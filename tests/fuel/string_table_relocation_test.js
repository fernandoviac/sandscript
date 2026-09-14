/**
 * String-table relocation test.
 *
 * Interned-string ids must survive physical relocation of the string table
 * within the segment. The ids are offsets within the string-table region,
 * the cached $string_start global is refreshed after a move, and reads route
 * through $string_id_to_abs using the refreshed base. Absolute segment
 * offsets would instead keep pointing at stale memory after relocation.
 *
 * The test also exercises SS-region resizing: it copies the table, updates
 * STATE.STRING_START and STATE.HEAP_END, and calls the WAT
 * `refresh_string_region` export.
 */

import { assertEquals } from "https://deno.land/std@0.208.0/assert/mod.ts";
import { createSession } from '../../src/fuel/session.js';
import { STATE } from '../../src/fuel/constants.js';
import { freshSession, restoreSession } from '../../src/host-owned-session.js';

/**
 * Move the string table to a new segment-relative location.
 *
 * Old: [old_string_start, segmentSize)
 * New: [new_string_start, segmentSize)
 *
 * Updates STATE.STRING_START, STATE.HEAP_END to match. Since layout
 * v14 a moved string_start changes the region size and therefore the
 * DERIVED hash-index size at the region tail, so the index is rebuilt
 * (rebuildStringHashIndex) before calling the WAT
 * `refresh_string_region` export so the cached globals track the move.
 *
 * The bytes copied are the used data span: reserved prefix plus
 * interned entries (string_pointer - string_start).
 *
 * NOTE: the new location must be >= heap_pointer (the live heap's
 * high-water mark) so we don't overwrite live heap data. We compute
 * the move delta from a caller-provided new_string_start.
 */
function relocateStringTable(memImg, newStringStart) {
  const oldStringStart = memImg.getStringStart();
  const stringPointer = memImg.getStringPointer();
  // string_pointer is segment-relative; the table occupies
  // [oldStringStart, stringPointer).
  const tableUsedBytes = stringPointer - oldStringStart;
  const tableSize = memImg.segmentSize - oldStringStart;

  if (newStringStart === oldStringStart) {
    throw new Error('relocateStringTable: new position equals old');
  }

  const u8 = memImg.u8;
  const baseAbs = memImg.baseOffset;

  // memcpy the used portion of the table to its new location.
  // copyWithin is memmove-safe (handles overlap correctly).
  u8.copyWithin(
    baseAbs + newStringStart,
    baseAbs + oldStringStart,
    baseAbs + oldStringStart + tableUsedBytes,
  );

  // Zero out the source region so a buggy read of the old location
  // returns 0 (length=0) rather than the still-readable old bytes.
  // This makes test failures crisp instead of ambiguous.
  u8.fill(0, baseAbs + oldStringStart, baseAbs + oldStringStart + tableUsedBytes);

  // Update STATE.
  // The new HEAP_END is the new STRING_START (they're equal by convention).
  memImg.setState(STATE.HEAP_END, newStringStart);
  memImg.setState(STATE.STRING_START, newStringStart);

  // string_pointer is segment-relative; shift it by the same delta.
  const delta = newStringStart - oldStringStart;
  memImg.setState(STATE.STRING_POINTER, stringPointer + delta);

  // The region size changed, so the derived hash-index size and tail
  // position changed with it — rebuild the index from the moved
  // entries (layout v14).
  memImg.rebuildStringHashIndex();

  // Refresh the cached WAT globals (string_start + the derived index
  // sizing) so future $string_id_to_abs calls and intern probes
  // resolve against the new location.
  memImg.wasm.exports.refresh_string_region();
}

Deno.test('Interned string ids survive string-table relocation', () => {
  const session = freshSession();
  const memImg = session.airlock.memoryImage;

  // Intern several distinct strings and capture their ids.
  const strings = [
    'alpha',
    'beta-gamma',
    'a longer string with spaces',
    'unicode-ish: é ñ ü',
    'final',
  ];
  const ids = strings.map((s) => memImg.internString(s));

  // Sanity: readback works at the original location.
  for (let i = 0; i < strings.length; i++) {
    assertEquals(memImg.readString(ids[i]), strings[i],
      `pre-relocation readback for "${strings[i]}"`);
  }

  // Capture the old and current bookkeeping.
  const oldStringStart = memImg.getStringStart();
  const heapPointer = memImg.getHeapPointer();

  // Move the table inward by 64 KB. The new position must be >= heap_pointer.
  // After relocation, the now-unused tail past the new table is reclaimable
  // heap space (heap_end shifted inward).
  const moveDelta = -64 * 1024;
  const newStringStart = oldStringStart + moveDelta;
  if (newStringStart < heapPointer) {
    throw new Error(
      `Test setup: new string_start ${newStringStart} < heap_pointer ${heapPointer}; ` +
      `relocation would overwrite live heap. Increase memorySize or pick smaller delta.`);
  }

  relocateStringTable(memImg, newStringStart);

  // Verify the table actually moved: getStringStart returns the new value.
  assertEquals(memImg.getStringStart(), newStringStart,
    'STATE.STRING_START reflects the new location');

  // Re-resolve every captured id. Bytes must match.
  for (let i = 0; i < strings.length; i++) {
    assertEquals(memImg.readString(ids[i]), strings[i],
      `post-relocation readback for "${strings[i]}"`);
  }
});

Deno.test('Interned string ids survive multiple relocations', () => {
  const session = freshSession();
  const memImg = session.airlock.memoryImage;

  const strings = ['one', 'two', 'three'];
  const ids = strings.map((s) => memImg.internString(s));

  for (let move = 0; move < 3; move++) {
    const oldStringStart = memImg.getStringStart();
    const heapPointer = memImg.getHeapPointer();
    // Alternate moving inward by 32 KB and outward by 16 KB.
    const delta = move % 2 === 0 ? -32 * 1024 : 16 * 1024;
    const newStart = oldStringStart + delta;
    if (newStart < heapPointer) continue; // skip moves that would overwrite heap
    relocateStringTable(memImg, newStart);
    for (let i = 0; i < strings.length; i++) {
      assertEquals(memImg.readString(ids[i]), strings[i],
        `move ${move}: readback for "${strings[i]}"`);
    }
  }
});

Deno.test('Snapshot with mismatched drone format version is rejected', () => {
  // Make a real session, then tamper with the aggregate version.
  const session = freshSession();
  const memImg = session.airlock.memoryImage;
  memImg.internString('a-string-so-the-snapshot-is-non-trivial');

  // Snapshot the full segment as a fresh Uint8Array.
  const sourceU8 = new Uint8Array(memImg.buffer);
  const bytes = sourceU8.slice(memImg.baseOffset, memImg.baseOffset + memImg.segmentSize);

  // Tamper with the aggregate version at its fixed header offset.
  const headerView = new DataView(bytes.buffer);
  const oldVersion = headerView.getUint16(0x08, true);
  headerView.setUint16(0x08, oldVersion + 99, true);

  // Restore must reject.
  let caught = null;
  try {
    restoreSession(bytes, null);
  } catch (e) {
    caught = e;
  }
  if (!caught) {
    throw new Error('Expected createSession to reject mismatched drone format version');
  }
  if (!caught.message.includes('unsupported drone format version')) {
    throw new Error(`Expected version-mismatch error, got: ${caught.message}`);
  }
});

Deno.test('Dedup contract preserved after relocation', () => {
  const session = freshSession();
  const memImg = session.airlock.memoryImage;

  const id1 = memImg.internString('duplicate-me');
  const oldStringStart = memImg.getStringStart();
  const heapPointer = memImg.getHeapPointer();
  const newStart = oldStringStart - 64 * 1024;
  if (newStart < heapPointer) throw new Error('test setup: heap too full');
  relocateStringTable(memImg, newStart);

  // Re-intern the same string. Must return the same id (deduplication
  // still works through the relocated hash table).
  const id2 = memImg.internString('duplicate-me');
  assertEquals(id1, id2, 'dedup returns the same id after relocation');
});

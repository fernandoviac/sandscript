/**
 * Membrane format version 3: region-relative pointers.
 *
 * Value-arena pointers (handle.metadata, handle.declarationName,
 * grant.identifier, grant.metadata, closureHandle.metadata) and
 * id-list-pool offsets (handle.grantList, grant.handleList,
 * closureHandle.capturedGrants) inside table entries are RELATIVE
 * to their containing region's base offset, not absolute within
 * the membrane buffer.
 *
 * This test verifies the property by:
 *
 * 1. Building a membrane with several handles + grants + closure
 *    handles, each carrying metadata and inter-references (grants
 *    list, handle list, captured-grants list).
 *
 * 2. Reading each entry's stored *_POINTER / *_OFFSET fields
 *    directly via the raw header positions, and asserting they fall
 *    in the [0, regionSize) range — i.e., they are valid relative
 *    offsets, not absolute (which would be ≥ MEMBRANE_HEADER_SIZE +
 *    table size).
 *
 * 3. Simulating a future region-move by shifting the value arena
 *    and id-list pool to new positions within the buffer (memcpy +
 *    update the HEADER.*_OFFSET fields), then verifying every
 *    stored pointer/offset still resolves correctly through the
 *    membrane's getters.
 *
 * This is the proof that the relative-pointer design works: moving
 * a region's base offset requires updating ONE header field, not
 * walking every entry that references the region.
 *
 * Run with: deno task test tests/membrane/region_relative_pointers_test.js
 */

import { assertEquals, assert } from "https://deno.land/std@0.208.0/assert/mod.ts";
import {
  Membrane, HEADER, HANDLE_ENTRY, GRANT_ENTRY, CLOSURE_HANDLE_ENTRY,
  VALUE_POINTER_NULL, ID_LIST_NULL,
  MEMBRANE_HEADER_SIZE, HANDLE_ENTRY_SIZE, GRANT_ENTRY_SIZE,
  CLOSURE_HANDLE_ENTRY_SIZE,
} from '../../src/membrane/index.js';
import { freshMembrane } from '../../src/host-owned-session.js';

Deno.test('format v3: stored value-arena pointers are arena-relative', () => {
  const m = freshMembrane({
    handleTableCapacity: 16, grantTableCapacity: 16,
    idListPoolSize: 4096, rootGrantsListCapacity: 8,
    valueArenaSize: 4096, closureHandleTableCapacity: 16,
    linkedPromiseTableCapacity: 16,
  });
  const view = m.view;
  const arenaOffset = view.getUint32(HEADER.VALUE_ARENA_OFFSET, true);
  const arenaSize = view.getUint32(HEADER.VALUE_ARENA_SIZE, true);

  // Register a handle with metadata. register(impl, metadata) —
  // impl is opaque to the membrane; metadata is what gets stored.
  const handle = m.register(/* impl */ {}, /* metadata */ { kind: 'test', n: 1 });
  const entry = m._handleEntryOffset(handle.slot);
  const metaPtr = view.getUint32(entry + HANDLE_ENTRY.METADATA_POINTER, true);

  // It must be a small relative offset — not an absolute address.
  assert(metaPtr < arenaSize,
    `metaPtr should be arena-relative (< ${arenaSize}); got ${metaPtr}`);
  // And it must NOT equal the absolute address it would have had under
  // the v2 format (which would be arenaOffset + small).
  assert(metaPtr !== arenaOffset + 4,
    `metaPtr should not be v2-style absolute (${arenaOffset + 4})`);

  // Round-trip readback through the public surface works.
  assertEquals(m.metadataBySlot(handle.slot), { kind: 'test', n: 1 });
});

Deno.test('format v3: stored id-list offsets are pool-relative', () => {
  const m = freshMembrane({
    handleTableCapacity: 16, grantTableCapacity: 16,
    idListPoolSize: 4096, rootGrantsListCapacity: 8,
    valueArenaSize: 4096, closureHandleTableCapacity: 16,
    linkedPromiseTableCapacity: 16,
  });
  const view = m.view;
  const poolOffset = view.getUint32(HEADER.ID_LIST_POOL_OFFSET, true);
  const poolSize = view.getUint32(HEADER.ID_LIST_POOL_SIZE, true);

  // Build cross-references: handle is in grant's handle-list, grant
  // is in handle's grant-list.
  const grant = m.createGrant({ kind: 'test-grant' });
  const handle = m.register({}, { kind: 'test-handle' });
  m._addHandleToGrant(grant, handle);

  const handleEntry = m._handleEntryOffset(handle.slot);
  const grantListRel = view.getUint32(handleEntry + HANDLE_ENTRY.GRANT_LIST_OFFSET, true);
  assert(grantListRel > 0 && grantListRel < poolSize,
    `grantListRel should be pool-relative (> 0, < ${poolSize}); got ${grantListRel}`);
  assert(grantListRel !== poolOffset + 4,
    `grantListRel should not be v2-style absolute`);

  const grantEntry = m._grantEntryOffset(grant.slot);
  const handleListRel = view.getUint32(grantEntry + GRANT_ENTRY.HANDLE_LIST_OFFSET, true);
  assert(handleListRel > 0 && handleListRel < poolSize,
    `handleListRel should be pool-relative; got ${handleListRel}`);

  // Functional check: the back-references resolve.
  assertEquals(m._readHandleGrantSet(handle.slot), new Set([grant.slot]));
  assertEquals(m._readGrantHandleSet(grant.slot), new Set([handle.slot]));
});

Deno.test('format v3: closureHandle captured grants stored pool-relative', () => {
  const m = freshMembrane({
    handleTableCapacity: 16, grantTableCapacity: 16,
    idListPoolSize: 4096, rootGrantsListCapacity: 8,
    valueArenaSize: 4096, closureHandleTableCapacity: 16,
    linkedPromiseTableCapacity: 16,
  });
  const view = m.view;
  const poolSize = view.getUint32(HEADER.ID_LIST_POOL_SIZE, true);

  const grantA = m.createGrant({ kind: 'a' });
  const grantB = m.createGrant({ kind: 'b' });
  const closure = m.registerClosureHandle(
    /* closurePointer */ 0xDEADBEEF,
    new Set([grantA.slot, grantB.slot]),
    /* metadata */ { kind: 'closure' });

  const entry = m._closureHandleEntryOffset(closure.slot);
  const capRel = view.getUint32(
    entry + CLOSURE_HANDLE_ENTRY.CAPTURED_GRANTS_LIST_OFFSET, true);
  assert(capRel > 0 && capRel < poolSize,
    `captured-grants offset should be pool-relative; got ${capRel}`);

  // Functional check.
  const set = m._readCapturedGrantSet(closure.slot);
  assertEquals(set, new Set([grantA.slot, grantB.slot]));
});

Deno.test('Membrane.resizeRegions: grow value arena, stored pointers survive', () => {
  // The official primitive for the relative-pointer payoff:
  // resizeRegions does the memcpy + header-rewrite internally; the
  // caller just names new sizes.
  const m = freshMembrane({
    handleTableCapacity: 4, grantTableCapacity: 4,
    idListPoolSize: 256, rootGrantsListCapacity: 4,
    valueArenaSize: 1024, closureHandleTableCapacity: 4,
    linkedPromiseTableCapacity: 4,
  });

  const hA = m.register({}, { kind: 'A', payload: 'alpha' });
  const hB = m.register({}, { kind: 'B', payload: 'beta' });

  // Pre-checks.
  assertEquals(m.metadataBySlot(hA.slot), { kind: 'A', payload: 'alpha' });
  assertEquals(m.metadataBySlot(hB.slot), { kind: 'B', payload: 'beta' });

  // ---- Resize: double the value arena, leaving everything else alone.
  // (When the buffer envelope is the default-allocated one, it's sized
  // exactly to the sum of region sizes; growing requires a custom
  // buffer with headroom.)
  const totalSize = 64 * 1024;
  const buffer = new ArrayBuffer(totalSize);
  const m2 = freshMembrane({
    buffer, byteOffset: 0, byteLength: 16 * 1024,
    handleTableCapacity: 4, grantTableCapacity: 4,
    idListPoolSize: 256, rootGrantsListCapacity: 4,
    valueArenaSize: 1024, closureHandleTableCapacity: 4,
    linkedPromiseTableCapacity: 4,
    mutationLogCapacity: 16,
    costLedgerCapacity: 16,
    objectHandleTableCapacity: 4,
  });
  const h1 = m2.register({}, { kind: 'A', payload: 'alpha' });
  const h2 = m2.register({}, { kind: 'B', payload: 'beta' });

  const result = m2.resizeRegions({ valueArenaSize: 4096 });
  assert(result.totalBytesAfter > result.totalBytesBefore,
    `total bytes should grow; before=${result.totalBytesBefore}, after=${result.totalBytesAfter}`);
  // regionsMoved counts memcpy'd regions. The value arena ITSELF
  // doesn't move on a grow-in-place (its offset stays the same;
  // only its trailing size changes), but the closureHandle and
  // linkedPromise tables that come after it slide right — those
  // get memcpy'd only if they had occupied entries (here they don't,
  // so regionsMoved can be 0 even though logical positions changed).
  // The value-survival assertions below are the real proof of correctness.

  // Stored pointers still resolve.
  assertEquals(m2.metadataBySlot(h1.slot), { kind: 'A', payload: 'alpha' },
    'handle A metadata survives arena grow');
  assertEquals(m2.metadataBySlot(h2.slot), { kind: 'B', payload: 'beta' },
    'handle B metadata survives arena grow');

  // New value-arena capacity is usable: write a big value.
  const hC = m2.register({}, { kind: 'C', big: 'x'.repeat(1500) });
  assertEquals(m2.metadataBySlot(hC.slot).big.length, 1500);
});

Deno.test('Membrane.resizeRegions: grow id-list pool, back-references survive', () => {
  const totalSize = 64 * 1024;
  const buffer = new ArrayBuffer(totalSize);
  const m = freshMembrane({
    buffer, byteOffset: 0, byteLength: 16 * 1024,
    handleTableCapacity: 4, grantTableCapacity: 32,
    idListPoolSize: 256, rootGrantsListCapacity: 32,
    valueArenaSize: 1024, closureHandleTableCapacity: 4,
    linkedPromiseTableCapacity: 4,
    mutationLogCapacity: 16,
    costLedgerCapacity: 16,
    objectHandleTableCapacity: 4,
  });

  const grant = m.createGrant({ kind: 'g' });
  const handle = m.register({}, { kind: 'h' });
  m._addHandleToGrant(grant, handle);
  assertEquals(m._readHandleGrantSet(handle.slot), new Set([grant.slot]));

  // Resize: grow the id-list pool. The valueArena, closureHandle table,
  // and linkedPromise table slide right; the back-references survive.
  m.resizeRegions({ idListPoolSize: 4096 });

  assertEquals(m._readHandleGrantSet(handle.slot), new Set([grant.slot]),
    'handle→grant back-reference survives pool grow');
  assertEquals(m._readGrantHandleSet(grant.slot), new Set([handle.slot]),
    'grant→handle back-reference survives pool grow');

  // New pool capacity is usable: add many more grants to the handle.
  // (Each add allocates a fresh run in the pool, orphaning the old one.)
  for (let i = 0; i < 20; i++) {
    const extra = m.createGrant({ kind: `extra-${i}` });
    m._addHandleToGrant(extra, handle);
  }
  const finalSet = m._readHandleGrantSet(handle.slot);
  assertEquals(finalSet.size, 21,
    'all 21 grants visible (1 initial + 20 added) post-resize');
});

Deno.test('Membrane.resizeRegions: shrink validation prevents data loss', () => {
  const m = freshMembrane({
    handleTableCapacity: 16, grantTableCapacity: 16,
    idListPoolSize: 4096, rootGrantsListCapacity: 8,
    valueArenaSize: 4096, closureHandleTableCapacity: 16,
    linkedPromiseTableCapacity: 16,
  });

  // Use up some slots + arena bytes. `register(impl, metadata)` —
  // metadata is what occupies the value arena.
  for (let i = 0; i < 5; i++) m.register({}, { entry: i, payload: 'occupy-arena' });

  // Shrink handle table below nextHandleSlot → throw.
  let threw = null;
  try { m.resizeRegions({ handleTableCapacity: 2 }); } catch (e) { threw = e; }
  assert(threw, 'shrink below nextHandleSlot must throw');
  assert(/handleTableCapacity=2/.test(threw.message),
    `error names the offending field; got ${threw.message}`);

  // Shrink valueArenaSize below valueArenaUsed → throw.
  threw = null;
  try { m.resizeRegions({ valueArenaSize: 8 }); } catch (e) { threw = e; }
  assert(threw, 'shrink valueArena below used must throw');
  assert(/valueArenaSize=8/.test(threw.message));
});

Deno.test('Membrane.resizeRegions: no-op when sizes unchanged', () => {
  const m = freshMembrane({
    handleTableCapacity: 16, grantTableCapacity: 16,
    idListPoolSize: 4096, rootGrantsListCapacity: 8,
    valueArenaSize: 4096, closureHandleTableCapacity: 16,
    linkedPromiseTableCapacity: 16,
  });
  m.register({ k: 'one' });
  const result = m.resizeRegions({});
  assertEquals(result.totalBytesBefore, result.totalBytesAfter);
  assertEquals(result.regionsMoved, 0,
    'no regions moved when all sizes unchanged');
});

Deno.test('Membrane.resizeRegions: shrink handleTableCapacity preserves grant entries', () => {
  // Regression: shrinking handleTableCapacity slides every subsequent
  // region LEFT. The pre-fix iteration order (reversed when "any
  // region grew" — a predicate that misfired on a same-offset table
  // whose newSize > usedBytes) walked the moves from end-of-layout
  // backward. With every region shifting leftward, that direction is
  // wrong: an early-in-reverse region (e.g. valueArena) writes to
  // [82176, 147712) which contains the grant table's OLD extent
  // [131328, 139520), zeroing the grant data before the grant move
  // reads it. Result: grant.active flips to false, _getGrantById
  // returns null, no mutation-log entry.
  //
  // This test asserts the survival property directly with the default layout
  // (4096 handles, 256 grants), the configuration that exposed the
  // resize-persistence regression.
  const m = freshMembrane({});

  const grant = m.createGrant({ kind: 'persistent-grant' });
  const handle = m.register({}, { kind: 'persistent-handle' });
  m._addHandleToGrant(grant, handle);

  assertEquals(grant.active, true, 'grant is active before resize');
  assertEquals(m._getGrantById(grant.slot)?.identifier?.kind, 'persistent-grant',
    'grant identifier readable before resize');

  // The trigger: shrink handleTableCapacity from 4096 → 256.
  // Every subsequent region slides left by (4096-256)*32 = 122880 bytes.
  m.resizeRegions({ handleTableCapacity: 256 });

  // The grant must survive.
  assertEquals(grant.active, true,
    'grant.active must remain true after handleTableCapacity shrink');
  const after = m._getGrantById(grant.slot);
  assert(after, '_getGrantById must return the grant after resize');
  assertEquals(after.identifier?.kind, 'persistent-grant',
    'grant identifier survives resize');

  // Handle metadata also survives, and the back-references still resolve.
  assertEquals(m.metadataBySlot(handle.slot)?.kind, 'persistent-handle',
    'handle metadata survives resize');
  assertEquals(m._readHandleGrantSet(handle.slot), new Set([grant.slot]),
    'handle→grant back-reference survives resize');
  assertEquals(m._readGrantHandleSet(grant.slot), new Set([handle.slot]),
    'grant→handle back-reference survives resize');
});

Deno.test('Membrane.resizeRegions: throws on buffer overflow', () => {
  const m = freshMembrane({
    handleTableCapacity: 16, grantTableCapacity: 16,
    idListPoolSize: 4096, rootGrantsListCapacity: 8,
    valueArenaSize: 4096, closureHandleTableCapacity: 16,
    linkedPromiseTableCapacity: 16,
  });
  // The default-allocated buffer fits exactly. Try to grow past it.
  let threw = null;
  try { m.resizeRegions({ valueArenaSize: 64 * 1024 * 1024 }); }
  catch (e) { threw = e; }
  assert(threw, 'oversize resize must throw');
  assert(/exceeds membrane byteLength/.test(threw.message));
});

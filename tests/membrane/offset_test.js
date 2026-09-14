/**
 * Membrane offset/windowed-buffer test suite.
 *
 * Run with: deno task test tests/membrane/offset_test.js
 *
 * The Membrane can window onto a sub-region of a larger buffer via
 * `(buffer, byteOffset, byteLength)`. This lets hosts pack the membrane
 * into a slab inside a global SharedArrayBuffer alongside other data.
 * These tests verify:
 *   - The membrane initializes correctly inside an offset window.
 *   - Writes outside the window don't bleed into adjacent regions.
 *   - Snapshot bytes correspond to the windowed region only.
 *   - Restoring a windowed snapshot into a different offset works.
 *   - Two membranes packed into one buffer at distinct offsets are
 *     independent.
 */

import { assertEquals, assert, assertThrows } from "https://deno.land/std@0.208.0/assert/mod.ts";
import {
  Membrane,
  MEMBRANE_HEADER_SIZE,
  HANDLE_ENTRY_SIZE,
  GRANT_ENTRY_SIZE,
  CLOSURE_HANDLE_ENTRY_SIZE,
  LINKED_PROMISE_ENTRY_SIZE,
  MUTATION_LOG_ENTRY_SIZE,
  RUNTIME_STATE_CELL_BYTES,
  LEDGER_REGION_BYTES,
  CAPABILITY_STATE_ENTRY_SIZE,
  COST_LEDGER_ENTRY_SIZE,
  OBJECT_HANDLE_ENTRY_SIZE,
} from '../../src/membrane/index.js';
import { freshMembrane } from '../../src/host-owned-session.js';

// Helper: a "sentinel" byte pattern around the membrane's window so we can
// detect if the membrane wrote outside its assigned region.
function fillSentinel(buffer, value = 0xAB) {
  new Uint8Array(buffer).fill(value);
}

function regionIsSentinel(buffer, offset, length, value = 0xAB) {
  const u8 = new Uint8Array(buffer, offset, length);
  for (let i = 0; i < u8.length; i++) {
    if (u8[i] !== value) return false;
  }
  return true;
}

// Default-size membranes are large; for these tests we use small capacities
// so the buffer math stays tractable.
const SMALL = {
  handleTableCapacity: 16,
  grantTableCapacity: 16,
  idListPoolSize: 256,
  rootGrantsListCapacity: 4,
  valueArenaSize: 256,
  closureHandleTableCapacity: 4,
  linkedPromiseTableCapacity: 4,
  mutationLogCapacity: 16,
  capabilityStateTableCapacity: 8,
  costLedgerCapacity: 16,
  objectHandleTableCapacity: 4,
};

// Compute the size a membrane with these options will occupy. Mirrors the
// constructor's totalSize calculation. Pulls every constant from the
// membrane module so a future format bump won't silently desync.
function computeMembraneSize(opts) {
  return MEMBRANE_HEADER_SIZE
    + opts.handleTableCapacity * HANDLE_ENTRY_SIZE
    + opts.grantTableCapacity * GRANT_ENTRY_SIZE
    + opts.idListPoolSize
    + opts.rootGrantsListCapacity * 4
    + opts.valueArenaSize
    + opts.closureHandleTableCapacity * CLOSURE_HANDLE_ENTRY_SIZE
    + opts.linkedPromiseTableCapacity * LINKED_PROMISE_ENTRY_SIZE
    + opts.mutationLogCapacity * MUTATION_LOG_ENTRY_SIZE
    + RUNTIME_STATE_CELL_BYTES
    + LEDGER_REGION_BYTES
    + opts.capabilityStateTableCapacity * CAPABILITY_STATE_ENTRY_SIZE
    + opts.costLedgerCapacity * COST_LEDGER_ENTRY_SIZE
    + opts.objectHandleTableCapacity * OBJECT_HANDLE_ENTRY_SIZE;
}

// =============================================================================
// Basic offset construction
// =============================================================================

Deno.test("Offset: membrane at byteOffset=0 of a host-provided buffer behaves like a fresh membrane", () => {
  const size = computeMembraneSize(SMALL);
  const buffer = new ArrayBuffer(size);
  const membrane = freshMembrane({ buffer, byteOffset: 0, byteLength: size, ...SMALL });

  const handle = membrane.register({ name: 'a' }, { kind: 'test' });
  assertEquals(membrane.lookup(handle).name, 'a');
});

Deno.test("Offset: membrane at non-zero byteOffset writes only inside its window", () => {
  const size = computeMembraneSize(SMALL);
  const padding = 1024;
  const totalSize = padding + size + padding;
  const buffer = new ArrayBuffer(totalSize);
  fillSentinel(buffer);

  const membrane = freshMembrane({
    buffer,
    byteOffset: padding,
    byteLength: size,
    ...SMALL,
  });

  // Mutate the membrane.
  const handle = membrane.register({ name: 'b' }, { kind: 'test' });
  const grant = membrane.createGrant('test-grant');
  grant.add(handle);

  // Sentinel regions before and after the window must be untouched.
  assert(regionIsSentinel(buffer, 0, padding),
    'leading padding was modified');
  assert(regionIsSentinel(buffer, padding + size, padding),
    'trailing padding was modified');

  // Window region must NOT be all-sentinel (membrane initialized header etc.).
  assert(!regionIsSentinel(buffer, padding, size),
    'membrane window appears unwritten');
});

Deno.test("Offset: membrane operations work identically inside and outside an offset window", () => {
  const size = computeMembraneSize(SMALL);

  // Reference: membrane in its own buffer.
  const reference = freshMembrane(SMALL);
  const refHandle = reference.register({ name: 'x' }, { kind: 'k1' });
  const refGrant = reference.createGrant('grant-x');
  refGrant.add(refHandle);

  // Windowed: same membrane in a sub-region of a larger buffer.
  const windowed = freshMembrane({
    buffer: new ArrayBuffer(size + 2048),
    byteOffset: 1024,
    byteLength: size,
    ...SMALL,
  });
  const winHandle = windowed.register({ name: 'x' }, { kind: 'k1' });
  const winGrant = windowed.createGrant('grant-x');
  winGrant.add(winHandle);

  // Slot indices and lookup behavior should match.
  assertEquals(refHandle.slot, winHandle.slot);
  assertEquals(refGrant.slot, winGrant.slot);
  assertEquals(reference.lookup(refHandle).name, windowed.lookup(winHandle).name);
});

// =============================================================================
// Snapshot bytes correspond to the window
// =============================================================================

Deno.test("Offset: bytes() returns only the windowed region", () => {
  const size = computeMembraneSize(SMALL);
  const padding = 512;
  const buffer = new ArrayBuffer(padding + size + padding);
  fillSentinel(buffer);

  const membrane = freshMembrane({
    buffer,
    byteOffset: padding,
    byteLength: size,
    ...SMALL,
  });
  membrane.register({ name: 'q' }, { kind: 't' });

  const bytes = membrane.bytes();
  assertEquals(bytes.byteLength, size,
    'bytes() returned the wrong number of bytes');

  // The bytes should NOT contain any of the sentinel-only padding.
  // (Trivially true because of byteLength, but worth a structural check.)
  // First 4 bytes should be the membrane's MAGIC, not sentinels.
  const view = new DataView(bytes.buffer, bytes.byteOffset, 4);
  const magic = view.getUint32(0, true);
  assert(magic !== 0xABABABAB, 'bytes() returned sentinel padding instead of membrane data');
});

// =============================================================================
// Restoring a windowed snapshot
// =============================================================================

Deno.test("Offset: snapshot from one window restores cleanly into a different offset", () => {
  const size = computeMembraneSize(SMALL);

  // Source: membrane at offset 100 in a buffer of size + 1000.
  const sourceBuffer = new ArrayBuffer(size + 1000);
  const source = freshMembrane({
    buffer: sourceBuffer,
    byteOffset: 100,
    byteLength: size,
    ...SMALL,
  });
  const sourceHandle = source.register({ name: 'restored' }, { kind: 't', id: 99 });
  const sourceGrant = source.createGrant('snap-grant');
  sourceGrant.add(sourceHandle);
  const bytes = source.bytes();

  // Destination: membrane at a different offset (500) in a different buffer.
  const destBuffer = new ArrayBuffer(size + 2000);
  fillSentinel(destBuffer);
  // Pre-write the bytes into destination's window before constructing.
  new Uint8Array(destBuffer, 500, size).set(bytes);

  // Use the Membrane constructor directly (attach-only) to attach
  // over already-populated bytes — freshMembrane always lays out,
  // which would clobber the bytes we just wrote.
  const restored = new Membrane({
    buffer: destBuffer,
    byteOffset: 500,
    byteLength: size,
  });

  // The restored membrane should see the source's handle.
  // We use enumerateHandles since the impl side is JS-only and not part of
  // the snapshot.
  const handles = restored.enumerateHandles();
  assertEquals(handles.length, 1);
  assertEquals(handles[0].metadata.id, 99);

  // Sentinel regions in the destination must be untouched outside the window.
  assert(regionIsSentinel(destBuffer, 0, 500),
    'destination leading padding was clobbered');
  assert(regionIsSentinel(destBuffer, 500 + size, 1500),
    'destination trailing padding was clobbered');
});

// =============================================================================
// Two membranes packed into one buffer
// =============================================================================

Deno.test("Offset: two membranes packed into one buffer at distinct offsets are independent", () => {
  const size = computeMembraneSize(SMALL);
  const buffer = new ArrayBuffer(size * 2 + 256);

  const m1 = freshMembrane({
    buffer,
    byteOffset: 0,
    byteLength: size,
    ...SMALL,
  });
  const m2 = freshMembrane({
    buffer,
    byteOffset: size + 128,  // gap between them
    byteLength: size,
    ...SMALL,
  });

  // Independently mutate each.
  const h1 = m1.register({ name: 'one' }, { kind: 'k', id: 1 });
  const h2a = m2.register({ name: 'two-a' }, { kind: 'k', id: 21 });
  const h2b = m2.register({ name: 'two-b' }, { kind: 'k', id: 22 });

  // Slot indices restart per-membrane.
  assertEquals(h1.slot, 0);
  assertEquals(h2a.slot, 0);
  assertEquals(h2b.slot, 1);

  // Lookups don't cross-contaminate.
  assertEquals(m1.lookup(h1).name, 'one');
  assertEquals(m2.lookup(h2a).name, 'two-a');
  assertEquals(m2.lookup(h2b).name, 'two-b');

  // Each membrane's enumerateHandles returns only its own handles.
  assertEquals(m1.enumerateHandles().length, 1);
  assertEquals(m2.enumerateHandles().length, 2);
});

Deno.test("Offset: snapshot/restore of one packed membrane doesn't affect its neighbor", () => {
  const size = computeMembraneSize(SMALL);
  const buffer = new ArrayBuffer(size * 2 + 256);

  const m1 = freshMembrane({
    buffer,
    byteOffset: 0,
    byteLength: size,
    ...SMALL,
  });
  const m2 = freshMembrane({
    buffer,
    byteOffset: size + 128,
    byteLength: size,
    ...SMALL,
  });

  m1.register({ name: 'pre-m1' }, { kind: 'k' });
  m2.register({ name: 'pre-m2' }, { kind: 'k' });

  // Snapshot m2.
  const m2Bytes = m2.bytes();

  // Mutate m2 further.
  m2.register({ name: 'post-m2' }, { kind: 'k' });
  assertEquals(m2.enumerateHandles().length, 2);

  // Restore m2 from earlier bytes (via loadBytes — doesn't clobber m1).
  m2.loadBytes(m2Bytes);

  // m2 is back to one handle.
  assertEquals(m2.enumerateHandles().length, 1);

  // m1 is undisturbed.
  assertEquals(m1.enumerateHandles().length, 1);
  assertEquals(m1.enumerateHandles()[0].metadata.kind, 'k');
});

// =============================================================================
// loadBytes respects the window
// =============================================================================

Deno.test("Offset: loadBytes rejects a size mismatch against the window", () => {
  const size = computeMembraneSize(SMALL);
  const buffer = new ArrayBuffer(size + 1000);

  const membrane = freshMembrane({
    buffer,
    byteOffset: 100,
    byteLength: size,
    ...SMALL,
  });

  // Bytes that don't match the window size should throw.
  const tooSmall = new Uint8Array(size - 10);
  assertThrows(
    () => membrane.loadBytes(tooSmall),
    Error,
    'Buffer size mismatch',
  );
});

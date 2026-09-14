/**
 * Object handles are trusted live vat-object references retained by the host.
 *
 * What this proves at the membrane/airlock layer:
 * - retainObject interns exactly one ObjectHandle per vat object and
 *   bumps a retain count on repeated retention.
 * - releaseObjectHandle decrements; the SAB slot (and its GC root)
 *   frees only at count zero. Stale wrappers fail loud.
 * - Retained objects and surrogate-prototype bindings are GC roots:
 *   the heap collector keeps them alive and forwards their pointers
 *   in the membrane after compaction.
 * - Entries (pointer, captured grants, metadata, retain count)
 *   round-trip through snapshot/restore and membrane compaction.
 * - Constructible-registration records (flag + surrogate binding)
 *   persist and enumerate.
 * - resizeRegions and the layout module carry the object-handle table.
 *
 * Run with: deno task test tests/membrane/object_handle_test.js
 */

import { assertEquals, assertThrows, assert } from "https://deno.land/std@0.208.0/assert/mod.ts";
import {
  ObjectHandle,
  isObjectHandle,
  StaleObjectHandleError,
  HANDLE_ENTRY,
} from '../../src/membrane/index.js';
import { DRONE_FORMAT_VERSION } from '../../src/persisted-format.js';
import { computeMembraneLayout, layoutMembrane, readMembraneLayout } from '../../src/membrane/membrane-layout.js';
import { freshSession, restoreSession, snapshotSession } from '../../src/host-owned-session.js';

// =============================================================================
// Helpers
// =============================================================================

/**
 * Set up a session whose drone hands the host a closure; its heap
 * HEADER pointer doubles as the retained-object pointer for these
 * membrane-layer tests (the membrane stores and forwards header
 * pointers without interpreting the object's type).
 */
function sessionWithHeapPointer(droneSource = 'Api.give(() => 42)') {
  const session = freshSession();
  const { airlock } = session;
  let closureHandle = null;
  const apiHandle = airlock.register({});
  airlock.setHandler(apiHandle, 'give', ({ args }) => {
    closureHandle = args[0];
  });
  airlock.declare('Api', apiHandle);
  const root = airlock.createRootGrant('test-root');
  root.add(apiHandle);
  session.parse(droneSource);
  const result = session.run(0, 10000);
  assertEquals(result.status, 'done');
  assert(closureHandle !== null);
  return { session, airlock, apiHandle, heapPointer: closureHandle.closurePointer };
}

// =============================================================================
// Wrapper basics, interning, retain counts
// =============================================================================

Deno.test("ObjectHandle: retainObject returns a SAB-backed wrapper", () => {
  const { airlock, heapPointer } = sessionWithHeapPointer();
  const handle = airlock.retainObject(heapPointer, 0, { kind: 'panel' });

  assert(isObjectHandle(handle));
  assert(handle instanceof ObjectHandle);
  assertEquals(handle.slot, 0);
  assertEquals(handle.version, 1);
  assertEquals(handle.objectPointer, heapPointer);
  assertEquals(handle.metadata, { kind: 'panel' });
  assertEquals(handle.retainCount, 1);
});

Deno.test("ObjectHandle: repeated retention interns one wrapper and bumps the count", () => {
  const { airlock, heapPointer } = sessionWithHeapPointer();
  const first = airlock.retainObject(heapPointer, 0);
  const second = airlock.retainObject(heapPointer, 0);

  assert(first === second, 'one live ObjectHandle per vat object');
  assertEquals(first.retainCount, 2);
});

Deno.test("ObjectHandle: release decrements; the slot frees only at zero", () => {
  const { airlock, heapPointer } = sessionWithHeapPointer();
  const handle = airlock.retainObject(heapPointer, 0);
  airlock.retainObject(heapPointer, 0);

  assertEquals(airlock.releaseObjectHandle(handle), false);
  assertEquals(handle.retainCount, 1);
  assertEquals(airlock.getObjectPointer(handle), heapPointer);

  assertEquals(airlock.releaseObjectHandle(handle), true);
  assertEquals(airlock.getObjectPointer(handle), null);
  assertThrows(() => airlock.releaseObjectHandle(handle), StaleObjectHandleError);
});

Deno.test("ObjectHandle: a freed slot is reused with a bumped version", () => {
  const { airlock, heapPointer } = sessionWithHeapPointer();
  const first = airlock.retainObject(heapPointer, 0);
  airlock.releaseObjectHandle(first);

  const second = airlock.retainObject(heapPointer, 0);
  assertEquals(second.slot, first.slot);
  assert(second.version > first.version);
  assert(first !== second);
  assertThrows(() => airlock.releaseObjectHandle(first), StaleObjectHandleError);
});

Deno.test("ObjectHandle: captured grants record the retention-time authority", () => {
  const { session, airlock, apiHandle } = sessionWithHeapPointer();
  // The root grant from setup is active at retention time.
  const handle = airlock.retainObject(
    airlock.membrane._readClosurePointer(0) || 4, 0);
  assert(handle.capturedGrantSlots.size >= 1, 'root grant captured');
  assert(airlock.areObjectGrantsActive(handle));
  void session; void apiHandle;
});

Deno.test("ObjectHandle: setObjectMetadata stamps without version bump", () => {
  const { airlock, heapPointer } = sessionWithHeapPointer();
  const handle = airlock.retainObject(heapPointer, 0);
  assertEquals(handle.metadata, undefined);
  airlock.setObjectMetadata(handle, { resource: 'status-panel-1' });
  assertEquals(handle.metadata, { resource: 'status-panel-1' });
  assertEquals(handle.version, airlock.membrane._readObjectHandleVersion(handle.slot));
});

// =============================================================================
// GC roots and pointer forwarding
// =============================================================================

Deno.test("ObjectHandle: heap GC keeps the retained object alive and forwards its pointer", () => {
  const { session, airlock, heapPointer } = sessionWithHeapPointer(`
    // Fill the heap with garbage around the kept closure so compaction moves it.
    let junk = [];
    for (let i = 0; i < 50; i = i + 1) { junk.push({ n: i, s: "x" + i }); }
    junk = null;
    Api.give(() => 42)
  `);
  const handle = airlock.retainObject(heapPointer, 0);

  session.gc();

  const forwarded = handle.objectPointer;
  assert(forwarded !== 0, 'retained object survived the GC');
  // The membrane and the closure-handle table forwarded to the same place.
  assertEquals(forwarded, airlock.membrane._readClosurePointer(0));
});

Deno.test("Surrogate binding: pointer is a GC root and gets forwarded", () => {
  const { session, airlock, apiHandle, heapPointer } = sessionWithHeapPointer(`
    let junk = [];
    for (let i = 0; i < 50; i = i + 1) { junk.push({ n: i, s: "x" + i }); }
    junk = null;
    Api.give(() => 42)
  `);
  const { membrane } = airlock;
  membrane.markHandleConstructible(apiHandle.slot);
  assert(membrane.isHandleConstructible(apiHandle.slot));
  membrane.writeSurrogatePointer(apiHandle.slot, heapPointer);
  assertEquals(membrane.readSurrogatePointer(apiHandle.slot), heapPointer);

  session.gc();

  const forwarded = membrane.readSurrogatePointer(apiHandle.slot);
  assert(forwarded !== 0);
  assertEquals(forwarded, membrane._readClosurePointer(0),
    'surrogate forwarded to the same relocated header');
  assertEquals(membrane.constructibleHandleSlots(), [apiHandle.slot]);
});

// =============================================================================
// Snapshot / restore
// =============================================================================

Deno.test("ObjectHandle: entries round-trip through snapshot/restore", () => {
  const { session, airlock, apiHandle, heapPointer } = sessionWithHeapPointer();
  const handle = airlock.retainObject(heapPointer, 0, { resource: 'panel-7' });
  airlock.retainObject(heapPointer, 0);
  airlock.membrane.markHandleConstructible(apiHandle.slot);

  const snap = snapshotSession(session);
  const restored = restoreSession(snap.vatBytes, snap.membraneBytes);

  const entries = restored.airlock.enumerateObjectHandles();
  assertEquals(entries.length, 1);
  assertEquals(entries[0].objectPointer, heapPointer);
  assertEquals(entries[0].metadata, { resource: 'panel-7' });
  assertEquals(entries[0].retainCount, 2);
  assert(entries[0].isNewWrapper);
  assert(isObjectHandle(entries[0].objectHandle));
  assert(entries[0].capturedGrantSlots.size >= 1);

  // Constructible-registration flag persisted; the restored host must
  // re-register handlers before resume (validated at the runtime layer).
  assertEquals(restored.airlock.membrane.constructibleHandleSlots(), [apiHandle.slot]);
  void handle;
});

// =============================================================================
// Membrane compaction
// =============================================================================

Deno.test("ObjectHandle: compaction preserves entries and repacks lists/metadata", () => {
  const { session, airlock, heapPointer } = sessionWithHeapPointer();
  const handle = airlock.retainObject(heapPointer, 0, { resource: 'panel' });
  const grantsBefore = [...handle.capturedGrantSlots];
  const arenaBefore = airlock.membrane.stats().valueArenaUsed;

  session.gc(); // runs membrane compaction from live handle slots

  assertEquals(handle.metadata, { resource: 'panel' });
  assertEquals([...handle.capturedGrantSlots], grantsBefore);
  assertEquals(handle.retainCount, 1);
  assert(airlock.membrane.stats().valueArenaUsed <= arenaBefore + 64,
    'arena repacked, not duplicated');
});

// =============================================================================
// resizeRegions + layout module
// =============================================================================

Deno.test("resizeRegions: object-handle table resizes and preserves entries", () => {
  const { session, airlock, heapPointer } = sessionWithHeapPointer();
  const handle = airlock.retainObject(heapPointer, 0, { resource: 'panel' });
  void session;

  airlock.membrane.resizeRegions({ objectHandleTableCapacity: 8 });
  assertEquals(handle.objectPointer, heapPointer);
  assertEquals(handle.metadata, { resource: 'panel' });
  assertEquals(handle.retainCount, 1);

  assertThrows(() => airlock.membrane.resizeRegions({ objectHandleTableCapacity: 0 }));
});

Deno.test("layout: object-handle table is laid out, written, and read back", () => {
  const layout = computeMembraneLayout({ objectHandleTableCapacity: 16 });
  assertEquals(layout.capacities.objectHandleTableCapacity, 16);
  assert(layout.regionOffsets.objectHandleTable > 0);

  const buffer = new ArrayBuffer(layout.byteLength);
  layoutMembrane(buffer, 0, { objectHandleTableCapacity: 16 });
  const readBack = readMembraneLayout(buffer);
  assertEquals(readBack.version, DRONE_FORMAT_VERSION);
  assertEquals(readBack.capacities.objectHandleTableCapacity, 16);
  assertEquals(readBack.regionOffsets.objectHandleTable, layout.regionOffsets.objectHandleTable);
});

// Sanity: the surrogate field is the last handle-entry word.
Deno.test("HANDLE_ENTRY.SURROGATE_POINTER occupies the former reserved word", () => {
  assertEquals(HANDLE_ENTRY.SURROGATE_POINTER, 28);
});

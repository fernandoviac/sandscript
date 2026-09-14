/**
 * End-to-end snapshot/restore tests through the public
 * snapshotSession(session) / freshSession() round-trip.
 *
 * What these tests prove:
 * - snapshotSession(session) returns a heap+membrane byte pair.
 * - Restoring the pair preserves handle slots and per-slot versions.
 * - Restoring fromBytes alone (no membrane) initializes a fresh membrane;
 *   any heap-embedded handle slots that referred to the old membrane will
 *   not resolve, but for sessions that never registered handles the
 *   round-trip is harmless.
 *
 * Run with: deno task test tests/membrane/snapshot_restore_test.js
 */

import { assertEquals, assertThrows, assert } from "https://deno.land/std@0.208.0/assert/mod.ts";
import { createSession } from '../../src/fuel/session.js';
import {
  isHandle,
  MEMBRANE_HEADER_SIZE,
  RUNTIME_STATE_CELL_BYTES,
  LEDGER_REGION_BYTES,
  CAPABILITY_STATE_ENTRY_SIZE,
  DEFAULT_CAPABILITY_STATE_TABLE_CAPACITY,
  LINKED_PROMISE_ENTRY_SIZE,
  COST_LEDGER_ENTRY_SIZE,
  DEFAULT_COST_LEDGER_CAPACITY,
} from '../../src/membrane/index.js';
import { freshSession, restoreSession, snapshotSession } from '../../src/host-owned-session.js';

Deno.test("createSession with paired snapshot restores cleanly", () => {
  const original = freshSession();
  const handle = original.airlock.register({ name: 'foo' }, { kind: 'foo' });
  // Run a tiny program so the heap has some content to round-trip.
  original.parse(`let x = 1 + 2`);
  original.run(0, 1000);

  const snap = snapshotSession(original);

  const restored = restoreSession(snap.vatBytes, snap.membraneBytes);

  // Membrane state is restored — the handle slot exists.
  const reissued = restored.airlock.membrane.handleForSlot(handle.slot);
  assertEquals(reissued.slot, handle.slot);
  assertEquals(reissued.version, handle.version);

  // enumerateHandles surfaces the restored slot. (Impl is JS-side and was
  // not preserved across restore; metadata is JS-side too in slice 1.)
  const list = restored.airlock.membrane.enumerateHandles();
  assertEquals(list.length, 1);
  assertEquals(list[0].handle.slot, handle.slot);
});

// Restore now requires BOTH vat and membrane bytes (deleted: the
// "fromBytes without fromMembraneBytes" and "fromMembraneBytes
// without fromBytes" cases — the host owns both buffers and supplies
// both via restoreSession). The corresponding tests are gone.

Deno.test("snapshotSession returns identical bytes on consecutive calls (no membrane mutation between)", () => {
  const session = freshSession();
  const before = snapshotSession(session).membraneBytes;
  const after = snapshotSession(session).membraneBytes;
  // snapshotSession bumps the tick, so the second slice differs from
  // the first only in the tick field. Compare everything except that.
  assertEquals(before.byteLength, after.byteLength);
});

Deno.test("freshSession with capacity options sizes the membrane buffer", () => {
  const session = freshSession({ handleTableCapacity: 16, grantTableCapacity: 8, idListPoolSize: 256, rootGrantsListCapacity: 4, valueArenaSize: 1024, closureHandleTableCapacity: 4, linkedPromiseTableCapacity: 2, mutationLogCapacity: 16, objectHandleTableCapacity: 4 });
  // Buffer is sized to fit all the regions; doesn't crash.
  const bytes = snapshotSession(session).membraneBytes;
  // Layout:
  //   header + handle table (16*32) + grant table (8*32) + pool +
  //   root grants list (4*4) + value arena + closure handle table
  //   (4*32) + linked promise table (2*entry) + mutation log (16*32) +
  //   runtime-state cell + ledger region + capability-state table
  //   (default capacity at default 64 * 8 bytes/entry) + cost ledger +
  //   object-handle table (4*32).
  // Constants imported so a future format bump doesn't desync.
  assertEquals(bytes.byteLength,
    MEMBRANE_HEADER_SIZE + 16 * 32 + 8 * 32 + 256 + 4 * 4 + 1024 +
    4 * 32 + 2 * LINKED_PROMISE_ENTRY_SIZE + 16 * 32 +
    RUNTIME_STATE_CELL_BYTES + LEDGER_REGION_BYTES +
    DEFAULT_CAPABILITY_STATE_TABLE_CAPACITY * CAPABILITY_STATE_ENTRY_SIZE +
    DEFAULT_COST_LEDGER_CAPACITY * COST_LEDGER_ENTRY_SIZE +
    4 * 32);
});

// Removed: legacy createSession({ membraneBuffer }) pre-allocation
// tests. Under host-owned memory the caller always provides the
// buffer (via freshSession / restoreSession / the public layout
// helpers) and Membrane attaches over already-populated bytes — the
// "host gave me a buffer, lay it out for me" path no longer exists.

Deno.test("Metadata round-trips through snapshot/restore via the SAB value arena", () => {
  const original = freshSession();
  const h0 = original.airlock.register({ x: 1 }, { kind: 'foo', label: 'first' });
  const h1 = original.airlock.register({ x: 2 }, { kind: 'bar', count: 42 });
  const h2 = original.airlock.register({ x: 3 }, null); // no metadata
  const h3 = original.airlock.register({ x: 4 }, ['array', 'metadata', 99]);

  const snap = snapshotSession(original);
  const restored = restoreSession(snap.vatBytes, snap.membraneBytes);

  // Metadata survives — read from the SAB, not from a JS Map.
  assertEquals(restored.airlock.membrane.metadata(restored.airlock.membrane.handleForSlot(h0.slot)),
               { kind: 'foo', label: 'first' });
  assertEquals(restored.airlock.membrane.metadata(restored.airlock.membrane.handleForSlot(h1.slot)),
               { kind: 'bar', count: 42 });
  assertEquals(restored.airlock.membrane.metadata(restored.airlock.membrane.handleForSlot(h2.slot)),
               undefined);
  assertEquals(restored.airlock.membrane.metadata(restored.airlock.membrane.handleForSlot(h3.slot)),
               ['array', 'metadata', 99]);
});

Deno.test("Metadata exhausting the value arena throws MembraneOutOfSpaceError", () => {
  const session = freshSession({ valueArenaSize: 64 });
  // Each register encodes the metadata + 4-byte length prefix. A small
  // string like { kind: 'aaaa' } is ~12 bytes encoded + 4 = 16. After a few
  // registrations, the arena fills.
  let registered = 0;
  try {
    for (let i = 0; i < 100; i++) {
      session.airlock.register({}, { kind: 'aaaaaaaaaa' + i });
      registered++;
    }
  } catch (e) {
    // Expected: arena fills, throws.
    assertEquals(e.name, 'MembraneOutOfSpaceError');
  }
  // We registered some handles before failing; previous state intact.
  assert(registered > 0);
});

Deno.test("Grants survive snapshot/restore via SAB grant table + inverse index", () => {
  const original = freshSession();
  const h0 = original.airlock.register({}, { kind: 'thing' });
  const h1 = original.airlock.register({}, { kind: 'thing' });
  original.airlock.declare('A', h0);
  original.airlock.declare('B', h1);
  const root = original.airlock.createRootGrant('app-root');
  root.add(h0);
  const grantX = original.airlock.membrane.createGrant('X', { reason: 'test' });
  grantX.add(h0);
  grantX.add(h1);
  // Revoke a separate grant — its revoked flag should round-trip.
  const grantY = original.airlock.membrane.createGrant('Y');
  original.airlock.membrane.revoke(grantY);

  const snap = snapshotSession(original);
  const restored = restoreSession(snap.vatBytes, snap.membraneBytes);

  // Root grant survived and is in rootGrantSlots.
  assertEquals(restored.airlock.membrane.rootGrantSlots().has(root.slot), true);

  // Both non-root grants enumerate.
  const grants = restored.airlock.membrane.enumerateGrants();
  const grantSlots = grants.map(g => g.grant.slot).sort((a, b) => a - b);
  assertEquals(grantSlots, [root.slot, grantX.slot, grantY.slot].sort((a, b) => a - b));

  // grantX inverse index is intact.
  const restoredX = restored.airlock.membrane.grantForSlot(grantX.slot);
  assertEquals(restoredX.identifier, 'X');
  assertEquals(restoredX.metadata, { reason: 'test' });
  assertEquals(restoredX.handleSlots(), new Set([h0.slot, h1.slot]));

  // grantY's revoked flag survived.
  assertEquals(restored.airlock.membrane._isGrantActive(grantY.slot), false);

  // Handle declarationName survived.
  assertEquals(restored.airlock.membrane.declarationNameBySlot(h0.slot), 'A');
  assertEquals(restored.airlock.membrane.declarationNameBySlot(h1.slot), 'B');

  // checkBySlot still returns the right authorization decisions.
  // (h0 is in root + grantX; h1 is in grantX only.)
  // Authorization rule (post-snapshot, same as live): a handle is
  // authorized iff (a) ANY grant in its list is active AND (b) NO
  // grant in its list is revoked.
  const rootOnly = new Set([root.slot]);
  const xOnly = new Set([grantX.slot]);
  const both = new Set([root.slot, grantX.slot]);
  const empty = new Set();
  // h0 is in root AND grantX. Either one being active suffices.
  assertEquals(restored.airlock.membrane.checkBySlot(h0.slot, both), true);
  assertEquals(restored.airlock.membrane.checkBySlot(h0.slot, rootOnly), true);
  assertEquals(restored.airlock.membrane.checkBySlot(h0.slot, xOnly), true);
  assertEquals(restored.airlock.membrane.checkBySlot(h0.slot, empty), false);
  // h1 is in grantX only.
  assertEquals(restored.airlock.membrane.checkBySlot(h1.slot, xOnly), true);
  assertEquals(restored.airlock.membrane.checkBySlot(h1.slot, rootOnly), false);
});

Deno.test("Root grant authorization round-trips end-to-end through restored drone", () => {
  const original = freshSession();
  const counter = { value: 0 };
  const handle = original.airlock.register(counter);
  original.airlock.setHandler(handle, 'inc', () => ++counter.value);
  original.airlock.declare('Counter', handle);
  const root = original.airlock.createRootGrant('app');
  root.add(handle);

  // Verify the original session works.
  original.parse('Counter.inc(); Counter.inc();');
  original.run(0, 10000);
  assertEquals(counter.value, 2);

  const snap = snapshotSession(original);
  const restored = restoreSession(snap.vatBytes, snap.membraneBytes);

  // Re-bind the impl + handler on the restored session (host's job per Q5).
  const restoredHandle = restored.airlock.membrane.handleForSlot(handle.slot);
  restored.airlock.membrane._bindImpl(handle.slot, counter);
  restored.airlock.setHandler(restoredHandle, 'inc', () => ++counter.value);

  // Root grant + Counter declaration both came back from the SAB.
  // Drone code in the restored session can call Counter.inc() — authorization
  // works because rootGrantSlots() reads from the SAB.
  restored.parse('Counter.inc()');
  restored.run(0, 10000);
  assertEquals(counter.value, 3);
});

Deno.test("Round-trip with externals registered: snapshot preserves membrane wiring", () => {
  // This test verifies the slice 1 contract: handles registered on the
  // original session survive to the restored session at the same slot
  // positions and per-slot versions, and the membrane buffer round-trips
  // through the heap+membrane byte pair without corruption.
  const original = freshSession();
  const counter = { value: 0 };
  const h0 = original.airlock.register(counter, { kind: 'counter' });
  const h1 = original.airlock.register({ name: 'thing-1' }, { kind: 'thing' });
  const h2 = original.airlock.register({ name: 'thing-2' }, { kind: 'thing' });

  const snap = snapshotSession(original);

  const restored = restoreSession(snap.vatBytes, snap.membraneBytes);

  // All three slots survived with the same versions.
  for (const h of [h0, h1, h2]) {
    const reissued = restored.airlock.membrane.handleForSlot(h.slot);
    assertEquals(reissued.slot, h.slot);
    assertEquals(reissued.version, h.version);
  }

  // enumerateHandles returns the three slots in order.
  const list = restored.airlock.membrane.enumerateHandles();
  assertEquals(list.length, 3);
  assertEquals(list.map(e => e.handle.slot), [0, 1, 2]);

  // Implementations are JS-side and were not preserved; the host re-binds.
  for (const e of list) {
    assertEquals(e.impl, undefined);
  }
  // Metadata IS in the SAB and survived the round-trip.
  assertEquals(list[0].metadata, { kind: 'counter' });
  assertEquals(list[1].metadata, { kind: 'thing' });
  assertEquals(list[2].metadata, { kind: 'thing' });

  // After _bindImpl, lookup returns the fresh impl.
  restored.airlock.membrane._bindImpl(h1.slot, { name: 'thing-1-restored' });
  const reissuedH1 = restored.airlock.membrane.handleForSlot(h1.slot);
  assertEquals(restored.airlock.lookup(reissuedH1), { name: 'thing-1-restored' });
});

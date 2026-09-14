/**
 * airlock.pin(handle) — long-lived capability-surface handles survive
 * membrane compaction.
 *
 * The membrane walker's liveness model is: SS-heap references, grant
 * stacks, root grants. A handle a capability keeps only in host-side
 * JS closures (namespace objects returned by getters, factory
 * singletons) is invisible to it, so the first compaction reaps the
 * slot and the capability's wrapper goes stale ("Stale handle:
 * slot=N expected version=X, actual=Y"). pin() exempts such handles.
 *
 * Long-lived stream and claim namespace handles must survive collection
 * between transfers.
 *
 * Run with: deno task test tests/fuel/pinned_handles_test.js
 */

import { assert, assertEquals } from "https://deno.land/std@0.208.0/assert/mod.ts";
import { freshSession } from '../../src/host-owned-session.js';

Deno.test('baseline: unpinned, unreferenced handle is reaped by compactMembrane', () => {
  const session = freshSession();
  const al = session.airlock;

  const handle = al.register({ kind: 'transient' });
  const slot = al.membrane.slotOf(handle);
  assert(al.membrane._handleSlotIsLive(slot), 'freshly registered handle must be live');

  al.compactMembrane();

  assert(!al.membrane._handleSlotIsLive(slot),
    'unpinned handle with no SS reference must be reaped (liveness model)');
});

Deno.test('pinned handle survives compactMembrane and stays usable', () => {
  const session = freshSession();
  const al = session.airlock;

  const impl = { kind: 'surface' };
  const handle = al.pin(al.register(impl));
  const slot = al.membrane.slotOf(handle);

  al.compactMembrane();

  assert(al.membrane._handleSlotIsLive(slot), 'pinned handle must survive compaction');
  assertEquals(al.lookup(handle), impl, 'wrapper must still resolve to the impl');

  // Repeated compactions must not erode the pin.
  al.compactMembrane();
  assert(al.membrane._handleSlotIsLive(slot), 'pinned handle must survive repeated compaction');
});

Deno.test('pinned handle survives session.gc() (inline single-pass path)', () => {
  const session = freshSession();
  const al = session.airlock;

  const pinnedImpl = { kind: 'pinned-surface' };
  const pinnedHandle = al.pin(al.register(pinnedImpl));
  const pinnedSlot = al.membrane.slotOf(pinnedHandle);
  const transientHandle = al.register({ kind: 'transient' });
  const transientSlot = al.membrane.slotOf(transientHandle);

  // Give the heap something to do so gc() runs a real pass.
  session.parse('let x = "a" + "b"');
  session.run(0, 1000000);

  session.gc();

  assert(al.membrane._handleSlotIsLive(pinnedSlot), 'pinned handle must survive session.gc()');
  assert(!al.membrane._handleSlotIsLive(transientSlot), 'transient handle must be reaped by session.gc()');
  assertEquals(al.lookup(pinnedHandle), pinnedImpl);
});

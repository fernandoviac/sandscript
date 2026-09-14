/**
 * Debug observability tests covering mutation watchers and snapshot diff.
 *
 * Run with: deno task test tests/fuel/debug_slice_d_test.js
 */

import { assertEquals, assert, assertThrows } from "https://deno.land/std@0.208.0/assert/mod.ts";
import { createSession } from '../../src/fuel/session.js';
import { createDebug, diffSnapshots } from '../../src/fuel/debug.js';
import {
  Membrane,
  MUTATION_KIND,
  MUTATION_TAG,
} from '../../src/membrane/index.js';
import { freshSession, snapshotSession } from '../../src/host-owned-session.js';

// =============================================================================
// Item 10: mutation watchers
// =============================================================================

Deno.test("watcher: fires synchronously on matching mutations", () => {
  const session = freshSession();
  const debug = createDebug(session);
  const events = [];
  debug.setMutationWatcher(
    1 << MUTATION_KIND.HANDLE_ALLOC,
    (ev) => events.push(ev),
  );
  session.airlock.register({});
  session.airlock.register({});
  session.airlock.register({});
  assertEquals(events.length, 3);
  for (const ev of events) {
    assertEquals(ev.kind, MUTATION_KIND.HANDLE_ALLOC);
    assertEquals(ev.callerTag, MUTATION_TAG.EXPLICIT_HANDLE);
  }
});

Deno.test("watcher: kindMask filters firings", () => {
  const session = freshSession();
  const debug = createDebug(session);
  let count = 0;
  // Only revokes:
  debug.setMutationWatcher(1 << MUTATION_KIND.GRANT_REVOKE, () => count++);
  // Mix of mutations:
  session.airlock.register({});
  session.airlock.register({});
  const g = session.airlock.membrane.createGrant('g');
  session.airlock.membrane.revoke(g);
  session.airlock.membrane.revoke(session.airlock.membrane.createGrant('g2'));
  assertEquals(count, 2,
    `watcher should have fired exactly twice (for revokes), got ${count}`);
});

Deno.test("watcher: clearMutationWatcher stops further firings", () => {
  const session = freshSession();
  const debug = createDebug(session);
  let count = 0;
  debug.setMutationWatcher(0xFFFFFFFF, () => count++);
  session.airlock.register({});
  assertEquals(count, 1);
  debug.clearMutationWatcher();
  session.airlock.register({});
  assertEquals(count, 1, 'cleared watcher must not fire');
});

Deno.test("watcher: setMutationWatcher replaces the previous one on this Debug", () => {
  const session = freshSession();
  const debug = createDebug(session);
  let firstCalls = 0, secondCalls = 0;
  debug.setMutationWatcher(0xFFFFFFFF, () => firstCalls++);
  session.airlock.register({});
  debug.setMutationWatcher(0xFFFFFFFF, () => secondCalls++);
  session.airlock.register({});
  assertEquals(firstCalls, 1,
    'first watcher should have fired once before being replaced');
  assertEquals(secondCalls, 1,
    'second watcher should have fired once after replacement');
});

Deno.test("watcher: a throwing watcher does NOT break the engine", () => {
  const session = freshSession();
  const debug = createDebug(session);
  // Suppress the noisy console.error by overriding it for the
  // duration of the test (we expect exactly one error).
  const originalConsoleError = console.error;
  const errors = [];
  console.error = (...args) => errors.push(args);
  try {
    debug.setMutationWatcher(0xFFFFFFFF, () => {
      throw new Error('intentional');
    });
    // Should not throw out of register():
    session.airlock.register({});
    session.airlock.register({});
    // The engine continued and incremented counters normally.
    assertEquals(debug.mutationCounters().handleAlloc, 2);
    // Two failures should have been surfaced via console.error.
    assertEquals(errors.length, 2);
  } finally {
    console.error = originalConsoleError;
  }
});

Deno.test("watcher: zero cost when no watcher is installed", () => {
  // Behavioural check (not a perf benchmark): an unwatched session
  // produces no observable side effects from the watcher path. The
  // assertion that survives lint is "1 million registrations
  // complete without error in a reasonable time" — too flaky for
  // CI without baseline numbers. Instead assert that the watcher
  // list is empty by introspection.
  const session = freshSession();
  assertEquals(session.airlock.membrane._mutationWatchers.length, 0);
  // Many mutations without a Debug instance:
  for (let i = 0; i < 1000; i++) session.airlock.register({});
  // Still empty:
  assertEquals(session.airlock.membrane._mutationWatchers.length, 0);
});

Deno.test("watcher: two Debug instances on one session have independent watchers", () => {
  const session = freshSession();
  const d1 = createDebug(session);
  const d2 = createDebug(session);
  let c1 = 0, c2 = 0;
  d1.setMutationWatcher(0xFFFFFFFF, () => c1++);
  d2.setMutationWatcher(0xFFFFFFFF, () => c2++);
  session.airlock.register({});
  assertEquals(c1, 1);
  assertEquals(c2, 1);
  // Clearing one doesn't affect the other:
  d1.clearMutationWatcher();
  session.airlock.register({});
  assertEquals(c1, 1, 'd1 cleared — must not have fired again');
  assertEquals(c2, 2, 'd2 still installed — must have fired');
});

Deno.test("watcher: event payload matches log entry shape", () => {
  const session = freshSession();
  const debug = createDebug(session);
  let captured = null;
  debug.setMutationWatcher(0xFFFFFFFF, (ev) => { captured = ev; });
  const h = session.airlock.register({ kind: 'cap' });
  assert(captured !== null);
  assertEquals(captured.kind, MUTATION_KIND.HANDLE_ALLOC);
  assertEquals(captured.slot, h.slot);
  assertEquals(captured.version, h.version);
  assertEquals(captured.callerTag, MUTATION_TAG.EXPLICIT_HANDLE);
  assert(typeof captured.tick === 'bigint');
  assertEquals(typeof captured.seq, 'number');
});

Deno.test("watcher: rejects bad arguments", () => {
  const session = freshSession();
  const debug = createDebug(session);
  assertThrows(() => debug.setMutationWatcher('not a number', () => {}),
    TypeError);
  assertThrows(() => debug.setMutationWatcher(1, 'not a function'),
    TypeError);
});

// =============================================================================
// Item 11: diffSnapshots
// =============================================================================

Deno.test("diffSnapshots: known mutation set produces the expected diff", () => {
  const session = freshSession();
  const debug = createDebug(session);
  const snapA = snapshotSession(session);
  // Do a known set of mutations between snapshots.
  const h = session.airlock.register({});
  const g = session.airlock.membrane.createGrant('mid-diff');
  session.airlock.membrane.revoke(g);
  const snapB = snapshotSession(session);
  const diff = diffSnapshots(snapA, snapB);
  // Tick advanced (snapshots bump tick):
  assert(diff.tick.to > diff.tick.from);
  // Counters delta:
  assertEquals(diff.membrane.mutationCountersDelta.handleAlloc, 1);
  assertEquals(diff.membrane.mutationCountersDelta.grantCreate, 1);
  assertEquals(diff.membrane.mutationCountersDelta.grantRevoke, 1);
  // logBetween contains the new entries:
  const kinds = diff.membrane.logBetween.map(e => e.kind);
  assert(kinds.includes(MUTATION_KIND.HANDLE_ALLOC));
  assert(kinds.includes(MUTATION_KIND.GRANT_CREATE));
  assert(kinds.includes(MUTATION_KIND.GRANT_REVOKE));
});

Deno.test("diffSnapshots: handles inventory added entry", () => {
  const session = freshSession();
  const snapA = snapshotSession(session);
  const h = session.airlock.register({ kind: 'added' });
  const snapB = snapshotSession(session);
  const diff = diffSnapshots(snapA, snapB);
  // h appears in B's inventory but not A's.
  assertEquals(diff.membrane.handles.added.length, 1);
  assertEquals(diff.membrane.handles.added[0].handle.slot, h.slot);
  assertEquals(diff.membrane.handles.removed.length, 0);
});

Deno.test("diffSnapshots: handles removed entry", () => {
  const session = freshSession();
  const h = session.airlock.register({});
  const snapA = snapshotSession(session);
  session.airlock.membrane._freeHandleSlot(h.slot);
  const snapB = snapshotSession(session);
  const diff = diffSnapshots(snapA, snapB);
  // h's active entry in A is gone in B (B has it reaped).
  // Default dumpState includes reaped, so the slot appears in both
  // as different shapes. The diff matches by slot, so it'll be
  // matched and surfaced as a versionChanged entry instead.
  const matched = diff.membrane.handles.versionChanged
    .find(e => e.slot === h.slot);
  assert(matched !== undefined,
    `slot ${h.slot} should show up as versionChanged (alloc → reap)`);
});

Deno.test("diffSnapshots: empty between identical snapshots (no work)", () => {
  const session = freshSession();
  // Two snapshots back-to-back with no mutations in between.
  const snapA = snapshotSession(session);
  const snapB = snapshotSession(session);
  const diff = diffSnapshots(snapA, snapB);
  // No mutations between the two snapshots.
  assertEquals(diff.membrane.mutationCountersDelta.handleAlloc, 0);
  assertEquals(diff.membrane.mutationCountersDelta.grantCreate, 0);
  // snapshotCount engine counter was removed (host-owned-memory).
  // No new mutations:
  assertEquals(diff.membrane.logBetween.length, 0);
  // No inventory changes:
  assertEquals(diff.membrane.handles.added.length, 0);
  assertEquals(diff.membrane.handles.removed.length, 0);
  assertEquals(diff.membrane.handles.versionChanged.length, 0);
});

Deno.test("diffSnapshots: accepts pre-parsed dumpState objects", () => {
  const session = freshSession();
  const debug = createDebug(session);
  const dumpA = debug.dumpState();
  session.airlock.register({});
  const dumpB = debug.dumpState();
  const diff = diffSnapshots(dumpA, dumpB);
  // Same shape; mutation visible:
  assertEquals(diff.membrane.mutationCountersDelta.handleAlloc, 1);
});

Deno.test("diffSnapshots: rejects junk inputs", () => {
  assertThrows(() => diffSnapshots(null, null), TypeError);
  assertThrows(() => diffSnapshots(42, 'foo'), TypeError);
  assertThrows(() => diffSnapshots({ unrelated: true }, { unrelated: true }),
    TypeError);
});

Deno.test("diffSnapshots: contexts statusChanged", () => {
  const session = freshSession();
  const debug = createDebug(session);
  // Allocate a context by parsing + setting up — without running it,
  // it has the FREE-marker status. Use the same prime trick as
  // earlier tests:
  const r = session.parse('1+1');
  session.mem.setContextInstructionIndex(0, r.startIndex);
  session.mem.clearExitCondition(0);
  const dumpA = debug.dumpState();  // context exists, not yet run
  session.run(0, 100);              // now exitCondition='done'
  const dumpB = debug.dumpState();
  const diff = diffSnapshots(dumpA, dumpB);
  // Either statusChanged surfaces it, or contexts added if it
  // wasn't in dumpA. Either is acceptable forensics.
  const surfacedSomewhere =
    diff.contexts.statusChanged.length +
    diff.contexts.added.length +
    diff.contexts.removed.length;
  assert(surfacedSomewhere > 0,
    'context activity between snapshots should produce a diff');
});

Deno.test("diffSnapshots: heap diff reports added objects", () => {
  const session = freshSession();
  const debug = createDebug(session);
  const dumpA = debug.dumpState();
  // Run code that allocates on the heap.
  const r = session.parse('let arr = [1, 2, 3]');
  session.mem.setContextInstructionIndex(0, r.startIndex);
  session.mem.clearExitCondition(0);
  session.run(0, 10000);
  const dumpB = debug.dumpState();
  const diff = diffSnapshots(dumpA, dumpB);
  assert(diff.heap.available);
  assert(diff.heap.objectsAdded.length > 0,
    `running heap-allocating code should produce added heap objects`);
});

Deno.test("diffSnapshots: works on byte bundles", () => {
  const session = freshSession();
  const snapA = snapshotSession(session);
  session.airlock.register({});
  const snapB = snapshotSession(session);
  // Pass byte bundles directly (not dumpState objects):
  const diff = diffSnapshots(
    { membraneBytes: snapA.membraneBytes, vatBytes: snapA.vatBytes },
    { membraneBytes: snapB.membraneBytes, vatBytes: snapB.vatBytes },
  );
  assertEquals(diff.membrane.mutationCountersDelta.handleAlloc, 1);
});

Deno.test("diffSnapshots: heap unavailable when bytes missing", () => {
  const session = freshSession();
  const snapA = snapshotSession(session);
  session.airlock.register({});
  const snapB = snapshotSession(session);
  // No vatBytes:
  const diff = diffSnapshots(
    { membraneBytes: snapA.membraneBytes },
    { membraneBytes: snapB.membraneBytes },
  );
  assertEquals(diff.heap.available, false);
});

Deno.test("diffSnapshots: tick/from-to monotonic across the diff", () => {
  const session = freshSession();
  const snapA = snapshotSession(session);
  // Several host operations that bump the tick:
  session.gc();
  session.airlock.register({});
  const snapB = snapshotSession(session);
  const diff = diffSnapshots(snapA, snapB);
  assert(diff.tick.to > diff.tick.from,
    `tick must advance: ${diff.tick.from} → ${diff.tick.to}`);
});

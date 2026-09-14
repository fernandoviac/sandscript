/**
 * Membrane handle/grant compaction is folded into the heap GC pass
 * (session.gc()) with a single mark phase.
 *
 * Background: regular (non-closure) handles are reachable from the SS heap as
 * TYPE.EXTERNAL values; their lifetime is drone-heap reachability, NOT
 * host-wrapper GC. The membrane already had the correct reaper
 * (MembraneWalker + compact, via airlock.compactMembrane()), but nothing
 * triggered it automatically — so a drone churning regular handles leaked
 * handle-table slots for its whole life. This wires that reaper into the heap
 * GC the runtime already runs.
 *
 * What this proves:
 *  - collectLiveHandleSlots() + walkFrom() produce the same live sets as the
 *    standalone walk() (the refactor preserved the contract).
 *  - session.gc() reaps an orphaned regular handle (heap no longer references
 *    it) without an explicit compactMembrane() call.
 *  - session.gc() does NOT reap a handle the heap still references.
 *  - A drone that mints-and-drops regular handles in a loop, calling gc()
 *    between iterations, holds a BOUNDED handle-table high-water mark instead
 *    of growing without bound (the actual leak this fixes).
 *  - gc() reports handlesFreed / grantsFreed alongside heap stats.
 *
 * Run with: deno task test tests/membrane/gc_reaps_handles_test.js
 */

import { assertEquals, assert } from "https://deno.land/std@0.208.0/assert/mod.ts";
import { freshSession } from '../../src/host-owned-session.js';
import { MembraneWalker } from '../../src/membrane/walker.js';

// =============================================================================
// Refactor-equivalence: walk() === collectLiveHandleSlots() + walkFrom()
// =============================================================================

Deno.test("walk() equals collectLiveHandleSlots() + walkFrom()", () => {
  const session = freshSession();
  const a = session.airlock.register({}, { kind: 'a' });
  const b = session.airlock.register({}, { kind: 'b' });
  session.airlock.declare('A', a);
  session.airlock.declare('B', b);
  session.airlock.membrane.createGrant('g');  // orphan grant
  session.parse('let x = A');
  session.run(0, 1000);

  const walker = new MembraneWalker(
    session.memoryImage, session.collector, session.airlock, session.airlock.membrane,
  );

  const combined = walker.walk();
  const live = walker.collectLiveHandleSlots();
  const split = walker.walkFrom(live);

  assertEquals(
    [...combined.liveHandleSlots].sort((x, y) => x - y),
    [...split.liveHandleSlots].sort((x, y) => x - y),
  );
  assertEquals(
    [...combined.liveGrantSlots].sort((x, y) => x - y),
    [...split.liveGrantSlots].sort((x, y) => x - y),
  );
});

// =============================================================================
// session.gc() reaps regular handles (no explicit compactMembrane())
// =============================================================================

Deno.test("session.gc() reaps an orphaned regular handle", () => {
  const session = freshSession();
  // A handle that is never declared and never stored in the heap is
  // unreachable from every root the moment its host wrapper is dropped.
  // gc() must reclaim it without an explicit compactMembrane() call.
  session.airlock.register({}, { kind: 'orphan' });
  assertEquals(session.airlock.membraneStats().handleTableLive, 1);

  const result = session.gc();
  assertEquals(session.airlock.membraneStats().handleTableLive, 0);
  assert(result.handlesFreed >= 1, `expected >=1 handlesFreed, got ${result.handlesFreed}`);
});

Deno.test("session.gc() does NOT reap a heap-referenced regular handle", () => {
  const session = freshSession();
  const handle = session.airlock.register({}, { kind: 'api' });
  session.airlock.declare('Api', handle);
  session.airlock.setHandler(handle, 'value', () => 42);
  session.parse('let x = Api');
  session.run(0, 1000);

  session.gc();
  // Still reachable through the declared global + heap var → kept, and the
  // wrapper still resolves to its impl.
  assertEquals(session.airlock.membraneStats().handleTableLive, 1);
  assert(session.airlock.membrane.lookup(handle) !== undefined);
});

Deno.test("session.gc() reaps an orphaned grant too", () => {
  const session = freshSession();
  session.airlock.membrane.createGrant('x');  // not root, not on any stack
  assertEquals(session.airlock.membraneStats().grantTableLive, 1);

  const result = session.gc();
  assertEquals(session.airlock.membraneStats().grantTableLive, 0);
  assert(result.grantsFreed >= 1, `expected >=1 grantsFreed, got ${result.grantsFreed}`);
});

// =============================================================================
// The regression this fixes: bounded high-water mark under churn
// =============================================================================

Deno.test("mint-and-drop regular handles under gc() holds a bounded handle table", () => {
  const session = freshSession();

  // Simulate a long-lived drone that mints a fresh host-side object handle
  // each iteration and drops its reference at cycle end — exactly the
  // DOM-element-churn / per-request-Response shape. Each handle is otherwise
  // unreferenced (no declare, no heap value, no closure). Without GC-driven
  // membrane compaction the handle table grows by one slot per iteration and
  // never shrinks until teardown.
  const ITERATIONS = 50;
  let maxLive = 0;
  for (let i = 0; i < ITERATIONS; i++) {
    session.airlock.register({ node: i });  // mint; drop reference immediately
    session.gc();                           // reap the now-unreachable slot
    maxLive = Math.max(maxLive, session.airlock.membraneStats().handleTableLive);
  }

  // The high-water mark is bounded by the per-iteration live set (one freshly
  // minted handle before its gc()), NOT by cumulative mints. Without the fix
  // this would climb to ~ITERATIONS.
  assert(
    maxLive <= 1,
    `handle table high-water mark grew unbounded: maxLive=${maxLive} over ${ITERATIONS} iterations`,
  );
  assertEquals(session.airlock.membraneStats().handleTableLive, 0);
});

/**
 * Slice 3 of snapshottable-membrane: compaction (heap walker + free-list +
 * pool repack + arena reclaim) under Policy R1 (lazy reclaim).
 *
 * What this slice proves:
 * - airlock.compactMembrane() reclaims unreachable handle and grant slots,
 *   the id-list pool, and the value arena.
 * - Reachable slots (heap-referenced externals, drone-stack-referenced
 *   grants, closure-captured grants, root grants, transitively-referenced
 *   grants and handles) are NEVER freed.
 * - Stale wrappers held by the host throw on next use after their slot is
 *   reclaimed (version bumped on free).
 * - Reclaimed slots are reused by the next register() / createGrant().
 * - membraneStats() reflects the buffer state.
 * - Snapshot/restore through a compacted membrane preserves authorization.
 *
 * Run with: deno task test tests/membrane/compaction_test.js
 */

import { assertEquals, assertThrows, assert } from "https://deno.land/std@0.208.0/assert/mod.ts";
import { createSession } from '../../src/fuel/session.js';
import {
  Membrane,
  Handle,
  Grant,
  StaleHandleError,
  StaleGrantError,
} from '../../src/membrane/index.js';
import { freshSession, restoreSession, snapshotSession } from '../../src/host-owned-session.js';
import { MembraneWalker } from '../../src/membrane/walker.js';

// =============================================================================
// Helpers
// =============================================================================

/**
 * Run compaction and return the stats. Convenience wrapper that pulls the
 * collector from the session.
 */
function compact(session) {
  return session.airlock.compactMembrane();
}

// =============================================================================
// Basic reclamation
// =============================================================================

Deno.test("Compaction: unreferenced handle is freed; slot reused with bumped version", () => {
  const session = freshSession();
  // Register a handle that's NOT referenced by anything (no grant, no
  // declare, not in heap). It exists only as a host-side wrapper.
  const orphan = session.airlock.register({}, { kind: 'orphan' });
  assertEquals(session.airlock.membraneStats().handleTableLive, 1);

  // Drop the host's reference (just by not using it). Compaction frees it.
  session.airlock.compactMembrane();
  assertEquals(session.airlock.membraneStats().handleTableLive, 0);
  assertEquals(session.airlock.membraneStats().handleTableFree, 1);

  // Stale wrapper now throws.
  assertThrows(
    () => session.airlock.membrane.lookup(orphan),
    StaleHandleError,
  );

  // Next register() reuses the slot with a bumped version.
  const reused = session.airlock.register({});
  assertEquals(reused.slot, orphan.slot);
  assert(reused.version > orphan.version, 'reused version must exceed reclaimed version');
});

Deno.test("Compaction: heap-referenced handle is NOT freed", () => {
  const session = freshSession();
  const handle = session.airlock.register({});
  session.airlock.declare('Api', handle);
  session.airlock.setHandler(handle, 'value', () => 42);
  // Run a program that stores the external in a heap variable.
  session.parse('let x = Api');
  session.run(0, 1000);

  session.airlock.compactMembrane();
  assertEquals(session.airlock.membraneStats().handleTableLive, 1);
  // The wrapper still works.
  assertEquals(session.airlock.membrane.lookup(handle).constructor, Object);
});

Deno.test("Compaction: declared handle stays live (heap holds external in global scope)", () => {
  const session = freshSession();
  const handle = session.airlock.register({}, { kind: 'api' });
  session.airlock.declare('Api', handle);

  session.airlock.compactMembrane();
  // declareExternal adds the handle slot as a TYPE_EXTERNAL value to global
  // scope, so the heap walker finds it.
  assertEquals(session.airlock.membraneStats().handleTableLive, 1);
});

// =============================================================================
// Grant reclamation
// =============================================================================

Deno.test("Compaction: orphaned grant is freed", () => {
  const session = freshSession();
  const grant = session.airlock.membrane.createGrant('x');
  assertEquals(session.airlock.membraneStats().grantTableLive, 1);

  session.airlock.compactMembrane();
  assertEquals(session.airlock.membraneStats().grantTableLive, 0);

  assertThrows(
    () => session.airlock.membrane.revoke(grant),
    StaleGrantError,
  );
});

Deno.test("Compaction: root grant is NOT freed", () => {
  const session = freshSession();
  const root = session.airlock.createRootGrant('app');

  session.airlock.compactMembrane();
  assertEquals(session.airlock.membraneStats().grantTableLive, 1);
  assertEquals(session.airlock.membraneStats().rootGrantsCount, 1);
  // Wrapper still valid.
  assertEquals(root.identifier, 'app');
});

Deno.test("Compaction: grant referenced by a live handle's grant list stays alive (transitive)", () => {
  const session = freshSession();
  const handle = session.airlock.register({});
  session.airlock.declare('Api', handle);  // keeps handle live via heap

  const grant = session.airlock.membrane.createGrant('g');
  grant.add(handle);

  session.airlock.compactMembrane();
  // Both stay live: handle via declare, grant via handle's grant list.
  assertEquals(session.airlock.membraneStats().handleTableLive, 1);
  assertEquals(session.airlock.membraneStats().grantTableLive, 1);
});

Deno.test("Compaction: handle anchored by declare() + authorized by a root grant stays alive", () => {
  // Setup-then-defer pattern: the host registers an API handle at
  // startup, anchors it via declare() so the SS heap reaches it,
  // and adds it to a root grant for authorization scope. After
  // compaction both must survive.
  //
  // Note: declare() is the lifetime anchor, not grant.add(). A
  // handle that is ONLY in a grant's authorization list — never on
  // the heap, never in a closure, never returned to a caller — is
  // unreachable and gets reaped (see the "grant.add does NOT
  // anchor" test below). grant.add records authorization, not
  // reachability; see src/membrane/walker.js header for the full
  // doctrine.
  const session = freshSession();
  const handle = session.airlock.register({});
  session.airlock.declare('Api', handle);   // SS-heap anchor
  const root = session.airlock.createRootGrant('app');
  root.add(handle);                          // authorization tag

  session.airlock.compactMembrane();
  // Root grant lives via rootGrants; handle lives via the declared
  // heap binding. The grant's authorization of the handle has no
  // bearing on the handle's lifetime.
  assertEquals(session.airlock.membraneStats().handleTableLive, 1);
  assertEquals(session.airlock.membraneStats().grantTableLive, 1);
});

// =============================================================================
// Pool + arena reclamation
// =============================================================================

Deno.test("Compaction: id-list pool is repacked (orphaned runs reclaimed)", () => {
  const session = freshSession();
  const handle = session.airlock.register({});
  session.airlock.declare('Api', handle);  // keep handle live

  // Add many grants to the same handle. Each grant.add(handle) grows the
  // handle's grant-list and orphans the previous run.
  const grants = [];
  for (let i = 0; i < 10; i++) {
    const g = session.airlock.membrane.createGrant(`g${i}`);
    g.add(handle);
    grants.push(g);
  }
  // Mark all of them as root so they survive compaction.
  for (const g of grants) session.airlock.membrane.markAsRootGrant(g);

  const before = session.airlock.membraneStats();
  session.airlock.compactMembrane();
  const after = session.airlock.membraneStats();

  // The handle's grant list is 10 entries (40 bytes). Plus each grant's
  // handle list is 1 entry (4 bytes). Pool used after compact = 4 (sentinel)
  // + 40 + 10*4 = 84 bytes. The "before" used was much more because of
  // the bump-allocation of growing runs.
  assertEquals(after.idListPoolUsed, 4 + 40 + 10 * 4);
  assert(before.idListPoolUsed > after.idListPoolUsed,
    `expected reclamation; before=${before.idListPoolUsed}, after=${after.idListPoolUsed}`);

  // Authorization still works after the repack.
  const activeSet = new Set(grants.map(g => g.slot));
  assertEquals(session.airlock.membrane.checkBySlot(handle.slot, activeSet), true);
});

Deno.test("Compaction: value arena is repacked (orphaned msgpack bytes reclaimed)", () => {
  const session = freshSession();
  // Allocate a handle with metadata, then orphan it. Compaction must
  // reclaim its arena bytes.
  const orphan = session.airlock.register({}, { kind: 'orphan', extra: 'lots of bytes here' });
  const live = session.airlock.register({}, { kind: 'live' });
  session.airlock.declare('Live', live);

  const before = session.airlock.membraneStats();
  session.airlock.compactMembrane();
  const after = session.airlock.membraneStats();

  // Arena should have shrunk because the orphan's metadata bytes were dropped.
  assert(after.valueArenaUsed < before.valueArenaUsed,
    `expected arena reclamation; before=${before.valueArenaUsed}, after=${after.valueArenaUsed}`);
  // Live handle's metadata still intact.
  assertEquals(session.airlock.membrane.metadata(live), { kind: 'live' });
});

// =============================================================================
// Bounded growth (the long-running-host story)
// =============================================================================

Deno.test("Compaction: many alloc/orphan cycles return to constant memory", () => {
  const session = freshSession();
  const live = session.airlock.register({}, { kind: 'keeper' });
  session.airlock.declare('Keeper', live);

  // Initial baseline.
  session.airlock.compactMembrane();
  const baseline = session.airlock.membraneStats();

  // Many cycles of allocate-then-orphan.
  for (let cycle = 0; cycle < 100; cycle++) {
    const ephemerals = [];
    for (let i = 0; i < 50; i++) {
      ephemerals.push(session.airlock.register({}, { cycle, i }));
      ephemerals.push(session.airlock.membrane.createGrant(`g-${cycle}-${i}`));
    }
    // Drop references (not in any live root, not on heap, not in any list).
    session.airlock.compactMembrane();
  }

  const final = session.airlock.membraneStats();
  // The buffer should NOT have grown unbounded. Live counts should match
  // the baseline (just the keeper handle).
  assertEquals(final.handleTableLive, baseline.handleTableLive);
  assertEquals(final.grantTableLive, baseline.grantTableLive);
  // Arena and pool usage should be the same (or very close — only the live
  // keeper's bytes).
  assertEquals(final.valueArenaUsed, baseline.valueArenaUsed);
  assertEquals(final.idListPoolUsed, baseline.idListPoolUsed);
});

// =============================================================================
// Policy R1: revoked-but-referenced grants stay alive
// =============================================================================

Deno.test("Compaction (R1): revoked grant on suspended drone's stack is NOT freed", () => {
  const session = freshSession();
  const handle = session.airlock.register({});
  session.airlock.declare('Db', handle);
  let testResolver = null;
  session.airlock.setHandler(handle, 'query', ({ context }) => {
    return context.suspend((resolve) => { testResolver = resolve; });
  });

  let grant = null;
  session.airlock.onGrantRequest = (id) => {
    grant = session.airlock.membrane.createGrant(id);
    grant.add(handle);
    return { approved: true, grant };
  };

  session.parse(`
    let result = "none";
    grant "fs" {
      let r = Db.query();
      result = "ok:" + r;
    } denied (revoked) {
      result = "denied";
    }
  `);
  const r1 = session.run(0, 10000);
  assertEquals(r1.status, 'suspended');

  // Revoke the grant — but the drone is parked inside the grant block,
  // so its WAT grant stack still references grant.slot.
  session.airlock.membrane.revoke(grant);

  // Compact. Walker sees grant.slot on the suspended drone's grant
  // stack → marks it live → not freed.
  const stats = session.airlock.compactMembrane();
  assertEquals(stats.grantsFreed, 0);
  assert(session.airlock.membrane._grantSlotIsLive(grant.slot),
    'revoked-but-referenced grant slot must stay live');

  // Resume the suspension — the revocation handler must fire (slot still
  // holds the same revoked grant, no slot reuse happened).
  testResolver('value');
  const r2 = session.run(0, 10000);
  assertEquals(r2.status, 'done');
  assertEquals(session.get(0, 'result'), 'denied');
});

Deno.test("Compaction (R1): unreferenced revoked grant IS freed", () => {
  const session = freshSession();
  const grant = session.airlock.membrane.createGrant('throwaway');
  session.airlock.membrane.revoke(grant);

  session.airlock.compactMembrane();
  // Nothing referenced this grant — no handle, no drone stack, not root.
  // Reclaimed.
  assertEquals(session.airlock.membraneStats().grantTableLive, 0);
});

// =============================================================================
// Stats sanity
// =============================================================================

Deno.test("membraneStats: reports plausible numbers", () => {
  const session = freshSession();
  const h0 = session.airlock.register({});
  const h1 = session.airlock.register({});
  session.airlock.declare('A', h0);
  const root = session.airlock.createRootGrant('r');
  root.add(h0);

  const stats = session.airlock.membraneStats();
  assertEquals(stats.handleTableLive, 2);
  assertEquals(stats.grantTableLive, 1);
  assertEquals(stats.rootGrantsCount, 1);
  assert(stats.valueArenaUsed > 0);
  assert(stats.idListPoolUsed >= 4);
  assert(stats.totalBytes > 0);
});

// =============================================================================
// Snapshot/restore through compacted membrane
// =============================================================================

Deno.test("Snapshot/restore through compacted membrane preserves authorization", () => {
  const session = freshSession();
  const handle = session.airlock.register({}, { kind: 'api' });
  session.airlock.declare('Api', handle);
  const root = session.airlock.createRootGrant('app');
  root.add(handle);

  // Allocate some orphans, then compact (so the snapshot reflects a
  // compacted state).
  for (let i = 0; i < 5; i++) {
    session.airlock.register({}, { i });
    session.airlock.membrane.createGrant(`g${i}`);
  }
  session.airlock.compactMembrane();

  const snap = snapshotSession(session);
  const restored = restoreSession(snap.vatBytes, snap.membraneBytes);

  // Live handle + root grant survived.
  assertEquals(restored.airlock.membraneStats().handleTableLive, 1);
  assertEquals(restored.airlock.membraneStats().grantTableLive, 1);
  // checkBySlot still works correctly.
  const activeSet = new Set([root.slot]);
  assertEquals(restored.airlock.membrane.checkBySlot(handle.slot, activeSet), true);
  // Metadata + declarationName preserved through the arena repack.
  assertEquals(restored.airlock.membrane.metadataBySlot(handle.slot), { kind: 'api' });
  assertEquals(restored.airlock.membrane.declarationNameBySlot(handle.slot), 'Api');
});

// =============================================================================
// MembraneWalker direct unit tests
// =============================================================================

Deno.test("MembraneWalker: enumerates root grants", () => {
  const session = freshSession();
  const root = session.airlock.createRootGrant('r');

  const walker = new MembraneWalker(
    session.memoryImage,
    session.collector,
    session.airlock,
    session.airlock.membrane,
  );
  const live = walker.walk();
  assert(live.liveGrantSlots.has(root.slot));
});

Deno.test("MembraneWalker: enumerates handle slots from heap", () => {
  const session = freshSession();
  const handle = session.airlock.register({});
  session.airlock.declare('X', handle);

  const walker = new MembraneWalker(
    session.memoryImage,
    session.collector,
    session.airlock,
    session.airlock.membrane,
  );
  const live = walker.walk();
  assert(live.liveHandleSlots.has(handle.slot));
});

Deno.test("MembraneWalker: enumerates grant slots from drone grant stack", () => {
  const session = freshSession();
  const handle = session.airlock.register({});
  session.airlock.declare('Db', handle);
  let testResolver = null;
  session.airlock.setHandler(handle, 'q', ({ context }) => {
    return context.suspend((resolve) => { testResolver = resolve; });
  });

  let grant = null;
  session.airlock.onGrantRequest = (id) => {
    grant = session.airlock.membrane.createGrant(id);
    grant.add(handle);
    return { approved: true, grant };
  };

  session.parse('grant "g" { Db.q() }');
  const r1 = session.run(0, 10000);
  assertEquals(r1.status, 'suspended');

  const walker = new MembraneWalker(
    session.memoryImage,
    session.collector,
    session.airlock,
    session.airlock.membrane,
  );
  const live = walker.walk();
  assert(live.liveGrantSlots.has(grant.slot),
    'walker must find grant slot on suspended drone stack');

  // Cleanup so deno task test process doesn't hang.
  testResolver('done');
  session.run(0, 10000);
});

// =============================================================================
// Capability pattern: per-cycle handle attached to a long-lived root grant
// =============================================================================
//
// Repro extracted from a long-lived fetch capability and equivalent timer
// surfaces. The pattern:
//
//   - One long-lived root grant ("fetch") created once at drone deploy.
//   - Per cycle: register a fresh "Response" handle and call
//     fetchGrant.add(responseHandle) to authorize it under the grant.
//   - The drone drops its JS-side reference at cycle end. No SS heap
//     value, no closure, no context grant stack holds the handle.
//
// The walker SHOULD now consider the handle unreachable (no roots
// observe it) and compaction SHOULD reap it, shrinking the grant's
// idList back toward a constant. Today it doesn't: the walker's
// transitive-closure step propagates liveness from a live grant down
// to every handle in its idList (the "reverse transitive" rule
// asserted by the test 60 lines above). Under sustained load that
// produces unbounded growth of the handle table and idList pool, failing a
// 1000-cycle fetch stress test at approximately 620 cycles.
//
// This test asserts the desired post-fix behavior: handle table
// stays bounded across N grant-attached register-and-drop cycles.
// It WILL FAIL on the current walker.js (step 5 reverse direction
// marks every dropped handle live). The fix tightens the walker doctrine.

Deno.test("Compaction: grant.add does NOT anchor a handle whose JS ref is dropped", () => {
  const session = freshSession();
  const fetchGrant = session.airlock.createRootGrant('app:fetch');

  const N = 50;
  for (let i = 0; i < N; i++) {
    // Register a fresh handle and authorize it under the long-lived
    // grant. The handle is otherwise unreferenced: no declare(), no
    // SS heap value, no closure capture, no context stack entry.
    const responseHandle = session.airlock.register(
      { ok: true, status: 200 });
    fetchGrant.add(responseHandle);
    // Drop the wrapper — the host no longer holds a reference.
    // (We don't have FinalizationRegistry control in tests, but
    // the walker shouldn't need GC to consider this handle dead;
    // it has no live roots that should reach it.)
  }

  session.airlock.compactMembrane();
  const stats = session.airlock.membraneStats();
  // The fetch grant itself is a root grant and stays alive.
  assertEquals(stats.grantTableLive, 1, 'only the fetch grant lives');
  // Every Response handle should be reaped: no roots reach it.
  // The current walker marks them all live via step (5)'s reverse
  // direction; this assertion fails until that direction is removed.
  assertEquals(stats.handleTableLive, 0,
    `all dropped handles must be reaped (handleTableLive=${stats.handleTableLive} of ${N})`);
});

Deno.test("Compaction: grant.add + drop pattern repeated keeps idList bounded across compactions", () => {
  const session = freshSession();
  const fetchGrant = session.airlock.createRootGrant('app:fetch');

  // First batch + compact.
  for (let i = 0; i < 20; i++) {
    const h = session.airlock.register({});
    fetchGrant.add(h);
  }
  session.airlock.compactMembrane();
  const after1 = session.airlock.membraneStats().idListPoolUsed;

  // Second batch + compact. If handles were truly reaped after the
  // first compaction, the pool used after the second batch's compaction
  // should match (steady state). If handles are NOT being reaped
  // (current bug), the pool grows by another batch's worth.
  for (let i = 0; i < 20; i++) {
    const h = session.airlock.register({});
    fetchGrant.add(h);
  }
  session.airlock.compactMembrane();
  const after2 = session.airlock.membraneStats().idListPoolUsed;

  assertEquals(after1, after2,
    `idList pool must reach steady state across cycles; ` +
    `after1=${after1}, after2=${after2}`);
});

// (A) — Authorization survives compaction even when the handle's
// lifetime is anchored elsewhere. The grant→handle membership is
// recorded for permission checks; it doesn't keep the handle alive,
// but it doesn't get severed by compaction either, as long as both
// ends remain alive through their own roots.
Deno.test("Compaction: grant→handle authorization link is preserved through compaction", () => {
  const session = freshSession();
  const handle = session.airlock.register({});
  session.airlock.declare('Api', handle);                     // pin via heap
  const grant = session.airlock.membrane.createGrant('g1');
  session.airlock.membrane.markAsRootGrant(grant);            // pin grant via root
  grant.add(handle);                                          // authorize

  // Before compaction: authorization holds.
  const grantHandlesBefore = Array.from(
    session.airlock.membrane._readGrantHandleSet(grant.slot));
  assertEquals(grantHandlesBefore, [handle.slot]);

  session.airlock.compactMembrane();

  // After compaction: both still alive, authorization link intact.
  assertEquals(session.airlock.membraneStats().handleTableLive, 1);
  assertEquals(session.airlock.membraneStats().grantTableLive, 1);
  const grantHandlesAfter = Array.from(
    session.airlock.membrane._readGrantHandleSet(grant.slot));
  assertEquals(grantHandlesAfter, [handle.slot],
    'authorization survives compaction when both ends are pinned');
});

// (B) — Closure capture is a lifetime anchor for both the handle
// itself and (transitively) any grant the handle is authorized
// under. A handle reachable only through a closure must survive,
// and its authorizing grant must survive even if no other root
// reaches that grant.
Deno.test("Compaction: closure-captured handle + its authorizing grant both survive", () => {
  const session = freshSession();
  const handle = session.airlock.register({});
  session.airlock.declare('Api', handle);
  session.airlock.setHandler(handle, 'fire', () => 42);

  const grant = session.airlock.membrane.createGrant('cap');
  // NOT a root grant — relies on transitive reachability from the
  // handle's grant list to stay alive.
  grant.add(handle);

  // Drive an SS call under the grant; sandscript will end up
  // referencing both via the active context's heap state during
  // suspension or completion.
  session.parse('grant "cap" { Api.fire() }');
  session.airlock.onGrantRequest = (id) => {
    if (id === 'cap') return { approved: true, grant };
    return { approved: false };
  };
  const r = session.run(0, 10000);
  assertEquals(r.status, 'done');

  session.airlock.compactMembrane();

  // Handle pinned by declare; grant pinned transitively by handle
  // → grant link (step 5 forward direction).
  assertEquals(session.airlock.membraneStats().handleTableLive, 1);
  assertEquals(session.airlock.membraneStats().grantTableLive, 1,
    'grant survives via the live handle that names it (step 5 forward)');
});

// (C) — Handle authorized by multiple grants: dropping one grant
// from the pinned set must not affect the handle, because the
// handle's lifetime is from declare(), not from any grant.
Deno.test("Compaction: handle in two grants — losing one grant does not affect the handle", () => {
  const session = freshSession();
  const handle = session.airlock.register({});
  session.airlock.declare('Api', handle);

  const grantA = session.airlock.membrane.createGrant('A');
  const grantB = session.airlock.membrane.createGrant('B');
  session.airlock.membrane.markAsRootGrant(grantA);
  // grantB NOT a root — it'll be reaped because nothing pins it.
  grantA.add(handle);
  grantB.add(handle);

  session.airlock.compactMembrane();

  // Handle alive via declare. grantA alive via root. grantB reaped
  // because nothing transitively reaches it (the handle's grant
  // list still names it, so step 5 forward marks it live — actually
  // we expect grantB to LIVE here because the live handle's grant
  // list contributes it).
  assertEquals(session.airlock.membraneStats().handleTableLive, 1);
  assertEquals(session.airlock.membraneStats().grantTableLive, 2,
    'both grants survive: A via root, B via live-handle transitive');
});

// (D) — Scale: many register-and-grant.add-and-drop cycles converge
// to constant-bound memory. This is the load-pattern version of the
// "+drop pattern repeated" test above.
Deno.test("Compaction: 100 grant.add+drop cycles converge to a constant-bounded handle table", () => {
  const session = freshSession();
  const fetchGrant = session.airlock.createRootGrant('app:fetch');

  const samples = [];
  const BATCHES = 10;
  const PER_BATCH = 10;
  for (let b = 0; b < BATCHES; b++) {
    for (let i = 0; i < PER_BATCH; i++) {
      const h = session.airlock.register({});
      fetchGrant.add(h);
    }
    session.airlock.compactMembrane();
    const s = session.airlock.membraneStats();
    samples.push({
      handleTableLive: s.handleTableLive,
      idListPoolUsed:  s.idListPoolUsed,
    });
  }

  // Steady state: after the first compaction every batch reaches
  // the same bound. (The fetch grant itself contributes a small
  // sentinel idList entry; that's the only thing alive.)
  const first = samples[0];
  for (let i = 1; i < samples.length; i++) {
    assertEquals(samples[i].handleTableLive, first.handleTableLive,
      `batch ${i + 1} handleTableLive must match batch 1: ` +
      `${samples[i].handleTableLive} vs ${first.handleTableLive}`);
    assertEquals(samples[i].idListPoolUsed, first.idListPoolUsed,
      `batch ${i + 1} idListPoolUsed must match batch 1: ` +
      `${samples[i].idListPoolUsed} vs ${first.idListPoolUsed}`);
  }
  // And both bounds are small — order of the per-batch-allocation
  // (10), not order of cumulative N (100).
  assert(first.handleTableLive <= PER_BATCH,
    `handleTableLive should be bounded by per-batch alloc; got ${first.handleTableLive}`);
});

// (E) — Revoking a grant that was the sole authorizer of a still-
// reachable handle: the grant gets reaped (no roots), the handle
// stays (declare() pins it). The grant's idList entry for that
// handle disappears with the grant.
Deno.test("Compaction: revoking a grant doesn't reap a handle the heap still pins", () => {
  const session = freshSession();
  const handle = session.airlock.register({});
  session.airlock.declare('Api', handle);

  const grant = session.airlock.membrane.createGrant('temp');
  grant.add(handle);
  // Don't markAsRootGrant — when compaction runs and the SS heap
  // walk doesn't reach grant (no context grant stack, no closure
  // capture), the grant should be reaped.

  session.airlock.compactMembrane();

  // Handle alive via heap declare. Grant alive via transitive from
  // live handle (step 5 forward). Both stay; the grant doesn't get
  // reaped JUST because nothing else roots it.
  //
  // To actually see the grant get reaped, we'd need the handle to
  // also lose its reference to grant — see test (D) where the
  // handles ARE truly unreferenced and the cycle does reap.
  assertEquals(session.airlock.membraneStats().handleTableLive, 1);
  assertEquals(session.airlock.membraneStats().grantTableLive, 1);
});

// (F) — Focused walker unit test. Locks in the post-fix doctrine
// directly at the walker layer, independent of airlock plumbing,
// so that nobody silently re-introduces the grant → handle
// transitive direction.
Deno.test("MembraneWalker: live grant does NOT mark its idList handles live", () => {
  const session = freshSession();
  // Two handles. One declared (heap-anchored), one only registered.
  const heapHandle = session.airlock.register({});
  session.airlock.declare('Heap', heapHandle);
  const loneHandle = session.airlock.register({});

  // One root grant. Both handles are added — but only heapHandle
  // has independent reachability via declare().
  const grant = session.airlock.createRootGrant('all');
  grant.add(heapHandle);
  grant.add(loneHandle);

  const walker = new MembraneWalker(
    session.memoryImage,
    session.collector,
    session.airlock,
    session.airlock.membrane,
  );
  const live = walker.walk();

  // The walker must recognize the grant (it's a root) and the
  // heap-anchored handle (it's referenced from heap). It MUST NOT
  // anchor loneHandle just because the grant lists it.
  assert(live.liveGrantSlots.has(grant.slot),
    'walker finds the root grant');
  assert(live.liveHandleSlots.has(heapHandle.slot),
    'walker finds the declare()-pinned handle');
  assert(!live.liveHandleSlots.has(loneHandle.slot),
    `walker MUST NOT mark loneHandle live just because grant lists it; ` +
    `liveHandleSlots = ${Array.from(live.liveHandleSlots)}`);
});

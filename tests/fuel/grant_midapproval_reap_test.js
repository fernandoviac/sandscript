/**
 * Membrane compaction must not reap a grant held by the host during approval
 * or a pinned long-lived grant.
 *
 * The walker's liveness model is SS anchors only — context grant
 * stacks, root grants, closure-captured grants, live handles' grant
 * lists. Two host-JS holder classes are invisible to it:
 *
 *   1. A grant created inside onGrantRequest, between createGrant()
 *      and the airlock pushing its grant-stack entry. A pool-pressure
 *      compaction inside grant.add() (or any compaction during an
 *      async approval) reaps the slot, the approval pushes a dead
 *      entry, and the next runContext revocation sweep fires
 *      "Suspension orphaned: grant N was revoked" for a grant the
 *      host just approved. Fixed by the approval window
 *      (membrane.beginGrantApprovalWindow / handleGrantRequest).
 *
 *   2. A long-lived grant held only in a host variable between grant
 *      blocks, with no handle membership keeping it live. Fixed by
 *      airlock.pin(grant) — same contract as pinned handles.
 *
 * Security-relevant, not just availability: a freed slot is reused by
 * a later createGrant, and `entry.grantId` on the interpreter stack is
 * slot-only, so a stale wrapper aliases a different authorization
 * domain.
 *
 * Run with: deno task test tests/fuel/grant_midapproval_reap_test.js
 */

import { assert, assertEquals } from "https://deno.land/std@0.208.0/assert/mod.ts";
import { freshSession } from '../../src/host-owned-session.js';
import { parseAndSetup } from './test-helpers.js';

// An async grant decision suspends the slot instead of keeping session.run()
// pending, so direct Session callers drive the spawned-context drain loop
// while awaiting the whole grant statement.
async function runGrantToCompletion(session, slot = 0, fuel = 1_000_000, timeout = 2000) {
  let result = session.run(slot, fuel);
  const deadline = Date.now() + timeout;
  while (result.status === 'suspended' && Date.now() < deadline) {
    await Promise.resolve();
    await new Promise((r) => setTimeout(r, 0));
    const ready = session.airlock.drainPendingSpawnedContextIdentities();
    for (const readySlot of ready) {
      result = session.run(readySlot, fuel);
    }
  }
  return result;
}

// =============================================================================
// Approval window: per-approval grants survive compaction mid-approval
// =============================================================================

Deno.test("fresh grant per approval survives pool-pressure compaction", () => {
  // Default-size fresh grant/add cycles pressure and compact the id-list pool
  // at roughly 180 approvals. Every prior grant remains live through the
  // declared handle's grant list, so only append garbage is reclaimable.
  const session = freshSession();
  const { airlock } = session;

  const handle = airlock.register({});
  const calls = [];
  airlock.setHandler(handle, 'ping', () => { calls.push(1); return 1; });
  airlock.declare('Cap', handle);

  airlock.onGrantRequest = (identifier) => {
    const grant = airlock.membrane.createGrant(identifier);
    grant.add(handle); // pool pressure → compaction lands HERE
    return { approved: true, grant };
  };

  parseAndSetup(session, `
    let count = 0
    for (let i = 0; i < 200; i = i + 1) {
      grant "cap" { Cap.ping(); count = count + 1 }
    }
  `);
  const result = session.run(0, 100_000_000);

  assertEquals(result.status, 'done', `expected clean completion, got ${result.status}: ${result.error?.message}`);
  assertEquals(session.get(0, 'count'), 200);
  assertEquals(calls.length, 200);
  assertEquals(session.memoryImage.getGrantDepth(0), 0);
});

Deno.test("explicit compaction inside sync onGrantRequest cannot reap the new grant", () => {
  const session = freshSession();
  const { airlock } = session;

  airlock.onGrantRequest = (identifier) => {
    const grant = airlock.membrane.createGrant(identifier);
    airlock.compactMembrane(); // deterministic stand-in for pool pressure
    return { approved: true, grant };
  };

  parseAndSetup(session, 'let result = 0; grant "test" { result = 42 }');
  const result = session.run(0, 1_000_000);

  assertEquals(result.status, 'done', `expected clean completion, got ${result.status}: ${result.error?.message}`);
  assertEquals(session.get(0, 'result'), 42);
});

Deno.test("compaction during an async approval's event-loop turns cannot reap the new grant", async () => {
  const session = freshSession();
  const { airlock } = session;

  airlock.onGrantRequest = async (identifier) => {
    const grant = airlock.membrane.createGrant(identifier);
    await new Promise((resolve) => setTimeout(resolve, 1));
    airlock.compactMembrane(); // e.g. a host's periodic gc firing mid-approval
    return { approved: true, grant };
  };

  session.parse('let result = 0; grant "test" { result = 42 }');
  await runGrantToCompletion(session);

  assertEquals(session.get(0, 'result'), 42);
});

Deno.test("rejected grants become reapable once the approval window closes", () => {
  const session = freshSession();
  const { airlock } = session;

  let orphanSlot = null;
  airlock.onGrantRequest = (identifier) => {
    const grant = airlock.membrane.createGrant(identifier);
    orphanSlot = airlock.membrane.slotOfGrant(grant);
    return { approved: false }; // grant created, then discarded
  };

  parseAndSetup(session, 'let result = 0; grant "test" { result = 1 } denied { result = 99 }');
  session.run(0, 1_000_000);
  assertEquals(session.get(0, 'result'), 99);

  assert(airlock.membrane._grantSlotIsLive(orphanSlot),
    'discarded grant stays allocated until a compaction');
  airlock.compactMembrane();
  assert(!airlock.membrane._grantSlotIsLive(orphanSlot),
    'window must not outlive the approval — discarded grant is reaped');
});

// =============================================================================
// pin(grant): long-lived host-held grants survive compaction by fiat
// =============================================================================

Deno.test("baseline: unpinned, unanchored grant is reaped by compactMembrane", () => {
  const session = freshSession();
  const { airlock } = session;

  const grant = airlock.membrane.createGrant('cap');
  const slot = airlock.membrane.slotOfGrant(grant);

  airlock.compactMembrane();

  assert(!airlock.membrane._grantSlotIsLive(slot),
    'unpinned grant with no SS anchor must be reaped (liveness model)');
});

Deno.test("pinned grant survives compactMembrane and stays usable", () => {
  const session = freshSession();
  const { airlock } = session;

  const grant = airlock.pin(airlock.membrane.createGrant('cap'));
  const slot = airlock.membrane.slotOfGrant(grant);

  airlock.compactMembrane();
  assert(airlock.membrane._grantSlotIsLive(slot), 'pinned grant must survive compaction');
  assertEquals(grant.active, true, 'wrapper must still pass its version check');

  airlock.compactMembrane();
  assert(airlock.membrane._grantSlotIsLive(slot), 'pinned grant must survive repeated compaction');

  // The pinned grant still works as an authorization domain.
  const handle = airlock.pin(airlock.register({}));
  grant.add(handle);
  assert(grant.handleSlots().has(airlock.membrane.slotOf(handle)));
});

Deno.test("unpin returns the grant to normal liveness rules", () => {
  const session = freshSession();
  const { airlock } = session;

  const grant = airlock.pin(airlock.membrane.createGrant('cap'));
  const slot = airlock.membrane.slotOfGrant(grant);

  airlock.compactMembrane();
  assert(airlock.membrane._grantSlotIsLive(slot));

  airlock.unpin(grant);
  airlock.compactMembrane();
  assert(!airlock.membrane._grantSlotIsLive(slot),
    'unpinned grant must be reaped by the next compaction');
});

Deno.test("pinned grant survives session.gc() (inline single-pass path)", () => {
  const session = freshSession();
  const { airlock } = session;

  const pinnedGrant = airlock.pin(airlock.membrane.createGrant('pinned'));
  const pinnedSlot = airlock.membrane.slotOfGrant(pinnedGrant);
  const transientGrant = airlock.membrane.createGrant('transient');
  const transientSlot = airlock.membrane.slotOfGrant(transientGrant);

  // Give the heap something to do so gc() runs a real pass.
  session.parse('let x = "a" + "b"');
  session.run(0, 1_000_000);

  session.gc();

  assert(airlock.membrane._grantSlotIsLive(pinnedSlot), 'pinned grant must survive session.gc()');
  assert(!airlock.membrane._grantSlotIsLive(transientSlot), 'transient grant must be reaped by session.gc()');
  assertEquals(pinnedGrant.active, true);
});

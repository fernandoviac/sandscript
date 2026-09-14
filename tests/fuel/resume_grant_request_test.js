/**
 * airlock.resumeGrantRequest(linkedPromiseSlot, request) finishes a grant
 * statement parked at EXIT_GRANT_REQUEST from outside its original
 * onGrantRequest / _processGrants promise chain, such as after the process
 * owning that chain exits.
 *
 * The embedder captures identifiers, identifierAddrs, deniedAddr, and
 * continuationId from the onGrant `request` event when the grant is first
 * requested. This event is the sole source of values that cannot be recovered
 * from restored memory. After a snapshot/restore round trip, the fresh session
 * has no original hooks, and resumeGrantRequest re-drives the same request
 * through a newly installed onGrantRequest hook.
 *
 * Run with: deno task test tests/fuel/resume_grant_request_test.js
 */

import { assertEquals, assertThrows, assert } from "https://deno.land/std@0.208.0/assert/mod.ts";
import { freshSession, restoreSession, snapshotSession } from '../../src/host-owned-session.js';
import { parseAndSetup } from './test-helpers.js';

// Drive a session's spawned-context queue to completion — same shape as
// grant_async_suspension_test.js's runGrantToCompletion, duplicated here
// (not imported) since that helper is bound to a differently-shaped
// pending-fuel default in a file about a different suspension mechanism.
async function driveSuspensionToCompletion(session, result, fuel = 10000, timeout = 2000) {
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

// Parks a slot on `grant "test" { result = 42; } denied (rejected) { result = -1; }`
// with an onGrantRequest that never resolves — simulating a process
// killed while genuinely still waiting on the first ask, before
// _processGrants ever reaches its base case. Captures the recovered
// request state via the onGrant 'request' event (the only place it's
// exposed) and returns { session, request } with the slot left parked.
function parkOnUnansweredGrantRequest() {
  const session = freshSession();
  const { airlock } = session;

  let request = null;
  airlock.onGrant = (e) => {
    if (e.kind === 'request') request = e;
  };
  // Never resolves — mirrors a process killed mid-ask.
  airlock.onGrantRequest = () => new Promise(() => {});

  session.parse(`
    let result = 0;
    grant "test" { result = 42; } denied (rejected) { result = -1; }
  `);
  const parked = session.run(0, 10000);
  assertEquals(parked.status, 'suspended', 'slot 0 must be parked on the grant request');
  assert(request !== null, 'onGrant request event must have fired');
  assertEquals(request.identifiers, ['test']);
  assertEquals(request.identifierAddrs.length, 1);
  assert(typeof request.deniedAddr === 'number');
  assert(typeof request.continuationId === 'number');

  return { session, request };
}

Deno.test("resumeGrantRequest: approves a grant restored after a simulated process restart", async () => {
  const { session, request } = parkOnUnansweredGrantRequest();

  const snap = snapshotSession(session);
  const restored = restoreSession(snap.vatBytes, snap.membraneBytes);
  // Fresh restored session has no hooks wired at all — the original
  // onGrantRequest promise is gone with the dead process, same as any
  // other in-flight JS state. No auto-reject (embedder-owned restore):
  // the linked-promise entry survives verbatim.
  const entries = restored.airlock.enumerateLinkedPromises();
  assertEquals(entries.length, 1);
  assertEquals(entries[0].parkedContextSlot, 0);

  // resumeGrantRequest re-drives _processGrants, which calls
  // onGrantRequest synchronously as part of the SAME call — the hook
  // must be installed BEFORE calling resumeGrantRequest, same as any
  // ordinary (non-resumed) grant request.
  restored.airlock.onGrantRequest = (identifier) => ({ approved: true, grant: restored.airlock.membrane.createGrant(identifier) });
  restored.airlock.resumeGrantRequest(entries[0].slot, {
    identifiers: request.identifiers,
    identifierAddrs: request.identifierAddrs,
    deniedAddr: request.deniedAddr,
    continuationId: request.continuationId,
  });

  const result = await driveSuspensionToCompletion(restored, { status: 'suspended' });
  assertEquals(result.status, 'done');
  assertEquals(restored.get(0, 'result'), 42);
  assertEquals(restored.airlock.linkedPromiseCount(), 0,
    'the linked-promise slot must be freed once resumeGrantRequest finishes');
});

Deno.test("resumeGrantRequest: denies a grant restored after a simulated process restart", async () => {
  const { session, request } = parkOnUnansweredGrantRequest();

  const snap = snapshotSession(session);
  const restored = restoreSession(snap.vatBytes, snap.membraneBytes);
  const [entry] = restored.airlock.enumerateLinkedPromises();

  restored.airlock.onGrantRequest = () => ({ approved: false });
  restored.airlock.resumeGrantRequest(entry.slot, {
    identifiers: request.identifiers,
    identifierAddrs: request.identifierAddrs,
    deniedAddr: request.deniedAddr,
    continuationId: request.continuationId,
  });

  const result = await driveSuspensionToCompletion(restored, { status: 'suspended' });
  assertEquals(result.status, 'done');
  assertEquals(restored.get(0, 'result'), -1, 'denied block must have run');
  assertEquals(restored.airlock.linkedPromiseCount(), 0);
});

Deno.test("resumeGrantRequest: async onGrantRequest hook (the realistic case — a wire round-trip)", async () => {
  // The synchronous-decision tests above prove the finalize mechanics;
  // This proves the expected embedder shape: onGrantRequest itself performs
  // asynchronous work, such as a wire round trip, before
  // resumeGrantRequest's suspendOnGrantRequest-style settle() runs.
  const { session, request } = parkOnUnansweredGrantRequest();
  const snap = snapshotSession(session);
  const restored = restoreSession(snap.vatBytes, snap.membraneBytes);
  const [entry] = restored.airlock.enumerateLinkedPromises();

  let releaseApproval;
  const approvalPromise = new Promise(r => { releaseApproval = r; });
  restored.airlock.onGrantRequest = async (identifier) => {
    await approvalPromise;
    return { approved: true, grant: restored.airlock.membrane.createGrant(identifier) };
  };
  restored.airlock.resumeGrantRequest(entry.slot, {
    identifiers: request.identifiers,
    identifierAddrs: request.identifierAddrs,
    deniedAddr: request.deniedAddr,
    continuationId: request.continuationId,
  });

  // Still pending — the async hook hasn't resolved yet.
  await Promise.resolve();
  await new Promise((r) => setTimeout(r, 0));
  assertEquals(restored.get(0, 'result'), 0, 'grant block has not run yet');
  assertEquals(restored.airlock.linkedPromiseCount(), 1,
    'linked-promise slot stays live while the async decision is pending');

  releaseApproval();
  const result = await driveSuspensionToCompletion(restored, { status: 'suspended' });
  assertEquals(result.status, 'done');
  assertEquals(restored.get(0, 'result'), 42);
  assertEquals(restored.airlock.linkedPromiseCount(), 0);
});

Deno.test("resumeGrantRequest: onGrantRequest throwing synchronously still frees the linked-promise slot before rethrowing", () => {
  // Distinct from handleGrantRequest's own catch branch (which never
  // needs to free a linked-promise slot, because on a LIVE first-time
  // request the slot isn't registered until suspendOnGrantRequest sees
  // an actual Promise — a sync throw never reaches that point).
  // resumeGrantRequest is always called against an ALREADY-registered
  // slot (from the original, now-dead suspendOnGrantRequest call before
  // the restart), so a sync throw here would leak that slot forever
  // unless resumeGrantRequest itself cleans it up before rethrowing.
  const { session, request } = parkOnUnansweredGrantRequest();
  const snap = snapshotSession(session);
  const restored = restoreSession(snap.vatBytes, snap.membraneBytes);
  const [entry] = restored.airlock.enumerateLinkedPromises();

  restored.airlock.onGrantRequest = () => { throw new Error('capability exploded'); };
  assertThrows(
    () => restored.airlock.resumeGrantRequest(entry.slot, {
      identifiers: request.identifiers,
      identifierAddrs: request.identifierAddrs,
      deniedAddr: request.deniedAddr,
      continuationId: request.continuationId,
    }),
    Error,
    'capability exploded',
  );
  assertEquals(restored.airlock.linkedPromiseCount(), 0,
    'the linked-promise slot must not leak when onGrantRequest throws synchronously');
});

Deno.test("resumeGrantRequest: multi-identifier statement re-drives ALL identifiers from index 0, not a single injected decision", async () => {
  // `grant (a, b) { }` is parser sugar for exactly one GRANT_START and park,
  // so there is no per-identifier interpreter suspension to resume.
  // resumeGrantRequest re-enters _processGrants at index 0 and calls
  // onGrantRequest for every identifier in the recovered list.
  const session = freshSession();
  const { airlock } = session;

  let request = null;
  airlock.onGrant = (e) => { if (e.kind === 'request') request = e; };
  airlock.onGrantRequest = () => new Promise(() => {});

  session.parse(`
    let result = 0;
    grant ("a", "b") { result = 42; } denied (rejected) { result = -1; }
  `);
  const parked = session.run(0, 10000);
  assertEquals(parked.status, 'suspended');
  assertEquals(request.identifiers, ['a', 'b']);
  assertEquals(request.identifierAddrs.length, 2);

  const snap = snapshotSession(session);
  const restored = restoreSession(snap.vatBytes, snap.membraneBytes);
  const [entry] = restored.airlock.enumerateLinkedPromises();

  const callOrder = [];
  restored.airlock.onGrantRequest = (identifier) => {
    callOrder.push(identifier);
    return { approved: true, grant: restored.airlock.membrane.createGrant(identifier) };
  };
  restored.airlock.resumeGrantRequest(entry.slot, {
    identifiers: request.identifiers,
    identifierAddrs: request.identifierAddrs,
    deniedAddr: request.deniedAddr,
    continuationId: request.continuationId,
  });

  const result = await driveSuspensionToCompletion(restored, { status: 'suspended' });
  assertEquals(result.status, 'done');
  assertEquals(callOrder, ['a', 'b'], 'onGrantRequest must be called for every identifier, in order, from scratch');
  assertEquals(restored.get(0, 'result'), 42);
});

Deno.test("resumeGrantRequest: fired into a request whose live approval chain is still in flight must not double-finalize", async () => {
  // A late fire-and-forget resume can target a request that parked after
  // respawn and is already owned by a live _processGrants chain. Both chains
  // then carry the same still-valid continuationId, so a staleness check alone
  // passes twice and attempts to finalize the request twice. The
  // duplicate-finalize guard rejects the second chain before it advances past
  // GRANT_START or pushes another grant entry.
  const session = freshSession();
  const { airlock } = session;

  let request = null;
  const approvedEvents = [];
  const resumeEvents = [];
  const skippedEvents = [];
  airlock.onGrant = (e) => {
    if (e.kind === 'request') request = e;
    if (e.kind === 'approved') approvedEvents.push(e);
    if (e.kind === 'resume') resumeEvents.push(e);
    if (e.kind === 'finalize-skipped') skippedEvents.push(e);
  };

  // Live chain: async approval gated on `release` (the shape of an
  // embedder approveGrant wire round-trip).
  let release;
  const gate = new Promise((r) => { release = r; });
  airlock.onGrantRequest = async (identifier) => {
    await gate;
    return { approved: true, grant: airlock.membrane.createGrant(identifier) };
  };

  session.parse(`
    let result = 0;
    grant "test" { result = 42; } denied (rejected) { result = -1; }
  `);
  assertEquals(session.run(0, 10000).status, 'suspended');

  // The late resume, targeting the SAME parked request with the CURRENT
  // continuationId. Sync approver so finalize #1 lands deterministically
  // before the live chain's finalize #2.
  const [entry] = airlock.enumerateLinkedPromises();
  airlock.onGrantRequest = (identifier) =>
    ({ approved: true, grant: airlock.membrane.createGrant(identifier) });
  airlock.resumeGrantRequest(entry.slot, {
    identifiers: request.identifiers,
    identifierAddrs: request.identifierAddrs,
    deniedAddr: request.deniedAddr,
    continuationId: request.continuationId,
  });

  release();
  const result = await driveSuspensionToCompletion(session, { status: 'suspended' });
  assertEquals(result.status, 'done');
  assertEquals(session.get(0, 'result'), 42);
  assertEquals(approvedEvents.length, 1,
    'the duplicate finalize must be a no-op — exactly one approved event');
  assertEquals(session.airlock.linkedPromiseCount(), 0);

  // The instrumentation trail of the duplicate: the resume itself is
  // announced, and the losing chain's finalize is skipped with a named
  // reason instead of silently corrupting the slot.
  assertEquals(resumeEvents.length, 1);
  assertEquals(resumeEvents[0].slot, 0);
  assertEquals(skippedEvents.length, 1,
    'the second finalize must surface as a finalize-skipped event');
  assertEquals(skippedEvents[0].reason, 'already-finalized');
  assertEquals(skippedEvents[0].decision, 'approved');
});

Deno.test("resumeGrantRequest: duplicate REJECTION against a live in-flight request must not double-finalize either", async () => {
  // The denied twin of the test above: a duplicate rejection would both
  // corrupt the pc AND marshal the rejected-identifiers array onto the
  // pending stack a second time.
  const session = freshSession();
  const { airlock } = session;

  let request = null;
  const deniedEvents = [];
  const skippedEvents = [];
  airlock.onGrant = (e) => {
    if (e.kind === 'request') request = e;
    if (e.kind === 'denied') deniedEvents.push(e);
    if (e.kind === 'finalize-skipped') skippedEvents.push(e);
  };

  let release;
  const gate = new Promise((r) => { release = r; });
  airlock.onGrantRequest = async () => {
    await gate;
    return { approved: false };
  };

  session.parse(`
    let result = 0;
    grant "test" { result = 42; } denied (rejected) { result = -1; }
  `);
  assertEquals(session.run(0, 10000).status, 'suspended');

  const [entry] = airlock.enumerateLinkedPromises();
  airlock.onGrantRequest = () => ({ approved: false });
  airlock.resumeGrantRequest(entry.slot, {
    identifiers: request.identifiers,
    identifierAddrs: request.identifierAddrs,
    deniedAddr: request.deniedAddr,
    continuationId: request.continuationId,
  });

  release();
  const result = await driveSuspensionToCompletion(session, { status: 'suspended' });
  assertEquals(result.status, 'done');
  assertEquals(session.get(0, 'result'), -1, 'denied block must have run exactly once');
  assertEquals(deniedEvents.length, 1,
    'the duplicate finalize must be a no-op — exactly one denied event');
  assertEquals(session.airlock.linkedPromiseCount(), 0);
  assertEquals(skippedEvents.length, 1,
    'the second finalize must surface as a finalize-skipped event');
  assertEquals(skippedEvents[0].reason, 'already-finalized');
  assertEquals(skippedEvents[0].decision, 'denied');
});

Deno.test("resumeGrantRequest: throws on a non-live linked-promise slot", () => {
  const session = freshSession();
  assertThrows(
    () => session.airlock.resumeGrantRequest(99, {
      identifiers: ['x'], identifierAddrs: [0], deniedAddr: 0, continuationId: 1,
    }),
    Error,
    "not a live linked-promise entry",
  );
});

Deno.test("resumeGrantRequest: throws on a linked-promise slot with no parked context (JS-Promise-backed entry)", () => {
  // A linked promise created via the ordinary JS-Promise-bridge path
  // (not context.suspend/suspendOnGrantRequest) has no parkedContextSlot
  // at all — resumeGrantRequest must reject it rather than silently
  // operate on the wrong kind of entry.
  const session = freshSession();
  const { airlock } = session;
  const apiHandle = airlock.register({});
  airlock.setHandler(apiHandle, 'fetch', () => new Promise(() => {}));
  airlock.declare('Api', apiHandle);
  const root = airlock.createRootGrant('app');
  root.add(apiHandle);

  session.parse(`let p = Api.fetch();`);
  session.run(0, 10000);
  const [entry] = airlock.enumerateLinkedPromises();
  assertEquals(entry.parkedContextSlot, -1, 'JS-Promise-backed entry has no parked context');

  assertThrows(
    () => airlock.resumeGrantRequest(entry.slot, {
      identifiers: ['x'], identifierAddrs: [0], deniedAddr: 0, continuationId: 1,
    }),
    Error,
    'not a grant-request suspension',
  );
});

Deno.test("resumeGrantRequest: stale continuationId (slot freed and reused since the request was persisted) is a no-op finalize", async () => {
  // _finalizeGrantApproval/_finalizeGrantRejection already check
  // continuationId themselves (see their own doc comments) —
  // resumeGrantRequest does not duplicate that check, so this test
  // locks in that the existing check still protects a resumed request
  // the same way it protects a live one.
  const { session, request } = parkOnUnansweredGrantRequest();
  const snap = snapshotSession(session);
  const restored = restoreSession(snap.vatBytes, snap.membraneBytes);
  const [entry] = restored.airlock.enumerateLinkedPromises();

  // Simulate the slot having been freed and its number reused for a
  // fresh, unrelated program between restore and the resume call —
  // exactly the scenario suspendOnGrantRequest's own staleness test
  // covers for the live path.
  restored.airlock.freeContext(0);
  const reusedSlot = restored.airlock.allocateContext();
  assertEquals(reusedSlot, 0);
  parseAndSetup(restored, 'let other = 0; other = 7;', 0);
  const freshResult = restored.run(0, 10000);
  assertEquals(freshResult.status, 'done');
  assertEquals(restored.get(0, 'other'), 7);

  restored.airlock.onGrantRequest = () => ({ approved: true, grant: restored.airlock.membrane.createGrant('test') });
  restored.airlock.resumeGrantRequest(entry.slot, {
    identifiers: request.identifiers,
    identifierAddrs: request.identifierAddrs,
    deniedAddr: request.deniedAddr,
    continuationId: request.continuationId,
  });
  await Promise.resolve();
  await new Promise((r) => setTimeout(r, 0));

  assertEquals(restored.get(0, 'other'), 7,
    'stale finalize must not touch the reused slot\'s state');
  assertEquals(restored.state(0).exitCondition, 'done',
    'reused slot must still be done, not reopened by the stale finalize');
  assertEquals(restored.airlock.linkedPromiseCount(), 0,
    'resumeGrantRequest still consumes the linked-promise slot even when the finalize is a stale no-op');
});

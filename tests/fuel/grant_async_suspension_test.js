/**
 * Async grant decisions use the same suspension path as other parked
 * operations.
 *
 * These tests pin two properties:
 *
 *   1. session.js's `grant_request` branch suspends through
 *      `airlock.suspendOnGrantRequest` and immediately returns
 *      `{status: 'suspended'}` rather than promise-chaining its own `run()`
 *      call. A slot parked on a slow decision is therefore not counted as
 *      in flight by Runtime, and `SCHEDULER_IDLE` fires while the decision
 *      remains pending. Direct Session callers must drive the spawned-context
 *      drain loop after this suspend point.
 *
 *   2. Revocation can race an in-flight approval without interrupting the
 *      outstanding hook, and multi-identifier `grant (a, b) {}` statements
 *      invoke asynchronous hooks in order while applying approval atomically.
 */

import { assertEquals, assert } from "https://deno.land/std@0.208.0/assert/mod.ts";
import { freshSession } from '../../src/host-owned-session.js';
import { RuntimeBuilder } from '../../src/runtime/test-harness.js';
import { RUNTIME_STATE } from '../../src/runtime/index.js';
import { parseAndSetup } from './test-helpers.js';

function tick(ms = 0) { return new Promise(r => setTimeout(r, ms)); }

// Pump the spawned-context drain loop starting from an in-progress
// `result` until the slot is no longer suspended. Factored out from
// `runGrantToCompletion` so tests that need to interleave an action
// (revoke a grant, release a gate) between the initial suspend and
// final completion can call session.run() themselves first, then hand
// the result here to finish draining.
async function drainGrantSuspension(session, result, fuel = 10000, timeout = 2000) {
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

// Drive a bare Session's grant suspension to completion: pump the
// spawned-context drain loop until the slot is no longer suspended.
async function runGrantToCompletion(session, slot = 0, fuel = 10000) {
  return drainGrantSuspension(session, session.run(slot, fuel), fuel);
}

// Pump the drain loop until `condition()` is true (e.g. an inner grant's
// async hook has been called), stopping BEFORE the suspension is fully
// resolved. Used to reach "parked at the inner grant statement" without
// resolving it, so a test can act (revoke, release) while it's genuinely
// still pending. Throws if the slot goes terminal before the condition
// is met, or after too many pumps, so a broken assumption fails loudly
// instead of the caller's own post-loop assert silently doing the work.
async function pumpUntil(session, initialResult, condition, fuel = 10000, timeout = 2000) {
  let result = initialResult;
  const deadline = Date.now() + timeout;
  while (!condition() && Date.now() < deadline) {
    if (result.status !== 'suspended') {
      throw new Error(`pumpUntil: slot went ${result.status} before condition was met`);
    }
    await Promise.resolve();
    await new Promise((r) => setTimeout(r, 0));
    const ready = session.airlock.drainPendingSpawnedContextIdentities();
    for (const readySlot of ready) {
      result = session.run(readySlot, fuel);
    }
  }
  if (!condition()) throw new Error('pumpUntil: condition never became true');
  return result;
}

async function waitFor(condition, { timeout = 2000, label = 'condition' } = {}) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    if (condition()) return;
    await tick(2);
  }
  throw new Error(`waitFor timed out: ${label}`);
}

// =============================================================================
// The core regression: runtime-level idle/in-flight behavior while a grant
// decision is pending.
// =============================================================================

Deno.test("a pending async grant decision does not keep the drive in flight", async () => {
  // The grant_request branch returns {status: 'suspended'} immediately after
  // parking through airlock.suspendOnGrantRequest. Runtime can therefore
  // transition from RUNNING to SCHEDULER_IDLE while approval remains pending.
  let releaseApproval;
  const approvalPromise = new Promise(r => { releaseApproval = r; });

  const { runtime, session, channels } = new RuntimeBuilder()
    .capability({
      name: 'fs',
      setup: (al) => {
        al.onGrantRequest = async (identifier) => {
          await approvalPromise;
          const grant = al.membrane.createGrant(identifier);
          return { approved: true, grant };
        };
      },
    })
    .onInboundMessage(() => {})
    .build();
  await runtime.start();

  session.parse('let result = 0; grant "fs" { result = 42; }');
  const runPromise = runtime.run(0);
  await tick(10);

  assertEquals(runtime.getSchedulerStats().inFlight, 0,
    'a pending async grant decision must not be counted in-flight');
  assertEquals(runtime.runtimeState.get(), RUNTIME_STATE.SCHEDULER_IDLE,
    'SCHEDULER_IDLE must publish while the grant is still pending');

  const suspended = await runPromise;
  assertEquals(suspended.status, 'suspended',
    'the drive episode that yields on the grant returns suspended, not done');
  assertEquals(session.get(0, 'result'), 0, 'grant block has not run yet');

  releaseApproval();
  await waitFor(() => runtime.getEngineState(0).status === 'done',
    { label: 'slot 0 to reach done after the grant resolves' });
  assertEquals(session.get(0, 'result'), 42);

  await runtime.terminate();
  channels.close();
});

// =============================================================================
// Continuation-id staleness for suspendOnGrantRequest
// =============================================================================

Deno.test("Grant: a grant approval that resolves after its slot is freed and reused is a no-op", async () => {
  // suspendOnGrantRequest captures `continuationId` at suspend time and checks
  // it against the slot's current continuation id when the grant promise
  // settles, matching the stale-suspension guard used for external calls. A
  // grant-parked slot cannot suspend on a second operation while approval is
  // pending because it remains at EXIT_GRANT_REQUEST. Its continuation id can
  // change only if the slot is freed and reused for a fresh context;
  // memoryImage._initializeContext zeroes the entire context object on both
  // free and slot-number reuse.
  //
  // A settlement arriving after reuse must not corrupt the new occupant: no
  // grant entry is pushed onto its grant stack, and neither its instruction
  // pointer nor its exception state changes.
  const session = freshSession();
  const { airlock, memoryImage } = session;

  let releaseGrant;
  const grantApproval = new Promise(r => { releaseGrant = r; });
  airlock.onGrantRequest = async (identifier) => {
    await grantApproval;
    const grant = airlock.membrane.createGrant(identifier);
    return { approved: true, grant };
  };

  session.parse('let result = 0; grant "test" { result = 42; }');
  const parked = session.run(0, 10000);
  await Promise.resolve();
  await new Promise((r) => setTimeout(r, 0));
  assertEquals(parked.status, 'suspended', 'slot 0 is parked on the async grant decision');
  assertEquals(memoryImage.getGrantDepth(0), 0, 'grant not yet pushed — still pending');

  // Free slot 0's context and reuse the same slot number for a fresh,
  // unrelated program — WITHOUT ever letting the original grant settle.
  airlock.freeContext(0);
  const reusedSlot = airlock.allocateContext();
  assertEquals(reusedSlot, 0, 'the freed slot number must be the one reused (lowest-free-first)');
  parseAndSetup(session, 'let other = 0; other = 7;', 0);
  const freshResult = session.run(0, 10000);
  assertEquals(freshResult.status, 'done');
  assertEquals(session.get(0, 'other'), 7);
  const grantDepthBeforeStaleSettle = memoryImage.getGrantDepth(0);

  // Now let the ORIGINAL (stale) grant approval settle. Its resolve
  // continuation must recognize the continuation id no longer matches
  // and do nothing — no grant entry pushed onto the reused slot's grant
  // stack, no re-enqueue, no corruption of the fresh program's state.
  releaseGrant();
  await Promise.resolve();
  await new Promise((r) => setTimeout(r, 0));
  await new Promise((r) => setTimeout(r, 0));

  assertEquals(memoryImage.getGrantDepth(0), grantDepthBeforeStaleSettle,
    'stale settle must not push a grant entry onto the reused slot');
  assertEquals(session.get(0, 'other'), 7, 'reused slot state must be untouched by the stale settle');
  assertEquals(session.state(0).exitCondition, 'done',
    'reused slot must still be done, not reopened by the stale settle');
});

// =============================================================================
// Revocation racing an in-flight async grant approval
// =============================================================================

Deno.test("Grant: revoking an outer grant while an inner grant's async approval is pending routes to outer's denied block", async () => {
  // runContext checks the calling context's held grant stack for revocation
  // before every dispatch. An outer grant revoked while an inner grant's
  // decision remains pending is caught the next time the slot is driven,
  // because resolving the suspension only re-enqueues the slot and runContext
  // repeats the revocation check on entry.
  const session = freshSession();
  const { airlock } = session;

  const id = airlock.register({});
  airlock.declare('Api', id);

  let outerGrant = null;
  let releaseInner;
  const innerApproval = new Promise(r => { releaseInner = r; });
  let innerHookCalled = false;

  airlock.onGrantRequest = async (identifier) => {
    if (identifier === 'outer') {
      const grant = airlock.membrane.createGrant(identifier);
      outerGrant = grant;
      return { approved: true, grant };
    }
    // identifier === 'inner': stays pending until the test releases it.
    innerHookCalled = true;
    await innerApproval;
    const grant = airlock.membrane.createGrant(identifier);
    grant.add(id);
    return { approved: true, grant };
  };

  session.parse(`
    let result = "none";
    grant "outer" {
      grant "inner" {
        result = "inner-ok";
      } denied (revoked) {
        result = "inner-denied";
      }
    } denied (revoked) {
      result = "outer-denied";
    }
  `);

  // Drive the slot until it's genuinely parked at the inner grant
  // (the inner hook has been called and is awaiting innerApproval) —
  // NOT just "the outer hook ran," which happens synchronously inside
  // _processGrants and proves nothing about the interpreter having
  // resumed past the outer suspension.
  const parked = await pumpUntil(session, session.run(0, 10000), () => innerHookCalled);
  assert(outerGrant !== null, 'outer grant should already be approved');
  assertEquals(session.get(0, 'result'), 'none', 'inner grant decision still pending');

  // Revoke the outer grant while the inner grant's async approval is
  // still outstanding.
  airlock.membrane.revoke(outerGrant);
  releaseInner();

  await drainGrantSuspension(session, parked);
  assertEquals(session.get(0, 'result'), 'outer-denied',
    'outer revocation must win over the inner grant eventually resolving');
});

Deno.test("Grant: revoking an outer grant does not prevent the inner async grant's onGrantRequest hook from being called", async () => {
  // Revocation is caught on re-entry to runContext rather than by
  // short-circuiting a hook already in flight. Because the inner hook was
  // called before the outer revocation, it still resolves; its result becomes
  // moot when execution jumps to the outer denied block. No special path
  // interrupts an outstanding onGrantRequest call.
  const session = freshSession();
  const { airlock } = session;

  const id = airlock.register({});
  airlock.declare('Api', id);

  let outerGrant = null;
  let releaseInner;
  const innerApproval = new Promise(r => { releaseInner = r; });
  let innerHookCalled = false;
  let innerHookResolved = false;

  airlock.onGrantRequest = async (identifier) => {
    if (identifier === 'outer') {
      const grant = airlock.membrane.createGrant(identifier);
      outerGrant = grant;
      return { approved: true, grant };
    }
    innerHookCalled = true;
    await innerApproval;
    innerHookResolved = true;
    const grant = airlock.membrane.createGrant(identifier);
    grant.add(id);
    return { approved: true, grant };
  };

  session.parse(`
    let result = "none";
    grant "outer" {
      grant "inner" {
        result = "inner-ok";
      } denied (revoked) {
        result = "inner-denied";
      }
    } denied (revoked) {
      result = "outer-denied";
    }
  `);

  // Drive the slot until it's genuinely parked at the inner grant, not
  // just until the outer hook has run (see the sibling test above).
  const parked = await pumpUntil(session, session.run(0, 10000), () => innerHookCalled);
  assert(outerGrant !== null, 'outer grant should already be approved');

  airlock.membrane.revoke(outerGrant);
  releaseInner();

  await drainGrantSuspension(session, parked);
  assert(innerHookResolved, 'inner hook runs to completion even though its result becomes moot');
  assertEquals(session.get(0, 'result'), 'outer-denied');
});

// =============================================================================
// Multi-identifier ordering with async hooks
// =============================================================================

Deno.test("Grant: multi-identifier grant preserves strict in-order hook invocation under async hooks", async () => {
  // A `grant (a, b) { }` statement calls onGrantRequest for "b" only after
  // "a"'s promise resolves. The compiler emits one GRANT_START for the whole
  // statement, while _processGrants performs the identifier recursion. Any
  // change to concurrent dispatch must fail this ordering oracle.
  const session = freshSession();
  const { airlock } = session;

  const callOrder = [];
  const resolveOrder = [];
  airlock.onGrantRequest = async (identifier) => {
    callOrder.push(identifier);
    // "b"'s hook resolves faster than "a"'s would, if they were
    // dispatched concurrently — proves strict sequencing, not just
    // call-order, because a naive Promise.all would still call both
    // synchronously up front even though b's hook body runs after a's.
    await tick(identifier === 'a' ? 10 : 0);
    resolveOrder.push(identifier);
    const grant = airlock.membrane.createGrant(identifier);
    return { approved: true, grant };
  };

  session.parse('let result = 0; grant ("a", "b") { result = 42; }');
  await runGrantToCompletion(session);

  assertEquals(callOrder, ["a", "b"],
    "b's hook must not be invoked until a's promise has resolved");
  assertEquals(resolveOrder, ["a", "b"]);
  assertEquals(session.get(0, 'result'), 42);
});

Deno.test("Grant: multi-identifier grant with async hooks — later identifier's rejection after earlier's approval", async () => {
  // Partial approval state accumulated after "a" is correctly discarded
  // rather than partially applied when a later identifier in the same
  // statement is rejected. The accumulator remains internal to
  // _processGrants until every identifier has been approved.
  const session = freshSession();
  const { airlock } = session;

  const grantsCreated = [];
  airlock.onGrantRequest = async (identifier) => {
    await Promise.resolve();
    if (identifier === 'b') {
      return { approved: false };
    }
    const grant = airlock.membrane.createGrant(identifier);
    grantsCreated.push(identifier);
    return { approved: true, grant };
  };

  session.parse(`
    let result = 0;
    grant ("a", "b") { result = 1; } denied (rejected) { result = 99; }
  `);
  await runGrantToCompletion(session);

  assertEquals(grantsCreated, ["a"], "a's grant object is created before b is rejected");
  assertEquals(session.get(0, 'result'), 99, "the whole statement is denied, not partially applied");
  assertEquals(session.memoryImage.getGrantDepth(0), 0,
    "no grant entries pushed to the stack when any identifier in the batch is rejected");
});

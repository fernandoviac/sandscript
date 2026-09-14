/**
 * Tests for async property getters: a getter that returns a Promise (or a
 * SuspensionMarker via context.suspend(...)) parks the reading slot on the
 * existing suspendOnPromise / _setupSuspension machinery; the slot resumes
 * with the resolved value pushed onto its pending stack.
 */

import { assertEquals, assert } from "https://deno.land/std@0.208.0/assert/mod.ts";
import { createSession } from '../../src/fuel/session.js';
import { parseAndSetup } from './test-helpers.js';
import {
  EXIT_DONE,
  EXIT_ERROR,
  EXIT_AWAIT,
  EXIT_ASYNC_COMPLETE,
  EXIT_ASYNC_REJECTED,
  EXIT_EXTERNAL_CALL,
  EXIT_EXTERNAL_PROPERTY,
} from '../../src/fuel/constants.js';
import { freshSession } from '../../src/host-owned-session.js';

/**
 * Run the session until every tracked context has reached a terminal exit.
 * Lifted from promise_bridging_test.js — same shape, same drain semantics.
 */
async function runToCompletion(session, maxIterations = 200) {
  const mem = session.memoryImage;
  const airlock = session.airlock;
  const contexts = [{ slot: 0, generation: session.memoryImage.getContextGeneration(0) }]

  for (let iter = 0; iter < maxIterations; iter++) {
    await new Promise(r => setTimeout(r, 0));

    {
      const spawned = airlock.drainPendingSpawnedContextIdentities();
      for (const ctx of spawned) {
        if (!contexts.find(c => c.slot === ctx.slot && c.generation === ctx.generation)) {
          contexts.push(ctx);
        }
      }
    }

    let contextToRun = null;
    for (const ctx of contexts) {
      const exitCondition = mem.getExitCondition(ctx.slot);
      if (exitCondition === EXIT_DONE || exitCondition === EXIT_ERROR ||
          exitCondition === EXIT_ASYNC_COMPLETE || exitCondition === EXIT_ASYNC_REJECTED) {
        continue;
      }
      if (exitCondition === EXIT_AWAIT) {
        continue;
      }
      // Slot parked at an external call/property exit AND registered in
      // pendingContexts is suspended on a SuspensionMarker; do not run it
      // until the marker resolves/rejects (which clears the exit condition).
      // Without this skip, the poller would re-enter the WAT with no value
      // pushed and read garbage off the pending stack.
      if ((exitCondition === EXIT_EXTERNAL_CALL || exitCondition === EXIT_EXTERNAL_PROPERTY) &&
          airlock.pendingContexts && airlock.pendingContexts.has(ctx.slot)) {
        continue;
      }
      contextToRun = ctx;
      break;
    }

    if (!contextToRun) {
      // Keep looping while either an SS-linked JS promise hasn't settled
      // OR a slot is parked on a SuspensionMarker (pendingContexts).
      // Either path may resolve on a future event-loop tick.
      const hasLinked = airlock.linkedPromiseCount && airlock.linkedPromiseCount() > 0;
      const hasPending = airlock.pendingContexts && airlock.pendingContexts.size > 0;
      if ((hasLinked || hasPending) && iter < maxIterations - 1) {
        continue;
      }
      break;
    }

    const result = session.run(contextToRun, 100);

    if (result.status === 'async_call' && result.asyncContext !== undefined) {
      contexts.push(result.asyncContext);
    }

    if (result.status === 'await') {
      airlock.handleAwait(contextToRun.slot);
    }

    if (result.status === 'async_complete') {
      const { waiters } = airlock.handleAsyncComplete(contextToRun.slot);
      for (const w of waiters) {
        if (!contexts.find(c => c.slot === w.slot && c.generation === w.generation)) {
          contexts.push(w);
        }
      }
    }

    if (result.status === 'async_rejected') {
      const { waiters } = airlock.handleAsyncRejected(contextToRun.slot);
      for (const w of waiters) {
        if (!contexts.find(c => c.slot === w.slot && c.generation === w.generation)) {
          contexts.push(w);
        }
      }
    }

    if (result.status === 'promise_method') {
      if (result.contexts) {
        for (const ctx of result.contexts) {
          if (!contexts.find(c => c.slot === ctx.slot && c.generation === ctx.generation)) {
            contexts.push(ctx);
          }
        }
      }
    }
  }
}

function declareExternal(session, name, { methods = {}, getters = {}, grant } = {}) {
  const airlock = session.airlock;
  const handleId = airlock.register({});
  const g = grant || airlock.createRootGrant(`test:${name}`);
  g.add(handleId);
  for (const [m, fn] of Object.entries(methods)) {
    airlock.setHandler(handleId, m, fn);
  }
  for (const [p, fn] of Object.entries(getters)) {
    airlock.setGetter(handleId, p, fn);
  }
  airlock.declare(name, handleId);
  return { handleId, grant: g };
}

// ---------------------------------------------------------------------------
// 1. Async getter returning a resolved value
// ---------------------------------------------------------------------------

Deno.test("async getter: resolved Promise yields the value via await", async () => {
  const session = freshSession();
  declareExternal(session, 'obj', {
    getters: { foo: () => Promise.resolve(42) },
  });

  parseAndSetup(session, `
    let x;
    async function main() { x = await obj.foo; }
    main();
  `);
  await runToCompletion(session);
  assertEquals(session.get(0, 'x'), 42);
});

// ---------------------------------------------------------------------------
// 2. Async getter returning a rejected promise — drone catches via try/catch
// ---------------------------------------------------------------------------

Deno.test("async getter: rejected Promise is catchable in drone", async () => {
  const session = freshSession();
  declareExternal(session, 'obj', {
    getters: { foo: () => Promise.reject(new Error('boom')) },
  });

  parseAndSetup(session, `
    let msg;
    async function main() {
      try { let x = await obj.foo; }
      catch (e) { msg = e.message; }
    }
    main();
  `);
  await runToCompletion(session);
  assertEquals(session.get(0, 'msg'), 'boom');
});

// ---------------------------------------------------------------------------
// 3. Mixed: same handle has sync and async getters; sync path doesn't suspend
// ---------------------------------------------------------------------------

Deno.test("async getter: mixed sync + async getters on same handle", async () => {
  const session = freshSession();
  declareExternal(session, 'obj', {
    getters: {
      syncProp: () => 7,
      asyncProp: () => Promise.resolve(99),
    },
  });

  parseAndSetup(session, `
    let a = obj.syncProp;
    let b;
    async function main() { b = await obj.asyncProp; }
    main();
  `);
  await runToCompletion(session);
  assertEquals(session.get(0, 'a'), 7);
  assertEquals(session.get(0, 'b'), 99);
});

// ---------------------------------------------------------------------------
// 4. Chained read — `await (await obj.first).second`
//    obj.first is async, returns another External; .second is sync on that.
// ---------------------------------------------------------------------------

Deno.test("async getter: chained read across async then sync", async () => {
  const session = freshSession();
  const airlock = session.airlock;
  const grant = airlock.createRootGrant('test:chain');

  const innerId = airlock.register({});
  grant.add(innerId);
  airlock.setGetter(innerId, 'second', () => 5);

  const outerId = airlock.register({});
  grant.add(outerId);
  airlock.setGetter(outerId, 'first', () => Promise.resolve(innerId));
  airlock.declare('outer', outerId);

  parseAndSetup(session, `
    let v;
    async function main() {
      let mid = await outer.first;
      v = mid.second;
    }
    main();
  `);
  await runToCompletion(session);
  assertEquals(session.get(0, 'v'), 5);
});

// ---------------------------------------------------------------------------
// 5. Concurrent: two contexts reading the same async getter
//    Both park on a single deferred Promise; both resume on settle.
// ---------------------------------------------------------------------------

Deno.test("async getter: two contexts park on the same deferred and both resume", async () => {
  const session = freshSession();
  let resolveExternal;
  const deferred = new Promise(resolve => { resolveExternal = resolve; });

  declareExternal(session, 'obj', {
    getters: { ready: () => deferred },
  });

  // Two async drone functions both read obj.ready in parallel.
  parseAndSetup(session, `
    let a, b;
    async function one() { a = await obj.ready; }
    async function two() { b = await obj.ready; }
    one();
    two();
  `);

  // Settle the external promise on the next macrotask so both readers have
  // already parked by the time it resolves.
  setTimeout(() => resolveExternal(123), 5);

  await runToCompletion(session);
  assertEquals(session.get(0, 'a'), 123);
  assertEquals(session.get(0, 'b'), 123);
});

// ---------------------------------------------------------------------------
// 6. Read inside a grant block — grant authorization runs regardless of
//    sync/async; verify the async path doesn't bypass the check.
// ---------------------------------------------------------------------------

Deno.test("async getter: grant authorization still runs for async path", async () => {
  const session = freshSession();
  const airlock = session.airlock;

  // Register the handle WITHOUT adding it to any root grant. The drone
  // must enter a grant block to access it; if the async path bypasses the
  // grant check, the drone would receive 42 instead of a grant error.
  const handleId = airlock.register({});
  airlock.setGetter(handleId, 'foo', () => Promise.resolve(42));
  airlock.declare('obj', handleId);

  parseAndSetup(session, `
    let v, err;
    async function main() {
      try { v = await obj.foo; }
      catch (e) { err = e.message; }
    }
    main();
  `);
  await runToCompletion(session);
  // Grant denial — drone gets an error, not the value.
  assert(session.get(0, 'err'), 'expected grant denial error from un-granted handle');
  assertEquals(session.get(0, 'v'), undefined);
});

// ---------------------------------------------------------------------------
// 7. Getter returns a SuspensionMarker via context.suspend(...)
//    Mirror the method side: marker.asyncCallback(resolve, reject) drives
//    the resume.
// ---------------------------------------------------------------------------

Deno.test("async getter: SuspensionMarker via context.suspend", async () => {
  const session = freshSession();
  // The drone assigns the continuation when it actually evaluates
  // `obj.foo`; injecting on a bare timer races that evaluation. The suspend
  // executor is the event, so resolve from inside it.
  let armResolve;
  const armed = new Promise((resolve) => { armResolve = resolve; });
  declareExternal(session, 'obj', {
    getters: {
      foo: ({ context }) => context.suspend((resolve, _reject) => {
        armResolve(resolve);
      }),
    },
  });

  parseAndSetup(session, `
    let x;
    async function main() { x = await obj.foo; }
    main();
  `);

  armed.then((externalResolve) => externalResolve(77));

  await runToCompletion(session);
  assertEquals(session.get(0, 'x'), 77);
});

// ---------------------------------------------------------------------------
// 7b. SuspensionMarker rejection — drone catches via try/catch
//     Method-side coverage of the reject continuation lives in
//     suspension_test.js; this exercises the equivalent path on the
//     property side (different call site through _setupSuspension's
//     reject branch, same primitive).
// ---------------------------------------------------------------------------

Deno.test("async getter: SuspensionMarker rejection is catchable in drone", async () => {
  const session = freshSession();
  // Same event-driven injection as the resolve-side sibling above.
  let armResolve;
  const armed = new Promise((resolve) => { armResolve = resolve; });
  declareExternal(session, 'obj', {
    getters: {
      foo: ({ context }) => context.suspend((_resolve, reject) => {
        armResolve(reject);
      }),
    },
  });

  parseAndSetup(session, `
    let msg;
    async function main() {
      try { let x = await obj.foo; }
      catch (e) { msg = e.message; }
    }
    main();
  `);

  armed.then((externalReject) => externalReject(new Error('marker-fail')));

  await runToCompletion(session);
  assertEquals(session.get(0, 'msg'), 'marker-fail');
});

// ---------------------------------------------------------------------------
// 8. Getter that constructs `new Promise((resolve) => ...)`
//    The executor's resolve call may enqueue a spawned context; verify
//    session.js drains pendingSpawnedContexts after the property read, which
//    is required in addition to unwrapping the Promise.
// ---------------------------------------------------------------------------

Deno.test("async getter: getter that constructs a new Promise drains spawned contexts", async () => {
  const session = freshSession();

  // Getter constructs `new Promise(executor)` — the executor's resolve
  // is called synchronously inside the getter. The session.js
  // external_property branch must (a) suspend the slot on the returned
  // Promise and (b) drain pendingSpawnedContexts after the property
  // read, mirroring the external_call path.
  declareExternal(session, 'obj', {
    getters: {
      foo: () => new Promise(resolve => { resolve(11); }),
    },
  });

  parseAndSetup(session, `
    let x;
    async function main() { x = await obj.foo; }
    main();
  `);
  await runToCompletion(session);
  assertEquals(session.get(0, 'x'), 11);
});

/**
 * Tests for Phase 6: JS Promise ↔ SS Promise bridging.
 * Handler async return, marshalling, and GC safety.
 */

import { assertEquals, assert } from "https://deno.land/std@0.208.0/assert/mod.ts";
import { createSession } from '../../src/fuel/session.js';
import { parseAndSetup } from './test-helpers.js';
import {
  TYPE,
  EXIT_DONE,
  EXIT_ERROR,
  EXIT_AWAIT,
  EXIT_ASYNC_COMPLETE,
  EXIT_ASYNC_REJECTED,
  PROMISE_STATUS_PENDING,
  PROMISE_STATUS_RESOLVED,
  PROMISE_STATUS_REJECTED,
  GC_HEADER_SIZE,
} from '../../src/fuel/constants.js';
import { freshSession } from '../../src/host-owned-session.js';

// Async run-to-completion helper.
// Must yield to the event loop between cycles so JS Promise .then() callbacks fire.
async function runToCompletion(session, maxIterations = 200) {
  const mem = session.memoryImage;
  const airlock = session.airlock;
  const contexts = [{ slot: 0, generation: session.memoryImage.getContextGeneration(0) }]

  for (let iter = 0; iter < maxIterations; iter++) {
    // Yield to event loop — allows JS Promise .then() callbacks to fire
    await new Promise(r => setTimeout(r, 0));

    // Drain any pending spawned contexts from async settlement. Use
    // the canonical drain primitive — the old capture-then-reassign
    // idiom assumed the airlock would let you swap in a fresh array
    // for the field, which the freeze no longer allows.
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
      contextToRun = ctx;
      break;
    }

    if (!contextToRun) {
      // Check if there are still pending linked promises that haven't settled
      // AND we haven't exhausted iterations (prevents infinite loop for deferred promises)
      if (airlock.linkedPromiseCount() > 0 && iter < maxIterations - 1) {
        continue; // Keep looping — JS Promises may settle on next event loop tick
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

function setupHandle(session, name) {
  const airlock = session.airlock;
  const id = airlock.register({});
  airlock.createRootGrant().add(id);
  airlock.declare(name, id);
  return { airlock, id };
}

// ===========================================================================
// Handler returns JS Promise
// ===========================================================================

Deno.test("Handler returns resolved Promise", async () => {
  const session = freshSession();
  const { airlock, id } = setupHandle(session, 'Api');
  airlock.setHandler(id, 'getValue', () => Promise.resolve(42));

  parseAndSetup(session, `
    let x;
    async function main() {
      x = await Api.getValue();
    }
    main();
  `);
  await runToCompletion(session);
  assertEquals(session.get(0, 'x'), 42);
});

Deno.test("Handler returns rejected Promise", async () => {
  const session = freshSession();
  const { airlock, id } = setupHandle(session, 'Api');
  airlock.setHandler(id, 'fail', () => Promise.reject(new Error("async fail")));

  parseAndSetup(session, `
    let msg;
    async function main() {
      try {
        await Api.fail();
      } catch (e) {
        msg = e.message;
      }
    }
    main();
  `);
  await runToCompletion(session);
  assertEquals(session.get(0, 'msg'), "async fail");
});

Deno.test("Handler returns async function result", async () => {
  const session = freshSession();
  const { airlock, id } = setupHandle(session, 'Api');
  airlock.setHandler(id, 'double', async ({ args }) => args[0] * 2);

  parseAndSetup(session, `
    let x;
    async function main() {
      x = await Api.double(21);
    }
    main();
  `);
  await runToCompletion(session);
  assertEquals(session.get(0, 'x'), 42);
});

Deno.test("Handler returns deferred Promise", async () => {
  const session = freshSession();
  const { airlock, id } = setupHandle(session, 'Api');

  let resolveExternal;
  airlock.setHandler(id, 'fetchData', () => {
    return new Promise(resolve => { resolveExternal = resolve; });
  });

  parseAndSetup(session, `
    let x;
    async function main() {
      x = await Api.fetchData();
    }
    main();
  `);

  // Run until the context suspends on await
  const mem = session.memoryImage;
  session.run(0, 1000);
  // Context 0 hit async_call, spawned context 1. Drain the queue
  // so the test driver (which manually picks contexts to run) isn't
  // re-running the same spawn on the next pass.
  session.airlock.drainPendingSpawnedContextIdentities();
  const result1 = session.run(1, 1000);
  // Context 1 should be awaiting the linked promise

  // Now resolve the JS Promise from outside
  resolveExternal(99);

  // Run to completion — the settlement callback fires on next event loop tick
  await runToCompletion(session);
  assertEquals(session.get(0, 'x'), 99);
});

Deno.test(".then() on external promise", async () => {
  const session = freshSession();
  const { airlock, id } = setupHandle(session, 'Api');
  airlock.setHandler(id, 'double', () => Promise.resolve(20));

  const logId = airlock.register({});
  airlock.createRootGrant().add(logId);
  let logged = null;
  airlock.setHandler(logId, 'log', ({ args }) => { logged = args[0]; });
  airlock.declare('Console', logId);

  parseAndSetup(session, `
    Api.double().then(v => { Console.log(v); });
  `);
  await runToCompletion(session);
  assertEquals(logged, 20);
});

// ===========================================================================
// Marshalling: JS Promise as nested value
// ===========================================================================

Deno.test("Handler returns object containing Promise", async () => {
  const session = freshSession();
  const { airlock, id } = setupHandle(session, 'Api');
  airlock.setHandler(id, 'getData', () => {
    return { value: Promise.resolve(42) };
  });

  parseAndSetup(session, `
    let x;
    async function main() {
      let obj = Api.getData();
      x = await obj.value;
    }
    main();
  `);
  await runToCompletion(session);
  assertEquals(session.get(0, 'x'), 42);
});

// ===========================================================================
// unwrapPromise option — drone source sees a sync return
// ===========================================================================

Deno.test("unwrapPromise: handler returning Promise marshals resolved value sync-side", async () => {
  const session = freshSession();
  const { airlock, id } = setupHandle(session, 'Api');
  airlock.setHandler(id, 'getValue', () => Promise.resolve(42), { unwrapPromise: true });

  // Note: drone source does NOT use `await` — call site is synchronous.
  parseAndSetup(session, `let x = Api.getValue();`);
  await runToCompletion(session);
  assertEquals(session.get(0, 'x'), 42);
});

Deno.test("unwrapPromise: handler rejection throws at the call site", async () => {
  const session = freshSession();
  const { airlock, id } = setupHandle(session, 'Api');
  airlock.setHandler(id, 'fail', () => Promise.reject(new Error('boom')),
    { unwrapPromise: true });

  parseAndSetup(session, `
    let caught = null;
    try { Api.fail(); } catch (e) { caught = e.message; }
  `);
  await runToCompletion(session);
  assertEquals(session.get(0, 'caught'), 'boom');
});

Deno.test("unwrapPromise: nested Promise inside resolved value still links as SS Promise", async () => {
  const session = freshSession();
  const { airlock, id } = setupHandle(session, 'Api');
  airlock.setHandler(id, 'getMixed',
    () => Promise.resolve({ data: Promise.resolve(7) }),
    { unwrapPromise: true });

  // Outer call is sync (no await). Inner .data is still an SS Promise
  // (the marshaller's universal nested-Promise behavior is untouched).
  parseAndSetup(session, `
    let outer = Api.getMixed();
    let inner;
    async function main() { inner = await outer.data; }
    main();
  `);
  await runToCompletion(session);
  assertEquals(session.get(0, 'inner'), 7);
});

Deno.test("unwrapPromise: not set — Promise still wraps as SS Promise (default unchanged)", async () => {
  const session = freshSession();
  const { airlock, id } = setupHandle(session, 'Api');
  // No unwrapPromise option — same as today's behavior.
  airlock.setHandler(id, 'getValue', () => Promise.resolve(99));

  parseAndSetup(session, `
    let x;
    async function main() { x = await Api.getValue(); }
    main();
  `);
  await runToCompletion(session);
  assertEquals(session.get(0, 'x'), 99);
});

// ===========================================================================
// GC tests
// ===========================================================================

Deno.test("GC: linked promise survives compaction", async () => {
  const session = freshSession();
  const { airlock, id } = setupHandle(session, 'Api');

  let resolveExternal;
  airlock.setHandler(id, 'fetchData', () => {
    return new Promise(resolve => { resolveExternal = resolve; });
  });

  parseAndSetup(session, `
    let x;
    async function main() {
      x = await Api.fetchData();
    }
    main();
  `);

  // Run ctx 0: spawns async context 1
  let result = session.run(0, 1000);
  // Run ctx 1: calls Api.fetchData (returns linked promise), hits await
  session.run(1, 1000);
  airlock.handleAwait(1);

  // Verify the linked promise handle exists
  assert(airlock.linkedPromiseCount() > 0);

  // Run GC — this may compact and move the promise
  session.gc();

  // Now resolve the JS Promise
  resolveExternal(42);

  // Yield to event loop for settlement callback
  await new Promise(r => setTimeout(r, 0));

  // Drain pending contexts and run to completion
  airlock.drainPendingSpawnedContextIdentities();
  // Context 1 should now be ready (await resolved)
  session.run(1, 1000);

  assertEquals(session.get(0, 'x'), 42);
});

Deno.test("GC: .then handler on linked promise survives compaction", async () => {
  const session = freshSession();
  const { airlock, id } = setupHandle(session, 'Api');

  let resolveExternal;
  airlock.setHandler(id, 'fetchData', () => {
    return new Promise(resolve => { resolveExternal = resolve; });
  });

  const logId = airlock.register({});
  airlock.createRootGrant().add(logId);
  let logged = null;
  airlock.setHandler(logId, 'log', ({ args }) => { logged = args[0]; });
  airlock.declare('Console', logId);

  parseAndSetup(session, `
    Api.fetchData().then(v => { Console.log(v); });
  `);

  // Run: calls Api.fetchData, attaches .then
  session.run(0, 1000);

  // GC
  session.gc();

  // Resolve
  resolveExternal(77);

  // Yield to event loop for settlement, then run spawned handler contexts
  await new Promise(r => setTimeout(r, 0));

  {
    const spawned = airlock.drainPendingSpawnedContextIdentities();
    for (const ctx of spawned) {
      session.run(ctx, 1000);
      // Handle async complete if the .then callback context finishes
      const mem = session.memoryImage;
      if (mem.getExitCondition(ctx.slot) === 9) { // EXIT_ASYNC_COMPLETE
        airlock.handleAsyncComplete(ctx.slot);
      }
    }
  }

  assertEquals(logged, 77);
});

Deno.test("GC: multiple linked promises survive compaction", async () => {
  const session = freshSession();
  const { airlock, id } = setupHandle(session, 'Api');

  let resolvers = [];
  airlock.setHandler(id, 'fetch', () => {
    return new Promise(resolve => { resolvers.push(resolve); });
  });

  parseAndSetup(session, `
    let a;
    let b;
    async function main() {
      let p1 = Api.fetch();
      let p2 = Api.fetch();
      a = await p1;
      b = await p2;
    }
    main();
  `);

  // Run ctx 0 (spawns main), then run main until it awaits
  session.run(0, 1000);
  // Main calls Api.fetch() twice, then hits await on p1
  session.run(1, 1000);
  airlock.handleAwait(1);

  assertEquals(resolvers.length, 2);
  assert(airlock.linkedPromiseCount() >= 2);

  // GC
  session.gc();

  // Resolve first promise
  resolvers[0](100);
  await new Promise(r => setTimeout(r, 0));

  // Drain pending and run ctx 1 (resumes from first await, hits second await)
  airlock.drainPendingSpawnedContextIdentities();
  session.run(1, 1000);
  airlock.handleAwait(1);

  // Resolve second promise
  resolvers[1](200);
  await new Promise(r => setTimeout(r, 0));

  airlock.drainPendingSpawnedContextIdentities();
  session.run(1, 1000);

  assertEquals(session.get(0, 'a'), 100);
  assertEquals(session.get(0, 'b'), 200);
});

// =============================================================================
// registerLinkedPromiseExternal — host-driven linked-promise registration
// =============================================================================

Deno.test("registerLinkedPromiseExternal registers without parking a slot", () => {
  const session = freshSession();
  const airlock = session.airlock;

  assertEquals(airlock.linkedPromiseCount(), 0,
    'fresh session has no linked promises');

  // Promise that never resolves — pending forever.
  const neverResolves = new Promise(() => {});
  const slot = airlock.registerLinkedPromiseExternal(neverResolves);

  assertEquals(typeof slot, 'number',
    'returns the SAB slot index for diagnostics');
  assertEquals(airlock.linkedPromiseCount(), 1,
    'one linked promise is now pending in the membrane');

  // No slot is parked — there's no SS interpreter caller to park.
  // The host is in a "regular" state and could now snapshot.
});

Deno.test("registerLinkedPromiseExternal entries are freed when the JS promise settles", async () => {
  const session = freshSession();
  const airlock = session.airlock;

  let resolveIt;
  const p = new Promise((r) => { resolveIt = r; });
  airlock.registerLinkedPromiseExternal(p);
  assertEquals(airlock.linkedPromiseCount(), 1);

  resolveIt('done');
  // Yield to the event loop so the .then() callback runs and the
  // settlement path frees the slot.
  await new Promise((r) => setTimeout(r, 0));

  assertEquals(airlock.linkedPromiseCount(), 0,
    'settlement frees the slot like any other linked promise');
});

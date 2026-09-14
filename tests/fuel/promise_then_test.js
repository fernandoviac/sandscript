/**
 * Tests for Promise .then()/.catch()/.finally() methods.
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
  EXIT_PROMISE_METHOD,
} from '../../src/fuel/constants.js';
import { freshSession } from '../../src/host-owned-session.js';

/**
 * Run a session to completion, handling all async statuses.
 */
function runToCompletion(session) {
  const mem = session.memoryImage;
  const airlock = session.airlock;
  const contexts = [{ slot: 0, generation: session.memoryImage.getContextGeneration(0) }]

  for (let iter = 0; iter < 1000; iter++) {
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

    if (!contextToRun) break;

    const result = session.run(contextToRun, 100);

    if (result.status === 'async_call' && result.asyncContext !== undefined) {
      contexts.push(result.asyncContext);
    }

    if (result.status === 'await') {
      const { pending } = airlock.handleAwait(contextToRun.slot);
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

function runAndGet(source, varName) {
  const session = freshSession();
  parseAndSetup(session, source);
  runToCompletion(session);
  return session.get(0, varName);
}

// ===========================================================================
// Basic .then()
// ===========================================================================

Deno.test("Promise.then: basic resolved value", () => {
  const session = freshSession();
  const airlock = session.airlock;
  let logged = null;

  const id = airlock.register({});
  airlock.createRootGrant().add(id);
  airlock.setHandler(id, 'log', ({ args }) => { logged = args[0]; });
  airlock.declare('Console', id);

  parseAndSetup(session, `
    async function getValue() { return 42; }
    getValue().then(v => { Console.log(v); });
  `);
  runToCompletion(session);

  assertEquals(logged, 42);
});

Deno.test("Promise.then: chained transformations", () => {
  const x = runAndGet(`
    async function getValue() { return 10; }
    let x = await getValue()
      .then(v => v * 2)
      .then(v => v + 1);
  `, 'x');

  assertEquals(x, 21);
});

Deno.test("Promise.then: pass-through when no onResolved", () => {
  const x = runAndGet(`
    async function getValue() { return 42; }
    let x = await getValue().then();
  `, 'x');

  assertEquals(x, 42);
});

// ===========================================================================
// .catch()
// ===========================================================================

Deno.test("Promise.catch: catches rejection", () => {
  const x = runAndGet(`
    async function fail() { throw new Error("oops"); }
    let x = await fail().catch(e => e.message);
  `, 'x');

  assertEquals(x, "oops");
});

Deno.test("Promise.catch: pass-through on success", () => {
  const x = runAndGet(`
    async function getValue() { return 42; }
    let x = await getValue()
      .catch(e => "caught")
      .then(v => v);
  `, 'x');

  assertEquals(x, 42);
});

// ===========================================================================
// .finally()
// ===========================================================================

Deno.test("Promise.finally: called on resolve, value passes through", () => {
  const session = freshSession();
  const airlock = session.airlock;
  let finallyCalled = false;

  const id = airlock.register({});
  airlock.createRootGrant().add(id);
  airlock.setHandler(id, 'markFinally', () => { finallyCalled = true; });
  airlock.declare('Helper', id);

  parseAndSetup(session, `
    async function getValue() { return 42; }
    let x = await getValue().finally(() => { Helper.markFinally(); });
  `);
  runToCompletion(session);

  assertEquals(finallyCalled, true);
  assertEquals(session.get(0, 'x'), 42);
});

Deno.test("Promise.finally: called on reject, rejection passes through", () => {
  const x = runAndGet(`
    async function fail() { throw new Error("oops"); }
    let x = await fail()
      .finally(() => {})
      .catch(e => e.message);
  `, 'x');

  assertEquals(x, "oops");
});

// ===========================================================================
// Edge cases
// ===========================================================================

Deno.test("Promise.then: multiple handlers on same promise", () => {
  const session = freshSession();
  const airlock = session.airlock;
  const logged = [];

  const id = airlock.register({});
  airlock.createRootGrant().add(id);
  airlock.setHandler(id, 'log', ({ args }) => { logged.push(args[0]); });
  airlock.declare('Console', id);

  parseAndSetup(session, `
    async function getValue() { return 42; }
    let p = getValue();
    p.then(v => { Console.log("a"); });
    p.then(v => { Console.log("b"); });
  `);
  runToCompletion(session);

  assert(logged.includes("a"), "first handler should fire");
  assert(logged.includes("b"), "second handler should fire");
});

Deno.test("Promise.then: callback throws rejects child", () => {
  const x = runAndGet(`
    async function getValue() { return 42; }
    let x = await getValue()
      .then(v => { throw new Error("boom"); })
      .catch(e => e.message);
  `, 'x');

  assertEquals(x, "boom");
});

Deno.test("Promise.then: direct call preserves the caller scope across a yield", () => {
  const result = runAndGet(`
    let answer = -1;
    let worker = async (value) => value;
    let pending = [];
    let index = 0;
    while (index < 3) {
      pending[index] = worker(index);
      index = index + 1;
    }
    let value = await pending[2].then((item) => item + 40);
    answer = value;
  `, 'answer');

  assertEquals(result, 42);
});

Deno.test("Promise.then: detached call preserves the caller scope across a yield", () => {
  const result = runAndGet(`
    let answer = -1;
    let worker = async (value) => value;
    let pending = [];
    let index = 0;
    while (index < 3) {
      pending[index] = worker(index);
      index = index + 1;
    }
    let continueWith = pending[2].then;
    let value = await continueWith((item) => item + 40);
    answer = value;
  `, 'answer');

  assertEquals(result, 42);
});

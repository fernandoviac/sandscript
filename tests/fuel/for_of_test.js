/**
 * Slice 2 — for-of and for-await-of statements.
 *
 * Covers:
 *   - Sync for-of over hand-written iterables (no built-ins are iterable
 *     yet; slice 3 wires arrays / strings / typed arrays).
 *   - break, continue, exception in body, exception in next(),
 *     non-iterable receiver, non-object next() result (strict per spec).
 *   - Async for-await-of over hand-written async iterables (next()
 *     returning a Promise or a plain object).
 *   - Parser rejects for-await outside async contexts.
 */

import { assertEquals, assertThrows } from "https://deno.land/std@0.208.0/assert/mod.ts";
import { parseAndSetup } from './test-helpers.js';
import { freshSession } from '../../src/host-owned-session.js';
import {
  EXIT_DONE, EXIT_ERROR, EXIT_AWAIT,
  EXIT_ASYNC_COMPLETE, EXIT_ASYNC_REJECTED,
  EXIT_EXTERNAL_CALL, EXIT_EXTERNAL_PROPERTY,
} from '../../src/fuel/constants.js';

function run(source) {
  const session = freshSession();
  parseAndSetup(session, source);
  const result = session.run(0, 10_000_000);
  if (result.status === 'error') {
    throw new Error(`Error: ${result.error.message}`);
  }
  return session;
}

/**
 * Drive an async program (e.g. one using for-await-of) to quiescence by
 * scheduling spawned contexts, handling promise settles, and yielding to
 * the JS event loop between iterations so linked Promises can settle.
 * Lifted from the existing async test helpers in this directory.
 */
async function runAsync(source, maxIterations = 200) {
  const session = freshSession();
  const mem = session.airlock.memoryImage;
  const airlock = session.airlock;
  parseAndSetup(session, source);

  const contexts = [{ slot: 0, generation: session.memoryImage.getContextGeneration(0) }]
  for (let iter = 0; iter < maxIterations; iter++) {
    await new Promise(r => setTimeout(r, 0));
    const spawned = airlock.drainPendingSpawnedContextIdentities();
    for (const ctx of spawned) {
      if (!contexts.find(c => c.slot === ctx.slot && c.generation === ctx.generation)) contexts.push(ctx);
    }

    let contextToRun = null;
    for (const ctx of contexts) {
      const ec = mem.getExitCondition(ctx.slot);
      if (ec === EXIT_DONE || ec === EXIT_ERROR || ec === EXIT_ASYNC_COMPLETE || ec === EXIT_ASYNC_REJECTED) continue;
      if (ec === EXIT_AWAIT) continue;
      if ((ec === EXIT_EXTERNAL_CALL || ec === EXIT_EXTERNAL_PROPERTY) &&
          airlock.pendingContexts && airlock.pendingContexts.has(ctx.slot)) continue;
      contextToRun = ctx;
      break;
    }
    if (!contextToRun) {
      const hasLinked = airlock.linkedPromiseCount && airlock.linkedPromiseCount() > 0;
      const hasPending = airlock.pendingContexts && airlock.pendingContexts.size > 0;
      if ((hasLinked || hasPending) && iter < maxIterations - 1) continue;
      break;
    }

    const result = session.run(contextToRun, 1000);
    if (result.status === 'async_call' && result.asyncContext !== undefined) {
      contexts.push(result.asyncContext);
    }
    if (result.status === 'await') airlock.handleAwait(contextToRun.slot);
    if (result.status === 'async_complete') {
      const { waiters } = airlock.handleAsyncComplete(contextToRun.slot);
      for (const w of waiters) if (!contexts.find(c => c.slot === w.slot && c.generation === w.generation)) contexts.push(w);
    }
    if (result.status === 'async_rejected') {
      const { waiters } = airlock.handleAsyncRejected(contextToRun.slot);
      for (const w of waiters) if (!contexts.find(c => c.slot === w.slot && c.generation === w.generation)) contexts.push(w);
    }
    if (result.status === 'promise_method' && result.contexts) {
      for (const ctx of result.contexts) if (!contexts.find(c => c.slot === ctx.slot && c.generation === ctx.generation)) contexts.push(ctx);
    }
  }

  return session;
}

// =============================================================================
// Sync for-of
// =============================================================================

const COUNTER_ITER = `
  let iter = {};
  iter[Symbol.iterator] = function() {
    let i = 0;
    return {
      next: function() {
        if (i < 3) {
          let v = i;
          i = i + 1;
          return { value: v, done: false };
        }
        return { value: undefined, done: true };
      }
    };
  };
`;

Deno.test("for-of: collects values from a hand-written iterable", () => {
  const session = run(`
    ${COUNTER_ITER}
    let collected = [];
    for (let x of iter) { collected[collected.length] = x; }
    let total = collected[0] + collected[1] * 10 + collected[2] * 100;
  `);
  assertEquals(session.get(0, 'total'), 210);  // 0 + 1*10 + 2*100
});

Deno.test("for-of: empty iterable runs zero iterations", () => {
  const session = run(`
    let iter = {};
    iter[Symbol.iterator] = function() {
      return { next: function() { return { value: undefined, done: true }; } };
    };
    let entered = false;
    for (let x of iter) { entered = true; }
  `);
  assertEquals(session.get(0, 'entered'), false);
});

Deno.test("for-of: break exits the loop early", () => {
  const session = run(`
    ${COUNTER_ITER}
    let total = 0;
    for (let x of iter) {
      if (x === 2) break;
      total = total + x;
    }
  `);
  assertEquals(session.get(0, 'total'), 1);  // 0 + 1
});

Deno.test("for-of: continue skips current iteration", () => {
  const session = run(`
    ${COUNTER_ITER}
    let total = 0;
    for (let x of iter) {
      if (x === 1) continue;
      total = total + x;
    }
  `);
  assertEquals(session.get(0, 'total'), 2);  // 0 + 2 (skipped 1)
});

Deno.test("for-of: const loop variable works", () => {
  const session = run(`
    ${COUNTER_ITER}
    let total = 0;
    for (const x of iter) { total = total + x; }
  `);
  assertEquals(session.get(0, 'total'), 3);  // 0 + 1 + 2
});

Deno.test("for-of: var loop variable works", () => {
  const session = run(`
    ${COUNTER_ITER}
    let total = 0;
    for (var x of iter) { total = total + x; }
  `);
  assertEquals(session.get(0, 'total'), 3);
});

Deno.test("for-of: iterator method is invoked with this = iterable", () => {
  // The iterator factory reads `this.start` to compute the starting value;
  // verifies that expr[Symbol.iterator]() binds `this` to expr.
  const session = run(`
    let iter = { start: 100 };
    iter[Symbol.iterator] = function() {
      let i = this.start;
      let limit = i + 3;
      return {
        next: function() {
          if (i < limit) {
            let v = i;
            i = i + 1;
            return { value: v, done: false };
          }
          return { value: undefined, done: true };
        }
      };
    };
    let collected = [];
    for (let x of iter) { collected[collected.length] = x; }
    let first = collected[0];
    let last = collected[2];
  `);
  assertEquals(session.get(0, 'first'), 100);
  assertEquals(session.get(0, 'last'), 102);
});

Deno.test("for-of: next() is invoked with this = iterator", () => {
  // The iterator carries its own state on the iterator object (via this);
  // verifies CALL_METHOD on iter.next() preserves the receiver.
  const session = run(`
    let iter = {};
    iter[Symbol.iterator] = function() {
      return {
        i: 0,
        next: function() {
          if (this.i < 3) {
            let v = this.i;
            this.i = this.i + 1;
            return { value: v * 10, done: false };
          }
          return { value: undefined, done: true };
        }
      };
    };
    let total = 0;
    for (let x of iter) { total = total + x; }
  `);
  assertEquals(session.get(0, 'total'), 30);  // 0 + 10 + 20
});

Deno.test("for-of: throw in body propagates and stops iteration", () => {
  const session = run(`
    ${COUNTER_ITER}
    let total = 0;
    let caught = null;
    try {
      for (let x of iter) {
        if (x === 1) throw 'stop';
        total = total + 100;
      }
    } catch (e) { caught = e; }
  `);
  assertEquals(session.get(0, 'total'), 100);  // only x=0 contributed
  assertEquals(session.get(0, 'caught'), 'stop');
});

Deno.test("for-of: throw in next() propagates", () => {
  const session = run(`
    let iter = {};
    iter[Symbol.iterator] = function() {
      let i = 0;
      return {
        next: function() {
          if (i === 2) throw 'boom';
          let v = i;
          i = i + 1;
          return { value: v, done: false };
        }
      };
    };
    let total = 0;
    let caught = null;
    try {
      for (let x of iter) { total = total + x; }
    } catch (e) { caught = e; }
  `);
  assertEquals(session.get(0, 'total'), 1);  // 0 + 1 before next() threw
  assertEquals(session.get(0, 'caught'), 'boom');
});

Deno.test("for-of: non-object next() result throws TypeError", () => {
  const session = run(`
    let iter = {};
    iter[Symbol.iterator] = function() {
      return { next: function() { return 42; } };
    };
    let caught = null;
    try {
      for (let x of iter) { }
    } catch (e) { caught = e.message; }
  `);
  assertEquals(session.get(0, 'caught'), 'Not an object');
});

Deno.test("for-of: nested for-of works", () => {
  const session = run(`
    function makeIter(limit) {
      let it = {};
      it[Symbol.iterator] = function() {
        let i = 0;
        return {
          next: function() {
            if (i < limit) { let v = i; i = i + 1; return { value: v, done: false }; }
            return { value: undefined, done: true };
          }
        };
      };
      return it;
    }
    let total = 0;
    for (let a of makeIter(3)) {
      for (let b of makeIter(2)) {
        total = total + a * 10 + b;
      }
    }
    // a=0: b=0,1 → 0+0 + 0+1 = 1
    // a=1: b=0,1 → 10+0 + 10+1 = 21
    // a=2: b=0,1 → 20+0 + 20+1 = 41
    // total = 1 + 21 + 41 = 63
  `);
  assertEquals(session.get(0, 'total'), 63);
});

Deno.test("for-of: break in outer leaves outer scope clean for subsequent code", () => {
  const session = run(`
    ${COUNTER_ITER}
    for (let x of iter) { break; }
    let after = 'fine';
  `);
  assertEquals(session.get(0, 'after'), 'fine');
});

// =============================================================================
// for-await-of
// =============================================================================

const ASYNC_COUNTER_ITER = `
  let iter = {};
  iter[Symbol.asyncIterator] = function() {
    let i = 0;
    return {
      next: function() {
        if (i < 3) {
          let v = i;
          i = i + 1;
          return Promise.resolve({ value: v * 100, done: false });
        }
        return Promise.resolve({ value: undefined, done: true });
      }
    };
  };
`;

Deno.test("for-await-of: collects values from a promise-returning iterable", async () => {
  const session = await runAsync(`
    ${ASYNC_COUNTER_ITER}
    let total = 0;
    for await (let x of iter) { total = total + x; }
  `);
  assertEquals(session.get(0, 'total'), 300);  // 0 + 100 + 200
});

Deno.test("for-await-of: works with synchronous (non-promise) next() results", async () => {
  const session = await runAsync(`
    let iter = {};
    iter[Symbol.asyncIterator] = function() {
      let i = 0;
      return {
        next: function() {
          if (i < 3) { let v = i; i = i + 1; return { value: v, done: false }; }
          return { value: undefined, done: true };
        }
      };
    };
    let total = 0;
    for await (let x of iter) { total = total + x; }
  `);
  assertEquals(session.get(0, 'total'), 3);
});

Deno.test("for-await-of: inside an async function, result resolves through the returned promise", async () => {
  const session = await runAsync(`
    ${ASYNC_COUNTER_ITER}
    async function sum() {
      let total = 0;
      for await (let x of iter) { total = total + x; }
      return total;
    }
    let p = sum();
    let result = 'pending';
    p.then(function(v) { result = v; });
  `);
  assertEquals(session.get(0, 'result'), 300);
});

Deno.test("for-await-of: break exits early", async () => {
  const session = await runAsync(`
    ${ASYNC_COUNTER_ITER}
    let total = 0;
    for await (let x of iter) {
      if (x === 200) break;
      total = total + x;
    }
  `);
  assertEquals(session.get(0, 'total'), 100);  // 0 + 100
});

// =============================================================================
// for-await-of: sync→async fallback (C3)
// =============================================================================
// A source without Symbol.asyncIterator falls back to Symbol.iterator;
// each step VALUE is lifted through await (the spec's
// AsyncFromSyncIterator), so promise elements settle before binding.

Deno.test("for-await-of: falls back to a plain array's sync iterator", async () => {
  const session = await runAsync(`
    let result = "";
    async function main() {
      let total = 0;
      for await (const x of [1, 2, 3]) { total = total + x; }
      return total;
    }
    main().then(function (r) { result = "sum:" + r; });
  `);
  assertEquals(session.get(0, 'result'), 'sum:6');
});

Deno.test("for-await-of: sync fallback awaits promise-valued elements", async () => {
  const session = await runAsync(`
    let result = "";
    let src = {
      [Symbol.iterator]() {
        let i = 0;
        return { next() { i = i + 1; return { value: Promise.resolve(i * 10), done: i > 3 }; } };
      },
    };
    async function main() {
      let total = 0;
      for await (const x of src) { total = total + x; }
      return total;
    }
    main().then(function (r) { result = "sum:" + r; });
  `);
  assertEquals(session.get(0, 'result'), 'sum:60');
});

Deno.test("for-await-of: sync fallback over a Set", async () => {
  const session = await runAsync(`
    let result = "";
    async function main() {
      let total = 0;
      for await (const x of new Set([7, 8])) { total = total + x; }
      return total;
    }
    main().then(function (r) { result = "sum:" + r; });
  `);
  assertEquals(session.get(0, 'result'), 'sum:15');
});

Deno.test("for-await-of: sync fallback over a string iterates code points", async () => {
  const session = await runAsync(`
    let result = "";
    async function main() {
      let out = "";
      for await (const ch of "ab") { out = out + ch + "."; }
      return out;
    }
    main().then(function (r) { result = r; });
  `);
  assertEquals(session.get(0, 'result'), 'a.b.');
});

Deno.test("for-await-of: Symbol.asyncIterator still wins over Symbol.iterator", async () => {
  const session = await runAsync(`
    let result = "";
    let src = {
      [Symbol.iterator]() {
        return { next() { return { value: "sync", done: false }; } };
      },
      [Symbol.asyncIterator]() {
        let i = 0;
        return {
          next() {
            i = i + 1;
            return Promise.resolve({ value: "async" + i, done: i > 2 });
          },
        };
      },
    };
    async function main() {
      let out = "";
      for await (const x of src) { out = out + x; }
      return out;
    }
    main().then(function (r) { result = r; });
  `);
  assertEquals(session.get(0, 'result'), 'async1async2');
});

Deno.test("for-await-of: sync fallback with break closes the iterator", async () => {
  const session = await runAsync(`
    let result = "";
    let closed = 0;
    let src = {
      [Symbol.iterator]() {
        let i = 0;
        return {
          next() { i = i + 1; return { value: i, done: false }; },
          return() { closed = closed + 1; return { done: true }; },
        };
      },
    };
    async function main() {
      for await (const x of src) { if (x === 2) break; }
      return "closed:" + closed;
    }
    main().then(function (r) { result = r; });
  `);
  assertEquals(session.get(0, 'result'), 'closed:1');
});

Deno.test("for-await-of: non-iterable source still throws Not iterable", async () => {
  const session = await runAsync(`
    let result = "";
    async function main() {
      try {
        for await (const x of 42) { }
      } catch (e) { return "caught:" + e.message; }
      return "no-throw";
    }
    main().then(function (r) { result = r; });
  `);
  assertEquals(session.get(0, 'result'), 'caught:Not iterable');
});

Deno.test("for-await-of: parser rejects outside async context (in a non-async function)", () => {
  // for-await is parse-time invalid inside a non-async function.
  // parse() throws ParseError on failure (673de61); assert on the
  // thrown message.
  const session = freshSession();
  let thrown = null;
  try {
    session.parse(`
      function notAsync() {
        let iter = {};
        for await (let x of iter) { }
      }
    `);
  } catch (e) { thrown = e; }
  if (!thrown) throw new Error("Expected parse error, got success");
  if (!String(thrown.message || thrown).includes("'for await' is only valid in async functions or at top level")) {
    throw new Error(`Unexpected error: ${thrown.message || thrown}`);
  }
});

// =============================================================================
// Non-iterable sources — "Not iterable" diagnostics (ASSERT_ITERABLE)
// =============================================================================

Deno.test("for-of: non-iterable number throws catchable Not iterable", () => {
  const s = run(`
    let caught = null;
    try { for (let x of 42) {} } catch (e) { caught = e.message; }
  `);
  assertEquals(s.get(0, 'caught'), 'Not iterable');
});

Deno.test("for-of: null source throws Not iterable, not a property-read error", () => {
  const s = run(`
    let caught = null;
    try { for (let x of null) {} } catch (e) { caught = e.message; }
  `);
  assertEquals(s.get(0, 'caught'), 'Not iterable');
});

Deno.test("for-of: plain object without Symbol.iterator throws Not iterable", () => {
  const s = run(`
    let caught = null;
    try { for (let x of { a: 1 }) {} } catch (e) { caught = e.message; }
  `);
  assertEquals(s.get(0, 'caught'), 'Not iterable');
});

Deno.test("for-of: uncaught non-iterable reports the received type", () => {
  const session = freshSession();
  parseAndSetup(session, `for (let x of null) {}`);
  let message = null;
  try {
    session.run(0, 10_000_000);
  } catch (e) {
    message = e.message;
  }
  assertEquals(message.includes('Not iterable (received null)'), true);
});

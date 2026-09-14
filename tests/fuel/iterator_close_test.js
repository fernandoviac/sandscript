/**
 * Iterator close on early exit (C2 — IteratorClose).
 *
 * Every for-of / for-await-of iteration arms a per-iteration close
 * frame: a finally-armed try entry whose handler is the close block the
 * parser emits after the loop body. Abrupt exits — break (via
 * UNWIND_JUMP), early return (via the return walk), throw (via the
 * throw walk) — divert through it and invoke the iterator's return()
 * method; normal iteration end diverts with a NORMAL completion and
 * skips the close. Spec error routing: on the throw path the original
 * exception wins (close errors are swallowed); on the break/return
 * paths close errors propagate.
 */

import { assertEquals } from "https://deno.land/std@0.208.0/assert/mod.ts";
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
  const result = session.run(0, 50_000_000);
  if (result.status === 'error') {
    throw new Error(result.error.message);
  }
  return session;
}

/** Drive an async program to quiescence (same shape as for_of_test.js). */
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

const MAKE_ITERABLE = `
  let closed = 0;
  let seen = [];
  function makeIterable(limit) {
    return {
      [Symbol.iterator]() {
        let i = 0;
        return {
          next() { i = i + 1; return { value: i, done: i > limit }; },
          return() { closed = closed + 1; return { done: true }; },
        };
      },
    };
  }
`;

Deno.test("close: break invokes return() once", () => {
  const s = run(MAKE_ITERABLE + `
    for (const x of makeIterable(5)) { seen.push(x); if (x === 2) break; }
    let r = closed;
    let order = "" + seen;
  `);
  assertEquals(s.get(0, 'r'), 1);
  assertEquals(s.get(0, 'order'), '1,2');
});

Deno.test("close: normal completion does NOT invoke return()", () => {
  const s = run(MAKE_ITERABLE + `
    for (const x of makeIterable(3)) { seen.push(x); }
    let r = closed;
  `);
  assertEquals(s.get(0, 'r'), 0);
});

Deno.test("close: continue does NOT invoke return()", () => {
  const s = run(MAKE_ITERABLE + `
    for (const x of makeIterable(3)) { if (x === 2) continue; seen.push(x); }
    let r = closed;
    let order = "" + seen;
  `);
  assertEquals(s.get(0, 'r'), 0);
  assertEquals(s.get(0, 'order'), '1,3');
});

Deno.test("close: early return invokes return()", () => {
  const s = run(MAKE_ITERABLE + `
    function f() {
      for (const x of makeIterable(5)) { if (x === 2) return "ret:" + x; }
      return "no";
    }
    let rv = f();
    let r = closed;
  `);
  assertEquals(s.get(0, 'rv'), 'ret:2');
  assertEquals(s.get(0, 'r'), 1);
});

Deno.test("close: throw from the body invokes return(); original error wins", () => {
  const s = run(MAKE_ITERABLE + `
    let caught = "";
    try {
      for (const x of makeIterable(5)) { if (x === 2) throw "body-boom"; }
    } catch (e) { caught = e; }
    let r = closed;
  `);
  assertEquals(s.get(0, 'r'), 1);
  assertEquals(s.get(0, 'caught'), 'body-boom');
});

Deno.test("close: throwing return() on the throw path is swallowed (original error wins)", () => {
  const s = run(`
    let caught = "";
    let src = {
      [Symbol.iterator]() {
        let i = 0;
        return {
          next() { i = i + 1; return { value: i, done: false }; },
          return() { throw "close-boom"; },
        };
      },
    };
    try {
      for (const x of src) { if (x === 2) throw "body-boom"; }
    } catch (e) { caught = e; }
  `);
  assertEquals(s.get(0, 'caught'), 'body-boom');
});

Deno.test("close: throwing return() on the break path propagates", () => {
  const s = run(`
    let caught = "";
    let src = {
      [Symbol.iterator]() {
        let i = 0;
        return {
          next() { i = i + 1; return { value: i, done: false }; },
          return() { throw "close-boom"; },
        };
      },
    };
    try {
      for (const x of src) { if (x === 2) break; }
    } catch (e) { caught = e; }
  `);
  assertEquals(s.get(0, 'caught'), 'close-boom');
});

Deno.test("close: iterators without a return method are fine", () => {
  const s = run(`
    let src = {
      [Symbol.iterator]() {
        let i = 0;
        return { next() { i = i + 1; return { value: i, done: i > 5 }; } };
      },
    };
    let sum = 0;
    for (const x of src) { sum = sum + x; if (x === 3) break; }
  `);
  assertEquals(s.get(0, 'sum'), 6);
});

Deno.test("close: native iterators (arrays) on break are fine", () => {
  const s = run(`
    let sum = 0;
    for (const x of [1, 2, 3, 4]) { sum = sum + x; if (x === 2) break; }
  `);
  assertEquals(s.get(0, 'sum'), 3);
});

Deno.test("close: nested loops on return close both, inner first", () => {
  const s = run(`
    let order = [];
    function makeIterable(name) {
      return {
        [Symbol.iterator]() {
          let i = 0;
          return {
            next() { i = i + 1; return { value: i, done: i > 4 }; },
            return() { order.push(name); return { done: true }; },
          };
        },
      };
    }
    function f() {
      for (const a of makeIterable("outer")) {
        for (const b of makeIterable("inner")) {
          if (b === 2) return "done";
        }
      }
    }
    let rv = f();
    let r = "" + order;
  `);
  assertEquals(s.get(0, 'rv'), 'done');
  assertEquals(s.get(0, 'r'), 'inner,outer');
});

Deno.test("close: break crossing a user try runs its finally BEFORE the close", () => {
  const s = run(`
    let order = [];
    let src = {
      [Symbol.iterator]() {
        let i = 0;
        return {
          next() { i = i + 1; return { value: i, done: false }; },
          return() { order.push("close"); return { done: true }; },
        };
      },
    };
    for (const x of src) {
      try { if (x === 2) break; } finally { order.push("finally" + x); }
    }
    let r = "" + order;
  `);
  assertEquals(s.get(0, 'r'), 'finally1,finally2,close');
});

Deno.test("close: destructuring for-of closes on break", () => {
  const s = run(`
    let closed = 0;
    let src = {
      [Symbol.iterator]() {
        let i = 0;
        return {
          next() { i = i + 1; return { value: [i, i * 10], done: i > 5 }; },
          return() { closed = closed + 1; return { done: true }; },
        };
      },
    };
    let last = 0;
    for (const [a, b] of src) { last = b; if (a === 2) break; }
    let r = closed;
  `);
  assertEquals(s.get(0, 'r'), 1);
  assertEquals(s.get(0, 'last'), 20);
});

Deno.test("close: for-await-of break awaits and invokes return()", async () => {
  const s = await runAsync(`
    let closed = 0;
    let seen = [];
    let src = {
      [Symbol.asyncIterator]() {
        let i = 0;
        return {
          next() {
            i = i + 1;
            return Promise.resolve({ value: i, done: i > 5 });
          },
          return() { closed = closed + 1; return Promise.resolve({ done: true }); },
        };
      },
    };
    let result = "";
    async function main() {
      for await (const x of src) { seen.push(x); if (x === 2) break; }
      return "" + seen + "|closed:" + closed;
    }
    main().then((r) => { result = r; });
  `);
  assertEquals(s.get(0, 'result'), '1,2|closed:1');
});

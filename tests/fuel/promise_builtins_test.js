/**
 * Tests for Promise built-ins: Promise.resolve, Promise.reject,
 * new Promise(executor), Promise.all, Promise.race.
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
  PROMISE,
  GC_HEADER_SIZE,
} from '../../src/fuel/constants.js';
import { freshSession } from '../../src/host-owned-session.js';

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

function setupConsole(session) {
  const airlock = session.airlock;
  const logged = [];
  const id = airlock.register({});
  airlock.createRootGrant().add(id);
  airlock.setHandler(id, 'log', ({ args }) => { logged.push(args[0]); });
  airlock.declare('Console', id);
  return logged;
}

function runAndGet(source, varName) {
  const session = freshSession();
  parseAndSetup(session, source);
  runToCompletion(session);
  return session.get(0, varName);
}

// ===========================================================================
// Promise.resolve
// ===========================================================================

Deno.test("Promise.resolve: resolves with value", () => {
  const result = runAndGet(`
    let x;
    async function main() {
      x = await Promise.resolve(42);
    }
    main();
  `, 'x');
  assertEquals(result, 42);
});

Deno.test("Promise.resolve: resolves with undefined when no arg", () => {
  const result = runAndGet(`
    let x = "sentinel";
    async function main() {
      x = await Promise.resolve();
    }
    main();
  `, 'x');
  assertEquals(result, undefined);
});

Deno.test("Promise.resolve: identity for promise arg", () => {
  const session = freshSession();
  parseAndSetup(session, `
    async function getValue() { return 42; }
    let p = getValue();
    let p2 = Promise.resolve(p);
  `);
  runToCompletion(session);

  const mem = session.memoryImage;
  const p = session.get(0, 'p');
  const p2 = session.get(0, 'p2');

  // Both should be the same promise object (identity)
  // They're both "[object Promise]" strings from readValueAt but
  // let's check the raw pointers
  const globalScope = mem.getRootScope();
  const pOffset = mem.internString('p');
  const p2Offset = mem.internString('p2');
  const pPtr = mem.scopeLookup(globalScope, pOffset);
  const p2Ptr = mem.scopeLookup(globalScope, p2Offset);
  const pHeaderLo = mem.view.getUint32(mem.abs(pPtr + 8), true);
  const p2HeaderLo = mem.view.getUint32(mem.abs(p2Ptr + 8), true);
  assertEquals(pHeaderLo, p2HeaderLo);
});

// ===========================================================================
// Promise.reject
// ===========================================================================

Deno.test("Promise.reject: rejects with reason", () => {
  const result = runAndGet(`
    let msg;
    async function main() {
      try {
        await Promise.reject(new Error("oops"));
      } catch (e) {
        msg = e.message;
      }
    }
    main();
  `, 'msg');
  assertEquals(result, "oops");
});

Deno.test("Promise.reject: rejects with undefined when no arg", () => {
  const result = runAndGet(`
    let caught = "not_caught";
    async function main() {
      try {
        await Promise.reject();
      } catch (e) {
        caught = e;
      }
    }
    main();
  `, 'caught');
  assertEquals(result, undefined);
});

// ===========================================================================
// new Promise(executor)
// ===========================================================================

Deno.test("new Promise: resolve", () => {
  const result = runAndGet(`
    let x;
    async function main() {
      let p = new Promise((resolve, reject) => {
        resolve(42);
      });
      x = await p;
    }
    main();
  `, 'x');
  assertEquals(result, 42);
});

Deno.test("new Promise: reject", () => {
  const result = runAndGet(`
    let msg;
    async function main() {
      let p = new Promise((resolve, reject) => {
        reject(new Error("oops"));
      });
      try {
        await p;
      } catch (e) {
        msg = e.message;
      }
    }
    main();
  `, 'msg');
  assertEquals(result, "oops");
});

Deno.test("new Promise: executor throws rejects promise", () => {
  const result = runAndGet(`
    let msg;
    async function main() {
      let p = new Promise((resolve, reject) => {
        throw new Error("executor failed");
      });
      try {
        await p;
      } catch (e) {
        msg = e.message;
      }
    }
    main();
  `, 'msg');
  assertEquals(result, "executor failed");
});

Deno.test("new Promise: resolve called twice ignores second", () => {
  const result = runAndGet(`
    let x;
    async function main() {
      let p = new Promise((resolve, reject) => {
        resolve(42);
        resolve(99);
      });
      x = await p;
    }
    main();
  `, 'x');
  assertEquals(result, 42);
});

Deno.test("new Promise: no executor arg throws TypeError", () => {
  const session = freshSession();
  const logged = setupConsole(session);
  parseAndSetup(session, `
    let caught;
    try {
      new Promise();
    } catch (e) {
      caught = e.message;
    }
  `);
  runToCompletion(session);
  const result = session.get(0, 'caught');
  assert(result !== undefined);
  assert(typeof result === 'string');
});

// ===========================================================================
// Promise.all
// ===========================================================================

Deno.test("Promise.all: basic resolved", () => {
  const result = runAndGet(`
    let a, b, c;
    async function main() {
      let arr = await Promise.all([
        Promise.resolve(1),
        Promise.resolve(2),
        Promise.resolve(3)
      ]);
      a = arr[0]; b = arr[1]; c = arr[2];
    }
    main();
  `, 'a');
  assertEquals(result, 1);
});

Deno.test("Promise.all: mixed promises and values", () => {
  const session = freshSession();
  parseAndSetup(session, `
    let a, b, c;
    async function main() {
      let arr = await Promise.all([
        Promise.resolve(1),
        42,
        Promise.resolve(3)
      ]);
      a = arr[0]; b = arr[1]; c = arr[2];
    }
    main();
  `);
  runToCompletion(session);
  assertEquals(session.get(0, 'a'), 1);
  assertEquals(session.get(0, 'b'), 42);
  assertEquals(session.get(0, 'c'), 3);
});

Deno.test("Promise.all: one rejects", () => {
  const result = runAndGet(`
    let msg;
    async function main() {
      try {
        await Promise.all([
          Promise.resolve(1),
          Promise.reject(new Error("fail")),
          Promise.resolve(3)
        ]);
      } catch (e) {
        msg = e.message;
      }
    }
    main();
  `, 'msg');
  assertEquals(result, "fail");
});

Deno.test("Promise.all: empty array resolves immediately", () => {
  const session = freshSession();
  parseAndSetup(session, `
    let result;
    async function main() {
      result = await Promise.all([]);
    }
    main();
  `);
  runToCompletion(session);
  const result = session.get(0, 'result');
  assert(Array.isArray(result));
  assertEquals(result.length, 0);
});

Deno.test("Promise.all: with async functions", () => {
  const session = freshSession();
  parseAndSetup(session, `
    async function double(x) { return x * 2; }
    let a, b, c;
    async function main() {
      let arr = await Promise.all([double(1), double(2), double(3)]);
      a = arr[0]; b = arr[1]; c = arr[2];
    }
    main();
  `);
  runToCompletion(session);
  assertEquals(session.get(0, 'a'), 2);
  assertEquals(session.get(0, 'b'), 4);
  assertEquals(session.get(0, 'c'), 6);
});

Deno.test("Promise.all: direct call preserves the caller scope across a yield", () => {
  const result = runAndGet(`
    let finishedCount = -1;
    let worker = async (value) => value;
    let pending = [];
    let index = 0;
    while (index < 3) {
      pending[index] = worker(index);
      index = index + 1;
    }
    let values = await Promise.all(pending);
    finishedCount = values.length;
  `, 'finishedCount');

  assertEquals(result, 3);
});

Deno.test("Promise.all: detached call preserves the caller scope across a yield", () => {
  const result = runAndGet(`
    let finishedCount = -1;
    let worker = async (value) => value;
    let pending = [];
    let index = 0;
    while (index < 3) {
      pending[index] = worker(index);
      index = index + 1;
    }
    let combine = Promise.all;
    let values = await combine(pending);
    finishedCount = values.length;
  `, 'finishedCount');

  assertEquals(result, 3);
});

// ===========================================================================
// Promise.race
// ===========================================================================

Deno.test("Promise.race: first resolves", () => {
  const result = runAndGet(`
    let x;
    async function main() {
      x = await Promise.race([
        Promise.resolve("first"),
        Promise.resolve("second")
      ]);
    }
    main();
  `, 'x');
  assertEquals(result, "first");
});

Deno.test("Promise.race: first rejects", () => {
  const result = runAndGet(`
    let msg;
    async function main() {
      try {
        await Promise.race([
          Promise.reject(new Error("fail")),
          Promise.resolve("second")
        ]);
      } catch (e) {
        msg = e.message;
      }
    }
    main();
  `, 'msg');
  assertEquals(result, "fail");
});

Deno.test("Promise.race: empty array stays pending", () => {
  const session = freshSession();
  parseAndSetup(session, `
    let p = Promise.race([]);
  `);
  runToCompletion(session);

  const mem = session.memoryImage;
  const globalScope = mem.getRootScope();
  const pOffset = mem.internString('p');
  const pPtr = mem.scopeLookup(globalScope, pOffset);
  const pType = mem.view.getUint32(mem.abs(pPtr), true);
  assertEquals(pType, TYPE.PROMISE);
  const promiseHeader = mem.view.getUint32(mem.abs(pPtr + 8), true);
  const promiseData = promiseHeader + GC_HEADER_SIZE;
  assertEquals(mem.getPromiseStatus(promiseData), PROMISE_STATUS_PENDING);
});

// ===========================================================================
// Chaining
// ===========================================================================

Deno.test("Promise.all chained with .then", () => {
  const result = runAndGet(`
    let sum;
    async function main() {
      sum = await Promise.all([
        Promise.resolve(1),
        Promise.resolve(2),
        Promise.resolve(3)
      ]).then(arr => arr[0] + arr[1] + arr[2]);
    }
    main();
  `, 'sum');
  assertEquals(result, 6);
});

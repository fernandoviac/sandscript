/**
 * Tests for async function mechanics (Phase 2 of async/await).
 *
 * Host-owned execution model: the caller must handle async context switching.
 */

import { assertEquals, assertNotEquals } from 'https://deno.land/std@0.208.0/assert/mod.ts';
import { createSession } from '../../src/fuel/session.js';
import { parseAndSetup } from './test-helpers.js';
import {
  TYPE,
  PROMISE_STATUS_PENDING,
  PROMISE_STATUS_RESOLVED,
  PROMISE_STATUS_REJECTED,
  EXIT_DONE,
  EXIT_ERROR,
  EXIT_AWAIT,
  EXIT_ASYNC_COMPLETE,
  EXIT_ASYNC_REJECTED,
} from '../../src/fuel/constants.js';
import { freshSession } from '../../src/host-owned-session.js';

// Helper to convert lo/hi to f64
function f64FromParts(lo, hi) {
  const buffer = new ArrayBuffer(8);
  const view = new DataView(buffer);
  view.setUint32(0, lo, true);
  view.setUint32(4, hi, true);
  return view.getFloat64(0, true);
}

/**
 * Run a session to completion, handling async context switching inline.
 * Continues until ALL contexts are terminal (not just the main context).
 */
function runToCompletion(session) {
  const mem = session.memoryImage;
  const airlock = session.airlock;
  const contexts = [{ slot: 0, generation: session.memoryImage.getContextGeneration(0) }]

  for (let iter = 0; iter < 200; iter++) {
    let contextToRun = null;

    for (const ctx of contexts) {
      const exitCondition = mem.getExitCondition(ctx.slot);

      // Skip terminal states
      if (exitCondition === EXIT_DONE || exitCondition === EXIT_ERROR ||
          exitCondition === EXIT_ASYNC_COMPLETE || exitCondition === EXIT_ASYNC_REJECTED) {
        continue;
      }

      // Waiting for handleAsyncComplete/handleAsyncRejected to prepare it
      if (exitCondition === EXIT_AWAIT) {
        continue;
      }

      contextToRun = ctx;
      break;
    }

    // Exit when no runnable context (all terminal or blocked)
    if (!contextToRun) break;

    const result = session.run(contextToRun, 100);

    if (result.status === 'async_call' && result.asyncContext !== undefined) {
      contexts.push(result.asyncContext);
    }

    if (result.status === 'await') {
      airlock.handleAwait(contextToRun.slot);
    }

    if (result.status === 'async_complete') {
      airlock.handleAsyncComplete(contextToRun.slot);
    }

    if (result.status === 'async_rejected') {
      airlock.handleAsyncRejected(contextToRun.slot);
    }
  }

  return { status: 'done' };
}

// =============================================================================
// Parser: async function declaration
// =============================================================================

Deno.test('Parser: async function declaration creates async closure', () => {
  const session = freshSession();
  parseAndSetup(session, 'async function foo() { return 42; }');
  const result = session.run(0, 10000);
  assertEquals(result.status, 'done');

  // Verify the closure has the async flag set
  const memoryImage = session.memoryImage;
  const globalScope = memoryImage.getRootScope();
  const fooOffset = memoryImage.internString('foo');
  const fooValuePointer = memoryImage.scopeLookup(globalScope, fooOffset);
  const fooValue = memoryImage.getValue(fooValuePointer);

  assertEquals(fooValue.type, TYPE.FUNCTION);
  const closurePointer = Number(fooValue.payload);
  assertEquals(memoryImage.isAsyncClosure(closurePointer), true);
  assertEquals(memoryImage.isArrowClosure(closurePointer), false);
});

Deno.test('Parser: async arrow function creates async arrow closure', () => {
  const session = freshSession();
  parseAndSetup(session, 'let foo = async () => 42');
  const result = session.run(0, 10000);
  assertEquals(result.status, 'done');

  const memoryImage = session.memoryImage;
  const globalScope = memoryImage.getRootScope();
  const fooOffset = memoryImage.internString('foo');
  const fooValuePointer = memoryImage.scopeLookup(globalScope, fooOffset);
  const fooValue = memoryImage.getValue(fooValuePointer);

  assertEquals(fooValue.type, TYPE.FUNCTION);
  const closurePointer = Number(fooValue.payload);
  assertEquals(memoryImage.isAsyncClosure(closurePointer), true);
  assertEquals(memoryImage.isArrowClosure(closurePointer), true);
});

Deno.test('Parser: async arrow with single param', () => {
  const session = freshSession();
  parseAndSetup(session, 'let foo = async x => x * 2');
  const result = session.run(0, 10000);
  assertEquals(result.status, 'done');

  const memoryImage = session.memoryImage;
  const globalScope = memoryImage.getRootScope();
  const fooOffset = memoryImage.internString('foo');
  const fooValuePointer = memoryImage.scopeLookup(globalScope, fooOffset);
  const fooValue = memoryImage.getValue(fooValuePointer);

  assertEquals(fooValue.type, TYPE.FUNCTION);
  const closurePointer = Number(fooValue.payload);
  assertEquals(memoryImage.isAsyncClosure(closurePointer), true);
  assertEquals(memoryImage.isArrowClosure(closurePointer), true);
});

Deno.test('Parser: async function expression', () => {
  const session = freshSession();
  parseAndSetup(session, 'let foo = async function() { return 42; }');
  const result = session.run(0, 10000);
  assertEquals(result.status, 'done');

  const memoryImage = session.memoryImage;
  const globalScope = memoryImage.getRootScope();
  const fooOffset = memoryImage.internString('foo');
  const fooValuePointer = memoryImage.scopeLookup(globalScope, fooOffset);
  const fooValue = memoryImage.getValue(fooValuePointer);

  assertEquals(fooValue.type, TYPE.FUNCTION);
  const closurePointer = Number(fooValue.payload);
  assertEquals(memoryImage.isAsyncClosure(closurePointer), true);
  assertEquals(memoryImage.isArrowClosure(closurePointer), false);
});

// =============================================================================
// Calling async functions returns a Promise
// =============================================================================

Deno.test('Calling async function returns a Promise', () => {
  const session = freshSession();
  parseAndSetup(session, `
    async function foo() { return 42; }
    let p = foo();
  `);
  const result = runToCompletion(session);
  assertEquals(result.status, 'done');

  // p should be a Promise
  const memoryImage = session.memoryImage;
  const globalScope = memoryImage.getRootScope();
  const pOffset = memoryImage.internString('p');
  const pValuePointer = memoryImage.scopeLookup(globalScope, pOffset);
  const pValue = memoryImage.getValue(pValuePointer);

  assertEquals(pValue.type, TYPE.PROMISE);
});

Deno.test('Async function returning value resolves promise', () => {
  const session = freshSession();
  parseAndSetup(session, `
    async function foo() { return 42; }
    let p = foo();
  `);
  const result = runToCompletion(session);
  assertEquals(result.status, 'done');

  // Get the promise
  const memoryImage = session.memoryImage;
  const globalScope = memoryImage.getRootScope();
  const pOffset = memoryImage.internString('p');
  const pValuePointer = memoryImage.scopeLookup(globalScope, pOffset);
  const pValue = memoryImage.getValue(pValuePointer);

  assertEquals(pValue.type, TYPE.PROMISE);
  // payload is the header pointer as BigInt, data pointer is header + GC_HEADER_SIZE
  const promisePointer = Number(pValue.payload) + 8;

  // Check promise status and value
  const status = memoryImage.getPromiseStatus(promisePointer);
  assertEquals(status, PROMISE_STATUS_RESOLVED);
  const promiseValue = memoryImage.getPromiseValue(promisePointer);
  // Integer literals are Rational now; the resolved value carries type RATIONAL.
  assertEquals(promiseValue.type, TYPE.RATIONAL);
});

Deno.test('Async arrow function returning value resolves promise', () => {
  const session = freshSession();
  parseAndSetup(session, `
    let foo = async () => 42;
    let p = foo();
  `);
  const result = runToCompletion(session);
  assertEquals(result.status, 'done');

  const memoryImage = session.memoryImage;
  const globalScope = memoryImage.getRootScope();
  const pOffset = memoryImage.internString('p');
  const pValuePointer = memoryImage.scopeLookup(globalScope, pOffset);
  const pValue = memoryImage.getValue(pValuePointer);

  assertEquals(pValue.type, TYPE.PROMISE);
  const promisePointer = Number(pValue.payload) + 8;

  assertEquals(memoryImage.getPromiseStatus(promisePointer), PROMISE_STATUS_RESOLVED);
  const promiseValue = memoryImage.getPromiseValue(promisePointer);
  assertEquals(promiseValue.type, TYPE.RATIONAL);
});

Deno.test('Async function with arguments', () => {
  const session = freshSession();
  parseAndSetup(session, `
    async function add(a, b) { return a + b; }
    let p = add(10, 32);
  `);
  const result = runToCompletion(session);
  assertEquals(result.status, 'done');

  const memoryImage = session.memoryImage;
  const globalScope = memoryImage.getRootScope();
  const pOffset = memoryImage.internString('p');
  const pValuePointer = memoryImage.scopeLookup(globalScope, pOffset);
  const pValue = memoryImage.getValue(pValuePointer);

  assertEquals(pValue.type, TYPE.PROMISE);
  const promisePointer = Number(pValue.payload) + 8;

  assertEquals(memoryImage.getPromiseStatus(promisePointer), PROMISE_STATUS_RESOLVED);
  const promiseValue = memoryImage.getPromiseValue(promisePointer);
  assertEquals(promiseValue.type, TYPE.RATIONAL);
});

// =============================================================================
// Async function throwing rejects promise
// =============================================================================

Deno.test('Async function throwing rejects promise', () => {
  const session = freshSession();
  parseAndSetup(session, `
    async function fail() { throw new Error('oops'); }
    let p = fail();
  `);
  const result = runToCompletion(session);
  assertEquals(result.status, 'done');

  const memoryImage = session.memoryImage;
  const globalScope = memoryImage.getRootScope();
  const pOffset = memoryImage.internString('p');
  const pValuePointer = memoryImage.scopeLookup(globalScope, pOffset);
  const pValue = memoryImage.getValue(pValuePointer);

  assertEquals(pValue.type, TYPE.PROMISE);
  const promisePointer = Number(pValue.payload) + 8;

  assertEquals(memoryImage.getPromiseStatus(promisePointer), PROMISE_STATUS_REJECTED);
});

// =============================================================================
// Multiple async calls
// =============================================================================

Deno.test('Multiple async calls create independent promises', () => {
  const session = freshSession();
  parseAndSetup(session, `
    async function foo() { return 1; }
    let p1 = foo();
    let p2 = foo();
  `);
  const result = runToCompletion(session);
  assertEquals(result.status, 'done');

  const memoryImage = session.memoryImage;
  const globalScope = memoryImage.getRootScope();

  const p1Offset = memoryImage.internString('p1');
  const p1ValuePointer = memoryImage.scopeLookup(globalScope, p1Offset);
  const p1Value = memoryImage.getValue(p1ValuePointer);

  const p2Offset = memoryImage.internString('p2');
  const p2ValuePointer = memoryImage.scopeLookup(globalScope, p2Offset);
  const p2Value = memoryImage.getValue(p2ValuePointer);

  assertEquals(p1Value.type, TYPE.PROMISE);
  assertEquals(p2Value.type, TYPE.PROMISE);

  // They should be different promises
  assertNotEquals(Number(p1Value.payload), Number(p2Value.payload));

  // Both should be resolved
  const p1Pointer = Number(p1Value.payload) + 8;
  const p2Pointer = Number(p2Value.payload) + 8;
  assertEquals(memoryImage.getPromiseStatus(p1Pointer), PROMISE_STATUS_RESOLVED);
  assertEquals(memoryImage.getPromiseStatus(p2Pointer), PROMISE_STATUS_RESOLVED);
});

// =============================================================================
// Caller continues after async call
// =============================================================================

Deno.test('Caller continues after async call', () => {
  const session = freshSession();
  parseAndSetup(session, `
    async function slow() { return 1; }
    let p = slow();
    let x = 42;
  `);
  const result = runToCompletion(session);
  assertEquals(result.status, 'done');

  const memoryImage = session.memoryImage;
  const globalScope = memoryImage.getRootScope();

  // x should have value 42 (caller continued). Integer literal is Rational.
  const xOffset = memoryImage.internString('x');
  const xValuePointer = memoryImage.scopeLookup(globalScope, xOffset);
  assertEquals(memoryImage.readValueAt(xValuePointer, { unwrapRational: true }), 42);
});

// =============================================================================
// Nested regular calls in async function
// =============================================================================

Deno.test('Nested regular calls in async function', () => {
  const session = freshSession();
  parseAndSetup(session, `
    function helper(x) { return x * 2; }
    async function foo() { return helper(21); }
    let p = foo();
  `);
  const result = runToCompletion(session);
  assertEquals(result.status, 'done');

  const memoryImage = session.memoryImage;
  const globalScope = memoryImage.getRootScope();
  const pOffset = memoryImage.internString('p');
  const pValuePointer = memoryImage.scopeLookup(globalScope, pOffset);
  const pValue = memoryImage.getValue(pValuePointer);

  assertEquals(pValue.type, TYPE.PROMISE);
  const promisePointer = Number(pValue.payload) + 8;

  assertEquals(memoryImage.getPromiseStatus(promisePointer), PROMISE_STATUS_RESOLVED);
  const promiseValue = memoryImage.getPromiseValue(promisePointer);
  assertEquals(promiseValue.type, TYPE.RATIONAL);
});

// =============================================================================
// Async function without explicit return
// =============================================================================

Deno.test('Async function without explicit return resolves to undefined', () => {
  const session = freshSession();
  parseAndSetup(session, `
    async function foo() { let x = 1; }
    let p = foo();
  `);
  const result = runToCompletion(session);
  assertEquals(result.status, 'done');

  const memoryImage = session.memoryImage;
  const globalScope = memoryImage.getRootScope();
  const pOffset = memoryImage.internString('p');
  const pValuePointer = memoryImage.scopeLookup(globalScope, pOffset);
  const pValue = memoryImage.getValue(pValuePointer);

  assertEquals(pValue.type, TYPE.PROMISE);
  const promisePointer = Number(pValue.payload) + 8;

  assertEquals(memoryImage.getPromiseStatus(promisePointer), PROMISE_STATUS_RESOLVED);
  const promiseValue = memoryImage.getPromiseValue(promisePointer);
  assertEquals(promiseValue.type, TYPE.UNDEFINED);
});

// =============================================================================
// Async method shorthand in object literals
//
// Method-shorthand `async` support fixes the original failure. The repro was
// `{ async next() {...} }` consumed via for-await; the root cause was a
// combination of (1) method shorthand silently dropping the `async`
// modifier and (2) the parser also rejecting `async` as a reserved-word
// property name without surfacing the parse failure (per F10 helper
// fix). After the fix:
//
//   - `{ async foo() {} }` creates an async closure as the property value
//   - `obj.foo()` dispatches as an async method call and yields a Promise
//   - `await obj.foo()` resolves to the body's return value
//   - `{ async: value }` (async as a plain property name) still works
// =============================================================================

// Helper: pull the resolved integer value out of a Promise binding.
function resolvedInt(session, name) {
  const mem = session.memoryImage;
  const ptr = mem.scopeLookup(mem.getRootScope(), mem.internString(name));
  const v = mem.getValue(ptr);
  assertEquals(v.type, TYPE.PROMISE);
  const promisePointer = Number(v.payload) + 8;
  assertEquals(mem.getPromiseStatus(promisePointer), PROMISE_STATUS_RESOLVED);
  return mem.getPromiseValue(promisePointer);
}

Deno.test('Async method shorthand: { async foo() {} } produces an async closure', () => {
  const session = freshSession();
  parseAndSetup(session, `
    let obj = { async foo() { return 42; } };
    let p = obj.foo();
  `);
  const result = runToCompletion(session);
  assertEquals(result.status, 'done');
  const pv = resolvedInt(session, 'p');
  assertEquals(pv.lo, 42);
});

Deno.test('Async method: await obj.foo() returns the body value', () => {
  const session = freshSession();
  parseAndSetup(session, `
    let obj = { async foo() { return 99; } };
    async function go() { return await obj.foo(); }
    let p = go();
  `);
  const r = runToCompletion(session);
  assertEquals(r.status, 'done');
  assertEquals(resolvedInt(session, 'p').lo, 99);
});

Deno.test('Async method: this binding is the receiver inside the body', () => {
  const session = freshSession();
  parseAndSetup(session, `
    let obj = {
      v: 17,
      async readV() { return this.v; },
    };
    async function go() { return await obj.readV(); }
    let p = go();
  `);
  const r = runToCompletion(session);
  assertEquals(r.status, 'done');
  assertEquals(resolvedInt(session, 'p').lo, 17);
});

Deno.test('Async method on iterator: { async next() {} } works end-to-end', () => {
  // This is the original async-method-on-iterator reproduction.
  const session = freshSession();
  parseAndSetup(session, `
    let iter = {
      async next() { return { value: 7, done: false }; },
    };
    async function go() {
      let r = await iter.next();
      return r.value;
    }
    let p = go();
  `);
  const r = runToCompletion(session);
  assertEquals(r.status, 'done');
  assertEquals(resolvedInt(session, 'p').lo, 7);
});

Deno.test('async as a plain property name still works: { async: 42 }', () => {
  // F9-adjacent: `async` is a reserved word but valid as a property
  // name. The cover-grammar fix peeks past `async` and only treats it
  // as a method modifier when an identifier-and-`(` follows.
  const session = freshSession();
  parseAndSetup(session, `
    let obj = { async: 42 };
    let v = obj.async;
  `);
  const result = session.run(0, 100000);
  assertEquals(result.status, 'done');
  assertEquals(session.get(0, 'v'), 42);
});

// =============================================================================
// Async calls with spread arguments (F4: CALL_SPREAD/CALL_METHOD_SPREAD
// used to raise a bare TypeError for async callees)
// =============================================================================

Deno.test('Async: plain call with spread arguments', () => {
  const session = freshSession();
  parseAndSetup(session, `
    async function f(a, b) { return a + b; }
    let r = 0;
    async function main() { r = await f(...[10, 20]); }
    main();
  `);
  runToCompletion(session);
  assertEquals(session.get(0, 'r'), 30);
});

Deno.test('Async: method call with spread arguments binds this', () => {
  const session = freshSession();
  parseAndSetup(session, `
    let obj = {
      base: 100,
      f: async function (a, b) { return this.base + a + b; },
    };
    let r = 0;
    async function main() { r = await obj.f(...[1, 2]); }
    main();
  `);
  runToCompletion(session);
  assertEquals(session.get(0, 'r'), 103);
});

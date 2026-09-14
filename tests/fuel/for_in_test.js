/**
 * Tests for `for...in` (parser desugaring to Object.keys + indexed loop)
 * and the JS-aligned Object.keys behavior on non-objects.
 *
 * Run with: deno task test tests/fuel/for_in_test.js
 */

import { assertEquals, assertThrows } from "https://deno.land/std@0.208.0/assert/mod.ts";
import { freshSession } from '../../src/host-owned-session.js';
import { parseAndSetup } from './test-helpers.js';
import { UncaughtScriptError } from '../../src/runtime/errors.js';

function run(source) {
  const session = freshSession();
  parseAndSetup(session, source);
  session.run(0, 1_000_000);
  return session;
}

function assertResult(source, varName, expected) {
  const session = run(source);
  assertEquals(session.get(0, varName), expected);
}

function assertTypeError(source) {
  const session = freshSession();
  parseAndSetup(session, source);
  let err;
  try {
    session.run(0, 1_000_000);
    throw new Error(`expected error, got status=done`);
  } catch (e) {
    if (!(e instanceof UncaughtScriptError)) throw e;
    err = e.scriptError;
  }
  const code = err.codeName;
  if (code !== 'TypeError' && code !== 'USER_THROW') {
    throw new Error(`expected TypeError or USER_THROW, got ${code}: ${err.message}`);
  }
  const msg = err.message ?? '';
  if (!msg.includes('Not an object')) {
    throw new Error(`expected message to include "Not an object", got: ${msg}`);
  }
}

function assertParseError(source, expectedFragment) {
  const session = freshSession();
  let msg = null;
  try {
    session.parse(source);
  } catch (parseError) {
    msg = parseError.message;
  }
  if (msg === null) {
    throw new Error(`expected parse to fail`);
  }
  if (!msg.includes(expectedFragment)) {
    throw new Error(`expected parse error to include "${expectedFragment}", got: ${msg}`);
  }
}

// =============================================================================
// Object.keys — JS-aligned semantics for non-objects
// =============================================================================

Deno.test("Object.keys: plain object returns own keys", () => {
  assertResult('let r = Object.keys({a: 1, b: 2, c: 3})', 'r', ['a', 'b', 'c']);
});

Deno.test("Object.keys: empty object returns empty array", () => {
  assertResult('let r = Object.keys({})', 'r', []);
});

Deno.test("Object.keys: array returns string indices", () => {
  assertResult('let r = Object.keys([10, 20, 30])', 'r', ['0', '1', '2']);
});

Deno.test("Object.keys: empty array returns empty array", () => {
  assertResult('let r = Object.keys([])', 'r', []);
});

Deno.test("Object.keys: string returns string indices per code point", () => {
  assertResult('let r = Object.keys("abc")', 'r', ['0', '1', '2']);
});

Deno.test("Object.keys: empty string returns empty array", () => {
  assertResult('let r = Object.keys("")', 'r', []);
});

Deno.test("Object.keys: null throws TypeError", () => {
  assertTypeError('let r = Object.keys(null)');
});

Deno.test("Object.keys: undefined throws TypeError", () => {
  assertTypeError('let r = Object.keys(undefined)');
});

Deno.test("Object.keys: number returns empty array", () => {
  assertResult('let r = Object.keys(42)', 'r', []);
});

Deno.test("Object.keys: boolean returns empty array", () => {
  assertResult('let r = Object.keys(true)', 'r', []);
});

// =============================================================================
// for...in — plain objects
// =============================================================================

Deno.test("for...in: iterates own keys of plain object", () => {
  assertResult(`
    let o = {a: 1, b: 2, c: 3};
    let r = [];
    for (let k in o) { r.push(k); }
  `, 'r', ['a', 'b', 'c']);
});

Deno.test("for...in: empty object iterates zero times", () => {
  assertResult(`
    let o = {};
    let n = 0;
    for (let k in o) { n = n + 1; }
  `, 'n', 0);
});

Deno.test("for...in: yields keys as strings", () => {
  assertResult(`
    let o = {x: 10};
    let kind = "";
    for (let k in o) { kind = typeof k; }
  `, 'kind', 'string');
});

Deno.test("for...in: const binding", () => {
  assertResult(`
    let o = {a: 1, b: 2};
    let r = [];
    for (const k in o) { r.push(k); }
  `, 'r', ['a', 'b']);
});

// =============================================================================
// for...in — arrays and strings (indices as strings, JS semantics)
// =============================================================================

Deno.test("for...in: array yields string indices", () => {
  assertResult(`
    let a = [10, 20, 30];
    let r = [];
    for (let k in a) { r.push(k); }
  `, 'r', ['0', '1', '2']);
});

Deno.test("for...in: string yields string indices", () => {
  assertResult(`
    let s = "abc";
    let r = [];
    for (let k in s) { r.push(k); }
  `, 'r', ['0', '1', '2']);
});

// =============================================================================
// for...in — null/undefined throw (via Object.keys)
// =============================================================================

Deno.test("for...in: null throws TypeError", () => {
  assertTypeError(`for (let k in null) { }`);
});

Deno.test("for...in: undefined throws TypeError", () => {
  assertTypeError(`for (let k in undefined) { }`);
});

// =============================================================================
// for...in — control flow (break, continue, nested)
// =============================================================================

Deno.test("for...in: break exits early", () => {
  assertResult(`
    let o = {a: 1, b: 2, c: 3};
    let r = [];
    for (let k in o) {
      if (k === 'b') break;
      r.push(k);
    }
  `, 'r', ['a']);
});

Deno.test("for...in: continue skips iteration", () => {
  assertResult(`
    let o = {a: 1, b: 2, c: 3};
    let r = [];
    for (let k in o) {
      if (k === 'b') continue;
      r.push(k);
    }
  `, 'r', ['a', 'c']);
});

Deno.test("for...in: nested loops", () => {
  assertResult(`
    let r = [];
    for (let k1 in {x: 1, y: 2}) {
      for (let k2 in {a: 1, b: 2}) {
        r.push(k1 + k2);
      }
    }
  `, 'r', ['xa', 'xb', 'ya', 'yb']);
});

Deno.test("for...in: body can read iterable values", () => {
  assertResult(`
    let o = {a: 1, b: 2, c: 3};
    let sum = 0;
    for (let k in o) { sum = sum + o[k]; }
  `, 'sum', 6);
});

// =============================================================================
// for...in — per-iteration scope (closure capture)
// =============================================================================

Deno.test("for...in: per-iteration scope for closures", () => {
  // Each iteration's `k` is a fresh binding, so captured closures see
  // distinct values rather than the final loop value.
  assertResult(`
    let o = {a: 1, b: 2, c: 3};
    let fns = [];
    for (let k in o) { fns.push(() => k); }
    let r = fns.map((f) => f());
  `, 'r', ['a', 'b', 'c']);
});

// =============================================================================
// for...in — mutation during iteration (snapshot semantics)
// =============================================================================

Deno.test("for...in: keys are snapshotted at loop start", () => {
  // Object.keys captures keys up-front, so adding a key mid-loop does
  // not extend the iteration.
  assertResult(`
    let o = {a: 1, b: 2};
    let r = [];
    for (let k in o) {
      r.push(k);
      o.c = 3;
    }
  `, 'r', ['a', 'b']);
});

// =============================================================================
// for...in — pattern form rejected at parse time
// =============================================================================

Deno.test("for...in: array destructuring pattern rejected", () => {
  assertParseError(
    `for (let [a, b] in {}) { }`,
    "Destructuring patterns not supported in for...in",
  );
});

Deno.test("for...in: object destructuring pattern rejected", () => {
  assertParseError(
    `for (let {a} in {}) { }`,
    "Destructuring patterns not supported in for...in",
  );
});

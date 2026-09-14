/**
 * Typed-array prototype parity with plain arrays for toString and sort.
 *
 * toString is a thin method wrapper over $typed_array_to_string — the
 * same conversion implicit coercion uses — so explicit and implicit
 * paths agree by construction. sort's DEFAULT comparator is NUMERIC
 * ascending per spec (%TypedArray%.prototype.sort), unlike JS arrays'
 * string sort — note sandscript's own Array.prototype.sort default is
 * also numeric, so the two kinds agree here. Sort is in place on the
 * descriptor's window: a subarray sort must not touch bytes outside
 * byte_offset..byte_offset+length.
 *
 * Also pins the OP_RETURN_UNDEFINED comparator fix that landed with
 * this work: a block-bodied comparator with no explicit return used to
 * fall into the generic forEach-style continuation and the whole sort
 * call returned undefined (plain arrays) or read garbage through the
 * descriptor (typed). Per spec an undefined comparator result coerces
 * to NaN which sorts as +0 — elements keep their order and the sort
 * still returns the receiver.
 *
 * Run with: deno task test tests/fuel/typed_array_prototype_parity_test.js
 */

import { assertEquals } from "https://deno.land/std@0.208.0/assert/mod.ts";
import { freshSession } from '../../src/host-owned-session.js';
import { parseAndSetup } from './test-helpers.js';

function assertResult(source, varName, expected) {
  const session = freshSession();
  parseAndSetup(session, source);
  const result = session.run(0, 10_000_000);
  assertEquals(result.status, 'done',
    `expected status=done, got ${result.status} (${result.error?.message})`);
  assertEquals(session.get(0, varName), expected);
}

// =============================================================================
// TypedArray.prototype.toString
// =============================================================================

Deno.test("typed toString: is a function", () => {
  assertResult('let b = new Uint8Array(3); let r = typeof b.toString', 'r', 'function');
});

Deno.test("typed toString: comma-joined decimals", () => {
  assertResult(
    'let b = new Uint8Array(3); b[0] = 5; b[1] = 200; b[2] = 7; let r = b.toString()',
    'r', '5,200,7');
});

Deno.test("typed toString: empty array", () => {
  assertResult('let b = new Uint8Array(0); let r = b.toString()', 'r', '');
});

Deno.test("typed toString: matches implicit coercion exactly", () => {
  assertResult(
    'let b = new Uint8Array(2); b[0] = 1; b[1] = 2; let r = (b.toString() === "" + b)',
    'r', true);
});

Deno.test("typed toString: Float64Array decimals and negatives", () => {
  assertResult(
    'let f = new Float64Array(2); f[0] = 1.5; f[1] = -2.25; let r = f.toString()',
    'r', '1.5,-2.25');
});

Deno.test("typed toString: subarray window only", () => {
  assertResult(
    'let b = new Uint8Array(5); b[0] = 9; b[1] = 4; b[2] = 3; b[3] = 2; b[4] = 1; ' +
    'let r = b.subarray(1, 4).toString()',
    'r', '4,3,2');
});

Deno.test("typed toString: Int16Array negatives", () => {
  assertResult(
    'let s = new Int16Array(2); s[0] = -300; s[1] = 100; let r = s.toString()',
    'r', '-300,100');
});

// =============================================================================
// toLocaleString — a resolution-time alias for toString on both kinds
// The sandbox has no locales, so default-locale number output equals
// toString's.
// =============================================================================

Deno.test("toLocaleString: array alias equals toString output", () => {
  assertResult(
    'let a = [1,2,3]; let r = (a.toLocaleString() === a.toString()) + ":" + a.toLocaleString()',
    'r', 'true:1,2,3');
});

Deno.test("toLocaleString: typed alias equals toString output", () => {
  assertResult(
    'let b = new Uint8Array(2); b[0] = 5; b[1] = 200; ' +
    'let r = (b.toLocaleString() === b.toString()) + ":" + b.toLocaleString()',
    'r', 'true:5,200');
});

Deno.test("toLocaleString: empty array is empty string", () => {
  assertResult('let r = [].toLocaleString()', 'r', '');
});

// =============================================================================
// TypedArray.prototype.sort — default (numeric ascending)
// =============================================================================

Deno.test("typed sort: is a function", () => {
  assertResult('let b = new Uint8Array(3); let r = typeof b.sort', 'r', 'function');
});

Deno.test("typed sort default: numeric ascending, not stringly", () => {
  // JS arrays would sort [10, 9, 2] as [10, 2, 9] under the spec's
  // string default; the typed default is numeric → [2, 9, 10].
  assertResult(
    'let b = new Uint8Array(3); b[0] = 10; b[1] = 9; b[2] = 2; let r = b.sort().toString()',
    'r', '2,9,10');
});

Deno.test("typed sort default: returns the receiver", () => {
  assertResult(
    'let b = new Uint8Array(2); b[0] = 2; b[1] = 1; let r = (b.sort() === b)',
    'r', true);
});

Deno.test("typed sort default: sorts in place", () => {
  assertResult(
    'let b = new Uint8Array(3); b[0] = 3; b[1] = 1; b[2] = 2; b.sort(); let r = b.toString()',
    'r', '1,2,3');
});

Deno.test("typed sort default: empty and single element", () => {
  assertResult('let b = new Uint8Array(0); let r = b.sort().toString()', 'r', '');
  assertResult('let b = new Uint8Array(1); b[0] = 7; let r = b.sort().toString()', 'r', '7');
});

Deno.test("typed sort default: Int16Array negatives sort numerically", () => {
  assertResult(
    'let s = new Int16Array(3); s[0] = 5; s[1] = -300; s[2] = 100; let r = s.sort().toString()',
    'r', '-300,5,100');
});

Deno.test("typed sort default: Float64Array NaN sorts last", () => {
  assertResult(
    'let f = new Float64Array(3); f[0] = 0 / 0; f[1] = 2; f[2] = 1; let r = f.sort().toString()',
    'r', '1,2,NaN');
});

Deno.test("typed sort default: subarray sort leaves bytes outside the window untouched", () => {
  assertResult(
    'let b = new Uint8Array(5); b[0] = 9; b[1] = 4; b[2] = 3; b[3] = 2; b[4] = 1; ' +
    'b.subarray(1, 4).sort(); let r = b.toString()',
    'r', '9,2,3,4,1');
});

// =============================================================================
// TypedArray.prototype.sort — comparator form
// =============================================================================

Deno.test("typed sort comparator: ascending", () => {
  assertResult(
    'let b = new Uint8Array(4); b[0] = 3; b[1] = 1; b[2] = 4; b[3] = 2; ' +
    'let r = b.sort((a, x) => a - x).toString()',
    'r', '1,2,3,4');
});

Deno.test("typed sort comparator: descending", () => {
  assertResult(
    'let b = new Uint8Array(4); b[0] = 3; b[1] = 1; b[2] = 4; b[3] = 2; ' +
    'let r = b.sort((a, x) => x - a).toString()',
    'r', '4,3,2,1');
});

Deno.test("typed sort comparator: returns the receiver", () => {
  assertResult(
    'let b = new Uint8Array(2); b[0] = 2; b[1] = 1; let r = (b.sort((a, x) => a - x) === b)',
    'r', true);
});

Deno.test("typed sort comparator: zero-returning comparator keeps order", () => {
  assertResult(
    'let b = new Uint8Array(3); b[0] = 3; b[1] = 1; b[2] = 2; ' +
    'let r = b.sort((a, x) => 0).toString()',
    'r', '3,1,2');
});

Deno.test("typed sort comparator: subarray isolation", () => {
  assertResult(
    'let b = new Uint8Array(5); b[0] = 9; b[1] = 4; b[2] = 3; b[3] = 2; b[4] = 1; ' +
    'b.subarray(1, 4).sort((a, x) => a - x); let r = b.toString()',
    'r', '9,2,3,4,1');
});

Deno.test("typed sort comparator: Float64Array fractional comparator results", () => {
  // Comparator results only need the right SIGN; fractional returns
  // must not be truncated toward zero.
  assertResult(
    'let f = new Float64Array(3); f[0] = 0.3; f[1] = 0.1; f[2] = 0.2; ' +
    'let r = f.sort((a, x) => a - x).toString()',
    'r', '0.1,0.2,0.3');
});

// =============================================================================
// Block-bodied comparator with no return (the OP_RETURN_UNDEFINED fix)
// =============================================================================

Deno.test("typed sort comparator: block body with no return keeps order and returns receiver", () => {
  assertResult(
    'let b = new Uint8Array(3); b[0] = 3; b[1] = 1; b[2] = 2; ' +
    'let r = b.sort((a, x) => {}).toString()',
    'r', '3,1,2');
});

Deno.test("array sort comparator: block body with no return keeps order and returns the array", () => {
  // Before the fix this returned undefined (the sort frame fell into
  // the generic forEach-style RETURN_UNDEFINED continuation).
  assertResult('let r = String([3, 1, 2].sort((a, x) => {}))', 'r', '3,1,2');
});

Deno.test("array sort comparator: expression-body undefined result keeps order (unchanged)", () => {
  assertResult('let r = String([3, 1, 2].sort((a, x) => undefined))', 'r', '3,1,2');
});

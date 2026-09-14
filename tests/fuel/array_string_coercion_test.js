/**
 * Tests for array → string coercion.
 *
 * Implements Array.prototype.toString (alias for .join(",")) and routes
 * implicit coercion sites through $array_join in interpreter.wat:
 *   - "" + arr        → coerces via $value_to_string
 *   - String(arr)     → explicit String() constructor
 *   - `${arr}`        → template literal substitution
 *   - arr.join(sep)   → explicit join with custom separator
 *   - arr.toString()  → calls $array_to_string directly
 *
 * Matches JS spec: null and undefined elements stringify to empty (not
 * "null"/"undefined"); nested arrays recurse via the same helper.
 *
 * Run with: deno task test tests/fuel/array_string_coercion_test.js
 */

import { assertEquals } from "https://deno.land/std@0.208.0/assert/mod.ts";
import { freshSession } from '../../src/host-owned-session.js';
import { parseAndSetup } from './test-helpers.js';

function run(source) {
  const session = freshSession();
  parseAndSetup(session, source);
  const result = session.run(0, 1_000_000);
  return { session, result };
}

function assertResult(source, varName, expected) {
  const { session, result } = run(source);
  assertEquals(result.status, 'done',
    `expected status=done, got ${result.status} (${result.error?.message})`);
  assertEquals(session.get(0, varName), expected);
}

// =============================================================================
// String(array)
// =============================================================================

Deno.test("String(array): integers", () => {
  assertResult('let r = String([1, 2, 3])', 'r', '1,2,3');
});

Deno.test("String(array): strings", () => {
  assertResult('let r = String(["a", "b", "c"])', 'r', 'a,b,c');
});

Deno.test("String(array): mixed", () => {
  assertResult('let r = String([1, "a", true])', 'r', '1,a,true');
});

Deno.test("String(array): empty", () => {
  assertResult('let r = String([])', 'r', '');
});

Deno.test("String(array): singleton", () => {
  assertResult('let r = String([42])', 'r', '42');
});

Deno.test("String(array): nested arrays flatten via recursion", () => {
  // Matches JS: [[1,2],[3,4]].toString() === "1,2,3,4" because each
  // element's toString returns its own join, and the outer join
  // concatenates with "," — same effect as flattening.
  assertResult('let r = String([[1,2],[3,4]])', 'r', '1,2,3,4');
});

Deno.test("String(array): null and undefined elements become empty", () => {
  // Per JS spec: Array.prototype.join treats null/undefined as empty string.
  assertResult('let r = String([1, null, 2, undefined, 3])', 'r', '1,,2,,3');
});

Deno.test("String(array): all-null elements", () => {
  assertResult('let r = String([null, null, null])', 'r', ',,');
});

// =============================================================================
// "" + array (implicit coercion via OP.ADD's value_to_string)
// =============================================================================

Deno.test("plus-coerce: empty-string prefix + array", () => {
  assertResult('let r = "" + [1, 2, 3]', 'r', '1,2,3');
});

Deno.test("plus-coerce: text + array", () => {
  assertResult('let r = "items: " + [10, 20]', 'r', 'items: 10,20');
});

Deno.test("plus-coerce: array on the left", () => {
  assertResult('let r = [1, 2] + " items"', 'r', '1,2 items');
});

// NOTE: `array + array` is NOT covered here — OP.ADD has no branch for
// "neither operand is a string but at least one is an array/object",
// so it falls through to the numeric paths and errors. Filed separately;
// fixing requires extending OP.ADD's coercion cascade, not the
// array-stringification helper itself.

// =============================================================================
// Template literal substitutions (delegate to value_to_string)
// =============================================================================

Deno.test("template: array of numbers in substitution", () => {
  assertResult('let r = `[${[1, 2, 3]}]`', 'r', '[1,2,3]');
});

Deno.test("template: empty array in substitution", () => {
  assertResult('let r = `[${[]}]`', 'r', '[]');
});

// =============================================================================
// arr.join(separator)
// =============================================================================

Deno.test("join: default separator (no arg)", () => {
  assertResult('let r = [1, 2, 3].join()', 'r', '1,2,3');
});

Deno.test("join: comma separator", () => {
  assertResult('let r = [1, 2, 3].join(",")', 'r', '1,2,3');
});

Deno.test("join: dash separator", () => {
  assertResult('let r = [1, 2, 3].join("-")', 'r', '1-2-3');
});

Deno.test("join: multi-char separator", () => {
  assertResult('let r = ["a", "b", "c"].join(" - ")', 'r', 'a - b - c');
});

Deno.test("join: empty separator", () => {
  assertResult('let r = [1, 2, 3].join("")', 'r', '123');
});

Deno.test("join: empty array returns empty string", () => {
  assertResult('let r = [].join(",")', 'r', '');
});

Deno.test("join: singleton (no separator added)", () => {
  assertResult('let r = [42].join(",")', 'r', '42');
});

Deno.test("join: null/undefined elements become empty", () => {
  assertResult('let r = [1, null, undefined, 2].join(",")', 'r', '1,,,2');
});

Deno.test("join: non-string separator falls back to default \",\"", () => {
  // v1 simplification: only string separators are honored; numeric / other
  // separator types use the default comma. JS spec coerces non-string
  // separators via String(); this is a documented divergence.
  assertResult('let r = [1, 2, 3].join(5)', 'r', '1,2,3');
});

// =============================================================================
// arr.toString() — explicit method call
// =============================================================================

Deno.test("toString: array of numbers", () => {
  assertResult('let r = [1, 2, 3].toString()', 'r', '1,2,3');
});

Deno.test("toString: empty array", () => {
  assertResult('let r = [].toString()', 'r', '');
});

Deno.test("toString: equivalent to .join(\",\")", () => {
  assertResult(`
    let a = [1, 2, 3, "x", true, null];
    let r = a.toString() === a.join(",");
  `, 'r', true);
});

Deno.test("toString: accessing the method without calling returns function", () => {
  assertResult('let r = typeof [1, 2, 3].toString', 'r', 'function');
});

// =============================================================================
// Cross-pattern equivalence
// =============================================================================

Deno.test("equivalence: String(arr) === arr.toString() === \"\" + arr", () => {
  assertResult(`
    let a = [1, "two", true, null];
    let r = String(a) === a.toString() && a.toString() === ("" + a);
  `, 'r', true);
});

Deno.test("equivalence: template substitution matches String() coercion", () => {
  assertResult(`
    let a = [1, 2, 3];
    let r = (\`\${a}\`) === String(a);
  `, 'r', true);
});

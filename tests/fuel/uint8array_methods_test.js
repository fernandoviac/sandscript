/**
 * Uint8Array method tests (Phase 2).
 *
 * Tests the non-callback methods: fill, reverse, indexOf, lastIndexOf,
 * includes, set, copyWithin, join.
 *
 * Run with: deno task test tests/fuel/uint8array_methods_test.js
 */

import { assertEquals, assert, assertThrows } from "https://deno.land/std@0.208.0/assert/mod.ts";
import { createSession } from '../../src/fuel/session.js';
import { freshSession } from '../../src/host-owned-session.js';
import { UncaughtScriptError } from '../../src/runtime/errors.js';

function runCode(code) {
  const session = freshSession();
  session.parse(code);
  const runResult = session.run(0, 10000);
  if (runResult.status === 'error') {
    throw new Error(`Execution error: ${JSON.stringify(runResult.error)}`);
  }
  return { status: runResult.status, value: session.result(0) };
}

// =============================================================================
// fill()
// =============================================================================

Deno.test("Uint8Array: fill() fills entire array with value", () => {
  const result = runCode(`
    let arr = new Uint8Array(5);
    arr.fill(42);
    [arr[0], arr[1], arr[2], arr[3], arr[4]]
  `);
  assertEquals(result.value, [42, 42, 42, 42, 42]);
});

Deno.test("Uint8Array: fill() with start and end", () => {
  const result = runCode(`
    let arr = new Uint8Array(5);
    arr.fill(0);
    arr.fill(99, 1, 4);
    [arr[0], arr[1], arr[2], arr[3], arr[4]]
  `);
  assertEquals(result.value, [0, 99, 99, 99, 0]);
});

Deno.test("Uint8Array: fill() wraps value to byte", () => {
  const result = runCode(`
    let arr = new Uint8Array(3);
    arr.fill(256);
    [arr[0], arr[1], arr[2]]
  `);
  assertEquals(result.value, [0, 0, 0]);
});

Deno.test("Uint8Array: fill() with negative start", () => {
  const result = runCode(`
    let arr = new Uint8Array(5);
    arr.fill(0);
    arr.fill(77, -2);
    [arr[0], arr[1], arr[2], arr[3], arr[4]]
  `);
  assertEquals(result.value, [0, 0, 0, 77, 77]);
});

Deno.test("Uint8Array: fill() returns this", () => {
  const result = runCode(`
    let arr = new Uint8Array(3);
    let returned = arr.fill(5);
    returned === arr
  `);
  assertEquals(result.value, true);
});

// =============================================================================
// reverse()
// =============================================================================

Deno.test("Uint8Array: reverse() reverses array", () => {
  const result = runCode(`
    let arr = new Uint8Array(5);
    arr[0] = 1; arr[1] = 2; arr[2] = 3; arr[3] = 4; arr[4] = 5;
    arr.reverse();
    [arr[0], arr[1], arr[2], arr[3], arr[4]]
  `);
  assertEquals(result.value, [5, 4, 3, 2, 1]);
});

Deno.test("Uint8Array: reverse() returns this", () => {
  const result = runCode(`
    let arr = new Uint8Array(3);
    arr[0] = 1; arr[1] = 2; arr[2] = 3;
    let returned = arr.reverse();
    returned === arr
  `);
  assertEquals(result.value, true);
});

Deno.test("Uint8Array: reverse() handles odd length", () => {
  const result = runCode(`
    let arr = new Uint8Array(3);
    arr[0] = 1; arr[1] = 2; arr[2] = 3;
    arr.reverse();
    [arr[0], arr[1], arr[2]]
  `);
  assertEquals(result.value, [3, 2, 1]);
});

// =============================================================================
// indexOf()
// =============================================================================

Deno.test("Uint8Array: indexOf() finds first occurrence", () => {
  const result = runCode(`
    let arr = new Uint8Array(5);
    arr[0] = 1; arr[1] = 2; arr[2] = 3; arr[3] = 2; arr[4] = 1;
    arr.indexOf(2)
  `);
  assertEquals(result.value, 1);
});

Deno.test("Uint8Array: indexOf() with fromIndex", () => {
  const result = runCode(`
    let arr = new Uint8Array(5);
    arr[0] = 1; arr[1] = 2; arr[2] = 3; arr[3] = 2; arr[4] = 1;
    arr.indexOf(2, 2)
  `);
  assertEquals(result.value, 3);
});

Deno.test("Uint8Array: indexOf() returns -1 when not found", () => {
  const result = runCode(`
    let arr = new Uint8Array(3);
    arr[0] = 1; arr[1] = 2; arr[2] = 3;
    arr.indexOf(99)
  `);
  assertEquals(result.value, -1);
});

Deno.test("Uint8Array: indexOf() with negative fromIndex", () => {
  const result = runCode(`
    let arr = new Uint8Array(5);
    arr[0] = 1; arr[1] = 2; arr[2] = 3; arr[3] = 2; arr[4] = 1;
    arr.indexOf(2, -3)
  `);
  assertEquals(result.value, 3);
});

// =============================================================================
// lastIndexOf()
// =============================================================================

Deno.test("Uint8Array: lastIndexOf() finds last occurrence", () => {
  const result = runCode(`
    let arr = new Uint8Array(5);
    arr[0] = 1; arr[1] = 2; arr[2] = 3; arr[3] = 2; arr[4] = 1;
    arr.lastIndexOf(2)
  `);
  assertEquals(result.value, 3);
});

Deno.test("Uint8Array: lastIndexOf() with fromIndex", () => {
  const result = runCode(`
    let arr = new Uint8Array(5);
    arr[0] = 1; arr[1] = 2; arr[2] = 3; arr[3] = 2; arr[4] = 1;
    arr.lastIndexOf(2, 2)
  `);
  assertEquals(result.value, 1);
});

Deno.test("Uint8Array: lastIndexOf() returns -1 when not found", () => {
  const result = runCode(`
    let arr = new Uint8Array(3);
    arr[0] = 1; arr[1] = 2; arr[2] = 3;
    arr.lastIndexOf(99)
  `);
  assertEquals(result.value, -1);
});

// =============================================================================
// includes()
// =============================================================================

Deno.test("Uint8Array: includes() returns true when found", () => {
  const result = runCode(`
    let arr = new Uint8Array(3);
    arr[0] = 1; arr[1] = 2; arr[2] = 3;
    arr.includes(2)
  `);
  assertEquals(result.value, true);
});

Deno.test("Uint8Array: includes() returns false when not found", () => {
  const result = runCode(`
    let arr = new Uint8Array(3);
    arr[0] = 1; arr[1] = 2; arr[2] = 3;
    arr.includes(99)
  `);
  assertEquals(result.value, false);
});

Deno.test("Uint8Array: includes() with fromIndex", () => {
  const result = runCode(`
    let arr = new Uint8Array(3);
    arr[0] = 1; arr[1] = 2; arr[2] = 3;
    [arr.includes(1, 1), arr.includes(2, 1)]
  `);
  assertEquals(result.value, [false, true]);
});

// =============================================================================
// set()
// =============================================================================

Deno.test("Uint8Array: set() from Array", () => {
  const result = runCode(`
    let dest = new Uint8Array(5);
    dest.set([1, 2, 3]);
    [dest[0], dest[1], dest[2], dest[3], dest[4]]
  `);
  assertEquals(result.value, [1, 2, 3, 0, 0]);
});

Deno.test("Uint8Array: set() from Array with offset", () => {
  const result = runCode(`
    let dest = new Uint8Array(5);
    dest.set([7, 8], 3);
    [dest[0], dest[1], dest[2], dest[3], dest[4]]
  `);
  assertEquals(result.value, [0, 0, 0, 7, 8]);
});

Deno.test("Uint8Array: set() from Uint8Array", () => {
  const result = runCode(`
    let dest = new Uint8Array(5);
    let src = new Uint8Array(2);
    src[0] = 10; src[1] = 20;
    dest.set(src, 1);
    [dest[0], dest[1], dest[2], dest[3], dest[4]]
  `);
  assertEquals(result.value, [0, 10, 20, 0, 0]);
});

Deno.test("Uint8Array: set() returns undefined", () => {
  const result = runCode(`
    let dest = new Uint8Array(5);
    dest.set([1, 2, 3])
  `);
  assertEquals(result.value, undefined);
});

Deno.test("Uint8Array: set() throws on overflow", () => {
  const session = freshSession();
  session.parse(`
    let dest = new Uint8Array(3);
    dest.set([1, 2, 3, 4]);
  `);
  assertThrows(() => session.run(0, 10000), UncaughtScriptError);
});

// =============================================================================
// copyWithin()
// =============================================================================

Deno.test("Uint8Array: copyWithin() copies forward", () => {
  const result = runCode(`
    let arr = new Uint8Array(5);
    arr[0] = 1; arr[1] = 2; arr[2] = 3; arr[3] = 4; arr[4] = 5;
    arr.copyWithin(0, 3);
    [arr[0], arr[1], arr[2], arr[3], arr[4]]
  `);
  assertEquals(result.value, [4, 5, 3, 4, 5]);
});

Deno.test("Uint8Array: copyWithin() copies backward", () => {
  const result = runCode(`
    let arr = new Uint8Array(5);
    arr[0] = 1; arr[1] = 2; arr[2] = 3; arr[3] = 4; arr[4] = 5;
    arr.copyWithin(2, 0);
    [arr[0], arr[1], arr[2], arr[3], arr[4]]
  `);
  assertEquals(result.value, [1, 2, 1, 2, 3]);
});

Deno.test("Uint8Array: copyWithin() with end parameter", () => {
  const result = runCode(`
    let arr = new Uint8Array(5);
    arr[0] = 1; arr[1] = 2; arr[2] = 3; arr[3] = 4; arr[4] = 5;
    arr.copyWithin(0, 3, 4);
    [arr[0], arr[1], arr[2], arr[3], arr[4]]
  `);
  assertEquals(result.value, [4, 2, 3, 4, 5]);
});

Deno.test("Uint8Array: copyWithin() returns this", () => {
  const result = runCode(`
    let arr = new Uint8Array(3);
    arr[0] = 1; arr[1] = 2; arr[2] = 3;
    let returned = arr.copyWithin(0, 1);
    returned === arr
  `);
  assertEquals(result.value, true);
});

// =============================================================================
// join()
// =============================================================================

Deno.test("Uint8Array: join() with default separator", () => {
  const result = runCode(`
    let arr = new Uint8Array(3);
    arr[0] = 65; arr[1] = 66; arr[2] = 67;
    arr.join()
  `);
  assertEquals(result.value, '65,66,67');
});

Deno.test("Uint8Array: join() with custom separator", () => {
  const result = runCode(`
    let arr = new Uint8Array(3);
    arr[0] = 1; arr[1] = 2; arr[2] = 3;
    arr.join('-')
  `);
  assertEquals(result.value, '1-2-3');
});

Deno.test("Uint8Array: join() with empty separator", () => {
  const result = runCode(`
    let arr = new Uint8Array(3);
    arr[0] = 1; arr[1] = 2; arr[2] = 3;
    arr.join('')
  `);
  assertEquals(result.value, '123');
});

Deno.test("Uint8Array: join() on empty array", () => {
  const result = runCode(`
    let arr = new Uint8Array(0);
    arr.join(',')
  `);
  assertEquals(result.value, '');
});

Deno.test("Uint8Array: join() on single element", () => {
  const result = runCode(`
    let arr = new Uint8Array(1);
    arr[0] = 42;
    arr.join(',')
  `);
  assertEquals(result.value, '42');
});

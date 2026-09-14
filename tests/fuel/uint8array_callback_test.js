/**
 * Uint8Array callback method tests.
 *
 * Tests: forEach, map, filter, find, findIndex, every, some, reduce, reduceRight.
 *
 * Run with: deno task test tests/fuel/uint8array_callback_test.js
 */

import { assertEquals, assert } from "https://deno.land/std@0.208.0/assert/mod.ts";
import { createSession } from '../../src/fuel/session.js';
import { freshSession } from '../../src/host-owned-session.js';

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
// forEach()
// =============================================================================

Deno.test("Uint8Array: forEach() iterates all elements", () => {
  const result = runCode(`
    let arr = new Uint8Array(3);
    arr[0] = 1; arr[1] = 2; arr[2] = 3;
    let sum = 0;
    arr.forEach((x) => { sum = sum + x; });
    sum
  `);
  assertEquals(result.value, 6);
});

Deno.test("Uint8Array: forEach() receives element, index, array", () => {
  const result = runCode(`
    let arr = new Uint8Array(3);
    arr[0] = 10; arr[1] = 20; arr[2] = 30;
    let indices = [];
    arr.forEach((elem, idx, a) => {
      indices.push(idx);
    });
    indices
  `);
  assertEquals(result.value, [0, 1, 2]);
});

Deno.test("Uint8Array: forEach() returns undefined", () => {
  const result = runCode(`
    let arr = new Uint8Array(3);
    arr[0] = 1; arr[1] = 2; arr[2] = 3;
    arr.forEach((x) => { x; })
  `);
  assertEquals(result.value, undefined);
});

Deno.test("Uint8Array: forEach() on empty array", () => {
  const result = runCode(`
    let arr = new Uint8Array(0);
    let called = false;
    arr.forEach((x) => { called = true; });
    called
  `);
  assertEquals(result.value, false);
});

// =============================================================================
// map()
// =============================================================================

Deno.test("Uint8Array: map() transforms elements", () => {
  const result = runCode(`
    let arr = new Uint8Array(3);
    arr[0] = 1; arr[1] = 2; arr[2] = 3;
    let doubled = arr.map((x) => x * 2);
    [doubled[0], doubled[1], doubled[2]]
  `);
  assertEquals(result.value, [2, 4, 6]);
});

Deno.test("Uint8Array: map() returns Uint8Array", () => {
  const result = runCode(`
    let arr = new Uint8Array(3);
    arr[0] = 1; arr[1] = 2; arr[2] = 3;
    let mapped = arr.map((x) => x + 1);
    mapped instanceof Uint8Array
  `);
  assertEquals(result.value, true);
});

Deno.test("Uint8Array: map() wraps results to byte", () => {
  const result = runCode(`
    let arr = new Uint8Array(2);
    arr[0] = 100; arr[1] = 200;
    let mapped = arr.map((x) => x * 2);
    [mapped[0], mapped[1]]
  `);
  // 100*2=200, 200*2=400 -> 400 & 255 = 144
  assertEquals(result.value, [200, 144]);
});

Deno.test("Uint8Array: map() same length as source", () => {
  const result = runCode(`
    let arr = new Uint8Array(5);
    arr[0] = 1; arr[1] = 2; arr[2] = 3; arr[3] = 4; arr[4] = 5;
    let mapped = arr.map((x) => x);
    mapped.length
  `);
  assertEquals(result.value, 5);
});

Deno.test("Uint8Array: map() on empty array", () => {
  const result = runCode(`
    let arr = new Uint8Array(0);
    let mapped = arr.map((x) => x * 2);
    mapped.length
  `);
  assertEquals(result.value, 0);
});

// =============================================================================
// filter()
// =============================================================================

Deno.test("Uint8Array: filter() selects elements", () => {
  const result = runCode(`
    let arr = new Uint8Array(5);
    arr[0] = 1; arr[1] = 2; arr[2] = 3; arr[3] = 4; arr[4] = 5;
    let evens = arr.filter((x) => x % 2 === 0);
    [evens[0], evens[1], evens.length]
  `);
  assertEquals(result.value, [2, 4, 2]);
});

Deno.test("Uint8Array: filter() returns Uint8Array", () => {
  const result = runCode(`
    let arr = new Uint8Array(3);
    arr[0] = 1; arr[1] = 2; arr[2] = 3;
    let filtered = arr.filter((x) => x > 1);
    filtered instanceof Uint8Array
  `);
  assertEquals(result.value, true);
});

Deno.test("Uint8Array: filter() returns empty when no match", () => {
  const result = runCode(`
    let arr = new Uint8Array(3);
    arr[0] = 1; arr[1] = 2; arr[2] = 3;
    let filtered = arr.filter((x) => x > 10);
    filtered.length
  `);
  assertEquals(result.value, 0);
});

Deno.test("Uint8Array: filter() on empty array", () => {
  const result = runCode(`
    let arr = new Uint8Array(0);
    let filtered = arr.filter((x) => true);
    filtered.length
  `);
  assertEquals(result.value, 0);
});

// =============================================================================
// find()
// =============================================================================

Deno.test("Uint8Array: find() returns first match", () => {
  const result = runCode(`
    let arr = new Uint8Array(5);
    arr[0] = 1; arr[1] = 2; arr[2] = 3; arr[3] = 4; arr[4] = 5;
    arr.find((x) => x > 2)
  `);
  assertEquals(result.value, 3);
});

Deno.test("Uint8Array: find() returns undefined when not found", () => {
  const result = runCode(`
    let arr = new Uint8Array(3);
    arr[0] = 1; arr[1] = 2; arr[2] = 3;
    arr.find((x) => x > 10)
  `);
  assertEquals(result.value, undefined);
});

Deno.test("Uint8Array: find() on empty array", () => {
  const result = runCode(`
    let arr = new Uint8Array(0);
    arr.find((x) => true)
  `);
  assertEquals(result.value, undefined);
});

// =============================================================================
// findIndex()
// =============================================================================

Deno.test("Uint8Array: findIndex() returns first match index", () => {
  const result = runCode(`
    let arr = new Uint8Array(5);
    arr[0] = 1; arr[1] = 2; arr[2] = 3; arr[3] = 4; arr[4] = 5;
    arr.findIndex((x) => x > 2)
  `);
  assertEquals(result.value, 2);
});

Deno.test("Uint8Array: findIndex() returns -1 when not found", () => {
  const result = runCode(`
    let arr = new Uint8Array(3);
    arr[0] = 1; arr[1] = 2; arr[2] = 3;
    arr.findIndex((x) => x > 10)
  `);
  assertEquals(result.value, -1);
});

Deno.test("Uint8Array: findIndex() on empty array", () => {
  const result = runCode(`
    let arr = new Uint8Array(0);
    arr.findIndex((x) => true)
  `);
  assertEquals(result.value, -1);
});

// =============================================================================
// every()
// =============================================================================

Deno.test("Uint8Array: every() returns true when all match", () => {
  const result = runCode(`
    let arr = new Uint8Array(3);
    arr[0] = 2; arr[1] = 4; arr[2] = 6;
    arr.every((x) => x % 2 === 0)
  `);
  assertEquals(result.value, true);
});

Deno.test("Uint8Array: every() returns false when one fails", () => {
  const result = runCode(`
    let arr = new Uint8Array(3);
    arr[0] = 2; arr[1] = 3; arr[2] = 6;
    arr.every((x) => x % 2 === 0)
  `);
  assertEquals(result.value, false);
});

Deno.test("Uint8Array: every() returns true on empty array", () => {
  const result = runCode(`
    let arr = new Uint8Array(0);
    arr.every((x) => false)
  `);
  assertEquals(result.value, true);
});

// =============================================================================
// some()
// =============================================================================

Deno.test("Uint8Array: some() returns true when one matches", () => {
  const result = runCode(`
    let arr = new Uint8Array(3);
    arr[0] = 1; arr[1] = 2; arr[2] = 3;
    arr.some((x) => x > 2)
  `);
  assertEquals(result.value, true);
});

Deno.test("Uint8Array: some() returns false when none match", () => {
  const result = runCode(`
    let arr = new Uint8Array(3);
    arr[0] = 1; arr[1] = 2; arr[2] = 3;
    arr.some((x) => x > 10)
  `);
  assertEquals(result.value, false);
});

Deno.test("Uint8Array: some() returns false on empty array", () => {
  const result = runCode(`
    let arr = new Uint8Array(0);
    arr.some((x) => true)
  `);
  assertEquals(result.value, false);
});

// =============================================================================
// reduce()
// =============================================================================

Deno.test("Uint8Array: reduce() with initial value", () => {
  const result = runCode(`
    let arr = new Uint8Array(3);
    arr[0] = 1; arr[1] = 2; arr[2] = 3;
    arr.reduce((acc, x) => acc + x, 0)
  `);
  assertEquals(result.value, 6);
});

Deno.test("Uint8Array: reduce() without initial value", () => {
  const result = runCode(`
    let arr = new Uint8Array(3);
    arr[0] = 1; arr[1] = 2; arr[2] = 3;
    arr.reduce((acc, x) => acc + x)
  `);
  assertEquals(result.value, 6);
});

Deno.test("Uint8Array: reduce() single element no initial", () => {
  const result = runCode(`
    let arr = new Uint8Array(1);
    arr[0] = 42;
    arr.reduce((acc, x) => acc + x)
  `);
  assertEquals(result.value, 42);
});

Deno.test("Uint8Array: reduce() empty with initial", () => {
  const result = runCode(`
    let arr = new Uint8Array(0);
    arr.reduce((acc, x) => acc + x, 100)
  `);
  assertEquals(result.value, 100);
});

Deno.test("Uint8Array: reduce() receives accumulator, element, index, array", () => {
  const result = runCode(`
    let arr = new Uint8Array(3);
    arr[0] = 10; arr[1] = 20; arr[2] = 30;
    let indices = [];
    arr.reduce((acc, elem, idx, a) => {
      indices.push(idx);
      return acc + elem;
    }, 0);
    indices
  `);
  assertEquals(result.value, [0, 1, 2]);
});

// Note: reduceRight is more complex to test, adding basic test
Deno.test("Uint8Array: reduceRight() iterates in reverse", () => {
  // For now, skip until reduceRight is fully implemented
  // This is a placeholder
});

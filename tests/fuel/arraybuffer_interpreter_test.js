/**
 * ArrayBuffer and Uint8Array interpreter integration tests.
 *
 * Tests constructor usage, indexed access, property access, and instanceof.
 *
 * Run with: deno task test tests/fuel/arraybuffer_interpreter_test.js
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
// ArrayBuffer Constructor
// =============================================================================

Deno.test("ArrayBuffer: new ArrayBuffer(n) creates buffer", () => {
  const result = runCode(`
    let buf = new ArrayBuffer(10);
    buf.byteLength
  `);
  assertEquals(result.value, 10);
});

Deno.test("ArrayBuffer: new ArrayBuffer() defaults to 0", () => {
  const result = runCode(`
    let buf = new ArrayBuffer();
    buf.byteLength
  `);
  assertEquals(result.value, 0);
});

Deno.test("ArrayBuffer: negative length throws RangeError", () => {
  const session = freshSession();
  session.parse(`new ArrayBuffer(-1)`);
  const err = assertThrows(() => session.run(0, 10000), UncaughtScriptError);
  assert(err.scriptError.name === 'RangeError' || err.scriptError.message?.includes('RangeError'));
});

// =============================================================================
// Uint8Array Constructor
// =============================================================================

Deno.test("Uint8Array: new Uint8Array(n) creates typed array", () => {
  const result = runCode(`
    let arr = new Uint8Array(5);
    arr.length
  `);
  assertEquals(result.value, 5);
});

Deno.test("Uint8Array: new Uint8Array() defaults to 0", () => {
  const result = runCode(`
    let arr = new Uint8Array();
    arr.length
  `);
  assertEquals(result.value, 0);
});

Deno.test("Uint8Array: negative length throws RangeError", () => {
  const session = freshSession();
  session.parse(`new Uint8Array(-5)`);
  const err = assertThrows(() => session.run(0, 10000), UncaughtScriptError);
  assert(err.scriptError.name === 'RangeError' || err.scriptError.message?.includes('RangeError'));
});

// =============================================================================
// Uint8Array Indexed Access
// =============================================================================

Deno.test("Uint8Array: indexed read returns 0 initially", () => {
  const result = runCode(`
    let arr = new Uint8Array(5);
    arr[2]
  `);
  assertEquals(result.value, 0);
});

Deno.test("Uint8Array: indexed write and read", () => {
  const result = runCode(`
    let arr = new Uint8Array(5);
    arr[2] = 42;
    arr[2]
  `);
  assertEquals(result.value, 42);
});

Deno.test("Uint8Array: indexed write wraps to 0-255", () => {
  const result = runCode(`
    let arr = new Uint8Array(3);
    arr[0] = 256;  // wraps to 0
    arr[1] = 257;  // wraps to 1
    arr[2] = -1;   // wraps to 255
    [arr[0], arr[1], arr[2]]
  `);
  assertEquals(result.value, [0, 1, 255]);
});

Deno.test("Uint8Array: out of bounds read returns undefined", () => {
  const result = runCode(`
    let arr = new Uint8Array(3);
    arr[100]
  `);
  assertEquals(result.value, undefined);
});

Deno.test("Uint8Array: out of bounds write is silent", () => {
  const result = runCode(`
    let arr = new Uint8Array(3);
    arr[100] = 42;  // silent ignore
    arr.length
  `);
  assertEquals(result.value, 3);
});

// =============================================================================
// Uint8Array Properties
// =============================================================================

Deno.test("Uint8Array: .length property", () => {
  const result = runCode(`
    let arr = new Uint8Array(10);
    arr.length
  `);
  assertEquals(result.value, 10);
});

Deno.test("Uint8Array: .byteLength property", () => {
  const result = runCode(`
    let arr = new Uint8Array(10);
    arr.byteLength
  `);
  assertEquals(result.value, 10);
});

Deno.test("Uint8Array: .byteOffset property", () => {
  const result = runCode(`
    let arr = new Uint8Array(10);
    arr.byteOffset
  `);
  assertEquals(result.value, 0);
});

Deno.test("Uint8Array: .buffer property returns ArrayBuffer", () => {
  const result = runCode(`
    let arr = new Uint8Array(10);
    let buf = arr.buffer;
    buf.byteLength
  `);
  assertEquals(result.value, 10);
});

// =============================================================================
// ArrayBuffer Properties
// =============================================================================

Deno.test("ArrayBuffer: .byteLength property", () => {
  const result = runCode(`
    let buf = new ArrayBuffer(42);
    buf.byteLength
  `);
  assertEquals(result.value, 42);
});

// =============================================================================
// instanceof
// =============================================================================

Deno.test("instanceof: ArrayBuffer instanceof ArrayBuffer", () => {
  const result = runCode(`
    let buf = new ArrayBuffer(10);
    buf instanceof ArrayBuffer
  `);
  assertEquals(result.value, true);
});

Deno.test("instanceof: ArrayBuffer instanceof Object", () => {
  const result = runCode(`
    let buf = new ArrayBuffer(10);
    buf instanceof Object
  `);
  assertEquals(result.value, true);
});

Deno.test("instanceof: Uint8Array instanceof Uint8Array", () => {
  const result = runCode(`
    let arr = new Uint8Array(10);
    arr instanceof Uint8Array
  `);
  assertEquals(result.value, true);
});

Deno.test("instanceof: Uint8Array instanceof Object", () => {
  const result = runCode(`
    let arr = new Uint8Array(10);
    arr instanceof Object
  `);
  assertEquals(result.value, true);
});

Deno.test("instanceof: Uint8Array not instanceof ArrayBuffer", () => {
  const result = runCode(`
    let arr = new Uint8Array(10);
    arr instanceof ArrayBuffer
  `);
  assertEquals(result.value, false);
});

Deno.test("instanceof: object not instanceof ArrayBuffer", () => {
  const result = runCode(`
    let obj = {};
    obj instanceof ArrayBuffer
  `);
  assertEquals(result.value, false);
});

// =============================================================================
// RangeError
// =============================================================================

Deno.test("RangeError: can be thrown manually", () => {
  const session = freshSession();
  session.parse(`throw new RangeError("test")`);
  const err = assertThrows(() => session.run(0, 10000), UncaughtScriptError);
  assertEquals(err.scriptError.name, 'RangeError');
  assertEquals(err.scriptError.message, 'test');
});

Deno.test("RangeError: instanceof Error", () => {
  const result = runCode(`
    let e = new RangeError("test");
    e instanceof Error
  `);
  assertEquals(result.value, true);
});

Deno.test("RangeError: instanceof RangeError", () => {
  const result = runCode(`
    let e = new RangeError("test");
    e instanceof RangeError
  `);
  assertEquals(result.value, true);
});

// =============================================================================
// Phase 3: Constructor from ArrayBuffer
// =============================================================================

Deno.test("Uint8Array: new Uint8Array(buffer) views entire buffer", () => {
  const result = runCode(`
    let buf = new ArrayBuffer(10);
    let view = new Uint8Array(buf);
    [view.length, view.byteOffset, view.byteLength]
  `);
  assertEquals(result.value, [10, 0, 10]);
});

Deno.test("Uint8Array: new Uint8Array(buffer, offset) views from offset", () => {
  const result = runCode(`
    let buf = new ArrayBuffer(10);
    let view = new Uint8Array(buf, 3);
    [view.length, view.byteOffset, view.byteLength]
  `);
  assertEquals(result.value, [7, 3, 7]);
});

Deno.test("Uint8Array: new Uint8Array(buffer, offset, length) views portion", () => {
  const result = runCode(`
    let buf = new ArrayBuffer(10);
    let view = new Uint8Array(buf, 2, 5);
    [view.length, view.byteOffset, view.byteLength]
  `);
  assertEquals(result.value, [5, 2, 5]);
});

Deno.test("Uint8Array: views share underlying buffer", () => {
  const result = runCode(`
    let buf = new ArrayBuffer(10);
    let view1 = new Uint8Array(buf);
    let view2 = new Uint8Array(buf, 2);
    let view3 = new Uint8Array(buf, 2, 5);
    view1[2] = 42;
    [view2[0], view3[0]]
  `);
  assertEquals(result.value, [42, 42]);
});

Deno.test("Uint8Array: buffer identity preserved", () => {
  const result = runCode(`
    let buf = new ArrayBuffer(10);
    let view1 = new Uint8Array(buf);
    let view2 = new Uint8Array(buf, 2);
    view1.buffer === view2.buffer
  `);
  assertEquals(result.value, true);
});

Deno.test("Uint8Array: offset beyond buffer throws RangeError", () => {
  const session = freshSession();
  session.parse(`
    let buf = new ArrayBuffer(10);
    new Uint8Array(buf, 100);
  `);
  assertThrows(() => session.run(0, 10000), UncaughtScriptError);
});

Deno.test("Uint8Array: offset + length beyond buffer throws RangeError", () => {
  const session = freshSession();
  session.parse(`
    let buf = new ArrayBuffer(10);
    new Uint8Array(buf, 5, 100);
  `);
  assertThrows(() => session.run(0, 10000), UncaughtScriptError);
});

// =============================================================================
// Phase 3: subarray() method
// =============================================================================

Deno.test("Uint8Array: subarray() with no args returns full view", () => {
  const result = runCode(`
    let arr = new Uint8Array(5);
    let sub = arr.subarray();
    sub.length
  `);
  assertEquals(result.value, 5);
});

Deno.test("Uint8Array: subarray(start) views from start", () => {
  const result = runCode(`
    let arr = new Uint8Array(10);
    let sub = arr.subarray(3);
    [sub.length, sub.byteOffset]
  `);
  assertEquals(result.value, [7, 3]);
});

Deno.test("Uint8Array: subarray(start, end) views portion", () => {
  const result = runCode(`
    let arr = new Uint8Array(10);
    let sub = arr.subarray(2, 5);
    [sub.length, sub.byteOffset]
  `);
  assertEquals(result.value, [3, 2]);
});

Deno.test("Uint8Array: subarray shares buffer", () => {
  const result = runCode(`
    let arr = new Uint8Array(10);
    arr[3] = 99;
    let sub = arr.subarray(2, 6);
    sub[1]
  `);
  assertEquals(result.value, 99);
});

Deno.test("Uint8Array: subarray modifications affect original", () => {
  const result = runCode(`
    let arr = new Uint8Array(10);
    let sub = arr.subarray(2, 6);
    sub[0] = 77;
    arr[2]
  `);
  assertEquals(result.value, 77);
});

Deno.test("Uint8Array: subarray buffer identity", () => {
  const result = runCode(`
    let arr = new Uint8Array(10);
    let sub = arr.subarray(2, 5);
    arr.buffer === sub.buffer
  `);
  assertEquals(result.value, true);
});

Deno.test("Uint8Array: subarray negative start", () => {
  const result = runCode(`
    let arr = new Uint8Array(10);
    arr[8] = 88;
    arr[9] = 99;
    let sub = arr.subarray(-2);
    [sub.length, sub[0], sub[1]]
  `);
  assertEquals(result.value, [2, 88, 99]);
});

Deno.test("Uint8Array: subarray negative end", () => {
  const result = runCode(`
    let arr = new Uint8Array(10);
    arr[2] = 22;
    arr[7] = 77;
    let sub = arr.subarray(2, -2);
    [sub.length, sub[0], sub[5]]
  `);
  assertEquals(result.value, [6, 22, 77]);
});

Deno.test("Uint8Array: subarray start > end returns empty", () => {
  const result = runCode(`
    let arr = new Uint8Array(10);
    let sub = arr.subarray(5, 2);
    sub.length
  `);
  assertEquals(result.value, 0);
});

Deno.test("Uint8Array: subarray beyond bounds clamped", () => {
  const result = runCode(`
    let arr = new Uint8Array(5);
    let sub = arr.subarray(10);
    sub.length
  `);
  assertEquals(result.value, 0);
});

// =============================================================================
// Phase 3: slice() method
// =============================================================================

Deno.test("Uint8Array: slice() with no args copies all", () => {
  const result = runCode(`
    let arr = new Uint8Array(5);
    arr[2] = 42;
    let copy = arr.slice();
    [copy.length, copy[2]]
  `);
  assertEquals(result.value, [5, 42]);
});

Deno.test("Uint8Array: slice(start) copies from start", () => {
  const result = runCode(`
    let arr = new Uint8Array(10);
    arr[5] = 55;
    let copy = arr.slice(3);
    [copy.length, copy[2]]
  `);
  assertEquals(result.value, [7, 55]);
});

Deno.test("Uint8Array: slice(start, end) copies portion", () => {
  const result = runCode(`
    let arr = new Uint8Array(10);
    arr[3] = 33;
    let copy = arr.slice(2, 5);
    [copy.length, copy[1]]
  `);
  assertEquals(result.value, [3, 33]);
});

Deno.test("Uint8Array: slice creates independent buffer", () => {
  const result = runCode(`
    let arr = new Uint8Array(10);
    arr[2] = 42;
    let copy = arr.slice();
    arr[2] = 100;
    copy[2]
  `);
  assertEquals(result.value, 42);
});

Deno.test("Uint8Array: slice buffer not same as original", () => {
  const result = runCode(`
    let arr = new Uint8Array(10);
    let copy = arr.slice();
    arr.buffer === copy.buffer
  `);
  assertEquals(result.value, false);
});

Deno.test("Uint8Array: slice negative start", () => {
  const result = runCode(`
    let arr = new Uint8Array(5);
    arr[3] = 33;
    arr[4] = 44;
    let copy = arr.slice(-2);
    [copy.length, copy[0], copy[1]]
  `);
  assertEquals(result.value, [2, 33, 44]);
});

Deno.test("Uint8Array: slice negative end", () => {
  const result = runCode(`
    let arr = new Uint8Array(10);
    arr[2] = 22;
    arr[7] = 77;
    let copy = arr.slice(2, -2);
    [copy.length, copy[0], copy[5]]
  `);
  assertEquals(result.value, [6, 22, 77]);
});

Deno.test("Uint8Array: slice start > end returns empty", () => {
  const result = runCode(`
    let arr = new Uint8Array(10);
    let copy = arr.slice(5, 2);
    copy.length
  `);
  assertEquals(result.value, 0);
});

Deno.test("Uint8Array: slice beyond bounds clamped", () => {
  const result = runCode(`
    let arr = new Uint8Array(5);
    let copy = arr.slice(10);
    copy.length
  `);
  assertEquals(result.value, 0);
});

Deno.test("Uint8Array: slice on view with offset", () => {
  const result = runCode(`
    let buf = new ArrayBuffer(10);
    let view = new Uint8Array(buf, 2, 5);
    view[0] = 11;
    view[1] = 22;
    view[2] = 33;
    let copy = view.slice(1, 3);
    [copy.length, copy[0], copy[1], copy.byteOffset]
  `);
  assertEquals(result.value, [2, 22, 33, 0]);
});

Deno.test("Uint8Array: subarray on view with offset", () => {
  const result = runCode(`
    let buf = new ArrayBuffer(10);
    let view = new Uint8Array(buf, 2, 5);
    view[0] = 11;
    view[1] = 22;
    view[2] = 33;
    let sub = view.subarray(1, 3);
    [sub.length, sub[0], sub[1], sub.byteOffset]
  `);
  assertEquals(result.value, [2, 22, 33, 3]);
});

/**
 * DataView interpreter integration tests.
 *
 * Tests constructor usage, property access, getter/setter methods, and endianness.
 *
 * Run with: deno task test tests/fuel/dataview_interpreter_test.js
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
// DataView Constructor
// =============================================================================

Deno.test("DataView: new DataView(buffer) creates view", () => {
  const result = runCode(`
    let buf = new ArrayBuffer(16);
    let view = new DataView(buf);
    view.byteLength
  `);
  assertEquals(result.value, 16);
});

Deno.test("DataView: new DataView(buffer, byteOffset)", () => {
  const result = runCode(`
    let buf = new ArrayBuffer(16);
    let view = new DataView(buf, 4);
    [view.byteLength, view.byteOffset]
  `);
  assertEquals(result.value, [12, 4]);
});

Deno.test("DataView: new DataView(buffer, byteOffset, byteLength)", () => {
  const result = runCode(`
    let buf = new ArrayBuffer(16);
    let view = new DataView(buf, 4, 8);
    [view.byteLength, view.byteOffset]
  `);
  assertEquals(result.value, [8, 4]);
});

Deno.test("DataView: .buffer property returns ArrayBuffer", () => {
  const result = runCode(`
    let buf = new ArrayBuffer(16);
    let view = new DataView(buf);
    view.buffer === buf
  `);
  assertEquals(result.value, true);
});

Deno.test("DataView: buffer identity preserved across views", () => {
  const result = runCode(`
    let buf = new ArrayBuffer(16);
    let view1 = new DataView(buf);
    let view2 = new DataView(buf, 4);
    view1.buffer === view2.buffer
  `);
  assertEquals(result.value, true);
});

Deno.test("DataView: offset beyond buffer throws RangeError", () => {
  const session = freshSession();
  session.parse(`
    let buf = new ArrayBuffer(10);
    new DataView(buf, 20);
  `);
  assertThrows(() => session.run(0, 10000), UncaughtScriptError);
});

Deno.test("DataView: offset + length beyond buffer throws RangeError", () => {
  const session = freshSession();
  session.parse(`
    let buf = new ArrayBuffer(10);
    new DataView(buf, 5, 10);
  `);
  assertThrows(() => session.run(0, 10000), UncaughtScriptError);
});

// =============================================================================
// 8-bit operations (no endianness)
// =============================================================================

Deno.test("DataView: setInt8/getInt8", () => {
  const result = runCode(`
    let buf = new ArrayBuffer(4);
    let view = new DataView(buf);
    view.setInt8(0, -1);
    view.getInt8(0)
  `);
  assertEquals(result.value, -1);
});

Deno.test("DataView: setUint8/getUint8", () => {
  const result = runCode(`
    let buf = new ArrayBuffer(4);
    let view = new DataView(buf);
    view.setUint8(0, 255);
    view.getUint8(0)
  `);
  assertEquals(result.value, 255);
});

Deno.test("DataView: int8 signed/unsigned conversion", () => {
  const result = runCode(`
    let buf = new ArrayBuffer(4);
    let view = new DataView(buf);
    view.setInt8(0, -1);
    [view.getInt8(0), view.getUint8(0)]
  `);
  assertEquals(result.value, [-1, 255]);
});

// =============================================================================
// 16-bit operations
// =============================================================================

Deno.test("DataView: setInt16/getInt16 big-endian (default)", () => {
  const result = runCode(`
    let buf = new ArrayBuffer(4);
    let view = new DataView(buf);
    view.setInt16(0, 0x1234);
    [view.getInt16(0), view.getUint8(0), view.getUint8(1)]
  `);
  // Big-endian: high byte first
  assertEquals(result.value, [0x1234, 0x12, 0x34]);
});

Deno.test("DataView: setInt16/getInt16 little-endian", () => {
  const result = runCode(`
    let buf = new ArrayBuffer(4);
    let view = new DataView(buf);
    view.setInt16(0, 0x1234, true);
    [view.getInt16(0, true), view.getUint8(0), view.getUint8(1)]
  `);
  // Little-endian: low byte first
  assertEquals(result.value, [0x1234, 0x34, 0x12]);
});

Deno.test("DataView: setUint16/getUint16", () => {
  const result = runCode(`
    let buf = new ArrayBuffer(4);
    let view = new DataView(buf);
    view.setUint16(0, 0xFFFF);
    view.getUint16(0)
  `);
  assertEquals(result.value, 65535);
});

Deno.test("DataView: int16 signed/unsigned conversion", () => {
  const result = runCode(`
    let buf = new ArrayBuffer(4);
    let view = new DataView(buf);
    view.setInt16(0, -1);
    [view.getInt16(0), view.getUint16(0)]
  `);
  assertEquals(result.value, [-1, 65535]);
});

// =============================================================================
// 32-bit operations
// =============================================================================

Deno.test("DataView: setInt32/getInt32 big-endian", () => {
  const result = runCode(`
    let buf = new ArrayBuffer(8);
    let view = new DataView(buf);
    view.setInt32(0, 0x12345678);
    [view.getInt32(0), view.getUint8(0), view.getUint8(1), view.getUint8(2), view.getUint8(3)]
  `);
  // Big-endian: highest byte first
  assertEquals(result.value, [0x12345678, 0x12, 0x34, 0x56, 0x78]);
});

Deno.test("DataView: setInt32/getInt32 little-endian", () => {
  const result = runCode(`
    let buf = new ArrayBuffer(8);
    let view = new DataView(buf);
    view.setInt32(0, 0x12345678, true);
    [view.getInt32(0, true), view.getUint8(0), view.getUint8(1), view.getUint8(2), view.getUint8(3)]
  `);
  // Little-endian: lowest byte first
  assertEquals(result.value, [0x12345678, 0x78, 0x56, 0x34, 0x12]);
});

Deno.test("DataView: setUint32/getUint32", () => {
  const result = runCode(`
    let buf = new ArrayBuffer(8);
    let view = new DataView(buf);
    view.setUint32(0, 0xFFFFFFFF);
    view.getUint32(0)
  `);
  assertEquals(result.value, 4294967295);
});

Deno.test("DataView: int32 signed/unsigned conversion", () => {
  const result = runCode(`
    let buf = new ArrayBuffer(8);
    let view = new DataView(buf);
    view.setInt32(0, -1);
    [view.getInt32(0), view.getUint32(0)]
  `);
  assertEquals(result.value, [-1, 4294967295]);
});

// =============================================================================
// Float32 operations
// =============================================================================

Deno.test("DataView: setFloat32/getFloat32 round-trip", () => {
  const result = runCode(`
    let buf = new ArrayBuffer(8);
    let view = new DataView(buf);
    view.setFloat32(0, 1.5);
    view.getFloat32(0)
  `);
  assertEquals(result.value, 1.5);
});

Deno.test("DataView: setFloat32/getFloat32 little-endian", () => {
  const result = runCode(`
    let buf = new ArrayBuffer(8);
    let view = new DataView(buf);
    view.setFloat32(0, 1.5, true);
    view.getFloat32(0, true)
  `);
  assertEquals(result.value, 1.5);
});

Deno.test("DataView: float32 precision loss", () => {
  // 0.1 cannot be represented exactly in float32
  const result = runCode(`
    let buf = new ArrayBuffer(8);
    let view = new DataView(buf);
    view.setFloat32(0, 0.1);
    let val = view.getFloat32(0);
    val !== 0.1  // Should be different due to precision loss
  `);
  assertEquals(result.value, true);
});

// =============================================================================
// Float64 operations
// =============================================================================

Deno.test("DataView: setFloat64/getFloat64 round-trip", () => {
  const result = runCode(`
    let buf = new ArrayBuffer(16);
    let view = new DataView(buf);
    view.setFloat64(0, 3.141592653589793);
    view.getFloat64(0)
  `);
  assertEquals(result.value, Math.PI);
});

Deno.test("DataView: setFloat64/getFloat64 little-endian", () => {
  const result = runCode(`
    let buf = new ArrayBuffer(16);
    let view = new DataView(buf);
    view.setFloat64(0, 3.141592653589793, true);
    view.getFloat64(0, true)
  `);
  assertEquals(result.value, Math.PI);
});

Deno.test("DataView: float64 preserves precision", () => {
  const result = runCode(`
    let buf = new ArrayBuffer(16);
    let view = new DataView(buf);
    view.setFloat64(0, 0.1);
    view.getFloat64(0) === 0.1
  `);
  assertEquals(result.value, true);
});

// =============================================================================
// Bounds checking
// =============================================================================

Deno.test("DataView: getInt8 bounds check", () => {
  const session = freshSession();
  session.parse(`
    let buf = new ArrayBuffer(4);
    let view = new DataView(buf);
    view.getInt8(4);  // Out of bounds
  `);
  assertThrows(() => session.run(0, 10000), UncaughtScriptError);
});

Deno.test("DataView: getInt16 bounds check", () => {
  const session = freshSession();
  session.parse(`
    let buf = new ArrayBuffer(4);
    let view = new DataView(buf);
    view.getInt16(3);  // offset + 2 > 4
  `);
  assertThrows(() => session.run(0, 10000), UncaughtScriptError);
});

Deno.test("DataView: getInt32 bounds check", () => {
  const session = freshSession();
  session.parse(`
    let buf = new ArrayBuffer(4);
    let view = new DataView(buf);
    view.getInt32(1);  // offset + 4 > 4
  `);
  assertThrows(() => session.run(0, 10000), UncaughtScriptError);
});

Deno.test("DataView: getFloat64 bounds check", () => {
  const session = freshSession();
  session.parse(`
    let buf = new ArrayBuffer(8);
    let view = new DataView(buf);
    view.getFloat64(1);  // offset + 8 > 8
  `);
  assertThrows(() => session.run(0, 10000), UncaughtScriptError);
});

Deno.test("DataView: setInt32 bounds check", () => {
  const session = freshSession();
  session.parse(`
    let buf = new ArrayBuffer(4);
    let view = new DataView(buf);
    view.setInt32(2, 0x12345678);  // offset + 4 > 4
  `);
  assertThrows(() => session.run(0, 10000), UncaughtScriptError);
});

// =============================================================================
// View with offset
// =============================================================================

Deno.test("DataView: operations respect byteOffset", () => {
  const result = runCode(`
    let buf = new ArrayBuffer(16);
    let view1 = new DataView(buf);
    let view2 = new DataView(buf, 4);
    view1.setInt32(4, 0x12345678);
    view2.getInt32(0)  // Should read from buf[4..8]
  `);
  assertEquals(result.value, 0x12345678);
});

Deno.test("DataView: write through offset view", () => {
  const result = runCode(`
    let buf = new ArrayBuffer(16);
    let view1 = new DataView(buf);
    let view2 = new DataView(buf, 4);
    view2.setInt32(0, 0xDEADBEEF);
    view1.getInt32(4)  // Should read from buf[4..8]
  `);
  assertEquals(result.value, 0xDEADBEEF | 0);  // Sign-extend
});

// =============================================================================
// instanceof
// =============================================================================

Deno.test("instanceof: DataView instanceof DataView", () => {
  const result = runCode(`
    let buf = new ArrayBuffer(10);
    let view = new DataView(buf);
    view instanceof DataView
  `);
  assertEquals(result.value, true);
});

Deno.test("instanceof: DataView instanceof Object", () => {
  const result = runCode(`
    let buf = new ArrayBuffer(10);
    let view = new DataView(buf);
    view instanceof Object
  `);
  assertEquals(result.value, true);
});

Deno.test("instanceof: DataView not instanceof ArrayBuffer", () => {
  const result = runCode(`
    let buf = new ArrayBuffer(10);
    let view = new DataView(buf);
    view instanceof ArrayBuffer
  `);
  assertEquals(result.value, false);
});

// =============================================================================
// Mixed Uint8Array and DataView
// =============================================================================

Deno.test("DataView and Uint8Array share buffer", () => {
  const result = runCode(`
    let buf = new ArrayBuffer(16);
    let arr = new Uint8Array(buf);
    let view = new DataView(buf);
    view.setInt32(0, 0x12345678);
    [arr[0], arr[1], arr[2], arr[3]]
  `);
  // Big-endian
  assertEquals(result.value, [0x12, 0x34, 0x56, 0x78]);
});

Deno.test("Uint8Array writes visible through DataView", () => {
  const result = runCode(`
    let buf = new ArrayBuffer(16);
    let arr = new Uint8Array(buf);
    let view = new DataView(buf);
    arr[0] = 0x12;
    arr[1] = 0x34;
    arr[2] = 0x56;
    arr[3] = 0x78;
    view.getInt32(0)
  `);
  assertEquals(result.value, 0x12345678);
});

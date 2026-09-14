/**
 * Tests for all typed array types (except BigInt variants)
 */

import { createSession } from '../../src/fuel/session.js';
import { freshSession } from '../../src/host-owned-session.js';

function run(code) {
  const session = freshSession();
  session.parse(code);
  const result = session.run(0, 10000);
  if (result.status === 'error') {
    throw new Error(result.error.message);
  }
  return session.result(0);
}

// =============================================================================
// Int8Array Tests
// =============================================================================

Deno.test("Int8Array: constructor with length", () => {
  const result = run(`
    let arr = new Int8Array(5);
    arr.length
  `);
  if (result !== 5) throw new Error(`Expected 5, got ${result}`);
});

Deno.test("Int8Array: BYTES_PER_ELEMENT", () => {
  const result = run(`
    let arr = new Int8Array(1);
    arr.BYTES_PER_ELEMENT
  `);
  if (result !== 1) throw new Error(`Expected 1, got ${result}`);
});

Deno.test("Int8Array: byteLength", () => {
  const result = run(`
    let arr = new Int8Array(4);
    arr.byteLength
  `);
  if (result !== 4) throw new Error(`Expected 4, got ${result}`);
});

Deno.test("Int8Array: indexed read/write", () => {
  const result = run(`
    let arr = new Int8Array(3);
    arr[0] = 10;
    arr[1] = 20;
    arr[2] = 30;
    arr[0] + arr[1] + arr[2]
  `);
  if (result !== 60) throw new Error(`Expected 60, got ${result}`);
});

Deno.test("Int8Array: positive overflow wraps to negative", () => {
  const result = run(`
    let arr = new Int8Array(1);
    arr[0] = 128;
    arr[0]
  `);
  if (result !== -128) throw new Error(`Expected -128, got ${result}`);
});

Deno.test("Int8Array: large positive wraps correctly", () => {
  const result = run(`
    let arr = new Int8Array(1);
    arr[0] = 255;
    arr[0]
  `);
  if (result !== -1) throw new Error(`Expected -1, got ${result}`);
});

Deno.test("Int8Array: negative values preserved", () => {
  const result = run(`
    let arr = new Int8Array(1);
    arr[0] = -50;
    arr[0]
  `);
  if (result !== -50) throw new Error(`Expected -50, got ${result}`);
});

Deno.test("Int8Array: min value", () => {
  const result = run(`
    let arr = new Int8Array(1);
    arr[0] = -128;
    arr[0]
  `);
  if (result !== -128) throw new Error(`Expected -128, got ${result}`);
});

Deno.test("Int8Array: max value", () => {
  const result = run(`
    let arr = new Int8Array(1);
    arr[0] = 127;
    arr[0]
  `);
  if (result !== 127) throw new Error(`Expected 127, got ${result}`);
});

// =============================================================================
// Uint8ClampedArray Tests
// =============================================================================

Deno.test("Uint8ClampedArray: constructor with length", () => {
  const result = run(`
    let arr = new Uint8ClampedArray(3);
    arr.length
  `);
  if (result !== 3) throw new Error(`Expected 3, got ${result}`);
});

Deno.test("Uint8ClampedArray: BYTES_PER_ELEMENT", () => {
  const result = run(`
    let arr = new Uint8ClampedArray(1);
    arr.BYTES_PER_ELEMENT
  `);
  if (result !== 1) throw new Error(`Expected 1, got ${result}`);
});

Deno.test("Uint8ClampedArray: clamps high values to 255", () => {
  const result = run(`
    let arr = new Uint8ClampedArray(1);
    arr[0] = 300;
    arr[0]
  `);
  if (result !== 255) throw new Error(`Expected 255, got ${result}`);
});

Deno.test("Uint8ClampedArray: clamps negative values to 0", () => {
  const result = run(`
    let arr = new Uint8ClampedArray(1);
    arr[0] = -50;
    arr[0]
  `);
  if (result !== 0) throw new Error(`Expected 0, got ${result}`);
});

Deno.test("Uint8ClampedArray: normal values preserved", () => {
  const result = run(`
    let arr = new Uint8ClampedArray(1);
    arr[0] = 100;
    arr[0]
  `);
  if (result !== 100) throw new Error(`Expected 100, got ${result}`);
});

Deno.test("Uint8ClampedArray: boundary value 0", () => {
  const result = run(`
    let arr = new Uint8ClampedArray(1);
    arr[0] = 0;
    arr[0]
  `);
  if (result !== 0) throw new Error(`Expected 0, got ${result}`);
});

Deno.test("Uint8ClampedArray: boundary value 255", () => {
  const result = run(`
    let arr = new Uint8ClampedArray(1);
    arr[0] = 255;
    arr[0]
  `);
  if (result !== 255) throw new Error(`Expected 255, got ${result}`);
});

// =============================================================================
// Int16Array Tests
// =============================================================================

Deno.test("Int16Array: constructor with length", () => {
  const result = run(`
    let arr = new Int16Array(4);
    arr.length
  `);
  if (result !== 4) throw new Error(`Expected 4, got ${result}`);
});

Deno.test("Int16Array: BYTES_PER_ELEMENT", () => {
  const result = run(`
    let arr = new Int16Array(1);
    arr.BYTES_PER_ELEMENT
  `);
  if (result !== 2) throw new Error(`Expected 2, got ${result}`);
});

Deno.test("Int16Array: byteLength", () => {
  const result = run(`
    let arr = new Int16Array(4);
    arr.byteLength
  `);
  if (result !== 8) throw new Error(`Expected 8, got ${result}`);
});

Deno.test("Int16Array: indexed read/write", () => {
  const result = run(`
    let arr = new Int16Array(2);
    arr[0] = 1000;
    arr[1] = 2000;
    arr[0] + arr[1]
  `);
  if (result !== 3000) throw new Error(`Expected 3000, got ${result}`);
});

Deno.test("Int16Array: positive overflow wraps", () => {
  const result = run(`
    let arr = new Int16Array(1);
    arr[0] = 32768;
    arr[0]
  `);
  if (result !== -32768) throw new Error(`Expected -32768, got ${result}`);
});

Deno.test("Int16Array: max value", () => {
  const result = run(`
    let arr = new Int16Array(1);
    arr[0] = 32767;
    arr[0]
  `);
  if (result !== 32767) throw new Error(`Expected 32767, got ${result}`);
});

Deno.test("Int16Array: min value", () => {
  const result = run(`
    let arr = new Int16Array(1);
    arr[0] = -32768;
    arr[0]
  `);
  if (result !== -32768) throw new Error(`Expected -32768, got ${result}`);
});

// =============================================================================
// Uint16Array Tests
// =============================================================================

Deno.test("Uint16Array: constructor with length", () => {
  const result = run(`
    let arr = new Uint16Array(3);
    arr.length
  `);
  if (result !== 3) throw new Error(`Expected 3, got ${result}`);
});

Deno.test("Uint16Array: BYTES_PER_ELEMENT", () => {
  const result = run(`
    let arr = new Uint16Array(1);
    arr.BYTES_PER_ELEMENT
  `);
  if (result !== 2) throw new Error(`Expected 2, got ${result}`);
});

Deno.test("Uint16Array: byteLength", () => {
  const result = run(`
    let arr = new Uint16Array(3);
    arr.byteLength
  `);
  if (result !== 6) throw new Error(`Expected 6, got ${result}`);
});

Deno.test("Uint16Array: max value", () => {
  const result = run(`
    let arr = new Uint16Array(1);
    arr[0] = 65535;
    arr[0]
  `);
  if (result !== 65535) throw new Error(`Expected 65535, got ${result}`);
});

Deno.test("Uint16Array: overflow wraps", () => {
  const result = run(`
    let arr = new Uint16Array(1);
    arr[0] = 65536;
    arr[0]
  `);
  if (result !== 0) throw new Error(`Expected 0, got ${result}`);
});

// =============================================================================
// Int32Array Tests
// =============================================================================

Deno.test("Int32Array: constructor with length", () => {
  const result = run(`
    let arr = new Int32Array(3);
    arr.length
  `);
  if (result !== 3) throw new Error(`Expected 3, got ${result}`);
});

Deno.test("Int32Array: BYTES_PER_ELEMENT", () => {
  const result = run(`
    let arr = new Int32Array(1);
    arr.BYTES_PER_ELEMENT
  `);
  if (result !== 4) throw new Error(`Expected 4, got ${result}`);
});

Deno.test("Int32Array: byteLength", () => {
  const result = run(`
    let arr = new Int32Array(3);
    arr.byteLength
  `);
  if (result !== 12) throw new Error(`Expected 12, got ${result}`);
});

Deno.test("Int32Array: large positive value", () => {
  const result = run(`
    let arr = new Int32Array(1);
    arr[0] = 2147483647;
    arr[0]
  `);
  if (result !== 2147483647) throw new Error(`Expected 2147483647, got ${result}`);
});

Deno.test("Int32Array: large negative value", () => {
  const result = run(`
    let arr = new Int32Array(1);
    arr[0] = -2147483648;
    arr[0]
  `);
  if (result !== -2147483648) throw new Error(`Expected -2147483648, got ${result}`);
});

// =============================================================================
// Uint32Array Tests
// =============================================================================

Deno.test("Uint32Array: constructor with length", () => {
  const result = run(`
    let arr = new Uint32Array(2);
    arr.length
  `);
  if (result !== 2) throw new Error(`Expected 2, got ${result}`);
});

Deno.test("Uint32Array: BYTES_PER_ELEMENT", () => {
  const result = run(`
    let arr = new Uint32Array(1);
    arr.BYTES_PER_ELEMENT
  `);
  if (result !== 4) throw new Error(`Expected 4, got ${result}`);
});

Deno.test("Uint32Array: byteLength", () => {
  const result = run(`
    let arr = new Uint32Array(2);
    arr.byteLength
  `);
  if (result !== 8) throw new Error(`Expected 8, got ${result}`);
});

Deno.test("Uint32Array: max value", () => {
  const result = run(`
    let arr = new Uint32Array(1);
    arr[0] = 4294967295;
    arr[0]
  `);
  if (result !== 4294967295) throw new Error(`Expected 4294967295, got ${result}`);
});

// =============================================================================
// Float32Array Tests
// =============================================================================

Deno.test("Float32Array: constructor with length", () => {
  const result = run(`
    let arr = new Float32Array(4);
    arr.length
  `);
  if (result !== 4) throw new Error(`Expected 4, got ${result}`);
});

Deno.test("Float32Array: BYTES_PER_ELEMENT", () => {
  const result = run(`
    let arr = new Float32Array(1);
    arr.BYTES_PER_ELEMENT
  `);
  if (result !== 4) throw new Error(`Expected 4, got ${result}`);
});

Deno.test("Float32Array: byteLength", () => {
  const result = run(`
    let arr = new Float32Array(3);
    arr.byteLength
  `);
  if (result !== 12) throw new Error(`Expected 12, got ${result}`);
});

Deno.test("Float32Array: indexed read/write", () => {
  const result = run(`
    let arr = new Float32Array(2);
    arr[0] = 1.5;
    arr[1] = 2.5;
    arr[0] + arr[1]
  `);
  if (result !== 4) throw new Error(`Expected 4, got ${result}`);
});

Deno.test("Float32Array: precision loss for PI", () => {
  const result = run(`
    let arr = new Float32Array(1);
    arr[0] = 3.141592653589793;
    let diff = arr[0] - 3.141592653589793;
    diff !== 0
  `);
  if (result !== true) throw new Error(`Expected precision loss, got none`);
});

// =============================================================================
// Float64Array Tests
// =============================================================================

Deno.test("Float64Array: constructor with length", () => {
  const result = run(`
    let arr = new Float64Array(3);
    arr.length
  `);
  if (result !== 3) throw new Error(`Expected 3, got ${result}`);
});

Deno.test("Float64Array: BYTES_PER_ELEMENT", () => {
  const result = run(`
    let arr = new Float64Array(1);
    arr.BYTES_PER_ELEMENT
  `);
  if (result !== 8) throw new Error(`Expected 8, got ${result}`);
});

Deno.test("Float64Array: byteLength", () => {
  const result = run(`
    let arr = new Float64Array(2);
    arr.byteLength
  `);
  if (result !== 16) throw new Error(`Expected 16, got ${result}`);
});

Deno.test("Float64Array: indexed read/write", () => {
  const result = run(`
    let arr = new Float64Array(2);
    arr[0] = 1.5;
    arr[1] = 2.5;
    arr[0] + arr[1]
  `);
  if (result !== 4) throw new Error(`Expected 4, got ${result}`);
});

Deno.test("Float64Array: full precision for PI", () => {
  const result = run(`
    let arr = new Float64Array(1);
    arr[0] = 3.141592653589793;
    arr[0] === 3.141592653589793
  `);
  if (result !== true) throw new Error(`Expected full precision`);
});

// =============================================================================
// ArrayBuffer Constructor Tests
// =============================================================================

Deno.test("Int16Array: from ArrayBuffer", () => {
  const result = run(`
    let buf = new ArrayBuffer(8);
    let arr = new Int16Array(buf);
    arr.length
  `);
  if (result !== 4) throw new Error(`Expected 4, got ${result}`);
});

Deno.test("Int32Array: from ArrayBuffer", () => {
  const result = run(`
    let buf = new ArrayBuffer(16);
    let arr = new Int32Array(buf);
    arr.length
  `);
  if (result !== 4) throw new Error(`Expected 4, got ${result}`);
});

Deno.test("Int32Array: from ArrayBuffer with offset", () => {
  const result = run(`
    let buf = new ArrayBuffer(16);
    let arr = new Int32Array(buf, 4);
    arr.length
  `);
  if (result !== 3) throw new Error(`Expected 3, got ${result}`);
});

Deno.test("Int32Array: from ArrayBuffer with offset and length", () => {
  const result = run(`
    let buf = new ArrayBuffer(16);
    let arr = new Int32Array(buf, 4, 2);
    arr.length
  `);
  if (result !== 2) throw new Error(`Expected 2, got ${result}`);
});

Deno.test("Float64Array: from ArrayBuffer", () => {
  const result = run(`
    let buf = new ArrayBuffer(24);
    let arr = new Float64Array(buf);
    arr.length
  `);
  if (result !== 3) throw new Error(`Expected 3, got ${result}`);
});

Deno.test("Float64Array: from ArrayBuffer with offset", () => {
  const result = run(`
    let buf = new ArrayBuffer(24);
    let arr = new Float64Array(buf, 8);
    arr.length
  `);
  if (result !== 2) throw new Error(`Expected 2, got ${result}`);
});

// =============================================================================
// Alignment Tests
// =============================================================================

Deno.test("Int16Array: unaligned offset throws RangeError", () => {
  const result = run(`
    let buf = new ArrayBuffer(16);
    let threw = false;
    try {
      let arr = new Int16Array(buf, 1);
    } catch (e) {
      threw = true;
    }
    threw
  `);
  if (result !== true) throw new Error(`Expected RangeError for unaligned offset`);
});

Deno.test("Int32Array: unaligned offset throws RangeError", () => {
  const result = run(`
    let buf = new ArrayBuffer(16);
    let threw = false;
    try {
      let arr = new Int32Array(buf, 1);
    } catch (e) {
      threw = true;
    }
    threw
  `);
  if (result !== true) throw new Error(`Expected RangeError for unaligned offset`);
});

Deno.test("Int32Array: offset 2 throws RangeError", () => {
  const result = run(`
    let buf = new ArrayBuffer(16);
    let threw = false;
    try {
      let arr = new Int32Array(buf, 2);
    } catch (e) {
      threw = true;
    }
    threw
  `);
  if (result !== true) throw new Error(`Expected RangeError for offset 2`);
});

Deno.test("Float64Array: unaligned offset throws RangeError", () => {
  const result = run(`
    let buf = new ArrayBuffer(24);
    let threw = false;
    try {
      let arr = new Float64Array(buf, 4);
    } catch (e) {
      threw = true;
    }
    threw
  `);
  if (result !== true) throw new Error(`Expected RangeError for offset 4`);
});

Deno.test("Int32Array: aligned offset 4 works", () => {
  const result = run(`
    let buf = new ArrayBuffer(16);
    let arr = new Int32Array(buf, 4);
    arr.length
  `);
  if (result !== 3) throw new Error(`Expected 3, got ${result}`);
});

Deno.test("Float64Array: aligned offset 8 works", () => {
  const result = run(`
    let buf = new ArrayBuffer(24);
    let arr = new Float64Array(buf, 8);
    arr.length
  `);
  if (result !== 2) throw new Error(`Expected 2, got ${result}`);
});

// =============================================================================
// Shared Buffer Tests
// =============================================================================

Deno.test("Shared buffer: Int32Array and Uint8Array view same data", () => {
  const result = run(`
    let buf = new ArrayBuffer(16);
    let i32 = new Int32Array(buf);
    let u8 = new Uint8Array(buf);
    i32[0] = 0x04030201;
    u8[0]
  `);
  if (result !== 1) throw new Error(`Expected 1 (little-endian first byte), got ${result}`);
});

Deno.test("Shared buffer: verify little-endian byte order", () => {
  const result = run(`
    let buf = new ArrayBuffer(4);
    let i32 = new Int32Array(buf);
    let u8 = new Uint8Array(buf);
    i32[0] = 0x04030201;
    u8[0] + u8[1] * 256 + u8[2] * 65536 + u8[3] * 16777216
  `);
  if (result !== 0x04030201) throw new Error(`Expected 0x04030201, got ${result}`);
});

// =============================================================================
// Out of Bounds Tests
// =============================================================================

Deno.test("Int8Array: out of bounds read returns undefined", () => {
  const result = run(`
    let arr = new Int8Array(3);
    arr[10] === undefined
  `);
  if (result !== true) throw new Error(`Expected undefined for out of bounds`);
});

Deno.test("Int32Array: negative index returns undefined", () => {
  const result = run(`
    let arr = new Int32Array(3);
    arr[-1] === undefined
  `);
  if (result !== true) throw new Error(`Expected undefined for negative index`);
});

// =============================================================================
// Empty Array Tests
// =============================================================================

Deno.test("Int8Array: empty constructor", () => {
  const result = run(`
    let arr = new Int8Array();
    arr.length
  `);
  if (result !== 0) throw new Error(`Expected 0, got ${result}`);
});

Deno.test("Float64Array: empty constructor", () => {
  const result = run(`
    let arr = new Float64Array();
    arr.length
  `);
  if (result !== 0) throw new Error(`Expected 0, got ${result}`);
});

// =============================================================================
// .buffer Property Tests
// =============================================================================

Deno.test("Int16Array: .buffer returns ArrayBuffer", () => {
  const result = run(`
    let arr = new Int16Array(4);
    arr.buffer.byteLength
  `);
  if (result !== 8) throw new Error(`Expected 8, got ${result}`);
});

Deno.test("Float64Array: .buffer returns ArrayBuffer", () => {
  const result = run(`
    let arr = new Float64Array(2);
    arr.buffer.byteLength
  `);
  if (result !== 16) throw new Error(`Expected 16, got ${result}`);
});

// =============================================================================
// .byteOffset Property Tests
// =============================================================================

Deno.test("Int32Array: byteOffset is 0 for new array", () => {
  const result = run(`
    let arr = new Int32Array(4);
    arr.byteOffset
  `);
  if (result !== 0) throw new Error(`Expected 0, got ${result}`);
});

Deno.test("Int32Array: byteOffset reflects ArrayBuffer offset", () => {
  const result = run(`
    let buf = new ArrayBuffer(16);
    let arr = new Int32Array(buf, 8);
    arr.byteOffset
  `);
  if (result !== 8) throw new Error(`Expected 8, got ${result}`);
});

// =============================================================================
// Method Tests - forEach
// =============================================================================

Deno.test("Int16Array: forEach iterates all elements", () => {
  const result = run(`
    let arr = new Int16Array(3);
    arr[0] = 10; arr[1] = 20; arr[2] = 30;
    let sum = 0;
    arr.forEach((x) => { sum = sum + x; });
    sum
  `);
  if (result !== 60) throw new Error(`Expected 60, got ${result}`);
});

Deno.test("Float32Array: forEach with index", () => {
  const result = run(`
    let arr = new Float32Array(3);
    arr[0] = 1.5; arr[1] = 2.5; arr[2] = 3.5;
    let sum = 0;
    arr.forEach((x, i) => { sum = sum + i; });
    sum
  `);
  if (result !== 3) throw new Error(`Expected 3, got ${result}`);
});

// =============================================================================
// Method Tests - map
// =============================================================================

Deno.test("Int16Array: map doubles values", () => {
  const result = run(`
    let arr = new Int16Array(3);
    arr[0] = 10; arr[1] = 20; arr[2] = 30;
    let mapped = arr.map((x) => x * 2);
    mapped[0] + mapped[1] + mapped[2]
  `);
  if (result !== 120) throw new Error(`Expected 120, got ${result}`);
});

Deno.test("Int16Array: map returns same type", () => {
  const result = run(`
    let arr = new Int16Array(2);
    arr[0] = 100; arr[1] = 200;
    let mapped = arr.map((x) => x + 1);
    mapped.BYTES_PER_ELEMENT
  `);
  if (result !== 2) throw new Error(`Expected 2 (Int16Array), got ${result}`);
});

Deno.test("Float64Array: map preserves precision", () => {
  const result = run(`
    let arr = new Float64Array(1);
    arr[0] = 3.141592653589793;
    let mapped = arr.map((x) => x);
    mapped[0] === 3.141592653589793
  `);
  if (result !== true) throw new Error(`Expected precision preserved`);
});

// =============================================================================
// Method Tests - filter
// =============================================================================

Deno.test("Int32Array: filter keeps matching elements", () => {
  const result = run(`
    let arr = new Int32Array(4);
    arr[0] = 10; arr[1] = 25; arr[2] = 30; arr[3] = 15;
    let filtered = arr.filter((x) => x > 20);
    filtered.length
  `);
  if (result !== 2) throw new Error(`Expected 2, got ${result}`);
});

Deno.test("Int32Array: filter returns same type", () => {
  const result = run(`
    let arr = new Int32Array(4);
    arr[0] = 10; arr[1] = 25; arr[2] = 30; arr[3] = 15;
    let filtered = arr.filter((x) => x > 20);
    filtered.BYTES_PER_ELEMENT
  `);
  if (result !== 4) throw new Error(`Expected 4 (Int32Array), got ${result}`);
});

// =============================================================================
// Method Tests - reduce
// =============================================================================

Deno.test("Uint16Array: reduce sums values", () => {
  const result = run(`
    let arr = new Uint16Array(4);
    arr[0] = 100; arr[1] = 200; arr[2] = 300; arr[3] = 400;
    arr.reduce((acc, x) => acc + x, 0)
  `);
  if (result !== 1000) throw new Error(`Expected 1000, got ${result}`);
});

Deno.test("Float32Array: reduce with index", () => {
  const result = run(`
    let arr = new Float32Array(3);
    arr[0] = 1; arr[1] = 2; arr[2] = 3;
    arr.reduce((acc, x, i) => acc + i, 0)
  `);
  if (result !== 3) throw new Error(`Expected 3, got ${result}`);
});

// =============================================================================
// Method Tests - find/findIndex
// =============================================================================

Deno.test("Int8Array: find returns first match", () => {
  const result = run(`
    let arr = new Int8Array(4);
    arr[0] = 5; arr[1] = 10; arr[2] = 15; arr[3] = 20;
    arr.find((x) => x > 12)
  `);
  if (result !== 15) throw new Error(`Expected 15, got ${result}`);
});

Deno.test("Uint32Array: findIndex returns correct index", () => {
  const result = run(`
    let arr = new Uint32Array(4);
    arr[0] = 5; arr[1] = 10; arr[2] = 15; arr[3] = 20;
    arr.findIndex((x) => x > 12)
  `);
  if (result !== 2) throw new Error(`Expected 2, got ${result}`);
});

// =============================================================================
// Method Tests - every/some
// =============================================================================

Deno.test("Int16Array: every returns true when all match", () => {
  const result = run(`
    let arr = new Int16Array(3);
    arr[0] = 10; arr[1] = 20; arr[2] = 30;
    arr.every((x) => x > 0)
  `);
  if (result !== true) throw new Error(`Expected true, got ${result}`);
});

Deno.test("Int16Array: every returns false when one doesn't match", () => {
  const result = run(`
    let arr = new Int16Array(3);
    arr[0] = 10; arr[1] = -5; arr[2] = 30;
    arr.every((x) => x > 0)
  `);
  if (result !== false) throw new Error(`Expected false, got ${result}`);
});

Deno.test("Float64Array: some returns true when one matches", () => {
  const result = run(`
    let arr = new Float64Array(3);
    arr[0] = 1.5; arr[1] = 2.5; arr[2] = 10.5;
    arr.some((x) => x > 5)
  `);
  if (result !== true) throw new Error(`Expected true, got ${result}`);
});

Deno.test("Float64Array: some returns false when none match", () => {
  const result = run(`
    let arr = new Float64Array(3);
    arr[0] = 1.5; arr[1] = 2.5; arr[2] = 3.5;
    arr.some((x) => x > 5)
  `);
  if (result !== false) throw new Error(`Expected false, got ${result}`);
});

// =============================================================================
// Method Tests - indexOf/includes
// =============================================================================

Deno.test("Int32Array: indexOf finds element", () => {
  const result = run(`
    let arr = new Int32Array(4);
    arr[0] = 100; arr[1] = 200; arr[2] = 300; arr[3] = 200;
    arr.indexOf(200)
  `);
  if (result !== 1) throw new Error(`Expected 1, got ${result}`);
});

Deno.test("Int32Array: indexOf returns -1 when not found", () => {
  const result = run(`
    let arr = new Int32Array(3);
    arr[0] = 100; arr[1] = 200; arr[2] = 300;
    arr.indexOf(999)
  `);
  if (result !== -1) throw new Error(`Expected -1, got ${result}`);
});

Deno.test("Uint8ClampedArray: includes returns true when found", () => {
  const result = run(`
    let arr = new Uint8ClampedArray(3);
    arr[0] = 10; arr[1] = 20; arr[2] = 30;
    arr.includes(20)
  `);
  if (result !== true) throw new Error(`Expected true, got ${result}`);
});

Deno.test("Uint8ClampedArray: includes returns false when not found", () => {
  const result = run(`
    let arr = new Uint8ClampedArray(3);
    arr[0] = 10; arr[1] = 20; arr[2] = 30;
    arr.includes(99)
  `);
  if (result !== false) throw new Error(`Expected false, got ${result}`);
});

// =============================================================================
// Method Tests - fill
// =============================================================================

Deno.test("Int16Array: fill sets all elements", () => {
  const result = run(`
    let arr = new Int16Array(4);
    arr.fill(42);
    arr[0] + arr[1] + arr[2] + arr[3]
  `);
  if (result !== 168) throw new Error(`Expected 168, got ${result}`);
});

Deno.test("Float32Array: fill with range", () => {
  const result = run(`
    let arr = new Float32Array(5);
    arr.fill(1.5, 1, 4);
    arr[0] + arr[1] + arr[2] + arr[3] + arr[4]
  `);
  if (result !== 4.5) throw new Error(`Expected 4.5, got ${result}`);
});

// =============================================================================
// Method Tests - reverse
// =============================================================================

Deno.test("Int8Array: reverse inverts order", () => {
  const result = run(`
    let arr = new Int8Array(4);
    arr[0] = 1; arr[1] = 2; arr[2] = 3; arr[3] = 4;
    arr.reverse();
    arr[0] * 1000 + arr[1] * 100 + arr[2] * 10 + arr[3]
  `);
  if (result !== 4321) throw new Error(`Expected 4321, got ${result}`);
});

// =============================================================================
// Method Tests - slice
// =============================================================================

Deno.test("Int32Array: slice creates copy", () => {
  const result = run(`
    let arr = new Int32Array(4);
    arr[0] = 10; arr[1] = 20; arr[2] = 30; arr[3] = 40;
    let sliced = arr.slice(1, 3);
    sliced.length
  `);
  if (result !== 2) throw new Error(`Expected 2, got ${result}`);
});

Deno.test("Int32Array: slice returns same type", () => {
  const result = run(`
    let arr = new Int32Array(4);
    arr[0] = 10; arr[1] = 20; arr[2] = 30; arr[3] = 40;
    let sliced = arr.slice(1, 3);
    sliced.BYTES_PER_ELEMENT
  `);
  if (result !== 4) throw new Error(`Expected 4, got ${result}`);
});

// =============================================================================
// Method Tests - subarray
// =============================================================================

Deno.test("Float64Array: subarray creates view", () => {
  const result = run(`
    let arr = new Float64Array(4);
    arr[0] = 1.1; arr[1] = 2.2; arr[2] = 3.3; arr[3] = 4.4;
    let sub = arr.subarray(1, 3);
    sub.length
  `);
  if (result !== 2) throw new Error(`Expected 2, got ${result}`);
});

Deno.test("Float64Array: subarray shares buffer", () => {
  const result = run(`
    let arr = new Float64Array(4);
    arr[0] = 1.1; arr[1] = 2.2; arr[2] = 3.3; arr[3] = 4.4;
    let sub = arr.subarray(1, 3);
    sub[0] = 99.9;
    arr[1]
  `);
  if (result !== 99.9) throw new Error(`Expected 99.9, got ${result}`);
});

// =============================================================================
// Method Tests - join
// =============================================================================

Deno.test("Int16Array: join creates string", () => {
  const result = run(`
    let arr = new Int16Array(3);
    arr[0] = 10; arr[1] = 20; arr[2] = 30;
    arr.join(',')
  `);
  if (result !== '10,20,30') throw new Error(`Expected '10,20,30', got ${result}`);
});

// =============================================================================
// Static from / of — numeric element reads
// (used to accept only TYPE_FLOAT elements, silently zero-filling for
// integer literals, which are inline Rationals under the number tower)
// =============================================================================

Deno.test("Uint8Array.from: array of integer literals", () => {
  const result = run(`
    let arr = Uint8Array.from([1, 2, 3]);
    arr[0] + arr[1] * 10 + arr[2] * 100
  `);
  if (result !== 321) throw new Error(`Expected 321, got ${result}`);
});

Deno.test("Uint8Array.of: integer literal arguments", () => {
  const result = run(`
    let arr = Uint8Array.of(4, 5);
    arr[0] + arr[1] * 10
  `);
  if (result !== 54) throw new Error(`Expected 54, got ${result}`);
});

Deno.test("Float64Array.from: float literals survive", () => {
  const result = run(`
    let arr = Float64Array.from([0.5, 1.5]);
    arr[0] + arr[1]
  `);
  if (result !== 2) throw new Error(`Expected 2, got ${result}`);
});

Deno.test("Int32Array.from: elements read back from another typed array", () => {
  const result = run(`
    let src = new Int32Array(2);
    src[0] = -7; src[1] = 9;
    let arr = Int32Array.from([src[0], src[1]]);
    arr[0] + arr[1]
  `);
  if (result !== 2) throw new Error(`Expected 2, got ${result}`);
});

Deno.test("Int16Array.of: negative integer argument", () => {
  const result = run(`
    let arr = Int16Array.of(-3);
    arr[0]
  `);
  if (result !== -3) throw new Error(`Expected -3, got ${result}`);
});

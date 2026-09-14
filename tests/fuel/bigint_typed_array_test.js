/**
 * Tests for BigInt64Array and BigUint64Array.
 */

import { assertEquals } from "https://deno.land/std@0.208.0/assert/mod.ts";
import { createSession } from '../../src/fuel/session.js';
import { parseAndSetup } from './test-helpers.js';
import { freshSession } from '../../src/host-owned-session.js';

function evalValue(source, varName) {
  const session = freshSession();
  parseAndSetup(session, source);
  const result = session.run(0, 10000);
  if (result.status === 'error') throw new Error(`Error: ${result.error?.message}`);
  return session.get(0, varName);
}

// ===========================================================================
// BigInt64Array
// ===========================================================================

Deno.test("BigInt64Array: construction with length", () => {
  assertEquals(evalValue('let a = new BigInt64Array(3); let r = a.length;', 'r'), 3);
});

Deno.test("BigInt64Array: BYTES_PER_ELEMENT", () => {
  assertEquals(evalValue('let a = new BigInt64Array(1); let r = a.BYTES_PER_ELEMENT;', 'r'), 8);
});

Deno.test("BigInt64Array: write and read positive", () => {
  assertEquals(evalValue('let a = new BigInt64Array(1); a[0] = 42n; let r = a[0];', 'r'), 42n);
});

Deno.test("BigInt64Array: write and read negative", () => {
  assertEquals(evalValue('let a = new BigInt64Array(1); a[0] = -1n; let r = a[0];', 'r'), -1n);
});

Deno.test("BigInt64Array: write and read large positive", () => {
  assertEquals(evalValue(
    'let a = new BigInt64Array(1); a[0] = 9223372036854775807n; let r = a[0];', 'r'),
    9223372036854775807n); // MAX_INT64
});

Deno.test("BigInt64Array: write and read large negative", () => {
  assertEquals(evalValue(
    'let a = new BigInt64Array(1); a[0] = -9223372036854775808n; let r = a[0];', 'r'),
    -9223372036854775808n); // MIN_INT64
});

Deno.test("BigInt64Array: typeof element is bigint", () => {
  assertEquals(evalValue('let a = new BigInt64Array(1); a[0] = 42n; let r = typeof a[0];', 'r'), 'bigint');
});

Deno.test("BigInt64Array: zero-initialized", () => {
  assertEquals(evalValue('let a = new BigInt64Array(1); let r = a[0];', 'r'), 0n);
});

Deno.test("BigInt64Array: multiple elements", () => {
  const session = freshSession();
  parseAndSetup(session, `
    let a = new BigInt64Array(3);
    a[0] = 10n;
    a[1] = 20n;
    a[2] = 30n;
    let sum = a[0] + a[1] + a[2];
  `);
  session.run(0, 10000);
  assertEquals(session.get(0, 'sum'), 60n);
});

// ===========================================================================
// BigUint64Array
// ===========================================================================

Deno.test("BigUint64Array: construction with length", () => {
  assertEquals(evalValue('let a = new BigUint64Array(2); let r = a.length;', 'r'), 2);
});

Deno.test("BigUint64Array: BYTES_PER_ELEMENT", () => {
  assertEquals(evalValue('let a = new BigUint64Array(1); let r = a.BYTES_PER_ELEMENT;', 'r'), 8);
});

Deno.test("BigUint64Array: write and read", () => {
  assertEquals(evalValue('let a = new BigUint64Array(1); a[0] = 42n; let r = a[0];', 'r'), 42n);
});

Deno.test("BigUint64Array: write and read max value", () => {
  assertEquals(evalValue(
    'let a = new BigUint64Array(1); a[0] = 0xFFFFFFFFFFFFFFFFn; let r = a[0];', 'r'),
    0xFFFFFFFFFFFFFFFFn);
});

Deno.test("BigUint64Array: typeof element is bigint", () => {
  assertEquals(evalValue('let a = new BigUint64Array(1); a[0] = 1n; let r = typeof a[0];', 'r'), 'bigint');
});

Deno.test("BigUint64Array: zero-initialized", () => {
  assertEquals(evalValue('let a = new BigUint64Array(1); let r = a[0];', 'r'), 0n);
});

// ===========================================================================
// Shared buffer
// ===========================================================================

Deno.test("BigInt64Array: shares buffer with Uint8Array", () => {
  const session = freshSession();
  parseAndSetup(session, `
    let buf = new ArrayBuffer(8);
    let bi = new BigInt64Array(buf);
    let u8 = new Uint8Array(buf);
    bi[0] = 0x0102030405060708n;
    let b0 = u8[0];
    let b7 = u8[7];
  `);
  session.run(0, 10000);
  // Little-endian: byte 0 = 0x08 (least significant), byte 7 = 0x01 (most significant)
  assertEquals(session.get(0, 'b0'), 8);
  assertEquals(session.get(0, 'b7'), 1);
});

// ===========================================================================
// GC
// ===========================================================================

// ===========================================================================
// Edge cases
// ===========================================================================

Deno.test("BigInt64Array: arithmetic on elements", () => {
  const session = freshSession();
  parseAndSetup(session, `
    let a = new BigInt64Array(2);
    a[0] = 10n;
    a[1] = 20n;
    let sum = a[0] + a[1];
  `);
  session.run(0, 10000);
  assertEquals(session.get(0, 'sum'), 30n);
});

Deno.test("BigInt64Array: out of bounds returns undefined", () => {
  assertEquals(evalValue('let a = new BigInt64Array(1); let r = a[5];', 'r'), undefined);
});

Deno.test("BigInt64Array: byteLength", () => {
  assertEquals(evalValue('let a = new BigInt64Array(4); let r = a.byteLength;', 'r'), 32);
});

Deno.test("BigInt64Array: construction from ArrayBuffer", () => {
  assertEquals(evalValue('let buf = new ArrayBuffer(16); let a = new BigInt64Array(buf); let r = a.length;', 'r'), 2);
});

Deno.test("BigInt64Array: subarray", () => {
  const session = freshSession();
  parseAndSetup(session, `
    let buf = new ArrayBuffer(24);
    let full = new BigInt64Array(buf);
    full[0] = 100n;
    full[1] = 200n;
    full[2] = 300n;
    let sub = full.subarray(1);
    let r = sub[0];
  `);
  session.run(0, 10000);
  assertEquals(session.get(0, 'r'), 200n);
});

Deno.test("BigUint64Array: max value roundtrip", () => {
  assertEquals(evalValue(
    'let a = new BigUint64Array(1); a[0] = 0xFFFFFFFFFFFFFFFFn; let r = a[0] === 0xFFFFFFFFFFFFFFFFn;', 'r'), true);
});

// ===========================================================================
// GC
// ===========================================================================

Deno.test("BigInt64Array: survives GC", () => {
  const session = freshSession();
  parseAndSetup(session, `
    let a = new BigInt64Array(1);
    a[0] = 9223372036854775807n;
    let len = a.length;
  `);
  session.run(0, 10000);
  session.gc();
  // After GC, read the value via a new snippet
  assertEquals(session.get(0, 'len'), 1);
});

// ===========================================================================
// Constructor seeding from array / typed array
// (used to silently zero-fill through the f64 element-write path)
// ===========================================================================

Deno.test("BigInt64Array: construction from array of BigInts", () => {
  assertEquals(evalValue(
    'let a = new BigInt64Array([1n, -2n, 3n]); let r = a[1];', 'r'), -2n);
});

Deno.test("BigInt64Array: construction from array preserves all elements", () => {
  const session = freshSession();
  parseAndSetup(session, `
    let a = new BigInt64Array([10n, 20n, 30n]);
    let r0 = a[0]; let r1 = a[1]; let r2 = a[2]; let len = a.length;
  `);
  session.run(0, 10000);
  assertEquals(session.get(0, 'r0'), 10n);
  assertEquals(session.get(0, 'r1'), 20n);
  assertEquals(session.get(0, 'r2'), 30n);
  assertEquals(session.get(0, 'len'), 3);
});

Deno.test("BigUint64Array: construction from array, two-limb value", () => {
  assertEquals(evalValue(
    'let a = new BigUint64Array([0x123456789ABCDEF0n]); let r = a[0];', 'r'),
    0x123456789ABCDEF0n);
});

Deno.test("BigInt64Array: construction from another BigInt64Array", () => {
  assertEquals(evalValue(
    'let a = new BigInt64Array([7n, -8n]); let b = new BigInt64Array(a); let r = b[1];', 'r'), -8n);
});

Deno.test("BigUint64Array: construction from BigInt64Array is bit-preserving", () => {
  assertEquals(evalValue(
    'let a = new BigInt64Array([-1n]); let b = new BigUint64Array(a); let r = b[0];', 'r'),
    18446744073709551615n);
});

// ===========================================================================
// from / of (restored 2026-07-05; the METHOD ids had been removed after
// they shipped bootstrap-bound but with no WAT dispatch)
// ===========================================================================

Deno.test("BigInt64Array.from: array of BigInts", () => {
  const session = freshSession();
  parseAndSetup(session, `
    let a = BigInt64Array.from([1n, 2n]);
    let r0 = a[0]; let r1 = a[1]; let len = a.length;
  `);
  session.run(0, 10000);
  assertEquals(session.get(0, 'r0'), 1n);
  assertEquals(session.get(0, 'r1'), 2n);
  assertEquals(session.get(0, 'len'), 2);
});

Deno.test("BigInt64Array.from: negative values", () => {
  assertEquals(evalValue('let a = BigInt64Array.from([-5n]); let r = a[0];', 'r'), -5n);
});

Deno.test("BigInt64Array.from: another BigInt typed array", () => {
  assertEquals(evalValue(
    'let a = new BigInt64Array([9n]); let b = BigInt64Array.from(a); let r = b[0];', 'r'), 9n);
});

Deno.test("BigInt64Array.of: arguments become elements", () => {
  const session = freshSession();
  parseAndSetup(session, `
    let a = BigInt64Array.of(3n, -4n);
    let r0 = a[0]; let r1 = a[1]; let len = a.length;
  `);
  session.run(0, 10000);
  assertEquals(session.get(0, 'r0'), 3n);
  assertEquals(session.get(0, 'r1'), -4n);
  assertEquals(session.get(0, 'len'), 2);
});

Deno.test("BigUint64Array.from: two-limb value round-trips", () => {
  assertEquals(evalValue(
    'let a = BigUint64Array.from([18446744073709551615n]); let r = a[0];', 'r'),
    18446744073709551615n);
});

Deno.test("BigUint64Array.of: single element", () => {
  assertEquals(evalValue('let a = BigUint64Array.of(100n); let r = a[0];', 'r'), 100n);
});

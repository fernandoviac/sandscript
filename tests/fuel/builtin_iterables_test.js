/**
 * Slice 3 — built-in iterables (arrays, strings, typed arrays).
 *
 * Verifies that `for (x of <built-in>)` works without the user having
 * to hand-write an iterable, by routing primitive symbol-keyed access
 * through the relevant *.prototype object.
 */

import { assertEquals } from "https://deno.land/std@0.208.0/assert/mod.ts";
import { parseAndSetup } from './test-helpers.js';
import { freshSession } from '../../src/host-owned-session.js';

function run(source) {
  const session = freshSession();
  parseAndSetup(session, source);
  const result = session.run(0, 10_000_000);
  if (result.status === 'error') {
    throw new Error(`Error: ${result.error.message}`);
  }
  return session;
}

// =============================================================================
// Array iteration
// =============================================================================

Deno.test("array iter: for-of over [1, 2, 3] yields each element", () => {
  const session = run(`
    let total = 0;
    for (let x of [10, 20, 30]) { total = total + x; }
  `);
  assertEquals(session.get(0, 'total'), 60);
});

Deno.test("array iter: empty array iterates zero times", () => {
  const session = run(`
    let entered = false;
    for (let x of []) { entered = true; }
  `);
  assertEquals(session.get(0, 'entered'), false);
});

Deno.test("array iter: explicit arr[Symbol.iterator]() + manual .next()", () => {
  const session = run(`
    let arr = [7, 8];
    let iter = arr[Symbol.iterator]();
    let a = iter.next();
    let b = iter.next();
    let c = iter.next();
    let a_val = a.value; let a_done = a.done;
    let b_val = b.value; let b_done = b.done;
    let c_val = c.value; let c_done = c.done;
  `);
  assertEquals(session.get(0, 'a_val'), 7);
  assertEquals(session.get(0, 'a_done'), false);
  assertEquals(session.get(0, 'b_val'), 8);
  assertEquals(session.get(0, 'b_done'), false);
  assertEquals(session.get(0, 'c_done'), true);
});

Deno.test("array iter: works with mixed-type elements", () => {
  const session = run(`
    let s = '';
    for (let x of [1, 'a', true, null]) { s = s + String(x) + '|'; }
  `);
  assertEquals(session.get(0, 's'), '1|a|true|null|');
});

Deno.test("array iter: nested for-of (Cartesian-product feel)", () => {
  const session = run(`
    let sum = 0;
    for (let a of [1, 2, 3]) {
      for (let b of [10, 20]) {
        sum = sum + a * b;
      }
    }
  `);
  // (1+2+3) * (10+20) = 6 * 30 = 180
  assertEquals(session.get(0, 'sum'), 180);
});

Deno.test("array iter: break/continue inside for-of of array literal", () => {
  const session = run(`
    let collected = '';
    for (let x of [1, 2, 3, 4, 5]) {
      if (x === 4) break;
      if (x === 2) continue;
      collected = collected + x;
    }
  `);
  assertEquals(session.get(0, 'collected'), '13');
});

Deno.test("array iter: mutation during iteration follows JS semantics (live length)", () => {
  // Pushing during iteration extends the loop; the iterator reads
  // arr.length on every step, so newly-pushed elements are visited.
  const session = run(`
    let arr = [1, 2];
    let seen = 0;
    for (let x of arr) {
      seen = seen + 1;
      if (seen === 1) arr.push(3);  // appears in iteration
      if (seen === 3) arr.push(4);  // also appears
      if (seen >= 5) break;          // guard against runaway
    }
  `);
  assertEquals(session.get(0, 'seen'), 4);
});

// =============================================================================
// String iteration (UTF-8 code points)
// =============================================================================

Deno.test("string iter: ASCII string yields code points one by one", () => {
  const session = run(`
    let joined = '';
    for (let c of 'abc') { joined = joined + c + '-'; }
  `);
  assertEquals(session.get(0, 'joined'), 'a-b-c-');
});

Deno.test("string iter: empty string yields zero", () => {
  const session = run(`
    let entered = false;
    for (let c of '') { entered = true; }
  `);
  assertEquals(session.get(0, 'entered'), false);
});

Deno.test("string iter: multi-byte code point yields as a single string", () => {
  // U+1F600 (😀) is 4 bytes in UTF-8; surrogate-pair-aware iteration
  // must yield it as one element, not two.
  const session = run(`
    let parts = [];
    for (let c of 'a\u{1F600}b') { parts[parts.length] = c; }
    let count = parts.length;
    let p0 = parts[0];
    let p1 = parts[1];
    let p2 = parts[2];
  `);
  assertEquals(session.get(0, 'count'), 3);
  assertEquals(session.get(0, 'p0'), 'a');
  assertEquals(session.get(0, 'p1'), '\u{1F600}');
  assertEquals(session.get(0, 'p2'), 'b');
});

Deno.test("string iter: 2-byte code point (Latin-1 supplement)", () => {
  // ñ (U+00F1) is 2 bytes in UTF-8.
  const session = run(`
    let parts = [];
    for (let c of 'mañana') { parts[parts.length] = c; }
    let count = parts.length;
    let p1 = parts[1];
  `);
  assertEquals(session.get(0, 'count'), 6);  // m, a, ñ, a, n, a
  assertEquals(session.get(0, 'p1'), 'a');
});

Deno.test("string iter: 3-byte code point (CJK)", () => {
  // 中 (U+4E2D) is 3 bytes in UTF-8.
  const session = run(`
    let parts = [];
    for (let c of '中文') { parts[parts.length] = c; }
    let count = parts.length;
    let p0 = parts[0];
    let p1 = parts[1];
  `);
  assertEquals(session.get(0, 'count'), 2);
  assertEquals(session.get(0, 'p0'), '中');
  assertEquals(session.get(0, 'p1'), '文');
});

Deno.test("string iter: explicit str[Symbol.iterator]() + manual .next()", () => {
  const session = run(`
    let iter = 'hi'[Symbol.iterator]();
    let a = iter.next();
    let b = iter.next();
    let c = iter.next();
    let a_val = a.value; let a_done = a.done;
    let b_val = b.value; let b_done = b.done;
    let c_done = c.done;
  `);
  assertEquals(session.get(0, 'a_val'), 'h');
  assertEquals(session.get(0, 'a_done'), false);
  assertEquals(session.get(0, 'b_val'), 'i');
  assertEquals(session.get(0, 'b_done'), false);
  assertEquals(session.get(0, 'c_done'), true);
});

// =============================================================================
// Uint8Array iteration
// =============================================================================

Deno.test("uint8array iter: yields each byte as a number", () => {
  const session = run(`
    let total = 0;
    for (let b of new Uint8Array([10, 20, 30, 40])) { total = total + b; }
  `);
  assertEquals(session.get(0, 'total'), 100);
});

Deno.test("uint8array iter: empty Uint8Array iterates zero times", () => {
  const session = run(`
    let entered = false;
    for (let b of new Uint8Array(0)) { entered = true; }
  `);
  assertEquals(session.get(0, 'entered'), false);
});

Deno.test("uint8array iter: explicit Symbol.iterator() invocation works", () => {
  const session = run(`
    let buf = new Uint8Array([5, 6, 7]);
    let iter = buf[Symbol.iterator]();
    let a = iter.next();
    let b = iter.next();
    let c = iter.next();
    let d = iter.next();
    let a_val = a.value;
    let b_val = b.value;
    let c_val = c.value;
    let d_done = d.done;
  `);
  assertEquals(session.get(0, 'a_val'), 5);
  assertEquals(session.get(0, 'b_val'), 6);
  assertEquals(session.get(0, 'c_val'), 7);
  assertEquals(session.get(0, 'd_done'), true);
});

// =============================================================================
// Other typed arrays
// =============================================================================

Deno.test("int16array iter: yields each element (sign-extended)", () => {
  const session = run(`
    let buf = new Int16Array([-3, 0, 5]);
    let total = 0;
    for (let v of buf) { total = total + v; }
  `);
  assertEquals(session.get(0, 'total'), 2);  // -3 + 0 + 5
});

Deno.test("float32array iter: yields each element as a number", () => {
  const session = run(`
    let buf = new Float32Array([0.5, 1.5, 2.0]);
    let total = 0;
    for (let v of buf) { total = total + v; }
  `);
  assertEquals(session.get(0, 'total'), 4);
});

Deno.test("uint32array iter: roundtrips through Symbol.iterator", () => {
  const session = run(`
    let buf = new Uint32Array([100, 200, 300]);
    let parts = [];
    for (let v of buf) { parts[parts.length] = v; }
    let p0 = parts[0];
    let p1 = parts[1];
    let p2 = parts[2];
    let count = parts.length;
  `);
  assertEquals(session.get(0, 'p0'), 100);
  assertEquals(session.get(0, 'p1'), 200);
  assertEquals(session.get(0, 'p2'), 300);
  assertEquals(session.get(0, 'count'), 3);
});

// =============================================================================
// Sanity: prototype identity
// =============================================================================

Deno.test("Array.prototype[Symbol.iterator] is a function (returns iterator when called)", () => {
  const session = run(`
    let iter = [1, 2][Symbol.iterator]();
    let kind = typeof iter;
    let hasNext = typeof iter.next;
  `);
  assertEquals(session.get(0, 'kind'), 'object');
  assertEquals(session.get(0, 'hasNext'), 'function');
});

Deno.test("String.prototype[Symbol.iterator] returns an iterator on a string", () => {
  const session = run(`
    let iter = 'x'[Symbol.iterator]();
    let kind = typeof iter;
  `);
  assertEquals(session.get(0, 'kind'), 'object');
});

// =============================================================================
// BigInt typed-array iteration (elements used to iterate as undefined)
// =============================================================================

Deno.test("bigint64array iter: yields each element as a BigInt", () => {
  const session = run(`
    let total = 0n;
    for (let v of new BigInt64Array([1n, 2n, 3n])) { total = total + v; }
  `);
  assertEquals(session.get(0, 'total'), 6n);
});

Deno.test("bigint64array iter: negatives round-trip", () => {
  const session = run(`
    let parts = [];
    for (let v of new BigInt64Array([-1n, 0n, 1n])) {
      parts[parts.length] = v;
    }
    let a = parts[0]; let b = parts[1]; let c = parts[2];
  `);
  assertEquals(session.get(0, 'a'), -1n);
  assertEquals(session.get(0, 'b'), 0n);
  assertEquals(session.get(0, 'c'), 1n);
});

Deno.test("biguint64array iter: yields each element as a BigInt", () => {
  const session = run(`
    let buf = new BigUint64Array([100n, 200n]);
    let total = 0n;
    for (let v of buf) { total = total + v; }
  `);
  assertEquals(session.get(0, 'total'), 300n);
});

Deno.test("biguint64array iter: large values above 2^32 round-trip", () => {
  // The two-limb path: high 32 bits non-zero.
  const session = run(`
    let buf = new BigUint64Array([0x123456789ABCDEF0n]);
    let v;
    for (let x of buf) { v = x; }
  `);
  assertEquals(session.get(0, 'v'), 0x123456789ABCDEF0n);
});

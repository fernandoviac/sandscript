/**
 * Array.prototype.keys / values / entries and their typed-array mirrors.
 *
 * values() resolves to the existing Symbol.iterator factory ids
 * (METHOD_ARRAY_ITERATOR_FACTORY / METHOD_TYPED_ARRAY_ITERATOR_FACTORY,
 * matching JS where values === [Symbol.iterator]); keys() and entries()
 * are new ids sharing the same factory, which now stores the iterator
 * kind in a @kind slot (the Map/Set factory convention: keys=0,
 * values=1, entries=2) that the shared iterator-next branches on.
 * The iterator objects also carry Symbol.iterator → return-this, so
 * they are self-iterable (for-of / spread over arr.entries() works).
 *
 * Run with: deno task test tests/fuel/array_iterator_kinds_test.js
 */

import { assertEquals } from 'https://deno.land/std@0.208.0/assert/mod.ts';
import { parseAndSetup } from './test-helpers.js';
import { freshSession } from '../../src/host-owned-session.js';

function assertResult(source, varName, expected) {
  const session = freshSession();
  parseAndSetup(session, source);
  const result = session.run(0, 10_000_000);
  assertEquals(result.status, 'done',
    `expected status=done, got ${result.status} (${result.error?.message})`);
  assertEquals(session.get(0, varName), expected);
}

// =============================================================================
// Plain arrays — manual next() protocol
// =============================================================================

Deno.test("keys/values/entries: are functions", () => {
  assertResult(
    'let r = typeof [].keys + ":" + typeof [].values + ":" + typeof [].entries',
    'r', 'function:function:function');
});

Deno.test("keys: yields ascending indexes then done", () => {
  assertResult(
    'let it = [10,20].keys(); let a = it.next(); let b = it.next(); let c = it.next(); ' +
    'let r = a.value + ":" + b.value + ":" + c.done',
    'r', '0:1:true');
});

Deno.test("values: yields elements (same iterator as Symbol.iterator)", () => {
  assertResult(
    'let it = [10,20].values(); let a = it.next(); let b = it.next(); let c = it.next(); ' +
    'let r = a.value + ":" + b.value + ":" + c.done',
    'r', '10:20:true');
});

Deno.test("entries: yields [index, value] pairs", () => {
  assertResult(
    'let it = [10,20].entries(); let a = it.next(); ' +
    'let r = a.value[0] + ":" + a.value[1] + ":" + a.done',
    'r', '0:10:false');
});

Deno.test("entries: exhausted step is {value: undefined, done: true}", () => {
  assertResult(
    'let it = [7].entries(); it.next(); let e = it.next(); ' +
    'let r = e.done + ":" + (e.value === undefined)',
    'r', 'true:true');
});

Deno.test("keys/entries: empty array is done immediately", () => {
  assertResult(
    'let r = [].keys().next().done + ":" + [].entries().next().done',
    'r', 'true:true');
});

// =============================================================================
// Plain arrays — for-of / spread (the iterator is self-iterable)
// =============================================================================

Deno.test("for-of over keys()", () => {
  assertResult(
    'let out = []; for (const k of [10,20,30].keys()) { out.push(k); } let r = out.join(",")',
    'r', '0,1,2');
});

Deno.test("for-of over entries() with destructuring", () => {
  assertResult(
    'let out = []; for (const [i, v] of ["a","b"].entries()) { out.push(i + v); } let r = out.join(",")',
    'r', '0a,1b');
});

Deno.test("spread over keys()", () => {
  assertResult('let r = [...[5,6].keys()].join(",")', 'r', '0,1');
});

Deno.test("a partially-consumed iterator resumes in for-of", () => {
  assertResult(
    'let it = [1,2].values(); it.next(); let out = []; for (const v of it) { out.push(v); } let r = out.join(",")',
    'r', '2');
});

// =============================================================================
// Typed arrays
// =============================================================================

Deno.test("typed keys/values/entries: are functions", () => {
  assertResult(
    'let b = new Uint8Array(2); let r = typeof b.keys + ":" + typeof b.values + ":" + typeof b.entries',
    'r', 'function:function:function');
});

Deno.test("typed keys: ascending indexes then done", () => {
  assertResult(
    'let b = new Uint8Array(2); b[0] = 9; let it = b.keys(); ' +
    'let a = it.next(); let c = it.next(); let d = it.next(); ' +
    'let r = a.value + ":" + c.value + ":" + d.done',
    'r', '0:1:true');
});

Deno.test("typed entries: [index, value] pairs", () => {
  assertResult(
    'let b = new Uint8Array(2); b[0] = 9; b[1] = 8; let it = b.entries(); let a = it.next(); ' +
    'let r = a.value[0] + ":" + a.value[1]',
    'r', '0:9');
});

Deno.test("typed for-of over entries()", () => {
  assertResult(
    'let b = new Uint8Array(3); b[0] = 5; b[1] = 6; b[2] = 7; let out = []; ' +
    'for (const [i, v] of b.entries()) { out.push(i + ":" + v); } let r = out.join(",")',
    'r', '0:5,1:6,2:7');
});

Deno.test("typed entries on a subarray: window-relative indexes and values", () => {
  assertResult(
    'let b = new Uint8Array(4); b[0] = 1; b[1] = 2; b[2] = 3; b[3] = 4; ' +
    'let s = b.subarray(1, 3); let out = []; ' +
    'for (const [i, v] of s.entries()) { out.push(i + ":" + v); } let r = out.join(",")',
    'r', '0:2,1:3');
});

Deno.test("Float64Array values keep float identity", () => {
  assertResult(
    'let b = new Float64Array(2); b[0] = 1.5; b[1] = -0.25; let out = []; ' +
    'for (const v of b.values()) { out.push(v); } let r = out.join(",")',
    'r', '1.5,-0.25');
});

Deno.test("BigInt64Array values yield bigints", () => {
  assertResult(
    'let b = new BigInt64Array(2); b[0] = 5n; b[1] = -3n; let out = []; ' +
    'for (const v of b.values()) { out.push(typeof v + ":" + v); } let r = out.join(",")',
    'r', 'bigint:5,bigint:-3');
});

Deno.test("BigInt64Array entries pair holds the bigint element", () => {
  assertResult(
    'let b = new BigInt64Array(1); b[0] = 7n; let it = b.entries(); let a = it.next(); ' +
    'let r = a.value[0] + ":" + a.value[1]',
    'r', '0:7');
});

// =============================================================================
// Neighbors unchanged: direct for-of, Map/Set iterators
// =============================================================================

Deno.test("for-of directly over an array is unchanged", () => {
  assertResult(
    'let out = []; for (const v of [1,2,3]) { out.push(v); } let r = out.join(",")',
    'r', '1,2,3');
});

Deno.test("for-of directly over a typed array is unchanged", () => {
  assertResult(
    'let b = new Uint8Array(2); b[0] = 4; b[1] = 5; let out = []; ' +
    'for (const v of b) { out.push(v); } let r = out.join(",")',
    'r', '4,5');
});

Deno.test("Map/Set iterator kinds are unchanged", () => {
  assertResult(
    'let m = new Map(); m.set("a", 1); let s = new Set(); s.add(3); ' +
    'let out = []; for (const [k, v] of m.entries()) { out.push(k + ":" + v); } ' +
    'for (const k of s.keys()) { out.push(k); } let r = out.join(",")',
    'r', 'a:1,3');
});

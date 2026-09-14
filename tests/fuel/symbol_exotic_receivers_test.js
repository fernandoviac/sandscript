/**
 * Symbol-keyed properties on Array, TypedArray, Map, Set, Object, and
 * Function receivers.
 *
 * Before this landed, arr[sym] = v coerced the symbol to numeric index 0
 * and silently clobbered arr[0]; map[sym] = v threw INVALID_OPERAND.
 *
 * Run with: deno task test tests/fuel/symbol_exotic_receivers_test.js
 */

import { assertEquals } from "https://deno.land/std@0.208.0/assert/mod.ts";
import { freshSession } from '../../src/host-owned-session.js';

function runAndGet(source, names, fuel = 10_000_000) {
  const session = freshSession();
  session.parse(source);
  const result = session.run(0, fuel);
  assertEquals(result.status, 'done', `expected 'done', got '${result.status}'`);
  const out = {};
  for (const name of names) out[name] = session.get(0, name);
  return out;
}

// =============================================================================
// Round-trips per receiver kind
// =============================================================================

Deno.test("Symbol keys: array set/get round-trip", () => {
  const { r } = runAndGet('let k = Symbol("k"); let arr = [1,2,3]; arr[k] = 9; let r = arr[k]', ['r']);
  assertEquals(r, 9);
});

Deno.test("Symbol keys: typed array set/get round-trip", () => {
  const { r } = runAndGet('let k = Symbol("k"); let ta = new Uint8Array(3); ta[k] = 11; let r = ta[k]', ['r']);
  assertEquals(r, 11);
});

Deno.test("Symbol keys: Int32Array set/get round-trip", () => {
  const { r } = runAndGet('let k = Symbol("k"); let ta = new Int32Array(2); ta[k] = 12; let r = ta[k]', ['r']);
  assertEquals(r, 12);
});

Deno.test("Symbol keys: Map set/get round-trip", () => {
  const { r } = runAndGet('let k = Symbol("k"); let m = new Map(); m[k] = 5; let r = m[k]', ['r']);
  assertEquals(r, 5);
});

Deno.test("Symbol keys: Set set/get round-trip", () => {
  const { r } = runAndGet('let k = Symbol("k"); let s = new Set(); s[k] = 4; let r = s[k]', ['r']);
  assertEquals(r, 4);
});

Deno.test("Symbol keys: object regression", () => {
  const { r } = runAndGet('let k = Symbol("k"); let obj = {}; obj[k] = 7; let r = obj[k]', ['r']);
  assertEquals(r, 7);
});

Deno.test("Symbol keys: function regression", () => {
  const { r } = runAndGet('let k = Symbol("k"); function f() {}; f[k] = 5; let r = f[k]', ['r']);
  assertEquals(r, 5);
});

// =============================================================================
// Corruption regression: symbol writes must never hit the numeric path
// =============================================================================

Deno.test("Symbol keys: array elements and length untouched by symbol write", () => {
  const { elems, len } = runAndGet(
    'let k = Symbol("k"); let arr = [1,2,3]; arr[k] = 9;' +
    'let elems = arr[0] * 100 + arr[1] * 10 + arr[2]; let len = arr.length',
    ['elems', 'len']);
  assertEquals(elems, 123);
  assertEquals(len, 3);
});

Deno.test("Symbol keys: typed array elements untouched by symbol write", () => {
  const { e0 } = runAndGet(
    'let k = Symbol("k"); let ta = new Uint8Array(3); ta[0] = 7; ta[k] = 9; let e0 = ta[0]',
    ['e0']);
  assertEquals(e0, 7);
});

Deno.test("Symbol keys: Map entries coexist with symbol props", () => {
  const { r } = runAndGet(
    'let k = Symbol("k"); let m = new Map(); m.set("a", 1); m[k] = 9; m.set("b", 2);' +
    'let r = m.get("a") * 100 + m.get("b") * 10 + m.size',
    ['r']);
  assertEquals(r, 122);
});

// =============================================================================
// Identity and storage semantics
// =============================================================================

Deno.test("Symbol keys: distinct symbols with same description get distinct slots", () => {
  const { r } = runAndGet(
    'let a = Symbol("x"); let b = Symbol("x"); let arr = []; arr[a] = 1; arr[b] = 2;' +
    'let r = arr[a] * 10 + arr[b]',
    ['r']);
  assertEquals(r, 12);
});

Deno.test("Symbol keys: missing key reads undefined", () => {
  const { r } = runAndGet('let k = Symbol("k"); let arr = [1]; let r = arr[k] === undefined ? 1 : 0', ['r']);
  assertEquals(r, 1);
});

Deno.test("Symbol keys: update in place", () => {
  const { r } = runAndGet('let k = Symbol("k"); let arr = []; arr[k] = 1; arr[k] = 2; let r = arr[k]', ['r']);
  assertEquals(r, 2);
});

Deno.test("Symbol keys: block grows past initial capacity of 4", () => {
  const { r } = runAndGet(
    'let arr = []; let syms = []; let i = 0;' +
    'while (i < 7) { syms[i] = Symbol("s"); arr[syms[i]] = i * 2; i = i + 1 }' +
    'let r = arr[syms[6]] * 10 + arr[syms[0]]',
    ['r']);
  assertEquals(r, 120);
});

// =============================================================================
// Invisibility to string-keyed views
// =============================================================================

Deno.test("Symbol keys: invisible to JSON.stringify and iteration", () => {
  const { json, sum } = runAndGet(
    'let k = Symbol("k"); let arr = [1,2,3]; arr[k] = 99;' +
    'let json = JSON.stringify(arr); let sum = 0; for (let x of arr) { sum = sum + x }',
    ['json', 'sum']);
  assertEquals(json, '[1,2,3]');
  assertEquals(sum, 6);
});

Deno.test("Symbol keys: invisible to Object.keys on objects", () => {
  const { r } = runAndGet(
    'let k = Symbol("k"); let obj = {a: 1}; obj[k] = 9; let r = Object.keys(obj).length',
    ['r']);
  assertEquals(r, 1);
});

// =============================================================================
// Prototype interplay
// =============================================================================

Deno.test("Symbol keys: Symbol.iterator still resolves through prototype with own sym props", () => {
  const { r } = runAndGet(
    'let k = Symbol("k"); let arr = [1,2]; arr[k] = 1;' +
    'let f = arr[Symbol.iterator]; let r = f === undefined ? 0 : 1',
    ['r']);
  assertEquals(r, 1);
});

Deno.test("Symbol keys: string receiver write is a silent no-op", () => {
  const { r, ch } = runAndGet(
    'let k = Symbol("k"); let s = "ab"; s[k] = 9;' +
    'let r = s[k] === undefined ? 1 : 0; let ch = s[1]',
    ['r', 'ch']);
  assertEquals(r, 1);
  assertEquals(ch, 'b');
});

// =============================================================================
// Frozen receivers
// =============================================================================

Deno.test("Symbol keys: frozen array write throws catchable TypeError", () => {
  const { threw, still } = runAndGet(
    'let k = Symbol("k"); let arr = [1]; Array.freeze(arr); let threw = 0;' +
    'try { arr[k] = 9 } catch (e) { threw = 1 }' +
    'let still = arr[k] === undefined ? 1 : 0',
    ['threw', 'still']);
  assertEquals(threw, 1);
  assertEquals(still, 1);
});

Deno.test("Symbol keys: frozen object write throws catchable TypeError", () => {
  const { threw } = runAndGet(
    'let k = Symbol("k"); let obj = Object.freeze({a: 1}); let threw = 0;' +
    'try { obj[k] = 9 } catch (e) { threw = 1 }',
    ['threw']);
  assertEquals(threw, 1);
});

// =============================================================================
// GC / compaction survival
// =============================================================================

Deno.test("Symbol keys: survive gc/compaction on all receiver kinds", () => {
  const session = freshSession();
  session.parse(`
    let ka = Symbol("a")
    let kb = Symbol("b")
    let arr = [1, 2]
    let ta = new Uint8Array(2)
    let m = new Map()
    let s = new Set()
    let obj = {}
    arr[ka] = "hello-" + "world"
    ta[ka] = 11
    m[ka] = 13
    s[ka] = 17
    obj[ka] = "sym-" + "str"
    let i = 0
    let syms = []
    while (i < 7) { syms[i] = Symbol("g"); arr[syms[i]] = i + 100; i = i + 1 }
    let garbage = []
    i = 0
    while (i < 50) { garbage[i] = [i, i, i]; i = i + 1 }
    garbage = 0
  `);
  let result = session.run(0, 10_000_000);
  assertEquals(result.status, 'done');

  session.gc();

  const r2 = session.parse(`
    let checkArr = arr[ka]
    let checkTa = ta[ka]
    let checkM = m[ka]
    let checkS = s[ka]
    let checkObj = obj[ka]
    let checkGrow = arr[syms[6]]
    let checkElems = arr[0] * 10 + arr[1]
    let checkMissing = arr[kb] === undefined ? 1 : 0
  `);
  session.airlock.memoryImage.setContextInstructionIndex(0, r2.startIndex);
  result = session.run(0, 10_000_000);
  assertEquals(result.status, 'done');

  assertEquals(session.get(0, 'checkArr'), 'hello-world');
  assertEquals(session.get(0, 'checkTa'), 11);
  assertEquals(session.get(0, 'checkM'), 13);
  assertEquals(session.get(0, 'checkS'), 17);
  assertEquals(session.get(0, 'checkObj'), 'sym-str');
  assertEquals(session.get(0, 'checkGrow'), 106);
  assertEquals(session.get(0, 'checkElems'), 12);
  assertEquals(session.get(0, 'checkMissing'), 1);
});

// =============================================================================
// Heap pressure on the symbol-set allocation path
// =============================================================================

Deno.test("Symbol keys: set under heap exhaustion yields memory_pressure then recovers", () => {
  // Tiny heap, and a loop that allocates a fresh object + symbol +
  // lazy sym-entries block (96 bytes) per round — far more than fits,
  // so pressure repeatedly lands on the symbol-set path itself. Each
  // yield must restore the three popped SET_INDEX operands so the
  // retry (after the host gc reclaims the dead rounds) re-runs the op
  // cleanly. Pins the $check_heap_overflow guards in $sym_block_set.
  const session = freshSession({ heapSize: 64 * 1024 });
  session.parse(`
    let keep = Symbol("keep")
    let obj = {}
    obj[keep] = "v" + "0"
    let i = 0
    let g = 0
    while (i < 300) {
      g = {}
      g[Symbol("s")] = i
      i = i + 1
    }
    g = 0
    let r = obj[keep]
  `);
  let result = session.run(0, 50_000_000);
  let yielded = 0;
  while (result.status === 'memory_pressure') {
    yielded++;
    if (yielded > 200) throw new Error('no progress after repeated gc');
    session.gc();
    result = session.run(0, 50_000_000);
  }
  assertEquals(result.status, 'done');
  assertEquals(session.get(0, 'r'), 'v0');
  if (yielded === 0) throw new Error('expected at least one memory_pressure yield');
});

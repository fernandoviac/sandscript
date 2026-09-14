/**
 * Array.from over iterable sources.
 *
 * Set / Map / typed-array sources convert natively (single synchronous
 * walk, budget pre-checked); user iterables (objects with a callable
 * Symbol.iterator, own or prototype) drain through an ARRAY_FROM_SEED
 * continuation frame whose completion substitutes the drained array
 * into the source slot and re-runs the call — so the existing
 * Array-source paths (clone, mapFn rewrite) apply uniformly.
 * null/undefined sources throw "Not iterable"; other primitives and
 * plain objects keep the spec's ToObject/no-length behavior (empty
 * array). Before this shipped, every non-Array/String source silently
 * produced [].
 */

import { assertEquals, assert } from "https://deno.land/std@0.208.0/assert/mod.ts";
import { parseAndSetup } from './test-helpers.js';
import { freshSession } from '../../src/host-owned-session.js';

function run(source) {
  const session = freshSession();
  parseAndSetup(session, source);
  const result = session.run(0, 50_000_000);
  if (result.status === 'error') {
    throw new Error(`Error: ${result.error.message}`);
  }
  return session;
}

Deno.test("Array.from: Set yields live values in slot order", () => {
  const s = run(`let a = Array.from(new Set([3,1,2])); let r = a.join(",");`);
  assertEquals(s.get(0, 'r'), '3,1,2');
});

Deno.test("Array.from: Set tombstones are skipped", () => {
  const s = run(`
    let set = new Set([1,2,3]); set.delete(2); set.add(9);
    let r = Array.from(set).join(",");
  `);
  assertEquals(s.get(0, 'r'), '1,3,9');
});

Deno.test("Array.from: Map yields [key, value] pairs", () => {
  const s = run(`
    let a = Array.from(new Map([['a',1],['b',2]]));
    let r = a[0][0] + a[0][1] + a[1][0] + a[1][1];
  `);
  assertEquals(s.get(0, 'r'), 'a1b2');
});

Deno.test("Array.from: typed arrays yield their elements", () => {
  const s = run(`
    let u8 = Array.from(new Uint8Array([4,5]));
    let f64 = Array.from(new Float64Array([0.5, -2.25]));
    let i32 = Array.from(new Int32Array([-7]));
    let r = u8.join(",") + "|" + f64.join(",") + "|" + i32[0];
  `);
  assertEquals(s.get(0, 'r'), '4,5|0.5,-2.25|-7');
});

Deno.test("Array.from: BigInt typed arrays yield BigInts", () => {
  const s = run(`
    let a = Array.from(new BigInt64Array([7n, -3n]));
    let r = (a[0] === 7n && a[1] === -3n);
  `);
  assertEquals(s.get(0, 'r'), true);
});

Deno.test("Array.from: user iterable drains through the protocol", () => {
  const s = run(`
    let obj = { [Symbol.iterator]() { let i = 0;
      return { next() { i = i + 1; return { value: i * 10, done: i > 3 }; } }; } };
    let r = Array.from(obj).join(",");
  `);
  assertEquals(s.get(0, 'r'), '10,20,30');
});

Deno.test("Array.from: mapFn applies over Set, Map, typed, and user-iterable sources", () => {
  const s = run(`
    let fromSet = Array.from(new Set([1,2,3]), x => x * 2)[2];
    let fromMap = Array.from(new Map([['k',7]]), e => e[0] + e[1])[0];
    let fromTyped = Array.from(new Uint8Array([4,5]), (x, i) => x + i)[1];
    let obj = { [Symbol.iterator]() { let i = 0;
      return { next() { i = i + 1; return { value: i, done: i > 3 }; } }; } };
    let fromIterable = Array.from(obj, x => x * x)[2];
    let r = fromSet + "," + fromMap + "," + fromTyped + "," + fromIterable;
  `);
  assertEquals(s.get(0, 'r'), '6,k7,6,9');
});

Deno.test("Array.from: null and undefined throw Not iterable", () => {
  const s = run(`
    let r1 = ""; try { Array.from(null); } catch (e) { r1 = e.message; }
    let u; let r2 = ""; try { Array.from(u); } catch (e) { r2 = e.message; }
  `);
  assertEquals(s.get(0, 'r1'), 'Not iterable');
  assertEquals(s.get(0, 'r2'), 'Not iterable');
});

Deno.test("Array.from: non-null primitives and plain objects give empty arrays (spec ToObject)", () => {
  const s = run(`let r = Array.from(42).length + Array.from({a:1}).length;`);
  assertEquals(s.get(0, 'r'), 0);
});

Deno.test("Array.from: detached-call form covers the same sources", () => {
  const s = run(`
    let f = Array.from;
    let fromSet = f(new Set([1,2])).length;
    let obj = { [Symbol.iterator]() { let i = 0;
      return { next() { i = i + 1; return { value: i, done: i > 2 }; } }; } };
    let fromIterable = f(obj).length;
    let caught = ""; try { f(null); } catch (e) { caught = e.message; }
    let r = fromSet + "," + fromIterable + "," + caught;
  `);
  assertEquals(s.get(0, 'r'), '2,2,Not iterable');
});

Deno.test("Array.from: a throw inside the user iterator propagates catchably", () => {
  const s = run(`
    let obj = { [Symbol.iterator]() { return { next() { throw new Error("boom"); } }; } };
    let r = ""; try { Array.from(obj); } catch (e) { r = e.message; }
  `);
  assertEquals(s.get(0, 'r'), 'boom');
});

Deno.test("Array.from: long drain grows the accumulator across capacity doublings", () => {
  const s = run(`
    let obj = { [Symbol.iterator]() { let i = 0;
      return { next() { i = i + 1; return { value: i, done: i > 100 }; } }; } };
    let a = Array.from(obj);
    let r = a.length * 1000 + a[99];
  `);
  assertEquals(s.get(0, 'r'), 100100);
});

Deno.test("Array.from: result survives gc", () => {
  const session = freshSession();
  parseAndSetup(session, `
    let a = Array.from(new Set(["keep", "these"]));
    let waste = [];
    for (let i = 0; i < 200; i++) waste.push({ junk: [i, i] });
    waste = null;
  `);
  session.run(0, 50_000_000);
  session.gc();
  const parseResult = session.parse('let after = a.join(",")');
  session.mem.setContextInstructionIndex(0, parseResult.startIndex);
  session.run(0, 10_000_000);
  assertEquals(session.get(0, 'after'), 'keep,these');
});

// =============================================================================
// Array-LIKE sources (added 2026-07-05): objects without a callable
// Symbol.iterator take the spec's ToObject path — read `length`
// (ToLength), copy index properties "0".."len-1", missing indexes become
// undefined. Accessor-bearing array-likes resolve through
// ACCESSOR_RESOLVE first, so index getters are invoked.
// =============================================================================

Deno.test("Array.from: array-like objects convert by length and index keys", () => {
  const s = run(`
    let a = Array.from({length: 2, 0: 'x', 1: 'y'});
    let sparse = Array.from({length: 3, 1: 'mid'});
    let r = a.join(",") + "|" + String(sparse[0]) + "," + sparse[1] + "," + sparse.length;
  `);
  assertEquals(s.get(0, 'r'), 'x,y|undefined,mid,3');
});

Deno.test("Array.from: array-like length follows ToLength", () => {
  const s = run(`
    let r = Array.from({length: -5}).length
      + "," + Array.from({length: 2.9, 0: 'a', 1: 'b', 2: 'c'}).length
      + "," + Array.from({length: "x"}).length
      + "," + Array.from({a: 1}).length;
  `);
  assertEquals(s.get(0, 'r'), '0,2,0,0');
});

Deno.test("Array.from: mapFn applies over array-like sources", () => {
  const s = run(`
    let scaled = Array.from({length: 3, 0: 1, 1: 2, 2: 3}, x => x * 10)[2];
    let indexes = Array.from({length: 2}, (x, i) => i)[1];
    let r = scaled + "," + indexes;
  `);
  assertEquals(s.get(0, 'r'), '30,1');
});

Deno.test("Array.from: index getters on array-likes are invoked", () => {
  const s = run(`
    let src = {length: 1, get 0() { return "from-getter"; }};
    let r = Array.from(src)[0];
  `);
  assertEquals(s.get(0, 'r'), 'from-getter');
});

Deno.test("Array.from: a callable Symbol.iterator wins over array-like shape", () => {
  const s = run(`
    let src = {length: 5, [Symbol.iterator]() {
      let i = 0;
      return {next() { i = i + 1; return {value: i, done: i > 2}; }};
    }};
    let r = Array.from(src).length;
  `);
  assertEquals(s.get(0, 'r'), 2);
});

Deno.test("Array.from: detached form with a mapFn throws loudly instead of ignoring it", () => {
  const s = run(`
    let f = Array.from;
    let caught = "";
    try { f([1, 2], function (x) { return x; }); } catch (e) { caught = e.message; }
    let plain = f([1, 2, 3]).length;
    let r = (caught.length > 0 ? "threw" : "silent") + "," + plain;
  `);
  assertEquals(s.get(0, 'r'), 'threw,3');
});

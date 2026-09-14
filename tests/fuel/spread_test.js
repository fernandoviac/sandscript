/**
 * Cluster 2 — spread operator (`...`) in expression positions:
 *   - Array literals:   [a, ...b, c]
 *   - Object literals:  {a, ...b, c}
 *   - Call sites:       f(a, ...b, c)
 *
 * Parser switches to builder mode on the first `...` element. Iteration
 * uses the standard iterator protocol (`[Symbol.iterator]().next()`).
 * Object spread walks own enumerable string-keyed properties via the
 * runtime OBJ_MERGE_SPREAD opcode.
 *
 * Current limitations:
 *   - Spread in `new` constructor calls is unsupported.
 *   - Spread of async functions is rejected with TypeError.
 *   - Bound-method callees with spread are rejected.
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
// Array-literal spread
// =============================================================================

Deno.test("array spread: middle of literal", () => {
  const s = run(`
    let a = [1, 2, 3];
    let b = [0, ...a, 4];
  `);
  assertEquals(s.get(0, 'b'), [0, 1, 2, 3, 4]);
});

Deno.test("array spread: only spread", () => {
  const s = run(`
    let a = [1, 2, 3];
    let b = [...a];
    let len = b.length; let r0 = b[0]; let r2 = b[2];
  `);
  assertEquals(s.get(0, 'len'), 3);
  assertEquals(s.get(0, 'r0'), 1);
  assertEquals(s.get(0, 'r2'), 3);
});

Deno.test("array spread: multiple spreads", () => {
  const s = run(`
    let a = [1, 2]; let b = [3, 4];
    let c = [...a, ...b];
    let len = c.length; let r0 = c[0]; let r3 = c[3];
  `);
  assertEquals(s.get(0, 'len'), 4);
  assertEquals(s.get(0, 'r0'), 1);
  assertEquals(s.get(0, 'r3'), 4);
});

Deno.test("array spread: of empty", () => {
  const s = run(`let a = []; let b = [...a]; let len = b.length;`);
  assertEquals(s.get(0, 'len'), 0);
});

Deno.test("array spread: of string yields chars", () => {
  const s = run(`let b = [..."abc"]; let len = b.length; let r0 = b[0]; let r2 = b[2];`);
  assertEquals(s.get(0, 'len'), 3);
  assertEquals(s.get(0, 'r0'), 'a');
  assertEquals(s.get(0, 'r2'), 'c');
});

Deno.test("array spread: of Set", () => {
  const s = run(`
    let myset = new Set();
    myset.add(10); myset.add(20); myset.add(30);
    let arr = [...myset];
    let len = arr.length;
  `);
  assertEquals(s.get(0, 'len'), 3);
});

Deno.test("array spread: of Map yields [key, value] entries", () => {
  const s = run(`
    let m = new Map();
    m.set('a', 1); m.set('b', 2);
    let entries = [...m];
    let len = entries.length;
    let key0 = entries[0][0]; let val0 = entries[0][1];
  `);
  assertEquals(s.get(0, 'len'), 2);
  assertEquals(s.get(0, 'key0'), 'a');
  assertEquals(s.get(0, 'val0'), 1);
});

// =============================================================================
// Object-literal spread
// =============================================================================

Deno.test("object spread: basic copy", () => {
  const s = run(`
    let a = {x: 1, y: 2};
    let b = {...a};
    let rx = b.x; let ry = b.y;
  `);
  assertEquals(s.get(0, 'rx'), 1);
  assertEquals(s.get(0, 'ry'), 2);
});

Deno.test("object spread: merge with additional keys", () => {
  const s = run(`
    let a = {x: 1, y: 2};
    let b = {...a, z: 3};
    let r = b.x + b.y + b.z;
  `);
  assertEquals(s.get(0, 'r'), 6);
});

Deno.test("object spread: later keys override earlier", () => {
  const s = run(`
    let a = {x: 1};
    let b = {...a, x: 99};
  `);
  assertEquals(s.get(0, 'b').x, 99);
});

Deno.test("object spread: two spreads merge in order", () => {
  const s = run(`
    let a = {x: 1};
    let b = {y: 2};
    let c = {...a, ...b, z: 3};
    let r = c.x + c.y + c.z;
  `);
  assertEquals(s.get(0, 'r'), 6);
});

Deno.test("object spread: null is no-op", () => {
  const s = run(`
    let b = {x: 1, ...null, y: 2};
    let r = b.x + b.y;
  `);
  assertEquals(s.get(0, 'r'), 3);
});

Deno.test("object spread: undefined is no-op", () => {
  const s = run(`
    let b = {...undefined};
    let keys = Object.keys(b);
    let len = keys.length;
  `);
  assertEquals(s.get(0, 'len'), 0);
});

// =============================================================================
// Call-site spread
// =============================================================================

Deno.test("call spread: bare", () => {
  const s = run(`
    function add3(a, b, c) { return a + b + c; }
    let args = [1, 2, 3];
    let r = add3(...args);
  `);
  assertEquals(s.get(0, 'r'), 6);
});

Deno.test("call spread: mixed positions", () => {
  const s = run(`
    function f(a, b, c, d) { return a*1000 + b*100 + c*10 + d; }
    let m = [2, 3];
    let r = f(1, ...m, 4);
  `);
  assertEquals(s.get(0, 'r'), 1234);
});

Deno.test("call spread: of empty", () => {
  const s = run(`function f() { return 42; } let r = f(...[]);`);
  assertEquals(s.get(0, 'r'), 42);
});

Deno.test("call spread: feeds into rest parameter", () => {
  const s = run(`
    function f(...args) { return args.length; }
    let v = [10, 20, 30, 40];
    let r = f(...v);
  `);
  assertEquals(s.get(0, 'r'), 4);
});

Deno.test("call spread: two spreads in one call", () => {
  const s = run(`
    function f(a, b, c, d) { return a + b + c + d; }
    let x = [1, 2]; let y = [3, 4];
    let r = f(...x, ...y);
  `);
  assertEquals(s.get(0, 'r'), 10);
});

Deno.test("call spread: method call", () => {
  const s = run(`
    let o = { sum(a, b, c) { return a + b + c; } };
    let args = [10, 20, 30];
    let r = o.sum(...args);
  `);
  assertEquals(s.get(0, 'r'), 60);
});

Deno.test("call spread: arrow callee", () => {
  const s = run(`
    let add = (a, b, c) => a + b + c;
    let args = [1, 2, 3];
    let r = add(...args);
  `);
  assertEquals(s.get(0, 'r'), 6);
});

// ---------------------------------------------------------------------------
// Object spread of non-object sources, which used to be a silent no-op
// producing {}
// ---------------------------------------------------------------------------

Deno.test("object spread: array yields indexed properties", () => {
  const s = run(`
    let o = {...[10, 20, 30]};
    let a = o["0"]; let b = o["1"]; let c = o["2"];
    let n = Object.keys(o).length;
  `);
  assertEquals(s.get(0, 'a'), 10);
  assertEquals(s.get(0, 'b'), 20);
  assertEquals(s.get(0, 'c'), 30);
  assertEquals(s.get(0, 'n'), 3);
});

Deno.test("object spread: array does not copy length", () => {
  const s = run(`
    let o = {...[1, 2]};
    let hasLength = o.length !== undefined;
  `);
  assertEquals(s.get(0, 'hasLength'), false);
});

Deno.test("object spread: array merges with literal keys", () => {
  const s = run(`
    let o = {...[7, 8], tag: 'x'};
    let a = o["0"]; let t = o.tag;
  `);
  assertEquals(s.get(0, 'a'), 7);
  assertEquals(s.get(0, 't'), 'x');
});

Deno.test("object spread: string yields indexed single-char properties", () => {
  const s = run(`
    let o = {..."abc"};
    let a = o["0"]; let b = o["1"]; let c = o["2"];
    let n = Object.keys(o).length;
  `);
  assertEquals(s.get(0, 'a'), 'a');
  assertEquals(s.get(0, 'b'), 'b');
  assertEquals(s.get(0, 'c'), 'c');
  assertEquals(s.get(0, 'n'), 3);
});

Deno.test("object spread: string with multi-byte code point", () => {
  const s = run(`
    let o = {..."é!"};
    let a = o["0"]; let b = o["1"];
  `);
  assertEquals(s.get(0, 'a'), 'é');
  assertEquals(s.get(0, 'b'), '!');
});

Deno.test("object spread: typed array yields indexed elements", () => {
  const s = run(`
    let o = {...new Uint8Array([5, 6])};
    let a = o["0"]; let b = o["1"];
  `);
  assertEquals(s.get(0, 'a'), 5);
  assertEquals(s.get(0, 'b'), 6);
});

Deno.test("object spread: float typed array keeps float values", () => {
  const s = run(`
    let o = {...new Float64Array([0.5, 1.5])};
    let a = o["0"]; let b = o["1"];
  `);
  assertEquals(s.get(0, 'a'), 0.5);
  assertEquals(s.get(0, 'b'), 1.5);
});

Deno.test("object spread: bigint typed array yields BigInt elements", () => {
  const s = run(`
    let o = {...new BigInt64Array([1n, -2n])};
    let a = o["0"]; let b = o["1"];
  `);
  assertEquals(s.get(0, 'a'), 1n);
  assertEquals(s.get(0, 'b'), -2n);
});

Deno.test("object spread: number and boolean are no-ops", () => {
  const s = run(`
    let a = {...42};
    let b = {...true};
    let n = Object.keys(a).length + Object.keys(b).length;
  `);
  assertEquals(s.get(0, 'n'), 0);
});

// ---------------------------------------------------------------------------
// Symbol-keyed source properties: CopyDataProperties includes own enumerable
// symbols, but the sym_entries walk used to be skipped.
// ---------------------------------------------------------------------------

Deno.test("object spread: symbol-keyed source property is copied", () => {
  const s = run(`
    let src = { plain: 1 };
    src[Symbol.iterator] = function() { return 42 };
    let o = {...src};
    let sym = typeof o[Symbol.iterator];
    let plain = o.plain;
    let invoked = o[Symbol.iterator]();
  `);
  assertEquals(s.get(0, 'sym'), 'function');
  assertEquals(s.get(0, 'plain'), 1);
  assertEquals(s.get(0, 'invoked'), 42);
});

Deno.test("object spread: same symbol from two sources — later wins", () => {
  const s = run(`
    let a = {}; a[Symbol.iterator] = function() { return 1 };
    let b = {}; b[Symbol.iterator] = function() { return 99 };
    let merged = {...a, ...b};
    let got = merged[Symbol.iterator]();
  `);
  assertEquals(s.get(0, 'got'), 99);
});

Deno.test("object spread: getter + symbol on the same source (resolve-copy carries symbols)", () => {
  // A getter-bearing source is substituted by an ACCESSOR_RESOLVE
  // data-only copy before the spread re-runs — the copy must carry
  // sym_entries or the symbol silently vanishes on exactly this path.
  const s = run(`
    let src = { get g() { return 7 } };
    src[Symbol.iterator] = function() { return 42 };
    let o = {...src};
    let g = o.g;
    let sym = o[Symbol.iterator]();
    let chained = {...{...src}};
    let chainedSym = chained[Symbol.iterator]();
  `);
  assertEquals(s.get(0, 'g'), 7);
  assertEquals(s.get(0, 'sym'), 42);
  assertEquals(s.get(0, 'chainedSym'), 42);
});

Deno.test("Object.assign: symbol-keyed source property is copied", () => {
  const s = run(`
    let src = { plain: 1 };
    src[Symbol.iterator] = function() { return 42 };
    let t = Object.assign({}, src);
    let sym = t[Symbol.iterator]();
    let plain = t.plain;
    let withGetter = Object.assign({}, { get g() { return 7 } }, src);
    let both = withGetter.g + withGetter[Symbol.iterator]();
  `);
  assertEquals(s.get(0, 'sym'), 42);
  assertEquals(s.get(0, 'plain'), 1);
  assertEquals(s.get(0, 'both'), 49);
});

// ---------------------------------------------------------------------------
// Spread with non-closure callees, which CALL_SPREAD/CALL_METHOD_SPREAD used
// to reject unless the callee was a synchronous TYPE_FUNCTION closure
// ---------------------------------------------------------------------------

Deno.test("spread callee: bound method arr.push(...vals)", () => {
  const s = run(`
    let arr = [1, 2, 3];
    let len = arr.push(...[4, 5]);
    let last = arr[4];
  `);
  assertEquals(s.get(0, 'len'), 5);
  assertEquals(s.get(0, 'last'), 5);
});

Deno.test("spread callee: bound method with mixed positions", () => {
  const s = run(`
    let arr = [];
    arr.push(0, ...[8, 9]);
    let n = arr.length; let a = arr[1]; let b = arr[2];
  `);
  assertEquals(s.get(0, 'n'), 3);
  assertEquals(s.get(0, 'a'), 8);
  assertEquals(s.get(0, 'b'), 9);
});

Deno.test("spread callee: Math.max(...values)", () => {
  const s = run(`let r = Math.max(...[1, 5, 3]);`);
  assertEquals(s.get(0, 'r'), 5);
});

Deno.test("spread callee: map.set(...entry)", () => {
  const s = run(`
    let m = new Map();
    m.set(...['k', 9]);
    let r = m.get('k');
  `);
  assertEquals(s.get(0, 'r'), 9);
});

Deno.test("spread callee: constructor conversion String(...args)", () => {
  const s = run(`let r = String(...[42]);`);
  assertEquals(s.get(0, 'r'), '42');
});

Deno.test("spread callee: empty spread on bound method is a no-op call", () => {
  const s = run(`
    let arr = [7];
    arr.push(...[]);
    let r = arr.length;
  `);
  assertEquals(s.get(0, 'r'), 1);
});

Deno.test("spread callee: callback method sort(...[comparator])", () => {
  const s = run(`
    let arr = [3, 1, 2];
    arr.sort(...[(a, b) => a - b]);
    let r = arr[0] * 100 + arr[1] * 10 + arr[2];
  `);
  assertEquals(s.get(0, 'r'), 123);
});

// ---------------------------------------------------------------------------
// Pending-stack growth during unpack (a large spread used to write straight
// past the stack block — the per-instruction safepoint only reserves a
// small fixed burst)
// ---------------------------------------------------------------------------

Deno.test("spread: large argument list grows the pending stack", () => {
  const s = run(`
    let big = [];
    for (let i = 0; i < 500; i++) big.push(i);
    function addAll(...rest) {
      let total = 0;
      for (let v of rest) total = total + v;
      return total;
    }
    let sum = addAll(...big);
    let top = Math.max(...big);
  `);
  assertEquals(s.get(0, 'sum'), 124750);
  assertEquals(s.get(0, 'top'), 499);
});

Deno.test("spread: very large argument list works with a heap that fits it", () => {
  const session = freshSession({ segmentSize: 8 * 1024 * 1024 });
  parseAndSetup(session, `
    let big = [];
    for (let i = 0; i < 5000; i++) big.push(1);
    function count(...rest) { return rest.length; }
    let n = count(...big);
  `);
  const result = session.run(0, 100_000_000);
  assertEquals(result.status, 'done');
  assertEquals(session.get(0, 'n'), 5000);
});

// =============================================================================
// Non-iterable spread sources — "Not iterable" diagnostics (ASSERT_ITERABLE)
// =============================================================================

Deno.test("spread: null source throws Not iterable, not a property-read error", () => {
  const s = run(`
    let caught = null;
    try { let a = [...null]; } catch (e) { caught = e.message; }
  `);
  assertEquals(s.get(0, 'caught'), 'Not iterable');
});

Deno.test("spread: undefined source throws Not iterable", () => {
  const s = run(`
    let u = undefined; let caught = null;
    try { let a = [...u]; } catch (e) { caught = e.message; }
  `);
  assertEquals(s.get(0, 'caught'), 'Not iterable');
});

Deno.test("spread: number source throws Not iterable, not Not a function", () => {
  const s = run(`
    let caught = null;
    try { let a = [...42]; } catch (e) { caught = e.message; }
  `);
  assertEquals(s.get(0, 'caught'), 'Not iterable');
});

Deno.test("spread: plain object without Symbol.iterator throws Not iterable", () => {
  const s = run(`
    let caught = null;
    try { let a = [...{ a: 1 }]; } catch (e) { caught = e.message; }
  `);
  assertEquals(s.get(0, 'caught'), 'Not iterable');
});

Deno.test("spread: call-site spread of a non-iterable throws Not iterable", () => {
  const s = run(`
    function f(a) { return a; }
    let caught = null;
    try { f(...42); } catch (e) { caught = e.message; }
  `);
  assertEquals(s.get(0, 'caught'), 'Not iterable');
});

// =============================================================================
// Constructor calls with spread (F3, fixed 2026-07-05). The parser packs
// spread args into an array (same builder as call()); NEW_SPREAD unpacks
// it in place and shares OP_NEW's logic. Pressure retries re-pack.
// =============================================================================

Deno.test("new spread: user constructor", () => {
  const s = run(`
    function Foo(a, b) { this.sum = a + b; }
    let f = new Foo(...[3, 4]);
    let r = f.sum;
  `);
  assertEquals(s.get(0, 'r'), 7);
});

Deno.test("new spread: mixed positions and prototype methods", () => {
  const s = run(`
    function C(a, b, c) { this.v = a * 100 + b * 10 + c; }
    C.prototype = { read() { return this.v; } };
    let c = new C(1, ...[2, 3]);
    let r = c.read();
  `);
  assertEquals(s.get(0, 'r'), 123);
});

Deno.test("new spread: builtin constructors", () => {
  const s = run(`
    let s1 = new Set(...[[1, 2, 3]]).size;
    let m = new Map(...[[["k", 5]]]).get("k");
    let a = new Array(...[1, 2, 3]).length;
    let r = s1 * 100 + m * 10 + a;
  `);
  assertEquals(s.get(0, 'r'), 353);
});

Deno.test("new spread: non-iterable source throws Not iterable", () => {
  const s = run(`
    function H(a) {}
    let caught = "";
    try { new H(...42); } catch (e) { caught = e.message; }
  `);
  assertEquals(s.get(0, 'caught'), 'Not iterable');
});

Deno.test("new Array with multiple args builds elements (not length)", () => {
  const s = run(`
    let a = new Array(1, 2, 3);
    let b = new Array("x");
    let r = a.join(",") + "|" + a.length + "|" + b[0];
  `);
  assertEquals(s.get(0, 'r'), '1,2,3|3|x');
});

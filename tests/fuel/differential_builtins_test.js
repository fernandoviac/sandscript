/**
 * Differential builtin tests: run identical source through sandscript and
 * through Deno's own JS engine, and require the same value.
 *
 * Born from the 2026-07-05 silent-failure sweep, which found eleven
 * builtins silently ignoring optional or variadic arguments (fromIndex/
 * position/limit/mapFn/space and friends). Every case here executes
 * without error in both engines — this file pins VALUES, not error
 * behavior. When adding a builtin with optional arguments, add its cases
 * here.
 *
 * Known intentional divergences (do NOT add): byte-indexed (not UTF-16)
 * string positions for multi-byte code points; Number("42x") parses the
 * numeric prefix (JS: NaN); JSON.parse revivers receive exactly
 * (key, value) — never V8's source-access context third argument — so
 * reviver cases here must not observe arity or a third parameter.
 */

import { assertEquals } from "https://deno.land/std@0.208.0/assert/mod.ts";
import { parseAndSetup } from './test-helpers.js';
import { freshSession } from '../../src/host-owned-session.js';

function runSand(source) {
  const session = freshSession();
  parseAndSetup(session, `let __r = (${source});`);
  const result = session.run(0, 10_000_000);
  if (result.status === 'error') {
    throw new Error(`sandscript error: ${result.error.message}`);
  }
  return session.get(0, '__r');
}

function norm(value) {
  if (typeof value === 'bigint') return `bigint:${value}`;
  if (Number.isNaN(value)) return 'NaN';
  if (value === undefined) return 'undefined';
  if (value === Infinity) return 'Infinity';
  if (value === -Infinity) return '-Infinity';
  return JSON.stringify(value);
}

const CASES = [
  // Array search methods with fromIndex
  '[1,2,3,1].indexOf(1)',
  '[1,2,3,1].indexOf(1, 1)',
  '[1,2,3,1].indexOf(1, -1)',
  '[1,2,3,1].indexOf(1, -10)',
  '[1,2,3,1].indexOf(9, 1)',
  '[1,2,3,1].lastIndexOf(1)',
  '[1,2,3,1].lastIndexOf(1, 2)',
  '[1,2,3,1].lastIndexOf(1, -2)',
  '[1,2,3].includes(1, 1)',
  '[1,2,3].includes(3, -1)',
  '[1,2,3].includes(1, -1)',

  // Array optional-argument methods
  '[1,2,3,4].slice(1, -1)',
  '[1,2,3,4].slice(-3, -1)',
  '[1,2,3,4].fill(9, 1, 3)',
  '[1,2,3,4].fill(9, -2)',
  '[1,2,3,4,5].copyWithin(0, 3, 4)',
  '[[1],[2,[3]]].flat(2)',
  '(() => { let a = [1,2,3,4]; a.splice(-2, 1); return a; })()',
  '[1,2].concat([3],[4],5)',
  '[1, [2]].concat([3], 4).length',
  'Array.from([1, 2], (x, i) => x + i)',
  'Array.from([1, 2, 3], (x) => x * 2)',

  // String search methods with position
  '"hello".indexOf("l", 3)',
  '"hello".lastIndexOf("l")',
  '"hello".lastIndexOf("l", 2)',
  '"hello".lastIndexOf("l", 99)',
  '"hello".lastIndexOf("l", -1)',
  '"hello".includes("ell", 2)',
  '"hello".includes("h", -3)',
  '"hello".startsWith("llo", 2)',
  '"hello".startsWith("llo", -1)',
  '"hello".endsWith("ll", 4)',
  '"hello".endsWith("hello", 99)',

  // String split with limit (including the no-argument form, which used
  // to crash on a garbage string id, and ToUint32 negative wrap)
  '"a b".split()',
  '"a,b,c".split(",", 2)',
  '"a,b,c".split(",", 0)',
  '"a,b".split(",", -1)',
  '"abc".split("", 2)',
  '"aXbXc".split("X", 2)',

  // Number conversion edges
  'Number("")',
  'Number(" ")',
  'Number("\\n\\t")',
  'Number(" 42 ")',

  // Variadic Math
  'Math.max(1, 9, 3, 7)',
  'Math.max(5)',
  'Math.max()',
  'Math.min(9, 8, -2, 7)',
  'Math.min()',
  'Math.max(1, NaN, 3)',
  'Math.hypot(2, 3, 6)',
  'Math.hypot()',

  // JSON.stringify space
  'JSON.stringify({a: 1}, null, 2)',
  'JSON.stringify([1, {a: 2}], null, 2)',
  'JSON.stringify({a: [1, 2]}, null, "\\t")',
  'JSON.stringify({a: 1, b: {c: 3}}, null, 4)',
  'JSON.stringify({}, null, 2)',
  'JSON.stringify([], null, 2)',
  'JSON.stringify({a: 1}, null, 0)',
  'JSON.stringify({a: 1}, null, "")',
  'JSON.stringify("plain", null, 2)',

  // Rest-parameter callbacks receive the full specification argument list.
  // Staging used to size pushed arguments by declared parameter count, which
  // a rest parameter observes; one shared sizing rule now lives in
  // interpreter.wat's $callback_staged_argc. Multi-element receivers
  // exercise the continuation re-arm paths, not just the first staging.
  "['a','b'].map((...xs) => xs.length).join(',')",
  "(() => { let n = 0; ['a','b'].forEach((...xs) => { n = n + xs.length; }); return n; })()",
  '[1,2,3].filter((...xs) => xs[1] < 2).length',
  '[5,6].find((...xs) => xs[1] === 1)',
  '[5,6].findIndex((...xs) => xs[0] === 6)',
  '[1,2].some((...xs) => xs.length === 3)',
  '[1,2].every((...xs) => xs.length === 3)',
  '[1,2,3].reduce((...xs) => xs[0] + xs[1], 0)',
  '[1,2].reduce((...xs) => xs.length, 0)',
  '[1,2].reduceRight((...xs) => xs.length, 0)',
  "[3,1,2].sort((...ab) => ab[0] - ab[1]).join(',')",
  "[1,2].flatMap((...xs) => [xs.length]).join(',')",
  '[7].map((a, b, c, d, ...rest) => rest.length)[0]',
  "(() => { let n = 0; new Map([['a',1],['b',2]]).forEach((...xs) => { n = n + xs.length; }); return n; })()",
  '(() => { let n = 0; new Set([8, 9]).forEach((...xs) => { n = n + xs.length; }); return n; })()',
  'new Uint8Array([4,5]).map((...xs) => xs.length)[0]',
  'new Uint8Array([1,2]).reduce((...xs) => xs.length, 0)',
  'new Uint8Array([3,1,2]).sort((...ab) => ab[0] - ab[1])[0]',
  'JSON.stringify({a:1}, (...kv) => kv.length)',
  '(() => { const o = { valueOf: (...a) => BigInt(40 + a.length) }; return BigInt(o); })()',
  '(() => { const o = { [Symbol.toPrimitive]: (...h) => BigInt(h.length) }; return BigInt(o); })()',

  // JSON.parse reviver (JSON_INTERNALIZE driver): bottom-up walk,
  // undefined deletes, root call last, holder mutation in place.
  "JSON.stringify(JSON.parse('{\"a\":1,\"b\":[2,3]}', (k, v) => v))",
  "JSON.stringify(JSON.parse('{\"a\":1,\"b\":2}', (k, v) => typeof v === 'number' ? v * 10 : v))",
  "JSON.stringify(JSON.parse('{\"a\":1,\"b\":2,\"c\":3}', (k, v) => k === 'b' ? undefined : v))",
  "JSON.stringify(JSON.parse('[1,[2,3],{\"d\":4}]', (k, v) => typeof v === 'number' ? v + 1 : v))",
  "(() => { let seen = []; JSON.parse('{\"o\":{\"i\":1},\"z\":2}', (k, v) => { seen.push(k); return v }); return seen.join('|'); })()",
  "JSON.parse('{\"a\":1}', (k, v) => k === '' ? 'ROOT' : v)",
  "JSON.parse('42', (k, v) => typeof v === 'number' ? v + 1 : v)",
  "(() => { const r = JSON.parse('[1,2,3]', (k, v) => v === 2 ? undefined : v); return String(r[1]) + ':' + r.length; })()",
  "(() => { let ks = []; JSON.parse('[5,6]', (k, v) => { ks.push(typeof k); return v }); return ks.join(','); })()",
  'JSON.parse(\'"str"\', (k, v) => v)',
  "JSON.parse('null', (k, v) => v)",
  "JSON.stringify(JSON.parse('{}', (k, v) => v))",
  "JSON.stringify(JSON.parse('[]', (k, v) => v))",
];

for (const expr of CASES) {
  Deno.test(`differential: ${expr}`, () => {
    const jsValue = (0, eval)(`(${expr})`);
    const sandValue = runSand(expr);
    assertEquals(norm(sandValue), norm(jsValue));
  });
}

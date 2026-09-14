/**
 * Symbol.toStringTag + Object.prototype.toString (B2).
 *
 * Symbol.toStringTag is the third well-known symbol (minted at
 * bootstrap, mirrored to STATE). Object.prototype.toString — reachable
 * both directly (Object.prototype is now a real property of the Object
 * constructor) and inherited (map.toString()) — reports
 * "[object <tag>]": built-in tags for Map / Set / Array / Function /
 * Promise and the primitives, or the receiver's Symbol.toStringTag for
 * plain objects (own or prototype-inherited; string values only). The
 * string coercion paths ("" + x, String(x), template literals) honor
 * the same tags — before B2, "" + new Map() coerced to "".
 */

import { assertEquals } from "https://deno.land/std@0.208.0/assert/mod.ts";
import { parseAndSetup } from './test-helpers.js';
import { freshSession } from '../../src/host-owned-session.js';

function run(source) {
  const session = freshSession();
  parseAndSetup(session, source);
  const result = session.run(0, 50_000_000);
  if (result.status === 'error') {
    throw new Error(result.error.message);
  }
  return session;
}

Deno.test("Symbol.toStringTag is a symbol", () => {
  const s = run(`let t = typeof Symbol.toStringTag;`);
  assertEquals(s.get(0, 't'), 'symbol');
});

Deno.test("Object.prototype is reachable and its toString works", () => {
  const s = run(`
    let t = typeof Object.prototype;
    let r = Object.prototype.toString();
  `);
  assertEquals(s.get(0, 't'), 'object');
  assertEquals(s.get(0, 'r'), '[object Object]');
});

Deno.test("built-in tags: Map, Set via inherited toString()", () => {
  const s = run(`
    let m = (new Map()).toString();
    let st = (new Set()).toString();
    let o = ({}).toString();
  `);
  assertEquals(s.get(0, 'm'), '[object Map]');
  assertEquals(s.get(0, 'st'), '[object Set]');
  assertEquals(s.get(0, 'o'), '[object Object]');
});

Deno.test("string coercion honors tags: + operator, String(), template literal", () => {
  const s = run(`
    let plus = "" + new Map();
    let str = String(new Set());
    let m2 = new Map();
    let tpl = \`x\${m2}y\`;
  `);
  assertEquals(s.get(0, 'plus'), '[object Map]');
  assertEquals(s.get(0, 'str'), '[object Set]');
  assertEquals(s.get(0, 'tpl'), 'x[object Map]y');
});

Deno.test("String() of a promise reports [object Promise]", () => {
  const s = run(`let r = String(Promise.resolve(1));`);
  assertEquals(s.get(0, 'r'), '[object Promise]');
});

Deno.test("user Symbol.toStringTag: own property", () => {
  const s = run(`
    let o = { [Symbol.toStringTag]: "Custom" };
    let direct = o.toString();
    let coerced = "" + o;
    let viaString = String(o);
  `);
  assertEquals(s.get(0, 'direct'), '[object Custom]');
  assertEquals(s.get(0, 'coerced'), '[object Custom]');
  assertEquals(s.get(0, 'viaString'), '[object Custom]');
});

Deno.test("user Symbol.toStringTag: inherited through the prototype chain", () => {
  const s = run(`
    function Token() {}
    Token.prototype[Symbol.toStringTag] = "Token";
    let r = (new Token()).toString();
  `);
  assertEquals(s.get(0, 'r'), '[object Token]');
});

Deno.test("non-string Symbol.toStringTag values are ignored", () => {
  const s = run(`
    let o = { [Symbol.toStringTag]: 42 };
    let r = o.toString();
  `);
  assertEquals(s.get(0, 'r'), '[object Object]');
});

Deno.test("array and primitive coercion is unchanged", () => {
  const s = run(`
    let arr = "" + [1, 2, 3];
    let obj = "" + {};
    let num = "" + 7;
  `);
  assertEquals(s.get(0, 'arr'), '1,2,3');
  assertEquals(s.get(0, 'obj'), '[object Object]');
  assertEquals(s.get(0, 'num'), '7');
});

Deno.test("tags survive gc (symbol identity and literals are intrinsic roots)", () => {
  const session = freshSession();
  parseAndSetup(session, `
    let o = { [Symbol.toStringTag]: "Persistent" };
    let before = o.toString();
  `);
  let result = session.run(0, 50_000_000);
  assertEquals(result.status, 'done');
  session.gc();
  parseAndSetup(session, `
    let after = o.toString();
    let again = (new Map()).toString();
  `);
  result = session.run(0, 50_000_000);
  assertEquals(result.status, 'done');
  assertEquals(session.get(0, 'before'), '[object Persistent]');
  assertEquals(session.get(0, 'after'), '[object Persistent]');
  assertEquals(session.get(0, 'again'), '[object Map]');
});

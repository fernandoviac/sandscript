/**
 * JSON.stringify through the JSON_TRANSFORM driver: getter-backed
 * properties at any depth, and function replacers.
 *
 * A function replacer (previously silently ignored) or a getter met by
 * the native serializer's walk (previously a loud TypeError for nested
 * ones) routes the call through a transform-first driver: it builds a
 * JSON-shaped deep copy with an explicit DFS, staging getter and
 * replacer calls in spec order (Get, then replacer, per own property;
 * the replacer is first called as replacer.call({"": value}, "", value)),
 * then re-runs stringify natively on the copy with the replacer
 * argument neutralized. Non-function replacers stay ignored; cycles
 * still error; `space` composes.
 */

import { assertEquals } from "https://deno.land/std@0.208.0/assert/mod.ts";
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

Deno.test("stringify: nested getter serialises", () => {
  const s = run(`
    let inner = { get x() { return 1; } };
    let r = JSON.stringify({ wrap: inner });
  `);
  assertEquals(s.get(0, 'r'), '{"wrap":{"x":1}}');
});

Deno.test("stringify: getters inside arrays and getter-returned objects", () => {
  const s = run(`
    let a = JSON.stringify([{ get g() { return 7; } }]);
    let b = JSON.stringify({ get g() { return { n: 1 }; } });
    let c = JSON.stringify({ a: { get deep() { return [1, { get deeper() { return "!"; } }]; } } });
    let r = a + "|" + b + "|" + c;
  `);
  assertEquals(s.get(0, 'r'), '[{"g":7}]|{"g":{"n":1}}|{"a":{"deep":[1,{"deeper":"!"}]}}');
});

Deno.test("stringify: nested getter runs exactly once and throws propagate", () => {
  const s = run(`
    let calls = 0;
    let o = { arr: [{ get g() { calls = calls + 1; return calls; } }] };
    let json = JSON.stringify(o);
    let caught = "";
    try { JSON.stringify({ wrap: { get boom() { throw new Error("nope"); } } }); }
    catch (e) { caught = e.message; }
    let r = json + "|" + calls + "|" + caught;
  `);
  assertEquals(s.get(0, 'r'), '{"arr":[{"g":1}]}|1|nope');
});

Deno.test("stringify: setter-only properties are omitted", () => {
  const s = run(`let r = JSON.stringify({ a: 1, wrap: { set s(v) {} } });`);
  assertEquals(s.get(0, 'r'), '{"a":1,"wrap":{}}');
});

Deno.test("replacer: filters and transforms values", () => {
  const s = run(`
    let filtered = JSON.stringify({ a: 1, b: 2 }, function (k, v) {
      if (k === "b") return undefined;
      return v;
    });
    let scaled = JSON.stringify({ a: 1 }, function (k, v) {
      return typeof v === "number" ? v * 10 : v;
    });
    let r = filtered + "|" + scaled;
  `);
  assertEquals(s.get(0, 'r'), '{"a":1}|{"a":10}');
});

Deno.test("replacer: applies to the root value first", () => {
  const s = run(`
    let order = [];
    JSON.stringify({ a: { b: 1 }, c: 2 }, function (k, v) { order.push(k); return v; });
    let root = JSON.stringify(42, function (k, v) { return v + 1; });
    let r = order.join("|") + " root=" + root;
  `);
  assertEquals(s.get(0, 'r'), '|a|b|c root=43');
});

Deno.test("replacer: array elements get string index keys, undefined becomes null", () => {
  const s = run(`
    let keys = [];
    let json = JSON.stringify([1, 2], function (k, v) {
      if (k !== "") keys.push(k + ":" + typeof k);
      if (k === "1") return undefined;
      return v;
    });
    let r = json + "|" + keys.join(",");
  `);
  assertEquals(s.get(0, 'r'), '[1,null]|0:string,1:string');
});

Deno.test("replacer: composes with getters and space", () => {
  const s = run(`
    let o = { get g() { return 3; } };
    let both = JSON.stringify(o, function (k, v) { if (k === "g") return v * 2; return v; });
    let spaced = JSON.stringify({ a: 1 }, function (k, v) { return v; }, 1);
    let r = both + "|" + spaced;
  `);
  assertEquals(s.get(0, 'r'), '{"g":6}|{\n "a": 1\n}');
});

Deno.test("replacer: this is the holder object", () => {
  const s = run(`
    let out = "";
    JSON.stringify({ a: 1 }, function (k, v) {
      if (k === "a") out = (typeof this === "object") ? "obj" : "?";
      return v;
    });
    let r = out;
  `);
  assertEquals(s.get(0, 'r'), 'obj');
});

Deno.test("replacer: arrow replacers and block bodies (implicit undefined) work", () => {
  const s = run(`
    let arrow = JSON.stringify({ a: 5 }, (k, v) => (k === "a" ? "five" : v));
    let blockBody = JSON.stringify({ a: 1, keep: 2 }, function (k, v) {
      if (k !== "a") return v;
    });
    let r = arrow + "|" + blockBody;
  `);
  assertEquals(s.get(0, 'r'), '{"a":"five"}|{"keep":2}');
});

Deno.test("replacer: throw inside the replacer propagates catchably", () => {
  const s = run(`
    let r = "";
    try { JSON.stringify({ a: 1 }, function (k, v) { if (k === "a") throw new Error("stop"); return v; }); }
    catch (e) { r = e.message; }
  `);
  assertEquals(s.get(0, 'r'), 'stop');
});

Deno.test("replacer: non-function replacers stay ignored", () => {
  const s = run(`
    let a = JSON.stringify({ a: 1 }, null);
    let b = JSON.stringify({ a: 1 }, "nope");
    let r = a + "|" + b;
  `);
  assertEquals(s.get(0, 'r'), '{"a":1}|{"a":1}');
});

Deno.test("stringify: cycles still error with the driver engaged", () => {
  const s = run(`
    let o = { a: {} };
    o.a.back = o;
    o.g = { get x() { return 1; } };
    let viaGetter = "";
    try { JSON.stringify(o); } catch (e) { viaGetter = "threw"; }
    let viaReplacer = "";
    let c = { a: {} }; c.a.back = c;
    try { JSON.stringify(c, function (k, v) { return v; }); } catch (e) { viaReplacer = "threw"; }
    let r = viaGetter + "|" + viaReplacer;
  `);
  assertEquals(s.get(0, 'r'), 'threw|threw');
});

Deno.test("stringify: detached-call form drives too", () => {
  const s = run(`
    let f = JSON.stringify;
    let viaGetter = f({ wrap: { get x() { return 1; } } });
    let viaReplacer = f({ a: 1 }, function (k, v) { return typeof v === "number" ? v + 1 : v; });
    let r = viaGetter + "|" + viaReplacer;
  `);
  assertEquals(s.get(0, 'r'), '{"wrap":{"x":1}}|{"a":2}');
});

Deno.test("stringify: transform result survives gc", () => {
  const session = freshSession();
  parseAndSetup(session, `
    let o = { wrap: { get g() { return "kept"; } } };
    let json = JSON.stringify(o);
    let waste = [];
    for (let i = 0; i < 200; i++) waste.push({ junk: [i, i] });
    waste = null;
  `);
  session.run(0, 50_000_000);
  session.gc();
  const parseResult = session.parse('let after = json');
  session.mem.setContextInstructionIndex(0, parseResult.startIndex);
  session.run(0, 10_000_000);
  assertEquals(session.get(0, 'after'), '{"wrap":{"g":"kept"}}');
});

// =============================================================================
// Array replacers (PropertyList) — native whitelist filter, added
// 2026-07-05. Applied to objects at every depth; list ORDER wins; number
// elements key by canonical string form; dedup'd; arrays unaffected.
// =============================================================================

Deno.test("array replacer: filters and orders keys", () => {
  const s = run(`
    let ordered = JSON.stringify({b: 1, a: 2, c: 3}, ['a', 'b']);
    let deduped = JSON.stringify({a: 1, b: 2}, ['b', 'a', 'b']);
    let missing = JSON.stringify({a: 1}, ['nope', 'a']);
    let empty = JSON.stringify({a: 1, b: 2}, []);
    let r = ordered + "|" + deduped + "|" + missing + "|" + empty;
  `);
  assertEquals(s.get(0, 'r'), '{"a":2,"b":1}|{"b":2,"a":1}|{"a":1}|{}');
});

Deno.test("array replacer: applies at every object depth, arrays unaffected", () => {
  const s = run(`
    let nested = JSON.stringify({o: {a: 1, b: 2}, a: 9}, ['o', 'a']);
    let inArray = JSON.stringify([{a: 1, b: 2}, {a: 3}], ['a']);
    let r = nested + "|" + inArray;
  `);
  assertEquals(s.get(0, 'r'), '{"o":{"a":1},"a":9}|[{"a":1},{"a":3}]');
});

Deno.test("array replacer: number elements key by string form, others ignored", () => {
  const s = run(`
    let numeric = JSON.stringify({1: 'x', a: 2}, [1]);
    let mixed = JSON.stringify({a: 1}, [true, null, 'a']);
    let r = numeric + "|" + mixed;
  `);
  assertEquals(s.get(0, 'r'), '{"1":"x"}|{"a":1}');
});

Deno.test("array replacer: composes with space and with getters (transform driver)", () => {
  const s = run(`
    let spaced = JSON.stringify({a: 1, b: 2}, ['a'], 1);
    let viaGetter = JSON.stringify({ get a() { return 7; }, b: 2 }, ['a']);
    let nestedGetter = JSON.stringify({ wrap: { get x() { return 1; }, y: 2 } }, ['wrap', 'x']);
    let r = spaced + "|" + viaGetter + "|" + nestedGetter;
  `);
  assertEquals(s.get(0, 'r'), '{\n "a": 1\n}|{"a":7}|{"wrap":{"x":1}}');
});

// =============================================================================
// Undefined-class roots (fixed 2026-07-05): JSON.stringify of undefined,
// a function, a symbol, or no argument returns the undefined VALUE (it
// used to serialise as the string "null"). Property/element positions
// keep their omit/null behavior.
// =============================================================================

Deno.test("stringify: undefined-class roots return the undefined value", () => {
  const s = run(`
    let u;
    let r = String(JSON.stringify(u)) + "|" + String(JSON.stringify())
      + "|" + String(JSON.stringify(function () {}))
      + "|" + String(JSON.stringify({ a: 1 }, function (k, v) { return undefined; }));
  `);
  assertEquals(s.get(0, 'r'), 'undefined|undefined|undefined|undefined');
});

Deno.test("stringify: undefined stays omitted in objects, null in arrays", () => {
  const s = run(`
    let u;
    let r = JSON.stringify({a: u, b: 1}) + "|" + JSON.stringify([u, 1]) + "|" + JSON.stringify(null);
  `);
  assertEquals(s.get(0, 'r'), '{"b":1}|[null,1]|null');
});

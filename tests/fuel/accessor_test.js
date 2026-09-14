/**
 * Getter/setter properties in object literals.
 *
 * `get prop() {}` / `set prop(v) {}` parse to TYPE_ACCESSOR property
 * values (getter closure in data_lo, setter closure in data_hi);
 * GET_PROP/GET_INDEX invoke the getter with `this` = the receiver,
 * SET_PROP/SET_INDEX invoke the setter and evaluate to the assigned
 * value. Enumeration surfaces (spread, Object.values/entries/assign
 * sources, JSON.stringify at any depth) invoke getters through the
 * re-entry machinery; the one remaining loud TypeError is Object.assign
 * onto an accessor-bearing TARGET (its setters would need invoking).
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

Deno.test("accessor: basic getter", () => {
  const s = run(`let o = { get answer() { return 42; } }; let r = o.answer;`);
  assertEquals(s.get(0, 'r'), 42);
});

Deno.test("accessor: getter binds this to the receiver", () => {
  const s = run(`let o = { base: 10, get doubled() { return this.base * 2; } }; let r = o.doubled;`);
  assertEquals(s.get(0, 'r'), 20);
});

Deno.test("accessor: getter and setter pair on one key", () => {
  const s = run(`
    let o = {
      _v: 1,
      get v() { return this._v; },
      set v(x) { this._v = x * 10; },
    };
    o.v = 5;
    let r = o.v;
  `);
  assertEquals(s.get(0, 'r'), 50);
});

Deno.test("accessor: assignment through a setter evaluates to the assigned value", () => {
  const s = run(`
    let o = { set x(v) { this._x = v; } };
    let r = (o.x = 7);
  `);
  assertEquals(s.get(0, 'r'), 7);
});

Deno.test("accessor: setter-only property reads as undefined", () => {
  const s = run(`
    let o = { set x(v) { this._x = v; } };
    o.x = 3;
    let stored = o._x;
    let read = o.x;
    let r = (read === undefined) ? stored : -1;
  `);
  assertEquals(s.get(0, 'r'), 3);
});

Deno.test("accessor: getter-only property ignores writes (non-strict JS)", () => {
  const s = run(`
    let o = { get x() { return 9; } };
    o.x = 100;
    let r = o.x;
  `);
  assertEquals(s.get(0, 'r'), 9);
});

Deno.test("accessor: index access invokes the getter", () => {
  const s = run(`let o = { get k() { return 5; } }; let r = o["k"];`);
  assertEquals(s.get(0, 'r'), 5);
});

Deno.test("accessor: index assignment invokes the setter", () => {
  const s = run(`
    let o = { _n: 0, set k(v) { this._n = v + 1; } };
    o["k"] = 41;
    let r = o._n;
  `);
  assertEquals(s.get(0, 'r'), 42);
});

Deno.test("accessor: getter can call sibling methods and read sibling props", () => {
  const s = run(`
    let o = {
      plain: 1,
      m() { return 2; },
      get g() { return this.plain + this.m(); },
    };
    let r = o.g;
  `);
  assertEquals(s.get(0, 'r'), 3);
});

Deno.test("accessor: getter invoked once per mention in an expression", () => {
  const s = run(`
    let calls = 0;
    let o = { get n() { calls = calls + 1; return 4; } };
    let r = o.n * o.n + o.n;
    let c = calls;
  `);
  assertEquals(s.get(0, 'r'), 20);
  assertEquals(s.get(0, 'c'), 3);
});

Deno.test("accessor: get/set stay usable as ordinary property names", () => {
  const s = run(`
    let a = { get: 1, set: 2 };
    let b = { get() { return 3; } };
    let r = a.get + a.set + b.get();
  `);
  assertEquals(s.get(0, 'r'), 6);
});

Deno.test("accessor: coexists with computed keys in one literal", () => {
  const s = run(`
    let key = "dyn";
    let o = { [key]: 1, get total() { return this.dyn + 1; } };
    let r = o.total;
  `);
  assertEquals(s.get(0, 'r'), 2);
});

Deno.test("accessor: getter throw propagates catchably", () => {
  const s = run(`
    let o = { get boom() { throw new Error("nope"); } };
    let r = 0;
    try { let x = o.boom; } catch (e) { r = e.message; }
  `);
  assertEquals(s.get(0, 'r'), 'nope');
});

Deno.test("accessor: setter throw propagates catchably", () => {
  const s = run(`
    let o = { set boom(v) { throw new Error("bad " + v); } };
    let r = 0;
    try { o.boom = 5; } catch (e) { r = e.message; }
  `);
  assertEquals(s.get(0, 'r'), 'bad 5');
});

Deno.test("accessor: Object.keys lists accessor property names", () => {
  const s = run(`
    let o = { a: 1, get b() { return 2; } };
    let r = Object.keys(o).join(",");
  `);
  assertEquals(s.get(0, 'r'), 'a,b');
});

Deno.test("accessor: survives gc with live getter and setter", () => {
  const session = freshSession();
  parseAndSetup(session, `
    let o = { _v: 7, get v() { return this._v; }, set v(x) { this._v = x; } };
    let waste = [];
    for (let i = 0; i < 200; i++) waste.push({ junk: [i, i] });
    waste = null;
  `);
  session.run(0, 10_000_000);
  session.gc();
  const parseResult = session.parse('o.v = 99; let after = o.v');
  session.mem.setContextInstructionIndex(0, parseResult.startIndex);
  session.run(0, 10_000_000);
  assertEquals(session.get(0, 'after'), 99);
});

Deno.test("accessor: host-side read of an accessor property gives undefined", () => {
  const s = run(`let o = { plain: 1, get g() { return 2; } };`);
  const hostValue = s.get(0, 'o');
  assertEquals(hostValue.plain, 1);
  assertEquals(hostValue.g, undefined);
});

// ---------------------------------------------------------------------------
// Enumeration surfaces invoke getters via the ACCESSOR_RESOLVE re-entry
// machinery (the operand is resolved to a data-only copy, then the
// original instruction re-runs against it). JSON.stringify goes through
// the JSON_TRANSFORM driver instead, which handles getters at ANY depth
// (tests/fuel/json_transform_test.js). Object.assign onto an
// accessor-bearing TARGET drives the target's setters through the
// ASSIGN_SETTERS continuation (tests/fuel/assign_setters_test.js).
// ---------------------------------------------------------------------------

Deno.test("accessor surfaces: object spread invokes the getter", () => {
  const s = run(`
    let o = { plain: 1, get g() { return this.plain + 10; } };
    let c = {...o};
    o.plain = 5;
    let liveG = o.g; let copiedG = c.g;
  `);
  assertEquals(s.get(0, 'copiedG'), 11);
  assertEquals(s.get(0, 'liveG'), 15);
});

Deno.test("accessor surfaces: Object.values invokes getters", () => {
  const s = run(`
    let o = { a: 1, get g() { return 2; } };
    let v = Object.values(o);
    let n = v.length; let second = v[1];
  `);
  assertEquals(s.get(0, 'n'), 2);
  assertEquals(s.get(0, 'second'), 2);
});

Deno.test("accessor surfaces: Object.entries invokes getters", () => {
  const s = run(`
    let o = { a: 1, get g() { return 2; } };
    let e = Object.entries(o);
    let key = e[1][0]; let value = e[1][1];
  `);
  assertEquals(s.get(0, 'key'), 'g');
  assertEquals(s.get(0, 'value'), 2);
});

Deno.test("accessor surfaces: Object.assign resolves sources in spec order", () => {
  const s = run(`
    let log = [];
    let s1 = { get a() { log.push("s1"); return 1; } };
    let s2 = { get b() { log.push("s2"); return 2; } };
    let t = Object.assign({}, s1, s2);
    let r = log.join(",") + ":" + t.a + t.b;
  `);
  assertEquals(s.get(0, 'r'), 's1,s2:12');
});

Deno.test("accessor surfaces: JSON.stringify serialises top-level getter values", () => {
  const s = run(`
    let o = { plain: 2, get g() { return this.plain + 10; } };
    let r = JSON.stringify(o);
  `);
  assertEquals(s.get(0, 'r'), '{"plain":2,"g":12}');
});

Deno.test("accessor surfaces: getter runs exactly once per operation", () => {
  const s = run(`
    let calls = 0;
    let o = { get g() { calls = calls + 1; return 7; } };
    let c = {...o};
    let copied = c.g; let count = calls;
  `);
  assertEquals(s.get(0, 'copied'), 7);
  assertEquals(s.get(0, 'count'), 1);
});

Deno.test("accessor surfaces: getter throw propagates from spread", () => {
  const s = run(`
    let bad = { get boom() { throw new Error("nope"); } };
    let r = "";
    try { let c = {...bad}; } catch (e) { r = e.message; }
  `);
  assertEquals(s.get(0, 'r'), 'nope');
});

Deno.test("accessor surfaces: nested accessor under JSON.stringify serialises", () => {
  const s = run(`
    let inner = { get x() { return 1; } };
    let outer = { wrap: inner };
    let r = JSON.stringify(outer);
  `);
  assertEquals(s.get(0, 'r'), '{"wrap":{"x":1}}');
});

Deno.test("accessor surfaces: Object.assign onto an accessor-bearing target invokes setters", () => {
  const s = run(`
    let t = { _x: 0, set x(v) { this._x = v * 10; } };
    let out = Object.assign(t, { x: 5 });
    let r = t._x * (out === t ? 1 : -1);
  `);
  assertEquals(s.get(0, 'r'), 50);
});

// ---------------------------------------------------------------------------
// AST fidelity: getSource() prints the get/set keyword (fixed 2026-07-05 —
// accessors used to print as plain methods, losing accessor semantics on
// reparse).
// ---------------------------------------------------------------------------

Deno.test("accessor AST: getSource keeps get/set keywords and round-trips", () => {
  const session = freshSession({ inlineSource: true });
  session.parse(`let o = { _v: 1, get v() { return this._v; }, set v(x) { this._v = x; } };`);
  const printed = session.getSource();
  if (!printed.includes('get v()') || !printed.includes('set v(x)')) {
    throw new Error(`keywords missing from: ${printed}`);
  }
  const session2 = freshSession({ inlineSource: true });
  session2.parse(printed);
  assertEquals(session2.getSource(), printed);
});

Deno.test("accessor AST: reprinted source keeps accessor semantics", () => {
  const session = freshSession({ inlineSource: true });
  session.parse(`let o = { _v: 5, get v() { return this._v; }, set v(x) { this._v = x * 2; } };`);
  const printed = session.getSource();

  const session2 = freshSession({ inlineSource: true });
  parseAndSetup(session2, `${printed}\no.v = 10;\nlet r = o.v;`);
  session2.run(0, 10_000_000);
  assertEquals(session2.get(0, 'r'), 20);
});

Deno.test("accessor AST: get/set as plain property names print unchanged", () => {
  const session = freshSession({ inlineSource: true });
  session.parse(`let o = { get: 1, set: 2 };`);
  assertEquals(session.getSource().trim(), 'let o = { get: 1, set: 2 };');
});

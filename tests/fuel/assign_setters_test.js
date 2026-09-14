/**
 * Object.assign onto an accessor-bearing target (ASSIGN_SETTERS driver).
 *
 * Once every accessor-bearing SOURCE has been resolved to a data-only
 * copy (ACCESSOR_RESOLVE re-runs), an accessor-bearing TARGET routes
 * through a continuation that walks source entries left to right,
 * staging the target's own setters per colliding key — mirroring
 * SET_PROP semantics (getter-only collisions silently ignored, throws
 * propagate) — and writing everything else natively. The call completes
 * directly with the target (no re-run: setters fire exactly once).
 * Previously this shape threw a loud TypeError.
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

Deno.test("assign: setter invoked with this = target, result is the target", () => {
  const s = run(`
    let t = { _x: 0, set x(v) { this._x = v * 10; } };
    let out = Object.assign(t, { x: 5 });
    let r = t._x * (out === t ? 1 : -1);
  `);
  assertEquals(s.get(0, 'r'), 50);
});

Deno.test("assign: accessor, data, and fresh keys interleave", () => {
  const s = run(`
    let t = { plain: 0, _v: 0, set v(x) { this._v = x; } };
    Object.assign(t, { plain: 7, v: 3, fresh: "new" });
    let r = t.plain + "|" + t._v + "|" + t.fresh;
  `);
  assertEquals(s.get(0, 'r'), '7|3|new');
});

Deno.test("assign: multiple sources fire the setter in order, once each", () => {
  const s = run(`
    let log = [];
    let t = { set x(v) { log.push(v); } };
    Object.assign(t, { x: 1 }, { x: 2 });
    let r = log.join(",");
  `);
  assertEquals(s.get(0, 'r'), '1,2');
});

Deno.test("assign: getter-only collisions are silently ignored (SET_PROP semantics)", () => {
  const s = run(`
    let t = { get x() { return 9; } };
    Object.assign(t, { x: 100, other: 1 });
    let r = t.x + "|" + t.other;
  `);
  assertEquals(s.get(0, 'r'), '9|1');
});

Deno.test("assign: getter+setter pair routes writes through the setter", () => {
  const s = run(`
    let t = { _n: 0, get n() { return this._n; }, set n(v) { this._n = v + 1; } };
    Object.assign(t, { n: 41 });
    let r = t.n;
  `);
  assertEquals(s.get(0, 'r'), 42);
});

Deno.test("assign: setter throws propagate catchably", () => {
  const s = run(`
    let t = { set x(v) { throw new Error("no " + v); } };
    let r = "";
    try { Object.assign(t, { x: 5 }); } catch (e) { r = e.message; }
  `);
  assertEquals(s.get(0, 'r'), 'no 5');
});

Deno.test("assign: accessor-bearing source resolves first, then the target setter fires", () => {
  const s = run(`
    let src = { get x() { return 5; } };
    let t = { _x: 0, set x(v) { this._x = v * 2; } };
    Object.assign(t, src);
    let r = t._x;
  `);
  assertEquals(s.get(0, 'r'), 10);
});

Deno.test("assign: non-object sources are skipped, block-body setters fine", () => {
  const s = run(`
    let t = { set x(v) { let unused = v; } };
    Object.assign(t, null, undefined, { x: 1, y: 2 });
    let r = t.y;
  `);
  assertEquals(s.get(0, 'r'), 2);
});

Deno.test("assign: non-colliding target accessors survive untouched", () => {
  const s = run(`
    let t = { get lazy() { return "still"; }, a: 1 };
    Object.assign(t, { a: 2 });
    let r = t.lazy + "|" + t.a;
  `);
  assertEquals(s.get(0, 'r'), 'still|2');
});

Deno.test("assign: target mutations survive gc", () => {
  const session = freshSession();
  parseAndSetup(session, `
    let t = { _x: 0, set x(v) { this._x = v; } };
    Object.assign(t, { x: 77, extra: "kept" });
    let waste = [];
    for (let i = 0; i < 200; i++) waste.push({ junk: [i, i] });
    waste = null;
  `);
  session.run(0, 50_000_000);
  session.gc();
  const parseResult = session.parse('let after = t._x + "|" + t.extra');
  session.mem.setContextInstructionIndex(0, parseResult.startIndex);
  session.run(0, 10_000_000);
  assertEquals(session.get(0, 'after'), '77|kept');
});

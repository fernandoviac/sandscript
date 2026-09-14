/**
 * Function.prototype.call / apply / bind (closure receivers).
 *
 * call/apply: the native rewrites the pending stack into plain-argument
 * shape at the receiver slot, prepares the call scope (binding `this`
 * for non-arrows — strict-mode style, the thisArg passes through
 * verbatim, null stays null), and dispatch code 6 stages the closure
 * call. bind: the A2 thisArg pattern — a closure clone whose holder
 * scope binds `this`, ARROW-flagged so call sites resolve `this`
 * lexically. Loudly unsupported (one TypeError): async or generator
 * callees, bind with partial arguments, apply arrays beyond current
 * pending capacity. Detached call (`let c = f.call; c()`) throws — the
 * receiver slot no longer holds the function.
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

Deno.test("call binds this and passes arguments", () => {
  const s = run(`
    function f(a, b) { return this.base + a + b; }
    function g() { return this.tag; }
    let r = f.call({ base: 100 }, 5, 7);
    let noArgs = g.call({ tag: "T" });
    let rr = r + "|" + noArgs;
  `);
  assertEquals(s.get(0, 'rr'), '112|T');
});

Deno.test("apply unpacks the argument array", () => {
  const s = run(`
    function f(a, b, c) { return this.base + a + b + c; }
    let r = f.apply({ base: 1000 }, [1, 2, 3]);
    let empty = (function () { return "none"; }).apply({ base: 5 }, []);
    let nully = (function () { return this === null; }).apply(null);
    let rr = r + "|" + empty + "|" + nully;
  `);
  assertEquals(s.get(0, 'rr'), '1006|none|true');
});

Deno.test("bind creates a persistent this binding", () => {
  const s = run(`
    function f(x) { return this.n * x; }
    let g = f.bind({ n: 6 });
    let r = g(7) + "|" + g(2);
  `);
  assertEquals(s.get(0, 'r'), '42|12');
});

Deno.test("arrows keep lexical this through call and bind", () => {
  const s = run(`
    let outer = { v: "lexical" };
    function make() { return () => this.v; }
    let viaCall = make.call(outer)();
    let arrow = (x) => x + 1;
    let bound = arrow.bind({ z: 9 });
    let r = viaCall + "|" + arrow.call({ ignored: 1 }, 41) + "|" + bound(41);
  `);
  assertEquals(s.get(0, 'r'), 'lexical|42|42');
});

Deno.test("recursion and expression composition through call", () => {
  const s = run(`
    function fact(n) { if (n <= 1) { return 1; } return n * fact.call(null, n - 1); }
    function triple(a) { return a * 3; }
    let r = fact(6) + "|" + (1 + triple.call(undefined, 4) + 2);
  `);
  assertEquals(s.get(0, 'r'), '720|15');
});

Deno.test("unsupported forms throw loudly", () => {
  const s = run(`
    async function af() { return 1; }
    function f(a, b) { return a + b; }
    let errors = 0;
    try { af.call({}); } catch (e) { errors = errors + 1; }
    try { f.bind({}, 1); } catch (e) { errors = errors + 1; }
    try { f.apply({}, "not-an-array"); } catch (e) { errors = errors + 1; }
  `);
  assertEquals(s.get(0, 'errors'), 3);
});

Deno.test("detached call throws (receiver slot loses the function)", () => {
  const s = run(`
    function f() { return 1; }
    let c = f.call;
    let caught = "";
    try { c({}); } catch (e) { caught = "threw"; }
  `);
  assertEquals(s.get(0, 'caught'), 'threw');
});

Deno.test("the B2 observable now works end to end", () => {
  const s = run(`
    let r = Object.prototype.toString.call(new Map());
    let r2 = Object.prototype.toString.call(new Set());
  `);
  assertEquals(s.get(0, 'r'), '[object Map]');
  assertEquals(s.get(0, 'r2'), '[object Set]');
});

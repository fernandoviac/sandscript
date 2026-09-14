/**
 * Cluster 1 — function call ABI: parameter defaults and rest parameters.
 *
 * Implemented via OP.RECONCILE_PARAMS, the first opcode of every function
 * body. It reads FRAME.ARGC (written by every call-path site at frame push)
 * and reshapes the pending stack so the LET_VAR sequence sees exactly the
 * declared parameter count.
 */

import { assertEquals, assertThrows } from "https://deno.land/std@0.208.0/assert/mod.ts";
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

function parseOnly(source) {
  return freshSession().parse(source);
}

// =============================================================================
// Plain identifier parameter defaults
// =============================================================================

Deno.test("default: fires on missing arg", () => {
  const s = run(`function add(a, b = 10) { return a + b; } let r = add(5);`);
  assertEquals(s.get(0, 'r'), 15);
});

Deno.test("default: fires on explicit undefined", () => {
  const s = run(`function f(a, b = 10) { return a + b; } let r = f(5, undefined);`);
  assertEquals(s.get(0, 'r'), 15);
});

Deno.test("default: does not fire when value provided", () => {
  const s = run(`function f(a, b = 10) { return a + b; } let r = f(5, 20);`);
  assertEquals(s.get(0, 'r'), 25);
});

Deno.test("default: multiple defaults, no args", () => {
  const s = run(`function f(a = 1, b = 2, c = 3) { return a + b + c; } let r = f();`);
  assertEquals(s.get(0, 'r'), 6);
});

Deno.test("default: multiple defaults, partial args", () => {
  const s = run(`
    function f(a = 1, b = 2, c = 3) { return a + b + c; }
    let r1 = f(10);
    let r2 = f(10, 20);
    let r3 = f(10, 20, 30);
  `);
  assertEquals(s.get(0, 'r1'), 15);  // 10 + 2 + 3
  assertEquals(s.get(0, 'r2'), 33);  // 10 + 20 + 3
  assertEquals(s.get(0, 'r3'), 60);  // 10 + 20 + 30
});

// Default parameters in non-arrow function forms are covered here; arrow
// cover-grammar has its own parser coverage.

Deno.test("default: extra args silently dropped (no rest)", () => {
  const s = run(`function f(a, b) { return a + b; } let r = f(1, 2, 999, 1000);`);
  assertEquals(s.get(0, 'r'), 3);
});

// =============================================================================
// Rest parameters
// =============================================================================

Deno.test("rest: zero extras", () => {
  const s = run(`function f(...rest) { return rest.length; } let r = f();`);
  assertEquals(s.get(0, 'r'), 0);
});

Deno.test("rest: three args", () => {
  const s = run(`function f(...rest) { return rest.length; } let r = f(1, 2, 3);`);
  assertEquals(s.get(0, 'r'), 3);
});

Deno.test("rest: preserves arg order", () => {
  const s = run(`
    function f(...rest) { return rest[0] * 100 + rest[1] * 10 + rest[2]; }
    let r = f(1, 2, 3);
  `);
  assertEquals(s.get(0, 'r'), 123);
});

Deno.test("rest: after fixed params", () => {
  const s = run(`
    function f(a, b, ...rest) { return a + b + rest.length; }
    let r1 = f(10, 20);
    let r2 = f(10, 20, 30, 40, 50);
  `);
  assertEquals(s.get(0, 'r1'), 30);  // 10 + 20 + 0
  assertEquals(s.get(0, 'r2'), 33);  // 10 + 20 + 3
});

Deno.test("rest: rest array values preserved with fixed params", () => {
  const s = run(`
    function f(a, ...rest) { return rest[0] + rest[1]; }
    let r = f(0, 100, 200);
  `);
  assertEquals(s.get(0, 'r'), 300);
});

Deno.test("rest: function expression", () => {
  const s = run(`let f = function(...rest) { return rest[0]; }; let r = f(42, 43);`);
  assertEquals(s.get(0, 'r'), 42);
});

Deno.test("rest: arrow function — bare rest", () => {
  const s = run(`let f = (...rest) => rest.length; let r = f(1, 2, 3, 4);`);
  assertEquals(s.get(0, 'r'), 4);
});

Deno.test("rest: arrow function — mixed with fixed", () => {
  const s = run(`let f = (x, ...rest) => x + rest.length; let r = f(100, 1, 2);`);
  assertEquals(s.get(0, 'r'), 102);
});

Deno.test("rest: method shorthand", () => {
  const s = run(`
    let o = { sum(...n) { let s = 0; for (let x of n) s += x; return s; } };
    let r = o.sum(1, 2, 3, 4);
  `);
  assertEquals(s.get(0, 'r'), 10);
});

Deno.test("rest: is a real array — has .length, indexing, .map", () => {
  const s = run(`
    function f(...rest) {
      let doubled = rest.map(function(x) { return x * 2; });
      return doubled[0] + doubled[1] + doubled[2];
    }
    let r = f(1, 2, 3);
  `);
  assertEquals(s.get(0, 'r'), 12);
});

// =============================================================================
// Syntax-error cases
// =============================================================================

Deno.test("rest: must be last parameter (syntax error)", () => {
  let threw = false;
  try { parseOnly(`function f(...rest, x) {}`); } catch { threw = true; }
  if (!threw) throw new Error("Should have failed to parse");
});

Deno.test("rest: must have a name after '...' (syntax error)", () => {
  let threw = false;
  try { parseOnly(`function f(...) {}`); } catch { threw = true; }
  if (!threw) throw new Error("Should have failed to parse");
});

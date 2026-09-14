/**
 * Ring 4 (4a) — Exact.Matrix.equal: structural equality.
 *
 * Shape match, then per-entry expression equality — Ring 1 semantic
 * equality on numeric leaves (2n equals 2), Symbol pointer identity,
 * recursion through Expression and nested Matrix entries. No simplify:
 * make([[Add(1, 0)]]) is NOT equal to make([[1]]).
 */

import { assertEquals } from "https://deno.land/std@0.208.0/assert/mod.ts";
import { parseAndSetup } from './test-helpers.js';
import { freshSession } from '../../src/host-owned-session.js';

function run(source) {
  const session = freshSession();
  parseAndSetup(session, source);
  const result = session.run(0, 1000000);
  if (result.status === 'error') {
    throw new Error(`Error: ${result.error?.message ?? JSON.stringify(result)}`);
  }
  return session;
}

function equalOf(source) {
  const session = run(source);
  return session.get(0, 'result');
}

Deno.test("equal: identical construction is equal", () => {
  assertEquals(equalOf(`
    let a = Exact.Matrix.make([[1n, 2n], [3n, 4n]]);
    let b = Exact.Matrix.make([[1n, 2n], [3n, 4n]]);
    let result = Exact.Matrix.equal(a, b);
  `), true);
});

Deno.test("equal: same instance is equal", () => {
  assertEquals(equalOf(`
    let a = Exact.Matrix.identity(3);
    let result = Exact.Matrix.equal(a, a);
  `), true);
});

Deno.test("equal: numeric leaves compare semantically across representations", () => {
  // BigInt 2n vs inline Rational 2 vs Rational 2/1 — all semantically 2.
  assertEquals(equalOf(`
    let a = Exact.Matrix.make([[2n]]);
    let b = Exact.Matrix.make([[2]]);
    let c = Exact.Matrix.make([[Exact.rational(2n, 1n)]]);
    let result = Exact.Matrix.equal(a, b) && Exact.Matrix.equal(b, c);
  `), true);
});

Deno.test("equal: differing entries are unequal", () => {
  assertEquals(equalOf(`
    let a = Exact.Matrix.make([[1n, 2n]]);
    let b = Exact.Matrix.make([[1n, 3n]]);
    let result = Exact.Matrix.equal(a, b);
  `), false);
});

Deno.test("equal: shape mismatch is unequal even when entries align", () => {
  assertEquals(equalOf(`
    let a = Exact.Matrix.make([[1n, 2n, 3n, 4n]]);
    let b = Exact.Matrix.make([[1n, 2n], [3n, 4n]]);
    let result = Exact.Matrix.equal(a, b);
  `), false);
});

Deno.test("equal: zero-size shapes compare by shape", () => {
  assertEquals(equalOf(`
    let result = Exact.Matrix.equal(Exact.Matrix.make([]), Exact.Matrix.zero(0, 0));
  `), true);
  assertEquals(equalOf(`
    let result = Exact.Matrix.equal(Exact.Matrix.zero(0, 5), Exact.Matrix.zero(0, 5));
  `), true);
  assertEquals(equalOf(`
    let result = Exact.Matrix.equal(Exact.Matrix.zero(0, 5), Exact.Matrix.zero(0, 4));
  `), false);
  assertEquals(equalOf(`
    let result = Exact.Matrix.equal(Exact.Matrix.zero(0, 5), Exact.Matrix.zero(5, 0));
  `), false);
});

Deno.test("equal: registered Symbols compare by identity", () => {
  assertEquals(equalOf(`
    let a = Exact.Matrix.make([[Symbol.for('x')]]);
    let b = Exact.Matrix.make([[Symbol.for('x')]]);
    let result = Exact.Matrix.equal(a, b);
  `), true);
  assertEquals(equalOf(`
    let a = Exact.Matrix.make([[Symbol.for('x')]]);
    let b = Exact.Matrix.make([[Symbol.for('y')]]);
    let result = Exact.Matrix.equal(a, b);
  `), false);
});

Deno.test("equal: Expression entries recurse structurally", () => {
  assertEquals(equalOf(`
    let a = Exact.Matrix.make([[Exact.Expression.add(Symbol.for('x'), 1n)]]);
    let b = Exact.Matrix.make([[Exact.Expression.add(Symbol.for('x'), 1)]]);
    let result = Exact.Matrix.equal(a, b);
  `), true);
});

Deno.test("equal: no simplify — Add(1, 0) entry is not the entry 1", () => {
  assertEquals(equalOf(`
    let a = Exact.Matrix.make([[Exact.Expression.add(1n, 0n)]]);
    let b = Exact.Matrix.make([[1n]]);
    let result = Exact.Matrix.equal(a, b);
  `), false);
});

Deno.test("equal: nested matrices recurse", () => {
  assertEquals(equalOf(`
    let a = Exact.Matrix.make([[Exact.Matrix.make([[1n, 2n]])]]);
    let b = Exact.Matrix.make([[Exact.Matrix.make([[1n, 2n]])]]);
    let result = Exact.Matrix.equal(a, b);
  `), true);
  assertEquals(equalOf(`
    let a = Exact.Matrix.make([[Exact.Matrix.make([[1n, 2n]])]]);
    let b = Exact.Matrix.make([[Exact.Matrix.make([[1n, 3n]])]]);
    let result = Exact.Matrix.equal(a, b);
  `), false);
});

Deno.test("equal: Matrix vs non-Matrix is false (full equality relation)", () => {
  assertEquals(equalOf(`
    let result = Exact.Matrix.equal(Exact.Matrix.make([[1n]]), 1n);
  `), false);
});

Deno.test("Expression.equal sees Matrix atoms structurally", () => {
  assertEquals(equalOf(`
    let m1 = Exact.Matrix.make([[1n, 2n]]);
    let m2 = Exact.Matrix.make([[1n, 2n]]);
    let e1 = Exact.Expression.make(Exact.Expression.Add, [m1, m1]);
    let e2 = Exact.Expression.make(Exact.Expression.Add, [m2, m2]);
    let result = Exact.Expression.equal(e1, e2);
  `), true);
  assertEquals(equalOf(`
    let e1 = Exact.Expression.make(Exact.Expression.Add, [Exact.Matrix.make([[1n]]), 1n]);
    let e2 = Exact.Expression.make(Exact.Expression.Add, [Exact.Matrix.make([[2n]]), 1n]);
    let result = Exact.Expression.equal(e1, e2);
  `), false);
});

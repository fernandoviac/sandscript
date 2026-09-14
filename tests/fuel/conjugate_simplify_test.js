/**
 * Ring 4 (4b) — the Conjugate head in Ring 2 simplify.
 *
 * Rules (Q5, 2026-07-19):
 *   Conjugate(Conjugate(x)) -> x
 *   Conjugate(numeric atom) folds: identity on Rational/BigInt,
 *   flips the imaginary component on Complex.
 * Ring 5 (5a) added distribution over Add/Multiply/integer-Power and
 * the Matrix-atom fold — see conjugate_distribution_test.js. What
 * remains opaque (Conjugate(Symbol), Conjugate over opaque heads) is
 * an honorary atom to Ring 3 collection.
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

const rational = (n, d = 1n) => ({ kind: 'rational', numerator: n, denominator: d });

function conjugateOf(argExpr) {
  return `Exact.Expression.make(Exact.Expression.Conjugate, [${argExpr}])`;
}

Deno.test("Exact.Expression.Conjugate is the registered Symbol.for('Conjugate')", () => {
  const session = run(`
    let same = Exact.Expression.Conjugate === Symbol.for('Conjugate');
  `);
  assertEquals(session.get(0, 'same'), true);
});

Deno.test("Conjugate(x) stays symbolic under simplify", () => {
  const session = run(`
    let e = Exact.Expression.simplify(${conjugateOf(`Symbol.for('x')`)});
  `);
  const value = session.getExact(0, 'e');
  assertEquals(value.kind, 'expression');
  assertEquals(value.head.description, 'Conjugate');
  assertEquals(value.arguments[0].description, 'x');
});

Deno.test("Conjugate(Conjugate(x)) collapses to x", () => {
  const session = run(`
    let e = Exact.Expression.simplify(${conjugateOf(conjugateOf(`Symbol.for('x')`))});
  `);
  const value = session.getExact(0, 'e');
  assertEquals(value.kind, 'symbol');
  assertEquals(value.description, 'x');
});

Deno.test("Conjugate folds on Rational and BigInt atoms (identity)", () => {
  const session = run(`
    let a = Exact.Expression.simplify(${conjugateOf('5n')});
    let b = Exact.Expression.simplify(${conjugateOf('Exact.rational(2n, 3n)')});
  `);
  assertEquals(session.getExact(0, 'a'), 5n);
  assertEquals(session.getExact(0, 'b'), rational(2n, 3n));
});

Deno.test("Conjugate folds on Complex atoms (flips imaginary)", () => {
  const session = run(`
    let e = Exact.Expression.simplify(${conjugateOf('Exact.complex(3n, 4n)')});
  `);
  const value = session.getExact(0, 'e');
  assertEquals(value.kind, 'complex');
  assertEquals(value.real, rational(3n));
  assertEquals(value.imaginary, rational(-4n));
});

Deno.test("Conjugate distributes over Add (Ring 5 (5a) — the Ring 4 Q5 deferral)", () => {
  const session = run(`
    let sum = Exact.Expression.add(Symbol.for('x'), Symbol.for('y'));
    let e = Exact.Expression.simplify(${conjugateOf('sum')});
  `);
  const value = session.getExact(0, 'e');
  assertEquals(value.head.description, 'Add');
  assertEquals(value.arguments[0].head.description, 'Conjugate');
  assertEquals(value.arguments[1].head.description, 'Conjugate');
});

Deno.test("Conjugate(x) is an honorary atom to collection", () => {
  const session = run(`
    let c = ${conjugateOf(`Symbol.for('x')`)};
    let e = Exact.Expression.simplify(Exact.Expression.add(c, c));
  `);
  const value = session.getExact(0, 'e');
  // Conjugate(x) + Conjugate(x) collects to 2 * Conjugate(x).
  assertEquals(value.head.description, 'Multiply');
  assertEquals(value.arguments[0], rational(2n));
  assertEquals(value.arguments[1].head.description, 'Conjugate');
});

Deno.test("inner numeric fold feeds the double-conjugate collapse", () => {
  const session = run(`
    let e = Exact.Expression.simplify(${conjugateOf(conjugateOf('Exact.complex(1n, 2n)'))});
  `);
  // Inner Conjugate folds to 1-2i, outer folds back to 1+2i.
  const value = session.getExact(0, 'e');
  assertEquals(value.kind, 'complex');
  assertEquals(value.real, rational(1n));
  assertEquals(value.imaginary, rational(2n));
});

Deno.test("simplify with Matrix atoms inside Add sorts without crashing", () => {
  // The comparator's class-2 branch reads Expression fields; Matrix
  // atoms need their own class (4b comparator fix). This exercises
  // the sort path: Add over [Matrix, Symbol, numeric].
  const session = run(`
    let m = Exact.Matrix.make([[1n, 2n]]);
    let e = Exact.Expression.simplify(
      Exact.Expression.make(Exact.Expression.Add, [m, Symbol.for('x'), 3n]));
  `);
  const value = session.getExact(0, 'e');
  assertEquals(value.kind, 'expression');
  assertEquals(value.head.description, 'Add');
  assertEquals(value.arguments.length, 3);
});

Deno.test("Add(M, M) collects Matrix atoms like any atom", () => {
  const session = run(`
    let m = Exact.Matrix.make([[1n, 2n]]);
    let e = Exact.Expression.simplify(
      Exact.Expression.make(Exact.Expression.Add, [m, m]));
  `);
  const value = session.getExact(0, 'e');
  assertEquals(value.head.description, 'Multiply');
  assertEquals(value.arguments[0], rational(2n));
  assertEquals(value.arguments[1].kind, 'matrix');
});

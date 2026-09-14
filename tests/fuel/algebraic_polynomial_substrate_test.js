/**
 * Ring 6 (6a) — the expression boundary and dense-substrate
 * normalisation behind Exact.AlgebraicNumber.rootsOfPolynomial:
 * degree extraction, coefficient validation, denominator clearing,
 * content/sign normalisation, squarefree reduction, and the
 * degree-0/1 renormalisation rules. The substrate itself (dense
 * integer polynomials, primitive PRS, Sturm chains) is internal —
 * everything here exercises it through the public surface.
 */

import { assertEquals } from "https://deno.land/std@0.208.0/assert/mod.ts";
import { parseAndSetup } from './test-helpers.js';
import { freshSession } from '../../src/host-owned-session.js';

function run(source) {
  const session = freshSession();
  parseAndSetup(session, source);
  const result = session.run(0, 100000000);
  if (result.status === 'error') {
    throw new Error(`Error: ${result.error?.message ?? JSON.stringify(result)}`);
  }
  return session;
}

// ---------- degree-1 renormalisation ----------

Deno.test("degree 1: x - 2 renormalises to the Rational root 2", () => {
  const session = run(`
    let x = Symbol.for('x');
    let roots = Exact.AlgebraicNumber.rootsOfPolynomial(
      Exact.Expression.subtract(x, 2n), x);
    let count = roots.length;
    let value = roots[0] === 2n || Exact.AlgebraicNumber.equals(roots[0], 2n);
    let tof = Exact.typeOf(roots[0]);
  `);
  assertEquals(session.get(0, 'count'), 1);
  assertEquals(session.get(0, 'value'), true);
  assertEquals(session.get(0, 'tof'), 'integer');
});

Deno.test("degree 1 with denominator clearing: 2x - 3 gives 3/2", () => {
  const session = run(`
    let x = Symbol.for('x');
    let roots = Exact.AlgebraicNumber.rootsOfPolynomial(
      Exact.Expression.subtract(Exact.Expression.multiply(2n, x), 3n), x);
    let isThreeHalves = Exact.AlgebraicNumber.equals(roots[0], Exact.rational(3n, 2n));
  `);
  assertEquals(session.get(0, 'isThreeHalves'), true);
});

Deno.test("rational coefficients clear denominators: x^2/4 - 1/2 has the roots of x^2 - 2", () => {
  const session = run(`
    let x = Symbol.for('x');
    let scaled = Exact.AlgebraicNumber.rootsOfPolynomial(
      Exact.Expression.subtract(
        Exact.Expression.multiply(Exact.rational(1n, 4n), Exact.Expression.power(x, 2n)),
        Exact.rational(1n, 2n)), x);
    let plain = Exact.AlgebraicNumber.rootsOfPolynomial(
      Exact.Expression.subtract(Exact.Expression.power(x, 2n), 2n), x);
    let sameNegative = Exact.AlgebraicNumber.equals(scaled[0], plain[0]);
    let samePositive = Exact.AlgebraicNumber.equals(scaled[1], plain[1]);
  `);
  assertEquals(session.get(0, 'sameNegative'), true);
  assertEquals(session.get(0, 'samePositive'), true);
});

// ---------- squarefree reduction ----------

Deno.test("repeated roots collapse: (x - 1)^2 has the single root 1", () => {
  const session = run(`
    let x = Symbol.for('x');
    let square = Exact.Expression.expand(Exact.Expression.power(
      Exact.Expression.subtract(x, 1n), 2n));
    let roots = Exact.AlgebraicNumber.rootsOfPolynomial(square, x);
    let count = roots.length;
    let isOne = Exact.AlgebraicNumber.equals(roots[0], 1n);
  `);
  assertEquals(session.get(0, 'count'), 1);
  assertEquals(session.get(0, 'isOne'), true);
});

Deno.test("mixed multiplicities: (x - 1)^2 (x + 2) has exactly the roots -2 and 1", () => {
  const session = run(`
    let x = Symbol.for('x');
    let poly = Exact.Expression.expand(Exact.Expression.multiply(
      Exact.Expression.power(Exact.Expression.subtract(x, 1n), 2n),
      Exact.Expression.add(x, 2n)));
    let roots = Exact.AlgebraicNumber.rootsOfPolynomial(poly, x);
    let count = roots.length;
    let first = Exact.AlgebraicNumber.equals(roots[0], 0n - 2n);
    let second = Exact.AlgebraicNumber.equals(roots[1], 1n);
  `);
  assertEquals(session.get(0, 'count'), 2);
  assertEquals(session.get(0, 'first'), true);
  assertEquals(session.get(0, 'second'), true);
});

// ---------- sign normalisation ----------

Deno.test("negative leading coefficient normalises: 2 - x^2 has the roots of x^2 - 2", () => {
  const session = run(`
    let x = Symbol.for('x');
    let flipped = Exact.AlgebraicNumber.rootsOfPolynomial(
      Exact.Expression.subtract(2n, Exact.Expression.power(x, 2n)), x);
    let plain = Exact.AlgebraicNumber.rootsOfPolynomial(
      Exact.Expression.subtract(Exact.Expression.power(x, 2n), 2n), x);
    let sameNegative = Exact.AlgebraicNumber.equals(flipped[0], plain[0]);
    let samePositive = Exact.AlgebraicNumber.equals(flipped[1], plain[1]);
    // The stored defining polynomial keeps a positive leading coefficient.
    let coefficients = Exact.AlgebraicNumber.definingPolynomial(flipped[1]);
    let sameDefining = Exact.Expression.equal(coefficients,
      Exact.AlgebraicNumber.definingPolynomial(plain[1]));
  `);
  assertEquals(session.get(0, 'sameNegative'), true);
  assertEquals(session.get(0, 'samePositive'), true);
  assertEquals(session.get(0, 'sameDefining'), true);
});

// ---------- degenerate degrees ----------

Deno.test("degree 0: a nonzero constant has no roots", () => {
  const session = run(`
    let x = Symbol.for('x');
    let roots = Exact.AlgebraicNumber.rootsOfPolynomial(5n, x);
    let count = roots.length;
    let frozen = Array.isFrozen(roots);
  `);
  assertEquals(session.get(0, 'count'), 0);
  assertEquals(session.get(0, 'frozen'), true);
});

Deno.test("no real roots: x^2 + 1 returns the empty Array", () => {
  const session = run(`
    let x = Symbol.for('x');
    let roots = Exact.AlgebraicNumber.rootsOfPolynomial(
      Exact.Expression.add(Exact.Expression.power(x, 2n), 1n), x);
    let count = roots.length;
  `);
  assertEquals(session.get(0, 'count'), 0);
});

Deno.test("the zero polynomial throws RangeError", () => {
  const session = run(`
    let x = Symbol.for('x');
    let message = false;
    try { Exact.AlgebraicNumber.rootsOfPolynomial(0n, x); }
    catch (e) { message = e.message; }
    let viaExpression = false;
    try { Exact.AlgebraicNumber.rootsOfPolynomial(Exact.Expression.subtract(x, x), x); }
    catch (e) { viaExpression = e.message; }
  `);
  const expected = 'Exact.AlgebraicNumber.rootsOfPolynomial: the zero polynomial has every value as a root';
  assertEquals(session.get(0, 'message'), expected);
  assertEquals(session.get(0, 'viaExpression'), expected);
});

// ---------- validation ----------

Deno.test("variable must be a Symbol", () => {
  const session = run(`
    let x = Symbol.for('x');
    let message = false;
    try { Exact.AlgebraicNumber.rootsOfPolynomial(Exact.Expression.subtract(x, 1n), 'x'); }
    catch (e) { message = e.message; }
  `);
  assertEquals(session.get(0, 'message'),
    'Exact.AlgebraicNumber.rootsOfPolynomial: variable must be a Symbol');
});

Deno.test("symbolic coefficients are rejected in 6a", () => {
  const session = run(`
    let x = Symbol.for('x');
    let y = Symbol.for('y');
    let message = false;
    try {
      Exact.AlgebraicNumber.rootsOfPolynomial(
        Exact.Expression.subtract(Exact.Expression.power(x, 2n), y), x);
    } catch (e) { message = e.message; }
    let constant = false;
    try { Exact.AlgebraicNumber.rootsOfPolynomial(y, x); }
    catch (e) { constant = e.message; }
  `);
  const expected = 'Exact.AlgebraicNumber.rootsOfPolynomial: coefficients must be rational numerics';
  assertEquals(session.get(0, 'message'), expected);
  assertEquals(session.get(0, 'constant'), expected);
});

Deno.test("Complex coefficients are rejected (real ring)", () => {
  const session = run(`
    let x = Symbol.for('x');
    let message = false;
    try {
      Exact.AlgebraicNumber.rootsOfPolynomial(
        Exact.Expression.subtract(Exact.Expression.power(x, 2n), Exact.i), x);
    } catch (e) { message = e.message; }
  `);
  assertEquals(session.get(0, 'message'),
    'Exact.AlgebraicNumber.rootsOfPolynomial: coefficients must be rational numerics');
});

Deno.test("non-polynomial input throws: negative and non-integer exponents", () => {
  const session = run(`
    let x = Symbol.for('x');
    let negative = false;
    try {
      Exact.AlgebraicNumber.rootsOfPolynomial(Exact.Expression.divide(1n, x), x);
    } catch (e) { negative = e.message; }
    let fractional = false;
    try {
      Exact.AlgebraicNumber.rootsOfPolynomial(
        Exact.Expression.power(x, Exact.rational(1n, 2n)), x);
    } catch (e) { fractional = e.message; }
  `);
  const expected = 'Exact.AlgebraicNumber.rootsOfPolynomial: expression is not a polynomial in the variable';
  assertEquals(session.get(0, 'negative'), expected);
  assertEquals(session.get(0, 'fractional'), expected);
});

Deno.test("absurd degrees refuse loudly instead of wrapping i32 arithmetic", () => {
  const session = run(`
    let x = Symbol.for('x');
    let message = false;
    try {
      Exact.AlgebraicNumber.rootsOfPolynomial(
        Exact.Expression.power(x, 1099511627776n), x);
    } catch (e) { message = e.message; }
  `);
  assertEquals(session.get(0, 'message'),
    'Exact.AlgebraicNumber.rootsOfPolynomial: polynomial degree is too large for isolation');
});

// ---------- result shape ----------

Deno.test("results are frozen Arrays; shared defining polynomial across sibling roots", () => {
  const session = run(`
    let x = Symbol.for('x');
    let roots = Exact.AlgebraicNumber.rootsOfPolynomial(
      Exact.Expression.subtract(Exact.Expression.power(x, 2n), 2n), x);
    let frozen = Array.isFrozen(roots);
    let sameDefining = Exact.Expression.equal(
      Exact.AlgebraicNumber.definingPolynomial(roots[0]),
      Exact.AlgebraicNumber.definingPolynomial(roots[1]));
  `);
  assertEquals(session.get(0, 'frozen'), true);
  assertEquals(session.get(0, 'sameDefining'), true);
});

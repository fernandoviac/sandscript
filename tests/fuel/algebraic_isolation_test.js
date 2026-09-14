/**
 * Ring 6 (6a) — real-root isolation: Sturm counting through the
 * public surface, interval invariants, ascending order, rational-root
 * extraction (dyadic bisection hits), and semantic equality across
 * different defining polynomials (squarefree, not minimal — the
 * gcd + Sturm overlap decision).
 */

import { assertEquals } from "https://deno.land/std@0.208.0/assert/mod.ts";
import { parseAndSetup } from './test-helpers.js';
import { freshSession } from '../../src/host-owned-session.js';

function run(source) {
  const session = freshSession();
  parseAndSetup(session, source);
  const result = session.run(0, 1000000000);
  if (result.status === 'error') {
    throw new Error(`Error: ${result.error?.message ?? JSON.stringify(result)}`);
  }
  if (result.status !== 'done') {
    throw new Error(`run ended ${result.status}`);
  }
  return session;
}

// ---------- the flagship values ----------

Deno.test("x^2 - 2: two roots, negative first, ±√2 by approximation", () => {
  const session = run(`
    let x = Symbol.for('x');
    let roots = Exact.AlgebraicNumber.rootsOfPolynomial(
      Exact.Expression.subtract(Exact.Expression.power(x, 2n), 2n), x);
    let count = roots.length;
    let ordered = Exact.AlgebraicNumber.compare(roots[0], roots[1]);
    let negativeSign = Exact.AlgebraicNumber.sign(roots[0]);
    let positiveSign = Exact.AlgebraicNumber.sign(roots[1]);
    let approx = Exact.AlgebraicNumber.toApproximation(roots[1], 0n - 48n);
  `);
  assertEquals(session.get(0, 'count'), 2);
  assertEquals(session.get(0, 'ordered'), -1);
  assertEquals(session.get(0, 'negativeSign'), -1);
  assertEquals(session.get(0, 'positiveSign'), 1);
  const approx = session.get(0, 'approx');
  if (Math.abs(approx - Math.SQRT2) > 1e-12) {
    throw new Error(`√2 approximation off: ${approx}`);
  }
});

Deno.test("x^2 - 3: negative root first, √3 by approximation", () => {
  const session = run(`
    let x = Symbol.for('x');
    let roots = Exact.AlgebraicNumber.rootsOfPolynomial(
      Exact.Expression.subtract(Exact.Expression.power(x, 2n), 3n), x);
    let count = roots.length;
    let negativeFirst = Exact.AlgebraicNumber.sign(roots[0]) === (0 - 1);
    let approx = Exact.AlgebraicNumber.toApproximation(roots[1], 0n - 48n);
  `);
  assertEquals(session.get(0, 'count'), 2);
  assertEquals(session.get(0, 'negativeFirst'), true);
  const approx = session.get(0, 'approx');
  if (Math.abs(approx - Math.sqrt(3)) > 1e-12) {
    throw new Error(`√3 approximation off: ${approx}`);
  }
});

Deno.test("x^3 - 2: exactly one real root, the cube root of 2", () => {
  const session = run(`
    let x = Symbol.for('x');
    let roots = Exact.AlgebraicNumber.rootsOfPolynomial(
      Exact.Expression.subtract(Exact.Expression.power(x, 3n), 2n), x);
    let count = roots.length;
    let approx = Exact.AlgebraicNumber.toApproximation(roots[0], 0n - 48n);
  `);
  assertEquals(session.get(0, 'count'), 1);
  const approx = session.get(0, 'approx');
  if (Math.abs(approx - Math.cbrt(2)) > 1e-12) {
    throw new Error(`∛2 approximation off: ${approx}`);
  }
});

// ---------- interval invariants ----------

Deno.test("the isolating interval strictly brackets the root and excludes zero endpoints", () => {
  const session = run(`
    let x = Symbol.for('x');
    let sqrt2 = Exact.AlgebraicNumber.rootsOfPolynomial(
      Exact.Expression.subtract(Exact.Expression.power(x, 2n), 2n), x)[1];
    let interval = Exact.AlgebraicNumber.isolatingInterval(sqrt2);
    let ordered = interval[0] < interval[1];
    let aboveLow = Exact.AlgebraicNumber.compare(sqrt2, interval[0]);
    let belowHigh = Exact.AlgebraicNumber.compare(sqrt2, interval[1]);
    // The defining polynomial is nonzero at both endpoints: substituting
    // an endpoint and simplifying yields a nonzero numeric.
    let dp = Exact.AlgebraicNumber.definingPolynomial(sqrt2);
    let atLow = Exact.Expression.simplify(
      Exact.Expression.substitute(dp, x, interval[0]));
    let atHigh = Exact.Expression.simplify(
      Exact.Expression.substitute(dp, x, interval[1]));
    let lowNonzero = atLow !== 0n && !Exact.Expression.equal(atLow, 0n);
    let highNonzero = atHigh !== 0n && !Exact.Expression.equal(atHigh, 0n);
  `);
  assertEquals(session.get(0, 'ordered'), true);
  assertEquals(session.get(0, 'aboveLow'), 1);
  assertEquals(session.get(0, 'belowHigh'), -1);
  assertEquals(session.get(0, 'lowNonzero'), true);
  assertEquals(session.get(0, 'highNonzero'), true);
});

// ---------- rational roots inside higher-degree polynomials ----------

Deno.test("(2x - 1)(3x - 1): the rational roots 1/3 and 1/2, in order", () => {
  const session = run(`
    let x = Symbol.for('x');
    let poly = Exact.Expression.expand(Exact.Expression.multiply(
      Exact.Expression.subtract(Exact.Expression.multiply(2n, x), 1n),
      Exact.Expression.subtract(Exact.Expression.multiply(3n, x), 1n)));
    let roots = Exact.AlgebraicNumber.rootsOfPolynomial(poly, x);
    let count = roots.length;
    let firstIsThird = Exact.AlgebraicNumber.equals(roots[0], Exact.rational(1n, 3n));
    let secondIsHalf = Exact.AlgebraicNumber.equals(roots[1], Exact.rational(1n, 2n));
  `);
  assertEquals(session.get(0, 'count'), 2);
  assertEquals(session.get(0, 'firstIsThird'), true);
  assertEquals(session.get(0, 'secondIsHalf'), true);
});

Deno.test("mixed rational/irrational output sorts ascending: (2x - 1)(x^2 - 2)", () => {
  const session = run(`
    let x = Symbol.for('x');
    let poly = Exact.Expression.expand(Exact.Expression.multiply(
      Exact.Expression.subtract(Exact.Expression.multiply(2n, x), 1n),
      Exact.Expression.subtract(Exact.Expression.power(x, 2n), 2n)));
    let roots = Exact.AlgebraicNumber.rootsOfPolynomial(poly, x);
    let count = roots.length;
    let negativeSqrt2 = Exact.AlgebraicNumber.sign(roots[0]) === (0 - 1);
    let middleIsHalf = Exact.AlgebraicNumber.equals(roots[1], Exact.rational(1n, 2n));
    let ascending = Exact.AlgebraicNumber.compare(roots[0], roots[1]) === (0 - 1)
      && Exact.AlgebraicNumber.compare(roots[1], roots[2]) === (0 - 1);
  `);
  assertEquals(session.get(0, 'count'), 3);
  assertEquals(session.get(0, 'negativeSqrt2'), true);
  assertEquals(session.get(0, 'middleIsHalf'), true);
  assertEquals(session.get(0, 'ascending'), true);
});

Deno.test("x^2 - 1: rational values represented algebraically still decide equality", () => {
  // ±1 are isolated as count-1 intervals before bisection ever lands
  // on them — the representation stays algebraic (squarefree, not
  // minimal; not canonical by type) but equals/compare decide right.
  const session = run(`
    let x = Symbol.for('x');
    let roots = Exact.AlgebraicNumber.rootsOfPolynomial(
      Exact.Expression.subtract(Exact.Expression.power(x, 2n), 1n), x);
    let count = roots.length;
    let minusOne = Exact.AlgebraicNumber.equals(roots[0], 0n - 1n);
    let plusOne = Exact.AlgebraicNumber.equals(roots[1], 1n);
    let notEqual = Exact.AlgebraicNumber.equals(roots[0], roots[1]);
    // Refining an interval whose root IS rational bisects onto it —
    // the exact-hit branch must keep narrowing, not stall or corrupt.
    let approx = Exact.AlgebraicNumber.toApproximation(roots[1], 0n - 30n);
  `);
  assertEquals(session.get(0, 'count'), 2);
  assertEquals(session.get(0, 'minusOne'), true);
  assertEquals(session.get(0, 'plusOne'), true);
  assertEquals(session.get(0, 'notEqual'), false);
  assertEquals(session.get(0, 'approx'), 1);
});

// ---------- Wilkinson-style stress ----------

Deno.test("Wilkinson degree 10: all ten roots found and equal to 1..10", () => {
  const session = run(`
    let x = Symbol.for('x');
    let w = Exact.Expression.subtract(x, 1n);
    for (let k = 2n; k <= 10n; k = k + 1n) {
      w = Exact.Expression.multiply(w, Exact.Expression.subtract(x, k));
    }
    w = Exact.Expression.expand(w);
    let roots = Exact.AlgebraicNumber.rootsOfPolynomial(w, x);
    let count = roots.length;
    let allMatch = true;
    let expected = 1n;
    for (let k = 0; k < 10; k = k + 1) {
      allMatch = allMatch && Exact.AlgebraicNumber.equals(roots[k], expected);
      expected = expected + 1n;
    }
  `);
  assertEquals(session.get(0, 'count'), 10);
  assertEquals(session.get(0, 'allMatch'), true);
});

// ---------- semantic equality across defining polynomials ----------

Deno.test("√2 from x^2 - 2 equals √2 from (x^2 - 2)(x^2 - 3); √3 does not", () => {
  const session = run(`
    let x = Symbol.for('x');
    let sqrt2 = Exact.AlgebraicNumber.rootsOfPolynomial(
      Exact.Expression.subtract(Exact.Expression.power(x, 2n), 2n), x)[1];
    let quartic = Exact.Expression.expand(Exact.Expression.multiply(
      Exact.Expression.subtract(Exact.Expression.power(x, 2n), 2n),
      Exact.Expression.subtract(Exact.Expression.power(x, 2n), 3n)));
    let roots = Exact.AlgebraicNumber.rootsOfPolynomial(quartic, x);
    let count = roots.length;
    let sameRoot = Exact.AlgebraicNumber.equals(sqrt2, roots[2]);
    let differentRoot = Exact.AlgebraicNumber.equals(sqrt2, roots[3]);
    let comparedBelow = Exact.AlgebraicNumber.compare(sqrt2, roots[3]);
  `);
  assertEquals(session.get(0, 'count'), 4);
  assertEquals(session.get(0, 'sameRoot'), true);
  assertEquals(session.get(0, 'differentRoot'), false);
  assertEquals(session.get(0, 'comparedBelow'), -1);
});

Deno.test("ordering forces refinement: √2 < 3/2 < √3, and 1414/1000 < √2 < 1415/1000", () => {
  const session = run(`
    let x = Symbol.for('x');
    let sqrt2 = Exact.AlgebraicNumber.rootsOfPolynomial(
      Exact.Expression.subtract(Exact.Expression.power(x, 2n), 2n), x)[1];
    let sqrt3 = Exact.AlgebraicNumber.rootsOfPolynomial(
      Exact.Expression.subtract(Exact.Expression.power(x, 2n), 3n), x)[1];
    let below = Exact.AlgebraicNumber.compare(sqrt2, Exact.rational(3n, 2n));
    let above = Exact.AlgebraicNumber.compare(sqrt3, Exact.rational(3n, 2n));
    let tightLow = Exact.AlgebraicNumber.compare(sqrt2, Exact.rational(1414n, 1000n));
    let tightHigh = Exact.AlgebraicNumber.compare(sqrt2, Exact.rational(1415n, 1000n));
    let crossPolynomial = Exact.AlgebraicNumber.compare(sqrt2, sqrt3);
  `);
  assertEquals(session.get(0, 'below'), -1);
  assertEquals(session.get(0, 'above'), 1);
  assertEquals(session.get(0, 'tightLow'), 1);
  assertEquals(session.get(0, 'tightHigh'), -1);
  assertEquals(session.get(0, 'crossPolynomial'), -1);
});

Deno.test("golden ratio: the positive root of x^2 - x - 1", () => {
  const session = run(`
    let x = Symbol.for('x');
    let roots = Exact.AlgebraicNumber.rootsOfPolynomial(
      Exact.Expression.subtract(
        Exact.Expression.subtract(Exact.Expression.power(x, 2n), x), 1n), x);
    let count = roots.length;
    let phi = Exact.AlgebraicNumber.toApproximation(roots[1], 0n - 48n);
  `);
  assertEquals(session.get(0, 'count'), 2);
  const phi = session.get(0, 'phi');
  if (Math.abs(phi - (1 + Math.sqrt(5)) / 2) > 1e-12) {
    throw new Error(`φ approximation off: ${phi}`);
  }
});

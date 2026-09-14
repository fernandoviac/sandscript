/**
 * Ring 6 (6b) — field arithmetic on AlgebraicNumbers: the numeric
 * tower operator dispatch (+ − * / and unary −) over
 * {AlgebraicNumber, Rational, BigInt} pairs, resultant composition
 * with root selection, degree-preserving affine fast paths, division
 * guards, coercion refusals for Float/Complex mixes, and pressure
 * recovery on small heaps.
 *
 * Shared-field arithmetic reduces coordinate polynomials modulo the field
 * generator before falling back to resultant composition. When that exact
 * reduction lands in Q, the result renormalises immediately to Rational;
 * this is load-bearing for self-products such as √2·√2, whose generic
 * resultant representation used to inflate before later factorization.
 */

import { assertEquals, assert } from "https://deno.land/std@0.208.0/assert/mod.ts";
import { parseAndSetup } from './test-helpers.js';
import { freshSession } from '../../src/host-owned-session.js';

function run(source, options = {}) {
  const session = freshSession(options);
  parseAndSetup(session, source);
  let result = session.run(0, 1000000000);
  let rounds = 0;
  while (result.status === 'memory_pressure' && rounds < 500) {
    session.gc();
    result = session.run(0, 1000000000);
    rounds++;
  }
  if (result.status === 'error') {
    throw new Error(`Error: ${result.error?.message ?? JSON.stringify(result)}`);
  }
  if (result.status !== 'done') {
    throw new Error(`run ended ${result.status}`);
  }
  return session;
}

const ROOTS_SETUP = `
  let sqrt2 = Exact.AlgebraicNumber.squareRoot(2n);
  let sqrt3 = Exact.AlgebraicNumber.squareRoot(3n);
  let sqrt6 = Exact.AlgebraicNumber.squareRoot(6n);
`;

// ---------- the flagship: multiplicative structure is decidable ----------

Deno.test("flagship: sqrt2 * sqrt3 equals sqrt6", () => {
  const session = run(ROOTS_SETUP + `
    let product = sqrt2 * sqrt3;
    let flagship = Exact.AlgebraicNumber.equals(product, sqrt6);
    let stillAlgebraic = Exact.AlgebraicNumber.isAlgebraicNumber(product);
  `);
  assertEquals(session.get(0, 'flagship'), true);
  assertEquals(session.get(0, 'stillAlgebraic'), true);
});

Deno.test("same-field reduction canonicalizes sqrt2 * sqrt2 to Rational 2", () => {
  const session = run(ROOTS_SETUP + `
    let squared = sqrt2 * sqrt2;
    let isTwo = Exact.AlgebraicNumber.equals(squared, 2n);
    let stillAlgebraic = Exact.AlgebraicNumber.isAlgebraicNumber(squared);
    let sign = Exact.AlgebraicNumber.sign(squared);
  `);
  assertEquals(session.get(0, 'isTwo'), true);
  assertEquals(session.get(0, 'stillAlgebraic'), false);
  assertEquals(session.get(0, 'sign'), 1);
});

Deno.test("(sqrt2 + sqrt3)^2 - 5 equals 2*sqrt6", () => {
  const session = run(ROOTS_SETUP + `
    let s = sqrt2 + sqrt3;
    let p = s * s;
    let back = p - 5n;
    let check = Exact.AlgebraicNumber.equals(back, 2n * sqrt6);
  `, { heapSize: 1024 * 1024 });
  assertEquals(session.get(0, 'check'), true);
});

Deno.test("1/sqrt2 equals sqrt2/2", () => {
  const session = run(ROOTS_SETUP + `
    let inverse = 1n / sqrt2;
    let half = sqrt2 / 2n;
    let check = Exact.AlgebraicNumber.equals(inverse, half);
    let doubled = inverse * 2n;
    let backToRoot = Exact.AlgebraicNumber.equals(doubled, sqrt2);
  `);
  assertEquals(session.get(0, 'check'), true);
  assertEquals(session.get(0, 'backToRoot'), true);
});

Deno.test("quotient of radicals: sqrt6 / sqrt2 equals sqrt3", () => {
  const session = run(ROOTS_SETUP + `
    let quotient = sqrt6 / sqrt2;
    let check = Exact.AlgebraicNumber.equals(quotient, sqrt3);
  `);
  assertEquals(session.get(0, 'check'), true);
});

Deno.test("difference: (sqrt2 + sqrt3) - sqrt3 equals sqrt2", () => {
  const session = run(ROOTS_SETUP + `
    let sum = sqrt2 + sqrt3;
    let diff = sum - sqrt3;
    let check = Exact.AlgebraicNumber.equals(diff, sqrt2);
  `);
  assertEquals(session.get(0, 'check'), true);
});

Deno.test("sqrt2 - sqrt2 is exactly zero", () => {
  const session = run(ROOTS_SETUP + `
    let zero = sqrt2 - sqrt2;
    let isZero = Exact.AlgebraicNumber.isZero(zero);
    let sign = Exact.AlgebraicNumber.sign(zero);
  `);
  assertEquals(session.get(0, 'isZero'), true);
  assertEquals(session.get(0, 'sign'), 0);
});

// ---------- cube roots: beyond square-root towers ----------

Deno.test("cube root arithmetic: cbrt2^3 equals 2, cbrt2 * cbrt4 equals 2", () => {
  const session = run(`
    let cbrt2 = Exact.AlgebraicNumber.nthRoot(2n, 3n);
    let cbrt4 = Exact.AlgebraicNumber.nthRoot(4n, 3n);
    let cubed = cbrt2 * cbrt2 * cbrt2;
    let cubedIsTwo = Exact.AlgebraicNumber.equals(cubed, 2n);
    let mixed = cbrt2 * cbrt4;
    let mixedIsTwo = Exact.AlgebraicNumber.equals(mixed, 2n);
  `, { heapSize: 1024 * 1024 });
  assertEquals(session.get(0, 'cubedIsTwo'), true);
  assertEquals(session.get(0, 'mixedIsTwo'), true);
});

// ---------- mixed tower arithmetic (affine fast paths) ----------

Deno.test("mixed shifts round-trip: (sqrt2 + 3/2) - 3/2 equals sqrt2", () => {
  const session = run(ROOTS_SETUP + `
    let shifted = sqrt2 + Exact.rational(3n, 2n);
    let back = shifted - Exact.rational(3n, 2n);
    let check = Exact.AlgebraicNumber.equals(back, sqrt2);
    let stillAlgebraic = Exact.AlgebraicNumber.isAlgebraicNumber(shifted);
  `);
  assertEquals(session.get(0, 'check'), true);
  assertEquals(session.get(0, 'stillAlgebraic'), true);
});

Deno.test("mixed scaling: (sqrt2 * 3n) / 3n equals sqrt2, both operand orders", () => {
  const session = run(ROOTS_SETUP + `
    let tripled = sqrt2 * 3n;
    let back = tripled / 3n;
    let check = Exact.AlgebraicNumber.equals(back, sqrt2);
    let leftScaled = Exact.rational(-2n, 3n) * sqrt2;
    let rightScaled = sqrt2 * Exact.rational(-2n, 3n);
    let sameBothWays = Exact.AlgebraicNumber.equals(leftScaled, rightScaled);
    let negativeNow = Exact.AlgebraicNumber.sign(leftScaled);
  `);
  assertEquals(session.get(0, 'check'), true);
  assertEquals(session.get(0, 'sameBothWays'), true);
  assertEquals(session.get(0, 'negativeNow'), -1);
});

Deno.test("bigint and rational operands both dispatch: 1n + sqrt2, 1/2 + sqrt2", () => {
  const session = run(ROOTS_SETUP + `
    let a = 1n + sqrt2;
    let b = sqrt2 + 1n;
    let symmetric = Exact.AlgebraicNumber.equals(a, b);
    let c = Exact.rational(1n, 2n) + sqrt2;
    let d = c - sqrt2;
    let halfBack = Exact.AlgebraicNumber.equals(d, Exact.rational(1n, 2n));
    let e = 3n - sqrt2;
    let f = -(sqrt2 - 3n);
    let reversedSubtract = Exact.AlgebraicNumber.equals(e, f);
  `);
  assertEquals(session.get(0, 'symmetric'), true);
  assertEquals(session.get(0, 'halfBack'), true);
  assertEquals(session.get(0, 'reversedSubtract'), true);
});

Deno.test("additive zero and multiplicative identities pass through", () => {
  const session = run(ROOTS_SETUP + `
    let plusZero = sqrt2 + 0n;
    let sameValue = Exact.AlgebraicNumber.equals(plusZero, sqrt2);
    let timesZero = sqrt2 * 0n;
    let zeroTyped = Exact.typeOf(timesZero);
    let zeroLeft = 0n * sqrt2;
    let zeroLeftTyped = Exact.typeOf(zeroLeft);
    let zeroOver = 0n / sqrt2;
    let zeroOverIsZero = Exact.AlgebraicNumber.isZero(zeroOver);
  `);
  assertEquals(session.get(0, 'sameValue'), true);
  assertEquals(session.get(0, 'zeroTyped'), 'integer');
  assertEquals(session.get(0, 'zeroLeftTyped'), 'integer');
  assertEquals(session.get(0, 'zeroOverIsZero'), true);
});

// ---------- unary negation ----------

Deno.test("unary negation: -sqrt2 flips sign and round-trips", () => {
  const session = run(ROOTS_SETUP + `
    let negated = -sqrt2;
    let sign = Exact.AlgebraicNumber.sign(negated);
    let doubleNegated = -negated;
    let roundTrip = Exact.AlgebraicNumber.equals(doubleNegated, sqrt2);
    let sumWithNegation = sqrt2 + negated;
    let cancels = Exact.AlgebraicNumber.isZero(sumWithNegation);
  `);
  assertEquals(session.get(0, 'sign'), -1);
  assertEquals(session.get(0, 'roundTrip'), true);
  assertEquals(session.get(0, 'cancels'), true);
});

// ---------- ordering through compare ----------

Deno.test("ordering: sqrt2 < 3/2 < sqrt3", () => {
  const session = run(ROOTS_SETUP + `
    let left = Exact.AlgebraicNumber.compare(sqrt2, Exact.rational(3n, 2n));
    let right = Exact.AlgebraicNumber.compare(Exact.rational(3n, 2n), sqrt3);
    let direct = Exact.AlgebraicNumber.compare(sqrt2, sqrt3);
  `);
  assertEquals(session.get(0, 'left'), -1);
  assertEquals(session.get(0, 'right'), -1);
  assertEquals(session.get(0, 'direct'), -1);
});

// ---------- division guards ----------

Deno.test("division by exact algebraic zero throws RangeError", () => {
  const session = run(ROOTS_SETUP + `
    let zero = sqrt2 - sqrt2;
    let caught = false;
    try { let q = sqrt3 / zero; } catch (e) { caught = true; }
    let caughtRational = false;
    try { let q2 = 1n / zero; } catch (e) { caughtRational = true; }
    let caughtByRationalZero = false;
    try { let q3 = sqrt2 / 0n; } catch (e) { caughtByRationalZero = true; }
  `);
  assertEquals(session.get(0, 'caught'), true);
  assertEquals(session.get(0, 'caughtRational'), true);
  assertEquals(session.get(0, 'caughtByRationalZero'), true);
});

// ---------- coercion refusals: exactness never leaks ----------

Deno.test("Float mixes refuse while legacy Complex crosses into the exact algebraic tower", () => {
  const session = run(ROOTS_SETUP + `
    let floatMix = false;
    try { let bad = sqrt2 + 1.5; } catch (e) { floatMix = true; }
    let complexMix = sqrt2 * Exact.i;
    let complexMixWorks =
      Exact.ComplexAlgebraicNumber.equals(complexMix * complexMix, -2n);
    let floatDivide = false;
    try { let bad3 = 1.5 / sqrt2; } catch (e) { floatDivide = true; }
  `);
  assertEquals(session.get(0, 'floatMix'), true);
  assertEquals(session.get(0, 'complexMixWorks'), true);
  assertEquals(session.get(0, 'floatDivide'), true);
});

// ---------- geometry: the vesica piscis height ----------

Deno.test("vesica piscis: unit circles at 0 and 1 intersect at height sqrt3/2", () => {
  // x = 1/2 on both circles; y² = 1 − 1/4. The height computed from
  // the circle equation equals √3/2 computed from radical arithmetic.
  const session = run(ROOTS_SETUP + `
    let xCoord = Exact.rational(1n, 2n);
    let ySquared = 1n - xCoord * xCoord;
    let height = Exact.AlgebraicNumber.squareRoot(ySquared);
    let expected = sqrt3 / 2n;
    let check = Exact.AlgebraicNumber.equals(height, expected);
    let onSecondCircle = Exact.AlgebraicNumber.isZero(
      (xCoord - 1n) * (xCoord - 1n) + height * height - 1n);
  `, { heapSize: 1024 * 1024 });
  assertEquals(session.get(0, 'check'), true);
  assertEquals(session.get(0, 'onSecondCircle'), true);
});

// ---------- results stay usable: refinement and approximation ----------

Deno.test("composed results approximate correctly", () => {
  const session = run(ROOTS_SETUP + `
    let product = sqrt2 * sqrt3;
    let approx = Exact.AlgebraicNumber.toApproximation(product, -40n);
    let sum = sqrt2 + sqrt3;
    let sumApprox = Exact.AlgebraicNumber.toApproximation(sum, -40n);
  `);
  const approx = session.get(0, 'approx');
  assert(Math.abs(approx - Math.sqrt(6)) < 1e-9, `sqrt6 approx off: ${approx}`);
  const sumApprox = session.get(0, 'sumApprox');
  assert(Math.abs(sumApprox - (Math.SQRT2 + Math.sqrt(3))) < 1e-9, `sum approx off: ${sumApprox}`);
});

Deno.test("five independent square roots complete within a 128 MB heap", () => {
  const session = freshSession({ heapSize: 128 * 1024 * 1024 });
  parseAndSetup(session, `
    let sum =
      Exact.AlgebraicNumber.squareRoot(2n) +
      Exact.AlgebraicNumber.squareRoot(3n) +
      Exact.AlgebraicNumber.squareRoot(5n) +
      Exact.AlgebraicNumber.squareRoot(7n) +
      Exact.AlgebraicNumber.squareRoot(11n);
    let approximation = Exact.AlgebraicNumber.toApproximation(sum, -30n);
  `);
  const result = session.run(0, 1000000000);
  assertEquals(result.status, 'done');
  const approximation = session.get(0, 'approximation');
  const expected = [2, 3, 5, 7, 11]
    .reduce((sum, value) => sum + Math.sqrt(value), 0);
  assert(
    Math.abs(approximation - expected) < 1e-8,
    `five-root sum approximation off: ${approximation}`,
  );
});

Deno.test("composed results survive introspection: definingPolynomial has algebraic degree", () => {
  const session = run(ROOTS_SETUP + `
    let product = sqrt2 * sqrt3;
    let poly = Exact.AlgebraicNumber.definingPolynomial(product);
    let interval = Exact.AlgebraicNumber.isolatingInterval(product);
    let intervalLength = interval.length;
    let polyIsExpression = Exact.typeOf(poly) === 'expression';
  `);
  assertEquals(session.get(0, 'intervalLength'), 2);
  assertEquals(session.get(0, 'polyIsExpression'), true);
});

// ---------- non-canonical operands compose correctly ----------

Deno.test("algebraic-typed rational values compose: roots of x^2-1 do arithmetic", () => {
  // ±1 isolate as count-1 intervals (bisection never lands on them),
  // so they come back algebraic-typed; arithmetic must still be exact.
  const session = run(`
    let x = Symbol.for('x');
    let roots = Exact.AlgebraicNumber.rootsOfPolynomial(
      Exact.Expression.subtract(Exact.Expression.power(x, 2n), 1n), x);
    let one = roots[1];
    let sqrt2 = Exact.AlgebraicNumber.squareRoot(2n);
    let scaled = one * sqrt2;
    let check = Exact.AlgebraicNumber.equals(scaled, sqrt2);
    let sum = one + 1n;
    let sumIsTwo = Exact.AlgebraicNumber.equals(sum, 2n);
    let inverse = 1n / one;
    let inverseIsOne = Exact.AlgebraicNumber.equals(inverse, 1n);
  `, { heapSize: 1024 * 1024 });
  assertEquals(session.get(0, 'check'), true);
  assertEquals(session.get(0, 'sumIsTwo'), true);
  assertEquals(session.get(0, 'inverseIsOne'), true);
});

// ---------- golden values ----------

Deno.test("golden ratio: phi = (1+sqrt5)/2 satisfies phi^2 = phi + 1", () => {
  const session = run(`
    let sqrt5 = Exact.AlgebraicNumber.squareRoot(5n);
    let phi = (1n + sqrt5) / 2n;
    let phiSquared = phi * phi;
    let phiPlusOne = phi + 1n;
    let identity = Exact.AlgebraicNumber.equals(phiSquared, phiPlusOne);
  `, { heapSize: 1024 * 1024 });
  assertEquals(session.get(0, 'identity'), true);
});

// ---------- pressure recovery ----------

Deno.test("affine algebraic arithmetic on a small heap yields and recovers", () => {
  // Shift/scale fast paths (no resultants) exercised repeatedly under
  // a 96 KB heap: garbage accrues, pressure yields, gc reclaims, the
  // retry completes. Composition-scale workloads legitimately exceed
  // this heap (same posture as the growing-bigint OOM pin).
  const session = freshSession({ heapSize: 96 * 1024 });
  parseAndSetup(session, `
    let sqrt2 = Exact.AlgebraicNumber.squareRoot(2n);
    let ok = 0;
    let i = 0;
    while (i < 40) {
      let shifted = sqrt2 + Exact.rational(3n, 7n);
      let scaled = shifted * 2n;
      let back = scaled / 2n - Exact.rational(3n, 7n);
      if (Exact.AlgebraicNumber.equals(back, sqrt2)) { ok = ok + 1; }
      i = i + 1;
    }
  `);
  let result = session.run(0, 1000000000);
  let rounds = 0;
  while (result.status === 'memory_pressure' && rounds < 2000) {
    session.gc();
    result = session.run(0, 1000000000);
    rounds++;
  }
  assertEquals(result.status, 'done');
  assertEquals(session.get(0, 'i'), 40);
  assertEquals(session.get(0, 'ok'), 40);
  assert(rounds > 0, 'expected at least one pressure yield');
});

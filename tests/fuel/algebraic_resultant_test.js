/**
 * Ring 6 (6c) — Exact.Expression.resultant: bivariate elimination on
 * the dense ℤ[x] engine (Sylvester + fraction-free Bareiss), with the
 * denominator-clearing factors divided back out so values match the
 * textbook Res_{m,n}. Numeric results come back numeric; polynomial
 * results as canonical expressions in the surviving symbol.
 */

import { assertEquals, assert } from "https://deno.land/std@0.208.0/assert/mod.ts";
import { parseAndSetup } from './test-helpers.js';
import { freshSession } from '../../src/host-owned-session.js';

function run(source, options = {}) {
  const session = freshSession(options);
  parseAndSetup(session, source);
  let result = session.run(0, 1000000000);
  let rounds = 0;
  while (result.status === 'memory_pressure' && rounds < 800) {
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

const SETUP = `
  let x = Symbol.for('x');
  let y = Symbol.for('y');
  let E = Exact.Expression;
`;

// ---------- hand-computed values ----------

Deno.test("resultant: circle x line — Res_y(x^2+y^2-1, x-y) = 2x^2 - 1", () => {
  const session = run(SETUP + `
    let r = E.resultant(
      E.subtract(E.add(E.power(x, 2n), E.power(y, 2n)), 1n),
      E.subtract(x, y),
      y);
    let expected = E.simplify(E.subtract(E.multiply(2n, E.power(x, 2n)), 1n));
    let check = E.equal(r, expected);
  `);
  assertEquals(session.get(0, 'check'), true);
});

Deno.test("resultant: numeric result — Res_y(y^2-2, y^2-3) = 1", () => {
  const session = run(SETUP + `
    let r = E.resultant(
      E.subtract(E.power(y, 2n), 2n),
      E.subtract(E.power(y, 2n), 3n),
      y);
    let isOne = r === 1;
    let swapped = E.resultant(
      E.subtract(E.power(y, 2n), 3n),
      E.subtract(E.power(y, 2n), 2n),
      y);
    let swappedIsOne = swapped === 1;
  `);
  assertEquals(session.get(0, 'isOne'), true);
  assertEquals(session.get(0, 'swappedIsOne'), true);
});

Deno.test("resultant: rational coefficients divide the clearing factor back out", () => {
  // Res_y(y^2 - 1/2, y - x) = x^2 - 1/2 EXACTLY (not the 2x^2 - 1 the
  // cleared integer computation produces before correction).
  const session = run(SETUP + `
    let r = E.resultant(
      E.subtract(E.power(y, 2n), Exact.rational(1n, 2n)),
      E.subtract(y, x),
      y);
    let expected = E.simplify(E.subtract(E.power(x, 2n), Exact.rational(1n, 2n)));
    let check = E.equal(r, expected);
  `);
  assertEquals(session.get(0, 'check'), true);
});

Deno.test("resultant: zero polynomial input gives 0; constants give powers", () => {
  const session = run(SETUP + `
    let z = E.resultant(E.subtract(y, y), E.subtract(y, x), y);
    let zIsZero = z === 0;
    // Res(3, y - x) with deg 0 vs 1: 3^1 = 3.
    let c = E.resultant(E.add(3n, E.subtract(y, y)), E.subtract(y, x), y);
    let cIsThree = c === 3;
  `);
  assertEquals(session.get(0, 'zIsZero'), true);
  assertEquals(session.get(0, 'cIsThree'), true);
});

// ---------- geometry: the two roads to the vesica ----------

Deno.test("vesica cross-check: elimination reproduces 6b's arithmetic values", () => {
  const session = run(SETUP + `
    let circleA = E.subtract(E.add(E.power(x, 2n), E.power(y, 2n)), 1n);
    let circleB = E.subtract(E.add(E.power(E.subtract(x, 1n), 2n), E.power(y, 2n)), 1n);
    // Road one: eliminate y — the intersection x-coordinate.
    let xPoly = E.resultant(circleA, circleB, y);
    let xRoots = Exact.AlgebraicNumber.rootsOfPolynomial(xPoly, x);
    let xCount = xRoots.length;
    let xIsHalf = xRoots[0] === Exact.rational(1n, 2n);
    // Road two: eliminate x — the intersection heights.
    let yPoly = E.resultant(circleA, circleB, x);
    let yRoots = Exact.AlgebraicNumber.rootsOfPolynomial(yPoly, y);
    let yCount = yRoots.length;
    let sqrt3 = Exact.AlgebraicNumber.squareRoot(3n);
    let heightMatches = Exact.AlgebraicNumber.equals(yRoots[yCount - 1], sqrt3 / 2n);
    let symmetric = Exact.AlgebraicNumber.isZero(yRoots[0] + yRoots[yCount - 1]);
  `, { heapSize: 1024 * 1024 });
  assertEquals(session.get(0, 'xCount'), 1);
  assertEquals(session.get(0, 'xIsHalf'), true);
  assertEquals(session.get(0, 'yCount'), 2);
  assertEquals(session.get(0, 'heightMatches'), true);
  assertEquals(session.get(0, 'symmetric'), true);
});

Deno.test("cubic x line: the plastic number from y=x^3 meeting y=x+1", () => {
  const session = run(SETUP + `
    let curve = E.subtract(y, E.power(x, 3n));
    let line = E.subtract(y, E.add(x, 1n));
    let eliminant = E.resultant(curve, line, y);
    let roots = Exact.AlgebraicNumber.rootsOfPolynomial(eliminant, x);
    let count = roots.length;
    let plastic = roots[0];
    // ρ³ = ρ + 1 exactly.
    let identity = Exact.AlgebraicNumber.equals(plastic * plastic * plastic, plastic + 1n);
    let approx = Exact.AlgebraicNumber.toApproximation(plastic, -30n);
  `, { heapSize: 1024 * 1024 });
  assertEquals(session.get(0, 'count'), 1);
  assertEquals(session.get(0, 'identity'), true);
  assert(Math.abs(session.get(0, 'approx') - 1.3247179572447) < 1e-9);
});

Deno.test("cubic x cubic: degree-9 eliminant, all nine intersections real", () => {
  // y = x^3 - 3x meets its own reflection x = y^3 - 3y: nine real
  // intersections (the classic fully-real cubic pair), including the
  // three symmetric ones on y = x at x ∈ {-2, 0, 2}.
  const session = run(SETUP + `
    let a = E.subtract(E.subtract(E.power(x, 3n), E.multiply(3n, x)), y);
    let b = E.subtract(E.subtract(E.power(y, 3n), E.multiply(3n, y)), x);
    let eliminant = E.resultant(a, b, y);
    let roots = Exact.AlgebraicNumber.rootsOfPolynomial(eliminant, x);
    let count = roots.length;
    let middle = Exact.AlgebraicNumber.isZero(roots[4]);
    let hasTwo = Exact.AlgebraicNumber.equals(roots[count - 1], 2n);
    // Symmetry via cheap affine negation, not a degree-81 sum
    // composition: the root set is closed under x → −x.
    let symmetric = Exact.AlgebraicNumber.equals(roots[0], -roots[count - 1]);
  `, { heapSize: 4 * 1024 * 1024 });
  assertEquals(session.get(0, 'count'), 9);
  assertEquals(session.get(0, 'middle'), true);
  assertEquals(session.get(0, 'hasTwo'), true);
  assertEquals(session.get(0, 'symmetric'), true);
});

// ---------- algebraic coefficient field ----------

Deno.test("resultant: one algebraic coefficient survives exact bivariate elimination", () => {
  const session = run(SETUP + `
    let A = Exact.AlgebraicNumber;
    let sqrt2 = A.squareRoot(2n);
    let r = E.resultant(E.subtract(y, sqrt2), E.subtract(y, x), y);
    let roots = A.rootsOfPolynomial(r, x);
    let rootMatches = A.equals(roots[0], sqrt2);
    let atZero = E.simplify(E.substitute(r, x, 0n));
    let zeroMatches = A.equals(atZero, sqrt2);
    let rootCount = roots.length;
  `);
  assertEquals(session.get(0, 'zeroMatches'), true);
  assertEquals(session.get(0, 'rootMatches'), true);
  assertEquals(session.get(0, 'rootCount'), 1);
});

Deno.test("resultant: products, powers, and several algebraic coefficients share one exact field", () => {
  const session = run(SETUP + `
    let A = Exact.AlgebraicNumber;
    let sqrt2 = A.squareRoot(2n);
    let sqrt3 = A.squareRoot(3n);
    let coefficient = E.add(E.power(sqrt2, 3n), E.multiply(sqrt2, sqrt3));
    let r = E.resultant(
      E.subtract(y, coefficient),
      E.subtract(E.add(y, sqrt3), x),
      y);
    let roots = A.rootsOfPolynomial(r, x);
    let expected = 2n * sqrt2 + sqrt2 * sqrt3 + sqrt3;
    let matches = A.equals(roots[0], expected);
    let rootCount = roots.length;
  `, { heapSize: 8 * 1024 * 1024 });
  assertEquals(session.get(0, 'matches'), true);
  assertEquals(session.get(0, 'rootCount'), 1);
});

Deno.test("resultant: algebraic field denominator clearing preserves textbook scaling", () => {
  const session = run(SETUP + `
    let A = Exact.AlgebraicNumber;
    let sqrt2 = A.squareRoot(2n);
    let half = Exact.rational(1n, 2n);
    let r = E.resultant(
      E.subtract(E.multiply(half, y), sqrt2),
      E.subtract(y, x),
      y);
    let roots = A.rootsOfPolynomial(r, x);
    let rootMatches = A.equals(roots[0], 2n * sqrt2);
    let rootCount = roots.length;
  `);
  assertEquals(session.get(0, 'rootMatches'), true);
  assertEquals(session.get(0, 'rootCount'), 1);
});
// ---------- error surface ----------

Deno.test("resultant: validation TypeErrors", () => {
  const session = run(SETUP + `
    let missingVariable = false;
    try { E.resultant(E.power(y, 2n), y, 'y'); } catch (e) { missingVariable = true; }
    let nonPolynomial = false;
    try {
      E.resultant(E.power(y, Exact.rational(1n, 2n)), E.subtract(y, x), y);
    } catch (e) { nonPolynomial = true; }
    let trivariate = false;
    try {
      E.resultant(
        E.add(E.power(y, 2n), E.multiply(x, Symbol.for('z'))),
        E.subtract(y, x),
        y);
    } catch (e) { trivariate = true; }
  `);
  assertEquals(session.get(0, 'missingVariable'), true);
  assertEquals(session.get(0, 'nonPolynomial'), true);
  assertEquals(session.get(0, 'trivariate'), true);
});

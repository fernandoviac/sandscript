/**
 * Ring 7c userland recipes — elimination and triangular back-substitution.
 *
 * These tests deliberately compose the two committed builtins with the
 * existing resultant, substitution, simplification, and root-isolation
 * surfaces instead of adding convenience APIs for either recipe.
 */

import { assertEquals } from "https://deno.land/std@0.208.0/assert/mod.ts";
import { parseAndSetup } from "./test-helpers.js";
import { freshSession } from "../../src/host-owned-session.js";

function run(source) {
  const session = freshSession({ heapSize: 64 * 1024 * 1024 });
  parseAndSetup(session, source);
  let result = session.run(0, 100000000);
  let collections = 0;
  while (result.status === 'memory_pressure' && collections < 800) {
    session.gc();
    collections++;
    result = session.run(0, 100000000);
  }
  if (result.status === 'error') {
    throw new Error(`Error: ${result.error?.message ?? JSON.stringify(result)}`);
  }
  if (result.status !== 'done') {
    throw new Error(`Expected done, got ${JSON.stringify(result)}`);
  }
  return session;
}

const SETUP = `
  let E = Exact.Expression;
  let A = Exact.AlgebraicNumber;
  let x = Symbol.for('x');
  let y = Symbol.for('y');
  let z = Symbol.for('z');
`;

const TRILATERATION = `
  let xSquared = E.power(x, 2n);
  let ySquared = E.power(y, 2n);
  let zSquared = E.power(z, 2n);
  let firstSphere = E.subtract(E.add(E.add(xSquared, ySquared), zSquared), 5n);
  let secondSphere = E.subtract(E.add(E.add(E.power(E.subtract(x, 2n), 2n), ySquared), zSquared), 5n);
  let thirdSphere = E.subtract(E.add(E.add(xSquared, E.power(E.subtract(y, 4n), 2n)), zSquared), 5n);
  let sphereBasis = E.groebnerBasis([firstSphere, secondSphere, thirdSphere], [x, y, z]);
`;

Deno.test("zero-dimensional recipe: three tangent spheres form a triangular lex basis", () => {
  const session = run(SETUP + TRILATERATION + `
    let expectedX = E.simplify(E.subtract(x, 1n));
    let expectedY = E.simplify(E.subtract(y, 2n));
    let expectedZ = E.power(z, 2n);
    let lengthMatches = sphereBasis.length === 3;
    let xMatches = E.equal(sphereBasis[0], expectedX);
    let yMatches = E.equal(sphereBasis[1], expectedY);
    let zMatches = E.equal(sphereBasis[2], expectedZ);
  `);
  assertEquals(session.get(0, 'lengthMatches'), true);
  assertEquals(session.get(0, 'xMatches'), true);
  assertEquals(session.get(0, 'yMatches'), true);
  assertEquals(session.get(0, 'zMatches'), true);
});

Deno.test("zero-dimensional recipe: isolate last variable and substitute backward", () => {
  const session = run(SETUP + TRILATERATION + `
    let zRoots = A.rootsOfPolynomial(sphereBasis[2], z);
    let zValue = zRoots[0];
    let yPolynomial = E.simplify(E.substitute(sphereBasis[1], z, zValue));
    let yRoots = A.rootsOfPolynomial(yPolynomial, y);
    let yValue = yRoots[0];
    let xPolynomial = E.simplify(E.substitute(
      E.substitute(sphereBasis[0], z, zValue), y, yValue));
    let xRoots = A.rootsOfPolynomial(xPolynomial, x);
    let xValue = xRoots[0];
    let rootCountsMatch = zRoots.length === 1 && yRoots.length === 1 && xRoots.length === 1;
    let xMatches = A.equals(xValue, 1n);
    let yMatches = A.equals(yValue, 2n);
    let zMatches = A.equals(zValue, 0n);
  `);
  assertEquals(session.get(0, 'rootCountsMatch'), true);
  assertEquals(session.get(0, 'xMatches'), true);
  assertEquals(session.get(0, 'yMatches'), true);
  assertEquals(session.get(0, 'zMatches'), true);
});

Deno.test("zero-dimensional recipe: recovered point satisfies every original sphere", () => {
  const session = run(SETUP + TRILATERATION + `
    let zValue = A.rootsOfPolynomial(sphereBasis[2], z)[0];
    let yValue = A.rootsOfPolynomial(E.simplify(E.substitute(sphereBasis[1], z, zValue)), y)[0];
    let xValue = A.rootsOfPolynomial(E.simplify(E.substitute(
      E.substitute(sphereBasis[0], z, zValue), y, yValue)), x)[0];
    let firstValue = E.simplify(E.substitute(E.substitute(E.substitute(firstSphere, x, xValue), y, yValue), z, zValue));
    let secondValue = E.simplify(E.substitute(E.substitute(E.substitute(secondSphere, x, xValue), y, yValue), z, zValue));
    let thirdValue = E.simplify(E.substitute(E.substitute(E.substitute(thirdSphere, x, xValue), y, yValue), z, zValue));
    let firstMatches = E.equal(firstValue, 0n);
    let secondMatches = E.equal(secondValue, 0n);
    let thirdMatches = E.equal(thirdValue, 0n);
  `);
  assertEquals(session.get(0, 'firstMatches'), true);
  assertEquals(session.get(0, 'secondMatches'), true);
  assertEquals(session.get(0, 'thirdMatches'), true);
});

Deno.test("zero-dimensional recipe: isolated coordinates have the expected interval evaluations", () => {
  const session = run(SETUP + TRILATERATION + `
    let zValue = A.rootsOfPolynomial(sphereBasis[2], z)[0];
    let yValue = A.rootsOfPolynomial(E.simplify(E.substitute(sphereBasis[1], z, zValue)), y)[0];
    let xValue = A.rootsOfPolynomial(E.simplify(E.substitute(
      E.substitute(sphereBasis[0], z, zValue), y, yValue)), x)[0];
    let xApproximation = A.toApproximation(xValue, -40n);
    let yApproximation = A.toApproximation(yValue, -40n);
    let zApproximation = A.toApproximation(zValue, -40n);
  `);
  assertEquals(session.get(0, 'xApproximation'), 1);
  assertEquals(session.get(0, 'yApproximation'), 2);
  assertEquals(session.get(0, 'zApproximation'), 0);
});

Deno.test("elimination recipe: circle-line Groebner elimination agrees with resultant up to units", () => {
  const session = run(SETUP + `
    let circle = E.subtract(E.add(E.power(x, 2n), E.power(y, 2n)), 1n);
    let diagonal = E.subtract(x, y);
    let basis = E.groebnerBasis([circle, diagonal], [x, y]);
    let eliminationPolynomial = basis[1];
    let resultantPolynomial = E.resultant(circle, diagonal, x);
    let resultantByBasis = E.polynomialReduce(resultantPolynomial, [eliminationPolynomial], [y]);
    let basisByResultant = E.polynomialReduce(eliminationPolynomial, [resultantPolynomial], [y]);
    let resultantReduces = E.equal(resultantByBasis, 0n);
    let basisReduces = E.equal(basisByResultant, 0n);
  `);
  assertEquals(session.get(0, 'resultantReduces'), true);
  assertEquals(session.get(0, 'basisReduces'), true);
});

Deno.test("elimination recipe: vesica-family circles agree with resultant up to factors", () => {
  const session = run(SETUP + `
    let leftCircle = E.subtract(E.add(E.power(x, 2n), E.power(y, 2n)), 1n);
    let rightCircle = E.subtract(E.add(E.power(E.subtract(x, 1n), 2n), E.power(y, 2n)), 1n);
    let basis = E.groebnerBasis([leftCircle, rightCircle], [x, y]);
    let expectedX = E.simplify(E.subtract(x, Exact.rational(1n, 2n)));
    let expectedY = E.simplify(E.subtract(E.power(y, 2n), Exact.rational(3n, 4n)));
    let basisMatches = basis.length === 2
      && E.equal(basis[0], expectedX)
      && E.equal(basis[1], expectedY);
    let resultantPolynomial = E.resultant(leftCircle, rightCircle, x);
    let resultantReduces = E.equal(E.polynomialReduce(resultantPolynomial, [basis[1]], [y]), 0n);
    let basisReduces = E.equal(E.polynomialReduce(basis[1], [resultantPolynomial], [y]), 0n);
  `);
  assertEquals(session.get(0, 'basisMatches'), true);
  assertEquals(session.get(0, 'resultantReduces'), true);
  assertEquals(session.get(0, 'basisReduces'), true);
});

Deno.test("elimination recipe: trailing basis polynomial isolates both circle-line points", () => {
  const session = run(SETUP + `
    let circle = E.subtract(E.add(E.power(x, 2n), E.power(y, 2n)), 1n);
    let diagonal = E.subtract(x, y);
    let basis = E.groebnerBasis([circle, diagonal], [x, y]);
    let yRoots = A.rootsOfPolynomial(basis[1], y);
    let negativeY = yRoots[0];
    let positiveY = yRoots[1];
    let negativeX = A.rootsOfPolynomial(E.simplify(E.substitute(basis[0], y, negativeY)), x)[0];
    let positiveX = A.rootsOfPolynomial(E.simplify(E.substitute(basis[0], y, positiveY)), x)[0];
    let countMatches = yRoots.length === 2;
    let negativeCoordinatesMatch = A.equals(negativeX, negativeY);
    let positiveCoordinatesMatch = A.equals(positiveX, positiveY);
    let ordered = A.compare(negativeY, positiveY) === -1;
  `);
  assertEquals(session.get(0, 'countMatches'), true);
  assertEquals(session.get(0, 'negativeCoordinatesMatch'), true);
  assertEquals(session.get(0, 'positiveCoordinatesMatch'), true);
  assertEquals(session.get(0, 'ordered'), true);
});

Deno.test("elimination recipe: recovered circle-line points verify by exact substitution", () => {
  const session = run(SETUP + `
    let circle = E.subtract(E.add(E.power(x, 2n), E.power(y, 2n)), 1n);
    let diagonal = E.subtract(x, y);
    let basis = E.groebnerBasis([circle, diagonal], [x, y]);
    let yRoots = A.rootsOfPolynomial(basis[1], y);
    let firstX = A.rootsOfPolynomial(E.simplify(E.substitute(basis[0], y, yRoots[0])), x)[0];
    let secondX = A.rootsOfPolynomial(E.simplify(E.substitute(basis[0], y, yRoots[1])), x)[0];
    let firstCircle = firstX * firstX + yRoots[0] * yRoots[0] - 1n;
    let firstDiagonal = firstX - yRoots[0];
    let secondCircle = secondX * secondX + yRoots[1] * yRoots[1] - 1n;
    let secondDiagonal = secondX - yRoots[1];
    let firstMatches = A.equals(firstCircle, 0n) && A.equals(firstDiagonal, 0n);
    let secondMatches = A.equals(secondCircle, 0n) && A.equals(secondDiagonal, 0n);
  `);
  assertEquals(session.get(0, 'firstMatches'), true);
  assertEquals(session.get(0, 'secondMatches'), true);
});

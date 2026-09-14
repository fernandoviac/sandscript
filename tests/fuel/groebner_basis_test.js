/**
 * Ring 7c — sparse multivariate elimination.
 *
 * Observable contracts for reduced lexicographic Groebner bases and canonical
 * polynomial normal forms over the complete exact numeric coefficient tower.
 */

import { assertEquals } from "https://deno.land/std@0.208.0/assert/mod.ts";
import { parseAndSetup } from "./test-helpers.js";
import { freshSession } from "../../src/host-owned-session.js";

function run(source, options = {}) {
  const session = freshSession({ heapSize: 32 * 1024 * 1024, ...options });
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
  let C = Exact.ComplexAlgebraicNumber;
  let x = Symbol.for('x');
  let y = Symbol.for('y');
  let z = Symbol.for('z');
`;

Deno.test("Groebner basis: lex elimination is reduced, monic, and canonical", () => {
  const session = run(SETUP + `
    let first = E.subtract(E.multiply(x, y), 1n);
    let second = E.subtract(E.power(y, 2n), x);
    let basis = E.groebnerBasis([first, second], [x, y]);
    let expectedFirst = E.simplify(E.subtract(x, E.power(y, 2n)));
    let expectedSecond = E.simplify(E.subtract(E.power(y, 3n), 1n));
    let lengthMatches = basis.length === 2;
    let firstMatches = E.equal(basis[0], expectedFirst);
    let secondMatches = E.equal(basis[1], expectedSecond);
    let firstReduces = E.equal(E.polynomialReduce(first, basis, [x, y]), 0n);
    let secondReduces = E.equal(E.polynomialReduce(second, basis, [x, y]), 0n);
  `);


  assertEquals(session.get(0, 'lengthMatches'), true);
  assertEquals(session.get(0, 'firstMatches'), true);
  assertEquals(session.get(0, 'secondMatches'), true);
  assertEquals(session.get(0, 'firstReduces'), true);
  assertEquals(session.get(0, 'secondReduces'), true);
});

Deno.test("polynomialReduce: canonical normal form distinguishes ideal membership", () => {
  const session = run(SETUP + `
    let basis = E.groebnerBasis([
      E.subtract(E.multiply(x, y), 1n),
      E.subtract(E.power(y, 2n), x)
    ], [x, y]);
    let member = E.subtract(E.power(x, 2n), y);
    let memberRemainder = E.polynomialReduce(member, basis, [x, y]);
    let outside = E.add(E.power(x, 2n), y);
    let outsideRemainder = E.polynomialReduce(outside, basis, [x, y]);
    let expectedOutside = E.multiply(2n, y);
    let memberMatches = E.equal(memberRemainder, 0n);
    let outsideMatches = E.equal(outsideRemainder, expectedOutside);
  `);


  assertEquals(session.get(0, 'memberMatches'), true);
  assertEquals(session.get(0, 'outsideMatches'), true);
});

Deno.test("Groebner basis: empty and all-zero generators return the empty basis", () => {
  const session = run(SETUP + `
    let empty = E.groebnerBasis([], [x, y]);
    let zeros = E.groebnerBasis([0n, E.subtract(x, x), E.multiply(0n, y)], [x, y]);
    let emptyMatches = empty.length === 0;
    let zerosMatch = zeros.length === 0;
  `);
  assertEquals(session.get(0, 'emptyMatches'), true);
  assertEquals(session.get(0, 'zerosMatch'), true);
});

Deno.test("Groebner basis: a nonzero constant is exactly the whole-ring basis [1]", () => {
  const session = run(SETUP + `
    let integerBasis = E.groebnerBasis([x, 7n], [x]);
    let rationalBasis = E.groebnerBasis([Exact.rational(3n, 5n), E.power(x, 4n)], [x]);
    let integerMatches = integerBasis.length === 1 && E.equal(integerBasis[0], 1n);
    let rationalMatches = rationalBasis.length === 1 && E.equal(rationalBasis[0], 1n);
  `);
  assertEquals(session.get(0, 'integerMatches'), true);
  assertEquals(session.get(0, 'rationalMatches'), true);
});

Deno.test("Groebner basis: inconsistent generators reduce to [1]", () => {
  const session = run(SETUP + `
    let basis = E.groebnerBasis([x, E.subtract(x, 1n)], [x]);
    let matches = basis.length === 1 && E.equal(basis[0], 1n);
    let arbitraryRemainder = E.polynomialReduce(E.add(E.power(x, 9n), 42n), basis, [x]);
    let arbitraryIsZero = E.equal(arbitraryRemainder, 0n);
  `);
  assertEquals(session.get(0, 'matches'), true);
  assertEquals(session.get(0, 'arbitraryIsZero'), true);
});

Deno.test("Groebner basis: redundant and scalar-multiple generators disappear", () => {
  const session = run(SETUP + `
    let generator = E.add(E.power(x, 2n), E.multiply(2n, y));
    let basis = E.groebnerBasis([
      generator,
      E.multiply(7n, generator),
      E.multiply(Exact.rational(-3n, 5n), generator),
      0n
    ], [x, y]);
    let expected = E.simplify(generator);
    let lengthMatches = basis.length === 1;
    let polynomialMatches = E.equal(basis[0], expected);
  `);
  assertEquals(session.get(0, 'lengthMatches'), true);
  assertEquals(session.get(0, 'polynomialMatches'), true);
});

Deno.test("Groebner basis: division by an exact coefficient stays polynomial", () => {
  const session = run(SETUP + `
    let divided = E.divide(E.add(E.multiply(6n, x), 9n), 3n);
    let basis = E.groebnerBasis([divided], [x]);
    let expected = E.add(x, Exact.rational(3n, 2n));
    let matches = basis.length === 1 && E.equal(basis[0], expected);
  `);
  assertEquals(session.get(0, 'matches'), true);
});

Deno.test("Groebner basis: circle-line elimination matches the hand-checked lex basis", () => {
  const session = run(SETUP + `
    let circle = E.subtract(E.add(E.power(x, 2n), E.power(y, 2n)), 1n);
    let diagonal = E.subtract(x, y);
    let basis = E.groebnerBasis([circle, diagonal], [x, y]);
    let expectedFirst = E.simplify(E.subtract(x, y));
    let expectedSecond = E.simplify(E.subtract(E.power(y, 2n), Exact.rational(1n, 2n)));
    let lengthMatches = basis.length === 2;
    let firstMatches = E.equal(basis[0], expectedFirst);
    let secondMatches = E.equal(basis[1], expectedSecond);
    let circleReduces = E.equal(E.polynomialReduce(circle, basis, [x, y]), 0n);
    let diagonalReduces = E.equal(E.polynomialReduce(diagonal, basis, [x, y]), 0n);
  `);
  assertEquals(session.get(0, 'lengthMatches'), true);
  assertEquals(session.get(0, 'firstMatches'), true);
  assertEquals(session.get(0, 'secondMatches'), true);
  assertEquals(session.get(0, 'circleReduces'), true);
  assertEquals(session.get(0, 'diagonalReduces'), true);
});

Deno.test("Groebner basis: user variable order controls lexicographic elimination", () => {
  const session = run(SETUP + `
    let circle = E.subtract(E.add(E.power(x, 2n), E.power(y, 2n)), 1n);
    let diagonal = E.subtract(x, y);
    let xy = E.groebnerBasis([circle, diagonal], [x, y]);
    let yx = E.groebnerBasis([circle, diagonal], [y, x]);
    let xyFirst = E.equal(xy[0], E.simplify(E.subtract(x, y)));
    let xyLast = E.equal(xy[1], E.simplify(E.subtract(E.power(y, 2n), Exact.rational(1n, 2n))));
    let yxFirst = E.equal(yx[0], E.simplify(E.subtract(y, x)));
    let yxLast = E.equal(yx[1], E.simplify(E.subtract(E.power(x, 2n), Exact.rational(1n, 2n))));
  `);
  assertEquals(session.get(0, 'xyFirst'), true);
  assertEquals(session.get(0, 'xyLast'), true);
  assertEquals(session.get(0, 'yxFirst'), true);
  assertEquals(session.get(0, 'yxLast'), true);
});

Deno.test("Groebner basis: cyclic-3 produces the triangular reduced lex basis", () => {
  const session = run(SETUP + `
    let first = E.add(E.add(x, y), z);
    let second = E.add(E.add(E.multiply(x, y), E.multiply(y, z)), E.multiply(z, x));
    let third = E.subtract(E.multiply(E.multiply(x, y), z), 1n);
    let basis = E.groebnerBasis([first, second, third], [x, y, z]);
    let expectedFirst = E.simplify(E.add(E.add(x, y), z));
    let expectedSecond = E.simplify(E.add(E.add(E.power(y, 2n), E.multiply(y, z)), E.power(z, 2n)));
    let expectedThird = E.simplify(E.subtract(E.power(z, 3n), 1n));
    let lengthMatches = basis.length === 3;
    let firstMatches = E.equal(basis[0], expectedFirst);
    let secondMatches = E.equal(basis[1], expectedSecond);
    let thirdMatches = E.equal(basis[2], expectedThird);
    let firstReduces = E.equal(E.polynomialReduce(first, basis, [x, y, z]), 0n);
    let secondReduces = E.equal(E.polynomialReduce(second, basis, [x, y, z]), 0n);
    let thirdReduces = E.equal(E.polynomialReduce(third, basis, [x, y, z]), 0n);
  `);
  assertEquals(session.get(0, 'lengthMatches'), true);
  assertEquals(session.get(0, 'firstMatches'), true);
  assertEquals(session.get(0, 'secondMatches'), true);
  assertEquals(session.get(0, 'thirdMatches'), true);
  assertEquals(session.get(0, 'firstReduces'), true);
  assertEquals(session.get(0, 'secondReduces'), true);
  assertEquals(session.get(0, 'thirdReduces'), true);
});

Deno.test("Groebner basis: every cyclic-3 S-polynomial has a zero-reduction certificate", () => {
  const session = run(SETUP + `
    let generators = [
      E.add(E.add(x, y), z),
      E.add(E.add(E.multiply(x, y), E.multiply(y, z)), E.multiply(z, x)),
      E.subtract(E.multiply(E.multiply(x, y), z), 1n)
    ];
    let basis = E.groebnerBasis(generators, [x, y, z]);
    let ySquared = E.power(y, 2n);
    let zSquared = E.power(z, 2n);
    let zCubed = E.power(z, 3n);
    let s01 = E.subtract(E.multiply(ySquared, basis[0]), E.multiply(x, basis[1]));
    let s02 = E.subtract(E.multiply(zCubed, basis[0]), E.multiply(x, basis[2]));
    let s12 = E.subtract(E.multiply(zCubed, basis[1]), E.multiply(ySquared, basis[2]));
    let certificate01 = E.subtract(
      E.subtract(
        E.add(
          E.add(s01, E.multiply(E.multiply(y, z), basis[0])),
          E.multiply(zSquared, basis[0])
        ),
        E.multiply(y, basis[1])
      ),
      E.multiply(z, basis[1])
    );
    let certificate02 = E.subtract(
      E.subtract(
        E.subtract(s02, basis[0]),
        E.multiply(y, basis[2])
      ),
      E.multiply(z, basis[2])
    );
    let certificate12 = E.subtract(
      E.subtract(
        E.subtract(s12, basis[1]),
        E.multiply(E.multiply(y, z), basis[2])
      ),
      E.multiply(zSquared, basis[2])
    );
    let firstZero = E.equal(E.polynomialReduce(certificate01, [], [x, y, z]), 0n);
    let secondZero = E.equal(E.polynomialReduce(certificate02, [], [x, y, z]), 0n);
    let thirdZero = E.equal(E.polynomialReduce(certificate12, [], [x, y, z]), 0n);
  `);
  assertEquals(session.get(0, 'firstZero'), true);
  assertEquals(session.get(0, 'secondZero'), true);
  assertEquals(session.get(0, 'thirdZero'), true);
});

Deno.test("Groebner basis: exact algebraic coefficients remain exact field elements", () => {
  const session = run(SETUP + `
    let rootTwo = A.squareRoot(2n);
    let generator = E.add(E.multiply(rootTwo, x), 1n);
    let basis = E.groebnerBasis([generator], [x]);
    let lengthMatches = basis.length === 1;
    let basisMatches = A.equals(E.args(basis[0])[1], 1n / rootTwo);
    let generatorReduces = E.equal(E.polynomialReduce(generator, basis, [x]), 0n);
  `);
  assertEquals(session.get(0, 'lengthMatches'), true);
  assertEquals(session.get(0, 'basisMatches'), true);
  assertEquals(session.get(0, 'generatorReduces'), true);
});

Deno.test("Groebner basis: exact complex-algebraic coefficients remain exact field elements", () => {
  const session = run(SETUP + `
    let coefficient = C.fromParts(A.squareRoot(2n), A.squareRoot(3n));
    let generator = E.add(E.multiply(coefficient, x), 1n);
    let basis = E.groebnerBasis([generator], [x]);
    let lengthMatches = basis.length === 1;
    let basisMatches = C.equals(E.args(basis[0])[1], 1n / coefficient);
    let generatorReduces = E.equal(E.polynomialReduce(generator, basis, [x]), 0n);
  `);
  assertEquals(session.get(0, 'lengthMatches'), true);
  assertEquals(session.get(0, 'basisMatches'), true);
  assertEquals(session.get(0, 'generatorReduces'), true);
});

Deno.test("polynomialReduce: generator order does not change the canonical remainder", () => {
  const session = run(SETUP + `
    let first = E.subtract(E.multiply(x, y), 1n);
    let second = E.subtract(E.power(y, 2n), x);
    let target = E.add(E.add(E.power(x, 3n), E.power(y, 5n)), 7n);
    let forward = E.polynomialReduce(target, [first, second], [x, y]);
    let reverse = E.polynomialReduce(target, [second, first], [x, y]);
    let same = E.equal(forward, reverse);
  `);
  assertEquals(session.get(0, 'same'), true);
});

Deno.test("polynomialReduce: large nonnegative exponents follow lex leading terms", () => {
  const session = run(SETUP + `
    let basis = E.groebnerBasis([
      E.subtract(E.power(x, 12n), y),
      E.subtract(E.power(y, 3n), 1n)
    ], [x, y]);
    let target = E.add(E.power(x, 25n), E.power(y, 7n));
    let remainder = E.polynomialReduce(target, basis, [x, y]);
    let expected = E.add(E.multiply(x, E.power(y, 2n)), y);
    let matches = E.equal(remainder, E.simplify(expected));
  `);
  assertEquals(session.get(0, 'matches'), true);
});

Deno.test("polynomial exponents use the full unsigned cell and reject overflow", () => {
  const session = run(SETUP + `
    let largestDirectPower = E.power(x, 4294967295n);
    let directRemainder = E.polynomialReduce(largestDirectPower, [], [x]);
    let fullRangeMatches = E.equal(directRemainder, largestDirectPower);
    let productOverflowRejected = false;
    let reductionOverflowRejected = false;
    try {
      E.polynomialReduce(
        E.multiply(
          E.multiply(E.power(x, 2147483647n), E.power(x, 2147483647n)),
          E.power(x, 2n)
        ),
        [],
        [x]
      );
    } catch (error) {
      productOverflowRejected = error instanceof RangeError;
    }
    try {
      E.polynomialReduce(
        E.multiply(x, E.power(y, 4294967295n)),
        [E.add(x, y)],
        [x, y]
      );
    } catch (error) {
      reductionOverflowRejected = error instanceof RangeError;
    }
  `);
  assertEquals(session.get(0, 'fullRangeMatches'), true);
  assertEquals(session.get(0, 'productOverflowRejected'), true);
  assertEquals(session.get(0, 'reductionOverflowRejected'), true);
});

Deno.test("Groebner basis: returned arrays are frozen", () => {
  const session = run(SETUP + `
    let basis = E.groebnerBasis([x], [x]);
    let rejected = false;
    try { basis.push(y); } catch (error) { rejected = true; }
  `);
  assertEquals(session.get(0, 'rejected'), true);
});

Deno.test("Groebner basis: argument and variable-list boundaries reject malformed calls", () => {
  const session = run(SETUP + `
    let nonArrayBasisRejected = false;
    let nonArrayVariablesRejected = false;
    let nonSymbolVariableRejected = false;
    let duplicateVariableRejected = false;
    let missingArgumentRejected = false;
    try { E.groebnerBasis(x, [x]); } catch (error) { nonArrayBasisRejected = true; }
    try { E.groebnerBasis([x], x); } catch (error) { nonArrayVariablesRejected = true; }
    try { E.groebnerBasis([x], [1n]); } catch (error) { nonSymbolVariableRejected = true; }
    try { E.groebnerBasis([x], [x, x]); } catch (error) { duplicateVariableRejected = true; }
    try { E.groebnerBasis([x]); } catch (error) { missingArgumentRejected = true; }
  `);
  assertEquals(session.get(0, 'nonArrayBasisRejected'), true);
  assertEquals(session.get(0, 'nonArrayVariablesRejected'), true);
  assertEquals(session.get(0, 'nonSymbolVariableRejected'), true);
  assertEquals(session.get(0, 'duplicateVariableRejected'), true);
  assertEquals(session.get(0, 'missingArgumentRejected'), true);
});

Deno.test("polynomialReduce: boundary rejects malformed basis and variable arrays", () => {
  const session = run(SETUP + `
    let nonArrayBasisRejected = false;
    let nonArrayVariablesRejected = false;
    let duplicateVariableRejected = false;
    let missingArgumentRejected = false;
    try { E.polynomialReduce(x, x, [x]); } catch (error) { nonArrayBasisRejected = true; }
    try { E.polynomialReduce(x, [x], x); } catch (error) { nonArrayVariablesRejected = true; }
    try { E.polynomialReduce(x, [x], [x, x]); } catch (error) { duplicateVariableRejected = true; }
    try { E.polynomialReduce(x, [x]); } catch (error) { missingArgumentRejected = true; }
  `);
  assertEquals(session.get(0, 'nonArrayBasisRejected'), true);
  assertEquals(session.get(0, 'nonArrayVariablesRejected'), true);
  assertEquals(session.get(0, 'duplicateVariableRejected'), true);
  assertEquals(session.get(0, 'missingArgumentRejected'), true);
});

Deno.test("Groebner basis: non-polynomial expression shapes reject at the boundary", () => {
  const session = run(SETUP + `
    let divisionRejected = false;
    let negativePowerRejected = false;
    let fractionalPowerRejected = false;
    let unlistedSymbolRejected = false;
    try { E.groebnerBasis([E.divide(1n, x)], [x]); } catch (error) { divisionRejected = true; }
    try { E.groebnerBasis([E.power(x, -1n)], [x]); } catch (error) { negativePowerRejected = true; }
    try { E.groebnerBasis([E.power(x, Exact.rational(1n, 2n))], [x]); } catch (error) { fractionalPowerRejected = true; }
    try { E.groebnerBasis([E.add(x, y)], [x]); } catch (error) { unlistedSymbolRejected = true; }
  `);
  assertEquals(session.get(0, 'divisionRejected'), true);
  assertEquals(session.get(0, 'negativePowerRejected'), true);
  assertEquals(session.get(0, 'fractionalPowerRejected'), true);
  assertEquals(session.get(0, 'unlistedSymbolRejected'), true);
});

Deno.test("polynomialReduce: non-polynomial targets and generators reject", () => {
  const session = run(SETUP + `
    let targetRejected = false;
    let generatorRejected = false;
    try { E.polynomialReduce(E.divide(1n, x), [x], [x]); } catch (error) { targetRejected = true; }
    try { E.polynomialReduce(x, [E.divide(1n, x)], [x]); } catch (error) { generatorRejected = true; }
  `);
  assertEquals(session.get(0, 'targetRejected'), true);
  assertEquals(session.get(0, 'generatorRejected'), true);
});

Deno.test("Groebner basis: variable-free exact constants have coherent bases and remainders", () => {
  const session = run(SETUP + `
    let zeroBasis = E.groebnerBasis([0n], []);
    let unitBasis = E.groebnerBasis([A.squareRoot(2n)], []);
    let zeroRemainder = E.polynomialReduce(A.squareRoot(3n), unitBasis, []);
    let emptyRemainder = E.polynomialReduce(A.squareRoot(3n), [], []);
    let zeroBasisMatches = zeroBasis.length === 0;
    let unitBasisMatches = unitBasis.length === 1 && E.equal(unitBasis[0], 1n);
    let zeroRemainderMatches = E.equal(zeroRemainder, 0n);
    let emptyRemainderMatches = E.equal(emptyRemainder, A.squareRoot(3n));
  `);
  assertEquals(session.get(0, 'zeroBasisMatches'), true);
  assertEquals(session.get(0, 'unitBasisMatches'), true);
  assertEquals(session.get(0, 'zeroRemainderMatches'), true);
  assertEquals(session.get(0, 'emptyRemainderMatches'), true);
});

Deno.test("Groebner basis: call frame resumes after collection without losing arguments", () => {
  const session = freshSession({ heapSize: 4 * 1024 * 1024, gcCollector: 'js' });
  parseAndSetup(session, SETUP + `
    let wasteRounds = 0;
    while (wasteRounds < 5) {
      let waste = [];
      let wasteIndex = 0;
      while (wasteIndex < 30000) { waste.push(wasteIndex); wasteIndex++; }
      waste = null;
      wasteRounds++;
    }
    let basis = E.groebnerBasis([
      E.subtract(E.multiply(x, y), 1n),
      E.subtract(E.power(y, 2n), x)
    ], [x, y]);
    let valid = basis.length === 2
      && E.equal(E.polynomialReduce(E.subtract(E.power(x, 2n), y), basis, [x, y]), 0n);
  `);
  let result = session.run(0, 100000000);
  let collections = 0;
  while (result.status === 'memory_pressure' && collections < 20) {
    session.gc();
    collections++;
    result = session.run(0, 100000000);
  }
  assertEquals(result.status, 'done');
  assertEquals(collections > 0, true);
  assertEquals(session.get(0, 'valid'), true);
});

Deno.test("Groebner basis: oversized sparse records survive collection without corrupting the heap", () => {
  const session = freshSession({ heapSize: 64 * 1024 * 1024, gcCollector: 'js' });
  parseAndSetup(session, SETUP + `
    let level = [];
    let degree = 0n;
    while (degree < 916n) {
      level.push(E.power(x, degree));
      degree++;
    }
    while (level.length > 1) {
      let nextLevel = [];
      let index = 0;
      while (index < level.length) {
        if (index + 1 < level.length) {
          nextLevel.push(E.add(level[index], level[index + 1]));
        } else {
          nextLevel.push(level[index]);
        }
        index += 2;
      }
      level = nextLevel;
    }
    let dense = level[0];
    let marker = 42n;
    let result = E.polynomialReduce(E.multiply(dense, dense), [], [x]);
  `);
  const firstResult = session.run(0, 100000000);
  assertEquals(firstResult.status, 'memory_pressure');
  session.gc();
  const secondResult = session.run(0, 100000000);
  assertEquals(secondResult.status, 'memory_pressure');
  assertEquals(session.get(0, 'marker'), 42n);
});

const UNIVARIATE_POWER_CASES = [
  { degree: 1, targetExponent: 4 },
  { degree: 2, targetExponent: 5 },
  { degree: 3, targetExponent: 6 },
  { degree: 4, targetExponent: 7 },
  { degree: 5, targetExponent: 8 },
  { degree: 6, targetExponent: 9 },
];

for (const { degree, targetExponent } of UNIVARIATE_POWER_CASES) {
  Deno.test(`Groebner basis: univariate monomial degree ${degree} is already reduced`, () => {
    const session = run(SETUP + `
      let generator = E.power(x, ${degree}n);
      let basis = E.groebnerBasis([generator], [x]);
      let target = E.power(x, ${targetExponent}n);
      let basisMatches = basis.length === 1 && E.equal(basis[0], E.simplify(generator));
      let targetReduces = E.equal(E.polynomialReduce(target, basis, [x]), 0n);
    `);
    assertEquals(session.get(0, 'basisMatches'), true);
    assertEquals(session.get(0, 'targetReduces'), true);
  });
}

const LINEAR_SYSTEM_CASES = [
  { xCoordinate: '0n', yCoordinate: '0n', label: 'origin' },
  { xCoordinate: '1n', yCoordinate: '2n', label: 'positive integers' },
  { xCoordinate: '-3n', yCoordinate: '5n', label: 'mixed signs' },
  { xCoordinate: 'Exact.rational(1n, 2n)', yCoordinate: 'Exact.rational(2n, 3n)', label: 'positive rationals' },
  { xCoordinate: 'Exact.rational(-4n, 5n)', yCoordinate: 'Exact.rational(7n, 9n)', label: 'signed rationals' },
];

for (const { xCoordinate, yCoordinate, label } of LINEAR_SYSTEM_CASES) {
  Deno.test(`Groebner basis: independent linear system at ${label}`, () => {
    const session = run(SETUP + `
      let first = E.subtract(x, ${xCoordinate});
      let second = E.subtract(y, ${yCoordinate});
      let basis = E.groebnerBasis([second, first], [x, y]);
      let firstMatches = E.equal(basis[0], E.simplify(first));
      let secondMatches = E.equal(basis[1], E.simplify(second));
      let lengthMatches = basis.length === 2;
    `);
    assertEquals(session.get(0, 'lengthMatches'), true);
    assertEquals(session.get(0, 'firstMatches'), true);
    assertEquals(session.get(0, 'secondMatches'), true);
  });
}

const NORMAL_FORM_CASES = [
  { label: 'x squared', target: 'E.power(x, 2n)', expected: 'y' },
  { label: 'x fourth', target: 'E.power(x, 4n)', expected: '1n' },
  { label: 'x squared times y', target: 'E.multiply(E.power(x, 2n), y)', expected: '1n' },
  { label: 'x cubed', target: 'E.power(x, 3n)', expected: 'E.multiply(x, y)' },
  { label: 'y cubed', target: 'E.power(y, 3n)', expected: 'y' },
  { label: 'x fifth', target: 'E.power(x, 5n)', expected: 'x' },
];

for (const { label, target, expected } of NORMAL_FORM_CASES) {
  Deno.test(`polynomialReduce: canonical quotient relations reduce ${label}`, () => {
    const session = run(SETUP + `
      let basis = E.groebnerBasis([
        E.subtract(E.power(x, 2n), y),
        E.subtract(E.power(y, 2n), 1n)
      ], [x, y]);
      let remainder = E.polynomialReduce(${target}, basis, [x, y]);
      let matches = E.equal(remainder, E.simplify(${expected}));
    `);
    assertEquals(session.get(0, 'matches'), true);
  });
}

const RATIONAL_COEFFICIENT_CASES = [
  { label: 'integer half', coefficient: '2n', constant: '1n', expected: 'Exact.rational(1n, 2n)' },
  { label: 'negative integer', coefficient: '-3n', constant: '2n', expected: 'Exact.rational(-2n, 3n)' },
  { label: 'fractional leading coefficient', coefficient: 'Exact.rational(1n, 2n)', constant: '3n', expected: '6n' },
  {
    label: 'two rational coefficients',
    coefficient: 'Exact.rational(2n, 3n)',
    constant: 'Exact.rational(-5n, 7n)',
    expected: 'Exact.rational(-15n, 14n)',
  },
];

for (const { label, coefficient, constant, expected } of RATIONAL_COEFFICIENT_CASES) {
  Deno.test(`Groebner basis: monic normalization with ${label}`, () => {
    const session = run(SETUP + `
      let generator = E.add(E.multiply(${coefficient}, x), ${constant});
      let basis = E.groebnerBasis([generator], [x]);
      let arguments = E.args(basis[0]);
      let leadingMatches = E.equal(arguments[0], x);
      let constantMatches = Exact.equal(arguments[1], ${expected});
      let generatorReduces = E.equal(E.polynomialReduce(generator, basis, [x]), 0n);
    `);
    assertEquals(session.get(0, 'leadingMatches'), true);
    assertEquals(session.get(0, 'constantMatches'), true);
    assertEquals(session.get(0, 'generatorReduces'), true);
  });
}

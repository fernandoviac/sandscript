/**
 * Ring 6 (6c) — the term-universe widening (TYPE.ALGEBRAIC becomes a
 * legal Expression argument at the $expression_arg_type_ok chokepoint)
 * and rootsOfPolynomial over algebraic coefficients via norm
 * elimination: coefficients decompose as r + q·α for ONE algebraic
 * value α, N(x) = Res_t(p_α, L·(R + t·Q)) is isolated, and candidates
 * are filtered EXACTLY by 6b Horner evaluation.
 */

import { assertEquals } from "https://deno.land/std@0.208.0/assert/mod.ts";
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
  let E = Exact.Expression;
  let sqrt2 = Exact.AlgebraicNumber.squareRoot(2n);
`;

// ---------- universe widening ----------

Deno.test("widening: make, substitute, and structural equal accept algebraic atoms", () => {
  const session = run(SETUP + `
    let made = E.make(Symbol.for('Add'), [sqrt2, x]);
    let madeType = Exact.typeOf(made);
    let viaSubstitute = E.substitute(E.add(x, 1n), x, sqrt2);
    let substituteType = Exact.typeOf(viaSubstitute);
    let same = E.equal(E.add(sqrt2, x), E.add(sqrt2, x));
    let different = E.equal(E.add(sqrt2, x),
      E.add(Exact.AlgebraicNumber.squareRoot(3n), x));
  `);
  assertEquals(session.get(0, 'madeType'), 'expression');
  assertEquals(session.get(0, 'substituteType'), 'expression');
  assertEquals(session.get(0, 'same'), true);
  assertEquals(session.get(0, 'different'), false);
});

Deno.test("widening: simplify collects like terms with algebraic coefficients", () => {
  const session = run(SETUP + `
    let collected = E.simplify(E.add(E.multiply(sqrt2, x), E.multiply(sqrt2, x)));
    let roots = Exact.AlgebraicNumber.rootsOfPolynomial(collected, x);
    let count = roots.length;
    let onlyRootIsZero = roots[0] === 0;
  `);
  assertEquals(session.get(0, 'count'), 1);
  assertEquals(session.get(0, 'onlyRootIsZero'), true);
});

Deno.test("widening: Matrix entries admit algebraic values", () => {
  const session = run(SETUP + `
    let M = Exact.Matrix.make([[sqrt2, 0n], [0n, 1n]]);
    let mType = Exact.typeOf(M);
    let det = Exact.Matrix.determinant(M);
    let detIsSqrt2 = Exact.AlgebraicNumber.equals(det, sqrt2);
  `);
  assertEquals(session.get(0, 'mType'), 'matrix');
  assertEquals(session.get(0, 'detIsSqrt2'), true);
});

Deno.test("widening: algebraic leaves keep printing and marshaling as values", () => {
  const session = run(SETUP + `
    let str = '' + sqrt2;
    let json = JSON.stringify([sqrt2, 1n]);
  `);
  assertEquals(session.get(0, 'str'), 'algebraic(x^2 - 2, (0, 8))');
  assertEquals(session.get(0, 'json'),
    '[{"$algebraic":{"definingPolynomial":["-2","0","1"],"isolatingInterval":["0","8"]}},{"$bigint":"1"}]');
});

// ---------- algebraic-coefficient roots ----------

Deno.test("roots of x^2 - sqrt2 are the fourth roots of 2", () => {
  const session = run(SETUP + `
    let roots = Exact.AlgebraicNumber.rootsOfPolynomial(
      E.subtract(E.power(x, 2n), sqrt2), x);
    let count = roots.length;
    let fourthRoot = Exact.AlgebraicNumber.nthRoot(2n, 4n);
    let positiveMatches = Exact.AlgebraicNumber.equals(roots[1], fourthRoot);
    let negativeMatches = Exact.AlgebraicNumber.isZero(roots[0] + fourthRoot);
  `);
  assertEquals(session.get(0, 'count'), 2);
  assertEquals(session.get(0, 'positiveMatches'), true);
  assertEquals(session.get(0, 'negativeMatches'), true);
});

Deno.test("false candidates are filtered exactly: x - sqrt2 has ONE root", () => {
  // The norm x^2 - 2 offers ±√2 as candidates; exact Horner
  // evaluation keeps only +√2.
  const session = run(SETUP + `
    let roots = Exact.AlgebraicNumber.rootsOfPolynomial(E.subtract(x, sqrt2), x);
    let count = roots.length;
    let isSqrt2 = Exact.AlgebraicNumber.equals(roots[0], sqrt2);
  `);
  assertEquals(session.get(0, 'count'), 1);
  assertEquals(session.get(0, 'isSqrt2'), true);
});

Deno.test("linear-in-alpha coefficient shapes: q*alpha products and r + q*alpha sums", () => {
  // x² − 2√2·x + 2 = (x − √2)²: squarefree norm machinery still finds
  // the (single, double) root √2. And (x − (1+√2)) shifts correctly.
  const session = run(SETUP + `
    let doubled = Exact.AlgebraicNumber.rootsOfPolynomial(
      E.add(E.subtract(E.power(x, 2n), E.multiply(E.multiply(2n, sqrt2), x)), 2n), x);
    let doubledCount = doubled.length;
    let doubledIsSqrt2 = Exact.AlgebraicNumber.equals(doubled[0], sqrt2);
    let shifted = Exact.AlgebraicNumber.rootsOfPolynomial(
      E.subtract(x, E.add(1n, sqrt2)), x);
    let shiftedCount = shifted.length;
    let shiftedMatches = Exact.AlgebraicNumber.equals(shifted[0], sqrt2 + 1n);
  `);
  assertEquals(session.get(0, 'doubledCount'), 1);
  assertEquals(session.get(0, 'doubledIsSqrt2'), true);
  assertEquals(session.get(0, 'shiftedCount'), 1);
  assertEquals(session.get(0, 'shiftedMatches'), true);
});

Deno.test("distinct algebraic coefficient values (r>=2) now succeed via multivariate elimination (Item 1)", () => {
  // sqrt2*x^2 - sqrt3 = 0  =>  x^2 = sqrt3/sqrt2 (positive) => two real
  // roots, each with defining polynomial 2x^4 - 3 = 0 (Res_t(t^2-2,
  // x^2*t-sqrt3) up to sign/squarefree normalization; the factorization was
  // verified by hand.
  const session = run(SETUP + `
    let sqrt3 = Exact.AlgebraicNumber.squareRoot(3n);
    let roots = Exact.AlgebraicNumber.rootsOfPolynomial(
      E.subtract(E.multiply(sqrt2, E.power(x, 2n)), sqrt3), x);
    let count = roots.length;
  `);
  assertEquals(session.get(0, 'count'), 2);
  const roots = session.get(0, 'roots');
  // Both roots share the same (degree-4) minimal polynomial up to an
  // overall scalar -- normalize by the leading coefficient's sign/gcd.
  const normalize = (coeffs) => {
    let gcd = 0n;
    for (const c of coeffs) {
      let v = c < 0n ? -c : c;
      while (v) { [gcd, v] = [v, gcd % v]; }
    }
    let out = coeffs.map(c => c / gcd);
    if (out[out.length - 1] < 0n) out = out.map(c => -c);
    return out;
  };
  assertEquals(normalize(roots[0].definingPolynomial), normalize(roots[1].definingPolynomial));
  assertEquals(normalize(roots[0].definingPolynomial), [-3n, 0n, 0n, 0n, 2n]);
});

Deno.test("r=3 false candidates are interval-rejected before exact field extension", () => {
  // sqrt2*x^2+sqrt3*x+sqrt5 has no real roots because its
  // discriminant is 3-4*sqrt(10) < 0. Its degree-16 eliminant still
  // has four real roots from other coefficient embeddings. Rigorous
  // interval Horner evaluation must reject all four under the actual
  // coefficient embedding before the much larger candidate compositum
  // is built. The default heap pins that memory-safety contract.
  const session = run(SETUP + `
    let sqrt3 = Exact.AlgebraicNumber.squareRoot(3n);
    let sqrt5 = Exact.AlgebraicNumber.squareRoot(5n);
    let roots = Exact.AlgebraicNumber.rootsOfPolynomial(
      E.add(E.add(E.multiply(sqrt2, E.power(x, 2n)), E.multiply(sqrt3, x)), sqrt5), x);
    let count = roots.length;
  `);
  assertEquals(session.get(0, 'count'), 0);
});

Deno.test("minimal real roots discard unrelated rational sibling factors", () => {
  // α starts as the √2 root of (t²−2)(t−3). Root minting selects t²−2,
  // so the unrelated rational sibling 3 cannot make a later norm degenerate.
  const session = run(SETUP + `
    let t = Symbol.for('t');
    let roots = Exact.AlgebraicNumber.rootsOfPolynomial(
      E.multiply(E.subtract(E.power(t, 2n), 2n), E.subtract(t, 3n)), t);
    let alpha = roots[1];
    let alphaIsSqrt2 = Exact.AlgebraicNumber.equals(alpha, sqrt2);
    let result = Exact.AlgebraicNumber.rootsOfPolynomial(
      E.multiply(E.subtract(alpha, 3n), E.add(E.power(x, 2n), 1n)), x);
    let resultIsEmpty = result.length === 0;
  `);
  assertEquals(session.get(0, 'alphaIsSqrt2'), true);
  assertEquals(session.get(0, 'resultIsEmpty'), true);
});

Deno.test("rational-coefficient path is untouched: mixed trees still work", () => {
  const session = run(SETUP + `
    let plain = Exact.AlgebraicNumber.rootsOfPolynomial(
      E.subtract(E.power(x, 2n), 2n), x);
    let plainCount = plain.length;
    let stillMatches = Exact.AlgebraicNumber.equals(plain[1], sqrt2);
  `);
  assertEquals(session.get(0, 'plainCount'), 2);
  assertEquals(session.get(0, 'stillMatches'), true);
});

// ---------- complex algebraic numbers ----------

Deno.test("ComplexAlgebraicNumber: construction, projections, comparison, printing, and JSON round-trip", () => {
  const session = run(SETUP + `
    let C = Exact.ComplexAlgebraicNumber;
    let sqrt3 = Exact.AlgebraicNumber.squareRoot(3n);
    let value = C.fromParts(sqrt2, sqrt3);
    let valueType = Exact.typeOf(value);
    let isComplexAlgebraic = C.isComplexAlgebraicNumber(value);
    let realMatches = Exact.AlgebraicNumber.equals(C.realPart(value), sqrt2);
    let imaginaryMatches = Exact.AlgebraicNumber.equals(C.imaginaryPart(value), sqrt3);
    let equalCopy = C.equals(value, C.fromParts(sqrt2, sqrt3));
    let equalRealTowerValue = C.equals(C.fromParts(2n, 0n), 2n);
    let rendered = Exact.toString(value);
    let json = JSON.stringify(value);
  `);
  const value = session.getExact(0, 'value');
  assertEquals(value.kind, 'complex-algebraic');
  assertEquals(value.real.kind, 'algebraic');
  assertEquals(value.imaginary.kind, 'algebraic');
  assertEquals(session.get(0, 'valueType'), 'complexAlgebraic');
  assertEquals(session.get(0, 'isComplexAlgebraic'), true);
  assertEquals(session.get(0, 'realMatches'), true);
  assertEquals(session.get(0, 'imaginaryMatches'), true);
  assertEquals(session.get(0, 'equalCopy'), true);
  assertEquals(session.get(0, 'equalRealTowerValue'), true);
  assertEquals(session.get(0, 'rendered').startsWith('complexAlgebraic('), true);
  const encoded = JSON.parse(session.get(0, 'json'));
  assertEquals(Object.keys(encoded), ['$complexAlgebraic']);
  assertEquals(Object.keys(encoded.$complexAlgebraic), ['realPart', 'imaginaryPart']);
});

Deno.test("ComplexAlgebraicNumber: exact arithmetic, conjugation, modulus, and named roots", () => {
  const session = run(SETUP + `
    let C = Exact.ComplexAlgebraicNumber;
    let sqrt3 = Exact.AlgebraicNumber.squareRoot(3n);
    let value = C.fromParts(sqrt2, sqrt3);
    let legacy = Exact.complex(1n, 2n);
    let sum = value + legacy;
    let difference = value - legacy;
    let product = value * legacy;
    let quotient = value / legacy;
    let sumMatches = C.equals(sum, C.add(value, legacy));
    let differenceMatches = C.equals(difference, C.subtract(value, legacy));
    let productMatches = C.equals(product, C.multiply(value, legacy));
    let quotientMatches = C.equals(quotient, C.divide(value, legacy));
    let quotientReconstructs = C.equals(quotient * legacy, value);
    let negationMatches = C.equals(-value, C.negate(value));
    let conjugateMatches = C.equals(C.conjugate(value), C.fromParts(sqrt2, -sqrt3));
    let modulusSquaredMatches =
      Exact.AlgebraicNumber.equals(C.modulusSquared(value), 5n);
    let modulus = C.modulus(value);
    let modulusMatches =
      Exact.AlgebraicNumber.equals(modulus, Exact.AlgebraicNumber.squareRoot(5n));
    let principalRoot = C.squareRoot(value);
    let principalRootSquares = C.equals(principalRoot * principalRoot, value);
    let negativeRealRoot = C.squareRoot(-4n);
    let negativeRealRootSquares =
      C.equals(negativeRealRoot * negativeRealRoot, -4n);
    let cubeRoot = C.nthRoot(C.fromParts(3n, 4n), 3n);
    let cubeRootCubes = C.equals(cubeRoot * cubeRoot * cubeRoot, C.fromParts(3n, 4n));
    let principalNegativeCubeRoot = C.nthRoot(-8n, 3n);
    let principalNegativeCubeRootMatches =
      C.equals(principalNegativeCubeRoot * principalNegativeCubeRoot
        * principalNegativeCubeRoot, -8n)
      && C.equals(C.realPart(principalNegativeCubeRoot), 1n)
      && C.equals(C.imaginaryPart(principalNegativeCubeRoot), sqrt3);
  `, { heapSize: 512 * 1024 * 1024 });
  for (const name of [
    'sumMatches',
    'differenceMatches',
    'productMatches',
    'quotientMatches',
    'quotientReconstructs',
    'negationMatches',
    'conjugateMatches',
    'modulusSquaredMatches',
    'modulusMatches',
    'principalRootSquares',
    'negativeRealRootSquares',
    'cubeRootCubes',
    'principalNegativeCubeRootMatches',
  ]) {
    assertEquals(session.get(0, name), true, name);
  }
});

Deno.test("ComplexAlgebraicNumber: nthRoot resumes through collection without losing its call frame", () => {
  const session = freshSession({ heapSize: 3 * 1024 * 1024 });
  parseAndSetup(session, SETUP + `
    let C = Exact.ComplexAlgebraicNumber;
    let waste = [];
    let wasteIndex = 0;
    while (wasteIndex < 50000) {
      waste.push(wasteIndex);
      wasteIndex++;
    }
    waste = null;
    let cubeRoot = C.nthRoot(C.fromParts(3n, 4n), 3n);
  `);
  let result = session.run(0, 1000000000);
  let collections = 0;
  while (result.status === 'memory_pressure' && collections < 20) {
    session.gc();
    collections++;
    result = session.run(0, 1000000000);
  }
  assertEquals(result.status, 'done');
  assertEquals(collections > 0, true);
  const cubeRoot = session.getExact(0, 'cubeRoot');
  assertEquals(cubeRoot.kind, 'complex-algebraic');
  assertEquals(cubeRoot.real.kind, 'algebraic');
  assertEquals(cubeRoot.imaginary.kind, 'algebraic');
});


Deno.test("ComplexAlgebraicNumber: rootsOfPolynomial returns every distinct complex root", () => {
  const session = run(SETUP + `
    let C = Exact.ComplexAlgebraicNumber;
    let xSquared = E.power(x, 2n);
    let imaginaryRoots = C.rootsOfPolynomial(E.add(xSquared, 1n), x);
    let imaginaryRootsMatch = imaginaryRoots.length === 2
      && C.equals(imaginaryRoots[0] * imaginaryRoots[0], -1n)
      && C.equals(imaginaryRoots[1] * imaginaryRoots[1], -1n)
      && !C.equals(imaginaryRoots[0], imaginaryRoots[1]);
    let realRoots = Exact.AlgebraicNumber.rootsOfPolynomial(
      E.subtract(xSquared, 1n), x);
    let complexRealRoots = C.rootsOfPolynomial(E.subtract(xSquared, 1n), x);
    let first = C.fromParts(1n, 1n);
    let second = C.fromParts(2n, -1n);
    let complexRoots = C.rootsOfPolynomial(
      E.multiply(E.subtract(x, first), E.subtract(x, second)), x);
    let complexRootsMatch = complexRoots.length === 2
      && (C.equals(complexRoots[0], first) || C.equals(complexRoots[1], first))
      && (C.equals(complexRoots[0], second) || C.equals(complexRoots[1], second));
    let repeatedRoots = C.rootsOfPolynomial(
      E.power(E.subtract(x, first), 2n), x);
    let repeatedRootMatches =
      repeatedRoots.length === 1 && C.equals(repeatedRoots[0], first);
    let sqrt3 = Exact.AlgebraicNumber.squareRoot(3n);
    let algebraicRoot = C.fromParts(sqrt2, sqrt3);
    let algebraicLinearRoots =
      C.rootsOfPolynomial(E.subtract(x, algebraicRoot), x);
    let algebraicLinearRootMatches = algebraicLinearRoots.length === 1
      && C.equals(algebraicLinearRoots[0], algebraicRoot);
  `, { heapSize: 512 * 1024 * 1024 });
  assertEquals(session.get(0, 'imaginaryRootsMatch'), true);
  assertEquals(session.getExact(0, 'complexRealRoots'),
    session.getExact(0, 'realRoots'));
  assertEquals(session.get(0, 'complexRootsMatch'), true);
  assertEquals(session.get(0, 'repeatedRootMatches'), true);
  assertEquals(session.get(0, 'algebraicLinearRootMatches'), true);
});

Deno.test("ComplexAlgebraicNumber: root validation rejects invalid index and coefficient", () => {
  const session = run(SETUP + `
    let C = Exact.ComplexAlgebraicNumber;
    let invalidIndexRejected = false;
    try { C.nthRoot(1n, 0n); } catch (error) { invalidIndexRejected = true; }
    let invalidCoefficientRejected = false;
    try {
      C.rootsOfPolynomial(E.add(x, Symbol.for('notNumeric')), x);
    } catch (error) { invalidCoefficientRejected = true; }
  `);
  assertEquals(session.get(0, 'invalidIndexRejected'), true);
  assertEquals(session.get(0, 'invalidCoefficientRejected'), true);
});

Deno.test("ComplexAlgebraicNumber: expression, matrix, typeof, and approximation integration", () => {
  const session = run(SETUP + `
    let C = Exact.ComplexAlgebraicNumber;
    let sqrt3 = Exact.AlgebraicNumber.squareRoot(3n);
    let value = C.fromParts(sqrt2, sqrt3);
    let jsType = typeof value;
    let expression = E.add(value, 1n);
    let expressionAdmits =
      C.equals(E.args(expression)[0], value);
    let matrix = Exact.Matrix.make([[value]]);
    let matrixAdmits =
      C.equals(Exact.Matrix.get(matrix, 0, 0), value);
    let approximation = C.toApproximation(value, -30n);
    let approximationMatches = Array.isArray(approximation)
      && approximation.length === 2
      && typeof approximation[0] === 'number'
      && typeof approximation[1] === 'number'
      && approximation[0] > 1
      && approximation[1] > 1;
  `);
  assertEquals(session.get(0, 'jsType'), 'number');
  assertEquals(session.get(0, 'expressionAdmits'), true);
  assertEquals(session.get(0, 'matrixAdmits'), true);
  assertEquals(session.get(0, 'approximationMatches'), true);
});

Deno.test("ComplexAlgebraicNumber: quadratic and cubic roots obey conjugacy and real-root identity", () => {
  const session = run(SETUP + `
    let C = Exact.ComplexAlgebraicNumber;
    let A = Exact.AlgebraicNumber;
    let xSquared = E.power(x, 2n);
    let quadratic = E.add(E.add(xSquared, x), 1n);
    let quadraticRoots = C.rootsOfPolynomial(quadratic, x);
    let quadraticMatches = quadraticRoots.length === 2
      && C.equals(C.conjugate(quadraticRoots[0]), quadraticRoots[1])
      && C.equals(C.modulusSquared(quadraticRoots[0]), 1n)
      && C.equals(C.modulusSquared(quadraticRoots[1]), 1n);

    let cubic = E.subtract(E.power(x, 3n), 2n);
    let cubicRoots = C.rootsOfPolynomial(cubic, x);
    let realRoots = A.rootsOfPolynomial(cubic, x);
    let realMatchCount = 0;
    let nonrealRoots = [];
    let everyRootMatches = cubicRoots.length === 3;
    for (let root of cubicRoots) {
      everyRootMatches = everyRootMatches
        && C.equals(root * root * root, 2n);
      if (C.equals(root, realRoots[0])) {
        realMatchCount++;
      } else {
        nonrealRoots.push(root);
      }
    }
    let cubicMatches = everyRootMatches
      && realRoots.length === 1
      && realMatchCount === 1
      && nonrealRoots.length === 2
      && C.equals(C.conjugate(nonrealRoots[0]), nonrealRoots[1]);
  `, { heapSize: 512 * 1024 * 1024 });
  assertEquals(session.get(0, 'quadraticMatches'), true);
  assertEquals(session.get(0, 'cubicMatches'), true);
});

Deno.test("ComplexAlgebraicNumber: cubic and quartic roots fit the consumer budget", () => {
  const cases = [
    { degree: 3n, constant: 1n, operation: 'subtract' },
    { degree: 3n, constant: 2n, operation: 'subtract' },
    { degree: 4n, constant: 1n, operation: 'subtract' },
    { degree: 4n, constant: 1n, operation: 'add' },
  ];
  for (const testCase of cases) {
    const session = freshSession({ heapSize: 8 * 1024 * 1024 });
    parseAndSetup(session, `
      let E = Exact.Expression;
      let C = Exact.ComplexAlgebraicNumber;
      let x = Symbol.for('x');
      let roots = C.rootsOfPolynomial(
        E.${testCase.operation}(
          E.power(x, ${testCase.degree}n),
          ${testCase.constant}n),
        x);
    `);
    const result = session.run(0, 20_000_000);
    assertEquals(result.status, 'done',
      `degree ${testCase.degree} ${testCase.operation}`);
    assertEquals(session.getExact(0, 'roots').length, Number(testCase.degree),
      `degree ${testCase.degree} ${testCase.operation}`);
    session.gc();
    assertEquals(session.getExact(0, 'roots').length, Number(testCase.degree),
      `degree ${testCase.degree} ${testCase.operation} after collection`);
  }
});

Deno.test("ComplexAlgebraicNumber: exact eighth-turn rotation closes after eight products", () => {
  const session = run(`
    let A = Exact.AlgebraicNumber;
    let C = Exact.ComplexAlgebraicNumber;
    let eighthTurn = Exact.rational(1n, 8n);
    let rotation = C.fromParts(
      A.cosineOfTurns(eighthTurn),
      A.sineOfTurns(eighthTurn));
    let value = 1n;
    let index = 0;
    while (index < 8) {
      value = C.multiply(value, rotation);
      index++;
    }
    let closes = C.equals(value, 1n);
  `, { heapSize: 512 * 1024 * 1024 });
  assertEquals(session.get(0, 'closes'), true);
});

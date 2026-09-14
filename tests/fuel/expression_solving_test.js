import { assert, assertEquals } from "https://deno.land/std@0.208.0/assert/mod.ts";
import { freshSession } from '../../src/host-owned-session.js';
import { parseAndSetup } from './test-helpers.js';

function run(source) {
  const session = freshSession({ heapSize: 64 * 1024 * 1024 });
  parseAndSetup(session, `let E = Exact.Expression;
let x = Symbol.for('x');
let y = Symbol.for('y');
` + source);
  let result = session.run(0, 1000000000);
  let collections = 0;
  while (result.status === 'memory_pressure' && collections < 400) {
    session.collectGarbage(0);
    result = session.run(0, 1000000000);
    collections += 1;
  }
  assertEquals(result.status, 'done');
  return session;
}

const rational = (n, d = 1n) => ({ kind: 'rational', numerator: n, denominator: d });

Deno.test("factor: complete rational factorization of x^4 - 1", () => {
  const session = run(`
    let record = E.factor(E.subtract(E.power(x, 4n), 1n), x);
    let unitValue = record.unit;
    let count = record.factors.length;
    let multiplicities = record.factors.map((pair) => pair[1]);
    let hasLinearMinus = record.factors.some((pair) =>
      E.equal(pair[0], E.simplify(E.subtract(x, 1n))));
    let hasLinearPlus = record.factors.some((pair) =>
      E.equal(pair[0], E.simplify(E.add(x, 1n))));
    let hasQuadratic = record.factors.some((pair) =>
      E.equal(pair[0], E.simplify(E.add(E.power(x, 2n), 1n))));
  `);
  assertEquals(session.getExact(0, 'unitValue'), rational(1n));
  assertEquals(session.get(0, 'count'), 3);
  assertEquals(session.getExact(0, 'multiplicities'), [1n, 1n, 1n]);
  for (const name of ['hasLinearMinus', 'hasLinearPlus', 'hasQuadratic']) {
    assertEquals(session.get(0, name), true, name);
  }
});

Deno.test("factor: repeated factors, rational units, and constants", () => {
  const session = run(`
    let repeated = E.factor(
      E.multiply(Exact.rational(3n, 2n), E.power(E.subtract(x, 1n), 2n)), x);
    let repeatedUnit = repeated.unit;
    let repeatedMultiplicity = repeated.factors[0][1];
    let constant = E.factor(Exact.rational(7n, 3n), x);
    let constantUnit = constant.unit;
    let constantFactors = constant.factors.length;
    let irreducible = E.factor(E.add(E.power(x, 2n), 1n), x);
    let irreducibleCount = irreducible.factors.length;
  `);
  assertEquals(session.getExact(0, 'repeatedUnit'), rational(3n, 2n));
  assertEquals(session.getExact(0, 'repeatedMultiplicity'), 2n);
  assertEquals(session.getExact(0, 'constantUnit'), rational(7n, 3n));
  assertEquals(session.get(0, 'constantFactors'), 0);
  assertEquals(session.get(0, 'irreducibleCount'), 1);
});

Deno.test("expandFactorization reconstructs the canonical polynomial", () => {
  const session = run(`
    let source = E.add(E.multiply(Exact.rational(1n, 2n), E.power(x, 5n)),
      E.subtract(E.multiply(3n, E.power(x, 3n)), E.add(E.power(x, 2n), 6n)));
    let record = E.factor(source, x);
    let reconstructed = E.expandFactorization(record);
    let matches = E.equal(reconstructed, E.simplify(source));
  `);
  assertEquals(session.get(0, 'matches'), true);
});

Deno.test("degree, coefficients, content, and primitivePart", () => {
  const session = run(`
    let f = E.add(E.multiply(6n, E.power(x, 2n)), 4n);
    let degreeValue = E.degree(f, x);
    let coefficientList = E.coefficients(f, x);
    let contentValue = E.content(f, x);
    let primitive = E.primitivePart(f, x);
    let primitiveOk = E.equal(primitive, E.simplify(E.add(E.multiply(3n, E.power(x, 2n)), 2n)));
    let negative = E.content(E.negate(E.multiply(2n, x)), x);
    let reconstructs = E.equal(
      E.simplify(E.multiply(E.content(f, x), E.primitivePart(f, x))),
      E.simplify(f));
  `);
  assertEquals(session.getExact(0, 'degreeValue'), 2n);
  assertEquals(session.getExact(0, 'coefficientList').length, 3);
  assertEquals(session.getExact(0, 'contentValue'), rational(2n));
  assertEquals(session.get(0, 'primitiveOk'), true);
  assertEquals(session.getExact(0, 'negative'), rational(-2n));
  assertEquals(session.get(0, 'reconstructs'), true);
});

Deno.test("univariate surface rejects extra free symbols and non-polynomials", () => {
  const session = run(`
    function fails(f) { try { f(); return false; } catch (e) { return true; } }
    let extraSymbol = fails(() => E.factor(E.multiply(y, x), x));
    let transcendental = fails(() => E.factor(E.exp(x), x));
    let algebraicCoefficient = fails(() =>
      E.factor(E.multiply(Exact.AlgebraicNumber.nthRoot(2n, 2n), x), x));
    let badVariable = fails(() => E.degree(x, 3n));
  `);
  for (const name of ['extraSymbol', 'transcendental', 'algebraicCoefficient', 'badVariable']) {
    assertEquals(session.get(0, name), true, name);
  }
});

Deno.test("solvePolynomial: real and complex roots with multiplicity", () => {
  const session = run(`
    let f = E.multiply(E.power(E.subtract(x, 1n), 2n), E.add(E.power(x, 2n), 1n));
    let records = E.solvePolynomial(f, x);
    let count = records.length;
    let multiplicities = records.map((r) => r.multiplicity);
    let verified = records.every((r) =>
      E.equal(E.simplify(E.substitute(f, x, r.root)), 0n));
  `);
  assertEquals(session.get(0, 'count'), 3);
  assertEquals(session.getExact(0, 'multiplicities'), [2n, 1n, 1n]);
  assertEquals(session.get(0, 'verified'), true);
});

Deno.test("solvePolynomial: algebraic coefficients through the complex-roots engine", () => {
  const session = run(`
    let sqrt2 = Exact.AlgebraicNumber.nthRoot(2n, 2n);
    let records = E.solvePolynomial(E.subtract(E.power(x, 2n), sqrt2), x);
    let count = records.length;
    let verified = records.every((r) => {
      let v = E.simplify(E.substitute(E.subtract(E.power(x, 2n), sqrt2), x, r.root));
      return E.equal(v, 0n);
    });
    let multiplicities = records.map((r) => r.multiplicity);
  `);
  assertEquals(session.get(0, 'count'), 2);
  assertEquals(session.get(0, 'verified'), true);
  assertEquals(session.getExact(0, 'multiplicities'), [1n, 1n]);
});

Deno.test("solveSystem: zero-dimensional system with exact verification", () => {
  const session = run(`
    let circle = E.subtract(E.add(E.power(x, 2n), E.power(y, 2n)), 2n);
    let line = E.subtract(x, y);
    let tuples = E.solveSystem([circle, line], [x, y]);
    let count = tuples.length;
    let widths = tuples.map((t) => t.length);
    let verified = tuples.every((t) => {
      let c = E.simplify(E.substitute(E.substitute(circle, x, t[0]), y, t[1]));
      let l = E.simplify(E.substitute(E.substitute(line, x, t[0]), y, t[1]));
      return E.equal(c, 0n) && E.equal(l, 0n);
    });
  `);
  assertEquals(session.get(0, 'count'), 2);
  assertEquals(session.getExact(0, 'widths'), [2, 2]);
  assertEquals(session.get(0, 'verified'), true);
});

Deno.test("solveSystem: inconsistent systems give the empty set; positive-dimensional systems reject", () => {
  const session = run(`
    let empty = E.solveSystem([E.subtract(x, 1n), E.subtract(x, 2n)], [x]);
    let emptyCount = empty.length;
    let rejected = false;
    try { E.solveSystem([E.subtract(x, y)], [x, y]); } catch (e) { rejected = true; }
  `);
  assertEquals(session.get(0, 'emptyCount'), 0);
  assertEquals(session.get(0, 'rejected'), true);
});

Deno.test("Matrix.solve: tagged unique, none, and family results", () => {
  const session = run(`
    let unique = Exact.Matrix.solve(Exact.Matrix.make([[2n, 0n], [0n, 4n]]), [2n, 8n]);
    let none = Exact.Matrix.solve(Exact.Matrix.make([[1n, 1n], [1n, 1n]]), [1n, 2n]);
    let family = Exact.Matrix.solve(Exact.Matrix.make([[1n, 1n]]), [3n]);
    let kinds = [unique.kind, none.kind, family.kind];
    let solution = Exact.Matrix.get(unique.solution, 1n, 0n);
    let a = Exact.Matrix.make([[1n, 1n]]);
    let familyOk = Exact.Matrix.equal(
      Exact.Matrix.multiply(a, family.particular), Exact.Matrix.make([[3n]]))
      && Exact.Matrix.equal(
        Exact.Matrix.multiply(a, family.basis[0]), Exact.Matrix.zero(1, 1));
  `);
  assertEquals(session.getExact(0, 'kinds'), ['unique', 'none', 'family']);
  assertEquals(session.getExact(0, 'solution'), rational(2n));
  assertEquals(session.get(0, 'familyOk'), true);
});

Deno.test("solveInequality: x^2 < 2 is the open interval between -sqrt(2) and sqrt(2)", () => {
  const session = run(`
    let intervals = E.solveInequality(E.make(E.Less, [E.power(x, 2n), 2n]), x);
    let count = intervals.length;
    let sqrt2 = Exact.AlgebraicNumber.nthRoot(2n, 2n);
    let lowerOk = Exact.AlgebraicNumber.equals(intervals[0].lower, -sqrt2);
    let upperOk = Exact.AlgebraicNumber.equals(intervals[0].upper, sqrt2);
    let open = intervals[0].lowerClosed === false && intervals[0].upperClosed === false;
  `);
  assertEquals(session.get(0, 'count'), 1);
  assertEquals(session.get(0, 'lowerOk'), true);
  assertEquals(session.get(0, 'upperOk'), true);
  assertEquals(session.get(0, 'open'), true);
});

Deno.test("solveInequality: closed, unbounded, disconnected, and point solution sets", () => {
  const session = run(`
    ;; x^2 >= 1: (-inf, -1] union [1, inf)
    let closed = E.solveInequality(E.make(E.GreaterEqual, [E.power(x, 2n), 1n]), x);
    let closedCount = closed.length;
    let closedShape = [
      closed[0].lower === undefined, closed[0].lowerClosed, closed[0].upperClosed,
      closed[1].lowerClosed, closed[1].upper === undefined, closed[1].upperClosed];
    ;; x^2 <= 0: the single point 0
    let point = E.solveInequality(E.make(E.LessEqual, [E.power(x, 2n), 0n]), x);
    let pointShape = [point.length, point[0].lowerClosed, point[0].upperClosed];
    let pointEqual = E.equal(point[0].lower, point[0].upper);
    ;; everything: x^2 >= 0 merges into one unbounded interval
    let everything = E.solveInequality(E.make(E.GreaterEqual, [E.power(x, 2n), 0n]), x);
    let everythingShape = [everything.length,
      everything[0].lower === undefined, everything[0].upper === undefined];
    ;; equality: x^2 = 1 gives two points
    let points = E.solveInequality(E.make(E.Equal, [E.power(x, 2n), 1n]), x);
    let pointsCount = points.length;
  `.replaceAll(';;', '//'));
  assertEquals(session.get(0, 'closedCount'), 2);
  assertEquals(session.getExact(0, 'closedShape'), [true, false, true, true, true, false]);
  assertEquals(session.getExact(0, 'pointShape'), [1, true, true]);
  assertEquals(session.get(0, 'pointEqual'), true);
  assertEquals(session.getExact(0, 'everythingShape'), [1, true, true]);
  assertEquals(session.get(0, 'pointsCount'), 2);
});

Deno.test("solveInequality: rational functions exclude denominator roots", () => {
  const session = run(`
    let intervals = E.solveInequality(E.make(E.Greater, [E.divide(1n, x), 0n]), x);
    let count = intervals.length;
    let lowerValue = intervals[0].lower;
    let lowerOpen = intervals[0].lowerClosed === false;
    let unbounded = intervals[0].upper === undefined;
    ;; 1/x <= 0: x < 0, open at 0 (0 is outside the domain)
    let negative = E.solveInequality(E.make(E.LessEqual, [E.divide(1n, x), 0n]), x);
    let negativeShape = [negative.length,
      negative[0].lower === undefined, negative[0].upperClosed];
  `.replaceAll(';;', '//'));
  assertEquals(session.get(0, 'count'), 1);
  assertEquals(session.getExact(0, 'lowerValue'), rational(0n));
  assertEquals(session.get(0, 'lowerOpen'), true);
  assertEquals(session.get(0, 'unbounded'), true);
  assertEquals(session.getExact(0, 'negativeShape'), [1, true, false]);
});

Deno.test("signChart: exact signs on every region and root", () => {
  const session = run(`
    let chart = E.signChart(E.subtract(E.power(x, 2n), 1n), x);
    let signs = chart.map((entry) => entry.sign);
    let pointEntry = chart[1];
    let pointIsRoot = E.equal(pointEntry.interval.lower, pointEntry.interval.upper);
  `);
  assertEquals(session.getExact(0, 'signs'), [1n, 0n, -1n, 0n, 1n]);
  assertEquals(session.get(0, 'pointIsRoot'), true);
});

Deno.test("solveInequality rejects transcendental relations loudly", () => {
  const session = run(`
    let rejected = false;
    try { E.solveInequality(E.make(E.Less, [E.exp(x), 2n]), x); }
    catch (e) { rejected = true; }
  `);
  assertEquals(session.get(0, 'rejected'), true);
});

Deno.test("satisfies: true, false, and unknown exact condition evaluation", () => {
  const session = run(`
    let positive = E.make(E.Greater, [x, 0n]);
    let sameTrue = E.satisfies(Object.freeze([positive]), [x], [2n]);
    let sameFalse = E.satisfies(Object.freeze([positive]), [x], [-2n]);
    let boundary = E.satisfies(Object.freeze([E.make(E.GreaterEqual, [x, 0n])]), [x], [0n]);
    let algebraic = E.satisfies(
      Object.freeze([E.make(E.Less, [E.power(x, 2n), 3n])]),
      [x], [Exact.AlgebraicNumber.nthRoot(2n, 2n)]);
    let transcendentalTrue = E.satisfies(
      Object.freeze([E.make(E.Greater, [E.exp(x), 0n])]), [x], [1n]);
    ;; log(exp(1)) - 1 = 0 exactly, but the difference stays symbolic and
    ;; the interval evaluator can never separate it from zero, so the
    ;; strict relation stays unknown.
    let unknown = E.satisfies(
      Object.freeze([E.make(E.Greater, [E.log(E.exp(x)), 1n])]), [x], [1n]);
    let unknownIsUndefined = unknown === undefined;
  `.replaceAll(';;', '//'));
  assertEquals(session.get(0, 'sameTrue'), true);
  assertEquals(session.get(0, 'sameFalse'), false);
  assertEquals(session.get(0, 'boundary'), true);
  assertEquals(session.get(0, 'algebraic'), true);
  assertEquals(session.get(0, 'transcendentalTrue'), true);
  assertEquals(session.get(0, 'unknownIsUndefined'), true);
});

Deno.test("simplify folds integer powers of algebraic values exactly", () => {
  // Regression: this fold used to project the algebraic base onto a
  // rational taken from its isolating interval, silently returning a
  // wrong exact value.
  const session = run(`
    let root = Exact.AlgebraicNumber.rootsOfPolynomial(
      E.subtract(E.power(x, 2n), 1n), x)[0];
    let square = E.simplify(E.power(root, 2n));
    let isOne = E.equal(square, 1n);
    let sqrt2 = Exact.AlgebraicNumber.nthRoot(2n, 2n);
    let cube = E.simplify(E.power(sqrt2, 3n));
    let cubeOk = Exact.AlgebraicNumber.equals(cube, sqrt2 * 2n);
    let reciprocal = E.simplify(E.power(sqrt2, -2n));
    let reciprocalOk = E.equal(reciprocal, Exact.rational(1n, 2n));
  `);
  assertEquals(session.get(0, 'isOne'), true);
  assertEquals(session.get(0, 'cubeOk'), true);
  assertEquals(session.get(0, 'reciprocalOk'), true);
});

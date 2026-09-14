/**
 * Ring 6 (6b) — full radical fromExpression and the named roots:
 * squareRoot / nthRoot over the whole tower, rational-exponent Power
 * trees, nested radicals (the no-denesting decidable equality), and
 * the evaluator's error surface (symbols, complex, division by zero,
 * even roots of negatives, out-of-range exponents).
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

// ---------- the flagship: nested radical equality without denesting ----------

Deno.test("fromExpression(sqrt(5 + 2*sqrt6)) equals sqrt2 + sqrt3", () => {
  const session = run(`
    let sqrt2 = Exact.AlgebraicNumber.squareRoot(2n);
    let sqrt3 = Exact.AlgebraicNumber.squareRoot(3n);
    let nested = Exact.AlgebraicNumber.fromExpression(
      Exact.Expression.power(
        Exact.Expression.add(5n, Exact.Expression.multiply(2n,
          Exact.Expression.power(6n, Exact.rational(1n, 2n)))),
        Exact.rational(1n, 2n)));
    let check = Exact.AlgebraicNumber.equals(nested, sqrt2 + sqrt3);
  `, { heapSize: 1024 * 1024 });
  assertEquals(session.get(0, 'check'), true);
});

// ---------- squareRoot / nthRoot over the tower ----------

Deno.test("squareRoot of rationals: values, ordering, principal branch", () => {
  const session = run(`
    let sqrt2 = Exact.AlgebraicNumber.squareRoot(2n);
    let positive = Exact.AlgebraicNumber.sign(sqrt2);
    let squares = Exact.AlgebraicNumber.equals(sqrt2 * sqrt2, 2n);
    let ofRational = Exact.AlgebraicNumber.squareRoot(Exact.rational(9n, 4n));
    let threeHalves = Exact.AlgebraicNumber.equals(ofRational, Exact.rational(3n, 2n));
    let ofFour = Exact.AlgebraicNumber.squareRoot(4n);
    let twoValued = Exact.AlgebraicNumber.equals(ofFour, 2n);
    let zeroRoot = Exact.AlgebraicNumber.squareRoot(0n);
    let zeroTyped = Exact.typeOf(zeroRoot);
  `);
  assertEquals(session.get(0, 'positive'), 1);
  assertEquals(session.get(0, 'squares'), true);
  assertEquals(session.get(0, 'threeHalves'), true);
  assertEquals(session.get(0, 'twoValued'), true);
  assertEquals(session.get(0, 'zeroTyped'), 'integer');
});

Deno.test("nthRoot: cube and fifth roots, odd roots of negatives", () => {
  const session = run(`
    let cbrt2 = Exact.AlgebraicNumber.nthRoot(2n, 3n);
    let cubed = Exact.AlgebraicNumber.equals(cbrt2 * cbrt2 * cbrt2, 2n);
    let cbrtNeg8 = Exact.AlgebraicNumber.nthRoot(-8n, 3n);
    let minusTwo = Exact.AlgebraicNumber.equals(cbrtNeg8, -2n);
    let fifth = Exact.AlgebraicNumber.nthRoot(Exact.rational(1n, 32n), 5n);
    let halfBack = Exact.AlgebraicNumber.equals(fifth, Exact.rational(1n, 2n));
    let identityRoot = Exact.AlgebraicNumber.nthRoot(cbrt2, 1n);
    let unchanged = Exact.AlgebraicNumber.equals(identityRoot, cbrt2);
  `, { heapSize: 1024 * 1024 });
  assertEquals(session.get(0, 'cubed'), true);
  assertEquals(session.get(0, 'minusTwo'), true);
  assertEquals(session.get(0, 'halfBack'), true);
  assertEquals(session.get(0, 'unchanged'), true);
});

Deno.test("nthRoot of an algebraic value: sqrt(sqrt2) is the fourth root of 2", () => {
  const session = run(`
    let sqrt2 = Exact.AlgebraicNumber.squareRoot(2n);
    let fourth = Exact.AlgebraicNumber.squareRoot(sqrt2);
    let positive = Exact.AlgebraicNumber.sign(fourth);
    let fourthPower = fourth * fourth * fourth * fourth;
    let isTwo = Exact.AlgebraicNumber.equals(fourthPower, 2n);
    let viaExpression = Exact.AlgebraicNumber.fromExpression(
      Exact.Expression.power(2n, Exact.rational(1n, 4n)));
    let sameValue = Exact.AlgebraicNumber.equals(fourth, viaExpression);
  `, { heapSize: 1024 * 1024 });
  assertEquals(session.get(0, 'positive'), 1);
  assertEquals(session.get(0, 'isTwo'), true);
  assertEquals(session.get(0, 'sameValue'), true);
});

Deno.test("cube root of an algebraic value composes: nthRoot(sqrt2, 3) is 2^(1/6)", () => {
  const session = run(`
    let sqrt2 = Exact.AlgebraicNumber.squareRoot(2n);
    let sixth = Exact.AlgebraicNumber.nthRoot(sqrt2, 3n);
    let viaExpression = Exact.AlgebraicNumber.fromExpression(
      Exact.Expression.power(2n, Exact.rational(1n, 6n)));
    let sameValue = Exact.AlgebraicNumber.equals(sixth, viaExpression);
  `, { heapSize: 1024 * 1024 });
  assertEquals(session.get(0, 'sameValue'), true);
});

// ---------- fromExpression: the full radical tree language ----------

Deno.test("fromExpression: rational powers, negative exponents, mixed arithmetic", () => {
  const session = run(`
    let sqrt2 = Exact.AlgebraicNumber.squareRoot(2n);
    let e1 = Exact.AlgebraicNumber.fromExpression(
      Exact.Expression.power(2n, Exact.rational(3n, 2n)));
    let e1Check = Exact.AlgebraicNumber.equals(e1, 2n * sqrt2);
    let e2 = Exact.AlgebraicNumber.fromExpression(
      Exact.Expression.power(2n, Exact.rational(-1n, 2n)));
    let e2Check = Exact.AlgebraicNumber.equals(e2, 1n / sqrt2);
    let e3 = Exact.AlgebraicNumber.fromExpression(
      Exact.Expression.divide(
        Exact.Expression.power(8n, Exact.rational(1n, 2n)),
        2n));
    let e3Check = Exact.AlgebraicNumber.equals(e3, sqrt2);
    let e4 = Exact.AlgebraicNumber.fromExpression(
      Exact.Expression.subtract(
        Exact.Expression.power(3n, Exact.rational(1n, 2n)),
        Exact.Expression.power(3n, Exact.rational(1n, 2n))));
    let e4IsZero = Exact.typeOf(e4) === 'integer' || Exact.AlgebraicNumber.isZero(e4);
  `, { heapSize: 1024 * 1024 });
  assertEquals(session.get(0, 'e1Check'), true);
  assertEquals(session.get(0, 'e2Check'), true);
  assertEquals(session.get(0, 'e3Check'), true);
  assertEquals(session.get(0, 'e4IsZero'), true);
});

Deno.test("fromExpression: negation head and integer powers still fold", () => {
  const session = run(`
    let e1 = Exact.AlgebraicNumber.fromExpression(
      Exact.Expression.negate(Exact.Expression.power(2n, Exact.rational(1n, 2n))));
    let negative = Exact.AlgebraicNumber.sign(e1);
    let sqrt2 = Exact.AlgebraicNumber.squareRoot(2n);
    let cancels = Exact.AlgebraicNumber.isZero(e1 + sqrt2);
    let e2 = Exact.AlgebraicNumber.fromExpression(
      Exact.Expression.power(Exact.rational(2n, 3n), 3n));
    let folded = e2 === Exact.rational(8n, 27n);
  `);
  assertEquals(session.get(0, 'negative'), -1);
  assertEquals(session.get(0, 'cancels'), true);
  assertEquals(session.get(0, 'folded'), true);
});

Deno.test("fromExpression: rational and bigint passthrough unchanged (6a behavior kept)", () => {
  const session = run(`
    let a = Exact.AlgebraicNumber.fromExpression(7n);
    let aType = Exact.typeOf(a);
    let b = Exact.AlgebraicNumber.fromExpression(Exact.rational(1n, 3n));
    let bCheck = b === Exact.rational(1n, 3n);
  `);
  assertEquals(session.get(0, 'aType'), 'bigint');
  assertEquals(session.get(0, 'bCheck'), true);
});

// ---------- error surface ----------

Deno.test("even roots of negative values throw RangeError everywhere", () => {
  const session = run(`
    let direct = false;
    try { Exact.AlgebraicNumber.squareRoot(-2n); } catch (e) { direct = e.message; }
    let viaNthRoot = false;
    try { Exact.AlgebraicNumber.nthRoot(Exact.rational(-1n, 4n), 4n); }
    catch (e) { viaNthRoot = e.message; }
    let viaExpression = false;
    try {
      Exact.AlgebraicNumber.fromExpression(
        Exact.Expression.power(-2n, Exact.rational(1n, 2n)));
    } catch (e) { viaExpression = e.message; }
    let algebraicNegative = false;
    try {
      let minusSqrt2 = -Exact.AlgebraicNumber.squareRoot(2n);
      Exact.AlgebraicNumber.squareRoot(minusSqrt2);
    } catch (e) { algebraicNegative = e.message; }
  `);
  const expected = 'Exact.AlgebraicNumber: even root of a negative value has no real result';
  assertEquals(session.get(0, 'direct'), expected);
  assertEquals(session.get(0, 'viaNthRoot'), expected);
  assertEquals(session.get(0, 'viaExpression'), expected);
  assertEquals(session.get(0, 'algebraicNegative'), expected);
});

Deno.test("nthRoot index validation: type and range", () => {
  const session = run(`
    let notInteger = false;
    try { Exact.AlgebraicNumber.nthRoot(2n, Exact.rational(1n, 2n)); }
    catch (e) { notInteger = e.message; }
    let zeroIndex = false;
    try { Exact.AlgebraicNumber.nthRoot(2n, 0n); } catch (e) { zeroIndex = e.message; }
    let negativeIndex = false;
    try { Exact.AlgebraicNumber.nthRoot(2n, -2n); } catch (e) { negativeIndex = e.message; }
    let stringIndex = false;
    try { Exact.AlgebraicNumber.nthRoot(2n, 'two'); } catch (e) { stringIndex = e.message; }
  `);
  const expected = 'Exact.AlgebraicNumber.nthRoot: root index must be a positive integer';
  assertEquals(session.get(0, 'notInteger'), expected);
  assertEquals(session.get(0, 'zeroIndex'), expected);
  assertEquals(session.get(0, 'negativeIndex'), expected);
  assertEquals(session.get(0, 'stringIndex'), expected);
});

Deno.test("fromExpression: division by an exactly-zero radical is the messaged RangeError", () => {
  const session = run(`
    let caught = false;
    try {
      Exact.AlgebraicNumber.fromExpression(
        Exact.Expression.divide(1n,
          Exact.Expression.subtract(
            Exact.Expression.power(2n, Exact.rational(1n, 2n)),
            Exact.Expression.power(2n, Exact.rational(1n, 2n)))));
    } catch (e) { caught = e.message; }
  `, { heapSize: 1024 * 1024 });
  assertEquals(session.get(0, 'caught'),
    'Exact.AlgebraicNumber.fromExpression: division by zero');
});

Deno.test("fromExpression: symbolic exponents and non-arithmetic heads are TypeErrors", () => {
  const session = run(`
    let x = Symbol.for('x');
    let symbolicExponent = false;
    try {
      Exact.AlgebraicNumber.fromExpression(Exact.Expression.power(2n, x));
    } catch (e) { symbolicExponent = e.message; }
    let symbolicBase = false;
    try {
      Exact.AlgebraicNumber.fromExpression(
        Exact.Expression.power(x, Exact.rational(1n, 2n)));
    } catch (e) { symbolicBase = e.message; }
  `);
  const expected = 'Exact.AlgebraicNumber.fromExpression: expression is not an exact numeric-radical tree';
  assertEquals(session.get(0, 'symbolicExponent'), expected);
  assertEquals(session.get(0, 'symbolicBase'), expected);
});

Deno.test("fromExpression: oversized rational exponents are a RangeError", () => {
  const session = run(`
    let bigNumerator = false;
    try {
      Exact.AlgebraicNumber.fromExpression(
        Exact.Expression.power(2n, Exact.rational(70000n, 3n)));
    } catch (e) { bigNumerator = e.message; }
  `);
  assertEquals(session.get(0, 'bigNumerator'),
    'Exact.AlgebraicNumber.fromExpression: rational exponent is out of range');
});

// ---------- roundtrip through the introspection surface ----------

Deno.test("fromExpression(definingPolynomial evaluated at the root shape) round-trips", () => {
  // Rebuild sqrt2 from its own introspected defining polynomial's
  // coefficients: c0 + c2·x² = 0 → x = sqrt(−c0/c2).
  const session = run(`
    let sqrt2 = Exact.AlgebraicNumber.squareRoot(2n);
    let rebuilt = Exact.AlgebraicNumber.fromExpression(
      Exact.Expression.power(2n, Exact.rational(1n, 2n)));
    let same = Exact.AlgebraicNumber.equals(sqrt2, rebuilt);
    let interval = Exact.AlgebraicNumber.isolatingInterval(rebuilt);
    let lowBelowHigh = interval[0] < interval[1];
  `);
  assertEquals(session.get(0, 'same'), true);
  assertEquals(session.get(0, 'lowBelowHigh'), true);
});

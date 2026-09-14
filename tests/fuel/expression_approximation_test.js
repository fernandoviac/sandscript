import { assert, assertEquals, assertThrows } from "https://deno.land/std@0.208.0/assert/mod.ts";
import { freshSession } from '../../src/host-owned-session.js';
import { parseAndSetup } from './test-helpers.js';

function run(source) {
  const session = freshSession();
  parseAndSetup(session, source);
  const result = session.run(0, 1000000000);
  assertEquals(result.status, 'done');
  return session;
}

// Independently generated fixed-point references (pure-integer Taylor /
// atanh series and Machin's formula, scale 10^50, truncation within a few
// units of the last place). NOT produced by the implementation under test.
const REFERENCE_SCALE = 10n ** 50n;
// Truncation slack: 10^-40 absolutely dominates the reference error and is
// far below every tested enclosure width.
const REFERENCE_SLACK = 10n ** 10n;
const REFERENCES = {
  e: 271828182845904523536028747135266249775724709369978n,
  inverseE: 36787944117144232159552377016146086744581113103161n,
  expLargeRational: 22866195205680982959041592507119616788507537103678137703n,
  ln2: 69314718055994530941723212145817656807550013435972n,
  ln3: 109861228866810969139524523692252570464749055782192n,
  sin1: 84147098480789650665250232163029899962256306079826n,
  cos1: 54030230586813971740093660744297660373231042061781n,
  sinThird: 32719469679615224417334408526762060606430140689368n,
  sin1000: 82687954053200256025588742910921814121272496784874n,
  tan1: 155740772465490223050697480745836017308725077238163n,
  tan157: 125576559150069160466054300777387340939909076098259219n,
  pi: 314159265358979323846264338327950288419716939937510n,
  sqrt2: 141421356237309504880168872420969807856967187537694n,
};

function toFraction(value) {
  return [BigInt(value.numerator), BigInt(value.denominator)];
}

// a/b <= c/d with positive denominators.
function fractionLessOrEqual(a, b, c, d) {
  return a * d <= c * b;
}

// The enclosure must contain the reference value (with truncation slack)
// AND obey the requested width — checked separately, per the plan.
function assertEnclosure(interval, reference, widthExponent) {
  const [lowNumerator, lowDenominator] = toFraction(interval[0]);
  const [highNumerator, highDenominator] = toFraction(interval[1]);
  const referenceLow = reference - REFERENCE_SLACK;
  const referenceHigh = reference + REFERENCE_SLACK;
  assert(
    fractionLessOrEqual(lowNumerator, lowDenominator, referenceLow, REFERENCE_SCALE),
    `containment: low endpoint above the reference`);
  assert(
    fractionLessOrEqual(referenceHigh, REFERENCE_SCALE, highNumerator, highDenominator),
    `containment: high endpoint below the reference`);
  // width = high - low <= 2^widthExponent
  const widthNumerator = highNumerator * lowDenominator - lowNumerator * highDenominator;
  const widthDenominator = highDenominator * lowDenominator;
  const shift = -widthExponent;
  assert(shift > 0n, 'test fixtures use negative width exponents');
  assert(widthNumerator * (2n ** shift) <= widthDenominator,
    `width: wider than 2^${widthExponent}`);
}

function approximate(expressionSource, widthExponent) {
  const session = run(`
    let E = Exact.Expression;
    let interval = E.toApproximation(${expressionSource}, ${widthExponent}n);
  `);
  return session.getExact(0, 'interval');
}

Deno.test("Exp enclosures: 1, -1, and a reduced large rational argument", () => {
  assertEnclosure(approximate('E.exp(1n)', -80n), REFERENCES.e, -80n);
  assertEnclosure(approximate('E.exp(-1n)', -80n), REFERENCES.inverseE, -80n);
  assertEnclosure(
    approximate('E.exp(Exact.rational(1234n, 100n))', -80n),
    REFERENCES.expLargeRational * (10n ** 50n) / REFERENCE_SCALE, -80n);
});

Deno.test("Exp(0) still simplifies exactly before the interval evaluator", () => {
  const interval = approximate('E.exp(0n)', -20n);
  assertEquals(toFraction(interval[0]), [1n, 1n]);
  assertEquals(toFraction(interval[1]), [1n, 1n]);
});

Deno.test("Log enclosures: Log(1), Log(2), Log(3), and a positive algebraic argument", () => {
  const logOne = approximate('E.log(1n)', -20n);
  assertEquals(toFraction(logOne[0]), [0n, 1n]);
  assertEquals(toFraction(logOne[1]), [0n, 1n]);
  assertEnclosure(approximate('E.log(2n)', -80n), REFERENCES.ln2, -80n);
  assertEnclosure(approximate('E.log(3n)', -80n), REFERENCES.ln3, -80n);
  // ln(sqrt(2)) = ln2 / 2.
  assertEnclosure(
    approximate('E.log(Exact.AlgebraicNumber.nthRoot(2n, 2n))', -60n),
    REFERENCES.ln2 / 2n, -60n);
});

Deno.test("Sine and cosine at zero, general rational points, and a large argument", () => {
  const sineZero = approximate('E.sin(0n)', -20n);
  assertEquals(toFraction(sineZero[0]), [0n, 1n]);
  assertEquals(toFraction(sineZero[1]), [0n, 1n]);
  assertEnclosure(approximate('E.sin(1n)', -80n), REFERENCES.sin1, -80n);
  assertEnclosure(approximate('E.cos(1n)', -80n), REFERENCES.cos1, -80n);
  assertEnclosure(approximate('E.sin(Exact.rational(1n, 3n))', -60n), REFERENCES.sinThird, -60n);
  assertEnclosure(approximate('E.sin(1000n)', -60n), REFERENCES.sin1000, -60n);
});

Deno.test("Sine at a rational multiple of Pi simplifies to the exact special point", () => {
  const interval = approximate(
    'E.sin(E.multiply(Exact.Pi, Exact.rational(1n, 6n)))', -30n);
  assertEquals(toFraction(interval[0]), [1n, 2n]);
  assertEquals(toFraction(interval[1]), [1n, 2n]);
});

Deno.test("Tangent away from and near a pole", () => {
  assertEnclosure(approximate('E.tan(1n)', -80n), REFERENCES.tan1, -80n);
  assertEnclosure(
    approximate('E.tan(Exact.rational(157n, 100n))', -60n),
    REFERENCES.tan157 * (10n ** 50n) / REFERENCE_SCALE, -60n);
});

Deno.test("Pi gets its own certified enclosure", () => {
  assertEnclosure(approximate('Exact.Pi', -80n), REFERENCES.pi, -80n);
});

Deno.test("Nested arithmetic over transcendental values", () => {
  // e + 2 ln 2.
  assertEnclosure(
    approximate('E.add(E.exp(1n), E.multiply(2n, E.log(2n)))', -80n),
    REFERENCES.e + 2n * REFERENCES.ln2, -80n);
});

Deno.test("A rational exponent evaluates through the positive-base power path", () => {
  assertEnclosure(
    approximate('E.power(2n, Exact.rational(1n, 2n))', -60n),
    REFERENCES.sqrt2, -60n);
});

Deno.test("Independent requests at coarse and fine widths", () => {
  assertEnclosure(approximate('E.exp(1n)', -4n), REFERENCES.e, -4n);
  assertEnclosure(approximate('E.exp(1n)', -120n), REFERENCES.e, -120n);
  assertEnclosure(approximate('E.log(2n)', -8n), REFERENCES.ln2, -8n);
});

Deno.test("Rejections: free symbol, branch crossings, poles, zero divisors, non-real values", () => {
  const session = run(`
    let E = Exact.Expression;
    function fails(f) {
      try { f(); return false; } catch (e) { return true; }
    }
    let freeSymbol = fails(() => E.toApproximation(E.exp(Symbol.for('x')), -20n));
    let logNegative = fails(() => E.toApproximation(E.log(-2n), -20n));
    let logZero = fails(() => E.toApproximation(E.log(0n), -20n));
    let zeroDivisor = fails(() =>
      E.toApproximation(E.divide(1n, E.subtract(E.exp(1n), E.exp(1n))), -20n));
    let tangentPole = fails(() =>
      E.toApproximation(E.tan(E.multiply(Exact.Pi, Exact.rational(1n, 2n))), -20n));
    let nonReal = fails(() => E.toApproximation(E.exp(Exact.i), -20n));
    let negativeBasePower = fails(() =>
      E.toApproximation(E.power(-2n, Exact.rational(1n, 2n)), -20n));
    let widthValidation = fails(() => E.toApproximation(E.exp(1n), Exact.rational(1n, 2n)));
  `);
  for (const name of ['freeSymbol', 'logNegative', 'logZero', 'zeroDivisor',
    'tangentPole', 'nonReal', 'negativeBasePower', 'widthValidation']) {
    assertEquals(session.get(0, name), true, name);
  }
});

Deno.test("A hand-built near-match of the trigonometric tree is rejected", () => {
  // Same shape as the sine tree but with Complex(0, 2) inside the
  // exponential arguments: not the canonical constructor structure.
  const session = run(`
    let E = Exact.Expression;
    let twoI = Exact.complex(0n, 2n);
    let m = E.multiply(twoI, 1n);
    let nearMatch = E.divide(
      E.subtract(E.exp(m), E.exp(E.negate(m))),
      Exact.complex(0n, 2n));
    let rejected = false;
    try { E.toApproximation(nearMatch, -20n); } catch (e) { rejected = true; }
  `);
  assertEquals(session.get(0, 'rejected'), true);
});

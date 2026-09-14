/**
 * Ring 6 (6d) — rational-turn trigonometry (cosineOfTurns /
 * sineOfTurns via Chebyshev T_q − 1 with exact index selection, Niven
 * denominators returning pure Rationals) and the cross-type
 * comparison sweep (relational and equality operators over the
 * {AlgebraicNumber, Rational, BigInt} tower).
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
  let A = Exact.AlgebraicNumber;
`;

// ---------- Niven denominators renormalise to Rationals ----------

Deno.test("cosineOfTurns: the rational cosines come back as Rationals", () => {
  const session = run(SETUP + `
    let whole = A.cosineOfTurns(0n) === 1;
    let integerTurns = A.cosineOfTurns(5n) === 1;
    let half = A.cosineOfTurns(Exact.rational(1n, 2n)) === -1;
    let third = A.cosineOfTurns(Exact.rational(1n, 3n)) === Exact.rational(-1n, 2n);
    let quarter = A.cosineOfTurns(Exact.rational(1n, 4n)) === 0;
    let sixth = A.cosineOfTurns(Exact.rational(1n, 6n)) === Exact.rational(1n, 2n);
    let twoSixths = A.cosineOfTurns(Exact.rational(2n, 6n)) === Exact.rational(-1n, 2n);
  `);
  for (const name of ['whole', 'integerTurns', 'half', 'third', 'quarter', 'sixth', 'twoSixths']) {
    assertEquals(session.get(0, name), true, name);
  }
});

// ---------- the algebraic cosines ----------

Deno.test("cosineOfTurns(1/8) equals sqrt2/2 (cross-checked against 6b)", () => {
  const session = run(SETUP + `
    let octagon = A.cosineOfTurns(Exact.rational(1n, 8n));
    let check = A.equals(octagon, A.squareRoot(2n) / 2n);
    let squared = A.isZero(octagon * octagon - Exact.rational(1n, 2n));
  `, { heapSize: 1024 * 1024 });
  assertEquals(session.get(0, 'check'), true);
  assertEquals(session.get(0, 'squared'), true);
});

Deno.test("cosineOfTurns(1/12) equals sqrt3/2", () => {
  const session = run(SETUP + `
    let check = A.equals(
      A.cosineOfTurns(Exact.rational(1n, 12n)),
      A.squareRoot(3n) / 2n);
  `, { heapSize: 1024 * 1024 });
  assertEquals(session.get(0, 'check'), true);
});

Deno.test("pentagon: cosineOfTurns(1/5) equals (sqrt5 - 1)/4 — the golden check", () => {
  const session = run(SETUP + `
    let pentagon = A.cosineOfTurns(Exact.rational(1n, 5n));
    let check = A.equals(pentagon, (A.squareRoot(5n) - 1n) / 4n);
  `, { heapSize: 1024 * 1024 });
  assertEquals(session.get(0, 'check'), true);
});

Deno.test("heptagon: cosineOfTurns(1/7) is exact and self-consistent", () => {
  const session = run(SETUP + `
    let seventh = A.cosineOfTurns(Exact.rational(1n, 7n));
    let selfEqual = A.equals(seventh, A.cosineOfTurns(Exact.rational(1n, 7n)));
    let ordered = A.compare(A.cosineOfTurns(Exact.rational(2n, 7n)), seventh);
    let approx = A.toApproximation(seventh, -40n);
  `, { heapSize: 1024 * 1024 });
  assertEquals(session.get(0, 'selfEqual'), true);
  assertEquals(session.get(0, 'ordered'), -1);
  assert(Math.abs(session.get(0, 'approx') - Math.cos((2 * Math.PI) / 7)) < 1e-10);
});

// ---------- argument reduction ----------

Deno.test("argument reduction: periodicity, evenness, negative and >1-turn arguments", () => {
  const session = run(SETUP + `
    let octagon = A.cosineOfTurns(Exact.rational(1n, 8n));
    let periodic = A.equals(A.cosineOfTurns(Exact.rational(9n, 8n)), octagon);
    let even = A.equals(A.cosineOfTurns(Exact.rational(-1n, 8n)), octagon);
    let deepWrap = A.equals(A.cosineOfTurns(Exact.rational(-15n, 8n)), octagon);
  `, { heapSize: 1024 * 1024 });
  assertEquals(session.get(0, 'periodic'), true);
  assertEquals(session.get(0, 'even'), true);
  assertEquals(session.get(0, 'deepWrap'), true);
});

// ---------- sine ----------

Deno.test("sineOfTurns: reduction to cosine, rational and algebraic values", () => {
  const session = run(SETUP + `
    let zero = A.sineOfTurns(0n) === 0;
    let quarter = A.sineOfTurns(Exact.rational(1n, 4n)) === 1;
    let half = A.sineOfTurns(Exact.rational(1n, 2n)) === 0;
    let threeQuarters = A.sineOfTurns(Exact.rational(3n, 4n)) === -1;
    let twelfth = A.sineOfTurns(Exact.rational(1n, 12n)) === Exact.rational(1n, 2n);
    let sixthValue = A.sineOfTurns(Exact.rational(1n, 6n));
    let sixth = A.equals(sixthValue, A.squareRoot(3n) / 2n);
    let eighth = A.equals(A.sineOfTurns(Exact.rational(1n, 8n)),
      A.cosineOfTurns(Exact.rational(1n, 8n)));
  `, { heapSize: 1024 * 1024 });
  for (const name of ['zero', 'quarter', 'half', 'threeQuarters', 'twelfth', 'sixth', 'eighth']) {
    assertEquals(session.get(0, name), true, name);
  }
  assertEquals(session.getExact(0, 'sixthValue').definingPolynomial, [-3n, 0n, 4n]);
});

// ---------- validation ----------

Deno.test("turns argument validation", () => {
  const session = run(SETUP + `
    let notRational = false;
    try { A.cosineOfTurns('x'); } catch (e) { notRational = e.message; }
    let algebraicRefused = false;
    try { A.sineOfTurns(A.squareRoot(2n)); } catch (e) { algebraicRefused = true; }
    let hugeDenominator = false;
    try { A.cosineOfTurns(Exact.rational(1n, 1000000000n)); } catch (e) { hugeDenominator = true; }
  `);
  assertEquals(session.get(0, 'notRational'),
    'Exact.AlgebraicNumber.cosineOfTurns: argument must be a Rational number of turns');
  assertEquals(session.get(0, 'algebraicRefused'), true);
  assertEquals(session.get(0, 'hugeDenominator'), true);
});

// ---------- cross-type comparison sweep ----------

Deno.test("relational operators are exact across the tower", () => {
  const session = run(SETUP + `
    let sqrt2 = A.squareRoot(2n);
    let sqrt3 = A.squareRoot(3n);
    let c1 = sqrt2 < Exact.rational(3n, 2n);
    let c2 = Exact.rational(3n, 2n) < sqrt3;
    let c3 = sqrt3 > sqrt2;
    let c4 = sqrt2 <= sqrt2;
    let c5 = sqrt2 >= sqrt2;
    let c6 = sqrt2 >= 2n;
    let c7 = 1n < sqrt2;
    let c8 = sqrt2 > Exact.rational(141n, 100n);
    let c9 = sqrt2 < Exact.rational(142n, 100n);
    let tight = sqrt2 > Exact.rational(14142135n, 10000000n);
  `);
  for (const name of ['c1', 'c2', 'c3', 'c4', 'c5', 'c7', 'c8', 'c9', 'tight']) {
    assertEquals(session.get(0, name), true, name);
  }
  assertEquals(session.get(0, 'c6'), false);
});

Deno.test("equality operators: number-surface value equality, bigint excluded", () => {
  const session = run(SETUP + `
    let sqrt2 = A.squareRoot(2n);
    let freshEqual = sqrt2 === A.squareRoot(2n);
    let notEqual = sqrt2 !== A.squareRoot(3n);
    let squared = sqrt2 * sqrt2;
    let rationalSurface = squared === 2;
    let bigintExcluded = squared === 2n;
    let bigintNotEqual = squared !== 2n;
    let negatedDiffers = sqrt2 !== -sqrt2;
  `);
  assertEquals(session.get(0, 'freshEqual'), true);
  assertEquals(session.get(0, 'notEqual'), true);
  assertEquals(session.get(0, 'rationalSurface'), true);
  assertEquals(session.get(0, 'bigintExcluded'), false);
  assertEquals(session.get(0, 'bigintNotEqual'), true);
  assertEquals(session.get(0, 'negatedDiffers'), true);
});

Deno.test("float mixes refuse in relational position (approximation stays explicit)", () => {
  const session = run(SETUP + `
    let sqrt2 = A.squareRoot(2n);
    let ltRefused = false;
    try { let z = sqrt2 < 1.5; } catch (e) { ltRefused = true; }
    let gteRefused = false;
    try { let z = 1.5 >= sqrt2; } catch (e) { gteRefused = true; }
    let eqIsFalse = sqrt2 === 1.4142135623730951;
  `);
  assertEquals(session.get(0, 'ltRefused'), true);
  assertEquals(session.get(0, 'gteRefused'), true);
  assertEquals(session.get(0, 'eqIsFalse'), false);
});

Deno.test("comparisons drive control flow: sorting algebraic values works", () => {
  const session = run(SETUP + `
    let values = [A.squareRoot(3n), 1n, A.squareRoot(2n), Exact.rational(3n, 2n)];
    let sorted = [];
    while (values.length > 0) {
      let best = 0;
      for (let i = 1; i < values.length; i = i + 1) {
        if (values[i] < values[best]) { best = i; }
      }
      sorted.push(values[best]);
      values.splice(best, 1);
    }
    let order = A.equals(sorted[0], 1n) && A.equals(sorted[1], A.squareRoot(2n))
      && sorted[2] === Exact.rational(3n, 2n) && A.equals(sorted[3], A.squareRoot(3n));
  `);
  assertEquals(session.get(0, 'order'), true);
});

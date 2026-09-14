/**
 * Tests for the successive-norms elimination loop through
 * algebraic_eliminate_multivariate and algebraic_npoly_transpose_outer.
 * The test_full_norm WASM export runs canonicalize -> degree ->
 * extract-coefficients -> registry -> build_g -> eliminate.
 *
 * The r=1 cases are cross-checked against the separate, unmodified
 * production Exact.AlgebraicNumber.rootsOfPolynomial code path as an
 * independent oracle. The r>=2 cases are checked against hand-derived
 * Sylvester-resultant mathematics.
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

function valuePointerOf(session, name) {
  return session.mem.scopeLookup(session.mem.getContextScope(0), session.mem.internString(name));
}

function toBigInt({ sign, limbs }) {
  let magnitude = 0n;
  for (let i = limbs.length - 1; i >= 0; i--) magnitude = (magnitude << 32n) | BigInt(limbs[i]);
  return sign ? -magnitude : magnitude;
}

function readCoefficients(session, ptr) {
  const deg = session.mem.wasm.exports.test_npoly_degree(ptr);
  const out = [];
  for (let i = 0; i <= deg; i++) {
    out.push(toBigInt(session.mem.readBigInt(session.mem.wasm.exports.test_npoly_coefficient(ptr, i))));
  }
  return out;
}

/** Run the full pipeline; returns { status, coefficients } (ascending x-power, or null coefficients on failure). */
function fullNorm(session, polyName, varName) {
  const statusOut = session.mem.wasm.exports.test_carve_scratch(4);
  const normPtr = session.mem.wasm.exports.test_full_norm(
    valuePointerOf(session, polyName), valuePointerOf(session, varName), statusOut);
  const status = session.mem.view.getInt32(session.mem.abs(statusOut), true);
  return { status, coefficients: normPtr ? readCoefficients(session, normPtr) : null };
}

/** Normalize a coefficient list up to an overall rational scalar (sign + gcd), for comparing against a differently-scaled oracle. */
function normalizeUpToScalar(coeffs) {
  let gcd = 0n;
  for (const c of coeffs) {
    let v = c < 0n ? -c : c;
    while (v) { [gcd, v] = [v, gcd % v]; }
  }
  if (gcd === 0n) return coeffs;
  let normalized = coeffs.map(c => c / gcd);
  const lastNonzero = [...normalized].reverse().find(c => c !== 0n);
  if (lastNonzero < 0n) normalized = normalized.map(c => -c);
  return normalized;
}

const SETUP = `
  let x = Symbol.for('x');
  let A = Exact.AlgebraicNumber;
  let E = Exact.Expression;
`;

Deno.test("eliminate_multivariate r=1: sqrt2*x^2 - 3 matches production rootsOfPolynomial", () => {
  const session = run(SETUP + `
    let sqrt2 = A.squareRoot(2n);
    let poly = E.subtract(E.multiply(sqrt2, E.power(x, 2n)), 3n);
    let roots = A.rootsOfPolynomial(poly, x);
  `);
  const { status, coefficients } = fullNorm(session, "poly", "x");
  assertEquals(status, 0);
  const production = session.get(0, 'roots')[0].definingPolynomial;
  assertEquals(normalizeUpToScalar(coefficients), normalizeUpToScalar(production));
});

Deno.test("eliminate_multivariate r=1: sqrt3*x - 5 matches production rootsOfPolynomial", () => {
  const session = run(SETUP + `
    let sqrt3 = A.squareRoot(3n);
    let poly = E.subtract(E.multiply(sqrt3, x), 5n);
    let roots = A.rootsOfPolynomial(poly, x);
  `);
  const { status, coefficients } = fullNorm(session, "poly", "x");
  assertEquals(status, 0);
  const production = session.get(0, 'roots')[0].definingPolynomial;
  assertEquals(normalizeUpToScalar(coefficients), normalizeUpToScalar(production));
});

Deno.test("eliminate_multivariate r=2: sqrt2*x^2 - sqrt3 -> (2x^4-3)^2 by hand-verified Sylvester resultant", () => {
  const session = run(SETUP + `
    let sqrt2 = A.squareRoot(2n);
    let sqrt3 = A.squareRoot(3n);
    let poly = E.subtract(E.multiply(sqrt2, E.power(x, 2n)), sqrt3);
  `);
  const { status, coefficients } = fullNorm(session, "poly", "x");
  assertEquals(status, 0);
  // (2x^4-3)^2 = 4x^8 - 12x^4 + 9 -- the RAW (pre-squarefree) elimination
  // result really is a perfect square here (both roots ±sqrt3 of t^2-3
  // give x the SAME minimal polynomial), which is expected and correct:
  // algebraic_eliminate_multivariate deliberately never squarefree-
  // normalizes intermediate/final results (section 3.2's ruling; that
  // stays the CALLER's job, applied once via the existing
  // algebraic_poly_normalize_squarefree, not yet wired up here).
  assertEquals(normalizeUpToScalar(coefficients), [9n, 0n, 0n, 0n, -12n, 0n, 0n, 0n, 4n]);
});

Deno.test("eliminate_multivariate r=3: sqrt2*x^2 + sqrt3*x + sqrt5 has the expected degree-16 bound and a numerically verified root", () => {
  const session = run(SETUP + `
    let sqrt2 = A.squareRoot(2n);
    let sqrt3 = A.squareRoot(3n);
    let sqrt5 = A.squareRoot(5n);
    let poly = E.add(
      E.add(E.multiply(sqrt2, E.power(x, 2n)), E.multiply(sqrt3, x)), sqrt5);
  `, { heapSize: 32 * 1024 * 1024 });
  const { status, coefficients } = fullNorm(session, "poly", "x");
  assertEquals(status, 0);
  assertEquals(coefficients.length, 17); // degree 16 = Option A's own deg(F) * prod(deg p_i) bound: 2*2*2*2
  // Numerically verify a root of sqrt2*x^2+sqrt3*x+sqrt5=0 (complex,
  // since the discriminant sqrt3^2-4*sqrt2*sqrt5 < 0) satisfies the norm.
  const a = Math.sqrt(2), b = Math.sqrt(3), c = Math.sqrt(5);
  const disc = b * b - 4 * a * c;
  const re = -b / (2 * a);
  const im = Math.sqrt(-disc) / (2 * a);
  let sumRe = 0, sumIm = 0, curRe = 1, curIm = 0;
  for (let i = 0; i < coefficients.length; i++) {
    const coeff = Number(coefficients[i]);
    sumRe += coeff * curRe;
    sumIm += coeff * curIm;
    const nextRe = curRe * re - curIm * im;
    const nextIm = curRe * im + curIm * re;
    curRe = nextRe; curIm = nextIm;
  }
  assertEquals(Math.abs(sumRe) < 1e-6, true);
  assertEquals(Math.abs(sumIm) < 1e-6, true);
});

Deno.test("eliminate_multivariate: minimal roots exclude unrelated rational sibling factors", () => {
  const session = run(SETUP + `
    let t = Symbol.for('t');
    let roots = A.rootsOfPolynomial(
      E.multiply(E.subtract(E.power(t, 2n), 2n), E.subtract(t, 3n)), t);
    let alpha = roots[1];
    let sqrt2 = A.squareRoot(2n);
    let alphaIsSqrt2 = A.equals(alpha, sqrt2);
    let poly = E.multiply(E.subtract(alpha, 3n), E.add(E.power(x, 2n), 1n));
  `);
  assertEquals(session.get(0, 'alphaIsSqrt2'), true);
  const { status, coefficients } = fullNorm(session, "poly", "x");
  assertEquals(status, 0);
  assertEquals(normalizeUpToScalar(coefficients), [1n, 0n, 2n, 0n, 1n]);
});

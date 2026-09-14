/**
 * Tests for gamma construction and the rewrite step in
 * algebraic_build_primitive_element through a WASM test export.
 * The r=2 case is cross-checked directly against SymPy's own worked
 * example (sympy.primitive_element([sqrt(2), sqrt(3)], x, ex=True)):
 * gamma = sqrt2 + sqrt3, defining polynomial x^4 - 10x^2 + 1, reps
 * [1/2, 0, -9/2, 0] for sqrt2 and [-1/2, 0, 11/2, 0] for sqrt3 (SymPy's
 * own convention: coefficients of FALLING powers of gamma, i.e.
 * descending degree order -- this test converts to this project's own
 * ascending-degree apoly convention before comparing).
 *
 * The public-surface cases below preserve the same mathematical oracle.
 */
import { assertEquals } from "https://deno.land/std@0.208.0/assert/mod.ts";
import { freshSession } from '../../src/host-owned-session.js';

function session() {
  return freshSession({ heapSize: 16 * 1024 * 1024 });
}

function run(s, source) {
  const result = s.parse(source);
  s.mem.setContextInstructionIndex(0, result.startIndex);
  s.mem.clearExitCondition(0);
  for (;;) {
    const out = s.run(0, 50_000_000);
    if (out.status === 'complete' || out.status === 'done') return;
    if (out.status === 'paused') { s.mem.clearExitCondition(0); continue; }
    if (out.status === 'memory_pressure') { s.gc(); continue; }
    throw new Error(`unexpected status ${out.status}`);
  }
}

function valuePointerOf(s, name) {
  return s.mem.scopeLookup(s.mem.getContextScope(0), s.mem.internString(name));
}

function headerOf(s, name) {
  return s.mem.view.getUint32(s.mem.abs(valuePointerOf(s, name)) + 8, true);
}

function toBigInt({ sign, limbs }) {
  let magnitude = 0n;
  for (let i = limbs.length - 1; i >= 0; i--) magnitude = (magnitude << 32n) | BigInt(limbs[i]);
  return sign ? -magnitude : magnitude;
}

function readApoly(s, ptr) {
  const deg = s.mem.wasm.exports.test_apoly_degree(ptr);
  const out = [];
  for (let i = 0; i <= deg; i++) {
    const rational = s.mem.wasm.exports.test_apoly_coefficient(ptr, i);
    const num = toBigInt(s.mem.readBigInt(s.mem.wasm.exports.test_rational_numerator(rational)));
    const den = toBigInt(s.mem.readBigInt(s.mem.wasm.exports.test_rational_denominator(rational)));
    out.push(`${num}/${den}`);
  }
  return out;
}

function readCoefficients(s, ptr) {
  const deg = s.mem.wasm.exports.test_npoly_degree(ptr);
  const out = [];
  for (let i = 0; i <= deg; i++) out.push(toBigInt(s.mem.readBigInt(s.mem.wasm.exports.test_npoly_coefficient(ptr, i))));
  return out;
}

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

/** SymPy's reps are falling-power (descending); this project's apoly is ascending. Reverse + as fractions. */
function toAscendingFractions(fallingPowerRationals) {
  return [...fallingPowerRationals].reverse();
}

Deno.test("build_primitive_element r=2: gamma=sqrt2+sqrt3 matches SymPy exactly (defining poly and both reps)", () => {
  const s = session();
  run(s, `
    let A = Exact.AlgebraicNumber;
    let sqrt2 = A.squareRoot(2n);
    let sqrt3 = A.squareRoot(3n);
  `);
  const registry = s.mem.wasm.exports.test_carve_scratch(2 * 4);
  s.mem.view.setUint32(s.mem.abs(registry) + 0, headerOf(s, "sqrt2"), true);
  s.mem.view.setUint32(s.mem.abs(registry) + 4, headerOf(s, "sqrt3"), true);
  const repsOut = s.mem.wasm.exports.test_carve_scratch(2 * 4);

  const gammaHeader = s.mem.wasm.exports.test_build_primitive_element(registry, 2, repsOut);
  assertEquals(gammaHeader === 0 || gammaHeader === -2, false, "expected success, got pressure/shift-limit sentinel");

  const gammaCoefficientsArray = s.mem.view.getUint32(s.mem.abs(gammaHeader) + 8, true);
  // Read gamma's defining polynomial directly via algebraic_coefficients_of's
  // own array-of-VALUE layout (bigint headers in a plain JS array read).
  const lengthOffset = s.mem.abs(gammaCoefficientsArray) + 8;
  const length = s.mem.view.getUint32(lengthOffset, true);
  const dataOffset = s.mem.view.getUint32(s.mem.abs(gammaCoefficientsArray) + 16, true);
  const coeffs = [];
  for (let i = 0; i < length; i++) {
    const entryAddr = s.mem.abs(dataOffset) + 8 /* GC header */ + i * 16 /* VALUE_SIZE */;
    const dataLo = s.mem.view.getUint32(entryAddr + 8, true);
    coeffs.push(toBigInt(s.mem.readBigInt(dataLo)));
  }
  assertEquals(normalizeUpToScalar(coeffs), [1n, 0n, -10n, 0n, 1n]);

  const rep0 = s.mem.view.getUint32(s.mem.abs(repsOut) + 0, true);
  const rep1 = s.mem.view.getUint32(s.mem.abs(repsOut) + 4, true);
  assertEquals(readApoly(s, rep0), toAscendingFractions(["1/2", "0/1", "-9/2", "0/1"]));
  assertEquals(readApoly(s, rep1), toAscendingFractions(["-1/2", "0/1", "11/2", "0/1"]));
});

Deno.test("build_primitive_element r=3: gamma=sqrt2+sqrt3+sqrt5 matches SymPy exactly (defining poly and all three reps)", () => {
  const s = session();
  run(s, `
    let A = Exact.AlgebraicNumber;
    let sqrt2 = A.squareRoot(2n);
    let sqrt3 = A.squareRoot(3n);
    let sqrt5 = A.squareRoot(5n);
  `);
  const registry = s.mem.wasm.exports.test_carve_scratch(3 * 4);
  s.mem.view.setUint32(s.mem.abs(registry) + 0, headerOf(s, "sqrt2"), true);
  s.mem.view.setUint32(s.mem.abs(registry) + 4, headerOf(s, "sqrt3"), true);
  s.mem.view.setUint32(s.mem.abs(registry) + 8, headerOf(s, "sqrt5"), true);
  const repsOut = s.mem.wasm.exports.test_carve_scratch(3 * 4);

  const gammaHeader = s.mem.wasm.exports.test_build_primitive_element(registry, 3, repsOut);
  assertEquals(gammaHeader === 0 || gammaHeader === -2, false, "expected success, got pressure/shift-limit sentinel");

  const gammaCoefficientsArray = s.mem.view.getUint32(s.mem.abs(gammaHeader) + 8, true);
  const lengthOffset = s.mem.abs(gammaCoefficientsArray) + 8;
  const length = s.mem.view.getUint32(lengthOffset, true);
  const dataOffset = s.mem.view.getUint32(s.mem.abs(gammaCoefficientsArray) + 16, true);
  const coeffs = [];
  for (let i = 0; i < length; i++) {
    const entryAddr = s.mem.abs(dataOffset) + 8 + i * 16;
    const dataLo = s.mem.view.getUint32(entryAddr + 8, true);
    coeffs.push(toBigInt(s.mem.readBigInt(dataLo)));
  }
  // SymPy: primitive_element([sqrt(2), sqrt(3), sqrt(5)], x, ex=True)
  //   -> x^8 - 40x^6 + 352x^4 - 960x^2 + 576, multipliers [1,1,1]
  assertEquals(normalizeUpToScalar(coeffs), [576n, 0n, -960n, 0n, 352n, 0n, -40n, 0n, 1n]);

  const rep0 = s.mem.view.getUint32(s.mem.abs(repsOut) + 0, true);
  const rep1 = s.mem.view.getUint32(s.mem.abs(repsOut) + 4, true);
  const rep2 = s.mem.view.getUint32(s.mem.abs(repsOut) + 8, true);
  assertEquals(readApoly(s, rep0), toAscendingFractions(
    ["1/576", "0/1", "-7/144", "0/1", "-7/72", "0/1", "5/3", "0/1"]));
  assertEquals(readApoly(s, rep1), toAscendingFractions(
    ["-1/96", "0/1", "37/96", "0/1", "-61/24", "0/1", "15/4", "0/1"]));
  assertEquals(readApoly(s, rep2), toAscendingFractions(
    ["5/576", "0/1", "-97/288", "0/1", "95/36", "0/1", "-53/12", "0/1"]));
});

/**
 * $algebraic_apoly_of_coefficient_slot rewrites a coefficient's original
 * expression shape (an Add fanout of classify_term monomials) directly
 * into an apoly in gamma, using the registry's own representations and
 * making no calls to algebraic_compose_binary. The older
 * algebraic_evaluate_node path could enter an unbounded disambiguation
 * loop. Hand- and SymPy-derived values cover sqrt2*sqrt3 (a Multiply
 * term), sqrt2+sqrt3 (an Add of two bare terms, which is gamma itself),
 * and sqrt2^2*sqrt3 (an exponentiated factor).
 */
Deno.test("apoly_of_coefficient_slot: rewrites sqrt2*sqrt3, sqrt2+sqrt3, sqrt2^2*sqrt3 as apolys in gamma=sqrt2+sqrt3", () => {
  const s = session();
  run(s, `
    let A = Exact.AlgebraicNumber;
    let E = Exact.Expression;
    let sqrt2 = A.squareRoot(2n);
    let sqrt3 = A.squareRoot(3n);
    let term1 = E.multiply(sqrt2, sqrt3);
    let term2 = E.add(sqrt2, sqrt3);
    let term3 = E.multiply(E.power(sqrt2, 2n), sqrt3);
  `);
  const registry = s.mem.wasm.exports.test_carve_scratch(2 * 4);
  s.mem.view.setUint32(s.mem.abs(registry) + 0, headerOf(s, "sqrt2"), true);
  s.mem.view.setUint32(s.mem.abs(registry) + 4, headerOf(s, "sqrt3"), true);
  const repsOut = s.mem.wasm.exports.test_carve_scratch(2 * 4);
  const gammaHeader = s.mem.wasm.exports.test_build_primitive_element(registry, 2, repsOut);
  assertEquals(gammaHeader === 0 || gammaHeader === -2, false);

  const gammaCoefficientsArray = s.mem.view.getUint32(s.mem.abs(gammaHeader) + 8, true);
  const length = s.mem.view.getUint32(s.mem.abs(gammaCoefficientsArray) + 8, true);
  const dataOffset = s.mem.view.getUint32(s.mem.abs(gammaCoefficientsArray) + 16, true);
  const gammaCoeffs = [];
  for (let i = 0; i < length; i++) {
    const entryAddr = s.mem.abs(dataOffset) + 8 + i * 16;
    const dataLo = s.mem.view.getUint32(entryAddr + 8, true);
    gammaCoeffs.push(toBigInt(s.mem.readBigInt(dataLo)));
  }
  const p_gamma_bigint = s.mem.wasm.exports.test_npoly_carve(gammaCoeffs.length - 1);
  gammaCoeffs.forEach((c, i) => s.mem.wasm.exports.test_npoly_set_coefficient(p_gamma_bigint, i, s.mem.marshalBigInt(c)));
  const p_gamma_apoly = s.mem.wasm.exports.test_apoly_from_bigint_poly(p_gamma_bigint);

  function valuePointerOf2(name) { return s.mem.scopeLookup(s.mem.getContextScope(0), s.mem.internString(name)); }

  const term1Apoly = s.mem.wasm.exports.test_apoly_of_coefficient_slot(
    valuePointerOf2("term1"), registry, 2, repsOut, p_gamma_apoly);
  const term2Apoly = s.mem.wasm.exports.test_apoly_of_coefficient_slot(
    valuePointerOf2("term2"), registry, 2, repsOut, p_gamma_apoly);
  const term3Apoly = s.mem.wasm.exports.test_apoly_of_coefficient_slot(
    valuePointerOf2("term3"), registry, 2, repsOut, p_gamma_apoly);

  // sqrt2*sqrt3 = sqrt6 = -5/2 + (1/2)*gamma^2 (hand-derived, verified
  // numerically against SymPy: both evaluate to 2.449489742783178...).
  assertEquals(readApoly(s, term1Apoly), ["-5/2", "0/1", "1/2"]);
  // sqrt2+sqrt3 = gamma itself.
  assertEquals(readApoly(s, term2Apoly), ["0/1", "1/1"]);
  // sqrt2^2*sqrt3 = 2*sqrt3 = 2*rep1.
  assertEquals(readApoly(s, term3Apoly), ["0/1", "11/1", "0/1", "-1/1"]);
});

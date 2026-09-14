/**
 * Tests for G construction through algebraic_build_g,
 * algebraic_carve_zero_tree, and algebraic_g_descend_slot.
 *
 * G is a level-1 polynomial in x whose degree+1 coefficients are each
 * a level-r polynomial (r = distinct algebraic values, nested t_r
 * outermost down to t_1 innermost per the registry's order: registry
 * index i maps to nesting position registry_count-1-i). Direct descent
 * through test_g_descend_slot pins the actual nesting contract rather
 * than merely checking that the expected numbers appear somewhere.
 */
import { assertEquals } from "https://deno.land/std@0.208.0/assert/mod.ts";
import { freshSession } from '../../src/host-owned-session.js';

function session() {
  return freshSession({ heapSize: 8 * 1024 * 1024 });
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

/** Build G for `polyName` in terms of `varName`; returns { degree, registry, registryCount, gOut }. */
function buildG(s, polyName, varName) {
  const registry = s.mem.wasm.exports.test_carve_scratch(16 * 4);
  const maxExponents = s.mem.wasm.exports.test_carve_scratch(16 * 4);
  const gOut = s.mem.wasm.exports.test_carve_scratch(16 * 4);
  const degree = s.mem.wasm.exports.test_build_g(
    valuePointerOf(s, polyName), valuePointerOf(s, varName), registry, maxExponents, gOut);
  return { degree, registry, gOut };
}

/**
 * Read the coefficient of x^xPower * Pi (registry[i]^exponents[i]) out
 * of a built G, via direct descent (not flattened reads) — exponents
 * indexed by REGISTRY position (registry[0]'s exponent first), which
 * this helper converts to the nesting-position order
 * (registry_count-1-i) g_descend_slot expects.
 */
function readGCoefficient(s, built, registryCount, xPower, exponentsByRegistryIndex) {
  const gi = s.mem.view.getUint32(s.mem.abs(built.gOut) + xPower * 4, true);
  if (registryCount === 0) return toBigInt(s.mem.readBigInt(gi));
  const nestingExponents = new Array(registryCount);
  for (let regIndex = 0; regIndex < registryCount; regIndex++) {
    nestingExponents[registryCount - 1 - regIndex] = exponentsByRegistryIndex[regIndex];
  }
  const exponentsScratch = s.mem.wasm.exports.test_carve_scratch(registryCount * 4);
  for (let k = 0; k < registryCount; k++) {
    s.mem.view.setUint32(s.mem.abs(exponentsScratch) + k * 4, nestingExponents[k], true);
  }
  const addr = s.mem.wasm.exports.test_g_descend_slot(gi, registryCount, exponentsScratch);
  return toBigInt(s.mem.readBigInt(s.mem.view.getUint32(addr, true)));
}

function registryIndexOf(s, registry, count, header) {
  return s.mem.wasm.exports.test_registry_index_of(registry, count, header);
}

Deno.test("build_g: pure rational polynomial (r=0)", () => {
  const s = session();
  run(s, `
    let x = Symbol.for("x");
    let poly = Exact.Expression.add(Exact.Expression.power(x, 2n), -2n);
  `);
  const built = buildG(s, "poly", "x");
  assertEquals(built.degree, 2);
  assertEquals(readGCoefficient(s, built, 0, 0, []), -2n);
  assertEquals(readGCoefficient(s, built, 0, 1, []), 0n);
  assertEquals(readGCoefficient(s, built, 0, 2, []), 1n);
});

Deno.test("build_g: r=1, sqrt2*x^2 - 3", () => {
  const s = session();
  run(s, `
    let A = Exact.AlgebraicNumber;
    let E = Exact.Expression;
    let sqrt2 = A.squareRoot(2n);
    let x = Symbol.for("x");
    let poly = E.add(E.multiply(sqrt2, E.power(x, 2n)), -3n);
  `);
  const built = buildG(s, "poly", "x");
  const idx = registryIndexOf(s, built.registry, 1, headerOf(s, "sqrt2"));
  assertEquals(idx, 0);
  // x^0 coefficient is the constant -3 (sqrt2^0 term).
  assertEquals(readGCoefficient(s, built, 1, 0, [0]), -3n);
  assertEquals(readGCoefficient(s, built, 1, 1, [0]), 0n);
  // x^2 coefficient is sqrt2^1.
  assertEquals(readGCoefficient(s, built, 1, 2, [1]), 1n);
});

Deno.test("build_g: r=2, sqrt2*x^2 - sqrt3", () => {
  const s = session();
  run(s, `
    let A = Exact.AlgebraicNumber;
    let E = Exact.Expression;
    let sqrt2 = A.squareRoot(2n);
    let sqrt3 = A.squareRoot(3n);
    let x = Symbol.for("x");
    let poly = E.add(
      E.multiply(sqrt2, E.power(x, 2n)), E.multiply(-1n, sqrt3));
  `);
  const built = buildG(s, "poly", "x");
  const sqrt2Idx = registryIndexOf(s, built.registry, 2, headerOf(s, "sqrt2"));
  const sqrt3Idx = registryIndexOf(s, built.registry, 2, headerOf(s, "sqrt3"));

  const expAt = (want) => {
    const arr = [0, 0];
    for (const [name, idx, exp] of want) arr[idx] = exp;
    return arr;
  };

  // x^2 coefficient: sqrt2^1 * sqrt3^0 -> 1; everything else at x^2 is 0.
  assertEquals(readGCoefficient(s, built, 2, 2, expAt([['sqrt2', sqrt2Idx, 1]])), 1n);
  assertEquals(readGCoefficient(s, built, 2, 2, expAt([['sqrt2', sqrt2Idx, 0]])), 0n);
  // x^0 coefficient: sqrt2^0 * sqrt3^1 -> -1 (the subtracted sqrt3).
  assertEquals(readGCoefficient(s, built, 2, 0, expAt([['sqrt3', sqrt3Idx, 1]])), -1n);
  assertEquals(readGCoefficient(s, built, 2, 0, expAt([['sqrt3', sqrt3Idx, 0]])), 0n);
  // x^1 coefficient is entirely zero.
  assertEquals(readGCoefficient(s, built, 2, 1, [0, 0]), 0n);
});

Deno.test("build_g: r=2, coefficient with BOTH values in one term (product)", () => {
  const s = session();
  run(s, `
    let A = Exact.AlgebraicNumber;
    let E = Exact.Expression;
    let sqrt2 = A.squareRoot(2n);
    let sqrt3 = A.squareRoot(3n);
    let x = Symbol.for("x");
    let poly = E.add(E.make(E.Multiply, [5n, sqrt2, sqrt3]), x);
  `);
  const built = buildG(s, "poly", "x");
  const sqrt2Idx = registryIndexOf(s, built.registry, 2, headerOf(s, "sqrt2"));
  const sqrt3Idx = registryIndexOf(s, built.registry, 2, headerOf(s, "sqrt3"));
  const expAt = (pairs) => {
    const arr = [0, 0];
    for (const [idx, exp] of pairs) arr[idx] = exp;
    return arr;
  };
  assertEquals(
    readGCoefficient(s, built, 2, 0, expAt([[sqrt2Idx, 1], [sqrt3Idx, 1]])),
    5n);
});

Deno.test("build_g: r=1 with a rational scalar (q*alpha), denominators cleared", () => {
  const s = session();
  run(s, `
    let A = Exact.AlgebraicNumber;
    let E = Exact.Expression;
    let sqrt2 = A.squareRoot(2n);
    let x = Symbol.for("x");
    // (1/2)*sqrt2*x - 3/4
    let poly = E.add(
      E.make(E.Multiply, [Exact.rational(1n, 2n), sqrt2, x]),
      Exact.rational(-3n, 4n));
  `);
  const built = buildG(s, "poly", "x");
  // Denominators clear via a global LCM (4 here) -- G's leaves are
  // integers, so the RATIO between coefficients must still match the
  // original (1/2 : -3/4 = -2 : 3, up to the shared clearing factor);
  // just confirm both leaves are nonzero integers with the right sign.
  const x1 = readGCoefficient(s, built, 1, 1, [1]);
  const x0 = readGCoefficient(s, built, 1, 0, [0]);
  assertEquals(x1 > 0n, true);
  assertEquals(x0 < 0n, true);
});

Deno.test("build_g: r=3 completes and places each value at its own nesting level", () => {
  const s = session();
  run(s, `
    let A = Exact.AlgebraicNumber;
    let E = Exact.Expression;
    let sqrt2 = A.squareRoot(2n);
    let sqrt3 = A.squareRoot(3n);
    let sqrt5 = A.squareRoot(5n);
    let x = Symbol.for("x");
    let poly = E.make(E.Add, [
      E.multiply(sqrt2, E.power(x, 2n)),
      E.multiply(sqrt3, x),
      sqrt5
    ]);
  `);
  const built = buildG(s, "poly", "x");
  assertEquals(built.degree, 2);
  const sqrt2Idx = registryIndexOf(s, built.registry, 3, headerOf(s, "sqrt2"));
  const sqrt3Idx = registryIndexOf(s, built.registry, 3, headerOf(s, "sqrt3"));
  const sqrt5Idx = registryIndexOf(s, built.registry, 3, headerOf(s, "sqrt5"));
  const expAt = (pairs) => {
    const arr = [0, 0, 0];
    for (const [idx, exp] of pairs) arr[idx] = exp;
    return arr;
  };
  assertEquals(readGCoefficient(s, built, 3, 2, expAt([[sqrt2Idx, 1]])), 1n);
  assertEquals(readGCoefficient(s, built, 3, 1, expAt([[sqrt3Idx, 1]])), 1n);
  assertEquals(readGCoefficient(s, built, 3, 0, expAt([[sqrt5Idx, 1]])), 1n);
});

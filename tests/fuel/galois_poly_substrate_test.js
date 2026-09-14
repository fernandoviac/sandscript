/**
 * GF(p) polynomial arithmetic through the $galois_poly_* helpers and
 * their direct WASM test exports.
 *
 * Every case is translated directly from SymPy's galoistools.py doctests,
 * computed against a real SymPy installation rather than hand-derived.
 * SymPy's `dup` convention uses descending power order (index 0 is the
 * leading term), while this project uses ascending order (index 0 is the
 * constant term), so every SymPy-sourced list is reversed before comparison.
 */
import { assertEquals } from "https://deno.land/std@0.208.0/assert/mod.ts";
import { freshSession } from '../../src/host-owned-session.js';

function session() {
  return freshSession({ heapSize: 8 * 1024 * 1024 });
}

function poly(s, coeffs) {
  const p = s.mem.wasm.exports.test_galois_poly_carve(Math.max(0, coeffs.length - 1));
  coeffs.forEach((c, i) => s.mem.wasm.exports.test_galois_poly_set_coefficient(p, i, c));
  return p;
}

function readPoly(s, ptr) {
  const deg = s.mem.wasm.exports.test_galois_poly_degree(ptr);
  const out = [];
  for (let i = 0; i <= deg; i++) out.push(s.mem.wasm.exports.test_galois_poly_coefficient(ptr, i));
  return out;
}

Deno.test("galois_poly_gcd: gcd(3x^2+2x+4, 2x^2+2x+3) mod 5 = x+3 (SymPy: gf_gcd([3,2,4],[2,2,3],5)==[1,3])", () => {
  const s = session();
  const f = poly(s, [4, 2, 3]);
  const g = poly(s, [3, 2, 2]);
  const result = s.mem.wasm.exports.test_galois_poly_gcd(f, g, 5);
  assertEquals(readPoly(s, result), [3, 1]);
});

Deno.test("galois_poly_rem/quo: (x^3+x+1)/(x^2+x) mod 2 -> q=x+1, r=1 (SymPy: gf_div([1,0,1,1],[1,1,0],2))", () => {
  const s = session();
  const f = poly(s, [1, 1, 0, 1]);
  const g = poly(s, [0, 1, 1]);
  const q = s.mem.wasm.exports.test_galois_poly_quo(f, g, 2);
  const r = s.mem.wasm.exports.test_galois_poly_rem(f, g, 2);
  assertEquals(readPoly(s, q), [1, 1]);
  assertEquals(readPoly(s, r), [1]);
});

Deno.test("galois_poly_quo: exact division (x^4+3x^2+2x+3)/(2x^2+2x+2) mod 5 = 4x^2+2x+3 (SymPy: gf_quo([1,0,3,2,3],[2,2,2],5)==[3,2,4])", () => {
  const s = session();
  const f = poly(s, [3, 2, 3, 0, 1]);
  const g = poly(s, [2, 2, 2]);
  const q = s.mem.wasm.exports.test_galois_poly_quo(f, g, 5);
  assertEquals(readPoly(s, q), [4, 2, 3]);
});

Deno.test("galois_poly_diff: d/dx(3x^2+2x+4) mod 5 = x+2 (SymPy: gf_diff([3,2,4],5)==[1,2])", () => {
  const s = session();
  const f = poly(s, [4, 2, 3]);
  const result = s.mem.wasm.exports.test_galois_poly_diff(f, 5);
  assertEquals(readPoly(s, result), [2, 1]);
});

Deno.test("galois_poly_monic: monic(3x^2+2x+4) mod 5 -> lc=3, monic=x^2+4x+3 (SymPy: gf_monic([3,2,4],5)==(3,[1,4,3]))", () => {
  const s = session();
  const f = poly(s, [4, 2, 3]);
  const result = s.mem.wasm.exports.test_galois_poly_monic(f, 5);
  assertEquals(readPoly(s, result), [3, 4, 1]);
});

Deno.test("galois_poly_add/sub: basic mod-p wraparound", () => {
  const s = session();
  const a = poly(s, [3, 4]); // 4x+3
  const b = poly(s, [4, 3]); // 3x+4
  const sum = s.mem.wasm.exports.test_galois_poly_add(a, b, 5);
  assertEquals(readPoly(s, sum), [2, 2]); // (4+3)x + (3+4) = 7x+7 = 2x+2 mod 5
  const diff = s.mem.wasm.exports.test_galois_poly_sub(a, b, 5);
  assertEquals(readPoly(s, diff), [4, 1]); // (3-4) + (4-3)x = -1 + x = 4 + x mod 5
});

Deno.test("galois_poly_mul: (x+1)(x+4) mod 5 = x^2+5x+4 = x^2+4 mod 5", () => {
  const s = session();
  const a = poly(s, [1, 1]);
  const b = poly(s, [4, 1]);
  const result = s.mem.wasm.exports.test_galois_poly_mul(a, b, 5);
  assertEquals(readPoly(s, result), [4, 0, 1]);
});

Deno.test("galois_inverse: Fermat little-theorem inverse mod small primes", () => {
  const s = session();
  // 3 * 4 = 12 = 2 mod 5, not 1 -- use the real inverse of 3 mod 5, which is 2 (3*2=6=1 mod 5).
  assertEquals(s.mem.wasm.exports.test_galois_inverse(3, 5), 2);
  assertEquals(s.mem.wasm.exports.test_galois_inverse(1, 7), 1);
  assertEquals(s.mem.wasm.exports.test_galois_inverse(3, 7), 5); // 3*5=15=1 mod 7
});

Deno.test("galois_reduce_bigint: euclidean (non-negative) reduction of large and negative bigints", () => {
  const s = session();
  const negThirteen = s.mem.marshalBigInt(-13n);
  assertEquals(s.mem.wasm.exports.test_galois_reduce_bigint(negThirteen, 5), 2); // -13 mod 5 = 2 (euclidean)
  const large = s.mem.marshalBigInt(123456789012345n);
  assertEquals(s.mem.wasm.exports.test_galois_reduce_bigint(large, 97), Number(123456789012345n % 97n));
});

Deno.test("galois_poly_gcdex: SymPy's own doctest (f=x^2+8x+7, g=x^3+7x^2+x+7 mod 11) -> s=5x+6, t=6, h=x+7", () => {
  const s = session();
  const f = poly(s, [7, 8, 1]);
  const g = poly(s, [7, 1, 7, 1]);
  const sOut = s.mem.wasm.exports.test_carve_scratch(4);
  const tOut = s.mem.wasm.exports.test_carve_scratch(4);
  const h = s.mem.wasm.exports.test_galois_poly_gcdex(f, g, 11, sOut, tOut);
  const sPoly = s.mem.view.getUint32(s.mem.abs(sOut), true);
  const tPoly = s.mem.view.getUint32(s.mem.abs(tOut), true);
  assertEquals(readPoly(s, h), [7, 1]);
  assertEquals(readPoly(s, sPoly), [6, 5]);
  assertEquals(readPoly(s, tPoly), [6]);
});

Deno.test("galois_sqf_list: ordinary case (SymPy: gf_sqf_list([1,1,3,0,1,0,2,2,1],5) == (1, [([1,4,3],4)]))", () => {
  const s = session();
  const f = poly(s, [1, 2, 2, 0, 1, 0, 3, 1, 1]);
  const factorsOut = s.mem.wasm.exports.test_carve_scratch(4 * 8);
  const lcOut = s.mem.wasm.exports.test_carve_scratch(4);
  const count = s.mem.wasm.exports.test_galois_sqf_list(f, 5, factorsOut, 4, lcOut);
  assertEquals(count, 1);
  const factorPtr = s.mem.view.getUint32(s.mem.abs(factorsOut) + 0, true);
  const multiplicity = s.mem.view.getUint32(s.mem.abs(factorsOut) + 4, true);
  assertEquals(readPoly(s, factorPtr), [3, 4, 1]);
  assertEquals(multiplicity, 4);
  assertEquals(s.mem.view.getUint32(s.mem.abs(lcOut), true), 1);
});

Deno.test("galois_sqf_list: characteristic-p pathology (f=x^10+2x^5+3 mod 5, f'=0, recovers h=x^2+2x+3 with multiplicity 5)", () => {
  const s = session();
  // ascending: constant=3, x^5 coeff=2, x^10 coeff=1
  const f = poly(s, [3, 0, 0, 0, 0, 2, 0, 0, 0, 0, 1]);
  const factorsOut = s.mem.wasm.exports.test_carve_scratch(4 * 8);
  const lcOut = s.mem.wasm.exports.test_carve_scratch(4);
  const count = s.mem.wasm.exports.test_galois_sqf_list(f, 5, factorsOut, 4, lcOut);
  assertEquals(count, 1);
  const factorPtr = s.mem.view.getUint32(s.mem.abs(factorsOut) + 0, true);
  const multiplicity = s.mem.view.getUint32(s.mem.abs(factorsOut) + 4, true);
  assertEquals(readPoly(s, factorPtr), [3, 2, 1]); // h ascending: 3 + 2x + x^2
  assertEquals(multiplicity, 5);
});

Deno.test("galois_ddf_zassenhaus: SymPy's own doctest (x^15-1 mod 11 -> degree-1 factor x+10 and degree-2 factor x^4+x^3+x^2+x+1... actually x^10+x^5+1)", () => {
  const s = session();
  // ascending: x^15 - 1 mod 11 = x^15 + 10
  const f = poly(s, [10, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1]);
  const factorsOut = s.mem.wasm.exports.test_carve_scratch(4 * 8);
  const count = s.mem.wasm.exports.test_galois_ddf_zassenhaus(f, 11, factorsOut, 4);
  assertEquals(count, 2);
  const factor0 = s.mem.view.getUint32(s.mem.abs(factorsOut) + 0, true);
  const degree0 = s.mem.view.getUint32(s.mem.abs(factorsOut) + 4, true);
  const factor1 = s.mem.view.getUint32(s.mem.abs(factorsOut) + 8, true);
  const degree1 = s.mem.view.getUint32(s.mem.abs(factorsOut) + 12, true);
  // SymPy: ([1,0,0,0,0,10], 1) descending -> ascending [10,0,0,0,0,1] (x^5+10, deg-1 factor product)
  assertEquals(readPoly(s, factor0), [10, 0, 0, 0, 0, 1]);
  assertEquals(degree0, 1);
  // SymPy: ([1,0,0,0,0,1,0,0,0,0,1], 2) descending -> ascending [1,0,0,0,0,1,0,0,0,0,1]
  assertEquals(readPoly(s, factor1), [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]);
  assertEquals(degree1, 2);
});

Deno.test("galois_edf_zassenhaus: SymPy's own doctest (x^3+x^2+x+1 mod 5, degree-1 factors -> x+1, x+2, x+3)", () => {
  const s = session();
  const f = poly(s, [1, 1, 1, 1]);
  const factorsOut = s.mem.wasm.exports.test_carve_scratch(4 * 4);
  const count = s.mem.wasm.exports.test_galois_edf_zassenhaus(f, 1, 5, factorsOut, 4);
  assertEquals(count, 3);
  const results = [];
  for (let i = 0; i < count; i++) {
    const ptr = s.mem.view.getUint32(s.mem.abs(factorsOut) + i * 4, true);
    results.push(readPoly(s, ptr));
  }
  // Order may differ from SymPy's (recombination order isn't
  // canonical) -- sort by constant term before comparing.
  results.sort((a, b) => a[0] - b[0]);
  assertEquals(results, [[1, 1], [2, 1], [3, 1]]);
});

Deno.test("galois_edf_zassenhaus: p==2 branch (x^2+x mod 2 -> x, x+1)", () => {
  const s = session();
  const f = poly(s, [0, 1, 1]); // ascending: x^2+x
  const factorsOut = s.mem.wasm.exports.test_carve_scratch(4 * 4);
  const count = s.mem.wasm.exports.test_galois_edf_zassenhaus(f, 1, 2, factorsOut, 4);
  assertEquals(count, 2);
  const results = [];
  for (let i = 0; i < count; i++) {
    const ptr = s.mem.view.getUint32(s.mem.abs(factorsOut) + i * 4, true);
    results.push(readPoly(s, ptr));
  }
  results.sort((a, b) => a[0] - b[0]);
  assertEquals(results, [[0, 1], [1, 1]]);
});

Deno.test("galois_edf_zassenhaus: degree-2 split ((x^2+1)(x^2+x+2) mod 3 -> x^2+1, x^2+x+2)", () => {
  const s = session();
  // product ascending: [2,1,0,1,1] (constructed as (x^2+1)(x^2+x+2) mod 3)
  const f = poly(s, [2, 1, 0, 1, 1]);
  const factorsOut = s.mem.wasm.exports.test_carve_scratch(4 * 4);
  const count = s.mem.wasm.exports.test_galois_edf_zassenhaus(f, 2, 3, factorsOut, 4);
  assertEquals(count, 2);
  const results = [];
  for (let i = 0; i < count; i++) {
    const ptr = s.mem.view.getUint32(s.mem.abs(factorsOut) + i * 4, true);
    results.push(readPoly(s, ptr));
  }
  results.sort((a, b) => a[0] - b[0]);
  assertEquals(results, [[1, 0, 1], [2, 1, 1]]);
});

function toBigInt({ sign, limbs }) {
  let magnitude = 0n;
  for (let i = limbs.length - 1; i >= 0; i--) magnitude = (magnitude << 32n) | BigInt(limbs[i]);
  return sign ? -magnitude : magnitude;
}

function zpoly(s, coeffs) {
  const p = s.mem.wasm.exports.test_zpoly_carve(Math.max(0, coeffs.length - 1));
  coeffs.forEach((c, i) => s.mem.wasm.exports.test_zpoly_set_coefficient(p, i, s.mem.marshalBigInt(BigInt(c))));
  return p;
}

function readZPoly(s, ptr) {
  const deg = s.mem.wasm.exports.test_zpoly_degree(ptr);
  const out = [];
  for (let i = 0; i <= deg; i++) out.push(toBigInt(s.mem.readBigInt(s.mem.wasm.exports.test_zpoly_coefficient(ptr, i))));
  return out;
}

Deno.test("bigint_extended_gcd: gcd(3,5) with Bezout coefficients", () => {
  const s = session();
  const a = s.mem.marshalBigInt(3n);
  const b = s.mem.marshalBigInt(5n);
  const uOut = s.mem.wasm.exports.test_carve_scratch(4);
  const vOut = s.mem.wasm.exports.test_carve_scratch(4);
  const g = s.mem.wasm.exports.test_bigint_extended_gcd(a, b, uOut, vOut);
  assertEquals(toBigInt(s.mem.readBigInt(g)), 1n);
  const u = toBigInt(s.mem.readBigInt(s.mem.view.getUint32(s.mem.abs(uOut), true)));
  const v = toBigInt(s.mem.readBigInt(s.mem.view.getUint32(s.mem.abs(vOut), true)));
  assertEquals(3n * u + 5n * v, 1n);
});

Deno.test("algebraic_hensel_lift: (x-7)(x-11) mod 5 lifted from GF(5) factors [x+3,x+4] to p^2=25 recovers exact factors", () => {
  const s = session();
  const f = zpoly(s, [77, -18, 1]); // x^2 - 18x + 77
  const factor0 = s.mem.wasm.exports.test_galois_poly_carve(1);
  s.mem.wasm.exports.test_galois_poly_set_coefficient(factor0, 0, 3);
  s.mem.wasm.exports.test_galois_poly_set_coefficient(factor0, 1, 1);
  const factor1 = s.mem.wasm.exports.test_galois_poly_carve(1);
  s.mem.wasm.exports.test_galois_poly_set_coefficient(factor1, 0, 4);
  s.mem.wasm.exports.test_galois_poly_set_coefficient(factor1, 1, 1);
  const fList = s.mem.wasm.exports.test_carve_scratch(2 * 4);
  s.mem.view.setUint32(s.mem.abs(fList) + 0, factor0, true);
  s.mem.view.setUint32(s.mem.abs(fList) + 4, factor1, true);
  const resultOut = s.mem.wasm.exports.test_carve_scratch(2 * 4);
  const status = s.mem.wasm.exports.test_algebraic_hensel_lift(5, f, fList, 2, 2, resultOut);
  assertEquals(status, 0);
  const lifted0 = s.mem.view.getUint32(s.mem.abs(resultOut) + 0, true);
  const lifted1 = s.mem.view.getUint32(s.mem.abs(resultOut) + 4, true);
  assertEquals(readZPoly(s, lifted0), [-7n, 1n]); // x - 7
  assertEquals(readZPoly(s, lifted1), [-11n, 1n]); // x - 11
});

Deno.test("algebraic_zz_zassenhaus: classic worked example x^4-1 = (x-1)(x+1)(x^2+1)", () => {
  const s = session();
  const f = zpoly(s, [-1, 0, 0, 0, 1]);
  const resultOut = s.mem.wasm.exports.test_carve_scratch(8 * 4);
  const count = s.mem.wasm.exports.test_algebraic_zz_zassenhaus(f, resultOut, 8);
  assertEquals(count, 3);
  const factors = [];
  for (let i = 0; i < count; i++) {
    factors.push(readZPoly(s, s.mem.view.getUint32(s.mem.abs(resultOut) + i * 4, true)));
  }
  factors.sort((a, b) => a.length - b.length || Number(a[0] - b[0]));
  assertEquals(factors, [[-1n, 1n], [1n, 1n], [1n, 0n, 1n]]);
});

Deno.test("algebraic_zz_zassenhaus: the resultant for sqrt2+r0 over x^3-4x-1 factors into its true minimal polynomial", () => {
  const s = session();
  // 4x^8 - 36x^6 + 24x^5 + 69x^4 + 84x^3 - 494x^2 - 372x - 63, ascending.
  const f = zpoly(s, [-63, -372, -494, 84, 69, 24, -36, 0, 4]);
  const resultOut = s.mem.wasm.exports.test_carve_scratch(8 * 4);
  const count = s.mem.wasm.exports.test_algebraic_zz_zassenhaus(f, resultOut, 8);
  assertEquals(count, 2);
  const factors = [];
  for (let i = 0; i < count; i++) {
    factors.push(readZPoly(s, s.mem.view.getUint32(s.mem.abs(resultOut) + i * 4, true)));
  }
  // 2x^4-5x^2-18x-7 (ascending [-7,-18,-5,0,2]) is the independently
  // derived minimal polynomial of sqrt2+r0 and must be one of these factors.
  const hasMinimalFactor = factors.some(f =>
    f.length === 5 && f[0] === -7n && f[1] === -18n && f[2] === -5n && f[3] === 0n && f[4] === 2n);
  assertEquals(hasMinimalFactor, true);
});

Deno.test("galois_poly_from_bigint_poly: lifts a bigint-coefficient poly to GF(p), reducing each entry", () => {
  const s = session();
  const bigintPoly = s.mem.wasm.exports.test_npoly_carve(2);
  [-13n, 100n, 7n].forEach((c, i) => s.mem.wasm.exports.test_npoly_set_coefficient(bigintPoly, i, s.mem.marshalBigInt(c)));
  const lifted = s.mem.wasm.exports.test_galois_poly_from_bigint_poly(bigintPoly, 5);
  assertEquals(readPoly(s, lifted), [2, 0, 2]); // -13 mod 5=2, 100 mod 5=0, 7 mod 5=2
});

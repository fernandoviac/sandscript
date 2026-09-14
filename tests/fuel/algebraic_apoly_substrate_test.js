/**
 * Rational-coefficient apoly substrate tests for algebraic_apoly_add,
 * algebraic_apoly_sub, algebraic_apoly_mul, algebraic_apoly_mod,
 * algebraic_apoly_gcd, and algebraic_apoly_from_bigint_poly. The tests
 * exercise these helpers directly through WASM test exports.
 */
import { assertEquals } from "https://deno.land/std@0.208.0/assert/mod.ts";
import { freshSession } from '../../src/host-owned-session.js';

function session() {
  return freshSession({ heapSize: 8 * 1024 * 1024 });
}

function toBigInt({ sign, limbs }) {
  let magnitude = 0n;
  for (let i = limbs.length - 1; i >= 0; i--) magnitude = (magnitude << 32n) | BigInt(limbs[i]);
  return sign ? -magnitude : magnitude;
}

function marshalBigInt(s, n) {
  return s.mem.marshalBigInt(BigInt(n));
}

function rat(s, num, den = 1n) {
  return s.mem.wasm.exports.test_rational_new(marshalBigInt(s, num), marshalBigInt(s, den));
}

function readRational(s, header) {
  const num = toBigInt(s.mem.readBigInt(s.mem.wasm.exports.test_rational_numerator(header)));
  const den = toBigInt(s.mem.readBigInt(s.mem.wasm.exports.test_rational_denominator(header)));
  return `${num}/${den}`;
}

/** Build an apoly from a list of [num, den] or plain bigint/number coefficients (ascending degree). */
function poly(s, coeffs) {
  const p = s.mem.wasm.exports.test_apoly_carve(coeffs.length - 1);
  coeffs.forEach((c, i) => {
    const [num, den] = Array.isArray(c) ? c : [c, 1n];
    s.mem.wasm.exports.test_apoly_set_coefficient(p, i, rat(s, BigInt(num), BigInt(den)));
  });
  return p;
}

function readPoly(s, ptr) {
  const deg = s.mem.wasm.exports.test_apoly_degree(ptr);
  const out = [];
  for (let i = 0; i <= deg; i++) out.push(readRational(s, s.mem.wasm.exports.test_apoly_coefficient(ptr, i)));
  return out;
}

Deno.test("apoly_add: (1 + 2x) + (3 + 4x + 5x^2) = 4 + 6x + 5x^2", () => {
  const s = session();
  const a = poly(s, [1, 2]);
  const b = poly(s, [3, 4, 5]);
  const result = s.mem.wasm.exports.test_apoly_add(a, b);
  assertEquals(readPoly(s, result), ["4/1", "6/1", "5/1"]);
});

Deno.test("apoly_add: with rational coefficients (1/2 + x) + (1/2 - x) = 1 (cancels x)", () => {
  const s = session();
  const a = s.mem.wasm.exports.test_apoly_carve(1);
  s.mem.wasm.exports.test_apoly_set_coefficient(a, 0, rat(s, 1n, 2n));
  s.mem.wasm.exports.test_apoly_set_coefficient(a, 1, rat(s, 1n, 1n));
  const b = s.mem.wasm.exports.test_apoly_carve(1);
  s.mem.wasm.exports.test_apoly_set_coefficient(b, 0, rat(s, 1n, 2n));
  s.mem.wasm.exports.test_apoly_set_coefficient(b, 1, rat(s, -1n, 1n));
  const result = s.mem.wasm.exports.test_apoly_add(a, b);
  assertEquals(readPoly(s, result), ["1/1"]);
});

Deno.test("apoly_sub: (3 + 4x) - (1 + x) = 2 + 3x", () => {
  const s = session();
  const a = poly(s, [3, 4]);
  const b = poly(s, [1, 1]);
  const result = s.mem.wasm.exports.test_apoly_sub(a, b);
  assertEquals(readPoly(s, result), ["2/1", "3/1"]);
});

Deno.test("apoly_mul: (1 + x)(1 - x) = 1 - x^2", () => {
  const s = session();
  const a = poly(s, [1, 1]);
  const b = poly(s, [1, -1]);
  const result = s.mem.wasm.exports.test_apoly_mul(a, b);
  assertEquals(readPoly(s, result), ["1/1", "0/1", "-1/1"]);
});

Deno.test("apoly_mul: (x^2+1)(x^3+2) via degree-2 * degree-3 -> degree-5", () => {
  const s = session();
  const a = poly(s, [1, 0, 1]);
  const b = poly(s, [2, 0, 0, 1]);
  const result = s.mem.wasm.exports.test_apoly_mul(a, b);
  // (x^2+1)(x^3+2) = x^5 + x^3 + 2x^2 + 2
  assertEquals(readPoly(s, result), ["2/1", "0/1", "2/1", "1/1", "0/1", "1/1"]);
});

Deno.test("apoly_mod: (x^2 - 1) mod (x - 1) = 0", () => {
  const s = session();
  const f = poly(s, [-1, 0, 1]);
  const m = poly(s, [-1, 1]);
  const result = s.mem.wasm.exports.test_apoly_mod(f, m);
  assertEquals(s.mem.wasm.exports.test_apoly_degree(result), -1);
});

Deno.test("apoly_mod: (x^3 + 2x + 3) mod (x^2 + 1) reduces to linear remainder", () => {
  const s = session();
  // x^3 + 2x + 3 = (x^2+1)*x + (x + 3)
  const f = poly(s, [3, 2, 0, 1]);
  const m = poly(s, [1, 0, 1]);
  const result = s.mem.wasm.exports.test_apoly_mod(f, m);
  assertEquals(readPoly(s, result), ["3/1", "1/1"]);
});

Deno.test("apoly_mod: matches SymPy's x^4-10x^2+1 reduction shape (rational coefficients survive division)", () => {
  const s = session();
  // gamma^4 - 10*gamma^2 + 1 = 0. Reduce gamma^4 mod p_gamma should give 10*gamma^2 - 1.
  const f = poly(s, [0, 0, 0, 0, 1]); // gamma^4
  const m = poly(s, [1, 0, -10, 0, 1]); // p_gamma = gamma^4 - 10 gamma^2 + 1
  const result = s.mem.wasm.exports.test_apoly_mod(f, m);
  assertEquals(readPoly(s, result), ["-1/1", "0/1", "10/1"]);
});

Deno.test("apoly_gcd: gcd(x^2-1, x-1) = x-1 (monic)", () => {
  const s = session();
  const a = poly(s, [-1, 0, 1]);
  const b = poly(s, [-1, 1]);
  const result = s.mem.wasm.exports.test_apoly_gcd(a, b);
  assertEquals(readPoly(s, result), ["-1/1", "1/1"]);
});

Deno.test("apoly_gcd: two polys with a genuine linear common factor found via Euclidean steps", () => {
  const s = session();
  // (x-2)(x-3) and (x-2)(x-5): gcd should be (x-2), monic.
  const a = poly(s, [6, -5, 1]);  // x^2 -5x +6 = (x-2)(x-3)
  const b = poly(s, [10, -7, 1]); // x^2 -7x +10 = (x-2)(x-5)
  const result = s.mem.wasm.exports.test_apoly_gcd(a, b);
  assertEquals(readPoly(s, result), ["-2/1", "1/1"]);
});

Deno.test("apoly_gcd: coprime polynomials give gcd 1 (constant)", () => {
  const s = session();
  const a = poly(s, [-1, 1]); // x - 1
  const b = poly(s, [-2, 1]); // x - 2
  const result = s.mem.wasm.exports.test_apoly_gcd(a, b);
  assertEquals(readPoly(s, result), ["1/1"]);
});

Deno.test("apoly_from_bigint_poly: lifts an existing bigint-coefficient poly's values verbatim as rationals", () => {
  const s = session();
  const bigintPoly = s.mem.wasm.exports.test_npoly_carve(2);
  s.mem.wasm.exports.test_npoly_set_coefficient(bigintPoly, 0, marshalBigInt(s, -2n));
  s.mem.wasm.exports.test_npoly_set_coefficient(bigintPoly, 1, marshalBigInt(s, 0n));
  s.mem.wasm.exports.test_npoly_set_coefficient(bigintPoly, 2, marshalBigInt(s, 1n));
  const lifted = s.mem.wasm.exports.test_apoly_from_bigint_poly(bigintPoly);
  assertEquals(readPoly(s, lifted), ["-2/1", "0/1", "1/1"]);
});

Deno.test("apoly zero polynomial: degree -1 passes through add/sub/mul unchanged", () => {
  const s = session();
  const zero = s.mem.wasm.exports.test_apoly_zero_poly(-1);
  const a = poly(s, [1, 2, 3]);
  const sum = s.mem.wasm.exports.test_apoly_add(a, zero);
  assertEquals(readPoly(s, sum), ["1/1", "2/1", "3/1"]);
  const product = s.mem.wasm.exports.test_apoly_mul(a, zero);
  assertEquals(s.mem.wasm.exports.test_apoly_degree(product), -1);
});

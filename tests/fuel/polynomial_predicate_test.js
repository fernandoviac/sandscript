/**
 * Ring 3 (3a) — Exact.Expression.isPolynomial: the widened
 * polynomial-shape predicate.
 *
 * Atoms are Ring 1 numerics, Symbols, Power(Symbol, non-negative
 * integer literal), and — the widening — ANY opaque expression
 * (unrecognised head) as an honorary atom. NOT_POLYNOMIAL is reserved
 * for shapes polynomial logic actively can't handle: Divide, negative
 * or non-integer Power exponents, symbolic exponents, and non-universe
 * values; it propagates up through Add / Subtract / Multiply / Negate
 * / Power args.
 */

import { assertEquals } from "https://deno.land/std@0.208.0/assert/mod.ts";
import { parseAndSetup } from './test-helpers.js';
import { freshSession } from '../../src/host-owned-session.js';

function isPolynomial(expressionSource) {
  const session = freshSession();
  parseAndSetup(session, `
    let x = Symbol.for('x');
    let y = Symbol.for('y');
    let z = Symbol.for('z');
    let E = Exact.Expression;
    let answer = E.isPolynomial(${expressionSource});
  `);
  const result = session.run(0, 1000000);
  if (result.status !== 'done') {
    throw new Error(`run ended ${result.status}: ${result.error?.message ?? ''}`);
  }
  return session.getExact(0, 'answer');
}

// ---------- Atoms ----------

Deno.test("isPolynomial: BigInt atom", () => {
  assertEquals(isPolynomial('42n'), true);
});

Deno.test("isPolynomial: Rational atom", () => {
  assertEquals(isPolynomial('Exact.rational(1n, 2n)'), true);
});

Deno.test("isPolynomial: Complex atom", () => {
  assertEquals(isPolynomial('Exact.complex(1n, 2n)'), true);
});

Deno.test("isPolynomial: Symbol atom", () => {
  assertEquals(isPolynomial('x'), true);
});

Deno.test("isPolynomial: opaque expression alone (Sin(x)) is a degree-0 honorary atom", () => {
  assertEquals(isPolynomial("E.make(Symbol.for('Sin'), [x])"), true);
});

Deno.test("isPolynomial: opaque head is indivisible — Sin(Divide(x, y)) is still an atom", () => {
  assertEquals(isPolynomial("E.make(Symbol.for('Sin'), [E.divide(x, y)])"), true);
});

// ---------- Power shapes ----------

Deno.test("isPolynomial: Power(x, 2)", () => {
  assertEquals(isPolynomial('E.power(x, 2n)'), true);
});

Deno.test("isPolynomial: Power(x, 0)", () => {
  assertEquals(isPolynomial('E.power(x, 0n)'), true);
});

Deno.test("isPolynomial: Power(x, huge integer) — beyond i64 still polynomial-shaped", () => {
  assertEquals(isPolynomial('E.power(x, 10n ** 30n)'), true);
});

Deno.test("isPolynomial: Power(x, -1) → false", () => {
  assertEquals(isPolynomial('E.power(x, Exact.rational(-1n, 1n))'), false);
});

Deno.test("isPolynomial: Power(x, 1/2) → false", () => {
  assertEquals(isPolynomial('E.power(x, Exact.rational(1n, 2n))'), false);
});

Deno.test("isPolynomial: Power(x, x) → false (symbolic exponent)", () => {
  assertEquals(isPolynomial('E.power(x, x)'), false);
});

Deno.test("isPolynomial: Power(2, 3) — numeric base is an honorary atom", () => {
  assertEquals(isPolynomial('E.power(2n, 3n)'), true);
});

Deno.test("isPolynomial: Power(Add(x, 1), 2) — unexpanded sum power is polynomial-shaped", () => {
  assertEquals(isPolynomial('E.power(E.add(x, 1n), 2n)'), true);
});

Deno.test("isPolynomial: Power(Divide(x, y), 2) → false (NOT propagates through the base)", () => {
  assertEquals(isPolynomial('E.power(E.divide(x, y), 2n)'), false);
});

// ---------- Divide ----------

Deno.test("isPolynomial: Divide(x, y) → false", () => {
  assertEquals(isPolynomial('E.divide(x, y)'), false);
});

Deno.test("isPolynomial: Add containing a Divide → false", () => {
  assertEquals(isPolynomial('E.add(x, E.divide(y, z))'), false);
});

Deno.test("isPolynomial: Multiply containing Power(y, -1) → false", () => {
  assertEquals(isPolynomial('E.multiply(x, E.power(y, Exact.rational(-1n, 1n)))'), false);
});

Deno.test("isPolynomial: nested propagation — Add(x, Add(y, Power(z, -1))) → false", () => {
  assertEquals(isPolynomial('E.add(x, E.add(y, E.power(z, Exact.rational(-1n, 1n))))'), false);
});

// ---------- Composite polynomial shapes ----------

Deno.test("isPolynomial: Add(y, Sin(z)) — the widened predicate's signature case", () => {
  assertEquals(isPolynomial("E.add(y, E.make(Symbol.for('Sin'), [z]))"), true);
});

Deno.test("isPolynomial: monomial Multiply(2, x, y)", () => {
  assertEquals(isPolynomial('E.multiply(2n, E.multiply(x, y))'), true);
});

Deno.test("isPolynomial: Subtract(x, y)", () => {
  assertEquals(isPolynomial('E.subtract(x, y)'), true);
});

Deno.test("isPolynomial: Negate(x)", () => {
  assertEquals(isPolynomial('E.negate(x)'), true);
});

Deno.test("isPolynomial: Negate(Divide(x, y)) → false", () => {
  assertEquals(isPolynomial('E.negate(E.divide(x, y))'), false);
});

Deno.test("isPolynomial: full multivariate polynomial", () => {
  assertEquals(isPolynomial(
    'E.add(E.multiply(2n, E.power(x, 2n)), E.add(E.multiply(x, y), 7n))'), true);
});

// ---------- Non-universe values ----------

Deno.test("isPolynomial: string → false", () => {
  assertEquals(isPolynomial("'nope'"), false);
});

Deno.test("isPolynomial: boolean → false", () => {
  assertEquals(isPolynomial('true'), false);
});

Deno.test("isPolynomial: array → false", () => {
  assertEquals(isPolynomial('[1, 2]'), false);
});

Deno.test("isPolynomial: null → false", () => {
  assertEquals(isPolynomial('null'), false);
});

Deno.test("isPolynomial: float → false (Float never enters the exact pipeline)", () => {
  assertEquals(isPolynomial('1.5'), false);
});

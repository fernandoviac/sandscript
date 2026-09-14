/**
 * Rational construction tests — Phase 1a of the exact-numbers extension.
 *
 * Covers the Exact.rational(numerator, denominator) constructor and its
 * canonicalization: sign on numerator, reduction by gcd, canonical zero.
 */

import { assertEquals, assertThrows } from "https://deno.land/std@0.208.0/assert/mod.ts";
import { createSession } from '../../src/fuel/session.js';
import { parseAndSetup } from './test-helpers.js';
import { freshSession } from '../../src/host-owned-session.js';
import { UncaughtScriptError } from '../../src/runtime/errors.js';

function run(source) {
  const session = freshSession();
  parseAndSetup(session, source);
  try {
    session.run(0, 100000);
    return { session, error: null };
  } catch (e) {
    if (e instanceof UncaughtScriptError) return { session, error: e.scriptError };
    throw e;
  }
}

function evalRational(expression) {
  const { session, error } = run(`let r = ${expression};`);
  if (error) throw new Error(`Error evaluating '${expression}': ${error.message}`);
  return session.getExact(0, 'r');
}

Deno.test("Rational: construction returns structured object", () => {
  assertEquals(evalRational('Exact.rational(3n, 7n)'), {
    kind: 'rational',
    numerator: 3n,
    denominator: 7n,
  });
});

Deno.test("Rational: negative numerator stays on numerator", () => {
  assertEquals(evalRational('Exact.rational(-3n, 7n)'), {
    kind: 'rational',
    numerator: -3n,
    denominator: 7n,
  });
});

Deno.test("Rational: negative denominator moves sign to numerator", () => {
  assertEquals(evalRational('Exact.rational(3n, -7n)'), {
    kind: 'rational',
    numerator: -3n,
    denominator: 7n,
  });
});

Deno.test("Rational: both negative produces positive", () => {
  assertEquals(evalRational('Exact.rational(-3n, -7n)'), {
    kind: 'rational',
    numerator: 3n,
    denominator: 7n,
  });
});

Deno.test("Rational: reduces by gcd", () => {
  assertEquals(evalRational('Exact.rational(6n, 8n)'), {
    kind: 'rational',
    numerator: 3n,
    denominator: 4n,
  });
});

Deno.test("Rational: zero numerator produces canonical 0/1", () => {
  assertEquals(evalRational('Exact.rational(0n, 5n)'), {
    kind: 'rational',
    numerator: 0n,
    denominator: 1n,
  });
});

Deno.test("Rational: zero denominator throws", () => {
  const { error } = run(`let r = Exact.rational(1n, 0n);`);
  if (!error) throw new Error('expected error on zero denominator');
});

Deno.test("Rational: accepts large BigInt operands", () => {
  const { session, error } = run(`let r = Exact.rational(10n ** 30n, 3n);`);
  if (error) throw new Error(error.message);
  const value = session.getExact(0, 'r');
  assertEquals(value.kind, 'rational');
  assertEquals(value.numerator, 10n ** 30n);
  assertEquals(value.denominator, 3n);
});

Deno.test("Rational: integer-valued rational has denominator 1", () => {
  assertEquals(evalRational('Exact.rational(5n, 1n)'), {
    kind: 'rational',
    numerator: 5n,
    denominator: 1n,
  });
});

Deno.test("Rational: gcd reduction cancels all common factors", () => {
  // 100/250 should reduce to 2/5
  assertEquals(evalRational('Exact.rational(100n, 250n)'), {
    kind: 'rational',
    numerator: 2n,
    denominator: 5n,
  });
});

Deno.test("Exact.isRational: true for Rational values", () => {
  const { session, error } = run(`let r = Exact.isRational(Exact.rational(1n, 2n));`);
  if (error) throw new Error(error.message);
  assertEquals(session.getExact(0, 'r'), true);
});

Deno.test("Exact.isRational: false for non-Rational values", () => {
  const { session, error } = run(`
    let a = Exact.isRational(5n);
    let b = Exact.isRational(1.5);
    let c = Exact.isRational("hi");
  `);
  if (error) throw new Error(error.message);
  assertEquals(session.getExact(0, 'a'), false);
  assertEquals(session.getExact(0, 'b'), false);
  assertEquals(session.getExact(0, 'c'), false);
});

Deno.test("Exact.isInteger: true for integer-valued Rational", () => {
  const { session, error } = run(`let r = Exact.isInteger(Exact.rational(7n, 1n));`);
  if (error) throw new Error(error.message);
  assertEquals(session.getExact(0, 'r'), true);
});

Deno.test("Exact.isInteger: false for proper fraction", () => {
  const { session, error } = run(`let r = Exact.isInteger(Exact.rational(1n, 2n));`);
  if (error) throw new Error(error.message);
  assertEquals(session.getExact(0, 'r'), false);
});

Deno.test("Exact.numerator and Exact.denominator extract BigInts", () => {
  const { session, error } = run(`
    let r = Exact.rational(6n, 8n);
    let n = Exact.numerator(r);
    let d = Exact.denominator(r);
  `);
  if (error) throw new Error(error.message);
  assertEquals(session.getExact(0, 'n'), 3n);
  assertEquals(session.getExact(0, 'd'), 4n);
});

Deno.test("Rational: binary-gcd reduction with a large shared power of two", () => {
  // $bigint_gcd is a binary (Stein) gcd: the shared power of two is
  // factored out via in-place shifts and restored by the final left
  // shift. Pin a reduction whose gcd is exactly a large power of two
  // times an odd part, crossing limb boundaries (2^90 = 2 full limbs
  // + 26 bits).
  const numerator = 3n ** 20n * 2n ** 100n;
  const denominator = 5n ** 15n * 2n ** 90n;
  assertEquals(evalRational(`Exact.rational(${numerator}n, ${denominator}n)`), {
    kind: 'rational',
    numerator: 3n ** 20n * 2n ** 10n,
    denominator: 5n ** 15n,
  });
});

Deno.test("Rational: binary-gcd reduction of coprime multi-limb values is identity", () => {
  // Consecutive Fibonacci numbers are coprime and are the gcd loop's
  // slowest-shrinking inputs — the worst case that made the old
  // Euclidean loop's allocation quadratic. F(151)/F(150), ~105 bits
  // each, reduce to themselves.
  let a = 1n, b = 1n;
  for (let i = 2; i < 151; i++) [a, b] = [b, a + b];
  // b = F(151), a = F(150)
  assertEquals(evalRational(`Exact.rational(${b}n, ${a}n)`), {
    kind: 'rational',
    numerator: b,
    denominator: a,
  });
});

Deno.test("Rational: binary-gcd reduction with odd multi-limb gcd", () => {
  const g = 7n ** 40n; // ~113 bits, odd
  assertEquals(evalRational(`Exact.rational(${4n * g}n, ${6n * g}n)`), {
    kind: 'rational',
    numerator: 2n,
    denominator: 3n,
  });
});

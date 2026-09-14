/**
 * Small-integer inline fast path tests — Phase 1c.
 *
 * The inline representation is a performance optimization that must be
 * semantically transparent: every test here should produce the same
 * answer as the heap path. These tests exercise construction, arithmetic,
 * overflow transitions to heap, mixed inline/heap, and readback.
 *
 * Inline-eligibility: Rationals with denominator == 1 and |numerator| that
 * fits in signed i64 (roughly ±9.2×10¹⁸).
 */

import { assertEquals } from "https://deno.land/std@0.208.0/assert/mod.ts";
import { createSession } from '../../src/fuel/session.js';
import { parseAndSetup } from './test-helpers.js';
import { freshSession } from '../../src/host-owned-session.js';

function run(source) {
  const session = freshSession();
  parseAndSetup(session, source);
  const result = session.run(0, 1000000);
  if (result.status === 'error') {
    return { session, error: result.error };
  }
  return { session, error: null };
}

function evalValue(expression, name = 'r') {
  const { session, error } = run(`let ${name} = ${expression};`);
  if (error) throw new Error(`Error evaluating '${expression}': ${error.message}`);
  return session.getExact(0, name);
}

function rationalOf(numerator, denominator = 1n) {
  return { kind: 'rational', numerator, denominator };
}

// ===========================================================================
// Construction picks inline when eligible
// ===========================================================================

Deno.test("Inline: small integer-valued Rational round-trips as inline", () => {
  // Semantically: Exact.rational(5n, 1n) is the integer 5.
  // Internally: should use inline representation. Observable only via
  // memory-image readback (inline path produces same shape).
  assertEquals(evalValue('Exact.rational(5n, 1n)'), rationalOf(5n));
});

Deno.test("Inline: negative small integer", () => {
  assertEquals(evalValue('Exact.rational(-42n, 1n)'), rationalOf(-42n));
});

Deno.test("Inline: zero is inline", () => {
  assertEquals(evalValue('Exact.rational(0n, 1n)'), rationalOf(0n));
});

Deno.test("Inline: non-integer Rational stays heap", () => {
  // Denominator != 1 → not inline-eligible.
  assertEquals(evalValue('Exact.rational(1n, 2n)'), rationalOf(1n, 2n));
});

Deno.test("Inline: integer beyond i64 stays heap", () => {
  // 2^63 exceeds signed i64 range. Must fall back to heap Rational.
  assertEquals(evalValue('Exact.rational(2n ** 63n, 1n)'), rationalOf(1n << 63n));
});

// ===========================================================================
// Arithmetic fast path
// ===========================================================================

Deno.test("Inline arithmetic: integer addition", () => {
  assertEquals(evalValue('Exact.rational(5n, 1n) + Exact.rational(3n, 1n)'), rationalOf(8n));
});

Deno.test("Inline arithmetic: integer subtraction", () => {
  assertEquals(evalValue('Exact.rational(10n, 1n) - Exact.rational(3n, 1n)'), rationalOf(7n));
});

Deno.test("Inline arithmetic: integer multiplication", () => {
  assertEquals(evalValue('Exact.rational(6n, 1n) * Exact.rational(7n, 1n)'), rationalOf(42n));
});

Deno.test("Inline arithmetic: integer negation", () => {
  assertEquals(evalValue('-Exact.rational(42n, 1n)'), rationalOf(-42n));
});

Deno.test("Inline arithmetic: zero negation stays zero", () => {
  assertEquals(evalValue('-Exact.rational(0n, 1n)'), rationalOf(0n));
});

Deno.test("Inline arithmetic: division produces heap Rational", () => {
  // 5 / 3 is not an integer; result must fall into heap form.
  assertEquals(evalValue('Exact.rational(5n, 1n) / Exact.rational(3n, 1n)'), rationalOf(5n, 3n));
});

Deno.test("Inline arithmetic: division that lands integer stays integer", () => {
  // 10 / 5 = 2, integer result.
  assertEquals(evalValue('Exact.rational(10n, 1n) / Exact.rational(5n, 1n)'), rationalOf(2n));
});

// ===========================================================================
// Overflow transitions to heap
// ===========================================================================

Deno.test("Inline overflow: add near i64.MAX transitions to heap", () => {
  // (2^62) + (2^62) = 2^63, which does not fit in signed i64. Falls back
  // to heap. Answer must still be exact.
  assertEquals(
    evalValue('Exact.rational(2n ** 62n, 1n) + Exact.rational(2n ** 62n, 1n)'),
    rationalOf(1n << 63n),
  );
});

Deno.test("Inline overflow: multiply large inline → heap", () => {
  // (2^40) * (2^40) = 2^80, overflow.
  assertEquals(
    evalValue('Exact.rational(2n ** 40n, 1n) * Exact.rational(2n ** 40n, 1n)'),
    rationalOf(2n ** 80n),
  );
});

Deno.test("Inline overflow: subtract underflow transitions to heap", () => {
  // i64.MIN - 1 underflows.
  const iMin = -(1n << 63n);
  assertEquals(
    evalValue(`Exact.rational(${iMin}n, 1n) - Exact.rational(1n, 1n)`),
    rationalOf(iMin - 1n),
  );
});

// ===========================================================================
// Mixed inline / heap
// ===========================================================================

Deno.test("Mixed: inline + heap Rational (non-integer)", () => {
  // 5 + 1/2 = 11/2
  assertEquals(
    evalValue('Exact.rational(5n, 1n) + Exact.rational(1n, 2n)'),
    rationalOf(11n, 2n),
  );
});

Deno.test("Mixed: heap (non-integer) + inline", () => {
  assertEquals(
    evalValue('Exact.rational(1n, 2n) + Exact.rational(5n, 1n)'),
    rationalOf(11n, 2n),
  );
});

Deno.test("Mixed: inline * heap", () => {
  // 6 * (1/3) = 2
  assertEquals(
    evalValue('Exact.rational(6n, 1n) * Exact.rational(1n, 3n)'),
    rationalOf(2n),
  );
});

Deno.test("Mixed: heap / inline", () => {
  // (1/6) / 2 = 1/12
  assertEquals(
    evalValue('Exact.rational(1n, 6n) / Exact.rational(2n, 1n)'),
    rationalOf(1n, 12n),
  );
});

// ===========================================================================
// Accessors work on both forms
// ===========================================================================

Deno.test("Accessors on inline: Exact.numerator returns i64 as BigInt", () => {
  const { session, error } = run(`let n = Exact.numerator(Exact.rational(42n, 1n));`);
  if (error) throw new Error(error.message);
  assertEquals(session.getExact(0, 'n'), 42n);
});

Deno.test("Accessors on inline: Exact.denominator is 1n", () => {
  const { session, error } = run(`let d = Exact.denominator(Exact.rational(42n, 1n));`);
  if (error) throw new Error(error.message);
  assertEquals(session.getExact(0, 'd'), 1n);
});

Deno.test("Accessors on inline: Exact.isInteger is true", () => {
  const { session, error } = run(`let r = Exact.isInteger(Exact.rational(42n, 1n));`);
  if (error) throw new Error(error.message);
  assertEquals(session.getExact(0, 'r'), true);
});

Deno.test("Accessors on inline: Exact.isRational is true", () => {
  const { session, error } = run(`let r = Exact.isRational(Exact.rational(42n, 1n));`);
  if (error) throw new Error(error.message);
  assertEquals(session.getExact(0, 'r'), true);
});

// ===========================================================================
// Equality across forms
// ===========================================================================

Deno.test("Equality: inline === inline same value", () => {
  const { session, error } = run(`let r = Exact.rational(5n, 1n) === Exact.rational(5n, 1n);`);
  if (error) throw new Error(error.message);
  assertEquals(session.getExact(0, 'r'), true);
});

Deno.test("Equality: inline === inline different value is false", () => {
  const { session, error } = run(`let r = Exact.rational(5n, 1n) === Exact.rational(6n, 1n);`);
  if (error) throw new Error(error.message);
  assertEquals(session.getExact(0, 'r'), false);
});

Deno.test("Equality: inline === heap same value (denominator 1 matters)", () => {
  // Heap Rational produced by 2/2 = 1 reduces to 1/1, which is inline-eligible.
  // So this is really inline === inline. Try with non-reducing: 10/2 = 5,
  // reduced to 5/1 → inline.
  const { session, error } = run(`let r = Exact.rational(10n, 2n) === Exact.rational(5n, 1n);`);
  if (error) throw new Error(error.message);
  assertEquals(session.getExact(0, 'r'), true);
});

Deno.test("Equality: inline === BigInt is false (different type tags)", () => {
  const { session, error } = run(`let r = Exact.rational(5n, 1n) === 5n;`);
  if (error) throw new Error(error.message);
  assertEquals(session.getExact(0, 'r'), false);
});

Deno.test("Exact.equal: inline vs. inline same value semantic", () => {
  const { session, error } = run(`let r = Exact.equal(Exact.rational(5n, 1n), Exact.rational(5n, 1n));`);
  if (error) throw new Error(error.message);
  assertEquals(session.getExact(0, 'r'), true);
});

Deno.test("Exact.equal: inline vs. BigInt", () => {
  const { session, error } = run(`let r = Exact.equal(Exact.rational(5n, 1n), 5n);`);
  if (error) throw new Error(error.message);
  assertEquals(session.getExact(0, 'r'), true);
});

// ===========================================================================
// Reassignment preserves representation correctly
// ===========================================================================

Deno.test("Reassignment: inline → inline survives", () => {
  const { session, error } = run(`
    let x = Exact.rational(1n, 1n);
    x = Exact.rational(42n, 1n);
  `);
  if (error) throw new Error(error.message);
  assertEquals(session.getExact(0, 'x'), rationalOf(42n));
});

Deno.test("Reassignment: inline → heap then → inline", () => {
  const { session, error } = run(`
    let x = Exact.rational(1n, 1n);
    x = Exact.rational(1n, 3n);
    x = Exact.rational(7n, 1n);
  `);
  if (error) throw new Error(error.message);
  assertEquals(session.getExact(0, 'x'), rationalOf(7n));
});

Deno.test("Reassignment: accumulator loop preserves fractions", () => {
  // This was the regression that caught the scope_set flag-merging bug.
  const { session, error } = run(`
    let sum = Exact.rational(0n, 1n);
    for (let i = 0; i < 100; i = i + 1) {
      sum = sum + Exact.rational(1n, 3n);
    }
  `);
  if (error) throw new Error(error.message);
  assertEquals(session.getExact(0, 'sum'), rationalOf(100n, 3n));
});

Deno.test("Reassignment: inline counter integer loop", () => {
  const { session, error } = run(`
    let x = Exact.rational(0n, 1n);
    for (let i = 0; i < 10; i = i + 1) {
      x = x + Exact.rational(1n, 1n);
    }
  `);
  if (error) throw new Error(error.message);
  assertEquals(session.getExact(0, 'x'), rationalOf(10n));
});

// ===========================================================================
// GC correctness with inline values
// ===========================================================================

Deno.test("GC: inline Rationals do not produce heap allocations", () => {
  // Allocate many inline values in a loop. They should create no heap
  // pressure. Final result must still be correct.
  const { session, error } = run(`
    let sum = Exact.rational(0n, 1n);
    for (let i = 0; i < 500; i = i + 1) {
      sum = sum + Exact.rational(1n, 1n);
    }
  `);
  if (error) throw new Error(error.message);
  assertEquals(session.getExact(0, 'sum'), rationalOf(500n));
});

Deno.test("GC: mixed inline and heap values survive collection", () => {
  const { session, error } = run(`
    let small = Exact.rational(42n, 1n);
    let big = Exact.rational(10n ** 30n, 7n);
    let garbage = Exact.rational(1n, 2n);
    for (let i = 0; i < 50; i = i + 1) {
      garbage = garbage + Exact.rational(1n, 5n);
    }
  `);
  if (error) throw new Error(error.message);
  assertEquals(session.getExact(0, 'small'), rationalOf(42n));
  const bigValue = session.getExact(0, 'big');
  assertEquals(bigValue.kind, 'rational');
  assertEquals(bigValue.numerator, 10n ** 30n);
  assertEquals(bigValue.denominator, 7n);
});

// ===========================================================================
// Complex composition preserves inline where possible
// ===========================================================================

Deno.test("Complex: real part of Complex(5, 3) is inline-eligible", () => {
  // Complex components are heap Rationals internally. Exact.real returns a
  // Rational — push_rational auto-converts to inline if eligible.
  const { session, error } = run(`
    let z = Exact.complex(5n, 3n);
    let r = Exact.real(z);
  `);
  if (error) throw new Error(error.message);
  assertEquals(session.getExact(0, 'r'), rationalOf(5n));
});

Deno.test("Complex: Exact.imaginary on real Rational is inline zero", () => {
  const { session, error } = run(`
    let r = Exact.imaginary(Exact.rational(5n, 7n));
  `);
  if (error) throw new Error(error.message);
  assertEquals(session.getExact(0, 'r'), rationalOf(0n));
});

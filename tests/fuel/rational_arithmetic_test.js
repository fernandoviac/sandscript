/**
 * Rational arithmetic tests — Phase 1a.
 *
 * Exercises OP_ADD, OP_SUB, OP_MUL, OP_DIV, OP_POW, OP_NEG, and OP_EQ
 * extensions for Rational-Rational and Rational-BigInt mixed dispatch.
 */

import { assertEquals } from "https://deno.land/std@0.208.0/assert/mod.ts";
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

Deno.test("Rational: 1/3 + 1/6 = 1/2", () => {
  assertEquals(evalRational('Exact.rational(1n, 3n) + Exact.rational(1n, 6n)'), {
    kind: 'rational',
    numerator: 1n,
    denominator: 2n,
  });
});

Deno.test("Rational: 1/3 - 1/6 = 1/6", () => {
  assertEquals(evalRational('Exact.rational(1n, 3n) - Exact.rational(1n, 6n)'), {
    kind: 'rational',
    numerator: 1n,
    denominator: 6n,
  });
});

Deno.test("Rational: 2/3 * 3/4 = 1/2", () => {
  assertEquals(evalRational('Exact.rational(2n, 3n) * Exact.rational(3n, 4n)'), {
    kind: 'rational',
    numerator: 1n,
    denominator: 2n,
  });
});

Deno.test("Rational: (1/3) / (2/5) = 5/6", () => {
  assertEquals(evalRational('Exact.rational(1n, 3n) / Exact.rational(2n, 5n)'), {
    kind: 'rational',
    numerator: 5n,
    denominator: 6n,
  });
});

Deno.test("Rational: (2/3) ** 3 = 8/27", () => {
  assertEquals(evalRational('Exact.rational(2n, 3n) ** 3n'), {
    kind: 'rational',
    numerator: 8n,
    denominator: 27n,
  });
});

Deno.test("Rational: negation", () => {
  assertEquals(evalRational('-Exact.rational(3n, 7n)'), {
    kind: 'rational',
    numerator: -3n,
    denominator: 7n,
  });
});

Deno.test("Rational: negation of zero stays zero", () => {
  assertEquals(evalRational('-Exact.rational(0n, 1n)'), {
    kind: 'rational',
    numerator: 0n,
    denominator: 1n,
  });
});

Deno.test("Rational: division by zero yields Infinity (JS contagion)", () => {
  // Under the Mathematica-style contagion rule, Rational/0 coerces to Float
  // and follows IEEE-754 semantics: 1/0 = Infinity (matches JS `1/0`).
  const { session, error } = run(`let r = Exact.rational(1n, 2n) / Exact.rational(0n, 1n);`);
  if (error) throw new Error(error.message);
  assertEquals(session.getExact(0, 'r'), Infinity);
});

Deno.test("Rational + BigInt promotes BigInt", () => {
  assertEquals(evalRational('Exact.rational(1n, 2n) + 3n'), {
    kind: 'rational',
    numerator: 7n,
    denominator: 2n,
  });
});

Deno.test("BigInt + Rational promotes BigInt", () => {
  assertEquals(evalRational('3n + Exact.rational(1n, 2n)'), {
    kind: 'rational',
    numerator: 7n,
    denominator: 2n,
  });
});

Deno.test("Rational * BigInt", () => {
  assertEquals(evalRational('Exact.rational(1n, 3n) * 6n'), {
    kind: 'rational',
    numerator: 2n,
    denominator: 1n,
  });
});

Deno.test("BigInt / Rational", () => {
  // 1 / (1/2) = 2
  assertEquals(evalRational('1n / Exact.rational(1n, 2n)'), {
    kind: 'rational',
    numerator: 2n,
    denominator: 1n,
  });
});

Deno.test("Rational + Float contaminates to Float (Mathematica-style)", () => {
  // Contagion rule: decimal literal signals approximate-land; Rational is
  // coerced to f64 and the result is Float.
  const { session, error } = run(`let r = Exact.rational(1n, 2n) + 0.5;`);
  if (error) throw new Error(error.message);
  assertEquals(session.getExact(0, 'r'), 1.0);
});

Deno.test("Float + Rational contaminates to Float (Mathematica-style)", () => {
  const { session, error } = run(`let r = 0.5 + Exact.rational(1n, 2n);`);
  if (error) throw new Error(error.message);
  assertEquals(session.getExact(0, 'r'), 1.0);
});

Deno.test("Rational structural equality: === true for same value", () => {
  const { session, error } = run(`let r = Exact.rational(1n, 2n) === Exact.rational(2n, 4n);`);
  if (error) throw new Error(error.message);
  // 2/4 is reduced to 1/2, so structural equality holds.
  assertEquals(session.getExact(0, 'r'), true);
});

Deno.test("Rational structural equality: different reduced forms are !==", () => {
  const { session, error } = run(`let r = Exact.rational(1n, 2n) === Exact.rational(1n, 3n);`);
  if (error) throw new Error(error.message);
  assertEquals(session.getExact(0, 'r'), false);
});

Deno.test("Rational === BigInt is false (different type tags)", () => {
  const { session, error } = run(`let r = Exact.rational(3n, 1n) === 3n;`);
  if (error) throw new Error(error.message);
  assertEquals(session.getExact(0, 'r'), false);
});

Deno.test("Exact.equal: Rational vs. Rational semantic equality", () => {
  const { session, error } = run(`let r = Exact.equal(Exact.rational(2n, 4n), Exact.rational(1n, 2n));`);
  if (error) throw new Error(error.message);
  assertEquals(session.getExact(0, 'r'), true);
});

Deno.test("Exact.equal: Rational vs. BigInt when denominator is 1", () => {
  const { session, error } = run(`let r = Exact.equal(Exact.rational(5n, 1n), 5n);`);
  if (error) throw new Error(error.message);
  assertEquals(session.getExact(0, 'r'), true);
});

Deno.test("Exact.equal: Rational vs. BigInt when not integer", () => {
  const { session, error } = run(`let r = Exact.equal(Exact.rational(1n, 2n), 5n);`);
  if (error) throw new Error(error.message);
  assertEquals(session.getExact(0, 'r'), false);
});

Deno.test("Exact.equal: BigInt vs. Rational argument order does not matter", () => {
  const { session, error } = run(`let r = Exact.equal(5n, Exact.rational(5n, 1n));`);
  if (error) throw new Error(error.message);
  assertEquals(session.getExact(0, 'r'), true);
});

Deno.test("Exact.equal: Float operand throws TypeError", () => {
  const { error } = run(`let r = Exact.equal(Exact.rational(1n, 2n), 0.5);`);
  if (!error) throw new Error('expected TypeError on Float in Exact.equal');
});

Deno.test("Rational: chained arithmetic stays reduced", () => {
  // 1/2 + 1/3 + 1/6 = 1
  assertEquals(evalRational('Exact.rational(1n, 2n) + Exact.rational(1n, 3n) + Exact.rational(1n, 6n)'), {
    kind: 'rational',
    numerator: 1n,
    denominator: 1n,
  });
});

Deno.test("Rational: negative exponent throws", () => {
  const { error } = run(`let r = Exact.rational(2n, 3n) ** -1n;`);
  if (!error) throw new Error('expected error on negative exponent');
});

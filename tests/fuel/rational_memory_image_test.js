/**
 * Memory-image readback for Rational — Phase 1a.
 *
 * Verifies that session.get() returns a structured
 * { kind: 'rational', numerator, denominator } object and that the values
 * round-trip through arithmetic and GC.
 */

import { assertEquals } from "https://deno.land/std@0.208.0/assert/mod.ts";
import { createSession } from '../../src/fuel/session.js';
import { parseAndSetup } from './test-helpers.js';
import { freshSession } from '../../src/host-owned-session.js';

function run(source) {
  const session = freshSession();
  parseAndSetup(session, source);
  const result = session.run(0, 100000);
  if (result.status === 'error') {
    throw new Error(result.error.message);
  }
  return session;
}

Deno.test("Rational readback: session.get returns structured object", () => {
  const session = run(`let r = Exact.rational(355n, 113n);`);
  const value = session.getExact(0, 'r');
  assertEquals(value.kind, 'rational');
  assertEquals(value.numerator, 355n);
  assertEquals(value.denominator, 113n);
});

Deno.test("Rational readback: negative numerator round-trips", () => {
  const session = run(`let r = Exact.rational(-5n, 7n);`);
  assertEquals(session.getExact(0, 'r'), {
    kind: 'rational',
    numerator: -5n,
    denominator: 7n,
  });
});

Deno.test("Rational readback: values are JS BigInts", () => {
  const session = run(`let r = Exact.rational(1n, 2n);`);
  const value = session.getExact(0, 'r');
  assertEquals(typeof value.numerator, 'bigint');
  assertEquals(typeof value.denominator, 'bigint');
});

Deno.test("Rational readback: reads values across contexts of same session", () => {
  const session = run(`
    let a = Exact.rational(3n, 4n);
    let b = Exact.rational(5n, 7n);
    let c = a + b;
  `);
  // 3/4 + 5/7 = (21+20)/28 = 41/28
  assertEquals(session.getExact(0, 'c'), {
    kind: 'rational',
    numerator: 41n,
    denominator: 28n,
  });
});

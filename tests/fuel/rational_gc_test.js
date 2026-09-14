/**
 * GC tests for Rational — Phase 1a.
 *
 * Confirms that heap Rationals (and their BigInt children) are traced
 * correctly through collection and survive compaction.
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
    throw new Error(`Error: ${result.error.message}`);
  }
  return session;
}

Deno.test("Rational GC: long-lived rational survives many allocations", () => {
  const session = run(`
    let kept = Exact.rational(355n, 113n);
    let acc = Exact.rational(0n, 1n);
    for (let i = 0; i < 200; i = i + 1) {
      acc = acc + Exact.rational(1n, 2n);
    }
    let final = kept;
  `);
  assertEquals(session.getExact(0, 'final'), {
    kind: 'rational',
    numerator: 355n,
    denominator: 113n,
  });
});

Deno.test("Rational GC: arithmetic chain with gc pressure preserves correctness", () => {
  const session = run(`
    let sum = Exact.rational(0n, 1n);
    for (let i = 0; i < 100; i = i + 1) {
      sum = sum + Exact.rational(1n, 3n);
    }
  `);
  // 100 * 1/3 = 100/3
  assertEquals(session.getExact(0, 'sum'), {
    kind: 'rational',
    numerator: 100n,
    denominator: 3n,
  });
});

Deno.test("Rational GC: rational with large BigInt components survives", () => {
  const session = run(`
    let big = Exact.rational(10n ** 40n, 3n);
    let filler = Exact.rational(0n, 1n);
    for (let i = 0; i < 50; i = i + 1) {
      filler = filler + Exact.rational(1n, 7n);
    }
    let still = big;
  `);
  const value = session.getExact(0, 'still');
  assertEquals(value.kind, 'rational');
  assertEquals(value.numerator, 10n ** 40n);
  assertEquals(value.denominator, 3n);
});

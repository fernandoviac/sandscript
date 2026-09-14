/**
 * Regression test for the pre-existing GC alignment bug.
 *
 * Bug: BigInt heap objects stored unaligned total_size in the GC header while
 * the allocator advanced the heap pointer by the 16-aligned stride. The
 * collector walked by the header size, producing a misalignment gap that later
 * looked like a malformed object. Symptom: property reads throwing
 * ERR_USER_THROW after a GC cycle.
 *
 * Odd-limb BigInts are the failure case: length=1 gives total_size=20 but
 * aligned stride=32. Length=2 gives total=24, aligned=32 — also unaligned.
 * Length=0 and length=4 already aligned by coincidence.
 *
 * Fix: store the aligned size in the GC header so walk stride == alloc stride.
 */

import { assertEquals } from "https://deno.land/std@0.208.0/assert/mod.ts";
import { createSession } from '../../src/fuel/session.js';
import { parseAndSetup } from './test-helpers.js';
import { freshSession } from '../../src/host-owned-session.js';

function run(source) {
  const session = freshSession();
  parseAndSetup(session, source);
  const result = session.run(0, 10000000);
  if (result.status === 'error') {
    throw new Error(`Error: ${result.error.message}`);
  }
  return session;
}

Deno.test("GC alignment: odd-limb BigInts survive a full collection cycle", () => {
  // 2n ** 40n is a single-limb-ish BigInt (fits in two 32-bit limbs — 40 bits).
  // Allocate many of them followed by forced GC pressure.
  const session = run(`
    let kept = 2n ** 40n;
    let filler = 0n;
    for (let i = 0; i < 500; i = i + 1) {
      filler = filler + (2n ** 40n);
    }
    let still = kept;
  `);
  assertEquals(session.get(0, 'still'), 2n ** 40n);
});

Deno.test("GC alignment: two-limb BigInts survive collection", () => {
  // 2n ** 80n spans two 32-bit limbs — data_size = 8 + 8 = 16, total = 24,
  // aligned = 32. The mismatched case under the old bug.
  const session = run(`
    let kept = 2n ** 80n;
    let filler = 0n;
    for (let i = 0; i < 500; i = i + 1) {
      filler = filler + (2n ** 80n);
    }
    let still = kept;
  `);
  assertEquals(session.get(0, 'still'), 2n ** 80n);
});

Deno.test("GC alignment: property access after heavy BigInt churn", () => {
  // Reproduces the original 'ERR_USER_THROW on property read after GC' symptom.
  const session = run(`
    let obj = { value: 2n ** 50n };
    for (let i = 0; i < 1000; i = i + 1) {
      let temp = 2n ** 50n + 1n;
    }
    let result = obj.value;
  `);
  assertEquals(session.get(0, 'result'), 2n ** 50n);
});

Deno.test("GC alignment: Rational with odd-limb BigInt numerator and denominator", () => {
  const session = run(`
    let kept = Exact.rational(2n ** 40n, 3n);
    let filler = Exact.rational(0n, 1n);
    for (let i = 0; i < 200; i = i + 1) {
      filler = filler + Exact.rational(2n ** 40n, 7n);
    }
    let still = kept;
  `);
  const value = session.get(0, 'still');
  assertEquals(value.kind, 'rational');
  assertEquals(value.numerator, 2n ** 40n);
  assertEquals(value.denominator, 3n);
});

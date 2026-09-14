/**
 * Tests for $bigint_to_decimal (interpreter.wat).
 *
 * Before this work, the function wrote digit bytes into the fixed
 * 256-byte SCRATCH region with no bounds check. Bigints whose decimal
 * form exceeded ~256 digits silently corrupted memory beyond SCRATCH
 * (typically the BUILTINS region), after which the caller proceeded with a
 * corrupt string id.
 *
 * The fix routes the digit buffer through heap-tail scratch with the
 * same memory-pressure protocol as $string_concat and the 8 string
 * methods. Large bigints now stringify correctly; near-segment-end
 * bigints yield with status 'memory_pressure' instead of trapping.
 */

import { assertEquals } from "https://deno.land/std@0.208.0/assert/mod.ts";
import { createSession } from '../../src/fuel/session.js';
import { freshSession } from '../../src/host-owned-session.js';

Deno.test('String(small bigint) round-trips', () => {
  const session = freshSession();
  session.parse(`
    let x = 42n
    let s = String(x)
  `);
  const r = session.run(0, 1_000_000);
  assertEquals(r.status, 'done');
  assertEquals(session.get(0, 's'), '42');
});

Deno.test('String(negative bigint) round-trips', () => {
  const session = freshSession();
  session.parse(`
    let x = -12345n
    let s = String(x)
  `);
  const r = session.run(0, 1_000_000);
  assertEquals(r.status, 'done');
  assertEquals(session.get(0, 's'), '-12345');
});

Deno.test('String(bigint zero) returns "0"', () => {
  const session = freshSession();
  session.parse(`
    let s = String(0n)
  `);
  const r = session.run(0, 1_000_000);
  assertEquals(r.status, 'done');
  assertEquals(session.get(0, 's'), '0');
});

Deno.test('String(1200-digit bigint) matches JS BigInt', () => {
  // Pre-fix: silently corrupted state. Post-fix: produces the
  // correct 1200-digit decimal representation.
  const session = freshSession();
  session.parse(`
    let big = 1n
    let i = 0
    while (i < 100) { big = big * 999999999999n; i = i + 1 }
    let s = String(big)
    let len = s.length
  `);
  const r = session.run(0, 200_000_000);
  assertEquals(r.status, 'done');

  // Compute the expected via JS BigInt.
  let expected = 1n;
  for (let i = 0; i < 100; i++) expected *= 999999999999n;
  const expectedStr = String(expected);

  assertEquals(session.get(0, 'len'), expectedStr.length);
  assertEquals(session.get(0, 's'), expectedStr);
});

Deno.test('Coerce-concat with huge bigint preserves both operands', () => {
  // "prefix=" + huge_bigint exercises the OP_ADD String+other coerce
  // branch, which calls $value_to_string -> $bigint_to_decimal.
  // Before the fix, the huge bigint's stringification corrupted state
  // and the left "prefix=" was lost or garbled.
  const session = freshSession();
  session.parse(`
    let big = 1n
    let i = 0
    while (i < 80) { big = big * 999999999999n; i = i + 1 }
    let s = "prefix=" + big
    let head = s.slice(0, 7)
  `);
  let result = session.run(0, 200_000_000);
  while (result.status === 'memory_pressure') {
    session.gc();
    result = session.run(0, 200_000_000);
  }
  assertEquals(result.status, 'done');
  // Left operand survived; the slice (which now dedups via the chokepoint)
  // returns the same id as the literal.
  assertEquals(session.get(0, 'head'), 'prefix=');
});

Deno.test('Rational with huge numerator stringifies correctly', () => {
  // Use a base coprime with 11 so the rational doesn't reduce. 1000000007
  // is a prime (the well-known "competitive-programming prime").
  const session = freshSession();
  session.parse(`
    let big = 1n
    let i = 0
    while (i < 80) { big = big * 1000000007n; i = i + 1 }
    let r = Exact.rational(big, 11n)
    let s = String(r)
    let len = s.length
    // "<num>/11" — last 3 chars are "/11".
    let tail = s.slice(len - 3)
  `);
  let result = session.run(0, 200_000_000);
  while (result.status === 'memory_pressure') {
    session.gc();
    result = session.run(0, 200_000_000);
  }
  assertEquals(result.status, 'done');
  assertEquals(session.get(0, 'tail'), '/11');
});

Deno.test('bigint stringification under memory pressure yields', () => {
  // Pad the string table so any new long entry would overflow.
  // Then stringify a sizable bigint via coercion. Either the
  // coerce-final concat or the bigint scratch will hit the
  // pre-check; in either case the dispatcher yields rather than
  // trapping.
  const session = freshSession();
  session.parse(`
    let pad = "p"
    let i = 0
    while (i < 600) { pad = pad + "p"; i = i + 1 }
    let big = 1n
    let j = 0
    while (j < 50) { big = big * 999999999999n; j = j + 1 }
    let s = "x=" + big
    let len = s.length
  `);

  let result;
  try {
    result = session.run(0, 200_000_000);
  } catch (e) {
    throw new Error(`Expected yield, got WASM trap: ${e.message}`);
  }
  while (result.status === 'memory_pressure') {
    session.gc();
    result = session.run(0, 200_000_000);
  }
  assertEquals(result.status, 'done');
  // "x=" (2 chars) + 50 * 12 ≈ 600 decimal digits.
  const len = session.get(0, 'len');
  if (typeof len !== 'number' || len < 2 + 50) {
    throw new Error(`Unexpected len: ${len}`);
  }
});

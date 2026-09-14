/**
 * Tests for JSON serialization of exact types.
 *
 * Semantics (aligned with the 1d session.get unwrap rule):
 *   Integer-valued Rational  → plain JSON number ("5", "-5", "0")
 *   Non-integer Rational     → {"$rational":"n/d"}   (tagged, lossless)
 *   Complex                  → {"$complex":"a + bi"} (tagged, lossless)
 *   BigInt                   → {"$bigint":"…"}       (tagged, lossless)
 *   Float                    → unchanged JSON number ("3.5", NaN/∞ → null)
 *
 * Parsing exact values back out of JSON is deliberately NOT provided.
 * JSON is a data-interchange format; if you need symbolic round-trip,
 * that is a formula-language concern, not a numeric-literal one.
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

// Integer-valued Rationals emit as plain JSON numbers.

Deno.test("JSON: integer literal emits as plain number", () => {
  assertEquals(run(`let x = JSON.stringify(5);`).get(0, 'x'), '5');
});

Deno.test("JSON: negative integer emits as plain number", () => {
  assertEquals(run(`let x = JSON.stringify(-5);`).get(0, 'x'), '-5');
});

Deno.test("JSON: zero emits as '0'", () => {
  assertEquals(run(`let x = JSON.stringify(0);`).get(0, 'x'), '0');
});

Deno.test("JSON: Exact.rational(6n, 3n) reduces then emits as '2'", () => {
  assertEquals(run(`let x = JSON.stringify(Exact.rational(6n, 3n));`).get(0, 'x'), '2');
});

// Non-integer Rationals → tagged form.

Deno.test("JSON: Exact.rational(1n, 3n) → {\"$rational\":\"1/3\"}", () => {
  assertEquals(run(`let x = JSON.stringify(Exact.rational(1n, 3n));`).get(0, 'x'),
    '{"$rational":"1/3"}');
});

Deno.test("JSON: Exact.rational(-1n, 3n) → {\"$rational\":\"-1/3\"}", () => {
  assertEquals(run(`let x = JSON.stringify(Exact.rational(-1n, 3n));`).get(0, 'x'),
    '{"$rational":"-1/3"}');
});

// Complex always tagged (no lossless JSON number form).

Deno.test("JSON: Exact.i → {\"$complex\":\"i\"}", () => {
  assertEquals(run(`let x = JSON.stringify(Exact.i);`).get(0, 'x'),
    '{"$complex":"i"}');
});

Deno.test("JSON: Exact.complex(3n, 4n) → {\"$complex\":\"3 + 4i\"}", () => {
  assertEquals(run(`let x = JSON.stringify(Exact.complex(3n, 4n));`).get(0, 'x'),
    '{"$complex":"3 + 4i"}');
});

Deno.test("JSON: Exact.complex(3n, -4n) → {\"$complex\":\"3 - 4i\"}", () => {
  assertEquals(run(`let x = JSON.stringify(Exact.complex(3n, -4n));`).get(0, 'x'),
    '{"$complex":"3 - 4i"}');
});

// BigInt always tagged (JSON numbers can't represent > 2^53 losslessly).

Deno.test("JSON: small BigInt still tagged", () => {
  assertEquals(run(`let x = JSON.stringify(3n);`).get(0, 'x'),
    '{"$bigint":"3"}');
});

Deno.test("JSON: BigInt past safe-integer range is exact", () => {
  assertEquals(run(`let x = JSON.stringify(9999999999999999999n);`).get(0, 'x'),
    '{"$bigint":"9999999999999999999"}');
});

Deno.test("JSON: negative BigInt", () => {
  assertEquals(run(`let x = JSON.stringify(-42n);`).get(0, 'x'),
    '{"$bigint":"-42"}');
});

// Float path unchanged.

Deno.test("JSON: float renders as plain number", () => {
  assertEquals(run(`let x = JSON.stringify(3.5);`).get(0, 'x'), '3.5');
});

Deno.test("JSON: NaN becomes null", () => {
  assertEquals(run(`let x = JSON.stringify(0.0 / 0.0);`).get(0, 'x'), 'null');
});

Deno.test("JSON: Infinity becomes null", () => {
  assertEquals(run(`let x = JSON.stringify(1.0 / 0.0);`).get(0, 'x'), 'null');
});

// Collection cases — exactness propagates correctly through arrays/objects.

Deno.test("JSON: array of integers emits as plain numbers", () => {
  assertEquals(run(`let x = JSON.stringify([1, 2, 3]);`).get(0, 'x'),
    '[1,2,3]');
});

Deno.test("JSON: array with non-integer rational is tagged", () => {
  assertEquals(run(`let x = JSON.stringify([1, Exact.rational(1n, 3n), 2]);`).get(0, 'x'),
    '[1,{"$rational":"1/3"},2]');
});

Deno.test("JSON: object with mixed exact values", () => {
  assertEquals(
    run(`let x = JSON.stringify({count: 5, ratio: Exact.rational(1n, 2n), z: Exact.i});`).get(0, 'x'),
    '{"count":5,"ratio":{"$rational":"1/2"},"z":{"$complex":"i"}}'
  );
});

Deno.test("JSON: nested BigInt in object", () => {
  assertEquals(
    run(`let x = JSON.stringify({id: 9999999999999999999n});`).get(0, 'x'),
    '{"id":{"$bigint":"9999999999999999999"}}'
  );
});

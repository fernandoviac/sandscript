/**
 * Tests for Exact.toString(x) — exact decimal pretty-printing.
 *
 * Integer Rational            → "5"   / "-5"
 * Non-integer Rational        → "1/3" / "-1/3"
 * Complex, pure imaginary     → "i", "-i", "2i", "-2i"
 * Complex, real + imag        → "3 + 4i", "3 - 4i", "3 + i", "3 - i"
 * BigInt (including > 2^53)   → exact decimal string
 * Float                       → delegates to f64 stringification
 *
 * Also covers that `String(x)` takes the exact path: `String(Exact.i)` is
 * "i", not "[object Object]"; `String(Exact.rational(1n, 3n))` is "1/3",
 * not a lossy f64 approximation.
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

// Integer Rationals

Deno.test("Exact.toString: 5 → '5'", () => {
  assertEquals(run(`let x = Exact.toString(5);`).get(0, 'x'), '5');
});

Deno.test("Exact.toString: -5 → '-5'", () => {
  assertEquals(run(`let x = Exact.toString(-5);`).get(0, 'x'), '-5');
});

Deno.test("Exact.toString: 0 → '0'", () => {
  assertEquals(run(`let x = Exact.toString(0);`).get(0, 'x'), '0');
});

// Non-integer Rationals

Deno.test("Exact.toString: Exact.rational(1, 3) → '1/3'", () => {
  assertEquals(run(`let x = Exact.toString(Exact.rational(1n, 3n));`).get(0, 'x'), '1/3');
});

Deno.test("Exact.toString: Exact.rational(-1, 3) → '-1/3'", () => {
  assertEquals(run(`let x = Exact.toString(Exact.rational(-1n, 3n));`).get(0, 'x'), '-1/3');
});

Deno.test("Exact.toString: Exact.rational(6, 3) → '2' (reduced)", () => {
  assertEquals(run(`let x = Exact.toString(Exact.rational(6n, 3n));`).get(0, 'x'), '2');
});

// Complex — pure imaginary

Deno.test("Exact.toString: Exact.i → 'i'", () => {
  assertEquals(run(`let x = Exact.toString(Exact.i);`).get(0, 'x'), 'i');
});

Deno.test("Exact.toString: Exact.complex(0, -1) → '-i'", () => {
  assertEquals(run(`let x = Exact.toString(Exact.complex(0n, -1n));`).get(0, 'x'), '-i');
});

Deno.test("Exact.toString: Exact.complex(0, 2) → '2i'", () => {
  assertEquals(run(`let x = Exact.toString(Exact.complex(0n, 2n));`).get(0, 'x'), '2i');
});

Deno.test("Exact.toString: Exact.complex(0, -2) → '-2i'", () => {
  assertEquals(run(`let x = Exact.toString(Exact.complex(0n, -2n));`).get(0, 'x'), '-2i');
});

// Complex — mixed

Deno.test("Exact.toString: Exact.complex(3, 4) → '3 + 4i'", () => {
  assertEquals(run(`let x = Exact.toString(Exact.complex(3n, 4n));`).get(0, 'x'), '3 + 4i');
});

Deno.test("Exact.toString: Exact.complex(3, -4) → '3 - 4i'", () => {
  assertEquals(run(`let x = Exact.toString(Exact.complex(3n, -4n));`).get(0, 'x'), '3 - 4i');
});

Deno.test("Exact.toString: Exact.complex(3, 1) → '3 + i' (drop coefficient)", () => {
  assertEquals(run(`let x = Exact.toString(Exact.complex(3n, 1n));`).get(0, 'x'), '3 + i');
});

Deno.test("Exact.toString: Exact.complex(3, -1) → '3 - i'", () => {
  assertEquals(run(`let x = Exact.toString(Exact.complex(3n, -1n));`).get(0, 'x'), '3 - i');
});

Deno.test("Exact.toString: Complex with rational parts", () => {
  assertEquals(
    run(`let x = Exact.toString(Exact.complex(Exact.rational(1n, 2n), Exact.rational(3n, 4n)));`).get(0, 'x'),
    '1/2 + 3/4i'
  );
});

// BigInt — including beyond f64 safe-integer range

Deno.test("Exact.toString: 123456789n → '123456789'", () => {
  assertEquals(run(`let x = Exact.toString(123456789n);`).get(0, 'x'), '123456789');
});

Deno.test("Exact.toString: -123456789n → '-123456789'", () => {
  assertEquals(run(`let x = Exact.toString(-123456789n);`).get(0, 'x'), '-123456789');
});

Deno.test("Exact.toString: multi-limb BigInt is exact", () => {
  assertEquals(run(`let x = Exact.toString(9999999999999999999n);`).get(0, 'x'),
    '9999999999999999999');
});

Deno.test("Exact.toString: negative multi-limb BigInt", () => {
  assertEquals(run(`let x = Exact.toString(-9999999999999999999n);`).get(0, 'x'),
    '-9999999999999999999');
});

// Symbols — mathematical atoms use their descriptions.

Deno.test("Exact.toString: symbols return atom names", () => {
  const session = run(`
    let variable = Exact.toString(Symbol.for('x'));
    let pi = Exact.toString(Exact.Pi);
    let e = Exact.toString(Exact.E);
    let infinity = Exact.toString(Exact.Infinity);
    let fresh = Exact.toString(Symbol('fresh'));
    let anonymous = Exact.toString(Symbol());
  `);
  assertEquals(session.get(0, 'variable'), 'x');
  assertEquals(session.get(0, 'pi'), 'Pi');
  assertEquals(session.get(0, 'e'), 'E');
  assertEquals(session.get(0, 'infinity'), 'Infinity');
  assertEquals(session.get(0, 'fresh'), 'fresh');
  assertEquals(session.get(0, 'anonymous'), 'Symbol()');
});

// Float and non-numeric fallbacks

Deno.test("Exact.toString: 3.5 → '3.5' (float via f64)", () => {
  assertEquals(run(`let x = Exact.toString(3.5);`).get(0, 'x'), '3.5');
});

Deno.test("Exact.toString: true → 'true'", () => {
  assertEquals(run(`let x = Exact.toString(true);`).get(0, 'x'), 'true');
});

Deno.test("Exact.toString: null → 'null'", () => {
  assertEquals(run(`let x = Exact.toString(null);`).get(0, 'x'), 'null');
});

// String(x) also takes the exact path now

Deno.test("String: String(Exact.rational(1n, 3n)) → '1/3' (exact, not 0.333…)", () => {
  assertEquals(run(`let x = String(Exact.rational(1n, 3n));`).get(0, 'x'), '1/3');
});

Deno.test("String: String(Exact.i) → 'i' (not [object Object])", () => {
  assertEquals(run(`let x = String(Exact.i);`).get(0, 'x'), 'i');
});

Deno.test("String: String(3n) → '3' (bigint exact)", () => {
  assertEquals(run(`let x = String(3n);`).get(0, 'x'), '3');
});

Deno.test("String: String(9999999999999999999n) → exact decimal", () => {
  assertEquals(run(`let x = String(9999999999999999999n);`).get(0, 'x'),
    '9999999999999999999');
});

// String concatenation via `+` goes through exact stringification.

Deno.test("concat: 'r=' + Exact.rational(1n, 3n) → 'r=1/3'", () => {
  assertEquals(run(`let x = 'r=' + Exact.rational(1n, 3n);`).get(0, 'x'), 'r=1/3');
});

Deno.test("concat: 'z=' + Exact.complex(3n, 4n) → 'z=3 + 4i'", () => {
  assertEquals(run(`let x = 'z=' + Exact.complex(3n, 4n);`).get(0, 'x'), 'z=3 + 4i');
});

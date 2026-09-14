/**
 * Tests for Exact.typeOf(x) — fine-grained numeric type predicate.
 *
 * Returns 'integer' / 'rational' / 'complex' / 'bigint' / 'float' for
 * numeric values, and the coarse `typeof` result for everything else.
 *
 * Also covers the plan's JS-surface rule: `typeof` itself still yields
 * 'number' for every numeric type (Float, Rational, Complex).
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

Deno.test("Exact.typeOf: integer literal → 'integer'", () => {
  const session = run(`let x = Exact.typeOf(5);`);
  assertEquals(session.get(0, 'x'), 'integer');
});

Deno.test("Exact.typeOf: Exact.rational(1n, 3n) → 'rational'", () => {
  const session = run(`let x = Exact.typeOf(Exact.rational(1n, 3n));`);
  assertEquals(session.get(0, 'x'), 'rational');
});

Deno.test("Exact.typeOf: Exact.rational(6n, 3n) → 'integer' (reduced)", () => {
  const session = run(`let x = Exact.typeOf(Exact.rational(6n, 3n));`);
  assertEquals(session.get(0, 'x'), 'integer');
});

Deno.test("Exact.typeOf: Exact.i → 'complex'", () => {
  const session = run(`let x = Exact.typeOf(Exact.i);`);
  assertEquals(session.get(0, 'x'), 'complex');
});

Deno.test("Exact.typeOf: Exact.complex(1n, 2n) → 'complex'", () => {
  const session = run(`let x = Exact.typeOf(Exact.complex(1n, 2n));`);
  assertEquals(session.get(0, 'x'), 'complex');
});

Deno.test("Exact.typeOf: 3.5 → 'float'", () => {
  const session = run(`let x = Exact.typeOf(3.5);`);
  assertEquals(session.get(0, 'x'), 'float');
});

Deno.test("Exact.typeOf: 3.0 → 'float' (decimal literal is Float)", () => {
  const session = run(`let x = Exact.typeOf(3.0);`);
  assertEquals(session.get(0, 'x'), 'float');
});

Deno.test("Exact.typeOf: 3n → 'bigint'", () => {
  const session = run(`let x = Exact.typeOf(3n);`);
  assertEquals(session.get(0, 'x'), 'bigint');
});

Deno.test("Exact.typeOf: 'hello' → 'string'", () => {
  const session = run(`let x = Exact.typeOf('hello');`);
  assertEquals(session.get(0, 'x'), 'string');
});

Deno.test("Exact.typeOf: true → 'boolean'", () => {
  const session = run(`let x = Exact.typeOf(true);`);
  assertEquals(session.get(0, 'x'), 'boolean');
});

Deno.test("Exact.typeOf: undefined → 'undefined'", () => {
  const session = run(`let x = Exact.typeOf(undefined);`);
  assertEquals(session.get(0, 'x'), 'undefined');
});

Deno.test("Exact.typeOf: null → 'object'", () => {
  const session = run(`let x = Exact.typeOf(null);`);
  assertEquals(session.get(0, 'x'), 'object');
});

Deno.test("Exact.typeOf: object → 'object'", () => {
  const session = run(`let x = Exact.typeOf({a: 1});`);
  assertEquals(session.get(0, 'x'), 'object');
});

Deno.test("Exact.typeOf: array → 'object'", () => {
  const session = run(`let x = Exact.typeOf([1, 2, 3]);`);
  assertEquals(session.get(0, 'x'), 'object');
});

Deno.test("Exact.typeOf: function → 'function'", () => {
  const session = run(`let x = Exact.typeOf((a) => a);`);
  assertEquals(session.get(0, 'x'), 'function');
});

// Surface-compat: `typeof` itself stays coarse.

Deno.test("typeof: integer literal still 'number'", () => {
  const session = run(`let x = typeof 5;`);
  assertEquals(session.get(0, 'x'), 'number');
});

Deno.test("typeof: Exact.rational(1n, 3n) still 'number'", () => {
  const session = run(`let x = typeof Exact.rational(1n, 3n);`);
  assertEquals(session.get(0, 'x'), 'number');
});

Deno.test("typeof: Exact.i still 'number'", () => {
  const session = run(`let x = typeof Exact.i;`);
  assertEquals(session.get(0, 'x'), 'number');
});

Deno.test("typeof: 3.5 still 'number'", () => {
  const session = run(`let x = typeof 3.5;`);
  assertEquals(session.get(0, 'x'), 'number');
});

Deno.test("typeof: 3n still 'bigint'", () => {
  const session = run(`let x = typeof 3n;`);
  assertEquals(session.get(0, 'x'), 'bigint');
});

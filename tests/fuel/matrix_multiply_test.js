/**
 * Ring 4 (4c) — Exact.Matrix.multiply: row-by-column product.
 *
 * Entries go through the uniform dispatch (numeric folds via Ring 1,
 * symbolic builds + simplifies). p = 0 inner dimension is legal: every
 * entry is an empty sum, so the result is the zero matrix.
 */

import { assertEquals, assertThrows } from "https://deno.land/std@0.208.0/assert/mod.ts";
import { parseAndSetup } from './test-helpers.js';
import { freshSession } from '../../src/host-owned-session.js';
import { UncaughtScriptError } from '../../src/runtime/errors.js';

function expectError(source) {
  const session = freshSession();
  parseAndSetup(session, source);
  assertThrows(() => session.run(0, 1000000), UncaughtScriptError);
}

function run(source) {
  const session = freshSession();
  parseAndSetup(session, source);
  const result = session.run(0, 10000000);
  if (result.status === 'error') {
    throw new Error(`Error: ${result.error?.message ?? JSON.stringify(result)}`);
  }
  return session;
}

const rational = (n, d = 1n) => ({ kind: 'rational', numerator: n, denominator: d });

Deno.test("multiply: 2x2 numeric product", () => {
  const session = run(`
    let m = Exact.Matrix.multiply(
      Exact.Matrix.make([[1n, 2n], [3n, 4n]]),
      Exact.Matrix.make([[5n, 6n], [7n, 8n]]));
  `);
  // [[1*5+2*7, 1*6+2*8], [3*5+4*7, 3*6+4*8]] = [[19, 22], [43, 50]]
  assertEquals(session.getExact(0, 'm').entries, [[19n, 22n], [43n, 50n]]);
});

Deno.test("multiply: rectangular shapes compose (2x3 · 3x1 -> 2x1)", () => {
  const session = run(`
    let m = Exact.Matrix.multiply(
      Exact.Matrix.make([[1n, 2n, 3n], [4n, 5n, 6n]]),
      Exact.Matrix.make([[1n], [1n], [1n]]));
  `);
  const value = session.getExact(0, 'm');
  assertEquals(value.rows, 2);
  assertEquals(value.columns, 1);
  assertEquals(value.entries, [[6n], [15n]]);
});

Deno.test("multiply: A · I equals A and I · A equals A (symbolic entries included)", () => {
  const session = run(`
    let a = Exact.Matrix.make([[Symbol.for('x'), 2n], [Exact.rational(1n, 3n), Symbol.for('y')]]);
    let i = Exact.Matrix.identity(2);
    let right = Exact.Matrix.equal(Exact.Matrix.multiply(a, i), a);
    let left = Exact.Matrix.equal(Exact.Matrix.multiply(i, a), a);
  `);
  assertEquals(session.get(0, 'right'), true);
  assertEquals(session.get(0, 'left'), true);
});

Deno.test("multiply: associativity on concrete values", () => {
  const session = run(`
    let a = Exact.Matrix.make([[1n, 2n], [3n, 4n]]);
    let b = Exact.Matrix.make([[0n, 1n], [1n, 1n]]);
    let c = Exact.Matrix.make([[2n, 0n], [1n, 2n]]);
    let result = Exact.Matrix.equal(
      Exact.Matrix.multiply(Exact.Matrix.multiply(a, b), c),
      Exact.Matrix.multiply(a, Exact.Matrix.multiply(b, c)));
  `);
  assertEquals(session.get(0, 'result'), true);
});

Deno.test("multiply: symbolic entries build simplified products", () => {
  const session = run(`
    let m = Exact.Matrix.multiply(
      Exact.Matrix.make([[Symbol.for('x')]]),
      Exact.Matrix.make([[Symbol.for('y')]]));
    let e = Exact.Matrix.get(m, 0, 0);
  `);
  const entry = session.getExact(0, 'e');
  assertEquals(entry.kind, 'expression');
  assertEquals(entry.head.description, 'Multiply');
});

Deno.test("multiply: symbolic sums collect (x·1 + 1·x -> 2x)", () => {
  const session = run(`
    let x = Symbol.for('x');
    let m = Exact.Matrix.multiply(
      Exact.Matrix.make([[x, 1n]]),
      Exact.Matrix.make([[1n], [x]]));
    let e = Exact.Matrix.get(m, 0, 0);
  `);
  const entry = session.getExact(0, 'e');
  assertEquals(entry.head.description, 'Multiply');
  assertEquals(entry.arguments[0], rational(2n));
  assertEquals(entry.arguments[1].description, 'x');
});

Deno.test("multiply: zero inner dimension yields the zero matrix", () => {
  const session = run(`
    let m = Exact.Matrix.multiply(Exact.Matrix.zero(2, 0), Exact.Matrix.zero(0, 3));
    let isZero = Exact.Matrix.equal(m, Exact.Matrix.zero(2, 3));
  `);
  assertEquals(session.get(0, 'isZero'), true);
});

Deno.test("multiply: inner-dimension mismatch throws", () => {
  expectError(`
    let m = Exact.Matrix.multiply(Exact.Matrix.zero(2, 3), Exact.Matrix.zero(2, 3));
  `);
});

Deno.test("multiply: non-Matrix operands throw", () => {
  expectError(`let m = Exact.Matrix.multiply(Exact.Matrix.zero(1, 1), 5);`);
  expectError(`let m = Exact.Matrix.multiply(5, Exact.Matrix.zero(1, 1));`);
});

Deno.test("multiply: complex entries", () => {
  const session = run(`
    let m = Exact.Matrix.multiply(
      Exact.Matrix.make([[Exact.i]]),
      Exact.Matrix.make([[Exact.i]]));
    let e = Exact.Matrix.get(m, 0, 0);
    let isMinusOne = Exact.equal(e, Exact.rational(-1n, 1n));
  `);
  assertEquals(session.get(0, 'isMinusOne'), true);
});

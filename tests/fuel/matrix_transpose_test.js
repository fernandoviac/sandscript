/**
 * Ring 4 (4b) — transpose and conjugateTranspose.
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
  const result = session.run(0, 1000000);
  if (result.status === 'error') {
    throw new Error(`Error: ${result.error?.message ?? JSON.stringify(result)}`);
  }
  return session;
}

const rational = (n, d = 1n) => ({ kind: 'rational', numerator: n, denominator: d });

// ---------- transpose ----------

Deno.test("transpose swaps rows and columns", () => {
  const session = run(`
    let m = Exact.Matrix.transpose(Exact.Matrix.make([[1n, 2n, 3n], [4n, 5n, 6n]]));
  `);
  const value = session.getExact(0, 'm');
  assertEquals(value.rows, 3);
  assertEquals(value.columns, 2);
  assertEquals(value.entries, [[1n, 4n], [2n, 5n], [3n, 6n]]);
});

Deno.test("transpose of a transpose is the original (structural)", () => {
  const session = run(`
    let a = Exact.Matrix.make([[1n, Symbol.for('x')], [Exact.rational(1n, 2n), 4n]]);
    let result = Exact.Matrix.equal(Exact.Matrix.transpose(Exact.Matrix.transpose(a)), a);
  `);
  assertEquals(session.get(0, 'result'), true);
});

Deno.test("transpose of zero-size shapes", () => {
  const session = run(`
    let a = Exact.Matrix.transpose(Exact.Matrix.zero(0, 5));
    let ar = Exact.Matrix.rows(a);
    let ac = Exact.Matrix.columns(a);
  `);
  assertEquals(session.get(0, 'ar'), 5);
  assertEquals(session.get(0, 'ac'), 0);
});

Deno.test("transpose of a row vector is a column vector", () => {
  const session = run(`
    let v = Exact.Matrix.transpose(Exact.Matrix.make([[1n, 2n, 3n]]));
  `);
  const value = session.getExact(0, 'v');
  assertEquals(value.rows, 3);
  assertEquals(value.columns, 1);
  assertEquals(value.entries, [[1n], [2n], [3n]]);
});

Deno.test("transpose on a non-Matrix throws", () => {
  expectError(`let m = Exact.Matrix.transpose([[1n]]);`);
});

// ---------- conjugateTranspose ----------

Deno.test("conjugateTranspose flips the imaginary component of Complex entries", () => {
  const session = run(`
    let m = Exact.Matrix.conjugateTranspose(Exact.Matrix.make([[Exact.i, Exact.complex(1n, 2n)]]));
    let a = Exact.Matrix.get(m, 0, 0);
    let b = Exact.Matrix.get(m, 1, 0);
    let r = Exact.Matrix.rows(m);
    let c = Exact.Matrix.columns(m);
  `);
  assertEquals(session.get(0, 'r'), 2);
  assertEquals(session.get(0, 'c'), 1);
  const a = session.getExact(0, 'a');
  assertEquals(a.kind, 'complex');
  assertEquals(a.real, rational(0n));
  assertEquals(a.imaginary, rational(-1n));
  const b = session.getExact(0, 'b');
  assertEquals(b.real, rational(1n));
  assertEquals(b.imaginary, rational(-2n));
});

Deno.test("conjugateTranspose is the identity on Rational/BigInt entries (plus transpose)", () => {
  const session = run(`
    let a = Exact.Matrix.make([[1n, 2n], [3n, 4n]]);
    let result = Exact.Matrix.equal(
      Exact.Matrix.conjugateTranspose(a),
      Exact.Matrix.transpose(a));
  `);
  assertEquals(session.get(0, 'result'), true);
});

Deno.test("conjugateTranspose wraps symbolic entries in Conjugate", () => {
  const session = run(`
    let m = Exact.Matrix.conjugateTranspose(Exact.Matrix.make([[Symbol.for('x')]]));
    let e = Exact.Matrix.get(m, 0, 0);
  `);
  const entry = session.getExact(0, 'e');
  assertEquals(entry.kind, 'expression');
  assertEquals(entry.head.description, 'Conjugate');
  assertEquals(entry.arguments[0].description, 'x');
});

Deno.test("conjugateTranspose twice is the identity (double-conjugate collapse)", () => {
  const session = run(`
    let a = Exact.Matrix.make([[Symbol.for('x'), Exact.i], [2n, Exact.rational(1n, 3n)]]);
    let result = Exact.Matrix.equal(
      Exact.Matrix.conjugateTranspose(Exact.Matrix.conjugateTranspose(a)),
      a);
  `);
  assertEquals(session.get(0, 'result'), true);
});

Deno.test("conjugateTranspose on a non-Matrix throws", () => {
  expectError(`let m = Exact.Matrix.conjugateTranspose(5);`);
});

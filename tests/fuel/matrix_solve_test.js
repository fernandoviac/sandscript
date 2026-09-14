/**
 * Ring 4 (4d) — Exact.Matrix.solve: A x = b via the shared engine.
 * b is an m × 1 Matrix or a plain Array of m entries. Mathematically
 * valid systems never throw: solve returns a tagged record —
 * { kind: "unique", solution }, { kind: "none" }, or
 * { kind: "family", particular, basis }.
 */

import { assertEquals, assertThrows } from "https://deno.land/std@0.208.0/assert/mod.ts";
import { parseAndSetup } from './test-helpers.js';
import { freshSession } from '../../src/host-owned-session.js';
import { UncaughtScriptError } from '../../src/runtime/errors.js';

function expectError(source) {
  const session = freshSession();
  parseAndSetup(session, source);
  assertThrows(() => session.run(0, 10000000), UncaughtScriptError);
}

function run(source) {
  const session = freshSession();
  parseAndSetup(session, source);
  const result = session.run(0, 50000000);
  if (result.status === 'error') {
    throw new Error(`Error: ${result.error?.message ?? JSON.stringify(result)}`);
  }
  return session;
}

const rational = (n, d = 1n) => ({ kind: 'rational', numerator: n, denominator: d });

Deno.test("solve: 2x2 with a column-Matrix b", () => {
  const session = run(`
    let result = Exact.Matrix.solve(
      Exact.Matrix.make([[1n, 2n], [3n, 4n]]),
      Exact.Matrix.make([[5n], [11n]]));
    let x = result.solution;
    let kind = result.kind;
  `);
  assertEquals(session.get(0, 'kind'), 'unique');
  const value = session.getExact(0, 'x');
  assertEquals(value.rows, 2);
  assertEquals(value.columns, 1);
  assertEquals(value.entries, [[rational(1n)], [rational(2n)]]);
});

Deno.test("solve: plain-Array b auto-converts", () => {
  const session = run(`
    let x = Exact.Matrix.solve(
      Exact.Matrix.make([[1n, 2n], [3n, 4n]]),
      [5n, 11n]).solution;
  `);
  assertEquals(session.getExact(0, 'x').entries, [[rational(1n)], [rational(2n)]]);
});

Deno.test("solve: 3x3 known solution", () => {
  const session = run(`
    let x = Exact.Matrix.solve(
      Exact.Matrix.make([[1n, 2n, 3n], [4n, 5n, 6n], [7n, 8n, 10n]]),
      [6n, 15n, 25n]).solution;
  `);
  // x = [1, 1, 1]
  assertEquals(session.getExact(0, 'x').entries,
    [[rational(1n)], [rational(1n)], [rational(1n)]]);
});

Deno.test("solve: solution verifies via multiply", () => {
  const session = run(`
    let a = Exact.Matrix.make([[2n, 1n], [1n, 3n]]);
    let b = Exact.Matrix.make([[3n], [5n]]);
    let x = Exact.Matrix.solve(a, b).solution;
    let ok = Exact.Matrix.equal(Exact.Matrix.multiply(a, x), b);
  `);
  assertEquals(session.get(0, 'ok'), true);
});

Deno.test("solve: rational solution", () => {
  const session = run(`
    let x = Exact.Matrix.solve(Exact.Matrix.make([[2n]]), [1n]).solution;
  `);
  assertEquals(session.getExact(0, 'x').entries, [[rational(1n, 2n)]]);
});

Deno.test("solve: overdetermined but consistent has a unique solution", () => {
  const session = run(`
    let x = Exact.Matrix.solve(
      Exact.Matrix.make([[1n, 0n], [0n, 1n], [1n, 1n]]),
      [1n, 2n, 3n]).solution;
  `);
  assertEquals(session.getExact(0, 'x').entries, [[rational(1n)], [rational(2n)]]);
});

Deno.test("solve: zero-pivot system needing a row swap", () => {
  const session = run(`
    let x = Exact.Matrix.solve(
      Exact.Matrix.make([[0n, 1n], [1n, 0n]]),
      [7n, 9n]).solution;
  `);
  assertEquals(session.getExact(0, 'x').entries, [[rational(9n)], [rational(7n)]]);
});

Deno.test("solve: inconsistent system returns { kind: 'none' }", () => {
  const session = run(`
    let result = Exact.Matrix.solve(
      Exact.Matrix.make([[1n, 0n], [1n, 0n]]),
      [1n, 2n]);
    let kind = result.kind;
  `);
  assertEquals(session.get(0, 'kind'), 'none');
});

Deno.test("solve: overdetermined inconsistent returns { kind: 'none' }", () => {
  const session = run(`
    let kind = Exact.Matrix.solve(
      Exact.Matrix.make([[1n, 0n], [0n, 1n], [1n, 1n]]),
      [1n, 2n, 4n]).kind;
  `);
  assertEquals(session.get(0, 'kind'), 'none');
});

Deno.test("solve: underdetermined system returns the solution family", () => {
  const session = run(`
    let result = Exact.Matrix.solve(Exact.Matrix.make([[1n, 1n]]), [2n]);
    let kind = result.kind;
    let particular0 = Exact.Matrix.get(result.particular, 0n, 0n);
    let particular1 = Exact.Matrix.get(result.particular, 1n, 0n);
    let basisLength = result.basis.length;
    let basis0 = Exact.Matrix.get(result.basis[0], 0n, 0n);
    let basis1 = Exact.Matrix.get(result.basis[0], 1n, 0n);
    let a = Exact.Matrix.make([[1n, 1n]]);
    let particularOk = Exact.Matrix.equal(
      Exact.Matrix.multiply(a, result.particular), Exact.Matrix.make([[2n]]));
    let basisOk = Exact.Matrix.equal(
      Exact.Matrix.multiply(a, result.basis[0]), Exact.Matrix.zero(1, 1));
    let rankDeficient = Exact.Matrix.solve(
      Exact.Matrix.make([[1n, 2n], [2n, 4n]]),
      [3n, 6n]).kind;
  `);
  assertEquals(session.get(0, 'kind'), 'family');
  assertEquals(session.getExact(0, 'particular0'), 2n);
  assertEquals(session.getExact(0, 'particular1'), rational(0n));
  assertEquals(session.get(0, 'basisLength'), 1);
  assertEquals(session.get(0, 'particularOk'), true);
  assertEquals(session.get(0, 'basisOk'), true);
  assertEquals(session.get(0, 'rankDeficient'), 'family');
});

Deno.test("solve: b shape/length mismatches throw", () => {
  expectError(`
    let x = Exact.Matrix.solve(Exact.Matrix.identity(2), [1n]);
  `);
  expectError(`
    let x = Exact.Matrix.solve(Exact.Matrix.identity(2), Exact.Matrix.zero(2, 2));
  `);
});

Deno.test("solve: invalid b entries throw", () => {
  expectError(`
    let x = Exact.Matrix.solve(Exact.Matrix.identity(2), [1n, 'two']);
  `);
});

Deno.test("solve: non-Matrix A throws", () => {
  expectError(`let x = Exact.Matrix.solve([[1n]], [1n]);`);
});

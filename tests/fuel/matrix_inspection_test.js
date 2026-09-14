/**
 * Ring 4 (4a) — Exact.Matrix inspection.
 *
 *   Exact.Matrix.rows(M) / columns(M) — plain integers
 *   Exact.Matrix.get(M, i, j)         — zero-indexed entry, RangeError OOB
 *   Exact.Matrix.isMatrix(v)          — type predicate on any value
 *   Exact.Matrix.isSquare(M)          — rows === columns
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

// ---------- rows / columns ----------

Deno.test("rows and columns report the shape", () => {
  const session = run(`
    let m = Exact.Matrix.zero(2, 3);
    let r = Exact.Matrix.rows(m);
    let c = Exact.Matrix.columns(m);
  `);
  assertEquals(session.get(0, 'r'), 2);
  assertEquals(session.get(0, 'c'), 3);
});

Deno.test("rows and columns on zero-size matrices", () => {
  const session = run(`
    let a = Exact.Matrix.zero(0, 5);
    let ar = Exact.Matrix.rows(a);
    let ac = Exact.Matrix.columns(a);
    let b = Exact.Matrix.make([]);
    let br = Exact.Matrix.rows(b);
    let bc = Exact.Matrix.columns(b);
  `);
  assertEquals(session.get(0, 'ar'), 0);
  assertEquals(session.get(0, 'ac'), 5);
  assertEquals(session.get(0, 'br'), 0);
  assertEquals(session.get(0, 'bc'), 0);
});

Deno.test("rows/columns on a non-Matrix throw TypeError", () => {
  expectError(`let r = Exact.Matrix.rows([1, 2]);`);
  expectError(`let c = Exact.Matrix.columns(5);`);
  expectError(`let r = Exact.Matrix.rows();`);
});

// ---------- get ----------

Deno.test("get returns entries zero-indexed in row-major order", () => {
  const session = run(`
    let m = Exact.Matrix.make([[1n, 2n], [3n, 4n]]);
    let a = Exact.Matrix.get(m, 0, 0);
    let b = Exact.Matrix.get(m, 0, 1);
    let c = Exact.Matrix.get(m, 1, 0);
    let d = Exact.Matrix.get(m, 1, 1);
  `);
  assertEquals(session.getExact(0, 'a'), 1n);
  assertEquals(session.getExact(0, 'b'), 2n);
  assertEquals(session.getExact(0, 'c'), 3n);
  assertEquals(session.getExact(0, 'd'), 4n);
});

Deno.test("get returns symbolic and nested-matrix entries intact", () => {
  const session = run(`
    let inner = Exact.Matrix.make([[9n]]);
    let m = Exact.Matrix.make([[Symbol.for('x'), inner]]);
    let s = Exact.Matrix.get(m, 0, 0);
    let n = Exact.Matrix.get(m, 0, 1);
  `);
  assertEquals(session.getExact(0, 's').description, 'x');
  assertEquals(session.getExact(0, 'n').kind, 'matrix');
  assertEquals(session.getExact(0, 'n').entries, [[9n]]);
});

Deno.test("get out of bounds throws RangeError", () => {
  expectError(`let m = Exact.Matrix.identity(2); let x = Exact.Matrix.get(m, 2, 0);`);
  expectError(`let m = Exact.Matrix.identity(2); let x = Exact.Matrix.get(m, 0, 2);`);
  expectError(`let m = Exact.Matrix.identity(2); let x = Exact.Matrix.get(m, -1, 0);`);
  expectError(`let m = Exact.Matrix.make([]); let x = Exact.Matrix.get(m, 0, 0);`);
});

Deno.test("get rejects fractional and missing indices", () => {
  expectError(`let m = Exact.Matrix.identity(2); let x = Exact.Matrix.get(m, 0.5, 0);`);
  expectError(`let m = Exact.Matrix.identity(2); let x = Exact.Matrix.get(m, 0);`);
});

Deno.test("get on a non-Matrix throws TypeError", () => {
  expectError(`let x = Exact.Matrix.get([[1]], 0, 0);`);
});

// ---------- isMatrix / isSquare ----------

Deno.test("isMatrix distinguishes matrices from everything else", () => {
  const session = run(`
    let yes = Exact.Matrix.isMatrix(Exact.Matrix.identity(2));
    let zeroSize = Exact.Matrix.isMatrix(Exact.Matrix.make([]));
    let arr = Exact.Matrix.isMatrix([[1n]]);
    let num = Exact.Matrix.isMatrix(5);
    let sym = Exact.Matrix.isMatrix(Symbol.for('x'));
    let expr = Exact.Matrix.isMatrix(Exact.Expression.add(1n, 2n));
    let nul = Exact.Matrix.isMatrix(null);
    let missing = Exact.Matrix.isMatrix();
  `);
  assertEquals(session.get(0, 'yes'), true);
  assertEquals(session.get(0, 'zeroSize'), true);
  assertEquals(session.get(0, 'arr'), false);
  assertEquals(session.get(0, 'num'), false);
  assertEquals(session.get(0, 'sym'), false);
  assertEquals(session.get(0, 'expr'), false);
  assertEquals(session.get(0, 'nul'), false);
  assertEquals(session.get(0, 'missing'), false);
});

Deno.test("isSquare compares rows to columns", () => {
  const session = run(`
    let square = Exact.Matrix.isSquare(Exact.Matrix.identity(3));
    let rect = Exact.Matrix.isSquare(Exact.Matrix.zero(2, 3));
    let empty = Exact.Matrix.isSquare(Exact.Matrix.make([]));
    let zeroRow = Exact.Matrix.isSquare(Exact.Matrix.zero(0, 5));
  `);
  assertEquals(session.get(0, 'square'), true);
  assertEquals(session.get(0, 'rect'), false);
  assertEquals(session.get(0, 'empty'), true);
  assertEquals(session.get(0, 'zeroRow'), false);
});

Deno.test("isSquare on a non-Matrix throws TypeError", () => {
  expectError(`let x = Exact.Matrix.isSquare(5);`);
});

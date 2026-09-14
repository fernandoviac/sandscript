/**
 * Ring 4 (4a) — Exact.Matrix construction.
 *
 * Tests the construction API:
 *   Exact.Matrix.make(rowsArray)       — general-purpose, Array of row Arrays
 *   Exact.Matrix.identity(n)           — n × n, Rational 1 diagonal
 *   Exact.Matrix.zero(rows, columns)   — all Rational 0
 *   Exact.Matrix.diagonal(valuesArray) — square, values on the diagonal
 *   Exact.Matrix.fromColumns(columnsArray)
 *
 * Also tests:
 *   - Entry-universe validation (Rational/Complex/BigInt/Symbol/Expression/
 *     Matrix only; Float/String/Boolean/Array/Object/null/undefined rejected).
 *   - Zero-size matrices (0×0, 0×n, n×0) are legal.
 *   - typeof is 'object', Exact.typeOf is 'matrix'.
 *   - Arithmetic operators on Matrix throw TypeError.
 *   - Readback shape { kind: 'matrix', rows, columns, entries } (nested 2D).
 *   - GC survival (matrix + entries traced and compacted).
 *   - Matrix as a legal Expression argument (Ring 2 universe widening).
 */

import { assertEquals, assert, assertThrows } from "https://deno.land/std@0.208.0/assert/mod.ts";
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

const rational = (n) => ({ kind: 'rational', numerator: n, denominator: 1n });

// ---------- make ----------

Deno.test("Matrix.make builds a 2x2 from BigInt rows", () => {
  const session = run(`let m = Exact.Matrix.make([[1n, 2n], [3n, 4n]]);`);
  const value = session.getExact(0, 'm');
  assertEquals(value.kind, 'matrix');
  assertEquals(value.rows, 2);
  assertEquals(value.columns, 2);
  assertEquals(value.entries, [[1n, 2n], [3n, 4n]]);
});

Deno.test("Matrix.make with plain integer entries stores Rationals", () => {
  const session = run(`let m = Exact.Matrix.make([[1, 2], [3, 4]]);`);
  const value = session.getExact(0, 'm');
  assertEquals(value.entries, [
    [rational(1n), rational(2n)],
    [rational(3n), rational(4n)],
  ]);
});

Deno.test("Matrix.make accepts Symbol and Expression entries", () => {
  const session = run(`
    let x = Symbol.for('x');
    let e = Exact.Expression.add(x, 1n);
    let m = Exact.Matrix.make([[x, e], [1n, Exact.rational(1n, 2n)]]);
  `);
  const value = session.getExact(0, 'm');
  assertEquals(value.rows, 2);
  assertEquals(value.entries[0][0].kind, 'symbol');
  assertEquals(value.entries[0][0].description, 'x');
  assertEquals(value.entries[0][1].kind, 'expression');
  assertEquals(value.entries[0][1].head.description, 'Add');
  assertEquals(value.entries[1][1], { kind: 'rational', numerator: 1n, denominator: 2n });
});

Deno.test("Matrix.make accepts Complex entries", () => {
  const session = run(`let m = Exact.Matrix.make([[Exact.i]]);`);
  const value = session.getExact(0, 'm');
  assertEquals(value.entries[0][0].kind, 'complex');
});

Deno.test("Matrix.make accepts nested Matrix entries (block matrix)", () => {
  const session = run(`
    let inner = Exact.Matrix.make([[1n]]);
    let m = Exact.Matrix.make([[inner, 2n]]);
  `);
  const value = session.getExact(0, 'm');
  assertEquals(value.rows, 1);
  assertEquals(value.columns, 2);
  assertEquals(value.entries[0][0].kind, 'matrix');
  assertEquals(value.entries[0][0].entries, [[1n]]);
  assertEquals(value.entries[0][1], 2n);
});

Deno.test("Matrix.make([]) builds the 0x0 matrix", () => {
  const session = run(`let m = Exact.Matrix.make([]);`);
  const value = session.getExact(0, 'm');
  assertEquals(value.kind, 'matrix');
  assertEquals(value.rows, 0);
  assertEquals(value.columns, 0);
  assertEquals(value.entries, []);
});

Deno.test("Matrix.make([[], []]) builds a 2x0 matrix", () => {
  const session = run(`let m = Exact.Matrix.make([[], []]);`);
  const value = session.getExact(0, 'm');
  assertEquals(value.rows, 2);
  assertEquals(value.columns, 0);
  assertEquals(value.entries, [[], []]);
});

// ---------- make validation ----------

Deno.test("Matrix.make rejects a non-Array argument", () => {
  expectError(`let m = Exact.Matrix.make(5);`);
});

Deno.test("Matrix.make rejects a row that is not an Array", () => {
  expectError(`let m = Exact.Matrix.make([1n]);`);
});

Deno.test("Matrix.make rejects ragged rows", () => {
  expectError(`let m = Exact.Matrix.make([[1n, 2n], [3n]]);`);
});

Deno.test("Matrix.make rejects Float entries", () => {
  expectError(`let m = Exact.Matrix.make([[1.5]]);`);
});

Deno.test("Matrix.make rejects String entries", () => {
  expectError(`let m = Exact.Matrix.make([['x']]);`);
});

Deno.test("Matrix.make rejects Boolean entries", () => {
  expectError(`let m = Exact.Matrix.make([[true]]);`);
});

Deno.test("Matrix.make rejects null entries", () => {
  expectError(`let m = Exact.Matrix.make([[null]]);`);
});

Deno.test("Matrix.make rejects plain Array entries", () => {
  expectError(`let m = Exact.Matrix.make([[[1n]]]);`);
});

Deno.test("Matrix.make rejects Object entries", () => {
  expectError(`let m = Exact.Matrix.make([[{ a: 1 }]]);`);
});

Deno.test("Matrix.make error message names the entry universe", () => {
  const session = freshSession();
  parseAndSetup(session, `let m = Exact.Matrix.make([[1.5]]);`);
  try {
    session.run(0, 1000000);
    assert(false, 'expected a throw');
  } catch (error) {
    assert(error.message.includes('entries must be'), `got: ${error.message}`);
  }
});

// ---------- identity / zero / diagonal ----------

Deno.test("Matrix.identity(3) is 3x3 with Rational 1 diagonal", () => {
  const session = run(`let m = Exact.Matrix.identity(3);`);
  const value = session.getExact(0, 'm');
  assertEquals(value.rows, 3);
  assertEquals(value.columns, 3);
  for (let i = 0; i < 3; i++) {
    for (let j = 0; j < 3; j++) {
      assertEquals(value.entries[i][j], rational(i === j ? 1n : 0n));
    }
  }
});

Deno.test("Matrix.identity(0) is the 0x0 matrix", () => {
  const session = run(`let m = Exact.Matrix.identity(0);`);
  const value = session.getExact(0, 'm');
  assertEquals(value.rows, 0);
  assertEquals(value.columns, 0);
});

Deno.test("Matrix.identity accepts a BigInt dimension", () => {
  const session = run(`let m = Exact.Matrix.identity(2n);`);
  assertEquals(session.getExact(0, 'm').rows, 2);
});

Deno.test("Matrix.zero(2, 3) is all Rational 0", () => {
  const session = run(`let m = Exact.Matrix.zero(2, 3);`);
  const value = session.getExact(0, 'm');
  assertEquals(value.rows, 2);
  assertEquals(value.columns, 3);
  assertEquals(value.entries, [
    [rational(0n), rational(0n), rational(0n)],
    [rational(0n), rational(0n), rational(0n)],
  ]);
});

Deno.test("Matrix.zero allows zero-size shapes", () => {
  const session = run(`
    let a = Exact.Matrix.zero(0, 0);
    let b = Exact.Matrix.zero(0, 5);
    let c = Exact.Matrix.zero(5, 0);
  `);
  assertEquals(session.getExact(0, 'a'), { kind: 'matrix', rows: 0, columns: 0, entries: [] });
  assertEquals(session.getExact(0, 'b').columns, 5);
  assertEquals(session.getExact(0, 'c').rows, 5);
  assertEquals(session.getExact(0, 'c').entries, [[], [], [], [], []]);
});

Deno.test("Matrix.diagonal places values on the diagonal", () => {
  const session = run(`let m = Exact.Matrix.diagonal([2n, Symbol.for('x')]);`);
  const value = session.getExact(0, 'm');
  assertEquals(value.rows, 2);
  assertEquals(value.columns, 2);
  assertEquals(value.entries[0][0], 2n);
  assertEquals(value.entries[0][1], rational(0n));
  assertEquals(value.entries[1][0], rational(0n));
  assertEquals(value.entries[1][1].description, 'x');
});

Deno.test("Matrix.diagonal([]) is the 0x0 matrix", () => {
  const session = run(`let m = Exact.Matrix.diagonal([]);`);
  assertEquals(session.getExact(0, 'm'), { kind: 'matrix', rows: 0, columns: 0, entries: [] });
});

Deno.test("Matrix.diagonal validates entry types", () => {
  expectError(`let m = Exact.Matrix.diagonal([1.5]);`);
});

Deno.test("dimension constructors reject negatives, fractions, and non-numbers", () => {
  expectError(`let m = Exact.Matrix.identity(-1);`);
  expectError(`let m = Exact.Matrix.identity(2.5);`);
  expectError(`let m = Exact.Matrix.identity('3');`);
  expectError(`let m = Exact.Matrix.zero(2, -1);`);
  expectError(`let m = Exact.Matrix.zero();`);
});

// ---------- fromColumns ----------

Deno.test("Matrix.fromColumns transposes column vectors into rows", () => {
  const session = run(`let m = Exact.Matrix.fromColumns([[1n, 2n], [3n, 4n]]);`);
  const value = session.getExact(0, 'm');
  assertEquals(value.rows, 2);
  assertEquals(value.columns, 2);
  // Column 0 is [1, 2], column 1 is [3, 4] → rows [[1, 3], [2, 4]].
  assertEquals(value.entries, [[1n, 3n], [2n, 4n]]);
});

Deno.test("Matrix.fromColumns([]) is the 0x0 matrix", () => {
  const session = run(`let m = Exact.Matrix.fromColumns([]);`);
  assertEquals(session.getExact(0, 'm'), { kind: 'matrix', rows: 0, columns: 0, entries: [] });
});

Deno.test("Matrix.fromColumns rejects ragged columns", () => {
  expectError(`let m = Exact.Matrix.fromColumns([[1n, 2n], [3n]]);`);
});

Deno.test("Matrix.fromColumns validates entry types", () => {
  expectError(`let m = Exact.Matrix.fromColumns([['x']]);`);
});

// ---------- typeof / Exact.typeOf / operators ----------

Deno.test("typeof a Matrix is 'object'", () => {
  const session = run(`let t = typeof Exact.Matrix.identity(2);`);
  assertEquals(session.get(0, 't'), 'object');
});

Deno.test("Exact.typeOf a Matrix is 'matrix'", () => {
  const session = run(`let t = Exact.typeOf(Exact.Matrix.identity(2));`);
  assertEquals(session.get(0, 't'), 'matrix');
});

Deno.test("Arithmetic operators on Matrix throw TypeError", () => {
  expectError(`let m = Exact.Matrix.identity(2); let x = m + m;`);
  expectError(`let m = Exact.Matrix.identity(2); let x = m * 2;`);
  expectError(`let m = Exact.Matrix.identity(2); let x = -m;`);
  expectError(`let m = Exact.Matrix.identity(2); let x = 1 + m;`);
});

// ---------- GC ----------

Deno.test("Matrix survives allocation pressure and collection", () => {
  const session = run(`
    let kept = Exact.Matrix.make([[1n, Symbol.for('x')], [Exact.rational(1n, 3n), 4n]]);
    let acc = Exact.rational(0n, 1n);
    for (let i = 0; i < 200; i = i + 1) {
      acc = acc + Exact.rational(1n, 7n);
    }
    let final = kept;
  `);
  const value = session.getExact(0, 'final');
  assertEquals(value.kind, 'matrix');
  assertEquals(value.entries[0][0], 1n);
  assertEquals(value.entries[0][1].description, 'x');
  assertEquals(value.entries[1][0], { kind: 'rational', numerator: 1n, denominator: 3n });
  assertEquals(value.entries[1][1], 4n);
});

Deno.test("Matrix survives an explicit gc + compaction", () => {
  const session = run(`
    let junk = [];
    for (let i = 0; i < 20; i = i + 1) { junk.push(Exact.rational(10n ** 20n, 7n)); }
    junk = null;
    let m = Exact.Matrix.make([[Exact.Expression.add(Symbol.for('y'), 2n)]]);
  `);
  session.gc();
  const value = session.getExact(0, 'm');
  assertEquals(value.kind, 'matrix');
  assertEquals(value.entries[0][0].kind, 'expression');
  assertEquals(value.entries[0][0].head.description, 'Add');
});

Deno.test("nested Matrix entries survive gc", () => {
  const session = run(`
    let inner = Exact.Matrix.make([[7n]]);
    let outer = Exact.Matrix.make([[inner]]);
    inner = null;
  `);
  session.gc();
  const value = session.getExact(0, 'outer');
  assertEquals(value.entries[0][0].kind, 'matrix');
  assertEquals(value.entries[0][0].entries, [[7n]]);
});

// ---------- Ring 2 widening: Matrix as Expression argument ----------

Deno.test("Matrix is a legal Expression argument", () => {
  const session = run(`
    let m = Exact.Matrix.identity(2);
    let e = Exact.Expression.make(Exact.Expression.Add, [m, m]);
  `);
  const value = session.getExact(0, 'e');
  assertEquals(value.kind, 'expression');
  assertEquals(value.head.description, 'Add');
  assertEquals(value.arguments.length, 2);
  assertEquals(value.arguments[0].kind, 'matrix');
  assertEquals(value.arguments[0].rows, 2);
});

Deno.test("Expression sugar constructors accept Matrix operands", () => {
  const session = run(`
    let m = Exact.Matrix.identity(2);
    let e = Exact.Expression.multiply(m, Symbol.for('k'));
  `);
  const value = session.getExact(0, 'e');
  assertEquals(value.head.description, 'Multiply');
  assertEquals(value.arguments[0].kind, 'matrix');
  assertEquals(value.arguments[1].description, 'k');
});

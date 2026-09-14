/**
 * Ring 4 (4c) — trace and determinant.
 *
 * determinant runs fraction-free Bareiss elimination uniformly for
 * every n >= 1 (0x0 is the empty product 1). Symbolic entries are
 * valid pivots; the exact division by the previous pivot rides
 * Ring 3d's Divide cancellation.
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

// ---------- trace ----------

Deno.test("trace: numeric diagonal sums", () => {
  const session = run(`
    let t = Exact.Matrix.trace(Exact.Matrix.make([[1n, 99n], [99n, 2n]]));
  `);
  assertEquals(session.getExact(0, 't'), 3n);
});

Deno.test("trace: identity(n) is n", () => {
  const session = run(`
    let t = Exact.Matrix.trace(Exact.Matrix.identity(5));
  `);
  assertEquals(session.getExact(0, 't'), rational(5n));
});

Deno.test("trace: 0x0 matrix is 0 (empty sum)", () => {
  const session = run(`
    let t = Exact.Matrix.trace(Exact.Matrix.make([]));
  `);
  assertEquals(session.getExact(0, 't'), rational(0n));
});

Deno.test("trace: symbolic diagonal builds an Expression", () => {
  const session = run(`
    let t = Exact.Matrix.trace(Exact.Matrix.diagonal([Symbol.for('x'), Symbol.for('y')]));
  `);
  const value = session.getExact(0, 't');
  assertEquals(value.kind, 'expression');
  assertEquals(value.head.description, 'Add');
});

Deno.test("trace: non-square throws", () => {
  expectError(`let t = Exact.Matrix.trace(Exact.Matrix.zero(2, 3));`);
});

Deno.test("trace: non-Matrix throws", () => {
  expectError(`let t = Exact.Matrix.trace(7);`);
});

// ---------- determinant: numeric, every size 0-5 ----------

Deno.test("determinant: 0x0 is 1 (empty product)", () => {
  const session = run(`let d = Exact.Matrix.determinant(Exact.Matrix.make([]));`);
  assertEquals(session.getExact(0, 'd'), rational(1n));
});

Deno.test("determinant: 1x1 is the entry", () => {
  const session = run(`
    let d = Exact.Matrix.determinant(Exact.Matrix.make([[7n]]));
    let s = Exact.Matrix.determinant(Exact.Matrix.make([[Symbol.for('x')]]));
  `);
  assertEquals(session.getExact(0, 'd'), 7n);
  assertEquals(session.getExact(0, 's').description, 'x');
});

Deno.test("determinant: 2x2 numeric (ad - bc)", () => {
  const session = run(`
    let d = Exact.Matrix.determinant(Exact.Matrix.make([[1n, 2n], [3n, 4n]]));
    let isMinusTwo = Exact.equal(d, Exact.rational(-2n, 1n));
  `);
  assertEquals(session.get(0, 'isMinusTwo'), true);
});

Deno.test("determinant: 3x3 numeric", () => {
  const session = run(`
    let d = Exact.Matrix.determinant(Exact.Matrix.make([
      [1n, 2n, 3n], [4n, 5n, 6n], [7n, 8n, 10n]]));
    let ok = Exact.equal(d, Exact.rational(-3n, 1n));
  `);
  assertEquals(session.get(0, 'ok'), true);
});

Deno.test("determinant: 4x4 tridiagonal (Bareiss path)", () => {
  const session = run(`
    let d = Exact.Matrix.determinant(Exact.Matrix.make([
      [2n, 1n, 0n, 0n],
      [1n, 2n, 1n, 0n],
      [0n, 1n, 2n, 1n],
      [0n, 0n, 1n, 2n]]));
    let ok = Exact.equal(d, Exact.rational(5n, 1n));
  `);
  assertEquals(session.get(0, 'ok'), true);
});

Deno.test("determinant: 5x5 diagonal is the product of the diagonal", () => {
  const session = run(`
    let d = Exact.Matrix.determinant(Exact.Matrix.diagonal([1n, 2n, 3n, 4n, 5n]));
    let ok = Exact.equal(d, Exact.rational(120n, 1n));
  `);
  assertEquals(session.get(0, 'ok'), true);
});

Deno.test("determinant: identity at several sizes is 1", () => {
  const session = run(`
    let ok = true;
    for (let n = 0; n < 6; n = n + 1) {
      let d = Exact.Matrix.determinant(Exact.Matrix.identity(n));
      ok = ok && Exact.equal(d, Exact.rational(1n, 1n));
    }
  `);
  assertEquals(session.get(0, 'ok'), true);
});

Deno.test("determinant: rational entries stay exact", () => {
  const session = run(`
    let d = Exact.Matrix.determinant(Exact.Matrix.make([
      [Exact.rational(1n, 2n), Exact.rational(1n, 3n)],
      [Exact.rational(1n, 4n), Exact.rational(1n, 5n)]]));
  `);
  // 1/10 - 1/12 = 1/60
  assertEquals(session.getExact(0, 'd'), rational(1n, 60n));
});

Deno.test("determinant: complex entries", () => {
  const session = run(`
    let d = Exact.Matrix.determinant(Exact.Matrix.diagonal([Exact.i, Exact.i]));
    let ok = Exact.equal(d, Exact.rational(-1n, 1n));
  `);
  assertEquals(session.get(0, 'ok'), true);
});

// ---------- determinant: pivoting and singularity ----------

Deno.test("determinant: zero pivot forces a row swap (sign flips)", () => {
  const session = run(`
    let d = Exact.Matrix.determinant(Exact.Matrix.make([[0n, 1n], [1n, 0n]]));
    let ok = Exact.equal(d, Exact.rational(-1n, 1n));
  `);
  assertEquals(session.get(0, 'ok'), true);
});

Deno.test("determinant: even permutation keeps the sign", () => {
  const session = run(`
    let d = Exact.Matrix.determinant(Exact.Matrix.make([
      [0n, 1n, 0n], [0n, 0n, 1n], [1n, 0n, 0n]]));
    let ok = Exact.equal(d, Exact.rational(1n, 1n));
  `);
  assertEquals(session.get(0, 'ok'), true);
});

Deno.test("determinant: singular matrices give exactly zero", () => {
  const session = run(`
    let a = Exact.Matrix.determinant(Exact.Matrix.make([[1n, 2n], [2n, 4n]]));
    let aZero = Exact.equal(a, Exact.rational(0n, 1n));
    let b = Exact.Matrix.determinant(Exact.Matrix.make([
      [1n, 2n, 3n], [4n, 5n, 6n], [7n, 8n, 9n]]));
    let bZero = Exact.equal(b, Exact.rational(0n, 1n));
  `);
  assertEquals(session.get(0, 'aZero'), true);
  assertEquals(session.get(0, 'bZero'), true);
});

Deno.test("determinant: all-zero pivot column short-circuits to zero", () => {
  const session = run(`
    let d = Exact.Matrix.determinant(Exact.Matrix.make([
      [0n, Symbol.for('x')], [0n, Symbol.for('y')]]));
    let ok = Exact.equal(d, Exact.rational(0n, 1n));
  `);
  assertEquals(session.get(0, 'ok'), true);
});

// ---------- determinant: symbolic ----------

Deno.test("determinant: symbolic 2x2 evaluates to ad - bc under substitution", () => {
  const session = run(`
    let a = Symbol.for('a'); let b = Symbol.for('b');
    let c = Symbol.for('c'); let d = Symbol.for('d');
    let det = Exact.Matrix.determinant(Exact.Matrix.make([[a, b], [c, d]]));
    let value = det;
    value = Exact.Expression.substitute(value, a, 1n);
    value = Exact.Expression.substitute(value, b, 2n);
    value = Exact.Expression.substitute(value, c, 3n);
    value = Exact.Expression.substitute(value, d, 4n);
    let ok = Exact.equal(Exact.Expression.simplify(value), Exact.rational(-2n, 1n));
  `);
  assertEquals(session.get(0, 'ok'), true);
});

Deno.test("determinant: symbolic pivot is valid (x^2 - 1 shape)", () => {
  const session = run(`
    let x = Symbol.for('x');
    let det = Exact.Matrix.determinant(Exact.Matrix.make([[x, 1n], [1n, x]]));
    let atThree = Exact.Expression.simplify(Exact.Expression.substitute(det, x, 3n));
    let ok = Exact.equal(atThree, Exact.rational(8n, 1n));
  `);
  assertEquals(session.get(0, 'ok'), true);
});

Deno.test("determinant: symbolic 3x3 with exact Bareiss division", () => {
  const session = run(`
    let x = Symbol.for('x');
    let det = Exact.Matrix.determinant(Exact.Matrix.make([
      [x, 1n, 0n],
      [1n, x, 1n],
      [0n, 1n, x]]));
    let atTwo = Exact.Expression.simplify(Exact.Expression.substitute(det, x, 2n));
    let ok = Exact.equal(atTwo, Exact.rational(4n, 1n));
  `);
  // det = x^3 - 2x; at x = 2: 8 - 4 = 4.
  assertEquals(session.get(0, 'ok'), true);
});

Deno.test("determinant: mixed numeric/symbolic matrix", () => {
  const session = run(`
    let x = Symbol.for('x');
    let det = Exact.Matrix.determinant(Exact.Matrix.make([
      [2n, x], [3n, 5n]]));
    let atSeven = Exact.Expression.simplify(Exact.Expression.substitute(det, x, 7n));
    let ok = Exact.equal(atSeven, Exact.rational(-11n, 1n));
  `);
  assertEquals(session.get(0, 'ok'), true);
});

// ---------- determinant: errors ----------

Deno.test("determinant: non-square throws", () => {
  expectError(`let d = Exact.Matrix.determinant(Exact.Matrix.zero(2, 3));`);
});

Deno.test("determinant: non-Matrix throws", () => {
  expectError(`let d = Exact.Matrix.determinant([[1n]]);`);
});

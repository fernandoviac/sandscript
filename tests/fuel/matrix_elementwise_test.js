/**
 * Ring 4 (4b) — element-wise arithmetic: add / subtract / scale / negate.
 *
 * Per-entry ops follow the uniform dispatch rule (plan decision 10):
 * numeric × numeric folds via Ring 1; everything else — Symbol,
 * Expression, or Matrix entries — builds a Ring 2 Expression and runs
 * simplify. Matrix-valued entries yield symbolic entries (lazy block
 * algebra), never recursion and never an error.
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

const rational = (n, d = 1n) => ({ kind: 'rational', numerator: n, denominator: d });

// ---------- add ----------

Deno.test("add: BigInt entries fold to BigInt", () => {
  const session = run(`
    let m = Exact.Matrix.add(
      Exact.Matrix.make([[1n, 2n], [3n, 4n]]),
      Exact.Matrix.make([[10n, 20n], [30n, 40n]]));
  `);
  assertEquals(session.getExact(0, 'm').entries, [[11n, 22n], [33n, 44n]]);
});

Deno.test("add: mixed numeric entries fold with Ring 1 promotion", () => {
  const session = run(`
    let m = Exact.Matrix.add(
      Exact.Matrix.make([[Exact.rational(1n, 2n), 1n]]),
      Exact.Matrix.make([[Exact.rational(1n, 3n), Exact.i]]));
    let a = Exact.Matrix.get(m, 0, 0);
    let b = Exact.Matrix.get(m, 0, 1);
  `);
  assertEquals(session.getExact(0, 'a'), rational(5n, 6n));
  const complexSum = session.getExact(0, 'b');
  assertEquals(complexSum.kind, 'complex');
  assertEquals(complexSum.real, rational(1n));
  assertEquals(complexSum.imaginary, rational(1n));
});

Deno.test("add: symbolic entries build simplified Expressions", () => {
  const session = run(`
    let x = Symbol.for('x');
    let y = Symbol.for('y');
    let m = Exact.Matrix.add(Exact.Matrix.make([[x]]), Exact.Matrix.make([[y]]));
    let e = Exact.Matrix.get(m, 0, 0);
  `);
  const entry = session.getExact(0, 'e');
  assertEquals(entry.kind, 'expression');
  assertEquals(entry.head.description, 'Add');
});

Deno.test("add: like symbolic entries collect (x + x -> 2x)", () => {
  const session = run(`
    let x = Symbol.for('x');
    let m = Exact.Matrix.add(Exact.Matrix.make([[x]]), Exact.Matrix.make([[x]]));
    let e = Exact.Matrix.get(m, 0, 0);
  `);
  const entry = session.getExact(0, 'e');
  assertEquals(entry.kind, 'expression');
  assertEquals(entry.head.description, 'Multiply');
  assertEquals(entry.arguments[0], rational(2n));
  assertEquals(entry.arguments[1].description, 'x');
});

Deno.test("add: numeric-symbolic mix folds where possible", () => {
  const session = run(`
    let m = Exact.Matrix.add(
      Exact.Matrix.make([[2n, Symbol.for('x')]]),
      Exact.Matrix.make([[3n, 5n]]));
    let a = Exact.Matrix.get(m, 0, 0);
    let b = Exact.Matrix.get(m, 0, 1);
  `);
  assertEquals(session.getExact(0, 'a'), 5n);
  const symbolic = session.getExact(0, 'b');
  assertEquals(symbolic.kind, 'expression');
  assertEquals(symbolic.head.description, 'Add');
});

Deno.test("add: Matrix-valued entries go symbolic (lazy block algebra)", () => {
  const session = run(`
    let inner = Exact.Matrix.make([[1n]]);
    let a = Exact.Matrix.make([[inner]]);
    let b = Exact.Matrix.make([[inner]]);
    let m = Exact.Matrix.add(a, b);
    let e = Exact.Matrix.get(m, 0, 0);
  `);
  const entry = session.getExact(0, 'e');
  // Two structurally-equal Matrix atoms collect like any atom: 2 * M.
  assertEquals(entry.kind, 'expression');
  assertEquals(entry.head.description, 'Multiply');
  assertEquals(entry.arguments[0], rational(2n));
  assertEquals(entry.arguments[1].kind, 'matrix');
});

Deno.test("add: zero-size matrices", () => {
  const session = run(`
    let m = Exact.Matrix.add(Exact.Matrix.zero(0, 5), Exact.Matrix.zero(0, 5));
  `);
  assertEquals(session.getExact(0, 'm'), { kind: 'matrix', rows: 0, columns: 5, entries: [] });
});

Deno.test("add: shape mismatch throws", () => {
  expectError(`
    let m = Exact.Matrix.add(Exact.Matrix.zero(2, 3), Exact.Matrix.zero(3, 2));
  `);
});

Deno.test("add: non-Matrix operands throw", () => {
  expectError(`let m = Exact.Matrix.add(Exact.Matrix.zero(1, 1), 5);`);
  expectError(`let m = Exact.Matrix.add([[1n]], Exact.Matrix.zero(1, 1));`);
});

// ---------- subtract ----------

Deno.test("subtract: numeric entries", () => {
  const session = run(`
    let m = Exact.Matrix.subtract(
      Exact.Matrix.make([[10n, Exact.rational(1n, 2n)]]),
      Exact.Matrix.make([[4n, Exact.rational(1n, 3n)]]));
    let a = Exact.Matrix.get(m, 0, 0);
    let b = Exact.Matrix.get(m, 0, 1);
  `);
  // BigInt - BigInt routes through the Negate desugar (Ring 2/3
  // canonical): the result is an integer Rational, same as
  // simplify(Subtract(10n, 4n)).
  assertEquals(session.getExact(0, 'a'), rational(6n));
  assertEquals(session.getExact(0, 'b'), rational(1n, 6n));
});

Deno.test("subtract: x - x collapses to zero", () => {
  const session = run(`
    let x = Symbol.for('x');
    let m = Exact.Matrix.subtract(Exact.Matrix.make([[x]]), Exact.Matrix.make([[x]]));
    let e = Exact.Matrix.get(m, 0, 0);
  `);
  assertEquals(session.getExact(0, 'e'), rational(0n));
});

Deno.test("subtract: shape mismatch throws", () => {
  expectError(`
    let m = Exact.Matrix.subtract(Exact.Matrix.zero(1, 2), Exact.Matrix.zero(2, 1));
  `);
});

// ---------- scale ----------

Deno.test("scale: numeric scalar over numeric entries", () => {
  const session = run(`
    let m = Exact.Matrix.scale(3n, Exact.Matrix.make([[1n, 2n], [3n, 4n]]));
  `);
  assertEquals(session.getExact(0, 'm').entries, [[3n, 6n], [9n, 12n]]);
});

Deno.test("scale: symbolic scalar builds Multiply entries", () => {
  const session = run(`
    let k = Symbol.for('k');
    let m = Exact.Matrix.scale(k, Exact.Matrix.make([[2n]]));
    let e = Exact.Matrix.get(m, 0, 0);
  `);
  const entry = session.getExact(0, 'e');
  assertEquals(entry.kind, 'expression');
  assertEquals(entry.head.description, 'Multiply');
  // The BigInt entry stays a BigInt coefficient (no Rational mixing).
  assertEquals(entry.arguments[0], 2n);
  assertEquals(entry.arguments[1].description, 'k');
});

Deno.test("scale: 1x1 Matrix scalar unwraps to its entry", () => {
  const session = run(`
    let k = Exact.Matrix.make([[5n]]);
    let m = Exact.Matrix.scale(k, Exact.Matrix.make([[2n, 3n]]));
  `);
  assertEquals(session.getExact(0, 'm').entries, [[10n, 15n]]);
});

Deno.test("scale: non-1x1 Matrix scalar throws", () => {
  expectError(`
    let m = Exact.Matrix.scale(Exact.Matrix.zero(2, 2), Exact.Matrix.zero(2, 2));
  `);
});

Deno.test("scale: disallowed scalar types throw", () => {
  expectError(`let m = Exact.Matrix.scale(1.5, Exact.Matrix.zero(1, 1));`);
  expectError(`let m = Exact.Matrix.scale('k', Exact.Matrix.zero(1, 1));`);
});

Deno.test("scale: second argument must be a Matrix", () => {
  expectError(`let m = Exact.Matrix.scale(2n, [[1n]]);`);
});

// ---------- negate ----------

Deno.test("negate: numeric and symbolic entries", () => {
  const session = run(`
    let x = Symbol.for('x');
    let m = Exact.Matrix.negate(Exact.Matrix.make([[2n, Exact.rational(1n, 2n), x]]));
    let a = Exact.Matrix.get(m, 0, 0);
    let b = Exact.Matrix.get(m, 0, 1);
    let c = Exact.Matrix.get(m, 0, 2);
  `);
  // Negate of a BigInt promotes to an integer Rational (the
  // Multiply(-1, x) fold path — Ring 2/3 canonical).
  assertEquals(session.getExact(0, 'a'), rational(-2n));
  assertEquals(session.getExact(0, 'b'), rational(-1n, 2n));
  const symbolic = session.getExact(0, 'c');
  // Ring 3 canonicalizes Negate(x) to Multiply(-1, x).
  assertEquals(symbolic.kind, 'expression');
  assertEquals(symbolic.head.description, 'Multiply');
  assertEquals(symbolic.arguments[0], rational(-1n));
  assertEquals(symbolic.arguments[1].description, 'x');
});

Deno.test("negate: complex entries", () => {
  const session = run(`
    let m = Exact.Matrix.negate(Exact.Matrix.make([[Exact.i]]));
    let e = Exact.Matrix.get(m, 0, 0);
  `);
  const entry = session.getExact(0, 'e');
  assertEquals(entry.kind, 'complex');
  assertEquals(entry.imaginary, rational(-1n));
});

Deno.test("negate: non-Matrix throws", () => {
  expectError(`let m = Exact.Matrix.negate(5);`);
});

// ---------- algebraic sanity ----------

Deno.test("subtract(A, A) equals the zero matrix", () => {
  const session = run(`
    let a = Exact.Matrix.make([[1n, Symbol.for('x')], [Exact.rational(2n, 3n), Exact.i]]);
    let z = Exact.Matrix.subtract(a, a);
    let result = Exact.Matrix.equal(z, Exact.Matrix.zero(2, 2));
  `);
  assertEquals(session.get(0, 'result'), true);
});

Deno.test("add(A, negate(A)) equals the zero matrix", () => {
  const session = run(`
    let a = Exact.Matrix.make([[7n, Symbol.for('y')]]);
    let z = Exact.Matrix.add(a, Exact.Matrix.negate(a));
    let result = Exact.Matrix.equal(z, Exact.Matrix.zero(1, 2));
  `);
  assertEquals(session.get(0, 'result'), true);
});

Deno.test("scale(0, A) is the zero matrix even for symbolic entries", () => {
  const session = run(`
    let a = Exact.Matrix.make([[Symbol.for('x'), 3n]]);
    let z = Exact.Matrix.scale(0, a);
    let result = Exact.Matrix.equal(z, Exact.Matrix.zero(1, 2));
  `);
  assertEquals(session.get(0, 'result'), true);
});

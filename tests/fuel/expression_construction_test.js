/**
 * 2b.3 — Expression construction builtins.
 *
 * Tests the user-facing construction API:
 *   Exact.Expression.make(headSymbol, argsArray) — general-purpose
 *   Exact.Expression.add / subtract / multiply / divide / power — sugar
 *   Exact.Expression.negate(operand)
 *
 * Also tests:
 *   - Strict argument-type validation (Symbol/Rational/Complex/BigInt/Expression
 *     only; Float/String/Boolean/Array/Object/null/undefined rejected with
 *     TypeError).
 *   - Lazy construction: Exact.Expression.add(1, 2) builds Add(1, 2), not 3.
 *   - typeof on an Expression is 'object' (heap-backed).
 *   - Implicit coercion: e + x, Number(e), -e, +e all throw TypeError.
 */

import { assertEquals, assert, assertThrows } from "https://deno.land/std@0.208.0/assert/mod.ts";
import { createSession } from '../../src/fuel/session.js';
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
  session.run(0, 1000000);
  return session;
}

// ---------- sugar constructors: add/subtract/multiply/divide/power/negate ----------

Deno.test("Expression.add(a, b) builds Add(a, b)", () => {
  const session = run(`let x = Exact.Expression.add(Exact.Pi, 1n);`);
  const value = session.getExact(0, 'x');
  assertEquals(value.kind, 'expression');
  assertEquals(value.head.description, 'Add');
  assertEquals(value.arguments.length, 2);
  assertEquals(value.arguments[0].description, 'Pi');
  assertEquals(value.arguments[1], 1n);
});

Deno.test("Expression.subtract(a, b) builds Subtract(a, b) — not desugared", () => {
  // Ring 2 construction is parse-faithful; desugaring happens in simplify (2d).
  const session = run(`let x = Exact.Expression.subtract(Exact.Pi, 1n);`);
  assertEquals(session.getExact(0, 'x').head.description, 'Subtract');
});

Deno.test("Expression.multiply(a, b) builds Multiply(a, b)", () => {
  const session = run(`let x = Exact.Expression.multiply(Exact.Pi, 2n);`);
  assertEquals(session.getExact(0, 'x').head.description, 'Multiply');
});

Deno.test("Expression.divide(a, b) builds Divide(a, b)", () => {
  const session = run(`let x = Exact.Expression.divide(Exact.Pi, 2n);`);
  assertEquals(session.getExact(0, 'x').head.description, 'Divide');
});

Deno.test("Expression.power(a, b) builds Power(a, b)", () => {
  const session = run(`let x = Exact.Expression.power(Exact.Pi, 2n);`);
  assertEquals(session.getExact(0, 'x').head.description, 'Power');
});

Deno.test("Expression.negate(x) builds Negate(x) with one arg", () => {
  const session = run(`let x = Exact.Expression.negate(Exact.Pi);`);
  const value = session.getExact(0, 'x');
  assertEquals(value.head.description, 'Negate');
  assertEquals(value.arguments.length, 1);
  assertEquals(value.arguments[0].description, 'Pi');
});

// ---------- binary-operation arity ----------
//
// add/subtract/multiply/divide/power are strictly 2-argument. A call
// with argc != 2 used to silently read only the first two pending
// arguments and discard the rest with no error at all
// (Exact.Expression.add(1n, 2n, 3n) built Add(1n, 2n), the 3n simply
// vanished). Fixed 2026-07-21 to throw instead.

Deno.test("Expression.add with 3 arguments throws instead of silently dropping the third", () => {
  expectError(`let x = Exact.Expression.add(1n, 2n, 3n);`);
});

Deno.test("Expression.multiply with 3 arguments throws instead of silently dropping the third", () => {
  expectError(`let x = Exact.Expression.multiply(1n, 2n, 3n);`);
});

Deno.test("Expression.subtract/divide/power with 3 arguments all throw", () => {
  expectError(`let x = Exact.Expression.subtract(1n, 2n, 3n);`);
  expectError(`let x = Exact.Expression.divide(1n, 2n, 3n);`);
  expectError(`let x = Exact.Expression.power(1n, 2n, 3n);`);
});

Deno.test("Expression.add with 1 argument throws (not silently building a degenerate node)", () => {
  expectError(`let x = Exact.Expression.add(1n);`);
});

Deno.test("Expression.add(a, b) with exactly 2 arguments is unaffected by the arity fix", () => {
  const session = run(`let x = Exact.Expression.add(1n, 2n); let v = Exact.Expression.simplify(x);`);
  assertEquals(session.get(0, 'v'), 3n);
});

// ---------- make(head, args) ----------

Deno.test("Expression.make(head, args) with registry-backed head", () => {
  const session = run(`let x = Exact.Expression.make(Exact.Expression.Add, [Exact.Pi, 2n]);`);
  const value = session.getExact(0, 'x');
  assertEquals(value.head.description, 'Add');
  assertEquals(value.arguments[0].description, 'Pi');
  assertEquals(value.arguments[1], 2n);
});

Deno.test("Expression.make with a custom head symbol (e.g. Sin)", () => {
  const session = run(`
    let sin = Symbol.for('Sin');
    let x = Exact.Expression.make(sin, [Exact.Pi]);
  `);
  const value = session.getExact(0, 'x');
  assertEquals(value.head.description, 'Sin');
  assertEquals(value.arguments.length, 1);
});

Deno.test("Expression.make with zero-argument head allowed (Add() is fine structurally)", () => {
  const session = run(`let x = Exact.Expression.make(Exact.Expression.Add, []);`);
  const value = session.getExact(0, 'x');
  assertEquals(value.head.description, 'Add');
  assertEquals(value.arguments, []);
});

Deno.test("Expression.make rejects non-Symbol head", () => {
  expectError(`let x = Exact.Expression.make('Add', [1n]);`);
  expectError(`let x = Exact.Expression.make(42, [1n]);`);
});

Deno.test("Expression.make rejects non-Array args", () => {
  expectError(`let x = Exact.Expression.make(Exact.Expression.Add, Exact.Pi);`);
  expectError(`let x = Exact.Expression.make(Exact.Expression.Add, 'nope');`);
});

// ---------- argument type validation ----------

Deno.test("Expression args: Symbol, BigInt, Rational, Complex, Expression accepted", () => {
  // All five allowed types.
  const session = run(`
    let a = Exact.Expression.add(Exact.Pi, 1n);                                  // Symbol + BigInt
    let b = Exact.Expression.add(Exact.rational(1n, 2n), Exact.rational(1n, 3n)); // Rational + Rational
    let c = Exact.Expression.add(Exact.i, Exact.Pi);                              // Complex + Symbol
    let d = Exact.Expression.add(a, b);                                           // Expression + Expression
  `);
  assertEquals(session.getExact(0, 'a').head.description, 'Add');
  assertEquals(session.getExact(0, 'b').head.description, 'Add');
  assertEquals(session.getExact(0, 'c').head.description, 'Add');
  assertEquals(session.getExact(0, 'd').head.description, 'Add');
});

Deno.test("Expression args: Float rejected", () => {
  expectError(`let x = Exact.Expression.add(1.5, Exact.Pi);`);
  expectError(`let x = Exact.Expression.add(Exact.Pi, 3.14);`);
});

Deno.test("Expression args: String rejected", () => {
  expectError(`let x = Exact.Expression.add('x', Exact.Pi);`);
});

Deno.test("Expression args: Boolean rejected", () => {
  expectError(`let x = Exact.Expression.add(true, Exact.Pi);`);
});

Deno.test("Expression args: Array rejected", () => {
  expectError(`let x = Exact.Expression.add([1n, 2n], Exact.Pi);`);
});

Deno.test("Expression args: Object rejected", () => {
  expectError(`let x = Exact.Expression.add({a: 1n}, Exact.Pi);`);
});

Deno.test("Expression args: null rejected", () => {
  expectError(`let x = Exact.Expression.add(null, Exact.Pi);`);
});

Deno.test("Expression args: undefined rejected", () => {
  expectError(`let x = Exact.Expression.add(undefined, Exact.Pi);`);
});

// make() validates each element, including nested arrays
Deno.test("Expression.make: rejects if any args element is an invalid type", () => {
  expectError(`let x = Exact.Expression.make(Exact.Expression.Add, [Exact.Pi, 3.14]);`);
  expectError(`let x = Exact.Expression.make(Exact.Expression.Add, [Exact.Pi, 'x']);`);
});

// ---------- lazy construction ----------

Deno.test("Expression.add is lazy — builds a tree even with two numeric args", () => {
  const session = run(`let x = Exact.Expression.add(1n, 2n);`);
  const value = session.getExact(0, 'x');
  // Must be a tree, not 3n
  assertEquals(value.kind, 'expression');
  assertEquals(value.head.description, 'Add');
  assertEquals(value.arguments, [1n, 2n]);
});

Deno.test("Expression.multiply is lazy — builds Multiply(2, 3) not 6", () => {
  const session = run(`let x = Exact.Expression.multiply(2n, 3n);`);
  assertEquals(session.getExact(0, 'x').head.description, 'Multiply');
});

Deno.test("Expression.negate is lazy — Negate(5) not -5", () => {
  const session = run(`let x = Exact.Expression.negate(5n);`);
  assertEquals(session.getExact(0, 'x').head.description, 'Negate');
});

// ---------- typeof + JS-surface behavior ----------

Deno.test("typeof Expression === 'object'", () => {
  assertEquals(run(`let x = typeof Exact.Expression.add(Exact.Pi, 1n);`).get(0, 'x'), 'object');
});

Deno.test("Expression !== any other Expression even with same structure", () => {
  // Ring 2 construction is not hash-consed — two separately-built Add(Pi, 1n)
  // trees are distinct heap objects. Structural equality comes in 2c.
  const session = run(`
    let a = Exact.Expression.add(Exact.Pi, 1n);
    let b = Exact.Expression.add(Exact.Pi, 1n);
    let x = a === b;
  `);
  assertEquals(session.get(0, 'x'), false);
});

Deno.test("Expression === itself", () => {
  const session = run(`
    let e = Exact.Expression.add(Exact.Pi, 1n);
    let x = e === e;
  `);
  assertEquals(session.get(0, 'x'), true);
});

// ---------- implicit coercion rejection ----------

Deno.test("Expression + Number throws", () => {
  expectError(`let x = Exact.Expression.add(Exact.Pi, 1n) + 1;`);
});

Deno.test("Number + Expression throws", () => {
  expectError(`let x = 1 + Exact.Expression.add(Exact.Pi, 1n);`);
});

Deno.test("String + Expression throws (no silent stringify)", () => {
  expectError(`let x = 'result=' + Exact.Expression.add(Exact.Pi, 1n);`);
});

Deno.test("Number(Expression) throws", () => {
  expectError(`let x = Number(Exact.Expression.add(Exact.Pi, 1n));`);
});

Deno.test("Unary minus on Expression throws", () => {
  expectError(`let x = -Exact.Expression.add(Exact.Pi, 1n);`);
});

Deno.test("Unary plus on Expression throws", () => {
  expectError(`let x = +Exact.Expression.add(Exact.Pi, 1n);`);
});

// ---------- nested construction ----------

Deno.test("Nested expressions: Multiply(Add(Pi, 1), 2)", () => {
  const session = run(`
    let inner = Exact.Expression.add(Exact.Pi, 1n);
    let x = Exact.Expression.multiply(inner, 2n);
  `);
  const value = session.getExact(0, 'x');
  assertEquals(value.head.description, 'Multiply');
  assertEquals(value.arguments[0].kind, 'expression');
  assertEquals(value.arguments[0].head.description, 'Add');
  assertEquals(value.arguments[1], 2n);
});

// ---------- args array is frozen ----------

Deno.test("Expression's args array is frozen (cannot be mutated via make)", () => {
  // After make() attaches the args array, it's frozen. We can't inspect it
  // directly in 2b.3 (args accessor is 2b.4), but we can verify the freeze
  // by reusing the same array: pass it to make, then try to mutate.
  expectError(`
    let args = [Exact.Pi, 1n];
    Exact.Expression.make(Exact.Expression.Add, args);
    args.push(2n);
  `);
});

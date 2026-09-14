/**
 * 2b.4 — Expression inspection accessors.
 *
 * Tests the five accessor builtins:
 *   Exact.Expression.kind(e)          → head Symbol (throws on atoms)
 *   Exact.Expression.args(e)          → frozen Array (throws on atoms)
 *   Exact.Expression.argumentCount(e) → integer (throws on atoms)
 *   Exact.Expression.isExpression(v)  → boolean
 *   Exact.Expression.isAtom(v)        → boolean
 *
 * Plus Exact.typeOf extension for 'symbol' and 'expression'.
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

// kind(e) — head Symbol

Deno.test("kind: returns Add for an add expression", () => {
  const session = run(`
    let e = Exact.Expression.add(Exact.Pi, 1n);
    let x = Exact.Expression.kind(e) === Exact.Expression.Add;
  `);
  assertEquals(session.get(0, 'x'), true);
});

Deno.test("kind: returns Subtract for a subtract expression (not desugared)", () => {
  const session = run(`
    let e = Exact.Expression.subtract(Exact.Pi, 1n);
    let x = Exact.Expression.kind(e) === Exact.Expression.Subtract;
  `);
  assertEquals(session.get(0, 'x'), true);
});

Deno.test("kind: returns the custom head for a user-defined expression", () => {
  const session = run(`
    let sin = Symbol.for('Sin');
    let e = Exact.Expression.make(sin, [Exact.Pi]);
    let x = Exact.Expression.kind(e) === sin;
  `);
  assertEquals(session.get(0, 'x'), true);
});

Deno.test("kind: throws on atoms (Symbol)", () => {
  expectError(`let x = Exact.Expression.kind(Exact.Pi);`);
});

Deno.test("kind: throws on atoms (Rational)", () => {
  expectError(`let x = Exact.Expression.kind(Exact.rational(1n, 2n));`);
});

Deno.test("kind: throws on atoms (BigInt)", () => {
  expectError(`let x = Exact.Expression.kind(42n);`);
});

Deno.test("kind: throws on non-atom non-expression values", () => {
  expectError(`let x = Exact.Expression.kind('hello');`);
  expectError(`let x = Exact.Expression.kind(null);`);
  expectError(`let x = Exact.Expression.kind([1n, 2n]);`);
});

// args(e) — frozen argument array

Deno.test("args: returns the argument array", () => {
  const session = run(`
    let e = Exact.Expression.add(Exact.Pi, 1n);
    let a = Exact.Expression.args(e);
    let x = a.length;
  `);
  assertEquals(session.get(0, 'x'), 2);
});

Deno.test("args: returned array is frozen", () => {
  expectError(`
    let e = Exact.Expression.add(Exact.Pi, 1n);
    let a = Exact.Expression.args(e);
    a.push(42n);
  `);
});

Deno.test("args: returned array index assignment also throws", () => {
  expectError(`
    let e = Exact.Expression.add(Exact.Pi, 1n);
    let a = Exact.Expression.args(e);
    a[0] = 99n;
  `);
});

Deno.test("args: elements are readable at every index", () => {
  const session = run(`
    let e = Exact.Expression.add(Exact.Pi, 1n);
    let a = Exact.Expression.args(e);
    let firstDescription = a[0].description;
    let second = a[1];
  `);
  assertEquals(session.get(0, 'firstDescription'), 'Pi');
  assertEquals(session.get(0, 'second'), 1n);
});

Deno.test("args: throws on non-Expression", () => {
  expectError(`let x = Exact.Expression.args(Exact.Pi);`);
  expectError(`let x = Exact.Expression.args(42n);`);
  expectError(`let x = Exact.Expression.args('x');`);
});

Deno.test("args: works on zero-arg expressions", () => {
  const session = run(`
    let e = Exact.Expression.make(Exact.Expression.Add, []);
    let a = Exact.Expression.args(e);
    let x = a.length;
  `);
  assertEquals(session.get(0, 'x'), 0);
});

// argumentCount(e)

Deno.test("argumentCount: binary expression has 2 args", () => {
  const session = run(`
    let e = Exact.Expression.add(Exact.Pi, 1n);
    let x = Exact.Expression.argumentCount(e);
  `);
  assertEquals(session.get(0, 'x'), 2);
});

Deno.test("argumentCount: unary (negate) has 1 arg", () => {
  const session = run(`
    let e = Exact.Expression.negate(Exact.Pi);
    let x = Exact.Expression.argumentCount(e);
  `);
  assertEquals(session.get(0, 'x'), 1);
});

Deno.test("argumentCount: zero-arg expression has 0 args", () => {
  const session = run(`
    let e = Exact.Expression.make(Exact.Expression.Add, []);
    let x = Exact.Expression.argumentCount(e);
  `);
  assertEquals(session.get(0, 'x'), 0);
});

Deno.test("argumentCount: throws on non-Expression", () => {
  expectError(`let x = Exact.Expression.argumentCount(Exact.Pi);`);
});

// isExpression(v)

Deno.test("isExpression: true for Expression", () => {
  assertEquals(
    run(`let x = Exact.Expression.isExpression(Exact.Expression.add(Exact.Pi, 1n));`).get(0, 'x'),
    true
  );
});

Deno.test("isExpression: false for Symbol", () => {
  assertEquals(run(`let x = Exact.Expression.isExpression(Exact.Pi);`).get(0, 'x'), false);
});

Deno.test("isExpression: false for numeric types", () => {
  assertEquals(run(`let x = Exact.Expression.isExpression(42n);`).get(0, 'x'), false);
  assertEquals(run(`let x = Exact.Expression.isExpression(3);`).get(0, 'x'), false);
  assertEquals(run(`let x = Exact.Expression.isExpression(Exact.i);`).get(0, 'x'), false);
  assertEquals(run(`let x = Exact.Expression.isExpression(Exact.rational(1n, 2n));`).get(0, 'x'), false);
});

Deno.test("isExpression: false for non-math types", () => {
  assertEquals(run(`let x = Exact.Expression.isExpression('hello');`).get(0, 'x'), false);
  assertEquals(run(`let x = Exact.Expression.isExpression(true);`).get(0, 'x'), false);
  assertEquals(run(`let x = Exact.Expression.isExpression(null);`).get(0, 'x'), false);
  assertEquals(run(`let x = Exact.Expression.isExpression([1n, 2n]);`).get(0, 'x'), false);
});

// isAtom(v)

Deno.test("isAtom: true for Symbol / Rational / Complex / BigInt", () => {
  assertEquals(run(`let x = Exact.Expression.isAtom(Exact.Pi);`).get(0, 'x'), true);
  assertEquals(run(`let x = Exact.Expression.isAtom(Exact.rational(1n, 2n));`).get(0, 'x'), true);
  assertEquals(run(`let x = Exact.Expression.isAtom(Exact.i);`).get(0, 'x'), true);
  assertEquals(run(`let x = Exact.Expression.isAtom(42n);`).get(0, 'x'), true);
});

Deno.test("isAtom: true for integer-literal Rationals too (ring 1 unwrap)", () => {
  // Integer literals are TYPE.RATIONAL under the hood — still atoms.
  assertEquals(run(`let x = Exact.Expression.isAtom(5);`).get(0, 'x'), true);
});

Deno.test("isAtom: false for Expression", () => {
  assertEquals(
    run(`let x = Exact.Expression.isAtom(Exact.Expression.add(Exact.Pi, 1n));`).get(0, 'x'),
    false
  );
});

Deno.test("isAtom: false for non-math types", () => {
  assertEquals(run(`let x = Exact.Expression.isAtom('hello');`).get(0, 'x'), false);
  assertEquals(run(`let x = Exact.Expression.isAtom(true);`).get(0, 'x'), false);
  assertEquals(run(`let x = Exact.Expression.isAtom(3.14);`).get(0, 'x'), false);
  assertEquals(run(`let x = Exact.Expression.isAtom(null);`).get(0, 'x'), false);
  assertEquals(run(`let x = Exact.Expression.isAtom([1n, 2n]);`).get(0, 'x'), false);
});

// Exact.typeOf extension

Deno.test("Exact.typeOf: returns 'symbol' for a Symbol", () => {
  assertEquals(run(`let x = Exact.typeOf(Exact.Pi);`).get(0, 'x'), 'symbol');
  assertEquals(run(`let x = Exact.typeOf(Symbol('x'));`).get(0, 'x'), 'symbol');
  assertEquals(run(`let x = Exact.typeOf(Symbol.for('y'));`).get(0, 'x'), 'symbol');
});

Deno.test("Exact.typeOf: returns 'expression' for an Expression", () => {
  assertEquals(
    run(`let x = Exact.typeOf(Exact.Expression.add(Exact.Pi, 1n));`).get(0, 'x'),
    'expression'
  );
});

Deno.test("Exact.typeOf: Ring 1 types still report correctly", () => {
  // Sanity-check that 2b.4's extension didn't regress Ring 1.
  assertEquals(run(`let x = Exact.typeOf(5);`).get(0, 'x'), 'integer');
  assertEquals(run(`let x = Exact.typeOf(Exact.rational(1n, 2n));`).get(0, 'x'), 'rational');
  assertEquals(run(`let x = Exact.typeOf(Exact.i);`).get(0, 'x'), 'complex');
  assertEquals(run(`let x = Exact.typeOf(42n);`).get(0, 'x'), 'bigint');
  assertEquals(run(`let x = Exact.typeOf(3.14);`).get(0, 'x'), 'float');
});

// Inspection round-trips: kind matches pre-registered constant

Deno.test("Inspection round-trip: build / inspect / compare", () => {
  const session = run(`
    let x = Symbol.for('x');
    let y = Symbol.for('y');
    let e = Exact.Expression.multiply(
      Exact.Expression.add(x, y),
      2n
    );
    let outerKind = Exact.Expression.kind(e);
    let outerArgs = Exact.Expression.args(e);
    let innerKind = Exact.Expression.kind(outerArgs[0]);
    let result = outerKind === Exact.Expression.Multiply && innerKind === Exact.Expression.Add;
  `);
  assertEquals(session.get(0, 'result'), true);
});

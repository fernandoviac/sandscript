/**
 * 2c — Structural equality + single-variable substitution.
 *
 *   Exact.Expression.equal(a, b)
 *     - Atoms: Symbols by pointer (registry-backed identity),
 *       numeric atoms via Ring 1 semantic equality (Add(2n, x) equals
 *       Add(2, x) at the leaf level).
 *     - Expressions: head equal AND args equal recursively.
 *     - Different kinds with no semantic rule: false.
 *
 *   Exact.Expression.substitute(expression, targetSymbol, replacement)
 *     - Walks the tree replacing every occurrence of targetSymbol in
 *       ARGUMENT positions with replacement. Head positions are untouched.
 *     - Returns a new tree; input is never mutated.
 *     - Throws TypeError if target isn't a Symbol.
 *     - Substitute on an atom that matches returns the replacement.
 *     - Substitute on any other atom returns it unchanged.
 */

import { assertEquals, assertThrows } from "https://deno.land/std@0.208.0/assert/mod.ts";
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

// ---------- equal: atoms ----------

Deno.test("equal: Symbol by pointer", () => {
  assertEquals(run(`let x = Exact.Expression.equal(Exact.Pi, Exact.Pi);`).get(0, 'x'), true);
  assertEquals(run(`
    let a = Symbol.for('x');
    let b = Symbol.for('x');
    let x = Exact.Expression.equal(a, b);
  `).get(0, 'x'), true);
  assertEquals(run(`
    let a = Symbol('x');
    let b = Symbol('x');
    let x = Exact.Expression.equal(a, b);
  `).get(0, 'x'), false);
});

Deno.test("equal: different Symbols are not equal", () => {
  assertEquals(run(`let x = Exact.Expression.equal(Exact.Pi, Exact.E);`).get(0, 'x'), false);
});

Deno.test("equal: BigInt equality", () => {
  assertEquals(run(`let x = Exact.Expression.equal(42n, 42n);`).get(0, 'x'), true);
  assertEquals(run(`let x = Exact.Expression.equal(42n, 43n);`).get(0, 'x'), false);
});

Deno.test("equal: Rational equality", () => {
  assertEquals(
    run(`let x = Exact.Expression.equal(Exact.rational(1n, 2n), Exact.rational(1n, 2n));`).get(0, 'x'),
    true
  );
  assertEquals(
    run(`let x = Exact.Expression.equal(Exact.rational(2n, 4n), Exact.rational(1n, 2n));`).get(0, 'x'),
    true  // reduced form is canonical
  );
});

Deno.test("equal: integer literal ≡ BigInt semantically", () => {
  // Ring 1 semantic equality: 2 (Rational) == 2n (BigInt).
  assertEquals(run(`let x = Exact.Expression.equal(2, 2n);`).get(0, 'x'), true);
});

Deno.test("equal: Complex equality", () => {
  assertEquals(run(`let x = Exact.Expression.equal(Exact.i, Exact.i);`).get(0, 'x'), true);
  assertEquals(run(`
    let a = Exact.complex(3n, 4n);
    let b = Exact.complex(3n, 4n);
    let x = Exact.Expression.equal(a, b);
  `).get(0, 'x'), true);
});

// ---------- equal: expressions ----------

Deno.test("equal: identical expressions", () => {
  assertEquals(run(`
    let a = Exact.Expression.add(Exact.Pi, 1n);
    let b = Exact.Expression.add(Exact.Pi, 1n);
    let x = Exact.Expression.equal(a, b);
  `).get(0, 'x'), true);
});

Deno.test("equal: different heads", () => {
  assertEquals(run(`
    let a = Exact.Expression.add(Exact.Pi, 1n);
    let b = Exact.Expression.multiply(Exact.Pi, 1n);
    let x = Exact.Expression.equal(a, b);
  `).get(0, 'x'), false);
});

Deno.test("equal: different args", () => {
  assertEquals(run(`
    let a = Exact.Expression.add(Exact.Pi, 1n);
    let b = Exact.Expression.add(Exact.E, 1n);
    let x = Exact.Expression.equal(a, b);
  `).get(0, 'x'), false);
});

Deno.test("equal: different arg counts", () => {
  assertEquals(run(`
    let a = Exact.Expression.make(Exact.Expression.Add, [1n]);
    let b = Exact.Expression.make(Exact.Expression.Add, [1n, 2n]);
    let x = Exact.Expression.equal(a, b);
  `).get(0, 'x'), false);
});

Deno.test("equal: nested expressions", () => {
  assertEquals(run(`
    let a = Exact.Expression.multiply(Exact.Expression.add(Exact.Pi, 1n), 2n);
    let b = Exact.Expression.multiply(Exact.Expression.add(Exact.Pi, 1n), 2n);
    let x = Exact.Expression.equal(a, b);
  `).get(0, 'x'), true);
});

Deno.test("equal: numeric atoms compared semantically inside trees", () => {
  // Integer literal 2 (Rational) equals BigInt 2n inside the same tree.
  assertEquals(run(`
    let a = Exact.Expression.add(Exact.Pi, 2n);
    let b = Exact.Expression.add(Exact.Pi, 2);
    let x = Exact.Expression.equal(a, b);
  `).get(0, 'x'), true);
});

Deno.test("equal: Expression ≠ non-Expression", () => {
  assertEquals(run(`
    let a = Exact.Expression.add(Exact.Pi, 1n);
    let x = Exact.Expression.equal(a, Exact.Pi);
  `).get(0, 'x'), false);
});

Deno.test("equal: structural — Add(1, x) ≠ Add(x, 1)", () => {
  // Structural equality respects argument order. Simplify (in 2d) will
  // canonicalize commutative heads; until then, order matters.
  assertEquals(run(`
    let x = Symbol.for('x');
    let a = Exact.Expression.add(1n, x);
    let b = Exact.Expression.add(x, 1n);
    let r = Exact.Expression.equal(a, b);
  `).get(0, 'r'), false);
});

Deno.test("equal: zero-arg expressions equal by head", () => {
  assertEquals(run(`
    let a = Exact.Expression.make(Exact.Expression.Add, []);
    let b = Exact.Expression.make(Exact.Expression.Add, []);
    let x = Exact.Expression.equal(a, b);
  `).get(0, 'x'), true);
});

// ---------- substitute: atoms ----------

Deno.test("substitute: on target symbol returns replacement", () => {
  assertEquals(run(`
    let x = Symbol.for('x');
    let r = Exact.Expression.substitute(x, x, 42n);
  `).get(0, 'r'), 42n);
});

Deno.test("substitute: on non-target atom returns it unchanged", () => {
  const session = run(`
    let x = Symbol.for('x');
    let r = Exact.Expression.substitute(Exact.Pi, x, 42n);
    let stillPi = r === Exact.Pi;
  `);
  assertEquals(session.get(0, 'stillPi'), true);
});

Deno.test("substitute: on a numeric atom returns it unchanged", () => {
  assertEquals(run(`
    let x = Symbol.for('x');
    let r = Exact.Expression.substitute(7n, x, 42n);
  `).get(0, 'r'), 7n);
});

// ---------- substitute: inside expressions ----------

Deno.test("substitute: leaf arg", () => {
  const session = run(`
    let x = Symbol.for('x');
    let e = Exact.Expression.add(x, 1n);
    let r = Exact.Expression.substitute(e, x, 42n);
    let k = Exact.Expression.kind(r);
    let a = Exact.Expression.args(r);
    let first = a[0];
    let second = a[1];
    let sameKind = k === Exact.Expression.Add;
  `);
  assertEquals(session.get(0, 'sameKind'), true);
  assertEquals(session.get(0, 'first'), 42n);
  assertEquals(session.get(0, 'second'), 1n);
});

Deno.test("substitute: multiple occurrences in flat expression", () => {
  const session = run(`
    let x = Symbol.for('x');
    let e = Exact.Expression.make(Exact.Expression.Add, [x, x, x]);
    let r = Exact.Expression.substitute(e, x, 5n);
    let a = Exact.Expression.args(r);
  `);
  assertEquals(session.get(0, 'a'), [5n, 5n, 5n]);
});

Deno.test("substitute: nested occurrences", () => {
  const session = run(`
    let x = Symbol.for('x');
    let y = Symbol.for('y');
    let inner = Exact.Expression.multiply(x, y);
    let outer = Exact.Expression.add(inner, x);
    let r = Exact.Expression.substitute(outer, x, 5n);
  `);
  const value = session.getExact(0, 'r');
  assertEquals(value.head.description, 'Add');
  // Inner becomes Multiply(5n, y)
  assertEquals(value.arguments[0].head.description, 'Multiply');
  assertEquals(value.arguments[0].arguments[0], 5n);
  assertEquals(value.arguments[0].arguments[1].description, 'y');
  // Outer-second becomes 5n
  assertEquals(value.arguments[1], 5n);
});

Deno.test("substitute: symbol not present in tree — unchanged structure", () => {
  const session = run(`
    let x = Symbol.for('x');
    let y = Symbol.for('y');
    let e = Exact.Expression.add(Exact.Pi, y);
    let r = Exact.Expression.substitute(e, x, 99n);
    let same = Exact.Expression.equal(e, r);
  `);
  assertEquals(session.get(0, 'same'), true);
});

Deno.test("substitute: input tree is never mutated", () => {
  const session = run(`
    let x = Symbol.for('x');
    let original = Exact.Expression.add(x, 1n);
    let replaced = Exact.Expression.substitute(original, x, 42n);
    let originalFirst = Exact.Expression.args(original)[0];
    let originalStillHasX = originalFirst === x;
  `);
  assertEquals(session.get(0, 'originalStillHasX'), true);
});

Deno.test("substitute: replacement can be any allowed atom type", () => {
  // Symbol replacement.
  const s1 = run(`
    let x = Symbol.for('x');
    let y = Symbol.for('y');
    let e = Exact.Expression.add(x, 1n);
    let r = Exact.Expression.substitute(e, x, y);
    let first = Exact.Expression.args(r)[0];
    let matches = first === y;
  `);
  assertEquals(s1.get(0, 'matches'), true);

  // Rational replacement.
  const s2 = run(`
    let x = Symbol.for('x');
    let e = Exact.Expression.add(x, 1n);
    let r = Exact.Expression.substitute(e, x, Exact.rational(1n, 3n));
    let first = Exact.Expression.args(r)[0];
  `);
  assertEquals(s2.getExact(0, 'first'), { kind: 'rational', numerator: 1n, denominator: 3n });

  // Expression replacement — nested structure.
  const s3 = run(`
    let x = Symbol.for('x');
    let e = Exact.Expression.add(x, 1n);
    let replacement = Exact.Expression.multiply(Exact.Pi, 2n);
    let r = Exact.Expression.substitute(e, x, replacement);
    let first = Exact.Expression.args(r)[0];
    let matches = Exact.Expression.equal(first, replacement);
  `);
  assertEquals(s3.get(0, 'matches'), true);
});

// ---------- substitute: head positions untouched ----------

Deno.test("substitute: does NOT replace head position", () => {
  // substitute(Add(1, 2), Add, Multiply) must leave the Add head intact —
  // matching the plan's rule that heads are never substituted (a variable
  // doesn't appear as a head in well-formed math, so this protects
  // against an easy footgun).
  const session = run(`
    let add = Exact.Expression.Add;
    let mul = Exact.Expression.Multiply;
    let e = Exact.Expression.make(add, [1n, 2n]);
    let r = Exact.Expression.substitute(e, add, mul);
    let k = Exact.Expression.kind(r);
    let stillAdd = k === add;
  `);
  assertEquals(session.get(0, 'stillAdd'), true);
});

// ---------- substitute: argument validation ----------

Deno.test("substitute: target must be a Symbol", () => {
  expectError(`let x = Exact.Expression.substitute(Exact.Pi, 42n, 0n);`);
  expectError(`let x = Exact.Expression.substitute(Exact.Pi, 'x', 0n);`);
});

Deno.test("substitute: replacement must stay inside the term universe", () => {
  // A foreign replacement would splice a value the walkers (comparator,
  // collection, simplify) were never designed to see into the tree.
  expectError(`
    let x = Symbol.for('x');
    let r = Exact.Expression.substitute(Exact.Expression.add(x, 1n), x, 'hello');
  `);
  expectError(`
    let x = Symbol.for('x');
    let r = Exact.Expression.substitute(Exact.Expression.add(x, 1n), x, () => 1);
  `);
  expectError(`
    let x = Symbol.for('x');
    let r = Exact.Expression.substitute(Exact.Expression.add(x, 1n), x, null);
  `);
});

Deno.test("substitute: a Matrix replacement is legal (term universe includes Matrix)", () => {
  const session = run(`
    let x = Symbol.for('x');
    let m = Exact.Matrix.make([[1n, 0n], [0n, 1n]]);
    let r = Exact.Expression.substitute(Exact.Expression.add(x, 1n), x, m);
    let args = Exact.Expression.args(r);
    let gotMatrix = Exact.Matrix.isMatrix(args[0]) || Exact.Matrix.isMatrix(args[1]);
  `);
  assertEquals(session.get(0, 'gotMatrix'), true);
});

// ---------- substitute + equal compose ----------

Deno.test("substitute then equal round-trip", () => {
  const session = run(`
    let x = Symbol.for('x');
    let expected = Exact.Expression.multiply(Exact.Pi, 2n);
    let template = Exact.Expression.multiply(x, 2n);
    let substituted = Exact.Expression.substitute(template, x, Exact.Pi);
    let matches = Exact.Expression.equal(expected, substituted);
  `);
  assertEquals(session.get(0, 'matches'), true);
});

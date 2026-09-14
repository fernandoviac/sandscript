/**
 * 2d.2 — simplify: flatten associative + constant folding.
 *
 * Rules added on top of 2d.1:
 *   1. Flatten same-head associative: Add(Add(a, b), c) → Add(a, b, c);
 *      Multiply same. Deep nests flatten in one pass.
 *   2. Fold numeric args: Add(1, 2, x) → Add(3, x); Multiply(2, 3, x) → Multiply(6, x).
 *      All numerics collapse into a single folded value; Ring 1 arithmetic
 *      handles the promotion (BigInt+Rational → Rational, etc.).
 *   3. N-ary identity stripping: Add(0, x, 0, y) → Add(x, y); Multiply(1, x, 1)
 *      → x. Zero always annihilates Multiply.
 *   4. Zero-arg: Add() → 0, Multiply() → 1.
 *
 * Order preservation: the folded numeric lands at the position of the
 * FIRST numeric in the flattened arg list. Non-numerics keep their
 * relative order. Commutative sort lands in 2d.3.
 */

import { assertEquals } from "https://deno.land/std@0.208.0/assert/mod.ts";
import { createSession } from '../../src/fuel/session.js';
import { parseAndSetup } from './test-helpers.js';
import { freshSession } from '../../src/host-owned-session.js';

function run(source) {
  const session = freshSession();
  parseAndSetup(session, source);
  const result = session.run(0, 1000000);
  if (result.status === 'error') {
    throw new Error(`Error: ${result.error.message}`);
  }
  return session;
}

// ---------- Flatten ----------

Deno.test("flatten: Add(Add(a, b), c) → Add(a, b, c) — sorted alphabetically", () => {
  const session = run(`
    let e = Exact.Expression.add(Exact.Expression.add(Exact.Pi, Exact.E), Exact.Infinity);
    let r = Exact.Expression.simplify(e);
    let count = Exact.Expression.argumentCount(r);
  `);
  const value = session.getExact(0, 'r');
  assertEquals(value.head.description, 'Add');
  assertEquals(value.arguments.length, 3);
  assertEquals(session.get(0, 'count'), 3);
  // 2d.3 sorts commutative args alphabetically: E < Infinity < Pi.
  assertEquals(value.arguments[0].description, 'E');
  assertEquals(value.arguments[1].description, 'Infinity');
  assertEquals(value.arguments[2].description, 'Pi');
});

Deno.test("flatten: Multiply(Multiply(a, b), c) → Multiply(a, b, c)", () => {
  const session = run(`
    let r = Exact.Expression.simplify(
      Exact.Expression.multiply(
        Exact.Expression.multiply(Exact.Pi, Exact.E),
        Exact.Infinity));
    let count = Exact.Expression.argumentCount(r);
  `);
  assertEquals(session.get(0, 'count'), 3);
});

Deno.test("flatten: three-level deep Add nest flattens fully", () => {
  const session = run(`
    let r = Exact.Expression.simplify(
      Exact.Expression.add(
        Exact.Expression.add(
          Exact.Expression.add(Exact.Pi, Exact.E),
          Symbol.for('x')),
        Symbol.for('y')));
  `);
  const value = session.getExact(0, 'r');
  assertEquals(value.head.description, 'Add');
  assertEquals(value.arguments.length, 4);
});

Deno.test("flatten: Add and Multiply don't mix — the Add factor distributes instead (3b)", () => {
  // Multiply(Add(a, b), c) never SPLICES (different heads); under
  // Ring 3b it distributes: (Pi + E)·Infinity → Pi·Infinity + E·Infinity.
  const session = run(`
    let inner = Exact.Expression.add(Exact.Pi, Exact.E);
    let outer = Exact.Expression.multiply(inner, Exact.Infinity);
    let r = Exact.Expression.simplify(outer);
    let count = Exact.Expression.argumentCount(r);
  `);
  assertEquals(session.get(0, 'count'), 2);
  const value = session.getExact(0, 'r');
  assertEquals(value.head.description, 'Add');
  assertEquals(value.arguments[0].head.description, 'Multiply');
  assertEquals(value.arguments[1].head.description, 'Multiply');
});

// ---------- Constant folding ----------

Deno.test("fold: Add(1, 2, 3) → 6", () => {
  assertEquals(
    run(`
      let r = Exact.Expression.simplify(
        Exact.Expression.make(Exact.Expression.Add, [1n, 2n, 3n]));
    `).get(0, 'r'),
    6n
  );
});

Deno.test("fold: Multiply(2, 3, 4) → 24", () => {
  assertEquals(
    run(`
      let r = Exact.Expression.simplify(
        Exact.Expression.make(Exact.Expression.Multiply, [2n, 3n, 4n]));
    `).get(0, 'r'),
    24n
  );
});

Deno.test("fold: Add(1, x, 2) → Add(x, 3) (fold + Ring 3 monomial order)", () => {
  const session = run(`
    let x = Symbol.for('x');
    let r = Exact.Expression.simplify(
      Exact.Expression.make(Exact.Expression.Add, [1n, x, 2n]));
  `);
  const value = session.getExact(0, 'r');
  assertEquals(value.head.description, 'Add');
  assertEquals(value.arguments.length, 2);
  assertEquals(value.arguments[0].description, 'x');
  assertEquals(value.arguments[1], 3n);
});

Deno.test("fold: Add(Pi, 1, 2) → Add(Pi, 3) (constant term last)", () => {
  const session = run(`
    let r = Exact.Expression.simplify(
      Exact.Expression.make(Exact.Expression.Add, [Exact.Pi, 1n, 2n]));
  `);
  const value = session.getExact(0, 'r');
  assertEquals(value.head.description, 'Add');
  assertEquals(value.arguments.length, 2);
  // Ring 3 monomial order: degree-1 terms first, the constant last.
  assertEquals(value.arguments[0].description, 'Pi');
  assertEquals(value.arguments[1], 3n);
});

Deno.test("fold: Rational + BigInt correctly promotes", () => {
  // Ring 1 arithmetic: Rational + BigInt → Rational.
  const session = run(`
    let r = Exact.Expression.simplify(
      Exact.Expression.add(Exact.rational(1n, 2n), 1n));
  `);
  assertEquals(session.getExact(0, 'r'), {
    kind: 'rational', numerator: 3n, denominator: 2n
  });
});

Deno.test("fold: Rationals add exactly — 1/2 + 1/3 = 5/6", () => {
  const session = run(`
    let r = Exact.Expression.simplify(
      Exact.Expression.add(Exact.rational(1n, 2n), Exact.rational(1n, 3n)));
  `);
  assertEquals(session.getExact(0, 'r'), {
    kind: 'rational', numerator: 5n, denominator: 6n
  });
});

Deno.test("fold: Complex + Rational promotes to Complex", () => {
  const session = run(`
    let r = Exact.Expression.simplify(
      Exact.Expression.add(Exact.i, 1n));
  `);
  assertEquals(session.getExact(0, 'r'), {
    kind: 'complex',
    real: { kind: 'rational', numerator: 1n, denominator: 1n },
    imaginary: { kind: 'rational', numerator: 1n, denominator: 1n }
  });
});

// ---------- Zero-arg identities ----------

Deno.test("zero-arg: Add() → 0", () => {
  assertEquals(
    run(`let r = Exact.Expression.simplify(Exact.Expression.make(Exact.Expression.Add, []));`).get(0, 'r'),
    0
  );
});

Deno.test("zero-arg: Multiply() → 1", () => {
  assertEquals(
    run(`let r = Exact.Expression.simplify(Exact.Expression.make(Exact.Expression.Multiply, []));`).get(0, 'r'),
    1
  );
});

// ---------- N-ary identity / annihilation ----------

Deno.test("n-ary: Add(0, x, 0, y) → Add(x, y)", () => {
  const session = run(`
    let x = Symbol.for('x');
    let y = Symbol.for('y');
    let r = Exact.Expression.simplify(
      Exact.Expression.make(Exact.Expression.Add, [0n, x, 0n, y]));
  `);
  const value = session.getExact(0, 'r');
  assertEquals(value.head.description, 'Add');
  assertEquals(value.arguments.length, 2);
  assertEquals(value.arguments[0].description, 'x');
  assertEquals(value.arguments[1].description, 'y');
});

Deno.test("n-ary: Multiply(1, x, 1, y) → Multiply(x, y)", () => {
  const session = run(`
    let x = Symbol.for('x');
    let y = Symbol.for('y');
    let r = Exact.Expression.simplify(
      Exact.Expression.make(Exact.Expression.Multiply, [1n, x, 1n, y]));
  `);
  const value = session.getExact(0, 'r');
  assertEquals(value.head.description, 'Multiply');
  assertEquals(value.arguments.length, 2);
});

Deno.test("n-ary: Multiply(Pi, 0, E) → 0 (annihilation wins over identity)", () => {
  assertEquals(
    run(`
      let r = Exact.Expression.simplify(
        Exact.Expression.make(Exact.Expression.Multiply, [Exact.Pi, 0n, Exact.E]));
    `).get(0, 'r'),
    0
  );
});

Deno.test("n-ary: Multiply(2, x, 3, y, 4) → Multiply(24, x, y)", () => {
  const session = run(`
    let x = Symbol.for('x');
    let y = Symbol.for('y');
    let r = Exact.Expression.simplify(
      Exact.Expression.make(Exact.Expression.Multiply, [2n, x, 3n, y, 4n]));
  `);
  const value = session.getExact(0, 'r');
  assertEquals(value.head.description, 'Multiply');
  assertEquals(value.arguments.length, 3);
  assertEquals(value.arguments[0], 24n);  // fold at first-numeric index (0)
  assertEquals(value.arguments[1].description, 'x');
  assertEquals(value.arguments[2].description, 'y');
});

// ---------- Order preservation ----------

Deno.test("sort: Add(Pi, 1) canonicalizes to Add(Pi, 1) (constant last)", () => {
  const session = run(`
    let r = Exact.Expression.simplify(Exact.Expression.add(Exact.Pi, 1n));
  `);
  const value = session.getExact(0, 'r');
  assertEquals(value.head.description, 'Add');
  assertEquals(value.arguments.length, 2);
  assertEquals(value.arguments[0].description, 'Pi');
  assertEquals(value.arguments[1], 1n);
});

Deno.test("sort: Add(1, Pi) canonicalizes to Add(Pi, 1) (Ring 3 monomial order)", () => {
  const session = run(`
    let r = Exact.Expression.simplify(Exact.Expression.add(1n, Exact.Pi));
  `);
  const value = session.getExact(0, 'r');
  assertEquals(value.arguments[0].description, 'Pi');
  assertEquals(value.arguments[1], 1n);
});

Deno.test("sort: commutativity — Add(Pi, 1) equals Add(1, Pi) after simplify", () => {
  const session = run(`
    let a = Exact.Expression.add(Exact.Pi, 1n);
    let b = Exact.Expression.add(1n, Exact.Pi);
    let match = Exact.Expression.equal(
      Exact.Expression.simplify(a),
      Exact.Expression.simplify(b));
  `);
  assertEquals(session.get(0, 'match'), true);
});

// ---------- Flatten + fold together ----------

Deno.test("combined: Add(Add(1, x), Add(2, y)) → Add(x, y, 3)", () => {
  const session = run(`
    let x = Symbol.for('x');
    let y = Symbol.for('y');
    let r = Exact.Expression.simplify(
      Exact.Expression.add(
        Exact.Expression.add(1n, x),
        Exact.Expression.add(2n, y)));
  `);
  const value = session.getExact(0, 'r');
  assertEquals(value.head.description, 'Add');
  assertEquals(value.arguments.length, 3);
  // Ring 3 monomial order: x before y (lex), the constant last.
  assertEquals(value.arguments[0].description, 'x');
  assertEquals(value.arguments[1].description, 'y');
  assertEquals(value.arguments[2], 3n);
});

Deno.test("combined: nested Multiply with make flattens and folds", () => {
  // Build Multiply(2, Multiply(3, x, Multiply(4, y))) using make for n-ary.
  // Flatten: [2, 3, x, 4, y]. Fold: 2*3*4=24, first-numeric at index 0.
  // Result: Multiply(24, x, y).
  const session = run(`
    let x = Symbol.for('x');
    let y = Symbol.for('y');
    let innermost = Exact.Expression.make(Exact.Expression.Multiply, [4n, y]);
    let middle = Exact.Expression.make(Exact.Expression.Multiply, [3n, x, innermost]);
    let outer = Exact.Expression.make(Exact.Expression.Multiply, [2n, middle]);
    let r = Exact.Expression.simplify(outer);
  `);
  const value = session.getExact(0, 'r');
  assertEquals(value.head.description, 'Multiply');
  assertEquals(value.arguments.length, 3);
  assertEquals(value.arguments[0], 24n);
  assertEquals(value.arguments[1].description, 'x');
  assertEquals(value.arguments[2].description, 'y');
});

Deno.test("Multiply.make supports n-ary directly", () => {
  // Just verifying the plumbing: make with 5 args fold works.
  const session = run(`
    let r = Exact.Expression.simplify(
      Exact.Expression.make(Exact.Expression.Multiply, [2n, 3n, 4n, 5n, 6n]));
  `);
  assertEquals(session.get(0, 'r'), 720n);  // 2*3*4*5*6
});

// ---------- Bottom-up still works ----------

Deno.test("bottom-up: inner fold cascades", () => {
  // Multiply(Add(1, 2), x) → Multiply(3, x) (inner Add folds to 3 first).
  const session = run(`
    let x = Symbol.for('x');
    let r = Exact.Expression.simplify(
      Exact.Expression.multiply(Exact.Expression.add(1n, 2n), x));
  `);
  const value = session.getExact(0, 'r');
  assertEquals(value.head.description, 'Multiply');
  assertEquals(value.arguments.length, 2);
  assertEquals(value.arguments[0], 3n);
  assertEquals(value.arguments[1].description, 'x');
});

// ---------- Idempotence ----------

Deno.test("idempotent: simplify(simplify(e)) equals simplify(e)", () => {
  const session = run(`
    let x = Symbol.for('x');
    let e = Exact.Expression.make(Exact.Expression.Add,
      [1n, x, 2n, Exact.Expression.add(3n, x), 4n]);
    let once = Exact.Expression.simplify(e);
    let twice = Exact.Expression.simplify(once);
    let same = Exact.Expression.equal(once, twice);
  `);
  assertEquals(session.get(0, 'same'), true);
});

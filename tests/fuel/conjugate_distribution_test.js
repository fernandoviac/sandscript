/**
 * Ring 5 (5a) — Conjugate distribution in simplify, completing the
 * Ring 4 Q5 deferral.
 *
 * New rules:
 *   Conjugate(Add(a, ...))      -> Add(Conjugate(a), ...)
 *   Conjugate(Multiply(a, ...)) -> Multiply(Conjugate(a), ...)
 *   Conjugate(Power(b, n))      -> Power(Conjugate(b), n)  (integer n,
 *                                  positive or negative)
 *   Conjugate(Matrix atom)      -> entry-conjugated Matrix
 * Rational/symbolic Power exponents stay opaque (branch cuts), and
 * Conjugate(Symbol) remains an honorary atom to collection.
 */

import { assertEquals } from "https://deno.land/std@0.208.0/assert/mod.ts";
import { parseAndSetup } from './test-helpers.js';
import { freshSession } from '../../src/host-owned-session.js';

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

function conjugateOf(argExpr) {
  return `Exact.Expression.make(Exact.Expression.Conjugate, [${argExpr}])`;
}

Deno.test("distributes over Add and folds the numeric child", () => {
  const session = run(`
    let e = Exact.Expression.simplify(
      ${conjugateOf(`Exact.Expression.add(Symbol.for('x'), Exact.complex(1n, 2n))`)});
  `);
  const value = session.getExact(0, 'e');
  assertEquals(value.head.description, 'Add');
  // Canonical Add order puts the folded numeric constant LAST.
  assertEquals(value.arguments[0].head.description, 'Conjugate');
  assertEquals(value.arguments[0].arguments[0].description, 'x');
  assertEquals(value.arguments[1].kind, 'complex');
  assertEquals(value.arguments[1].imaginary, rational(-2n));
});

Deno.test("distributes over Multiply", () => {
  const session = run(`
    let e = Exact.Expression.simplify(
      ${conjugateOf(`Exact.Expression.multiply(Symbol.for('x'), Symbol.for('y'))`)});
  `);
  const value = session.getExact(0, 'e');
  assertEquals(value.head.description, 'Multiply');
  assertEquals(value.arguments[0].head.description, 'Conjugate');
  assertEquals(value.arguments[1].head.description, 'Conjugate');
});

Deno.test("distributes through an n-ary flattened Add", () => {
  const session = run(`
    let sum = Exact.Expression.make(Exact.Expression.Add,
      [Symbol.for('x'), Symbol.for('y'), 3n]);
    let e = Exact.Expression.simplify(${conjugateOf('sum')});
  `);
  const value = session.getExact(0, 'e');
  assertEquals(value.head.description, 'Add');
  assertEquals(value.arguments.length, 3);
  assertEquals(value.arguments[0].head.description, 'Conjugate');
  assertEquals(value.arguments[2], 3n);
});

Deno.test("distributes through Power with positive integer exponent", () => {
  const session = run(`
    let e = Exact.Expression.simplify(
      ${conjugateOf(`Exact.Expression.power(Symbol.for('x'), 3n)`)});
  `);
  const value = session.getExact(0, 'e');
  assertEquals(value.head.description, 'Power');
  assertEquals(value.arguments[0].head.description, 'Conjugate');
  assertEquals(value.arguments[1], 3n);
});

Deno.test("distributes through Power with negative integer exponent", () => {
  const session = run(`
    let e = Exact.Expression.simplify(
      ${conjugateOf(`Exact.Expression.power(Symbol.for('x'), -2n)`)});
  `);
  const value = session.getExact(0, 'e');
  assertEquals(value.head.description, 'Power');
  assertEquals(value.arguments[0].head.description, 'Conjugate');
  assertEquals(value.arguments[1], -2n);
});

Deno.test("stays opaque on symbolic and rational Power exponents", () => {
  const session = run(`
    let symbolic = Exact.Expression.simplify(
      ${conjugateOf(`Exact.Expression.power(Symbol.for('x'), Symbol.for('y'))`)});
    let fractional = Exact.Expression.simplify(
      ${conjugateOf(`Exact.Expression.power(Symbol.for('x'), Exact.rational(1n, 2n))`)});
  `);
  assertEquals(session.getExact(0, 'symbolic').head.description, 'Conjugate');
  assertEquals(session.getExact(0, 'fractional').head.description, 'Conjugate');
});

Deno.test("distribution + numeric power fold compose", () => {
  // Conjugate((1+i)^2) -> Conjugate(1+i)^2 -> (1-i)^2 -> -2i.
  const session = run(`
    let e = Exact.Expression.simplify(
      ${conjugateOf(`Exact.Expression.power(Exact.complex(1n, 1n), 2n)`)});
  `);
  const value = session.getExact(0, 'e');
  assertEquals(value.kind, 'complex');
  assertEquals(value.real, rational(0n));
  assertEquals(value.imaginary, rational(-2n));
});

Deno.test("Divide desugar composes with distribution", () => {
  // Conjugate(x / y): the child simplifies to Multiply(x, Power(y, -1))
  // first, then Conjugate distributes across both factors.
  const session = run(`
    let e = Exact.Expression.simplify(
      ${conjugateOf(`Exact.Expression.divide(Symbol.for('x'), Symbol.for('y'))`)});
  `);
  const value = session.getExact(0, 'e');
  assertEquals(value.head.description, 'Multiply');
  assertEquals(value.arguments[0].head.description, 'Conjugate');
  assertEquals(value.arguments[1].head.description, 'Power');
  assertEquals(value.arguments[1].arguments[0].head.description, 'Conjugate');
  assertEquals(value.arguments[1].arguments[1], rational(-1n));
});

Deno.test("Subtract desugar composes with distribution", () => {
  // Conjugate(x - 2) -> Add(-2, Conjugate(x)).
  const session = run(`
    let e = Exact.Expression.simplify(
      ${conjugateOf(`Exact.Expression.subtract(Symbol.for('x'), 2n)`)});
  `);
  const value = session.getExact(0, 'e');
  assertEquals(value.head.description, 'Add');
  assertEquals(value.arguments[0].head.description, 'Conjugate');
  assertEquals(value.arguments[1], rational(-2n));
});

Deno.test("Conjugate(Matrix atom) folds entry-wise", () => {
  const session = run(`
    let m = Exact.Matrix.make([[Exact.complex(1n, 2n), 3n], [Symbol.for('x'), 5n]]);
    let e = Exact.Expression.simplify(${conjugateOf('m')});
    let isMatrix = Exact.Matrix.isMatrix(e);
    let e00 = Exact.Matrix.get(e, 0, 0);
    let e01 = Exact.Matrix.get(e, 0, 1);
    let e10 = Exact.Matrix.get(e, 1, 0);
  `);
  assertEquals(session.get(0, 'isMatrix'), true);
  const conjugated = session.getExact(0, 'e00');
  assertEquals(conjugated.imaginary, rational(-2n));
  assertEquals(session.getExact(0, 'e01'), 3n);
  assertEquals(session.getExact(0, 'e10').head.description, 'Conjugate');
});

Deno.test("matrix fold matches conjugateTranspose of the transpose", () => {
  const session = run(`
    let m = Exact.Matrix.make([[Exact.complex(1n, 2n), Symbol.for('x')],
                               [3n, Exact.complex(0n, 1n)]]);
    let folded = Exact.Expression.simplify(${conjugateOf('m')});
    let viaTranspose = Exact.Matrix.conjugateTranspose(Exact.Matrix.transpose(m));
    let same = Exact.Matrix.equal(folded, viaTranspose);
  `);
  assertEquals(session.get(0, 'same'), true);
});

Deno.test("collection still works on the remaining opaque atoms", () => {
  // Conjugate(x) + Conjugate(x) -> 2 * Conjugate(x): distribution did
  // not break the honorary-atom treatment of Conjugate(Symbol).
  const session = run(`
    let c = ${conjugateOf(`Symbol.for('x')`)};
    let e = Exact.Expression.simplify(Exact.Expression.add(c, c));
  `);
  const value = session.getExact(0, 'e');
  assertEquals(value.head.description, 'Multiply');
  assertEquals(value.arguments[0], rational(2n));
  assertEquals(value.arguments[1].head.description, 'Conjugate');
});

Deno.test("conjugateTranspose entries distribute under a later simplify", () => {
  // conjugateTranspose wraps the symbolic Add entry as Conjugate(Add(...));
  // simplify then distributes it down to the atoms.
  const session = run(`
    let m = Exact.Matrix.make([[Exact.Expression.add(Symbol.for('x'), Exact.complex(0n, 1n))]]);
    let ct = Exact.Matrix.conjugateTranspose(m);
    let entry = Exact.Matrix.get(ct, 0, 0);
  `);
  const value = session.getExact(0, 'entry');
  assertEquals(value.head.description, 'Add');
  assertEquals(value.arguments[0].head.description, 'Conjugate');
  assertEquals(value.arguments[1].kind, 'complex');
  assertEquals(value.arguments[1].imaginary, rational(-1n));
});

Deno.test("double conjugate through distribution round-trips", () => {
  // Conjugate(Conjugate(x + i)) simplifies back to Add(i, x)'s canonical
  // form: distribution + numeric folds + double-conjugate collapse.
  const session = run(`
    let sum = Exact.Expression.add(Symbol.for('x'), Exact.complex(0n, 1n));
    let e = Exact.Expression.simplify(${conjugateOf(conjugateOf('sum'))});
    let direct = Exact.Expression.simplify(sum);
    let same = Exact.Expression.equal(e, direct);
  `);
  assertEquals(session.get(0, 'same'), true);
});

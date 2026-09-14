/**
 * Ring 5 (5a) — Exact.Expression.match(pattern, subject, variables).
 *
 * Structural pattern matching (Q4): Symbols listed in `variables` are
 * pattern variables — first occurrence binds, repeats must agree
 * (structural equality); unlisted Symbols are constants matching only
 * themselves. Heads and arity must agree exactly (no AC-matching —
 * canonical forms via simplify recover most of its value). Pattern
 * Matrices match subject Matrices shape-first, then entry-wise
 * (Ring 4's owed matrix pattern matching). Returns a frozen Array of
 * bound values aligned with `variables`, or null on no match.
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

Deno.test("Equal and NotEqual are registered heads on the Expression namespace", () => {
  const session = run(`
    let eq = Exact.Expression.Equal === Symbol.for('Equal');
    let ne = Exact.Expression.NotEqual === Symbol.for('NotEqual');
  `);
  assertEquals(session.get(0, 'eq'), true);
  assertEquals(session.get(0, 'ne'), true);
});

Deno.test("Equal does not fold in simplify — statements are not booleans", () => {
  const session = run(`
    let e = Exact.Expression.simplify(
      Exact.Expression.make(Exact.Expression.Equal, [2n, 2n]));
  `);
  const value = session.getExact(0, 'e');
  assertEquals(value.kind, 'expression');
  assertEquals(value.head.description, 'Equal');
});

Deno.test("simplify recurses into Equal's arguments", () => {
  const session = run(`
    let lhs = Exact.Expression.add(1n, 2n);
    let e = Exact.Expression.simplify(
      Exact.Expression.make(Exact.Expression.Equal, [lhs, Symbol.for('x')]));
  `);
  const value = session.getExact(0, 'e');
  assertEquals(value.head.description, 'Equal');
  assertEquals(value.arguments[0], 3n);
  assertEquals(value.arguments[1].description, 'x');
});

Deno.test("variable binds the corresponding subterm", () => {
  const session = run(`
    let x = Symbol.for('x');
    let y = Symbol.for('y');
    let pattern = Exact.Expression.add(x, y);
    let subject = Exact.Expression.add(Symbol.for('a'), 2n);
    let bindings = Exact.Expression.match(pattern, subject, [x, y]);
  `);
  const bindings = session.getExact(0, 'bindings');
  assertEquals(bindings.length, 2);
  assertEquals(bindings[0].description, 'a');
  assertEquals(bindings[1], 2n);
});

Deno.test("binding order follows the variables array, not occurrence order", () => {
  const session = run(`
    let x = Symbol.for('x');
    let y = Symbol.for('y');
    let pattern = Exact.Expression.add(x, y);
    let subject = Exact.Expression.add(1n, 2n);
    let bindings = Exact.Expression.match(pattern, subject, [y, x]);
  `);
  const bindings = session.getExact(0, 'bindings');
  assertEquals(bindings[0], 2n);
  assertEquals(bindings[1], 1n);
});

Deno.test("head mismatch and arity mismatch return null", () => {
  const session = run(`
    let x = Symbol.for('x');
    let pattern = Exact.Expression.add(x, 1n);
    let headMiss = Exact.Expression.match(pattern, Exact.Expression.multiply(2n, 1n), [x]);
    let arityMiss = Exact.Expression.match(pattern,
      Exact.Expression.make(Exact.Expression.Add, [2n, 1n, 3n]), [x]);
  `);
  assertEquals(session.get(0, 'headMiss'), null);
  assertEquals(session.get(0, 'arityMiss'), null);
});

Deno.test("unlisted Symbols are constants matching only themselves", () => {
  const session = run(`
    let x = Symbol.for('x');
    let a = Symbol.for('a');
    let pattern = Exact.Expression.add(x, a);
    let hit = Exact.Expression.match(pattern, Exact.Expression.add(5n, a), [x]);
    let miss = Exact.Expression.match(pattern, Exact.Expression.add(5n, Symbol.for('b')), [x]);
  `);
  assertEquals(session.getExact(0, 'hit'), [5n]);
  assertEquals(session.get(0, 'miss'), null);
});

Deno.test("a variable can bind a whole subtree", () => {
  const session = run(`
    let x = Symbol.for('x');
    let pattern = Exact.Expression.power(x, 2n);
    let subject = Exact.Expression.power(
      Exact.Expression.add(Symbol.for('a'), Symbol.for('b')), 2n);
    let bindings = Exact.Expression.match(pattern, subject, [x]);
  `);
  const bindings = session.getExact(0, 'bindings');
  assertEquals(bindings[0].head.description, 'Add');
});

Deno.test("non-linear pattern: repeated variable must bind equal values", () => {
  const session = run(`
    let x = Symbol.for('x');
    let pattern = Exact.Expression.add(x, x);
    let hit = Exact.Expression.match(pattern,
      Exact.Expression.add(Symbol.for('a'), Symbol.for('a')), [x]);
    let miss = Exact.Expression.match(pattern,
      Exact.Expression.add(Symbol.for('a'), Symbol.for('b')), [x]);
  `);
  assertEquals(session.getExact(0, 'hit').length, 1);
  assertEquals(session.get(0, 'miss'), null);
});

Deno.test("non-linear agreement is semantic on numerics (2 vs 2n)", () => {
  const session = run(`
    let x = Symbol.for('x');
    let pattern = Exact.Expression.add(x, x);
    let hit = Exact.Expression.match(pattern,
      Exact.Expression.make(Exact.Expression.Add, [2n, Exact.rational(2n, 1n)]), [x]);
  `);
  assertEquals(session.getExact(0, 'hit').length, 1);
});

Deno.test("numeric pattern atoms match semantically", () => {
  const session = run(`
    let x = Symbol.for('x');
    let pattern = Exact.Expression.add(x, Exact.rational(2n, 1n));
    let hit = Exact.Expression.match(pattern, Exact.Expression.add(Symbol.for('a'), 2n), [x]);
  `);
  assertEquals(session.getExact(0, 'hit')[0].description, 'a');
});

Deno.test("atom-vs-atom match with no variables returns an empty Array or null", () => {
  const session = run(`
    let hit = Exact.Expression.match(2n, Exact.rational(2n, 1n), []);
    let miss = Exact.Expression.match(2n, 3n, []);
    let hitIsArray = Array.isArray(hit);
    let hitLength = hit.length;
  `);
  assertEquals(session.get(0, 'hitIsArray'), true);
  assertEquals(session.get(0, 'hitLength'), 0);
  assertEquals(session.get(0, 'miss'), null);
});

Deno.test("matrix pattern: shape-first, then entry-wise with binding", () => {
  const session = run(`
    let x = Symbol.for('x');
    let y = Symbol.for('y');
    let pattern = Exact.Matrix.make([[x, 0n], [0n, y]]);
    let subject = Exact.Matrix.make([[5n, 0n], [0n, 7n]]);
    let bindings = Exact.Expression.match(pattern, subject, [x, y]);
    let shapeMiss = Exact.Expression.match(pattern, Exact.Matrix.make([[5n, 0n]]), [x, y]);
  `);
  assertEquals(session.getExact(0, 'bindings'), [5n, 7n]);
  assertEquals(session.get(0, 'shapeMiss'), null);
});

Deno.test("matrix pattern: repeated variable enforces agreement across entries", () => {
  const session = run(`
    let x = Symbol.for('x');
    let pattern = Exact.Matrix.make([[x, 0n], [0n, x]]);
    let hit = Exact.Expression.match(pattern, Exact.Matrix.make([[5n, 0n], [0n, 5n]]), [x]);
    let miss = Exact.Expression.match(pattern, Exact.Matrix.make([[5n, 0n], [0n, 6n]]), [x]);
  `);
  assertEquals(session.getExact(0, 'hit'), [5n]);
  assertEquals(session.get(0, 'miss'), null);
});

Deno.test("matrix pattern inside an expression pattern", () => {
  const session = run(`
    let x = Symbol.for('x');
    let pattern = Exact.Expression.add(Exact.Matrix.make([[x]]), 1n);
    let subject = Exact.Expression.add(Exact.Matrix.make([[9n]]), 1n);
    let bindings = Exact.Expression.match(pattern, subject, [x]);
  `);
  assertEquals(session.getExact(0, 'bindings'), [9n]);
});

Deno.test("matrix entry can bind an expression subtree", () => {
  const session = run(`
    let x = Symbol.for('x');
    let pattern = Exact.Matrix.make([[x]]);
    let subject = Exact.Matrix.make([[Exact.Expression.add(Symbol.for('a'), 1n)]]);
    let bindings = Exact.Expression.match(pattern, subject, [x]);
  `);
  assertEquals(session.getExact(0, 'bindings')[0].head.description, 'Add');
});

Deno.test("matrix pattern vs non-matrix subject returns null", () => {
  const session = run(`
    let x = Symbol.for('x');
    let miss = Exact.Expression.match(Exact.Matrix.make([[x]]), 5n, [x]);
  `);
  assertEquals(session.get(0, 'miss'), null);
});

Deno.test("the bindings Array is frozen", () => {
  const session = run(`
    let x = Symbol.for('x');
    let bindings = Exact.Expression.match(x, 5n, [x]);
    let frozen = Array.isFrozen(bindings);
  `);
  assertEquals(session.get(0, 'frozen'), true);
});

Deno.test("validation: variables must be an Array of Symbols", () => {
  const session = run(`
    let notArray = false;
    try { Exact.Expression.match(2n, 2n, 5n); } catch (e) { notArray = e.message; }
    let notSymbol = false;
    try { Exact.Expression.match(2n, 2n, [5n]); } catch (e) { notSymbol = e.message; }
  `);
  assertEquals(session.get(0, 'notArray'),
    'Exact.Expression.match: variables must be an Array of distinct Symbols');
  assertEquals(session.get(0, 'notSymbol'),
    'Exact.Expression.match: variables must be an Array of distinct Symbols');
});

Deno.test("validation: duplicate variables throw", () => {
  const session = run(`
    let x = Symbol.for('x');
    let threw = false;
    try { Exact.Expression.match(x, 2n, [x, x]); } catch (e) { threw = e.message; }
  `);
  assertEquals(session.get(0, 'threw'),
    'Exact.Expression.match: variables must be an Array of distinct Symbols');
});

Deno.test("validation: a variable absent from the pattern throws", () => {
  const session = run(`
    let x = Symbol.for('x');
    let threw = false;
    try { Exact.Expression.match(2n, 2n, [x]); } catch (e) { threw = e.message; }
  `);
  assertEquals(session.get(0, 'threw'),
    'Exact.Expression.match: a listed variable does not occur in the pattern');
});

Deno.test("occurrence check sees variables inside matrix entries", () => {
  // The widened $expression_contains_value descends into Matrix atoms —
  // a variable occurring ONLY inside a matrix entry is a legal listing.
  const session = run(`
    let x = Symbol.for('x');
    let pattern = Exact.Expression.add(Exact.Matrix.make([[x]]), 1n);
    let bindings = Exact.Expression.match(pattern,
      Exact.Expression.add(Exact.Matrix.make([[4n]]), 1n), [x]);
  `);
  assertEquals(session.getExact(0, 'bindings'), [4n]);
});

Deno.test("substitute reaches matrix entries (Ring 5 (5a) widening)", () => {
  const session = run(`
    let x = Symbol.for('x');
    let m = Exact.Matrix.make([[x, 1n]]);
    let e = Exact.Expression.add(m, x);
    let sub = Exact.Expression.substitute(e, x, 7n);
    let entry = Exact.Matrix.get(Exact.Expression.args(sub)[0], 0, 0);
  `);
  assertEquals(session.getExact(0, 'entry'), 7n);
});

Deno.test("substitute reaches nested matrix-in-matrix entries", () => {
  const session = run(`
    let x = Symbol.for('x');
    let inner = Exact.Matrix.make([[x]]);
    let outer = Exact.Matrix.make([[inner]]);
    let e = Exact.Expression.add(outer, 0n);
    let sub = Exact.Expression.simplify(Exact.Expression.substitute(e, x, 3n));
    let entry = Exact.Matrix.get(Exact.Matrix.get(sub, 0, 0), 0, 0);
  `);
  assertEquals(session.getExact(0, 'entry'), 3n);
});

Deno.test("substitute on a bare Matrix value reaches its entries", () => {
  const session = run(`
    let x = Symbol.for('x');
    let m = Exact.Matrix.make([[Exact.Expression.add(x, 1n)]]);
    let sub = Exact.Expression.substitute(m, x, 2n);
    let entry = Exact.Expression.simplify(Exact.Matrix.get(sub, 0, 0));
    let isMatrix = Exact.Matrix.isMatrix(sub);
  `);
  assertEquals(session.get(0, 'isMatrix'), true);
  assertEquals(session.getExact(0, 'entry'), 3n);
});

Deno.test("substituted matrix keeps its shape and untouched entries", () => {
  const session = run(`
    let x = Symbol.for('x');
    let m = Exact.Matrix.make([[x, 2n], [Symbol.for('y'), 4n]]);
    let sub = Exact.Expression.substitute(m, x, 9n);
    let rows = Exact.Matrix.rows(sub);
    let columns = Exact.Matrix.columns(sub);
    let e01 = Exact.Matrix.get(sub, 0, 1);
    let e10 = Exact.Matrix.get(sub, 1, 0);
  `);
  assertEquals(session.get(0, 'rows'), 2);
  assertEquals(session.get(0, 'columns'), 2);
  assertEquals(session.getExact(0, 'e01'), 2n);
  assertEquals(session.getExact(0, 'e10').description, 'y');
});

Deno.test("match survives gc (bindings are real heap values)", () => {
  const session = run(`
    let x = Symbol.for('x');
    let subject = Exact.Expression.add(Exact.Expression.power(Symbol.for('a'), 3n), 2n);
    let pattern = Exact.Expression.add(x, 2n);
    let bindings = Exact.Expression.match(pattern, subject, [x]);
    let arr = [];
    for (let i = 0; i < 2000; i = i + 1) { arr.push([i, i, i]); }
    let stillThere = Exact.Expression.kind(bindings[0]) === Exact.Expression.Power;
  `);
  assertEquals(session.get(0, 'stillThere'), true);
});

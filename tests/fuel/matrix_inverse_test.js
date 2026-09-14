/**
 * Ring 4 (4d) — Exact.Matrix.inverse via the shared fraction-free
 * engine (Montante on [M | I]). Throws on singular and non-square.
 */

import { assertEquals, assert, assertThrows } from "https://deno.land/std@0.208.0/assert/mod.ts";
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

Deno.test("inverse: identity is its own inverse at several sizes", () => {
  const session = run(`
    let ok = true;
    for (let n = 0; n < 5; n = n + 1) {
      let i = Exact.Matrix.identity(n);
      ok = ok && Exact.Matrix.equal(Exact.Matrix.inverse(i), i);
    }
  `);
  assertEquals(session.get(0, 'ok'), true);
});

Deno.test("inverse: known 2x2", () => {
  const session = run(`
    let inv = Exact.Matrix.inverse(Exact.Matrix.make([[1n, 2n], [3n, 4n]]));
  `);
  // [[1,2],[3,4]]^-1 = [[-2, 1], [3/2, -1/2]]
  assertEquals(session.getExact(0, 'inv').entries, [
    [rational(-2n), rational(1n)],
    [rational(3n, 2n), rational(-1n, 2n)],
  ]);
});

Deno.test("inverse: 1x1", () => {
  const session = run(`
    let inv = Exact.Matrix.inverse(Exact.Matrix.make([[2n]]));
  `);
  assertEquals(session.getExact(0, 'inv').entries, [[rational(1n, 2n)]]);
});

Deno.test("inverse: multiply(A, inverse(A)) is the identity (3x3 numeric)", () => {
  const session = run(`
    let a = Exact.Matrix.make([[1n, 2n, 3n], [4n, 5n, 6n], [7n, 8n, 10n]]);
    let inv = Exact.Matrix.inverse(a);
    let right = Exact.Matrix.equal(Exact.Matrix.multiply(a, inv), Exact.Matrix.identity(3));
    let left = Exact.Matrix.equal(Exact.Matrix.multiply(inv, a), Exact.Matrix.identity(3));
  `);
  assertEquals(session.get(0, 'right'), true);
  assertEquals(session.get(0, 'left'), true);
});

Deno.test("inverse: rational entries stay exact", () => {
  const session = run(`
    let a = Exact.Matrix.make([
      [Exact.rational(1n, 2n), Exact.rational(1n, 3n)],
      [Exact.rational(1n, 4n), Exact.rational(1n, 5n)]]);
    let ok = Exact.Matrix.equal(
      Exact.Matrix.multiply(a, Exact.Matrix.inverse(a)),
      Exact.Matrix.identity(2));
  `);
  assertEquals(session.get(0, 'ok'), true);
});

Deno.test("inverse: permutation matrix (zero pivots force swaps)", () => {
  const session = run(`
    let p = Exact.Matrix.make([[0n, 1n], [1n, 0n]]);
    let ok = Exact.Matrix.equal(Exact.Matrix.inverse(p), p);
  `);
  assertEquals(session.get(0, 'ok'), true);
});

Deno.test("inverse: complex entries", () => {
  const session = run(`
    let a = Exact.Matrix.diagonal([Exact.i, Exact.i]);
    let ok = Exact.Matrix.equal(
      Exact.Matrix.multiply(a, Exact.Matrix.inverse(a)),
      Exact.Matrix.identity(2));
  `);
  assertEquals(session.get(0, 'ok'), true);
});

Deno.test("inverse: symbolic diagonal verified by substitution", () => {
  const session = run(`
    let x = Symbol.for('x');
    let inv = Exact.Matrix.inverse(Exact.Matrix.diagonal([x, 2n]));
    let e = Exact.Matrix.get(inv, 0, 0);
    let atFive = Exact.Expression.simplify(Exact.Expression.substitute(e, x, 5n));
    let ok = Exact.equal(atFive, Exact.rational(1n, 5n));
    let corner = Exact.Matrix.get(inv, 1, 1);
    let cornerOk = Exact.equal(corner, Exact.rational(1n, 2n));
  `);
  assertEquals(session.get(0, 'ok'), true);
  assertEquals(session.get(0, 'cornerOk'), true);
});

Deno.test("inverse: singular matrix throws", () => {
  expectError(`let inv = Exact.Matrix.inverse(Exact.Matrix.make([[1n, 2n], [2n, 4n]]));`);
  expectError(`let inv = Exact.Matrix.inverse(Exact.Matrix.zero(3, 3));`);
});

Deno.test("inverse: non-square throws", () => {
  expectError(`let inv = Exact.Matrix.inverse(Exact.Matrix.zero(2, 3));`);
});

Deno.test("inverse: non-Matrix throws", () => {
  expectError(`let inv = Exact.Matrix.inverse(5);`);
});

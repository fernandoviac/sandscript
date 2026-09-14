/**
 * Ring 4 (4d) — Exact.Matrix.rank: pivot count of the fraction-free
 * reduction. For symbolic entries the rank is conditional on the
 * pivoting Symbols being nonzero.
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

Deno.test("rank: identity(n) has rank n", () => {
  const session = run(`
    let r3 = Exact.Matrix.rank(Exact.Matrix.identity(3));
    let r5 = Exact.Matrix.rank(Exact.Matrix.identity(5));
  `);
  assertEquals(session.get(0, 'r3'), 3);
  assertEquals(session.get(0, 'r5'), 5);
});

Deno.test("rank: zero matrix has rank 0", () => {
  const session = run(`
    let r = Exact.Matrix.rank(Exact.Matrix.zero(3, 3));
  `);
  assertEquals(session.get(0, 'r'), 0);
});

Deno.test("rank: zero-size matrices have rank 0", () => {
  const session = run(`
    let a = Exact.Matrix.rank(Exact.Matrix.make([]));
    let b = Exact.Matrix.rank(Exact.Matrix.zero(0, 5));
    let c = Exact.Matrix.rank(Exact.Matrix.zero(5, 0));
  `);
  assertEquals(session.get(0, 'a'), 0);
  assertEquals(session.get(0, 'b'), 0);
  assertEquals(session.get(0, 'c'), 0);
});

Deno.test("rank: known rank-deficient cases", () => {
  const session = run(`
    let r1 = Exact.Matrix.rank(Exact.Matrix.make([[1n, 2n], [2n, 4n]]));
    let r2 = Exact.Matrix.rank(Exact.Matrix.make([[1n, 2n, 3n], [4n, 5n, 6n], [7n, 8n, 9n]]));
  `);
  assertEquals(session.get(0, 'r1'), 1);
  assertEquals(session.get(0, 'r2'), 2);
});

Deno.test("rank: rectangular matrices", () => {
  const session = run(`
    let wide = Exact.Matrix.rank(Exact.Matrix.make([[1n, 2n, 3n], [4n, 5n, 6n]]));
    let tall = Exact.Matrix.rank(Exact.Matrix.make([[1n], [2n], [3n]]));
  `);
  assertEquals(session.get(0, 'wide'), 2);
  assertEquals(session.get(0, 'tall'), 1);
});

Deno.test("rank: symbolic pivots count as nonzero", () => {
  const session = run(`
    let x = Symbol.for('x');
    let r = Exact.Matrix.rank(Exact.Matrix.diagonal([x, 1n]));
  `);
  assertEquals(session.get(0, 'r'), 2);
});

Deno.test("rank: non-Matrix throws", () => {
  expectError(`let r = Exact.Matrix.rank('m');`);
});

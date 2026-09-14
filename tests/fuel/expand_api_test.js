/**
 * Ring 3 (3b) — Exact.Expression.expand: uncapped expansion.
 *
 * Same machinery as simplify's auto-expansion, with
 * MAX_EXPANSION_TERMS disabled: the user opted into the blow-up.
 * Idempotent; non-expression values pass through like simplify.
 */

import { assertEquals } from "https://deno.land/std@0.208.0/assert/mod.ts";
import { parseAndSetup } from './test-helpers.js';
import { freshSession } from '../../src/host-owned-session.js';

function run(source) {
  const session = freshSession({ heapSize: 16 * 1024 * 1024 });
  parseAndSetup(session, `
    let x = Symbol.for('x');
    let y = Symbol.for('y');
    let E = Exact.Expression;
    ${source}
  `);
  const result = session.run(0, 1000000000);
  if (result.status !== 'done') {
    throw new Error(`run ended ${result.status}: ${result.error?.message ?? ''}`);
  }
  return session;
}

Deno.test("expand: matches simplify under the cap", () => {
  const session = run(`
    let same = E.equal(
      E.expand(E.power(E.add(x, 1n), 3n)),
      E.simplify(E.power(E.add(x, 1n), 3n)));
  `);
  assertEquals(session.getExact(0, 'same'), true);
});

Deno.test("expand: (x + 1)^60 produces all 61 terms where simplify refuses", () => {
  const session = run(`
    let e = E.power(E.add(x, 1n), 60n);
    let kept = E.kind(E.simplify(e));
    let expanded = E.expand(e);
    let count = E.argumentCount(expanded);
    let kind = E.kind(expanded);
  `);
  assertEquals(session.getExact(0, 'kept').description, 'Power');
  assertEquals(session.getExact(0, 'kind').description, 'Add');
  assertEquals(session.get(0, 'count'), 61);
});

Deno.test("expand: exact coefficients — the middle term of (x + 1)^60 is C(60, 30)", () => {
  const session = run(`
    let expanded = E.expand(E.power(E.add(x, 1n), 60n));
    let middle = E.args(expanded)[30];
    let coefficient = E.args(middle)[0];
  `);
  // C(60, 30) = 118264581564861424, exactly.
  assertEquals(session.getExact(0, 'coefficient'),
    { kind: 'rational', numerator: 118264581564861424n, denominator: 1n });
});

Deno.test("expand: distribution past the product cap", () => {
  // 9 × 8 = 72 predicted terms — simplify refuses, expand distributes.
  const session = run(`
    let a = E.make(E.Add, [x, y, Symbol.for('a1'), Symbol.for('a2'), Symbol.for('a3'),
      Symbol.for('a4'), Symbol.for('a5'), Symbol.for('a6'), Symbol.for('a7')]);
    let b = E.make(E.Add, [1n, x, y, Symbol.for('a1'), Symbol.for('a2'),
      Symbol.for('a3'), Symbol.for('a4'), Symbol.for('a5')]);
    let kept = E.kind(E.simplify(E.multiply(a, b)));
    let kind = E.kind(E.expand(E.multiply(a, b)));
  `);
  assertEquals(session.getExact(0, 'kept').description, 'Multiply');
  assertEquals(session.getExact(0, 'kind').description, 'Add');
});

Deno.test("expand: idempotent — expand(expand(e)) equals expand(e)", () => {
  const session = run(`
    let e = E.power(E.add(x, 1n), 55n);
    let once = E.expand(e);
    let twice = E.expand(once);
    let same = E.equal(once, twice);
  `);
  assertEquals(session.getExact(0, 'same'), true);
});

Deno.test("expand: a later simplify keeps the cap for NEW expansions", () => {
  // expand must not leak its uncapped mode into subsequent simplify
  // calls.
  const session = run(`
    let big = E.power(E.add(x, 1n), 60n);
    let expanded = E.expand(big);
    let after = E.kind(E.simplify(big));
  `);
  assertEquals(session.getExact(0, 'after').description, 'Power');
});

Deno.test("expand: atoms and non-expressions pass through", () => {
  const session = run(`
    let sym = E.expand(x);
    let num = E.expand(42n);
    let isSym = sym === x;
  `);
  assertEquals(session.getExact(0, 'isSym'), true);
  assertEquals(session.getExact(0, 'num'), 42n);
});

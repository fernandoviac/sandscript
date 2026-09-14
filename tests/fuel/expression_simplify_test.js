/**
 * 2d.1 — Exact.Expression.simplify identity elimination.
 *
 * Bottom-up canonicalization. 2d.1 covers the local rewrite rules that
 * don't need numeric value traversal:
 *   Add(0, x)  / Add(x, 0)       → x
 *   Multiply(0, x) / (x, 0)      → 0
 *   Multiply(1, x) / (x, 1)      → x
 *   Power(x, 0)                  → 1
 *   Power(x, 1)                  → x
 *   Power(1, x)                  → 1
 *   Negate(Negate(x))            → x
 *   Add(x) / Multiply(x)         → x  (single-arg collapse)
 *
 * simplify is bottom-up: Multiply(Add(0, Pi), 2) becomes Multiply(Pi, 2)
 * because the inner Add(0, Pi) simplifies to Pi before the outer rule
 * looks at its args.
 *
 * Flatten, commutative sort, constant folding, and Subtract/Divide
 * desugar land in 2d.2 and 2d.3.
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

// ---------- atoms pass through ----------

Deno.test("simplify: Symbol passes through unchanged", () => {
  const session = run(`
    let p = Exact.Pi;
    let x = Exact.Expression.simplify(p);
    let same = x === p;
  `);
  assertEquals(session.get(0, 'same'), true);
});

Deno.test("simplify: BigInt passes through unchanged", () => {
  assertEquals(run(`let x = Exact.Expression.simplify(42n);`).get(0, 'x'), 42n);
});

Deno.test("simplify: Rational passes through unchanged", () => {
  assertEquals(
    run(`let x = Exact.Expression.simplify(Exact.rational(1n, 3n));`).getExact(0, 'x'),
    { kind: 'rational', numerator: 1n, denominator: 3n }
  );
});

// ---------- Add identity ----------

Deno.test("simplify: Add(0, x) → x", () => {
  const session = run(`
    let e = Exact.Expression.add(0n, Exact.Pi);
    let r = Exact.Expression.simplify(e);
    let isPi = r === Exact.Pi;
  `);
  assertEquals(session.get(0, 'isPi'), true);
});

Deno.test("simplify: Add(x, 0) → x", () => {
  const session = run(`
    let e = Exact.Expression.add(Exact.Pi, 0n);
    let r = Exact.Expression.simplify(e);
    let isPi = r === Exact.Pi;
  `);
  assertEquals(session.get(0, 'isPi'), true);
});

// ---------- Multiply identity / annihilation ----------

Deno.test("simplify: Multiply(0, x) → 0", () => {
  const session = run(`
    let e = Exact.Expression.multiply(0n, Exact.Pi);
    let r = Exact.Expression.simplify(e);
  `);
  assertEquals(session.getExact(0, 'r'), {
    kind: 'rational', numerator: 0n, denominator: 1n
  });
});

Deno.test("simplify: Multiply(x, 0) → 0", () => {
  const session = run(`
    let e = Exact.Expression.multiply(Exact.Pi, 0n);
    let r = Exact.Expression.simplify(e);
  `);
  assertEquals(session.getExact(0, 'r'), {
    kind: 'rational', numerator: 0n, denominator: 1n
  });
});

Deno.test("simplify: Multiply(1, x) → x", () => {
  const session = run(`
    let e = Exact.Expression.multiply(1n, Exact.Pi);
    let r = Exact.Expression.simplify(e);
    let isPi = r === Exact.Pi;
  `);
  assertEquals(session.get(0, 'isPi'), true);
});

Deno.test("simplify: Multiply(x, 1) → x", () => {
  const session = run(`
    let e = Exact.Expression.multiply(Exact.Pi, 1n);
    let r = Exact.Expression.simplify(e);
    let isPi = r === Exact.Pi;
  `);
  assertEquals(session.get(0, 'isPi'), true);
});

// ---------- Power identity ----------

Deno.test("simplify: Power(x, 0) → 1", () => {
  assertEquals(
    run(`let x = Exact.Expression.simplify(Exact.Expression.power(Exact.Pi, 0n));`).getExact(0, 'x'),
    { kind: 'rational', numerator: 1n, denominator: 1n }
  );
});

Deno.test("simplify: Power(x, 1) → x", () => {
  const session = run(`
    let r = Exact.Expression.simplify(Exact.Expression.power(Exact.Pi, 1n));
    let isPi = r === Exact.Pi;
  `);
  assertEquals(session.get(0, 'isPi'), true);
});

Deno.test("simplify: Power(1, x) → 1", () => {
  assertEquals(
    run(`let x = Exact.Expression.simplify(Exact.Expression.power(1n, Exact.Pi));`).getExact(0, 'x'),
    { kind: 'rational', numerator: 1n, denominator: 1n }
  );
});

// ---------- Negate(Negate(x)) → x ----------

Deno.test("simplify: Negate(Negate(x)) → x", () => {
  const session = run(`
    let inner = Exact.Expression.negate(Exact.Pi);
    let outer = Exact.Expression.negate(inner);
    let r = Exact.Expression.simplify(outer);
    let isPi = r === Exact.Pi;
  `);
  assertEquals(session.get(0, 'isPi'), true);
});

Deno.test("simplify: Negate(Negate(Negate(x))) → Multiply(-1, x) (Ring 3 normal form)", () => {
  // Triple negate: bottom-up turns inner two into x; the surviving
  // Negate normalizes to a -1 coefficient (Ring 3a) so subtraction
  // participates in monomial collection.
  const session = run(`
    let e = Exact.Expression.negate(
      Exact.Expression.negate(
        Exact.Expression.negate(Exact.Pi)));
    let r = Exact.Expression.simplify(e);
  `);
  const value = session.getExact(0, 'r');
  assertEquals(value.kind, 'expression');
  assertEquals(value.head.description, 'Multiply');
  assertEquals(value.arguments.length, 2);
  assertEquals(value.arguments[0], { kind: 'rational', numerator: -1n, denominator: 1n });
  assertEquals(value.arguments[1].description, 'Pi');
});

Deno.test("simplify: Negate(Pi) → Multiply(-1, Pi) (Ring 3 normal form)", () => {
  const session = run(`
    let r = Exact.Expression.simplify(Exact.Expression.negate(Exact.Pi));
  `);
  const value = session.getExact(0, 'r');
  assertEquals(value.head.description, 'Multiply');
  assertEquals(value.arguments[0], { kind: 'rational', numerator: -1n, denominator: 1n });
  assertEquals(value.arguments[1].description, 'Pi');
});

// ---------- Single-arg collapse ----------

Deno.test("simplify: Add(x) → x (single-arg collapse)", () => {
  const session = run(`
    let e = Exact.Expression.make(Exact.Expression.Add, [Exact.Pi]);
    let r = Exact.Expression.simplify(e);
    let isPi = r === Exact.Pi;
  `);
  assertEquals(session.get(0, 'isPi'), true);
});

Deno.test("simplify: Multiply(x) → x (single-arg collapse)", () => {
  const session = run(`
    let e = Exact.Expression.make(Exact.Expression.Multiply, [Exact.Pi]);
    let r = Exact.Expression.simplify(e);
    let isPi = r === Exact.Pi;
  `);
  assertEquals(session.get(0, 'isPi'), true);
});

// ---------- Bottom-up: inner simplification happens first ----------

Deno.test("simplify: bottom-up — inner Add(0, Pi) simplifies, outer sees Pi", () => {
  const session = run(`
    let inner = Exact.Expression.add(0n, Exact.Pi);
    let outer = Exact.Expression.multiply(inner, 2n);
    let r = Exact.Expression.simplify(outer);
  `);
  const value = session.getExact(0, 'r');
  assertEquals(value.head.description, 'Multiply');
  // 2d.3 sort: numerics first, then Symbols. So 2 comes before Pi.
  assertEquals(value.arguments[0], 2n);
  assertEquals(value.arguments[1].description, 'Pi');
});

Deno.test("simplify: bottom-up — Negate(Negate(x)) inside another expression", () => {
  const session = run(`
    let doubleNeg = Exact.Expression.negate(Exact.Expression.negate(Exact.Pi));
    let e = Exact.Expression.add(doubleNeg, 1n);
    let r = Exact.Expression.simplify(e);
  `);
  const value = session.getExact(0, 'r');
  assertEquals(value.head.description, 'Add');
  // Ring 3 monomial order: terms before the degree-0 constant.
  assertEquals(value.arguments[0].description, 'Pi');  // Negate(Negate) collapsed
  assertEquals(value.arguments[1], 1n);
});

Deno.test("simplify: bottom-up — Multiply(1, Add(0, x)) cascades", () => {
  const session = run(`
    let innerAdd = Exact.Expression.add(0n, Exact.Pi);
    let e = Exact.Expression.multiply(1n, innerAdd);
    let r = Exact.Expression.simplify(e);
    let isPi = r === Exact.Pi;
  `);
  assertEquals(session.get(0, 'isPi'), true);
});

// ---------- Expressions without rewrite rules stay equivalent ----------

Deno.test("simplify: Add(1, Pi) — canonicalizes to Add(Pi, 1) (Ring 3 monomial order)", () => {
  const session = run(`
    let r = Exact.Expression.simplify(Exact.Expression.add(1n, Exact.Pi));
    let sorted = Exact.Expression.add(Exact.Pi, 1n);
    let same = Exact.Expression.equal(r, sorted);
  `);
  assertEquals(session.get(0, 'same'), true);
});

// ---------- Idempotence ----------

Deno.test("simplify: simplify(simplify(e)) equals simplify(e)", () => {
  const session = run(`
    let e = Exact.Expression.multiply(Exact.Expression.add(0n, Exact.Pi), 2n);
    let once = Exact.Expression.simplify(e);
    let twice = Exact.Expression.simplify(once);
    let idempotent = Exact.Expression.equal(once, twice);
  `);
  assertEquals(session.get(0, 'idempotent'), true);
});

// ---------- simplify on Rational zero / one is exact ----------

Deno.test("simplify: Multiply(0, x) returns an integer-valued Rational zero", () => {
  const session = run(`
    let r = Exact.Expression.simplify(Exact.Expression.multiply(0n, Exact.Pi));
    let isZero = Exact.equal(r, 0n);
  `);
  assertEquals(session.get(0, 'isZero'), true);
});

Deno.test("simplify: Power(x, 0) returns an integer-valued Rational one", () => {
  const session = run(`
    let r = Exact.Expression.simplify(Exact.Expression.power(Exact.Pi, 0n));
    let isOne = Exact.equal(r, 1n);
  `);
  assertEquals(session.get(0, 'isOne'), true);
});

// ---------- Zero check treats Rational 0 (integer literal) and 0n equally ----------

Deno.test("simplify: Add(0, x) (integer literal) → x", () => {
  // Integer literals are Rational under the hood.
  const session = run(`
    let e = Exact.Expression.add(0, Exact.Pi);
    let r = Exact.Expression.simplify(e);
    let isPi = r === Exact.Pi;
  `);
  assertEquals(session.get(0, 'isPi'), true);
});

Deno.test("simplify: Multiply(x, 1) (integer literal) → x", () => {
  const session = run(`
    let e = Exact.Expression.multiply(Exact.Pi, 1);
    let r = Exact.Expression.simplify(e);
    let isPi = r === Exact.Pi;
  `);
  assertEquals(session.get(0, 'isPi'), true);
});

/**
 * 2d.3 — simplify: commutative sort + Subtract/Divide desugar.
 * (Expectations updated for the Ring 3a canonical order.)
 *
 * Commutative sort (Ring 3a monomial order):
 *   Multiply args: numeric coefficient first, then factors by base
 *   ascending (Symbols alphabetical before opaque expressions;
 *   Power(base, n) keys by its base), exponent descending on ties.
 *   Add terms: canonical monomial order — lex on exponent vectors,
 *   higher powers first, the numeric (degree-0) term last.
 *   Add(Pi, 1) and Add(1, Pi) simplify to the same canonical form.
 *   Multiply(z, y, x) sorts to Multiply(x, y, z).
 *
 * Desugar:
 *   Subtract(a, b) → Add(a, Multiply(-1, b)) — the Negate normalizes
 *   to a -1 coefficient (Ring 3a) so collection sees it.
 *   Divide(a, b)   → Multiply(a, Power(b, -1)).
 *   When both operands are exact numerics, a direct arithmetic fast
 *   path bypasses the desugar: Subtract(3, 2) → 1, Divide(6, 2) → 3.
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

function assertFormalZeroDivision(value, numerator, zeroBase) {
  assertEquals(value.kind, 'expression');
  assertEquals(value.head.description, 'Multiply');
  assertEquals(value.arguments.length, 2);
  assertEquals(value.arguments[0], numerator);
  const reciprocal = value.arguments[1];
  assertEquals(reciprocal.kind, 'expression');
  assertEquals(reciprocal.head.description, 'Power');
  assertEquals(reciprocal.arguments, [
    zeroBase,
    { kind: 'rational', numerator: -1n, denominator: 1n },
  ]);
}

// ---------- Commutative sort: class priority ----------

Deno.test("sort: in an Add, the numeric (degree-0) term sorts last", () => {
  // Ring 3 monomial order replaced Ring 2's numerics-first class order
  // for Add terms: constants are the degree-0 monomial and sort last.
  const session = run(`
    let r = Exact.Expression.simplify(
      Exact.Expression.make(Exact.Expression.Add, [1n, Exact.Pi]));
  `);
  const value = session.getExact(0, 'r');
  assertEquals(value.arguments[0].description, 'Pi');
  assertEquals(value.arguments[1], 1n);
});

Deno.test("sort: Symbols precede opaque Expressions in Multiply factor order", () => {
  // (An Add factor would distribute under 3b, so an opaque head
  // demonstrates the class order.)
  const session = run(`
    let inner = Exact.Expression.make(Symbol.for('Sin'), [Symbol.for('a')]);
    let r = Exact.Expression.simplify(
      Exact.Expression.make(Exact.Expression.Multiply, [inner, Symbol.for('z')]));
  `);
  const value = session.getExact(0, 'r');
  assertEquals(value.arguments[0].description, 'z');
  assertEquals(value.arguments[1].kind, 'expression');
});

Deno.test("sort: numerics sort by value within class", () => {
  const session = run(`
    let r = Exact.Expression.simplify(
      Exact.Expression.make(Exact.Expression.Multiply,
        [5n, Symbol.for('a'), 2n, Symbol.for('b'), 3n]));
  `);
  const value = session.getExact(0, 'r');
  // Multiply folds 5*2*3=30 into a single numeric; sort orders [30, a, b].
  assertEquals(value.arguments[0], 30n);
  assertEquals(value.arguments[1].description, 'a');
  assertEquals(value.arguments[2].description, 'b');
});

Deno.test("sort: Symbols sort alphabetically by description", () => {
  const session = run(`
    let r = Exact.Expression.simplify(
      Exact.Expression.make(Exact.Expression.Multiply,
        [Symbol.for('z'), Symbol.for('y'), Symbol.for('x')]));
  `);
  const value = session.getExact(0, 'r');
  assertEquals(value.arguments.map(a => a.description), ['x', 'y', 'z']);
});

Deno.test("sort: longer names come after shorter with equal prefix", () => {
  // Byte compare: 'a' < 'ab' < 'ac' < 'b'.
  const session = run(`
    let r = Exact.Expression.simplify(
      Exact.Expression.make(Exact.Expression.Add,
        [Symbol.for('b'), Symbol.for('a'), Symbol.for('ab')]));
  `);
  assertEquals(
    session.getExact(0, 'r').arguments.map(a => a.description),
    ['a', 'ab', 'b']
  );
});

Deno.test("sort: Pi / E / Infinity alphabetical", () => {
  const session = run(`
    let r = Exact.Expression.simplify(
      Exact.Expression.make(Exact.Expression.Add,
        [Exact.Pi, Exact.Infinity, Exact.E]));
  `);
  assertEquals(
    session.getExact(0, 'r').arguments.map(a => a.description),
    ['E', 'Infinity', 'Pi']
  );
});

// ---------- Commutativity: different input orders yield same canonical form ----------

Deno.test("commutativity: Add(Pi, 1) === Add(1, Pi) after simplify", () => {
  assertEquals(run(`
    let x = Exact.Expression.equal(
      Exact.Expression.simplify(Exact.Expression.add(Exact.Pi, 1n)),
      Exact.Expression.simplify(Exact.Expression.add(1n, Exact.Pi)));
  `).get(0, 'x'), true);
});

Deno.test("commutativity: Multiply(a, b, c) == Multiply(c, b, a) after simplify", () => {
  assertEquals(run(`
    let x = Exact.Expression.equal(
      Exact.Expression.simplify(Exact.Expression.make(Exact.Expression.Multiply,
        [Symbol.for('a'), Symbol.for('b'), Symbol.for('c')])),
      Exact.Expression.simplify(Exact.Expression.make(Exact.Expression.Multiply,
        [Symbol.for('c'), Symbol.for('b'), Symbol.for('a')])));
  `).get(0, 'x'), true);
});

// ---------- Negate fold on numerics ----------

Deno.test("Negate(5n) folds to -5 (promoted to Rational via Multiply by -1)", () => {
  // Ring 1 arithmetic: BigInt * Rational → Rational. session.get auto-unwraps
  // integer-valued Rationals in safe range to plain Number.
  assertEquals(
    run(`let x = Exact.Expression.simplify(Exact.Expression.negate(5n));`).get(0, 'x'),
    -5
  );
});

Deno.test("Negate(Rational(1/3)) → -1/3", () => {
  const session = run(`
    let r = Exact.Expression.simplify(Exact.Expression.negate(Exact.rational(1n, 3n)));
  `);
  assertEquals(session.getExact(0, 'r'), {
    kind: 'rational', numerator: -1n, denominator: 3n
  });
});

// ---------- Subtract desugar ----------

Deno.test("Subtract(a, b) → Add(a, Multiply(-1, b)) symbolic", () => {
  // Ring 3a: the desugared Negate normalizes to a -1 coefficient so
  // subtraction participates in monomial collection.
  const session = run(`
    let x = Symbol.for('x');
    let y = Symbol.for('y');
    let r = Exact.Expression.simplify(Exact.Expression.subtract(x, y));
  `);
  const value = session.getExact(0, 'r');
  assertEquals(value.head.description, 'Add');
  assertEquals(value.arguments.length, 2);
  // Monomial order: x (atom x) before -y (atom y).
  assertEquals(value.arguments[0].description, 'x');
  assertEquals(value.arguments[1].head.description, 'Multiply');
  assertEquals(value.arguments[1].arguments[0],
    { kind: 'rational', numerator: -1n, denominator: 1n });
  assertEquals(value.arguments[1].arguments[1].description, 'y');
});

Deno.test("Subtract(5, 3) folds via fast path → 2", () => {
  // Fast path uses \$rational_add(a, -b) which promotes BigInts to Rational.
  // session.get unwraps the integer-valued Rational to Number.
  assertEquals(
    run(`let x = Exact.Expression.simplify(Exact.Expression.subtract(5n, 3n));`).get(0, 'x'),
    2
  );
});

Deno.test("Subtract(x, x) → 0 (Ring 3a monomial collection)", () => {
  // Ring 2 left Add(x, Negate(x)) alone; Ring 3a's collection merges
  // the 1·x and -1·x monomials and drops the zero coefficient.
  const session = run(`
    let x = Symbol.for('x');
    let r = Exact.Expression.simplify(Exact.Expression.subtract(x, x));
  `);
  assertEquals(session.getExact(0, 'r'),
    { kind: 'rational', numerator: 0n, denominator: 1n });
});

Deno.test("Subtract(Pi, 1) → Add(Pi, -1)", () => {
  const session = run(`
    let r = Exact.Expression.simplify(Exact.Expression.subtract(Exact.Pi, 1n));
  `);
  const value = session.getExact(0, 'r');
  assertEquals(value.head.description, 'Add');
  assertEquals(value.arguments.length, 2);
  // Negate(1) folds to -1 (Rational); the constant term sorts last.
  assertEquals(value.arguments[0].description, 'Pi');
  assertEquals(value.arguments[1].kind, 'rational');
  assertEquals(value.arguments[1].numerator, -1n);
});

// ---------- Divide desugar ----------

Deno.test("Divide(a, b) → Multiply(a, Power(b, -1)) symbolic", () => {
  const session = run(`
    let x = Symbol.for('x');
    let y = Symbol.for('y');
    let r = Exact.Expression.simplify(Exact.Expression.divide(x, y));
  `);
  const value = session.getExact(0, 'r');
  assertEquals(value.head.description, 'Multiply');
  assertEquals(value.arguments.length, 2);
  assertEquals(value.arguments[0].description, 'x');
  assertEquals(value.arguments[1].head.description, 'Power');
});

Deno.test("Divide(6, 2) folds via fast path → 3", () => {
  assertEquals(
    run(`let x = Exact.Expression.simplify(Exact.Expression.divide(6n, 2n));`).get(0, 'x'),
    3
  );
});

Deno.test("Divide(1, 2) folds to Rational 1/2", () => {
  assertEquals(
    run(`let x = Exact.Expression.simplify(Exact.Expression.divide(1n, 2n));`).getExact(0, 'x'),
    { kind: 'rational', numerator: 1n, denominator: 2n }
  );
});

Deno.test("Divide(Pi, 2) → Multiply(1/2, Pi) (3b folds the numeric power)", () => {
  const session = run(`
    let r = Exact.Expression.simplify(Exact.Expression.divide(Exact.Pi, 2n));
  `);
  const value = session.getExact(0, 'r');
  assertEquals(value.head.description, 'Multiply');
  // The desugared Power(2, -1) folds to the exact Rational 1/2, which
  // leads as the coefficient.
  assertEquals(value.arguments[0], { kind: 'rational', numerator: 1n, denominator: 2n });
  assertEquals(value.arguments[1].description, 'Pi');
});

Deno.test("Divide by zero stays formal and keeps its numerator", () => {
  const session = run(`
    let E = Exact.Expression;
    let zeroOverZero = E.simplify(E.divide(0n, 0n));

    let oneOverZero = E.simplify(E.divide(1n, 0n));
    let twoOverZero = E.simplify(E.divide(2n, 0n));
    let numeratorsStayDistinct = !E.equal(oneOverZero, twoOverZero);

    let x = Symbol.for('x');
    let quotient = E.divide(
      E.subtract(E.power(x, 2n), 1n),
      E.subtract(x, 1n));
    let atOne = E.simplify(E.substitute(quotient, x, 1n));
  `);

  assertFormalZeroDivision(session.getExact(0, 'zeroOverZero'), 0n, 0n);

  const oneOverZero = session.getExact(0, 'oneOverZero');
  assertEquals(oneOverZero.kind, 'expression');
  assertEquals(oneOverZero.head.description, 'Power');
  assertEquals(oneOverZero.arguments, [
    0n,
    { kind: 'rational', numerator: -1n, denominator: 1n },
  ]);
  assertFormalZeroDivision(session.getExact(0, 'twoOverZero'), 2n, 0n);
  assertEquals(session.get(0, 'numeratorsStayDistinct'), true);

  const rationalZero = { kind: 'rational', numerator: 0n, denominator: 1n };
  assertFormalZeroDivision(
    session.getExact(0, 'atOne'),
    rationalZero,
    rationalZero,
  );
});

Deno.test("Undefined zero-division forms survive identities and cancellation", () => {
  const session = run(`
    let E = Exact.Expression;
    let undefinedValue = E.simplify(E.divide(0n, 0n));
    let subtraction = E.simplify(
      E.subtract(undefinedValue, undefinedValue));
    let zeroPower = E.simplify(E.power(undefinedValue, 0n));
    let onePower = E.simplify(E.power(1n, undefinedValue));
    let addIdentity = E.simplify(E.add(undefinedValue, 0n));
    let multiplyIdentity = E.simplify(E.multiply(undefinedValue, 1n));
    let x = Symbol.for('x');
    let ordinarySubtraction = E.simplify(E.subtract(x, x));
    let ordinaryPower = E.simplify(E.power(7n, 0n));
  `);
  assertEquals(session.getExact(0, 'subtraction').head.description, 'Add');
  assertEquals(session.getExact(0, 'zeroPower').head.description, 'Power');
  assertEquals(session.getExact(0, 'onePower').head.description, 'Power');
  assertFormalZeroDivision(session.getExact(0, 'addIdentity'), 0n, 0n);
  assertFormalZeroDivision(session.getExact(0, 'multiplyIdentity'), 0n, 0n);
  assertEquals(session.getExact(0, 'ordinarySubtraction'),
    { kind: 'rational', numerator: 0n, denominator: 1n });
  assertEquals(session.getExact(0, 'ordinaryPower'),
    { kind: 'rational', numerator: 1n, denominator: 1n });
});

Deno.test("Divide folds algebraic operands without recursive desugaring", () => {
  const session = run(`
    let E = Exact.Expression;
    let A = Exact.AlgebraicNumber;
    let sqrt2 = A.squareRoot(2n);
    let sqrt5 = A.squareRoot(5n);

    let halfRoot = E.simplify(E.divide(sqrt2, 2n));
    let halfRootMatches = A.equals(halfRoot, sqrt2 / 2n);

    let goldenRatio = E.simplify(E.divide(E.add(1n, sqrt5), 2n));
    let goldenRatioMatches = A.equals(goldenRatio, (1n + sqrt5) / 2n);

    let cancelled = E.simplify(
      E.divide(E.multiply(2n, sqrt2), sqrt2));
    let cancellationMatches = A.equals(cancelled, 2n);

    let mixedRoots = E.simplify(
      E.divide(A.squareRoot(6n), sqrt2));
    let mixedRootsMatch = A.equals(mixedRoots, A.squareRoot(3n));
  `);
  assertEquals(session.get(0, 'halfRootMatches'), true);
  assertEquals(session.get(0, 'goldenRatioMatches'), true);
  assertEquals(session.get(0, 'cancellationMatches'), true);
  assertEquals(session.get(0, 'mixedRootsMatch'), true);
});

// ---------- Combined: Subtract/Divide participating in larger trees ----------

Deno.test("combined: Add(Subtract(5, 3), Subtract(10, 8)) folds fully", () => {
  // Inner Subtracts fold to 2 each (Rational via desugar fast path);
  // outer Add folds 2+2 = 4. session.get unwraps to Number.
  assertEquals(run(`
    let r = Exact.Expression.simplify(
      Exact.Expression.add(
        Exact.Expression.subtract(5n, 3n),
        Exact.Expression.subtract(10n, 8n)));
  `).get(0, 'r'), 4);
});

Deno.test("combined: Multiply(Divide(6, 2), x) → Multiply(3, x)", () => {
  const session = run(`
    let x = Symbol.for('x');
    let r = Exact.Expression.simplify(
      Exact.Expression.multiply(Exact.Expression.divide(6n, 2n), x));
  `);
  const value = session.getExact(0, 'r');
  assertEquals(value.head.description, 'Multiply');
  assertEquals(value.arguments.length, 2);
  // Fold path produces Rational(3/1); session.get unwraps to 3.
  // Inside a tree the value stays structured.
  assertEquals(value.arguments[0], { kind: 'rational', numerator: 3n, denominator: 1n });
  assertEquals(value.arguments[1].description, 'x');
});

// ---------- Idempotence ----------

Deno.test("idempotent: simplify(simplify(e)) equals simplify(e) with all 2d rules", () => {
  const session = run(`
    let x = Symbol.for('x');
    let y = Symbol.for('y');
    let e = Exact.Expression.subtract(
      Exact.Expression.add(1n, Exact.Expression.multiply(2n, x)),
      Exact.Expression.multiply(3n, y));
    let once = Exact.Expression.simplify(e);
    let twice = Exact.Expression.simplify(once);
    let match = Exact.Expression.equal(once, twice);
  `);
  assertEquals(session.get(0, 'match'), true);
});

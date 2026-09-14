/**
 * Ring 3 (3a) — monomial collection + canonical monomial order inside
 * Exact.Expression.simplify.
 *
 * After flatten/fold, an Add's terms group by their collapsed factor
 * lists (structural equality, opaque atoms included), coefficients sum
 * through Ring 1 arithmetic, zero-coefficient groups drop, and the
 * surviving terms sort in canonical monomial order: lex on exponent
 * vectors (atoms ascending — Symbols alphabetical before opaque
 * atoms), higher exponents first, the numeric degree-0 term last.
 * Multiply args sort in factor order: coefficient first, then base
 * ascending with exponent descending on equal bases.
 */

import { assertEquals } from "https://deno.land/std@0.208.0/assert/mod.ts";
import { parseAndSetup } from './test-helpers.js';
import { freshSession } from '../../src/host-owned-session.js';

function simplify(expressionSource, extra = '') {
  const session = freshSession();
  parseAndSetup(session, `
    let x = Symbol.for('x');
    let y = Symbol.for('y');
    let z = Symbol.for('z');
    let E = Exact.Expression;
    let r = E.simplify(${expressionSource});
    ${extra}
  `);
  const result = session.run(0, 1000000);
  if (result.status !== 'done') {
    throw new Error(`run ended ${result.status}: ${result.error?.message ?? ''}`);
  }
  return session;
}

// Render an exact tree as a compact string for whole-shape assertions.
function render(value) {
  if (value === null || typeof value !== 'object') {
    return typeof value === 'bigint' ? `${value}n` : String(value);
  }
  if (value.kind === 'symbol') return value.description;
  if (value.kind === 'rational') {
    return value.denominator === 1n
      ? `${value.numerator}`
      : `${value.numerator}/${value.denominator}`;
  }
  if (value.kind === 'complex') {
    return `Complex(${render(value.real)}, ${render(value.imaginary)})`;
  }
  if (value.kind === 'expression') {
    return `${value.head.description}(${value.arguments.map(render).join(', ')})`;
  }
  return JSON.stringify(value);
}

function simplified(expressionSource) {
  return render(simplify(expressionSource).getExact(0, 'r'));
}

// ---------- Like-term collection ----------

Deno.test("collect: 2x + 3x → 5x", () => {
  assertEquals(simplified('E.add(E.multiply(2n, x), E.multiply(3n, x))'),
    'Multiply(5n, x)');
});

Deno.test("collect: x + x → 2x (implicit unit coefficients)", () => {
  assertEquals(simplified('E.add(x, x)'), 'Multiply(2, x)');
});

Deno.test("collect: x² + 3x + 2x + 1 → x² + 5x + 1 (the plan's example)", () => {
  assertEquals(
    simplified('E.add(E.add(E.power(x, 2n), E.multiply(3n, x)), E.add(E.multiply(2n, x), 1n))'),
    'Add(Power(x, 2n), Multiply(5n, x), 1n)');
});

Deno.test("collect: x - x → 0", () => {
  assertEquals(simplify('E.subtract(x, x)').getExact(0, 'r'),
    { kind: 'rational', numerator: 0n, denominator: 1n });
});

Deno.test("collect: 2x - 2x → 0", () => {
  assertEquals(
    simplify('E.subtract(E.multiply(2n, x), E.multiply(2n, x))').getExact(0, 'r'),
    { kind: 'rational', numerator: 0n, denominator: 1n });
});

Deno.test("collect: x - 2x → -x", () => {
  assertEquals(simplified('E.subtract(x, E.multiply(2n, x))'), 'Multiply(-1, x)');
});

Deno.test("collect: zero-coefficient group drops, others survive — 2x + y - 2x → y", () => {
  assertEquals(
    simplified('E.add(E.subtract(E.multiply(2n, x), E.multiply(2n, x)), y)'), 'y');
});

Deno.test("collect: cancellation plus constant — x - x + 5 → 5", () => {
  // The fold path promotes through Ring 1 arithmetic, so the surviving
  // constant is an integer-valued Rational.
  assertEquals(simplify('E.add(E.subtract(x, x), 5n)').getExact(0, 'r'),
    { kind: 'rational', numerator: 5n, denominator: 1n });
});

Deno.test("collect: rational coefficients — x/2 + x/2 → x (unit coefficient collapses)", () => {
  assertEquals(
    simplified('E.add(E.multiply(Exact.rational(1n, 2n), x), E.multiply(Exact.rational(1n, 2n), x))'),
    'x');
});

Deno.test("collect: 2xy - xy → xy (unit coefficient with several factors)", () => {
  assertEquals(
    simplified('E.subtract(E.multiply(2n, E.multiply(x, y)), E.multiply(x, y))'),
    'Multiply(x, y)');
});

Deno.test("collect: multivariate like terms — 2xy + 3yx → 5xy (order-insensitive grouping)", () => {
  assertEquals(
    simplified('E.add(E.multiply(2n, E.multiply(x, y)), E.multiply(3n, E.multiply(y, x)))'),
    'Multiply(5n, x, y)');
});

Deno.test("collect: x·x groups with x² (exponent collapse)", () => {
  const session = simplify('E.add(E.multiply(x, x), E.power(x, 2n))');
  const value = session.getExact(0, 'r');
  // First group member's structure survives with the merged coefficient
  // (an integer-valued Rational, since it went through the fold path).
  assertEquals(value.head.description, 'Multiply');
  assertEquals(value.arguments[0], { kind: 'rational', numerator: 2n, denominator: 1n });
});

Deno.test("collect: opaque atoms — 2·Sin(x) + 3·Sin(x) → 5·Sin(x)", () => {
  assertEquals(
    simplified("E.add(E.multiply(2n, E.make(Symbol.for('Sin'), [x])), E.multiply(3n, E.make(Symbol.for('Sin'), [x])))"),
    'Multiply(5n, Sin(x))');
});

Deno.test("collect: distinct opaque atoms stay separate — Sin(x) + Sin(y)", () => {
  assertEquals(
    simplified("E.add(E.make(Symbol.for('Sin'), [x]), E.make(Symbol.for('Sin'), [y]))"),
    'Add(Sin(x), Sin(y))');
});

Deno.test("collect: complex coefficients cancel to a true zero — i·x + (-i)·x → 0", () => {
  assertEquals(
    simplify('E.add(E.multiply(Exact.i, x), E.multiply(Exact.complex(0n, -1n), x))').getExact(0, 'r'),
    { kind: 'rational', numerator: 0n, denominator: 1n });
});

Deno.test("collect: complex coefficients sum — i·x + i·x keeps a Complex coefficient", () => {
  assertEquals(
    simplified('E.add(E.multiply(Exact.i, x), E.multiply(Exact.i, x))'),
    'Multiply(Complex(0, 2), x)');
});

Deno.test("collect: non-monomial terms still group structurally — Sin(x)/y + Sin(x)/y stays sound", () => {
  // t + t = 2t holds for ANY term; grouping is by structural equality
  // of the factor part, polynomial or not. Factor order keys
  // Power(y, -1) by its symbol base y, which sorts before the opaque
  // Sin(x).
  assertEquals(
    simplified("E.add(E.divide(E.make(Symbol.for('Sin'), [x]), y), E.divide(E.make(Symbol.for('Sin'), [x]), y))"),
    'Multiply(2, Power(y, -1), Sin(x))');
});

// ---------- Canonical monomial order ----------

Deno.test("order: descending degree, constant last — 1 + x + x² sorts as x², x, 1", () => {
  assertEquals(simplified('E.add(1n, E.add(x, E.power(x, 2n)))'),
    'Add(Power(x, 2n), x, 1n)');
});

Deno.test("order: multivariate lex — x²y before xy²", () => {
  assertEquals(
    simplified('E.add(E.multiply(x, E.power(y, 2n)), E.multiply(E.power(x, 2n), y))'),
    'Add(Multiply(Power(x, 2n), y), Multiply(x, Power(y, 2n)))');
});

Deno.test("order: x²y ≻ xy² ≻ xy ≻ x ≻ 1 (the plan's lex chain)", () => {
  assertEquals(
    simplified(`E.make(E.Add, [
      1n, x,
      E.multiply(x, y),
      E.multiply(x, E.power(y, 2n)),
      E.multiply(E.power(x, 2n), y)])`),
    'Add(Multiply(Power(x, 2n), y), Multiply(x, Power(y, 2n)), Multiply(x, y), x, 1n)');
});

Deno.test("order: symbol atoms before opaque atoms — x + Sin(z) keeps x first", () => {
  assertEquals(simplified("E.add(E.make(Symbol.for('Sin'), [z]), x)"),
    'Add(x, Sin(z))');
});

Deno.test("order: subtraction ordering — y - x puts -x first (x < y)", () => {
  assertEquals(simplified('E.subtract(y, x)'), 'Add(Multiply(-1, x), y)');
});

Deno.test("order: Multiply factor order keys Power by its base — y·x² → x²·y", () => {
  assertEquals(simplified('E.multiply(y, E.power(x, 2n))'),
    'Multiply(Power(x, 2n), y)');
});

Deno.test("order: same base combines inside Multiply — x·x³ → x⁴ (3b)", () => {
  assertEquals(simplified('E.multiply(x, E.power(x, 3n))'), 'Power(x, 4)');
});

Deno.test("order: coefficient leads the Multiply — y·3·x → 3·x·y", () => {
  assertEquals(simplified('E.multiply(y, E.multiply(3n, x))'),
    'Multiply(3n, x, y)');
});

// ---------- Negate normalization ----------

Deno.test("negate: Negate(x) → Multiply(-1, x)", () => {
  assertEquals(simplified('E.negate(x)'), 'Multiply(-1, x)');
});

Deno.test("negate: Negate(Multiply(2, x)) folds the coefficient → Multiply(-2, x)", () => {
  assertEquals(simplified('E.negate(E.multiply(2n, x))'), 'Multiply(-2, x)');
});

Deno.test("negate: Negate(Add(x, 1)) distributes — -(x+1) → -x - 1 (3b)", () => {
  assertEquals(simplified('E.negate(E.add(x, 1n))'),
    'Add(Multiply(-1, x), -1)');
});

// ---------- Idempotence ----------

Deno.test("idempotence: collection output is a fixed point of simplify", () => {
  const cases = [
    'E.add(E.multiply(2n, x), E.multiply(3n, x))',
    'E.add(E.add(E.power(x, 2n), E.multiply(3n, x)), E.add(E.multiply(2n, x), 1n))',
    'E.subtract(y, x)',
    'E.add(E.multiply(x, E.power(y, 2n)), E.multiply(E.power(x, 2n), y))',
    "E.add(E.multiply(2n, E.make(Symbol.for('Sin'), [x])), E.multiply(3n, E.make(Symbol.for('Sin'), [x])))",
    'E.negate(E.add(x, 1n))',
  ];
  for (const source of cases) {
    const session = simplify(source, 'let again = E.equal(E.simplify(r), r);');
    assertEquals(session.getExact(0, 'again'), true, source);
  }
});

// ---------- GC safety of the collection machinery ----------

Deno.test("collection scratch stays GC-clean: collect, gc, deep-equal", () => {
  const session = simplify(
    'E.add(E.add(E.power(x, 2n), E.multiply(3n, x)), E.add(E.multiply(2n, x), 1n))');
  const before = render(session.getExact(0, 'r'));
  session.gc();
  assertEquals(render(session.getExact(0, 'r')), before);
});

/**
 * Ring 3 (3d) — Divide cancellation inside simplify.
 *
 * simplify sees the desugared Divide shape — Multiply(numerator…,
 * Power(denominator, -k)…) — and, when both sides are
 * polynomial-shaped, divides through by their GCD. Sign normalization
 * follows prior art (Mathematica Cancel / Maple normal / SymPy cancel):
 * a real-negative leading denominator coefficient flips both sides;
 * Complex-leading denominators are left alone. When the GCD machinery
 * cannot help (opaque shapes), the original form returns unchanged.
 */

import { assertEquals } from "https://deno.land/std@0.208.0/assert/mod.ts";
import { parseAndSetup } from './test-helpers.js';
import { freshSession } from '../../src/host-owned-session.js';

function simplify(expressionSource, extra = '') {
  const session = freshSession({ heapSize: 8 * 1024 * 1024 });
  parseAndSetup(session, `
    let x = Symbol.for('x');
    let y = Symbol.for('y');
    let E = Exact.Expression;
    let r = E.simplify(${expressionSource});
    ${extra}
  `);
  const result = session.run(0, 100000000);
  if (result.status !== 'done') {
    throw new Error(`run ended ${result.status}: ${result.error?.message ?? ''}`);
  }
  return session;
}

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

// ---------- Cancellation ----------

Deno.test("cancel: (x² - 1) / (x - 1) → x + 1", () => {
  assertEquals(
    simplified('E.divide(E.subtract(E.power(x, 2n), 1n), E.subtract(x, 1n))'),
    'Add(x, 1)');
});

Deno.test("cancel: (x² + 2x + 1) / (x + 1) → x + 1", () => {
  assertEquals(
    simplified('E.divide(E.add(E.power(x, 2n), E.add(E.multiply(2n, x), 1n)), E.add(x, 1n))'),
    'Add(x, 1)');
});

Deno.test("cancel: (x³ - 1) / (x - 1) → x² + x + 1", () => {
  assertEquals(
    simplified('E.divide(E.subtract(E.power(x, 3n), 1n), E.subtract(x, 1n))'),
    'Add(Power(x, 2), x, 1)');
});

Deno.test("cancel: full cancellation a / a → 1, not Divide(thing, thing)", () => {
  assertEquals(simplify('E.divide(E.add(x, 1n), E.add(x, 1n))').getExact(0, 'r'),
    { kind: 'rational', numerator: 1n, denominator: 1n });
});

Deno.test("cancel: multivariate — xy / x → y", () => {
  assertEquals(simplified('E.divide(E.multiply(x, y), x)'), 'y');
});

Deno.test("cancel: multivariate — (x + y)·x / (x + y) → x", () => {
  assertEquals(
    simplified('E.divide(E.expand(E.multiply(E.add(x, y), x)), E.add(x, y))'), 'x');
});

Deno.test("cancel: partial — (x² - 1) / (x²·(x - 1)) keeps the uncancelled part", () => {
  assertEquals(
    simplified('E.divide(E.subtract(E.power(x, 2n), 1n), E.multiply(E.power(x, 2n), E.subtract(x, 1n)))'),
    'Multiply(Power(x, -2), Add(x, 1))');
});

Deno.test("cancel: opaque atoms cancel too — Sin(x)·y / Sin(x) → y", () => {
  assertEquals(
    simplified("E.divide(E.multiply(E.make(Symbol.for('Sin'), [x]), y), E.make(Symbol.for('Sin'), [x]))"),
    'y');
});

// ---------- Coprime and bailout: unchanged forms ----------

Deno.test("no-op: coprime pair keeps the desugared Divide shape", () => {
  assertEquals(simplified('E.divide(E.add(x, 2n), E.add(x, 1n))'),
    'Multiply(Power(Add(x, 1n), -1), Add(x, 2n))');
});

Deno.test("no-op: opaque-only shapes bail out unchanged", () => {
  assertEquals(
    simplified("E.divide(E.make(Symbol.for('Sin'), [x]), E.make(Symbol.for('Cos'), [x]))"),
    'Multiply(Power(Cos(x), -1), Sin(x))');
});

Deno.test("no-op: pure numerics ride Ring 1 — 6/4 → 3/2", () => {
  assertEquals(simplify('E.divide(6n, 4n)').getExact(0, 'r'),
    { kind: 'rational', numerator: 3n, denominator: 2n });
});

// ---------- Sign normalization ----------

Deno.test("sign: (x - 1) / (1 - x) → -1", () => {
  assertEquals(simplify('E.divide(E.subtract(x, 1n), E.subtract(1n, x))').getExact(0, 'r'),
    { kind: 'rational', numerator: -1n, denominator: 1n });
});

Deno.test("sign: (x² - 1) / (1 - x) → -x - 1", () => {
  assertEquals(
    simplified('E.divide(E.subtract(E.power(x, 2n), 1n), E.subtract(1n, x))'),
    'Add(Multiply(-1, x), -1)');
});

Deno.test("sign: 1 / (1 - x) → -1 / (x - 1)", () => {
  assertEquals(simplified('E.divide(1n, E.subtract(1n, x))'),
    'Multiply(-1, Power(Add(x, -1), -1))');
});

// ---------- Desugar interplay + raw shapes ----------

Deno.test("interplay: divide() desugar then cancellation in one simplify pass", () => {
  assertEquals(
    simplified('E.multiply(E.subtract(E.power(x, 2n), 1n), E.power(E.subtract(x, 1n), Exact.rational(-1n, 1n)))'),
    'Add(x, 1)');
});

Deno.test("interplay: negative exponent beyond -1 unifies — x³ / x² via powers", () => {
  assertEquals(
    simplified('E.multiply(E.power(x, 3n), E.power(x, Exact.rational(-2n, 1n)))'),
    'x');
});

// ---------- Idempotence ----------

Deno.test("idempotence: cancelled and uncancelled Divide forms are fixed points", () => {
  const cases = [
    'E.divide(E.subtract(E.power(x, 2n), 1n), E.subtract(x, 1n))',
    'E.divide(E.add(x, 2n), E.add(x, 1n))',
    'E.divide(1n, E.subtract(1n, x))',
    "E.divide(E.make(Symbol.for('Sin'), [x]), E.make(Symbol.for('Cos'), [x]))",
  ];
  for (const source of cases) {
    const session = simplify(source, 'let again = E.equal(E.simplify(r), r);');
    assertEquals(session.getExact(0, 'again'), true, source);
  }
});

// ---------- GC safety ----------

Deno.test("cancellation output survives gc intact", () => {
  const session = simplify('E.divide(E.subtract(E.power(x, 3n), 1n), E.subtract(x, 1n))');
  const before = render(session.getExact(0, 'r'));
  session.gc();
  assertEquals(render(session.getExact(0, 'r')), before);
});

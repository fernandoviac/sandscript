/**
 * Ring 3 (3b) — Power rewrites + capped expansion inside simplify.
 *
 * Power rewrites: numeric base ^ integer exponent folds exactly
 * (BigInt keeps BigInt-ness, negatives invert, i² → -1);
 * Power(Power(a, n), m) → Power(a, n·m); Power(Multiply(…), n)
 * distributes over the factors; same-base factors combine inside
 * Multiply (x·x³ → x⁴, x·x⁻¹ → 1).
 *
 * Expansion: Multiply-over-Add distribution and Power(sum, n)
 * expansion fire when the PREDICTED post-expansion term count fits
 * MAX_EXPANSION_TERMS = 50 (multinomial C(n+k-1, k-1) for sum powers,
 * the product of summand counts for distribution); above the cap
 * simplify leaves the structure alone. Never distributes across
 * Power(_, negative) factors — that is division, 3d's territory.
 */

import { assertEquals } from "https://deno.land/std@0.208.0/assert/mod.ts";
import { parseAndSetup } from './test-helpers.js';
import { freshSession } from '../../src/host-owned-session.js';

function simplify(expressionSource, extra = '') {
  const session = freshSession({ heapSize: 4 * 1024 * 1024 });
  parseAndSetup(session, `
    let x = Symbol.for('x');
    let y = Symbol.for('y');
    let z = Symbol.for('z');
    let w = Symbol.for('w');
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

// ---------- Numeric power folding ----------

Deno.test("power fold: 2^10 → 1024 (BigInt keeps BigInt-ness)", () => {
  assertEquals(simplify('E.power(2n, 10n)').getExact(0, 'r'), 1024n);
});

Deno.test("power fold: (2/3)^-2 → 9/4", () => {
  assertEquals(
    simplify('E.power(Exact.rational(2n, 3n), Exact.rational(-2n, 1n))').getExact(0, 'r'),
    { kind: 'rational', numerator: 9n, denominator: 4n });
});

Deno.test("power fold: (-2)^3 → -8", () => {
  assertEquals(simplify('E.power(0n - 2n, 3n)').getExact(0, 'r'), -8n);
});

Deno.test("power fold: i^2 → canonical real -1", () => {
  assertEquals(simplify('E.power(Exact.i, 2n)').getExact(0, 'r'), {
    kind: 'rational',
    numerator: -1n,
    denominator: 1n,
  });
});

Deno.test("power fold: i^-1 → -i (Complex reciprocal)", () => {
  assertEquals(simplify('E.power(Exact.i, Exact.rational(-1n, 1n))').getExact(0, 'r'), {
    kind: 'complex',
    real: { kind: 'rational', numerator: 0n, denominator: 1n },
    imaginary: { kind: 'rational', numerator: -1n, denominator: 1n },
  });
});

Deno.test("power fold: 0^-1 stays symbolic (no division blow-up)", () => {
  assertEquals(simplified('E.power(0n, Exact.rational(-1n, 1n))'),
    'Power(0n, -1)');
});

Deno.test("power fold: an astronomically large result stays symbolic", () => {
  assertEquals(simplified('E.power(2n, 10n ** 9n)'),
    'Power(2n, 1000000000n)');
});

// ---------- Power structure rewrites ----------

Deno.test("power of power: (x^2)^3 → x^6", () => {
  assertEquals(simplified('E.power(E.power(x, 2n), 3n)'), 'Power(x, 6n)');
});

Deno.test("power of power: (x^2)^-1 → x^-2 (integer exponents multiply)", () => {
  assertEquals(simplified('E.power(E.power(x, 2n), Exact.rational(-1n, 1n))'),
    'Power(x, -2)');
});

Deno.test("power of power collapsing to identity: (x^2)^0 → 1", () => {
  assertEquals(simplify('E.power(E.power(x, 2n), 0n)').getExact(0, 'r'),
    { kind: 'rational', numerator: 1n, denominator: 1n });
});

Deno.test("power over multiply: (2x)^3 → 8x^3", () => {
  assertEquals(simplified('E.power(E.multiply(2n, x), 3n)'),
    'Multiply(8n, Power(x, 3n))');
});

Deno.test("power over multiply cascades into expansion: (2(x+1))^2 → 4x² + 8x + 4", () => {
  assertEquals(simplified('E.power(E.multiply(2n, E.add(x, 1n)), 2n)'),
    'Add(Multiply(4n, Power(x, 2)), Multiply(8n, x), 4n)');
});

Deno.test("same-base combine: x^2 · x^3 → x^5", () => {
  assertEquals(simplified('E.multiply(E.power(x, 2n), E.power(x, 3n))'),
    'Power(x, 5)');
});

Deno.test("same-base combine: x · x → x^2", () => {
  assertEquals(simplified('E.multiply(x, x)'), 'Power(x, 2)');
});

Deno.test("same-base combine to nothing: x · x^-1 → 1", () => {
  assertEquals(
    simplify('E.multiply(x, E.power(x, Exact.rational(-1n, 1n)))').getExact(0, 'r'),
    { kind: 'rational', numerator: 1n, denominator: 1n });
});

Deno.test("same-base combine keeps other factors: 3 · x · x · y → 3x²y", () => {
  assertEquals(simplified('E.multiply(E.multiply(3n, x), E.multiply(x, y))'),
    'Multiply(3n, Power(x, 2), y)');
});

Deno.test("opaque bases combine too: Sin(x) · Sin(x) → Sin(x)^2", () => {
  assertEquals(
    simplified("E.multiply(E.make(Symbol.for('Sin'), [x]), E.make(Symbol.for('Sin'), [x]))"),
    'Power(Sin(x), 2)');
});

// ---------- Distribution under the cap ----------

Deno.test("distribute: 2(x + 1) → 2x + 2", () => {
  assertEquals(simplified('E.multiply(2n, E.add(x, 1n))'),
    'Add(Multiply(2n, x), 2n)');
});

Deno.test("distribute: (x + 1)(x - 1) → x² - 1", () => {
  assertEquals(simplified('E.multiply(E.add(x, 1n), E.subtract(x, 1n))'),
    'Add(Power(x, 2), -1)');
});

Deno.test("distribute: (x + y)(x + y) → x² + 2xy + y²", () => {
  assertEquals(simplified('E.multiply(E.add(x, y), E.add(x, y))'),
    'Add(Power(x, 2), Multiply(2, x, y), Power(y, 2))');
});

Deno.test("distribute with opaque factor: Sin(x)·(y + 1) → y·Sin(x) + Sin(x)", () => {
  assertEquals(
    simplified("E.multiply(E.make(Symbol.for('Sin'), [x]), E.add(y, 1n))"),
    'Add(Multiply(y, Sin(x)), Sin(x))');
});

Deno.test("no distribution across negative powers: (x + 1)·y⁻¹ stays factored", () => {
  assertEquals(
    simplified('E.multiply(E.add(x, 1n), E.power(y, Exact.rational(-1n, 1n)))'),
    'Multiply(Power(y, -1), Add(x, 1n))');
});

// ---------- Sum-power expansion under the cap ----------

Deno.test("expand: (x + 1)^2 → x² + 2x + 1", () => {
  assertEquals(simplified('E.power(E.add(x, 1n), 2n)'),
    'Add(Power(x, 2), Multiply(2, x), 1n)');
});

Deno.test("expand: (x + 1)^3 → x³ + 3x² + 3x + 1", () => {
  assertEquals(simplified('E.power(E.add(x, 1n), 3n)'),
    'Add(Power(x, 3), Multiply(3, Power(x, 2)), Multiply(3, x), 1n)');
});

Deno.test("expand: (x - y)^2 → x² - 2xy + y²", () => {
  assertEquals(simplified('E.power(E.subtract(x, y), 2n)'),
    'Add(Power(x, 2), Multiply(-2, x, y), Power(y, 2))');
});

Deno.test("expand: (x + y + z)^2 has the multinomial's 6 terms", () => {
  const session = simplify('E.power(E.add(E.add(x, y), z), 2n)',
    'let count = E.argumentCount(r);');
  assertEquals(session.get(0, 'count'), 6);
});

Deno.test("expand: binomial coefficients are exact — (x+2)^4", () => {
  assertEquals(simplified('E.power(E.add(x, 2n), 4n)'),
    'Add(Power(x, 4), Multiply(8n, Power(x, 3)), Multiply(24n, Power(x, 2)), Multiply(32n, x), 16n)');
});

// ---------- The cap ----------

Deno.test("cap: (x + 1)^49 expands (50 terms, exactly at the cap)", () => {
  const session = simplify('E.power(E.add(x, 1n), 49n)',
    'let count = E.argumentCount(r); let kind = E.kind(r);');
  assertEquals(session.get(0, 'count'), 50);
  assertEquals(session.getExact(0, 'kind').description, 'Add');
});

Deno.test("cap: (x + 1)^50 stays unexpanded (51 terms would exceed the cap)", () => {
  assertEquals(simplified('E.power(E.add(x, 1n), 50n)'),
    'Power(Add(x, 1n), 50n)');
});

Deno.test("cap: (x + y + z)^8 expands (45 terms fit)", () => {
  const session = simplify('E.power(E.add(E.add(x, y), z), 8n)',
    'let count = E.argumentCount(r);');
  assertEquals(session.get(0, 'count'), 45);
});

Deno.test("cap: (x + y + z)^9 stays unexpanded (55 terms exceed)", () => {
  const session = simplify('E.power(E.add(E.add(x, y), z), 9n)',
    'let kind = E.kind(r);');
  assertEquals(session.getExact(0, 'kind').description, 'Power');
});

Deno.test("cap: (x + y + z + w)^4 expands (35 terms fit)", () => {
  const session = simplify('E.power(E.add(E.add(x, y), E.add(z, w)), 4n)',
    'let count = E.argumentCount(r);');
  assertEquals(session.get(0, 'count'), 35);
});

Deno.test("cap: distribution over many summands respects the product cap", () => {
  // (a+b)(c+d) → 4 terms fits; a 9-summand × 8-summand product (72)
  // stays factored.
  const session = simplify(
    `E.multiply(
      E.make(E.Add, [x, y, z, w, Symbol.for('p'), Symbol.for('q'), Symbol.for('s'), Symbol.for('t'), Symbol.for('u')]),
      E.make(E.Add, [1n, x, y, z, w, Symbol.for('p'), Symbol.for('q'), Symbol.for('s')]))`,
    'let kind = E.kind(r);');
  assertEquals(session.getExact(0, 'kind').description, 'Multiply');
});

// ---------- Idempotence ----------

Deno.test("idempotence: expansion output is a fixed point of simplify", () => {
  const cases = [
    'E.power(E.add(x, 1n), 3n)',
    'E.multiply(E.add(x, y), E.add(x, y))',
    'E.power(E.multiply(2n, x), 3n)',
    'E.multiply(E.power(x, 2n), E.power(x, 3n))',
    'E.power(E.add(x, 1n), 50n)',
  ];
  for (const source of cases) {
    const session = simplify(source, 'let again = E.equal(E.simplify(r), r);');
    assertEquals(session.getExact(0, 'again'), true, source);
  }
});

// ---------- GC safety across expansion ----------

Deno.test("expansion output survives gc intact", () => {
  const session = simplify('E.power(E.add(x, 2n), 4n)');
  const before = render(session.getExact(0, 'r'));
  session.gc();
  assertEquals(render(session.getExact(0, 'r')), before);
});

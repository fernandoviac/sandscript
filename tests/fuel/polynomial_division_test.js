/**
 * Ring 3 (3c) — Exact.Expression.polynomialDivide(a, b) → [q, r].
 *
 * Long division on coefficient lists in b's main variable (highest
 * degree in b, ties by canonical order): a = b·q + r with
 * degree_v(r) < degree_v(b). Numeric coefficient divisions fold
 * exactly; symbolic leads produce rational-function coefficients
 * (uncancelled until 3d). TypeError on non-polynomial inputs,
 * RangeError on a zero divisor.
 */

import { assertEquals } from "https://deno.land/std@0.208.0/assert/mod.ts";
import { parseAndSetup } from './test-helpers.js';
import { freshSession } from '../../src/host-owned-session.js';
import { UncaughtScriptError } from '../../src/runtime/errors.js';

function run(source) {
  const session = freshSession({ heapSize: 8 * 1024 * 1024 });
  parseAndSetup(session, `
    let x = Symbol.for('x');
    let y = Symbol.for('y');
    let E = Exact.Expression;
    ${source}
  `);
  try {
    const result = session.run(0, 100000000);
    return { session, result, error: null };
  } catch (e) {
    if (e instanceof UncaughtScriptError) {
      return { session, result: { status: 'error' }, error: e.scriptError };
    }
    throw e;
  }
}

function render(value) {
  if (value === null || typeof value !== 'object') {
    return typeof value === 'bigint' ? `${value}n` : String(value);
  }
  if (Array.isArray(value)) return `[${value.map(render).join(' ; ')}]`;
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

function divide(argsSource) {
  const { session, result } = run(`let r = E.polynomialDivide(${argsSource});`);
  if (result.status !== 'done') {
    throw new Error(`run ended ${result.status}: ${result.error?.message ?? ''}`);
  }
  return render(session.getExact(0, 'r'));
}

Deno.test("polynomialDivide: (x² - 1) / (x - 1) = [x + 1, 0]", () => {
  assertEquals(divide('E.subtract(E.power(x, 2n), 1n), E.subtract(x, 1n)'),
    '[Add(x, 1) ; 0]');
});

Deno.test("polynomialDivide: x³ / (x - 1) = [x² + x + 1, 1]", () => {
  assertEquals(divide('E.power(x, 3n), E.subtract(x, 1n)'),
    '[Add(Power(x, 2), x, 1) ; 1]');
});

Deno.test("polynomialDivide: (x² + 2x + 1) / (x + 1) = [x + 1, 0]", () => {
  assertEquals(
    divide('E.add(E.power(x, 2n), E.add(E.multiply(2n, x), 1n)), E.add(x, 1n)'),
    '[Add(x, 1) ; 0]');
});

Deno.test("polynomialDivide: degree(a) < degree(b) → [0, a]", () => {
  assertEquals(divide('E.add(x, 1n), E.power(x, 2n)'), '[0 ; Add(x, 1n)]');
});

Deno.test("polynomialDivide: rational quotient coefficients — x / (2x + 2)", () => {
  // x = (2x + 2)·(1/2) + (-1)
  assertEquals(divide('x, E.add(E.multiply(2n, x), 2n)'), '[1/2 ; -1]');
});

Deno.test("polynomialDivide: division by a constant scales exactly", () => {
  assertEquals(divide('E.add(E.multiply(4n, x), 2n), 2n'),
    '[Add(Multiply(2, x), 1) ; 0]');
});

Deno.test("polynomialDivide: multivariate main variable comes from b — (xy + y) / (x + 1)", () => {
  assertEquals(divide('E.add(E.multiply(x, y), y), E.add(x, 1n)'), '[y ; 0]');
});

Deno.test("polynomialDivide: identity a = b·q + r on a hand-checked case", () => {
  const { session, result } = run(`
    let a = E.expand(E.power(E.add(x, 2n), 3n));
    let b = E.add(E.power(x, 2n), 1n);
    let parts = E.polynomialDivide(a, b);
    let rebuilt = E.simplify(E.add(E.multiply(b, parts[0]), parts[1]));
    let same = E.equal(rebuilt, a);
  `);
  assertEquals(result.status, 'done');
  assertEquals(session.getExact(0, 'same'), true);
});

Deno.test("polynomialDivide: zero divisor throws RangeError", () => {
  const { result, error } = run('let r = E.polynomialDivide(x, 0n);');
  assertEquals(result.status, 'error');
  assertEquals(error.type, 'RangeError');
});

Deno.test("polynomialDivide: non-polynomial input throws TypeError", () => {
  const { result, error } = run('let r = E.polynomialDivide(E.divide(x, y), x);');
  assertEquals(result.status, 'error');
  assertEquals(error.type, 'TypeError');
});

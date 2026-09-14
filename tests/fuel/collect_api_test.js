/**
 * Ring 3 (3c) — Exact.Expression.collect(e, v): regroup e as a
 * polynomial in v, Add(c_n·v^n, …, c_1·v, c_0), each c_i fully
 * simplified in the other atoms. The grouped shape is returned RAW —
 * running simplify on it redistributes back to the canonical expanded
 * form (collect is the alternate form, like Mathematica's Collect).
 * TypeError when e is not polynomial in v (negative exponents, or v
 * inside an opaque head).
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
    let z = Symbol.for('z');
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
  if (value.kind === 'symbol') return value.description;
  if (value.kind === 'rational') {
    return value.denominator === 1n
      ? `${value.numerator}`
      : `${value.numerator}/${value.denominator}`;
  }
  if (value.kind === 'expression') {
    return `${value.head.description}(${value.arguments.map(render).join(', ')})`;
  }
  return JSON.stringify(value);
}

function collect(argsSource) {
  const { session, result } = run(`let r = E.collect(${argsSource});`);
  if (result.status !== 'done') {
    throw new Error(`run ended ${result.status}: ${result.error?.message ?? ''}`);
  }
  return render(session.getExact(0, 'r'));
}

Deno.test("collect API: xy + x + 1 in x → (y+1)·x + 1", () => {
  assertEquals(collect('E.add(E.multiply(x, y), E.add(x, 1n)), x'),
    'Add(Multiply(Add(y, 1), x), 1n)');
});

Deno.test("collect API: expanded (x+y)(x+1) in x → x² + (y+1)·x + y", () => {
  assertEquals(collect('E.expand(E.multiply(E.add(x, y), E.add(x, 1n))), x'),
    'Add(Power(x, 2), Multiply(Add(y, 1), x), y)');
});

Deno.test("collect API: same expression in y instead → (x+1)·y + (x² + x)", () => {
  assertEquals(collect('E.expand(E.multiply(E.add(x, y), E.add(x, 1n))), y'),
    'Add(Multiply(Add(x, 1), y), Add(Power(x, 2), x))');
});

Deno.test("collect API: missing variable → degree-0 constant coefficient", () => {
  assertEquals(collect('E.add(x, 1n), z'), 'Add(x, 1n)');
});

Deno.test("collect API: collects by an opaque atom key", () => {
  assertEquals(
    collect("E.add(E.multiply(y, E.make(Symbol.for('Sin'), [x])), E.multiply(z, E.make(Symbol.for('Sin'), [x]))), E.make(Symbol.for('Sin'), [x])"),
    'Multiply(Add(y, z), Sin(x))');
});

Deno.test("collect API: simplify of the collected form redistributes to canonical", () => {
  const { session, result } = run(`
    let e = E.expand(E.multiply(E.add(x, y), E.add(x, 1n)));
    let grouped = E.collect(e, x);
    let same = E.equal(E.simplify(grouped), e);
  `);
  assertEquals(result.status, 'done');
  assertEquals(session.getExact(0, 'same'), true);
});

Deno.test("collect API: v inside an opaque head throws TypeError", () => {
  const { result, error } = run("let r = E.collect(E.make(Symbol.for('Sin'), [x]), x);");
  assertEquals(result.status, 'error');
  assertEquals(error.type, 'TypeError');
});

Deno.test("collect API: negative exponent on v throws TypeError", () => {
  const { result, error } = run(
    'let r = E.collect(E.multiply(x, E.power(x, Exact.rational(-2n, 1n))), x);');
  assertEquals(result.status, 'error');
  assertEquals(error.type, 'TypeError');
});

Deno.test("collect API: numeric variable argument throws TypeError", () => {
  const { result, error } = run('let r = E.collect(E.add(x, 1n), 2n);');
  assertEquals(result.status, 'error');
  assertEquals(error.type, 'TypeError');
});

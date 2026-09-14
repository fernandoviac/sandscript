/**
 * Tests for the distinct-algebraic-variable registry collector through
 * algebraic_collect_variable_registry and algebraic_registry_index_of.
 *
 * The collector runs through the same canonicalize -> degree ->
 * extract-coefficients pipeline as algebraic_roots_of_polynomial.
 * Exercising the WASM test export against real post-simplify coefficient
 * shapes pins that production input contract.
 */
import { assertEquals, assert } from "https://deno.land/std@0.208.0/assert/mod.ts";
import { freshSession } from '../../src/host-owned-session.js';

function session() {
  return freshSession({ heapSize: 8 * 1024 * 1024 });
}

function run(s, source) {
  const result = s.parse(source);
  s.mem.setContextInstructionIndex(0, result.startIndex);
  s.mem.clearExitCondition(0);
  for (;;) {
    const out = s.run(0, 50_000_000);
    if (out.status === 'complete' || out.status === 'done') return;
    if (out.status === 'paused') { s.mem.clearExitCondition(0); continue; }
    if (out.status === 'memory_pressure') { s.gc(); continue; }
    throw new Error(`unexpected status ${out.status}`);
  }
}

function valuePointerOf(s, name) {
  return s.mem.scopeLookup(s.mem.getContextScope(0), s.mem.internString(name));
}

function collectRegistry(s, polyName, varName) {
  const registry = s.mem.wasm.exports.test_carve_scratch(16 * 4);
  const maxExponents = s.mem.wasm.exports.test_carve_scratch(16 * 4);
  const count = s.mem.wasm.exports.test_collect_registry(
    valuePointerOf(s, polyName), valuePointerOf(s, varName), registry, maxExponents);
  if (count < 0) return { count, headers: [], maxExponents: [] };
  const headers = [];
  const exps = [];
  for (let i = 0; i < count; i++) {
    headers.push(s.mem.view.getUint32(s.mem.abs(registry) + i * 4, true));
    exps.push(s.mem.view.getUint32(s.mem.abs(maxExponents) + i * 4, true));
  }
  return { count, headers, maxExponents: exps };
}

Deno.test("registry: pure rational polynomial has zero distinct variables", () => {
  const s = session();
  run(s, `
    let x = Symbol.for("x");
    let poly = Exact.Expression.subtract(Exact.Expression.power(x, 2n), 2n);
  `);
  const result = collectRegistry(s, "poly", "x");
  assertEquals(result.count, 0);
});

Deno.test("registry: single algebraic value (r=1, the 6c case) counts as 1", () => {
  const s = session();
  run(s, `
    let A = Exact.AlgebraicNumber;
    let sqrt2 = A.squareRoot(2n);
    let x = Symbol.for("x");
    let poly = Exact.Expression.subtract(Exact.Expression.multiply(sqrt2, x), 3n);
  `);
  const result = collectRegistry(s, "poly", "x");
  assertEquals(result.count, 1);
});

Deno.test("registry: two distinct algebraic values across different coefficients (r=2)", () => {
  const s = session();
  run(s, `
    let A = Exact.AlgebraicNumber;
    let sqrt2 = A.squareRoot(2n);
    let sqrt3 = A.squareRoot(3n);
    let x = Symbol.for("x");
    let poly = Exact.Expression.subtract(
      Exact.Expression.multiply(sqrt2, Exact.Expression.power(x, 2n)), sqrt3);
  `);
  const result = collectRegistry(s, "poly", "x");
  assertEquals(result.count, 2);
});

Deno.test("registry: a folded algebraic product is one coefficient value", () => {
  const s = session();
  run(s, `
    let A = Exact.AlgebraicNumber;
    let E = Exact.Expression;
    let sqrt2 = A.squareRoot(2n);
    let sqrt3 = A.squareRoot(3n);
    let x = Symbol.for("x");
    let poly = E.subtract(E.multiply(E.multiply(sqrt2, sqrt3), x), 5n);
  `);
  const result = collectRegistry(s, "poly", "x");
  assertEquals(result.count, 1);
});

Deno.test("registry: the SAME algebraic value repeated across coefficients dedupes to 1", () => {
  const s = session();
  run(s, `
    let A = Exact.AlgebraicNumber;
    let E = Exact.Expression;
    let sqrt2 = A.squareRoot(2n);
    let x = Symbol.for("x");
    let poly = E.add(
      E.multiply(sqrt2, E.power(x, 3n)),
      E.multiply(sqrt2, x));
  `);
  const result = collectRegistry(s, "poly", "x");
  assertEquals(result.count, 1);
});

Deno.test("registry: three distinct algebraic values (r=3)", () => {
  const s = session();
  run(s, `
    let A = Exact.AlgebraicNumber;
    let E = Exact.Expression;
    let sqrt2 = A.squareRoot(2n);
    let sqrt3 = A.squareRoot(3n);
    let sqrt5 = A.squareRoot(5n);
    let x = Symbol.for("x");
    let poly = E.add(
      E.add(E.multiply(sqrt2, E.power(x, 2n)), E.multiply(sqrt3, x)), sqrt5);
  `);
  const result = collectRegistry(s, "poly", "x");
  assertEquals(result.count, 3);
});

Deno.test("registry: value-equal but differently-constructed algebraic headers still dedupe", () => {
  const s = session();
  run(s, `
    let A = Exact.AlgebraicNumber;
    let E = Exact.Expression;
    let sqrt2a = A.squareRoot(2n);
    let sqrt2b = A.squareRoot(2n);
    let x = Symbol.for("x");
    let poly = E.add(
      E.multiply(sqrt2a, E.power(x, 2n)), E.multiply(sqrt2b, x));
  `);
  const result = collectRegistry(s, "poly", "x");
  assertEquals(result.count, 1);
});

Deno.test("registry: folded algebraic powers are distinct coefficient values", () => {
  const s = session();
  run(s, `
    let A = Exact.AlgebraicNumber;
    let E = Exact.Expression;
    let sqrt2 = A.squareRoot(2n);
    let x = Symbol.for("x");
    // The power folds to one exact value distinct from the constant sqrt2.
    let poly = E.add(
      E.multiply(E.power(sqrt2, 3n), E.power(x, 2n)), sqrt2);
  `);
  const result = collectRegistry(s, "poly", "x");
  assertEquals(result.count, 2);
  assertEquals([...result.maxExponents].sort((a, b) => a - b), [1, 1]);
});

Deno.test("registry: rational-valued folded powers leave the algebraic registry", () => {
  const s = session();
  run(s, `
    let A = Exact.AlgebraicNumber;
    let E = Exact.Expression;
    let sqrt2 = A.squareRoot(2n);
    let sqrt3 = A.squareRoot(3n);
    let x = Symbol.for("x");
    let poly = E.add(
      E.add(
        E.multiply(E.power(sqrt2, 5n), E.power(x, 2n)),
        E.multiply(sqrt3, x)),
      E.power(sqrt3, 4n));
  `);
  const result = collectRegistry(s, "poly", "x");
  assertEquals(result.count, 2);
  assertEquals([...result.maxExponents].sort((a, b) => a - b), [1, 1]);
});

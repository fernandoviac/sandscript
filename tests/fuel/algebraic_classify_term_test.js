/**
 * Tests for the generalized coefficient-term classifier:
 * algebraic_classify_term, algebraic_classify_factor, and
 * algebraic_monomial_add_factor.
 *
 * The tests drive the classifier directly through WASM test exports.
 * Terms are built through real Exact.Expression calls and read through
 * session.mem.scopeLookup, matching the post-simplify coefficient shape
 * that algebraic_roots_of_polynomial hands the classifier. Every
 * coefficient slot is canonicalized before classification, so nested
 * Multiply never reaches this code in the real pipeline; the tests call
 * E.simplify to preserve that precondition.
 */
import { assertEquals } from "https://deno.land/std@0.208.0/assert/mod.ts";
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

function toBigInt({ sign, limbs }) {
  let magnitude = 0n;
  for (let i = limbs.length - 1; i >= 0; i--) magnitude = (magnitude << 32n) | BigInt(limbs[i]);
  return sign ? -magnitude : magnitude;
}

function readRational(s, headerPointer) {
  const { numeratorPointer, denominatorPointer } = s.mem.readRational(headerPointer);
  return {
    num: toBigInt(s.mem.readBigInt(numeratorPointer)),
    den: toBigInt(s.mem.readBigInt(denominatorPointer)),
  };
}

function valuePointerOf(s, name) {
  return s.mem.scopeLookup(s.mem.getContextScope(0), s.mem.internString(name));
}

function classify(s, name) {
  const record = s.mem.wasm.exports.test_classify_new_record();
  const status = s.mem.wasm.exports.test_classify_term(record, valuePointerOf(s, name));
  const count = s.mem.wasm.exports.test_classify_record_factor_count(record);
  const factors = [];
  for (let i = 0; i < count; i++) {
    factors.push({
      alpha: s.mem.wasm.exports.test_classify_record_factor_alpha(record, i),
      exp: s.mem.wasm.exports.test_classify_record_factor_exponent(record, i),
    });
  }
  return { status, scalar: readRational(s, s.mem.wasm.exports.test_classify_record_scalar(record)), factors };
}

Deno.test("classify: bare Rational term", () => {
  const s = session();
  run(s, `let A = Exact.AlgebraicNumber; let term = Exact.rational(5n, 2n);`);
  const result = classify(s, "term");
  assertEquals(result.status, 0);
  assertEquals(result.scalar, { num: 5n, den: 2n });
  assertEquals(result.factors, []);
});

Deno.test("classify: bare BigInt term", () => {
  const s = session();
  run(s, `let term = 7n;`);
  const result = classify(s, "term");
  assertEquals(result.status, 0);
  assertEquals(result.scalar, { num: 7n, den: 1n });
  assertEquals(result.factors, []);
});

Deno.test("classify: bare algebraic term (exponent 1)", () => {
  const s = session();
  run(s, `let A = Exact.AlgebraicNumber; let term = A.squareRoot(2n);`);
  const result = classify(s, "term");
  assertEquals(result.status, 0);
  assertEquals(result.scalar, { num: 1n, den: 1n });
  assertEquals(result.factors.length, 1);
  assertEquals(result.factors[0].exp, 1);
});

Deno.test("classify: q * alpha (rational scalar times one algebraic value)", () => {
  const s = session();
  run(s, `
    let A = Exact.AlgebraicNumber;
    let E = Exact.Expression;
    let sqrt2 = A.squareRoot(2n);
    let term = E.multiply(3n, sqrt2);
  `);
  const result = classify(s, "term");
  assertEquals(result.status, 0);
  assertEquals(result.scalar, { num: 3n, den: 1n });
  assertEquals(result.factors.length, 1);
  assertEquals(result.factors[0].exp, 1);
});

Deno.test("classify: Power(alpha, k) for k >= 2", () => {
  const s = session();
  run(s, `
    let A = Exact.AlgebraicNumber;
    let E = Exact.Expression;
    let sqrt2 = A.squareRoot(2n);
    let term = E.multiply(3n, E.power(sqrt2, 2n));
  `);
  const result = classify(s, "term");
  assertEquals(result.status, 0);
  assertEquals(result.scalar, { num: 3n, den: 1n });
  assertEquals(result.factors.length, 1);
  assertEquals(result.factors[0].exp, 2);
});

Deno.test("classify: product of two DISTINCT algebraic values (the r=2 case)", () => {
  const s = session();
  run(s, `
    let A = Exact.AlgebraicNumber;
    let E = Exact.Expression;
    let sqrt2 = A.squareRoot(2n);
    let sqrt3 = A.squareRoot(3n);
    let term = E.multiply(sqrt2, sqrt3);
  `);
  const result = classify(s, "term");
  assertEquals(result.status, 0);
  assertEquals(result.scalar, { num: 1n, den: 1n });
  assertEquals(result.factors.length, 2);
  assertEquals(result.factors.map((f) => f.exp).sort(), [1, 1]);
  // Distinct headers.
  assertEquals(result.factors[0].alpha === result.factors[1].alpha, false);
});

Deno.test("classify: same value appearing twice merges exponents (sqrt2 * sqrt2)", () => {
  const s = session();
  run(s, `
    let A = Exact.AlgebraicNumber;
    let E = Exact.Expression;
    let sqrt2 = A.squareRoot(2n);
    let term = E.multiply(sqrt2, sqrt2);
  `);
  const result = classify(s, "term");
  assertEquals(result.status, 0);
  assertEquals(result.factors.length, 1);
  assertEquals(result.factors[0].exp, 2);
});

Deno.test("classify: scalar folded correctly with three post-simplify factors (2 distinct algebraic + scalar)", () => {
  const s = session();
  run(s, `
    let A = Exact.AlgebraicNumber;
    let E = Exact.Expression;
    let sqrt2 = A.squareRoot(2n);
    let sqrt3 = A.squareRoot(3n);
    let term = E.make(E.Multiply, [sqrt2, sqrt3, 7n]);
  `);
  const result = classify(s, "term");
  assertEquals(result.status, 0);
  assertEquals(result.scalar, { num: 7n, den: 1n });
  assertEquals(result.factors.length, 2);
  assertEquals(result.factors.map((f) => f.exp).sort(), [1, 1]);
});

Deno.test("classify: negative exponent is unrecognized (status 2)", () => {
  const s = session();
  run(s, `
    let A = Exact.AlgebraicNumber;
    let E = Exact.Expression;
    let sqrt2 = A.squareRoot(2n);
    let term = E.power(sqrt2, 0n - 1n);
  `);
  const result = classify(s, "term");
  assertEquals(result.status, 2);
});

Deno.test("classify: a Symbol (unbound variable) is unrecognized (status 2)", () => {
  const s = session();
  run(s, `let x = Symbol.for("x"); let term = x;`);
  const result = classify(s, "term");
  assertEquals(result.status, 2);
});

Deno.test("classify: three distinct algebraic values in one term (r=3 shape)", () => {
  const s = session();
  run(s, `
    let A = Exact.AlgebraicNumber;
    let E = Exact.Expression;
    let sqrt2 = A.squareRoot(2n);
    let sqrt3 = A.squareRoot(3n);
    let sqrt5 = A.squareRoot(5n);
    let term = E.make(E.Multiply, [sqrt2, sqrt3, sqrt5]);
  `);
  const result = classify(s, "term");
  assertEquals(result.status, 0);
  assertEquals(result.factors.length, 3);
  assertEquals(result.factors.map((f) => f.exp).sort(), [1, 1, 1]);
});

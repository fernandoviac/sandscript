/**
 * Ring 6 (6a) — the AlgebraicNumber type surface: predicates, typeOf
 * and coarse typeof, toString, JSON, structured readback,
 * introspection (definingPolynomial / isolatingInterval snapshot
 * semantics), compare/equals/sign/isZero across the tower mix,
 * toApproximation, fromExpression (6a's rational-tree form), argument
 * validation, and gc preservation (both collectors trace the new
 * OBJ class).
 */

import { assertEquals } from "https://deno.land/std@0.208.0/assert/mod.ts";
import { parseAndSetup } from './test-helpers.js';
import { freshSession } from '../../src/host-owned-session.js';
import { OBJ } from '../../src/fuel/constants.js';

function run(source, options = {}) {
  const session = freshSession(options);
  parseAndSetup(session, source);
  const result = session.run(0, 1000000000);
  if (result.status === 'error') {
    throw new Error(`Error: ${result.error?.message ?? JSON.stringify(result)}`);
  }
  if (result.status !== 'done') {
    throw new Error(`run ended ${result.status}`);
  }
  return session;
}

const SQRT2_SETUP = `
  let x = Symbol.for('x');
  let sqrt2 = Exact.AlgebraicNumber.rootsOfPolynomial(
    Exact.Expression.subtract(Exact.Expression.power(x, 2n), 2n), x)[1];
`;

// ---------- predicates and type tags ----------

Deno.test("isAlgebraicNumber: true for roots, false for everything else", () => {
  const session = run(SQRT2_SETUP + `
    let yes = Exact.AlgebraicNumber.isAlgebraicNumber(sqrt2);
    let no1 = Exact.AlgebraicNumber.isAlgebraicNumber(2n);
    let no2 = Exact.AlgebraicNumber.isAlgebraicNumber(Exact.rational(1n, 2n));
    let no3 = Exact.AlgebraicNumber.isAlgebraicNumber('sqrt2');
    let no4 = Exact.AlgebraicNumber.isAlgebraicNumber(x);
  `);
  assertEquals(session.get(0, 'yes'), true);
  assertEquals(session.get(0, 'no1'), false);
  assertEquals(session.get(0, 'no2'), false);
  assertEquals(session.get(0, 'no3'), false);
  assertEquals(session.get(0, 'no4'), false);
});

Deno.test("Exact.typeOf reports 'algebraic'; coarse typeof stays 'number'", () => {
  const session = run(SQRT2_SETUP + `
    let fine = Exact.typeOf(sqrt2);
    let coarse = typeof sqrt2;
  `);
  assertEquals(session.get(0, 'fine'), 'algebraic');
  assertEquals(session.get(0, 'coarse'), 'number');
});

// ---------- toString / JSON / readback ----------

Deno.test("toString renders the defining polynomial and interval", () => {
  const session = run(SQRT2_SETUP + `
    let rendered = Exact.toString(sqrt2);
    let coerced = '' + sqrt2;
  `);
  assertEquals(session.get(0, 'rendered'), 'algebraic(x^2 - 2, (0, 8))');
  assertEquals(session.get(0, 'coerced'), 'algebraic(x^2 - 2, (0, 8))');
});

Deno.test("toString renders the selected minimal factor", () => {
  const session = run(`
    let x = Symbol.for('x');
    // x^3 - 2x - 1 factors as (x + 1)(x^2 - x - 1). The positive
    // algebraic root retains only its irreducible quadratic factor.
    let root = Exact.AlgebraicNumber.rootsOfPolynomial(
      Exact.Expression.subtract(
        Exact.Expression.subtract(Exact.Expression.power(x, 3n),
          Exact.Expression.multiply(2n, x)), 1n), x)[2];
    let rendered = Exact.toString(root);
    let hasMinimalPolynomial = rendered.indexOf('x^2 - x - 1') >= 0;
  `);
  assertEquals(session.get(0, 'hasMinimalPolynomial'), true);
});

Deno.test("JSON.stringify emits the tagged structured form", () => {
  const session = run(SQRT2_SETUP + `
    let json = JSON.stringify(sqrt2);
  `);
  assertEquals(session.get(0, 'json'),
    '{"$algebraic":{"definingPolynomial":["-2","0","1"],"isolatingInterval":["0","8"]}}');
});

Deno.test("JSON.stringify nests inside arrays and objects", () => {
  const session = run(SQRT2_SETUP + `
    let json = JSON.stringify({ value: sqrt2, list: [1, sqrt2] });
  `);
  const tagged = '{"$algebraic":{"definingPolynomial":["-2","0","1"],"isolatingInterval":["0","8"]}}';
  assertEquals(session.get(0, 'json'),
    `{"value":${tagged},"list":[1,${tagged}]}`);
});

Deno.test("structured readback: kind, BigInt coefficients, rational interval", () => {
  const session = run(SQRT2_SETUP);
  const shape = session.getExact(0, 'sqrt2');
  assertEquals(shape.kind, 'algebraic');
  assertEquals(shape.definingPolynomial, [-2n, 0n, 1n]);
  assertEquals(shape.isolatingInterval.length, 2);
  assertEquals(shape.isolatingInterval[0],
    { kind: 'rational', numerator: 0n, denominator: 1n });
  assertEquals(shape.isolatingInterval[1],
    { kind: 'rational', numerator: 8n, denominator: 1n });
});

// ---------- introspection ----------

Deno.test("definingPolynomial owns the canonical x symbol", () => {
  const session = run(`
    let A = Exact.AlgebraicNumber;
    let E = Exact.Expression;
    let value = A.squareRoot(2n);
    let polynomial = A.definingPolynomial(value);
    let x = Symbol.for('x');
    let atRoot = E.simplify(E.substitute(polynomial, x, value));
    let variableMatches = E.equal(atRoot, 0n);
  `);
  assertEquals(session.get(0, 'variableMatches'), true);
  const polynomial = session.getExact(0, 'polynomial');
  assertEquals(polynomial.kind, 'expression');
  assertEquals(polynomial.head.description, 'Add');
});

Deno.test("definingPolynomial returns a canonical Ring 2 polynomial whose roots include the value", () => {
  const session = run(SQRT2_SETUP + `
    let dp = Exact.AlgebraicNumber.definingPolynomial(sqrt2);
    let isPolynomial = Exact.Expression.isPolynomial(dp);
    let roundTrip = Exact.AlgebraicNumber.rootsOfPolynomial(dp, x);
    let recovered = Exact.AlgebraicNumber.equals(roundTrip[1], sqrt2);
  `);
  assertEquals(session.get(0, 'isPolynomial'), true);
  assertEquals(session.get(0, 'recovered'), true);
});

Deno.test("isolatingInterval returns a frozen two-Rational snapshot, not the live interval", () => {
  const session = run(SQRT2_SETUP + `
    let snapshot = Exact.AlgebraicNumber.isolatingInterval(sqrt2);
    let frozen = Array.isFrozen(snapshot);
    let widthBefore = snapshot[1] - snapshot[0];
    // Refinement narrows the STORED interval; the snapshot must not move.
    let ignored = Exact.AlgebraicNumber.toApproximation(sqrt2, 0n - 40n);
    let widthAfterOld = snapshot[1] - snapshot[0];
    let narrowed = Exact.AlgebraicNumber.isolatingInterval(sqrt2);
    let widthAfterNew = narrowed[1] - narrowed[0];
    let snapshotStable = widthBefore === widthAfterOld;
    let intervalNarrowed = widthAfterNew < widthBefore;
  `);
  assertEquals(session.get(0, 'frozen'), true);
  assertEquals(session.get(0, 'snapshotStable'), true);
  assertEquals(session.get(0, 'intervalNarrowed'), true);
});

Deno.test("introspection validates its argument", () => {
  const session = run(`
    let m1 = false;
    try { Exact.AlgebraicNumber.definingPolynomial(5n); } catch (e) { m1 = e.message; }
    let m2 = false;
    try { Exact.AlgebraicNumber.isolatingInterval('x'); } catch (e) { m2 = e.message; }
  `);
  const expected = 'Exact.AlgebraicNumber: expected an AlgebraicNumber, Rational, or BigInt';
  assertEquals(session.get(0, 'm1'), expected);
  assertEquals(session.get(0, 'm2'), expected);
});

// ---------- compare / equals / sign / isZero across the tower ----------

Deno.test("compare accepts every mix of AlgebraicNumber, Rational, and BigInt", () => {
  const session = run(SQRT2_SETUP + `
    let aa = Exact.AlgebraicNumber.compare(sqrt2, sqrt2);
    let ar = Exact.AlgebraicNumber.compare(sqrt2, Exact.rational(3n, 2n));
    let ra = Exact.AlgebraicNumber.compare(Exact.rational(3n, 2n), sqrt2);
    let ab = Exact.AlgebraicNumber.compare(sqrt2, 2n);
    let ba = Exact.AlgebraicNumber.compare(2n, sqrt2);
    let rr = Exact.AlgebraicNumber.compare(Exact.rational(1n, 3n), Exact.rational(1n, 2n));
    let bb = Exact.AlgebraicNumber.compare(5n, 3n);
  `);
  assertEquals(session.get(0, 'aa'), 0);
  assertEquals(session.get(0, 'ar'), -1);
  assertEquals(session.get(0, 'ra'), 1);
  assertEquals(session.get(0, 'ab'), -1);
  assertEquals(session.get(0, 'ba'), 1);
  assertEquals(session.get(0, 'rr'), -1);
  assertEquals(session.get(0, 'bb'), 1);
});

Deno.test("equals: reflexive on the same object, false against nearby rationals", () => {
  const session = run(SQRT2_SETUP + `
    let self = Exact.AlgebraicNumber.equals(sqrt2, sqrt2);
    let near = Exact.AlgebraicNumber.equals(sqrt2, Exact.rational(1414213n, 1000000n));
    let plain = Exact.AlgebraicNumber.equals(2n, 2n);
    let cross = Exact.AlgebraicNumber.equals(2n, Exact.rational(4n, 2n));
  `);
  assertEquals(session.get(0, 'self'), true);
  assertEquals(session.get(0, 'near'), false);
  assertEquals(session.get(0, 'plain'), true);
  assertEquals(session.get(0, 'cross'), true);
});

Deno.test("sign and isZero across the mix", () => {
  const session = run(SQRT2_SETUP + `
    let negative = Exact.AlgebraicNumber.rootsOfPolynomial(
      Exact.Expression.subtract(Exact.Expression.power(x, 2n), 2n), x)[0];
    let s1 = Exact.AlgebraicNumber.sign(sqrt2);
    let s2 = Exact.AlgebraicNumber.sign(negative);
    let s3 = Exact.AlgebraicNumber.sign(0n);
    let s4 = Exact.AlgebraicNumber.sign(Exact.rational(0n - 1n, 2n));
    let z1 = Exact.AlgebraicNumber.isZero(sqrt2);
    let z2 = Exact.AlgebraicNumber.isZero(0n);
    let z3 = Exact.AlgebraicNumber.isZero(Exact.rational(0n, 5n));
  `);
  assertEquals(session.get(0, 's1'), 1);
  assertEquals(session.get(0, 's2'), -1);
  assertEquals(session.get(0, 's3'), 0);
  assertEquals(session.get(0, 's4'), -1);
  assertEquals(session.get(0, 'z1'), false);
  assertEquals(session.get(0, 'z2'), true);
  assertEquals(session.get(0, 'z3'), true);
});

Deno.test("predicate arguments outside the tower throw", () => {
  const session = run(SQRT2_SETUP + `
    let m1 = false;
    try { Exact.AlgebraicNumber.compare('a', 1n); } catch (e) { m1 = e.message; }
    let m2 = false;
    try { Exact.AlgebraicNumber.equals(sqrt2, 'b'); } catch (e) { m2 = e.message; }
    let m3 = false;
    try { Exact.AlgebraicNumber.sign(1.5); } catch (e) { m3 = e.message; }
    let m4 = false;
    try { Exact.AlgebraicNumber.isZero(x); } catch (e) { m4 = e.message; }
  `);
  const expected = 'Exact.AlgebraicNumber: expected an AlgebraicNumber, Rational, or BigInt';
  assertEquals(session.get(0, 'm1'), expected);
  assertEquals(session.get(0, 'm2'), expected);
  assertEquals(session.get(0, 'm3'), expected);
  assertEquals(session.get(0, 'm4'), expected);
});

// ---------- toApproximation ----------

Deno.test("toApproximation converges to the requested width", () => {
  const session = run(SQRT2_SETUP + `
    let coarse = Exact.AlgebraicNumber.toApproximation(sqrt2, 0n - 8n);
    let fine = Exact.AlgebraicNumber.toApproximation(sqrt2, 0n - 52n);
  `);
  const coarse = session.get(0, 'coarse');
  const fine = session.get(0, 'fine');
  if (Math.abs(coarse - Math.SQRT2) > 1 / 256) {
    throw new Error(`coarse approximation off: ${coarse}`);
  }
  if (Math.abs(fine - Math.SQRT2) > 1e-15) {
    throw new Error(`fine approximation off: ${fine}`);
  }
});

Deno.test("toApproximation passes Rational and BigInt through exactly", () => {
  const session = run(`
    let r = Exact.AlgebraicNumber.toApproximation(Exact.rational(3n, 4n), 0n - 10n);
    let b = Exact.AlgebraicNumber.toApproximation(7n, 0n - 10n);
  `);
  assertEquals(session.get(0, 'r'), 0.75);
  assertEquals(session.get(0, 'b'), 7);
});

Deno.test("toApproximation validates the width exponent", () => {
  const session = run(SQRT2_SETUP + `
    let m1 = false;
    try { Exact.AlgebraicNumber.toApproximation(sqrt2, 'wide'); } catch (e) { m1 = e.message; }
    let m2 = false;
    try { Exact.AlgebraicNumber.toApproximation(sqrt2, Exact.rational(1n, 2n)); } catch (e) { m2 = e.message; }
    let m3 = false;
    try { Exact.AlgebraicNumber.toApproximation(sqrt2, 2000000n); } catch (e) { m3 = e.message; }
  `);
  const expected = 'Exact.AlgebraicNumber.toApproximation: widthExponent must be an integer';
  assertEquals(session.get(0, 'm1'), expected);
  assertEquals(session.get(0, 'm2'), expected);
  assertEquals(session.get(0, 'm3'), expected);
});

// ---------- fromExpression (6a: rational-valued trees) ----------

Deno.test("fromExpression evaluates rational trees exactly", () => {
  const session = run(`
    let sum = Exact.AlgebraicNumber.fromExpression(
      Exact.Expression.divide(Exact.Expression.add(1n, 2n), 4n));
    let sumIsThreeQuarters = Exact.AlgebraicNumber.equals(sum, Exact.rational(3n, 4n));
    let folded = Exact.AlgebraicNumber.fromExpression(Exact.Expression.power(2n, 10n));
    let foldedIs1024 = Exact.AlgebraicNumber.equals(folded, 1024n);
    let passthroughBigInt = Exact.AlgebraicNumber.fromExpression(7n);
    let passthroughIsSeven = passthroughBigInt === 7n;
    let passthroughRational = Exact.AlgebraicNumber.fromExpression(Exact.rational(2n, 6n));
    let passthroughIsThird = Exact.AlgebraicNumber.equals(passthroughRational, Exact.rational(1n, 3n));
  `);
  assertEquals(session.get(0, 'sumIsThreeQuarters'), true);
  assertEquals(session.get(0, 'foldedIs1024'), true);
  assertEquals(session.get(0, 'passthroughIsSeven'), true);
  assertEquals(session.get(0, 'passthroughIsThird'), true);
});

Deno.test("fromExpression: division by numeric zero is RangeError", () => {
  const session = run(`
    let x = Symbol.for('x');
    let direct = false;
    try { Exact.AlgebraicNumber.fromExpression(Exact.Expression.divide(x, 0n)); }
    catch (e) { direct = e.message; }
    let numeric = false;
    try { Exact.AlgebraicNumber.fromExpression(Exact.Expression.divide(1n, 0n)); }
    catch (e) { numeric = e.message; }
  `);
  const expected = 'Exact.AlgebraicNumber.fromExpression: division by zero';
  assertEquals(session.get(0, 'direct'), expected);
  assertEquals(session.get(0, 'numeric'), expected);
});

Deno.test("fromExpression: symbolic and complex inputs are TypeErrors (radicals succeed since 6b)", () => {
  const session = run(`
    let x = Symbol.for('x');
    let symbolic = false;
    try { Exact.AlgebraicNumber.fromExpression(Exact.Expression.add(x, 1n)); }
    catch (e) { symbolic = e.message; }
    let radicalIsAlgebraic = Exact.AlgebraicNumber.isAlgebraicNumber(
      Exact.AlgebraicNumber.fromExpression(
        Exact.Expression.power(2n, Exact.rational(1n, 2n))));
    let complexInput = false;
    try { Exact.AlgebraicNumber.fromExpression(Exact.i); }
    catch (e) { complexInput = e.message; }
    let stringInput = false;
    try { Exact.AlgebraicNumber.fromExpression('2'); }
    catch (e) { stringInput = e.message; }
  `);
  const expected = 'Exact.AlgebraicNumber.fromExpression: expression is not an exact numeric-radical tree';
  assertEquals(session.get(0, 'symbolic'), expected);
  assertEquals(session.get(0, 'radicalIsAlgebraic'), true);
  assertEquals(session.get(0, 'complexInput'), expected);
  assertEquals(session.get(0, 'stringInput'), expected);
});

// ---------- gc preservation (both collectors trace OBJ.ALGEBRAIC) ----------

const GC_BATTERY = `
  let x = Symbol.for('x');
  let sqrt2 = Exact.AlgebraicNumber.rootsOfPolynomial(
    Exact.Expression.subtract(Exact.Expression.power(x, 2n), 2n), x)[1];
  let cbrt2 = Exact.AlgebraicNumber.rootsOfPolynomial(
    Exact.Expression.subtract(Exact.Expression.power(x, 3n), 2n), x)[0];
  let garbage = 0n;
  for (let k = 0; k < 200; k = k + 1) {
    garbage = garbage + 12345678901234567890n;
  }
`;

function assertHeapChainParses(session) {
  const image = session.memoryImage;
  const maxObjectType = Math.max(...Object.values(OBJ));
  const heapStart = image.getHeapStart();
  const heapPointer = image.getHeapPointer();
  let p = heapStart;
  while (p < heapPointer) {
    const word0 = image.view.getUint32(image.abs(p), true);
    const size = word0 & 0xFFFFFF;
    const type = (word0 >>> 24) & 0x7f;
    if (size === 0) throw new Error(`zero-size header at ${p}`);
    if ((size & 3) !== 0) throw new Error(`unaligned size ${size} at ${p}`);
    if (type > maxObjectType) throw new Error(`unknown object type ${type} at ${p}`);
    if (p + size > heapPointer) {
      throw new Error(`header at ${p} (size ${size}) overruns heap pointer ${heapPointer}`);
    }
    p += size;
  }
  assertEquals(p, heapPointer, 'walk must land exactly on the heap pointer');
}

Deno.test("gc preserves AlgebraicNumbers and their decisions (differential collectors)", () => {
  const session = run(GC_BATTERY, { gcCollector: 'differential' });
  const render = (name) => JSON.stringify(
    session.getExact(0, name),
    (key, value) => typeof value === 'bigint' ? value.toString() + 'n' : value);
  const before = ['sqrt2', 'cbrt2'].map(render);
  session.gc();
  const after = ['sqrt2', 'cbrt2'].map(render);
  assertEquals(after, before);
  assertHeapChainParses(session);
});

Deno.test("post-gc AlgebraicNumbers still refine and compare correctly", () => {
  const session = run(GC_BATTERY + `
    let marker = 'ready';
  `, { gcCollector: 'differential' });
  session.gc();
  // Drive further work in the same session (appended code shares the
  // global scope — no re-declarations): comparisons refine the
  // (relocated) intervals and must land on the true values.
  parseAndSetup(session, `
    let ordered = Exact.AlgebraicNumber.compare(cbrt2, sqrt2);
    let approx = Exact.AlgebraicNumber.toApproximation(sqrt2, 0n - 40n);
  `);
  const result = session.run(0, 1000000000);
  assertEquals(result.status, 'done');
  assertEquals(session.get(0, 'ordered'), -1);
  const approx = session.get(0, 'approx');
  if (Math.abs(approx - Math.SQRT2) > 1e-11) {
    throw new Error(`post-gc √2 approximation off: ${approx}`);
  }
});

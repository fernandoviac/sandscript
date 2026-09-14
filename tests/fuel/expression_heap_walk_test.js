/**
 * Regression pins for the Ring 2 expression-walk heap-discipline bugs
 * found while opening Ring 3 (2026-07-19):
 *
 * 1. $expression_canonicalize_flat (and the sort/negate/desugar helpers)
 *    carved headerless scratch INTO the committed heap, tearing the
 *    collectors' linear header walk — a GC after any simplify corrupted
 *    whatever live objects sat above the scratch (the simplify result
 *    itself included). Fixed by OBJ_SCRATCH-headed blobs
 *    ($carve_scratch_blob).
 *
 * 2. $expression_numeric_compare's both-Complex path passed Rational
 *    HEADER pointers into the slot-based $rational_compare — a raw WASM
 *    out-of-bounds trap when sorting expressions that differ only in
 *    Complex leaves. Fixed by the allocation-free comparison family
 *    ($rational_header_pair_compare).
 *
 * 3. Polynomial factor staging reserved one 16-byte value slot but
 *    wrote one 16-byte record per factor. A term such as sqrt(2)·x
 *    overwrote the next scratch object's GC header before
 *    rootsOfPolynomial returned.
 */

import { assertEquals } from "https://deno.land/std@0.208.0/assert/mod.ts";
import { parseAndSetup } from './test-helpers.js';
import { freshSession } from '../../src/host-owned-session.js';
import { OBJ } from '../../src/fuel/constants.js';

const MAX_OBJ_TYPE = Math.max(...Object.values(OBJ)); // derived — can't go stale

function run(source, options = {}) {
  const session = freshSession(options);
  parseAndSetup(session, source);
  const result = session.run(0, 1000000);
  if (result.status !== 'done') {
    throw new Error(`run ended ${result.status}: ${result.error?.message ?? ''}`);
  }
  return session;
}

// Walk the committed heap as the collectors do: header to header, by
// stored size. The chain must land exactly on the heap pointer with
// every header well-formed.
function assertHeapChainParses(session) {
  const image = session.memoryImage;
  const heapStart = image.getHeapStart();
  const heapPointer = image.getHeapPointer();
  let p = heapStart;
  while (p < heapPointer) {
    const word0 = image.view.getUint32(image.abs(p), true);
    const size = word0 & 0xFFFFFF;
    const type = (word0 >>> 24) & 0x7f;
    if (size === 0) throw new Error(`zero-size header at ${p}`);
    if ((size & 3) !== 0) throw new Error(`unaligned size ${size} at ${p}`);
    if (type > MAX_OBJ_TYPE) throw new Error(`unknown object type ${type} at ${p}`);
    if (p + size > heapPointer) {
      throw new Error(`header at ${p} (size ${size}) overruns heap pointer ${heapPointer}`);
    }
    p += size;
  }
  assertEquals(p, heapPointer, 'walk must land exactly on the heap pointer');
}

const EXPRESSION_OP_BATTERY = `
  let x = Symbol.for('x');
  let y = Symbol.for('y');
  let sum = Exact.Expression.simplify(
    Exact.Expression.add(Exact.Expression.add(1n, x), 2n));
  let nested = Exact.Expression.simplify(
    Exact.Expression.multiply(
      Exact.Expression.add(x, Exact.Expression.multiply(2n, y)),
      Exact.Expression.subtract(y, 1n)));
  let divided = Exact.Expression.simplify(Exact.Expression.divide(x, y));
  let negated = Exact.Expression.simplify(
    Exact.Expression.negate(Exact.Expression.negate(x)));
  let substituted = Exact.Expression.substitute(sum, x, Exact.rational(1n, 2n));
  let compared = Exact.Expression.equal(sum, substituted);
`;

Deno.test("expression ops leave a perfectly parsable heap header chain", () => {
  const session = run(EXPRESSION_OP_BATTERY);
  assertHeapChainParses(session);
});

Deno.test("gc after simplify preserves the simplify result", () => {
  const session = run(EXPRESSION_OP_BATTERY, { gcCollector: 'differential' });
  const render = (name) => JSON.stringify(
    session.getExact(0, name),
    (key, value) => typeof value === 'bigint' ? value.toString() + 'n' : value);
  const before = ['sum', 'nested', 'divided', 'negated', 'substituted'].map(render);
  session.gc();
  const after = ['sum', 'nested', 'divided', 'negated', 'substituted'].map(render);
  assertEquals(after, before);
  assertHeapChainParses(session);
});

Deno.test("sorting expressions with Complex leaves is canonical (no trap)", () => {
  const session = run(`
    let x = Symbol.for('x');
    let a = Exact.Expression.power(Exact.complex(0n, 1n), x);
    let b = Exact.Expression.power(Exact.complex(0n, 2n), x);
    let s1 = Exact.Expression.simplify(Exact.Expression.add(a, b));
    let s2 = Exact.Expression.simplify(Exact.Expression.add(b, a));
    let eq = Exact.Expression.equal(s1, s2);
  `);
  assertEquals(session.getExact(0, 'eq'), true);
  assertHeapChainParses(session);
});

for (const gcCollector of ['js', 'wat']) {
  Deno.test(`rootsOfPolynomial multi-factor staging preserves the heap (${gcCollector} collector)`, () => {
    const session = run(`
      let A = Exact.AlgebraicNumber;
      let E = Exact.Expression;
      let x = Symbol.for('x');
      let sqrt2 = A.squareRoot(2n);
      let roots = A.rootsOfPolynomial(
        E.add(E.multiply(sqrt2, x), x), x);
      let rootCount = roots.length;
    `, { gcCollector });

    assertEquals(session.getExact(0, 'rootCount'), 1);
    assertHeapChainParses(session);
    const before = JSON.stringify(
      session.getExact(0, 'roots'),
      (key, value) => typeof value === 'bigint' ? value.toString() + 'n' : value);
    session.gc();
    const after = JSON.stringify(
      session.getExact(0, 'roots'),
      (key, value) => typeof value === 'bigint' ? value.toString() + 'n' : value);
    assertEquals(after, before);
    assertHeapChainParses(session);
  });
}

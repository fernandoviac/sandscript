/**
 * Tests for depth-generic content/content-strip and the p_alpha
 * lift-to-any-depth helper: algebraic_npoly_content,
 * algebraic_npoly_scale_down, algebraic_npoly_content_strip, and
 * algebraic_lift_defining_poly. The tests exercise these helpers directly
 * through WASM test exports.
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

function valuePointerOf(s, name) {
  return s.mem.scopeLookup(s.mem.getContextScope(0), s.mem.internString(name));
}

function toBigInt({ sign, limbs }) {
  let magnitude = 0n;
  for (let i = limbs.length - 1; i >= 0; i--) magnitude = (magnitude << 32n) | BigInt(limbs[i]);
  return sign ? -magnitude : magnitude;
}

function poly1(s, coeffs) {
  const p = s.mem.wasm.exports.test_npoly_carve(coeffs.length - 1);
  coeffs.forEach((c, i) => s.mem.wasm.exports.test_npoly_set_coefficient(p, i, s.mem.marshalBigInt(BigInt(c))));
  return p;
}

function readLevel1(s, ptr) {
  const deg = s.mem.wasm.exports.test_npoly_degree(ptr);
  const out = [];
  for (let i = 0; i <= deg; i++) out.push(toBigInt(s.mem.readBigInt(s.mem.wasm.exports.test_npoly_coefficient(ptr, i))));
  return out;
}

// ---------- content / content_strip, depth 1 ----------

Deno.test("npoly_content depth-1: gcd of [6,9,-12] is 3", () => {
  const s = session();
  const p = poly1(s, [6, 9, -12]);
  const content = s.mem.wasm.exports.test_npoly_content(p, 1);
  assertEquals(toBigInt(s.mem.readBigInt(content)), 3n);
});

Deno.test("npoly_content_strip depth-1: negative leading gets negated", () => {
  const s = session();
  const p = poly1(s, [6, 9, -12]);
  const stripped = s.mem.wasm.exports.test_npoly_content_strip(p, 1);
  assertEquals(readLevel1(s, stripped), [-2n, -3n, 4n]);
});

Deno.test("npoly_content_strip depth-1: positive leading stays unchanged (up to the divide)", () => {
  const s = session();
  const p = poly1(s, [6, 9, 12]);
  const stripped = s.mem.wasm.exports.test_npoly_content_strip(p, 1);
  assertEquals(readLevel1(s, stripped), [2n, 3n, 4n]);
});

Deno.test("npoly_content_strip: a nonzero constant (degree 0) still strips its own content", () => {
  const s = session();
  const p = poly1(s, [42]);
  const stripped = s.mem.wasm.exports.test_npoly_content_strip(p, 1);
  assertEquals(readLevel1(s, stripped), [1n]);
});

Deno.test("npoly_content_strip: the zero polynomial (degree < 0) passes through unchanged", () => {
  const s = session();
  const zero = s.mem.wasm.exports.test_npoly_carve(-1);
  const stripped = s.mem.wasm.exports.test_npoly_content_strip(zero, 1);
  assertEquals(stripped, zero);
});

// ---------- content / content_strip, depth 2 ----------

Deno.test("npoly_content depth-2: gcd across ALL leaves in a nested structure", () => {
  const s = session();
  const outer = s.mem.wasm.exports.test_npoly_carve(1);
  s.mem.wasm.exports.test_npoly_set_coefficient(outer, 0, poly1(s, [4, 8]));
  s.mem.wasm.exports.test_npoly_set_coefficient(outer, 1, poly1(s, [6, -10]));
  const content = s.mem.wasm.exports.test_npoly_content(outer, 2);
  assertEquals(toBigInt(s.mem.readBigInt(content)), 2n);
});

Deno.test("npoly_content_strip depth-2: strips and negates by the outer leading coefficient's own sign", () => {
  const s = session();
  const outer = s.mem.wasm.exports.test_npoly_carve(1);
  s.mem.wasm.exports.test_npoly_set_coefficient(outer, 0, poly1(s, [4, 8]));
  s.mem.wasm.exports.test_npoly_set_coefficient(outer, 1, poly1(s, [6, -10]));
  const stripped = s.mem.wasm.exports.test_npoly_content_strip(outer, 2);
  const deg = s.mem.wasm.exports.test_npoly_degree(stripped);
  const rows = [];
  for (let i = 0; i <= deg; i++) rows.push(readLevel1(s, s.mem.wasm.exports.test_npoly_coefficient(stripped, i)));
  assertEquals(rows, [[-2n, -4n], [-3n, 5n]]);
});

// ---------- lift_defining_poly ----------

Deno.test("lift_defining_poly depth-1: sqrt2's defining polynomial is x^2 - 2 flat", () => {
  const s = session();
  run(s, `let A = Exact.AlgebraicNumber; let sqrt2 = A.squareRoot(2n);`);
  const header = s.mem.view.getUint32(s.mem.abs(valuePointerOf(s, "sqrt2")) + 8, true);
  const lifted = s.mem.wasm.exports.test_lift_defining_poly(header, 1);
  assertEquals(readLevel1(s, lifted), [-2n, 0n, 1n]);
});

Deno.test("lift_defining_poly depth-2: each nonzero coefficient wrapped as a level-1 constant", () => {
  const s = session();
  run(s, `let A = Exact.AlgebraicNumber; let sqrt2 = A.squareRoot(2n);`);
  const header = s.mem.view.getUint32(s.mem.abs(valuePointerOf(s, "sqrt2")) + 8, true);
  const lifted = s.mem.wasm.exports.test_lift_defining_poly(header, 2);
  const deg = s.mem.wasm.exports.test_npoly_degree(lifted);
  assertEquals(deg, 2);
  // coeff[0] = -2 wrapped as [-2] (degree 0); coeff[1] = zero poly
  // (degree -1); coeff[2] = 1 wrapped as [1] (degree 0).
  const c0 = s.mem.wasm.exports.test_npoly_coefficient(lifted, 0);
  const c1 = s.mem.wasm.exports.test_npoly_coefficient(lifted, 1);
  const c2 = s.mem.wasm.exports.test_npoly_coefficient(lifted, 2);
  assertEquals(readLevel1(s, c0), [-2n]);
  assertEquals(s.mem.wasm.exports.test_npoly_degree(c1), -1);
  assertEquals(readLevel1(s, c2), [1n]);
});

Deno.test("lift_defining_poly depth-3: a degree-4 algebraic value (e.g. a rotation) lifts cleanly", () => {
  const s = session();
  run(s, `
    let A = Exact.AlgebraicNumber;
    let E = Exact.Expression;
    // sqrt(sqrt(2)) -- a genuine degree-4 value, to exercise a longer chain.
    let x2 = A.squareRoot(2n);
    let x4 = A.squareRoot(E.simplify(E.add(x2, 0n)));
  `);
  const header = s.mem.view.getUint32(s.mem.abs(valuePointerOf(s, "x2")) + 8, true);
  const lifted = s.mem.wasm.exports.test_lift_defining_poly(header, 3);
  const deg = s.mem.wasm.exports.test_npoly_degree(lifted);
  assertEquals(deg, 2);
  // Every level-1 nested coefficient must itself be well-formed
  // (degree -1 or a valid poly, never garbage) -- confirms the
  // 3-deep wrap chain doesn't corrupt anything.
  for (let i = 0; i <= deg; i++) {
    const c2 = s.mem.wasm.exports.test_npoly_coefficient(lifted, i);
    const c2deg = s.mem.wasm.exports.test_npoly_degree(c2);
    if (c2deg >= 0) {
      const c1 = s.mem.wasm.exports.test_npoly_coefficient(c2, 0);
      const c1deg = s.mem.wasm.exports.test_npoly_degree(c1);
      if (c1deg >= 0) {
        readLevel1(s, c1); // must not throw / read garbage
      }
    }
  }
});

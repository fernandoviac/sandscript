/**
 * Regression tests for cross-representation numeric equality.
 *
 * SandScript stores "numbers" in three heap representations:
 *   - TYPE.RATIONAL (inline i64) — produced by integer literals (3, 0x3)
 *   - TYPE.FLOAT — produced by float literals (3.0, 3e0) and host-marshalled JS numbers
 *   - TYPE.BIGINT — produced by `n` literals and host-marshalled JS BigInts
 *
 * The original interpreter rejected `===` between mismatched type tags up
 * front, so `1 === 1.0`, `host_3 === 3`, `[1,2,3].indexOf(host_3)`, etc.
 * all gave wrong answers. The fix routes Rational↔Float comparisons
 * through `value_to_f64` + `f64.eq` (mirroring OP_LT), in OP_EQ, OP_NEQ,
 * Array.indexOf, and Array.includes. BigInt is intentionally not bridged
 * to Number — JS spec keeps `3n === 3` false.
 */

import { assertEquals } from "https://deno.land/std@0.208.0/assert/mod.ts";
import { createSession } from '../../src/fuel/session.js';
import { parseAndSetup } from './test-helpers.js';
import { freshSession } from '../../src/host-owned-session.js';

function declareExternal(session, name, { methods = {}, getters = {} } = {}) {
  const airlock = session.airlock;
  const handleId = airlock.register({});
  const grant = airlock.createRootGrant(`test:${name}`);
  grant.add(handleId);
  for (const [m, fn] of Object.entries(methods)) airlock.setHandler(handleId, m, fn);
  for (const [p, fn] of Object.entries(getters)) airlock.setGetter(handleId, p, fn);
  airlock.declare(name, handleId);
}

// Drive a synchronous program to completion. Throws if the session exits
// with an error so a malformed test source surfaces immediately.
function runSync(session, fuelPerStep = 1000, maxIterations = 200) {
  for (let i = 0; i < maxIterations; i++) {
    const r = session.run(0, fuelPerStep);
    if (r.status === 'done') return;
    if (r.status === 'error') {
      throw new Error(`session exited with error: ${r.error?.message ?? '<no message>'}`);
    }
  }
  throw new Error('session did not complete within iteration budget');
}

function evaluate(source, externalSetup) {
  const session = freshSession();
  if (externalSetup) externalSetup(session);
  parseAndSetup(session, source);
  runSync(session);
  return session.get(0, 'result');
}

// ---------------------------------------------------------------------------
// A. Source-level === parity (no host involvement)
// ---------------------------------------------------------------------------

Deno.test("number equality A: source integer === source integer", () => {
  assertEquals(evaluate(`let result = 1 === 1`), true);
});

Deno.test("number equality A: source float === source float", () => {
  assertEquals(evaluate(`let result = 1.0 === 1.0`), true);
});

Deno.test("number equality A: source 1 === 1.0 (cross-representation)", () => {
  assertEquals(evaluate(`let result = 1 === 1.0`), true);
});

Deno.test("number equality A: source 1.0 === 1 (symmetric)", () => {
  assertEquals(evaluate(`let result = 1.0 === 1`), true);
});

Deno.test("number equality A: source 1 === 1e0 (exponent literal is FLOAT)", () => {
  assertEquals(evaluate(`let result = 1 === 1e0`), true);
});

Deno.test("number equality A: source 0 === 0.0", () => {
  assertEquals(evaluate(`let result = 0 === 0.0`), true);
});

Deno.test("number equality A: source -1 === -1.0", () => {
  assertEquals(evaluate(`let result = -1 === -1.0`), true);
});

Deno.test("number equality A: 1 !== 1.0 is false (NEQ symmetric to EQ)", () => {
  assertEquals(evaluate(`let result = 1 !== 1.0`), false);
});

Deno.test("number equality A: 3 === 0x3 (both are INTEGER lexer path)", () => {
  assertEquals(evaluate(`let result = 3 === 0x3`), true);
});

Deno.test("number equality A: 3 === 3n is false (number !== bigint per JS spec)", () => {
  assertEquals(evaluate(`let result = 3 === 3n`), false);
});

// ---------------------------------------------------------------------------
// B. Host-method-returned numbers vs source literals
// ---------------------------------------------------------------------------

function withHost(methods, getters = {}) {
  return (s) => declareExternal(s, 'obj', { methods, getters });
}

Deno.test("number equality B: host method returns 3, === 3", () => {
  assertEquals(evaluate(
    `let result = obj.three() === 3`,
    withHost({ three: () => 3 })
  ), true);
});

Deno.test("number equality B: host method returns 3, !== 3 is false", () => {
  assertEquals(evaluate(
    `let result = obj.three() !== 3`,
    withHost({ three: () => 3 })
  ), false);
});

Deno.test("number equality B: host method returns 0, === 0", () => {
  assertEquals(evaluate(
    `let result = obj.zero() === 0`,
    withHost({ zero: () => 0 })
  ), true);
});

Deno.test("number equality B: host method returns -1, === -1", () => {
  assertEquals(evaluate(
    `let result = obj.negOne() === -1`,
    withHost({ negOne: () => -1 })
  ), true);
});

Deno.test("number equality B: host method returns MAX_SAFE_INTEGER", () => {
  assertEquals(evaluate(
    `let result = obj.maxSafe() === 9007199254740991`,
    withHost({ maxSafe: () => Number.MAX_SAFE_INTEGER })
  ), true);
});

Deno.test("number equality B: host method returns 3.14, === 3.14", () => {
  assertEquals(evaluate(
    `let result = obj.pi() === 3.14`,
    withHost({ pi: () => 3.14 })
  ), true);
});

Deno.test("number equality B: host method returns -0, === 0 (JS spec)", () => {
  assertEquals(evaluate(
    `let result = obj.negZero() === 0`,
    withHost({ negZero: () => -0 })
  ), true);
});

Deno.test("number equality B: host method returns 3, === 3.0", () => {
  assertEquals(evaluate(
    `let result = obj.three() === 3.0`,
    withHost({ three: () => 3 })
  ), true);
});

Deno.test("number equality B: host method returns NaN, === NaN is false", () => {
  // Regression guard: NaN !== NaN must hold even after the cross-type fix.
  assertEquals(evaluate(
    `let result = obj.nan() === obj.nan()`,
    withHost({ nan: () => NaN })
  ), false);
});

Deno.test("number equality B: host method returns Infinity, === Infinity", () => {
  assertEquals(evaluate(
    `let result = obj.inf() === obj.inf()`,
    withHost({ inf: () => Infinity })
  ), true);
});

// ---------------------------------------------------------------------------
// C. Host-getter-returned numbers (parallel to B — proves the marshal path
//    is the same)
// ---------------------------------------------------------------------------

Deno.test("number equality C: host getter returns 3, === 3", () => {
  assertEquals(evaluate(
    `let result = obj.three === 3`,
    withHost({}, { three: () => 3 })
  ), true);
});

Deno.test("number equality C: host getter returns -0, === 0", () => {
  assertEquals(evaluate(
    `let result = obj.negZero === 0`,
    withHost({}, { negZero: () => -0 })
  ), true);
});

Deno.test("number equality C: host getter, used in conditional", () => {
  assertEquals(evaluate(
    `
      let result = false
      if (obj.three === 3) { result = true }
    `,
    withHost({}, { three: () => 3 })
  ), true);
});

// ---------------------------------------------------------------------------
// D. Equality between two host-derived numbers
// ---------------------------------------------------------------------------

Deno.test("number equality D: host method === host method", () => {
  assertEquals(evaluate(
    `let result = obj.three() === obj.three()`,
    withHost({ three: () => 3 })
  ), true);
});

Deno.test("number equality D: host method === host getter", () => {
  assertEquals(evaluate(
    `let result = obj.threeM() === obj.threeG`,
    withHost({ threeM: () => 3 }, { threeG: () => 3 })
  ), true);
});

// ---------------------------------------------------------------------------
// E. Arithmetic results (contagion preservation)
// ---------------------------------------------------------------------------

Deno.test("number equality E: (1 + 2) === 3 (Rat + Rat = Rat, sanity)", () => {
  assertEquals(evaluate(`let result = (1 + 2) === 3`), true);
});

Deno.test("number equality E: (1.0 + 2.0) === 3.0 (Float + Float, sanity)", () => {
  assertEquals(evaluate(`let result = (1.0 + 2.0) === 3.0`), true);
});

Deno.test("number equality E: (1 + 2.0) === 3 (Rat + Float = Float, cross-type)", () => {
  assertEquals(evaluate(`let result = (1 + 2.0) === 3`), true);
});

Deno.test("number equality E: (1 + 2.0) === 3.0", () => {
  assertEquals(evaluate(`let result = (1 + 2.0) === 3.0`), true);
});

Deno.test("number equality E: (host3 + 0) === 3 (arithmetic preserves Float)", () => {
  assertEquals(evaluate(
    `
      let h = obj.three()
      let result = (h + 0) === 3
    `,
    withHost({ three: () => 3 })
  ), true);
});

Deno.test("number equality E: (host3 + 0.0) === 3", () => {
  assertEquals(evaluate(
    `
      let h = obj.three()
      let result = (h + 0.0) === 3
    `,
    withHost({ three: () => 3 })
  ), true);
});

Deno.test("number equality E: (host3 - host3) === 0", () => {
  assertEquals(evaluate(
    `
      let h = obj.three()
      let result = (h - h) === 0
    `,
    withHost({ three: () => 3 })
  ), true);
});

Deno.test("number equality E: (host3 * 2) === 6", () => {
  assertEquals(evaluate(
    `
      let h = obj.three()
      let result = (h * 2) === 6
    `,
    withHost({ three: () => 3 })
  ), true);
});

// ---------------------------------------------------------------------------
// F. Object/array property round-trip
// ---------------------------------------------------------------------------

Deno.test("number equality F: store host number on object, compare with literal", () => {
  assertEquals(evaluate(
    `
      let storage = {}
      storage.x = obj.three()
      let result = storage.x === 3
    `,
    withHost({ three: () => 3 })
  ), true);
});

Deno.test("number equality F: store literal on object, compare with host number", () => {
  assertEquals(evaluate(
    `
      let storage = {}
      storage.x = 3
      let result = storage.x === obj.three()
    `,
    withHost({ three: () => 3 })
  ), true);
});

Deno.test("number equality F: store host number in array, compare element with literal", () => {
  assertEquals(evaluate(
    `
      let arr = [obj.three()]
      let result = arr[0] === 3
    `,
    withHost({ three: () => 3 })
  ), true);
});

// ---------------------------------------------------------------------------
// G. Array.indexOf and Array.includes
// ---------------------------------------------------------------------------

Deno.test("number equality G: [1,2,3].indexOf(3) === 2 (sanity)", () => {
  assertEquals(evaluate(`let result = [1,2,3].indexOf(3)`), 2);
});

Deno.test("number equality G: [1,2,3].indexOf(host3) === 2", () => {
  assertEquals(evaluate(
    `let result = [1,2,3].indexOf(obj.three())`,
    withHost({ three: () => 3 })
  ), 2);
});

Deno.test("number equality G: [1,2,3].includes(host3) is true", () => {
  assertEquals(evaluate(
    `let result = [1,2,3].includes(obj.three())`,
    withHost({ three: () => 3 })
  ), true);
});

Deno.test("number equality G: [host3].includes(3) is true (symmetric)", () => {
  assertEquals(evaluate(
    `let result = [obj.three()].includes(3)`,
    withHost({ three: () => 3 })
  ), true);
});

Deno.test("number equality G: [1,2,3].indexOf(3.0) === 2 (cross-source-type)", () => {
  assertEquals(evaluate(`let result = [1,2,3].indexOf(3.0)`), 2);
});

Deno.test("number equality G: [1.0,2.0,3.0].indexOf(3) === 2", () => {
  assertEquals(evaluate(`let result = [1.0,2.0,3.0].indexOf(3)`), 2);
});

Deno.test("number equality G: [1, 2.0, 3].indexOf(2) === 1", () => {
  assertEquals(evaluate(`let result = [1, 2.0, 3].indexOf(2)`), 1);
});

Deno.test("number equality G: [host3, 4, 5].indexOf(host3) === 0 (sanity)", () => {
  assertEquals(evaluate(
    `
      let h = obj.three()
      let result = [h, 4, 5].indexOf(h)
    `,
    withHost({ three: () => 3 })
  ), 0);
});

Deno.test("number equality G: [1,2,3].includes(3.0) is true", () => {
  assertEquals(evaluate(`let result = [1,2,3].includes(3.0)`), true);
});

// ---------------------------------------------------------------------------
// H. Predicate-based array methods (find / findIndex / filter)
// ---------------------------------------------------------------------------

Deno.test("number equality H: find with === host needle", () => {
  assertEquals(evaluate(
    `
      let h = obj.three()
      let result = [1,2,3,4].find((x) => x === h)
    `,
    withHost({ three: () => 3 })
  ), 3);
});

Deno.test("number equality H: findIndex with === host needle", () => {
  assertEquals(evaluate(
    `
      let h = obj.three()
      let result = [1,2,3,4].findIndex((x) => x === h)
    `,
    withHost({ three: () => 3 })
  ), 2);
});

Deno.test("number equality H: filter with === host needle", () => {
  assertEquals(evaluate(
    `
      let h = obj.three()
      let result = [1,2,3,4].filter((x) => x === h)
    `,
    withHost({ three: () => 3 })
  ), [3]);
});

// ---------------------------------------------------------------------------
// I. Control flow (if / ternary / while)
// ---------------------------------------------------------------------------

Deno.test("number equality I: if (host === literal) takes the branch", () => {
  assertEquals(evaluate(
    `
      let result = 'untaken'
      if (obj.three() === 3) { result = 'taken' }
    `,
    withHost({ three: () => 3 })
  ), 'taken');
});

Deno.test("number equality I: ternary with host === literal", () => {
  assertEquals(evaluate(
    `let result = obj.three() === 3 ? 'eq' : 'ne'`,
    withHost({ three: () => 3 })
  ), 'eq');
});

Deno.test("number equality I: while (counter !== host3) terminates", () => {
  // Regression guard against infinite-loop case: the !== comparison
  // must converge once counter equals the host-derived bound.
  assertEquals(evaluate(
    `
      let counter = 0
      let h = obj.three()
      while (counter !== h) { counter = counter + 1 }
      let result = counter
    `,
    withHost({ three: () => 3 })
  ), 3);
});

// ---------------------------------------------------------------------------
// J. Comparison-operator regression (must keep working — these used the
//    canonicalization path before the fix)
// ---------------------------------------------------------------------------

Deno.test("number equality J: host3 < 4 is true", () => {
  assertEquals(evaluate(
    `let result = obj.three() < 4`,
    withHost({ three: () => 3 })
  ), true);
});

Deno.test("number equality J: host3 >= 3 is true", () => {
  assertEquals(evaluate(
    `let result = obj.three() >= 3`,
    withHost({ three: () => 3 })
  ), true);
});

Deno.test("number equality J: 1 < 1.5 is true", () => {
  assertEquals(evaluate(`let result = 1 < 1.5`), true);
});

// ---------------------------------------------------------------------------
// K. NaN / Infinity / ±0 corner cases
// ---------------------------------------------------------------------------

Deno.test("number equality K: NaN === NaN is false (regression guard)", () => {
  assertEquals(evaluate(
    `
      let n = obj.nan()
      let result = n === n
    `,
    withHost({ nan: () => NaN })
  ), false);
});

Deno.test("number equality K: host_NaN === source NaN is false", () => {
  assertEquals(evaluate(
    `let result = obj.nan() === (0/0)`,
    withHost({ nan: () => NaN })
  ), false);
});

Deno.test("number equality K: host_Inf === (1/0) is true", () => {
  assertEquals(evaluate(
    `let result = obj.inf() === (1/0)`,
    withHost({ inf: () => Infinity })
  ), true);
});

Deno.test("number equality K: host_-0 === 0 (JS spec: -0 == 0 == true)", () => {
  assertEquals(evaluate(
    `let result = obj.negZero() === 0`,
    withHost({ negZero: () => -0 })
  ), true);
});

Deno.test("number equality K: host_-0 === -0", () => {
  assertEquals(evaluate(
    `let result = obj.negZero() === -0`,
    withHost({ negZero: () => -0 })
  ), true);
});

// ---------------------------------------------------------------------------
// L. BigInt boundary (regression guard — already correct)
// ---------------------------------------------------------------------------

Deno.test("number equality L: host_3n === 3n", () => {
  assertEquals(evaluate(
    `let result = obj.bigThree() === 3n`,
    withHost({ bigThree: () => 3n })
  ), true);
});

Deno.test("number equality L: host_3n === 3 is false (number !== bigint)", () => {
  assertEquals(evaluate(
    `let result = obj.bigThree() === 3`,
    withHost({ bigThree: () => 3n })
  ), false);
});

Deno.test("number equality L: host_3n === host_3n", () => {
  assertEquals(evaluate(
    `let result = obj.bigThree() === obj.bigThree()`,
    withHost({ bigThree: () => 3n })
  ), true);
});

// ---------------------------------------------------------------------------
// M. NaN in Array.indexOf (StrictEquality) and Array.includes (SameValueZero)
//
// JS spec: indexOf uses Strict Equality, where NaN never equals anything
// (so indexOf can never find NaN). includes uses SameValueZero, where NaN
// equals NaN (so includes CAN find NaN). The two methods deliberately
// disagree on NaN.
// ---------------------------------------------------------------------------

Deno.test("number equality M: [NaN].indexOf(NaN) is -1 (StrictEquality)", () => {
  assertEquals(evaluate(`let result = [(0/0)].indexOf(0/0)`), -1);
});

Deno.test("number equality M: [1, NaN, 3].indexOf(NaN) is -1", () => {
  assertEquals(evaluate(`let result = [1, (0/0), 3].indexOf(0/0)`), -1);
});

Deno.test("number equality M: [NaN].indexOf(host_NaN) is -1", () => {
  assertEquals(evaluate(
    `let result = [(0/0)].indexOf(obj.nan())`,
    withHost({ nan: () => NaN })
  ), -1);
});

Deno.test("number equality M: [host_NaN].indexOf(NaN) is -1 (symmetric)", () => {
  assertEquals(evaluate(
    `let result = [obj.nan()].indexOf(0/0)`,
    withHost({ nan: () => NaN })
  ), -1);
});

Deno.test("number equality M: [host_NaN].indexOf(host_NaN) is -1", () => {
  assertEquals(evaluate(
    `let result = [obj.nan()].indexOf(obj.nan())`,
    withHost({ nan: () => NaN })
  ), -1);
});

Deno.test("number equality M: [NaN].includes(NaN) is true (SameValueZero)", () => {
  assertEquals(evaluate(`let result = [(0/0)].includes(0/0)`), true);
});

Deno.test("number equality M: [1, NaN, 3].includes(NaN) is true", () => {
  assertEquals(evaluate(`let result = [1, (0/0), 3].includes(0/0)`), true);
});

Deno.test("number equality M: [NaN].includes(host_NaN) is true", () => {
  assertEquals(evaluate(
    `let result = [(0/0)].includes(obj.nan())`,
    withHost({ nan: () => NaN })
  ), true);
});

Deno.test("number equality M: [host_NaN].includes(NaN) is true (symmetric)", () => {
  assertEquals(evaluate(
    `let result = [obj.nan()].includes(0/0)`,
    withHost({ nan: () => NaN })
  ), true);
});

Deno.test("number equality M: [host_NaN].includes(host_NaN) is true", () => {
  assertEquals(evaluate(
    `let result = [obj.nan()].includes(obj.nan())`,
    withHost({ nan: () => NaN })
  ), true);
});

Deno.test("number equality M: [NaN].includes(3) is false (NaN doesn't match a number)", () => {
  assertEquals(evaluate(`let result = [(0/0)].includes(3)`), false);
});

Deno.test("number equality M: [3].includes(NaN) is false", () => {
  assertEquals(evaluate(`let result = [3].includes(0/0)`), false);
});

Deno.test("number equality M: find with === NaN does not find NaN", () => {
  // find uses === in the predicate, so NaN === NaN is false → undefined.
  assertEquals(evaluate(
    `
      let n = obj.nan()
      let result = [1, (0/0), 3].find((x) => x === n)
    `,
    withHost({ nan: () => NaN })
  ), undefined);
});

Deno.test("number equality M: findIndex with === NaN returns -1", () => {
  assertEquals(evaluate(
    `
      let n = obj.nan()
      let result = [1, (0/0), 3].findIndex((x) => x === n)
    `,
    withHost({ nan: () => NaN })
  ), -1);
});

Deno.test("number equality M: includes still finds 3 in [1, NaN, 3]", () => {
  // Regression guard: the NaN special-case must not break ordinary matches.
  assertEquals(evaluate(`let result = [1, (0/0), 3].includes(3)`), true);
});

Deno.test("number equality M: indexOf still finds 3 in [1, NaN, 3]", () => {
  assertEquals(evaluate(`let result = [1, (0/0), 3].indexOf(3)`), 2);
});

Deno.test("number equality M: includes finds host_3 across NaN element", () => {
  // Cross-type bridge still works in the presence of NaN elements.
  assertEquals(evaluate(
    `let result = [1, (0/0), 3].includes(obj.three())`,
    withHost({ three: () => 3 })
  ), true);
});

/**
 * Unary plus operator (+x) — pre-existing gap, restored for JS-parity.
 *
 * JS spec: +x is ToNumber(x). Numeric values pass through unchanged
 * (preserving exact type per Ring 1 conventions — +Rational stays Rational,
 * matching Number(Rational)); Symbol throws TypeError; undefined becomes
 * NaN; null becomes 0; booleans become 0/1.
 */

import { assertEquals, assert, assertThrows } from "https://deno.land/std@0.208.0/assert/mod.ts";
import { createSession } from '../../src/fuel/session.js';
import { parseAndSetup } from './test-helpers.js';
import { freshSession } from '../../src/host-owned-session.js';
import { UncaughtScriptError } from '../../src/runtime/errors.js';

function expectParseError(source) {
  const session = freshSession();
  const result = session.parse(source);
  assert(result.error, `expected parse error for: ${source}`);
}

function expectRuntimeError(source) {
  const session = freshSession();
  const parseResult = session.parse(source);
  session.mem.setContextInstructionIndex(0, parseResult.startIndex);
  session.mem.clearExitCondition(0);
  assertThrows(() => session.run(0, 1000000), UncaughtScriptError);
}

function run(source) {
  const session = freshSession();
  parseAndSetup(session, source);
  session.run(0, 1000000);
  return session;
}

// Numeric pass-through (preserves exact type per Ring 1)

Deno.test("+5 → 5 (integer stays integer)", () => {
  assertEquals(run(`let x = +5;`).get(0, 'x'), 5);
});

Deno.test("+(-5) → -5", () => {
  assertEquals(run(`let x = +(-5);`).get(0, 'x'), -5);
});

Deno.test("+0 → 0", () => {
  assertEquals(run(`let x = +0;`).get(0, 'x'), 0);
});

Deno.test("+3.14 → 3.14 (float unchanged)", () => {
  assertEquals(run(`let x = +3.14;`).get(0, 'x'), 3.14);
});

Deno.test("+3n → 3n (BigInt preserved, consistent with Number(3n))", () => {
  // Ring 1 chose Number(BigInt) to preserve exactness rather than throw;
  // unary plus follows the same rule.
  assertEquals(run(`let x = +3n;`).get(0, 'x'), 3n);
});

Deno.test("+Exact.rational(1n, 2n) preserves Rational", () => {
  assertEquals(
    run(`let x = +Exact.rational(1n, 2n);`).getExact(0, 'x'),
    { kind: 'rational', numerator: 1n, denominator: 2n }
  );
});

// Coercion

Deno.test("+true → 1", () => {
  assertEquals(run(`let x = +true;`).get(0, 'x'), 1);
});

Deno.test("+false → 0", () => {
  assertEquals(run(`let x = +false;`).get(0, 'x'), 0);
});

Deno.test("+null → 0", () => {
  assertEquals(run(`let x = +null;`).get(0, 'x'), 0);
});

Deno.test("+undefined → NaN", () => {
  const got = run(`let x = +undefined;`).get(0, 'x');
  assert(Number.isNaN(got), `expected NaN, got ${got}`);
});

// Symbol rejection (JS spec)

Deno.test("+Symbol('x') throws TypeError", () => {
  expectRuntimeError(`let x = +Symbol('x');`);
});

// Composite expressions

Deno.test("+x where x = 5 variable", () => {
  assertEquals(run(`let n = 5; let x = +n;`).get(0, 'x'), 5);
});

Deno.test("1 + +'' arithmetic mixing", () => {
  assertEquals(run(`let x = 1 + +'';`).get(0, 'x'), 1);
});

Deno.test("Unary plus does not coerce implicit string +", () => {
  // Making sure +5 + '!' still goes through the JS string-concat path:
  // +5 is 5, 5 + '!' is '5!'
  assertEquals(run(`let x = +5 + '!';`).get(0, 'x'), '5!');
});

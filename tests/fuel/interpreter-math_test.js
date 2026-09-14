/**
 * Test interpreter Math methods, Number constants, and global functions.
 *
 * Run with: deno task test tests/fuel/interpreter-math_test.js
 */

import {
  assertEquals,
  assertThrows,
} from "https://deno.land/std@0.208.0/assert/mod.ts";
import {
  assertNumericResult,
  assertStringResult,
  assertBooleanResult,
  assertNaNResult,
  assertInfinityResult,
  assertUndefinedResult,
} from './interpreter-test-utils.js';
import { freshSession } from '../../src/host-owned-session.js';
import { UncaughtScriptError } from '../../src/runtime/errors.js';

// =============================================================================
// Math.random
// =============================================================================

Deno.test("Math: Math.random() reports explicit unsupported operation", () => {
  const session = freshSession();
  session.parse('Math.random()');
  const error = assertThrows(
    () => session.run(0, 10000),
    UncaughtScriptError,
  );
  assertEquals(error.scriptError.codeName, 'NOT_SUPPORTED');
  assertEquals(
    error.scriptError.message,
    'Math.random is unavailable because the interpreter has no implicit time or entropy source',
  );
  assertEquals(
    error.scriptError.hint,
    'Provide randomness through an explicit host capability.',
  );
});

Deno.test("Math: Math.random property lookup is non-throwing", () => {
  const session = freshSession();
  session.parse('const random = Math.random; const available = random !== undefined');
  session.run(0, 10000);
  assertEquals(session.get(0, 'available'), true);
});

Deno.test("Math: extracted Math.random callable reports the named error", () => {
  const session = freshSession();
  session.parse('const random = Math.random; random()');
  const error = assertThrows(
    () => session.run(0, 10000),
    UncaughtScriptError,
  );
  assertEquals(error.scriptError.codeName, 'NOT_SUPPORTED');
  assertEquals(
    error.scriptError.message,
    'Math.random is unavailable because the interpreter has no implicit time or entropy source',
  );
});

// =============================================================================
// Math.abs
// =============================================================================

Deno.test("Math: Math.abs(-5) returns 5", () => {
  assertNumericResult('let result = Math.abs(-5)', 'result', 5);
});

Deno.test("Math: Math.abs(5) returns 5", () => {
  assertNumericResult('let result = Math.abs(5)', 'result', 5);
});

Deno.test("Math: Math.abs(0) returns 0", () => {
  assertNumericResult('let result = Math.abs(0)', 'result', 0);
});

// =============================================================================
// Math.floor
// =============================================================================

Deno.test("Math: Math.floor(3.7) returns 3", () => {
  assertNumericResult('let result = Math.floor(3.7)', 'result', 3);
});

Deno.test("Math: Math.floor(-3.7) returns -4", () => {
  assertNumericResult('let result = Math.floor(-3.7)', 'result', -4);
});

Deno.test("Math: Math.floor(5) returns 5", () => {
  assertNumericResult('let result = Math.floor(5)', 'result', 5);
});

// =============================================================================
// Math.ceil
// =============================================================================

Deno.test("Math: Math.ceil(3.2) returns 4", () => {
  assertNumericResult('let result = Math.ceil(3.2)', 'result', 4);
});

Deno.test("Math: Math.ceil(-3.2) returns -3", () => {
  assertNumericResult('let result = Math.ceil(-3.2)', 'result', -3);
});

Deno.test("Math: Math.ceil(5) returns 5", () => {
  assertNumericResult('let result = Math.ceil(5)', 'result', 5);
});

// =============================================================================
// Math.round
// =============================================================================

Deno.test("Math: Math.round(3.5) returns 4", () => {
  assertNumericResult('let result = Math.round(3.5)', 'result', 4);
});

Deno.test("Math: Math.round(3.4) returns 3", () => {
  assertNumericResult('let result = Math.round(3.4)', 'result', 3);
});

Deno.test("Math: Math.round(-3.5) returns -3", () => {
  assertNumericResult('let result = Math.round(-3.5)', 'result', -3);
});

// =============================================================================
// Math.trunc
// =============================================================================

Deno.test("Math: Math.trunc(3.9) returns 3", () => {
  assertNumericResult('let result = Math.trunc(3.9)', 'result', 3);
});

Deno.test("Math: Math.trunc(-3.9) returns -3", () => {
  assertNumericResult('let result = Math.trunc(-3.9)', 'result', -3);
});

Deno.test("Math: Math.trunc(5) returns 5", () => {
  assertNumericResult('let result = Math.trunc(5)', 'result', 5);
});

// =============================================================================
// Math.sqrt
// =============================================================================

Deno.test("Math: Math.sqrt(16) returns 4", () => {
  assertNumericResult('let result = Math.sqrt(16)', 'result', 4);
});

Deno.test("Math: Math.sqrt(2) returns ~1.414", () => {
  assertNumericResult('let result = Math.sqrt(2)', 'result', Math.sqrt(2));
});

Deno.test("Math: Math.sqrt(0) returns 0", () => {
  assertNumericResult('let result = Math.sqrt(0)', 'result', 0);
});

// =============================================================================
// Math.min/max
// =============================================================================

Deno.test("Math: Math.min(3, 7) returns 3", () => {
  assertNumericResult('let result = Math.min(3, 7)', 'result', 3);
});

Deno.test("Math: Math.min(7, 3) returns 3", () => {
  assertNumericResult('let result = Math.min(7, 3)', 'result', 3);
});

Deno.test("Math: Math.min(-5, 5) returns -5", () => {
  assertNumericResult('let result = Math.min(-5, 5)', 'result', -5);
});

Deno.test("Math: Math.max(3, 7) returns 7", () => {
  assertNumericResult('let result = Math.max(3, 7)', 'result', 7);
});

Deno.test("Math: Math.max(7, 3) returns 7", () => {
  assertNumericResult('let result = Math.max(7, 3)', 'result', 7);
});

Deno.test("Math: Math.max(-5, 5) returns 5", () => {
  assertNumericResult('let result = Math.max(-5, 5)', 'result', 5);
});

// =============================================================================
// Math.sign
// =============================================================================

Deno.test("Math: Math.sign(-5) returns -1", () => {
  assertNumericResult('let result = Math.sign(-5)', 'result', -1);
});

Deno.test("Math: Math.sign(5) returns 1", () => {
  assertNumericResult('let result = Math.sign(5)', 'result', 1);
});

Deno.test("Math: Math.sign(0) returns 0", () => {
  assertNumericResult('let result = Math.sign(0)', 'result', 0);
});

// =============================================================================
// Math Constants
// =============================================================================

Deno.test("Math: Math.PI returns pi", () => {
  assertNumericResult('let result = Math.PI', 'result', Math.PI);
});

Deno.test("Math: Math.E returns e", () => {
  assertNumericResult('let result = Math.E', 'result', Math.E);
});

Deno.test("Math: Math.LN2 returns ln(2)", () => {
  assertNumericResult('let result = Math.LN2', 'result', Math.LN2);
});

Deno.test("Math: Math.SQRT2 returns sqrt(2)", () => {
  assertNumericResult('let result = Math.SQRT2', 'result', Math.SQRT2);
});

// =============================================================================
// Math.log/exp
// =============================================================================

Deno.test("Math: Math.log(1) returns 0", () => {
  assertNumericResult('let result = Math.log(1)', 'result', 0);
});

Deno.test("Math: Math.log(Math.E) returns 1", () => {
  assertNumericResult('let result = Math.log(Math.E)', 'result', Math.log(Math.E));
});

Deno.test("Math: Math.exp(0) returns 1", () => {
  assertNumericResult('let result = Math.exp(0)', 'result', 1);
});

Deno.test("Math: Math.exp(1) returns e", () => {
  assertNumericResult('let result = Math.exp(1)', 'result', Math.exp(1));
});

// =============================================================================
// Math.log10/log2
// =============================================================================

Deno.test("Math: Math.log10(100) returns 2", () => {
  assertNumericResult('let result = Math.log10(100)', 'result', Math.log10(100));
});

Deno.test("Math: Math.log2(8) returns 3", () => {
  assertNumericResult('let result = Math.log2(8)', 'result', Math.log2(8));
});

// =============================================================================
// Math.cbrt
// =============================================================================

Deno.test("Math: Math.cbrt(8) returns 2", () => {
  assertNumericResult('let result = Math.cbrt(8)', 'result', 2);
});

Deno.test("Math: Math.cbrt(-8) returns -2", () => {
  assertNumericResult('let result = Math.cbrt(-8)', 'result', -2);
});

// =============================================================================
// Math.hypot
// =============================================================================

Deno.test("Math: Math.hypot(3, 4) returns 5", () => {
  assertNumericResult('let result = Math.hypot(3, 4)', 'result', 5);
});

// =============================================================================
// Trigonometric functions
// =============================================================================

Deno.test("Math: Math.sin(0) returns 0", () => {
  assertNumericResult('let result = Math.sin(0)', 'result', 0);
});

Deno.test("Math: Math.sin(Math.PI/2) returns 1", () => {
  assertNumericResult('let result = Math.sin(Math.PI / 2)', 'result', Math.sin(Math.PI / 2));
});

Deno.test("Math: Math.cos(0) returns 1", () => {
  assertNumericResult('let result = Math.cos(0)', 'result', 1);
});

Deno.test("Math: Math.cos(Math.PI) returns -1", () => {
  assertNumericResult('let result = Math.cos(Math.PI)', 'result', -1);
});

Deno.test("Math: Math.tan(0) returns 0", () => {
  assertNumericResult('let result = Math.tan(0)', 'result', 0);
});

// =============================================================================
// Inverse trigonometric functions
// =============================================================================

Deno.test("Math: Math.asin(0) returns 0", () => {
  assertNumericResult('let result = Math.asin(0)', 'result', 0);
});

Deno.test("Math: Math.asin(1) returns PI/2", () => {
  assertNumericResult('let result = Math.asin(1)', 'result', Math.asin(1));
});

Deno.test("Math: Math.acos(1) returns 0", () => {
  assertNumericResult('let result = Math.acos(1)', 'result', 0);
});

Deno.test("Math: Math.atan(0) returns 0", () => {
  assertNumericResult('let result = Math.atan(0)', 'result', 0);
});

Deno.test("Math: Math.atan(1) returns PI/4", () => {
  assertNumericResult('let result = Math.atan(1)', 'result', Math.atan(1));
});

// =============================================================================
// Math.atan2
// =============================================================================

Deno.test("Math: Math.atan2(1, 1) returns PI/4", () => {
  assertNumericResult('let result = Math.atan2(1, 1)', 'result', Math.atan2(1, 1));
});

Deno.test("Math: Math.atan2(0, 1) returns 0", () => {
  assertNumericResult('let result = Math.atan2(0, 1)', 'result', 0);
});

// =============================================================================
// Hyperbolic functions
// =============================================================================

Deno.test("Math: Math.sinh(0) returns 0", () => {
  assertNumericResult('let result = Math.sinh(0)', 'result', 0);
});

Deno.test("Math: Math.cosh(0) returns 1", () => {
  assertNumericResult('let result = Math.cosh(0)', 'result', 1);
});

Deno.test("Math: Math.tanh(0) returns 0", () => {
  assertNumericResult('let result = Math.tanh(0)', 'result', 0);
});

// =============================================================================
// Inverse hyperbolic functions
// =============================================================================

Deno.test("Math: Math.asinh(0) returns 0", () => {
  assertNumericResult('let result = Math.asinh(0)', 'result', 0);
});

Deno.test("Math: Math.acosh(1) returns 0", () => {
  assertNumericResult('let result = Math.acosh(1)', 'result', 0);
});

Deno.test("Math: Math.atanh(0) returns 0", () => {
  assertNumericResult('let result = Math.atanh(0)', 'result', 0);
});

// =============================================================================
// Math.clz32/imul/fround
// =============================================================================

Deno.test("Math: Math.clz32(1) returns 31", () => {
  assertNumericResult('let result = Math.clz32(1)', 'result', 31);
});

Deno.test("Math: Math.imul(3, 4) returns 12", () => {
  assertNumericResult('let result = Math.imul(3, 4)', 'result', 12);
});

Deno.test("Math: Math.fround(1.5) returns 1.5", () => {
  assertNumericResult('let result = Math.fround(1.5)', 'result', 1.5);
});

// =============================================================================
// Sanity tests with SANITY_VALUE = 0.5665263062638896
// =============================================================================

const SANITY_VALUE = 0.5665263062638896;

Deno.test("Math: Math.exp(SANITY_VALUE) exact match", () => {
  assertNumericResult(`let result = Math.exp(${SANITY_VALUE})`, 'result', Math.exp(SANITY_VALUE));
});

Deno.test("Math: Math.log(SANITY_VALUE) exact match", () => {
  assertNumericResult(`let result = Math.log(${SANITY_VALUE})`, 'result', Math.log(SANITY_VALUE));
});

Deno.test("Math: Math.log2(SANITY_VALUE) exact match", () => {
  assertNumericResult(`let result = Math.log2(${SANITY_VALUE})`, 'result', Math.log2(SANITY_VALUE));
});

Deno.test("Math: Math.log10(SANITY_VALUE) exact match", () => {
  assertNumericResult(`let result = Math.log10(${SANITY_VALUE})`, 'result', Math.log10(SANITY_VALUE));
});

Deno.test("Math: Math.log1p(SANITY_VALUE) exact match", () => {
  assertNumericResult(`let result = Math.log1p(${SANITY_VALUE})`, 'result', Math.log1p(SANITY_VALUE));
});

Deno.test("Math: Math.expm1(SANITY_VALUE) exact match", () => {
  assertNumericResult(`let result = Math.expm1(${SANITY_VALUE})`, 'result', Math.expm1(SANITY_VALUE));
});

Deno.test("Math: Math.sin(SANITY_VALUE) exact match", () => {
  assertNumericResult(`let result = Math.sin(${SANITY_VALUE})`, 'result', Math.sin(SANITY_VALUE));
});

Deno.test("Math: Math.cos(SANITY_VALUE) exact match", () => {
  assertNumericResult(`let result = Math.cos(${SANITY_VALUE})`, 'result', Math.cos(SANITY_VALUE));
});

Deno.test("Math: Math.tan(SANITY_VALUE) exact match", () => {
  assertNumericResult(`let result = Math.tan(${SANITY_VALUE})`, 'result', Math.tan(SANITY_VALUE));
});

Deno.test("Math: Math.asin(SANITY_VALUE) exact match", () => {
  assertNumericResult(`let result = Math.asin(${SANITY_VALUE})`, 'result', Math.asin(SANITY_VALUE));
});

Deno.test("Math: Math.acos(SANITY_VALUE) exact match", () => {
  assertNumericResult(`let result = Math.acos(${SANITY_VALUE})`, 'result', Math.acos(SANITY_VALUE));
});

Deno.test("Math: Math.atan(SANITY_VALUE) exact match", () => {
  assertNumericResult(`let result = Math.atan(${SANITY_VALUE})`, 'result', Math.atan(SANITY_VALUE));
});

Deno.test("Math: Math.sinh(SANITY_VALUE) exact match", () => {
  assertNumericResult(`let result = Math.sinh(${SANITY_VALUE})`, 'result', Math.sinh(SANITY_VALUE));
});

Deno.test("Math: Math.cosh(SANITY_VALUE) exact match", () => {
  assertNumericResult(`let result = Math.cosh(${SANITY_VALUE})`, 'result', Math.cosh(SANITY_VALUE));
});

Deno.test("Math: Math.tanh(SANITY_VALUE) exact match", () => {
  assertNumericResult(`let result = Math.tanh(${SANITY_VALUE})`, 'result', Math.tanh(SANITY_VALUE));
});

Deno.test("Math: Math.asinh(SANITY_VALUE) exact match", () => {
  assertNumericResult(`let result = Math.asinh(${SANITY_VALUE})`, 'result', Math.asinh(SANITY_VALUE));
});

Deno.test("Math: Math.atanh(SANITY_VALUE) exact match", () => {
  assertNumericResult(`let result = Math.atanh(${SANITY_VALUE})`, 'result', Math.atanh(SANITY_VALUE));
});

Deno.test("Math: Math.sqrt(SANITY_VALUE) exact match", () => {
  assertNumericResult(`let result = Math.sqrt(${SANITY_VALUE})`, 'result', Math.sqrt(SANITY_VALUE));
});

Deno.test("Math: Math.cbrt(SANITY_VALUE) exact match", () => {
  assertNumericResult(`let result = Math.cbrt(${SANITY_VALUE})`, 'result', Math.cbrt(SANITY_VALUE));
});

Deno.test("Math: Math.pow(SANITY_VALUE, 2.5) exact match", () => {
  assertNumericResult(`let result = Math.pow(${SANITY_VALUE}, 2.5)`, 'result', Math.pow(SANITY_VALUE, 2.5));
});

// =============================================================================
// Sanity tests with SANITY_NEG = -0.7078123361793136
// =============================================================================

const SANITY_NEG = -0.7078123361793136;

Deno.test("Math: Math.exp(SANITY_NEG) exact match", () => {
  assertNumericResult(`let result = Math.exp(${SANITY_NEG})`, 'result', Math.exp(SANITY_NEG));
});

Deno.test("Math: Math.expm1(SANITY_NEG) exact match", () => {
  assertNumericResult(`let result = Math.expm1(${SANITY_NEG})`, 'result', Math.expm1(SANITY_NEG));
});

Deno.test("Math: Math.sin(SANITY_NEG) exact match", () => {
  assertNumericResult(`let result = Math.sin(${SANITY_NEG})`, 'result', Math.sin(SANITY_NEG));
});

Deno.test("Math: Math.cos(SANITY_NEG) exact match", () => {
  assertNumericResult(`let result = Math.cos(${SANITY_NEG})`, 'result', Math.cos(SANITY_NEG));
});

Deno.test("Math: Math.tan(SANITY_NEG) exact match", () => {
  assertNumericResult(`let result = Math.tan(${SANITY_NEG})`, 'result', Math.tan(SANITY_NEG));
});

Deno.test("Math: Math.asin(SANITY_NEG) exact match", () => {
  assertNumericResult(`let result = Math.asin(${SANITY_NEG})`, 'result', Math.asin(SANITY_NEG));
});

Deno.test("Math: Math.acos(SANITY_NEG) exact match", () => {
  assertNumericResult(`let result = Math.acos(${SANITY_NEG})`, 'result', Math.acos(SANITY_NEG));
});

Deno.test("Math: Math.atan(SANITY_NEG) exact match", () => {
  assertNumericResult(`let result = Math.atan(${SANITY_NEG})`, 'result', Math.atan(SANITY_NEG));
});

Deno.test("Math: Math.sinh(SANITY_NEG) exact match", () => {
  assertNumericResult(`let result = Math.sinh(${SANITY_NEG})`, 'result', Math.sinh(SANITY_NEG));
});

Deno.test("Math: Math.cosh(SANITY_NEG) exact match", () => {
  assertNumericResult(`let result = Math.cosh(${SANITY_NEG})`, 'result', Math.cosh(SANITY_NEG));
});

Deno.test("Math: Math.tanh(SANITY_NEG) exact match", () => {
  assertNumericResult(`let result = Math.tanh(${SANITY_NEG})`, 'result', Math.tanh(SANITY_NEG));
});

Deno.test("Math: Math.asinh(SANITY_NEG) exact match", () => {
  assertNumericResult(`let result = Math.asinh(${SANITY_NEG})`, 'result', Math.asinh(SANITY_NEG));
});

Deno.test("Math: Math.atanh(SANITY_NEG) exact match", () => {
  assertNumericResult(`let result = Math.atanh(${SANITY_NEG})`, 'result', Math.atanh(SANITY_NEG));
});

Deno.test("Math: Math.cbrt(SANITY_NEG) exact match", () => {
  assertNumericResult(`let result = Math.cbrt(${SANITY_NEG})`, 'result', Math.cbrt(SANITY_NEG));
});

Deno.test("Math: Math.pow(SANITY_NEG, 3) exact match", () => {
  assertNumericResult(`let result = Math.pow(${SANITY_NEG}, 3)`, 'result', Math.pow(SANITY_NEG, 3));
});

// =============================================================================
// Sanity tests with SANITY_GT1 = 1.865634627938732
// =============================================================================

const SANITY_GT1 = 1.865634627938732;

Deno.test("Math: Math.exp(SANITY_GT1) exact match", () => {
  assertNumericResult(`let result = Math.exp(${SANITY_GT1})`, 'result', Math.exp(SANITY_GT1));
});

Deno.test("Math: Math.expm1(SANITY_GT1) exact match", () => {
  assertNumericResult(`let result = Math.expm1(${SANITY_GT1})`, 'result', Math.expm1(SANITY_GT1));
});

Deno.test("Math: Math.log(SANITY_GT1) exact match", () => {
  assertNumericResult(`let result = Math.log(${SANITY_GT1})`, 'result', Math.log(SANITY_GT1));
});

Deno.test("Math: Math.log2(SANITY_GT1) exact match", () => {
  assertNumericResult(`let result = Math.log2(${SANITY_GT1})`, 'result', Math.log2(SANITY_GT1));
});

Deno.test("Math: Math.log10(SANITY_GT1) exact match", () => {
  assertNumericResult(`let result = Math.log10(${SANITY_GT1})`, 'result', Math.log10(SANITY_GT1));
});

Deno.test("Math: Math.log1p(SANITY_GT1) exact match", () => {
  assertNumericResult(`let result = Math.log1p(${SANITY_GT1})`, 'result', Math.log1p(SANITY_GT1));
});

Deno.test("Math: Math.sin(SANITY_GT1) exact match", () => {
  assertNumericResult(`let result = Math.sin(${SANITY_GT1})`, 'result', Math.sin(SANITY_GT1));
});

Deno.test("Math: Math.cos(SANITY_GT1) exact match", () => {
  assertNumericResult(`let result = Math.cos(${SANITY_GT1})`, 'result', Math.cos(SANITY_GT1));
});

Deno.test("Math: Math.tan(SANITY_GT1) exact match", () => {
  assertNumericResult(`let result = Math.tan(${SANITY_GT1})`, 'result', Math.tan(SANITY_GT1));
});

Deno.test("Math: Math.atan(SANITY_GT1) exact match", () => {
  assertNumericResult(`let result = Math.atan(${SANITY_GT1})`, 'result', Math.atan(SANITY_GT1));
});

Deno.test("Math: Math.sinh(SANITY_GT1) exact match", () => {
  assertNumericResult(`let result = Math.sinh(${SANITY_GT1})`, 'result', Math.sinh(SANITY_GT1));
});

Deno.test("Math: Math.cosh(SANITY_GT1) exact match", () => {
  assertNumericResult(`let result = Math.cosh(${SANITY_GT1})`, 'result', Math.cosh(SANITY_GT1));
});

Deno.test("Math: Math.tanh(SANITY_GT1) exact match", () => {
  assertNumericResult(`let result = Math.tanh(${SANITY_GT1})`, 'result', Math.tanh(SANITY_GT1));
});

Deno.test("Math: Math.asinh(SANITY_GT1) exact match", () => {
  assertNumericResult(`let result = Math.asinh(${SANITY_GT1})`, 'result', Math.asinh(SANITY_GT1));
});

Deno.test("Math: Math.acosh(SANITY_GT1) exact match", () => {
  assertNumericResult(`let result = Math.acosh(${SANITY_GT1})`, 'result', Math.acosh(SANITY_GT1));
});

Deno.test("Math: Math.sqrt(SANITY_GT1) exact match", () => {
  assertNumericResult(`let result = Math.sqrt(${SANITY_GT1})`, 'result', Math.sqrt(SANITY_GT1));
});

Deno.test("Math: Math.cbrt(SANITY_GT1) exact match", () => {
  assertNumericResult(`let result = Math.cbrt(${SANITY_GT1})`, 'result', Math.cbrt(SANITY_GT1));
});

Deno.test("Math: Math.pow(SANITY_GT1, 2.5) exact match", () => {
  assertNumericResult(`let result = Math.pow(${SANITY_GT1}, 2.5)`, 'result', Math.pow(SANITY_GT1, 2.5));
});

// =============================================================================
// Sanity tests with SANITY_LARGE = 18023.495369343371
// =============================================================================

const SANITY_LARGE = 18023.495369343371;

Deno.test("Math: Math.log(SANITY_LARGE) exact match", () => {
  assertNumericResult(`let result = Math.log(${SANITY_LARGE})`, 'result', Math.log(SANITY_LARGE));
});

Deno.test("Math: Math.log2(SANITY_LARGE) exact match", () => {
  assertNumericResult(`let result = Math.log2(${SANITY_LARGE})`, 'result', Math.log2(SANITY_LARGE));
});

Deno.test("Math: Math.log10(SANITY_LARGE) exact match", () => {
  assertNumericResult(`let result = Math.log10(${SANITY_LARGE})`, 'result', Math.log10(SANITY_LARGE));
});

Deno.test("Math: Math.log1p(SANITY_LARGE) exact match", () => {
  assertNumericResult(`let result = Math.log1p(${SANITY_LARGE})`, 'result', Math.log1p(SANITY_LARGE));
});

Deno.test("Math: Math.sin(SANITY_LARGE) exact match", () => {
  assertNumericResult(`let result = Math.sin(${SANITY_LARGE})`, 'result', Math.sin(SANITY_LARGE));
});

Deno.test("Math: Math.cos(SANITY_LARGE) exact match", () => {
  assertNumericResult(`let result = Math.cos(${SANITY_LARGE})`, 'result', Math.cos(SANITY_LARGE));
});

Deno.test("Math: Math.tan(SANITY_LARGE) exact match", () => {
  assertNumericResult(`let result = Math.tan(${SANITY_LARGE})`, 'result', Math.tan(SANITY_LARGE));
});

Deno.test("Math: Math.atan(SANITY_LARGE) exact match", () => {
  assertNumericResult(`let result = Math.atan(${SANITY_LARGE})`, 'result', Math.atan(SANITY_LARGE));
});

Deno.test("Math: Math.sinh(SANITY_LARGE) exact match", () => {
  assertNumericResult(`let result = Math.sinh(${SANITY_LARGE})`, 'result', Math.sinh(SANITY_LARGE));
});

Deno.test("Math: Math.cosh(SANITY_LARGE) exact match", () => {
  assertNumericResult(`let result = Math.cosh(${SANITY_LARGE})`, 'result', Math.cosh(SANITY_LARGE));
});

Deno.test("Math: Math.tanh(SANITY_LARGE) exact match", () => {
  assertNumericResult(`let result = Math.tanh(${SANITY_LARGE})`, 'result', Math.tanh(SANITY_LARGE));
});

Deno.test("Math: Math.asinh(SANITY_LARGE) exact match", () => {
  assertNumericResult(`let result = Math.asinh(${SANITY_LARGE})`, 'result', Math.asinh(SANITY_LARGE));
});

Deno.test("Math: Math.acosh(SANITY_LARGE) exact match", () => {
  assertNumericResult(`let result = Math.acosh(${SANITY_LARGE})`, 'result', Math.acosh(SANITY_LARGE));
});

Deno.test("Math: Math.sqrt(SANITY_LARGE) exact match", () => {
  assertNumericResult(`let result = Math.sqrt(${SANITY_LARGE})`, 'result', Math.sqrt(SANITY_LARGE));
});

Deno.test("Math: Math.cbrt(SANITY_LARGE) exact match", () => {
  assertNumericResult(`let result = Math.cbrt(${SANITY_LARGE})`, 'result', Math.cbrt(SANITY_LARGE));
});

Deno.test("Math: Math.pow(SANITY_LARGE, 0.3) exact match", () => {
  assertNumericResult(`let result = Math.pow(${SANITY_LARGE}, 0.3)`, 'result', Math.pow(SANITY_LARGE, 0.3));
});

// =============================================================================
// Global constants: Infinity, NaN, undefined
// =============================================================================

Deno.test("Math: Infinity global constant", () => {
  assertInfinityResult('let x = Infinity', 'x', true);
});

Deno.test("Math: Negative Infinity via negation", () => {
  assertInfinityResult('let x = -Infinity', 'x', false);
});

Deno.test("Math: 1/0 returns Infinity", () => {
  assertInfinityResult('let x = 1 / 0', 'x', true);
});

Deno.test("Math: -1/0 returns -Infinity", () => {
  assertInfinityResult('let x = -1 / 0', 'x', false);
});

Deno.test("Math: Number.POSITIVE_INFINITY", () => {
  assertInfinityResult('let x = Number.POSITIVE_INFINITY', 'x', true);
});

Deno.test("Math: Number.NEGATIVE_INFINITY", () => {
  assertInfinityResult('let x = Number.NEGATIVE_INFINITY', 'x', false);
});

Deno.test("Math: NaN global constant", () => {
  assertNaNResult('let x = NaN', 'x');
});

Deno.test("Math: 0/0 returns NaN", () => {
  assertNaNResult('let x = 0 / 0', 'x');
});

Deno.test("Math: Number.NaN", () => {
  assertNaNResult('let x = Number.NaN', 'x');
});

Deno.test("Math: Math.sqrt(-1) returns NaN", () => {
  assertNaNResult('let x = Math.sqrt(-1)', 'x');
});

Deno.test("Math: undefined global constant", () => {
  assertUndefinedResult('let x = undefined', 'x');
});

// =============================================================================
// Number static methods
// =============================================================================

Deno.test("Math: isNaN(NaN) returns true", () => {
  assertBooleanResult('let x = isNaN(NaN)', 'x', true);
});

Deno.test("Math: isNaN(5) returns false", () => {
  assertBooleanResult('let x = isNaN(5)', 'x', false);
});

Deno.test("Math: isNaN(undefined) returns true", () => {
  assertBooleanResult('let x = isNaN(undefined)', 'x', true);
});

Deno.test("Math: isNaN(Infinity) returns false", () => {
  assertBooleanResult('let x = isNaN(Infinity)', 'x', false);
});

Deno.test("Math: isFinite(5) returns true", () => {
  assertBooleanResult('let x = isFinite(5)', 'x', true);
});

Deno.test("Math: isFinite(Infinity) returns false", () => {
  assertBooleanResult('let x = isFinite(Infinity)', 'x', false);
});

Deno.test("Math: isFinite(-Infinity) returns false", () => {
  assertBooleanResult('let x = isFinite(-Infinity)', 'x', false);
});

Deno.test("Math: isFinite(NaN) returns false", () => {
  assertBooleanResult('let x = isFinite(NaN)', 'x', false);
});

Deno.test("Math: Number.isNaN(NaN) returns true", () => {
  assertBooleanResult('let x = Number.isNaN(NaN)', 'x', true);
});

Deno.test("Math: Number.isNaN(5) returns false", () => {
  assertBooleanResult('let x = Number.isNaN(5)', 'x', false);
});

Deno.test("Math: Number.isNaN(undefined) returns false", () => {
  assertBooleanResult('let x = Number.isNaN(undefined)', 'x', false);
});

Deno.test("Math: Number.isFinite(5) returns true", () => {
  assertBooleanResult('let x = Number.isFinite(5)', 'x', true);
});

Deno.test("Math: Number.isFinite(Infinity) returns false", () => {
  assertBooleanResult('let x = Number.isFinite(Infinity)', 'x', false);
});

Deno.test("Math: Number.isFinite(NaN) returns false", () => {
  assertBooleanResult('let x = Number.isFinite(NaN)', 'x', false);
});

Deno.test("Math: Number.isInteger(5) returns true", () => {
  assertBooleanResult('let x = Number.isInteger(5)', 'x', true);
});

Deno.test("Math: Number.isInteger(5.0) returns true", () => {
  assertBooleanResult('let x = Number.isInteger(5.0)', 'x', true);
});

Deno.test("Math: Number.isInteger(5.5) returns false", () => {
  assertBooleanResult('let x = Number.isInteger(5.5)', 'x', false);
});

Deno.test("Math: Number.isInteger(Infinity) returns false", () => {
  assertBooleanResult('let x = Number.isInteger(Infinity)', 'x', false);
});

Deno.test("Math: Number.isInteger(NaN) returns false", () => {
  assertBooleanResult('let x = Number.isInteger(NaN)', 'x', false);
});

// =============================================================================
// parseInt
// =============================================================================

Deno.test("Math: parseInt(123) exact match", () => {
  assertNumericResult('let x = parseInt("123")', 'x', 123);
});

Deno.test("Math: parseInt(456 with spaces) exact match", () => {
  assertNumericResult('let x = parseInt("  456  ")', 'x', 456);
});

Deno.test("Math: parseInt(-789) exact match", () => {
  assertNumericResult('let x = parseInt("-789")', 'x', -789);
});

Deno.test("Math: parseInt(+42) exact match", () => {
  assertNumericResult('let x = parseInt("+42")', 'x', 42);
});

Deno.test("Math: parseInt(0xFF) exact match", () => {
  assertNumericResult('let x = parseInt("0xFF")', 'x', 255);
});

Deno.test("Math: parseInt(0xff) exact match", () => {
  assertNumericResult('let x = parseInt("0xff")', 'x', 255);
});

Deno.test("Math: parseInt(ff, 16) exact match", () => {
  assertNumericResult('let x = parseInt("ff", 16)', 'x', 255);
});

Deno.test("Math: parseInt(1010, 2) exact match", () => {
  assertNumericResult('let x = parseInt("1010", 2)', 'x', 10);
});

Deno.test("Math: parseInt(77, 8) exact match", () => {
  assertNumericResult('let x = parseInt("77", 8)', 'x', 63);
});

Deno.test("Math: parseInt(z, 36) exact match", () => {
  assertNumericResult('let x = parseInt("z", 36)', 'x', 35);
});

Deno.test("Math: parseInt(123abc) exact match", () => {
  assertNumericResult('let x = parseInt("123abc")', 'x', 123);
});

Deno.test("Math: parseInt(abc) returns NaN", () => {
  assertNaNResult('let x = parseInt("abc")', 'x');
});

Deno.test("Math: parseInt empty returns NaN", () => {
  assertNaNResult('let x = parseInt("")', 'x');
});

// =============================================================================
// parseFloat
// =============================================================================

Deno.test("Math: parseFloat(3.14) exact match", () => {
  assertNumericResult('let x = parseFloat("3.14")', 'x', 3.14);
});

Deno.test("Math: parseFloat(-2.5 with spaces) exact match", () => {
  assertNumericResult('let x = parseFloat("  -2.5  ")', 'x', -2.5);
});

Deno.test("Math: parseFloat(.5) exact match", () => {
  assertNumericResult('let x = parseFloat(".5")', 'x', 0.5);
});

Deno.test("Math: parseFloat(1e10) exact match", () => {
  assertNumericResult('let x = parseFloat("1e10")', 'x', 1e10);
});

Deno.test("Math: parseFloat(2.5e-3) exact match", () => {
  assertNumericResult('let x = parseFloat("2.5e-3")', 'x', 2.5e-3);
});

Deno.test("Math: parseFloat(1E+5) exact match", () => {
  assertNumericResult('let x = parseFloat("1E+5")', 'x', 1E+5);
});

Deno.test("Math: parseFloat(Infinity) returns Infinity", () => {
  assertInfinityResult('let x = parseFloat("Infinity")', 'x', true);
});

Deno.test("Math: parseFloat(-Infinity) returns -Infinity", () => {
  assertInfinityResult('let x = parseFloat("-Infinity")', 'x', false);
});

Deno.test("Math: parseFloat(123.456abc) exact match", () => {
  assertNumericResult('let x = parseFloat("123.456abc")', 'x', 123.456);
});

Deno.test("Math: parseFloat(abc) returns NaN", () => {
  assertNaNResult('let x = parseFloat("abc")', 'x');
});

Deno.test("Math: parseFloat empty returns NaN", () => {
  assertNaNResult('let x = parseFloat("")', 'x');
});

// =============================================================================
// Number.parseInt / Number.parseFloat
// =============================================================================

Deno.test("Math: Number.parseInt(123) exact match", () => {
  assertNumericResult('let x = Number.parseInt("123")', 'x', 123);
});

Deno.test("Math: Number.parseInt(ff, 16) exact match", () => {
  assertNumericResult('let x = Number.parseInt("ff", 16)', 'x', 255);
});

Deno.test("Math: Number.parseInt(abc) returns NaN", () => {
  assertNaNResult('let x = Number.parseInt("abc")', 'x');
});

Deno.test("Math: Number.parseFloat(3.14) exact match", () => {
  assertNumericResult('let x = Number.parseFloat("3.14")', 'x', 3.14);
});

Deno.test("Math: Number.parseFloat(2.5e-3) exact match", () => {
  assertNumericResult('let x = Number.parseFloat("2.5e-3")', 'x', 2.5e-3);
});

Deno.test("Math: Number.parseFloat(abc) returns NaN", () => {
  assertNaNResult('let x = Number.parseFloat("abc")', 'x');
});

// =============================================================================
// Number constants
// =============================================================================

Deno.test("Math: Number.MAX_VALUE exact match", () => {
  assertNumericResult('let x = Number.MAX_VALUE', 'x', Number.MAX_VALUE);
});

Deno.test("Math: Number.MIN_VALUE exact match", () => {
  assertNumericResult('let x = Number.MIN_VALUE', 'x', Number.MIN_VALUE);
});

Deno.test("Math: Number.MAX_SAFE_INTEGER exact match", () => {
  assertNumericResult('let x = Number.MAX_SAFE_INTEGER', 'x', Number.MAX_SAFE_INTEGER);
});

Deno.test("Math: Number.MIN_SAFE_INTEGER exact match", () => {
  assertNumericResult('let x = Number.MIN_SAFE_INTEGER', 'x', Number.MIN_SAFE_INTEGER);
});

Deno.test("Math: Number.EPSILON exact match", () => {
  assertNumericResult('let x = Number.EPSILON', 'x', Number.EPSILON);
});

// =============================================================================
// String.fromCharCode
// =============================================================================

Deno.test("Math: String.fromCharCode(65) returns A", () => {
  assertStringResult('let x = String.fromCharCode(65)', 'x', 'A');
});

Deno.test("Math: String.fromCharCode(72, 105) returns Hi", () => {
  assertStringResult('let x = String.fromCharCode(72, 105)', 'x', 'Hi');
});

Deno.test("Math: String.fromCharCode(0x48, 0x65, 0x6C, 0x6C, 0x6F) returns Hello", () => {
  assertStringResult('let x = String.fromCharCode(0x48, 0x65, 0x6C, 0x6C, 0x6F)', 'x', 'Hello');
});

Deno.test("Math: String.fromCharCode() returns empty string", () => {
  assertStringResult('let x = String.fromCharCode()', 'x', '');
});

// =============================================================================
// String.fromCodePoint
// =============================================================================

Deno.test("Math: String.fromCodePoint(65) returns A", () => {
  assertStringResult('let x = String.fromCodePoint(65)', 'x', 'A');
});

Deno.test("Math: String.fromCodePoint(72, 105) returns Hi", () => {
  assertStringResult('let x = String.fromCodePoint(72, 105)', 'x', 'Hi');
});

Deno.test("Math: String.fromCodePoint(128512) returns emoji", () => {
  assertStringResult('let x = String.fromCodePoint(128512)', 'x', String.fromCodePoint(128512));
});

Deno.test("Math: String.fromCodePoint() returns empty string", () => {
  assertStringResult('let x = String.fromCodePoint()', 'x', '');
});

// =============================================================================
// String() and Number() conversion functions
// =============================================================================

Deno.test("Math: String(undefined) returns 'undefined'", () => {
  assertStringResult('let x = String(undefined)', 'x', 'undefined');
});

Deno.test("Math: String(null) returns 'null'", () => {
  assertStringResult('let x = String(null)', 'x', 'null');
});

Deno.test("Math: String(true) returns 'true'", () => {
  assertStringResult('let x = String(true)', 'x', 'true');
});

Deno.test("Math: String(false) returns 'false'", () => {
  assertStringResult('let x = String(false)', 'x', 'false');
});

Deno.test("Math: String(hello) returns 'hello'", () => {
  assertStringResult('let x = String("hello")', 'x', 'hello');
});

Deno.test("Math: String(42) returns '42'", () => {
  assertStringResult('let x = String(42)', 'x', '42');
});

Deno.test("Math: String(3.14) returns decimal string", () => {
  assertStringResult('let x = String(3.14)', 'x', String(3.14));
});

Deno.test("Math: String(-5) returns '-5'", () => {
  assertStringResult('let x = String(-5)', 'x', '-5');
});

Deno.test("Math: String(0) returns '0'", () => {
  assertStringResult('let x = String(0)', 'x', '0');
});

Deno.test("Math: String(NaN) returns 'NaN'", () => {
  assertStringResult('let x = String(NaN)', 'x', 'NaN');
});

Deno.test("Math: String(Infinity) returns 'Infinity'", () => {
  assertStringResult('let x = String(Infinity)', 'x', 'Infinity');
});

Deno.test("Math: String(-Infinity) returns '-Infinity'", () => {
  assertStringResult('let x = String(-Infinity)', 'x', '-Infinity');
});

Deno.test("Math: String({}) returns '[object Object]'", () => {
  assertStringResult('let x = String({})', 'x', '[object Object]');
});

Deno.test("Math: Number(42) returns 42", () => {
  assertNumericResult('let x = Number(42)', 'x', 42);
});

Deno.test("Math: Number('123') parses string", () => {
  assertNumericResult('let x = Number("123")', 'x', 123);
});

Deno.test("Math: Number('3.14') parses decimal", () => {
  assertNumericResult('let x = Number("3.14")', 'x', 3.14);
});

Deno.test("Math: Number(true) returns 1", () => {
  assertNumericResult('let x = Number(true)', 'x', 1);
});

Deno.test("Math: Number(false) returns 0", () => {
  assertNumericResult('let x = Number(false)', 'x', 0);
});

Deno.test("Math: Number(null) returns 0", () => {
  assertNumericResult('let x = Number(null)', 'x', 0);
});

Deno.test("Math: Number(undefined) returns NaN", () => {
  assertNaNResult('let x = Number(undefined)', 'x');
});

Deno.test("Math: Number('not a number') returns NaN", () => {
  assertNaNResult('let x = Number("not a number")', 'x');
});

// =============================================================================
// Variadic Math.min / Math.max / Math.hypot (each used to read exactly two
// arguments: extras were silently dropped and single-argument calls read
// garbage past the args)
// =============================================================================

Deno.test("Math: Math.max variadic", () => {
  assertNumericResult('let result = Math.max(0, 1, 2, 3, 11, 4)', 'result', 11);
});

Deno.test("Math: Math.max single argument", () => {
  assertNumericResult('let result = Math.max(5)', 'result', 5);
});

Deno.test("Math: Math.max no arguments returns -Infinity", () => {
  assertNumericResult('let result = Math.max() === -Infinity ? 1 : 0', 'result', 1);
});

Deno.test("Math: Math.min variadic", () => {
  assertNumericResult('let result = Math.min(9, 8, -2, 7)', 'result', -2);
});

Deno.test("Math: Math.min single argument", () => {
  assertNumericResult('let result = Math.min(5)', 'result', 5);
});

Deno.test("Math: Math.min no arguments returns Infinity", () => {
  assertNumericResult('let result = Math.min() === Infinity ? 1 : 0', 'result', 1);
});

Deno.test("Math: Math.max with spread of large array", () => {
  assertNumericResult(`
    let big = [];
    for (let i = 0; i < 100; i++) big.push(i);
    let result = Math.max(...big)
  `, 'result', 99);
});

Deno.test("Math: Math.hypot variadic", () => {
  assertNumericResult('let result = Math.hypot(2, 3, 6)', 'result', 7);
});

Deno.test("Math: Math.hypot single argument", () => {
  assertNumericResult('let result = Math.hypot(-5)', 'result', 5);
});

Deno.test("Math: Math.hypot no arguments returns 0", () => {
  assertNumericResult('let result = Math.hypot()', 'result', 0);
});

Deno.test("Math: Math.max non-numeric argument yields NaN", () => {
  assertNaNResult('let result = Math.max(1, "x", 3)', 'result');
});

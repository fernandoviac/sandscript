/**
 * fdlibm Range Tests - Transcendental function tests across different value ranges.
 *
 * IMPORTANT: These tests are NOT redundant. The fdlibm algorithms used by V8/JavaScript
 * have DIFFERENT CODE PATHS for different input ranges. Each range uses optimized
 * polynomial approximations tuned for that specific domain. A bug could exist in one
 * range while other ranges work perfectly.
 *
 * For example, Math.sin uses:
 * - Direct polynomial for very small values (|x| < 2^-27)
 * - Minimax polynomial for |x| < π/4
 * - Argument reduction + kernel functions for larger values
 * - Special handling for Infinity, NaN, and denormals
 *
 * Every test value exercises a different code path. All tests require EXACT
 * floating-point match, not approximate equality.
 *
 * Run with: deno task test tests/fuel/math/fdlibm-ranges_test.js
 */

import { assertNumericResult } from '../interpreter-test-utils.js';

// =============================================================================
// SANITY_VALUE = 0.5665263062638896
// Primary polynomial range for most functions (|x| < 1)
// =============================================================================

const SANITY_VALUE = 0.5665263062638896;

// exp/log family
Deno.test("fdlibm range: Math.exp(SANITY_VALUE)", () => {
  assertNumericResult(`let result = Math.exp(${SANITY_VALUE})`, 'result', Math.exp(SANITY_VALUE));
});

Deno.test("fdlibm range: Math.log(SANITY_VALUE)", () => {
  assertNumericResult(`let result = Math.log(${SANITY_VALUE})`, 'result', Math.log(SANITY_VALUE));
});

Deno.test("fdlibm range: Math.log2(SANITY_VALUE)", () => {
  assertNumericResult(`let result = Math.log2(${SANITY_VALUE})`, 'result', Math.log2(SANITY_VALUE));
});

Deno.test("fdlibm range: Math.log10(SANITY_VALUE)", () => {
  assertNumericResult(`let result = Math.log10(${SANITY_VALUE})`, 'result', Math.log10(SANITY_VALUE));
});

Deno.test("fdlibm range: Math.log1p(SANITY_VALUE)", () => {
  assertNumericResult(`let result = Math.log1p(${SANITY_VALUE})`, 'result', Math.log1p(SANITY_VALUE));
});

Deno.test("fdlibm range: Math.expm1(SANITY_VALUE)", () => {
  assertNumericResult(`let result = Math.expm1(${SANITY_VALUE})`, 'result', Math.expm1(SANITY_VALUE));
});

// sin/cos/tan
Deno.test("fdlibm range: Math.sin(SANITY_VALUE)", () => {
  assertNumericResult(`let result = Math.sin(${SANITY_VALUE})`, 'result', Math.sin(SANITY_VALUE));
});

Deno.test("fdlibm range: Math.cos(SANITY_VALUE)", () => {
  assertNumericResult(`let result = Math.cos(${SANITY_VALUE})`, 'result', Math.cos(SANITY_VALUE));
});

Deno.test("fdlibm range: Math.tan(SANITY_VALUE)", () => {
  assertNumericResult(`let result = Math.tan(${SANITY_VALUE})`, 'result', Math.tan(SANITY_VALUE));
});

// asin/acos/atan
Deno.test("fdlibm range: Math.asin(SANITY_VALUE)", () => {
  assertNumericResult(`let result = Math.asin(${SANITY_VALUE})`, 'result', Math.asin(SANITY_VALUE));
});

Deno.test("fdlibm range: Math.acos(SANITY_VALUE)", () => {
  assertNumericResult(`let result = Math.acos(${SANITY_VALUE})`, 'result', Math.acos(SANITY_VALUE));
});

Deno.test("fdlibm range: Math.atan(SANITY_VALUE)", () => {
  assertNumericResult(`let result = Math.atan(${SANITY_VALUE})`, 'result', Math.atan(SANITY_VALUE));
});

// sinh/cosh/tanh
Deno.test("fdlibm range: Math.sinh(SANITY_VALUE)", () => {
  assertNumericResult(`let result = Math.sinh(${SANITY_VALUE})`, 'result', Math.sinh(SANITY_VALUE));
});

Deno.test("fdlibm range: Math.cosh(SANITY_VALUE)", () => {
  assertNumericResult(`let result = Math.cosh(${SANITY_VALUE})`, 'result', Math.cosh(SANITY_VALUE));
});

Deno.test("fdlibm range: Math.tanh(SANITY_VALUE)", () => {
  assertNumericResult(`let result = Math.tanh(${SANITY_VALUE})`, 'result', Math.tanh(SANITY_VALUE));
});

// asinh/atanh (acosh needs x >= 1)
Deno.test("fdlibm range: Math.asinh(SANITY_VALUE)", () => {
  assertNumericResult(`let result = Math.asinh(${SANITY_VALUE})`, 'result', Math.asinh(SANITY_VALUE));
});

Deno.test("fdlibm range: Math.atanh(SANITY_VALUE)", () => {
  assertNumericResult(`let result = Math.atanh(${SANITY_VALUE})`, 'result', Math.atanh(SANITY_VALUE));
});

// sqrt/cbrt/pow
Deno.test("fdlibm range: Math.sqrt(SANITY_VALUE)", () => {
  assertNumericResult(`let result = Math.sqrt(${SANITY_VALUE})`, 'result', Math.sqrt(SANITY_VALUE));
});

Deno.test("fdlibm range: Math.cbrt(SANITY_VALUE)", () => {
  assertNumericResult(`let result = Math.cbrt(${SANITY_VALUE})`, 'result', Math.cbrt(SANITY_VALUE));
});

Deno.test("fdlibm range: Math.pow(SANITY_VALUE, 2.5)", () => {
  assertNumericResult(`let result = Math.pow(${SANITY_VALUE}, 2.5)`, 'result', Math.pow(SANITY_VALUE, 2.5));
});

// =============================================================================
// SANITY_NEG = -0.7078123361793136
// Negative value handling - tests sign handling in algorithms
// =============================================================================

const SANITY_NEG = -0.7078123361793136;

Deno.test("fdlibm range: Math.exp(SANITY_NEG)", () => {
  assertNumericResult(`let result = Math.exp(${SANITY_NEG})`, 'result', Math.exp(SANITY_NEG));
});

Deno.test("fdlibm range: Math.expm1(SANITY_NEG)", () => {
  assertNumericResult(`let result = Math.expm1(${SANITY_NEG})`, 'result', Math.expm1(SANITY_NEG));
});

Deno.test("fdlibm range: Math.sin(SANITY_NEG)", () => {
  assertNumericResult(`let result = Math.sin(${SANITY_NEG})`, 'result', Math.sin(SANITY_NEG));
});

Deno.test("fdlibm range: Math.cos(SANITY_NEG)", () => {
  assertNumericResult(`let result = Math.cos(${SANITY_NEG})`, 'result', Math.cos(SANITY_NEG));
});

Deno.test("fdlibm range: Math.tan(SANITY_NEG)", () => {
  assertNumericResult(`let result = Math.tan(${SANITY_NEG})`, 'result', Math.tan(SANITY_NEG));
});

Deno.test("fdlibm range: Math.asin(SANITY_NEG)", () => {
  assertNumericResult(`let result = Math.asin(${SANITY_NEG})`, 'result', Math.asin(SANITY_NEG));
});

Deno.test("fdlibm range: Math.acos(SANITY_NEG)", () => {
  assertNumericResult(`let result = Math.acos(${SANITY_NEG})`, 'result', Math.acos(SANITY_NEG));
});

Deno.test("fdlibm range: Math.atan(SANITY_NEG)", () => {
  assertNumericResult(`let result = Math.atan(${SANITY_NEG})`, 'result', Math.atan(SANITY_NEG));
});

Deno.test("fdlibm range: Math.sinh(SANITY_NEG)", () => {
  assertNumericResult(`let result = Math.sinh(${SANITY_NEG})`, 'result', Math.sinh(SANITY_NEG));
});

Deno.test("fdlibm range: Math.cosh(SANITY_NEG)", () => {
  assertNumericResult(`let result = Math.cosh(${SANITY_NEG})`, 'result', Math.cosh(SANITY_NEG));
});

Deno.test("fdlibm range: Math.tanh(SANITY_NEG)", () => {
  assertNumericResult(`let result = Math.tanh(${SANITY_NEG})`, 'result', Math.tanh(SANITY_NEG));
});

Deno.test("fdlibm range: Math.asinh(SANITY_NEG)", () => {
  assertNumericResult(`let result = Math.asinh(${SANITY_NEG})`, 'result', Math.asinh(SANITY_NEG));
});

Deno.test("fdlibm range: Math.atanh(SANITY_NEG)", () => {
  assertNumericResult(`let result = Math.atanh(${SANITY_NEG})`, 'result', Math.atanh(SANITY_NEG));
});

Deno.test("fdlibm range: Math.cbrt(SANITY_NEG)", () => {
  assertNumericResult(`let result = Math.cbrt(${SANITY_NEG})`, 'result', Math.cbrt(SANITY_NEG));
});

Deno.test("fdlibm range: Math.pow(SANITY_NEG, 3)", () => {
  assertNumericResult(`let result = Math.pow(${SANITY_NEG}, 3)`, 'result', Math.pow(SANITY_NEG, 3));
});

// =============================================================================
// SANITY_GT1 = 1.865634627938732
// Values > 1 - tests different polynomial range and functions like acos, atanh
// =============================================================================

const SANITY_GT1 = 1.865634627938732;

Deno.test("fdlibm range: Math.exp(SANITY_GT1)", () => {
  assertNumericResult(`let result = Math.exp(${SANITY_GT1})`, 'result', Math.exp(SANITY_GT1));
});

Deno.test("fdlibm range: Math.expm1(SANITY_GT1)", () => {
  assertNumericResult(`let result = Math.expm1(${SANITY_GT1})`, 'result', Math.expm1(SANITY_GT1));
});

Deno.test("fdlibm range: Math.log(SANITY_GT1)", () => {
  assertNumericResult(`let result = Math.log(${SANITY_GT1})`, 'result', Math.log(SANITY_GT1));
});

Deno.test("fdlibm range: Math.log2(SANITY_GT1)", () => {
  assertNumericResult(`let result = Math.log2(${SANITY_GT1})`, 'result', Math.log2(SANITY_GT1));
});

Deno.test("fdlibm range: Math.log10(SANITY_GT1)", () => {
  assertNumericResult(`let result = Math.log10(${SANITY_GT1})`, 'result', Math.log10(SANITY_GT1));
});

Deno.test("fdlibm range: Math.log1p(SANITY_GT1)", () => {
  assertNumericResult(`let result = Math.log1p(${SANITY_GT1})`, 'result', Math.log1p(SANITY_GT1));
});

Deno.test("fdlibm range: Math.sin(SANITY_GT1)", () => {
  assertNumericResult(`let result = Math.sin(${SANITY_GT1})`, 'result', Math.sin(SANITY_GT1));
});

Deno.test("fdlibm range: Math.cos(SANITY_GT1)", () => {
  assertNumericResult(`let result = Math.cos(${SANITY_GT1})`, 'result', Math.cos(SANITY_GT1));
});

Deno.test("fdlibm range: Math.tan(SANITY_GT1)", () => {
  assertNumericResult(`let result = Math.tan(${SANITY_GT1})`, 'result', Math.tan(SANITY_GT1));
});

Deno.test("fdlibm range: Math.atan(SANITY_GT1)", () => {
  assertNumericResult(`let result = Math.atan(${SANITY_GT1})`, 'result', Math.atan(SANITY_GT1));
});

Deno.test("fdlibm range: Math.sinh(SANITY_GT1)", () => {
  assertNumericResult(`let result = Math.sinh(${SANITY_GT1})`, 'result', Math.sinh(SANITY_GT1));
});

Deno.test("fdlibm range: Math.cosh(SANITY_GT1)", () => {
  assertNumericResult(`let result = Math.cosh(${SANITY_GT1})`, 'result', Math.cosh(SANITY_GT1));
});

Deno.test("fdlibm range: Math.tanh(SANITY_GT1)", () => {
  assertNumericResult(`let result = Math.tanh(${SANITY_GT1})`, 'result', Math.tanh(SANITY_GT1));
});

Deno.test("fdlibm range: Math.asinh(SANITY_GT1)", () => {
  assertNumericResult(`let result = Math.asinh(${SANITY_GT1})`, 'result', Math.asinh(SANITY_GT1));
});

Deno.test("fdlibm range: Math.acosh(SANITY_GT1)", () => {
  assertNumericResult(`let result = Math.acosh(${SANITY_GT1})`, 'result', Math.acosh(SANITY_GT1));
});

Deno.test("fdlibm range: Math.sqrt(SANITY_GT1)", () => {
  assertNumericResult(`let result = Math.sqrt(${SANITY_GT1})`, 'result', Math.sqrt(SANITY_GT1));
});

Deno.test("fdlibm range: Math.cbrt(SANITY_GT1)", () => {
  assertNumericResult(`let result = Math.cbrt(${SANITY_GT1})`, 'result', Math.cbrt(SANITY_GT1));
});

Deno.test("fdlibm range: Math.pow(SANITY_GT1, 2.5)", () => {
  assertNumericResult(`let result = Math.pow(${SANITY_GT1}, 2.5)`, 'result', Math.pow(SANITY_GT1, 2.5));
});

// =============================================================================
// SANITY_LARGE = 18023.495369343371
// Large values - tests argument reduction for trig functions, overflow handling
// =============================================================================

const SANITY_LARGE = 18023.495369343371;

Deno.test("fdlibm range: Math.log(SANITY_LARGE)", () => {
  assertNumericResult(`let result = Math.log(${SANITY_LARGE})`, 'result', Math.log(SANITY_LARGE));
});

Deno.test("fdlibm range: Math.log2(SANITY_LARGE)", () => {
  assertNumericResult(`let result = Math.log2(${SANITY_LARGE})`, 'result', Math.log2(SANITY_LARGE));
});

Deno.test("fdlibm range: Math.log10(SANITY_LARGE)", () => {
  assertNumericResult(`let result = Math.log10(${SANITY_LARGE})`, 'result', Math.log10(SANITY_LARGE));
});

Deno.test("fdlibm range: Math.log1p(SANITY_LARGE)", () => {
  assertNumericResult(`let result = Math.log1p(${SANITY_LARGE})`, 'result', Math.log1p(SANITY_LARGE));
});

Deno.test("fdlibm range: Math.sin(SANITY_LARGE)", () => {
  assertNumericResult(`let result = Math.sin(${SANITY_LARGE})`, 'result', Math.sin(SANITY_LARGE));
});

Deno.test("fdlibm range: Math.cos(SANITY_LARGE)", () => {
  assertNumericResult(`let result = Math.cos(${SANITY_LARGE})`, 'result', Math.cos(SANITY_LARGE));
});

Deno.test("fdlibm range: Math.tan(SANITY_LARGE)", () => {
  assertNumericResult(`let result = Math.tan(${SANITY_LARGE})`, 'result', Math.tan(SANITY_LARGE));
});

Deno.test("fdlibm range: Math.atan(SANITY_LARGE)", () => {
  assertNumericResult(`let result = Math.atan(${SANITY_LARGE})`, 'result', Math.atan(SANITY_LARGE));
});

Deno.test("fdlibm range: Math.sinh(SANITY_LARGE)", () => {
  assertNumericResult(`let result = Math.sinh(${SANITY_LARGE})`, 'result', Math.sinh(SANITY_LARGE));
});

Deno.test("fdlibm range: Math.cosh(SANITY_LARGE)", () => {
  assertNumericResult(`let result = Math.cosh(${SANITY_LARGE})`, 'result', Math.cosh(SANITY_LARGE));
});

Deno.test("fdlibm range: Math.tanh(SANITY_LARGE)", () => {
  assertNumericResult(`let result = Math.tanh(${SANITY_LARGE})`, 'result', Math.tanh(SANITY_LARGE));
});

Deno.test("fdlibm range: Math.asinh(SANITY_LARGE)", () => {
  assertNumericResult(`let result = Math.asinh(${SANITY_LARGE})`, 'result', Math.asinh(SANITY_LARGE));
});

Deno.test("fdlibm range: Math.acosh(SANITY_LARGE)", () => {
  assertNumericResult(`let result = Math.acosh(${SANITY_LARGE})`, 'result', Math.acosh(SANITY_LARGE));
});

Deno.test("fdlibm range: Math.sqrt(SANITY_LARGE)", () => {
  assertNumericResult(`let result = Math.sqrt(${SANITY_LARGE})`, 'result', Math.sqrt(SANITY_LARGE));
});

Deno.test("fdlibm range: Math.cbrt(SANITY_LARGE)", () => {
  assertNumericResult(`let result = Math.cbrt(${SANITY_LARGE})`, 'result', Math.cbrt(SANITY_LARGE));
});

Deno.test("fdlibm range: Math.pow(SANITY_LARGE, 0.3)", () => {
  assertNumericResult(`let result = Math.pow(${SANITY_LARGE}, 0.3)`, 'result', Math.pow(SANITY_LARGE, 0.3));
});

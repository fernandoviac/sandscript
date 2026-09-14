/**
 * fdlibm Sentinel Value Tests - Boundary cases with special handling.
 *
 * IMPORTANT: These sentinel values (0, -1, 1, 2, Infinity, NaN) have SPECIAL
 * HANDLING in fdlibm algorithms. They often trigger:
 * - Early-exit fast paths
 * - Edge-case logic for domain boundaries
 * - Special return values (0, 1, Infinity, NaN)
 * - Sign handling edge cases
 *
 * Every single test here exercises a different code path that could have bugs
 * independent of the main polynomial computation paths.
 *
 * Run with: deno task test tests/fuel/math/fdlibm-sentinels_test.js
 */

import { assertNumericResult, assertNaNResult } from '../interpreter-test-utils.js';

// =============================================================================
// Sentinel: 0
// Zero has special handling in almost every transcendental function.
// Many functions return 0 or 1 directly, others return -Infinity.
// =============================================================================

Deno.test("fdlibm sentinel 0: Math.exp(0)", () => {
  assertNumericResult('let result = Math.exp(0)', 'result', Math.exp(0));
});

Deno.test("fdlibm sentinel 0: Math.expm1(0)", () => {
  assertNumericResult('let result = Math.expm1(0)', 'result', Math.expm1(0));
});

Deno.test("fdlibm sentinel 0: Math.log(0)", () => {
  assertNumericResult('let result = Math.log(0)', 'result', Math.log(0));
});

Deno.test("fdlibm sentinel 0: Math.log2(0)", () => {
  assertNumericResult('let result = Math.log2(0)', 'result', Math.log2(0));
});

Deno.test("fdlibm sentinel 0: Math.log10(0)", () => {
  assertNumericResult('let result = Math.log10(0)', 'result', Math.log10(0));
});

Deno.test("fdlibm sentinel 0: Math.log1p(0)", () => {
  assertNumericResult('let result = Math.log1p(0)', 'result', Math.log1p(0));
});

Deno.test("fdlibm sentinel 0: Math.sin(0)", () => {
  assertNumericResult('let result = Math.sin(0)', 'result', Math.sin(0));
});

Deno.test("fdlibm sentinel 0: Math.cos(0)", () => {
  assertNumericResult('let result = Math.cos(0)', 'result', Math.cos(0));
});

Deno.test("fdlibm sentinel 0: Math.tan(0)", () => {
  assertNumericResult('let result = Math.tan(0)', 'result', Math.tan(0));
});

Deno.test("fdlibm sentinel 0: Math.asin(0)", () => {
  assertNumericResult('let result = Math.asin(0)', 'result', Math.asin(0));
});

Deno.test("fdlibm sentinel 0: Math.acos(0)", () => {
  assertNumericResult('let result = Math.acos(0)', 'result', Math.acos(0));
});

Deno.test("fdlibm sentinel 0: Math.atan(0)", () => {
  assertNumericResult('let result = Math.atan(0)', 'result', Math.atan(0));
});

Deno.test("fdlibm sentinel 0: Math.sinh(0)", () => {
  assertNumericResult('let result = Math.sinh(0)', 'result', Math.sinh(0));
});

Deno.test("fdlibm sentinel 0: Math.cosh(0)", () => {
  assertNumericResult('let result = Math.cosh(0)', 'result', Math.cosh(0));
});

Deno.test("fdlibm sentinel 0: Math.tanh(0)", () => {
  assertNumericResult('let result = Math.tanh(0)', 'result', Math.tanh(0));
});

Deno.test("fdlibm sentinel 0: Math.asinh(0)", () => {
  assertNumericResult('let result = Math.asinh(0)', 'result', Math.asinh(0));
});

Deno.test("fdlibm sentinel 0: Math.atanh(0)", () => {
  assertNumericResult('let result = Math.atanh(0)', 'result', Math.atanh(0));
});

Deno.test("fdlibm sentinel 0: Math.sqrt(0)", () => {
  assertNumericResult('let result = Math.sqrt(0)', 'result', Math.sqrt(0));
});

Deno.test("fdlibm sentinel 0: Math.cbrt(0)", () => {
  assertNumericResult('let result = Math.cbrt(0)', 'result', Math.cbrt(0));
});

Deno.test("fdlibm sentinel 0: Math.pow(0, 2)", () => {
  assertNumericResult('let result = Math.pow(0, 2)', 'result', Math.pow(0, 2));
});

Deno.test("fdlibm sentinel 0: Math.pow(0, 0)", () => {
  assertNumericResult('let result = Math.pow(0, 0)', 'result', Math.pow(0, 0));
});

// =============================================================================
// Sentinel: -1
// Tests negative handling and domain boundaries (log1p(-1) = -Infinity, etc.)
// =============================================================================

Deno.test("fdlibm sentinel -1: Math.exp(-1)", () => {
  assertNumericResult('let result = Math.exp(-1)', 'result', Math.exp(-1));
});

Deno.test("fdlibm sentinel -1: Math.expm1(-1)", () => {
  assertNumericResult('let result = Math.expm1(-1)', 'result', Math.expm1(-1));
});

Deno.test("fdlibm sentinel -1: Math.log1p(-1)", () => {
  assertNumericResult('let result = Math.log1p(-1)', 'result', Math.log1p(-1));
});

Deno.test("fdlibm sentinel -1: Math.sin(-1)", () => {
  assertNumericResult('let result = Math.sin(-1)', 'result', Math.sin(-1));
});

Deno.test("fdlibm sentinel -1: Math.cos(-1)", () => {
  assertNumericResult('let result = Math.cos(-1)', 'result', Math.cos(-1));
});

Deno.test("fdlibm sentinel -1: Math.tan(-1)", () => {
  assertNumericResult('let result = Math.tan(-1)', 'result', Math.tan(-1));
});

Deno.test("fdlibm sentinel -1: Math.asin(-1)", () => {
  assertNumericResult('let result = Math.asin(-1)', 'result', Math.asin(-1));
});

Deno.test("fdlibm sentinel -1: Math.acos(-1)", () => {
  assertNumericResult('let result = Math.acos(-1)', 'result', Math.acos(-1));
});

Deno.test("fdlibm sentinel -1: Math.atan(-1)", () => {
  assertNumericResult('let result = Math.atan(-1)', 'result', Math.atan(-1));
});

Deno.test("fdlibm sentinel -1: Math.sinh(-1)", () => {
  assertNumericResult('let result = Math.sinh(-1)', 'result', Math.sinh(-1));
});

Deno.test("fdlibm sentinel -1: Math.cosh(-1)", () => {
  assertNumericResult('let result = Math.cosh(-1)', 'result', Math.cosh(-1));
});

Deno.test("fdlibm sentinel -1: Math.tanh(-1)", () => {
  assertNumericResult('let result = Math.tanh(-1)', 'result', Math.tanh(-1));
});

Deno.test("fdlibm sentinel -1: Math.asinh(-1)", () => {
  assertNumericResult('let result = Math.asinh(-1)', 'result', Math.asinh(-1));
});

Deno.test("fdlibm sentinel -1: Math.atanh(-1)", () => {
  assertNumericResult('let result = Math.atanh(-1)', 'result', Math.atanh(-1));
});

Deno.test("fdlibm sentinel -1: Math.cbrt(-1)", () => {
  assertNumericResult('let result = Math.cbrt(-1)', 'result', Math.cbrt(-1));
});

Deno.test("fdlibm sentinel -1: Math.pow(-1, 2)", () => {
  assertNumericResult('let result = Math.pow(-1, 2)', 'result', Math.pow(-1, 2));
});

Deno.test("fdlibm sentinel -1: Math.pow(-1, 3)", () => {
  assertNumericResult('let result = Math.pow(-1, 3)', 'result', Math.pow(-1, 3));
});

// =============================================================================
// Sentinel: Infinity
// Tests overflow handling and special Infinity cases
// =============================================================================

Deno.test("fdlibm sentinel Infinity: Math.exp(Infinity)", () => {
  assertNumericResult('let result = Math.exp(Infinity)', 'result', Math.exp(Infinity));
});

Deno.test("fdlibm sentinel Infinity: Math.exp(-Infinity)", () => {
  assertNumericResult('let result = Math.exp(-Infinity)', 'result', Math.exp(-Infinity));
});

Deno.test("fdlibm sentinel Infinity: Math.expm1(Infinity)", () => {
  assertNumericResult('let result = Math.expm1(Infinity)', 'result', Math.expm1(Infinity));
});

Deno.test("fdlibm sentinel Infinity: Math.expm1(-Infinity)", () => {
  assertNumericResult('let result = Math.expm1(-Infinity)', 'result', Math.expm1(-Infinity));
});

Deno.test("fdlibm sentinel Infinity: Math.log(Infinity)", () => {
  assertNumericResult('let result = Math.log(Infinity)', 'result', Math.log(Infinity));
});

Deno.test("fdlibm sentinel Infinity: Math.log2(Infinity)", () => {
  assertNumericResult('let result = Math.log2(Infinity)', 'result', Math.log2(Infinity));
});

Deno.test("fdlibm sentinel Infinity: Math.log10(Infinity)", () => {
  assertNumericResult('let result = Math.log10(Infinity)', 'result', Math.log10(Infinity));
});

Deno.test("fdlibm sentinel Infinity: Math.log1p(Infinity)", () => {
  assertNumericResult('let result = Math.log1p(Infinity)', 'result', Math.log1p(Infinity));
});

Deno.test("fdlibm sentinel Infinity: Math.sin(Infinity)", () => {
  assertNaNResult('let result = Math.sin(Infinity)', 'result');
});

Deno.test("fdlibm sentinel Infinity: Math.cos(Infinity)", () => {
  assertNaNResult('let result = Math.cos(Infinity)', 'result');
});

Deno.test("fdlibm sentinel Infinity: Math.tan(Infinity)", () => {
  assertNaNResult('let result = Math.tan(Infinity)', 'result');
});

Deno.test("fdlibm sentinel Infinity: Math.asin(Infinity)", () => {
  assertNaNResult('let result = Math.asin(Infinity)', 'result');
});

Deno.test("fdlibm sentinel Infinity: Math.acos(Infinity)", () => {
  assertNaNResult('let result = Math.acos(Infinity)', 'result');
});

Deno.test("fdlibm sentinel Infinity: Math.atan(Infinity)", () => {
  assertNumericResult('let result = Math.atan(Infinity)', 'result', Math.atan(Infinity));
});

Deno.test("fdlibm sentinel Infinity: Math.atan(-Infinity)", () => {
  assertNumericResult('let result = Math.atan(-Infinity)', 'result', Math.atan(-Infinity));
});

Deno.test("fdlibm sentinel Infinity: Math.sinh(Infinity)", () => {
  assertNumericResult('let result = Math.sinh(Infinity)', 'result', Math.sinh(Infinity));
});

Deno.test("fdlibm sentinel Infinity: Math.sinh(-Infinity)", () => {
  assertNumericResult('let result = Math.sinh(-Infinity)', 'result', Math.sinh(-Infinity));
});

Deno.test("fdlibm sentinel Infinity: Math.cosh(Infinity)", () => {
  assertNumericResult('let result = Math.cosh(Infinity)', 'result', Math.cosh(Infinity));
});

Deno.test("fdlibm sentinel Infinity: Math.cosh(-Infinity)", () => {
  assertNumericResult('let result = Math.cosh(-Infinity)', 'result', Math.cosh(-Infinity));
});

Deno.test("fdlibm sentinel Infinity: Math.tanh(Infinity)", () => {
  assertNumericResult('let result = Math.tanh(Infinity)', 'result', Math.tanh(Infinity));
});

Deno.test("fdlibm sentinel Infinity: Math.tanh(-Infinity)", () => {
  assertNumericResult('let result = Math.tanh(-Infinity)', 'result', Math.tanh(-Infinity));
});

Deno.test("fdlibm sentinel Infinity: Math.asinh(Infinity)", () => {
  assertNumericResult('let result = Math.asinh(Infinity)', 'result', Math.asinh(Infinity));
});

Deno.test("fdlibm sentinel Infinity: Math.asinh(-Infinity)", () => {
  assertNumericResult('let result = Math.asinh(-Infinity)', 'result', Math.asinh(-Infinity));
});

Deno.test("fdlibm sentinel Infinity: Math.acosh(Infinity)", () => {
  assertNumericResult('let result = Math.acosh(Infinity)', 'result', Math.acosh(Infinity));
});

Deno.test("fdlibm sentinel Infinity: Math.sqrt(Infinity)", () => {
  assertNumericResult('let result = Math.sqrt(Infinity)', 'result', Math.sqrt(Infinity));
});

Deno.test("fdlibm sentinel Infinity: Math.cbrt(Infinity)", () => {
  assertNumericResult('let result = Math.cbrt(Infinity)', 'result', Math.cbrt(Infinity));
});

Deno.test("fdlibm sentinel Infinity: Math.cbrt(-Infinity)", () => {
  assertNumericResult('let result = Math.cbrt(-Infinity)', 'result', Math.cbrt(-Infinity));
});

Deno.test("fdlibm sentinel Infinity: Math.pow(Infinity, 2)", () => {
  assertNumericResult('let result = Math.pow(Infinity, 2)', 'result', Math.pow(Infinity, 2));
});

Deno.test("fdlibm sentinel Infinity: Math.pow(2, Infinity)", () => {
  assertNumericResult('let result = Math.pow(2, Infinity)', 'result', Math.pow(2, Infinity));
});

Deno.test("fdlibm sentinel Infinity: Math.pow(0.5, Infinity)", () => {
  assertNumericResult('let result = Math.pow(0.5, Infinity)', 'result', Math.pow(0.5, Infinity));
});

Deno.test("fdlibm sentinel Infinity: Math.pow(Infinity, -1)", () => {
  assertNumericResult('let result = Math.pow(Infinity, -1)', 'result', Math.pow(Infinity, -1));
});

// =============================================================================
// Sentinel: NaN
// Tests NaN propagation - all functions should return NaN for NaN input
// =============================================================================

Deno.test("fdlibm sentinel NaN: Math.exp(NaN)", () => {
  assertNaNResult('let result = Math.exp(NaN)', 'result');
});

Deno.test("fdlibm sentinel NaN: Math.expm1(NaN)", () => {
  assertNaNResult('let result = Math.expm1(NaN)', 'result');
});

Deno.test("fdlibm sentinel NaN: Math.log(NaN)", () => {
  assertNaNResult('let result = Math.log(NaN)', 'result');
});

Deno.test("fdlibm sentinel NaN: Math.log2(NaN)", () => {
  assertNaNResult('let result = Math.log2(NaN)', 'result');
});

Deno.test("fdlibm sentinel NaN: Math.log10(NaN)", () => {
  assertNaNResult('let result = Math.log10(NaN)', 'result');
});

Deno.test("fdlibm sentinel NaN: Math.log1p(NaN)", () => {
  assertNaNResult('let result = Math.log1p(NaN)', 'result');
});

Deno.test("fdlibm sentinel NaN: Math.sin(NaN)", () => {
  assertNaNResult('let result = Math.sin(NaN)', 'result');
});

Deno.test("fdlibm sentinel NaN: Math.cos(NaN)", () => {
  assertNaNResult('let result = Math.cos(NaN)', 'result');
});

Deno.test("fdlibm sentinel NaN: Math.tan(NaN)", () => {
  assertNaNResult('let result = Math.tan(NaN)', 'result');
});

Deno.test("fdlibm sentinel NaN: Math.asin(NaN)", () => {
  assertNaNResult('let result = Math.asin(NaN)', 'result');
});

Deno.test("fdlibm sentinel NaN: Math.acos(NaN)", () => {
  assertNaNResult('let result = Math.acos(NaN)', 'result');
});

Deno.test("fdlibm sentinel NaN: Math.atan(NaN)", () => {
  assertNaNResult('let result = Math.atan(NaN)', 'result');
});

Deno.test("fdlibm sentinel NaN: Math.sinh(NaN)", () => {
  assertNaNResult('let result = Math.sinh(NaN)', 'result');
});

Deno.test("fdlibm sentinel NaN: Math.cosh(NaN)", () => {
  assertNaNResult('let result = Math.cosh(NaN)', 'result');
});

Deno.test("fdlibm sentinel NaN: Math.tanh(NaN)", () => {
  assertNaNResult('let result = Math.tanh(NaN)', 'result');
});

Deno.test("fdlibm sentinel NaN: Math.asinh(NaN)", () => {
  assertNaNResult('let result = Math.asinh(NaN)', 'result');
});

Deno.test("fdlibm sentinel NaN: Math.acosh(NaN)", () => {
  assertNaNResult('let result = Math.acosh(NaN)', 'result');
});

Deno.test("fdlibm sentinel NaN: Math.atanh(NaN)", () => {
  assertNaNResult('let result = Math.atanh(NaN)', 'result');
});

Deno.test("fdlibm sentinel NaN: Math.sqrt(NaN)", () => {
  assertNaNResult('let result = Math.sqrt(NaN)', 'result');
});

Deno.test("fdlibm sentinel NaN: Math.cbrt(NaN)", () => {
  assertNaNResult('let result = Math.cbrt(NaN)', 'result');
});

Deno.test("fdlibm sentinel NaN: Math.pow(NaN, 2)", () => {
  assertNaNResult('let result = Math.pow(NaN, 2)', 'result');
});

Deno.test("fdlibm sentinel NaN: Math.pow(2, NaN)", () => {
  assertNaNResult('let result = Math.pow(2, NaN)', 'result');
});

// =============================================================================
// Sentinel: 1
// Tests unity cases - many functions have special fast paths for x=1
// =============================================================================

Deno.test("fdlibm sentinel 1: Math.exp(1)", () => {
  assertNumericResult('let result = Math.exp(1)', 'result', Math.exp(1));
});

Deno.test("fdlibm sentinel 1: Math.expm1(1)", () => {
  assertNumericResult('let result = Math.expm1(1)', 'result', Math.expm1(1));
});

Deno.test("fdlibm sentinel 1: Math.log(1)", () => {
  assertNumericResult('let result = Math.log(1)', 'result', Math.log(1));
});

Deno.test("fdlibm sentinel 1: Math.log2(1)", () => {
  assertNumericResult('let result = Math.log2(1)', 'result', Math.log2(1));
});

Deno.test("fdlibm sentinel 1: Math.log10(1)", () => {
  assertNumericResult('let result = Math.log10(1)', 'result', Math.log10(1));
});

Deno.test("fdlibm sentinel 1: Math.log1p(1)", () => {
  assertNumericResult('let result = Math.log1p(1)', 'result', Math.log1p(1));
});

Deno.test("fdlibm sentinel 1: Math.sin(1)", () => {
  assertNumericResult('let result = Math.sin(1)', 'result', Math.sin(1));
});

Deno.test("fdlibm sentinel 1: Math.cos(1)", () => {
  assertNumericResult('let result = Math.cos(1)', 'result', Math.cos(1));
});

Deno.test("fdlibm sentinel 1: Math.tan(1)", () => {
  assertNumericResult('let result = Math.tan(1)', 'result', Math.tan(1));
});

Deno.test("fdlibm sentinel 1: Math.asin(1)", () => {
  assertNumericResult('let result = Math.asin(1)', 'result', Math.asin(1));
});

Deno.test("fdlibm sentinel 1: Math.acos(1)", () => {
  assertNumericResult('let result = Math.acos(1)', 'result', Math.acos(1));
});

Deno.test("fdlibm sentinel 1: Math.atan(1)", () => {
  assertNumericResult('let result = Math.atan(1)', 'result', Math.atan(1));
});

Deno.test("fdlibm sentinel 1: Math.sinh(1)", () => {
  assertNumericResult('let result = Math.sinh(1)', 'result', Math.sinh(1));
});

Deno.test("fdlibm sentinel 1: Math.cosh(1)", () => {
  assertNumericResult('let result = Math.cosh(1)', 'result', Math.cosh(1));
});

Deno.test("fdlibm sentinel 1: Math.tanh(1)", () => {
  assertNumericResult('let result = Math.tanh(1)', 'result', Math.tanh(1));
});

Deno.test("fdlibm sentinel 1: Math.asinh(1)", () => {
  assertNumericResult('let result = Math.asinh(1)', 'result', Math.asinh(1));
});

Deno.test("fdlibm sentinel 1: Math.acosh(1)", () => {
  assertNumericResult('let result = Math.acosh(1)', 'result', Math.acosh(1));
});

Deno.test("fdlibm sentinel 1: Math.atanh(1)", () => {
  assertNumericResult('let result = Math.atanh(1)', 'result', Math.atanh(1));
});

Deno.test("fdlibm sentinel 1: Math.sqrt(1)", () => {
  assertNumericResult('let result = Math.sqrt(1)', 'result', Math.sqrt(1));
});

Deno.test("fdlibm sentinel 1: Math.cbrt(1)", () => {
  assertNumericResult('let result = Math.cbrt(1)', 'result', Math.cbrt(1));
});

Deno.test("fdlibm sentinel 1: Math.pow(1, 100)", () => {
  assertNumericResult('let result = Math.pow(1, 100)', 'result', Math.pow(1, 100));
});

// =============================================================================
// Sentinel: 2
// Tests powers of 2 - important for binary floating-point algorithms
// =============================================================================

Deno.test("fdlibm sentinel 2: Math.exp(2)", () => {
  assertNumericResult('let result = Math.exp(2)', 'result', Math.exp(2));
});

Deno.test("fdlibm sentinel 2: Math.expm1(2)", () => {
  assertNumericResult('let result = Math.expm1(2)', 'result', Math.expm1(2));
});

Deno.test("fdlibm sentinel 2: Math.log(2)", () => {
  assertNumericResult('let result = Math.log(2)', 'result', Math.log(2));
});

Deno.test("fdlibm sentinel 2: Math.log2(2)", () => {
  assertNumericResult('let result = Math.log2(2)', 'result', Math.log2(2));
});

Deno.test("fdlibm sentinel 2: Math.log10(2)", () => {
  assertNumericResult('let result = Math.log10(2)', 'result', Math.log10(2));
});

Deno.test("fdlibm sentinel 2: Math.log1p(2)", () => {
  assertNumericResult('let result = Math.log1p(2)', 'result', Math.log1p(2));
});

Deno.test("fdlibm sentinel 2: Math.sin(2)", () => {
  assertNumericResult('let result = Math.sin(2)', 'result', Math.sin(2));
});

Deno.test("fdlibm sentinel 2: Math.cos(2)", () => {
  assertNumericResult('let result = Math.cos(2)', 'result', Math.cos(2));
});

Deno.test("fdlibm sentinel 2: Math.tan(2)", () => {
  assertNumericResult('let result = Math.tan(2)', 'result', Math.tan(2));
});

Deno.test("fdlibm sentinel 2: Math.atan(2)", () => {
  assertNumericResult('let result = Math.atan(2)', 'result', Math.atan(2));
});

Deno.test("fdlibm sentinel 2: Math.sinh(2)", () => {
  assertNumericResult('let result = Math.sinh(2)', 'result', Math.sinh(2));
});

Deno.test("fdlibm sentinel 2: Math.cosh(2)", () => {
  assertNumericResult('let result = Math.cosh(2)', 'result', Math.cosh(2));
});

Deno.test("fdlibm sentinel 2: Math.tanh(2)", () => {
  assertNumericResult('let result = Math.tanh(2)', 'result', Math.tanh(2));
});

Deno.test("fdlibm sentinel 2: Math.asinh(2)", () => {
  assertNumericResult('let result = Math.asinh(2)', 'result', Math.asinh(2));
});

Deno.test("fdlibm sentinel 2: Math.acosh(2)", () => {
  assertNumericResult('let result = Math.acosh(2)', 'result', Math.acosh(2));
});

Deno.test("fdlibm sentinel 2: Math.sqrt(2)", () => {
  assertNumericResult('let result = Math.sqrt(2)', 'result', Math.sqrt(2));
});

Deno.test("fdlibm sentinel 2: Math.cbrt(2)", () => {
  assertNumericResult('let result = Math.cbrt(2)', 'result', Math.cbrt(2));
});

Deno.test("fdlibm sentinel 2: Math.pow(2, 10)", () => {
  assertNumericResult('let result = Math.pow(2, 10)', 'result', Math.pow(2, 10));
});

Deno.test("fdlibm sentinel 2: Math.pow(2, 0.5)", () => {
  assertNumericResult('let result = Math.pow(2, 0.5)', 'result', Math.pow(2, 0.5));
});

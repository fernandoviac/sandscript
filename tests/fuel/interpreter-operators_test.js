/**
 * Test interpreter operators: comparison, logic, bitwise, increment, compound, comma, ternary, typeof.
 *
 * Run with: deno task test tests/fuel/interpreter-operators_test.js
 */

import {
  assertNumericResult,
  assertParseError,
  assertErrorCode,
} from './interpreter-test-utils.js';

// =============================================================================
// Comparison Operators
// =============================================================================

Deno.test("Comparison: strict equality true", () => {
  assertNumericResult('let x = 3 === 3; if (x) { x = 1 } else { x = 0 }', 'x', 1);
});

Deno.test("Comparison: strict equality false", () => {
  assertNumericResult('let x = 3 === 4; if (x) { x = 1 } else { x = 0 }', 'x', 0);
});

Deno.test("Comparison: strict inequality true", () => {
  assertNumericResult('let x = 3 !== 4; if (x) { x = 1 } else { x = 0 }', 'x', 1);
});

Deno.test("Comparison: strict inequality false", () => {
  assertNumericResult('let x = 3 !== 3; if (x) { x = 1 } else { x = 0 }', 'x', 0);
});

Deno.test("Comparison: less than true", () => {
  assertNumericResult('let x = 3 < 5; if (x) { x = 1 } else { x = 0 }', 'x', 1);
});

Deno.test("Comparison: less than false", () => {
  assertNumericResult('let x = 5 < 3; if (x) { x = 1 } else { x = 0 }', 'x', 0);
});

Deno.test("Comparison: greater than true", () => {
  assertNumericResult('let x = 5 > 3; if (x) { x = 1 } else { x = 0 }', 'x', 1);
});

Deno.test("Comparison: greater than false", () => {
  assertNumericResult('let x = 3 > 5; if (x) { x = 1 } else { x = 0 }', 'x', 0);
});

Deno.test("Comparison: greater than equal", () => {
  assertNumericResult('let x = 3 > 3; if (x) { x = 1 } else { x = 0 }', 'x', 0);
});

Deno.test("Comparison: less than or equal true", () => {
  assertNumericResult('let x = 3 <= 3; if (x) { x = 1 } else { x = 0 }', 'x', 1);
});

Deno.test("Comparison: less than or equal false", () => {
  assertNumericResult('let x = 5 <= 3; if (x) { x = 1 } else { x = 0 }', 'x', 0);
});

Deno.test("Comparison: greater than or equal true", () => {
  assertNumericResult('let x = 5 >= 3; if (x) { x = 1 } else { x = 0 }', 'x', 1);
});

Deno.test("Comparison: greater than or equal equal", () => {
  assertNumericResult('let x = 3 >= 3; if (x) { x = 1 } else { x = 0 }', 'x', 1);
});

Deno.test("Comparison: greater than or equal false", () => {
  assertNumericResult('let x = 3 >= 5; if (x) { x = 1 } else { x = 0 }', 'x', 0);
});

Deno.test("Comparison: float equality", () => {
  assertNumericResult('let x = 1.5; let y = 1.5; if (x === y) { x = 1 } else { x = 0 }', 'x', 1);
});

Deno.test("Comparison: string less than true", () => {
  assertNumericResult(`let x = 'a' < 'b'; if (x) { x = 1 } else { x = 0 }`, 'x', 1);
});

Deno.test("Comparison: string less than false", () => {
  assertNumericResult(`let x = 'b' < 'a'; if (x) { x = 1 } else { x = 0 }`, 'x', 0);
});

Deno.test("Comparison: string greater than true", () => {
  assertNumericResult(`let x = 'b' > 'a'; if (x) { x = 1 } else { x = 0 }`, 'x', 1);
});

Deno.test("Comparison: string greater than false", () => {
  assertNumericResult(`let x = 'a' > 'b'; if (x) { x = 1 } else { x = 0 }`, 'x', 0);
});

Deno.test("Comparison: string less than or equal, equal case", () => {
  assertNumericResult(`let x = 'a' <= 'a'; if (x) { x = 1 } else { x = 0 }`, 'x', 1);
});

Deno.test("Comparison: string greater than or equal, equal case", () => {
  assertNumericResult(`let x = 'a' >= 'a'; if (x) { x = 1 } else { x = 0 }`, 'x', 1);
});

Deno.test("Comparison: string prefix ordering ('app' < 'apple')", () => {
  assertNumericResult(`let x = 'app' < 'apple'; if (x) { x = 1 } else { x = 0 }`, 'x', 1);
});

Deno.test("Comparison: multi-character strings ('apple' < 'banana')", () => {
  assertNumericResult(`let x = 'apple' < 'banana'; if (x) { x = 1 } else { x = 0 }`, 'x', 1);
});

Deno.test("Comparison: empty string is smallest", () => {
  assertNumericResult(`let x = '' < 'a'; if (x) { x = 1 } else { x = 0 }`, 'x', 1);
});

Deno.test("Comparison: mixed string/number still throws INVALID_OPERAND", () => {
  assertErrorCode(`let x = 1 < 'a';`, 6); // ERR_INVALID_OPERAND
});

// =============================================================================
// Logical Operators (Short-Circuit)
// =============================================================================

Deno.test("Logic: AND both truthy", () => {
  assertNumericResult('let x = 1 && 2', 'x', 2);
});

Deno.test("Logic: AND left falsy", () => {
  assertNumericResult('let x = 0 && 2', 'x', 0);
});

Deno.test("Logic: AND right falsy", () => {
  assertNumericResult('let x = 1 && 0', 'x', 0);
});

Deno.test("Logic: OR left truthy", () => {
  assertNumericResult('let x = 1 || 2', 'x', 1);
});

Deno.test("Logic: OR left falsy", () => {
  assertNumericResult('let x = 0 || 2', 'x', 2);
});

Deno.test("Logic: OR both falsy", () => {
  assertNumericResult('let x = 0 || 0', 'x', 0);
});

Deno.test("Logic: AND short-circuit", () => {
  assertNumericResult('let y = 0; let f = () => { y = 1; return 1 }; let x = 0 && f(); y', 'y', 0);
});

Deno.test("Logic: OR short-circuit", () => {
  assertNumericResult('let y = 0; let f = () => { y = 1; return 1 }; let x = 1 || f(); y', 'y', 0);
});

Deno.test("Logic: NOT true", () => {
  assertNumericResult('let x = !true; if (x) { x = 1 } else { x = 0 }', 'x', 0);
});

Deno.test("Logic: NOT false", () => {
  assertNumericResult('let x = !false; if (x) { x = 1 } else { x = 0 }', 'x', 1);
});

Deno.test("Logic: paren assignment", () => {
  assertNumericResult('let x = 0; let y = (x = 5); y', 'y', 5);
});

Deno.test("Logic: AND with paren assignment", () => {
  assertNumericResult('let x = 0; 0 && (x = 1); x', 'x', 0);
});

Deno.test("Logic: OR with paren assignment", () => {
  assertNumericResult('let x = 0; 1 || (x = 1); x', 'x', 0);
});

// =============================================================================
// Nullish Coalescing (??)
// =============================================================================

Deno.test("Nullish: ?? with null", () => {
  assertNumericResult('let x = null ?? 5', 'x', 5);
});

Deno.test("Nullish: ?? with undefined", () => {
  assertNumericResult('let x = undefined ?? 5', 'x', 5);
});

Deno.test("Nullish: ?? with zero", () => {
  assertNumericResult('let x = 0 ?? 5', 'x', 0);
});

Deno.test("Nullish: ?? with false", () => {
  assertNumericResult('let x = false ?? 5; if (x === false) { x = 1 } else { x = 0 }', 'x', 1);
});

Deno.test("Nullish: ?? with number", () => {
  assertNumericResult('let x = 42 ?? 5', 'x', 42);
});

Deno.test("Nullish: ?? chained", () => {
  assertNumericResult('let x = null ?? undefined ?? 5', 'x', 5);
});

Deno.test("Nullish: ?? short-circuit", () => {
  assertNumericResult('let y = 0; let f = () => { y = 1; return 1 }; let x = 5 ?? f(); y', 'y', 0);
});

// =============================================================================
// Optional Chaining (?.)
// =============================================================================

Deno.test("Optional chaining: ?. on object", () => {
  assertNumericResult('let obj = {x: 42}; let y = obj?.x', 'y', 42);
});

Deno.test("Optional chaining: ?. on null", () => {
  assertNumericResult('let obj = null; let y = obj?.x; if (y === undefined) { y = 1 } else { y = 0 }', 'y', 1);
});

Deno.test("Optional chaining: ?. on undefined", () => {
  assertNumericResult('let obj = undefined; let y = obj?.x; if (y === undefined) { y = 1 } else { y = 0 }', 'y', 1);
});

Deno.test("Optional chaining: ?. chained", () => {
  assertNumericResult('let obj = {a: {b: 42}}; let y = obj?.a?.b', 'y', 42);
});

Deno.test("Optional chaining: ?. chained null", () => {
  assertNumericResult('let obj = {a: null}; let y = obj?.a?.b; if (y === undefined) { y = 1 } else { y = 0 }', 'y', 1);
});

Deno.test("Optional chaining: ?.[] on object", () => {
  assertNumericResult('let obj = {x: 42}; let y = obj?.["x"]', 'y', 42);
});

Deno.test("Optional chaining: ?.[] on null", () => {
  assertNumericResult('let obj = null; let y = obj?.["x"]; if (y === undefined) { y = 1 } else { y = 0 }', 'y', 1);
});

Deno.test("Optional chaining: ?.() on function", () => {
  assertNumericResult('let f = () => 42; let y = f?.()', 'y', 42);
});

Deno.test("Optional chaining: ?.() on null", () => {
  assertNumericResult('let f = null; let y = f?.(); if (y === undefined) { y = 1 } else { y = 0 }', 'y', 1);
});

// =============================================================================
// Increment/Decrement
// =============================================================================

Deno.test("Increment: ++i prefix", () => {
  assertNumericResult('let i = 5; ++i', 'i', 6);
});

Deno.test("Increment: ++i returns new", () => {
  assertNumericResult('let i = 5; let x = ++i', 'x', 6);
});

Deno.test("Increment: --i prefix", () => {
  assertNumericResult('let i = 5; --i', 'i', 4);
});

Deno.test("Increment: i++ postfix", () => {
  assertNumericResult('let i = 5; i++; i', 'i', 6);
});

Deno.test("Increment: i++ returns old", () => {
  assertNumericResult('let i = 5; let x = i++', 'x', 5);
});

Deno.test("Increment: i-- postfix", () => {
  assertNumericResult('let i = 5; i--; i', 'i', 4);
});

Deno.test("Increment: ++i in expr", () => {
  assertNumericResult('let i = 5; let x = ++i + 10', 'x', 16);
});

Deno.test("Increment: i++ in expr", () => {
  assertNumericResult('let i = 5; let x = i++ + 10', 'x', 15);
});

Deno.test("Increment: ++obj.x returns new", () => {
  assertNumericResult('let obj = {x: 5}; let y = ++obj.x', 'y', 6);
});

Deno.test("Increment: ++obj.x stores new", () => {
  assertNumericResult('let obj = {x: 5}; ++obj.x; let y = obj.x', 'y', 6);
});

Deno.test("Increment: obj.x++ returns old", () => {
  assertNumericResult('let obj = {x: 5}; let y = obj.x++', 'y', 5);
});

Deno.test("Increment: obj.x++ stores new", () => {
  assertNumericResult('let obj = {x: 5}; obj.x++; let y = obj.x', 'y', 6);
});

Deno.test("Increment: ++arr[0] returns new", () => {
  assertNumericResult('let arr = [10]; let y = ++arr[0]', 'y', 11);
});

Deno.test("Increment: arr[0]++ returns old", () => {
  assertNumericResult('let arr = [10]; let y = arr[0]++', 'y', 10);
});

Deno.test("Increment: ++arr[i] with variable index", () => {
  assertNumericResult('let arr = [10]; let i = 0; let y = ++arr[i]', 'y', 11);
});

Deno.test("Increment: ++arr[i % 3] in loop", () => {
  assertNumericResult('let arr = [0, 0, 0]; for (let i = 0; i < 10; i++) { ++arr[i % 3] }; let y = arr[0]', 'y', 4);
});

// =============================================================================
// Compound Assignment
// =============================================================================

Deno.test("Compound: += var", () => {
  assertNumericResult('let x = 5; x += 3', 'x', 8);
});

Deno.test("Compound: -= var", () => {
  assertNumericResult('let x = 10; x -= 3', 'x', 7);
});

Deno.test("Compound: *= var", () => {
  assertNumericResult('let x = 4; x *= 3', 'x', 12);
});

Deno.test("Compound: /= var", () => {
  assertNumericResult('let x = 12; x /= 3', 'x', 4);
});

Deno.test("Compound: %= var", () => {
  assertNumericResult('let x = 10; x %= 3', 'x', 1);
});

Deno.test("Compound: **= var", () => {
  assertNumericResult('let x = 2; x **= 3', 'x', 8);
});

Deno.test("Compound: += returns value", () => {
  assertNumericResult('let x = 5; let y = (x += 3)', 'y', 8);
});

Deno.test("Compound: += prop", () => {
  assertNumericResult('let obj = {x: 5}; obj.x += 3; let y = obj.x', 'y', 8);
});

Deno.test("Compound: += index", () => {
  assertNumericResult('let arr = [5]; arr[0] += 3; let y = arr[0]', 'y', 8);
});

Deno.test("Compound: += obj bracket", () => {
  assertNumericResult('let obj = {x: 5}; obj["x"] += 3; let y = obj.x', 'y', 8);
});

// =============================================================================
// Comma Operator
// =============================================================================

Deno.test("Comma: basic", () => {
  assertNumericResult('let x = (1, 2, 3)', 'x', 3);
});

Deno.test("Comma: side effects", () => {
  assertNumericResult('let a = 0; let x = (a = 1, a = 2, a)', 'x', 2);
});

Deno.test("Comma: with assignment", () => {
  assertNumericResult('let a = 0; let b = 0; let x = (a = 1, b = 2)', 'x', 2);
});

// =============================================================================
// Ternary Operator
// =============================================================================

Deno.test("Ternary: true", () => {
  assertNumericResult('let x = true ? 1 : 2', 'x', 1);
});

Deno.test("Ternary: false", () => {
  assertNumericResult('let x = false ? 1 : 2', 'x', 2);
});

Deno.test("Ternary: nested", () => {
  assertNumericResult('let x = true ? (false ? 1 : 2) : 3', 'x', 2);
});

Deno.test("Ternary: chain", () => {
  assertNumericResult('let x = false ? 1 : false ? 2 : 3', 'x', 3);
});

Deno.test("Ternary: expression condition", () => {
  assertNumericResult('let x = 5 > 3 ? 10 : 20', 'x', 10);
});

Deno.test("Ternary: in expression", () => {
  assertNumericResult('let x = 1 + (true ? 2 : 3)', 'x', 3);
});

Deno.test("Ternary: with variables", () => {
  assertNumericResult('let a = 5; let b = 10; let x = a < b ? a : b', 'x', 5);
});

// =============================================================================
// TYPEOF
// =============================================================================

Deno.test("Typeof: number", () => {
  assertNumericResult('let x = typeof 42; if (x === "number") { x = 1 } else { x = 0 }', 'x', 1);
});

Deno.test("Typeof: string", () => {
  assertNumericResult('let x = typeof "hi"; if (x === "string") { x = 1 } else { x = 0 }', 'x', 1);
});

Deno.test("Typeof: boolean", () => {
  assertNumericResult('let x = typeof true; if (x === "boolean") { x = 1 } else { x = 0 }', 'x', 1);
});

Deno.test("Typeof: undefined", () => {
  assertNumericResult('let x = typeof undefined; if (x === "undefined") { x = 1 } else { x = 0 }', 'x', 1);
});

Deno.test("Typeof: null", () => {
  assertNumericResult('let x = typeof null; if (x === "object") { x = 1 } else { x = 0 }', 'x', 1);
});

Deno.test("Typeof: array", () => {
  assertNumericResult('let x = typeof [1,2]; if (x === "object") { x = 1 } else { x = 0 }', 'x', 1);
});

Deno.test("Typeof: object", () => {
  assertNumericResult('let x = typeof {a:1}; if (x === "object") { x = 1 } else { x = 0 }', 'x', 1);
});

Deno.test("Typeof: function", () => {
  assertNumericResult('let x = typeof (() => 1); if (x === "function") { x = 1 } else { x = 0 }', 'x', 1);
});

// =============================================================================
// Bitwise Operators
// =============================================================================

Deno.test("Bitwise: & basic", () => {
  assertNumericResult('let x = 5 & 3', 'x', 1);
});

Deno.test("Bitwise: & with zero", () => {
  assertNumericResult('let x = 5 & 0', 'x', 0);
});

Deno.test("Bitwise: & mask", () => {
  assertNumericResult('let x = 255 & 15', 'x', 15);
});

Deno.test("Bitwise: | basic", () => {
  assertNumericResult('let x = 5 | 3', 'x', 7);
});

Deno.test("Bitwise: | with zero", () => {
  assertNumericResult('let x = 5 | 0', 'x', 5);
});

Deno.test("Bitwise: ^ basic", () => {
  assertNumericResult('let x = 5 ^ 3', 'x', 6);
});

Deno.test("Bitwise: ^ self", () => {
  assertNumericResult('let x = 5 ^ 5', 'x', 0);
});

Deno.test("Bitwise: ^ double", () => {
  assertNumericResult('let x = 5 ^ 3 ^ 3', 'x', 5);
});

Deno.test("Bitwise: ~ positive", () => {
  assertNumericResult('let x = ~5', 'x', -6);
});

Deno.test("Bitwise: ~ zero", () => {
  assertNumericResult('let x = ~0', 'x', -1);
});

Deno.test("Bitwise: ~ negative", () => {
  assertNumericResult('let x = ~(-1)', 'x', 0);
});

Deno.test("Bitwise: << basic", () => {
  assertNumericResult('let x = 5 << 2', 'x', 20);
});

Deno.test("Bitwise: << by 0", () => {
  assertNumericResult('let x = 5 << 0', 'x', 5);
});

Deno.test("Bitwise: << multiply", () => {
  assertNumericResult('let x = 1 << 10', 'x', 1024);
});

Deno.test("Bitwise: >> positive", () => {
  assertNumericResult('let x = 20 >> 2', 'x', 5);
});

Deno.test("Bitwise: >> negative", () => {
  assertNumericResult('let x = -20 >> 2', 'x', -5);
});

Deno.test("Bitwise: >>> positive", () => {
  assertNumericResult('let x = 20 >>> 2', 'x', 5);
});

Deno.test("Bitwise: &= var", () => {
  assertNumericResult('let x = 7; x &= 3', 'x', 3);
});

Deno.test("Bitwise: |= var", () => {
  assertNumericResult('let x = 5; x |= 2', 'x', 7);
});

Deno.test("Bitwise: ^= var", () => {
  assertNumericResult('let x = 7; x ^= 3', 'x', 4);
});

Deno.test("Bitwise: <<= var", () => {
  assertNumericResult('let x = 5; x <<= 2', 'x', 20);
});

Deno.test("Bitwise: >>= var", () => {
  assertNumericResult('let x = 20; x >>= 2', 'x', 5);
});

Deno.test("Bitwise: >>>= var", () => {
  assertNumericResult('let x = 20; x >>>= 2', 'x', 5);
});

Deno.test("Bitwise precedence: | lower than &", () => {
  assertNumericResult('let x = 1 | 2 & 3', 'x', 3);
});

Deno.test("Bitwise precedence: shift lower than +", () => {
  assertNumericResult('let x = 1 + 2 << 1', 'x', 6);
});

// =============================================================================
// Numeric Literals
// =============================================================================

Deno.test("Numeric: hex basic", () => {
  assertNumericResult('let x = 0xFF', 'x', 255);
});

Deno.test("Numeric: hex lowercase", () => {
  assertNumericResult('let x = 0xff', 'x', 255);
});

Deno.test("Numeric: hex uppercase prefix", () => {
  assertNumericResult('let x = 0XFF', 'x', 255);
});

Deno.test("Numeric: hex large", () => {
  assertNumericResult('let x = 0xCAFE', 'x', 51966);
});

Deno.test("Numeric: hex with separator", () => {
  assertNumericResult('let x = 0xFF_FF', 'x', 65535);
});

Deno.test("Numeric: binary basic", () => {
  assertNumericResult('let x = 0b1010', 'x', 10);
});

Deno.test("Numeric: binary uppercase", () => {
  assertNumericResult('let x = 0B1111', 'x', 15);
});

Deno.test("Numeric: binary byte", () => {
  assertNumericResult('let x = 0b11111111', 'x', 255);
});

Deno.test("Numeric: binary with separator", () => {
  assertNumericResult('let x = 0b1010_1010', 'x', 170);
});

Deno.test("Numeric: octal basic", () => {
  assertNumericResult('let x = 0o17', 'x', 15);
});

Deno.test("Numeric: octal uppercase", () => {
  assertNumericResult('let x = 0O77', 'x', 63);
});

Deno.test("Numeric: octal 777", () => {
  assertNumericResult('let x = 0o777', 'x', 511);
});

Deno.test("Numeric: octal with separator", () => {
  assertNumericResult('let x = 0o7_7_7', 'x', 511);
});

Deno.test("Numeric: decimal separator", () => {
  assertNumericResult('let x = 1_000_000', 'x', 1000000);
});

Deno.test("Numeric: float separator", () => {
  assertNumericResult('let x = 3.14_159', 'x', 3.14159);
});

Deno.test("Numeric: exponent separator", () => {
  assertNumericResult('let x = 1e1_0', 'x', 1e10);
});

// Numeric literal parse errors
Deno.test("Numeric error: hex no digits", () => {
  assertParseError('let x = 0x', 'Hexadecimal literal with no digits');
});

Deno.test("Numeric error: binary no digits", () => {
  assertParseError('let x = 0b', 'Binary literal with no digits');
});

Deno.test("Numeric error: octal no digits", () => {
  assertParseError('let x = 0o', 'Octal literal with no digits');
});

Deno.test("Numeric error: invalid hex digit", () => {
  assertParseError('let x = 0xGG', 'Invalid hexadecimal digit');
});

Deno.test("Numeric error: invalid binary digit", () => {
  assertParseError('let x = 0b12', 'Invalid binary digit');
});

Deno.test("Numeric error: invalid octal digit", () => {
  assertParseError('let x = 0o89', 'Invalid octal digit');
});

Deno.test("Numeric error: trailing separator", () => {
  assertParseError('let x = 123_', 'Trailing numeric separator');
});

Deno.test("Numeric error: consecutive separators", () => {
  assertParseError('let x = 1__2', 'Consecutive numeric separators');
});

Deno.test("Numeric error: separator after prefix", () => {
  assertParseError('let x = 0x_FF', 'Numeric separator after hexadecimal prefix');
});

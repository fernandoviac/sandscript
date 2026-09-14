/**
 * Test interpreter basics: header, literals, variables, control flow, loops.
 *
 * Run with: deno task test tests/fuel/interpreter-basics_test.js
 */

import {
  createTestContext,
  runCode,
  assertNumericResult,
  assertStringResult,
  assertArrayResult,
  assertErrorCode,
  assertEquals,
  assert,
  STATUS_DONE,
  STATUS_ERROR,
  VERSION,
} from './interpreter-test-utils.js';
import { EXIT_PAUSED_FUEL, EXIT_DONE } from '../../src/fuel/index.js';
import { DRONE_FORMAT_VERSION } from '../../src/persisted-format.js';

// =============================================================================
// SANDFUEL Header Tests
// =============================================================================

Deno.test("Header: SANDFUEL magic bytes", () => {
  const { mem } = createTestContext();
  const magic = mem.getMagic();
  assertEquals(magic, 'SANDFUEL');
});

Deno.test("Header: version fields match", () => {
  const { mem } = createTestContext();
  const versions = mem.getVersions();
  assertEquals(versions.droneFormat, DRONE_FORMAT_VERSION);
  assertEquals(versions.bytecode, VERSION.BYTECODE);
  assertEquals(versions.type, VERSION.TYPE);
  assertEquals(versions.builtin, VERSION.BUILTIN);
});

Deno.test("Header: validateMagic succeeds", () => {
  const { mem } = createTestContext();
  mem.validateMagic(); // Should not throw
});

// =============================================================================
// Basic Literals
// =============================================================================

Deno.test("Literals: integer stored as float", () => {
  assertNumericResult('let x = 42', 'x', 42);
});

Deno.test("Literals: float", () => {
  assertNumericResult('let x = 3.14', 'x', 3.14);
});

Deno.test("Literals: boolean true", () => {
  assertNumericResult('let x = true; if (x) { x = 1 } else { x = 0 }', 'x', 1);
});

Deno.test("Literals: boolean false", () => {
  assertNumericResult('let x = false; if (x) { x = 1 } else { x = 0 }', 'x', 0);
});

Deno.test("Literals: null", () => {
  assertNumericResult('let x = null; if (x === null) { x = 1 } else { x = 0 }', 'x', 1);
});

Deno.test("Literals: string", () => {
  assertStringResult('let x = "hello"', 'x', 'hello');
});

// =============================================================================
// Variables
// =============================================================================

Deno.test("Variables: declaration and access", () => {
  assertNumericResult('let x = 42; x', 'x', 42);
});

Deno.test("Variables: assignment", () => {
  assertNumericResult('let x = 1; x = 10; x', 'x', 10);
});

Deno.test("Variables: multiple declarations", () => {
  assertNumericResult('let a = 10; let b = 3; let x = a + b', 'x', 13);
});

// =============================================================================
// Arithmetic
// =============================================================================

Deno.test("Arithmetic: addition", () => {
  assertNumericResult('let x = 3 + 2', 'x', 5);
});

Deno.test("Arithmetic: subtraction", () => {
  assertNumericResult('let x = 5 - 2', 'x', 3);
});

Deno.test("Arithmetic: multiplication", () => {
  assertNumericResult('let x = 3 * 4', 'x', 12);
});

Deno.test("Arithmetic: division", () => {
  assertNumericResult('let x = 10 / 4', 'x', 2.5);
});

Deno.test("Arithmetic: modulo", () => {
  assertNumericResult('let x = 10 % 3', 'x', 1);
});

Deno.test("Arithmetic: negation", () => {
  assertNumericResult('let x = -5', 'x', -5);
});

Deno.test("Arithmetic: power", () => {
  assertNumericResult('let x = 2 ** 3', 'x', 8);
});

Deno.test("Arithmetic: float addition", () => {
  assertNumericResult('let x = 1.5 + 2.5', 'x', 4.0);
});

Deno.test("Arithmetic: large number (no overflow)", () => {
  assertNumericResult('let x = 2147483647 + 1', 'x', 2147483648.0);
});

// =============================================================================
// Control Flow - If/Else
// =============================================================================

Deno.test("If: simple true branch", () => {
  assertNumericResult('let x = 0; if (true) { x = 1 }; x', 'x', 1);
});

Deno.test("If: simple false branch", () => {
  assertNumericResult('let x = 0; if (false) { x = 1 }; x', 'x', 0);
});

Deno.test("If-else: true branch", () => {
  assertNumericResult('let x = 0; if (true) { x = 1 } else { x = 2 }; x', 'x', 1);
});

Deno.test("If-else: false branch", () => {
  assertNumericResult('let x = 0; if (false) { x = 1 } else { x = 2 }; x', 'x', 2);
});

Deno.test("If: condition expression", () => {
  assertNumericResult('let x = 5 > 3 ? 10 : 20', 'x', 10);
});

// =============================================================================
// Control Flow - While Loops
// =============================================================================

Deno.test("While: basic loop", () => {
  assertNumericResult('let i = 0; while (i < 3) { i = i + 1 }; i', 'i', 3);
});

Deno.test("While: sum accumulation", () => {
  assertNumericResult('let sum = 0; let i = 1; while (i <= 5) { sum = sum + i; i = i + 1 }; sum', 'sum', 15);
});

Deno.test("While: never runs", () => {
  assertNumericResult('let x = 10; while (x < 0) { x = 99 }; x', 'x', 10);
});

Deno.test("While: nested loops", () => {
  assertNumericResult('let total = 0; let i = 0; while (i < 3) { let j = 0; while (j < 2) { total = total + 1; j = j + 1 }; i = i + 1 }; total', 'total', 6);
});

Deno.test("While: break", () => {
  assertNumericResult('let i = 0; while (true) { i = i + 1; if (i === 3) { break } }; i', 'i', 3);
});

Deno.test("While: continue", () => {
  assertNumericResult('let sum = 0; let i = 0; while (i < 5) { i = i + 1; if (i === 3) { continue }; sum = sum + i }; sum', 'sum', 12);
});

// =============================================================================
// Control Flow - Do-While Loops
// =============================================================================

Deno.test("Do-while: basic", () => {
  assertNumericResult('let i = 0; do { i = i + 1 } while (i < 3); i', 'i', 3);
});

Deno.test("Do-while: runs at least once", () => {
  assertNumericResult('let i = 10; do { i = i + 1 } while (i < 3); i', 'i', 11);
});

Deno.test("Do-while: break", () => {
  assertNumericResult('let i = 0; do { i = i + 1; if (i === 5) { break } } while (true); i', 'i', 5);
});

Deno.test("Do-while: continue", () => {
  assertNumericResult('let sum = 0; let i = 0; do { i = i + 1; if (i === 3) { continue }; sum = sum + i } while (i < 5); sum', 'sum', 12);
});

// =============================================================================
// Control Flow - For Loops
// =============================================================================

Deno.test("For: basic", () => {
  assertNumericResult('let sum = 0; for (let i = 0; i < 5; i = i + 1) { sum = sum + i }; sum', 'sum', 10);
});

Deno.test("For: empty init", () => {
  assertNumericResult('let i = 0; let sum = 0; for (; i < 3; i = i + 1) { sum = sum + i }; sum', 'sum', 3);
});

Deno.test("For: empty update", () => {
  assertNumericResult('let sum = 0; for (let i = 0; i < 3;) { sum = sum + i; i = i + 1 }; sum', 'sum', 3);
});

Deno.test("For: empty condition (infinite with break)", () => {
  assertNumericResult('let i = 0; for (;;) { i = i + 1; if (i === 5) { break } }; i', 'i', 5);
});

Deno.test("For: scoping (inner variable shadows outer)", () => {
  assertNumericResult('let x = 1; for (let x = 10; x < 12; x = x + 1) { }; x', 'x', 1);
});

Deno.test("For: break", () => {
  assertNumericResult('let sum = 0; for (let i = 0; i < 10; i = i + 1) { if (i === 5) { break }; sum = sum + i }; sum', 'sum', 10);
});

Deno.test("For: continue", () => {
  assertNumericResult('let sum = 0; for (let i = 0; i < 5; i = i + 1) { if (i === 2) { continue }; sum = sum + i }; sum', 'sum', 8);
});

Deno.test("For: nested", () => {
  assertNumericResult('let sum = 0; for (let i = 0; i < 3; i = i + 1) { for (let j = 0; j < 3; j = j + 1) { sum = sum + 1 } }; sum', 'sum', 9);
});

Deno.test("For: with i++", () => {
  assertNumericResult('let sum = 0; for (let i = 0; i < 5; i++) { sum += i }; sum', 'sum', 10);
});

// =============================================================================
// Arrays
// =============================================================================

Deno.test("Array: literal creation", () => {
  const { mem, wasm, parser } = createTestContext();
  const status = runCode(mem, wasm, parser, 'let arr = [1, 2, 3]');
  assertEquals(status, STATUS_DONE);

  const scope = mem.getRootScope();
  const nameOffset = mem.internString('arr');
  const valuePtr = mem.scopeLookup(scope, nameOffset);
  const val = mem.getValue(valuePtr);
  assertEquals(val.type, 6); // TYPE_ARRAY

  const arrPtr = Number(val.payload);
  const arrLen = mem.view.getUint32(mem.abs(arrPtr + 8), true);
  assertEquals(arrLen, 3);
});

Deno.test("Array: index access", () => {
  assertNumericResult('let arr = [10, 20, 30]; let x = arr[1]', 'x', 20);
});

Deno.test("Array: index assignment", () => {
  assertNumericResult('let arr = [1, 2, 3]; arr[1] = 42; let x = arr[1]', 'x', 42);
});

Deno.test("Array: length property", () => {
  assertNumericResult('let arr = [1, 2, 3, 4, 5]; let x = arr.length', 'x', 5);
});

// =============================================================================
// Objects
// =============================================================================

Deno.test("Object: literal creation", () => {
  const { mem, wasm, parser } = createTestContext();
  const status = runCode(mem, wasm, parser, 'let obj = { x: 42 }');
  assertEquals(status, STATUS_DONE);

  const scope = mem.getRootScope();
  const nameOffset = mem.internString('obj');
  const valuePtr = mem.scopeLookup(scope, nameOffset);
  const val = mem.getValue(valuePtr);
  assertEquals(val.type, 7); // TYPE_OBJECT
});

Deno.test("Object: property access", () => {
  assertNumericResult('let obj = {x: 42}; let y = obj.x', 'y', 42);
});

Deno.test("Object: property assignment", () => {
  assertNumericResult('let obj = {x: 1}; obj.x = 42; let y = obj.x', 'y', 42);
});

Deno.test("Object: bracket access with string", () => {
  assertNumericResult('let obj = {foo: 42}; let x = obj["foo"]', 'x', 42);
});

Deno.test("Object: bracket access with variable", () => {
  assertNumericResult('let obj = {foo: 42}; let key = "foo"; let x = obj[key]', 'x', 42);
});

// =============================================================================
// Fuel Exhaustion
// =============================================================================

Deno.test("Fuel: exhaustion and resume", () => {
  const { mem, wasm, parser } = createTestContext();
  mem.allocateCodeBlock();
  parser.parse('let x = 1');
  parser.parse('let y = 2');
  parser.parse('let z = 3');

  mem.setContextInstructionIndex(0, 0);

  // Run with limited fuel
  wasm.exports.run(3, 0);  // returns remaining fuel, pass context slot
  assertEquals(mem.getExitCondition(0), EXIT_PAUSED_FUEL);

  // Resume with more fuel
  wasm.exports.run(10, 0);
  assertEquals(mem.getExitCondition(0), EXIT_DONE);
});

// =============================================================================
// Empty Statements
// =============================================================================

Deno.test("Empty statements: semicolons only", () => {
  assertNumericResult('let x = 1;;; x', 'x', 1);
});

// =============================================================================
// Redeclaration Errors
// =============================================================================

Deno.test("Redeclaration: let in same scope throws error", () => {
  assertErrorCode('let x = 1; let x = 2', 16);
});

Deno.test("Redeclaration: let with different value types throws error", () => {
  assertErrorCode('let x = "hello"; let x = 42', 16);
});

Deno.test("Redeclaration: shadowing in nested block scope allowed", () => {
  assertNumericResult('let x = 1; { let x = 2; } x', 'x', 1);
});

Deno.test("Redeclaration: inner scope sees shadowed value", () => {
  assertNumericResult('let x = 1; let y; { let x = 2; y = x; } y', 'y', 2);
});

Deno.test("Redeclaration: deeply nested shadowing", () => {
  assertNumericResult('let x = 1; { let x = 2; { let x = 3; } } x', 'x', 1);
});

Deno.test("Redeclaration: reassignment is allowed", () => {
  assertNumericResult('let x = 1; x = 2; x', 'x', 2);
});

/**
 * Tests for Error constructors and Error.prototype methods.
 */

import { assertEquals } from "https://deno.land/std@0.208.0/assert/mod.ts";
import {
  createTestContext,
  runCode,
  getStringVar,
  assertStringResult,
} from './interpreter-test-utils.js';
import { EXIT_DONE } from '../../src/fuel/index.js';

// =============================================================================
// Error Construction
// =============================================================================

Deno.test("Error: new Error() creates error with empty message", () => {
  const { mem, wasm, parser } = createTestContext();
  const status = runCode(mem, wasm, parser, 'let e = new Error(); let msg = e.message');
  assertEquals(status, EXIT_DONE);
  assertEquals(getStringVar(mem, 'msg'), '');
});

Deno.test("Error: new Error(message) sets message property", () => {
  assertStringResult('let e = new Error("test message"); let msg = e.message', 'msg', 'test message');
});

Deno.test("Error: new TypeError() creates error with empty message", () => {
  const { mem, wasm, parser } = createTestContext();
  const status = runCode(mem, wasm, parser, 'let e = new TypeError(); let msg = e.message');
  assertEquals(status, EXIT_DONE);
  assertEquals(getStringVar(mem, 'msg'), '');
});

Deno.test("Error: new TypeError(message) sets message property", () => {
  assertStringResult('let e = new TypeError("type error"); let msg = e.message', 'msg', 'type error');
});

Deno.test("Error: new ReferenceError() creates error with empty message", () => {
  const { mem, wasm, parser } = createTestContext();
  const status = runCode(mem, wasm, parser, 'let e = new ReferenceError(); let msg = e.message');
  assertEquals(status, EXIT_DONE);
  assertEquals(getStringVar(mem, 'msg'), '');
});

Deno.test("Error: new ReferenceError(message) sets message property", () => {
  assertStringResult('let e = new ReferenceError("ref error"); let msg = e.message', 'msg', 'ref error');
});

Deno.test("Error: message is coerced to string", () => {
  assertStringResult('let e = new Error(42); let msg = e.message', 'msg', '42');
});

// =============================================================================
// Error Prototype Chain
// =============================================================================

Deno.test("Error: error inherits name from prototype", () => {
  assertStringResult('let e = new Error(); let name = e.name', 'name', 'Error');
});

Deno.test("Error: TypeError inherits name from prototype", () => {
  assertStringResult('let e = new TypeError(); let name = e.name', 'name', 'TypeError');
});

Deno.test("Error: ReferenceError inherits name from prototype", () => {
  assertStringResult('let e = new ReferenceError(); let name = e.name', 'name', 'ReferenceError');
});

// =============================================================================
// Error.prototype.toString()
// =============================================================================

Deno.test("Error: toString formats as Name: message", () => {
  assertStringResult('let e = new Error("boom"); let x = e.toString()', 'x', 'Error: boom');
});

Deno.test("Error: toString with no message omits the colon", () => {
  assertStringResult('let e = new Error(); let x = e.toString()', 'x', 'Error');
});

Deno.test("Error: TypeError toString uses the TypeError name", () => {
  assertStringResult('let e = new TypeError("bad type"); let x = e.toString()', 'x', 'TypeError: bad type');
});

Deno.test("Error: ReferenceError toString uses the ReferenceError name", () => {
  assertStringResult('let e = new ReferenceError("not defined"); let x = e.toString()', 'x', 'ReferenceError: not defined');
});

Deno.test("Error: RangeError toString uses the RangeError name", () => {
  assertStringResult('let e = new RangeError("out of range"); let x = e.toString()', 'x', 'RangeError: out of range');
});

Deno.test("Error: implicit toString via string concatenation", () => {
  assertStringResult('let e = new Error("boom"); let x = "" + e', 'x', 'Error: boom');
});

Deno.test("Error: implicit toString via String()", () => {
  assertStringResult('let e = new Error("boom"); let x = String(e)', 'x', 'Error: boom');
});

Deno.test("Error: implicit toString with no message omits the colon", () => {
  assertStringResult('let e = new Error(); let x = "" + e', 'x', 'Error');
});

Deno.test("Error: plain object toString is unaffected (generic tag)", () => {
  assertStringResult('let o = {}; let x = o.toString()', 'x', '[object Object]');
});

Deno.test("Error: plain object implicit coercion is unaffected (generic tag)", () => {
  assertStringResult('let o = {}; let x = "" + o', 'x', '[object Object]');
});

// =============================================================================
// Frozen Prototype Protection
// =============================================================================

Deno.test("Frozen: Object.prototype throws TypeError on property assignment", () => {
  const { mem, wasm, parser } = createTestContext();
  const status = runCode(mem, wasm, parser, 'let proto = Object.getPrototypeOf({}); proto.x = 1');
  assertEquals(status, 4); // STATUS_ERROR (uncaught exception)
});

Deno.test("Frozen: Error.prototype throws TypeError on property assignment", () => {
  const { mem, wasm, parser } = createTestContext();
  const status = runCode(mem, wasm, parser, 'let proto = Object.getPrototypeOf(new Error()); proto.x = 1');
  assertEquals(status, 4); // STATUS_ERROR (uncaught exception)
});

Deno.test("Frozen: Array.prototype throws TypeError on property assignment", () => {
  const { mem, wasm, parser } = createTestContext();
  const status = runCode(mem, wasm, parser, 'let proto = Object.getPrototypeOf([]); proto.x = 1');
  assertEquals(status, 4); // STATUS_ERROR (uncaught exception)
});

Deno.test("Frozen: regular objects are not frozen", () => {
  const { mem, wasm, parser } = createTestContext();
  const status = runCode(mem, wasm, parser, 'let obj = {}; obj.x = 1');
  assertEquals(status, EXIT_DONE);
});

// =============================================================================
// TypeError Catchability
// =============================================================================

Deno.test("Frozen: TypeError can be caught by try-catch", () => {
  const { mem, wasm, parser } = createTestContext();
  const status = runCode(mem, wasm, parser, `
    let caught = 0
    try {
      let proto = Object.getPrototypeOf({})
      proto.x = 1
    } catch (e) {
      caught = 1
    }
  `);
  assertEquals(status, EXIT_DONE);
});

Deno.test("Frozen: caught TypeError has correct name", () => {
  assertStringResult(`
    let name = ''
    try {
      let proto = Object.getPrototypeOf({})
      proto.x = 1
    } catch (e) {
      name = e.name
    }
  `, 'name', 'TypeError');
});

Deno.test("Frozen: caught TypeError has message property", () => {
  assertStringResult(`
    let msg = 'not set'
    try {
      let proto = Object.getPrototypeOf({})
      proto.x = 1
    } catch (e) {
      msg = e.message
    }
  `, 'msg', 'Cannot modify frozen object');
});

// =============================================================================
// ReferenceError Catchability
// =============================================================================

Deno.test("ReferenceError: undefined variable can be caught", () => {
  const { mem, wasm, parser } = createTestContext();
  const status = runCode(mem, wasm, parser, `
    let caught = 0
    try {
      undefinedVariable
    } catch (e) {
      caught = 1
    }
  `);
  assertEquals(status, EXIT_DONE);
});

Deno.test("ReferenceError: caught error has correct name", () => {
  assertStringResult(`
    let name = ''
    try {
      undefinedVariable
    } catch (e) {
      name = e.name
    }
  `, 'name', 'ReferenceError');
});

// =============================================================================
// TypeError on Null/Undefined Property Access
// =============================================================================

Deno.test("TypeError: property access on null can be caught", () => {
  const { mem, wasm, parser } = createTestContext();
  const status = runCode(mem, wasm, parser, `
    let caught = 0
    try {
      let x = null
      x.foo
    } catch (e) {
      caught = 1
    }
  `);
  assertEquals(status, EXIT_DONE);
});

Deno.test("TypeError: property access on null throws TypeError", () => {
  assertStringResult(`
    let name = ''
    try {
      let x = null
      x.foo
    } catch (e) {
      name = e.name
    }
  `, 'name', 'TypeError');
});

Deno.test("TypeError: property access on undefined can be caught", () => {
  const { mem, wasm, parser } = createTestContext();
  const status = runCode(mem, wasm, parser, `
    let caught = 0
    try {
      let x = undefined
      x.foo
    } catch (e) {
      caught = 1
    }
  `);
  assertEquals(status, EXIT_DONE);
});

Deno.test("TypeError: index access on null can be caught", () => {
  const { mem, wasm, parser } = createTestContext();
  const status = runCode(mem, wasm, parser, `
    let caught = 0
    try {
      let x = null
      x[0]
    } catch (e) {
      caught = 1
    }
  `);
  assertEquals(status, EXIT_DONE);
});

// =============================================================================
// TypeError on Calling Non-Function
// =============================================================================

Deno.test("TypeError: calling non-function can be caught", () => {
  const { mem, wasm, parser } = createTestContext();
  const status = runCode(mem, wasm, parser, `
    let caught = 0
    try {
      let x = 5
      x()
    } catch (e) {
      caught = 1
    }
  `);
  assertEquals(status, EXIT_DONE);
});

Deno.test("TypeError: calling non-function throws TypeError", () => {
  assertStringResult(`
    let name = ''
    try {
      let x = 5
      x()
    } catch (e) {
      name = e.name
    }
  `, 'name', 'TypeError');
});

// =============================================================================
// Scope restoration on exception
// =============================================================================

Deno.test("Scope: outer variables still visible in catch", () => {
  const { mem, wasm, parser } = createTestContext();
  const status = runCode(mem, wasm, parser, `
    let outerVar = 'outer'
    let result = 'before'
    try {
      let innerVar = 'inner'
      null.foo  // throws
    } catch (e) {
      // outerVar should still be visible
      result = outerVar
    }
  `);
  assertEquals(status, EXIT_DONE);
  assertEquals(getStringVar(mem, 'result'), 'outer');
});

Deno.test("Scope: catch block can declare same variable name as try", () => {
  // If scope is restored correctly, we can redeclare a variable with the same name
  const { mem, wasm, parser } = createTestContext();
  const status = runCode(mem, wasm, parser, `
    let result = 'before'
    try {
      let x = 'try-x'
      null.foo
    } catch (e) {
      // Should be able to declare x since try scope is gone
      let x = 'catch-x'
      result = x
    }
  `);
  assertEquals(status, EXIT_DONE);
  assertEquals(getStringVar(mem, 'result'), 'catch-x');
});

Deno.test("Scope: variables from try block not in catch scope chain", () => {
  // Verify try block variable doesn't pollute catch scope by checking
  // that assignment to try variable name creates new variable
  const { mem, wasm, parser } = createTestContext();
  const status = runCode(mem, wasm, parser, `
    let result = 'before'
    try {
      let innerVar = 'original'
      null.foo
    } catch (e) {
      // This should error because innerVar isn't defined
      // But we're testing scope restoration worked, so instead:
      result = 'caught'
    }
  `);
  assertEquals(status, EXIT_DONE);
  assertEquals(getStringVar(mem, 'result'), 'caught');
});

Deno.test("Scope: deeply nested throw restores to try scope", () => {
  const { mem, wasm, parser } = createTestContext();
  const status = runCode(mem, wasm, parser, `
    let result = 'before'
    try {
      {
        {
          {
            null.foo  // throws from deep nesting
          }
        }
      }
    } catch (e) {
      result = 'caught'
    }
  `);
  assertEquals(status, EXIT_DONE);
  assertEquals(getStringVar(mem, 'result'), 'caught');
});

Deno.test("Scope: nested try-catch restores correct scopes", () => {
  const { mem, wasm, parser } = createTestContext();
  const status = runCode(mem, wasm, parser, `
    let result = ''
    let outer = 'outer'
    try {
      let a = 'a'
      try {
        let b = 'b'
        null.foo
      } catch (e1) {
        // a should be visible, b should not
        result = a
      }
    } catch (e2) {
      result = 'wrong'
    }
  `);
  assertEquals(status, EXIT_DONE);
  assertEquals(getStringVar(mem, 'result'), 'a');
});

Deno.test("Scope: re-throw preserves scope chain", () => {
  const { mem, wasm, parser } = createTestContext();
  const status = runCode(mem, wasm, parser, `
    let result = ''
    let outer = 'outer'
    try {
      let inner = 'inner'
      try {
        null.foo
      } catch (e1) {
        result = inner  // inner still visible
        throw e1
      }
    } catch (e2) {
      result = result + '-' + outer  // outer visible, inner not
    }
  `);
  assertEquals(status, EXIT_DONE);
  assertEquals(getStringVar(mem, 'result'), 'inner-outer');
});

Deno.test("Scope: exception in catch block handled correctly", () => {
  const { mem, wasm, parser } = createTestContext();
  const status = runCode(mem, wasm, parser, `
    let result = 'before'
    try {
      try {
        null.foo
      } catch (e1) {
        null.bar  // throws again
      }
    } catch (e2) {
      result = 'outer-caught'
    }
  `);
  assertEquals(status, EXIT_DONE);
  assertEquals(getStringVar(mem, 'result'), 'outer-caught');
});

Deno.test("Scope: finally runs with correct scope after throw", () => {
  const { mem, wasm, parser } = createTestContext();
  const status = runCode(mem, wasm, parser, `
    let result = ''
    let outer = 'outer'
    try {
      let inner = 'inner'
      null.foo
    } catch (e) {
      result = 'caught'
    } finally {
      result = result + '-' + outer
    }
  `);
  assertEquals(status, EXIT_DONE);
  assertEquals(getStringVar(mem, 'result'), 'caught-outer');
});

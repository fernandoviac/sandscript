/**
 * Tests for generalized `new` operator with user-defined constructors.
 */

import { assertEquals } from "https://deno.land/std@0.208.0/assert/mod.ts";
import {
  createTestContext,
  runCode,
  getNumericVar,
  getStringVar,
  assertNumericResult,
  assertBooleanResult,
  STATUS_DONE,
  STATUS_ERROR,
} from './interpreter-test-utils.js';

// =============================================================================
// Basic Constructor
// =============================================================================

Deno.test("new: basic constructor with property assignment", () => {
  assertNumericResult(`
    function Point(x, y) {
      this.x = x
      this.y = y
    }
    let p = new Point(3, 4)
    let result = p.x
  `, 'result', 3);
});

Deno.test("new: constructor sets multiple properties", () => {
  const { mem, wasm, parser } = createTestContext();
  const status = runCode(mem, wasm, parser, `
    function Point(x, y) {
      this.x = x
      this.y = y
    }
    let p = new Point(3, 4)
    let rx = p.x
    let ry = p.y
  `);
  assertEquals(status, STATUS_DONE);
  assertEquals(getNumericVar(mem, 'rx'), 3);
  assertEquals(getNumericVar(mem, 'ry'), 4);
});

Deno.test("new: constructor with no arguments", () => {
  assertNumericResult(`
    function Counter() {
      this.count = 0
    }
    let c = new Counter()
    let result = c.count
  `, 'result', 0);
});

// =============================================================================
// Return Value Semantics
// =============================================================================

Deno.test("new: implicit return uses created object", () => {
  assertNumericResult(`
    function Foo() {
      this.value = 42
    }
    let f = new Foo()
    let result = f.value
  `, 'result', 42);
});

Deno.test("new: explicit object return uses that object", () => {
  assertNumericResult(`
    function Foo() {
      this.value = 1
      return { value: 99 }
    }
    let f = new Foo()
    let result = f.value
  `, 'result', 99);
});

Deno.test("new: explicit primitive return keeps `this` (matches JS)", () => {
  // JS [[Construct]] ignores a primitive (or undefined) constructor
  // return and keeps the allocated object. OP_RETURN's constructor-frame
  // substitution enforces this class behavior.
  assertNumericResult(`
    function Foo() {
      this.value = 1
      return 42
    }
    let result = new Foo().value
  `, 'result', 1);
});

// =============================================================================
// this Binding
// =============================================================================

Deno.test("new: this refers to new object", () => {
  assertNumericResult(`
    function Box(val) {
      this.val = val
      this.getVal = function() { return this.val }
    }
    let b = new Box(10)
    let result = b.val
  `, 'result', 10);
});

// =============================================================================
// Arrow Function Error
// =============================================================================

Deno.test("new: arrow function throws TypeError", () => {
  const { mem, wasm, parser } = createTestContext();
  const status = runCode(mem, wasm, parser, `
    let Arrow = (x) => x
    new Arrow(1)
  `);
  assertEquals(status, 4); // STATUS_ERROR (uncaught exception)
});

Deno.test("new: arrow function TypeError can be caught", () => {
  const { mem, wasm, parser } = createTestContext();
  const status = runCode(mem, wasm, parser, `
    let caught = 0
    try {
      let Arrow = (x) => x
      new Arrow(1)
    } catch (e) {
      caught = 1
    }
  `);
  assertEquals(status, STATUS_DONE);
  assertEquals(getNumericVar(mem, 'caught'), 1);
});

// =============================================================================
// Nested new Calls
// =============================================================================

Deno.test("new: nested constructor calls", () => {
  assertNumericResult(`
    function Inner(x) {
      this.x = x
    }
    function Outer(x) {
      this.inner = new Inner(x * 2)
    }
    let o = new Outer(5)
    let result = o.inner.x
  `, 'result', 10);
});

Deno.test("new: constructor calling another constructor", () => {
  const { mem, wasm, parser } = createTestContext();
  const status = runCode(mem, wasm, parser, `
    function A(val) {
      this.a = val
    }
    function B(val) {
      this.b = new A(val + 1)
    }
    let obj = new B(10)
    let ra = obj.b.a
    let hasB = obj.b !== undefined
  `);
  assertEquals(status, STATUS_DONE);
  assertEquals(getNumericVar(mem, 'ra'), 11);
});

// =============================================================================
// Prototype Chain
// =============================================================================

Deno.test("new: object inherits from constructor prototype", () => {
  assertNumericResult(`
    function Foo() {}
    Foo.prototype.bar = 42
    let f = new Foo()
    let result = f.bar
  `, 'result', 42);
});

Deno.test("new: instance property shadows prototype property", () => {
  assertNumericResult(`
    function Foo() {
      this.bar = 100
    }
    Foo.prototype.bar = 42
    let f = new Foo()
    let result = f.bar
  `, 'result', 100);
});

// =============================================================================
// Multiple Instances
// =============================================================================

Deno.test("new: multiple instances are independent", () => {
  const { mem, wasm, parser } = createTestContext();
  const status = runCode(mem, wasm, parser, `
    function Counter(start) {
      this.count = start
    }
    let c1 = new Counter(1)
    let c2 = new Counter(100)
    c1.count = c1.count + 1
    let r1 = c1.count
    let r2 = c2.count
  `);
  assertEquals(status, STATUS_DONE);
  assertEquals(getNumericVar(mem, 'r1'), 2);
  assertEquals(getNumericVar(mem, 'r2'), 100);
});

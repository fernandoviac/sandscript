/**
 * Tests for instanceof operator.
 */

import { assertEquals } from "https://deno.land/std@0.208.0/assert/mod.ts";
import {
  createTestContext,
  runCode,
  getNumericVar,
  getBooleanVar,
  assertBooleanResult,
  STATUS_DONE,
  STATUS_ERROR,
} from './interpreter-test-utils.js';

// =============================================================================
// Basic instanceof with user constructor
// =============================================================================

Deno.test("instanceof: basic user constructor", () => {
  assertBooleanResult(`
    function Foo() {}
    let f = new Foo()
    let result = f instanceof Foo
  `, 'result', true);
});

Deno.test("instanceof: object not instance of unrelated constructor", () => {
  assertBooleanResult(`
    function Foo() {}
    function Bar() {}
    let f = new Foo()
    let result = f instanceof Bar
  `, 'result', false);
});

// =============================================================================
// Prototype chain walking
// =============================================================================

Deno.test("instanceof: inherits from Object", () => {
  assertBooleanResult(`
    function Foo() {}
    let f = new Foo()
    let result = f instanceof Object
  `, 'result', true);
});

Deno.test("instanceof: plain object instanceof Object", () => {
  assertBooleanResult(`
    let obj = {}
    let result = obj instanceof Object
  `, 'result', true);
});

Deno.test("instanceof: multi-level prototype chain", () => {
  // Foo.prototype → Object.prototype → null
  // f → Foo.prototype → Object.prototype → null
  assertBooleanResult(`
    function Foo() {}
    let f = new Foo()
    let result = f instanceof Object
  `, 'result', true);
});

// =============================================================================
// Error types
// =============================================================================

Deno.test("instanceof: TypeError instanceof Error", () => {
  assertBooleanResult(`
    let e = new TypeError("test")
    let result = e instanceof Error
  `, 'result', true);
});

Deno.test("instanceof: TypeError instanceof TypeError", () => {
  assertBooleanResult(`
    let e = new TypeError("test")
    let result = e instanceof TypeError
  `, 'result', true);
});

Deno.test("instanceof: Error not instanceof TypeError", () => {
  assertBooleanResult(`
    let e = new Error("test")
    let result = e instanceof TypeError
  `, 'result', false);
});

Deno.test("instanceof: ReferenceError instanceof Error", () => {
  assertBooleanResult(`
    let e = new ReferenceError("test")
    let result = e instanceof Error
  `, 'result', true);
});

// =============================================================================
// Arrays
// =============================================================================

Deno.test("instanceof: array instanceof Array", () => {
  assertBooleanResult(`
    let arr = [1, 2, 3]
    let result = arr instanceof Array
  `, 'result', true);
});

Deno.test("instanceof: array instanceof Object", () => {
  assertBooleanResult(`
    let arr = [1, 2, 3]
    let result = arr instanceof Object
  `, 'result', true);
});

Deno.test("instanceof: object not instanceof Array", () => {
  assertBooleanResult(`
    let obj = {}
    let result = obj instanceof Array
  `, 'result', false);
});

// =============================================================================
// Map / Set regression
//
// Both the RHS constructor dispatch (METHOD_MAP/SET_CONSTRUCTOR ->
// STATE_MAP/SET_PROTOTYPE) and the LHS special-case (a Map/Set value is not
// a prototype-bearing object) were missing; instanceof Map/Set threw
// "Not an object" / crashed on a garbage prototype walk.
// =============================================================================

Deno.test("instanceof: map instanceof Map", () => {
  assertBooleanResult(`
    let m = new Map()
    m.set('a', 1)
    let result = m instanceof Map
  `, 'result', true);
});

Deno.test("instanceof: map instanceof Object", () => {
  assertBooleanResult(`
    let m = new Map()
    let result = m instanceof Object
  `, 'result', true);
});

Deno.test("instanceof: map not instanceof Set", () => {
  assertBooleanResult(`
    let m = new Map()
    let result = m instanceof Set
  `, 'result', false);
});

Deno.test("instanceof: set instanceof Set", () => {
  assertBooleanResult(`
    let s = new Set()
    s.add(1)
    let result = s instanceof Set
  `, 'result', true);
});

Deno.test("instanceof: set instanceof Object", () => {
  assertBooleanResult(`
    let s = new Set()
    let result = s instanceof Object
  `, 'result', true);
});

Deno.test("instanceof: set not instanceof Map", () => {
  assertBooleanResult(`
    let s = new Set()
    let result = s instanceof Map
  `, 'result', false);
});

Deno.test("instanceof: array not instanceof Map", () => {
  assertBooleanResult(`
    let arr = [1, 2, 3]
    let result = arr instanceof Map
  `, 'result', false);
});

Deno.test("instanceof: object not instanceof Map", () => {
  assertBooleanResult(`
    let obj = {}
    let result = obj instanceof Map
  `, 'result', false);
});

// =============================================================================
// Functions
// =============================================================================

Deno.test("instanceof: function instanceof Function", () => {
  assertBooleanResult(`
    function foo() {}
    let result = foo instanceof Function
  `, 'result', true);
});

Deno.test("instanceof: arrow function instanceof Function", () => {
  assertBooleanResult(`
    let arrow = () => {}
    let result = arrow instanceof Function
  `, 'result', true);
});

Deno.test("instanceof: function instanceof Object", () => {
  assertBooleanResult(`
    function foo() {}
    let result = foo instanceof Object
  `, 'result', true);
});

// =============================================================================
// Primitives
// =============================================================================

Deno.test("instanceof: number not instanceof Number", () => {
  assertBooleanResult(`
    let n = 5
    let result = n instanceof Number
  `, 'result', false);
});

Deno.test("instanceof: string not instanceof String", () => {
  assertBooleanResult(`
    let s = "hello"
    let result = s instanceof String
  `, 'result', false);
});

Deno.test("instanceof: boolean not instanceof Boolean", () => {
  assertBooleanResult(`
    let b = true
    let result = b instanceof Boolean
  `, 'result', false);
});

Deno.test("instanceof: null returns false", () => {
  assertBooleanResult(`
    let x = null
    let result = x instanceof Object
  `, 'result', false);
});

Deno.test("instanceof: undefined returns false", () => {
  assertBooleanResult(`
    let x = undefined
    let result = x instanceof Object
  `, 'result', false);
});

// =============================================================================
// TypeError cases
// =============================================================================

Deno.test("instanceof: non-callable right side throws TypeError", () => {
  const { mem, wasm, parser } = createTestContext();
  const status = runCode(mem, wasm, parser, `
    let obj = {}
    obj instanceof {}
  `);
  assertEquals(status, 4); // STATUS_ERROR (uncaught exception)
});

Deno.test("instanceof: number on right side throws TypeError", () => {
  const { mem, wasm, parser } = createTestContext();
  const status = runCode(mem, wasm, parser, `
    let obj = {}
    obj instanceof 5
  `);
  assertEquals(status, 4);
});

Deno.test("instanceof: arrow function on right side throws TypeError", () => {
  const { mem, wasm, parser } = createTestContext();
  const status = runCode(mem, wasm, parser, `
    let arrow = () => {}
    let obj = {}
    obj instanceof arrow
  `);
  assertEquals(status, 4);
});

Deno.test("instanceof: TypeError can be caught", () => {
  const { mem, wasm, parser } = createTestContext();
  const status = runCode(mem, wasm, parser, `
    let caught = 0
    try {
      let obj = {}
      obj instanceof 5
    } catch (e) {
      caught = 1
    }
  `);
  assertEquals(status, STATUS_DONE);
  assertEquals(getNumericVar(mem, 'caught'), 1);
});

// =============================================================================
// new Function() throws TypeError
// =============================================================================

Deno.test("new Function() throws TypeError", () => {
  const { mem, wasm, parser } = createTestContext();
  const status = runCode(mem, wasm, parser, `
    new Function()
  `);
  assertEquals(status, 4); // STATUS_ERROR (uncaught exception)
});

Deno.test("new Function() TypeError can be caught", () => {
  const { mem, wasm, parser } = createTestContext();
  const status = runCode(mem, wasm, parser, `
    let caught = 0
    try {
      new Function()
    } catch (e) {
      caught = 1
    }
  `);
  assertEquals(status, STATUS_DONE);
  assertEquals(getNumericVar(mem, 'caught'), 1);
});

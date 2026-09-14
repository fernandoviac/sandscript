/**
 * Test interpreter objects and this binding.
 *
 * Run with: deno task test tests/fuel/test-interpreter-objects.js
 */

import {
  createTestContext,
  runCode,
  assertNumericResult,
  assertStringResult,
  assertBooleanResult,
  assertErrorCode,
  assertEquals,
  STATUS_DONE,
} from './interpreter-test-utils.js';

// =============================================================================
// Object Property Operations
// =============================================================================

Deno.test("Object: SET_PROP existing", () => {
  assertNumericResult('let obj = {x: 1}; obj.x = 42; let y = obj.x', 'y', 42);
});

Deno.test("Object: SET_PROP new", () => {
  assertNumericResult('let obj = {x: 1}; obj.y = 2; let z = obj.y', 'z', 2);
});

Deno.test("Object: SET_PROP returns value", () => {
  assertNumericResult('let obj = {}; let x = (obj.a = 42)', 'x', 42);
});

Deno.test("Object: SET_PROP multiple", () => {
  assertNumericResult('let obj = {}; obj.a = 1; obj.b = 2; obj.c = 3; let x = obj.b', 'x', 2);
});

Deno.test("Object: SET_PROP grow", () => {
  assertNumericResult('let obj = {a:1, b:2, c:3, d:4}; obj.e = 5; let x = obj.e', 'x', 5);
});

Deno.test("Object: SET_PROP preserve existing", () => {
  assertNumericResult('let obj = {x: 10}; obj.y = 20; let z = obj.x', 'z', 10);
});

Deno.test("Object: mixed access", () => {
  assertNumericResult('let obj = {a: 1}; obj["b"] = 2; let x = obj.a + obj["b"]', 'x', 3);
});

// =============================================================================
// Numeric and non-string dynamic keys coerce to strings (ToPropertyKey)
// =============================================================================

Deno.test("Object: integer key write and read", () => {
  assertNumericResult('let obj = {}; obj[42] = 1; let r = obj[42]', 'r', 1);
});

Deno.test("Object: integer key aliases its string form", () => {
  assertNumericResult('let obj = {}; obj[42] = 5; let r = obj["42"]', 'r', 5);
});

Deno.test("Object: string key readable via integer", () => {
  assertNumericResult('let obj = {}; obj["42"] = 9; let r = obj[42]', 'r', 9);
});

Deno.test("Object: integer key via variable", () => {
  assertNumericResult('let obj = {}; let k = 42; obj[k] = 7; let r = obj[k]', 'r', 7);
});

Deno.test("Object: negative integer key", () => {
  assertNumericResult('let obj = {}; obj[-3] = 4; let r = obj["-3"]', 'r', 4);
});

Deno.test("Object: float key aliases its string form", () => {
  assertNumericResult('let obj = {}; obj[1.5] = 3; let r = obj["1.5"]', 'r', 3);
});

Deno.test("Object: bigint key aliases its string form", () => {
  assertNumericResult('let obj = {}; obj[42n] = 11; let r = obj["42"]', 'r', 11);
});

Deno.test("Object: boolean key aliases its string form", () => {
  assertNumericResult('let obj = {}; obj[true] = 13; let r = obj["true"]', 'r', 13);
});

Deno.test("Object: numeric keys appear stringified in Object.keys", () => {
  assertStringResult('let obj = {}; obj[42] = 1; obj[1.5] = 2; let k = Object.keys(obj).join(",")', 'k', '42,1.5');
});

Deno.test("Object: numeric key dedupe map (bug report shape)", () => {
  assertNumericResult(
    'let bySeq = {}; let seqs = [3, 7, 3, 9, 7]; let count = 0;' +
    'for (let i = 0; i < seqs.length; i++) {' +
    '  if (!bySeq[seqs[i]]) { bySeq[seqs[i]] = true; count = count + 1 }' +
    '}',
    'count', 3);
});

// =============================================================================
// Object Property Increment/Decrement
// =============================================================================

Deno.test("Object: ++obj.x returns new", () => {
  assertNumericResult('let obj = {x: 5}; let y = ++obj.x', 'y', 6);
});

Deno.test("Object: ++obj.x stores new", () => {
  assertNumericResult('let obj = {x: 5}; ++obj.x; let y = obj.x', 'y', 6);
});

Deno.test("Object: --obj.x returns new", () => {
  assertNumericResult('let obj = {x: 5}; let y = --obj.x', 'y', 4);
});

Deno.test("Object: --obj.x stores new", () => {
  assertNumericResult('let obj = {x: 5}; --obj.x; let y = obj.x', 'y', 4);
});

Deno.test("Object: obj.x++ returns old", () => {
  assertNumericResult('let obj = {x: 5}; let y = obj.x++', 'y', 5);
});

Deno.test("Object: obj.x++ stores new", () => {
  assertNumericResult('let obj = {x: 5}; obj.x++; let y = obj.x', 'y', 6);
});

Deno.test("Object: obj.x-- returns old", () => {
  assertNumericResult('let obj = {x: 5}; let y = obj.x--', 'y', 5);
});

Deno.test("Object: obj.x-- stores new", () => {
  assertNumericResult('let obj = {x: 5}; obj.x--; let y = obj.x', 'y', 4);
});

// =============================================================================
// Object Compound Assignment
// =============================================================================

Deno.test("Object: += prop", () => {
  assertNumericResult('let obj = {x: 5}; obj.x += 3; let y = obj.x', 'y', 8);
});

Deno.test("Object: += bracket", () => {
  assertNumericResult('let obj = {x: 5}; obj["x"] += 3; let y = obj.x', 'y', 8);
});

// =============================================================================
// Method Shorthand
// =============================================================================

Deno.test("Object: method shorthand parses", () => {
  assertNumericResult('let obj = { x: 5, getX() { return 42 } }; let y = obj.getX()', 'y', 42);
});

Deno.test("Object: method shorthand with params", () => {
  assertNumericResult('let obj = { add(a, b) { return a + b } }; let y = obj.add(3, 4)', 'y', 7);
});

// =============================================================================
// this Binding
// =============================================================================

Deno.test("Object: this basic", () => {
  assertNumericResult('let obj = { x: 5, getX() { return this.x } }; let y = obj.getX()', 'y', 5);
});

Deno.test("Object: this with params", () => {
  assertNumericResult('let obj = { x: 10, add(n) { return this.x + n } }; let y = obj.add(5)', 'y', 15);
});

Deno.test("Object: this nested", () => {
  assertNumericResult(
    'let outer = { val: 10, inner: { val: 20, getVal() { return this.val } } }; let y = outer.inner.getVal()',
    'y', 20);
});

Deno.test("Object: this unbound", () => {
  assertNumericResult(
    'let obj = { x: 5, getX() { return this } }; let f = obj.getX; let y = f(); if (y === undefined) { y = 1 } else { y = 0 }',
    'y', 1);
});

Deno.test("Object: arrow no this", () => {
  assertNumericResult(
    `let obj = {
      x: 10,
      outer() {
        let inner = () => this.x;
        return inner()
      }
    }; let y = obj.outer()`,
    'y', 10);
});

Deno.test("Object: comma breaks this", () => {
  assertNumericResult(
    'let obj = { x: 5, getX() { return this } }; let y = (0, obj.getX)(); if (y === undefined) { y = 1 } else { y = 0 }',
    'y', 1);
});

Deno.test("Object: this chain", () => {
  assertNumericResult(
    'let obj = { nested: { x: 99, getX() { return this.x } } }; let y = obj.nested.getX()',
    'y', 99);
});

Deno.test("Object: this function expr", () => {
  assertNumericResult(
    'let obj = { x: 7, getX: function() { return this.x } }; let y = obj.getX()',
    'y', 7);
});

Deno.test("Object: this multi prop", () => {
  assertNumericResult(
    'let obj = { a: 2, b: 3, sum() { return this.a + this.b } }; let y = obj.sum()',
    'y', 5);
});

// =============================================================================
// typeof object
// =============================================================================

Deno.test("Object: typeof object", () => {
  assertNumericResult('let x = typeof {a:1}; if (x === "object") { x = 1 } else { x = 0 }', 'x', 1);
});

// =============================================================================
// new Object() and new Array()
// =============================================================================

Deno.test("Object: new Array() creates empty array", () => {
  const { mem, wasm, parser } = createTestContext();
  const status = runCode(mem, wasm, parser, 'let arr = new Array()');
  assertEquals(status, STATUS_DONE);

  const scope = mem.getRootScope();
  const nameOffset = mem.internString('arr');
  const valuePtr = mem.scopeLookup(scope, nameOffset);
  const val = mem.getValue(valuePtr);
  assertEquals(val.type, 6); // TYPE_ARRAY

  const arrPtr = Number(val.payload);
  const length = mem.view.getUint32(mem.abs(arrPtr + 8), true);
  assertEquals(length, 0);
});

Deno.test("Object: new Array(3) creates array with length 3", () => {
  const { mem, wasm, parser } = createTestContext();
  const status = runCode(mem, wasm, parser, 'let arr = new Array(3)');
  assertEquals(status, STATUS_DONE);

  const scope = mem.getRootScope();
  const nameOffset = mem.internString('arr');
  const valuePtr = mem.scopeLookup(scope, nameOffset);
  const val = mem.getValue(valuePtr);
  assertEquals(val.type, 6);

  const arrPtr = Number(val.payload);
  const length = mem.view.getUint32(mem.abs(arrPtr + 8), true);
  assertEquals(length, 3);
});

Deno.test("Object: new Array(10) creates array with length 10", () => {
  const { mem, wasm, parser } = createTestContext();
  const status = runCode(mem, wasm, parser, 'let arr = new Array(10)');
  assertEquals(status, STATUS_DONE);

  const scope = mem.getRootScope();
  const nameOffset = mem.internString('arr');
  const valuePtr = mem.scopeLookup(scope, nameOffset);
  const val = mem.getValue(valuePtr);
  assertEquals(val.type, 6);

  const arrPtr = Number(val.payload);
  const length = mem.view.getUint32(mem.abs(arrPtr + 8), true);
  assertEquals(length, 10);
});

Deno.test("Object: new Object() creates empty object", () => {
  const { mem, wasm, parser } = createTestContext();
  const status = runCode(mem, wasm, parser, 'let obj = new Object()');
  assertEquals(status, STATUS_DONE);

  const scope = mem.getRootScope();
  const nameOffset = mem.internString('obj');
  const valuePtr = mem.scopeLookup(scope, nameOffset);
  const val = mem.getValue(valuePtr);
  assertEquals(val.type, 7); // TYPE_OBJECT

  const objPtr = Number(val.payload);
  const count = mem.view.getUint32(mem.abs(objPtr + 8), true);
  assertEquals(count, 0);
});

Deno.test("Object: new Array(5).length returns 5", () => {
  assertNumericResult('let len = new Array(5).length', 'len', 5);
});

Deno.test("Object: new String() throws NotSupportedError", () => {
  assertErrorCode('new String()', 15);
});

Deno.test("Object: new Number() throws NotSupportedError", () => {
  assertErrorCode('new Number()', 15);
});

// =============================================================================
// Object.keys
// =============================================================================

Deno.test("Object: Object.keys returns correct length", () => {
  assertNumericResult('let obj = {a: 1, b: 2, c: 3}; let k = Object.keys(obj); let x = k.length', 'x', 3);
});

Deno.test("Object: Object.keys returns first key", () => {
  assertStringResult('let obj = {foo: 1, bar: 2}; let k = Object.keys(obj); let x = k[0]', 'x', 'foo');
});

Deno.test("Object: Object.keys returns second key", () => {
  assertStringResult('let obj = {foo: 1, bar: 2}; let k = Object.keys(obj); let x = k[1]', 'x', 'bar');
});

Deno.test("Object: Object.keys of empty object returns empty array", () => {
  assertNumericResult('let obj = {}; let k = Object.keys(obj); let x = k.length', 'x', 0);
});

// =============================================================================
// Object.values
// =============================================================================

Deno.test("Object: Object.values returns correct length", () => {
  assertNumericResult('let obj = {a: 1, b: 2, c: 3}; let v = Object.values(obj); let x = v.length', 'x', 3);
});

Deno.test("Object: Object.values returns first value", () => {
  assertNumericResult('let obj = {foo: 10, bar: 20}; let v = Object.values(obj); let x = v[0]', 'x', 10);
});

Deno.test("Object: Object.values returns second value", () => {
  assertNumericResult('let obj = {foo: 10, bar: 20}; let v = Object.values(obj); let x = v[1]', 'x', 20);
});

// =============================================================================
// Object.entries
// =============================================================================

Deno.test("Object: Object.entries returns correct length", () => {
  assertNumericResult('let obj = {a: 1, b: 2}; let e = Object.entries(obj); let x = e.length', 'x', 2);
});

Deno.test("Object: Object.entries first entry key", () => {
  assertStringResult('let obj = {foo: 42}; let e = Object.entries(obj); let x = e[0][0]', 'x', 'foo');
});

Deno.test("Object: Object.entries first entry value", () => {
  assertNumericResult('let obj = {foo: 42}; let e = Object.entries(obj); let x = e[0][1]', 'x', 42);
});

// =============================================================================
// Object.assign
// =============================================================================

Deno.test("Object: Object.assign copies property to target", () => {
  assertNumericResult('let t = {}; Object.assign(t, {a: 1}); let x = t.a', 'x', 1);
});

Deno.test("Object: Object.assign copies multiple properties", () => {
  assertNumericResult('let t = {}; Object.assign(t, {a: 1, b: 2}); let x = t.a + t.b', 'x', 3);
});

Deno.test("Object: Object.assign overwrites existing property", () => {
  assertNumericResult('let t = {a: 1}; Object.assign(t, {a: 5}); let x = t.a', 'x', 5);
});

Deno.test("Object: Object.assign from multiple sources", () => {
  assertNumericResult('let t = {}; Object.assign(t, {a: 1}, {b: 2}); let x = t.a + t.b', 'x', 3);
});

Deno.test("Object: Object.assign later source overwrites earlier", () => {
  assertNumericResult('let t = {}; Object.assign(t, {a: 1}, {a: 9}); let x = t.a', 'x', 9);
});

Deno.test("Object: Object.assign returns target", () => {
  assertNumericResult('let t = {x: 5}; let r = Object.assign(t, {y: 3}); let x = r.x', 'x', 5);
});

Deno.test("Object: Object.assign preserves existing properties", () => {
  assertNumericResult('let t = {a: 1, b: 2}; Object.assign(t, {c: 3}); let x = t.a + t.b + t.c', 'x', 6);
});

// =============================================================================
// Array.isArray
// =============================================================================

Deno.test("Object: Array.isArray([]) returns true", () => {
  assertBooleanResult('let x = Array.isArray([])', 'x', true);
});

Deno.test("Object: Array.isArray([1,2,3]) returns true", () => {
  assertBooleanResult('let x = Array.isArray([1,2,3])', 'x', true);
});

Deno.test("Object: Array.isArray({}) returns false", () => {
  assertBooleanResult('let x = Array.isArray({})', 'x', false);
});

Deno.test("Object: Array.isArray(5) returns false", () => {
  assertBooleanResult('let x = Array.isArray(5)', 'x', false);
});

Deno.test("Object: Array.isArray(string) returns false", () => {
  assertBooleanResult('let x = Array.isArray("hello")', 'x', false);
});

// =============================================================================
// Prototype Chain (using test helper to set prototypes)
// =============================================================================

Deno.test("Object: prototype chain - inherit property from prototype", () => {
  const { mem, wasm, parser } = createTestContext();

  // Create parent object with property 'a'
  runCode(mem, wasm, parser, 'let parent = { a: 42 }');
  const parentVal = mem.scopeLookup(mem.getRootScope(), mem.internString('parent'));
  const parentPtr = mem.view.getUint32(mem.abs(parentVal) + 8, true); // data_lo

  // Create child object with no properties
  runCode(mem, wasm, parser, 'let child = {}');
  const childVal = mem.scopeLookup(mem.getRootScope(), mem.internString('child'));
  const childPtr = mem.view.getUint32(mem.abs(childVal) + 8, true);

  // Set child's prototype to parent
  mem.setObjectPrototype(childPtr, parentPtr);

  // Access child.a - should find 42 from prototype chain
  const status = runCode(mem, wasm, parser, 'let x = child.a');
  assertEquals(status, STATUS_DONE);

  const xVal = mem.scopeLookup(mem.getRootScope(), mem.internString('x'));
  assertEquals(mem.readValueAt(xVal, { unwrapRational: true }), 42);
});

Deno.test("Object: prototype chain - own property shadows inherited", () => {
  const { mem, wasm, parser } = createTestContext();

  // Create parent with a=10
  runCode(mem, wasm, parser, 'let parent = { a: 10 }');
  const parentVal = mem.scopeLookup(mem.getRootScope(), mem.internString('parent'));
  const parentPtr = mem.view.getUint32(mem.abs(parentVal) + 8, true);

  // Create child with a=20
  runCode(mem, wasm, parser, 'let child = { a: 20 }');
  const childVal = mem.scopeLookup(mem.getRootScope(), mem.internString('child'));
  const childPtr = mem.view.getUint32(mem.abs(childVal) + 8, true);

  // Set child's prototype to parent
  mem.setObjectPrototype(childPtr, parentPtr);

  // Access child.a - should be 20 (own property shadows)
  const status = runCode(mem, wasm, parser, 'let x = child.a');
  assertEquals(status, STATUS_DONE);

  const xVal = mem.scopeLookup(mem.getRootScope(), mem.internString('x'));
  assertEquals(mem.readValueAt(xVal, { unwrapRational: true }), 20);
});

Deno.test("Object: prototype chain - missing property returns undefined", () => {
  const { mem, wasm, parser } = createTestContext();

  // Create parent with a=1
  runCode(mem, wasm, parser, 'let parent = { a: 1 }');
  const parentVal = mem.scopeLookup(mem.getRootScope(), mem.internString('parent'));
  const parentPtr = mem.view.getUint32(mem.abs(parentVal) + 8, true);

  // Create empty child
  runCode(mem, wasm, parser, 'let child = {}');
  const childVal = mem.scopeLookup(mem.getRootScope(), mem.internString('child'));
  const childPtr = mem.view.getUint32(mem.abs(childVal) + 8, true);

  // Set prototype
  mem.setObjectPrototype(childPtr, parentPtr);

  // Access child.b - not in chain, should be undefined
  const status = runCode(mem, wasm, parser, 'let x = child.b; let y = x === undefined ? 1 : 0');
  assertEquals(status, STATUS_DONE);

  const yVal = mem.scopeLookup(mem.getRootScope(), mem.internString('y'));
  assertEquals(mem.readValueAt(yVal, { unwrapRational: true }), 1);
});

Deno.test("Object: prototype chain - three levels deep", () => {
  const { mem, wasm, parser } = createTestContext();

  // Create grandparent with a=100
  runCode(mem, wasm, parser, 'let grandparent = { a: 100 }');
  const gpVal = mem.scopeLookup(mem.getRootScope(), mem.internString('grandparent'));
  const gpPtr = mem.view.getUint32(mem.abs(gpVal) + 8, true);

  // Create parent with b=200
  runCode(mem, wasm, parser, 'let parent = { b: 200 }');
  const parentVal = mem.scopeLookup(mem.getRootScope(), mem.internString('parent'));
  const parentPtr = mem.view.getUint32(mem.abs(parentVal) + 8, true);

  // Create child with c=300
  runCode(mem, wasm, parser, 'let child = { c: 300 }');
  const childVal = mem.scopeLookup(mem.getRootScope(), mem.internString('child'));
  const childPtr = mem.view.getUint32(mem.abs(childVal) + 8, true);

  // Set up chain: child -> parent -> grandparent
  mem.setObjectPrototype(parentPtr, gpPtr);
  mem.setObjectPrototype(childPtr, parentPtr);

  // Access child.a - should find 100 from grandparent
  runCode(mem, wasm, parser, 'let x = child.a');
  let val = mem.scopeLookup(mem.getRootScope(), mem.internString('x'));
  assertEquals(mem.readValueAt(val, { unwrapRational: true }), 100);

  // Access child.b - should find 200 from parent
  runCode(mem, wasm, parser, 'let y = child.b');
  val = mem.scopeLookup(mem.getRootScope(), mem.internString('y'));
  assertEquals(mem.readValueAt(val, { unwrapRational: true }), 200);

  // Access child.c - should find 300 from child itself
  runCode(mem, wasm, parser, 'let z = child.c');
  val = mem.scopeLookup(mem.getRootScope(), mem.internString('z'));
  assertEquals(mem.readValueAt(val, { unwrapRational: true }), 300);
});

Deno.test("Object: prototype chain - bracket notation works", () => {
  const { mem, wasm, parser } = createTestContext();

  // Create parent with property
  runCode(mem, wasm, parser, 'let parent = { foo: 77 }');
  const parentVal = mem.scopeLookup(mem.getRootScope(), mem.internString('parent'));
  const parentPtr = mem.view.getUint32(mem.abs(parentVal) + 8, true);

  // Create empty child
  runCode(mem, wasm, parser, 'let child = {}');
  const childVal = mem.scopeLookup(mem.getRootScope(), mem.internString('child'));
  const childPtr = mem.view.getUint32(mem.abs(childVal) + 8, true);

  // Set prototype
  mem.setObjectPrototype(childPtr, parentPtr);

  // Access via bracket notation
  const status = runCode(mem, wasm, parser, 'let x = child["foo"]');
  assertEquals(status, STATUS_DONE);

  const xVal = mem.scopeLookup(mem.getRootScope(), mem.internString('x'));
  assertEquals(mem.readValueAt(xVal, { unwrapRational: true }), 77);
});

Deno.test("Object: prototype chain - function inherits from prototype", () => {
  const { mem, wasm, parser } = createTestContext();

  // Create prototype object with property
  runCode(mem, wasm, parser, 'let proto = { inherited: 999 }');
  const protoVal = mem.scopeLookup(mem.getRootScope(), mem.internString('proto'));
  const protoPtr = mem.view.getUint32(mem.abs(protoVal) + 8, true);

  // Create function
  runCode(mem, wasm, parser, 'let f = function() {}');
  const fVal = mem.scopeLookup(mem.getRootScope(), mem.internString('f'));
  const fPtr = mem.view.getUint32(mem.abs(fVal) + 8, true);

  // Set function's prototype chain (not .prototype property, the internal [[Prototype]])
  mem.setObjectPrototype(fPtr, protoPtr);

  // Access f.inherited - should find from prototype chain
  const status = runCode(mem, wasm, parser, 'let x = f.inherited');
  assertEquals(status, STATUS_DONE);

  const xVal = mem.scopeLookup(mem.getRootScope(), mem.internString('x'));
  assertEquals(mem.readValueAt(xVal, { unwrapRational: true }), 999);
});

// =============================================================================
// hasOwnProperty
// =============================================================================

Deno.test("Object: hasOwnProperty returns false for missing property", () => {
  assertBooleanResult('let obj = {}; let x = obj.hasOwnProperty("x")', 'x', false);
});

Deno.test("Object: hasOwnProperty returns true for own property", () => {
  assertBooleanResult('let obj = {foo: 1}; let x = obj.hasOwnProperty("foo")', 'x', true);
});

Deno.test("Object: hasOwnProperty returns false for other property", () => {
  assertBooleanResult('let obj = {foo: 1}; let x = obj.hasOwnProperty("bar")', 'x', false);
});

Deno.test("Object: hasOwnProperty coerces key to string", () => {
  assertBooleanResult('let obj = {"1": "one"}; let x = obj.hasOwnProperty(1)', 'x', true);
});

Deno.test("Object: hasOwnProperty does not find prototype property", () => {
  // toString is inherited from Object.prototype, not own property
  assertBooleanResult('let obj = {}; let x = obj.hasOwnProperty("toString")', 'x', false);
});

// =============================================================================
// Object.prototype.toString
// =============================================================================

Deno.test("Object: toString returns [object Object]", () => {
  assertStringResult('let obj = {}; let x = obj.toString()', 'x', '[object Object]');
});

Deno.test("Object: toString with properties returns [object Object]", () => {
  assertStringResult('let obj = {a: 1, b: 2}; let x = obj.toString()', 'x', '[object Object]');
});

// =============================================================================
// Object.getPrototypeOf
// =============================================================================

Deno.test("Object: getPrototypeOf returns Object.prototype", () => {
  // Object.getPrototypeOf({}) should return Object.prototype
  // We can test this indirectly by checking that it has hasOwnProperty
  assertBooleanResult('let obj = {}; let proto = Object.getPrototypeOf(obj); let x = proto.hasOwnProperty !== undefined', 'x', true);
});

Deno.test("Object: getPrototypeOf(Object.prototype) returns null", () => {
  const { mem, wasm, parser } = createTestContext();
  const status = runCode(mem, wasm, parser, 'let obj = {}; let proto = Object.getPrototypeOf(Object.getPrototypeOf(obj)); let x = proto');
  assertEquals(status, STATUS_DONE);
  const xVal = mem.scopeLookup(mem.getRootScope(), mem.internString('x'));
  const xType = mem.getValueType(xVal);
  assertEquals(xType, 0); // TYPE_NULL
});

Deno.test("Object: getPrototypeOf([]) returns Array.prototype", () => {
  // Array.prototype should have prototype chain to Object.prototype
  assertBooleanResult('let arr = []; let proto = Object.getPrototypeOf(Object.getPrototypeOf(arr)); let x = proto.hasOwnProperty !== undefined', 'x', true);
});

// =============================================================================
// Property shorthand: { foo } is sugar for { foo: foo }
// =============================================================================
//
// ES2015 shorthand. The parser detects an IDENTIFIER followed by
// COMMA or RBRACE in an object literal and emits GET_VAR for the
// value (matching the bare-identifier expression path), while the
// key uses the identifier's name as a string. Drone authors writing
// `box('out').postMessage({ result, value: f() })` no longer need
// to spell out `{ result: result, value: f() }`.

Deno.test("Object: shorthand { foo } is sugar for { foo: foo }", () => {
  assertNumericResult('let foo = 42; let obj = { foo }; let x = obj.foo', 'x', 42);
});

Deno.test("Object: shorthand mixed with regular property", () => {
  assertNumericResult('let a = 1; let b = 2; let obj = { a, b: b * 10 }; let x = obj.b', 'x', 20);
  assertNumericResult('let a = 1; let b = 2; let obj = { a, b: b * 10 }; let x = obj.a', 'x', 1);
});

Deno.test("Object: multiple shorthand properties", () => {
  assertNumericResult('let a = 1; let b = 2; let c = 3; let obj = { a, b, c }; let x = obj.b', 'x', 2);
});

Deno.test("Object: shorthand as last property (no trailing comma)", () => {
  assertStringResult('let name = "alice"; let obj = { name }; let x = obj.name', 'x', 'alice');
});

Deno.test("Object: shorthand from outer scope (closure capture)", () => {
  // The shorthand resolves the variable via the same path as the
  // bare identifier expression — closure capture should work too.
  assertNumericResult(`
    let x = 7
    function make() {
      return { x }
    }
    let y = make().x
  `, 'y', 7);
});

// =============================================================================
// Numeric property keys (fixed 2026-07-05 — used to be "Expected property
// name"). Keys are the number's canonical string form, matching JS.
// =============================================================================

Deno.test("Object: numeric keys in literals", () => {
  assertStringResult(`let o = {0: 'x', 1: 'y'}; let r = o[0] + o[1];`, 'r', 'xy');
});

Deno.test("Object: numeric keys canonicalize (1.50 keys as '1.5', 0x10 as '16')", () => {
  assertStringResult(`let o = {1.50: 'a', 0x10: 'b'}; let r = o["1.5"] + o["16"];`, 'r', 'ab');
});

Deno.test("Object: numeric keys mix with identifiers and enumerate", () => {
  assertStringResult(`let o = {a: 1, 0: 2, b: 3}; let r = Object.keys(o).join(",");`, 'r', 'a,0,b');
});

Deno.test("Object: numeric method shorthand", () => {
  assertStringResult(`let o = {0() { return "m"; }}; let r = o[0]();`, 'r', 'm');
});

Deno.test("Object: numeric pattern keys destructure", () => {
  assertStringResult(`let {0: first, 1: second} = {0: 'p', 1: 'q'}; let r = first + second;`, 'r', 'pq');
});

/**
 * Test the formatValue function used by CLI output.
 */

import { formatValue } from '../../src/sand/cli.js';

console.log('=== formatValue Tests ===\n');

let passed = 0;
let failed = 0;

function test(name, actual, expected) {
  if (actual === expected) {
    console.log(`PASS: ${name}`);
    passed++;
  } else {
    console.log(`FAIL: ${name}`);
    console.log(`  expected: ${expected}`);
    console.log(`  actual:   ${actual}`);
    failed++;
  }
}

// Primitives
test('null', formatValue(null), 'null');
test('undefined', formatValue(undefined), 'undefined');
test('number', formatValue(42), '42');
test('negative number', formatValue(-3.14), '-3.14');
test('boolean true', formatValue(true), 'true');
test('boolean false', formatValue(false), 'false');

// Strings
test('string at top level (no quotes)', formatValue('hello world'), 'hello world');
test('empty string', formatValue(''), '');

// Long strings truncate
const longString = 'a'.repeat(250);
test('long string truncates at 200', formatValue(longString), 'a'.repeat(200) + '...');

// Functions
test('named function', formatValue(function myFunc() {}), '[Function: myFunc]');
test('anonymous function', formatValue(function() {}), '[Function]');
test('arrow function', formatValue(() => {}), '[Function]');

// Simple objects
test('simple object', formatValue({a: 1, b: 2}), '{ a: 1, b: 2 }');
test('empty object', formatValue({}), '{  }');
test('object with array', formatValue({a: 1, b: [2, 3]}), '{ a: 1, b: [2, 3] }');

// Arrays
test('simple array', formatValue([1, 2, 3]), '[1, 2, 3]');
test('empty array', formatValue([]), '[]');
test('nested array', formatValue([[1, 2], [3, 4]]), '[[1, 2], [3, 4]]');

// Nested strings get quotes
test('string nested in object', formatValue({name: 'Alice'}), '{ name: "Alice" }');
test('string nested in array', formatValue(['a', 'b']), '["a", "b"]');

// Depth limiting
test('depth 3 truncates', formatValue({l1: {l2: {l3: {l4: 'deep'}}}}), '{ l1: { l2: { l3: {...} } } }');
test('array at depth 3 truncates', formatValue({l1: {l2: {l3: [1, 2, 3]}}}), '{ l1: { l2: { l3: [...] } } }');

// Circular references
const circular = {a: 1};
circular.self = circular;
test('circular reference', formatValue(circular), '{ a: 1, self: [Circular] }');

const circularArray = [1, 2];
circularArray.push(circularArray);
test('circular array', formatValue(circularArray), '[1, 2, [Circular]]');

// Large collections truncate
const largeArray = Array.from({length: 25}, (_, i) => i);
test('large array truncates', formatValue(largeArray), '[0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, ... 5 more]');

const largeObject = {};
for (let i = 0; i < 25; i++) largeObject[`k${i}`] = i;
const largeObjResult = formatValue(largeObject);
test('large object truncates', largeObjResult.includes('... 5 more'), true);

// Long nested strings truncate
const longNestedString = 'x'.repeat(100);
test('long nested string truncates at 50', formatValue({s: longNestedString}), '{ s: "' + 'x'.repeat(50) + '..." }');

// Mixed complex structure
test('complex nested', formatValue({
  num: 42,
  arr: [1, 2],
  obj: {x: 'hi'}
}), '{ num: 42, arr: [1, 2], obj: { x: "hi" } }');

console.log(`\n${passed} passed, ${failed} failed`);

if (failed > 0) {
  Deno.exit(1);
}

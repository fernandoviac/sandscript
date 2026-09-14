import {
  assertNumericResult,
  assertArrayResult,
  assertUndefinedResult,
  assertBooleanResult,
  assertStringResult,
} from './interpreter-test-utils.js';

// =============================================================================
// Array.isArray (already implemented — needs test coverage)
// =============================================================================

Deno.test("Array.isArray: true for array literal", () => {
  assertBooleanResult('let r = Array.isArray([1, 2, 3])', 'r', true);
});

Deno.test("Array.isArray: true for empty array", () => {
  assertBooleanResult('let r = Array.isArray([])', 'r', true);
});

Deno.test("Array.isArray: false for number", () => {
  assertBooleanResult('let r = Array.isArray(42)', 'r', false);
});

Deno.test("Array.isArray: false for string", () => {
  assertBooleanResult('let r = Array.isArray("hello")', 'r', false);
});

Deno.test("Array.isArray: false for object", () => {
  assertBooleanResult('let r = Array.isArray({a: 1})', 'r', false);
});

Deno.test("Array.isArray: false for null", () => {
  assertBooleanResult('let r = Array.isArray(null)', 'r', false);
});

Deno.test("Array.isArray: false for undefined", () => {
  assertBooleanResult('let r = Array.isArray(undefined)', 'r', false);
});

// =============================================================================
// Array.from (already implemented — needs test coverage)
// =============================================================================

Deno.test("Array.from: clone array", () => {
  assertArrayResult('let r = Array.from([1, 2, 3])', 'r', [1, 2, 3]);
});

Deno.test("Array.from: empty array", () => {
  assertArrayResult('let r = Array.from([])', 'r', []);
});

Deno.test("Array.from: string to char array", () => {
  assertArrayResult('let r = Array.from("abc")', 'r', ["a", "b", "c"]);
});

Deno.test("Array.from: clone is independent", () => {
  assertArrayResult(
    'let a = [1, 2, 3]; let b = Array.from(a); a[0] = 99; let r = b',
    'r', [1, 2, 3]
  );
});

// =============================================================================
// splice
// =============================================================================

Deno.test("splice: delete one element", () => {
  assertArrayResult(
    'let a = [1, 2, 3, 4]; a.splice(1, 1); let r = a',
    'r', [1, 3, 4]
  );
});

Deno.test("splice: returns removed elements", () => {
  assertArrayResult(
    'let a = [1, 2, 3, 4]; let r = a.splice(1, 2)',
    'r', [2, 3]
  );
});

Deno.test("splice: insert without deleting", () => {
  assertArrayResult(
    'let a = [1, 4]; a.splice(1, 0, 2, 3); let r = a',
    'r', [1, 2, 3, 4]
  );
});

Deno.test("splice: replace elements", () => {
  assertArrayResult(
    'let a = [1, 2, 3]; a.splice(1, 1, 10, 20); let r = a',
    'r', [1, 10, 20, 3]
  );
});

Deno.test("splice: delete from start", () => {
  assertArrayResult(
    'let a = [1, 2, 3]; a.splice(0, 1); let r = a',
    'r', [2, 3]
  );
});

Deno.test("splice: delete to end", () => {
  assertArrayResult(
    'let a = [1, 2, 3, 4]; a.splice(2); let r = a',
    'r', [1, 2]
  );
});

Deno.test("splice: negative start index", () => {
  assertArrayResult(
    'let a = [1, 2, 3, 4]; a.splice(-2, 1); let r = a',
    'r', [1, 2, 4]
  );
});

Deno.test("splice: empty return when nothing removed", () => {
  assertArrayResult(
    'let a = [1, 2, 3]; let r = a.splice(1, 0)',
    'r', []
  );
});

Deno.test("splice: deleteCount exceeds remaining", () => {
  assertArrayResult(
    'let a = [1, 2, 3]; let r = a.splice(1, 100)',
    'r', [2, 3]
  );
});

Deno.test("splice: start beyond length", () => {
  assertArrayResult(
    'let a = [1, 2]; a.splice(5, 0, 3); let r = a',
    'r', [1, 2, 3]
  );
});

// =============================================================================
// sort
// =============================================================================

Deno.test("sort: default numeric sort", () => {
  assertArrayResult(
    'let r = [3, 1, 4, 1, 5].sort()',
    'r', [1, 1, 3, 4, 5]
  );
});

Deno.test("sort: already sorted", () => {
  assertArrayResult(
    'let r = [1, 2, 3].sort()',
    'r', [1, 2, 3]
  );
});

Deno.test("sort: reverse order", () => {
  assertArrayResult(
    'let r = [5, 4, 3, 2, 1].sort()',
    'r', [1, 2, 3, 4, 5]
  );
});

Deno.test("sort: single element", () => {
  assertArrayResult(
    'let r = [42].sort()',
    'r', [42]
  );
});

Deno.test("sort: empty array", () => {
  assertArrayResult(
    'let r = [].sort()',
    'r', []
  );
});

Deno.test("sort: custom comparator ascending", () => {
  assertArrayResult(
    'let r = [3, 1, 2].sort((a, b) => a - b)',
    'r', [1, 2, 3]
  );
});

Deno.test("sort: custom comparator descending", () => {
  assertArrayResult(
    'let r = [3, 1, 2].sort((a, b) => b - a)',
    'r', [3, 2, 1]
  );
});

Deno.test("sort: mutates in place", () => {
  assertArrayResult(
    'let a = [3, 1, 2]; a.sort(); let r = a',
    'r', [1, 2, 3]
  );
});

Deno.test("sort: returns the array", () => {
  assertArrayResult(
    'let a = [3, 1, 2]; let r = a.sort()',
    'r', [1, 2, 3]
  );
});

Deno.test("sort: string default sort (toString comparison)", () => {
  assertArrayResult(
    'let r = ["banana", "apple", "cherry"].sort()',
    'r', ["apple", "banana", "cherry"]
  );
});

// =============================================================================
// flat
// =============================================================================

Deno.test("flat: one level deep", () => {
  assertArrayResult(
    'let r = [1, [2, 3], 4].flat()',
    'r', [1, 2, 3, 4]
  );
});

Deno.test("flat: already flat", () => {
  assertArrayResult(
    'let r = [1, 2, 3].flat()',
    'r', [1, 2, 3]
  );
});

Deno.test("flat: empty array", () => {
  assertArrayResult(
    'let r = [].flat()',
    'r', []
  );
});

Deno.test("flat: nested arrays default depth 1", () => {
  assertArrayResult(
    'let r = [1, [2, [3]]].flat()',
    'r', [1, 2, "<type 6>"]
  );
});

Deno.test("flat: depth 2", () => {
  assertArrayResult(
    'let r = [1, [2, [3]]].flat(2)',
    'r', [1, 2, 3]
  );
});

Deno.test("flat: multiple nested at same level", () => {
  assertArrayResult(
    'let r = [[1, 2], [3, 4], [5]].flat()',
    'r', [1, 2, 3, 4, 5]
  );
});

// =============================================================================
// flatMap
// =============================================================================

Deno.test("flatMap: basic mapping and flatten", () => {
  assertArrayResult(
    'let r = [1, 2, 3].flatMap(x => [x, x * 2])',
    'r', [1, 2, 2, 4, 3, 6]
  );
});

Deno.test("flatMap: filtering by returning empty array", () => {
  assertArrayResult(
    'let r = [1, 2, 3, 4].flatMap(x => x % 2 === 0 ? [x] : [])',
    'r', [2, 4]
  );
});

Deno.test("flatMap: identity", () => {
  assertArrayResult(
    'let r = [1, 2, 3].flatMap(x => [x])',
    'r', [1, 2, 3]
  );
});

Deno.test("flatMap: empty source", () => {
  assertArrayResult(
    'let r = [].flatMap(x => [x, x])',
    'r', []
  );
});

// =============================================================================
// at
// =============================================================================

Deno.test("at: positive index", () => {
  assertNumericResult('let r = [10, 20, 30].at(1)', 'r', 20);
});

Deno.test("at: first element", () => {
  assertNumericResult('let r = [10, 20, 30].at(0)', 'r', 10);
});

Deno.test("at: last element with -1", () => {
  assertNumericResult('let r = [10, 20, 30].at(-1)', 'r', 30);
});

Deno.test("at: second to last with -2", () => {
  assertNumericResult('let r = [10, 20, 30].at(-2)', 'r', 20);
});

Deno.test("at: out of bounds returns undefined", () => {
  assertUndefinedResult('let r = [10, 20].at(5)', 'r');
});

Deno.test("at: negative out of bounds returns undefined", () => {
  assertUndefinedResult('let r = [10, 20].at(-5)', 'r');
});

// =============================================================================
// fill
// =============================================================================

Deno.test("fill: fill entire array", () => {
  assertArrayResult(
    'let r = [1, 2, 3].fill(0)',
    'r', [0, 0, 0]
  );
});

Deno.test("fill: fill with start", () => {
  assertArrayResult(
    'let r = [1, 2, 3, 4].fill(0, 2)',
    'r', [1, 2, 0, 0]
  );
});

Deno.test("fill: fill with start and end", () => {
  assertArrayResult(
    'let r = [1, 2, 3, 4].fill(0, 1, 3)',
    'r', [1, 0, 0, 4]
  );
});

Deno.test("fill: returns the array", () => {
  assertArrayResult(
    'let a = [1, 2, 3]; let r = a.fill(9)',
    'r', [9, 9, 9]
  );
});

Deno.test("fill: negative start", () => {
  assertArrayResult(
    'let r = [1, 2, 3, 4].fill(0, -2)',
    'r', [1, 2, 0, 0]
  );
});

Deno.test("fill: empty array", () => {
  assertArrayResult(
    'let r = [].fill(5)',
    'r', []
  );
});

// =============================================================================
// lastIndexOf
// =============================================================================

Deno.test("lastIndexOf: found last occurrence", () => {
  assertNumericResult('let r = [1, 2, 3, 2, 1].lastIndexOf(2)', 'r', 3);
});

Deno.test("lastIndexOf: not found", () => {
  assertNumericResult('let r = [1, 2, 3].lastIndexOf(5)', 'r', -1);
});

Deno.test("lastIndexOf: first element", () => {
  assertNumericResult('let r = [1, 2, 3].lastIndexOf(1)', 'r', 0);
});

Deno.test("lastIndexOf: last element", () => {
  assertNumericResult('let r = [1, 2, 3].lastIndexOf(3)', 'r', 2);
});

Deno.test("lastIndexOf: empty array", () => {
  assertNumericResult('let r = [].lastIndexOf(1)', 'r', -1);
});

// =============================================================================
// copyWithin
// =============================================================================

Deno.test("copyWithin: basic copy", () => {
  assertArrayResult(
    'let r = [1, 2, 3, 4, 5].copyWithin(0, 3)',
    'r', [4, 5, 3, 4, 5]
  );
});

Deno.test("copyWithin: with end", () => {
  assertArrayResult(
    'let r = [1, 2, 3, 4, 5].copyWithin(1, 3, 4)',
    'r', [1, 4, 3, 4, 5]
  );
});

Deno.test("copyWithin: overlapping forward", () => {
  assertArrayResult(
    'let r = [1, 2, 3, 4, 5].copyWithin(1, 0, 3)',
    'r', [1, 1, 2, 3, 5]
  );
});

Deno.test("copyWithin: negative target", () => {
  assertArrayResult(
    'let r = [1, 2, 3, 4, 5].copyWithin(-2, 0, 2)',
    'r', [1, 2, 3, 1, 2]
  );
});

Deno.test("copyWithin: returns the array", () => {
  assertArrayResult(
    'let a = [1, 2, 3]; let r = a.copyWithin(0, 1)',
    'r', [2, 3, 3]
  );
});

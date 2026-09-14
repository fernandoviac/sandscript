/**
 * Test interpreter array methods.
 *
 * Run with: deno task test tests/fuel/interpreter-arrays_test.js
 */

import {
  assertNumericResult,
  assertArrayResult,
  assertUndefinedResult,
  assertBooleanResult,
} from './interpreter-test-utils.js';

// =============================================================================
// Array Length
// =============================================================================

Deno.test("Array: length basic", () => {
  assertNumericResult('let arr = [1, 2, 3]; let y = arr.length', 'y', 3);
});

Deno.test("Array: length empty", () => {
  assertNumericResult('let arr = []; let y = arr.length', 'y', 0);
});

Deno.test("Array: length one", () => {
  assertNumericResult('let arr = [42]; let y = arr.length', 'y', 1);
});

Deno.test("Array: length five", () => {
  assertNumericResult('let arr = [1, 2, 3, 4, 5]; let y = arr.length', 'y', 5);
});

Deno.test("Array: length in expression", () => {
  assertNumericResult('let arr = [1, 2, 3]; let y = arr.length + 10', 'y', 13);
});

Deno.test("Array: length comparison", () => {
  assertNumericResult('let arr = [1, 2]; let y = arr.length < 5; if (y) { y = 1 } else { y = 0 }', 'y', 1);
});

Deno.test("Array: literal length", () => {
  assertNumericResult('let y = [1, 2, 3, 4].length', 'y', 4);
});

// =============================================================================
// Array Index Operations
// =============================================================================

Deno.test("Array: SET_INDEX in bounds", () => {
  assertNumericResult('let arr = [1, 2, 3]; arr[1] = 42; let x = arr[1]', 'x', 42);
});

Deno.test("Array: SET_INDEX first", () => {
  assertNumericResult('let arr = [1, 2, 3]; arr[0] = 99; let x = arr[0]', 'x', 99);
});

Deno.test("Array: SET_INDEX last", () => {
  assertNumericResult('let arr = [1, 2, 3]; arr[2] = 77; let x = arr[2]', 'x', 77);
});

Deno.test("Array: SET_INDEX at length", () => {
  assertNumericResult('let arr = [1, 2]; arr[2] = 3; let x = arr[2]', 'x', 3);
});

Deno.test("Array: SET_INDEX sparse", () => {
  assertNumericResult('let arr = [1]; arr[5] = 42; let x = arr[5]', 'x', 42);
});

Deno.test("Array: SET_INDEX returns value", () => {
  assertNumericResult('let arr = [1]; let x = (arr[0] = 42)', 'x', 42);
});

Deno.test("Array: SET_INDEX grow double", () => {
  assertNumericResult('let arr = [1, 2, 3, 4]; arr[8] = 100; let x = arr[8]', 'x', 100);
});

// =============================================================================
// Array Index Increment/Decrement
// =============================================================================

Deno.test("Array: ++arr[0] returns new", () => {
  assertNumericResult('let arr = [10]; let y = ++arr[0]', 'y', 11);
});

Deno.test("Array: ++arr[0] stores new", () => {
  assertNumericResult('let arr = [10]; ++arr[0]; let y = arr[0]', 'y', 11);
});

Deno.test("Array: --arr[0] returns new", () => {
  assertNumericResult('let arr = [10]; let y = --arr[0]', 'y', 9);
});

Deno.test("Array: --arr[0] stores new", () => {
  assertNumericResult('let arr = [10]; --arr[0]; let y = arr[0]', 'y', 9);
});

Deno.test("Array: arr[0]++ returns old", () => {
  assertNumericResult('let arr = [10]; let y = arr[0]++', 'y', 10);
});

Deno.test("Array: arr[0]++ stores new", () => {
  assertNumericResult('let arr = [10]; arr[0]++; let y = arr[0]', 'y', 11);
});

Deno.test("Array: arr[0]-- returns old", () => {
  assertNumericResult('let arr = [10]; let y = arr[0]--', 'y', 10);
});

Deno.test("Array: arr[0]-- stores new", () => {
  assertNumericResult('let arr = [10]; arr[0]--; let y = arr[0]', 'y', 9);
});

Deno.test("Array: ++arr[i] returns new", () => {
  assertNumericResult('let arr = [10]; let i = 0; let y = ++arr[i]', 'y', 11);
});

Deno.test("Array: ++arr[i] stores new", () => {
  assertNumericResult('let arr = [10]; let i = 0; ++arr[i]; let y = arr[i]', 'y', 11);
});

Deno.test("Array: --arr[i] returns new", () => {
  assertNumericResult('let arr = [10]; let i = 0; let y = --arr[i]', 'y', 9);
});

Deno.test("Array: --arr[i] stores new", () => {
  assertNumericResult('let arr = [10]; let i = 0; --arr[i]; let y = arr[i]', 'y', 9);
});

Deno.test("Array: arr[i]++ returns old", () => {
  assertNumericResult('let arr = [10]; let i = 0; let y = arr[i]++', 'y', 10);
});

Deno.test("Array: arr[i]++ stores new", () => {
  assertNumericResult('let arr = [10]; let i = 0; arr[i]++; let y = arr[i]', 'y', 11);
});

Deno.test("Array: arr[i]-- returns old", () => {
  assertNumericResult('let arr = [10]; let i = 0; let y = arr[i]--', 'y', 10);
});

Deno.test("Array: arr[i]-- stores new", () => {
  assertNumericResult('let arr = [10]; let i = 0; arr[i]--; let y = arr[i]', 'y', 9);
});

Deno.test("Array: ++arr[1] middle", () => {
  assertNumericResult('let arr = [10, 20, 30]; let y = ++arr[1]', 'y', 21);
});

Deno.test("Array: arr[2]++ last", () => {
  assertNumericResult('let arr = [10, 20, 30]; let y = arr[2]++', 'y', 30);
});

Deno.test("Array: ++arr[i % 3]", () => {
  assertNumericResult('let arr = [10, 20, 30]; let i = 4; let y = ++arr[i % 3]', 'y', 21);
});

Deno.test("Array: arr[i + 1]++", () => {
  assertNumericResult('let arr = [10, 20, 30]; let i = 0; let y = arr[i + 1]++', 'y', 20);
});

Deno.test("Array: ++arr[i % 3] in loop", () => {
  assertNumericResult('let arr = [0, 0, 0]; for (let i = 0; i < 10; i++) { ++arr[i % 3] }; let y = arr[0]', 'y', 4);
});

Deno.test("Array: arr[i % 3]+= in loop", () => {
  assertNumericResult('let arr = [0, 0, 0]; for (let i = 0; i < 10; i++) { arr[i % 3] += 1 }; let y = arr[1]', 'y', 3);
});

// =============================================================================
// Array Compound Assignment
// =============================================================================

Deno.test("Array: += index var", () => {
  assertNumericResult('let arr = [5]; arr[0] += 3; let y = arr[0]', 'y', 8);
});

Deno.test("Array: += index ident", () => {
  assertNumericResult('let arr = [1, 2, 5]; let i = 2; arr[i] += 3; let y = arr[i]', 'y', 8);
});

// =============================================================================
// Array Method Lookup
// =============================================================================

Deno.test("Array: method lookup", () => {
  assertNumericResult(
    'let arr = [1, 2]; let m = arr.push; let y = 0; if (typeof m === "function") { y = 1 }',
    'y', 1);
});

Deno.test("Array: push callable", () => {
  assertNumericResult('let arr = [1, 2]; arr.push(3); let y = arr[2]', 'y', 3);
});

// =============================================================================
// Array Mutating Methods
// =============================================================================

Deno.test("Array: push returns length", () => {
  assertNumericResult('let arr = [1, 2]; let y = arr.push(3)', 'y', 3);
});

Deno.test("Array: push modifies array", () => {
  assertNumericResult('let arr = [1, 2]; arr.push(3); let y = arr.length', 'y', 3);
});

Deno.test("Array: push value accessible", () => {
  assertNumericResult('let arr = [1, 2]; arr.push(99); let y = arr[2]', 'y', 99);
});

Deno.test("Array: push to empty", () => {
  assertNumericResult('let arr = []; arr.push(5); let y = arr[0]', 'y', 5);
});

Deno.test("Array: pop returns last", () => {
  assertNumericResult('let arr = [1, 2, 3]; let y = arr.pop()', 'y', 3);
});

Deno.test("Array: pop modifies length", () => {
  assertNumericResult('let arr = [1, 2, 3]; arr.pop(); let y = arr.length', 'y', 2);
});

Deno.test("Array: pop single element", () => {
  assertNumericResult('let arr = [42]; let y = arr.pop()', 'y', 42);
});

Deno.test("Array: pop empty returns undefined", () => {
  assertNumericResult('let arr = []; let y = arr.pop(); if (y === undefined) { y = 1 } else { y = 0 }', 'y', 1);
});

Deno.test("Array: shift returns first", () => {
  assertNumericResult('let arr = [1, 2, 3]; let y = arr.shift()', 'y', 1);
});

Deno.test("Array: shift modifies length", () => {
  assertNumericResult('let arr = [1, 2, 3]; arr.shift(); let y = arr.length', 'y', 2);
});

Deno.test("Array: shift moves elements", () => {
  assertNumericResult('let arr = [1, 2, 3]; arr.shift(); let y = arr[0]', 'y', 2);
});

Deno.test("Array: shift empty returns undefined", () => {
  assertNumericResult('let arr = []; let y = arr.shift(); if (y === undefined) { y = 1 } else { y = 0 }', 'y', 1);
});

Deno.test("Array: unshift returns length", () => {
  assertNumericResult('let arr = [2, 3]; let y = arr.unshift(1)', 'y', 3);
});

Deno.test("Array: unshift adds to front", () => {
  assertNumericResult('let arr = [2, 3]; arr.unshift(1); let y = arr[0]', 'y', 1);
});

Deno.test("Array: unshift preserves elements", () => {
  assertNumericResult('let arr = [2, 3]; arr.unshift(1); let y = arr[1]', 'y', 2);
});

Deno.test("Array: unshift to empty", () => {
  assertNumericResult('let arr = []; arr.unshift(5); let y = arr[0]', 'y', 5);
});

Deno.test("Array: multiple pushes", () => {
  assertNumericResult('let arr = []; arr.push(1); arr.push(2); arr.push(3); let y = arr.length', 'y', 3);
});

Deno.test("Array: push pop combo", () => {
  assertNumericResult('let arr = [1]; arr.push(2); let y = arr.pop()', 'y', 2);
});

// =============================================================================
// Array Non-Mutating Methods
// =============================================================================

Deno.test("Array: indexOf finds element", () => {
  assertNumericResult('let arr = [1, 2, 3]; let y = arr.indexOf(2)', 'y', 1);
});

Deno.test("Array: indexOf not found", () => {
  assertNumericResult('let arr = [1, 2, 3]; let y = arr.indexOf(5)', 'y', -1);
});

Deno.test("Array: indexOf first occurrence", () => {
  assertNumericResult('let arr = [1, 2, 2, 3]; let y = arr.indexOf(2)', 'y', 1);
});

Deno.test("Array: indexOf strings", () => {
  assertNumericResult('let arr = ["a", "b", "c"]; let y = arr.indexOf("b")', 'y', 1);
});

Deno.test("Array: indexOf works", () => {
  assertNumericResult('let arr = [1, 2, 3]; let y = arr.indexOf(2)', 'y', 1);
});

Deno.test("Array: includes true", () => {
  assertNumericResult('let arr = [1, 2, 3]; let y = arr.includes(2); if (y) { y = 1 } else { y = 0 }', 'y', 1);
});

Deno.test("Array: includes false", () => {
  assertNumericResult('let arr = [1, 2, 3]; let y = arr.includes(5); if (y) { y = 1 } else { y = 0 }', 'y', 0);
});

Deno.test("Array: slice basic", () => {
  assertNumericResult('let arr = [1, 2, 3, 4, 5]; let y = arr.slice(1, 3).length', 'y', 2);
});

Deno.test("Array: slice elements", () => {
  assertNumericResult('let arr = [1, 2, 3, 4, 5]; let s = arr.slice(1, 3); let y = s[0]', 'y', 2);
});

Deno.test("Array: slice negative start", () => {
  assertNumericResult('let arr = [1, 2, 3, 4, 5]; let y = arr.slice(-2).length', 'y', 2);
});

Deno.test("Array: slice copy", () => {
  assertNumericResult('let arr = [1, 2, 3]; let y = arr.slice().length', 'y', 3);
});

Deno.test("Array: concat arrays", () => {
  assertNumericResult('let a = [1, 2]; let b = [3, 4]; let y = a.concat(b).length', 'y', 4);
});

Deno.test("Array: concat elements", () => {
  assertNumericResult('let a = [1, 2]; let b = [3, 4]; let c = a.concat(b); let y = c[2]', 'y', 3);
});

Deno.test("Array: join default", () => {
  assertNumericResult('let arr = ["a", "b", "c"]; let y = arr.join().length', 'y', 5);
});

Deno.test("Array: join custom sep", () => {
  assertNumericResult('let arr = ["a", "b", "c"]; let y = arr.join("-").length', 'y', 5);
});

Deno.test("Array: join empty", () => {
  assertNumericResult('let arr = []; let y = arr.join(",").length', 'y', 0);
});

Deno.test("Array: join single", () => {
  assertNumericResult('let arr = ["hello"]; let y = arr.join(",").length', 'y', 5);
});

Deno.test("Array: join empty sep", () => {
  assertNumericResult('let arr = ["a", "b", "c"]; let y = arr.join("").length', 'y', 3);
});

Deno.test("Array: reverse mutates", () => {
  assertNumericResult('let arr = [1, 2, 3]; arr.reverse(); let y = arr[0]', 'y', 3);
});

Deno.test("Array: reverse returns array", () => {
  assertNumericResult('let arr = [1, 2, 3]; let y = arr.reverse()[0]', 'y', 3);
});

Deno.test("Array: reverse even length", () => {
  assertNumericResult('let arr = [1, 2, 3, 4]; arr.reverse(); let y = arr[1]', 'y', 3);
});

// =============================================================================
// Array Callback Methods - map
// =============================================================================

Deno.test("Array: map basic", () => {
  assertArrayResult('let arr = [1, 2, 3]; let y = arr.map((x) => x * 2)', 'y', [2, 4, 6]);
});

Deno.test("Array: map with index", () => {
  assertArrayResult('let arr = [10, 20, 30]; let y = arr.map((x, i) => x + i)', 'y', [10, 21, 32]);
});

Deno.test("Array: map identity", () => {
  assertArrayResult('let arr = [1, 2]; let y = arr.map((x) => x)', 'y', [1, 2]);
});

Deno.test("Array: map empty", () => {
  assertArrayResult('let arr = []; let y = arr.map((x) => x * 2)', 'y', []);
});

Deno.test("Array: map single", () => {
  assertArrayResult('let arr = [5]; let y = arr.map((x) => x + 1)', 'y', [6]);
});

// =============================================================================
// Array Callback Methods - filter
// =============================================================================

Deno.test("Array: filter basic", () => {
  assertArrayResult('let arr = [1, 2, 3, 4, 5]; let y = arr.filter((x) => x > 2)', 'y', [3, 4, 5]);
});

Deno.test("Array: filter even", () => {
  assertArrayResult('let arr = [1, 2, 3, 4, 5, 6]; let y = arr.filter((x) => x % 2 === 0)', 'y', [2, 4, 6]);
});

Deno.test("Array: filter none", () => {
  assertArrayResult('let arr = [1, 2, 3]; let y = arr.filter((x) => x > 10)', 'y', []);
});

Deno.test("Array: filter all", () => {
  assertArrayResult('let arr = [1, 2, 3]; let y = arr.filter((x) => x > 0)', 'y', [1, 2, 3]);
});

Deno.test("Array: filter empty", () => {
  assertArrayResult('let arr = []; let y = arr.filter((x) => x > 0)', 'y', []);
});

// =============================================================================
// Array Callback Methods - reduce
// =============================================================================

Deno.test("Array: reduce sum", () => {
  assertNumericResult('let arr = [1, 2, 3, 4]; let y = arr.reduce((acc, x) => acc + x, 0)', 'y', 10);
});

Deno.test("Array: reduce product", () => {
  assertNumericResult('let arr = [1, 2, 3, 4]; let y = arr.reduce((acc, x) => acc * x, 1)', 'y', 24);
});

Deno.test("Array: reduce no initial", () => {
  assertNumericResult('let arr = [1, 2, 3]; let y = arr.reduce((acc, x) => acc + x)', 'y', 6);
});

Deno.test("Array: reduce single no initial", () => {
  assertNumericResult('let arr = [42]; let y = arr.reduce((acc, x) => acc + x)', 'y', 42);
});

Deno.test("Array: reduce single with initial", () => {
  assertNumericResult('let arr = [5]; let y = arr.reduce((acc, x) => acc + x, 10)', 'y', 15);
});

Deno.test("Array: reduce empty with initial", () => {
  assertNumericResult('let arr = []; let y = arr.reduce((acc, x) => acc + x, 100)', 'y', 100);
});

// =============================================================================
// Array Callback Methods - forEach
// =============================================================================

Deno.test("Array: forEach side effect", () => {
  assertNumericResult('let total = 0; [1, 2, 3].forEach((x) => { total = total + x }); let y = total', 'y', 6);
});

Deno.test("Array: forEach returns undefined", () => {
  assertUndefinedResult('let arr = [1, 2]; let y = arr.forEach((x) => x * 2)', 'y');
});

Deno.test("Array: forEach empty", () => {
  assertNumericResult('let count = 0; [].forEach((x) => { count = count + 1 }); let y = count', 'y', 0);
});

// =============================================================================
// Callback `this` binding (default, no thisArg — see tests/fuel/this_arg_test.js for thisArg)
//
// Non-arrow callbacks must see `this === undefined` (matching plain
// top-level function-call semantics) instead of throwing "this is not
// defined". Covers both the initial callback invocation and the
// RETURN/RETURN_UNDEFINED continuation ("call again with next element")
// paths, which previously diverged.
// =============================================================================

Deno.test("Array: forEach non-arrow callback sees this === undefined, single element", () => {
  assertBooleanResult(
    'let seen = false; [1].forEach(function (x) { seen = (this === undefined); }); let y = seen',
    'y', true);
});

Deno.test("Array: forEach non-arrow callback sees this === undefined across continuation calls", () => {
  assertBooleanResult(
    'let ok = true; [1, 2, 3, 4].forEach(function (x) { if (this !== undefined) ok = false; }); let y = ok',
    'y', true);
});

Deno.test("Array: map non-arrow callback sees this === undefined", () => {
  assertBooleanResult(
    'let ok = true; [1, 2, 3].map(function (x) { if (this !== undefined) ok = false; return x; }); let y = ok',
    'y', true);
});

Deno.test("Array: filter non-arrow callback sees this === undefined", () => {
  assertBooleanResult(
    'let ok = true; [1, 2, 3].filter(function (x) { if (this !== undefined) ok = false; return true; }); let y = ok',
    'y', true);
});

Deno.test("Array: reduce non-arrow callback sees this === undefined", () => {
  assertBooleanResult(
    'let ok = true; [1, 2, 3].reduce(function (acc, x) { if (this !== undefined) ok = false; return acc; }, 0); let y = ok',
    'y', true);
});

Deno.test("Array: find/findIndex/some/every non-arrow callback sees this === undefined", () => {
  assertBooleanResult(
    `let ok = true;
     [1].find(function (x) { if (this !== undefined) ok = false; return true; });
     [1].findIndex(function (x) { if (this !== undefined) ok = false; return true; });
     [1].some(function (x) { if (this !== undefined) ok = false; return true; });
     [1].every(function (x) { if (this !== undefined) ok = false; return true; });
     let y = ok`,
    'y', true);
});

Deno.test("Array: flatMap non-arrow callback sees this === undefined", () => {
  assertBooleanResult(
    'let ok = true; [1].flatMap(function (x) { if (this !== undefined) ok = false; return [x]; }); let y = ok',
    'y', true);
});

Deno.test("Array: sort comparator sees this === undefined across multiple comparisons", () => {
  assertBooleanResult(
    'let ok = true; [5, 3, 1, 4, 2].sort(function (a, b) { if (this !== undefined) ok = false; return a - b; }); let y = ok',
    'y', true);
});

Deno.test("Array: arrow callback still inherits enclosing this (no own binding)", () => {
  assertBooleanResult(
    `let outerOk = true;
     function outer() {
       [1, 2].forEach((x) => { if (this !== undefined) outerOk = false; });
     }
     outer();
     let y = outerOk`,
    'y', true);
});

// =============================================================================
// Array Callback Methods - find
// =============================================================================

Deno.test("Array: find basic", () => {
  assertNumericResult('let arr = [1, 2, 3, 4, 5]; let y = arr.find((x) => x > 3)', 'y', 4);
});

Deno.test("Array: find first", () => {
  assertNumericResult('let arr = [10, 20, 30]; let y = arr.find((x) => x > 5)', 'y', 10);
});

Deno.test("Array: find not found", () => {
  assertUndefinedResult('let arr = [1, 2, 3]; let y = arr.find((x) => x > 10)', 'y');
});

Deno.test("Array: find empty", () => {
  assertUndefinedResult('let arr = []; let y = arr.find((x) => x > 0)', 'y');
});

// =============================================================================
// Array Callback Methods - findIndex
// =============================================================================

Deno.test("Array: findIndex basic", () => {
  assertNumericResult('let arr = [1, 2, 3, 4, 5]; let y = arr.findIndex((x) => x > 3)', 'y', 3);
});

Deno.test("Array: findIndex first", () => {
  assertNumericResult('let arr = [10, 20, 30]; let y = arr.findIndex((x) => x >= 10)', 'y', 0);
});

Deno.test("Array: findIndex not found", () => {
  assertNumericResult('let arr = [1, 2, 3]; let y = arr.findIndex((x) => x > 10)', 'y', -1);
});

Deno.test("Array: findIndex empty", () => {
  assertNumericResult('let arr = []; let y = arr.findIndex((x) => x > 0)', 'y', -1);
});

// =============================================================================
// Array Callback Methods - some
// =============================================================================

Deno.test("Array: some true", () => {
  assertBooleanResult('let arr = [1, 2, 3]; let y = arr.some((x) => x > 2)', 'y', true);
});

Deno.test("Array: some false", () => {
  assertBooleanResult('let arr = [1, 2, 3]; let y = arr.some((x) => x > 10)', 'y', false);
});

Deno.test("Array: some empty", () => {
  assertBooleanResult('let arr = []; let y = arr.some((x) => x > 0)', 'y', false);
});

Deno.test("Array: some first match", () => {
  assertBooleanResult('let arr = [10, 1, 2]; let y = arr.some((x) => x > 5)', 'y', true);
});

// =============================================================================
// Array Callback Methods - every
// =============================================================================

Deno.test("Array: every true", () => {
  assertBooleanResult('let arr = [1, 2, 3]; let y = arr.every((x) => x > 0)', 'y', true);
});

Deno.test("Array: every false", () => {
  assertBooleanResult('let arr = [1, 2, 3]; let y = arr.every((x) => x > 1)', 'y', false);
});

Deno.test("Array: every empty", () => {
  assertBooleanResult('let arr = []; let y = arr.every((x) => x > 100)', 'y', true);
});

Deno.test("Array: every first fail", () => {
  assertBooleanResult('let arr = [0, 1, 2]; let y = arr.every((x) => x > 0)', 'y', false);
});

// =============================================================================
// Array Method Chaining
// =============================================================================

Deno.test("Array: filter then map", () => {
  assertArrayResult('let arr = [1, 2, 3, 4, 5]; let y = arr.filter((x) => x % 2 === 0).map((x) => x * 10)', 'y', [20, 40]);
});

Deno.test("Array: map then filter", () => {
  assertArrayResult('let arr = [1, 2, 3]; let y = arr.map((x) => x * 2).filter((x) => x > 3)', 'y', [4, 6]);
});

// =============================================================================
// Array Callbacks with Closures
// =============================================================================

Deno.test("Array: map with closure", () => {
  assertArrayResult('let multiplier = 3; let arr = [1, 2, 3]; let y = arr.map((x) => x * multiplier)', 'y', [3, 6, 9]);
});

Deno.test("Array: reduce with closure", () => {
  assertNumericResult('let offset = 100; let arr = [1, 2, 3]; let y = arr.reduce((acc, x) => acc + x, offset)', 'y', 106);
});

// =============================================================================
// typeof array
// =============================================================================

Deno.test("Array: typeof array", () => {
  assertNumericResult('let x = typeof [1,2]; if (x === "object") { x = 1 } else { x = 0 }', 'x', 1);
});

// =============================================================================
// Variadic push / unshift / concat
// (each used to read only its first argument, silently dropping the rest)
// =============================================================================

Deno.test("Array: push with multiple arguments appends all in order", () => {
  assertNumericResult('let arr = [1]; arr.push(2, 3, 4); let y = arr.length', 'y', 4);
  assertNumericResult('let arr = [1]; arr.push(2, 3, 4); let y = arr[3]', 'y', 4);
});

Deno.test("Array: push with multiple arguments returns new length", () => {
  assertNumericResult('let arr = []; let y = arr.push(7, 8)', 'y', 2);
});

Deno.test("Array: push with no arguments returns length unchanged", () => {
  assertNumericResult('let arr = [1, 2]; let y = arr.push()', 'y', 2);
});

Deno.test("Array: push many arguments across a growth boundary", () => {
  assertNumericResult(
    'let arr = [0]; arr.push(1, 2, 3, 4, 5, 6, 7, 8, 9); let y = arr[9]', 'y', 9);
});

Deno.test("Array: unshift with multiple arguments prepends in argument order", () => {
  assertNumericResult('let arr = [9]; arr.unshift(1, 2); let y = arr.length', 'y', 3);
  assertNumericResult('let arr = [9]; arr.unshift(1, 2); let y = arr[0]', 'y', 1);
  assertNumericResult('let arr = [9]; arr.unshift(1, 2); let y = arr[1]', 'y', 2);
  assertNumericResult('let arr = [9]; arr.unshift(1, 2); let y = arr[2]', 'y', 9);
});

Deno.test("Array: unshift with multiple arguments returns new length", () => {
  assertNumericResult('let arr = [5]; let y = arr.unshift(1, 2, 3)', 'y', 4);
});

Deno.test("Array: unshift growth boundary preserves order", () => {
  assertNumericResult(
    'let arr = [8, 9]; arr.unshift(1, 2, 3, 4, 5, 6, 7); let y = arr[8]', 'y', 9);
});

Deno.test("Array: concat with multiple array arguments", () => {
  assertNumericResult('let y = [1].concat([2], [3]).length', 'y', 3);
  assertNumericResult('let y = [1].concat([2], [3])[2]', 'y', 3);
});

Deno.test("Array: concat with non-array argument appends it as an element", () => {
  assertNumericResult('let y = [1].concat(2).length', 'y', 2);
  assertNumericResult('let y = [1].concat(2)[1]', 'y', 2);
});

Deno.test("Array: concat mixes arrays and plain values", () => {
  assertNumericResult('let y = [1].concat(2, [3, 4], 5).length', 'y', 5);
  assertNumericResult('let y = [1].concat(2, [3, 4], 5)[4]', 'y', 5);
});

Deno.test("Array: concat with no arguments returns a copy", () => {
  assertNumericResult('let a = [1, 2]; let b = a.concat(); b.push(3); let y = a.length', 'y', 2);
});

/**
 * Test interpreter function declarations and arrow functions.
 *
 * Run with: deno task test tests/fuel/interpreter-functions_test.js
 */

import {
  assertNumericResult,
  assertStringResult,
  assertArrayResult,
  assertUndefinedResult,
  assertParseError,
} from './interpreter-test-utils.js';

// =============================================================================
// Arrow Functions
// =============================================================================

Deno.test("Function: arrow function creates closure", () => {
  assertNumericResult('let f = () => 42; let y = f()', 'y', 42);
});

Deno.test("Function: function expression creates closure", () => {
  assertNumericResult('let f = function() { return 42 }; let y = f()', 'y', 42);
});

Deno.test("Function: function with params", () => {
  assertNumericResult('let f = function(a, b) { return a + b }; let y = f(3, 4)', 'y', 7);
});

Deno.test("Function: function expression with closure", () => {
  assertNumericResult('let x = 10; let f = function() { return x }; let y = f()', 'y', 10);
});

// =============================================================================
// Function Declarations
// =============================================================================

Deno.test("Function: declaration basic", () => {
  assertNumericResult('function add(a, b) { return a + b; } let x = add(2, 3)', 'x', 5);
});

Deno.test("Function: declaration no params", () => {
  assertNumericResult('function greet() { return 42; } let x = greet()', 'x', 42);
});

Deno.test("Function: declaration returns string", () => {
  assertStringResult('function greet() { return "hello"; } let x = greet()', 'x', 'hello');
});

Deno.test("Function: nested function declarations", () => {
  assertNumericResult('function outer() { function inner() { return 1; } return inner(); } let x = outer()', 'x', 1);
});

Deno.test("Function: declaration with closure", () => {
  assertNumericResult('function makeAdder(x) { return (y) => x + y; } let add5 = makeAdder(5); let x = add5(3)', 'x', 8);
});

Deno.test("Function: declaration implicit return undefined", () => {
  assertUndefinedResult('function noReturn() { let x = 1; } let result = noReturn()', 'result');
});

Deno.test("Function: declaration recursive", () => {
  assertNumericResult('function fib(n) { if (n <= 1) { return n; } return fib(n - 1) + fib(n - 2); } let x = fib(6)', 'x', 8);
});

// =============================================================================
// Arrow Without Parens
// =============================================================================

Deno.test("Function: arrow without parens expression body", () => {
  assertNumericResult('let f = x => x + 1; let y = f(5)', 'y', 6);
});

Deno.test("Function: arrow without parens block body", () => {
  assertNumericResult('let f = x => { return x + 1; }; let y = f(5)', 'y', 6);
});

Deno.test("Function: arrow without parens in array map", () => {
  assertArrayResult('let arr = [1, 2, 3]; let result = arr.map(x => x * 2)', 'result', [2, 4, 6]);
});

Deno.test("Function: arrow without parens nested", () => {
  assertNumericResult('let f = x => y => x + y; let y = f(2)(3)', 'y', 5);
});

Deno.test("Function: arrow without parens with closure", () => {
  assertNumericResult('let a = 10; let f = x => x + a; let y = f(5)', 'y', 15);
});

Deno.test("Function: arrow without parens after operator is error", () => {
  assertParseError('1 + x => x', 'Unexpected');
});

// =============================================================================
// typeof function
// =============================================================================

Deno.test("Function: typeof function", () => {
  assertNumericResult('let x = typeof (() => 1); if (x === "function") { x = 1 } else { x = 0 }', 'x', 1);
});

// =============================================================================
// Optional chaining on functions
// =============================================================================

Deno.test("Function: ?.() on function", () => {
  assertNumericResult('let f = () => 42; let y = f?.()', 'y', 42);
});

Deno.test("Function: ?.() on null", () => {
  assertNumericResult('let f = null; let y = f?.(); if (y === undefined) { y = 1 } else { y = 0 }', 'y', 1);
});

// =============================================================================
// Short-circuit with functions
// =============================================================================

Deno.test("Function: AND short-circuit", () => {
  assertNumericResult('let y = 0; let f = () => { y = 1; return 1 }; let x = 0 && f(); y', 'y', 0);
});

Deno.test("Function: OR short-circuit", () => {
  assertNumericResult('let y = 0; let f = () => { y = 1; return 1 }; let x = 1 || f(); y', 'y', 0);
});

Deno.test("Function: ?? short-circuit", () => {
  assertNumericResult('let y = 0; let f = () => { y = 1; return 1 }; let x = 5 ?? f(); y', 'y', 0);
});

// =============================================================================
// Function properties
// =============================================================================

Deno.test("Function: set and get property", () => {
  assertNumericResult('let f = function() {}; f.x = 1; let y = f.x', 'y', 1);
});

Deno.test("Function: multiple properties", () => {
  assertNumericResult('let f = function() {}; f.a = 1; f.b = 2; let y = f.a + f.b', 'y', 3);
});

Deno.test("Function: property does not affect calling", () => {
  assertNumericResult('let f = function(x) { return x + 1; }; f.note = "adds one"; let y = f(5)', 'y', 6);
});

Deno.test("Function: arrow function no prototype", () => {
  assertUndefinedResult('let a = () => {}; let y = a.prototype', 'y');
});

Deno.test("Function: regular function has prototype", () => {
  assertNumericResult('let f = function() {}; let y = typeof f.prototype === "object" ? 1 : 0', 'y', 1);
});

Deno.test("Function: each function has unique prototype", () => {
  assertNumericResult('let f = function() {}; let g = function() {}; let y = f.prototype === g.prototype ? 0 : 1', 'y', 1);
});

Deno.test("Function: arrow function can have properties", () => {
  assertNumericResult('let a = () => 1; a.x = 42; let y = a.x', 'y', 42);
});

Deno.test("Function: property via bracket notation", () => {
  assertNumericResult('let f = function() {}; f["key"] = 123; let y = f["key"]', 'y', 123);
});

// =============================================================================
// Cross-function throw
// =============================================================================

Deno.test("Function: cross-function throw", () => {
  assertNumericResult(`
    let x = 0
    let f = () => {
      throw 42
    }
    try {
      f()
    } catch (e) {
      x = e
    }
  `, 'x', 42);
});

// =============================================================================
// Implicit-return epilogue (fixed 2026-07-05)
//
// The parser used to SKIP the body-end RETURN_UNDEFINED whenever the last
// emitted instruction was already a RETURN — wrong for bodies whose final
// statement is a CONDITIONAL return: the if's JUMP_IF_FALSE targets the
// body end, so with no epilogue there, control fell out of the function
// into whatever bytecode followed it (silently executing the caller's
// code, runaway recursion, or garbage results).
// =============================================================================

Deno.test("Function: body ending in a conditional return falls through to undefined", () => {
  assertStringResult(`
    function f(k) { if (k !== "a") return k; }
    let r = String(f("a")) + "|" + String(f("b"));
  `, 'r', 'undefined|b');
});

Deno.test("Function: expression form with conditional-return tail", () => {
  assertStringResult(`
    let f = function (k) { if (k === 1) return "one"; };
    let r = String(f(1)) + "|" + String(f(2));
  `, 'r', 'one|undefined');
});

Deno.test("Function: callback with conditional-return tail binds undefined, not stray code", () => {
  assertStringResult(`
    function call(cb) { return String(cb("a")); }
    let r = call(function (k) { if (k !== "a") return k; });
  `, 'r', 'undefined');
});

Deno.test("Function: nested ifs ending in returns still fall through", () => {
  assertStringResult(`
    function f(n) {
      if (n > 10) {
        if (n > 100) return "big";
        return "medium";
      }
    }
    let r = String(f(200)) + "|" + String(f(50)) + "|" + String(f(5));
  `, 'r', 'big|medium|undefined');
});

// =============================================================================
// Parameter defaults referencing earlier parameters (F1, fixed 2026-07-05).
// Any default triggers two-phase forward binding: args stash into hidden
// temps, then bind in declaration order so defaults see earlier params.
// =============================================================================

Deno.test("Function: default references earlier parameter", () => {
  assertNumericResult(`function f(a, b = a) { return a + b; } let r = f(7);`, 'r', 14);
});

Deno.test("Function: chained defaults reference multiple earlier params", () => {
  assertNumericResult(`function f(a, b = a * 2, c = a + b) { return c; } let r = f(3);`, 'r', 9);
});

Deno.test("Function: default referencing a later parameter throws", () => {
  assertStringResult(`
    function f(a = b, b) { return a; }
    let r = ""; try { f(); } catch (e) { r = "threw"; }
  `, 'r', 'threw');
});

Deno.test("Function: defaults evaluate in declaration order", () => {
  assertStringResult(`
    let log = [];
    function f(a = log.push("a"), b = log.push("b")) {}
    f();
    let r = log.join(",");
  `, 'r', 'a,b');
});

Deno.test("Function: arrow expression-body defaults see earlier params", () => {
  assertNumericResult(`let f = (a, b = a + 1) => a + b; let r = f(5);`, 'r', 11);
});

// =============================================================================
// Rest parameter with a destructuring target (F6, fixed 2026-07-05).
// =============================================================================

Deno.test("Function: rest array pattern", () => {
  assertNumericResult(`function f(...[a, b]) { return a + b; } let r = f(3, 4);`, 'r', 7);
});

Deno.test("Function: rest object pattern reads the rest array's properties", () => {
  assertNumericResult(`function f(...{length}) { return length; } let r = f(9, 9, 9);`, 'r', 3);
});

Deno.test("Function: rest pattern after fixed and defaulted params", () => {
  assertNumericResult(`
    function f(a = 1, ...[b = 10]) { return a + b; }
    let r = f() + f(2, 3) * 100;
  `, 'r', 511);
});

Deno.test("Function: arrow rest pattern (expression body)", () => {
  assertNumericResult(`let f = (...[a, b]) => a * b; let r = f(3, 4);`, 'r', 12);
});

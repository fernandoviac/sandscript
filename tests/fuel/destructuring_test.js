/**
 * Slice 4 — destructuring (array + object) in:
 *   - declaration form: let/const/var [a, b] = expr
 *   - assignment form:  [a, b] = expr  and  ({a, b} = expr)
 *   - function parameters: function f([a, b], { c, d }) {}
 *   - for-of heads: for (const [k, v] of map)
 *
 * Coverage matrix per the plan: 8 surface combinations across array
 * vs object × declaration vs assignment × with/without defaults ×
 * with/without rest, plus nested, plus negative cases.
 */

import { assertEquals, assert } from "https://deno.land/std@0.208.0/assert/mod.ts";
import { parseAndSetup } from './test-helpers.js';
import { freshSession } from '../../src/host-owned-session.js';

function run(source) {
  const session = freshSession();
  parseAndSetup(session, source);
  const result = session.run(0, 10_000_000);
  if (result.status === 'error') {
    throw new Error(`Error: ${result.error.message}`);
  }
  return session;
}

// =============================================================================
// Array destructuring — declaration
// =============================================================================

Deno.test("array decl: plain identifiers", () => {
  const s = run(`let [a, b, c] = [1, 2, 3];`);
  assertEquals(s.get(0, 'a'), 1);
  assertEquals(s.get(0, 'b'), 2);
  assertEquals(s.get(0, 'c'), 3);
});

Deno.test("array decl: const works", () => {
  const s = run(`const [a, b] = [10, 20];`);
  assertEquals(s.get(0, 'a'), 10);
  assertEquals(s.get(0, 'b'), 20);
});

Deno.test("array decl: var works", () => {
  const s = run(`var [a, b] = [10, 20];`);
  assertEquals(s.get(0, 'a'), 10);
  assertEquals(s.get(0, 'b'), 20);
});

Deno.test("array decl: source has fewer elements; extras bind undefined", () => {
  const s = run(`let [a, b, c] = [10];`);
  assertEquals(s.get(0, 'a'), 10);
  assertEquals(s.get(0, 'b'), undefined);
  assertEquals(s.get(0, 'c'), undefined);
});

Deno.test("array decl: source has more elements; extras ignored", () => {
  const s = run(`let [a, b] = [1, 2, 3, 4];`);
  assertEquals(s.get(0, 'a'), 1);
  assertEquals(s.get(0, 'b'), 2);
});

Deno.test("array decl: defaults fire on undefined", () => {
  const s = run(`let [a = 99, b = 88, c = 77] = [10];`);
  assertEquals(s.get(0, 'a'), 10);
  assertEquals(s.get(0, 'b'), 88);
  assertEquals(s.get(0, 'c'), 77);
});

Deno.test("array decl: defaults do NOT fire on null (only undefined)", () => {
  const s = run(`let [a = 99, b = 88] = [null, undefined];`);
  assertEquals(s.get(0, 'a'), null);
  assertEquals(s.get(0, 'b'), 88);
});

Deno.test("array decl: holes skip iterator values without binding", () => {
  const s = run(`let [a, , c] = [1, 2, 3];`);
  assertEquals(s.get(0, 'a'), 1);
  assertEquals(s.get(0, 'c'), 3);
});

Deno.test("array decl: rest collects remaining elements", () => {
  const s = run(`
    let [a, b, ...rest] = [1, 2, 3, 4, 5];
    let len = rest.length;
    let r0 = rest[0]; let r1 = rest[1]; let r2 = rest[2];
  `);
  assertEquals(s.get(0, 'a'), 1);
  assertEquals(s.get(0, 'b'), 2);
  assertEquals(s.get(0, 'len'), 3);
  assertEquals(s.get(0, 'r0'), 3);
  assertEquals(s.get(0, 'r1'), 4);
  assertEquals(s.get(0, 'r2'), 5);
});

Deno.test("array decl: rest of an empty remainder yields []", () => {
  const s = run(`
    let [a, b, ...rest] = [1, 2];
    let len = rest.length;
  `);
  assertEquals(s.get(0, 'a'), 1);
  assertEquals(s.get(0, 'b'), 2);
  assertEquals(s.get(0, 'len'), 0);
});

Deno.test("array decl: nested array pattern", () => {
  const s = run(`let [[a, b], c] = [[1, 2], 3];`);
  assertEquals(s.get(0, 'a'), 1);
  assertEquals(s.get(0, 'b'), 2);
  assertEquals(s.get(0, 'c'), 3);
});

Deno.test("array decl: triple-nested array pattern", () => {
  const s = run(`let [[[a]], b] = [[[42]], 100];`);
  assertEquals(s.get(0, 'a'), 42);
  assertEquals(s.get(0, 'b'), 100);
});

Deno.test("array decl: works with user-defined iterables", () => {
  const s = run(`
    let iter = {};
    iter[Symbol.iterator] = function() {
      let i = 0;
      return { next: function() {
        if (i < 3) { let v = i; i = i + 1; return { value: v * 10, done: false }; }
        return { value: undefined, done: true };
      } };
    };
    let [a, b, c] = iter;
  `);
  assertEquals(s.get(0, 'a'), 0);
  assertEquals(s.get(0, 'b'), 10);
  assertEquals(s.get(0, 'c'), 20);
});

Deno.test("array decl: destructuring non-iterable throws catchable TypeError", () => {
  const s = run(`
    let caught = null;
    try { let [a] = 42; } catch (e) { caught = e.message; }
  `);
  assertEquals(s.get(0, 'caught'), 'Not iterable');
});

Deno.test("array decl: destructuring null names the iteration, not a property read", () => {
  const s = run(`
    let caught = null;
    try { let [a] = null; } catch (e) { caught = e.message; }
  `);
  assertEquals(s.get(0, 'caught'), 'Not iterable');
});

Deno.test("array decl: nested pattern over a non-iterable element throws Not iterable", () => {
  const s = run(`
    let caught = null;
    try { let [[a]] = [42]; } catch (e) { caught = e.message; }
  `);
  assertEquals(s.get(0, 'caught'), 'Not iterable');
});

Deno.test("array assign: destructuring non-iterable throws Not iterable", () => {
  const s = run(`
    let a; let caught = null;
    try { [a] = 42; } catch (e) { caught = e.message; }
  `);
  assertEquals(s.get(0, 'caught'), 'Not iterable');
});

// =============================================================================
// Array destructuring — assignment
// =============================================================================

Deno.test("array assign: basic", () => {
  const s = run(`
    let a, b;
    [a, b] = [10, 20];
  `);
  assertEquals(s.get(0, 'a'), 10);
  assertEquals(s.get(0, 'b'), 20);
});

Deno.test("array assign: classic swap", () => {
  const s = run(`
    let a = 1, b = 2;
    [a, b] = [b, a];
  `);
  assertEquals(s.get(0, 'a'), 2);
  assertEquals(s.get(0, 'b'), 1);
});

Deno.test("array assign: defaults still work", () => {
  const s = run(`
    let a, b;
    [a = 99, b = 88] = [10];
  `);
  assertEquals(s.get(0, 'a'), 10);
  assertEquals(s.get(0, 'b'), 88);
});

Deno.test("array assign: rest still works", () => {
  const s = run(`
    let a, b, rest;
    [a, b, ...rest] = [1, 2, 3, 4];
    let r0 = rest[0]; let r1 = rest[1];
  `);
  assertEquals(s.get(0, 'a'), 1);
  assertEquals(s.get(0, 'b'), 2);
  assertEquals(s.get(0, 'r0'), 3);
  assertEquals(s.get(0, 'r1'), 4);
});

Deno.test("array assign: array literals on the RHS still parse normally", () => {
  // Sanity check: the cover-grammar machinery doesn't break ordinary
  // array literals on the RHS or wherever else they appear.
  const s = run(`
    let arr = [1, 2, 3];
    let len = arr.length;
    let copy = [arr[0], arr[1], arr[2]];
    let copyLen = copy.length;
  `);
  assertEquals(s.get(0, 'len'), 3);
  assertEquals(s.get(0, 'copyLen'), 3);
});

// =============================================================================
// Object destructuring — declaration
// =============================================================================

Deno.test("object decl: shorthand", () => {
  const s = run(`let { a, b } = { a: 10, b: 20 };`);
  assertEquals(s.get(0, 'a'), 10);
  assertEquals(s.get(0, 'b'), 20);
});

Deno.test("object decl: renaming", () => {
  const s = run(`let { a: x, b: y } = { a: 10, b: 20 };`);
  assertEquals(s.get(0, 'x'), 10);
  assertEquals(s.get(0, 'y'), 20);
});

Deno.test("object decl: computed key", () => {
  const s = run(`
    let key = 'foo';
    let { [key]: v } = { foo: 42 };
  `);
  assertEquals(s.get(0, 'v'), 42);
});

Deno.test("object decl: defaults fire on undefined", () => {
  const s = run(`let { a = 99, b = 88 } = { a: 10 };`);
  assertEquals(s.get(0, 'a'), 10);
  assertEquals(s.get(0, 'b'), 88);
});

Deno.test("object decl: defaults do NOT fire on null", () => {
  const s = run(`let { a = 99, b = 88 } = { a: null, b: undefined };`);
  assertEquals(s.get(0, 'a'), null);
  assertEquals(s.get(0, 'b'), 88);
});

Deno.test("object decl: renaming with default", () => {
  const s = run(`let { a: x = 99, b: y = 88 } = { a: 10 };`);
  assertEquals(s.get(0, 'x'), 10);
  assertEquals(s.get(0, 'y'), 88);
});

Deno.test("object decl: rest collects remaining own enumerable string keys", () => {
  const s = run(`
    let { a, ...rest } = { a: 1, b: 2, c: 3 };
    let rb = rest.b; let rc = rest.c;
    let ra = rest.a;  // should be undefined — already bound to a
  `);
  assertEquals(s.get(0, 'a'), 1);
  assertEquals(s.get(0, 'rb'), 2);
  assertEquals(s.get(0, 'rc'), 3);
  assertEquals(s.get(0, 'ra'), undefined);
});

Deno.test("object decl: nested object pattern", () => {
  const s = run(`let { a: { x, y } } = { a: { x: 1, y: 2 } };`);
  assertEquals(s.get(0, 'x'), 1);
  assertEquals(s.get(0, 'y'), 2);
});

Deno.test("object decl: mixed array + object nesting", () => {
  const s = run(`
    let { items: [first, second], total } = {
      items: [10, 20, 30],
      total: 60,
    };
  `);
  assertEquals(s.get(0, 'first'), 10);
  assertEquals(s.get(0, 'second'), 20);
  assertEquals(s.get(0, 'total'), 60);
});

Deno.test("object decl: destructuring null throws catchable TypeError", () => {
  const s = run(`
    let caught = null;
    try { let { a } = null; } catch (e) { caught = e.message; }
  `);
  assertEquals(s.get(0, 'caught'), 'Cannot read property of null');
});

// =============================================================================
// Object destructuring — assignment
// =============================================================================

Deno.test("object assign: parens required at statement start", () => {
  const s = run(`
    let a, b;
    ({ a, b } = { a: 10, b: 20 });
  `);
  assertEquals(s.get(0, 'a'), 10);
  assertEquals(s.get(0, 'b'), 20);
});

Deno.test("object assign: renaming + defaults", () => {
  const s = run(`
    let x, y;
    ({ a: x = 99, b: y = 88 } = { a: 10 });
  `);
  assertEquals(s.get(0, 'x'), 10);
  assertEquals(s.get(0, 'y'), 88);
});

Deno.test("object assign: object literals on the RHS still parse normally", () => {
  // Sanity: the cover-grammar machinery doesn't break ordinary
  // object literals.
  const s = run(`
    let obj = { a: 1, b: 2 };
    let copy = { x: obj.a, y: obj.b };
    let sum = copy.x + copy.y;
  `);
  assertEquals(s.get(0, 'sum'), 3);
});

// =============================================================================
// Function parameters
// =============================================================================

Deno.test("function param: array pattern", () => {
  const s = run(`
    function sum([a, b, c]) { return a + b + c; }
    let r = sum([10, 20, 30]);
  `);
  assertEquals(s.get(0, 'r'), 60);
});

Deno.test("function param: object pattern", () => {
  const s = run(`
    function greet({ name, age }) { return name + ':' + age; }
    let r = greet({ name: 'alice', age: 30 });
  `);
  assertEquals(s.get(0, 'r'), 'alice:30');
});

Deno.test("function param: object pattern with renaming", () => {
  const s = run(`
    function key({ id: i, name: n }) { return i + '/' + n; }
    let r = key({ id: 7, name: 'x' });
  `);
  assertEquals(s.get(0, 'r'), '7/x');
});

Deno.test("function param: nested pattern", () => {
  const s = run(`
    function f({ items: [first, second] }) { return first + second; }
    let r = f({ items: [10, 20] });
  `);
  assertEquals(s.get(0, 'r'), 30);
});

Deno.test("function param: pattern with outer default + inner default", () => {
  const s = run(`
    function f({ a = 99 } = {}) { return a; }
    let r1 = f();
    let r2 = f({});
    let r3 = f({ a: 5 });
  `);
  assertEquals(s.get(0, 'r1'), 99);  // outer default fires; inner default fires on the resulting {}.a
  assertEquals(s.get(0, 'r2'), 99);  // outer skipped; inner default fires on {}.a
  assertEquals(s.get(0, 'r3'), 5);   // both skipped
});

Deno.test("function param: multiple destructured parameters", () => {
  const s = run(`
    function combine([a, b], { c, d }) { return a + b + c + d; }
    let r = combine([1, 2], { c: 3, d: 4 });
  `);
  assertEquals(s.get(0, 'r'), 10);
});

// =============================================================================
// for-of with patterns
// =============================================================================

Deno.test("for-of: array pattern in head", () => {
  const s = run(`
    let total = 0;
    for (let [a, b] of [[1, 2], [10, 20], [100, 200]]) {
      total = total + a * 1000 + b;
    }
  `);
  // 1002 + 10020 + 100200 = 111222
  assertEquals(s.get(0, 'total'), 111222);
});

Deno.test("for-of: object pattern in head", () => {
  const s = run(`
    let names = '';
    for (let { name } of [{ name: 'a' }, { name: 'b' }, { name: 'c' }]) {
      names = names + name;
    }
  `);
  assertEquals(s.get(0, 'names'), 'abc');
});

Deno.test("for-of: object pattern with renaming", () => {
  const s = run(`
    let users = [
      { id: 1, name: 'alice' },
      { id: 2, name: 'bob' },
    ];
    let result = '';
    for (let { id: i, name: n } of users) {
      result = result + i + ':' + n + ',';
    }
  `);
  assertEquals(s.get(0, 'result'), '1:alice,2:bob,');
});

Deno.test("for-of: array pattern with defaults", () => {
  const s = run(`
    let total = 0;
    for (let [a, b = 100] of [[1], [10, 20], [50]]) {
      total = total + a + b;
    }
  `);
  // (1 + 100) + (10 + 20) + (50 + 100) = 101 + 30 + 150 = 281
  assertEquals(s.get(0, 'total'), 281);
});

// =============================================================================
// Closures over destructured bindings
// =============================================================================

Deno.test("destructured bindings can be captured in closures", () => {
  const s = run(`
    function makeAdder([a, b]) {
      return function() { return a + b; };
    }
    let add = makeAdder([10, 20]);
    let r = add();
  `);
  assertEquals(s.get(0, 'r'), 30);
});

// =============================================================================
// Destructuring-assignment expression value (JS spec: evaluates to RHS)
// =============================================================================

Deno.test("array assign: expression evaluates to the RHS", () => {
  const s = run(`
    let a, b;
    let raw = ([a, b] = [10, 20]);
    let r0 = raw[0]; let r1 = raw[1]; let len = raw.length;
  `);
  assertEquals(s.get(0, 'a'), 10);
  assertEquals(s.get(0, 'b'), 20);
  assertEquals(s.get(0, 'len'), 2);
  assertEquals(s.get(0, 'r0'), 10);
  assertEquals(s.get(0, 'r1'), 20);
});

Deno.test("object assign: expression evaluates to the RHS", () => {
  const s = run(`
    let a, b;
    let raw = ({ a, b } = { a: 10, b: 20 });
    let ra = raw.a; let rb = raw.b;
  `);
  assertEquals(s.get(0, 'a'), 10);
  assertEquals(s.get(0, 'b'), 20);
  assertEquals(s.get(0, 'ra'), 10);
  assertEquals(s.get(0, 'rb'), 20);
});

Deno.test("destructuring assignment can chain via the RHS value", () => {
  const s = run(`
    let a, b, c;
    a = ([b, c] = [1, 2]);
    let a0 = a[0]; let a1 = a[1];
  `);
  assertEquals(s.get(0, 'b'), 1);
  assertEquals(s.get(0, 'c'), 2);
  assertEquals(s.get(0, 'a0'), 1);
  assertEquals(s.get(0, 'a1'), 2);
});

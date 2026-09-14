/**
 * 2b.1 — Array.freeze / Array.isFrozen + Object.freeze / Object.isFrozen.
 *
 * Object.freeze existed internally (setObjectFrozen) since day one but was
 * not user-callable. Array.freeze is brand new — needed a flags field added
 * to the Array heap layout at offset 20.
 *
 * Frozen arrays refuse: a[i] = v, push, pop, shift, unshift, reverse.
 * Frozen objects refuse: o.k = v.
 * Reads on frozen containers (a[i], a.length, a.slice, Object.keys) work.
 * freeze() returns the same container for chaining.
 */

import { assertEquals, assert, assertThrows } from "https://deno.land/std@0.208.0/assert/mod.ts";
import { createSession } from '../../src/fuel/session.js';
import { parseAndSetup } from './test-helpers.js';
import { freshSession } from '../../src/host-owned-session.js';
import { UncaughtScriptError } from '../../src/runtime/errors.js';

function expectError(source) {
  const session = freshSession();
  parseAndSetup(session, source);
  assertThrows(() => session.run(0, 1000000), UncaughtScriptError);
}

function run(source) {
  const session = freshSession();
  parseAndSetup(session, source);
  session.run(0, 1000000);
  return session;
}

// Array.freeze / Array.isFrozen

Deno.test("Array.isFrozen: false on a fresh array", () => {
  assertEquals(run(`let a = [1, 2, 3]; let x = Array.isFrozen(a);`).get(0, 'x'), false);
});

Deno.test("Array.freeze then isFrozen: true", () => {
  assertEquals(
    run(`let a = [1, 2, 3]; Array.freeze(a); let x = Array.isFrozen(a);`).get(0, 'x'),
    true
  );
});

Deno.test("Array.freeze returns the same array", () => {
  assertEquals(
    run(`let a = [1, 2]; let b = Array.freeze(a); let x = a === b;`).get(0, 'x'),
    true
  );
});

Deno.test("Array.isFrozen: false on a non-array returns false", () => {
  assertEquals(run(`let x = Array.isFrozen({a: 1});`).get(0, 'x'), false);
  assertEquals(run(`let x = Array.isFrozen(42);`).get(0, 'x'), false);
  assertEquals(run(`let x = Array.isFrozen('string');`).get(0, 'x'), false);
});

// Frozen arrays reject mutation

Deno.test("Frozen array: index assignment throws", () => {
  expectError(`let a = [1, 2]; Array.freeze(a); a[0] = 99;`);
});

Deno.test("Frozen array: push throws", () => {
  expectError(`let a = [1, 2]; Array.freeze(a); a.push(3);`);
});

Deno.test("Frozen array: pop throws", () => {
  expectError(`let a = [1, 2]; Array.freeze(a); a.pop();`);
});

Deno.test("Frozen array: shift throws", () => {
  expectError(`let a = [1, 2]; Array.freeze(a); a.shift();`);
});

Deno.test("Frozen array: unshift throws", () => {
  expectError(`let a = [1, 2]; Array.freeze(a); a.unshift(0);`);
});

Deno.test("Frozen array: reverse throws", () => {
  expectError(`let a = [1, 2]; Array.freeze(a); a.reverse();`);
});

// Frozen arrays allow read

Deno.test("Frozen array: index read works", () => {
  assertEquals(run(`let a = [1, 2, 3]; Array.freeze(a); let x = a[0];`).get(0, 'x'), 1);
});

Deno.test("Frozen array: .length works", () => {
  assertEquals(run(`let a = [1, 2, 3]; Array.freeze(a); let x = a.length;`).get(0, 'x'), 3);
});

Deno.test("Frozen array: .slice() works (returns unfrozen copy)", () => {
  const session = run(`let a = [1, 2, 3]; Array.freeze(a); let b = a.slice(1); let x = Array.isFrozen(b);`);
  assertEquals(session.get(0, 'x'), false);
});

Deno.test("Frozen array: .concat() works", () => {
  const session = run(`let a = [1, 2]; Array.freeze(a); let b = a.concat([3, 4]); let x = b.length;`);
  assertEquals(session.get(0, 'x'), 4);
});

Deno.test("Frozen array: .indexOf() works", () => {
  assertEquals(
    run(`let a = [10, 20, 30]; Array.freeze(a); let x = a.indexOf(20);`).get(0, 'x'),
    1
  );
});

// Object.freeze / Object.isFrozen (user-callable now)

Deno.test("Object.isFrozen: false on a fresh object", () => {
  assertEquals(run(`let o = {a: 1}; let x = Object.isFrozen(o);`).get(0, 'x'), false);
});

Deno.test("Object.freeze then isFrozen: true", () => {
  assertEquals(
    run(`let o = {a: 1}; Object.freeze(o); let x = Object.isFrozen(o);`).get(0, 'x'),
    true
  );
});

Deno.test("Object.freeze: property assignment throws", () => {
  expectError(`let o = {a: 1}; Object.freeze(o); o.a = 99;`);
});

Deno.test("Object.freeze: new property assignment throws", () => {
  expectError(`let o = {a: 1}; Object.freeze(o); o.b = 2;`);
});

Deno.test("Object.freeze returns the same object", () => {
  assertEquals(
    run(`let o = {a: 1}; let p = Object.freeze(o); let x = o === p;`).get(0, 'x'),
    true
  );
});

Deno.test("Object.isFrozen: true for primitives (JS spec)", () => {
  // Non-objects are 'trivially frozen' per JS spec — they can't be mutated.
  assertEquals(run(`let x = Object.isFrozen(42);`).get(0, 'x'), true);
  assertEquals(run(`let x = Object.isFrozen('hello');`).get(0, 'x'), true);
  assertEquals(run(`let x = Object.isFrozen(true);`).get(0, 'x'), true);
});

// Object.freeze works on arrays (JS parity — previously a silent no-op)

Deno.test("Object.freeze on array: isFrozen flips, both APIs agree", () => {
  const session = run(`
    let a = [1, 2]
    let before = Object.isFrozen(a)
    Object.freeze(a)
    let viaObject = Object.isFrozen(a)
    let viaArray = Array.isFrozen(a)
  `);
  assertEquals(session.get(0, 'before'), false);
  assertEquals(session.get(0, 'viaObject'), true);
  assertEquals(session.get(0, 'viaArray'), true);
});

Deno.test("Object.freeze on array: index assignment throws", () => {
  expectError(`let a = [1, 2]; Object.freeze(a); a[0] = 99;`);
});

Deno.test("Object.freeze on array: push throws", () => {
  expectError(`let a = [1, 2]; Object.freeze(a); a.push(3);`);
});

Deno.test("Object.freeze on array: symbol-key assignment throws", () => {
  expectError(`let k = Symbol("k"); let a = [1]; Object.freeze(a); a[k] = 9;`);
});

Deno.test("Object.freeze on array: returns the same array, reads work", () => {
  const session = run(`let a = [7, 8]; let b = Object.freeze(a); let same = a === b; let x = a[1];`);
  assertEquals(session.get(0, 'same'), true);
  assertEquals(session.get(0, 'x'), 8);
});

Deno.test("Object.isFrozen: false on a fresh array (not 'trivially frozen')", () => {
  assertEquals(run(`let x = Object.isFrozen([1, 2]);`).get(0, 'x'), false);
});

Deno.test("Object.freeze: primitive argument passes through", () => {
  assertEquals(run(`let x = Object.freeze(42);`).get(0, 'x'), 42);
});

// Frozen object still reads

Deno.test("Frozen object: property read works", () => {
  assertEquals(run(`let o = {a: 42}; Object.freeze(o); let x = o.a;`).get(0, 'x'), 42);
});

Deno.test("Frozen object: Object.keys works", () => {
  const session = run(`let o = {a: 1, b: 2}; Object.freeze(o); let x = Object.keys(o);`);
  assertEquals(session.get(0, 'x'), ['a', 'b']);
});

// Freeze is idempotent

Deno.test("Array.freeze is idempotent", () => {
  assertEquals(
    run(`let a = [1]; Array.freeze(a); Array.freeze(a); let x = Array.isFrozen(a);`).get(0, 'x'),
    true
  );
});

Deno.test("Object.freeze is idempotent", () => {
  assertEquals(
    run(`let o = {a: 1}; Object.freeze(o); Object.freeze(o); let x = Object.isFrozen(o);`).get(0, 'x'),
    true
  );
});

// Array.freeze on non-array throws TypeError

Deno.test("Array.freeze: non-array argument throws", () => {
  expectError(`let x = Array.freeze({a: 1});`);
});

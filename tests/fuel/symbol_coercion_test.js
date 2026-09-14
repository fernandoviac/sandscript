/**
 * 2a.4 — Symbol coercion rules (JS-spec-conformant).
 *
 * Implicit coercion (+, -, Number()) throws TypeError. Explicit String(sym)
 * calls toString(). Boolean(sym) returns true.
 *
 * JS spec reference:
 *   - Symbol + anything → TypeError (Symbol refuses ToPrimitive with hint 'default')
 *   - Number(sym) / -sym → TypeError (ToNumber on Symbol)
 *   - String(sym) → "Symbol(desc)" (explicit ToString calls .toString())
 *   - Boolean(sym) → true (ToBoolean on any non-null object is true)
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

// Implicit addition (+) rejects Symbol on either side.

Deno.test("Symbol coercion: Symbol + Number throws", () => {
  expectError(`let x = Symbol('x') + 1;`);
});

Deno.test("Symbol coercion: Number + Symbol throws", () => {
  expectError(`let x = 1 + Symbol('x');`);
});

Deno.test("Symbol coercion: Symbol + String throws (no silent stringify)", () => {
  expectError(`let x = Symbol('x') + '!';`);
});

Deno.test("Symbol coercion: String + Symbol throws (no silent stringify)", () => {
  expectError(`let x = '!' + Symbol('x');`);
});

Deno.test("Symbol coercion: Symbol + Symbol throws", () => {
  expectError(`let x = Symbol('a') + Symbol('b');`);
});

// Explicit numeric coercion also rejects Symbol.

Deno.test("Symbol coercion: Number(Symbol) throws", () => {
  expectError(`let x = Number(Symbol('x'));`);
});

Deno.test("Symbol coercion: unary minus on Symbol throws", () => {
  expectError(`let x = -Symbol('x');`);
});

// Explicit String() is spec-allowed and calls toString().

Deno.test("Symbol coercion: String(Symbol('x')) → 'Symbol(x)'", () => {
  assertEquals(run(`let x = String(Symbol('x'));`).get(0, 'x'), 'Symbol(x)');
});

Deno.test("Symbol coercion: String(Symbol()) → 'Symbol()'", () => {
  assertEquals(run(`let x = String(Symbol());`).get(0, 'x'), 'Symbol()');
});

Deno.test("Symbol coercion: String(Symbol.for('key')) → 'Symbol(key)'", () => {
  assertEquals(run(`let x = String(Symbol.for('key'));`).get(0, 'x'), 'Symbol(key)');
});

// Boolean is always true (any non-null/undefined object is truthy).

Deno.test("Symbol coercion: Boolean(Symbol) → true", () => {
  assertEquals(run(`let x = Boolean(Symbol('x'));`).get(0, 'x'), true);
});

Deno.test("Symbol coercion: Boolean(Symbol()) → true (undescribed still truthy)", () => {
  assertEquals(run(`let x = Boolean(Symbol());`).get(0, 'x'), true);
});

Deno.test("Symbol coercion: Boolean(Symbol.for('empty')) → true", () => {
  assertEquals(run(`let x = Boolean(Symbol.for('empty'));`).get(0, 'x'), true);
});

// Symbols in boolean contexts directly — truthy.

Deno.test("Symbol coercion: Symbol is truthy in if-condition", () => {
  assertEquals(
    run(`let s = Symbol('x'); let x = s ? 'yes' : 'no';`).get(0, 'x'),
    'yes'
  );
});

Deno.test("Symbol coercion: undescribed Symbol is truthy in if-condition", () => {
  assertEquals(
    run(`let s = Symbol(); let x = s ? 'yes' : 'no';`).get(0, 'x'),
    'yes'
  );
});

// Boolean-like operators work (logical ops use ToBoolean).

Deno.test("Symbol coercion: Symbol in && — right side wins", () => {
  assertEquals(
    run(`let s = Symbol('x'); let x = s && 42;`).get(0, 'x'),
    42
  );
});

Deno.test("Symbol coercion: Symbol in || — left side wins (truthy)", () => {
  assertEquals(
    run(`let s = Symbol('x'); let x = s || 42;`).get(0, 'x').description,
    'x'
  );
});

// Explicit !sym does ToBoolean then negate.

Deno.test("Symbol coercion: !Symbol is false", () => {
  assertEquals(run(`let x = !Symbol('x');`).get(0, 'x'), false);
});

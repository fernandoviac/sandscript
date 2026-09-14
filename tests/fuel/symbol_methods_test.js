/**
 * 2a.3 — Symbol .description property and .toString() method.
 *
 * .description returns the Symbol's description string, or undefined for an
 * undescribed Symbol (constructed via Symbol() with no argument).
 * .toString() returns "Symbol(description)" or "Symbol()" for undescribed,
 * matching the JS spec format.
 * Unknown property access on a Symbol returns undefined (Symbols don't
 * expose arbitrary properties).
 */

import { assertEquals } from "https://deno.land/std@0.208.0/assert/mod.ts";
import { createSession } from '../../src/fuel/session.js';
import { parseAndSetup } from './test-helpers.js';
import { freshSession } from '../../src/host-owned-session.js';

function run(source) {
  const session = freshSession();
  parseAndSetup(session, source);
  const result = session.run(0, 1000000);
  if (result.status === 'error') {
    throw new Error(`Error: ${result.error.message}`);
  }
  return session;
}

// .description

Deno.test("Symbol.description: returns description for fresh Symbol", () => {
  assertEquals(run(`let s = Symbol('x'); let x = s.description;`).get(0, 'x'), 'x');
});

Deno.test("Symbol.description: returns description for registered Symbol", () => {
  assertEquals(run(`let s = Symbol.for('hello'); let x = s.description;`).get(0, 'x'), 'hello');
});

Deno.test("Symbol.description: returns undefined for undescribed Symbol", () => {
  assertEquals(run(`let s = Symbol(); let x = s.description;`).get(0, 'x'), undefined);
});

Deno.test("Symbol.description: handles multi-byte descriptions", () => {
  assertEquals(run(`let s = Symbol('αβγ'); let x = s.description;`).get(0, 'x'), 'αβγ');
});

Deno.test("Symbol.description: handles empty-string description", () => {
  assertEquals(run(`let s = Symbol(''); let x = s.description;`).get(0, 'x'), '');
});

// .toString()

Deno.test("Symbol.toString(): 'Symbol(description)' for described", () => {
  assertEquals(run(`let s = Symbol('x'); let x = s.toString();`).get(0, 'x'), 'Symbol(x)');
});

Deno.test("Symbol.toString(): 'Symbol()' for undescribed", () => {
  assertEquals(run(`let s = Symbol(); let x = s.toString();`).get(0, 'x'), 'Symbol()');
});

Deno.test("Symbol.toString(): works on registered Symbols", () => {
  assertEquals(run(`let s = Symbol.for('abc'); let x = s.toString();`).get(0, 'x'), 'Symbol(abc)');
});

Deno.test("Symbol.toString(): handles empty-string description", () => {
  assertEquals(run(`let s = Symbol(''); let x = s.toString();`).get(0, 'x'), 'Symbol()');
});

// Unknown property → undefined

Deno.test("Symbol: unknown property returns undefined", () => {
  assertEquals(run(`let s = Symbol('x'); let x = s.foo;`).get(0, 'x'), undefined);
});

Deno.test("Symbol: .constructor returns undefined (not yet supported)", () => {
  // Documenting that full Symbol.prototype.constructor is not wired — a
  // separate JS-parity concern. Symbols only expose .description and
  // .toString() in Ring 2.
  assertEquals(run(`let s = Symbol('x'); let x = s.constructor;`).get(0, 'x'), undefined);
});

// Method reference is a bound method

Deno.test("Symbol.toString: accessing without calling returns a function", () => {
  // s.toString is a bound method; typeof reports 'function'.
  assertEquals(run(`let s = Symbol('x'); let x = typeof s.toString;`).get(0, 'x'), 'function');
});

/**
 * 2a.2 — Symbol() constructor, Symbol.for registry, typeof 'symbol', identity.
 *
 * Covers the language-level surface: calling Symbol / Symbol.for / Symbol.keyFor
 * from SandScript source, checking typeof, and verifying identity semantics
 * (fresh Symbols are always distinct; registry-backed Symbols are canonical).
 */

import { assertEquals, assert, assertThrows } from "https://deno.land/std@0.208.0/assert/mod.ts";
import { createSession } from '../../src/fuel/session.js';
import { parseAndSetup } from './test-helpers.js';
import { freshSession } from '../../src/host-owned-session.js';
import { UncaughtScriptError } from '../../src/runtime/errors.js';

function run(source) {
  const session = freshSession();
  parseAndSetup(session, source);
  session.run(0, 1000000);
  return session;
}

// typeof

Deno.test("Symbol: typeof Symbol('x') === 'symbol'", () => {
  assertEquals(run(`let x = typeof Symbol('x');`).get(0, 'x'), 'symbol');
});

Deno.test("Symbol: typeof Symbol() === 'symbol'", () => {
  assertEquals(run(`let x = typeof Symbol();`).get(0, 'x'), 'symbol');
});

Deno.test("Symbol: typeof Symbol.for('x') === 'symbol'", () => {
  assertEquals(run(`let x = typeof Symbol.for('x');`).get(0, 'x'), 'symbol');
});

// Fresh Symbol identity

Deno.test("Symbol: two fresh Symbols with same description are distinct", () => {
  assertEquals(
    run(`let a = Symbol('x'); let b = Symbol('x'); let x = a === b;`).get(0, 'x'),
    false
  );
});

Deno.test("Symbol: two fresh Symbols without description are distinct", () => {
  assertEquals(
    run(`let a = Symbol(); let b = Symbol(); let x = a === b;`).get(0, 'x'),
    false
  );
});

Deno.test("Symbol: a fresh Symbol is equal to itself", () => {
  assertEquals(
    run(`let s = Symbol('x'); let x = s === s;`).get(0, 'x'),
    true
  );
});

// Registry identity

Deno.test("Symbol.for: two calls with same key return the same Symbol", () => {
  assertEquals(
    run(`let a = Symbol.for('x'); let b = Symbol.for('x'); let x = a === b;`).get(0, 'x'),
    true
  );
});

Deno.test("Symbol.for: different keys produce distinct Symbols", () => {
  assertEquals(
    run(`let a = Symbol.for('x'); let b = Symbol.for('y'); let x = a === b;`).get(0, 'x'),
    false
  );
});

Deno.test("Symbol.for: a registered Symbol is never equal to a fresh one", () => {
  assertEquals(
    run(`let a = Symbol('x'); let b = Symbol.for('x'); let x = a === b;`).get(0, 'x'),
    false
  );
});

// Symbol.keyFor

Deno.test("Symbol.keyFor: returns the key for a registered Symbol", () => {
  assertEquals(
    run(`let a = Symbol.for('hello'); let x = Symbol.keyFor(a);`).get(0, 'x'),
    'hello'
  );
});

Deno.test("Symbol.keyFor: returns undefined for a fresh Symbol", () => {
  assertEquals(
    run(`let a = Symbol('world'); let x = Symbol.keyFor(a);`).get(0, 'x'),
    undefined
  );
});

Deno.test("Symbol.keyFor: key survives round-trip", () => {
  assertEquals(
    run(`
      let s = Symbol.for('roundtrip');
      let k = Symbol.keyFor(s);
      let s2 = Symbol.for(k);
      let x = s === s2;
    `).get(0, 'x'),
    true
  );
});

// Readback shape

Deno.test("Symbol readback: session.getExact returns structured with description", () => {
  const session = run(`let s = Symbol('myAtom');`);
  assertEquals(session.getExact(0, 's'), {
    kind: 'symbol',
    description: 'myAtom',
    registered: false,
  });
});

Deno.test("Symbol readback: registry-backed flag is true for Symbol.for", () => {
  const session = run(`let s = Symbol.for('registered');`);
  assertEquals(session.getExact(0, 's'), {
    kind: 'symbol',
    description: 'registered',
    registered: true,
  });
});

Deno.test("Symbol readback: undescribed Symbol reads as description=undefined", () => {
  const session = run(`let s = Symbol();`);
  assertEquals(session.getExact(0, 's'), {
    kind: 'symbol',
    description: undefined,
    registered: false,
  });
});

// Cross-scope registry survival

Deno.test("Symbol registry: values survive across statement boundaries", () => {
  const session = run(`
    let a = Symbol.for('persist');
    // Other work here that might have triggered GC
    let b = Symbol.for('persist');
    let x = a === b;
  `);
  assertEquals(session.get(0, 'x'), true);
});

// Invalid argument types

Deno.test("Symbol.for: throws TypeError on non-string key", () => {
  const session = freshSession();
  parseAndSetup(session, `let x = Symbol.for(42);`);
  assertThrows(() => session.run(0, 1000000), UncaughtScriptError);
});

Deno.test("Symbol.keyFor: throws TypeError on non-Symbol argument", () => {
  const session = freshSession();
  parseAndSetup(session, `let x = Symbol.keyFor('not a symbol');`);
  assertThrows(() => session.run(0, 1000000), UncaughtScriptError);
});

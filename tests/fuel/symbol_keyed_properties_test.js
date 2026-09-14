/**
 * Slice 1 — Symbol-keyed properties and well-known symbols.
 *
 * Verifies the iterator-protocol prerequisites:
 *   1. Symbol.iterator and Symbol.asyncIterator exist as fresh, eager,
 *      non-registry-backed well-known symbols on the Symbol constructor.
 *   2. obj[someSymbol] = value and obj[someSymbol] round-trip on plain
 *      objects and functions.
 *   3. Symbol-keyed methods are inherited through the prototype chain.
 *   4. obj[someSymbol]() invokes the method correctly.
 *   5. Symbol-keyed properties survive GC (snapshot mark + compaction
 *      walker).
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
// Well-known symbols
// =============================================================================

Deno.test("Symbol.iterator exists and is a symbol", () => {
  assertEquals(run(`let x = typeof Symbol.iterator;`).get(0, 'x'), 'symbol');
});

Deno.test("Symbol.asyncIterator exists and is a symbol", () => {
  assertEquals(run(`let x = typeof Symbol.asyncIterator;`).get(0, 'x'), 'symbol');
});

Deno.test("Symbol.iterator is stable across accesses (identity)", () => {
  assertEquals(
    run(`let x = Symbol.iterator === Symbol.iterator;`).get(0, 'x'),
    true
  );
});

Deno.test("Symbol.asyncIterator is stable across accesses (identity)", () => {
  assertEquals(
    run(`let x = Symbol.asyncIterator === Symbol.asyncIterator;`).get(0, 'x'),
    true
  );
});

Deno.test("Symbol.iterator !== Symbol.asyncIterator", () => {
  assertEquals(
    run(`let x = Symbol.iterator === Symbol.asyncIterator;`).get(0, 'x'),
    false
  );
});

Deno.test("Symbol.iterator is NOT registry-backed: distinct from Symbol.for('Symbol.iterator')", () => {
  // Spec-correct: well-known symbols are their own identities, separate
  // from any registry entry with a matching description.
  assertEquals(
    run(`let x = Symbol.iterator === Symbol.for('Symbol.iterator');`).get(0, 'x'),
    false
  );
});

Deno.test("Symbol.asyncIterator is NOT registry-backed: distinct from Symbol.for('Symbol.asyncIterator')", () => {
  assertEquals(
    run(`let x = Symbol.asyncIterator === Symbol.for('Symbol.asyncIterator');`).get(0, 'x'),
    false
  );
});

// =============================================================================
// Symbol-keyed property round-trip on plain objects
// =============================================================================

Deno.test("symbol key: set and get with Symbol.iterator", () => {
  assertEquals(
    run(`
      let obj = {};
      obj[Symbol.iterator] = 42;
      let x = obj[Symbol.iterator];
    `).get(0, 'x'),
    42
  );
});

Deno.test("symbol key: set and get with a user-minted symbol", () => {
  assertEquals(
    run(`
      let s = Symbol('mykey');
      let obj = {};
      obj[s] = 'hello';
      let x = obj[s];
    `).get(0, 'x'),
    'hello'
  );
});

Deno.test("symbol key: unset symbol key returns undefined", () => {
  assertEquals(
    run(`
      let s = Symbol('absent');
      let obj = {};
      let x = obj[s];
    `).get(0, 'x'),
    undefined
  );
});

Deno.test("symbol key: distinct symbols with same description are distinct keys", () => {
  assertEquals(
    run(`
      let a = Symbol('k');
      let b = Symbol('k');
      let obj = {};
      obj[a] = 1;
      obj[b] = 2;
      let x = obj[a] + obj[b] * 10;
    `).get(0, 'x'),
    21
  );
});

Deno.test("symbol key: update existing symbol-keyed property in place", () => {
  assertEquals(
    run(`
      let s = Symbol('x');
      let obj = {};
      obj[s] = 1;
      obj[s] = 2;
      obj[s] = 3;
      let x = obj[s];
    `).get(0, 'x'),
    3
  );
});

Deno.test("symbol key: many symbol-keyed properties (capacity growth)", () => {
  // Initial sym-block capacity is 4. Push past it to exercise grow.
  assertEquals(
    run(`
      let obj = {};
      let symbols = [];
      let i = 0;
      while (i < 12) {
        symbols[i] = Symbol('s' + i);
        obj[symbols[i]] = i * 10;
        i = i + 1;
      }
      // Read back the 8th one (well past the initial 4-cap).
      let x = obj[symbols[8]];
    `).get(0, 'x'),
    80
  );
});

Deno.test("symbol key: string and symbol keys coexist on the same object", () => {
  assertEquals(
    run(`
      let s = Symbol('x');
      let obj = { foo: 1, bar: 2 };
      obj[s] = 99;
      // Both maps function independently.
      let x = obj.foo + obj.bar * 10 + obj[s] * 100;
    `).get(0, 'x'),
    9921
  );
});

// =============================================================================
// Symbol-keyed properties on functions
// =============================================================================

Deno.test("symbol key: function carries its own symbol-keyed properties", () => {
  assertEquals(
    run(`
      let s = Symbol('tag');
      function f() {}
      f[s] = 'tagged';
      let x = f[s];
    `).get(0, 'x'),
    'tagged'
  );
});

// =============================================================================
// Prototype-chain lookup for symbol-keyed properties
// =============================================================================

Deno.test("symbol key: inherited from prototype", () => {
  // Use the constructor + new idiom to install a prototype, since
  // Object.create is not yet in sandscript.
  assertEquals(
    run(`
      let s = Symbol('inherited');
      function Ctor() {}
      Ctor.prototype[s] = 'from-proto';
      let obj = new Ctor();
      let x = obj[s];
    `).get(0, 'x'),
    'from-proto'
  );
});

Deno.test("symbol key: own property shadows prototype", () => {
  assertEquals(
    run(`
      let s = Symbol('shadow');
      function Ctor() {}
      Ctor.prototype[s] = 'proto';
      let obj = new Ctor();
      obj[s] = 'own';
      let x = obj[s];
    `).get(0, 'x'),
    'own'
  );
});

// =============================================================================
// Method invocation via symbol-keyed access
// =============================================================================

Deno.test("symbol key: method call via obj[Symbol]() works", () => {
  assertEquals(
    run(`
      let s = Symbol('callme');
      let obj = {};
      obj[s] = function() { return 7; };
      let x = obj[s]();
    `).get(0, 'x'),
    7
  );
});

Deno.test("symbol key: method on prototype, called via instance", () => {
  assertEquals(
    run(`
      let s = Symbol('greet');
      function Ctor() {}
      Ctor.prototype[s] = function() { return 'hi'; };
      let obj = new Ctor();
      let x = obj[s]();
    `).get(0, 'x'),
    'hi'
  );
});

// =============================================================================
// GC survival
// =============================================================================

Deno.test("symbol key: properties survive GC", () => {
  // Read-back must use the same `obj` and the same `s1`/`s2` bindings
  // to prove that the relocated symbol-pointer keys still match. Use
  // a custom GC builtin if one is exposed via globalThis.gc(); otherwise
  // do the gc + read in a single parsed unit by stashing readbacks into
  // top-level variables and then calling session.gc() — but that runs
  // the GC *after* the read, defeating the test.
  //
  // Workaround: drive GC mid-execution by parsing a script that does the
  // setup, then re-running fresh code with the *same* lexical scope after
  // calling session.gc() — append-and-set-PC pattern used by the
  // gc_shrink_alignment test.
  const session = freshSession();
  const memImg = session.airlock.memoryImage;

  parseAndSetup(session, `
    let s1 = Symbol('persist1');
    let s2 = Symbol('persist2');
    let obj = {};
    obj[s1] = 100;
    obj[s2] = 'two-hundred';
  `);
  let r = session.run(0, 10_000_000);
  if (r.status === 'error') throw new Error(JSON.stringify(r.error));

  session.gc();

  // Append additional code and resume from its start.
  const parseResult = session.parse(`
    let a = obj[s1];
    let b = obj[s2];
  `);
  memImg.setContextInstructionIndex(0, parseResult.startIndex);
  r = session.run(0, 10_000_000);
  if (r.status === 'error') throw new Error(JSON.stringify(r.error));

  assertEquals(session.get(0, 'a'), 100);
  assertEquals(session.get(0, 'b'), 'two-hundred');
});

Deno.test("Symbol.iterator survives GC and stays identity-equal", () => {
  const session = freshSession();
  parseAndSetup(session, `
    let before = Symbol.iterator;
  `);
  session.run(0, 10_000_000);
  session.gc();
  parseAndSetup(session, `
    let after = Symbol.iterator;
    let same = before === after;
  `);
  session.run(0, 10_000_000);
  assertEquals(session.get(0, 'same'), true);
});

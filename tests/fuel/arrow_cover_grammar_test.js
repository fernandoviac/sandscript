/**
 * Cluster 3 — arrow function cover-grammar.
 *
 * The arrow grouping path (`grouping()` in parser.js) used to do
 * single-token lookahead to decide between `(expr)` and `(params) =>`.
 * That couldn't handle destructuring patterns, defaults, computed
 * keys, or async-arrow variants. The new dispatch skims ahead to the
 * matching `)`, peeks for `=>`, and routes through `parseFunctionParams`
 * — the same shared parser used by function declarations.
 *
 * This enables destructuring parameters in the idiomatic arrow shapes used
 * by stream adapters.
 *
 * Also fixes a parallel pre-existing gap: string-keyed pattern keys
 * (`{ 'x-y': v }`) now work in all destructuring contexts. The arrow
 * cover-grammar work brought this case into reach via the arrow
 * surface; the fix is a one-line addition to `objectPatternBind`.
 */

import { assertEquals, assertMatch, assertThrows } from "https://deno.land/std@0.208.0/assert/mod.ts";
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

function parseOnly(source) {
  return freshSession().parse(source);
}

// =============================================================================
// Arrow parameter destructuring
// =============================================================================

Deno.test("arrow: object pattern parameter", () => {
  const s = run(`let f = ({a, b}) => a + b; let r = f({a: 10, b: 20});`);
  assertEquals(s.get(0, 'r'), 30);
});

Deno.test("arrow: array pattern parameter", () => {
  const s = run(`let f = ([a, b]) => a * b; let r = f([4, 5]);`);
  assertEquals(s.get(0, 'r'), 20);
});

Deno.test("arrow: object pattern with rename", () => {
  const s = run(`let f = ({a: x, b: y}) => x - y; let r = f({a: 50, b: 8});`);
  assertEquals(s.get(0, 'r'), 42);
});

Deno.test("arrow: pattern with default", () => {
  const s = run(`
    let f = ({a = 99} = {}) => a;
    let r1 = f();
    let r2 = f({});
    let r3 = f({a: 5});
  `);
  assertEquals(s.get(0, 'r1'), 99);
  assertEquals(s.get(0, 'r2'), 99);
  assertEquals(s.get(0, 'r3'), 5);
});

Deno.test("arrow: mixed plain and destructured params", () => {
  const s = run(`let f = (x, [a, b]) => x + a + b; let r = f(100, [10, 20]);`);
  assertEquals(s.get(0, 'r'), 130);
});

Deno.test("arrow: nested patterns", () => {
  const s = run(`
    let f = ({a: {x}, b: [y, z]}) => x + y + z;
    let r = f({a: {x: 1}, b: [2, 3]});
  `);
  assertEquals(s.get(0, 'r'), 6);
});

// =============================================================================
// Arrow with parameter defaults (plain identifier)
// =============================================================================

Deno.test("arrow: plain-ident default", () => {
  const s = run(`let f = (a, b = 100) => a + b; let r = f(5);`);
  assertEquals(s.get(0, 'r'), 105);
});

Deno.test("arrow: multiple defaults", () => {
  const s = run(`
    let f = (a = 1, b = 2, c = 3) => a + b + c;
    let r1 = f();
    let r2 = f(10);
    let r3 = f(10, 20, 30);
  `);
  assertEquals(s.get(0, 'r1'), 6);
  assertEquals(s.get(0, 'r2'), 15);
  assertEquals(s.get(0, 'r3'), 60);
});

// =============================================================================
// Arrow with rest parameter (already worked since Cluster 1; re-pin here)
// =============================================================================

Deno.test("arrow: bare rest parameter", () => {
  const s = run(`let f = (...rest) => rest.length; let r = f(1, 2, 3, 4);`);
  assertEquals(s.get(0, 'r'), 4);
});

Deno.test("arrow: rest after fixed param", () => {
  const s = run(`let f = (x, ...rest) => x + rest.length; let r = f(100, 1, 2, 3);`);
  assertEquals(s.get(0, 'r'), 103);
});

// =============================================================================
// Async arrow with patterns and defaults
// =============================================================================

Deno.test("async arrow: object pattern parses", () => {
  parseOnly(`let f = async ({a}) => a;`);
});

Deno.test("async arrow: pattern with default parses", () => {
  parseOnly(`let f = async ({a = 99} = {}) => a;`);
});

Deno.test("async arrow: plain default parses", () => {
  parseOnly(`let f = async (a, b = 100) => a + b;`);
});

Deno.test("async arrow: rest parameter parses", () => {
  parseOnly(`let f = async (...rest) => rest.length;`);
});

// =============================================================================
// Computed and string keys in arrow patterns
// =============================================================================

Deno.test("arrow: computed key in object pattern", () => {
  const s = run(`let k = 'a'; let f = ({[k]: v}) => v; let r = f({a: 7, b: 8});`);
  assertEquals(s.get(0, 'r'), 7);
});

Deno.test("arrow: string-keyed pattern entry", () => {
  const s = run(`let f = ({'x-y': v}) => v; let r = f({'x-y': 42});`);
  assertEquals(s.get(0, 'r'), 42);
});

Deno.test("string-keyed pattern: in declaration", () => {
  const s = run(`let { 'x-y': v } = { 'x-y': 7 }; let r = v;`);
  assertEquals(s.get(0, 'r'), 7);
});

Deno.test("string-keyed pattern: in function param", () => {
  const s = run(`
    function f({ 'x-y': v }) { return v; }
    let r = f({ 'x-y': 7 });
  `);
  assertEquals(s.get(0, 'r'), 7);
});

Deno.test("string-keyed pattern: in for-of", () => {
  const s = run(`
    let total = 0;
    for (const { 'x-y': v } of [{'x-y': 1}, {'x-y': 2}, {'x-y': 3}]) {
      total = total + v;
    }
  `);
  assertEquals(s.get(0, 'total'), 6);
});

// =============================================================================
// Nested arrows — cover-grammar must handle nesting
// =============================================================================

Deno.test("nested arrow: outer plain, inner destructured", () => {
  const s = run(`let f = (x) => ({a}) => x + a; let r = f(100)({a: 5});`);
  assertEquals(s.get(0, 'r'), 105);
});

Deno.test("nested arrow: outer destructured, inner plain", () => {
  const s = run(`let f = ({x}) => (y) => x + y; let r = f({x: 100})(5);`);
  assertEquals(s.get(0, 'r'), 105);
});

Deno.test("nested arrow: both destructured", () => {
  const s = run(`let f = ({a}) => ({b}) => a + b; let r = f({a: 1})({b: 2});`);
  assertEquals(s.get(0, 'r'), 3);
});

// =============================================================================
// Non-arrow grouping must still work (regression guards)
// =============================================================================

Deno.test("grouping: arithmetic in parens", () => {
  const s = run(`let r = (3 + 4);`);
  assertEquals(s.get(0, 'r'), 7);
});

Deno.test("grouping: paren'd object literal", () => {
  const s = run(`let r = ({a: 5}); let v = r.a;`);
  assertEquals(s.get(0, 'v'), 5);
});

Deno.test("grouping: paren'd array literal", () => {
  const s = run(`let r = ([1, 2, 3]); let v = r[1];`);
  assertEquals(s.get(0, 'v'), 2);
});

Deno.test("grouping: assignment expression in parens", () => {
  const s = run(`let x = 0; let r = (x = 10);`);
  assertEquals(s.get(0, 'r'), 10);
  assertEquals(s.get(0, 'x'), 10);
});

Deno.test("grouping: compound assignment in parens", () => {
  const s = run(`let x = 5; let r = (x += 3);`);
  assertEquals(s.get(0, 'r'), 8);
  assertEquals(s.get(0, 'x'), 8);
});

Deno.test("grouping: comma expression in parens", () => {
  // The cover-grammar work newly enables `(x, y, z)` as a comma
  // expression at expression position. The legacy single-token
  // lookahead erroneously interpreted any comma as arrow params.
  const s = run(`let r = (1, 2, 3);`);
  assertEquals(s.get(0, 'r'), 3);
});

Deno.test("grouping: single ident no parens arrow", () => {
  const s = run(`let f = x => x + 1; let r = f(5);`);
  assertEquals(s.get(0, 'r'), 6);
});

Deno.test("grouping: empty parens arrow", () => {
  const s = run(`let f = () => 42; let r = f();`);
  assertEquals(s.get(0, 'r'), 42);
});

// =============================================================================
// Regression: cover-grammar skim must not suppress the real error
// =============================================================================

// The arrow cover-grammar dispatch speculatively skims to the matching `)`
// to check for `=>`. skimBalanced() throws via error(), which latches
// hadError=true before throwing. The catch here swallows that exception and
// falls through to the normal expression path — but hadError was never
// reset, so the real parse error below got suppressed by error()'s
// cascading-suppression guard (`if (this.hadError) return`), and only a
// generic, location-less fallback message ever reached the caller.
Deno.test("grouping: unbalanced parens report the real error with line/col", () => {
  const err = assertThrows(() => parseOnly("let x = (10\n"));
  assertMatch(err.message, /Expected '\)' after expression/);
  assertMatch(err.message, /line 2, col 1/);
});

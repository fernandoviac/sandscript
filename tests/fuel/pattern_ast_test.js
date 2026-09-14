/**
 * Destructuring pattern AST fidelity in AST format v2.
 *
 * Patterns are real AST nodes: ARRAY_PATTERN / OBJECT_PATTERN (carrying
 * the declaration initializer or parameter default as a child) built
 * from PATTERN_ELEMENT entries (name, key node, nested pattern, default,
 * rest/hole/shorthand flags). getSource() round-trips destructuring
 * declarations, pattern parameters, rest patterns, and for-of patterns;
 * the printed form re-parses to the same printed form (fixpoint).
 */

import { assertEquals, assert } from "https://deno.land/std@0.208.0/assert/mod.ts";
import { freshSession } from '../../src/host-owned-session.js';

function printedSource(source) {
  const session = freshSession({ inlineSource: true });
  session.parse(source);
  return session.getSource().trim();
}

function assertFixpoint(source) {
  // Pre-existing (pattern-unrelated) quirk: statements ending in `}` print
  // with a trailing `;`, which reparses as one extra EMPTY_STMT — strip
  // lone `;` lines before comparing so the fixpoint check isolates the
  // pattern printing itself.
  const stripEmpty = (text) =>
    text.split('\n').filter((line) => line.trim() !== ';').join('\n').trim();
  const once = printedSource(source);
  const twice = printedSource(once);
  assertEquals(stripEmpty(twice), stripEmpty(once),
    `print → reparse → print is not a fixpoint for: ${source}`);
  return once;
}

Deno.test("pattern AST: object pattern round-trips", () => {
  assertEquals(assertFixpoint(`let { a, b } = src;`), 'let { a, b } = src;');
});

Deno.test("pattern AST: renaming, defaults, string and numeric keys", () => {
  assertEquals(
    assertFixpoint(`let { a: x, b = 2, 'k-2': y, 0: zeroth } = src;`),
    `let { a: x, b = 2, "k-2": y, "0": zeroth } = src;`);
});

Deno.test("pattern AST: array pattern with holes, defaults, and rest", () => {
  assertEquals(
    assertFixpoint(`const [first, , third] = arr;`),
    'const [first,, third] = arr;');
  assertEquals(
    assertFixpoint(`let [a, b = 1, ...rest] = arr;`),
    'let [a, b = 1, ...rest] = arr;');
});

Deno.test("pattern AST: object rest and nesting", () => {
  assertEquals(assertFixpoint(`let { a, ...others } = src;`), 'let { a, ...others } = src;');
  assertEquals(assertFixpoint(`let { outer: { inner } } = src;`), 'let { outer: { inner } } = src;');
  assertEquals(assertFixpoint(`let [[x, y], z] = pairs;`), 'let [[x, y], z] = pairs;');
});

Deno.test("pattern AST: computed keys", () => {
  assertEquals(assertFixpoint(`let { [key]: value } = src;`), 'let { [key]: value } = src;');
});

Deno.test("pattern AST: pattern parameters and rest patterns print", () => {
  const printed = assertFixpoint(`function f({ a, b = 1 }, [c], ...rest) { return a; }`);
  assert(printed.includes('function f({ a, b = 1 }, [c], ...rest)'), printed);
});

Deno.test("pattern AST: arrow pattern parameter with default", () => {
  const printed = assertFixpoint(`let g = ({ x } = {}) => x;`);
  assert(printed.includes('({ x } = {})'), printed);
});

Deno.test("pattern AST: rest parameter with pattern target", () => {
  const printed = assertFixpoint(`function h(...[p, q]) { return p; }`);
  assert(printed.includes('h(...[p, q])'), printed);
});

Deno.test("pattern AST: for-of patterns keep the declaration keyword", () => {
  const printed = assertFixpoint(`for (const [k, v] of pairs) { use(k); }`);
  assert(printed.includes('for (const [k, v] of pairs)'), printed);
  const letPrinted = assertFixpoint(`for (let { id } of rows) { use(id); }`);
  assert(letPrinted.includes('for (let { id } of rows)'), letPrinted);
});

Deno.test("pattern AST: printed declarations still execute correctly", () => {
  const session = freshSession({ inlineSource: true });
  session.parse(`
    let src = { a: 1, b: 2, deep: { c: 3 } };
    let { a, b: renamed = 0, deep: { c } } = src;
    let [x, , z = 9, ...tail] = [10, 20, undefined, 30, 40];
    let summary = a + renamed + c + x + z + tail.length;
  `);
  session.run(0, 10_000_000);
  assertEquals(session.get(0, 'summary'), 1 + 2 + 3 + 10 + 9 + 2);

  const reprinted = session.getSource();
  const session2 = freshSession({ inlineSource: true });
  session2.parse(reprinted);
  session2.run(0, 10_000_000);
  assertEquals(session2.get(0, 'summary'), 1 + 2 + 3 + 10 + 9 + 2);
});

Deno.test("for-in AST: declaration keyword round-trips", () => {
  const constPrinted = assertFixpoint(`for (const k in obj) { use(k); }`);
  assert(constPrinted.includes('for (const k in obj)'), constPrinted);
  const letPrinted = assertFixpoint(`for (let k in obj) { use(k); }`);
  assert(letPrinted.includes('for (let k in obj)'), letPrinted);
});

/**
 * Tests for ESM-style export syntax and invokeExport.
 *
 * Run with: deno task test tests/fuel/export_test.js
 */

import { assertEquals, assertExists, assert, assertThrows } from "https://deno.land/std@0.208.0/assert/mod.ts";
import { createSession } from '../../src/fuel/session.js';
import { freshSession, snapshotSession, restoreSession } from '../../src/host-owned-session.js';

function parseAndSetup(session, source, slot = 0) {
  const result = session.parse(source);
  session.mem.setContextInstructionIndex(slot, result.startIndex);
  session.mem.clearExitCondition(slot);
  return result;
}

// =============================================================================
// Phase 1: Export Syntax
// =============================================================================

Deno.test("Export: export const", () => {
  const session = freshSession();
  session.parse('export const add = (x, y) => x + y');
  session.run(0, 10000);

  const exports = session.exports();
  assertEquals(exports.size, 1);
  assert(exports.has('add'));
  assertEquals(exports.get('add').type, 'const');
});

Deno.test("Export: export let", () => {
  const session = freshSession();
  session.parse('export let counter = 0');
  session.run(0, 10000);

  const exports = session.exports();
  assertEquals(exports.size, 1);
  assert(exports.has('counter'));
  assertEquals(exports.get('counter').type, 'let');
});

Deno.test("Export: export function", () => {
  const session = freshSession();
  session.parse('export function multiply(x, y) { return x * y }');
  session.run(0, 10000);

  const exports = session.exports();
  assertEquals(exports.size, 1);
  assert(exports.has('multiply'));
  assertEquals(exports.get('multiply').type, 'function');
});

Deno.test("Export: export var (alias for let)", () => {
  const session = freshSession();
  session.parse('export var x = 42');
  session.run(0, 10000);

  const exports = session.exports();
  assertEquals(exports.size, 1);
  assert(exports.has('x'));
  assertEquals(exports.get('x').type, 'let');
});

Deno.test("Export: multiple exports", () => {
  const session = freshSession();
  session.parse(`
    export const add = (x, y) => x + y
    const internal = 42
    export function greet(name) { return "Hello, " + name }
  `);
  session.run(0, 10000);

  const exports = session.exports();
  assertEquals(exports.size, 2);
  assert(exports.has('add'));
  assert(exports.has('greet'));
  assert(!exports.has('internal'));
});

Deno.test("Export: comma-separated const", () => {
  const session = freshSession();
  session.parse('export const a = 1, b = 2, c = 3');
  session.run(0, 10000);

  const exports = session.exports();
  assertEquals(exports.size, 3);
  assert(exports.has('a'));
  assert(exports.has('b'));
  assert(exports.has('c'));
  assertEquals(session.get(0, 'a'), 1);
  assertEquals(session.get(0, 'b'), 2);
  assertEquals(session.get(0, 'c'), 3);
});

Deno.test("Export: exported values are accessible via get()", () => {
  const session = freshSession();
  session.parse('export const PI = 3.14159');
  session.run(0, 10000);

  assertEquals(session.get(0, 'PI'), 3.14159);
});

Deno.test("Export: export has no runtime effect", () => {
  const session = freshSession();
  session.parse(`
    export const x = 10
    let y = x + 5
  `);
  session.run(0, 10000);

  assertEquals(session.get(0, 'x'), 10);
  assertEquals(session.get(0, 'y'), 15);
});

Deno.test("Export: export async function", () => {
  const session = freshSession();
  session.parse('export async function fetchData() { return 42 }');
  session.run(0, 10000);

  const exports = session.exports();
  assertEquals(exports.size, 1);
  assert(exports.has('fetchData'));
  assertEquals(exports.get('fetchData').type, 'function');
});

// =============================================================================
// Export Errors
// =============================================================================

Deno.test("Export: error on export without declaration", () => {
  const session = freshSession();
  assertThrows(() => session.parse('export 42'));
});

Deno.test("Export: error on export inside function", () => {
  const session = freshSession();
  assertThrows(() => session.parse('function f() { export const x = 1 }'));
});

Deno.test("Export: error on export inside block", () => {
  const session = freshSession();
  assertThrows(() => session.parse('if (true) { export const x = 1 }'));
});

Deno.test("Export: error on export inside for loop", () => {
  const session = freshSession();
  assertThrows(() => session.parse('for (let i = 0; i < 1; i++) { export const x = 1 }'));
});

// =============================================================================
// Phase 2: invokeExport
// =============================================================================

Deno.test("invokeExport: basic function call", () => {
  const session = freshSession();
  session.parse('export const add = (x, y) => x + y');
  session.run(0, 10000);

  const slot = session.invokeExport('add', [5, 3]);
  const result = session.run(slot, 10000);
  assertEquals(result.status, 'done');
});

Deno.test("invokeExport: error on non-exported name", () => {
  const session = freshSession();
  session.parse('const secret = 42');
  session.run(0, 10000);

  assertThrows(
    () => session.invokeExport('secret', []),
    Error,
    'not exported',
  );
});

Deno.test("invokeExport: error on nonexistent name", () => {
  const session = freshSession();
  session.parse('export const x = 1');
  session.run(0, 10000);

  assertThrows(
    () => session.invokeExport('nonexistent', []),
    Error,
    'not exported',
  );
});

Deno.test("invokeExport: named function declaration", () => {
  const session = freshSession();
  session.parse('export function double(x) { return x * 2 }');
  session.run(0, 10000);

  const slot = session.invokeExport('double', [7]);
  const result = session.run(slot, 10000);
  assertEquals(result.status, 'done');
});


// =============================================================================
// Export persistence across snapshot/restore
//
// Export declarations persist as AST v4 FN_EXPORTED/VAR_EXPORTED flags;
// restore rebuilds the authoritative map from the persisted AST, so
// invokeExport keeps working on restored, patch-swapped, and respawned
// drones. Requires inlineSource — without the AST region no program
// metadata persists at all.
// =============================================================================

Deno.test("Export restore: invokeExport survives snapshot/restore", () => {
  const session = freshSession({ inlineSource: true });
  session.parse('export function applyInput(value) { return value }');
  session.run(0, 10000);

  // Works before persistence.
  const liveSlot = session.invokeExport('applyInput', [1]);
  assertEquals(session.run(liveSlot, 10000).status, 'done');
  session.mem.freeContext(liveSlot);

  const { vatBytes, membraneBytes } = snapshotSession(session);
  const restored = restoreSession(vatBytes, membraneBytes);

  const exports = restored.exports();
  assertEquals(exports.size, 1);
  assertEquals(exports.get('applyInput').type, 'function');

  const slot = restored.invokeExport('applyInput', [1]);
  assertEquals(restored.run(slot, 10000).status, 'done');
});

Deno.test("Export restore: every declaration type keeps its recorded type", () => {
  const session = freshSession({ inlineSource: true });
  session.parse('export const add = (x, y) => x + y');
  session.parse('export let counter = 0');
  session.parse('export var legacy = 1');
  session.parse('export async function fetchData() { return 7 }');
  session.parse('export const a = 1, b = 2');
  session.run(0, 100000);

  const { vatBytes, membraneBytes } = snapshotSession(session);
  const restored = restoreSession(vatBytes, membraneBytes);

  const expected = new Map([
    ['add', 'const'], ['counter', 'let'], ['legacy', 'let'],
    ['fetchData', 'function'], ['a', 'const'], ['b', 'const'],
  ]);
  const exports = restored.exports();
  assertEquals(exports.size, expected.size);
  for (const [name, type] of expected) {
    assertEquals(exports.get(name)?.type, type, `export '${name}'`);
  }
});

Deno.test("Export restore: non-exported root bindings stay non-exported", () => {
  const session = freshSession({ inlineSource: true });
  session.parse('export function visible() { return 1 }\nfunction hidden() { return 2 }\nconst secret = 3');
  session.run(0, 10000);

  const { vatBytes, membraneBytes } = snapshotSession(session);
  const restored = restoreSession(vatBytes, membraneBytes);

  assertEquals(restored.exports().size, 1);
  assertThrows(() => restored.invokeExport('hidden', []), Error, 'not exported');
  assertThrows(() => restored.invokeExport('secret', []), Error, 'not exported');
});

Deno.test("Export restore: getSource round-trips the export keyword", () => {
  const session = freshSession({ inlineSource: true });
  session.parse('export function double(x) { return x * 2 }');
  session.parse('export const rate = 3');
  session.parse('let internal = 4');
  session.run(0, 100000);

  const { vatBytes, membraneBytes } = snapshotSession(session);
  const restored = restoreSession(vatBytes, membraneBytes);
  const source = restored.getSource();
  assert(source.includes('export function double'), source);
  assert(source.includes('export const rate'), source);
  assert(!source.includes('export let internal'), source);

  // The reconstruction parses back to the same export surface.
  const reparsed = freshSession({ inlineSource: true });
  reparsed.parse(source);
  assertEquals([...reparsed.exports().keys()].sort(), ['double', 'rate']);
});

Deno.test("Export restore: later parses accumulate onto the rebuilt map", () => {
  const session = freshSession({ inlineSource: true });
  session.parse('export const first = 1');
  session.run(0, 10000);

  const { vatBytes, membraneBytes } = snapshotSession(session);
  const restored = restoreSession(vatBytes, membraneBytes);
  restored.parse('export const second = 2');

  assertEquals([...restored.exports().keys()].sort(), ['first', 'second']);
});
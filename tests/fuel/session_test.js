/**
 * Test script for fuel session API.
 *
 * Run with: deno task test tests/fuel/session_test.js
 */

import { assertEquals, assertExists, assert, assertThrows } from "https://deno.land/std@0.208.0/assert/mod.ts";
import { createSession } from '../../src/fuel/session.js';
import { freshSession } from '../../src/host-owned-session.js';
// Helper to parse and set up execution state
function parseAndSetup(session, source, slot = 0) {
  const result = session.parse(source);
  session.mem.setContextInstructionIndex(slot, result.startIndex);
  session.mem.clearExitCondition(slot);
  return result;
}

// =============================================================================
// Basic API
// =============================================================================

Deno.test("Session: basic execution", () => {
  const session = freshSession();
  session.parse('let result = 1 + 2');
  session.run(0, 10000);
  assertEquals(session.get(0, 'result'), 3);
});

Deno.test("Session: variable persistence across exec calls", () => {
  const session = freshSession();
  parseAndSetup(session, 'let x = 10');
  session.run(0, 10000);
  assertEquals(session.get(0, 'x'), 10);

  parseAndSetup(session, 'let xPlusOne = x + 1');
  session.run(0, 10000);
  assertEquals(session.get(0, 'xPlusOne'), 11);
});

Deno.test("Session: external call via airlock", () => {
  const session = freshSession();
  const { airlock } = session;
  const rootGrant = airlock.createRootGrant();

  let called = false;
  const id = airlock.register({});
  rootGrant.add(id);
  airlock.setHandler(id, 'log', ({ args }) => {
    called = true;
  });
  airlock.declare('Console', id);

  session.parse('Console.log("hello from sandscript")');
  session.run(0, 10000);
  assertEquals(called, true);
});

Deno.test("Session: memory stats accessible", () => {
  const session = freshSession();
  session.parse('let x = 1');
  session.run(0, 10000);

  const heap = session.mem.heapUsage();
  const strings = session.mem.stringUsage();

  assertEquals(typeof heap.used, 'number');
  assertEquals(typeof heap.total, 'number');
  assertEquals(typeof strings.used, 'number');
});

Deno.test("Session: GC runs successfully", () => {
  const session = freshSession();
  session.parse('let garbage = { a: 1 }; garbage = null');
  session.run(0, 10000);

  const gcResult = session.gc();
  assertEquals(typeof gcResult.heapCollected, 'number');
});

Deno.test("Session: internals accessible", () => {
  const session = freshSession();
  assertExists(session.mem);
  assertExists(session.parser);
  assertExists(session.collector);
  assertExists(session.airlock);
});

// =============================================================================
// Debug/Introspection API
// =============================================================================

Deno.test("Session: parse() returns instruction count", () => {
  const session = freshSession();
  const parseResult = session.parse('let x = 1 + 2');

  assert(parseResult.instructions >= 1, 'Expected at least 1 instruction');
});

Deno.test("Session: run() returns status", () => {
  const session = freshSession();
  session.parse('let x = 1');
  const runResult = session.run(0, 1000);

  assertEquals(runResult.status, 'done');
});

Deno.test("Session: get() retrieves variable", () => {
  const session = freshSession();
  session.parse('let x = 3');
  session.run(0, 10000);

  assertEquals(session.get(0, 'x'), 3);
});

Deno.test("Session: state() returns scope", () => {
  const session = freshSession();
  session.parse('let x = 3');
  session.run(0, 10000);

  const state = session.state(0);
  assertEquals(typeof state.instruction, 'number');
  assertEquals(typeof state.instructionCount, 'number');
  assertEquals(state.scope.x, 3);
});

Deno.test("Session: instruction() returns opcode info", () => {
  const session = freshSession();
  session.parse('let x = 1');
  session.run(0, 10000);

  const instr0 = session.instruction(0);
  assertExists(instr0.opcode);
  assertEquals(typeof instr0.astNode, 'number');
  // Without inlineSource, no AST attribution.
  assertEquals(instr0.astNode, 0);
});

Deno.test("Session: instructionsForAstSubtree() finds instructions in subtree", () => {
  const session = freshSession({ inlineSource: true });
  session.parse('let a = 1 + 2');
  // Walk to the root, find the BINARY_OP node, and ask for its descendants.
  const reader = session.astReader();
  const roots = [...reader.iterateRoots()];
  const root = reader.readTree(roots[0]);
  const decl = root.body.statements[0];        // VARIABLE_DECL
  const binding = decl.bindings[0];              // VARIABLE_BINDING
  const expr = binding.initializer;              // BINARY_OP
  const indices = session.instructionsForAstSubtree(expr.offset);
  // Should include the LIT for 1, LIT for 2, and the ADD instruction.
  assert(indices.length >= 3, `expected ≥3 attributions, got ${indices.length}`);
});

Deno.test("Session: run(1) steps one instruction", () => {
  const session = freshSession();
  session.parse('let step1 = 1; let step2 = 2');

  const before = session.state(0).instruction;
  session.run(0, 1);
  const after = session.state(0).instruction;

  assert(after > before, 'Expected instruction to advance');
});

Deno.test("Session: run() returns done status", () => {
  // Exit condition is OUTPUT only - check it from the run result,
  // don't call run() again to check if "still done"
  const session = freshSession();
  session.parse('let done1 = 1');
  const result = session.run(0, 10000);

  assertEquals(result.status, 'done');
});

Deno.test("Session: parse() with syntax error throws", () => {
  const session = freshSession();
  assertThrows(() => session.parse('let = bad syntax'));
});

Deno.test("Session: state() returns pending stack", () => {
  const session = freshSession();
  session.parse('1 + 2');
  session.run(0, 1);

  const state = session.state(0);
  assert(Array.isArray(state.pending), 'Expected pending array');
});

Deno.test("Session: setInstruction() jumps to instruction", () => {
  const session = freshSession();
  session.parse('let jump1 = 1; let jump2 = 2');
  session.run(0, 10000);

  session.setInstruction(0, 0);
  const state = session.state(0);
  assertEquals(state.instruction, 0);
});

Deno.test("Session: AST attributions resolve to source", () => {
  // Slice 6 replaced source-position fields with AST attribution. The
  // analogous test: every value-producing instruction in an inlineSource
  // session has an astNode that decodes to a real AST node.
  const session = freshSession({ inlineSource: true });
  session.parse('let pos = 123');

  const count = session.state(0).instructionCount;
  let foundAttributed = false;
  for (let i = 0; i < count; i++) {
    const ins = session.instruction(i);
    if (ins.astNode !== 0) {
      foundAttributed = true;
      assertExists(session.getSourceFor(i));
      break;
    }
  }
  assert(foundAttributed, 'Expected at least one attributed instruction');
});

// =============================================================================
// REPL Result (deferred POP)
// =============================================================================

Deno.test("Session: result() returns expression value", () => {
  const session = freshSession();
  session.parse('1 + 2');
  session.run(0, 10000);
  assertEquals(session.result(0), 3);
});

Deno.test("Session: result() returns last expression", () => {
  const session = freshSession();
  session.parse('1 + 2; 3 + 4');
  session.run(0, 10000);
  assertEquals(session.result(0), 7);
});

Deno.test("Session: result() undefined after let statement", () => {
  const session = freshSession();
  session.parse('let x = 5');
  session.run(0, 10000);
  assertEquals(session.result(0), undefined);
});

Deno.test("Session: next parse clears previous result", () => {
  const session = freshSession();
  parseAndSetup(session, '1 + 2');
  session.run(0, 10000);
  assertEquals(session.result(0), 3);

  parseAndSetup(session, '10 + 20');
  session.run(0, 10000);
  assertEquals(session.result(0), 30);
});

Deno.test("Session: nested expression only final survives", () => {
  const session = freshSession();
  session.parse('if (true) { 1 + 1; } 2 + 2');
  session.run(0, 10000);
  assertEquals(session.result(0), 4);
});

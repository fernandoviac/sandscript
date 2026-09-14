/**
 * Tests for step-diff pure helpers.
 *
 * Pins the snapshot/diff contract independent of any runner. Tests use a
 * raw session and drive it with session.run(slot, 1) to exercise the
 * helpers directly.
 */

import { assertEquals, assert } from "https://deno.land/std@0.208.0/assert/mod.ts";
import { freshSession } from '../../src/host-owned-session.js';
import { snapshot, diff, readInstruction, depths, heap } from '../../src/fuel/step-diff.js';

Deno.test("step-diff: snapshot returns expected shape", () => {
  const session = freshSession();
  session.parse('let x = 1');
  const snap = snapshot(session.memoryImage, 0);
  assert(Array.isArray(snap.pending));
  assert(Array.isArray(snap.callStack));
  assertEquals(typeof snap.scope.depth, 'number');
  assert(Array.isArray(snap.tryStack));
  assert(Array.isArray(snap.grantStack));
  assertEquals(typeof snap.stateHeader.instructionIndex, 'number');
  assert(snap.errorInfo !== undefined);
});

Deno.test("step-diff: diff of identical snapshots is empty", () => {
  const session = freshSession();
  session.parse('let x = 1');
  const a = snapshot(session.memoryImage, 0);
  const b = snapshot(session.memoryImage, 0);
  const d = diff(a, b);
  assertEquals(d.pending.pushed.length, 0);
  assertEquals(d.pending.popped.length, 0);
  assertEquals(d.callStack.pushed.length, 0);
  assertEquals(d.callStack.popped.length, 0);
  assertEquals(d.scope.depthChange, 0);
  assertEquals(Object.keys(d.stateHeader).length, 0);
  assertEquals(d.errorInfo, null);
});

Deno.test("step-diff: one instruction step produces non-empty diff", () => {
  const session = freshSession();
  session.parse('let x = 1');
  const before = snapshot(session.memoryImage, 0);
  session.run(0, 1);
  const after = snapshot(session.memoryImage, 0);
  const d = diff(before, after);
  assert(
    d.pending.pushed.length > 0 ||
    d.pending.popped.length > 0 ||
    Object.keys(d.stateHeader).length > 0,
    'expected some change after one instruction'
  );
  assert(
    d.stateHeader.instructionIndex !== undefined,
    'instructionIndex should advance'
  );
});

Deno.test("step-diff: readInstruction returns numeric opcode + opcodeName + operands", () => {
  const session = freshSession();
  session.parse('let x = 1');
  const instr = readInstruction(session.memoryImage, 0);
  assertEquals(instr.index, 0);
  assertEquals(typeof instr.opcode, 'number');
  assertEquals(typeof instr.opcodeName, 'string');
  assert(instr.opcodeName.length > 0, 'opcodeName must not be empty');
  assertEquals(typeof instr.operand1, 'number');
  assertEquals(typeof instr.operand2, 'number');
});

Deno.test("step-diff: depths returns nonnegative integers for every per-slot stack", () => {
  const session = freshSession();
  session.parse('let x = 1');
  const d = depths(session.memoryImage, 0);
  assertEquals(typeof d.pendingDepth, 'number');
  assertEquals(typeof d.callDepth, 'number');
  assertEquals(typeof d.scopeDepth, 'number');
  assertEquals(typeof d.tryDepth, 'number');
  assertEquals(typeof d.grantDepth, 'number');
  assert(d.pendingDepth >= 0);
  assert(d.callDepth >= 0);
  assert(d.scopeDepth >= 0);
  assert(d.tryDepth >= 0);
  assert(d.grantDepth >= 0);
});

Deno.test("step-diff: heap returns pointers with null deltas when no prior is given", () => {
  const session = freshSession();
  session.parse('let x = 1');
  const h = heap(session.memoryImage);
  assertEquals(typeof h.heapPointer, 'number');
  assertEquals(typeof h.stringPointer, 'number');
  assertEquals(h.heapDelta, null);
  assertEquals(h.stringDelta, null);
});

Deno.test("step-diff: heap returns nonnegative deltas vs. a prior snapshot's stateHeader", () => {
  const session = freshSession();
  session.parse('let s = "hello"');
  const before = snapshot(session.memoryImage, 0).stateHeader;
  // Run a few steps to allocate the string literal.
  for (let i = 0; i < 5; i++) {
    const r = session.run(0, 1);
    if (r.status === 'done') break;
  }
  const h = heap(session.memoryImage, before);
  assert(h.heapDelta >= 0, `heapDelta should be >= 0, got ${h.heapDelta}`);
  assert(h.stringDelta >= 0, `stringDelta should be >= 0, got ${h.stringDelta}`);
});

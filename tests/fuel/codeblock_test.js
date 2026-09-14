/**
 * Test CodeBlock infrastructure (Phase 1)
 *
 * Run with: deno task test tests/fuel/codeblock_test.js
 */

import { assertEquals, assertThrows } from "https://deno.land/std@0.208.0/assert/mod.ts";
import { MemoryManipulator, instantiateSync, layoutVat, OP, CODE_BLOCK_FLAG } from '../../src/fuel/index.js';

function createFreshMemory() {
  const memory = new WebAssembly.Memory({ initial: 16, maximum: 256, shared: true });
  const wasm = instantiateSync(memory);
  const mem = new MemoryManipulator(memory);
  mem.setWasmInstance(wasm);
  layoutVat(mem.memory, mem.baseOffset, { segmentSize: mem.segmentSize });
  mem.bootstrap();
  return { memory, wasm, mem };
}

Deno.test("CodeBlock: allocate returns valid pointer", () => {
  const { mem } = createFreshMemory();
  const cb = mem.allocateCodeBlock();
  assertEquals(typeof cb, 'number');
  assertEquals(cb > 0, true, 'CodeBlock pointer should be positive');
});

Deno.test("CodeBlock: initial instruction count is 0", () => {
  const { mem } = createFreshMemory();
  const cb = mem.allocateCodeBlock();
  assertEquals(mem.codeBlockInstructionCount(cb), 0);
});

Deno.test("CodeBlock: initial flags are 0", () => {
  const { mem } = createFreshMemory();
  mem.allocateCodeBlock();
  assertEquals(mem.codeBlockGetFlags(), 0);
});

Deno.test("CodeBlock: append instructions", () => {
  const { mem } = createFreshMemory();
  mem.allocateCodeBlock();

  const idx0 = mem.codeBlockAppend(OP.LIT_INT, 42);
  assertEquals(idx0, 0, 'First instruction should be at index 0');

  const idx1 = mem.codeBlockAppend(OP.LIT_INT, 100);
  assertEquals(idx1, 1, 'Second instruction should be at index 1');

  const idx2 = mem.codeBlockAppend(OP.ADD);
  assertEquals(idx2, 2, 'Third instruction should be at index 2');

  assertEquals(mem.codeBlockInstructionCount(), 3);
});

Deno.test("CodeBlock: read instructions back", () => {
  const { mem } = createFreshMemory();
  mem.allocateCodeBlock();

  // Pass an astNode placeholder (5) to verify it round-trips via the
  // 5th positional arg (signature is opcode, op1, op2, flags, astNode).
  mem.codeBlockAppend(OP.LIT_INT, 42, 0, 0, 5);
  mem.codeBlockAppend(OP.LIT_INT, 100, 0, 0, 6);
  mem.codeBlockAppend(OP.ADD);

  const instr0 = mem.codeBlockReadInstruction(0);
  assertEquals(instr0.opcode, OP.LIT_INT);
  assertEquals(instr0.operand1, 42);
  assertEquals(instr0.astNode, 5);

  const instr1 = mem.codeBlockReadInstruction(1);
  assertEquals(instr1.astNode, 6);

  const instr2 = mem.codeBlockReadInstruction(2);
  assertEquals(instr2.opcode, OP.ADD);
});

Deno.test("CodeBlock: patch instruction operand1", () => {
  const { mem } = createFreshMemory();
  mem.allocateCodeBlock();

  mem.codeBlockAppend(OP.LIT_INT, 42);
  mem.codeBlockPatch(0, 999);

  const patched = mem.codeBlockReadInstruction(0);
  assertEquals(patched.operand1, 999);
});

Deno.test("CodeBlock: set flags", () => {
  const { mem } = createFreshMemory();
  mem.allocateCodeBlock();

  mem.codeBlockSetFlags(CODE_BLOCK_FLAG.COMPLETE);
  assertEquals(mem.codeBlockGetFlags(), CODE_BLOCK_FLAG.COMPLETE);
});

Deno.test("CodeBlock: allocating resets the single code block", () => {
  const { mem } = createFreshMemory();
  const cb1 = mem.allocateCodeBlock();
  mem.codeBlockAppend(OP.LIT_INT, 42);
  assertEquals(mem.codeBlockInstructionCount(), 1);

  // Allocating again resets (single code block model)
  const cb2 = mem.allocateCodeBlock();
  assertEquals(cb1, cb2, 'Same code block pointer returned');
  assertEquals(mem.codeBlockInstructionCount(), 0);
});

Deno.test("CodeBlock: append after reset works", () => {
  const { mem } = createFreshMemory();
  mem.allocateCodeBlock();
  mem.codeBlockAppend(OP.LIT_INT, 42);

  mem.allocateCodeBlock();
  mem.codeBlockAppend(OP.LIT_TRUE);
  mem.codeBlockAppend(OP.RETURN);

  assertEquals(mem.codeBlockInstructionCount(), 2);
});

Deno.test("CodeBlock: try stack operations", () => {
  const { mem } = createFreshMemory();
  mem.allocateCodeBlock();

  assertEquals(mem.getTryDepth(0), 0, 'Initial try depth should be 0');

  mem.pushTryEntry(0, 5, 10);
  assertEquals(mem.getTryDepth(0), 1);

  const entry = mem.peekTryEntry(0);
  assertEquals(entry.catchIndex, 5);
  assertEquals(entry.finallyIndex, 10);

  mem.popTryEntry(0);
  assertEquals(mem.getTryDepth(0), 0);
});

Deno.test("CodeBlock: instruction index state", () => {
  const { mem } = createFreshMemory();
  mem.allocateCodeBlock();

  mem.setContextInstructionIndex(0, 2);

  assertEquals(mem.getContextInstructionIndex(0), 2);
});

/**
 * Freed contexts and the slot→pointer table.
 *
 * freeContext must zero the slot's table entry: the context object and its
 * stack blocks are heap garbage from that moment, so freeness must never be
 * read out of them. The old protocol (table entry kept + FREE exit condition
 * read from the state block) dangled after the first collection swept the
 * block — the next GC (or the reuse scan) read whatever bytes had been
 * reallocated there, and when they did not happen to equal FREE it
 * resurrected a "phantom context" whose stack bounds were arbitrary data.
 * The collector then walked AND FORWARDED through that data: silent heap
 * poisoning, wasm OOB traps, and the Collector.abs out-of-bounds storm
 * (the console-host vat corruption, 2026-07-02).
 *
 * Run with: deno task test tests/fuel/gc_freed_context_table_test.js
 */

import { assert, assertEquals } from "https://deno.land/std@0.208.0/assert/mod.ts";
import {
  MemoryManipulator,
  Parser,
  instantiateSync,
  layoutVat,
  Collector,
  CONTEXT_STATUS_FREE,
} from '../../src/fuel/index.js';

function createTestContext() {
  const memory = new WebAssembly.Memory({ initial: 16, maximum: 256, shared: true });
  const wasm = instantiateSync(memory);
  const mem = new MemoryManipulator(memory);
  mem.setWasmInstance(wasm);
  layoutVat(mem.memory, mem.baseOffset, { segmentSize: mem.segmentSize });
  mem.bootstrap();

  const parser = new Parser(mem);
  let currentCodeBlock = null;

  function run(source) {
    if (currentCodeBlock === null) {
      currentCodeBlock = mem.allocateCodeBlock();
    }
    const startIndex = mem.codeBlockInstructionCount();
    parser.parse(source);
    mem.setContextInstructionIndex(0, startIndex);
    wasm.exports.run(10000, 0);
    return mem.getExitCondition(0);
  }

  function gc() {
    const collector = new Collector(mem);
    return collector.collect();
  }

  return { memory, wasm, mem, parser, run, gc };
}

Deno.test("freeContext zeroes the slot→pointer table entry", () => {
  const { mem } = createTestContext();

  const slot = mem.allocateContext();
  assert(mem.getContextBase(slot) !== 0, 'allocated slot has a table entry');

  mem.freeContext(slot);
  assertEquals(mem.getContextBase(slot), 0,
    'freed slot table entry must be zero — freeness must not live in the reclaimable block');
  assertEquals(mem.getExitCondition(slot), CONTEXT_STATUS_FREE,
    'a zeroed table entry reads as FREE without touching the heap');
});

Deno.test("freed slot is reused by allocateContext", () => {
  const { mem } = createTestContext();

  const a = mem.allocateContext();
  const countAfterA = mem.getContextCount();
  mem.freeContext(a);

  const b = mem.allocateContext();
  assertEquals(b, a, 'the freed slot is the one reused');
  assertEquals(mem.getContextCount(), countAfterA, 'no new slot appended');
  assert(mem.getContextBase(b) !== 0, 'reused slot has a fresh table entry');
});

Deno.test("alloc/free churn with interleaved GC does not grow the table or resurrect phantoms", () => {
  const { mem, run, gc } = createTestContext();

  // Live data so collections have real objects to move over the freed blocks.
  run(`
    let keep = []
    let i = 0
    while (i < 40) { keep.push("filler string number " + i + " with some prose to occupy heap"); i = i + 1 }
  `);

  const capacity = mem.getContextTableCapacity();
  const rounds = capacity * 2 + 8;
  for (let i = 0; i < rounds; i++) {
    const slot = mem.allocateContext();
    mem.freeContext(slot);
    // Collect every few rounds: pre-fix, the first GC after a free swept the
    // state block while the table still pointed at it; a later GC then read
    // reused bytes as an exit condition and walked a phantom context. This
    // loop crashes (Collector.abs out of bounds) or corrupts under the old
    // protocol once compaction slides the filler over a freed block.
    if (i % 3 === 0) {
      run(`keep.push("churn ${i} — more prose so compaction has bytes to slide")`);
      gc();
    }
  }

  // The table never grows (freed slots are reused), and a final collection
  // walks only genuinely allocated contexts.
  gc();
  assert(mem.getContextCount() <= capacity, 'context count stays within capacity');
});

Deno.test("collection preserves context allocation generations", () => {
  const { mem, gc } = createTestContext();
  const slot = mem.allocateContext();
  const generation = mem.getContextGeneration(slot);
  const tableBefore = mem.getContextGenerationTablePointer();

  gc();

  assert(mem.getContextGenerationTablePointer() !== 0);
  assertEquals(mem.getContextGeneration(slot), generation);
  assertEquals(mem.isContextIdentityLive(slot, generation), true);
  assert(
    mem.getContextGenerationTablePointer() <= tableBefore,
    "collection may forward the generation table but must retain its contents",
  );
});

Deno.test("legacy image: first collection zeroes a FREE slot's dangling table entry", () => {
  const { mem, gc } = createTestContext();

  // Recreate the pre-fix state: a freed context whose table entry still
  // points at the FREE-marked state block (as written by the old freeContext
  // or restored from an old snapshot).
  const slot = mem.allocateContext();
  const base = mem.getContextBase(slot);
  mem.freeContext(slot);
  mem.setContextPointer(slot, base);
  assertEquals(mem.getExitCondition(slot), CONTEXT_STATUS_FREE,
    'legacy shape: table entry live, block says FREE');

  gc();

  assertEquals(mem.getContextBase(slot), 0,
    'the collection that reclaims the block must also zero the dangling entry');
});

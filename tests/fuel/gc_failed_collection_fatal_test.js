/**
 * A collection that throws mid-phase POISONS the image: the failure is
 * rethrown as FatalCollectionError, and every later collect() refuses.
 *
 * Rationale: a mid-phase throw leaves the image half-mutated (marks
 * partially applied, objects partially moved, string references partially
 * forwarded or zeroed). The old behavior — callers swallowing the throw
 * into a per-slot error and continuing lets poisoned folds, sticky
 * INVALID_OPERAND state, and phantom string ids accumulate. A failed
 * collection must therefore be loud, unrecoverable, and restored from
 * persistence.
 *
 * Run with: deno task test tests/fuel/gc_failed_collection_fatal_test.js
 */

import { assert, assertEquals } from "https://deno.land/std@0.208.0/assert/mod.ts";
import {
  MemoryManipulator,
  Parser,
  instantiateSync,
  layoutVat,
  Collector,
} from '../../src/fuel/index.js';

function createTestContext() {
  const memory = new WebAssembly.Memory({ initial: 16, maximum: 256, shared: true });
  const wasm = instantiateSync(memory);
  const mem = new MemoryManipulator(memory);
  mem.setWasmInstance(wasm);
  layoutVat(mem.memory, mem.baseOffset, { segmentSize: mem.segmentSize });
  mem.bootstrap();
  const parser = new Parser(mem);
  let code = null;
  function run(source) {
    if (code === null) code = mem.allocateCodeBlock();
    const startIndex = mem.codeBlockInstructionCount();
    parser.parse(source);
    mem.setContextInstructionIndex(0, startIndex);
    wasm.exports.run(10000, 0);
    return mem.getExitCondition(0);
  }
  return { mem, run };
}

Deno.test('a mid-phase collection failure is fatal and poisons the image', () => {
  const { mem, run } = createTestContext();
  run(`let keep = { a: "alive", list: [1, 2, 3] }`);

  const collector = new Collector(mem);

  // Sanity: a healthy collection works.
  collector.collect();

  // Inject a mid-mark failure via the observer hook.
  collector.valueObserver = () => { throw new Error('injected mark failure'); };
  let firstError = null;
  try { collector.collect(); } catch (e) { firstError = e; }
  assert(firstError, 'the failing collection must throw');
  assertEquals(firstError.name, 'FatalCollectionError');
  assert(firstError.fatalCollection === true, 'must carry the fatal marker');
  assert(String(firstError.message).includes('poisoned'),
    'must say the image is poisoned');

  // The observer is gone, but the image is poisoned: collect() refuses.
  collector.valueObserver = null;
  let secondError = null;
  try { collector.collect(); } catch (e) { secondError = e; }
  assert(secondError, 'a later collection over a poisoned image must refuse');
  assertEquals(secondError.name, 'FatalCollectionError');
  assert(String(secondError.message).includes('earlier failed collection'),
    'the refusal must name the cause');
});

Deno.test('a zero-size header before heapPointer is fatal', () => {
  const { mem, run } = createTestContext();
  run(`let keep = { a: "alive", list: [1, 2, 3] }`);

  const heapStart = mem.getHeapStart();
  const absoluteHeapStart = mem.abs(heapStart);
  const headerWord = mem.view.getUint32(absoluteHeapStart, true);
  mem.view.setUint32(absoluteHeapStart, headerWord & 0xFF000000, true);

  const collector = new Collector(mem);
  let failure = null;
  try { collector.collect(); } catch (error) { failure = error; }
  assert(failure, 'the malformed heap must be rejected');
  assertEquals(failure.name, 'FatalCollectionError');
  assert(failure.fatalCollection === true);
  assert(
    String(failure.cause?.message).includes(`zero-size heap header at ${heapStart}`),
    `must identify the malformed header, got: ${failure.cause?.message}`,
  );
});

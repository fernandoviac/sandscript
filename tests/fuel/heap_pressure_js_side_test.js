/**
 * JS-side allocator pressure signaling.
 *
 * MemoryImage.allocate() used to throw a plain Error('Heap
 * overflow') when the heap-vs-code boundary was crossed. The throw
 * propagated as an untyped exception — the host's runtime surfaced
 * it as ERR_OUT_OF_MEMORY (sometimes via the WAT-side per-instruction
 * safeguard, sometimes via the raw JS throw) but couldn't
 * distinguish recoverable pressure from terminal failure.
 *
 * With structured pressure signaling:
 *  - MemoryImage.allocate() and the inline allocator wrappers
 *    (allocateObject, allocateArrayWithCapacity, allocateArrayBuffer,
 *    allocateSymEntriesBlock, allocateBigInt, allocateRational,
 *    allocateComplex, allocateSymbol, allocateExpression) call
 *    this._checkHeapBudget(bytes) at entry.
 *  - On overflow: signals the WAT-side pressure flag and throws
 *    HeapPressureSignal (subclass of Error) instead of plain Error.
 *  - Hosts catching HeapPressureSignal can treat it as a recoverable
 *    signal and retry after engine.gc().
 */

import { assertEquals, assert } from 'https://deno.land/std@0.208.0/assert/mod.ts';
import { freshSession } from '../../src/host-owned-session.js';
import { HeapPressureSignal } from '../../src/fuel/memory-image.js';

Deno.test('HeapPressureSignal is exported and is an Error subclass', () => {
  assert(typeof HeapPressureSignal === 'function');
  const instance = new HeapPressureSignal(100, 50);
  assert(instance instanceof Error);
  assertEquals(instance.name, 'HeapPressureSignal');
  assertEquals(instance.requestedBytes, 100);
  assertEquals(instance.availableBytes, 50);
});

Deno.test('MemoryImage.allocate throws HeapPressureSignal on overflow', () => {
  // Tight heap (96 KB), big allocation that won't fit.
  const session = freshSession({ heapSize: 96 * 1024 });
  const mem = session.airlock.memoryImage;
  // Force heap_pointer near code_pointer by allocating big chunks.
  // (allocate takes a dataSize; total size is dataSize + GC_HEADER (8),
  //  aligned to 16.)
  try {
    // First a few that should fit.
    mem.allocate(40000, 0);
    mem.allocate(40000, 0);
    // This one shouldn't fit.
    mem.allocate(40000, 0);
    throw new Error('expected HeapPressureSignal');
  } catch (e) {
    assert(e instanceof HeapPressureSignal,
      `expected HeapPressureSignal, got ${e.name}: ${e.message}`);
    assert(e.requestedBytes > 0);
  }
});

Deno.test('After HeapPressureSignal, the WAT pressure flag is set', () => {
  const session = freshSession({ heapSize: 96 * 1024 });
  const mem = session.airlock.memoryImage;
  // Trigger an overflow.
  try {
    mem.allocate(40000, 0);
    mem.allocate(40000, 0);
    mem.allocate(40000, 0);
  } catch (e) {
    if (!(e instanceof HeapPressureSignal)) throw e;
  }
  // The WAT flag should be set so the next run() yields memory_pressure.
  const flagSet = mem.wasm.exports.memory_pressure_signaled();
  assertEquals(flagSet, 1,
    'expected $memory_pressure_signaled to be set after HeapPressureSignal throw');
});

Deno.test('allocateBigInt throws HeapPressureSignal on overflow', () => {
  const session = freshSession({ heapSize: 96 * 1024 });
  const mem = session.airlock.memoryImage;
  // Fill heap by allocating big bigints.
  const bigLimbs = new Array(2000).fill(0xDEADBEEF);
  try {
    for (let i = 0; i < 100; i++) {
      mem.allocateBigInt(0, bigLimbs);
    }
    throw new Error('expected HeapPressureSignal');
  } catch (e) {
    assert(e instanceof HeapPressureSignal,
      `expected HeapPressureSignal, got ${e.name}: ${e.message}`);
  }
});

Deno.test('allocateObject throws HeapPressureSignal when entries block overruns', () => {
  // allocateObject's entries block can be larger than the header — both
  // need to fit. With a tight heap and a large initialCapacity, the
  // pre-check should fire even though the header alone would fit.
  const session = freshSession({ heapSize: 96 * 1024 });
  const mem = session.airlock.memoryImage;
  // Fill heap with a few big allocations to get near the boundary.
  for (let i = 0; i < 20; i++) {
    try { mem.allocate(4000, 0); } catch (e) {
      if (e instanceof HeapPressureSignal) break;
      throw e;
    }
  }
  // Now allocateObject with a moderate capacity should overrun.
  try {
    mem.allocateObject(1000); // entries block: 8 + 1000*20 = 20008 bytes
    throw new Error('expected HeapPressureSignal');
  } catch (e) {
    assert(e instanceof HeapPressureSignal,
      `expected HeapPressureSignal, got ${e.name}: ${e.message}`);
  }
});

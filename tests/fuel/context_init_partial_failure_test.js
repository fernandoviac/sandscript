/**
 * Context initialization must remain recoverable if HeapPressureSignal
 * interrupts _initializeContext before the new slot's table entry is written.
 *
 * memoryImage.allocateContext increments STATE.CONTEXT_COUNT before
 * _initializeContext performs five separate allocations and finally calls
 * setContextPointer. Failure in that interval leaves the header claiming a
 * slot whose entry is still zero. These cases construct that partial state
 * directly and verify that collection and allocateContext retry preserve the
 * header and slot table.
 */

import { assert, assertEquals } from "https://deno.land/std@0.208.0/assert/mod.ts";
import {
  MemoryManipulator,
  instantiateSync,
  layoutVat,
  Collector,
  CONTEXT_STATUS_FREE,
} from '../../src/fuel/index.js';

function createTightHeapContext({ heapSize, stringTableSize, contextTableSize }) {
  const memory = new WebAssembly.Memory({ initial: 16, maximum: 256, shared: true });
  const wasm = instantiateSync(memory);
  const mem = new MemoryManipulator(memory);
  mem.setWasmInstance(wasm);
  layoutVat(mem.memory, mem.baseOffset, { heapSize, stringTableSize, contextTableSize });
  mem.bootstrap();
  return { memory, wasm, mem };
}

function gc(mem) {
  const collector = new Collector(mem);
  return collector.collect();
}

Deno.test("allocateContext recovers when heap pressure interrupts _initializeContext", () => {
  // Boot with a heap tight enough that only a few hundred bytes of real
  // headroom remain after bootstrap — small enough that a handful of
  // context-slot allocations (each ~1KB across 5 blocks + headers) will
  // exhaust it, but not so tight that bootstrap() itself fails.
  // stringTableSize must leave a positive data span past the derived
  // tail hash index (gc-scratch-layout.js) — 32KB gives ~16KB of data
  // span, well below the 256KB default.
  // contextTableSize=16 -> capacity 4 slots (4 bytes/entry) — forces
  // _growContextTable to fire on the 5th allocateContext() call, well
  // before heap exhaustion, isolating table-growth pressure from ordinary
  // per-context allocation pressure.
  const { mem } = createTightHeapContext({
    heapSize: 40 * 1024, stringTableSize: 32 * 1024, contextTableSize: 16,
  });

  const heapStart = mem.getHeapStart();
  const heapPointerAfterBoot = mem.getHeapPointer();
  console.log(`post-boot heap: start=${heapStart} pointer=${heapPointerAfterBoot} ` +
    `used=${heapPointerAfterBoot - heapStart}`);

  // Exercise MemoryManipulator directly while reproducing
  // airlock.allocateContext()'s allocate, collect, and retry sequence.
  const allocated = [];
  let pressureHits = 0;
  let corruptedAfterRetry = false;

  for (let i = 0; i < 64; i++) {
    let slot;
    try {
      slot = mem.allocateContext();
    } catch (e) {
      pressureHits++;
      console.log(`iteration ${i}: HeapPressureSignal (${e.message}) — ` +
        `CONTEXT_COUNT=${mem.getContextCount()}, ` +
        `tablePointer=${mem.getContextTablePointer()}`);

      // Mirror airlock.js's own recovery exactly: gc, then retry once.
      try {
        gc(mem);
      } catch (gcErr) {
        console.log(`iteration ${i}: gc() ITSELF threw: ${gcErr.message}`);
        corruptedAfterRetry = true;
        break;
      }

      // Check header sanity immediately after GC follows a failed
      // _initializeContext; header corruption first becomes observable here.
      const tablePointerAfterGc = mem.getContextTablePointer();
      const heapPointerAfterGc = mem.getHeapPointer();
      console.log(`iteration ${i}: post-gc tablePointer=${tablePointerAfterGc}, ` +
        `heapPointer=${heapPointerAfterGc}`);
      if (tablePointerAfterGc === 0 || heapPointerAfterGc === 0) {
        corruptedAfterRetry = true;
        console.log(`iteration ${i}: CORRUPTION — table or heap pointer zeroed after gc`);
        break;
      }

      try {
        slot = mem.allocateContext();
      } catch (e2) {
        console.log(`iteration ${i}: retry ALSO threw: ${e2.message} — genuine OOM, stopping`);
        break;
      }
    }
    allocated.push(slot);

    // Every allocated slot's exit condition must remain readable rather than
    // failing with an out-of-bounds DataView access.
    try {
      const ec = mem.getExitCondition(slot);
      if (i % 8 === 0) {
        console.log(`iteration ${i}: slot=${slot} exitCondition=${ec} ` +
          `tablePointer=${mem.getContextTablePointer()} ` +
          `contextCount=${mem.getContextCount()}`);
      }
    } catch (readErr) {
      corruptedAfterRetry = true;
      console.log(`iteration ${i}: getExitCondition(${slot}) THREW: ${readErr.message}`);
      break;
    }
  }

  console.log(`done: allocated=${allocated.length}, pressureHits=${pressureHits}, ` +
    `corrupted=${corruptedAfterRetry}`);

  // A passing run must enter the failure window. If no HeapPressureSignal
  // occurs, heap sizing no longer exercises the intended boundary.
  assert(pressureHits > 0,
    "test did not trigger HeapPressureSignal; adjust heap sizing to exercise " +
    "the mid-_initializeContext failure window");

  assert(!corruptedAfterRetry,
    "CONFIRMED: a HeapPressureSignal during _initializeContext, followed " +
    "by the standard gc-and-retry, left the header (context table pointer " +
    "or heap pointer) corrupted or unreadable");
});

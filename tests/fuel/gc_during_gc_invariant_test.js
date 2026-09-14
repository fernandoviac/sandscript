/**
 * GC-during-GC invariant.
 *
 * The garbage collector must never trigger heap pressure as a side
 * effect of its own work — if it did, a host-side gc() called in
 * response to pressure would re-enter the allocator, re-signal
 * pressure, and the recovery loop would never terminate.
 *
 * The invariant is structural: collector.js writes through raw
 * view.setUint32 / setUint8 operations against the existing linear
 * memory, never calling memoryImage.allocate or signal_memory_pressure.
 * The single state-mutating call at the end of compaction is
 * manipulator.setHeapPointer(newHeapPointer), the atomic commit.
 *
 * These tests pin the invariant against regression:
 *  1. A gc() pass over a populated heap must leave the WAT pressure
 *     flag clear.
 *  2. A gc() pass must NEVER advance heap_pointer (it can only
 *     stay the same or shrink).
 *  3. A gc() called while the WAT pressure flag is set must clear
 *     the flag (session.gc's contract), not re-signal it.
 */

import { assertEquals, assert } from 'https://deno.land/std@0.208.0/assert/mod.ts';
import { parseAndSetup } from './test-helpers.js';
import { freshSession } from '../../src/host-owned-session.js';
import { HeapPressureSignal } from '../../src/fuel/memory-image.js';

Deno.test('gc() does not signal memory pressure on a populated heap', () => {
  const session = freshSession({ heapSize: 96 * 1024 });
  const mem = session.airlock.memoryImage;

  // Populate the heap with a mix of live and garbage allocations.
  parseAndSetup(session, `
    let kept = [];
    for (let i = 0; i < 50; i = i + 1) {
      kept[i] = {x: i, y: i + 1, z: [i, i+1, i+2]};
    }
    let garbage = null;
    for (let i = 0; i < 100; i = i + 1) {
      garbage = {junk: i};
    }
    let result = kept.length;
  `);
  session.run(0, 100000);

  // Confirm pressure flag is clear before gc.
  assertEquals(mem.wasm.exports.memory_pressure_signaled(), 0,
    'pressure flag must be clear before gc');

  session.gc();

  // Invariant: gc must not signal pressure.
  assertEquals(mem.wasm.exports.memory_pressure_signaled(), 0,
    'gc() must not signal memory pressure as a side effect');
});

Deno.test('gc() never advances the heap pointer', () => {
  const session = freshSession({ heapSize: 96 * 1024 });
  const mem = session.airlock.memoryImage;

  parseAndSetup(session, `
    let arr = [];
    for (let i = 0; i < 100; i = i + 1) {
      arr[i] = {idx: i, doubled: i * 2};
    }
    let result = arr.length;
  `);
  session.run(0, 100000);

  const heapBefore = mem.getHeapPointer();
  session.gc();
  const heapAfter = mem.getHeapPointer();

  assert(heapAfter <= heapBefore,
    `gc() must not advance heap pointer (was ${heapBefore}, now ${heapAfter})`);
});

Deno.test('gc() clears a previously-signaled pressure flag', () => {
  const session = freshSession({ heapSize: 96 * 1024 });
  const mem = session.airlock.memoryImage;

  // Trigger pressure via JS-side allocator overflow.
  for (let i = 0; i < 30; i++) {
    try { mem.allocate(4000, 0); } catch (e) {
      if (e instanceof HeapPressureSignal) break;
      throw e;
    }
  }
  assertEquals(mem.wasm.exports.memory_pressure_signaled(), 1,
    'pressure flag must be set after JS-side overflow');

  session.gc();

  // gc clears the flag (session.gc's contract — see session.js:283).
  assertEquals(mem.wasm.exports.memory_pressure_signaled(), 0,
    'gc() must clear the pressure flag (session.gc contract)');
});

Deno.test('repeated gc() cycles remain pressure-flag-clean', () => {
  // Stress: many gc passes against a heap that grows + shrinks.
  // Confirms the invariant holds across iterations, not just a
  // single pass.
  const session = freshSession({ heapSize: 96 * 1024 });
  const mem = session.airlock.memoryImage;

  parseAndSetup(session, `
    let kept = null;
    for (let i = 0; i < 50; i = i + 1) {
      kept = {x: i, list: [i, i+1, i+2]};
    }
    let result = 1;
  `);
  session.run(0, 100000);

  for (let i = 0; i < 20; i++) {
    session.gc();
    assertEquals(mem.wasm.exports.memory_pressure_signaled(), 0,
      `pass ${i + 1}: gc must not signal pressure`);
  }
});

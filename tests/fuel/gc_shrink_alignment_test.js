/**
 * Tests for $gc_shrinkable_high_water_mark, the read-only export that
 * exposes the SS heap's live-set high-water mark after compaction.
 *
 * The export reads STATE.HEAP_POINTER directly. Callers compact first, read
 * the high-water mark, then pass it into SS-region resizing as the floor
 * below which `heap_end` must not move.
 */

import { assertEquals } from "https://deno.land/std@0.208.0/assert/mod.ts";
import { createSession } from '../../src/fuel/session.js';
import { freshSession } from '../../src/host-owned-session.js';

Deno.test('HWM equals heap_pointer after a compact', () => {
  const session = freshSession();
  const memImg = session.airlock.memoryImage;

  // Allocate some heap objects via running code.
  session.parse(`
    let arr = [1, 2, 3, 4, 5]
    let obj = { a: 1, b: 2, c: { nested: true } }
    let nested = [[1,2],[3,4],[5,6]]
  `);
  const result = session.run(0, 1_000_000);
  if (result.status === 'error') {
    throw new Error(`run failed: ${JSON.stringify(result.error)}`);
  }

  // Compact the heap; HWM after compact must equal current heap_pointer.
  session.gc();
  const heapPointer = memImg.getHeapPointer();
  const hwm = session.airlock.shrinkableHighWaterMark();

  assertEquals(hwm, heapPointer,
    'HWM should equal STATE.HEAP_POINTER post-compact');
});

Deno.test('HWM stays above heap_start when live data exists', () => {
  const session = freshSession();
  const memImg = session.airlock.memoryImage;

  // Keep some live objects.
  session.parse(`
    let keep1 = "live string one"
    let keep2 = { stays: "alive" }
  `);
  const result = session.run(0, 1_000_000);
  if (result.status === 'error') {
    throw new Error(`run failed: ${JSON.stringify(result.error)}`);
  }

  session.gc();
  const hwm = session.airlock.shrinkableHighWaterMark();
  const heapStart = memImg.getHeapStart();

  // Live data is on the heap, so HWM must be strictly above heap_start.
  if (hwm <= heapStart) {
    throw new Error(
      `HWM (${hwm}) should be strictly greater than heap_start (${heapStart}) ` +
      `when live data exists`);
  }
});

Deno.test('HWM reflects the most-recent compact within one session', () => {
  // In one session, compact, read the high-water mark, allocate more, compact
  // again, and read it again. The second value must reflect the new live set
  // rather than a stale cache.
  const session = freshSession();
  const memImg = session.airlock.memoryImage;

  // Phase 1: allocate, run, compact, capture HWM.
  session.parse(`let first = [1, 2, 3]`);
  let r = session.run(0, 1_000_000);
  if (r.status === 'error') throw new Error(JSON.stringify(r.error));
  session.gc();
  const hwm1 = session.airlock.shrinkableHighWaterMark();

  // Phase 2: append more code with distinct identifiers, set PC to the
  // start of the new chunk so we don't re-execute the original `let
  // first` (would throw REDECLARATION), run, compact.
  const parseResult = session.parse(`
    let second = [{a:1,b:2,c:3,d:4,e:5},{f:6,g:7,h:8,i:9,j:10}]
    let third = [[1,2,3],[4,5,6],[7,8,9],[10,11,12]]
  `);
  memImg.setContextInstructionIndex(0, parseResult.startIndex);
  r = session.run(0, 1_000_000);
  if (r.status === 'error') throw new Error(JSON.stringify(r.error));
  session.gc();
  const hwm2 = session.airlock.shrinkableHighWaterMark();

  // hwm2 must strictly exceed hwm1 — more live data after the second
  // compact, and the export reads the current heap_pointer.
  if (hwm2 <= hwm1) {
    throw new Error(
      `Second-compact HWM (${hwm2}) should exceed first-compact HWM ` +
      `(${hwm1}) — more live data was retained between compacts. ` +
      `If they're equal, the export may be returning a stale value.`);
  }
});

Deno.test('HWM is below heap_end (resize-down would be valid)', () => {
  const session = freshSession();
  const memImg = session.airlock.memoryImage;

  session.parse(`let x = "some live data"`);
  const result = session.run(0, 1_000_000);
  if (result.status === 'error') {
    throw new Error(`run failed: ${JSON.stringify(result.error)}`);
  }

  session.gc();
  const hwm = session.airlock.shrinkableHighWaterMark();
  const heapEnd = memImg.getHeapEnd();

  if (hwm >= heapEnd) {
    throw new Error(
      `HWM (${hwm}) should be strictly less than heap_end (${heapEnd}) ` +
      `for a meaningful shrink budget`);
  }
});

Deno.test('HWM grows with allocation between compacts (no allocation: stable)', () => {
  const session = freshSession();

  session.parse(`let a = [1, 2, 3]`);
  const r1 = session.run(0, 1_000_000);
  if (r1.status === 'error') throw new Error(JSON.stringify(r1.error));
  session.gc();
  const hwmA = session.airlock.shrinkableHighWaterMark();

  // No more code runs; immediately re-compact.
  session.gc();
  const hwmB = session.airlock.shrinkableHighWaterMark();

  // Should be the same — nothing was allocated between compacts.
  assertEquals(hwmA, hwmB,
    'HWM should not move when no allocation happens between compacts');
});

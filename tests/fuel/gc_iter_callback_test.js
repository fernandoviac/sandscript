/**
 * FRAME.ITER_CALLBACK holds the callback closure's HEADER pointer and
 * the iteration continuation dereferences it on every element — so the
 * collector must mark it (the frame can be the closure's ONLY
 * reference for an inline arrow) and forward it across compaction.
 *
 * A stale collector comment claimed FRAME.ITER_CALLBACK held an instruction
 * index, so markCallStackForContext and updateCallStackPointersForContext
 * both skipped it. A gc() while a slot was fuel-parked mid-iteration either
 * collected an inline-arrow callback that had no other reference or left a
 * moved named callback's pointer stale after relocation.
 */
import { assertEquals } from "https://deno.land/std@0.208.0/assert/mod.ts";
import { freshSession } from '../../src/host-owned-session.js';
import { parseAndSetup } from './test-helpers.js';

function runToCompletion(session, slot, fuelPerStep = 100000, maxSteps = 50) {
  for (let step = 0; step < maxSteps; step++) {
    const result = session.run(slot, fuelPerStep);
    if (result.status === 'done') return result;
    // Documented host behavior: the offending instruction has not
    // advanced; gc() and resume.
    if (result.status === 'memory_pressure') session.gc();
  }
  throw new Error('did not complete');
}

// Overwrite the free heap span with a poison pattern. Compaction
// copies live objects down without zeroing the vacated source bytes,
// so a stale (un-forwarded) pointer dereferences an intact ghost copy
// and "works" — until real allocations overwrite it. Scrubbing makes
// that latent corruption deterministic: the free span's contents are
// undefined by contract, so a correct collector must not be affected.
function scrubFreeHeap(session) {
  const start = session.mem.abs(session.mem.getHeapPointer());
  const end = session.mem.abs(session.mem.getCodePointer());
  new Uint8Array(session.mem.buffer, start, end - start).fill(0xAA);
}

Deno.test('inline arrow callback survives gc during a parked iteration', () => {
  const session = freshSession();
  // The arrow closure's only reference once iteration starts is the
  // frame's ITER_CALLBACK field. Burn fuel inside the callback so the
  // slot parks mid-iteration.
  parseAndSetup(session, `
    let out = [10, 20, 30].map((v) => {
      let i = 0;
      while (i < 2000) { i = i + 1; }
      return v + 1;
    });
  `);
  const paused = session.run(0, 800);
  assertEquals(paused.status, 'paused');

  session.gc();
  scrubFreeHeap(session);

  runToCompletion(session, 0);
  assertEquals(session.get(0, 'out'), [11, 21, 31]);
});

Deno.test('named callback relocated by gc mid-iteration is forwarded', () => {
  const session = freshSession();
  // Garbage BEFORE the callback closure so compaction relocates it.
  parseAndSetup(session, `
    let garbage = [];
    let g = 0;
    while (g < 50) { garbage = [g, g + 1, g + 2]; g = g + 1; }
    garbage = 0;
    function bump(v) {
      let i = 0;
      while (i < 2000) { i = i + 1; }
      return v * 2;
    }
    let out = [1, 2, 3].map(bump);
  `);
  const paused = session.run(0, 4000);
  assertEquals(paused.status, 'paused');

  const stats = session.gc();
  // The setup must actually reclaim something, or relocation isn't
  // exercised.
  if (stats.heapCollected === 0) {
    throw new Error('setup produced no garbage — test exercises nothing');
  }
  scrubFreeHeap(session);

  runToCompletion(session, 0);
  assertEquals(session.get(0, 'out'), [2, 4, 6]);
});

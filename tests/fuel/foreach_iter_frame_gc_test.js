/**
 * Regression: FRAME.ITER_RECEIVER / FRAME.ITER_RESULT store HEADER
 * pointers, but the collector previously walked them as DATA pointers
 * (markObjectByDataPointer in markCallStackForContext, getNewDataPointer
 * in updateCallStackPointersForContext). After a compacting GC fired
 * mid-iteration, the iter frame's receiver pointer was off by 8 bytes
 * (mark missed the object entirely, update wrote nonsense), and the
 * subsequent RETURN_UNDEFINED continuation crashed with "memory access
 * out of bounds" while loading the next array element.
 *
 * This test pins the bug fix. Both regular Array forEach and
 * msgpack-materialized array forEach must survive a GC that fires
 * during the callback body — both store header pointers in
 * FRAME.ITER_RECEIVER and rely on the collector forwarding them
 * correctly.
 */

import { assertEquals } from 'https://deno.land/std@0.208.0/assert/mod.ts';
import { parseAndSetup } from './test-helpers.js';
import { freshSession } from '../../src/host-owned-session.js';

function runWithRecovery(session, maxIters = 200) {
  let result;
  for (let i = 0; i < maxIters; i++) {
    result = session.run(0, 50000);
    if (result.status === 'memory_pressure') {
      session.gc();
      continue;
    }
    return result;
  }
  return result;
}

Deno.test('Array.forEach survives GC fired mid-callback (iter frame receiver forwarding)', () => {
  // Tight heap; each outer iteration's literal array + each rational
  // sum grows the heap until pressure forces a gc + retry. Prior to
  // the fix, the gc relocated the iter frame's receiver but
  // miscalculated the new pointer (used getNewDataPointer on a
  // header pointer, so it read forwarding from an 8-byte-prior
  // location). On resume, RETURN_UNDEFINED's iteration continuation
  // followed the bad receiver pointer and faulted.
  const session = freshSession({ heapSize: 80 * 1024 });
  parseAndSetup(session, `
    let total = 0;
    for (let i = 0; i < 1000; i = i + 1) {
      const arr = [i, i+1, i+2, i+3, i+4];
      arr.forEach((x) => { total = total + x });
    }
    let result = total;
  `);

  const result = runWithRecovery(session);
  assertEquals(result.status, 'done', `expected done, got ${result.status}`);
  // 5 elements per iteration; sum is i + (i+1) + (i+2) + (i+3) + (i+4) = 5i + 10.
  // Sum over i=0..999: 5 * 999*1000/2 + 10*1000 = 2497500 + 10000 = 2507500.
  assertEquals(session.get(0, 'result'), 2507500);
});

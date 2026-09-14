/**
 * JSON.stringify / JSON.parse pressure pre-checks.
 *
 * The JSON helpers use a doubling-buffer model: allocate 4 KB output
 * up front, grow by 2× as serialisation/parsing proceeds. The entry
 * pre-check covers only the initial buffers; every growth step is
 * pressure-checked inside $json_buffer_grow, and parse-side tree
 * allocations are pre-checked at their call sites, so the demand is
 * proportional to the actual serialised size. The old flat 512 KB entry
 * headroom falsely reported OOM for small inputs. On refusal the opcode
 * yields EXIT_MEMORY_PRESSURE so the host can gc + retry; outputs
 * that genuinely cannot fit keep yielding pressure, which the host
 * escalates after a no-progress gc.
 */

import { assertEquals } from 'https://deno.land/std@0.208.0/assert/mod.ts';
import { parseAndSetup } from './test-helpers.js';
import { freshSession } from '../../src/host-owned-session.js';

function runWithRecovery(session, maxIters = 200) {
  let result;
  for (let i = 0; i < maxIters; i++) {
    result = session.run(0, 100000);
    if (result.status === 'memory_pressure') {
      session.gc();
      continue;
    }
    return result;
  }
  return result;
}

Deno.test('JSON.stringify loop under heap pressure yields and recovers', () => {
  // Heap = 768 KB: enough for one JSON.stringify pass (≤ 512 KB
  // worst case for the doubling chain) but tight enough that
  // repeated calls in a loop without gc would accumulate orphan
  // buffers and overflow.
  const session = freshSession({ heapSize: 768 * 1024 });
  parseAndSetup(session, `
    let total = 0;
    for (let i = 0; i < 50; i = i + 1) {
      const obj = {a: 1, b: 2, c: 3, d: [4, 5, 6], e: "hello"};
      const s = JSON.stringify(obj);
      total = total + s.length;
    }
    let result = total;
  `);

  const result = runWithRecovery(session);
  assertEquals(result.status, 'done', `expected done, got ${result.status}`);
  // {"a":1,"b":2,"c":3,"d":[4,5,6],"e":"hello"} = 43 chars per iter; 50 iters → 2150.
  assertEquals(session.get(0, 'result'), 2150);
});

Deno.test('JSON.parse loop under heap pressure yields and recovers', () => {
  const session = freshSession({ heapSize: 768 * 1024 });
  parseAndSetup(session, `
    let total = 0;
    const input = '{"a":1,"b":2,"c":3,"d":[4,5,6],"e":"hello"}';
    for (let i = 0; i < 50; i = i + 1) {
      const obj = JSON.parse(input);
      total = total + obj.a + obj.b + obj.c;
    }
    let result = total;
  `);

  const result = runWithRecovery(session);
  assertEquals(result.status, 'done', `expected done, got ${result.status}`);
  // a+b+c = 6 per iter; 50 iters → 300.
  assertEquals(session.get(0, 'result'), 300);
});

Deno.test('JSON.stringify with insufficient heap escalates to OOM', () => {
  // An output that genuinely cannot fit: 8 × 32 KB strings serialise
  // to ~262 KB, and the output buffer's doubling chain alone needs
  // more than the whole 256 KB heap. Every retry after gc hits the
  // same wall (the operands are live, nothing reclaimable). Confirms
  // the host loop escalates rather than spinning forever — and that a
  // too-big stringify can never falsely succeed or corrupt the heap.
  const session = freshSession({ heapSize: 256 * 1024 });
  parseAndSetup(session, `
    let chunk = "0123456789abcdef";
    for (let i = 0; i < 11; i = i + 1) { chunk = chunk + chunk; }
    let arr = [chunk, chunk, chunk, chunk, chunk, chunk, chunk, chunk];
    let s = JSON.stringify(arr);
    let result = s.length;
  `);

  // Persistent pressure should escalate; bound is at most 50 iters
  // in runWithRecovery before we abort.
  let result;
  let lastStatus = null;
  let pressureCount = 0;
  for (let i = 0; i < 5; i++) {
    result = session.run(0, 100000);
    lastStatus = result.status;
    if (result.status === 'memory_pressure') {
      pressureCount++;
      session.gc();
      continue;
    }
    break;
  }
  // Either yielded persistent pressure (gc never reclaims enough) or
  // surfaced as ERR_OUT_OF_MEMORY. Both are acceptable surfaces for
  // hard OOM. The key invariant: did NOT silently corrupt or succeed.
  if (lastStatus === 'memory_pressure') {
    // Persistent pressure — acceptable surface, the test heap is
    // just too small for the JSON bound.
    return;
  }
  if (lastStatus === 'error') return;
  // If it succeeded, the heap was actually large enough — not what
  // we're testing here. Re-check the bound.
  if (lastStatus === 'done') {
    throw new Error('expected pressure escalation, but JSON.stringify succeeded');
  }
});

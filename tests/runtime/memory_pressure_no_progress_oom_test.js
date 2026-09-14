/**
 * A no-progress HeapPressureSignal becomes a runtime-level
 * MemoryPressureError rather than a catchable SandScript exception.
 *
 * runtime.js deliberately treats a retry that parks again at the same
 * instruction after consuming almost no fuel as genuine OOM. Only a retry
 * that makes progress is silently re-driven.
 *
 * Through the real Runtime, the OOM is delivered exclusively through
 * onHandlerError as an AttributedRejection wrapping MemoryPressureError, and
 * the slot resolves with `{ status: 'error' }`. Execution never re-enters the
 * script, so a surrounding `try`/`catch` cannot observe the error.
 * A synchronously thrown marshal error follows a different mechanism and is
 * outside this test's contract.
 *
 * Run with: deno task test tests/runtime/memory_pressure_no_progress_oom_test.js
 */

import { assert, assertEquals } from "https://deno.land/std@0.208.0/assert/mod.ts";
import { RuntimeBuilder } from '../../src/runtime/test-harness.js';

function tick(ms = 0) { return new Promise(r => setTimeout(r, ms)); }
async function waitFor(cond, { timeout = 10000, label = 'condition' } = {}) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) { if (cond()) return; await tick(5); }
  throw new Error(`waitFor timed out: ${label}`);
}

Deno.test('runtime: a single oversized allocation that cannot fit even after gc is a runtime-level MemoryPressureError, NOT an SS-catchable exception', async () => {
  const handlerErrors = [];
  const { runtime, session } = new RuntimeBuilder()
    .sessionOptions({ heapSize: 64 * 1024 })
    .onInboundMessage(() => {})
    .onHandlerError((rej) => { handlerErrors.push(rej); })
    .build();
  await runtime.start();

  // Every prior chunk is kept alive in `arr`, so gc reclaims nothing —
  // the retry after gc parks at the SAME instruction having consumed
  // no fuel. That's the no-progress condition the runtime treats as a
  // genuine OOM. The SS-level try/catch wraps the whole loop; if the
  // OOM were SS-catchable, `outcome` would flip to the caught message.
  session.parse(`
    let arr = []
    let i = 0
    let outcome = "not-run"
    try {
      while (i < 10000) {
        arr[i] = new Uint8Array(4096)
        i = i + 1
      }
      outcome = "completed"
    } catch (e) {
      outcome = "" + e.message
    }
  `);

  const result = await runtime.run(0);

  // The drive itself terminates with a runtime-level error status —
  // SS execution never reaches either `outcome = "completed"` or the
  // catch block's `outcome = ...`.
  assertEquals(result.status, 'error',
    `expected the drive to terminate as a runtime-level error, got status=${result.status}`);
  assertEquals(result.error?.name, 'MemoryPressureError');

  assertEquals(session.get(0, 'outcome'), 'not-run',
    'SS-side try/catch never ran — the OOM is not injected back into SS execution as a thrown value');

  assertEquals(handlerErrors.length, 1,
    `expected exactly one MemoryPressureError handler error, got ${handlerErrors.length}`);
  assertEquals(handlerErrors[0]?.cause?.name, 'MemoryPressureError');
  assert(handlerErrors[0]?.cause?.message.includes('memory_pressure persisted across runtime gc'),
    `unexpected message: ${handlerErrors[0]?.cause?.message}`);

  await runtime.terminate();
});

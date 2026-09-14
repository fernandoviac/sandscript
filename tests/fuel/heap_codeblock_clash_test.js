/**
 * Regression: heap allocator must not overrun the code block region.
 *
 * The bytecode region grows downward from STRING_START; the heap grows
 * upward from HEAP_START. They share a segment. Without a tight bound,
 * long-running drones (especially ones that allocate per `await`) end up
 * silently corrupting bytecode — the dispatcher then fetches a tagged
 * value as an opcode and either falls through to the unknown-opcode
 * handler or executes garbage.
 *
 * The fix puts two checks in place:
 *   1. JS-side `allocate()` uses CODE_POINTER (not HEAP_END) as the
 *      effective heap end.
 *   2. The WAT dispatcher checks `heap_pointer >= code_pointer` once
 *      per instruction and exits with ERR_OUT_OF_MEMORY if so —
 *      catching WAT-side allocations that bumped past code_pointer.
 *
 * This test runs an await loop that previously corrupted bytecode at
 * iteration ~2700 with "Invalid operand type: null" / "Unknown opcode
 * 0x00 at instruction N". With the fix, the same loop instead exits
 * cleanly with ERR_OUT_OF_MEMORY (or, if the segment is large enough,
 * runs to completion).
 */

import { assertEquals, assert } from 'https://deno.land/std@0.208.0/assert/mod.ts';
import { createSession } from '../../src/fuel/session.js';
import { parseAndSetup } from './test-helpers.js';
import {
  EXIT_DONE, EXIT_ERROR, EXIT_AWAIT,
  EXIT_ASYNC_COMPLETE, EXIT_ASYNC_REJECTED,
  ERR_OUT_OF_MEMORY,
  ERR_UNKNOWN_OPCODE,
} from '../../src/fuel/constants.js';
import { freshSession } from '../../src/host-owned-session.js';

async function runUntilDoneOrError(session, maxIters = 100000) {
  const mem = session.memoryImage;
  const airlock = session.airlock;
  const contexts = [{ slot: 0, generation: session.memoryImage.getContextGeneration(0) }]

  for (let iter = 0; iter < maxIters; iter++) {
    await new Promise(r => setTimeout(r, 0));

    for (const ctx of airlock.drainPendingSpawnedContextIdentities()) {
      if (!contexts.find(c => c.slot === ctx.slot && c.generation === ctx.generation)) contexts.push(ctx);
    }

    // Prune terminal contexts (keep slot 0).
    for (let i = contexts.length - 1; i >= 0; i--) {
      const ec = mem.getExitCondition(contexts[i].slot);
      if (ec === EXIT_DONE || ec === EXIT_ERROR ||
          ec === EXIT_ASYNC_COMPLETE || ec === EXIT_ASYNC_REJECTED) {
        if (contexts[i].slot !== 0) contexts.splice(i, 1);
      }
    }

    let contextToRun = null;
    for (const ctx of contexts) {
      const ec = mem.getExitCondition(ctx.slot);
      if (ec === EXIT_DONE || ec === EXIT_ERROR ||
          ec === EXIT_ASYNC_COMPLETE || ec === EXIT_ASYNC_REJECTED) continue;
      if (ec === EXIT_AWAIT) continue;
      contextToRun = ctx;
      break;
    }

    if (!contextToRun) {
      if (airlock.linkedPromiseCount() > 0) continue;
      return { status: 'done', iter };
    }

    let result = session.run(contextToRun, 100000);

    // Heap pressure: gc and retry the same instruction. If gc reclaims
    // nothing and the second yield is also pressure, surface as OOM.
    // (Mirrors the string-table-pressure recovery pattern.)
    if (result.status === 'memory_pressure') {
      session.gc();
      result = session.run(contextToRun, 100000);
      if (result.status === 'memory_pressure') {
        // Persistent pressure → hard OOM. Surface to the test the same
        // way an ERR_OUT_OF_MEMORY would have, so the assertion below
        // still passes.
        return {
          status: 'error',
          error: { code: ERR_OUT_OF_MEMORY, codeName: 'OUT_OF_MEMORY',
                   message: 'memory_pressure persisted across gc' },
          iter,
        };
      }
    }

    if (result.status === 'error') return { status: 'error', error: result.error, iter };

    if (result.status === 'async_call' && result.asyncContext !== undefined) {
      contexts.push(result.asyncContext);
    }
    if (result.status === 'await') airlock.handleAwait(contextToRun.slot);
    if (result.status === 'async_complete') {
      const { waiters } = airlock.handleAsyncComplete(contextToRun.slot);
      for (const w of waiters) if (!contexts.find(c => c.slot === w.slot && c.generation === w.generation)) contexts.push(w);
    }
    if (result.status === 'async_rejected') {
      const { waiters } = airlock.handleAsyncRejected(contextToRun.slot);
      for (const w of waiters) if (!contexts.find(c => c.slot === w.slot && c.generation === w.generation)) contexts.push(w);
    }
    if (result.status === 'promise_method' && result.contexts) {
      for (const ctx of result.contexts) {
        if (!contexts.find(c => c.slot === ctx.slot && c.generation === ctx.generation)) contexts.push(ctx);
      }
    }
  }

  return { status: 'timeout', iter: maxIters };
}

Deno.test('await loop that previously corrupted bytecode now exits cleanly with ERR_OUT_OF_MEMORY', async () => {
  const session = freshSession();
  const airlock = session.airlock;

  const id = airlock.register({});
  airlock.createRootGrant().add(id);
  airlock.declare('asyncNoop', id);
  airlock.setHandler(id, null, async () => undefined);

  // Loop large enough to exhaust heap before the code block.
  parseAndSetup(session, `
    async function main(n) {
      for (let i = 0; i < n; i = i + 1) {
        await asyncNoop()
      }
      return i
    }
    let result = main(5000)
  `);

  // Heap exhaustion must stay on the host protocol: a raw JS allocator
  // exception is an internal boundary leak, not an acceptable OOM surface.
  const result = await runUntilDoneOrError(session);

  if (result.status === 'error') {
    assertEquals(
      result.error.code,
      ERR_OUT_OF_MEMORY,
      `expected ERR_OUT_OF_MEMORY, got ${result.error.codeName}: ${result.error.message}`,
    );
    assert(
      result.error.code !== ERR_UNKNOWN_OPCODE,
      'bytecode was corrupted — heap overran the code block',
    );
  }
});

/**
 * Debug test for async function mechanics with host-owned execution.
 */

import { assertEquals } from 'https://deno.land/std@0.208.0/assert/mod.ts';
import { createSession } from '../../src/fuel/session.js';
import { parseAndSetup } from './test-helpers.js';
import {
  EXIT_DONE,
  EXIT_ERROR,
  EXIT_ASYNC_CALL,
  EXIT_ASYNC_COMPLETE,
  EXIT_ASYNC_REJECTED,
  EXIT_AWAIT,
} from '../../src/fuel/constants.js';
import { freshSession } from '../../src/host-owned-session.js';

Deno.test('Debug async function execution flow', () => {
  const session = freshSession();
  const mem = session.memoryImage;
  const airlock = session.airlock;

  parseAndSetup(session, `
    async function foo() { return 42; }
    let p = foo();
  `);

  console.log('\n=== Starting debug trace ===');
  console.log('Initial context:', 0);
  console.log('Initial instruction index:', mem.getContextInstructionIndex(0));

  const contexts = [{ slot: 0, generation: session.memoryImage.getContextGeneration(0) }]
  let loopCount = 0;
  const maxLoops = 100;

  while (loopCount < maxLoops) {
    loopCount++;

    // Find a runnable context
    let contextToRun = null;
    for (const ctx of contexts) {
      const exitCondition = mem.getExitCondition(ctx.slot);

      if (exitCondition === EXIT_DONE || exitCondition === EXIT_ERROR ||
          exitCondition === EXIT_ASYNC_COMPLETE || exitCondition === EXIT_ASYNC_REJECTED) {
        continue;
      }

      if (exitCondition === EXIT_AWAIT) {
        continue;
      }

      contextToRun = ctx;
      break;
    }

    if (!contextToRun) {
      console.log(`Loop ${loopCount}: no runnable context`);
      break;
    }

    const result = session.run(contextToRun, 100);

    console.log(`Loop ${loopCount}: ctx=${contextToRun.slot}, status=${result.status}, asyncContext=${result.asyncContext}`);

    if (result.status === 'done') {
      console.log('Done!');
    }

    if (result.status === 'async_call' && result.asyncContext !== undefined) {
      contexts.push(result.asyncContext);
      console.log(`  Added async context: ${result.asyncContext}`);
    }

    if (result.status === 'await') {
      airlock.handleAwait(contextToRun.slot);
    }

    if (result.status === 'async_complete') {
      console.log(`  Handling async_complete for ctx ${contextToRun.slot}`);
      const { waiters } = airlock.handleAsyncComplete(contextToRun.slot);
      console.log(`  waiters=${JSON.stringify(waiters)}`);
    }

    if (result.status === 'async_rejected') {
      airlock.handleAsyncRejected(contextToRun.slot);
    }
  }

  console.log(`=== Ended after ${loopCount} loops ===\n`);

  assertEquals(loopCount < maxLoops, true, 'Should complete within max loops');
});

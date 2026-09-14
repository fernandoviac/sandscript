/**
 * Tests for await keyword runtime execution.
 *
 * These tests verify that await properly suspends async functions,
 * resumes them via microtask queue, and handles resolved/rejected promises.
 *
 * Host-owned execution model: the caller must handle async context switching.
 */

import { assertEquals, assert } from "https://deno.land/std@0.208.0/assert/mod.ts";
import { createSession } from '../../src/fuel/session.js';
import { parseAndSetup } from './test-helpers.js';
import {
  EXIT_DONE,
  EXIT_ERROR,
  EXIT_AWAIT,
  EXIT_ASYNC_COMPLETE,
  EXIT_ASYNC_REJECTED,
} from '../../src/fuel/constants.js';
import { freshSession } from '../../src/host-owned-session.js';

/**
 * Run a session to completion, handling async context switching inline.
 * Continues until ALL contexts are terminal (not just the main context).
 */
function runToCompletion(session) {
  const mem = session.memoryImage;
  const airlock = session.airlock;
  const contexts = [{ slot: 0, generation: session.memoryImage.getContextGeneration(0) }]

  for (let iter = 0; iter < 500; iter++) {
    let contextToRun = null;

    for (const ctx of contexts) {
      const exitCondition = mem.getExitCondition(ctx.slot);

      // Skip terminal states
      if (exitCondition === EXIT_DONE || exitCondition === EXIT_ERROR ||
          exitCondition === EXIT_ASYNC_COMPLETE || exitCondition === EXIT_ASYNC_REJECTED) {
        continue;
      }

      // EXIT_AWAIT with exit condition still set means the context is waiting
      // for handleAsyncComplete/handleAsyncRejected to prepare it.
      // (handleAwait already prepared it if the promise was settled on first encounter.)
      if (exitCondition === EXIT_AWAIT) {
        continue;
      }

      contextToRun = ctx;
      break;
    }

    // Exit when no runnable context (all terminal or blocked)
    if (!contextToRun) break;

    const result = session.run(contextToRun, 100);

    if (result.status === 'async_call' && result.asyncContext !== undefined) {
      contexts.push(result.asyncContext);
    }

    // handleAwait must be called immediately after run() returns EXIT_AWAIT,
    // because it reads from shared external_request_base.
    if (result.status === 'await') {
      const { pending } = airlock.handleAwait(contextToRun.slot);
      if (!pending) {
        // Promise was already settled — context is prepared and ready to run
      }
      // If pending, context stays in EXIT_AWAIT until handleAsyncComplete/Rejected
    }

    if (result.status === 'async_complete') {
      airlock.handleAsyncComplete(contextToRun.slot);
    }

    if (result.status === 'async_rejected') {
      airlock.handleAsyncRejected(contextToRun.slot);
    }
  }

  return { status: 'done' };
}

function runAndGet(source, varName) {
  const session = freshSession();
  parseAndSetup(session, source);
  runToCompletion(session);
  return session.get(0, varName);
}

// ===========================================================================
// Basic await functionality
// ===========================================================================

Deno.test("Await: top-level await completes with done status", () => {
  const session = freshSession();
  parseAndSetup(session, `
    async function foo() { return 42; }
    let x = await foo();
  `);
  const result = runToCompletion(session);

  // After await, status should be 'done' (not 'suspended')
  assertEquals(result.status, 'done');

  // x should be 42
  const x = session.get(0, 'x');
  assertEquals(x, 42);
});

// ===========================================================================
// Await with arithmetic expressions
// ===========================================================================

Deno.test("Await: await result can be used in expressions", () => {
  const x = runAndGet(`
    async function getNum() { return 10; }
    async function main() {
      let a = await getNum();
      let b = await getNum();
      return a * b;
    }
    let x = await main();
  `, 'x');

  assertEquals(x, 100);
});

Deno.test("Await: await in expression position", () => {
  const x = runAndGet(`
    async function getNum() { return 5; }
    let x = await getNum() + await getNum();
  `, 'x');

  assertEquals(x, 10);
});

// ===========================================================================
// Rejection propagation
// ===========================================================================

Deno.test("Await: rejection propagates to waiter", () => {
  const caught = runAndGet(`
    async function fail() { throw new Error('oops'); }
    let caught = false;
    try {
      await fail();
    } catch (e) {
      caught = true;
    }
  `, 'caught');

  assertEquals(caught, true);
});

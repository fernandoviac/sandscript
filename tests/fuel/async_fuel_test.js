/**
 * Tests for fuel behavior with async/await.
 *
 * These tests verify that:
 * 1. Fuel is consumed by async operations
 * 2. Stepping (fuel=1) works correctly through async boundaries
 * 3. Context switching respects fuel limits
 * 4. 'paused' vs 'suspended' status is correct
 *
 * Host-owned execution model: the caller must handle async context switching.
 */

import { assertEquals, assert } from "https://deno.land/std@0.208.0/assert/mod.ts";
import { createSession } from '../../src/fuel/session.js';
import { parseAndSetup } from './test-helpers.js';
import {
  CONTEXT_STATUS_FREE,
  EXIT_DONE,
  EXIT_AWAIT,
  EXIT_ASYNC_COMPLETE,
  EXIT_ASYNC_REJECTED,
} from '../../src/fuel/constants.js';
import { freshSession } from '../../src/host-owned-session.js';

// ===========================================================================
// Stepping through async functions (fuel=1)
// ===========================================================================

Deno.test("Fuel: stepping through simple async function completes correctly", () => {
  const session = freshSession();
  const mem = session.memoryImage;
  const airlock = session.airlock;

  parseAndSetup(session, `
    async function getValue() { return 42; }
    let x = await getValue();
  `);

  const contexts = [{ slot: 0, generation: session.memoryImage.getContextGeneration(0) }]
  const statuses = [];

  for (let iter = 0; iter < 100; iter++) {
    // Find a runnable context
    let contextToRun = null;

    for (const ctx of contexts) {
      const status = mem.getExitCondition(ctx.slot);

      // Skip terminal states
      if (status === EXIT_DONE || status === EXIT_ASYNC_COMPLETE || status === EXIT_ASYNC_REJECTED) {
        continue;
      }

      if (status === EXIT_AWAIT) {
        continue;
      }

      contextToRun = ctx;
      break;
    }

    if (!contextToRun) break;

    const result = session.run(contextToRun, 1);
    statuses.push(result.status);

    // Handle async_call - new context spawned
    if (result.status === 'async_call' && result.asyncContext !== undefined) {
      contexts.push(result.asyncContext);
    }

    if (result.status === 'await') {
      airlock.handleAwait(contextToRun.slot);
    }

    if (result.status === 'async_complete') {
      airlock.handleAsyncComplete(contextToRun.slot);
    }

    if (result.status === 'async_rejected') {
      airlock.handleAsyncRejected(contextToRun.slot);
    }

    // Check if main context is done
    const mainStatus = mem.getExitCondition(contexts[0].slot);
    if (mainStatus === EXIT_DONE) {
      statuses.push('done');
      break;
    }
  }

  // Main context slot for result extraction
  const mainSlot = contexts[0].slot;

  // Should complete with 'done'
  assertEquals(statuses[statuses.length - 1], 'done');

  // x should be 42
  assertEquals(session.get(0, 'x'), 42);
});

Deno.test("Fuel: stepping never returns 'suspended' when work is available", () => {
  const session = freshSession();
  const mem = session.memoryImage;
  const airlock = session.airlock;

  parseAndSetup(session, `
    async function getValue() { return 42; }
    let x = await getValue();
  `);

  const contexts = [{ slot: 0, generation: session.memoryImage.getContextGeneration(0) }]

  for (let iter = 0; iter < 100; iter++) {
    // Find a runnable context
    let contextToRun = null;

    for (const ctx of contexts) {
      const status = mem.getExitCondition(ctx.slot);

      if (status === EXIT_DONE || status === EXIT_ASYNC_COMPLETE || status === EXIT_ASYNC_REJECTED) {
        continue;
      }

      if (status === EXIT_AWAIT) {
        continue;
      }

      contextToRun = ctx;
      break;
    }

    if (!contextToRun) break;

    const result = session.run(contextToRun, 1);

    // Valid statuses during host-owned execution
    assert(
      result.status === 'paused' || result.status === 'done' ||
      result.status === 'async_call' || result.status === 'async_complete' ||
      result.status === 'await',
      `Unexpected status '${result.status}' at step ${iter}`
    );

    if (result.status === 'async_call' && result.asyncContext !== undefined) {
      contexts.push(result.asyncContext);
    }

    if (result.status === 'await') {
      airlock.handleAwait(contextToRun.slot);
    }

    if (result.status === 'async_complete') {
      airlock.handleAsyncComplete(contextToRun.slot);
    }

    if (result.status === 'async_rejected') {
      airlock.handleAsyncRejected(contextToRun.slot);
    }

    const mainStatus = mem.getExitCondition(contexts[0].slot);
    if (mainStatus === EXIT_DONE) break;
  }

});

Deno.test("Fuel: nested async stepping works correctly", () => {
  const session = freshSession();
  const mem = session.memoryImage;
  const airlock = session.airlock;

  parseAndSetup(session, `
    async function double(n) { return n * 2; }
    async function quadruple(n) {
      let doubled = await double(n);
      return await double(doubled);
    }
    let x = await quadruple(3);
  `);

  const contexts = [{ slot: 0, generation: session.memoryImage.getContextGeneration(0) }]
  const statuses = [];

  for (let iter = 0; iter < 200; iter++) {
    let contextToRun = null;

    for (const ctx of contexts) {
      const status = mem.getExitCondition(ctx.slot);

      if (status === EXIT_DONE || status === EXIT_ASYNC_COMPLETE || status === EXIT_ASYNC_REJECTED) {
        continue;
      }

      if (status === EXIT_AWAIT) {
        continue;
      }

      contextToRun = ctx;
      break;
    }

    if (!contextToRun) break;

    const result = session.run(contextToRun, 1);
    statuses.push(result.status);

    if (result.status === 'async_call' && result.asyncContext !== undefined) {
      contexts.push(result.asyncContext);
    }

    if (result.status === 'await') {
      airlock.handleAwait(contextToRun.slot);
    }

    if (result.status === 'async_complete') {
      airlock.handleAsyncComplete(contextToRun.slot);
    }

    if (result.status === 'async_rejected') {
      airlock.handleAsyncRejected(contextToRun.slot);
    }

    const mainStatus = mem.getExitCondition(contexts[0].slot);
    if (mainStatus === EXIT_DONE) {
      statuses.push('done');
      break;
    }
  }

  // Should complete
  assertEquals(statuses[statuses.length - 1], 'done');

  // x should be 12 (3 * 2 * 2)
  assertEquals(session.get(0, 'x'), 12);
});

// ===========================================================================
// Context validity after async completion
// ===========================================================================

Deno.test("Fuel: context slot is valid after async function completes", () => {
  const session = freshSession();
  const mem = session.memoryImage;
  const airlock = session.airlock;

  parseAndSetup(session, `
    async function getValue() { return 42; }
    let x = await getValue();
  `);

  const contexts = [{ slot: 0, generation: session.memoryImage.getContextGeneration(0) }]

  for (let iter = 0; iter < 100; iter++) {
    let contextToRun = null;

    for (const ctx of contexts) {
      const status = mem.getExitCondition(ctx.slot);

      if (status === EXIT_DONE || status === EXIT_ASYNC_COMPLETE || status === EXIT_ASYNC_REJECTED) {
        continue;
      }

      if (status === EXIT_AWAIT) {
        continue;
      }

      contextToRun = ctx;
      break;
    }

    if (!contextToRun) break;

    // Context being run should not be free
    const runStatus = mem.getExitCondition(contextToRun.slot);
    assert(
      runStatus !== CONTEXT_STATUS_FREE,
      `Context ${contextToRun.slot} is FREE before step ${iter}`
    );

    const result = session.run(contextToRun, 1);

    if (result.status === 'async_call' && result.asyncContext !== undefined) {
      contexts.push(result.asyncContext);
    }

    if (result.status === 'await') {
      airlock.handleAwait(contextToRun.slot);
    }

    if (result.status === 'async_complete') {
      airlock.handleAsyncComplete(contextToRun.slot);
    }

    if (result.status === 'async_rejected') {
      airlock.handleAsyncRejected(contextToRun.slot);
    }

    const mainStatus = mem.getExitCondition(contexts[0].slot);
    if (mainStatus === EXIT_DONE) break;
  }

});

Deno.test("Fuel: freed async context is never executed", () => {
  const session = freshSession();
  const mem = session.memoryImage;
  const airlock = session.airlock;

  parseAndSetup(session, `
    async function getValue() { return 42; }
    let x = await getValue();
  `);

  const contexts = [{ slot: 0, generation: session.memoryImage.getContextGeneration(0) }]
  const executedContexts = new Set();

  for (let iter = 0; iter < 100; iter++) {
    let contextToRun = null;

    for (const ctx of contexts) {
      const status = mem.getExitCondition(ctx.slot);

      if (status === EXIT_DONE || status === EXIT_ASYNC_COMPLETE || status === EXIT_ASYNC_REJECTED) {
        continue;
      }

      if (status === EXIT_AWAIT) {
        continue;
      }

      contextToRun = ctx;
      break;
    }

    if (!contextToRun) break;

    const runStatus = mem.getExitCondition(contextToRun.slot);
    // Should never try to execute a free context
    assert(
      runStatus !== CONTEXT_STATUS_FREE,
      `Attempted to execute FREE context ${contextToRun.slot} at step ${iter}`
    );

    executedContexts.add(contextToRun.slot);

    const result = session.run(contextToRun, 1);

    if (result.status === 'async_call' && result.asyncContext !== undefined) {
      contexts.push(result.asyncContext);
    }

    if (result.status === 'await') {
      airlock.handleAwait(contextToRun.slot);
    }

    if (result.status === 'async_complete') {
      airlock.handleAsyncComplete(contextToRun.slot);
    }

    if (result.status === 'async_rejected') {
      airlock.handleAsyncRejected(contextToRun.slot);
    }

    const mainStatus = mem.getExitCondition(contexts[0].slot);
    if (mainStatus === EXIT_DONE) break;
  }

});

// ===========================================================================
// Fuel consumption across contexts
// ===========================================================================

Deno.test("Fuel: each instruction consumes fuel regardless of context", () => {
  const session = freshSession();
  const mem = session.memoryImage;
  const airlock = session.airlock;

  parseAndSetup(session, `
    async function getValue() { return 42; }
    let x = await getValue();
  `);

  const contexts = [{ slot: 0, generation: session.memoryImage.getContextGeneration(0) }]
  let totalFuelUsed = 0;

  for (let iter = 0; iter < 200; iter++) {
    let contextToRun = null;

    for (const ctx of contexts) {
      const status = mem.getExitCondition(ctx.slot);

      if (status === EXIT_DONE || status === EXIT_ASYNC_COMPLETE || status === EXIT_ASYNC_REJECTED) {
        continue;
      }

      if (status === EXIT_AWAIT) {
        continue;
      }

      contextToRun = ctx;
      break;
    }

    if (!contextToRun) break;

    const fuelBefore = 1;
    const result = session.run(contextToRun, fuelBefore);
    const fuelUsed = fuelBefore - (result.fuel || 0);

    totalFuelUsed += fuelUsed;

    if (result.status === 'async_call' && result.asyncContext !== undefined) {
      contexts.push(result.asyncContext);
    }

    if (result.status === 'await') {
      airlock.handleAwait(contextToRun.slot);
    }

    if (result.status === 'async_complete') {
      airlock.handleAsyncComplete(contextToRun.slot);
    }

    if (result.status === 'async_rejected') {
      airlock.handleAsyncRejected(contextToRun.slot);
    }

    const mainStatus = mem.getExitCondition(contexts[0].slot);
    if (mainStatus === EXIT_DONE) break;
  }

  // fuelUsed should be positive (instructions were executed)
  assert(totalFuelUsed > 0, `Expected positive fuel usage, got ${totalFuelUsed}`);
});

Deno.test("Fuel: fuel exhaustion pauses correctly mid-async", () => {
  const session = freshSession();
  const mem = session.memoryImage;
  const airlock = session.airlock;

  parseAndSetup(session, `
    async function getValue() { return 42; }
    let x = await getValue();
  `);

  const contexts = [{ slot: 0, generation: session.memoryImage.getContextGeneration(0) }]

  // Run with limited fuel - should pause or hit async status
  let result = session.run(0, 3);

  // Status could be paused, async_call, await, etc.
  assert(
    result.status !== 'done',
    `Expected non-done status with 3 fuel, got '${result.status}'`
  );

  // x should not be defined yet
  assertEquals(session.get(0, 'x'), undefined);

  // Continue to completion with full execution loop
  for (let iter = 0; iter < 200; iter++) {
    let contextToRun = null;

    for (const ctx of contexts) {
      const status = mem.getExitCondition(ctx.slot);

      if (status === EXIT_DONE || status === EXIT_ASYNC_COMPLETE || status === EXIT_ASYNC_REJECTED) {
        continue;
      }

      if (status === EXIT_AWAIT) {
        continue;
      }

      contextToRun = ctx;
      break;
    }

    if (!contextToRun) break;

    result = session.run(contextToRun, 100);

    if (result.status === 'async_call' && result.asyncContext !== undefined) {
      contexts.push(result.asyncContext);
    }

    if (result.status === 'await') {
      airlock.handleAwait(contextToRun.slot);
    }

    if (result.status === 'async_complete') {
      airlock.handleAsyncComplete(contextToRun.slot);
    }

    if (result.status === 'async_rejected') {
      airlock.handleAsyncRejected(contextToRun.slot);
    }

    const mainStatus = mem.getExitCondition(contexts[0].slot);
    if (mainStatus === EXIT_DONE) break;
  }

  assertEquals(session.get(0, 'x'), 42);
});

// ===========================================================================
// Multiple awaits in sequence
// ===========================================================================

Deno.test("Fuel: stepping through multiple sequential awaits", () => {
  const session = freshSession();
  const mem = session.memoryImage;
  const airlock = session.airlock;

  parseAndSetup(session, `
    async function getA() { return 1; }
    async function getB() { return 2; }
    async function getC() { return 3; }
    let sum = await getA() + await getB() + await getC();
  `);

  const contexts = [{ slot: 0, generation: session.memoryImage.getContextGeneration(0) }]
  const statuses = [];

  for (let iter = 0; iter < 300; iter++) {
    let contextToRun = null;

    for (const ctx of contexts) {
      const status = mem.getExitCondition(ctx.slot);

      if (status === EXIT_DONE || status === EXIT_ASYNC_COMPLETE || status === EXIT_ASYNC_REJECTED) {
        continue;
      }

      if (status === EXIT_AWAIT) {
        continue;
      }

      contextToRun = ctx;
      break;
    }

    if (!contextToRun) break;

    const result = session.run(contextToRun, 1);
    statuses.push(result.status);

    if (result.status === 'async_call' && result.asyncContext !== undefined) {
      contexts.push(result.asyncContext);
    }

    if (result.status === 'await') {
      airlock.handleAwait(contextToRun.slot);
    }

    if (result.status === 'async_complete') {
      airlock.handleAsyncComplete(contextToRun.slot);
    }

    if (result.status === 'async_rejected') {
      airlock.handleAsyncRejected(contextToRun.slot);
    }

    const mainStatus = mem.getExitCondition(contexts[0].slot);
    if (mainStatus === EXIT_DONE) {
      statuses.push('done');
      break;
    }
  }

  assertEquals(statuses[statuses.length - 1], 'done');
  assertEquals(session.get(0, 'sum'), 6);
});

// ===========================================================================
// Fuel behavior with microtask queue
// ===========================================================================

Deno.test("Fuel: microtask processing does not bypass fuel limits", () => {
  const session = freshSession();
  const mem = session.memoryImage;
  const airlock = session.airlock;

  parseAndSetup(session, `
    async function getValue() { return 42; }
    let x = await getValue();
  `);

  const contexts = [{ slot: 0, generation: session.memoryImage.getContextGeneration(0) }]
  let steps = 0;

  for (let iter = 0; iter < 100; iter++) {
    let contextToRun = null;

    for (const ctx of contexts) {
      const status = mem.getExitCondition(ctx.slot);

      if (status === EXIT_DONE || status === EXIT_ASYNC_COMPLETE || status === EXIT_ASYNC_REJECTED) {
        continue;
      }

      if (status === EXIT_AWAIT) {
        continue;
      }

      contextToRun = ctx;
      break;
    }

    if (!contextToRun) break;

    const result = session.run(contextToRun, 1);
    steps++;

    if (result.status === 'async_call' && result.asyncContext !== undefined) {
      contexts.push(result.asyncContext);
    }

    if (result.status === 'await') {
      airlock.handleAwait(contextToRun.slot);
    }

    if (result.status === 'async_complete') {
      airlock.handleAsyncComplete(contextToRun.slot);
    }

    if (result.status === 'async_rejected') {
      airlock.handleAsyncRejected(contextToRun.slot);
    }

    const mainStatus = mem.getExitCondition(contexts[0].slot);
    if (mainStatus === EXIT_DONE) break;
  }

  // Should take multiple steps (not complete in 1-2 steps due to microtask bypass)
  assert(steps >= 5, `Expected at least 5 steps for async completion, got ${steps}`);
});

Deno.test("Fuel: context count stays bounded during stepping", () => {
  const session = freshSession();
  const mem = session.memoryImage;
  const airlock = session.airlock;

  parseAndSetup(session, `
    async function getValue() { return 42; }
    let x = await getValue();
  `);

  const contexts = [{ slot: 0, generation: session.memoryImage.getContextGeneration(0) }]
  let maxContexts = 0;

  for (let iter = 0; iter < 100; iter++) {
    const contextCount = mem.getContextCount();
    if (contextCount > maxContexts) maxContexts = contextCount;

    let contextToRun = null;

    for (const ctx of contexts) {
      const status = mem.getExitCondition(ctx.slot);

      if (status === EXIT_DONE || status === EXIT_ASYNC_COMPLETE || status === EXIT_ASYNC_REJECTED) {
        continue;
      }

      if (status === EXIT_AWAIT) {
        continue;
      }

      contextToRun = ctx;
      break;
    }

    if (!contextToRun) break;

    const result = session.run(contextToRun, 1);

    if (result.status === 'async_call' && result.asyncContext !== undefined) {
      contexts.push(result.asyncContext);
    }

    if (result.status === 'await') {
      airlock.handleAwait(contextToRun.slot);
    }

    if (result.status === 'async_complete') {
      airlock.handleAsyncComplete(contextToRun.slot);
    }

    if (result.status === 'async_rejected') {
      airlock.handleAsyncRejected(contextToRun.slot);
    }

    const mainStatus = mem.getExitCondition(contexts[0].slot);
    if (mainStatus === EXIT_DONE) break;
  }

  // Should never exceed 2 contexts for this simple example
  assert(maxContexts <= 2, `Expected at most 2 contexts, saw ${maxContexts}`);
});

// ===========================================================================
// Exact fuel consumption tests (verify fix for context switch fuel bypass)
// ===========================================================================

Deno.test("Fuel: run(1) executes exactly 1 instruction across context switch", () => {
  const session = freshSession();
  const mem = session.memoryImage;
  const airlock = session.airlock;

  parseAndSetup(session, `
    async function getValue() { return 42; }
    let x = await getValue();
  `);

  const contexts = [{ slot: 0, generation: session.memoryImage.getContextGeneration(0) }]
  let instructionsExecuted = 0;

  for (let iter = 0; iter < 100; iter++) {
    let contextToRun = null;

    for (const ctx of contexts) {
      const status = mem.getExitCondition(ctx.slot);

      if (status === EXIT_DONE || status === EXIT_ASYNC_COMPLETE || status === EXIT_ASYNC_REJECTED) {
        continue;
      }

      if (status === EXIT_AWAIT) {
        continue;
      }

      contextToRun = ctx;
      break;
    }

    if (!contextToRun) break;

    const fuelBefore = 1;
    const result = session.run(contextToRun, fuelBefore);
    const fuelUsed = fuelBefore - (result.fuel || 0);

    // Each step should use at most 1 fuel
    // (may be 0 on yield statuses)
    assert(
      fuelUsed <= 1,
      `Step ${iter}: expected fuelUsed<=1, got ${fuelUsed}`
    );

    // If paused status, should have used exactly 1 fuel
    if (result.status === 'paused') {
      assertEquals(
        fuelUsed,
        1,
        `Step ${iter}: expected fuelUsed=1 for paused status, got ${fuelUsed}`
      );
    }

    instructionsExecuted += fuelUsed;

    if (result.status === 'async_call' && result.asyncContext !== undefined) {
      contexts.push(result.asyncContext);
    }

    if (result.status === 'await') {
      airlock.handleAwait(contextToRun.slot);
    }

    if (result.status === 'async_complete') {
      airlock.handleAsyncComplete(contextToRun.slot);
    }

    if (result.status === 'async_rejected') {
      airlock.handleAsyncRejected(contextToRun.slot);
    }

    const mainStatus = mem.getExitCondition(contexts[0].slot);
    if (mainStatus === EXIT_DONE) break;
  }

  assertEquals(session.get(0, 'x'), 42);
});

Deno.test("Fuel: run(1) respects fuel limit when async function returns", () => {
  const session = freshSession();
  const mem = session.memoryImage;
  const airlock = session.airlock;

  // This code triggers context switch when async function returns
  parseAndSetup(session, `
    async function inner() { return 1; }
    async function outer() {
      let a = await inner();
      return a + 1;
    }
    let result = await outer();
  `);

  const contexts = [{ slot: 0, generation: session.memoryImage.getContextGeneration(0) }]

  // Step through and verify each step uses at most 1 fuel
  for (let iter = 0; iter < 200; iter++) {
    let contextToRun = null;

    for (const ctx of contexts) {
      const status = mem.getExitCondition(ctx.slot);

      if (status === EXIT_DONE || status === EXIT_ASYNC_COMPLETE || status === EXIT_ASYNC_REJECTED) {
        continue;
      }

      if (status === EXIT_AWAIT) {
        continue;
      }

      contextToRun = ctx;
      break;
    }

    if (!contextToRun) break;

    const fuelBefore = 1;
    const result = session.run(contextToRun, fuelBefore);
    const fuelUsed = fuelBefore - (result.fuel || 0);

    // Each step should use at most 1 fuel
    assert(
      fuelUsed <= 1,
      `Step ${iter}: expected fuelUsed<=1, got ${fuelUsed}`
    );

    // If paused status, should have used exactly 1 fuel
    if (result.status === 'paused') {
      assertEquals(
        fuelUsed,
        1,
        `Step ${iter}: expected fuelUsed=1 for paused status, got ${fuelUsed}`
      );
    }

    if (result.status === 'async_call' && result.asyncContext !== undefined) {
      contexts.push(result.asyncContext);
    }

    if (result.status === 'await') {
      airlock.handleAwait(contextToRun.slot);
    }

    if (result.status === 'async_complete') {
      airlock.handleAsyncComplete(contextToRun.slot);
    }

    if (result.status === 'async_rejected') {
      airlock.handleAsyncRejected(contextToRun.slot);
    }

    const mainStatus = mem.getExitCondition(contexts[0].slot);
    if (mainStatus === EXIT_DONE) break;
  }

  assertEquals(session.get(0, 'result'), 2);
});

Deno.test("Fuel: run(1) respects fuel limit with multiple awaits", () => {
  const session = freshSession();
  const mem = session.memoryImage;
  const airlock = session.airlock;

  parseAndSetup(session, `
    async function getA() { return 10; }
    async function getB() { return 20; }
    let sum = await getA() + await getB();
  `);

  const contexts = [{ slot: 0, generation: session.memoryImage.getContextGeneration(0) }]
  let maxFuelUsed = 0;

  for (let iter = 0; iter < 200; iter++) {
    let contextToRun = null;

    for (const ctx of contexts) {
      const status = mem.getExitCondition(ctx.slot);

      if (status === EXIT_DONE || status === EXIT_ASYNC_COMPLETE || status === EXIT_ASYNC_REJECTED) {
        continue;
      }

      if (status === EXIT_AWAIT) {
        continue;
      }

      contextToRun = ctx;
      break;
    }

    if (!contextToRun) break;

    const fuelBefore = 1;
    const result = session.run(contextToRun, fuelBefore);
    const fuelUsed = fuelBefore - (result.fuel || 0);

    if (fuelUsed > maxFuelUsed) {
      maxFuelUsed = fuelUsed;
    }

    // Each step should use at most 1 fuel
    assert(
      fuelUsed <= 1,
      `Step ${iter}: expected fuelUsed<=1, got ${fuelUsed}`
    );

    // If paused status, should have used exactly 1 fuel
    if (result.status === 'paused') {
      assertEquals(
        fuelUsed,
        1,
        `Step ${iter}: expected fuelUsed=1 for paused status, got ${fuelUsed}`
      );
    }

    if (result.status === 'async_call' && result.asyncContext !== undefined) {
      contexts.push(result.asyncContext);
    }

    if (result.status === 'await') {
      airlock.handleAwait(contextToRun.slot);
    }

    if (result.status === 'async_complete') {
      airlock.handleAsyncComplete(contextToRun.slot);
    }

    if (result.status === 'async_rejected') {
      airlock.handleAsyncRejected(contextToRun.slot);
    }

    const mainStatus = mem.getExitCondition(contexts[0].slot);
    if (mainStatus === EXIT_DONE) break;
  }

  assertEquals(session.get(0, 'sum'), 30);
});

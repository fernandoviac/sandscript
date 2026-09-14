/**
 * Tests for suspension API and multi-context execution.
 */

import { assertEquals } from 'https://deno.land/std@0.208.0/assert/mod.ts';
import { createSession } from '../../src/fuel/session.js';
import { parseAndSetup } from './test-helpers.js';
import { CONTEXT_STATUS_FREE } from '../../src/fuel/constants.js';
import { freshSession } from '../../src/host-owned-session.js';

// =============================================================================
// Basic Suspension
// =============================================================================

Deno.test("Suspension: handler can suspend and resolve", async () => {
  const session = freshSession();
  const { airlock } = session;
  const rootGrant = airlock.createRootGrant();

  const id = airlock.register({});
  rootGrant.add(id);

  airlock.setHandler(id, 'delay', ({ args, context }) => {
    return context.suspend(async (resolve) => {
      await new Promise(r => setTimeout(r, 10));
      resolve(args[0] * 2);
    });
  });
  airlock.declare('Api', id);

  parseAndSetup(session, 'Api.delay(21)');
  const result = session.run(0, 10000);

  assertEquals(result.status, 'suspended');

  // Wait for async resolution
  await new Promise(r => setTimeout(r, 50));

  assertEquals(session.result(0), 42);
});

Deno.test("Suspension: function parameters survive a host suspension", async () => {
  const session = freshSession();
  const { airlock } = session;
  const rootGrant = airlock.createRootGrant();
  const identifier = airlock.register({});
  rootGrant.add(identifier);

  let resolvePause;
  let captured;
  airlock.setHandler(identifier, "pause", ({ context }) => {
    return context.suspend((resolve) => {
      resolvePause = resolve;
    });
  });
  airlock.setHandler(identifier, "capture", ({ args }) => {
    captured = args[0];
    return null;
  });
  airlock.declare("Api", identifier);

  parseAndSetup(session, `
    const continueAfterPause = (crewName, locator, factoryArgs) => {
      Api.pause()
      Api.capture({ crewName, locator, factoryArgs })
    }
    continueAfterPause("crew", "module#capability", { value: 7 })
  `);

  const suspended = session.run(0, 10000);
  assertEquals(suspended.status, "suspended");
  resolvePause([]);
  await Promise.resolve();
  for (let index = 0; index < 10 && captured === undefined; index++) {
    session.run(0, 10000);
  }

  assertEquals(captured, {
    crewName: "crew",
    locator: "module#capability",
    factoryArgs: { value: 7 },
  });
});

Deno.test("Suspension: handler can suspend and reject", async () => {
  const session = freshSession();
  const { airlock } = session;
  const rootGrant = airlock.createRootGrant();

  const id = airlock.register({});
  rootGrant.add(id);

  airlock.setHandler(id, 'fail', ({ args, context }) => {
    return context.suspend(async (resolve, reject) => {
      await new Promise(r => setTimeout(r, 10));
      reject(new Error('test error'));
    });
  });
  airlock.declare('Api', id);

  parseAndSetup(session, `
    let caught = false;
    try {
      Api.fail()
    } catch (e) {
      caught = true;
    }
    caught
  `);
  session.run(0, 10000);

  // Wait for async rejection
  await new Promise(r => setTimeout(r, 50));

  // Resume to run the catch block
  session.run(0, 10000);

  assertEquals(session.result(0), true);
});

Deno.test("Suspension: auto-reject on throw", async () => {
  const session = freshSession();
  const { airlock } = session;
  const rootGrant = airlock.createRootGrant();

  const id = airlock.register({});
  rootGrant.add(id);

  airlock.setHandler(id, 'crash', ({ args, context }) => {
    return context.suspend(async (resolve, reject) => {
      throw new Error('Handler crashed');
    });
  });
  airlock.declare('Api', id);

  parseAndSetup(session, `
    let caught = false;
    try {
      Api.crash()
    } catch (e) {
      caught = true;
    }
    caught
  `);
  session.run(0, 10000);

  // Wait for auto-reject
  await new Promise(r => setTimeout(r, 50));

  // Resume to run the catch block
  session.run(0, 10000);

  assertEquals(session.result(0), true);
});

// =============================================================================
// Callbacks in Fresh Contexts
// =============================================================================

Deno.test("Suspension: sync callback returns value directly", () => {
  const session = freshSession();
  const { airlock } = session;
  const mem = session.memoryImage;
  const rootGrant = airlock.createRootGrant();

  const id = airlock.register({});
  rootGrant.add(id);

  airlock.setHandler(id, 'call', ({ args }) => {
    const closureHandle = args[0];

    // Allocate context and set up callback
    const slot = mem.allocateContext();
    airlock.setupCallbackContext(slot, closureHandle, [10]);

    // Run callback to completion
    while (true) {
      const result = airlock.runContext(slot, 1000);
      if (result.status === 'done') {
        const returnValue = airlock.extractResultFromContext(slot);
        mem.freeContext(slot);
        return returnValue;
      }
      if (result.status === 'external_call') {
        const ext = airlock.handleExternalCall(slot, 1000);
        if (!ext.suspended && !ext.threw) airlock.resumeWithValue(slot, ext.result);
        continue;
      }
      if (result.status === 'external_property') {
        airlock.handleExternalProperty(slot, 1000);
        continue;
      }
      throw new Error(`Unexpected status: ${result.status}`);
    }
  });
  airlock.declare('Util', id);

  parseAndSetup(session, 'Util.call((x) => x * 2)');
  session.run(0, 10000);

  assertEquals(session.result(0), 20);
});

Deno.test("Suspension: sync callback with multiple invocations", () => {
  const session = freshSession();
  const { airlock } = session;
  const mem = session.memoryImage;
  const rootGrant = airlock.createRootGrant();

  const id = airlock.register({});
  rootGrant.add(id);

  airlock.setHandler(id, 'reduce', ({ args }) => {
    const [arr, closureHandle, init] = args;
    let acc = init;
    for (const item of arr) {
      // Allocate context and set up callback
      const slot = mem.allocateContext();
      airlock.setupCallbackContext(slot, closureHandle, [acc, item]);

      // Run callback to completion
      while (true) {
        const result = airlock.runContext(slot, 1000);
        if (result.status === 'done') {
          acc = airlock.extractResultFromContext(slot);
          mem.freeContext(slot);
          break;
        }
        if (result.status === 'external_call') {
          const ext = airlock.handleExternalCall(slot, 1000);
          if (!ext.suspended && !ext.threw) airlock.resumeWithValue(slot, ext.result);
          continue;
        }
        if (result.status === 'external_property') {
          airlock.handleExternalProperty(slot, 1000);
          continue;
        }
        throw new Error(`Unexpected status: ${result.status}`);
      }
    }
    return acc;
  });
  airlock.declare('Util', id);

  parseAndSetup(session, 'Util.reduce([1, 2, 3, 4], (a, b) => a + b, 0)');
  session.run(0, 10000);

  assertEquals(session.result(0), 10);
});

Deno.test("Suspension: callback modifies outer variable", () => {
  const session = freshSession();
  const { airlock } = session;
  const mem = session.memoryImage;
  const rootGrant = airlock.createRootGrant();

  const id = airlock.register({});
  rootGrant.add(id);

  airlock.setHandler(id, 'call', ({ args }) => {
    const closureHandle = args[0];

    // Invoke callback 3 times
    for (let i = 0; i < 3; i++) {
      const slot = mem.allocateContext();
      airlock.setupCallbackContext(slot, closureHandle, []);

      while (true) {
        const result = airlock.runContext(slot, 1000);
        if (result.status === 'done') {
          mem.freeContext(slot);
          break;
        }
        if (result.status === 'external_call') {
          const ext = airlock.handleExternalCall(slot, 1000);
          if (!ext.suspended && !ext.threw) airlock.resumeWithValue(slot, ext.result);
          continue;
        }
        if (result.status === 'external_property') {
          airlock.handleExternalProperty(slot, 1000);
          continue;
        }
        throw new Error(`Unexpected status: ${result.status}`);
      }
    }
  });
  airlock.declare('Util', id);

  parseAndSetup(session, `
    let count = 0;
    Util.call(() => { count = count + 1; });
    count
  `);
  session.run(0, 10000);

  assertEquals(session.result(0), 3);
});

Deno.test("Suspension: callback reads closure variable", () => {
  const session = freshSession();
  const { airlock } = session;
  const mem = session.memoryImage;
  const rootGrant = airlock.createRootGrant();

  const id = airlock.register({});
  rootGrant.add(id);

  airlock.setHandler(id, 'call', ({ args }) => {
    const closureHandle = args[0];

    const slot = mem.allocateContext();
    airlock.setupCallbackContext(slot, closureHandle, []);

    while (true) {
      const result = airlock.runContext(slot, 1000);
      if (result.status === 'done') {
        const returnValue = airlock.extractResultFromContext(slot);
        mem.freeContext(slot);
        return returnValue;
      }
      if (result.status === 'external_call') {
        const ext = airlock.handleExternalCall(slot, 1000);
        if (!ext.suspended && !ext.threw) airlock.resumeWithValue(slot, ext.result);
        continue;
      }
      if (result.status === 'external_property') {
        airlock.handleExternalProperty(slot, 1000);
        continue;
      }
      throw new Error(`Unexpected status: ${result.status}`);
    }
  });
  airlock.declare('Util', id);

  parseAndSetup(session, `
    let x = 42;
    Util.call(() => x)
  `);
  session.run(0, 10000);

  assertEquals(session.result(0), 42);
});

// =============================================================================
// Nested Suspension (callback that suspends)
// =============================================================================

Deno.test("Suspension: callback that suspends returns Promise", async () => {
  const session = freshSession();
  const { airlock } = session;
  const mem = session.memoryImage;
  const rootGrant = airlock.createRootGrant();

  const asyncId = airlock.register({});
  rootGrant.add(asyncId);
  airlock.setHandler(asyncId, 'delay', ({ args, context }) => {
    return context.suspend(async (resolve) => {
      await new Promise(r => setTimeout(r, 10));
      resolve(args[0]);
    });
  });
  airlock.declare('Async', asyncId);

  const utilId = airlock.register({});
  rootGrant.add(utilId);
  airlock.setHandler(utilId, 'callAsync', ({ args, context }) => {
    // For callbacks that may suspend, we use a different pattern:
    // We suspend ourselves and run the callback context to completion,
    // handling both external calls and nested suspensions.
    return context.suspend(async (resolve, reject) => {
      const closureHandle = args[0];

      // Allocate context and set up callback
      const slot = mem.allocateContext();
      airlock.setupCallbackContext(slot, closureHandle, [42]);

      // Run callback, handling both external calls and suspensions
      const runToCompletion = async () => {
        while (true) {
          const result = airlock.runContext(slot, 1000);
          if (result.status === 'done') {
            const returnValue = airlock.extractResultFromContext(slot);
            mem.freeContext(slot);
            return returnValue;
          }
          if (result.status === 'external_call') {
            // Handle the external call (which may itself suspend)
            const ext = airlock.handleExternalCall(slot, 1000);
            if (ext.suspended) {
              // Wait until exit condition is cleared (resolve callback clears it)
              while (mem.getExitCondition(slot) !== 0) {
                await new Promise(r => setTimeout(r, 10));
              }
            } else if (!ext.threw) {
              airlock.resumeWithValue(slot, ext.result);
            }
            continue;
          }
          if (result.status === 'external_property') {
            airlock.handleExternalProperty(slot, 1000);
            continue;
          }
          throw new Error(`Unexpected status: ${result.status}`);
        }
      };

      try {
        const value = await runToCompletion();
        resolve(value);
      } catch (e) {
        reject(e);
      }
    });
  });
  airlock.declare('Util', utilId);

  parseAndSetup(session, `
    Util.callAsync((x) => Async.delay(x * 2))
  `);
  session.run(0, 10000);

  // Wait for all async operations
  await new Promise(r => setTimeout(r, 150));

  // Resume execution after async completes
  session.run(0, 10000);

  assertEquals(session.result(0), 84);
});

// =============================================================================
// Stale Continuation Detection
// =============================================================================

Deno.test("Suspension: stale continuation is ignored", async () => {
  const session = freshSession();
  const { airlock } = session;
  const rootGrant = airlock.createRootGrant();

  const id = airlock.register({});
  rootGrant.add(id);

  let resolvers = [];
  airlock.setHandler(id, 'capture', ({ args, context }) => {
    return context.suspend((resolve, reject) => {
      resolvers.push(resolve);
    });
  });
  airlock.declare('Api', id);

  // First capture
  parseAndSetup(session, 'Api.capture()');
  session.run(0, 10000);

  // Capture the first resolver
  const firstResolver = resolvers[0];

  // Parse and run again - this creates a new suspension
  parseAndSetup(session, 'Api.capture()');
  session.run(0, 10000);

  // Resolve the second (current) one
  resolvers[1](200);
  await new Promise(r => setTimeout(r, 10));

  assertEquals(session.result(0), 200);

  // Now try to resolve the first (stale) one - should be ignored
  firstResolver(100);
  await new Promise(r => setTimeout(r, 10));

  // Result should still be 200, not 100
  assertEquals(session.result(0), 200);
});

// =============================================================================
// Multiple Contexts
// =============================================================================

Deno.test("Suspension: nested callbacks work correctly", () => {
  const session = freshSession();
  const { airlock } = session;
  const mem = session.memoryImage;
  const rootGrant = airlock.createRootGrant();

  const id = airlock.register({});
  rootGrant.add(id);

  airlock.setHandler(id, 'map', ({ args }) => {
    const [arr, closureHandle] = args;
    const results = [];
    for (const item of arr) {
      const slot = mem.allocateContext();
      airlock.setupCallbackContext(slot, closureHandle, [item]);

      while (true) {
        const result = airlock.runContext(slot, 1000);
        if (result.status === 'done') {
          const returnValue = airlock.extractResultFromContext(slot);
          mem.freeContext(slot);
          results.push(returnValue);
          break;
        }
        if (result.status === 'external_call') {
          const ext = airlock.handleExternalCall(slot, 1000);
          if (!ext.suspended && !ext.threw) airlock.resumeWithValue(slot, ext.result);
          continue;
        }
        if (result.status === 'external_property') {
          airlock.handleExternalProperty(slot, 1000);
          continue;
        }
        throw new Error(`Unexpected status: ${result.status}`);
      }
    }
    return results;
  });
  airlock.declare('Util', id);

  parseAndSetup(session, `
    Util.map([1, 2, 3], (x) => x * 2)
  `);
  session.run(0, 10000);

  const result = session.result(0);
  assertEquals(result[0], 2);
  assertEquals(result[1], 4);
  assertEquals(result[2], 6);
});

Deno.test("Suspension: callback calling callback", () => {
  const session = freshSession();
  const { airlock } = session;
  const mem = session.memoryImage;
  const rootGrant = airlock.createRootGrant();

  const id = airlock.register({});
  rootGrant.add(id);

  airlock.setHandler(id, 'call', ({ args }) => {
    const closureHandle = args[0];

    const slot = mem.allocateContext();
    airlock.setupCallbackContext(slot, closureHandle, []);

    while (true) {
      const result = airlock.runContext(slot, 1000);
      if (result.status === 'done') {
        const returnValue = airlock.extractResultFromContext(slot);
        mem.freeContext(slot);
        return returnValue;
      }
      if (result.status === 'external_call') {
        const ext = airlock.handleExternalCall(slot, 1000);
        if (!ext.suspended && !ext.threw) airlock.resumeWithValue(slot, ext.result);
        continue;
      }
      if (result.status === 'external_property') {
        airlock.handleExternalProperty(slot, 1000);
        continue;
      }
      throw new Error(`Unexpected status: ${result.status}`);
    }
  });
  airlock.declare('Util', id);

  parseAndSetup(session, `
    Util.call(() => Util.call(() => 42))
  `);
  session.run(0, 10000);

  assertEquals(session.result(0), 42);
});

// =============================================================================
// GC with Suspended Contexts
// =============================================================================

Deno.test("Suspension: GC preserves suspended context roots", async () => {
  const session = freshSession();
  const { airlock } = session;
  const rootGrant = airlock.createRootGrant();

  const id = airlock.register({});
  rootGrant.add(id);

  let resolveCapture = null;
  airlock.setHandler(id, 'suspend', ({ args, context }) => {
    return context.suspend((resolve) => {
      resolveCapture = resolve;
    });
  });
  airlock.declare('Api', id);

  // Create an object, suspend with reference to it on pending stack
  parseAndSetup(session, `
    let obj = { value: 42, nested: { deep: 100 } };
    Api.suspend();
    obj.value + obj.nested.deep
  `);
  session.run(0, 10000);

  // At this point, obj is only reachable from suspended context's scope
  // Running GC should NOT collect it
  session.gc();

  // Resume the context - if GC corrupted obj, this will fail
  resolveCapture(null);
  await new Promise(r => setTimeout(r, 10));

  // Run to complete execution after async resolves
  session.run(0, 10000);

  assertEquals(session.result(0), 142);
});

Deno.test("Suspension: GC preserves multiple suspended contexts", async () => {
  const session = freshSession();
  const { airlock } = session;
  const rootGrant = airlock.createRootGrant();

  const id = airlock.register({});
  rootGrant.add(id);

  const resolvers = [];
  airlock.setHandler(id, 'suspend', ({ args, context }) => {
    return context.suspend((resolve) => {
      resolvers.push({ resolve, value: args[0] });
    });
  });
  airlock.declare('Api', id);

  // First suspension
  parseAndSetup(session, `
    let a = { tag: "first", data: [1, 2, 3] };
    Api.suspend(a);
    a.tag
  `);
  session.run(0, 10000);

  // Second suspension (creates new context)
  parseAndSetup(session, `
    let b = { tag: "second", data: [4, 5, 6] };
    Api.suspend(b);
    b.tag
  `);
  session.run(0, 10000);

  // Both contexts are now suspended with objects only reachable from them
  // GC should preserve both
  session.gc();

  // Resolve second first (out of order)
  resolvers[1].resolve(null);
  await new Promise(r => setTimeout(r, 10));
  session.run(0, 10000);
  assertEquals(session.result(0), "second");

  // Resolve first
  resolvers[0].resolve(null);
  await new Promise(r => setTimeout(r, 10));
  session.run(0, 10000);
  // Note: result will be from most recently resolved context
});

Deno.test("Suspension: GC during callback preserves callback context", async () => {
  const session = freshSession();
  const { airlock } = session;
  const mem = session.memoryImage;
  const rootGrant = airlock.createRootGrant();

  const asyncId = airlock.register({});
  rootGrant.add(asyncId);

  let resolveCapture = null;
  let gcRan = false;
  airlock.setHandler(asyncId, 'delay', ({ args, context }) => {
    return context.suspend((resolve) => {
      resolveCapture = { resolve, value: args[0] };
    });
  });
  airlock.declare('Async', asyncId);

  const utilId = airlock.register({});
  rootGrant.add(utilId);
  airlock.setHandler(utilId, 'callAsync', ({ args, context }) => {
    return context.suspend(async (resolve, reject) => {
      const closureHandle = args[0];

      // Allocate context and set up callback
      const slot = mem.allocateContext();
      airlock.setupCallbackContext(slot, closureHandle, []);

      // Run callback, handling suspension
      const runToCompletion = async () => {
        while (true) {
          const result = airlock.runContext(slot, 1000);
          if (result.status === 'done') {
            const returnValue = airlock.extractResultFromContext(slot);
            mem.freeContext(slot);
            return returnValue;
          }
          if (result.status === 'external_call') {
            const ext = airlock.handleExternalCall(slot, 1000);
            if (ext.suspended) {
              // Handler returned a suspension - wait until exit condition is cleared
              // (resolve callback clears it to signal ready to resume)
              while (mem.getExitCondition(slot) !== 0) {
                await new Promise(r => setTimeout(r, 10));
              }
            } else if (!ext.threw) {
              airlock.resumeWithValue(slot, ext.result);
            }
            continue;
          }
          if (result.status === 'external_property') {
            airlock.handleExternalProperty(slot, 1000);
            continue;
          }
          throw new Error(`Unexpected status: ${result.status}`);
        }
      };

      try {
        const value = await runToCompletion();
        resolve(value);
      } catch (e) {
        reject(e);
      }
    });
  });
  airlock.declare('Util', utilId);

  parseAndSetup(session, `
    let obj = { value: 999 };
    Util.callAsync(() => {
      let local = obj.value;
      return Async.delay(local)
    })
  `);
  const result = session.run(0, 10000);

  // Wait for initial suspension
  assertEquals(result.status, 'suspended');

  // Wait for callback to reach inner suspension
  await new Promise(r => setTimeout(r, 30));

  // Run GC while callback context is suspended (not running)
  session.gc();
  gcRan = true;

  // Now resolve the inner suspension
  resolveCapture.resolve(resolveCapture.value);
  await new Promise(r => setTimeout(r, 100));

  // Resume execution after async completes
  session.run(0, 10000);

  // The main context should now be done with the result
  assertEquals(session.result(0), 999);
  assertEquals(gcRan, true);
});

// =============================================================================
// Context Reuse (Freelist)
// =============================================================================

Deno.test("Suspension: freed context slot is reused", () => {
  const session = freshSession();
  const { airlock, memoryImage } = session;
  const rootGrant = airlock.createRootGrant();

  const id = airlock.register({});
  rootGrant.add(id);

  // Track context counts
  let maxContexts = 0;

  airlock.setHandler(id, 'call', ({ args }) => {
    const closureHandle = args[0];
    const currentCount = memoryImage.getContextCount();
    if (currentCount > maxContexts) {
      maxContexts = currentCount;
    }

    const slot = memoryImage.allocateContext();
    airlock.setupCallbackContext(slot, closureHandle, []);

    while (true) {
      const result = airlock.runContext(slot, 1000);
      if (result.status === 'done') {
        const returnValue = airlock.extractResultFromContext(slot);
        memoryImage.freeContext(slot);
        return returnValue;
      }
      if (result.status === 'external_call') {
        const ext = airlock.handleExternalCall(slot, 1000);
        if (!ext.suspended && !ext.threw) airlock.resumeWithValue(slot, ext.result);
        continue;
      }
      if (result.status === 'external_property') {
        airlock.handleExternalProperty(slot, 1000);
        continue;
      }
      throw new Error(`Unexpected status: ${result.status}`);
    }
  });
  airlock.declare('Util', id);

  // Call callback many times - each should reuse context, not allocate new
  parseAndSetup(session, `
    let sum = 0;
    for (let i = 0; i < 10; i = i + 1) {
      sum = sum + Util.call(() => i);
    }
    sum
  `);
  session.run(0, 10000);

  // Should be 0+1+2+...+9 = 45
  assertEquals(session.result(0), 45);

  // Context count should be low despite many callback invocations
  // We expect: context 0 (main) + context 1 (callback, reused)
  // The freelist should prevent unbounded growth
  assertEquals(maxContexts <= 3, true, `Expected max 3 contexts but got ${maxContexts}`);
});

Deno.test("Suspension: nested callbacks reuse freed contexts", () => {
  const session = freshSession();
  const { airlock, memoryImage } = session;
  const rootGrant = airlock.createRootGrant();

  const id = airlock.register({});
  rootGrant.add(id);

  airlock.setHandler(id, 'call', ({ args }) => {
    const closureHandle = args[0];

    const slot = memoryImage.allocateContext();
    airlock.setupCallbackContext(slot, closureHandle, []);

    while (true) {
      const result = airlock.runContext(slot, 1000);
      if (result.status === 'done') {
        const returnValue = airlock.extractResultFromContext(slot);
        memoryImage.freeContext(slot);
        return returnValue;
      }
      if (result.status === 'external_call') {
        const ext = airlock.handleExternalCall(slot, 1000);
        if (!ext.suspended && !ext.threw) airlock.resumeWithValue(slot, ext.result);
        continue;
      }
      if (result.status === 'external_property') {
        airlock.handleExternalProperty(slot, 1000);
        continue;
      }
      throw new Error(`Unexpected status: ${result.status}`);
    }
  });
  airlock.declare('Util', id);

  // Deeply nested callbacks - each level allocates context, but they get reused
  parseAndSetup(session, `
    Util.call(() =>
      Util.call(() =>
        Util.call(() =>
          Util.call(() =>
            Util.call(() => 42)
          )
        )
      )
    )
  `);
  session.run(0, 10000);

  assertEquals(session.result(0), 42);

  // After completion, we should have freed contexts available for reuse
  // Check that some slots have CONTEXT_STATUS_FREE
  let freeCount = 0;
  const contextCount = memoryImage.getContextCount();
  for (let i = 0; i < contextCount; i++) {
    if (memoryImage.getExitCondition(i) === CONTEXT_STATUS_FREE) {
      freeCount++;
    }
  }
  assertEquals(freeCount > 0, true, "Should have freed contexts available");
});

// =============================================================================
// Multiple Concurrent Suspended Contexts
// =============================================================================

Deno.test("Suspension: multiple concurrent callback suspensions", async () => {
  // This tests multiple callbacks all suspended at the same time
  const session = freshSession();
  const { airlock } = session;
  const mem = session.memoryImage;
  const rootGrant = airlock.createRootGrant();

  const id = airlock.register({});
  rootGrant.add(id);

  const suspended = [];
  airlock.setHandler(id, 'asyncOp', ({ args, context }) => {
    return context.suspend((resolve) => {
      suspended.push({ value: args[0], resolve });
    });
  });

  // Process multiple callbacks concurrently
  let results = [];
  airlock.setHandler(id, 'processAll', ({ args, context }) => {
    return context.suspend(async (resolve, reject) => {
      const closureHandles = args[0];
      try {
        // Invoke all callbacks concurrently - each will suspend
        const promises = closureHandles.map(closureHandle => {
          return new Promise((resolveCallback) => {
            const slot = mem.allocateContext();
            airlock.setupCallbackContext(slot, closureHandle, []);

            const runCallback = async () => {
              while (true) {
                const result = airlock.runContext(slot, 1000);
                if (result.status === 'done') {
                  const returnValue = airlock.extractResultFromContext(slot);
                  mem.freeContext(slot);
                  resolveCallback(returnValue);
                  return;
                }
                if (result.status === 'external_call') {
                  const ext = airlock.handleExternalCall(slot, 1000);
                  if (ext.suspended) {
                    while (mem.getExitCondition(slot) !== 0) {
                      await new Promise(r => setTimeout(r, 10));
                    }
                  } else if (!ext.threw) {
                    airlock.resumeWithValue(slot, ext.result);
                  }
                  continue;
                }
                if (result.status === 'external_property') {
                  airlock.handleExternalProperty(slot, 1000);
                  continue;
                }
                throw new Error(`Unexpected status: ${result.status}`);
              }
            };
            runCallback();
          });
        });
        // Wait for all to complete
        const values = await Promise.all(promises);
        results = values;
        resolve(values.reduce((a, b) => a + b, 0));
      } catch (e) {
        reject(e);
      }
    });
  });
  airlock.declare('Api', id);

  parseAndSetup(session, `
    let callbacks = [
      () => Api.asyncOp(10),
      () => Api.asyncOp(20),
      () => Api.asyncOp(30)
    ];
    Api.processAll(callbacks)
  `);
  session.run(0, 10000);

  // Wait for callbacks to run and reach their suspensions
  await new Promise(r => setTimeout(r, 50));

  // All three callbacks should be suspended
  assertEquals(suspended.length, 3);

  // Resolve out of order: 2, 0, 1
  suspended[1].resolve(20);
  suspended[2].resolve(30);
  suspended[0].resolve(10);

  await new Promise(r => setTimeout(r, 100));

  // Resume execution after async completes
  session.run(0, 10000);

  // Final result should be sum
  assertEquals(session.result(0), 60);
});

Deno.test("Suspension: concurrent callbacks share scope correctly", async () => {
  // Test that multiple suspended callback contexts can share heap state
  const session = freshSession();
  const { airlock } = session;
  const mem = session.memoryImage;
  const rootGrant = airlock.createRootGrant();

  const id = airlock.register({});
  rootGrant.add(id);

  const suspended = [];
  airlock.setHandler(id, 'asyncOp', ({ args, context }) => {
    return context.suspend((resolve) => {
      suspended.push({ value: args[0], resolve });
    });
  });

  // Invoke callbacks that all read from shared object
  airlock.setHandler(id, 'parallel', ({ args, context }) => {
    return context.suspend(async (resolve, reject) => {
      const [obj, closureHandles] = args;
      try {
        const promises = closureHandles.map(closureHandle => {
          return new Promise((resolveCallback) => {
            const slot = mem.allocateContext();
            airlock.setupCallbackContext(slot, closureHandle, [obj]);

            const runCallback = async () => {
              while (true) {
                const result = airlock.runContext(slot, 1000);
                if (result.status === 'done') {
                  const returnValue = airlock.extractResultFromContext(slot);
                  mem.freeContext(slot);
                  resolveCallback(returnValue);
                  return;
                }
                if (result.status === 'external_call') {
                  const ext = airlock.handleExternalCall(slot, 1000);
                  if (ext.suspended) {
                    while (mem.getExitCondition(slot) !== 0) {
                      await new Promise(r => setTimeout(r, 10));
                    }
                  } else if (!ext.threw) {
                    airlock.resumeWithValue(slot, ext.result);
                  }
                  continue;
                }
                if (result.status === 'external_property') {
                  airlock.handleExternalProperty(slot, 1000);
                  continue;
                }
                throw new Error(`Unexpected status: ${result.status}`);
              }
            };
            runCallback();
          });
        });
        const values = await Promise.all(promises);
        resolve(values);
      } catch (e) {
        reject(e);
      }
    });
  });
  airlock.declare('Api', id);

  parseAndSetup(session, `
    let shared = { count: 100 };
    let callbacks = [
      (s) => { let x = s.count; return Api.asyncOp(x + 1) },
      (s) => { let y = s.count; return Api.asyncOp(y + 2) },
      (s) => { let z = s.count; return Api.asyncOp(z + 3) }
    ];
    Api.parallel(shared, callbacks)
  `);
  session.run(0, 10000);

  // Wait for callbacks to run and reach their suspensions
  await new Promise(r => setTimeout(r, 50));

  // All three callbacks suspended, each accessed shared.count
  assertEquals(suspended.length, 3);

  // Resolve them
  for (const s of suspended) {
    s.resolve(s.value);
  }

  await new Promise(r => setTimeout(r, 100));

  // Resume execution after async completes
  session.run(0, 10000);

  const result = session.result(0);
  assertEquals(result.length, 3);
  assertEquals(result[0], 101);
  assertEquals(result[1], 102);
  assertEquals(result[2], 103);
});

// =============================================================================
// Additional Context Allocation Tests
// =============================================================================

Deno.test("Context: rapid allocate/free cycles", () => {
  const session = freshSession();
  const { airlock, memoryImage } = session;
  const rootGrant = airlock.createRootGrant();

  const id = airlock.register({});
  rootGrant.add(id);

  let maxContexts = 0;
  let callCount = 0;

  airlock.setHandler(id, 'call', ({ args }) => {
    const closureHandle = args[0];
    callCount++;
    const current = memoryImage.getContextCount();
    if (current > maxContexts) maxContexts = current;

    const slot = memoryImage.allocateContext();
    airlock.setupCallbackContext(slot, closureHandle, []);

    while (true) {
      const result = airlock.runContext(slot, 1000);
      if (result.status === 'done') {
        const returnValue = airlock.extractResultFromContext(slot);
        memoryImage.freeContext(slot);
        return returnValue;
      }
      if (result.status === 'external_call') {
        const ext = airlock.handleExternalCall(slot, 1000);
        if (!ext.suspended && !ext.threw) airlock.resumeWithValue(slot, ext.result);
        continue;
      }
      if (result.status === 'external_property') {
        airlock.handleExternalProperty(slot, 1000);
        continue;
      }
      throw new Error(`Unexpected status: ${result.status}`);
    }
  });
  airlock.declare('Util', id);

  // Rapid sequential calls - contexts should be reused
  parseAndSetup(session, `
    let sum = 0;
    for (let i = 0; i < 50; i = i + 1) {
      sum = sum + Util.call(() => i);
    }
    sum
  `);
  session.run(0, 10000);

  // Sum of 0..49 = 1225
  assertEquals(session.result(0), 1225);
  assertEquals(callCount, 50);
  // Should reuse contexts, not allocate 50+
  assertEquals(maxContexts <= 3, true, `Expected max 3 contexts but got ${maxContexts}`);
});

Deno.test("Context: alternating allocate/free pattern", () => {
  const session = freshSession();
  const { airlock, memoryImage } = session;
  const rootGrant = airlock.createRootGrant();

  const id = airlock.register({});
  rootGrant.add(id);

  airlock.setHandler(id, 'call', ({ args }) => {
    const closureHandle = args[0];

    const slot = memoryImage.allocateContext();
    airlock.setupCallbackContext(slot, closureHandle, []);

    while (true) {
      const result = airlock.runContext(slot, 1000);
      if (result.status === 'done') {
        const returnValue = airlock.extractResultFromContext(slot);
        memoryImage.freeContext(slot);
        return returnValue;
      }
      if (result.status === 'external_call') {
        const ext = airlock.handleExternalCall(slot, 1000);
        if (!ext.suspended && !ext.threw) airlock.resumeWithValue(slot, ext.result);
        continue;
      }
      if (result.status === 'external_property') {
        airlock.handleExternalProperty(slot, 1000);
        continue;
      }
      throw new Error(`Unexpected status: ${result.status}`);
    }
  });
  airlock.declare('Util', id);

  parseAndSetup(session, `
    Util.call(() => 1);
    Util.call(() => 2);
    Util.call(() => 3);
    "done"
  `);
  session.run(0, 10000);

  assertEquals(session.result(0), "done");
  // After callbacks complete, freed contexts should be available
  // Context count should stay low due to reuse
  assertEquals(memoryImage.getContextCount() <= 3, true,
    `Expected max 3 contexts but got ${memoryImage.getContextCount()}`);
});

Deno.test("Context: deeply nested callbacks all complete", () => {
  const session = freshSession();
  const { airlock, memoryImage } = session;
  const rootGrant = airlock.createRootGrant();

  const id = airlock.register({});
  rootGrant.add(id);

  airlock.setHandler(id, 'nest', ({ args }) => {
    const [depth, closureHandle] = args;

    const slot = memoryImage.allocateContext();
    if (depth <= 0) {
      airlock.setupCallbackContext(slot, closureHandle, []);
    } else {
      airlock.setupCallbackContext(slot, closureHandle, [depth - 1]);
    }

    while (true) {
      const result = airlock.runContext(slot, 1000);
      if (result.status === 'done') {
        const returnValue = airlock.extractResultFromContext(slot);
        memoryImage.freeContext(slot);
        return returnValue;
      }
      if (result.status === 'external_call') {
        const ext = airlock.handleExternalCall(slot, 1000);
        if (!ext.suspended && !ext.threw) airlock.resumeWithValue(slot, ext.result);
        continue;
      }
      if (result.status === 'external_property') {
        airlock.handleExternalProperty(slot, 1000);
        continue;
      }
      throw new Error(`Unexpected status: ${result.status}`);
    }
  });
  airlock.declare('Util', id);

  parseAndSetup(session, `
    let depth = 0;
    Util.nest(10, (d) => {
      if (d === undefined) {
        return depth;
      }
      depth = depth + 1;
      return Util.nest(d, (d2) => {
        if (d2 === undefined) {
          return depth;
        }
        depth = depth + 1;
        return Util.nest(d2, (d3) => {
          if (d3 === undefined) {
            return depth;
          }
          depth = depth + 1;
          return Util.nest(d3, (d4) => d4 === undefined ? depth : depth);
        });
      });
    })
  `);
  session.run(0, 10000);

  // Verify freed contexts exist after deep nesting completes
  let freeCount = 0;
  const contextCount = memoryImage.getContextCount();
  for (let i = 0; i < contextCount; i++) {
    if (memoryImage.getExitCondition(i) === CONTEXT_STATUS_FREE) {
      freeCount++;
    }
  }
  assertEquals(freeCount > 0, true, "Should have freed contexts after completion");
});

// =============================================================================
// Additional GC + Context Tests
// =============================================================================

Deno.test("GC: collects garbage while context is suspended", async () => {
  const session = freshSession();
  const { airlock, memoryImage } = session;
  const rootGrant = airlock.createRootGrant();

  const id = airlock.register({});
  rootGrant.add(id);

  let resolveCapture = null;
  airlock.setHandler(id, 'suspend', ({ context }) => {
    return context.suspend((resolve) => {
      resolveCapture = resolve;
    });
  });
  airlock.declare('Api', id);

  // Create garbage and a live object, then suspend
  parseAndSetup(session, `
    let garbage1 = { waste: [1, 2, 3, 4, 5] };
    let garbage2 = { more: { waste: true } };
    let keeper = { important: 42 };
    garbage1 = null;
    garbage2 = null;
    Api.suspend();
    keeper.important
  `);

  const result = session.run(0, 10000);
  assertEquals(result.status, 'suspended');

  // Run GC while suspended - should collect garbage but preserve keeper
  const heapBefore = memoryImage.heapUsage().used;
  session.gc();
  const heapAfter = memoryImage.heapUsage().used;

  assertEquals(heapAfter < heapBefore, true, "GC should collect garbage while suspended");

  // Resume and verify keeper survived
  resolveCapture(null);
  await new Promise(r => setTimeout(r, 10));

  // Resume execution after async completes
  session.run(0, 10000);

  assertEquals(session.result(0), 42);
});

Deno.test("GC: context 0 suspended, GC preserves its scope", async () => {
  const session = freshSession();
  const { airlock } = session;
  const rootGrant = airlock.createRootGrant();

  const id = airlock.register({});
  rootGrant.add(id);

  let resolveCapture = null;
  airlock.setHandler(id, 'suspend', ({ context }) => {
    return context.suspend((resolve) => {
      resolveCapture = resolve;
    });
  });
  airlock.declare('Api', id);

  parseAndSetup(session, `
    let complexObj = {
      nested: {
        deep: {
          value: 999
        }
      },
      array: [1, 2, 3, { inner: 1 }]
    };
    Api.suspend();
    complexObj.nested.deep.value + complexObj.array[3].inner
  `);

  session.run(0, 10000);

  // GC with context 0 suspended
  session.gc();
  session.gc(); // Multiple cycles

  resolveCapture(null);
  await new Promise(r => setTimeout(r, 10));

  // Resume execution after async completes
  session.run(0, 10000);

  // 999 + 1 = 1000
  assertEquals(session.result(0), 1000);
});

Deno.test("GC: object reachable only from suspended callback context", async () => {
  const session = freshSession();
  const { airlock } = session;
  const mem = session.memoryImage;
  const rootGrant = airlock.createRootGrant();

  const asyncId = airlock.register({});
  rootGrant.add(asyncId);

  let resolveCapture = null;
  airlock.setHandler(asyncId, 'delay', ({ args, context }) => {
    return context.suspend((resolve) => {
      resolveCapture = { resolve, expected: args[0] };
    });
  });
  airlock.declare('Async', asyncId);

  const utilId = airlock.register({});
  rootGrant.add(utilId);
  airlock.setHandler(utilId, 'callAsync', ({ args, context }) => {
    return context.suspend(async (resolve, reject) => {
      const closureHandle = args[0];

      const slot = mem.allocateContext();
      airlock.setupCallbackContext(slot, closureHandle, []);

      const runCallback = async () => {
        while (true) {
          const result = airlock.runContext(slot, 1000);
          if (result.status === 'done') {
            const returnValue = airlock.extractResultFromContext(slot);
            mem.freeContext(slot);
            resolve(returnValue);
            return;
          }
          if (result.status === 'external_call') {
            const ext = airlock.handleExternalCall(slot, 1000);
            if (ext.suspended) {
              while (mem.getExitCondition(slot) !== 0) {
                await new Promise(r => setTimeout(r, 10));
              }
            } else if (!ext.threw) {
              airlock.resumeWithValue(slot, ext.result);
            }
            continue;
          }
          if (result.status === 'external_property') {
            airlock.handleExternalProperty(slot, 1000);
            continue;
          }
          reject(new Error(`Unexpected status: ${result.status}`));
          return;
        }
      };
      runCallback();
    });
  });
  airlock.declare('Util', utilId);

  // The localObj is only reachable from the callback context's scope
  parseAndSetup(session, `
    Util.callAsync(() => {
      let localObj = { secret: 12345 };
      return Async.delay(localObj.secret)
    })
  `);

  session.run(0, 10000);

  // Wait for callback to reach its inner suspension
  await new Promise(r => setTimeout(r, 50));

  // localObj is only in callback context's scope, not main context
  // GC should preserve it since callback context is still active
  session.gc();

  resolveCapture.resolve(resolveCapture.expected);
  await new Promise(r => setTimeout(r, 100));

  // Resume execution after async completes
  session.run(0, 10000);

  assertEquals(session.result(0), 12345);
});

Deno.test("GC: cross-context object reference survives", async () => {
  const session = freshSession();
  const { airlock } = session;
  const mem = session.memoryImage;
  const rootGrant = airlock.createRootGrant();

  const id = airlock.register({});
  rootGrant.add(id);

  const suspended = [];
  airlock.setHandler(id, 'suspend', ({ args, context }) => {
    return context.suspend((resolve) => {
      suspended.push({ resolve, value: args[0] });
    });
  });

  airlock.setHandler(id, 'parallel', ({ args, context }) => {
    return context.suspend(async (resolve, reject) => {
      const closureHandles = args[0];
      try {
        const promises = closureHandles.map(closureHandle => {
          return new Promise((resolveCallback) => {
            const slot = mem.allocateContext();
            airlock.setupCallbackContext(slot, closureHandle, []);

            const runCallback = async () => {
              while (true) {
                const result = airlock.runContext(slot, 1000);
                if (result.status === 'done') {
                  const returnValue = airlock.extractResultFromContext(slot);
                  mem.freeContext(slot);
                  resolveCallback(returnValue);
                  return;
                }
                if (result.status === 'external_call') {
                  const ext = airlock.handleExternalCall(slot, 1000);
                  if (ext.suspended) {
                    while (mem.getExitCondition(slot) !== 0) {
                      await new Promise(r => setTimeout(r, 10));
                    }
                  } else if (!ext.threw) {
                    airlock.resumeWithValue(slot, ext.result);
                  }
                  continue;
          }
          if (result.status === 'external_property') {
            airlock.handleExternalProperty(slot, 1000);
            continue;
          }
                throw new Error(`Unexpected status: ${result.status}`);
              }
            };
            runCallback();
          });
        });
        const values = await Promise.all(promises);
        resolve(values);
      } catch (e) {
        reject(e);
      }
    });
  });
  airlock.declare('Api', id);

  // shared is in main context, both callbacks reference it
  parseAndSetup(session, `
    let shared = { value: 100 };
    let callbacks = [
      () => Api.suspend(shared.value + 1),
      () => Api.suspend(shared.value + 2)
    ];
    Api.parallel(callbacks)
  `);

  session.run(0, 10000);

  // Wait for callbacks to run and reach their suspensions
  await new Promise(r => setTimeout(r, 50));

  // Both callbacks suspended, shared object must survive
  assertEquals(suspended.length, 2);

  // GC while both contexts reference shared
  session.gc();

  // Resolve both
  suspended[0].resolve(suspended[0].value);
  suspended[1].resolve(suspended[1].value);

  await new Promise(r => setTimeout(r, 50));

  // Resume execution after async completes
  session.run(0, 10000);

  const result = session.result(0);
  assertEquals(result[0], 101);
  assertEquals(result[1], 102);
});

Deno.test("GC: freelist integrity after collection", () => {
  const session = freshSession();
  const { airlock, memoryImage } = session;
  const rootGrant = airlock.createRootGrant();

  const id = airlock.register({});
  rootGrant.add(id);

  airlock.setHandler(id, 'call', ({ args }) => {
    const closureHandle = args[0];

    const slot = memoryImage.allocateContext();
    airlock.setupCallbackContext(slot, closureHandle, []);

    while (true) {
      const result = airlock.runContext(slot, 1000);
      if (result.status === 'done') {
        const returnValue = airlock.extractResultFromContext(slot);
        memoryImage.freeContext(slot);
        return returnValue;
      }
      if (result.status === 'external_call') {
        const ext = airlock.handleExternalCall(slot, 1000);
        if (!ext.suspended && !ext.threw) airlock.resumeWithValue(slot, ext.result);
        continue;
      }
      if (result.status === 'external_property') {
        airlock.handleExternalProperty(slot, 1000);
        continue;
      }
      throw new Error(`Unexpected status: ${result.status}`);
    }
  });
  airlock.declare('Util', id);

  // Create many callbacks, then let them complete
  parseAndSetup(session, `
    let results = [];
    for (let i = 0; i < 10; i = i + 1) {
      results.push(Util.call(() => i * 2));
    }
    results
  `);
  session.run(0, 10000);

  // Count free contexts before GC
  let freeCountBefore = 0;
  const contextCountBefore = memoryImage.getContextCount();
  for (let i = 0; i < contextCountBefore; i++) {
    if (memoryImage.getExitCondition(i) === CONTEXT_STATUS_FREE) {
      freeCountBefore++;
    }
  }

  // GC shouldn't corrupt context status
  session.gc();

  // Count free contexts after GC
  let freeCountAfter = 0;
  const contextCountAfter = memoryImage.getContextCount();
  for (let i = 0; i < contextCountAfter; i++) {
    if (memoryImage.getExitCondition(i) === CONTEXT_STATUS_FREE) {
      freeCountAfter++;
    }
  }

  // Free count should be preserved
  assertEquals(freeCountAfter, freeCountBefore);

  // Verify we can still allocate and use contexts
  parseAndSetup(session, `Util.call(() => 42)`);
  session.run(0, 10000);
  assertEquals(session.result(0), 42);
});

Deno.test("GC: stress test with interleaved suspension and collection", async () => {
  const session = freshSession();
  const { airlock } = session;
  const rootGrant = airlock.createRootGrant();

  const id = airlock.register({});
  rootGrant.add(id);

  const resolvers = [];
  airlock.setHandler(id, 'capture', ({ args, context }) => {
    return context.suspend((resolve) => {
      resolvers.push({ resolve, id: args[0] });
    });
  });
  airlock.declare('Api', id);

  // First suspension
  parseAndSetup(session, `
    let a = { id: "first", data: [1, 2, 3] };
    Api.capture("a")
  `);
  session.run(0, 10000);

  session.gc();

  // Second suspension (new parse, new context state)
  parseAndSetup(session, `
    let b = { id: "second", data: [4, 5, 6] };
    Api.capture("b")
  `);
  session.run(0, 10000);

  session.gc();

  // Third suspension
  parseAndSetup(session, `
    let c = { id: "third", data: [7, 8, 9] };
    Api.capture("c")
  `);
  session.run(0, 10000);

  session.gc();

  // Resolve in reverse order
  assertEquals(resolvers.length, 3);

  resolvers[2].resolve("third-done");
  await new Promise(r => setTimeout(r, 10));
  assertEquals(session.result(0), "third-done");

  resolvers[1].resolve("second-done");
  await new Promise(r => setTimeout(r, 10));

  resolvers[0].resolve("first-done");
  await new Promise(r => setTimeout(r, 10));
});

// =============================================================================
// Exception with fuel=0
// =============================================================================

Deno.test("Suspension: rejected exception is processed on next run", async () => {
  // Tests that a rejected suspension's exception is properly caught
  // by try/catch, even when resumed with 0 fuel (the interpreter
  // processes exceptions before checking fuel).
  const session = freshSession();
  const { airlock } = session;
  const mem = session.memoryImage;
  const rootGrant = airlock.createRootGrant();

  const id = airlock.register({});
  rootGrant.add(id);

  let rejectFn = null;
  airlock.setHandler(id, 'willReject', ({ args, context }) => {
    return context.suspend((resolve, reject) => {
      rejectFn = reject;
    });
  });
  airlock.declare('Api', id);

  parseAndSetup(session, `
    let caught = null;
    try {
      Api.willReject()
    } catch (e) {
      caught = e.message;
    }
    caught
  `);

  // Run until suspended
  session.run(0, 10000);
  assertEquals(rejectFn !== null, true);

  // Reject the promise - this sets RESPONSE_THROW and pushes exception to pending
  rejectFn(new Error('the exception'));

  // Wait for rejection to be processed by airlock
  while (mem.getExitCondition(0) !== 0) {
    await new Promise(r => setTimeout(r, 10));
  }

  // Run — interpreter processes RESPONSE_THROW and catch block executes
  session.run(0, 100);

  // Exception should have been caught, e.message extracted
  assertEquals(session.result(0), 'the exception');
});

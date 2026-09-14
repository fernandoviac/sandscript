/**
 * Test external call implementation for the fuel-based interpreter.
 *
 * Run with: deno task test tests/fuel/external_test.js
 */

import { assertEquals, assert } from "https://deno.land/std@0.208.0/assert/mod.ts";
import { createSession } from '../../src/fuel/session.js';
import { freshSession } from '../../src/host-owned-session.js';
// Slice 1 of snapshottable-membrane: register() returns Handle wrappers
// directly; no re-wrapping needed when returning from a handler.

/**
 * Create a session with a root grant for testing.
 * All registered handles added to the root grant are accessible without explicit grant blocks.
 */
function createTestSession() {
  const session = freshSession();
  const { airlock } = session;
  const rootGrant = airlock.createRootGrant();
  return { session, airlock, rootGrant };
}

// =============================================================================
// Sync External Call Tests
// =============================================================================

Deno.test("External: stateless sync - pure function", () => {
  const { session, airlock, rootGrant } = createTestSession();

  const id = airlock.register({});
  rootGrant.add(id);
  airlock.setHandler(id, 'clamp', ({ args }) => {
    const [value, min, max] = args;
    return Math.min(Math.max(value, min), max);
  });
  airlock.declare('MathExt', id);

  session.parse(`let result = MathExt.clamp(15, 0, 10)`);
  session.run(0, 10000);

  assertEquals(session.get(0, 'result'), 10);
});

Deno.test("External: stateful sync - counter", () => {
  const { session, airlock, rootGrant } = createTestSession();

  const counter = { value: 0 };
  const id = airlock.register(counter);
  rootGrant.add(id);
  airlock.setHandler(id, 'increment', ({ args, context }) => {
    const impl = airlock.lookup(context.handle);
    return ++impl.value;
  });
  airlock.setHandler(id, 'get', ({ args, context }) => {
    const impl = airlock.lookup(context.handle);
    return impl.value;
  });
  airlock.declare('Counter', id);

  session.parse(`
    Counter.increment();
    Counter.increment();
    let result = Counter.get()
  `);
  session.run(0, 10000);

  assertEquals(session.get(0, 'result'), 2);
});

Deno.test("External: opaque handle - key-value store", () => {
  const { session, airlock, rootGrant } = createTestSession();

  const id = airlock.register({});
  rootGrant.add(id);
  airlock.setHandler(id, 'create', ({ context }) => {
    const map = new Map();
    const mapId = context.register(map);
    return mapId;
  });
  airlock.setHandler(id, 'set', ({ args }) => {
    const [store, key, value] = args;
    store.set(key, value);
  });
  airlock.setHandler(id, 'get', ({ args }) => {
    const [store, key] = args;
    return store.get(key);
  });
  airlock.declare('Store', id);

  session.parse(`
    let db = Store.create();
    Store.set(db, "name", "alice");
    let result = Store.get(db, "name")
  `);
  session.run(0, 10000);

  assertEquals(session.get(0, 'result'), 'alice');
});

Deno.test("External: callback - transform", () => {
  const { session, airlock, rootGrant } = createTestSession();
  const mem = session.memoryImage;

  const id = airlock.register({});
  rootGrant.add(id);
  airlock.setHandler(id, 'transform', ({ args }) => {
    const [value, closureHandle] = args;

    // Allocate context and set up callback
    const slot = mem.allocateContext();
    airlock.setupCallbackContext(slot, closureHandle, [value * 2]);

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

  session.parse(`let result = Util.transform(5, (x) => x + 1)`);
  session.run(0, 10000);

  assertEquals(session.get(0, 'result'), 11);
});

Deno.test("External: callback with multiple invocations", () => {
  const { session, airlock, rootGrant } = createTestSession();
  const mem = session.memoryImage;

  const id = airlock.register({});
  rootGrant.add(id);
  airlock.setHandler(id, 'times', ({ args }) => {
    const [n, closureHandle] = args;

    for (let i = 0; i < n; i++) {
      // Allocate context and set up callback
      const slot = mem.allocateContext();
      airlock.setupCallbackContext(slot, closureHandle, [i]);

      // Run callback to completion
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
  airlock.declare('Iter', id);

  session.parse(`
    let sum = 0;
    Iter.times(5, (i) => { sum = sum + i; })
  `);
  session.run(0, 10000);

  assertEquals(session.get(0, 'sum'), 10);
});

Deno.test("External: callback calling external (recursive)", () => {
  const { session, airlock, rootGrant } = createTestSession();
  const mem = session.memoryImage;

  const id = airlock.register({});
  rootGrant.add(id);
  airlock.setHandler(id, 'process', ({ args }) => {
    const [x, closureHandle] = args;

    // Allocate context and set up callback
    const slot = mem.allocateContext();
    airlock.setupCallbackContext(slot, closureHandle, [x]);

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
  airlock.setHandler(id, 'double', ({ args }) => {
    return args[0] * 2;
  });
  airlock.declare('Api', id);

  session.parse(`let result = Api.process(5, (x) => Api.double(x))`);
  session.run(0, 10000);

  assertEquals(session.get(0, 'result'), 10);
});

// =============================================================================
// Async External Call Tests
// =============================================================================

Deno.test("External: async callback - deferred", async () => {
  const { session, airlock, rootGrant } = createTestSession();
  const mem = session.memoryImage;

  const id = airlock.register({});
  rootGrant.add(id);
  airlock.setHandler(id, 'delay', ({ args }) => {
    const [ms, closureHandle] = args;
    setTimeout(() => {
      // Allocate context and set up callback
      const slot = mem.allocateContext();
      airlock.setupCallbackContext(slot, closureHandle, []);

      // Run callback to completion
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
    }, ms);
  });
  airlock.declare('Async', id);

  session.parse(`
    let done = false;
    Async.delay(10, () => { done = true; });
  `);
  session.run(0, 10000);

  // Immediately after run(), done should be false
  assertEquals(session.get(0, 'done'), false);

  // Wait for the timeout to fire
  await new Promise(resolve => setTimeout(resolve, 50));

  // Now done should be true
  assertEquals(session.get(0, 'done'), true);
});

Deno.test("External: async with data", async () => {
  const { session, airlock, rootGrant } = createTestSession();
  const mem = session.memoryImage;

  const id = airlock.register({});
  rootGrant.add(id);
  airlock.setHandler(id, 'fetch', ({ args }) => {
    const [url, closureHandle] = args;
    setTimeout(() => {
      // Allocate context and set up callback with data argument
      const slot = mem.allocateContext();
      airlock.setupCallbackContext(slot, closureHandle, [{ status: 200, body: 'hello' }]);

      // Run callback to completion
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
    }, 10);
  });
  airlock.declare('Http', id);

  session.parse(`
    let response = null;
    Http.fetch("/api", (data) => { response = data; });
  `);
  session.run(0, 10000);

  // Immediately after run(), response should be null
  assertEquals(session.get(0, 'response'), null);

  // Wait for the timeout to fire
  await new Promise(resolve => setTimeout(resolve, 50));

  // Now response should have the data
  const response = session.get(0, 'response');
  assertEquals(response.status, 200);
  assertEquals(response.body, 'hello');
});

// =============================================================================
// Error Handling
// =============================================================================

Deno.test("External: error from handler", () => {
  const { session, airlock, rootGrant } = createTestSession();

  const id = airlock.register({});
  rootGrant.add(id);
  airlock.setHandler(id, 'fail', () => {
    throw new Error('boom');
  });
  airlock.declare('Risky', id);

  session.parse(`
    let caught = false;
    try {
      Risky.fail();
    } catch (e) {
      caught = true;
    }
  `);
  session.run(0, 10000);

  assertEquals(session.get(0, 'caught'), true);
});

Deno.test("External: error from callback", () => {
  const { session, airlock, rootGrant } = createTestSession();
  const mem = session.memoryImage;

  const id = airlock.register({});
  rootGrant.add(id);
  airlock.setHandler(id, 'run', ({ args }) => {
    const [closureHandle] = args;

    // Allocate context and set up callback
    const slot = mem.allocateContext();
    airlock.setupCallbackContext(slot, closureHandle, []);

    // Run callback to completion
    while (true) {
      const result = airlock.runContext(slot, 1000);
      if (result.status === 'done') {
        const returnValue = airlock.extractResultFromContext(slot);
        mem.freeContext(slot);
        return returnValue;
      }
      if (result.status === 'error') {
        const errorValue = airlock.extractResultFromContext(slot);
        mem.freeContext(slot);
        return 'caught: ' + String(errorValue);
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
  airlock.declare('Runner', id);

  session.parse(`let result = Runner.run(() => { throw "oops"; })`);
  session.run(0, 10000);

  const result = session.get(0, 'result');
  assert(typeof result === 'string' && result.includes('caught'));
});

// =============================================================================
// Event Emitter Pattern
// =============================================================================

Deno.test("External: event emitter - repeated sync callbacks", () => {
  const { session, airlock, rootGrant } = createTestSession();
  const mem = session.memoryImage;

  const id = airlock.register({});
  rootGrant.add(id);
  airlock.setHandler(id, 'emitter', ({ context }) => {
    const listeners = [];
    const emitter = { listeners };
    const emitterId = context.register(emitter);

    // Register handlers for the emitter
    airlock.setHandler(emitterId, 'on', ({ args }) => {
      const [closureHandle] = args;
      listeners.push(closureHandle);
    });
    airlock.setHandler(emitterId, 'emit', ({ args }) => {
      const [value] = args;
      for (const closureHandle of listeners) {
        // Allocate context and set up callback
        const slot = mem.allocateContext();
        airlock.setupCallbackContext(slot, closureHandle, [value]);

        // Run callback to completion
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

    return emitterId;
  });
  airlock.declare('Events', id);

  session.parse(`
    let log = [];
    let bus = Events.emitter();
    bus.on((x) => { log.push(x); });
    bus.emit(1);
    bus.emit(2);
    bus.emit(3)
  `);
  session.run(0, 10000);

  const result = session.get(0, 'log');
  assert(Array.isArray(result));
  assertEquals(result.length, 3);
  assertEquals(result[0], 1);
  assertEquals(result[1], 2);
  assertEquals(result[2], 3);
});

Deno.test("External: multiple listeners", () => {
  const { session, airlock, rootGrant } = createTestSession();
  const mem = session.memoryImage;

  const id = airlock.register({});
  rootGrant.add(id);
  airlock.setHandler(id, 'emitter', ({ context }) => {
    const listeners = [];
    const emitter = { listeners };
    const emitterId = context.register(emitter);

    airlock.setHandler(emitterId, 'on', ({ args }) => {
      const [closureHandle] = args;
      listeners.push(closureHandle);
    });
    airlock.setHandler(emitterId, 'emit', ({ args }) => {
      const [value] = args;
      for (const closureHandle of listeners) {
        // Allocate context and set up callback
        const slot = mem.allocateContext();
        airlock.setupCallbackContext(slot, closureHandle, [value]);

        // Run callback to completion
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

    return emitterId;
  });
  airlock.declare('Events', id);

  session.parse(`
    let a = [];
    let b = [];
    let bus = Events.emitter();
    bus.on((x) => { a.push(x); });
    bus.on((x) => { b.push(x * 2); });
    bus.emit(5)
  `);
  session.run(0, 10000);

  const a = session.get(0, 'a');
  const b = session.get(0, 'b');
  assert(Array.isArray(a));
  assert(Array.isArray(b));
  assertEquals(a[0], 5);
  assertEquals(b[0], 10);
});

Deno.test("External: method call with spread arguments (F4)", () => {
  const { session, airlock, rootGrant } = createTestSession();

  const id = airlock.register({});
  rootGrant.add(id);
  airlock.setHandler(id, 'sum', ({ args }) => args.reduce((total, v) => total + v, 0));
  airlock.declare('Calc', id);

  session.parse(`
    let parts = [1, 2, 3];
    let result = Calc.sum(...parts)
  `);
  session.run(0, 10000);

  assertEquals(session.get(0, 'result'), 6);
});

Deno.test("External: spread mixes with leading positional arguments", () => {
  const { session, airlock, rootGrant } = createTestSession();

  const id = airlock.register({});
  rootGrant.add(id);
  airlock.setHandler(id, 'join', ({ args }) => args.join('-'));
  airlock.declare('Fmt', id);

  session.parse(`let result = Fmt.join('a', ...['b', 'c'])`);
  session.run(0, 10000);

  assertEquals(session.get(0, 'result'), 'a-b-c');
});

// =============================================================================
// Stale declared handles — dispatch-time consequence
//
// These tests provide end-to-end coverage of declared-handle versioning.
//
// declare()d SS values carry the handle's version in data_hi; the WAT
// forwards it as request.handleVersion and _rejectIfStaleHandle compares
// it against the live slot's version BEFORE the grant check. These tests
// construct the C4/C5 race shape directly: the slot is reaped underneath
// the still-referenced SS value (bumping the table version), then reused
// by a different registration. Dispatch through the old value must
// produce the clean recoverable "stale handle" TypeError — never the
// misleading "requires a grant" error, and never a dispatch into
// whatever now owns the slot.
// =============================================================================

Deno.test("External: stale declared handle rejects cleanly instead of dispatching into the slot's new owner", () => {
  const { session, airlock, rootGrant } = createTestSession();

  const id = airlock.register({});
  rootGrant.add(id);
  airlock.setHandler(id, 'ping', () => 'pong');
  airlock.declare('Api', id);

  session.parse(`let before = Api.ping();`);
  session.run(0, 100000);
  assertEquals(session.get(0, 'before'), 'pong');

  // Reap the slot underneath the declared value (version bumps; the SS
  // scope entry still carries the old version), then re-register: the
  // free list hands the same slot to the new owner.
  airlock.membrane._freeHandleSlot(id.slot);
  let intruderInvoked = false;
  const intruder = airlock.register({ tag: 'new owner' });
  assertEquals(intruder.slot, id.slot, 'free-list reuse should hand back the same slot');
  rootGrant.add(intruder);
  airlock.setHandler(intruder, 'ping', () => {
    intruderInvoked = true;
    return 'INTRUDER';
  });

  const parseResult = session.parse(`
    let caught = null;
    try { Api.ping(); } catch (e) { caught = e.message; }
  `);
  session.mem.setContextInstructionIndex(0, parseResult.startIndex);
  session.run(0, 100000);

  const message = session.get(0, 'caught');
  assert(message !== null, 'the stale dispatch must throw catchably');
  assert(message.includes('no longer available (stale handle'),
    `expected the stale-handle rejection, got: ${message}`);
  assert(!message.includes('requires a grant'),
    `stale handle must not surface as a grant error: ${message}`);
  assertEquals(intruderInvoked, false,
    'the stale value must never dispatch into the handler of the slot\'s new owner');
});

Deno.test("External: stale declared handle rejects property reads too", () => {
  const { session, airlock, rootGrant } = createTestSession();

  const id = airlock.register({});
  rootGrant.add(id);
  airlock.setGetter(id, 'status', () => 'live');
  airlock.declare('Api', id);

  session.parse(`let before = Api.status;`);
  session.run(0, 100000);
  assertEquals(session.get(0, 'before'), 'live');

  airlock.membrane._freeHandleSlot(id.slot);

  const parseResult = session.parse(`
    let caught = null;
    try { let x = Api.status; } catch (e) { caught = e.message; }
  `);
  session.mem.setContextInstructionIndex(0, parseResult.startIndex);
  session.run(0, 100000);

  const message = session.get(0, 'caught');
  assert(message !== null, 'the stale property read must throw catchably');
  assert(message.includes('no longer available (stale handle'),
    `expected the stale-handle rejection, got: ${message}`);
});

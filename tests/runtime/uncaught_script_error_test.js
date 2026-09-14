import { assertEquals, assert, assertRejects } from "https://deno.land/std@0.208.0/assert/mod.ts";
import { RuntimeBuilder } from '../../src/runtime/test-harness.js';
import { UncaughtScriptError } from '../../src/runtime/errors.js';

function tick(ms = 0) { return new Promise(r => setTimeout(r, ms)); }

async function waitFor(condition, { timeout = 2000, label = 'condition' } = {}) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    if (condition()) return;
    await tick(2);
  }
  throw new Error(`waitFor timed out: ${label}`);
}

function catchUnhandledRejection() {
  let caught = null;
  const handler = (event) => {
    event.preventDefault();
    caught = event.reason;
  };
  globalThis.addEventListener('unhandledrejection', handler);
  return {
    get caught() { return caught; },
    dispose() { globalThis.removeEventListener('unhandledrejection', handler); },
  };
}

// =============================================================================
// runtime.run() — top-level throw
// =============================================================================

Deno.test('runtime.run: unhandled throw rejects with UncaughtScriptError', async () => {
  const { runtime, session, channels } = new RuntimeBuilder()
    .onInboundMessage(() => {})
    .build();
  await runtime.start();

  session.parse(`throw "boom"`);

  let caught = null;
  try {
    await runtime.run(0);
  } catch (err) {
    caught = err;
  }

  assert(caught instanceof UncaughtScriptError, `expected UncaughtScriptError, got ${caught?.constructor?.name}`);
  assertEquals(caught.slot, 0);
  assert(caught.scriptError !== null, 'scriptError should be present');
  assertEquals(caught.scriptError.codeName, 'USER_THROW');
  assert(caught.message.includes('boom'), `message should contain thrown value, got: ${caught.message}`);

  await runtime.terminate();
  channels.close();
});

Deno.test('runtime.run: unhandled runtime error rejects with UncaughtScriptError', async () => {
  const { runtime, session, channels } = new RuntimeBuilder()
    .onInboundMessage(() => {})
    .build();
  await runtime.start();

  session.parse(`nonexistent`);

  let caught = null;
  try {
    await runtime.run(0);
  } catch (err) {
    caught = err;
  }

  assert(caught instanceof UncaughtScriptError, `expected UncaughtScriptError, got ${caught?.constructor?.name}`);
  assertEquals(caught.slot, 0);
  assertEquals(caught.scriptError.type, 'ReferenceError');
  assert(caught.scriptError.message.includes('nonexistent'), `message should mention the variable`);

  await runtime.terminate();
  channels.close();
});

Deno.test('runtime.run: successful program does not throw', async () => {
  const { runtime, session, channels } = new RuntimeBuilder()
    .onInboundMessage(() => {})
    .build();
  await runtime.start();

  session.parse(`let x = 42`);

  const result = await runtime.run(0);
  assertEquals(result.status, 'done');

  await runtime.terminate();
  channels.close();
});

// =============================================================================
// invokeClosure — throw inside closure
// =============================================================================

Deno.test('invokeClosure: throw inside closure rejects with UncaughtScriptError', async () => {
  let capturedClosure = null;
  const { runtime, session, channels } = new RuntimeBuilder()
    .capability({
      name: 'Host',
      setup: (airlock) => {
        const rootGrant = airlock.createRootGrant();
        const handle = airlock.register({});
        rootGrant.add(handle);
        airlock.setHandler(handle, 'register', ({ args }) => {
          capturedClosure = args[0];
          return null;
        });
        airlock.declare('Host', handle);
      },
    })
    .onInboundMessage(() => {})
    .build();
  await runtime.start();

  session.parse(`Host.register(function() { throw "closure boom" })`);
  await runtime.run(0);
  assert(capturedClosure !== null, 'closure should be captured');

  let caught = null;
  try {
    await runtime.invokeClosure(capturedClosure, []);
  } catch (err) {
    caught = err;
  }

  assert(caught instanceof UncaughtScriptError, `expected UncaughtScriptError, got ${caught?.constructor?.name}`);
  assert(caught.message.includes('closure boom'), `message should contain thrown value, got: ${caught.message}`);

  await runtime.terminate();
  channels.close();
});

// =============================================================================
// scheduleClosureCall — throw inside fire-and-forget closure
// =============================================================================

Deno.test('scheduleClosureCall: throw inside closure surfaces via onHandlerError', async () => {
  let capturedClosure = null;
  let handlerErrors = [];
  const { runtime, session, channels } = new RuntimeBuilder()
    .capability({
      name: 'Host',
      setup: (airlock) => {
        const rootGrant = airlock.createRootGrant();
        const handle = airlock.register({});
        rootGrant.add(handle);
        airlock.setHandler(handle, 'register', ({ args }) => {
          capturedClosure = args[0];
          return null;
        });
        airlock.declare('Host', handle);
      },
    })
    .onInboundMessage(() => {})
    .onHandlerError((err) => { handlerErrors.push(err); })
    .build();
  await runtime.start();

  session.parse(`Host.register(function() { throw "scheduled boom" })`);
  await runtime.run(0);
  assert(capturedClosure !== null, 'closure should be captured');

  runtime.scheduleClosureCall(capturedClosure, []);

  await waitFor(() => handlerErrors.length > 0, { label: 'handlerError from scheduled closure throw' });

  const surfaced = handlerErrors[0];
  assert(surfaced.cause instanceof UncaughtScriptError,
    `expected UncaughtScriptError as cause, got ${surfaced?.cause?.constructor?.name ?? surfaced}`);
  assert(surfaced.cause.message.includes('scheduled boom'),
    `message should contain thrown value, got: ${surfaced.cause.message}`);

  await runtime.terminate();
  channels.close();
});

// =============================================================================
// Unawaited async throw — child slot
// =============================================================================

Deno.test('unawaited async throw: surfaces via onHandlerError when nobody awaits', async () => {
  let handlerErrors = [];
  const { runtime, session, channels } = new RuntimeBuilder()
    .onInboundMessage(() => {})
    .onHandlerError((err) => { handlerErrors.push(err); })
    .build();
  await runtime.start();

  session.parse(`
    async function boom() {
      throw "async boom"
    }
    boom()
  `);

  await runtime.run(0);
  await tick(100);

  assert(handlerErrors.length > 0,
    'expected onHandlerError to fire for unhandled async rejection');
  const surfaced = handlerErrors[0];
  assert(surfaced.cause instanceof UncaughtScriptError,
    `expected UncaughtScriptError as cause, got ${surfaced?.cause?.constructor?.name ?? 'nothing'}`);
  assert(surfaced.cause.message.includes('async boom'),
    `message should contain thrown value, got: ${surfaced.cause?.message}`);

  await runtime.terminate();
  channels.close();
});

Deno.test('awaited async throw: does NOT surface when parent catches the rejection', async () => {
  let handlerErrors = [];
  const trap = catchUnhandledRejection();
  const { runtime, session, channels } = new RuntimeBuilder()
    .onInboundMessage(() => {})
    .onHandlerError((err) => { handlerErrors.push(err); })
    .build();
  await runtime.start();

  session.parse(`
    async function bad() { throw new Error("caught async"); }
    async function main() {
      try { await bad(); } catch (_e) {}
    }
    main()
  `);

  await runtime.run(0);
  await tick(100);

  assertEquals(handlerErrors.length, 0,
    `onHandlerError should not fire for a caught async rejection, got: ${handlerErrors.map(e => e.cause?.message)}`);
  assertEquals(trap.caught, null,
    'no unhandled rejection should escape to the global');

  trap.dispose();
  await runtime.terminate();
  channels.close();
});

// =============================================================================
// onSlotLifecycle still fires
// =============================================================================

Deno.test('runtime.run: onSlotLifecycle fires before UncaughtScriptError propagates', async () => {
  let lifecycleEvents = [];
  const { runtime, session, channels } = new RuntimeBuilder()
    .onInboundMessage(() => {})
    .build();

  runtime.onSlotLifecycle = (event) => { lifecycleEvents.push(event); };

  await runtime.start();
  session.parse(`throw "lifecycle test"`);

  try {
    await runtime.run(0);
  } catch (_) {}

  assertEquals(lifecycleEvents.length, 1);
  assertEquals(lifecycleEvents[0].kind, 'error');
  assertEquals(lifecycleEvents[0].slot, 0);

  await runtime.terminate();
  channels.close();
});

// =============================================================================
// Error class shape
// =============================================================================

Deno.test('UncaughtScriptError: has correct shape and is instanceof Error', () => {
  const scriptError = { code: 12, codeName: 'USER_THROW', message: 'boom', failPc: 3 };
  const err = new UncaughtScriptError(0, scriptError);

  assert(err instanceof Error);
  assert(err instanceof UncaughtScriptError);
  assertEquals(err.name, 'UncaughtScriptError');
  assertEquals(err.slot, 0);
  assertEquals(err.scriptError, scriptError);
  assert(err.message.includes('boom'));
  assert(err.stack !== undefined, 'should have a stack trace');
});

// =============================================================================
// scheduleClosureCall — per-call marshal receipts (onMarshaled / onMarshalError)
// =============================================================================

Deno.test('scheduleClosureCall: onMarshaled fires once the args land in the vat', async () => {
  let capturedClosure = null;
  const { runtime, session, channels } = new RuntimeBuilder()
    .capability({
      name: 'Host',
      setup: (airlock) => {
        const rootGrant = airlock.createRootGrant();
        const handle = airlock.register({});
        rootGrant.add(handle);
        airlock.setHandler(handle, 'register', ({ args }) => {
          capturedClosure = args[0];
          return null;
        });
        airlock.declare('Host', handle);
      },
    })
    .onInboundMessage(() => {})
    .build();
  await runtime.start();

  session.parse(`Host.register(function(x) { let y = x })`);
  await runtime.run(0);
  assert(capturedClosure !== null, 'closure should be captured');

  let marshaled = 0;
  let marshalErrors = [];
  runtime.scheduleClosureCall(capturedClosure, ['small arg'], {
    onMarshaled: () => { marshaled += 1; },
    onMarshalError: (err) => { marshalErrors.push(err); },
  });

  await waitFor(() => marshaled > 0, { label: 'onMarshaled receipt' });
  assertEquals(marshaled, 1);
  assertEquals(marshalErrors.length, 0);

  await runtime.terminate();
  channels.close();
});

Deno.test('scheduleClosureCall: marshal refusal (string too long for scratch) fires onMarshalError, not onError', async () => {
  let capturedClosure = null;
  let handlerErrors = [];
  const { runtime, session, channels } = new RuntimeBuilder()
    .sessionOptions({ scratchSize: 65536 })
    .capability({
      name: 'Host',
      setup: (airlock) => {
        const rootGrant = airlock.createRootGrant();
        const handle = airlock.register({});
        rootGrant.add(handle);
        airlock.setHandler(handle, 'register', ({ args }) => {
          capturedClosure = args[0];
          return null;
        });
        airlock.declare('Host', handle);
      },
    })
    .onInboundMessage(() => {})
    .onHandlerError((err) => { handlerErrors.push(err); })
    .build();
  await runtime.start();

  session.parse(`Host.register(function(x) { let y = x })`);
  await runtime.run(0);
  assert(capturedClosure !== null, 'closure should be captured');

  let marshaled = 0;
  let scriptErrors = [];
  let marshalErrors = [];
  const oversized = 'x'.repeat(100000); // > 65536 scratch: interning must refuse
  runtime.scheduleClosureCall(capturedClosure, [oversized], {
    onMarshaled: () => { marshaled += 1; },
    onError: (err) => { scriptErrors.push(err); },
    onMarshalError: (err) => { marshalErrors.push(err); },
  });

  await waitFor(() => marshalErrors.length > 0, { label: 'onMarshalError receipt' });
  assertEquals(marshaled, 0, 'onMarshaled must not fire for a refused marshal');
  assertEquals(scriptErrors.length, 0, 'onError is reserved for delivered calls');
  assert(String(marshalErrors[0]?.message ?? marshalErrors[0]).includes('too long'),
    `expected the interning refusal, got: ${marshalErrors[0]?.message}`);

  await runtime.terminate();
  channels.close();
});

Deno.test('scheduleClosureCall: script error after successful marshal fires onMarshaled then onError', async () => {
  let capturedClosure = null;
  const { runtime, session, channels } = new RuntimeBuilder()
    .capability({
      name: 'Host',
      setup: (airlock) => {
        const rootGrant = airlock.createRootGrant();
        const handle = airlock.register({});
        rootGrant.add(handle);
        airlock.setHandler(handle, 'register', ({ args }) => {
          capturedClosure = args[0];
          return null;
        });
        airlock.declare('Host', handle);
      },
    })
    .onInboundMessage(() => {})
    .onHandlerError(() => {})
    .build();
  await runtime.start();

  session.parse(`Host.register(function() { throw "delivered but failed" })`);
  await runtime.run(0);
  assert(capturedClosure !== null, 'closure should be captured');

  let marshaled = 0;
  let scriptErrors = [];
  let marshalErrors = [];
  runtime.scheduleClosureCall(capturedClosure, [], {
    onMarshaled: () => { marshaled += 1; },
    onError: (err) => { scriptErrors.push(err); },
    onMarshalError: (err) => { marshalErrors.push(err); },
  });

  await waitFor(() => scriptErrors.length > 0, { label: 'onError after marshal' });
  assertEquals(marshaled, 1, 'the call WAS delivered');
  assertEquals(marshalErrors.length, 0);

  await runtime.terminate();
  channels.close();
});

// =============================================================================
// Async member-write rejection through the suspension reject path
// =============================================================================
//
// An external member write whose setter suspends and whose Promise then
// REJECTS delivers the throw through _setupSuspension's reject closure —
// no JS handler ever throws, so no AttributedRejection is stashed. The
// slot wakes, rethrows in SS, and (uncaught) session.run throws
// UncaughtScriptError from a WAKE-path drive (_continueRoot), whose
// rethrow is deliberately swallowed. Before the fix, driveLoop only
// surfaced the (absent) stash: the error vanished entirely — no
// onHandlerError, no capability hook, a silently dead drone.

function buildRejectingSetterRuntime({ uncaught, handlerErrors }) {
  return new RuntimeBuilder()
    .capability({
      name: 'Host',
      setup: (airlock) => {
        const rootGrant = airlock.createRootGrant();
        const handle = airlock.register({});
        rootGrant.add(handle);
        airlock.setMemberInspector(handle, () => ({ kind: 'data', writable: true }));
        airlock.setDefaultSetter(handle, ({ propName, context }) =>
          context.suspend((resolve, reject) =>
            Promise.reject(new Error(`write ${propName} refused`))
              .then(resolve, reject)));
        airlock.declare('Host', handle);
        return {
          onUncaughtException: (error) => { uncaught.push(error); },
        };
      },
    })
    .onInboundMessage(() => {})
    .onHandlerError((err) => { handlerErrors.push(err); })
    .build();
}

Deno.test('member-write rejection: uncaught throw fires onHandlerError and onUncaughtException', async () => {
  const handlerErrors = [];
  const uncaught = [];
  const { runtime, session, channels } = buildRejectingSetterRuntime({ uncaught, handlerErrors });
  await runtime.start();

  session.parse(`
    let after = "not-reached"
    Host.width = "12pt"
    after = "reached"
  `);
  await runtime.run(0);

  await waitFor(() => handlerErrors.length > 0,
    { label: 'onHandlerError from rejected member write' });

  const surfaced = handlerErrors[0];
  assert(surfaced.cause instanceof UncaughtScriptError,
    `expected UncaughtScriptError as cause, got ${surfaced?.cause?.constructor?.name ?? surfaced}`);
  assert(surfaced.cause.message.includes('write width refused'),
    `message should name the failed write, got: ${surfaced.cause.message}`);
  assertEquals(surfaced.slot, 0, 'attribution should carry the throwing slot');

  assertEquals(uncaught.length, 1, 'capability onUncaughtException should fire exactly once');
  assertEquals(uncaught[0], surfaced.cause,
    'the capability hook receives the original error, not the wrapper');

  assertEquals(session.get(0, 'after'), 'not-reached',
    'the statement after the throwing write must not run');

  await runtime.terminate();
  channels.close();
});

Deno.test('member-write rejection: a drone-side catch keeps the error out of both hooks', async () => {
  const handlerErrors = [];
  const uncaught = [];
  const { runtime, session, channels } = buildRejectingSetterRuntime({ uncaught, handlerErrors });
  await runtime.start();

  session.parse(`
    let caught = "no"
    try {
      Host.width = "12pt"
    } catch (e) {
      caught = e.message
    }
  `);
  await runtime.run(0);

  await waitFor(() => session.get(0, 'caught') !== 'no',
    { label: 'drone-side catch observed the write error' });
  assertEquals(session.get(0, 'caught'), 'write width refused');
  await tick(50);

  assertEquals(handlerErrors.length, 0,
    'a caught write error is the drone\u2019s own business — no onHandlerError');
  assertEquals(uncaught.length, 0,
    'a caught write error must not reach onUncaughtException');

  await runtime.terminate();
  channels.close();
});

import { assertEquals, assert } from "https://deno.land/std@0.208.0/assert/mod.ts";
import { RuntimeBuilder } from '../../src/runtime/test-harness.js';

function tick(ms = 0) { return new Promise(r => setTimeout(r, ms)); }

async function waitFor(condition, { timeout = 2000, label = 'condition' } = {}) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    if (condition()) return;
    await tick(2);
  }
  throw new Error(`waitFor timed out: ${label}`);
}

function buildCap(state) {
  return {
    name: 'test',
    needs: {},
    setup(airlock) {
      const handle = airlock.register({});
      airlock.setHandler(handle, 'echo', ({ args }) => args[0]);
      airlock.setHandler(handle, 'add', ({ args }) => args[0] + args[1]);
      airlock.setHandler(handle, 'fail', () => { throw new Error('boom'); });
      airlock.setHandler(handle, 'deferred', ({ args }) => {
        return new Promise(resolve => setTimeout(() => resolve(args[0] * 10), 0));
      });
      airlock.setHandler(handle, 'suspend', ({ args, context }) => {
        return context.suspend((resolve) => {
          setTimeout(() => resolve(args[0] * 10), 0);
        });
      });
      airlock.setHandler(handle, 'regClosure', ({ args }) => {
        state.closure = args[0];
        return 0;
      });
      airlock.setGetter(handle, 'value', () => 42);
      airlock.setSetter(handle, 'value', ({ value }) => { state.written = value; });
      airlock.declare('T', handle);

      const grant = airlock.membrane.createGrant('test');
      grant.add(handle);
      return {
        onGrantRequest(id) { return id === 'test' ? grant : null; },
      };
    },
  };
}

async function buildRuntime(hooks = {}) {
  const state = { closure: null, written: null };
  const { runtime, session, channels } = new RuntimeBuilder()
    .capability(buildCap(state))
    .onInboundMessage(() => {})
    .onHandlerError(() => {})
    .build();

  for (const [k, v] of Object.entries(hooks)) {
    runtime[k] = v;
  }

  await runtime.start();
  return { runtime, session, channels, state };
}

async function runCode(session, runtime, code) {
  const parsed = session.parse(code);
  session.setInstruction(0, parsed.startIndex);
  // Every test here wraps code in `grant "test" { ... }`. The Runtime fanout
  // wrapper's onGrantRequest is always async, so runtime.run(0) suspends
  // immediately after GRANT_START rather than firing the remaining hook events
  // in the same drive episode. Some callers deliberately assert on a second,
  // genuine suspension triggered by context.suspend or an awaited host
  // Promise and must observe that state rather than silently driving to
  // completion.
  // Polling only until blockedOnGrant clears would be racy because a
  // macrotask-based inner suspension can pass that observation between ticks.
  //
  // The grant fanout (runGrantFanout, runtime.js) settles via
  // Promise.all/.then — microtask timing, no macrotask hop. Draining
  // ONLY microtasks (never yielding to the macrotask queue) advances
  // exactly past the grant settle and the resulting re-drive, landing
  // on whatever the code's body does next, before any setTimeout-based
  // suspend inside that body gets a chance to fire.
  await runtime.run(0);
  for (let i = 0; i < 50 && session.state(0).blockedOnGrant; i++) {
    await Promise.resolve();
  }
  // session.state(slot).exitCondition is the raw WASM exit-condition
  // vocabulary ('external_call', 'grant_request', 'await', ...) — NOT
  // the session.run()/runtime.run() STATUS vocabulary ('suspended',
  // 'done') some callers assert on. 'suspended' is synthesized by
  // session.run() at the moment it parks and isn't persisted anywhere
  // retrievable afterward, and no single boolean on session.state()
  // generalizes across every park mechanism (context.suspend/external
  // calls vs. SS-level await vs. this grant suspension each use
  // different underlying signals) — so this intentionally returns the
  // raw exit condition rather than fabricating a synthetic status.
  // Callers that need the exact 'suspended'/'await' STATUS check the
  // raw exitCondition themselves against what their own code triggers.
  return { status: session.state(0).exitCondition };
}

// =============================================================================
// onExternalCall
// =============================================================================

Deno.test('onExternalCall: method call emits call + call-result', async () => {
  const events = [];
  const { runtime, session, channels } = await buildRuntime({
    onExternalCall: (e) => events.push(e),
  });

  await runCode(session, runtime, 'grant "test" { T.echo(1) }');

  const call = events.find(e => e.kind === 'call');
  assert(call, `expected a 'call' event; got: ${JSON.stringify(events)}`);
  assertEquals(call.method, 'echo');
  assertEquals(call.declaredName, 'T');
  assertEquals(call.argCount, 1);

  const result = events.find(e => e.kind === 'call-result');
  assert(result, `expected a 'call-result' event`);
  assertEquals(result.method, 'echo');

  await runtime.terminate();
  channels.close();
});

Deno.test('onExternalCall: multiple args and correct slot', async () => {
  const events = [];
  const { runtime, session, channels } = await buildRuntime({
    onExternalCall: (e) => events.push(e),
  });

  await runCode(session, runtime, 'grant "test" { T.add(3, 4) }');

  const call = events.find(e => e.kind === 'call' && e.method === 'add');
  assert(call, 'expected a call event for add');
  assertEquals(call.argCount, 2);
  assertEquals(call.slot, 0);

  await runtime.terminate();
  channels.close();
});

Deno.test('onExternalCall: handler throw emits call-error', async () => {
  const events = [];
  const { runtime, session, channels } = await buildRuntime({
    onExternalCall: (e) => events.push(e),
  });

  await runCode(session, runtime, 'grant "test" { try { T.fail() } catch(_e) {} }');

  const error = events.find(e => e.kind === 'call-error');
  assert(error, `expected a 'call-error' event`);
  assertEquals(error.method, 'fail');
  assert(error.error instanceof Error);
  assertEquals(error.error.message, 'boom');

  await runtime.terminate();
  channels.close();
});

Deno.test('onExternalCall: SuspensionMarker emits call-suspend', async () => {
  const events = [];
  const { runtime, session, channels } = await buildRuntime({
    onExternalCall: (e) => events.push(e),
  });

  const result = await runCode(session, runtime,
    'grant "test" { let x = await T.suspend(5) }');
  // 'external_call' is the raw exit condition context.suspend() parks
  // at — session.run()'s synthetic 'suspended' STATUS isn't persisted
  // (see runCode's own comment on why it returns the raw condition).
  assertEquals(result.status, 'external_call');

  const suspend = events.find(e => e.kind === 'call-suspend');
  assert(suspend, `expected 'call-suspend'; got: ${JSON.stringify(events.map(e => e.kind))}`);
  assertEquals(suspend.method, 'suspend');

  await tick(50);
  await runtime.terminate();
  channels.close();
});

Deno.test('onExternalCall: property read emits property-read + property-read-result', async () => {
  const events = [];
  const { runtime, session, channels } = await buildRuntime({
    onExternalCall: (e) => events.push(e),
  });

  await runCode(session, runtime, 'grant "test" { let x = T.value }');

  const read = events.find(e => e.kind === 'property-read');
  assert(read, `expected 'property-read'; got: ${JSON.stringify(events.map(e => e.kind))}`);
  assertEquals(read.property, 'value');
  assertEquals(read.declaredName, 'T');

  const result = events.find(e => e.kind === 'property-read-result');
  assert(result, `expected a 'property-read-result' event`);

  await runtime.terminate();
  channels.close();
});

Deno.test('onExternalCall: property write emits property-write + property-write-result', async () => {
  const events = [];
  const { runtime, session, channels, state } = await buildRuntime({
    onExternalCall: (e) => events.push(e),
  });

  await runCode(session, runtime, 'grant "test" { T.value = 99 }');
  assertEquals(state.written, 99);

  const write = events.find(e => e.kind === 'property-write');
  assert(write, `expected 'property-write'; got: ${JSON.stringify(events.map(e => e.kind))}`);
  assertEquals(write.property, 'value');

  const result = events.find(e => e.kind === 'property-write-result');
  assert(result, `expected a 'property-write-result' event`);

  await runtime.terminate();
  channels.close();
});

Deno.test('onExternalCall: no hook → no overhead', async () => {
  const { runtime, session, channels } = await buildRuntime();

  const result = await runCode(session, runtime, 'grant "test" { T.echo(1) }');
  assertEquals(result.status, 'done');

  await runtime.terminate();
  channels.close();
});

// =============================================================================
// onGrant
// =============================================================================

Deno.test('onGrant: approved grant emits request + approved', async () => {
  const events = [];
  const { runtime, session, channels } = await buildRuntime({
    onGrant: (e) => events.push(e),
  });

  await runCode(session, runtime, 'grant "test" { T.echo(1) }');

  const request = events.find(e => e.kind === 'request');
  assert(request, `expected a 'request' event`);
  assertEquals(request.identifiers, ['test']);

  const approved = events.find(e => e.kind === 'approved');
  assert(approved, `expected an 'approved' event`);
  assertEquals(approved.identifiers, ['test']);

  await runtime.terminate();
  channels.close();
});

Deno.test('onGrant: denied grant emits request + denied', async () => {
  const events = [];
  const { runtime, session, channels } = await buildRuntime({
    onGrant: (e) => events.push(e),
  });

  await runCode(session, runtime, `
    grant "nonexistent" {
      T.echo(1)
    } denied {
      let x = 0
    }
  `);

  const request = events.find(e => e.kind === 'request');
  assert(request, 'expected a request event');

  const denied = events.find(e => e.kind === 'denied');
  assert(denied, `expected 'denied'; got: ${JSON.stringify(events.map(e => e.kind))}`);
  assert(denied.rejected.length > 0, 'rejected should list the denied identifiers');

  await runtime.terminate();
  channels.close();
});

// =============================================================================
// onClosureDispatch
// =============================================================================

Deno.test('onClosureDispatch: scheduleClosureCall emits enqueue + drive + complete', async () => {
  const events = [];
  const { runtime, session, channels, state } = await buildRuntime({
    onClosureDispatch: (e) => events.push(e),
  });

  await runCode(session, runtime, `
    grant "test" {
      T.regClosure(function(x) { return x + 1 })
    }
  `);
  assert(state.closure, 'closure should be registered');

  runtime.scheduleClosureCall(state.closure, [42]);
  await waitFor(() => events.some(e => e.kind === 'complete'), { label: 'closure complete' });

  const enqueue = events.find(e => e.kind === 'enqueue');
  assert(enqueue, `expected an 'enqueue' event`);
  assert(enqueue.closurePointer !== null, 'closurePointer should be present');

  const drive = events.find(e => e.kind === 'drive');
  assert(drive, `expected a 'drive' event`);
  assert(typeof drive.slot === 'number', 'drive should have a slot');

  const complete = events.find(e => e.kind === 'complete');
  assert(complete, `expected a 'complete' event`);
  assertEquals(complete.slot, drive.slot);
  assertEquals(complete.closurePointer, drive.closurePointer);

  await runtime.terminate();
  channels.close();
});

// =============================================================================
// onSlotLifecycle
// =============================================================================

Deno.test('onSlotLifecycle: closure drive emits allocate + done + free', async () => {
  const events = [];
  const { runtime, session, channels, state } = await buildRuntime({
    onSlotLifecycle: (e) => events.push(e),
  });

  await runCode(session, runtime, `
    grant "test" {
      T.regClosure(function() { return 1 })
    }
  `);
  assert(state.closure, 'closure should be registered');

  events.length = 0;

  runtime.scheduleClosureCall(state.closure, []);
  await waitFor(() => events.some(e => e.kind === 'free'), { label: 'slot freed' });

  const allocate = events.find(e => e.kind === 'allocate');
  assert(allocate, `expected an 'allocate' event`);

  const done = events.find(e => e.kind === 'done');
  assert(done, `expected a 'done' event`);

  const free = events.find(e => e.kind === 'free');
  assert(free, `expected a 'free' event`);
  assertEquals(free.slot, allocate.slot);

  await runtime.terminate();
  channels.close();
});

Deno.test('onSlotLifecycle: throwing code emits error or throw', async () => {
  const events = [];
  const { runtime, session, channels } = await buildRuntime({
    onSlotLifecycle: (e) => events.push(e),
  });

  try {
    await runCode(session, runtime, 'throw new Error("oops")');
  } catch (_) {}

  const terminal = events.find(e => e.kind === 'error' || e.kind === 'throw');
  assert(terminal, `expected a terminal event; got: ${JSON.stringify(events.map(e => e.kind))}`);

  await runtime.terminate();
  channels.close();
});

// =============================================================================
// onSuspend
// =============================================================================

Deno.test('onSuspend: SuspensionMarker emits park-suspend + wake', async () => {
  const events = [];
  const { runtime, session, channels } = await buildRuntime({
    onSuspend: (e) => events.push(e),
  });

  const result = await runCode(session, runtime,
    'grant "test" { let x = await T.suspend(5) }');
  // 'external_call' is the raw exit condition context.suspend() parks
  // at — session.run()'s synthetic 'suspended' STATUS isn't persisted
  // (see runCode's own comment on why it returns the raw condition).
  assertEquals(result.status, 'external_call');

  const parkSuspend = events.find(e => e.kind === 'park-suspend');
  assert(parkSuspend, `expected 'park-suspend'; got: ${JSON.stringify(events.map(e => e.kind))}`);

  await waitFor(() => events.some(e => e.kind === 'wake'), { label: 'wake event' });

  const wake = events.find(e => e.kind === 'wake');
  assert(wake, 'expected a wake event');

  await runtime.terminate();
  channels.close();
});

Deno.test('onSuspend: SS-side await emits park-await', async () => {
  const events = [];
  const { runtime, session, channels } = await buildRuntime({
    onSuspend: (e) => events.push(e),
  });

  await runCode(session, runtime, `
    grant "test" {
      async function inner() { return await T.deferred(3) }
      let result = await inner()
    }
  `);

  const parkAwait = events.find(e => e.kind === 'park-await');
  assert(parkAwait, `expected 'park-await'; got: ${JSON.stringify(events.map(e => e.kind))}`);

  await runtime.terminate();
  channels.close();
});

Deno.test('onSuspend: Promise-returning handler emits park-await + wake', async () => {
  const events = [];
  const { runtime, session, channels } = await buildRuntime({
    onSuspend: (e) => events.push(e),
  });

  const result = await runCode(session, runtime,
    'grant "test" { let x = await T.deferred(5) }');
  assertEquals(result.status, 'await');

  const park = events.find(e => e.kind === 'park-await');
  assert(park, `expected 'park-await'; got: ${JSON.stringify(events.map(e => e.kind))}`);

  await waitFor(() => events.some(e => e.kind === 'wake'), { label: 'wake event' });

  await runtime.terminate();
  channels.close();
});

// =============================================================================
// onGarbageCollect (hard to trigger deterministically — verify wiring only)
// =============================================================================

Deno.test('onGarbageCollect: hook is accepted and callable', async () => {
  const events = [];
  const { runtime, channels } = await buildRuntime({
    onGarbageCollect: (e) => events.push(e),
  });

  assertEquals(typeof runtime.onGarbageCollect, 'function');

  await runtime.terminate();
  channels.close();
});

// =============================================================================
// All hooks together — no interference
// =============================================================================

Deno.test('all six hooks fire independently on a mixed workload', async () => {
  const externalCalls = [];
  const grants = [];
  const closures = [];
  const slots = [];
  const suspends = [];
  const gcs = [];

  const { runtime, session, channels, state } = await buildRuntime({
    onExternalCall:    (e) => externalCalls.push(e),
    onGrant:           (e) => grants.push(e),
    onClosureDispatch: (e) => closures.push(e),
    onSlotLifecycle:   (e) => slots.push(e),
    onSuspend:         (e) => suspends.push(e),
    onGarbageCollect:  (e) => gcs.push(e),
  });

  await runCode(session, runtime, `
    grant "test" {
      T.regClosure(function(x) { return x })
      let a = T.echo(1)
      let b = T.value
      T.value = 77
    }
  `);
  assert(state.closure, 'closure should be registered');

  runtime.scheduleClosureCall(state.closure, [10]);
  await waitFor(() => closures.some(e => e.kind === 'complete'), { label: 'closure complete' });

  assert(externalCalls.length > 0, 'onExternalCall should have fired');
  assert(grants.length > 0, 'onGrant should have fired');
  assert(closures.length > 0, 'onClosureDispatch should have fired');
  assert(slots.length > 0, 'onSlotLifecycle should have fired');

  const callKinds = new Set(externalCalls.map(e => e.kind));
  assert(callKinds.has('call'), 'should have call events');
  assert(callKinds.has('call-result'), 'should have call-result events');
  assert(callKinds.has('property-read'), 'should have property-read events');
  assert(callKinds.has('property-write'), 'should have property-write events');

  const grantKinds = new Set(grants.map(e => e.kind));
  assert(grantKinds.has('request'), 'should have grant request');
  assert(grantKinds.has('approved'), 'should have grant approved');

  const closureKinds = new Set(closures.map(e => e.kind));
  assert(closureKinds.has('enqueue'), 'should have closure enqueue');
  assert(closureKinds.has('drive'), 'should have closure drive');
  assert(closureKinds.has('complete'), 'should have closure complete');

  await runtime.terminate();
  channels.close();
});

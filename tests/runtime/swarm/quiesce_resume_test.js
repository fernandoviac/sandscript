/**
 * Swarm integration tests — quiesce / resume contract.
 *
 * `quiesce()` stops dispatching new work and waits for any
 * currently in-flight slot drives to return. Crucially:
 *
 *   "In flight" means a drive whose JS Promise has not yet
 *   settled. A slot parked on `await Host.foo()` is NOT
 *   in-flight from the runtime's perspective — its drive
 *   returned with status 'await' and the Promise resolved.
 *
 * `resume()` re-enables dispatch and drains anything queued
 * during the pause.
 *
 * Existing coverage in tests/runtime/runtime_test.js and
 * runtime_state_integration_test.js already pins the idle-
 * cycle (quiesce/snapshot/resume) and the full snapshot
 * round-trip. This file fills the gaps for an embedder
 * driving a live workload across a quiesce window.
 *
 * Pinned:
 *   - quiesce on an idle runtime publishes QUIESCED immediately
 *     (already covered elsewhere; included here as a baseline)
 *   - parked slots are NOT in-flight: a drone parked on a host
 *     Promise has its drive resolved already, and quiesce
 *     resolves without waiting for the park to lift
 *   - inbound message delivery continues during quiesce
 *   - scheduleClosureCall during quiesce enqueues the call;
 *     resume() drains the queue and the closures fire
 *   - spawned slots queued during quiesce wait for resume,
 *     then dispatch
 *
 * Run with:
 *   deno task test tests/runtime/swarm/quiesce_resume_test.js
 */

import { assertEquals, assert } from "https://deno.land/std@0.208.0/assert/mod.ts";
import { RuntimeBuilder } from '../../../src/runtime/test-harness.js';
import { RUNTIME_STATE } from '../../../src/runtime/index.js';

const u8 = (s) => new TextEncoder().encode(s);

function tick(ms = 0) { return new Promise(r => setTimeout(r, ms)); }

async function waitFor(condition, { timeout = 2000, label = 'condition' } = {}) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    if (condition()) return;
    await tick(2);
  }
  throw new Error(`waitFor timed out: ${label}`);
}

// =============================================================================
// Parked slots are not in-flight: quiesce returns without waiting for
// a slot parked on a host Promise to unpark.
// =============================================================================

Deno.test("quiesce: a slot parked on a host Promise is not in-flight; quiesce returns immediately", async () => {
  let releaseHandler;
  const handlerPromise = new Promise(r => { releaseHandler = r; });
  const events = [];

  const { runtime, session, channels } = new RuntimeBuilder()
    .capability({
      name: 'host',
      setup: (al) => {
        const root = al.createRootGrant();
        const handle = al.register({});
        root.add(handle);
        al.setHandler(handle, 'wait', () => handlerPromise);
        al.setHandler(handle, 'mark', ({ args }) => { events.push(args[0]); return null; });
        al.declare('Host', handle);
      },
    })
    .onInboundMessage(() => {})
    .build();
  await runtime.start();

  session.parse(`
    async function main() {
      await Host.wait();
      Host.mark("after-wait");
    }
    let _ = main();
  `);
  // Start the drive but don't await — it will park on the Promise.
  const runPromise = runtime.run(0);
  await tick(10);
  assertEquals(events, [], 'main has not yet run past the await');

  // The slot is parked. _inFlightDrives is empty.
  assertEquals(runtime.getSchedulerStats().inFlight, 0,
    'parked slot is not counted as in-flight');

  // quiesce returns immediately because there are no in-flight drives.
  await runtime.quiesce();
  assertEquals(runtime.runtimeState.get(), RUNTIME_STATE.QUIESCED);

  // Resume — the parked slot is still parked. Releasing the handler
  // wakes it; under the current contract _drainPendingSpawned only
  // runs when not quiesced, so the wake needs resume().
  runtime.resume();
  releaseHandler();
  await runPromise;
  assertEquals(events, ['after-wait']);

  await runtime.terminate();
  channels.close();
});

// =============================================================================
// Inbound delivery continues during quiesce
// =============================================================================

Deno.test("quiesce: inbound loop continues delivering messages to onInboundMessage", async () => {
  const received = [];
  const { runtime, host, channels } = new RuntimeBuilder()
    .onInboundMessage((payload) => {
      received.push(new TextDecoder().decode(payload));
    })
    .build();
  await runtime.start();

  await runtime.quiesce();
  assertEquals(runtime.runtimeState.get(), RUNTIME_STATE.QUIESCED);

  await host.send(u8('during-quiesce-1'));
  await host.send(u8('during-quiesce-2'));
  await waitFor(() => received.length === 2,
    { label: 'inbound delivered during quiesce' });
  assertEquals(received, ['during-quiesce-1', 'during-quiesce-2']);

  runtime.resume();
  await runtime.terminate();
  channels.close();
});

// =============================================================================
// scheduleClosureCall during quiesce enqueues; resume() drains the queue.
// =============================================================================

Deno.test("quiesce: scheduleClosureCall during quiesce enqueues; resume drains the queue", async () => {
  const captured = { closures: [], calls: [] };
  const { runtime, session, channels } = new RuntimeBuilder()
    .capability({
      name: 'host',
      setup: (al) => {
        const root = al.createRootGrant();
        const handle = al.register({});
        root.add(handle);
        al.setHandler(handle, 'register', ({ args }) => {
          captured.closures.push(args[0]); return null;
        });
        al.setHandler(handle, 'callback', ({ args }) => {
          captured.calls.push(args[0]); return null;
        });
        al.declare('Host', handle);
      },
    })
    .onInboundMessage(() => {})
    .build();
  await runtime.start();

  session.parse(`Host.register(function(n) { Host.callback(n); });`);
  await runtime.run(0);
  assert(captured.closures[0]);

  // Sanity: while running, the closure fires.
  runtime.scheduleClosureCall(captured.closures[0], [1], {});
  await waitFor(() => captured.calls.length === 1, { label: 'pre-quiesce call fired' });
  assertEquals(captured.calls, [1]);

  // Quiesce, then schedule two calls — they enqueue but don't fire.
  await runtime.quiesce();
  runtime.scheduleClosureCall(captured.closures[0], [2], {});
  runtime.scheduleClosureCall(captured.closures[0], [3], {});
  await tick(20);
  assertEquals(captured.calls, [1],
    'closures scheduled during quiesce did not fire');

  // Resume drains the queue in FIFO order.
  runtime.resume();
  await waitFor(() => captured.calls.length === 3,
    { label: 'queued closures drained on resume' });
  assertEquals(captured.calls, [1, 2, 3]);

  // Fresh schedules after resume continue to work.
  runtime.scheduleClosureCall(captured.closures[0], [4], {});
  await waitFor(() => captured.calls.length === 4, { label: 'post-resume call fired' });
  assertEquals(captured.calls, [1, 2, 3, 4]);

  await runtime.terminate();
  channels.close();
});

Deno.test("quiesce: a dequeued closure refused at drive admission resumes exactly once", async () => {
  const captured = { closure: null, calls: [] };
  let releaseBackpressure;
  let reportBackpressure;
  let reportDrive;
  let reportCall;
  const backpressureGate = new Promise((resolve) => {
    releaseBackpressure = resolve;
  });
  const backpressureEntered = new Promise((resolve) => {
    reportBackpressure = resolve;
  });
  const driveAttempted = new Promise((resolve) => {
    reportDrive = resolve;
  });
  const callCompleted = new Promise((resolve) => {
    reportCall = resolve;
  });
  let reportFinalIdle;
  const finalIdle = new Promise((resolve) => {
    reportFinalIdle = resolve;
  });
  const { runtime, session, channels } = new RuntimeBuilder()
    .capability({
      name: 'host',
      setup: (airlock) => {
        const root = airlock.createRootGrant();
        const handle = airlock.register({});
        root.add(handle);
        airlock.setHandler(handle, 'register', ({ args }) => {
          captured.closure = args[0];
          return null;
        });
        airlock.setHandler(handle, 'callback', ({ args }) => {
          captured.calls.push(args[0]);
          reportCall();
          return null;
        });
        airlock.declare('Host', handle);
      },
    })
    .onSchedulerIdle(() => {
      if (captured.calls.length === 1) reportFinalIdle();
    })
    .onInboundMessage(() => {})
    .build();
  runtime.extraSchedulerBackpressure = () => {
    reportBackpressure();
    return backpressureGate;
  };
  runtime.onClosureDispatch = (event) => {
    if (event.kind === 'drive') reportDrive();
  };
  await runtime.start();
  session.parse(`Host.register(function(n) { Host.callback(n) })`);
  await runtime.run(0);

  runtime.scheduleClosureCall(captured.closure, [42], {});
  await backpressureEntered;
  await runtime.quiesce();
  releaseBackpressure();
  await driveAttempted;

  assertEquals(captured.calls, []);
  assertEquals(runtime.getSchedulerStats().deferredWakes.length, 1);
  assertEquals(runtime.getSchedulerStats().parkedCleanupSlots.length, 1);

  runtime.resume();
  await callCompleted;
  await finalIdle;
  await Promise.resolve();
  assertEquals(captured.calls, [42]);
  assertEquals(runtime.getSchedulerStats().deferredWakes.length, 0);

  await runtime.terminate();
  channels.close();
});

// =============================================================================
// Spawned slots queued during quiesce dispatch on resume
// =============================================================================

Deno.test("quiesce: a slot wake during quiesce is deferred until resume", async () => {
  let releaseHandler;
  const handlerPromise = new Promise(r => { releaseHandler = r; });
  const events = [];

  const { runtime, session, channels } = new RuntimeBuilder()
    .capability({
      name: 'host',
      setup: (al) => {
        const root = al.createRootGrant();
        const handle = al.register({});
        root.add(handle);
        al.setHandler(handle, 'wait', () => handlerPromise);
        al.setHandler(handle, 'mark', ({ args }) => { events.push(args[0]); return null; });
        al.declare('Host', handle);
      },
    })
    .onInboundMessage(() => {})
    .build();
  await runtime.start();

  session.parse(`
    async function main() {
      await Host.wait();
      Host.mark("after-wait");
    }
    let _ = main();
  `);
  const runPromise = runtime.run(0);
  await tick(10);

  // Quiesce while the slot is parked.
  await runtime.quiesce();
  assertEquals(runtime.runtimeState.get(), RUNTIME_STATE.QUIESCED);

  // Release the handler. The slot's wake fires onPendingSpawnedContexts,
  // which calls _drainPendingSpawned — but that's a no-op while quiesced.
  // So the slot stays parked even though its dependency settled.
  releaseHandler();
  await tick(20);
  assertEquals(events, [],
    'wake during quiesce is deferred — main has not yet resumed');

  // Resume drains the pending spawned queue.
  runtime.resume();
  await runPromise;
  assertEquals(events, ['after-wait']);

  await runtime.terminate();
  channels.close();
});

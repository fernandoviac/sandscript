/**
 * Integration tests for the runtime-state cell published by
 * Runtime / Scheduler / ChannelLoop / Runtime.send.
 *
 * Phase 1 covered the cell primitive in isolation (set/get/wait/
 * rebind) and exercised cross-thread Atomics.wait. Phase 2
 * covered the membrane allocation. This file covers the live
 * runtime: real start, quiesce, resume, GC, send, terminate —
 * with assertions about what `runtime.runtimeState.get()` (and
 * the equivalent `runtime.getSchedulerStats().state`) holds at
 * each stage.
 *
 * Run with: deno task test tests/runtime/runtime_state_integration_test.js
 */

import { assertEquals, assert } from "https://deno.land/std@0.208.0/assert/mod.ts";
import { Runtime, RUNTIME_STATE } from '../../src/runtime/index.js';
import { RuntimeBuilder, createPairedChannels } from '../../src/runtime/test-harness.js';
import { createSession } from '../../src/fuel/session.js';
import { freshSession } from '../../src/host-owned-session.js';

const u8 = (s) => new TextEncoder().encode(s);
const tick = (ms = 0) => new Promise(r => setTimeout(r, ms));

// =============================================================================
// Initial state
// =============================================================================

Deno.test("integration: a brand-new runtime (before start) reports SCHEDULER_IDLE", () => {
  const { runtime, channels } = new RuntimeBuilder()
    .onInboundMessage(() => {})
    .build();
  assertEquals(runtime.runtimeState.get(), RUNTIME_STATE.SCHEDULER_IDLE,
    'fresh membrane initializes the cell to SCHEDULER_IDLE');
  // stats.state agrees.
  assertEquals(runtime.getSchedulerStats().state, RUNTIME_STATE.SCHEDULER_IDLE);
  channels.close();
});

// =============================================================================
// Channel-loop publishes INBOUND_LOOP when idle
// =============================================================================

Deno.test("integration: idle runtime ends up in INBOUND_LOOP after start", async () => {
  const { runtime, channels } = new RuntimeBuilder()
    .onInboundMessage(() => {})
    .build();
  await runtime.start();
  // Let the channel-loop's first iteration settle into receive().
  await tick(5);
  assertEquals(runtime.runtimeState.get(), RUNTIME_STATE.INBOUND_LOOP,
    'channel loop should publish INBOUND_LOOP while parked on receive()');
  assertEquals(runtime.getSchedulerStats().state, RUNTIME_STATE.INBOUND_LOOP,
    'stats.state mirrors the cell');
  await runtime.terminate();
  channels.close();
});

// =============================================================================
// quiesce → resume cycle
// =============================================================================

Deno.test("integration: quiesce on an idle runtime publishes QUIESCED, resume goes back to SCHEDULER_IDLE", async () => {
  const { runtime, channels } = new RuntimeBuilder()
    .onInboundMessage(() => {})
    .build();
  await runtime.start();
  await tick(5);
  // Quiesce: nothing in flight, so the scheduler publishes QUIESCED.
  await runtime.quiesce();
  assertEquals(runtime.runtimeState.get(), RUNTIME_STATE.QUIESCED,
    'quiesce on an idle scheduler publishes QUIESCED');
  // Resume: nothing in flight, scheduler publishes SCHEDULER_IDLE.
  runtime.resume();
  assertEquals(runtime.runtimeState.get(), RUNTIME_STATE.SCHEDULER_IDLE,
    'resume publishes SCHEDULER_IDLE when nothing is in flight');
  await runtime.terminate();
  channels.close();
});

// =============================================================================
// send → OUTBOUND_DRAIN → RUNNING
// =============================================================================

Deno.test("integration: runtime.send publishes OUTBOUND_DRAIN during the await, then RUNNING when done", async () => {
  // Build a runtime with an outbound channel whose send blocks
  // until we explicitly release it, so we can observe the cell
  // mid-send.
  let releaseSend = null;
  const slowOutbound = {
    send: () => new Promise(r => { releaseSend = r; }),
    trySend: () => true,
  };
  const session = freshSession();
  const pair = createPairedChannels();
  const runtime = new Runtime({
    session,
    inboundChannel: pair.a,
    outboundChannel: slowOutbound,
    capabilities: [],
    hostServices: {},
    subsystems: {},
    onInboundMessage: () => {},
  });
  await runtime.start();

  const sendPromise = runtime.send(u8('payload'));
  await tick(20);
  assertEquals(runtime.runtimeState.get(), RUNTIME_STATE.OUTBOUND_DRAIN,
    'cell holds OUTBOUND_DRAIN while runtime.send awaits the channel');

  releaseSend();
  await sendPromise;
  await tick(5);
  assertEquals(runtime.runtimeState.get(), RUNTIME_STATE.RUNNING,
    'cell returns to RUNNING after send completes');

  await runtime.terminate();
  pair.close();
});

// =============================================================================
// stats.state reads live from the cell (single source of truth)
// =============================================================================

Deno.test("integration: stats.state and runtime.runtimeState.get() are equal by construction", async () => {
  // The scheduler writes the cell; ChannelLoop writes the cell;
  // runtime.send writes the cell. getSchedulerStats().state reads
  // the cell. They must always agree.
  const { runtime, channels } = new RuntimeBuilder()
    .onInboundMessage(() => {})
    .build();
  await runtime.start();
  // Sample at several stages.
  await tick(5);
  assertEquals(runtime.runtimeState.get(), runtime.getSchedulerStats().state,
    'idle: cell and stats agree');
  await runtime.quiesce();
  assertEquals(runtime.runtimeState.get(), runtime.getSchedulerStats().state,
    'quiesced: cell and stats agree');
  runtime.resume();
  assertEquals(runtime.runtimeState.get(), runtime.getSchedulerStats().state,
    'resumed: cell and stats agree');
  await runtime.terminate();
  channels.close();
});

// =============================================================================
// External (cross-thread) observer wakes on a transition
// =============================================================================
//
// Phase 1 had a worker test for the cell primitive in isolation;
// this is the integration equivalent: a worker waits on
// runtime.runtimeState's underlying cell and wakes when the
// runtime transitions. Proves the membrane SAB is observable
// from another realm and that the runtime's writes do hit it.

Deno.test("integration: a worker can Atomics.wait on the cell and wake on a runtime transition", async () => {
  // Build a runtime over a SharedArrayBuffer-backed membrane so
  // the cell can be observed across realms. Use small capacities
  // so the membrane fits in a modest SAB; the test doesn't need
  // large tables.
  const session = freshSession({ membraneBuffer: new SharedArrayBuffer(64 * 1024), handleTableCapacity: 32, grantTableCapacity: 16, idListPoolSize: 1024, rootGrantsListCapacity: 4, valueArenaSize: 1024, closureHandleTableCapacity: 8, linkedPromiseTableCapacity: 8, mutationLogCapacity: 16, costLedgerCapacity: 16 });
  const pair = createPairedChannels();
  const runtime = new Runtime({
    session,
    inboundChannel: pair.a,
    outboundChannel: pair.a,
    capabilities: [],
    hostServices: {},
    subsystems: {},
    onInboundMessage: () => {},
  });
  await runtime.start();
  await tick(5);

  // The cell currently holds INBOUND_LOOP. Spawn a worker that
  // waits on it until the value changes; then we'll cause a
  // transition (quiesce → QUIESCED) and the worker wakes.
  const membrane = session.airlock.membrane;
  const stateOffset = membrane.view.getUint32(
    /* HEADER.RUNTIME_STATE_OFFSET */ 248, true);
  const absoluteOffset = membrane.byteOffset + stateOffset;

  const workerSrc = `
    self.onmessage = (e) => {
      const { buffer, byteOffset, currentValue } = e.data;
      const view = new Int32Array(buffer, byteOffset, 1);
      const result = Atomics.wait(view, 0, currentValue, 5000);
      const observed = Atomics.load(view, 0);
      self.postMessage({ result, observed });
    };
  `;
  const blob = new Blob([workerSrc], { type: 'application/javascript' });
  const worker = new Worker(URL.createObjectURL(blob), { type: 'module' });

  const wakePromise = new Promise(resolve => {
    worker.onmessage = (e) => resolve(e.data);
  });

  worker.postMessage({
    buffer: membrane.buffer,
    byteOffset: absoluteOffset,
    currentValue: RUNTIME_STATE.INBOUND_LOOP,
  });

  // Brief delay so the worker is parked in Atomics.wait before
  // we cause the transition.
  await tick(50);
  await runtime.quiesce();
  // The transition to QUIESCED triggers Atomics.notify in
  // runtimeState.set(); the worker wakes.
  const { result, observed } = await wakePromise;
  worker.terminate();

  assertEquals(result, 'ok', 'worker observed a transition');
  assertEquals(observed, RUNTIME_STATE.QUIESCED,
    'worker read the post-transition value');

  await runtime.terminate();
  pair.close();
});

/**
 * Swarm integration tests — outbound emission contract.
 *
 * The Runtime sends bytes to its host through `send()` and `trySend()` over
 * the configured outboundChannel. Pinned behavior:
 *
 *   - send() forwards bytes verbatim and arrives in order
 *   - trySend() returns the channel's verdict directly
 *     (true on accept, false on full)
 *   - while send() is awaiting the channel's send Promise,
 *     `runtime.runtimeState` reads OUTBOUND_DRAIN; once
 *     resolved, it reverts to RUNNING
 *   - if the channel's send rejects, the runtime's send
 *     rejects too (loud-fail) and runtimeState reverts to
 *     RUNNING (the finally block runs)
 *   - send() preserves call order even when the channel
 *     applies backpressure (sender awaits each)
 *
 * Run with:
 *   deno task test tests/runtime/swarm/outbound_emission_test.js
 */

import { assertEquals, assertRejects } from "https://deno.land/std@0.208.0/assert/mod.ts";
import { createSession } from '../../../src/fuel/session.js';
import { Runtime, RUNTIME_STATE, createPairedChannels } from '../../../src/runtime/index.js';
import { freshSession } from '../../../src/host-owned-session.js';
import { collectMessages } from '../host-helpers.js';

const u8 = (s) => new TextEncoder().encode(s);
const utf = (b) => new TextDecoder().decode(b);

function tick(ms = 0) { return new Promise(r => setTimeout(r, ms)); }

/**
 * Build a Runtime whose outbound channel is a wrapper around
 * a paired-channel endpoint. The wrapper exposes hooks to
 * gate trySend / send so tests can simulate backpressure or
 * forced rejection.
 */
function buildRuntimeWithGatedOutbound(opts = {}) {
  const session = freshSession();
  const channels = createPairedChannels();

  const trySendVerdict = opts.trySendVerdict ?? (() => true);
  const sendImpl = opts.sendImpl ?? ((p) => channels.a.send(p));

  let trySendCalls = 0;
  let sendCalls = 0;
  const wrappedOutbound = {
    send: (payload) => { sendCalls++; return sendImpl(payload); },
    trySend: (payload) => {
      trySendCalls++;
      if (!trySendVerdict()) return false;
      return channels.a.trySend(payload);
    },
  };

  const runtime = new Runtime({
    session,
    inboundChannel:    channels.a,
    outboundChannel:   wrappedOutbound,
    capabilities:      [],
    hostServices:      {},
    subsystems:        {},
    onInboundMessage:  () => {},
    name:              'outbound-emission-test',
  });

  return {
    runtime,
    host: channels.b,
    channels,
    counts: () => ({ trySendCalls, sendCalls }),
  };
}

// =============================================================================
// send: bytes pass through verbatim and in order
// =============================================================================

Deno.test("outbound emission: send bytes arrive verbatim and in order", async () => {
  const { runtime, host, channels } = buildRuntimeWithGatedOutbound();
  const sink = collectMessages(host);
  await runtime.start();

  await runtime.send(u8('a'));
  await runtime.send(u8('b'));
  await runtime.send(new Uint8Array([0, 1, 2, 0xff]));

  const m1 = await sink.nextMessage();
  const m2 = await sink.nextMessage();
  const m3 = await sink.nextMessage();
  assertEquals(utf(m1.payload), 'a');
  assertEquals(utf(m2.payload), 'b');
  assertEquals(m3.payload.byteLength, 4);
  assertEquals(m3.payload[3], 0xff);

  sink.unsubscribe();
  await runtime.terminate();
  channels.close();
});

// =============================================================================
// trySend: returns channel verdict directly
// =============================================================================

Deno.test("outbound emission: trySend forwards channel verdict", async () => {
  let allow = true;
  const { runtime, host, channels, counts } = buildRuntimeWithGatedOutbound({
    trySendVerdict: () => allow,
  });
  const sink = collectMessages(host);
  await runtime.start();

  assertEquals(runtime.trySend(u8('ok')), true);
  allow = false;
  assertEquals(runtime.trySend(u8('nope')), false);

  // Only the accepted message reached the host. Use the async
  // nextMessage to give the harness's enqueue path a microtask
  // to deliver, then verify no second message lurks.
  const got = await sink.nextMessage();
  assertEquals(utf(got.payload), 'ok');
  assertEquals(sink.tryNextMessage(), null);
  assertEquals(counts().trySendCalls, 2);

  sink.unsubscribe();
  await runtime.terminate();
  channels.close();
});

// =============================================================================
// runtimeState: OUTBOUND_DRAIN while awaiting send, RUNNING after
// =============================================================================

Deno.test("outbound emission: runtimeState reads OUTBOUND_DRAIN while parked on send", async () => {
  let release;
  const gate = new Promise(r => { release = r; });

  const { runtime, channels } = buildRuntimeWithGatedOutbound({
    sendImpl: () => gate,  // never resolves until release()
  });
  await runtime.start();

  // Kick off send; do not await yet.
  const sendPromise = runtime.send(u8('blocked'));

  // Give the runtime a microtask to enter the await and publish state.
  await tick(5);
  assertEquals(runtime.runtimeState.get(), RUNTIME_STATE.OUTBOUND_DRAIN,
    'state is OUTBOUND_DRAIN while parked on send');

  // Release; finally clause must restore RUNNING.
  release();
  await sendPromise;
  assertEquals(runtime.runtimeState.get(), RUNTIME_STATE.RUNNING,
    'state restored to RUNNING after send resolves');

  await runtime.terminate();
  channels.close();
});

// =============================================================================
// runtimeState: restored to RUNNING even if channel rejects
// =============================================================================

Deno.test("outbound emission: send rejection propagates and runtimeState reverts", async () => {
  const { runtime, channels } = buildRuntimeWithGatedOutbound({
    sendImpl: () => Promise.reject(new Error('channel boom')),
  });
  await runtime.start();

  await assertRejects(
    () => runtime.send(u8('x')),
    Error,
    'channel boom',
  );
  assertEquals(runtime.runtimeState.get(), RUNTIME_STATE.RUNNING,
    'state restored to RUNNING after send rejection');

  await runtime.terminate();
  channels.close();
});

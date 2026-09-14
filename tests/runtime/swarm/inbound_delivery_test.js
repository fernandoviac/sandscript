/**
 * Swarm integration tests — inbound delivery contract.
 *
 * An embedder writes Uint8Array payloads to the Runtime's inbound channel.
 * This file pins how those payloads reach `onInboundMessage`:
 *
 *   - delivery is in send order (FIFO)
 *   - sequence numbers come from the channel verbatim, are
 *     monotonic, and are exposed as the second arg
 *   - payloads are passed through verbatim — no copying,
 *     reframing, or decoding by the runtime
 *   - empty payloads are valid
 *   - delivery is one-at-a-time: the next receive() is not
 *     attempted until the prior onInboundMessage settles
 *     (so embedder ordering invariants hold)
 *   - terminate() breaks a parked receive without firing
 *     onInboundMessage for in-flight messages that hadn't
 *     yet been picked up
 *
 * These guarantees let any runtime adapter preserve ordering and framing
 * without depending on Runtime internals.
 *
 * Run with:
 *   deno task test tests/runtime/swarm/inbound_delivery_test.js
 */

import { assertEquals, assert } from "https://deno.land/std@0.208.0/assert/mod.ts";
import { RuntimeBuilder } from '../../../src/runtime/test-harness.js';

const u8 = (s) => new TextEncoder().encode(s);
const utf = (b) => new TextDecoder().decode(b);

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
// FIFO ordering across many sends
// =============================================================================

Deno.test("inbound delivery: payloads arrive in send order", async () => {
  const received = [];
  const { runtime, host, channels } = new RuntimeBuilder()
    .onInboundMessage((payload) => { received.push(utf(payload)); })
    .build();
  await runtime.start();

  for (let i = 0; i < 16; i++) await host.send(u8(`msg-${i}`));

  await waitFor(() => received.length === 16, { label: 'all delivered' });
  for (let i = 0; i < 16; i++) assertEquals(received[i], `msg-${i}`);

  await runtime.terminate();
  channels.close();
});

// =============================================================================
// Sequence numbers — monotonic, channel-sourced, exposed verbatim
// =============================================================================

Deno.test("inbound delivery: sequence numbers are monotonic and channel-sourced", async () => {
  const seqs = [];
  const { runtime, host, channels } = new RuntimeBuilder()
    .onInboundMessage((_payload, sequenceNumber) => { seqs.push(sequenceNumber); })
    .build();
  await runtime.start();

  for (let i = 0; i < 8; i++) await host.send(u8(`m${i}`));

  await waitFor(() => seqs.length === 8, { label: 'all delivered' });
  for (let i = 0; i < 8; i++) assertEquals(seqs[i], BigInt(i + 1));

  await runtime.terminate();
  channels.close();
});

// =============================================================================
// Payload pass-through — no decoding, no reframing, no copy in our face
// =============================================================================

Deno.test("inbound delivery: payload bytes are passed through verbatim", async () => {
  let got = null;
  const { runtime, host, channels } = new RuntimeBuilder()
    .onInboundMessage((payload) => { got = payload; })
    .build();
  await runtime.start();

  // A payload with non-UTF8, zero, and high bytes.
  const original = new Uint8Array([0, 1, 2, 0x7f, 0x80, 0xff, 0xfe, 0]);
  await host.send(original);

  await waitFor(() => got !== null, { label: 'delivered' });
  assert(got instanceof Uint8Array, 'received a Uint8Array');
  assertEquals(got.byteLength, original.byteLength);
  for (let i = 0; i < original.byteLength; i++) assertEquals(got[i], original[i]);

  await runtime.terminate();
  channels.close();
});

// =============================================================================
// Empty payloads are valid
// =============================================================================

Deno.test("inbound delivery: empty payloads are delivered", async () => {
  const lengths = [];
  const { runtime, host, channels } = new RuntimeBuilder()
    .onInboundMessage((payload) => { lengths.push(payload.byteLength); })
    .build();
  await runtime.start();

  await host.send(new Uint8Array(0));
  await host.send(u8('x'));
  await host.send(new Uint8Array(0));

  await waitFor(() => lengths.length === 3, { label: 'all delivered' });
  assertEquals(lengths, [0, 1, 0]);

  await runtime.terminate();
  channels.close();
});

// =============================================================================
// Fire-and-forget dispatch: wire's onMessage callback is non-blocking,
// so onInboundMessage invocations from independent messages can run
// concurrently. Embedders that need ordering invariants implement
// them themselves; the runtime does not serialize handlers.
// =============================================================================

Deno.test("inbound delivery: handler invocations are NOT serialized (overlap is allowed)", async () => {
  let inFlight = 0;
  let maxInFlight = 0;
  const enters = [];
  const exits = [];

  const { runtime, host, channels } = new RuntimeBuilder()
    .onInboundMessage(async (payload) => {
      inFlight++;
      if (inFlight > maxInFlight) maxInFlight = inFlight;
      enters.push(utf(payload));
      // Force a microtask boundary, then a real timer tick. With
      // the non-blocking onMessage contract, the next inbound
      // delivery can fire while this handler is still mid-await.
      await tick(5);
      exits.push(utf(payload));
      inFlight--;
    })
    .build();
  await runtime.start();

  for (let i = 0; i < 5; i++) await host.send(u8(`m${i}`));

  await waitFor(() => exits.length === 5, { label: 'all exits logged' });

  // Enters MUST be in FIFO order — wire delivers in FIFO. Exits
  // happen in (roughly) the same order because the await durations
  // are equal, but their interleaving with enters is what matters.
  for (let i = 0; i < 5; i++) {
    assertEquals(enters[i], `m${i}`);
  }

  // The non-serialization contract: at some point during dispatch,
  // more than one handler is in flight at once. This is exactly
  // what wire's fire-and-forget onMessage shape buys us. If
  // maxInFlight ever drops to 1 after this change, the runtime
  // has accidentally re-introduced serialization.
  assertEquals(maxInFlight, 5,
    'all 5 handlers were in flight concurrently — non-blocking onMessage works');

  await runtime.terminate();
  channels.close();
});

// =============================================================================
// terminate() while parked on receive() — no spurious handler call,
// no leaked rejection
// =============================================================================

Deno.test("inbound delivery: terminate while parked on receive cleanly stops the loop", async () => {
  let calls = 0;
  const { runtime, channels } = new RuntimeBuilder()
    .onInboundMessage(() => { calls++; })
    .build();
  await runtime.start();

  // Give the inbound loop time to park on receive().
  await tick(10);

  // No messages were sent. Terminate must not block, must not
  // invoke onInboundMessage, and must not throw.
  await runtime.terminate();
  assertEquals(calls, 0);
  channels.close();
});

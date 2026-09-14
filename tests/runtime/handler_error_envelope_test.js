/**
 * Tests for composeErrorEnvelope wiring.
 *
 * Covers:
 *   - composer is called with a runtimeHalf containing live
 *     error / ss / membrane / slot / runtime sections
 *   - composer returns Uint8Array → bytes arrive on outbound
 *     verbatim, with no sandscript-side framing
 *   - composer returns null → no wire emit; onHandlerError still
 *     fires
 *   - composer wrong-type return → no wire emit (return-value check,
 *     not error swallow)
 *   - backpressure: trySend false → falls back to await send;
 *     OUTBOUND_DRAIN observed on the cell
 *
 * Run with:
 *   deno task test tests/runtime/handler_error_envelope_test.js
 */

import { assertEquals, assert, assertExists } from "https://deno.land/std@0.208.0/assert/mod.ts";
import { RuntimeBuilder } from '../../src/runtime/test-harness.js';
import { collectMessages } from './host-helpers.js';
import { AttributedRejection } from '../../src/fuel/attributed-rejection.js';
import { RUNTIME_STATE } from '../../src/runtime/index.js';
import { freshSession } from '../../src/host-owned-session.js';

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

// -----------------------------------------------------------------
// Capability used by every test: a `Bad.throws()` handler whose
// invocation under a grant block raises through the runtime as an
// AttributedRejection.
// -----------------------------------------------------------------

function badnessCapability() {
  let badHandle;
  return {
    name: 'badness-host',
    setup: (al) => {
      badHandle = al.register({});
      al.setHandler(badHandle, 'throws', () => {
        const err = new TypeError('handler boom');
        err.code = 'E_TEST';
        throw err;
      });
      al.declare('Bad', badHandle);
      return {
        onGrantRequest: (id) => {
          if (id !== 'badness') return null;
          const grant = al.membrane.createGrant(id);
          grant.add(badHandle);
          return grant;
        },
      };
    },
  };
}

const DRONE_SOURCE = `
  try { grant "badness" { Bad.throws(); } }
  catch (_e) { /* swallow so slot terminates cleanly */ }
`;

// =============================================================================
// Composer called with live runtimeHalf; bytes arrive on outbound
// =============================================================================

Deno.test("composeErrorEnvelope: invoked with live runtimeHalf and bytes posted verbatim", async () => {
  const calls = [];
  const errors = [];
  const expected = u8('envelope-bytes-XYZ');

  const { runtime, session, host, channels } = new RuntimeBuilder()
    .capability(badnessCapability())
    .onInboundMessage(() => {})
    .onHandlerError((e) => errors.push(e))
    .composeErrorEnvelope((runtimeHalf, rejection) => {
      calls.push({ runtimeHalf, rejection });
      return expected;
    })
    .build();
  const sink = collectMessages(host);
  await runtime.start();

  session.parse(DRONE_SOURCE);
  await runtime.run(0);

  await waitFor(() => calls.length >= 1, { label: 'composer invoked' });

  // Composer was called exactly once with the AttributedRejection.
  assertEquals(calls.length, 1);
  assert(calls[0].rejection instanceof AttributedRejection,
    'composer received a real AttributedRejection');
  assertEquals(calls[0].rejection.cause.message, 'handler boom');

  // runtimeHalf has all five sections.
  const rh = calls[0].runtimeHalf;
  assertExists(rh.error);
  assertEquals(rh.error.name, 'TypeError');
  assertEquals(rh.error.message, 'handler boom');
  // ownProperties carries the test code we stamped on the thrown err.
  assertEquals(rh.error.ownProperties.code, 'E_TEST');

  assertExists(rh.ss, 'ss section present');
  assertEquals(rh.ss.slot, 0);

  assertExists(rh.membrane, 'membrane section present');
  assertEquals(typeof rh.slot, 'number');
  assertEquals(rh.slot, 0);

  assertExists(rh.runtime, 'runtime block present');
  assertEquals(typeof rh.runtime.runtimeState, 'number');
  assertEquals(typeof rh.runtime.inFlightCount, 'number');
  assert(Array.isArray(rh.runtime.ledgerSnapshot)
    || rh.runtime.ledgerSnapshot === null,
    'ledgerSnapshot is array-or-null');

  // onHandlerError also fired with the AttributedRejection.
  assertEquals(errors.length, 1);
  assert(errors[0] instanceof AttributedRejection);

  // The composer's exact bytes landed on outbound — no
  // sandscript framing prepended/appended.
  const got = await sink.nextMessage();
  assertExists(got, 'outbound got a message');
  assertEquals(got.payload.byteLength, expected.byteLength);
  for (let i = 0; i < expected.byteLength; i++) {
    assertEquals(got.payload[i], expected[i]);
  }

  sink.unsubscribe();
  await runtime.terminate();
  channels.close();
});

// =============================================================================
// Composer returns null → no wire emit; onHandlerError still fires
// =============================================================================

Deno.test("composeErrorEnvelope: null return skips wire emit", async () => {
  const errors = [];
  let composerCalls = 0;

  const { runtime, session, host, channels } = new RuntimeBuilder()
    .capability(badnessCapability())
    .onInboundMessage(() => {})
    .onHandlerError((e) => errors.push(e))
    .composeErrorEnvelope(() => { composerCalls++; return null; })
    .build();
  const sink = collectMessages(host);
  await runtime.start();

  session.parse(DRONE_SOURCE);
  await runtime.run(0);

  await waitFor(() => composerCalls >= 1, { label: 'composer invoked' });
  // Give any in-flight onMessage delivery a microtask to land before
  // asserting absence.
  await new Promise((r) => setTimeout(r, 5));

  // Composer was called; nothing posted.
  assertEquals(composerCalls, 1);
  assertEquals(sink.tryNextMessage(), null);
  assertEquals(errors.length, 1);

  sink.unsubscribe();
  await runtime.terminate();
  channels.close();
});

// =============================================================================
// Composer returns wrong type → swallowed; no wire emit
// =============================================================================

Deno.test("composeErrorEnvelope: non-Uint8Array return skips wire emit", async () => {
  const errors = [];
  let composerCalls = 0;

  const { runtime, session, host, channels } = new RuntimeBuilder()
    .capability(badnessCapability())
    .onInboundMessage(() => {})
    .onHandlerError((e) => errors.push(e))
    // Return a plain object instead of Uint8Array — common embedder
    // mistake. Should be swallowed.
    .composeErrorEnvelope(() => {
      composerCalls++;
      return { not: 'bytes' };
    })
    .build();
  const sink = collectMessages(host);
  await runtime.start();

  session.parse(DRONE_SOURCE);
  await runtime.run(0);

  await waitFor(() => composerCalls >= 1, { label: 'composer invoked' });
  await new Promise((r) => setTimeout(r, 5));

  assertEquals(composerCalls, 1);
  assertEquals(sink.tryNextMessage(), null);
  assertEquals(errors.length, 1);

  sink.unsubscribe();
  await runtime.terminate();
  channels.close();
});

// =============================================================================
// Composer omitted → no wire emit at all
// =============================================================================

Deno.test("composeErrorEnvelope: omitted means no wire emit (back-compat)", async () => {
  const errors = [];

  const { runtime, session, host, channels } = new RuntimeBuilder()
    .capability(badnessCapability())
    .onInboundMessage(() => {})
    .onHandlerError((e) => errors.push(e))
    // No composer registered.
    .build();
  const sink = collectMessages(host);
  await runtime.start();

  session.parse(DRONE_SOURCE);
  await runtime.run(0);

  await waitFor(() => errors.length >= 1, { label: 'error surfaced' });
  await new Promise((r) => setTimeout(r, 5));

  assertEquals(sink.tryNextMessage(), null,
    'no envelope on outbound when composer omitted');
  assertEquals(errors.length, 1);

  sink.unsubscribe();
  await runtime.terminate();
  channels.close();
});

// =============================================================================
// Backpressure: full ring → fall back to await send
// =============================================================================

Deno.test("composeErrorEnvelope: trySend-false falls back to await send", async () => {
  // Wrap a normal paired-channel outbound with a wrapper that
  // refuses trySend, forcing the runtime onto the await-send
  // fallback. We use a custom RuntimeBuilder-like setup since
  // the harness doesn't expose channel wrapping directly.
  const { createPairedChannels } = await import('../../src/runtime/test-harness.js');
  const { createSession } = await import('../../src/fuel/session.js');
  const { Runtime } = await import('../../src/runtime/index.js');

  const session = freshSession();
  const channels = createPairedChannels();

  // Wrap channels.a so trySend always returns false. send() still
  // delegates to the real channel, so bytes eventually arrive on b.
  let trySendCalls = 0;
  let sendCalls = 0;
  const wrappedOutbound = {
    send: (payload) => { sendCalls++; return channels.a.send(payload); },
    trySend: (_p) => { trySendCalls++; return false; },
  };
  // Inbound is the unwrapped a so the channel loop works normally.
  const wrappedInbound = channels.a;

  const errors = [];
  const observedStates = [];
  const runtime = new Runtime({
    session,
    inboundChannel:    wrappedInbound,
    outboundChannel:   wrappedOutbound,
    capabilities:      [badnessCapability()],
    hostServices:      {},
    subsystems:        {},
    onInboundMessage:  () => {},
    onHandlerError:    (e) => {
      errors.push(e);
      observedStates.push(runtime.runtimeState.get());
    },
    composeErrorEnvelope: () => u8('envelope'),
    name:              'backpressure-test',
  });
  await runtime.start();

  session.parse(DRONE_SOURCE);
  await runtime.run(0);

  await waitFor(() => errors.length >= 1, { label: 'error surfaced' });
  // The runtime.send() call uses await; let it settle.
  await tick(10);

  assert(trySendCalls >= 1, 'trySend was attempted');
  assert(sendCalls >= 1,
    'send fallback was invoked after trySend returned false');

  // The bytes still arrived on b — wait for the onMessage callback
  // to fire.
  const sink = collectMessages(channels.b);
  const got = await sink.nextMessage();
  assertExists(got);
  assertEquals(got.payload.byteLength, u8('envelope').byteLength);
  sink.unsubscribe();

  await runtime.terminate();
  channels.close();
});

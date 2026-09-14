/**
 * Swarm integration tests — host-service round-trip pattern.
 *
 * Host services work like this from the Runtime's perspective:
 *
 *   drone code:   let r = await Host.callOut(args);
 *   handler:      ({ args }) => new Promise((resolve, reject) => {
 *                    pending.set(callId, { resolve, reject });
 *                    runtime.send(buildHostServiceCallEnvelope(callId, args));
 *                  });
 *   inbound:      the host eventually delivers a HOST_SERVICE_RESULT
 *                 for callId; onInboundMessage looks up pending[callId]
 *                 and resolves or rejects it.
 *   slot:         the await unparks with the resolved value
 *                 (or throws on reject); execution continues.
 *
 * This is just a Promise-returning handler from the airlock's
 * point of view, but call out, slot park, inbound result, and slot resume form
 * the load-bearing host-service pattern. Pinning it here ensures the Airlock
 * and Runtime deliver the round-trip without surprises.
 *
 * Covered:
 *   - resolve path: drone awaits the handler-returned Promise,
 *     embedder resolves it from inbound, drone receives the
 *     value and continues
 *   - reject path: rejection surfaces as a thrown error inside
 *     the await; drone-level try/catch sees it
 *   - multiplexing: two outstanding host-service calls
 *     resolved out of order; each await wakes with its own
 *     value
 *
 * Run with:
 *   deno task test tests/runtime/swarm/host_service_round_trip_test.js
 */

import { assertEquals, assert } from "https://deno.land/std@0.208.0/assert/mod.ts";
import { RuntimeBuilder } from '../../../src/runtime/test-harness.js';
import { collectMessages } from '../host-helpers.js';

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

/**
 * A representative host-service capability:
 *   - Host.callOut(arg) returns a Promise, stores its resolver by callId,
 *     and sends an outbound call envelope.
 *   - Host.report(value) synchronously exposes the awaited value to the test.
 */
function hostServiceCapability(state) {
  return {
    name: 'host-service',
    setup: (al) => {
      const rootGrant = al.createRootGrant();
      const handle = al.register({});
      rootGrant.add(handle);

      al.setHandler(handle, 'callOut', ({ args }) => {
        const callId = state.nextCallId++;
        return new Promise((resolve, reject) => {
          state.pending.set(callId, { resolve, reject });
          // Outbound envelope: simple "callId|payload" text frame.
          state.runtime.send(u8(`call:${callId}:${args[0]}`));
        });
      });

      al.setHandler(handle, 'report', ({ args }) => {
        state.reports.push(args[0]);
        return null;
      });

      al.setHandler(handle, 'reportError', ({ args }) => {
        state.reportedErrors.push(args[0]);
        return null;
      });

      al.declare('Host', handle);
    },
  };
}

/**
 * Embedder-side decoder: parses inbound text frames of the
 * form "result:<callId>:<value>" or "error:<callId>:<msg>"
 * and resolves/rejects the matching pending entry.
 */
function makeInboundDecoder(state) {
  return (payload) => {
    const text = utf(payload);
    const m = text.match(/^(result|error):(\d+):(.*)$/s);
    if (!m) return;
    const kind = m[1];
    const callId = Number(m[2]);
    const value = m[3];
    const entry = state.pending.get(callId);
    if (!entry) return;
    state.pending.delete(callId);
    if (kind === 'result') entry.resolve(value);
    else entry.reject(new Error(value));
  };
}

// =============================================================================
// resolve path — drone awaits the host-service Promise, value comes back
// =============================================================================

Deno.test("host-service round-trip: resolve path delivers value to awaiting drone", async () => {
  const state = {
    nextCallId: 1,
    pending: new Map(),
    reports: [],
    reportedErrors: [],
    runtime: null,
  };

  const { runtime, session, host, channels } = new RuntimeBuilder()
    .capability(hostServiceCapability(state))
    .onInboundMessage(makeInboundDecoder(state))
    .build();
  const sink = collectMessages(host);
  state.runtime = runtime;
  await runtime.start();

  session.parse(`
    async function main() {
      let r = await Host.callOut("ping");
      Host.report(r);
    }
    let _ = main();
  `);
  const r = await runtime.run(0);
  assertEquals(r.status, 'done');

  // The handler emitted an outbound call envelope.
  const outbound = await sink.nextMessage();
  assertEquals(utf(outbound.payload), 'call:1:ping');

  // The host replies with a result.
  await host.send(u8('result:1:pong'));

  await waitFor(() => state.reports.length === 1, { label: 'drone reported' });
  assertEquals(state.reports[0], 'pong');

  sink.unsubscribe();
  await runtime.terminate();
  channels.close();
});

// =============================================================================
// reject path — drone-level try/catch sees the thrown rejection
// =============================================================================

Deno.test("host-service round-trip: reject path throws inside the awaiting drone", async () => {
  const state = {
    nextCallId: 1,
    pending: new Map(),
    reports: [],
    reportedErrors: [],
    runtime: null,
  };

  const { runtime, session, host, channels } = new RuntimeBuilder()
    .capability(hostServiceCapability(state))
    .onInboundMessage(makeInboundDecoder(state))
    .build();
  const sink = collectMessages(host);
  state.runtime = runtime;
  await runtime.start();

  session.parse(`
    async function main() {
      try {
        await Host.callOut("doomed");
        Host.report("unreachable");
      } catch (e) {
        Host.reportError(e.message);
      }
    }
    let _ = main();
  `);
  const r = await runtime.run(0);
  assertEquals(r.status, 'done');

  const outbound = await sink.nextMessage();
  assertEquals(utf(outbound.payload), 'call:1:doomed');

  await host.send(u8('error:1:remote failure'));

  await waitFor(() => state.reportedErrors.length === 1, { label: 'drone caught error' });
  assertEquals(state.reportedErrors[0], 'remote failure');
  assertEquals(state.reports.length, 0, 'unreachable line did not run');

  sink.unsubscribe();
  await runtime.terminate();
  channels.close();
});

// =============================================================================
// multiplexing — two concurrent host-service calls, results out of order
// =============================================================================

Deno.test("host-service round-trip: concurrent calls resolved out of order each wake the right slot", async () => {
  const state = {
    nextCallId: 1,
    pending: new Map(),
    reports: [],
    reportedErrors: [],
    runtime: null,
  };

  const { runtime, session, host, channels } = new RuntimeBuilder()
    .capability(hostServiceCapability(state))
    .onInboundMessage(makeInboundDecoder(state))
    .build();
  const sink = collectMessages(host);
  state.runtime = runtime;
  await runtime.start();

  // Two parallel async chains, each awaiting its own host-service
  // call and reporting tagged results.
  session.parse(`
    async function chain(label, arg) {
      let r = await Host.callOut(arg);
      Host.report(label + ":" + r);
    }
    let _a = chain("A", "first");
    let _b = chain("B", "second");
  `);
  const r = await runtime.run(0);
  assertEquals(r.status, 'done');

  // Two outbound calls were queued.
  const out1 = await sink.nextMessage();
  const out2 = await sink.nextMessage();
  assertEquals(utf(out1.payload), 'call:1:first');
  assertEquals(utf(out2.payload), 'call:2:second');

  // Reply to call 2 first, then call 1 — out-of-order completion.
  await host.send(u8('result:2:beta'));
  await host.send(u8('result:1:alpha'));

  await waitFor(() => state.reports.length === 2, { label: 'both reported' });
  // Order of reports reflects resolution order, not call order.
  assert(state.reports.includes('A:alpha'),
    `expected 'A:alpha' in reports, got ${JSON.stringify(state.reports)}`);
  assert(state.reports.includes('B:beta'),
    `expected 'B:beta' in reports, got ${JSON.stringify(state.reports)}`);

  sink.unsubscribe();
  await runtime.terminate();
  channels.close();
});

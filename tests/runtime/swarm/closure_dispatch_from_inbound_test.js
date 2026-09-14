/**
 * Swarm integration tests — closure-call dispatch from inbound.
 *
 * The primary closure-driving CALLBACK command flow is:
 *
 *   embedder writes a CALLBACK record to inbound
 *      → Runtime delivers payload to onInboundMessage
 *      → embedder decodes the record, looks up the closure handle by id,
 *        and calls runtime.scheduleClosureCall(...)
 *      → drainer allocates a slot and drives the closure to
 *        terminal completion or error
 *
 * This file pins the contract embedders depend on:
 *
 *   - scheduleClosureCall is callable from inside
 *     onInboundMessage (no re-entrancy lock-out)
 *   - the closure executes asynchronously after
 *     onInboundMessage returns; multiple inbound messages
 *     queue closures FIFO and the drainer runs them one at a
 *     time
 *   - closure args are forwarded verbatim
 *   - closures scheduled while the runtime is terminating
 *     are dropped, not forwarded
 *
 * Run with:
 *   deno task test tests/runtime/swarm/closure_dispatch_from_inbound_test.js
 */

import { assertEquals, assertExists } from "https://deno.land/std@0.208.0/assert/mod.ts";
import { RuntimeBuilder } from '../../../src/runtime/test-harness.js';

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

/**
 * Capability that registers two host methods used by every
 * test in this file:
 *   - Host.register(closure) — drone hands a closure over;
 *     captured for later dispatch
 *   - Host.callback(value)   — drone calls back into the
 *     host; arg captured into a shared array
 */
function hostCapability(captured) {
  return {
    name: 'host',
    setup: (al) => {
      const rootGrant = al.createRootGrant();
      const handle = al.register({});
      rootGrant.add(handle);
      al.setHandler(handle, 'register', ({ args }) => {
        captured.closures.push(args[0]);
        return null;
      });
      al.setHandler(handle, 'callback', ({ args }) => {
        captured.calls.push(args[0]);
        return null;
      });
      al.declare('Host', handle);
    },
  };
}

// =============================================================================
// scheduleClosureCall is callable from inside onInboundMessage
// =============================================================================

Deno.test("closure dispatch: schedule from onInboundMessage delivers args to closure", async () => {
  const captured = { closures: [], calls: [] };
  let runtimeRef;

  const { runtime, session, host, channels } = new RuntimeBuilder()
    .capability(hostCapability(captured))
    .onInboundMessage((payload) => {
      // The "embedder" decodes the payload and treats it as
      // an integer to forward to the captured closure.
      const n = Number(new TextDecoder().decode(payload));
      runtimeRef.scheduleClosureCall(captured.closures[0], [n], {});
    })
    .build();
  runtimeRef = runtime;
  await runtime.start();

  session.parse(`
    Host.register(function(n) { Host.callback(n); });
  `);
  await runtime.run(0);
  assertExists(captured.closures[0], 'closure registered');

  await host.send(u8('42'));
  await waitFor(() => captured.calls.length === 1, { label: 'closure fired' });
  assertEquals(captured.calls[0], 42);

  await runtime.terminate();
  channels.close();
});

// =============================================================================
// Multiple inbound messages → FIFO closure dispatch
// =============================================================================

Deno.test("closure dispatch: multiple inbound messages enqueue closures in order", async () => {
  const captured = { closures: [], calls: [] };
  let runtimeRef;

  const { runtime, session, host, channels } = new RuntimeBuilder()
    .capability(hostCapability(captured))
    .onInboundMessage((payload) => {
      const n = Number(new TextDecoder().decode(payload));
      runtimeRef.scheduleClosureCall(captured.closures[0], [n], {});
    })
    .build();
  runtimeRef = runtime;
  await runtime.start();

  session.parse(`
    Host.register(function(n) { Host.callback(n); });
  `);
  await runtime.run(0);

  for (let i = 0; i < 5; i++) await host.send(u8(String(i)));
  await waitFor(() => captured.calls.length === 5, { label: 'all fired' });
  assertEquals(captured.calls, [0, 1, 2, 3, 4]);

  await runtime.terminate();
  channels.close();
});

// =============================================================================
// scheduleClosureCall after terminate is dropped
// =============================================================================

Deno.test("closure dispatch: scheduleClosureCall is a no-op after terminate", async () => {
  const captured = { closures: [], calls: [] };

  const { runtime, session, channels } = new RuntimeBuilder()
    .capability(hostCapability(captured))
    .onInboundMessage(() => {})
    .build();
  await runtime.start();

  session.parse(`Host.register(function(n) { Host.callback(n); });`);
  await runtime.run(0);
  assertExists(captured.closures[0]);

  await runtime.terminate();

  // Post-terminate scheduleClosureCall must not throw and
  // must not deliver.
  runtime.scheduleClosureCall(captured.closures[0], [99], {});
  await tick(20);
  assertEquals(captured.calls.length, 0);

  channels.close();
});

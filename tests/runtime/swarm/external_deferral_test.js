/**
 * Swarm integration tests — external-event deferral pattern.
 *
 * Models an HTTP-ingress capability. The shape:
 *
 *   external event arrives at the host (e.g. an HTTP request)
 *      → capability stashes a deferred (Promise + resolve/reject)
 *        in a correlationId-keyed registry
 *      → capability notifies the drone (via a host-controlled
 *        surface — here the test calls a method directly that
 *        invokes a drone-registered closure)
 *      → drone calls a "respond" handler with the correlationId
 *        and a payload
 *      → handler looks up the entry, calls resolveResponse(payload)
 *      → the external awaiter unblocks with the drone's value
 *
 * This is the *opposite* direction from host-service-round-trip
 * (where the drone awaits and the host resolves). Here the host
 * awaits and the drone resolves.
 *
 * Pinned:
 *   - round-trip: external await unblocks with the drone's payload
 *   - single-claim: a completed flag prevents a second respond(id)
 *     from settling the same entry
 *   - teardown: in-flight entries reject; external awaiters see
 *     a rejection rather than hanging
 *
 * Run with:
 *   deno task test tests/runtime/swarm/external_deferral_test.js
 */

import { assertEquals, assert, assertRejects } from "https://deno.land/std@0.208.0/assert/mod.ts";
import { RuntimeBuilder } from '../../../src/runtime/test-harness.js';

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
 * Builds a capability that mimics http-ingress's deferred
 * registry. `state` holds:
 *   - registry: Map<correlationId, { promise, resolve, reject, completed }>
 *   - droneCallback: closure registered by the drone via Ingress.subscribe
 *   - reportedErrors: drone-surfaced errors from respond() throws
 *
 * Test code drives external events by calling state.fireRequest(id, body).
 */
function ingressCapability(state) {
  return {
    name: 'ingress',
    setup: (al) => {
      const root = al.createRootGrant();
      const handle = al.register({});
      root.add(handle);

      // Drone subscribes a closure to handle "incoming requests".
      al.setHandler(handle, 'subscribe', ({ args }) => {
        state.droneCallback = args[0];
        return null;
      });

      // Drone calls respond(id, payload). Looks up the entry,
      // resolves the host-side promise. Throws on unknown id or
      // already-completed entry — those propagate as drone errors.
      al.setHandler(handle, 'respond', ({ args }) => {
        const id = args[0];
        const payload = args[1];
        const entry = state.registry.get(id);
        if (!entry) throw new Error(`unknown correlationId: ${id}`);
        if (entry.completed) throw new Error(`already completed: ${id}`);
        entry.completed = true;
        entry.resolve(payload);
        return null;
      });

      al.setHandler(handle, 'reportError', ({ args }) => {
        state.reportedErrors.push(args[0]);
        return null;
      });

      al.declare('Ingress', handle);

      // Returned to the test via runtime.start() chain — but the
      // test reaches `state` directly, so just expose teardown.
      return {
        onDroneTerminated: () => {
          // Reject all in-flight entries so external awaiters
          // don't hang.
          for (const [, entry] of state.registry) {
            if (!entry.completed) {
              entry.completed = true;
              entry.reject(new Error('ingress: teardown'));
            }
          }
        },
      };
    },
  };
}

/**
 * Drives an "external request" by stashing a deferred entry
 * and triggering the drone's subscribed closure via
 * runtime.scheduleClosureCall. Returns the host-side promise
 * that the drone is expected to resolve via Ingress.respond.
 */
function fireRequest(state, runtime, correlationId, body) {
  let resolve, reject;
  const promise = new Promise((res, rej) => { resolve = res; reject = rej; });
  state.registry.set(correlationId, { resolve, reject, completed: false });
  runtime.scheduleClosureCall(state.droneCallback, [correlationId, body], {});
  return promise;
}

// =============================================================================
// Round-trip: external await unblocks with the drone's payload
// =============================================================================

Deno.test("external deferral: external awaiter receives the drone's response payload", async () => {
  const state = {
    registry: new Map(),
    droneCallback: null,
    reportedErrors: [],
  };

  const { runtime, session, channels } = new RuntimeBuilder()
    .capability(ingressCapability(state))
    .onInboundMessage(() => {})
    .onHandlerError(() => {})
    .build();
  await runtime.start();

  // Drone subscribes a closure that echoes the body back via respond.
  session.parse(`
    Ingress.subscribe(function(id, body) {
      Ingress.respond(id, "echo:" + body);
    });
  `);
  const r = await runtime.run(0);
  assertEquals(r.status, 'done');
  assert(state.droneCallback, 'drone subscribed a closure');

  const responseA = fireRequest(state, runtime, 'req-A', 'hello');
  const responseB = fireRequest(state, runtime, 'req-B', 'world');

  assertEquals(await responseA, 'echo:hello');
  assertEquals(await responseB, 'echo:world');

  await runtime.terminate();
  channels.close();
});

// =============================================================================
// Single-claim: a second respond() with the same id throws into the drone
// =============================================================================

Deno.test("external deferral: double-respond on same id throws into the drone", async () => {
  const state = {
    registry: new Map(),
    droneCallback: null,
    reportedErrors: [],
  };

  const { runtime, session, channels } = new RuntimeBuilder()
    .capability(ingressCapability(state))
    .onInboundMessage(() => {})
    .onHandlerError(() => {})
    .build();
  await runtime.start();

  // Drone responds once successfully, then attempts a second
  // respond on the same id and catches the resulting throw.
  session.parse(`
    Ingress.subscribe(function(id, body) {
      Ingress.respond(id, "first");
      try { Ingress.respond(id, "second"); }
      catch (e) { Ingress.reportError(e.message); }
    });
  `);
  const r = await runtime.run(0);
  assertEquals(r.status, 'done');

  const response = fireRequest(state, runtime, 'req-1', 'payload');
  assertEquals(await response, 'first');

  await waitFor(() => state.reportedErrors.length === 1,
    { label: 'second respond surfaced as drone error' });
  assert(state.reportedErrors[0].includes('already completed'),
    `expected 'already completed' in ${state.reportedErrors[0]}`);

  await runtime.terminate();
  channels.close();
});

// =============================================================================
// Teardown: in-flight entries reject; external awaiters see rejection
// =============================================================================

Deno.test("external deferral: terminate rejects in-flight entries with a teardown error", async () => {
  const state = {
    registry: new Map(),
    droneCallback: null,
    reportedErrors: [],
  };

  const { runtime, session, channels } = new RuntimeBuilder()
    .capability(ingressCapability(state))
    .onInboundMessage(() => {})
    .onHandlerError(() => {})
    .build();
  await runtime.start();

  // Drone subscribes a closure that *never* responds — so the
  // external awaiter hangs until teardown rejects it.
  session.parse(`
    Ingress.subscribe(function(id, body) {
      // intentionally drop the request — model an unresponsive drone
    });
  `);
  const r = await runtime.run(0);
  assertEquals(r.status, 'done');

  const hangingResponse = fireRequest(state, runtime, 'req-hang', 'payload');

  // Give the dropped closure a tick to settle.
  await tick(10);

  // Terminate — onDroneTerminated must reject the entry.
  await runtime.terminate();

  await assertRejects(
    () => hangingResponse,
    Error,
    'ingress: teardown',
  );

  channels.close();
});

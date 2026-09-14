/**
 * Does a closure fired via scheduleClosureCall (the inbound CALLBACK path —
 * box subscriptions, landing connection.message, every host→drone fire) RESUME
 * across an `await`?
 *
 * The approval-scopes console UI hit this: a landing connection.message handler
 * that did `await runCommand(...)` ran its pre-await span but never continued
 * past the await. This test isolates the mechanism from caps/landing/browser —
 * a registered closure that awaits a suspending host call, then calls back.
 *
 *   register(async (n) => { let x = await Host.tick(n); Host.callback(x) })
 *   fire it from onInboundMessage
 *   expect: Host.callback fires with the resolved value (resume worked)
 */

import { assertEquals } from "https://deno.land/std@0.208.0/assert/mod.ts";
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

// Host cap: register(closure) captures it; tick(n) is a SUSPENDING call
// (resolves n*10 on a later turn); callback(v) records v.
function hostCapability(captured, { synchronousTick = false } = {}) {
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
      al.setHandler(handle, 'tick', ({ args, context }) =>
        context.suspend((resolve) => {
          if (synchronousTick) resolve(args[0] * 10);
          else setTimeout(() => resolve(args[0] * 10), 0);
        }));
      al.setHandler(handle, 'callback', ({ args }) => {
        captured.calls.push(args[0]);
        return null;
      });
      al.declare('Host', handle);
    },
  };
}

Deno.test("fired closure resumes across an await (suspending host call)", async () => {
  const captured = { closures: [], calls: [] };
  let runtimeRef;

  const { runtime, session, host, channels } = new RuntimeBuilder()
    .capability(hostCapability(captured))
    .onInboundMessage((payload) => {
      const n = Number(new TextDecoder().decode(payload));
      runtimeRef.scheduleClosureCall(captured.closures[0], [n], {});
    })
    .onHandlerError(() => {})
    .build();
  runtimeRef = runtime;
  await runtime.start();

  // The closure AWAITS Host.tick before calling back — the resume is the test.
  session.parse(`
    Host.register(async function(n) { let x = await Host.tick(n); Host.callback(x); });
  `);
  await runtime.run(0);

  await host.send(u8('7'));
  await waitFor(() => captured.calls.length === 1, { label: 'fired closure resumed past await' });
  assertEquals(captured.calls[0], 70); // 7 * 10 — proves the awaited value flowed back

  await runtime.terminate();
  channels.close();
});

Deno.test("wake during fired-closure drive is deferred until parked ownership exists", async () => {
  const captured = { closures: [], calls: [] };
  let drivenCalls = 0;
  let resolveFinalIdle;
  const finalIdle = new Promise((resolve) => {
    resolveFinalIdle = resolve;
  });
  const { runtime, session, channels } = new RuntimeBuilder()
    .capability(hostCapability(captured, { synchronousTick: true }))
    .onInboundMessage(() => {})
    .onSchedulerIdle(() => {
      if (drivenCalls === 30) resolveFinalIdle();
    })
    .onHandlerError((error) => {
      throw error;
    })
    .build();
  runtime.onClosureDispatch = (event) => {
    if (event.kind === 'drive') drivenCalls++;
  };
  await runtime.start();

  session.parse(`
    Host.register(async function(n) {
      let value = await Host.tick(n)
      Host.callback(value)
    })
  `);
  await runtime.run(0);

  for (let index = 0; index < 30; index++) {
    runtime.scheduleClosureCall(captured.closures[0], [index], {
      traceCorrelationId: index + 1,
    });
  }
  await finalIdle;

  assertEquals(drivenCalls, 30);
  assertEquals(
    captured.calls,
    Array.from({ length: 30 }, (_, index) => index * 10),
  );

  await runtime.terminate();
  channels.close();
});

// Variant: the EXACT console shape. A first fired closure stashes a Promise's
// resolve in an SS variable and awaits the Promise. A SECOND fired closure (a
// later inbound message — the console's box-message listener) calls that stored
// resolve. So the promise is resolved from ANOTHER fired-closure turn, all in
// SS. The approval-scopes console hung exactly here.
Deno.test("fired closure resumes across await of an SS Promise resolved from another fired-closure turn", async () => {
  const captured = { closures: [], calls: [] };
  let runtimeRef;

  // Two closures: [0] the awaiter (inbound "a"), [1] the resolver (inbound "r").
  const { runtime, session, host, channels } = new RuntimeBuilder()
    .capability(hostCapability(captured))
    .onInboundMessage((payload) => {
      const tag = new TextDecoder().decode(payload);
      if (tag === 'a') runtimeRef.scheduleClosureCall(captured.closures[0], [], {});
      if (tag === 'r') runtimeRef.scheduleClosureCall(captured.closures[1], [], {});
    })
    .onHandlerError(() => {})
    .build();
  runtimeRef = runtime;
  await runtime.start();

  // pendingResolve is an SS module-level var. The awaiter stashes its Promise's
  // resolve there and awaits; the resolver (a later fired closure) calls it.
  session.parse(`
    let pendingResolve = null;
    Host.register(async function() {
      let x = await new Promise(function(resolve) { pendingResolve = resolve });
      Host.callback(x);
    });
    Host.register(function() { pendingResolve(50) });
  `);
  await runtime.run(0);

  await host.send(u8('a'));               // fire the awaiter → parks at await
  await tick(20);
  await host.send(u8('r'));               // fire the resolver → calls pendingResolve(50)
  await waitFor(() => captured.calls.length === 1, { label: 'awaiter resumed after cross-turn resolve', timeout: 3000 });
  assertEquals(captured.calls[0], 50);

  await runtime.terminate();
  channels.close();
});

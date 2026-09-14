/**
 * Swarm integration tests — multi-capability composition.
 *
 * Capabilities can depend on each other via `needs:`. The
 * Runtime resolves dependencies, topo-orders setup, and
 * passes each capability a `resolvedContext` map keyed by the
 * `needs` keys. A capability exposes its export to dependents
 * either as the whole setup return, or as `result.exports`
 * if present (so hooks like `onGrantRequest` aren't accidentally
 * exported as part of the API surface).
 *
 * This file pins the composition contract used by capability stacks:
 *
 *   - capability-on-capability dependency: capA exports a
 *     value, capB reads it via resolvedContext, runs its setup
 *     after capA
 *   - host-service and subsystem needs land in resolvedContext
 *     under the declared key
 *   - aliased needs: `needs: { local: { kind: 'capability',
 *     name: 'real' } }` exposes the dep under `local`
 *   - `result.exports` shapes the export; sibling hook fields
 *     don't leak into the dependent's resolved view
 *   - lifecycle hooks (`onDroneTerminated`) fire across a
 *     three-cap chain in the order capabilities were declared
 *   - grant fanout composes across caps: an endorser added by
 *     a downstream cap participates in the same fanout as
 *     upstream caps; multi-endorsement still flips to denial
 *
 * Run with:
 *   deno task test tests/runtime/swarm/capability_composition_test.js
 */

import { assertEquals, assert } from "https://deno.land/std@0.208.0/assert/mod.ts";
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

// Under Runtime, every grant request passes through runGrantFanout, which
// returns a Promise even for zero or fully synchronous endorsers. Thus
// runtime.run(0) suspends immediately after the first
// grant statement instead of running the whole script to 'done' in one
// drive episode. Slot 0 is a root slot, so its wake-up after suspension
// re-drives fire-and-forget via _continueRoot — runtime.run(0)'s own
// returned promise never resolves again for that continuation. Poll
// engine state instead of awaiting a second drive.
async function runRootToCompletion(runtime, slot = 0) {
  await runtime.run(slot);
  await waitFor(() => runtime.getEngineState(slot).status === 'done',
    { label: `slot ${slot} to reach 'done'` });
  return runtime.getEngineState(slot);
}

// =============================================================================
// Capability-on-capability: setup order + exports flow
// =============================================================================

Deno.test("capability composition: dependent reads predecessor's export and runs after it", async () => {
  const setupOrder = [];

  const capA = {
    name: 'A',
    setup: () => {
      setupOrder.push('A');
      return { exports: { greeting: 'hello-from-A' } };
    },
  };

  const capB = {
    name: 'B',
    needs: { upstream: { kind: 'capability', name: 'A' } },
    setup: (_al, ctx) => {
      setupOrder.push('B');
      assertEquals(ctx.upstream.greeting, 'hello-from-A',
        "B's resolvedContext.upstream is A's exports");
      return { exports: { combined: ctx.upstream.greeting + '-then-B' } };
    },
  };

  const capC = {
    name: 'C',
    needs: { mid: { kind: 'capability', name: 'B' } },
    setup: (_al, ctx) => {
      setupOrder.push('C');
      assertEquals(ctx.mid.combined, 'hello-from-A-then-B',
        "C sees the chain through B");
    },
  };

  // Declare in non-topological order to prove the runtime sorts.
  const { runtime, channels } = new RuntimeBuilder()
    .capabilities([capC, capB, capA])
    .onInboundMessage(() => {})
    .build();
  await runtime.start();

  assertEquals(setupOrder, ['A', 'B', 'C']);

  await runtime.terminate();
  channels.close();
});

// =============================================================================
// host-service and subsystem needs land under their key in resolvedContext
// =============================================================================

Deno.test("capability composition: host-service and subsystem deps resolve into context", async () => {
  let seenClock = null;
  let seenLogger = null;

  const cap = {
    name: 'consumer',
    needs: {
      clock:  'host-service',
      logger: { kind: 'subsystem', name: 'log' },
    },
    setup: (_al, ctx) => {
      seenClock = ctx.clock;
      seenLogger = ctx.logger;
    },
  };

  const clock = () => 12345;
  const logger = { write: () => {} };

  const { runtime, channels } = new RuntimeBuilder()
    .capability(cap)
    .hostService('clock', clock)
    .subsystem('log', logger)
    .onInboundMessage(() => {})
    .build();
  await runtime.start();

  assertEquals(seenClock, clock);
  assertEquals(seenLogger, logger);

  await runtime.terminate();
  channels.close();
});

// =============================================================================
// `result.exports` isolates hooks from dependents' view
// =============================================================================

Deno.test("capability composition: result.exports shapes the dep view; hook fields don't leak", async () => {
  const capA = {
    name: 'A',
    setup: () => ({
      // Hook field — the runtime should pick this up internally,
      // but it must NOT show up in dependents' resolvedContext.
      onDroneTerminated: () => {},
      // Public surface for dependents.
      exports: { value: 7 },
    }),
  };

  let seen = null;
  const capB = {
    name: 'B',
    needs: { up: { kind: 'capability', name: 'A' } },
    setup: (_al, ctx) => { seen = ctx.up; },
  };

  const { runtime, channels } = new RuntimeBuilder()
    .capabilities([capA, capB])
    .onInboundMessage(() => {})
    .build();
  await runtime.start();

  assertEquals(seen, { value: 7 });
  assert(!('onDroneTerminated' in seen),
    'hook field must not leak into dependent context');

  await runtime.terminate();
  channels.close();
});

// =============================================================================
// onDroneTerminated fires for every cap that registered the hook
// =============================================================================

Deno.test("capability composition: onDroneTerminated fires across the chain", async () => {
  const fired = [];

  const mk = (name, deps = {}) => ({
    name,
    needs: deps,
    setup: () => ({ onDroneTerminated: () => { fired.push(name); } }),
  });

  const capA = mk('A');
  const capB = mk('B', { a: { kind: 'capability', name: 'A' } });
  const capC = mk('C', { b: { kind: 'capability', name: 'B' } });

  const { runtime, channels } = new RuntimeBuilder()
    .capabilities([capA, capB, capC])
    .onInboundMessage(() => {})
    .build();
  await runtime.start();
  await runtime.terminate();

  // All three fired. Order is the runtime's choice (currently
  // setup order); pin "every hook ran" rather than the order
  // unless we want to lock that down.
  assertEquals(new Set(fired), new Set(['A', 'B', 'C']));
  channels.close();
});

// =============================================================================
// Composed grant fanout: two caps endorse the same identifier → denial
// =============================================================================

Deno.test("capability composition: two caps endorsing the same identifier → denial + MultipleEndorsementsError", async () => {
  const events = [];
  const handlerErrors = [];

  // Shared "log" surface so the drone can report which arm ran.
  const logCap = {
    name: 'log',
    setup: (al) => {
      const root = al.createRootGrant();
      const handle = al.register({});
      root.add(handle);
      al.setHandler(handle, 'mark', ({ args }) => { events.push(args[0]); return null; });
      al.declare('Log', handle);
    },
  };

  const mkEndorser = (name) => ({
    name,
    setup: (al) => ({
      onGrantRequest: (id) => {
        if (id !== 'shared') return null;
        return al.membrane.createGrant(id);
      },
    }),
  });

  const { runtime, session, channels } = new RuntimeBuilder()
    .capabilities([logCap, mkEndorser('endorser-A'), mkEndorser('endorser-B')])
    .onInboundMessage(() => {})
    .onHandlerError((e) => handlerErrors.push(e))
    .build();
  await runtime.start();

  session.parse(`
    grant "shared" { Log.mark("approved"); } denied { Log.mark("denied"); }
  `);
  const r = await runRootToCompletion(runtime);
  assertEquals(r.status, 'done');

  // Two endorsements collide: single-claim policy → denial.
  assertEquals(events, ['denied'],
    `expected denial on multi-endorsement; got ${JSON.stringify(events)}`);
  assert(handlerErrors.some(e => e?.name === 'MultipleEndorsementsError'),
    `expected MultipleEndorsementsError; got ${handlerErrors.map(e => e?.name).join(', ')}`);

  await runtime.terminate();
  channels.close();
});

// =============================================================================
// Composed endorsement: downstream cap's endorser participates with
// upstream caps in the same fanout. Single endorsement still wins.
// =============================================================================

Deno.test("capability composition: downstream cap's endorser composes into the same fanout", async () => {
  const events = [];

  // capA exposes a Handle that capB will endorse for grant "x".
  // This proves the endorser added by a dependent cap can
  // authorize a handle owned by an upstream cap.
  let aHandle;
  const capA = {
    name: 'A',
    setup: (al) => {
      aHandle = al.register({});
      al.setHandler(aHandle, 'touch', () => { events.push('A.touch'); return null; });
      al.declare('A', aHandle);
      return { exports: { handle: aHandle } };
    },
  };

  const capB = {
    name: 'B',
    needs: { up: { kind: 'capability', name: 'A' } },
    setup: (al, ctx) => ({
      onGrantRequest: (id) => {
        if (id !== 'x') return null;
        const grant = al.membrane.createGrant(id);
        grant.add(ctx.up.handle);
        return grant;
      },
    }),
  };

  const logCap = {
    name: 'log',
    setup: (al) => {
      const root = al.createRootGrant();
      const handle = al.register({});
      root.add(handle);
      al.setHandler(handle, 'mark', ({ args }) => { events.push(args[0]); return null; });
      al.declare('Log', handle);
    },
  };

  const { runtime, session, channels } = new RuntimeBuilder()
    .capabilities([capA, capB, logCap])
    .onInboundMessage(() => {})
    .onHandlerError(() => {})
    .build();
  await runtime.start();

  session.parse(`
    grant "x" { A.touch(); Log.mark("approved"); } denied { Log.mark("denied"); }
  `);
  const r = await runRootToCompletion(runtime);
  assertEquals(r.status, 'done');

  assertEquals(events, ['A.touch', 'approved'],
    `expected approval and A.touch; got ${JSON.stringify(events)}`);

  await runtime.terminate();
  channels.close();
});

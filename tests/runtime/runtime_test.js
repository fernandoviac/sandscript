/**
 * Comprehensive Runtime tests.
 *
 * Covers: start/terminate happy path, capability dependency
 * resolution, grant fanout policy, scheduler dispatch on real
 * sandscript drone code, parked-slot resumption,
 * AttributedRejection surfacing via onHandlerError, quiesce/
 * resume semantics, snapshot/resume round-trip, lifecycle
 * methods, stats surface, and the channel main loop.
 *
 * Run with: deno task test tests/runtime/runtime_test.js
 */

import { assertEquals, assert, assertExists, assertRejects, assertThrows } from "https://deno.land/std@0.208.0/assert/mod.ts";
import { RuntimeBuilder, createPairedChannels } from '../../src/runtime/test-harness.js';
import { collectMessages } from './host-helpers.js';
import {
  Runtime, RUNTIME_STATE, driveLoop, runBackgroundDrive, runGrantFanout,
} from '../../src/runtime/index.js';
import { freshSession, restoreSession, snapshotSession } from '../../src/host-owned-session.js';
import { CONTEXT_STATUS_FREE } from '../../src/fuel/constants.js';
import { AttributedRejection } from '../../src/fuel/attributed-rejection.js';
import {
  MissingDependencyError,
  CapabilityCycleError,
  RuntimeBootError,
} from '../../src/runtime/errors.js';
import { createSession } from '../../src/fuel/session.js';

// =============================================================================
// Helpers
// =============================================================================

const u8 = (s) => new TextEncoder().encode(s);
const utf = (b) => new TextDecoder().decode(b);

/**
 * Wait one macrotask so microtask-driven scheduler work
 * (parked-slot resumption, spawned context drives) has a
 * chance to land.
 */
function tick(ms = 0) {
  return new Promise(r => setTimeout(r, ms));
}

/**
 * Drive the runtime until a condition is true or a timeout
 * elapses. Returns once the condition is true or throws.
 */
async function waitFor(condition, { timeout = 2000, label = 'condition' } = {}) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    if (condition()) return;
    await tick(2);
  }
  throw new Error(`waitFor timed out: ${label}`);
}

// =============================================================================
// Construction + validation
// =============================================================================

Deno.test("Runtime: rejects missing required options", () => {
  assertThrows(() => new Runtime({}), RuntimeBootError, "missing required option");
});

Deno.test("Runtime: rejects bad inbound channel shape", () => {
  const session = freshSession();
  assertThrows(() => new Runtime({
    session,
    inboundChannel: { onMessage: 'not-a-function' },
    outboundChannel: { send: () => {}, trySend: () => true },
    capabilities: [],
    hostServices: {},
    subsystems: {},
  }), RuntimeBootError, 'inboundChannel.onMessage');
});

Deno.test("Runtime: start() rejects without onInboundMessage", async () => {
  const { runtime, channels } = new RuntimeBuilder().build();
  await assertRejects(() => runtime.start(), RuntimeBootError, 'onInboundMessage');
  channels.close();
});

Deno.test("Runtime: start() rejects when called twice", async () => {
  const { runtime, channels } = new RuntimeBuilder()
    .onInboundMessage(() => {})
    .build();
  await runtime.start();
  await assertRejects(() => runtime.start(), RuntimeBootError, 'start');
  await runtime.terminate();
  channels.close();
});

// =============================================================================
// Capability lifecycle
// =============================================================================

Deno.test("Runtime: capabilities set up in dependency-topological order", async () => {
  const order = [];
  const { runtime, channels } = new RuntimeBuilder()
    .capability({
      name: 'depA',
      setup: () => { order.push('depA'); return { exports: 'A-result' }; },
    })
    .capability({
      name: 'depB',
      needs: { depA: 'capability' },
      setup: (airlock, ctx) => {
        order.push('depB');
        assertEquals(ctx.depA, 'A-result');
        return { exports: 'B-result' };
      },
    })
    .capability({
      name: 'leaf',
      needs: { depA: 'capability', depB: 'capability' },
      setup: (airlock, ctx) => {
        order.push('leaf');
        assertEquals(ctx.depA, 'A-result');
        assertEquals(ctx.depB, 'B-result');
      },
    })
    .onInboundMessage(() => {})
    .build();
  await runtime.start();
  assertEquals(order, ['depA', 'depB', 'leaf']);
  await runtime.terminate();
  channels.close();
});

Deno.test("Runtime: missing capability dep raises RuntimeBootError(validate)", async () => {
  const { runtime, channels } = new RuntimeBuilder()
    .capability({
      name: 'x',
      needs: { y: 'capability' },
      setup: () => {},
    })
    .onInboundMessage(() => {})
    .build();
  const err = await assertRejects(() => runtime.start(), RuntimeBootError);
  assertEquals(err.phase, 'validate');
  channels.close();
});

Deno.test("Runtime: capability cycle raises RuntimeBootError(order)", async () => {
  const { runtime, channels } = new RuntimeBuilder()
    .capability({ name: 'a', needs: { b: 'capability' }, setup: () => {} })
    .capability({ name: 'b', needs: { a: 'capability' }, setup: () => {} })
    .onInboundMessage(() => {})
    .build();
  const err = await assertRejects(() => runtime.start(), RuntimeBootError);
  assertEquals(err.phase, 'order');
  channels.close();
});

Deno.test("Runtime: capability setup throw raises RuntimeBootError(setup)", async () => {
  const { runtime, channels } = new RuntimeBuilder()
    .capability({ name: 'broken', setup: () => { throw new Error('nope'); } })
    .onInboundMessage(() => {})
    .build();
  const err = await assertRejects(() => runtime.start(), RuntimeBootError);
  assertEquals(err.phase, 'setup');
  channels.close();
});

Deno.test("Runtime: onDroneTerminated fires in reverse setup order", async () => {
  const order = [];
  const { runtime, channels } = new RuntimeBuilder()
    .capability({
      name: 'a',
      setup: () => ({ onDroneTerminated: () => { order.push('a'); } }),
    })
    .capability({
      name: 'b',
      needs: { a: 'capability' },
      setup: () => ({ onDroneTerminated: () => { order.push('b'); } }),
    })
    .onInboundMessage(() => {})
    .build();
  await runtime.start();
  await runtime.terminate();
  assertEquals(order, ['b', 'a']); // reverse of setup order
  channels.close();
});

// =============================================================================
// Channel main loop
// =============================================================================

Deno.test("Runtime: onInboundMessage fires for each delivered message", async () => {
  const received = [];
  const { runtime, host, channels } = new RuntimeBuilder()
    .onInboundMessage((payload, seq) => {
      received.push({ payload: utf(payload), seq });
    })
    .build();
  await runtime.start();
  await host.send(u8('one'));
  await host.send(u8('two'));
  await host.send(u8('three'));
  await waitFor(() => received.length === 3, { label: '3 messages received' });
  assertEquals(received.map(r => r.payload), ['one', 'two', 'three']);
  assertEquals(received.map(r => r.seq), [1n, 2n, 3n]);
  await runtime.terminate();
  channels.close();
});

// =============================================================================
// Slot driver — running real sandscript drone code
// =============================================================================

Deno.test("Runtime: drone closure is captured by JS as a ClosureHandle wrapper", async () => {
  // First half of the closure-call story: when drone code
  // passes a function to a registered handler, the handler
  // receives a ClosureHandle wrapper carrying a numeric slot.
  // This validates the capture path before exercising the
  // dispatch path in the next test.
  //
  // Root-grant authorization keeps this test focused on
  // closure-handle plumbing; grant fanout has its own tests.
  let observed = null;
  const { runtime, session, channels } = new RuntimeBuilder()
    .capability({
      name: 'host',
      setup: (al) => {
        const rootGrant = al.createRootGrant();
        const handle = al.register({});
        rootGrant.add(handle);
        al.setHandler(handle, 'capture', ({ args }) => {
          observed = args[0];
          return null;
        });
        al.declare('Host', handle);
      },
    })
    .onInboundMessage(() => {})
    .build();
  await runtime.start();

  session.parse(`
    function fire(n) { Host.capture(n); }
    Host.capture(fire);
  `);
  const result = await runtime.run(0);
  assertEquals(result.status, 'done');
  assertExists(observed);
  assertEquals(typeof observed.slot, 'number');
  assertEquals(typeof observed.version, 'number');

  await runtime.terminate();
  channels.close();
});

Deno.test("Runtime: scheduleClosureCall fires registered closure with args", async () => {
  let capturedClosure = null;
  let receivedFromClosure = null;
  const { runtime, session, channels } = new RuntimeBuilder()
    .capability({
      name: 'host',
      setup: (al) => {
        const rootGrant = al.createRootGrant();
        const handle = al.register({});
        rootGrant.add(handle);
        al.setHandler(handle, 'register', ({ args }) => {
          capturedClosure = args[0];
          return null;
        });
        al.setHandler(handle, 'callback', ({ args }) => {
          receivedFromClosure = args[0];
          return null;
        });
        al.declare('Host', handle);
      },
    })
    .onInboundMessage(() => {})
    .build();
  await runtime.start();

  session.parse(`
    Host.register(function(n) { Host.callback(n); });
  `);
  const r1 = await runtime.run(0);
  assertEquals(r1.status, 'done');
  assertExists(capturedClosure);

  // Now schedule it. The drainer allocates a slot, calls
  // the closure with arg 7, drives to terminal.
  runtime.scheduleClosureCall(capturedClosure, [7], {});
  await waitFor(() => receivedFromClosure === 7, { label: 'closure fired' });

  await runtime.terminate();
  channels.close();
});

// =============================================================================
// AttributedRejection surfacing
// =============================================================================

Deno.test("Runtime: handler sync-throw inside grant block surfaces AttributedRejection via onHandlerError", async () => {
  // Capability-endorsement path: the drone wraps the call
  // in a grant block, the runtime's grant fanout dispatches
  // to this capability's endorser, the endorser issues a
  // grant covering the Bad handle, the call lands inside the
  // grant, the handler throws, AttributedRejection surfaces.
  // Exercises grant fanout + diagnostic capture together —
  // the runtime layer's headline path.
  let badHandle;
  const errors = [];
  const { runtime, session, channels } = new RuntimeBuilder()
    .capability({
      name: 'badness-host',
      setup: (al) => {
        badHandle = al.register({});
        al.setHandler(badHandle, 'throws', () => {
          throw new TypeError('handler boom');
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
    })
    .onInboundMessage(() => {})
    .onHandlerError((err) => { errors.push(err); })
    .build();
  await runtime.start();

  session.parse(`
    try { grant "badness" { Bad.throws(); } }
    catch (_e) { /* drone swallows so this slot terminates cleanly */ }
  `);
  await runtime.run(0);

  await waitFor(() => errors.length >= 1, { label: 'attribution surfaced' });
  const attr = errors[0];
  assertEquals(attr.slot, 0);
  assertEquals(attr.cause.message, 'handler boom');
  // The attributed rejection includes a captured slot diagnostic.
  assertExists(attr.diagnostic);
  assertEquals(attr.diagnostic.slot, 0);

  await runtime.terminate();
  channels.close();
});

// =============================================================================
// Grant fanout
// =============================================================================

Deno.test("Runtime: grant fanout — zero endorsements → denied", async () => {
  // Grant denial is control flow, not an exception: with no
  // endorser registered, the body is skipped and the optional
  // `denied` arm runs. Use Host as a root-granted surface so
  // the drone can report which arm fired.
  const events = [];
  const { runtime, session, channels } = new RuntimeBuilder()
    .capability({
      name: 'host',
      setup: (al) => {
        const root = al.createRootGrant();
        const handle = al.register({});
        root.add(handle);
        al.setHandler(handle, 'mark', ({ args }) => { events.push(args[0]); return null; });
        al.declare('Host', handle);
      },
    })
    .onInboundMessage(() => {})
    .onHandlerError(() => {})
    .build();
  await runtime.start();

  session.parse(`
    grant "fs" { Host.mark("approved"); } denied { Host.mark("denied"); }
  `);
  const r = await runtime.run(0);
  assertEquals(r.status, 'done');
  assertEquals(events, ['denied'],
    `expected only the denied arm to run; got ${JSON.stringify(events)}`);

  await runtime.terminate();
  channels.close();
});

Deno.test("Runtime: grant fanout — single endorsement → approved", async () => {
  let approvalSeen = false;
  const { runtime, session, channels } = new RuntimeBuilder()
    .capability({
      name: 'host',
      setup: (al) => {
        const handle = al.register({});
        al.setHandler(handle, 'inside', () => { approvalSeen = true; return null; });
        al.declare('Host', handle);
        return {
          onGrantRequest: (id) => {
            if (id !== 'fs') return null;
            const grant = al.membrane.createGrant(id);
            // The endorsement covers Host so the drone can
            // call Host.inside() while inside the grant block.
            grant.add(handle);
            return grant;
          },
        };
      },
    })
    .onInboundMessage(() => {})
    .onHandlerError(() => {})
    .build();
  await runtime.start();

  session.parse(`grant "fs" { Host.inside(); }`);
  // The async fanout wrapper returns a Promise even for this synchronous
  // endorser, so runtime.run(0) suspends immediately after GRANT_START rather
  // than running the block body within the same drive episode.
  await runtime.run(0);
  await waitFor(() => approvalSeen, { label: 'grant body to run' });
  assert(approvalSeen, 'handler inside grant block must have run');

  await runtime.terminate();
  channels.close();
});

Deno.test("Runtime: grant fanout — multiple endorsements → denied + error fires", async () => {
  const errors = [];
  const { runtime, session, channels } = new RuntimeBuilder()
    .capability({
      name: 'capA',
      setup: (al) => ({
        onGrantRequest: (id) => al.membrane.createGrant(id + '-A'),
      }),
    })
    .capability({
      name: 'capB',
      setup: (al) => ({
        onGrantRequest: (id) => al.membrane.createGrant(id + '-B'),
      }),
    })
    .capability({
      name: 'host',
      setup: (al) => {
        const handle = al.register({});
        al.setHandler(handle, 'inside', () => null);
        al.declare('Host', handle);
      },
    })
    .onInboundMessage(() => {})
    .onHandlerError((err) => { errors.push(err); })
    .build();
  await runtime.start();

  session.parse(`
    try { grant "fs" { Host.inside(); } }
    catch (_e) {}
  `);
  await runtime.run(0);
  await waitFor(() => errors.length >= 1, { label: 'multi-endorser error' });
  const e = errors[0];
  assertEquals(e.name, 'MultipleEndorsementsError');
  assertEquals(e.identifier, 'fs');
  assertEquals(e.endorsers.sort(), ['capA', 'capB']);

  await runtime.terminate();
  channels.close();
});

// =============================================================================
// Lifecycle: quiesce / resume / snapshot
// =============================================================================

Deno.test("Runtime: quiesce after start resolves on idle scheduler", async () => {
  const { runtime, channels } = new RuntimeBuilder()
    .onInboundMessage(() => {})
    .build();
  await runtime.start();
  await runtime.quiesce();
  const stats = runtime.getSchedulerStats();
  assertEquals(stats.state, RUNTIME_STATE.QUIESCED);
  runtime.resume();
  const after = runtime.getSchedulerStats();
  assertEquals(after.state, RUNTIME_STATE.SCHEDULER_IDLE);
  await runtime.terminate();
  channels.close();
});

Deno.test("Host-orchestrated snapshot via harness.snapshot()", async () => {
  // Under host-owned memory, the runtime exposes no snapshot
  // method. Sandscript exposes lifecycle primitives (quiesce /
  // resume) and the host orchestrates byte slicing itself. The
  // test harness's snapshot() is the convenience wrapper for
  // tests; production hosts slice their own buffers.
  const { runtime, session, channels, snapshot } = new RuntimeBuilder()
    .onInboundMessage(() => {})
    .build();
  await runtime.start();
  session.parse(`let x = 1 + 2;`);
  await runtime.run(0);
  await runtime.quiesce();
  const snap = snapshot();
  assertExists(snap.vatBytes);
  assertExists(snap.membraneBytes);
  runtime.resume();
  await runtime.terminate();
  channels.close();
});

// =============================================================================
// End-to-end: boot, run, snapshot, resume, run again, terminate
// =============================================================================

Deno.test("Runtime: full lifecycle round-trip (boot → run → snapshot → restore → run → terminate)", async () => {
  // --- Phase 1: fresh boot ---
  const phase1Errors = [];
  const phase1Resumes = [];
  const builder1 = new RuntimeBuilder()
    .capability({
      name: 'counter',
      setup: (al, _ctx, opts) => {
        const rootGrant = al.createRootGrant();
        const handle = al.register({ count: 0 });
        rootGrant.add(handle);
        al.setHandler(handle, 'inc', ({ context }) => {
          const obj = al.lookup(handle);
          obj.count += 1;
          return obj.count;
        });
        al.setHandler(handle, 'value', () => al.lookup(handle).count);
        al.declare('Counter', handle);
        return {
          onResume: () => { phase1Resumes.push('counter'); },
        };
      },
    })
    .onInboundMessage(() => {})
    .onHandlerError((err) => { phase1Errors.push(err); });

  const { runtime: rt1, session: s1, channels: c1, snapshot: snap1 } = builder1.build();
  await rt1.start();
  // Boot should NOT have fired onResume (fresh boot, not resume).
  assertEquals(phase1Resumes, []);

  s1.parse(`Counter.inc(); Counter.inc(); Counter.inc();`);
  const r1 = await rt1.run(0);
  assertEquals(r1.status, 'done');
  assertEquals(s1.get(0, 'undefined'), undefined);
  // Counter via getter
  s1.parse(`let v = Counter.value();`);
  await rt1.run(0);
  assertEquals(s1.get(0, 'v'), 3);
  assertEquals(phase1Errors, []);

  // Snapshot.
  await rt1.quiesce();
  const snap = snap1();
  rt1.resume();
  await rt1.terminate();
  c1.close();

  // --- Phase 2: resume ---
  const phase2Resumes = [];
  const builder2 = new RuntimeBuilder()
    .fromSnapshot({ vatBytes: snap.vatBytes, membraneBytes: snap.membraneBytes })
    .capability({
      name: 'counter',
      setup: (al, _ctx, opts) => {
        // On resume, what survives:
        //   - the Counter handle's membrane slot
        //   - the declared name "Counter" (drone-scope binding)
        //   - the root-grant membership (so Counter is still
        //     callable from drone code without grant fanout)
        // What does NOT survive: the JS-side `impl` object
        // (al.lookup returns nothing useful), the registered
        // handler functions, the count.
        //
        // The capability's job on resume is to rebind handlers to fresh
        // JavaScript-side state. It may instead throw SnapshotOrphanedError;
        // here it mints a fresh implementation and starts the count over.
        const entries = al.membrane.enumerateHandles();
        const counterEntry = entries.find(e => e.declarationName === 'Counter');
        assertExists(counterEntry, 'Counter handle should survive snapshot');
        const handle = counterEntry.handle;
        const freshImpl = { count: 0 };
        al.setHandler(handle, 'inc', () => {
          freshImpl.count += 1;
          return freshImpl.count;
        });
        al.setHandler(handle, 'value', () => freshImpl.count);
        return {
          onResume: () => { phase2Resumes.push('counter'); },
        };
      },
    })
    .onInboundMessage(() => {});
  const { runtime: rt2, session: s2, channels: c2 } = builder2.build();
  await rt2.start();
  // Resume mode detected by session.tick() > 0n (set by phase 1's run).
  assertEquals(phase2Resumes, ['counter']);

  // Drone resumes against the restored membrane. The Counter
  // binding is still in scope; calling its methods works.
  // Counts restart at 0 because JS-side state didn't survive,
  // which is the documented contract.
  //
  // Snapshot/resume preserves the engine's instruction index.
  // When the embedder wants to append fresh drone code after
  // resume (as opposed to resuming a parked slot mid-execution),
  // it must advance the instruction index past the restored
  // body before running, otherwise the slot replays the last
  // instruction of the pre-snapshot program. session.parse
  // returns the new instructions' start index for exactly this
  // purpose.
  const parseResult = s2.parse(`
    let v0 = Counter.value();
    Counter.inc();
    Counter.inc();
    let v2 = Counter.value();
  `);
  s2.setInstruction(0, parseResult.startIndex);
  const r2 = await rt2.run(0);
  assertEquals(r2.status, 'done',
    'drone should run cleanly against restored handle');
  assertEquals(s2.get(0, 'v0'), 0,
    'JS state does not survive snapshot; count restarts');
  assertEquals(s2.get(0, 'v2'), 2);

  await rt2.terminate();
  c2.close();
});

// =============================================================================
// Stats surface
// =============================================================================

Deno.test("Runtime: stats surface exposes the documented methods", async () => {
  const { runtime, channels } = new RuntimeBuilder()
    .onInboundMessage(() => {})
    .build();
  await runtime.start();

  const schedStats = runtime.getSchedulerStats();
  assert('inFlight' in schedStats);
  assert('parked' in schedStats);
  assert('state' in schedStats);

  const engState = runtime.getEngineState(0);
  assertExists(engState);
  assertEquals(engState.context, 0);

  const memStats = runtime.getMembraneStats();
  assertExists(memStats);
  assert('totalBytes' in memStats);

  const tick = runtime.getOperationTick();
  assert(typeof tick === 'bigint');

  const slotDiag = runtime.captureSlotDiagnostic(0);
  assertExists(slotDiag);
  assertEquals(slotDiag.slot, 0);

  const memDiag = runtime.captureMembraneDiagnostic();
  assertExists(memDiag);
  assertExists(memDiag.stats);

  await runtime.terminate();
  channels.close();
});

// =============================================================================
// runtime.runtimeState (cross-realm-observable scheduler state)
//
// Successor to the retired onParkedStateChange JS callback.
// =============================================================================

Deno.test("Runtime: channel loop publishes INBOUND_LOOP to the runtime-state cell", async () => {
  // The channel-loop's _enterParked() writes INBOUND_LOOP to the
  // runtime-state cell. After start() + a few microtask ticks, the
  // cell must hold INBOUND_LOOP (the steady state of an idle
  // runtime). Also confirms the mirrored stats.state value matches.
  const { runtime, channels } = new RuntimeBuilder()
    .onInboundMessage(() => {})
    .build();
  await runtime.start();
  await tick(5);
  assertEquals(runtime.runtimeState.get(), RUNTIME_STATE.INBOUND_LOOP,
    'channel loop should have published INBOUND_LOOP');
  assertEquals(runtime.getSchedulerStats().state, RUNTIME_STATE.INBOUND_LOOP,
    'stats.state mirrors the cell value');
  await runtime.terminate();
  channels.close();
});

// =============================================================================
// Send / outbound
// =============================================================================

Deno.test("Runtime: send delivers to outbound channel", async () => {
  const { runtime, host, channels } = new RuntimeBuilder()
    .onInboundMessage(() => {})
    .build();
  const sink = collectMessages(host);
  await runtime.start();
  await runtime.send(u8('outbound-test'));
  const got = await sink.nextMessage();
  assertEquals(utf(got.payload), 'outbound-test');
  sink.unsubscribe();
  await runtime.terminate();
  channels.close();
});

Deno.test("Runtime: trySend forwards to outbound.trySend", async () => {
  const { runtime, host, channels } = new RuntimeBuilder()
    .onInboundMessage(() => {})
    .build();
  const sink = collectMessages(host);
  await runtime.start();
  assertEquals(runtime.trySend(u8('quick')), true);
  const got = await sink.nextMessage();
  assertEquals(utf(got.payload), 'quick');
  sink.unsubscribe();
  await runtime.terminate();
  channels.close();
});

// =============================================================================
// Scheduler status regressions
// =============================================================================

// The scheduler must dispatch `async_complete` / `async_rejected`
// — calling airlock.handleAsyncComplete / handleAsyncRejected
// and scheduling the returned waiters. Previously these statuses
// fell to the `default:` arm and were treated as fatal.
Deno.test("Runtime: async function completion dispatches without UnexpectedSchedulerStatus", async () => {
  const handlerErrors = [];
  const { runtime, session, channels } = new RuntimeBuilder()
    .onInboundMessage(() => {})
    .onHandlerError((e) => { handlerErrors.push(e); })
    .build();
  await runtime.start();

  session.parse(`
    async function f() { return 42; }
    let p = f();
  `);
  const rootResult = await runtime.run(0);
  assertEquals(rootResult.status, 'done');

  // Give the spawned async slot a tick to complete.
  await tick(20);

  const unexpected = handlerErrors.find(e =>
    /unexpected status 'async_complete'|unexpected status 'async_rejected'/.test(e?.message ?? ''));
  assertEquals(unexpected, undefined,
    `scheduler must dispatch async_complete/async_rejected; saw: ${unexpected?.message}`);
  assertEquals(handlerErrors.length, 0,
    `no handler errors expected; got: ${handlerErrors.map(e => e.message).join('; ')}`);

  await runtime.terminate();
  channels.close();
});

Deno.test("Runtime: async function throw dispatches via async_rejected without UnexpectedSchedulerStatus", async () => {
  const handlerErrors = [];
  const { runtime, session, channels } = new RuntimeBuilder()
    .onInboundMessage(() => {})
    .onHandlerError((e) => { handlerErrors.push(e); })
    .build();
  await runtime.start();

  // An async function that throws produces async_rejected on
  // its slot. Wrap the await in try/catch so the parent
  // doesn't propagate the rejection up as an SS error.
  session.parse(`
    async function bad() { throw new Error('async oops'); }
    async function main() {
      try { await bad(); } catch (_e) { /* swallow */ }
    }
    let _ = main();
  `);
  const rootResult = await runtime.run(0);
  assertEquals(rootResult.status, 'done');
  await tick(20);

  const unexpected = handlerErrors.find(e =>
    /unexpected status 'async_(complete|rejected)'/.test(e?.message ?? ''));
  assertEquals(unexpected, undefined,
    `scheduler must dispatch async_rejected; saw: ${unexpected?.message}`);

  await runtime.terminate();
  channels.close();
});

// A memory-pressure retry can itself produce a scheduler status.
// When memory_pressure's gc-retry returns async_call /
// promise_method, the scheduler previously dropped the
// spawned-context payload (asyncContext / contexts) and
// continued the outer loop expecting session.run to re-emit —
// which it never did. The fix: feed the retry result back
// through the main switch (or otherwise schedule its spawned
// contexts).
Deno.test("driveLoop: dispatches spawned context returned by memory_pressure retry", async () => {
  // Scripted engine: first run yields memory_pressure, the
  // post-gc retry returns async_call with asyncContext: 42, the
  // continuation returns done. The loop must dispatch slot 42
  // via the dispatchChild callback (regression for the bug where
  // the retry result was discarded).
  const dispatchedChildren = [];
  let scriptIndex = 0;
  const script = [
    { status: 'memory_pressure' },
    { status: 'async_call', asyncContext: 42 },
    { status: 'done', error: null },
  ];
  const session = {
    run() {
      if (scriptIndex >= script.length) return { status: 'done', error: null };
      return script[scriptIndex++];
    },
    gc() { return { compacted: true, freed: 0 }; },
    airlock: { consumeAttributedRejection: () => null },
  };

  const result = await driveLoop(0, {
    session, fuel: 1000,
    isTerminated:  () => false,
    drainSpawned:  () => {},
    dispatchChild: (s) => dispatchedChildren.push(s),
    surfaceError:  () => {},
    publishState:  () => {},
    bumpErrors:    () => {},
  });

  assertEquals(result.status, 'done');
  assert(dispatchedChildren.includes(42),
    `slot 42 (asyncContext from retry) must be dispatched; got ${JSON.stringify(dispatchedChildren)}`);
});

Deno.test("driveLoop: dispatches promise_method contexts returned by memory_pressure retry", async () => {
  const dispatchedChildren = [];
  let scriptIndex = 0;
  const script = [
    { status: 'memory_pressure' },
    { status: 'promise_method', contexts: [7, 8, 9] },
    { status: 'done', error: null },
  ];
  const session = {
    run() {
      if (scriptIndex >= script.length) return { status: 'done', error: null };
      return script[scriptIndex++];
    },
    gc() { return { compacted: true, freed: 0 }; },
    airlock: { consumeAttributedRejection: () => null },
  };

  await driveLoop(0, {
    session, fuel: 1000,
    isTerminated:  () => false,
    drainSpawned:  () => {},
    dispatchChild: (s) => dispatchedChildren.push(s),
    surfaceError:  () => {},
    publishState:  () => {},
    bumpErrors:    () => {},
  });

  for (const s of [7, 8, 9]) {
    assert(dispatchedChildren.includes(s),
      `slot ${s} (promise_method handler from retry) must be dispatched; got ${JSON.stringify(dispatchedChildren)}`);
  }
});

// Regression for audit item #9: SPEC.md:317 says quiesce "stops
// dispatching new work into the scheduler." Previously the
// scheduler accepted new driveRootSlot calls during quiesce,
// which would prevent the quiesce promise from settling and
// race with snapshot/relocation.
Deno.test("Runtime: scheduler refuses driveRootSlot while quiesced", async () => {
  const { runtime, channels } = new RuntimeBuilder()
    .onInboundMessage(() => {})
    .build();
  await runtime.start();
  await runtime.quiesce();

  // Direct invocation of driveRootSlot via the private accessor
  // — this is the surface other internals (closure drainer,
  // spawn hook) would use. It must NOT start a new drive while
  // quiesced.
  const result = await runtime.run(0);
  assertEquals(result.status, 'quiesced',
    `driveRootSlot during quiesce should return status 'quiesced'; got ${result.status}`);

  await runtime.terminate();
  channels.close();
});

// Resume versus boot is supplied by the host through the Runtime constructor's
// `resume` option. The engine exposes no restoration signal for the runtime
// to infer or fail to read.

// Regression for audit item #5: SPEC.md documents
// `runtime.onInboundMessage = fn` as an assignable property,
// matching the shape of onHandlerError.
// Pre-fix this was only settable via setOnInboundMessage(fn).
Deno.test("Runtime: onInboundMessage is assignable as a public property", async () => {
  const received = [];
  const session = freshSession();
  const pair = createPairedChannels();
  const runtime = new Runtime({
    session,
    inboundChannel: pair.a,
    outboundChannel: pair.a,
    capabilities: [],
    hostServices: {},
    subsystems: {},
    // Constructor-time omission is fine; we register below.
  });
  runtime.onInboundMessage = (payload) => { received.push(utf(payload)); };
  await runtime.start();
  await pair.b.send(u8('hi'));
  await waitFor(() => received.length === 1, { label: 'message delivered' });
  await runtime.terminate();
  pair.close();
});

// Regression for audit item #10: scheduler's synthetic-error
// wrapper used to hand-roll the AttributedRejection shape with
// a stub `diagnostic = { slot, status: 'unknown' }`. It should
// instead construct the real AttributedRejection class so the
// shape is consistent with handler-throw paths.
Deno.test("driveLoop: synthetic errors from unexpected status are real AttributedRejection instances", async () => {
  const surfaced = [];
  const session = {
    run() { return { status: 'gibberish' }; },
    gc() { return { compacted: true, freed: 0 }; },
    airlock: { consumeAttributedRejection: () => null },
  };

  await driveLoop(0, {
    session, fuel: 1000,
    isTerminated:  () => false,
    drainSpawned:  () => {},
    dispatchChild: () => {},
    surfaceError:  (rej) => surfaced.push(rej),
    publishState:  () => {},
    bumpErrors:    () => {},
  });

  assertEquals(surfaced.length, 1);
  assert(surfaced[0] instanceof AttributedRejection,
    `synthetic driver error should be a real AttributedRejection; got ${surfaced[0]?.constructor?.name}`);
});

Deno.test("runGrantFanout: zero endorsers → denied (sync)", () => {
  const r = runGrantFanout('x', [], () => {});
  assertEquals(r, { approved: false });
});

Deno.test("runGrantFanout: one endorser returning a bare grant → approved+wrapped", async () => {
  const r = await runGrantFanout('x', [
    { name: 'cap', hook: () => ({ token: 'T' }) },
  ], () => {});
  assertEquals(r, { approved: true, grant: { token: 'T' } });
});

Deno.test("runGrantFanout: one endorser returning {approved,grant} passes through", async () => {
  const r = await runGrantFanout('x', [
    { name: 'cap', hook: () => ({ approved: true, grant: 'G' }) },
  ], () => {});
  assertEquals(r, { approved: true, grant: 'G' });
});

Deno.test("runGrantFanout: null/undefined return = no endorsement → denied", async () => {
  const r = await runGrantFanout('x', [
    { name: 'a', hook: () => null },
    { name: 'b', hook: () => undefined },
  ], () => {});
  assertEquals(r, { approved: false });
});

Deno.test("runGrantFanout: two endorsers → denied + MultipleEndorsementsError surfaced", async () => {
  const errs = [];
  const r = await runGrantFanout('x', [
    { name: 'a', hook: () => 'GA' },
    { name: 'b', hook: () => 'GB' },
  ], (e) => errs.push(e));
  assertEquals(r, { approved: false });
  assertEquals(errs.length, 1);
  assertEquals(errs[0].name, 'MultipleEndorsementsError');
  assertEquals(errs[0].endorsers, ['a', 'b']);
});

Deno.test("runGrantFanout: throwing endorser counts as no endorsement; surfaces wrapped error", async () => {
  const errs = [];
  const r = await runGrantFanout('the-id', [
    { name: 'broken', hook: () => { throw new Error('boom'); } },
    { name: 'good',   hook: () => ({ token: 'T' }) },
  ], (e) => errs.push(e));
  assertEquals(r, { approved: true, grant: { token: 'T' } });
  assertEquals(errs.length, 1);
  assertEquals(errs[0].name, 'EndorserError');
  assertEquals(errs[0].capability, 'broken');
  assertEquals(errs[0].identifier, 'the-id');
  assertEquals(errs[0].cause.message, 'boom');
});

Deno.test("runGrantFanout: rejecting Promise endorser counts as no endorsement", async () => {
  const errs = [];
  const r = await runGrantFanout('x', [
    { name: 'p', hook: () => Promise.reject(new Error('async boom')) },
  ], (e) => errs.push(e));
  assertEquals(r, { approved: false });
  assertEquals(errs.length, 1);
  assertEquals(errs[0].name, 'EndorserError');
});

// Regression: a background-drive completion (slots from
// async_call / promise_method / parked-slot wakes) must free the
// slot via airlock.freeContext — sandscript allocated it but won't
// free it on its own.
Deno.test("runBackgroundDrive: frees slot after drive completes", async () => {
  const events = [];
  await new Promise((resolve) => {
    runBackgroundDrive({ slot: 42, generation: 7 }, {
      driveSlot: (slot) => {
        events.push(['drive', slot]);
        return Promise.resolve({ status: 'done', error: null });
      },
      freeContext: (identity) => {
        events.push(['free', identity]);
        resolve();
      },
      isTerminated: () => false,
    });
  });
  assertEquals(events, [
    ['drive', 42],
    ['free', { slot: 42, generation: 7 }],
  ]);
});

Deno.test("runBackgroundDrive: no-op when terminated", () => {
  const events = [];
  runBackgroundDrive({ slot: 42, generation: 7 }, {
    driveSlot:    () => { events.push('drive'); return Promise.resolve({ status: 'done' }); },
    freeContext:  () => { events.push('free'); },
    isTerminated: () => true,
  });
  assertEquals(events, []);
});

// Regression for audit item #11: if setupCallbackContext throws
// after allocateContext succeeds, the slot must still be freed.
// The throw propagates (we no longer swallow drainer errors); the
// test asserts the propagation AND the cleanup.
Deno.test("runClosureCall: frees slot when setupCallbackContext throws", async () => {
  const events = [];
  const airlock = {
    allocateContext: () => 100,
    memoryImage: {
      getContextGeneration: () => 9,
      isContextIdentityLive: () => true,
    },
    freeContext: (slot, generation) =>
      events.push(['free', slot, generation]),
    getClosurePointer: () => 0xdeadbeef,
    areClosureGrantsActive: () => true,
    setupCallbackContext: () => { events.push(['setup']); throw new Error('setup boom'); },
    dropClosureHandle: () => {},
  };

  const { runClosureCall } = await import('../../src/runtime/index.js');
  await assertRejects(
    () => runClosureCall(
      { closureHandle: { id: 1 }, args: [], opts: {}, ledgerEntry: -1 },
      {
        airlock,
        driveSlot:        () => Promise.resolve({ status: 'done' }),
        backpressure:     null,
        ledger:           { free: () => {} },
        isTerminated:     () => false,
      },
    ),
    Error,
    'setup boom',
  );
  assertEquals(events, [['setup'], ['free', 100, 9]]);
});


// The host-supplied Runtime `resume` option selects resume versus boot; the
// runtime does not infer it from the engine.
Deno.test("Runtime: resume=false means boot — onResume hook does not fire", async () => {
  let onResumeFires = 0;
  const cap = {
    name: 'observer',
    needs: {},
    setup(_al, _ctx, opts) {
      return {
        onResume: () => { onResumeFires += opts.resume ? 1 : 0; },
      };
    },
  };

  const session = freshSession();
  const pair = createPairedChannels();
  const runtime = new Runtime({
    session,
    resume: false,   // boot mode
    inboundChannel: pair.a,
    outboundChannel: pair.a,
    capabilities: [cap],
    hostServices: {},
    subsystems: {},
    onInboundMessage: () => {},
  });
  await runtime.start();
  assertEquals(onResumeFires, 0,
    'boot-mode runtime must not fire onResume');
  await runtime.terminate();
  pair.close();
});

Deno.test("Runtime: resume=true fires onResume hook", async () => {
  let onResumeFires = 0;
  const cap = {
    name: 'observer',
    needs: {},
    setup(_al, _ctx, opts) {
      return {
        onResume: () => { onResumeFires += opts.resume ? 1 : 0; },
      };
    },
  };

  // Build a fresh session, snapshot it, then restoreSession + new
  // Runtime with resume:true. The host is responsible for
  // declaring resume mode; the runtime takes its word for it.
  const session = freshSession();
  const pair = createPairedChannels();
  const runtime = new Runtime({
    session,
    resume: false,
    inboundChannel: pair.a,
    outboundChannel: pair.a,
    capabilities: [],
    hostServices: {},
    subsystems: {},
    onInboundMessage: () => {},
  });
  await runtime.start();
  await runtime.quiesce();
  const snap = snapshotSession(session);
  await runtime.terminate();
  pair.close();

  const session2 = restoreSession(snap.vatBytes, snap.membraneBytes);
  const pair2 = createPairedChannels();
  const runtime2 = new Runtime({
    session: session2,
    resume: true,    // resume mode — onResume fires
    inboundChannel: pair2.a,
    outboundChannel: pair2.a,
    capabilities: [cap],
    hostServices: {},
    subsystems: {},
    onInboundMessage: () => {},
  });
  await runtime2.start();
  assertEquals(onResumeFires, 1,
    'restored-session runtime with resume:true must fire onResume');
  await runtime2.terminate();
  pair2.close();
});

// Architectural cleanup B: OUTBOUND_DRAIN was a dead enum value
// published in RuntimeParkedState but never fired. runtime.send
// now publishes it while awaiting the outbound channel's
// send() Promise.
Deno.test("Runtime: send publishes OUTBOUND_DRAIN around the channel await", async () => {
  // Construct a channel pair where outbound.send blocks until
  // we explicitly release it. Observe the runtime-state cell
  // mid-send and post-send.
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
  // Start the send (it blocks on slowOutbound's pending Promise).
  const sendPromise = runtime.send(u8('blocked'));
  await tick(20);
  // While the send is blocked, the cell holds OUTBOUND_DRAIN.
  assertEquals(runtime.runtimeState.get(), RUNTIME_STATE.OUTBOUND_DRAIN,
    'runtime-state cell should hold OUTBOUND_DRAIN while send is blocked');
  // Release the send and let it finish.
  releaseSend();
  await sendPromise;
  await tick(5);
  // After send completes, send()'s finally writes RUNNING.
  assertEquals(runtime.runtimeState.get(), RUNTIME_STATE.RUNNING,
    'cell should return to RUNNING after send completes');
  await runtime.terminate();
  pair.close();
});

// Architectural cleanup C: extraSchedulerBackpressure was
// constructor-only. Now it's an assignable property like the
// other hooks. Late assignment must take effect on the next
// scheduleClosureCall dispatch.
Deno.test("Runtime: extraSchedulerBackpressure can be assigned post-construction", async () => {
  let backpressureCalls = 0;
  let capturedClosure = null;
  let received = null;
  const { runtime, session, channels } = new RuntimeBuilder()
    .capability({
      name: 'host',
      setup: (al) => {
        const root = al.createRootGrant();
        const h = al.register({});
        root.add(h);
        al.setHandler(h, 'register', ({ args }) => {
          capturedClosure = args[0];
          return null;
        });
        al.setHandler(h, 'cb', ({ args }) => {
          received = args[0];
          return null;
        });
        al.declare('Host', h);
      },
    })
    .onInboundMessage(() => {})
    .build();
  await runtime.start();

  session.parse(`Host.register(function(n) { Host.cb(n); });`);
  await runtime.run(0);
  assertExists(capturedClosure);

  // Late assignment: the drainer should observe it.
  runtime.extraSchedulerBackpressure = async () => { backpressureCalls++; };
  runtime.scheduleClosureCall(capturedClosure, [42], {});
  await waitFor(() => received === 42, { label: 'closure fired' });
  assertEquals(backpressureCalls, 1,
    'late-assigned extraSchedulerBackpressure must be called before slot allocation');

  await runtime.terminate();
  channels.close();
});

// This end-to-end case boots a session, sends an inbound message that produces
// an outbound response, snapshots and restores, performs a relocation
// round-trip, then sends another inbound message and observes a fresh response.
// It exercises only public capability, channel, scheduling, snapshot/restore,
// relocation, and run surfaces.
Deno.test("Runtime: end-to-end inbound → response → snapshot → resume → relocate → inbound", async () => {
  // -------- Phase 1: boot, send, observe response ----------
  const outboundFromDrone1 = [];
  const session1 = freshSession();
  const pair1 = createPairedChannels();
  const runtime1 = new Runtime({
    session: session1,
    inboundChannel: pair1.a,
    outboundChannel: pair1.a,
    capabilities: [
      {
        name: 'echo',
        setup: (al) => {
          const root = al.createRootGrant();
          const h = al.register({});
          root.add(h);
          al.setHandler(h, 'reply', ({ args }) => {
            // Capability emits via the runtime's public send.
            // We capture into the test's array; in production
            // this would call runtime.send via a back-channel,
            // but holding a reference is simpler for testing.
            outboundFromDrone1.push(args[0]);
            return null;
          });
          al.declare('Host', h);
        },
      },
    ],
    hostServices: {},
    subsystems: {},
    onInboundMessage: async (payload) => {
      // Decode → drive a fresh drone program with the payload.
      const text = utf(payload);
      session1.parse(`Host.reply("echo:${text}");`);
      await runtime1.run(0);
    },
  });
  await runtime1.start();

  await pair1.b.send(u8('hello'));
  await waitFor(() => outboundFromDrone1.includes('echo:hello'),
    { label: 'phase-1 response from drone' });

  // -------- Snapshot ---------------------------------------
  // Host-orchestrated: quiesce, then slice the buffers the host
  // allocated. snapshotSession does that for sessions constructed
  // via freshSession.
  await runtime1.quiesce();
  const snap = snapshotSession(session1);
  assert(snap.vatBytes instanceof Uint8Array);
  assert(snap.membraneBytes instanceof Uint8Array);
  await runtime1.terminate();
  pair1.close();

  // -------- Phase 2: restore from snapshot -----------------
  const outboundFromDrone2 = [];
  let onResumeFired = 0;
  const session2 = restoreSession(snap.vatBytes, snap.membraneBytes);
  const pair2 = createPairedChannels();
  const runtime2 = new Runtime({
    session: session2,
    resume: true,    // host knows this was restored from snapshot
    inboundChannel: pair2.a,
    outboundChannel: pair2.a,
    capabilities: [
      {
        name: 'echo',
        setup: (al, _ctx, opts) => {
          // After snapshot+resume, the membrane survives but
          // JS handler closures don't — re-bind by
          // declarationName, the documented pattern.
          const entries = al.membrane.enumerateHandles();
          const entry = entries.find(e => e.declarationName === 'Host');
          assertExists(entry, 'Host declaration must survive snapshot');
          al.setHandler(entry.handle, 'reply', ({ args }) => {
            outboundFromDrone2.push(args[0]);
            return null;
          });
          return {
            onResume: () => { onResumeFired++; },
          };
        },
      },
    ],
    hostServices: {},
    subsystems: {},
    onInboundMessage: async (payload) => {
      const text = utf(payload);
      // After resume, advance the instruction index past phase 1's body before
      // appending fresh code.
      const before = session2.state(0).instructionCount;
      session2.parse(`Host.reply("echo2:${text}");`);
      session2.setInstruction(0, before);
      await runtime2.run(0);
    },
  });
  await runtime2.start();
  assertEquals(onResumeFired, 1,
    'restored runtime must fire onResume during setup');

  // -------- Simulated relocation round-trip ----------------
  await runtime2.quiesce();
  // No-op spec: every field undefined → all three branches
  // are skipped. Tests that the call doesn't throw and the
  // runtime survives back to a working state.
  runtime2.notifyMemoryRelocated({});
  runtime2.resume();

  // -------- Phase 2: send another message ------------------
  await pair2.b.send(u8('world'));
  await waitFor(() => outboundFromDrone2.includes('echo2:world'),
    { label: 'phase-2 response from resumed+relocated drone' });

  await runtime2.terminate();
  pair2.close();
});

// Regression: method-path context.suspend must wake the slot when
// resolve() fires from outside the run loop. Previously
// handleExternalCall passed a null onResume into _setupSuspension,
// so a late settle marshalled the value onto the pending stack and
// cleared exitCondition but never enqueued the slot — leaving it
// silently stuck. The getter path already wired an onResume; this
// test pins the same behavior for the method path.
Deno.test("Runtime: method-path context.suspend wakes slot on late resolve", async () => {
  let stashedResolve = null;
  const { runtime, session, channels } = new RuntimeBuilder()
    .capability({
      name: 'echo-suspend',
      setup: (al) => {
        const rootGrant = al.createRootGrant();
        const handle = al.register({});
        rootGrant.add(handle);
        al.setHandler(handle, 'say', ({ context }) => {
          return context.suspend((resolve, _reject) => {
            stashedResolve = resolve;
          });
        });
        al.declare('Echo', handle);
      },
    })
    .onInboundMessage(() => {})
    .build();
  await runtime.start();

  session.parse(`let reply = null; reply = await Echo.say("hi")`);

  const runPromise = runtime.run(0);
  await new Promise(r => setTimeout(r, 10));
  assertExists(stashedResolve);

  // run(0) returns once the slot parks on the suspension; the
  // late resolve must wake the slot via the spawned-context drain,
  // not via the original run promise.
  const parkResult = await runPromise;
  assertEquals(parkResult.status, 'suspended');

  stashedResolve('hi-from-host');

  // Without the onResume wiring in handleExternalCall, this binding
  // stays null forever — the slot is "ready to resume" but never
  // enqueued. With the fix, _enqueueSpawnedContexts drives it.
  await waitFor(() => session.get(0, 'reply') === 'hi-from-host',
    { label: 'late resolve drives slot to terminal' });

  await runtime.terminate();
  channels.close();
});

// Slot 0 is the persistent root context: embedders rely on driving fresh code
// there after the top-level program finishes. When its continuation parks on a
// genuine async boundary and wakes through _drainPendingSpawned, it is not
// registered in _invokeWaiters because that registry covers only invokeClosure
// calls. Treating the wake as a background drive used to free slot 0 on
// terminal completion, leaving later code unable to use the zeroed root slot.
Deno.test("Runtime: slot 0 survives its own continuation after a genuine async park", async () => {
  const { runtime, session, channels } = new RuntimeBuilder()
    .capability({
      name: 'echo-suspend',
      setup: (al) => {
        const rootGrant = al.createRootGrant();
        const handle = al.register({});
        rootGrant.add(handle);
        al.setHandler(handle, 'say', ({ context }) => {
          return context.suspend((resolve, _reject) => {
            // A real macrotask-boundary async host call (what
            // fetch/time capabilities do under the hood) — NOT a
            // same-tick resolve, which would never enter the
            // spawned-context drain path at all.
            setTimeout(() => resolve('hi-from-host'), 10);
          });
        });
        al.declare('Echo', handle);
      },
    })
    .onInboundMessage(() => {})
    .build();
  await runtime.start();

  session.parse(`let reply = null; reply = await Echo.say("hi")`);

  const parkResult = await runtime.run(0);
  assertEquals(parkResult.status, 'suspended');

  await waitFor(() => session.get(0, 'reply') === 'hi-from-host',
    { label: 'late resolve drives slot 0 to terminal' });

  assert(session.mem.getExitCondition(0) !== CONTEXT_STATUS_FREE,
    'slot 0 must survive its own top-level continuation reaching terminal after a genuine async park');

  // Slot 0 must still be drivable — this is the concrete failure mode
  // reported by embedders: attempting to run fresh code on slot 0 after
  // the original top-level program awaited a real host-service call.
  session.setInstruction(0, 0);

  await runtime.terminate();
  channels.close();
});

// =============================================================================
// Scheduler-idle notification
// =============================================================================

Deno.test("Runtime onSchedulerIdle: rejects a non-function value", () => {
  const session = freshSession();
  assertThrows(() => new Runtime({
    session,
    inboundChannel:  { onMessage: () => () => {} },
    outboundChannel: { send: async () => {}, trySend: () => true },
    capabilities: [], hostServices: {}, subsystems: {},
    onInboundMessage: () => {},
    onSchedulerIdle: 'not-a-function',
  }), RuntimeBootError, "'onSchedulerIdle' must be a function");
});

Deno.test("Runtime onSchedulerIdle: retains no legacy mirror option", () => {
  const session = freshSession();
  const runtime = new Runtime({
    session,
    inboundChannel:  { onMessage: () => () => {} },
    outboundChannel: { send: async () => {}, trySend: () => true },
    capabilities: [], hostServices: {}, subsystems: {},
    onInboundMessage: () => {},
    // The retired mirror option must not be retained anywhere —
    // no caller-provided vat or membrane arrays survive
    // construction.
    mirror: {
      interpreter: new Uint8Array(0),
      membrane:    new Uint8Array(0),
    },
  });
  assertEquals('_mirror' in runtime, false,
    'the runtime must not retain a mirror configuration');
  assertEquals(typeof runtime._copyToMirror, 'undefined',
    'the mirror copy surface must be gone');
});

Deno.test("Runtime onSchedulerIdle: one drive fires one notification, observing SCHEDULER_IDLE", async () => {
  let idleCount = 0;
  let observedState = null;
  let rt = null;
  const { runtime, session, channels } = new RuntimeBuilder()
    .onInboundMessage(() => {})
    .onSchedulerIdle(() => {
      idleCount++;
      observedState = rt.runtimeState.get();
    })
    .build();
  rt = runtime;

  await runtime.start();
  assertEquals(idleCount, 0,
    'the hook must not fire before any slot drives');

  session.parse(`let a = 1`);
  const result = await runtime.run(0);
  assertEquals(result.status, 'done');
  assertEquals(idleCount, 1,
    'one drive to terminal fires exactly one notification');
  assertEquals(observedState, RUNTIME_STATE.SCHEDULER_IDLE,
    'the hook must observe the already-published SCHEDULER_IDLE');

  await runtime.terminate();
  channels.close();
});

Deno.test("Runtime onSchedulerIdle: fires only when the final concurrent drive returns", async () => {
  let idleCount = 0;
  let capturedClosure = null;
  let receivedFromClosure = null;
  const { runtime, session, channels } = new RuntimeBuilder()
    .capability({
      name: 'host',
      setup: (al) => {
        const rootGrant = al.createRootGrant();
        const handle = al.register({});
        rootGrant.add(handle);
        al.setHandler(handle, 'register', ({ args }) => {
          capturedClosure = args[0];
          return null;
        });
        al.setHandler(handle, 'callback', ({ args }) => {
          receivedFromClosure = args[0];
          return null;
        });
        al.declare('Host', handle);
      },
    })
    .onInboundMessage(() => {})
    .onSchedulerIdle(() => { idleCount++; })
    .fuel(10_000)
    .build();
  await runtime.start();

  // Drive 1: registers the closure early (an external call inside
  // the same drive), then burns past the fuel budget. The
  // onFuelExhausted gate below holds the drive in flight until the
  // test releases it.
  session.parse(`
    Host.register(function(n) { Host.callback(n); });
    let i = 0;
    while (i < 60000) { i = i + 1; }
  `);
  let releaseGate = null;
  let gateRequested = false;
  runtime.onFuelExhausted = () => new Promise((resolve) => {
    gateRequested = true;
    releaseGate = resolve;
  });

  const drive1 = runtime.run(0);
  await waitFor(() => gateRequested, { label: 'drive 1 held at fuel gate' });
  assertExists(capturedClosure);
  assertEquals(runtime.getSchedulerStats().inFlight, 1,
    'drive 1 must still be in flight while gated');

  // Drive 2: a closure call that completes while drive 1 is still
  // in flight. Its return is a non-final return — no notification.
  runtime.scheduleClosureCall(capturedClosure, [7], {});
  await waitFor(() => receivedFromClosure === 7, { label: 'closure fired' });
  assertEquals(idleCount, 0,
    'a non-final drive return must not fire the notification');

  // Release drive 1 with enough fuel to finish. Its return is the
  // final return — exactly one notification.
  releaseGate(10_000_000);
  const result = await drive1;
  assertEquals(result.status, 'done');
  assertEquals(idleCount, 1,
    'the final concurrent return fires exactly one notification');

  await runtime.terminate();
  channels.close();
});

Deno.test("Runtime onSchedulerIdle: quiesce and resume fire no notification", async () => {
  let idleCount = 0;
  const { runtime, session, channels } = new RuntimeBuilder()
    .onInboundMessage(() => {})
    .onSchedulerIdle(() => { idleCount++; })
    .build();
  await runtime.start();

  await runtime.quiesce();
  assertEquals(runtime.getSchedulerStats().state, RUNTIME_STATE.QUIESCED);
  assertEquals(idleCount, 0, 'quiesce must not fire the notification');

  runtime.resume();
  assertEquals(runtime.getSchedulerStats().state, RUNTIME_STATE.SCHEDULER_IDLE);
  assertEquals(idleCount, 0,
    "resume's idle publication must not fire the notification");

  // The hook is still alive: a real drive fires it.
  session.parse(`let a = 1`);
  await runtime.run(0);
  assertEquals(idleCount, 1);

  await runtime.terminate();
  channels.close();
});

Deno.test("Runtime onSchedulerIdle: a final drive under quiesce publishes QUIESCED and fires no notification", async () => {
  let idleCount = 0;
  const { runtime, session, channels } = new RuntimeBuilder()
    .onInboundMessage(() => {})
    .onSchedulerIdle(() => { idleCount++; })
    .fuel(10_000)
    .build();
  await runtime.start();

  session.parse(`
    let i = 0;
    while (i < 60000) { i = i + 1; }
  `);
  let releaseGate = null;
  let gateRequested = false;
  runtime.onFuelExhausted = () => new Promise((resolve) => {
    gateRequested = true;
    releaseGate = resolve;
  });

  const drive = runtime.run(0);
  await waitFor(() => gateRequested, { label: 'drive held at fuel gate' });

  // Quiesce while the drive is in flight — the runtime drains.
  const quiesced = runtime.quiesce();
  assertEquals(runtime.getSchedulerStats().state,
    RUNTIME_STATE.DRAINING_ROOT_SLOTS);

  releaseGate(10_000_000);
  const result = await drive;
  assertEquals(result.status, 'done');
  await quiesced;

  assertEquals(runtime.getSchedulerStats().state, RUNTIME_STATE.QUIESCED,
    'the final drive under quiesce publishes QUIESCED');
  assertEquals(idleCount, 0,
    'a QUIESCED publication must not fire the notification');

  runtime.resume();
  assertEquals(idleCount, 0,
    "resume after a drained quiesce must not fire the notification");

  await runtime.terminate();
  channels.close();
});

Deno.test("Runtime onSchedulerIdle: a throwing hook surfaces via onHandlerError without breaking the drive", async () => {
  const handlerErrors = [];
  const { runtime, session, channels } = new RuntimeBuilder()
    .onInboundMessage(() => {})
    .onHandlerError((rej) => { handlerErrors.push(rej); })
    .onSchedulerIdle(() => { throw new Error('hook bug'); })
    .build();
  await runtime.start();

  session.parse(`let a = 1`);
  const result = await runtime.run(0);
  assertEquals(result.status, 'done',
    'a throwing hook must not reject the drive promise');
  assertEquals(runtime.getSchedulerStats().state,
    RUNTIME_STATE.SCHEDULER_IDLE,
    'the state publishes before the hook, so a throw cannot block it');

  assert(handlerErrors.length >= 1,
    'a throwing hook must surface via onHandlerError');
  const msg = handlerErrors[0]?.error?.message
    ?? handlerErrors[0]?.message
    ?? String(handlerErrors[0]);
  assert(/hook bug/.test(msg),
    `expected 'hook bug' in surfaced error, got: ${msg}`);

  // Quiesce coordination survives the throwing hook.
  await runtime.quiesce();
  assertEquals(runtime.getSchedulerStats().state, RUNTIME_STATE.QUIESCED);
  runtime.resume();

  await runtime.terminate();
  channels.close();
});

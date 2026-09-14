/**
 * Per-activity integration tests for the v5 in-flight ledger.
 *
 * Asserts that the runtime claims and frees ledger entries at
 * the right moments for each runtime-internal activity:
 *
 *   - DRIVING_ROOT        — scheduler drives a root slot
 *   - DISPATCHING_CLOSURE — closure queued, not yet dispatched
 *   - AWAITING_PROMISE    — slot parked on a pending promise
 *
 * The v1 ledger does NOT distinguish JS-promise awaits from
 * SS-peer-slot awaits — both surface as AWAITING_PROMISE. Value
 * 4 is reserved for a future AWAITING_ASYNC_PEER split.
 *
 * Also covers the table-saturation path (claim returns -1 —
 * surfaces through onHandlerError as a LedgerSaturatedError).
 *
 * Run with: deno task test tests/runtime/activities_test.js
 */

import { assertEquals, assert } from "https://deno.land/std@0.208.0/assert/mod.ts";
import { RuntimeBuilder } from '../../src/runtime/test-harness.js';
import { LEDGER_ACTIVITY } from '../../src/runtime/index.js';

const tick = (ms = 0) => new Promise(r => setTimeout(r, ms));

// =============================================================================
// DRIVING_ROOT
// =============================================================================

Deno.test("activity DRIVING_ROOT: appears while a drive is in flight, frees on done", async () => {
  // Use a host capability whose handler synchronously samples
  // the ledger — this catches the entry while the drive is
  // mid-flight (the handler runs inside the drive loop).
  let sampledWalk = null;
  let observedRuntime = null;
  const { runtime, session, channels } = new RuntimeBuilder()
    .capability({
      name: 'host',
      setup: (al) => {
        const rootGrant = al.createRootGrant();
        const handle = al.register({});
        rootGrant.add(handle);
        al.setHandler(handle, 'sampleLedger', () => {
          // Sample the ledger from inside the drive.
          sampledWalk = observedRuntime.ledger.walk();
          return null;
        });
        al.declare('Host', handle);
      },
    })
    .onInboundMessage(() => {})
    .build();
  observedRuntime = runtime;
  await runtime.start();

  session.parse(`Host.sampleLedger();`);
  const result = await runtime.run(0);
  assertEquals(result.status, 'done');

  // Mid-drive, the ledger had exactly one entry: DRIVING_ROOT
  // for slot 0.
  assert(sampledWalk !== null, 'handler must have run');
  assertEquals(sampledWalk.length, 1,
    `expected 1 ledger entry mid-drive; got ${JSON.stringify(sampledWalk)}`);
  assertEquals(sampledWalk[0].activity, LEDGER_ACTIVITY.DRIVING_ROOT);
  assertEquals(sampledWalk[0].contextSlot, 0,
    'DRIVING_ROOT contextSlot is the slot being driven');
  assert(sampledWalk[0].beganAtTick >= 0,
    'beganAtTick should be a non-negative tick value');

  // After the drive resolves, the entry is freed.
  assertEquals(runtime.ledger.walk(), [],
    'ledger is empty after drive resolves');

  await runtime.terminate();
  channels.close();
});

// =============================================================================
// DISPATCHING_CLOSURE
// =============================================================================

Deno.test("activity DISPATCHING_CLOSURE: appears when queued, freed when picked up", async () => {
  // The scheduleClosureCall path: claim happens synchronously
  // inside scheduleClosureCall; free happens at the start of
  // _dispatchOne (async). Between the call and the next
  // microtask, the entry should be visible.
  //
  // To make this observable: drive a synchronous program first
  // that registers a closure. Then call scheduleClosureCall
  // (synchronously) and immediately walk the ledger before
  // yielding to the event loop.
  let capturedClosure = null;
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
        al.declare('Host', handle);
      },
    })
    .onInboundMessage(() => {})
    .build();
  await runtime.start();

  session.parse(`Host.register(function() {});`);
  const r1 = await runtime.run(0);
  assertEquals(r1.status, 'done');
  assert(capturedClosure !== null, 'closure was registered');

  // Now queue the closure. Synchronously walk the ledger before
  // any microtask drains.
  runtime.scheduleClosureCall(capturedClosure, [], { callerSlot: 12 });
  const walkAfterEnqueue = runtime.ledger.walk();

  // The DISPATCHING_CLOSURE entry should be present, with the
  // callerSlot we passed.
  const dispatchEntries = walkAfterEnqueue.filter(
    e => e.activity === LEDGER_ACTIVITY.DISPATCHING_CLOSURE);
  assertEquals(dispatchEntries.length, 1,
    `expected 1 DISPATCHING_CLOSURE entry; got ${JSON.stringify(walkAfterEnqueue)}`);
  assertEquals(dispatchEntries[0].contextSlot, 12,
    'callerSlot from opts surfaces as contextSlot on the entry');
  assert(dispatchEntries[0].id1 > 0,
    'id1 carries the closure pointer (non-zero)');

  // Let the drainer pick the closure up and finish.
  await tick(20);

  // Entry is freed.
  const walkAfterDispatch = runtime.ledger.walk();
  const stillDispatching = walkAfterDispatch.filter(
    e => e.activity === LEDGER_ACTIVITY.DISPATCHING_CLOSURE);
  assertEquals(stillDispatching.length, 0,
    'DISPATCHING_CLOSURE entry freed when dispatch picks it up');

  await runtime.terminate();
  channels.close();
});

Deno.test("activity DISPATCHING_CLOSURE: omitted callerSlot uses the max-u32 sentinel", async () => {
  // When scheduleClosureCall is invoked without a callerSlot
  // (e.g. JS-side timer fire), the ledger entry's contextSlot
  // is 0xFFFFFFFF. NOT 0 — slot 0 is a real slot id.
  let capturedClosure = null;
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
        al.declare('Host', handle);
      },
    })
    .onInboundMessage(() => {})
    .build();
  await runtime.start();

  session.parse(`Host.register(function() {});`);
  await runtime.run(0);

  // Schedule without callerSlot.
  runtime.scheduleClosureCall(capturedClosure, [], {});
  const walk = runtime.ledger.walk();
  const entry = walk.find(e => e.activity === LEDGER_ACTIVITY.DISPATCHING_CLOSURE);
  assert(entry, 'DISPATCHING_CLOSURE entry should exist');
  assertEquals(entry.contextSlot, 0xFFFFFFFF,
    'omitted callerSlot defaults to the max-u32 sentinel (not 0)');

  await tick(20);
  await runtime.terminate();
  channels.close();
});

// =============================================================================
// AWAITING_PROMISE
// =============================================================================

Deno.test("activity AWAITING_PROMISE: appears when a slot parks on a pending promise, frees on resume", async () => {
  // Build a host service whose handler returns a Promise that
  // doesn't resolve until the test explicitly releases it. The
  // sandscript program does an explicit `await` on the handler
  // call, which emits EXIT_AWAIT and parks the slot on the
  // returned promise. While parked, the ledger must hold an
  // AWAITING_PROMISE entry for slot 0; after the promise
  // resolves and the slot resumes, the entry is freed.
  let releaseHandler = null;
  const { runtime, session, channels } = new RuntimeBuilder()
    .capability({
      name: 'host',
      setup: (al) => {
        const rootGrant = al.createRootGrant();
        const handle = al.register({});
        rootGrant.add(handle);
        al.setHandler(handle, 'slowCall', () => {
          // Return a Promise that pauses until releaseHandler is called.
          return new Promise(r => { releaseHandler = () => r('done'); });
        });
        al.declare('Host', handle);
      },
    })
    .onInboundMessage(() => {})
    .build();
  await runtime.start();

  // Explicit await — emits EXIT_AWAIT which routes through
  // airlock.handleAwait, where AWAITING_PROMISE is claimed.
  session.parse(`
    async function main() {
      await Host.slowCall();
    }
    main();
  `);
  // Start the drive but don't await yet — let it park.
  const runPromise = runtime.run(0);

  // Let the drive reach the await and park.
  await tick(20);

  // The ledger should have an AWAITING_PROMISE entry for the
  // slot parked on the host-call promise. There may also be
  // DRIVING_ROOT entries for the top-level async drive that
  // hasn't completed yet; filter for the activity we care
  // about.
  const walk = runtime.ledger.walk();
  const awaitingEntries = walk.filter(
    e => e.activity === LEDGER_ACTIVITY.AWAITING_PROMISE);
  assertEquals(awaitingEntries.length, 1,
    `expected 1 AWAITING_PROMISE entry while parked; got ${JSON.stringify(walk)}`);
  assert(awaitingEntries[0].contextSlot >= 0,
    'AWAITING_PROMISE contextSlot is a real slot id');

  // Release the handler — the slot resumes.
  assert(releaseHandler, 'handler should have been invoked and parked');
  releaseHandler();
  await runPromise;
  // The async function may complete on its own; wait for
  // background drives to finish.
  await runtime.quiesce();
  runtime.resume();

  // After resume + completion, no AWAITING_PROMISE entries remain.
  const finalWalk = runtime.ledger.walk();
  const stillAwaiting = finalWalk.filter(
    e => e.activity === LEDGER_ACTIVITY.AWAITING_PROMISE);
  assertEquals(stillAwaiting.length, 0,
    'AWAITING_PROMISE entry freed when slot resumes');

  await runtime.terminate();
  channels.close();
});

// =============================================================================
// Table-saturation handling
// =============================================================================

Deno.test("activity: DRIVING_ROOT claim returning -1 surfaces as a LedgerSaturatedError via onHandlerError", async () => {
  // Pre-fill the ledger with embedder activities so the
  // scheduler's DRIVING_ROOT claim returns -1. The drive should
  // still proceed (saturation is a diagnostic, not a hard
  // failure), but onHandlerError fires with a structured
  // LedgerSaturatedError.
  const handlerErrors = [];
  const { runtime, session, channels } = new RuntimeBuilder()
    .onInboundMessage(() => {})
    .onHandlerError((e) => handlerErrors.push(e))
    .build();
  await runtime.start();

  // Pre-fill: claim every entry as an embedder activity.
  const cap = runtime.ledger.capacity;
  for (let i = 0; i < cap; i++) {
    const idx = runtime.ledger.claim({
      contextSlot: 99,
      activity: 64, // embedder activity
    });
    assert(idx >= 0, `claim ${i} should succeed in pre-fill`);
  }
  // Now any new claim returns -1.
  assertEquals(runtime.ledger.claim({ contextSlot: 1, activity: 64 }), -1,
    'pre-fill complete: table is at capacity');

  // Drive a program. The scheduler's DRIVING_ROOT claim returns
  // -1, surfaces as LedgerSaturatedError.
  session.parse(`let x = 1;`);
  const result = await runtime.run(0);
  assertEquals(result.status, 'done',
    'drive still proceeds even when ledger is saturated');

  // onHandlerError received a LedgerSaturatedError.
  assert(handlerErrors.length >= 1,
    `expected at least one onHandlerError; got none`);
  // The runtime wraps the error in an AttributedRejection;
  // the inner error name is what we care about.
  const saturationError = handlerErrors.find(e => {
    const inner = e.cause ?? e;
    return inner.name === 'LedgerSaturatedError';
  });
  assert(saturationError,
    `expected a LedgerSaturatedError in handlerErrors; got ` +
    handlerErrors.map(e => (e.cause ?? e).name).join(', '));

  await runtime.terminate();
  channels.close();
});

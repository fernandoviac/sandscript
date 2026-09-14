/**
 * Cross-realm test for the in-flight ledger.
 *
 * Phase 1 already covered the cell + ledger primitives in
 * isolation. Phase 3 added a Worker-based test for the
 * runtime-state cell over a live runtime. This file does the
 * equivalent for the ledger: spawn a Worker, transfer the
 * membrane SharedArrayBuffer to it, and verify the Worker can
 * walk the ledger via the same view module the main thread uses
 * and observe entries appearing/disappearing as the main-thread
 * runtime makes progress.
 *
 * Run with: deno task test tests/runtime/cross_realm_ledger_test.js
 */

import { assertEquals, assert } from "https://deno.land/std@0.208.0/assert/mod.ts";
import { Runtime, LEDGER_ACTIVITY } from '../../src/runtime/index.js';
import { createPairedChannels } from '../../src/runtime/test-harness.js';
import { createSession } from '../../src/fuel/session.js';
import { HEADER as MEMBRANE_HEADER } from '../../src/membrane/index.js';
import { freshSession } from '../../src/host-owned-session.js';

const tick = (ms = 0) => new Promise(r => setTimeout(r, ms));

Deno.test("cross-realm: a Worker walks the ledger via SAB and sees the main thread's activity entries", async () => {
  // Build a runtime over a SharedArrayBuffer-backed membrane so
  // the ledger region is observable from another realm. Small
  // capacities keep the SAB tight; the test doesn't need large
  // tables.
  const SAB_SIZE = 64 * 1024;
  const buffer = new SharedArrayBuffer(SAB_SIZE);
  const session = freshSession({ membraneBuffer: buffer, handleTableCapacity: 32, grantTableCapacity: 16, idListPoolSize: 1024, rootGrantsListCapacity: 4, valueArenaSize: 1024, closureHandleTableCapacity: 8, linkedPromiseTableCapacity: 8, mutationLogCapacity: 16, costLedgerCapacity: 16 });
  const pair = createPairedChannels();

  // Host capability whose handler returns a controllable promise.
  // The drone awaits it; while parked we ask the Worker to walk
  // the ledger and report what it sees.
  let releaseHandler = null;
  const runtime = new Runtime({
    session,
    inboundChannel: pair.a,
    outboundChannel: pair.a,
    capabilities: [{
      name: 'host',
      setup: (al) => {
        const rootGrant = al.createRootGrant();
        const handle = al.register({});
        rootGrant.add(handle);
        al.setHandler(handle, 'slowCall', () => {
          return new Promise(r => { releaseHandler = () => r('done'); });
        });
        al.declare('Host', handle);
      },
    }],
    hostServices: {},
    subsystems: {},
    onInboundMessage: () => {},
  });
  await runtime.start();

  // Membrane offsets the Worker will use to bind its own views.
  const membrane = session.airlock.membrane;
  const baseOffset = membrane.byteOffset;
  const ledgerOffset = membrane.view.getUint32(MEMBRANE_HEADER.LEDGER_OFFSET, true);
  const ledgerCapacity = membrane.view.getUint32(MEMBRANE_HEADER.LEDGER_CAPACITY, true);

  // The Worker imports the same createLedgerView the main thread
  // uses, binds it over the shared buffer at the same offset, and
  // walks on demand. Communication: main → Worker "please walk"
  // requests; Worker → main entry snapshots.
  //
  // Resolve via import.meta.url so the Worker loads source
  // straight from the repo, not from a URL the network would
  // need to resolve.
  const workerScript = `
    import { createLedgerView } from '${new URL('../../src/runtime/ledger.js', import.meta.url).href}';
    let ledger = null;
    self.onmessage = (e) => {
      const msg = e.data;
      if (msg.kind === 'bind') {
        ledger = createLedgerView({
          buffer: msg.buffer,
          byteOffset: msg.byteOffset,
          capacity: msg.capacity,
        });
        self.postMessage({ kind: 'bound' });
      } else if (msg.kind === 'walk') {
        self.postMessage({ kind: 'walked', entries: ledger.walk() });
      }
    };
  `;
  const blob = new Blob([workerScript], { type: 'application/javascript' });
  const workerUrl = URL.createObjectURL(blob);
  const worker = new Worker(workerUrl, { type: 'module' });

  // Helper: request-response over postMessage. Each round-trip
  // posts a message and resolves on the next reply.
  function ask(msg) {
    return new Promise(resolve => {
      worker.onmessage = (e) => resolve(e.data);
      worker.postMessage(msg);
    });
  }

  // Bind the Worker's view to the same ledger region.
  const bound = await ask({
    kind: 'bind',
    buffer,
    byteOffset: baseOffset + ledgerOffset,
    capacity: ledgerCapacity,
  });
  assertEquals(bound.kind, 'bound');

  // Initial state: no main-thread activity yet, ledger is empty.
  const initial = await ask({ kind: 'walk' });
  assertEquals(initial.entries, [],
    'fresh ledger is empty (no main-thread activity yet)');

  // Drive the main-thread program: it awaits Host.slowCall.
  session.parse(`
    async function main() {
      await Host.slowCall();
    }
    main();
  `);
  const runPromise = runtime.run(0);
  // Let the drive reach the await and park.
  await tick(20);

  // From the Worker's perspective, the ledger now holds an
  // AWAITING_PROMISE entry. (DRIVING_ROOT entries for the
  // top-level async drive may also be present; we filter to the
  // activity we care about.)
  const parked = await ask({ kind: 'walk' });
  const awaiting = parked.entries.filter(
    e => e.activity === LEDGER_ACTIVITY.AWAITING_PROMISE);
  assertEquals(awaiting.length, 1,
    `Worker should observe 1 AWAITING_PROMISE entry; got ${JSON.stringify(parked.entries)}`);
  assert(awaiting[0].contextSlot >= 0,
    'AWAITING_PROMISE.contextSlot is a real slot id');
  assert(awaiting[0].beganAtTick >= 0,
    'beganAtTick survived the realm crossing');

  // Release the handler — the slot resumes and the entry is freed.
  assert(releaseHandler, 'handler should have fired');
  releaseHandler();
  await runPromise;
  await runtime.quiesce();
  runtime.resume();

  // Worker observes the ledger has cleared (no AWAITING_PROMISE
  // entries left). DRIVING_ROOT may briefly persist for the
  // top-level async machinery but won't survive quiesce/resume.
  const final = await ask({ kind: 'walk' });
  const stillAwaiting = final.entries.filter(
    e => e.activity === LEDGER_ACTIVITY.AWAITING_PROMISE);
  assertEquals(stillAwaiting.length, 0,
    'Worker observes AWAITING_PROMISE entries cleared after resume');

  worker.terminate();
  URL.revokeObjectURL(workerUrl);
  await runtime.terminate();
  pair.close();
});

Deno.test("cross-realm: Worker observes DRIVING_ROOT mid-drive via Atomics.wait on the state cell", async () => {
  // DRIVING_ROOT entries don't naturally span macrotask
  // boundaries — they're freed the moment a slot parks. To
  // observe one cross-realm, the Worker has to sample the
  // ledger DURING a synchronous main-thread drive, which means
  // it can't be waiting on postMessage (which requires the main
  // thread to yield). The cross-realm primitive that DOES work
  // is Atomics.wait on the runtime-state cell: the cell
  // transitions to RUNNING synchronously inside
  // Scheduler.driveRootSlot before _drive even begins. The
  // Worker, blocked in Atomics.wait, wakes the moment that
  // transition is notified — and at that wake, both threads
  // are live in parallel. The Worker walks the ledger while the
  // main thread is still in the drive loop.
  //
  // This test proves DRIVING_ROOT is cross-realm-observable
  // given the right observation pattern. AWAITING_PROMISE is
  // the easy case (it spans macrotasks); DRIVING_ROOT is the
  // hard case, and Atomics.wait is the cross-realm primitive
  // for the hard case.
  const SAB_SIZE = 64 * 1024;
  const buffer = new SharedArrayBuffer(SAB_SIZE);
  const session = freshSession({ membraneBuffer: buffer, handleTableCapacity: 32, grantTableCapacity: 16, idListPoolSize: 1024, rootGrantsListCapacity: 4, valueArenaSize: 1024, closureHandleTableCapacity: 8, linkedPromiseTableCapacity: 8, mutationLogCapacity: 16, costLedgerCapacity: 16 });
  const pair = createPairedChannels();

  // Capability with a "burn cycles" handler — keeps the SS
  // drive in the run loop long enough for the Worker's wake +
  // walk to land before the drive resolves. The handler returns
  // synchronously (no JS Promise), so the slot stays in
  // DRIVING_ROOT and doesn't park.
  const runtime = new Runtime({
    session,
    inboundChannel: pair.a,
    outboundChannel: pair.a,
    capabilities: [{
      name: 'host',
      setup: (al) => {
        const rootGrant = al.createRootGrant();
        const handle = al.register({});
        rootGrant.add(handle);
        al.setHandler(handle, 'burnCycles', () => {
          // Spin synchronously for ~50ms. The Worker has
          // plenty of time to wake and walk during this.
          const deadline = performance.now() + 50;
          let acc = 0;
          while (performance.now() < deadline) acc += 1;
          return acc;
        });
        al.declare('Host', handle);
      },
    }],
    hostServices: {},
    subsystems: {},
    onInboundMessage: () => {},
  });
  await runtime.start();
  // Pre-program: a single host call that burns cycles. The
  // drive enters _drive, calls handleAsyncCall (or the sync
  // call path), the handler spins for 50ms holding the main
  // thread, then returns. Throughout, the DRIVING_ROOT entry
  // for slot 0 is live.
  session.parse(`Host.burnCycles();`);

  const membrane = session.airlock.membrane;
  const baseOffset = membrane.byteOffset;
  const ledgerOffset = membrane.view.getUint32(MEMBRANE_HEADER.LEDGER_OFFSET, true);
  const ledgerCapacity = membrane.view.getUint32(MEMBRANE_HEADER.LEDGER_CAPACITY, true);
  const stateOffset = membrane.view.getUint32(MEMBRANE_HEADER.RUNTIME_STATE_OFFSET, true);

  // RUNTIME_STATE.INBOUND_LOOP — value 2. (Hardcoded so the
  // worker script doesn't have to import the enum to know the
  // value to wait off of.)
  const INBOUND_LOOP = 2;

  // Worker: bind both views, block on Atomics.wait for the cell
  // to leave INBOUND_LOOP. After the wake, the main thread may
  // still be between Atomics.notify (step 1: state→RUNNING) and
  // ledger.claim (step 2). To race-proofly capture the
  // DRIVING_ROOT entry, the Worker spin-walks the ledger after
  // wake until it sees a runtime activity, with a timeout. The
  // spin is a tight loop on this thread — it doesn't yield to
  // the main thread, which is on its own thread; the SAB writes
  // become visible as fast as the CPU can propagate them.
  const workerScript = `
    import { createLedgerView } from '${new URL('../../src/runtime/ledger.js', import.meta.url).href}';
    self.onmessage = (e) => {
      const { buffer, stateAbsOffset, ledgerAbsOffset, ledgerCapacity } = e.data;
      const stateView = new Int32Array(buffer, stateAbsOffset, 1);
      const ledger = createLedgerView({
        buffer, byteOffset: ledgerAbsOffset, capacity: ledgerCapacity,
      });
      // Block until the cell moves off INBOUND_LOOP. Timeout
      // guards against test hangs.
      const waitResult = Atomics.wait(stateView, 0, ${INBOUND_LOOP}, 5000);
      // Spin-walk until we see a runtime activity (1..63 range)
      // or hit a small wall-clock budget. The main thread is
      // either in driveRootSlot already (claim landed) or about
      // to be (claim is microseconds away). 100ms is generous
      // for either case; if the activity hasn't appeared by
      // then, the drive has already completed and we lost the
      // race entirely.
      const spinDeadline = performance.now() + 100;
      let entries = [];
      while (performance.now() < spinDeadline) {
        entries = ledger.walk();
        if (entries.some(e => e.activity >= 1 && e.activity <= 63)) break;
      }
      const observedState = Atomics.load(stateView, 0);
      self.postMessage({ waitResult, observedState, entries });
    };
  `;
  const blob = new Blob([workerScript], { type: 'application/javascript' });
  const workerUrl = URL.createObjectURL(blob);
  const worker = new Worker(workerUrl, { type: 'module' });

  const wakePromise = new Promise(resolve => {
    worker.onmessage = (e) => resolve(e.data);
  });

  worker.postMessage({
    buffer,
    stateAbsOffset: baseOffset + stateOffset,
    ledgerAbsOffset: baseOffset + ledgerOffset,
    ledgerCapacity,
  });

  // Give the worker a moment to enter Atomics.wait.
  await tick(50);

  // Trigger the drive. The first thing driveRootSlot does is
  // claim DRIVING_ROOT and set state to RUNNING; the Worker
  // wakes immediately and walks while we're still in _drive.
  const runPromise = runtime.run(0);

  // Worker should wake during the drive (long-running while
  // loop). Receive its sample.
  const sample = await wakePromise;
  worker.terminate();
  URL.revokeObjectURL(workerUrl);

  assertEquals(sample.waitResult, 'ok',
    `Worker should have woken on the state cell transition; got ${sample.waitResult}`);
  assert(sample.observedState !== INBOUND_LOOP,
    'Worker observed a state OTHER than INBOUND_LOOP after wake');

  // The ledger snapshot the Worker grabbed should contain a
  // DRIVING_ROOT entry — the main thread was in driveRootSlot
  // when the Worker woke.
  const driving = sample.entries.filter(
    e => e.activity === LEDGER_ACTIVITY.DRIVING_ROOT);
  assert(driving.length >= 1,
    `Worker should observe at least one DRIVING_ROOT cross-realm; ` +
    `got entries=${JSON.stringify(sample.entries)} state=${sample.observedState}`);

  // Wait for the drive to finish. The drive may complete with
  // status 'done', or may stretch over multiple ticks via the
  // scheduler's 'paused' (fuel-exhaustion) re-drive loop;
  // either way is fine — the cross-realm observation already
  // happened. The drive shouldn't error, though.
  const result = await runPromise;
  assert(result.status === 'done',
    `drive should complete cleanly; got status=${result.status} error=${result.error && (result.error.message ?? result.error)}`);

  await runtime.terminate();
  pair.close();
});

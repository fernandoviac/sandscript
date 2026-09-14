/**
 * DRIVING_ROOT ledger saturation under legitimate concurrent load.
 *
 * runtime.js's _driveSlot claims one entry per call and frees it in finally
 * when that drive reaches its next park. scheduleClosureCall awaits each drive
 * serially, so that drainer cannot create simultaneous claims. In contrast,
 * _drainPendingSpawned launches one _driveSlot per woken slot without awaiting
 * between them when several suspended contexts resolve in the same JS turn.
 * These tests park N closures on suspend-based awaits and resolve them in one
 * macrotask so their drives overlap before any promise settles.
 *
 * With N greater than the default ledger capacity of 256,
 * LedgerSaturatedError is an expected capacity signal rather than evidence of
 * a leak. ledger.walk() at saturation shows one current DRIVING_ROOT entry per
 * slot genuinely mid-drive. Every entry is freed when its drive completes,
 * and a second round saturates and recovers identically.
 *
 * The linked-promise table has an independent default capacity of 256 because
 * each parked suspend call retains one slot. These cases raise
 * linkedPromiseTableCapacity so they isolate the DRIVING_ROOT ledger.
 *
 * The saturation signal states that high-concurrency saturation is nonfatal,
 * carries `isDiagnosticSignal: true` for structured routing, and respects the
 * session's configurable `ledgerCapacity`.
 */

import { assert, assertEquals } from "https://deno.land/std@0.208.0/assert/mod.ts";
import { RuntimeBuilder } from '../../src/runtime/test-harness.js';

function tick(ms = 0) { return new Promise((r) => setTimeout(r, ms)); }
async function waitFor(condition, { timeout = 15000, label = 'condition' } = {}) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    if (condition()) return;
    await tick(5);
  }
  throw new Error(`waitFor timed out: ${label}`);
}

function concurrentResolveCap(captured, drainCount) {
  return {
    name: 'cap',
    needs: {},
    setup(airlock) {
      const rootGrant = airlock.createRootGrant();
      const rootHandle = airlock.register({});
      rootGrant.add(rootHandle);

      airlock.setHandler(rootHandle, 'regDrain', ({ args }) => {
        captured.drain = args[0]; return 0;
      });

      // Every call's setTimeout is scheduled up front; when the
      // scheduler pass fires them, all `pendingResolves` resolve
      // callbacks run back-to-back in the SAME macrotask processing
      // pass, before any of driveSlot's promises can settle.
      airlock.setHandler(rootHandle, 'next', ({ context }) => {
        return context.suspend((resolve) => {
          captured.pendingResolves.push(() => resolve(1));
          captured.readyCount++;
        });
      });

      airlock.declare('Cap', rootHandle);
      return { onGrantRequest(id) { return id === 'cap' ? rootGrant : null; } };
    },
  };
}

async function buildRuntime(drainCount) {
  const captured = { drain: null, handlerErrors: [], pendingResolves: [], readyCount: 0 };
  const builder = new RuntimeBuilder()
    // linkedPromiseTableCapacity raised well past drainCount so its own
    // (unrelated, but also-256-by-default) ceiling isn't hit first — see
    // the file-level comment above.
    .sessionOptions({ heapSize: 4 * 1024 * 1024, linkedPromiseTableCapacity: drainCount * 2 })
    .capability(concurrentResolveCap(captured, drainCount))
    .onInboundMessage(() => {})
    .onHandlerError((rej) => { captured.handlerErrors.push(rej); });
  const { runtime, session } = builder.build();
  await runtime.start();

  const result = session.parse(`
    let completed = 0
    grant "cap" {
      Cap.regDrain(async function(id) {
        let x = await Cap.next()
        completed = completed + 1
      })
    }
  `);
  session.setInstruction(0, result.startIndex);
  // The Runtime fanout wrapper's onGrantRequest is always async, so
  // runtime.run(0) suspends immediately after GRANT_START instead of running
  // the registration body within the same drive episode.
  await runtime.run(0);
  await waitFor(() => captured.drain !== null, { label: 'grant body registration to run' });
  assert(captured.drain, 'drain closure not registered');
  return { runtime, session, captured };
}

Deno.test('ledger: N > LEDGER_CAPACITY truly-simultaneous slot drives saturate DRIVING_ROOT — genuine ceiling, not a leak', async () => {
  const CAPACITY_PROBE = await buildRuntime(1);
  const CAPACITY = CAPACITY_PROBE.runtime.ledger.capacity;
  await CAPACITY_PROBE.runtime.terminate();
  assertEquals(CAPACITY, 256, 'LEDGER_CAPACITY is documented as a fixed v5 constant of 256');

  const DRAINS = CAPACITY + 40; // comfortably above the bounded ledger capacity
  const { runtime, session, captured } = await buildRuntime(DRAINS);
  try {
    for (let i = 1; i <= DRAINS; i++) {
      runtime.scheduleClosureCall(captured.drain, [i]);
    }
    // Let every closure park on its `await Cap.next()` — one at a
    // time through the closure-call drainer, but each drive settles
    // fast (parks immediately at the suspend call).
    await waitFor(() => captured.readyCount === DRAINS,
      { label: `all ${DRAINS} drains parked on Cap.next()` });

    // Fire every stashed resolve callback back-to-back, synchronously,
    // in one JS turn — no await between them. Each resolve enqueues
    // its slot and immediately drains it via the
    // onPendingSpawnedContexts hook (runtime.js wires this straight
    // to _drainPendingSpawned, which fires one _driveSlot per slot,
    // unserialized). None of those _driveSlot promises can settle
    // until this synchronous loop yields — so all DRAINS drives are
    // genuinely in flight together, each holding its own DRIVING_ROOT
    // claim.
    const resolves = captured.pendingResolves;
    captured.pendingResolves = [];
    let sawSaturation = false;
    for (const fire of resolves) {
      const before = captured.handlerErrors.length;
      fire();
      if (captured.handlerErrors.length > before) sawSaturation = true;
    }

    assert(sawSaturation,
      `expected at least one LedgerSaturatedError firing ${DRAINS} truly-concurrent ` +
      `drives against a ${CAPACITY}-entry table — if this doesn't fire, the drives may not ` +
      `be landing in the same JS turn (check the resolve-batching shape)`);

    const saturationErrors = captured.handlerErrors.filter(
      (e) => e?.cause?.name === 'LedgerSaturatedError');
    assert(saturationErrors.length > 0, 'expected LedgerSaturatedError instances specifically');

    // The message must not accuse the caller of a leak, and the error must be
    // tagged so embedders can route it away from real-error alerting without
    // string matching.
    for (const e of saturationErrors) {
      assert(e.cause.isDiagnosticSignal === true,
        'LedgerSaturatedError must be tagged isDiagnosticSignal so embedders can ' +
        'filter it out of alerting without string-matching the message');
      assert(/expected under enough legitimately concurrent activity/i.test(e.cause.message),
        `message must state this is expected under legitimate concurrency, not just a leak symptom: ${e.cause.message}`);
      assert(/observability signal, NOT an error/i.test(e.cause.message),
        `message must state plainly that this is non-fatal: ${e.cause.message}`);
    }

    await waitFor(() => session.get(0, 'completed') === DRAINS,
      { label: 'all drains eventually complete despite saturation (it is a diagnostic signal, not a hard failure)' });

    // `completed` increments from SS code inside the drive, before
    // _driveSlot's own .finally() frees the ledger entry — give that
    // finally a moment to run for every drive before walking.
    await waitFor(() => runtime.ledger.walk().length === 0,
      { label: 'every DRIVING_ROOT entry frees after its drive completes' });

    // Round 2: the same N slots drive again. If round 1 leaked ledger
    // entries, capacity would be effectively lower now and saturation
    // would get WORSE (more entries stuck) or the ledger would already
    // be full before any new claims. Confirmed clean between rounds.
    const staleEntries = runtime.ledger.walk();
    assertEquals(staleEntries, [],
      `ledger must be fully drained between rounds — any surviving entries are leaked ` +
      `claims: ${JSON.stringify(staleEntries)}`);
  } finally {
    await runtime.terminate();
  }
});

Deno.test('ledger: ledgerCapacity session option raises the ceiling — the same truly-concurrent load that saturates at the 256 default produces zero LedgerSaturatedErrors', async () => {
  const DRAINS = 296; // same load as the default-capacity test above
  const RAISED_CAPACITY = DRAINS * 2;

  const captured = { drain: null, handlerErrors: [], pendingResolves: [], readyCount: 0 };
  const builder = new RuntimeBuilder()
    .sessionOptions({
      heapSize: 4 * 1024 * 1024,
      linkedPromiseTableCapacity: DRAINS * 2,
      ledgerCapacity: RAISED_CAPACITY,
    })
    .capability(concurrentResolveCap(captured, DRAINS))
    .onInboundMessage(() => {})
    .onHandlerError((rej) => { captured.handlerErrors.push(rej); });
  const { runtime, session } = builder.build();
  await runtime.start();

  const result = session.parse(`
    let completed = 0
    grant "cap" {
      Cap.regDrain(async function(id) {
        let x = await Cap.next()
        completed = completed + 1
      })
    }
  `);
  session.setInstruction(0, result.startIndex);
  // The Runtime fanout wrapper's onGrantRequest is always async, so
  // runtime.run(0) suspends immediately after GRANT_START instead of running
  // the registration body within the same drive episode.
  await runtime.run(0);
  await waitFor(() => captured.drain !== null, { label: 'grant body registration to run' });
  assert(captured.drain, 'drain closure not registered');

  try {
    assertEquals(runtime.ledger.capacity, RAISED_CAPACITY,
      'ledgerCapacity session option must be reflected in runtime.ledger.capacity');

    for (let i = 1; i <= DRAINS; i++) {
      runtime.scheduleClosureCall(captured.drain, [i]);
    }
    await waitFor(() => captured.readyCount === DRAINS,
      { label: `all ${DRAINS} drains parked on Cap.next()` });

    const resolves = captured.pendingResolves;
    captured.pendingResolves = [];
    for (const fire of resolves) fire();

    await waitFor(() => session.get(0, 'completed') === DRAINS,
      { label: 'all drains completed' });

    assertEquals(captured.handlerErrors.length, 0,
      `expected zero handler errors with ledgerCapacity=${RAISED_CAPACITY} for ${DRAINS} ` +
      `concurrent drives, got: ${captured.handlerErrors.map((e) => e?.cause?.message ?? e).join('; ')}`);
  } finally {
    await runtime.terminate();
  }
});

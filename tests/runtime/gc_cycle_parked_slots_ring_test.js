/**
 * GC_CYCLE_PARKED_SLOTS ring entries are written after every GC_CYCLE_START
 * in both the WAT and JS collector paths. Each entry records exactly which
 * slots were parked at collection start: allocated, non-FREE, and not at a
 * terminal exit condition. This captures the state directly rather than
 * inferring it from trace-ring event ordering.
 *
 * Run with: deno task test tests/runtime/gc_cycle_parked_slots_ring_test.js
 */

import { assert, assertEquals } from "https://deno.land/std@0.208.0/assert/mod.ts";
import { RuntimeBuilder } from '../../src/runtime/test-harness.js';
import { readHeaderEventRing } from '../../src/fuel/header-event-ring.js';
import {
  HEADER_EVENT_RING_HEADER_SIZE,
  HEADER_EVENT_RING_ENTRY_SIZE,
  HEADER_EVENT_KIND,
} from '../../src/fuel/constants.js';

function ringSizeFor(entryCount) {
  return HEADER_EVENT_RING_HEADER_SIZE + entryCount * HEADER_EVENT_RING_ENTRY_SIZE;
}

function tick(ms = 0) {
  return new Promise((r) => setTimeout(r, ms));
}

async function waitFor(condition, { timeout = 10000, label = 'condition' } = {}) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    if (condition()) return;
    await tick(5);
  }
  throw new Error(`waitFor timed out: ${label}`);
}

function buildParkedRuntime(gcCollector) {
  let parkedResolve = null;
  let parkedReached = false;
  const captured = { closureA: null };

  const builder = new RuntimeBuilder()
    .sessionOptions({
      heapSize: 256 * 1024,
      headerEventRingSize: ringSizeFor(64),
      gcCollector,
    })
    .capability({
      name: 'box-listener',
      setup: (al) => {
        const rootGrant = al.createRootGrant();
        const handle = al.register({});
        rootGrant.add(handle);
        al.setHandler(handle, 'regA', ({ args }) => { captured.closureA = args[0]; return 0; });
        al.setHandler(handle, 'dispatch', ({ context }) => {
          return context.suspend((resolve) => {
            parkedResolve = resolve;
            parkedReached = true;
          });
        });
        al.declare('Box', handle);
      },
    })
    .onInboundMessage(() => {});

  const { runtime, session } = builder.build();

  return {
    runtime, session, captured,
    waitUntilParked: () => waitFor(() => parkedReached, { label: 'closure A parked' }),
    release: () => {
      assert(parkedResolve, 'release() called before closure A parked');
      const fn = parkedResolve;
      parkedResolve = null;
      fn(undefined);
    },
  };
}

for (const gcCollector of ['wat', 'js']) {
  Deno.test(`GC_CYCLE_PARKED_SLOTS (${gcCollector}): records the parked slot when a gc runs mid-park`, async () => {
    const { runtime, session, captured, waitUntilParked, release } = buildParkedRuntime(gcCollector);
    await runtime.start();

    session.parse(`
      let done = false
      Box.regA(async function() {
        await Box.dispatch()
        done = true
      })
    `);
    await runtime.run(0);
    assert(captured.closureA, 'closureA not registered');

    runtime.scheduleClosureCall(captured.closureA, []);
    await waitUntilParked();

    // Find the slot closure A actually landed on: the sole allocated,
    // non-context-0 slot right now (context 0 is the boot/grant-body
    // context; A got a fresh slot from allocateContext).
    const contextCount = session.memoryImage.getContextCount();
    let parkedSlot = null;
    for (let slot = 0; slot < contextCount; slot++) {
      if (slot === 0) continue;
      if (session.memoryImage.getContextBase(slot) === 0) continue;
      parkedSlot = slot;
      break;
    }
    assert(parkedSlot !== null, 'expected closure A to occupy a real context slot');

    session.gc();

    const ring = readHeaderEventRing(session.memoryImage.view, session.memoryImage.baseOffset);
    const snapshots = ring.entries.filter(e => e.kind === HEADER_EVENT_KIND.GC_CYCLE_PARKED_SLOTS);
    assert(snapshots.length > 0,
      'expected at least one GC_CYCLE_PARKED_SLOTS entry after gc() with A parked');

    const lastSnapshot = snapshots[snapshots.length - 1];
    assertEquals(lastSnapshot.parkedTruncatedCount, 0, 'no truncation expected at this scale');
    assert(lastSnapshot.parkedCount >= 1,
      `expected at least the parked slot counted, got parkedCount=${lastSnapshot.parkedCount}`);
    assert(lastSnapshot.parkedSlots.includes(parkedSlot),
      `expected slot ${parkedSlot} (closure A) in parkedSlots=${JSON.stringify(lastSnapshot.parkedSlots)}`);

    // Pairing: a GC_CYCLE_START must immediately precede this snapshot,
    // matching the existing GC_CYCLE_START/GC_CYCLE_END convention.
    const snapshotIdx = ring.entries.indexOf(lastSnapshot);
    assert(snapshotIdx > 0, 'snapshot must not be the first entry');
    assertEquals(ring.entries[snapshotIdx - 1].kind, HEADER_EVENT_KIND.GC_CYCLE_START,
      'GC_CYCLE_PARKED_SLOTS must immediately follow GC_CYCLE_START');

    release();
    await waitFor(() => session.get(0, 'done') === true, { label: 'closure A completed' });
    await runtime.terminate();
  });

  Deno.test(`GC_CYCLE_PARKED_SLOTS (${gcCollector}): records zero parked slots when nothing is parked`, async () => {
    const { runtime, session } = buildParkedRuntime(gcCollector);
    await runtime.start();

    session.parse(`let x = { a: 1, b: [1,2,3] }`);
    await runtime.run(0);

    session.gc();

    const ring = readHeaderEventRing(session.memoryImage.view, session.memoryImage.baseOffset);
    const snapshots = ring.entries.filter(e => e.kind === HEADER_EVENT_KIND.GC_CYCLE_PARKED_SLOTS);
    assert(snapshots.length > 0, 'expected a GC_CYCLE_PARKED_SLOTS entry even with nothing parked');
    const lastSnapshot = snapshots[snapshots.length - 1];
    assertEquals(lastSnapshot.parkedCount, 0);
    assertEquals(lastSnapshot.parkedTruncatedCount, 0);
    assertEquals(lastSnapshot.parkedSlots, []);

    await runtime.terminate();
  });

  Deno.test(`GC_CYCLE_PARKED_SLOTS (${gcCollector}): reports truncation, never silently drops it, past the inline bitmap capacity`, async () => {
    const handlerErrors = [];
    let capturedB = null;

    const builder = new RuntimeBuilder()
      .sessionOptions({
        heapSize: 1024 * 1024,
        // Big enough that the ~140 CONTEXT_TABLE_GROWTH / FIELD_WRITE
        // entries from parking 140 concurrent contexts don't wrap the
        // ring and overwrite the GC_CYCLE_PARKED_SLOTS entry before the
        // test reads it.
        headerEventRingSize: ringSizeFor(1024),
        gcCollector,
      })
      .capability({
        name: 'churn',
        setup: (al) => {
          const rootGrant = al.createRootGrant();
          const handle = al.register({});
          rootGrant.add(handle);
          al.setHandler(handle, 'regB', ({ args }) => { capturedB = args[0]; return 0; });
          // Parks every call on a macrotask so many piled-up calls stay
          // simultaneously live+parked (same shape as
          // gc_parked_createcrew_concurrent_allocation_test.js's dispatchB).
          // Long enough that all 140 concurrent calls (drained ONE AT A
          // TIME by _kickClosureDrainer) can park before the first one's
          // timer fires and resolves it — a short/zero delay lets early
          // parks resolve before later ones even start, undercounting
          // the simultaneously-parked total.
          al.setHandler(handle, 'parkBriefly', ({ context }) => {
            return context.suspend((resolve) => { setTimeout(() => resolve(undefined), 200); });
          });
          al.declare('Churn', handle);
        },
      })
      .onInboundMessage(() => {});
    const { runtime, session } = builder.build();
    runtime.onHandlerError = (rej) => { handlerErrors.push(rej); };
    await runtime.start();

    session.parse(`
      Churn.regB(async function() {
        await Churn.parkBriefly()
      })
    `);
    await runtime.run(0);
    assert(capturedB, 'closure B not registered');

    // 140 concurrent parked slots — comfortably past
    // HEADER_EVENT_PARKED_BITMAP_BITS (128), forcing real truncation.
    const CONCURRENT = 140;
    for (let i = 0; i < CONCURRENT; i++) {
      runtime.scheduleClosureCall(capturedB, []);
    }
    function countParked() {
      const contextCount = session.memoryImage.getContextCount();
      let n = 0;
      for (let slot = 0; slot < contextCount; slot++) {
        if (session.memoryImage.getContextBase(slot) === 0) continue;
        const exitCondition = session.memoryImage.getExitCondition(slot);
        if (exitCondition !== 0 && exitCondition !== 1 /* EXIT_DONE */) n++;
      }
      return n;
    }
    await waitFor(() => countParked() > 128,
      { label: 'more than 128 slots simultaneously parked' });

    session.gc();

    const ring = readHeaderEventRing(session.memoryImage.view, session.memoryImage.baseOffset);
    const snapshots = ring.entries.filter(e => e.kind === HEADER_EVENT_KIND.GC_CYCLE_PARKED_SLOTS);
    assert(snapshots.length > 0);
    const lastSnapshot = snapshots[snapshots.length - 1];

    assert(lastSnapshot.parkedCount > 128,
      `expected parkedCount > 128 to actually exercise truncation, got ${lastSnapshot.parkedCount} — ` +
      `pressure calibration failure, not evidence the truncation path works`);
    assert(lastSnapshot.parkedTruncatedCount > 0,
      'a snapshot with more parked slots than the bitmap holds must report a non-zero truncated count, ' +
      'never silently claim completeness');
    assertEquals(lastSnapshot.parkedSlots.length, lastSnapshot.parkedCount - lastSnapshot.parkedTruncatedCount,
      'bitmap entries + truncated count must exactly account for every parked slot');
    for (const slot of lastSnapshot.parkedSlots) {
      assert(slot < 128, `bitmap must never report a slot index >= 128, got ${slot}`);
    }

    // Let every parked closure's 200ms timer actually fire and resolve
    // before terminate() — otherwise Deno's test sanitizer flags the
    // still-pending timers as leaks.
    await waitFor(() => countParked() === 0, { label: 'all parked closures to resolve', timeout: 5000 });
    await runtime.terminate();
  });
}

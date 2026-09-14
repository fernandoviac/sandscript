/**
 * Suspension through durable linked-promise slots.
 *
 * context.suspend registers a durable linked-promise slot at
 * suspension time. The slot:
 *   - is reported in the suspend callback's third argument
 *   - appears in airlock.enumerateLinkedPromises() with
 *     parkedContextSlot set to the parked SS context
 *   - survives snapshot/restore; the embedder can settle/reject
 *     it post-restore via the existing settleLinkedPromise /
 *     rejectLinkedPromise primitives, which now route to
 *     resumeWithValue / resumeWithThrow on the parked context
 *     when parkedContextSlot is set.
 */

import { assertEquals, assert } from "https://deno.land/std@0.208.0/assert/mod.ts";
import { createSession } from '../../src/fuel/session.js';
import { parseAndSetup } from './test-helpers.js';
import { createLedgerView, LEDGER_ACTIVITY } from '../../src/runtime/ledger.js';
import { HEADER } from '../../src/membrane/index.js';
import { freshSession, restoreSession, snapshotSession } from '../../src/host-owned-session.js';

function setupSuspendingSession(captureSlotInto) {
  const session = freshSession();
  const { airlock } = session;
  const apiHandle = airlock.register({});
  // Handler suspends and stashes the slot id captured from the
  // third callback arg. Never resolves on its own — the test
  // drives the wake explicitly via settleLinkedPromise /
  // rejectLinkedPromise.
  airlock.setHandler(apiHandle, 'echo', ({ context }) => {
    return context.suspend((_resolve, _reject, { slot }) => {
      if (captureSlotInto) captureSlotInto.slot = slot;
    });
  });
  airlock.declare('Api', apiHandle);
  const root = airlock.createRootGrant('app');
  root.add(apiHandle);
  return session;
}

function driveSpawnedToCompletion(session) {
  for (const contextIdentity of session.airlock.drainPendingSpawnedContextIdentities()) { while (true) {
    const r = session.run(contextIdentity, 1000);
    if (r.status === 'done' || r.status === 'paused' ||
        r.status === 'error' || r.status === 'await') break;
  } }
}

Deno.test("context.suspend: callback receives { slot } as third argument", () => {
  const captured = {};
  const session = setupSuspendingSession(captured);
  parseAndSetup(session, 'Api.echo()');
  const r = session.run(0, 10000);
  assertEquals(r.status, 'suspended');
  assert(typeof captured.slot === 'number',
    'suspend callback must receive a numeric slot id');
  assert(captured.slot >= 0, 'slot id must be a valid table index');
});

Deno.test("context.suspend: enumerateLinkedPromises surfaces the suspension entry with parkedContextSlot", () => {
  const captured = {};
  const session = setupSuspendingSession(captured);
  parseAndSetup(session, 'Api.echo()');
  session.run(0, 10000);
  const entries = session.airlock.enumerateLinkedPromises();
  assertEquals(entries.length, 1);
  assertEquals(entries[0].slot, captured.slot);
  // The SS context is parked at EXIT_EXTERNAL_CALL, not on the SS
  // promise — so parkedSlots is empty. The durable identity for
  // routing post-restore wake is parkedContextSlot.
  assertEquals(entries[0].parkedSlots, []);
  assertEquals(entries[0].parkedContextSlot, 0);
});

Deno.test("context.suspend: pendingContexts entry carries the linked-promise slot", () => {
  const captured = {};
  const session = setupSuspendingSession(captured);
  parseAndSetup(session, 'Api.echo()');
  session.run(0, 10000);
  const entry = session.airlock.pendingContexts.get(0);
  assert(entry !== undefined, 'context 0 must have a pendingContexts entry');
  assertEquals(entry.slot, captured.slot);
  assert(typeof entry.resolve === 'function');
  assert(typeof entry.reject === 'function');
});

Deno.test("context.suspend: live-session resolve frees the linked-promise slot", () => {
  const captured = {};
  const session = setupSuspendingSession(captured);
  parseAndSetup(session, 'Api.echo()');
  session.run(0, 10000);
  assertEquals(session.airlock.linkedPromiseCount(), 1);

  // Live-session resolve via the resolve closure stashed in pendingContexts.
  const { resolve } = session.airlock.pendingContexts.get(0);
  resolve(42);

  // Slot is freed; table count drops back to zero.
  assertEquals(session.airlock.linkedPromiseCount(), 0);
  driveSpawnedToCompletion(session);
  assertEquals(session.result(0), 42);
});

Deno.test("context.suspend: live-session reject frees the linked-promise slot", () => {
  const captured = {};
  const session = setupSuspendingSession(captured);
  parseAndSetup(session, `
    let caught = 'no';
    try { Api.echo() } catch (e) { caught = 'yes:' + e.message }
    caught
  `);
  session.run(0, 10000);
  assertEquals(session.airlock.linkedPromiseCount(), 1);

  const { reject } = session.airlock.pendingContexts.get(0);
  reject(new Error('boom'));

  assertEquals(session.airlock.linkedPromiseCount(), 0);
  driveSpawnedToCompletion(session);
  assertEquals(session.result(0), 'yes:boom');
});
Deno.test("context.suspend: live-session reject preserves structured error fields", () => {
  const session = setupSuspendingSession({});
  parseAndSetup(session, `
    let caught = null;
    try {
      Api.echo()
    } catch (error) {
      caught = { kind: error.kind, details: error.details }
    }
  `);
  session.run(0, 10000);

  const error = new Error('route refused');
  error.kind = 'nexus-route-storage-capacity-exceeded';
  error.details = {
    storageKind: 'route',
    observedBytes: 2049,
    maximumBytes: 2048,
  };
  session.airlock.pendingContexts.get(0).reject(error);
  driveSpawnedToCompletion(session);
  assertEquals(session.get(0, 'caught'), {
    kind: 'nexus-route-storage-capacity-exceeded',
    details: {
      storageKind: 'route',
      observedBytes: 2049,
      maximumBytes: 2048,
    },
  });
});


Deno.test("context.suspend: snapshot + restore + settleLinkedPromise wakes the parked context", () => {
  const session = setupSuspendingSession();
  parseAndSetup(session, `
    let result = "pending";
    result = "got:" + Api.echo();
  `);
  session.run(0, 10000);
  // Mid-suspension snapshot.
  const snap = snapshotSession(session);

  const restored = restoreSession(snap.vatBytes, snap.membraneBytes);
  // The durable identity survives. parkedContextSlot points at the
  // parked context (slot 0). The original resolve/reject closures
  // are gone with the worker — the embedder rebuilds the wake by
  // calling settleLinkedPromise from the outside.
  const entries = restored.airlock.enumerateLinkedPromises();
  assertEquals(entries.length, 1);
  assertEquals(entries[0].parkedContextSlot, 0);
  assertEquals(entries[0].parkedSlots, []);

  restored.airlock.settleLinkedPromise(entries[0].slot, 'hello');
  driveSpawnedToCompletion(restored);
  assertEquals(restored.get(0, 'result'), 'got:hello');
});

Deno.test("context.suspend: rejectOrphanedLinkedPromises wakes the parked context with SnapshotOrphanedError", () => {
  // Embedders that opt into the blanket-reject pattern (the legacy
  // pre-embedder-owned-restore default; still a supported API)
  // must wake suspend-registered contexts the same way they wake
  // JS-Promise-backed ones. The suspend path has no SS-side
  // waiters on the SS promise, so the standard waiter-wake would
  // silently fail — Phase 4 routes through resumeWithThrow on
  // parkedContextSlot instead.
  const session = setupSuspendingSession();
  parseAndSetup(session, `
    let result = "pending";
    try {
      result = "got:" + Api.echo();
    } catch (e) {
      result = "caught:" + e.message;
    }
  `);
  session.run(0, 10000);
  const snap = snapshotSession(session);

  const restored = restoreSession(snap.vatBytes, snap.membraneBytes);
  const rejectedCount = restored.airlock.rejectOrphanedLinkedPromises();
  assertEquals(rejectedCount, 1,
    'one suspend-registered entry should be reported orphaned');
  driveSpawnedToCompletion(restored);
  // The drone observes SnapshotOrphanedError's canonical message
  // ("linked promise orphaned by snapshot/restore") at the call site.
  const result = restored.get(0, 'result');
  assert(result.startsWith('caught:'),
    `expected catch arm to fire, got ${result}`);
  assert(result.includes('orphan'),
    `expected SnapshotOrphanedError message, got ${result}`);
});

Deno.test("context.suspend: snapshot + restore + rejectLinkedPromise raises in the parked context", () => {
  const session = setupSuspendingSession();
  parseAndSetup(session, `
    let result = "pending";
    try {
      result = "got:" + Api.echo();
    } catch (e) {
      result = "caught:" + e.message;
    }
  `);
  session.run(0, 10000);
  const snap = snapshotSession(session);

  const restored = restoreSession(snap.vatBytes, snap.membraneBytes);
  const [entry] = restored.airlock.enumerateLinkedPromises();
  restored.airlock.rejectLinkedPromise(entry.slot, new Error('upstream failed'));
  driveSpawnedToCompletion(restored);
  assertEquals(restored.get(0, 'result'), 'caught:upstream failed');
});

// -----------------------------------------------------------------------------
// Missing awaiting-promise ledger regression
// -----------------------------------------------------------------------------

function attachLedger(session) {
  const m = session.airlock.membrane;
  const ledgerOffset = m.view.getUint32(HEADER.LEDGER_OFFSET, true);
  const ledgerCapacity = m.view.getUint32(HEADER.LEDGER_CAPACITY, true);
  const ledger = createLedgerView({
    buffer: m.buffer,
    byteOffset: m.byteOffset + ledgerOffset,
    capacity: ledgerCapacity,
  });
  session.airlock.setLedger(ledger);
  return ledger;
}

Deno.test("context.suspend: claims AWAITING_PROMISE in the ledger during suspension", () => {
  const session = setupSuspendingSession();
  const ledger = attachLedger(session);
  parseAndSetup(session, 'Api.echo()');
  session.run(0, 10000);

  // The parked context appears in the ledger with AWAITING_PROMISE.
  // The await-opcode path uses the same activity; both forms of
  // "this slot is parked awaiting external resolve" are
  // observationally identical, which is the whole point.
  const entries = ledger.walk().filter(e =>
    e.activity === LEDGER_ACTIVITY.AWAITING_PROMISE && e.contextSlot === 0);
  assertEquals(entries.length, 1,
    'parked context.suspend slot must surface as AWAITING_PROMISE');
});

Deno.test("context.suspend: live-session resolve releases the AWAITING_PROMISE ledger entry", () => {
  const session = setupSuspendingSession();
  const ledger = attachLedger(session);
  parseAndSetup(session, 'Api.echo()');
  session.run(0, 10000);
  assertEquals(
    ledger.walk().filter(e =>
      e.activity === LEDGER_ACTIVITY.AWAITING_PROMISE && e.contextSlot === 0).length,
    1);

  const { resolve } = session.airlock.pendingContexts.get(0);
  resolve(7);

  // Entry is freed on resolve.
  assertEquals(
    ledger.walk().filter(e =>
      e.activity === LEDGER_ACTIVITY.AWAITING_PROMISE && e.contextSlot === 0).length,
    0,
    'AWAITING_PROMISE must be freed when the suspension resolves');
});

Deno.test("context.suspend: live-session reject also releases the AWAITING_PROMISE entry", () => {
  const session = setupSuspendingSession();
  const ledger = attachLedger(session);
  parseAndSetup(session, `
    try { Api.echo() } catch (e) {}
  `);
  session.run(0, 10000);
  assertEquals(
    ledger.walk().filter(e =>
      e.activity === LEDGER_ACTIVITY.AWAITING_PROMISE && e.contextSlot === 0).length,
    1);

  const { reject } = session.airlock.pendingContexts.get(0);
  reject(new Error('nope'));

  assertEquals(
    ledger.walk().filter(e =>
      e.activity === LEDGER_ACTIVITY.AWAITING_PROMISE && e.contextSlot === 0).length,
    0,
    'AWAITING_PROMISE must be freed when the suspension rejects');
});

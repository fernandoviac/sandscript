/**
 * Embedder-driven linked-promise settlement.
 *
 * Covers:
 *   - airlock.enumerateLinkedPromises() returns parkedSlots
 *   - airlock.settleLinkedPromise(slot, value) — happy path post-restore
 *   - airlock.rejectLinkedPromise(slot, error) — happy path post-restore
 *   - slot validation
 *   - mixed scenarios across multiple linked promises
 */

import { assertEquals, assertThrows, assert } from "https://deno.land/std@0.208.0/assert/mod.ts";
import { createSession } from '../../src/fuel/session.js';
import { freshSession, restoreSession, snapshotSession } from '../../src/host-owned-session.js';

function setupFetchSession() {
  const session = freshSession();
  const { airlock } = session;
  const apiHandle = airlock.register({});
  // Handler returns a never-settling Promise so the linked-promise
  // entry sits in the table indefinitely (mirrors a real outbound
  // wire call awaiting a reply).
  airlock.setHandler(apiHandle, 'fetch', () => new Promise(() => {}));
  airlock.declare('Api', apiHandle);
  const root = airlock.createRootGrant('app');
  root.add(apiHandle);
  return session;
}

function driveSpawnedToCompletion(session) {
  while (true) {
    const contexts = session.airlock.drainPendingSpawnedContextIdentities();
    if (contexts.length === 0) return;
    for (const contextIdentity of contexts) {
      while (true) {
        const result = session.run(contextIdentity, 1000);
        // Break on any non-progress status. 'await' means the context
        // parked again on a different promise — the host doesn't get
        // to drive it further until something else settles that
        // promise.
        if (result.status === 'done' || result.status === 'paused' ||
            result.status === 'error' || result.status === 'await') break;
      }
    }
  }
}

Deno.test("airlock.enumerateLinkedPromises includes parkedSlots", () => {
  const session = setupFetchSession();
  session.parse(`let p = Api.fetch(); await p;`);
  session.run(0, 10000);
  // Slot 0 is now parked on the linked promise.
  const entries = session.airlock.enumerateLinkedPromises();
  assertEquals(entries.length, 1);
  assertEquals(entries[0].parkedSlots, [0]);
  assert(typeof entries[0].ssPromisePointer === 'number');
});

Deno.test("airlock.enumerateLinkedPromises: empty parkedSlots when nothing is awaiting", () => {
  const session = setupFetchSession();
  // Drone never awaits — just stores the promise.
  session.parse(`let p = Api.fetch();`);
  session.run(0, 10000);
  const entries = session.airlock.enumerateLinkedPromises();
  assertEquals(entries.length, 1);
  assertEquals(entries[0].parkedSlots, []);
});

Deno.test("settleLinkedPromise: post-restore, embedder settles a parked promise and drone resumes", () => {
  const session = setupFetchSession();
  session.parse(`
    let result = "pending";
    let p = Api.fetch();
    result = "got:" + await p;
  `);
  session.run(0, 10000);
  // Snapshot mid-await.
  const snap = snapshotSession(session);

  const restored = restoreSession(snap.vatBytes, snap.membraneBytes);
  // No auto-reject. The linked promise survives verbatim.
  const entries = restored.airlock.enumerateLinkedPromises();
  assertEquals(entries.length, 1);
  assertEquals(entries[0].parkedSlots, [0]);

  // Embedder settles from the outside with the recovered value.
  restored.airlock.settleLinkedPromise(entries[0].slot, 42);
  driveSpawnedToCompletion(restored);

  const r = restored.get(0, 'result');
  assertEquals(r, 'got:42');
});

Deno.test("rejectLinkedPromise: post-restore, embedder rejects and drone observes the error", () => {
  const session = setupFetchSession();
  session.parse(`
    let result = "pending";
    let p = Api.fetch();
    try {
      await p;
      result = "should-not-reach";
    } catch (e) {
      result = "caught:" + e.message;
    }
  `);
  session.run(0, 10000);
  const snap = snapshotSession(session);

  const restored = restoreSession(snap.vatBytes, snap.membraneBytes);
  const [entry] = restored.airlock.enumerateLinkedPromises();
  restored.airlock.rejectLinkedPromise(entry.slot, new Error("backend exploded"));
  driveSpawnedToCompletion(restored);

  const r = restored.get(0, 'result');
  assertEquals(r, 'caught:backend exploded');
});

Deno.test("settleLinkedPromise: removes the entry from the table", () => {
  const session = setupFetchSession();
  session.parse(`let p = Api.fetch();`);
  session.run(0, 10000);
  const before = session.airlock.linkedPromiseCount();
  assertEquals(before, 1);
  const [entry] = session.airlock.enumerateLinkedPromises();
  session.airlock.settleLinkedPromise(entry.slot, "ok");
  assertEquals(session.airlock.linkedPromiseCount(), 0);
});

Deno.test("settleLinkedPromise: throws on a non-live slot", () => {
  const session = freshSession();
  assertThrows(
    () => session.airlock.settleLinkedPromise(99, "x"),
    Error,
    "not a live linked-promise entry",
  );
});

Deno.test("rejectLinkedPromise: throws on a non-live slot", () => {
  const session = freshSession();
  assertThrows(
    () => session.airlock.rejectLinkedPromise(99, new Error("x")),
    Error,
    "not a live linked-promise entry",
  );
});

Deno.test("Mixed: embedder settles one and rejects another in the same restore session", () => {
  // Three linked promises in flight. The drone stores all three, then
  // awaits the first. After restore the embedder settles two of them
  // and leaves the third parked for a later call. The drone awaits each
  // one in turn so we can verify all three outcomes.
  const session = setupFetchSession();
  session.parse(`
    let p1 = Api.fetch();
    let p2 = Api.fetch();
    let p3 = Api.fetch();
    let r1 = "?";
    let r2 = "?";
    let r3 = "?";
    r1 = await p1;
    try { r2 = await p2; } catch (e) { r2 = "err:" + e.message; }
    r3 = await p3;
  `);
  session.run(0, 10000);
  assertEquals(session.airlock.linkedPromiseCount(), 3);

  const snap = snapshotSession(session);
  const restored = restoreSession(snap.vatBytes, snap.membraneBytes);
  const entries = restored.airlock.enumerateLinkedPromises();
  assertEquals(entries.length, 3);

  // The drone is parked on p1 (the first await). Identify which entry
  // p1 corresponds to by parkedSlots — the entry the drone is awaiting
  // has a non-empty parkedSlots list with drone slot 0.
  const p1Entry = entries.find(e => e.parkedSlots.includes(0));
  assert(p1Entry !== undefined, 'one entry must have drone 0 parked on it');
  restored.airlock.settleLinkedPromise(p1Entry.slot, "alpha");
  driveSpawnedToCompletion(restored);
  // Drone is now parked on p2. Find that entry the same way.
  const remainingAfterP1 = restored.airlock.enumerateLinkedPromises();
  const p2Entry = remainingAfterP1.find(e => e.parkedSlots.includes(0));
  assert(p2Entry !== undefined, 'drone should now be parked on p2');
  restored.airlock.rejectLinkedPromise(p2Entry.slot, new Error("beta-error"));
  driveSpawnedToCompletion(restored);
  // Drone is now parked on p3 (try/catch absorbed the rejection).
  assertEquals(restored.airlock.linkedPromiseCount(), 1);
  assertEquals(restored.get(0, 'r1'), 'alpha');
  assertEquals(restored.get(0, 'r2'), 'err:beta-error');
  assertEquals(restored.get(0, 'r3'), '?');

  // Finally settle the leftover — find the surviving entry.
  const [p3Entry] = restored.airlock.enumerateLinkedPromises();
  restored.airlock.settleLinkedPromise(p3Entry.slot, "gamma");
  driveSpawnedToCompletion(restored);
  assertEquals(restored.airlock.linkedPromiseCount(), 0);
  assertEquals(restored.get(0, 'r3'), 'gamma');
});

/**
 * Slice 5: end-to-end integration test for the snapshottable membrane.
 *
 * This is the architectural proof: one realistic scenario that exercises
 * every membrane surface (handles, grants, root grants, declarations,
 * closure handles, linked promises, compaction) end-to-end through a
 * snapshot/restore cycle. Any host that requires drone state to survive a
 * restart depends on this contract.
 *
 * The scenario mimics how a real host uses the membrane:
 *
 *   1. Build a fresh session. Set up a small "Counter" capability and a
 *      "Things" capability via shared host setup code.
 *   2. Drone runs code that:
 *        - calls handlers via root grant
 *        - opens an interpreter grant block + registers a callback inside it
 *        - asks the host for a JS Promise that the host will settle later
 *        - asks the host for a JS Promise that will NEVER settle in the
 *          original session (will be orphaned by snapshot/restore)
 *   3. Host revokes one grant; drone's surviving callback should observe
 *      this on next firing.
 *   4. Host calls compactMembrane() to prove the buffer can be compacted
 *      mid-lifecycle without breaking anything.
 *   5. Snapshot. Drop all references to the original session.
 *   6. Build a new session from the byte pair in an isolated scope (no
 *      reference to the original).
 *   7. Re-register everything via the documented four-step contract:
 *      enumerateHandles → dispatch by metadata.kind → _bindImpl + setHandlers.
 *      enumerateClosureHandles → match by metadata → store wrapper.
 *      Linked promises were rejected by createSession; verify.
 *   8. Resume drone code. Run new programs that exercise every surface.
 *      Fire surviving callbacks. Verify behavioral equivalence:
 *        - method dispatch works
 *        - root grants still authorize
 *        - revoked grant still reports revoked (and the surviving callback
 *          keyed on it still fires correctly under its captured grants)
 *        - orphaned promise's drone-side .catch fired
 *        - new linked promises post-restore work normally
 *   9. Run a SECOND compactMembrane() post-restore to prove the restored
 *      session is fully operational, not a degraded copy.
 *
 * Run with: deno task test tests/membrane/end_to_end_test.js
 */

import { assertEquals, assert } from "https://deno.land/std@0.208.0/assert/mod.ts";
import { createSession } from '../../src/fuel/session.js';
import { freshSession, restoreSession, snapshotSession } from '../../src/host-owned-session.js';

// =============================================================================
// Host shape with JS-side state surviving session replacement
//
// `kinds` is a JS-side dispatch table the host uses for both fresh-session
// setup and post-restore re-binding. The same install function runs in both
// paths — that's the contract guarantee.
// =============================================================================

function buildHost() {
  // Shared state lives outside every session, as host listener tables do
  // across restarts.
  const counterStateBySlot = new Map();   // slot → { value }
  const thingsStateBySlot = new Map();    // slot → Map(name → ...)

  const kinds = {
    counter: {
      makeImpl: (slot) => {
        const state = counterStateBySlot.get(slot) ?? { value: 0 };
        counterStateBySlot.set(slot, state);
        return state;
      },
      install: (airlock, handle, impl) => {
        airlock.setHandlers(handle, {
          inc: () => ++impl.value,
          read: () => impl.value,
        });
        airlock.setGetter(handle, 'value', () => impl.value);
      },
    },
    things: {
      makeImpl: (slot) => {
        const state = thingsStateBySlot.get(slot) ?? new Map();
        thingsStateBySlot.set(slot, state);
        return state;
      },
      install: (airlock, handle, impl) => {
        airlock.setHandlers(handle, {
          add: ({ args }) => { impl.set(args[0], args[1]); return args[0]; },
          get: ({ args }) => impl.get(args[0]) ?? null,
          count: () => impl.size,
        });
      },
    },
  };

  function declarationFor(kind) {
    return kind === 'counter' ? 'Counter' : 'Things';
  }

  // Linked-promise resolver registry — the host hands out fetch() promises
  // that may or may not settle. Stored externally so cross-cycle state
  // works.
  const pendingPromiseResolvers = [];

  function freshSetup(session) {
    for (const [kind, spec] of Object.entries(kinds)) {
      const handle = session.airlock.register(spec.makeImpl(undefined), { kind });
      // After register, slot is known; rebind impl using slot-keyed state.
      const impl = spec.makeImpl(handle.slot);
      session.airlock.membrane._bindImpl(handle.slot, impl);
      session.airlock.declare(declarationFor(kind), handle);
      const root = session.airlock.createRootGrant(`root-${kind}`);
      root.add(handle);
      spec.install(session.airlock, handle, impl);
    }
    // Add a "fetch" capability separate from the kind-based handles.
    const fetchHandle = session.airlock.register({}, { kind: 'fetch' });
    session.airlock.declare('Fetch', fetchHandle);
    const fetchRoot = session.airlock.createRootGrant('root-fetch');
    fetchRoot.add(fetchHandle);
    installFetch(session.airlock, fetchHandle);
    return { fetchHandle };
  }

  function installFetch(airlock, handle) {
    airlock.setHandler(handle, 'orphaned', () => {
      // Returns a JS Promise that never settles in this session — meant
      // to be orphaned by snapshot/restore.
      return new Promise(() => {});
    });
    airlock.setHandler(handle, 'deferred', () => {
      // Returns a JS Promise the host can settle later via a registered
      // resolver.
      return new Promise((resolve) => pendingPromiseResolvers.push(resolve));
    });
  }

  function restoreSetup(session) {
    for (const entry of session.airlock.membrane.enumerateHandles()) {
      const kind = entry.metadata?.kind;
      const spec = kinds[kind];
      if (spec) {
        const impl = spec.makeImpl(entry.handle.slot);
        session.airlock.membrane._bindImpl(entry.handle.slot, impl);
        spec.install(session.airlock, entry.handle, impl);
        continue;
      }
      if (kind === 'fetch') {
        session.airlock.membrane._bindImpl(entry.handle.slot, {});
        installFetch(session.airlock, entry.handle);
        continue;
      }
      // Unknown kind — host policy decides; here we just bind an empty impl.
      session.airlock.membrane._bindImpl(entry.handle.slot, {});
    }
  }

  return {
    freshSetup,
    restoreSetup,
    pendingPromiseResolvers,
    counterStateBySlot,
    thingsStateBySlot,
  };
}

// =============================================================================
// The scenario
// =============================================================================

Deno.test("End-to-end: full lifecycle round-trips through snapshot/restore", async () => {
  const host = buildHost();

  // -------------------------------------------------------------------------
  // Phase 1: fresh session, drone setup that touches every surface.
  // -------------------------------------------------------------------------
  let phase1 = await (async () => {
    const session = freshSession();
    host.freshSetup(session);

    // Drone work — exercises method dispatch, getters, callbacks captured
    // inside grant blocks, linked promises, and grant revocation prep.
    let storedCallbackSlot = null;
    let storedRevocableSlot = null;

    // Capture the closure handle slot the drone passes via Counter.subscribe.
    // We need a place to receive it; install a one-off handler.
    {
      const counterEntry = session.airlock.membrane.enumerateHandles()
        .find(e => e.metadata?.kind === 'counter');
      session.airlock.setHandler(counterEntry.handle, 'subscribe', ({ args }) => {
        storedCallbackSlot = args[0].slot;
      });
      session.airlock.setHandler(counterEntry.handle, 'subscribeRevocable', ({ args }) => {
        storedRevocableSlot = args[0].slot;
      });
    }

    // Custom grant approver: approves any identifier, returns a fresh
    // grant. We do NOT add Counter to this grant — Counter is already
    // authorized via the root grant set up by freshSetup. The grant
    // block's purpose here is to be CAPTURED by the closure registered
    // inside it, so the closure carries the grant slot in its captured
    // set across snapshot/restore. (Adding Counter to the block's grant
    // would require us to always be inside that block to call Counter,
    // which doesn't match the test's setup.)
    let revocableGrant = null;
    session.airlock.onGrantRequest = (id) => {
      const grant = session.airlock.membrane.createGrant(id);
      if (id === 'revocable') revocableGrant = grant;
      return { approved: true, grant };
    };

    session.parse(`
      // Direct method dispatch via root grant.
      Counter.inc();
      Counter.inc();
      let direct = Counter.read();
      let viaGetter = Counter.value;

      // Closure captured inside a grant block: its captured grants list
      // includes the "fs" grant. After snapshot/restore, firing it must
      // still be authorized by that grant.
      grant "fs" {
        Counter.subscribe(() => Counter.read());
      }

      // Closure captured inside a revocable grant block. The host will
      // revoke this grant before snapshot.
      grant "revocable" {
        Counter.subscribeRevocable(() => Counter.read());
      }

      // Things capability via root grant.
      Things.add("alpha", 1);
      Things.add("beta", 2);
      let thingCount = Things.count();

      // Open a linked promise that the host will resolve after run.
      let deferredPromise = Fetch.deferred();

      // Open a linked promise that will NEVER settle in this session —
      // it'll be orphaned by snapshot/restore.
      let orphanedResult = "none";
      let orphanedPromise = Fetch.orphaned();
      orphanedPromise.then(v => { orphanedResult = "ok:" + v; })
                     .catch(e => { orphanedResult = "rejected:" + e.message; });

      // Drain the deferred promise's chain when it settles.
      let deferredResult = "none";
      deferredPromise.then(v => { deferredResult = "ok:" + v; });
    `);
    const runResult = session.run(0, 100000);
    assertEquals(runResult.status, 'done',
      `phase 1 run should succeed; got ${JSON.stringify(runResult)}`);

    // Settle the deferred promise from the host side.
    assertEquals(host.pendingPromiseResolvers.length, 1,
      `expected 1 pending resolver from Fetch.deferred(); got ${host.pendingPromiseResolvers.length}`);
    host.pendingPromiseResolvers.shift()(123);
    // Yield to the event loop so the JS Promise's .then microtask fires
    // and settles the SS Promise.
    await Promise.resolve();
    // Pump the .then handler through generation-bearing wake identities.
    const readyContexts =
      session.airlock.drainPendingSpawnedContextIdentities();
    for (const identity of readyContexts) {
      while (true) {
        const result = session.airlock.runContext(identity.slot, 1000);
        if (result.status === 'done'
            || result.status === 'paused'
            || result.status === 'error') break;
        if (result.status === 'async_complete') {
          const { waiters } =
            session.airlock.handleAsyncComplete(identity.slot);
          if (waiters) readyContexts.push(...waiters);
          break;
        }
        if (result.status === 'async_rejected') {
          const { waiters } =
            session.airlock.handleAsyncRejected(identity.slot);
          if (waiters) readyContexts.push(...waiters);
          break;
        }
        if (result.status === 'external_call') {
          const externalCall =
            session.airlock.handleExternalCall(identity.slot, 1000);
          if (!externalCall.suspended && !externalCall.threw) {
            session.airlock.resumeWithValue(
              identity.slot, externalCall.result);
          }
          continue;
        }
        if (result.status === 'external_property') {
          session.airlock.handleExternalProperty(identity.slot, 1000);
          continue;
        }
        break;
      }
    }

    // Verify the original session is in the expected state.
    assertEquals(session.get(0, 'direct'), 2);
    assertEquals(session.get(0, 'viaGetter'), 2);
    assertEquals(session.get(0, 'thingCount'), 2);
    assertEquals(session.get(0, 'deferredResult'), 'ok:123');
    assertEquals(session.get(0, 'orphanedResult'), 'none', 'orphaned promise still pending');
    assert(storedCallbackSlot !== null);
    assert(storedRevocableSlot !== null);
    assert(revocableGrant !== null);

    // Revoke the "revocable" grant. The closure captured under it is now
    // unauthorized — areClosureGrantsActive should return false.
    session.airlock.membrane.revoke(revocableGrant);
    const revocableHandle = session.airlock.membrane.closureHandleForSlot(storedRevocableSlot);
    assertEquals(session.airlock.areClosureGrantsActive(revocableHandle), false,
      'revoked grant should make captured callback unauthorized');

    // Run compaction mid-lifecycle. Should NOT free anything load-bearing
    // (closure handles are lazy; revoked grant is referenced by the closure
    // handle's captured-grants list, so it stays live).
    const stats1 = session.airlock.compactMembrane();
    assertEquals(stats1.handlesFreed, 0, 'no handles should be freed (all in use)');
    // The orphan-grant approver minted grants for "fs" and "revocable" —
    // both are referenced by closure-handle captured-grants lists, so
    // neither gets freed by compaction.
    assertEquals(stats1.grantsFreed, 0,
      'grants referenced by closure handles must stay live across compaction');

    // Snapshot.
    const snap = snapshotSession(session);
    return {
      snap,
      // Slot identifiers for cross-phase assertions.
      callbackSlot: storedCallbackSlot,
      revocableCallbackSlot: storedRevocableSlot,
      revokedGrantSlot: revocableGrant.slot,
      // Linked promise was orphaned (one slot still in the table).
      orphanedLinkedCount: session.airlock.linkedPromiseCount(),
    };
  })();

  assertEquals(phase1.orphanedLinkedCount, 1, 'one orphaned linked promise survived to snapshot');

  // -------------------------------------------------------------------------
  // Phase 2: fully isolated restored session — no reference to phase1
  // session past the snap bytes.
  // -------------------------------------------------------------------------
  const { snap, callbackSlot, revocableCallbackSlot, revokedGrantSlot } = phase1;
  phase1 = null;  // drop the original session.

  const restored = restoreSession(snap.vatBytes, snap.membraneBytes);

  // Embedder is responsible for handling orphaned linked promises post-
  // restore. This embedder has no correlation state, so it uses the
  // canonical "reject them all" path.
  restored.airlock.rejectOrphanedLinkedPromises();
  assertEquals(restored.airlock.linkedPromiseCount(), 0,
    'all orphaned linked promises rejected on restore');

  // Re-register handlers per the documented contract.
  host.restoreSetup(restored);

  // Re-attach the closure-capture handlers (they're per-handle and
  // per-method, not part of the kind-based setup).
  let restoredCallbackSlot = null;
  let restoredRevocableSlot = null;
  {
    const counterEntry = restored.airlock.membrane.enumerateHandles()
      .find(e => e.metadata?.kind === 'counter');
    restored.airlock.setHandler(counterEntry.handle, 'subscribe', ({ args }) => {
      restoredCallbackSlot = args[0].slot;
    });
    restored.airlock.setHandler(counterEntry.handle, 'subscribeRevocable', ({ args }) => {
      restoredRevocableSlot = args[0].slot;
    });
  }

  // Walk the surviving closure handles. Both should be there: the "fs"
  // callback (still authorized) and the "revocable" callback (its grant
  // is revoked, so not authorized to fire).
  const closures = restored.airlock.enumerateClosureHandles();
  assertEquals(closures.length, 2, 'both registered callbacks survived restore');
  const closureBySlot = new Map(closures.map(e => [e.closureHandle.slot, e]));
  assert(closureBySlot.has(callbackSlot), 'fs-grant callback survived');
  assert(closureBySlot.has(revocableCallbackSlot), 'revocable-grant callback survived');

  // The "fs" callback's captured grants are still active — its grant slot
  // points at a non-revoked grant in the SAB.
  const fsCallback = closureBySlot.get(callbackSlot).closureHandle;
  assertEquals(restored.airlock.areClosureGrantsActive(fsCallback), true,
    'fs callback should be authorized post-restore');

  // The "revocable" callback's captured grant slot points at the revoked
  // grant in the SAB — areClosureGrantsActive must report false.
  const revocableCallback = closureBySlot.get(revocableCallbackSlot).closureHandle;
  assertEquals(restored.airlock.areClosureGrantsActive(revocableCallback), false,
    'revoked-grant callback must remain unauthorized post-restore');
  // The grant is still in the SAB at the same slot, still flagged revoked.
  assertEquals(restored.airlock.membrane.grantForSlot(revokedGrantSlot).active, false,
    'revoked grant flag survived snapshot/restore');

  // Drone observed the orphaned promise's rejection on next run cycle.
  const orphanedReadyContexts =
    restored.airlock.drainPendingSpawnedContextIdentities();
  for (const identity of orphanedReadyContexts) {
    while (true) {
      const result = restored.airlock.runContext(identity.slot, 1000);
      if (result.status === 'done'
          || result.status === 'paused'
          || result.status === 'error') break;
      if (result.status === 'async_complete') {
        const { waiters } =
          restored.airlock.handleAsyncComplete(identity.slot);
        if (waiters) orphanedReadyContexts.push(...waiters);
        break;
      }
      if (result.status === 'async_rejected') {
        const { waiters } =
          restored.airlock.handleAsyncRejected(identity.slot);
        if (waiters) orphanedReadyContexts.push(...waiters);
        break;
      }
    }
  }
  const orphanedResult = restored.get(0, 'orphanedResult');
  assert(typeof orphanedResult === 'string' && orphanedResult.startsWith('rejected:'),
    `orphaned promise's .catch should have fired post-restore; got: ${orphanedResult}`);
  assert(orphanedResult.includes('orphaned'),
    `error message should mention "orphaned"; got: ${orphanedResult}`);

  // Fire the surviving fs-grant callback. It must run successfully under
  // its captured grant — verifying that captured grant slots in the SAB
  // still authorize after restore.
  const fsCallbackReturnValue = (() => {
    const slot = restored.memoryImage.allocateContext();
    restored.airlock.setupCallbackContext(slot, fsCallback, []);
    while (true) {
      const r = restored.airlock.runContext(slot, 10000);
      if (r.status === 'done') {
        const v = restored.airlock.extractResultFromContext(slot);
        restored.memoryImage.freeContext(slot);
        return v;
      }
      if (r.status === 'external_call') {
        const ext = restored.airlock.handleExternalCall(slot, 1000);
        if (!ext.suspended && !ext.threw) restored.airlock.resumeWithValue(slot, ext.result);
        continue;
      }
      if (r.status === 'external_property') {
        restored.airlock.handleExternalProperty(slot, 1000);
        continue;
      }
      throw new Error(`unexpected: ${r.status}`);
    }
  })();
  // Counter starts at 0 in the restored session (host state is keyed by
  // slot but we made fresh state-by-slot maps via buildHost()). Wait —
  // the test's host instance is reused; its counterStateBySlot started
  // empty for the original, then accumulated value=2. The restoreSetup
  // looks up by slot, finds the existing entry, reuses it (value=2). The
  // callback calls Counter.read() which reads value → 2.
  assertEquals(fsCallbackReturnValue, 2,
    'fs callback fired post-restore, dispatched correctly, returned counter value');

  // Resume drone code (new program) post-restore. Must seek to startIndex.
  const pr = restored.parse(`
    Counter.inc();
    let postRestore = Counter.read();
    let postRestoreCount = Things.count();
    let postRestoreAlpha = Things.get("alpha");
    // New linked promise to prove fresh promise machinery still works.
    let freshDeferred = Fetch.deferred();
    let freshResult = "none";
    freshDeferred.then(v => { freshResult = "ok:" + v; });
  `);
  restored.setInstruction(0, pr.startIndex);
  restored.run(0, 100000);
  // Settle the new deferred promise.
  assertEquals(host.pendingPromiseResolvers.length, 1);
  host.pendingPromiseResolvers.shift()(456);
  await Promise.resolve();
  const restoredReadyContexts =
    restored.airlock.drainPendingSpawnedContextIdentities();
  for (const identity of restoredReadyContexts) {
    while (true) {
      const result = restored.airlock.runContext(identity.slot, 1000);
      if (result.status === 'done'
          || result.status === 'paused'
          || result.status === 'error') break;
      if (result.status === 'async_complete') {
        const { waiters } =
          restored.airlock.handleAsyncComplete(identity.slot);
        if (waiters) restoredReadyContexts.push(...waiters);
        break;
      }
      if (result.status === 'async_rejected') {
        const { waiters } =
          restored.airlock.handleAsyncRejected(identity.slot);
        if (waiters) restoredReadyContexts.push(...waiters);
        break;
      }
      if (result.status === 'external_call') {
        const externalCall =
          restored.airlock.handleExternalCall(identity.slot, 1000);
        if (!externalCall.suspended && !externalCall.threw) {
          restored.airlock.resumeWithValue(
            identity.slot, externalCall.result);
        }
        continue;
      }
      if (result.status === 'external_property') {
        restored.airlock.handleExternalProperty(identity.slot, 1000);
        continue;
      }
      break;
    }
  }
  assertEquals(restored.get(0, 'postRestore'), 3, 'counter incremented from restored value 2 → 3');
  assertEquals(restored.get(0, 'postRestoreCount'), 2, 'Things size preserved');
  assertEquals(restored.get(0, 'postRestoreAlpha'), 1, 'Things content preserved');
  assertEquals(restored.get(0, 'freshResult'), 'ok:456',
    'new linked-promise machinery works post-restore');

  // Final compaction post-restore. Should succeed; nothing was freed
  // because everything is still referenced. Proves the restored session
  // is fully operational, not a degraded copy.
  const stats2 = restored.airlock.compactMembrane();
  assertEquals(stats2.handlesFreed, 0);
  assertEquals(stats2.grantsFreed, 0);
});

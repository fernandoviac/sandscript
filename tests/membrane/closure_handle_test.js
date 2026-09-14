/**
 * Slice 3.5 of snapshottable-membrane: snapshottable closure handles +
 * orphaned-promise rejection.
 *
 * What this slice proves:
 * - registerClosure (called by the marshaller when drone code passes a
 *   closure to a host handler) returns a ClosureHandle wrapper backed by
 *   the SAB.
 * - Captured grants, closure pointer, and metadata round-trip through
 *   snapshot/restore.
 * - After restore, the host can enumerateClosureHandles, re-bind handlers,
 *   and fire the surviving callbacks — they execute with the original
 *   captured grants.
 * - Heap GC (which moves closure objects) updates the SAB closure pointers.
 * - Lazy reclamation: closure-handle slots stay alive until explicit
 *   dropClosureHandle or FinalizationRegistry firing.
 * - Linked promises pending at snapshot time are rejected with
 *   SnapshotOrphanedError on restore — drone code awaiting them gets a
 *   thrown rejection on next run cycle.
 *
 * Run with: deno task test tests/membrane/closure_handle_test.js
 */

import { assertEquals, assertThrows, assert } from "https://deno.land/std@0.208.0/assert/mod.ts";
import { createSession } from '../../src/fuel/session.js';
import {
  ClosureHandle,
  isClosureHandle,
  StaleClosureHandleError,
  SnapshotOrphanedError,
} from '../../src/membrane/index.js';
import { freshSession, restoreSession, snapshotSession } from '../../src/host-owned-session.js';
import { DRONE_FORMAT_VERSION } from '../../src/persisted-format.js';

// =============================================================================
// Helpers — capture a real closure handle through the marshaller path
// =============================================================================

/**
 * Set up a session with an Api that captures any closure passed to it.
 * Drone code runs `Api.give(() => ...)`; the marshaller calls
 * registerClosure, which returns a ClosureHandle. Returns the captured
 * wrapper.
 */
function captureClosure(droneSource = 'Api.give(() => 42)', metadataKind = null) {
  const session = freshSession();
  const { airlock } = session;
  let capturedHandle = null;
  const apiHandle = airlock.register({});
  airlock.setHandler(apiHandle, 'give', ({ args }) => {
    capturedHandle = args[0];
    return undefined;
  });
  airlock.declare('Api', apiHandle);
  // Authorize Api with a root grant so drone code can reach it without
  // wrapping every test in a `grant "x" { ... }` block.
  const root = airlock.createRootGrant('test-root');
  root.add(apiHandle);
  session.parse(droneSource);
  session.run(0, 10000);
  if (metadataKind !== null) {
    // The auto-marshal path registers closures with metadata=null. Stamp
    // the requested kind via airlock.setClosureMetadata — the same path
    // hosts use in real code.
    airlock.setClosureMetadata(capturedHandle, { kind: metadataKind });
  }
  return { session, airlock, handle: capturedHandle, apiHandle };
}

function captureGroupedGrantClosure() {
  const session = freshSession();
  const { airlock } = session;
  let closureHandle = null;
  const apiHandle = airlock.register({});
  airlock.setHandler(apiHandle, 'give', ({ args }) => {
    closureHandle = args[0];
  });
  airlock.declare('Api', apiHandle);
  airlock.onGrantRequest = (identifier) => {
    const grant = airlock.membrane.createGrant(identifier);
    grant.add(apiHandle);
    return { approved: true, grant };
  };

  session.parse(`
    grant ("callback-first", "callback-second") {
      Api.give(() => 42)
    }
  `);
  const result = session.run(0, 10000);
  assertEquals(result.status, 'done');
  assert(closureHandle !== null, 'host captured grouped-grant closure');
  return { session, closureHandle };
}

// =============================================================================
// Wrapper basics
// =============================================================================

Deno.test("ClosureHandle: registerClosure returns a wrapper backed by the SAB", () => {
  const { handle } = captureClosure();

  assert(isClosureHandle(handle));
  assert(handle instanceof ClosureHandle);
  assertEquals(handle.slot, 0);
  assertEquals(handle.version, 1);
  assert(handle.closurePointer !== 0, 'closure pointer should be non-zero');
});

Deno.test("ClosureHandle: metadata round-trips via the value arena", () => {
  const { handle } = captureClosure('Api.give(() => 1)', 'subscriber');
  assertEquals(handle.metadata, { kind: 'subscriber' });
});

Deno.test("ClosureHandle: setClosureMetadata stamps metadata on auto-minted closure", () => {
  // The auto-marshal path registers closures with metadata=null. Hosts
  // call airlock.setClosureMetadata to stamp host-side annotations after
  // the fact, without losing the wrapper identity.
  const { airlock, handle } = captureClosure();
  assertEquals(handle.metadata, undefined,
    'auto-minted closure starts with no metadata');

  airlock.setClosureMetadata(handle, { kind: 'box-listener', boxName: 'inbox' });
  assertEquals(handle.metadata, { kind: 'box-listener', boxName: 'inbox' });
});

Deno.test("ClosureHandle: setClosureMetadata does not bump the wrapper version", () => {
  // Hosts retain wrappers in long-lived dispatch maps. Bumping the version on
  // metadata change would invalidate every existing reference;
  // setClosureMetadata enriches the wrapper rather than replacing it.
  const { airlock, handle } = captureClosure();
  const versionBefore = handle.version;
  airlock.setClosureMetadata(handle, { kind: 'a' });
  assertEquals(handle.version, versionBefore);
  airlock.setClosureMetadata(handle, { kind: 'b' });
  assertEquals(handle.version, versionBefore);
  // The wrapper still works for invocation/drop after metadata changes.
  airlock.dropClosureHandle(handle);
});

Deno.test("ClosureHandle: setClosureMetadata can overwrite existing metadata", () => {
  const { airlock, handle } = captureClosure('Api.give(() => 1)', 'subscriber');
  assertEquals(handle.metadata, { kind: 'subscriber' });

  airlock.setClosureMetadata(handle, { kind: 'subscriber', boxName: 'inbox' });
  assertEquals(handle.metadata, { kind: 'subscriber', boxName: 'inbox' });
});

Deno.test("ClosureHandle: setClosureMetadata accepts null to clear", () => {
  const { airlock, handle } = captureClosure('Api.give(() => 1)', 'subscriber');
  assertEquals(handle.metadata, { kind: 'subscriber' });

  airlock.setClosureMetadata(handle, null);
  assertEquals(handle.metadata, undefined);
});

Deno.test("ClosureHandle: setClosureMetadata throws on stale wrapper", () => {
  const { airlock, handle } = captureClosure();
  airlock.dropClosureHandle(handle);

  assertThrows(
    () => airlock.setClosureMetadata(handle, { kind: 'too-late' }),
    StaleClosureHandleError,
  );
});

Deno.test("ClosureHandle: setClosureMetadata stamping survives snapshot/restore", () => {
  // The whole point of the API: stamp metadata on the host side, snapshot,
  // restore, and read the metadata back on the new session via
  // enumerateClosureHandles. Hosts use this path for capability
  // reattachment after snapshot and restart.
  const original = freshSession();
  const { airlock } = original;

  let capturedHandle = null;
  const apiHandle = airlock.register({});
  airlock.setHandler(apiHandle, 'subscribe', ({ args }) => {
    capturedHandle = args[0];
    return undefined;
  });
  airlock.declare('Api', apiHandle);
  const root = airlock.createRootGrant('app');
  root.add(apiHandle);

  original.parse('Api.subscribe(() => 42)');
  original.run(0, 10000);
  assert(capturedHandle !== null);

  // Stamp metadata after the auto-marshal path returned the wrapper.
  airlock.setClosureMetadata(capturedHandle, {
    kind: 'box-listener',
    boxName: 'inbox',
  });

  const snap = snapshotSession(original);

  const restored = restoreSession(snap.vatBytes, snap.membraneBytes);

  const list = restored.airlock.membrane.enumerateClosureHandles();
  assertEquals(list.length, 1);
  assertEquals(list[0].metadata, {
    kind: 'box-listener',
    boxName: 'inbox',
  });
});

Deno.test("ClosureHandle: stale wrapper throws StaleClosureHandleError", () => {
  const { airlock, handle } = captureClosure();
  airlock.dropClosureHandle(handle);

  // The wrapper's slot has been freed and version bumped. Any operation
  // that validates the wrapper throws.
  assertThrows(
    () => airlock.dropClosureHandle(handle),
    StaleClosureHandleError,
  );
});

Deno.test("ClosureHandle: callback context reports captured grant identifiers", () => {
  const { session, closureHandle } = captureGroupedGrantClosure();
  const callbackSlot = session.memoryImage.allocateContext();
  session.airlock.setupCallbackContext(callbackSlot, closureHandle, []);

  assertEquals(
    session.airlock.getActiveGrantIdentifiers(callbackSlot),
    ["callback-first", "callback-second"],
  );
  session.memoryImage.freeContext(callbackSlot);
});

Deno.test("ClosureHandle: restored callback context reports captured grant identifiers", () => {
  const { session: original } = captureGroupedGrantClosure();
  const snapshot = snapshotSession(original);
  const restored = restoreSession(snapshot.vatBytes, snapshot.membraneBytes);
  const [{ closureHandle }] = restored.airlock.enumerateClosureHandles();
  const callbackSlot = restored.memoryImage.allocateContext();
  restored.airlock.setupCallbackContext(callbackSlot, closureHandle, []);

  assertEquals(
    restored.airlock.getActiveGrantIdentifiers(callbackSlot),
    ["callback-first", "callback-second"],
  );
  restored.memoryImage.freeContext(callbackSlot);
});

// =============================================================================
// End-to-end snapshot/restore: drone-registered callback survives
// =============================================================================

Deno.test("ClosureHandle: drone-registered callback survives snapshot/restore and fires", () => {
  // The whole point of slice 3.5: a drone passes a closure to the host,
  // we snapshot, we restore in a fresh session, and the host can still
  // fire that closure with its original captured scope.
  const original = freshSession();
  const { airlock } = original;

  let capturedHandleSlot = null;
  const apiHandle = airlock.register({});
  airlock.setHandler(apiHandle, 'subscribe', ({ args }) => {
    capturedHandleSlot = args[0].slot;
    return undefined;
  });
  airlock.declare('Api', apiHandle);
  const root = airlock.createRootGrant('app');
  root.add(apiHandle);

  // Drone code passes a closure that returns 42.
  original.parse('Api.subscribe(() => 42)');
  original.run(0, 10000);
  assert(capturedHandleSlot !== null, 'host captured closure handle');

  const snap = snapshotSession(original);

  // Restore in a fresh session.
  const restored = restoreSession(snap.vatBytes, snap.membraneBytes);
  // Re-bind the impl on the Api handle (host's responsibility per Q5).
  restored.airlock.membrane._bindImpl(apiHandle.slot, {});

  // Walk the closure handles surviving the restore.
  const closures = restored.airlock.enumerateClosureHandles();
  assertEquals(closures.length, 1);
  assertEquals(closures[0].closureHandle.slot, capturedHandleSlot);
  // Pointer was preserved (heap snapshot kept the closure alive at its slot).
  assert(closures[0].closurePointer !== 0);

  // Fire the surviving callback. It must produce 42.
  const closureHandle = closures[0].closureHandle;
  const slot = restored.memoryImage.allocateContext();
  restored.airlock.setupCallbackContext(slot, closureHandle, []);

  let returnValue;
  while (true) {
    const result = restored.airlock.runContext(slot, 1000);
    if (result.status === 'done') {
      returnValue = restored.airlock.extractResultFromContext(slot);
      restored.memoryImage.freeContext(slot);
      break;
    }
    throw new Error(`unexpected status: ${result.status}`);
  }
  assertEquals(returnValue, 42);
});

Deno.test("ClosureHandle: captured grants survive snapshot/restore", () => {
  const original = freshSession();
  const { airlock } = original;

  const apiHandle = airlock.register({});
  airlock.setHandler(apiHandle, 'subscribe', () => {});
  airlock.declare('Api', apiHandle);

  let theGrant = null;
  airlock.onGrantRequest = (id) => {
    theGrant = airlock.membrane.createGrant(id);
    theGrant.add(apiHandle);
    return { approved: true, grant: theGrant };
  };

  // Closure registered inside `grant "fs" { ... }` should capture grant for "fs".
  original.parse('grant "fs" { Api.subscribe(() => 99) }');
  original.run(0, 10000);

  const snap = snapshotSession(original);
  const restored = restoreSession(snap.vatBytes, snap.membraneBytes);

  const closures = restored.airlock.enumerateClosureHandles();
  assertEquals(closures.length, 1);
  // Captured grant slot for "fs" round-tripped via the SAB inverse-index.
  assert(closures[0].capturedGrantSlots.has(theGrant.slot),
    'captured grant slot survived restore');

  // The grant itself is still in the SAB at the same slot with the same identifier.
  const restoredGrant = restored.airlock.membrane.grantForSlot(theGrant.slot);
  assertEquals(restoredGrant.identifier, 'fs');
});

Deno.test("ClosureHandle: callback after restore runs under captured grants (authorization works)", () => {
  // The most stringent test: a drone registers a callback inside a grant
  // block where the callback itself calls a guarded API. After restore,
  // firing the callback must succeed because the captured grant slot still
  // authorizes the inner call.
  const original = freshSession();
  const { airlock } = original;

  let capturedClosureHandleSlot = null;
  const apiHandle = airlock.register({});
  airlock.setHandler(apiHandle, 'subscribe', ({ args }) => {
    capturedClosureHandleSlot = args[0].slot;
  });
  airlock.setHandler(apiHandle, 'getValue', () => 99);
  airlock.declare('Api', apiHandle);

  let approvedGrant = null;
  airlock.onGrantRequest = (id) => {
    approvedGrant = airlock.membrane.createGrant(id);
    approvedGrant.add(apiHandle);
    return { approved: true, grant: approvedGrant };
  };

  // The callback closes over the grant for "fs" + uses Api.getValue inside.
  original.parse(`
    let result = 0;
    grant "fs" {
      Api.subscribe(() => { result = Api.getValue(); });
    }
  `);
  original.run(0, 10000);

  const snap = snapshotSession(original);
  const restored = restoreSession(snap.vatBytes, snap.membraneBytes);
  // Re-bind handlers (host's responsibility post-restore).
  restored.airlock.membrane._bindImpl(apiHandle.slot, {});
  const restoredApi = restored.airlock.membrane.handleForSlot(apiHandle.slot);
  restored.airlock.setHandler(restoredApi, 'getValue', () => 99);

  // Fire the surviving callback.
  const closures = restored.airlock.enumerateClosureHandles();
  assertEquals(closures.length, 1);
  const closureHandle = closures[0].closureHandle;
  const slot = restored.memoryImage.allocateContext();
  restored.airlock.setupCallbackContext(slot, closureHandle, []);

  while (true) {
    const r = restored.airlock.runContext(slot, 1000);
    if (r.status === 'done') {
      restored.memoryImage.freeContext(slot);
      break;
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

  assertEquals(restored.get(0, 'result'), 99,
    'callback ran under captured "fs" grant — Api.getValue authorized');
});

// =============================================================================
// Heap GC: closure pointer stays valid
// =============================================================================

Deno.test("ClosureHandle: closure pointer is rewritten after heap GC moves the closure", () => {
  const { session, airlock, handle } = captureClosure();
  const { collector } = session;

  const beforePtr = handle.closurePointer;
  // Force a GC. Closure is a root (in airlock.getClosureRoots), so it
  // survives and may move. updateClosurePointers (now backed by
  // membrane.updateClosurePointersAfterGC) rewrites the SAB pointer.
  const result = collector.collect(airlock.getClosureRoots());
  airlock.updateClosurePointers(result.forwarding);

  const afterPtr = handle.closurePointer;
  assert(afterPtr !== 0, 'closure pointer must remain valid after GC');
  // Whether or not the pointer moved, the wrapper still resolves it
  // correctly (read via SAB, post-rewrite).
  if (result.forwarding.has(beforePtr)) {
    assertEquals(afterPtr, result.forwarding.get(beforePtr),
      'SAB pointer was rewritten to the new heap location');
  } else {
    assertEquals(afterPtr, beforePtr,
      'SAB pointer unchanged when closure didn\'t move');
  }
});

// =============================================================================
// Lazy reclamation
// =============================================================================

Deno.test("ClosureHandle: dropClosureHandle frees the slot immediately", () => {
  const { airlock, handle } = captureClosure();
  assertEquals(airlock.enumerateClosureHandles().length, 1);

  airlock.dropClosureHandle(handle);
  assertEquals(airlock.enumerateClosureHandles().length, 0);
});

Deno.test("ClosureHandle: compaction does NOT free closure-handle slots (lazy)", () => {
  const { airlock, handle } = captureClosure('Api.give(() => 1)', 'subscriber');

  airlock.compactMembrane();
  // Closure handle slot still alive — lazy reclamation says compaction
  // doesn't touch them.
  const list = airlock.enumerateClosureHandles();
  assertEquals(list.length, 1);
  assertEquals(list[0].metadata, { kind: 'subscriber' });
  assertEquals(list[0].closureHandle.slot, handle.slot);
});

Deno.test("ClosureHandle: compaction reclaims orphaned arena bytes from re-encoded metadata", () => {
  // Allocate two closure handles with metadata; compaction should preserve
  // both, repacking their metadata into the fresh arena.
  const { session, airlock } = captureClosure('Api.give(() => 1)', 'one');
  // Capture a second one (uses a fresh closure expression).
  let secondHandle = null;
  airlock.setHandler(
    session.airlock.membrane.handleForSlot(0),  // Api handle was at slot 0
    'give',
    ({ args }) => {
      secondHandle = args[0];
      // Attach metadata via the same trick.
      const cp = secondHandle.closurePointer;
      const captured = secondHandle.capturedGrantSlots;
      airlock.dropClosureHandle(secondHandle);
      secondHandle = airlock.membrane.registerClosureHandle(cp, captured, { kind: 'two' });
      airlock.closureRegistry.register(secondHandle, secondHandle.slot);
    },
  );
  session.parse('Api.give(() => 2)');
  session.run(0, 10000);

  const beforeArena = airlock.membraneStats().valueArenaUsed;
  airlock.compactMembrane();
  const afterArena = airlock.membraneStats().valueArenaUsed;

  // Arena re-encoded; usage may stay similar (live bytes only) but is bounded.
  assert(afterArena <= beforeArena, 'arena should not grow on compaction');

  const list = airlock.enumerateClosureHandles();
  assertEquals(list.length, 2);
  const kinds = list.map(e => e.metadata.kind).sort();
  assertEquals(kinds, ['one', 'two']);
});

// =============================================================================
// Linked promises: orphaned on restore
// =============================================================================

Deno.test("Linked promise: pending at snapshot time → rejected on restore (SS Promise transitions to REJECTED)", () => {
  const original = freshSession();
  const { airlock } = original;

  // Drone calls a host method that returns a JS Promise. The marshaller
  // detects the Promise and links it as an SS Promise (registered in the
  // SAB linked-promise table). The original JS Promise NEVER settles —
  // we want it still pending at snapshot time.
  const apiHandle = airlock.register({});
  airlock.setHandler(apiHandle, 'fetch', () => new Promise(() => {}));
  airlock.declare('Api', apiHandle);
  const root = airlock.createRootGrant('app');
  root.add(apiHandle);

  // Drone stores the linked promise in a global so we can inspect it after
  // restore.
  original.parse(`let p = Api.fetch();`);
  original.run(0, 10000);

  assert(original.airlock.linkedPromiseCount() > 0,
    'a linked promise should be in flight at snapshot time');

  const snap = snapshotSession(original);

  // Restore in a fresh session. createSession no longer auto-rejects;
  // the embedder owns the post-restore policy. Here we mimic the
  // "blanket reject" embedder by calling rejectOrphanedLinkedPromises
  // explicitly, which is the contract for callers with no correlation
  // state of their own.
  const restored = restoreSession(snap.vatBytes, snap.membraneBytes);
  restored.airlock.rejectOrphanedLinkedPromises();

  // The linked-promise table is cleared post-rejection.
  assertEquals(restored.airlock.linkedPromiseCount(), 0);

  // The SS Promise the drone stored as `p` was the one that was orphaned.
  // Its status should now be REJECTED with a SnapshotOrphanedError-shaped value.
  const p = restored.get(0, 'p');
  assertEquals(p._type, 28); // TYPE.PROMISE
  // Inspect the SS Promise via memoryImage. Its value field should hold an
  // Error with the orphan message.
  const promiseDataPointer = p._dataLo + 8;  // dataLo is header pointer; +8 for GC header
  const status = restored.memoryImage.getPromiseStatus(promiseDataPointer);
  // PROMISE_STATUS_REJECTED == 2 (per src/fuel/constants.js)
  assertEquals(status, 2, 'restored linked-promise should be REJECTED');
});

Deno.test("Linked promise: drone catches the rejection on next run", () => {
  // End-to-end: the drone's .catch handler fires on the next session.run
  // after restore, observing the SnapshotOrphanedError.
  const original = freshSession();
  const { airlock } = original;
  const apiHandle = airlock.register({});
  airlock.setHandler(apiHandle, 'fetch', () => new Promise(() => {}));
  airlock.declare('Api', apiHandle);
  const root = airlock.createRootGrant('app');
  root.add(apiHandle);

  original.parse(`
    let result = "none";
    let p = Api.fetch();
    p.then(v => { result = "ok:" + v; })
     .catch(e => { result = "rejected:" + e.message; });
  `);
  original.run(0, 10000);
  assertEquals(original.airlock.linkedPromiseCount(), 1);

  const snap = snapshotSession(original);
  const restored = restoreSession(snap.vatBytes, snap.membraneBytes);
  // Embedder explicitly rejects orphans — sandscript no longer does this
  // automatically (the embedder owns the policy).
  restored.airlock.rejectOrphanedLinkedPromises();

  // The .catch handler is in the generation-bearing wake queue — drive it.
  const readyContexts =
    restored.airlock.drainPendingSpawnedContextIdentities();
  for (const identity of readyContexts) {
    while (true) {
      const result = restored.airlock.runContext(identity.slot, 1000);
      if (result.status === 'done'
          || result.status === 'paused'
          || result.status === 'error') break;
      if (result.status === 'async_complete') {
        const { waiters } =
          restored.airlock.handleAsyncComplete(identity.slot);
        if (waiters) readyContexts.push(...waiters);
        break;
      }
      if (result.status === 'async_rejected') {
        const { waiters } =
          restored.airlock.handleAsyncRejected(identity.slot);
        if (waiters) readyContexts.push(...waiters);
        break;
      }
    }
  }

  const result = restored.get(0, 'result');
  assert(typeof result === 'string' && result.startsWith('rejected:'),
    `expected rejected:..., got ${JSON.stringify(result)}`);
  assert(result.includes('orphaned'),
    `error message should mention "orphaned", got: ${result}`);
});

Deno.test("Linked promise: restored session preserves table verbatim when embedder does NOT reject", () => {
  // The new contract: createSession does not auto-reject orphans.
  // An embedder that wants to keep linked promises around (e.g. to
  // settle them from its own correlation table) gets them back intact.
  const original = freshSession();
  const { airlock } = original;
  const apiHandle = airlock.register({});
  airlock.setHandler(apiHandle, 'fetch', () => new Promise(() => {}));
  airlock.declare('Api', apiHandle);
  const root = airlock.createRootGrant('app');
  root.add(apiHandle);

  original.parse(`let p = Api.fetch();`);
  original.run(0, 10000);
  assertEquals(original.airlock.linkedPromiseCount(), 1);

  const snap = snapshotSession(original);
  const restored = restoreSession(snap.vatBytes, snap.membraneBytes);

  // Embedder did NOT call rejectOrphanedLinkedPromises. The table is
  // intact and the SS promise is still pending.
  assertEquals(restored.airlock.linkedPromiseCount(), 1,
    'linked promise table should be preserved verbatim post-restore');
  const p = restored.get(0, 'p');
  const promiseDataPointer = p._dataLo + 8;
  const status = restored.memoryImage.getPromiseStatus(promiseDataPointer);
  assertEquals(status, 0, 'SS promise should still be PENDING (status 0)');
});

Deno.test("SnapshotOrphanedError: class is exported and is an Error", () => {
  const err = new SnapshotOrphanedError();
  assertEquals(err.name, 'SnapshotOrphanedError');
  assert(err instanceof Error);
});

// =============================================================================
// Format version check
// =============================================================================

// =============================================================================
// Wrapper identity (cache)
// =============================================================================

Deno.test("ClosureHandle: enumerateClosureHandles returns the same wrapper identity across calls", () => {
  const { airlock } = captureClosure();

  const list1 = airlock.enumerateClosureHandles();
  const list2 = airlock.enumerateClosureHandles();
  assertEquals(list1.length, 1);
  assertEquals(list2.length, 1);
  // Same JS object identity — the cache returned the previously-minted
  // wrapper instead of a fresh one.
  assert(list1[0].closureHandle === list2[0].closureHandle,
    'subsequent enumerate calls must return the same wrapper identity');
  // First call mints a new wrapper (or returns the one from registerClosure);
  // second call hits the cache.
  assertEquals(list2[0].isNewWrapper, false);
});

Deno.test("ClosureHandle: closureHandleForSlot returns the same identity as enumerateClosureHandles", () => {
  const { airlock } = captureClosure();
  const fromEnum = airlock.enumerateClosureHandles()[0].closureHandle;
  const fromForSlot = airlock.membrane.closureHandleForSlot(fromEnum.slot);
  assert(fromEnum === fromForSlot,
    'closureHandleForSlot must return the cached wrapper identity');
});

Deno.test("Snapshot carries the current parked-context generation format", () => {
  const session = freshSession();
  const bytes = snapshotSession(session).membraneBytes;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  assertEquals(view.getUint32(4, true), DRONE_FORMAT_VERSION);
});

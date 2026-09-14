/**
 * Slice 4: handler re-registration contract.
 *
 * Verifies the four-step host contract documented on the Airlock class:
 *   1. Walk surviving entries via enumerateHandles / enumerateGrants /
 *      enumerateClosureHandles.
 *   2. Dispatch each entry to host setup code (typically keyed on
 *      metadata.kind).
 *   3. Re-bind via _bindImpl + setHandler/setHandlers/setGetter.
 *   4. Resume drone execution.
 *
 * Also verifies the loud-failure case: drone code calling a handler the
 * host forgot to re-register throws TypeError with a descriptive message.
 *
 * No new APIs in this slice — every method used here predates slice 4.
 *
 * Run with: deno task test tests/membrane/restore_contract_test.js
 */

import { assertEquals, assertThrows, assert } from "https://deno.land/std@0.208.0/assert/mod.ts";
import { createSession } from '../../src/fuel/session.js';
import { freshSession, restoreSession, snapshotSession } from '../../src/host-owned-session.js';

// =============================================================================
// Helper: a "host" with a tiny dispatch table keyed on metadata.kind
//
// Each handle's metadata declares a kind with a corresponding host setup
// function. The same function runs for fresh setup and restore; only the handle
// source differs (`register()` when fresh, `enumerateHandles()` after restore).
// =============================================================================

function buildHostSetup() {
  // Each kind has: a JS impl factory + handler/getter installers.
  // Impl is constructed fresh per call so original and restored sessions
  // get separate state — this matches the realistic case where a restored
  // session is in a fresh worker with its own JS heap. The installers
  // close over the impl returned by makeImpl so each session's handlers
  // see their own counter / namedThings.
  const kinds = {
    counter: {
      makeImpl: () => ({ value: 0 }),
      install: (airlock, handle, impl) => {
        airlock.setHandlers(handle, {
          inc: () => ++impl.value,
          dec: () => --impl.value,
          read: () => impl.value,
        });
        airlock.setGetter(handle, 'value', () => impl.value);
      },
    },
    namedThings: {
      makeImpl: () => new Map(),
      install: (airlock, handle, impl) => {
        airlock.setHandlers(handle, {
          add: ({ args }) => {
            const [name, age] = args;
            impl.set(name, { name, age });
            return name;
          },
          get: ({ args }) => impl.get(args[0]) ?? null,
          count: () => impl.size,
        });
      },
    },
  };

  // Fresh-session setup: register a handle of each kind, declare it, install
  // handlers via the same `install()` the restore path uses.
  function freshSetup(session) {
    for (const [kind, spec] of Object.entries(kinds)) {
      const impl = spec.makeImpl();
      const handle = session.airlock.register(impl, { kind });
      session.airlock.declare(declarationFor(kind), handle);
      // Authorize via a root grant (so drone code can reach it without grants).
      const root = session.airlock.createRootGrant(`root-${kind}`);
      root.add(handle);
      spec.install(session.airlock, handle, impl);
    }
  }

  // Restore-time setup: walk enumerateHandles, dispatch each to its
  // installer, attach a fresh impl. No `register()` calls.
  function restoreSetup(session) {
    for (const entry of session.airlock.membrane.enumerateHandles()) {
      const kind = entry.metadata?.kind;
      const spec = kinds[kind];
      if (!spec) continue;  // unknown kind — host policy decides; here we skip
      const impl = spec.makeImpl();
      session.airlock.membrane._bindImpl(entry.handle.slot, impl);
      spec.install(session.airlock, entry.handle, impl);
    }
  }

  function declarationFor(kind) {
    return kind === 'counter' ? 'Counter' : 'Things';
  }

  return { freshSetup, restoreSetup, kinds, declarationFor };
}

// =============================================================================
// Round-trip: full multi-handler restore
// =============================================================================

Deno.test("Restore contract: multi-handler/getter session round-trips correctly", () => {
  const host = buildHostSetup();

  const original = freshSession();
  host.freshSetup(original);

  // Exercise everything in the original session.
  original.parse(`
    Counter.inc();
    Counter.inc();
    Counter.inc();
    Things.add("a", 10);
    Things.add("b", 20);
    let counterVia = Counter.read();
    let getterVia = Counter.value;
    let thingsCount = Things.count();
    let aThing = Things.get("a");
  `);
  original.run(0, 100000);

  assertEquals(original.get(0, 'counterVia'), 3);
  assertEquals(original.get(0, 'getterVia'), 3);
  assertEquals(original.get(0, 'thingsCount'), 2);
  assertEquals(original.get(0, 'aThing'), { name: 'a', age: 10 });

  // Snapshot.
  const snap = snapshotSession(original);

  // Restore. Per the contract: enumerateHandles → re-bind → resume.
  const restored = restoreSession(snap.vatBytes, snap.membraneBytes);
  host.restoreSetup(restored);

  // Run NEW drone code that uses every handler/getter to confirm full
  // dispatch works after restore. The host appends new code via parse(),
  // then seeks the context to the new startIndex — without seeking, run
  // would re-execute the original program from instruction 0 and fail
  // on redeclarations. (This is a host-loop concern, not a slice-4
  // concern; documented here for clarity.)
  const parseResult = restored.parse(`
    Counter.inc();
    Counter.inc();
    Things.add("c", 30);
    let cVia2 = Counter.read();
    let cGetter2 = Counter.value;
    let count2 = Things.count();
    let cThing2 = Things.get("c");
  `);
  restored.setInstruction(0, parseResult.startIndex);
  const result = restored.run(0, 100000);
  assertEquals(result.status, 'done',
    `restored run should succeed; got ${JSON.stringify(result)}`);

  // Counter started fresh in restoreSetup, so 0 + 2 inc = 2.
  assertEquals(restored.get(0, 'cVia2'), 2);
  assertEquals(restored.get(0, 'cGetter2'), 2);
  assertEquals(restored.get(0, 'count2'), 1);
  assertEquals(restored.get(0, 'cThing2'), { name: 'c', age: 30 });
});

Deno.test("Restore contract: setHandlers + setGetter both round-trip via the same setup code", () => {
  // The point: the host's setup function is called identically in fresh and
  // restore paths. If setHandlers and setGetter both work post-restore, the
  // contract holds.
  const host = buildHostSetup();
  const original = freshSession();
  host.freshSetup(original);
  original.parse(`Counter.inc(); let v1 = Counter.read(); let g1 = Counter.value;`);
  original.run(0, 10000);
  assertEquals(original.get(0, 'v1'), 1);
  assertEquals(original.get(0, 'g1'), 1);

  const snap = snapshotSession(original);
  const restored = restoreSession(snap.vatBytes, snap.membraneBytes);
  host.restoreSetup(restored);

  // Both method dispatch and getter dispatch work post-restore.
  const pr = restored.parse(`Counter.inc(); let v3 = Counter.read(); let g3 = Counter.value;`);
  restored.setInstruction(0, pr.startIndex);
  const r = restored.run(0, 10000);
  assertEquals(r.status, 'done', `restored run should succeed; got ${JSON.stringify(r)}`);
  assertEquals(restored.get(0, 'v3'), 1);  // fresh counter via restoreSetup
  assertEquals(restored.get(0, 'g3'), 1);
});

// =============================================================================
// Loud-failure: forgetting to re-register is observable as a thrown TypeError
// =============================================================================

Deno.test("Restore contract: missing handler throws TypeError with declared name + method", () => {
  const host = buildHostSetup();
  const original = freshSession();
  host.freshSetup(original);
  original.parse(`Counter.inc();`);
  original.run(0, 10000);

  const snap = snapshotSession(original);
  const restored = restoreSession(snap.vatBytes, snap.membraneBytes);

  // Skip the restore setup for Counter on purpose. Re-bind the impl and
  // install only some handlers — but not 'inc'.
  for (const entry of restored.airlock.membrane.enumerateHandles()) {
    if (entry.metadata?.kind !== 'counter') continue;
    restored.airlock.membrane._bindImpl(entry.handle.slot, { value: 0 });
    restored.airlock.setHandler(entry.handle, 'read', () => 999);
    // Deliberately NOT re-registering 'inc'.
  }

  // Drone calls Counter.inc() — should throw TypeError, observable via try/catch.
  const pr = restored.parse(`
    let caught = "";
    try {
      Counter.inc();
    } catch (e) {
      caught = e.name + ":" + e.message;
    }
  `);
  restored.setInstruction(0, pr.startIndex);
  restored.run(0, 10000);
  const caught = restored.get(0, 'caught');
  assert(caught.startsWith('TypeError:'),
    `expected TypeError, got: ${caught}`);
  assert(caught.includes('Counter'),
    `error should mention declared name 'Counter', got: ${caught}`);
  assert(caught.includes('inc'),
    `error should mention method name 'inc', got: ${caught}`);
});

Deno.test("Restore contract: missing direct-call handler throws 'is not directly callable'", () => {
  const original = freshSession();
  const callable = airlockHandlerOnly(original);
  original.parse(`callable()`);
  original.run(0, 10000);
  // (Sanity: no error in original.)

  const snap = snapshotSession(original);
  const restored = restoreSession(snap.vatBytes, snap.membraneBytes);

  // Re-bind impl but DON'T re-register the direct handler.
  for (const entry of restored.airlock.membrane.enumerateHandles()) {
    restored.airlock.membrane._bindImpl(entry.handle.slot, () => {});
    // No setHandler call.
  }

  const pr = restored.parse(`
    let caught = "";
    try {
      callable();
    } catch (e) {
      caught = e.name + ":" + e.message;
    }
  `);
  restored.setInstruction(0, pr.startIndex);
  restored.run(0, 10000);
  const caught = restored.get(0, 'caught');
  assert(caught.startsWith('TypeError:'), `expected TypeError, got: ${caught}`);
  assert(caught.includes('directly callable') || caught.includes('not'),
    `expected 'not directly callable' message, got: ${caught}`);
});

Deno.test("Restore contract: missing getter falls through to method-binding (does NOT throw)", () => {
  // Document an asymmetry between method handlers and getters: a missing
  // getter does NOT throw — it falls through to the legacy method-binding
  // behavior so older drones that read `obj.foo` as a method binding still
  // work. Hosts that rely on getters specifically should re-register them
  // carefully; the airlock won't catch a missed getter the way it catches
  // a missed method handler.
  const original = freshSession();
  const counter = { value: 7 };
  const handle = original.airlock.register(counter, { kind: 'counter' });
  original.airlock.declare('Counter', handle);
  const root = original.airlock.createRootGrant('app');
  root.add(handle);
  original.airlock.setGetter(handle, 'value', () => counter.value);
  // Sanity: getter works in the original.
  original.parse(`let v = Counter.value;`);
  original.run(0, 10000);
  assertEquals(original.get(0, 'v'), 7);

  const snap = snapshotSession(original);
  const restored = restoreSession(snap.vatBytes, snap.membraneBytes);
  // Re-bind impl but DON'T re-register the getter.
  for (const entry of restored.airlock.membrane.enumerateHandles()) {
    if (entry.metadata?.kind === 'counter') {
      restored.airlock.membrane._bindImpl(entry.handle.slot, { value: 99 });
    }
  }

  // Reading Counter.value falls through to method-binding (does not throw).
  // The drone gets back a TYPE_EXTERNAL_METHOD-shaped value.
  const pr = restored.parse(`
    let result = "ok";
    try {
      let bound = Counter.value;  // missing getter — falls through, no throw
    } catch (e) {
      result = "threw:" + e.name;
    }
  `);
  restored.setInstruction(0, pr.startIndex);
  const r = restored.run(0, 10000);
  assertEquals(r.status, 'done',
    `restored run should succeed (no throw); got ${JSON.stringify(r)}`);
  assertEquals(restored.get(0, 'result'), 'ok',
    'missing getter must NOT throw — falls through to method-binding semantics');
});

function airlockHandlerOnly(session) {
  // Helper for the direct-call test: register a handle with a null-method
  // direct handler.
  const impl = () => 42;
  const handle = session.airlock.register(impl, { kind: 'direct' });
  session.airlock.declare('callable', handle);
  const root = session.airlock.createRootGrant('root-direct');
  root.add(handle);
  session.airlock.setHandler(handle, null, impl);
  return handle;
}

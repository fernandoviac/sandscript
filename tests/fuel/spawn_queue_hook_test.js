/**
 * Tests for `airlock.onPendingSpawnedContexts` — the readiness
 * notification hook fired when sandscript pushes context slots onto
 * `pendingSpawnedContexts`.
 *
 * Background: SandScript is passive during JS event-loop pauses. When
 * a linked JS Promise resolves and produces drone slots ready to
 * resume, sandscript pushes those slots into `pendingSpawnedContexts`
 * but cannot run them itself — only the host can drive `session.run`
 * again.
 *
 * Without a notification, every host-side promise source has to
 * remember to schedule its own drain after the promise settles, or
 * poll the queue. The hook lets the host install a single drain
 * trigger at airlock construction time, and every push site fires it
 * automatically.
 *
 * The hook fires synchronously after the push, in the same microtask
 * the push happens in. That way the host's drain runs before any
 * other code observes the new entries — no risk of out-of-order
 * draining, no need for the host to debounce.
 */

import { assertEquals, assert } from "https://deno.land/std@0.208.0/assert/mod.ts";
import { createSession } from '../../src/fuel/session.js';
import { parseAndSetup } from './test-helpers.js';
import { freshSession } from '../../src/host-owned-session.js';

Deno.test("onPendingSpawnedContexts: fires when a linked JS Promise resolves", async () => {
  const session = freshSession();
  const airlock = session.airlock;

  // The host installs the hook once. Every future spawn-push from
  // sandscript will call it.
  let hookCalls = 0;
  airlock.onPendingSpawnedContexts = () => {
    hookCalls += 1;
  };

  // Capability that returns a JS Promise; sandscript will park the
  // drone slot until it settles, then push the slot when it does.
  let resolveDeferred;
  const deferred = new Promise((resolve) => { resolveDeferred = resolve; });
  const handle = airlock.register({});
  airlock.setHandler(handle, null, () => deferred, { unwrapPromise: true });
  airlock.declare('asyncCall', handle);
  const grant = airlock.createRootGrant('test');
  grant.add(handle);

  parseAndSetup(session, `
    let result = asyncCall()
    result
  `);

  // First run: the slot calls asyncCall(), gets a Promise, suspends.
  // pendingSpawnedContexts is still empty; hook hasn't fired.
  await session.run(0, 1000);
  assertEquals(hookCalls, 0,
    "hook should not fire before the promise resolves");
  assertEquals(airlock.pendingSpawnedContexts?.length ?? 0, 0);

  // Settle the promise. SandScript's microtask callback pushes the
  // slot into the spawn queue and fires the hook.
  resolveDeferred(42);
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();

  assertEquals(hookCalls, 1,
    "hook should fire exactly once after the resolve microtask runs");
  assert((airlock.pendingSpawnedContexts?.length ?? 0) > 0,
    "the resumed slot should be in the spawn queue");
});

Deno.test("onPendingSpawnedContexts: does not fire when the queue push is empty", async () => {
  const session = freshSession();
  const airlock = session.airlock;

  let hookCalls = 0;
  airlock.onPendingSpawnedContexts = () => { hookCalls += 1; };

  // Run a synchronous program. No promise → no spawn-push → no hook.
  parseAndSetup(session, `1 + 2`);
  await session.run(0, 1000);

  assertEquals(hookCalls, 0,
    "hook should never fire when no spawned contexts are produced");
});

Deno.test("onPendingSpawnedContexts: hook is optional (null = silent push)", async () => {
  const session = freshSession();
  const airlock = session.airlock;
  // Deliberately do not set onPendingSpawnedContexts.
  // The push must still succeed; sandscript must not throw.

  let resolveDeferred;
  const deferred = new Promise((resolve) => { resolveDeferred = resolve; });
  const handle = airlock.register({});
  airlock.setHandler(handle, null, () => deferred, { unwrapPromise: true });
  airlock.declare('asyncCall', handle);
  const grant = airlock.createRootGrant('test');
  grant.add(handle);

  parseAndSetup(session, `asyncCall()`);
  await session.run(0, 1000);
  resolveDeferred('ok');
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();

  // No hook installed; queue still has the slot, ready for a polling
  // host to drain.
  assert((airlock.pendingSpawnedContexts?.length ?? 0) > 0,
    "spawn queue should be populated even without a hook");
});

Deno.test("onPendingSpawnedContexts: a host that drains inside the hook can resume immediately", async () => {
  const session = freshSession();
  const airlock = session.airlock;

  // This test exercises the canonical use: the hook drains the queue
  // and runs each ready slot to completion. The point is that no
  // explicit polling loop is needed in the host once the hook is
  // installed.
  const finishedSlots = [];
  airlock.onPendingSpawnedContexts = async () => {
    for (const slot of airlock.drainPendingSpawnedContextIdentities()) {
      await session.run(slot, 1000);
      finishedSlots.push(slot);
    }
  };

  let resolveDeferred;
  const deferred = new Promise((resolve) => { resolveDeferred = resolve; });
  const handle = airlock.register({});
  airlock.setHandler(handle, null, () => deferred, { unwrapPromise: true });
  airlock.declare('asyncCall', handle);
  const grant = airlock.createRootGrant('test');
  grant.add(handle);

  parseAndSetup(session, `asyncCall()`);
  await session.run(0, 1000);

  resolveDeferred(7);
  // Yield enough to let the microtask chain run the hook.
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();

  assert(finishedSlots.length > 0,
    "the hook-driven drain should have run at least one slot");
});

/**
 * runtime.invokeClosure tests.
 *
 * invokeClosure runs a registered SS closure on a fresh slot
 * and returns a Promise that resolves with the closure's return
 * value (or rejects on throw / error / runtime-terminate). Async
 * closures (anything that parks via await or context.suspend)
 * are supported transparently — the runtime owns the
 * wake-dispatch routing for the slot via _drainPendingSpawned's
 * branch on the _invokeWaiters registry.
 *
 * Pinned scenarios:
 *   - Sync closure returns its value.
 *   - Async closure (single await) returns through park/wake.
 *   - Multi-await closure survives multiple park-wake cycles.
 *   - Throwing closure rejects the Promise.
 *   - Closure that spawns an inner async function returns
 *     the awaited result.
 *   - dropOnComplete actually frees the closure handle.
 *   - Two invokeClosure calls in flight at once don't interfere.
 *   - Liveness check rejects when closure has been freed.
 *   - invokeClosure before start() rejects.
 *   - invokeClosure after terminate() rejects.
 *   - Concurrent scheduleClosureCall + invokeClosure don't cross.
 *   - Quiesce-while-parked defers settlement until resume.
 *
 * Settlement behavior:
 *   - Hard OOM inside a sync closure rejects with
 *     MemoryPressureError and frees the slot (dropOnComplete drops).
 *   - Hard OOM after an await (wake-time re-drive) rejects the same.
 *   - invokeClosure called while quiesced defers the whole setup and
 *     settles after resume().
 *   - A dispatchChild wake racing the quiesce tail is deferred and
 *     re-dispatched on resume() (not dropped).
 *   - A fuel-paused invoke slot re-driven via runtime.run(slot)
 *     settles the original Promise.
 *   - terminate() rejects parked invoke waiters.
 */

import { assertEquals, assert, assertRejects, assertThrows } from "https://deno.land/std@0.208.0/assert/mod.ts";
import { RuntimeBuilder } from '../../src/runtime/test-harness.js';

function tick(ms = 0) { return new Promise(r => setTimeout(r, ms)); }

async function waitFor(condition, { timeout = 2000, label = 'condition' } = {}) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    if (condition()) return;
    await tick(2);
  }
  throw new Error(`waitFor timed out: ${label}`);
}

/**
 * Capability fixture: a single Cap handle exposing every method
 * the invokeClosure tests need.
 *
 *   Cap.regSync(fn) / Cap.regAsync(fn) / Cap.regMulti(fn)
 *   Cap.regThrow(fn) / Cap.regSpawn(fn) / Cap.regSuspend(fn)
 *     — each stashes the SS closure handle into the captured map
 *       so the test can pass it to runtime.invokeClosure.
 *
 *   Cap.deferred(x)
 *     — returns a JS Promise that defers via setTimeout(0) and
 *       resolves with x * 10. Forces SS-side await to genuinely
 *       park.
 *
 *   Cap.echo(x)
 *     — synchronous identity; used by scheduleClosureCall paths.
 *
 *   Cap.notify(x)
 *     — synchronous; pushes x onto state.notifications. Used to
 *       observe side effects from scheduleClosureCall-fired
 *       closures.
 */
function capCap(captured) {
  return {
    name: 'cap',
    needs: {},
    setup(airlock) {
      const h = airlock.register({});
      airlock.setHandler(h, 'regSync',    ({ args }) => { captured.syncClosure    = args[0]; return 0; });
      airlock.setHandler(h, 'regAsync',   ({ args }) => { captured.asyncClosure   = args[0]; return 0; });
      airlock.setHandler(h, 'regMulti',   ({ args }) => { captured.multiClosure   = args[0]; return 0; });
      airlock.setHandler(h, 'regThrow',   ({ args }) => { captured.throwClosure   = args[0]; return 0; });
      airlock.setHandler(h, 'regSpawn',   ({ args }) => { captured.spawnClosure   = args[0]; return 0; });
      airlock.setHandler(h, 'regManual',  ({ args }) => { captured.manualClosure  = args[0]; return 0; });
      airlock.setHandler(h, 'regHog',     ({ args }) => { captured.hogClosure     = args[0]; return 0; });
      airlock.setHandler(h, 'regHogAfterAwait', ({ args }) => { captured.hogAfterAwaitClosure = args[0]; return 0; });
      airlock.setHandler(h, 'regBusy',    ({ args }) => { captured.busyClosure    = args[0]; return 0; });
      airlock.setHandler(h, 'regSpawnManual', ({ args }) => { captured.spawnManualClosure = args[0]; return 0; });

      airlock.setHandler(h, 'deferred', ({ args }) => {
        const x = args[0];
        return new Promise((resolve) => {
          setTimeout(() => resolve(x * 10), 0);
        });
      });
      airlock.setHandler(h, 'manual', ({ args }) => {
        // Returns a Promise whose resolver is exposed via
        // captured.manualResolvers. Test code can resolve it on
        // demand. Each call gets its own resolver entry.
        const x = args[0];
        return new Promise((resolve) => {
          captured.manualResolvers.push((v = x * 10) => resolve(v));
        });
      });
      airlock.setHandler(h, 'echo', ({ args }) => args[0]);
      airlock.setHandler(h, 'notify', ({ args }) => {
        captured.notifications.push(args[0]);
        return 0;
      });

      const grant = airlock.membrane.createGrant('cap');
      grant.add(h);
      airlock.declare('Cap', h);
      return {
        onGrantRequest(id) { return id === 'cap' ? grant : null; },
      };
    },
  };
}

async function buildRuntime(sessionOptions = null) {
  const captured = {
    syncClosure: null, asyncClosure: null, multiClosure: null,
    throwClosure: null, spawnClosure: null,
    manualClosure: null,
    hogClosure: null, hogAfterAwaitClosure: null, busyClosure: null,
    spawnManualClosure: null,
    notifications: [],
    manualResolvers: [],
    handlerErrors: [],
  };
  let builder = new RuntimeBuilder()
    .capability(capCap(captured))
    .onInboundMessage(() => {})
    .onHandlerError((rej) => { captured.handlerErrors.push(rej); });
  if (sessionOptions) builder = builder.sessionOptions(sessionOptions);
  const built = builder.build();
  const { runtime, session } = built;
  await runtime.start();

  // Register all closures via a single boot program.
  const result = session.parse(`
    let hogRetained = []
    let sharedValue = 42
    grant "cap" {
      Cap.regSync(function(x) { return x + 1 })
      Cap.regAsync(async function(x) {
        let y = await Cap.deferred(x)
        return y + 1
      })
      Cap.regMulti(async function(x) {
        let a = await Cap.deferred(x)
        let b = await Cap.deferred(a)
        let c = await Cap.deferred(b)
        return c
      })
      Cap.regThrow(function() { throw new Error("intentional") })
      Cap.regSpawn(async function(x) {
        let p = (async function() { return x * 100 })()
        let v = await p
        return v
      })
      Cap.regManual(async function(x) {
        let y = await Cap.manual(x)
        return y + 1
      })
      Cap.regHog(function(n) {
        let i = 0
        while (i < n) {
          hogRetained.push("hog-" + i + "-xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx")
          i = i + 1
        }
        return i
      })
      Cap.regHogAfterAwait(async function(n) {
        let y = await Cap.manual(0)
        let i = 0
        while (i < n) {
          hogRetained.push("hog-" + i + "-xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx")
          i = i + 1
        }
        return i
      })
      Cap.regBusy(function(n) {
        let i = 0
        while (i < n) { i = i + 1 }
        return i
      })
      Cap.regSpawnManual(async function(x) {
        let p = (async function() {
          let v = await Cap.manual(x)
          let i = 0
          while (i < 5000) { i = i + 1 }
          return v + i
        })()
        let out = await p
        return out
      })
    }
  `);
  session.setInstruction(0, result.startIndex);
  // Runtime grant requests always pass through runGrantFanout, which returns
  // a Promise even for a fully synchronous onGrantRequest hook, so the boot
  // program's
  // `grant "cap" { ... }` now genuinely suspends runtime.run(0) instead
  // of completing within a single drive episode. Slot 0 is a root slot;
  // its wake-up after suspension re-drives fire-and-forget, so poll for
  // the registrations to land instead of trusting a single awaited run.
  await runtime.run(0);
  await waitFor(() => captured.syncClosure !== null,
    { label: 'boot grant to resolve and registrations to run' });

  for (const k of ['syncClosure','asyncClosure','multiClosure','throwClosure','spawnClosure','manualClosure',
                   'hogClosure','hogAfterAwaitClosure','busyClosure','spawnManualClosure']) {
    assert(captured[k], `${k} not registered`);
  }
  return { ...built, runtime, session, captured };
}

// =============================================================================
// Happy-path scenarios
// =============================================================================

Deno.test('invokeClosure: sync closure returns its value', async () => {
  const { runtime, captured } = await buildRuntime();
  const r = await runtime.invokeClosure(captured.syncClosure, [7]);
  assertEquals(r, 8);
  await runtime.terminate();
});

Deno.test('invokeClosure: async closure (single await) returns through park/wake', async () => {
  const { runtime, captured } = await buildRuntime();
  const r = await runtime.invokeClosure(captured.asyncClosure, [5]);
  assertEquals(r, 51);
  await runtime.terminate();
});

Deno.test('invokeClosure: multi-await closure survives multiple park-wake cycles', async () => {
  const { runtime, captured } = await buildRuntime();
  const r = await runtime.invokeClosure(captured.multiClosure, [2]);
  // 2 → 20 → 200 → 2000
  assertEquals(r, 2000);
  await runtime.terminate();
});

Deno.test('invokeClosure: SS-level throw inside closure rejects the Promise with the error', async () => {
  const { runtime, captured } = await buildRuntime();
  let caught = null;
  try {
    await runtime.invokeClosure(captured.throwClosure, []);
  } catch (err) {
    caught = err;
  }
  assert(caught, 'expected throw');
  assertEquals(caught.name, 'UncaughtScriptError');
  assert(caught.message.includes('intentional'), `message should contain thrown value, got: ${caught.message}`);
  assertEquals(caught.scriptError.codeName, 'USER_THROW');
  await runtime.terminate();
});

Deno.test('invokeClosure: JS handler-throw inside closure fires onHandlerError AND rejects the Promise', async () => {
  // Pin the asymmetry: when an invoked closure calls a JS
  // capability handler that throws (the AttributedRejection
  // path), the embedder receives TWO signals:
  //   1. onHandlerError fires with the AttributedRejection
  //      (carrying the slot, the original cause, and the
  //      diagnostic snapshot captured at the throw).
  //   2. The returned Promise rejects with the cause.
  //
  // Both signals carry the same underlying error. The hook is
  // the global error pipeline; the Promise is the call-site
  // signal. Capabilities can react in both places safely.
  const captured = {
    syncClosure: null, asyncClosure: null, multiClosure: null,
    throwClosure: null, spawnClosure: null, manualClosure: null,
    handlerThrowClosure: null,
    notifications: [], manualResolvers: [], handlerErrors: [],
  };
  const { runtime, session } = new RuntimeBuilder()
    .capability({
      name: 'cap',
      needs: {},
      setup(airlock) {
        const h = airlock.register({});
        airlock.setHandler(h, 'regHandlerThrow', ({ args }) => {
          captured.handlerThrowClosure = args[0];
          return 0;
        });
        // Handler that throws back into SS. This is the JS-side
        // throw that the AttributedRejection path is designed for.
        airlock.setHandler(h, 'badHandler', () => {
          throw new TypeError('handler-throw boom');
        });
        const grant = airlock.membrane.createGrant('cap');
        grant.add(h);
        airlock.declare('Cap', h);
        return {
          onGrantRequest(id) { return id === 'cap' ? grant : null; },
        };
      },
    })
    .onInboundMessage(() => {})
    .onHandlerError((rej) => { captured.handlerErrors.push(rej); })
    .build();
  await runtime.start();

  const result = session.parse(`
    grant "cap" {
      Cap.regHandlerThrow(function() {
        // No try/catch — the JS handler throw propagates out
        // of the closure as the slot's terminal error.
        Cap.badHandler()
      })
    }
  `);
  session.setInstruction(0, result.startIndex);
  await runtime.run(0);
  await waitFor(() => captured.handlerThrowClosure !== null,
    { label: 'boot grant to resolve and registration to run' });
  assert(captured.handlerThrowClosure, 'closure not registered');

  let caught = null;
  try {
    await runtime.invokeClosure(captured.handlerThrowClosure, []);
  } catch (err) {
    caught = err;
  }
  assert(caught, 'expected Promise rejection');
  assertEquals(caught.name, 'UncaughtScriptError');
  assert(caught.message.includes('handler-throw boom'),
    `unexpected rejection message: ${caught.message}`);

  // onHandlerError fired with an AttributedRejection.
  assert(captured.handlerErrors.length >= 1, 'onHandlerError did not fire');
  const attr = captured.handlerErrors[0];
  assertEquals(attr.cause.message, 'handler-throw boom');
  // The AttributedRejection's slot is the closure's slot (not 0).
  assert(typeof attr.slot === 'number', 'attribution missing slot');
  // Diagnostic snapshot captured at-throw.
  assertEquals(attr.diagnostic.slot, attr.slot);

  await runtime.terminate();
});

Deno.test('invokeClosure: SS throw on async path (after await) rejects the Promise', async () => {
  // Surface specifically the case the user asked about: a closure
  // that PARKS on an await, then THROWS after waking. The throw
  // happens on a re-drive of the slot — _continueInvoke's terminal
  // path must surface it as a Promise rejection.
  const captured = {
    syncClosure: null, asyncClosure: null, multiClosure: null,
    throwClosure: null, spawnClosure: null, manualClosure: null,
    parkThenThrow: null,
    notifications: [], manualResolvers: [], handlerErrors: [],
  };
  const { runtime, session } = new RuntimeBuilder()
    .capability({
      name: 'cap',
      needs: {},
      setup(airlock) {
        const h = airlock.register({});
        airlock.setHandler(h, 'regParkThrow', ({ args }) => {
          captured.parkThenThrow = args[0];
          return 0;
        });
        airlock.setHandler(h, 'deferred', ({ args }) => {
          const x = args[0];
          return new Promise((resolve) => setTimeout(() => resolve(x * 10), 0));
        });
        const grant = airlock.membrane.createGrant('cap');
        grant.add(h);
        airlock.declare('Cap', h);
        return {
          onGrantRequest(id) { return id === 'cap' ? grant : null; },
        };
      },
    })
    .onInboundMessage(() => {})
    .onHandlerError((rej) => { captured.handlerErrors.push(rej); })
    .build();
  await runtime.start();

  const result = session.parse(`
    grant "cap" {
      Cap.regParkThrow(async function(x) {
        let y = await Cap.deferred(x)
        // Throw AFTER the await — the slot resumed on a wake,
        // then immediately threw. The terminal status comes
        // back on a re-drive, not the initial drive.
        throw new Error("post-await-throw " + y)
      })
    }
  `);
  session.setInstruction(0, result.startIndex);
  await runtime.run(0);
  await waitFor(() => captured.parkThenThrow !== null,
    { label: 'boot grant to resolve and registration to run' });
  assert(captured.parkThenThrow, 'closure not registered');

  let caught = null;
  try {
    await runtime.invokeClosure(captured.parkThenThrow, [3]);
  } catch (err) {
    caught = err;
  }
  assert(caught, 'expected Promise rejection');
  assertEquals(caught.name, 'UncaughtScriptError');
  assert(caught.message.includes('post-await-throw 30'),
    `message should contain thrown value, got: ${caught.message}`);

  await runtime.terminate();
});

Deno.test('invokeClosure: closure that spawns an inner async fn returns the awaited result', async () => {
  const { runtime, captured } = await buildRuntime();
  const r = await runtime.invokeClosure(captured.spawnClosure, [3]);
  assertEquals(r, 300);
  await runtime.terminate();
});

// =============================================================================
// Lifecycle of the closure handle
// =============================================================================

Deno.test('invokeClosure: dropOnComplete frees the closure handle', async () => {
  const { runtime, session, captured } = await buildRuntime();
  // Confirm closure is live before invocation.
  assert(session.airlock.getClosurePointer(captured.syncClosure) !== null,
    'closure not live pre-invoke');
  const r = await runtime.invokeClosure(captured.syncClosure, [10],
    { dropOnComplete: true });
  assertEquals(r, 11);
  // Closure should be freed post-invoke.
  assertEquals(session.airlock.getClosurePointer(captured.syncClosure), null,
    'closure not freed after dropOnComplete');
  await runtime.terminate();
});

Deno.test('invokeClosure: dropOnComplete also frees on async-closure path', async () => {
  const { runtime, session, captured } = await buildRuntime();
  const r = await runtime.invokeClosure(captured.asyncClosure, [3],
    { dropOnComplete: true });
  assertEquals(r, 31);
  assertEquals(session.airlock.getClosurePointer(captured.asyncClosure), null);
  await runtime.terminate();
});

Deno.test('invokeClosure: dropOnComplete also frees on throw', async () => {
  const { runtime, session, captured } = await buildRuntime();
  await assertRejects(() =>
    runtime.invokeClosure(captured.throwClosure, [], { dropOnComplete: true }));
  assertEquals(session.airlock.getClosurePointer(captured.throwClosure), null,
    'throwing closure not freed despite dropOnComplete');
  await runtime.terminate();
});

// =============================================================================
// Concurrency
// =============================================================================

Deno.test('invokeClosure: two concurrent calls do not interfere', async () => {
  const { runtime, captured } = await buildRuntime();
  const p1 = runtime.invokeClosure(captured.asyncClosure, [4]);
  const p2 = runtime.invokeClosure(captured.multiClosure, [5]);
  const [r1, r2] = await Promise.all([p1, p2]);
  assertEquals(r1, 41);    // (4 * 10) + 1
  assertEquals(r2, 5000);  // 5 * 1000
  await runtime.terminate();
});

Deno.test('invokeClosure: many concurrent invocations all settle correctly', async () => {
  const { runtime, captured } = await buildRuntime();
  const promises = [];
  for (let i = 0; i < 5; i++) {
    promises.push(runtime.invokeClosure(captured.asyncClosure, [i]));
  }
  const results = await Promise.all(promises);
  for (let i = 0; i < 5; i++) {
    assertEquals(results[i], i * 10 + 1, `concurrent invoke #${i}`);
  }
  await runtime.terminate();
});

Deno.test('invokeClosure: invocations past the initial table capacity grow the table and park', async () => {
  // Layout v10: the slot→pointer table is a growable heap object. Pin a
  // small initial table (10 slots) and fire 15 concurrent invocations —
  // every one parks (the table doubles under them); none reject. The old
  // fixed-table contract (loud ContextRegionFullError reject past
  // capacity) is retired: the only allocation failure left is genuine
  // heap exhaustion.
  const { runtime, captured, session } = await buildRuntime({ contextTableSize: 4 * 10 });
  const initialCapacity = session.memoryImage.getContextTableCapacity();

  // Track per-promise outcomes ourselves rather than
  // Promise.allSettled, because the invocations park indefinitely on
  // Cap.manual until we resolve them below. allSettled would hang.
  const outcomes = new Array(15).fill(null);
  const promises = [];
  for (let i = 0; i < 15; i++) {
    const idx = i;
    const p = runtime.invokeClosure(captured.manualClosure, [idx])
      .then(
        (v) => { outcomes[idx] = { status: 'fulfilled', value: v }; },
        (e) => { outcomes[idx] = { status: 'rejected', reason: e }; },
      );
    promises.push(p);
  }

  // Let microtasks settle so every invocation parks on Cap.manual.
  await tick(20);

  // Pinned contract: nothing rejects, nothing fulfills yet — all 15
  // parked, and the table grew to admit them.
  const settled = outcomes.filter((o) => o !== null);
  assertEquals(settled.length, 0,
    `all invocations should be parked; got ${JSON.stringify(settled[0])}`);
  assertEquals(captured.manualResolvers.length, 15,
    'each parked invocation registered one Cap.manual resolver');
  assert(session.memoryImage.getContextTableCapacity() > initialCapacity,
    'the table grew past its initial capacity');

  // Resolve them all; every invocation completes.
  for (const r of captured.manualResolvers) r();
  await Promise.all(promises);

  for (let i = 0; i < 15; i++) {
    assert(outcomes[i] !== null && outcomes[i].status === 'fulfilled',
      `parked #${i} did not fulfill after resolver: ${JSON.stringify(outcomes[i])}`);
    assertEquals(outcomes[i].value, i * 10 + 1, `#${i} wrong value`);
  }

  await runtime.terminate();
});

Deno.test('invokeClosure: 100 concurrent parked awaits (ceiling lifted past the old 10)', async () => {
  // The headline win of heap-allocated contexts: concurrent suspensions are
  // bounded by heap rather than a fixed slab count. Here 100 closures park
  // simultaneously on Cap.manual—far beyond the old limit of ten—then all
  // complete when resolved.
  const { runtime, captured } = await buildRuntime();

  const N = 100;
  const outcomes = new Array(N).fill(null);
  const promises = [];
  for (let i = 0; i < N; i++) {
    const idx = i;
    promises.push(
      runtime.invokeClosure(captured.manualClosure, [idx]).then(
        (v) => { outcomes[idx] = { status: 'fulfilled', value: v }; },
        (e) => { outcomes[idx] = { status: 'rejected', reason: e }; },
      ));
  }

  // Let all 100 park on Cap.manual.
  await tick(50);

  // Every invocation parked — none rejected, none completed yet (all
  // waiting on their manual resolver).
  const rejected = outcomes.filter((o) => o && o.status === 'rejected');
  assertEquals(rejected.length, 0,
    `no invocation should reject; got ${rejected.length}: ${rejected[0]?.reason?.name}`);
  assertEquals(captured.manualResolvers.length, N,
    `all ${N} should be parked with a resolver; got ${captured.manualResolvers.length}`);

  // Resolve all; each closure returns its arg*10 + 1.
  for (const r of captured.manualResolvers) r();
  await Promise.all(promises);

  for (let i = 0; i < N; i++) {
    assertEquals(outcomes[i]?.status, 'fulfilled', `#${i} did not fulfill`);
    assertEquals(outcomes[i].value, i * 10 + 1, `#${i} wrong value`);
  }

  await runtime.terminate();
});

Deno.test('invokeClosure does not interfere with concurrent scheduleClosureCall', async () => {
  const { runtime, session, captured } = await buildRuntime();

  // Register a sync side-effect closure. Capture the PREVIOUS
  // syncClosure identity first — this second grant block re-registers
  // Cap.regSync with a fresh closure, and (like the boot grant)
  // suspends under Runtime's always-Promise grant fanout, so wait for
  // the identity to actually change rather than trusting a single
  // awaited run().
  const previousSyncClosure = captured.syncClosure;
  const result = session.parse(`
    grant "cap" {
      Cap.regSync(function(n) { Cap.notify(n) })
    }
  `);
  session.setInstruction(0, result.startIndex);
  await runtime.run(0);
  await waitFor(() => captured.syncClosure !== previousSyncClosure,
    { label: 're-registration grant to resolve' });

  // Schedule the side-effect closure to fire 3 times via the
  // existing fire-and-forget path, AND invoke an async closure
  // via invokeClosure simultaneously. Both should complete
  // correctly without interfering.
  const invokePromise = runtime.invokeClosure(captured.asyncClosure, [7]);
  runtime.scheduleClosureCall(captured.syncClosure, [100], {});
  runtime.scheduleClosureCall(captured.syncClosure, [200], {});
  runtime.scheduleClosureCall(captured.syncClosure, [300], {});

  const r = await invokePromise;
  assertEquals(r, 71);

  await waitFor(() => captured.notifications.length === 3,
    { label: 'all scheduleClosureCalls fired' });
  assertEquals(captured.notifications, [100, 200, 300]);

  await runtime.terminate();
});

// =============================================================================
// Liveness + lifecycle guards
// =============================================================================

Deno.test('invokeClosure: rejects when closure has been freed', async () => {
  const { runtime, session, captured } = await buildRuntime();
  // Drop the closure first.
  session.airlock.dropClosureHandle(captured.syncClosure);
  await assertRejects(
    () => runtime.invokeClosure(captured.syncClosure, [1]),
    Error,
    'freed',
  );
  await runtime.terminate();
});

Deno.test('invokeClosure: rejects after runtime.terminate()', async () => {
  const { runtime, captured } = await buildRuntime();
  await runtime.terminate();
  await assertRejects(
    () => runtime.invokeClosure(captured.syncClosure, [1]),
    Error,
    'terminated',
  );
});

Deno.test('invokeClosure: rejects before runtime.start()', async () => {
  // Build runtime without starting it. Need to construct directly
  // because the builder doesn't expose pre-start access for invoke;
  // RuntimeBuilder.build() returns runtime un-started.
  const captured = {
    syncClosure: null, asyncClosure: null, multiClosure: null,
    throwClosure: null, spawnClosure: null,
    notifications: [], handlerErrors: [],
  };
  const { runtime } = new RuntimeBuilder()
    .capability(capCap(captured))
    .onInboundMessage(() => {})
    .build();
  // Don't start. Try to invoke — there's no closure to invoke
  // yet, but invokeClosure checks _started before liveness, so
  // a bogus arg still surfaces the start() error.
  await assertRejects(
    () => runtime.invokeClosure({ slot: 0, version: 0 }, []),
    Error,
    'start()',
  );
});

// =============================================================================
// Quiesce / resume
// =============================================================================

Deno.test('invokeClosure: quiesce while parked defers settlement until resume', async () => {
  const { runtime, captured } = await buildRuntime();
  // Fire an async closure that parks on Cap.manual — we
  // control when its Promise resolves.
  const p = runtime.invokeClosure(captured.manualClosure, [9]);
  // Wait until the closure has parked (the manual resolver
  // has been registered).
  await waitFor(() => captured.manualResolvers.length === 1,
    { label: 'closure parked on Cap.manual' });
  // Quiesce — _drainPendingSpawned becomes a no-op while quiesced.
  await runtime.quiesce();
  // Now resolve the JS Promise. The airlock pushes the slot
  // into pendingSpawnedContexts and fires the hook; the hook
  // returns early because of quiesce.
  captured.manualResolvers[0]();
  // Race the invoke against a short timer — if quiesce honored,
  // the invoke does NOT resolve.
  let resolved = false;
  p.then(() => { resolved = true; });
  await tick(30);
  assert(!resolved, 'invokeClosure resolved while quiesced');
  // Now resume — the queued wake drains and the invoke settles.
  runtime.resume();
  const r = await p;
  assertEquals(r, 91);
  await runtime.terminate();
});

Deno.test('cancelRestoredInvocationRoots: cancels only snapshot-owned invocation roots before start', async () => {
  const original = await buildRuntime();
  const pendingResult = original.runtime
    .invokeClosure(original.captured.manualClosure, [9])
    .then(
      (value) => ({ value }),
      (error) => ({ error }),
    );
  await waitFor(() => original.captured.manualResolvers.length === 1,
    { label: 'invocation root parked before snapshot' });
  const invocationSlot = [...original.runtime._invokeWaiters.keys()][0];
  const invocationGeneration =
    original.session.memoryImage.getContextGeneration(invocationSlot);
  assert(original.session.memoryImage.isContextInvocationRoot(invocationSlot));
  assert(!original.session.memoryImage.isContextInvocationRoot(0));

  await original.runtime.quiesce();
  const snapshot = original.snapshot();
  const restoredBuilder = () => {
    const captured = {
      notifications: [],
      manualResolvers: [],
      handlerErrors: [],
    };
    return new RuntimeBuilder()
      .fromSnapshot(snapshot)
      .capability(capCap(captured))
      .onInboundMessage(() => {})
      .build();
  };

  const restored = restoredBuilder();
  assertEquals(restored.session.get(0, 'sharedValue'), 42);
  assert(restored.session.memoryImage.isContextIdentityLive(
    invocationSlot, invocationGeneration));
  assert(restored.session.memoryImage.isContextInvocationRoot(invocationSlot));
  assertEquals(restored.runtime.cancelRestoredInvocationRoots(), 1);
  assert(!restored.session.memoryImage.isContextIdentityLive(
    invocationSlot, invocationGeneration));
  assert(restored.session.memoryImage.getContextBase(0) !== 0);
  assert(!restored.session.memoryImage.isContextInvocationRoot(0));
  assertEquals(restored.session.get(0, 'sharedValue'), 42);
  assertThrows(
    () => restored.runtime.cancelRestoredInvocationRoots(),
    Error,
    'already completed',
  );

  const startedRestore = restoredBuilder();
  await startedRestore.runtime.start();
  assertThrows(
    () => startedRestore.runtime.cancelRestoredInvocationRoots(),
    Error,
    'start() has already begun',
  );
  await startedRestore.runtime.terminate();

  const freshCaptured = {
    notifications: [],
    manualResolvers: [],
    handlerErrors: [],
  };
  const fresh = new RuntimeBuilder()
    .capability(capCap(freshCaptured))
    .onInboundMessage(() => {})
    .build();
  assertThrows(
    () => fresh.runtime.cancelRestoredInvocationRoots(),
    Error,
    'runtime was not restored',
  );

  await original.runtime.terminate();
  const originalOutcome = await pendingResult;
  assert(originalOutcome.error instanceof Error);
});

// =============================================================================
// Settlement behavior
// =============================================================================

// A string table small enough that the hog closure's RETAINED strings
// exhaust it: gc reclaims nothing, the memory_pressure persists with
// no progress, and driveLoop returns a MemoryPressureError 'error'
// terminal (the status that used to dangle the invoke Promise).
const HOG_SESSION = { stringTableSize: 64 * 1024 };

Deno.test('invokeClosure: hard OOM in a sync closure rejects with MemoryPressureError and frees the slot', async () => {
  const { runtime, session, captured } = await buildRuntime(HOG_SESSION);
  try {
    let oomSlot = null;
    runtime.onGarbageCollect = (event) => {
      if (event.kind === 'oom') oomSlot = event.slot;
    };

    await assertRejects(
      () => runtime.invokeClosure(captured.hogClosure, [50000], { dropOnComplete: true }),
      Error,
      'memory_pressure persisted');

    // The terminal settle freed the slot (the old dangle also leaked it).
    assert(oomSlot !== null, 'onGarbageCollect oom event must name the slot');
    assertEquals(session.airlock.memoryImage.getContextBase(oomSlot), 0,
      'OOM slot must be freed by the settle');
    // dropOnComplete ran: the handle is gone, so a second invoke rejects
    // on the liveness check.
    await assertRejects(
      () => runtime.invokeClosure(captured.hogClosure, [1]),
      Error,
      'closure handle has been freed');
  } finally {
    await runtime.terminate();
  }
});

Deno.test('invokeClosure: hard OOM after an await (wake-time re-drive) rejects the Promise', async () => {
  const { runtime, captured } = await buildRuntime(HOG_SESSION);
  try {
    const p = runtime.invokeClosure(captured.hogAfterAwaitClosure, [50000]);
    // Let the closure park on Cap.manual, then wake it into the hog loop.
    await waitFor(() => captured.manualResolvers.length === 1,
      { label: 'hog closure parked on Cap.manual' });
    captured.manualResolvers[0]();

    await assertRejects(() => p, Error, 'memory_pressure persisted');
  } finally {
    await runtime.terminate();
  }
});

Deno.test('invokeClosure: called while quiesced defers the whole call and settles after resume', async () => {
  const { runtime, captured } = await buildRuntime();
  await runtime.quiesce();

  const p = runtime.invokeClosure(captured.syncClosure, [5]);
  let settled = false;
  p.then(() => { settled = true; }, () => { settled = true; });
  await tick(30);
  assert(!settled, 'invokeClosure must not settle while quiesced');

  runtime.resume();
  assertEquals(await p, 6);
  await runtime.terminate();
});

Deno.test('invokeClosure: dispatchChild wake racing the quiesce tail is deferred, not dropped', async () => {
  // The uncovered wake channel: a drive finishing DURING the quiesce
  // tail hands its awaiter slots straight to the dispatcher via
  // driveLoop's dispatchChild, bypassing the airlock queue that the
  // existing quiesce test covers. Shape: parent closure awaits an
  // inner SS async fn; the inner parks on Cap.manual. The inner's
  // post-wake drive burns a busy loop, so with a tiny fuel budget the
  // fuel hook fires MID-DRIVE — it flips quiesce on and refuels; the
  // inner then completes while quiesced, and its
  // dispatchChild(parent) must be deferred for resume() instead of
  // silently lost (pre-fix: the parent — and the invoke Promise —
  // dangled forever).
  const { runtime, captured } = await buildRuntime();
  try {
    const p = runtime.invokeClosure(captured.spawnManualClosure, [7]);
    await waitFor(() => captured.manualResolvers.length === 1,
      { label: 'inner async fn parked on Cap.manual' });

    // Arm the fuel hook BEFORE waking the inner: its wake-drive
    // exhausts the tiny budget inside the busy loop, the hook
    // quiesces mid-drive and refuels big. driveLoop captures the
    // hook at drive entry, so the same hook may fire again within
    // this drive — only the first call quiesces.
    let quiescePromise = null;
    runtime._fuel = 50;
    runtime.onFuelExhausted = () => {
      if (quiescePromise === null) quiescePromise = runtime.quiesce();
      return 10_000_000;
    };
    captured.manualResolvers[0]();

    await waitFor(() => quiescePromise !== null,
      { label: 'fuel hook fired mid-drive' });
    await quiescePromise;
    runtime.onFuelExhausted = null;

    // Quiesced: the inner completed its drive, but the parent's wake
    // (and therefore the invoke settle) must not have run.
    let settled = false;
    p.then(() => { settled = true; }, () => { settled = true; });
    await tick(30);
    assert(!settled, 'parent wake must defer while quiesced');

    runtime.resume();
    // manual default resolver: 7 * 10 = 70; inner adds its busy count.
    assertEquals(await p, 70 + 5000);
  } finally {
    await runtime.terminate();
  }
});

Deno.test('invokeClosure: fuel-paused slot re-driven via runtime.run settles the Promise', async () => {
  const { runtime, captured } = await buildRuntime();
  try {
    // First exhaustion: decline to refuel — the drive parks with
    // status 'paused' and the waiter stays registered.
    let pausedSlot = null;
    runtime._fuel = 50;
    runtime.onFuelExhausted = (slot) => {
      pausedSlot = slot;
      return 0;
    };

    const p = runtime.invokeClosure(captured.busyClosure, [10000]);
    await waitFor(() => pausedSlot !== null, { label: 'closure paused on fuel' });

    let settled = false;
    p.then(() => { settled = true; }, () => { settled = true; });
    await tick(30);
    assert(!settled, 'paused invoke must stay pending');

    // Re-drive through the public surface. run() must route the
    // waiter-owned slot through the invoke path so the terminal
    // settles the original Promise (a raw drive would bypass it).
    runtime.onFuelExhausted = () => 10_000_000;
    const status = await runtime.run(pausedSlot);
    assertEquals(status.status, 'done');
    assertEquals(await p, 10000);
  } finally {
    await runtime.terminate();
  }
});

Deno.test('invokeClosure: terminate() rejects parked waiters instead of dangling them', async () => {
  const { runtime, captured } = await buildRuntime();
  const p = runtime.invokeClosure(captured.manualClosure, [3]);
  await waitFor(() => captured.manualResolvers.length === 1,
    { label: 'closure parked on Cap.manual' });

  await runtime.terminate();
  await assertRejects(() => p, Error, 'runtime is terminated');
});

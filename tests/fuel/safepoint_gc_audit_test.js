/**
 * Safepoint GC coverage for every root held across an interpreter exit.
 *
 * The request and frame locations exercised here are:
 *
 *   1. EXIT_AWAIT (settled): request_base + 8 holds
 *      promise_data_ptr + PROMISE_VALUE.
 *   2. EXIT_PROMISE_SETTLE: request_base + 0 holds promiseDataPointer.
 *   3. EXIT_PROMISE_METHOD (instance): request_base + 0 holds a
 *      promise heap pointer.
 *   4. EXIT_ASYNC_CALL: request_base + 0 holds a closure heap pointer.
 *   5. EXIT_PROMISE_METHOD (static, Promise.all etc.): the call-stack
 *      frame's FRAME.ASYNC_PROMISE field holds a promise pointer.
 *   6. EXIT_ASYNC_COMPLETE: FRAME.ASYNC_PROMISE holds the same root.
 *   7. EXIT_ASYNC_REJECTED: FRAME.ASYNC_PROMISE holds the same root.
 *
 * Additional regression cases cover EXIT_AWAIT while pending,
 * EXIT_EXTERNAL_CALL, EXIT_EXTERNAL_PROPERTY, EXIT_GRANT_REQUEST,
 * EXIT_PAUSED_FUEL, terminal exits, and the baseline collector path.
 *
 * Public-API reachability matters. The four request_base windows are not
 * exposed by the public API because session.run and airlock.runContext call
 * the matching handleX synchronously before returning to the host. Their tests
 * drive `airlock.wasm.exports.run` directly to expose the interval after the
 * yield and before its handler. The three FRAME.ASYNC_PROMISE windows are
 * public: session.run returns 'async_complete', 'async_rejected', or
 * 'promise_method', and a host may collect between that return and the
 * corresponding handleX call.
 */

import { assert, assertEquals, assertNotEquals } from 'https://deno.land/std@0.208.0/assert/mod.ts';
import { UncaughtScriptError } from '../../src/runtime/errors.js';
import { createSession } from '../../src/fuel/session.js';
import { parseAndSetup } from './test-helpers.js';
import {
  STATE,
  EXIT_DONE,
  EXIT_ERROR,
  EXIT_EXTERNAL_CALL,
  EXIT_EXTERNAL_PROPERTY,
  EXIT_AWAIT,
  EXIT_ASYNC_CALL,
  EXIT_ASYNC_COMPLETE,
  EXIT_ASYNC_REJECTED,
  EXIT_PROMISE_METHOD,
  EXIT_PROMISE_SETTLE,
} from '../../src/fuel/constants.js';
import { freshSession } from '../../src/host-owned-session.js';

function setupHandle(session, name) {
  const airlock = session.airlock;
  const id = airlock.register({});
  airlock.createRootGrant().add(id);
  airlock.declare(name, id);
  return { airlock, id };
}

/**
 * Drive a slot via `airlock.wasm.exports.run` directly, bypassing
 * session.run's internal handler dispatch. Returns the exit
 * condition observed after the WAT yield. The slot is now in the
 * post-yield-pre-handler state — the window the public API hides.
 */
function runWasmDirectly(session, slot, fuel) {
  const remainingFuel = session.airlock.wasm.exports.run(fuel, slot);
  const exitCondition = session.memoryImage.getExitCondition(slot);
  return { exitCondition, remainingFuel };
}

/**
 * Run a session to completion, calling `gcEvery(session)` between
 * iterations. Drives all spawned contexts and dispatches the same
 * statuses as promise_bridging_test.js's runToCompletion.
 */
async function runToCompletionWithGc(session, gcEvery, maxIterations = 200) {
  const mem = session.memoryImage;
  const airlock = session.airlock;
  const contexts = [{ slot: 0, generation: session.memoryImage.getContextGeneration(0) }]
  const TERMINAL = new Set([EXIT_DONE, EXIT_ERROR, EXIT_ASYNC_COMPLETE, EXIT_ASYNC_REJECTED]);

  for (let iter = 0; iter < maxIterations; iter++) {
    await new Promise(r => setTimeout(r, 0));

    for (const c of airlock.drainPendingSpawnedContextIdentities()) {
      if (!contexts.find(ct => ct.slot === c.slot && ct.generation === c.generation)) contexts.push(c);
    }

    let next = null;
    for (const c of contexts) {
      const ec = mem.getExitCondition(c.slot);
      if (TERMINAL.has(ec)) continue;
      if (ec === EXIT_AWAIT) continue;
      next = c;
      break;
    }

    if (!next) {
      if (airlock.linkedPromiseCount() > 0 && iter < maxIterations - 1) continue;
      break;
    }

    if (gcEvery) gcEvery(session);
    const r = session.run(next, 1000);
    if (gcEvery) gcEvery(session);

    if (r.status === 'async_call' && r.asyncContext !== undefined) {
      contexts.push(r.asyncContext);
    }
    if (r.status === 'await') airlock.handleAwait(next.slot);
    if (r.status === 'async_complete') {
      const { waiters } = airlock.handleAsyncComplete(next.slot);
      for (const w of waiters) if (!contexts.find(ct => ct.slot === w.slot && ct.generation === w.generation)) contexts.push(w);
    }
    if (r.status === 'async_rejected') {
      const { waiters } = airlock.handleAsyncRejected(next.slot);
      for (const w of waiters) if (!contexts.find(ct => ct.slot === w.slot && ct.generation === w.generation)) contexts.push(w);
    }
    if (r.status === 'promise_method' && r.contexts) {
      for (const c of r.contexts) {
        if (!contexts.find(ct => ct.slot === c.slot && ct.generation === c.generation)) contexts.push(c);
      }
    }
  }
}

// ===========================================================================
// 1. EXIT_AWAIT (settled case)
//
//    request_base + 8 = promise_data_ptr + PROMISE_VALUE.
//    handleAwait reads it to copy the settled value to the slot's
//    pending stack. After GC moves the promise, the dereference reads
//    garbage — the awaited value is corrupt.
// ===========================================================================

Deno.test(
  'safepoint audit / EXIT_AWAIT (settled): GC must forward request_base+8',
  () => {
    const session = freshSession();

    // `Promise.resolve({...})` produces an already-settled (RESOLVED)
    // promise whose VALUE field carries an OBJECT heap pointer. When
    // OP_AWAIT runs against it, the WAT goes through the
    // settled-resolved branch (interpreter.wat:28329) and writes
    // `request_base + 8 = promise_data_ptr + PROMISE_VALUE`.
    //
    // We need a heap-bearing value (not a primitive) so that any
    // forwarding lapse is *observable* — primitives like integers
    // store their data inline and would round-trip through a stale
    // pointer harmlessly.
    //
    // We also pre-allocate throwaway garbage so that a real
    // compaction step has something to reclaim. Without that, the
    // collector may skip moving the promise entirely and the bug
    // wouldn't be exposed.
    parseAndSetup(session, `
      let temp = [];
      let i = 0;
      while (i < 80) { temp.push({ k: i }); i = i + 1; }
      temp = 0;

      let x;
      async function main() {
        x = await Promise.resolve({ value: 42 });
      }
      main();
    `);

    const mem = session.memoryImage;
    const airlock = session.airlock;

    // Step 1: drive ctx 0 (spawns ctx 1 via async_call).
    session.run(0, 100000);

    // Step 2: drive ctx 1 with raw wasm so we land at EXIT_AWAIT
    // before any handler runs.
    runWasmDirectly(session, 1, 10000);
    assertEquals(mem.getExitCondition(1), EXIT_AWAIT, 'expected ctx 1 at EXIT_AWAIT');

    const reqBase = mem.getExternalRequestBase(1);
    assertEquals(
      mem.view.getUint32(mem.abs(reqBase), true), 0,
      'expected settled await (isPending=0)',
    );
    const valuePtr = mem.view.getUint32(mem.abs(reqBase + 8), true);
    assertNotEquals(valuePtr, 0, 'value pointer should be non-zero on settled await');

    // The value at *valuePtr is a tagged 16-byte slot. For an OBJECT
    // value, lo (offset +8) is a heap header pointer to the object's
    // data block.
    const objHeaderBefore = mem.view.getUint32(mem.abs(valuePtr + 8), true);
    assertNotEquals(objHeaderBefore, 0, 'object should have a heap pointer');

    const heapPointerBefore = mem.getHeapPointer();

    // **Inject GC.** With dead-temp garbage in the heap, compaction
    // should reclaim space. The promise itself should survive but at
    // a relocated address.
    session.gc();

    const heapPointerAfter = mem.getHeapPointer();

    // Sanity: GC actually freed something. Otherwise this test would
    // pass vacuously even with the bug present.
    assert(
      heapPointerAfter < heapPointerBefore,
      `GC didn't reclaim anything (${heapPointerBefore} -> ${heapPointerAfter}) — test premise broken`,
    );

    // request_base+8 was a heap pointer into the moved promise. Forwarding
    // makes it point below heap_pointer_after at the promise's new location;
    // an unforwarded value remains above the pointer in freed heap space.
    const valuePtrAfter = mem.view.getUint32(mem.abs(reqBase + 8), true);
    assert(
      valuePtrAfter < heapPointerAfter,
      `request_base+8 (${valuePtrAfter}) points into freed heap region ` +
      `(heap_pointer is now ${heapPointerAfter}); the collector did not ` +
      `forward it.`,
    );
  },
);

// ===========================================================================
// 2. EXIT_PROMISE_SETTLE
//
//    request_base + 0 = promiseDataPointer.
//    handlePromiseSettle dereferences to mutate the promise's status.
//    After GC moves the promise, the status update lands at a stale
//    address — silent corruption of unrelated heap memory; the actual
//    promise stays PENDING and any .then handler never fires.
// ===========================================================================

Deno.test(
  'safepoint audit / EXIT_PROMISE_SETTLE: GC must forward request_base+0',
  () => {
    const session = freshSession();

    // Throwaway garbage so GC has something to compact.
    parseAndSetup(session, `
      let temp = [];
      let i = 0;
      while (i < 80) { temp.push({ k: i }); i = i + 1; }
      temp = 0;

      let p = new Promise((resolve) => { resolve(99) });
    `);

    const mem = session.memoryImage;
    const airlock = session.airlock;

    // The Promise constructor itself yields EXIT_PROMISE_METHOD on
    // the host slot (ctx 0); session.run handles that internally
    // and spawns the executor in a new context. We need to drive
    // raw wasm and dispatch promise_method ourselves to leave the
    // executor at EXIT_PROMISE_SETTLE without consuming it.
    runWasmDirectly(session, 0, 100000);
    assertEquals(mem.getExitCondition(0), EXIT_PROMISE_METHOD, 'ctx 0 should yield EXIT_PROMISE_METHOD (Promise constructor)');
    const pmResult = airlock.handlePromiseMethod(0);
    const executorIdentity = pmResult.contexts[0];
    assert(executorIdentity !== undefined, 'expected a spawned executor context');

    // Drive ctx 0 to completion (it's now done with the constructor
    // call; just runs the rest of the script).
    runWasmDirectly(session, 0, 100000);

    // Now drive the executor. It runs `resolve(99)` and yields
    // EXIT_PROMISE_SETTLE.
    runWasmDirectly(session, executorIdentity.slot, 10000);
    assertEquals(
      mem.getExitCondition(executorIdentity.slot),
      EXIT_PROMISE_SETTLE,
      'expected executor at EXIT_PROMISE_SETTLE',
    );

    const reqBase = mem.getExternalRequestBase(executorIdentity.slot);
    const promisePtrBefore = mem.view.getUint32(mem.abs(reqBase), true);
    assertNotEquals(promisePtrBefore, 0, 'request_base+0 should hold a promise pointer');

    const heapPointerBefore = mem.getHeapPointer();
    session.gc();
    const heapPointerAfter = mem.getHeapPointer();

    assert(
      heapPointerAfter < heapPointerBefore,
      `GC didn't reclaim anything (${heapPointerBefore} -> ${heapPointerAfter}) — test premise broken`,
    );

    // **Canary.** request_base+0 holds the promise's data pointer.
    // After compaction, that pointer must point into the LIVE heap
    // (below heap_pointer_after), not into the freed region.
    const promisePtrAfter = mem.view.getUint32(mem.abs(reqBase), true);
    assert(
      promisePtrAfter < heapPointerAfter,
      `request_base+0 (${promisePtrAfter}) points into freed heap region ` +
      `(heap_pointer is now ${heapPointerAfter}); the collector did not ` +
      `forward it. Slice 2 fix needed.`,
    );
  },
);

// ===========================================================================
// 3. EXIT_PROMISE_METHOD (instance variant)
//
//    request_base + 0 = promise heap pointer (the receiver of .then).
//    handlePromiseMethod dereferences to wire a then-handler node.
//    After GC moves the promise, the handler lands on a stale address;
//    when the actual promise settles, the .then callback never fires.
//
//    NOTE: the static variants (Promise.all, Promise.race) write 0 in
//    request_base + 0 and are NOT affected by this gap.
// ===========================================================================

Deno.test(
  'safepoint audit / EXIT_PROMISE_METHOD (instance): GC must forward request_base+0',
  () => {
    const session = freshSession();

    // Throwaway garbage so GC has something to compact.
    parseAndSetup(session, `
      let temp = [];
      let i = 0;
      while (i < 80) { temp.push({ k: i }); i = i + 1; }
      temp = 0;

      let result;
      let p = new Promise((resolve) => { resolve(7) });
      p.then(v => { result = v });
    `);

    const mem = session.memoryImage;
    const airlock = session.airlock;

    // Yield #1: Promise constructor → EXIT_PROMISE_METHOD (static
    // variant, request_base[0]=0). Dispatch to spawn the executor.
    runWasmDirectly(session, 0, 100000);
    assertEquals(mem.getExitCondition(0), EXIT_PROMISE_METHOD, 'first yield should be EXIT_PROMISE_METHOD (constructor)');
    const reqBase = mem.getExternalRequestBase(0);
    assertEquals(
      mem.view.getUint32(mem.abs(reqBase), true), 0,
      'constructor variant writes 0 at request_base[0]',
    );
    airlock.handlePromiseMethod(0);

    // Yield #2: p.then(...) → EXIT_PROMISE_METHOD (instance
    // variant, request_base[0]=promise heap pointer).
    runWasmDirectly(session, 0, 100000);
    assertEquals(mem.getExitCondition(0), EXIT_PROMISE_METHOD, 'second yield should be EXIT_PROMISE_METHOD (.then)');
    const promisePtrBefore = mem.view.getUint32(mem.abs(reqBase), true);
    assertNotEquals(promisePtrBefore, 0, 'instance variant must hold a heap pointer at request_base[0]');

    const heapPointerBefore = mem.getHeapPointer();
    session.gc();
    const heapPointerAfter = mem.getHeapPointer();

    assert(
      heapPointerAfter < heapPointerBefore,
      `GC didn't reclaim anything (${heapPointerBefore} -> ${heapPointerAfter}) — test premise broken`,
    );

    // **Canary.** request_base+0 holds the receiver promise's
    // pointer. After compaction, it must point into the live heap.
    const promisePtrAfter = mem.view.getUint32(mem.abs(reqBase), true);
    assert(
      promisePtrAfter < heapPointerAfter,
      `request_base+0 (${promisePtrAfter}) points into freed heap region ` +
      `(heap_pointer is now ${heapPointerAfter}); the collector did not ` +
      `forward it. Slice 2 fix needed.`,
    );
  },
);

// ===========================================================================
// 4. EXIT_ASYNC_CALL
//
//    request_base + 0 = closure heap pointer.
//    handleAsyncCall dereferences at +28 (start_instruction) and
//    +36 (capturedScope) to spawn the async context. After GC moves
//    the closure, the spawned context starts at a garbage PC with a
//    garbage scope — typically crashes immediately or runs wrong code.
// ===========================================================================

Deno.test(
  'safepoint audit / EXIT_ASYNC_CALL: GC must forward request_base+0',
  () => {
    const session = freshSession();

    parseAndSetup(session, `
      let temp = [];
      let i = 0;
      while (i < 80) { temp.push({ k: i }); i = i + 1; }
      temp = 0;

      let captured = 100;
      async function inner() {
        return captured + 23;
      }
      inner();
    `);

    const mem = session.memoryImage;
    const airlock = session.airlock;

    // Drive ctx 0 to the inner() async_call yield.
    runWasmDirectly(session, 0, 100000);
    assertEquals(mem.getExitCondition(0), EXIT_ASYNC_CALL, 'expected EXIT_ASYNC_CALL');

    const reqBase = mem.getExternalRequestBase(0);
    const closurePtrBefore = mem.view.getUint32(mem.abs(reqBase), true);
    assertNotEquals(closurePtrBefore, 0, 'request_base+0 should hold closure heap pointer');

    const heapPointerBefore = mem.getHeapPointer();
    session.gc();
    const heapPointerAfter = mem.getHeapPointer();

    assert(
      heapPointerAfter < heapPointerBefore,
      `GC didn't reclaim anything (${heapPointerBefore} -> ${heapPointerAfter}) — test premise broken`,
    );

    // **Canary.** request_base+0 holds the closure header pointer.
    // After compaction it must point into the live heap.
    const closurePtrAfter = mem.view.getUint32(mem.abs(reqBase), true);
    assert(
      closurePtrAfter < heapPointerAfter,
      `request_base+0 (${closurePtrAfter}) points into freed heap region ` +
      `(heap_pointer is now ${heapPointerAfter}); the collector did not ` +
      `forward it. Slice 2 fix needed.`,
    );
  },
);

// ===========================================================================
// CROSS-CHECK: a baseline test that should pass today.
//
// Same await pattern, no intermediate GC, going through session.run
// (the public API). Confirms the test infra works.
// ===========================================================================

Deno.test('safepoint audit / baseline: await without intermediate GC works (via session.run)', async () => {
  const session = freshSession();
  const { airlock, id } = setupHandle(session, 'Api');
  airlock.setHandler(id, 'getValue', () => Promise.resolve(42));

  parseAndSetup(session, `
    let x;
    async function main() {
      x = await Api.getValue();
    }
    main();
  `);

  // Use the same runToCompletion pattern as promise_bridging_test.js.
  const mem = session.memoryImage;
  const contexts = [{ slot: 0, generation: session.memoryImage.getContextGeneration(0) }]

  for (let iter = 0; iter < 200; iter++) {
    await new Promise(r => setTimeout(r, 0));

    for (const ctx of airlock.drainPendingSpawnedContextIdentities()) {
      if (!contexts.find(c => c.slot === ctx.slot && c.generation === ctx.generation)) contexts.push(ctx);
    }

    let contextToRun = null;
    for (const ctx of contexts) {
      const ec = mem.getExitCondition(ctx.slot);
      if (ec === EXIT_DONE || ec === EXIT_ERROR ||
          ec === EXIT_ASYNC_COMPLETE || ec === EXIT_ASYNC_REJECTED ||
          ec === EXIT_AWAIT) continue;
      contextToRun = ctx;
      break;
    }

    if (!contextToRun) {
      if (airlock.linkedPromiseCount() > 0 && iter < 199) continue;
      break;
    }

    const result = session.run(contextToRun, 100);
    if (result.status === 'async_call' && result.asyncContext !== undefined) {
      contexts.push(result.asyncContext);
    }
    if (result.status === 'await') airlock.handleAwait(contextToRun.slot);
    if (result.status === 'async_complete') {
      const { waiters } = airlock.handleAsyncComplete(contextToRun.slot);
      for (const w of waiters) if (!contexts.find(c => c.slot === w.slot && c.generation === w.generation)) contexts.push(w);
    }
    if (result.status === 'async_rejected') {
      const { waiters } = airlock.handleAsyncRejected(contextToRun.slot);
      for (const w of waiters) if (!contexts.find(c => c.slot === w.slot && c.generation === w.generation)) contexts.push(w);
    }
  }

  assertEquals(session.get(0, 'x'), 42);
});

// ===========================================================================
// REGRESSION TESTS: each supported exit type must tolerate engine.gc() at its
// boundary. Where possible the cases drive WAT directly through
// runWasmDirectly to reach the exact post-yield, pre-handler state.
//
// One test per non-terminal exit, plus one consolidated test for
// terminal exits (`done`, `error`, `throw`) where the slot is no
// longer running.
// ===========================================================================

// ---------------------------------------------------------------------------
// 'await' (pending) — request_base = [1, 0, 0]; no heap pointer to forward.
//
// The host gets `'await'` from session.run only when the linked
// promise hasn't settled yet. GC at this point should be safe by
// construction.
// ---------------------------------------------------------------------------

Deno.test('safepoint audit / EXIT_AWAIT (pending): GC at the await-pending boundary is safe', async () => {
  const session = freshSession();
  const { airlock, id } = setupHandle(session, 'Api');

  let resolveExternal;
  airlock.setHandler(id, 'fetchData', () => {
    return new Promise(resolve => { resolveExternal = resolve; });
  });

  parseAndSetup(session, `
    let x;
    async function main() {
      x = await Api.fetchData();
    }
    main();
  `);

  // Spawn ctx 1, drive it to the await on a still-pending promise.
  session.run(0, 1000);
  session.run(1, 1000);

  // ctx 1 is parked on a pending linked promise. GC here is the canonical
  // host-integration use case.
  session.gc();

  // Settle and finish.
  resolveExternal(7);
  await new Promise(r => setTimeout(r, 0));
  airlock.drainPendingSpawnedContextIdentities();
  session.run(1, 1000);

  assertEquals(session.get(0, 'x'), 7);
});

// ---------------------------------------------------------------------------
// 'external_call' — request_base holds integers and a pending-stack
// address; both safe under GC.
// ---------------------------------------------------------------------------

Deno.test('safepoint audit / EXIT_EXTERNAL_CALL: GC between yield and handleExternalCall is safe', () => {
  const session = freshSession();
  const { airlock, id } = setupHandle(session, 'Api');
  airlock.setHandler(id, 'compute', ({ args }) => args[0] * 2);

  parseAndSetup(session, `
    let x = Api.compute(21);
  `);

  // SS code `Api.compute(21)` yields TWICE:
  //   1. EXIT_EXTERNAL_PROPERTY (= 13) for the `.compute` member access.
  //      The host pushes a TYPE_EXTERNAL_METHOD binding and resumes.
  //   2. EXIT_EXTERNAL_CALL (= 3) for the actual call.
  // GC at boundary #2 is the watermark.

  // Drive WAT directly to reach yield #1 (property).
  let r = runWasmDirectly(session, 0, 1000);
  assertEquals(r.exitCondition, EXIT_EXTERNAL_PROPERTY, 'expected EXIT_EXTERNAL_PROPERTY first');
  airlock.handleExternalProperty(0, 1000);

  // Resume, drive to yield #2 (call).
  r = runWasmDirectly(session, 0, 1000);
  assertEquals(r.exitCondition, EXIT_EXTERNAL_CALL, 'expected EXIT_EXTERNAL_CALL after property');

  // **Watermark.** GC at the post-yield-pre-handler boundary.
  session.gc();

  // Service the call and finish.
  const result = airlock.handleExternalCall(0, 1000);
  airlock.resumeWithValue(0, result.result);
  runWasmDirectly(session, 0, 1000);

  assertEquals(session.get(0, 'x'), 42);
});

// ---------------------------------------------------------------------------
// 'external_property' — request_base holds integers only.
// ---------------------------------------------------------------------------

Deno.test('safepoint audit / EXIT_EXTERNAL_PROPERTY: GC between yield and getter is safe', () => {
  const session = freshSession();
  const { airlock, id } = setupHandle(session, 'Api');

  // setGetter (not setHandler) is what registers a property getter
  // that fires on `Api.value` without parentheses.
  airlock.setGetter(id, 'value', () => 99);

  parseAndSetup(session, `
    let x = Api.value;
  `);

  session.gc();
  session.run(0, 1000);
  session.gc();

  assertEquals(session.get(0, 'x'), 99);
});

// ---------------------------------------------------------------------------
// 'grant_request' — identifiers live on the pending stack (walked).
// ---------------------------------------------------------------------------

Deno.test('safepoint audit / EXIT_GRANT_REQUEST: GC during grant resolution is safe', () => {
  const session = freshSession();
  const { airlock } = session;

  // Use the simple grant pattern (per tests/fuel/grant_test.js):
  // approve every grant request with a freshly-created Grant object.
  airlock.onGrantRequest = (identifier) => {
    const grant = airlock.membrane.createGrant(identifier);
    return { approved: true, grant };
  };

  session.parse('let result = 0; grant "fs" { result = 42; }');

  // GC at every boundary the host can reach.
  session.gc();
  session.run(0, 10000);
  session.gc();

  assertEquals(session.get(0, 'result'), 42);
});

// ---------------------------------------------------------------------------
// THE FIFTH AUDIT GAP: FRAME.ASYNC_PROMISE is unwalked.
//
// The collector's `updateCallStackPointersForContext`
// (`src/fuel/collector.js:1191`) only forwards `SCOPE_POINTER`,
// `ITER_RESULT`, and `ITER_RECEIVER`. It does NOT forward
// `FRAME.ASYNC_PROMISE` (offset 0x34), which holds a heap pointer
// to the implicit promise an async function will resolve/reject.
//
// `airlock.handleAsyncComplete` and `airlock.handleAsyncRejected`
// both read `FRAME.ASYNC_PROMISE` to decide which promise to
// settle. After GC moves the promise, that field holds the OLD
// address. The handlers then call `popAllWaiters(stalePtr)` /
// `popAllHandlers(stalePtr)`, which walk garbage memory and crash
// with "Offset is outside the bounds of the DataView".
//
// FRAME.ASYNC_PROMISE must be forwarded while preserving its low two flag
// bits. Otherwise handleAsyncComplete or handleAsyncRejected follows the old
// promise address, walks garbage waiter data, and reads an out-of-bounds slot.
// The three cases below cover the promise-method, completion, and rejection
// paths.
// ---------------------------------------------------------------------------

Deno.test(
  'safepoint audit / EXIT_PROMISE_METHOD (static, Promise.all): GC must forward FRAME.ASYNC_PROMISE',
  async () => {
    const session = freshSession();
    const { airlock, id } = setupHandle(session, 'Api');
    airlock.setHandler(id, 'a', () => Promise.resolve(1));
    airlock.setHandler(id, 'b', () => Promise.resolve(2));

    parseAndSetup(session, `
      let result;
      async function main() {
        result = await Promise.all([Api.a(), Api.b()]);
      }
      main();
    `);

    await runToCompletionWithGc(session, (s) => s.gc());

    assertEquals(session.get(0, 'result'), [1, 2]);
  },
);

// These watermarks also pin built-in string forwarding. When
// Collector.updateBuiltinsStrings walked only the first 56 slots,
// BUILTIN_THEN, BUILTIN_CATCH, BUILTIN_FINALLY, and roughly 120 later names
// remained stale after string compaction. OP_GET_PROP "then" on a promise
// consequently produced UNDEFINED instead of a BOUND_METHOD, and
// OP_CALL_METHOD surfaced a TypeError before reaching the
// FRAME.ASYNC_PROMISE root.

Deno.test(
  'safepoint audit / EXIT_ASYNC_COMPLETE: GC must forward FRAME.ASYNC_PROMISE',
  async () => {
    const session = freshSession();

    parseAndSetup(session, `
      let x;
      async function main() {
        return 55;
      }
      let p = main();
      p.then(v => { x = v });
    `);

    await runToCompletionWithGc(session, (s) => s.gc());

    assertEquals(session.get(0, 'x'), 55);
  },
);

Deno.test(
  'safepoint audit / EXIT_ASYNC_REJECTED: GC must forward FRAME.ASYNC_PROMISE',
  async () => {
    const session = freshSession();

    parseAndSetup(session, `
      let caught;
      async function bad() {
        throw new Error('boom');
      }
      async function main() {
        try {
          await bad();
        } catch (e) {
          caught = e.message;
        }
      }
      main();
    `);

    await runToCompletionWithGc(session, (s) => s.gc());

    assertEquals(session.get(0, 'caught'), 'boom');
  },
);

// ---------------------------------------------------------------------------
// 'paused' (fuel-out) — no payload; slot resumes on next session.run.
// ---------------------------------------------------------------------------

Deno.test('safepoint audit / EXIT_PAUSED_FUEL: GC at fuel-out boundary is safe', () => {
  const session = freshSession();

  // Tight arithmetic loop — many instructions, will exhaust small fuel.
  parseAndSetup(session, `
    let total = 0;
    for (let i = 0; i < 100; i = i + 1) {
      total = total + i;
    }
  `);

  // Run with tight fuel to force fuel-out, GC, then resume.
  let result = session.run(0, 50);
  while (result.status === 'paused') {
    session.gc();
    result = session.run(0, 50);
  }

  // 0+1+...+99 = 4950
  assertEquals(session.get(0, 'total'), 4950);
});

// ---------------------------------------------------------------------------
// Terminal exits (`done`, `error`, `throw`) — slot is no longer
// running. GC after a terminal exit should be safe; the slot's
// state is whatever the WAT left behind (and is walked).
// ---------------------------------------------------------------------------

Deno.test('safepoint audit / terminal exits: GC after done / error / throw is safe', () => {
  // 'done': normal completion.
  {
    const session = freshSession();
    parseAndSetup(session, `let x = 1 + 2;`);
    session.run(0, 1000);
    session.gc();
    assertEquals(session.get(0, 'x'), 3);
  }

  // 'error': interpreter-detected error (e.g., undefined variable).
  {
    const session = freshSession();
    parseAndSetup(session, `let x = nonExistentVar;`);
    try { session.run(0, 1000); } catch (e) {
      if (!(e instanceof UncaughtScriptError)) throw e;
    }
    session.gc();
    assertEquals(session.memoryImage.getExitCondition(0), EXIT_ERROR);
  }

  // 'throw': user-thrown exception that escapes.
  {
    const session = freshSession();
    parseAndSetup(session, `throw new Error('user threw');`);
    try { session.run(0, 1000); } catch (e) {
      if (!(e instanceof UncaughtScriptError)) throw e;
    }
    session.gc();
    assertEquals(session.memoryImage.getExitCondition(0), EXIT_ERROR);
  }
});

// ===========================================================================
// Value-coverage regressions: markValue/updateValuePointer once omitted
// TYPE.PROMISE and TYPE.EXPRESSION. markPromise/updatePromisePointers carried
// reduced copies of the value switch, misdispatching typed arrays as header
// pointers and skipping BigInt, Map, and other types. Promise.all's pending
// aggregator also hid the results-array header inside an INTEGER-typed value
// slot. These tests explicitly enable pre/post heap-walk, context-roots, and
// setMark header verification, so a regression fails at the collection that
// creates it rather than at a later collection.
// ===========================================================================

Deno.test('value coverage: unawaited promise binding survives GC', async () => {
  const session = freshSession();
  session.collector.verifyAfterCollect = true;

  parseAndSetup(session, `
    let p = Promise.resolve(42);
    let junk = [];
    for (let i = 0; i < 50; i = i + 1) { junk.push({ pad: "x" + i }); }
    junk = null;
    let result = null;
    async function main() { result = await p; }
    main();
  `);

  await runToCompletionWithGc(session, (s) => s.gc());
  assertEquals(session.get(0, 'result'), 42);
});

Deno.test('value coverage: promise resolving a typed array survives GC', async () => {
  const session = freshSession();
  session.collector.verifyAfterCollect = true;
  const { airlock, id } = setupHandle(session, 'Api');
  airlock.setHandler(id, 'bytes', () => new Uint8Array([1, 2, 3]));

  parseAndSetup(session, `
    let p = Promise.resolve(Api.bytes());
    let junk = [];
    for (let i = 0; i < 50; i = i + 1) { junk.push({ pad: "y" + i }); }
    junk = null;
    let result = null;
    async function main() {
      let arr = await p;
      result = arr[0] + arr[1] + arr[2];
    }
    main();
  `);

  await runToCompletionWithGc(session, (s) => s.gc());
  assertEquals(session.get(0, 'result'), 6);
});

Deno.test('value coverage: symbolic expression binding survives GC', async () => {
  const session = freshSession();
  session.collector.verifyAfterCollect = true;

  parseAndSetup(session, `
    let e = Exact.Expression.add(Exact.Pi, 1n);
    let junk = [];
    for (let i = 0; i < 50; i = i + 1) { junk.push({ pad: "z" + i }); }
    junk = null;
  `);
  let result = session.run(0, 100000);
  assertEquals(result.status, 'done');

  // Two collections: the first may move the expression (binding must
  // forward), the second walks the binding again (must still be a live
  // OBJ.EXPRESSION — the audits throw otherwise).
  session.gc();
  session.gc();

  // The binding is still usable after both collections.
  parseAndSetup(session, `let e2 = e;`);
  result = session.run(0, 100000);
  assertEquals(result.status, 'done');
  session.gc();
});

Deno.test('value coverage: Promise.all pending aggregator survives GC at every boundary', async () => {
  // The aggregate promise stays PENDING across boundaries while its
  // elements settle via linked promises; the stashed results array must
  // survive (and forward through) every collection in between. This is
  // the deterministic pin for the disguised-pointer stash.
  const session = freshSession();
  session.collector.verifyAfterCollect = true;
  const { airlock, id } = setupHandle(session, 'Api');
  airlock.setHandler(id, 'a', () => Promise.resolve('alpha'));
  airlock.setHandler(id, 'b', () => Promise.resolve('beta'));
  airlock.setHandler(id, 'c', () => Promise.resolve('gamma'));

  parseAndSetup(session, `
    let result;
    async function main() {
      result = await Promise.all([Api.a(), Api.b(), Api.c()]);
    }
    main();
  `);

  await runToCompletionWithGc(session, (s) => s.gc());
  assertEquals(session.get(0, 'result'), ['alpha', 'beta', 'gamma']);
});

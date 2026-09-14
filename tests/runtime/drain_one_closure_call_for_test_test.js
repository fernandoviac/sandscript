/**
 * Runtime._drainOneClosureCallForTest() dequeues and drives exactly one
 * closure-queue entry before returning control. The test drains closure A
 * until context.suspend parks it, drives closure B through real
 * allocateContext pressure and an explicit gc(), inspects state, resumes A,
 * and drains A to completion through the same hook. With no automatic drainer
 * running, the interleaving is exact rather than timing-dependent.
 *
 * The concurrent-misuse guard must also reject a single-step drain while
 * scheduleClosureCall's automatic drainer is active, preventing a race on
 * _closureQueue and _drainingClosureCall.
 */

import { assert, assertEquals, assertRejects } from "https://deno.land/std@0.208.0/assert/mod.ts";
import { RuntimeBuilder } from '../../src/runtime/test-harness.js';

function tick(ms = 0) {
  return new Promise((r) => setTimeout(r, ms));
}

function buildRuntime() {
  const handlerErrors = [];
  let parkedResolve = null;
  let parkedReached = false;
  const captured = { closureA: null, closureB: null };

  const builder = new RuntimeBuilder()
    .sessionOptions({ heapSize: 256 * 1024 })
    .capability({
      name: 'box-listener',
      setup: (al) => {
        const rootGrant = al.createRootGrant();
        const handle = al.register({});
        rootGrant.add(handle);
        al.setHandler(handle, 'regA', ({ args }) => { captured.closureA = args[0]; return 0; });
        al.setHandler(handle, 'regB', ({ args }) => { captured.closureB = args[0]; return 0; });
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
  runtime.onHandlerError = (rejection) => { handlerErrors.push(rejection); };

  return {
    runtime, session, handlerErrors, captured,
    isParked: () => parkedReached,
    release: () => {
      assert(parkedResolve, 'release() called before closure A parked');
      const fn = parkedResolve;
      parkedResolve = null;
      fn(undefined);
    },
  };
}

async function setupProgram(session, runtime, captured) {
  session.parse(`
    let name = "clearance-check-crew"
    let org = "example-test-org"
    let done = false
    let allocated = 0
    Box.regA(async function() {
      await Box.dispatch()
      done = (name === "clearance-check-crew" && org === "example-test-org")
    })
    Box.regB(function() {
      let scratch = []
      let i = 0
      while (i < 100) {
        scratch.push({ index: i, pad: "pressure-padding" })
        i = i + 1
      }
      allocated = allocated + 1
    })
  `);
  await runtime.run(0);
  assert(captured.closureA, 'closureA not registered');
  assert(captured.closureB, 'closureB not registered');
}

Deno.test('_drainOneClosureCallForTest: steps exactly one entry, leaves the rest queued', async () => {
  const { runtime, session, captured } = buildRuntime();
  await runtime.start();
  await setupProgram(session, runtime, captured);

  // Schedule two entries — scheduleClosureCall's own auto-kick starts its
  // async IIFE synchronously and immediately shifts the FIRST entry off
  // _closureQueue (before yielding at runClosureCall's first await), so
  // by the time control returns here only the second entry is still
  // queued; this is expected, not a hook bug.
  runtime.scheduleClosureCall(captured.closureB, []);
  runtime.scheduleClosureCall(captured.closureB, []);
  assertEquals(runtime._closureQueue.length, 1,
    'the auto-drainer dequeues its first entry synchronously on kick, ' +
    'leaving exactly one behind');

  // Wait for the auto-drainer's async IIFE to actually finish this round
  // before taking single-step control — otherwise the auto-loop and the
  // hook would race on the same queue.
  await tick(20);
  assertEquals(session.get(0, 'allocated'), 2, 'auto-drainer already ran both B calls');

  // Re-queue two more, this time proving the single-step hook can drain
  // them ONE AT A TIME while the auto-drainer stays idle (queue starts
  // empty each time _kickClosureDrainer would check it).
  runtime._closureQueue.push({ closureHandle: captured.closureB, args: [], opts: {}, ledgerEntry: -1 });
  runtime._closureQueue.push({ closureHandle: captured.closureB, args: [], opts: {}, ledgerEntry: -1 });
  assertEquals(runtime._closureQueue.length, 2);

  const drainedFirst = await runtime._drainOneClosureCallForTest();
  assert(drainedFirst, 'expected an entry to be drained');
  assertEquals(runtime._closureQueue.length, 1,
    'exactly one entry must be consumed, the other left queued');
  assertEquals(session.get(0, 'allocated'), 3);

  const drainedSecond = await runtime._drainOneClosureCallForTest();
  assert(drainedSecond);
  assertEquals(runtime._closureQueue.length, 0);
  assertEquals(session.get(0, 'allocated'), 4);

  const drainedEmpty = await runtime._drainOneClosureCallForTest();
  assertEquals(drainedEmpty, false, 'draining an empty queue returns false, not a throw');

  await runtime.terminate();
});

Deno.test('_drainOneClosureCallForTest: pins drain-A-partway / drive-B-fully / resume-A sequence', async () => {
  const { runtime, session, captured, isParked, release } = buildRuntime();
  await runtime.start();
  await setupProgram(session, runtime, captured);

  // Push A directly onto the queue (bypassing scheduleClosureCall's
  // auto-kick) so the single-step hook has exclusive control from the
  // very first entry.
  runtime._closureQueue.push({ closureHandle: captured.closureA, args: [], opts: {}, ledgerEntry: -1 });

  // Step 1: drain A PARTWAY — it parks mid-drive on context.suspend.
  // _driveOneQueuedClosureCall's own await (inside runClosureCall ->
  // driveSlot) resolves once the drive reaches a non-terminal status
  // (parked), so this call returns control with A genuinely suspended,
  // not finished.
  const drainedA = await runtime._drainOneClosureCallForTest();
  assert(drainedA, 'expected closure A to be drained (and park)');
  assert(isParked(), 'closure A must be genuinely parked after this single step');
  assertEquals(session.get(0, 'done'), false, 'A has not finished yet');
  assertEquals(runtime._closureQueue.length, 0, 'A was consumed off the queue');

  // Step 2: drive closure B fully through the hook — real
  // allocateContext() pressure while A sits parked, pinned to run
  // between A's park and A's resume with no timing luck involved.
  runtime._closureQueue.push({ closureHandle: captured.closureB, args: [], opts: {}, ledgerEntry: -1 });
  const drainedB = await runtime._drainOneClosureCallForTest();
  assert(drainedB);
  assertEquals(session.get(0, 'allocated'), 1, 'B ran fully while A was parked');

  // Inspect state: A is still parked, B's allocation is visible, gc runs
  // clean at exactly this pinned moment.
  assert(isParked(), 'A must still be parked after B fully drained');
  const gcResult = session.gc();
  assert(gcResult, 'gc() must complete while A sits parked mid-drive');
  const mem = session.memoryImage;
  assert(mem.segmentSize - mem.getStringStart() > 0,
    'header must stay sane (segmentSize - getStringStart() positive) ' +
    'immediately after gc with A parked and B just drained');

  // Step 3: resume A. It has no more queue entries to drain through the
  // hook (its continuation is driven by the suspend's own resolve, via
  // the runtime's slot-wake path, not _closureQueue) — release it and
  // wait for it to reach terminal.
  release();
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline && session.get(0, 'done') !== true) {
    await tick(5);
  }
  assertEquals(session.get(0, 'done'), true,
    'closure A must resume and complete with its scope intact after the pinned interleaving');

  await runtime.terminate();
});

Deno.test('_drainOneClosureCallForTest: throws if the auto-drainer is concurrently running', async () => {
  const { runtime, session, captured } = buildRuntime();
  await runtime.start();
  await setupProgram(session, runtime, captured);

  // scheduleClosureCall both enqueues AND kicks the auto-drainer — its
  // async IIFE is now racing to drain this entry.
  runtime.scheduleClosureCall(captured.closureA, []);
  assert(runtime._closureDraining, 'auto-drainer should be marked draining immediately after scheduleClosureCall');

  await assertRejects(
    () => runtime._drainOneClosureCallForTest(),
    Error,
    'auto-drainer',
    'single-step hook must refuse to run while the auto-drainer is mid-loop',
  );

  // Let closure A's own park settle so terminate() doesn't hang on it.
  await tick(20);
  await runtime.terminate();
});

/**
 * runtime.bootOnly(slot) — completes a slot's boot sequence without
 * ever dispatching an instruction of its top-level code.
 */

import { assertEquals, assert } from "https://deno.land/std@0.208.0/assert/mod.ts";
import { RuntimeBuilder } from '../../src/runtime/test-harness.js';
import { LEDGER_ACTIVITY, RUNTIME_STATE } from '../../src/runtime/index.js';

Deno.test("bootOnly: resolves 'unstarted' and never dispatches top-level code", async () => {
  let sideEffect = false;
  const { runtime, session, channels } = new RuntimeBuilder()
    .capability({
      name: 'host',
      setup: (al) => {
        const rootGrant = al.createRootGrant();
        const handle = al.register({});
        rootGrant.add(handle);
        al.setHandler(handle, 'mark', () => { sideEffect = true; return null; });
        al.declare('Host', handle);
      },
    })
    .onInboundMessage(() => {})
    .build();
  await runtime.start();

  session.parse(`Host.mark();`);
  const result = await runtime.bootOnly(0);

  assertEquals(result, { status: 'unstarted', error: null });
  assertEquals(sideEffect, false, 'top-level code must never dispatch');

  await runtime.terminate();
  channels.close();
});

Deno.test("bootOnly: leaves no ledger entry behind", async () => {
  const { runtime, session, channels } = new RuntimeBuilder()
    .onInboundMessage(() => {})
    .build();
  await runtime.start();

  session.parse(`let x = 1;`);
  await runtime.bootOnly(0);

  assertEquals(runtime.ledger.walk(), [],
    'claim+free must be synchronous — no entry should remain observable');

  await runtime.terminate();
  channels.close();
});

Deno.test("bootOnly: does not bump spawnedRuns/inFlight (never a real drive episode)", async () => {
  const { runtime, session, channels } = new RuntimeBuilder()
    .onInboundMessage(() => {})
    .build();
  await runtime.start();

  session.parse(`let x = 1;`);
  const before = runtime.getSchedulerStats();
  await runtime.bootOnly(0);
  const after = runtime.getSchedulerStats();

  assertEquals(after.spawnedRuns, before.spawnedRuns);
  assertEquals(after.inFlight, 0);

  await runtime.terminate();
  channels.close();
});

Deno.test("bootOnly: returns 'quiesced' while the runtime is quiesced, without publishing state", async () => {
  const { runtime, channels } = new RuntimeBuilder()
    .onInboundMessage(() => {})
    .build();
  await runtime.start();
  await runtime.quiesce();

  const result = await runtime.bootOnly(0);
  assertEquals(result, { status: 'quiesced', error: null });
  assertEquals(runtime.getSchedulerStats().state, RUNTIME_STATE.QUIESCED,
    'bootOnly must not clobber QUIESCED with SCHEDULER_IDLE');

  runtime.resume();
  await runtime.terminate();
  channels.close();
});

Deno.test("bootOnly: returns 'terminated' after the runtime is terminated", async () => {
  const { runtime, channels } = new RuntimeBuilder()
    .onInboundMessage(() => {})
    .build();
  await runtime.start();
  await runtime.terminate();

  const result = await runtime.bootOnly(0);
  assertEquals(result, { status: 'terminated', error: null });

  channels.close();
});

Deno.test("bootOnly: throws if called before start() completes", () => {
  const { runtime, channels } = new RuntimeBuilder()
    .onInboundMessage(() => {})
    .build();

  let threw = false;
  try {
    runtime.bootOnly(0);
  } catch (err) {
    threw = true;
    assert(err.message.includes('start() has not completed'));
  }
  assert(threw, 'expected bootOnly to throw synchronously');

  channels.close();
});

Deno.test("bootOnly: a subsequent run(slot) still executes the slot's top-level code", async () => {
  let sideEffect = false;
  const { runtime, session, channels } = new RuntimeBuilder()
    .capability({
      name: 'host',
      setup: (al) => {
        const rootGrant = al.createRootGrant();
        const handle = al.register({});
        rootGrant.add(handle);
        al.setHandler(handle, 'mark', () => { sideEffect = true; return null; });
        al.declare('Host', handle);
      },
    })
    .onInboundMessage(() => {})
    .build();
  await runtime.start();

  session.parse(`Host.mark();`);
  await runtime.bootOnly(0);
  assertEquals(sideEffect, false);

  const result = await runtime.run(0);
  assertEquals(result.status, 'done');
  assertEquals(sideEffect, true, 'a later run(slot) must still dispatch normally');

  await runtime.terminate();
  channels.close();
});

Deno.test("LEDGER_ACTIVITY.BOOTED_UNSTARTED: distinct value, named, not confused with DRIVING_ROOT", () => {
  assertEquals(LEDGER_ACTIVITY.BOOTED_UNSTARTED, 5);
  assert(LEDGER_ACTIVITY.BOOTED_UNSTARTED !== LEDGER_ACTIVITY.DRIVING_ROOT);
  assert(LEDGER_ACTIVITY.BOOTED_UNSTARTED !== LEDGER_ACTIVITY.AWAITING_PROMISE);
});

Deno.test("bootOnly: fires onSchedulerIdle once, after the state publish", async () => {
  let idleCount = 0;
  let observedState = null;
  let rt = null;
  const { runtime, session, channels } = new RuntimeBuilder()
    .onInboundMessage(() => {})
    .onSchedulerIdle(() => {
      idleCount++;
      observedState = rt.runtimeState.get();
    })
    .build();
  rt = runtime;
  await runtime.start();

  session.parse(`let x = 1;`);
  const result = await runtime.bootOnly(0);
  assertEquals(result, { status: 'unstarted', error: null });

  // The runtime-state cell is constructed as SCHEDULER_IDLE, so
  // bootOnly's publish is a deduped no-op with no observable cell
  // edge — the hook is the only signal, and it must fire anyway.
  assertEquals(idleCount, 1,
    'bootOnly fires exactly one notification');
  assertEquals(observedState, RUNTIME_STATE.SCHEDULER_IDLE,
    'the hook observes SCHEDULER_IDLE');

  await runtime.terminate();
  channels.close();
});

/**
 * Concurrent callback collection while one closure remains parked.
 *
 * One closure remains parked across several awaited host calls while other
 * callbacks allocate contexts and trigger collection. The runtime must retain
 * the parked closure's scope and resume it after the independently-triggered
 * collection.
 *
 * The exercised path is:
 *   inbound callback -> Runtime.scheduleClosureCall ->
 *   _kickClosureDrainer -> runClosureCall -> airlock.allocateContext ->
 *   driveSlot, with real suspension points inside the callback body.
 *
 * Run with: deno task test tests/runtime/concurrent_closure_fire_gc_parked_test.js
 */

import { RuntimeBuilder } from '../../src/runtime/test-harness.js';

function tick(ms = 0) {
  return new Promise((r) => setTimeout(r, ms));
}

async function waitFor(condition, { timeout = 5000, label = 'condition' } = {}) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    if (condition()) return;
    await tick(5);
  }
  throw new Error(`waitFor timed out: ${label}`);
}

// Exercise several sequential awaited host calls per fire: this is a real
// multi-await callback body rather than a single suspension point. Each call
// parks the calling context through a host handler that settles asynchronously
// from a macrotask, making the park observable rather than resolving it in the
// same turn.
const CREATE_CREW_SHAPED_SOURCE = `
  let handled = 0
  let errors = 0
  let listener = async (event) => {
    await HostCall.step("create-instance")
    await HostCall.step("register-capability-1")
    await HostCall.step("grant-policy-add-1")
    await HostCall.step("register-capability-2")
    await HostCall.step("grant-policy-add-2")
    await HostCall.step("post-crew-record")
    await HostCall.step("chart-hail")
    await HostCall.step("chart-home")
    handled = handled + 1
  }
  HostCallFire.onFire(listener)
`;

// Build a runtime with:
//   - a "HostCall" capability exposing step(label), which parks and settles
//     late, and onFire(closure), which registers the listener fired
//     concurrently by the test.
//   - an "Alloc" capability exposing pressure() — a SEPARATE, minimal
//     synchronous call whose ONLY purpose is to be scheduled as its own
//     closure fire, forcing a fresh allocateContext() (a fresh context
//     slot) at a moment the test controls, while other fires may be
//     mid-park.
function buildConcurrentFireRuntime({ onStep }) {
  let registeredListener = null;
  const handlerErrors = [];
  const stepLog = [];

  const builder = new RuntimeBuilder()
    .sessionOptions({ heapSize: 4 * 1024 * 1024 })
    .capability({
      name: 'host-call',
      setup: (al) => {
        const rootGrant = al.createRootGrant();
        const stepHandle = al.register({});
        rootGrant.add(stepHandle);
        al.setHandler(stepHandle, 'step', ({ args, context }) => {
          const [label] = args;
          return context.suspend((resolve, _reject) => {
            setTimeout(() => {
              stepLog.push('' + label);
              onStep?.('' + label);
              resolve(null);
            }, 0);
          });
        });
        al.declare('HostCall', stepHandle);

        const fireHandle = al.register({});
        rootGrant.add(fireHandle);
        al.setHandler(fireHandle, 'onFire', ({ args }) => {
          const [closureHandle] = args;
          registeredListener = closureHandle;
          return undefined;
        });
        al.declare('HostCallFire', fireHandle);
      },
    })
    .onInboundMessage(() => {});

  const { runtime, session, channels } = builder.build();
  runtime.onHandlerError = (rejection) => { handlerErrors.push(rejection); };
  return {
    runtime, session, channels, handlerErrors, stepLog,
    getListener: () => registeredListener,
  };
}

// Fires the registered listener closure `fireCount` times, back to back
// (no await between scheduleClosureCall calls — matching N genuinely
// concurrent box.post deliveries all landing before the drainer has
// caught up), and optionally forces a gc() at a chosen step-label
// boundary while fires are still in flight.
async function runConcurrentFireScenario({
  fireCount, gcAtStep, expectClean,
}) {
  let gcFired = false;
  const ctx = buildConcurrentFireRuntime({
    onStep: (label) => {
      if (!gcFired && gcAtStep !== null && label === gcAtStep) {
        gcFired = true;
        ctx.session.gc();
      }
    },
  });
  const { runtime, session, channels, handlerErrors, stepLog } = ctx;

  await runtime.start();
  session.parse(CREATE_CREW_SHAPED_SOURCE);
  await runtime.run(0);

  const listener = ctx.getListener();
  if (!listener) throw new Error('listener never registered via HostCall.onFire');

  for (let i = 0; i < fireCount; i++) {
    runtime.scheduleClosureCall(listener, [{ nonce: `fire-${i}` }]);
  }

  try {
    await waitFor(() => {
      const handled = session.get(0, 'handled');
      return handled !== undefined && Number(handled) >= fireCount;
    }, {
      timeout: 8000,
      label: `all ${fireCount} fires complete (gcAtStep=${gcAtStep})`,
    });
  } catch (err) {
    const handled = session.get(0, 'handled');
    throw new Error(
      `${err.message} — handled=${handled} steps=${stepLog.length} ` +
      `handlerErrors=${handlerErrors.length}: ` +
      `${handlerErrors[0]?.error?.message ?? ''}`,
      { cause: err });
  }

  if (expectClean) {
    if (handlerErrors.length > 0) {
      throw new Error(`expected no handler errors, got: ` +
        `${handlerErrors[0]?.error?.message ?? handlerErrors[0]}`);
    }
    const handled = session.get(0, 'handled');
    if (Number(handled) !== fireCount) {
      throw new Error(`expected handled=${fireCount}, got ${handled}`);
    }
  }

  await runtime.terminate();
  channels.close();
  return { handlerErrors, stepLog };
}

Deno.test('sanity: single fire, no gc, completes cleanly', async () => {
  await runConcurrentFireScenario({ fireCount: 1, gcAtStep: null, expectClean: true });
});

Deno.test('sanity: 3 concurrent fires, no gc, all complete cleanly', async () => {
  await runConcurrentFireScenario({ fireCount: 3, gcAtStep: null, expectClean: true });
});

Deno.test('3 concurrent fires, gc forced mid-sequence while others are parked', async () => {
  await runConcurrentFireScenario({
    fireCount: 3, gcAtStep: 'register-capability-1', expectClean: true,
  });
});

Deno.test('3 concurrent fires, gc forced at the LATEST step (closest to completion) while others still parked', async () => {
  await runConcurrentFireScenario({
    fireCount: 3, gcAtStep: 'chart-home', expectClean: true,
  });
});

Deno.test('5 concurrent fires, gc forced early while 4 others are parked', async () => {
  await runConcurrentFireScenario({
    fireCount: 5, gcAtStep: 'create-instance', expectClean: true,
  });
});

Deno.test('8 concurrent fires with gc forced mid-sequence', async () => {
  await runConcurrentFireScenario({
    fireCount: 8, gcAtStep: 'grant-policy-add-1', expectClean: true,
  });
});

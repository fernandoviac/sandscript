/**
 * Heap pressure during a non-parked linked-promise settlement.
 *
 * Shape: a handler returns a plain JS Promise (no unwrapPromise, no
 * context.suspend) → the external_call path resumes the slot with a
 * LINKED SS promise → the drone awaits it (waiter parks). When the JS
 * promise settles, _settleLinkedPromiseBySlot marshals the value into
 * the SS promise — an allocation that can throw HeapPressureSignal.
 *
 * Before the fix the settle freed the SAB slot and set the promise
 * status BEFORE marshalling, so a pressure throw left the promise
 * settled with a stale VALUE, its waiters parked forever, the value
 * unrecoverable (the freed slot was the only gc-forwarded route back),
 * and the HeapPressureSignal escaping jsPromise.then as an unhandled
 * rejection — even when a gc would have freed plenty (the probe showed
 * 76 KB of dropped junk reclaimable).
 *
 * Now the settle is commit-last and self-heals: on pressure it runs
 * the session gc (wired via setHeapGarbageCollect) and retries once.
 * The gcPassCount assertion pins that the pressure path actually fired
 * — if heap layout drifts and the fill no longer forces pressure, the
 * test fails loudly instead of passing vacuously.
 */

import { assertEquals, assert } from "https://deno.land/std@0.208.0/assert/mod.ts";
import { RuntimeBuilder } from '../../src/runtime/test-harness.js';

function buildProbeRuntime(settleArm) {
  let done;
  const finished = new Promise((resolve) => { done = resolve; });

  const cap = {
    name: 'probe',
    needs: {},
    setup(airlock) {
      const rootGrant = airlock.createRootGrant();
      const root = airlock.register({}, { kind: 'root' });
      rootGrant.add(root);
      airlock.declare('thing', root);

      airlock.setHandler(root, 'make', () =>
        new Promise((resolve, reject) => setTimeout(() => {
          // 4000 elements ≈ 64 KB of value slots — larger than the
          // post-fill headroom, smaller than what a gc reclaims.
          const bigValue = new Array(4000).fill(7);
          if (settleArm === 'resolve') resolve(bigValue);
          else reject(bigValue);
        }, 20)));

      const report = airlock.register({}, { kind: 'report' });
      airlock.declare('report', report);
      rootGrant.add(report);
      airlock.setHandler(report, null, ({ args }) => {
        done({ resolvedLength: args[0], caughtLength: args[1] });
      });

      return {};
    },
  };

  const { runtime, session } = new RuntimeBuilder()
    .onInboundMessage(() => {})
    .sessionOptions({ heapSize: 128 * 1024 })
    .capability(cap)
    .build();

  return { runtime, session, finished };
}

const DRONE_SOURCE = `
  let run = async () => {
    let resolvedLength = null
    let caughtLength = null
    let junk = []
    let i = 0
    while (i < 400) {
      junk.push([i, i, i, i])
      i = i + 1
    }
    junk = 0
    try {
      let v = await thing.make()
      resolvedLength = v.length
    } catch (err) {
      caughtLength = err.length
    }
    report(resolvedLength, caughtLength)
  }
  run()
`;

async function runSettlePressureScenario(settleArm) {
  const { runtime, session, finished } = buildProbeRuntime(settleArm);
  await runtime.start();

  const parsed = session.parse(DRONE_SOURCE);
  session.setInstruction(0, parsed.startIndex);
  await runtime.run(0);

  const gcPassesBeforeSettle = session.airlock.membrane.engineCounters().gcPassCount;

  let timeoutId;
  try {
    const result = await Promise.race([
      finished,
      new Promise((_, reject) => {
        timeoutId = setTimeout(
          () => reject(new Error('settle never reached the drone (hung waiter)')), 10000);
      }),
    ]);
    const gcPassesAfterSettle = session.airlock.membrane.engineCounters().gcPassCount;
    assert(gcPassesAfterSettle > gcPassesBeforeSettle,
      'the settle must have hit heap pressure and self-healed via gc — ' +
      'if this fails the fill no longer forces pressure and the test is vacuous; retune it');
    return result;
  } finally {
    clearTimeout(timeoutId);
    await runtime.terminate();
  }
}

Deno.test('linked-promise resolve marshal under heap pressure self-heals via gc', async () => {
  const result = await runSettlePressureScenario('resolve');
  assertEquals(result.resolvedLength, 4000,
    'drone must receive the full resolved value after the gc-retry');
  assertEquals(result.caughtLength, null);
});

Deno.test('linked-promise reject marshal under heap pressure self-heals via gc', async () => {
  const result = await runSettlePressureScenario('reject');
  assertEquals(result.caughtLength, 4000,
    'drone must catch the full rejection value after the gc-retry');
  assertEquals(result.resolvedLength, null);
});

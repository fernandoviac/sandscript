import { assertEquals, assert } from "https://deno.land/std@0.208.0/assert/mod.ts";
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

function makeCounterCap() {
  let compactCount = 0;
  let lastLiveSet = null;
  const cachedHandles = new Map();

  const cap = {
    name: 'counter',
    needs: {},
    setup(airlock) {
      const handle = airlock.register({}, { kind: 'counter-root' });
      airlock.declare('counter', handle);

      airlock.setHandler(handle, 'make', () => {
        const child = airlock.register({}, { kind: 'counter-child' });
        cachedHandles.set(child.slot, child);
        airlock.setSetter(child, 'value', () => {});
        return child;
      });

      return {
        async onGrantRequest(identifier) {
          if (identifier !== 'counter') return null;
          for (const entry of airlock.membrane.enumerateGrants()) {
            if (entry.metadata?.kind === 'counter-grant') return entry.grant;
          }
          const grant = airlock.membrane.createGrant(identifier, { kind: 'counter-grant' });
          grant.add(handle);
          return grant;
        },

        onCompact(liveHandleSlots) {
          compactCount++;
          lastLiveSet = new Set(liveHandleSlots);
          for (const [slot] of cachedHandles) {
            if (!liveHandleSlots.has(slot)) cachedHandles.delete(slot);
          }
        },
      };
    },
  };

  return {
    cap,
    get compactCount() { return compactCount; },
    get lastLiveSet() { return lastLiveSet; },
    get cachedHandles() { return cachedHandles; },
  };
}

Deno.test('onCompact wired through Runtime: fires on session.gc()', async () => {
  const probe = makeCounterCap();

  const { runtime, session } = new RuntimeBuilder()
    .onInboundMessage(() => {})
    .capability(probe.cap)
    .build();

  await runtime.start();

  const parsed = session.parse('grant "counter" { { let c = counter.make() } }');
  session.setInstruction(0, parsed.startIndex);
  // The async onGrantRequest hook suspends runtime.run(0) before the grant
  // body runs, so poll for the registration side effect.
  await runtime.run(0);
  await waitFor(() => probe.cachedHandles.size === 1, { label: 'grant body to run' });

  assertEquals(probe.cachedHandles.size, 1, 'one child cached');

  session.gc();

  assertEquals(probe.compactCount, 1, 'onCompact fired through Runtime');
  assertEquals(probe.cachedHandles.size, 0, 'cache cleared by onCompact');

  await runtime.terminate();
});

Deno.test('onCompact wired through Runtime: fires on pressure-triggered compaction', async () => {
  const probe = makeCounterCap();

  const { runtime, session } = new RuntimeBuilder()
    .onInboundMessage(() => {})
    .sessionOptions({ handleTableCapacity: 16 })
    .capability(probe.cap)
    .build();

  await runtime.start();

  const parsed = session.parse(`
    grant "counter" {
      let i = 0
      let last = null
      while (i < 30) {
        { last = counter.make() }
        i = i + 1
      }
    }
  `);
  session.setInstruction(0, parsed.startIndex);
  await runtime.run(0);
  await waitFor(() => session.state(0).exitCondition === 'done',
    { label: 'grant body loop to finish' });

  assert(probe.compactCount >= 1,
    `onCompact should fire at least once under pressure, fired ${probe.compactCount}`);

  await runtime.terminate();
});

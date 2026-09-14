/**
 * Consumed-fuel reporting at the await/suspend/async drive-episode
 * boundaries, and the membrane cost-ledger wiring.
 *
 * Pre-existing gap (fixed here): driveLoop returned at 'await' /
 * 'suspended' / 'async_complete' / 'async_rejected' WITHOUT reporting
 * the fuel consumed before the park. The common "compute then
 * await T.suspend(...)" shape therefore dropped all pre-await fuel —
 * it was accumulated into consumedThisDrive, then discarded when the
 * slot re-drove with a fresh accumulator. Now every episode boundary
 * reports its consumed fuel (via the lifecycle event AND the return
 * value), and every boundary also lands a kind:FUEL entry in the
 * membrane cost ledger.
 *
 * Run with: deno task test tests/runtime/consumed_fuel_park_test.js
 */

import { assertEquals, assert } from "https://deno.land/std@0.208.0/assert/mod.ts";
import { RuntimeBuilder } from '../../src/runtime/test-harness.js';
import { COST_KIND, HEADER } from '../../src/membrane/index.js';
import { createCostLedgerView } from '../../src/runtime/cost-ledger.js';

// Read the membrane cost ledger through the one bounded validated
// decoder, the way any out-of-realm holder does.
function readCostEntries(membrane) {
  const header = new DataView(membrane.buffer, membrane.byteOffset);
  return createCostLedgerView({
    buffer: membrane.buffer,
    byteOffset: membrane.byteOffset + header.getUint32(HEADER.COST_LEDGER_OFFSET, true),
    capacity:   header.getUint32(HEADER.COST_LEDGER_CAPACITY, true),
    writeIndex: header.getUint32(HEADER.COST_LEDGER_WRITE_INDEX, true),
    segmentGeneration: header.getUint32(
      HEADER.COST_LEDGER_SEGMENT_GENERATION, true),
    flags: header.getUint32(HEADER.COST_LEDGER_FLAGS, true),
  }).walk(0);
}

function tick(ms = 0) { return new Promise(r => setTimeout(r, ms)); }

// A capability with a suspending method: `await T.suspend(n)` parks the
// slot (status 'suspended'), then resolves on a later turn.
function buildSuspendCap() {
  return {
    name: 'test',
    needs: {},
    setup(airlock) {
      const handle = airlock.register({});
      airlock.setHandler(handle, 'suspend', ({ args, context }) =>
        context.suspend((resolve) => { setTimeout(() => resolve(args[0] * 10), 0); }));
      airlock.declare('T', handle);
      const grant = airlock.membrane.createGrant('test');
      grant.add(handle);
      return { onGrantRequest(id) { return id === 'test' ? grant : null; } };
    },
  };
}

// Burn a meaningful amount of fuel, THEN await a suspending call (inside
// the grant the suspend method requires). The loop guarantees
// consumedThisDrive > 0 at the suspend boundary.
const COMPUTE_THEN_AWAIT =
  'grant "test" { ' +
  '  let total = 0; for (let i = 0; i < 2000; i = i + 1) { total = total + i } ' +
  '  let x = await T.suspend(5) ' +
  '}';

Deno.test('suspend boundary: lifecycle event + return carry pre-await consumed fuel', async () => {
  const lifecycle = [];
  const { runtime, session } = new RuntimeBuilder()
    .capability(buildSuspendCap())
    .onInboundMessage(() => {})
    .onHandlerError(() => {})
    .fuel(100000)   // generous; the await, not fuel, ends the episode
    .build();
  runtime.onSlotLifecycle = (ev) => lifecycle.push(ev);
  await runtime.start();

  const parsed = session.parse(COMPUTE_THEN_AWAIT);
  session.setInstruction(0, parsed.startIndex);
  const result = await runtime.run(0);

  // The first episode ends parked at the suspending call.
  assertEquals(result.status, 'suspended');
  assert(
    typeof result.consumedFuel === 'number' && result.consumedFuel > 0,
    `suspend return must carry pre-await consumed fuel, got ${result.consumedFuel}`,
  );
  const ev = lifecycle.find((e) => e.kind === 'suspended');
  assert(ev, 'a suspended lifecycle event should have fired');
  assert(
    typeof ev.consumedFuel === 'number' && ev.consumedFuel > 0,
    `suspended event must carry consumed fuel, got ${ev?.consumedFuel}`,
  );
  await runtime.terminate();
});

Deno.test('cost ledger: a fuel drive lands a kind:FUEL entry in the membrane', async () => {
  const lifecycle = [];
  const { runtime, session } = new RuntimeBuilder()
    .onInboundMessage(() => {})
    .fuel(100000)
    .build();
  runtime.onSlotLifecycle = (ev) => lifecycle.push(ev);
  await runtime.start();

  const parsed = session.parse(
    'let total = 0; for (let i = 0; i < 2000; i = i + 1) { total = total + i }');
  session.setInstruction(0, parsed.startIndex);
  const result = await runtime.run(0);
  assertEquals(result.status, 'done');

  // The drive's consumed fuel must have been appended to the cost ledger.
  const entries = readCostEntries(session.airlock.membrane);
  const fuelEntries = entries.filter((e) => e.kind === COST_KIND.FUEL);
  assert(fuelEntries.length >= 1, `expected a FUEL entry, got ${entries.length} entries`);
  const total = fuelEntries.reduce((s, e) => s + e.fuel, 0n);
  assert(total > 0n, `FUEL entry should record positive consumed fuel, got ${total}`);
  // The ledger total matches the consumed fuel reported on the done event.
  const done = lifecycle.find((e) => e.kind === 'done');
  assert(done, 'a done lifecycle event should have fired');
  assertEquals(total, BigInt(done.consumedFuel));
  await runtime.terminate();
});

Deno.test('cost ledger: the suspend episode lands its pre-await fuel as an entry', async () => {
  const { runtime, session } = new RuntimeBuilder()
    .capability(buildSuspendCap())
    .onInboundMessage(() => {})
    .onHandlerError(() => {})
    .fuel(100000)
    .build();
  await runtime.start();

  const parsed = session.parse(COMPUTE_THEN_AWAIT);
  session.setInstruction(0, parsed.startIndex);
  const result = await runtime.run(0);
  assertEquals(result.status, 'suspended');

  const entries = readCostEntries(session.airlock.membrane);
  const fuelEntries = entries.filter((e) => e.kind === COST_KIND.FUEL);
  assert(fuelEntries.length >= 1, 'suspend episode should have appended a FUEL entry');
  const total = fuelEntries.reduce((s, e) => s + e.fuel, 0n);
  // Pre-await compute is real and must be recorded, not dropped.
  assertEquals(total, BigInt(result.consumedFuel));
  assert(total > 0n, 'pre-await fuel must be recorded, not dropped');
  await runtime.terminate();
});

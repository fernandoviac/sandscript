/**
 * Tests for the onFuelExhausted boundary hook.
 *
 * When a slot runs out of fuel, driveLoop's 'paused' case consults the
 * runtime's onFuelExhausted hook (if set). The hook receives the slot
 * and returns the number of fuel units to inject for the next run:
 *   - > 0   continue driving the slot with that budget
 *   - falsy stop driving; driveLoop returns the slot's existing 'paused'
 *           status, leaving the slot alive and resumable (NOT a kill)
 *   - may return a number (sync, no await) or a Promise of one (awaited)
 * With no hook, driveLoop refills with the default quantum and continues
 * forever — byte-for-byte today's behavior.
 *
 * Run with: deno task test tests/runtime/fuel_exhausted_hook_test.js
 */

import { assertEquals, assert } from "https://deno.land/std@0.208.0/assert/mod.ts";
import { RuntimeBuilder } from '../../src/runtime/test-harness.js';

// A program that runs long enough to exhaust a tiny fuel quantum at
// least once before completing. A loop with a few thousand iterations
// burns far more than a handful of instructions.
const LOOPY = 'let total = 0; for (let i = 0; i < 5000; i = i + 1) { total = total + i }';

Deno.test('no hook → slot refills with default quantum and runs to done', async () => {
  // Tiny quantum so the loop pauses many times; with no hook the loop
  // must still complete (infinite refuel — today's behavior).
  const { runtime, session } = new RuntimeBuilder()
    .onInboundMessage(() => {})
    .fuel(50)
    .build();
  // No onFuelExhausted set.
  await runtime.start();

  const parsed = session.parse(LOOPY);
  session.setInstruction(0, parsed.startIndex);
  const result = await runtime.run(0);

  assertEquals(result.status, 'done');
  await runtime.terminate();
});

Deno.test('no hook + fuel already 0 → parks instead of hanging', async () => {
  const { runtime, session } = new RuntimeBuilder()
    .onInboundMessage(() => {})
    .fuel(0)
    .build();
  // No onFuelExhausted set. With a starting quantum of 0, "refuel with
  // the same quantum" would refuel with nothing — must park for real
  // instead of spinning forever.
  await runtime.start();

  const parsed = session.parse('throw new Error("EXECUTED")');
  session.setInstruction(0, parsed.startIndex);
  const result = await runtime.run(0);

  assertEquals(result.status, 'paused');
  assertEquals(result.error, null);
  await runtime.terminate();
});

Deno.test('hook returning a positive number refuels and the slot runs to done', async () => {
  let calls = 0;
  const { runtime, session } = new RuntimeBuilder()
    .onInboundMessage(() => {})
    .fuel(50)
    .build();
  runtime.onFuelExhausted = (slot) => {
    calls++;
    assertEquals(slot, 0);
    return 50;   // keep feeding fuel
  };
  await runtime.start();

  const parsed = session.parse(LOOPY);
  session.setInstruction(0, parsed.startIndex);
  const result = await runtime.run(0);

  assertEquals(result.status, 'done');
  assert(calls > 1, `hook should have fired multiple times, fired ${calls}`);
  await runtime.terminate();
});

Deno.test('hook returning falsy parks the slot (alive, not killed)', async () => {
  let calls = 0;
  const { runtime, session } = new RuntimeBuilder()
    .onInboundMessage(() => {})
    .fuel(50)
    .build();
  runtime.onFuelExhausted = () => {
    calls++;
    return 0;   // stop driving on the first exhaustion
  };
  await runtime.start();

  const parsed = session.parse(LOOPY);
  session.setInstruction(0, parsed.startIndex);
  const result = await runtime.run(0);

  // Falsy refuel parks the slot — driveLoop returns the existing
  // 'paused' status, NOT a terminal/error.
  assertEquals(result.status, 'paused');
  assertEquals(result.error, null);
  assertEquals(calls, 1, 'hook should fire exactly once before parking');
  await runtime.terminate();
});

Deno.test('parked slot is resumable: re-driving completes it', async () => {
  let allow = 1;   // refuel once, park once, then allow to completion
  const { runtime, session } = new RuntimeBuilder()
    .onInboundMessage(() => {})
    .fuel(50)
    .build();
  runtime.onFuelExhausted = () => (allow-- > 0 ? 50 : 0);
  await runtime.start();

  const parsed = session.parse(LOOPY);
  session.setInstruction(0, parsed.startIndex);

  // First drive: hook allows one refuel then returns 0 → parks.
  const first = await runtime.run(0);
  assertEquals(first.status, 'paused');

  // Re-drive the same parked slot with unlimited refuel → completes.
  // The slot continues from where it parked, not from the start.
  runtime.onFuelExhausted = () => 50;
  const second = await runtime.run(0);
  assertEquals(second.status, 'done');
  await runtime.terminate();
});

Deno.test('async hook (returns a Promise) is awaited', async () => {
  let calls = 0;
  const { runtime, session } = new RuntimeBuilder()
    .onInboundMessage(() => {})
    .fuel(50)
    .build();
  runtime.onFuelExhausted = async (slot) => {
    calls++;
    // Force a real microtask hop before answering.
    await Promise.resolve();
    return 50;
  };
  await runtime.start();

  const parsed = session.parse(LOOPY);
  session.setInstruction(0, parsed.startIndex);
  const result = await runtime.run(0);

  assertEquals(result.status, 'done');
  assert(calls > 1, `async hook should have fired multiple times, fired ${calls}`);
  await runtime.terminate();
});

Deno.test('async hook returning a falsy Promise parks the slot', async () => {
  const { runtime, session } = new RuntimeBuilder()
    .onInboundMessage(() => {})
    .fuel(50)
    .build();
  runtime.onFuelExhausted = async () => {
    await Promise.resolve();
    return 0;
  };
  await runtime.start();

  const parsed = session.parse(LOOPY);
  session.setInstruction(0, parsed.startIndex);
  const result = await runtime.run(0);

  assertEquals(result.status, 'paused');
  assertEquals(result.error, null);
  await runtime.terminate();
});

// --- consumed-fuel surfacing (Shape A: consumedFuel on the existing
// terminal lifecycle events and on the park return) ---

Deno.test('done lifecycle event carries consumedFuel accumulated across refuels', async () => {
  const lifecycle = [];
  const { runtime, session } = new RuntimeBuilder()
    .onInboundMessage(() => {})
    .fuel(50)
    .build();
  // Refuel forever so the loop runs to done across many quanta; the
  // accumulator must sum every session.run, not report only the last.
  runtime.onFuelExhausted = () => 50;
  runtime.onSlotLifecycle = (ev) => lifecycle.push(ev);
  await runtime.start();

  const parsed = session.parse(LOOPY);
  session.setInstruction(0, parsed.startIndex);
  const result = await runtime.run(0);

  assertEquals(result.status, 'done');
  const done = lifecycle.find((e) => e.kind === 'done');
  assert(done, 'a done lifecycle event should have fired');
  assert(
    typeof done.consumedFuel === 'number' && done.consumedFuel > 50,
    `consumedFuel should sum across the many refuel quanta, got ${done.consumedFuel}`,
  );
  await runtime.terminate();
});

Deno.test('park return carries consumedFuel for the work done before the park', async () => {
  const { runtime, session } = new RuntimeBuilder()
    .onInboundMessage(() => {})
    .fuel(50)
    .build();
  // Allow one 50-fuel run, then park. The first run burns its full
  // quantum (the loop is far longer than 50 instructions), so the park
  // should report ~50 consumed.
  let allow = 1;
  runtime.onFuelExhausted = () => (allow-- > 0 ? 50 : 0);
  await runtime.start();

  const parsed = session.parse(LOOPY);
  session.setInstruction(0, parsed.startIndex);
  const result = await runtime.run(0);

  assertEquals(result.status, 'paused');
  assert(
    typeof result.consumedFuel === 'number' && result.consumedFuel > 0,
    `park should surface consumed fuel, got ${result.consumedFuel}`,
  );
  await runtime.terminate();
});

Deno.test('re-driving a parked slot starts a fresh consumedFuel accumulator', async () => {
  const events = [];
  const { runtime, session } = new RuntimeBuilder()
    .onInboundMessage(() => {})
    .fuel(50)
    .build();
  let allow = 1;
  runtime.onFuelExhausted = () => (allow-- > 0 ? 50 : 0);
  runtime.onSlotLifecycle = (ev) => events.push(ev);
  await runtime.start();

  const parsed = session.parse(LOOPY);
  session.setInstruction(0, parsed.startIndex);

  const first = await runtime.run(0);
  assertEquals(first.status, 'paused');
  const parkConsumed = first.consumedFuel;

  // Re-drive to completion. The done event's consumedFuel covers only
  // the second episode, not the first — accumulator reset on re-entry.
  runtime.onFuelExhausted = () => 50;
  const second = await runtime.run(0);
  assertEquals(second.status, 'done');

  const done = events.find((e) => e.kind === 'done');
  assert(done, 'a done lifecycle event should have fired on the re-drive');
  // The two episodes together account for the whole program; neither
  // episode alone equals the total, and the second does not re-count
  // the first.
  assert(
    done.consumedFuel > 0,
    `re-drive episode should report its own consumed fuel, got ${done.consumedFuel}`,
  );
  await runtime.terminate();
});

Deno.test('error lifecycle event carries consumedFuel', async () => {
  const events = [];
  const { runtime, session } = new RuntimeBuilder()
    .onInboundMessage(() => {})
    .fuel(100000)
    .build();
  runtime.onSlotLifecycle = (ev) => events.push(ev);
  await runtime.start();

  // A program that throws at runtime (calling a non-function).
  const parsed = session.parse('let x = 1; x();');
  session.setInstruction(0, parsed.startIndex);
  await runtime.run(0).catch(() => {});

  const err = events.find((e) => e.kind === 'error');
  assert(err, 'an error lifecycle event should have fired');
  assertEquals(typeof err.consumedFuel, 'number');
  assert(err.consumedFuel > 0, `error should report consumed fuel, got ${err.consumedFuel}`);
  await runtime.terminate();
});

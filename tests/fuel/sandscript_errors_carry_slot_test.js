/**
 * Context-slot attribution for internally thrown errors.
 *
 * Errors thrown from sandscript-internal JS code (the resolve path's
 * marshalling, the reject path's createAndPushError, the
 * asyncCallback's synchronous-throw branch) historically didn't
 * carry the SS context slot they originated from. Diagnostic envelope
 * builders need the slot to attribute the failure correctly.
 *
 * Phase 2 step 2 adds two helpers on the Airlock:
 *   - airlock._stampContextSlot(err, slot) — idempotent stamp.
 *   - airlock._stampContextSlotOnThrow(slot, fn) — run fn, stamp on
 *     synchronous throw, re-throw.
 *
 * And wires them into the three known slot-attributable sites in
 * _setupSuspension. This file proves:
 *   - The stamp helper attaches .contextSlot to error objects.
 *   - The wrapper stamps on throw and re-throws the same instance.
 *   - Already-stamped errors aren't overwritten (idempotent).
 *   - The marshal-throw site stamps the slot when the resolve path
 *     can't marshal the value.
 *   - The asyncCallback-sync-throw site stamps before routing into
 *     reject (and reject's own stamp is idempotent).
 *   - Stamps survive even when the thrown value is a custom
 *     subclass / object (not just `new Error`).
 *   - Stamps don't crash on frozen or primitive throws.
 *
 * Run with: deno task test tests/fuel/sandscript_errors_carry_slot_test.js
 */

import { assert, assertEquals, assertStrictEquals, assertThrows }
  from "https://deno.land/std@0.208.0/assert/mod.ts";
import { freshSession } from '../../src/host-owned-session.js';

function newAirlock() {
  const session = freshSession();
  return { session, airlock: session.airlock };
}

// ---------------------------------------------------------------
// _stampContextSlot — direct unit tests
// ---------------------------------------------------------------

Deno.test('_stampContextSlot: attaches .contextSlot to an Error', () => {
  const { airlock } = newAirlock();
  const err = new Error('boom');
  airlock._stampContextSlot(err, 3);
  assertEquals(err.contextSlot, 3);
});

Deno.test('_stampContextSlot: idempotent — does not overwrite an existing slot', () => {
  const { airlock } = newAirlock();
  const err = new Error('x');
  err.contextSlot = 99;
  airlock._stampContextSlot(err, 0);
  assertEquals(err.contextSlot, 99,
    'pre-existing .contextSlot was preserved');
});

Deno.test('_stampContextSlot: no-op on non-object throws', () => {
  const { airlock } = newAirlock();
  // None of these should throw; the function returns the input
  // unmodified.
  assertEquals(airlock._stampContextSlot(null, 1), null);
  assertEquals(airlock._stampContextSlot(undefined, 1), undefined);
  assertEquals(airlock._stampContextSlot(42, 1), 42);
  assertEquals(airlock._stampContextSlot('oops', 1), 'oops');
});

Deno.test('_stampContextSlot: returns the same instance', () => {
  const { airlock } = newAirlock();
  const err = new TypeError('id');
  const got = airlock._stampContextSlot(err, 5);
  assertStrictEquals(got, err);
});

Deno.test('_stampContextSlot: tolerates frozen Error objects', () => {
  const { airlock } = newAirlock();
  const err = new Error('frozen');
  Object.freeze(err);
  // Must not propagate the TypeError from the assignment.
  airlock._stampContextSlot(err, 7);
  // The stamp didn't take — but the call succeeded.
  assertEquals(err.contextSlot, undefined,
    'frozen object — stamp silently no-ops');
});

Deno.test('_stampContextSlot: works on custom subclasses', () => {
  const { airlock } = newAirlock();
  class MyError extends RangeError {
    constructor(m) { super(m); this.name = 'MyError'; }
  }
  const err = new MyError('msg');
  airlock._stampContextSlot(err, 4);
  assertEquals(err.contextSlot, 4);
});

// ---------------------------------------------------------------
// _stampContextSlotOnThrow — wrapper tests
// ---------------------------------------------------------------

Deno.test('_stampContextSlotOnThrow: passes through normal return value', () => {
  const { airlock } = newAirlock();
  const out = airlock._stampContextSlotOnThrow(2, () => 'ok');
  assertEquals(out, 'ok');
});

Deno.test('_stampContextSlotOnThrow: stamps on synchronous throw and re-throws same instance', () => {
  const { airlock } = newAirlock();
  const original = new Error('inside');
  let caught;
  assertThrows(() => {
    airlock._stampContextSlotOnThrow(8, () => { throw original; });
  });
  try {
    airlock._stampContextSlotOnThrow(8, () => { throw original; });
  } catch (e) {
    caught = e;
  }
  assertStrictEquals(caught, original);
  assertEquals(caught.contextSlot, 8);
});

Deno.test('_stampContextSlotOnThrow: idempotent on already-stamped errors', () => {
  const { airlock } = newAirlock();
  const err = new Error('pre');
  err.contextSlot = 1;
  try {
    airlock._stampContextSlotOnThrow(99, () => { throw err; });
  } catch (_e) { /* expected */ }
  assertEquals(err.contextSlot, 1,
    'pre-stamped slot preserved');
});

// ---------------------------------------------------------------
// Integration: _setupSuspension wiring
// ---------------------------------------------------------------

Deno.test('asyncCallback sync-throw: error reaches reject with .contextSlot stamped', () => {
  const { airlock, session } = newAirlock();
  const slot = 0;
  session.mem.clearExitCondition(slot);
  const thrown = new Error('synchronous throw inside asyncCallback');
  const marker = {
    asyncCallback: (_resolve, _reject) => { throw thrown; },
  };
  airlock._setupSuspension(slot, marker, {}, new Set(), null);
  // The reject path stashes the error for host diagnostics.
  const stashed = airlock.lastRejectionError(slot);
  assertStrictEquals(stashed, thrown);
  assertEquals(stashed.contextSlot, slot,
    'thrown error carries the responsible slot');
});

Deno.test('marshal-throw: real marshal failure carries .contextSlot', () => {
  // marshalResultWithGrantTagging delegates to memoryImage.marshalResult,
  // which throws "Cannot marshal value of type function" for function
  // values. We resolve() with a function — the marshaller throws, the
  // resolve path's _stampContextSlotOnThrow wrapper stamps the slot.
  //
  // The throw escapes resolve() but is caught by _setupSuspension's
  // outer asyncCallback try/catch, which routes it through reject().
  // So the error lands in the rejection stash, still bearing the
  // .contextSlot stamp the marshal-throw wrapper added.
  const { airlock, session } = newAirlock();
  const slot = 0;
  session.mem.clearExitCondition(slot);
  const marker = {
    asyncCallback: (resolve, _reject) => { resolve(() => 1); },
  };
  airlock._setupSuspension(slot, marker, {}, new Set(), null);
  const stashed = airlock.lastRejectionError(slot);
  assert(stashed instanceof Error,
    `expected marshal failure to land in the rejection stash; got ${stashed}`);
  assert(stashed.message.includes('Cannot marshal'),
    `expected the marshal failure message; got: ${stashed.message}`);
  assertEquals(stashed.contextSlot, slot,
    'marshal throw stamped with slot at the stamp wrapper, ' +
    'survives the reject re-route');
});

Deno.test('integration: stamp works across different slots', () => {
  const { airlock, session } = newAirlock();
  // Allocate enough contexts for slot 2.
  session.airlock.memoryImage.allocateContext();
  session.airlock.memoryImage.allocateContext();
  const slotA = 0;
  const slotC = 2;
  session.mem.clearExitCondition(slotA);
  session.mem.clearExitCondition(slotC);
  const errA = new Error('A');
  const errC = new Error('C');
  airlock._setupSuspension(slotA, {
    asyncCallback: (_r, reject) => reject(errA),
  }, {}, new Set(), null);
  airlock._setupSuspension(slotC, {
    asyncCallback: (_r, reject) => reject(errC),
  }, {}, new Set(), null);
  assertEquals(errA.contextSlot, slotA);
  assertEquals(errC.contextSlot, slotC);
});

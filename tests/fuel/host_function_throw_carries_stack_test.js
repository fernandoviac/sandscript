/**
 * Raw host-handler rejection preservation.
 *
 * When a host function handler throws, SandScript's reject() pushes an
 * SS-side error carrying only `.message`. Diagnostic envelope builders also
 * need the original JavaScript Error with its stack, cause chain, own
 * properties, and BigInt fields.
 *
 * `airlock.lastRejectionError(slot)` and
 * `consumeLastRejectionError(slot)` expose an in-airlock per-slot FIFO queue
 * populated by reject() before the SS-side rewrite.
 *
 * What this file proves:
 *   - A RangeError thrown from inside a host handler shows up on
 *     lastRejectionError(slot) with .stack intact.
 *   - The Error's identity is preserved (object equality).
 *   - consumeLastRejectionError pops; a second call returns null.
 *   - A subsequent successful resolve() for the same slot drains
 *     the queue (so a caught-and-recovered earlier failure doesn't
 *     leak into a future cycle-error).
 *   - The FIFO queue accommodates multiple sequential rejections
 *     on the same slot.
 *   - .contextSlot is stamped on the stashed error (Phase 2 step 2).
 *
 * Run with: deno task test tests/fuel/host_function_throw_carries_stack_test.js
 */

import { assert, assertEquals, assertStrictEquals }
  from "https://deno.land/std@0.208.0/assert/mod.ts";
import { freshSession } from '../../src/host-owned-session.js';

// Set up an airlock with a known slot in pendingContexts by going
// straight to _setupSuspension via context.suspend(...).  Reusing the
// async_property_getters scaffolding is overkill for unit coverage —
// these tests poke the surface directly with a synthetic
// SuspensionMarker so we don't depend on the WASM run loop.
function newAirlock() {
  const session = freshSession();
  return { session, airlock: session.airlock };
}

// A SuspensionMarker that asyncCallback'd straight to a reject() with
// a thrown JS Error. Reach into _setupSuspension directly so we don't
// have to drive the WASM loop just to exercise the reject path.
function makeMarker(asyncCallback) {
  return { asyncCallback };
}

Deno.test('lastRejectionError: returns null before any rejection', () => {
  const { airlock } = newAirlock();
  assertEquals(airlock.lastRejectionError(0), null);
  assertEquals(airlock.lastRejectionError(7), null);
});

Deno.test('lastRejectionError: stashes the raw JS Error on reject()', () => {
  const { airlock, session } = newAirlock();
  const slot = 0;
  // Make sure the context exists and has its exit-condition set so
  // _setupSuspension doesn't trip on the stale-continuation check.
  session.mem.clearExitCondition(slot);
  // Manually invoke the suspension setup with a synthetic marker
  // whose asyncCallback rejects synchronously.
  const thrown = new RangeError('out of range — diagnostic test');
  const marker = makeMarker((_resolve, reject) => {
    reject(thrown);
  });
  // _setupSuspension expects (slot, marker, options, activeGrantIds,
  // onResume). Pass empty active grants; marshalling options aren't
  // exercised by the reject path so an empty object is fine.
  airlock._setupSuspension(slot, marker, {}, new Set(), null);
  const stashed = airlock.lastRejectionError(slot);
  assertStrictEquals(stashed, thrown,
    'identity-equal to the thrown Error — no copy, no rewrap');
  assert(typeof stashed.stack === 'string' && stashed.stack.length > 0,
    'stack preserved');
  assert(stashed.stack.includes('RangeError'),
    `stack mentions the class; saw: ${stashed.stack.slice(0, 200)}`);
});

Deno.test('lastRejectionError: stamp .contextSlot on the stashed error', () => {
  const { airlock, session } = newAirlock();
  const slot = 0;
  session.mem.clearExitCondition(slot);
  const thrown = new Error('test');
  airlock._setupSuspension(slot, makeMarker((_r, reject) => reject(thrown)),
    {}, new Set(), null);
  assertEquals(thrown.contextSlot, slot,
    'Phase 2 step 2: .contextSlot is stamped on the raw error');
});

Deno.test('consumeLastRejectionError: pops the head; second call returns null', () => {
  const { airlock, session } = newAirlock();
  const slot = 0;
  session.mem.clearExitCondition(slot);
  const thrown = new Error('first');
  airlock._setupSuspension(slot, makeMarker((_r, reject) => reject(thrown)),
    {}, new Set(), null);
  const popped = airlock.consumeLastRejectionError(slot);
  assertStrictEquals(popped, thrown);
  assertEquals(airlock.consumeLastRejectionError(slot), null,
    'queue drained after consume');
});

Deno.test('lastRejectionError: queue is FIFO across multiple sequential rejects', () => {
  const { airlock, session } = newAirlock();
  const slot = 0;
  const errA = new Error('A');
  const errB = new Error('B');
  const errC = new Error('C');
  session.mem.clearExitCondition(slot);
  airlock._setupSuspension(slot, makeMarker((_r, reject) => reject(errA)),
    {}, new Set(), null);
  session.mem.clearExitCondition(slot);
  airlock._setupSuspension(slot, makeMarker((_r, reject) => reject(errB)),
    {}, new Set(), null);
  session.mem.clearExitCondition(slot);
  airlock._setupSuspension(slot, makeMarker((_r, reject) => reject(errC)),
    {}, new Set(), null);
  assertStrictEquals(airlock.consumeLastRejectionError(slot), errA);
  assertStrictEquals(airlock.consumeLastRejectionError(slot), errB);
  assertStrictEquals(airlock.consumeLastRejectionError(slot), errC);
  assertEquals(airlock.consumeLastRejectionError(slot), null);
});

Deno.test('lastRejectionError: per-slot isolation', () => {
  const { airlock, session } = newAirlock();
  const slotA = 0;
  const slotB = 1;
  // Allocate an extra context for slot B so its state header exists.
  session.airlock.memoryImage.allocateContext();
  session.mem.clearExitCondition(slotA);
  session.mem.clearExitCondition(slotB);
  const errA = new Error('A');
  const errB = new Error('B');
  airlock._setupSuspension(slotA, makeMarker((_r, reject) => reject(errA)),
    {}, new Set(), null);
  airlock._setupSuspension(slotB, makeMarker((_r, reject) => reject(errB)),
    {}, new Set(), null);
  assertStrictEquals(airlock.lastRejectionError(slotA), errA);
  assertStrictEquals(airlock.lastRejectionError(slotB), errB);
  airlock.consumeLastRejectionError(slotA);
  assertEquals(airlock.lastRejectionError(slotA), null,
    'consuming slotA doesn\'t affect slotB');
  assertStrictEquals(airlock.lastRejectionError(slotB), errB);
});

Deno.test('lastRejectionError: successful resolve drains the queue', () => {
  const { airlock, session } = newAirlock();
  const slot = 0;
  session.mem.clearExitCondition(slot);
  // First: a reject that stashes.
  const errA = new Error('A');
  airlock._setupSuspension(slot, makeMarker((_r, reject) => reject(errA)),
    {}, new Set(), null);
  assertStrictEquals(airlock.lastRejectionError(slot), errA);
  // Then: a successful resolve. The drone caught errA and proceeded;
  // the next await succeeded.
  session.mem.clearExitCondition(slot);
  airlock._setupSuspension(slot,
    makeMarker((resolve, _reject) => resolve(42)),
    {}, new Set(), null);
  assertEquals(airlock.lastRejectionError(slot), null,
    'resolve drained the previously-stashed rejection');
});

Deno.test('clearLastRejectionErrors: drops the whole queue', () => {
  const { airlock, session } = newAirlock();
  const slot = 0;
  session.mem.clearExitCondition(slot);
  airlock._setupSuspension(slot,
    makeMarker((_r, reject) => reject(new Error('X'))),
    {}, new Set(), null);
  session.mem.clearExitCondition(slot);
  airlock._setupSuspension(slot,
    makeMarker((_r, reject) => reject(new Error('Y'))),
    {}, new Set(), null);
  airlock.clearLastRejectionErrors(slot);
  assertEquals(airlock.lastRejectionError(slot), null);
});

Deno.test('lastRejectionError: nested .cause survives stashing', () => {
  const { airlock, session } = newAirlock();
  const slot = 0;
  session.mem.clearExitCondition(slot);
  const root = new TypeError('root');
  const mid = new RangeError('mid', { cause: root });
  const top = new Error('top', { cause: mid });
  airlock._setupSuspension(slot, makeMarker((_r, reject) => reject(top)),
    {}, new Set(), null);
  const got = airlock.lastRejectionError(slot);
  assertStrictEquals(got, top);
  assertStrictEquals(got.cause, mid);
  assertStrictEquals(got.cause.cause, root);
});

Deno.test('lastRejectionError: own properties survive (host services attach diagnostics)', () => {
  const { airlock, session } = newAirlock();
  const slot = 0;
  session.mem.clearExitCondition(slot);
  const err = new Error('host service failed');
  err.capability = 'fetch';
  err.method = 'fetch';
  err.host = 'example.com';
  err.reason = 'CORS';
  airlock._setupSuspension(slot, makeMarker((_r, reject) => reject(err)),
    {}, new Set(), null);
  const got = airlock.lastRejectionError(slot);
  assertEquals(got.capability, 'fetch');
  assertEquals(got.method, 'fetch');
  assertEquals(got.host, 'example.com');
  assertEquals(got.reason, 'CORS');
});

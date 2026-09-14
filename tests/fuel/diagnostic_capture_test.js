/**
 * Diagnostic capture test suite.
 *
 * Covers:
 *   - airlock.captureSlotDiagnostic(slot): fresh, mid-execution, invalid
 *   - membrane.captureDiagnostic(opts):    fresh, after mutations, per-slot
 *   - AttributedRejection + handler wrap:  sync throw, async reject (with
 *     intervening slot activity), nested handler, non-throwing happy path
 *
 * Run with: deno task test tests/fuel/diagnostic_capture_test.js
 */

import { assertEquals, assert, assertExists } from "https://deno.land/std@0.208.0/assert/mod.ts";
import { AttributedRejection } from '../../src/fuel/airlock.js';
import { freshSession } from '../../src/host-owned-session.js';

function createAirlock() {
  return freshSession().airlock;
}

// =============================================================================
// captureSlotDiagnostic
// =============================================================================

Deno.test("captureSlotDiagnostic: fresh slot returns documented shape with default values", () => {
  const airlock = createAirlock();
  // initialize() allocates context 0; it's running but has no instructions yet.
  const diag = airlock.captureSlotDiagnostic(0);

  assertEquals(diag.slot, 0);
  assertEquals(diag.status, 'running'); // exitCondition === 0
  assertEquals(diag.exitCondition, 0);
  assertEquals(diag.instructionIndex, 0);
  assertEquals(diag.pendingStackDepth, 0);
  assertEquals(diag.callStackDepth, 0);
  assertEquals(diag.grantStackDepth, 0);
  assert(Array.isArray(diag.activeGrantIds), "activeGrantIds should be an Array (msgpack-friendly), not a Set");
  assertEquals(diag.activeGrantIds.length, 0);
  assert(typeof diag.tick === 'bigint', "tick should be a BigInt");
  assert(typeof diag.scopePointer === 'number');
});

Deno.test("captureSlotDiagnostic: invalid slot (out-of-range) returns sentinel", () => {
  const airlock = createAirlock();
  const capacity = airlock.memoryImage.getContextTableCapacity();
  const diag = airlock.captureSlotDiagnostic(capacity + 5);
  assertEquals(diag, { slot: capacity + 5, status: 'invalid' });
});

Deno.test("captureSlotDiagnostic: invalid slot (negative) returns sentinel", () => {
  const airlock = createAirlock();
  const diag = airlock.captureSlotDiagnostic(-1);
  assertEquals(diag, { slot: -1, status: 'invalid' });
});

Deno.test("captureSlotDiagnostic: non-integer slot returns sentinel", () => {
  const airlock = createAirlock();
  const diag = airlock.captureSlotDiagnostic(1.5);
  assertEquals(diag, { slot: 1.5, status: 'invalid' });
});

Deno.test("captureSlotDiagnostic: free slot returns sentinel", () => {
  const airlock = createAirlock();
  // Allocate then free a slot. allocateContext walks for the first free slot,
  // so slot 0 is taken (from initialize); slot 1 we allocate fresh.
  const slot = airlock.memoryImage.allocateContext();
  assert(slot >= 1);
  airlock.memoryImage.freeContext(slot);
  const diag = airlock.captureSlotDiagnostic(slot);
  assertEquals(diag.status, 'invalid');
});

Deno.test("captureSlotDiagnostic: tick reflects current membrane tick", () => {
  const airlock = createAirlock();
  const before = airlock.captureSlotDiagnostic(0).tick;
  airlock.membrane.bumpTick();
  airlock.membrane.bumpTick();
  const after = airlock.captureSlotDiagnostic(0).tick;
  assertEquals(after - before, 2n);
});

// =============================================================================
// membrane.captureDiagnostic
// =============================================================================

Deno.test("membrane.captureDiagnostic: fresh membrane returns stats + zero counters", () => {
  const airlock = createAirlock();
  const diag = airlock.membrane.captureDiagnostic();

  // Bundled stats() should match a direct call.
  assertEquals(diag.stats, airlock.membrane.stats());
  // tick is a BigInt.
  assert(typeof diag.tick === 'bigint');
  // No mutations yet on a fresh membrane.
  assertEquals(diag.recentMutations, []);
  // Finalization counters: zero on a fresh membrane.
  assertEquals(diag.finalization.recent, 0);
  assertEquals(diag.finalization.lifetime, 0);
  // perSlotMutations only appears when perSlotSlot is provided.
  assert(!('perSlotMutations' in diag));
});

Deno.test("membrane.captureDiagnostic: recent mutations populated after handle alloc", () => {
  const airlock = createAirlock();
  airlock.register({ name: 'a' });
  airlock.register({ name: 'b' });
  const diag = airlock.membrane.captureDiagnostic();
  assert(diag.recentMutations.length >= 2,
    `expected at least 2 mutations, got ${diag.recentMutations.length}`);
  // Newest-first ordering — last alloc's slot is at index 0.
  assertEquals(diag.recentMutations[0].slot, 1);
  assertEquals(diag.recentMutations[1].slot, 0);
});

Deno.test("membrane.captureDiagnostic: recentMutationsCap respected", () => {
  const airlock = createAirlock();
  for (let i = 0; i < 10; i++) airlock.register({ i });
  const diag = airlock.membrane.captureDiagnostic({ recentMutationsCap: 3 });
  assertEquals(diag.recentMutations.length, 3);
});

Deno.test("membrane.captureDiagnostic: perSlotSlot filters perSlotMutations", () => {
  const airlock = createAirlock();
  const h0 = airlock.register({ name: 'a' });
  airlock.register({ name: 'b' });
  airlock.register({ name: 'c' });
  const diag = airlock.membrane.captureDiagnostic({ perSlotSlot: h0.slot });
  assert(Array.isArray(diag.perSlotMutations));
  for (const m of diag.perSlotMutations) {
    assertEquals(m.slot, h0.slot);
  }
  assert(diag.perSlotMutations.length >= 1);
});

Deno.test("membrane.captureDiagnostic: default cap is 64", () => {
  const airlock = createAirlock();
  // Allocate enough to exceed the default cap, verify clamping.
  for (let i = 0; i < 100; i++) airlock.register({ i });
  const diag = airlock.membrane.captureDiagnostic();
  assertEquals(diag.recentMutations.length, 64);
});

// =============================================================================
// AttributedRejection class shape
// =============================================================================

Deno.test("AttributedRejection: cause/slot/diagnostic shape", () => {
  const original = new Error("the cause");
  const diag = { slot: 5, status: 'running' };
  const wrapped = new AttributedRejection(original, 5, diag);
  assert(wrapped instanceof Error);
  assert(wrapped instanceof AttributedRejection);
  assertEquals(wrapped.cause, original);
  assertEquals(wrapped.slot, 5);
  assertEquals(wrapped.diagnostic, diag);
  // Message copied from the cause.
  assertEquals(wrapped.message, "the cause");
  // Name distinguishes from base Error so logs can be matched.
  assertEquals(wrapped.name, 'AttributedRejection');
});

Deno.test("AttributedRejection: non-Error cause produces String message", () => {
  const wrapped = new AttributedRejection("plain string throw", 3, {});
  assertEquals(wrapped.cause, "plain string throw");
  assertEquals(wrapped.message, "plain string throw");
});

// =============================================================================
// Handler-invocation attribution: sync path
// =============================================================================

Deno.test("AttributedRejection: sync throw stashes per-slot and re-throws original", () => {
  const airlock = createAirlock();
  const original = new Error("boom");
  let observed;
  try {
    airlock._invokeWithSlotCapture(0, () => { throw original; }, {});
  } catch (e) {
    observed = e;
  }
  // Original error is what got re-thrown — SS-side error propagation is unchanged.
  assertEquals(observed, original);
  // The wrapped form lives in the per-slot stash.
  const stash = airlock.consumeAttributedRejection(0);
  assertExists(stash);
  assert(stash instanceof AttributedRejection);
  assertEquals(stash.cause, original);
  assertEquals(stash.slot, 0);
  // Diagnostic snapshot was captured from slot 0.
  assertEquals(stash.diagnostic.slot, 0);
  assertEquals(stash.diagnostic.status, 'running');
});

Deno.test("AttributedRejection: consume removes the stash; second call returns null", () => {
  const airlock = createAirlock();
  try {
    airlock._invokeWithSlotCapture(0, () => { throw new Error("x"); }, {});
  } catch (_e) { /* expected */ }
  assert(airlock.consumeAttributedRejection(0) !== null);
  assertEquals(airlock.consumeAttributedRejection(0), null);
});

Deno.test("AttributedRejection: peek does not remove the stash", () => {
  const airlock = createAirlock();
  try {
    airlock._invokeWithSlotCapture(0, () => { throw new Error("x"); }, {});
  } catch (_e) { /* expected */ }
  const first = airlock.peekAttributedRejection(0);
  const second = airlock.peekAttributedRejection(0);
  assertExists(first);
  assertEquals(first, second);
});

Deno.test("AttributedRejection: clear drops the stash without surfacing", () => {
  const airlock = createAirlock();
  try {
    airlock._invokeWithSlotCapture(0, () => { throw new Error("x"); }, {});
  } catch (_e) { /* expected */ }
  airlock.clearAttributedRejection(0);
  assertEquals(airlock.consumeAttributedRejection(0), null);
});

Deno.test("AttributedRejection: non-throwing handler leaves stash empty (no allocation on happy path)", () => {
  const airlock = createAirlock();
  airlock._invokeWithSlotCapture(0, () => 42, {});
  assertEquals(airlock.consumeAttributedRejection(0), null);
});

// =============================================================================
// Handler-invocation attribution: async path
// =============================================================================

Deno.test("AttributedRejection: async rejection stashes per-slot", async () => {
  const airlock = createAirlock();
  const original = new Error("async boom");
  const returned = airlock._invokeWithSlotCapture(0, () =>
    Promise.reject(original), {});
  let observed;
  try {
    await returned;
  } catch (e) {
    observed = e;
  }
  // The original Promise was returned unchanged; rejection passes through.
  assertEquals(observed, original);
  // The stash holds the AttributedRejection for slot 0.
  const stash = airlock.consumeAttributedRejection(0);
  assertExists(stash);
  assertEquals(stash.cause, original);
  assertEquals(stash.slot, 0);
});

Deno.test("AttributedRejection: async rejection with intervening slot activity attributes to the right slot", async () => {
  // The motivating race: between handler entry and async rejection, other
  // slot activity may run. The diagnostic must be captured at the moment
  // of rejection for the slot that originated the call, NOT whichever slot
  // happened to be current when the rejection settled.
  const airlock = createAirlock();
  // Allocate a second context slot so we have something to switch to.
  const otherSlot = airlock.memoryImage.allocateContext();
  assert(otherSlot !== 0);

  // Start the rejecting handler on slot 0. Don't await yet.
  let resolveOriginal;
  const original = new Promise((_r, reject) => {
    resolveOriginal = () => reject(new Error("async boom"));
  });
  const returned = airlock._invokeWithSlotCapture(0, () => original, {});

  // Simulate other slot activity between handler entry and rejection.
  airlock._invokeWithSlotCapture(otherSlot, () => 'unrelated work', {});

  // Now trigger the rejection.
  resolveOriginal();
  try {
    await returned;
  } catch (_e) { /* expected */ }

  // Slot 0's stash is what we want, not the other slot's.
  const slot0Stash = airlock.consumeAttributedRejection(0);
  assertExists(slot0Stash);
  assertEquals(slot0Stash.slot, 0);
  assertEquals(slot0Stash.diagnostic.slot, 0);
  // Other slot has no stash — it never threw.
  assertEquals(airlock.consumeAttributedRejection(otherSlot), null);
});

Deno.test("AttributedRejection: async resolution leaves stash empty (no spurious capture)", async () => {
  const airlock = createAirlock();
  const out = await airlock._invokeWithSlotCapture(0, () =>
    Promise.resolve("ok"), {});
  assertEquals(out, "ok");
  assertEquals(airlock.consumeAttributedRejection(0), null);
});

Deno.test("AttributedRejection: returned Promise identity is preserved (no .then wrap)", () => {
  // Sandscript's linked-promise machinery keys settlement off the Promise's
  // identity. Wrapping the return with .then would mint a new Promise that
  // settles one microtask later, breaking the host's settle-then-drain
  // ordering. Verify we return the exact same Promise the handler gave us.
  const airlock = createAirlock();
  const original = Promise.resolve("ok");
  const returned = airlock._invokeWithSlotCapture(0, () => original, {});
  assertEquals(returned, original);
});

// =============================================================================
// Nested handler invocations
// =============================================================================

Deno.test("AttributedRejection: nested handler — innermost slot captured", () => {
  // When handler A calls into handler B (both via _invokeWithSlotCapture)
  // and B throws, the stash should be keyed by B's slot, not A's.
  const airlock = createAirlock();
  const outerSlot = 0;
  const innerSlot = airlock.memoryImage.allocateContext();

  const innerErr = new Error("inner boom");
  try {
    airlock._invokeWithSlotCapture(outerSlot, () => {
      airlock._invokeWithSlotCapture(innerSlot, () => { throw innerErr; }, {});
    }, {});
  } catch (_e) { /* expected to propagate out */ }

  // Inner slot has the stash.
  const innerStash = airlock.consumeAttributedRejection(innerSlot);
  assertExists(innerStash);
  assertEquals(innerStash.slot, innerSlot);
  assertEquals(innerStash.cause, innerErr);
  // Outer slot has no stash.
  assertEquals(airlock.consumeAttributedRejection(outerSlot), null);
});

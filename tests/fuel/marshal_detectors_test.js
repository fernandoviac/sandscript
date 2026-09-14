/**
 * Tests for the marshalling detector chain.
 *
 * The detector chain handles wrapper-type marshalling (External, MsgpackRef,
 * Promise) globally — values pass through correctly regardless of whether
 * the calling site provided marshalling options. Originally async airlock
 * handlers returning Externals produced broken plain-object SS values; the
 * detectors fix that.
 *
 * Run with: deno task test tests/fuel/marshal_detectors_test.js
 */

import { assertEquals, assert } from "https://deno.land/std@0.208.0/assert/mod.ts";
import { createSession } from '../../src/fuel/session.js';
import { Handle } from '../../src/fuel/airlock.js';
import { freshSession } from '../../src/host-owned-session.js';
import { UncaughtScriptError } from '../../src/runtime/errors.js';

/**
 * Drive a session with manual handling of all async statuses, since async
 * paths are what the detector chain primarily fixes.
 *
 * SINGLE-OWNER driver: one queue, one slot running at a time. The old
 * version both kept polling an awaited slot AND concurrently drove the
 * same slot when the await-wake handed it back through
 * drainPendingSpawnedContexts — a double-drive that re-entered the
 * finished slot and re-executed its trailing instructions. That only
 * "worked" via the pending-pop base clamp; under strict stack mode (the
 * default) it traps with ERR_STACK_UNDERFLOW, by design.
 */
async function driveToCompletion(session) {
  const airlock = session.airlock;

  const queue = [0];
  let last = null;
  while (queue.length > 0) {
    const slot = queue.shift();
    let r;
    try {
      r = await session.run(slot, 100000);
    } catch (e) {
      if (e instanceof UncaughtScriptError) return { status: 'error', error: e.scriptError };
      throw e;
    }
    if (slot === 0) last = r;
    switch (r.status) {
      case 'done':
      case 'paused':
      case 'async_complete':
      case 'async_rejected':
        break;
      case 'async_call':
        queue.push(r.asyncContext, slot);
        break;
      case 'await':
      case 'suspended': {
        await new Promise(rs => setTimeout(rs, 5));
        const woken = airlock.drainPendingSpawnedContextIdentities();
        // The wake queue is the slot's ticket back into the rotation —
        // never ALSO keep polling it, or two drivers own one slot.
        if (woken.length > 0) queue.push(...woken);
        else queue.push(slot);
        break;
      }
      case 'promise_method':
        if (Array.isArray(r.contexts)) queue.push(...r.contexts);
        queue.push(slot);
        break;
      default:
        return r;
    }
  }
  return last;
}

function setupSession() {
  const session = freshSession();
  const airlock = session.airlock;
  const rootGrant = airlock.createRootGrant('test');
  return { session, airlock, rootGrant };
}

function registerThing(airlock, rootGrant, methodName = 'greet', returnValue = 'hi-from-thing') {
  const handleId = airlock.register({});
  airlock.setHandler(handleId, methodName, () => returnValue);
  rootGrant.add(handleId);
  return handleId;
}

// =============================================================================
// External marshalling
// =============================================================================

Deno.test("Detectors: SYNC handler returning External — drone can call methods", () => {
  const { session, airlock, rootGrant } = setupSession();
  const thingId = registerThing(airlock, rootGrant);
  const rootId = airlock.register({});
  airlock.setHandler(rootId, null, () => thingId);
  rootGrant.add(rootId);
  airlock.declare('getThing', rootId);

  session.parse(`
    let t = getThing()
    let msg = t.greet()
  `);
  session.run(0, 100000);
  assertEquals(session.get(0, 'msg'), 'hi-from-thing');
});

Deno.test("Detectors: ASYNC handler returning External — drone can call methods", async () => {
  // An async handler returning an External once produced a broken
  // `{ handleId: N }` plain object in SandScript memory.
  const { session, airlock, rootGrant } = setupSession();
  const thingId = registerThing(airlock, rootGrant);
  const rootId = airlock.register({});
  airlock.setHandler(rootId, null, async () => thingId);
  rootGrant.add(rootId);
  airlock.declare('getThing', rootId);

  session.parse(`
    let t = await getThing()
    let msg = t.greet()
  `);
  await driveToCompletion(session);
  assertEquals(session.get(0, 'msg'), 'hi-from-thing');
});

Deno.test("Detectors: ASYNC handler returning nested External in object", async () => {
  // Walker descends into objects; detector should fire on the inner External.
  const { session, airlock, rootGrant } = setupSession();
  const thingId = registerThing(airlock, rootGrant);
  const rootId = airlock.register({});
  airlock.setHandler(rootId, null, async () => ({ outer: { inner: thingId } }));
  rootGrant.add(rootId);
  airlock.declare('getThing', rootId);

  session.parse(`
    let r = await getThing()
    let t = r.outer.inner
    let msg = t.greet()
  `);
  await driveToCompletion(session);
  assertEquals(session.get(0, 'msg'), 'hi-from-thing');
});

Deno.test("Detectors: ASYNC handler returning External in array", async () => {
  const { session, airlock, rootGrant } = setupSession();
  const thingId = registerThing(airlock, rootGrant);
  const rootId = airlock.register({});
  airlock.setHandler(rootId, null, async () => [thingId]);
  rootGrant.add(rootId);
  airlock.declare('getThing', rootId);

  session.parse(`
    let r = await getThing()
    let t = r[0]
    let msg = t.greet()
  `);
  await driveToCompletion(session);
  assertEquals(session.get(0, 'msg'), 'hi-from-thing');
});

// =============================================================================
// Promise constructor — resolve / reject paths
// =============================================================================

// Clean test of the await-on-settled-promise fix in session.run.
// Uses a primitive value to avoid coupling to External marshalling.
Deno.test("Detectors: Promise constructor resolve(primitive) — drone awaits and gets value", async () => {
  const { session } = setupSession();
  session.parse(`
    let p = new Promise(function(resolve, reject) { resolve(42) })
    let v = await p
  `);
  await driveToCompletion(session);
  assertEquals(session.get(0, 'v'), 42);
});

Deno.test("Detectors: Promise constructor resolve(External) — drone awaits and gets methods", async () => {
  const { session, airlock, rootGrant } = setupSession();
  const thingId = registerThing(airlock, rootGrant);
  rootGrant.add(thingId);
  const rootId = airlock.register({});
  airlock.setHandler(rootId, null, () => thingId);
  rootGrant.add(rootId);
  airlock.declare('getThing', rootId);

  session.parse(`
    let p = new Promise(function(resolve, reject) {
      resolve(getThing())
    })
    let t = await p
    let msg = t.greet()
  `);
  await driveToCompletion(session);
  assertEquals(session.get(0, 'msg'), 'hi-from-thing');
});

// resolve/reject are in-band continuation values (TYPE_PROMISE_RESOLVE /
// TYPE_PROMISE_REJECT), not registered host handles. No synthetic grant
// should be minted to gate them. If this test fails, _handleNewPromise
// has regressed back to creating a __promise_executor__ grant, reintroducing
// cross-context grant infection.
Deno.test("Promise constructor mints no synthetic grant", async () => {
  const { session, airlock } = setupSession();
  session.parse(`
    let p = new Promise(function(resolve, reject) { resolve(42) })
    let v = await p
  `);
  await driveToCompletion(session);
  assertEquals(session.get(0, 'v'), 42);

  const syntheticGrants = airlock.membrane.enumerateGrants()
    .filter(e => e.identifier === '__promise_executor__');
  assertEquals(syntheticGrants.length, 0,
    'Promise executor must not mint a __promise_executor__ grant');
});

// =============================================================================
// Nested external calls — stack-management regression
// =============================================================================
//
// When an external method call wraps a direct external call as one of its args
// (e.g. `Console.log(getThing())`), the inner call's result must NOT clobber
// the slot underneath the outer call's bound method on the pending stack.
// The bug previously was that the host always reset the pending pointer by
// argsPointer - 32 (correct for CALL_METHOD, off-by-one for CALL), so the
// inner call's marshalResult would overwrite the outer call's
// receiver/closure slot. The fix moved result-destination calculation into
// the WAT, where each yield path knows its exact stack layout.

Deno.test("Nested external call inside external method call argument", () => {
  const { session, airlock, rootGrant } = setupSession();

  const inner = airlock.register({});
  airlock.setHandler(inner, null, () => 'inner-result');
  rootGrant.add(inner);
  airlock.declare('getThing', inner);

  let logged = null;
  const outer = airlock.register({});
  airlock.setHandler(outer, 'log', ({ args }) => { logged = args[0]; });
  rootGrant.add(outer);
  airlock.declare('Console', outer);

  session.parse(`Console.log(getThing())`);
  session.run(0, 100000);
  assertEquals(logged, 'inner-result');
});

Deno.test("Nested direct-external call inside direct-external call argument", () => {
  const { session, airlock, rootGrant } = setupSession();

  const inner = airlock.register({});
  airlock.setHandler(inner, null, () => 'inner-result');
  rootGrant.add(inner);
  airlock.declare('getThing', inner);

  let received = null;
  const outer = airlock.register({});
  airlock.setHandler(outer, null, ({ args }) => { received = args[0]; });
  rootGrant.add(outer);
  airlock.declare('sink', outer);

  session.parse(`sink(getThing())`);
  session.run(0, 100000);
  assertEquals(received, 'inner-result');
});

// =============================================================================
// Detector registry plumbing
// =============================================================================

Deno.test("Detectors: airlock registers detectors at init", () => {
  const { airlock } = setupSession();
  const detectors = airlock.memoryImage._marshalDetectors;
  // Seven stateless detectors are registered: External, ObjectHandle,
  // ClosureHandle, MsgpackRef, Promise, ArrayBuffer, and Uint8Array.
  // JS function marshalling remains unsupported, so Closure detection is
  // deferred.
  assertEquals(detectors.length, 7);
});

Deno.test("Detectors: External detector returns descriptor", () => {
  const { airlock } = setupSession();
  const detect = airlock.memoryImage._marshalDetectors[0];
  const r = detect(new Handle(42, 1));
  assertEquals(r.type, 0x0a /* TYPE.EXTERNAL */);
  assertEquals(r.dataLo, 42);
});

Deno.test("Detectors: External detector skips plain values", () => {
  const { airlock } = setupSession();
  const detect = airlock.memoryImage._marshalDetectors[0];
  assertEquals(detect(42), undefined);
  assertEquals(detect("foo"), undefined);
  assertEquals(detect({}), undefined);
  assertEquals(detect(null), undefined);
  assertEquals(detect(undefined), undefined);
});

Deno.test("Detectors: setMarshalDetectors replaces the chain", () => {
  const { airlock } = setupSession();
  const original = airlock.memoryImage._marshalDetectors;
  assertEquals(original.length, 7);

  airlock.memoryImage.setMarshalDetectors([(v) => v === 'magic' ? { type: 1, dataLo: 0 } : undefined]);
  assertEquals(airlock.memoryImage._marshalDetectors.length, 1);

  // Restore for subsequent tests in this file (Deno.test does fresh sessions
  // but clobbering a global on memoryImage might surprise other tests that
  // share state — they don't, since each test calls setupSession.
});

// =============================================================================
// ArrayBuffer / Uint8Array round-trip
//
// Without these detectors, host handlers returning a Uint8Array (e.g.
// fetch's response.arrayBuffer()) silently fall into writeValueAt's
// generic typeof === 'object' branch and arrive drone-side as a plain
// object. The detectors copy the bytes into an SS-heap-allocated
// ArrayBuffer + descriptor so the drone sees a real Uint8Array.
// =============================================================================

Deno.test("Detectors: Uint8Array round-trips host → drone via host call", () => {
  const { airlock, session: sess } = setupSession();
  const probe = airlock.register({}, { kind: 'probe' });
  airlock.setHandler(probe, null, () => new Uint8Array([1, 2, 3, 4]));
  airlock.declare('probe', probe);
  airlock.createRootGrant('test-root').add(probe);

  let captured = null;
  const capture = airlock.register({}, { kind: 'capture' });
  airlock.setHandler(capture, null, ({ args }) => {
    captured = { len: args[0], first: args[1], last: args[2] };
  });
  airlock.declare('capture', capture);
  airlock.createRootGrant('cap-root').add(capture);

  const r = sess.parse(`
    const bytes = probe()
    capture(bytes.length, bytes[0], bytes[3])
  `);
  sess.memoryImage.setContextInstructionIndex(0, r.startIndex);
  sess.memoryImage.clearExitCondition(0);
  const result = sess.run(0, 100000);
  assertEquals(result.status, 'done');
  assertEquals(captured.len, 4);
  assertEquals(captured.first, 1);
  assertEquals(captured.last, 4);
});

Deno.test("Detectors: Uint8Array round-trips drone → host via host arg", () => {
  const { airlock, session: sess } = setupSession();
  let captured = null;
  const echo = airlock.register({}, { kind: 'echo' });
  airlock.setHandler(echo, null, ({ args }) => { captured = args[0]; });
  airlock.declare('echo', echo);
  airlock.createRootGrant('echo-root').add(echo);

  const r = sess.parse(`
    const droneBytes = new Uint8Array([10, 20, 30])
    echo(droneBytes)
  `);
  sess.memoryImage.setContextInstructionIndex(0, r.startIndex);
  sess.memoryImage.clearExitCondition(0);
  const result = sess.run(0, 100000);
  assertEquals(result.status, 'done');
  assertEquals(captured instanceof Uint8Array, true,
    'host should receive a real Uint8Array, not a plain object');
  assertEquals(Array.from(captured), [10, 20, 30]);
});

Deno.test("Detectors: ArrayBuffer round-trips host → drone via host call", () => {
  const { airlock, session: sess } = setupSession();
  let received = null;
  const echo = airlock.register({}, { kind: 'echo' });
  airlock.setHandler(echo, null, ({ args }) => { received = args[0]; });
  airlock.declare('echo', echo);
  airlock.createRootGrant('echo-root').add(echo);

  const ab = airlock.register({}, { kind: 'ab' });
  airlock.setHandler(ab, null, () => {
    const buffer = new ArrayBuffer(4);
    new Uint8Array(buffer).set([5, 6, 7, 8]);
    return buffer;
  });
  airlock.declare('makeAb', ab);
  airlock.createRootGrant('ab-root').add(ab);

  const r = sess.parse(`
    const buf = makeAb()
    echo(buf)
  `);
  sess.memoryImage.setContextInstructionIndex(0, r.startIndex);
  sess.memoryImage.clearExitCondition(0);
  const result = sess.run(0, 100000);
  assertEquals(result.status, 'done');
  assertEquals(received instanceof ArrayBuffer, true,
    'host should receive a real ArrayBuffer, not a plain object');
  assertEquals(received.byteLength, 4);
  assertEquals(Array.from(new Uint8Array(received)), [5, 6, 7, 8]);
});

// =============================================================================
// BigInt round-trip in structured values
// =============================================================================
//
// Sandscript marshals SS Rationals OUT to JS as BigInt (always for
// integers, regardless of magnitude). A BigInt nested inside a
// handler-returned object used to hit "Cannot marshal value of type bigint" on
// the resumed external-call write path, even though the standalone marshal
// path already supported it. Numeric identifiers and structured identifiers
// with numeric fields pin parity between both paths.
Deno.test("Marshal: BigInt round-trips through a handler-returned object property", () => {
  const { session, airlock, rootGrant } = setupSession();
  // Handler returns an object containing a BigInt. The marshal-OUT
  // path (SS reads the property back) already worked; the marshal-IN
  // path (object property write) is what was broken.
  const handleId = airlock.register({});
  airlock.setHandler(handleId, null, () => ({ count: 7n }));
  rootGrant.add(handleId);
  airlock.declare('getCount', handleId);

  session.parse(`
    let result = getCount()
    let n = result.count
  `);
  session.run(0, 100000);
  // SS unmarshals BIGINT back to JS as BigInt.
  assertEquals(session.get(0, 'n'), 7n);
});

Deno.test("Marshal: BigInt round-trips through a handler-returned array element", () => {
  const { session, airlock, rootGrant } = setupSession();
  const handleId = airlock.register({});
  airlock.setHandler(handleId, null, () => [1n, 2n, 3n]);
  rootGrant.add(handleId);
  airlock.declare('getList', handleId);

  session.parse(`
    let arr = getList()
    let first = arr[0]
    let third = arr[2]
  `);
  session.run(0, 100000);
  assertEquals(session.get(0, 'first'), 1n);
  assertEquals(session.get(0, 'third'), 3n);
});

Deno.test("Marshal: BigInt nested in a handler-returned object", () => {
  const { session, airlock, rootGrant } = setupSession();
  const handleId = airlock.register({});
  airlock.setHandler(handleId, null, () => ({
    summary: { total: 100n, items: [10n, 20n, 30n] },
  }));
  rootGrant.add(handleId);
  airlock.declare('getSummary', handleId);

  session.parse(`
    let s = getSummary()
    let total = s.summary.total
    let firstItem = s.summary.items[0]
  `);
  session.run(0, 100000);
  assertEquals(session.get(0, 'total'), 100n);
  assertEquals(session.get(0, 'firstItem'), 10n);
});

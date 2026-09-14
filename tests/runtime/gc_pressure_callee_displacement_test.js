/**
 * A callee parked on the pending stack must survive pressure/gc rounds
 * fired by its own argument expression.
 *
 * The trigger is a fired closure evaluating
 * `send({ kind: "parks-backfill", parks: openParks() })`. The callee `send`
 * remains on the pending stack while openParks allocates objects and strings,
 * forcing collection and retry. After collection, CALL used to find an array
 * in the callee slot (`Not a function (received array)`); the related object
 * construction path could also place that array in the frame's `kind` field.
 *
 * This test replays that exact shape in the lab: phase 1 builds a
 * long-lived map of string-bearing entries (the fold), phase 2 (a
 * separate fired closure, aged past phase-1 collections) builds the
 * frame from the map — callee below, pressure inside the argument.
 *
 * Run with: deno task test tests/runtime/gc_pressure_callee_displacement_test.js
 */

import { assert, assertEquals } from "https://deno.land/std@0.208.0/assert/mod.ts";
import { RuntimeBuilder } from '../../src/runtime/test-harness.js';

function tick(ms = 0) { return new Promise(r => setTimeout(r, ms)); }
async function waitFor(cond, { timeout = 30000, label = 'condition' } = {}) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) { if (cond()) return; await tick(5); }
  throw new Error(`waitFor timed out: ${label}`);
}

Deno.test('runtime: callee survives pressure/gc rounds fired by its own argument expression', async () => {
  const captured = { fill: null, fire: null, handlerErrors: [] };
  const builder = new RuntimeBuilder()
    .capability({
      name: 'cap',
      needs: {},
      setup(airlock) {
        const h = airlock.register({});
        airlock.setHandler(h, 'regFill', ({ args }) => { captured.fill = args[0]; return 0; });
        airlock.setHandler(h, 'regFire', ({ args }) => { captured.fire = args[0]; return 0; });
        const grant = airlock.membrane.createGrant('cap');
        grant.add(h);
        airlock.declare('Cap', h);
        return { onGrantRequest(id) { return id === 'cap' ? grant : null; } };
      },
    })
    .onInboundMessage(() => {})
    .onHandlerError((rej) => { captured.handlerErrors.push(rej?.message ?? String(rej)); });
  const { runtime, session } = builder.build();
  await runtime.start();

  const result = session.parse(`
    let parkById = {}
    let parkOrder = []
    let frame = null
    let fillDone = 0
    let fireDone = 0
    let deliver = (f) => { frame = f }
    let openParks = () => {
      let out = []
      let i = 0
      while (i < parkOrder.length) {
        let p = parkById[parkOrder[i]]
        if (p !== undefined) {
          out.push({ parkId: "" + p.parkId, god: "" + p.god, verb: "" + p.verb, channel: "" + p.channel, crew: "" + p.crew, author: "" + p.author })
        }
        i = i + 1
      }
      return out
    }
    grant "cap" {
      Cap.regFill((count) => {
        let i = 0
        while (i < count) {
          let id = "req-" + i + "-padding-so-ids-are-not-tiny"
          parkOrder.push(id)
          parkById[id] = {
            parkId: id,
            god: "astronomy",
            verb: "chart",
            channel: "channel-" + i + "-with-some-prose-tail",
            crew: "orion-crew",
            author: "subject-" + i + "-with-some-prose-tail"
          }
          i = i + 1
        }
        fillDone = fillDone + 1
      })
      Cap.regFire((measureCount) => {
        // The live ready handler measures the feed backfill FIRST (per-
        // entry stringify transients — pure garbage that drives several
        // collections in this same fired-closure context), THEN sends
        // the parks frame. Mirror that order.
        let chars = 0
        let j = 0
        while (j < measureCount) {
          let entry = { text: "entry-" + j + "-padding-padding-padding-padding", detail: { n: j, tag: "t-" + j } }
          chars = chars + JSON.stringify(entry).length
          j = j + 1
        }
        deliver({ kind: "parks-backfill", parks: openParks(), measured: chars })
        fireDone = fireDone + 1
      })
    }
  `);
  session.setInstruction(0, result.startIndex);
  // The Runtime fanout wrapper's onGrantRequest is always async, so
  // runtime.run(0) suspends immediately after GRANT_START instead of running
  // the registration body within the same drive episode.
  await runtime.run(0);
  await waitFor(() => captured.fill !== null && captured.fire !== null,
    { label: 'grant body registrations to run' });
  assert(captured.fill && captured.fire, 'closures not registered');

  const gcRounds = [];
  runtime.onGarbageCollect = (e) => { gcRounds.push(e.kind); };

  // Phase 1: build the long-lived fold (its strings age across the
  // phase-2 collections).
  // Live-like fold size (the console's parks/genesis folds are tens of
  // entries); the pressure comes from the measuring churn, not the fold.
  const COUNT = 40;
  const MEASURE = 3000;
  runtime.scheduleClosureCall(captured.fill, [COUNT]);
  await waitFor(() => session.get(0, 'fillDone') === 1, { label: 'fold filled' });

  // Phase 2: build the frame from the aged fold — callee below,
  // pressure/gc rounds inside the argument expression.
  runtime.scheduleClosureCall(captured.fire, [MEASURE]);
  try {
    await waitFor(() => session.get(0, 'fireDone') === 1,
      { label: 'fire closure completed' });
  } catch (e) {
    throw new Error(
      `${e.message} — handlerErrors=${JSON.stringify(captured.handlerErrors)} ` +
      `gcRounds=${JSON.stringify(gcRounds)} fireDone=${session.get(0, 'fireDone')}`);
  }

  assertEquals(captured.handlerErrors, [],
    'the fire closure must not throw (pre-fix: "Not a function (received array)" at the deliver CALL)');

  const frame = session.get(0, 'frame');
  assert(frame !== null && typeof frame === 'object', 'frame delivered');
  assertEquals(frame.kind, 'parks-backfill',
    'kind must be the string — the pre-workaround live fault delivered the parks ARRAY here');
  assert(Array.isArray(frame.parks), 'parks must be the array');
  assertEquals(frame.parks.length, COUNT, 'every fold entry ships');
  assertEquals(frame.parks[0].parkId, 'req-0-padding-so-ids-are-not-tiny');
  assertEquals(frame.parks[COUNT - 1].author, `subject-${COUNT - 1}-with-some-prose-tail`);

  const collections = gcRounds.filter((k) => k === 'complete').length;
  assert(collections >= 1,
    `phase 2 must span at least one collection (got ${collections}) — raise COUNT if allocation shrank`);
});

Deno.test('runtime: callee survives a PENDING-BLOCK RELOCATION during its own argument expression', async () => {
  // The sharper variant: the fired context's stack blocks are allocated
  // at the heap top, ABOVE a big live ballast. The closure body drops
  // the ballast and then runs the mid-expression churn — the collection
  // it triggers frees the ballast below the blocks, so compaction
  // SLIDES the pending block down. Every call frame's saved
  // FRAME.PENDING_POINTER must slide with it; a stale one restores the
  // operand stack at the old address on return — the console-host live
  // fault (callee slot read as the parks array, `{kind: <parks array>}`
  // frames, msgpack of displaced memory).
  const captured = { fill: null, fire: null, handlerErrors: [] };
  const builder = new RuntimeBuilder()
    .capability({
      name: 'cap',
      needs: {},
      setup(airlock) {
        const h = airlock.register({});
        airlock.setHandler(h, 'regFill', ({ args }) => { captured.fill = args[0]; return 0; });
        airlock.setHandler(h, 'regFire', ({ args }) => { captured.fire = args[0]; return 0; });
        const grant = airlock.membrane.createGrant('cap');
        grant.add(h);
        airlock.declare('Cap', h);
        return { onGrantRequest(id) { return id === 'cap' ? grant : null; } };
      },
    })
    .onInboundMessage(() => {})
    .onHandlerError((rej) => { captured.handlerErrors.push(rej?.message ?? String(rej)); });
  const { runtime, session } = builder.build();
  await runtime.start();

  const result = session.parse(`
    let ballast = []
    let parkById = {}
    let parkOrder = []
    let frame = null
    let fillDone = 0
    let fireDone = 0
    let deliver = (f) => { frame = f }
    let openParks = () => {
      let out = []
      let i = 0
      while (i < parkOrder.length) {
        let p = parkById[parkOrder[i]]
        if (p !== undefined) {
          out.push({ parkId: "" + p.parkId, channel: "" + p.channel, author: "" + p.author })
        }
        i = i + 1
      }
      return out
    }
    let measureChurn = (count) => {
      let chars = 0
      let j = 0
      while (j < count) {
        let entry = { text: "entry-" + j + "-padding-padding-padding-padding", detail: { n: j, tag: "t-" + j } }
        chars = chars + JSON.stringify(entry).length
        j = j + 1
      }
      return chars
    }
    grant "cap" {
      Cap.regFill((foldCount, ballastCount) => {
        let i = 0
        while (i < foldCount) {
          let id = "req-" + i + "-padding-so-ids-are-not-tiny"
          parkOrder.push(id)
          parkById[id] = { parkId: id, channel: "channel-" + i + "-prose", author: "subject-" + i + "-prose" }
          i = i + 1
        }
        let b = 0
        while (b < ballastCount) {
          ballast.push({ a: b, b: b * 2, c: { nested: b }, pad: [b, b + 1, b + 2, b + 3] })
          b = b + 1
        }
        fillDone = fillDone + 1
      })
      Cap.regFire((measureCount) => {
        // Drop the ballast FIRST: the collection fired by the churn
        // below reclaims it, sliding this context's stack blocks down.
        ballast = null
        deliver({ kind: "parks-backfill", parks: openParks(), measured: measureChurn(measureCount) })
        fireDone = fireDone + 1
      })
    }
  `);
  session.setInstruction(0, result.startIndex);
  // The Runtime fanout wrapper's onGrantRequest is always async, so
  // runtime.run(0) suspends immediately after GRANT_START instead of running
  // the registration body within the same drive episode.
  await runtime.run(0);
  await waitFor(() => captured.fill !== null && captured.fire !== null,
    { label: 'grant body registrations to run' });
  assert(captured.fill && captured.fire, 'closures not registered');

  const gcRounds = [];
  runtime.onGarbageCollect = (e) => { gcRounds.push(e.kind); };

  runtime.scheduleClosureCall(captured.fill, [40, 1500]);
  try {
    await waitFor(() => session.get(0, 'fillDone') === 1, { label: 'fold + ballast filled' });
  } catch (e) {
    throw new Error(
      `${e.message} — handlerErrors=${JSON.stringify(captured.handlerErrors)}`);
  }

  runtime.scheduleClosureCall(captured.fire, [3000]);
  try {
    await waitFor(() => session.get(0, 'fireDone') === 1,
      { label: 'fire closure completed' });
  } catch (e) {
    throw new Error(
      `${e.message} — handlerErrors=${JSON.stringify(captured.handlerErrors)} ` +
      `gcRounds=${JSON.stringify(gcRounds)} fireDone=${session.get(0, 'fireDone')}`);
  }

  assertEquals(captured.handlerErrors, [],
    'the fire closure must not throw (stale FRAME.PENDING_POINTER: "Not a function (received array)")');

  const frame = session.get(0, 'frame');
  assert(frame !== null && typeof frame === 'object', 'frame delivered');
  assertEquals(frame.kind, 'parks-backfill',
    'kind must be the string — displaced operands deliver {kind: <parks array>}');
  assert(Array.isArray(frame.parks), 'parks must be the array');
  assertEquals(frame.parks.length, 40, 'every fold entry ships');
  assert(typeof frame.measured === 'number' && frame.measured > 0, 'measured is the churn total');

  const collections = gcRounds.filter((k) => k === 'complete').length;
  assert(collections >= 1,
    `the fire must span at least one collection (got ${collections}) — raise MEASURE/ballast if not`);
});

Deno.test('runtime: call frame saved pending pointer survives a gc while suspended mid-argument', async () => {
  // Fully deterministic variant — no pressure timing. The fired closure
  // evaluates deliver(wrap()) where wrap() SUSPENDS (context.suspend).
  // While parked: the callee value `deliver` and wrap's call frame (with
  // its saved restore-on-return FRAME.PENDING_POINTER) sit in the fired
  // context's blocks, allocated ABOVE a big live ballast. The test drops
  // the ballast and runs an explicit gc — compaction slides the fired
  // context's pending block down. Then the suspension resolves: wrap
  // returns, the frame restores the pending pointer, deliver is called.
  // A stale saved pointer restores the operand stack at the OLD block
  // address — the live console-host fault ("Not a function (received
  // array)" at the send CALL; {kind: <parks array>} frames), and the
  // "connection.message callbacks do not survive suspension" gotcha.
  const captured = { fire: null, handlerErrors: [] };
  const builder = new RuntimeBuilder()
    .capability({
      name: 'cap',
      needs: {},
      setup(airlock) {
        const h = airlock.register({});
        airlock.setHandler(h, 'regFire', ({ args }) => { captured.fire = args[0]; return 0; });
        airlock.setHandler(h, 'suspendMe', ({ context }) => context.suspend(() => {}));
        const grant = airlock.membrane.createGrant('cap');
        grant.add(h);
        airlock.declare('Cap', h);
        return { onGrantRequest(id) { return id === 'cap' ? grant : null; } };
      },
    })
    .onInboundMessage(() => {})
    .onHandlerError((rej) => { captured.handlerErrors.push(rej?.message ?? String(rej)); });
  const { runtime, session } = builder.build();
  await runtime.start();

  const result = session.parse(`
    let ballast = []
    let b = 0
    while (b < 1200) {
      ballast.push({ a: b, c: { nested: b }, pad: [b, b + 1, b + 2, b + 3] })
      b = b + 1
    }
    let frame = null
    let fireDone = 0
    let deliver = (f) => { frame = f }
    let wrap = () => {
      return "wrapped-" + Cap.suspendMe()
    }
    grant "cap" {
      Cap.regFire(() => {
        deliver({ kind: "parks-backfill", inner: wrap(), tail: "after-suspend" })
        fireDone = fireDone + 1
      })
    }
  `);
  session.setInstruction(0, result.startIndex);
  // The Runtime fanout wrapper's onGrantRequest is always async, so
  // runtime.run(0) suspends immediately after GRANT_START instead of running
  // the registration body within the same drive episode.
  await runtime.run(0);
  await waitFor(() => captured.fire !== null, { label: 'grant body registration to run' });
  assert(captured.fire, 'fire closure not registered');

  // Fire; the closure parks inside wrap() at the suspension, with the
  // deliver callee + object operands below and wrap's frame live.
  runtime.scheduleClosureCall(captured.fire, []);
  await waitFor(() => session.airlock.pendingContexts.size === 1,
    { label: 'fired closure parked at the suspension' });
  const [parkedSlot] = [...session.airlock.pendingContexts.keys()];

  // Drop the ballast (allocated below the fired context's blocks) and
  // collect: compaction slides the fired context's stack blocks down.
  const release = session.parse(`ballast = null`);
  session.setInstruction(0, release.startIndex);
  await runtime.run(0);
  const stats = session.gc();
  assert(stats.heapCollected > 0, 'the ballast must actually be collected');

  // Resume the suspension; wrap returns, the frame restores the pending
  // pointer, deliver is called with the completed object.
  const { resolve } = session.airlock.pendingContexts.get(parkedSlot);
  resolve('resumed-value');
  await waitFor(() => session.get(0, 'fireDone') === 1,
    { label: 'fire closure completed after resume' });

  assertEquals(captured.handlerErrors, [],
    'the resumed call must not throw (stale FRAME.PENDING_POINTER: "Not a function")');
  const frame = session.get(0, 'frame');
  assert(frame !== null && typeof frame === 'object', 'frame delivered');
  assertEquals(frame.kind, 'parks-backfill');
  assertEquals(frame.inner, 'wrapped-resumed-value');
  assertEquals(frame.tail, 'after-suspend');
});

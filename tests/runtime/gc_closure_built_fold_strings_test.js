/**
 * Fold state built by FIRED CLOSURES must survive gc.
 *
 * The console-host pattern: box-record listeners (fired closures with
 * marshaled args) build global fold state keyed and valued by DYNAMIC
 * strings ("" + record.field). A later handler walks the fold. On the live
 * console, walking the fold AFTER a gc threw
 *   "readString: id N is outside the interned-entry region"
 * (or silently returned undefined for dynamic-string keys) — the parks fold
 * "lost" a record and the APPROVALS panel stayed empty.
 *
 * This pins: strings created inside fired-closure slots and stored into
 * root-scope objects/arrays remain valid after session.gc() — readable as
 * values, usable as property keys, and stringifiable.
 *
 * Run with: deno task test tests/runtime/gc_closure_built_fold_strings_test.js
 */

import { assert, assertEquals } from "https://deno.land/std@0.208.0/assert/mod.ts";
import { RuntimeBuilder } from '../../src/runtime/test-harness.js';

function tick(ms = 0) { return new Promise(r => setTimeout(r, ms)); }

async function waitFor(condition, { timeout = 5000, label = 'condition' } = {}) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    if (condition()) return;
    await tick(5);
  }
  throw new Error(`waitFor timed out: ${label}`);
}

function foldCap(captured) {
  return {
    name: 'cap',
    needs: {},
    setup(airlock) {
      const h = airlock.register({});
      airlock.setHandler(h, 'regRecord', ({ args }) => { captured.record = args[0]; return 0; });
      airlock.setHandler(h, 'regChurn',  ({ args }) => { captured.churn  = args[0]; return 0; });
      airlock.setHandler(h, 'regRead',   ({ args }) => { captured.read   = args[0]; return 0; });
      airlock.setHandler(h, 'regFill',   ({ args }) => { captured.fill   = args[0]; return 0; });
      // Count ORGANIC collections (pressure-triggered via the airlock's gc
      // hook) so the pressure test can prove collections really fired
      // mid-burst rather than passing vacuously.
      const originalGc = airlock._state.heapGarbageCollect;
      if (originalGc) {
        airlock._state.heapGarbageCollect = (...gcArgs) => {
          captured.gcCount += 1;
          return originalGc(...gcArgs);
        };
      }
      const grant = airlock.membrane.createGrant('cap');
      grant.add(h);
      airlock.declare('Cap', h);
      return {
        onGrantRequest(id) { return id === 'cap' ? grant : null; },
      };
    },
  };
}

async function buildRuntime(heapSize = 4 * 1024 * 1024) {
  const captured = { record: null, churn: null, read: null, handlerErrors: [], gcCount: 0 };
  // stringTableSize: the retained ballast + folded records total
  // ~200 KB of live strings. Since layout v14 the derived hash index
  // takes half the string region, so the 256 KB default's data span
  // (~128 KB) no longer holds them — this test is about HEAP pressure
  // (organic collections mid-burst), not string-capacity exhaustion.
  const builder = new RuntimeBuilder()
    .sessionOptions({ heapSize, stringTableSize: 512 * 1024 })
    .capability(foldCap(captured))
    .onInboundMessage(() => {})
    .onHandlerError((rej) => { captured.handlerErrors.push(rej); });
  const { runtime, session } = builder.build();
  await runtime.start();

  const result = session.parse(`
    let byId = {}
    let order = []
    let heard = 0
    let readback = null
    let churn = []
    let ballast = []
    grant "cap" {
      Cap.regRecord(function(record) {
        let id = "" + record.requestId
        if (byId[id] === undefined) order.push(id)
        byId[id] = { channel: "" + record.channel, author: "" + record.author }
        heard = heard + 1
      })
      Cap.regChurn(function(n) {
        let i = 0
        while (i < 40) {
          churn.push("churn-" + n + "-" + i + "-padding-padding-padding")
          i = i + 1
        }
        churn = []
        return 0
      })
      Cap.regRead(function() {
        let out = []
        let i = 0
        while (i < order.length) {
          let p = byId[order[i]]
          if (p !== undefined) out.push(p.channel + "/" + p.author)
          i = i + 1
        }
        readback = out
        return out.length
      })
      Cap.regFill(function(n) {
        // Retained ballast: push heap occupancy up so the burst's
        // allocations trip organic pressure collections (the console
        // host idles at ~84% heap).
        let i = 0
        while (i < n) {
          ballast.push("ballast-" + i + "-" + "z-z-z-z-z-z-z-z-z-z-z-z-z-z-z-z-z-z-z-z-z-z-z-z-z-z-z-z-z-z-z-z")
          i = i + 1
        }
        return ballast.length
      })
    }
  `);
  session.setInstruction(0, result.startIndex);
  // The Runtime fanout wrapper's onGrantRequest is always async, so
  // runtime.run(0) suspends immediately after GRANT_START instead of running
  // the registration body within the same drive episode.
  await runtime.run(0);
  await waitFor(() => session.state(0).exitCondition === 'done',
    { label: 'grant body registrations to run' });

  for (const k of ['record', 'churn', 'read', 'fill']) {
    assert(captured[k], `${k} closure not registered`);
  }
  return { runtime, session, captured };
}

Deno.test('gc: fold state built by fired closures (dynamic string keys + values) survives collection', async () => {
  const { runtime, session, captured } = await buildRuntime();
  try {
    // Fire the record listener like a box replay burst — marshaled args,
    // one fresh slot per fire, dynamic ids the fold stores as keys.
    const COUNT = 6;
    for (let i = 1; i <= COUNT; i++) {
      runtime.scheduleClosureCall(captured.record, [{
        requestId: `chart-orion-crew-target-${i}`,
        channel: `target-${i}`,
        author: '9f8e7d6c5b4a',
      }]);
    }
    await waitFor(() => session.get(0, 'heard') === COUNT,
      { label: 'all records folded' });

    // Churn strings, then collect — twice, the console's reload moment.
    await runtime.invokeClosure(captured.churn, [1]);
    session.gc();
    await runtime.invokeClosure(captured.churn, [2]);
    session.gc();

    // Walk the fold AFTER the collections — the console's openParks() moment.
    const count = await runtime.invokeClosure(captured.read, []);
    assertEquals(count, COUNT, 'every folded record must still be reachable');
    const readback = session.get(0, 'readback');
    for (let i = 1; i <= COUNT; i++) {
      assertEquals(readback[i - 1], `target-${i}/9f8e7d6c5b4a`,
        `fold entry ${i} must survive gc intact`);
    }
    assertEquals(captured.handlerErrors.length, 0,
      `no handler errors expected, got: ${captured.handlerErrors.map((e) => e?.message ?? e).join('; ')}`);
  } finally {
    await runtime.terminate();
  }
});

Deno.test('gc: fold state survives PRESSURE collections mid-burst (organic gc at allocation points)', async () => {
  // The live-console shape: collections fire from allocation pressure
  // DURING the fired-closure burst, not from a controlled host gc between
  // activities. A console-host-sized heap (768 KB) + fat interleaved churn
  // force organic collections while listener slots are being created,
  // marshaled into, and folded. captured.gcCount proves they really fired.
  const { runtime, session, captured } = await buildRuntime(768 * 1024);
  try {
    // Retained ballast first: push occupancy up near the console host's
    // idle level so collections have real live data to move around.
    await runtime.invokeClosure(captured.fill, [2000]);

    // Schedule in batches with a COLLECTION FORCED WHILE THE DRAINER IS
    // MID-QUEUE — fires already folded coexist with fires still pending,
    // the console replay's shape. Plus churn so strings genuinely move.
    const COUNT = 200;
    let scheduled = 0;
    for (let batch = 0; batch < 10; batch++) {
      for (let j = 0; j < COUNT / 10; j++) {
        scheduled += 1;
        const i = scheduled;
        runtime.scheduleClosureCall(captured.record, [{
          requestId: `chart-orion-crew-target-${i}-${'x'.repeat(40)}`,
          channel: `target-${i}-${'y'.repeat(40)}`,
          author: '9f8e7d6c5b4a',
        }]);
      }
      runtime.scheduleClosureCall(captured.churn, [batch]);
      await tick();
      session.gc();
      captured.gcCount += 1;
    }
    await waitFor(() => session.get(0, 'heard') === COUNT,
      { label: 'all records folded under pressure', timeout: 30000 });
    session.gc();

    const count = await runtime.invokeClosure(captured.read, []);
    assertEquals(count, COUNT, 'every folded record must still be reachable');
    const readback = session.get(0, 'readback');
    for (let i = 1; i <= COUNT; i++) {
      assertEquals(readback[i - 1], `target-${i}-${'y'.repeat(40)}/9f8e7d6c5b4a`,
        `fold entry ${i} must survive pressure gc intact`);
    }
    assertEquals(captured.handlerErrors.length, 0,
      `no handler errors expected, got: ${captured.handlerErrors.map((e) => e?.message ?? e).join('; ')}`);
    assert(captured.gcCount >= 1,
      `test must exercise organic collections; gcCount=${captured.gcCount} — shrink the heap`);
  } finally {
    await runtime.terminate();
  }
});

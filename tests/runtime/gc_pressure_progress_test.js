/**
 * Allocation-heavy stretches survive repeated memory pressure.
 *
 * driveSlot's memory_pressure handling used to declare OOM whenever the
 * post-gc retry hit pressure AGAIN — but an allocation-heavy loop (per-
 * iteration objects + JSON.stringify temporaries) legitimately outruns one
 * collection and pressures repeatedly while still making progress. Treating
 * the second pressure signal as OOM discarded the completed backfill on every
 * reload.
 *
 * Only a NO-PROGRESS retry (same instruction, essentially no fuel) is a
 * genuine OOM: the single pending operation cannot fit.
 *
 * Run with: deno task test tests/runtime/gc_pressure_progress_test.js
 */

import { assert, assertEquals } from "https://deno.land/std@0.208.0/assert/mod.ts";
import { RuntimeBuilder } from '../../src/runtime/test-harness.js';

function tick(ms = 0) { return new Promise(r => setTimeout(r, ms)); }
async function waitFor(cond, { timeout = 30000, label = 'condition' } = {}) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) { if (cond()) return; await tick(5); }
  throw new Error(`waitFor timed out: ${label}`);
}

Deno.test('runtime: an allocation-heavy loop completes across many pressure/gc rounds (no false OOM)', async () => {
  const captured = { loop: null, handlerErrors: [] };
  const builder = new RuntimeBuilder()
    .capability({
      name: 'cap',
      needs: {},
      setup(airlock) {
        const h = airlock.register({});
        airlock.setHandler(h, 'regLoop', ({ args }) => { captured.loop = args[0]; return 0; });
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
    let doneCount = 0
    let total = 0
    grant "cap" {
      Cap.regLoop((count) => {
        // Per-iteration heap + string churn: objects, stringify results,
        // concat temporaries. Far more transient allocation than one heap
        // holds — several collections are REQUIRED to finish.
        let i = 0
        let acc = 0
        while (i < count) {
          let entry = { text: "entry-" + i + "-padding-padding-padding", detail: { n: i, tag: "t-" + i } }
          acc = acc + JSON.stringify(entry).length
          i = i + 1
        }
        total = acc
        doneCount = doneCount + 1
      })
    }
  `);
  session.setInstruction(0, result.startIndex);
  // The Runtime fanout wrapper's onGrantRequest is always async, so
  // runtime.run(0) suspends immediately after GRANT_START instead of running
  // the registration body within the same drive episode.
  await runtime.run(0);
  await waitFor(() => captured.loop !== null, { label: 'grant body registration to run' });
  assert(captured.loop, 'loop closure not registered');

  const gcRounds = [];
  runtime.onGarbageCollect = (e) => { gcRounds.push(e.kind); };

  const COUNT = 3000;
  runtime.scheduleClosureCall(captured.loop, [COUNT]);
  await waitFor(() => session.get(0, 'doneCount') === 1,
    { label: 'allocation-heavy loop completed' });

  assert(session.get(0, 'total') > 0, 'the loop must have measured every entry');
  assertEquals(captured.handlerErrors, [],
    `no MemoryPressureError may fire for a progressing loop`);
  const collections = gcRounds.filter((k) => k === 'complete').length;
  assert(collections >= 2,
    `the loop must have genuinely spanned multiple collections (got ${collections}) — ` +
    `raise COUNT if allocation per iteration shrank`);
  const ooms = gcRounds.filter((k) => k === 'oom').length;
  assertEquals(ooms, 0, 'no OOM events for a progressing loop');
});

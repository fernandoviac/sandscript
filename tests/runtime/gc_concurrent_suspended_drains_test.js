/**
 * Concurrent suspended stream drains vs membrane compaction / gc.
 *
 * The console-host / approval-scopes reap shape: N closure calls each drain a
 * chunked source through a cap HANDLE held across awaits (`let reader =
 * Cap.open(); while (...) await reader.next()`), concurrently, while handle
 * churn drives membrane compaction and heap churn drives collections.
 *
 * The pinned failure signatures are:
 *   - "handle:N requires a grant not in the current grant stack" when
 *     compaction misses a suspended context's live handle;
 *   - a collection throwing mid-pass on a string id outside the interned-entry
 *     region, then allowing the vat to continue half-collected.
 *
 * Run with: deno task test tests/runtime/gc_concurrent_suspended_drains_test.js
 */

import { assert, assertEquals } from "https://deno.land/std@0.208.0/assert/mod.ts";
import { RuntimeBuilder } from '../../src/runtime/test-harness.js';

function tick(ms = 0) { return new Promise(r => setTimeout(r, ms)); }

async function waitFor(condition, { timeout = 30000, label = 'condition' } = {}) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    if (condition()) return;
    await tick(5);
  }
  throw new Error(`waitFor timed out: ${label}`);
}

const CHUNKS_PER_DRAIN = 6;

function streamCap(captured) {
  return {
    name: 'cap',
    needs: {},
    setup(airlock) {
      const rootHandle = airlock.register({});
      const grant = airlock.membrane.createGrant('cap');
      grant.add(rootHandle);

      airlock.setHandler(rootHandle, 'regDrain', ({ args }) => {
        captured.drain = args[0]; return 0;
      });

      // Cap.open(id) returns a fresh stream handle. Each `next()` settles on a
      // later macrotask so the calling slot genuinely parks; chunk payloads
      // are fresh, handle-free objects.
      airlock.setHandler(rootHandle, 'open', ({ args }) => {
        const id = args[0];
        let served = 0;
        const streamHandle = airlock.register({});
        grant.add(streamHandle);
        airlock.setHandler(streamHandle, 'next', () => {
          return new Promise((resolve) => {
            setTimeout(() => {
              served += 1;
              if (served > CHUNKS_PER_DRAIN) { resolve(null); return; }
              resolve({ id, n: served, pad: 'chunk-padding-'.repeat(8) });
            }, 0);
          });
        });
        return streamHandle;
      });

      // Cap.churnHandle() → register-and-return a throwaway handle. The SS
      // side drops it immediately; enough of these fill the handle arena and
      // drive REAL membrane compactions during the drains.
      airlock.setHandler(rootHandle, 'churnHandle', () => {
        const h = airlock.register({ throwaway: true });
        grant.add(h);
        return h;
      });

      airlock.declare('Cap', rootHandle);
      return { onGrantRequest(id) { return id === 'cap' ? grant : null; } };
    },
  };
}

async function buildRuntime() {
  const captured = { drain: null, handlerErrors: [] };
  const builder = new RuntimeBuilder()
    .sessionOptions({ heapSize: 4 * 1024 * 1024 })
    .capability(streamCap(captured))
    .onInboundMessage(() => {})
    .onHandlerError((rej) => { captured.handlerErrors.push(rej); });
  const { runtime, session } = builder.build();
  await runtime.start();

  const result = session.parse(`
    let completed = 0
    let total = 0
    let failures = []
    grant "cap" {
      Cap.regDrain(async function(id) {
        try {
          let reader = Cap.open(id)
          let going = true
          while (going) {
            let chunk = await reader.next()
            if (chunk === null) {
              going = false
            } else {
              total = total + chunk.n
              let x = Cap.churnHandle()
              x = null
            }
          }
        } catch (drainError) {
          failures.push("" + id + ": " + drainError.message)
        }
        completed = completed + 1
      })
    }
  `);
  session.setInstruction(0, result.startIndex);
  // The Runtime fanout wrapper's onGrantRequest is always async, so
  // runtime.run(0) suspends immediately after GRANT_START instead of running
  // the registration body within the same drive episode.
  await runtime.run(0);
  await waitFor(() => captured.drain !== null, { label: 'grant body registration to run' });
  assert(captured.drain, 'drain closure not registered');
  return { runtime, session, captured };
}

Deno.test('membrane compaction + gc under 40 concurrent suspended stream drains: no reap, no corruption', async () => {
  const { runtime, session, captured } = await buildRuntime();
  try {
    const DRAINS = 40;
    for (let i = 1; i <= DRAINS; i++) {
      runtime.scheduleClosureCall(captured.drain, [i]);
    }
    // Force collections + membrane compactions while the drains are parked
    // mid-await (the drains take several macrotask rounds each).
    for (let round = 0; round < 12; round++) {
      await tick(5);
      session.gc();
      session.airlock.compactMembrane();
    }
    await waitFor(() => session.get(0, 'completed') === DRAINS,
      { label: 'all drains completed' });

    const failures = session.get(0, 'failures');
    assertEquals(failures, [],
      `no drain may fail (reaped handle shows up here as "requires a grant")`);
    // Every chunk of every drain arrived: sum over drains of 1..CHUNKS.
    const expectedTotal = DRAINS * (CHUNKS_PER_DRAIN * (CHUNKS_PER_DRAIN + 1)) / 2;
    assertEquals(session.get(0, 'total'), expectedTotal, 'every chunk accounted');
    assertEquals(captured.handlerErrors.length, 0,
      `no handler errors, got: ${captured.handlerErrors.map((e) => e?.message ?? e).join('; ')}`);
  } finally {
    await runtime.terminate();
  }
});

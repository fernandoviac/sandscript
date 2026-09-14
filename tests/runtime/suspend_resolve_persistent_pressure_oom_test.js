/**
 * A suspend-based host method resolves with a value the heap can never fit
 * because every chunk is retained across awaits, unlike a plain bytecode
 * allocation loop.
 *
 * Contrast with suspend_resolve_heap_pressure_test.js, which resolves
 * with chunks that ARE garbage by the next iteration — gc reclaims
 * them and the deferred-marshal stash drains cleanly. Here nothing is
 * ever freed, so _drainDeferredMarshal keeps returning 'pressure'
 * (airlock.js's _setupSuspension resolve / _drainDeferredMarshal),
 * runContext yields 'memory_pressure' with no interpreter step, and
 * the SAME no-progress escalation in runtime.js's driveLoop applies:
 * a retry that consumes no fuel and doesn't advance pc is a genuine
 * OOM, thrown as MemoryPressureError.
 *
 * This confirms that persistent pressure on the suspend-resolve path surfaces
 * through runtime-level onHandlerError, never through the script's try/catch:
 * the async closure cannot resume when its deferred result cannot fit. A
 * synchronously-thrown marshal error is a different mechanism and is outside
 * this test's contract.
 *
 * Run with: deno task test tests/runtime/suspend_resolve_persistent_pressure_oom_test.js
 */

import { assert, assertEquals } from "https://deno.land/std@0.208.0/assert/mod.ts";
import { RuntimeBuilder } from '../../src/runtime/test-harness.js';

const CHUNK_BYTES = 96 * 1024;
const HEAP_SIZE = 64 * 1024; // smaller than a single chunk — cannot ever fit

function tick(ms = 0) { return new Promise((r) => setTimeout(r, ms)); }
async function waitFor(condition, { timeout = 10000, label = 'condition' } = {}) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    if (condition()) return;
    await tick(5);
  }
  throw new Error(`waitFor timed out: ${label}`);
}

Deno.test('suspend resolve under PERSISTENT heap pressure (nothing ever freed): drive terminates as runtime-level MemoryPressureError, drone catch block never runs', async () => {
  const handlerErrors = [];

  const { runtime, session, channels } = new RuntimeBuilder()
    .sessionOptions({ heapSize: HEAP_SIZE })
    .capability({
      name: 'chunk-source',
      setup: (al) => {
        const rootGrant = al.createRootGrant();
        const handle = al.register({});
        rootGrant.add(handle);
        al.setHandler(handle, 'next', ({ context }) => {
          return context.suspend((resolve, _reject) => {
            setTimeout(() => {
              // A chunk bigger than the whole heap. Nothing frees it —
              // the SS side holds every chunk in `kept`, matching the
              // real drain's "handle held across many chunked awaits"
              // shape — so gc can never reclaim enough room.
              resolve(new Uint8Array(CHUNK_BYTES));
            }, 0);
          });
        });
        al.declare('Source', handle);
      },
    })
    .onInboundMessage(() => {})
    .onHandlerError((rej) => { handlerErrors.push(rej); })
    .build();

  await runtime.start();

  session.parse(`
    let kept = []
    let outcome = "not-run"
    try {
      let chunk = await Source.next()
      kept[kept.length] = chunk
      outcome = "completed"
    } catch (e) {
      outcome = "" + e.message
    }
  `);

  const result = runtime.run(0);

  await waitFor(() => handlerErrors.length > 0 || session.get(0, 'outcome') !== 'not-run',
    { label: 'either a handler error fires or the SS script observes something' });

  // Give any (incorrect) late SS-side resumption a moment to land.
  await tick(50);

  assertEquals(session.get(0, 'outcome'), 'not-run',
    'the drone async closure never resumes — neither the success line nor the catch block runs');

  assertEquals(handlerErrors.length, 1,
    `expected exactly one MemoryPressureError handler error, got ${handlerErrors.length}: ` +
    handlerErrors.map((e) => e?.cause?.message ?? e).join('; '));
  assertEquals(handlerErrors[0]?.cause?.name, 'MemoryPressureError');

  await runtime.terminate();
  channels.close();
});

/**
 * A SandScript loop awaits a suspend-based host method that resolves outside
 * an active drive with a fresh Uint8Array each time. Each chunk is garbage by
 * the next iteration, so collection should keep heap use flat regardless of
 * heap size.
 *
 * The former failure appeared when cumulative chunk bytes approached the heap
 * ceiling. A late resolve's marshal raised HeapPressureSignal inside
 * _setupSuspension, which stored the value in _deferredMarshals but returned
 * without calling onResume. Nothing then scheduled a drive to surface the WAT
 * pressure flag, so collection never ran and the loop froze silently.
 *
 * Contrast with _settleLinkedPromiseBySlot (the post-restore settle),
 * which stashes via resumeWithValue and STILL enqueues the parked
 * context — and with the "late resolve wakes slot" regression test in
 * runtime_test.js, which pinned the onResume wiring for the
 * non-pressure path.
 *
 * Run with: deno task test tests/runtime/suspend_resolve_heap_pressure_test.js
 */

import { RuntimeBuilder } from '../../src/runtime/test-harness.js';

const CHUNK_BYTES = 32 * 1024;
const CHUNK_COUNT = 24;            // 24 × 32 KB = 768 KB cumulative
const HEAP_SIZE = 256 * 1024;      // « cumulative; fine if GC runs

function tick(ms = 0) {
  return new Promise((r) => setTimeout(r, ms));
}

async function waitFor(condition, { timeout = 10000, label = 'condition' } = {}) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    if (condition()) return;
    await tick(5);
  }
  throw new Error(`waitFor timed out: ${label}`);
}

Deno.test('suspend resolve under heap pressure: chunked await loop completes (GC reclaims dead chunks)', async () => {
  let served = 0;
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
            // Resolve LATE — from a macrotask, with the runtime idle.
            // This is the settlement path for a wire reply delivered by an
            // embedder after the initiating drive has parked.
            setTimeout(() => {
              if (served >= CHUNK_COUNT) {
                resolve(null);
                return;
              }
              served += 1;
              resolve(new Uint8Array(CHUNK_BYTES));
            }, 0);
          });
        });
        al.declare('Source', handle);
      },
    })
    .onInboundMessage(() => {})
    .build();

  runtime.onHandlerError = (rejection) => { handlerErrors.push(rejection); };

  await runtime.start();

  session.parse(`
    let total = 0
    let finished = false
    let going = true
    while (going) {
      let chunk = await Source.next()
      if (chunk === null) {
        going = false
      } else {
        total = total + chunk.byteLength
      }
    }
    finished = true
  `);

  // run(0) parks at the first suspension; every subsequent step is a
  // late resolve waking the slot through the spawned-context drain.
  runtime.run(0);

  try {
    await waitFor(() => session.get(0, 'finished') === true, {
      label: `loop finished (served=${CHUNK_COUNT})`,
    });
  } catch (err) {
    // Stall diagnostics: which chunk froze the loop, was the value
    // stashed in _deferredMarshals (the lost-wake signature), and did
    // any error surface at all.
    const total = session.get(0, 'total');
    const deferred = session.airlock._deferredMarshals?.size ?? 'n/a';
    const pending = session.airlock.pendingContexts?.size ?? 'n/a';
    throw new Error(
      `${err.message} — STALLED: served=${served} ssTotal=${total} ` +
      `deferredMarshals=${deferred} pendingContexts=${pending} ` +
      `handlerErrors=${handlerErrors.length}`,
      { cause: err });
  }

  const total = session.get(0, 'total');
  if (total !== CHUNK_BYTES * CHUNK_COUNT) {
    throw new Error(`expected total=${CHUNK_BYTES * CHUNK_COUNT}, got ${total}`);
  }
  if (handlerErrors.length > 0) {
    throw new Error(`expected no handler errors, got ${handlerErrors.length}: ` +
      `${handlerErrors[0]?.error?.message ?? handlerErrors[0]}`);
  }

  await runtime.terminate();
  channels.close();
});

// A resolve value that CARRIES A FRESH HANDLE must survive the
// pressure-deferred marshal. The handle is registered outside any
// dispatch (no in-flight protection) and has no SS-heap reference
// until the drain lands it — the only thing keeping it alive across
// the gc that the drain waits for is the deferred-marshal stash walk
// in _compactMembraneFromLiveHandleSlots. Without it, the gc reaps
// the slot and the drain marshals a stale handle.
Deno.test('suspend resolve under heap pressure: handle inside the deferred value survives the gc', async () => {
  let served = 0;
  let airlockRef = null;
  const handlerErrors = [];

  const { runtime, session, channels } = new RuntimeBuilder()
    .sessionOptions({ heapSize: HEAP_SIZE })
    .capability({
      name: 'chunk-source',
      setup: (al) => {
        airlockRef = al;
        const rootGrant = al.createRootGrant();
        const handle = al.register({});
        rootGrant.add(handle);
        al.setHandler(handle, 'next', ({ context }) => {
          return context.suspend((resolve, _reject) => {
            setTimeout(() => {
              if (served >= CHUNK_COUNT) {
                resolve(null);
                return;
              }
              served += 1;
              const tag = `tag-${served}`;
              const probeHandle = airlockRef.register({ tag });
              rootGrant.add(probeHandle);
              airlockRef.setHandler(probeHandle, 'tag', () => tag);
              resolve({ data: new Uint8Array(CHUNK_BYTES), probe: probeHandle });
            }, 0);
          });
        });
        al.declare('Source', handle);
      },
    })
    .onInboundMessage(() => {})
    .build();

  runtime.onHandlerError = (rejection) => { handlerErrors.push(rejection); };

  await runtime.start();

  session.parse(`
    let total = 0
    let finished = false
    let going = true
    let lastTag = ""
    while (going) {
      let piece = await Source.next()
      if (piece === null) {
        going = false
      } else {
        total = total + piece.data.byteLength
        lastTag = piece.probe.tag()
      }
    }
    finished = true
  `);

  runtime.run(0);

  try {
    await waitFor(() => session.get(0, 'finished') === true, {
      label: `handle-bearing loop finished (served=${CHUNK_COUNT})`,
    });
  } catch (err) {
    const total = session.get(0, 'total');
    const deferred = session.airlock._deferredMarshals?.size ?? 'n/a';
    throw new Error(
      `${err.message} — STALLED: served=${served} ssTotal=${total} ` +
      `deferredMarshals=${deferred} handlerErrors=${handlerErrors.length}: ` +
      `${handlerErrors[0]?.error?.message ?? ''}`,
      { cause: err });
  }

  const total = session.get(0, 'total');
  if (total !== CHUNK_BYTES * CHUNK_COUNT) {
    throw new Error(`expected total=${CHUNK_BYTES * CHUNK_COUNT}, got ${total}`);
  }
  const lastTag = session.get(0, 'lastTag');
  if (lastTag !== `tag-${CHUNK_COUNT}`) {
    throw new Error(`expected lastTag=tag-${CHUNK_COUNT}, got ${JSON.stringify(lastTag)}`);
  }
  if (handlerErrors.length > 0) {
    throw new Error(`expected no handler errors, got ${handlerErrors.length}: ` +
      `${handlerErrors[0]?.error?.message ?? handlerErrors[0]}`);
  }

  await runtime.terminate();
  channels.close();
});

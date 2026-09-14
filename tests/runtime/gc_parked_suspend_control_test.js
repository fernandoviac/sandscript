/**
 * Control matrix for the suspend-resolve heap-pressure stall: how does
 * session.gc() interact with slots parked on host calls? NO heap
 * pressure anywhere (4 MB heap, 8 KB chunks) — gc is invoked
 * explicitly by the host at controlled moments.
 *
 * Findings these tests pin:
 *   - gc with no parked slot: safe (sanity control).
 *   - gc while a slot is parked at EXIT_EXTERNAL_CALL
 *     (context.suspend): the resumed slot loses scope state
 *     ("total is not defined") — corruption, the root enabler under
 *     suspend_resolve_heap_pressure_test.js's stall: the pressure
 *     recovery design (gc + retry) depends on a gc that is unsafe
 *     at exactly that parked moment.
 *   - gc while a slot awaits a handler-returned JS Promise
 *     (suspendOnPromise path): same question, separate park shape.
 *
 * Run with: deno task test tests/runtime/gc_parked_suspend_control_test.js
 */

import { RuntimeBuilder } from '../../src/runtime/test-harness.js';

const CHUNK_BYTES = 8 * 1024;
const HEAP_SIZE = 4 * 1024 * 1024;

function tick(ms = 0) {
  return new Promise((r) => setTimeout(r, ms));
}

async function waitFor(condition, { timeout = 5000, label = 'condition' } = {}) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    if (condition()) return;
    await tick(5);
  }
  throw new Error(`waitFor timed out: ${label}`);
}

const LOOP_SOURCE = `
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
`;

// Build a runtime whose Source.next parks via `parkKind` and settles
// late from a macrotask. `beforeResolve` runs while the slot is
// parked, just before the settle — the gc injection point.
function buildChunkRuntime({ parkKind, chunkCount, beforeResolve }) {
  let served = 0;
  const handlerErrors = [];
  const state = { served: () => served, handlerErrors };

  const builder = new RuntimeBuilder()
    .sessionOptions({ heapSize: HEAP_SIZE })
    .capability({
      name: 'chunk-source',
      setup: (al) => {
        const rootGrant = al.createRootGrant();
        const handle = al.register({});
        rootGrant.add(handle);
        al.setHandler(handle, 'next', ({ context }) => {
          const settle = (resolve) => {
            setTimeout(() => {
              beforeResolve();
              if (served >= chunkCount) {
                resolve(null);
                return;
              }
              served += 1;
              resolve(new Uint8Array(CHUNK_BYTES));
            }, 0);
          };
          if (parkKind === 'suspend') {
            return context.suspend((resolve, _reject) => settle(resolve));
          }
          // parkKind === 'js-promise': return a real Promise; the
          // airlock links it via the suspendOnPromise path.
          return new Promise((resolve) => settle(resolve));
        });
        al.declare('Source', handle);
      },
    })
    .onInboundMessage(() => {});

  const { runtime, session, channels } = builder.build();
  runtime.onHandlerError = (rejection) => { handlerErrors.push(rejection); };
  return { runtime, session, channels, state };
}

async function runChunkScenario({ parkKind, chunkCount, gcWhileParked }) {
  const ctx = buildChunkRuntime({
    parkKind,
    chunkCount,
    beforeResolve: () => { if (gcWhileParked) ctx.session.gc(); },
  });
  const { runtime, session, channels, state } = ctx;

  await runtime.start();
  session.parse(LOOP_SOURCE);
  runtime.run(0);

  try {
    await waitFor(() => session.get(0, 'finished') === true, {
      label: `loop finished (parkKind=${parkKind} gc=${gcWhileParked})`,
    });
  } catch (err) {
    const total = session.get(0, 'total');
    throw new Error(
      `${err.message} — served=${state.served()} ssTotal=${total} ` +
      `handlerErrors=${state.handlerErrors.length}: ` +
      `${state.handlerErrors[0]?.error?.message ?? ''}`,
      { cause: err });
  }

  const total = session.get(0, 'total');
  if (total !== CHUNK_BYTES * chunkCount) {
    throw new Error(`expected total=${CHUNK_BYTES * chunkCount}, got ${total}`);
  }
  if (state.handlerErrors.length > 0) {
    throw new Error(`expected no handler errors, got: ` +
      `${state.handlerErrors[0]?.error?.message ?? state.handlerErrors[0]}`);
  }

  await runtime.terminate();
  channels.close();
}

Deno.test('sanity: chunk loop with no gc completes (suspend park)', async () => {
  await runChunkScenario({ parkKind: 'suspend', chunkCount: 10, gcWhileParked: false });
});

Deno.test('gc while parked at context.suspend — single chunk (minimal)', async () => {
  await runChunkScenario({ parkKind: 'suspend', chunkCount: 1, gcWhileParked: true });
});

Deno.test('gc while parked at context.suspend — chunk loop', async () => {
  await runChunkScenario({ parkKind: 'suspend', chunkCount: 10, gcWhileParked: true });
});

Deno.test('gc while parked on handler JS Promise — chunk loop', async () => {
  await runChunkScenario({ parkKind: 'js-promise', chunkCount: 10, gcWhileParked: true });
});

/**
 * A parked closure with plain-string scope state must survive context-table
 * growth and collection triggered by concurrent listener calls. The closure
 * queue drains those calls sequentially, but each allocateContext can still
 * trigger real heap pressure and collection.
 *
 * One closure parks through context.suspend while retaining name, org, and
 * role. Several other scheduled closures then allocate enough scratch state
 * on a small heap to exercise table growth and explicit collection while the
 * first closure remains parked. After it resumes, the test checks both its
 * retained scope value and the session-header fields used by
 * computeGcScratchLayout; disagreement between segmentSize and stringStart
 * would make stringTableSize negative and identify header corruption.
 */

import { assert, assertEquals } from "https://deno.land/std@0.208.0/assert/mod.ts";
import { RuntimeBuilder } from '../../src/runtime/test-harness.js';

const HEAP_SIZE = 256 * 1024; // small enough that N concurrent closures'
                               // context allocations force real table growth
                               // and heap pressure, not just headroom — but
                               // enough that all N can be live+parked
                               // simultaneously without genuine OOM.
const CONCURRENT_ALLOCATORS = 40;

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

function assertHeaderSane(session, label) {
  const mem = session.memoryImage;
  const stringTableSize = mem.segmentSize - mem.getStringStart();
  assert(mem.segmentSize > 0,
    `${label}: memoryImage.segmentSize must stay positive, got ${mem.segmentSize}`);
  assert(mem.getStringStart() > 0 && mem.getStringStart() < mem.segmentSize,
    `${label}: getStringStart() (${mem.getStringStart()}) must stay within ` +
    `[0, segmentSize=${mem.segmentSize}]`);
  assert(stringTableSize > 0,
    `${label}: segmentSize - getStringStart() must remain positive, got ` +
    `${stringTableSize}; a non-positive value would break ` +
    `computeGcScratchLayout`);
  assert(mem.getContextTablePointer() !== 0,
    `${label}: context table pointer must not be zeroed`);
  assert(mem.getHeapPointer() !== 0,
    `${label}: heap pointer must not be zeroed`);
}

function buildRuntime() {
  const handlerErrors = [];
  let parkedResolve = null;
  let parkedReached = false;
  const captured = { closureA: null, closureB: null };

  const builder = new RuntimeBuilder()
    .sessionOptions({ heapSize: HEAP_SIZE })
    .capability({
      name: 'box-listener',
      setup: (al) => {
        const rootGrant = al.createRootGrant();
        const handle = al.register({});
        rootGrant.add(handle);

        // The guest hands its closures across the membrane as arguments so
        // registration produces the ClosureHandle required by
        // scheduleClosureCall.
        al.setHandler(handle, 'regA', ({ args }) => { captured.closureA = args[0]; return 0; });
        al.setHandler(handle, 'regB', ({ args }) => { captured.closureB = args[0]; return 0; });

        // Controlled suspension: park the calling context on a promise whose
        // release is driven explicitly by the test. This lets the test insert
        // allocation pressure at the exact moment closure A is parked.
        al.setHandler(handle, 'dispatch', ({ context }) => {
          return context.suspend((resolve) => {
            parkedResolve = resolve;
            parkedReached = true;
          });
        });

        // dispatchB briefly parks on a macrotask-deferred suspension so closure
        // B remains mid-drive instead of completing synchronously within one
        // _kickClosureDrainer iteration. Scheduling many B closures back to
        // back leaves several context slots live and parked simultaneously,
        // forcing allocateContext() to grow the context table and create real
        // heap pressure instead of repeatedly recycling one freed slot.
        al.setHandler(handle, 'dispatchB', ({ context }) => {
          return context.suspend((resolve) => {
            setTimeout(() => resolve(undefined), 0);
          });
        });

        al.declare('Box', handle);
      },
    })
    .onInboundMessage(() => {});

  const { runtime, session } = builder.build();
  runtime.onHandlerError = (rejection) => { handlerErrors.push(rejection); };

  return {
    runtime, session, handlerErrors, captured,
    waitUntilParked: () => waitFor(() => parkedReached,
      { label: 'closure A reached context.suspend' }),
    release: () => {
      assert(parkedResolve, 'release() called before closure A parked');
      const fn = parkedResolve;
      parkedResolve = null;
      fn(undefined);
    },
  };
}

Deno.test('gc/allocateContext pressure from concurrent closures while a controlled-suspension closure is parked: no header corruption', async () => {
  const { runtime, session, handlerErrors, captured, waitUntilParked, release } = buildRuntime();
  await runtime.start();

  // Closure A retains plain-string fields in its own guest scope across the
  // controlled await, exercising decoded wire values rather than a
  // Handle/MsgpackRef. Closure B briefly parks via Box.dispatchB(), keeping
  // its context live instead of completing within one _kickClosureDrainer
  // iteration. Many such parked contexts force allocateContext() to grow the
  // context table before each closure allocates a fresh, moderately sized
  // array that pressures the heap. Both closures are registered by reference
  // in the same parse and scope so producing a ClosureHandle does not clobber
  // context 0.
  session.parse(`
    let name = "clearance-check-crew"
    let org = "example-test-org"
    let role = "admin"
    let done = false
    Box.regA(async function() {
      await Box.dispatch()
      done = (name === "clearance-check-crew" && org === "example-test-org" && role === "admin")
    })
    Box.regB(async function() {
      await Box.dispatchB()
      let scratch = []
      let i = 0
      while (i < 200) {
        scratch.push({ index: i, pad: "allocator-pressure-padding" })
        i = i + 1
      }
    })
  `);
  await runtime.run(0);
  assert(captured.closureA, 'closureA not registered');
  assert(captured.closureB, 'closureB not registered');

  runtime.scheduleClosureCall(captured.closureA, []);
  await waitUntilParked();

  assertHeaderSane(session, 'before concurrent allocation pressure');

  // While A remains parked, fire concurrent allocators plus explicit GC
  // passes. The closure drainer processes them sequentially.
  for (let i = 0; i < CONCURRENT_ALLOCATORS; i++) {
    runtime.scheduleClosureCall(captured.closureB, []);
  }
  for (let round = 0; round < 8; round++) {
    await tick(5);
    session.gc();
    assertHeaderSane(session, `mid-pressure round ${round}`);
    assertEquals(session.get(0, 'done'), false,
      `closure A must remain parked through round ${round}, not resumed early`);
  }
  assert(session.memoryImage.getContextCount() > CONCURRENT_ALLOCATORS,
    `expected real context-table growth from ${CONCURRENT_ALLOCATORS} concurrent ` +
    `allocators, got contextCount=${session.memoryImage.getContextCount()} — ` +
    `pressure calibration failure, not evidence of absence`);

  release();
  await waitFor(() => session.get(0, 'done') === true,
    { label: 'closure A resumed and completed' });

  assertHeaderSane(session, 'after closure A resumed');
  assertEquals(session.get(0, 'done'), true,
    'closure A scope (name/org/role) must survive concurrent allocation pressure while parked');
  assertEquals(handlerErrors.length, 0,
    `no handler errors, got: ${handlerErrors.map((e) => e?.error?.message ?? e).join('; ')}`);

  await runtime.terminate();
});

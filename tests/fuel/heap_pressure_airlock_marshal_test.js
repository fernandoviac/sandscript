/**
 * Airlock-side marshalling pressure rollback.
 *
 * When an external handler returns a JS value (array, object,
 * nested structure) and marshalling it into SS heap memory hits the
 * heap-vs-code boundary mid-walk, MemoryImage.marshalResult catches
 * the HeapPressureSignal, rewinds STATE_HEAP_POINTER to its on-entry
 * checkpoint (discarding the partial allocation), and re-throws.
 *
 * The airlock catches that throw in resumeWithValue and stashes the
 * handler's result for retry: the next runContext tick drains the
 * stash, retrying the marshal after the host has run gc(). The
 * handler is NOT re-invoked (its side effects already committed),
 * only the marshal walk is retried.
 */

import { assertEquals, assert } from 'https://deno.land/std@0.208.0/assert/mod.ts';
import { parseAndSetup } from './test-helpers.js';
import { freshSession } from '../../src/host-owned-session.js';
import { HeapPressureSignal } from '../../src/fuel/memory-image.js';

function runWithRecovery(session, maxIters = 200) {
  let result;
  for (let i = 0; i < maxIters; i++) {
    result = session.run(0, 50000);
    if (result.status === 'memory_pressure') {
      session.gc();
      continue;
    }
    return result;
  }
  return result;
}

Deno.test('MemoryImage.marshalResult rolls back the heap pointer on HeapPressureSignal', () => {
  // Direct unit test: call marshalResult with a value that requires
  // an array allocation, on a session whose heap is too full to
  // accommodate it. The throw must propagate, AND the heap pointer
  // must be restored to its on-entry value.
  const session = freshSession({ heapSize: 96 * 1024 });
  const mem = session.airlock.memoryImage;

  // Burn the heap down to a budget that fits the outer array header
  // but not the nested allocations. Goal: marshal walks the outer,
  // succeeds, recurses into inner arrays, hits pressure before
  // finishing — that's the rollback path we want to pin.
  for (;;) {
    const remaining = mem.getCodePointer() - mem.getHeapPointer();
    if (remaining < 350) break;
    try { mem.allocate(200, 0); } catch (e) {
      if (e instanceof HeapPressureSignal) break;
      throw e;
    }
  }

  const heapBefore = mem.getHeapPointer();
  const pendingBefore = mem.getContextPendingPointer(0);
  let threw = false;
  try {
    // Nested structure — outer (80 bytes) fits, then inner arrays
    // start allocating and run into the boundary.
    mem.marshalResult(0, [
      [1, 2, 3, 4, 5, 6, 7, 8, 9, 10],
      [11, 12, 13, 14, 15, 16, 17, 18, 19, 20],
      [21, 22, 23, 24, 25, 26, 27, 28, 29, 30],
    ]);
  } catch (e) {
    threw = true;
    assert(e instanceof HeapPressureSignal,
      `expected HeapPressureSignal, got ${e.name}: ${e.message}`);
  }
  assert(threw, 'expected marshalResult to throw');

  const heapAfter = mem.getHeapPointer();
  assertEquals(heapAfter, heapBefore,
    'heap pointer must be rewound to its pre-marshal checkpoint');

  // pending pointer must NOT have advanced — the marshal didn't
  // finalize, so the slot is still ready to receive the (retried) value.
  const pendingAfter = mem.getContextPendingPointer(0);
  assertEquals(pendingAfter, pendingBefore,
    'pending pointer must not advance on pressure');
});

Deno.test('External handler returning large array recovers under heap pressure', () => {
  // End-to-end: SS calls an external handler that returns a JS
  // array; on tight heap, the marshalResult walk hits pressure on
  // some iterations. The airlock stashes the handler result and the
  // host's gc + retry loop drains it. The handler MUST run exactly
  // once per call site (no re-invocation on marshal retry).
  const session = freshSession({ heapSize: 96 * 1024 });
  const { airlock } = session;
  const rootGrant = airlock.createRootGrant();

  let handlerInvocations = 0;
  const handlerId = airlock.register({});
  rootGrant.add(handlerId);
  airlock.setHandler(handlerId, null, ({ args }) => {
    handlerInvocations++;
    const n = args[0];
    const out = [];
    for (let i = 0; i < n; i++) out.push(i);
    return out;
  });
  airlock.declare('makeArray', handlerId);

  parseAndSetup(session, `
    let total = 0;
    let callCount = 0;
    for (let i = 0; i < 200; i = i + 1) {
      const arr = makeArray(8);
      callCount = callCount + 1;
      for (let j = 0; j < arr.length; j = j + 1) {
        total = total + arr[j];
      }
    }
    let result = total;
    let calls = callCount;
  `);

  const result = runWithRecovery(session);
  assertEquals(result.status, 'done', `expected done, got ${result.status}`);
  // Sum 0..7 = 28; 200 iterations → 5600.
  assertEquals(session.get(0, 'result'), 5600);
  // The SS for-loop ran 200 times.
  assertEquals(session.get(0, 'calls'), 200);
  // The handler must NOT have been invoked more than once per call
  // site, even when marshal retried after pressure.
  assertEquals(handlerInvocations, 200,
    `handler must run exactly once per SS call site; ran ${handlerInvocations} times`);
});

Deno.test('External handler returning nested array recovers under pressure', () => {
  const session = freshSession({ heapSize: 96 * 1024 });
  const { airlock } = session;
  const rootGrant = airlock.createRootGrant();

  let handlerInvocations = 0;
  const handlerId = airlock.register({});
  rootGrant.add(handlerId);
  airlock.setHandler(handlerId, null, () => {
    handlerInvocations++;
    return [[1, 2, 3], [4, 5, 6], [7, 8, 9]];
  });
  airlock.declare('makeNested', handlerId);

  parseAndSetup(session, `
    let total = 0;
    for (let i = 0; i < 150; i = i + 1) {
      const arr = makeNested();
      for (let j = 0; j < arr.length; j = j + 1) {
        const inner = arr[j];
        for (let k = 0; k < inner.length; k = k + 1) {
          total = total + inner[k];
        }
      }
    }
    let result = total;
  `);

  const result = runWithRecovery(session);
  assertEquals(result.status, 'done', `expected done, got ${result.status}`);
  // Sum 1..9 = 45; 150 iterations → 6750.
  assertEquals(session.get(0, 'result'), 6750);
  assertEquals(handlerInvocations, 150);
});

/**
 * Regression pins for host-owned GC scratch headroom.
 *
 * `freshSession`/`restoreSession` (host-owned-session.js) construct
 * their own `WebAssembly.Memory`. Its `maximum` must exceed `initial`
 * by at least the worst-case GC scratch block (`reserveGcScratch`'s
 * grow-path in session.js needs room to `memory.grow()` into on the
 * very first collection), or the first collection that needs to grow
 * scratch fails outright — with ZERO GC rounds attempted, no
 * pressure-retry, regardless of workload. The old
 * `Math.max(initialPages, 256)` floor gave headroom only below the
 * 256-page/16MB boundary; at or above it, `maximum === initial`
 * exactly, so ANY session with a heap that size or larger hit a hard
 * wall on its first real GC.
 */
import { assertEquals, assert } from "https://deno.land/std@0.208.0/assert/mod.ts";
import { freshSession, restoreSession, snapshotSession, sessionBuffers } from '../../src/host-owned-session.js';

function stringKeyLoopSource(count) {
  return `
    let i = 0;
    let junk = "";
    while (i < ${count}) {
      let a = i % 100;
      let b = (i / 100) | 0;
      let key = ("" + a) + "," + ("" + b);
      junk = key;
      i = i + 1;
    }
  `;
}

function runToCompletion(session, source) {
  const result = session.parse(source);
  session.mem.setContextInstructionIndex(0, result.startIndex);
  session.mem.clearExitCondition(0);
  let gcCount = 0;
  for (;;) {
    const out = session.run(0, 300_000_000);
    if (out.status === 'complete' || out.status === 'done') return gcCount;
    if (out.status === 'paused') { session.mem.clearExitCondition(0); continue; }
    if (out.status === 'memory_pressure') { session.gc(); gcCount++; continue; }
    throw new Error(`unexpected status ${out.status}`);
  }
}

Deno.test('a >=16MB session has grow headroom for GC scratch (was: maximum === initial, zero headroom)', () => {
  const session = freshSession({ heapSize: 32 * 1024 * 1024 });
  const { memory } = sessionBuffers(session);
  const before = memory.buffer.byteLength;
  memory.grow(1);
  assert(memory.buffer.byteLength > before, 'memory.grow(1) must succeed on a >=16MB session');
});

Deno.test('a string-building loop past 16MB heap size completes with real GC activity, no cliff', () => {
  for (const heapMB of [8, 16, 17, 32, 64, 256]) {
    const session = freshSession({ heapSize: heapMB * 1024 * 1024 });
    const gcCount = runToCompletion(session, stringKeyLoopSource(50000));
    assert(gcCount > 0, `expected real GC activity at heapSize=${heapMB}MB, got 0`);
    assertEquals(session.get(0, 'i'), 50000);
  }
});

Deno.test('non-string garbage (array churn) also completes past 16MB — not a string-specific bug', () => {
  const session = freshSession({ heapSize: 32 * 1024 * 1024 });
  const gcCount = runToCompletion(session, `
    let acc = 0;
    let i = 0;
    while (i < 2000000) {
      let arr = [i, i + 1, i + 2, i + 3, i + 4, i + 5, i + 6, i + 7];
      acc = acc + arr[2] - arr[1];
      i = i + 1;
    }
  `);
  assert(gcCount > 0, 'expected real GC activity');
  assertEquals(session.get(0, 'acc'), 2000000);
});

Deno.test('a for-loop shape hits the same fix as while (both compile through the same scratch reservation)', () => {
  const session = freshSession({ heapSize: 32 * 1024 * 1024 });
  const gcCount = runToCompletion(session, `
    let junk = "";
    for (let i = 0; i < 50000; i = i + 1) {
      let a = i % 100;
      let b = (i / 100) | 0;
      junk = ("" + a) + "," + ("" + b);
    }
  `);
  assert(gcCount > 0, 'expected real GC activity');
});

Deno.test('restoreSession also budgets scratch headroom for a large restored heap', () => {
  const original = freshSession({ heapSize: 32 * 1024 * 1024 });
  const setup = original.parse('let x = 1;');
  original.mem.setContextInstructionIndex(0, setup.startIndex);
  original.mem.clearExitCondition(0);
  original.run(0, 1000);
  const { vatBytes, membraneBytes } = snapshotSession(original);

  const restored = restoreSession(vatBytes, membraneBytes);
  const gcCount = runToCompletion(restored, stringKeyLoopSource(20000));
  assert(gcCount > 0, 'expected real GC activity on the restored session');
  assertEquals(restored.get(0, 'i'), 20000);
});

Deno.test('scratch headroom scales with membrane table capacities, not just heap size', () => {
  // A larger closure-handle-table capacity means a larger worst-case
  // root block inside the scratch layout — the fix must account for
  // membrane capacities, not just vat heap size, or a session with
  // generous membrane tables and a >=16MB heap would still starve.
  const session = freshSession({
    heapSize: 32 * 1024 * 1024,
    closureHandleTableCapacity: 8192,
    linkedPromiseTableCapacity: 2048,
  });
  const gcCount = runToCompletion(session, stringKeyLoopSource(50000));
  assert(gcCount > 0, 'expected real GC activity');
});

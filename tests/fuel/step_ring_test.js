import { assertEquals, assert } from "https://deno.land/std@0.208.0/assert/mod.ts";
import { RuntimeBuilder } from '../../src/runtime/test-harness.js';
import { readStepRing } from '../../src/fuel/step-ring.js';
import { STEP_RING_HEADER_SIZE, STEP_RING_ENTRY_SIZE } from '../../src/fuel/constants.js';

function buildWithRing(entryCount = 1024) {
  const ringSize = STEP_RING_HEADER_SIZE + entryCount * STEP_RING_ENTRY_SIZE;
  const { runtime, session } = new RuntimeBuilder()
    .sessionOptions({ stepRingSize: ringSize })
    .onInboundMessage(() => {})
    .build();
  return { runtime, session };
}

function getRing(session) {
  return readStepRing(session.memoryImage.view, session.memoryImage.baseOffset);
}

Deno.test('step ring: entries are written during execution', async () => {
  const { runtime, session } = buildWithRing();
  await runtime.start();

  const result = session.parse('let x = 1');
  session.setInstruction(0, result.startIndex);
  await runtime.run(0);

  const ring = getRing(session);
  assert(ring.entries.length > 0, 'ring should have entries after execution');
  assert(ring.writeHead > 0, 'writeHead should have advanced');
});

Deno.test('step ring: entries have correct slot', async () => {
  const { runtime, session } = buildWithRing();
  await runtime.start();

  const result = session.parse('let x = 1');
  session.setInstruction(0, result.startIndex);
  await runtime.run(0);

  const ring = getRing(session);
  for (const entry of ring.entries) {
    assertEquals(entry.slot, 0);
  }
});

Deno.test('step ring: entries include opcode names', async () => {
  const { runtime, session } = buildWithRing();
  await runtime.start();

  const result = session.parse('let x = 42');
  session.setInstruction(0, result.startIndex);
  await runtime.run(0);

  const ring = getRing(session);
  const names = ring.entries.map(e => e.opcodeName);
  assert(names.some(n => n !== 'UNKNOWN'), `all opcodes are UNKNOWN: ${JSON.stringify(names)}`);
});

Deno.test('step ring: pendingDepth changes across instructions', async () => {
  const { runtime, session } = buildWithRing();
  await runtime.start();

  const result = session.parse('let x = 1 + 2');
  session.setInstruction(0, result.startIndex);
  await runtime.run(0);

  const ring = getRing(session);
  const depths = ring.entries.map(e => e.pendingDepth);
  const uniqueDepths = new Set(depths);
  assert(uniqueDepths.size > 1, `pending depth should vary, got: ${JSON.stringify(depths)}`);
});

Deno.test('step ring: heap pointer advances on allocation', async () => {
  const { runtime, session } = buildWithRing();
  await runtime.start();

  const result = session.parse('let x = { a: 1 }');
  session.setInstruction(0, result.startIndex);
  await runtime.run(0);

  const ring = getRing(session);
  const heaps = ring.entries.map(e => e.heapPointer);
  const firstHeap = heaps[0];
  const lastHeap = heaps[heaps.length - 1];
  assert(lastHeap > firstHeap, `heap should grow on object allocation: first=${firstHeap}, last=${lastHeap}`);
});

Deno.test('step ring: consecutive entries enable diff reconstruction', async () => {
  const { runtime, session } = buildWithRing();
  await runtime.start();

  const result = session.parse('let x = 1; let y = 2; let z = x + y');
  session.setInstruction(0, result.startIndex);
  await runtime.run(0);

  const ring = getRing(session);
  assert(ring.entries.length >= 2);

  for (let i = 1; i < ring.entries.length; i++) {
    const prev = ring.entries[i - 1];
    const curr = ring.entries[i];
    const pendingDelta = curr.pendingDepth - prev.pendingDepth;
    const heapDelta = curr.heapPointer - prev.heapPointer;
    assert(typeof pendingDelta === 'number');
    assert(heapDelta >= 0, `heap should never shrink: delta=${heapDelta}`);
  }
});

Deno.test('step ring: no entries when ring is disabled (size 0)', async () => {
  const { runtime, session } = new RuntimeBuilder()
    .onInboundMessage(() => {})
    .build();
  await runtime.start();

  const result = session.parse('let x = 1');
  session.setInstruction(0, result.startIndex);
  await runtime.run(0);

  const ring = getRing(session);
  assertEquals(ring.entries.length, 0);
  assertEquals(ring.writeHead, 0);
  assertEquals(ring.capacity, 0);
});

Deno.test('step ring: wraps correctly when capacity is exceeded', async () => {
  const { runtime, session } = buildWithRing(8);
  await runtime.start();

  const result = session.parse('let a = 1; let b = 2; let c = 3; let d = 4; let e = 5; let f = 6; let g = 7; let h = 8; let i = 9; let j = 10');
  session.setInstruction(0, result.startIndex);
  await runtime.run(0);

  const ring = getRing(session);
  assert(ring.writeHead > 8, `writeHead should exceed capacity (8), got ${ring.writeHead}`);
  assertEquals(ring.entries.length, 8, 'should only keep last 8 entries');
});

Deno.test('step ring: call depth tracks function calls', async () => {
  const { runtime, session } = buildWithRing();
  await runtime.start();

  const result = session.parse('function f() { return 1; } f()');
  session.setInstruction(0, result.startIndex);
  await runtime.run(0);

  const ring = getRing(session);
  const callDepths = ring.entries.map(e => e.callDepth);
  const maxCallDepth = Math.max(...callDepths);
  assert(maxCallDepth >= 1, `should see call depth >= 1 during function call, max was ${maxCallDepth}`);
});

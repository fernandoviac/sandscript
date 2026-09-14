/**
 * Instruction-step ring publication proofs for the durable contract in
 * docs/ring-publication-contract.md: the layout v26 cursor-segment
 * cutover, bounded validated range reads, exact overwrite gaps,
 * pre-segment version rejection, and a concurrent reader paging while
 * the real WebAssembly interpreter laps the ring.
 *
 * Run with: deno task test tests/fuel/step_ring_publication_test.js
 */
import { assert, assertEquals } from "https://deno.land/std@0.208.0/assert/mod.ts";
import { RuntimeBuilder } from '../../src/runtime/test-harness.js';
import { readStepRing, readStepRingRange } from '../../src/fuel/step-ring.js';
import {
  STEP_RING,
  STEP_RING_HEADER_SIZE,
  STEP_RING_ENTRY_SIZE,
  RING_FLAG_SEGMENT_SPACE_EXHAUSTED,
  STATE,
} from '../../src/fuel/constants.js';
import {
  RING_READ_STATUS,
} from '../../src/ring-publication.js';

function buildWithRing(entryCount) {
  const ringSize = STEP_RING_HEADER_SIZE + entryCount * STEP_RING_ENTRY_SIZE;
  const { runtime, session } = new RuntimeBuilder()
    .sessionOptions({ stepRingSize: ringSize })
    .fuel(10_000_000)
    .onInboundMessage(() => {})
    .build();
  return { runtime, session };
}

function ringBaseOf(session) {
  const mem = session.memoryImage;
  return mem.view.getUint32(mem.baseOffset + STATE.STEP_RING_BASE, true);
}

Deno.test('step ring publication: layout stamps the ring format version', async () => {
  const { runtime, session } = buildWithRing(64);
  const mem = session.memoryImage;
  assertEquals(
    mem.view.getUint32(mem.baseOffset + ringBaseOf(session) + STEP_RING.FORMAT_VERSION, true),
    3);
  assertEquals(
    mem.view.getUint32(
      mem.baseOffset + ringBaseOf(session) + STEP_RING.SEGMENT_GENERATION, true),
    1);
  const page = readStepRingRange(mem.view, mem.baseOffset);
  assertEquals(page.status, RING_READ_STATUS.OK);
  await runtime.terminate();
});

Deno.test('step ring publication: pre-segment format is rejected loudly', async () => {
  const { runtime, session } = buildWithRing(64);
  const mem = session.memoryImage;
  mem.view.setUint32(mem.baseOffset + ringBaseOf(session) + STEP_RING.FORMAT_VERSION, 2, true);
  const page = readStepRingRange(mem.view, mem.baseOffset);
  assertEquals(page.status, RING_READ_STATUS.UNSUPPORTED_VERSION);
  assertEquals(page.declaredVersion, 2);
  await runtime.terminate();
});

Deno.test('step ring publication: zero generation is malformed', async () => {
  const { runtime, session } = buildWithRing(64);
  const mem = session.memoryImage;
  mem.view.setUint32(
    mem.baseOffset + ringBaseOf(session) + STEP_RING.SEGMENT_GENERATION,
    0,
    true);
  const page = readStepRingRange(mem.view, mem.baseOffset);
  assertEquals(page.status, RING_READ_STATUS.MALFORMED);
  assertEquals(page.entries, []);
  await runtime.terminate();
});

Deno.test('step ring publication: execution publishes contiguous validated indexes', async () => {
  const { runtime, session } = buildWithRing(1024);
  await runtime.start();
  const parsed = session.parse('let total = 0; for (let i = 0; i < 20; i = i + 1) { total = total + i }');
  session.setInstruction(0, parsed.startIndex);
  await runtime.run(0);

  const mem = session.memoryImage;
  const page = readStepRingRange(mem.view, mem.baseOffset);
  assertEquals(page.status, RING_READ_STATUS.OK);
  assert(page.entries.length > 0, 'execution should publish step entries');
  assertEquals(page.gap, null);
  for (let i = 0; i < page.entries.length; i++) {
    assertEquals(page.entries[i].index, i + 1, 'indexes are 1-based and contiguous');
  }
  assert(page.entries.every((e) => typeof e.opcodeName === 'string'));
  // The legacy whole-window reader agrees with the validated range.
  const legacy = readStepRing(mem.view, mem.baseOffset);
  assertEquals(legacy.entries.length, page.entries.length);
  assertEquals(legacy.writeHead, page.reservationHead);
  await runtime.terminate();
});

Deno.test('step ring publication: lapping the ring reports the exact overwrite gap', async () => {
  const { runtime, session } = buildWithRing(32); // tiny ring — guaranteed laps
  await runtime.start();
  const parsed = session.parse('let total = 0; for (let i = 0; i < 200; i = i + 1) { total = total + i }');
  session.setInstruction(0, parsed.startIndex);
  await runtime.run(0);

  const mem = session.memoryImage;
  const page = readStepRingRange(mem.view, mem.baseOffset, { afterIndex: 0 });
  assertEquals(page.status, RING_READ_STATUS.OK);
  assert(page.reservationHead > 32, 'the writer should have lapped the ring');
  assertEquals(page.gap, {
    firstMissingIndex: 1,
    lastMissingIndex: page.reservationHead - 32,
  });
  assertEquals(page.entries.length, 32);
  assertEquals(page.entries[0].index, page.reservationHead - 31);
  assertEquals(page.entries[31].index, page.reservationHead);
  await runtime.terminate();
});

Deno.test('step ring publication: WebAssembly writer transitions generation before wrap', async () => {
  const { runtime, session } = buildWithRing(64);
  const mem = session.memoryImage;
  const base = mem.baseOffset + ringBaseOf(session);
  mem.view.setUint32(base + STEP_RING.WRITE_HEAD, 0xffffffff, true);
  mem.view.setUint32(base + STEP_RING.SEGMENT_GENERATION, 1, true);

  await runtime.start();
  const parsed = session.parse('let value = 1');
  session.setInstruction(0, parsed.startIndex);
  const result = await runtime.run(0);
  assertEquals(result.status, 'done');

  assertEquals(mem.view.getUint32(base + STEP_RING.SEGMENT_GENERATION, true), 2);
  const page = readStepRingRange(mem.view, mem.baseOffset, {
    expectedSegmentGeneration: 2,
  });
  assertEquals(page.status, RING_READ_STATUS.OK);
  assertEquals(page.segmentGeneration, 2);
  assert(page.entries.length > 0);
  assert(page.entries.every((entry) => entry.index > 0));
  const stale = readStepRingRange(mem.view, mem.baseOffset, {
    expectedSegmentGeneration: 1,
  });
  assertEquals(stale.status, RING_READ_STATUS.SEGMENT_CHANGED);
  assertEquals(stale.entries, []);
  await runtime.terminate();
});

Deno.test('step ring publication: terminal exhaustion does not block execution', async () => {
  const { runtime, session } = buildWithRing(64);
  const mem = session.memoryImage;
  const base = mem.baseOffset + ringBaseOf(session);
  mem.view.setUint32(base + STEP_RING.WRITE_HEAD, 0xffffffff, true);
  mem.view.setUint32(base + STEP_RING.SEGMENT_GENERATION, 0xffffffff, true);

  await runtime.start();
  const parsed = session.parse('let value = 1');
  session.setInstruction(0, parsed.startIndex);
  const result = await runtime.run(0);
  assertEquals(result.status, 'done');
  assertEquals(mem.view.getUint32(base + STEP_RING.WRITE_HEAD, true), 0xffffffff);
  assertEquals(
    mem.view.getUint32(base + STEP_RING.FLAGS, true),
    RING_FLAG_SEGMENT_SPACE_EXHAUSTED);
  const page = readStepRingRange(mem.view, mem.baseOffset);
  assertEquals(page.status, RING_READ_STATUS.SEGMENT_SPACE_EXHAUSTED);
  assertEquals(page.entries, []);
  await runtime.terminate();
});

Deno.test('step ring publication: concurrent reader stays coherent while the interpreter laps', async () => {
  const { runtime, session } = buildWithRing(64);
  const buffer = session.memoryImage.buffer;
  assert(buffer instanceof SharedArrayBuffer, 'vat memory must be shared');
  const control = new Int32Array(new SharedArrayBuffer(4));

  const workerScript = `
    import { readStepRingRange } from '${new URL('../../src/fuel/step-ring.js', import.meta.url).href}';
    import { RING_READ_STATUS } from '${new URL('../../src/ring-publication.js', import.meta.url).href}';
    self.onmessage = (e) => {
      const { buffer, baseOffset, control } = e.data;
      const view = new DataView(buffer);
      const violations = [];
      const acceptedByIndex = new Map();
      let pages = 0;
      let cursor = 0;
      const deadline = Date.now() + 8000;
      while (Date.now() < deadline) {
        const page = readStepRingRange(view, baseOffset, { afterIndex: cursor, maximumEntries: 16 });
        pages++;
        if (page.status !== RING_READ_STATUS.OK) {
          violations.push('status ' + page.status + ' at cursor ' + cursor);
          break;
        }
        let previous = page.gap ? page.gap.lastMissingIndex : cursor;
        for (const entry of page.entries) {
          if (entry.index !== ((previous + 1) >>> 0)) {
            violations.push('index jump ' + previous + ' -> ' + entry.index);
          }
          previous = entry.index;
          if (acceptedByIndex.has(entry.index)) {
            violations.push('duplicate index ' + entry.index);
          }
          acceptedByIndex.set(entry.index, {
            instructionIndex: entry.instructionIndex,
            opcode: entry.opcode,
            slot: entry.slot,
          });
        }
        if (page.entries.length > 0) cursor = page.entries[page.entries.length - 1].index;
        else if (page.gap) cursor = page.gap.lastMissingIndex;
        const writerDone = Atomics.load(control, 0) === 1;
        if (writerDone && page.entries.length === 0 && page.gap === null) break;
      }
      self.postMessage({
        pages,
        accepted: acceptedByIndex.size,
        acceptedEntries: Array.from(acceptedByIndex.entries()),
        violations,
      });
    };
  `;
  const worker = new Worker(URL.createObjectURL(new Blob([workerScript], { type: 'application/javascript' })), { type: 'module' });
  const summaryPromise = new Promise((resolve) => { worker.onmessage = (e) => resolve(e.data); });
  worker.postMessage({ buffer, baseOffset: session.memoryImage.baseOffset, control });
  await new Promise((r) => setTimeout(r, 50));

  await runtime.start();
  const parsed = session.parse(
    'let total = 0; for (let i = 0; i < 30000; i = i + 1) { total = total + i }');
  session.setInstruction(0, parsed.startIndex);
  await runtime.run(0);
  Atomics.store(control, 0, 1);

  const summary = await summaryPromise;
  worker.terminate();

  assertEquals(summary.violations, [], 'reader must stay coherent while the writer laps');
  assert(summary.pages > 10, `reader should have paged continuously (got ${summary.pages})`);
  assert(summary.accepted > 0, 'reader should have accepted records');

  // Records are immutable once published: every accepted entry whose
  // index is still retained at the end must match the final decode.
  const mem = session.memoryImage;
  const finalPage = readStepRingRange(mem.view, mem.baseOffset);
  const finalByIndex = new Map(finalPage.entries.map((e) => [e.index, e]));
  let compared = 0;
  for (const [index, seen] of summary.acceptedEntries) {
    const final = finalByIndex.get(index);
    if (!final) continue; // overwritten after the worker read it
    compared++;
    assertEquals(seen.instructionIndex, final.instructionIndex, `instructionIndex drift at ${index}`);
    assertEquals(seen.opcode, final.opcode, `opcode drift at ${index}`);
    assertEquals(seen.slot, final.slot, `slot drift at ${index}`);
  }
  await runtime.terminate();
});

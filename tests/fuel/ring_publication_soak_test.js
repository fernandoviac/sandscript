/**
 * Ring-publication soak proofs — harder concurrency than the per-ring
 * publication tests, run before trusting the contract in production:
 *
 * - cost ledger: capacity 4 (maximum wrap pressure), 200k appends,
 *   THREE simultaneous readers — two sequential validators with
 *   different page sizes plus a chaos reader issuing random cursors
 *   and bounds, all validating every accepted record against the
 *   index-derived gauge equations and newest-committed monotonicity;
 * - header-event ring: the WAT GC-path writers ($header_event_ring_write
 *   and the parked-slots twin) exercised by repeated real collections
 *   while a reader pages a tiny ring throughout — the per-ring proof
 *   only covered the JS twin concurrently;
 * - step ring: an 8-entry ring lapped ~100k times by the interpreter
 *   with a sequential validator AND a chaos reader in flight, plus the
 *   record-immutability comparison at the end.
 *
 * Run with: deno task test tests/fuel/ring_publication_soak_test.js
 */
import { assert, assertEquals } from "https://deno.land/std@0.208.0/assert/mod.ts";
import { HEADER } from '../../src/membrane/index.js';
import { freshMembrane } from '../../src/host-owned-session.js';
import { RuntimeBuilder } from '../../src/runtime/test-harness.js';
import { readStepRingRange } from '../../src/fuel/step-ring.js';
import {
  STEP_RING_HEADER_SIZE,
  STEP_RING_ENTRY_SIZE,
  HEADER_EVENT_RING_HEADER_SIZE,
  HEADER_EVENT_RING_ENTRY_SIZE,
  HEADER_EVENT_KIND,
} from '../../src/fuel/constants.js';

const MEMBRANE_OPTIONS = {
  handleTableCapacity: 16, grantTableCapacity: 8, idListPoolSize: 256,
  rootGrantsListCapacity: 4, valueArenaSize: 256, closureHandleTableCapacity: 4,
  linkedPromiseTableCapacity: 4, mutationLogCapacity: 16,
  costLedgerCapacity: 4, // the smallest legal ring — maximum wrap pressure
};

function spawnReader(script, payload) {
  const worker = new Worker(
    URL.createObjectURL(new Blob([script], { type: 'application/javascript' })),
    { type: 'module' });
  const summary = new Promise((resolve) => { worker.onmessage = (e) => resolve(e.data); });
  worker.postMessage(payload);
  return { worker, summary };
}

// Reader-side validation helpers inlined into the cost workers:
// index-derived gauge equations and newest-committed monotonicity.
const COST_READER_LIB = `
  const checkEntry = (entry, violations) => {
    const index = BigInt(entry.index);
    if (entry.fuel !== index ||
        entry.wallNanos !== index * 3n ||
        entry.bytesIn !== index * 7n + 1n ||
        entry.bytesOut !== index * 11n + 2n ||
        entry.calls !== index + 5n ||
        entry.cpuNanos !== index * 13n + 3n) {
      violations.push('incoherent record at index ' + entry.index);
    }
  };
  const checkMonotonicCommit = (state, page, violations) => {
    const advance = (page.newestCommitted - state.lastCommitted) >>> 0;
    if (advance > 0x80000000) {
      violations.push('newestCommitted went backward: ' +
        state.lastCommitted + ' -> ' + page.newestCommitted);
    }
    state.lastCommitted = page.newestCommitted;
  };
`;

Deno.test('soak: cost ledger survives three simultaneous readers over a 4-slot ring', async () => {
  const m = freshMembrane({ ...MEMBRANE_OPTIONS });
  const control = new Int32Array(new SharedArrayBuffer(4));
  const TOTAL = 200000;
  const costModule = new URL('../../src/runtime/cost-ledger.js', import.meta.url).href;

  const sequentialScript = (pageSize) => `
    import { createCostLedgerView, RING_READ_STATUS } from '${costModule}';
    ${COST_READER_LIB}
    self.onmessage = (e) => {
      const { buffer, byteOffset, ringOffset, capacity, headByteOffset,
        generationByteOffset, flagsByteOffset, control } = e.data;
      const view = createCostLedgerView({
        buffer, byteOffset: byteOffset + ringOffset, capacity,
        reservationHeadByteOffset: headByteOffset,
        segmentGenerationByteOffset: generationByteOffset,
        flagsByteOffset });
      const violations = [];
      const state = { lastCommitted: 0 };
      let pages = 0, accepted = 0, cursor = 0;
      const deadline = Date.now() + 15000;
      while (Date.now() < deadline) {
        const page = view.readRange({ afterIndex: cursor, maximumEntries: ${pageSize} });
        pages++;
        if (page.status !== RING_READ_STATUS.OK) {
          violations.push('status ' + page.status + ' at cursor ' + cursor);
          break;
        }
        checkMonotonicCommit(state, page, violations);
        let previous = page.gap ? page.gap.lastMissingIndex : cursor;
        for (const entry of page.entries) {
          if (entry.index !== ((previous + 1) >>> 0)) {
            violations.push('index jump ' + previous + ' -> ' + entry.index);
          }
          previous = entry.index;
          accepted++;
          checkEntry(entry, violations);
        }
        if (page.entries.length > 0) cursor = page.entries[page.entries.length - 1].index;
        else if (page.gap) cursor = page.gap.lastMissingIndex;
        if (Atomics.load(control, 0) === 1 && page.entries.length === 0 && page.gap === null) break;
        if (violations.length > 20) break;
      }
      self.postMessage({ pages, accepted, violations });
    };
  `;

  const chaosScript = `
    import { createCostLedgerView, RING_READ_STATUS } from '${costModule}';
    ${COST_READER_LIB}
    self.onmessage = (e) => {
      const { buffer, byteOffset, ringOffset, capacity, headByteOffset,
        generationByteOffset, flagsByteOffset, control } = e.data;
      const headWords = new Uint32Array(buffer, headByteOffset, 1);
      const view = createCostLedgerView({
        buffer, byteOffset: byteOffset + ringOffset, capacity,
        reservationHeadByteOffset: headByteOffset,
        segmentGenerationByteOffset: generationByteOffset,
        flagsByteOffset });
      const violations = [];
      let pages = 0, accepted = 0;
      let randomState = 0x9E3779B9;
      const nextRandom = () => {
        randomState ^= randomState << 13; randomState ^= randomState >>> 17;
        randomState ^= randomState << 5; return randomState >>> 0;
      };
      const deadline = Date.now() + 15000;
      while (Date.now() < deadline) {
        const head = Atomics.load(headWords, 0) >>> 0;
        // Random cursor anywhere from far-behind to slightly ahead;
        // random entry and byte bounds. Only OK and INVALID_CURSOR are
        // legal outcomes, and every accepted record must be coherent.
        const afterIndex = (head + 5 - (nextRandom() % 64)) >>> 0;
        const page = view.readRange({
          afterIndex,
          maximumEntries: 1 + (nextRandom() % 7),
          maximumBytes: 96 + (nextRandom() % 400),
        });
        pages++;
        if (page.status !== RING_READ_STATUS.OK &&
            page.status !== RING_READ_STATUS.INVALID_CURSOR) {
          violations.push('status ' + page.status + ' at random cursor ' + afterIndex);
        }
        if (page.status === RING_READ_STATUS.INVALID_CURSOR &&
            ((page.reservationHead - afterIndex) >>> 0) <= 0x80000000) {
          violations.push('spurious invalid-cursor for in-window cursor ' + afterIndex + ' at head ' + page.reservationHead);
        }
        for (const entry of page.entries) { accepted++; checkEntry(entry, violations); }
        if (Atomics.load(control, 0) === 1 && pages > 100) break;
        if (violations.length > 20) break;
      }
      self.postMessage({ pages, accepted, violations });
    };
  `;

  const payload = {
    buffer: m.buffer,
    byteOffset: m.byteOffset,
    ringOffset: m.view.getUint32(HEADER.COST_LEDGER_OFFSET, true),
    capacity: m.view.getUint32(HEADER.COST_LEDGER_CAPACITY, true),
    headByteOffset: m.byteOffset + HEADER.COST_LEDGER_WRITE_INDEX,
    generationByteOffset:
      m.byteOffset + HEADER.COST_LEDGER_SEGMENT_GENERATION,
    flagsByteOffset: m.byteOffset + HEADER.COST_LEDGER_FLAGS,
    control,
  };
  const readers = [
    spawnReader(sequentialScript(3), payload),
    spawnReader(sequentialScript(16), payload),
    spawnReader(chaosScript, payload),
  ];

  await new Promise((r) => setTimeout(r, 100));
  for (let i = 1; i <= TOTAL; i++) {
    m.appendCostEntry(1, 0, {
      fuel: i, wallNanos: i * 3, bytesIn: i * 7 + 1,
      bytesOut: i * 11 + 2, calls: i + 5, cpuNanos: i * 13 + 3,
    });
  }
  Atomics.store(control, 0, 1);

  const summaries = await Promise.all(readers.map((r) => r.summary));
  for (const r of readers) r.worker.terminate();
  for (const [i, summary] of summaries.entries()) {
    assertEquals(summary.violations, [], `reader ${i} observed violations`);
    assert(summary.pages > 50, `reader ${i} should have paged continuously (got ${summary.pages})`);
  }
  assert(summaries[0].accepted + summaries[1].accepted > 0, 'sequential readers accepted records');
});

Deno.test('soak: WAT GC-path header-event writers stay coherent under live paging', async () => {
  const RING_ENTRIES = 8;
  const ringSize = HEADER_EVENT_RING_HEADER_SIZE + RING_ENTRIES * HEADER_EVENT_RING_ENTRY_SIZE;
  const { runtime, session } = new RuntimeBuilder()
    .sessionOptions({ headerEventRingSize: ringSize })
    .fuel(50_000_000)
    .onInboundMessage(() => {})
    .build();
  await runtime.start();
  const buffer = session.memoryImage.buffer;
  assert(buffer instanceof SharedArrayBuffer);
  const control = new Int32Array(new SharedArrayBuffer(4));
  const knownKinds = Object.values(HEADER_EVENT_KIND);

  const workerScript = `
    import { readHeaderEventRingRange } from '${new URL('../../src/fuel/header-event-ring.js', import.meta.url).href}';
    import { RING_READ_STATUS } from '${new URL('../../src/ring-publication.js', import.meta.url).href}';
    self.onmessage = (e) => {
      const { buffer, baseOffset, control, knownKinds } = e.data;
      const view = new DataView(buffer);
      const kinds = new Set(knownKinds);
      const violations = [];
      const seenKinds = new Set();
      let pages = 0, accepted = 0, cursor = 0, lastCommitted = 0;
      const deadline = Date.now() + 15000;
      while (Date.now() < deadline) {
        const page = readHeaderEventRingRange(view, baseOffset, { afterIndex: cursor, maximumEntries: 4 });
        pages++;
        if (page.status !== RING_READ_STATUS.OK) {
          violations.push('status ' + page.status + ' at cursor ' + cursor);
          break;
        }
        const advance = (page.newestCommitted - lastCommitted) >>> 0;
        if (advance > 0x80000000) {
          violations.push('newestCommitted went backward: ' + lastCommitted + ' -> ' + page.newestCommitted);
        }
        lastCommitted = page.newestCommitted;
        let previous = page.gap ? page.gap.lastMissingIndex : cursor;
        for (const entry of page.entries) {
          if (entry.index !== ((previous + 1) >>> 0)) {
            violations.push('index jump ' + previous + ' -> ' + entry.index);
          }
          previous = entry.index;
          accepted++;
          seenKinds.add(entry.kind);
          if (!kinds.has(entry.kind)) {
            violations.push('unknown kind ' + entry.kind + ' at index ' + entry.index);
          }
          if (entry.parkedSlots && entry.parkedSlots.length > entry.parkedCount) {
            violations.push('bitmap larger than parked count at index ' + entry.index);
          }
        }
        if (page.entries.length > 0) cursor = page.entries[page.entries.length - 1].index;
        else if (page.gap) cursor = page.gap.lastMissingIndex;
        if (Atomics.load(control, 0) === 1 && page.entries.length === 0 && page.gap === null) break;
        if (violations.length > 20) break;
      }
      self.postMessage({ pages, accepted, violations, seenKinds: Array.from(seenKinds) });
    };
  `;
  const { worker, summary } = spawnReader(workerScript, {
    buffer,
    baseOffset: session.memoryImage.baseOffset,
    control,
    knownKinds,
  });
  await new Promise((r) => setTimeout(r, 50));

  // Drive real WAT collections in bursts while the reader pages. Each
  // gc() writes GC_CYCLE_START, a parked-slots snapshot, any pointer
  // field-writes, and GC_CYCLE_END through the WAT twins.
  const parsed = session.parse('let keep = [1, 2, 3]');
  session.setInstruction(0, parsed.startIndex);
  await runtime.run(0);
  for (let cycle = 0; cycle < 400; cycle++) {
    session.gc();
  }
  Atomics.store(control, 0, 1);

  const result = await summary;
  worker.terminate();
  assertEquals(result.violations, [], 'reader observed violations against the WAT writers');
  assert(result.pages > 50, `reader should have paged continuously (got ${result.pages})`);
  assert(result.accepted > 0, 'reader should have accepted WAT-written records');
  assert(result.seenKinds.includes(HEADER_EVENT_KIND.GC_CYCLE_START),
    'soak must actually exercise GC cycle writes');
  await runtime.terminate();
});

Deno.test('soak: step ring stays coherent under ~100k instructions with two readers', async () => {
  const RING_ENTRIES = 8;
  const ringSize = STEP_RING_HEADER_SIZE + RING_ENTRIES * STEP_RING_ENTRY_SIZE;
  const { runtime, session } = new RuntimeBuilder()
    .sessionOptions({ stepRingSize: ringSize })
    .fuel(50_000_000)
    .onInboundMessage(() => {})
    .build();
  const buffer = session.memoryImage.buffer;
  const baseOffset = session.memoryImage.baseOffset;
  const control = new Int32Array(new SharedArrayBuffer(4));
  const stepModule = new URL('../../src/fuel/step-ring.js', import.meta.url).href;
  const contractModule = new URL('../../src/ring-publication.js', import.meta.url).href;

  const sequentialScript = `
    import { readStepRingRange } from '${stepModule}';
    import { RING_READ_STATUS } from '${contractModule}';
    self.onmessage = (e) => {
      const { buffer, baseOffset, control } = e.data;
      const view = new DataView(buffer);
      const violations = [];
      const acceptedByIndex = new Map();
      let pages = 0, cursor = 0, lastCommitted = 0;
      const deadline = Date.now() + 15000;
      while (Date.now() < deadline) {
        const page = readStepRingRange(view, baseOffset, { afterIndex: cursor, maximumEntries: 5 });
        pages++;
        if (page.status !== RING_READ_STATUS.OK) {
          violations.push('status ' + page.status + ' at cursor ' + cursor);
          break;
        }
        const advance = (page.newestCommitted - lastCommitted) >>> 0;
        if (advance > 0x80000000) {
          violations.push('newestCommitted went backward: ' + lastCommitted + ' -> ' + page.newestCommitted);
        }
        lastCommitted = page.newestCommitted;
        let previous = page.gap ? page.gap.lastMissingIndex : cursor;
        for (const entry of page.entries) {
          if (entry.index !== ((previous + 1) >>> 0)) {
            violations.push('index jump ' + previous + ' -> ' + entry.index);
          }
          previous = entry.index;
          if (acceptedByIndex.has(entry.index)) violations.push('duplicate index ' + entry.index);
          acceptedByIndex.set(entry.index, {
            instructionIndex: entry.instructionIndex, opcode: entry.opcode, slot: entry.slot });
        }
        if (page.entries.length > 0) cursor = page.entries[page.entries.length - 1].index;
        else if (page.gap) cursor = page.gap.lastMissingIndex;
        if (Atomics.load(control, 0) === 1 && page.entries.length === 0 && page.gap === null) break;
        if (violations.length > 20) break;
      }
      self.postMessage({
        pages, accepted: acceptedByIndex.size,
        acceptedEntries: Array.from(acceptedByIndex.entries()), violations });
    };
  `;

  const chaosScript = `
    import { readStepRingRange } from '${stepModule}';
    import { RING_READ_STATUS } from '${contractModule}';
    self.onmessage = (e) => {
      const { buffer, baseOffset, control } = e.data;
      const view = new DataView(buffer);
      const violations = [];
      let pages = 0, accepted = 0;
      let randomState = 0x2545F491;
      const nextRandom = () => {
        randomState ^= randomState << 13; randomState ^= randomState >>> 17;
        randomState ^= randomState << 5; return randomState >>> 0;
      };
      const deadline = Date.now() + 15000;
      while (Date.now() < deadline) {
        const probe = readStepRingRange(view, baseOffset, { afterIndex: 0, maximumEntries: 1 });
        if (probe.status !== RING_READ_STATUS.OK) {
          violations.push('probe status ' + probe.status);
          break;
        }
        const head = probe.reservationHead;
        const afterIndex = (head + 3 - (nextRandom() % 32)) >>> 0;
        const page = readStepRingRange(view, baseOffset, {
          afterIndex,
          maximumEntries: 1 + (nextRandom() % 6),
          maximumBytes: 40 + (nextRandom() % 300),
        });
        pages++;
        if (page.status !== RING_READ_STATUS.OK &&
            page.status !== RING_READ_STATUS.INVALID_CURSOR) {
          violations.push('status ' + page.status + ' at random cursor ' + afterIndex);
        }
        accepted += page.entries.length;
        if (Atomics.load(control, 0) === 1 && pages > 100) break;
        if (violations.length > 20) break;
      }
      self.postMessage({ pages, accepted, violations });
    };
  `;

  const payload = { buffer, baseOffset, control };
  const sequential = spawnReader(sequentialScript, payload);
  const chaos = spawnReader(chaosScript, payload);
  await new Promise((r) => setTimeout(r, 50));

  await runtime.start();
  const parsed = session.parse(
    'let total = 0; for (let i = 0; i < 100000; i = i + 1) { total = total + i }');
  session.setInstruction(0, parsed.startIndex);
  await runtime.run(0);
  Atomics.store(control, 0, 1);

  const [sequentialSummary, chaosSummary] = await Promise.all([sequential.summary, chaos.summary]);
  sequential.worker.terminate();
  chaos.worker.terminate();

  assertEquals(sequentialSummary.violations, [], 'sequential reader observed violations');
  assertEquals(chaosSummary.violations, [], 'chaos reader observed violations');
  assert(sequentialSummary.pages > 50, `sequential reader paged continuously (got ${sequentialSummary.pages})`);
  assert(chaosSummary.pages > 50, `chaos reader paged continuously (got ${chaosSummary.pages})`);
  assert(sequentialSummary.accepted > 0, 'sequential reader accepted records');

  // Immutability: accepted entries still retained must match the final decode.
  const mem = session.memoryImage;
  const finalPage = readStepRingRange(mem.view, mem.baseOffset);
  const finalByIndex = new Map(finalPage.entries.map((e) => [e.index, e]));
  for (const [index, seen] of sequentialSummary.acceptedEntries) {
    const final = finalByIndex.get(index);
    if (!final) continue;
    assertEquals(seen.instructionIndex, final.instructionIndex, `instructionIndex drift at ${index}`);
    assertEquals(seen.opcode, final.opcode, `opcode drift at ${index}`);
    assertEquals(seen.slot, final.slot, `slot drift at ${index}`);
  }
  await runtime.terminate();
});

/**
 * Concurrent cost-ledger publication proof for
 * docs/ring-publication-contract.md: write concurrently and prove no accepted
 * record combines two writes.
 *
 * The main thread appends entries whose gauge fields are all derived
 * from the entry's own 1-based index; a Worker reads bounded validated
 * pages the whole time. Every entry the reader ACCEPTS must satisfy
 * the derivation exactly — a record combining bytes from two different
 * writes cannot. The reader must also never block, and its pages must
 * be strictly ordered with typed truncation only.
 *
 * Run with: deno task test tests/runtime/cost_ledger_concurrent_test.js
 */

import { assert, assertEquals } from "https://deno.land/std@0.208.0/assert/mod.ts";
import { HEADER } from '../../src/membrane/index.js';
import { freshMembrane } from '../../src/host-owned-session.js';

const SMALL = {
  handleTableCapacity: 16, grantTableCapacity: 8, idListPoolSize: 256,
  rootGrantsListCapacity: 4, valueArenaSize: 256, closureHandleTableCapacity: 4,
  linkedPromiseTableCapacity: 4, mutationLogCapacity: 16,
  costLedgerCapacity: 64, // small ring => heavy wrapping under load
};

const TOTAL_APPENDS = 60000;

// Gauges derived from the 1-based index; any torn combination of two
// writes breaks at least one equation.
function gaugesFor(index) {
  return {
    fuel: index,
    wallNanos: index * 3,
    bytesIn: index * 7 + 1,
    bytesOut: index * 11 + 2,
    calls: index + 5,
    cpuNanos: index * 13 + 3,
  };
}

Deno.test('cost ledger: concurrent reader accepts only coherent records', async () => {
  const m = freshMembrane({ ...SMALL });
  const buffer = m.buffer;
  assert(buffer instanceof SharedArrayBuffer, 'proof needs a shared membrane');

  // One-word control channel: main sets it to 1 after the last append
  // so the worker can stop as soon as it has drained to the head.
  const control = new Int32Array(new SharedArrayBuffer(4));

  const workerScript = `
    import { createCostLedgerView, RING_READ_STATUS } from '${new URL('../../src/runtime/cost-ledger.js', import.meta.url).href}';
    self.onmessage = (e) => {
      const { buffer, byteOffset, ringOffset, capacity, headByteOffset,
        generationByteOffset, flagsByteOffset, control } = e.data;
      const violations = [];
      let pages = 0;
      let accepted = 0;
      let sawTruncation = 0;
      let cursor = 0;
      const deadline = Date.now() + 4000;
      while (Date.now() < deadline) {
        const view = createCostLedgerView({
          buffer, byteOffset: byteOffset + ringOffset, capacity,
          reservationHeadByteOffset: headByteOffset,
          segmentGenerationByteOffset: generationByteOffset,
          flagsByteOffset,
        });
        const page = view.readRange({ afterIndex: cursor, maximumEntries: 16 });
        pages++;
        if (page.status !== RING_READ_STATUS.OK) {
          violations.push('status ' + page.status + ' at cursor ' + cursor);
          break;
        }
        if (page.truncation) sawTruncation++;
        let previousIndex = page.gap ? page.gap.lastMissingIndex : cursor;
        for (const entry of page.entries) {
          if (entry.index !== ((previousIndex + 1) >>> 0)) {
            violations.push('index jump ' + previousIndex + ' -> ' + entry.index);
          }
          previousIndex = entry.index;
          accepted++;
          const index = BigInt(entry.index);
          if (entry.fuel !== index ||
              entry.wallNanos !== index * 3n ||
              entry.bytesIn !== index * 7n + 1n ||
              entry.bytesOut !== index * 11n + 2n ||
              entry.calls !== index + 5n ||
              entry.cpuNanos !== index * 13n + 3n) {
            violations.push('incoherent record at index ' + entry.index);
          }
        }
        if (page.entries.length > 0) cursor = page.entries[page.entries.length - 1].index;
        else if (page.gap) cursor = page.gap.lastMissingIndex;
        const writerDone = Atomics.load(control, 0) === 1;
        // Never wait for the writer; move straight to the next page.
        if (writerDone && page.entries.length === 0 && page.gap === null) break;
      }
      self.postMessage({ pages, accepted, sawTruncation, violations });
    };
  `;
  const blob = new Blob([workerScript], { type: 'application/javascript' });
  const worker = new Worker(URL.createObjectURL(blob), { type: 'module' });

  const summaryPromise = new Promise((resolve) => {
    worker.onmessage = (e) => resolve(e.data);
  });

  worker.postMessage({
    buffer,
    byteOffset: m.byteOffset,
    ringOffset: m.view.getUint32(HEADER.COST_LEDGER_OFFSET, true),
    capacity: m.view.getUint32(HEADER.COST_LEDGER_CAPACITY, true),
    headByteOffset: m.byteOffset + HEADER.COST_LEDGER_WRITE_INDEX,
    generationByteOffset:
      m.byteOffset + HEADER.COST_LEDGER_SEGMENT_GENERATION,
    flagsByteOffset: m.byteOffset + HEADER.COST_LEDGER_FLAGS,
    control,
  });

  // Give the worker a moment to bind, then hammer the ring from this
  // thread while the worker pages concurrently.
  await new Promise((r) => setTimeout(r, 100));
  for (let i = 1; i <= TOTAL_APPENDS; i++) {
    m.appendCostEntry(1, 0, gaugesFor(i));
  }
  Atomics.store(control, 0, 1);

  const summary = await summaryPromise;
  worker.terminate();

  assertEquals(summary.violations, [], 'reader must never accept an incoherent record');
  assert(summary.pages > 10, `reader should have paged continuously (got ${summary.pages})`);
  assert(summary.accepted > 0, 'reader should have accepted records');
});

/**
 * Header-event ring publication proofs for the durable contract in
 * docs/ring-publication-contract.md: bounded validated range reads, exact wrap
 * gaps, version rejection, mid-publication
 * visibility, and a concurrent writer/reader coherence proof over a
 * SharedArrayBuffer-backed vat segment.
 *
 * Run with: deno task test tests/fuel/header_event_ring_publication_test.js
 */
import { assert, assertEquals } from "https://deno.land/std@0.208.0/assert/mod.ts";
import {
  computeVatLayout,
  layoutVat,
} from '../../src/fuel/vat-layout.js';
import { freshSession } from '../../src/host-owned-session.js';
import {
  readHeaderEventRing,
  readHeaderEventRingRange,
  writeHeaderEventRingEntry,
} from '../../src/fuel/header-event-ring.js';
import {
  HEADER_EVENT_RING,
  HEADER_EVENT_RING_HEADER_SIZE,
  HEADER_EVENT_RING_ENTRY_SIZE,
  HEADER_EVENT_KIND,
  HEADER_EVENT_SITE,
  STATE,
  RING_FLAG_SEGMENT_SPACE_EXHAUSTED,
} from '../../src/fuel/constants.js';
import {
  RING_READ_STATUS,
  RING_READ_TRUNCATION,
} from '../../src/ring-publication.js';

// A minimal shared vat segment with an enabled header-event ring. No
// interpreter needed — the JS writer and the decoder only touch STATE
// and the ring region.
function sharedSegment(entryCount) {
  const ringSize = HEADER_EVENT_RING_HEADER_SIZE + entryCount * HEADER_EVENT_RING_ENTRY_SIZE;
  const layout = computeVatLayout({ headerEventRingSize: ringSize });
  const buffer = new SharedArrayBuffer(Math.ceil(layout.byteLength / 65536) * 65536);
  layoutVat(buffer, 0, { headerEventRingSize: ringSize });
  return { buffer, view: new DataView(buffer), ringSize };
}

function ringBase(view) {
  return view.getUint32(STATE.HEADER_EVENT_RING_BASE, true);
}

Deno.test('header ring publication: layout stamps the ring format version', () => {
  const { view } = sharedSegment(4);
  assertEquals(
    view.getUint32(ringBase(view) + HEADER_EVENT_RING.FORMAT_VERSION, true),
    3);
  assertEquals(
    view.getUint32(ringBase(view) + HEADER_EVENT_RING.SEGMENT_GENERATION, true),
    1);
  const page = readHeaderEventRingRange(view, 0);
  assertEquals(page.status, RING_READ_STATUS.OK);
  assertEquals(page.entries.length, 0);
});

Deno.test('header ring publication: pre-segment format is rejected loudly', () => {
  const { view } = sharedSegment(4);
  view.setUint32(ringBase(view) + HEADER_EVENT_RING.FORMAT_VERSION, 2, true);
  const page = readHeaderEventRingRange(view, 0);
  assertEquals(page.status, RING_READ_STATUS.UNSUPPORTED_VERSION);
  assertEquals(page.declaredVersion, 2);
  assertEquals(page.entries.length, 0);
});

Deno.test('header ring publication: zero generation is malformed', () => {
  const { view } = sharedSegment(4);
  view.setUint32(
    ringBase(view) + HEADER_EVENT_RING.SEGMENT_GENERATION, 0, true);
  const page = readHeaderEventRingRange(view, 0);
  assertEquals(page.status, RING_READ_STATUS.MALFORMED);
  assertEquals(page.entries, []);
});

Deno.test('header ring publication: disabled ring reads as not-enabled', () => {
  const layout = computeVatLayout({});
  const buffer = new SharedArrayBuffer(Math.ceil(layout.byteLength / 65536) * 65536);
  layoutVat(buffer, 0, {});
  const page = readHeaderEventRingRange(new DataView(buffer), 0);
  assertEquals(page.status, RING_READ_STATUS.NOT_ENABLED);
});

Deno.test('header ring publication: wrap reports the exact overwrite gap', () => {
  const { view } = sharedSegment(4);
  for (let i = 1; i <= 10; i++) {
    writeHeaderEventRingEntry(view, 0, {
      kind: HEADER_EVENT_KIND.FIELD_WRITE,
      site: HEADER_EVENT_SITE.UNKNOWN,
      oldValue: i, newValue: i * 2,
    });
  }
  const page = readHeaderEventRingRange(view, 0, { afterIndex: 0 });
  assertEquals(page.gap, { firstMissingIndex: 1, lastMissingIndex: 6 });
  assertEquals(page.entries.map((e) => e.index), [7, 8, 9, 10]);
  assertEquals(page.entries.map((e) => e.oldValue), [7, 8, 9, 10]);
  // The legacy whole-window reader sees the same validated entries.
  const legacy = readHeaderEventRing(view, 0);
  assertEquals(legacy.writeHead, 10);
  assertEquals(legacy.capacity, 4);
  assertEquals(legacy.entries.length, 4);
});

Deno.test('header ring publication: an invalidated slot is never returned', () => {
  const { view } = sharedSegment(4);
  for (let i = 1; i <= 3; i++) {
    writeHeaderEventRingEntry(view, 0, {
      kind: HEADER_EVENT_KIND.FIELD_WRITE,
      site: HEADER_EVENT_SITE.UNKNOWN,
      oldValue: i, newValue: i,
    });
  }
  // Simulate a writer mid-rewrite of entry 2's slot: head reserved for
  // entry 6, token invalidated to the sentinel.
  const base = ringBase(view);
  view.setUint32(base + HEADER_EVENT_RING.WRITE_HEAD, 6, true);
  const slotOffset = base + HEADER_EVENT_RING_HEADER_SIZE + 1 * HEADER_EVENT_RING_ENTRY_SIZE;
  view.setUint32(slotOffset + 12, 0, true);

  const page = readHeaderEventRingRange(view, 0, { afterIndex: 2 });
  // Entries 3..5 requested; slot of entry 6 == slot of entry 2 is
  // invalidated, entries 4 and 5 were never published (tokens hold old
  // laps) — the reader stops with a typed overrun, never a torn record.
  assertEquals(page.reservationHead, 6);
  for (const entry of page.entries) {
    assert(entry.index >= 3 && entry.index <= 5, `unexpected index ${entry.index}`);
  }
  assertEquals(page.truncation, RING_READ_TRUNCATION.OVERRUN);
});

Deno.test('header ring publication: JS writer transitions generation before head wrap', () => {
  const { view } = sharedSegment(4);
  const base = ringBase(view);
  view.setUint32(base + HEADER_EVENT_RING.WRITE_HEAD, 0xffffffff, true);
  view.setUint32(base + HEADER_EVENT_RING.SEGMENT_GENERATION, 1, true);
  const boundaryTokenOffset = base + HEADER_EVENT_RING_HEADER_SIZE +
    3 * HEADER_EVENT_RING_ENTRY_SIZE + 12;
  view.setUint32(boundaryTokenOffset, 0xdeadbeef, true);
  const transitionPublished = writeHeaderEventRingEntry(view, 0, {
    kind: HEADER_EVENT_KIND.FIELD_WRITE,
    site: HEADER_EVENT_SITE.UNKNOWN,
    oldValue: 99,
  });
  assertEquals(transitionPublished, false);
  assertEquals(view.getUint32(base + HEADER_EVENT_RING.WRITE_HEAD, true), 0);
  assertEquals(
    view.getUint32(
      base + HEADER_EVENT_RING.SEGMENT_GENERATION, true),
    2);
  assertEquals(view.getUint32(boundaryTokenOffset, true), 0xdeadbeef);

  writeHeaderEventRingEntry(view, 0, {
    kind: HEADER_EVENT_KIND.FIELD_WRITE,
    site: HEADER_EVENT_SITE.UNKNOWN,
    oldValue: 100,
  });
  const page = readHeaderEventRingRange(view, 0, {
    expectedSegmentGeneration: 2,
  });
  assertEquals(page.status, RING_READ_STATUS.OK);
  assertEquals(page.segmentGeneration, 2);
  assertEquals(page.entries.map((entry) => entry.oldValue), [100]);
  const stale = readHeaderEventRingRange(view, 0, {
    expectedSegmentGeneration: 1,
  });
  assertEquals(stale.status, RING_READ_STATUS.SEGMENT_CHANGED);
  assertEquals(stale.entries, []);
});

Deno.test('header ring publication: JS writer stops at terminal generation', () => {
  const { view } = sharedSegment(4);
  const base = ringBase(view);
  view.setUint32(base + HEADER_EVENT_RING.WRITE_HEAD, 0xffffffff, true);
  view.setUint32(base + HEADER_EVENT_RING.SEGMENT_GENERATION, 0xffffffff, true);
  writeHeaderEventRingEntry(view, 0, {
    kind: HEADER_EVENT_KIND.FIELD_WRITE,
    site: HEADER_EVENT_SITE.UNKNOWN,
  });
  assertEquals(view.getUint32(base + HEADER_EVENT_RING.WRITE_HEAD, true), 0xffffffff);
  assertEquals(
    view.getUint32(base + HEADER_EVENT_RING.FLAGS, true),
    RING_FLAG_SEGMENT_SPACE_EXHAUSTED);
  const page = readHeaderEventRingRange(view, 0);
  assertEquals(page.status, RING_READ_STATUS.SEGMENT_SPACE_EXHAUSTED);
  assertEquals(page.entries, []);
});

for (const gcCollector of ['wat', 'js']) {
  Deno.test(`header ring publication: ${gcCollector} GC writer transitions generation before wrap`, () => {
    const session = freshSession({
      headerEventRingSize:
        HEADER_EVENT_RING_HEADER_SIZE + 8 * HEADER_EVENT_RING_ENTRY_SIZE,
      gcCollector,
    });
    const mem = session.memoryImage;
    const base = mem.baseOffset +
      mem.view.getUint32(mem.baseOffset + STATE.HEADER_EVENT_RING_BASE, true);
    mem.view.setUint32(base + HEADER_EVENT_RING.WRITE_HEAD, 0xffffffff, true);
    mem.view.setUint32(
      base + HEADER_EVENT_RING.SEGMENT_GENERATION, 1, true);
    session.gc();
    assertEquals(mem.view.getUint32(
      base + HEADER_EVENT_RING.SEGMENT_GENERATION, true), 2);
    const page = readHeaderEventRingRange(mem.view, mem.baseOffset, {
      expectedSegmentGeneration: 2,
    });
    assertEquals(page.status, RING_READ_STATUS.OK);
    assertEquals(page.segmentGeneration, 2);
    assert(page.entries.every((entry) => entry.index > 0));
  });
  Deno.test(`header ring publication: ${gcCollector} GC writer honors terminal exhaustion`, () => {
    const session = freshSession({
      headerEventRingSize:
        HEADER_EVENT_RING_HEADER_SIZE + 8 * HEADER_EVENT_RING_ENTRY_SIZE,
      gcCollector,
    });
    const mem = session.memoryImage;
    const base = mem.baseOffset +
      mem.view.getUint32(mem.baseOffset + STATE.HEADER_EVENT_RING_BASE, true);
    mem.view.setUint32(base + HEADER_EVENT_RING.WRITE_HEAD, 0xffffffff, true);
    mem.view.setUint32(
      base + HEADER_EVENT_RING.SEGMENT_GENERATION, 0xffffffff, true);
    session.gc();
    assertEquals(mem.view.getUint32(base + HEADER_EVENT_RING.WRITE_HEAD, true),
      0xffffffff);
    assertEquals(
      mem.view.getUint32(base + HEADER_EVENT_RING.FLAGS, true),
      RING_FLAG_SEGMENT_SPACE_EXHAUSTED);
    assertEquals(
      readHeaderEventRingRange(mem.view, mem.baseOffset).status,
      RING_READ_STATUS.SEGMENT_SPACE_EXHAUSTED);
  });
}

Deno.test('header ring publication: concurrent writer never yields torn records', async () => {
  const { buffer, view } = sharedSegment(8); // small ring => heavy wrapping
  const control = new Int32Array(new SharedArrayBuffer(4));
  const TOTAL = 40000;

  const workerScript = `
    import { readHeaderEventRingRange } from '${new URL('../../src/fuel/header-event-ring.js', import.meta.url).href}';
    import { RING_READ_STATUS } from '${new URL('../../src/ring-publication.js', import.meta.url).href}';
    self.onmessage = (e) => {
      const { buffer, control } = e.data;
      const view = new DataView(buffer);
      const violations = [];
      let pages = 0;
      let accepted = 0;
      let cursor = 0;
      const deadline = Date.now() + 4000;
      while (Date.now() < deadline) {
        const page = readHeaderEventRingRange(view, 0, { afterIndex: cursor, maximumEntries: 4 });
        pages++;
        if (page.status !== RING_READ_STATUS.OK) {
          violations.push('status ' + page.status);
          break;
        }
        for (const entry of page.entries) {
          accepted++;
          // oldValue/newValue both derive from the entry's own index;
          // a record combining two writes breaks the equations.
          if (entry.oldValue !== (entry.index >>> 0) ||
              entry.newValue !== ((entry.index * 31 + 7) >>> 0)) {
            violations.push('incoherent record at index ' + entry.index);
          }
        }
        if (page.entries.length > 0) cursor = page.entries[page.entries.length - 1].index;
        else if (page.gap) cursor = page.gap.lastMissingIndex;
        const writerDone = Atomics.load(control, 0) === 1;
        if (writerDone && page.entries.length === 0 && page.gap === null) break;
      }
      self.postMessage({ pages, accepted, violations });
    };
  `;
  const worker = new Worker(URL.createObjectURL(new Blob([workerScript], { type: 'application/javascript' })), { type: 'module' });
  const summaryPromise = new Promise((resolve) => { worker.onmessage = (e) => resolve(e.data); });
  worker.postMessage({ buffer, control });

  await new Promise((r) => setTimeout(r, 100));
  for (let i = 1; i <= TOTAL; i++) {
    writeHeaderEventRingEntry(view, 0, {
      kind: HEADER_EVENT_KIND.FIELD_WRITE,
      site: HEADER_EVENT_SITE.UNKNOWN,
      oldValue: i,
      newValue: (i * 31 + 7) >>> 0,
    });
  }
  Atomics.store(control, 0, 1);

  const summary = await summaryPromise;
  worker.terminate();
  assertEquals(summary.violations, [], 'reader must never accept an incoherent record');
  assert(summary.pages > 10, `reader should have paged continuously (got ${summary.pages})`);
  assert(summary.accepted > 0, 'reader should have accepted records');
});

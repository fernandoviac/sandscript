/**
 * cost-ledger.js view module — the one bounded validated decoder for
 * the membrane cost-ledger ring from a raw shared buffer, as an out-of-realm
 * host does. Writes go through appendCostEntry; the view decodes bytes only
 * after validating each entry's publication token
 * (docs/ring-publication-contract.md).
 *
 * Run with: deno task test tests/runtime/cost_ledger_view_test.js
 */

import { assertEquals, assert } from "https://deno.land/std@0.208.0/assert/mod.ts";
import {
  HEADER,
  COST_KIND,
  COST_LEDGER_ENTRY,
  COST_LEDGER_ENTRY_SIZE,
  COST_LEDGER_FLAG_SEGMENT_SPACE_EXHAUSTED,
} from '../../src/membrane/index.js';
import {
  createCostLedgerView,
  RING_READ_STATUS,
  RING_READ_TRUNCATION,
} from '../../src/runtime/cost-ledger.js';
import { freshMembrane } from '../../src/host-owned-session.js';

const SMALL = {
  handleTableCapacity: 16, grantTableCapacity: 8, idListPoolSize: 256,
  rootGrantsListCapacity: 4, valueArenaSize: 256, closureHandleTableCapacity: 4,
  linkedPromiseTableCapacity: 4, mutationLogCapacity: 16, costLedgerCapacity: 8,
};

// Build a view over a membrane's live SAB exactly as an out-of-realm
// reader would: read the three header fields, then bind the view to
// the ring. (m.buffer/m.byteOffset are the LIVE bytes; m.bytes() is a
// snapshot copy and would hide later mutations.)
function viewOver(m) {
  return createCostLedgerView({
    buffer: m.buffer,
    byteOffset: m.byteOffset + m.view.getUint32(HEADER.COST_LEDGER_OFFSET, true),
    capacity:   m.view.getUint32(HEADER.COST_LEDGER_CAPACITY, true),
    reservationHeadByteOffset:
      m.byteOffset + HEADER.COST_LEDGER_WRITE_INDEX,
    segmentGenerationByteOffset:
      m.byteOffset + HEADER.COST_LEDGER_SEGMENT_GENERATION,
    flagsByteOffset:
      m.byteOffset + HEADER.COST_LEDGER_FLAGS,
  });
}

Deno.test('cost-ledger view: reads entries appended through the membrane', () => {
  const m = freshMembrane({ ...SMALL });
  m.appendCostEntry(COST_KIND.FUEL, 3, { fuel: 1234 });
  m.appendCostEntry(70, 5, { wallNanos: 9, bytesIn: 10, bytesOut: 20, calls: 1 });

  const v = viewOver(m);
  assertEquals(v.writeIndex, 2);
  const entries = v.walk(0);
  assertEquals(entries.length, 2);
  assertEquals(entries[0].kind, COST_KIND.FUEL);
  assertEquals(entries[0].slot, 3);
  assertEquals(entries[0].fuel, 1234n);
  assertEquals(entries[1].kind, 70);
  assertEquals(entries[1].bytesIn, 10n);
  assertEquals(entries[1].calls, 1n);
});

Deno.test('cost-ledger view: cursor and wrap keep only the survivors', () => {
  const m = freshMembrane({ ...SMALL }); // capacity 8
  for (let i = 1; i <= 12; i++) m.appendCostEntry(COST_KIND.FUEL, 0, { fuel: i });

  const v = viewOver(m);
  const all = v.walk(0);
  assertEquals(all.length, 8);              // wrapped — last 8 survive
  assertEquals(all[0].fuel, 5n);
  assertEquals(all[7].fuel, 12n);

  // Cursor past the latest write index yields nothing.
  assertEquals(v.walk(v.writeIndex).length, 0);
});

Deno.test('cost-ledger view: bounded pages report typed truncation and exact gaps', () => {
  const m = freshMembrane({ ...SMALL }); // capacity 8
  for (let i = 1; i <= 12; i++) m.appendCostEntry(COST_KIND.FUEL, 0, { fuel: i });

  const v = viewOver(m);
  const page = v.readRange({ afterIndex: 0, maximumEntries: 3 });
  assertEquals(page.status, RING_READ_STATUS.OK);
  assertEquals(page.gap, { firstMissingIndex: 1, lastMissingIndex: 4 });
  assertEquals(page.entries.map((e) => e.index), [5, 6, 7]);
  assertEquals(page.truncation, RING_READ_TRUNCATION.ENTRY_LIMIT);

  const nextPage = v.readRange({ afterIndex: 7, maximumBytes: 2 * COST_LEDGER_ENTRY_SIZE });
  assertEquals(nextPage.gap, null);
  assertEquals(nextPage.entries.map((e) => e.index), [8, 9]);
  assertEquals(nextPage.truncation, RING_READ_TRUNCATION.BYTE_LIMIT);

  // A cursor ahead of the reservation head is a typed invalid-cursor.
  assertEquals(v.readRange({ afterIndex: 20 }).status, RING_READ_STATUS.INVALID_CURSOR);
});

Deno.test('cost-ledger view: a reserved-but-unpublished entry is not returned', () => {
  const m = freshMembrane({ ...SMALL });
  m.appendCostEntry(COST_KIND.FUEL, 1, { fuel: 7 });
  m.appendCostEntry(COST_KIND.FUEL, 1, { fuel: 8 });

  // Simulate the writer mid-payload on entry 3: head reserved, token
  // not yet published (its slot still carries the zero sentinel).
  m.view.setUint32(HEADER.COST_LEDGER_WRITE_INDEX, 3, true);

  const page = viewOver(m).readRange({ afterIndex: 0 });
  assertEquals(page.reservationHead, 3);
  assertEquals(page.newestCommitted, 2);
  assertEquals(page.entries.map((e) => e.index), [1, 2]);
  assertEquals(page.truncation, null);
});

Deno.test('cost-ledger view: a token from another lap rejects the record as overrun', () => {
  const m = freshMembrane({ ...SMALL });
  for (let i = 1; i <= 3; i++) m.appendCostEntry(COST_KIND.FUEL, 0, { fuel: i });

  // Corrupt entry 2's token to a newer lap (2 + capacity): the record
  // no longer proves it is entry 2, so the page must stop before it
  // with a typed overrun rather than return a possibly-torn payload.
  const ringOffset = m.view.getUint32(HEADER.COST_LEDGER_OFFSET, true);
  const slotOffset = ringOffset + 1 * COST_LEDGER_ENTRY_SIZE;
  m.view.setUint32(slotOffset + COST_LEDGER_ENTRY.SEQ_LO, 2 + SMALL.costLedgerCapacity, true);

  const page = viewOver(m).readRange({ afterIndex: 0 });
  assertEquals(page.entries.map((e) => e.index), [1]);
  assertEquals(page.truncation, RING_READ_TRUNCATION.OVERRUN);
});

Deno.test('cost-ledger view: writer transitions generation before head wrap', () => {
  const m = freshMembrane({ ...SMALL });
  m.view.setUint32(HEADER.COST_LEDGER_WRITE_INDEX, 0xffffffff, true);
  m.view.setUint32(HEADER.COST_LEDGER_SEGMENT_GENERATION, 1, true);
  const ringOffset = m.view.getUint32(HEADER.COST_LEDGER_OFFSET, true);
  const boundaryTokenOffset = ringOffset +
    (SMALL.costLedgerCapacity - 1) * COST_LEDGER_ENTRY_SIZE +
    COST_LEDGER_ENTRY.SEQ_LO;
  m.view.setUint32(boundaryTokenOffset, 0xdeadbeef, true);
  m.appendCostEntry(COST_KIND.FUEL, 0, { fuel: 99 });
  assertEquals(m.view.getUint32(
    HEADER.COST_LEDGER_SEGMENT_GENERATION, true), 2);
  assertEquals(m.view.getUint32(HEADER.COST_LEDGER_WRITE_INDEX, true), 0);
  assertEquals(m.view.getUint32(boundaryTokenOffset, true), 0xdeadbeef);

  m.appendCostEntry(COST_KIND.FUEL, 0, { fuel: 100 });
  const page = viewOver(m).readRange({ expectedSegmentGeneration: 2 });
  assertEquals(page.status, RING_READ_STATUS.OK);
  assertEquals(page.segmentGeneration, 2);
  assertEquals(page.entries.map((entry) => entry.fuel), [100n]);
  const stale = viewOver(m).readRange({ expectedSegmentGeneration: 1 });
  assertEquals(stale.status, RING_READ_STATUS.SEGMENT_CHANGED);
  assertEquals(stale.entries, []);
});

Deno.test('cost-ledger view: terminal exhaustion stops publication', () => {
  const m = freshMembrane({ ...SMALL });
  m.view.setUint32(HEADER.COST_LEDGER_WRITE_INDEX, 0xffffffff, true);
  m.view.setUint32(
    HEADER.COST_LEDGER_SEGMENT_GENERATION, 0xffffffff, true);
  m.appendCostEntry(COST_KIND.FUEL, 0, { fuel: 1 });
  m.appendCostEntry(COST_KIND.FUEL, 0, { fuel: 2 });
  assertEquals(
    m.view.getUint32(HEADER.COST_LEDGER_WRITE_INDEX, true), 0xffffffff);
  assertEquals(
    m.view.getUint32(HEADER.COST_LEDGER_FLAGS, true),
    COST_LEDGER_FLAG_SEGMENT_SPACE_EXHAUSTED);
  const page = viewOver(m).readRange();
  assertEquals(page.status, RING_READ_STATUS.SEGMENT_SPACE_EXHAUSTED);
  assertEquals(page.entries, []);
});

Deno.test('cost-ledger view: zero generation is malformed', () => {
  const m = freshMembrane({ ...SMALL });
  m.view.setUint32(HEADER.COST_LEDGER_SEGMENT_GENERATION, 0, true);
  const page = viewOver(m).readRange();
  assertEquals(page.status, RING_READ_STATUS.MALFORMED);
  assertEquals(page.entries, []);
});

Deno.test('cost-ledger view: misaligned ring offset is rejected loudly', () => {
  const m = freshMembrane({ ...SMALL });
  let threw = false;
  try {
    createCostLedgerView({ buffer: m.buffer, byteOffset: m.byteOffset + 2, capacity: 8, writeIndex: 0 });
  } catch (err) {
    threw = true;
    assert(String(err.message).includes('aligned'));
  }
  assert(threw, 'expected misaligned byteOffset to throw');
});

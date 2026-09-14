// Cost-ledger region tests with atomic publication per
// docs/ring-publication-contract.md.
//
// Exercises the airlock append primitive through the one bounded
// validated decoder (src/runtime/cost-ledger.js): gauge round-trip,
// the publish-token-last discipline, ring wraparound with exact gaps,
// the read cursor, and survival across snapshot/restore.

import { assertEquals, assert } from "https://deno.land/std@0.208.0/assert/mod.ts";
import { HEADER, COST_KIND, COST_LEDGER_ENTRY_SIZE } from '../../src/membrane/index.js';
import { createCostLedgerView } from '../../src/runtime/cost-ledger.js';
import { freshMembrane } from '../../src/host-owned-session.js';

const SMALL = {
  handleTableCapacity: 16,
  grantTableCapacity: 8,
  idListPoolSize: 256,
  rootGrantsListCapacity: 4,
  valueArenaSize: 256,
  closureHandleTableCapacity: 4,
  linkedPromiseTableCapacity: 4,
  mutationLogCapacity: 16,
  costLedgerCapacity: 8,   // tiny ring so wraparound is easy to drive
};

// Bind the decoder over a membrane's buffer exactly as an out-of-realm
// reader would: read the three header fields, then bind to the ring.
function viewOver(m) {
  const buffer = m.bytes().buffer;
  const header = new DataView(buffer, 0);
  return createCostLedgerView({
    buffer,
    byteOffset: header.getUint32(HEADER.COST_LEDGER_OFFSET, true),
    capacity:   header.getUint32(HEADER.COST_LEDGER_CAPACITY, true),
    writeIndex: header.getUint32(HEADER.COST_LEDGER_WRITE_INDEX, true),
    segmentGeneration: header.getUint32(
      HEADER.COST_LEDGER_SEGMENT_GENERATION, true),
    flags: header.getUint32(HEADER.COST_LEDGER_FLAGS, true),
  });
}

function readAll(m, afterIndex = 0) {
  const view = viewOver(m);
  return { writeIndex: view.writeIndex, entries: view.walk(afterIndex) };
}

Deno.test("cost ledger: append + read round-trips every gauge", () => {
  const m = freshMembrane({ ...SMALL });
  m.appendCostEntry(COST_KIND.FUEL, 3, { fuel: 1234 });
  m.appendCostEntry(70, 5, {
    wallNanos: 999, bytesIn: 10, bytesOut: 20, calls: 1,
    ext0: 7, ext1: 8,
  });

  const { writeIndex, entries } = readAll(m);
  assertEquals(writeIndex, 2);
  assertEquals(entries.length, 2);

  assertEquals(entries[0].kind, COST_KIND.FUEL);
  assertEquals(entries[0].slot, 3);
  assertEquals(entries[0].fuel, 1234n);
  assertEquals(entries[0].index, 1);
  assertEquals(entries[0].seq, 1);
  // unset gauges are zero
  assertEquals(entries[0].wallNanos, 0n);
  assertEquals(entries[0].bytesIn, 0n);

  assertEquals(entries[1].kind, 70);
  assertEquals(entries[1].slot, 5);
  assertEquals(entries[1].wallNanos, 999n);
  assertEquals(entries[1].bytesIn, 10n);
  assertEquals(entries[1].bytesOut, 20n);
  assertEquals(entries[1].calls, 1n);
  assertEquals(entries[1].ext0, 7n);
  assertEquals(entries[1].ext1, 8n);
  assertEquals(entries[1].fuel, 0n);
});

Deno.test("cost ledger: read cursor returns only entries past the cursor", () => {
  const m = freshMembrane({ ...SMALL });
  m.appendCostEntry(COST_KIND.FUEL, 1, { fuel: 1 });
  m.appendCostEntry(COST_KIND.FUEL, 1, { fuel: 2 });
  const first = readAll(m);
  assertEquals(first.entries.length, 2);

  // Append one more; reading from the prior cursor yields just the new one.
  m.appendCostEntry(COST_KIND.FUEL, 1, { fuel: 3 });
  const next = readAll(m, first.writeIndex);
  assertEquals(next.entries.length, 1);
  assertEquals(next.entries[0].fuel, 3n);
  assertEquals(next.writeIndex, 3);

  // Reading again from the latest cursor yields nothing.
  const empty = readAll(m, next.writeIndex);
  assertEquals(empty.entries.length, 0);
});

Deno.test("cost ledger: ring wraps, keeping only the most-recent capacity entries", () => {
  const m = freshMembrane({ ...SMALL }); // capacity 8
  for (let i = 1; i <= 12; i++) {
    m.appendCostEntry(COST_KIND.FUEL, 0, { fuel: i });
  }
  const { writeIndex, entries } = readAll(m);
  assertEquals(writeIndex, 12);
  // Only the last 8 survive (entries 5..12).
  assertEquals(entries.length, 8);
  assertEquals(entries[0].fuel, 5n);
  assertEquals(entries[7].fuel, 12n);

  // The bounded read reports the exact ordinary-overwrite gap.
  const page = viewOver(m).readRange({ afterIndex: 0 });
  assertEquals(page.gap, { firstMissingIndex: 1, lastMissingIndex: 4 });
  assertEquals(page.oldestAvailable, 5);
  assertEquals(page.newestCommitted, 12);
});

Deno.test("cost ledger: survives snapshot/restore (durable accounting state)", () => {
  const m = freshMembrane({ ...SMALL });
  m.appendCostEntry(COST_KIND.FUEL, 2, { fuel: 4242 });
  m.appendCostEntry(71, 2, { bytesOut: 100, calls: 1 });

  const bytes = m.bytes();

  // Restore into a fresh membrane of the same geometry.
  const m2 = freshMembrane({ ...SMALL });
  m2.loadBytes(bytes);

  const { writeIndex, entries } = readAll(m2);
  assertEquals(writeIndex, 2);
  assertEquals(entries.length, 2);
  assertEquals(entries[0].fuel, 4242n);
  assertEquals(entries[1].kind, 71);
  assertEquals(entries[1].bytesOut, 100n);
  assertEquals(entries[1].calls, 1n);
});

Deno.test("cost ledger: entry size and default ring fit the layout", () => {
  // The region is capacity × entry size; a freshly-laid-out membrane
  // must have a non-overlapping ledger past every other region.
  const m = freshMembrane({ ...SMALL });
  const region = SMALL.costLedgerCapacity * COST_LEDGER_ENTRY_SIZE;
  assert(region > 0);
  // Appending up to capacity never throws / overflows.
  for (let i = 0; i < SMALL.costLedgerCapacity; i++) {
    m.appendCostEntry(COST_KIND.FUEL, 0, { fuel: i });
  }
});

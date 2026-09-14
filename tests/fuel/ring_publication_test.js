/**
 * Focused proof for the shared bounded validated range reader
 * (src/ring-publication.js) over a synthetic token/payload ring.
 * Ring-specific decoders (cost ledger, header-event, step) get their
 * own proofs; this file pins the protocol arithmetic: paging, exact
 * gaps, u32 head wrap, contention truncation, and cursor validation.
 */
import { assertEquals } from "https://deno.land/std@0.208.0/assert/mod.ts";
import {
  readPublishedRange,
  RING_READ_STATUS,
  RING_READ_TRUNCATION,
} from '../../src/ring-publication.js';

const ENTRY_SIZE = 16;

/**
 * Synthetic ring: tokens[] holds the per-slot publication token,
 * payloads[] the per-slot value. `publish(index)` writes both the way
 * the real producers do (payload then token); `reserve(head)` only
 * moves the head.
 */
function syntheticRing(capacity) {
  const tokens = new Array(capacity).fill(0);
  const payloads = new Array(capacity).fill(null);
  let head = 0;
  let generation = 1;
  let flags = 0;
  return {
    tokens,
    payloads,
    get head() { return head; },
    get generation() { return generation; },
    append(value) {
      if ((flags & 1) !== 0) return;
      if (head === 0xffffffff) {
        if (generation === 0xffffffff) {
          flags |= 1;
          return;
        }
        generation = (generation + 1) >>> 0;
      }
      head = (head + 1) >>> 0;
      const slot = (head - 1) % capacity;
      payloads[slot] = value;
      tokens[slot] = head;
    },
    reserveOnly() {
      head = (head + 1) >>> 0;
    },
    read({
      afterIndex = 0,
      expectedSegmentGeneration,
      maximumEntries = 1000,
      maximumBytes = 1000 * ENTRY_SIZE,
      loadPublicationToken,
      loadSegmentGeneration,
    } = {}) {
      return readPublishedRange({
        capacity,
        reservationHead: head,
        segmentGeneration: generation,
        expectedSegmentGeneration,
        flags,
        afterIndex,
        maximumEntries,
        maximumBytes,
        entrySize: ENTRY_SIZE,
        loadPublicationToken: loadPublicationToken ?? ((slot) => tokens[slot] >>> 0),
        decodeEntry: (slot) => ({ value: payloads[slot] }),
        loadSegmentGeneration: loadSegmentGeneration ?? (() => generation),
        loadFlags: () => flags,
      });
    },
  };
}

Deno.test('ring publication: empty ring reports zero cursors and no entries', () => {
  const ring = syntheticRing(8);
  const page = ring.read();
  assertEquals(page.status, RING_READ_STATUS.OK);
  assertEquals(page.newestCommitted, 0);
  assertEquals(page.oldestAvailable, 0);
  assertEquals(page.entries.length, 0);
  assertEquals(page.gap, null);
  assertEquals(page.truncation, null);
});

Deno.test('ring publication: partial ring pages oldest-first with 1-based indexes', () => {
  const ring = syntheticRing(8);
  for (let i = 1; i <= 5; i++) ring.append(i * 100);
  const page = ring.read();
  assertEquals(page.newestCommitted, 5);
  assertEquals(page.oldestAvailable, 1);
  assertEquals(page.entries.map((e) => e.index), [1, 2, 3, 4, 5]);
  assertEquals(page.entries.map((e) => e.value), [100, 200, 300, 400, 500]);
});

Deno.test('ring publication: afterIndex is exclusive; at-newest returns an empty page', () => {
  const ring = syntheticRing(8);
  for (let i = 1; i <= 5; i++) ring.append(i);
  assertEquals(ring.read({ afterIndex: 3 }).entries.map((e) => e.index), [4, 5]);
  const atNewest = ring.read({ afterIndex: 5 });
  assertEquals(atNewest.entries.length, 0);
  assertEquals(atNewest.status, RING_READ_STATUS.OK);
  assertEquals(atNewest.truncation, null);
});

Deno.test('ring publication: cursor ahead of the head is a typed invalid-cursor', () => {
  const ring = syntheticRing(8);
  ring.append(1);
  assertEquals(ring.read({ afterIndex: 7 }).status, RING_READ_STATUS.INVALID_CURSOR);
});

Deno.test('ring publication: wrapped ring reports the exact ordinary-overwrite gap', () => {
  const ring = syntheticRing(4);
  for (let i = 1; i <= 10; i++) ring.append(i);
  const page = ring.read({ afterIndex: 0 });
  assertEquals(page.oldestAvailable, 7);
  assertEquals(page.newestCommitted, 10);
  assertEquals(page.gap, { firstMissingIndex: 1, lastMissingIndex: 6 });
  assertEquals(page.entries.map((e) => e.index), [7, 8, 9, 10]);
  // A cursor inside the overwritten range gets the tail of the gap only.
  const partial = ring.read({ afterIndex: 4 });
  assertEquals(partial.gap, { firstMissingIndex: 5, lastMissingIndex: 6 });
  assertEquals(partial.entries.map((e) => e.index), [7, 8, 9, 10]);
});

Deno.test('ring publication: a reserved-but-unpublished newest entry is not committed', () => {
  const ring = syntheticRing(8);
  ring.append(1);
  ring.append(2);
  ring.reserveOnly(); // writer mid-payload on index 3
  const page = ring.read();
  assertEquals(page.reservationHead, 3);
  assertEquals(page.newestCommitted, 2);
  assertEquals(page.entries.map((e) => e.index), [1, 2]);
  assertEquals(page.truncation, null);
});

Deno.test('ring publication: entry and byte bounds truncate with typed reasons', () => {
  const ring = syntheticRing(8);
  for (let i = 1; i <= 6; i++) ring.append(i);
  const byEntries = ring.read({ maximumEntries: 2 });
  assertEquals(byEntries.entries.map((e) => e.index), [1, 2]);
  assertEquals(byEntries.truncation, RING_READ_TRUNCATION.ENTRY_LIMIT);
  const byBytes = ring.read({ maximumBytes: 3 * ENTRY_SIZE + 1 });
  assertEquals(byBytes.entries.length, 3);
  assertEquals(byBytes.truncation, RING_READ_TRUNCATION.BYTE_LIMIT);
  // Bounds that exactly cover the committed range are not truncation.
  const exact = ring.read({ maximumEntries: 6 });
  assertEquals(exact.entries.length, 6);
  assertEquals(exact.truncation, null);
});

Deno.test('ring publication: writer lapping the page is a typed overrun prefix', () => {
  const ring = syntheticRing(4);
  for (let i = 1; i <= 4; i++) ring.append(i);
  // After the head snapshot, the writer laps slots 0 and 1 (indexes 5, 6).
  let reads = 0;
  const page = ring.read({
    loadPublicationToken(slot) {
      reads++;
      if (reads === 1) return ring.tokens[slot] >>> 0; // newest-committed probe
      // Slots 0 and 1 were reused for indexes 5 and 6 by the time paging starts.
      if (slot === 0) return 5;
      if (slot === 1) return 6;
      return ring.tokens[slot] >>> 0;
    },
  });
  assertEquals(page.entries.length, 0);
  assertEquals(page.truncation, RING_READ_TRUNCATION.OVERRUN);
  // Paging from past the lapped slots still yields the survivors.
  const tail = ring.read({ afterIndex: 2 });
  assertEquals(tail.entries.map((e) => e.index), [3, 4]);
});

Deno.test('ring publication: token change during decode is a typed raced prefix', () => {
  const ring = syntheticRing(4);
  for (let i = 1; i <= 3; i++) ring.append(i);
  // Slot 1 (index 2) is overwritten between the pre- and post-decode loads.
  const seen = new Map();
  const page = ring.read({
    loadPublicationToken(slot) {
      const count = (seen.get(slot) ?? 0) + 1;
      seen.set(slot, count);
      if (slot === 1 && count === 2) return 6; // post-decode load sees a newer lap
      return ring.tokens[slot] >>> 0;
    },
  });
  assertEquals(page.entries.map((e) => e.index), [1]);
  assertEquals(page.truncation, RING_READ_TRUNCATION.RACED);
});

Deno.test('ring publication: u32 head wrap keeps distances and indexes coherent', () => {
  const ring = syntheticRing(4);
  // Pretend the ring has been running forever: head just below wrap.
  const nearWrap = 0xFFFFFFFE;
  for (let slot = 0; slot < 4; slot++) ring.tokens[slot] = 0;
  // Manually place the head and the retained lap.
  // Retained indexes: 0xFFFFFFFB .. 0xFFFFFFFE.
  const indexes = [0xFFFFFFFB, 0xFFFFFFFC, 0xFFFFFFFD, 0xFFFFFFFE];
  for (const index of indexes) {
    const slot = (index - 1) % 4;
    ring.tokens[slot] = index;
    ring.payloads[slot] = index;
  }
  const page = readPublishedRange({
    capacity: 4,
    reservationHead: nearWrap,
    segmentGeneration: 1,
    flags: 0,
    afterIndex: 0xFFFFFFFA,
    maximumEntries: 10,
    maximumBytes: 10 * ENTRY_SIZE,
    entrySize: ENTRY_SIZE,
    loadPublicationToken: (slot) => ring.tokens[slot] >>> 0,
    decodeEntry: (slot) => ({ value: ring.payloads[slot] }),
    loadSegmentGeneration: () => 1,
    loadFlags: () => 0,
  });
  assertEquals(page.status, RING_READ_STATUS.OK);
  assertEquals(page.entries.map((e) => e.index), indexes);
  assertEquals(page.newestCommitted, 0xFFFFFFFE);
  assertEquals(page.oldestAvailable, 0xFFFFFFFB);
});

Deno.test('ring publication: successor generation rejects prior-segment slots', () => {
  // The explicit generation removes the old head-wrap ambiguity. A
  // successor segment still only reports indexes 1..head, never stale
  // high-token slots retained in other physical slots.
  const ring = syntheticRing(4);
  ring.tokens[3] = 0xFFFFFFFF; // stale pre-wrap lap survivor
  ring.payloads[3] = 'stale';
  ring.tokens[0] = 1;
  ring.payloads[0] = 'fresh';
  const page = readPublishedRange({
    capacity: 4,
    reservationHead: 1,
    segmentGeneration: 2,
    flags: 0,
    afterIndex: 0,
    maximumEntries: 10,
    maximumBytes: 10 * ENTRY_SIZE,
    entrySize: ENTRY_SIZE,
    loadPublicationToken: (slot) => ring.tokens[slot] >>> 0,
    decodeEntry: (slot) => ({ value: ring.payloads[slot] }),
    loadSegmentGeneration: () => 2,
    loadFlags: () => 0,
  });
  assertEquals(page.entries.map((e) => e.value), ['fresh']);
  assertEquals(page.oldestAvailable, 1);
});

Deno.test('ring publication: transition seqlock rejects old high-head slots', () => {
  const ring = syntheticRing(4);
  ring.tokens[3] = 0xffffffff;
  ring.payloads[3] = 'prior-segment';
  const page = readPublishedRange({
    capacity: 4,
    reservationHead: 0xffffffff,
    segmentGeneration: 0,
    flags: 0,
    afterIndex: 0xfffffffb,
    maximumEntries: 4,
    maximumBytes: 4 * ENTRY_SIZE,
    entrySize: ENTRY_SIZE,
    loadPublicationToken: (slot) => ring.tokens[slot] >>> 0,
    decodeEntry: (slot) => ({ value: ring.payloads[slot] }),
    loadSegmentGeneration: () => 0,
    loadFlags: () => 0,
  });
  assertEquals(page.status, RING_READ_STATUS.MALFORMED);
  assertEquals(page.entries, []);
  assertEquals(page.truncation, null);
});

Deno.test('ring publication: stale expected generation rejects the whole page', () => {
  const ring = syntheticRing(4);
  ring.append('current');
  const page = ring.read({ expectedSegmentGeneration: 2 });
  assertEquals(page.status, RING_READ_STATUS.SEGMENT_CHANGED);
  assertEquals(page.segmentGeneration, 1);
  assertEquals(page.entries, []);
  assertEquals(page.truncation, null);
});

Deno.test('ring publication: generation change during decode rejects the whole page', () => {
  const ring = syntheticRing(4);
  ring.append('one');
  ring.append('two');
  const page = ring.read({ loadSegmentGeneration: () => 2 });
  assertEquals(page.status, RING_READ_STATUS.SEGMENT_CHANGED);
  assertEquals(page.segmentGeneration, 1);
  assertEquals(page.entries, []);
  assertEquals(page.truncation, null);
});

Deno.test('ring publication: terminal generation exhaustion is typed', () => {
  const ring = syntheticRing(4);
  const page = readPublishedRange({
    capacity: 4,
    reservationHead: 0xffffffff,
    segmentGeneration: 0xffffffff,
    flags: 1,
    afterIndex: 0,
    maximumEntries: 4,
    maximumBytes: 4 * ENTRY_SIZE,
    entrySize: ENTRY_SIZE,
    loadPublicationToken: () => 0,
    decodeEntry: () => ({ value: null }),
    loadSegmentGeneration: () => 0xffffffff,
    loadFlags: () => 1,
  });
  assertEquals(page.status, RING_READ_STATUS.SEGMENT_SPACE_EXHAUSTED);
  assertEquals(page.segmentGeneration, 0xffffffff);
  assertEquals(page.entries, []);
  assertEquals(page.truncation, null);
});

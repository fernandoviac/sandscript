/**
 * Tests for the header-event ring:
 * records writes to global STATE.* fields (context-table growth, GC
 * pointer forwarding, segment resize), GC-cycle start/end, and
 * getExitCondition's zero-guard fires, each with an attributable call site.
 */

import { assertEquals, assert } from "https://deno.land/std@0.208.0/assert/mod.ts";
import { freshSession } from '../../src/host-owned-session.js';
import { createTestContext } from './interpreter-test-utils.js';
import { parseAndSetup } from './test-helpers.js';
import { readHeaderEventRing, writeHeaderEventRingEntry } from '../../src/fuel/header-event-ring.js';
import {
  HEADER_EVENT_RING_HEADER_SIZE,
  HEADER_EVENT_RING_ENTRY_SIZE,
  HEADER_EVENT_KIND,
  HEADER_EVENT_FIELD,
  HEADER_EVENT_SITE,
  CONTEXT_STATUS_FREE,
} from '../../src/fuel/constants.js';

function ringSizeFor(entryCount) {
  return HEADER_EVENT_RING_HEADER_SIZE + entryCount * HEADER_EVENT_RING_ENTRY_SIZE;
}

function getRing(session) {
  return readHeaderEventRing(session.memoryImage.view, session.memoryImage.baseOffset);
}

function populateAndOrphan(session) {
  // Garbage-before-kept pattern (matches gc_during_gc_invariant_test.js):
  // reliably forces real compaction that reclaims bytes and moves the
  // heap pointer down, so GC_CYCLE_* and the HEAP_POINTER field-write
  // are guaranteed to fire regardless of collector ('wat' vs 'js').
  parseAndSetup(session, `
    let kept = [];
    for (let i = 0; i < 50; i = i + 1) {
      kept[i] = {x: i, y: i + 1, z: [i, i+1, i+2]};
    }
    let garbage = null;
    for (let i = 0; i < 100; i = i + 1) {
      garbage = {junk: i};
    }
    let result = kept.length;
  `);
  session.run(0, 100000);
}

for (const gcCollector of ['wat', 'js']) {
  Deno.test(`header event ring (${gcCollector}): GC cycle brackets with START/END`, () => {
    const session = freshSession({
      heapSize: 96 * 1024,
      headerEventRingSize: ringSizeFor(64),
      gcCollector,
    });
    populateAndOrphan(session);

    session.gc();

    const ring = getRing(session);
    assert(ring.entries.length > 0, 'ring should have entries after a real GC');

    const starts = ring.entries.filter(e => e.kind === HEADER_EVENT_KIND.GC_CYCLE_START);
    const ends = ring.entries.filter(e => e.kind === HEADER_EVENT_KIND.GC_CYCLE_END);
    assertEquals(starts.length, 1, 'exactly one GC_CYCLE_START');
    assertEquals(ends.length, 1, 'exactly one GC_CYCLE_END');

    const startIdx = ring.entries.indexOf(starts[0]);
    const endIdx = ring.entries.indexOf(ends[0]);
    assert(startIdx < endIdx, 'START must precede END');
  });

  Deno.test(`header event ring (${gcCollector}): HEAP_POINTER field-write fires when compaction reclaims bytes`, () => {
    const session = freshSession({
      heapSize: 96 * 1024,
      headerEventRingSize: ringSizeFor(64),
      gcCollector,
    });
    populateAndOrphan(session);

    const heapBefore = session.memoryImage.getHeapPointer();
    session.gc();
    const heapAfter = session.memoryImage.getHeapPointer();
    assert(heapAfter < heapBefore, 'sanity: this GC must actually reclaim bytes');

    const ring = getRing(session);
    const heapWrites = ring.entries.filter(e =>
      e.kind === HEADER_EVENT_KIND.FIELD_WRITE && e.field === HEADER_EVENT_FIELD.HEAP_POINTER);
    assertEquals(heapWrites.length, 1, 'exactly one HEAP_POINTER field-write');
    assertEquals(heapWrites[0].oldValue, heapBefore);
    assertEquals(heapWrites[0].newValue, heapAfter);

    const expectedSite = gcCollector === 'wat'
      ? HEADER_EVENT_SITE.WAT_GC_MOVE_OBJECTS
      : HEADER_EVENT_SITE.JS_COLLECTOR_MOVE_OBJECTS;
    assertEquals(heapWrites[0].site, expectedSite);
  });
}

for (const gcCollector of ['wat', 'js']) {
  Deno.test(`header event ring (${gcCollector}): ROOT_SCOPE forwarding fires when compaction moves it`, () => {
    const session = freshSession({
      heapSize: 96 * 1024,
      headerEventRingSize: ringSizeFor(64),
      gcCollector,
    });
    // A bigger garbage-before-kept workload than populateAndOrphan's —
    // enough live + dead allocation before the root scope's own data
    // that compaction slides the root scope itself, not just the
    // trailing garbage (confirmed empirically: the smaller workload
    // doesn't always relocate ROOT_SCOPE, only HEAP_POINTER).
    parseAndSetup(session, `
      let kept = [];
      for (let i = 0; i < 200; i = i + 1) { kept[i] = {x: i, y: i + 1, z: [i, i+1, i+2]}; }
      let garbage = null;
      for (let i = 0; i < 500; i = i + 1) { garbage = {junk: i, more: [1, 2, 3]}; }
      let result = kept.length;
    `);
    session.run(0, 500000);

    session.gc();

    const ring = getRing(session);
    const rootScopeWrites = ring.entries.filter(e =>
      e.kind === HEADER_EVENT_KIND.FIELD_WRITE && e.field === HEADER_EVENT_FIELD.ROOT_SCOPE);
    assertEquals(rootScopeWrites.length, 1, 'exactly one ROOT_SCOPE field-write');

    const expectedSite = gcCollector === 'wat'
      ? HEADER_EVENT_SITE.WAT_GC_UPDATE_POINTERS
      : HEADER_EVENT_SITE.JS_COLLECTOR_UPDATE_INTRINSICS;
    assertEquals(rootScopeWrites[0].site, expectedSite);
    assertEquals(rootScopeWrites[0].newValue, session.memoryImage.getRootScope());
  });
}

Deno.test('header event ring: disabled by default (no headerEventRingSize)', () => {
  const session = freshSession({ heapSize: 96 * 1024 });
  populateAndOrphan(session);
  session.gc();

  const ring = getRing(session);
  assertEquals(ring.entries.length, 0);
  assertEquals(ring.writeHead, 0);
  assertEquals(ring.capacity, 0);
});

Deno.test('header event ring: context-table growth emits CONTEXT_TABLE_GROWTH', () => {
  const { mem } = createTestContext({
    contextTableSize: 2,
    headerEventRingSize: ringSizeFor(32),
  });
  // Context 0 is auto-allocated; capacity is 2, so this third allocation
  // (slot 2) must grow the table.
  const oldTable = mem.getContextTablePointer();
  const slot = mem.allocateContext();
  assertEquals(slot, 1);
  const secondSlot = mem.allocateContext();
  assertEquals(secondSlot, 2);
  const newTable = mem.getContextTablePointer();
  assert(newTable !== oldTable, 'sanity: table must have actually grown');

  const ring = readHeaderEventRing(mem.view, mem.baseOffset);
  const growthEvents = ring.entries.filter(e => e.kind === HEADER_EVENT_KIND.CONTEXT_TABLE_GROWTH);
  assertEquals(growthEvents.length, 1);
  assertEquals(growthEvents[0].oldValue, oldTable);
  assertEquals(growthEvents[0].newValue, newTable);
  assertEquals(growthEvents[0].slot, secondSlot, 'growth attributed to the triggering slot');
  assertEquals(growthEvents[0].site, HEADER_EVENT_SITE.JS_GROW_CONTEXT_TABLE);

  // Every allocateContext call also bumps CONTEXT_COUNT. Three occur here:
  // bootstrap's context 0 plus the two allocated above.
  const countWrites = ring.entries.filter(e =>
    e.kind === HEADER_EVENT_KIND.FIELD_WRITE && e.field === HEADER_EVENT_FIELD.CONTEXT_COUNT);
  assertEquals(countWrites.length, 3, 'one CONTEXT_COUNT write per allocateContext call');
  assertEquals(countWrites[2].newValue, 3);
});

Deno.test('header event ring: resizeSegment emits field-writes for every field it touches', () => {
  // Generously-sized buffer envelope (matches ss_region_resize_test.js's
  // pattern) so the grow below never hits the buffer-envelope ceiling.
  const memory = new WebAssembly.Memory({ initial: 64, maximum: 64, shared: true });
  const session = freshSession({
    memory,
    offset: 0,
    headerEventRingSize: ringSizeFor(32),
    heapSize: 768 * 1024,
  });
  const mem = session.airlock.memoryImage;
  const oldSegmentSize = mem.segmentSize;

  mem.resizeSegment({ newSegmentSize: oldSegmentSize + 65536 });

  const ring = readHeaderEventRing(mem.view, mem.baseOffset);
  const resizeWrites = ring.entries.filter(e => e.site === HEADER_EVENT_SITE.JS_RESIZE_SEGMENT);
  assert(resizeWrites.length > 0, 'resizeSegment must emit at least one field-write');

  const fieldsWritten = new Set(resizeWrites.map(e => e.fieldName));
  // SEGMENT_SIZE always changes on a grow; HEAP_END/STRING_START move in
  // lockstep with it.
  assert(fieldsWritten.has('SEGMENT_SIZE'), `expected SEGMENT_SIZE, got ${[...fieldsWritten]}`);
  assert(fieldsWritten.has('HEAP_END'), `expected HEAP_END, got ${[...fieldsWritten]}`);
  assert(fieldsWritten.has('STRING_START'), `expected STRING_START, got ${[...fieldsWritten]}`);

  const segmentSizeWrite = resizeWrites.find(e => e.fieldName === 'SEGMENT_SIZE');
  assertEquals(segmentSizeWrite.oldValue, oldSegmentSize);
  assertEquals(segmentSizeWrite.newValue, oldSegmentSize + 65536);
});

Deno.test('header event ring: getExitCondition zero-guard fire is recorded for a free slot', () => {
  const { mem } = createTestContext({
    headerEventRingSize: ringSizeFor(32),
  });
  const slot = mem.allocateContext();
  mem.freeContext(slot);

  const exitCondition = mem.getExitCondition(slot);
  assertEquals(exitCondition, CONTEXT_STATUS_FREE);

  const ring = readHeaderEventRing(mem.view, mem.baseOffset);
  const fires = ring.entries.filter(e => e.kind === HEADER_EVENT_KIND.ZERO_GUARD_FIRED);
  assert(fires.length > 0, 'zero-guard fire must be recorded');
  assertEquals(fires[fires.length - 1].slot, slot);
  assertEquals(fires[fires.length - 1].site, HEADER_EVENT_SITE.JS_MEMORY_READER_GET_EXIT_CONDITION);
});

Deno.test('header event ring: writer wraps correctly when capacity is exceeded', () => {
  const { mem } = createTestContext({
    headerEventRingSize: ringSizeFor(4),
  });
  // bootstrap() itself writes a CONTEXT_COUNT entry (context 0's
  // allocateContext) before this test's loop — read the baseline
  // writeHead rather than assuming the ring starts empty.
  const baseline = readHeaderEventRing(mem.view, mem.baseOffset).writeHead;

  for (let i = 0; i < 10; i++) {
    writeHeaderEventRingEntry(mem.view, mem.baseOffset, {
      kind: HEADER_EVENT_KIND.FIELD_WRITE,
      field: HEADER_EVENT_FIELD.HEAP_POINTER,
      site: HEADER_EVENT_SITE.JS_RESIZE_SEGMENT,
      oldValue: i,
      newValue: i + 1,
    });
  }

  const ring = readHeaderEventRing(mem.view, mem.baseOffset);
  assertEquals(ring.writeHead, baseline + 10);
  assertEquals(ring.entries.length, 4, 'should only keep the last 4 entries');
  // Last 4 writes were i=6..9 (oldValue 6,7,8,9).
  assertEquals(ring.entries.map(e => e.oldValue), [6, 7, 8, 9]);
});

Deno.test('header event ring: readHeaderEventRing on an unwritten (disabled) ring returns empty', () => {
  const { mem } = createTestContext({});
  const ring = readHeaderEventRing(mem.view, mem.baseOffset);
  assertEquals(ring.entries.length, 0);
  assertEquals(ring.writeHead, 0);
  assertEquals(ring.capacity, 0);
});

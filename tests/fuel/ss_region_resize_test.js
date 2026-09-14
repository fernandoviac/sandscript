/**
 * Tests for engine.resizeSegment() — the umbrella primitive that
 * grows or shrinks the SS region (heap + string table) in place.
 *
 * The primitive moves the code block + string table as one
 * contiguous unit by `delta = new_string_start - old_string_start`,
 * rewrites STATE header fields, and refreshes the cached
 * $string_start global. After it returns, execution continues
 * normally against the resized layout.
 */

import { assertEquals } from "https://deno.land/std@0.208.0/assert/mod.ts";
import { freshSession, restoreSession, snapshotSession } from '../../src/host-owned-session.js';

const INITIAL_RESIZE_HEAP_SIZE = 768 * 1024;

function createBigBuffer(bytes) {
  // Build a SAB big enough for any test in this file. We size the
  // WebAssembly.Memory generously so the buffer envelope never blocks
  // a grow.
  const pages = Math.ceil(bytes / 65536);
  return new WebAssembly.Memory({
    initial: pages,
    maximum: pages,
    shared: true,
  });
}

Deno.test('grow segment without shrinking string table', () => {
  // Build a 1 MB session inside a 4 MB envelope, then grow to 2 MB.
  const memory = createBigBuffer(4 * 1024 * 1024);
  const session = freshSession({
    memory, offset: 0, heapSize: INITIAL_RESIZE_HEAP_SIZE,
  });
  const mem = session.airlock.memoryImage;

  // Run code that interns strings and allocates heap.
  let r = session.parse(`
    let s1 = "hello world"
    let s2 = "another string"
    let arr = [1, 2, 3, 4, 5]
    let obj = { a: s1, b: s2, c: arr }
  `);
  let result = session.run(0, 1_000_000);
  if (result.status === 'error') throw new Error(JSON.stringify(result.error));

  // Snapshot pre-resize state.
  const oldHeapPointer   = mem.getHeapPointer();
  const oldStringStart   = mem.getStringStart();
  const oldStringPointer = mem.getStringPointer();
  const oldSegmentSize   = mem.segmentSize;

  // Grow to 2 MB.
  session.resizeSegment({ newSegmentSize: 2 * 1024 * 1024 });

  // Heap pointer and string contents unchanged.
  assertEquals(mem.getHeapPointer(), oldHeapPointer, 'heap_pointer must not move on grow');
  assertEquals(mem.segmentSize, 2 * 1024 * 1024, 'segmentSize must update');

  // String table moved outward; bytes are intact.
  const delta = mem.getStringStart() - oldStringStart;
  if (delta !== (2 * 1024 * 1024 - oldSegmentSize)) {
    throw new Error(`Expected delta ${2*1024*1024 - oldSegmentSize}, got ${delta}`);
  }
  assertEquals(mem.getStringPointer(), oldStringPointer + delta,
    'string_pointer must shift by delta');

  // Previously interned strings still resolve through the same JS reads.
  const s1 = session.get(0, 's1');
  const s2 = session.get(0, 's2');
  assertEquals(s1, 'hello world');
  assertEquals(s2, 'another string');

  // Post-resize execution: more allocation, more strings.
  r = session.parse(`
    let bigArr = [10, 20, 30, 40, 50, 60, 70, 80, 90, 100]
    let s3 = "added after resize"
  `);
  mem.setContextInstructionIndex(0, r.startIndex);
  result = session.run(0, 1_000_000);
  if (result.status === 'error') throw new Error(JSON.stringify(result.error));

  assertEquals(session.get(0, 's3'), 'added after resize');
});

Deno.test('grow segment with bigger string table', () => {
  const memory = createBigBuffer(4 * 1024 * 1024);
  const session = freshSession({
    memory, offset: 0, heapSize: INITIAL_RESIZE_HEAP_SIZE,
  });
  const mem = session.airlock.memoryImage;

  let r = session.parse(`let initial = "first string"`);
  let result = session.run(0, 1_000_000);
  if (result.status === 'error') throw new Error(JSON.stringify(result.error));

  // Grow to 2 MB with a 512 KB string table (up from 256 KB default).
  session.resizeSegment({
    newSegmentSize: 2 * 1024 * 1024,
    newStringTableSize: 512 * 1024,
  });

  // Old string still resolves.
  assertEquals(session.get(0, 'initial'), 'first string');

  // Intern a new string post-resize.
  r = session.parse(`let after = "post-grow string"`);
  mem.setContextInstructionIndex(0, r.startIndex);
  result = session.run(0, 1_000_000);
  if (result.status === 'error') throw new Error(JSON.stringify(result.error));
  assertEquals(session.get(0, 'after'), 'post-grow string');
});

Deno.test('string-table size change rebuilds the derived hash index: ids stable, dedup intact', () => {
  // Layout v14: the hash index sits at the region TAIL with a bucket
  // count derived from the region size, so a table-size change
  // changes the index while every interned id stays valid. This test
  // pins the whole contract: churn thousands of entries, grow the
  // table, and require (a) same id for same bytes through the rebuilt
  // index, (b) property lookups keyed by pre-resize ids still hit,
  // (c) the WAT's cached derived globals track the change.
  const memory = createBigBuffer(8 * 1024 * 1024);
  const session = freshSession({
    memory, offset: 0, heapSize: INITIAL_RESIZE_HEAP_SIZE,
  });
  const mem = session.airlock.memoryImage;

  let r = session.parse(`
    let keep = []
    let i = 0
    while (i < 3000) { keep.push("r_" + i); i = i + 1 }
    let holder = {}
    holder["resize" + "-dedup-probe"] = 77
  `);
  let result = session.run(0, 20_000_000);
  while (result.status === 'memory_pressure') {
    session.gc();
    result = session.run(0, 20_000_000);
  }
  assertEquals(result.status, 'done', `churn: expected done, got ${result.status}`);

  // Captured AFTER the churn (its pressure-gc cycles would collect an
  // unreferenced entry): dedups against the live holder key, so this
  // is the canonical live id going into the resize.
  const idBefore = mem.internString('resize-dedup-probe');

  session.resizeSegment({
    newSegmentSize: 4 * 1024 * 1024,
    newStringTableSize: 1024 * 1024,  // up from the 256 KB default
  });

  // (a) Dedup through the rebuilt index returns the ORIGINAL id.
  const idAfter = mem.internString('resize-dedup-probe');
  assertEquals(idAfter, idBefore, 'same bytes must dedup to the same id across the resize');

  // (c) The WAT re-derived its cached index globals.
  const audit = mem.auditRegionGlobals();
  assertEquals(audit.mismatches, [], 'cached globals must track the resize');

  // (b) A runtime-rebuilt key still hits the pre-resize property.
  r = session.parse(`
    let got = holder["resize-dedup" + "-probe"]
    let late = keep[2999]
  `);
  mem.setContextInstructionIndex(0, r.startIndex);
  result = session.run(0, 20_000_000);
  while (result.status === 'memory_pressure') {
    session.gc();
    result = session.run(0, 20_000_000);
  }
  assertEquals(result.status, 'done', `readback: expected done, got ${result.status}`);
  assertEquals(session.get(0, 'got'), 77);
  assertEquals(session.get(0, 'late'), 'r_2999');
});

Deno.test('shrink after compact', () => {
  // Start with a 4 MB segment, run code, compact, then shrink.
  const memory = createBigBuffer(4 * 1024 * 1024);
  const session = freshSession({
    memory, offset: 0, heapSize: INITIAL_RESIZE_HEAP_SIZE,
  });
  const mem = session.airlock.memoryImage;

  let r = session.parse(`
    let live = "must survive"
    let arr = [1, 2, 3]
    let nested = { x: live, y: arr }
  `);
  let result = session.run(0, 1_000_000);
  if (result.status === 'error') throw new Error(JSON.stringify(result.error));

  // Compact + read the high-water mark.
  session.gc();
  const hwm = session.airlock.shrinkableHighWaterMark();
  const heapStart = mem.getHeapStart();

  // Pick a shrink target generous enough to leave headroom: HWM + 1 MB
  // for the new heap end (well above hwm), plus a 256 KB string table.
  // Total = HWM + 1 MB + 256 KB.
  const newStringTableSize = 256 * 1024;
  const newSegmentSize = hwm + 1024 * 1024 + newStringTableSize;
  // Round up to be safe (must satisfy newStringStart > hwm).

  session.resizeSegment({ newSegmentSize, newStringTableSize });

  // Previously-live data still resolves.
  assertEquals(session.get(0, 'live'), 'must survive');
  assertEquals(mem.segmentSize, newSegmentSize);

  // Sanity: the relocated code pointer must sit above heap_pointer.
  const codePointer = mem.getCodePointer();
  const heapPointer = mem.getHeapPointer();
  if (codePointer < heapPointer) {
    throw new Error(`code_pointer ${codePointer} below heap_pointer ${heapPointer}`);
  }

  // Execution continues against the smaller layout.
  r = session.parse(`let extra = [99, 98, 97]`);
  mem.setContextInstructionIndex(0, r.startIndex);
  result = session.run(0, 1_000_000);
  if (result.status === 'error') throw new Error(JSON.stringify(result.error));
  // Verify it resolved correctly post-resize.
  const extra = session.get(0, 'extra');
  if (!Array.isArray(extra) || extra.length !== 3) {
    throw new Error(`Expected array [99,98,97], got ${JSON.stringify(extra)}`);
  }
});

Deno.test('shrink rejected when below heap_pointer', () => {
  const memory = createBigBuffer(4 * 1024 * 1024);
  const session = freshSession({
    memory, offset: 0, heapSize: INITIAL_RESIZE_HEAP_SIZE,
  });
  const mem = session.airlock.memoryImage;

  // Allocate enough heap to push heap_pointer well past heap_start.
  let r = session.parse(`
    let a = [1,2,3,4,5,6,7,8,9,10]
    let b = [11,12,13,14,15,16,17,18,19,20]
    let c = { x: a, y: b, z: "padding string padding string" }
  `);
  let result = session.run(0, 1_000_000);
  if (result.status === 'error') throw new Error(JSON.stringify(result.error));
  session.gc();

  const heapPointer = mem.getHeapPointer();
  const heapStart   = mem.getHeapStart();

  // Try to shrink below the live heap. Build a target where
  // newCodePointer < heapPointer.
  const newStringTableSize = 256 * 1024;
  // newSegmentSize chosen so new_string_start = newSegmentSize - 256KB
  // sits below heap_pointer: pick newSegmentSize = heapStart + 256KB +
  // a few bytes of code-block headroom (16). That places new_string_start
  // right at heap_start + 16, deliberately below heap_pointer.
  const newSegmentSize = heapStart + newStringTableSize + 16;

  let threw = null;
  try {
    session.resizeSegment({ newSegmentSize, newStringTableSize });
  } catch (e) {
    threw = e;
  }
  if (!threw) throw new Error('Expected resizeSegment to throw');
  if (!threw.message.includes('below heap_pointer')) {
    throw new Error(`Wrong error: ${threw.message}`);
  }
});

Deno.test('shrink rejected when below string-table usage', () => {
  const memory = createBigBuffer(4 * 1024 * 1024);
  const session = freshSession({
    memory, offset: 0, heapSize: INITIAL_RESIZE_HEAP_SIZE,
  });
  const mem = session.airlock.memoryImage;

  // Force intern usage to a known floor.
  let r = session.parse(`
    let a = "string-one"
    let b = "string-two-different"
    let c = "string-three-yet-another-distinct-value"
  `);
  let result = session.run(0, 1_000_000);
  if (result.status === 'error') throw new Error(JSON.stringify(result.error));

  const stringStart   = mem.getStringStart();
  const stringPointer = mem.getStringPointer();
  const usedBytes     = stringPointer - stringStart;

  // Request a table whose DATA SPAN (table minus the derived tail
  // index) lands below used bytes — must reject. For T a multiple of
  // 16 the span is T/2 - 8, so T = 2 * usedBytes rounded down to a
  // multiple of 16 always undershoots.
  let threw = null;
  try {
    session.resizeSegment({
      newSegmentSize: 2 * 1024 * 1024,
      newStringTableSize: Math.floor((usedBytes * 2) / 16) * 16,
    });
  } catch (e) {
    threw = e;
  }
  if (!threw) throw new Error('Expected resizeSegment to throw');
  if (!threw.message.includes('below current usage')) {
    throw new Error(`Wrong error: ${threw.message}`);
  }
});

Deno.test('grow rejected when exceeds buffer envelope', () => {
  const memory = createBigBuffer(2 * 1024 * 1024);
  const session = freshSession({
    memory, offset: 0, heapSize: INITIAL_RESIZE_HEAP_SIZE,
  });

  let threw = null;
  try {
    session.resizeSegment({ newSegmentSize: 4 * 1024 * 1024 });
  } catch (e) {
    threw = e;
  }
  if (!threw) throw new Error('Expected resizeSegment to throw');
  if (!threw.message.includes('exceeds buffer envelope')) {
    throw new Error(`Wrong error: ${threw.message}`);
  }
});

Deno.test('shrink and grow round-trip', () => {
  const memory = createBigBuffer(8 * 1024 * 1024);
  const session = freshSession({
    memory, offset: 0, heapSize: INITIAL_RESIZE_HEAP_SIZE,
  });
  const mem = session.airlock.memoryImage;

  let r = session.parse(`
    let s1 = "alpha"
    let s2 = "beta"
    let s3 = "gamma"
    let payload = { s1: s1, s2: s2, s3: s3, nums: [1, 2, 3, 4, 5] }
  `);
  let result = session.run(0, 1_000_000);
  if (result.status === 'error') throw new Error(JSON.stringify(result.error));
  session.gc();

  const hwm = session.airlock.shrinkableHighWaterMark();

  // Shrink to (heap floor + 1 MB) + 256 KB string table.
  const shrunkenSegmentSize = hwm + 1024 * 1024 + 256 * 1024;
  session.resizeSegment({
    newSegmentSize: shrunkenSegmentSize,
    newStringTableSize: 256 * 1024,
  });

  // All strings survive shrink.
  assertEquals(session.get(0, 's1'), 'alpha');
  assertEquals(session.get(0, 's2'), 'beta');
  assertEquals(session.get(0, 's3'), 'gamma');

  // Grow back.
  session.resizeSegment({ newSegmentSize: 4 * 1024 * 1024 });
  assertEquals(session.get(0, 's1'), 'alpha');
  assertEquals(session.get(0, 's2'), 'beta');
  assertEquals(session.get(0, 's3'), 'gamma');
  assertEquals(mem.segmentSize, 4 * 1024 * 1024);

  // Execution still works.
  r = session.parse(`let final = s1 + "-" + s2 + "-" + s3`);
  mem.setContextInstructionIndex(0, r.startIndex);
  result = session.run(0, 1_000_000);
  if (result.status === 'error') throw new Error(JSON.stringify(result.error));
  assertEquals(session.get(0, 'final'), 'alpha-beta-gamma');
});

Deno.test('resize across snapshot/restore', () => {
  // Snapshot, restore, then resize, then continue execution.
  const memory1 = createBigBuffer(4 * 1024 * 1024);
  const session1 = freshSession({
    memory: memory1, offset: 0, heapSize: INITIAL_RESIZE_HEAP_SIZE,
  });

  let r = session1.parse(`
    let surviving = "across snapshot"
    let v = 42
  `);
  let result = session1.run(0, 1_000_000);
  if (result.status === 'error') throw new Error(JSON.stringify(result.error));

  // Snapshot — both halves.
  const snap = snapshotSession(session1);

  // Restore into a fresh memory. Pre-allocate a 4 MB envelope so
  // the subsequent resize has headroom to grow into.
  const memory2 = createBigBuffer(4 * 1024 * 1024);
  const session2 = restoreSession(snap.vatBytes, snap.membraneBytes,
    { memory: memory2 });
  const mem2 = session2.airlock.memoryImage;

  // Resize the restored session.
  session2.resizeSegment({ newSegmentSize: 2 * 1024 * 1024 });

  // Snapshot data intact.
  assertEquals(session2.get(0, 'surviving'), 'across snapshot');
  assertEquals(session2.get(0, 'v'), 42);

  // Continue executing — must work against the new layout.
  r = session2.parse(`let postResize = surviving + "!"`);
  mem2.setContextInstructionIndex(0, r.startIndex);
  result = session2.run(0, 1_000_000);
  if (result.status === 'error') throw new Error(JSON.stringify(result.error));
  assertEquals(session2.get(0, 'postResize'), 'across snapshot!');
});

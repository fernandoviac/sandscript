/**
 * Differential GC tests for the WAT collector.
 *
 * Pins the premise the byte-equality oracle rests on and proves the
 * harness machinery, before any WAT exists:
 *
 *   1. BYTES SUFFICIENCY — collecting a bytes-only copy of a live
 *      session's segment produces byte-identical results to the live
 *      session's own gc(). If the JS collector consulted ANY state
 *      outside (segment bytes, roots), this fails.
 *   2. determinism across copies, with roots flowing through the
 *      scratch-block contract;
 *   3. the comparator is not vacuous (a corrupted input diverges);
 *   4. parked async contexts survive the copy path identically;
 *   5. the handle-liveness bitmap output matches the observer set.
 */
import { assert, assertEquals } from "https://deno.land/std@0.208.0/assert/mod.ts";
import { freshSession, snapshotSession, restoreSession } from '../../src/host-owned-session.js';
import { parseAndRun } from './test-helpers.js';
import { GC_HEADER_SIZE, REGEXP } from '../../src/fuel/constants.js';
import {
  runJsCollectorSide,
  runJsMarkOnlySide,
  runWatMarkOnlySide,
  runWatCollectorSide,
  compareBytes,
  compareSides,
} from './differential-gc-harness.js';

// THE differential oracle: full collection on both sides, full-segment
// byte compare plus the two scratch-block outputs.
function assertFullCollectParity(vatBytes, options = {}) {
  const jsSide = runJsCollectorSide(vatBytes, options);
  const watSide = runWatCollectorSide(vatBytes, options);

  if (jsSide.error !== null || watSide.error !== null) {
    assert(jsSide.error !== null && watSide.error !== null,
      `one side failed: JS ${jsSide.error?.message ?? 'ok'} / WAT ${watSide.error?.message ?? 'ok'}`);
    return;
  }
  assertEquals(watSide.status, 0, 'WAT collect returns success');

  const verdict = compareSides(jsSide, watSide);
  assert(verdict.agreement,
    `full collect diverged (${verdict.reason}): segments ${JSON.stringify(verdict.segments?.firstDiffs)} ` +
    `roots ${JSON.stringify(verdict.rootBlocks?.firstDiffs)} handles ${JSON.stringify(verdict.handleBitmaps?.firstDiffs)}`);
  assert(jsSide.stats.heapCollected >= 0);
  return jsSide.stats;
}

// Assert the WAT and JS mark-only runs agree on everything observable:
// segment bytes (the mark bits ARE the mark set), the string-mark
// bitmap, and the handle-liveness bitmap.
function assertMarkParity(vatBytes, options = {}) {
  const jsSide = runJsMarkOnlySide(vatBytes, options);
  const watSide = runWatMarkOnlySide(vatBytes, options);

  if (jsSide.error !== null || watSide.error !== null) {
    assert(jsSide.error !== null && watSide.error !== null,
      `one side failed: JS ${jsSide.error?.message ?? 'ok'} / WAT ${watSide.error?.message ?? 'ok'}`);
    return; // both-failed = agreement
  }
  assertEquals(watSide.status, 0, 'WAT mark-only returns success');

  const segments = compareBytes(jsSide.segment, watSide.segment);
  assert(segments.equal,
    `mark sets diverge: ${segments.diffCount} bytes, first ${JSON.stringify(segments.firstDiffs)}`);

  const section = (side, name) => side.scratch.subarray(
    side.layout.sections[name].offset,
    side.layout.sections[name].offset + side.layout.sections[name].size);
  const stringBitmaps = compareBytes(section(jsSide, 'stringMarkBitmap'), section(watSide, 'stringMarkBitmap'));
  assert(stringBitmaps.equal,
    `string-mark bitmaps diverge: first ${JSON.stringify(stringBitmaps.firstDiffs)}`);
  const handleBitmaps = compareBytes(section(jsSide, 'handleBitmap'), section(watSide, 'handleBitmap'));
  assert(handleBitmaps.equal,
    `handle bitmaps diverge: first ${JSON.stringify(handleBitmaps.firstDiffs)}`);
}

// A compaction-worthy program: garbage strings interned first (so
// live strings relocate), heap churn across object kinds, live
// closures, a Map/Set, bigints, a typed array.
function buildSession() {
  const session = freshSession({ inlineSource: true });
  for (let i = 0; i < 40; i++) {
    session.mem.internString(`garbage_padding_${i}_${'x'.repeat(30)}`);
  }
  parseAndRun(session, `
    let keep = 'live_marker_string';
    let nums = [1, 2.5, 3];
    let big = 12345678901234567890n;
    let m = new Map(); m.set('k', { nested: [keep] });
    let s = new Set(); s.add(42);
    let bytes = new Uint8Array(8); bytes[0] = 7;
    function makeAdder(n) { return (x) => x + n; }
    let add2 = makeAdder(2);
    let sum = add2(40);
    let trash = null;
    for (let i = 0; i < 30; i++) { trash = { filler: 'garbage_' + i }; }
    trash = null;
  `);
  return session;
}

Deno.test('bytes sufficiency: copy-collect equals live gc byte-for-byte', () => {
  const session = buildSession();
  const before = snapshotSession(session).vatBytes;

  const side = runJsCollectorSide(before, { roots: [] });
  assertEquals(side.error, null);
  assert(side.stats.heapCollected > 0, 'setup must actually collect garbage');
  assert(side.stats.stringsCollected > 0, 'setup must force string compaction');

  const liveStats = session.gc();
  const after = snapshotSession(session).vatBytes;

  const report = compareBytes(side.segment, after);
  assert(report.equal,
    `live and copy segments diverge: ${report.diffCount} bytes, first ${JSON.stringify(report.firstDiffs)}`);
  assertEquals(side.stats.heapCollected, liveStats.heapCollected);
  assertEquals(side.stats.stringsCollected, liveStats.stringsCollected);
});

Deno.test('determinism: two sides over the same copy agree on all outputs', () => {
  const session = buildSession();
  const bytes = snapshotSession(session).vatBytes;

  const sideA = runJsCollectorSide(bytes);
  const sideB = runJsCollectorSide(bytes);
  const verdict = compareSides(sideA, sideB);
  assert(verdict.agreement, `diverged: ${JSON.stringify(verdict)}`);
});

Deno.test('external roots flow through the scratch block and forward identically', () => {
  const session = buildSession();
  // An unreferenced heap object, rooted ONLY via the external-root
  // block — plus garbage below it so compaction relocates it.
  const rootedHeader = session.mem.allocateObject(2);
  const bytes = snapshotSession(session).vatBytes;

  const withRoot = runJsCollectorSide(bytes, { roots: [rootedHeader] });
  const withoutRoot = runJsCollectorSide(bytes);
  assertEquals(withRoot.error, null);
  assertEquals(withoutRoot.error, null);

  // The root kept the object alive: the rooted side retains more.
  assert(withRoot.stats.heapRetained > withoutRoot.stats.heapRetained,
    'external root must keep its object alive');

  // The block was rewritten with the forwarded address, and two rooted
  // runs agree byte-for-byte.
  assertEquals(withRoot.forwardedRoots.length, 1);
  const again = runJsCollectorSide(bytes, { roots: [rootedHeader] });
  const verdict = compareSides(withRoot, again);
  assert(verdict.agreement, `rooted runs diverged: ${JSON.stringify(verdict)}`);
});

Deno.test('comparator is not vacuous: corrupting a live string diverges', () => {
  const session = buildSession();
  const bytes = snapshotSession(session).vatBytes;

  // Find the live marker string's bytes and flip one in copy B's input.
  const marker = new TextEncoder().encode('live_marker_string');
  const corrupted = bytes.slice();
  const index = indexOfBytes(corrupted, marker);
  assert(index > 0, 'marker string present in the segment');
  corrupted[index] ^= 0xFF;

  const sideA = runJsCollectorSide(bytes);
  const sideB = runJsCollectorSide(corrupted);
  if (sideA.error === null && sideB.error === null) {
    const verdict = compareSides(sideA, sideB);
    assert(!verdict.agreement, 'corrupted input must not compare equal');
  }
  // (If the corruption made side B fail, that is divergence too —
  // one-failed-one-succeeded — and equally proves non-vacuity.)
});

function indexOfBytes(haystack, needle) {
  outer: for (let i = 0; i <= haystack.length - needle.length; i++) {
    for (let j = 0; j < needle.length; j++) {
      if (haystack[i + j] !== needle[j]) continue outer;
    }
    return i;
  }
  return -1;
}

Deno.test('parked async context: copy path collects identically', () => {
  const session = freshSession({ inlineSource: true });
  for (let i = 0; i < 40; i++) {
    session.mem.internString(`garbage_padding_${i}_${'x'.repeat(30)}`);
  }
  parseAndRun(session, `
    let gate = new Promise(() => {});
    let pending = (async () => { let inner = 'parked_marker'; await gate; return inner; })();
    let done = 'main_done';
  `);
  const bytes = snapshotSession(session).vatBytes;

  const sideA = runJsCollectorSide(bytes);
  const sideB = runJsCollectorSide(bytes);
  assertEquals(sideA.error, null, `collect over parked context failed: ${sideA.error?.message}`);
  const verdict = compareSides(sideA, sideB);
  assert(verdict.agreement, `diverged: ${JSON.stringify(verdict)}`);
});

Deno.test('WAT mark parity: rich heap program', () => {
  const session = buildSession();
  assertMarkParity(snapshotSession(session).vatBytes);
});

Deno.test('WAT mark parity: with external roots and handles', () => {
  const session = buildSession();
  session.mem.declareExternal('extThing', 7);
  session.mem.declareExternal('otherExt', 42);
  const rootedHeader = session.mem.allocateObject(2);
  assertMarkParity(snapshotSession(session).vatBytes, {
    roots: [rootedHeader],
    handleTableCapacity: 64,
  });
});

Deno.test('WAT mark parity: parked async context', () => {
  const session = freshSession({ inlineSource: true });
  parseAndRun(session, `
    let gate = new Promise(() => {});
    let pending = (async () => { let inner = 'parked_marker'; await gate; return inner; })();
    let done = 'main_done';
  `);
  assertMarkParity(snapshotSession(session).vatBytes);
});

Deno.test('WAT mark parity: every-construct AST session (graph walk)', () => {
  const session = freshSession({ inlineSource: true });
  parseAndRun(session, `
    let m = new Map(); m.set('mk', [1n, 2.5, 'deep_string']);
    let s = new Set(); s.add(Symbol('symdesc'));
    let ta = new Float64Array(4);
    function outer(a) { return (b) => a + b; }
    let f = outer(1);
  `);
  session.parse(`let second_root_marker = 'chain_check';`);
  assertMarkParity(snapshotSession(session).vatBytes);
});

Deno.test('WAT full-collect parity: rich heap program with real garbage', () => {
  const session = buildSession();
  const stats = assertFullCollectParity(snapshotSession(session).vatBytes);
  assert(stats.heapCollected > 0, 'setup must actually collect garbage');
  assert(stats.stringsCollected > 0, 'setup must force string compaction');
});

Deno.test('WAT full-collect parity: external roots and handles', () => {
  const session = buildSession();
  session.mem.declareExternal('extThing', 7);
  session.mem.declareExternal('otherExt', 42);
  const rootedHeader = session.mem.allocateObject(2);
  assertFullCollectParity(snapshotSession(session).vatBytes, {
    roots: [rootedHeader],
    handleTableCapacity: 64,
  });
});

Deno.test('WAT full-collect parity: parked async context', () => {
  const session = freshSession({ inlineSource: true });
  for (let i = 0; i < 40; i++) {
    session.mem.internString(`garbage_padding_${i}_${'x'.repeat(30)}`);
  }
  parseAndRun(session, `
    let gate = new Promise(() => {});
    let pending = (async () => { let inner = 'parked_marker'; await gate; return inner; })();
    let done = 'main_done';
  `);
  assertFullCollectParity(snapshotSession(session).vatBytes);
});

Deno.test('WAT full-collect parity: AST session across the root chain', () => {
  const session = freshSession({ inlineSource: true });
  for (let i = 0; i < 40; i++) {
    session.mem.internString(`garbage_padding_${i}_${'x'.repeat(30)}`);
  }
  parseAndRun(session, `
    let m = new Map(); m.set('mk', [1n, 2.5, 'deep_string']);
    let s = new Set(); s.add(Symbol('symdesc'));
    let ta = new Float64Array(4);
    function outer(a) { return (b) => a + b; }
    let f = outer(1);
  `);
  session.parse(`let second_root_marker = 'chain_check';`);
  assertFullCollectParity(snapshotSession(session).vatBytes);
});

Deno.test('WAT full-collect parity: no garbage at all (early-return path)', () => {
  const session = freshSession();
  parseAndRun(session, `let tiny = 1;`);
  assertFullCollectParity(snapshotSession(session).vatBytes);
});

Deno.test('WAT full collect: the collected session still runs', () => {
  // Not a byte comparison — an end-to-end sanity check that a
  // WAT-collected image is a functioning vat: restore it into a fresh
  // session and keep executing.
  const session = buildSession();
  const watSide = runWatCollectorSide(snapshotSession(session).vatBytes);
  assertEquals(watSide.error, null);
  assertEquals(watSide.status, 0);

  const { membraneBytes } = snapshotSession(session);
  const revived = restoreSession(watSide.segment, membraneBytes);
  parseAndRun(revived, `let after = keep + '|' + sum;`);
  assertEquals(revived.get(0, 'after'), 'live_marker_string|42');
});

Deno.test('handle-liveness bitmap output matches the observer set', () => {
  const session = buildSession();
  session.mem.declareExternal('extThing', 7);
  session.mem.declareExternal('otherExt', 42);
  const bytes = snapshotSession(session).vatBytes;

  const side = runJsCollectorSide(bytes, { handleTableCapacity: 64 });
  assertEquals(side.error, null);
  assert(side.liveHandleSlots.has(7), 'slot 7 observed');
  assert(side.liveHandleSlots.has(42), 'slot 42 observed');

  const bitmap = side.scratch.subarray(
    side.layout.sections.handleBitmap.offset,
    side.layout.sections.handleBitmap.offset + side.layout.sections.handleBitmap.size);
  for (let slot = 0; slot < 64; slot++) {
    const bit = (bitmap[slot >> 3] >> (slot & 7)) & 1;
    assertEquals(bit === 1, side.liveHandleSlots.has(slot), `bitmap bit for slot ${slot}`);
  }
});

Deno.test('WAT full-collect parity: regexp descriptors trace and forward', () => {
  const session = buildSession();
  // A live RegExp descriptor rooted externally: interned pattern string
  // plus a committed program ArrayBuffer wired through the descriptor's
  // DATA-pointer field. Garbage below it (buildSession) forces both the
  // descriptor and the buffer to relocate, and string garbage forces the
  // pattern id to forward.
  const patternOffset = session.mem.internString('regexp_pattern_marker_a|b');
  const regexpHeader = session.mem.allocateRegExp(patternOffset, 1);
  const programDataPointer = session.mem.allocateArrayBuffer(64);
  new Uint8Array(session.mem.memory.buffer).set(
    new TextEncoder().encode('SSRX_program_marker'),
    session.mem.abs(programDataPointer + 4));
  session.mem.view.setUint32(
    session.mem.abs(regexpHeader + GC_HEADER_SIZE + REGEXP.PROGRAM_BUFFER),
    programDataPointer,
    true);
  // A second descriptor whose pattern string is referenced only by it.
  // Rooting it must retain exactly one descriptor (32 heap bytes) and
  // one string entry more than dropping it — which proves the mark arm
  // traces the pattern id and the descriptor dies when unrooted.
  // (Byte-searching for the dead pattern would be wrong: string
  // compaction shrinks the bump pointer without zeroing tail bytes.)
  const orphanPattern = 'garbage_regexp_pattern_zzz';
  const orphanHeader = session.mem.allocateRegExp(
    session.mem.internString(orphanPattern), 0);

  const stringStart = session.mem.getStringStart();
  const bytes = snapshotSession(session).vatBytes;
  assertFullCollectParity(bytes, { roots: [regexpHeader] });

  const side = runJsCollectorSide(bytes, { roots: [regexpHeader] });
  assertEquals(side.error, null);
  assertEquals(side.forwardedRoots.length, 1);
  // The rooted descriptor kept its pattern string and program bytes.
  assert(indexOfBytes(side.segment.subarray(stringStart),
    new TextEncoder().encode('regexp_pattern_marker_a|b')) >= 0,
    'live pattern string survives');
  assert(indexOfBytes(side.segment,
    new TextEncoder().encode('SSRX_program_marker')) >= 0,
    'committed program buffer survives');

  const withOrphanRooted = runJsCollectorSide(bytes, {
    roots: [regexpHeader, orphanHeader],
  });
  assertEquals(withOrphanRooted.error, null);
  // Descriptor: GC header 8 + payload 16, aligned to 32.
  assertEquals(withOrphanRooted.stats.heapRetained - side.stats.heapRetained, 32,
    'unrooted regexp descriptor is reclaimed');
  // Pattern entry: 4-byte length + 26 bytes, aligned to 32.
  assertEquals(
    withOrphanRooted.stats.stringsRetained - side.stats.stringsRetained, 32,
    'descriptor-only pattern string is reclaimed with its descriptor');
});

Deno.test('WAT mark parity: regexp descriptor with uncommitted program', () => {
  const session = buildSession();
  // Program pointer still zero — the pre-commit shape every literal has
  // between allocation and successful emission.
  const regexpHeader = session.mem.allocateRegExp(
    session.mem.internString('uncommitted_pattern_marker'), 0);
  assertMarkParity(snapshotSession(session).vatBytes, { roots: [regexpHeader] });
});

/**
 * Tests for the AST region (slice 2 of source-inlining).
 *
 * The interpreter does not interpret AST bytes — these tests exercise
 * region plumbing only: enable/disable, header, allocation, byte access,
 * snapshot roundtrip, and per-instruction astNode threading. Slice 3
 * wires the parser to actually populate the region.
 *
 * Run with: deno task test tests/fuel/ast_region_test.js
 */

import { assertEquals, assert, assertThrows } from "https://deno.land/std@0.208.0/assert/mod.ts";
import { createSession } from '../../src/fuel/session.js';
import { AST_REGION_HEADER_SIZE } from '../../src/fuel/constants.js';
import { freshSession, restoreSession, snapshotSession } from '../../src/host-owned-session.js';

// "sand" as a 4-byte little-endian ASCII tag (placeholder for SS dialect)
const DIALECT_SAND = 0x646e6173;

Deno.test("AST region: disabled by default", () => {
  const session = freshSession();
  assertEquals(session.getAstRegion(), null);
  assertEquals(session.getAstRegionHeader(), null);
});

Deno.test("AST region: opt-in initializes the header at session creation", () => {
  // Slice 3 wires the parser to the writer, so session creation now stamps
  // the header with the SS dialect immediately.
  const session = freshSession({ inlineSource: true });
  const header = session.getAstRegionHeader();
  assertEquals(header.dialect, DIALECT_SAND);
  assertEquals(header.formatVersion, 6);
  assertEquals(session.mem.getAstRegionSize(), 256 * 1024);
});

Deno.test("AST region: header initialization writes dialect and version", () => {
  const session = freshSession({ inlineSource: true });
  session.mem.initializeAstRegionHeader(DIALECT_SAND, 1);
  const header = session.getAstRegionHeader();
  assertEquals(header.dialect, DIALECT_SAND);
  assertEquals(header.formatVersion, 6);
  assertEquals(header.rootNodeOffset, 0);
});

Deno.test("AST region: header init is idempotent", () => {
  const session = freshSession({ inlineSource: true });
  session.mem.initializeAstRegionHeader(DIALECT_SAND, 1);
  // Allocate something so pointer is past base.
  const off = session.mem.astRegionAlloc(8);
  // A second call to initialize should be a no-op (region already initialized).
  session.mem.initializeAstRegionHeader(0xdeadbeef, 99);
  // Original dialect/version should remain.
  const header = session.getAstRegionHeader();
  assertEquals(header.dialect, DIALECT_SAND);
  assertEquals(header.formatVersion, 6);
  // And the existing allocation is undisturbed.
  assertEquals(session.mem.getAstRegionPointer(),
               session.mem.getAstRegionBase() + AST_REGION_HEADER_SIZE + 8);
  // off was the offset right after the header.
  assertEquals(off, AST_REGION_HEADER_SIZE);
});

Deno.test("AST region: allocate appends and returns base-relative offset", () => {
  const session = freshSession({ inlineSource: true });
  session.mem.initializeAstRegionHeader(DIALECT_SAND, 1);
  const a = session.mem.astRegionAlloc(4);
  const b = session.mem.astRegionAlloc(8);
  const c = session.mem.astRegionAlloc(2);
  assertEquals(a, AST_REGION_HEADER_SIZE);
  assertEquals(b, AST_REGION_HEADER_SIZE + 4);
  assertEquals(c, AST_REGION_HEADER_SIZE + 12);
});

Deno.test("AST region: write and read raw bytes", () => {
  const session = freshSession({ inlineSource: true });
  session.mem.initializeAstRegionHeader(DIALECT_SAND, 1);
  const offset = session.mem.astRegionAlloc(5);
  const view = session.mem.readAstRegionBytes(offset, 5);
  view[0] = 0x11;
  view[1] = 0x22;
  view[2] = 0x33;
  view[3] = 0x44;
  view[4] = 0x55;
  // Read back via a fresh view to avoid relying on view aliasing.
  const readback = session.mem.readAstRegionBytes(offset, 5);
  assertEquals(Array.from(readback), [0x11, 0x22, 0x33, 0x44, 0x55]);
});

Deno.test("AST region: alloc throws when region is exhausted", () => {
  const session = freshSession({ inlineSource: true, astRegionSize: 32 });
  session.mem.initializeAstRegionHeader(DIALECT_SAND, 1);
  // 32 bytes total, 16 used by header. We have 16 bytes left.
  session.mem.astRegionAlloc(16);
  assertThrows(
    () => session.mem.astRegionAlloc(1),
    Error,
    'AST region exhausted'
  );
});

Deno.test("AST region: header init throws when region too small", () => {
  // The session constructor auto-initializes the header when inlineSource
  // is on, so a too-small region surfaces the error there.
  assertThrows(
    () => freshSession({ inlineSource: true, astRegionSize: 8 }),
    Error,
    'too small for header'
  );
});

Deno.test("AST region: setAstRegionRootNodeOffset updates header", () => {
  const session = freshSession({ inlineSource: true });
  session.mem.initializeAstRegionHeader(DIALECT_SAND, 1);
  const nodeOffset = session.mem.astRegionAlloc(12);
  session.mem.setAstRegionRootNodeOffset(nodeOffset);
  const header = session.getAstRegionHeader();
  assertEquals(header.rootNodeOffset, nodeOffset);
});

Deno.test("AST region: copyAstRegion returns header + allocated bytes", () => {
  const session = freshSession({ inlineSource: true });
  session.mem.initializeAstRegionHeader(DIALECT_SAND, 1);
  const offset = session.mem.astRegionAlloc(4);
  const view = session.mem.readAstRegionBytes(offset, 4);
  view[0] = 0xAA;
  view[1] = 0xBB;
  view[2] = 0xCC;
  view[3] = 0xDD;
  const copy = session.getAstRegion();
  assertEquals(copy.length, AST_REGION_HEADER_SIZE + 4);
  assertEquals(copy[AST_REGION_HEADER_SIZE], 0xAA);
  assertEquals(copy[AST_REGION_HEADER_SIZE + 3], 0xDD);
});

// =============================================================================
// Snapshot roundtrip
// =============================================================================

Deno.test("AST region: roundtrip through toBytes / fromBytes preserves header and bytes", () => {
  // Restore walks the root chain (export-map rebuild), so the region
  // must hold real nodes — fabricated raw bytes now fail loudly as
  // corruption instead of round-tripping uninspected.
  const original = freshSession({ inlineSource: true });
  original.parse('let marker = 7');
  const regionBefore = original.getAstRegion();
  const rootBefore = original.getAstRegionHeader().rootNodeOffset;

  const bytes = snapshotSession(original).vatBytes;
  const restored = restoreSession(bytes, null);

  const header = restored.getAstRegionHeader();
  assertEquals(header.dialect, DIALECT_SAND);
  assertEquals(header.formatVersion, 6);
  assertEquals(header.rootNodeOffset, rootBefore);
  assertEquals(restored.getAstRegion(), regionBefore);
});

Deno.test("AST region: disabled session roundtrips with no AST data", () => {
  const original = freshSession();
  const bytes = snapshotSession(original).vatBytes;
  const restored = restoreSession(bytes, null);
  assertEquals(restored.getAstRegion(), null);
  assertEquals(restored.getAstRegionHeader(), null);
});

// =============================================================================
// Per-instruction astNode threading
// =============================================================================

Deno.test("AST region: instructions are attributed when inlineSource is on", () => {
  const session = freshSession({ inlineSource: true });
  session.parse('let x = 1 + 2');
  // With inlineSource on, value-producing emits carry an astNode. Some
  // auxiliary ops (POP/SCOPE_PUSH/etc.) remain 0; we just need at least one.
  let attributedCount = 0;
  for (const instr of session.state(0).instructions) {
    if (instr.astNode !== 0) attributedCount++;
  }
  assert(attributedCount > 0, 'expected at least one attributed instruction');
});

Deno.test("AST region: instructions are NOT attributed when inlineSource is off", () => {
  const session = freshSession();
  session.parse('let x = 1 + 2');
  for (const instr of session.state(0).instructions) {
    assertEquals(instr.astNode, 0);
  }
});

Deno.test("AST region: getAstNodeOffset returns the AST offset for attributed instructions", () => {
  const session = freshSession({ inlineSource: true });
  session.parse('let x = 1');
  // The first instruction (LIT_RATIONAL_INTEGER for `1`) should be attributed.
  const first = session.getAstNodeOffset(0);
  assert(first !== null && first !== 0, 'expected non-null astNode offset');
});

Deno.test("AST region: iterateAstAttributions yields all attributed instructions", () => {
  const session = freshSession({ inlineSource: true });
  session.parse('let x = 1; let y = 2');
  const list = [...session.iterateAstAttributions()];
  assert(list.length > 0, 'expected at least one attribution');
});

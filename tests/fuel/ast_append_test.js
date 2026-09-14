/**
 * Tests for slice 4 of source-inlining: append-time AST behavior.
 *
 * Slice 3 already exercises the basic per-parse-call root append (each
 * parse() writes one ROOT and chains it). These tests cover:
 *   - Multi-chunk contiguous AST region across many parse() calls
 *   - Roots iterate in append order
 *   - Cross-chunk attribution (instructions from chunk N decode through
 *     chunk N's nodes)
 *   - Region survives toBytes/fromBytes after multiple appends
 *   - Dialect lock-in: a session restored from a different-dialect
 *     snapshot rejects on attach
 *   - Format-version mismatch likewise
 *
 * Run with: deno task test tests/fuel/ast_append_test.js
 */

import { assertEquals, assert, assertThrows } from "https://deno.land/std@0.208.0/assert/mod.ts";
import { createSession } from '../../src/fuel/session.js';
import {
  createAstReader,
  createAstWriter,
  DIALECT_SAND,
  FORMAT_VERSION,
  NODE,
} from '../../src/fuel/ast.js';
import { freshSession, restoreSession, snapshotSession } from '../../src/host-owned-session.js';

// =============================================================================
// Multi-chunk append
// =============================================================================

Deno.test("Append: three parse() calls produce three roots in order", () => {
  const session = freshSession({ inlineSource: true });
  session.parse('let a = 1');
  session.parse('let b = 2');
  session.parse('let c = 3');
  const reader = createAstReader(session.mem);
  const roots = [...reader.iterateRoots()];
  assertEquals(roots.length, 3);
  assertEquals(reader.readTree(roots[0]).body.statements[0].bindings[0].name, 'a');
  assertEquals(reader.readTree(roots[1]).body.statements[0].bindings[0].name, 'b');
  assertEquals(reader.readTree(roots[2]).body.statements[0].bindings[0].name, 'c');
});

Deno.test("Append: each chunk's instructions point at the correct chunk's nodes", () => {
  const session = freshSession({ inlineSource: true });
  session.parse('let a = 1');     // produces some instructions
  const firstCount = session.mem.codeBlockInstructionCount();
  session.parse('let b = 2');     // appends more
  const reader = createAstReader(session.mem);

  // Pick an instruction from chunk 1 and chunk 2; both should resolve to
  // their own chunk's literal nodes.
  for (let i = 0; i < firstCount; i++) {
    const off = session.getAstNodeOffset(i);
    if (off === null) continue;
    const node = reader.readNode(off);
    if (node.type === 'LITERAL_INTEGER') {
      assertEquals(node.value, 1n);
      break;
    }
  }
  for (let i = firstCount; i < session.mem.codeBlockInstructionCount(); i++) {
    const off = session.getAstNodeOffset(i);
    if (off === null) continue;
    const node = reader.readNode(off);
    if (node.type === 'LITERAL_INTEGER') {
      assertEquals(node.value, 2n);
      break;
    }
  }
});

Deno.test("Append: header firstRoot stays put while lastRoot advances", () => {
  const session = freshSession({ inlineSource: true });
  session.parse('let a = 1');
  const afterFirst = session.getAstRegionHeader();
  const firstRootOffset = afterFirst.rootNodeOffset;
  const lastAfterFirst = afterFirst.lastRootOffset;
  assertEquals(firstRootOffset, lastAfterFirst, 'first parse: first === last');

  session.parse('let b = 2');
  const afterSecond = session.getAstRegionHeader();
  assertEquals(afterSecond.rootNodeOffset, firstRootOffset, 'firstRoot must not move');
  assert(afterSecond.lastRootOffset !== firstRootOffset, 'lastRoot must advance');

  session.parse('let c = 3');
  const afterThird = session.getAstRegionHeader();
  assertEquals(afterThird.rootNodeOffset, firstRootOffset, 'firstRoot still pinned');
  assert(afterThird.lastRootOffset !== afterSecond.lastRootOffset, 'lastRoot advances again');
});

Deno.test("Append: chain links via nextRoot pointers", () => {
  const session = freshSession({ inlineSource: true });
  session.parse('let a = 1');
  session.parse('let b = 2');
  session.parse('let c = 3');
  const reader = createAstReader(session.mem);
  const header = session.getAstRegionHeader();

  // Walk by hand from firstRoot via nextRoot.
  let cur = header.rootNodeOffset;
  const visited = [];
  while (cur !== 0) {
    visited.push(cur);
    const node = reader.readNode(cur);
    cur = node.nextRoot;
  }
  assertEquals(visited.length, 3);
  // Last entry should equal lastRoot from the header.
  assertEquals(visited[visited.length - 1], header.lastRootOffset);
});

// =============================================================================
// Region growth and snapshot roundtrip
// =============================================================================

Deno.test("Append: region pointer advances monotonically across parses", () => {
  const session = freshSession({ inlineSource: true });
  let prev = session.mem.getAstRegionPointer();
  for (const src of ['let a = 1', 'let b = 2 + 3', 'function f(x) { return x }']) {
    session.parse(src);
    const cur = session.mem.getAstRegionPointer();
    assert(cur > prev, `pointer must advance after parse(${src})`);
    prev = cur;
  }
});

Deno.test("Append: full multi-chunk session roundtrips through toBytes/fromBytes", () => {
  const original = freshSession({ inlineSource: true });
  original.parse('let a = 1 + 2');
  original.parse('function f(x) { return x * 2 }');
  original.parse('let r = f(3)');
  const snap = snapshotSession(original);

  const restored = restoreSession(snap.vatBytes, snap.membraneBytes, { inlineSource: true });
  const reader = createAstReader(restored.mem);
  const roots = [...reader.iterateRoots()];
  assertEquals(roots.length, 3);
  // Sanity-check chunk 2 (the function declaration).
  const fn = reader.readTree(roots[1]).body.statements[0];
  assertEquals(fn.type, 'FUNCTION_DECL');
  assertEquals(fn.name, 'f');
  assertEquals(fn.params[0].name, 'x');
});

// =============================================================================
// Dialect lock-in
// =============================================================================

Deno.test("Append: restoring a snapshot with a different dialect rejects with a clear error", () => {
  // Build a "fake foreign-dialect" session: write the bytes of an SS session
  // but tamper the dialect tag to a different value before restore.
  const original = freshSession({ inlineSource: true });
  original.parse('let x = 1');
  const snap = snapshotSession(original);
  const bytes = snap.vatBytes;

  // Locate AST_REGION_BASE inside the snapshot and overwrite the dialect.
  // STATE.AST_REGION_BASE = HEADER_SIZE + 0x84 = 0x10 + 0x84 = 0x94.
  // The base is a u32 at that offset; the dialect is the first u32 at the
  // base.
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const astRegionBase = view.getUint32(0x94, true);
  // Overwrite dialect with a foreign tag.
  view.setUint32(astRegionBase, 0xCAFEBABE, true);

  assertThrows(
    () => restoreSession(bytes, snap.membraneBytes, { inlineSource: true }),
    Error,
    'dialect mismatch'
  );
});

Deno.test("Append: restoring a snapshot with a wrong format_version rejects", () => {
  const original = freshSession({ inlineSource: true });
  original.parse('let x = 1');
  const snap = snapshotSession(original);
  const bytes = snap.vatBytes;

  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const astRegionBase = view.getUint32(0x94, true);
  // FORMAT_VERSION lives at base + 4 (u16).
  view.setUint16(astRegionBase + 4, 99, true);

  assertThrows(
    () => restoreSession(bytes, snap.membraneBytes, { inlineSource: true }),
    Error,
    'format_version mismatch'
  );
});

Deno.test("Append: matching-dialect snapshot restore is fine", () => {
  const original = freshSession({ inlineSource: true });
  original.parse('let x = 1');
  original.parse('let y = 2');
  const snap = snapshotSession(original);

  // Should not throw.
  const restored = restoreSession(snap.vatBytes, snap.membraneBytes, { inlineSource: true });
  const reader = createAstReader(restored.mem);
  const roots = [...reader.iterateRoots()];
  assertEquals(roots.length, 2);
});

Deno.test("Append: continuing to parse on a restored session extends the chain", () => {
  const original = freshSession({ inlineSource: true });
  original.parse('let a = 1');
  const snap = snapshotSession(original);

  const restored = restoreSession(snap.vatBytes, snap.membraneBytes, { inlineSource: true });
  restored.parse('let b = 2');
  restored.parse('let c = 3');

  const reader = createAstReader(restored.mem);
  const roots = [...reader.iterateRoots()];
  assertEquals(roots.length, 3);
  assertEquals(reader.readTree(roots[0]).body.statements[0].bindings[0].name, 'a');
  assertEquals(reader.readTree(roots[1]).body.statements[0].bindings[0].name, 'b');
  assertEquals(reader.readTree(roots[2]).body.statements[0].bindings[0].name, 'c');
});

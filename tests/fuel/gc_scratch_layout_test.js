/**
 * GC scratch layout tests for the WAT collector.
 *
 * The scratch block carries the WAT collector's working memory and
 * knowledge tables, written from the live JS constants so there is no
 * second copy to drift. These tests pin the encoding against its JS
 * sources: every opcode's operand kind, every intrinsic cell, every
 * NODE_LAYOUT record round-trips; absent AST tags read as absent; the
 * root block round-trips and enforces capacity.
 */
import { assert, assertEquals, assertThrows } from "https://deno.land/std@0.208.0/assert/mod.ts";
import {
  computeGcScratchLayout,
  writeGcScratchBlock,
  writeGcScratchRoots,
  readGcScratchRoots,
  readGcScratchAstRecord,
  GC_SCRATCH_HEADER,
  GC_SCRATCH_HEADER_SIZE,
} from '../../src/fuel/gc-scratch-layout.js';
import {
  OPCODE_OPERANDS,
  INTRINSIC_STATE_CELLS,
  STRING_DATA_START,
  hashTableSize,
} from '../../src/fuel/constants.js';
import { NODE, NODE_LAYOUT } from '../../src/fuel/ast.js';

const OPTIONS = {
  stringTableSize: 256 * 1024,
  astRegionSize: 64 * 1024,
  handleTableCapacity: 4096,
  rootCapacity: 128,
};

function writtenBlock(options = OPTIONS) {
  const layout = computeGcScratchLayout(options);
  const baseOffset = 32; // deliberately non-zero
  const buffer = new ArrayBuffer(baseOffset + layout.byteLength);
  writeGcScratchBlock(buffer, baseOffset, layout);
  return { layout, baseOffset, buffer };
}

Deno.test('layout: sections are ordered, 4-aligned, and inside byteLength', () => {
  const { byteLength, sections } = computeGcScratchLayout(OPTIONS);
  let previousEnd = GC_SCRATCH_HEADER_SIZE;
  for (const [name, section] of Object.entries(sections)) {
    assertEquals(section.offset % 4, 0, `${name} offset 4-aligned`);
    assert(section.offset >= previousEnd, `${name} does not overlap the previous section`);
    previousEnd = section.offset + section.size;
  }
  assert(previousEnd <= byteLength);
});

Deno.test('layout: astRegionSize 0 (the default) collapses the AST sections', () => {
  const layout = computeGcScratchLayout({ ...OPTIONS, astRegionSize: 0 });
  assertEquals(layout.sections.astVisitedBitmap.size, 0);
  assertEquals(layout.sections.astWorklist.size, 0);
});

Deno.test('operand-kind table matches OPCODE_OPERANDS for all 256 opcodes', () => {
  const { layout, baseOffset, buffer } = writtenBlock();
  const bytes = new Uint8Array(buffer);
  for (let opcode = 0; opcode < 256; opcode++) {
    const expected = OPCODE_OPERANDS[opcode]?.[0] ?? 0;
    assertEquals(
      bytes[baseOffset + layout.sections.operandKinds.offset + opcode], expected,
      `operand1 kind of opcode 0x${opcode.toString(16)}`);
  }
});

Deno.test('intrinsic-cell table matches INTRINSIC_STATE_CELLS', () => {
  const { layout, baseOffset, buffer } = writtenBlock();
  const view = new DataView(buffer);
  assertEquals(
    view.getUint32(baseOffset + GC_SCRATCH_HEADER.INTRINSIC_CELL_COUNT, true),
    INTRINSIC_STATE_CELLS.length);
  for (let i = 0; i < INTRINSIC_STATE_CELLS.length; i++) {
    assertEquals(
      view.getUint32(baseOffset + layout.sections.intrinsicCells.offset + i * 4, true),
      INTRINSIC_STATE_CELLS[i], `intrinsic cell ${i}`);
  }
});

Deno.test('every NODE_LAYOUT entry round-trips through its AST record', () => {
  const { layout, baseOffset, buffer } = writtenBlock();
  for (const [tagKey, tagLayout] of Object.entries(NODE_LAYOUT)) {
    const tag = Number(tagKey);
    const record = readGcScratchAstRecord(buffer, baseOffset, layout, tag);
    assert(record !== null, `tag 0x${tag.toString(16)} present`);
    assertEquals(record.children, (tagLayout.children ?? []).map((child) => child.offset));
    assertEquals(record.string, tagLayout.strings?.[0] ?? null);
    assertEquals(record.childArray,
      tagLayout.childArray === undefined
        ? null
        : { count: tagLayout.childArray.count, start: tagLayout.childArray.start });
    assertEquals(record.chain, tagLayout.chain ?? null);
  }
});

Deno.test('absent AST tags read as absent, never as empty layouts', () => {
  const { layout, baseOffset, buffer } = writtenBlock();
  const knownTags = new Set(Object.keys(NODE_LAYOUT).map(Number));
  let absentChecked = 0;
  for (let tag = 0; tag < layout.sections.astLayout.tagCapacity; tag++) {
    if (knownTags.has(tag)) continue;
    assertEquals(readGcScratchAstRecord(buffer, baseOffset, layout, tag), null,
      `tag 0x${tag.toString(16)} absent`);
    absentChecked++;
  }
  assert(absentChecked > 0, 'the tag space has gaps to check');
});

Deno.test('NODE_LAYOUT stays within the record format (≤6 children, ≤1 string)', () => {
  for (const [tagKey, tagLayout] of Object.entries(NODE_LAYOUT)) {
    const name = Object.entries(NODE).find(([, v]) => v === Number(tagKey))?.[0] ?? tagKey;
    assert((tagLayout.children ?? []).length <= 6, `NODE.${name} children fit the record`);
    assert((tagLayout.strings ?? []).length <= 1, `NODE.${name} strings fit the record`);
  }
});

Deno.test('root block round-trips and enforces capacity', () => {
  const { layout, baseOffset, buffer } = writtenBlock();
  const roots = [0x1000, 0x2040, 0x30F0];
  writeGcScratchRoots(buffer, baseOffset, layout, roots);
  assertEquals(readGcScratchRoots(buffer, baseOffset, layout), roots);

  const tooMany = Array.from({ length: OPTIONS.rootCapacity + 1 }, (_, i) => 16 * (i + 1));
  assertThrows(() => writeGcScratchRoots(buffer, baseOffset, layout, tooMany), RangeError);
});

Deno.test('string-mark bitmap is sized for the data span past the reserved prefix', () => {
  const layout = computeGcScratchLayout(OPTIONS);
  const stringDataSize = OPTIONS.stringTableSize
    - hashTableSize(OPTIONS.stringTableSize) - STRING_DATA_START;
  assertEquals(layout.sections.stringMarkBitmap.size, Math.ceil(stringDataSize / 4 / 8));
});

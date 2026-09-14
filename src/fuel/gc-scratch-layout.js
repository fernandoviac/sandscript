/**
 * GC scratch layout — pure-function helpers for the WAT collector's
 * working-memory block.
 *
 * The block lives OUTSIDE any vat segment, in host-reserved space of
 * the same `WebAssembly.Memory`; the host passes its base pointer to
 * `collect(gc_scratch_ptr, mode)`. Nothing in it is ever snapshotted,
 * and on a successful collection nothing inside any vat segment
 * differs between the JS and WAT collectors — the differential
 * harness compares full segments unmasked.
 *
 * Interior (all offsets block-relative, sections 4-byte aligned):
 *
 *   header             — self-describing: section offsets, capacities,
 *                        per-collect root count. The WAT reads
 *                        everything from here; only the base pointer
 *                        crosses the call boundary.
 *   operand kinds      — 256 × u8, operand1 kind per opcode
 *                        (OPERAND_KIND values from OPCODE_OPERANDS).
 *   intrinsic cells    — INTRINSIC_STATE_CELLS as u32 STATE offsets.
 *   AST layout table   — NODE_LAYOUT flattened to fixed 12-byte
 *                        records indexed by tag (format below).
 *   string-mark bitmap — 1 bit per 4 bytes of string data past the
 *                        reserved prefix; zeroed by the collector at
 *                        the start of every collection.
 *   string forwarding  — 1 u32 per 4 bytes of string data (entry ids
 *                        are 4-aligned): the WAT equivalent of
 *                        computeStringForwarding's Map. 0xFFFFFFFF =
 *                        no entry (live, unmoved), 0 = dead, else the
 *                        forwarded id. Filled by the collector each
 *                        collection.
 *   AST visited bitmap — 1 bit per 4 bytes of AST region.
 *   AST worklist       — u32 node offsets; capacity bounds the walk's
 *                        pending edges. Every edge is a distinct u32
 *                        field somewhere in the region and each is
 *                        pushed at most once (its parent pops exactly
 *                        once), so astRegionSize/4 entries can never
 *                        overflow — array-children-heavy nodes
 *                        approach one edge per 4 bytes.
 *   handle bitmap      — 1 bit per membrane handle slot; the
 *                        collector's liveness OUTPUT for membrane
 *                        compaction.
 *   root block         — [count:u32][u32 header pointers…]; input
 *                        roots, rewritten in place with forwarded
 *                        addresses (the collector's second output).
 *
 * The knowledge tables are written FROM the live JS constants
 * (OPCODE_OPERANDS, INTRINSIC_STATE_CELLS, NODE_LAYOUT) at write time
 * — there is no generated second copy to drift.
 *
 * AST record format (12 bytes, indexed by node tag):
 *   [0]      child count (≤ 6)
 *   [1..6]   child byte-offsets (u8, node-relative)
 *   [7]      string-field byte-offset, or 0xFF (none)
 *   [8]      childArray count-field byte-offset, or 0xFF (none)
 *   [9]      childArray elements-start byte-offset
 *   [10]     chain byte-offset (ROOT's nextRoot), or 0xFF (none)
 *   [11]     presence flag: 1 = tag exists. An all-zero record is an
 *            UNKNOWN tag — the WAT walker fails on it, matching
 *            iterateStringFields' throw.
 */

import {
  OPCODE_OPERANDS,
  INTRINSIC_STATE_CELLS,
  STRING_DATA_START,
  hashTableSize,
  GC_SCRATCH_HEADER,
  GC_SCRATCH_HEADER_SIZE,
} from './constants.js';
import { NODE_LAYOUT } from './ast.js';

export { GC_SCRATCH_HEADER, GC_SCRATCH_HEADER_SIZE };

const OPERAND_KIND_TABLE_SIZE = 256;
const AST_RECORD_SIZE = 12;
const AST_RECORD_MAX_CHILDREN = 6;
const NO_FIELD = 0xFF;

const align4 = (value) => (value + 3) & ~3;

function astLayoutTagCapacity() {
  let maxTag = 0;
  for (const tag of Object.keys(NODE_LAYOUT)) {
    maxTag = Math.max(maxTag, Number(tag));
  }
  return maxTag + 1;
}

/**
 * Compute the scratch block's layout. Pure — no buffer touched.
 *
 * @param {object} options
 * @param {number} options.stringTableSize — the vat's string table
 *   size (hash table included), as in the vat layout.
 * @param {number} [options.astRegionSize=0] — the vat's AST region
 *   size; 0 (the default everywhere) collapses the AST sections.
 * @param {number} options.handleTableCapacity — membrane handle-table
 *   capacity in slots.
 * @param {number} options.rootCapacity — max external roots per
 *   collection.
 * @returns {{ byteLength: number, sections: object }}
 */
export function computeGcScratchLayout(options) {
  const { stringTableSize, astRegionSize = 0, handleTableCapacity, rootCapacity } = options;
  if (!Number.isInteger(stringTableSize)
      || stringTableSize - hashTableSize(stringTableSize) - STRING_DATA_START <= 0) {
    throw new Error(
      `computeGcScratchLayout: stringTableSize ${stringTableSize} must leave ` +
      `a positive data span past the derived hash index and reserved prefix.`);
  }
  if (!Number.isInteger(handleTableCapacity) || handleTableCapacity < 0) {
    throw new Error(`computeGcScratchLayout: bad handleTableCapacity ${handleTableCapacity}`);
  }
  if (!Number.isInteger(rootCapacity) || rootCapacity < 0) {
    throw new Error(`computeGcScratchLayout: bad rootCapacity ${rootCapacity}`);
  }

  const tagCapacity = astLayoutTagCapacity();
  const stringDataSize =
    stringTableSize - hashTableSize(stringTableSize) - STRING_DATA_START;

  let offset = GC_SCRATCH_HEADER_SIZE;
  const section = (size) => {
    const start = offset;
    offset = align4(offset + size);
    return { offset: start, size };
  };

  const sections = {
    operandKinds:     section(OPERAND_KIND_TABLE_SIZE),
    intrinsicCells:   { ...section(INTRINSIC_STATE_CELLS.length * 4), count: INTRINSIC_STATE_CELLS.length },
    astLayout:        { ...section(tagCapacity * AST_RECORD_SIZE), tagCapacity },
    stringMarkBitmap: section(Math.ceil(stringDataSize / 4 / 8)),
    stringForwarding: { ...section(Math.ceil(stringDataSize / 4) * 4), entries: Math.ceil(stringDataSize / 4) },
    astVisitedBitmap: section(Math.ceil(astRegionSize / 4 / 8)),
    astWorklist:      { ...section(Math.ceil(astRegionSize / 4) * 4), capacity: Math.ceil(astRegionSize / 4) },
    handleBitmap:     { ...section(Math.ceil(handleTableCapacity / 8)), capacity: handleTableCapacity },
    rootBlock:        { ...section(4 + rootCapacity * 4), capacity: rootCapacity },
  };

  return { byteLength: offset, sections };
}

/**
 * Write the header and the knowledge tables into `buffer` at
 * `baseOffset`. Bitmaps and the worklist are zeroed; roots are
 * written separately per collect (writeGcScratchRoots).
 *
 * @param {ArrayBuffer|SharedArrayBuffer} buffer
 * @param {number} baseOffset
 * @param {object} layout — from computeGcScratchLayout.
 */
export function writeGcScratchBlock(buffer, baseOffset, layout) {
  const { byteLength, sections } = layout;
  if (baseOffset + byteLength > buffer.byteLength) {
    throw new RangeError(
      `writeGcScratchBlock: block (${byteLength} bytes) at ${baseOffset} ` +
      `overflows buffer (${buffer.byteLength}).`);
  }
  const view = new DataView(buffer);
  const bytes = new Uint8Array(buffer);

  // Zero the whole block, then fill header + tables.
  bytes.fill(0, baseOffset, baseOffset + byteLength);

  const H = GC_SCRATCH_HEADER;
  const writeHeader = (field, value) => view.setUint32(baseOffset + field, value, true);
  writeHeader(H.OPERAND_KINDS_OFFSET,      sections.operandKinds.offset);
  writeHeader(H.INTRINSIC_CELLS_OFFSET,    sections.intrinsicCells.offset);
  writeHeader(H.INTRINSIC_CELL_COUNT,      sections.intrinsicCells.count);
  writeHeader(H.AST_LAYOUT_OFFSET,         sections.astLayout.offset);
  writeHeader(H.AST_LAYOUT_TAG_CAPACITY,   sections.astLayout.tagCapacity);
  writeHeader(H.STRING_MARK_BITMAP_OFFSET, sections.stringMarkBitmap.offset);
  writeHeader(H.STRING_MARK_BITMAP_SIZE,   sections.stringMarkBitmap.size);
  writeHeader(H.AST_VISITED_BITMAP_OFFSET, sections.astVisitedBitmap.offset);
  writeHeader(H.AST_VISITED_BITMAP_SIZE,   sections.astVisitedBitmap.size);
  writeHeader(H.AST_WORKLIST_OFFSET,       sections.astWorklist.offset);
  writeHeader(H.AST_WORKLIST_CAPACITY,     sections.astWorklist.capacity);
  writeHeader(H.HANDLE_BITMAP_OFFSET,      sections.handleBitmap.offset);
  writeHeader(H.HANDLE_BITMAP_CAPACITY,    sections.handleBitmap.capacity);
  writeHeader(H.ROOT_BLOCK_OFFSET,         sections.rootBlock.offset);
  writeHeader(H.ROOT_CAPACITY,             sections.rootBlock.capacity);
  writeHeader(H.ROOT_COUNT,                0);
  writeHeader(H.STRING_FORWARDING_OFFSET,  sections.stringForwarding.offset);
  writeHeader(H.STRING_FORWARDING_ENTRIES, sections.stringForwarding.entries);

  // Operand kinds: operand1 kind per opcode; unlisted opcodes stay
  // NONE (0) from the zero-fill.
  for (const [opcode, kinds] of Object.entries(OPCODE_OPERANDS)) {
    bytes[baseOffset + sections.operandKinds.offset + Number(opcode)] = kinds[0];
  }

  // Intrinsic STATE cells.
  for (let i = 0; i < INTRINSIC_STATE_CELLS.length; i++) {
    view.setUint32(
      baseOffset + sections.intrinsicCells.offset + i * 4,
      INTRINSIC_STATE_CELLS[i], true);
  }

  // AST layout records.
  for (const [tagKey, tagLayout] of Object.entries(NODE_LAYOUT)) {
    const tag = Number(tagKey);
    const children = tagLayout.children ?? [];
    const strings = tagLayout.strings ?? [];
    if (children.length > AST_RECORD_MAX_CHILDREN) {
      throw new Error(
        `writeGcScratchBlock: NODE_LAYOUT tag 0x${tag.toString(16)} has ` +
        `${children.length} children — the ${AST_RECORD_SIZE}-byte record ` +
        `format holds ${AST_RECORD_MAX_CHILDREN}. Grow AST_RECORD_SIZE.`);
    }
    if (strings.length > 1) {
      throw new Error(
        `writeGcScratchBlock: NODE_LAYOUT tag 0x${tag.toString(16)} has ` +
        `${strings.length} string fields — the record format holds 1. ` +
        `Grow AST_RECORD_SIZE.`);
    }
    const record = baseOffset + sections.astLayout.offset + tag * AST_RECORD_SIZE;
    bytes[record + 0] = children.length;
    for (let i = 0; i < children.length; i++) {
      bytes[record + 1 + i] = children[i].offset;
    }
    bytes[record + 7] = strings.length === 1 ? strings[0] : NO_FIELD;
    bytes[record + 8] = tagLayout.childArray !== undefined ? tagLayout.childArray.count : NO_FIELD;
    bytes[record + 9] = tagLayout.childArray !== undefined ? tagLayout.childArray.start : 0;
    bytes[record + 10] = tagLayout.chain !== undefined ? tagLayout.chain : NO_FIELD;
    bytes[record + 11] = 1;
  }
}

/**
 * Write the per-collection external roots into the root block.
 *
 * @param {ArrayBuffer|SharedArrayBuffer} buffer
 * @param {number} baseOffset
 * @param {object} layout — from computeGcScratchLayout.
 * @param {number[]} roots — HEADER pointers.
 */
export function writeGcScratchRoots(buffer, baseOffset, layout, roots) {
  const { rootBlock } = layout.sections;
  if (roots.length > rootBlock.capacity) {
    throw new RangeError(
      `writeGcScratchRoots: ${roots.length} roots exceed the block's ` +
      `capacity ${rootBlock.capacity} — recompute the layout with a ` +
      `larger rootCapacity.`);
  }
  const view = new DataView(buffer);
  view.setUint32(baseOffset + GC_SCRATCH_HEADER.ROOT_COUNT, roots.length, true);
  view.setUint32(baseOffset + rootBlock.offset, roots.length, true);
  for (let i = 0; i < roots.length; i++) {
    view.setUint32(baseOffset + rootBlock.offset + 4 + i * 4, roots[i], true);
  }
}

/**
 * Read the root block back — the forwarded root addresses after a
 * collection (the WAT rewrites entries in place).
 *
 * @returns {number[]} header pointers.
 */
export function readGcScratchRoots(buffer, baseOffset, layout) {
  const view = new DataView(buffer);
  const { rootBlock } = layout.sections;
  const count = view.getUint32(baseOffset + rootBlock.offset, true);
  const roots = [];
  for (let i = 0; i < count; i++) {
    roots.push(view.getUint32(baseOffset + rootBlock.offset + 4 + i * 4, true));
  }
  return roots;
}

/**
 * Decode the AST layout record for one tag — the test/oracle-side
 * inverse of the writer's encoding.
 *
 * @returns {{ children: number[], string: number|null,
 *             childArray: {count:number,start:number}|null,
 *             chain: number|null } | null} null if the tag is absent.
 */
export function readGcScratchAstRecord(buffer, baseOffset, layout, tag) {
  const bytes = new Uint8Array(buffer);
  const record = baseOffset + layout.sections.astLayout.offset + tag * AST_RECORD_SIZE;
  if (bytes[record + 11] !== 1) return null;
  const children = [];
  for (let i = 0; i < bytes[record + 0]; i++) {
    children.push(bytes[record + 1 + i]);
  }
  return {
    children,
    string: bytes[record + 7] === NO_FIELD ? null : bytes[record + 7],
    childArray: bytes[record + 8] === NO_FIELD
      ? null
      : { count: bytes[record + 8], start: bytes[record + 9] },
    chain: bytes[record + 10] === NO_FIELD ? null : bytes[record + 10],
  };
}

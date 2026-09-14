/**
 * Vat layout — pure-function helpers for the interpreter segment.
 *
 * A "vat" is one interpreter's complete segment within a
 * `WebAssembly.Memory`: the SANDFUEL header (magic + four version
 * fields), STATE (region pointers, counters, builtin slots), then the
 * regions themselves (error info, scratch, builtins, AST, GC heap,
 * code block, string table). Contexts, their slot→pointer table, and their
 * parallel slot→allocation-generation table live inside the GC heap. All of
 * these bytes are what `session.snapshot()` historically returned.
 *
 * This module owns the layout contract. Three exports:
 *
 *   computeVatLayout(options) → { byteLength, regionOffsets, ... }
 *     Pure compute. Given sizing options, returns the total bytes the
 *     host needs to allocate and where each region will land. No
 *     buffer touched.
 *
 *   layoutVat(memory, baseOffset, options) → void
 *     Writes the SANDFUEL header, STATE, region offsets, and code-
 *     block header bytes into `memory` starting at `baseOffset`. No
 *     WASM instance required — pure DataView writes.
 *
 *   readVatLayout(bytes, baseOffset?) → { byteLength, regionOffsets, ... }
 *     Reads STATE back out of a laid-out (or snapshot-restored)
 *     buffer. Symmetric with computeVatLayout.
 *
 * After layoutVat, a host instantiates WASM and constructs a
 * MemoryImage to attach to the laid-out segment, then runs the
 * post-layout bootstrap (init_regions, init_string_table,
 * internBuiltinNames, context 0, root scope, builtins). None of that
 * happens here.
 */

import {
  HEADER,
  HEADER_SIZE,
  VERSION,
  STATE,
  STATE_SIZE,
  REGION_SIZE,
  SCRATCH_MINIMUM_SIZE,
  STRING_DATA_START,
  hashTableSize,
  OBJ,
  GC_HEADER_SIZE,
  CONTEXT_TABLE_INITIAL_SIZE,
  HEADER_EVENT_RING,
  HEADER_EVENT_RING_FORMAT_VERSION,
  STEP_RING,
  STEP_RING_FORMAT_VERSION,
} from './constants.js';
import { DRONE_FORMAT_VERSION } from '../persisted-format.js';

// SANDFUEL magic — 8 ASCII bytes at offset 0.
const MAGIC_BYTES = new Uint8Array([0x53, 0x41, 0x4E, 0x44, 0x46, 0x55, 0x45, 0x4C]); // "SANDFUEL"

/**
 * Compute the layout of a vat segment given sizing options.
 *
 * No buffer is touched. The host uses the returned `byteLength` to
 * size its `WebAssembly.Memory` (round up to page boundary) before
 * calling `layoutVat`.
 *
 * @param {object} options
 * @param {number} [options.segmentSize] — total bytes for the
 *   segment. If omitted, computed as the sum of fixed-size regions
 *   plus a default GC-heap budget plus the string table.
 * @param {number} [options.stringTableSize=262144] — bytes reserved
 *   for the string table at the segment tail.
 * @param {number} [options.errorInfoSize] — region size override.
 * @param {number} [options.scratchSize] — region size override.
 * @param {number} [options.builtinsSize] — region size override.
 * @param {number} [options.contextTableSize] — initial size in bytes of
 *   the slot→pointer context table (4 bytes per slot), carved as the
 *   first heap object. A starting hint, not a ceiling — allocateContext
 *   grows the table on demand.
 * @param {number} [options.astRegionSize=0] — bytes reserved for the
 *   AST region. 0 disables inline source (default).
 * @param {number} [options.heapSize] — bytes reserved for the GC heap.
 *   Only consulted when `segmentSize` is omitted; otherwise the heap
 *   fills whatever the segment leaves between the fixed regions and
 *   the string table. Default 8 MB — enough headroom for ordinary exact
 *   algebraic operations to finish atomically instead of yielding persistent
 *   memory pressure under the former legacy 768 KB budget.
 * @returns {{
 *   byteLength: number,
 *   regionOffsets: {
 *     stateBase: number,
 *     errorInfoBase: number,
 *     scratchBase: number,
 *     builtinsBase: number,
 *     astRegionBase: number,
 *     heapStart: number,
 *     heapEnd: number,
 *     stringStart: number,
 *     stringPointer: number,
 *     codeStart: number,
 *   },
 *   regionSizes: {
 *     errorInfo: number,
 *     scratch: number,
 *     builtins: number,
 *     astRegion: number,
 *     stringTable: number,
 *   },
 *   contextTableSize: number,
 * }}
 */
export function computeVatLayout(options = {}) {
  // Layout v8: no EXTERNAL_REQUEST region — the request block is
  // per-context (CTX.REQUEST_BLOCK inside each context object).
  // Layout v10: no CONTEXT_REGION either — the slot→pointer table is a
  // growable heap object (carved by layoutVat as the first heap
  // allocation, grown by allocateContext).
  const errorInfoSize       = options.errorInfoSize       ?? REGION_SIZE.ERROR_INFO;
  const scratchSize         = options.scratchSize         ?? REGION_SIZE.SCRATCH;
  if (scratchSize < SCRATCH_MINIMUM_SIZE) {
    throw new Error(
      `computeVatLayout: scratchSize ${scratchSize} is below the minimum ` +
      `${SCRATCH_MINIMUM_SIZE} — the interpreter's own fixed-extent scratch ` +
      `staging must always fit ($scratch_ptr traps on overflow).`);
  }
  const builtinsSize        = options.builtinsSize        ?? REGION_SIZE.BUILTINS;
  const contextTableSize    = options.contextTableSize    ?? CONTEXT_TABLE_INITIAL_SIZE;
  const astRegionSize       = options.astRegionSize       ?? REGION_SIZE.AST_REGION;
  const stepRingSize        = options.stepRingSize         ?? REGION_SIZE.STEP_RING;
  const headerEventRingSize = options.headerEventRingSize ?? REGION_SIZE.HEADER_EVENT_RING;
  const stringTableSize     = options.stringTableSize     ?? 256 * 1024;
  const heapSize            = options.heapSize            ?? 8 * 1024 * 1024;

  // Region offsets are sequential after the STATE header.
  let offset = HEADER_SIZE + STATE_SIZE;

  const errorInfoBase       = offset; offset += errorInfoSize;
  const scratchBase         = offset; offset += scratchSize;
  const builtinsBase        = offset; offset += builtinsSize;
  const astRegionBase       = offset; offset += astRegionSize;
  const stepRingBase        = offset; offset += stepRingSize;
  const headerEventRingBase = offset; offset += headerEventRingSize;
  const heapStart           = offset;

  // segmentSize: caller-supplied or derived from the requested heap budget.
  const segmentSize = options.segmentSize ?? (heapStart + heapSize + stringTableSize);

  // The hash-index bucket count is derived from the region size; the
  // sizing proof (see constants.js hashTableBuckets) needs the region
  // to be a multiple of 8, and the derived index plus the reserved
  // prefix must leave a positive data span.
  if (stringTableSize % 8 !== 0) {
    throw new Error(
      `computeVatLayout: stringTableSize ${stringTableSize} must be a ` +
      `multiple of 8 (hash-index sizing invariant).`);
  }
  if (stringTableSize - hashTableSize(stringTableSize) - STRING_DATA_START <= 0) {
    throw new Error(
      `computeVatLayout: stringTableSize ${stringTableSize} leaves no ` +
      `data span after the derived hash index ` +
      `(${hashTableSize(stringTableSize)} bytes) and the reserved prefix.`);
  }

  const stringStart = segmentSize - stringTableSize;
  const heapEnd     = stringStart;

  if (heapStart > heapEnd) {
    throw new Error(
      `Vat layout exceeds segment size: fixed regions need ${heapStart} bytes ` +
      `but only ${heapEnd} available (segmentSize=${segmentSize}, ` +
      `stringTableSize=${stringTableSize}).`);
  }

  // String pointer starts just past the reserved prefix at the head of
  // the string region (the hash index lives at the region TAIL); the
  // code block sits 16 bytes (header) below stringStart.
  const stringPointer = stringStart + STRING_DATA_START;
  const codeStart     = stringStart - 16;

  return {
    byteLength: segmentSize,
    regionOffsets: {
      stateBase: HEADER_SIZE,
      errorInfoBase,
      scratchBase,
      builtinsBase,
      astRegionBase,
      stepRingBase,
      headerEventRingBase,
      heapStart,
      heapEnd,
      stringStart,
      stringPointer,
      codeStart,
    },
    regionSizes: {
      errorInfo:       errorInfoSize,
      scratch:         scratchSize,
      builtins:        builtinsSize,
      astRegion:       astRegionSize,
      stepRing:        stepRingSize,
      headerEventRing: headerEventRingSize,
      stringTable:     stringTableSize,
    },
    contextTableSize,
  };
}

/**
 * Lay out a vat segment in `memory` at `baseOffset`.
 *
 * Writes the SANDFUEL header, the STATE block, the region-offset
 * fields inside STATE, and the code-block header. After this call,
 * the bytes at `[baseOffset, baseOffset + byteLength)` constitute a
 * valid empty vat — magic + versions check out, STATE points the GC
 * heap at an empty span, the code block has zero instructions, the
 * string table is unwritten (will be initialized by the post-layout
 * bootstrap inside the session).
 *
 * Pure DataView writes — no WASM, no allocation.
 *
 * @param {WebAssembly.Memory|ArrayBuffer|SharedArrayBuffer} memory
 *   The backing buffer. `WebAssembly.Memory` has its `.buffer`
 *   unwrapped automatically.
 * @param {number} baseOffset — Where the vat starts inside the buffer.
 * @param {object} options — Same as `computeVatLayout`.
 * @returns {object} The layout descriptor (same shape as `computeVatLayout`).
 */
export function layoutVat(memory, baseOffset, options = {}) {
  const buffer = memory instanceof WebAssembly.Memory ? memory.buffer : memory;
  if (typeof baseOffset !== 'number' || baseOffset < 0) {
    throw new TypeError(`layoutVat: baseOffset must be a non-negative number, got ${baseOffset}`);
  }

  const layout = computeVatLayout(options);
  const { byteLength, regionOffsets } = layout;

  if (baseOffset + byteLength > buffer.byteLength) {
    throw new RangeError(
      `layoutVat: vat (${byteLength} bytes) at baseOffset ${baseOffset} ` +
      `would overflow buffer (${buffer.byteLength} bytes).`);
  }

  const u8 = new Uint8Array(buffer);
  const view = new DataView(buffer);
  const abs = (off) => baseOffset + off;

  // SANDFUEL magic + four version fields.
  u8.set(MAGIC_BYTES, abs(HEADER.MAGIC));
  view.setUint16(abs(HEADER.DRONE_FORMAT_VERSION), DRONE_FORMAT_VERSION, true);
  view.setUint16(abs(HEADER.BYTECODE_VERSION),  VERSION.BYTECODE, true);
  view.setUint16(abs(HEADER.TYPE_VERSION),      VERSION.TYPE,     true);
  view.setUint16(abs(HEADER.BUILTIN_VERSION),   VERSION.BUILTIN,  true);

  const {
    errorInfoBase, scratchBase, builtinsBase,
    astRegionBase, stepRingBase, headerEventRingBase,
    heapStart, heapEnd, stringStart, stringPointer, codeStart,
  } = regionOffsets;

  // Region bases in STATE. (No EXTERNAL_REQUEST_BASE since layout v8 —
  // the request block is per-context.)
  view.setUint32(abs(STATE.ERROR_INFO_BASE),       errorInfoBase,       true);
  view.setUint32(abs(STATE.SCRATCH_BASE),          scratchBase,         true);
  view.setUint32(abs(STATE.SCRATCH_REGION_SIZE),   layout.regionSizes.scratch, true);
  view.setUint32(abs(STATE.BUILTINS_BASE),         builtinsBase,        true);

  // Layout v18: carve parallel slot→pointer and slot→generation tables as the
  // first two heap objects. Both grow together; the generation entry remains
  // populated after its context pointer is cleared.
  const tableTotal = (GC_HEADER_SIZE + layout.contextTableSize + 15) & ~15;
  const contextTableHeader = heapStart;
  const contextTableData = contextTableHeader + GC_HEADER_SIZE;
  const generationTableHeader = contextTableHeader + tableTotal;
  const generationTableData = generationTableHeader + GC_HEADER_SIZE;
  view.setUint32(abs(contextTableHeader),
    (OBJ.STACK_BLOCK << 24) | tableTotal, true);
  view.setUint32(abs(contextTableHeader + 4), 0, true);
  view.setUint32(abs(generationTableHeader),
    (OBJ.STACK_BLOCK << 24) | tableTotal, true);
  view.setUint32(abs(generationTableHeader + 4), 0, true);
  u8.fill(0, abs(contextTableData), abs(contextTableHeader + tableTotal));
  u8.fill(0, abs(generationTableData), abs(generationTableHeader + tableTotal));

  // Heap / string pointers, segment metadata. The heap pointer starts
  // just past both carved tables.
  view.setUint32(abs(STATE.HEAP_POINTER), generationTableHeader + tableTotal, true);
  view.setUint32(abs(STATE.STRING_POINTER), stringPointer, true);
  view.setUint32(abs(STATE.HEAP_START), heapStart, true);
  view.setUint32(abs(STATE.HEAP_END), heapEnd, true);
  view.setUint32(abs(STATE.STRING_START), stringStart, true);
  view.setUint32(abs(STATE.SEGMENT_SIZE), byteLength, true);
  view.setUint32(abs(STATE.BASE_OFFSET), baseOffset, true);

  view.setUint32(abs(STATE.CONTEXT_COUNT), 0, true);
  view.setUint32(abs(STATE.CONTEXT_TABLE_POINTER), contextTableData, true);
  view.setUint32(abs(STATE.CONTEXT_GENERATION_TABLE_POINTER),
    generationTableData, true);
  // AST region pointers. Empty by default; the header is written
  // lazily on first allocation, so disabled (size=0) sessions don't
  // carry an empty header.
  view.setUint32(abs(STATE.AST_REGION_BASE),    astRegionBase,   true);
  view.setUint32(abs(STATE.AST_REGION_SIZE),    layout.regionSizes.astRegion, true);
  view.setUint32(abs(STATE.AST_REGION_POINTER), astRegionBase,   true);

  // Step ring region. Size 0 = disabled (interpreter skips ring
  // writes). An enabled ring carries its publication format version in
  // the ring header (docs/ring-publication-contract.md) and must sit
  // 4-byte aligned so atomic head/token accesses are legal.
  view.setUint32(abs(STATE.STEP_RING_BASE), stepRingBase, true);
  view.setUint32(abs(STATE.STEP_RING_SIZE), layout.regionSizes.stepRing, true);
  if (layout.regionSizes.stepRing > 0) {
    if (((baseOffset + stepRingBase) & 3) !== 0) {
      throw new RangeError(
        `layoutVat: step ring base must be 4-byte aligned for atomic ` +
        `publication; got absolute ${baseOffset + stepRingBase}`);
    }
    view.setUint32(abs(stepRingBase + STEP_RING.WRITE_HEAD), 0, true);
    view.setUint32(abs(stepRingBase + STEP_RING.FLAGS), 0, true);
    view.setUint32(abs(stepRingBase + STEP_RING.FORMAT_VERSION),
      STEP_RING_FORMAT_VERSION, true);
    view.setUint32(abs(stepRingBase + STEP_RING.SEGMENT_GENERATION), 1, true);
  }

  // Header-event ring region. Size 0 = disabled (interpreter and JS
  // collector/memory-image writers skip ring writes). An enabled ring
  // carries its publication format version in the ring header
  // (docs/ring-publication-contract.md) and must sit 4-byte aligned so
  // atomic head/token accesses are legal.
  view.setUint32(abs(STATE.HEADER_EVENT_RING_BASE), headerEventRingBase, true);
  view.setUint32(abs(STATE.HEADER_EVENT_RING_SIZE), layout.regionSizes.headerEventRing, true);
  if (layout.regionSizes.headerEventRing > 0) {
    if (((baseOffset + headerEventRingBase) & 3) !== 0) {
      throw new RangeError(
        `layoutVat: header-event ring base must be 4-byte aligned for ` +
        `atomic publication; got absolute ${baseOffset + headerEventRingBase}`);
    }
    view.setUint32(abs(headerEventRingBase + HEADER_EVENT_RING.WRITE_HEAD), 0, true);
    view.setUint32(abs(headerEventRingBase + HEADER_EVENT_RING.FLAGS), 0, true);
    view.setUint32(abs(headerEventRingBase + HEADER_EVENT_RING.FORMAT_VERSION),
      HEADER_EVENT_RING_FORMAT_VERSION, true);
    view.setUint32(abs(headerEventRingBase + HEADER_EVENT_RING.SEGMENT_GENERATION), 1, true);
  }

  // Code pointer + code-block header. Layout at the tail of the
  // pre-string area: [instructions grow downward ←][header 16B] stringStart.
  // Header: [count 4B][flags 4B][GC header 8B].
  view.setUint32(abs(STATE.CODE_POINTER), codeStart, true);
  view.setUint32(abs(STATE.CODE_BLOCK),   codeStart, true);

  // Code-block header bytes at codeStart..codeStart+15.
  view.setUint32(abs(codeStart),      0, true);                                  // instruction count
  view.setUint32(abs(codeStart + 4),  0, true);                                  // flags
  view.setUint32(abs(codeStart + 8),  (OBJ.CODE_BLOCK << 24) | 16, true);         // GC header
  view.setUint32(abs(codeStart + 12), 0, true);                                  // GC forwarding

  return layout;
}

/**
 * Read the layout of a vat back from its bytes.
 *
 * Symmetric inverse of `layoutVat`. Used by hosts that have snapshot
 * bytes on disk and need to know how much memory to allocate before
 * copying them into a fresh `WebAssembly.Memory`.
 *
 * Validates the SANDFUEL magic and rejects mismatches. Does not
 * validate the version fields — that's the caller's job, since the
 * answer may inform a migration decision.
 *
 * @param {Uint8Array|ArrayBuffer|SharedArrayBuffer} bytes
 * @param {number} [baseOffset=0] — Where the vat starts inside the bytes.
 * @returns {object} Same shape as `computeVatLayout`'s return, plus a
 *   `versions` field with the four header version numbers.
 */
export function readVatLayout(bytes, baseOffset = 0) {
  const buffer = bytes instanceof Uint8Array ? bytes.buffer : bytes;
  const byteOffset = bytes instanceof Uint8Array ? bytes.byteOffset : 0;
  const byteLength = bytes instanceof Uint8Array ? bytes.byteLength : buffer?.byteLength;
  if (!(buffer instanceof ArrayBuffer || buffer instanceof SharedArrayBuffer)) {
    throw new TypeError('readVatLayout: bytes must be a Uint8Array, ArrayBuffer, or SharedArrayBuffer');
  }
  if (!Number.isSafeInteger(baseOffset) || baseOffset < 0 ||
      baseOffset + HEADER_SIZE + STATE_SIZE > byteLength) {
    throw new RangeError(`readVatLayout: truncated header at baseOffset ${baseOffset}`);
  }
  const view = new DataView(buffer, byteOffset, byteLength);
  const abs = (off) => baseOffset + off;

  // Magic check.
  for (let i = 0; i < MAGIC_BYTES.length; i++) {
    if (view.getUint8(abs(HEADER.MAGIC + i)) !== MAGIC_BYTES[i]) {
      throw new Error(
        `readVatLayout: SANDFUEL magic mismatch at baseOffset ${baseOffset}`);
    }
  }

  const versions = {
    droneFormat: view.getUint16(abs(HEADER.DRONE_FORMAT_VERSION), true),
    bytecode:    view.getUint16(abs(HEADER.BYTECODE_VERSION),     true),
    type:        view.getUint16(abs(HEADER.TYPE_VERSION),         true),
    builtin:     view.getUint16(abs(HEADER.BUILTIN_VERSION),      true),
  };
  if (versions.droneFormat !== DRONE_FORMAT_VERSION) {
    throw new Error(
      `readVatLayout: unsupported drone format version ${versions.droneFormat}; ` +
      `expected ${DRONE_FORMAT_VERSION}`);
  }

  const segmentSize         = view.getUint32(abs(STATE.SEGMENT_SIZE),         true);
  if (segmentSize < HEADER_SIZE + STATE_SIZE ||
      segmentSize > byteLength - baseOffset) {
    throw new RangeError(
      `readVatLayout: declared segment size ${segmentSize} exceeds ` +
      `the ${byteLength - baseOffset}-byte input window`);
  }
  const errorInfoBase       = view.getUint32(abs(STATE.ERROR_INFO_BASE),       true);
  const scratchBase         = view.getUint32(abs(STATE.SCRATCH_BASE),          true);
  const builtinsBase        = view.getUint32(abs(STATE.BUILTINS_BASE),         true);
  const contextTablePointer = view.getUint32(abs(STATE.CONTEXT_TABLE_POINTER), true);
  const astRegionBase       = view.getUint32(abs(STATE.AST_REGION_BASE),       true);
  const astRegionSize       = view.getUint32(abs(STATE.AST_REGION_SIZE),       true);
  const stepRingBase        = view.getUint32(abs(STATE.STEP_RING_BASE),        true);
  const stepRingSize        = view.getUint32(abs(STATE.STEP_RING_SIZE),        true);
  const headerEventRingBase = view.getUint32(abs(STATE.HEADER_EVENT_RING_BASE), true);
  const headerEventRingSize = view.getUint32(abs(STATE.HEADER_EVENT_RING_SIZE), true);
  const heapStart           = view.getUint32(abs(STATE.HEAP_START),            true);
  const heapPointer         = view.getUint32(abs(STATE.HEAP_POINTER),          true);
  const heapEnd             = view.getUint32(abs(STATE.HEAP_END),              true);
  const stringStart         = view.getUint32(abs(STATE.STRING_START),          true);
  const stringPointer       = view.getUint32(abs(STATE.STRING_POINTER),        true);
  const codeStart           = view.getUint32(abs(STATE.CODE_BLOCK),            true);

  // Reconstruct region sizes from the offsets stored in STATE. Step ring
  // and header-event ring sizes are read directly (stepRingSize,
  // headerEventRingSize above) rather than back-derived from adjacent
  // offsets, since both regions are stored explicitly in STATE.
  const errorInfoSize       = scratchBase     - errorInfoBase;
  const scratchSize         = builtinsBase    - scratchBase;
  const builtinsSize        = astRegionBase   - builtinsBase;
  const stringTableSize     = segmentSize     - stringStart;

  // Layout v10: the context table is a heap object; its current size is
  // in its own GC header (size word includes the header, data excludes it).
  if (contextTablePointer < heapStart + GC_HEADER_SIZE ||
      contextTablePointer > heapPointer) {
    throw new Error(
      `readVatLayout: context table pointer ${contextTablePointer} is outside ` +
      `the active heap [${heapStart}, ${heapPointer})`);
  }
  const tableHeaderWord = view.getUint32(abs(contextTablePointer - GC_HEADER_SIZE), true);
  const contextTableSize = (tableHeaderWord & 0x00ffffff) - GC_HEADER_SIZE;
  const tableTotalSize = tableHeaderWord & 0x00ffffff;
  const tableType = (tableHeaderWord >>> 24) & 0x7f;
  if (tableType !== OBJ.STACK_BLOCK ||
      tableTotalSize < GC_HEADER_SIZE ||
      contextTablePointer - GC_HEADER_SIZE + tableTotalSize > heapPointer) {
    throw new Error('readVatLayout: malformed context table heap object');
  }

  return {
    byteLength: segmentSize,
    versions,
    regionOffsets: {
      stateBase: HEADER_SIZE,
      errorInfoBase,
      scratchBase,
      builtinsBase,
      astRegionBase,
      stepRingBase,
      headerEventRingBase,
      heapStart,
      heapEnd,
      stringStart,
      stringPointer,
      codeStart,
    },
    regionSizes: {
      errorInfo:       errorInfoSize,
      scratch:         scratchSize,
      builtins:        builtinsSize,
      astRegion:       astRegionSize,
      stepRing:        stepRingSize,
      headerEventRing: headerEventRingSize,
      stringTable:     stringTableSize,
    },
    contextTableSize,
  };
}

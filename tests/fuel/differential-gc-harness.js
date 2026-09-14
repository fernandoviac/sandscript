/**
 * Differential GC harness for the WAT collector.
 *
 * Runs a collector over a bytes-only copy of a vat segment, speaking
 * the stage-2 scratch-block I/O contract (roots in, forwarded roots +
 * handle-liveness bitmap out), and compares two sides byte-for-byte:
 * full segments unmasked, plus the two scratch-block outputs.
 *
 * Today both sides are the JS collector. That is not a placeholder
 * arrangement — it pins the premise the whole oracle design rests on:
 * a collection's result is a pure function of (segment bytes, roots),
 * with no hidden host state. When the WAT collect export lands, it
 * becomes side B and the same comparisons become the differential
 * oracle.
 *
 * Failure rule (from the error-reporting design): both-failed =
 * agreement (codes need not match); one-failed-one-succeeded =
 * divergence to investigate.
 */
import { MemoryImage } from '../../src/fuel/memory-image.js';
import { Collector } from '../../src/fuel/collector.js';
import { makeExternalSlotObserver } from '../../src/membrane/walker.js';
import { readVatLayout } from '../../src/fuel/vat-layout.js';
import { instantiateSync } from '../../src/fuel/interpreter.wasm.js';
import {
  computeGcScratchLayout,
  writeGcScratchBlock,
  writeGcScratchRoots,
  readGcScratchRoots,
} from '../../src/fuel/gc-scratch-layout.js';

function scratchLayoutFor(vatBytes, { handleTableCapacity, roots }) {
  const vatLayout = readVatLayout(vatBytes, 0);
  return computeGcScratchLayout({
    stringTableSize: vatLayout.regionSizes.stringTable,
    astRegionSize: vatLayout.regionSizes.astRegion,
    handleTableCapacity,
    rootCapacity: Math.max(roots.length, 16),
  });
}

function decodeHandleBitmap(scratchBytes, layout) {
  const { handleBitmap } = layout.sections;
  const slots = new Set();
  for (let slot = 0; slot < handleBitmap.capacity; slot++) {
    if ((scratchBytes[handleBitmap.offset + (slot >> 3)] >> (slot & 7)) & 1) {
      slots.add(slot);
    }
  }
  return slots;
}

/**
 * JS mark-only side: collector.markPhase() over a bytes-only copy
 * (exactly what collectLiveHandleSlots runs), with the string-mark
 * bitmap and handle bitmap materialized into the scratch block for
 * byte comparison. Mark bits are left set in the segment — that IS
 * the mark-set output.
 */
export function runJsMarkOnlySide(vatBytes, options = {}) {
  const { roots = [], handleTableCapacity = 1024 } = options;
  const segment = vatBytes.slice();
  const mem = new MemoryImage({ buffer: segment.buffer }, 0, segment.byteLength);

  const layout = scratchLayoutFor(vatBytes, { handleTableCapacity, roots });
  const scratch = new ArrayBuffer(layout.byteLength);
  writeGcScratchBlock(scratch, 0, layout);
  writeGcScratchRoots(scratch, 0, layout, roots);

  const collector = new Collector(mem);
  const liveHandleSlots = new Set();
  collector.valueObserver = makeExternalSlotObserver(liveHandleSlots);
  collector.externalRoots = readGcScratchRoots(scratch, 0, layout);
  let error = null;
  try {
    collector.markPhase();
  } catch (markError) {
    error = markError;
  } finally {
    collector.valueObserver = null;
    collector.externalRoots = [];
  }

  const scratchBytes = new Uint8Array(scratch);
  if (error === null) {
    // Materialize the JS side's host-side structures into the block's
    // sections so the comparison is byte-wise on both sides.
    if (collector.stringMarks.length !== layout.sections.stringMarkBitmap.size) {
      throw new Error(
        `string-mark bitmap size mismatch: JS ${collector.stringMarks.length} ` +
        `vs scratch section ${layout.sections.stringMarkBitmap.size}`);
    }
    scratchBytes.set(collector.stringMarks, layout.sections.stringMarkBitmap.offset);
    for (const slot of liveHandleSlots) {
      if (slot >= handleTableCapacity) {
        throw new Error(
          `runJsMarkOnlySide: live handle slot ${slot} exceeds capacity ${handleTableCapacity}`);
      }
      scratchBytes[layout.sections.handleBitmap.offset + (slot >> 3)] |= 1 << (slot & 7);
    }
  }

  return { segment, scratch: scratchBytes, layout, error, liveHandleSlots };
}

/**
 * WAT side: the gc_collect export over a fresh WebAssembly.Memory
 * holding the segment at 0 and the scratch block right after it —
 * the production shape. mode 1 = mark-only, mode 0 = full collection.
 */
function runWatSide(vatBytes, mode, options = {}) {
  const { roots = [], handleTableCapacity = 1024 } = options;
  const layout = scratchLayoutFor(vatBytes, { handleTableCapacity, roots });

  const scratchBase = (vatBytes.byteLength + 7) & ~7;
  const totalBytes = scratchBase + layout.byteLength;
  const pages = Math.ceil(totalBytes / 65536);
  const memory = new WebAssembly.Memory({ initial: pages, maximum: 16384, shared: true });
  new Uint8Array(memory.buffer).set(vatBytes, 0);

  const wasm = instantiateSync(memory);
  wasm.exports.init_regions();

  writeGcScratchBlock(memory.buffer, scratchBase, layout);
  writeGcScratchRoots(memory.buffer, scratchBase, layout, roots);

  let status = null;
  let error = null;
  try {
    status = wasm.exports.gc_collect(scratchBase, mode);
  } catch (trapError) {
    error = trapError;
  }

  const memBytes = new Uint8Array(memory.buffer);
  const segment = memBytes.slice(0, vatBytes.byteLength);
  const scratch = memBytes.slice(scratchBase, scratchBase + layout.byteLength);
  return {
    segment, scratch, layout, status, error,
    liveHandleSlots: decodeHandleBitmap(scratch, layout),
    forwardedRoots: error === null ? readGcScratchRoots(scratch.buffer, scratch.byteOffset, layout) : null,
  };
}

export function runWatMarkOnlySide(vatBytes, options = {}) {
  return runWatSide(vatBytes, 1, options);
}

export function runWatCollectorSide(vatBytes, options = {}) {
  return runWatSide(vatBytes, 0, options);
}

/**
 * Run one collector side: fresh copies of the segment and a freshly
 * written scratch block, roots read FROM the block, outputs written
 * BACK to it.
 *
 * @param {Uint8Array} vatBytes - the segment to collect (not mutated)
 * @param {object} [options]
 * @param {number[]} [options.roots] - external root HEADER pointers
 * @param {number} [options.handleTableCapacity=1024]
 * @returns {{ segment: Uint8Array, scratch: Uint8Array, layout: object,
 *             stats: object|null, error: Error|null,
 *             liveHandleSlots: Set<number>, forwardedRoots: number[]|null }}
 */
export function runJsCollectorSide(vatBytes, options = {}) {
  const { roots = [], handleTableCapacity = 1024 } = options;

  const segment = vatBytes.slice();
  const mem = new MemoryImage({ buffer: segment.buffer }, 0, segment.byteLength);

  // The scratch block. A separate buffer here; in the WAT it is the
  // same linear memory past the segment — the interior contract is
  // identical either way.
  const vatLayout = readVatLayout(vatBytes, 0);
  const layout = computeGcScratchLayout({
    stringTableSize: vatLayout.regionSizes.stringTable,
    astRegionSize: vatLayout.regionSizes.astRegion,
    handleTableCapacity,
    rootCapacity: Math.max(roots.length, 16),
  });
  const scratch = new ArrayBuffer(layout.byteLength);
  writeGcScratchBlock(scratch, 0, layout);
  writeGcScratchRoots(scratch, 0, layout, roots);

  const collector = new Collector(mem);
  const liveHandleSlots = new Set();
  collector.valueObserver = makeExternalSlotObserver(liveHandleSlots);

  const blockRoots = readGcScratchRoots(scratch, 0, layout);
  let stats = null;
  let error = null;
  try {
    stats = collector.collect(blockRoots);
  } catch (collectError) {
    error = collectError;
  } finally {
    collector.valueObserver = null;
  }

  let forwardedRoots = null;
  if (error === null) {
    // Write the outputs back the way the WAT does in place: forwarded
    // root addresses into the root block, live handle slots into the
    // handle bitmap.
    forwardedRoots = blockRoots.map(
      (root) => stats.forwarding.get(root) ?? root);
    writeGcScratchRoots(scratch, 0, layout, forwardedRoots);

    const scratchBytes = new Uint8Array(scratch);
    for (const slot of liveHandleSlots) {
      if (slot >= handleTableCapacity) {
        throw new Error(
          `runJsCollectorSide: live handle slot ${slot} exceeds the bitmap ` +
          `capacity ${handleTableCapacity} (GC_ERR_HANDLE_SLOT_RANGE class)`);
      }
      scratchBytes[layout.sections.handleBitmap.offset + (slot >> 3)] |= 1 << (slot & 7);
    }
  }

  return {
    segment,
    scratch: new Uint8Array(scratch),
    layout,
    stats,
    error,
    liveHandleSlots,
    forwardedRoots,
  };
}

/**
 * Byte comparison with a usable report.
 *
 * @returns {{ equal: boolean, diffCount: number,
 *             firstDiffs: Array<{offset:number, a:number, b:number}> }}
 */
export function compareBytes(bytesA, bytesB, { maxReported = 8 } = {}) {
  if (bytesA.byteLength !== bytesB.byteLength) {
    return {
      equal: false,
      diffCount: -1,
      firstDiffs: [{ offset: -1, a: bytesA.byteLength, b: bytesB.byteLength }],
    };
  }
  const firstDiffs = [];
  let diffCount = 0;
  for (let i = 0; i < bytesA.byteLength; i++) {
    if (bytesA[i] !== bytesB[i]) {
      diffCount++;
      if (firstDiffs.length < maxReported) {
        firstDiffs.push({ offset: i, a: bytesA[i], b: bytesB[i] });
      }
    }
  }
  return { equal: diffCount === 0, diffCount, firstDiffs };
}

/**
 * Compare two collector sides under the differential rules: full
 * segments unmasked, root blocks, handle bitmaps; both-failed counts
 * as agreement.
 *
 * @returns {{ agreement: boolean, reason: string, segments: object|null,
 *             rootBlocks: object|null, handleBitmaps: object|null }}
 */
export function compareSides(sideA, sideB) {
  if (sideA.error !== null && sideB.error !== null) {
    return { agreement: true, reason: 'both-failed', segments: null, rootBlocks: null, handleBitmaps: null };
  }
  if ((sideA.error === null) !== (sideB.error === null)) {
    return {
      agreement: false,
      reason: `one-failed: A ${sideA.error?.message ?? 'ok'} / B ${sideB.error?.message ?? 'ok'}`,
      segments: null, rootBlocks: null, handleBitmaps: null,
    };
  }

  const segments = compareBytes(sideA.segment, sideB.segment);
  const sliceSection = (side, name) => side.scratch.subarray(
    side.layout.sections[name].offset,
    side.layout.sections[name].offset + side.layout.sections[name].size);
  const rootBlocks = compareBytes(sliceSection(sideA, 'rootBlock'), sliceSection(sideB, 'rootBlock'));
  const handleBitmaps = compareBytes(sliceSection(sideA, 'handleBitmap'), sliceSection(sideB, 'handleBitmap'));

  const agreement = segments.equal && rootBlocks.equal && handleBitmaps.equal;
  return {
    agreement,
    reason: agreement ? 'byte-equal' : 'diverged',
    segments,
    rootBlocks,
    handleBitmaps,
  };
}

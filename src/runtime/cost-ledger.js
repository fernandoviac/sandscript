/**
 * Cost ledger — a SAB-backed ring of consumption events carved out of
 * the membrane SAB (membrane format v14 and later).
 * This module is pure SAB plumbing and does no allocation beyond the
 * bounded output page. It is the ONE low-level bounded validated
 * decoder for the cost-ledger binary format
 * (docs/ring-publication-contract.md); the WRITER lives in the
 * membrane (`appendCostEntry`) because the airlock is the membrane's
 * sole writer. The read view is split out so any holder of the raw
 * membrane SAB — notably an embedder reading `refs.membraneSAB`
 * across a worker boundary — can read the ledger without a live Membrane
 * object.
 *
 * The binary contract — entry size, field offsets, kinds — lives in the
 * membrane module (the lower layer that owns the bytes). This module
 * re-exports the entry layout for convenience.
 *
 * Publication discipline (shared ring contract): generation zero is
 * the wrap-transition seqlock, after which the head is reset and the
 * successor nonzero generation is published. The boundary diagnostic
 * is dropped. Ordinary publication advances the head BEFORE the slot is
 * touched; each entry's SEQ_LO is the atomically-published exact 1-based
 * entry index. Reads load generation before the head and again after
 * decoding, validate tokens around every payload, and return only the
 * oldest bounded validated prefix.
 */

import { COST_LEDGER_ENTRY, COST_LEDGER_ENTRY_SIZE } from '../membrane/index.js';
import {
  readPublishedRange,
  RING_READ_STATUS,
  RING_READ_TRUNCATION,
} from '../ring-publication.js';

export { COST_LEDGER_ENTRY, COST_LEDGER_ENTRY_SIZE };
export { RING_READ_STATUS, RING_READ_TRUNCATION };

/**
 * createCostLedgerView({ buffer, byteOffset, capacity, writeIndex,
 *   segmentGeneration, flags, reservationHeadByteOffset,
 *   segmentGenerationByteOffset, flagsByteOffset }) → CostLedgerReader
 *
 * Binds views to the ring region and returns a reader. Quiescent bytes
 * supply `writeIndex`, `segmentGeneration`, and `flags`. Live readers
 * instead supply the three absolute byte offsets so each readRange call
 * atomically loads generation before the reservation head and validates
 * generation and flags again after decoding. `capacity` must be a power
 * of two; offsets must be 4-byte aligned.
 *
 * @param {SharedArrayBuffer | ArrayBuffer} buffer
 * @param {number} byteOffset — absolute ring-region byte offset
 * @param {number} capacity — entry count (power of two)
 * @param {number} [writeIndex] — quiescent reservation-head snapshot
 * @param {number} [segmentGeneration] — quiescent generation snapshot
 * @param {number} [flags] — quiescent ring-flags snapshot
 * @param {number} [reservationHeadByteOffset] — live head byte offset
 * @param {number} [segmentGenerationByteOffset] — live generation byte offset
 * @param {number} [flagsByteOffset] — live flags byte offset
 */
export function createCostLedgerView({
  buffer,
  byteOffset,
  capacity,
  writeIndex,
  segmentGeneration,
  flags,
  reservationHeadByteOffset,
  segmentGenerationByteOffset,
  flagsByteOffset,
}) {
  if (capacity <= 0 || (capacity & (capacity - 1)) !== 0) {
    throw new Error(
      `runtime/cost-ledger: capacity must be a power of two (got ${capacity})`);
  }
  const base = byteOffset >>> 0;
  if ((base & 3) !== 0) {
    throw new Error(
      `runtime/cost-ledger: byteOffset must be 4-byte aligned for atomic ` +
      `token loads (got ${base})`);
  }

  const liveOffsets = [
    reservationHeadByteOffset,
    segmentGenerationByteOffset,
    flagsByteOffset,
  ];
  const live = liveOffsets.every((offset) => offset !== undefined);
  if (!live && liveOffsets.some((offset) => offset !== undefined)) {
    throw new Error(
      'runtime/cost-ledger: live reads require reservationHeadByteOffset, ' +
      'segmentGenerationByteOffset, and flagsByteOffset together');
  }
  if (!live &&
      (writeIndex === undefined || segmentGeneration === undefined || flags === undefined)) {
    throw new Error(
      'runtime/cost-ledger: pass writeIndex, segmentGeneration, and flags ' +
      'for snapshot bytes, or all three live header offsets');
  }

  let loadReservationHead;
  let loadSegmentGeneration;
  let loadFlags;
  if (live) {
    for (const [name, offset] of [
      ['reservationHeadByteOffset', reservationHeadByteOffset],
      ['segmentGenerationByteOffset', segmentGenerationByteOffset],
      ['flagsByteOffset', flagsByteOffset],
    ]) {
      if (((offset >>> 0) & 3) !== 0) {
        throw new Error(
          `runtime/cost-ledger: ${name} must be 4-byte aligned (got ${offset >>> 0})`);
      }
    }
    const headWords = new Uint32Array(buffer, reservationHeadByteOffset >>> 0, 1);
    const generationWords = new Uint32Array(buffer, segmentGenerationByteOffset >>> 0, 1);
    const flagWords = new Uint32Array(buffer, flagsByteOffset >>> 0, 1);
    loadReservationHead = () => Atomics.load(headWords, 0) >>> 0;
    loadSegmentGeneration = () => Atomics.load(generationWords, 0) >>> 0;
    loadFlags = () => Atomics.load(flagWords, 0) >>> 0;
  } else {
    loadReservationHead = () => writeIndex >>> 0;
    loadSegmentGeneration = () => segmentGeneration >>> 0;
    loadFlags = () => flags >>> 0;
  }

  const regionBytes = capacity * COST_LEDGER_ENTRY_SIZE;
  const words = new Uint32Array(buffer, base, regionBytes >>> 2);
  const wordsPerEntry = COST_LEDGER_ENTRY_SIZE >>> 2;
  const loadPublicationToken = (slot) =>
    Atomics.load(words, slot * wordsPerEntry + (COST_LEDGER_ENTRY.SEQ_LO >>> 2)) >>> 0;

  function decodeEntry(slot) {
    const wordBase = slot * wordsPerEntry;
    const u32 = (byteOffsetInEntry) =>
      Atomics.load(words, wordBase + (byteOffsetInEntry >>> 2)) >>> 0;
    const u64 = (byteOffsetInEntry) =>
      (BigInt(u32(byteOffsetInEntry + 4)) << 32n) | BigInt(u32(byteOffsetInEntry));
    return {
      tick:      (BigInt(u32(COST_LEDGER_ENTRY.TICK_HI)) << 32n)
                 | BigInt(u32(COST_LEDGER_ENTRY.TICK_LO)),
      kind:      u32(COST_LEDGER_ENTRY.KIND),
      slot:      u32(COST_LEDGER_ENTRY.SLOT),
      fuel:      u64(COST_LEDGER_ENTRY.FUEL),
      wallNanos: u64(COST_LEDGER_ENTRY.WALL_NANOS),
      bytesIn:   u64(COST_LEDGER_ENTRY.BYTES_IN),
      bytesOut:  u64(COST_LEDGER_ENTRY.BYTES_OUT),
      calls:     u64(COST_LEDGER_ENTRY.CALLS),
      cpuNanos:  u64(COST_LEDGER_ENTRY.CPU_NANOS),
      bytesHeld: u64(COST_LEDGER_ENTRY.BYTES_HELD),
      ext0:      u64(COST_LEDGER_ENTRY.EXT0),
      ext1:      u64(COST_LEDGER_ENTRY.EXT1),
    };
  }

  function readRange({
    afterIndex = 0,
    expectedSegmentGeneration,
    maximumEntries = capacity,
    maximumBytes = regionBytes,
  } = {}) {
    // Generation is deliberately loaded before the reservation head.
    const observedGeneration = loadSegmentGeneration();
    const observedFlags = loadFlags();
    const observedHead = loadReservationHead();
    return readPublishedRange({
      capacity,
      reservationHead: observedHead,
      segmentGeneration: observedGeneration,
      expectedSegmentGeneration,
      flags: observedFlags,
      afterIndex,
      maximumEntries,
      maximumBytes,
      entrySize: COST_LEDGER_ENTRY_SIZE,
      loadPublicationToken,
      decodeEntry,
      loadReservationHead,
      loadSegmentGeneration,
      loadFlags,
    });
  }

  function walk(sinceWriteIndex = 0, expectedSegmentGeneration) {
    const page = readRange({
      afterIndex: sinceWriteIndex,
      expectedSegmentGeneration,
    });
    for (const entry of page.entries) entry.seq = entry.index;
    return page.entries;
  }

  return {
    get writeIndex() {
      return loadReservationHead();
    },
    get segmentGeneration() {
      return loadSegmentGeneration();
    },
    get flags() {
      return loadFlags();
    },
    readRange,
    walk,
  };
}

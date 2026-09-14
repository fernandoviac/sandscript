/**
 * Instruction-step ring — the per-instruction binary event ring written
 * by the WAT interpreter inside the dispatch loop ($step_ring_write,
 * per the atomic ring publication contract
 * (docs/ring-publication-contract.md, layout v26): 40-byte naturally
 * aligned entries led by the u32 publication token and an explicit
 * cursor-segment generation in the ring header.
 *
 * readStepRingRange is the one bounded validated decoder for this
 * binary format; readStepRing keeps the historical whole-window
 * { entries, writeHead, capacity } shape for same-realm diagnostics.
 */
import {
  STEP_RING_HEADER_SIZE,
  STEP_RING_ENTRY_SIZE,
  STEP_RING_FORMAT_VERSION,
  STEP_RING,
  STEP_RING_ENTRY,
  STATE,
  opcodeToString,
} from './constants.js';
import {
  readPublishedRange,
  RING_READ_STATUS,
} from '../ring-publication.js';

const WORDS_PER_ENTRY = STEP_RING_ENTRY_SIZE >>> 2;
const TOKEN_WORD = STEP_RING_ENTRY.TOKEN >>> 2;

function ringGeometry(view, baseOffset) {
  const ringBase = view.getUint32(baseOffset + STATE.STEP_RING_BASE, true);
  const ringSize = view.getUint32(baseOffset + STATE.STEP_RING_SIZE, true);
  if (ringSize === 0) return null;

  const absoluteBase = view.byteOffset + baseOffset + ringBase;
  if ((absoluteBase & 3) !== 0) {
    throw new Error(
      `step ring: base must be 4-byte aligned for atomic publication; ` +
      `got absolute ${absoluteBase}`);
  }
  return {
    capacity: Math.floor((ringSize - STEP_RING_HEADER_SIZE) / STEP_RING_ENTRY_SIZE),
    words: new Uint32Array(view.buffer, 0, view.buffer.byteLength >>> 2),
    baseWord: absoluteBase >>> 2,
    headerWords: STEP_RING_HEADER_SIZE >>> 2,
  };
}

function decodeEntryFromWords(geometry, slot) {
  const wordBase = geometry.baseWord + geometry.headerWords + slot * WORDS_PER_ENTRY;
  // Atomic payload loads keep every read ordered between the shared
  // reader's two token validations (the JS memory model has no fence).
  const u32 = (byteOffsetInEntry) =>
    Atomics.load(geometry.words, wordBase + (byteOffsetInEntry >>> 2)) >>> 0;
  const opcodeAndPending = u32(STEP_RING_ENTRY.OPCODE);
  const callAndTry = u32(STEP_RING_ENTRY.CALL_DEPTH);
  const grantSlotStatus = u32(STEP_RING_ENTRY.GRANT_DEPTH);
  const errorAndCompletion = u32(STEP_RING_ENTRY.ERROR_CODE);
  const opcode = opcodeAndPending & 0xFFFF;
  return {
    slot:             (grantSlotStatus >>> 16) & 0xFF,
    instructionIndex: u32(STEP_RING_ENTRY.INSTRUCTION_INDEX),
    opcode,
    opcodeName:       opcodeToString(opcode),
    status:           (grantSlotStatus >>> 24) & 0xFF,
    errorCode:        errorAndCompletion & 0xFF,
    completionType:   (errorAndCompletion >>> 8) & 0xFF,
    pendingDepth:     opcodeAndPending >>> 16,
    callDepth:        callAndTry & 0xFFFF,
    scopePointer:     u32(STEP_RING_ENTRY.SCOPE_POINTER),
    tryDepth:         callAndTry >>> 16,
    grantDepth:       grantSlotStatus & 0xFFFF,
    heapPointer:      u32(STEP_RING_ENTRY.HEAP_POINTER),
    stringPointer:    u32(STEP_RING_ENTRY.STRING_POINTER),
  };
}

/**
 * Bounded validated oldest-first range read — the one low-level
 * decoder for the step-ring binary format. Never pauses or waits for
 * the interpreter: a page the writer laps returns a shorter validated
 * prefix with a typed overrun/raced truncation.
 */
export function readStepRingRange(view, baseOffset, {
  afterIndex = 0,
  expectedSegmentGeneration,
  maximumEntries = Number.MAX_SAFE_INTEGER,
  maximumBytes = Number.MAX_SAFE_INTEGER,
} = {}) {
  const geometry = ringGeometry(view, baseOffset);
  if (geometry === null) {
    return {
      status: RING_READ_STATUS.NOT_ENABLED,
      segmentGeneration: 0,
      capacity: 0, reservationHead: 0, newestCommitted: 0, oldestAvailable: 0,
      gap: null, entries: [], truncation: null,
    };
  }
  if (geometry.capacity <= 0) {
    // The region declares a nonzero size too small for even one entry.
    return {
      status: RING_READ_STATUS.MALFORMED,
      segmentGeneration: 0,
      capacity: 0, reservationHead: 0, newestCommitted: 0, oldestAvailable: 0,
      gap: null, entries: [], truncation: null,
    };
  }
  const declaredVersion =
    Atomics.load(geometry.words, geometry.baseWord + (STEP_RING.FORMAT_VERSION >>> 2)) >>> 0;
  if (declaredVersion !== STEP_RING_FORMAT_VERSION) {
    return {
      status: RING_READ_STATUS.UNSUPPORTED_VERSION,
      declaredVersion,
      segmentGeneration: 0,
      capacity: geometry.capacity, reservationHead: 0, newestCommitted: 0,
      oldestAvailable: 0, gap: null, entries: [], truncation: null,
    };
  }

  const loadSegmentGeneration = () =>
    Atomics.load(geometry.words,
      geometry.baseWord + (STEP_RING.SEGMENT_GENERATION >>> 2)) >>> 0;
  const loadFlags = () =>
    Atomics.load(geometry.words,
      geometry.baseWord + (STEP_RING.FLAGS >>> 2)) >>> 0;
  // Required ordering: generation before reservation head.
  const segmentGeneration = loadSegmentGeneration();
  const flags = loadFlags();
  const reservationHead =
    Atomics.load(geometry.words,
      geometry.baseWord + (STEP_RING.WRITE_HEAD >>> 2)) >>> 0;
  return readPublishedRange({
    capacity: geometry.capacity,
    reservationHead,
    segmentGeneration,
    expectedSegmentGeneration,
    flags,
    afterIndex,
    maximumEntries: Math.min(maximumEntries, geometry.capacity + 1),
    maximumBytes: Math.min(maximumBytes, (geometry.capacity + 1) * STEP_RING_ENTRY_SIZE),
    entrySize: STEP_RING_ENTRY_SIZE,
    loadPublicationToken: (slot) =>
      Atomics.load(geometry.words,
        geometry.baseWord + geometry.headerWords + slot * WORDS_PER_ENTRY + TOKEN_WORD) >>> 0,
    decodeEntry: (slot) => decodeEntryFromWords(geometry, slot),
    loadReservationHead: () =>
      Atomics.load(geometry.words,
        geometry.baseWord + (STEP_RING.WRITE_HEAD >>> 2)) >>> 0,
    loadSegmentGeneration,
    loadFlags,
  });
}

/**
 * Same-realm whole-window convenience over readStepRingRange, keeping
 * the historical { entries, writeHead, capacity } shape expected by
 * diagnostic consumers. An unallocated ring reads as empty so optional
 * diagnostics can query it before ring storage is provisioned.
 */
export function readStepRing(view, baseOffset) {
  const page = readStepRingRange(view, baseOffset);
  return {
    entries: page.entries,
    writeHead: page.reservationHead,
    capacity: page.capacity,
  };
}

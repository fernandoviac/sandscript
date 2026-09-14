/**
 * Header-event ring — records writes to global STATE.* fields and
 * GC-cycle boundaries, published per the atomic ring publication contract
 * (docs/ring-publication-contract.md, layout v26).
 *
 * JavaScript and WebAssembly writers publish byte-identical entries.
 * A wrap uses generation zero as a reader-invalid transition seqlock,
 * resets the head, publishes the successor generation, and drops that
 * diagnostic event; terminal exhaustion sets the ring flag and drops
 * future diagnostic events without blocking runtime execution. Ordinary
 * publication reserves the head, invalidates the token, stores payload
 */
import {
  HEADER_EVENT_RING_HEADER_SIZE,
  HEADER_EVENT_RING_ENTRY_SIZE,
  HEADER_EVENT_RING_FORMAT_VERSION,
  HEADER_EVENT_RING,
  HEADER_EVENT_RING_ENTRY,
  HEADER_EVENT_KIND,
  HEADER_EVENT_PARKED_BITMAP_BITS,
  RING_FLAG_SEGMENT_SPACE_EXHAUSTED,
  HEADER_EVENT_SITE,
  STATE,
  CONTEXT_STATUS_FREE,
  EXIT_DONE,
  EXIT_ERROR,
  headerEventFieldToString,
  headerEventSiteToString,
} from './constants.js';
import {
  readPublishedRange,
  RING_READ_STATUS,
} from '../ring-publication.js';

const HEADER_EVENT_KIND_NAMES = Object.fromEntries(
  Object.entries(HEADER_EVENT_KIND).map(([name, code]) => [code, name])
);

function headerEventKindToString(code) {
  return HEADER_EVENT_KIND_NAMES[code] ?? `KIND_${code}`;
}

const WORDS_PER_ENTRY = HEADER_EVENT_RING_ENTRY_SIZE >>> 2;
const TOKEN_WORD = HEADER_EVENT_RING_ENTRY.ENTRY_INDEX >>> 2;

/**
 * Ring geometry from STATE, plus the u32 word view atomic accesses
 * run through. Returns null when the ring is not enabled (size 0).
 * The absolute word index of the ring base is `baseWord`; entry N's
 * words start at `baseWord + headerWords + slot * WORDS_PER_ENTRY`.
 */
function ringGeometry(view, baseOffset) {
  const ringBase = view.getUint32(baseOffset + STATE.HEADER_EVENT_RING_BASE, true);
  const ringSize = view.getUint32(baseOffset + STATE.HEADER_EVENT_RING_SIZE, true);
  if (ringSize === 0) return null;

  const absoluteBase = view.byteOffset + baseOffset + ringBase;
  if ((absoluteBase & 3) !== 0) {
    throw new Error(
      `header-event ring: base must be 4-byte aligned for atomic ` +
      `publication; got absolute ${absoluteBase}`);
  }
  const capacity = Math.floor((ringSize - HEADER_EVENT_RING_HEADER_SIZE) / HEADER_EVENT_RING_ENTRY_SIZE);
  return {
    capacity,
    words: new Uint32Array(view.buffer, 0, view.buffer.byteLength >>> 2),
    baseWord: absoluteBase >>> 2,
    headerWords: HEADER_EVENT_RING_HEADER_SIZE >>> 2,
  };
}

function decodeEntryFromWords(geometry, slot) {
  const wordBase = geometry.baseWord + geometry.headerWords + slot * WORDS_PER_ENTRY;
  // Atomic payload loads: a plain load may sink past the shared
  // reader's post-decode token validation (see the ring publication
  // contract), so every payload word goes through Atomics.load.
  const packed = Atomics.load(geometry.words, wordBase) >>> 0;
  const kind = packed & 0xFF;
  const field = (packed >>> 8) & 0xFF;
  const site = (packed >>> 16) & 0xFF;
  const slotByte = (packed >>> 24) & 0xFF;
  const oldValue = Atomics.load(geometry.words, wordBase + 1) >>> 0;
  const newValue = Atomics.load(geometry.words, wordBase + 2) >>> 0;
  const entry = {
    kind,
    kindName:   headerEventKindToString(kind),
    field,
    fieldName:  headerEventFieldToString(field),
    site,
    siteName:   headerEventSiteToString(site),
    slot:       slotByte === 0xFF ? null : slotByte,
    oldValue,
    newValue,
  };
  if (kind === HEADER_EVENT_KIND.GC_CYCLE_PARKED_SLOTS) {
    // oldValue = total parked count observed; newValue = how many of
    // those fell past the inline bitmap's capacity (truncated, NOT
    // recorded below) — a reader must check this before treating
    // parkedSlots as exhaustive.
    entry.parkedCount = oldValue;
    entry.parkedTruncatedCount = newValue;
    entry.parkedSlots = [];
    const reservedWord = HEADER_EVENT_RING_ENTRY.RESERVED >>> 2;
    for (let word = 0; word < 4; word++) {
      const bits = Atomics.load(geometry.words, wordBase + reservedWord + word) >>> 0;
      if (bits === 0) continue;
      for (let bit = 0; bit < 32; bit++) {
        if ((bits >>> bit) & 1) entry.parkedSlots.push(word * 32 + bit);
      }
    }
  }
  return entry;
}

/**
 * Bounded validated oldest-first range read — the one low-level
 * decoder for this binary ring format. Returns the shared
 * ring-publication result shape; `not-enabled` when the region was
 * never allocated, `unsupported-version` (with the declared version)
 * when the ring predates or postdates this decoder's contract.
 */
export function readHeaderEventRingRange(view, baseOffset, {
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
    Atomics.load(geometry.words, geometry.baseWord + (HEADER_EVENT_RING.FORMAT_VERSION >>> 2)) >>> 0;
  if (declaredVersion !== HEADER_EVENT_RING_FORMAT_VERSION) {
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
      geometry.baseWord + (HEADER_EVENT_RING.SEGMENT_GENERATION >>> 2)) >>> 0;
  const loadFlags = () =>
    Atomics.load(geometry.words,
      geometry.baseWord + (HEADER_EVENT_RING.FLAGS >>> 2)) >>> 0;
  // Required ordering: generation before reservation head.
  const segmentGeneration = loadSegmentGeneration();
  const flags = loadFlags();
  const reservationHead =
    Atomics.load(geometry.words,
      geometry.baseWord + (HEADER_EVENT_RING.WRITE_HEAD >>> 2)) >>> 0;
  const bounded = Math.min(maximumEntries, geometry.capacity + 1);
  return readPublishedRange({
    capacity: geometry.capacity,
    reservationHead,
    segmentGeneration,
    expectedSegmentGeneration,
    flags,
    afterIndex,
    maximumEntries: bounded,
    maximumBytes: Math.min(maximumBytes, (geometry.capacity + 1) * HEADER_EVENT_RING_ENTRY_SIZE),
    entrySize: HEADER_EVENT_RING_ENTRY_SIZE,
    loadPublicationToken: (slot) =>
      Atomics.load(geometry.words,
        geometry.baseWord + geometry.headerWords + slot * WORDS_PER_ENTRY + TOKEN_WORD) >>> 0,
    decodeEntry: (slot) => decodeEntryFromWords(geometry, slot),
    loadReservationHead: () =>
      Atomics.load(geometry.words,
        geometry.baseWord + (HEADER_EVENT_RING.WRITE_HEAD >>> 2)) >>> 0,
    loadSegmentGeneration,
    loadFlags,
  });
}

/**
 * Same-realm whole-window convenience over readHeaderEventRingRange,
 * keeping the historical { entries, writeHead, capacity } shape expected
 * by diagnostic consumers. An unallocated ring reads as empty so optional
 * diagnostics can query it before ring storage is provisioned.
 */
export function readHeaderEventRing(view, baseOffset) {
  const page = readHeaderEventRingRange(view, baseOffset);
  return {
    entries: page.entries,
    writeHead: page.reservationHead,
    capacity: page.capacity,
  };
}

/**
 * The shared JS write path: reserve, invalidate, atomic payload,
 * publish. `packedWords` is the 7-word payload (entry bytes 0..27
 * except the token word at byte 12): [kindFieldSiteSlot, oldValue,
 * newValue, reserved0..reserved3].
 */
function publishEntry(geometry, packedWords) {
  const flagsWord = geometry.baseWord + (HEADER_EVENT_RING.FLAGS >>> 2);
  if ((Atomics.load(geometry.words, flagsWord) &
       RING_FLAG_SEGMENT_SPACE_EXHAUSTED) !== 0) return false;

  const headWord = geometry.baseWord + (HEADER_EVENT_RING.WRITE_HEAD >>> 2);
  const generationWord =
    geometry.baseWord + (HEADER_EVENT_RING.SEGMENT_GENERATION >>> 2);
  const writeHead = Atomics.load(geometry.words, headWord) >>> 0;
  if (writeHead === 0xffffffff) {
    const generation = Atomics.load(geometry.words, generationWord) >>> 0;
    if (generation === 0xffffffff) {
      Atomics.store(geometry.words, flagsWord,
        (Atomics.load(geometry.words, flagsWord) |
         RING_FLAG_SEGMENT_SPACE_EXHAUSTED) >>> 0);
      return false;
    }
    // Generation 0 is the transition seqlock. Readers reject every
    // observation until the head is reset and the successor generation
    // is visible. This event is dropped; token 0 is never published.
    Atomics.store(geometry.words, generationWord, 0);
    Atomics.store(geometry.words, headWord, 0);
    Atomics.store(
      geometry.words, generationWord, (generation + 1) >>> 0);
    return false;
  }
  const index = (writeHead + 1) >>> 0;
  const slot = writeHead % geometry.capacity;
  const wordBase = geometry.baseWord + geometry.headerWords + slot * WORDS_PER_ENTRY;
  Atomics.store(geometry.words, headWord, index);
  Atomics.store(geometry.words, wordBase + TOKEN_WORD, 0);

  Atomics.store(geometry.words, wordBase,     packedWords[0]);
  Atomics.store(geometry.words, wordBase + 1, packedWords[1]);
  Atomics.store(geometry.words, wordBase + 2, packedWords[2]);
  Atomics.store(geometry.words, wordBase + 4, packedWords[3]);
  Atomics.store(geometry.words, wordBase + 5, packedWords[4]);
  Atomics.store(geometry.words, wordBase + 6, packedWords[5]);
  Atomics.store(geometry.words, wordBase + 7, packedWords[6]);

  Atomics.store(geometry.words, wordBase + TOKEN_WORD, index);
  return true;
}

function packHeaderBytes(kind, field, site, slot) {
  return ((kind & 0xFF) | ((field & 0xFF) << 8) | ((site & 0xFF) << 16) | ((slot & 0xFF) << 24)) >>> 0;
}

// Writer for the JS-side call sites (collector.js's updateIntrinsics —
// the 'js'/'differential' GC path — and memory-image.js's
// _growContextTable / resizeSegment / allocateContext). The WAT
// interpreter writes its own ring entries directly from
// $header_event_ring_write; this is the JS-side twin, same entry
// layout and same publication protocol, so readers never need to know
// which side wrote an entry.
export function writeHeaderEventRingEntry(view, baseOffset, { kind, field = 0, site, slot = 0xFF, oldValue = 0, newValue = 0 }) {
  const geometry = ringGeometry(view, baseOffset);
  if (geometry === null || geometry.capacity === 0) return false;
  return publishEntry(geometry, [
    packHeaderBytes(kind, field, site, slot),
    oldValue >>> 0,
    newValue >>> 0,
    0, 0, 0, 0,
  ]);
}

// A context slot counts as "parked" for the snapshot if it's allocated
// (table entry non-zero, exit condition isn't CONTEXT_STATUS_FREE) and its
// exit condition isn't a terminal one (done/error) or the "never yielded
// yet" zero — matching Runtime.isTerminalDriveStatus's notion of
// non-terminal, at the exit-code level the collector already reads.
function isParkedExitCondition(exitCondition) {
  return exitCondition !== CONTEXT_STATUS_FREE
    && exitCondition !== 0
    && exitCondition !== EXIT_DONE
    && exitCondition !== EXIT_ERROR;
}

/**
 * Called immediately after a GC_CYCLE_START entry so the parked-slot
 * snapshot belongs to the same cycle boundary as the matching
 * GC_CYCLE_START/GC_CYCLE_END pair. Writes a GC_CYCLE_PARKED_SLOTS entry:
 * the inline bitmap (RESERVED bytes, one bit per slot index
 * 0..HEADER_EVENT_PARKED_BITMAP_BITS-1) plus oldValue=total parked count
 * and newValue=count truncated past the bitmap's capacity. A reader must
 * treat newValue > 0 as "this snapshot is incomplete," never silently
 * assume every parked slot is represented.
 *
 * @param {{getContextCount(): number, getContextBase(slot: number): number,
 *   getExitCondition(slot: number): number}} manipulator
 */
export function writeParkedSlotsSnapshotEntry(view, baseOffset, manipulator, { site = HEADER_EVENT_SITE.UNKNOWN } = {}) {
  const geometry = ringGeometry(view, baseOffset);
  if (geometry === null || geometry.capacity === 0) return;

  const contextCount = manipulator.getContextCount();
  let parkedCount = 0;
  let truncatedCount = 0;
  const bitmapWords = [0, 0, 0, 0];
  for (let slot = 0; slot < contextCount; slot++) {
    if (manipulator.getContextBase(slot) === 0) continue;
    if (!isParkedExitCondition(manipulator.getExitCondition(slot))) continue;
    parkedCount++;
    if (slot < HEADER_EVENT_PARKED_BITMAP_BITS) {
      bitmapWords[slot >>> 5] |= (1 << (slot & 31));
    } else {
      truncatedCount++;
    }
  }

  publishEntry(geometry, [
    packHeaderBytes(HEADER_EVENT_KIND.GC_CYCLE_PARKED_SLOTS, 0, site, 0xFF),
    parkedCount >>> 0,
    truncatedCount >>> 0,
    bitmapWords[0] >>> 0,
    bitmapWords[1] >>> 0,
    bitmapWords[2] >>> 0,
    bitmapWords[3] >>> 0,
  ]);
}

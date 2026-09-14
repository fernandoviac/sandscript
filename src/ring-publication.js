/**
 * Ring publication contract (docs/ring-publication-contract.md).
 *
 * SandScript's shared-memory event rings — the membrane cost ledger, the
 * vat header-event ring, and the vat instruction-step ring — are written
 * by exactly one producer thread each and read concurrently from other
 * realms over a SharedArrayBuffer. This module encodes the publication
 * protocol every adopted ring version follows and provides the one
 * shared bounded validated range reader the per-ring decoders build on.
 *
 * Protocol (per ring):
 *   1. The producer atomically advances a 32-bit reservation head BEFORE
 *      touching the reused slot.
 *   2. The producer atomically INVALIDATES the slot's publication token
 *      to the 0 sentinel. The previous lap's token equals exactly the
 *      index a slow reader still expects, so overwriting the payload
 *      under a still-valid token would let that reader accept a torn
 *      record (the seqlock "odd" state; proven necessary by the
 *      concurrent cost-ledger proof).
 *   3. The producer writes the complete payload with ATOMIC stores —
 *      JavaScript and WebAssembly have no store fences, and only
 *      sequentially-consistent atomics respect per-agent program order,
 *      which is what makes invalidate → payload → publish provable.
 *   4. The producer atomically publishes the slot's publication token:
 *      the exact 1-based entry index (u32).
 *   5. A reader atomically loads the token, requires exact equality with
 *      the expected index, decodes the payload with ATOMIC loads (a
 *      plain load may sink past the re-check), loads the token again,
 *      and requires exact equality again. Any mismatch rejects the
 *      record as raced or overwritten; it is never returned as coherent.
 *
 * Zero is the "never published" token sentinel a fresh region's
 * zero-init provides for free. The producer starts in nonzero segment
 * generation one. At the reservation-head boundary it stores generation
 * zero as a reader-invalid transition seqlock, resets the head to zero,
 * publishes the successor nonzero generation, and drops the boundary
 * diagnostic. Readers therefore cannot combine the old high head with
 * the successor generation. The successor accepts entries at index one;
 * no writer ever publishes token zero.
 *
 * Generation never aliases. A producer that reaches the next head wrap
 * while generation is 0xffffffff atomically sets the ring's
 * segment-space-exhausted flag and permanently stops publishing to that
 * ring. Runtime execution continues; readers report the typed terminal
 * source condition.
 *
 * Reads are bounded by entry count and encoded bytes, decode only
 * candidate slots in the requested page, page oldest-first, and never
 * retry a full snapshot until a hot writer becomes quiet.
 *
 * The reservation head is free-running modulo 2^32 within one explicit
 * segment generation. After a generation transition, head < capacity
 * identifies the successor segment's retained indexes 1..head; older
 * high-token slots are conservatively discarded and can never be
 * attached to the new generation.
 */

/** Fixture/contract schema version for cross-process and embedder consumers. */
export const RING_PUBLICATION_CONTRACT_VERSION = 2;

/** Overall result of a bounded ring read. */
export const RING_READ_STATUS = {
  OK: 'ok',
  /** The ring region was never allocated (capacity or size 0). */
  NOT_ENABLED: 'not-enabled',
  /** The ring declares a format version this decoder does not speak. */
  UNSUPPORTED_VERSION: 'unsupported-version',
  /** The ring generation differs from the caller's expected segment. */
  SEGMENT_CHANGED: 'segment-changed',
  /** No further entries can be published without generation aliasing. */
  SEGMENT_SPACE_EXHAUSTED: 'segment-space-exhausted',
  /** The requested cursor is ahead of the reservation head. */
  INVALID_CURSOR: 'invalid-cursor',
  /** Ring geometry is inconsistent (bad base, capacity, or bounds). */
  MALFORMED: 'malformed',
};

/** Why a returned page is shorter than the committed range. */
export const RING_READ_TRUNCATION = {
  /** maximumEntries was reached before newest committed. */
  ENTRY_LIMIT: 'entry-limit',
  /** maximumBytes was reached before newest committed. */
  BYTE_LIMIT: 'byte-limit',
  /** A slot's token changed between the pre- and post-decode loads. */
  RACED: 'raced',
  /** The writer lapped the requested page before it could be read. */
  OVERRUN: 'overrun',
};

/** Ring-header flag bits shared by every segment-aware ring. */
export const RING_FLAG_SEGMENT_SPACE_EXHAUSTED = 0x01;

/**
 * Bounded validated oldest-first range read over a published ring.
 *
 * The caller owns the memory geometry and passes two closures:
 *   - loadPublicationToken(slot) — an ATOMIC u32 load of the slot's
 *     publication token;
 *   - decodeEntry(slot, index) — ordinary payload decode returning the
 *     entry object (without its index; this reader attaches it).
 *
 * All index arithmetic is u32-window based so it stays correct across
 * 32-bit head wrap: distances from the reservation head are compared,
 * never raw index magnitudes.
 *
 * @param {object} options
 * @param {number} options.capacity — retained entry count (> 0).
 * @param {number} options.reservationHead — producer head (u32,
 *   free-running count of reserved entries; the newest reserved entry
 *   has 1-based index equal to this value).
 * @param {number} options.afterIndex — exclusive 1-based start cursor
 *   (u32). 0 reads from the oldest retained entry.
 * @param {number} options.maximumEntries — positive entry bound.
 * @param {number} options.maximumBytes — positive encoded-byte bound.
 * @param {number} options.entrySize — encoded bytes per entry.
 * @param {(slot: number) => number} options.loadPublicationToken
 * @param {(slot: number, index: number) => object} options.decodeEntry
 * @param {number} options.segmentGeneration — generation loaded before
 *   reservationHead.
 * @param {number} [options.expectedSegmentGeneration] — reject a
 *   different generation before pagination.
 * @param {(() => number)} options.loadSegmentGeneration — ATOMIC
 *   post-decode generation load.
 * @param {number} options.flags — ring flags loaded before reservationHead.
 * @param {(() => number)} options.loadFlags — ATOMIC post-decode flags load.
 * @param {(() => number)} [options.loadReservationHead] — ATOMIC live
 *   re-load of the reservation head, used only to disambiguate the
 *   newest-committed estimate under an in-flight overwrite. Omit for
 *   quiescent snapshot decoding.
 * @returns {{
 *   status: string,
 *   segmentGeneration: number,
 *   capacity: number,
 *   reservationHead: number,
 *   newestCommitted: number,
 *   oldestAvailable: number,
 *   gap: { firstMissingIndex: number, lastMissingIndex: number } | null,
 *   entries: object[],
 *   truncation: string | null,
 * }}
 */
export function readPublishedRange({
  capacity,
  reservationHead,
  segmentGeneration,
  expectedSegmentGeneration,
  flags,
  afterIndex,
  maximumEntries,
  maximumBytes,
  entrySize,
  loadPublicationToken,
  decodeEntry,
  loadReservationHead,
  loadSegmentGeneration,
  loadFlags,
}) {
  if (!Number.isSafeInteger(capacity) || capacity <= 0) {
    throw new TypeError(`readPublishedRange: capacity must be a positive integer, got ${capacity}`);
  }
  if (!Number.isSafeInteger(maximumEntries) || maximumEntries <= 0) {
    throw new TypeError(`readPublishedRange: maximumEntries must be a positive integer, got ${maximumEntries}`);
  }
  if (!Number.isSafeInteger(maximumBytes) || maximumBytes <= 0) {
    throw new TypeError(`readPublishedRange: maximumBytes must be a positive integer, got ${maximumBytes}`);
  }
  if (!Number.isSafeInteger(entrySize) || entrySize <= 0) {
    throw new TypeError(`readPublishedRange: entrySize must be a positive integer, got ${entrySize}`);
  }
  if (segmentGeneration === undefined || loadSegmentGeneration === undefined) {
    throw new TypeError(
      'readPublishedRange: segmentGeneration and loadSegmentGeneration are required');
  }
  if (flags === undefined || loadFlags === undefined) {
    throw new TypeError('readPublishedRange: flags and loadFlags are required');
  }

  const head = reservationHead >>> 0;
  const generation = segmentGeneration >>> 0;
  const initialFlags = flags >>> 0;
  const after = afterIndex >>> 0;
  const slotFor = (index) => ((index >>> 0) - 1) % capacity;

  const result = {
    status: RING_READ_STATUS.OK,
    segmentGeneration: generation,
    capacity,
    reservationHead: head,
    newestCommitted: 0,
    oldestAvailable: 0,
    gap: null,
    entries: [],
    truncation: null,
  };

  const rejectWholePage = (status) => {
    result.status = status;
    result.newestCommitted = 0;
    result.oldestAvailable = 0;
    result.gap = null;
    result.entries = [];
    result.truncation = null;
    return result;
  };
  const finish = () => {
    const finalGeneration = loadSegmentGeneration() >>> 0;
    const finalFlags = loadFlags() >>> 0;
    if (finalGeneration !== generation) {
      return rejectWholePage(RING_READ_STATUS.SEGMENT_CHANGED);
    }
    if ((finalFlags & RING_FLAG_SEGMENT_SPACE_EXHAUSTED) !== 0) {
      return rejectWholePage(RING_READ_STATUS.SEGMENT_SPACE_EXHAUSTED);
    }
    return result;
  };
  if (generation === 0) {
    return rejectWholePage(RING_READ_STATUS.MALFORMED);
  }

  if (expectedSegmentGeneration !== undefined &&
      (expectedSegmentGeneration >>> 0) !== generation) {
    return rejectWholePage(RING_READ_STATUS.SEGMENT_CHANGED);
  }
  if ((initialFlags & RING_FLAG_SEGMENT_SPACE_EXHAUSTED) !== 0) {
    return rejectWholePage(RING_READ_STATUS.SEGMENT_SPACE_EXHAUSTED);
  }

  // Newest committed: the single producer publishes token(index) before
  // reserving index+1, and both stores are atomic, so a reader that
  // observes reservation head H also observes token(H-1). At most the
  // newest reserved entry is still unpublished.
  //
  // One ambiguity needs care: token(slot(H)) can read as the 0 sentinel
  // either because H itself is mid-publication (H not committed → H-1)
  // or because the writer already reserved H+capacity and invalidated
  // the shared slot while our head load was slightly older (H WAS
  // committed → H). The two cases are separated by re-loading the head
  // AFTER the token load: the writer stores the new head before the
  // invalidation, so under sequentially-consistent atomics a re-load
  // that still returns H proves the sentinel belongs to H itself.
  // Without a live head loader the estimate stays conservative (H-1);
  // that only arises for quiescent snapshot decoding, where the
  // ambiguity cannot occur.
  if (head !== 0) {
    const newestToken = loadPublicationToken(slotFor(head));
    if (newestToken === head) {
      result.newestCommitted = head;
    } else if (newestToken !== 0 && ((newestToken - head) >>> 0) < 0x80000000) {
      // A newer lap already published in this slot: H is long committed
      // (its record is destroyed — a later page reports the overrun).
      result.newestCommitted = head;
    } else if (loadReservationHead !== undefined &&
               (loadReservationHead() >>> 0) !== head) {
      // Writer moved past H, so the sentinel/old token belongs to a
      // newer reservation; H itself was committed.
      result.newestCommitted = head;
    } else {
      result.newestCommitted = (head - 1) >>> 0;
    }
  }

  // Oldest still-retained reserved index (its slot has not been reused
  // by a newer reservation). u32 arithmetic: for head < capacity this is
  // index 1. Generation is loaded before the head, so after a native
  // wrap this deliberately excludes every prior-generation slot.
  const reservedCount = head === 0 ? 0 : Math.min(head, capacity);
  const oldestRetained = reservedCount === 0 ? 0 : (head - reservedCount + 1) >>> 0;
  result.oldestAvailable = result.newestCommitted === 0 ? 0 : oldestRetained;

  // Cursor position relative to the head, wrap-correct.
  const distanceBehindHead = (head - after) >>> 0;
  if (distanceBehindHead > 0x80000000) {
    result.status = RING_READ_STATUS.INVALID_CURSOR;
    return finish();
  }
  const distanceBehindCommitted = (result.newestCommitted - after) >>> 0;
  if (result.newestCommitted === 0 ||
      distanceBehindCommitted === 0 || distanceBehindCommitted > 0x80000000) {
    // Nothing committed after the cursor (empty ring, cursor at newest,
    // or cursor between newest committed and the reservation head).
    return finish();
  }

  // Exact ordinary-overwrite gap: the request precedes retained data.
  let startIndex = (after + 1) >>> 0;
  if (distanceBehindHead > reservedCount) {
    result.gap = {
      firstMissingIndex: startIndex,
      lastMissingIndex: (oldestRetained - 1) >>> 0,
    };
    startIndex = oldestRetained;
  }

  const entryBudget = Math.min(maximumEntries, Math.floor(maximumBytes / entrySize));
  if (entryBudget === 0) {
    result.truncation = RING_READ_TRUNCATION.BYTE_LIMIT;
    return finish();
  }

  let index = startIndex;
  for (;;) {
    const remaining = (result.newestCommitted - index + 1) >>> 0;
    if (remaining === 0 || remaining > 0x80000000) break;
    if (result.entries.length >= entryBudget) {
      result.truncation = maximumEntries <= entryBudget
        ? RING_READ_TRUNCATION.ENTRY_LIMIT
        : RING_READ_TRUNCATION.BYTE_LIMIT;
      break;
    }

    const slot = slotFor(index);
    const tokenBefore = loadPublicationToken(slot);
    if (tokenBefore !== index) {
      result.truncation = RING_READ_TRUNCATION.OVERRUN;
      break;
    }

    const entry = decodeEntry(slot, index);

    const tokenAfter = loadPublicationToken(slot);
    if (tokenAfter !== index) {
      result.truncation = RING_READ_TRUNCATION.RACED;
      break;
    }

    entry.index = index;
    result.entries.push(entry);
    index = (index + 1) >>> 0;
  }

  return finish();
}

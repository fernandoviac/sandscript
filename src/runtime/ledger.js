/**
 * In-flight ledger — a SAB-backed presence table of activities
 * currently in flight inside the runtime and its embedder.
 *
 * The ledger lives in a region carved out of the membrane SAB
 * (membrane format v5 and later); this module is pure SAB
 * plumbing and does no allocation. Callers obtain a view via
 * `createLedgerView({ buffer, byteOffset, capacity })`.
 *
 * The binary contract — entry size, capacity — lives in the
 * membrane module (the lower layer that owns the bytes). This
 * module re-exports those constants for runtime-layer
 * convenience.
 *
 * Binary layout (24 bytes per entry, six u32 fields, LE):
 *
 *   offset  field         meaning
 *   ------  ------------  --------------------------------------
 *   0x00    contextSlot   context slot the activity runs on
 *                         (a real slot id; not a sentinel —
 *                         slot 0 is the legitimate root context).
 *                         Embedders that have no associated slot
 *                         may use 0xFFFFFFFF by convention;
 *                         sandscript itself never writes that.
 *   0x04    activity      activity tag (0 = FREE, sync field)
 *   0x08    id1           activity-specific id #1
 *   0x0C    id2           activity-specific id #2
 *   0x10    callId        monotonic per-activity call id, or 0
 *   0x14    beganAtTick   performance.now() | 0 at claim time
 *
 * Synchronization discipline:
 *
 *   - `activity` is the sync field. Claim = atomic CAS 0 -> activity
 *     on the activity field; other fields are then Atomics.store'd
 *     after the CAS succeeds.
 *   - Free zeroes non-activity fields first, then Atomics.store
 *     activity = 0 last.
 *   - A racing walker either sees the entry as FREE (skips) or
 *     reads a real activity. Torn reads of id1/id2 may happen but
 *     always belong to *some* activity, never garbage from a
 *     different one, because activity flips last on both sides.
 *
 * Activity ranges:
 *
 *   - 0          — FREE
 *   - 1..63      — sandscript-internal activities (RESERVED)
 *   - 64..65535  — embedder-defined
 */

import {
  LEDGER_ENTRY_BYTES,
  LEDGER_ACTIVITY,
  LEDGER_ACTIVITY_RUNTIME_RESERVED_MAX,
  ledgerActivityName,
} from '../membrane/index.js';

export {
  LEDGER_ENTRY_BYTES,
  LEDGER_ACTIVITY,
  LEDGER_ACTIVITY_RUNTIME_RESERVED_MAX,
  ledgerActivityName,
};

export const LEDGER_FIELD = Object.freeze({
  CONTEXT_SLOT:   0x00,
  ACTIVITY:       0x04,
  ID_1:           0x08,
  ID_2:           0x0C,
  CALL_ID:        0x10,
  BEGAN_AT_TICK:  0x14,
});

/**
 * createLedgerView({ buffer, byteOffset, capacity }) → Ledger
 *
 * Binds an Int32Array view to the table region and returns
 * an object exposing claim/write/free/walk/rebind.
 *
 * @param {SharedArrayBuffer | ArrayBuffer} buffer
 * @param {number} byteOffset   — absolute byte offset within `buffer`
 * @param {number} capacity     — number of entries (each LEDGER_ENTRY_BYTES bytes)
 */
export function createLedgerView({ buffer, byteOffset, capacity }) {
  if (capacity <= 0) {
    throw new Error(
      `runtime/ledger: capacity must be > 0 (got ${capacity})`);
  }
  let baseOffset = byteOffset >>> 0;
  let view = new Int32Array(
    buffer, baseOffset, capacity * (LEDGER_ENTRY_BYTES / 4));

  function fieldIndex(entryIndex, fieldOffset) {
    return entryIndex * (LEDGER_ENTRY_BYTES / 4) + (fieldOffset / 4);
  }

  /**
   * Atomically reserve the next FREE entry and write all fields.
   *
   * @param {Object} fields
   * @param {number} fields.contextSlot
   * @param {number} fields.activity     — must be non-zero
   * @param {number} [fields.id1]
   * @param {number} [fields.id2]
   * @param {number} [fields.callId]
   * @param {number} [fields.beganAtTick]
   * @returns {number} entry index, or -1 if the table is full
   */
  function claim(fields) {
    const activity = fields.activity | 0;
    if (activity === 0) {
      throw new Error(
        'runtime/ledger: claim() with activity=0 (FREE) is invalid');
    }
    for (let i = 0; i < capacity; i++) {
      const activityIdx = fieldIndex(i, LEDGER_FIELD.ACTIVITY);
      const prev = Atomics.compareExchange(view, activityIdx, 0, activity);
      if (prev === 0) {
        Atomics.store(view, fieldIndex(i, LEDGER_FIELD.CONTEXT_SLOT),
          (fields.contextSlot ?? 0) | 0);
        Atomics.store(view, fieldIndex(i, LEDGER_FIELD.ID_1),
          (fields.id1 ?? 0) | 0);
        Atomics.store(view, fieldIndex(i, LEDGER_FIELD.ID_2),
          (fields.id2 ?? 0) | 0);
        Atomics.store(view, fieldIndex(i, LEDGER_FIELD.CALL_ID),
          (fields.callId ?? 0) | 0);
        Atomics.store(view, fieldIndex(i, LEDGER_FIELD.BEGAN_AT_TICK),
          (fields.beganAtTick ?? 0) | 0);
        return i;
      }
    }
    return -1;
  }

  /**
   * Partial update of an already-claimed entry. Out-of-range
   * entryIndex is a no-op. Used for activities whose ids change
   * after the initial claim (rare).
   */
  function write(entryIndex, fields) {
    if (entryIndex < 0 || entryIndex >= capacity) return;
    if (fields.contextSlot !== undefined) {
      Atomics.store(view, fieldIndex(entryIndex, LEDGER_FIELD.CONTEXT_SLOT),
        fields.contextSlot | 0);
    }
    if (fields.id1 !== undefined) {
      Atomics.store(view, fieldIndex(entryIndex, LEDGER_FIELD.ID_1),
        fields.id1 | 0);
    }
    if (fields.id2 !== undefined) {
      Atomics.store(view, fieldIndex(entryIndex, LEDGER_FIELD.ID_2),
        fields.id2 | 0);
    }
    if (fields.callId !== undefined) {
      Atomics.store(view, fieldIndex(entryIndex, LEDGER_FIELD.CALL_ID),
        fields.callId | 0);
    }
    if (fields.beganAtTick !== undefined) {
      Atomics.store(view, fieldIndex(entryIndex, LEDGER_FIELD.BEGAN_AT_TICK),
        fields.beganAtTick | 0);
    }
  }

  /**
   * Atomically mark the entry FREE. Idempotent. Out-of-range
   * entryIndex (including -1, the "claim failed" sentinel) is a
   * no-op. Zeroes non-activity fields first, then writes
   * activity = 0 last so any racing walker either sees the old
   * entry intact or sees FREE — never garbage.
   */
  function free(entryIndex) {
    if (entryIndex < 0 || entryIndex >= capacity) return;
    Atomics.store(view, fieldIndex(entryIndex, LEDGER_FIELD.CONTEXT_SLOT), 0);
    Atomics.store(view, fieldIndex(entryIndex, LEDGER_FIELD.ID_1), 0);
    Atomics.store(view, fieldIndex(entryIndex, LEDGER_FIELD.ID_2), 0);
    Atomics.store(view, fieldIndex(entryIndex, LEDGER_FIELD.CALL_ID), 0);
    Atomics.store(view, fieldIndex(entryIndex, LEDGER_FIELD.BEGAN_AT_TICK), 0);
    Atomics.store(view, fieldIndex(entryIndex, LEDGER_FIELD.ACTIVITY), 0);
  }

  /**
   * Snapshot of every non-FREE entry, in entry-index order.
   * Never throws on torn reads. A half-written entry (activity
   * set, other fields zero or partial) is reported as-is.
   *
   * @returns {Array<{entryIndex, contextSlot, activity, id1, id2, callId, beganAtTick}>}
   */
  function walk() {
    const result = [];
    for (let i = 0; i < capacity; i++) {
      const activity = Atomics.load(view, fieldIndex(i, LEDGER_FIELD.ACTIVITY));
      if (activity === 0) continue;
      result.push({
        entryIndex:   i,
        contextSlot:  Atomics.load(view, fieldIndex(i, LEDGER_FIELD.CONTEXT_SLOT)) >>> 0,
        activity:     activity >>> 0,
        id1:          Atomics.load(view, fieldIndex(i, LEDGER_FIELD.ID_1)) >>> 0,
        id2:          Atomics.load(view, fieldIndex(i, LEDGER_FIELD.ID_2)) >>> 0,
        callId:       Atomics.load(view, fieldIndex(i, LEDGER_FIELD.CALL_ID)) >>> 0,
        beganAtTick:  Atomics.load(view, fieldIndex(i, LEDGER_FIELD.BEGAN_AT_TICK)) >>> 0,
      });
    }
    return result;
  }

  /**
   * Rebind the view to a new (buffer, byteOffset). Used by
   * membrane compaction (notifyMemoryRelocated). Capacity is
   * fixed for the format version, so it isn't a parameter.
   */
  function rebind(newBuffer, newByteOffset) {
    baseOffset = newByteOffset >>> 0;
    view = new Int32Array(
      newBuffer, baseOffset, capacity * (LEDGER_ENTRY_BYTES / 4));
  }

  return {
    claim, write, free, walk, rebind,
    get capacity() { return capacity; },
    __peekOffset() { return baseOffset; },
    __peekBufferByteLength() { return view.buffer.byteLength; },
  };
}

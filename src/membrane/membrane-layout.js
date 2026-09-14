/**
 * Membrane layout — pure-function helpers for the membrane buffer.
 *
 * The membrane is the host-facing capability buffer: handle table,
 * grant table, id-list pool, value arena, mutation log, runtime-state
 * cell, in-flight ledger, capability-state table, plus the header
 * that stores their offsets and capacities. Since format version 10,
 * the buffer is self-describing: HEADER.TOTAL_BYTE_LENGTH records its
 * total byte length.
 *
 * This module owns the membrane layout contract. Three exports
 * mirroring vat-layout.js:
 *
 *   computeMembraneLayout(options) → { byteLength, regionOffsets, ... }
 *   layoutMembrane(buffer, byteOffset, options) → void
 *   readMembraneLayout(bytes, byteOffset?) → { byteLength, ... }
 *
 * After layoutMembrane, a host hands the buffer to a Membrane
 * constructor, which attaches without rewriting anything.
 */

import {
  HEADER,
  MEMBRANE_MAGIC,
  MEMBRANE_HEADER_SIZE,
  HANDLE_ENTRY_SIZE,
  GRANT_ENTRY_SIZE,
  CLOSURE_HANDLE_ENTRY_SIZE,
  OBJECT_HANDLE_ENTRY_SIZE,
  LINKED_PROMISE_ENTRY_SIZE,
  CAPABILITY_STATE_ENTRY_SIZE,
  MUTATION_LOG_ENTRY_SIZE,
  RUNTIME_STATE_CELL_BYTES,
  LEDGER_ENTRY_BYTES,
  RUNTIME_STATE,
  VALUE_POINTER_NULL,
  FREE_LIST_END,
  DEFAULT_HANDLE_TABLE_CAPACITY,
  DEFAULT_GRANT_TABLE_CAPACITY,
  DEFAULT_ID_LIST_POOL_SIZE,
  DEFAULT_ROOT_GRANTS_LIST_CAPACITY,
  DEFAULT_VALUE_ARENA_SIZE,
  DEFAULT_CLOSURE_HANDLE_TABLE_CAPACITY,
  DEFAULT_OBJECT_HANDLE_TABLE_CAPACITY,
  DEFAULT_LINKED_PROMISE_TABLE_CAPACITY,
  DEFAULT_MUTATION_LOG_CAPACITY,
  DEFAULT_CAPABILITY_STATE_TABLE_CAPACITY,
  DEFAULT_COST_LEDGER_CAPACITY,
  DEFAULT_LEDGER_CAPACITY,
  COST_LEDGER_ENTRY_SIZE,
} from './index.js';
import { DRONE_FORMAT_VERSION } from '../persisted-format.js';

/**
 * Compute the layout of a membrane buffer given capacity options.
 *
 * No buffer is touched. The host uses the returned `byteLength` to
 * size its `ArrayBuffer` / `SharedArrayBuffer` before calling
 * `layoutMembrane`.
 *
 * @param {object} options
 * @returns {{
 *   byteLength: number,
 *   regionOffsets: {
 *     handleTable: number,
 *     grantTable: number,
 *     idListPool: number,
 *     rootGrantsList: number,
 *     valueArena: number,
 *     closureHandleTable: number,
 *     linkedPromiseTable: number,
 *     mutationLog: number,
 *     runtimeStateCell: number,
 *     ledger: number,
 *     capabilityStateTable: number,
 *     objectHandleTable: number,
 *   },
 *   capacities: object,
 * }}
 */
export function computeMembraneLayout(options = {}) {
  const handleTableCapacity         = options.handleTableCapacity         ?? DEFAULT_HANDLE_TABLE_CAPACITY;
  const grantTableCapacity          = options.grantTableCapacity          ?? DEFAULT_GRANT_TABLE_CAPACITY;
  const idListPoolSize              = options.idListPoolSize              ?? DEFAULT_ID_LIST_POOL_SIZE;
  const rootGrantsListCapacity      = options.rootGrantsListCapacity      ?? DEFAULT_ROOT_GRANTS_LIST_CAPACITY;
  const valueArenaSize              = options.valueArenaSize              ?? DEFAULT_VALUE_ARENA_SIZE;
  const closureHandleTableCapacity  = options.closureHandleTableCapacity  ?? DEFAULT_CLOSURE_HANDLE_TABLE_CAPACITY;
  const objectHandleTableCapacity   = options.objectHandleTableCapacity   ?? DEFAULT_OBJECT_HANDLE_TABLE_CAPACITY;
  const linkedPromiseTableCapacity  = options.linkedPromiseTableCapacity  ?? DEFAULT_LINKED_PROMISE_TABLE_CAPACITY;
  const mutationLogCapacity         = options.mutationLogCapacity         ?? DEFAULT_MUTATION_LOG_CAPACITY;
  const capabilityStateTableCapacity = options.capabilityStateTableCapacity ?? DEFAULT_CAPABILITY_STATE_TABLE_CAPACITY;
  const costLedgerCapacity          = options.costLedgerCapacity          ?? DEFAULT_COST_LEDGER_CAPACITY;
  const ledgerCapacity              = options.ledgerCapacity              ?? DEFAULT_LEDGER_CAPACITY;

  if (ledgerCapacity <= 0) {
    throw new Error(
      `computeMembraneLayout: ledgerCapacity must be a positive integer; got ${ledgerCapacity}`);
  }

  if (mutationLogCapacity <= 0 ||
      (mutationLogCapacity & (mutationLogCapacity - 1)) !== 0) {
    throw new Error(
      `computeMembraneLayout: mutationLogCapacity must be a positive ` +
      `power of two; got ${mutationLogCapacity}`);
  }

  if (costLedgerCapacity <= 0 ||
      (costLedgerCapacity & (costLedgerCapacity - 1)) !== 0) {
    throw new Error(
      `computeMembraneLayout: costLedgerCapacity must be a positive ` +
      `power of two; got ${costLedgerCapacity}`);
  }

  // Atomic ring publication (docs/ring-publication-contract.md) does
  // Atomics loads/stores on u32 fields inside the cost-ledger region,
  // which requires every region cursor to stay 4-byte aligned. All
  // fixed entry sizes are multiples of 4; the two free-form byte sizes
  // must be too. (The runtime-state cell's Int32Array view already
  // required this in practice — this makes it loud at layout time.)
  if ((idListPoolSize & 3) !== 0) {
    throw new Error(
      `computeMembraneLayout: idListPoolSize must be a multiple of 4 ` +
      `(atomic ring publication alignment); got ${idListPoolSize}`);
  }
  if ((valueArenaSize & 3) !== 0) {
    throw new Error(
      `computeMembraneLayout: valueArenaSize must be a multiple of 4 ` +
      `(atomic ring publication alignment); got ${valueArenaSize}`);
  }

  let cursor = MEMBRANE_HEADER_SIZE;

  const handleTable = cursor;
  cursor += handleTableCapacity * HANDLE_ENTRY_SIZE;

  const grantTable = cursor;
  cursor += grantTableCapacity * GRANT_ENTRY_SIZE;

  const idListPool = cursor;
  cursor += idListPoolSize;

  const rootGrantsList = cursor;
  cursor += rootGrantsListCapacity * 4;

  const valueArena = cursor;
  cursor += valueArenaSize;

  const closureHandleTable = cursor;
  cursor += closureHandleTableCapacity * CLOSURE_HANDLE_ENTRY_SIZE;

  const linkedPromiseTable = cursor;
  cursor += linkedPromiseTableCapacity * LINKED_PROMISE_ENTRY_SIZE;

  const mutationLog = cursor;
  cursor += mutationLogCapacity * MUTATION_LOG_ENTRY_SIZE;

  const runtimeStateCell = cursor;
  cursor += RUNTIME_STATE_CELL_BYTES;

  const ledger = cursor;
  cursor += ledgerCapacity * LEDGER_ENTRY_BYTES;

  const capabilityStateTable = cursor;
  cursor += capabilityStateTableCapacity * CAPABILITY_STATE_ENTRY_SIZE;

  const costLedger = cursor;
  cursor += costLedgerCapacity * COST_LEDGER_ENTRY_SIZE;

  // v15: object-handle table (tail region after the cost ledger).
  const objectHandleTable = cursor;
  cursor += objectHandleTableCapacity * OBJECT_HANDLE_ENTRY_SIZE;

  const byteLength = cursor;

  return {
    byteLength,
    regionOffsets: {
      handleTable,
      grantTable,
      idListPool,
      rootGrantsList,
      valueArena,
      closureHandleTable,
      linkedPromiseTable,
      mutationLog,
      runtimeStateCell,
      ledger,
      capabilityStateTable,
      costLedger,
      objectHandleTable,
    },
    capacities: {
      handleTableCapacity,
      grantTableCapacity,
      idListPoolSize,
      rootGrantsListCapacity,
      valueArenaSize,
      closureHandleTableCapacity,
      linkedPromiseTableCapacity,
      objectHandleTableCapacity,
      mutationLogCapacity,
      capabilityStateTableCapacity,
      costLedgerCapacity,
      ledgerCapacity,
    },
  };
}

/**
 * Lay out a membrane buffer in `buffer` at `byteOffset`.
 *
 * Writes the membrane header (magic, version, region offsets,
 * capacities), zero-initializes free-list heads and per-kind
 * counters, and seeds the runtime-state cell to SCHEDULER_IDLE.
 * After this call, the bytes at `[byteOffset, byteOffset + byteLength)`
 * constitute a valid empty membrane.
 *
 * Pure DataView writes — no Membrane instance.
 *
 * @param {ArrayBuffer|SharedArrayBuffer} buffer
 * @param {number} byteOffset — Where the membrane starts inside the buffer.
 * @param {object} options — Same as `computeMembraneLayout`.
 * @returns {object} The layout descriptor (same shape as `computeMembraneLayout`).
 */
export function layoutMembrane(buffer, byteOffset, options = {}) {
  if (typeof byteOffset !== 'number' || byteOffset < 0) {
    throw new TypeError(`layoutMembrane: byteOffset must be a non-negative number, got ${byteOffset}`);
  }

  const layout = computeMembraneLayout(options);
  const { byteLength, regionOffsets, capacities } = layout;

  if (byteOffset + byteLength > buffer.byteLength) {
    throw new RangeError(
      `layoutMembrane: membrane (${byteLength} bytes) at byteOffset ${byteOffset} ` +
      `would overflow buffer (${buffer.byteLength} bytes).`);
  }

  const view = new DataView(buffer, byteOffset, byteLength);

  view.setUint32(HEADER.MAGIC,             MEMBRANE_MAGIC,          true);
  view.setUint32(HEADER.DRONE_FORMAT_VERSION,           DRONE_FORMAT_VERSION, true);
  view.setUint32(HEADER.TOTAL_BYTE_LENGTH, byteLength,              true);
  view.setUint32(HEADER.NEXT_HANDLE_SLOT,  0,                       true);
  view.setUint32(HEADER.NEXT_GRANT_SLOT,   0,                       true);

  view.setUint32(HEADER.HANDLE_TABLE_OFFSET,    regionOffsets.handleTable,            true);
  view.setUint32(HEADER.HANDLE_TABLE_CAPACITY,  capacities.handleTableCapacity,       true);

  view.setUint32(HEADER.GRANT_TABLE_OFFSET,     regionOffsets.grantTable,             true);
  view.setUint32(HEADER.GRANT_TABLE_CAPACITY,   capacities.grantTableCapacity,        true);

  view.setUint32(HEADER.ID_LIST_POOL_OFFSET,    regionOffsets.idListPool,             true);
  view.setUint32(HEADER.ID_LIST_POOL_SIZE,      capacities.idListPoolSize,            true);
  view.setUint32(HEADER.ID_LIST_POOL_USED,      4,                                    true); // 4 reserved so offset 0 = "no list"

  view.setUint32(HEADER.ROOT_GRANTS_LIST_OFFSET,   regionOffsets.rootGrantsList,         true);
  view.setUint32(HEADER.ROOT_GRANTS_LIST_COUNT,    0,                                    true);
  view.setUint32(HEADER.ROOT_GRANTS_LIST_CAPACITY, capacities.rootGrantsListCapacity,    true);

  view.setUint32(HEADER.VALUE_ARENA_OFFSET,     regionOffsets.valueArena,             true);
  view.setUint32(HEADER.VALUE_ARENA_SIZE,       capacities.valueArenaSize,            true);
  view.setUint32(HEADER.VALUE_ARENA_USED,       0,                                    true);

  view.setUint32(HEADER.CLOSURE_HANDLE_TABLE_OFFSET,   regionOffsets.closureHandleTable,        true);
  view.setUint32(HEADER.CLOSURE_HANDLE_TABLE_CAPACITY, capacities.closureHandleTableCapacity,   true);
  view.setUint32(HEADER.NEXT_CLOSURE_HANDLE_SLOT,      0,                                       true);
  view.setUint32(HEADER.CLOSURE_HANDLE_FREE_LIST_HEAD, FREE_LIST_END,                           true);

  // v15: object-handle table.
  view.setUint32(HEADER.OBJECT_HANDLE_TABLE_OFFSET,   regionOffsets.objectHandleTable,      true);
  view.setUint32(HEADER.OBJECT_HANDLE_TABLE_CAPACITY, capacities.objectHandleTableCapacity, true);
  view.setUint32(HEADER.NEXT_OBJECT_HANDLE_SLOT,      0,                                    true);
  view.setUint32(HEADER.OBJECT_HANDLE_FREE_LIST_HEAD, FREE_LIST_END,                        true);

  view.setUint32(HEADER.LINKED_PROMISE_TABLE_OFFSET,   regionOffsets.linkedPromiseTable,        true);
  view.setUint32(HEADER.LINKED_PROMISE_TABLE_CAPACITY, capacities.linkedPromiseTableCapacity,   true);
  view.setUint32(HEADER.NEXT_LINKED_PROMISE_SLOT,      0,                                       true);
  view.setUint32(HEADER.LINKED_PROMISE_FREE_LIST_HEAD, FREE_LIST_END,                           true);

  view.setUint32(HEADER.HANDLE_FREE_LIST_HEAD,   FREE_LIST_END, true);
  view.setUint32(HEADER.GRANT_FREE_LIST_HEAD,    FREE_LIST_END, true);

  // v4: operation tick (u64) + mutation log + per-kind counters.
  view.setBigUint64(HEADER.OPERATION_TICK, 0n, true);

  view.setUint32(HEADER.MUTATION_LOG_OFFSET,      regionOffsets.mutationLog,          true);
  view.setUint32(HEADER.MUTATION_LOG_CAPACITY,    capacities.mutationLogCapacity,     true);
  view.setUint32(HEADER.MUTATION_LOG_WRITE_INDEX, 0,                                  true);

  // v5: runtime-state cell + in-flight ledger.
  view.setUint32(HEADER.RUNTIME_STATE_OFFSET, regionOffsets.runtimeStateCell, true);
  view.setUint32(regionOffsets.runtimeStateCell, RUNTIME_STATE.SCHEDULER_IDLE, true);

  view.setUint32(HEADER.LEDGER_OFFSET,   regionOffsets.ledger,        true);
  view.setUint32(HEADER.LEDGER_CAPACITY, capacities.ledgerCapacity,   true);

  // v7: capability-state table. Entries init to (VALUE_POINTER_NULL, VALUE_POINTER_NULL).
  view.setUint32(HEADER.CAPABILITY_STATE_TABLE_OFFSET,   regionOffsets.capabilityStateTable,        true);
  view.setUint32(HEADER.CAPABILITY_STATE_TABLE_CAPACITY, capacities.capabilityStateTableCapacity,   true);
  for (let i = 0; i < capacities.capabilityStateTableCapacity; i++) {
    const entry = regionOffsets.capabilityStateTable + i * CAPABILITY_STATE_ENTRY_SIZE;
    view.setUint32(entry,     VALUE_POINTER_NULL, true); // namePointer
    view.setUint32(entry + 4, VALUE_POINTER_NULL, true); // valuePointer
  }

  // v8: embedder-state cell starts unset.
  view.setUint32(HEADER.EMBEDDER_STATE_VALUE_POINTER, VALUE_POINTER_NULL, true);

  // v11: cost ledger. The region body zero-inits with the buffer, and
  // seqLo == 0 per slot is exactly the "unpublished" sentinel, so no
  // per-entry init is needed (same as the mutation log).
  view.setUint32(HEADER.COST_LEDGER_OFFSET,      regionOffsets.costLedger,      true);
  view.setUint32(HEADER.COST_LEDGER_CAPACITY,    capacities.costLedgerCapacity, true);
  view.setUint32(HEADER.COST_LEDGER_WRITE_INDEX, 0,                             true);
  view.setUint32(HEADER.COST_LEDGER_FLAGS,              0, true);
  view.setUint32(HEADER.COST_LEDGER_SEGMENT_GENERATION, 1, true);

  // Per-kind mutation counters (13 u32). ArrayBuffer zero-init already
  // does this, but explicit writes document intent and cover reused
  // buffers. SharedArrayBuffer also zero-inits but the same point
  // applies.
  view.setUint32(HEADER.MUTATION_COUNT_HANDLE_ALLOC,     0, true);
  view.setUint32(HEADER.MUTATION_COUNT_HANDLE_FREE,      0, true);
  view.setUint32(HEADER.MUTATION_COUNT_GRANT_CREATE,     0, true);
  view.setUint32(HEADER.MUTATION_COUNT_GRANT_REVOKE,     0, true);
  view.setUint32(HEADER.MUTATION_COUNT_GRANT_REAP,       0, true);
  view.setUint32(HEADER.MUTATION_COUNT_CLOSURE_ALLOC,    0, true);
  view.setUint32(HEADER.MUTATION_COUNT_CLOSURE_FREE,     0, true);
  view.setUint32(HEADER.MUTATION_COUNT_LINKED_ALLOC,     0, true);
  view.setUint32(HEADER.MUTATION_COUNT_LINKED_FREE,      0, true);
  view.setUint32(HEADER.MUTATION_COUNT_LINKED_SETTLE,    0, true);
  view.setUint32(HEADER.MUTATION_COUNT_LINKED_REJECT,    0, true);
  view.setUint32(HEADER.MUTATION_COUNT_ROOT_ADD,         0, true);
  view.setUint32(HEADER.MUTATION_COUNT_ROOT_REMOVE,      0, true);
  view.setUint32(HEADER.MUTATION_COUNT_OBJECT_ALLOC,     0, true);
  view.setUint32(HEADER.MUTATION_COUNT_OBJECT_FREE,      0, true);

  // Engine counters are reserved here and initialized to zero.
  view.setUint32(HEADER.ENGINE_COUNT_GC_PASS,        0,  true);
  view.setBigUint64(HEADER.ENGINE_COUNT_GC_LAST_TICK, 0n, true);
  view.setBigUint64(HEADER.ENGINE_COUNT_GC_BYTES_TOTAL, 0n, true);
  view.setUint32(HEADER.ENGINE_COUNT_GC_LAST_BYTES,  0,  true);
  view.setUint32(HEADER.ENGINE_COUNT_RESIZE_SEGMENT, 0,  true);
  view.setUint32(HEADER.ENGINE_COUNT_RESIZE_REGIONS, 0,  true);

  return layout;
}

/**
 * Read the layout of a membrane back from its bytes.
 *
 * Validates the membrane magic; rejects mismatches. Does not validate
 * the format version — that's the caller's job. Used by hosts that
 * have snapshot bytes on disk and need to know the buffer envelope to
 * allocate.
 *
 * @param {Uint8Array|ArrayBuffer|SharedArrayBuffer} bytes
 * @param {number} [byteOffset=0]
 * @returns {{ byteLength: number, version: number, regionOffsets: object, capacities: object }}
 */
export function readMembraneLayout(bytes, byteOffset = 0) {
  const buffer = bytes instanceof Uint8Array ? bytes.buffer : bytes;
  const bufferOffset = bytes instanceof Uint8Array ? bytes.byteOffset : 0;
  const inputWindowLength = bytes instanceof Uint8Array ? bytes.byteLength : buffer?.byteLength;
  if (!(buffer instanceof ArrayBuffer || buffer instanceof SharedArrayBuffer)) {
    throw new TypeError(
      'readMembraneLayout: bytes must be a Uint8Array, ArrayBuffer, or SharedArrayBuffer');
  }
  if (!Number.isSafeInteger(byteOffset) || byteOffset < 0 ||
      byteOffset + MEMBRANE_HEADER_SIZE > inputWindowLength) {
    throw new RangeError(`readMembraneLayout: truncated header at byteOffset ${byteOffset}`);
  }
  const view = new DataView(
    buffer, bufferOffset + byteOffset, inputWindowLength - byteOffset);

  const magic = view.getUint32(HEADER.MAGIC, true);
  if (magic !== MEMBRANE_MAGIC) {
    throw new Error(
      `readMembraneLayout: membrane magic mismatch at byteOffset ${byteOffset} ` +
      `(got 0x${magic.toString(16)})`);
  }

  const version = view.getUint32(HEADER.DRONE_FORMAT_VERSION, true);
  if (version !== DRONE_FORMAT_VERSION) {
    throw new Error(
      `readMembraneLayout: unsupported drone format version ${version}; ` +
      `expected ${DRONE_FORMAT_VERSION}`);
  }

  const byteLength = view.getUint32(HEADER.TOTAL_BYTE_LENGTH, true);
  if (byteLength < MEMBRANE_HEADER_SIZE ||
      byteLength > view.byteLength) {
    throw new RangeError(
      `readMembraneLayout: declared length ${byteLength} exceeds ` +
      `the ${view.byteLength}-byte input window`);
  }

  return {
    byteLength,
    version,
    regionOffsets: {
      handleTable:           view.getUint32(HEADER.HANDLE_TABLE_OFFSET,         true),
      grantTable:            view.getUint32(HEADER.GRANT_TABLE_OFFSET,          true),
      idListPool:            view.getUint32(HEADER.ID_LIST_POOL_OFFSET,         true),
      rootGrantsList:        view.getUint32(HEADER.ROOT_GRANTS_LIST_OFFSET,     true),
      valueArena:            view.getUint32(HEADER.VALUE_ARENA_OFFSET,          true),
      closureHandleTable:    view.getUint32(HEADER.CLOSURE_HANDLE_TABLE_OFFSET, true),
      linkedPromiseTable:    view.getUint32(HEADER.LINKED_PROMISE_TABLE_OFFSET, true),
      mutationLog:           view.getUint32(HEADER.MUTATION_LOG_OFFSET,         true),
      runtimeStateCell:      view.getUint32(HEADER.RUNTIME_STATE_OFFSET,        true),
      ledger:                view.getUint32(HEADER.LEDGER_OFFSET,               true),
      capabilityStateTable:  view.getUint32(HEADER.CAPABILITY_STATE_TABLE_OFFSET, true),
      costLedger:            view.getUint32(HEADER.COST_LEDGER_OFFSET,          true),
      objectHandleTable:     view.getUint32(HEADER.OBJECT_HANDLE_TABLE_OFFSET,  true),
    },
    capacities: {
      handleTableCapacity:          view.getUint32(HEADER.HANDLE_TABLE_CAPACITY,           true),
      grantTableCapacity:           view.getUint32(HEADER.GRANT_TABLE_CAPACITY,            true),
      idListPoolSize:               view.getUint32(HEADER.ID_LIST_POOL_SIZE,               true),
      rootGrantsListCapacity:       view.getUint32(HEADER.ROOT_GRANTS_LIST_CAPACITY,       true),
      valueArenaSize:               view.getUint32(HEADER.VALUE_ARENA_SIZE,                true),
      closureHandleTableCapacity:   view.getUint32(HEADER.CLOSURE_HANDLE_TABLE_CAPACITY,   true),
      linkedPromiseTableCapacity:   view.getUint32(HEADER.LINKED_PROMISE_TABLE_CAPACITY,   true),
      mutationLogCapacity:          view.getUint32(HEADER.MUTATION_LOG_CAPACITY,           true),
      capabilityStateTableCapacity: view.getUint32(HEADER.CAPABILITY_STATE_TABLE_CAPACITY, true),
      costLedgerCapacity:           view.getUint32(HEADER.COST_LEDGER_CAPACITY,            true),
      ledgerCapacity:               view.getUint32(HEADER.LEDGER_CAPACITY,                 true),
      objectHandleTableCapacity:    view.getUint32(HEADER.OBJECT_HANDLE_TABLE_CAPACITY,    true),
    },
  };
}

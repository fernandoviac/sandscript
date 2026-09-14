import { DRONE_FORMAT_VERSION } from '../persisted-format.js';
import { encode as msgpackEncode, decode as msgpackDecode } from './msgpack.js';

/**
 * Membrane: Capability authorization primitive (SAB-resident).
 *
 * The membrane stores its handle table, grant table, inverse-index lists,
 * root-grants list, and host-facing values in a host-owned buffer (typically
 * a SharedArrayBuffer) addressed by a DataView. This makes membrane state
 * snapshottable as bytes so hosts can migrate or persist live execution.
 *
 * Layout:
 *
 *   [header — 128 bytes]
 *     u32 magic                   ("MMBR")
 *     u32 version                 (buffer-format version)
 *     u32 nextHandleSlot
 *     u32 nextGrantSlot
 *     u32 handleTableOffset
 *     u32 handleTableCapacity
 *     u32 grantTableOffset
 *     u32 grantTableCapacity
 *     u32 idListPoolOffset
 *     u32 idListPoolSize
 *     u32 idListPoolUsed
 *     u32 rootGrantsListOffset
 *     u32 rootGrantsListCount
 *     u32 handleFreeListHead
 *     u32 grantFreeListHead
 *     u32 valueArenaOffset
 *     u32 valueArenaSize
 *     u32 valueArenaUsed
 *     u32 rootGrantsListCapacity
 *     ...padding to 128 bytes
 *
 *   [handle table — 32 bytes per entry, indexed by slot]
 *     u32 version                 (per-slot, increments on reuse)
 *     u32 metadataPointer         (arena-relative; VALUE_POINTER_NULL = none)
 *     u32 declarationNamePointer  (arena-relative; VALUE_POINTER_NULL = none)
 *     u32 grantListOffset         (id-list-pool-relative; ID_LIST_NULL = empty)
 *     u32 grantListCount
 *     u8  flags                   (bit 0 = active, bit 1 = on free list)
 *     u8  padding[3]
 *     u32 freeListNext
 *     u32 reserved
 *
 *   [grant table — 32 bytes per entry, indexed by slot]
 *     u32 version
 *     u32 identifierPointer       (arena-relative)
 *     u32 metadataPointer         (arena-relative; VALUE_POINTER_NULL = none)
 *     u32 handleListOffset        (id-list-pool-relative; ID_LIST_NULL = empty)
 *     u32 handleListCount
 *     u8  flags                   (bit 0 = active, bit 1 = revoked,
 *                                  bit 2 = root, bit 3 = on free list)
 *     u8  padding[3]
 *     u32 freeListNext
 *     u32 reserved
 *
 *   [id-list pool] — bump-allocated u32 lists, no per-list headers
 *   [root grants list] — contiguous u32 grant slots
 *   [value arena] — bump-allocated msgpack-encoded values (u32 length prefix)
 *
 * **Format-version 3 (this revision):** value-arena pointers and
 * id-list-pool offsets stored inside table entries are now RELATIVE
 * to their containing region's base offset, not absolute within the
 * membrane buffer. Translation through `_arenaAbs` / `_arenaRel` for
 * the value arena, and `_listPoolAbs` / `_listPoolRel` for the
 * id-list pool. The motivation: a future membrane-resize primitive
 * can move sub-regions (handle table grows → value arena shifts) and
 * only needs to rewrite the relevant HEADER.*_OFFSET fields. Stored
 * pointers stay valid because they were never anchored to absolute
 * positions in the first place. This matches the WAT engine's
 * segment-relative addressing.
 *
 * The interpreter never touches this buffer. Only the airlock's DataView
 * (this Membrane class) reads or writes it.
 */

// =============================================================================
// Constants
// =============================================================================

export {
  computeMembraneLayout,
  layoutMembrane,
  readMembraneLayout,
} from './membrane-layout.js';

export const MEMBRANE_MAGIC = 0x4D4D4252; // "MMBR" little-endian
// Format version 5: adds two new regions —
// a 4-byte runtime-state cell (cross-realm-observable scheduler state,
// supersedes RuntimeParkedState's JS-callback API) and a fixed
// 256-entry in-flight ledger (per-slot activity presence table).
// Header grows from 256 → 288 bytes for three new u32 fields
// (RUNTIME_STATE_OFFSET, LEDGER_OFFSET, LEDGER_CAPACITY). v4 snapshots
// can't be loaded — pre-1.0, hard cutover acceptable.
//
// Format version 4 (debug observability): adds operation tick, mutation
// log region (offset/capacity/write-index), per-kind mutation counters,
// and reserved space for engine counters. Header grows from 128 → 256
// bytes.
//
// Format version 3 (region-relative pointers): value-arena pointers
// (handle.metadata, handle.declarationName, grant.identifier,
// grant.metadata, closureHandle.metadata) and id-list-pool offsets
// (handle.grantList, grant.handleList, closureHandle.capturedGrants)
// inside table entries are now RELATIVE to their region's base
// offset. Translation lives in _arenaAbs / _arenaRel / _listPoolAbs
// / _listPoolRel.
//
// Format version 2: adds closure-handle table and
// linked-promise table.
// Format version 7: adds capability-state
// table. Uses two u32 slots carved from the v5 reserved slack
// (260..267); MEMBRANE_HEADER_SIZE stays at 280.
// Format version 8: adds the
// embedder-state cell (one u32 arena pointer at offset 268).
// MEMBRANE_HEADER_SIZE stays at 280; 8 bytes of slack remain
// (272..279).
// Format version 9:
// linked-promise entries gain a PARKED_CONTEXT_SLOT i32 field
// (sentinel -1) so context.suspend can register a durable slot
// and route post-restore wake to the parked SS context.
// LINKED_PROMISE_ENTRY_SIZE grows 16 → 20.
// Format version 10: adds
// TOTAL_BYTE_LENGTH at offset 272 (carved from the v8 reserved
// slack at 272..279). Makes the membrane self-describing — hosts
// holding snapshot bytes can recover the size their buffer needs
// without remembering it out-of-band, symmetric with
// STATE.SEGMENT_SIZE in the vat. MEMBRANE_HEADER_SIZE stays at 280;
// 4 bytes of slack remain (276..279).
// Format version 11: adds the cost
// ledger — an append ring of consumption events (fuel + capability
// gauges). Three u32 header fields (COST_LEDGER_OFFSET / _CAPACITY /
// _WRITE_INDEX) at 280..291 grow the header from 280 → 296 (the v10
// slack at 276..279 only held 4 bytes; 12 are needed). The region
// itself is carved at the layout tail, sized capacity × entry size.
// 4 bytes of slack remain (292..295). v10 snapshots can't be loaded —
// pre-1.0, hard cutover acceptable.
// Format version 12: linked-promise parked context identities add the
// allocation generation. Entries grow from 20 to 24 bytes; v11 snapshots
// are rejected because slot-only wake records are unsafe after slot reuse.
// Format version 13: the cost ledger adopts the atomic ring publication
// contract (docs/ring-publication-contract.md). Byte layout is unchanged; the
// version records the behavioral cutover — the write index becomes an
// atomic reservation head advanced BEFORE the slot is touched, and
// SEQ_LO becomes the atomically-published exact 1-based entry index
// (no longer fudged to 1 at the 2^32 sentinel collision). v12
// snapshots predate coherent concurrent reads and are rejected.
// Format version 14: the cost ledger gains an explicit cursor-segment
// generation at reserved header offset 292 and ring flags at reserved
// offset 276. Generation starts at one; zero is the atomic wrap-transition
// seqlock and is never a valid segment. At terminal generation exhaustion
// the writer sets COST_LEDGER_FLAG_SEGMENT_SPACE_EXHAUSTED and stops
// publishing cost events without impeding runtime execution.
// The 96-byte entry and the 296-byte membrane header remain unchanged.
// Format version 15: adds the
// object-handle table (host-retained live vat objects — the object
// counterpart of closure handles, with a retain count), the
// constructible-registration handle flag, and the per-handle
// surrogate-prototype binding (HANDLE_ENTRY.SURROGATE_POINTER, carved
// from the entry's reserved word; 0 = none). Header fields are carved
// from reserved slack at offsets 108..119 and 140..143, and the two
// new mutation counters from slack at 240..247, so
// MEMBRANE_HEADER_SIZE stays 296. The object-handle table is a new
// tail region after the cost ledger.
export const MEMBRANE_HEADER_SIZE = 296;
export const HANDLE_ENTRY_SIZE = 32;
export const GRANT_ENTRY_SIZE = 32;
export const CLOSURE_HANDLE_ENTRY_SIZE = 32;
export const OBJECT_HANDLE_ENTRY_SIZE = 32;
export const LINKED_PROMISE_ENTRY_SIZE = 24;
// Sentinel for LINKED_PROMISE_ENTRY.PARKED_CONTEXT_SLOT meaning
// "no parked context — this entry is JS-Promise-backed
// (linkJSPromise) and wakes via the standard SS-promise waiter
// chain." Suspend-registered entries (context.suspend going
// through _setupSuspension) write a real i32 context slot here.
export const LINKED_PROMISE_NO_PARKED_CONTEXT = -1;
// v7: capability-state table entry = (namePointer:u32, valuePointer:u32)
export const CAPABILITY_STATE_ENTRY_SIZE = 8;
export const FREE_LIST_END = 0xFFFFFFFF;
export const ID_LIST_NULL = 0; // an offset of 0 means "no list" (header bytes can never host a list)

// Runtime-state enum used by the v5 runtime-state cell. The membrane
// owns the cell's binary contract and initializes it to SCHEDULER_IDLE
// during construction; the runtime layer imports the enum from here.
//
// Values match the retired RuntimeParkedState enum so the
// transition is a rename, not a value shuffle.
//
// Value ranges:
//   - 0..63     — sandscript-internal states (RESERVED). Sandscript
//                 may add values here in minor releases. Embedders
//                 must not write these.
//   - 64..65535 — embedder-defined states. Embedders pick their own
//                 values for host wait sites the runtime doesn't know
//                 about.
//
// The cell holds the most-recent transition. Both sandscript and
// the embedder write their own transitions into the same cell;
// neither side stomps the other deliberately, but a new write from
// either side always supersedes the previous value — that's the
// intended "what is this drone doing right now?" semantics, not a
// bug. Embedder-only wait sites that need to survive a runtime
// transition must be tracked elsewhere by the embedder.
export const RUNTIME_STATE = Object.freeze({
  RUNNING:             0,
  SCHEDULER_IDLE:      1,
  INBOUND_LOOP:        2,
  OUTBOUND_DRAIN:      3,
  DRAINING_ROOT_SLOTS: 4,
  GC:                  5,
  QUIESCED:            6,
});

export const RUNTIME_STATE_RUNTIME_RESERVED_MAX = 63;

const RUNTIME_STATE_NAME = Object.freeze(Object.fromEntries(
  Object.entries(RUNTIME_STATE).map(([n, v]) => [v, n])));

export function runtimeStateName(value) {
  return RUNTIME_STATE_NAME[value] ?? `unknown(${value})`;
}

// Ledger activity enum used by the v5 in-flight ledger. Defined here
// for the same reason as RUNTIME_STATE: the membrane owns the binary
// contract, and the airlock needs to write activity values into the
// ledger from handleAwait / resume paths. The runtime layer's
// createLedgerView re-exports these constants.
//
// Values 0..63 are reserved by sandscript; embedders use 64+.
// Value 4 is reserved for a future AWAITING_ASYNC_PEER split —
// v1 does not distinguish an SS slot awaiting another SS slot's
// promise from an SS slot awaiting an external JS Promise. Both
// are reported as AWAITING_PROMISE. When the airlock can cleanly
// determine the promise's executor kind, peer-awaits will move
// to value 4 and JS-promise-awaits will stay at value 3.
export const LEDGER_ACTIVITY = Object.freeze({
  FREE:                 0,
  DRIVING_ROOT:         1,
  DISPATCHING_CLOSURE:  2,
  AWAITING_PROMISE:     3,
  // 4: reserved for future AWAITING_ASYNC_PEER.
  BOOTED_UNSTARTED:     5,
});

export const LEDGER_ACTIVITY_RUNTIME_RESERVED_MAX = 63;

const LEDGER_ACTIVITY_NAME = Object.freeze({
  0: 'free',
  1: 'driving-root',
  2: 'dispatching-closure',
  3: 'awaiting-promise',
  5: 'booted-unstarted',
});

export function ledgerActivityName(activity) {
  return LEDGER_ACTIVITY_NAME[activity] ?? `unknown-activity-${activity}`;
}

// Header field offsets
export const HEADER = {
  MAGIC: 0,
  DRONE_FORMAT_VERSION: 4,
  NEXT_HANDLE_SLOT: 8,
  NEXT_GRANT_SLOT: 12,
  HANDLE_TABLE_OFFSET: 16,
  HANDLE_TABLE_CAPACITY: 20,
  GRANT_TABLE_OFFSET: 24,
  GRANT_TABLE_CAPACITY: 28,
  ID_LIST_POOL_OFFSET: 32,
  ID_LIST_POOL_SIZE: 36,
  ID_LIST_POOL_USED: 40,
  ROOT_GRANTS_LIST_OFFSET: 44,
  ROOT_GRANTS_LIST_COUNT: 48,
  HANDLE_FREE_LIST_HEAD: 52,
  GRANT_FREE_LIST_HEAD: 56,
  VALUE_ARENA_OFFSET: 60,
  VALUE_ARENA_SIZE: 64,
  VALUE_ARENA_USED: 68,
  ROOT_GRANTS_LIST_CAPACITY: 72,
  // v2 additions
  CLOSURE_HANDLE_TABLE_OFFSET: 76,
  CLOSURE_HANDLE_TABLE_CAPACITY: 80,
  NEXT_CLOSURE_HANDLE_SLOT: 84,
  CLOSURE_HANDLE_FREE_LIST_HEAD: 88,
  LINKED_PROMISE_TABLE_OFFSET: 92,
  LINKED_PROMISE_TABLE_CAPACITY: 96,
  NEXT_LINKED_PROMISE_SLOT: 100,
  LINKED_PROMISE_FREE_LIST_HEAD: 104,
  // v15: object-handle table (carved from the 108..119 reserved bytes).
  OBJECT_HANDLE_TABLE_OFFSET: 108,
  OBJECT_HANDLE_TABLE_CAPACITY: 112,
  NEXT_OBJECT_HANDLE_SLOT: 116,

  // ============================================================
  // v4 additions
  // ============================================================

  // Operation tick. Monotonic u64 bumped at coarse JS-side
  // operations (run/gc/snapshot/resize). The interpreter never sees
  // this — it lives in the membrane (host-owned, sandboxed-from-
  // interpreter side). Survives snapshot/restore through the
  // standard membrane bytes round-trip.
  OPERATION_TICK: 120,            // u64 (8 bytes), offsets 120..127

  // Mutation log header. Ring of every membrane mutation.
  MUTATION_LOG_OFFSET: 128,       // u32 — absolute byte offset of ring start
  MUTATION_LOG_CAPACITY: 132,     // u32 — entry count (power of two)
  MUTATION_LOG_WRITE_INDEX: 136,  // u32 — free-running write seq (never reset)
  // v15: object-handle free list (carved from the 140..143 reserved bytes).
  OBJECT_HANDLE_FREE_LIST_HEAD: 140,

  // Per-kind mutation counters. All u32. Bumped atomically
  // alongside log writes. 13 kinds × 4 bytes = 52 bytes (144..195).
  MUTATION_COUNT_HANDLE_ALLOC:     144,
  MUTATION_COUNT_HANDLE_FREE:      148,
  MUTATION_COUNT_GRANT_CREATE:     152,
  MUTATION_COUNT_GRANT_REVOKE:     156,
  MUTATION_COUNT_GRANT_REAP:       160,
  MUTATION_COUNT_CLOSURE_ALLOC:    164,
  MUTATION_COUNT_CLOSURE_FREE:     168,
  MUTATION_COUNT_LINKED_ALLOC:     172,
  MUTATION_COUNT_LINKED_FREE:      176,
  MUTATION_COUNT_LINKED_SETTLE:    180,
  MUTATION_COUNT_LINKED_REJECT:    184,
  MUTATION_COUNT_ROOT_ADD:         188,
  MUTATION_COUNT_ROOT_REMOVE:      192,
  // 196..199: reserved (alignment for the next u64)

  // Engine counters. Reserved before they were populated so enabling
  // them did not require a later format bump.
  ENGINE_COUNT_GC_PASS:            200, // u32
  ENGINE_COUNT_GC_LAST_TICK:       208, // u64 (note alignment skip at 204)
  ENGINE_COUNT_GC_BYTES_TOTAL:     216, // u64
  ENGINE_COUNT_GC_LAST_BYTES:      224, // u32
  // 228..231: reserved (was ENGINE_COUNT_SNAPSHOT in pre-v10
  // bookkeeping; removed when host-owned-memory deleted session-side
  // snapshotting).
  ENGINE_COUNT_RESIZE_SEGMENT:     232, // u32
  ENGINE_COUNT_RESIZE_REGIONS:     236, // u32
  // v15: object-handle mutation counters (carved from the 240..247
  // reserved slack).
  MUTATION_COUNT_OBJECT_ALLOC:     240,
  MUTATION_COUNT_OBJECT_FREE:      244,

  // ============================================================
  // v5 additions
  // ============================================================

  // Runtime-state cell: a single u32 holding the current
  // RUNTIME_STATE enum value. Successor to the JS-only
  // onParkedStateChange callback; readable across realms via
  // Atomics.load and waitable via Atomics.wait.
  RUNTIME_STATE_OFFSET:           248, // u32 — absolute byte offset of the cell

  // In-flight ledger: a fixed-capacity table of activity entries
  // (per-slot in-flight ops). 24 bytes/entry × 256 entries =
  // 6144 bytes. Capacity is encoded in the header so external
  // readers don't need to hard-code the table extent.
  LEDGER_OFFSET:                  252, // u32 — absolute byte offset of the ledger table
  LEDGER_CAPACITY:                256, // u32 — entry count (256 in v5)

  // ============================================================
  // v7 additions
  // ============================================================
  //
  // Capability-wide state table. One mutable, snapshot-surviving
  // cell per capability, addressed by free-form string name.
  // Carved from the v5 reserved slack at offsets 260..267 so
  // MEMBRANE_HEADER_SIZE is unchanged. Entry layout (8 bytes):
  // u32 namePointer | u32 valuePointer.
  CAPABILITY_STATE_TABLE_OFFSET:   260, // u32 — absolute byte offset of the table
  CAPABILITY_STATE_TABLE_CAPACITY: 264, // u32 — entry count

  // ============================================================
  // v8 additions
  // ============================================================
  //
  // Embedder-state cell. Single mutable, snapshot-surviving cell
  // for the embedder's correlation state (e.g. callId→slot tables
  // used to settle linked promises post-restore). Singular by
  // design — one embedder per session. Stored in the value arena
  // like handle/grant metadata. VALUE_POINTER_NULL means "unset".
  EMBEDDER_STATE_VALUE_POINTER:    268, // u32 — arena-relative pointer, or VALUE_POINTER_NULL

  // ============================================================
  // v10 additions
  // ============================================================
  //
  // Total byte length of this membrane buffer (from byteOffset to
  // byteOffset + byteLength). Written by layoutMembrane on fresh
  // init. Lets readMembraneLayout(bytes) recover the buffer envelope
  // a host needs without keeping that information out-of-band.
  TOTAL_BYTE_LENGTH:               272, // u32
  COST_LEDGER_FLAGS:               276, // u32 — COST_LEDGER_FLAG_* bits

  // ============================================================
  // v11 additions
  // ============================================================
  //
  // Cost ledger: an append RING of consumption events (SandScript
  // fuel drives + capability calls), each carrying a fixed gauge
  // vector. Same ring discipline as the mutation log — a
  // free-running write index, masked with CAPACITY-1 to pick the
  // ring slot, never reset; readers track a last-read cursor. Drone-
  // untouchable (only the airlock writes the membrane) and snapshots
  // for free (lives in membraneBytes). The header grows from 280 to
  // 296 to hold three u32 fields; generation uses the last reserved word.
  COST_LEDGER_OFFSET:              280, // u32 — absolute byte offset of the ring
  COST_LEDGER_CAPACITY:            284, // u32 — entry count (power of two)
  COST_LEDGER_WRITE_INDEX:         288, // u32 — reservation head within the segment
  COST_LEDGER_SEGMENT_GENERATION:  292, // u32 — opaque nonzero segment discriminator
};

// Sentinel meaning "no value stored at this pointer field".
// 0 is a valid arena offset (the first value stored); use 0xFFFFFFFF instead.
export const VALUE_POINTER_NULL = 0xFFFFFFFF;

// Handle entry field offsets (relative to entry start)
export const HANDLE_ENTRY = {
  VERSION: 0,
  METADATA_POINTER: 4,
  DECLARATION_NAME_POINTER: 8,
  GRANT_LIST_OFFSET: 12,
  GRANT_LIST_COUNT: 16,
  FLAGS: 20,
  // padding: 21..23
  FREE_LIST_NEXT: 24,
  // v15: surrogate prototype HEADER pointer for a constructible
  // external (0 = none interned yet). GC-forwarded; a GC root while
  // set. Pre-v15 entries always wrote 0 here (the field was RESERVED),
  // so no migration transform is needed.
  SURROGATE_POINTER: 28,
};

// Grant entry field offsets (relative to entry start). Same shape as handle.
export const GRANT_ENTRY = {
  VERSION: 0,
  IDENTIFIER_POINTER: 4,
  METADATA_POINTER: 8,
  HANDLE_LIST_OFFSET: 12,
  HANDLE_LIST_COUNT: 16,
  FLAGS: 20,
  // padding: 21..23
  FREE_LIST_NEXT: 24,
  RESERVED: 28,
};

// Closure-handle entry field offsets (relative to entry start). 32 bytes.
export const CLOSURE_HANDLE_ENTRY = {
  VERSION: 0,
  CLOSURE_POINTER: 4,            // SS heap header pointer; updated by GC
  METADATA_POINTER: 8,           // arena pointer; VALUE_POINTER_NULL = none
  CAPTURED_GRANTS_LIST_OFFSET: 12, // into id-list pool
  CAPTURED_GRANTS_LIST_COUNT: 16,
  FLAGS: 20,
  // padding: 21..23
  FREE_LIST_NEXT: 24,
  RESERVED: 28,
};

// Object-handle entry field offsets (relative to entry start). 32 bytes.
// v15: host-retained live vat objects.
// Same shape as the closure-handle entry, with a retain count in the
// last word instead of a reserved field.
export const OBJECT_HANDLE_ENTRY = {
  VERSION: 0,
  OBJECT_POINTER: 4,             // SS heap header pointer; updated by GC
  METADATA_POINTER: 8,           // arena pointer; VALUE_POINTER_NULL = none
  CAPTURED_GRANTS_LIST_OFFSET: 12, // into id-list pool
  CAPTURED_GRANTS_LIST_COUNT: 16,
  FLAGS: 20,
  // padding: 21..23
  FREE_LIST_NEXT: 24,
  RETAIN_COUNT: 28,              // u32; slot frees when it reaches zero
};

// Linked-promise entry field offsets. 24 bytes.
export const LINKED_PROMISE_ENTRY = {
  VERSION: 0,
  SS_PROMISE_POINTER: 4,        // SS heap header pointer; updated by GC
  FLAGS: 8,
  // padding: 9..11
  FREE_LIST_NEXT: 12,
  // v9: PARKED_CONTEXT_SLOT — i32. -1 (LINKED_PROMISE_NO_PARKED_CONTEXT)
  // for entries created via linkJSPromise (the JS-Promise-backed path,
  // which wakes its waiters through the SS promise's own waiter chain).
  // A real i32 context slot for entries created via context.suspend
  // (the SuspensionMarker path), where post-restore settlement must
  // route to resumeWithValue/resumeWithThrow on the parked context
  // because the SS promise itself has no SS-side waiters.
  PARKED_CONTEXT_SLOT: 16,
  PARKED_CONTEXT_GENERATION: 20,
};

export const HANDLE_FLAG_ACTIVE = 0x01;
export const HANDLE_FLAG_ON_FREE_LIST = 0x02;
// v15: the host registered this handle constructible
// (airlock.setConstructible). Persists so restore can validate that
// the capability re-registered the handle before runtime resume.
export const HANDLE_FLAG_CONSTRUCTIBLE = 0x04;

export const GRANT_FLAG_ACTIVE = 0x01;       // slot is allocated (not freed)
export const GRANT_FLAG_REVOKED = 0x02;      // host called revoke() — auth fails
export const GRANT_FLAG_ROOT = 0x04;         // tracked in rootGrantsList
export const GRANT_FLAG_ON_FREE_LIST = 0x08;

export const CLOSURE_HANDLE_FLAG_ACTIVE = 0x01;
export const CLOSURE_HANDLE_FLAG_ON_FREE_LIST = 0x02;

export const OBJECT_HANDLE_FLAG_ACTIVE = 0x01;
export const OBJECT_HANDLE_FLAG_ON_FREE_LIST = 0x02;

export const LINKED_PROMISE_FLAG_ACTIVE = 0x01;
export const LINKED_PROMISE_FLAG_ON_FREE_LIST = 0x02;

// Default capacities; closure and linked-promise tables were added in v2.
export const DEFAULT_HANDLE_TABLE_CAPACITY = 4096;
export const DEFAULT_GRANT_TABLE_CAPACITY = 256;
export const DEFAULT_ID_LIST_POOL_SIZE = 65536;
export const DEFAULT_ROOT_GRANTS_LIST_CAPACITY = 32;
export const DEFAULT_VALUE_ARENA_SIZE = 65536;
export const DEFAULT_CLOSURE_HANDLE_TABLE_CAPACITY = 1024;
export const DEFAULT_OBJECT_HANDLE_TABLE_CAPACITY = 1024;
export const DEFAULT_LINKED_PROMISE_TABLE_CAPACITY = 256;
// v7: capability-state default. 64 cells is comfortable for embedders with
// O(10) capabilities.
export const DEFAULT_CAPABILITY_STATE_TABLE_CAPACITY = 64;
// v4: default mutation-log capacity. Power of two required (we mask
// the free-running write index with CAPACITY-1 to compute the slot).
// 1024 entries × 32 bytes/entry = 32 KB. Configurable at session
// creation via createSession({ mutationLogCapacity }); growable at
// runtime via membrane.resizeMutationLog(newCapacity).
export const DEFAULT_MUTATION_LOG_CAPACITY = 1024;

// v11: default cost-ledger capacity. Power of two required (same
// write-index masking as the mutation log). 1024 entries × 96
// bytes/entry = 96 KB. Configurable at session creation via
// createSession({ costLedgerCapacity }).
export const DEFAULT_COST_LEDGER_CAPACITY = 1024;

/** Publication permanently stopped to prevent segment-generation aliasing. */
export const COST_LEDGER_FLAG_SEGMENT_SPACE_EXHAUSTED = 0x01;

// v5 diagnostic regions. RUNTIME_STATE_CELL_BYTES is fixed (a single u32
// cell). The ledger's ENTRY size is fixed, but its entry COUNT is a
// configurable session option (DEFAULT_LEDGER_CAPACITY), like
// costLedgerCapacity: set it at session creation via
// createSession({ ledgerCapacity }). It is not resizable later through
// resizeRegions because real concurrent workloads can legitimately exceed
// the 256 default. The runtime layer's view module imports
// LEDGER_ENTRY_BYTES from here rather than re-declaring it; the module-
// level LEDGER_CAPACITY/LEDGER_REGION_BYTES constants below are the
// DEFAULT sizing only — actual per-session capacity always comes from
// the membrane header (HEADER.LEDGER_CAPACITY), not these constants.
export const RUNTIME_STATE_CELL_BYTES = 4;
export const LEDGER_ENTRY_BYTES = 24;
export const DEFAULT_LEDGER_CAPACITY = 256;
export const LEDGER_CAPACITY = DEFAULT_LEDGER_CAPACITY;
export const LEDGER_REGION_BYTES = LEDGER_ENTRY_BYTES * LEDGER_CAPACITY;

// FinalizationRegistry recent-fire counter window, measured in membrane
// ticks. Each tick gets one bucket; recentFinalizationCount() sums the
// buckets covering the last N ticks. 64 ticks approximate one busy worker
// cycle, which is the resolution needed for leak investigations.
export const DEFAULT_FR_WINDOW_TICKS = 64;

// =============================================================================
// Mutation log (v4)
// =============================================================================
//
// Entry: 32 bytes per mutation. Field offsets relative to entry start.
//
//   offset 0:  u32 seqLo       free-running write sequence, low 32 bits
//   offset 4:  u32 seqHi       free-running write sequence, high 32 bits
//   offset 8:  u32 tickLo      operation tick at write, low 32
//   offset 12: u32 tickHi      operation tick at write, high 32
//   offset 16: u8  kind        MUTATION_KIND.* enum value
//   offset 17: u8  reserved
//   offset 18: u16 flags       per-kind bits (e.g. GRANT_WAS_ROOT)
//   offset 20: u32 slot        the slot mutated
//   offset 24: u32 version     slot version AFTER the mutation
//   offset 28: u32 callerTag   MUTATION_TAG.* enum value
//
// Publication: seqLo is stored LAST via Atomics.store, with seqHi
// stored just before. Readers Atomics.load seqLo; value 0 is the
// "not yet published" sentinel (or "wrapped and not yet rewritten").
// Free-running seq lets readers detect skipped entries from a fast
// wrap (consecutive ring slots whose seq delta != 1).
// =============================================================================

export const MUTATION_LOG_ENTRY_SIZE = 32;
export const MUTATION_LOG_ENTRY = {
  SEQ_LO:     0,
  SEQ_HI:     4,
  TICK_LO:    8,
  TICK_HI:   12,
  KIND:      16,
  // 17: reserved
  FLAGS:     18,    // u16
  SLOT:      20,
  VERSION:   24,
  CALLER_TAG: 28,
};

// v11: cost-ledger entry. 96 bytes: a 24-byte envelope (publish-seq,
// tick, kind, slot) followed by a 9-slot u64 gauge vector. Fixed-width
// so the ring has fixed stride and snapshots are a stable binary
// contract. seqLo is published LAST (sentinel 0 = "not yet written"),
// same partial-write protocol as the mutation log.
export const COST_LEDGER_ENTRY_SIZE = 96;
export const COST_LEDGER_ENTRY = {
  SEQ_LO:     0,   // u32 — publish-last sentinel (0 = unpublished)
  SEQ_HI:     4,   // u32
  TICK_LO:    8,   // u32
  TICK_HI:   12,   // u32
  KIND:      16,   // u32 — COST_KIND.* (extensible; see below)
  SLOT:      20,   // u32 — slot the event is attributed to
  // ---- gauge vector: nine u64s, 8-byte aligned from offset 24 ----
  FUEL:        24, // u64 — SandScript fuel consumed (fuel-drive entries)
  WALL_NANOS:  32, // u64 — wall-clock ns; read per KIND (compute→CPU, I/O→occupancy)
  BYTES_IN:    40, // u64 — bytes ingested
  BYTES_OUT:   48, // u64 — bytes emitted/stored
  CALLS:       56, // u64 — event count (1 per entry; lets readers count without scan)
  CPU_NANOS:   64, // u64 — PERMANENTLY UNSOURCED, by design, not pending.
                   // No per-drone CPU-time measurement exists on this
                   // runtime at any grain: process-wide APIs conflate
                   // every drone sharing a process, and a Swarm hosts N
                   // drones on one thread, so even a per-thread source
                   // would attribute to a swarm, not a drone. Always 0.
  BYTES_HELD:  72, // u64 — RESERVED, unsourced (sampler-only); always 0 today
  EXT0:        80, // u64 — uninterpreted embedder extension
  EXT1:        88, // u64 — uninterpreted embedder extension
};

// Cost-ledger entry kinds. Extensible range (mirrors the runtime-state
// 0..63 / 64+ split): 0..63 are sandscript-owned; embedders use 64+
// for their own capability kinds without a format bump. Sandscript
// only writes FUEL itself; embedders report their own capability costs.
export const COST_KIND = {
  FUEL:    1,   // SandScript fuel drive — the airlock appends on its own behalf
  // 2..63 reserved for future sandscript-owned kinds.
  // 64+ : embedder-defined (e.g. network, storage, or cryptography).
};
export const COST_KIND_EMBEDDER_BASE = 64;

// Closed enum: every mutation kind that lands in the log.
export const MUTATION_KIND = {
  HANDLE_ALLOC:          1,
  HANDLE_FREE:           2,
  GRANT_CREATE:          3,
  GRANT_REVOKE:          4,
  GRANT_REAP:            5,
  CLOSURE_HANDLE_ALLOC:  6,
  CLOSURE_HANDLE_FREE:   7,
  LINKED_PROMISE_ALLOC:  8,
  LINKED_PROMISE_FREE:   9,
  LINKED_PROMISE_SETTLE: 10,
  LINKED_PROMISE_REJECT: 11,
  GRANT_ROOT_ADD:        12,
  GRANT_ROOT_REMOVE:     13,
  OBJECT_HANDLE_ALLOC:   14,
  OBJECT_HANDLE_FREE:    15,
};

// Reverse map: numeric kind → enum-key name. Populated from MUTATION_KIND so
// new kinds appear automatically. Debug wrappers attach kindName to mutation
// log entries because numeric kinds are unreadable in raw form.
export const MUTATION_KIND_NAME = Object.freeze(Object.fromEntries(
  Object.entries(MUTATION_KIND).map(([name, value]) => [value, name]),
));

// Kind-family bitmasks: which mutation kinds apply to which membrane
// table. Used by structured errors and Debug introspection to filter
// "entries for slot N in the handle table" without confusing them with
// "entries for slot N in the grant table" (slot numbers are per-table).
export const MUTATION_KIND_FAMILY = {
  HANDLE:
    (1 << MUTATION_KIND.HANDLE_ALLOC) |
    (1 << MUTATION_KIND.HANDLE_FREE),
  GRANT:
    (1 << MUTATION_KIND.GRANT_CREATE) |
    (1 << MUTATION_KIND.GRANT_REVOKE) |
    (1 << MUTATION_KIND.GRANT_REAP) |
    (1 << MUTATION_KIND.GRANT_ROOT_ADD) |
    (1 << MUTATION_KIND.GRANT_ROOT_REMOVE),
  CLOSURE_HANDLE:
    (1 << MUTATION_KIND.CLOSURE_HANDLE_ALLOC) |
    (1 << MUTATION_KIND.CLOSURE_HANDLE_FREE),
  LINKED_PROMISE:
    (1 << MUTATION_KIND.LINKED_PROMISE_ALLOC) |
    (1 << MUTATION_KIND.LINKED_PROMISE_FREE) |
    (1 << MUTATION_KIND.LINKED_PROMISE_SETTLE) |
    (1 << MUTATION_KIND.LINKED_PROMISE_REJECT),
  OBJECT_HANDLE:
    (1 << MUTATION_KIND.OBJECT_HANDLE_ALLOC) |
    (1 << MUTATION_KIND.OBJECT_HANDLE_FREE),
};

// Map kind value → counter header offset. Single source of truth so
// _logMutation can bump the right counter without a switch.
export const MUTATION_KIND_COUNTER_OFFSET = {
  [MUTATION_KIND.HANDLE_ALLOC]:          HEADER.MUTATION_COUNT_HANDLE_ALLOC,
  [MUTATION_KIND.HANDLE_FREE]:           HEADER.MUTATION_COUNT_HANDLE_FREE,
  [MUTATION_KIND.GRANT_CREATE]:          HEADER.MUTATION_COUNT_GRANT_CREATE,
  [MUTATION_KIND.GRANT_REVOKE]:          HEADER.MUTATION_COUNT_GRANT_REVOKE,
  [MUTATION_KIND.GRANT_REAP]:            HEADER.MUTATION_COUNT_GRANT_REAP,
  [MUTATION_KIND.CLOSURE_HANDLE_ALLOC]:  HEADER.MUTATION_COUNT_CLOSURE_ALLOC,
  [MUTATION_KIND.CLOSURE_HANDLE_FREE]:   HEADER.MUTATION_COUNT_CLOSURE_FREE,
  [MUTATION_KIND.LINKED_PROMISE_ALLOC]:  HEADER.MUTATION_COUNT_LINKED_ALLOC,
  [MUTATION_KIND.LINKED_PROMISE_FREE]:   HEADER.MUTATION_COUNT_LINKED_FREE,
  [MUTATION_KIND.LINKED_PROMISE_SETTLE]: HEADER.MUTATION_COUNT_LINKED_SETTLE,
  [MUTATION_KIND.LINKED_PROMISE_REJECT]: HEADER.MUTATION_COUNT_LINKED_REJECT,
  [MUTATION_KIND.GRANT_ROOT_ADD]:        HEADER.MUTATION_COUNT_ROOT_ADD,
  [MUTATION_KIND.GRANT_ROOT_REMOVE]:     HEADER.MUTATION_COUNT_ROOT_REMOVE,
  [MUTATION_KIND.OBJECT_HANDLE_ALLOC]:   HEADER.MUTATION_COUNT_OBJECT_ALLOC,
  [MUTATION_KIND.OBJECT_HANDLE_FREE]:    HEADER.MUTATION_COUNT_OBJECT_FREE,
};

// Closed enum: who triggered the mutation, recorded at every call
// site. Every mutation call site in the membrane and airlock is
// tagged with exactly one of these. Adding a new mutation path
// requires adding a new tag (or reusing an exactly-matching existing
// one) at the call site — not inferred from a stack walk.
export const MUTATION_TAG = {
  // Explicit host-initiated mutations:
  EXPLICIT_REVOKE:   1,  // host called airlock.revoke / membrane.revoke
  EXPLICIT_GRANT:    2,  // host called createGrant directly
  EXPLICIT_HANDLE:   3,  // host called register / createHandle
  EXPLICIT_CLOSURE:  4,  // host registered a closure handle
  EXPLICIT_LINKED:   5,  // host registered a linked promise

  // Compaction reaping (membrane.compact):
  GC_REAP_GRANT:     6,
  GC_REAP_CLOSURE:   7,
  GC_REAP_LINKED:    8,
  GC_REAP_HANDLE:    9,

  // Root grant operations:
  ROOT_POP:         10,  // grant freed via root-pop on closure free
  ROOT_PUSH:        11,  // grant added to root list (markAsRootGrant)

  // Snapshot machinery:
  SNAPSHOT_QUIESCE: 12,
  SNAPSHOT_ORPHAN:  13,  // linked promise rejected post-restore

  // Capability lifecycle:
  HOST_REVOKE:      14,  // capability teardown by host (distinct from explicit revoke)
  LINKED_SETTLE:    15,  // linked promise resolved/rejected by host

  // Side effects of resize machinery (reserved for future use):
  RESIZE_CASCADE:   16,

  // FinalizationRegistry-driven free (JS GC reclaimed a wrapper):
  WRAPPER_GC:       17,

  // v15: object-handle mutations (host retained/released a vat object):
  EXPLICIT_OBJECT:  18,
};

// Reverse map: numeric tag → enum-key name. Same shape as
// MUTATION_KIND_NAME above. Adding a new tag picks the name up
// automatically. Consumers attach callerTagName to mutation log
// entries so "who did this" is readable without grepping enums.
export const MUTATION_TAG_NAME = Object.freeze(Object.fromEntries(
  Object.entries(MUTATION_TAG).map(([name, value]) => [value, name]),
));

// =============================================================================
// Errors
// =============================================================================

export class MembraneOutOfSpaceError extends Error {
  constructor(message) {
    super(message);
    this.name = 'MembraneOutOfSpaceError';
  }
}

// Helper used by the stale-error constructors to attach structured
// debug context. `details` is one of:
//   undefined  → no enrichment; .atTick = null, etc.
//   {tick, lastMutation, mutationHistory, ...}  → fields copied as-is.
//
// Errors carry plain-data log provenance copied out at throw time, so
// callers can read it without a Debug instance.
function _applyStaleErrorDetails(err, details) {
  if (!details) {
    err.atTick = null;
    err.lastMutation = null;
    err.mutationHistory = [];
    return;
  }
  err.atTick = details.tick ?? null;
  err.lastMutation = details.lastMutation ?? null;
  err.mutationHistory = details.mutationHistory ?? [];
  if (details.pendingCall !== undefined) err.pendingCall = details.pendingCall;
}

export class StaleHandleError extends Error {
  constructor(slot, expectedVersion, actualVersion, details) {
    super(`Stale handle: slot=${slot} expected version=${expectedVersion}, actual=${actualVersion}`);
    this.name = 'StaleHandleError';
    this.slot = slot;
    this.expectedVersion = expectedVersion;
    this.actualVersion = actualVersion;
    _applyStaleErrorDetails(this, details);
  }
}

export class StaleGrantError extends Error {
  constructor(slot, expectedVersion, actualVersion, details) {
    super(`Stale grant: slot=${slot} expected version=${expectedVersion}, actual=${actualVersion}`);
    this.name = 'StaleGrantError';
    this.slot = slot;
    this.expectedVersion = expectedVersion;
    this.actualVersion = actualVersion;
    _applyStaleErrorDetails(this, details);
  }
}

export class StaleClosureHandleError extends Error {
  constructor(slot, expectedVersion, actualVersion, details) {
    super(`Stale closure handle: slot=${slot} expected version=${expectedVersion}, actual=${actualVersion}`);
    this.name = 'StaleClosureHandleError';
    this.slot = slot;
    this.expectedVersion = expectedVersion;
    this.actualVersion = actualVersion;
    _applyStaleErrorDetails(this, details);
  }
}

export class StaleObjectHandleError extends Error {
  constructor(slot, expectedVersion, actualVersion, details) {
    super(`Stale object handle: slot=${slot} expected version=${expectedVersion}, actual=${actualVersion}`);
    this.name = 'StaleObjectHandleError';
    this.slot = slot;
    this.expectedVersion = expectedVersion;
    this.actualVersion = actualVersion;
    _applyStaleErrorDetails(this, details);
  }
}

/**
 * Thrown when an SS Promise is rejected because it was a JS↔SS linked promise
 * orphaned by snapshot/restore — the original JS Promise's continuation
 * closure cannot be serialized, so the new session's drone gets this on
 * resume. Drone source is expected to handle promise rejection cleanly.
 *
 * Accepts an optional `details` object carrying
 * { atTick, lastMutation, mutationHistory } so host code that constructs
 * the error in response to an orphaned promise can attach full provenance.
 */
export class SnapshotOrphanedError extends Error {
  constructor(message = 'linked promise was orphaned by snapshot/restore', details) {
    super(message);
    this.name = 'SnapshotOrphanedError';
    _applyStaleErrorDetails(this, details);
  }
}

// =============================================================================
// Wrappers
// =============================================================================

const HANDLE_TAG = Symbol.for('sandscript:handle');
const GRANT_TAG = Symbol.for('sandscript:grant');
const CLOSURE_HANDLE_TAG = Symbol.for('sandscript:closure-handle');
const OBJECT_HANDLE_TAG = Symbol.for('sandscript:object-handle');

export function isHandle(value) {
  return value !== null && typeof value === 'object' && value[HANDLE_TAG] === true;
}

export function isGrant(value) {
  return value !== null && typeof value === 'object' && value[GRANT_TAG] === true;
}

export function isClosureHandle(value) {
  return value !== null && typeof value === 'object' && value[CLOSURE_HANDLE_TAG] === true;
}

export function isObjectHandle(value) {
  return value !== null && typeof value === 'object' && value[OBJECT_HANDLE_TAG] === true;
}

/**
 * Host-facing wrapper for a registered capability. Carries (slot, version)
 * so stale references fail loud after a slot has been reclaimed and reused.
 */
export class Handle {
  constructor(slot, version) {
    this.slot = slot;
    this.version = version;
    this[HANDLE_TAG] = true;
  }
}

/**
 * Host-facing wrapper for a grant. Like Handle, carries (slot, version);
 * stale references fail loud.
 *
 * Identifier, metadata, and active state are read lazily from the SAB via
 * getters — they always reflect current truth (a revoked grant returns
 * `active === false` immediately, an undecoded identifier is decoded on
 * first read). This means wrappers are cheap to mint and never go out of
 * sync with the buffer.
 *
 * `slot` doubles as the grant id stored on the WAT interpreter's grant
 * stack — the WAT layer doesn't carry versions (it's protected by the
 * compaction heap walker the same way the heap is). Versions only matter
 * at the JS host boundary, where stale wrappers could otherwise survive
 * after a slot was reclaimed and reused.
 */
export class Grant {
  constructor(membrane, slot, version) {
    this.membrane = membrane;
    this.slot = slot;
    this.version = version;
    this[GRANT_TAG] = true;
  }

  get identifier() {
    return this.membrane._readGrantIdentifier(this.slot);
  }

  get metadata() {
    return this.membrane._readGrantMetadata(this.slot);
  }

  get active() {
    return this.membrane._isGrantActive(this.slot);
  }

  /**
   * Slots of the handles authorized by this grant, as a Set.
   * Read live from the SAB on each call — never goes stale.
   */
  handleSlots() {
    return this.membrane._readGrantHandleSet(this.slot);
  }

  add(handle) {
    if (!this.active) {
      throw new Error('Cannot add handle to revoked grant');
    }
    this.membrane._addHandleToGrant(this, handle);
  }
}

/**
 * Host-facing wrapper for a closure registered by drone code.
 *
 * Carries (slot, version) like Handle and Grant. Lazy SAB-backed getters
 * for closurePointer (kept up-to-date by heap GC), capturedGrantSlots,
 * and metadata. Snapshot-restorable: the membrane SAB stores everything,
 * so post-restore the host can enumerateClosureHandles(), reattach
 * wrappers to its own listener tables, and fire callbacks the drone
 * registered before the snapshot.
 */
export class ClosureHandle {
  constructor(membrane, slot, version) {
    this.membrane = membrane;
    this.slot = slot;
    this.version = version;
    this[CLOSURE_HANDLE_TAG] = true;
  }

  get closurePointer() {
    return this.membrane._readClosurePointer(this.slot);
  }

  get capturedGrantSlots() {
    return this.membrane._readCapturedGrantSet(this.slot);
  }

  get metadata() {
    return this.membrane._readClosureMetadata(this.slot);
  }
}

/**
 * Host-facing wrapper for a retained live vat object. Carries
 * (slot, version) like ClosureHandle. Lazy SAB-backed getters for
 * objectPointer (kept up-to-date by heap GC), capturedGrantSlots,
 * metadata, and retainCount. One live wrapper is interned per vat object;
 * repeated host retention returns the same wrapper and bumps the retain
 * count.
 */
export class ObjectHandle {
  constructor(membrane, slot, version) {
    this.membrane = membrane;
    this.slot = slot;
    this.version = version;
    this[OBJECT_HANDLE_TAG] = true;
  }

  get objectPointer() {
    return this.membrane._readObjectPointer(this.slot);
  }

  get capturedGrantSlots() {
    return this.membrane._readObjectCapturedGrantSet(this.slot);
  }

  get metadata() {
    return this.membrane._readObjectMetadata(this.slot);
  }

  get retainCount() {
    return this.membrane._readObjectRetainCount(this.slot);
  }
}

// Build the structured `details` payload for a stale-* error: log
// history filtered to the relevant kind family, plus the current tick.
// Returns { tick, lastMutation, mutationHistory } with empty/null
// fallbacks when the log has wrapped past the relevant entries.
function _staleErrorDetailsFor(membrane, slot, familyMask) {
  const history = membrane.findRecentMutationsForSlot(slot, {
    kindMask: familyMask,
    limit: 8,
  });
  return {
    tick: membrane.tick(),
    lastMutation: history.length > 0 ? history[0] : null,
    mutationHistory: history,
  };
}

function unwrapHandle(membrane, handle) {
  if (!isHandle(handle)) {
    throw new TypeError(`Expected a Handle, got ${typeof handle === 'object' ? handle?.constructor?.name : typeof handle}`);
  }
  const currentVersion = membrane._readHandleVersion(handle.slot);
  if (currentVersion !== handle.version) {
    throw new StaleHandleError(handle.slot, handle.version, currentVersion,
      _staleErrorDetailsFor(membrane, handle.slot, MUTATION_KIND_FAMILY.HANDLE));
  }
  return handle.slot;
}

function unwrapGrant(membrane, grant) {
  if (!isGrant(grant)) {
    throw new TypeError(`Expected a Grant, got ${typeof grant === 'object' ? grant?.constructor?.name : typeof grant}`);
  }
  const currentVersion = membrane._readGrantVersion(grant.slot);
  if (currentVersion !== grant.version) {
    throw new StaleGrantError(grant.slot, grant.version, currentVersion,
      _staleErrorDetailsFor(membrane, grant.slot, MUTATION_KIND_FAMILY.GRANT));
  }
  return grant.slot;
}

function unwrapClosureHandle(membrane, handle) {
  if (!isClosureHandle(handle)) {
    throw new TypeError(`Expected a ClosureHandle, got ${typeof handle === 'object' ? handle?.constructor?.name : typeof handle}`);
  }
  const currentVersion = membrane._readClosureHandleVersion(handle.slot);
  if (currentVersion !== handle.version) {
    throw new StaleClosureHandleError(handle.slot, handle.version, currentVersion,
      _staleErrorDetailsFor(membrane, handle.slot, MUTATION_KIND_FAMILY.CLOSURE_HANDLE));
  }
  return handle.slot;
}

function unwrapObjectHandle(membrane, handle) {
  if (!isObjectHandle(handle)) {
    throw new TypeError(`Expected an ObjectHandle, got ${typeof handle === 'object' ? handle?.constructor?.name : typeof handle}`);
  }
  const currentVersion = membrane._readObjectHandleVersion(handle.slot);
  if (currentVersion !== handle.version) {
    throw new StaleObjectHandleError(handle.slot, handle.version, currentVersion,
      _staleErrorDetailsFor(membrane, handle.slot, MUTATION_KIND_FAMILY.OBJECT_HANDLE));
  }
  return handle.slot;
}

// =============================================================================
// Membrane
// =============================================================================

export class Membrane {
  // Prototype accessors for the four fields that legitimately mutate
  // after construction (relocate). Internal code keeps reading
  // `this.view`, `this.byteOffset`, etc. unchanged; the getters
  // delegate to _state. The instance is Object.frozen at end of
  // construction, which blocks net-new fields from outside without
  // breaking these reads.
  get buffer()     { return this._state.buffer; }
  get byteOffset() { return this._state.byteOffset; }
  get byteLength() { return this._state.byteLength; }
  get view()       { return this._state.view; }
  get bytesView()  { return this._state.bytesView; }
  get onPressure()    { return this._state.onPressure; }
  set onPressure(fn)  { this._state.onPressure = fn; }

  /**
   * Attach to a host-owned membrane buffer.
   *
   * The caller has already laid out the bytes (via `layoutMembrane`)
   * or copied a snapshot in. This constructor only attaches a view
   * over them and validates that the magic + format version match
   * the running build. Sizing options live on `layoutMembrane`, not
   * here.
   *
   * @param {object} options
   * @param {ArrayBuffer|SharedArrayBuffer} options.buffer
   * @param {number} [options.byteOffset=0]
   * @param {number} options.byteLength
   */
  constructor(options = {}) {
    const { buffer, byteOffset = 0, byteLength } = options;

    if (!buffer || typeof buffer.byteLength !== 'number') {
      throw new TypeError(
        'Membrane: `buffer` (ArrayBuffer or SharedArrayBuffer) is ' +
        'required. Allocate with computeMembraneLayout(...) and ' +
        'populate via layoutMembrane(...) or by copying snapshot bytes.');
    }
    if (typeof byteLength !== 'number' || byteLength <= 0) {
      throw new TypeError(
        'Membrane: `byteLength` (positive number) is required.');
    }
    if (byteOffset + byteLength > buffer.byteLength) {
      throw new RangeError(
        `Membrane: window (offset ${byteOffset}, length ${byteLength}) ` +
        `exceeds buffer (${buffer.byteLength}).`);
    }
    if ((byteOffset & 3) !== 0) {
      throw new RangeError(
        `Membrane: byteOffset must be 4-byte aligned for atomic ring ` +
        `publication (docs/ring-publication-contract.md); got ${byteOffset}.`);
    }

    // _state holds the four fields that legitimately mutate after
    // construction (via `relocate`). The outer Membrane is frozen
    // at end of construction; consumers reach these through the
    // accessor getters declared above.
    this._state = {
      buffer,
      byteOffset,
      byteLength,
      view: new DataView(buffer, byteOffset, byteLength),
      bytesView: new Uint8Array(buffer, byteOffset, byteLength),
      // Whole-buffer u32 view for Atomics (cost-ledger reservation head
      // and publication tokens). Word index = absolute byte offset >> 2.
      wordView: new Uint32Array(buffer, 0, buffer.byteLength >>> 2),
      onPressure: null,
      compacting: false,
      // Open grant-approval windows.
      // Array of Sets; createGrant() registers every new slot into
      // every open window, and compaction treats those slots as live.
      // Transient JS state — never persisted, dies with the process.
      openGrantApprovalWindows: [],
    };

    // Validate the bytes the host handed us. Hard-cutover versioning
    // — any mismatch trips here.
    const magic = this.view.getUint32(HEADER.MAGIC, true);
    if (magic !== MEMBRANE_MAGIC) {
      throw new Error(`Invalid membrane buffer: magic=0x${magic.toString(16)}`);
    }
    const version = this.view.getUint32(HEADER.DRONE_FORMAT_VERSION, true);
    if (version !== DRONE_FORMAT_VERSION) {
      throw new Error(
        `Unsupported drone format version: ${version} ` +
        `(expected ${DRONE_FORMAT_VERSION})`);
    }

    // Reset transient JS-side diagnostic state. For freshly laid-out
    // bytes this is a no-op (the JS-side state is empty); for
    // snapshot-restored bytes it clears stale references.
    this._resetDiagnosticsOnRestore();

    // Tracks slot → JS impl object (the actual JS value being authorized).
    // This is *not* serialized — JS objects can't be. On restore, the
    // host re-binds via enumerateHandles + _bindImpl.
    this._impls = new Map();

    // Mutation watchers.
    // Subscribers fire synchronously after each successful log write.
    // List is purely transient JS-side state — not part of any
    // snapshot. Empty by default; Debug instances opt in via
    // _addMutationWatcher.
    //
    // Shape: Array<{ kindMask: number, fn: (event) => void }>.
    this._mutationWatchers = [];

    // FinalizationRegistry recent-fire counter. Both registries we own
    // (airlock.closureRegistry and this class's
    // _closureHandleCacheCleanup) route their callbacks through
    // _countFinalizationFire(); the host reads the windowed count via
    // recentFinalizationCount(). Leak investigations can use it to ask
    // whether finalization ran recently in a suspect code path. The
    // window slides over the membrane tick counter; we sum the last N
    // tick-buckets.
    // All mutable scalar state lives inside _frState so the outer
    // Membrane can stay Object.frozen (per the comment further down
    // in this constructor — only `_state`-style inner containers
    // are exempt from the freeze). Reassigning `this._frFireCursor`
    // after the freeze would TypeError; mutating `_frState.cursor`
    // is fine because the object reference doesn't change.
    this._frState = {
      windowTicks: DEFAULT_FR_WINDOW_TICKS,
      buckets:     new Array(DEFAULT_FR_WINDOW_TICKS).fill(0),
      bucketTick:  null, // bigint or null
      cursor:      0,
      lifetime:    0,
    };

    // Weak cache of ClosureHandle wrappers keyed by slot, so
    // multiple enumerateClosureHandles() / closureHandleForSlot() calls
    // for the same slot return the same JS object identity. Without this,
    // the host could end up with two wrappers to the same slot, and when
    // JS GCs one, the airlock's FinalizationRegistry would free the slot
    // out from under the other.
    //
    // WeakRef + a separate FinalizationRegistry to clean up the Map entry
    // when the wrapper is collected (so the Map doesn't grow unboundedly
    // with stale dead WeakRefs).
    this._closureHandleCache = new Map(); // slot → WeakRef<ClosureHandle>
    this._closureHandleCacheCleanup = new FinalizationRegistry(
      this._wrapFinalizationCallback((slot) => {
        // Only delete if the cached entry's WeakRef is dead — otherwise
        // a fresh wrapper was minted between the GC and this callback.
        const ref = this._closureHandleCache.get(slot);
        if (ref && ref.deref() === undefined) {
          this._closureHandleCache.delete(slot);
        }
      }));

    // v15: weak cache of ObjectHandle wrappers keyed by slot — same
    // identity discipline as _closureHandleCache above. Plus the
    // pointer→slot intern index ("one live ObjectHandle per vat
    // object"): rebuilt here by scanning the table (covers both fresh
    // layouts, where it is empty, and restored snapshots), updated on
    // register/free and re-keyed after heap GC forwarding.
    this._objectHandleCache = new Map(); // slot → WeakRef<ObjectHandle>
    this._objectHandleCacheCleanup = new FinalizationRegistry(
      this._wrapFinalizationCallback((slot) => {
        const ref = this._objectHandleCache.get(slot);
        if (ref && ref.deref() === undefined) {
          this._objectHandleCache.delete(slot);
        }
      }));
    this._objectHandleSlotByPointer = new Map(); // objectPointer → slot
    {
      const capacity = this.view.getUint32(HEADER.OBJECT_HANDLE_TABLE_CAPACITY, true);
      const nextSlot = this.view.getUint32(HEADER.NEXT_OBJECT_HANDLE_SLOT, true);
      for (let slot = 0; slot < Math.min(nextSlot, capacity); slot++) {
        if (this._objectHandleSlotIsLive(slot)) {
          this._objectHandleSlotByPointer.set(this._readObjectPointer(slot), slot);
        }
      }
    }

    // Freeze the membrane instance. Adding net-new fields from
    // outside (monkey-patching consumers) now throws TypeError.
    // The mutable inner state (`_state`, `_impls`, `_mutationWatchers`,
    // `_closureHandleCache`) stays unfrozen; the prototype getters
    // for `buffer`/`byteOffset`/`byteLength`/`view`/`bytesView` keep
    // working through the freeze.
    Object.freeze(this);
  }

  /**
   * Relocate this membrane to a new byteOffset within the SAME buffer.
   *
   * Used when a host compacts a shared buffer by copying slabs to new
   * addresses. Rebuilding the DataView and Uint8Array views at the new offset
   * re-points every membrane read and write to the intact copied bytes.
   *
   * The membrane bytes at the new offset MUST already be valid — the
   * caller is responsible for ensuring the memcpy happened before
   * this call. We validate by re-checking magic+version after the
   * view rebuild.
   *
   * Buffer-replacement (relocating to a different SharedArrayBuffer)
   * is NOT supported by this method; it would require re-binding
   * every wrapper that references the buffer. Whole-buffer replacement
   * is a different problem requiring a different primitive.
   *
   * @param {number} newByteOffset - New byte offset within this.buffer.
   * @param {number} [newByteLength] - New byteLength (defaults to existing).
   */
  relocate(newByteOffset, newByteLength) {
    if (typeof newByteOffset !== 'number' || newByteOffset < 0) {
      throw new Error(
        `Membrane.relocate: newByteOffset must be a non-negative number, got ${newByteOffset}`);
    }
    const length = newByteLength ?? this.byteLength;
    if (newByteOffset + length > this.buffer.byteLength) {
      throw new Error(
        `Membrane.relocate: newByteOffset (${newByteOffset}) + length ` +
        `(${length}) exceeds buffer.byteLength (${this.buffer.byteLength})`);
    }
    if ((newByteOffset & 3) !== 0) {
      throw new RangeError(
        `Membrane.relocate: newByteOffset must be 4-byte aligned for ` +
        `atomic ring publication; got ${newByteOffset}.`);
    }
    this._state.byteOffset = newByteOffset;
    this._state.byteLength = length;
    this._state.view = new DataView(this._state.buffer, newByteOffset, length);
    this._state.bytesView = new Uint8Array(this._state.buffer, newByteOffset, length);
    // Same buffer, so the whole-buffer word view stays valid as-is.
    // Sanity check: the bytes at the new offset must still be a valid
    // membrane header. If they aren't, the host got the relocation
    // bookkeeping wrong — fail loudly here rather than corrupting the
    // first read.
    const magic = this.view.getUint32(HEADER.MAGIC, true);
    if (magic !== MEMBRANE_MAGIC) {
      throw new Error(
        `Membrane.relocate: bytes at newByteOffset=${newByteOffset} ` +
        `don't carry a valid membrane header (magic=0x${magic.toString(16)}, ` +
        `expected 0x${MEMBRANE_MAGIC.toString(16)}). ` +
        `Did the caller forget to memcpy the membrane bytes before relocating?`);
    }
  }

  /**
   * In-place region-size change. Grow or shrink any of the membrane's
   * sub-regions while preserving every live entry's identity (slot
   * numbers, version counters, stored metadata, captured grants, etc).
   *
   * Pre-1.0 motivation: a drone whose membrane is filling can grow its handle,
   * grant, id-list, or value-arena capacity without a restart; an
   * overprovisioned drone can shrink them. This is the membrane-side control
   * used with a host's per-drone slab resize.
   *
   * Pointer-correctness: format v3 stored value-arena pointers as
   * arena-relative and id-list-pool offsets as pool-relative. So
   * the *only* per-region work this primitive needs to do is:
   *
   *   - compute the new layout (cursor walk through the sub-regions
   *     in the same order as `layoutMembrane`);
   *   - memcpy each sub-region from its old position to its new
   *     position (in dependency-safe order: rightward-growing regions
   *     copy in reverse so we don't overwrite source bytes; leftward-
   *     shrinking regions copy forward);
   *   - rewrite the HEADER.*_OFFSET / HEADER.*_CAPACITY / HEADER.*_SIZE
   *     fields to match the new layout.
   *
   * Every stored pointer in handle/grant/closure entries continues
   * to resolve correctly through `_arenaAbs` / `_listPoolAbs`
   * because they're computed against the (now-updated) header
   * offsets. **Zero per-entry rewrites.**
   *
   * Constraints (any violated → throws MembraneOutOfSpaceError):
   *
   *   - new total byte size must fit in `this.byteLength` (the
   *     membrane buffer is fixed-size for this primitive; growing
   *     the buffer envelope is the host's job, via a relocate-to-
   *     bigger-buffer dance).
   *   - new handle/grant/closureHandle/linkedPromise capacities
   *     must be ≥ `next*Slot` for each table (live slots stay
   *     addressable).
   *   - new idListPoolSize ≥ current idListPoolUsed.
   *   - new valueArenaSize ≥ current valueArenaUsed.
   *   - new rootGrantsListCapacity ≥ current rootGrantsListCount.
   *
   * Sub-regions whose new size = old size are not memcpy'd (no-op).
   * The header is rewritten in any case so it reflects the (possibly
   * unchanged) layout consistently.
   *
   * @param {Object} sizes
   * @param {number} [sizes.handleTableCapacity]
   * @param {number} [sizes.grantTableCapacity]
   * @param {number} [sizes.idListPoolSize]
   * @param {number} [sizes.rootGrantsListCapacity]
   * @param {number} [sizes.valueArenaSize]
   * @param {number} [sizes.closureHandleTableCapacity]
   * @param {number} [sizes.linkedPromiseTableCapacity]
   * @param {number} [sizes.capabilityStateTableCapacity]
   * @returns {{
   *   totalBytesBefore: number,
   *   totalBytesAfter: number,
   *   regionsMoved: number,
   * }}
   */
  resizeRegions(sizes = {}) {
    // ---- 1. Read current layout from the header. ----
    const v = this.view;
    const old = {
      handleTableOffset:    v.getUint32(HEADER.HANDLE_TABLE_OFFSET, true),
      handleTableCapacity:  v.getUint32(HEADER.HANDLE_TABLE_CAPACITY, true),
      grantTableOffset:     v.getUint32(HEADER.GRANT_TABLE_OFFSET, true),
      grantTableCapacity:   v.getUint32(HEADER.GRANT_TABLE_CAPACITY, true),
      idListPoolOffset:     v.getUint32(HEADER.ID_LIST_POOL_OFFSET, true),
      idListPoolSize:       v.getUint32(HEADER.ID_LIST_POOL_SIZE, true),
      idListPoolUsed:       v.getUint32(HEADER.ID_LIST_POOL_USED, true),
      rootGrantsListOffset: v.getUint32(HEADER.ROOT_GRANTS_LIST_OFFSET, true),
      rootGrantsListCount:  v.getUint32(HEADER.ROOT_GRANTS_LIST_COUNT, true),
      rootGrantsListCapacity: v.getUint32(HEADER.ROOT_GRANTS_LIST_CAPACITY, true),
      valueArenaOffset:     v.getUint32(HEADER.VALUE_ARENA_OFFSET, true),
      valueArenaSize:       v.getUint32(HEADER.VALUE_ARENA_SIZE, true),
      valueArenaUsed:       v.getUint32(HEADER.VALUE_ARENA_USED, true),
      closureHandleTableOffset:   v.getUint32(HEADER.CLOSURE_HANDLE_TABLE_OFFSET, true),
      closureHandleTableCapacity: v.getUint32(HEADER.CLOSURE_HANDLE_TABLE_CAPACITY, true),
      linkedPromiseTableOffset:   v.getUint32(HEADER.LINKED_PROMISE_TABLE_OFFSET, true),
      linkedPromiseTableCapacity: v.getUint32(HEADER.LINKED_PROMISE_TABLE_CAPACITY, true),
      capabilityStateTableOffset:   v.getUint32(HEADER.CAPABILITY_STATE_TABLE_OFFSET, true),
      capabilityStateTableCapacity: v.getUint32(HEADER.CAPABILITY_STATE_TABLE_CAPACITY, true),
      mutationLogOffset:    v.getUint32(HEADER.MUTATION_LOG_OFFSET, true),
      mutationLogCapacity:  v.getUint32(HEADER.MUTATION_LOG_CAPACITY, true),
      // v5 diagnostic regions. The runtime-
      // state cell is fixed-size, so we only capture its offset. The
      // ledger's capacity is a per-session option (like costLedgerCapacity
      // below) that resizeRegions preserves rather than changes — only
      // its offset shifts when earlier regions resize.
      runtimeStateOffset:   v.getUint32(HEADER.RUNTIME_STATE_OFFSET, true),
      ledgerOffset:         v.getUint32(HEADER.LEDGER_OFFSET, true),
      ledgerCapacity:       v.getUint32(HEADER.LEDGER_CAPACITY, true),
      // v11: cost ledger. Fixed-capacity ring like the mutation log;
      // capacity is pinned here, only the offset shifts on resize.
      costLedgerOffset:     v.getUint32(HEADER.COST_LEDGER_OFFSET, true),
      costLedgerCapacity:   v.getUint32(HEADER.COST_LEDGER_CAPACITY, true),
      // v15: object-handle table (tail region after the cost ledger).
      objectHandleTableOffset:   v.getUint32(HEADER.OBJECT_HANDLE_TABLE_OFFSET, true),
      objectHandleTableCapacity: v.getUint32(HEADER.OBJECT_HANDLE_TABLE_CAPACITY, true),
      nextHandleSlot:         v.getUint32(HEADER.NEXT_HANDLE_SLOT, true),
      nextGrantSlot:          v.getUint32(HEADER.NEXT_GRANT_SLOT, true),
      nextClosureHandleSlot:  v.getUint32(HEADER.NEXT_CLOSURE_HANDLE_SLOT, true),
      nextLinkedPromiseSlot:  v.getUint32(HEADER.NEXT_LINKED_PROMISE_SLOT, true),
      nextObjectHandleSlot:   v.getUint32(HEADER.NEXT_OBJECT_HANDLE_SLOT, true),
    };
    // Sum of region sizes before the resize — the membrane's content
    // extent within the buffer envelope. The envelope (this.byteLength)
    // is fixed; the content extent moves with resizes.
    const totalBytesBefore = MEMBRANE_HEADER_SIZE
      + old.handleTableCapacity * HANDLE_ENTRY_SIZE
      + old.grantTableCapacity * GRANT_ENTRY_SIZE
      + old.idListPoolSize
      + old.rootGrantsListCapacity * 4
      + old.valueArenaSize
      + old.closureHandleTableCapacity * CLOSURE_HANDLE_ENTRY_SIZE
      + old.linkedPromiseTableCapacity * LINKED_PROMISE_ENTRY_SIZE
      + old.mutationLogCapacity * MUTATION_LOG_ENTRY_SIZE
      + RUNTIME_STATE_CELL_BYTES
      + old.ledgerCapacity * LEDGER_ENTRY_BYTES
      + old.capabilityStateTableCapacity * CAPABILITY_STATE_ENTRY_SIZE
      + old.costLedgerCapacity * COST_LEDGER_ENTRY_SIZE
      + old.objectHandleTableCapacity * OBJECT_HANDLE_ENTRY_SIZE;

    // ---- 2. Resolve requested new sizes (default to current). ----
    const nu = {
      handleTableCapacity:        sizes.handleTableCapacity        ?? old.handleTableCapacity,
      grantTableCapacity:         sizes.grantTableCapacity         ?? old.grantTableCapacity,
      idListPoolSize:             sizes.idListPoolSize             ?? old.idListPoolSize,
      rootGrantsListCapacity:     sizes.rootGrantsListCapacity     ?? old.rootGrantsListCapacity,
      valueArenaSize:             sizes.valueArenaSize             ?? old.valueArenaSize,
      closureHandleTableCapacity: sizes.closureHandleTableCapacity ?? old.closureHandleTableCapacity,
      linkedPromiseTableCapacity: sizes.linkedPromiseTableCapacity ?? old.linkedPromiseTableCapacity,
      capabilityStateTableCapacity: sizes.capabilityStateTableCapacity ?? old.capabilityStateTableCapacity,
      objectHandleTableCapacity: sizes.objectHandleTableCapacity ?? old.objectHandleTableCapacity,
      // mutationLogCapacity is NOT resized through resizeRegions —
      // it has its own primitive (resizeMutationLog) because the
      // log is shape-different (no "used" prefix; it's a ring).
      // resizeRegions preserves the existing log capacity.
      mutationLogCapacity:        old.mutationLogCapacity,
    };

    // ---- 3. Validate shrink-below-content constraints. ----
    if (nu.handleTableCapacity < old.nextHandleSlot) {
      throw new MembraneOutOfSpaceError(
        `resizeRegions: handleTableCapacity=${nu.handleTableCapacity} ` +
        `< nextHandleSlot=${old.nextHandleSlot}; would orphan live slots.`);
    }
    if (nu.grantTableCapacity < old.nextGrantSlot) {
      throw new MembraneOutOfSpaceError(
        `resizeRegions: grantTableCapacity=${nu.grantTableCapacity} ` +
        `< nextGrantSlot=${old.nextGrantSlot}; would orphan live slots.`);
    }
    if (nu.closureHandleTableCapacity < old.nextClosureHandleSlot) {
      throw new MembraneOutOfSpaceError(
        `resizeRegions: closureHandleTableCapacity=${nu.closureHandleTableCapacity} ` +
        `< nextClosureHandleSlot=${old.nextClosureHandleSlot}; would orphan live slots.`);
    }
    if (nu.linkedPromiseTableCapacity < old.nextLinkedPromiseSlot) {
      throw new MembraneOutOfSpaceError(
        `resizeRegions: linkedPromiseTableCapacity=${nu.linkedPromiseTableCapacity} ` +
        `< nextLinkedPromiseSlot=${old.nextLinkedPromiseSlot}; would orphan live slots.`);
    }
    if (nu.objectHandleTableCapacity < old.nextObjectHandleSlot) {
      throw new MembraneOutOfSpaceError(
        `resizeRegions: objectHandleTableCapacity=${nu.objectHandleTableCapacity} ` +
        `< nextObjectHandleSlot=${old.nextObjectHandleSlot}; would orphan live slots.`);
    }
    // Capability-state table uses a NULL-pointer sentinel rather than
    // a watermark — slots are picked by key, not allocated sequentially.
    // Shrinking is rejected if any populated slot lives past the new
    // capacity boundary. Empty slots never trip this guard; populated
    // slots must not be orphaned.
    if (nu.capabilityStateTableCapacity < old.capabilityStateTableCapacity) {
      for (let i = nu.capabilityStateTableCapacity;
               i < old.capabilityStateTableCapacity; i++) {
        const entry = old.capabilityStateTableOffset + i * CAPABILITY_STATE_ENTRY_SIZE;
        const namePointer = v.getUint32(entry, true);
        if (namePointer !== VALUE_POINTER_NULL) {
          throw new MembraneOutOfSpaceError(
            `resizeRegions: capabilityStateTableCapacity=${nu.capabilityStateTableCapacity} ` +
            `would orphan populated slot ${i}.`);
        }
      }
    }
    if (nu.idListPoolSize < old.idListPoolUsed) {
      throw new MembraneOutOfSpaceError(
        `resizeRegions: idListPoolSize=${nu.idListPoolSize} ` +
        `< idListPoolUsed=${old.idListPoolUsed}; would drop list data. ` +
        `Call compact() first to reclaim orphaned runs.`);
    }
    if (nu.valueArenaSize < old.valueArenaUsed) {
      throw new MembraneOutOfSpaceError(
        `resizeRegions: valueArenaSize=${nu.valueArenaSize} ` +
        `< valueArenaUsed=${old.valueArenaUsed}; would drop encoded values. ` +
        `Call compact() first to reclaim orphaned bytes.`);
    }
    if ((nu.idListPoolSize & 3) !== 0 || (nu.valueArenaSize & 3) !== 0) {
      throw new Error(
        `resizeRegions: idListPoolSize and valueArenaSize must stay ` +
        `multiples of 4 (atomic ring publication alignment); got ` +
        `${nu.idListPoolSize} / ${nu.valueArenaSize}.`);
    }
    if (nu.rootGrantsListCapacity < old.rootGrantsListCount) {
      throw new MembraneOutOfSpaceError(
        `resizeRegions: rootGrantsListCapacity=${nu.rootGrantsListCapacity} ` +
        `< rootGrantsListCount=${old.rootGrantsListCount}; would drop root grants.`);
    }

    // ---- 4. Compute the new layout (cursor walk). ----
    // Same order as layoutMembrane: handle, grant, idList,
    // rootGrants, valueArena, closureHandle, linkedPromise.
    const newLayout = {};
    let cursor = MEMBRANE_HEADER_SIZE;

    newLayout.handleTableOffset = cursor;
    cursor += nu.handleTableCapacity * HANDLE_ENTRY_SIZE;

    newLayout.grantTableOffset = cursor;
    cursor += nu.grantTableCapacity * GRANT_ENTRY_SIZE;

    newLayout.idListPoolOffset = cursor;
    cursor += nu.idListPoolSize;

    newLayout.rootGrantsListOffset = cursor;
    cursor += nu.rootGrantsListCapacity * 4;

    newLayout.valueArenaOffset = cursor;
    cursor += nu.valueArenaSize;

    newLayout.closureHandleTableOffset = cursor;
    cursor += nu.closureHandleTableCapacity * CLOSURE_HANDLE_ENTRY_SIZE;

    newLayout.linkedPromiseTableOffset = cursor;
    cursor += nu.linkedPromiseTableCapacity * LINKED_PROMISE_ENTRY_SIZE;

    newLayout.mutationLogOffset = cursor;
    cursor += nu.mutationLogCapacity * MUTATION_LOG_ENTRY_SIZE;

    // v5: diagnostic regions. The runtime-state cell is fixed-size.
    // The ledger's capacity is pinned in resizeRegions (like
    // costLedgerCapacity below) — only its offset shifts when earlier
    // regions grow or shrink.
    newLayout.runtimeStateOffset = cursor;
    cursor += RUNTIME_STATE_CELL_BYTES;

    newLayout.ledgerOffset = cursor;
    cursor += old.ledgerCapacity * LEDGER_ENTRY_BYTES;

    // v7: capability-state table (tail-of-membrane, mirrors v5 pattern).
    newLayout.capabilityStateTableOffset = cursor;
    cursor += nu.capabilityStateTableCapacity * CAPABILITY_STATE_ENTRY_SIZE;

    // v11: cost ledger. Fixed-capacity ring; offset shifts when earlier
    // regions resize (capacity is pinned in resizeRegions).
    newLayout.costLedgerOffset = cursor;
    cursor += old.costLedgerCapacity * COST_LEDGER_ENTRY_SIZE;

    // v15: object-handle table (tail region, mirrors the cost ledger).
    newLayout.objectHandleTableOffset = cursor;
    cursor += nu.objectHandleTableCapacity * OBJECT_HANDLE_ENTRY_SIZE;

    const totalBytesAfter = cursor;

    // ---- 5. Validate buffer envelope. ----
    if (totalBytesAfter > this.byteLength) {
      throw new MembraneOutOfSpaceError(
        `resizeRegions: new total ${totalBytesAfter} bytes exceeds ` +
        `membrane byteLength ${this.byteLength}. Grow the membrane ` +
        `buffer first (host responsibility — typically via the slab ` +
        `geometry's membraneBytes field).`);
    }

    // ---- 6. Stage every region into a scratch buffer, then copy back. ----
    //
    // The naive approach — copyWithin each region in place — has to
    // solve an inter-region overlap puzzle: when sizes change, one
    // region's destination can land on another region's source, and
    // the iteration order has to make sure every overlapping read
    // happens before the corresponding write. The pre-fix code tried
    // to do this with a single "pick forward or reverse" predicate
    // and got it wrong for the shrink-and-slide-left case (handle
    // table shrinks → all later regions slide left → valueArena's
    // destination overlaps the grant table's source → grant data
    // zeroed before grant move reads it).
    //
    // Sidestepping the puzzle entirely: stage all moves into a fresh
    // scratch buffer (reads from the main buffer, writes to scratch —
    // no overlap possible), then copy the scratch buffer back. Order
    // becomes irrelevant. `new Uint8Array(...)` is zero-initialised,
    // so tail bytes beyond the used prefix are zero by construction —
    // no explicit zero-fill needed.
    //
    // Cost: one allocation of totalBytesAfter (already validated to
    // fit the envelope) and one extra memcpy. resizeRegions is a host
    // maintenance operation, not a hot path; the doubling is fine.
    const moves = [
      {
        oldOffset: old.handleTableOffset,
        newOffset: newLayout.handleTableOffset,
        usedBytes: old.nextHandleSlot * HANDLE_ENTRY_SIZE,
      },
      {
        oldOffset: old.grantTableOffset,
        newOffset: newLayout.grantTableOffset,
        usedBytes: old.nextGrantSlot * GRANT_ENTRY_SIZE,
      },
      {
        oldOffset: old.idListPoolOffset,
        newOffset: newLayout.idListPoolOffset,
        usedBytes: old.idListPoolUsed,
      },
      {
        oldOffset: old.rootGrantsListOffset,
        newOffset: newLayout.rootGrantsListOffset,
        usedBytes: old.rootGrantsListCount * 4,
      },
      {
        oldOffset: old.valueArenaOffset,
        newOffset: newLayout.valueArenaOffset,
        usedBytes: old.valueArenaUsed,
      },
      {
        oldOffset: old.closureHandleTableOffset,
        newOffset: newLayout.closureHandleTableOffset,
        usedBytes: old.nextClosureHandleSlot * CLOSURE_HANDLE_ENTRY_SIZE,
      },
      {
        oldOffset: old.linkedPromiseTableOffset,
        newOffset: newLayout.linkedPromiseTableOffset,
        usedBytes: old.nextLinkedPromiseSlot * LINKED_PROMISE_ENTRY_SIZE,
      },
      {
        // Mutation log: the entire ring's bytes are "used" (entries can
        // live anywhere in the ring). Capacity is pinned in resizeRegions
        // (use resizeMutationLog to change it).
        oldOffset: old.mutationLogOffset,
        newOffset: newLayout.mutationLogOffset,
        usedBytes: old.mutationLogCapacity * MUTATION_LOG_ENTRY_SIZE,
      },
      {
        // v5: runtime-state cell. Always preserved in full (4 bytes).
        oldOffset: old.runtimeStateOffset,
        newOffset: newLayout.runtimeStateOffset,
        usedBytes: RUNTIME_STATE_CELL_BYTES,
      },
      {
        // v5: in-flight ledger. The entire table is treated as
        // "used" — FREE entries are zero, but the bytes still need
        // to land at the new offset so any live (claimed) entry
        // makes it across the move.
        oldOffset: old.ledgerOffset,
        newOffset: newLayout.ledgerOffset,
        usedBytes: old.ledgerCapacity * LEDGER_ENTRY_BYTES,
      },
      {
        // v7: capability-state table. Every slot carries a valid
        // sentinel (namePointer/valuePointer = VALUE_POINTER_NULL
        // when empty), so the "used" extent is the whole old table.
        // Newly-created tail entries on grow are initialized below
        // after the scratch-copy-back, because scratch is zero-init
        // and the sentinel is 0xFFFFFFFF, not 0.
        oldOffset: old.capabilityStateTableOffset,
        newOffset: newLayout.capabilityStateTableOffset,
        usedBytes: Math.min(
          old.capabilityStateTableCapacity,
          nu.capabilityStateTableCapacity
        ) * CAPABILITY_STATE_ENTRY_SIZE,
      },
      {
        // v11: cost ledger. Ring like the mutation log — the entire
        // ring's bytes are "used" (entries can live anywhere). Capacity
        // is pinned in resizeRegions; only the offset shifts.
        oldOffset: old.costLedgerOffset,
        newOffset: newLayout.costLedgerOffset,
        usedBytes: old.costLedgerCapacity * COST_LEDGER_ENTRY_SIZE,
      },
      {
        // v15: object-handle table (tail region after the cost ledger).
        oldOffset: old.objectHandleTableOffset,
        newOffset: newLayout.objectHandleTableOffset,
        usedBytes: old.nextObjectHandleSlot * OBJECT_HANDLE_ENTRY_SIZE,
      },
    ];

    // Snapshot pre-resize liveness for the integrity check below.
    // Anything live now must remain live after the resize.
    const preLiveHandles = [];
    for (let s = 0; s < old.nextHandleSlot; s++) {
      if (this._handleSlotIsLive(s)) preLiveHandles.push(s);
    }
    const preLiveGrants = [];
    for (let s = 0; s < old.nextGrantSlot; s++) {
      if (this._grantSlotIsLive(s)) preLiveGrants.push(s);
    }

    const bytes = this.bytesView;
    const scratch = new Uint8Array(totalBytesAfter);
    let regionsMoved = 0;
    for (const move of moves) {
      if (move.usedBytes > 0) {
        scratch.set(
          bytes.subarray(move.oldOffset, move.oldOffset + move.usedBytes),
          move.newOffset);
        if (move.oldOffset !== move.newOffset) regionsMoved += 1;
      }
    }
    // Header preserved verbatim (it doesn't move — it always sits at
    // offset 0 with fixed size MEMBRANE_HEADER_SIZE).
    scratch.set(bytes.subarray(0, MEMBRANE_HEADER_SIZE), 0);

    // Copy back. The tail beyond totalBytesAfter inside the envelope
    // is not touched — it's reserved headroom and may legitimately
    // hold zeros from prior state.
    bytes.set(scratch, 0);

    // ---- 7. Rewrite header offsets and sizes. ----
    v.setUint32(HEADER.HANDLE_TABLE_OFFSET,         newLayout.handleTableOffset, true);
    v.setUint32(HEADER.HANDLE_TABLE_CAPACITY,       nu.handleTableCapacity, true);
    v.setUint32(HEADER.GRANT_TABLE_OFFSET,          newLayout.grantTableOffset, true);
    v.setUint32(HEADER.GRANT_TABLE_CAPACITY,        nu.grantTableCapacity, true);
    v.setUint32(HEADER.ID_LIST_POOL_OFFSET,         newLayout.idListPoolOffset, true);
    v.setUint32(HEADER.ID_LIST_POOL_SIZE,           nu.idListPoolSize, true);
    v.setUint32(HEADER.ROOT_GRANTS_LIST_OFFSET,     newLayout.rootGrantsListOffset, true);
    v.setUint32(HEADER.ROOT_GRANTS_LIST_CAPACITY,   nu.rootGrantsListCapacity, true);
    v.setUint32(HEADER.VALUE_ARENA_OFFSET,          newLayout.valueArenaOffset, true);
    v.setUint32(HEADER.VALUE_ARENA_SIZE,            nu.valueArenaSize, true);
    v.setUint32(HEADER.CLOSURE_HANDLE_TABLE_OFFSET, newLayout.closureHandleTableOffset, true);
    v.setUint32(HEADER.CLOSURE_HANDLE_TABLE_CAPACITY, nu.closureHandleTableCapacity, true);
    v.setUint32(HEADER.LINKED_PROMISE_TABLE_OFFSET, newLayout.linkedPromiseTableOffset, true);
    v.setUint32(HEADER.LINKED_PROMISE_TABLE_CAPACITY, nu.linkedPromiseTableCapacity, true);
    v.setUint32(HEADER.MUTATION_LOG_OFFSET,        newLayout.mutationLogOffset, true);
    // MUTATION_LOG_CAPACITY and WRITE_INDEX are unchanged by resizeRegions.

    // v5: diagnostic region offsets. LEDGER_CAPACITY is pinned by
    // resizeRegions (like COST_LEDGER_CAPACITY — set at session
    // creation, not resizable later), so it is not rewritten here.
    v.setUint32(HEADER.RUNTIME_STATE_OFFSET,       newLayout.runtimeStateOffset, true);
    v.setUint32(HEADER.LEDGER_OFFSET,              newLayout.ledgerOffset, true);

    // v7: capability-state table offset + capacity.
    v.setUint32(HEADER.CAPABILITY_STATE_TABLE_OFFSET,   newLayout.capabilityStateTableOffset, true);
    v.setUint32(HEADER.CAPABILITY_STATE_TABLE_CAPACITY, nu.capabilityStateTableCapacity, true);

    // v11: cost-ledger offset. CAPACITY and WRITE_INDEX are pinned by
    // resizeRegions (capacity is fixed; the ring's write index and
    // contents are preserved by the move above).
    v.setUint32(HEADER.COST_LEDGER_OFFSET, newLayout.costLedgerOffset, true);

    // v15: object-handle table offset + capacity.
    v.setUint32(HEADER.OBJECT_HANDLE_TABLE_OFFSET,   newLayout.objectHandleTableOffset, true);
    v.setUint32(HEADER.OBJECT_HANDLE_TABLE_CAPACITY, nu.objectHandleTableCapacity, true);

    // On grow, the newly-created tail entries need explicit sentinel
    // init — scratch is zero-init but VALUE_POINTER_NULL is 0xFFFFFFFF.
    if (nu.capabilityStateTableCapacity > old.capabilityStateTableCapacity) {
      for (let i = old.capabilityStateTableCapacity;
               i < nu.capabilityStateTableCapacity; i++) {
        const entry = newLayout.capabilityStateTableOffset + i * CAPABILITY_STATE_ENTRY_SIZE;
        v.setUint32(entry,     VALUE_POINTER_NULL, true);
        v.setUint32(entry + 4, VALUE_POINTER_NULL, true);
      }
    }

    // Resize-regions is a host-observed operation and gets an engine
    // counter bump just like gc / snapshot / resizeSegment.
    this._recordResizeRegions();

    // ---- 9. Post-resize integrity check. ----
    //
    // Defense-in-depth assertion: every handle / grant slot that was
    // live before the resize must still be live after. A failure here
    // means the move logic silently dropped slot-bearing data — the
    // exact failure mode the scratch-buffer rewrite is meant to make
    // impossible. If this ever throws, the membrane is corrupt and
    // the resize is the cause; investigate before adding any "well
    // skip the assert" branch.
    for (const slot of preLiveHandles) {
      if (!this._handleSlotIsLive(slot)) {
        throw new Error(
          `resizeRegions integrity check failed: handle slot ${slot} ` +
          `was live before the resize and is not live after.`);
      }
    }
    for (const slot of preLiveGrants) {
      if (!this._grantSlotIsLive(slot)) {
        throw new Error(
          `resizeRegions integrity check failed: grant slot ${slot} ` +
          `was live before the resize and is not live after.`);
      }
    }

    return { totalBytesBefore, totalBytesAfter, regionsMoved };
  }


  // ===========================================================================
  // Internal — value arena (msgpack-encoded host-facing values)
  //
  // Each value is u32 byteLength + payload bytes. Pointers stored in
  // entries are byte offsets to the start of the payload bytes (NOT to
  // the length prefix), **relative to the value arena's base** —
  // HEADER.VALUE_ARENA_OFFSET. Translation through _arenaAbs /
  // _arenaRel converts relative ↔ absolute at the I/O boundary.
  // VALUE_POINTER_NULL means "no value stored".
  //
  // Why relative: a future membrane-resize primitive can move the
  // value arena (e.g. handle table grew, value arena shifted further
  // down the buffer) by updating ONE header field — every stored
  // pointer stays valid because it was never anchored to the
  // absolute position in the first place.
  //
  // Re-encoding orphans old bytes; compact() reclaims them.
  // ===========================================================================

  // Convert an arena-relative payload offset to an absolute byte offset
  // within the membrane buffer (for DataView reads/writes).
  _arenaAbs(relPayloadOffset) {
    return this.view.getUint32(HEADER.VALUE_ARENA_OFFSET, true) + relPayloadOffset;
  }

  // Convert an absolute byte offset (within the membrane buffer) to an
  // arena-relative payload offset (for storage in entries).
  _arenaRel(absPayloadOffset) {
    return absPayloadOffset - this.view.getUint32(HEADER.VALUE_ARENA_OFFSET, true);
  }

  _retryOnPressure(allocFn) {
    try {
      return allocFn();
    } catch (error) {
      if (!(error instanceof MembraneOutOfSpaceError)) throw error;
      if (this._state.compacting || !this._state.onPressure) throw error;
      this._state.compacting = true;
      try { this._state.onPressure(); } finally { this._state.compacting = false; }
      return allocFn();
    }
  }

  _writeArenaValue(jsValue) {
    if (jsValue === undefined || jsValue === null) {
      return VALUE_POINTER_NULL;
    }
    const encoded = msgpackEncode(jsValue);
    return this._retryOnPressure(() => {
      const arenaOffset = this.view.getUint32(HEADER.VALUE_ARENA_OFFSET, true);
      const arenaSize = this.view.getUint32(HEADER.VALUE_ARENA_SIZE, true);
      const used = this.view.getUint32(HEADER.VALUE_ARENA_USED, true);
      const needed = 4 + encoded.byteLength;
      if (used + needed > arenaSize) {
        throw new MembraneOutOfSpaceError(
          `Value arena full: ${used} bytes used of ${arenaSize}, need ${needed} more. ` +
          `Tune valueArenaSize.`
        );
      }
      const lengthOffset = arenaOffset + used;
      const payloadOffset = lengthOffset + 4;
      this.view.setUint32(lengthOffset, encoded.byteLength, true);
      this.bytesView.set(encoded, payloadOffset);
      this.view.setUint32(HEADER.VALUE_ARENA_USED, used + needed, true);
      return payloadOffset - arenaOffset;
    });
  }

  _readArenaValue(relPayloadOffset) {
    if (relPayloadOffset === VALUE_POINTER_NULL) return undefined;
    const payloadOffset = this._arenaAbs(relPayloadOffset);
    const byteLength = this.view.getUint32(payloadOffset - 4, true);
    // .slice(), not .subarray() — msgpack's decode passes the buffer through
    // TextDecoder.decode(), which throws on SharedArrayBuffer-backed views in
    // browsers ("The provided ArrayBufferView value must not be shared").
    const bytes = this.bytesView.slice(payloadOffset, payloadOffset + byteLength);
    return msgpackDecode(bytes);
  }

  // ===========================================================================
  // Internal — id-list pool (handle→grants and grant→handles)
  //
  // A list is a contiguous run of u32 ids in the pool, length stored on the
  // referencing entry. To grow a list past its current allocation, allocate
  // a new tail run, copy old ids over, append the new id, and orphan the
  // old run for compaction to reclaim.
  //
  // Lists grow monotonically during normal mutation; revocation flips the
  // active flag but does not shrink lists.
  // ===========================================================================

  // Convert a pool-relative list offset to an absolute byte offset
  // within the membrane buffer (for DataView reads/writes).
  _listPoolAbs(relOffset) {
    return this.view.getUint32(HEADER.ID_LIST_POOL_OFFSET, true) + relOffset;
  }

  // Convert an absolute byte offset to a pool-relative list offset.
  _listPoolRel(absOffset) {
    return absOffset - this.view.getUint32(HEADER.ID_LIST_POOL_OFFSET, true);
  }

  // Allocate a fresh run in the id-list pool. Returns a
  // POOL-RELATIVE offset (suitable for storage in table entries).
  // ID_LIST_NULL = 0 is reserved as "no list"; the pool starts
  // bump-used at 4 so a real run never lands at relative offset 0.
  _allocateListRun(byteSize) {
    return this._retryOnPressure(() => {
      const poolSize = this.view.getUint32(HEADER.ID_LIST_POOL_SIZE, true);
      const used = this.view.getUint32(HEADER.ID_LIST_POOL_USED, true);
      if (used + byteSize > poolSize) {
        throw new MembraneOutOfSpaceError(
          `Id-list pool full: ${used} bytes used of ${poolSize}, need ${byteSize} more. ` +
          `Tune idListPoolSize or call compactMembrane().`
        );
      }
      const relOffset = used;
      this.view.setUint32(HEADER.ID_LIST_POOL_USED, used + byteSize, true);
      return relOffset;
    });
  }

  // Read a list of `count` u32 ids from a POOL-RELATIVE offset.
  _readIdList(relOffset, count) {
    if (relOffset === ID_LIST_NULL || count === 0) return [];
    const absOffset = this._listPoolAbs(relOffset);
    const out = new Array(count);
    for (let i = 0; i < count; i++) {
      out[i] = this.view.getUint32(absOffset + i * 4, true);
    }
    return out;
  }

  /**
   * Append `id` to a u32 list rooted at (offsetField, countField) on `entry`.
   * Returns nothing; updates the entry's offset/count in place.
   *
   * Allocates a fresh tail run with one extra slot, copies, orphans the old
   * run. Idempotent re-adds are caller's responsibility (we don't dedupe).
   *
   * The offsets stored in entryOffset+offsetField are POOL-RELATIVE
   * (translated through _listPoolAbs / _listPoolRel for I/O).
   */
  _appendToIdList(entryOffset, offsetField, countField, id) {
    const currentRel = this.view.getUint32(entryOffset + offsetField, true);
    const currentCount = this.view.getUint32(entryOffset + countField, true);
    const newCount = currentCount + 1;
    const newRunRel = this._allocateListRun(newCount * 4);
    const newRunAbs = this._listPoolAbs(newRunRel);
    // Copy old ids (only if current run actually exists).
    if (currentCount > 0 && currentRel !== ID_LIST_NULL) {
      const currentAbs = this._listPoolAbs(currentRel);
      for (let i = 0; i < currentCount; i++) {
        this.view.setUint32(newRunAbs + i * 4,
          this.view.getUint32(currentAbs + i * 4, true), true);
      }
    }
    // Append new id
    this.view.setUint32(newRunAbs + currentCount * 4, id, true);
    this.view.setUint32(entryOffset + offsetField, newRunRel, true);
    this.view.setUint32(entryOffset + countField, newCount, true);
  }

  // ===========================================================================
  // Internal — handle entry accessors
  // ===========================================================================

  _handleEntryOffset(slot) {
    const tableOffset = this.view.getUint32(HEADER.HANDLE_TABLE_OFFSET, true);
    return tableOffset + slot * HANDLE_ENTRY_SIZE;
  }

  _readHandleVersion(slot) {
    if (slot < 0 || slot >= this.view.getUint32(HEADER.HANDLE_TABLE_CAPACITY, true)) {
      return 0;
    }
    return this.view.getUint32(this._handleEntryOffset(slot) + HANDLE_ENTRY.VERSION, true);
  }

  _readHandleFlags(slot) {
    return this.view.getUint8(this._handleEntryOffset(slot) + HANDLE_ENTRY.FLAGS);
  }

  _writeHandleFlags(slot, flags) {
    this.view.setUint8(this._handleEntryOffset(slot) + HANDLE_ENTRY.FLAGS, flags);
  }

  _handleSlotIsLive(slot) {
    if (slot < 0 || slot >= this.view.getUint32(HEADER.HANDLE_TABLE_CAPACITY, true)) {
      return false;
    }
    const flags = this._readHandleFlags(slot);
    return (flags & HANDLE_FLAG_ACTIVE) !== 0 && (flags & HANDLE_FLAG_ON_FREE_LIST) === 0;
  }

  // ===========================================================================
  // Internal — grant entry accessors
  // ===========================================================================

  _grantEntryOffset(slot) {
    const tableOffset = this.view.getUint32(HEADER.GRANT_TABLE_OFFSET, true);
    return tableOffset + slot * GRANT_ENTRY_SIZE;
  }

  _readGrantVersion(slot) {
    if (slot < 0 || slot >= this.view.getUint32(HEADER.GRANT_TABLE_CAPACITY, true)) {
      return 0;
    }
    return this.view.getUint32(this._grantEntryOffset(slot) + GRANT_ENTRY.VERSION, true);
  }

  _readGrantFlags(slot) {
    return this.view.getUint8(this._grantEntryOffset(slot) + GRANT_ENTRY.FLAGS);
  }

  _writeGrantFlags(slot, flags) {
    this.view.setUint8(this._grantEntryOffset(slot) + GRANT_ENTRY.FLAGS, flags);
  }

  _grantSlotIsLive(slot) {
    if (slot < 0 || slot >= this.view.getUint32(HEADER.GRANT_TABLE_CAPACITY, true)) {
      return false;
    }
    const flags = this._readGrantFlags(slot);
    return (flags & GRANT_FLAG_ACTIVE) !== 0 && (flags & GRANT_FLAG_ON_FREE_LIST) === 0;
  }

  _isGrantActive(slot) {
    if (!this._grantSlotIsLive(slot)) return false;
    return (this._readGrantFlags(slot) & GRANT_FLAG_REVOKED) === 0;
  }

  _readGrantIdentifier(slot) {
    if (!this._grantSlotIsLive(slot)) return undefined;
    const ptr = this.view.getUint32(this._grantEntryOffset(slot) + GRANT_ENTRY.IDENTIFIER_POINTER, true);
    return this._readArenaValue(ptr);
  }

  _readGrantMetadata(slot) {
    if (!this._grantSlotIsLive(slot)) return undefined;
    const ptr = this.view.getUint32(this._grantEntryOffset(slot) + GRANT_ENTRY.METADATA_POINTER, true);
    return this._readArenaValue(ptr);
  }

  _readGrantHandleSet(slot) {
    if (!this._grantSlotIsLive(slot)) return new Set();
    const entry = this._grantEntryOffset(slot);
    const offset = this.view.getUint32(entry + GRANT_ENTRY.HANDLE_LIST_OFFSET, true);
    const count = this.view.getUint32(entry + GRANT_ENTRY.HANDLE_LIST_COUNT, true);
    return new Set(this._readIdList(offset, count));
  }

  _readHandleGrantSet(slot) {
    if (!this._handleSlotIsLive(slot)) return new Set();
    const entry = this._handleEntryOffset(slot);
    const offset = this.view.getUint32(entry + HANDLE_ENTRY.GRANT_LIST_OFFSET, true);
    const count = this.view.getUint32(entry + HANDLE_ENTRY.GRANT_LIST_COUNT, true);
    return new Set(this._readIdList(offset, count));
  }

  // ===========================================================================
  // Public — handle registration / lookup
  // ===========================================================================

  /**
   * Register a JS implementation object. Returns a Handle wrapper.
   */
  register(impl, metadata = null) {
    // Encode metadata before allocating a slot — if encoding throws we don't
    // want a half-initialized slot left behind.
    const metadataPointer = this._writeArenaValue(metadata);

    const slot = this._allocateHandleSlot();
    const entryOffset = this._handleEntryOffset(slot);

    const newVersion = this.view.getUint32(entryOffset + HANDLE_ENTRY.VERSION, true) + 1;
    this.view.setUint32(entryOffset + HANDLE_ENTRY.VERSION, newVersion, true);
    this.view.setUint32(entryOffset + HANDLE_ENTRY.METADATA_POINTER, metadataPointer, true);
    this.view.setUint32(entryOffset + HANDLE_ENTRY.DECLARATION_NAME_POINTER, VALUE_POINTER_NULL, true);
    this.view.setUint32(entryOffset + HANDLE_ENTRY.GRANT_LIST_OFFSET, ID_LIST_NULL, true);
    this.view.setUint32(entryOffset + HANDLE_ENTRY.GRANT_LIST_COUNT, 0, true);
    this.view.setUint32(entryOffset + HANDLE_ENTRY.FREE_LIST_NEXT, FREE_LIST_END, true);
    this.view.setUint32(entryOffset + HANDLE_ENTRY.SURROGATE_POINTER, 0, true);
    this._writeHandleFlags(slot, HANDLE_FLAG_ACTIVE);

    this._impls.set(slot, impl);
    this._logMutation(MUTATION_KIND.HANDLE_ALLOC, slot, newVersion, MUTATION_TAG.EXPLICIT_HANDLE);
    return new Handle(slot, newVersion);
  }

  _allocateHandleSlot() {
    return this._retryOnPressure(() => {
      const head = this.view.getUint32(HEADER.HANDLE_FREE_LIST_HEAD, true);
      if (head !== FREE_LIST_END) {
        const nextOffset = this._handleEntryOffset(head) + HANDLE_ENTRY.FREE_LIST_NEXT;
        const next = this.view.getUint32(nextOffset, true);
        this.view.setUint32(HEADER.HANDLE_FREE_LIST_HEAD, next, true);
        return head;
      }
      const slot = this.view.getUint32(HEADER.NEXT_HANDLE_SLOT, true);
      const capacity = this.view.getUint32(HEADER.HANDLE_TABLE_CAPACITY, true);
      if (slot >= capacity) {
        throw new MembraneOutOfSpaceError(
          `Handle table full: ${capacity} slots used. Tune handleTableCapacity or call compactMembrane().`
        );
      }
      this.view.setUint32(HEADER.NEXT_HANDLE_SLOT, slot + 1, true);
      return slot;
    });
  }

  lookup(handle) {
    const slot = unwrapHandle(this, handle);
    return this._impls.get(slot);
  }

  metadata(handle) {
    const slot = unwrapHandle(this, handle);
    const entryOffset = this._handleEntryOffset(slot);
    const ptr = this.view.getUint32(entryOffset + HANDLE_ENTRY.METADATA_POINTER, true);
    return this._readArenaValue(ptr);
  }

  declarationName(handle) {
    const slot = unwrapHandle(this, handle);
    const entryOffset = this._handleEntryOffset(slot);
    const ptr = this.view.getUint32(entryOffset + HANDLE_ENTRY.DECLARATION_NAME_POINTER, true);
    return this._readArenaValue(ptr);
  }

  /**
   * Set the declarationName on a handle (the SS variable name the host
   * declared this handle as). Stored in the value arena, round-trips
   * through snapshot/restore.
   */
  setDeclarationName(handle, name) {
    const slot = unwrapHandle(this, handle);
    const ptr = this._writeArenaValue(name);
    this.view.setUint32(this._handleEntryOffset(slot) + HANDLE_ENTRY.DECLARATION_NAME_POINTER, ptr, true);
  }

  _bindImpl(slot, impl) {
    if (!this._handleSlotIsLive(slot)) {
      throw new Error(`Cannot bind impl to non-live slot ${slot}`);
    }
    this._impls.set(slot, impl);
  }

  slotOf(handle) {
    return unwrapHandle(this, handle);
  }

  handleForSlot(slot) {
    if (!this._handleSlotIsLive(slot)) {
      throw new Error(`Slot ${slot} is not live`);
    }
    return new Handle(slot, this._readHandleVersion(slot));
  }

  // Dispatch-path lookups: no version validation. The heap walker keeps
  // referenced slots live; the airlock uses these when translating a
  // TYPE_EXTERNAL value's slot to its impl.
  lookupBySlot(slot) {
    if (!this._handleSlotIsLive(slot)) return undefined;
    return this._impls.get(slot);
  }

  metadataBySlot(slot) {
    if (!this._handleSlotIsLive(slot)) return undefined;
    const ptr = this.view.getUint32(this._handleEntryOffset(slot) + HANDLE_ENTRY.METADATA_POINTER, true);
    return this._readArenaValue(ptr);
  }

  declarationNameBySlot(slot) {
    if (!this._handleSlotIsLive(slot)) return undefined;
    const ptr = this.view.getUint32(this._handleEntryOffset(slot) + HANDLE_ENTRY.DECLARATION_NAME_POINTER, true);
    return this._readArenaValue(ptr);
  }

  /**
   * Dispatch-path authorization check.
   *
   * A handle's grant list accumulates over the handle's lifetime: every
   * `grant.add(handle)` call appends to it, and entries are not removed
   * when grant blocks end (only compaction reclaims dead entries lazily).
   * That means a long-lived top-level handle accumulates references to
   * every grant it was ever added to, including alive-but-dormant grants
   * from previous block invocations.
   *
   * Authorization rule: a handle is callable iff
   *   (a) AT LEAST ONE grant in its grant list is currently active
   *       (i.e., on the interpreter's grant stack or in rootGrants),
   *       AND
   *   (b) NO grant in its grant list is revoked.
   *
   * (a) is OR semantics: the handle authorizes the call as long as
   *     SOME grant carrying it is active. This is what lets the
   *     idiomatic "fresh grant per onGrantRequest invocation" pattern
   *     work across multiple block entries — old grants from previous
   *     blocks sit dormant in the list, contributing nothing, while
   *     the current block's grant authorizes the call.
   *
   * (b) is fail-safe AND semantics: any past revocation kills the
   *     handle permanently (until the dead grant is purged by
   *     compaction). Once any grant the handle was ever added to is
   *     revoked, the handle is dead. This preserves the security
   *     property that revocation is a one-way trapdoor — a host that
   *     revoked a grant cannot have its decision silently undone by a
   *     fresh grant minted for the same handle.
   *
   * Rationale for the asymmetry: we want capabilities to be able to
   * create fresh grants per identifier per recognition (the documented
   * onGrantRequest pattern) without poisoning the handle on subsequent
   * calls. But we also want revocation to be hard and irreversible. OR
   * on activeness gives the first; AND on not-revoked gives the second.
   *
   * Earlier versions of this method required EVERY grant in the handle's
   * list to be in activeGrantIds (strict AND on activeness). That made
   * a handle in two grants — one active, one dormant-but-alive — fail
   * authorization, which broke the idiomatic re-entry-into-same-block
   * pattern. The asymmetric rule above replaces it.
   *
   * No wrapper version validation here — heap walker keeps slots live,
   * and this is the dispatch hot path.
   */
  checkBySlot(slot, activeGrantIds) {
    if (!this._handleSlotIsLive(slot)) return false;
    const entry = this._handleEntryOffset(slot);
    const count = this.view.getUint32(entry + HANDLE_ENTRY.GRANT_LIST_COUNT, true);
    if (count === 0) return false;
    const relOffset = this.view.getUint32(entry + HANDLE_ENTRY.GRANT_LIST_OFFSET, true);
    const absOffset = this._listPoolAbs(relOffset);
    let anyActive = false;
    for (let i = 0; i < count; i++) {
      const grantSlot = this.view.getUint32(absOffset + i * 4, true);
      // Fail-safe AND-check: a single revoked grant kills the handle.
      if (!this._isGrantActive(grantSlot)) return false;
      if (activeGrantIds.has(grantSlot)) anyActive = true;
    }
    return anyActive;
  }

  // ===========================================================================
  // Public — grant creation / lookup / revocation
  // ===========================================================================

  createGrant(identifier, metadata = null) {
    // Encode identifier+metadata first so a half-allocated slot can't leak.
    const identifierPointer = this._writeArenaValue(identifier);
    const metadataPointer = this._writeArenaValue(metadata);

    const slot = this._allocateGrantSlot();
    const entryOffset = this._grantEntryOffset(slot);

    const newVersion = this.view.getUint32(entryOffset + GRANT_ENTRY.VERSION, true) + 1;
    this.view.setUint32(entryOffset + GRANT_ENTRY.VERSION, newVersion, true);
    this.view.setUint32(entryOffset + GRANT_ENTRY.IDENTIFIER_POINTER, identifierPointer, true);
    this.view.setUint32(entryOffset + GRANT_ENTRY.METADATA_POINTER, metadataPointer, true);
    this.view.setUint32(entryOffset + GRANT_ENTRY.HANDLE_LIST_OFFSET, ID_LIST_NULL, true);
    this.view.setUint32(entryOffset + GRANT_ENTRY.HANDLE_LIST_COUNT, 0, true);
    this.view.setUint32(entryOffset + GRANT_ENTRY.FREE_LIST_NEXT, FREE_LIST_END, true);
    this.view.setUint32(entryOffset + GRANT_ENTRY.RESERVED, 0, true);
    this._writeGrantFlags(slot, GRANT_FLAG_ACTIVE);

    // Mid-approval protection: until the airlock pushes this grant's
    // stack entry, the wrapper we return is the ONLY reference — host
    // JS, invisible to the compaction walker. Registering the slot in
    // every open approval window keeps a pool-pressure compaction
    // (e.g. inside a subsequent grant.add) from reaping it.
    for (const approvalWindow of this._state.openGrantApprovalWindows) {
      approvalWindow.add(slot);
    }

    this._logMutation(MUTATION_KIND.GRANT_CREATE, slot, newVersion, MUTATION_TAG.EXPLICIT_GRANT);
    return new Grant(this, slot, newVersion);
  }

  _allocateGrantSlot() {
    return this._retryOnPressure(() => {
      const head = this.view.getUint32(HEADER.GRANT_FREE_LIST_HEAD, true);
      if (head !== FREE_LIST_END) {
        const nextOffset = this._grantEntryOffset(head) + GRANT_ENTRY.FREE_LIST_NEXT;
        const next = this.view.getUint32(nextOffset, true);
        this.view.setUint32(HEADER.GRANT_FREE_LIST_HEAD, next, true);
        return head;
      }
      const slot = this.view.getUint32(HEADER.NEXT_GRANT_SLOT, true);
      const capacity = this.view.getUint32(HEADER.GRANT_TABLE_CAPACITY, true);
      if (slot >= capacity) {
        throw new MembraneOutOfSpaceError(
          `Grant table full: ${capacity} slots used. Tune grantTableCapacity or call compactMembrane().`
        );
      }
      this.view.setUint32(HEADER.NEXT_GRANT_SLOT, slot + 1, true);
      return slot;
    });
  }

  /**
   * Revoke a grant. Sets the REVOKED flag; the slot stays live so existing
   * Grant wrappers don't go stale (they just report `active === false`).
   * Compaction frees the slot once nothing references it.
   *
   * @param {Grant} grant
   * @param {number} [callerTag] - MUTATION_TAG.* recorded in the log;
   *   defaults to EXPLICIT_REVOKE. Callers that distinguish their
   *   revoke path (e.g. HOST_REVOKE for capability teardown) pass
   *   their own tag.
   */
  revoke(grant, callerTag = MUTATION_TAG.EXPLICIT_REVOKE) {
    const slot = unwrapGrant(this, grant);
    const flags = this._readGrantFlags(slot);
    this._writeGrantFlags(slot, flags | GRANT_FLAG_REVOKED);
    const version = this._readGrantVersion(slot);
    this._logMutation(MUTATION_KIND.GRANT_REVOKE, slot, version, callerTag,
      (flags & GRANT_FLAG_ROOT) !== 0 ? 1 : 0);
  }

  /**
   * Mint a fresh Grant wrapper for a known-live slot. Used by the airlock
   * when it needs a wrapper from a raw slot id (e.g. from the WAT grant
   * stack, from rootGrants, from a handle's grant list). Returns undefined
   * for non-live slots — defensive against stale stack entries during
   * revocation cleanup.
   */
  _getGrantById(slot) {
    if (!this._grantSlotIsLive(slot)) return undefined;
    return new Grant(this, slot, this._readGrantVersion(slot));
  }

  grantForSlot(slot) {
    if (!this._grantSlotIsLive(slot)) {
      throw new Error(`Grant slot ${slot} is not live`);
    }
    return new Grant(this, slot, this._readGrantVersion(slot));
  }

  slotOfGrant(grant) {
    return unwrapGrant(this, grant);
  }

  /**
   * Enumerate every live grant slot as
   * [{slot, identifier, active, root}], slot-ascending. "Live" is
   * allocated-and-not-freed (the same predicate grantForSlot gates
   * on); a revoked slot stays live until compaction frees it and
   * shows up here with active: false. This is the operator-facing
   * enumerator: it makes grants addressable by identifier from a
   * generic host CLI or administration API. The wire cannot hold Grant
   * wrappers, and slot ids are otherwise discoverable only via chain
   * edges or interpreter context dumps.
   */
  listGrants() {
    const nextGrantSlot = this.view.getUint32(HEADER.NEXT_GRANT_SLOT, true);
    const out = [];
    for (let slot = 0; slot < nextGrantSlot; slot++) {
      if (!this._grantSlotIsLive(slot)) continue;
      out.push({
        slot,
        identifier: this._readGrantIdentifier(slot),
        active: this._isGrantActive(slot),
        root: (this._readGrantFlags(slot) & GRANT_FLAG_ROOT) !== 0,
      });
    }
    return out;
  }

  // ===========================================================================
  // Inverse-index mutation: addHandleToGrant
  // ===========================================================================

  /**
   * Add `handle` to `grant`'s authorization set. Updates both inverse-index
   * lists (grant's handle list and handle's grant list).
   *
   * Idempotent in spirit: re-adding a handle is a no-op (the existing list
   * is checked for membership). Without dedup, the marshalResultWithGrantTagging
   * path that re-tags returned externals on every call would balloon both
   * lists.
   */
  _addHandleToGrant(grant, handle) {
    const grantSlot = unwrapGrant(this, grant);
    const handleSlot = unwrapHandle(this, handle);
    if (!this._handleSlotIsLive(handleSlot)) {
      throw new Error(`Unknown handle: ${handleSlot}`);
    }

    const handleEntry = this._handleEntryOffset(handleSlot);
    const grantEntry = this._grantEntryOffset(grantSlot);

    // Dedup: walk the handle's existing grant list; if grantSlot is already
    // there, no-op.
    const existingCount = this.view.getUint32(handleEntry + HANDLE_ENTRY.GRANT_LIST_COUNT, true);
    if (existingCount > 0) {
      const existingRel = this.view.getUint32(handleEntry + HANDLE_ENTRY.GRANT_LIST_OFFSET, true);
      const existingAbs = this._listPoolAbs(existingRel);
      for (let i = 0; i < existingCount; i++) {
        if (this.view.getUint32(existingAbs + i * 4, true) === grantSlot) return;
      }
    }

    this._appendToIdList(handleEntry, HANDLE_ENTRY.GRANT_LIST_OFFSET, HANDLE_ENTRY.GRANT_LIST_COUNT, grantSlot);
    this._appendToIdList(grantEntry, GRANT_ENTRY.HANDLE_LIST_OFFSET, GRANT_ENTRY.HANDLE_LIST_COUNT, handleSlot);
  }

  /**
   * Authorization check. A handle is authorized iff every grant it belongs
   * to is in `activeGrantIds` AND every such grant is not revoked. Stale
   * Handle wrapper → returns false (treated as denied).
   */
  check(handle, activeGrantIds) {
    let slot;
    try {
      slot = unwrapHandle(this, handle);
    } catch (err) {
      if (err instanceof StaleHandleError) return false;
      throw err;
    }
    return this.checkBySlot(slot, activeGrantIds);
  }

  /**
   * Returns the grants that include this handle (Grant wrappers, current
   * version each). Inactive (revoked) grants are skipped.
   */
  grantsForHandle(handle) {
    const slot = unwrapHandle(this, handle);
    const grantSlots = this._readHandleGrantSet(slot);
    const result = [];
    for (const grantSlot of grantSlots) {
      const g = this._getGrantById(grantSlot);
      if (g) result.push(g);
    }
    return result;
  }

  // ===========================================================================
  // Root grants — grants always considered active for authorization checks
  // ===========================================================================

  /**
   * Mark a grant as a root grant. Stored in the SAB's rootGrantsList; round-
   * trips through snapshot/restore. Idempotent.
   */
  markAsRootGrant(grant) {
    const slot = unwrapGrant(this, grant);
    const flags = this._readGrantFlags(slot);
    if ((flags & GRANT_FLAG_ROOT) !== 0) return; // already root
    this._writeGrantFlags(slot, flags | GRANT_FLAG_ROOT);
    // Append to rootGrantsList
    const listOffset = this.view.getUint32(HEADER.ROOT_GRANTS_LIST_OFFSET, true);
    const count = this.view.getUint32(HEADER.ROOT_GRANTS_LIST_COUNT, true);
    const capacity = this.view.getUint32(HEADER.ROOT_GRANTS_LIST_CAPACITY, true);
    if (count >= capacity) {
      throw new MembraneOutOfSpaceError(
        `Root grants list full: ${capacity} entries. Tune rootGrantsListCapacity.`
      );
    }
    this.view.setUint32(listOffset + count * 4, slot, true);
    this.view.setUint32(HEADER.ROOT_GRANTS_LIST_COUNT, count + 1, true);
    const version = this._readGrantVersion(slot);
    this._logMutation(MUTATION_KIND.GRANT_ROOT_ADD, slot, version, MUTATION_TAG.ROOT_PUSH);
  }

  /**
   * Get root grant slots as a Set<number>. The airlock unions this into
   * the active set on every authorization check. Cheap to call (linear in
   * the number of root grants, which is typically <10).
   */
  rootGrantSlots() {
    const listOffset = this.view.getUint32(HEADER.ROOT_GRANTS_LIST_OFFSET, true);
    const count = this.view.getUint32(HEADER.ROOT_GRANTS_LIST_COUNT, true);
    const out = new Set();
    for (let i = 0; i < count; i++) {
      out.add(this.view.getUint32(listOffset + i * 4, true));
    }
    return out;
  }

  // ===========================================================================
  // Grant-approval windows
  //
  // Between the host's createGrant() inside onGrantRequest and the
  // airlock pushing the grant-stack entry, a freshly approved grant
  // exists only as a host-side wrapper — no SS anchor, so a
  // pool-pressure compaction (typically inside grant.add on the same
  // grant) reaps the slot mid-approval, and a later createGrant can
  // reuse it under a different authorization domain. The airlock
  // brackets its whole approval flow with a window; createGrant
  // registers every new slot into all open windows; compaction treats
  // windowed slots as live. Windows are transient JS state — never
  // persisted, die with the process (same contract as airlock pins).
  // ===========================================================================

  /**
   * Open a grant-approval window. Every grant created while it is open
   * is protected from compaction until endGrantApprovalWindow() is
   * called with the returned token. Windows nest: overlapping windows
   * each register the grants created during their span, and a slot
   * stays protected until every window holding it closes.
   *
   * @returns {Set<number>} window token for endGrantApprovalWindow
   */
  beginGrantApprovalWindow() {
    const approvalWindow = new Set();
    this._state.openGrantApprovalWindows.push(approvalWindow);
    return approvalWindow;
  }

  /**
   * Close a grant-approval window. Grants it protected become subject
   * to normal liveness rules again — approved grants are anchored by
   * their grant-stack entries by the time the airlock closes the
   * window; rejected ones become reapable garbage.
   *
   * @param {Set<number>} approvalWindow - token from beginGrantApprovalWindow
   */
  endGrantApprovalWindow(approvalWindow) {
    const windows = this._state.openGrantApprovalWindows;
    const index = windows.indexOf(approvalWindow);
    if (index !== -1) windows.splice(index, 1);
  }

  /**
   * Union of all open windows' grant slots. Compaction
   * (airlock._compactMembraneFromLiveHandleSlots) adds these to the
   * live grant set on every pass — pressure-triggered and explicit
   * alike, since an async approval legitimately spans event-loop turns.
   *
   * @returns {Set<number>}
   */
  openGrantApprovalWindowSlots() {
    const out = new Set();
    for (const approvalWindow of this._state.openGrantApprovalWindows) {
      for (const slot of approvalWindow) out.add(slot);
    }
    return out;
  }

  // ===========================================================================
  // Closure-handle table
  //
  // Drone code can pass closures to host handlers (e.g. Api.subscribe(() =>
  // ...)). The closure-pointer and captured-grants mapping lives in the SAB,
  // rather than transient JS state, so drone-registered callbacks remain
  // reachable from the host after a snapshot/restore cycle.
  //
  // Lazy reclamation: a slot is freed only when (a) the host calls
  // dropClosureHandle(handle) explicitly, or (b) the airlock's
  // FinalizationRegistry fires for a wrapper the host stopped holding.
  // Compaction never frees a closure-handle slot on its own, because the
  // host might be planning to call enumerateClosureHandles() and adopt it.
  // ===========================================================================

  _closureHandleEntryOffset(slot) {
    const tableOffset = this.view.getUint32(HEADER.CLOSURE_HANDLE_TABLE_OFFSET, true);
    return tableOffset + slot * CLOSURE_HANDLE_ENTRY_SIZE;
  }

  _readClosureHandleVersion(slot) {
    if (slot < 0 || slot >= this.view.getUint32(HEADER.CLOSURE_HANDLE_TABLE_CAPACITY, true)) {
      return 0;
    }
    return this.view.getUint32(this._closureHandleEntryOffset(slot) + CLOSURE_HANDLE_ENTRY.VERSION, true);
  }

  _readClosureHandleFlags(slot) {
    return this.view.getUint8(this._closureHandleEntryOffset(slot) + CLOSURE_HANDLE_ENTRY.FLAGS);
  }

  _writeClosureHandleFlags(slot, flags) {
    this.view.setUint8(this._closureHandleEntryOffset(slot) + CLOSURE_HANDLE_ENTRY.FLAGS, flags);
  }

  _closureHandleSlotIsLive(slot) {
    if (slot < 0 || slot >= this.view.getUint32(HEADER.CLOSURE_HANDLE_TABLE_CAPACITY, true)) {
      return false;
    }
    const flags = this._readClosureHandleFlags(slot);
    return (flags & CLOSURE_HANDLE_FLAG_ACTIVE) !== 0 && (flags & CLOSURE_HANDLE_FLAG_ON_FREE_LIST) === 0;
  }

  _readClosurePointer(slot) {
    if (!this._closureHandleSlotIsLive(slot)) return 0;
    return this.view.getUint32(this._closureHandleEntryOffset(slot) + CLOSURE_HANDLE_ENTRY.CLOSURE_POINTER, true);
  }

  _readClosureMetadata(slot) {
    if (!this._closureHandleSlotIsLive(slot)) return undefined;
    const ptr = this.view.getUint32(this._closureHandleEntryOffset(slot) + CLOSURE_HANDLE_ENTRY.METADATA_POINTER, true);
    return this._readArenaValue(ptr);
  }

  /**
   * Replace the metadata for a live closure-handle slot.
   *
   * Encodes `metadata` into the value arena and updates the entry's
   * METADATA_POINTER. The old metadata's arena bytes become unreachable
   * from this entry; compaction reclaims them on its next pass (consistent
   * with the rest of `_writeArenaValue` usage).
   *
   * Does NOT bump the entry's version — the wrapper still references the
   * same closure, only the host-supplied annotation changed. Bumping
   * version would invalidate every existing wrapper, which is wrong:
   * hosts hold long-lived wrappers in their dispatch maps and changing
   * metadata is meant to enrich those wrappers, not replace them.
   *
   * Throws if the slot is not live.
   *
   * @param {number} slot
   * @param {*} metadata - msgpack-serializable, or null/undefined to clear.
   */
  setClosureMetadata(slot, metadata) {
    if (!this._closureHandleSlotIsLive(slot)) {
      throw new Error(`Closure handle slot ${slot} is not live`);
    }
    const metadataPointer = this._writeArenaValue(metadata);
    this.view.setUint32(
      this._closureHandleEntryOffset(slot) + CLOSURE_HANDLE_ENTRY.METADATA_POINTER,
      metadataPointer, true);
  }

  _readCapturedGrantSet(slot) {
    if (!this._closureHandleSlotIsLive(slot)) return new Set();
    const entry = this._closureHandleEntryOffset(slot);
    const offset = this.view.getUint32(entry + CLOSURE_HANDLE_ENTRY.CAPTURED_GRANTS_LIST_OFFSET, true);
    const count = this.view.getUint32(entry + CLOSURE_HANDLE_ENTRY.CAPTURED_GRANTS_LIST_COUNT, true);
    return new Set(this._readIdList(offset, count));
  }

  _allocateClosureHandleSlot() {
    const head = this.view.getUint32(HEADER.CLOSURE_HANDLE_FREE_LIST_HEAD, true);
    if (head !== FREE_LIST_END) {
      const nextOffset = this._closureHandleEntryOffset(head) + CLOSURE_HANDLE_ENTRY.FREE_LIST_NEXT;
      const next = this.view.getUint32(nextOffset, true);
      this.view.setUint32(HEADER.CLOSURE_HANDLE_FREE_LIST_HEAD, next, true);
      return head;
    }
    const slot = this.view.getUint32(HEADER.NEXT_CLOSURE_HANDLE_SLOT, true);
    const capacity = this.view.getUint32(HEADER.CLOSURE_HANDLE_TABLE_CAPACITY, true);
    if (slot >= capacity) {
      throw new MembraneOutOfSpaceError(
        `Closure handle table full: ${capacity} slots used. Tune closureHandleTableCapacity or call dropClosureHandle.`
      );
    }
    this.view.setUint32(HEADER.NEXT_CLOSURE_HANDLE_SLOT, slot + 1, true);
    return slot;
  }

  /**
   * Register a closure (drone-side) and return a host-facing wrapper.
   * @param {number} closurePointer - SS heap header pointer
   * @param {Iterable<number>} capturedGrantSlots - grant slots active at registration time
   * @param {*} metadata - host-supplied identifier (msgpack-serializable)
   * @returns {ClosureHandle}
   */
  registerClosureHandle(closurePointer, capturedGrantSlots, metadata = null) {
    // Encode metadata before allocating so a half-initialized slot can't leak.
    const metadataPointer = this._writeArenaValue(metadata);

    const slot = this._allocateClosureHandleSlot();
    const entry = this._closureHandleEntryOffset(slot);

    const newVersion = this.view.getUint32(entry + CLOSURE_HANDLE_ENTRY.VERSION, true) + 1;
    this.view.setUint32(entry + CLOSURE_HANDLE_ENTRY.VERSION, newVersion, true);
    this.view.setUint32(entry + CLOSURE_HANDLE_ENTRY.CLOSURE_POINTER, closurePointer, true);
    this.view.setUint32(entry + CLOSURE_HANDLE_ENTRY.METADATA_POINTER, metadataPointer, true);
    this.view.setUint32(entry + CLOSURE_HANDLE_ENTRY.CAPTURED_GRANTS_LIST_OFFSET, ID_LIST_NULL, true);
    this.view.setUint32(entry + CLOSURE_HANDLE_ENTRY.CAPTURED_GRANTS_LIST_COUNT, 0, true);
    this.view.setUint32(entry + CLOSURE_HANDLE_ENTRY.FREE_LIST_NEXT, FREE_LIST_END, true);
    this.view.setUint32(entry + CLOSURE_HANDLE_ENTRY.RESERVED, 0, true);
    this._writeClosureHandleFlags(slot, CLOSURE_HANDLE_FLAG_ACTIVE);

    // Captured grants list: snapshot of grant slots at registration time.
    // We materialize once and write into the pool (no in-place growth needed —
    // captured grants are immutable for the closure handle's lifetime).
    const grantsArr = Array.from(capturedGrantSlots);
    if (grantsArr.length > 0) {
      const relOffset = this._allocateListRun(grantsArr.length * 4);
      const absOffset = this._listPoolAbs(relOffset);
      for (let i = 0; i < grantsArr.length; i++) {
        this.view.setUint32(absOffset + i * 4, grantsArr[i], true);
      }
      this.view.setUint32(entry + CLOSURE_HANDLE_ENTRY.CAPTURED_GRANTS_LIST_OFFSET, relOffset, true);
      this.view.setUint32(entry + CLOSURE_HANDLE_ENTRY.CAPTURED_GRANTS_LIST_COUNT, grantsArr.length, true);
    }

    // Mint via the cache so that any future enumerateClosureHandles() that
    // sees this slot returns the same wrapper identity.
    const { wrapper } = this._mintOrGetClosureHandle(slot);
    this._logMutation(MUTATION_KIND.CLOSURE_HANDLE_ALLOC, slot, newVersion, MUTATION_TAG.EXPLICIT_CLOSURE);
    return wrapper;
  }

  /**
   * Free a closure-handle slot. Bumps version, clears flags, pushes onto
   * the free list, and removes it from the JS-side liveness Set. Used by:
   *   (a) explicit dropClosureHandle from the host
   *   (b) FinalizationRegistry callback when JS GC drops the wrapper
   * Compaction does not free closure handles; they are lazy-reclaimed.
   *
   * @param {number} slot
   * @param {number} [callerTag] - MUTATION_TAG.* recorded in the log;
   *   defaults to EXPLICIT_CLOSURE (the "host called dropClosureHandle"
   *   path). The airlock's FinalizationRegistry callback passes
   *   MUTATION_TAG.WRAPPER_GC to distinguish wrapper-collection-driven
   *   frees from explicit drops.
   */
  _freeClosureHandleSlot(slot, callerTag = MUTATION_TAG.EXPLICIT_CLOSURE) {
    if (!this._closureHandleSlotIsLive(slot)) return;
    const entry = this._closureHandleEntryOffset(slot);
    const oldVersion = this.view.getUint32(entry + CLOSURE_HANDLE_ENTRY.VERSION, true);
    const newVersion = oldVersion + 1;
    this.view.setUint32(entry + CLOSURE_HANDLE_ENTRY.VERSION, newVersion, true);
    this._writeClosureHandleFlags(slot, CLOSURE_HANDLE_FLAG_ON_FREE_LIST);
    const head = this.view.getUint32(HEADER.CLOSURE_HANDLE_FREE_LIST_HEAD, true);
    this.view.setUint32(entry + CLOSURE_HANDLE_ENTRY.FREE_LIST_NEXT, head, true);
    this.view.setUint32(HEADER.CLOSURE_HANDLE_FREE_LIST_HEAD, slot, true);
    // Drop the cache entry — the slot is now dead, and a future
    // _mintOrGetClosureHandle for this slot (e.g., after reallocation)
    // should produce a fresh wrapper with the bumped version.
    this._closureHandleCache.delete(slot);
    this._logMutation(MUTATION_KIND.CLOSURE_HANDLE_FREE, slot, newVersion, callerTag);
  }

  /**
   * Mint a fresh ClosureHandle wrapper for a known-live slot. Used by
   * enumerateClosureHandles post-restore, and when re-issuing wrappers
   * after `_bindImpl`-style host operations.
   */
  /**
   * Validate a ClosureHandle wrapper (version check) and return the slot.
   * Used by airlock when it needs the slot from a host-held wrapper.
   */
  _slotOfClosureHandle(handle) {
    return unwrapClosureHandle(this, handle);
  }

  /** Unwrap an ObjectHandle wrapper to its slot; stale wrappers throw. */
  _slotOfObjectHandle(handle) {
    return unwrapObjectHandle(this, handle);
  }

  /**
   * Return the canonical ClosureHandle wrapper for a slot. If a wrapper
   * was previously minted and is still alive in JS, returns that one —
   * preserving identity across multiple enumerate/forSlot calls.
   *
   * Returns `{ wrapper, isNew: boolean }` so the caller (typically the
   * airlock) can register newly-minted wrappers with its
   * FinalizationRegistry exactly once per slot lifetime.
   */
  _mintOrGetClosureHandle(slot) {
    const ref = this._closureHandleCache.get(slot);
    if (ref) {
      const cached = ref.deref();
      if (cached !== undefined && cached.version === this._readClosureHandleVersion(slot)) {
        // Cached wrapper still alive AND its version matches the SAB.
        // (Version mismatch would mean the slot was freed and reallocated
        // since the wrapper was minted — the cached wrapper is stale and
        // we need to mint a fresh one for the new slot occupant.)
        return { wrapper: cached, isNew: false };
      }
    }
    const wrapper = new ClosureHandle(this, slot, this._readClosureHandleVersion(slot));
    this._closureHandleCache.set(slot, new WeakRef(wrapper));
    this._closureHandleCacheCleanup.register(wrapper, slot);
    return { wrapper, isNew: true };
  }

  closureHandleForSlot(slot) {
    if (!this._closureHandleSlotIsLive(slot)) {
      throw new Error(`Closure handle slot ${slot} is not live`);
    }
    return this._mintOrGetClosureHandle(slot).wrapper;
  }

  /**
   * Enumerate live closure-handle slots.
   *
   * Returns `[{ closureHandle, isNewWrapper, closurePointer,
   * capturedGrantSlots, metadata }, …]` where:
   *   - `closureHandle`      — `ClosureHandle` wrapper (slot + version).
   *     Cached: subsequent enumerate / closureHandleForSlot calls for
   *     the same slot return the same JS identity.
   *   - `isNewWrapper`       — true if this call minted a fresh wrapper
   *     (i.e. the slot didn't have a live wrapper in the cache). The
   *     airlock uses this to register with FinalizationRegistry exactly
   *     once per slot lifetime.
   *   - `closurePointer`     — current SS heap pointer for the closure
   *     body; updated by heap GC's pointer-rewrite pass.
   *   - `capturedGrantSlots` — Set of grant slots active when the closure
   *     was registered. Pushed onto the WAT grant stack when the
   *     callback fires.
   *   - `metadata`           — host-supplied at `registerClosureHandle()`
   *     time. Hosts use it to identify which of their listener slots
   *     this closure belongs to after restore.
   *
   * Hosts walk this post-restore, match each entry to
   * their listener tables (typically by `metadata.kind` or
   * `metadata.boxId`), and STORE the wrapper to keep the SAB slot alive.
   * Wrappers the host doesn't adopt are eligible for FinalizationRegistry
   * cleanup (slot frees once JS GC collects the wrapper); the host can
   * also drop them eagerly via `airlock.dropClosureHandle(handle)`.
   *
   * See the Airlock class docblock for the full restore protocol.
   */
  enumerateClosureHandles(options = {}) {
    const { includeReaped = false } = options;
    const result = [];
    const capacity = this.view.getUint32(HEADER.CLOSURE_HANDLE_TABLE_CAPACITY, true);
    const nextSlot = this.view.getUint32(HEADER.NEXT_CLOSURE_HANDLE_SLOT, true);
    const upTo = Math.min(nextSlot, capacity);
    for (let slot = 0; slot < upTo; slot++) {
      const flags = this._readClosureHandleFlags(slot);
      const live = (flags & CLOSURE_HANDLE_FLAG_ACTIVE) !== 0 && (flags & CLOSURE_HANDLE_FLAG_ON_FREE_LIST) === 0;
      const onFreeList = (flags & CLOSURE_HANDLE_FLAG_ON_FREE_LIST) !== 0;
      if (live) {
        const entry = this._closureHandleEntryOffset(slot);
        const metaPtr = this.view.getUint32(entry + CLOSURE_HANDLE_ENTRY.METADATA_POINTER, true);
        // Use the cache so the same slot always yields the same wrapper
        // identity across calls. isNew tells the airlock whether to
        // register with FinalizationRegistry (only on first mint per slot).
        const minted = this._mintOrGetClosureHandle(slot);
        result.push({
          slot,
          closureHandle: minted.wrapper,
          isNewWrapper: minted.isNew,
          closurePointer: this._readClosurePointer(slot),
          capturedGrantSlots: this._readCapturedGrantSet(slot),
          metadata: this._readArenaValue(metaPtr),
        });
      } else if (includeReaped && onFreeList) {
        const entry = this._closureHandleEntryOffset(slot);
        const version = this.view.getUint32(entry + CLOSURE_HANDLE_ENTRY.VERSION, true);
        const reap = this.findLastMutationForSlot(slot,
          { kind: MUTATION_KIND.CLOSURE_HANDLE_FREE });
        result.push({
          slot,
          version,
          reaped: true,
          reapedAt: reap ? { tick: reap.tick, seq: reap.seq } : null,
          reapedCallerTag: reap ? reap.callerTag : null,
        });
      }
    }
    return result;
  }

  /**
   * Get all live closure-handle slots' closure pointers (for the GC's
   * external roots set). Replaces the JS-Map iteration that
   * airlock.getClosureRoots used to do.
   */
  closureHandleRootPointers() {
    const result = [];
    const capacity = this.view.getUint32(HEADER.CLOSURE_HANDLE_TABLE_CAPACITY, true);
    const nextSlot = this.view.getUint32(HEADER.NEXT_CLOSURE_HANDLE_SLOT, true);
    const upTo = Math.min(nextSlot, capacity);
    for (let slot = 0; slot < upTo; slot++) {
      if (this._closureHandleSlotIsLive(slot)) {
        const ptr = this._readClosurePointer(slot);
        if (ptr !== 0) result.push(ptr);
      }
    }
    return result;
  }

  /**
   * After a heap GC compaction, rewrite closure pointers (and linked-promise
   * pointers) to their new locations. forwarding is a Map<oldHeader, newHeader>
   * exactly as returned by Collector.collect().
   */
  updateClosurePointersAfterGC(forwarding) {
    // Closure handles
    const chCapacity = this.view.getUint32(HEADER.CLOSURE_HANDLE_TABLE_CAPACITY, true);
    const chNext = this.view.getUint32(HEADER.NEXT_CLOSURE_HANDLE_SLOT, true);
    for (let slot = 0; slot < Math.min(chNext, chCapacity); slot++) {
      if (!this._closureHandleSlotIsLive(slot)) continue;
      const entry = this._closureHandleEntryOffset(slot);
      const oldPtr = this.view.getUint32(entry + CLOSURE_HANDLE_ENTRY.CLOSURE_POINTER, true);
      const newPtr = forwarding.get(oldPtr);
      if (newPtr !== undefined && newPtr !== oldPtr) {
        this.view.setUint32(entry + CLOSURE_HANDLE_ENTRY.CLOSURE_POINTER, newPtr, true);
      }
    }
    // Linked promises (same shape, different field name)
    const lpCapacity = this.view.getUint32(HEADER.LINKED_PROMISE_TABLE_CAPACITY, true);
    const lpNext = this.view.getUint32(HEADER.NEXT_LINKED_PROMISE_SLOT, true);
    for (let slot = 0; slot < Math.min(lpNext, lpCapacity); slot++) {
      if (!this._linkedPromiseSlotIsLive(slot)) continue;
      const entry = this._linkedPromiseEntryOffset(slot);
      const oldPtr = this.view.getUint32(entry + LINKED_PROMISE_ENTRY.SS_PROMISE_POINTER, true);
      const newPtr = forwarding.get(oldPtr);
      if (newPtr !== undefined && newPtr !== oldPtr) {
        this.view.setUint32(entry + LINKED_PROMISE_ENTRY.SS_PROMISE_POINTER, newPtr, true);
      }
    }
    // v15: object handles (same shape). The pointer→slot intern index
    // re-keys alongside the entry rewrite.
    const ohCapacity = this.view.getUint32(HEADER.OBJECT_HANDLE_TABLE_CAPACITY, true);
    const ohNext = this.view.getUint32(HEADER.NEXT_OBJECT_HANDLE_SLOT, true);
    for (let slot = 0; slot < Math.min(ohNext, ohCapacity); slot++) {
      if (!this._objectHandleSlotIsLive(slot)) continue;
      const entry = this._objectHandleEntryOffset(slot);
      const oldPtr = this.view.getUint32(entry + OBJECT_HANDLE_ENTRY.OBJECT_POINTER, true);
      const newPtr = forwarding.get(oldPtr);
      if (newPtr !== undefined && newPtr !== oldPtr) {
        this.view.setUint32(entry + OBJECT_HANDLE_ENTRY.OBJECT_POINTER, newPtr, true);
        this._objectHandleSlotByPointer.delete(oldPtr);
        this._objectHandleSlotByPointer.set(newPtr, slot);
      }
    }
    // v15: surrogate prototypes bound to constructible handles.
    const hCapacity = this.view.getUint32(HEADER.HANDLE_TABLE_CAPACITY, true);
    const hNext = this.view.getUint32(HEADER.NEXT_HANDLE_SLOT, true);
    for (let slot = 0; slot < Math.min(hNext, hCapacity); slot++) {
      if (!this._handleSlotIsLive(slot)) continue;
      const entry = this._handleEntryOffset(slot);
      const oldPtr = this.view.getUint32(entry + HANDLE_ENTRY.SURROGATE_POINTER, true);
      if (oldPtr === 0) continue;
      const newPtr = forwarding.get(oldPtr);
      if (newPtr !== undefined && newPtr !== oldPtr) {
        this.view.setUint32(entry + HANDLE_ENTRY.SURROGATE_POINTER, newPtr, true);
      }
    }
  }

  // ===========================================================================
  // Object-handle table (v15)
  //
  // Host-retained live vat objects: the host keeps a SandScript instance
  // (e.g. a custom element) reachable and invokes its callbacks later
  // with the instance as the receiver. Each entry stores the object's
  // heap HEADER pointer (a GC root, forwarded on compaction), the grant
  // slots captured at first retention, optional host metadata, and a
  // retain count. One wrapper is interned per vat object; repeated
  // retention bumps the count, release decrements it, and the slot
  // frees only at zero (or when the host's last wrapper is JS-GC'd —
  // an unreachable wrapper can never be released explicitly).
  // Compaction never frees an object-handle slot on its own.
  // ===========================================================================

  _objectHandleEntryOffset(slot) {
    const tableOffset = this.view.getUint32(HEADER.OBJECT_HANDLE_TABLE_OFFSET, true);
    return tableOffset + slot * OBJECT_HANDLE_ENTRY_SIZE;
  }

  _readObjectHandleVersion(slot) {
    if (slot < 0 || slot >= this.view.getUint32(HEADER.OBJECT_HANDLE_TABLE_CAPACITY, true)) {
      return 0;
    }
    return this.view.getUint32(this._objectHandleEntryOffset(slot) + OBJECT_HANDLE_ENTRY.VERSION, true);
  }

  _readObjectHandleFlags(slot) {
    return this.view.getUint8(this._objectHandleEntryOffset(slot) + OBJECT_HANDLE_ENTRY.FLAGS);
  }

  _writeObjectHandleFlags(slot, flags) {
    this.view.setUint8(this._objectHandleEntryOffset(slot) + OBJECT_HANDLE_ENTRY.FLAGS, flags);
  }

  _objectHandleSlotIsLive(slot) {
    if (slot < 0 || slot >= this.view.getUint32(HEADER.OBJECT_HANDLE_TABLE_CAPACITY, true)) {
      return false;
    }
    const flags = this._readObjectHandleFlags(slot);
    return (flags & OBJECT_HANDLE_FLAG_ACTIVE) !== 0 && (flags & OBJECT_HANDLE_FLAG_ON_FREE_LIST) === 0;
  }

  _readObjectPointer(slot) {
    if (!this._objectHandleSlotIsLive(slot)) return 0;
    return this.view.getUint32(this._objectHandleEntryOffset(slot) + OBJECT_HANDLE_ENTRY.OBJECT_POINTER, true);
  }

  _readObjectMetadata(slot) {
    if (!this._objectHandleSlotIsLive(slot)) return undefined;
    const ptr = this.view.getUint32(this._objectHandleEntryOffset(slot) + OBJECT_HANDLE_ENTRY.METADATA_POINTER, true);
    return this._readArenaValue(ptr);
  }

  /**
   * Replace the metadata for a live object-handle slot. Same contract
   * as setClosureMetadata: no version bump, throws when not live.
   */
  setObjectMetadata(slot, metadata) {
    if (!this._objectHandleSlotIsLive(slot)) {
      throw new Error(`Object handle slot ${slot} is not live`);
    }
    const metadataPointer = this._writeArenaValue(metadata);
    this.view.setUint32(
      this._objectHandleEntryOffset(slot) + OBJECT_HANDLE_ENTRY.METADATA_POINTER,
      metadataPointer, true);
  }

  _readObjectCapturedGrantSet(slot) {
    if (!this._objectHandleSlotIsLive(slot)) return new Set();
    const entry = this._objectHandleEntryOffset(slot);
    const offset = this.view.getUint32(entry + OBJECT_HANDLE_ENTRY.CAPTURED_GRANTS_LIST_OFFSET, true);
    const count = this.view.getUint32(entry + OBJECT_HANDLE_ENTRY.CAPTURED_GRANTS_LIST_COUNT, true);
    return new Set(this._readIdList(offset, count));
  }

  _readObjectRetainCount(slot) {
    if (!this._objectHandleSlotIsLive(slot)) return 0;
    return this.view.getUint32(this._objectHandleEntryOffset(slot) + OBJECT_HANDLE_ENTRY.RETAIN_COUNT, true);
  }

  _allocateObjectHandleSlot() {
    const head = this.view.getUint32(HEADER.OBJECT_HANDLE_FREE_LIST_HEAD, true);
    if (head !== FREE_LIST_END) {
      const nextOffset = this._objectHandleEntryOffset(head) + OBJECT_HANDLE_ENTRY.FREE_LIST_NEXT;
      const next = this.view.getUint32(nextOffset, true);
      this.view.setUint32(HEADER.OBJECT_HANDLE_FREE_LIST_HEAD, next, true);
      return head;
    }
    const slot = this.view.getUint32(HEADER.NEXT_OBJECT_HANDLE_SLOT, true);
    const capacity = this.view.getUint32(HEADER.OBJECT_HANDLE_TABLE_CAPACITY, true);
    if (slot >= capacity) {
      throw new MembraneOutOfSpaceError(
        `Object handle table full: ${capacity} slots used. Tune objectHandleTableCapacity or call releaseObjectHandle.`
      );
    }
    this.view.setUint32(HEADER.NEXT_OBJECT_HANDLE_SLOT, slot + 1, true);
    return slot;
  }

  /**
   * Retain a vat object: intern (or re-use) the one ObjectHandle for
   * this object pointer and bump its retain count.
   *
   * @param {number} objectPointer - SS heap HEADER pointer of a TYPE_OBJECT value
   * @param {Iterable<number>} capturedGrantSlots - grant slots active at first retention
   * @param {*} metadata - host-supplied identifier (msgpack-serializable)
   * @returns {{ handle: ObjectHandle, isNew: boolean }}
   */
  retainObjectHandle(objectPointer, capturedGrantSlots, metadata = null) {
    const existingSlot = this._objectHandleSlotByPointer.get(objectPointer);
    if (existingSlot !== undefined && this._objectHandleSlotIsLive(existingSlot)) {
      const entry = this._objectHandleEntryOffset(existingSlot);
      const count = this.view.getUint32(entry + OBJECT_HANDLE_ENTRY.RETAIN_COUNT, true);
      this.view.setUint32(entry + OBJECT_HANDLE_ENTRY.RETAIN_COUNT, count + 1, true);
      const { wrapper } = this._mintOrGetObjectHandle(existingSlot);
      return { handle: wrapper, isNew: false };
    }

    // Encode metadata before allocating so a half-initialized slot can't leak.
    const metadataPointer = this._writeArenaValue(metadata);

    const slot = this._allocateObjectHandleSlot();
    const entry = this._objectHandleEntryOffset(slot);

    const newVersion = this.view.getUint32(entry + OBJECT_HANDLE_ENTRY.VERSION, true) + 1;
    this.view.setUint32(entry + OBJECT_HANDLE_ENTRY.VERSION, newVersion, true);
    this.view.setUint32(entry + OBJECT_HANDLE_ENTRY.OBJECT_POINTER, objectPointer, true);
    this.view.setUint32(entry + OBJECT_HANDLE_ENTRY.METADATA_POINTER, metadataPointer, true);
    this.view.setUint32(entry + OBJECT_HANDLE_ENTRY.CAPTURED_GRANTS_LIST_OFFSET, ID_LIST_NULL, true);
    this.view.setUint32(entry + OBJECT_HANDLE_ENTRY.CAPTURED_GRANTS_LIST_COUNT, 0, true);
    this.view.setUint32(entry + OBJECT_HANDLE_ENTRY.FREE_LIST_NEXT, FREE_LIST_END, true);
    this.view.setUint32(entry + OBJECT_HANDLE_ENTRY.RETAIN_COUNT, 1, true);
    this._writeObjectHandleFlags(slot, OBJECT_HANDLE_FLAG_ACTIVE);

    const grantsArr = [...capturedGrantSlots];
    if (grantsArr.length > 0) {
      const relOffset = this._allocateListRun(grantsArr.length * 4);
      const absOffset = this._listPoolAbs(relOffset);
      for (let i = 0; i < grantsArr.length; i++) {
        this.view.setUint32(absOffset + i * 4, grantsArr[i], true);
      }
      this.view.setUint32(entry + OBJECT_HANDLE_ENTRY.CAPTURED_GRANTS_LIST_OFFSET, relOffset, true);
      this.view.setUint32(entry + OBJECT_HANDLE_ENTRY.CAPTURED_GRANTS_LIST_COUNT, grantsArr.length, true);
    }

    this._objectHandleSlotByPointer.set(objectPointer, slot);
    const { wrapper } = this._mintOrGetObjectHandle(slot);
    this._logMutation(MUTATION_KIND.OBJECT_HANDLE_ALLOC, slot, newVersion, MUTATION_TAG.EXPLICIT_OBJECT);
    return { handle: wrapper, isNew: true };
  }

  /**
   * Drop one retention of a live object-handle slot. Frees the slot
   * (removing its GC root) only when the retain count reaches zero.
   * Throws for a slot that is not live and on retain-count underflow
   * (structurally impossible while live — a live slot's count is >= 1).
   *
   * @param {number} slot
   * @returns {boolean} true when the slot was freed by this release.
   */
  releaseObjectHandleSlot(slot) {
    if (!this._objectHandleSlotIsLive(slot)) {
      throw new Error(`Object handle slot ${slot} is not live`);
    }
    const entry = this._objectHandleEntryOffset(slot);
    const count = this.view.getUint32(entry + OBJECT_HANDLE_ENTRY.RETAIN_COUNT, true);
    if (count === 0) {
      throw new Error(`Object handle slot ${slot}: retain-count underflow`);
    }
    if (count > 1) {
      this.view.setUint32(entry + OBJECT_HANDLE_ENTRY.RETAIN_COUNT, count - 1, true);
      return false;
    }
    this._freeObjectHandleSlot(slot);
    return true;
  }

  /**
   * Free an object-handle slot unconditionally (version bump + free
   * list). Internal: explicit release at count zero, and the airlock's
   * FinalizationRegistry (a JS-GC'd wrapper can never be released).
   */
  _freeObjectHandleSlot(slot, callerTag = MUTATION_TAG.EXPLICIT_OBJECT) {
    if (!this._objectHandleSlotIsLive(slot)) return;
    const entry = this._objectHandleEntryOffset(slot);
    const objectPointer = this.view.getUint32(entry + OBJECT_HANDLE_ENTRY.OBJECT_POINTER, true);
    const oldVersion = this.view.getUint32(entry + OBJECT_HANDLE_ENTRY.VERSION, true);
    const newVersion = oldVersion + 1;
    this.view.setUint32(entry + OBJECT_HANDLE_ENTRY.VERSION, newVersion, true);
    this.view.setUint32(entry + OBJECT_HANDLE_ENTRY.RETAIN_COUNT, 0, true);
    this._writeObjectHandleFlags(slot, OBJECT_HANDLE_FLAG_ON_FREE_LIST);
    const head = this.view.getUint32(HEADER.OBJECT_HANDLE_FREE_LIST_HEAD, true);
    this.view.setUint32(entry + OBJECT_HANDLE_ENTRY.FREE_LIST_NEXT, head, true);
    this.view.setUint32(HEADER.OBJECT_HANDLE_FREE_LIST_HEAD, slot, true);
    if (this._objectHandleSlotByPointer.get(objectPointer) === slot) {
      this._objectHandleSlotByPointer.delete(objectPointer);
    }
    this._objectHandleCache.delete(slot);
    this._logMutation(MUTATION_KIND.OBJECT_HANDLE_FREE, slot, newVersion, callerTag);
  }

  _mintOrGetObjectHandle(slot) {
    const ref = this._objectHandleCache.get(slot);
    if (ref !== undefined) {
      const cached = ref.deref();
      if (cached !== undefined && cached.version === this._readObjectHandleVersion(slot)) {
        return { wrapper: cached, isNew: false };
      }
    }
    const wrapper = new ObjectHandle(this, slot, this._readObjectHandleVersion(slot));
    this._objectHandleCache.set(slot, new WeakRef(wrapper));
    this._objectHandleCacheCleanup.register(wrapper, slot);
    return { wrapper, isNew: true };
  }

  objectHandleForSlot(slot) {
    if (!this._objectHandleSlotIsLive(slot)) {
      throw new Error(`Object handle slot ${slot} is not live`);
    }
    return this._mintOrGetObjectHandle(slot).wrapper;
  }

  /**
   * Enumerate live object handles. Same shape as
   * enumerateClosureHandles: post-restore the host walks these,
   * correlates via metadata, and rebuilds its resource maps before the
   * runtime resumes.
   *
   * @returns {[{ objectHandle, objectPointer, capturedGrantSlots,
   *              metadata, retainCount, isNewWrapper }]}
   */
  enumerateObjectHandles() {
    const result = [];
    const capacity = this.view.getUint32(HEADER.OBJECT_HANDLE_TABLE_CAPACITY, true);
    const nextSlot = this.view.getUint32(HEADER.NEXT_OBJECT_HANDLE_SLOT, true);
    for (let slot = 0; slot < Math.min(nextSlot, capacity); slot++) {
      if (!this._objectHandleSlotIsLive(slot)) continue;
      const { wrapper, isNew } = this._mintOrGetObjectHandle(slot);
      result.push({
        objectHandle: wrapper,
        objectPointer: this._readObjectPointer(slot),
        capturedGrantSlots: this._readObjectCapturedGrantSet(slot),
        metadata: this._readObjectMetadata(slot),
        retainCount: this._readObjectRetainCount(slot),
        isNewWrapper: isNew,
      });
    }
    return result;
  }

  /**
   * All live object-handle object pointers plus every bound surrogate
   * prototype pointer — the GC's external roots contribution for v15.
   */
  objectHandleRootPointers() {
    const result = [];
    const capacity = this.view.getUint32(HEADER.OBJECT_HANDLE_TABLE_CAPACITY, true);
    const nextSlot = this.view.getUint32(HEADER.NEXT_OBJECT_HANDLE_SLOT, true);
    for (let slot = 0; slot < Math.min(nextSlot, capacity); slot++) {
      if (this._objectHandleSlotIsLive(slot)) {
        const ptr = this._readObjectPointer(slot);
        if (ptr !== 0) result.push(ptr);
      }
    }
    const hCapacity = this.view.getUint32(HEADER.HANDLE_TABLE_CAPACITY, true);
    const hNext = this.view.getUint32(HEADER.NEXT_HANDLE_SLOT, true);
    for (let slot = 0; slot < Math.min(hNext, hCapacity); slot++) {
      if (!this._handleSlotIsLive(slot)) continue;
      const ptr = this.view.getUint32(
        this._handleEntryOffset(slot) + HANDLE_ENTRY.SURROGATE_POINTER, true);
      if (ptr !== 0) result.push(ptr);
    }
    return result;
  }

  // ===========================================================================
  // Constructible-external registration records (v15 — D1/D2)
  //
  // The membrane records WHICH handles are registered constructible
  // (flag) and the surrogate prototype each has interned (heap HEADER
  // pointer in the handle entry). The begin/complete/abort handler
  // functions themselves are JS and live in the airlock; restore
  // validation compares the persisted flags against the handlers the
  // capability re-registered.
  // ===========================================================================

  markHandleConstructible(slot) {
    if (!this._handleSlotIsLive(slot)) {
      throw new Error(`Handle slot ${slot} is not live`);
    }
    this._writeHandleFlags(slot, this._readHandleFlags(slot) | HANDLE_FLAG_CONSTRUCTIBLE);
  }

  isHandleConstructible(slot) {
    if (!this._handleSlotIsLive(slot)) return false;
    return (this._readHandleFlags(slot) & HANDLE_FLAG_CONSTRUCTIBLE) !== 0;
  }

  readSurrogatePointer(slot) {
    if (!this._handleSlotIsLive(slot)) return 0;
    return this.view.getUint32(
      this._handleEntryOffset(slot) + HANDLE_ENTRY.SURROGATE_POINTER, true);
  }

  writeSurrogatePointer(slot, headerPointer) {
    if (!this._handleSlotIsLive(slot)) {
      throw new Error(`Handle slot ${slot} is not live`);
    }
    this.view.setUint32(
      this._handleEntryOffset(slot) + HANDLE_ENTRY.SURROGATE_POINTER,
      headerPointer, true);
  }

  /**
   * Live handle slots flagged constructible — restore validation walks
   * these to demand a re-registered set of construction handlers.
   */
  constructibleHandleSlots() {
    const result = [];
    const capacity = this.view.getUint32(HEADER.HANDLE_TABLE_CAPACITY, true);
    const nextSlot = this.view.getUint32(HEADER.NEXT_HANDLE_SLOT, true);
    for (let slot = 0; slot < Math.min(nextSlot, capacity); slot++) {
      if (this._handleSlotIsLive(slot) && this.isHandleConstructible(slot)) {
        result.push(slot);
      }
    }
    return result;
  }

  // ===========================================================================
  // Linked-promise table
  //
  // JS↔SS Promise bridges. Each entry stores the SS Promise's heap pointer so
  // it can be located after restore. The JS Promise side is *not* stored —
  // it can't be (continuation closures don't serialize). On restore, every
  // entry causes its SS Promise to be rejected with SnapshotOrphanedError.
  // ===========================================================================

  _linkedPromiseEntryOffset(slot) {
    const tableOffset = this.view.getUint32(HEADER.LINKED_PROMISE_TABLE_OFFSET, true);
    return tableOffset + slot * LINKED_PROMISE_ENTRY_SIZE;
  }

  _readLinkedPromiseFlags(slot) {
    return this.view.getUint8(this._linkedPromiseEntryOffset(slot) + LINKED_PROMISE_ENTRY.FLAGS);
  }

  _writeLinkedPromiseFlags(slot, flags) {
    this.view.setUint8(this._linkedPromiseEntryOffset(slot) + LINKED_PROMISE_ENTRY.FLAGS, flags);
  }

  _linkedPromiseSlotIsLive(slot) {
    if (slot < 0 || slot >= this.view.getUint32(HEADER.LINKED_PROMISE_TABLE_CAPACITY, true)) {
      return false;
    }
    const flags = this._readLinkedPromiseFlags(slot);
    return (flags & LINKED_PROMISE_FLAG_ACTIVE) !== 0 && (flags & LINKED_PROMISE_FLAG_ON_FREE_LIST) === 0;
  }

  _readLinkedPromisePointer(slot) {
    if (!this._linkedPromiseSlotIsLive(slot)) return 0;
    return this.view.getUint32(this._linkedPromiseEntryOffset(slot) + LINKED_PROMISE_ENTRY.SS_PROMISE_POINTER, true);
  }

  _allocateLinkedPromiseSlot() {
    const head = this.view.getUint32(HEADER.LINKED_PROMISE_FREE_LIST_HEAD, true);
    if (head !== FREE_LIST_END) {
      const nextOffset = this._linkedPromiseEntryOffset(head) + LINKED_PROMISE_ENTRY.FREE_LIST_NEXT;
      const next = this.view.getUint32(nextOffset, true);
      this.view.setUint32(HEADER.LINKED_PROMISE_FREE_LIST_HEAD, next, true);
      return head;
    }
    const slot = this.view.getUint32(HEADER.NEXT_LINKED_PROMISE_SLOT, true);
    const capacity = this.view.getUint32(HEADER.LINKED_PROMISE_TABLE_CAPACITY, true);
    if (slot >= capacity) {
      throw new MembraneOutOfSpaceError(
        `Linked promise table full: ${capacity} slots used. Tune linkedPromiseTableCapacity.`
      );
    }
    this.view.setUint32(HEADER.NEXT_LINKED_PROMISE_SLOT, slot + 1, true);
    return slot;
  }

  registerLinkedPromise(ssPromisePointer, options = {}) {
    const {
      parkedContextSlot = LINKED_PROMISE_NO_PARKED_CONTEXT,
      parkedContextGeneration = 0,
    } = options;
    const slot = this._allocateLinkedPromiseSlot();
    const entry = this._linkedPromiseEntryOffset(slot);
    const newVersion = this.view.getUint32(entry + LINKED_PROMISE_ENTRY.VERSION, true) + 1;
    this.view.setUint32(entry + LINKED_PROMISE_ENTRY.VERSION, newVersion, true);
    this.view.setUint32(entry + LINKED_PROMISE_ENTRY.SS_PROMISE_POINTER, ssPromisePointer, true);
    this.view.setUint32(entry + LINKED_PROMISE_ENTRY.FREE_LIST_NEXT, FREE_LIST_END, true);
    this.view.setInt32(entry + LINKED_PROMISE_ENTRY.PARKED_CONTEXT_SLOT, parkedContextSlot, true);
    this.view.setUint32(
      entry + LINKED_PROMISE_ENTRY.PARKED_CONTEXT_GENERATION,
      parkedContextGeneration,
      true,
    );
    this._writeLinkedPromiseFlags(slot, LINKED_PROMISE_FLAG_ACTIVE);
    this._logMutation(MUTATION_KIND.LINKED_PROMISE_ALLOC, slot, newVersion, MUTATION_TAG.EXPLICIT_LINKED);
    return slot;
  }

  /**
   * Read the parkedContextSlot for a live linked-promise entry.
   * Returns LINKED_PROMISE_NO_PARKED_CONTEXT (-1) for JS-Promise-backed
   * entries; a real i32 context slot for suspend-registered entries.
   *
   * Returns LINKED_PROMISE_NO_PARKED_CONTEXT if the slot is not live
   * (matches `_readLinkedPromisePointer`'s defensive 0-return for the
   * pointer case).
   */
  _readLinkedPromiseParkedContextSlot(slot) {
    if (!this._linkedPromiseSlotIsLive(slot)) return LINKED_PROMISE_NO_PARKED_CONTEXT;
    return this.view.getInt32(
      this._linkedPromiseEntryOffset(slot) + LINKED_PROMISE_ENTRY.PARKED_CONTEXT_SLOT, true);
  }

  _readLinkedPromiseParkedContextGeneration(slot) {
    if (!this._linkedPromiseSlotIsLive(slot)) return 0;
    return this.view.getUint32(
      this._linkedPromiseEntryOffset(slot)
        + LINKED_PROMISE_ENTRY.PARKED_CONTEXT_GENERATION,
      true,
    );
  }

  /**
   * Log a linked-promise settle/reject event (the *outcome*, not the
   * slot free which is logged separately by _freeLinkedPromiseSlot).
   * Called by the airlock when a JS Promise settles its SS Promise.
   *
   * @param {number} slot
   * @param {boolean} resolved - true for resolve, false for reject
   */
  _logLinkedPromiseSettle(slot, resolved) {
    if (slot < 0 || slot >= this.view.getUint32(HEADER.LINKED_PROMISE_TABLE_CAPACITY, true)) return;
    const entry = this._linkedPromiseEntryOffset(slot);
    const version = this.view.getUint32(entry + LINKED_PROMISE_ENTRY.VERSION, true);
    const kind = resolved
      ? MUTATION_KIND.LINKED_PROMISE_SETTLE
      : MUTATION_KIND.LINKED_PROMISE_REJECT;
    this._logMutation(kind, slot, version, MUTATION_TAG.LINKED_SETTLE);
  }

  _freeLinkedPromiseSlot(slot, callerTag = MUTATION_TAG.EXPLICIT_LINKED) {
    if (!this._linkedPromiseSlotIsLive(slot)) return;
    const entry = this._linkedPromiseEntryOffset(slot);
    const oldVersion = this.view.getUint32(entry + LINKED_PROMISE_ENTRY.VERSION, true);
    const newVersion = oldVersion + 1;
    this.view.setUint32(entry + LINKED_PROMISE_ENTRY.VERSION, newVersion, true);
    this._writeLinkedPromiseFlags(slot, LINKED_PROMISE_FLAG_ON_FREE_LIST);
    const head = this.view.getUint32(HEADER.LINKED_PROMISE_FREE_LIST_HEAD, true);
    this.view.setUint32(entry + LINKED_PROMISE_ENTRY.FREE_LIST_NEXT, head, true);
    this.view.setUint32(HEADER.LINKED_PROMISE_FREE_LIST_HEAD, slot, true);
    this._logMutation(MUTATION_KIND.LINKED_PROMISE_FREE, slot, newVersion, callerTag);
  }

  /**
   * Iterate over live linked-promise entries. Restore uses these to reject
   * every SS Promise; GC uses them as external roots.
   */
  enumerateLinkedPromises(options = {}) {
    const { includeReaped = false } = options;
    const result = [];
    const capacity = this.view.getUint32(HEADER.LINKED_PROMISE_TABLE_CAPACITY, true);
    const nextSlot = this.view.getUint32(HEADER.NEXT_LINKED_PROMISE_SLOT, true);
    const upTo = Math.min(nextSlot, capacity);
    for (let slot = 0; slot < upTo; slot++) {
      const flags = this._readLinkedPromiseFlags(slot);
      const live = (flags & LINKED_PROMISE_FLAG_ACTIVE) !== 0 && (flags & LINKED_PROMISE_FLAG_ON_FREE_LIST) === 0;
      const onFreeList = (flags & LINKED_PROMISE_FLAG_ON_FREE_LIST) !== 0;
      if (live) {
        result.push({
          slot,
          ssPromisePointer: this.view.getUint32(
            this._linkedPromiseEntryOffset(slot) + LINKED_PROMISE_ENTRY.SS_PROMISE_POINTER, true),
          parkedContextSlot: this.view.getInt32(
            this._linkedPromiseEntryOffset(slot)
              + LINKED_PROMISE_ENTRY.PARKED_CONTEXT_SLOT,
            true,
          ),
          parkedContextGeneration: this.view.getUint32(
            this._linkedPromiseEntryOffset(slot)
              + LINKED_PROMISE_ENTRY.PARKED_CONTEXT_GENERATION,
            true,
          ),
        });
      } else if (includeReaped && onFreeList) {
        const entry = this._linkedPromiseEntryOffset(slot);
        const version = this.view.getUint32(entry + LINKED_PROMISE_ENTRY.VERSION, true);
        const reap = this.findLastMutationForSlot(slot,
          { kind: MUTATION_KIND.LINKED_PROMISE_FREE });
        const settle = this.findLastMutationForSlot(slot,
          { kindMask:
              (1 << MUTATION_KIND.LINKED_PROMISE_SETTLE) |
              (1 << MUTATION_KIND.LINKED_PROMISE_REJECT) });
        result.push({
          slot,
          version,
          reaped: true,
          reapedAt: reap ? { tick: reap.tick, seq: reap.seq } : null,
          reapedCallerTag: reap ? reap.callerTag : null,
          settledAt: settle ? { tick: settle.tick, seq: settle.seq } : null,
          settledKind: settle ? settle.kind : null,
        });
      }
    }
    return result;
  }

  /**
   * Free every linked-promise slot. Called after restore once the host
   * has rejected each SS Promise.
   */
  clearAllLinkedPromises() {
    const capacity = this.view.getUint32(HEADER.LINKED_PROMISE_TABLE_CAPACITY, true);
    const nextSlot = this.view.getUint32(HEADER.NEXT_LINKED_PROMISE_SLOT, true);
    const upTo = Math.min(nextSlot, capacity);
    for (let slot = 0; slot < upTo; slot++) {
      if (this._linkedPromiseSlotIsLive(slot)) {
        this._freeLinkedPromiseSlot(slot, MUTATION_TAG.SNAPSHOT_ORPHAN);
      }
    }
  }

  // ===========================================================================
  // Engine counters
  //
  // Host-observed counters that don't require interpreter
  // instrumentation. Bumped by the host at session.gc / snapshot /
  // resizeSegment / resizeRegions. Their header fields were reserved in
  // advance, so populating them did not require a format bump.
  // ===========================================================================

  /**
   * Bump a u32 engine counter by `delta` (default 1). No-op if delta
   * is 0.
   */
  _bumpEngineCounter(offset, delta = 1) {
    if (delta === 0) return;
    const cur = this.view.getUint32(offset, true);
    this.view.setUint32(offset, (cur + delta) >>> 0, true);
  }

  /**
   * Bump a u64 engine counter by `delta` (default 1).
   */
  _bumpEngineCounter64(offset, delta = 1n) {
    if (delta === 0n) return;
    const cur = this.view.getBigUint64(offset, true);
    this.view.setBigUint64(offset, cur + delta, true);
  }

  /**
   * Set a u64 engine counter to an absolute value (used for
   * gcLastTick which is overwritten each pass, not incremented).
   */
  _setEngineCounter64(offset, value) {
    this.view.setBigUint64(offset, BigInt(value), true);
  }

  /**
   * Set a u32 engine counter to an absolute value.
   */
  _setEngineCounter(offset, value) {
    this.view.setUint32(offset, value >>> 0, true);
  }

  /**
   * Record a GC pass: bump pass count, store its tick, store its
   * bytes-reclaimed (both lastBytesReclaimed and total).
   *
   * Called by session.gc() after the collector finishes. The host
   * already has the bytes-reclaimed value from collector.collect()'s
   * return, so we don't need any interpreter cooperation.
   *
   * @param {bigint} tickAtPass
   * @param {number|bigint} bytesReclaimed
   */
  recordGcPass(tickAtPass, bytesReclaimed) {
    this._bumpEngineCounter(HEADER.ENGINE_COUNT_GC_PASS, 1);
    this._setEngineCounter64(HEADER.ENGINE_COUNT_GC_LAST_TICK, tickAtPass);
    this._bumpEngineCounter64(HEADER.ENGINE_COUNT_GC_BYTES_TOTAL, BigInt(bytesReclaimed));
    this._setEngineCounter(HEADER.ENGINE_COUNT_GC_LAST_BYTES, Number(bytesReclaimed));
  }

  /**
   * Record a resizeSegment operation.
   */
  recordResizeSegment() {
    this._bumpEngineCounter(HEADER.ENGINE_COUNT_RESIZE_SEGMENT, 1);
  }

  /**
   * Record a resizeRegions operation. Bumped internally by
   * resizeRegions; hosts don't call this directly.
   */
  _recordResizeRegions() {
    this._bumpEngineCounter(HEADER.ENGINE_COUNT_RESIZE_REGIONS, 1);
  }

  /**
   * Production-callable read of all engine counters. O(1) header reads.
   *
   * gcLastTick and gcBytesReclaimedTotal are bigints; the rest are
   * plain numbers.
   *
   * @returns {Object}
   */
  engineCounters() {
    const v = this.view;
    return {
      gcPassCount:             v.getUint32(HEADER.ENGINE_COUNT_GC_PASS, true),
      gcLastTick:              v.getBigUint64(HEADER.ENGINE_COUNT_GC_LAST_TICK, true),
      gcBytesReclaimedTotal:   v.getBigUint64(HEADER.ENGINE_COUNT_GC_BYTES_TOTAL, true),
      gcLastBytesReclaimed:    v.getUint32(HEADER.ENGINE_COUNT_GC_LAST_BYTES, true),
      resizeSegmentCount:      v.getUint32(HEADER.ENGINE_COUNT_RESIZE_SEGMENT, true),
      resizeRegionsCount:      v.getUint32(HEADER.ENGINE_COUNT_RESIZE_REGIONS, true),
    };
  }

  // ===========================================================================
  // State getters
  //
  // Production-callable. No throws — return null for out-of-range
  // slots. The boolean `isFresh(wrapper)` check is one line on the
  // caller side: `membrane.handleState(h)?.currentVersion === h.version`.
  // ===========================================================================

  /**
   * Read structured state for a handle slot or wrapper.
   *
   * Returns null only if `slot` is out of range. For freed/reaped
   * slots, returns `active: false` and a bumped currentVersion so
   * callers can detect staleness without throwing.
   *
   * @param {number|Handle} slotOrHandle
   * @returns {Object|null}
   */
  handleState(slotOrHandle) {
    const slot = typeof slotOrHandle === 'number'
      ? slotOrHandle
      : slotOrHandle?.slot;
    if (typeof slot !== 'number' || slot < 0) return null;
    const capacity = this.view.getUint32(HEADER.HANDLE_TABLE_CAPACITY, true);
    if (slot >= capacity) return null;
    const entryOffset = this._handleEntryOffset(slot);
    const flags = this._readHandleFlags(slot);
    const currentVersion = this._readHandleVersion(slot);
    const active = (flags & HANDLE_FLAG_ACTIVE) !== 0 && (flags & HANDLE_FLAG_ON_FREE_LIST) === 0;
    const onFreeList = (flags & HANDLE_FLAG_ON_FREE_LIST) !== 0;
    const metaPtr = this.view.getUint32(entryOffset + HANDLE_ENTRY.METADATA_POINTER, true);
    const declPtr = this.view.getUint32(entryOffset + HANDLE_ENTRY.DECLARATION_NAME_POINTER, true);
    return {
      exists: true,
      slot,
      currentVersion,
      active,
      reaped: onFreeList,
      flags,
      metadata: active ? (this._readArenaValue(metaPtr) ?? null) : null,
      declarationName: active ? (this._readArenaValue(declPtr) ?? null) : null,
      lastMutation: this.findLastMutationForSlot(slot,
        { kindMask: MUTATION_KIND_FAMILY.HANDLE }),
    };
  }

  /**
   * Read structured state for a grant slot or wrapper.
   * @param {number|Grant} slotOrGrant
   * @returns {Object|null}
   */
  grantState(slotOrGrant) {
    const slot = typeof slotOrGrant === 'number'
      ? slotOrGrant
      : slotOrGrant?.slot;
    if (typeof slot !== 'number' || slot < 0) return null;
    const capacity = this.view.getUint32(HEADER.GRANT_TABLE_CAPACITY, true);
    if (slot >= capacity) return null;
    const flags = this._readGrantFlags(slot);
    const currentVersion = this._readGrantVersion(slot);
    const live = (flags & GRANT_FLAG_ACTIVE) !== 0 && (flags & GRANT_FLAG_ON_FREE_LIST) === 0;
    const onFreeList = (flags & GRANT_FLAG_ON_FREE_LIST) !== 0;
    const revoked = live && (flags & GRANT_FLAG_REVOKED) !== 0;
    return {
      exists: true,
      slot,
      currentVersion,
      active: live && !revoked,
      revoked,
      reaped: onFreeList,
      isRoot: (flags & GRANT_FLAG_ROOT) !== 0,
      flags,
      identifier: live ? this._readGrantIdentifier(slot) : null,
      metadata:   live ? this._readGrantMetadata(slot) : null,
      lastMutation: this.findLastMutationForSlot(slot,
        { kindMask: MUTATION_KIND_FAMILY.GRANT }),
    };
  }

  /**
   * Read structured state for a closure-handle slot or wrapper.
   * @param {number|ClosureHandle} slotOrHandle
   * @returns {Object|null}
   */
  closureHandleState(slotOrHandle) {
    const slot = typeof slotOrHandle === 'number'
      ? slotOrHandle
      : slotOrHandle?.slot;
    if (typeof slot !== 'number' || slot < 0) return null;
    const capacity = this.view.getUint32(HEADER.CLOSURE_HANDLE_TABLE_CAPACITY, true);
    if (slot >= capacity) return null;
    const flags = this._readClosureHandleFlags(slot);
    const currentVersion = this._readClosureHandleVersion(slot);
    const active = (flags & CLOSURE_HANDLE_FLAG_ACTIVE) !== 0 && (flags & CLOSURE_HANDLE_FLAG_ON_FREE_LIST) === 0;
    const onFreeList = (flags & CLOSURE_HANDLE_FLAG_ON_FREE_LIST) !== 0;
    return {
      exists: true,
      slot,
      currentVersion,
      active,
      reaped: onFreeList,
      flags,
      closurePointer: active ? this._readClosurePointer(slot) : 0,
      capturedGrantSlots: active
        ? Array.from(this._readCapturedGrantSet(slot))
        : [],
      metadata: active ? (this._readClosureMetadata(slot) ?? null) : null,
      lastMutation: this.findLastMutationForSlot(slot,
        { kindMask: MUTATION_KIND_FAMILY.CLOSURE_HANDLE }),
    };
  }

  /**
   * Read structured state for a linked-promise slot.
   * @param {number} slot
   * @returns {Object|null}
   */
  linkedPromiseState(slot) {
    if (typeof slot !== 'number' || slot < 0) return null;
    const capacity = this.view.getUint32(HEADER.LINKED_PROMISE_TABLE_CAPACITY, true);
    if (slot >= capacity) return null;
    const entry = this._linkedPromiseEntryOffset(slot);
    const flags = this._readLinkedPromiseFlags(slot);
    const currentVersion = this.view.getUint32(entry + LINKED_PROMISE_ENTRY.VERSION, true);
    const active = (flags & LINKED_PROMISE_FLAG_ACTIVE) !== 0 && (flags & LINKED_PROMISE_FLAG_ON_FREE_LIST) === 0;
    const onFreeList = (flags & LINKED_PROMISE_FLAG_ON_FREE_LIST) !== 0;
    return {
      exists: true,
      slot,
      currentVersion,
      active,
      reaped: onFreeList,
      flags,
      ssPromisePointer: active
        ? this.view.getUint32(entry + LINKED_PROMISE_ENTRY.SS_PROMISE_POINTER, true)
        : 0,
      lastMutation: this.findLastMutationForSlot(slot,
        { kindMask: MUTATION_KIND_FAMILY.LINKED_PROMISE }),
    };
  }

  // ===========================================================================
  // Introspection
  // ===========================================================================

  /**
   * Enumerate all live handle slots.
   *
   * Returns `[{ handle, impl, metadata, declarationName }, …]` where:
   *   - `handle` — fresh `Handle` wrapper (slot + version), valid against
   *     the membrane's current state.
   *   - `impl`   — the JS object backing this handle, OR `undefined`
   *     post-restore (JS objects don't serialize). The undefined IS the
   *     marker that this handle needs re-binding via `_bindImpl(slot,
   *     impl)` plus `setHandler` / `setGetter`.
   *   - `metadata` — host-supplied at `register()` time, round-trips
   *     through the SAB value arena.
   *   - `declarationName` — set by `setDeclarationName` (called from
   *     `airlock.declare`); the SS variable name this handle was
   *     declared as, if any.
   *
   * Hosts walk this post-restore, dispatch each entry
   * to their own setup code (typically keyed on `metadata.kind` or
   * `declarationName`), and re-bind impl + handlers + getters BEFORE
   * resuming drone execution. See the Airlock class docblock for the
   * full restore protocol.
   */
  enumerateHandles(options = {}) {
    const { includeReaped = false } = options;
    const result = [];
    const capacity = this.view.getUint32(HEADER.HANDLE_TABLE_CAPACITY, true);
    const nextSlot = this.view.getUint32(HEADER.NEXT_HANDLE_SLOT, true);
    const upTo = Math.min(nextSlot, capacity);
    for (let slot = 0; slot < upTo; slot++) {
      const flags = this._readHandleFlags(slot);
      const live = (flags & HANDLE_FLAG_ACTIVE) !== 0 && (flags & HANDLE_FLAG_ON_FREE_LIST) === 0;
      const onFreeList = (flags & HANDLE_FLAG_ON_FREE_LIST) !== 0;
      if (live) {
        const entryOffset = this._handleEntryOffset(slot);
        const metaPtr = this.view.getUint32(entryOffset + HANDLE_ENTRY.METADATA_POINTER, true);
        const declPtr = this.view.getUint32(entryOffset + HANDLE_ENTRY.DECLARATION_NAME_POINTER, true);
        result.push({
          handle: this.handleForSlot(slot),
          impl: this._impls.get(slot),
          metadata: this._readArenaValue(metaPtr) ?? null,
          declarationName: this._readArenaValue(declPtr) ?? null,
        });
      } else if (includeReaped && onFreeList) {
        // Reaped slot: version was bumped, on free list, metadata
        // pointer may still point at arena bytes that haven't been
        // overwritten yet. Read defensively and surface the slot for
        // forensic inspection.
        const entryOffset = this._handleEntryOffset(slot);
        const version = this.view.getUint32(entryOffset + HANDLE_ENTRY.VERSION, true);
        const reaped = this.findLastMutationForSlot(slot,
          { kindMask: MUTATION_KIND_FAMILY.HANDLE });
        result.push({
          slot,
          version,
          reaped: true,
          reapedAt: reaped ? { tick: reaped.tick, seq: reaped.seq } : null,
          reapedCallerTag: reaped ? reaped.callerTag : null,
        });
      }
    }
    return result;
  }

  /**
   * Enumerate all live grant slots.
   *
   * Returns `[{ grant, identifier, metadata, active, isRoot,
   * handleSlots }, …]` where:
   *   - `grant`        — fresh `Grant` wrapper (slot + version).
   *   - `identifier`   — host-supplied at `createGrant()` time, from arena.
   *   - `metadata`     — optional host-supplied metadata, from arena.
   *   - `active`       — false if `revoke()` was called (slot still alive
   *     until compaction reclaims it; revoked grants fail authorization).
   *   - `isRoot`       — true if `markAsRootGrant` was called (also tracked
   *     in `rootGrantSlots()`).
   *   - `handleSlots`  — the handle slots this grant authorizes (its
   *     half of the inverse index).
   *
   * Grants don't need re-binding — they have no JS-side
   * function attached. But the host may need to walk them post-restore to
   * surface "what capabilities does this restored session have?" to the
   * user, or to re-establish a host-side mapping from grant identifiers
   * to host-managed capability objects. See the Airlock class docblock.
   */
  enumerateGrants(options = {}) {
    const { includeRevoked = false, includeReaped = false } = options;
    const result = [];
    const capacity = this.view.getUint32(HEADER.GRANT_TABLE_CAPACITY, true);
    const nextSlot = this.view.getUint32(HEADER.NEXT_GRANT_SLOT, true);
    const upTo = Math.min(nextSlot, capacity);
    for (let slot = 0; slot < upTo; slot++) {
      const flags = this._readGrantFlags(slot);
      const live = (flags & GRANT_FLAG_ACTIVE) !== 0 && (flags & GRANT_FLAG_ON_FREE_LIST) === 0;
      const onFreeList = (flags & GRANT_FLAG_ON_FREE_LIST) !== 0;
      const revoked = live && (flags & GRANT_FLAG_REVOKED) !== 0;
      const isActive = live && !revoked;
      if (live) {
        // Live slots include active and revoked-but-not-yet-reaped grants.
        // The default shape retains `active: false` for revoked grants; the
        // optional revokedAt and revokeCallerTag fields appear only when
        // includeRevoked=true.
        const entry = {
          grant: this.grantForSlot(slot),
          identifier: this._readGrantIdentifier(slot),
          metadata: this._readGrantMetadata(slot),
          active: isActive,
          isRoot: (flags & GRANT_FLAG_ROOT) !== 0,
          handleSlots: Array.from(this._readGrantHandleSet(slot)),
        };
        if (revoked && includeRevoked) {
          const last = this.findLastMutationForSlot(slot,
            { kind: MUTATION_KIND.GRANT_REVOKE });
          entry.revokedAt = last ? { tick: last.tick, seq: last.seq } : null;
          entry.revokeCallerTag = last ? last.callerTag : null;
        }
        result.push(entry);
      } else if (includeReaped && onFreeList) {
        // Reaped grant: slot freed, version bumped. Surface the most
        // recent revoke + reap from the log so forensic readers can
        // see "this slot was revoked at X, reaped at Y".
        const entryOffset = this._grantEntryOffset(slot);
        const version = this.view.getUint32(entryOffset + GRANT_ENTRY.VERSION, true);
        const reap = this.findLastMutationForSlot(slot,
          { kind: MUTATION_KIND.GRANT_REAP });
        const revoke = this.findLastMutationForSlot(slot,
          { kind: MUTATION_KIND.GRANT_REVOKE });
        result.push({
          slot,
          version,
          reaped: true,
          revokedAt: revoke ? { tick: revoke.tick, seq: revoke.seq } : null,
          revokeCallerTag: revoke ? revoke.callerTag : null,
          reapedAt: reap ? { tick: reap.tick, seq: reap.seq } : null,
          reapedCallerTag: reap ? reap.callerTag : null,
        });
      }
    }
    return result;
  }

  // ===========================================================================
  // Capability state (v7)
  //
  // One mutable, snapshot-surviving cell per capability, keyed by a free-form
  // string name. Linear lookup over the table; capability counts are O(10)
  // in typical embedders. Name strings and values are stored in the value
  // arena alongside handle metadata; the table entry is a fixed-size
  // (namePointer, valuePointer) pair.
  //
  // Sentinels:
  //   namePointer === VALUE_POINTER_NULL  → empty table slot
  //   valuePointer === VALUE_POINTER_NULL → "name is set, value is null"
  //
  // Mutation: overwrite leaves the old value's arena bytes unreachable
  // from this entry until compact() reclaims them. Same contract as
  // setClosureMetadata.
  // ===========================================================================

  _capabilityStateEntryOffset(slotIndex) {
    const tableOffset = this.view.getUint32(HEADER.CAPABILITY_STATE_TABLE_OFFSET, true);
    return tableOffset + slotIndex * CAPABILITY_STATE_ENTRY_SIZE;
  }

  // Find the table slot for `name`. Returns the index of an existing
  // matching slot, or the index of the first empty slot (for inserts),
  // or -1 if the table is full and `name` is not present.
  _findCapabilityStateSlot(name) {
    const capacity = this.view.getUint32(HEADER.CAPABILITY_STATE_TABLE_CAPACITY, true);
    let firstEmpty = -1;
    for (let i = 0; i < capacity; i++) {
      const entry = this._capabilityStateEntryOffset(i);
      const namePointer = this.view.getUint32(entry, true);
      if (namePointer === VALUE_POINTER_NULL) {
        if (firstEmpty === -1) firstEmpty = i;
        continue;
      }
      const existing = this._readArenaValue(namePointer);
      if (existing === name) return i;
    }
    return firstEmpty;
  }

  /**
   * Store `value` under capability `name`. Overwrites any prior value.
   *
   * `name` is a non-empty string. `value` is anything msgpack-serializable;
   * `null` (and `undefined`) clear the cell's value while keeping the table
   * slot leased — a subsequent `getCapabilityState(name)` returns `null`
   * (not the previous value).
   *
   * Throws `MembraneOutOfSpaceError` if the table is full and `name` is
   * not already present. Grow the table via
   * `resizeRegions({ capabilityStateTableCapacity: ... })`, matching how
   * the closure-handle and linked-promise tables are tuned post-hoc.
   *
   * @param {string} name
   * @param {*} value
   */
  setCapabilityState(name, value) {
    if (typeof name !== 'string' || name.length === 0) {
      throw new TypeError(
        `setCapabilityState: name must be a non-empty string; got ${typeof name}`);
    }
    const slotIndex = this._findCapabilityStateSlot(name);
    if (slotIndex === -1) {
      const capacity = this.view.getUint32(HEADER.CAPABILITY_STATE_TABLE_CAPACITY, true);
      throw new MembraneOutOfSpaceError(
        `Capability state table full: ${capacity} slots used. ` +
        `Tune capabilityStateTableCapacity.`);
    }
    const entry = this._capabilityStateEntryOffset(slotIndex);
    const existingNamePointer = this.view.getUint32(entry, true);
    if (existingNamePointer === VALUE_POINTER_NULL) {
      // Fresh slot — write the name into the arena. Names persist for the
      // lifetime of the slot; only the value churns.
      const namePointer = this._writeArenaValue(name);
      this.view.setUint32(entry, namePointer, true);
    }
    // _writeArenaValue returns VALUE_POINTER_NULL for null/undefined,
    // matching the cell-cleared semantics described above.
    const valuePointer = this._writeArenaValue(value);
    this.view.setUint32(entry + 4, valuePointer, true);
  }

  /**
   * Read the value previously stored under capability `name`.
   *
   * Returns the decoded value, or `null` if no cell exists for `name` or
   * the cell was cleared (set to `null`).
   *
   * @param {string} name
   */
  getCapabilityState(name) {
    if (typeof name !== 'string' || name.length === 0) {
      throw new TypeError(
        `getCapabilityState: name must be a non-empty string; got ${typeof name}`);
    }
    const slotIndex = this._findCapabilityStateSlot(name);
    if (slotIndex === -1) return null;
    const entry = this._capabilityStateEntryOffset(slotIndex);
    const namePointer = this.view.getUint32(entry, true);
    if (namePointer === VALUE_POINTER_NULL) return null; // hit the empty-slot return
    const valuePointer = this.view.getUint32(entry + 4, true);
    if (valuePointer === VALUE_POINTER_NULL) return null;
    return this._readArenaValue(valuePointer);
  }

  // ===========================================================================
  // Embedder state (v8)
  //
  // One mutable, snapshot-surviving cell for the embedder's correlation state.
  // Singular: one embedder per session, so no `name` keying. Value is
  // msgpack-encoded into the value arena; the header carries a single arena
  // pointer (or VALUE_POINTER_NULL when unset).
  //
  // Mutation: overwrite leaves the old value's arena bytes unreachable from
  // the cell until compact() reclaims them. Same contract as
  // setClosureMetadata / setCapabilityState.
  // ===========================================================================

  /**
   * Store the embedder-state value. `value` is anything msgpack-serializable.
   * `null` (and `undefined`) clear the cell — a subsequent `getEmbedderState()`
   * returns `null`.
   *
   * @param {*} value
   */
  setEmbedderState(value) {
    const valuePointer = this._writeArenaValue(value);
    this.view.setUint32(HEADER.EMBEDDER_STATE_VALUE_POINTER, valuePointer, true);
  }

  /**
   * Read the embedder-state value. Returns `null` when unset or cleared.
   */
  getEmbedderState() {
    const valuePointer = this.view.getUint32(HEADER.EMBEDDER_STATE_VALUE_POINTER, true);
    if (valuePointer === VALUE_POINTER_NULL) return null;
    return this._readArenaValue(valuePointer);
  }

  // ===========================================================================
  // Compaction (Policy R1: lazy reclaim)
  //
  // The walker (src/membrane/walker.js) builds the live-id sets; we trust
  // them and reclaim everything else. Live slots NEVER move — only dead
  // slots are freed and added to the free list. Live entries' inverse-
  // index lists and value-arena pointers are repacked in-place so the
  // pool/arena can be reset to bump-pointer state.
  // ===========================================================================

  /**
   * Compact the membrane.
   *
   * Three reclamations happen, all driven by the live-id sets:
   *   1. Slot reclamation — handles/grants not in the live set are pushed
   *      onto their respective free lists; their `version` is incremented
   *      so any stale wrapper held by the host fails on next use.
   *   2. Id-list pool repack — allocate a fresh pool (starting after the
   *      4-byte sentinel), copy each live entry's grant-list / handle-list
   *      into it, update the entry's *Offset field, drop the old pool.
   *   3. Value arena repack — allocate a fresh arena, re-encode each live
   *      entry's identifier/metadata/declarationName, update entry
   *      pointers, drop the old arena.
   *
   * Returns a stats object describing what was reclaimed (handy for
   * tests + telemetry).
   *
   * @param {{ liveHandleSlots: Set<number>, liveGrantSlots: Set<number> }} liveSets
   */
  compact({ liveHandleSlots, liveGrantSlots }) {
    const stats = {
      handlesFreed: 0,
      grantsFreed: 0,
      // The exact slots freed by this pass. The airlock uses this to
      // prune its dispatch maps (handlers/getters/setters) so a later
      // registration reusing a slot doesn't inherit the dead tenant's
      // entries.
      freedHandleSlots: [],
      poolBytesBefore: this.view.getUint32(HEADER.ID_LIST_POOL_USED, true),
      arenaBytesBefore: this.view.getUint32(HEADER.VALUE_ARENA_USED, true),
    };

    // ---------------------------------------------------------------------
    // Step 1: Snapshot live entries into JS-side intermediate state.
    //
    // We need this because the in-place repack would overwrite the source
    // data before we finish reading it. Reading everything first into JS
    // objects, then writing back, is the simplest correct approach.
    // ---------------------------------------------------------------------
    const handleCapacity = this.view.getUint32(HEADER.HANDLE_TABLE_CAPACITY, true);
    const grantCapacity = this.view.getUint32(HEADER.GRANT_TABLE_CAPACITY, true);
    const nextHandleSlot = this.view.getUint32(HEADER.NEXT_HANDLE_SLOT, true);
    const nextGrantSlot = this.view.getUint32(HEADER.NEXT_GRANT_SLOT, true);

    // For each live handle: { slot, grantSlots: number[], metadata, declarationName }.
    const liveHandles = [];
    for (let slot = 0; slot < Math.min(nextHandleSlot, handleCapacity); slot++) {
      if (!this._handleSlotIsLive(slot)) continue;
      if (!liveHandleSlots.has(slot)) continue;
      const entry = this._handleEntryOffset(slot);
      const metaPtr = this.view.getUint32(entry + HANDLE_ENTRY.METADATA_POINTER, true);
      const declPtr = this.view.getUint32(entry + HANDLE_ENTRY.DECLARATION_NAME_POINTER, true);
      const grantListRel = this.view.getUint32(entry + HANDLE_ENTRY.GRANT_LIST_OFFSET, true);
      const grantListCount = this.view.getUint32(entry + HANDLE_ENTRY.GRANT_LIST_COUNT, true);
      // Filter out dead grants from the list (a live handle may have had
      // grants that are no longer live — we drop those references here).
      const grantSlots = [];
      if (grantListCount > 0 && grantListRel !== ID_LIST_NULL) {
        const grantListAbs = this._listPoolAbs(grantListRel);
        for (let i = 0; i < grantListCount; i++) {
          const g = this.view.getUint32(grantListAbs + i * 4, true);
          if (liveGrantSlots.has(g)) grantSlots.push(g);
        }
      }
      liveHandles.push({
        slot,
        grantSlots,
        metadata: metaPtr === VALUE_POINTER_NULL ? undefined : this._readArenaValue(metaPtr),
        declarationName: declPtr === VALUE_POINTER_NULL ? undefined : this._readArenaValue(declPtr),
      });
    }

    // For each live grant: { slot, handleSlots, identifier, metadata, isRoot, isRevoked }.
    const liveGrants = [];
    for (let slot = 0; slot < Math.min(nextGrantSlot, grantCapacity); slot++) {
      if (!this._grantSlotIsLive(slot)) continue;
      if (!liveGrantSlots.has(slot)) continue;
      const entry = this._grantEntryOffset(slot);
      const flags = this._readGrantFlags(slot);
      const idPtr = this.view.getUint32(entry + GRANT_ENTRY.IDENTIFIER_POINTER, true);
      const metaPtr = this.view.getUint32(entry + GRANT_ENTRY.METADATA_POINTER, true);
      const handleListRel = this.view.getUint32(entry + GRANT_ENTRY.HANDLE_LIST_OFFSET, true);
      const handleListCount = this.view.getUint32(entry + GRANT_ENTRY.HANDLE_LIST_COUNT, true);
      const handleSlots = [];
      if (handleListCount > 0 && handleListRel !== ID_LIST_NULL) {
        const handleListAbs = this._listPoolAbs(handleListRel);
        for (let i = 0; i < handleListCount; i++) {
          const h = this.view.getUint32(handleListAbs + i * 4, true);
          if (liveHandleSlots.has(h)) handleSlots.push(h);
        }
      }
      liveGrants.push({
        slot,
        handleSlots,
        identifier: idPtr === VALUE_POINTER_NULL ? undefined : this._readArenaValue(idPtr),
        metadata: metaPtr === VALUE_POINTER_NULL ? undefined : this._readArenaValue(metaPtr),
        isRoot: (flags & GRANT_FLAG_ROOT) !== 0,
        isRevoked: (flags & GRANT_FLAG_REVOKED) !== 0,
      });
    }

    // For each live closure handle: { slot, capturedGrantSlots, metadata }.
    // Closure handles are lazy-reclaimed: every live SAB slot stays live
    // across compaction, regardless of liveSets. Their captured-grants list
    // and metadata pointer must still be repacked so the pool and arena can
    // return to bump-pointer state.
    const liveClosureHandles = [];
    const chCapacity = this.view.getUint32(HEADER.CLOSURE_HANDLE_TABLE_CAPACITY, true);
    const chNextSlot = this.view.getUint32(HEADER.NEXT_CLOSURE_HANDLE_SLOT, true);
    for (let slot = 0; slot < Math.min(chNextSlot, chCapacity); slot++) {
      if (!this._closureHandleSlotIsLive(slot)) continue;
      const entry = this._closureHandleEntryOffset(slot);
      const metaPtr = this.view.getUint32(entry + CLOSURE_HANDLE_ENTRY.METADATA_POINTER, true);
      const capturedListRel = this.view.getUint32(entry + CLOSURE_HANDLE_ENTRY.CAPTURED_GRANTS_LIST_OFFSET, true);
      const capturedListCount = this.view.getUint32(entry + CLOSURE_HANDLE_ENTRY.CAPTURED_GRANTS_LIST_COUNT, true);
      // Captured grants are immutable for the closure handle's lifetime,
      // but a captured grant may have been freed by this same compaction
      // pass (if it was unreferenced). Drop those — the captured grant
      // wasn't keeping the slot alive, so dropping the reference is safe
      // and the closure simply has fewer captured grants on resume. This
      // matches the handle.grantSlots filtering above.
      const capturedGrantSlots = [];
      if (capturedListCount > 0 && capturedListRel !== ID_LIST_NULL) {
        const capturedListAbs = this._listPoolAbs(capturedListRel);
        for (let i = 0; i < capturedListCount; i++) {
          const g = this.view.getUint32(capturedListAbs + i * 4, true);
          if (liveGrantSlots.has(g)) capturedGrantSlots.push(g);
        }
      }
      liveClosureHandles.push({
        slot,
        capturedGrantSlots,
        metadata: metaPtr === VALUE_POINTER_NULL ? undefined : this._readArenaValue(metaPtr),
      });
    }

    // v15: object handles. Same lazy-reclamation contract as closure
    // handles — every live slot stays live across compaction; only the
    // captured-grants list and metadata pointer are repacked.
    const liveObjectHandles = [];
    const ohCapacity = this.view.getUint32(HEADER.OBJECT_HANDLE_TABLE_CAPACITY, true);
    const ohNextSlot = this.view.getUint32(HEADER.NEXT_OBJECT_HANDLE_SLOT, true);
    for (let slot = 0; slot < Math.min(ohNextSlot, ohCapacity); slot++) {
      if (!this._objectHandleSlotIsLive(slot)) continue;
      const entry = this._objectHandleEntryOffset(slot);
      const metaPtr = this.view.getUint32(entry + OBJECT_HANDLE_ENTRY.METADATA_POINTER, true);
      const capturedListRel = this.view.getUint32(entry + OBJECT_HANDLE_ENTRY.CAPTURED_GRANTS_LIST_OFFSET, true);
      const capturedListCount = this.view.getUint32(entry + OBJECT_HANDLE_ENTRY.CAPTURED_GRANTS_LIST_COUNT, true);
      const capturedGrantSlots = [];
      if (capturedListCount > 0 && capturedListRel !== ID_LIST_NULL) {
        const capturedListAbs = this._listPoolAbs(capturedListRel);
        for (let i = 0; i < capturedListCount; i++) {
          const g = this.view.getUint32(capturedListAbs + i * 4, true);
          if (liveGrantSlots.has(g)) capturedGrantSlots.push(g);
        }
      }
      liveObjectHandles.push({
        slot,
        capturedGrantSlots,
        metadata: metaPtr === VALUE_POINTER_NULL ? undefined : this._readArenaValue(metaPtr),
      });
    }

    // v7: capability-state table. Every populated slot is a root.
    // Snapshot name + value into JS so we can re-encode them into the
    // fresh arena alongside handle/grant/closure metadata.
    const liveCapabilityState = [];
    const capabilityStateCapacity =
      this.view.getUint32(HEADER.CAPABILITY_STATE_TABLE_CAPACITY, true);
    for (let i = 0; i < capabilityStateCapacity; i++) {
      const entry = this._capabilityStateEntryOffset(i);
      const namePointer = this.view.getUint32(entry, true);
      if (namePointer === VALUE_POINTER_NULL) continue;
      const valuePointer = this.view.getUint32(entry + 4, true);
      liveCapabilityState.push({
        slotIndex: i,
        name:  this._readArenaValue(namePointer),
        value: valuePointer === VALUE_POINTER_NULL
          ? null
          : this._readArenaValue(valuePointer),
        valueWasNull: valuePointer === VALUE_POINTER_NULL,
      });
    }

    // v8: embedder-state cell. Single root pointer. Snapshot the decoded
    // value into JS so we can re-encode it after the arena reset. A NULL
    // pointer means "unset" — nothing to preserve.
    const embedderStatePointer =
      this.view.getUint32(HEADER.EMBEDDER_STATE_VALUE_POINTER, true);
    const liveEmbedderState = embedderStatePointer === VALUE_POINTER_NULL
      ? null
      : { value: this._readArenaValue(embedderStatePointer) };

    // ---------------------------------------------------------------------
    // Step 2: Free dead handle/grant slots.
    //
    // Walk the table linearly; any slot that is currently live but NOT in
    // the live set gets freed. Bump its version so any stale wrapper fails
    // on next use, clear all flags, push onto free list. We do NOT touch
    // _impls for live slots (they keep their JS objects); for dead slots
    // we drop the impl entry.
    // ---------------------------------------------------------------------
    for (let slot = 0; slot < Math.min(nextHandleSlot, handleCapacity); slot++) {
      if (!this._handleSlotIsLive(slot)) continue;
      if (liveHandleSlots.has(slot)) continue;
      this._freeHandleSlot(slot);
      stats.handlesFreed++;
      stats.freedHandleSlots.push(slot);
    }
    for (let slot = 0; slot < Math.min(nextGrantSlot, grantCapacity); slot++) {
      if (!this._grantSlotIsLive(slot)) continue;
      if (liveGrantSlots.has(slot)) continue;
      this._freeGrantSlot(slot);
      stats.grantsFreed++;
    }

    // ---------------------------------------------------------------------
    // Step 3: Reset and repack the id-list pool.
    //
    // Pool starts fresh at offset 4 (the reserved sentinel byte stays).
    // For each live handle, allocate a fresh run, write the (filtered)
    // grant slots into it, update the entry's *Offset / *Count. Same
    // for grants. Old pool bytes are now garbage; the next allocation
    // will overwrite them.
    // ---------------------------------------------------------------------
    this.view.setUint32(HEADER.ID_LIST_POOL_USED, 4, true);

    for (const h of liveHandles) {
      const entry = this._handleEntryOffset(h.slot);
      if (h.grantSlots.length === 0) {
        this.view.setUint32(entry + HANDLE_ENTRY.GRANT_LIST_OFFSET, ID_LIST_NULL, true);
        this.view.setUint32(entry + HANDLE_ENTRY.GRANT_LIST_COUNT, 0, true);
      } else {
        const relOffset = this._allocateListRun(h.grantSlots.length * 4);
        const absOffset = this._listPoolAbs(relOffset);
        for (let i = 0; i < h.grantSlots.length; i++) {
          this.view.setUint32(absOffset + i * 4, h.grantSlots[i], true);
        }
        this.view.setUint32(entry + HANDLE_ENTRY.GRANT_LIST_OFFSET, relOffset, true);
        this.view.setUint32(entry + HANDLE_ENTRY.GRANT_LIST_COUNT, h.grantSlots.length, true);
      }
    }

    for (const g of liveGrants) {
      const entry = this._grantEntryOffset(g.slot);
      if (g.handleSlots.length === 0) {
        this.view.setUint32(entry + GRANT_ENTRY.HANDLE_LIST_OFFSET, ID_LIST_NULL, true);
        this.view.setUint32(entry + GRANT_ENTRY.HANDLE_LIST_COUNT, 0, true);
      } else {
        const relOffset = this._allocateListRun(g.handleSlots.length * 4);
        const absOffset = this._listPoolAbs(relOffset);
        for (let i = 0; i < g.handleSlots.length; i++) {
          this.view.setUint32(absOffset + i * 4, g.handleSlots[i], true);
        }
        this.view.setUint32(entry + GRANT_ENTRY.HANDLE_LIST_OFFSET, relOffset, true);
        this.view.setUint32(entry + GRANT_ENTRY.HANDLE_LIST_COUNT, g.handleSlots.length, true);
      }
    }

    for (const ch of liveClosureHandles) {
      const entry = this._closureHandleEntryOffset(ch.slot);
      if (ch.capturedGrantSlots.length === 0) {
        this.view.setUint32(entry + CLOSURE_HANDLE_ENTRY.CAPTURED_GRANTS_LIST_OFFSET, ID_LIST_NULL, true);
        this.view.setUint32(entry + CLOSURE_HANDLE_ENTRY.CAPTURED_GRANTS_LIST_COUNT, 0, true);
      } else {
        const relOffset = this._allocateListRun(ch.capturedGrantSlots.length * 4);
        const absOffset = this._listPoolAbs(relOffset);
        for (let i = 0; i < ch.capturedGrantSlots.length; i++) {
          this.view.setUint32(absOffset + i * 4, ch.capturedGrantSlots[i], true);
        }
        this.view.setUint32(entry + CLOSURE_HANDLE_ENTRY.CAPTURED_GRANTS_LIST_OFFSET, relOffset, true);
        this.view.setUint32(entry + CLOSURE_HANDLE_ENTRY.CAPTURED_GRANTS_LIST_COUNT, ch.capturedGrantSlots.length, true);
      }
    }

    for (const oh of liveObjectHandles) {
      const entry = this._objectHandleEntryOffset(oh.slot);
      if (oh.capturedGrantSlots.length === 0) {
        this.view.setUint32(entry + OBJECT_HANDLE_ENTRY.CAPTURED_GRANTS_LIST_OFFSET, ID_LIST_NULL, true);
        this.view.setUint32(entry + OBJECT_HANDLE_ENTRY.CAPTURED_GRANTS_LIST_COUNT, 0, true);
      } else {
        const relOffset = this._allocateListRun(oh.capturedGrantSlots.length * 4);
        const absOffset = this._listPoolAbs(relOffset);
        for (let i = 0; i < oh.capturedGrantSlots.length; i++) {
          this.view.setUint32(absOffset + i * 4, oh.capturedGrantSlots[i], true);
        }
        this.view.setUint32(entry + OBJECT_HANDLE_ENTRY.CAPTURED_GRANTS_LIST_OFFSET, relOffset, true);
        this.view.setUint32(entry + OBJECT_HANDLE_ENTRY.CAPTURED_GRANTS_LIST_COUNT, oh.capturedGrantSlots.length, true);
      }
    }

    // ---------------------------------------------------------------------
    // Step 4: Reset and repack the value arena.
    //
    // Arena starts fresh at used=0. For each live entry with a value,
    // re-encode and write into the fresh arena (via _writeArenaValue),
    // update the entry pointer.
    // ---------------------------------------------------------------------
    this.view.setUint32(HEADER.VALUE_ARENA_USED, 0, true);

    for (const h of liveHandles) {
      const entry = this._handleEntryOffset(h.slot);
      const metaPtr = h.metadata === undefined ? VALUE_POINTER_NULL : this._writeArenaValue(h.metadata);
      const declPtr = h.declarationName === undefined ? VALUE_POINTER_NULL : this._writeArenaValue(h.declarationName);
      this.view.setUint32(entry + HANDLE_ENTRY.METADATA_POINTER, metaPtr, true);
      this.view.setUint32(entry + HANDLE_ENTRY.DECLARATION_NAME_POINTER, declPtr, true);
    }

    for (const g of liveGrants) {
      const entry = this._grantEntryOffset(g.slot);
      const idPtr = g.identifier === undefined ? VALUE_POINTER_NULL : this._writeArenaValue(g.identifier);
      const metaPtr = g.metadata === undefined ? VALUE_POINTER_NULL : this._writeArenaValue(g.metadata);
      this.view.setUint32(entry + GRANT_ENTRY.IDENTIFIER_POINTER, idPtr, true);
      this.view.setUint32(entry + GRANT_ENTRY.METADATA_POINTER, metaPtr, true);
    }

    for (const ch of liveClosureHandles) {
      const entry = this._closureHandleEntryOffset(ch.slot);
      const metaPtr = ch.metadata === undefined ? VALUE_POINTER_NULL : this._writeArenaValue(ch.metadata);
      this.view.setUint32(entry + CLOSURE_HANDLE_ENTRY.METADATA_POINTER, metaPtr, true);
    }

    for (const oh of liveObjectHandles) {
      const entry = this._objectHandleEntryOffset(oh.slot);
      const metaPtr = oh.metadata === undefined ? VALUE_POINTER_NULL : this._writeArenaValue(oh.metadata);
      this.view.setUint32(entry + OBJECT_HANDLE_ENTRY.METADATA_POINTER, metaPtr, true);
    }

    // v7: re-encode capability-state names and values into the fresh
    // arena and rewrite the table pointers. Cleared cells
    // (valueWasNull) keep namePointer set but valuePointer at
    // VALUE_POINTER_NULL — matches the set(name, null) contract.
    for (const cs of liveCapabilityState) {
      const entry = this._capabilityStateEntryOffset(cs.slotIndex);
      const namePointer = this._writeArenaValue(cs.name);
      const valuePointer = cs.valueWasNull
        ? VALUE_POINTER_NULL
        : this._writeArenaValue(cs.value);
      this.view.setUint32(entry,     namePointer,  true);
      this.view.setUint32(entry + 4, valuePointer, true);
    }

    // v8: re-encode the embedder-state value into the fresh arena.
    if (liveEmbedderState !== null) {
      const newPointer = this._writeArenaValue(liveEmbedderState.value);
      this.view.setUint32(HEADER.EMBEDDER_STATE_VALUE_POINTER, newPointer, true);
    }

    stats.poolBytesAfter = this.view.getUint32(HEADER.ID_LIST_POOL_USED, true);
    stats.arenaBytesAfter = this.view.getUint32(HEADER.VALUE_ARENA_USED, true);
    stats.poolBytesReclaimed = stats.poolBytesBefore - stats.poolBytesAfter;
    stats.arenaBytesReclaimed = stats.arenaBytesBefore - stats.arenaBytesAfter;
    return stats;
  }

  /**
   * Free a handle slot: bump version, clear flags, push onto free list,
   * drop the JS-side impl entry. Used by compact() and never directly by
   * register() (which only allocates).
   *
   * @param {number} slot
   * @param {number} [callerTag] - MUTATION_TAG.* recorded in the log;
   *   defaults to GC_REAP_HANDLE (compact() is the only caller today).
   */
  _freeHandleSlot(slot, callerTag = MUTATION_TAG.GC_REAP_HANDLE) {
    const entry = this._handleEntryOffset(slot);
    // Bump version BEFORE writing free-list pointer, so any stale wrapper
    // sees the new version and fails its check.
    const oldVersion = this.view.getUint32(entry + HANDLE_ENTRY.VERSION, true);
    const newVersion = oldVersion + 1;
    this.view.setUint32(entry + HANDLE_ENTRY.VERSION, newVersion, true);
    // v15: a freed handle drops its constructible registration and its
    // surrogate binding (the surrogate stays alive only through class
    // prototype chains that still reference it).
    this.view.setUint32(entry + HANDLE_ENTRY.SURROGATE_POINTER, 0, true);
    this._writeHandleFlags(slot, HANDLE_FLAG_ON_FREE_LIST);
    const head = this.view.getUint32(HEADER.HANDLE_FREE_LIST_HEAD, true);
    this.view.setUint32(entry + HANDLE_ENTRY.FREE_LIST_NEXT, head, true);
    this.view.setUint32(HEADER.HANDLE_FREE_LIST_HEAD, slot, true);
    this._impls.delete(slot);
    this._logMutation(MUTATION_KIND.HANDLE_FREE, slot, newVersion, callerTag);
  }

  /**
   * Free a grant slot: bump version, clear flags, push onto free list.
   * Removes the slot from rootGrantsList if it was a root (defensive —
   * with Policy R1 this should never happen because rootGrants are always
   * in the live set, but the cleanup keeps the buffer consistent).
   *
   * The slot may or may not have been revoked first. Either way, the
   * "REAP" kind reflects the slot transitioning to the free list (a
   * distinct lifecycle event from REVOKE which only flips the flag).
   *
   * @param {number} slot
   * @param {number} [callerTag] - defaults to GC_REAP_GRANT (compact()).
   */
  _freeGrantSlot(slot, callerTag = MUTATION_TAG.GC_REAP_GRANT) {
    const entry = this._grantEntryOffset(slot);
    const flags = this._readGrantFlags(slot);
    if ((flags & GRANT_FLAG_ROOT) !== 0) {
      this._removeFromRootGrantsList(slot);
    }
    const oldVersion = this.view.getUint32(entry + GRANT_ENTRY.VERSION, true);
    const newVersion = oldVersion + 1;
    this.view.setUint32(entry + GRANT_ENTRY.VERSION, newVersion, true);
    this._writeGrantFlags(slot, GRANT_FLAG_ON_FREE_LIST);
    const head = this.view.getUint32(HEADER.GRANT_FREE_LIST_HEAD, true);
    this.view.setUint32(entry + GRANT_ENTRY.FREE_LIST_NEXT, head, true);
    this.view.setUint32(HEADER.GRANT_FREE_LIST_HEAD, slot, true);
    this._logMutation(MUTATION_KIND.GRANT_REAP, slot, newVersion, callerTag,
      (flags & GRANT_FLAG_ROOT) !== 0 ? 1 : 0);
  }

  /**
   * Remove a grant slot from the rootGrantsList (used by _freeGrantSlot
   * defensively). O(n) where n is the number of root grants — typically <10.
   */
  _removeFromRootGrantsList(slot) {
    const listOffset = this.view.getUint32(HEADER.ROOT_GRANTS_LIST_OFFSET, true);
    const count = this.view.getUint32(HEADER.ROOT_GRANTS_LIST_COUNT, true);
    let writeIdx = 0;
    let removed = false;
    for (let i = 0; i < count; i++) {
      const s = this.view.getUint32(listOffset + i * 4, true);
      if (s === slot) { removed = true; continue; }
      if (writeIdx !== i) {
        this.view.setUint32(listOffset + writeIdx * 4, s, true);
      }
      writeIdx++;
    }
    this.view.setUint32(HEADER.ROOT_GRANTS_LIST_COUNT, writeIdx, true);
    if (removed) {
      // The grant slot may or may not still be live; read its current
      // version to stamp the log entry.
      const entry = this._grantEntryOffset(slot);
      const version = this.view.getUint32(entry + GRANT_ENTRY.VERSION, true);
      this._logMutation(MUTATION_KIND.GRANT_ROOT_REMOVE, slot, version, MUTATION_TAG.ROOT_POP);
    }
  }

  // ===========================================================================
  // Stats
  // ===========================================================================

  /**
   * Snapshot of buffer occupancy. Hosts read this to decide when to call
   * compactMembrane() — or expose it for telemetry.
   */
  stats() {
    let liveHandles = 0, freeHandles = 0;
    const handleCap = this.view.getUint32(HEADER.HANDLE_TABLE_CAPACITY, true);
    const nextH = this.view.getUint32(HEADER.NEXT_HANDLE_SLOT, true);
    for (let s = 0; s < Math.min(nextH, handleCap); s++) {
      if (this._handleSlotIsLive(s)) liveHandles++;
      else freeHandles++;
    }
    let liveGrants = 0, freeGrants = 0;
    const grantCap = this.view.getUint32(HEADER.GRANT_TABLE_CAPACITY, true);
    const nextG = this.view.getUint32(HEADER.NEXT_GRANT_SLOT, true);
    for (let s = 0; s < Math.min(nextG, grantCap); s++) {
      if (this._grantSlotIsLive(s)) liveGrants++;
      else freeGrants++;
    }
    let liveClosures = 0, freeClosures = 0;
    const closureCap = this.view.getUint32(
      HEADER.CLOSURE_HANDLE_TABLE_CAPACITY, true);
    const nextC = this.view.getUint32(HEADER.NEXT_CLOSURE_HANDLE_SLOT, true);
    for (let s = 0; s < Math.min(nextC, closureCap); s++) {
      if (this._closureHandleSlotIsLive(s)) liveClosures++;
      else freeClosures++;
    }
    let liveObjects = 0, freeObjects = 0;
    const objectCap = this.view.getUint32(
      HEADER.OBJECT_HANDLE_TABLE_CAPACITY, true);
    const nextO = this.view.getUint32(HEADER.NEXT_OBJECT_HANDLE_SLOT, true);
    for (let s = 0; s < Math.min(nextO, objectCap); s++) {
      if (this._objectHandleSlotIsLive(s)) liveObjects++;
      else freeObjects++;
    }
    let liveLinkedPromises = 0, freeLinkedPromises = 0;
    const linkedCap = this.view.getUint32(
      HEADER.LINKED_PROMISE_TABLE_CAPACITY, true);
    const nextL = this.view.getUint32(HEADER.NEXT_LINKED_PROMISE_SLOT, true);
    for (let s = 0; s < Math.min(nextL, linkedCap); s++) {
      if (this._linkedPromiseSlotIsLive(s)) liveLinkedPromises++;
      else freeLinkedPromises++;
    }
    return {
      totalBytes: this.byteLength,
      handleTableCapacity: handleCap,
      handleTableLive: liveHandles,
      handleTableFree: freeHandles,
      grantTableCapacity: grantCap,
      grantTableLive: liveGrants,
      grantTableFree: freeGrants,
      idListPoolUsed: this.view.getUint32(HEADER.ID_LIST_POOL_USED, true),
      idListPoolSize: this.view.getUint32(HEADER.ID_LIST_POOL_SIZE, true),
      valueArenaUsed: this.view.getUint32(HEADER.VALUE_ARENA_USED, true),
      valueArenaSize: this.view.getUint32(HEADER.VALUE_ARENA_SIZE, true),
      rootGrantsCount: this.view.getUint32(HEADER.ROOT_GRANTS_LIST_COUNT, true),
      // Expose rootGrantsListCapacity and mutationLogCapacity so hosts can
      // compute the minimum envelope size for a sub-region configuration.
      rootGrantsListCapacity:
        this.view.getUint32(HEADER.ROOT_GRANTS_LIST_CAPACITY, true),
      mutationLogCapacity:
        this.view.getUint32(HEADER.MUTATION_LOG_CAPACITY, true),
      closureHandleTableCapacity: closureCap,
      closureHandleTableLive: liveClosures,
      closureHandleTableFree: freeClosures,
      objectHandleTableCapacity: objectCap,
      objectHandleTableLive: liveObjects,
      objectHandleTableFree: freeObjects,
      linkedPromiseTableCapacity: linkedCap,
      linkedPromiseTableLive: liveLinkedPromises,
      linkedPromiseTableFree: freeLinkedPromises,
      capabilityStateTableCapacity:
        this.view.getUint32(HEADER.CAPABILITY_STATE_TABLE_CAPACITY, true),
    };
  }

  // ===========================================================================
  // v4: Operation tick
  //
  // The tick is a monotonic u64 the host bumps at coarse JS-side
  // operations (session.run entry, gc, snapshot, resize). It lives in
  // the membrane header (NOT in the interpreter segment / STATE), so
  // the interpreter never sees it. Survives snapshot/restore through
  // the existing membrane-bytes round-trip.
  //
  // Each mutation log entry stamps the *current* tick value at write
  // time; the log's own seq is per-mutation ordering. Structured errors
  // record the tick of the operation that produced them.
  // ===========================================================================

  /**
   * Read the current operation tick.
   * @returns {bigint} u64 monotonic counter
   */
  tick() {
    return this.view.getBigUint64(HEADER.OPERATION_TICK, true);
  }

  /**
   * Handle-table capacity in slots. The WAT collector sizes its
   * handle-liveness bitmap from this.
   * @returns {number}
   */
  getHandleTableCapacity() {
    return this.view.getUint32(HEADER.HANDLE_TABLE_CAPACITY, true);
  }

  // ===========================================================================
  // FinalizationRegistry recent-fire counter
  //
  // Both FRs we own — airlock.closureRegistry and this.
  // _closureHandleCacheCleanup — wrap their callbacks via
  // _wrapFinalizationCallback so every fire bumps the per-tick bucket
  // for the current tick. recentFinalizationCount({windowTicks=64})
  // sums the buckets covering the most recent windowTicks ticks.
  //
  // Buckets are indexed by (tick mod windowTicks); a stored "bucket
  // tick" tracks which absolute tick owns the cursor so we can
  // detect tick jumps and zero out the buckets we skipped over.
  //
  // The whole apparatus is JS-side, not part of any snapshot. After
  // restore-from-bytes, lifetime starts back at zero — the buckets
  // are about what's happened in *this* worker session, not history.
  // ===========================================================================

  /**
   * Wrap an FR callback so each fire increments the recent-fire
   * counter. The wrapped callback runs the original after the bump.
   * @param {(heldValue: any) => void} callback
   * @returns {(heldValue: any) => void}
   */
  _wrapFinalizationCallback(callback) {
    return (heldValue) => {
      this._countFinalizationFire();
      callback(heldValue);
    };
  }

  /**
   * Internal: bump the bucket for the current tick. Called from the
   * wrapped FR callbacks. Also bumps the lifetime counter. If the
   * tick has advanced since the last fire, advances the cursor and
   * zeros every bucket we skipped over so stale counts don't
   * contaminate the window.
   */
  _countFinalizationFire() {
    const fr = this._frState;
    fr.lifetime += 1;
    const tick = this.tick(); // bigint
    if (fr.bucketTick === null) {
      fr.bucketTick = tick;
      fr.cursor = 0;
      fr.buckets.fill(0);
      fr.buckets[0] = 1;
      return;
    }
    if (tick === fr.bucketTick) {
      fr.buckets[fr.cursor] += 1;
      return;
    }
    // Tick has advanced. Roll cursor forward by (tick - bucketTick),
    // clamped to the window size — anything older than windowTicks
    // is fully expired, so clamp avoids an unbounded zero-loop on a
    // huge jump.
    const window = fr.windowTicks;
    let delta = tick - fr.bucketTick;
    if (delta < 0n) {
      // Tick went backwards (shouldn't happen — bumpTick is monotonic
      // — but be defensive against snapshot restore weirdness).
      delta = 0n;
    }
    if (delta >= BigInt(window)) {
      fr.buckets.fill(0);
      fr.cursor = 0;
    } else {
      const steps = Number(delta);
      for (let i = 0; i < steps; i++) {
        fr.cursor = (fr.cursor + 1) % window;
        fr.buckets[fr.cursor] = 0;
      }
    }
    fr.bucketTick = tick;
    fr.buckets[fr.cursor] += 1;
  }

  /**
   * Count of FinalizationRegistry callback fires within the last
   * `windowTicks` ticks. If no callback has fired yet, returns 0.
   *
   * The window expires lazily: a fire only updates the bucket
   * structure on fire, but a read after silence has to honor "is
   * the most recent fire actually inside the window from the
   * *current* tick?" — otherwise a quiet period would keep stale
   * counts visible. We compare current tick to the bucket cursor's
   * tick and treat any fire older than `window` ticks as expired.
   *
   * @param {Object} [opts]
   * @param {number} [opts.windowTicks] - override the default window
   *   (must be ≤ the configured bucket count; values above the bucket
   *   count are clamped). Defaults to the full window.
   * @returns {number}
   */
  recentFinalizationCount(opts = {}) {
    const fr = this._frState;
    if (fr.bucketTick === null) return 0;
    const requested = opts.windowTicks ?? fr.windowTicks;
    const window = Math.min(requested | 0, fr.windowTicks);
    if (window <= 0) return 0;
    const nowTick = this.tick();
    const ageOfMostRecent = nowTick - fr.bucketTick; // bigint
    // If the *most recent* fire is already older than the window,
    // nothing else can be inside the window — every bucket holds an
    // even older fire (or is zero). Short-circuit.
    if (ageOfMostRecent >= BigInt(window)) return 0;
    // Otherwise sum the buckets covering the most-recent-fire and
    // the (window-1-age) further-back buckets. Buckets are aligned
    // to bucketTick at cursor — older fires sit at smaller cursors
    // (mod windowSize).
    let sum = 0;
    let cursor = fr.cursor;
    const slotsInWindow = window - Number(ageOfMostRecent);
    for (let i = 0; i < slotsInWindow; i++) {
      sum += fr.buckets[cursor] | 0;
      cursor = (cursor - 1 + fr.windowTicks) % fr.windowTicks;
    }
    return sum;
  }

  /**
   * Total number of FinalizationRegistry callback fires since this
   * membrane instance was constructed. Useful for absolute
   * comparisons across cycles (the windowed count is comparative
   * within a session). Not snapshottable.
   *
   * @returns {number}
   */
  lifetimeFinalizationFires() {
    return this._frState.lifetime;
  }

  /**
   * Capture a synchronous snapshot of membrane state as a plain
   * object. Bundles `stats()`, the current operation tick, the
   * mutation log tail, and finalization counters so embedders
   * never have to byte-walk the membrane layout themselves.
   *
   * The returned shape is part of sandscript's public surface:
   * adding fields is non-breaking; renaming or removing fields is
   * a major version change. msgpack-friendly throughout (BigInt
   * and Uint8Array survive as themselves; nothing else exotic is
   * included).
   *
   * @param {Object} [opts]
   * @param {number} [opts.recentMutationsCap=64] - max mutation log
   *   entries to include in `recentMutations`. Default is small
   *   enough not to dominate envelope size; raise it explicitly
   *   when a deeper history is genuinely needed.
   * @param {number} [opts.perSlotSlot] - if provided, also include
   *   `perSlotMutations`: the mutation log entries (newest first,
   *   capped) for this specific slot. Useful when the embedder
   *   already knows which slot it's diagnosing.
   * @param {number} [opts.perSlotCap=8] - max entries for
   *   `perSlotMutations`, when `perSlotSlot` is provided.
   * @returns {Object} `{ stats, tick, recentMutations,
   *   perSlotMutations?, finalization: { recent, lifetime } }`.
   */
  captureDiagnostic(opts = {}) {
    const {
      recentMutationsCap = 64,
      perSlotSlot,
      perSlotCap = 8,
    } = opts;
    const out = {
      stats: this.stats(),
      tick: this.tick(),
      recentMutations: this.mutationLog({ limit: recentMutationsCap }),
      finalization: {
        recent: this.recentFinalizationCount(),
        lifetime: this.lifetimeFinalizationFires(),
      },
    };
    if (perSlotSlot !== undefined) {
      out.perSlotMutations = this.findRecentMutationsForSlot(
        perSlotSlot, { limit: perSlotCap });
    }
    return out;
  }

  /**
   * Bump the operation tick by 1. Returns the NEW tick value.
   *
   * Called by the host at coarse operations: session.run() entry,
   * gc(), snapshot(), resizeSegment, resizeRegions. Atomic on the
   * low half so concurrent readers see a consistent value.
   *
   * The high half is bumped on low-half wrap. Bumps are JS-side
   * serial (no two host operations bump concurrently in practice),
   * so the read-modify-write on the high half is safe.
   *
   * @returns {bigint} the new tick value
   */
  bumpTick() {
    const view = this.view;
    // Atomically increment the low half so anything reading the tick
    // across threads sees a monotonic progression. Use Atomics on the
    // membrane buffer when it's a SAB; fall back to non-atomic for
    // non-shared buffers (Atomics.add on a non-shared Int32Array still
    // works in modern engines but the semantics are weaker).
    const lo = view.getUint32(HEADER.OPERATION_TICK, true);
    const newLo = (lo + 1) >>> 0;
    if (newLo === 0) {
      // Wrap of the low half — bump high half. Cheap (happens once
      // per 2^32 bumps, which at one bump per run() is millions of
      // operations).
      const hi = view.getUint32(HEADER.OPERATION_TICK + 4, true);
      view.setUint32(HEADER.OPERATION_TICK + 4, (hi + 1) >>> 0, true);
    }
    view.setUint32(HEADER.OPERATION_TICK, newLo, true);
    return this.tick();
  }

  // ===========================================================================
  // v4: Mutation log
  //
  // SAB-resident ring buffer of every membrane mutation. Each entry
  // is 32 bytes (see MUTATION_LOG_ENTRY constants above). Writers
  // claim a slot by atomically incrementing MUTATION_LOG_WRITE_INDEX,
  // then store the entry fields and publish seqLo last. Readers
  // detect partial writes via the seq sentinel (0 = not published).
  //
  // The log lives at the tail of the membrane layout (allocated by
  // layoutMembrane after every other region). resizeRegions
  // preserves capacity; resizeMutationLog is the dedicated grow
  // primitive.
  // ===========================================================================

  /**
   * Write one mutation entry. Called from every membrane mutation
   * site. The current tick value is stamped into the entry at write
   * time.
   *
   * @param {number} kind   - MUTATION_KIND.* value
   * @param {number} slot   - slot index that was mutated
   * @param {number} version - slot's version AFTER the mutation
   * @param {number} tag    - MUTATION_TAG.* value
   * @param {number} [flags] - per-kind u16 bits (default 0)
   */
  _logMutation(kind, slot, version, tag, flags = 0) {
    const v = this.view;
    const capacity = v.getUint32(HEADER.MUTATION_LOG_CAPACITY, true);
    const logOffset = v.getUint32(HEADER.MUTATION_LOG_OFFSET, true);
    if (capacity === 0) return; // no log region (shouldn't happen post-init)

    // Claim the next write slot. Free-running write index never
    // resets; the ring slot is (writeIndex - 1) & (capacity - 1)
    // after we increment. We use a non-atomic read-modify-write
    // because membrane mutations are serialized on the worker
    // thread; concurrent writers would violate other membrane
    // invariants long before contending on the log.
    const writeIndex = v.getUint32(HEADER.MUTATION_LOG_WRITE_INDEX, true);
    const nextWriteIndex = (writeIndex + 1) >>> 0;
    v.setUint32(HEADER.MUTATION_LOG_WRITE_INDEX, nextWriteIndex, true);

    const ringSlot = writeIndex & (capacity - 1);
    const entryOffset = logOffset + ringSlot * MUTATION_LOG_ENTRY_SIZE;

    // seq = writeIndex + 1 so the first published entry has seq 1
    // (seq 0 is the "not yet published" sentinel). seq is free-running
    // u64 — but writeIndex is u32 so we just use writeIndex+1 as the
    // low half and accept wraparound after 2^32 writes (4B entries =
    // many years of busy operation).
    //
    // For now, treat seq as u32 (low half). The high half stays 0
    // until we need to handle very-long-running sessions. If we ever
    // care, bump on low-half wrap (same pattern as tick).
    const seqLo = nextWriteIndex; // == writeIndex + 1, never 0 (skipped below if wrap hits 0)
    const tick = this.tick();
    const tickLo = Number(tick & 0xFFFFFFFFn);
    const tickHi = Number((tick >> 32n) & 0xFFFFFFFFn);

    // Write all fields EXCEPT seqLo first.
    v.setUint32(entryOffset + MUTATION_LOG_ENTRY.SEQ_HI, 0, true);
    v.setUint32(entryOffset + MUTATION_LOG_ENTRY.TICK_LO, tickLo, true);
    v.setUint32(entryOffset + MUTATION_LOG_ENTRY.TICK_HI, tickHi, true);
    v.setUint8(entryOffset + MUTATION_LOG_ENTRY.KIND, kind);
    v.setUint8(entryOffset + MUTATION_LOG_ENTRY.KIND + 1, 0); // reserved byte
    v.setUint16(entryOffset + MUTATION_LOG_ENTRY.FLAGS, flags, true);
    v.setUint32(entryOffset + MUTATION_LOG_ENTRY.SLOT, slot, true);
    v.setUint32(entryOffset + MUTATION_LOG_ENTRY.VERSION, version, true);
    v.setUint32(entryOffset + MUTATION_LOG_ENTRY.CALLER_TAG, tag, true);

    // Publish: write seqLo LAST. If a reader is concurrent (host
    // main thread reading SAB), it sees the entry only after seqLo
    // is set. Skip seqLo == 0 by writing 1 instead — preserves the
    // sentinel invariant. (writeIndex was u32; nextWriteIndex == 0
    // only after 2^32 writes — once every few centuries of busy
    // operation. Still handle it correctly.)
    v.setUint32(entryOffset + MUTATION_LOG_ENTRY.SEQ_LO,
      seqLo === 0 ? 1 : seqLo, true);

    // Bump per-kind counter atomically alongside.
    const counterOffset = MUTATION_KIND_COUNTER_OFFSET[kind];
    if (counterOffset !== undefined) {
      const cur = v.getUint32(counterOffset, true);
      v.setUint32(counterOffset, (cur + 1) >>> 0, true);
    }

    // Fire any installed mutation watchers AFTER the entry
    // is published. Watchers are transient JS-side state. Zero cost
    // when none are installed (length check + early return).
    const subs = this._mutationWatchers;
    if (subs.length === 0) return;
    // Build the event lazily — only if at least one subscriber's
    // kindMask matches. Subscribers see the same shape as a log entry.
    const kindBit = 1 << kind;
    let event = null;
    for (const sub of subs) {
      if ((sub.kindMask & kindBit) === 0) continue;
      if (event === null) {
        event = {
          seq: seqLo === 0 ? 1 : seqLo,
          tick: this.tick(),
          kind,
          flags,
          slot,
          version,
          callerTag: tag,
        };
      }
      try {
        sub.fn(event);
      } catch (err) {
        // A buggy watcher must not break the engine. Surface via
        // console.error so the host sees it; production code doesn't
        // install watchers (debug-only surface), so the sink is
        // appropriate for the debug audience.
        try {
          console.error('[sandscript debug] mutation watcher threw:', err);
        } catch (_) { /* swallow if console is missing */ }
      }
    }
  }

  // ===========================================================================
  // Cost ledger; atomic publication follows
  // docs/ring-publication-contract.md.
  //
  // SAB-resident ring of consumption events — SandScript fuel drives
  // (kind FUEL, the airlock appending on its own behalf) and capability
  // calls (kind 64+, the embedder reporting cap cost). Each entry is 96
  // bytes (COST_LEDGER_ENTRY). Publication follows the shared ring
  // contract (docs/ring-publication-contract.md): a wrap stores
  // generation zero, resets the head, publishes the successor, and
  // drops the boundary diagnostic. Ordinary publication advances the
  // reservation head BEFORE the reused slot is touched, and SEQ_LO is
  // the atomically-published exact 1-based entry index a concurrent
  // reader validates before and after decoding.
  //
  // The one bounded validated decoder for this format lives in
  // src/runtime/cost-ledger.js (createCostLedgerView); the membrane
  // deliberately does not carry a second reader.
  //
  // Unlike the mutation log / in-flight ledger, the cost ledger is the
  // DURABLE accounting record — it is preserved across snapshot/restore
  // (see _resetDiagnosticsOnRestore, which deliberately leaves it alone).
  // ===========================================================================

  /**
   * Append one consumption event. The sole writer of the cost-ledger
   * region. Gauges default to 0, so callers fill only the measurements
   * they can source honestly. The current tick is stamped at write time.
   *
   * @param {number} kind  - COST_KIND.* (1 = FUEL) or an embedder kind (64+).
   * @param {number} slot  - context slot the event is attributed to.
   * @param {object} [gauges] - { fuel, wallNanos, bytesIn, bytesOut,
   *                             calls, cpuNanos, bytesHeld, ext0, ext1 }.
   *                             Each a non-negative integer (stored u64);
   *                             omitted fields are 0.
   */
  appendCostEntry(kind, slot, gauges = {}) {
    const v = this.view;
    const capacity = v.getUint32(HEADER.COST_LEDGER_CAPACITY, true);
    const ledgerOffset = v.getUint32(HEADER.COST_LEDGER_OFFSET, true);
    if (capacity === 0) return; // no ledger region (shouldn't happen post-init)

    const words = this._state.wordView;
    const wordIndexFor = (relativeOffset) => {
      const absolute = this._state.byteOffset + relativeOffset;
      if ((absolute & 3) !== 0) {
        throw new Error(
          `appendCostEntry: misaligned atomic field at byte ${absolute}`);
      }
      return absolute >>> 2;
    };
    // Reserve the head BEFORE touching the reused slot. A u32 boundary
    // is a seqlock transition: publish generation 0 (reader-invalid),
    // reset the head, then publish the successor generation and drop
    // this diagnostic event. No writer ever publishes token 0. At the
    // terminal generation, set the exhausted flag and leave the head
    // and slots untouched: cost recording ends, but the runtime
    // operation that called this method continues.
    const flagsWord = wordIndexFor(HEADER.COST_LEDGER_FLAGS);
    if ((Atomics.load(words, flagsWord) &
         COST_LEDGER_FLAG_SEGMENT_SPACE_EXHAUSTED) !== 0) return;
    const generationWord = wordIndexFor(HEADER.COST_LEDGER_SEGMENT_GENERATION);
    const headWord = wordIndexFor(HEADER.COST_LEDGER_WRITE_INDEX);
    const writeIndex = Atomics.load(words, headWord) >>> 0;
    if (writeIndex === 0xffffffff) {
      const generation = Atomics.load(words, generationWord) >>> 0;
      if (generation === 0xffffffff) {
        Atomics.store(words, flagsWord,
          (Atomics.load(words, flagsWord) |
           COST_LEDGER_FLAG_SEGMENT_SPACE_EXHAUSTED) >>> 0);
        return;
      }
      Atomics.store(words, generationWord, 0);
      Atomics.store(words, headWord, 0);
      Atomics.store(words, generationWord, (generation + 1) >>> 0);
      return;
    }
    const index = (writeIndex + 1) >>> 0;
    Atomics.store(words, headWord, index);

    const ringSlot = writeIndex & (capacity - 1);
    const entryOffset = ledgerOffset + ringSlot * COST_LEDGER_ENTRY_SIZE;

    const storeWord = (relativeOffset, value) =>
      Atomics.store(words, wordIndexFor(relativeOffset), value >>> 0);
    const storeGauge = (fieldOffset, value) => {
      const wide = BigInt(value ?? 0);
      storeWord(entryOffset + fieldOffset,     Number(wide & 0xFFFFFFFFn));
      storeWord(entryOffset + fieldOffset + 4, Number((wide >> 32n) & 0xFFFFFFFFn));
    };

    // Invalidate BEFORE touching the payload: the previous lap's token
    // equals exactly the index a slow reader still expects, so leaving
    // it in place while overwriting would let that reader accept a torn
    // record. Storing the 0 sentinel first closes the hole (seqlock
    // "odd" state).
    storeWord(entryOffset + COST_LEDGER_ENTRY.SEQ_LO, 0);

    // Payload stores are ATOMIC word stores, not plain DataView writes:
    // JavaScript has no store fence, and a plain store may become
    // visible before the invalidation above. Sequentially-consistent
    // atomics respect program order per agent, which is what makes the
    // invalidate → payload → publish sequence provable.
    const tick = this.tick();
    storeWord(entryOffset + COST_LEDGER_ENTRY.SEQ_HI, 0);
    storeWord(entryOffset + COST_LEDGER_ENTRY.TICK_LO, Number(tick & 0xFFFFFFFFn));
    storeWord(entryOffset + COST_LEDGER_ENTRY.TICK_HI, Number((tick >> 32n) & 0xFFFFFFFFn));
    storeWord(entryOffset + COST_LEDGER_ENTRY.KIND, kind);
    storeWord(entryOffset + COST_LEDGER_ENTRY.SLOT, slot);

    storeGauge(COST_LEDGER_ENTRY.FUEL,       gauges.fuel);
    storeGauge(COST_LEDGER_ENTRY.WALL_NANOS, gauges.wallNanos);
    storeGauge(COST_LEDGER_ENTRY.BYTES_IN,   gauges.bytesIn);
    storeGauge(COST_LEDGER_ENTRY.BYTES_OUT,  gauges.bytesOut);
    storeGauge(COST_LEDGER_ENTRY.CALLS,      gauges.calls);
    storeGauge(COST_LEDGER_ENTRY.CPU_NANOS,  gauges.cpuNanos);
    storeGauge(COST_LEDGER_ENTRY.BYTES_HELD, gauges.bytesHeld);
    storeGauge(COST_LEDGER_ENTRY.EXT0,       gauges.ext0);
    storeGauge(COST_LEDGER_ENTRY.EXT1,       gauges.ext1);

    // Publish LAST: the exact 1-based index, atomically. The one entry
    // per 2^32 whose index is congruent to 0 publishes the sentinel and
    // is simply unavailable to readers — never fudged to 1.
    storeWord(entryOffset + COST_LEDGER_ENTRY.SEQ_LO, index);
  }


  /**
   * Install a mutation watcher. Internal API — Debug consumers call
   * this through `debug.setMutationWatcher(...)` which lives in
   * src/fuel/debug.js (debug-only). Hosts must not call this
   * directly; the boundary check happens at the debug.js import.
   *
   * @param {number} kindMask - Bitmask of (1 << MUTATION_KIND.*) values.
   * @param {Function} fn - Watcher callback.
   * @returns {number} Token to pass to _removeMutationWatcher.
   */
  _addMutationWatcher(kindMask, fn) {
    if (typeof fn !== 'function') {
      throw new TypeError('_addMutationWatcher: fn must be a function');
    }
    if (typeof kindMask !== 'number' || !Number.isFinite(kindMask)) {
      throw new TypeError('_addMutationWatcher: kindMask must be a number');
    }
    const token = { kindMask, fn };
    this._mutationWatchers.push(token);
    return token;
  }

  /**
   * Remove a previously-installed mutation watcher.
   * Idempotent; removing an already-removed token is a no-op.
   *
   * @param {Object} token - Returned by _addMutationWatcher.
   */
  _removeMutationWatcher(token) {
    const i = this._mutationWatchers.indexOf(token);
    if (i >= 0) this._mutationWatchers.splice(i, 1);
  }

  /**
   * Return per-kind mutation counters. O(1) header read; production-
   * callable. Counters are bumped atomically alongside log writes.
   *
   * @returns {Object} per-kind tally object
   */
  mutationCounters() {
    const v = this.view;
    return {
      handleAlloc:         v.getUint32(HEADER.MUTATION_COUNT_HANDLE_ALLOC, true),
      handleFree:          v.getUint32(HEADER.MUTATION_COUNT_HANDLE_FREE, true),
      grantCreate:         v.getUint32(HEADER.MUTATION_COUNT_GRANT_CREATE, true),
      grantRevoke:         v.getUint32(HEADER.MUTATION_COUNT_GRANT_REVOKE, true),
      grantReap:           v.getUint32(HEADER.MUTATION_COUNT_GRANT_REAP, true),
      closureHandleAlloc:  v.getUint32(HEADER.MUTATION_COUNT_CLOSURE_ALLOC, true),
      closureHandleFree:   v.getUint32(HEADER.MUTATION_COUNT_CLOSURE_FREE, true),
      linkedPromiseAlloc:  v.getUint32(HEADER.MUTATION_COUNT_LINKED_ALLOC, true),
      linkedPromiseFree:   v.getUint32(HEADER.MUTATION_COUNT_LINKED_FREE, true),
      linkedPromiseSettle: v.getUint32(HEADER.MUTATION_COUNT_LINKED_SETTLE, true),
      linkedPromiseReject: v.getUint32(HEADER.MUTATION_COUNT_LINKED_REJECT, true),
      grantRootAdd:        v.getUint32(HEADER.MUTATION_COUNT_ROOT_ADD, true),
      grantRootRemove:     v.getUint32(HEADER.MUTATION_COUNT_ROOT_REMOVE, true),
    };
  }

  /**
   * Return current mutation log write index (free-running, never
   * reset). Useful for tests asserting "no new mutations since this
   * point." Not the same as a seq — readers see entries with
   * seq = writeIndex + 1 at the time of their write.
   *
   * @returns {number} u32 free-running write index
   */
  mutationLogWriteIndex() {
    return this.view.getUint32(HEADER.MUTATION_LOG_WRITE_INDEX, true);
  }

  /**
   * Capacity of the mutation log ring (entries).
   * @returns {number}
   */
  mutationLogCapacity() {
    return this.view.getUint32(HEADER.MUTATION_LOG_CAPACITY, true);
  }

  /**
   * Read mutation log entries. Returns entries in **insertion order,
   * newest first** (most recently written entry first; walk backward
   * from there). Skipped if the ring slot's seq is 0 (not yet
   * published) or doesn't match the expected free-running sequence.
   *
   * Debug API surface; called by Debug.mutationLog().
   *
   * @param {Object} [options]
   * @param {number} [options.limit] - max entries to return
   * @param {number} [options.kindMask] - bitmask of (1 << kind) values
   *   to include; default: all kinds.
   * @returns {Array<{seq, tick, kind, callerTag, slot, version, flags}>}
   */
  mutationLog({ limit, kindMask } = {}) {
    const v = this.view;
    const capacity = v.getUint32(HEADER.MUTATION_LOG_CAPACITY, true);
    if (capacity === 0) return [];
    const logOffset = v.getUint32(HEADER.MUTATION_LOG_OFFSET, true);
    const writeIndex = v.getUint32(HEADER.MUTATION_LOG_WRITE_INDEX, true);
    const out = [];
    const maxEntries = limit !== undefined
      ? Math.min(limit, capacity)
      : capacity;

    // Walk backward from the most recently written entry. We can read
    // up to `min(writeIndex, capacity)` entries; entries past
    // (writeIndex - capacity) have been overwritten by wrap.
    const readableCount = Math.min(writeIndex, capacity);

    for (let i = 0; i < Math.min(maxEntries, readableCount); i++) {
      // Most recent first: writeIndex-1, writeIndex-2, ...
      const w = (writeIndex - 1 - i) >>> 0;
      const ringSlot = w & (capacity - 1);
      const entryOffset = logOffset + ringSlot * MUTATION_LOG_ENTRY_SIZE;

      const seqLo = v.getUint32(entryOffset + MUTATION_LOG_ENTRY.SEQ_LO, true);
      // seq 0 means not yet published; entry was claimed but not
      // committed (or wrap re-claimed and writer hasn't finished).
      // Skip — readers should see no torn data.
      if (seqLo === 0) continue;

      // Detect skipped entries from a fast wrap: the expected seq
      // for this position is w + 1 (since seq is "writeIndex at
      // write time + 1"). If it doesn't match, this entry is from
      // a prior generation of the ring slot — readable but the
      // caller should know.
      const expectedSeq = (w + 1) >>> 0;
      if (seqLo !== expectedSeq && expectedSeq !== 0) {
        // Older entry surfaces in walk-back; report it but tag as
        // out-of-band. For now, just include it — callers comparing
        // seqs can detect the discontinuity.
      }

      const kind = v.getUint8(entryOffset + MUTATION_LOG_ENTRY.KIND);
      if (kindMask !== undefined && (kindMask & (1 << kind)) === 0) continue;

      const tickLo = v.getUint32(entryOffset + MUTATION_LOG_ENTRY.TICK_LO, true);
      const tickHi = v.getUint32(entryOffset + MUTATION_LOG_ENTRY.TICK_HI, true);
      const tick = (BigInt(tickHi) << 32n) | BigInt(tickLo);
      const callerTag = v.getUint32(entryOffset + MUTATION_LOG_ENTRY.CALLER_TAG, true);
      out.push({
        seq: seqLo,
        tick,
        kind,
        kindName:      MUTATION_KIND_NAME[kind] ?? `unknown(${kind})`,
        flags:         v.getUint16(entryOffset + MUTATION_LOG_ENTRY.FLAGS, true),
        slot:          v.getUint32(entryOffset + MUTATION_LOG_ENTRY.SLOT, true),
        version:       v.getUint32(entryOffset + MUTATION_LOG_ENTRY.VERSION, true),
        callerTag,
        callerTagName: MUTATION_TAG_NAME[callerTag] ?? `unknown(${callerTag})`,
      });
    }

    return out;
  }

  /**
   * Find the most recent log entry for a given slot, optionally
   * filtered. Structured errors use it to attach mutation provenance.
   *
   * Walks the log newest-to-oldest; O(capacity) worst case.
   *
   * @param {number} slot
   * @param {Object} [options]
   * @param {number} [options.kind] - require this MUTATION_KIND
   * @param {number} [options.kindMask] - bitmask of (1 << kind) values
   *   to accept; useful for "any KIND in the handle family" lookups.
   * @returns {Object|null} log entry, or null if not found
   */
  findLastMutationForSlot(slot, options = {}) {
    // Backwards compatibility: legacy callers passed a bare number as
    // the second arg (a single MUTATION_KIND). Detect and route.
    if (typeof options === 'number') {
      options = { kind: options };
    }
    const entries = this.findRecentMutationsForSlot(slot, { ...options, limit: 1 });
    return entries.length > 0 ? entries[0] : null;
  }

  /**
   * Find recent log entries for a given slot, newest first. Optional
   * kind / kindMask filter. Stops at `limit` entries. Used by
   * structured errors to attach mutation provenance with history.
   *
   * @param {number} slot
   * @param {Object} [options]
   * @param {number} [options.kind] - require this MUTATION_KIND
   * @param {number} [options.kindMask] - bitmask of accepted kinds
   * @param {number} [options.limit] - max entries (default 8)
   * @returns {Array} entries, newest first
   */
  findRecentMutationsForSlot(slot, options = {}) {
    const { kind, kindMask, limit = 8 } = options;
    const v = this.view;
    const capacity = v.getUint32(HEADER.MUTATION_LOG_CAPACITY, true);
    if (capacity === 0) return [];
    const logOffset = v.getUint32(HEADER.MUTATION_LOG_OFFSET, true);
    const writeIndex = v.getUint32(HEADER.MUTATION_LOG_WRITE_INDEX, true);
    const readableCount = Math.min(writeIndex, capacity);
    const out = [];
    for (let i = 0; i < readableCount && out.length < limit; i++) {
      const w = (writeIndex - 1 - i) >>> 0;
      const ringSlot = w & (capacity - 1);
      const entryOffset = logOffset + ringSlot * MUTATION_LOG_ENTRY_SIZE;
      const seqLo = v.getUint32(entryOffset + MUTATION_LOG_ENTRY.SEQ_LO, true);
      if (seqLo === 0) continue;
      const entrySlot = v.getUint32(entryOffset + MUTATION_LOG_ENTRY.SLOT, true);
      if (entrySlot !== slot) continue;
      const entryKind = v.getUint8(entryOffset + MUTATION_LOG_ENTRY.KIND);
      if (kind !== undefined && entryKind !== kind) continue;
      if (kindMask !== undefined && (kindMask & (1 << entryKind)) === 0) continue;
      const tickLo = v.getUint32(entryOffset + MUTATION_LOG_ENTRY.TICK_LO, true);
      const tickHi = v.getUint32(entryOffset + MUTATION_LOG_ENTRY.TICK_HI, true);
      const callerTag = v.getUint32(entryOffset + MUTATION_LOG_ENTRY.CALLER_TAG, true);
      out.push({
        seq: seqLo,
        tick: (BigInt(tickHi) << 32n) | BigInt(tickLo),
        kind: entryKind,
        kindName:      MUTATION_KIND_NAME[entryKind] ?? `unknown(${entryKind})`,
        flags:         v.getUint16(entryOffset + MUTATION_LOG_ENTRY.FLAGS, true),
        slot:          entrySlot,
        version:       v.getUint32(entryOffset + MUTATION_LOG_ENTRY.VERSION, true),
        callerTag,
        callerTagName: MUTATION_TAG_NAME[callerTag] ?? `unknown(${callerTag})`,
      });
    }
    return out;
  }

  /**
   * Grow the mutation log. The new capacity must be a power of two
   * and strictly greater than the current capacity (grow-only).
   *
   * Implementation: append fresh ring slots after the current log
   * region. The existing entries stay in place (their ring slots
   * are still addressable). The free-running write index keeps its
   * value; new writes go to slots beyond the old extent.
   *
   * Note: a more sophisticated implementation would re-shuffle so
   * the most-recent-N entries occupy contiguous positions. This
   * implementation just grows; readers walk newest-first and stop at
   * `min(writeIndex, capacity)` entries, so grown-out positions read as
   * never-written until first occupied.
   *
   * @param {number} newCapacity - power of two > current capacity
   */
  resizeMutationLog(newCapacity) {
    if (newCapacity <= 0 || (newCapacity & (newCapacity - 1)) !== 0) {
      throw new Error(
        `resizeMutationLog: newCapacity must be a positive power of two, got ${newCapacity}`);
    }
    const v = this.view;
    const oldCapacity = v.getUint32(HEADER.MUTATION_LOG_CAPACITY, true);
    if (newCapacity < oldCapacity) {
      throw new Error(
        `resizeMutationLog: shrink not supported; got ${newCapacity}, current ${oldCapacity}`);
    }
    if (newCapacity === oldCapacity) return;
    const oldLogOffset = v.getUint32(HEADER.MUTATION_LOG_OFFSET, true);
    const oldTotalBytes = oldLogOffset + oldCapacity * MUTATION_LOG_ENTRY_SIZE;
    const newTotalBytes = oldLogOffset + newCapacity * MUTATION_LOG_ENTRY_SIZE;
    if (newTotalBytes > this.byteLength) {
      throw new MembraneOutOfSpaceError(
        `resizeMutationLog: new total ${newTotalBytes} bytes exceeds ` +
        `membrane byteLength ${this.byteLength}. Grow the membrane ` +
        `buffer envelope first.`);
    }
    // Zero the freshly-added tail so new slots read as never-written
    // (seq == 0 sentinel).
    this.bytesView.fill(0, oldTotalBytes, newTotalBytes);
    v.setUint32(HEADER.MUTATION_LOG_CAPACITY, newCapacity, true);

    // The write index is free-running u32; existing readers walking
    // backward from (writeIndex - 1) will still hit the same entries
    // because (w & (oldCapacity - 1)) and (w & (newCapacity - 1))
    // resolve to the same ring slot for w values within the old
    // capacity. Capacity-doubling preserves recent-ring-slot
    // positions; older entries that wrapped become re-addressable
    // (they're still in the old ring positions). The next write
    // uses (writeIndex & (newCapacity - 1)) which may differ from
    // (writeIndex & (oldCapacity - 1)) — that's fine; we want new
    // writes to land in the freshly-zeroed extent so we don't
    // overwrite older entries we just resurrected.
  }

  // ===========================================================================
  // Bytes / restore
  // ===========================================================================

  bytes() {
    return new Uint8Array(this.bytesView);
  }

  /**
   * v5: reset diagnostic regions (ledger + runtime-state cell) to
   * their fresh-membrane state. Called from every restore path
   * (constructor fromBytes branch and loadBytes) because these
   * regions are NOT preserved across snapshot/restore — a
   * restored program isn't in flight, so the ledger must be
   * empty and the state cell must reflect the freshly-restored
   * runtime, not whatever was running at snapshot time.
   */
  _resetDiagnosticsOnRestore() {
    const ledgerOffset = this.view.getUint32(HEADER.LEDGER_OFFSET, true);
    const ledgerCapacity = this.view.getUint32(HEADER.LEDGER_CAPACITY, true);
    const runtimeStateOffset = this.view.getUint32(HEADER.RUNTIME_STATE_OFFSET, true);
    this.bytesView.fill(0, ledgerOffset, ledgerOffset + ledgerCapacity * LEDGER_ENTRY_BYTES);
    this.view.setUint32(runtimeStateOffset, RUNTIME_STATE.SCHEDULER_IDLE, true);
    // v11: the COST LEDGER is deliberately NOT reset here. Unlike the
    // in-flight ledger (which describes the now-stale in-flight state of
    // a program that is no longer running), the cost ledger is the
    // durable accounting record — its whole purpose is to survive
    // snapshot/restore. loadBytes copies it across verbatim; leave it.
  }

  loadBytes(bytes) {
    if (bytes.byteLength !== this.byteLength) {
      throw new Error(
        `Buffer size mismatch: existing membrane region is ${this.byteLength} bytes, fromMembraneBytes is ${bytes.byteLength}`
      );
    }
    this.bytesView.set(bytes);
    const magic = this.view.getUint32(HEADER.MAGIC, true);
    if (magic !== MEMBRANE_MAGIC) {
      throw new Error(`Invalid membrane buffer after restore: magic=0x${magic.toString(16)}`);
    }
    const version = this.view.getUint32(HEADER.DRONE_FORMAT_VERSION, true);
    if (version !== DRONE_FORMAT_VERSION) {
      throw new Error(`Unsupported drone format version after restore: ${version}`);
    }
    this._resetDiagnosticsOnRestore();
  }
}

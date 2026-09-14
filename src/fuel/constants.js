/**
 * Fuel-Based Interpreter Constants
 *
 * All numeric constants shared between JS and WAT.
 */

// =============================================================================
// SANDFUEL Header (16 bytes at segment start)
// =============================================================================

export const HEADER = {
  MAGIC: 0x00,           // 8 bytes: "SANDFUEL"
  DRONE_FORMAT_VERSION: 0x08, // u16
  BYTECODE_VERSION: 0x0A, // u16
  TYPE_VERSION: 0x0C,    // u16
  BUILTIN_VERSION: 0x0E, // u16
};

export const HEADER_SIZE = 0x10; // 16 bytes

// Current version numbers
export const VERSION = {
  BYTECODE: 2,  // Opcode definitions (v2: UNWIND_JUMP and
                //   PUSH_COMPLETION_KIND; catch blocks end with
                //   TRY_POP; every parse batch appends sentinel
                //   THROW/RETURN instructions for completion
                //   re-dispatch)
  TYPE: 6,      // TYPE_* value encodings (v6: Proof artifact v2 and
                //   scoped level/name handles; old proof handles cannot restore.
                //   v5: TYPE.SCHEMA descriptor — source value,
                //   compiled program buffer, options.
                //   v4: OBJECT_FLAG.EXTERNAL_BACKED —
                //   branded instances constructed by super() against a
                //   constructible external carry a backing external handle
                //   under the hidden own key "@externalBacking" and marshal
                //   as that handle.
                //   v3: TYPE.REGEXP descriptor —
                //   pattern string, flags, lastIndex, compiled program
                //   buffer. v2: TYPE.THEOREM now names a checked proof
                //   declaration artifact, not an equality derivation node)
  BUILTIN: 7,   // Builtin namespace surface (v7: Schema — the global,
                //   its method/option/result keys, error message
                //   templates. v6: extends-externals —
                //   the "@externalBacking" hidden key and the external
                //   link/construction diagnostics.
                //   v5: RegExp string methods —
                //   match/matchAll/search names, matchAll iterator
                //   hidden keys, global-flag validation messages).
                //   v4: Exact.Theorem removed;
                //   proof declarations use the checked Proof API.
                //   v3: async generators — the step-promise /
                //   request-queue hidden-key names. v2: toStringTag
                //   literals, getOwnPropertyDescriptor, size getters,
                //   generator protocol, Function.prototype
                //   call/apply/bind.
};

// =============================================================================
// Exit conditions (interpreter → host, output only)
// =============================================================================
// These answer: "Why did the interpreter exit?"
// Only the interpreter writes these. Host reads to dispatch handling.

export const EXIT_DONE = 1;
export const EXIT_PAUSED_FUEL = 2;
export const EXIT_EXTERNAL_CALL = 3;
export const EXIT_ERROR = 4;
// 5 and 6 removed (were STATUS_SUSPENDED and STATUS_THROW - not exit conditions)
export const EXIT_GRANT_REQUEST = 7;
export const EXIT_ASYNC_CALL = 8;       // Spawn a new async context for me
export const EXIT_ASYNC_COMPLETE = 9;   // I'm an async context and I finished
export const EXIT_ASYNC_REJECTED = 10;  // I'm an async context and I threw
export const EXIT_AWAIT = 11;           // I'm waiting on a promise
export const EXIT_PROMISE_METHOD = 12;  // Promise .then/.catch/.finally call
export const EXIT_EXTERNAL_PROPERTY = 13; // Member-access on external; host runs getter or falls through to method-binding
export const EXIT_PROMISE_SETTLE = 14;    // Promise executor called resolve/reject; host settles the promise without handler lookup
export const EXIT_MEMORY_PRESSURE = 15;   // Allocation in the string table (or heap-tail concat scratch) would overflow; the offending instruction has not consumed its operands and has not advanced. Host may gc() and resume, or surface as OOM.
export const EXIT_EXTERNAL_PROPERTY_SET = 16; // Member-assignment on external (`external.prop = v`); host runs a registered setter. Fire-and-forget from the interpreter's view: the sync setter takes the non-suspending path; a Promise/SuspensionMarker setter may suspend (mirrors the getter path).
// A generator is a parked context driven
// by its generator object's next/return/throw methods; the caller of
// next() parks like an awaiter and session.run trampolines these exits.
export const EXIT_GENERATOR_CALL = 17;     // Calling a function* — spawn a generator context for me
export const EXIT_GENERATOR_NEXT = 18;     // gen.next/return/throw invoked — park me, drive the generator
export const EXIT_GENERATOR_YIELD = 19;    // I'm a generator context and I hit `yield` (value on my pending stack)
export const EXIT_GENERATOR_COMPLETE = 20; // I'm a generator context and my body returned (value on my pending stack)
export const EXIT_GENERATOR_THROW = 21;    // I'm a generator context and I threw (exception in my completion slot)
// External class-link and instanceof branches must read host state
// (constructible registration and surrogate binding) that the interpreter
// cannot see, so they yield to the host adapter, which services them
// synchronously without running capability code and resumes the same
// instruction.
export const EXIT_CLASS_LINK_EXTERNAL = 22;  // CLASS_LINK found a TYPE_EXTERNAL parent
export const EXIT_INSTANCEOF_EXTERNAL = 23;  // OP_INSTANCEOF found a TYPE_EXTERNAL right side
// Branded-instance forwarding: string-key miss probes and deletes
// against the backing external value.
export const EXIT_EXTERNAL_HAS_PROPERTY = 24;
export const EXIT_EXTERNAL_DELETE_PROPERTY = 25;

// Response type (host → interpreter, input)
// =============================================================================
// Host sets this to signal what's on the pending stack when resuming.

export const RESPONSE_NORMAL = 0;
export const RESPONSE_THROW = 1;
// Resume a parked context with a RETURN completion: run() pushes the
// prepared value (already on the context's pending stack) through the
// sentinel RETURN instruction, so the v11 return walk runs finallys and
// the bottom-of-context return completes normally. Used by
// generator.return().
export const RESPONSE_RETURN = 2;

// Interpreter-internal dispatch results. These never reach the host.
export const STATUS_SUCCESS = 0;
export const STATUS_THROW_CAUGHT = 1;
export const STATUS_THROW_UNCAUGHT = 2;
// 3: JSON transformation must resolve a getter-backed property.
// 4: generator control yielded to its caller.
// 5: a native-continuation frame and callback arguments are staged.
// 6: Function.prototype.call/apply/bind staged a closure call.
export const STATUS_NATIVE_CONTINUATION_STAGED = 5;

// Error codes (written to error info region)
export const ERR_NONE = 0;
export const ERR_UNDEFINED_VARIABLE = 1;
export const ERR_ASSIGN_UNDEFINED = 2;
export const ERR_NOT_CALLABLE = 3;
export const ERR_NOT_ITERABLE = 4;
export const ERR_PROPERTY_NULL = 5;
export const ERR_INVALID_OPERAND = 6;
export const ERR_STACK_OVERFLOW = 7;
export const ERR_TYPE_ERROR = 8;
export const ERR_ARITY = 9;
export const ERR_USER_THROW = 12;
export const ERR_MSGPACK_READONLY = 13;
export const ERR_MSGPACK_INVALID = 14;
export const ERR_NOT_SUPPORTED = 15;   // NotSupportedError: new String(), prototype chain, etc.

// ERR_NOT_SUPPORTED detail codes. detail=0 keeps the existing generic
// "Operation not supported" message (new String() / new Number()); named
// details distinguish deliberate unsupported surfaces from missing values.
export const NOT_SUPPORTED_FEATURE = {
  DELETE: 1,
  VOID: 2,
  IN: 3,
  MATH_RANDOM: 4,
  REGEXP: 5,    // regex dialect rejects the construct (backreference,
                // lookaround, unsupported flag) — fail loud at compile
  SCHEMA: 6,    // schema validation needs a table the engine does not
                // carry (IDNA labels) — refused, never guessed
};
export const ERR_REDECLARATION = 16;   // Variable already declared in scope
export const ERR_OUT_OF_MEMORY = 17;   // Out of memory (heap, string table, or stacks)
export const ERR_MISSING_REGION = 18;  // Required memory region not found
export const ERR_CONST_ASSIGNMENT = 19; // Assignment to constant variable
export const ERR_GRANT_DENIED = 20;     // External call requires grant not in current stack
export const ERR_RANGE_ERROR = 21;      // RangeError: invalid array length, buffer size, etc.
export const ERR_SYNTAX_ERROR = 22;     // SyntaxError: invalid source text conversion

// GC error codes — the WAT collector's detected-failure channel.
// Stamped as [code][detail][phase] into the
// error-info region and returned as the collect export's status.
// Base 0x40 keeps them outside the interpreter's ERR_* range above
// and within one byte (the step ring stores errorCode as u8).
export const GC_ERR_SEGMENT_BOUNDS   = 0x40; // image-derived address outside [0, SEGMENT_SIZE)
export const GC_ERR_COPY_RANGE       = 0x41; // move/copy range (dst, src, size) escapes the segment
export const GC_ERR_HANDLE_SLOT_RANGE = 0x42; // live handle slot ≥ handle-bitmap capacity
export const GC_ERR_ROOT_BLOCK_RANGE = 0x43; // host-passed root block malformed / out of bounds

export const GC_ERR_AST_TAG          = 0x44; // AST walk hit a tag with no NODE_LAYOUT record
export const GC_ERR_AST_WORKLIST     = 0x45; // AST worklist overflow (provably impossible unless the layout is wrong)
export const GC_ERR_HEAP_HEADER      = 0x46; // heap walk encountered a zero-size object before heapPointer

// GC phase ids — the third word of the error-info stamp on collector
// failure (the pc slot; the GC_ERR code namespace tells readers it is
// a phase, not a pc).
export const GC_PHASE = {
  MARK: 1,
  COMPUTE: 2,
  UPDATE: 3,
  MOVE: 4,
  STRINGS: 5,
  HASH_REBUILD: 6,
};

// GC scratch block header — the self-describing head of the WAT
// collector's out-of-segment working memory. See
// src/fuel/gc-scratch-layout.js for the full block layout. Field offsets
// are block-relative u32s. Lives here so the WAT's mirror globals are
// build-verified like every other layout fact.
export const GC_SCRATCH_HEADER = {
  OPERAND_KINDS_OFFSET:      0,
  INTRINSIC_CELLS_OFFSET:    4,
  INTRINSIC_CELL_COUNT:      8,
  AST_LAYOUT_OFFSET:         12,
  AST_LAYOUT_TAG_CAPACITY:   16,  // record count (max tag + 1)
  STRING_MARK_BITMAP_OFFSET: 20,
  STRING_MARK_BITMAP_SIZE:   24,
  AST_VISITED_BITMAP_OFFSET: 28,
  AST_VISITED_BITMAP_SIZE:   32,
  AST_WORKLIST_OFFSET:       36,
  AST_WORKLIST_CAPACITY:     40,  // u32 entries
  HANDLE_BITMAP_OFFSET:      44,
  HANDLE_BITMAP_CAPACITY:    48,  // handle slots (bits)
  ROOT_BLOCK_OFFSET:         52,
  ROOT_CAPACITY:             56,  // u32 entries
  ROOT_COUNT:                60,  // written per collect
  STRING_FORWARDING_OFFSET:  64,  // 1 u32 per 4 bytes of string data
  STRING_FORWARDING_ENTRIES: 68,
};
export const GC_SCRATCH_HEADER_SIZE = 72;
export const ERR_JSON_PARSE = 22;       // SyntaxError: JSON.parse failures (detail = position or 0)
export const ERR_JSON_STRINGIFY = 23;   // TypeError: JSON.stringify circular reference
export const ERR_UNKNOWN_OPCODE = 24;   // Bytecode region was corrupted (heap overrun) or compiler emitted an undefined opcode. Detail = the byte the dispatcher fetched.
export const ERR_STACK_UNDERFLOW = 25;  // Operand-stack pop below base during NORMAL execution — a codegen/dispatch bug (the deferred-POP class). Detail = the pc. Unwind over-pops (COMPLETION_THROW) still clamp.
export const ERR_CORRUPT_OPERAND = 26;  // A count operand (or frame argc) contradicts the structure it indexes — more values than the stack holds, paramCount above MAX_PARAMETER_COUNT, hasRest outside {0,1}. The parser never emits these; the code block (or frame) was corrupted. Detail = the offending value.
export const ERR_HEAP_CODE_COLLISION = 27; // The dispatcher's heap/code collision backstop fired: heap_pointer reached code_pointer, so some carve wrote through the whole slack red zone unguarded — the code block is likely already corrupt. Distinct from ERR_OUT_OF_MEMORY (an honest refusal with integrity intact).

// Error codes that mean the interpreter's execution substrate itself is broken
// (corrupted bytecode, corrupted frames, heap writes through the code
// block) rather than the guest program misbehaving. Raised via the
// WAT's $fault_error — NOT catchable by guest try/catch/finally, so
// they always reach the host with their true code (a finally rethrow
// re-labels catchable engine errors as USER_THROW). Host-side
// classification lives in runtime/errors.js isVatFault().
export const VAT_FAULT_ERROR_CODES = Object.freeze([
  ERR_UNKNOWN_OPCODE,
  ERR_STACK_UNDERFLOW,
  ERR_CORRUPT_OPERAND,
  ERR_HEAP_CODE_COLLISION,
]);

// Hard ceiling on a function's declared parameter count, enforced at
// parse time. Mirrored by $MAX_PARAMETER_COUNT in interpreter.wat: a
// RECONCILE_PARAMS operand above this is corruption by definition
// (ERR_CORRUPT_OPERAND), never a legitimate program.
export const MAX_PARAMETER_COUNT = 65535;

// Scope entry flags
// Variable is const (cannot be reassigned). Bit 31: the scope entry's
// flags word doubles as the stored VALUE's flags word, and the low byte
// belongs to TYPE_BOUND_METHOD's receiver type (TYPE_STRING = 0x05,
// TYPE_SET = 0x25 — both odd). The historic 0x01 made `let m = "x".slice`
// read as const, and $scope_set's flag-merge destroyed receiver types on
// reassignment. No value-level flag uses bit 31.
export const SCOPE_FLAG_CONST = 0x80000000;

// Completion types (for try/catch/finally)
export const COMPLETION_NORMAL = 0;
export const COMPLETION_THROW = 1;
export const COMPLETION_RETURN = 2;
// Layout v11: a pending break/continue crossing try frames. The
// completion value's lo word is the jump target instruction index and
// the hi word is the number of try entries still to unwind after the
// current finally completes (see OP.UNWIND_JUMP).
export const COMPLETION_JUMP = 3;

// State header offsets (relative to baseOffset, after HEADER_SIZE)
// Note: Per-execution state (scope, pointers, status, fuel) moved to context in v6
export const STATE = {
  // Heap management (global, shared across contexts)
  HEAP_POINTER: HEADER_SIZE + 0x00,
  STRING_POINTER: HEADER_SIZE + 0x04,
  HEAP_START: HEADER_SIZE + 0x08,
  HEAP_END: HEADER_SIZE + 0x0C,
  STRING_START: HEADER_SIZE + 0x10,
  SEGMENT_SIZE: HEADER_SIZE + 0x14,
  BASE_OFFSET: HEADER_SIZE + 0x18,

  // Code block (global, single code block per session)
  CODE_POINTER: HEADER_SIZE + 0x1C,    // current write position for code, decrements as code grows
  CODE_BLOCK: HEADER_SIZE + 0x20,      // pointer to the code block

  // Region base offsets (computed at init)
  // HEADER_SIZE + 0x24 is RETIRED (layout v8): was EXTERNAL_REQUEST_BASE,
  // the global request-scratch region — the request block is now
  // per-context (CTX.REQUEST_BLOCK). The header slot stays reserved so
  // the other STATE offsets keep their addresses.
  ERROR_INFO_BASE: HEADER_SIZE + 0x28,
  SCRATCH_BASE: HEADER_SIZE + 0x2C,
  BUILTINS_BASE: HEADER_SIZE + 0x30,

  // Intrinsic references (v3: prototype chain support)
  OBJECT_PROTOTYPE: HEADER_SIZE + 0x34,          // %ObjectPrototype%
  FUNCTION_PROTOTYPE: HEADER_SIZE + 0x38,        // %FunctionPrototype%
  ERROR_CONSTRUCTOR: HEADER_SIZE + 0x3C,         // %Error%
  TYPE_ERROR_CONSTRUCTOR: HEADER_SIZE + 0x40,    // %TypeError%
  REFERENCE_ERROR_CONSTRUCTOR: HEADER_SIZE + 0x44, // %ReferenceError%
  ARRAY_PROTOTYPE: HEADER_SIZE + 0x48,           // %ArrayPrototype%
  ERROR_PROTOTYPE: HEADER_SIZE + 0x4C,           // %ErrorPrototype%
  TYPE_ERROR_PROTOTYPE: HEADER_SIZE + 0x50,      // %TypeErrorPrototype%
  REFERENCE_ERROR_PROTOTYPE: HEADER_SIZE + 0x54, // %ReferenceErrorPrototype%
  GRANT_DENIED_ERROR_PROTOTYPE: HEADER_SIZE + 0x58, // %GrantDeniedErrorPrototype%

  // RangeError (v5: typed arrays)
  RANGE_ERROR_PROTOTYPE: HEADER_SIZE + 0x5C,
  RANGE_ERROR_CONSTRUCTOR: HEADER_SIZE + 0x60,

  // ArrayBuffer/Uint8Array (v5: typed arrays)
  ARRAYBUFFER_PROTOTYPE: HEADER_SIZE + 0x64,
  UINT8ARRAY_PROTOTYPE: HEADER_SIZE + 0x68,
  DATAVIEW_PROTOTYPE: HEADER_SIZE + 0x6C,

  // Multi-context execution (v6)
  CONTEXT_COUNT: HEADER_SIZE + 0x70,         // number of allocated context slots
  // String.prototype object used for primitive-string symbol dispatch. Primitive strings
  // dispatch symbol-keyed property access (e.g. Symbol.iterator) through
  // this object. Slotted into the previously-unused 0x74 gap so we don't
  // have to grow STATE_SIZE for one extra pointer.
  STRING_PROTOTYPE: HEADER_SIZE + 0x74,
  // Layout v10: DATA pointer to the slot→pointer context table, a growable
  // STACK_BLOCK heap object (one i32 context-object pointer per slot).
  // allocateContext reallocs it when full; the collector marks it as a root
  // and forwards this cell (data-pointer rule, like ROOT_SCOPE).
  CONTEXT_TABLE_POINTER: HEADER_SIZE + 0x78,
  ROOT_SCOPE: HEADER_SIZE + 0x7C,            // root scope pointer (builtins, externals)

  // Symbol registry (Symbol.for / Symbol.keyFor backing store).
  // Heap pointer to an Object whose keys are interned string
  // offsets of symbol descriptions and whose values are Symbol heap pointers.
  // The registry itself lives in the regular heap; STATE just holds the
  // pointer so GC treats it as a root.
  SYMBOL_REGISTRY: HEADER_SIZE + 0x80,       // Symbol registry object pointer

  // Optional opaque AST region carrying
  // the AST that produced the bytecode. The interpreter does not read it;
  // host APIs return raw bytes and the host's dialect decoder interprets
  // them. Size 0 means inlineSource was off (the default).
  AST_REGION_BASE: HEADER_SIZE + 0x84,       // segment-relative start of region
  AST_REGION_SIZE: HEADER_SIZE + 0x88,       // total bytes reserved (0 if disabled)
  AST_REGION_POINTER: HEADER_SIZE + 0x8C,    // current write head (relative to base)

  // Well-known symbols. Header pointers to
  // the canonical Symbol.iterator and Symbol.asyncIterator symbols minted
  // at bootstrap. WAT reads these directly to push the well-known symbol
  // values without going through Symbol.* property lookup.
  WELL_KNOWN_ITERATOR_SYMBOL: HEADER_SIZE + 0x90,
  WELL_KNOWN_ASYNC_ITERATOR_SYMBOL: HEADER_SIZE + 0x94,

  // Map and Set prototype object pointers. Methods are
  // attached to these prototypes during bootstrap and resolved via
  // the standard symbol-key / string-key dispatch paths.
  MAP_PROTOTYPE: HEADER_SIZE + 0x98,
  SET_PROTOTYPE: HEADER_SIZE + 0x9C,

  // TextEncoder / TextDecoder prototype pointers. Instances are plain
  // objects whose [[Prototype]] is one of these; .encode / .decode are
  // bound methods stored on the prototype and resolved through standard
  // property lookup.
  TEXT_ENCODER_PROTOTYPE: HEADER_SIZE + 0xA0,
  TEXT_DECODER_PROTOTYPE: HEADER_SIZE + 0xA4,

  // Actual scratch region size (written during layout initialization, read by internString).
  SCRATCH_REGION_SIZE: HEADER_SIZE + 0xA8,

  // Step ring: opt-in per-instruction binary event ring in linear memory.
  // Region base and size are written during layout initialization. Size 0 means disabled.
  STEP_RING_BASE: HEADER_SIZE + 0xAC,
  STEP_RING_SIZE: HEADER_SIZE + 0xB0,

  // The canonical Symbol.toStringTag symbol minted at bootstrap and threaded
  // through Object.prototype.toString and the string coercion paths.
  WELL_KNOWN_TO_STRING_TAG_SYMBOL: HEADER_SIZE + 0xB4,

  // Header-event ring (layout v13): records writes to global STATE.*
  // fields (context-table growth, GC pointer forwarding, segment
  // resize) plus GC-cycle start/end events. Default disabled (size=0).
  HEADER_EVENT_RING_BASE: HEADER_SIZE + 0xB8,
  HEADER_EVENT_RING_SIZE: HEADER_SIZE + 0xBC,
  SYNTAX_ERROR_PROTOTYPE: HEADER_SIZE + 0xC0,
  SYNTAX_ERROR_CONSTRUCTOR: HEADER_SIZE + 0xC4,
  BIGINT_PROTOTYPE: HEADER_SIZE + 0xC8,
  BIGINT_CONSTRUCTOR: HEADER_SIZE + 0xCC,
  WELL_KNOWN_TO_PRIMITIVE_SYMBOL: HEADER_SIZE + 0xD0,
  // Layout v18: DATA pointer to the growable slot→allocation-generation
  // table. Generations remain after a context pointer is cleared.
  CONTEXT_GENERATION_TABLE_POINTER: HEADER_SIZE + 0xD4,
  // Layout v21: RegExp.prototype intrinsic (instanceof identity; instances
  // are TYPE_REGEXP primitives whose methods bind per-instance, so this
  // object stores no methods).
  REGEXP_PROTOTYPE: HEADER_SIZE + 0xD8,
  // Layout v22: the hidden bootstrap symbol keying a match-result array's
  // metadata object (index/input/groups/indices) in its sym-entries block.
  // Never exposed on the Symbol global; script code cannot forge it.
  REGEXP_MATCH_META_SYMBOL: HEADER_SIZE + 0xDC,
};

export const STATE_SIZE = 0xE0;  // 224 bytes

// STATE cells holding heap HEADER pointers to intrinsic objects
// (prototypes, constructors, registries, well-known symbols). The
// collector marks every non-zero entry as a GC root and forwards the
// cell across compaction; the WAT collector consumes the same list as a
// host-written knowledge table. The true inventory is the set of
// `setState(STATE.*, <heap header pointer>)` calls in memory-image.js —
// when adding one, add it here and both collector sites inherit it.
//
// STATE.ROOT_SCOPE is deliberately NOT in this list: it holds a scope
// DATA pointer (different forwarding rule), is marked transitively
// via context 0's CTX_SCOPE chain, and is forwarded by a dedicated
// step in updateIntrinsics.
export const INTRINSIC_STATE_CELLS = [
  STATE.OBJECT_PROTOTYPE,
  STATE.FUNCTION_PROTOTYPE,
  STATE.ARRAY_PROTOTYPE,
  STATE.ERROR_PROTOTYPE,
  STATE.TYPE_ERROR_PROTOTYPE,
  STATE.REFERENCE_ERROR_PROTOTYPE,
  STATE.GRANT_DENIED_ERROR_PROTOTYPE,
  STATE.RANGE_ERROR_PROTOTYPE,
  STATE.ERROR_CONSTRUCTOR,
  STATE.TYPE_ERROR_CONSTRUCTOR,
  STATE.REFERENCE_ERROR_CONSTRUCTOR,
  STATE.RANGE_ERROR_CONSTRUCTOR,
  STATE.SYNTAX_ERROR_PROTOTYPE,
  STATE.SYNTAX_ERROR_CONSTRUCTOR,
  STATE.BIGINT_PROTOTYPE,
  STATE.BIGINT_CONSTRUCTOR,
  STATE.WELL_KNOWN_TO_PRIMITIVE_SYMBOL,
  STATE.ARRAYBUFFER_PROTOTYPE,
  STATE.UINT8ARRAY_PROTOTYPE,
  STATE.DATAVIEW_PROTOTYPE,
  STATE.SYMBOL_REGISTRY,
  STATE.MAP_PROTOTYPE,
  STATE.SET_PROTOTYPE,
  // Well-known symbol heap objects: the pointer-as-sym-entry-key on
  // prototype objects is forwarded by the heap walker, but the STATE
  // cell itself must be forwarded too or post-GC symbol lookups
  // (LIT_WELL_KNOWN_SYMBOL → GET_INDEX) see the pre-move address.
  STATE.WELL_KNOWN_ITERATOR_SYMBOL,
  STATE.WELL_KNOWN_ASYNC_ITERATOR_SYMBOL,
  STATE.WELL_KNOWN_TO_STRING_TAG_SYMBOL,
  // STRING_PROTOTYPE's STATE cell is the object's ONLY root
  // (primitive-string symbol dispatch reads it directly).
  STATE.STRING_PROTOTYPE,
  // `new TextEncoder()` / `new TextDecoder()` stamp instances with
  // these prototype pointers via the WAT's $STATE_TEXT_*_PROTOTYPE reads.
  STATE.TEXT_ENCODER_PROTOTYPE,
  STATE.TEXT_DECODER_PROTOTYPE,
  // RegExp.prototype: instanceof identity and the RegExp global's
  // .prototype property both reference this object (layout v21).
  STATE.REGEXP_PROTOTYPE,
  // The hidden match-metadata symbol (layout v22): its only other root
  // is each match-result array's sym-entries KEY column, which the heap
  // walker forwards — but the STATE cell must be forwarded too or
  // post-GC exec results key their metadata under a stale address.
  STATE.REGEXP_MATCH_META_SYMBOL,
];

// Default region sizes (used by initialize() to compute layout)
// Note: Stack regions removed in v6 - now allocated per-context
export const REGION_SIZE = {
  // EXTERNAL_REQUEST region RETIRED (layout v8) — per-context now
  // (CTX.REQUEST_BLOCK / REQUEST_BLOCK_SIZE).
  ERROR_INFO: 16,
  SCRATCH: 65536,        // Caps the byte length of interned strings (and thus
                         // of string literals at parse time). Real workloads
                         // carry multi-kilobyte inline literals such as HTML
                         // and source text, so this must be generous.
                         // Configurable per session via scratchSize.
  BUILTINS: 4096,
  AST_REGION: 0,          // Default 0 (disabled). Hosts opt in by passing
                          // astRegionSize at session creation.
  STEP_RING: 0,           // Default 0 (disabled). Hosts opt in by passing
                          // stepRingSize at session creation.
  HEADER_EVENT_RING: 0,   // Default 0 (disabled). Hosts opt in by passing
                          // headerEventRingSize at session creation.
};

export const SCRATCH_SIZE = REGION_SIZE.SCRATCH;

// Smallest legal scratch region. The interpreter's own fixed-extent
// staging (f64 digit buffer ≤ 36 B, msgpack peek block 16 B, grant
// operands 8 B, ...) must always fit: $scratch_ptr in the WAT traps on
// a bounds violation, and this floor keeps that trap unreachable in
// any session computeVatLayout was willing to create.
export const SCRATCH_MINIMUM_SIZE = 256;

// Free-span floor for the dispatcher's per-instruction heap-slack
// safepoint. Must match interpreter.wat's HEAP_SLACK_HEADROOM. Execution yields
// EXIT_MEMORY_PRESSURE whenever code_pointer - heap_pointer drops
// below this, so bump-then-write heap carves bounded by one
// instruction's burst can never write into the code block. The heap's
// top HEAP_SLACK_HEADROOM bytes are effectively a red zone.
export const HEAP_SLACK_HEADROOM = 65536;

export const BUILTINS_SIZE = 4096;

// String-region interior layout.
// Must match interpreter.wat's $derive_string_index_layout /
// $STRING_DATA_START:
//
//   [stringStart .. +STRING_DATA_START)  reserved prefix (id 0 invalid)
//   [.. stringStart + S - hashTableSize) interned entries (bump)
//   [.. stringStart + S)                 hash index, buckets × 8 bytes
//
// The bucket count is derived from the region size S so the index
// always holds STRICTLY more buckets than the data span can hold
// entries (min real entry is 8 bytes: 4-byte length + 1 char,
// 4-aligned; the 4-byte empty-string entry is unique by dedup; S must
// be a multiple of 8, which computeVatLayout/resizeSegment validate).
// Saturation of the index is therefore structurally impossible — the
// intern probe and both GC rebuilds trap on their (now-dead)
// exhaustion paths instead of silently evicting/dropping entries.
// The index sits at the region TAIL so a string-table resize can
// change its derived size without shifting interned ids.
export const STRING_DATA_START = 8;
export function hashTableBuckets(stringTableSize) {
  return Math.floor(stringTableSize / 16) + 1;
}
export function hashTableSize(stringTableSize) {
  return hashTableBuckets(stringTableSize) * 8;
}

// FNV-1a string-hash constants (32-bit). Shared by the WAT interner
// ($FNV_OFFSET_BASIS / $FNV_PRIME) and the collector's hash-table
// rebuild after string compaction. A divergence would silently corrupt
// interning: strings hashed under one basis become unfindable after a
// compaction rebuilt the table under the other.
export const FNV_OFFSET_BASIS = 0x811c9dc5;
export const FNV_PRIME = 0x01000193;

// =============================================================================
// Execution Context (v6: multi-context support)
// =============================================================================

// Context lifecycle marker
// Note: When a context is in use, exit condition field holds EXIT_* values (1-11).
// Value 0 means "no exit yet" (context running or never run).
// CONTEXT_STATUS_FREE must be distinct from all EXIT_* values to indicate a free slot.
export const CONTEXT_STATUS_FREE = 0xFF;  // Free slot marker

// Context region layout (12KB = 12288 bytes = 0x3000)
export const CONTEXT_SIZE = 12288;
export const CONTEXT_PENDING_OFFSET = 0x0000;
export const CONTEXT_PENDING_SIZE = 4096;
export const CONTEXT_CALL_STACK_OFFSET = 0x1000;
export const CONTEXT_CALL_STACK_SIZE = 4096;
export const CONTEXT_TRY_STACK_OFFSET = 0x2000;
export const CONTEXT_TRY_STACK_SIZE = 1024;
export const CONTEXT_GRANT_STACK_OFFSET = 0x2400;
export const CONTEXT_GRANT_STACK_SIZE = 512;
// The state block is the context object, so it starts at offset 0.
// It was at 0x2600 in the old single-slab layout.
export const CONTEXT_STATE_OFFSET = 0;

// Context state block field offsets (relative to state block start at CONTEXT_STATE_OFFSET)
export const CTX = {
  EXIT_CONDITION: 0x00,
  INSTRUCTION_INDEX: 0x04,
  SCOPE: 0x08,
  PENDING_POINTER: 0x0C,
  CALL_STACK_POINTER: 0x10,
  GRANT_STACK_POINTER: 0x14,
  TRY_STACK_POINTER: 0x18,
  COMPLETION_TYPE: 0x1C,
  COMPLETION_VALUE: 0x20,
  CONTINUATION_ID: 0x24,
  FUEL: 0x28,
  WAITING_ON: 0x2C,       // promise data pointer (0 if not waiting)
  RESPONSE_TYPE: 0x34,    // host → interpreter input: RESPONSE_NORMAL or RESPONSE_THROW

  // Each heap-allocated context stores every stack in its own STACK_BLOCK heap
  // object. The state block stores each stack's base (segment-relative pointer to
  // the block's first byte) and limit (one-past-the-last usable byte = base +
  // capacity). The stack's "top" pointer (PENDING_POINTER etc.) is a segment
  // offset between base and limit. On overflow the block relocates: base, limit,
  // and the top pointer are all rewritten by the same delta.
  PENDING_BASE: 0x38,
  PENDING_LIMIT: 0x3C,
  CALL_STACK_BASE: 0x40,
  CALL_STACK_LIMIT: 0x44,
  TRY_STACK_BASE: 0x48,
  TRY_STACK_LIMIT: 0x4C,
  GRANT_STACK_BASE: 0x50,
  GRANT_STACK_LIMIT: 0x54,

  // The context carries 16-byte inline storage for the completion value. Previously the
  // completion value lived in a reserved slot just below the pending stack base
  // (PENDING_BASE - 16), which relied on the pending stack sitting inside a
  // larger slab with slack below it. With each stack its own heap block, that
  // slot would land in a neighbouring object — so the completion value now lives
  // in the context object itself. COMPLETION_VALUE points here.
  COMPLETION_VALUE_STORAGE: 0x58,  // 0x58..0x67 (16 bytes)

  // Layout v8: the external request block is PER-CONTEXT. The WAT writes a
  // parked slot's yield payload here (handleId/methodOffset/args for external
  // calls, promise fields for await/settle, closure+receiver for async calls)
  // and the host reads it back per slot. A single global scratch region would
  // let concurrent parks overwrite one another's staged payloads, preventing
  // the collector from marking or forwarding every parked context's
  // arguments.
  REQUEST_BLOCK: 0x68,             // 0x68..0x87 (32 bytes — REQUEST_BLOCK_SIZE)

  // Generators: header pointer of the generator OBJECT this context is
  // the body of (0 = not a generator context). Written at spawn; read by
  // RETURN at the bottom frame (→ EXIT_GENERATOR_COMPLETE) and by the
  // no-handler throw path (→ EXIT_GENERATOR_THROW). GC root in both
  // collectors. Fits the context object's existing padding (0x88..0x8B
  // < CONTEXT_OBJECT_SIZE 0x90).
  GENERATOR_OBJECT: 0x88,
  // Layout v19: scalar ownership marker for Runtime.invokeClosure contexts.
  // Zero is an ordinary context; one is an invocation root. The marker is
  // snapshot-owned but is not a traced heap pointer.
  INVOCATION_ROOT: 0x8C,
  // Layout v20: traced root for a paused RegExp engine operation. Holds a
  // NATIVE_CONTINUATION_STATE header pointer (0 = none) whose slots keep
  // the compile/match workspaces, program buffer, and descriptor alive
  // while LIT_REGEXP (or a later match opcode) is parked on fuel. Cleared
  // at the operation's commit point.
  REGEX_STATE: 0x90,
  // External construction: traced root holding the HEAP header pointer of
  // a branded receiver whose abortConstruction is owed (0 = none).
  // Staged by the unwind walk / different-object validation, drained at
  // the dispatch-loop head, chained LIFO through the receivers'
  // @constructionLink hidden entries. Carved from the 0x94..0x9F
  // context-object padding — pre-existing snapshots hold zero here, so
  // no layout bump is needed.
  CONSTRUCTION_DUTY: 0x94,
};

// Per-context request block size: the largest yield payload is the async
// call's [closurePointer:4][argsPointer:4][argCount:4][receiver value:16] =
// 28 bytes, rounded up with spare.
export const REQUEST_BLOCK_SIZE = 32;

// Size of the context object (the state block) as a heap allocation. Covers all
// CTX fields above (last is CONSTRUCTION_DUTY at 0x94, 4 bytes ending at 0x98).
// Rounded to 0xA0.
export const CONTEXT_OBJECT_SIZE = 0xA0;

// Initial per-stack block sizes (bytes). Each stack starts as its own
// STACK_BLOCK heap object at this size and grows independently (realloc to a 2x
// block on overflow — see $grow_stack in interpreter.wat). Sized to the COMMON
// case, not the worst case: a parked waiter costs the sum of these (a few hundred
// bytes), and a stack that actually goes deep grows on demand. Each stack grows
// alone; growth never touches the other three.
//
//   operand: a handful of values mid-expression   (8 × VALUE_SIZE 16  = 128)
//   call:    a few nested frames                   (8 × FRAME_SIZE 60 ≈ 512, rounded)
//   try:     a couple of try/catch blocks          (4 × TRY_ENTRY_SIZE 56 = 224)
//   grant:   a couple of active grants             (4 × GRANT_ENTRY_SIZE 32 = 128)
export const CONTEXT_PENDING_INITIAL_SIZE = 128;     // operand stack
export const CONTEXT_CALL_STACK_INITIAL_SIZE = 512;  // call stack
export const CONTEXT_TRY_STACK_INITIAL_SIZE = 160;   // try stack
export const CONTEXT_GRANT_STACK_INITIAL_SIZE = 128; // grant stack

// Initial slot→pointer context-table size (bytes; 4 bytes = 1 slot). The table
// is a growable STACK_BLOCK heap object (layout v10) — allocateContext reallocs
// it to a 2x block when the next slot would exceed capacity, so this is a
// starting hint, not a ceiling. 64 slots covers common workloads without a
// single doubling; a session that parks hundreds of contexts pays log2(N/64)
// cheap realloc-and-copy growths, once ever. Configurable via the
// contextTableSize layout option.
export const CONTEXT_TABLE_INITIAL_SIZE = 256;

// BUILTINS segment offsets (relative to builtins base)
// Pre-interned string pointers for built-in names
export const BUILTIN_NAME = {
  // Typeof strings (moved from STATE)
  TYPEOF_UNDEFINED: 0x00,
  TYPEOF_BOOLEAN: 0x04,
  TYPEOF_NUMBER: 0x08,
  TYPEOF_STRING: 0x0C,
  TYPEOF_OBJECT: 0x10,
  TYPEOF_FUNCTION: 0x14,

  // Special keywords
  THIS: 0x18,
  LENGTH: 0x1C,

  // Array methods (0x20 - 0x6F)
  PUSH: 0x20,
  POP: 0x24,
  SHIFT: 0x28,
  UNSHIFT: 0x2C,
  SLICE: 0x30,
  CONCAT: 0x34,
  JOIN: 0x38,
  REVERSE: 0x3C,
  INDEX_OF: 0x40,
  INCLUDES: 0x44,
  MAP: 0x48,
  FILTER: 0x4C,
  REDUCE: 0x50,
  FOR_EACH: 0x54,
  FIND: 0x58,
  FIND_INDEX: 0x5C,
  SOME: 0x60,
  EVERY: 0x64,
  SPLICE: 0x68,
  SORT: 0x6C,
  FLAT: 0x70,
  FLAT_MAP: 0x74,
  AT: 0x78,

  // String methods (0x80 - 0xDF)
  CHAR_AT: 0x80,
  CHAR_CODE_AT: 0x84,
  STRING_INDEX_OF: 0x88,
  STRING_INCLUDES: 0x8C,
  STRING_SLICE: 0x90,
  SUBSTRING: 0x94,
  SPLIT: 0x98,
  TRIM: 0x9C,
  TO_LOWER_CASE: 0xA0,
  TO_UPPER_CASE: 0xA4,
  STARTS_WITH: 0xA8,
  ENDS_WITH: 0xAC,
  REPEAT: 0xB0,
  PAD_START: 0xB4,
  PAD_END: 0xB8,
  REPLACE: 0xBC,
  REPLACE_ALL: 0x2EC,
  TRIM_START: 0x2F0,
  TRIM_END: 0x2F4,
  STRING_LAST_INDEX_OF: 0x2F8,
  STRING_AT: 0x2FC,
  STRING_CONCAT: 0x328,        // continues past the 0x300-0x327 diagnostics block

  // Literal strings for type conversion (0xC0 - 0xDF)
  LIT_NULL: 0xC0,              // "null"
  LIT_TRUE: 0xC4,              // "true"
  LIT_FALSE: 0xC8,             // "false"
  LIT_OBJECT_OBJECT: 0xCC,     // "[object Object]"
  LIT_NAN: 0xD0,               // "NaN"
  LIT_INFINITY: 0xD4,          // "Infinity"
  LIT_NEG_INFINITY: 0xD8,      // "-Infinity"
  LIT_OBJECT_FUNCTION: 0xDC,   // "[object Function]"
  LIT_EMPTY_STRING: 0xE0,      // ""

  // Math methods (0x100 - 0x13F)
  MATH_ABS: 0x100,
  MATH_FLOOR: 0x104,
  MATH_CEIL: 0x108,
  MATH_ROUND: 0x10C,
  MATH_MIN: 0x110,
  MATH_MAX: 0x114,
  MATH_POW: 0x118,
  MATH_SQRT: 0x11C,
  MATH_RANDOM: 0x120,

  // Prototype chain related (0x140+)
  PROTOTYPE: 0x140,           // "prototype"
  CONSTRUCTOR: 0x144,         // "constructor"
  HAS_OWN_PROPERTY: 0x148,    // "hasOwnProperty"
  GET_PROTOTYPE_OF: 0x14C,    // "getPrototypeOf"
  NAME: 0x150,                // "name"
  MESSAGE: 0x154,             // "message"

  TO_STRING_NAME: 0x158,      // "toString" (method name string)

  // Error type names (0x160+)
  LIT_ERROR: 0x160,           // "Error"
  LIT_TYPE_ERROR: 0x164,      // "TypeError"
  LIT_REFERENCE_ERROR: 0x168, // "ReferenceError"
  LIT_GRANT_DENIED_ERROR: 0x16C, // "GrantDeniedError"
  LIT_RANGE_ERROR: 0x170,        // "RangeError"

  // ArrayBuffer/Uint8Array property names (0x174+)
  BYTE_LENGTH: 0x174,            // "byteLength"
  BYTE_OFFSET: 0x178,            // "byteOffset"
  BUFFER: 0x17C,                 // "buffer"

  // Uint8Array methods (0x180+)
  SUBARRAY: 0x180,               // "subarray"
  FILL: 0x184,                   // "fill"
  SET: 0x188,                    // "set"
  COPY_WITHIN: 0x18C,            // "copyWithin"
  LAST_INDEX_OF: 0x190,          // "lastIndexOf"
  REDUCE_RIGHT: 0x194,           // "reduceRight"
  FROM: 0x198,                   // "from"
  OF: 0x19C,                     // "of"

  // DataView (0x1A0+)
  DATA_VIEW: 0x1A0,              // "DataView" constructor name
  GET_INT8: 0x1A4,
  GET_UINT8: 0x1A8,
  GET_INT16: 0x1AC,
  GET_UINT16: 0x1B0,
  GET_INT32: 0x1B4,
  GET_UINT32: 0x1B8,
  GET_FLOAT32: 0x1BC,
  GET_FLOAT64: 0x1C0,
  SET_INT8: 0x1C4,
  SET_UINT8: 0x1C8,
  SET_INT16: 0x1CC,
  SET_UINT16: 0x1D0,
  SET_INT32: 0x1D4,
  SET_UINT32: 0x1D8,
  SET_FLOAT32: 0x1DC,
  SET_FLOAT64: 0x1E0,

  // Typed array constructor names (0x1E4+)
  INT8ARRAY: 0x1E4,
  UINT8CLAMPEDARRAY: 0x1E8,
  INT16ARRAY: 0x1EC,
  UINT16ARRAY: 0x1F0,
  INT32ARRAY: 0x1F4,
  UINT32ARRAY: 0x1F8,
  FLOAT32ARRAY: 0x1FC,
  FLOAT64ARRAY: 0x200,
  BYTES_PER_ELEMENT: 0x204,

  // BigInt typed array constructor names
  BIGINT64ARRAY: 0x218,
  BIGUINT64ARRAY: 0x21C,

  // Promise methods (0x208+)
  THEN: 0x208,                   // "then"
  CATCH: 0x20C,                  // "catch"
  FINALLY: 0x210,                // "finally"

  // Typeof bigint (0x214)
  TYPEOF_BIGINT: 0x214,          // "bigint"
  // Typeof symbol (0x290)
  TYPEOF_SYMBOL: 0x290,          // "symbol"

  // Symbol property / method names
  SYMBOL_DESCRIPTION: 0x294,     // "description" — Symbol.prototype.description
  SYMBOL_LIT_PREFIX: 0x298,      // "Symbol(" — toString prefix
  SYMBOL_LIT_SUFFIX: 0x29C,      // ")" — toString suffix
  SYMBOL_LIT_EMPTY: 0x2A0,       // "Symbol()" — toString for undescribed

  // Expression head names — interned so WAT sugar builtins
  // can look up the registry entry without re-interning on every call.
  EXPRESSION_HEAD_ADD:      0x2A4,
  EXPRESSION_HEAD_SUBTRACT: 0x2A8,
  EXPRESSION_HEAD_MULTIPLY: 0x2AC,
  EXPRESSION_HEAD_DIVIDE:   0x2B0,
  EXPRESSION_HEAD_POWER:    0x2B4,
  EXPRESSION_HEAD_NEGATE:   0x2B8,

  // Exact.typeOf('expression') fine-grained tag
  EXACT_TYPEOF_EXPRESSION:  0x2BC,

  // Error message builtins (0x220+)
  MSG_NOT_A_FUNCTION: 0x220,         // "Not a function"
  MSG_PROPERTY_OF_NULL: 0x224,       // "Cannot read property of null"
  MSG_PROPERTY_OF_UNDEFINED: 0x228,  // "Cannot read property of undefined"
  MSG_OUT_OF_BOUNDS: 0x22C,          // "Offset is outside the bounds of the DataView"
  MSG_INVALID_ARRAY_LENGTH: 0x230,   // "Invalid array length"
  MSG_NOT_AN_OBJECT: 0x234,          // "Not an object"
  MSG_NOT_DEFINED: 0x238,            // "Not defined"
  MSG_MIXED_BIGINT: 0x23C,           // "Cannot mix BigInt and other types"
  MSG_FROZEN_OBJECT: 0x240,          // "Cannot modify frozen object"

  // Error context property names (0x244+)
  PROP_OFFSET: 0x244,                // "offset"
  PROP_BUFFER_LENGTH: 0x248,         // "bufferLength"
  PROP_ELEMENT_SIZE: 0x24C,          // "elementSize"
  PROP_TYPE: 0x250,                  // "type"
  PROP_IDENTIFIER: 0x254,            // "identifier"

  // Exact.typeOf fine-grained type name strings (0x258+)
  EXACT_TYPEOF_INTEGER: 0x258,       // "integer"
  EXACT_TYPEOF_RATIONAL: 0x25C,      // "rational"
  EXACT_TYPEOF_COMPLEX: 0x260,       // "complex"
  EXACT_TYPEOF_FLOAT: 0x264,         // "float"

  // Exact.toString literal fragments (0x268+)
  EXACT_SLASH: 0x268,                // "/"
  EXACT_IMAGINARY_UNIT: 0x26C,       // "i"
  EXACT_NEG_IMAGINARY_UNIT: 0x270,   // "-i"
  EXACT_PLUS_SEP: 0x274,             // " + "
  EXACT_MINUS_SEP: 0x278,            // " - "
  EXACT_ZERO: 0x27C,                 // "0"

  // JSON tagged-object prefixes for exact types (0x280+)
  JSON_RATIONAL_PREFIX: 0x280,       // '{"$rational":"'
  JSON_COMPLEX_PREFIX: 0x284,        // '{"$complex":"'
  JSON_BIGINT_PREFIX: 0x288,         // '{"$bigint":"'
  JSON_TAGGED_SUFFIX: 0x28C,         // '"}'

  // Hidden property names used by built-in iterator objects (0x2C0+)
  ITER_HIDDEN_ARRAY: 0x2C0,          // "@array"
  ITER_HIDDEN_INDEX: 0x2C4,          // "@index"
  ITER_HIDDEN_STRING: 0x2C8,         // "@string"
  ITER_HIDDEN_BYTE_OFFSET: 0x2CC,    // "@byteOffset"
  ITER_HIDDEN_BUFFER: 0x2D0,         // "@buffer"
  ITER_NEXT_KEY: 0x2D4,              // "next" — the key for .next on iterator objects
  ITER_VALUE_KEY: 0x2D8,             // "value" — for the result object
  ITER_DONE_KEY: 0x2DC,              // "done" — for the result object

  // Map/Set property names (0x2E0+)
  MAP_SIZE: 0x2E0,                   // "size"
  ITER_HIDDEN_COLL: 0x2E4,           // "@coll" — iterator's source collection
  ITER_HIDDEN_KIND: 0x2E8,           // "@kind" — iterator kind (0=keys, 1=values, 2=entries)

  // btoa / atob (0x300+). InvalidCharacterError matches the DOMException
  // name JavaScript throws from btoa/atob; this runtime has no DOMException,
  // so the thrown object is a plain Error with an own `name` property.
  LIT_INVALID_CHARACTER_ERROR: 0x300,  // "InvalidCharacterError"
  MSG_BTOA_INVALID_CHARACTER: 0x304,   // btoa Latin1-range message
  MSG_ATOB_INVALID_CHARACTER: 0x308,   // atob invalid-base64 message
  MSG_MISSING_ARGUMENT: 0x30C,         // "1 argument required, but only 0 present."
  MSG_CANNOT_CONVERT_TO_NUMBER: 0x310, // "Cannot convert to a number"
  PROP_VALUE_LO: 0x314,                // "valueLo" — offending value's data_lo on type errors
  PROP_VALUE_FLAGS: 0x318,             // "valueFlags" — offending value's flags word
  PROP_VALUE_HI: 0x31C,                // "valueHi" — offending value's data_hi
  PROP_VALUE_ADDR: 0x320,              // "valueAddr" — segment address of the offending value slot
  PROP_STACK_BASE: 0x324,              // "stackBase" — CTX pending base at throw time
  // 0x328 = STRING_CONCAT (string methods block above)
  MSG_ACCESSOR_UNSUPPORTED: 0x32C,     // getter/setter property hit by an operation that can't invoke it yet
  SETLIKE_HAS: 0x330,                  // "has" — Set-like protocol lookup for the set-theoretic methods
  SETLIKE_KEYS: 0x334,                 // "keys" — Set-like protocol lookup
  MSG_NOT_ITERABLE: 0x338,             // "Not iterable" — for-of / destructuring / spread of a non-iterable
  MSG_DETACHED_CALLBACK: 0x33C,        // callback arguments need the method-call form (detached Array.from mapFn)
  FROM_ENTRIES: 0x340,                 // "fromEntries"
  TO_FIXED: 0x344,                     // "toFixed"
  MSG_INVALID_RADIX: 0x348,            // "toString() radix must be between 2 and 36"
  MSG_INVALID_FRACTION_DIGITS: 0x34C,  // "toFixed() digits must be between 0 and 100"

  // Symbol.toStringTag whole-literal tags for the built-in types
  // (zero-allocation fast paths), plus the two fragments the user-tag
  // path concatenates around the tag string.
  LIT_OBJECT_PREFIX: 0x350,            // "[object "
  LIT_CLOSE_BRACKET: 0x354,            // "]"
  LIT_OBJECT_MAP: 0x358,               // "[object Map]"
  LIT_OBJECT_SET: 0x35C,               // "[object Set]"
  LIT_OBJECT_ARRAY: 0x360,             // "[object Array]"
  LIT_OBJECT_UNDEFINED: 0x364,         // "[object Undefined]"
  LIT_OBJECT_NULL: 0x368,              // "[object Null]"
  LIT_OBJECT_BOOLEAN: 0x36C,           // "[object Boolean]"
  LIT_OBJECT_NUMBER: 0x370,            // "[object Number]"
  LIT_OBJECT_STRING: 0x374,            // "[object String]"
  LIT_OBJECT_PROMISE: 0x378,           // "[object Promise]"

  // Object.getOwnPropertyDescriptor descriptor property names.
  // 'value' reuses ITER_VALUE_KEY.
  WRITABLE: 0x37C,                     // "writable"
  ENUMERABLE: 0x380,                   // "enumerable"
  CONFIGURABLE: 0x384,                 // "configurable"
  GET_KEY: 0x388,                      // "get"
  SET_KEY: 0x38C,                      // "set"

  // Generator-object hidden state keys
  // (memory-resident so parked generators survive snapshot/restore) and
  // the method-name strings not already interned.
  GENERATOR_CONTEXT_KEY: 0x390,        // "@generatorContext" — context slot (-1 once completed)
  GENERATOR_STATE_KEY: 0x394,          // "@generatorState" — 0 start / 1 yield / 2 running / 3 completed
  GENERATOR_CALLER_KEY: 0x398,         // "@generatorCaller" — parked caller slot (-1 = none)
  RETURN_KEY: 0x39C,                   // "return"
  THROW_KEY: 0x3A0,                    // "throw"
  MSG_GENERATOR_SEED: 0x3A4,           // RETIRED (seed drivers drive generators natively now); slot kept, id space is positional

  // Function.prototype method names.
  CALL_NAME: 0x3A8,                    // "call"
  APPLY_NAME: 0x3AC,                   // "apply"
  BIND_NAME: 0x3B0,                    // "bind"
  MSG_FUNCTION_METHOD_UNSUPPORTED: 0x3B4, // call/apply/bind unsupported form

  // Async-generator hidden keys on the generator object and its queued
  // request records. The step-promise key doubles as the async marker —
  // its PRESENCE on a generator object is what routes the host adapter
  // to the promise-based
  // protocol. All of this state is memory-resident so parked async
  // generators (and their request queues) survive snapshot/restore.
  ASYNC_GENERATOR_STEP_PROMISE_KEY: 0x3B8, // "@asyncGeneratorStepPromise" — promise of the in-service request (INTEGER 0 = none)
  ASYNC_GENERATOR_QUEUE_KEY: 0x3BC,        // "@asyncGeneratorQueue" — head of the queued-request list (INTEGER 0 = empty)
  REQUEST_OPERATION_KEY: 0x3C0,            // "@requestOperation" — 0 next / 1 return / 2 throw
  REQUEST_VALUE_KEY: 0x3C4,                // "@requestValue" — the sent / returned / thrown value
  REQUEST_PROMISE_KEY: 0x3C8,              // "@requestPromise" — this request's step promise
  REQUEST_NEXT_KEY: 0x3CC,                 // "@requestNext" — next queued request (INTEGER 0 = tail)

  // Error.prototype.toString() formatting.
  LIT_COLON_SPACE: 0x3D0,                  // ": " — joins name and message

  // Array/TypedArray prototype method names
  FIND_LAST: 0x3D4,                        // "findLast"
  FIND_LAST_INDEX: 0x3D8,                  // "findLastIndex"
  VALUES: 0x3DC,                           // "values" ("keys" already exists as SETLIKE_KEYS)
  ENTRIES: 0x3E0,                          // "entries"
  TO_REVERSED: 0x3E4,                      // "toReversed"
  TO_SORTED: 0x3E8,                        // "toSorted"
  WITH_NAME: 0x3EC,                        // "with"
  TO_SPLICED: 0x3F0,                       // "toSpliced"
  MSG_INVALID_INDEX: 0x3F4,                // "Invalid index" — with() out of bounds
  TO_LOCALE_STRING: 0x3F8,                 // "toLocaleString" — resolves to the toString
                                           // method ids (the sandbox has no locales; the
                                           // default-locale number output is toString's)

  // Exact.Matrix type tag and construction errors (0x3FC+)
  EXACT_TYPEOF_MATRIX: 0x3FC,              // "matrix" — Exact.typeOf tag
  MSG_MATRIX_ROWS_NOT_ARRAY: 0x400,        // make/fromColumns input shape error
  MSG_MATRIX_RAGGED: 0x404,                // rows of differing lengths
  MSG_MATRIX_ENTRY_TYPE: 0x408,            // disallowed entry type
  MSG_MATRIX_NOT_MATRIX: 0x40C,            // matrix-taking builtin got a non-Matrix
  MSG_MATRIX_DIMENSION: 0x410,             // dimension not a non-negative integer
  MSG_MATRIX_INDEX: 0x414,                 // get(M, i, j) out of bounds

  // Conjugate head and element-wise matrix error messages
  EXPRESSION_HEAD_CONJUGATE: 0x418,        // "Conjugate"
  MSG_MATRIX_SHAPE_MISMATCH: 0x41C,        // element-wise op shape mismatch
  MSG_MATRIX_SCALE_SCALAR: 0x420,          // scale's k not scalar (or non-1x1 Matrix)

  // Matrix multiplication and linear-algebra error messages
  MSG_MATRIX_NOT_SQUARE: 0x424,            // trace/determinant on non-square

  // Matrix inverse / solve error messages
  MSG_MATRIX_SINGULAR: 0x428,              // inverse of a singular matrix

  // Equal / NotEqual heads and match error messages
  EXPRESSION_HEAD_EQUAL: 0x434,            // "Equal"
  EXPRESSION_HEAD_NOT_EQUAL: 0x438,        // "NotEqual"
  MSG_MATCH_VARIABLES: 0x43C,              // match: variables argument shape
  MSG_MATCH_VARIABLE_ABSENT: 0x440,        // match: listed variable not in pattern


  // Determinant / Rank heads and rewrite error messages
  EXPRESSION_HEAD_DETERMINANT: 0x4A0,      // "Determinant"
  EXPRESSION_HEAD_RANK: 0x4A4,             // "Rank"

  // Exact.AlgebraicNumber typeOf tag, error messages, toString fragments,
  // and JSON tagged-object pieces.
  EXACT_TYPEOF_ALGEBRAIC: 0x4B0,           // "algebraic"
  MSG_ALGEBRAIC_NOT_POLYNOMIAL: 0x4B4,     // rootsOfPolynomial: not a polynomial in the variable
  MSG_ALGEBRAIC_COEFFICIENT_TYPE: 0x4B8,   // rootsOfPolynomial: coefficient outside the rational universe
  MSG_ALGEBRAIC_VARIABLE: 0x4BC,           // rootsOfPolynomial: variable must be a Symbol
  MSG_ALGEBRAIC_FROM_EXPRESSION: 0x4C0,    // fromExpression: unsupported head / non-numeric leaf
  MSG_ALGEBRAIC_ARGUMENT: 0x4C4,           // compare/equals/sign/isZero/toApproximation argument type
  MSG_ALGEBRAIC_DIVIDE_BY_ZERO: 0x4C8,     // fromExpression: division by zero (RangeError)
  MSG_ALGEBRAIC_WIDTH: 0x4CC,              // toApproximation: widthExponent must be an integer
  MSG_ALGEBRAIC_ZERO_POLYNOMIAL: 0x4D0,    // rootsOfPolynomial: the zero polynomial has no root set
  ALGEBRAIC_TOSTRING_PREFIX: 0x4D4,        // "algebraic("
  EXACT_VARIABLE_X: 0x4D8,                 // "x"
  EXACT_CARET: 0x4DC,                      // "^"
  EXACT_OPEN_PAREN: 0x4E0,                 // "("
  EXACT_CLOSE_PAREN: 0x4E4,                // ")"
  EXACT_COMMA_SEP: 0x4E8,                  // ", "
  JSON_ALGEBRAIC_PREFIX: 0x4EC,            // '{"$algebraic":{"definingPolynomial":['
  JSON_ALGEBRAIC_MIDDLE: 0x4F0,            // '],"isolatingInterval":['
  JSON_ALGEBRAIC_SUFFIX: 0x4F4,            // ']}}'
  JSON_QUOTE: 0x4F8,                       // '"'
  JSON_QUOTE_COMMA_QUOTE: 0x4FC,           // '","'
  MSG_ALGEBRAIC_DEGREE: 0x500,             // rootsOfPolynomial: degree too large (i32-arithmetic shield, loud)
  EXACT_MINUS: 0x504,                      // "-" (leading negative-term sign)
  MSG_ALGEBRAIC_ROOT_DOMAIN: 0x508,        // even root of a negative value (RangeError)
  MSG_ALGEBRAIC_ROOT_INDEX: 0x50C,         // nthRoot index must be a positive integer
  MSG_ALGEBRAIC_EXPONENT: 0x510,           // fromExpression rational exponent out of range
  MSG_ALGEBRAIC_MULTI_COEFFICIENT: 0x514,  // retired: multivariate coefficients now succeed; offset kept allocated and string left interned for stale bytecode
  MSG_ALGEBRAIC_TURNS: 0x518,              // cosineOfTurns/sineOfTurns: argument must be rational turns
  MSG_ALGEBRAIC_TOO_MANY_VARIABLES: 0x51C, // rootsOfPolynomial/resultant: too many distinct algebraic values in one expression (successive-norms cost shield)
  MSG_ALGEBRAIC_TOO_MANY_FACTORS: 0x520,   // rootsOfPolynomial/resultant: a single coefficient term has too many distinct algebraic factors
  MSG_EXPRESSION_BINARY_ARITY: 0x524,      // Expression.add/subtract/multiply/divide/power require exactly 2 arguments
  MSG_ALGEBRAIC_DISAMBIGUATION_LIMIT: 0x528, // algebraic_compose_binary: root-selection did not converge within the round cap
  MSG_ALGEBRAIC_PRIMITIVE_ELEMENT_SHIFT_LIMIT: 0x52C, // rootsOfPolynomial: primitive-element shift-multiplier search exceeded its bound
  EXACT_TYPEOF_COMPLEX_ALGEBRAIC: 0x530,    // "complexAlgebraic"
  COMPLEX_ALGEBRAIC_TOSTRING_PREFIX: 0x534, // "complexAlgebraic("
  JSON_COMPLEX_ALGEBRAIC_PREFIX: 0x538,     // '{"$complexAlgebraic":{"realPart":'
  JSON_COMPLEX_ALGEBRAIC_MIDDLE: 0x53C,     // ',"imaginaryPart":'
  JSON_COMPLEX_ALGEBRAIC_SUFFIX: 0x540,     // '}}'
  MSG_GROEBNER_EXPONENT_RANGE: 0x544,       // groebnerBasis/polynomialReduce: exponent exceeds unsigned sparse-cell range
  LIT_SYNTAX_ERROR: 0x548,                // "SyntaxError"
  BIGINT_AS_INT_N: 0x54C,                 // "asIntN"
  BIGINT_AS_UINT_N: 0x550,                // "asUintN"
  VALUE_OF: 0x554,                       // "valueOf"

  // RegExp property and method names. Instances are TYPE_REGEXP primitives:
  // GET_PROP resolves these directly against the descriptor, like the
  // TYPE_STRING arm.
  SOURCE: 0x558,                          // "source"
  FLAGS: 0x55C,                           // "flags"
  GLOBAL: 0x560,                          // "global"
  IGNORE_CASE: 0x564,                     // "ignoreCase"
  MULTILINE: 0x568,                       // "multiline"
  DOT_ALL: 0x56C,                         // "dotAll"
  HAS_INDICES: 0x570,                     // "hasIndices"
  STICKY: 0x574,                          // "sticky"
  LAST_INDEX: 0x578,                      // "lastIndex"
  EXEC: 0x57C,                            // "exec"
  TEST: 0x580,                            // "test"
  // "(?:)" — what an empty-source RegExp stringifies as (matches JS, so
  // the rendered form re-reads as a regex literal instead of a comment).
  LIT_REGEXP_EMPTY_SOURCE: 0x584,
  MSG_REGEXP_PATTERN: 0x588,              // "RegExp pattern must be a string or RegExp"
  MSG_REGEXP_FLAGS: 0x58C,                // "RegExp flags must be a string"
  MSG_REGEXP_LAST_INDEX: 0x590,           // "lastIndex must be a non-negative integer"
  // Match-result property names (exec's array metadata) and the
  // receiver guard message for detached exec/test calls.
  MATCH_INDEX: 0x594,                     // "index"
  MATCH_INPUT: 0x598,                     // "input"
  MATCH_GROUPS: 0x59C,                    // "groups"
  MATCH_INDICES: 0x5A0,                   // "indices"
  MSG_REGEXP_RECEIVER: 0x5A4,             // "RegExp exec/test require a RegExp receiver"
  // RegExp string-method names, the matchAll iterator's hidden slots, and
  // the explicit flag-validation messages.
  MATCH: 0x5A8,                           // "match"
  MATCH_ALL: 0x5AC,                       // "matchAll"
  SEARCH: 0x5B0,                          // "search"
  ITER_HIDDEN_REGEXP: 0x5B4,              // "@regexp" — matchAll iterator's cloned RegExp
  ITER_HIDDEN_DONE: 0x5B8,                // "@done" — matchAll iterator exhaustion flag
  MSG_MATCHALL_GLOBAL: 0x5BC,             // "matchAll requires a global RegExp"
  MSG_REPLACEALL_GLOBAL: 0x5C0,           // "replaceAll requires a global RegExp"
  NEW_TARGET: 0x5C4,                      // "@newtarget" — hidden scope binding; every non-arrow invocation defines it (undefined for calls, the callee for constructs, the propagated value for super() calls); arrows inherit it lexically like `this`
  MSG_NOT_EXTENSIBLE: 0x5C8,              // "This built-in cannot be extended"
  MSG_PRIVATE_NOT_DECLARED: 0x5CC,        // "Private member is not declared on the receiver"
  // External-backed instances (BUILTIN v6): branded-instance hidden key and
  // external link/construction diagnostics.
  EXTERNAL_BACKING: 0x5D0,                // "@externalBacking" — hidden own key holding the backing external handle
  MSG_EXTERNAL_NOT_EXTENDABLE: 0x5D4,     // "This external cannot be extended"
  MSG_CONSTRUCTION_NO_BACKING: 0x5D8,     // "Construction returned no backing value"
  MSG_CONSTRUCTOR_DIFFERENT_OBJECT: 0x5DC, // "Constructor returned a different object"
  MSG_RECEIVER_ALREADY_INITIALIZED: 0x5E0, // "Receiver is already initialized"
  MSG_ILLEGAL_CONSTRUCTOR: 0x5E4,         // "Illegal constructor"
  // Construction-protocol method names (unspellable in source — the host
  // adapter dispatches them to the constructible registration, never to host
  // method handlers) and the per-instance abort-chain slot.
  CONSTRUCT_BEGIN: 0x5E8,                 // "@beginConstruction"
  CONSTRUCT_COMPLETE: 0x5EC,              // "@completeConstruction"
  CONSTRUCT_ABORT: 0x5F0,                 // "@abortConstruction"
  CONSTRUCTION_LINK: 0x5F4,               // "@constructionLink" — abort-duty chain (TYPE_OBJECT next receiver, or undefined)
  // Exact.Expression transcendental heads and diagnostics.
  EXPRESSION_HEAD_EXP: 0x5F8,              // "Exp"
  EXPRESSION_HEAD_LOG: 0x5FC,              // "Log"
  MSG_EXPRESSION_UNARY_ARITY: 0x600,       // unary transcendental constructor arity
  MSG_EXPRESSION_APPROXIMATION: 0x604,     // unsupported/non-real expression approximation
  EXACT_CONSTANT_PI: 0x608,                 // "Pi"

  // Symbolic calculus: ordering relation heads, derivative record keys,
  // and diagnostics.
  EXPRESSION_HEAD_LESS: 0x60C,             // "Less"
  EXPRESSION_HEAD_LESS_EQUAL: 0x610,       // "LessEqual"
  EXPRESSION_HEAD_GREATER: 0x614,          // "Greater"
  EXPRESSION_HEAD_GREATER_EQUAL: 0x618,    // "GreaterEqual"
  MSG_DERIVATIVE_UNSUPPORTED_HEAD: 0x61C,  // derivative: no rule for head (prefix)
  MSG_DERIVATIVE_ARGUMENTS: 0x620,         // derivative-family argument validation
  MSG_TAYLOR_ORDER: 0x624,                 // taylor: order validation / resource bound
  KEY_EXPRESSION: 0x628,                   // "expression"
  KEY_CONDITIONS: 0x62C,                   // "conditions"
  KEY_EXPRESSIONS: 0x630,                  // "expressions"
  KEY_MATRIX: 0x634,                       // "matrix"
  KEY_POLYNOMIAL: 0x638,                   // "polynomial"
  KEY_VARIABLE: 0x63C,                     // "variable"
  KEY_POINT: 0x640,                        // "point"
  KEY_ORDER: 0x644,                        // "order"

  // Exact solving and factorization: record keys, tagged-kind literals,
  // and diagnostics.
  KEY_UNIT: 0x648,                         // "unit"
  KEY_FACTORS: 0x64C,                      // "factors"
  KEY_KIND: 0x650,                         // "kind"
  KEY_SOLUTION: 0x654,                     // "solution"
  KEY_PARTICULAR: 0x658,                   // "particular"
  KEY_BASIS: 0x65C,                        // "basis"
  KEY_LOWER: 0x660,                        // "lower"
  KEY_LOWER_CLOSED: 0x664,                 // "lowerClosed"
  KEY_UPPER: 0x668,                        // "upper"
  KEY_UPPER_CLOSED: 0x66C,                 // "upperClosed"
  KEY_SIGN: 0x670,                         // "sign"
  KEY_INTERVAL: 0x674,                     // "interval"
  KEY_ROOT: 0x678,                         // "root"
  KEY_MULTIPLICITY: 0x67C,                 // "multiplicity"
  LIT_SOLVE_UNIQUE: 0x680,                 // "unique"
  LIT_SOLVE_NONE: 0x684,                   // "none"
  LIT_SOLVE_FAMILY: 0x688,                 // "family"
  MSG_SOLVING_ARGUMENTS: 0x68C,            // solving surface argument validation
  MSG_SOLVING_UNSUPPORTED: 0x690,          // unsupported expression class
  MSG_SOLVING_POSITIVE_DIMENSIONAL: 0x694, // solveSystem: positive-dimensional system

  // Verified symbolic integration.
  EXPRESSION_HEAD_INTEGRAL: 0x698,         // "Integral"
  LIT_INTEGRAL_VERIFIED: 0x69C,            // "verified"
  LIT_INTEGRAL_UNEVALUATED: 0x6A0,         // "unevaluated"
  MSG_INTEGRAL_ARGUMENTS: 0x6A4,           // integration surface argument validation

  // Schema (VERSION.BUILTIN v7): global surface, option/result keys,
  // dialect literals, and the validation-message templates (SM_*).
  COMPILE: 0x6A8,                            // 'compile'
  VALIDATE: 0x6AC,                           // 'validate'
  ASSERT: 0x6B0,                             // 'assert'
  ERRORS: 0x6B4,                             // 'errors'
  IS_SCHEMA: 0x6B8,                          // 'isSchema'
  FORMATS: 0x6BC,                            // 'formats'
  KEY_SCHEMA: 0x6C0,                         // 'schema'
  KEY_DIALECT: 0x6C4,                        // 'dialect'
  KEY_VALID: 0x6C8,                          // 'valid'
  KEY_ERROR_COUNT: 0x6CC,                    // 'errorCount'
  KEY_SCHEMAS: 0x6D0,                        // 'schemas'
  KEY_BASE_URI: 0x6D4,                       // 'baseUri'
  KEY_STRICT: 0x6D8,                         // 'strict'
  KEY_MAX_DEPTH: 0x6DC,                      // 'maxDepth'
  KEY_MAX_ERRORS: 0x6E0,                     // 'maxErrors'
  KEY_ARENA_BYTES: 0x6E4,                    // 'arenaBytes'
  LIT_ANNOTATE: 0x6E8,                       // 'annotate'
  LIT_DIALECT_2020: 0x6EC,                   // '2020-12'
  LIT_DIALECT_2019: 0x6F0,                   // '2019-09'
  LIT_DIALECT_07: 0x6F4,                     // 'draft-07'
  LIT_DIALECT_06: 0x6F8,                     // 'draft-06'
  LIT_DIALECT_04: 0x6FC,                     // 'draft-04'
  KEY_DOLLAR_SCHEMA: 0x700,                  // '$schema'
  KEY_KEYWORD: 0x704,                        // 'keyword'
  KEY_PARAMS: 0x708,                         // 'params'
  KEY_TYPE: 0x70C,                           // 'type'
  KEY_LIMIT: 0x710,                          // 'limit'
  KEY_COMPARISON: 0x714,                     // 'comparison'
  KEY_MULTIPLE_OF: 0x718,                    // 'multipleOf'
  KEY_MISSING_PROPERTY: 0x71C,               // 'missingProperty'
  KEY_PROPERTY: 0x720,                       // 'property'
  KEY_I: 0x724,                              // 'i'
  KEY_J: 0x728,                              // 'j'
  KEY_MIN_CONTAINS: 0x72C,                   // 'minContains'
  KEY_MAX_CONTAINS: 0x730,                   // 'maxContains'
  KEY_PATTERN: 0x734,                        // 'pattern'
  KEY_FORMAT: 0x738,                         // 'format'
  MSG_SCHEMA_SOURCE: 0x73C,                  // 'Schema requires an object or boolean schema'
  MSG_SCHEMA_OPTIONS: 0x740,                 // 'Schema options must be an object'
  MSG_SCHEMA_RECEIVER: 0x744,                // 'Schema methods require a Schema receiver'
  MSG_SCHEMA_ASSERT: 0x748,                  // 'value does not match schema'
  MSG_SCHEMA_INVALID: 0x74C,                 // 'invalid schema'
  MSG_SCHEMA_BUNDLE: 0x750,                  // 'Schema options.schemas must be an array of [uri, schema] pairs'
  MSG_SCHEMA_LIMIT: 0x754,                   // 'Schema limit exceeded'
  // 0x758..0x7E0 reserved: retired consumer-side schema message fragments.
  // Keep the gap and BUILTINS_SIZE for durable snapshots; later offsets do
  // not move. Fresh cells are zero; old snapshots may retain live string ids.
  KEY_DIAGNOSTIC: 0x7E4,                     // 'diagnostic'
  COMPILE_SET: 0x7E8,                        // 'compileSet'
  LIT_SET: 0x7EC,                            // 'set'
  MSG_SCHEMA_SET_METHOD: 0x7F0,              // 'a schema set has match(value), matchAll(value), and test(value, index)'
  MSG_SCHEMA_ROUTE_INDEX: 0x7F4,             // 'route index out of range'
  MSG_SCHEMA_SET_SOURCE: 0x7F8,              // 'Schema.compileSet requires an array of schemas'
};

// Frame layout (60 bytes)
// Base frame fields:
// Note: CODE_BLOCK removed in v6 - only one code block per session
export const FRAME = {
  INSTRUCTION_INDEX: 0x00, // return instruction index
  SCOPE_POINTER: 0x04,   // scope for this frame
  PENDING_POINTER: 0x08, // pending stack pointer to restore on return
  PENDING_COUNT: 0x0C,   // expected return values
  FLAGS: 0x10,           // TAIL_CALL, NATIVE_CONTINUATION, etc.
  AST_NODE: 0x14,        // offset into AST region (0 = no attribution; for stack traces)
  // Native continuation control fields. The frame owns a single operation-state
  // handle; pointer-bearing values inside that object declare their own masks.
  CONTINUATION_PHASE: 0x18,
  CONTINUATION_STATE_HANDLE: 0x1C,
  CONTINUATION_STATE_1: 0x20,
  CONTINUATION_KIND: 0x24,
  CONTINUATION_STATE_2: 0x28,
  CONTINUATION_CALLBACK: 0x2C, // callback closure HEADER pointer
  CONTINUATION_STATE_3: 0x30,
  CONTINUATION_STATE_4: 0x34,
  ASYNC_PROMISE: 0x34,   // ordinary async-call frame meaning of STATE_4
  // Argument count for this call (written by every call-path site at frame push):
  ARGC: 0x38,            // read by RECONCILE_PARAMS at function body entry
};
export const FRAME_SIZE = 60;

// Try stack entry layout (56 bytes)
// Note: CODE_BLOCK removed in v6 - only one code block per session
export const TRY_ENTRY = {
  CATCH_INDEX: 0x00,     // instruction index for catch, 0 if none
  FINALLY_INDEX: 0x04,   // instruction index for finally, 0 if none
  FRAME_DEPTH: 0x08,     // call stack depth when try was entered
  SCOPE: 0x0C,           // scope pointer when try was entered
  // Layout v9: the pending-stack position at try entry, stored
  // BLOCK-RELATIVE (offset from the pending base — the same
  // relocation-proof discipline as FRAME.PENDING_POINTER). Every
  // abnormal handler entry (throw→catch, throw→finally,
  // return→finally) RESTORES the pending pointer to it, so
  // catch/finally entry depth is statically try-depth(+1 for the
  // pushed error), the unwind path no longer relies on over-popping
  // into the base clamp, and abandoned operands of a throwing
  // expression can't leak past the handler.
  PENDING_POSITION: 0x10,
  // Layout v11: the entry's own pending completion. Entering a handler
  // DISARMS the entry in place (catch entry zeroes CATCH_INDEX; finally
  // entry zeroes both index fields) and, for finally entries, stores the
  // completion that must resume when the finally block ends. FINALLY_END
  // reads the top entry's completion, pops the entry, and re-dispatches.
  // COMPLETION_VALUE holds a 16-byte value slot for THROW (the
  // exception) and RETURN (the return value); for JUMP its lo word is
  // the target instruction index and its hi word is the remaining
  // unwind count. Entries with COMPLETION_THROW / COMPLETION_RETURN are
  // GC roots (both collectors scan them).
  COMPLETION_TYPE: 0x14,
  COMPLETION_VALUE: 0x18, // 0x18..0x27 (16 bytes)
  // Layout v12: the grant-stack DEPTH (entry count) at try entry.
  // Entering the entry's handler (catch, finally divert) and popping
  // the entry (TRY_POP, FINALLY_END, every unwind-walk pop) clamp the
  // grant stack back to this snapshot, so grants pushed inside the try
  // region can never survive an abrupt exit across it — the same
  // save/restore discipline v9 established for the pending position.
  GRANT_DEPTH: 0x28,
  // Layout v17: provenance for catchable engine errors diverted through
  // finally. ERROR_CODE 0 identifies an ordinary language-level throw.
  ERROR_CODE: 0x2C,
  ERROR_DETAIL: 0x30,
  ERROR_INSTRUCTION_INDEX: 0x34,
};
export const TRY_ENTRY_SIZE = 56;

// Grant stack entry layout (32 bytes)
export const GRANT_ENTRY = {
  IDENTIFIER: 0x00,      // 16-byte value slot for grant identifier
  GRANT_ID: 0x10,        // grant ID from host (u32)
  DENIED_ADDR: 0x14,     // instruction index for denied block (0 if none)
  SCOPE_POINTER: 0x18,   // scope pointer when grant was entered
  FRAME_DEPTH: 0x1C,     // call stack depth when grant was entered
};
export const GRANT_ENTRY_SIZE = 32;

// Frame flags
export const FRAME_FLAG_TAIL = 2;
export const FRAME_FLAG_NATIVE_CONTINUATION = 4;
export const FRAME_FLAG_CONSTRUCTOR = 8;
// Discard the callee's return value on RETURN/RETURN_UNDEFINED (accessor
// setter calls: the assignment's result already sits below the frame base).
export const FRAME_FLAG_DISCARD_RESULT = 16;

// Closure flags
export const CLOSURE_FLAG_ARROW = 1;
export const CLOSURE_FLAG_ASYNC = 2;
export const CLOSURE_FLAG_GENERATOR = 4;

// Value size
export const VALUE_SIZE = 16;

// Flag bits for value slots (stored in the 4-byte flags field at offset +4).
// The flags field is shared with scope-entry flags like SCOPE_FLAG_CONST
// (0x01), so value-level flags live in distinct higher bits.
//
// FLAG_RATIONAL_INLINE marks a TYPE.RATIONAL value as carrying an inline
// i64 numerator in [data_lo:4][data_hi:4] with an implicit denominator of 1,
// instead of a heap Rational pointer. Small-integer arithmetic uses this
// representation.
export const FLAG_RATIONAL_INLINE = 0x100;

// Type tags
export const TYPE = {
  NULL: 0x00,
  UNDEFINED: 0x01,
  BOOLEAN: 0x02,
  INTEGER: 0x03,
  FLOAT: 0x04,
  STRING: 0x05,
  ARRAY: 0x06,
  OBJECT: 0x07,
  FUNCTION: 0x08,  // was CLOSURE - functions are callable objects
  SCOPE: 0x09,
  EXTERNAL: 0x0a,
  EXTERNAL_METHOD: 0x0b,  // method reference on external handle (handleId + methodName)
  RATIONAL: 0x0c,         // exact rational number; data_lo = heap header pointer to [numeratorPointer:4][denominatorPointer:4]
  MSGPACK_REF: 0x0d,
  COMPLEX: 0x13,          // exact complex number; data_lo = heap header pointer to [realPointer:4][imaginaryPointer:4] (both Rational)
  BOUND_METHOD: 0x0e,
  CONSTRUCTOR: 0x0f,  // callable object (Array, Object, String, Number)
  ARRAYBUFFER: 0x10,  // ArrayBuffer - owns bytes on heap
  UINT8ARRAY: 0x11,   // Uint8Array - view into ArrayBuffer
  DATAVIEW: 0x12,     // DataView - explicit endianness binary access
  // Additional typed arrays (0x14 - 0x1B)
  INT8ARRAY: 0x14,
  UINT8CLAMPEDARRAY: 0x15,
  INT16ARRAY: 0x16,
  UINT16ARRAY: 0x17,
  INT32ARRAY: 0x18,
  UINT32ARRAY: 0x19,
  FLOAT32ARRAY: 0x1A,
  FLOAT64ARRAY: 0x1B,
  PROMISE: 0x1C,
  BIGINT: 0x1D,
  BIGINT64ARRAY: 0x1E,
  BIGUINT64ARRAY: 0x1F,
  SYMBOL: 0x20,           // JS Symbol; data_lo = heap header pointer to [descriptionStringOffset:4][reserved:4]
  EXPRESSION: 0x21,       // Symbolic Expression; data_lo = heap header pointer to [headPointer:4][argumentArrayPointer:4]
  PROMISE_RESOLVE: 0x22,  // Promise executor's resolve continuation; data_lo = promise data pointer
  PROMISE_REJECT: 0x23,   // Promise executor's reject continuation; data_lo = promise data pointer
  MAP: 0x24,              // ES Map; data_lo = heap header pointer to [size:4][slotCount:4][capacity:4][entriesPointer:4]
  SET: 0x25,              // ES Set; data_lo = heap header pointer to [size:4][slotCount:4][capacity:4][entriesPointer:4]
  ACCESSOR: 0x26,         // getter/setter property value (never user-visible);
                          // data_lo = getter closure header (0 = none),
                          // data_hi = setter closure header (0 = none).
                          // Lives only inside object entries; GET_PROP/SET_PROP
                          // invoke the halves instead of returning the value.
  MATRIX: 0x27,           // Exact/symbolic matrix; data_lo = heap header pointer to
                          // [rowCount:4][columnCount:4][entriesArrayPointer:4][reserved:4]
  THEOREM: 0x28,          // Proof handle; data_lo = heap header pointer to
                          // [artifactBufferDataPointer:4][index:4][kind:4]
                          // [universeOwnerDataPointer:4]. Both data pointers are traced.
  ALGEBRAIC: 0x29,        // Real algebraic number; data_lo = heap header pointer to
                          // [coefficientsArrayPointer:4][intervalArrayPointer:4]
                          // [fieldGeneratorPointer:4][coordinatesArrayPointer:4].
                          // The first pair caches the standalone minimal polynomial
                          // and open isolating interval. The optional second pair
                          // represents A(gamma) in a shared exact number field;
                          // both zero means this value is its own generator with
                          // coordinates [0, 1].
  COMPLEX_ALGEBRAIC: 0x2A, // Exact non-real algebraic number; data_lo =
                           // heap header pointer to [realPointer:4][imaginaryPointer:4].
                           // Both pointers name canonical exact-real heap values.
  REGEXP: 0x2B,            // RegExp; data_lo = heap header pointer to
                           // [patternStringOffset:4][flagsBitfield:4]
                           // [lastIndex:4][programBufferDataPointer:4].
                           // Flags reuse the engine's REGEX_FLAG bits
                           // (regex-engine-contract.js); lastIndex counts
                           // Unicode scalar values; the program pointer is a
                           // DATA pointer to an OBJ.ARRAYBUFFER holding the
                           // validated engine program, zero until
                           // compilation commits.
  SCHEMA: 0x2D,            // Compiled JSON Schema; data_lo = heap header
                           // pointer to an OBJ.SCHEMA descriptor (see SCHEMA).
  PROOF_NAMESPACE: 0x2C,   // Proof kernel native namespace (Proof, Proof.Nat,
                           // …); data_lo = kernel namespace id, no heap
                           // payload. Renumbered from an UNREGISTERED 0x2B in
                           // proof-kernel.wat that silently collided with
                           // REGEXP once 0x2B was allocated here — the layout
                           // verifier now scans every concatenated WAT so a
                           // type id can no longer be taken without a row in
                           // this registry.
};

// Helper to check if a type is a typed array
export function isTypedArrayType(type) {
  return type === TYPE.UINT8ARRAY ||
         (type >= TYPE.INT8ARRAY && type <= TYPE.FLOAT64ARRAY) ||
         type === TYPE.BIGINT64ARRAY || type === TYPE.BIGUINT64ARRAY;
}

// Helper to get BYTES_PER_ELEMENT for a typed array type
export function getBytesPerElement(type) {
  switch (type) {
    case TYPE.INT8ARRAY:
    case TYPE.UINT8ARRAY:
    case TYPE.UINT8CLAMPEDARRAY:
      return 1;
    case TYPE.INT16ARRAY:
    case TYPE.UINT16ARRAY:
      return 2;
    case TYPE.INT32ARRAY:
    case TYPE.UINT32ARRAY:
    case TYPE.FLOAT32ARRAY:
      return 4;
    case TYPE.FLOAT64ARRAY:
    case TYPE.BIGINT64ARRAY:
    case TYPE.BIGUINT64ARRAY:
      return 8;
    default:
      return 0;
  }
}

// GC object types
export const OBJ = {
  ARRAY: 0,
  OBJECT: 1,
  SCOPE: 2,
  FUNCTION: 3,  // was CLOSURE
  PARAM_LIST: 4,
  ARRAY_DATA: 5,
  CODE_BLOCK: 6,
  OBJECT_DATA: 7,  // Entries block for objects (like ARRAY_DATA for arrays)
  ARRAYBUFFER: 8,  // ArrayBuffer heap object (length + raw bytes)
  SCOPE_ENTRIES: 9,  // Entries block for scopes (20-byte entries, not 16-byte values)
  TYPED_ARRAY_DESCRIPTOR: 10,  // TypedArray descriptor [bufferPtr:4][byteOffset:4][length:4][sym_entries:4]
  PROMISE: 11,  // Promise [status:4][value:16][waiters:4][handlers:4]
  THEN_HANDLER: 12,  // ThenHandler [onResolved:4][onRejected:4][childPromise:4][next:4][flags:4]
  BIGINT: 13,  // BigInt [sign:4][length:4][limbs...]
  RATIONAL: 14,  // Rational [numeratorPointer:4][denominatorPointer:4] — both point at BIGINT heap objects
  COMPLEX: 15,  // Complex [realPointer:4][imaginaryPointer:4] — both point at RATIONAL heap objects
  SYMBOL: 16,      // Symbol [descriptionStringOffset:4][reserved:4]
  EXPRESSION: 17,  // Expression [headPointer:4][argumentArrayPointer:4]
  MAP: 18,         // Map header data: [size:4][slotCount:4][capacity:4][entriesPointer:4][sym_entries:4]
                   //   size      = live entries (excludes tombstones)
                   //   slotCount = used slots (live + tombstoned); insertion appends here
                   //   capacity  = allocated slots in entries block
                   //   entries   = HEADER pointer to MAP_ENTRIES block
  SET: 19,         // Set header data: same shape as Map (entries hold value only)
  MAP_ENTRIES: 20, // Map entries: per slot [tombstone_flag:4][key:16][value:16] = 36 bytes
                   //   tombstone_flag: 0 = live, 1 = deleted (skip on iteration)
  SET_ENTRIES: 21, // Set entries: per slot [tombstone_flag:4][value:16] = 20 bytes
  CONTEXT: 22,     // Execution context object: the state block (see CTX). Heap
                   //   citizen as of the heap-allocated-contexts change. Points at
                   //   four STACK_BLOCK objects (pending/call/try/grant).
  STACK_BLOCK: 23, // A context's stack storage: raw contiguous value/frame bytes.
                   //   One per stack. Relocates independently on overflow (call
                   //   stack); GC traces/forwards it via the owning context.
  SCRATCH: 24,     // Inert, pointer-free working buffer committed by the
                   //   expression walks (flatten/collect scratch). Real header
                   //   so linear heap walks parse over it; never marked, so
                   //   every collection reclaims it as garbage.
  MATRIX: 25,      // Matrix [rowCount:4][columnCount:4][entriesArrayPointer:4][reserved:4]
                   //   entriesArrayPointer is a frozen row-major Array
                   //   (HEADER pointer), the same storage pattern as EXPRESSION's
                   //   argument array.
  THEOREM: 26,     // Proof handle [artifactBufferDataPointer:4][index:4]
                   //   [kind:4][universeOwnerDataPointer:4]. Owner is zero
                   //   for unscoped handles; both data pointers are traced.
  ALGEBRAIC: 27,   // AlgebraicNumber [coefficientsArrayPointer:4]
                   //   [intervalArrayPointer:4][fieldGeneratorPointer:4]
                   //   [coordinatesArrayPointer:4]. Pointers name
                   //   frozen Arrays except fieldGeneratorPointer, which names
                   //   an AlgebraicNumber header. A zero field/coordinate pair
                   //   encodes the standalone generator identity.
  COMPLEX_ALGEBRAIC: 28, // ComplexAlgebraicNumber [realPointer:4][imaginaryPointer:4]
                         //   Both HEADER pointers name canonical
                         //   BigInt, Rational, or AlgebraicNumber values.
  NATIVE_CONTINUATION_STATE: 29,
  // Private operation state for a native callback continuation:
  // [headerPointerMask:4][dataPointerMask:4][state0..state4:20].
  // Bit N declares how stateN is traced; masks must not overlap.
  PROMISE_WAITER: 30, // Promise waiter [contextSlot:4][generation:4][nextDataPointer:4]
  REGEXP: 31,      // RegExp descriptor [patternStringOffset:4][flagsBitfield:4]
                   //   [lastIndex:4][programBufferDataPointer:4]. Traces the
                   //   pattern string id and the program ArrayBuffer DATA
                   //   pointer; flags and lastIndex are scalars.
  SCHEMA: 32,      // Schema descriptor (see SCHEMA): a 16-byte source value
                   //   slot (traced like an array element), the program
                   //   ArrayBuffer DATA pointer, and scalar options.
};

// RegExp descriptor payload offsets (relative to the OBJ.REGEXP data
// pointer). Mirrored by the $REGEXP_* globals in interpreter.wat.
export const REGEXP = {
  PATTERN_STRING: 0,   // interned-string id of the source pattern
  FLAGS: 4,            // REGEX_FLAG bitfield (regex-engine-contract.js)
  LAST_INDEX: 8,       // Unicode-scalar index; script-visible lastIndex
  PROGRAM_BUFFER: 12,  // DATA pointer to the OBJ.ARRAYBUFFER holding the
                       // validated engine program; 0 until compile commits
  SIZE: 16,
};

// Schema descriptor payload offsets (relative to the OBJ.SCHEMA data
// pointer). Mirrored by the $SCHEMA_* globals in interpreter.wat.
export const SCHEMA = {
  SOURCE: 0,           // 16-byte value slot: the source schema (object,
                       // boolean, or msgpack ref) — `s.schema`
  PROGRAM_BUFFER: 16,  // DATA pointer to the OBJ.ARRAYBUFFER holding the
                       // validated engine program; 0 until compile commits
  OPTIONS: 20,         // SCHEMA_PROGRAM.OPTION bits (strict, formats, dialect)
  MAX_DEPTH: 24,       // validation frame capacity
  MAX_ERRORS: 28,      // VALIDATE-mode stored-error capacity
  ARENA_BYTES: 32,     // validation arena bytes (grown on demand)
  COMPILE_FUEL: 36,    // fuel the compile charged
  SIZE: 40,
};

export const NATIVE_CONTINUATION_STATE = {
  SIZE: 40,
  HEADER_MASK: 0,
  DATA_MASK: 4,
  VALUES: 8,
};


// Simplify's auto-expansion result-size cap (predicted post-expansion term
// count). Exact.Expression.expand bypasses it.
export const MAX_EXPANSION_TERMS = 50;

// Polynomial-shape kinds returned by the WAT's
// $expression_polynomial_kind. Internal classification — the public
// surface is Exact.Expression.isPolynomial's boolean (everything
// except NOT_POLYNOMIAL) — but debug tooling may want the fine grain.
export const POLY_KIND = {
  ATOM_NUMERIC: 0,   // Rational / BigInt / Complex leaf
  ATOM_SYMBOL: 1,    // Symbol leaf
  ATOM_POWER: 2,     // Power(Symbol, non-negative integer literal)
  ATOM_OPAQUE: 3,    // any unrecognised head — honorary atom
  MONOMIAL: 4,       // Multiply of atoms (with optional coefficient)
  POLYNOMIAL: 5,     // Add/Subtract of monomials
  NOT_POLYNOMIAL: 6, // Divide, negative / non-integer Power, non-universe value
};
// Committed-heap sparse-polynomial scratch header:
// [termCount, termCapacity, variableCount, termSize].
export const SPARSE_POLYNOMIAL_HEADER_SIZE = 16;


export const GC_HEADER_SIZE = 8;

/**
 * Decode a GC object's total allocation size at an absolute header address.
 * Large ArrayBuffers use a zero packed size; their physical byte length at
 * data+0 determines the 8-aligned stride. Other zero-size headers stay invalid.
 * Keep arithmetic in JS numbers: bitwise alignment would wrap large lengths.
 */
export function readGCHeaderSize(view, absoluteHeaderPointer,
    headerWord = view.getUint32(absoluteHeaderPointer, true)) {
  const size = headerWord & 0x00ffffff;
  if (size !== 0 || ((headerWord >>> 24) & 0x7f) !== OBJ.ARRAYBUFFER) {
    return size;
  }
  const byteLength = view.getUint32(absoluteHeaderPointer + GC_HEADER_SIZE, true);
  return Math.ceil((GC_HEADER_SIZE + 4 + byteLength) / 8) * 8;
}

// Object layout: [GC:8][prototype:4][count:4][capacity:4][flags:4][entries:4][sym_entries:4] = 32 bytes
// sym_entries is a HEADER pointer to a lazy symbol-keyed entries block; 0 = absent.
export const OBJECT_HEADER_SIZE = 32;

// Object field offsets (from GC header start)
export const OBJECT = {
  PROTOTYPE: 0x08,    // prototype pointer (0 = null prototype)
  COUNT: 0x0C,        // number of string-keyed properties
  CAPACITY: 0x10,     // allocated string-key capacity
  FLAGS: 0x14,        // object flags (frozen, etc.)
  ENTRIES: 0x18,      // pointer to string-keyed entries block
  SYM_ENTRIES: 0x1C,  // pointer to symbol-keyed entries block (0 = unallocated)
};

// Map/Set header + slot layout (header-relative, i.e. from the GC header
// start). This is the authoritative source; the WAT globals
// ($MAP_SIZE_OFFSET etc.) are DATA-relative — these values minus
// GC_HEADER_SIZE — and the layout-constants verifier checks that
// correspondence at build time.
//
// Header: [GC:8][size:4][slotCount:4][capacity:4][entriesPointer:4][sym_entries:4]
export const MAP_LAYOUT = {
  SIZE: 0x08,          // WAT MAP_SIZE_OFFSET=0  + GC header
  SLOT_COUNT: 0x0C,    // WAT MAP_SLOT_COUNT_OFFSET=4
  CAPACITY: 0x10,      // WAT MAP_CAPACITY_OFFSET=8
  ENTRIES_PTR: 0x14,   // WAT MAP_ENTRIES_PTR_OFFSET=12 (HEADER pointer to entries block)
  SYM_ENTRIES: 0x18,   // WAT MAP_SYM_ENTRIES_OFFSET=16
  // Slot (within the entries block, after its own GC header):
  //   [tombstone:4][key:16][value:16] = 36 bytes; tombstone 0 = live.
  SLOT_STRIDE: 36,
  SLOT_TOMBSTONE: 0,
  SLOT_KEY: 4,
  SLOT_VALUE: 20,
};

// Set header shares the Map header shape; slot holds value only.
//   Slot: [tombstone:4][value:16] = 20 bytes; tombstone 0 = live.
export const SET_LAYOUT = {
  SIZE: 0x08,
  SLOT_COUNT: 0x0C,
  CAPACITY: 0x10,
  ENTRIES_PTR: 0x14,
  SYM_ENTRIES: 0x18,
  SLOT_STRIDE: 20,
  SLOT_TOMBSTONE: 0,
  SLOT_VALUE: 4,
};

// Array layout: [GC:8][length:4][capacity:4][data_pointer:4][flags:4][sym_entries:4] = 28 bytes
export const ARRAY_HEADER_SIZE = 28;

// Array field offsets (header-relative, i.e. from the GC header start —
// same basis as OBJECT). The WAT globals $ARRAY_FLAGS_OFFSET and
// $ARRAY_SYM_ENTRIES_OFFSET mirror FLAGS and SYM_ENTRIES.
export const ARRAY = {
  LENGTH: 0x08,
  CAPACITY: 0x0C,
  DATA_POINTER: 0x10,
  FLAGS: 0x14,
  SYM_ENTRIES: 0x18,
};

// Typed-array descriptor: [buffer_ptr:4][byte_offset:4][length:4][sym_entries:4]
// (data-relative — descriptor fields are measured from the DATA pointer,
// unlike Array/Object offsets above).
export const TYPED_ARRAY_SYM_ENTRIES_OFFSET = 12;

// Object/scope entry stride: [name:4][value:16] = 20 bytes.
export const ENTRY_SIZE = 20;

// Map/Set header data size: the five 4-byte fields after the GC header
// (size, slotCount, capacity, entriesPointer, sym_entries).
export const MAP_HEADER_DATA_SIZE = 20;

// Where closure fields begin inside a FUNCTION object, header-relative
// (GC:8 + object fields:24 — equals FUNCTION.START_INSTRUCTION, the
// first closure field).
export const FUNCTION_CLOSURE_OFFSET = 32;

// Object flags (bit field)
// Array flag bits (stored at array_pointer + 20)
export const ARRAY_FLAG = {
  FROZEN: 0x01,
};

export const OBJECT_FLAG = {
  FROZEN: 0x01,          // object is immutable
  EXTERNAL_BACKED: 0x02, // TYPE v4: instance branded by external super() —
                         // holds "@externalBacking" and forwards string-key
                         // misses to the backing external value
  CONSTRUCTION_PENDING: 0x04, // TYPE v4: external super() ran; completeConstruction has not
};

// Function layout: [object header: 32][start_instruction:4][end_instruction:4][scope:4][function_flags:4] = 48 bytes
export const FUNCTION_HEADER_SIZE = 48;

// Function field offsets (inherits OBJECT fields, adds closure data)
export const FUNCTION = {
  ...OBJECT,
  START_INSTRUCTION: 0x20,
  END_INSTRUCTION: 0x24,
  SCOPE: 0x28,
  FUNCTION_FLAGS: 0x2C,
};

// Symbol-entries block layout: [GC:8][sym_count:4][sym_capacity:4][entries...]
// where each entry is [symbolHeaderPointer:4][type:4][flags:4][data_lo:4][data_hi:4] = 20 bytes.
export const SYM_ENTRIES = {
  COUNT: 0x00,       // from data pointer (after GC header)
  CAPACITY: 0x04,    // from data pointer (after GC header)
  ENTRIES_START: 0x08,  // first entry begins here, stride 20
};

// Opcodes for flat instruction stream
export const OP = {
  // Literals (push to pending stack)
  LIT_INT: 0x01,         // operand1 = i32 value
  LIT_FLOAT: 0x02,       // operand1,2 = f64 bits (little-endian)
  LIT_STRING: 0x03,      // operand1 = string table offset
  LIT_NULL: 0x04,
  LIT_UNDEFINED: 0x05,
  LIT_TRUE: 0x06,
  LIT_FALSE: 0x07,
  LIT_BIGINT: 0x08,      // operand1 = heap header pointer
  LIT_RATIONAL_INTEGER: 0x09, // operand1,2 = i64 numerator (inline small-Rational, denom=1)
  LIT_RATIONAL_BIGINT: 0x0A,  // operand1 = heap BigInt numerator pointer (denom=1)
  LIT_WELL_KNOWN_SYMBOL: 0x0B, // operand1 = 0 (Symbol.iterator) | 1 (Symbol.asyncIterator) | 2 (Symbol.toStringTag)
  LIT_REGEXP: 0x0C,      // operand1 = pattern string table offset (raw source
                         // text between the slashes), operand2 = REGEX_FLAG
                         // bitfield (regex-engine-contract.js), validated by
                         // the parser. Compiles through the regex engine at
                         // evaluation and pushes a TYPE.REGEXP value.

  // Variables
  GET_VAR: 0x10,         // operand1 = name (string offset) → push value
  SET_VAR: 0x11,         // operand1 = name, pop value → assign
  LET_VAR: 0x12,         // operand1 = name, pop value → define in scope
  // 0x13 is FREE: BIND_PARAM had no parser emitter or WAT handler, so
  // any emission died at dispatch.

  // Arithmetic (pop operands, push result)
  ADD: 0x20,             // pop 2, push sum (polymorphic: number or string)
  SUB: 0x21,             // pop 2, push difference
  MUL: 0x22,             // pop 2, push product
  DIV: 0x23,             // pop 2, push quotient
  MOD: 0x24,             // pop 2, push remainder
  NEG: 0x25,             // pop 1, push negation
  POW: 0x26,             // pop 2, push power
  UPLUS: 0x2E,           // pop 1, push ToNumber(value) — unary plus

  // Comparison (pop 2, push bool)
  EQ: 0x30,              // ===
  NEQ: 0x31,             // !==
  LT: 0x32,              // <
  GT: 0x33,              // >
  LTE: 0x34,             // <=
  GTE: 0x35,             // >=

  // Logic
  NOT: 0x40,             // pop 1, push !value
  AND: 0x41,             // peek top; if falsy jump to operand1; else pop and continue
  OR: 0x42,              // peek top; if truthy jump to operand1; else pop and continue
  NULLISH: 0x43,         // peek top; if nullish (null/undefined) pop and jump to operand1; else keep

  // Bitwise
  BAND: 0x27,            // pop 2, push bitwise AND
  BOR: 0x28,             // pop 2, push bitwise OR
  BXOR: 0x29,            // pop 2, push bitwise XOR
  BNOT: 0x2A,            // pop 1, push bitwise NOT
  SHL: 0x2B,             // pop 2, push left shift
  SHR: 0x2C,             // pop 2, push signed right shift
  USHR: 0x2D,            // pop 2, push unsigned right shift

  // Control Flow
  JUMP: 0x50,            // operand1 = target instruction index (or CodeBlock ptr)
  JUMP_IF_FALSE: 0x51,   // pop condition, jump if falsy
  JUMP_IF_TRUE: 0x52,    // pop condition, jump if truthy

  // Scope
  SCOPE_PUSH: 0x60,      // create child scope
  SCOPE_POP: 0x61,       // restore parent scope

  // Functions
  MAKE_CLOSURE: 0x70,    // operand1 = start instr, operand2 = end instr → push closure (binds this)
  CALL: 0x71,            // operand1 = argc, pop closure + args, push frame, jump (this = undefined)
  RETURN: 0x72,          // pop result, pop frame, push result to caller's pending
  RETURN_UNDEFINED: 0x73, // push undefined then return
  MAKE_ARROW_CLOSURE: 0x74, // same as MAKE_CLOSURE but sets CLOSURE_FLAG_ARROW (no this binding)
  CALL_METHOD: 0x75,     // operand1 = argc, pop closure + args + receiver, push frame (this = receiver); operand2 bit 0 = propagate the caller's `@newtarget` binding (set only by super() emission)
  NEW: 0x76,             // operand1 = argc, pop constructor + args, construct object
  MAKE_ASYNC_CLOSURE: 0x77,        // same as MAKE_CLOSURE but sets CLOSURE_FLAG_ASYNC
  MAKE_ASYNC_ARROW_CLOSURE: 0x78,  // same as MAKE_ARROW_CLOSURE but also sets CLOSURE_FLAG_ASYNC
  AWAIT: 0x79,                     // pop value, yield to the host adapter for microtask scheduling
  MAKE_GENERATOR_CLOSURE: 0x7A,    // same as MAKE_CLOSURE but sets CLOSURE_FLAG_GENERATOR
  YIELD: 0x7B,                     // generator body: park this context with the yielded
                                   // value on the pending stack (EXIT_GENERATOR_YIELD);
                                   // resume pushes the sent value as the expression result
  MAKE_ASYNC_GENERATOR_CLOSURE: 0x7C, // same as MAKE_CLOSURE but sets
                                   // CLOSURE_FLAG_ASYNC | CLOSURE_FLAG_GENERATOR; calling it
                                   // spawns an async generator context (EXIT_GENERATOR_CALL —
                                   // the host adapter reads the closure flags to pick the protocol)

  // Objects/Arrays
  MAKE_ARRAY: 0x80,      // operand1 = count, pop N → push array
  MAKE_OBJECT: 0x81,     // operand1 = count, pop N key-value pairs → push object
  GET_PROP: 0x82,        // operand1 = name, pop obj → push value
  SET_PROP: 0x83,        // operand1 = name, pop val, pop obj → assign
  GET_INDEX: 0x84,       // pop index, pop obj → push value
  SET_INDEX: 0x85,       // pop val, pop idx, pop obj → assign

  // Spread opcodes. Used by spread-bearing array/object literals
  // and call sites where one or more arguments use `...`. Builder
  // pattern: start with an empty array/object (MAKE_ARRAY 0 / MAKE_OBJECT 0)
  // and accumulate elements one at a time. Iteration for array/call
  // spread is emitted as a parser-side loop using existing iterator
  // protocol opcodes; ARRAY_PUSH_ONE appends one element to that loop's
  // accumulator. Object spread can't be expressed via iterator protocol,
  // so OBJ_MERGE_SPREAD walks own-enumerable props in WAT.
  ARRAY_PUSH_ONE: 0x86,        // peek-array under value, append value. Stack: [arr, v] → [arr].
  OBJ_MERGE_SPREAD: 0x87,      // peek-object under source, copy own enum. string-keyed props. Stack: [obj, src] → [obj].
  CALL_SPREAD: 0x88,           // pop args-array, pop closure, call with array's contents as args.
  CALL_METHOD_SPREAD: 0x89,    // pop args-array, pop closure, pop receiver, method-call.
  WRAP_GETTER: 0x8A,           // pop closure, push TYPE_ACCESSOR with it as the getter half.
  WRAP_SETTER: 0x8B,           // pop closure, push TYPE_ACCESSOR with it as the setter half.
  NEW_SPREAD: 0x8C,            // pop args-array, pop constructor, construct with array's contents as args.
  DELETE_PROP: 0x8D,           // operand1 = name, pop obj → remove property, push boolean
  DELETE_INDEX: 0x8E,          // pop key, pop obj → remove property (ToPropertyKey'd), push boolean
  CLASS_LINK: 0x8F,            // pop class ctor, pop parent ctor → link class.[[proto]]=parent and class.prototype.[[proto]]=parent.prototype, push class ctor

  // 0x90 is FREE: BUILTIN had no emitter or WAT handler after builtin ids
  // merged into METHOD.
  TYPEOF: 0x91,          // pop 1, push type string
  INSTANCEOF: 0x92,      // pop 2 (value, constructor), push boolean
  VOID: 0x93,            // pop 1, discard, push undefined
  DELETE: 0x94,          // pop 1 (property ref), throw ERR_NOT_SUPPORTED
  IN: 0x95,              // pop 2 (key, obj), throw ERR_NOT_SUPPORTED
  GET_SUPER: 0x96,       // operand1 = name; [receiver, start] → [receiver, value]: chain lookup from `start`, getter runs with this = receiver
  SET_SUPER: 0x97,       // operand1 = name; [receiver, start, value] → [value]: chain accessor from `start` intercepts (setter this = receiver), else own define on receiver

  // Iteration — RESERVED, not implemented: no parser emission and no
  // WAT handler. Reserved for a frontend iteration protocol; implementing
  // these opcodes requires adding the WAT dispatch cases in the same change.
  ITER_INIT: 0xA0,       // pop iterable → push iterator
  ITER_NEXT: 0xA1,       // peek iterator → push value, push done (bool)
  ITER_CLOSE: 0xA2,      // pop iterator
  ASSERT_ITER_RESULT: 0xA3, // peek top: throw TypeError if not OBJECT/FUNCTION
  ASSERT_ITERABLE: 0xA4, // operand1=0: peek source, throw "Not iterable" for never-iterable primitives; operand1=1: peek iterator factory, throw with receiver's type if the Symbol.iterator lookup missed

  // Error Handling
  THROW: 0xB0,           // pop value, unwind to handler or halt
  TRY_PUSH: 0xB1,        // operand1 = catchPC, operand2 = finallyPC
  TRY_POP: 0xB2,         // normal exit from try, run finally if present
  FINALLY_END: 0xB3,     // end of finally: re-throw, complete return, or continue
  UNWIND_JUMP: 0xB4,     // break/continue crossing try frames. operand1 = target
                         // instruction index, operand2 = number of try entries to
                         // unwind (all belong to the current call frame — the
                         // parser counts them statically). Pops catch-only and
                         // disarmed entries; diverts through each armed finally
                         // with a COMPLETION_JUMP carrying {target, remaining}.
  PUSH_COMPLETION_KIND: 0xB5, // push the top try entry's completion type as an
                              // integer (0 normal / 1 throw / 2 return / 3 jump).
                              // Only valid inside a finally block, where the top
                              // entry is the disarmed holder — the for-of close
                              // block branches on it.

  // Special
  POP: 0xF0,             // discard top of pending stack
  DUP: 0xF1,             // duplicate top of pending stack
  SWAP: 0xF2,            // swap top two values on pending stack
  RECONCILE_PARAMS: 0xF3, // operand1 = paramCount, operand2 = hasRest. First op of every function body.
                          // Adjusts pending stack so exactly paramCount values remain for LET_VAR.
                          // argc < paramCount: pads missing slots with undefined.
                          // argc > paramCount with hasRest=1: packs excess into array as last param.
                          // argc > paramCount with hasRest=0: drops excess.
  NOP: 0xFF,             // no operation

  // Grant control
  GRANT_START: 0xC0,     // operand1 = denied addr (0 if none), operand2 = grant count; yield EXIT_GRANT_REQUEST
  GRANT_END: 0xC1,       // pop grant stack entries (operand1 = count)
  GRANT_DENIED: 0xC2,    // operand1 = param name offset (0 if no param); bind revoked identifiers array
};

// Operand kinds — what each instruction operand means, per opcode.
//
// Single source of truth for every consumer that walks code operands:
// the collector (which strings/heap objects to mark and forward across
// compaction) and the code differ (how to compare operands across two
// parses). Adding an opcode without classifying it here is an error —
// tests assert full coverage of OP.
export const OPERAND_KIND = {
  NONE: 0,               // operand unused
  INLINE: 1,             // immediate value (count, flags, argc, builtin id, i32, symbol id)
  INSTRUCTION_INDEX: 2,  // absolute instruction index into the code block
  STRING_OFFSET: 3,      // offset into the string table
  HEAP_POINTER: 4,       // heap HEADER pointer (parse-time allocation)
  FLOAT64_PAIR: 5,       // operand1+operand2 together encode one f64
  INTEGER64_PAIR: 6,     // operand1+operand2 together encode one i64
};

// Per-opcode [operand1 kind, operand2 kind]. For pair kinds both slots
// carry the pair marker. INSTRUCTION_INDEX operands of TRY_PUSH and
// GRANT_START (and the STRING_OFFSET of GRANT_DENIED) use 0 as a
// "none" sentinel — 0 can never be a real target/name there because
// the instruction emitting the sentinel precedes any code it could
// reference.
export const OPCODE_OPERANDS = {
  [OP.LIT_INT]:                  [OPERAND_KIND.INLINE, OPERAND_KIND.NONE],
  [OP.LIT_FLOAT]:                [OPERAND_KIND.FLOAT64_PAIR, OPERAND_KIND.FLOAT64_PAIR],
  [OP.LIT_STRING]:               [OPERAND_KIND.STRING_OFFSET, OPERAND_KIND.NONE],
  [OP.LIT_NULL]:                 [OPERAND_KIND.NONE, OPERAND_KIND.NONE],
  [OP.LIT_UNDEFINED]:            [OPERAND_KIND.NONE, OPERAND_KIND.NONE],
  [OP.LIT_TRUE]:                 [OPERAND_KIND.NONE, OPERAND_KIND.NONE],
  [OP.LIT_FALSE]:                [OPERAND_KIND.NONE, OPERAND_KIND.NONE],
  [OP.LIT_BIGINT]:               [OPERAND_KIND.HEAP_POINTER, OPERAND_KIND.NONE],
  [OP.LIT_RATIONAL_INTEGER]:     [OPERAND_KIND.INTEGER64_PAIR, OPERAND_KIND.INTEGER64_PAIR],
  [OP.LIT_RATIONAL_BIGINT]:      [OPERAND_KIND.HEAP_POINTER, OPERAND_KIND.NONE],
  [OP.LIT_WELL_KNOWN_SYMBOL]:    [OPERAND_KIND.INLINE, OPERAND_KIND.NONE],
  [OP.LIT_REGEXP]:               [OPERAND_KIND.STRING_OFFSET, OPERAND_KIND.INLINE],

  [OP.GET_VAR]:                  [OPERAND_KIND.STRING_OFFSET, OPERAND_KIND.NONE],
  [OP.SET_VAR]:                  [OPERAND_KIND.STRING_OFFSET, OPERAND_KIND.NONE],
  [OP.LET_VAR]:                  [OPERAND_KIND.STRING_OFFSET, OPERAND_KIND.INLINE], // operand2 = scope flags

  [OP.ADD]:                      [OPERAND_KIND.NONE, OPERAND_KIND.NONE],
  [OP.SUB]:                      [OPERAND_KIND.NONE, OPERAND_KIND.NONE],
  [OP.MUL]:                      [OPERAND_KIND.NONE, OPERAND_KIND.NONE],
  [OP.DIV]:                      [OPERAND_KIND.NONE, OPERAND_KIND.NONE],
  [OP.MOD]:                      [OPERAND_KIND.NONE, OPERAND_KIND.NONE],
  [OP.NEG]:                      [OPERAND_KIND.NONE, OPERAND_KIND.NONE],
  [OP.POW]:                      [OPERAND_KIND.NONE, OPERAND_KIND.NONE],
  [OP.UPLUS]:                    [OPERAND_KIND.NONE, OPERAND_KIND.NONE],

  [OP.EQ]:                       [OPERAND_KIND.NONE, OPERAND_KIND.NONE],
  [OP.NEQ]:                      [OPERAND_KIND.NONE, OPERAND_KIND.NONE],
  [OP.LT]:                       [OPERAND_KIND.NONE, OPERAND_KIND.NONE],
  [OP.GT]:                       [OPERAND_KIND.NONE, OPERAND_KIND.NONE],
  [OP.LTE]:                      [OPERAND_KIND.NONE, OPERAND_KIND.NONE],
  [OP.GTE]:                      [OPERAND_KIND.NONE, OPERAND_KIND.NONE],

  [OP.NOT]:                      [OPERAND_KIND.NONE, OPERAND_KIND.NONE],
  [OP.AND]:                      [OPERAND_KIND.INSTRUCTION_INDEX, OPERAND_KIND.NONE],
  [OP.OR]:                       [OPERAND_KIND.INSTRUCTION_INDEX, OPERAND_KIND.NONE],
  [OP.NULLISH]:                  [OPERAND_KIND.INSTRUCTION_INDEX, OPERAND_KIND.NONE],

  [OP.BAND]:                     [OPERAND_KIND.NONE, OPERAND_KIND.NONE],
  [OP.BOR]:                      [OPERAND_KIND.NONE, OPERAND_KIND.NONE],
  [OP.BXOR]:                     [OPERAND_KIND.NONE, OPERAND_KIND.NONE],
  [OP.BNOT]:                     [OPERAND_KIND.NONE, OPERAND_KIND.NONE],
  [OP.SHL]:                      [OPERAND_KIND.NONE, OPERAND_KIND.NONE],
  [OP.SHR]:                      [OPERAND_KIND.NONE, OPERAND_KIND.NONE],
  [OP.USHR]:                     [OPERAND_KIND.NONE, OPERAND_KIND.NONE],

  [OP.JUMP]:                     [OPERAND_KIND.INSTRUCTION_INDEX, OPERAND_KIND.NONE],
  [OP.JUMP_IF_FALSE]:            [OPERAND_KIND.INSTRUCTION_INDEX, OPERAND_KIND.NONE],
  [OP.JUMP_IF_TRUE]:             [OPERAND_KIND.INSTRUCTION_INDEX, OPERAND_KIND.NONE],

  [OP.SCOPE_PUSH]:               [OPERAND_KIND.NONE, OPERAND_KIND.NONE],
  [OP.SCOPE_POP]:                [OPERAND_KIND.NONE, OPERAND_KIND.NONE],

  [OP.MAKE_CLOSURE]:             [OPERAND_KIND.INSTRUCTION_INDEX, OPERAND_KIND.INSTRUCTION_INDEX],
  [OP.MAKE_ARROW_CLOSURE]:       [OPERAND_KIND.INSTRUCTION_INDEX, OPERAND_KIND.INSTRUCTION_INDEX],
  [OP.MAKE_ASYNC_CLOSURE]:       [OPERAND_KIND.INSTRUCTION_INDEX, OPERAND_KIND.INSTRUCTION_INDEX],
  [OP.MAKE_ASYNC_ARROW_CLOSURE]: [OPERAND_KIND.INSTRUCTION_INDEX, OPERAND_KIND.INSTRUCTION_INDEX],
  [OP.CALL]:                     [OPERAND_KIND.INLINE, OPERAND_KIND.NONE],
  [OP.CALL_METHOD]:              [OPERAND_KIND.INLINE, OPERAND_KIND.INLINE],
  [OP.NEW]:                      [OPERAND_KIND.INLINE, OPERAND_KIND.NONE],
  [OP.RETURN]:                   [OPERAND_KIND.NONE, OPERAND_KIND.NONE],
  [OP.RETURN_UNDEFINED]:         [OPERAND_KIND.NONE, OPERAND_KIND.NONE],
  [OP.AWAIT]:                    [OPERAND_KIND.NONE, OPERAND_KIND.NONE],

  [OP.MAKE_ARRAY]:               [OPERAND_KIND.INLINE, OPERAND_KIND.NONE],
  [OP.MAKE_OBJECT]:              [OPERAND_KIND.INLINE, OPERAND_KIND.NONE],
  [OP.GET_PROP]:                 [OPERAND_KIND.STRING_OFFSET, OPERAND_KIND.INLINE],
  [OP.SET_PROP]:                 [OPERAND_KIND.STRING_OFFSET, OPERAND_KIND.INLINE],
  [OP.GET_SUPER]:                [OPERAND_KIND.STRING_OFFSET, OPERAND_KIND.NONE],
  [OP.SET_SUPER]:                [OPERAND_KIND.STRING_OFFSET, OPERAND_KIND.NONE],
  [OP.GET_INDEX]:                [OPERAND_KIND.NONE, OPERAND_KIND.NONE],
  [OP.SET_INDEX]:                [OPERAND_KIND.NONE, OPERAND_KIND.NONE],
  [OP.ARRAY_PUSH_ONE]:           [OPERAND_KIND.NONE, OPERAND_KIND.NONE],
  [OP.OBJ_MERGE_SPREAD]:         [OPERAND_KIND.NONE, OPERAND_KIND.NONE],
  [OP.CALL_SPREAD]:              [OPERAND_KIND.NONE, OPERAND_KIND.NONE],
  [OP.CALL_METHOD_SPREAD]:       [OPERAND_KIND.NONE, OPERAND_KIND.NONE],
  [OP.CLASS_LINK]:               [OPERAND_KIND.NONE, OPERAND_KIND.NONE],
  [OP.WRAP_GETTER]:              [OPERAND_KIND.NONE, OPERAND_KIND.NONE],
  [OP.WRAP_SETTER]:              [OPERAND_KIND.NONE, OPERAND_KIND.NONE],
  [OP.NEW_SPREAD]:               [OPERAND_KIND.NONE, OPERAND_KIND.NONE],
  [OP.DELETE_PROP]:              [OPERAND_KIND.STRING_OFFSET, OPERAND_KIND.NONE],
  [OP.DELETE_INDEX]:             [OPERAND_KIND.NONE, OPERAND_KIND.NONE],

  [OP.TYPEOF]:                   [OPERAND_KIND.NONE, OPERAND_KIND.NONE],
  [OP.INSTANCEOF]:               [OPERAND_KIND.NONE, OPERAND_KIND.NONE],
  [OP.VOID]:                     [OPERAND_KIND.NONE, OPERAND_KIND.NONE],
  [OP.DELETE]:                   [OPERAND_KIND.NONE, OPERAND_KIND.NONE],
  [OP.IN]:                       [OPERAND_KIND.NONE, OPERAND_KIND.NONE],

  [OP.ITER_INIT]:                [OPERAND_KIND.NONE, OPERAND_KIND.NONE],
  [OP.ITER_NEXT]:                [OPERAND_KIND.NONE, OPERAND_KIND.NONE],
  [OP.ITER_CLOSE]:               [OPERAND_KIND.NONE, OPERAND_KIND.NONE],
  [OP.ASSERT_ITER_RESULT]:       [OPERAND_KIND.NONE, OPERAND_KIND.NONE],
  [OP.ASSERT_ITERABLE]:          [OPERAND_KIND.INLINE, OPERAND_KIND.NONE],

  [OP.THROW]:                    [OPERAND_KIND.NONE, OPERAND_KIND.NONE],
  [OP.TRY_PUSH]:                 [OPERAND_KIND.INSTRUCTION_INDEX, OPERAND_KIND.INSTRUCTION_INDEX],
  [OP.TRY_POP]:                  [OPERAND_KIND.NONE, OPERAND_KIND.NONE],
  [OP.FINALLY_END]:              [OPERAND_KIND.NONE, OPERAND_KIND.NONE],
  [OP.UNWIND_JUMP]:              [OPERAND_KIND.INSTRUCTION_INDEX, OPERAND_KIND.INLINE],
  [OP.PUSH_COMPLETION_KIND]:     [OPERAND_KIND.NONE, OPERAND_KIND.NONE],
  [OP.MAKE_GENERATOR_CLOSURE]:   [OPERAND_KIND.INSTRUCTION_INDEX, OPERAND_KIND.INSTRUCTION_INDEX],
  [OP.MAKE_ASYNC_GENERATOR_CLOSURE]: [OPERAND_KIND.INSTRUCTION_INDEX, OPERAND_KIND.INSTRUCTION_INDEX],
  [OP.YIELD]:                    [OPERAND_KIND.NONE, OPERAND_KIND.NONE],

  [OP.POP]:                      [OPERAND_KIND.NONE, OPERAND_KIND.NONE],
  [OP.DUP]:                      [OPERAND_KIND.NONE, OPERAND_KIND.NONE],
  [OP.SWAP]:                     [OPERAND_KIND.NONE, OPERAND_KIND.NONE],
  [OP.RECONCILE_PARAMS]:         [OPERAND_KIND.INLINE, OPERAND_KIND.INLINE],
  [OP.NOP]:                      [OPERAND_KIND.NONE, OPERAND_KIND.NONE],

  [OP.GRANT_START]:              [OPERAND_KIND.INSTRUCTION_INDEX, OPERAND_KIND.INLINE],
  [OP.GRANT_END]:                [OPERAND_KIND.INLINE, OPERAND_KIND.NONE],
  [OP.GRANT_DENIED]:             [OPERAND_KIND.STRING_OFFSET, OPERAND_KIND.NONE],
};

// Opcodes whose operand1 carries the given kind — derived views for
// consumers that walk code operands (collector mark/update passes).
export function opcodesWithOperand1Kind(kind) {
  const result = new Set();
  for (const [opcode, kinds] of Object.entries(OPCODE_OPERANDS)) {
    if (kinds[0] === kind) result.add(Number(opcode));
  }
  return result;
}

// Method IDs (for bound method dispatch in CALL_METHOD)
export const METHOD = {
  // Array instance methods (0x01 - 0x1F)
  PUSH: 0x01,
  POP: 0x02,
  SHIFT: 0x03,
  UNSHIFT: 0x04,
  SLICE: 0x05,
  CONCAT: 0x06,
  JOIN: 0x07,
  REVERSE: 0x08,
  INDEX_OF: 0x09,
  INCLUDES: 0x0A,
  MAP: 0x0B,
  FILTER: 0x0C,
  REDUCE: 0x0D,
  FOR_EACH: 0x0E,
  FIND: 0x0F,
  FIND_INDEX: 0x10,
  SOME: 0x11,
  EVERY: 0x12,
  SPLICE: 0x13,
  SORT: 0x14,
  FLAT: 0x15,
  FLAT_MAP: 0x16,
  ARRAY_AT: 0x17,
  ARRAY_FILL: 0x18,
  ARRAY_LAST_INDEX_OF: 0x19,
  ARRAY_COPY_WITHIN: 0x1A,

  // String instance methods (0x20 - 0x3F)
  CHAR_AT: 0x20,
  CHAR_CODE_AT: 0x21,
  STRING_INDEX_OF: 0x22,
  STRING_INCLUDES: 0x23,
  STRING_SLICE: 0x24,
  SUBSTRING: 0x25,
  SPLIT: 0x26,
  TRIM: 0x27,
  TO_LOWER_CASE: 0x28,
  TO_UPPER_CASE: 0x29,
  STARTS_WITH: 0x2A,
  ENDS_WITH: 0x2B,
  REPEAT: 0x2C,
  PAD_START: 0x2D,
  PAD_END: 0x2E,
  REPLACE: 0x2F,
  REPLACE_ALL: 0x38,
  TRIM_START: 0x39,
  TRIM_END: 0x3A,
  STRING_LAST_INDEX_OF: 0x3B,
  STRING_AT: 0x3C,
  STRING_CONCAT: 0x3D,
  MATH_RANDOM_UNSUPPORTED: 0x3E,

  // Math static methods (0x40 - 0x5F)
  MATH_ABS: 0x40,
  MATH_FLOOR: 0x41,
  MATH_CEIL: 0x42,
  MATH_ROUND: 0x43,
  MATH_TRUNC: 0x44,
  MATH_SIGN: 0x45,
  MATH_MIN: 0x46,
  MATH_MAX: 0x47,
  MATH_POW: 0x48,
  MATH_SQRT: 0x49,
  MATH_CBRT: 0x4A,
  MATH_HYPOT: 0x4B,
  MATH_SIN: 0x4C,
  MATH_COS: 0x4D,
  MATH_TAN: 0x4E,
  MATH_ASIN: 0x4F,
  MATH_ACOS: 0x50,
  MATH_ATAN: 0x51,
  MATH_ATAN2: 0x52,
  MATH_SINH: 0x53,
  MATH_COSH: 0x54,
  MATH_TANH: 0x55,
  MATH_ASINH: 0x56,
  MATH_ACOSH: 0x57,
  MATH_ATANH: 0x58,
  MATH_LOG: 0x59,
  MATH_LOG10: 0x5A,
  MATH_LOG2: 0x5B,
  MATH_LOG1P: 0x5C,
  MATH_EXP: 0x5D,
  MATH_EXPM1: 0x5E,
  MATH_CLZ32: 0x5F,
  MATH_IMUL: 0x60,
  MATH_FROUND: 0x61,

  // Exact Rational and Complex static methods (0x62 - 0x6F)
  EXACT_RATIONAL: 0x62,     // Exact.rational(numerator, denominator)
  EXACT_IS_RATIONAL: 0x63,  // Exact.isRational(value)
  EXACT_NUMERATOR: 0x64,    // Exact.numerator(rational) → BigInt
  EXACT_DENOMINATOR: 0x65,  // Exact.denominator(rational) → BigInt
  EXACT_EQUAL: 0x66,        // Exact.equal(a, b) — semantic cross-type equality
  EXACT_IS_INTEGER: 0x67,   // Exact.isInteger(value)
  EXACT_COMPLEX: 0x68,      // Exact.complex(real, imaginary)
  EXACT_IS_COMPLEX: 0x69,   // Exact.isComplex(value)
  EXACT_REAL: 0x6A,         // Exact.real(z) — Rational real part
  EXACT_IMAGINARY: 0x6B,    // Exact.imaginary(z) — Rational imaginary part
  EXACT_REALIZE: 0x6C,      // Exact.realize(z) — project Complex(a,0) → Rational(a), throw otherwise
  EXACT_TRY_REALIZE: 0x6D,  // Exact.tryRealize(z) — project or return unchanged
  EXACT_TYPE_OF: 0x6E,      // Exact.typeOf(x) — fine-grained: 'integer' | 'rational' | 'complex' | 'bigint' | 'float' | …
  EXACT_TO_STRING: 0x6F,    // Exact.toString(x) — exact decimal pretty-printing

  // Exact.Expression.* construction API
  EXACT_EXPRESSION_MAKE:     0x180,  // Exact.Expression.make(headSymbol, argsArray)
  EXACT_EXPRESSION_ADD:      0x181,  // Exact.Expression.add(left, right)
  EXACT_EXPRESSION_SUBTRACT: 0x182,  // Exact.Expression.subtract(left, right)
  EXACT_EXPRESSION_MULTIPLY: 0x183,  // Exact.Expression.multiply(left, right)
  EXACT_EXPRESSION_DIVIDE:   0x184,  // Exact.Expression.divide(left, right)
  EXACT_EXPRESSION_POWER:    0x185,  // Exact.Expression.power(base, exponent)
  EXACT_EXPRESSION_NEGATE:   0x186,  // Exact.Expression.negate(operand)

  // Expression inspection accessors
  EXACT_EXPRESSION_KIND:           0x187,  // kind(e) — head Symbol
  EXACT_EXPRESSION_ARGS:           0x188,  // args(e) — frozen arg array
  EXACT_EXPRESSION_ARGUMENT_COUNT: 0x189,  // argumentCount(e) — integer
  EXACT_EXPRESSION_IS_EXPRESSION:  0x18A,  // isExpression(v) — boolean
  EXACT_EXPRESSION_IS_ATOM:        0x18B,  // isAtom(v) — boolean

  // Expression equality and substitution
  EXACT_EXPRESSION_EQUAL:      0x18C,  // equal(a, b) — structural deep compare
  EXACT_EXPRESSION_SUBSTITUTE: 0x18D,  // substitute(e, sym, replacement)

  // Expression simplification and canonicalization
  EXACT_EXPRESSION_SIMPLIFY: 0x18E,   // simplify(e)

  // Polynomial recognition
  EXACT_EXPRESSION_IS_POLYNOMIAL: 0x18F,  // isPolynomial(v) — widened shape predicate

  // Uncapped expansion (0x1E1+ — the tail of the METHOD
  // id space; 0x190-0x1E0 are taken by iterators/Map/Set/typed-array
  // and array-method batches)
  EXACT_EXPRESSION_EXPAND: 0x1E1,  // expand(e) — no size cap

  // Polynomial algebra
  EXACT_EXPRESSION_POLYNOMIAL_GCD: 0x1E2,     // polynomialGcd(a, b)
  EXACT_EXPRESSION_POLYNOMIAL_DIVIDE: 0x1E3,  // polynomialDivide(a, b) → [q, r]
  EXACT_EXPRESSION_COLLECT: 0x1E4,            // collect(e, variable)

  // Exact.Matrix construction and inspection (0x1E5+ — the remaining
  // tail of the METHOD id space; the builtin table holds 512 entries, so
  // 0x1E5–0x1FF are the last free ids).
  EXACT_MATRIX_MAKE: 0x1E5,          // make(rowsArray)
  EXACT_MATRIX_IDENTITY: 0x1E6,      // identity(n)
  EXACT_MATRIX_ZERO: 0x1E7,          // zero(rows, columns)
  EXACT_MATRIX_DIAGONAL: 0x1E8,      // diagonal(valuesArray)
  EXACT_MATRIX_FROM_COLUMNS: 0x1E9,  // fromColumns(columnsArray)
  EXACT_MATRIX_ROWS: 0x1EA,          // rows(M) — integer
  EXACT_MATRIX_COLUMNS: 0x1EB,       // columns(M) — integer
  EXACT_MATRIX_GET: 0x1EC,           // get(M, i, j) — entry value
  EXACT_MATRIX_IS_MATRIX: 0x1ED,     // isMatrix(v) — boolean
  EXACT_MATRIX_IS_SQUARE: 0x1EE,     // isSquare(M) — boolean
  EXACT_MATRIX_EQUAL: 0x1EF,         // equal(a, b) — structural, shape + per-entry

  // Element-wise matrix arithmetic and transpose
  EXACT_MATRIX_ADD: 0x1F0,                 // add(A, B)
  EXACT_MATRIX_SUBTRACT: 0x1F1,            // subtract(A, B)
  EXACT_MATRIX_SCALE: 0x1F2,               // scale(k, A)
  EXACT_MATRIX_NEGATE: 0x1F3,              // negate(A)
  EXACT_MATRIX_TRANSPOSE: 0x1F4,           // transpose(M)
  EXACT_MATRIX_CONJUGATE_TRANSPOSE: 0x1F5, // conjugateTranspose(M)

  // Matrix multiplication and simple linear algebra
  EXACT_MATRIX_MULTIPLY: 0x1F6,            // multiply(A, B) — row-by-column
  EXACT_MATRIX_TRACE: 0x1F7,               // trace(M) — diagonal sum
  EXACT_MATRIX_DETERMINANT: 0x1F8,         // determinant(M) — Bareiss

  // Matrix inverse, solve, and rank (shared fraction-free engine)
  EXACT_MATRIX_INVERSE: 0x1F9,             // inverse(M) — throws on singular
  EXACT_MATRIX_SOLVE: 0x1FA,               // solve(A, b) — unique solution or throws
  EXACT_MATRIX_RANK: 0x1FB,                // rank(M) — integer

  // Pattern matching (0x200+, the first ids above the original 512-entry
  // dispatch table; the table now holds 1024 entries)
  EXACT_EXPRESSION_MATCH: 0x200,           // match(pattern, subject, variables)


  // Exact.AlgebraicNumber — real algebraic numbers.
  EXACT_ALGEBRAIC_ROOTS_OF_POLYNOMIAL: 0x214, // rootsOfPolynomial(expression, variable)
  EXACT_ALGEBRAIC_FROM_EXPRESSION: 0x215,     // fromExpression(expression) — rational-valued trees
  EXACT_ALGEBRAIC_COMPARE: 0x216,             // compare(a, b) → -1/0/1
  EXACT_ALGEBRAIC_EQUALS: 0x217,              // equals(a, b)
  EXACT_ALGEBRAIC_SIGN: 0x218,                // sign(a) → -1/0/1
  EXACT_ALGEBRAIC_IS_ZERO: 0x219,             // isZero(a)
  EXACT_ALGEBRAIC_TO_APPROXIMATION: 0x21A,    // toApproximation(a, widthExponent) → Float
  EXACT_ALGEBRAIC_DEFINING_POLYNOMIAL: 0x21B, // definingPolynomial(a) → symbolic expression
  EXACT_ALGEBRAIC_ISOLATING_INTERVAL: 0x21C,  // isolatingInterval(a) → [low, high] Rationals
  EXACT_ALGEBRAIC_IS_ALGEBRAIC_NUMBER: 0x21D, // isAlgebraicNumber(v)
  EXACT_ALGEBRAIC_SQUARE_ROOT: 0x21E,         // squareRoot(value)
  EXACT_ALGEBRAIC_NTH_ROOT: 0x21F,            // nthRoot(value, n)
  EXACT_EXPRESSION_RESULTANT: 0x220,          // Exact.Expression.resultant(a, b, variable)
  EXACT_ALGEBRAIC_COSINE_OF_TURNS: 0x221,     // cosineOfTurns(rational)
  EXACT_ALGEBRAIC_SINE_OF_TURNS: 0x222,       // sineOfTurns(rational)

  // Exact.ComplexAlgebraicNumber — exact non-real algebraic numbers.
  EXACT_COMPLEX_ALGEBRAIC_FROM_PARTS: 0x223,          // fromParts(realPart, imaginaryPart)
  EXACT_COMPLEX_ALGEBRAIC_IS_COMPLEX: 0x224,          // isComplexAlgebraicNumber(value)
  EXACT_COMPLEX_ALGEBRAIC_REAL_PART: 0x225,           // realPart(value)
  EXACT_COMPLEX_ALGEBRAIC_IMAGINARY_PART: 0x226,      // imaginaryPart(value)
  EXACT_COMPLEX_ALGEBRAIC_CONJUGATE: 0x227,           // conjugate(value)
  EXACT_COMPLEX_ALGEBRAIC_MODULUS_SQUARED: 0x228,     // modulusSquared(value)
  EXACT_COMPLEX_ALGEBRAIC_MODULUS: 0x229,             // modulus(value)
  EXACT_COMPLEX_ALGEBRAIC_EQUALS: 0x22A,              // equals(left, right)
  EXACT_COMPLEX_ALGEBRAIC_SQUARE_ROOT: 0x22B,         // squareRoot(value)
  EXACT_COMPLEX_ALGEBRAIC_NTH_ROOT: 0x22C,            // nthRoot(value, index)
  EXACT_COMPLEX_ALGEBRAIC_ROOTS_OF_POLYNOMIAL: 0x22D, // rootsOfPolynomial(expression, variable)
  EXACT_COMPLEX_ALGEBRAIC_TO_APPROXIMATION: 0x22E,    // toApproximation(value, widthExponent)
  EXACT_COMPLEX_ALGEBRAIC_ADD: 0x22F,             // add(left, right)
  EXACT_COMPLEX_ALGEBRAIC_SUBTRACT: 0x230,        // subtract(left, right)
  EXACT_COMPLEX_ALGEBRAIC_MULTIPLY: 0x231,        // multiply(left, right)
  EXACT_COMPLEX_ALGEBRAIC_DIVIDE: 0x232,          // divide(left, right)
  EXACT_COMPLEX_ALGEBRAIC_NEGATE: 0x233,          // negate(value)
  // Sparse multivariate elimination.
  EXACT_EXPRESSION_GROEBNER_BASIS: 0x234,      // groebnerBasis(expressions, variables)
  EXACT_EXPRESSION_POLYNOMIAL_REDUCE: 0x235,   // polynomialReduce(expression, basis, variables)
  // Exact.Expression transcendental construction and certified approximation.
  EXACT_EXPRESSION_EXP: 0x236,
  EXACT_EXPRESSION_SIN: 0x237,
  EXACT_EXPRESSION_COS: 0x238,
  EXACT_EXPRESSION_TAN: 0x239,
  EXACT_EXPRESSION_LOG: 0x23A,
  EXACT_EXPRESSION_TO_APPROXIMATION: 0x23B,

  // Object static methods (0x70 - 0x7F)
  OBJECT_KEYS: 0x70,
  OBJECT_VALUES: 0x71,
  OBJECT_ENTRIES: 0x72,
  OBJECT_ASSIGN: 0x73,
  OBJECT_FREEZE: 0x74,      // Object.freeze(obj)
  OBJECT_IS_FROZEN: 0x75,   // Object.isFrozen(obj)
  OBJECT_GET_OWN_PROPERTY_DESCRIPTOR: 0x76, // Object.getOwnPropertyDescriptor(obj, key)

  // Array static methods (0x80 - 0x8F)
  ARRAY_IS_ARRAY: 0x80,
  ARRAY_FROM: 0x81,
  ARRAY_FREEZE: 0x82,      // Array.freeze(arr)
  ARRAY_IS_FROZEN: 0x83,   // Array.isFrozen(arr)

  // String static methods (0x90 - 0x9F)
  STRING_FROM_CHAR_CODE: 0x90,
  STRING_FROM_CODE_POINT: 0x91,

  // Number static methods (0xA0 - 0xAF)
  NUMBER_IS_NAN: 0xA0,
  NUMBER_IS_FINITE: 0xA1,
  NUMBER_IS_INTEGER: 0xA2,
  NUMBER_PARSE_INT: 0xA3,
  NUMBER_PARSE_FLOAT: 0xA4,

  // Global conversion functions (0xB0 - 0xBF)
  TO_STRING: 0xB0,     // String(x)
  TO_NUMBER: 0xB1,     // Number(x)
  TO_BOOLEAN: 0xB2,    // Boolean(x)
  TO_BIGINT: 0xB7,     // BigInt(x)
  PARSE_INT: 0xB3,     // parseInt(str, radix)
  PARSE_FLOAT: 0xB4,   // parseFloat(str)
  IS_NAN: 0xB5,        // isNaN(x) - global version with coercion
  IS_FINITE: 0xB6,     // isFinite(x) - global version with coercion
  BIGINT_AS_INT_N: 0xB8,
  BIGINT_AS_UINT_N: 0xB9,
  SYNTAX_ERROR_CONSTRUCTOR: 0xBA,
  BIGINT_TO_STRING: 0xBB,
  BIGINT_VALUE_OF: 0xBC,
  BIGINT_TO_LOCALE_STRING: 0xBD,

  // Constructor method IDs (0xC0 - 0xCF)
  ARRAY_CONSTRUCTOR: 0xC0,
  OBJECT_CONSTRUCTOR: 0xC1,
  FUNCTION_CONSTRUCTOR: 0xC2,
  ARRAYBUFFER_CONSTRUCTOR: 0xC3,
  UINT8ARRAY_CONSTRUCTOR: 0xC4,
  UINT8ARRAY_SUBARRAY: 0xC5,
  UINT8ARRAY_SLICE: 0xC6,
  DATAVIEW_CONSTRUCTOR: 0xC7,
  DATAVIEW_GET_INT8: 0xC8,
  DATAVIEW_GET_UINT8: 0xC9,
  DATAVIEW_GET_INT16: 0xCA,
  DATAVIEW_GET_UINT16: 0xCB,
  DATAVIEW_GET_INT32: 0xCC,
  DATAVIEW_GET_UINT32: 0xCD,
  DATAVIEW_GET_FLOAT32: 0xCE,
  DATAVIEW_GET_FLOAT64: 0xCF,
  DATAVIEW_SET_INT8: 0xD8,
  DATAVIEW_SET_UINT8: 0xD9,
  DATAVIEW_SET_INT16: 0xDA,
  DATAVIEW_SET_UINT16: 0xDB,
  DATAVIEW_SET_INT32: 0xDC,
  DATAVIEW_SET_UINT32: 0xDD,
  DATAVIEW_SET_FLOAT32: 0xDE,
  DATAVIEW_SET_FLOAT64: 0xDF,

  // Uint8Array instance methods (0x110 - 0x12F)
  UINT8ARRAY_FILL: 0x110,
  UINT8ARRAY_SET: 0x111,
  UINT8ARRAY_COPY_WITHIN: 0x112,
  UINT8ARRAY_REVERSE: 0x113,
  UINT8ARRAY_INDEX_OF: 0x114,
  UINT8ARRAY_LAST_INDEX_OF: 0x115,
  UINT8ARRAY_INCLUDES: 0x116,
  UINT8ARRAY_FOR_EACH: 0x117,
  UINT8ARRAY_MAP: 0x118,
  UINT8ARRAY_FILTER: 0x119,
  UINT8ARRAY_FIND: 0x11A,
  UINT8ARRAY_FIND_INDEX: 0x11B,
  UINT8ARRAY_EVERY: 0x11C,
  UINT8ARRAY_SOME: 0x11D,
  UINT8ARRAY_REDUCE: 0x11E,
  UINT8ARRAY_REDUCE_RIGHT: 0x11F,
  UINT8ARRAY_JOIN: 0x120,
  UINT8ARRAY_TO_STRING: 0x121,
  UINT8ARRAY_SORT: 0x122,
  UINT8ARRAY_FIND_LAST: 0x123,
  UINT8ARRAY_FIND_LAST_INDEX: 0x124,
  TYPED_ARRAY_KEYS: 0x125,     // keys() — iterator factory, kind 0
  TYPED_ARRAY_ENTRIES: 0x126,  // entries() — iterator factory, kind 2 ([index, value] pairs)
  TYPED_ARRAY_TO_REVERSED: 0x127,  // toReversed() — reversed copy
  TYPED_ARRAY_TO_SORTED: 0x128,    // toSorted() — sorted copy (comparator form stages sort frames)
  TYPED_ARRAY_WITH: 0x129,         // with(index, value) — copy with one element replaced

  // Typed array static methods - from (0x150 - 0x15F)
  UINT8ARRAY_FROM: 0x150,
  INT8ARRAY_FROM: 0x151,
  UINT8CLAMPEDARRAY_FROM: 0x152,
  INT16ARRAY_FROM: 0x153,
  UINT16ARRAY_FROM: 0x154,
  INT32ARRAY_FROM: 0x155,
  UINT32ARRAY_FROM: 0x156,
  FLOAT32ARRAY_FROM: 0x157,
  FLOAT64ARRAY_FROM: 0x158,
  BIGINT64ARRAY_FROM: 0x159,
  BIGUINT64ARRAY_FROM: 0x15A,

  // Typed array static methods - of (0x160 - 0x16F)
  UINT8ARRAY_OF: 0x160,
  INT8ARRAY_OF: 0x161,
  UINT8CLAMPEDARRAY_OF: 0x162,
  INT16ARRAY_OF: 0x163,
  UINT16ARRAY_OF: 0x164,
  INT32ARRAY_OF: 0x165,
  UINT32ARRAY_OF: 0x166,
  FLOAT32ARRAY_OF: 0x167,
  FLOAT64ARRAY_OF: 0x168,
  BIGINT64ARRAY_OF: 0x169,
  BIGUINT64ARRAY_OF: 0x16A,

  // JSON methods (0x130 - 0x13F)
  JSON_STRINGIFY: 0x130,
  JSON_PARSE: 0x131,

  // Other typed array constructors (0x140 - 0x14F)
  INT8ARRAY_CONSTRUCTOR: 0x140,
  UINT8CLAMPEDARRAY_CONSTRUCTOR: 0x141,
  INT16ARRAY_CONSTRUCTOR: 0x142,
  UINT16ARRAY_CONSTRUCTOR: 0x143,
  INT32ARRAY_CONSTRUCTOR: 0x144,
  UINT32ARRAY_CONSTRUCTOR: 0x145,
  FLOAT32ARRAY_CONSTRUCTOR: 0x146,
  FLOAT64ARRAY_CONSTRUCTOR: 0x147,
  BIGINT64ARRAY_CONSTRUCTOR: 0x148,
  BIGUINT64ARRAY_CONSTRUCTOR: 0x149,

  // Object prototype methods (0xE0 - 0xEF)
  HAS_OWN_PROPERTY: 0xE0,
  OBJECT_TO_STRING: 0xE1,
  OBJECT_GET_PROTOTYPE_OF: 0xE2,

  // Error methods (0xF0 - 0xFF)
  ERROR_TO_STRING: 0xF0,
  ERROR_CONSTRUCTOR: 0xF1,
  TYPE_ERROR_CONSTRUCTOR: 0xF2,
  REFERENCE_ERROR_CONSTRUCTOR: 0xF3,
  RANGE_ERROR_CONSTRUCTOR: 0xF4,

  // TextEncoder / TextDecoder (0xF5 - 0xF8)
  TEXT_ENCODER_CONSTRUCTOR: 0xF5,
  TEXT_DECODER_CONSTRUCTOR: 0xF6,
  TEXT_ENCODER_ENCODE: 0xF7,
  TEXT_DECODER_DECODE: 0xF8,

  // btoa / atob global base64 functions (0xFA - 0xFB)
  BTOA: 0xFA,
  ATOB: 0xFB,

  // Array.prototype.toString — backed by $array_join with comma separator.
  ARRAY_TO_STRING: 0xF9,

  // Promise instance methods (0x30 - 0x32)
  THEN: 0x30,
  CATCH: 0x31,
  FINALLY: 0x32,

  // Promise static methods (0x33 - 0x37)
  PROMISE_RESOLVE: 0x33,
  PROMISE_REJECT: 0x34,
  PROMISE_ALL: 0x35,
  PROMISE_RACE: 0x36,
  PROMISE_CONSTRUCTOR: 0x37,

  // Symbol methods (0x170 - 0x17F)
  SYMBOL_CONSTRUCTOR: 0x170,  // Symbol(description) — fresh symbol
  SYMBOL_FOR: 0x171,          // Symbol.for(key) — registry-backed, canonical
  SYMBOL_KEY_FOR: 0x172,      // Symbol.keyFor(sym) — registered key or undefined
  SYMBOL_TO_STRING: 0x173,    // sym.toString() — "Symbol(desc)" or "Symbol()"

  // Built-in iterator protocol (0x190 - 0x19F).
  // Factories live on the relevant *.prototype under the Symbol.iterator
  // key; .next methods live on the iterator object that the factory
  // produces. Each factory allocates an iterator object that closes over
  // its receiver via hidden @-prefixed string-keyed properties.
  ARRAY_ITERATOR_FACTORY: 0x190,        // arr[Symbol.iterator]() -> iterator obj
  ARRAY_ITERATOR_NEXT: 0x191,           // arrayIterator.next() -> { value, done }
  STRING_ITERATOR_FACTORY: 0x192,       // str[Symbol.iterator]() -> code-point iterator
  STRING_ITERATOR_NEXT: 0x193,
  TYPED_ARRAY_ITERATOR_FACTORY: 0x194,  // shared by all 11 typed arrays
  TYPED_ARRAY_ITERATOR_NEXT: 0x195,

  // Map (0x1A0 - 0x1AF) and Set (0x1B0 - 0x1CF).
  // Map instance methods live on Map.prototype; constructor METHOD id
  // is dispatched by `new Map(...)`. Iterator NEXT handles all three
  // iterator kinds (entries / keys / values) via the iterator object's
  // stashed @kind property.
  MAP_CONSTRUCTOR: 0x1A0,
  MAP_GET: 0x1A1,
  MAP_SET: 0x1A2,
  MAP_HAS: 0x1A3,
  MAP_DELETE: 0x1A4,
  MAP_CLEAR: 0x1A5,
  MAP_FOREACH: 0x1A6,
  MAP_KEYS: 0x1A7,
  MAP_VALUES: 0x1A8,
  MAP_ENTRIES_M: 0x1A9,     // .entries() — _M suffix avoids name clash with OBJ.MAP_ENTRIES
  MAP_SIZE_GETTER: 0x1AA,   // size getter on Map.prototype
  MAP_ITERATOR_NEXT: 0x1AB,

  SET_CONSTRUCTOR: 0x1B0,
  SET_ADD: 0x1B1,
  SET_HAS: 0x1B2,
  SET_DELETE: 0x1B3,
  SET_CLEAR: 0x1B4,
  SET_FOREACH: 0x1B5,
  SET_KEYS: 0x1B6,          // === SET_VALUES (same function object semantically)
  SET_VALUES: 0x1B7,
  SET_ENTRIES_M: 0x1B8,
  SET_SIZE_GETTER: 0x1B9,
  SET_ITERATOR_NEXT: 0x1BA,
  // ES2025 set-theoretic methods
  SET_UNION: 0x1BB,
  SET_INTERSECTION: 0x1BC,
  SET_DIFFERENCE: 0x1BD,
  SET_SYMMETRIC_DIFFERENCE: 0x1BE,
  SET_IS_SUBSET_OF: 0x1BF,
  SET_IS_SUPERSET_OF: 0x1C0,
  SET_IS_DISJOINT_FROM: 0x1C1,
  // Universal `return this` method for iterator objects — wired as
  // [Symbol.iterator] on every iterator we build so that the iterators
  // themselves are iterable (matches JS — array.keys()[Symbol.iterator]()
  // returns the same iterator).
  ITERATOR_RETURN_SELF: 0x1C2,

  MSGPACK_ENCODE: 0x1C3,
  MSGPACK_DECODE: 0x1C4,


  // Additional array, object, number, and typed-array methods
  ARRAY_REDUCE_RIGHT: 0x1CC,   // plain-array reduceRight (descending reduce)
  ARRAY_OF: 0x1CD,             // Array.of(...) — args become the elements
  OBJECT_FROM_ENTRIES: 0x1CE,  // Object.fromEntries(pairs)
  NUMBER_TO_FIXED: 0x1CF,      // Number.prototype.toFixed(digits)
  NUMBER_TO_STRING: 0x1D0,     // Number.prototype.toString(radix)
  TYPED_ARRAY_AT: 0x1D1,       // typed-array .at(index) (negative wraps)

  // Methods on generator objects.
  GENERATOR_NEXT: 0x1D2,       // gen.next(v) — park caller, drive the generator context
  GENERATOR_RETURN: 0x1D3,     // gen.return(v) — RESPONSE_RETURN injection (body finallys run)
  GENERATOR_THROW: 0x1D4,      // gen.throw(e) — RESPONSE_THROW injection at the yield point
  GENERATOR_SELF: 0x1D5,       // gen[Symbol.iterator]() — returns the generator itself

  // Function.prototype methods (closures only; native bound methods
  // carry their receiver already).
  FUNCTION_CALL: 0x1D6,        // f.call(thisArg, ...args)
  FUNCTION_APPLY: 0x1D7,       // f.apply(thisArg, argsArray)
  FUNCTION_BIND: 0x1D8,        // f.bind(thisArg) — holder-scope closure clone (no partial args)

  // Plain-array findLast/findLastIndex methods; typed mirrors live in the
  // Uint8Array instance range above.
  FIND_LAST: 0x1D9,
  FIND_LAST_INDEX: 0x1DA,
  // keys()/entries() iterator factories — three ids share one factory per
  // kind (values() resolves to the existing ARRAY_ITERATOR_FACTORY /
  // TYPED_ARRAY_ITERATOR_FACTORY, matching JS where values ===
  // [Symbol.iterator]). The factory stores the kind in the iterator
  // object's @kind slot; the shared iterator-next branches on it.
  ARRAY_KEYS: 0x1DB,
  ARRAY_ENTRIES: 0x1DC,
  // Copying methods: allocate the copy first (pressure pre-checked), then
  // transform. toSorted's comparator form copies and then stages the
  // existing sort continuation kind against the copy. toSpliced is
  // arrays-only per spec.
  ARRAY_TO_REVERSED: 0x1DD,
  ARRAY_TO_SORTED: 0x1DE,
  ARRAY_WITH: 0x1DF,
  ARRAY_TO_SPLICED: 0x1E0,
  // RegExp methods. The constructor id doubles as the instanceof prototype
  // key, like every builtin above.
  // Renumbered 0x1E1-0x1E3 → 0x27C-0x27E: the original mints silently
  // collided with EXACT_EXPRESSION_EXPAND/POLYNOMIAL_GCD/POLYNOMIAL_DIVIDE
  // — method ids share ONE space across every receiver kind (bound-method
  // dispatch branches on method_id alone, and the builtin table's slot
  // index IS the id). The build verifier now rejects duplicate ids.
  REGEXP_CONSTRUCTOR: 0x27C,
  REGEXP_EXEC: 0x27D,
  REGEXP_TEST: 0x27E,
  // RegExp string methods. match/matchAll/search
  // are string-receiver methods; the iterator-next id drives the lazy
  // matchAll iterator. All four dispatch inline in CALL/CALL_METHOD
  // (fuel-resumable), never through the builtin table.
  STRING_MATCH: 0x27F,
  STRING_MATCH_ALL: 0x280,
  STRING_SEARCH: 0x281,
  REGEXP_STRING_ITERATOR_NEXT: 0x282,
  // Schema methods. The
  // constructor, compile, and the one-shots/instance methods run the
  // fuel-resumable engine inline from CALL/CALL_METHOD/NEW (never via
  // $builtin_table); isSchema is a plain table method.
  SCHEMA_CONSTRUCTOR: 0x2C0,
  SCHEMA_COMPILE: 0x2C1,
  SCHEMA_TEST_STATIC: 0x2C2,
  SCHEMA_VALIDATE_STATIC: 0x2C3,
  SCHEMA_IS_SCHEMA: 0x2C4,
  SCHEMA_TEST: 0x2C5,
  SCHEMA_VALIDATE: 0x2C6,
  SCHEMA_ASSERT: 0x2C7,
  SCHEMA_ERRORS: 0x2C8,
  SCHEMA_COMPILE_SET: 0x2C9,
  SCHEMA_MATCH: 0x2CA,
  SCHEMA_MATCH_ALL: 0x2CB,
  PROOF_UNIVERSES: 0x277,
  PROOF_CONSTRAIN: 0x278,
  PROOF_FIELD: 0x27A,
  PROOF_RECORD: 0x27B,
  PROOF_TERM_RECORD: 0x284,
  PROOF_TERM_RENDER: 0x285,
  PROOF_STATE_BEGIN: 0x286,
  PROOF_STATE_GOAL_COUNT: 0x287,
  PROOF_STATE_GOAL_TARGET: 0x288,
  PROOF_STATE_GOAL_CONTEXT: 0x289,
  PROOF_STATE_EXACT: 0x28A,
  PROOF_STATE_INTRODUCE: 0x28B,
  PROOF_STATE_SEAL: 0x28C,
  PROOF_STATE_APPLY: 0x28D,
  PROOF_STATE_ASSUMPTION: 0x28E,
  PROOF_STATE_CONSTRUCTOR: 0x28F,
  PROOF_STATE_CASES: 0x290,
  PROOF_STATE_INDUCTION: 0x291,
  PROOF_STATE_CHANGE: 0x292,
  PROOF_STATE_REDUCE: 0x293,
  PROOF_STATE_REFLEXIVITY: 0x2D0,
  PROOF_STATE_SYMMETRY: 0x2d1,
  PROOF_STATE_TRANSITIVITY: 0x2d2,
  PROOF_STATE_REWRITE: 0x2d3,
  PROOF_STATE_SUBSTITUTE: 0x2d4,
  PROOF_STATE_CONGRUENCE: 0x2d5,
  PROOF_STATE_DISCRIMINATE: 0x2d6,
  PROOF_STATE_INJECT: 0x2d7,
  PROOF_STATE_REFINE: 0x2d8,
  PROOF_STATE_REVERT: 0x2d9,
  PROOF_STATE_CLEAR: 0x2da,
  PROOF_STATE_HAVE: 0x2db,
  PROOF_STATE_POSE: 0x2dc,
  PROOF_STATE_SPECIALIZE: 0x2dd,
  PROOF_STATE_CONTRADICTION: 0x2de,
  PROOF_STATE_SPLIT: 0x2df,
  PROOF_STATE_LEFT: 0x2e0,
  PROOF_STATE_RIGHT: 0x2e1,
  PROOF_STATE_EXISTS: 0x2e2,
  PROOF_STATE_DESTRUCT: 0x2e3,
  PROOF_STATE_INVERSION: 0x2e4,
  PROOF_STATE_DECIDE: 0x2e5,
  PROOF_STATE_SIMPLIFY: 0x2e6,
  PROOF_STATE_UNFOLD: 0x2e7,
  PROOF_STATE_INFER: 0x2e8,
  PROOF_TERM_PROJECTION: 0x2e9,
  PROOF_TERM_NATURAL_LITERAL: 0x2ea,
  PROOF_TERM_STRING_LITERAL: 0x2eb,
  PROOF_TERM_RECURSOR: 0x2ec,
  PROOF_QUOTIENT: 0x2ed,
  PROOF_TERM_SORT: 0x2ee,
  PROOF_LEVEL_SUCCESSOR: 0x2ef,
  PROOF_LEVEL_MAXIMUM: 0x2f0,
  PROOF_LEVEL_IMAX: 0x2f1,
  PROOF_DECLARATION_INDEX: 0x2f2,
  PROOF_NAME_STR: 0x2f3,
  PROOF_NAME_NUM: 0x2f4,
  PROOF_DECLARATION_NAME: 0x2f5,
  PROOF_CONSTRUCTOR_NAME: 0x2f6,

  // Symbolic calculus: derived elementary-function constructors and
  // differentiation methods.
  EXACT_EXPRESSION_SINH: 0x294,
  EXACT_EXPRESSION_COSH: 0x295,
  EXACT_EXPRESSION_TANH: 0x296,
  EXACT_EXPRESSION_SQRT: 0x297,
  EXACT_EXPRESSION_ASIN: 0x298,
  EXACT_EXPRESSION_ACOS: 0x299,
  EXACT_EXPRESSION_ATAN: 0x29A,
  EXACT_EXPRESSION_ASINH: 0x29B,
  EXACT_EXPRESSION_ACOSH: 0x29C,
  EXACT_EXPRESSION_ATANH: 0x29D,
  EXACT_EXPRESSION_DERIVATIVE: 0x29E,
  EXACT_EXPRESSION_GRADIENT: 0x29F,
  EXACT_EXPRESSION_JACOBIAN: 0x2A0,
  EXACT_EXPRESSION_HESSIAN: 0x2A1,
  EXACT_EXPRESSION_TAYLOR: 0x2A2,

  // Exact solving and factorization.
  EXACT_EXPRESSION_FACTOR: 0x2A3,
  EXACT_EXPRESSION_EXPAND_FACTORIZATION: 0x2A4,
  EXACT_EXPRESSION_DEGREE: 0x2A5,
  EXACT_EXPRESSION_COEFFICIENTS: 0x2A6,
  EXACT_EXPRESSION_CONTENT: 0x2A7,
  EXACT_EXPRESSION_PRIMITIVE_PART: 0x2A8,
  EXACT_EXPRESSION_SOLVE_POLYNOMIAL: 0x2A9,
  EXACT_EXPRESSION_SOLVE_SYSTEM: 0x2AA,
  EXACT_EXPRESSION_SOLVE_INEQUALITY: 0x2AB,
  EXACT_EXPRESSION_SIGN_CHART: 0x2AC,
  EXACT_EXPRESSION_SATISFIES: 0x2AD,

  // Verified symbolic integration.
  EXACT_EXPRESSION_INTEGRAL: 0x2AE,
  EXACT_EXPRESSION_DEFINITE_INTEGRAL: 0x2AF,
  EXACT_EXPRESSION_ANTIDERIVATIVE: 0x2B0,
};

// Native continuation kinds are interpreter control-flow identifiers, never
// callable method identifiers. Values retain their established wire numbers
// so existing memory snapshots remain readable.
export const CONTINUATION_KIND = {
  ARRAY_MAP: 0x0B,
  ARRAY_FILTER: 0x0C,
  ARRAY_REDUCE: 0x0D,
  ARRAY_FOR_EACH: 0x0E,
  ARRAY_FIND: 0x0F,
  ARRAY_FIND_INDEX: 0x10,
  ARRAY_SOME: 0x11,
  ARRAY_EVERY: 0x12,
  ARRAY_SORT: 0x14,
  ARRAY_FLAT_MAP: 0x16,
  TYPED_ARRAY_FOR_EACH: 0x117,
  TYPED_ARRAY_MAP: 0x118,
  TYPED_ARRAY_FILTER: 0x119,
  TYPED_ARRAY_FIND: 0x11A,
  TYPED_ARRAY_FIND_INDEX: 0x11B,
  TYPED_ARRAY_EVERY: 0x11C,
  TYPED_ARRAY_SOME: 0x11D,
  TYPED_ARRAY_REDUCE: 0x11E,
  TYPED_ARRAY_REDUCE_RIGHT: 0x11F,
  TYPED_ARRAY_SORT: 0x122,
  TYPED_ARRAY_FIND_LAST: 0x123,
  TYPED_ARRAY_FIND_LAST_INDEX: 0x124,
  MAP_FOR_EACH: 0x1A6,
  SET_FOR_EACH: 0x1B5,
  ARRAY_REDUCE_RIGHT: 0x1CC,
  ARRAY_FIND_LAST: 0x1D9,
  ARRAY_FIND_LAST_INDEX: 0x1DA,
  MAP_SEED_FROM_ITERABLE: 0x1AC,
  SET_SEED_FROM_ITERABLE: 0x1C5,
  SETOP_HAS_DRIVEN: 0x1C6,
  SETOP_KEYS_DRIVEN: 0x1C7,
  ACCESSOR_RESOLVE: 0x1C8,
  ARRAY_FROM_SEED: 0x1C9,
  JSON_TRANSFORM: 0x1CA,
  ASSIGN_SETTERS: 0x1CB,
  PROOF_UNIVERSES: 0x279,
  BIGINT_TO_PRIMITIVE: 0x27C,
  // Regex replace/replaceAll with a callback replacement: the frame
  // holds the paused operation's NATIVE_CONTINUATION_STATE (the same
  // object CTX_REGEX_STATE roots between stagings) while the callback
  // runs; the return handler harvests the result and re-arms the
  // originating CALL instruction.
  REGEXP_REPLACE: 0x282,
  // JSON.parse with a function reviver: the bottom-up internalize walk
  // (docs mirror JSON_TRANSFORM; state array rooted the same way).
  JSON_INTERNALIZE: 0x283,
};

export const PROOF_UNIVERSES_PHASE = {
  CALLBACK_RETURNED: 0,
  CONSTRAINTS_VALIDATED: 1,
  RESULT_VALIDATED: 2,
  GENERALIZED: 3,
  RECHECKED: 4,
  PUBLISHED: 5,
};

// Note: BUILTIN IDs have been merged into METHOD for unified dispatch.
// OP.BUILTIN is no longer used; static methods use TYPE_BOUND_METHOD with METHOD IDs.

// CodeBlock flags
export const CODE_BLOCK_FLAG = {
  COMPLETE: 0x01,        // All backpatches resolved
  HAS_ERROR: 0x02,       // Parse error occurred
  IS_FUNCTION: 0x04,     // This is a function body (not top-level)
};

// Instruction size
// Layout: [opcode:1][flags:1][reserved:2][astNode:4][operand1:4][operand2:4]
// astNode is an offset into the AST region (0 = no source attribution).
// operand1/operand2 stay at their pre-source-inlining offsets (8 and 12) so
// WAT's read_operand1 / read_operand2 helpers don't shift; the AST node
// offset slot replaces the legacy srcStart/srcEnd u16 pair.
export const INSTRUCTION_SIZE = 16;
export const INSTRUCTION_AST_NODE_OFFSET = 4;

// AST region layout. The first 16 bytes of the region are a host-readable
// header. The interpreter does not interpret these — hosts coordinate
// dialect tags out-of-band — but the layout is fixed so all hosts agree
// on where to find them.
//
// Layout:
//   [dialect:u32][format_version:u16][reserved:u16][first_root:u32][last_root:u32]
//
// first_root / last_root are offsets to ROOT nodes; each ROOT carries a
// nextRoot pointer that forms a singly-linked chain of all parses. Holding
// last_root in the header gives O(1) appends.
//
// Sentinel astNode = 0 means "no AST attribution" — by convention the
// header occupies offsets 0..15 and no real node uses offset 0.
export const AST_REGION = {
  DIALECT: 0x00,           // u32: opaque dialect tag
  FORMAT_VERSION: 0x04,    // u16: schema version within a dialect
  RESERVED_HEADER: 0x06,   // u16: reserved
  FIRST_ROOT: 0x08,        // u32: offset of first ROOT in the chain
  LAST_ROOT: 0x0C,         // u32: offset of last ROOT (for O(1) appends)
};
export const AST_REGION_HEADER_SIZE = 0x10;  // 16 bytes

// =============================================================================
// Step Ring
// =============================================================================
//
// Per-instruction binary event ring. Written by the WAT interpreter inside
// the dispatch loop. Each entry captures the full observable state after an
// instruction executes; readers diff consecutive entries to reconstruct
// what changed.
//
// Ring header (16 bytes):
//   [writeHead:u32][flags:u32][formatVersion:u32][segmentGeneration:u32]
//
// Entry layout (40 bytes, naturally aligned; layout v24):
//   [publicationToken:u32][instructionIndex:u32][scopePointer:u32]
//   [heapPointer:u32][stringPointer:u32][opcode:u16][pendingDepth:u16]
//   [callDepth:u16][tryDepth:u16][grantDepth:u16][slot:u8][status:u8]
//   [errorCode:u8][completionType:u8][reserved:6 bytes]
//
// Publication: TOKEN is the
// atomically-published 1-based publication token — invalidated to the
// 0 sentinel while a slot is rewritten, republished as the exact entry
// index afterward. segmentGeneration starts at one and advances before
// writeHead wraps. formatVersion is STEP_RING_FORMAT_VERSION; pre-segment
// rings are rejected rather than presented through a compatibility shim.
export const STEP_RING_HEADER_SIZE = 16;
export const STEP_RING_ENTRY_SIZE = 40;
export const STEP_RING_FORMAT_VERSION = 3;
export const STEP_RING = {
  WRITE_HEAD: 0x00,
  FLAGS: 0x04,
  FORMAT_VERSION: 0x08,
  SEGMENT_GENERATION: 0x0C,
};
export const STEP_RING_ENTRY = {
  TOKEN: 0,
  INSTRUCTION_INDEX: 4,
  SCOPE_POINTER: 8,
  HEAP_POINTER: 12,
  STRING_POINTER: 16,
  OPCODE: 20,
  PENDING_DEPTH: 22,
  CALL_DEPTH: 24,
  TRY_DEPTH: 26,
  GRANT_DEPTH: 28,
  SLOT: 30,
  STATUS: 31,
  ERROR_CODE: 32,
  COMPLETION_TYPE: 33,
  RESERVED: 34,
};

// =============================================================================
// Header-Event Ring
// =============================================================================
//
// Records writes to global STATE.* fields:
// individual field rewrites (context-table growth, GC pointer forwarding,
// segment resize) and whole GC-cycle start/end events, in one shared ring so
// a GC-cycle entry and the field rewrites it caused interleave in write
// order. Written from both interpreter.wat (the default 'wat' GC path) and
// the JS collector/memory-image call sites (the 'js'/'differential' GC path
// and the JS-only structural writes: _growContextTable, resizeSegment,
// allocateContext's CONTEXT_COUNT bump). Header writes are rare relative to
// bytecode instructions — this is nothing like step-ring volume, so a small
// ring is fine.
//
// Ring header (16 bytes):
//   [writeHead:u32][flags:u32][formatVersion:u32][segmentGeneration:u32]
//
// Entry layout (32 bytes):
//   [kind:u8][field:u8][site:u8][slot:u8][oldValue:u32][newValue:u32]
//   [publicationToken:u32][reserved:u64][reserved:u32]
//
// Publication (layout v26):
// ENTRY_INDEX is the atomically-published 1-based publication token.
// segmentGeneration starts at one; zero is the wrap-transition seqlock.
// formatVersion is HEADER_EVENT_RING_FORMAT_VERSION; pre-segment rings
// are rejected rather than presented through a compatibility shim.
export const HEADER_EVENT_RING_HEADER_SIZE = 16;
export const HEADER_EVENT_RING_ENTRY_SIZE = 32;
export const HEADER_EVENT_RING_FORMAT_VERSION = 3;
export const HEADER_EVENT_RING = {
  WRITE_HEAD: 0x00,
  FLAGS: 0x04,
  FORMAT_VERSION: 0x08,
  SEGMENT_GENERATION: 0x0C,
};

/** Ring publication stopped permanently to prevent generation aliasing. */
export const RING_FLAG_SEGMENT_SPACE_EXHAUSTED = 0x01;
export const HEADER_EVENT_RING_ENTRY = {
  KIND: 0,
  FIELD: 1,
  SITE: 2,
  SLOT: 3,
  OLD_VALUE: 4,
  NEW_VALUE: 8,
  ENTRY_INDEX: 12,
  RESERVED: 16,
};

// kind: what this entry records.
export const HEADER_EVENT_KIND = {
  FIELD_WRITE: 0,          // a single STATE.* field was rewritten
  GC_CYCLE_START: 1,        // a full GC cycle began (mark phase)
  GC_CYCLE_END: 2,          // a full GC cycle completed (all phases done)
  CONTEXT_TABLE_GROWTH: 3,  // _growContextTable doubled the slot table
  // Read-side exception:
  // getExitCondition's defensive getContextBase(slot) === 0 branch fired
  // for a slot NOT already known free by its caller — the read-side
  // complement to FIELD_WRITE: this captures the first moment a reader
  // observed the corruption, rather than the write that caused it.
  ZERO_GUARD_FIRED: 4,
  // Written immediately after a GC_CYCLE_START entry (same pairing
  // convention as GC_CYCLE_END), carrying a snapshot of which context slots
  // were parked (allocated, non-FREE, exit condition not
  // done/error/never-run) when collection began. oldValue = total parked
  // count observed; newValue = how many were NOT recorded in the bitmap
  // (slot index >= HEADER_EVENT_PARKED_BITMAP_BITS) — a reader must treat
  // newValue > 0 as "snapshot truncated," never silently assume completeness.
  // The bitmap itself lives in the entry's RESERVED bytes (16 bytes = 128
  // bits, one per slot index 0..127).
  GC_CYCLE_PARKED_SLOTS: 5,
};

// Inline parked-slot bitmap capacity for GC_CYCLE_PARKED_SLOTS entries:
// the entry's 16 RESERVED bytes, one bit per slot index.
export const HEADER_EVENT_PARKED_BITMAP_BITS = 128;

// field: which STATE.* cell a FIELD_WRITE entry touched. Deliberately a
// SMALL enum of only fields written by this instrumentation, not a mirror
// of every STATE offset: most STATE cells (intrinsic prototypes and
// well-known symbols) are written exactly once at boot.
export const HEADER_EVENT_FIELD = {
  NONE: 0,                  // GC_CYCLE_* / no single field
  CONTEXT_TABLE_POINTER: 1,
  ROOT_SCOPE: 2,
  HEAP_POINTER: 3,
  STRING_POINTER: 4,
  HEAP_END: 5,
  STRING_START: 6,
  SEGMENT_SIZE: 7,
  CODE_POINTER: 8,
  CODE_BLOCK: 9,
  CONTEXT_COUNT: 10,
};

const HEADER_EVENT_FIELD_NAMES = Object.fromEntries(
  Object.entries(HEADER_EVENT_FIELD).map(([name, code]) => [code, name])
);

export function headerEventFieldToString(code) {
  return HEADER_EVENT_FIELD_NAMES[code] ?? `FIELD_${code}`;
}

// site: which code path made the write. A small fixed enum and one string
// constant per site suffice; no stack trace is needed.
export const HEADER_EVENT_SITE = {
  UNKNOWN: 0,
  WAT_GC_UPDATE_POINTERS: 1,     // interpreter.wat $gc_update_pointers (default GC path)
  WAT_GC_MOVE_OBJECTS: 2,        // interpreter.wat $gc_move_objects (HEAP_POINTER commit)
  // 3 retired: no WAT_GROW_CONTEXT_TABLE site exists — interpreter.wat
  // never grows the context table itself (allocateContext/
  // _growContextTable are JS-only, memory-image.js).
  JS_COLLECTOR_UPDATE_INTRINSICS: 4, // collector.js updateIntrinsics ('js'/'differential' GC path)
  JS_GROW_CONTEXT_TABLE: 5,      // memory-image.js _growContextTable
  JS_RESIZE_SEGMENT: 6,          // memory-image.js resizeSegment
  JS_ALLOCATE_CONTEXT: 7,        // memory-image.js allocateContext (CONTEXT_COUNT)
  WAT_GC_COLLECT: 8,             // interpreter.wat $gc_collect (whole-cycle GC_CYCLE_START/END)
  JS_COLLECTOR_COLLECT: 9,       // collector.js collect() (whole-cycle GC_CYCLE_START/END)
  JS_COLLECTOR_MOVE_OBJECTS: 10, // collector.js moveObjects (HEAP_POINTER commit)
  JS_MEMORY_READER_GET_EXIT_CONDITION: 11, // memory-reader.js getExitCondition's zero-guard (read-side, HEADER_EVENT_KIND.ZERO_GUARD_FIRED)
};

const HEADER_EVENT_SITE_NAMES = Object.fromEntries(
  Object.entries(HEADER_EVENT_SITE).map(([name, code]) => [code, name])
);

export function headerEventSiteToString(code) {
  return HEADER_EVENT_SITE_NAMES[code] ?? `SITE_${code}`;
}

// =============================================================================
// Reverse Lookup Helpers
// =============================================================================

// Exit condition to string
const EXIT_NAMES = {
  [EXIT_DONE]: 'done',
  [EXIT_PAUSED_FUEL]: 'paused',
  [EXIT_EXTERNAL_CALL]: 'external_call',
  [EXIT_ERROR]: 'error',
  [EXIT_GRANT_REQUEST]: 'grant_request',
  [EXIT_ASYNC_CALL]: 'async_call',
  [EXIT_ASYNC_COMPLETE]: 'async_complete',
  [EXIT_ASYNC_REJECTED]: 'async_rejected',
  [EXIT_AWAIT]: 'await',
  [EXIT_PROMISE_METHOD]: 'promise_method',
  [EXIT_EXTERNAL_PROPERTY]: 'external_property',
  [EXIT_PROMISE_SETTLE]: 'promise_settle',
  [EXIT_MEMORY_PRESSURE]: 'memory_pressure',
  [EXIT_EXTERNAL_PROPERTY_SET]: 'external_property_set',
  [EXIT_GENERATOR_CALL]: 'generator_call',
  [EXIT_GENERATOR_NEXT]: 'generator_next',
  [EXIT_GENERATOR_YIELD]: 'generator_yield',
  [EXIT_GENERATOR_COMPLETE]: 'generator_complete',
  [EXIT_GENERATOR_THROW]: 'generator_throw',
  [EXIT_CLASS_LINK_EXTERNAL]: 'class_link_external',
  [EXIT_INSTANCEOF_EXTERNAL]: 'instanceof_external',
  [EXIT_EXTERNAL_HAS_PROPERTY]: 'external_has_property',
  [EXIT_EXTERNAL_DELETE_PROPERTY]: 'external_delete_property',
};

export function exitConditionToString(code) {
  return EXIT_NAMES[code] ?? `unknown_${code}`;
}

// Error code to string
const ERROR_NAMES = {
  [ERR_NONE]: 'NONE',
  [ERR_UNDEFINED_VARIABLE]: 'UNDEFINED_VARIABLE',
  [ERR_ASSIGN_UNDEFINED]: 'ASSIGN_UNDEFINED',
  [ERR_NOT_CALLABLE]: 'NOT_CALLABLE',
  [ERR_NOT_ITERABLE]: 'NOT_ITERABLE',
  [ERR_PROPERTY_NULL]: 'PROPERTY_NULL',
  [ERR_INVALID_OPERAND]: 'INVALID_OPERAND',
  [ERR_STACK_OVERFLOW]: 'STACK_OVERFLOW',
  [ERR_TYPE_ERROR]: 'TYPE_ERROR',
  [ERR_ARITY]: 'ARITY',
  [ERR_USER_THROW]: 'USER_THROW',
  [ERR_MSGPACK_READONLY]: 'MSGPACK_READONLY',
  [ERR_MSGPACK_INVALID]: 'MSGPACK_INVALID',
  [ERR_NOT_SUPPORTED]: 'NOT_SUPPORTED',
  [ERR_REDECLARATION]: 'REDECLARATION',
  [ERR_OUT_OF_MEMORY]: 'OUT_OF_MEMORY',
  [ERR_MISSING_REGION]: 'MISSING_REGION',
  [ERR_CONST_ASSIGNMENT]: 'CONST_ASSIGNMENT',
  [ERR_GRANT_DENIED]: 'GRANT_DENIED',
  [ERR_RANGE_ERROR]: 'RANGE_ERROR',
  [ERR_SYNTAX_ERROR]: 'SYNTAX_ERROR',
  [ERR_JSON_PARSE]: 'JSON_PARSE',
  [ERR_JSON_STRINGIFY]: 'JSON_STRINGIFY',
  [ERR_UNKNOWN_OPCODE]: 'UNKNOWN_OPCODE',
  [ERR_STACK_UNDERFLOW]: 'STACK_UNDERFLOW',
  [ERR_CORRUPT_OPERAND]: 'CORRUPT_OPERAND',
  [ERR_HEAP_CODE_COLLISION]: 'HEAP_CODE_COLLISION',
};

export function errorCodeToString(code) {
  return ERROR_NAMES[code] ?? `UNKNOWN_${code}`;
}

// =============================================================================
// Promise
// =============================================================================

// Promise status values
export const PROMISE_STATUS_PENDING = 0;
export const PROMISE_STATUS_RESOLVED = 1;
export const PROMISE_STATUS_REJECTED = 2;

// Promise layout (offsets from data pointer)
// Total data size: 40 bytes (+ 8 byte GC header = 48 bytes)
export const PROMISE = {
  STATUS: 0x00,           // 4 bytes: 0=pending, 1=resolved, 2=rejected
  VALUE: 0x04,            // 16 bytes: inline tagged value
  WAITERS: 0x14,          // 4 bytes: head of waiting context list (-1 for empty)
  HANDLERS: 0x18,         // 4 bytes: head of .then() handler list (-1 for none)
  // padding to 40 bytes
};
export const PROMISE_DATA_SIZE = 40;

export const PROMISE_WAITER = {
  CONTEXT_SLOT: 0x00,
  CONTEXT_GENERATION: 0x04,
  NEXT: 0x08,
};
export const PROMISE_WAITER_DATA_SIZE = 16;
export const PROMISE_WAITER_TOTAL_SIZE = 32;

// ThenHandler heap object for .then()/.catch()/.finally()
export const THEN_HANDLER = {
  ON_RESOLVED: 0x00,      // 4 bytes: closure pointer (0 if none)
  ON_REJECTED: 0x04,      // 4 bytes: closure pointer (0 if none)
  CHILD_PROMISE: 0x08,    // 4 bytes: promise data pointer
  NEXT: 0x0C,             // 4 bytes: next handler pointer (-1 for end)
  FLAGS: 0x10,            // 4 bytes: bit 0 = isFinally
};
export const THEN_HANDLER_DATA_SIZE = 24;
export const THEN_HANDLER_FLAG_FINALLY = 1;

// Opcode to string (reverse lookup from OP object)
const OP_NAMES = Object.fromEntries(
  Object.entries(OP).map(([name, code]) => [code, name])
);

export function opcodeToString(code) {
  return OP_NAMES[code] ?? `OP_${code.toString(16)}`;
}

// Type tag to string (reverse lookup from TYPE object)
const TYPE_NAMES = Object.fromEntries(
  Object.entries(TYPE).map(([name, code]) => [code, name])
);

export function typeToString(code) {
  return TYPE_NAMES[code] ?? `TYPE_${(code >>> 0).toString(16)}`;
}

// Engine ABI constants, re-exported so the layout verifier can check the
// interpreter's mirrored $REGEX_STATUS_* / $REGEX_SCAN_* / $REGEX_EMIT_*
// globals against one source. The SCAN/EMIT address fields are the
// documented workspace-header slots the interpreter rebinds with fresh
// absolute addresses when resuming a paused engine operation after the
// collector may have relocated the pattern string or buffers.
export { REGEX_STATUS } from './regex-engine-contract.js';
// Accepted flag bits, re-exported as REGEXP_FLAG so the verifier can
// check the interpreter's mirrored $REGEXP_FLAG_* globals.
export { REGEX_FLAG as REGEXP_FLAG } from './regex-engine-contract.js';
import { REGEX_COMPILER, REGEX_CONTINUATION, REGEX_PROGRAM } from './regex-engine-contract.js';
export const REGEX_SCAN = REGEX_COMPILER.SCAN;
export const REGEX_EMIT = REGEX_COMPILER.EMIT;
// Match-continuation header facts consumed by the interpreter's exec/test
// step: the absolute program/input address slots it rebinds on resume, the
// result fields it materializes from, and the unset-position sentinel.
export const REGEX_CONT = {
  ...REGEX_CONTINUATION.HEADER,
  HEADER_SIZE: REGEX_CONTINUATION.HEADER_SIZE,
  NO_POSITION: REGEX_CONTINUATION.NO_POSITION,
};
// Retained-program header facts (sizing the match continuation and walking
// the capture-name records).
export const REGEX_PROG = {
  ...REGEX_PROGRAM.HEADER,
  HEADER_SIZE: REGEX_PROGRAM.HEADER_SIZE,
  INSTRUCTION_SIZE: REGEX_PROGRAM.INSTRUCTION_SIZE,
};
// Schema engine ABI facts the interpreter mirrors as $SCHEMA_STATUS_*,
// $SCHEMA_OPT_*, $SCHEMA_MODE_*, $SCHEMA_CH_* (continuation header),
// $SCHEMA_WH_* (compile workspace header), and $SCHEMA_DIAG_* globals.
export { SCHEMA_STATUS } from './schema-engine-contract.js';
import { SCHEMA_COMPILE, SCHEMA_CONTINUATION, SCHEMA_LIMIT, SCHEMA_PROGRAM } from './schema-engine-contract.js';
export const SCHEMA_OPT = SCHEMA_PROGRAM.OPTION;
export const SCHEMA_MODE = SCHEMA_CONTINUATION.MODE;
export const SCHEMA_CH = SCHEMA_CONTINUATION.HEADER;
export const SCHEMA_WH = SCHEMA_COMPILE.HEADER;
export const SCHEMA_DIAG = SCHEMA_COMPILE.DIAGNOSTIC;
export const SCHEMA_LIMITS = { ...SCHEMA_LIMIT, RENDER_TABLE_BYTES: 1280 };
// The interpreter's Schema operation state machine (NATIVE_CONTINUATION_STATE
// word 0): phase in bits 0-7 (16+ so a RegExp phase faults loud), result
// kind in bits 8-11, flags above, VALIDATE-mode error capacity in 16-31.
// Shared native continuation phase families: RegExp 1..10, Schema 16..23,
// Proof 32..47. Proof state0 stores methodId above the low-byte phase.
export const PROOF_PH = {
  PREPARE: 32,
  ARTIFACT: 33,
  TERM: 34,
  COMPACT: 35,
  PUBLISH: 36,
  COMPOSE_EXPECTED: 37,
  START_TERM: 38,
  // Builder methods and ordinary composition have disjoint dispatch.
  BUILDERS_PREPARE: 37,
  TRANSFER: 39,
  BUILDERS_WORK: 40,
  BUILDERS_COMMIT: 41,
  STATE_START: 42,
  STATE_WORK: 43,
  STATE_COMPACT: 44,
  ELABORATION_PREPARE: 45,
  ELABORATION_WORK: 46,
  ELABORATION_RESULT: 47,
};

export const SCHEMA_PH = {
  VALIDATE_RUN: 17,
  VALIDATE_MATERIALIZE: 18,
  COMPILE_MEASURE: 20,
  COMPILE_EMIT: 21,
  COMPILE_TO_VALIDATE: 22,
  COMPILE_MEASURED: 23,
};
export const SCHEMA_KIND = { TEST: 0, VALIDATE: 1, ASSERT: 2, ERRORS: 3, COMPILE: 4, MATCH: 5, MATCH_ALL: 6 };
export const SCHEMA_FLAG = { ONE_SHOT: 0x1000, DOC_REF: 0x2000, SET: 0x4000 };
// Keyword codes by SCREAMING_SNAKE name ($SCHEMA_KW_* in the interpreter's
// validation-message composer): index into KEYWORD_NAMES.
import { KEYWORD_NAMES as SCHEMA_KEYWORD_NAMES } from './schema-engine-contract.js';
export const SCHEMA_KW = Object.freeze(Object.fromEntries(
  SCHEMA_KEYWORD_NAMES.map((name, code) => [
    name.replace(/^\$/, 'DOLLAR_').replace(/([a-z])([A-Z])/g, '$1_$2').toUpperCase(),
    code,
  ]).filter(([name]) => name !== ''),
));

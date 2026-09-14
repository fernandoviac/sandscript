// Shared ABI constants for the standalone JSON Schema WASM engine.
// Keep these values mirrored in schema-engine.wat. The engine owns no
// memory: every structure below lives in caller-owned linear memory at
// an absolute address, and every header carries a magic + version that
// the engine checks on entry.

export const SCHEMA_STATUS = Object.freeze({
  OK: 0,
  PAUSED: 1,
  VALID: 2,
  INVALID: 3,
  SYNTAX_ERROR: 4,      // malformed schema (keyword shape, bad pointer, unresolvable $ref)
  UNSUPPORTED: 5,       // accepted by the spec, refused by this engine (regex dialect, bignum)
  LIMIT_EXCEEDED: 6,
  BUFFER_TOO_SMALL: 7,
  CORRUPT_PROGRAM: 8,
  CORRUPT_DOCUMENT: 9,  // malformed msgpack, non-string map key
  INVALID_UTF8: 10,
  WORK_LIMIT_EXCEEDED: 11, // terminal aggregate exhaustion; never a nonmatch or scheduling pause
  INVALID_ARGUMENT: 12,   // checked direct boundary refused spans/options/state
});

export const SCHEMA_LIMIT = Object.freeze({
  MAX_SCHEMA_BYTES: 4 * 1024 * 1024,
  MAX_NODES: 1 << 20,
  MAX_KEY_TABLE_ENTRIES: 65536,
  MAX_ENUM_MEMBERS: 65536,
  MAX_STATIC_DEPTH: 256,      // schema nesting (compile frames)
  MAX_POINTER_BYTES: 4096,    // one node's JSON pointer text
  DEFAULT_MAX_DEPTH: 256,     // validation frames
  DEFAULT_ARENA_BYTES: 16384,
  DEFAULT_ERROR_CAPACITY: 64,
  ERROR_PATH_BYTES: 128,      // per stored error: JSON pointer text + string params
  HASH_DEPTH: 64,             // structural hash / equality recursion bound
});

// JSON type bits. A document value's mask has NUMBER|INTEGER for
// integers (including integral floats), NUMBER alone for other floats.
export const JSON_TYPE = Object.freeze({
  NULL: 1,
  BOOLEAN: 2,
  NUMBER: 4,
  INTEGER: 8,
  STRING: 16,
  ARRAY: 32,
  OBJECT: 64,
});

export const JSON_TYPE_NAMES = Object.freeze({
  null: JSON_TYPE.NULL,
  boolean: JSON_TYPE.BOOLEAN,
  number: JSON_TYPE.NUMBER | JSON_TYPE.INTEGER,
  integer: JSON_TYPE.INTEGER,
  string: JSON_TYPE.STRING,
  array: JSON_TYPE.ARRAY,
  object: JSON_TYPE.OBJECT,
});

// Compiled program. Position-independent: every offset is relative to
// the program start. NONE marks an absent node reference.
export const SCHEMA_PROGRAM = Object.freeze({
  MAGIC: 0x48435353, // "SSCH" in little-endian memory
  VERSION: 2,        // v2: schema sets (route and gate tables, 80-byte header)
  HEADER_SIZE: 80,
  NODE_SIZE: 16,
  INSTRUCTION_SIZE: 16,
  NONE: 0xffffffff,
  TRUE_NODE: 0,
  FALSE_NODE: 1,
  HEADER: Object.freeze({
    MAGIC: 0,
    VERSION: 4,
    TOTAL_BYTES: 8,
    ROOT_NODE: 12,
    NODE_COUNT: 16,
    NODE_TABLE_OFFSET: 20,
    CODE_OFFSET: 24,
    CODE_BYTES: 28,
    POOL_OFFSET: 32,
    POOL_BYTES: 36,
    RESOURCE_TABLE_OFFSET: 40,
    RESOURCE_COUNT: 44,
    MAX_STATIC_DEPTH: 48,
    MAX_REGEX_CONTINUATION: 52,
    FLAGS: 56,
    SCHEMA_BYTES: 60,
    // Schema sets (VERSION 2). ROUTE_COUNT is 0 for a single-schema program.
    ROUTE_TABLE_OFFSET: 64,  // per route [node:4][gate count:4][flags:4][reserved:4]
    ROUTE_COUNT: 68,
    GATE_TABLE_OFFSET: 72,   // open-addressing table of GATE_ENTRY_SIZE entries
    GATE_CAPACITY: 76,       // power of two
  }),
  NODE: Object.freeze({
    CODE_OFFSET: 0,
    SCHEMA_OFFSET: 4,     // offset of the node's value inside the schema bytes; NONE for synthesized
    POINTER_STRING: 8,    // pool string record: "#/properties/x" (schemaPath)
    FLAGS: 12,
  }),
  NODE_FLAG: Object.freeze({
    TRACK_EVALUATED: 1,
  }),
  // Compile options word.
  OPTION: Object.freeze({
    STRICT: 1,
    FORMAT_ANNOTATE: 2,
    DIALECT_07: 4,      // $ref replaces its siblings
    DIALECT_04: 8,      // as 07, plus boolean exclusiveMaximum/Minimum
    SET: 16,            // the bundle root is an array of routes (a schema set)
  }),
  // Set tables (plan "Schema sets"). A gate table entry:
  //   [hash:4][key pool string:4][value pool record | NONE:4][type mask:4][bitset pool offset:4]
  GATE_ENTRY_SIZE: 20,
  ROUTE_ENTRY_SIZE: 16,
  ROUTE_FLAG: Object.freeze({
    FULL: 1,          // every root keyword is gate-decidable: all gates hit = matched
    ROOT_OBJECT: 2,   // the route requires an object document
  }),
});

// Instruction records are [opcode:4][a:4][b:4][c:4].
export const SCHEMA_OPCODE = Object.freeze({
  END: 0,
  FAIL: 1,                  // boolean false schema
  TYPE: 2,                  // a = JSON_TYPE mask
  CONST: 3,                 // a = pool value record
  ENUM: 4,                  // a = pool enum record
  MINIMUM: 5,               // a = pool value record holding a msgpack number
  MAXIMUM: 6,
  EXCLUSIVE_MINIMUM: 7,
  EXCLUSIVE_MAXIMUM: 8,
  MULTIPLE_OF: 9,
  MIN_LENGTH: 10,           // a = limit
  MAX_LENGTH: 11,
  MIN_ITEMS: 12,
  MAX_ITEMS: 13,
  MIN_PROPERTIES: 14,
  MAX_PROPERTIES: 15,
  OBJECT_PASS: 16,          // a = pool object table
  ARRAY_PASS: 17,           // a = pool array table
  ALL_OF: 18,               // a = pool node list
  ANY_OF: 19,
  ONE_OF: 20,
  NOT: 21,                  // a = node
  IF: 22,                   // a = if node, b = then node | NONE, c = else node | NONE
  REF: 23,                  // a = node
  PATTERN: 24,              // a = pool regex program (Item 2)
  FORMAT: 25,               // a = format id (Item 2)
  DYNAMIC_REF: 26,          // (Item 3)
  UNEVALUATED_PROPERTIES: 27,
  UNEVALUATED_ITEMS: 28,
});

// Pool records.
//   string:  [byteLength:4][bytes][pad to 4]
//   value:   [byteLength:4][structuralHash:4][msgpack bytes][pad to 4]
//   list:    [count:4][u32 items...]
//   enum:    [count:4][value record offsets...]
export const SCHEMA_POOL = Object.freeze({
  STRING_HEADER: 4,
  VALUE_HEADER: 8,
  OBJECT_TABLE: Object.freeze({
    ENTRY_COUNT: 0,
    CAPACITY: 4,          // power of two, 0 when there are no entries
    ENTRIES_OFFSET: 8,    // pool offset of CAPACITY hash entries
    BIT_COUNT: 12,        // seen-bit count (one per entry)
    REQUIRED_LIST: 16,    // pool list of entry indices, or NONE
    ADDITIONAL_NODE: 20,  // node or NONE
    PROPERTY_NAMES_NODE: 24,
    PATTERN_COUNT: 28,    // Item 2
    PATTERN_LIST: 32,     // pool record [count:4][(regex record, node) × count]
    FLAGS: 36,
    SIZE: 40,
  }),
  OBJECT_ENTRY: Object.freeze({
    HASH: 0,
    KEY: 4,               // pool string record, or NONE when the slot is empty
    CHILD_NODE: 8,        // node or NONE (required-only / dependency-only key)
    SEEN_BIT: 12,
    DEPENDENCY: 16,       // pool dependency record or NONE
    SIZE: 20,
  }),
  // dependency record: [requiredCount:4][schemaNode:4][required entry indices...]
  DEPENDENCY: Object.freeze({
    REQUIRED_COUNT: 0,
    SCHEMA_NODE: 4,
    ENTRIES: 8,
  }),
  ARRAY_TABLE: Object.freeze({
    PREFIX_COUNT: 0,
    PREFIX_LIST: 4,       // pool node list or NONE
    ITEMS_NODE: 8,
    CONTAINS_NODE: 12,
    MIN_CONTAINS: 16,
    MAX_CONTAINS: 20,     // NONE when absent
    UNIQUE: 24,
    FLAGS: 28,
    SIZE: 32,
  }),
});

// Work accounting ABI (independent of portable PROGRAM versions):
// compile_work_charged(ws) / validation_work_charged(cont) -> Wasm i64,
// interpreted as u64 (JS callers use BigInt.asUintN(64, value)).
// *_work_overflow(pointer) -> i32 is sticky on checked-u64 overflow; total
// then saturates to UINT64_MAX. Initialization starts a new phase/attempt.
// Legacy *_fuel_charged accessors saturate at INT32_MAX. Remaining fuel is
// exact when representable, otherwise INT32_MIN; it is NOT an exact charge
// channel in that case. Drivers must use the wide totals, never wrapped deltas.
// Initialization has no fuel result: its debt is deducted by the first
// positive stepped call. Zero-grant validation neither executes nor spends
// that debt. A sufficiently sized caller header retains failure accounting,
// but a failed initialization does not produce a runnable continuation.
// Old workspaces/continuations must be restarted, not rebound under this
// version. PROGRAM v2 bytes and completed compiled descriptors are unchanged.

// Compile workspace (measure and emission share one layout; emission
// appends the node-offset hash map).
export const SCHEMA_COMPILE = Object.freeze({
  MAGIC: 0x57435353, // "SSCW"
  VERSION: 2,           // v2: appended wide meter and resumable finalization
  HEADER_SIZE: 360,
  FRAME_SIZE: 328,
  SLOT_COUNT: 64,
  KEYWORD_TABLE_BYTES: 2048,   // keyword names + index, then format names + index
  HEADER: Object.freeze({
    MAGIC: 0,
    VERSION: 4,
    SCHEMA_ADDRESS: 8,
    SCHEMA_BYTES: 12,
    PASS: 16,             // 1 measure, 2 emit, 3 fixup, 4 complete
    OPTIONS: 20,
    FRAME_COUNT: 24,
    FRAME_CAPACITY: 28,
    FRAMES_OFFSET: 32,
    NODE_COUNT: 36,
    CODE_BYTES: 40,
    POOL_BYTES: 44,
    MAX_DEPTH: 48,
    PROGRAM_ADDRESS: 52,
    PROGRAM_CAPACITY: 56,
    CODE_CURSOR: 60,
    POOL_CURSOR: 64,
    DIAGNOSTIC_CODE: 68,
    DIAGNOSTIC_KEYWORD: 72,
    DIAGNOSTIC_OFFSET: 76,
    KEYWORD_TABLE_OFFSET: 80,
    POINTER_BYTES: 84,
    POINTER_OFFSET: 88,
    MAP_OFFSET: 92,       // emission: schema offset → node id map
    MAP_CAPACITY: 96,
    FIXUP_CURSOR: 100,
    MAX_REGEX_CONTINUATION: 104,
    ROOT_NODE: 108,
    FUEL_CHARGED: 112,
    TABLE_COUNTER: 116,
    MEASURED_NODES: 120,
    VISITED_OFFSET: 124,
    EXTRA_OFFSET: 128,
    EXTRA_COUNT: 132,
    EXTRA_CURSOR: 136,
    DIAGNOSTIC_DETAIL: 140,  // regex engine status for DIAGNOSTIC.REGEX
    RSCAN_OFFSET: 144,
    RSCAN_BYTES: 148,
    REMIT_OFFSET: 152,
    REMIT_BYTES: 156,
    WORK_CHARGED: 320,      // u64, saturates at UINT64_MAX
    WORK_OVERFLOW: 328,     // u32, sticky until initialization
    WORK_PENDING: 336,      // u64 setup/scheduling debt, capped at 2^32
    FINAL_PHASE: 344,       // 0 walk, 1 resources, 2 fixup, 3 track, 4 check
    FINAL_CURSOR: 348,      // next resource to finalize
    FINAL_TABLE: 352,       // resource table pool offset (not an address)
    TRACK_SEEDED: 356,
  }),
  PASS: Object.freeze({
    MEASURE: 1,
    EMIT: 2,
    FIXUP: 3,
    COMPLETE: 4,
  }),
  // Diagnostic codes written with SYNTAX_ERROR / UNSUPPORTED.
  DIAGNOSTIC: Object.freeze({
    NONE: 0,
    SCHEMA_NOT_OBJECT: 1,     // a schema position holds neither object nor boolean
    KEYWORD_SHAPE: 2,         // keyword value has the wrong type
    REF_UNRESOLVABLE: 3,
    REF_NOT_LOCAL: 4,         // retired (resources landed); kept for numbering
    DEPTH: 5,
    POINTER_LENGTH: 6,
    NODE_COUNT: 7,
    TABLE_SIZE: 8,
    UNKNOWN_KEYWORD: 9,       // strict mode
    REGEX: 10,                // regex engine status in DIAGNOSTIC_DETAIL
    UNKNOWN_FORMAT: 11,
    BIGNUM: 12,
  }),
});

// Validation continuation.
export const SCHEMA_CONTINUATION = Object.freeze({
  MAGIC: 0x56435353, // "SSCV"
  VERSION: 3,        // v3: appended source-owned wide work meter
  HEADER_SIZE: 168,
  FRAME_SIZE: 64,
  PATH_ENTRY_SIZE: 12,
  ERROR_SIZE: 32,
  HEADER: Object.freeze({
    MAGIC: 0,
    VERSION: 4,
    PROGRAM_ADDRESS: 8,
    PROGRAM_BYTES: 12,
    DOCUMENT_ADDRESS: 16,
    DOCUMENT_BYTES: 20,
    MODE: 24,
    PHASE: 28,
    FRAME_COUNT: 32,
    FRAME_CAPACITY: 36,
    FRAMES_OFFSET: 40,
    PATH_COUNT: 44,
    PATH_OFFSET: 48,
    ARENA_OFFSET: 52,
    ARENA_CURSOR: 56,
    ARENA_CAPACITY: 60,
    ERROR_COUNT: 64,
    ERROR_CAPACITY: 68,
    ERROR_STORED: 72,
    ERRORS_OFFSET: 76,
    ERROR_PATH_OFFSET: 80,   // path/param text region
    ERROR_PATH_CURSOR: 84,
    ERROR_PATH_CAPACITY: 88,
    RESULT: 92,
    FUEL_CHARGED: 96,
    TRIAL_DEPTH: 100,
    ARENA_REQUIRED: 104,
    REGEX_OFFSET: 108,
    REGEX_CAPACITY: 112,
    GRANT: 116,              // fuel available to the current step (regex sub-runs read it)
    // Schema sets: ROUTE_COUNT is 0 for a single-schema run.
    ROUTES_OFFSET: 120,      // per-route result table (ROUTE_RESULT)
    ROUTE_CURSOR: 124,       // -1 = gate pass pending; else the route being decided
    ROUTE_ABORT: 128,        // TEST-mode error inside a route: finish that route only
    ROUTE_COUNT: 132,
    WORK_CHARGED: 144,      // u64; includes initialization, even on failure
    WORK_OVERFLOW: 152,     // u32, sticky until initialization
    WORK_PENDING: 160,      // u64 setup/scheduling debt, capped at 2^32
  }),
  MODE: Object.freeze({
    TEST: 0,
    VALIDATE: 1,
    TRUSTED: 2,   // OR-ed in: skip validate_program (already validated by compile/load)
  }),
  PHASE: Object.freeze({
    RUNNING: 0,
    COMPLETE: 1,
  }),
  FRAME: Object.freeze({
    KIND: 0,
    NODE: 4,
    PC: 8,
    VALUE: 12,
    PATH_CURSOR_MARK: 16,
    CURSOR: 20,
    INDEX: 24,
    COUNT: 28,
    AUX: 32,
    AUX2: 36,
    AUX3: 40,
    ERROR_MARK: 44,
    ERROR_CURSOR_MARK: 48,
    ARENA_MARK: 52,
    CHILD_RESULT: 56,
    FLAGS: 60,
  }),
  FRAME_KIND: Object.freeze({
    NODE: 0,
    OBJECT_PASS: 1,
    ARRAY_PASS: 2,
    ALL_OF: 3,
    ANY_OF: 4,
    ONE_OF: 5,
    NOT: 6,
    IF: 7,
    REGEX: 8,
  }),
  FRAME_FLAG: Object.freeze({
    TRIAL: 1,          // failures inside are discarded by the parent
    PATH_PUSHED: 2,    // pop must pop one path segment
    CONTAINS_TRIAL: 4, // result feeds the parent's contains counter
    REGEX_PENDING: 8,  // a regex child just finished; CHILD_RESULT is its verdict
    MATCHED: 16,       // object pass: a patternProperties pattern matched the key
  }),
  ERROR: Object.freeze({
    KEYWORD: 0,        // u16
    PARAM_KIND: 2,     // u16
    NODE: 4,
    PATH_OFFSET: 8,    // into the error-path region: instancePath text
    PATH_BYTES: 12,
    PARAM_A: 16,
    PARAM_B: 20,
    PARAM_C: 24,
    RESERVED: 28,
  }),
  // Per-route result record in the continuation's route table.
  ROUTE_RESULT: Object.freeze({
    VERDICT: 0,       // 1 matched
    ERROR_START: 4,   // first stored error record index of this route
    ERROR_COUNT: 8,   // stored records for this route (VALIDATE mode)
    HITS: 12,         // gate hits from the gate pass
    SIZE: 16,
  }),
  PARAM_KIND: Object.freeze({
    NONE: 0,
    TYPE_MASK: 1,        // a = expected mask
    POOL_VALUE: 2,       // a = pool value record (const / enum / numeric limit)
    LIMIT: 3,            // a = integer limit
    POOL_STRING: 4,      // a = pool string (required.missingProperty)
    TEXT: 5,             // a = error-path region offset, b = byte length (additionalProperty, propertyName)
    INDICES: 6,          // a = i, b = j (uniqueItems)
    COUNT: 7,            // a = passing schemas (oneOf), contains counts
    DEPENDENCY: 8,       // a = pool string property, b = pool string missing
  }),
});

// Allocation-free reuse of the engine's exact Number#toString formatter.
// format_number(value:f64, output:i32, outputCapacity:i32,
//               scratch:i32, scratchCapacity:i32)
//   -> (status:i32, bytes:i32, work:u64, overflow:i32)
// All declared spans must fit memory and be disjoint; scratch is 8-aligned.
// INVALID_ARGUMENT precedes BUFFER_TOO_SMALL. Either refusal writes nothing
// and returns bytes/work/overflow = 0. Capacities below these minima return
// BUFFER_TOO_SMALL independently of the value; only OK returns a byte length.
// Text includes NaN/infinities and maps -0 to 0. No terminator is written.
// Scratch is overwritten; output stays caller-owned. No persistent state or
// memory growth occurs. Charge the returned actual atomic work in the caller's
// operation; this primitive does not initialize or replenish a direct budget.
export const SCHEMA_NUMBER_TEXT = Object.freeze({
  OUTPUT_BYTES: 32,
  SCRATCH_BYTES: 864,
});

// Full ECMAScript Number(string), not parseFloat or the JSON-only fast path.
// parse_number_utf16(input:i32, byteLength:i32, scratch:i32, scratchCapacity:i32)
//   -> (status:i32, value:f64, work:u64, overflow:i32)
// Input is UTF-16LE, byteLength is even, and scratch is disjoint and 8-aligned.
// Empty/whitespace input becomes +0; signs, decimal fractions/exponents,
// unsigned 0x/0o/0b prefixes and Infinity follow StringNumericLiteral.
// Invalid numeric syntax is successful NaN, not an ABI/resource error.
// Invalid spans/odd byteLength return INVALID_ARGUMENT before capacity checks.
// Short scratch returns BUFFER_TOO_SMALL. Refusals write nothing and return
// NaN with zero work/overflow. Successful scratch contents are unspecified.
// No allocation, callbacks, persistent state or growth. The caller charges
// actual atomic work (including all input scanning and exact rounding).
export const SCHEMA_NUMBER_PARSE = Object.freeze({ SCRATCH_BYTES: 320 });

// Exact Number#toString(16), including every subnormal fractional digit.
// format_number_hex(value:f64, output:i32, outputCapacity:i32)
//   -> (status:i32, bytes:i32, work:u64, overflow:i32)
// Requires this complete output reservation; no scratch or terminator.
// Same span/capacity refusal precedence and no-write semantics as format_number.
// Finite values use exact hexadecimal digits; -0 becomes "0", and nonfinite
// spellings share the decimal formatter's catalogue. Charge actual atomic work.
export const SCHEMA_NUMBER_HEX = Object.freeze({ OUTPUT_BYTES: 320 });

// Run-to-completion helpers (all parameters/results i32 except allowance:i64).
// initialize_work_budget(budget, capacity, allowance, flags) -> status
// compile_direct(schema, schemaBytes, options, scratch, capacity, budget,
//                initialize, grantCap) -> (status, requiredBytes)
// validate_direct(program, programCapacity, document, documentBytes, mode,
//                 maxDepth, errorCapacity, arenaBytes, scratch, capacity,
//                 budget, initialize, grantCap) -> (status, requiredBytes)
// render_error_direct(program, programCapacity, scratch, scratchCapacity,
//                     index, output, outputCapacity, budget) -> (status, bytes)
// render_failure_direct(scratch, scratchCapacity, output, outputCapacity,
//                       budget) -> (status, bytes)
// The failure renderer consumes immutable TERMINAL compile/validation scratch
// and the same budget, without its retired inputs. It returns MessagePack
// {message,status,diagnostic?,keyword?,schemaOffset?,detail?}, matching SchemaError
// data; it contains no consumer context. Output, scratch and budget are disjoint.
// Output shortage recommends max(2048,2*capacity), bounded by 1 GiB. Every attempt
// is charged under RENDER; sticky exhaustion forbids rendering. No failed
// operation is restarted or recharged. Facade-only terminal compatibility
// includes this bounded error formatting in the already-settled atomic failure.
//
// The renderer's second result is written bytes on OK, otherwise the next
// output capacity on BUFFER_TOO_SMALL (max(8192, 2*capacity), bounded by 1 GiB).
// It is a sizing recommendation, not an exact length. Preserve the completed
// validation scratch and immutable program/document on every output retry;
// failed output bytes are unspecified. Raw/complete renderer exports remain.
//
// Owner spans (inputs/program, scratch, 48-byte budget, diagnostic output)
// must be disjoint, in memory, and single-owner during execution. Program,
// budget and scratch addresses are 8-aligned; input/output bytes need not be.
// No allocation, memory.grow, host callback, scheduler, or hidden handle.
// Scratch/budget contents are engine-owned opaque state: do not mutate them.
// initialize=1 starts scratch state but NEVER replenishes the separate budget.
// initialize=0 accepts only resource re-entry or retained terminal results.
// On capacity <64 no scratch is written; grow and use initialize=1 again.
// Copy exactly LIVE_BYTES when relocating scratch at a resource return.
// Inputs may relocate there only with identical bytes and unchanged lengths/
// options. arenaBytes is initial policy input, ignored on resource re-entry;
// SELECTED_ARENA is the retained engine decision. Completed scratch/inputs
// stay live and unmodified through result access and rendering.
//
// Strict mode always checks program internals under PROGRAM_CHECK, including
// when MODE.TRUSTED is supplied. Successful checking is retained across sizing
// returns; it is not repeated on arena growth. Initialization and every source
// meter delta are debited before deciding the next phase/attempt. Setup debt
// already debited by strict helpers is removed from the scheduling-only pending
// counter, never from authoritative consumed work. Complete rendering debits
// its source-returned total on every attempt, including output shortages.
//
// Checked u64 addition saturates on overflow and sticks at status 11; finite
// allowances are 0..UINT64_MAX-1. Strict atomic overrun wins even over terminal
// success/error; exact terminal completion is allowed, unfinished equality
// exhausts. No helper returns PAUSED. grantCap=0 chooses 2^30, else 1..INT_MAX.
// Flags below are facade-only compatibility, never valid Velk routing policy.
// FACADE_TERMINAL allows an atomic terminal result to win over finite overrun
// (not overflow). Successful setup plus the first stepped call retain the old
// facade's single positive grant boundary; all source work is still debited.
// Only this flag together with MODE.TRUSTED skips a program check: the facade
// promises compile/load already checked byte-identical live bytes. Subsequent
// phases/retries/render records require positive remaining allowance. Nothing
// replenishes or wraps accounting, even with FACADE_UNLIMITED.
export const SCHEMA_WORK_BUDGET = Object.freeze({
  MAGIC: 0x42575353,
  VERSION: 1,
  SIZE: 48,
  FLAG: Object.freeze({ FACADE_UNLIMITED: 1, FACADE_TERMINAL: 2 }),
  HEADER: Object.freeze({
    MAGIC: 0, VERSION: 4, FLAGS: 8, TERMINAL_STATUS: 12,
    ALLOWANCE: 16, CONSUMED: 24, PHASE: 32, ENGINE_STATUS: 36,
    ROUTE: 40, OVERFLOW: 44,
  }),
  PHASE: Object.freeze({
    INPUT: 1, MEASURE: 2, EMIT: 3, FINALIZE: 4, VALIDATION_SETUP: 5,
    VALIDATE: 6, RENDER: 7, PROGRAM_CHECK: 8,
  }),
});

// Compile: [header][align8(workspace)][measured program bound]. In-place
// emission initialization reuses the measurement; no remeasurement on growth.
// RESULT_OFFSET/RESULT_CAPACITY describe the borrowed program on success.
// Validation: [header][continuation]; result offset is 64. Arena retry only
// follows LIMIT_EXCEEDED with ARENA_REQUIRED > ARENA_CAPACITY and chooses
// max(required, 2*capacity), <=256 MiB. Retry discards continuation (live=64),
// retains aggregate debt, and initializes fresh even if the address is stable.
// Unexpected compiler BUFFER_TOO_SMALL has no proven bound: terminal
// LIMIT_EXCEEDED, with original status 7 retained in the budget.
export const SCHEMA_DIRECT = Object.freeze({
  MAGIC: 0x4f575353,
  VERSION: 1,
  HEADER_SIZE: 64,
  KIND: Object.freeze({ COMPILE: 1, VALIDATE: 2 }),
  STATE: Object.freeze({
    NEED_WORKSPACE: 1, NEED_EMISSION: 2, NEED_VALIDATION: 3,
    COMPLETE: 4, TERMINAL: 5,
  }),
  HEADER: Object.freeze({
    MAGIC: 0, VERSION: 4, KIND: 8, STATE: 12, STATUS: 16, REQUIRED_BYTES: 20,
    LIVE_BYTES: 24, WORKSPACE_BYTES: 28, RESULT_OFFSET: 32, RESULT_CAPACITY: 36,
    SELECTED_ARENA: 40, OPTIONS_MODE: 44, SCHEMA_BYTES_MAX_DEPTH: 48,
    ERROR_CAPACITY: 52, PROGRAM_CAPACITY: 56, DOCUMENT_BYTES: 60,
  }),
});

// Format ids. Index in FORMAT_NAMES is the id; 0 is "unknown format".
export const FORMAT_NAMES = Object.freeze([
  '',
  'date-time', 'date', 'time', 'duration', 'email', 'idn-email', 'hostname',
  'idn-hostname', 'ipv4', 'ipv6', 'uri', 'uri-reference', 'iri', 'iri-reference',
  'uri-template', 'uuid', 'json-pointer', 'relative-json-pointer', 'regex',
]);

// Keyword codes. Index in KEYWORD_NAMES is the code; 0 is "not a keyword".
export const KEYWORD_NAMES = Object.freeze([
  '',
  '$ref', '$defs', 'definitions', '$id', 'id', '$anchor', '$dynamicRef',
  '$dynamicAnchor', '$recursiveRef', '$recursiveAnchor', '$schema',
  '$comment', '$vocabulary',
  'type', 'const', 'enum', 'multipleOf', 'maximum', 'exclusiveMaximum',
  'minimum', 'exclusiveMinimum', 'maxLength', 'minLength', 'pattern',
  'format', 'maxItems', 'minItems', 'uniqueItems', 'maxContains',
  'minContains', 'maxProperties', 'minProperties', 'required',
  'dependentRequired',
  'allOf', 'anyOf', 'oneOf', 'not', 'if', 'then', 'else', 'properties',
  'patternProperties', 'additionalProperties', 'propertyNames',
  'dependentSchemas', 'dependencies', 'prefixItems', 'items',
  'additionalItems', 'contains', 'unevaluatedProperties',
  'unevaluatedItems',
  'contentEncoding', 'contentMediaType', 'contentSchema', 'title',
  'description', 'default', 'deprecated', 'readOnly', 'writeOnly',
  'examples',
  'false', // pseudo-keyword reported by a boolean false schema
]);

export const KEYWORD = Object.freeze(
  Object.fromEntries(KEYWORD_NAMES.map((name, code) => [name, code])),
);

// FNV-1a 32-bit over UTF-8 bytes — the hash the engine uses for keyword
// classification and key tables. Mirrors $fnv1a in schema-engine.wat.
export function fnv1a(bytes) {
  let hash = 0x811c9dc5;
  for (let index = 0; index < bytes.length; index++) {
    hash ^= bytes[index];
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash >>> 0;
}

// Diagnostic rendering ABI (all pointers/capacities unsigned i32):
// render_error(program, continuation, index, out, capacity) -> length:i32
//   preserves the four raw MessagePack fields instancePath/schemaPath/keyword/
//   params; its existing 1280-byte table tail and -1/-2 results are unchanged.
// render_error_complete(same five arguments) -> (length:i32, work:i64, overflow:i32)
//   adds message from the upstream catalogue, with JS Number#toString numeric
//   presentation. i64/u64 params retain their raw representation; like the JS
//   decoder, message interpolation rounds wide integers to Number first.
// Both require a live validated program and finished VALIDATE continuation,
// and a disjoint caller-owned output range. They do not validate input pointers.
// Complete rendering additionally reserves a 4096-byte tail for immutable
// templates and 864 bytes of numeric scratch (inside that tail). Output range
// arithmetic is checked against memory before writing. No allocation or growth.
// length >= 0 is a complete record; -1 means insufficient output (no required
// size is returned); -2 means bad index. Failed output contents are unspecified.
// Callers grow only their output and retry the SAME settled continuation.
// Every complete attempt returns its unsigned u64 work, even on -1/-2. Overflow
// is sticky within that atomic attempt, saturating work to UINT64_MAX; callers
// must accumulate every attempt before handling its status or retrying.
// Bulk work is ceil(bytes/64); scans, limbs, and digit operations are metered at
// their source. No borrowed meter buffer, address-zero writes, retained driver
// debt, host number formatter, or compile/validation budget driver is involved.

// Shared ABI constants for the standalone RegExp WASM engine.
// Keep these values mirrored in regex-engine.wat.

export const REGEX_STATUS = Object.freeze({
  OK: 0,
  PAUSED: 1,
  MATCH: 2,
  NO_MATCH: 3,
  SYNTAX_ERROR: 4,
  UNSUPPORTED: 5,
  LIMIT_EXCEEDED: 6,
  BUFFER_TOO_SMALL: 7,
  CORRUPT_PROGRAM: 8,
  INVALID_UTF8: 9,
});

export const REGEX_LIMIT = Object.freeze({
  MAX_PATTERN_BYTES: 64 * 1024,
  MAX_BYTECODE_INSTRUCTIONS: 4096,
  MAX_CAPTURE_GROUPS: 32,
  MAX_CHARACTER_CLASS_RANGES: 1024,
});

export const REGEX_PROGRAM = Object.freeze({
  HEADER_SIZE: 40,
  INSTRUCTION_SIZE: 16,
  MAGIC: 0x53535258, // "SSRX" in little-endian memory.
  VERSION: 1,
  HEADER: Object.freeze({
    MAGIC: 0,
    VERSION: 4,
    BYTE_LENGTH: 8,
    INSTRUCTION_COUNT: 12,
    RANGE_COUNT: 16,
    CAPTURE_GROUP_COUNT: 20,
    FLAGS: 24,
    NAME_BYTES: 28,
    // Hidden per-thread slots recording iteration entry positions for the
    // empty-iteration guards of optional quantifier copies.
    GUARD_SLOTS: 32,
    RESERVED: 36,
  }),
  INSTRUCTION: Object.freeze({
    OPCODE: 0,
    FIRST_OPERAND: 4,
    SECOND_OPERAND: 8,
    THIRD_OPERAND: 12,
  }),
});

// Consuming and assertion instructions name their successor explicitly. This
// keeps every control-flow edge checked and removes fallthrough conventions
// from compiler, executor, disassembler, and corruption validation.
export const REGEX_OPCODE = Object.freeze({
  CHARACTER: 0,
  ANY: 1,
  CHARACTER_CLASS: 2,
  NEGATED_CHARACTER_CLASS: 3,
  SPLIT: 4,
  JUMP: 5,
  SAVE: 6,
  ASSERT_START: 7,
  ASSERT_END: 8,
  MATCH: 9,
  // Reset the capture slots of every group inside a quantified atom at each
  // loop-body entry: [firstSlot, slotCount, next]. This reproduces
  // JavaScript's per-iteration capture clearing.
  CLEAR_CAPTURES: 10,
  // Kill the thread when no input was consumed since the recorded guard
  // slot: [guardSlot, next]. This reproduces JavaScript's rule that an
  // optional quantifier iteration matching empty is discarded.
  GUARD: 11,
});

// Live compiler and match state is v2; old in-flight state is rejected.
// Each phase exposes <phase>_work_charged(state)->u64 and
// <phase>_work_overflow(state)->i32 for measurement, scan, emission, match.
// Totals saturate at UINT64_MAX with sticky overflow. WORK_PENDING is
// independent scheduling debt, capped at 2^32; it is not an exact total.
// Initialization retains inspected work on failure once a valid disjoint
// header begins the phase. Preflight size/version/alias refusals do not
// establish a new meter. Successful setup retains debt for the next
// positive step.
// initialize_program_emission charges the scan workspace; emission setup
// starts a separate total and moves outstanding scan debt into emission
// without counting it again. Nested measurement helpers charge their scan.
// validate_program_work(program,capacity)->(status,u64 work,i32 overflow)
// uses the same stateless validator, without allocating a work buffer.
// Intrinsic loops, examined bytes and 16-byte bulk blocks are additive to
// scalar/thread/control units. Atomic work may overrun a grant: remaining
// fuel is signed and clamps at INT32_MIN; exact work never comes from it.

export const REGEX_COMPILER = Object.freeze({
  SCAN_HEADER_SIZE: 128,
  SCAN_MAGIC: 0x53525343, // "SRSC" in little-endian memory.
  VERSION: 2,
  BUILTIN_CLASS_RESULT_SIZE: 8,
  BUILTIN_CLASS_MAX_RANGES: 10, // \s carries the ten ECMA-262 whitespace ranges
  NAME_HEADER_SIZE: 8,
  MEASUREMENT_HEADER_SIZE: 56,
  GROUP_STACK_ENTRY_SIZE: 8,
  MEASUREMENT_MAGIC: 0x53524d57, // "SRMW" in little-endian memory.
  MEASUREMENT: Object.freeze({
    MAGIC: 0,
    VERSION: 4,
    GROUP_DEPTH: 8,
    PATTERN_BYTES: 12,
    INSTRUCTION_COUNT: 16,
    LAST_ATOM_INSTRUCTION_COUNT: 20,
    LAST_ATOM_CAPTURE_COUNT: 24,
    GUARD_SLOTS: 28,
    WORK_CHARGED: 32,
    WORK_OVERFLOW: 40,
    WORK_RESERVED: 44,
    WORK_PENDING: 48,
  }),
  GROUP_STACK: Object.freeze({
    INSTRUCTION_CHECKPOINT: 0,
    CAPTURE_CHECKPOINT: 4,
  }),
  EMIT_HEADER_SIZE: 160,
  EMIT_STACK_ENTRY_SIZE: 24,
  EMIT_MAGIC: 0x53524543, // "SREC" in little-endian memory.
  EMIT: Object.freeze({
    MAGIC: 0,
    VERSION: 4,
    PATTERN_ADDRESS: 8,
    PATTERN_BYTES: 12,
    CURSOR: 16,
    PROGRAM_ADDRESS: 20,
    PROGRAM_BYTES: 24,
    INSTRUCTION_INDEX: 28,
    RANGE_INDEX: 32,
    NAME_BYTES_EMITTED: 36,
    GROUP_DEPTH: 40,
    COMPLETE: 44,
    MODE: 48,
    CLASS_FIRST: 52,
    CLASS_NEGATED: 56,
    CLASS_PENDING: 60,
    CLASS_PENDING_SCALAR: 64,
    CLASS_DASH: 68,
    CLASS_RANGE_START: 72,
    CLASS_RANGE_COUNT: 76,
    CAPTURE_GROUP_COUNT: 80,
    NAME_START: 84,
    NAME_LENGTH: 88,
    LAST_ATOM_START: 92,
    LAST_ATOM_INSTRUCTION_COUNT: 96,
    QUANTIFIER_SPLIT: 100,
    QUANTIFIER_MINIMUM: 104,
    QUANTIFIER_MAXIMUM: 108,
    QUANTIFIER_HAS_DIGITS: 112,
    LAST_ATOM_CAPTURE_START: 116,
    LAST_ATOM_CAPTURE_COUNT: 120,
    // The atom's real entry instruction: alternation inside a noncapturing
    // group places the branch split after the first branch, so entering the
    // atom is not always its lowest instruction index.
    LAST_ATOM_ENTRY: 124,
    // Next hidden guard slot to assign, counting guarded quantifiers in
    // emission order.
    GUARD_INDEX: 128,
    // Offset 132 is alignment padding; existing fields never move.
    WORK_CHARGED: 136,
    WORK_OVERFLOW: 144,
    WORK_RESERVED: 148,
    WORK_PENDING: 152,
  }),
  EMIT_STACK: Object.freeze({
    CAPTURE_SLOT: 0,
    ENTRY_INSTRUCTION: 4,
    BRANCH_START: 8,
    LATEST_SPLIT: 12,
    ATOM_START: 16,
    CAPTURE_CHECKPOINT: 20,
  }),
  EMIT_MODE: Object.freeze({
    NORMAL: 0,
    CLASS: 1,
    CLASS_ESCAPE: 2,
    AFTER_GROUP_OPEN: 3,
    GROUP_QUESTION: 4,
    GROUP_LESS: 5,
    NAMED_GROUP: 6,
    AFTER_QUANTIFIER: 7,
    BRACE_START: 8,
    BRACE_MINIMUM: 9,
    BRACE_AFTER_COMMA: 10,
    BRACE_MAXIMUM: 11,
    BOUNDED_READY: 12,
  }),
  BUILTIN_CLASS_RESULT: Object.freeze({
    RANGE_COUNT: 0,
    NEGATED: 4,
  }),
  SCAN: Object.freeze({
    MAGIC: 0,
    VERSION: 4,
    PATTERN_ADDRESS: 8,
    PATTERN_BYTES: 12,
    CURSOR: 16,
    SCALAR_COUNT: 20,
    COMPLETE: 24,
    RESERVED: 28,
    MODE: 32,
    GROUP_DEPTH: 36,
    CAPTURE_GROUP_COUNT: 40,
    NAME_LENGTH: 44,
    CAN_QUANTIFY: 48,
    QUANTIFIER_MINIMUM: 52,
    QUANTIFIER_MAXIMUM: 56,
    QUANTIFIER_HAS_MINIMUM: 60,
    QUANTIFIER_HAS_MAXIMUM: 64,
    BRACE_CAN_QUANTIFY: 68,
    NAMED_CAPTURE_COUNT: 72,
    NAME_BYTES: 76,
    CLASS_NEGATED: 80,
    CLASS_AT_START: 84,
    CLASS_HAS_PENDING: 88,
    CLASS_PENDING_SCALAR: 92,
    CLASS_RANGE_PENDING: 96,
    RANGE_COUNT: 100,
    WORK_CHARGED: 104,
    WORK_OVERFLOW: 112,
    WORK_RESERVED: 116,
    WORK_PENDING: 120,
  }),
});

export const REGEX_CONTINUATION = Object.freeze({
  HEADER_SIZE: 128,
  // Schema PROGRAM v2 stores the v1 continuation size. Runtime sizing adds
  // this extension to a nonzero stored maximum, preserving portable bytes.
  WORK_BYTES: 24,
  THREAD_HEADER_SIZE: 8,
  CAPTURE_OFFSET_SIZE: 4,
  MAGIC: 0x53535243, // "SSRC" in little-endian memory.
  VERSION: 2,
  // Unset capture offsets and the end-of-input scalar share one sentinel.
  NO_POSITION: 0xffffffff,
  HEADER: Object.freeze({
    MAGIC: 0,
    VERSION: 4,
    PROGRAM_ADDRESS: 8,
    PROGRAM_BYTES: 12,
    INPUT_ADDRESS: 16,
    INPUT_BYTES: 20,
    START_BYTE: 24,
    BYTE_POSITION: 28,
    SCALAR_POSITION: 32,
    PREVIOUS_SCALAR: 36,
    PHASE: 40,
    LIST_PARITY: 44,
    CURRENT_COUNT: 48,
    CURRENT_CURSOR: 52,
    STACK_COUNT: 56,
    NEXT_COUNT: 60,
    MATCHED: 64,
    MATCH_END_BYTE: 68,
    MATCH_END_SCALAR: 72,
    DECODED_SCALAR: 76,
    NEXT_BYTE_POSITION: 80,
    INSTRUCTION_COUNT: 84,
    CAPTURE_GROUP_COUNT: 88,
    FLAGS: 92,
    GUARD_SLOTS: 96,
    RESERVED: 100,
    WORK_CHARGED: 104,
    WORK_OVERFLOW: 112,
    WORK_RESERVED: 116,
    WORK_PENDING: 120,
  }),
  PHASE: Object.freeze({
    POSITION: 0,
    PROCESS: 1,
    COMPLETE: 2,
  }),
});

export const REGEX_FLAG = Object.freeze({
  GLOBAL: 1 << 0,
  IGNORE_CASE: 1 << 1,
  MULTILINE: 1 << 2,
  DOT_ALL: 1 << 3,
  HAS_INDICES: 1 << 5,
  STICKY: 1 << 7,
});

// Flag letters ↔ bits, shared by the parser (literal flags), the
// interpreter glue (new RegExp flags strings), and inspection. The bit
// values mirror the engine's flag_bit function in regex-engine.wat.
export const REGEX_FLAG_BY_LETTER = Object.freeze({
  g: REGEX_FLAG.GLOBAL,
  i: REGEX_FLAG.IGNORE_CASE,
  m: REGEX_FLAG.MULTILINE,
  s: REGEX_FLAG.DOT_ALL,
  d: REGEX_FLAG.HAS_INDICES,
  y: REGEX_FLAG.STICKY,
});

// Real JS flags the dialect deliberately rejects (fail loud, never
// approximate): Unicode mode and Unicode-sets mode.
export const REGEX_UNSUPPORTED_FLAG_LETTERS = Object.freeze(['u', 'v']);

// Canonical flags-string order, matching RegExp.prototype.flags
// ("dgimsuvy" minus the rejected letters).
export function regexFlagsToString(flagsWord) {
  let result = '';
  if (flagsWord & REGEX_FLAG.HAS_INDICES) result += 'd';
  if (flagsWord & REGEX_FLAG.GLOBAL) result += 'g';
  if (flagsWord & REGEX_FLAG.IGNORE_CASE) result += 'i';
  if (flagsWord & REGEX_FLAG.MULTILINE) result += 'm';
  if (flagsWord & REGEX_FLAG.DOT_ALL) result += 's';
  if (flagsWord & REGEX_FLAG.STICKY) result += 'y';
  return result;
}

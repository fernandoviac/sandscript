/**
 * SandScript AST module — the binary-AST dialect for SS source.
 *
 * Produces and consumes the AST region in the memory image. The interpreter
 * does not interpret AST bytes — this module is the host-side dialect
 * contract identified by the dialect tag in the region header.
 *
 * The AST is opt-in: enabled by passing `inlineSource: true` (or
 * `astRegionSize > 0`) to createSession. When disabled, this module is
 * unused; nothing in the interpreter depends on it.
 *
 */

// =============================================================================
// Dialect identity
// =============================================================================

// "sand" as a 4-byte little-endian ASCII tag (0x73 0x61 0x6E 0x64).
// Hosts coordinate dialect tags out-of-band; SS's own dialect is "sand".
export const DIALECT_SAND = 0x646e6173;

// Schema version within the SS dialect. Bump when node tags or layouts
// change in a way decoders need to know about. Dialect forks bump
// DIALECT_SAND instead.
// v2 (2026-07-05): destructuring pattern nodes (ARRAY_PATTERN,
// OBJECT_PATTERN, PATTERN_ELEMENT) — patterns are no longer opaque
// writeVariableBinding(0, 0) markers.
// v3 (2026-07-06): every node header grows an 8-byte source position
// (line:4, col:4) after [tag:2][flags:2]. Every write* function takes
// an optional trailing { line, col } (default { line: 0, col: 0 });
// every existing field offset in every write*/readNode case shifts +8
// to make room. Lets a post-parse AST walk (structural checks: unused
// bindings, unreachable code, undefined reads, const reassignment)
// report a real source location instead of only a reconstructed
// snippet.
// v4 (2026-08-04): FUNCTION_DECL gains FLAG.FN_EXPORTED and
// VARIABLE_DECL gains FLAG.VAR_EXPORTED, set by top-level `export`
// declarations. The export map is no longer parser-transient: restore
// rebuilds it from these flags, and the printer emits the `export`
// keyword so getSource() round-trips. Byte layouts are unchanged; the
// bits were previously always zero, so a pre-v4 region cannot
// distinguish "no exports" from "exports never recorded" — which is
// exactly why decoders must know.
// v5 (2026-08-14): class support —
// CLASS_DECL and CLASS_MEMBER node tags with their FLAG bits. SUPER
// (reserved since v1) is now written by the parser for `super(...)`
// and `super.m(...)` expressions. Additive: pre-v5 regions contain no
// class tags; a pre-v5 decoder must reject a v5 region because the
// tags are unknown to it.
// v6 (2026-08-14): new.target and super property access — NEW_TARGET
// node tag (header-only, like THIS/SUPER); SUPER now also appears as
// object of MEMBER_ACCESS/ASSIGNMENT nodes for super.x reads and
// writes. Additive in the same sense as v5.
export const FORMAT_VERSION = 6;

// =============================================================================
// Node tags
// =============================================================================

export const NODE = {
  // Literals
  LITERAL_INTEGER:    0x01,
  LITERAL_FLOAT:      0x02,
  LITERAL_BOOLEAN:    0x03,
  LITERAL_NULL:       0x04,
  LITERAL_UNDEFINED:  0x05,
  LITERAL_STRING:     0x06,
  LITERAL_RATIONAL:   0x07,
  LITERAL_BIGINT:     0x08,
  LITERAL_REGEXP:     0x09,

  // Names and access
  IDENTIFIER:         0x10,
  THIS:               0x11,
  SUPER:              0x12,
  MEMBER_ACCESS:      0x13,
  INDEX_ACCESS:       0x14,
  OPTIONAL_MEMBER:    0x15,
  OPTIONAL_INDEX:     0x16,
  NEW_TARGET:         0x17,

  // Operators
  BINARY_OP:          0x20,
  LOGICAL_OP:         0x21,
  UNARY_OP:           0x22,
  UPDATE:             0x23,
  ASSIGNMENT:         0x24,
  CONDITIONAL:        0x25,
  SEQUENCE:           0x26,
  SPREAD:             0x27,

  // Calls
  CALL:               0x30,
  NEW:                0x31,
  OPTIONAL_CALL:      0x32,

  // Control flow
  IF:                 0x40,
  WHILE:              0x41,
  DO_WHILE:           0x42,
  FOR:                0x43,
  FOR_IN:             0x44,
  FOR_OF:             0x45,
  BREAK:              0x46,
  CONTINUE:           0x47,
  RETURN:             0x48,
  THROW:              0x49,
  TRY:                0x4A,
  LABELED:            0x4B,
  SWITCH:             0x4C,
  SWITCH_CASE:        0x4D,

  // Declarations and statements
  FUNCTION_DECL:      0x50,
  VARIABLE_DECL:      0x51,
  VARIABLE_BINDING:   0x52,
  BLOCK:              0x53,
  EXPRESSION_STMT:    0x54,
  EMPTY_STMT:         0x55,

  // Destructuring patterns (targets of declarations / parameters)
  ARRAY_PATTERN:      0x56,
  OBJECT_PATTERN:     0x57,
  PATTERN_ELEMENT:    0x58,
  CLASS_DECL:         0x59,
  CLASS_MEMBER:       0x5A,

  // Composite literals
  ARRAY_LITERAL:      0x60,
  OBJECT_LITERAL:     0x61,
  OBJECT_PROPERTY:    0x62,
  TEMPLATE_LITERAL:   0x63,
  TAGGED_TEMPLATE:    0x64,

  // Async
  AWAIT:              0x70,
  YIELD:              0x71,

  // SS-specific
  GRANT:              0x78,

  // Root chain (one per parse)
  ROOT:               0x80,
};

// Reverse lookup for the reader.
const NODE_NAMES = Object.fromEntries(
  Object.entries(NODE).map(([name, code]) => [code, name])
);
function nodeTypeName(tag) {
  return NODE_NAMES[tag] ?? `UNKNOWN_${tag.toString(16)}`;
}

// =============================================================================
// Operator sub-tags
//
// Sourced from token-level distinctions (so `+` and `+=` differ even though
// they bytecode to the same ADD), not from runtime opcodes.
// =============================================================================

export const BinaryOp = {
  PLUS: 1, MINUS: 2, STAR: 3, SLASH: 4, PERCENT: 5, STAR_STAR: 6,
  EQ_EQ: 7, NOT_EQ: 8, EQ_EQ_EQ: 9, NOT_EQ_EQ: 10,
  LT: 11, GT: 12, LT_EQ: 13, GT_EQ: 14,
  AMP: 15, PIPE: 16, CARET: 17, LT_LT: 18, GT_GT: 19, GT_GT_GT: 20,
  IN: 21, INSTANCEOF: 22,
};

export const LogicalOp = {
  AMP_AMP: 1, PIPE_PIPE: 2, QUESTION_QUESTION: 3,
};

export const UnaryOp = {
  MINUS: 1, PLUS: 2, BANG: 3, TILDE: 4,
  TYPEOF: 5, VOID: 6, DELETE: 7,
};

export const UpdateOp = {
  PLUS_PLUS: 1, MINUS_MINUS: 2,
};

export const AssignOp = {
  EQ: 1, PLUS_EQ: 2, MINUS_EQ: 3, STAR_EQ: 4, SLASH_EQ: 5, PERCENT_EQ: 6,
  AMP_EQ: 7, PIPE_EQ: 8, CARET_EQ: 9,
  LT_LT_EQ: 10, GT_GT_EQ: 11, GT_GT_GT_EQ: 12,
  STAR_STAR_EQ: 13,
  AMP_AMP_EQ: 14, PIPE_PIPE_EQ: 15, QUESTION_QUESTION_EQ: 16,
};

const OPERATOR_NAMES = {
  BinaryOp: Object.fromEntries(Object.entries(BinaryOp).map(([k, v]) => [v, k])),
  LogicalOp: Object.fromEntries(Object.entries(LogicalOp).map(([k, v]) => [v, k])),
  UnaryOp: Object.fromEntries(Object.entries(UnaryOp).map(([k, v]) => [v, k])),
  UpdateOp: Object.fromEntries(Object.entries(UpdateOp).map(([k, v]) => [v, k])),
  AssignOp: Object.fromEntries(Object.entries(AssignOp).map(([k, v]) => [v, k])),
};

// =============================================================================
// Per-node flag bits
// =============================================================================

export const FLAG = {
  // FUNCTION_DECL
  FN_ASYNC:       0x01,
  FN_ARROW:       0x02,
  FN_GENERATOR:   0x04,
  FN_EXPORTED:    0x08, // top-level `export function` (v4)

  // VARIABLE_DECL
  VAR_CONST:      0x01,
  VAR_EXPORTED:   0x02, // top-level `export const`/`let`/`var` (v4)

  // VARIABLE_BINDING
  BINDING_HAS_INIT: 0x01,

  // PATTERN_ELEMENT
  PATTERN_REST:         0x01, // `...target`
  PATTERN_HOLE:         0x02, // array elision `[a, , b]`
  PATTERN_SHORTHAND:    0x04, // object `{ a }` (key === bound name; no key node)
  PATTERN_KEY_COMPUTED: 0x08, // key child is a computed-key expression — print [expr]

  // CLASS_DECL
  CLASS_EXPORTED:   0x01, // top-level `export class`
  CLASS_EXPRESSION: 0x02, // expression position (`let C = class {}`)

  // CLASS_MEMBER
  MEMBER_STATIC:       0x01,
  MEMBER_GETTER:       0x02,
  MEMBER_SETTER:       0x04,
  MEMBER_FIELD:        0x08, // value child = initializer expression (0 = none)
  MEMBER_KEY_COMPUTED: 0x10, // key child = computed-key expression — print [expr]
  MEMBER_CTOR:         0x20, // the `constructor(...)` member
  MEMBER_STATIC_BLOCK: 0x40, // `static { ... }`; key = 0, value = FUNCTION_DECL
  MEMBER_PRIVATE:      0x80, // #name member; the key node keeps the '#name' source spelling

  // OBJECT_PROPERTY
  PROP_SHORTHAND: 0x01,
  PROP_COMPUTED:  0x02,
  PROP_METHOD:    0x04,
  PROP_GETTER:    0x08,
  PROP_SETTER:    0x10,

  // FOR_OF
  FOR_OF_AWAIT:   0x01,
  FOR_OF_CONST:   0x02,   // binding declared with `const`
  FOR_OF_LET:     0x04,   // binding declared with `let` (neither flag =
                          // pre-v2 node; the printer omits the keyword)

  // FOR_IN
  FOR_IN_CONST:   0x01,   // binding declared with `const`
  FOR_IN_LET:     0x02,   // binding declared with `let` (neither = pre-v2)

  // IF
  IF_HAS_ALT:     0x01,

  // TRY
  TRY_HAS_CATCH:   0x01,
  TRY_HAS_FINALLY: 0x02,

  // GRANT
  GRANT_HAS_DENIED: 0x01,

  // YIELD
  YIELD_DELEGATE: 0x01,
};

// =============================================================================
// Node layout — the declarative per-tag walking table
// =============================================================================
//
// One entry per NODE tag, describing every graph edge and string
// reference in the node's binary layout (byte offsets relative to the
// node pointer). v3: the shared header is [tag:2][flags:2][line:4]
// [col:4] (12 bytes) — every per-tag payload field offset below starts
// at 12, not 4.
//
//   children:   scalar child references — u32 node offsets. Each entry
//               carries the byte offset AND the field name readNode
//               materializes it under, so readTree and the GC walker
//               consume the same table (offsets for raw walks, names
//               for tree materialization).
//   childArray: count-prefixed child array — `count` is the byte
//               offset of the u32 count, `start` of the first u32
//               element (stride 4), `name` the materialized field.
//   strings:    u32 string-table ids (0 = absent). The collector
//               marks these live and forwards them across string
//               compaction; the WAT collector consumes the same table
//               as a host-written knowledge table.
//
// MUST stay in sync with the readNode cases below — a field read
// there but missing here goes stale after the next string compaction
// (strings) or is collected out from under the AST (children, once
// the WAT collector walks this table). tests/fuel/ast_node_layout_test.js
// pins coverage: every tag, every string reachable.
//
// ROOT carries its `nextRoot` link as a `chain` edge, not a child:
// graph walkers (the GC string walk and WAT walker) follow
// it like any edge — so a walk primed with only the first root
// reaches every parse's tree — but readTree does NOT materialize it
// (a ROOT's tree is one parse, not the whole chain).
export const NODE_LAYOUT = {
  [NODE.LITERAL_INTEGER]:   {},
  [NODE.LITERAL_FLOAT]:     {},
  [NODE.LITERAL_BOOLEAN]:   {},
  [NODE.LITERAL_NULL]:      {},
  [NODE.LITERAL_UNDEFINED]: {},
  [NODE.LITERAL_STRING]:    { strings: [12] },
  [NODE.LITERAL_RATIONAL]:  {},
  [NODE.LITERAL_BIGINT]:    { strings: [12] },   // digit string — typically AST-only reference
  [NODE.LITERAL_REGEXP]:    { strings: [12] },   // raw pattern text; flags word at +16

  [NODE.IDENTIFIER]: { strings: [12] },
  [NODE.THIS]:       {},
  [NODE.SUPER]:      {},
  [NODE.NEW_TARGET]: {},

  [NODE.MEMBER_ACCESS]:   { children: [{ offset: 12, name: 'object' }], strings: [16] },
  [NODE.OPTIONAL_MEMBER]: { children: [{ offset: 12, name: 'object' }], strings: [16] },
  [NODE.INDEX_ACCESS]:    { children: [{ offset: 12, name: 'object' }, { offset: 16, name: 'index' }] },
  [NODE.OPTIONAL_INDEX]:  { children: [{ offset: 12, name: 'object' }, { offset: 16, name: 'index' }] },

  [NODE.BINARY_OP]:  { children: [{ offset: 16, name: 'left' }, { offset: 20, name: 'right' }] },
  [NODE.LOGICAL_OP]: { children: [{ offset: 16, name: 'left' }, { offset: 20, name: 'right' }] },
  [NODE.UNARY_OP]:   { children: [{ offset: 16, name: 'operand' }] },
  [NODE.UPDATE]:     { children: [{ offset: 16, name: 'operand' }] },
  [NODE.ASSIGNMENT]: { children: [{ offset: 16, name: 'target' }, { offset: 20, name: 'value' }] },
  [NODE.CONDITIONAL]: {
    children: [
      { offset: 12, name: 'test' },
      { offset: 16, name: 'consequent' },
      { offset: 20, name: 'alternate' },
    ],
  },
  [NODE.SEQUENCE]: { childArray: { count: 12, start: 16, name: 'expressions' } },
  [NODE.SPREAD]:   { children: [{ offset: 12, name: 'argument' }] },

  [NODE.CALL]:          { children: [{ offset: 12, name: 'callee' }], childArray: { count: 16, start: 20, name: 'args' } },
  [NODE.NEW]:           { children: [{ offset: 12, name: 'callee' }], childArray: { count: 16, start: 20, name: 'args' } },
  [NODE.OPTIONAL_CALL]: { children: [{ offset: 12, name: 'callee' }], childArray: { count: 16, start: 20, name: 'args' } },

  [NODE.IF]: {
    children: [
      { offset: 12, name: 'test' },
      { offset: 16, name: 'consequent' },
      { offset: 20, name: 'alternate' },
    ],
  },
  [NODE.WHILE]:    { children: [{ offset: 12, name: 'test' }, { offset: 16, name: 'body' }] },
  [NODE.DO_WHILE]: { children: [{ offset: 12, name: 'body' }, { offset: 16, name: 'test' }] },
  [NODE.FOR]: {
    children: [
      { offset: 12, name: 'init' },
      { offset: 16, name: 'test' },
      { offset: 20, name: 'update' },
      { offset: 24, name: 'body' },
    ],
  },
  [NODE.FOR_IN]: {
    children: [
      { offset: 12, name: 'binding' },
      { offset: 16, name: 'iterable' },
      { offset: 20, name: 'body' },
    ],
  },
  [NODE.FOR_OF]: {
    children: [
      { offset: 12, name: 'binding' },
      { offset: 16, name: 'iterable' },
      { offset: 20, name: 'body' },
    ],
  },
  [NODE.BREAK]:    { strings: [12] },   // label (0 = none)
  [NODE.CONTINUE]: { strings: [12] },   // label (0 = none)
  [NODE.RETURN]:   { children: [{ offset: 12, name: 'value' }] },
  [NODE.THROW]:    { children: [{ offset: 12, name: 'value' }] },
  [NODE.TRY]: {
    children: [
      { offset: 12, name: 'block' },
      { offset: 16, name: 'catchParam' },
      { offset: 20, name: 'catchBlock' },
      { offset: 24, name: 'finallyBlock' },
    ],
  },
  [NODE.LABELED]:     { strings: [12], children: [{ offset: 16, name: 'body' }] },
  [NODE.SWITCH]:      { children: [{ offset: 12, name: 'discriminant' }], childArray: { count: 16, start: 20, name: 'cases' } },
  [NODE.SWITCH_CASE]: { children: [{ offset: 12, name: 'test' }], childArray: { count: 16, start: 20, name: 'statements' } },

  [NODE.FUNCTION_DECL]: {
    strings: [12],   // name (0 = anonymous)
    children: [{ offset: 20, name: 'body' }],
    childArray: { count: 16, start: 24, name: 'params' },
  },
  [NODE.VARIABLE_DECL]:    { childArray: { count: 12, start: 16, name: 'bindings' } },
  [NODE.VARIABLE_BINDING]: { strings: [12], children: [{ offset: 16, name: 'initializer' }] },

  // Patterns appear directly in VARIABLE_DECL's bindings array (with the
  // declaration's initializer as their `initializer` child) and in
  // FUNCTION_DECL's params array (initializer = the parameter default).
  [NODE.ARRAY_PATTERN]: {
    children: [{ offset: 12, name: 'initializer' }],
    childArray: { count: 16, start: 20, name: 'elements' },
  },
  [NODE.OBJECT_PATTERN]: {
    children: [{ offset: 12, name: 'initializer' }],
    childArray: { count: 16, start: 20, name: 'properties' },
  },
  [NODE.PATTERN_ELEMENT]: {
    // ONE string field only — the GC scratch AST record format forwards
    // a single string per node. The key is a child NODE (IDENTIFIER,
    // LITERAL_STRING, or a computed-key expression), mirroring
    // OBJECT_PROPERTY.
    strings: [12],   // bound name (0 = nested pattern or hole)
    children: [
      { offset: 16, name: 'key' },
      { offset: 20, name: 'nestedPattern' },
      { offset: 24, name: 'defaultValue' },
    ],
  },
  [NODE.CLASS_DECL]: {
    strings: [12],   // name (0 = anonymous class expression)
    children: [{ offset: 16, name: 'heritage' }],
    childArray: { count: 20, start: 24, name: 'members' },
  },
  [NODE.CLASS_MEMBER]: {
    children: [{ offset: 12, name: 'key' }, { offset: 16, name: 'value' }],
  },
  [NODE.BLOCK]:            { childArray: { count: 12, start: 16, name: 'statements' } },
  [NODE.EXPRESSION_STMT]:  { children: [{ offset: 12, name: 'expression' }] },
  [NODE.EMPTY_STMT]:       {},

  [NODE.ARRAY_LITERAL]:    { childArray: { count: 12, start: 16, name: 'elements' } },
  [NODE.OBJECT_LITERAL]:   { childArray: { count: 12, start: 16, name: 'properties' } },
  [NODE.OBJECT_PROPERTY]:  { children: [{ offset: 12, name: 'key' }, { offset: 16, name: 'value' }] },
  [NODE.TEMPLATE_LITERAL]: { childArray: { count: 12, start: 16, name: 'parts' } },
  [NODE.TAGGED_TEMPLATE]:  { children: [{ offset: 12, name: 'tagFunction' }, { offset: 16, name: 'template' }] },

  [NODE.AWAIT]: { children: [{ offset: 12, name: 'argument' }] },
  [NODE.YIELD]: { children: [{ offset: 12, name: 'argument' }] },

  [NODE.GRANT]: {
    children: [{ offset: 12, name: 'body' }, { offset: 20, name: 'deniedBody' }],
    strings: [16],   // denied param name (0 = none)
    childArray: { count: 24, start: 28, name: 'identifiers' },
  },

  [NODE.ROOT]: { children: [{ offset: 12, name: 'body' }], chain: 16 },
};

// =============================================================================
// Writer
// =============================================================================

/**
 * Create a writer bound to a memory image's AST region. The writer allocates
 * space via `mem.astRegionAlloc(...)` and writes nodes there, returning
 * base-relative offsets that the parser stores in instruction `astNode`
 * fields.
 *
 * Caller must call `initialize()` before any writeXxx call. Subsequent
 * `parse()` calls on the same session share the same writer.
 */
export function createAstWriter(mem) {
  const view = mem.view;

  // Helpers — write a node header, return both the absolute pointer and the
  // base-relative offset of the new node.
  function alloc(byteLength) {
    const offset = mem.astRegionAlloc(byteLength);
    const ptr = mem.abs(mem.getAstRegionBase() + offset);
    return { offset, ptr };
  }

  function writeHeader(ptr, tag, flags, pos) {
    view.setUint16(ptr + 0, tag, true);
    view.setUint16(ptr + 2, flags, true);
    view.setUint32(ptr + 4, pos?.line ?? 0, true);
    view.setUint32(ptr + 8, pos?.col ?? 0, true);
  }

  return {
    /**
     * Initialize the AST region header for the SS dialect. Idempotent —
     * safe to call multiple times across appends, but if the region was
     * already initialized with a different dialect or format version, this
     * throws before any further writes are attempted.
     */
    initialize() {
      if (mem.isAstRegionInitialized()) {
        const header = mem.getAstRegionHeader();
        if (header.dialect !== DIALECT_SAND) {
          throw new Error(
            `AST region dialect mismatch: existing region uses dialect 0x${
              header.dialect.toString(16)
            }, this writer uses 0x${DIALECT_SAND.toString(16)} ("sand"). ` +
            `One session may carry only one dialect. Create a fresh session for a different dialect.`
          );
        }
        if (header.formatVersion !== FORMAT_VERSION) {
          throw new Error(
            `AST region format_version mismatch: existing region is v${
              header.formatVersion
            }, this writer produces v${FORMAT_VERSION}.`
          );
        }
        // Already initialized with matching dialect — nothing to do.
        return;
      }
      mem.initializeAstRegionHeader(DIALECT_SAND, FORMAT_VERSION);
    },

    // -----------------------------------------------------------------------
    // Literals
    // -----------------------------------------------------------------------

    writeLiteralInteger(value /* bigint */, pos) {
      const { offset, ptr } = alloc(24);
      writeHeader(ptr, NODE.LITERAL_INTEGER, 0, pos);
      view.setBigInt64(ptr + 12, BigInt(value), true);
      // 20-byte payload, but the i64 starts at offset 12 and we only need 8.
      // Bytes 20-23 are unused payload tail; they're already zero-initialized
      // because astRegionAlloc returns fresh region bytes.
      return offset;
    },

    writeLiteralFloat(value /* number */, pos) {
      const { offset, ptr } = alloc(24);
      writeHeader(ptr, NODE.LITERAL_FLOAT, 0, pos);
      view.setFloat64(ptr + 12, value, true);
      return offset;
    },

    writeLiteralBoolean(value /* boolean */, pos) {
      const { offset, ptr } = alloc(12);
      writeHeader(ptr, NODE.LITERAL_BOOLEAN, value ? 1 : 0, pos);
      return offset;
    },

    writeLiteralNull(pos) {
      const { offset, ptr } = alloc(12);
      writeHeader(ptr, NODE.LITERAL_NULL, 0, pos);
      return offset;
    },

    writeLiteralUndefined(pos) {
      const { offset, ptr } = alloc(12);
      writeHeader(ptr, NODE.LITERAL_UNDEFINED, 0, pos);
      return offset;
    },

    writeLiteralString(stringOffset /* intern offset */, pos) {
      const { offset, ptr } = alloc(16);
      writeHeader(ptr, NODE.LITERAL_STRING, 0, pos);
      view.setUint32(ptr + 12, stringOffset, true);
      return offset;
    },

    writeLiteralRational(numerator /* bigint */, denominator /* bigint */, pos) {
      const { offset, ptr } = alloc(28);
      writeHeader(ptr, NODE.LITERAL_RATIONAL, 0, pos);
      view.setBigInt64(ptr + 12, BigInt(numerator), true);
      view.setBigInt64(ptr + 20, BigInt(denominator), true);
      return offset;
    },

    writeLiteralBigInt(stringOffset /* intern offset of decimal string */, pos) {
      const { offset, ptr } = alloc(16);
      writeHeader(ptr, NODE.LITERAL_BIGINT, 0, pos);
      view.setUint32(ptr + 12, stringOffset, true);
      return offset;
    },

    writeLiteralRegExp(patternStringOffset /* intern offset */, flagsWord, pos) {
      const { offset, ptr } = alloc(20);
      writeHeader(ptr, NODE.LITERAL_REGEXP, 0, pos);
      view.setUint32(ptr + 12, patternStringOffset, true);
      view.setUint32(ptr + 16, flagsWord, true);
      return offset;
    },

    // -----------------------------------------------------------------------
    // Names and access
    // -----------------------------------------------------------------------

    writeIdentifier(nameOffset, pos) {
      const { offset, ptr } = alloc(16);
      writeHeader(ptr, NODE.IDENTIFIER, 0, pos);
      view.setUint32(ptr + 12, nameOffset, true);
      return offset;
    },

    writeThis(pos) {
      const { offset, ptr } = alloc(12);
      writeHeader(ptr, NODE.THIS, 0, pos);
      return offset;
    },

    writeSuper(pos) {
      const { offset, ptr } = alloc(12);
      writeHeader(ptr, NODE.SUPER, 0, pos);
      return offset;
    },
    writeNewTarget(pos) {
      const { offset, ptr } = alloc(12);
      writeHeader(ptr, NODE.NEW_TARGET, 0, pos);
      return offset;
    },


    writeMemberAccess(objectOffset, nameOffset, pos) {
      const { offset, ptr } = alloc(20);
      writeHeader(ptr, NODE.MEMBER_ACCESS, 0, pos);
      view.setUint32(ptr + 12, objectOffset, true);
      view.setUint32(ptr + 16, nameOffset, true);
      return offset;
    },

    writeIndexAccess(objectOffset, indexOffset, pos) {
      const { offset, ptr } = alloc(20);
      writeHeader(ptr, NODE.INDEX_ACCESS, 0, pos);
      view.setUint32(ptr + 12, objectOffset, true);
      view.setUint32(ptr + 16, indexOffset, true);
      return offset;
    },

    writeOptionalMember(objectOffset, nameOffset, pos) {
      const { offset, ptr } = alloc(20);
      writeHeader(ptr, NODE.OPTIONAL_MEMBER, 0, pos);
      view.setUint32(ptr + 12, objectOffset, true);
      view.setUint32(ptr + 16, nameOffset, true);
      return offset;
    },

    writeOptionalIndex(objectOffset, indexOffset, pos) {
      const { offset, ptr } = alloc(20);
      writeHeader(ptr, NODE.OPTIONAL_INDEX, 0, pos);
      view.setUint32(ptr + 12, objectOffset, true);
      view.setUint32(ptr + 16, indexOffset, true);
      return offset;
    },

    // -----------------------------------------------------------------------
    // Operators
    // -----------------------------------------------------------------------

    writeBinaryOp(opKind, left, right, pos) {
      const { offset, ptr } = alloc(24);
      writeHeader(ptr, NODE.BINARY_OP, 0, pos);
      view.setUint8(ptr + 12, opKind);
      view.setUint32(ptr + 16, left, true);
      view.setUint32(ptr + 20, right, true);
      return offset;
    },

    writeLogicalOp(opKind, left, right, pos) {
      const { offset, ptr } = alloc(24);
      writeHeader(ptr, NODE.LOGICAL_OP, 0, pos);
      view.setUint8(ptr + 12, opKind);
      view.setUint32(ptr + 16, left, true);
      view.setUint32(ptr + 20, right, true);
      return offset;
    },

    writeUnaryOp(opKind, operand, pos) {
      const { offset, ptr } = alloc(20);
      writeHeader(ptr, NODE.UNARY_OP, 0, pos);
      view.setUint8(ptr + 12, opKind);
      view.setUint32(ptr + 16, operand, true);
      return offset;
    },

    writeUpdate(opKind, operand, prefix, pos) {
      const { offset, ptr } = alloc(20);
      writeHeader(ptr, NODE.UPDATE, 0, pos);
      view.setUint8(ptr + 12, opKind);
      view.setUint8(ptr + 13, prefix ? 1 : 0);
      view.setUint32(ptr + 16, operand, true);
      return offset;
    },

    writeAssignment(opKind, target, value, pos) {
      const { offset, ptr } = alloc(24);
      writeHeader(ptr, NODE.ASSIGNMENT, 0, pos);
      view.setUint8(ptr + 12, opKind);
      view.setUint32(ptr + 16, target, true);
      view.setUint32(ptr + 20, value, true);
      return offset;
    },

    writeConditional(test, consequent, alternate, pos) {
      const { offset, ptr } = alloc(24);
      writeHeader(ptr, NODE.CONDITIONAL, 0, pos);
      view.setUint32(ptr + 12, test, true);
      view.setUint32(ptr + 16, consequent, true);
      view.setUint32(ptr + 20, alternate, true);
      return offset;
    },

    writeSequence(exprOffsets, pos) {
      const count = exprOffsets.length;
      const { offset, ptr } = alloc(16 + count * 4);
      writeHeader(ptr, NODE.SEQUENCE, 0, pos);
      view.setUint32(ptr + 12, count, true);
      for (let i = 0; i < count; i++) {
        view.setUint32(ptr + 16 + i * 4, exprOffsets[i], true);
      }
      return offset;
    },

    writeSpread(argument, pos) {
      const { offset, ptr } = alloc(16);
      writeHeader(ptr, NODE.SPREAD, 0, pos);
      view.setUint32(ptr + 12, argument, true);
      return offset;
    },

    // -----------------------------------------------------------------------
    // Calls
    // -----------------------------------------------------------------------

    writeCall(callee, args, pos) {
      return writeCallLike(NODE.CALL, callee, args, pos);
    },

    writeNew(callee, args, pos) {
      return writeCallLike(NODE.NEW, callee, args, pos);
    },

    writeOptionalCall(callee, args, pos) {
      return writeCallLike(NODE.OPTIONAL_CALL, callee, args, pos);
    },

    // -----------------------------------------------------------------------
    // Control flow
    // -----------------------------------------------------------------------

    writeIf(test, consequent, alternate /* 0 if absent */, pos) {
      const flags = alternate !== 0 ? FLAG.IF_HAS_ALT : 0;
      const { offset, ptr } = alloc(24);
      writeHeader(ptr, NODE.IF, flags, pos);
      view.setUint32(ptr + 12, test, true);
      view.setUint32(ptr + 16, consequent, true);
      view.setUint32(ptr + 20, alternate, true);
      return offset;
    },

    writeWhile(test, body, pos) {
      const { offset, ptr } = alloc(20);
      writeHeader(ptr, NODE.WHILE, 0, pos);
      view.setUint32(ptr + 12, test, true);
      view.setUint32(ptr + 16, body, true);
      return offset;
    },

    writeDoWhile(body, test, pos) {
      const { offset, ptr } = alloc(20);
      writeHeader(ptr, NODE.DO_WHILE, 0, pos);
      view.setUint32(ptr + 12, body, true);
      view.setUint32(ptr + 16, test, true);
      return offset;
    },

    writeFor(init, test, update, body, pos) {
      const { offset, ptr } = alloc(28);
      writeHeader(ptr, NODE.FOR, 0, pos);
      view.setUint32(ptr + 12, init, true);
      view.setUint32(ptr + 16, test, true);
      view.setUint32(ptr + 20, update, true);
      view.setUint32(ptr + 24, body, true);
      return offset;
    },

    writeForIn(binding, iterable, body, flags = 0, pos) {
      const { offset, ptr } = alloc(24);
      writeHeader(ptr, NODE.FOR_IN, flags, pos);
      view.setUint32(ptr + 12, binding, true);
      view.setUint32(ptr + 16, iterable, true);
      view.setUint32(ptr + 20, body, true);
      return offset;
    },

    writeForOf(binding, iterable, body, flags = 0, pos) {
      const { offset, ptr } = alloc(24);
      writeHeader(ptr, NODE.FOR_OF, flags, pos);
      view.setUint32(ptr + 12, binding, true);
      view.setUint32(ptr + 16, iterable, true);
      view.setUint32(ptr + 20, body, true);
      return offset;
    },

    writeBreak(labelOffset /* 0 if no label */, pos) {
      const { offset, ptr } = alloc(16);
      writeHeader(ptr, NODE.BREAK, 0, pos);
      view.setUint32(ptr + 12, labelOffset, true);
      return offset;
    },

    writeContinue(labelOffset, pos) {
      const { offset, ptr } = alloc(16);
      writeHeader(ptr, NODE.CONTINUE, 0, pos);
      view.setUint32(ptr + 12, labelOffset, true);
      return offset;
    },

    writeSwitch(discriminant, caseOffsets, pos) {
      const count = caseOffsets.length;
      const { offset, ptr } = alloc(20 + count * 4);
      writeHeader(ptr, NODE.SWITCH, 0, pos);
      view.setUint32(ptr + 12, discriminant, true);
      view.setUint32(ptr + 16, count, true);
      for (let i = 0; i < count; i++) {
        view.setUint32(ptr + 20 + i * 4, caseOffsets[i], true);
      }
      return offset;
    },

    writeSwitchCase(test, stmtOffsets, pos) {
      const count = stmtOffsets.length;
      const flags = test === 0 ? 1 : 0;
      const { offset, ptr } = alloc(20 + count * 4);
      writeHeader(ptr, NODE.SWITCH_CASE, flags, pos);
      view.setUint32(ptr + 12, test, true);
      view.setUint32(ptr + 16, count, true);
      for (let i = 0; i < count; i++) {
        view.setUint32(ptr + 20 + i * 4, stmtOffsets[i], true);
      }
      return offset;
    },

    writeReturn(value /* 0 if bare return */, pos) {
      const { offset, ptr } = alloc(16);
      writeHeader(ptr, NODE.RETURN, 0, pos);
      view.setUint32(ptr + 12, value, true);
      return offset;
    },

    writeThrow(value, pos) {
      const { offset, ptr } = alloc(16);
      writeHeader(ptr, NODE.THROW, 0, pos);
      view.setUint32(ptr + 12, value, true);
      return offset;
    },

    writeTry(block, catchParam, catchBlock, finallyBlock, pos) {
      let flags = 0;
      if (catchBlock !== 0) flags |= FLAG.TRY_HAS_CATCH;
      if (finallyBlock !== 0) flags |= FLAG.TRY_HAS_FINALLY;
      const { offset, ptr } = alloc(32);
      writeHeader(ptr, NODE.TRY, flags, pos);
      view.setUint32(ptr + 12, block, true);
      view.setUint32(ptr + 16, catchParam, true);
      view.setUint32(ptr + 20, catchBlock, true);
      view.setUint32(ptr + 24, finallyBlock, true);
      return offset;
    },

    writeLabeled(labelOffset, body, pos) {
      const { offset, ptr } = alloc(20);
      writeHeader(ptr, NODE.LABELED, 0, pos);
      view.setUint32(ptr + 12, labelOffset, true);
      view.setUint32(ptr + 16, body, true);
      return offset;
    },

    // -----------------------------------------------------------------------
    // Declarations and statements
    // -----------------------------------------------------------------------

    writeFunctionDecl({ nameOffset = 0, params, body, flags = 0, pos }) {
      const count = params.length;
      const { offset, ptr } = alloc(24 + count * 4);
      writeHeader(ptr, NODE.FUNCTION_DECL, flags, pos);
      view.setUint32(ptr + 12, nameOffset, true);
      view.setUint32(ptr + 16, count, true);
      view.setUint32(ptr + 20, body, true);
      for (let i = 0; i < count; i++) {
        view.setUint32(ptr + 24 + i * 4, params[i], true);
      }
      return offset;
    },
    writeClassDecl({ nameOffset = 0, heritage = 0, members, flags = 0, pos }) {
      const count = members.length;
      const { offset, ptr } = alloc(24 + count * 4);
      writeHeader(ptr, NODE.CLASS_DECL, flags, pos);
      view.setUint32(ptr + 12, nameOffset, true);
      view.setUint32(ptr + 16, heritage, true);
      view.setUint32(ptr + 20, count, true);
      for (let i = 0; i < count; i++) {
        view.setUint32(ptr + 24 + i * 4, members[i], true);
      }
      return offset;
    },

    writeClassMember({ key, value = 0, flags = 0, pos }) {
      const { offset, ptr } = alloc(20);
      writeHeader(ptr, NODE.CLASS_MEMBER, flags, pos);
      view.setUint32(ptr + 12, key, true);
      view.setUint32(ptr + 16, value, true);
      return offset;
    },


    writeVariableDecl(bindings, isConst, pos, exported = false) {
      const count = bindings.length;
      const flags = (isConst ? FLAG.VAR_CONST : 0) | (exported ? FLAG.VAR_EXPORTED : 0);
      const { offset, ptr } = alloc(16 + count * 4);
      writeHeader(ptr, NODE.VARIABLE_DECL, flags, pos);
      view.setUint32(ptr + 12, count, true);
      for (let i = 0; i < count; i++) {
        view.setUint32(ptr + 16 + i * 4, bindings[i], true);
      }
      return offset;
    },

    writeVariableBinding(nameOffset, initializerOffset /* 0 if none */, pos) {
      const flags = initializerOffset !== 0 ? FLAG.BINDING_HAS_INIT : 0;
      const { offset, ptr } = alloc(20);
      writeHeader(ptr, NODE.VARIABLE_BINDING, flags, pos);
      view.setUint32(ptr + 12, nameOffset, true);
      view.setUint32(ptr + 16, initializerOffset, true);
      return offset;
    },

    writeArrayPattern(elementOffsets, initializerOffset = 0, pos) {
      const count = elementOffsets.length;
      const { offset, ptr } = alloc(20 + count * 4);
      writeHeader(ptr, NODE.ARRAY_PATTERN, 0, pos);
      view.setUint32(ptr + 12, initializerOffset, true);
      view.setUint32(ptr + 16, count, true);
      for (let i = 0; i < count; i++) {
        view.setUint32(ptr + 20 + i * 4, elementOffsets[i], true);
      }
      return offset;
    },

    writeObjectPattern(propertyOffsets, initializerOffset = 0, pos) {
      const count = propertyOffsets.length;
      const { offset, ptr } = alloc(20 + count * 4);
      writeHeader(ptr, NODE.OBJECT_PATTERN, 0, pos);
      view.setUint32(ptr + 12, initializerOffset, true);
      view.setUint32(ptr + 16, count, true);
      for (let i = 0; i < count; i++) {
        view.setUint32(ptr + 20 + i * 4, propertyOffsets[i], true);
      }
      return offset;
    },

    // The declaration/parameter initializer is written after the pattern
    // itself is built (the parser binds the pattern on a rewound pass,
    // then learns the initializer offset).
    patchPatternInitializer(patternOffset, initializerOffset) {
      const ptr = mem.abs(mem.getAstRegionBase() + patternOffset);
      view.setUint32(ptr + 12, initializerOffset, true);
    },

    writePatternElement({
      nameOffset = 0, keyNode = 0,
      nestedPattern = 0, defaultValue = 0,
      flags = 0, pos,
    }) {
      const { offset, ptr } = alloc(28);
      writeHeader(ptr, NODE.PATTERN_ELEMENT, flags, pos);
      view.setUint32(ptr + 12, nameOffset, true);
      view.setUint32(ptr + 16, keyNode, true);
      view.setUint32(ptr + 20, nestedPattern, true);
      view.setUint32(ptr + 24, defaultValue, true);
      return offset;
    },

    writeBlock(stmtOffsets, pos) {
      const count = stmtOffsets.length;
      const { offset, ptr } = alloc(16 + count * 4);
      writeHeader(ptr, NODE.BLOCK, 0, pos);
      view.setUint32(ptr + 12, count, true);
      for (let i = 0; i < count; i++) {
        view.setUint32(ptr + 16 + i * 4, stmtOffsets[i], true);
      }
      return offset;
    },

    writeExpressionStatement(expression, pos) {
      const { offset, ptr } = alloc(16);
      writeHeader(ptr, NODE.EXPRESSION_STMT, 0, pos);
      view.setUint32(ptr + 12, expression, true);
      return offset;
    },

    writeEmptyStatement(pos) {
      const { offset, ptr } = alloc(12);
      writeHeader(ptr, NODE.EMPTY_STMT, 0, pos);
      return offset;
    },

    // -----------------------------------------------------------------------
    // Composite literals
    // -----------------------------------------------------------------------

    writeArrayLiteral(elemOffsets, pos) {
      const count = elemOffsets.length;
      const { offset, ptr } = alloc(16 + count * 4);
      writeHeader(ptr, NODE.ARRAY_LITERAL, 0, pos);
      view.setUint32(ptr + 12, count, true);
      for (let i = 0; i < count; i++) {
        view.setUint32(ptr + 16 + i * 4, elemOffsets[i], true);
      }
      return offset;
    },

    writeObjectLiteral(propOffsets, pos) {
      const count = propOffsets.length;
      const { offset, ptr } = alloc(16 + count * 4);
      writeHeader(ptr, NODE.OBJECT_LITERAL, 0, pos);
      view.setUint32(ptr + 12, count, true);
      for (let i = 0; i < count; i++) {
        view.setUint32(ptr + 16 + i * 4, propOffsets[i], true);
      }
      return offset;
    },

    writeObjectProperty(key, value, flags = 0, pos) {
      const { offset, ptr } = alloc(20);
      writeHeader(ptr, NODE.OBJECT_PROPERTY, flags, pos);
      view.setUint32(ptr + 12, key, true);
      view.setUint32(ptr + 16, value, true);
      return offset;
    },

    writeTemplateLiteral(partOffsets, pos) {
      const count = partOffsets.length;
      const { offset, ptr } = alloc(16 + count * 4);
      writeHeader(ptr, NODE.TEMPLATE_LITERAL, 0, pos);
      view.setUint32(ptr + 12, count, true);
      for (let i = 0; i < count; i++) {
        view.setUint32(ptr + 16 + i * 4, partOffsets[i], true);
      }
      return offset;
    },

    writeTaggedTemplate(tag, template, pos) {
      const { offset, ptr } = alloc(20);
      writeHeader(ptr, NODE.TAGGED_TEMPLATE, 0, pos);
      view.setUint32(ptr + 12, tag, true);
      view.setUint32(ptr + 16, template, true);
      return offset;
    },

    // -----------------------------------------------------------------------
    // Async
    // -----------------------------------------------------------------------

    writeAwait(argument, pos) {
      const { offset, ptr } = alloc(16);
      writeHeader(ptr, NODE.AWAIT, 0, pos);
      view.setUint32(ptr + 12, argument, true);
      return offset;
    },

    writeYield(argument, isDelegate, pos) {
      const { offset, ptr } = alloc(16);
      writeHeader(ptr, NODE.YIELD, isDelegate ? FLAG.YIELD_DELEGATE : 0, pos);
      view.setUint32(ptr + 12, argument, true);
      return offset;
    },

    // -----------------------------------------------------------------------
    // SS-specific
    // -----------------------------------------------------------------------

    writeGrant(identifiers, body, deniedParam, deniedBody, pos) {
      let flags = 0;
      if (deniedBody !== 0) flags |= FLAG.GRANT_HAS_DENIED;
      const count = identifiers.length;
      const { offset, ptr } = alloc(28 + count * 4);
      writeHeader(ptr, NODE.GRANT, flags, pos);
      view.setUint32(ptr + 12, body, true);
      view.setUint32(ptr + 16, deniedParam, true);
      view.setUint32(ptr + 20, deniedBody, true);
      view.setUint32(ptr + 24, count, true);
      for (let i = 0; i < count; i++) {
        view.setUint32(ptr + 28 + i * 4, identifiers[i], true);
      }
      return offset;
    },

    // -----------------------------------------------------------------------
    // Root chain
    //
    // Each parse() call writes one ROOT and commits it. The region header's
    // first_root and last_root form a singly-linked list via each ROOT's
    // nextRoot field. New roots get O(1) appended via the last_root pointer.
    // -----------------------------------------------------------------------

    writeRoot(body, pos) {
      const { offset, ptr } = alloc(20);
      writeHeader(ptr, NODE.ROOT, 0, pos);
      view.setUint32(ptr + 12, body, true);
      view.setUint32(ptr + 16, 0, true); // nextRoot = 0 until next root commits
      return offset;
    },

    /**
     * Link a freshly-written root into the chain. First commit also sets
     * the region header's `firstRoot`. Updates region header's `lastRoot`.
     */
    commitRoot(rootOffset) {
      const header = mem.getAstRegionHeader();
      if (header.rootNodeOffset === 0) {
        // First root — set firstRoot and lastRoot.
        mem.setAstRegionRootNodeOffset(rootOffset);
        mem.setAstRegionLastRootOffset(rootOffset);
        return;
      }
      // Subsequent root — patch the previous tail's nextRoot, then advance
      // lastRoot.
      const prevTailOffset = mem.getAstRegionLastRootOffset();
      const prevTailPtr = mem.abs(mem.getAstRegionBase() + prevTailOffset);
      view.setUint32(prevTailPtr + 16, rootOffset, true);
      mem.setAstRegionLastRootOffset(rootOffset);
    },
  };

  // ---------------------------------------------------------------------------
  // Internal helpers (capturing closures over view + alloc + writeHeader)
  // ---------------------------------------------------------------------------

  function writeCallLike(tag, callee, args, pos) {
    const count = args.length;
    const { offset, ptr } = alloc(20 + count * 4);
    writeHeader(ptr, tag, 0, pos);
    view.setUint32(ptr + 12, callee, true);
    view.setUint32(ptr + 16, count, true);
    for (let i = 0; i < count; i++) {
      view.setUint32(ptr + 20 + i * 4, args[i], true);
    }
    return offset;
  }
}

// =============================================================================
// No-op writer
//
// When inlineSource is off, the parser still threads astNode offsets through
// emit() calls — they're just always 0. Returning a writer whose methods
// all return 0 lets the parser stay simple (no per-call null-checks).
// =============================================================================

export function createNoOpAstWriter() {
  const noop = () => 0;
  return new Proxy(
    {},
    {
      get() {
        return noop;
      },
    }
  );
}

// =============================================================================
// Reader
// =============================================================================

/**
 * Create a reader bound to a memory image's AST region. Decodes raw bytes
 * back into structured node objects. Resolves intern-string offsets to
 * actual JS strings so consumers don't have to plumb the intern table.
 */
export function createAstReader(mem) {
  const view = mem.view;

  function nodePtr(offset) {
    return mem.abs(mem.getAstRegionBase() + offset);
  }

  function readString(stringOffset) {
    if (stringOffset === 0) return null;
    return mem.readString(stringOffset);
  }

  function operatorName(family, kind) {
    return OPERATOR_NAMES[family][kind] ?? `UNKNOWN_${kind}`;
  }

  function readNode(offset) {
    if (offset === 0) return null;
    if (!Number.isInteger(offset)) {
      // A NaN address coerces to 0 in DataView reads, so without this guard
      // a bad offset reads the SANDFUEL magic and reports "unknown tag 0x4153".
      throw new Error(
        `readNode: offset must be an integer, got ${offset}. ` +
        `A missing root usually means parse() returned complete: false — check its error field.`);
    }
    const ptr = nodePtr(offset);
    const tag = view.getUint16(ptr + 0, true);
    const flags = view.getUint16(ptr + 2, true);
    const line = view.getUint32(ptr + 4, true);
    const col = view.getUint32(ptr + 8, true);
    const base = { type: nodeTypeName(tag), flags, offset, line, col };

    switch (tag) {
      // Literals
      case NODE.LITERAL_INTEGER:
        return { ...base, value: view.getBigInt64(ptr + 12, true) };
      case NODE.LITERAL_FLOAT:
        return { ...base, value: view.getFloat64(ptr + 12, true) };
      case NODE.LITERAL_BOOLEAN:
        return { ...base, value: flags === 1 };
      case NODE.LITERAL_NULL:
        return { ...base, value: null };
      case NODE.LITERAL_UNDEFINED:
        return { ...base, value: undefined };
      case NODE.LITERAL_STRING:
        return { ...base, value: readString(view.getUint32(ptr + 12, true)) };
      case NODE.LITERAL_RATIONAL:
        return {
          ...base,
          numerator: view.getBigInt64(ptr + 12, true),
          denominator: view.getBigInt64(ptr + 20, true),
        };
      case NODE.LITERAL_BIGINT:
        return {
          ...base,
          value: BigInt(readString(view.getUint32(ptr + 12, true))),
        };
      case NODE.LITERAL_REGEXP:
        return {
          ...base,
          pattern: readString(view.getUint32(ptr + 12, true)),
          flagsWord: view.getUint32(ptr + 16, true),
        };

      // Names and access
      case NODE.IDENTIFIER:
        return { ...base, name: readString(view.getUint32(ptr + 12, true)) };
      case NODE.THIS:
      case NODE.SUPER:
      case NODE.NEW_TARGET:
        return base;
      case NODE.MEMBER_ACCESS:
      case NODE.OPTIONAL_MEMBER:
        return {
          ...base,
          object: view.getUint32(ptr + 12, true),
          name: readString(view.getUint32(ptr + 16, true)),
        };
      case NODE.INDEX_ACCESS:
      case NODE.OPTIONAL_INDEX:
        return {
          ...base,
          object: view.getUint32(ptr + 12, true),
          index: view.getUint32(ptr + 16, true),
        };

      // Operators
      case NODE.BINARY_OP:
        return {
          ...base,
          op: operatorName('BinaryOp', view.getUint8(ptr + 12)),
          opKind: view.getUint8(ptr + 12),
          left: view.getUint32(ptr + 16, true),
          right: view.getUint32(ptr + 20, true),
        };
      case NODE.LOGICAL_OP:
        return {
          ...base,
          op: operatorName('LogicalOp', view.getUint8(ptr + 12)),
          opKind: view.getUint8(ptr + 12),
          left: view.getUint32(ptr + 16, true),
          right: view.getUint32(ptr + 20, true),
        };
      case NODE.UNARY_OP:
        return {
          ...base,
          op: operatorName('UnaryOp', view.getUint8(ptr + 12)),
          opKind: view.getUint8(ptr + 12),
          operand: view.getUint32(ptr + 16, true),
        };
      case NODE.UPDATE:
        return {
          ...base,
          op: operatorName('UpdateOp', view.getUint8(ptr + 12)),
          opKind: view.getUint8(ptr + 12),
          prefix: view.getUint8(ptr + 13) === 1,
          operand: view.getUint32(ptr + 16, true),
        };
      case NODE.ASSIGNMENT:
        return {
          ...base,
          op: operatorName('AssignOp', view.getUint8(ptr + 12)),
          opKind: view.getUint8(ptr + 12),
          target: view.getUint32(ptr + 16, true),
          value: view.getUint32(ptr + 20, true),
        };
      case NODE.CONDITIONAL:
        return {
          ...base,
          test: view.getUint32(ptr + 12, true),
          consequent: view.getUint32(ptr + 16, true),
          alternate: view.getUint32(ptr + 20, true),
        };
      case NODE.SEQUENCE: {
        const count = view.getUint32(ptr + 12, true);
        const expressions = [];
        for (let i = 0; i < count; i++) {
          expressions.push(view.getUint32(ptr + 16 + i * 4, true));
        }
        return { ...base, expressions };
      }
      case NODE.SPREAD:
        return { ...base, argument: view.getUint32(ptr + 12, true) };

      // Calls
      case NODE.CALL:
      case NODE.NEW:
      case NODE.OPTIONAL_CALL: {
        const callee = view.getUint32(ptr + 12, true);
        const count = view.getUint32(ptr + 16, true);
        const args = [];
        for (let i = 0; i < count; i++) {
          args.push(view.getUint32(ptr + 20 + i * 4, true));
        }
        return { ...base, callee, args };
      }

      // Control flow
      case NODE.IF:
        return {
          ...base,
          test: view.getUint32(ptr + 12, true),
          consequent: view.getUint32(ptr + 16, true),
          alternate: view.getUint32(ptr + 20, true),
          hasAlternate: (flags & FLAG.IF_HAS_ALT) !== 0,
        };
      case NODE.WHILE:
        return {
          ...base,
          test: view.getUint32(ptr + 12, true),
          body: view.getUint32(ptr + 16, true),
        };
      case NODE.DO_WHILE:
        return {
          ...base,
          body: view.getUint32(ptr + 12, true),
          test: view.getUint32(ptr + 16, true),
        };
      case NODE.FOR:
        return {
          ...base,
          init: view.getUint32(ptr + 12, true),
          test: view.getUint32(ptr + 16, true),
          update: view.getUint32(ptr + 20, true),
          body: view.getUint32(ptr + 24, true),
        };
      case NODE.FOR_IN:
        return {
          ...base,
          binding: view.getUint32(ptr + 12, true),
          iterable: view.getUint32(ptr + 16, true),
          body: view.getUint32(ptr + 20, true),
          declarationKeyword: (flags & FLAG.FOR_IN_CONST) !== 0 ? 'const'
            : (flags & FLAG.FOR_IN_LET) !== 0 ? 'let' : null,
        };
      case NODE.FOR_OF:
        return {
          ...base,
          binding: view.getUint32(ptr + 12, true),
          iterable: view.getUint32(ptr + 16, true),
          body: view.getUint32(ptr + 20, true),
          isAwait: (flags & FLAG.FOR_OF_AWAIT) !== 0,
          declarationKeyword: (flags & FLAG.FOR_OF_CONST) !== 0 ? 'const'
            : (flags & FLAG.FOR_OF_LET) !== 0 ? 'let' : null,
        };
      case NODE.BREAK:
      case NODE.CONTINUE:
        return {
          ...base,
          label: readString(view.getUint32(ptr + 12, true)),
        };
      case NODE.RETURN:
      case NODE.THROW: {
        const valueOffset = view.getUint32(ptr + 12, true);
        return { ...base, value: valueOffset === 0 ? null : valueOffset };
      }
      case NODE.TRY:
        return {
          ...base,
          block: view.getUint32(ptr + 12, true),
          catchParam: view.getUint32(ptr + 16, true),
          catchBlock: view.getUint32(ptr + 20, true),
          finallyBlock: view.getUint32(ptr + 24, true),
          hasCatch: (flags & FLAG.TRY_HAS_CATCH) !== 0,
          hasFinally: (flags & FLAG.TRY_HAS_FINALLY) !== 0,
        };
      case NODE.LABELED:
        return {
          ...base,
          label: readString(view.getUint32(ptr + 12, true)),
          body: view.getUint32(ptr + 16, true),
        };
      case NODE.SWITCH: {
        const discriminant = view.getUint32(ptr + 12, true);
        const count = view.getUint32(ptr + 16, true);
        const caseRefs = [];
        for (let i = 0; i < count; i++) {
          caseRefs.push(view.getUint32(ptr + 20 + i * 4, true));
        }
        return { ...base, discriminant, cases: caseRefs };
      }
      case NODE.SWITCH_CASE: {
        const test = view.getUint32(ptr + 12, true);
        const count = view.getUint32(ptr + 16, true);
        const stmts = [];
        for (let i = 0; i < count; i++) {
          stmts.push(view.getUint32(ptr + 20 + i * 4, true));
        }
        return { ...base, test: flags === 1 ? null : test, isDefault: flags === 1, statements: stmts };
      }

      // Declarations and statements
      case NODE.FUNCTION_DECL: {
        const nameOffset = view.getUint32(ptr + 12, true);
        const count = view.getUint32(ptr + 16, true);
        const body = view.getUint32(ptr + 20, true);
        const params = [];
        for (let i = 0; i < count; i++) {
          params.push(view.getUint32(ptr + 24 + i * 4, true));
        }
        return {
          ...base,
          name: readString(nameOffset),
          params,
          body,
          isAsync: (flags & FLAG.FN_ASYNC) !== 0,
          isArrow: (flags & FLAG.FN_ARROW) !== 0,
          isGenerator: (flags & FLAG.FN_GENERATOR) !== 0,
          isExported: (flags & FLAG.FN_EXPORTED) !== 0,
        };
      }
      case NODE.CLASS_DECL: {
        const nameOffset = view.getUint32(ptr + 12, true);
        const heritage = view.getUint32(ptr + 16, true);
        const count = view.getUint32(ptr + 20, true);
        const members = [];
        for (let i = 0; i < count; i++) {
          members.push(view.getUint32(ptr + 24 + i * 4, true));
        }
        return {
          ...base,
          name: readString(nameOffset),
          heritage,
          members,
          isExported: (flags & FLAG.CLASS_EXPORTED) !== 0,
          isExpression: (flags & FLAG.CLASS_EXPRESSION) !== 0,
        };
      }
      case NODE.CLASS_MEMBER:
        return {
          ...base,
          key: view.getUint32(ptr + 12, true),
          value: view.getUint32(ptr + 16, true),
          isStatic: (flags & FLAG.MEMBER_STATIC) !== 0,
          isGetter: (flags & FLAG.MEMBER_GETTER) !== 0,
          isSetter: (flags & FLAG.MEMBER_SETTER) !== 0,
          isField: (flags & FLAG.MEMBER_FIELD) !== 0,
          isComputed: (flags & FLAG.MEMBER_KEY_COMPUTED) !== 0,
          isConstructor: (flags & FLAG.MEMBER_CTOR) !== 0,
          isStaticBlock: (flags & FLAG.MEMBER_STATIC_BLOCK) !== 0,
          isPrivate: (flags & FLAG.MEMBER_PRIVATE) !== 0,
        };
      case NODE.VARIABLE_DECL: {
        const count = view.getUint32(ptr + 12, true);
        const bindings = [];
        for (let i = 0; i < count; i++) {
          bindings.push(view.getUint32(ptr + 16 + i * 4, true));
        }
        return {
          ...base,
          bindings,
          isConst: (flags & FLAG.VAR_CONST) !== 0,
          isExported: (flags & FLAG.VAR_EXPORTED) !== 0,
        };
      }
      case NODE.VARIABLE_BINDING: {
        const nameOffset = view.getUint32(ptr + 12, true);
        const init = view.getUint32(ptr + 16, true);
        return {
          ...base,
          name: readString(nameOffset),
          initializer: init === 0 ? null : init,
          hasInitializer: (flags & FLAG.BINDING_HAS_INIT) !== 0,
        };
      }
      case NODE.ARRAY_PATTERN:
      case NODE.OBJECT_PATTERN: {
        const init = view.getUint32(ptr + 12, true);
        const count = view.getUint32(ptr + 16, true);
        const entries = [];
        for (let i = 0; i < count; i++) {
          entries.push(view.getUint32(ptr + 20 + i * 4, true));
        }
        return tag === NODE.ARRAY_PATTERN
          ? { ...base, initializer: init === 0 ? null : init, elements: entries }
          : { ...base, initializer: init === 0 ? null : init, properties: entries };
      }
      case NODE.PATTERN_ELEMENT: {
        const key = view.getUint32(ptr + 16, true);
        const nested = view.getUint32(ptr + 20, true);
        const defaultValue = view.getUint32(ptr + 24, true);
        return {
          ...base,
          name: readString(view.getUint32(ptr + 12, true)),
          key: key === 0 ? null : key,
          nestedPattern: nested === 0 ? null : nested,
          defaultValue: defaultValue === 0 ? null : defaultValue,
          isRest: (flags & FLAG.PATTERN_REST) !== 0,
          isHole: (flags & FLAG.PATTERN_HOLE) !== 0,
          isShorthand: (flags & FLAG.PATTERN_SHORTHAND) !== 0,
          isKeyComputed: (flags & FLAG.PATTERN_KEY_COMPUTED) !== 0,
        };
      }
      case NODE.BLOCK: {
        const count = view.getUint32(ptr + 12, true);
        const statements = [];
        for (let i = 0; i < count; i++) {
          statements.push(view.getUint32(ptr + 16 + i * 4, true));
        }
        return { ...base, statements };
      }
      case NODE.EXPRESSION_STMT:
        return { ...base, expression: view.getUint32(ptr + 12, true) };
      case NODE.EMPTY_STMT:
        return base;

      // Composite literals
      case NODE.ARRAY_LITERAL: {
        const count = view.getUint32(ptr + 12, true);
        const elements = [];
        for (let i = 0; i < count; i++) {
          elements.push(view.getUint32(ptr + 16 + i * 4, true));
        }
        return { ...base, elements };
      }
      case NODE.OBJECT_LITERAL: {
        const count = view.getUint32(ptr + 12, true);
        const properties = [];
        for (let i = 0; i < count; i++) {
          properties.push(view.getUint32(ptr + 16 + i * 4, true));
        }
        return { ...base, properties };
      }
      case NODE.OBJECT_PROPERTY:
        return {
          ...base,
          key: view.getUint32(ptr + 12, true),
          value: view.getUint32(ptr + 16, true),
          isShorthand: (flags & FLAG.PROP_SHORTHAND) !== 0,
          isComputed: (flags & FLAG.PROP_COMPUTED) !== 0,
          isMethod: (flags & FLAG.PROP_METHOD) !== 0,
          isGetter: (flags & FLAG.PROP_GETTER) !== 0,
          isSetter: (flags & FLAG.PROP_SETTER) !== 0,
        };
      case NODE.TEMPLATE_LITERAL: {
        const count = view.getUint32(ptr + 12, true);
        const parts = [];
        for (let i = 0; i < count; i++) {
          parts.push(view.getUint32(ptr + 16 + i * 4, true));
        }
        return { ...base, parts };
      }
      case NODE.TAGGED_TEMPLATE:
        return {
          ...base,
          tagFunction: view.getUint32(ptr + 12, true),
          template: view.getUint32(ptr + 16, true),
        };

      // Async
      case NODE.AWAIT:
        return { ...base, argument: view.getUint32(ptr + 12, true) };

      case NODE.YIELD:
        return {
          ...base,
          argument: view.getUint32(ptr + 12, true),
          isDelegate: (flags & FLAG.YIELD_DELEGATE) !== 0,
        };

      case NODE.GRANT: {
        const body = view.getUint32(ptr + 12, true);
        const deniedParamOffset = view.getUint32(ptr + 16, true);
        const deniedBody = view.getUint32(ptr + 20, true);
        const count = view.getUint32(ptr + 24, true);
        const identifiers = [];
        for (let i = 0; i < count; i++) {
          identifiers.push(view.getUint32(ptr + 28 + i * 4, true));
        }
        return {
          ...base,
          body,
          deniedParam: deniedParamOffset === 0 ? null : readString(deniedParamOffset),
          deniedBody,
          identifiers,
          hasDenied: (flags & FLAG.GRANT_HAS_DENIED) !== 0,
        };
      }

      // Root chain
      case NODE.ROOT:
        return {
          ...base,
          body: view.getUint32(ptr + 12, true),
          nextRoot: view.getUint32(ptr + 16, true),
        };

      default:
        throw new Error(`Unknown AST node tag 0x${tag.toString(16)} at offset ${offset}`);
    }
  }


  // Recursively reads a node and all its child references, driven by
  // NODE_LAYOUT (child names). The visited set guards against cycles
  // (which shouldn't exist in a write-once AST, but defensive read is
  // cheap). ROOT's `chain` link is deliberately NOT materialized — a
  // ROOT's tree is one parse, not the whole chain.
  function readTree(offset, visited = new Set()) {
    if (offset === 0) return null;
    if (visited.has(offset)) {
      throw new Error(`AST cycle detected at offset ${offset}`);
    }
    visited.add(offset);

    const node = readNode(offset);
    if (node === null) return null;
    const ptr = nodePtr(offset);
    const tag = view.getUint16(ptr + 0, true);
    const layout = NODE_LAYOUT[tag] ?? {};

    for (const { name } of layout.children ?? []) {
      if (name in node && typeof node[name] === 'number') {
        node[name] = readTree(node[name], visited);
      }
    }
    if (layout.childArray && Array.isArray(node[layout.childArray.name])) {
      node[layout.childArray.name] =
        node[layout.childArray.name].map(o => readTree(o, visited));
    }
    return node;
  }

  return {
    /**
     * Read a node by offset. Returns the node's structured fields with
     * children left as raw u32 offsets. Returns null if offset is 0
     * (sentinel "absent").
     */
    readNode,

    /**
     * Recursively read a node and all descendants. Children become nested
     * objects rather than offsets. Useful for full-tree walks.
     */
    readTree(offset) {
      return readTree(offset);
    },

    /**
     * Iterate root nodes in parse order. Each parse() call appends one
     * root to the chain.
     */
    *iterateRoots() {
      const header = mem.getAstRegionHeader();
      if (!header || header.rootNodeOffset === 0) return;
      let cur = header.rootNodeOffset;
      while (cur !== 0) {
        yield cur;
        const node = readNode(cur);
        cur = node.nextRoot;
      }
    },

    /**
     * Iterate every string-table reference in every node reachable from
     * the root chain. Yields { fieldPointer, stringOffset } where
     * fieldPointer is the ABSOLUTE address of the u32 field (ready for
     * an in-place rewrite) and stringOffset its current value (never 0
     * — sentinel fields are skipped).
     *
     * Used by the collector: mark phase keeps AST-referenced strings
     * alive (some — bigint digit strings — have no other reference);
     * string compaction forwards the fields via this same walk.
     *
     * Driven entirely by NODE_LAYOUT on raw u32 reads — no node
     * materialization, so the walk never touches string BYTES (only
     * ids) and is valid before or after string moves. This is the
     * exact walk the WAT collector reproduces from the host-written
     * knowledge table: prime with the first root, follow
     * child/childArray/chain edges,
     * dedup with a visited set. Nodes left unreachable by a
     * rolled-back parse are not visited; their string references may
     * go stale, which is harmless — nothing can reach those nodes.
     */
    *iterateStringFields() {
      const header = mem.getAstRegionHeader();
      if (!header || header.rootNodeOffset === 0) return;

      const stack = [header.rootNodeOffset];
      const visited = new Set();
      while (stack.length > 0) {
        const offset = stack.pop();
        if (offset === 0 || visited.has(offset)) continue;
        visited.add(offset);

        const ptr = nodePtr(offset);
        const tag = view.getUint16(ptr, true);
        const layout = NODE_LAYOUT[tag];
        if (layout === undefined) {
          throw new Error(
            `iterateStringFields: unknown AST node tag 0x${tag.toString(16)} at offset ${offset}`);
        }

        for (const fieldOffset of layout.strings ?? []) {
          const stringOffset = view.getUint32(ptr + fieldOffset, true);
          if (stringOffset !== 0) {
            yield { fieldPointer: ptr + fieldOffset, stringOffset };
          }
        }

        for (const { offset: fieldOffset } of layout.children ?? []) {
          stack.push(view.getUint32(ptr + fieldOffset, true));
        }
        if (layout.childArray !== undefined) {
          const count = view.getUint32(ptr + layout.childArray.count, true);
          for (let i = 0; i < count; i++) {
            stack.push(view.getUint32(ptr + layout.childArray.start + i * 4, true));
          }
        }
        if (layout.chain !== undefined) {
          stack.push(view.getUint32(ptr + layout.chain, true));
        }
      }
    },
  };
}

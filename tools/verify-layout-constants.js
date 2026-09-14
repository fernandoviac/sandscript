/**
 * Layout-constants verifier.
 *
 * constants.js is the single source of truth for layout facts (STATE /
 * CTX / OBJ / TYPE / OP / METHOD / FRAME offsets, sizes, tags). The WAT
 * duplicates them as immutable `(global $NAME i32 (i32.const VALUE))`
 * declarations. This tool parses every immutable global out of
 * interpreter.wat, maps each name to its constants.js expression via
 * per-family rules, and fails when:
 *
 *   - a mapped pair disagrees on value (drift — the bug class this
 *     tool exists to kill), or
 *   - a WAT global maps to nothing and is not on the explicit
 *     WAT-only allowlist (a new layout fact added only in the WAT).
 *
 * JS-only constants are fine (the host legitimately knows facts the
 * interpreter never touches) and are reported only when run standalone.
 *
 * Runs as part of `deno task wasm` (imported by build-fuel-wasm.js)
 * and standalone:
 *
 *   deno run --allow-read tools/verify-layout-constants.js
 */

import * as C from '../src/fuel/constants.js';

// Every WAT source that is concatenated into the fuel module shares one
// linear memory and one type-tag space, so every file must obey the
// constants.js registry. proof-kernel.wat once took type 0x2B for
// $TYPE_PROOF_NAMESPACE without a registry row; the id later collided
// with TYPE.REGEXP and silently swallowed RegExp property reads.
const DEFAULT_WAT_PATHS = [
  new URL('../src/fuel/interpreter.wat', import.meta.url).pathname,
  new URL('../src/fuel/proof-kernel.wat', import.meta.url).pathname,
];

// WAT globals with deliberately no constants.js counterpart. Adding a
// name here needs a reason the fact is interpreter-internal:
//   HASH_TABLE_BUCKETS — JS derives HASH_TABLE_SIZE (= buckets × 8).
//   MAX_PROTO_DEPTH    — dispatch-loop behavior cap, never read by JS.
//   MSGPACK_*          — the WAT decoder's internal type enums; the JS
//                        marshaller speaks wire bytes, not these tags.
const WAT_ONLY_ALLOWED = new Set([
  'HASH_TABLE_BUCKETS',
  'MAX_PROTO_DEPTH',
  'MSGPACK_NIL',
  'MSGPACK_BOOL',
  'MSGPACK_INT',
  'MSGPACK_FLOAT',
  'MSGPACK_STRING',
  'MSGPACK_ARRAY',
  'MSGPACK_MAP',
  'MSGPACK_BIN',
  'MSGPACK_ERROR',
  // The multivariate coefficient classifier's scratch-record layout is
  // entirely internal to WAT: algebraic_roots_of_polynomial and
  // algebraic_classify_term carve, fill, and consume monomial records.
  // No JS-side code reads or writes them, so there is no constants.js
  // counterpart to verify against.
  'ALGEBRAIC_MONOMIAL_MAX_FACTORS',
  'ALGEBRAIC_MONOMIAL_RECORD_SIZE',
  // ALGEBRAIC_MAX_VARIABLES bounds distinct algebraic values in one
  // elimination because work grows as the product of the input degrees.
  // It is internal to algebraic_collect_variable_registry and therefore
  // has no JS-side counterpart.
  'ALGEBRAIC_MAX_VARIABLES',
]);

// Whole prefixes with deliberately no constants.js counterpart:
//   PROOF_ — the proof kernel's private wire enums (term/record tags,
//            handle kinds, artifact magic). JS speaks the artifact byte
//            format, never these tags. Shared-space names (TYPE_*,
//            OBJ_*, STATE_*, …) are NOT under this prefix, so the
//            registry stays enforced where memory is shared — the
//            $TYPE_PROOF_NAMESPACE/TYPE.REGEXP 0x2B collision is the
//            incident this distinction exists for.
const WAT_ONLY_ALLOWED_PREFIXES = ['PROOF_'];

const scalarNames = new Set(Object.keys(C).filter((key) => typeof C[key] === 'number'));

function lookupIn(objectName, key) {
  const object = C[objectName];
  if (object && typeof object === 'object' && typeof object[key] === 'number') {
    return { expression: `${objectName}.${key}`, expected: object[key] };
  }
  return null;
}

// Explicit table for Map/Set: names diverge AND the header fields carry
// a basis conversion (constants.js MAP_LAYOUT/SET_LAYOUT are
// header-relative; the WAT globals are data-relative — GC_HEADER_SIZE
// apart).
const MAP_SET_TABLE = {
  MAP_SIZE_OFFSET:           { expression: 'MAP_LAYOUT.SIZE - GC_HEADER_SIZE',        expected: C.MAP_LAYOUT.SIZE - C.GC_HEADER_SIZE },
  MAP_SLOT_COUNT_OFFSET:     { expression: 'MAP_LAYOUT.SLOT_COUNT - GC_HEADER_SIZE',  expected: C.MAP_LAYOUT.SLOT_COUNT - C.GC_HEADER_SIZE },
  MAP_CAPACITY_OFFSET:       { expression: 'MAP_LAYOUT.CAPACITY - GC_HEADER_SIZE',    expected: C.MAP_LAYOUT.CAPACITY - C.GC_HEADER_SIZE },
  MAP_ENTRIES_PTR_OFFSET:    { expression: 'MAP_LAYOUT.ENTRIES_PTR - GC_HEADER_SIZE', expected: C.MAP_LAYOUT.ENTRIES_PTR - C.GC_HEADER_SIZE },
  MAP_SYM_ENTRIES_OFFSET:    { expression: 'MAP_LAYOUT.SYM_ENTRIES - GC_HEADER_SIZE', expected: C.MAP_LAYOUT.SYM_ENTRIES - C.GC_HEADER_SIZE },
  MAP_SLOT_STRIDE:           { expression: 'MAP_LAYOUT.SLOT_STRIDE',                  expected: C.MAP_LAYOUT.SLOT_STRIDE },
  MAP_SLOT_TOMBSTONE_OFFSET: { expression: 'MAP_LAYOUT.SLOT_TOMBSTONE',               expected: C.MAP_LAYOUT.SLOT_TOMBSTONE },
  MAP_SLOT_KEY_OFFSET:       { expression: 'MAP_LAYOUT.SLOT_KEY',                     expected: C.MAP_LAYOUT.SLOT_KEY },
  MAP_SLOT_VALUE_OFFSET:     { expression: 'MAP_LAYOUT.SLOT_VALUE',                   expected: C.MAP_LAYOUT.SLOT_VALUE },
  SET_SLOT_STRIDE:           { expression: 'SET_LAYOUT.SLOT_STRIDE',                  expected: C.SET_LAYOUT.SLOT_STRIDE },
  SET_SLOT_TOMBSTONE_OFFSET: { expression: 'SET_LAYOUT.SLOT_TOMBSTONE',               expected: C.SET_LAYOUT.SLOT_TOMBSTONE },
  SET_SLOT_VALUE_OFFSET:     { expression: 'SET_LAYOUT.SLOT_VALUE',                   expected: C.SET_LAYOUT.SLOT_VALUE },
};

// One-offs where WAT and JS names diverge structurally.
const SPECIAL_TABLE = {
  OBJECT_SYM_ENTRIES_OFFSET: () => lookupIn('OBJECT', 'SYM_ENTRIES'),
  ARRAY_FLAG_FROZEN:         () => lookupIn('ARRAY_FLAG', 'FROZEN'),
  OBJECT_FLAG_FROZEN:        () => lookupIn('OBJECT_FLAG', 'FROZEN'),
  OBJECT_FLAG_EXTERNAL_BACKED: () => lookupIn('OBJECT_FLAG', 'EXTERNAL_BACKED'),
  OBJECT_FLAG_CONSTRUCTION_PENDING: () => lookupIn('OBJECT_FLAG', 'CONSTRUCTION_PENDING'),
  ARRAY_FLAGS_OFFSET:        () => lookupIn('ARRAY', 'FLAGS'),
  ARRAY_SYM_ENTRIES_OFFSET:  () => lookupIn('ARRAY', 'SYM_ENTRIES'),
};

const FAMILY_RULES = [
  { prefix: 'STATE_',        objectName: 'STATE' },
  { prefix: 'CTX_',          objectName: 'CTX' },
  { prefix: 'BUILTIN_',      objectName: 'BUILTIN_NAME' },
  { prefix: 'METHOD_',       objectName: 'METHOD' },
  { prefix: 'CONTINUATION_KIND_', objectName: 'CONTINUATION_KIND' },
  { prefix: 'PROOF_UNIVERSES_PHASE_', objectName: 'PROOF_UNIVERSES_PHASE' },
  { prefix: 'NATIVE_CONTINUATION_STATE_', objectName: 'NATIVE_CONTINUATION_STATE' },
  { prefix: 'TYPE_',         objectName: 'TYPE' },
  { prefix: 'OBJ_',          objectName: 'OBJ' },
  { prefix: 'OP_',           objectName: 'OP' },
  { prefix: 'FRAME_',        objectName: 'FRAME' },
  { prefix: 'TRY_',          objectName: 'TRY_ENTRY' },
  { prefix: 'GRANT_',        objectName: 'GRANT_ENTRY' },
  { prefix: 'PROMISE_WAITER_', objectName: 'PROMISE_WAITER' },
  // Schema engine families: longer prefixes first, SCHEMA_ (descriptor
  // payload offsets) last.
  { prefix: 'SCHEMA_STATUS_', objectName: 'SCHEMA_STATUS' },
  { prefix: 'SCHEMA_OPT_',    objectName: 'SCHEMA_OPT' },
  { prefix: 'SCHEMA_MODE_',   objectName: 'SCHEMA_MODE' },
  { prefix: 'SCHEMA_CH_',     objectName: 'SCHEMA_CH' },
  { prefix: 'SCHEMA_WH_',     objectName: 'SCHEMA_WH' },
  { prefix: 'SCHEMA_DIAG_',   objectName: 'SCHEMA_DIAG' },
  { prefix: 'SCHEMA_LIMITS_', objectName: 'SCHEMA_LIMITS' },
  { prefix: 'SCHEMA_KW_',     objectName: 'SCHEMA_KW' },
  { prefix: 'SCHEMA_PH_',     objectName: 'SCHEMA_PH' },
  { prefix: 'SCHEMA_KIND_',   objectName: 'SCHEMA_KIND' },
  { prefix: 'SCHEMA_FLAG_',   objectName: 'SCHEMA_FLAG' },
  { prefix: 'SCHEMA_',        objectName: 'SCHEMA' },
  { prefix: 'REGEXP_FLAG_',  objectName: 'REGEXP_FLAG' },
  { prefix: 'REGEXP_',       objectName: 'REGEXP' },
  { prefix: 'REGEX_STATUS_', objectName: 'REGEX_STATUS' },
  { prefix: 'REGEX_SCAN_',   objectName: 'REGEX_SCAN' },
  { prefix: 'REGEX_EMIT_',   objectName: 'REGEX_EMIT' },
  { prefix: 'REGEX_CONT_',   objectName: 'REGEX_CONT' },
  { prefix: 'REGEX_PROGRAM_', objectName: 'REGEX_PROG' },
  { prefix: 'PROMISE_',      objectName: 'PROMISE' },
  // Collector-owned WAT families.
  { prefix: 'THEN_HANDLER_', objectName: 'THEN_HANDLER' },
  { prefix: 'GC_PHASE_',     objectName: 'GC_PHASE' },
  { prefix: 'AST_REGION_',   objectName: 'AST_REGION' },
  { prefix: 'GC_SCRATCH_',   objectName: 'GC_SCRATCH_HEADER' },
  { prefix: 'NOT_SUPPORTED_FEATURE_', objectName: 'NOT_SUPPORTED_FEATURE' },
  // Header-event ring families.
  { prefix: 'HEADER_EVENT_KIND_',  objectName: 'HEADER_EVENT_KIND' },
  { prefix: 'HEADER_EVENT_FIELD_', objectName: 'HEADER_EVENT_FIELD' },
  { prefix: 'HEADER_EVENT_SITE_',  objectName: 'HEADER_EVENT_SITE' },
  // Ring 3 polynomial-shape kinds.
  { prefix: 'POLY_KIND_',          objectName: 'POLY_KIND' },
];

function mapName(name) {
  // 1. Exact top-level scalar export (EXIT_*, ERR_*, VALUE_SIZE, ...).
  if (scalarNames.has(name)) {
    return { expression: name, expected: C[name] };
  }
  // 2. Map/Set explicit table (the basis conversion lives here).
  if (name in MAP_SET_TABLE) return MAP_SET_TABLE[name];
  // 3. Other explicit one-offs.
  if (name in SPECIAL_TABLE) {
    const result = SPECIAL_TABLE[name]();
    if (result) return result;
  }
  // 4. Family prefix rules.
  for (const { prefix, objectName } of FAMILY_RULES) {
    if (name.startsWith(prefix)) {
      const result = lookupIn(objectName, name.slice(prefix.length));
      if (result) return result;
    }
  }
  return null;
}

const hex = (value) => (value < 0 ? String(value) : '0x' + value.toString(16).toUpperCase());

/**
 * Verify the WAT sources' immutable globals against constants.js.
 *
 * @param {object} [options]
 * @param {string[]} [options.watPaths] — override the WAT files (tests).
 * @returns {{ ok: boolean, total: number, verified: number,
 *             mismatches: Array, unmapped: Array }}
 */
export async function verifyLayoutConstants({ watPaths = DEFAULT_WAT_PATHS } = {}) {
  // Shared-id-space uniqueness. TYPE/OBJ tags and METHOD ids each live in
  // ONE space across every receiver kind and every concatenated WAT
  // source (bound-method dispatch branches on method_id alone; the
  // builtin table's slot index IS the id). Two incidents prove the bug
  // class: $TYPE_PROOF_NAMESPACE squatting TYPE.REGEXP's 0x2B, and
  // METHOD.REGEXP_EXEC/TEST minted onto the Exact.Expression polynomial
  // ids (0x1E2/0x1E3) — latent until a dispatch arm keyed on the id.
  const duplicates = [];
  for (const tableName of ['TYPE', 'OBJ', 'METHOD']) {
    const byValue = new Map();
    for (const [key, value] of Object.entries(C[tableName])) {
      if (typeof value !== 'number') continue;
      if (!byValue.has(value)) byValue.set(value, []);
      byValue.get(value).push(key);
    }
    for (const [value, keys] of byValue) {
      if (keys.length > 1) duplicates.push({ tableName, value, keys });
    }
  }

  const globals = [];
  for (const watPath of watPaths) {
    const source = await Deno.readTextFile(watPath);
    const pattern = /\(global \$([A-Za-z0-9_]+)\s+i32\s+\(i32\.const\s+(-?(?:0x[0-9a-fA-F]+|\d+))\s*\)\)/g;
    const lines = source.split('\n');
    for (let lineIndex = 0; lineIndex < lines.length; lineIndex++) {
      pattern.lastIndex = 0;
      const match = pattern.exec(lines[lineIndex]);
      if (match) {
        globals.push({
          name: match[1], value: Number(match[2]),
          line: lineIndex + 1, watPath,
        });
      }
    }
  }

  const mismatches = [];
  const unmapped = [];
  let verified = 0;

  for (const global of globals) {
    const mapped = mapName(global.name);
    if (mapped === null) {
      if (!WAT_ONLY_ALLOWED.has(global.name) &&
          !WAT_ONLY_ALLOWED_PREFIXES.some((prefix) => global.name.startsWith(prefix))) {
        unmapped.push(global);
      }
      continue;
    }
    if (mapped.expected === global.value) {
      verified += 1;
    } else {
      mismatches.push({ ...global, ...mapped });
    }
  }

  const ok = mismatches.length === 0 && unmapped.length === 0 &&
    duplicates.length === 0;

  if (!ok) {
    console.error('Layout-constants verification FAILED.');
    for (const entry of mismatches) {
      console.error(
        `  MISMATCH  ${entry.watPath}:${entry.line}  $${entry.name} = ${hex(entry.value)}` +
        `  but  constants.js ${entry.expression} = ${hex(entry.expected)}`);
    }
    for (const entry of unmapped) {
      console.error(
        `  UNMAPPED  ${entry.watPath}:${entry.line}  $${entry.name} = ${hex(entry.value)}` +
        `  — no constants.js counterpart and not on the WAT-only allowlist.` +
        ` Add the fact to constants.js (preferred) or allowlist it with a reason.`);
    }
    for (const entry of duplicates) {
      console.error(
        `  DUPLICATE  constants.js ${entry.tableName} value ${hex(entry.value)}` +
        ` is minted by ${entry.keys.join(', ')} — ids in this table share one` +
        ` space; renumber the newcomer to a free id.`);
    }
  }

  return { ok, total: globals.length, verified, mismatches, unmapped, duplicates };
}

if (import.meta.main) {
  const report = await verifyLayoutConstants();
  if (report.ok) {
    console.log(
      `Layout constants OK: ${report.verified}/${report.total} WAT globals ` +
      `verified against constants.js (${report.total - report.verified} allowlisted WAT-only).`);
  }
  Deno.exit(report.ok ? 0 : 1);
}

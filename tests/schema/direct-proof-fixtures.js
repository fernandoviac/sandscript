// Build-time inputs only. Neither runtime host imports this codec nor drives an engine.
import { encode } from '../../src/membrane/msgpack.js';
import { createSchemaEngine } from '../../src/schema/index.js';
import { NUMERIC_CONVERSION_TEXTS } from './number-conversion-fixtures.js';

export const CASES = Object.freeze([
  'single compile, portable copy/load, test and validate',
  'ordered set match and matchAll, route-index verdicts',
  'external resource bundle and regex',
  'tiny/large grants preserve program bytes and work',
  'finite compilation exhaustion',
  'finite reference-chain evaluation exhaustion',
  'finite large-document exhaustion',
  'exact compilation completion',
  'over-budget compilation terminal precedence',
  'exact atomic set completion',
  'over-budget atomic set terminal precedence',
  'zero and sticky operation budget',
  'checked-u64 overflow and sticky saturation',
  'short scratch, measured-prefix relocation and input rebinding',
  'validation program/document relocation and retained check charge',
  'arena growth retains failed debt and exact retry completion',
  'unfinished arena equality forbids another attempt',
  'complete diagnostics, output growth and retained evaluation',
  'render shortage exhaustion remains sticky',
  'caller allocation refusal preserves owner spans',
  'corrupt document and wrapping MessagePack extent',
  'corrupt portable program geometry and nested offsets',
  'invalid and overlapping owner spans',
  'dependent lifetime cleanup and independent program ownership',
  'stored-error limits preserve honest totals and reject invalid capacity',
  'engine compile failure rendering and aggregate output retry',
  'shared exact numeric text and checked allocation-free regions',
  'full numeric string grammar and exact rounding boundaries',
  'exact hexadecimal numeric display without fractional truncation',
]);

const route = { type: 'object', required: ['kind'], properties: { kind: { const: 'a' } } };
const defs = { d0: true };
for (let i = 1; i <= 12; i++) defs[`d${i}`] = {
  allOf: [{ $ref: `#/$defs/d${i - 1}` }, { $ref: `#/$defs/d${i - 1}` }],
};
const missing = '雪/~'.repeat(1000);
const malformed = encode(Array.from({ length: 129 }, () => null));
malformed[malformed.length - 1] = 0xc1;
const utf8 = (text) => new TextEncoder().encode(text);

// Binary64 bits plus independently captured native Number text. The native
// caller consumes fixed records, not a host number formatter or codec.
function numberTextFixtures() {
  const values = [0, -0, NaN, Infinity, -Infinity, Number.MIN_VALUE, -Number.MIN_VALUE,
    Number.MAX_VALUE, -Number.MAX_VALUE, Number.MAX_SAFE_INTEGER, 1e-7, 1e-6,
    1.0000000000000002e-6, 1e20, 1e21, 1000000000000000100, 0.1, -0.1];
  const bits = new DataView(new ArrayBuffer(8));
  let state = 0x9e3779b97f4a7c15n;
  for (let i = 0; i < 8192; i++) {
    state = BigInt.asUintN(64, state ^ (state << 13n));
    state ^= state >> 7n;
    state = BigInt.asUintN(64, state ^ (state << 17n));
    bits.setBigUint64(0, state, true);
    values.push(bits.getFloat64(0, true));
  }
  const bytes = new Uint8Array(values.length * 48);
  const view = new DataView(bytes.buffer);
  for (let i = 0; i < values.length; i++) {
    const text = utf8(String(values[i]));
    if (text.length > 32) throw new Error('number fixture exceeds declared output bound');
    view.setFloat64(i * 48, values[i], true);
    view.setUint32(i * 48 + 8, text.length, true);
    bytes.set(text, i * 48 + 12);
  }
  return bytes;
}

// Test-only records: total:u32, textBytes:u32, value:f64, text bytes, pad-to-8.
function numericRecords(rows) {
  const total = rows.reduce((sum, [, text]) => sum + ((16 + text.length + 7) & ~7), 0);
  const bytes = new Uint8Array(total), view = new DataView(bytes.buffer);
  let at = 0;
  for (const [value, text] of rows) {
    const size = (16 + text.length + 7) & ~7;
    view.setUint32(at, size, true); view.setUint32(at + 4, text.length, true);
    view.setFloat64(at + 8, value, true); bytes.set(text, at + 16);
    at += size;
  }
  return bytes;
}
function utf16(text) {
  const bytes = new Uint8Array(text.length * 2), view = new DataView(bytes.buffer);
  for (let i = 0; i < text.length; i++) view.setUint16(i * 2, text.charCodeAt(i), true);
  return bytes;
}
const numberText = numberTextFixtures();
const numericSampleView = new DataView(numberText.buffer);
const parsedTexts = [...NUMERIC_CONVERSION_TEXTS], hexRows = [];
const numericDecoder = new TextDecoder();
for (let i = 0; i < 1024; i++) {
  const value = numericSampleView.getFloat64(i * 48, true);
  const length = numericSampleView.getUint32(i * 48 + 8, true);
  parsedTexts.push(numericDecoder.decode(numberText.subarray(i * 48 + 12, i * 48 + 12 + length)));
  hexRows.push([value, utf8(value.toString(16))]);
}
const numberParse = numericRecords(parsedTexts.map(text => [Number(text), utf16(text)]));
const numberHex = numericRecords(hexRows);

const setRoutes = [true, false, route, route];
const resourceUri = 'https://example.com/item';
const resourceRoot = { $ref: resourceUri };
const resource = { type: 'string', pattern: '^a+$' };
const missingSchema = { required: [missing] };
// Standalone outputs become passive comparison bytes, never executable inputs
// to a guarded scenario. Every WAT scenario still compiles its own schema.
const standalone = createSchemaEngine();
const standaloneRoute = standalone.compile(route);
const standaloneSet = standalone.compileSet(setRoutes);
const standaloneBundle = standalone.compile(resourceRoot, { schemas: [[resourceUri, resource]] });

// Ordinary accepted fixtures, encoded once at build time by the existing codec.
export const FIXTURES = Object.freeze({
  route: encode(route),
  set: encode([setRoutes, null]),
  atomicSet: encode([[route], null]),
  good: encode({ kind: 'a' }),
  bad: encode({ kind: 'b' }),
  empty: encode({}),
  regex: encode({ $defs: { item: { pattern: '^a+$' } }, items: { $ref: '#/$defs/item' } }),
  regexDoc: encode(['aaa', 'a']),
  bundle: encode([resourceRoot, null, [resourceUri, resource]]),
  string: encode('aaaa'),
  truth: encode(true),
  nil: encode(null),
  chain: encode({ $defs: defs, $ref: '#/$defs/d12' }),
  items: encode({ items: { type: 'integer' } }),
  large: encode(Array.from({ length: 10000 }, (_, i) => i)),
  unique: encode({ type: 'array', uniqueItems: true, items: { type: 'integer' } }),
  uniqueDoc: encode(Array.from({ length: 64 }, (_, i) => i)),
  missingSchema: encode(missingSchema),
  malformed,
  wrapped: new Uint8Array([0xdb, 0xff, 0xff, 0xff, 0xfb]),
  corruptible: encode({ allOf: [{ type: 'integer' }, { minimum: 0 }], $dynamicAnchor: 'here' }),
  one: encode(1),
  // Byte substrings are assertions, not a second MessagePack decoder. The WAT
  // also checks the actual error record, five-field map, and field ordering.
  instanceField: encode('instancePath'),
  schemaField: encode('schemaPath'),
  keywordField: encode('keyword'),
  paramsField: encode('params'),
  messageField: encode('message'),
  schemaPath: encode('#/required'),
  keyword: encode('required'),
  paramName: encode('missingProperty'),
  missingText: utf8(missing),
  messageText: utf8(`must have required property '${missing}'`),
  falseMessage: utf8('boolean schema is false'),
  threeRequired: encode({ required: ['a', 'b', 'c'] }),
  firstMissingParam: encode({ missingProperty: 'a' }),
  standaloneRouteProgram: standaloneRoute.programBytes,
  standaloneSetProgram: standaloneSet.programBytes,
  standaloneBundleProgram: standaloneBundle.programBytes,
  unresolved: encode({ $ref: '#/missing' }),
  failureDiagnostic: encode('REF_UNRESOLVABLE'),
  failureMessage: encode('schema compile failed: SYNTAX_ERROR'),
  numberText,
  numberParse,
  numberHex,
});
for (const compiled of [standaloneRoute, standaloneSet, standaloneBundle]) compiled.dispose();

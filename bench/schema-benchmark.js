// Schema engine benchmark. Workloads cover representative low-level match
// cases so engine and wrapper performance are measured over identical schemas
// and documents.
//
//   deno run --allow-all bench/schema-benchmark.js [--json] [--iterations N]
//
// Two layers are measured per case:
//   raw      one initialize_validation + run_validation over resident
//            msgpack (program and document already in memory), TEST mode
//            — the low-level validation layer;
//   wrapper  CompiledSchema.test(value) including msgpack encoding of the
//            JavaScript value.
import { createSchemaEngine } from '../src/schema/index.js';
import { encode } from '../src/membrane/msgpack.js';
import { SCHEMA_CONTINUATION, SCHEMA_STATUS } from '../src/fuel/schema-engine-contract.js';

const compactRoute = {
  type: 'object',
  required: ['kind', 'tenant'],
  properties: { kind: { const: 'landing-request' }, tenant: { type: 'string' } },
};
const nestedRoute = {
  type: 'object',
  required: ['kind', 'requestId', 'tenant', 'recipe'],
  properties: {
    kind: { const: 'landing-request' },
    requestId: { type: 'string', minLength: 8, maxLength: 64 },
    tenant: {
      type: 'object',
      required: ['id', 'region'],
      properties: { id: { type: 'string' }, region: { enum: ['ams', 'dub', 'fra', 'lhr'] } },
      additionalProperties: false,
    },
    recipe: {
      type: 'object',
      required: ['steps'],
      properties: {
        steps: {
          type: 'array',
          minItems: 1,
          maxItems: 8,
          items: {
            type: 'object',
            required: ['operation', 'attempts'],
            properties: {
              operation: { enum: Array.from({ length: 8 }, (_, index) => `operation-${index}`) },
              attempts: { type: 'integer', minimum: 1, maximum: 5 },
            },
            additionalProperties: false,
          },
        },
      },
      additionalProperties: false,
    },
  },
  additionalProperties: false,
};
const compactMatchingDocument = { kind: 'landing-request', tenant: 'tenant-blue' };
const compactNonmatchingDocument = { kind: 'inventory-update', tenant: 'tenant-blue' };
function nestedDocument(operation) {
  return {
    kind: 'landing-request',
    requestId: 'request-0001',
    tenant: { id: 'tenant-blue', region: 'fra' },
    recipe: { steps: [{ operation, attempts: 2 }] },
  };
}

const numericRoute = { type: 'object', required: ['score'], properties: { score: { type: 'number', minimum: 10, maximum: 100, multipleOf: 5 } } };
const stringRoute = { type: 'object', required: ['code'], properties: { code: { type: 'string', minLength: 4, maxLength: 12 } } };
const arrayRoute = { type: 'object', required: ['tags'], properties: { tags: { type: 'array', minItems: 2, maxItems: 4, uniqueItems: true, contains: { const: 'priority' }, items: { type: 'string' } } } };
const tupleRoute = { type: 'object', required: ['coordinates'], properties: { coordinates: { type: 'array', items: [{ type: 'number' }, { type: 'number' }], additionalItems: false } } };
const objectRoute = { type: 'object', minProperties: 2, maxProperties: 3, propertyNames: { type: 'string', minLength: 2 }, dependencies: { token: ['owner'] } };
const compositionRoute = {
  allOf: [
    { anyOf: [{ const: 'route-a' }, { const: 'route-b' }, { const: 'route-c' }, { const: 'route-d' }] },
    { oneOf: [{ type: 'string' }, { type: 'number' }] },
    { not: { const: 'blocked' } },
  ],
};
const conditionalRoute = { type: 'object', if: { properties: { expedited: { const: true } }, required: ['expedited'] }, then: { required: ['priority'] }, else: { required: ['queue'] } };
const refRoute = { definitions: { identity: { type: 'string', minLength: 4 } }, type: 'object', required: ['owner'], properties: { owner: { $ref: '#/definitions/identity' } } };

// Historical Deno p50 ns/op on Apple M4 for the reference implementation.
const REFERENCE_P50 = {
  'compact/match': 1115, 'compact/no-match': 727,
  'nested/early-match': 5616, 'nested/late-match': 5190, 'nested/no-match': 5132,
  'numeric-bounds-and-multiple/match': 635, 'numeric-bounds-and-multiple/no-match': 653,
  'string-length/match': 603, 'string-length/no-match': 623,
  'array-cardinality-unique-contains/match': 1211, 'array-cardinality-unique-contains/no-match': 1275,
  'array-tuple-additional-items/match': 987, 'array-tuple-additional-items/no-match': 1067,
  'object-count-names-dependencies/match': 876, 'object-count-names-dependencies/no-match': 855,
  'composition/early-match': 1370, 'composition/late-match': 1672, 'composition/no-match': 1671,
  'conditional/match': 973, 'conditional/no-match': 929,
  'local-reference/match': 783, 'local-reference/no-match': 760,
  'boolean-schema/match': 130, 'boolean-schema/no-match': 141,
};

const CASES = [
  { name: 'compact/match', route: compactRoute, document: compactMatchingDocument, expected: true },
  { name: 'compact/no-match', route: compactRoute, document: compactNonmatchingDocument, expected: false },
  { name: 'nested/early-match', route: nestedRoute, document: nestedDocument('operation-0'), expected: true },
  { name: 'nested/late-match', route: nestedRoute, document: nestedDocument('operation-7'), expected: true },
  { name: 'nested/no-match', route: nestedRoute, document: nestedDocument('unsupported-operation'), expected: false },
  { name: 'numeric-bounds-and-multiple/match', route: numericRoute, document: { score: 45 }, expected: true },
  { name: 'numeric-bounds-and-multiple/no-match', route: numericRoute, document: { score: 43 }, expected: false },
  { name: 'string-length/match', route: stringRoute, document: { code: 'route-42' }, expected: true },
  { name: 'string-length/no-match', route: stringRoute, document: { code: 'no' }, expected: false },
  { name: 'array-cardinality-unique-contains/match', route: arrayRoute, document: { tags: ['priority', 'audit'] }, expected: true },
  { name: 'array-cardinality-unique-contains/no-match', route: arrayRoute, document: { tags: ['audit', 'audit'] }, expected: false },
  { name: 'array-tuple-additional-items/match', route: tupleRoute, document: { coordinates: [52.37, 4.89] }, expected: true, dialect: 'draft-07' },
  { name: 'array-tuple-additional-items/no-match', route: tupleRoute, document: { coordinates: [52.37, 4.89, 12] }, expected: false, dialect: 'draft-07' },
  { name: 'object-count-names-dependencies/match', route: objectRoute, document: { token: 'active', owner: 'routing' }, expected: true },
  { name: 'object-count-names-dependencies/no-match', route: objectRoute, document: { token: 'active', id: 7 }, expected: false },
  { name: 'composition/early-match', route: compositionRoute, document: 'route-a', expected: true },
  { name: 'composition/late-match', route: compositionRoute, document: 'route-d', expected: true },
  { name: 'composition/no-match', route: compositionRoute, document: 'blocked', expected: false },
  { name: 'conditional/match', route: conditionalRoute, document: { expedited: true, priority: 1 }, expected: true },
  { name: 'conditional/no-match', route: conditionalRoute, document: { expedited: true, queue: 'normal' }, expected: false },
  { name: 'local-reference/match', route: refRoute, document: { owner: 'team-blue' }, expected: true },
  { name: 'local-reference/no-match', route: refRoute, document: { owner: 'no' }, expected: false },
  { name: 'boolean-schema/match', route: true, document: compactMatchingDocument, expected: true },
  { name: 'boolean-schema/no-match', route: false, document: compactMatchingDocument, expected: false },
];

const args = Deno.args;
const json = args.includes('--json');
const iterations = Number(args[args.indexOf('--iterations') + 1]) || 5000;
const samples = 5;

function measure(fn) {
  for (let i = 0; i < Math.min(2000, iterations); i++) fn();
  const results = [];
  for (let s = 0; s < samples; s++) {
    const start = performance.now();
    for (let i = 0; i < iterations; i++) fn();
    results.push((performance.now() - start) * 1e6 / iterations);
  }
  results.sort((a, b) => a - b);
  return { min: results[0], p50: results[Math.floor(samples / 2)] };
}

const engine = createSchemaEngine();
const x = engine.exports;
const rows = [];
for (const c of CASES) {
  const compiled = engine.compile(c.route, { dialect: c.dialect });
  if (compiled.test(c.document) !== c.expected) throw new Error(`verdict mismatch for ${c.name}`);
  const docBytes = encode(c.document);
  // resident inputs for the raw layer
  engine._scratchReset();
  const doc = engine._scratchAlloc(docBytes.length);
  engine.bytes.set(docBytes, doc);
  const contSize = x.continuation_size(compiled.program, compiled.size, 64, 0, 1024);
  const cont = engine._scratchAlloc(contSize);
  const mode = SCHEMA_CONTINUATION.MODE.TEST | SCHEMA_CONTINUATION.MODE.TRUSTED;
  let verdict = 0;
  const raw = measure(() => {
    x.initialize_validation(compiled.program, compiled.size, doc, docBytes.length, mode, 64, 0, 1024, cont, contSize);
    verdict = x.run_validation(cont, contSize, 1 << 30)[0];
  });
  if ((verdict === SCHEMA_STATUS.VALID) !== c.expected) throw new Error(`raw verdict mismatch for ${c.name}`);
  const wrapper = measure(() => compiled.test(c.document));
  rows.push({
    name: c.name, programBytes: compiled.size, documentBytes: docBytes.length,
    rawP50: raw.p50, rawMin: raw.min, wrapperP50: wrapper.p50, referenceP50: REFERENCE_P50[c.name] ?? null,
  });
}

// Fan-out: shared-selection scenarios — 128 compact candidate routes against
// one post, at match rates 0 / 0.5 / 1. Historical reference p50 values use
// Deno and report nanoseconds per operation.
// Three ways to answer "which routes match": N single test() calls, one
// compileSet().match() (TEST mode, gate-decided), and the raw set run.
const REFERENCE_FANOUT_P50 = { 'rate-0/none': 268219, 'rate-0.5/late': 200911, 'rate-1/complete': 177976 };
const fanout = [];
for (const [scenario, matchRate, position] of [['rate-0/none', 0, 'none'], ['rate-0.5/late', 0.5, 'late'], ['rate-1/complete', 1, 'complete']]) {
  const count = 128;
  const routes = [];
  for (let index = 0; index < count; index++) {
    const matches = matchRate === 1 || (matchRate === 0.5 && (position === 'late' ? index >= count / 2 : index < count / 2));
    routes.push({ type: 'object', required: ['kind'], properties: { kind: { const: matches ? 'landing-request' : 'other' } } });
  }
  const document = { kind: 'landing-request', requestId: 'request-0001', tenant: 'tenant-blue' };
  const expected = routes.flatMap((r, i) => (r.properties.kind.const === 'landing-request' ? [i] : []));
  const singles = routes.map((r) => engine.compile(r));
  const set = engine.compileSet(routes);
  const nSingles = measure(() => { const out = []; for (let i = 0; i < count; i++) if (singles[i].test(document)) out.push(i); return out; });
  if (JSON.stringify(set.match(document)) !== JSON.stringify(expected)) throw new Error(`set verdict mismatch for ${scenario}`);
  const setMatch = measure(() => set.match(document));
  // raw set run: resident document + continuation, TEST mode
  const docBytes = encode(document);
  engine._scratchReset();
  const doc = engine._scratchAlloc(docBytes.length);
  engine.bytes.set(docBytes, doc);
  const contSize = x.continuation_size(set.program, set.size, 64, 0, 1024);
  const cont = engine._scratchAlloc(contSize);
  const mode = SCHEMA_CONTINUATION.MODE.TEST | SCHEMA_CONTINUATION.MODE.TRUSTED;
  const rawSet = measure(() => {
    x.initialize_validation(set.program, set.size, doc, docBytes.length, mode, 64, 0, 1024, cont, contSize);
    x.run_validation(cont, contSize, 1 << 30);
  });
  fanout.push({ scenario, routes: count, programBytes: set.size, singlesP50: nSingles.p50, setP50: setMatch.p50, rawSetP50: rawSet.p50, referenceP50: REFERENCE_FANOUT_P50[scenario] });
  set.dispose();
  for (const s of singles) s.dispose();
}

// JSON text → msgpack: the engine's transcoder against JSON.parse +
// msgpack.encode on the nested post document.
const transcode = [];
{
  const text = JSON.stringify(nestedDocument('fetch'));
  const bytes = new TextEncoder().encode(text);
  const viaHost = measure(() => encode(JSON.parse(text)));
  const viaEngine = measure(() => engine.transcodeJson(bytes));
  engine._scratchReset();
  const input = engine._scratchAlloc(bytes.length);
  engine.bytes.set(bytes, input);
  const cap = bytes.length * 3 + 16;
  const out = engine._scratchAlloc(cap);
  const raw = measure(() => x.transcode_json(input, bytes.length, out, cap, 1 << 30));
  transcode.push({ name: 'nested post', textBytes: bytes.length, hostP50: viaHost.p50, wrapperP50: viaEngine.p50, rawP50: raw.p50 });
}

if (json) {
  console.log(JSON.stringify({ host: 'deno', version: Deno.version.deno, iterations, samples, rows, fanout, transcode }, null, 2));
} else {
  console.log(`schema engine benchmark — Deno ${Deno.version.deno}, ${iterations} iterations × ${samples} samples, ns/op`);
  console.log('case'.padEnd(46) + 'raw p50'.padStart(9) + 'raw min'.padStart(9) + 'wrapper'.padStart(9) + 'ref p50'.padStart(10) + '  ratio');
  for (const r of rows) {
    const ratio = r.referenceP50 ? (r.rawP50 / r.referenceP50).toFixed(2) + '×' : '';
    console.log(r.name.padEnd(46) + r.rawP50.toFixed(0).padStart(9) + r.rawMin.toFixed(0).padStart(9) + r.wrapperP50.toFixed(0).padStart(9) + String(r.referenceP50 ?? '').padStart(10) + '  ' + ratio);
  }
  console.log('\nfan-out: 128 compact routes × one post, ns/op');
  console.log('scenario'.padEnd(20) + 'N singles'.padStart(11) + 'set.match'.padStart(11) + 'raw set'.padStart(9) + 'ref p50'.padStart(10) + '  set/ref');
  for (const f of fanout) {
    console.log(f.scenario.padEnd(20) + f.singlesP50.toFixed(0).padStart(11) + f.setP50.toFixed(0).padStart(11) + f.rawSetP50.toFixed(0).padStart(9) + String(f.referenceP50).padStart(10) + '  ' + (f.setP50 / f.referenceP50).toFixed(3) + '×');
  }
  console.log('\nJSON text → msgpack, ns/op');
  console.log('case'.padEnd(20) + 'bytes'.padStart(7) + 'JSON.parse+encode'.padStart(19) + 'transcodeJson'.padStart(15) + 'raw'.padStart(8));
  for (const t of transcode) {
    console.log(t.name.padEnd(20) + String(t.textBytes).padStart(7) + t.hostP50.toFixed(0).padStart(19) + t.wrapperP50.toFixed(0).padStart(15) + t.rawP50.toFixed(0).padStart(8));
  }
}

// The engine's JSON text transcoder must produce exactly the bytes
// msgpack.encode(JSON.parse(text)) produces — over every document and
// schema in the corpus, every integer-form boundary, escapes and
// surrogates — refuse (never round twice) outside its exact number fast
// path, and report syntax errors with the byte offset.
import { assertEquals, assertThrows } from 'https://deno.land/std@0.208.0/assert/mod.ts';
import { createSchemaEngine, SchemaError } from '../../src/schema/index.js';
import { encode } from '../../src/membrane/msgpack.js';
import { SCHEMA_STATUS } from '../../src/fuel/schema-engine-contract.js';

const ROOT = new URL('../../fixtures/json-schema-test-suite/tests/draft2020-12/', import.meta.url);

function rawTranscode(engine, text) {
  const bytes = new TextEncoder().encode(text);
  engine._scratchReset();
  const input = engine._scratchAlloc(bytes.length);
  engine.bytes.set(bytes, input);
  const cap = bytes.length * 3 + 16;
  const out = engine._scratchAlloc(cap);
  const [status, , n] = engine.exports.transcode_json(input, bytes.length, out, cap, 1 << 30);
  return { status, n, bytes: status === SCHEMA_STATUS.OK ? engine.bytes.slice(out, out + n) : null };
}

function assertParity(engine, text) {
  const expected = encode(JSON.parse(text));
  const got = engine.transcodeJson(text);
  assertEquals([...got], [...expected], `bytes for ${text.slice(0, 60)}`);
}

Deno.test('transcode: integer-form boundaries, floats, literals, strings, containers', () => {
  const engine = createSchemaEngine();
  const texts = [
    '0', '-0', '1', '127', '128', '255', '256', '65535', '65536', '4294967295', '4294967296',
    '9007199254740991', '18446744073709551615', '18446744073709551616',
    '-1', '-32', '-33', '-128', '-129', '-32768', '-32769', '-2147483648', '-2147483649', '-9223372036854775808',
    '1.5', '-1.5', '0.1', '0.001', '1e3', '1E-3', '1e22', '1e-22', '2.5e22', '1.0', '10.50', '123456789012345', '-0.0', '1e0',
    'true', 'false', 'null', '""', '"abc"', String.raw`"a\"b\\c\/d\b\f\n\r\t"`, String.raw`"\u00e9\u20ac\ud834\udd1e"`,
    '"' + 'x'.repeat(31) + '"', '"' + 'x'.repeat(32) + '"', '"' + 'y'.repeat(255) + '"', '"' + 'y'.repeat(256) + '"',
    '[]', '[1,2,3]', '{}', '{"a":1,"b":[true,null,{"c":"d"}]}', ' { "k" : [ 1 , 2 ] } \n',
    '[' + Array.from({ length: 15 }, (_, i) => i).join(',') + ']', '[' + Array.from({ length: 16 }, (_, i) => i).join(',') + ']',
    '{' + Array.from({ length: 16 }, (_, i) => `"k${i}":${i}`).join(',') + '}',
    '[' + Array.from({ length: 70000 }, () => '0').join(',') + ']',
  ];
  for (const text of texts) assertParity(engine, text);
});

Deno.test('transcode: every corpus schema and document round-trips byte for byte', async () => {
  const engine = createSchemaEngine();
  let count = 0;
  for await (const entry of Deno.readDir(ROOT)) {
    if (!entry.name.endsWith('.json')) continue;
    const groups = JSON.parse(await Deno.readTextFile(new URL(entry.name, ROOT)));
    for (const group of groups) {
      assertParity(engine, JSON.stringify(group.schema));
      for (const test of group.tests) {
        assertParity(engine, JSON.stringify(test.data));
        count++;
      }
    }
  }
  if (count < 1000) throw new Error(`corpus too small: ${count}`);
});

Deno.test('transcode: numbers outside the exact fast path are refused, and the host falls back', () => {
  const engine = createSchemaEngine();
  for (const text of ['1e23', '1e-23', '0.1234567890123456', '1234567890123456789', '12345678901234567.5']) {
    assertEquals(rawTranscode(engine, text).status, SCHEMA_STATUS.UNSUPPORTED, text);
    assertParity(engine, text); // the wrapper's fallback path
  }
});

Deno.test('transcode: syntax errors name the byte offset', () => {
  const engine = createSchemaEngine();
  for (const [text, offset] of [['', 0], ['[', 1], ['{"a"}', 4], ['01', 1], ['1.', 2], ['-', 1], ['"\\ud800"', 7], ['"\\x"', 2], ['tru', 0], ['[1,]', 3], ['"a\nb"', 2], ['1 2', 2]]) {
    const r = rawTranscode(engine, text);
    assertEquals([r.status, r.n], [SCHEMA_STATUS.SYNTAX_ERROR, offset], JSON.stringify(text));
    assertThrows(() => engine.transcodeJson(text), SchemaError, 'invalid JSON');
  }
});

Deno.test('transcode: { json } inputs validate like their parsed value', () => {
  const engine = createSchemaEngine();
  const s = engine.compile({ type: 'object', required: ['n'], properties: { n: { type: 'integer', minimum: 1 } } });
  assertEquals(s.test({ json: '{"n": 1}' }), true);
  assertEquals(s.test({ json: '{"n": 1.0}' }), true);
  assertEquals(s.test({ json: '{"n": 0.5}' }), false);
  assertEquals(s.test({ json: '{"n": 1e23}' }), true); // integral, via the fallback path
  assertEquals(s.validate({ json: '{"n": "x"}' }).errors[0].keyword, 'type');
});

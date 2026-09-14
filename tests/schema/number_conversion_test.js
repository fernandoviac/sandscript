import { assert, assertEquals } from 'https://deno.land/std@0.208.0/assert/mod.ts';
import { instantiateRegexSync } from '../../src/fuel/regex-engine.wasm.js';
import { instantiateSchemaSync } from '../../src/fuel/schema-engine.wasm.js';
import { SCHEMA_NUMBER_PARSE, SCHEMA_NUMBER_HEX } from '../../src/fuel/schema-engine-contract.js';
import { NUMERIC_CONVERSION_TEXTS } from './number-conversion-fixtures.js';

function setup() {
  const memory = new WebAssembly.Memory({ initial: 32, maximum: 16384, shared: true });
  const api = instantiateSchemaSync(memory, instantiateRegexSync(memory)).exports;
  const bytes = new Uint8Array(memory.buffer);
  const view = new DataView(memory.buffer);
  function parse(text) {
    for (let i = 0; i < text.length; i++) view.setUint16(0x20001 + i * 2, text.charCodeAt(i), true);
    return api.parse_number_utf16(0x20001, text.length * 2, 0x1000, SCHEMA_NUMBER_PARSE.SCRATCH_BYTES);
  }
  return { api, bytes, view, parse };
}

Deno.test('Number text parsing preserves full grammar and exact midpoint rounding', () => {
  const { parse } = setup();
  const cases = NUMERIC_CONVERSION_TEXTS;
  for (const text of cases) {
    const [status, value, work, overflowed] = parse(text);
    assertEquals(status, 0, text);
    assert(Object.is(value, Number(text)), `${text.slice(0, 100)}: ${value} != ${Number(text)}`);
    assertEquals(overflowed, 0);
    if (text.length) assert(work > 0n);
  }
});

Deno.test('hexadecimal numeric text preserves exact fractional and integer bit windows', () => {
  const { api, bytes, view } = setup();
  const values = [0, -0, NaN, Infinity, -Infinity, Number.MIN_VALUE, -Number.MIN_VALUE,
    Number.MAX_VALUE, -Number.MAX_VALUE, 0.1, -0.1, 1.5, 16, 0.0625, 9007199254740992];
  let bits = 0x9e3779b97f4a7c15n;
  for (let i = 0; i < 1024; i++) {
    bits = BigInt.asUintN(64, bits ^ (bits << 13n)); bits ^= bits >> 7n;
    bits = BigInt.asUintN(64, bits ^ (bits << 17n));
    view.setBigUint64(0, bits, true); values.push(view.getFloat64(0, true));
  }
  for (const value of values) {
    bytes.fill(0xa5, 0x1000, 0x1000 + SCHEMA_NUMBER_HEX.OUTPUT_BYTES);
    const [status, length, work, overflow] = api.format_number_hex(value, 0x1000, SCHEMA_NUMBER_HEX.OUTPUT_BYTES);
    assertEquals(status, 0);
    assertEquals(new TextDecoder().decode(bytes.subarray(0x1000, 0x1000 + length)), value.toString(16));
    assertEquals(bytes[0x1000 + length], 0xa5);
    assert(work > 0n); assertEquals(overflow, 0);
  }
});

Deno.test('numeric conversion rejects invalid or undersized regions without mutation', () => {
  const { api, bytes } = setup();
  for (const [args, expected] of [
    [[0x20000, 3, 0x1000, 320], 12], [[0x20000, 2, 0x1001, 320], 12],
    [[0x1000, 2, 0x1000, 320], 12], [[-2, 8, 0x1000, 320], 12],
    [[0x20000, 2, bytes.length - 8, 320], 12], [[0x20000, 2, 0x1000, 319], 7],
    [[-2, 8, 0x1000, 319], 12],
  ]) {
    bytes.fill(0xa5);
    const [status, value, work, overflow] = api.parse_number_utf16(...args);
    assertEquals(status, expected); assert(Number.isNaN(value));
    assertEquals(work, 0n); assertEquals(overflow, 0); assert(bytes.every(byte => byte === 0xa5));
  }
  for (const [pointer, capacity, expected] of [[0x1000, 319, 7], [-2, 320, 12], [bytes.length - 8, 320, 12]]) {
    bytes.fill(0xa5);
    assertEquals(api.format_number_hex(0.1, pointer, capacity), [expected, 0, 0n, 0]);
    assert(bytes.every(byte => byte === 0xa5));
  }
});

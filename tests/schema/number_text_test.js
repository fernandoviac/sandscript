import { assert, assertEquals } from 'https://deno.land/std@0.208.0/assert/mod.ts';
import { instantiateRegexSync } from '../../src/fuel/regex-engine.wasm.js';
import { instantiateSchemaSync } from '../../src/fuel/schema-engine.wasm.js';
import { SCHEMA_NUMBER_TEXT as N, SCHEMA_STATUS as S } from '../../src/fuel/schema-engine-contract.js';

function caller() {
  const memory = new WebAssembly.Memory({ initial: 1, maximum: 16384, shared: true });
  const engine = instantiateSchemaSync(memory, instantiateRegexSync(memory)).exports;
  return { memory, engine };
}

Deno.test('number text preserves shortest decimal boundaries and independent atomic charges', () => {
  const { memory, engine } = caller();
  const bytes = new Uint8Array(memory.buffer);
  const decoder = new TextDecoder();
  const values = [0, -0, NaN, Infinity, -Infinity, Number.MIN_VALUE, -Number.MIN_VALUE,
    Number.MAX_VALUE, -Number.MAX_VALUE, Number.MIN_SAFE_INTEGER, Number.MAX_SAFE_INTEGER,
    1e-7, 1e-6, 1.0000000000000002e-6, 1e20, 1e21, 1000000000000000100, 0.1, -0.1];
  for (const value of values) {
    bytes.fill(0xa5);
    const [status, length, work, overflow] = engine.format_number(value, 64, N.OUTPUT_BYTES, 128, N.SCRATCH_BYTES);
    assertEquals(status, S.OK);
    assertEquals(decoder.decode(bytes.subarray(64, 64 + length)), String(value));
    assert(work > 0n);
    assertEquals(overflow, 0);
    assertEquals(bytes[0], 0xa5);
    assertEquals(bytes[64 + length], 0xa5);
    assertEquals(bytes[128 + N.SCRATCH_BYTES], 0xa5);
    assertEquals(engine.format_number(value, 64, N.OUTPUT_BYTES, 128, N.SCRATCH_BYTES), [status, length, work, overflow]);
  }
});

Deno.test('number text rejects bad or short regions without writing either region', () => {
  const { memory, engine } = caller();
  const bytes = new Uint8Array(memory.buffer);
  const cases = [
    [64, 31, 128, 864, S.BUFFER_TOO_SMALL],
    [64, 32, 128, 863, S.BUFFER_TOO_SMALL],
    [64, 32, 80, 864, S.INVALID_ARGUMENT],
    [64, 32, 129, 864, S.INVALID_ARGUMENT],
    [0xfffffff0, 32, 128, 864, S.INVALID_ARGUMENT],
    [64, 32, 65000, 864, S.INVALID_ARGUMENT],
    [65520, 31, 128, 864, S.INVALID_ARGUMENT],
  ];
  for (const [out, capacity, scratch, scratchCapacity, status] of cases) {
    bytes.fill(0xa5);
    const before = bytes.slice();
    assertEquals(engine.format_number(-Number.MIN_VALUE, out, capacity, scratch, scratchCapacity), [status, 0, 0n, 0]);
    assertEquals(bytes, before);
  }
});

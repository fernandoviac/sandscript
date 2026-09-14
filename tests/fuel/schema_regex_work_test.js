import { assert, assertEquals, assertThrows } from 'https://deno.land/std@0.208.0/assert/mod.ts';
import { createSchemaEngine, SchemaError } from '../../src/schema/index.js';
import { encode } from '../../src/membrane/msgpack.js';
import { SCHEMA_STATUS, SCHEMA_PROGRAM, SCHEMA_CONTINUATION } from '../../src/fuel/schema-engine-contract.js';
import { REGEX_CONTINUATION } from '../../src/fuel/regex-engine-contract.js';
import { instantiateRegexSync } from '../../src/fuel/regex-engine.wasm.js';
import { instantiateSchemaSync } from '../../src/fuel/schema-engine.wasm.js';

const unsigned = (value) => BigInt.asUintN(64, value);
const CH = SCHEMA_CONTINUATION.HEADER;
const RH = REGEX_CONTINUATION.HEADER;

function validation(engine, schema, document) {
  const x = engine.exports;
  const bytes = encode(document);
  engine._scratchReset();
  const input = engine._scratchAlloc(bytes.length);
  engine.bytes.set(bytes, input);
  const capacity = x.continuation_size(schema.program, schema.size, 64, 0, 65536);
  const cont = engine._scratchAlloc(capacity);
  assertEquals(x.initialize_validation(schema.program, schema.size, input, bytes.length, 2, 64, 0, 65536, cont, capacity), SCHEMA_STATUS.OK);
  return { cont, capacity, input, inputBytes: bytes.length };
}

function finish(x, cont, capacity, grant) {
  let status;
  for (let calls = 0; calls < 100000; calls++) {
    [status] = x.run_validation(cont, capacity, grant);
    if (status !== SCHEMA_STATUS.PAUSED) return status;
  }
  throw new Error('schema/regex continuation did not finish');
}

function parkRegex(engine, state) {
  const { cont, capacity } = state;
  const regex = cont + engine.view.getUint32(cont + CH.REGEX_OFFSET, true);
  for (let calls = 0; calls < 10000; calls++) {
    assertEquals(engine.exports.run_validation(cont, capacity, 1)[0], SCHEMA_STATUS.PAUSED);
    if (engine.view.getUint32(regex + RH.MAGIC, true) === REGEX_CONTINUATION.MAGIC) return regex;
  }
  throw new Error('validation did not reach the nested regex');
}

Deno.test('schema/regex work: tiny grants preserve portable bytes, verdicts and exact totals', () => {
  const input = { pattern: '(?:(a)|b){32}' };
  const wholeEngine = createSchemaEngine();
  const tinyEngine = createSchemaEngine();
  const whole = wholeEngine.compile(input);
  const tiny = tinyEngine.compile(input, { grant: 1 });
  assertEquals(tiny.programBytes, whole.programBytes);
  assertEquals(tiny.compileFuel, whole.compileFuel);
  // The portable field still describes the original v1 regex footprint;
  // runtime continuation sizing supplies the appended work fields.
  const stored = new DataView(whole.programBytes.buffer, whole.programBytes.byteOffset, whole.programBytes.byteLength)
    .getUint32(SCHEMA_PROGRAM.HEADER.MAX_REGEX_CONTINUATION, true);
  const state = validation(wholeEngine, whole, 'ab'.repeat(16));
  assertEquals(wholeEngine.view.getUint32(state.cont + CH.REGEX_CAPACITY, true), stored + REGEX_CONTINUATION.WORK_BYTES);
  const tinyState = validation(tinyEngine, tiny, 'ab'.repeat(16));
  assertEquals(finish(wholeEngine.exports, state.cont, state.capacity, 0x7fffffff), SCHEMA_STATUS.VALID);
  assertEquals(finish(tinyEngine.exports, tinyState.cont, tinyState.capacity, 1), SCHEMA_STATUS.VALID);
  assertEquals(tinyEngine.exports.validation_work_charged(tinyState.cont), wholeEngine.exports.validation_work_charged(state.cont));
  assertEquals(tinyEngine.exports.validation_work_overflow(tinyState.cont), 0);
  const loaded = createSchemaEngine().load(whole.programBytes);
  assertEquals(loaded.test('ab'.repeat(16), { grant: 1 }), true);
  assertEquals(loaded.test('short', { grant: 1 }), false);
});

Deno.test('schema/regex work: nested unsigned counters aggregate deltas, and source overflow propagates', () => {
  for (const overflow of [false, true]) {
    const engine = createSchemaEngine();
    const schema = engine.compile({ pattern: '(a|b)+c' });
    const state = validation(engine, schema, 'abababc');
    const regex = parkRegex(engine, state);
    const before = unsigned(engine.exports.validation_work_charged(state.cont));
    const seed = overflow ? 0xffffffffffffffffn : 0x8000000000000000n;
    engine.view.setBigUint64(regex + RH.WORK_CHARGED, seed, true);
    // An enormous legitimate scheduling debt is not a source overflow.
    engine.view.setBigUint64(regex + RH.WORK_PENDING, 0x100000000n, true);
    const status = finish(engine.exports, state.cont, state.capacity, 1);
    assertEquals(status, SCHEMA_STATUS.VALID); // stepped compatibility precedence
    const total = unsigned(engine.exports.validation_work_charged(state.cont));
    assertEquals(engine.exports.validation_work_overflow(state.cont), Number(overflow));
    if (overflow) {
      assertEquals(total, 0xffffffffffffffffn);
      assertEquals(finish(engine.exports, state.cont, state.capacity, 1), SCHEMA_STATUS.VALID);
      assertEquals(unsigned(engine.exports.validation_work_charged(state.cont)), total);
    } else {
      assert(total > before);
      assert(total < seed); // seed is prior work, never charged again as a delta
    }
  }
});

Deno.test('schema/regex work: relocated snapshots rebind a parked match without resetting work', () => {
  const engine = createSchemaEngine();
  const schema = engine.compile({ pattern: '(a|b)+c' });
  const state = validation(engine, schema, 'abababc');
  parkRegex(engine, state);
  const before = unsigned(engine.exports.validation_work_charged(state.cont));
  const program = engine._scratchAlloc(schema.size);
  const input = engine._scratchAlloc(state.inputBytes);
  const cont = engine._scratchAlloc(state.capacity);
  engine.bytes.copyWithin(program, schema.program, schema.program + schema.size);
  engine.bytes.copyWithin(input, state.input, state.input + state.inputBytes);
  engine.bytes.copyWithin(cont, state.cont, state.cont + state.capacity);
  const regex = instantiateRegexSync(engine.memory);
  const restored = instantiateSchemaSync(engine.memory, regex).exports;
  assertEquals(restored.rebind_validation(cont, program, input), SCHEMA_STATUS.OK);
  assertEquals(unsigned(restored.validation_work_charged(cont)), before);
  assertEquals(finish(restored, cont, state.capacity, 1), SCHEMA_STATUS.VALID);
  assertEquals(finish(engine.exports, state.cont, state.capacity, 0x7fffffff), SCHEMA_STATUS.VALID);
  assertEquals(restored.validation_work_charged(cont), engine.exports.validation_work_charged(state.cont));
  assertEquals(restored.validation_work_overflow(cont), 0);
});

Deno.test('schema/regex work: failed nested compilation retains the examined pattern prefix', () => {
  const charges = [];
  for (const count of [1, 129]) {
    const engine = createSchemaEngine();
    const error = assertThrows(() => engine.compile({ pattern: 'a'.repeat(count) + '(?=' }, { grant: 1 }), SchemaError);
    assertEquals(error.status, 'UNSUPPORTED');
    charges.push(error.fuelCharged);
  }
  assert(charges[1] >= charges[0] + 128);
});

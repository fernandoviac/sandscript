import { assert, assertEquals } from 'https://deno.land/std@0.208.0/assert/mod.ts';
import { createSchemaEngine } from '../../src/schema/index.js';
import { encode } from '../../src/membrane/msgpack.js';
import { SCHEMA_STATUS, SCHEMA_PROGRAM, SCHEMA_OPCODE } from '../../src/fuel/schema-engine-contract.js';

const unsigned = (value) => BigInt.asUintN(64, value);

// Exercise the source meter without diagnostic materialization or host encoding
// entering the comparison. Mode 0 checks programs; mode 2 trusts compiled bytes.
function validateBytes(engine, schema, bytes, grant = 0x7fffffff, mode = 2) {
  const x = engine.exports;
  engine._scratchReset();
  const input = engine._scratchAlloc(bytes.length);
  engine.bytes.set(bytes, input);
  const capacity = x.continuation_size(schema.program, schema.size, 64, 0, 65536);
  const cont = engine._scratchAlloc(capacity);
  let status = x.initialize_validation(schema.program, schema.size, input, bytes.length, mode, 64, 0, 65536, cont, capacity);
  let debit = 0n;
  let minimumRemaining = grant;
  if (status === SCHEMA_STATUS.OK) {
    for (let calls = 0; calls < 100000; calls++) {
      const result = x.run_validation(cont, capacity, grant);
      status = result[0];
      minimumRemaining = Math.min(minimumRemaining, result[1]);
      debit += BigInt(grant - result[1]);
      if (status !== SCHEMA_STATUS.PAUSED) break;
    }
    assert(status !== SCHEMA_STATUS.PAUSED, 'validation must terminate');
    // Setup debt is debited by the stepped calls, including terminal faults.
    assertEquals(unsigned(x.validation_work_charged(cont)), debit);
  }
  assertEquals(x.validation_work_overflow(cont), 0);
  return { status, work: unsigned(x.validation_work_charged(cont)), minimumRemaining };
}

function measureBytes(engine, bytes, grant) {
  const x = engine.exports;
  engine._scratchReset();
  const input = engine._scratchAlloc(bytes.length);
  engine.bytes.set(bytes, input);
  const capacity = x.compile_workspace_size(bytes.length);
  const ws = engine._scratchAlloc(capacity);
  let status;
  let debit = 0n;
  for (let calls = 0; calls < 100000; calls++) {
    const result = x.measure_schema(input, bytes.length, ws, capacity, 0, calls === 0 ? 1 : 0, grant);
    status = result[0];
    debit += BigInt(grant - result[1]);
    if (status !== SCHEMA_STATUS.PAUSED) break;
  }
  assert(status !== SCHEMA_STATUS.PAUSED, 'measurement must terminate');
  const work = unsigned(x.compile_work_charged(ws));
  assertEquals(work, debit);
  assertEquals(x.compile_work_overflow(ws), 0);
  return { status, work };
}

Deno.test('schema source work: UTF-8 failure charges examined prefix, not unvisited suffix', () => {
  const engine = createSchemaEngine();
  const schema = engine.compile({ minLength: 1 });
  const malformed = (length, index) => {
    const bytes = encode('a'.repeat(length));
    bytes[bytes.length - length + index] = 0xff;
    return bytes;
  };
  const early = validateBytes(engine, schema, malformed(4096, 0));
  const late = validateBytes(engine, schema, malformed(4096, 4095));
  const short = validateBytes(engine, schema, malformed(32, 0));
  assertEquals(early.status, SCHEMA_STATUS.INVALID_UTF8);
  assertEquals(late.status, early.status);
  assertEquals(short.status, early.status);
  assertEquals(short.work, early.work);
  assert(late.work >= early.work + 4095n, 'every examined ASCII prefix byte must be charged');
  const stepped = validateBytes(engine, schema, malformed(4096, 4095), 1);
  assertEquals(stepped.status, late.status);
  assertEquals(stepped.work, late.work);
  assert(stepped.minimumRemaining < -4095, 'terminal UTF-8 fault must debit its atomic overrun');
});

Deno.test('schema source work: format scanning meters long failed and successful fractions', () => {
  const engine = createSchemaEngine();
  const schema = engine.compile({ format: 'time' });
  const early = validateBytes(engine, schema, encode('12:00:00.!' + '1'.repeat(4095) + '!'));
  const late = validateBytes(engine, schema, encode('12:00:00.' + '1'.repeat(4096) + '!'));
  assertEquals(early.status, SCHEMA_STATUS.INVALID);
  assertEquals(late.status, early.status);
  assert(late.work >= early.work + 4096n, 'fraction scan may not collapse to a string-size bulk proxy');
  const bytes = encode('12:00:00.' + '1'.repeat(4096) + 'Z');
  const whole = validateBytes(engine, schema, bytes);
  const stepped = validateBytes(engine, schema, bytes, 1);
  assertEquals(whole.status, SCHEMA_STATUS.VALID);
  assertEquals(stepped.status, whole.status);
  assertEquals(stepped.work, whole.work);
  assert(stepped.minimumRemaining < -4095);
});

Deno.test('schema source work: malformed type arrays charge only visited operands beyond setup', () => {
  const engine = createSchemaEngine();
  const names = Array.from({ length: 512 }, () => 'string');
  const earlyBytes = encode({ type: [3, ...names] });
  const lateBytes = encode({ type: [...names, 3] });
  assertEquals(earlyBytes.length, lateBytes.length);
  const early = measureBytes(engine, earlyBytes, 0x7fffffff);
  const late = measureBytes(engine, lateBytes, 0x7fffffff);
  assertEquals(early.status, SCHEMA_STATUS.SYNTAX_ERROR);
  assertEquals(late.status, early.status);
  assert(late.work >= early.work + 512n, 'failed operand construction must retain its actual visits');
  assertEquals(measureBytes(engine, lateBytes, 1), late);
});

Deno.test('schema source work: program-check operand failures retain their scanned prefix', () => {
  const engine = createSchemaEngine();
  const count = 512;
  const schema = engine.compile({ allOf: Array.from({ length: count }, () => true) });
  const ph = SCHEMA_PROGRAM.HEADER;
  const code = schema.program + engine.view.getUint32(schema.program + ph.CODE_OFFSET, true);
  const end = code + engine.view.getUint32(schema.program + ph.CODE_BYTES, true);
  let list;
  for (let pc = code; pc < end; pc += SCHEMA_PROGRAM.INSTRUCTION_SIZE) {
    if (engine.view.getUint32(pc, true) === SCHEMA_OPCODE.ALL_OF) {
      list = schema.program + engine.view.getUint32(pc + 4, true);
      break;
    }
  }
  assert(list !== undefined, 'fixture must contain the node-list operand to corrupt');
  const corruptAt = (index) => {
    const at = list + 4 + index * 4;
    const saved = engine.view.getUint32(at, true);
    engine.view.setUint32(at, SCHEMA_PROGRAM.NONE, true);
    try {
      return validateBytes(engine, schema, encode(null), 0x7fffffff, 0);
    } finally {
      engine.view.setUint32(at, saved, true);
    }
  };
  const early = corruptAt(0);
  const late = corruptAt(count - 1);
  assertEquals(early.status, SCHEMA_STATUS.CORRUPT_PROGRAM);
  assertEquals(late.status, early.status);
  assert(late.work >= early.work + BigInt(count - 1));
  assertEquals(validateBytes(engine, schema, encode(null), 0x7fffffff, 0).status, SCHEMA_STATUS.VALID);
});

Deno.test('schema source work: subnormal multipleOf arithmetic debits its atomic exponent work', () => {
  const engine = createSchemaEngine();
  const schema = engine.compile({ multipleOf: Number.MIN_VALUE });
  const bytes = encode(Number.MAX_VALUE);
  const whole = validateBytes(engine, schema, bytes);
  const stepped = validateBytes(engine, schema, bytes, 1);
  // Every finite binary64 value is an exact multiple of the least subnormal.
  assertEquals(whole.status, SCHEMA_STATUS.VALID);
  assertEquals(stepped.status, whole.status);
  assertEquals(stepped.work, whole.work);
  assert(whole.work > 1024n, 'exact remainder scaling must not be free inside one VM instruction');
  assert(stepped.minimumRemaining < -1024);
});

Deno.test('schema source work: nonfinite remainder inputs cannot enter subnormal scaling', () => {
  const engine = createSchemaEngine();
  const schema = engine.compile({ multipleOf: Number.MIN_VALUE });
  const result = validateBytes(engine, schema, encode(Infinity), 1);
  assertEquals(result.status, SCHEMA_STATUS.INVALID);
});

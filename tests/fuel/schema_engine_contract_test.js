// Bare-memory contract tests for the standalone schema engine: fuel
// equivalence, program portability, error records, document-relative
// continuation state, and the engine-level facts a host relies on.
import { assertEquals, assert, assertThrows } from 'https://deno.land/std@0.208.0/assert/mod.ts';
import { createSchemaEngine, SchemaError } from '../../src/schema/index.js';
import { encode } from '../../src/membrane/msgpack.js';
import {
  KEYWORD_NAMES, SCHEMA_STATUS, SCHEMA_PROGRAM, SCHEMA_CONTINUATION, SCHEMA_COMPILE,
} from '../../src/fuel/schema-engine-contract.js';

const WORKLOADS = [
  {
    schema: {
      type: 'object',
      required: ['kind', 'id'],
      properties: { kind: { const: 'landing' }, id: { type: 'string', minLength: 3 } },
      additionalProperties: false,
    },
    documents: [
      { kind: 'landing', id: 'abc' },
      { kind: 'landing', id: 'ab', extra: 1 },
      { id: 5 },
      'not an object',
    ],
  },
  {
    schema: {
      $defs: { positive: { type: 'integer', minimum: 1 } },
      type: 'array',
      items: { $ref: '#/$defs/positive' },
      minItems: 1,
      uniqueItems: true,
      contains: { const: 7 },
    },
    documents: [[7], [1, 2, 7], [1, 1, 7], [0, 7], [], [7, 'x']],
  },
  {
    schema: {
      oneOf: [
        { type: 'object', required: ['a'], properties: { a: { enum: [1, 2, { x: [1, 2] }] } } },
        { type: 'object', required: ['b'], dependentRequired: { b: ['c'] } },
        { not: { type: 'object' } },
      ],
      if: { type: 'string' },
      then: { maxLength: 2 },
      else: { anyOf: [{ type: 'array' }, { type: 'object' }] },
    },
    documents: [{ a: { x: [1, 2] } }, { b: 1 }, { b: 1, c: 2 }, 'ab', 'abc', 3, [1]],
  },
];

Deno.test('one-unit fuel grants charge exactly what an uninterrupted run charges', () => {
  const engine = createSchemaEngine();
  for (const { schema, documents } of WORKLOADS) {
    const whole = engine.compile(schema);
    const stepped = engine.compile(schema, { grant: 1 });
    assertEquals(stepped.compileFuel, whole.compileFuel, 'compile fuel');
    assertEquals(stepped.programBytes, whole.programBytes, 'program bytes identical');
    for (const document of documents) {
      const a = whole.validate(document);
      const b = stepped.validate(document, { grant: 1 });
      assertEquals(b.valid, a.valid);
      assertEquals(b.errors, a.errors);
      assertEquals(b.fuelCharged, a.fuelCharged, `fuel for ${JSON.stringify(document)}`);
      assertEquals(stepped.test(document, { grant: 1 }), a.valid);
    }
  }
});

Deno.test('programs are portable bytes: load() validates and runs them in another engine', () => {
  const a = createSchemaEngine();
  const compiled = a.compile(WORKLOADS[1].schema);
  const bytes = compiled.programBytes;
  const b = createSchemaEngine();
  const loaded = b.load(bytes);
  for (const document of WORKLOADS[1].documents) {
    assertEquals(loaded.validate(document), compiled.validate(document));
  }
  // corruption is refused, never executed
  const corrupt = bytes.slice();
  corrupt[SCHEMA_PROGRAM.HEADER.ROOT_NODE] = 0xff;
  assertThrows(() => b.load(corrupt), SchemaError);
  const truncated = bytes.slice(0, bytes.length - 8);
  assertThrows(() => b.load(truncated), SchemaError);
});

Deno.test('error records carry JSON-pointer paths, keywords, and params', () => {
  const engine = createSchemaEngine();
  const s = engine.compile({
    type: 'object',
    properties: {
      'a/b': { type: 'array', items: { type: 'integer', maximum: 10 }, uniqueItems: true },
      'c~d': { enum: ['x', 'y'] },
    },
    required: ['a/b', 'missing'],
    dependencies: { 'c~d': ['dep'] },
  });
  const result = s.validate({ 'a/b': [1, 11, 1], 'c~d': 'z' });
  const byKeyword = Object.fromEntries(result.errors.map((e) => [e.keyword + e.instancePath, e]));
  assertEquals(byKeyword['maximum/a~1b/1'].params, { comparison: '<=', limit: 10 });
  assertEquals(byKeyword['maximum/a~1b/1'].schemaPath, '#/properties/a~1b/items/maximum');
  assertEquals(byKeyword['uniqueItems/a~1b'].params, { i: 2, j: 0 });
  assertEquals(byKeyword['enum/c~0d'].params, { allowedValues: ['x', 'y'] });
  assertEquals(byKeyword['required'].params, { missingProperty: 'missing' });
  assertEquals(byKeyword['dependencies'].params, { property: 'c~d', missingProperty: 'dep' });
  assertEquals(result.errorCount, result.errors.length);
});

Deno.test('TEST mode reports the same verdict as VALIDATE mode and stores nothing', () => {
  const engine = createSchemaEngine();
  const s = engine.compile(WORKLOADS[2].schema);
  for (const document of WORKLOADS[2].documents) {
    const full = s.validate(document);
    assertEquals(s.test(document), full.valid);
    const testMode = s._run(document, SCHEMA_CONTINUATION.MODE.TEST, {});
    assertEquals(testMode.errors, []);
    if (!full.valid) assertEquals(testMode.fuelCharged <= full.fuelCharged, true);
  }
});

Deno.test('error count stays honest past the stored capacity', () => {
  const engine = createSchemaEngine();
  const s = engine.compile({ items: { type: 'string' } });
  const document = Array.from({ length: 100 }, (_, i) => i);
  const result = s.validate(document, { maxErrors: 5 });
  assertEquals(result.errors.length, 5);
  assertEquals(result.errorCount, 100);
  assertEquals(result.errors[4].instancePath, '/4');
});

Deno.test('structural equality is key-order independent and numeric across int/float', () => {
  const engine = createSchemaEngine();
  const s = engine.compile({ const: { a: 1, b: [1, 2.0, { c: null }] } });
  assert(s.test({ b: [1.0, 2, { c: null }], a: 1 }));
  assert(!s.test({ b: [2, 1, { c: null }], a: 1 }));
  const u = engine.compile({ uniqueItems: true });
  assert(!u.test([{ a: 1, b: 2 }, { b: 2, a: 1 }]));
  assert(u.test([[1, 2], [2, 1]]));
  assert(!u.test([1, 1.0]));
  assert(u.test([1, '1', true, null, [1]]));
});

Deno.test('draft-4 integers reject integral floats when handed a real float64', () => {
  const engine = createSchemaEngine();
  const s = engine.compile({ type: 'integer' }, { dialect: 'draft-04' });
  const float = new Uint8Array([0xcb, 0x3f, 0xf0, 0, 0, 0, 0, 0, 0]); // float64 1.0
  assertEquals(s.test(float), false);
  assertEquals(s.test(1), true);
  const modern = engine.compile({ type: 'integer' });
  assertEquals(modern.test(float), true);
});

Deno.test('numbers compare exactly across the 64-bit boundary', () => {
  const engine = createSchemaEngine();
  const big = new Uint8Array([0xcf, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff]); // uint64 max
  assert(engine.compile({ minimum: 9007199254740992 }).test(big));
  assert(!engine.compile({ maximum: 9007199254740992 }).test(big));
  assert(engine.compile({ type: 'integer' }).test(big));
  assert(engine.compile({ multipleOf: 0.5 }).test(1e308));
  assert(!engine.compile({ multipleOf: 0.123456789 }).test(1e308));
  assert(engine.compile({ multipleOf: 0.0001 }).test(0.0075));
  assert(!engine.compile({ multipleOf: 0.0001 }).test(0.00751));
});

Deno.test('malformed inputs are statuses, never faults', () => {
  const engine = createSchemaEngine();
  const s = engine.compile({ type: 'object' });
  assertThrows(() => s.test(new Uint8Array([0xc1])), SchemaError, 'CORRUPT_DOCUMENT');
  assertThrows(() => s.test(new Uint8Array([0x92, 0x01])), SchemaError, 'CORRUPT_DOCUMENT');
  assertThrows(() => engine.compile({ required: 'nope' }), SchemaError, 'SYNTAX_ERROR');
  assertThrows(() => engine.compile({ $ref: '#/nowhere' }), SchemaError, 'SYNTAX_ERROR');
  assertThrows(() => engine.compile({ $ref: 'other.json' }), SchemaError, 'SYNTAX_ERROR');
  assertThrows(() => engine.compile({ $ref: 'http://example.com/x#/a' }), SchemaError, 'SYNTAX_ERROR');
  assertThrows(() => engine.compile({ type: 'object', zzz: 1 }, { strict: true }), SchemaError, 'SYNTAX_ERROR');
  assertThrows(() => engine.compile({ allOf: [] }), SchemaError, 'SYNTAX_ERROR');
  const deep = engine.compile({ $ref: '#' });
  assertThrows(() => deep.test(1), SchemaError, 'LIMIT_EXCEEDED');
});

Deno.test('a document relocated between grants validates identically', () => {
  const engine = createSchemaEngine();
  const x = engine.exports;
  const s = engine.compile(WORKLOADS[0].schema);
  const docBytes = encode(WORKLOADS[0].documents[1]);
  engine._scratchReset();
  let doc = engine._scratchAlloc(docBytes.length);
  engine.bytes.set(docBytes, doc);
  const size = x.continuation_size(s.program, s.size, 64, 16, 1024);
  const cont = engine._scratchAlloc(size);
  assertEquals(x.initialize_validation(s.program, s.size, doc, docBytes.length, 1, 64, 16, 1024, cont, size), 0);
  let status;
  for (let i = 0; i < 1000; i++) {
    [status] = x.run_validation(cont, size, 1);
    if (status !== SCHEMA_STATUS.PAUSED) break;
    // move the document every grant
    const moved = engine._scratchAlloc(docBytes.length + 8) + 8;
    engine.bytes.set(docBytes, moved);
    engine.bytes.fill(0, doc, doc + docBytes.length);
    doc = moved;
    assertEquals(x.rebind_validation(cont, s.program, doc), 0);
  }
  assertEquals(status, SCHEMA_STATUS.INVALID);
  assertEquals(x.error_count(cont), 2);
});

Deno.test('keyword table classifies every keyword name and nothing else', () => {
  const engine = createSchemaEngine();
  const x = engine.exports;
  engine._scratchReset();
  const schema = encode({});
  const addr = engine._scratchAlloc(schema.length);
  engine.bytes.set(schema, addr);
  const wsSize = x.compile_workspace_size(schema.length);
  const ws = engine._scratchAlloc(wsSize);
  let initialize = 1;
  let status;
  do {
    [status] = x.measure_schema(addr, schema.length, ws, wsSize, 0, initialize, 1000);
    initialize = 0;
  } while (status === SCHEMA_STATUS.PAUSED);
  assertEquals(status, SCHEMA_STATUS.OK);
  const text = engine._scratchAlloc(64);
  const enc = new TextEncoder();
  for (let code = 1; code < KEYWORD_NAMES.length; code++) {
    const bytes = enc.encode(KEYWORD_NAMES[code]);
    engine.bytes.set(bytes, text);
    assertEquals(x.keyword_code(ws, text, bytes.length), code, KEYWORD_NAMES[code]);
  }
  for (const name of ['', 'Type', 'propertie', 'propertiesx', '$refs']) {
    const bytes = enc.encode(name);
    engine.bytes.set(bytes, text);
    assertEquals(x.keyword_code(ws, text, bytes.length), 0, name);
  }
});

Deno.test('arena retries retain their charge and cannot start after budget exhaustion', () => {
  const engine = createSchemaEngine();
  const x = engine.exports;
  const schema = engine.compile({ type: 'array', uniqueItems: true, items: { type: 'integer' } });
  const document = Array.from({ length: 64 }, (_, i) => i);
  const bytes = encode(document);
  engine._scratchReset();
  const doc = engine._scratchAlloc(bytes.length);
  engine.bytes.set(bytes, doc);
  const size = x.continuation_size(schema.program, schema.size, 256, 64, 8);
  const cont = engine._scratchAlloc(size);
  assertEquals(x.initialize_validation(schema.program, schema.size, doc, bytes.length, 3, 256, 64, 8, cont, size), SCHEMA_STATUS.OK);
  const grant = 1000000;
  const [status, remaining] = x.run_validation(cont, size, grant);
  assertEquals(status, SCHEMA_STATUS.LIMIT_EXCEEDED);
  const failedCharge = grant - remaining;
  assert(failedCharge > 0);
  const required = engine.view.getUint32(cont + SCHEMA_CONTINUATION.HEADER.ARENA_REQUIRED, true);
  assert(required > 8);

  const withoutRetry = schema.validate(document, { arenaBytes: required });
  const total = failedCharge + withoutRetry.fuelCharged;
  const retried = schema.validate(document, { arenaBytes: 8 });
  assertEquals(retried, { ...withoutRetry, fuelCharged: total });
  assertEquals(schema.validate(document, { arenaBytes: 8, fuel: total }), retried);
  assertEquals(schema.validate(document, { arenaBytes: 8, grant: 1 }), retried);

  const exhausted = assertThrows(
    () => schema.validate(document, { arenaBytes: 8, fuel: failedCharge }),
    SchemaError,
  );
  assertEquals(exhausted.status, 'PAUSED'); // facade compatibility; not a direct-routing outcome
  assertEquals(exhausted.fuelCharged, failedCharge);
});

Deno.test('zero-grant sets pause before gates; atomic terminal overrun stays charged', () => {
  const engine = createSchemaEngine();
  const x = engine.exports;
  const schema = engine.compileSet([
    { type: 'object', required: ['kind'], properties: { kind: { const: 'a' } } },
  ]);
  const document = { kind: 'a' };
  const bytes = encode(document);
  engine._scratchReset();
  const doc = engine._scratchAlloc(bytes.length);
  engine.bytes.set(bytes, doc);
  const size = x.continuation_size(schema.program, schema.size, 64, 0, 1024);
  const cont = engine._scratchAlloc(size);
  assertEquals(x.initialize_validation(schema.program, schema.size, doc, bytes.length, 2, 64, 0, 1024, cont, size), SCHEMA_STATUS.OK);
  const setupCharge = x.validation_fuel_charged(cont);
  assert(setupCharge > 0);
  assertEquals(x.run_validation(cont, size, 0), [SCHEMA_STATUS.PAUSED, 0]);
  assertEquals(x.validation_fuel_charged(cont), setupCharge);
  const [status, remaining] = x.run_validation(cont, size, 1);
  assertEquals(status, SCHEMA_STATUS.VALID);
  assert(remaining < 0);
  assertEquals(x.validation_fuel_charged(cont), 1 - remaining);
  assertEquals(x.run_validation(cont, size, 0), [SCHEMA_STATUS.VALID, 0]);
  // The facade compatibility flag preserves terminal atomic precedence;
  // strict direct helpers reject the same over-budget result.
  assertEquals(schema.match(document, { fuel: 1 }), [0]);
});

Deno.test('restored wide work counters cross i32/u32 boundaries and saturate only at u64 overflow', () => {
  const engine = createSchemaEngine();
  const x = engine.exports;
  const schema = engine.compile({ type: 'array', items: { type: 'integer' } });
  const bytes = encode(Array.from({ length: 64 }, (_, i) => i));
  engine._scratchReset();
  const doc = engine._scratchAlloc(bytes.length);
  engine.bytes.set(bytes, doc);
  const size = x.continuation_size(schema.program, schema.size, 64, 0, 1024);
  const cont = engine._scratchAlloc(size);
  const ch = SCHEMA_CONTINUATION.HEADER;
  const total = () => BigInt.asUintN(64, x.validation_work_charged(cont));
  for (const restored of [0xffffffffn, 0x8000000000000000n, 0xffffffffffffffffn]) {
    assertEquals(x.initialize_validation(schema.program, schema.size, doc, bytes.length, 2, 64, 0, 1024, cont, size), SCHEMA_STATUS.OK);
    // Spend setup debt before restoring the cumulative counter. It is legal to
    // restore a large total without replaying billions of prior VM steps.
    assertEquals(x.run_validation(cont, size, 1)[0], SCHEMA_STATUS.PAUSED);
    engine.view.setBigUint64(cont + ch.WORK_CHARGED, restored, true);
    const [status, remaining] = x.run_validation(cont, size, 1);
    assertEquals(status, SCHEMA_STATUS.PAUSED);
    const charged = BigInt(1 - remaining);
    assert(charged > 0n);
    if (restored === 0xffffffffffffffffn) {
      assertEquals(total(), restored);
      assertEquals(x.validation_work_overflow(cont), 1);
      x.run_validation(cont, size, 1);
      assertEquals(total(), restored);
      assertEquals(x.validation_work_overflow(cont), 1);
    } else {
      assertEquals(total(), restored + charged);
      assertEquals(x.validation_work_overflow(cont), 0);
    }
    assertEquals(x.validation_fuel_charged(cont), 0x7fffffff);
  }

  // A pending atomic setup charge outside the old return width must pause,
  // never wrap into a positive grant and dispatch instructions.
  assertEquals(x.initialize_validation(schema.program, schema.size, doc, bytes.length, 2, 64, 0, 1024, cont, size), SCHEMA_STATUS.OK);
  engine.view.setBigUint64(cont + ch.WORK_CHARGED, 0x100000000n, true);
  engine.view.setBigUint64(cont + ch.WORK_PENDING, 0x100000000n, true);
  assertEquals(x.run_validation(cont, size, 1), [SCHEMA_STATUS.PAUSED, -2147483648]);
  assertEquals(total(), 0x100000000n);
  assertEquals(x.validation_work_overflow(cont), 0);
  let status;
  do {
    [status] = x.run_validation(cont, size, 1000);
  } while (status === SCHEMA_STATUS.PAUSED);
  assertEquals(status, SCHEMA_STATUS.VALID);
  assert(total() > 0x100000000n);
});

Deno.test('compiler wide accounting survives resumed measurement and reports sticky overflow', () => {
  const engine = createSchemaEngine();
  const x = engine.exports;
  const bytes = encode(WORKLOADS[0].schema);
  engine._scratchReset();
  const input = engine._scratchAlloc(bytes.length);
  engine.bytes.set(bytes, input);
  const size = x.compile_workspace_size(bytes.length);
  const ws = engine._scratchAlloc(size);
  assertEquals(x.measure_schema(input, bytes.length, ws, size, 0, 1, 1)[0], SCHEMA_STATUS.PAUSED);
  engine.view.setBigUint64(ws + SCHEMA_COMPILE.HEADER.WORK_CHARGED, 0xffffffffn, true);
  const [status, remaining] = x.measure_schema(input, bytes.length, ws, size, 0, 0, 1);
  assertEquals(status, SCHEMA_STATUS.PAUSED);
  assert(remaining <= 0);
  assertEquals(BigInt.asUintN(64, x.compile_work_charged(ws)), 0xffffffffn + BigInt(1 - remaining));
  assertEquals(x.compile_fuel_charged(ws), 0x7fffffff);
  engine.view.setBigUint64(ws + SCHEMA_COMPILE.HEADER.WORK_CHARGED, 0xffffffffffffffffn, true);
  x.measure_schema(input, bytes.length, ws, size, 0, 0, 1);
  assertEquals(x.compile_work_overflow(ws), 1);
  x.measure_schema(input, bytes.length, ws, size, 0, 0, 1);
  assertEquals(BigInt.asUintN(64, x.compile_work_charged(ws)), 0xffffffffffffffffn);
  assertEquals(x.compile_work_overflow(ws), 1);
});

Deno.test('failed whole-MessagePack checks charge the examined prefix in compile and validation setup', () => {
  const engine = createSchemaEngine();
  const x = engine.exports;
  const schema = engine.compile(true);
  const charges = [];
  for (const count of [1, 129]) {
    const bytes = encode(Array.from({ length: count }, () => null));
    bytes[bytes.length - 1] = 0xc1; // malformed only after the preceding items
    engine._scratchReset();
    const input = engine._scratchAlloc(bytes.length);
    engine.bytes.set(bytes, input);
    const size = x.compile_workspace_size(bytes.length);
    const ws = engine._scratchAlloc(size);
    const [status, remaining] = x.measure_schema(input, bytes.length, ws, size, 0, 1, 1);
    assertEquals(status, SCHEMA_STATUS.CORRUPT_DOCUMENT);
    const compile = BigInt.asUintN(64, x.compile_work_charged(ws));
    assertEquals(compile, BigInt(1 - remaining));
    const contSize = x.continuation_size(schema.program, schema.size, 64, 0, 1024);
    const cont = engine._scratchAlloc(contSize);
    assertEquals(x.initialize_validation(schema.program, schema.size, input, bytes.length, 2, 64, 0, 1024, cont, contSize), SCHEMA_STATUS.CORRUPT_DOCUMENT);
    const validation = BigInt.asUintN(64, x.validation_work_charged(cont));
    assertEquals(x.run_validation(cont, contSize, 1000)[0], SCHEMA_STATUS.CORRUPT_PROGRAM);
    charges.push({ compile, validation });
  }
  assert(charges[1].compile >= charges[0].compile + 128n);
  assert(charges[1].validation >= charges[0].validation + 128n);
});

Deno.test('resource finalization and backward annotation propagation suspend without repeating their work', () => {
  const defs = { d0: { properties: { value: true } } };
  for (let i = 1; i <= 24; i++) defs[`d${i}`] = { $ref: `#/$defs/d${i - 1}` };
  const schema = { $defs: defs, $ref: '#/$defs/d24', unevaluatedProperties: false };
  const resources = Array.from({ length: 24 }, (_, i) => [
    `https://example.test/r${i}`, { $dynamicAnchor: 'here', type: 'object' },
  ]);
  const inputBytes = encode([schema, null, ...resources]);
  const compile = (grant) => {
    const engine = createSchemaEngine();
    const x = engine.exports;
    engine._scratchReset();
    const input = engine._scratchAlloc(inputBytes.length);
    engine.bytes.set(inputBytes, input);
    const size = x.compile_workspace_size(inputBytes.length);
    const ws = engine._scratchAlloc(size);
    let initialize = 1;
    const drive = (ptr, call) => {
      let previous = 0n;
      const pausedPhases = [];
      for (let i = 0; i < 100000; i++) {
        const [status, remaining] = call();
        const total = BigInt.asUintN(64, x.compile_work_charged(ptr));
        assertEquals(total - previous, BigInt(grant - remaining));
        previous = total;
        if (status !== SCHEMA_STATUS.PAUSED) {
          assertEquals(status, SCHEMA_STATUS.OK);
          return { total, pausedPhases };
        }
        pausedPhases.push(engine.view.getUint32(ptr + SCHEMA_COMPILE.HEADER.FINAL_PHASE, true));
      }
      throw new Error('compiler did not terminate');
    };
    const measured = drive(ws, () => {
      const result = x.measure_schema(input, inputBytes.length, ws, size, 0, initialize, grant);
      initialize = 0;
      return result;
    });
    const programSize = x.measured_program_size(ws);
    const emissionSize = x.emission_workspace_size(ws);
    const ews = engine._scratchAlloc(emissionSize);
    const program = engine._scratchAlloc(programSize);
    assertEquals(x.initialize_emission(ws, ews, emissionSize, program, programSize), SCHEMA_STATUS.OK);
    const emitted = drive(ews, () => x.emit_program(ews, emissionSize, input, program, grant));
    return {
      total: measured.total + emitted.total,
      phases: emitted.pausedPhases,
      bytes: engine.bytes.slice(program, program + x.program_total_bytes(program)),
    };
  };
  const whole = compile(0x7fffffff);
  const stepped = compile(1);
  assertEquals(stepped.bytes, whole.bytes);
  assertEquals(stepped.total, whole.total);
  assert(stepped.phases.filter((phase) => phase === 1).length >= resources.length);
  assert(stepped.phases.filter((phase) => phase === 3).length >= 20);
  const loaded = createSchemaEngine().load(stepped.bytes);
  assertEquals(loaded.test({ value: 1 }), true);
  assertEquals(loaded.test({ other: 1 }), false);
});

Deno.test('unresolved-reference drain failures retain the same charge under tiny grants', () => {
  const engine = createSchemaEngine();
  const schema = {
    allOf: Array.from({ length: 32 }, (_, i) => ({ $ref: `https://missing.test/r${i}#anchor` })),
  };
  const whole = assertThrows(() => engine.compile(schema), SchemaError);
  const stepped = assertThrows(() => engine.compile(schema, { grant: 1 }), SchemaError);
  assertEquals(whole.status, 'SYNTAX_ERROR');
  assertEquals(stepped.status, whole.status);
  assertEquals(stepped.diagnostic, whole.diagnostic);
  assertEquals(stepped.schemaOffset, whole.schemaOffset);
  assertEquals(stepped.fuelCharged, whole.fuelCharged);
  assert(whole.fuelCharged >= 32);
});

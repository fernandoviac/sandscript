import { assert, assertEquals, assertThrows } from 'https://deno.land/std@0.208.0/assert/mod.ts';
import { createSchemaEngine, SchemaError } from '../../src/schema/index.js';
import { encode, decode } from '../../src/membrane/msgpack.js';
import { SCHEMA_CONTINUATION as C, SCHEMA_STATUS } from '../../src/fuel/schema-engine-contract.js';
import { freshSession, restoreSession, snapshotSession } from '../../src/host-owned-session.js';
import { CTX, GC_HEADER_SIZE, NATIVE_CONTINUATION_STATE, SCHEMA_PH, EXIT_PAUSED_FUEL, EXIT_MEMORY_PRESSURE, HEAP_SLACK_HEADROOM } from '../../src/fuel/constants.js';
import { parseAndSetup } from './test-helpers.js';

// Keep the schema operand's actual MessagePack number representation, including
// -0 and int64/uint64 values that the JS encoder would otherwise normalize.
function numericSchema(keyword, tag, bits) {
  const prefix = encode({ [keyword]: null });
  const bytes = new Uint8Array(prefix.length + 8);
  bytes.set(prefix);
  bytes[prefix.length - 1] = tag;
  new DataView(bytes.buffer).setBigUint64(prefix.length, bits, false);
  return bytes;
}

Deno.test('complete schema messages: binary64 shortest decimals agree with native Number at rounding boundaries', () => {
  const engine = createSchemaEngine();
  const bits = new DataView(new ArrayBuffer(8));
  // Neighbours defend fixed/scientific cutovers, asymmetric power-of-two
  // intervals, the normal/subnormal transition, and ties in 17-digit output.
  const values = [-0, 0, Number.MIN_VALUE, 2 ** -1022, 1e-7, 1e-6, 0.1, 0.3, 1 / 3,
    1, 2, 1e20, 1e21, 2 ** 53, 2 ** 63, 1e100, Number.MAX_VALUE];
  for (const value of values) {
    bits.setFloat64(0, value, false);
    const center = bits.getBigUint64(0, false);
    for (const offset of [-1n, 0n, 1n]) {
      const representation = BigInt.asUintN(64, center + offset);
      bits.setBigUint64(0, representation, false);
      const limit = bits.getFloat64(0, false);
      if (!Number.isFinite(limit)) continue;
      for (const sign of [0n, 1n << 63n]) {
        const signed = representation ^ sign;
        bits.setBigUint64(0, signed, false);
        const expected = bits.getFloat64(0, false);
        const schema = engine.compile(numericSchema('exclusiveMaximum', 0xcb, signed));
        const result = schema.validate(expected);
        assertEquals(result.valid, false);
        const error = result.errors[0];
        assertEquals(error.params.limit, expected);
        assertEquals(error.message.split(' ').at(-1), String(expected));
        schema.dispose();
      }
    }
  }
});

Deno.test('complete schema messages: int64 and uint64 params use the decoder Number presentation', () => {
  const engine = createSchemaEngine();
  for (const [tag, bits, document] of [
    [0xcf, 9007199254740991n, -1], [0xcf, 9007199254740993n, -1],
    [0xcf, 0xffffffffffffffffn, -1], [0xd3, 0x8000000000000000n, -1e30],
    [0xd3, 0xffdfffffffffffffn, -1e30],
  ]) {
    const input = numericSchema('minimum', tag, bits);
    const expected = decode(input).minimum;
    const schema = engine.compile(input);
    const result = schema.validate(document);
    assertEquals(result.valid, false);
    assertEquals(result.errors[0].params.limit, expected);
    assertEquals(result.errors[0].message.split(' ').at(-1), String(expected));
    schema.dispose();
  }
});

Deno.test('complete schema messages: bounded failed windows preserve settled validation and charge retries', () => {
  const engine = createSchemaEngine();
  const missing = '雪/~'.repeat(1000);
  const schema = engine.compile({ required: [missing] });
  let attemptsWork = 0;
  let firstAttemptWork;
  let validationWork;
  let completed;
  engine._runProgram(schema, {}, C.MODE.VALIDATE, {}, (cont, status, account) => {
    assertEquals(status, SCHEMA_STATUS.INVALID);
    validationWork = engine._spent(account);
    const x = engine.exports;
    const sourceWork = x.validation_work_charged(cont);
    const storage = engine._scratchAlloc(32768 + 32);
    const out = storage + 16;
    const zero = engine.bytes.slice(0, 32);
    for (const cap of [0, 1, 4096, 8192, 16384, 32768]) {
      engine.bytes.fill(0xa5, storage, storage + 32768 + 32);
      const [n, work, overflow] = x.render_error_complete(schema.program, cont, 0, out, cap);
      assertEquals(overflow, 0);
      assert(BigInt.asUintN(64, work) > 0n);
      assertEquals(engine.bytes.slice(storage, out), new Uint8Array(16).fill(0xa5));
      assertEquals(engine.bytes.slice(out + cap, out + cap + 16), new Uint8Array(16).fill(0xa5));
      assertEquals(engine.bytes.slice(0, 32), zero, 'a stateless renderer must not store a meter at address zero');
      assertEquals(x.validation_work_charged(cont), sourceWork, 'output growth must not rerun or mutate validation');
      if (cap < 16384) assertEquals(n, -1);
      if (cap === 8192 || cap === 16384) attemptsWork += Number(BigInt.asUintN(64, work));
      if (cap === 8192) firstAttemptWork = Number(BigInt.asUintN(64, work));
      if (n >= 0) completed = decode(engine.bytes.slice(out, out + n));
    }
    const [badIndex, badWork] = x.render_error_complete(schema.program, cont, 1, out, 32768);
    assertEquals(badIndex, -2);
    assert(BigInt.asUintN(64, badWork) > 0n);
    const [badRange, rangeWork] = x.render_error_complete(schema.program, cont, 0, 0xfffffff0, 0xffffffff);
    assertEquals(badRange, -1);
    assert(BigInt.asUintN(64, rangeWork) > 0n);
    assertEquals(engine.bytes.slice(0, 32), zero);
    const rawLength = x.render_error(schema.program, cont, 0, out, 32768);
    assert(rawLength >= 0);
    const { message: _message, ...rawFields } = completed;
    assertEquals(decode(engine.bytes.slice(out, out + rawLength)), rawFields);
  });
  const result = schema.validate({});
  assertEquals(result.errors, [completed]);
  assertEquals(result.fuelCharged, validationWork + attemptsWork);
  const exhausted = assertThrows(() => schema.validate({}, { fuel: validationWork + 1 }), SchemaError);
  assertEquals(exhausted.status, 'PAUSED');
  assertEquals(exhausted.fuelCharged, validationWork + firstAttemptWork);
  schema.dispose();
});

Deno.test('complete schema messages: builtin numeric diagnostics agree with native Number', () => {
  const values = [Number.MIN_VALUE, 1e-7, 1e-6, 0.1, 1 / 3, 1e20, 1e21, 1e100];
  const engine = createSchemaEngine();
  const expected = values.map((value) => {
    const schema = engine.compile({ exclusiveMaximum: value });
    const error = schema.errors(value)[0];
    schema.dispose();
    return error;
  });
  // Transfer the actual binary64 inputs; decimal parsing is a separate contract.
  const session = freshSession({ inlineSource: true });
  parseAndSetup(session, `
    const values = msgpack.decode(new Uint8Array(${JSON.stringify(Array.from(encode(values)))}));
    let diagnostics = values.map((value) => Schema.validate({ exclusiveMaximum: value }, value).errors[0]);
  `);
  assertEquals(session.run(0, 100000000).status, 'done');
  assertEquals(session.get(0, 'diagnostics'), expected);
});

function nativeState(session) {
  const mem = session.mem;
  const root = mem.view.getUint32(mem.abs(mem.getContextStateBase(0) + CTX.REGEX_STATE), true);
  if (!root) return null;
  const values = mem.abs(root + GC_HEADER_SIZE + NATIVE_CONTINUATION_STATE.VALUES);
  return {
    phase: mem.view.getUint32(values, true) & 0xff,
    continuation: mem.abs(mem.view.getUint32(values + 8, true) + 4),
  };
}

Deno.test('complete schema messages: pressure retries debit rendering before returning and survive restored collection', () => {
  const missing = 'x'.repeat(40000);
  let session = freshSession({ inlineSource: true });
  parseAndSetup(session, `let schema = Schema.compile({ required: [${JSON.stringify(missing)}] });`);
  assertEquals(session.run(0, 100000000).status, 'done');
  parseAndSetup(session, 'let diagnostic = schema.validate({}); let finished = true;');
  for (let i = 0; i < 1000 && nativeState(session)?.phase !== SCHEMA_PH.VALIDATE_RUN; i++) {
    session.mem.wasm.exports.run(1, 0);
    assertEquals(session.mem.getExitCondition(0), EXIT_PAUSED_FUEL);
  }
  assertEquals(nativeState(session)?.phase, SCHEMA_PH.VALIDATE_RUN);
  const mem = session.mem;
  const checkpoint = mem.getHeapPointer();
  // A real unrooted allocation leaves enough room for dispatch and several
  // failed render windows, but not the final output-plus-buffer window.
  const reservation = mem.getCodePointer() - checkpoint - HEAP_SLACK_HEADROOM - 4096;
  mem.allocateArrayBuffer(reservation - GC_HEADER_SIZE - 4);
  mem.wasm.exports.run(100000000, 0);
  assertEquals(mem.getExitCondition(0), EXIT_MEMORY_PRESSURE);
  assertEquals(nativeState(session)?.phase, SCHEMA_PH.VALIDATE_MATERIALIZE);
  const cont = nativeState(session).continuation;
  const settledWork = mem.view.getBigUint64(cont + C.HEADER.WORK_CHARGED, true);
  const remaining = mem.wasm.exports.run(100000000, 0);
  assertEquals(mem.getExitCondition(0), EXIT_MEMORY_PRESSURE);
  assert(100000000 - remaining > 100, 'failed rendering attempts must consume fuel before the pressure return');
  assertEquals(mem.view.getBigUint64(cont + C.HEADER.WORK_CHARGED, true), settledWork);
  mem.setHeapPointer(checkpoint);
  const snapshot = snapshotSession(session);
  session = restoreSession(snapshot.vatBytes, snapshot.membraneBytes);
  session.gc();
  assertEquals(session.run(0, 100000000).status, 'done');
  const result = session.get(0, 'diagnostic');
  assertEquals(result.errors[0].params.missingProperty, missing);
  assert(result.errors[0].message.includes(missing));
  assertEquals(session.get(0, 'finished'), true);
});

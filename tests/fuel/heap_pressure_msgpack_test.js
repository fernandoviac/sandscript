/**
 * Msgpack stream-processor pressure pre-checks.
 *
 * The msgpack-materialization helpers ($msgpack_to_array, $msgpack_map_keys,
 * $msgpack_array_keys, $msgpack_map_values, $msgpack_map_entries) each
 * allocate a result heap array sized from the msgpack wire-format count
 * field. The helpers once bumped the heap pointer past code_pointer, after
 * which the per-instruction dispatcher surfaced ERR_OUT_OF_MEMORY instead of
 * permitting pressure recovery.
 *
 * Opcode handlers now inspect the msgpack count and pre-check
 * estimate_array_size, including per-pair arrays for msgpack_map_entries.
 * Overflow yields EXIT_MEMORY_PRESSURE so the host can
 * gc + retry.
 *
 * The recursive-decode pressure pass moved container checks inside
 * $msgpack_to_array / $msgpack_to_object for count-proportional coverage and
 * replaced msgpack.decode's flat
 * 512 KB entry demand (which false-OOMed small decodes on any heap
 * whose HEAP→CODE gap sat under 512 KB), gave Object.assign per-entry
 * grow pre-checks on both its source paths, and made $msgpack_peek_type
 * reject container counts larger than the remaining input (hostile
 * array32/map32 counts used to wrap the count*16 size math past every
 * estimate).
 */

import { assertEquals, assert } from 'https://deno.land/std@0.208.0/assert/mod.ts';
import { parseAndSetup } from './test-helpers.js';
import { freshSession } from '../../src/host-owned-session.js';
import { TYPE } from '../../src/fuel/constants.js';

function writeMsgpackPayload(mem, bytes) {
  const dataPointer = mem.allocateMsgpackBytes(bytes.length);
  const bytesAbsolute = mem.abs(dataPointer + 4);
  const u8 = new Uint8Array(mem.memory.buffer);
  for (let i = 0; i < bytes.length; i++) {
    u8[bytesAbsolute + i] = bytes[i];
  }
  return dataPointer;
}

// Encode a fixarray of small positive integers [0..count). count <= 15.
function encodeFixArrayOfSmallInts(count) {
  if (count > 15) throw new Error('fixarray too large');
  const bytes = [0x90 | count];
  for (let i = 0; i < count; i++) bytes.push(i & 0x7f);
  return bytes;
}

// Encode a fixmap of {k0:0, k1:1, ...} for small count <= 15.
function encodeFixMapOfStringKeys(count) {
  if (count > 15) throw new Error('fixmap too large');
  const bytes = [0x80 | count];
  for (let i = 0; i < count; i++) {
    const key = 'k' + i;
    bytes.push(0xa0 | key.length);
    for (let j = 0; j < key.length; j++) bytes.push(key.charCodeAt(j));
    bytes.push(i & 0x7f);
  }
  return bytes;
}

function runWithRecovery(session, maxIters = 200) {
  const mem = session.memoryImage;
  let result;
  for (let i = 0; i < maxIters; i++) {
    result = session.run(0, 50000);
    if (result.status === 'memory_pressure') {
      session.gc();
      continue;
    }
    return result;
  }
  return result;
}

function exposeMsgpack(session, varName, bytes) {
  const mem = session.memoryImage;
  const dataPointer = writeMsgpackPayload(mem, bytes);
  const scope = mem.getRootScope();
  const nameOffset = mem.internString(varName);
  const valuePtr = mem.scopeLookup(scope, nameOffset);
  if (!valuePtr) throw new Error(`Failed to find ${varName} in scope`);
  mem.writeMsgpackRef(valuePtr, dataPointer, 0);
}

Deno.test('Array.from(msgpackArray) loop under pressure yields and recovers', () => {
  const session = freshSession({ heapSize: 96 * 1024 });
  parseAndSetup(session, 'let payload = null;');
  session.run(0, 10000);

  exposeMsgpack(session, 'payload', encodeFixArrayOfSmallInts(8));

  parseAndSetup(session, `
    let total = 0;
    for (let i = 0; i < 300; i = i + 1) {
      const materialized = Array.from(payload);
      total = total + materialized.length;
    }
    let result = total;
  `);

  const result = runWithRecovery(session);
  assertEquals(result.status, 'done', `expected done, got ${result.status}`);
  assertEquals(session.get(0, 'result'), 2400);
});

Deno.test('Object.keys(msgpackMap) loop under pressure yields and recovers', () => {
  const session = freshSession({ heapSize: 96 * 1024 });
  parseAndSetup(session, 'let payload = null;');
  session.run(0, 10000);

  exposeMsgpack(session, 'payload', encodeFixMapOfStringKeys(6));

  parseAndSetup(session, `
    let total = 0;
    for (let i = 0; i < 300; i = i + 1) {
      const keys = Object.keys(payload);
      total = total + keys.length;
    }
    let result = total;
  `);

  const result = runWithRecovery(session);
  assertEquals(result.status, 'done', `expected done, got ${result.status}`);
  assertEquals(session.get(0, 'result'), 1800);
});

Deno.test('Object.values(msgpackMap) loop under pressure yields and recovers', () => {
  const session = freshSession({ heapSize: 96 * 1024 });
  parseAndSetup(session, 'let payload = null;');
  session.run(0, 10000);

  exposeMsgpack(session, 'payload', encodeFixMapOfStringKeys(6));

  parseAndSetup(session, `
    let total = 0;
    for (let i = 0; i < 300; i = i + 1) {
      const values = Object.values(payload);
      total = total + values.length;
    }
    let result = total;
  `);

  const result = runWithRecovery(session);
  assertEquals(result.status, 'done', `expected done, got ${result.status}`);
  assertEquals(session.get(0, 'result'), 1800);
});

Deno.test('Object.entries(msgpackMap) loop under pressure yields and recovers', () => {
  const session = freshSession({ heapSize: 96 * 1024 });
  parseAndSetup(session, 'let payload = null;');
  session.run(0, 10000);

  exposeMsgpack(session, 'payload', encodeFixMapOfStringKeys(4));

  parseAndSetup(session, `
    let total = 0;
    for (let i = 0; i < 300; i = i + 1) {
      const entries = Object.entries(payload);
      total = total + entries.length;
    }
    let result = total;
  `);

  const result = runWithRecovery(session);
  assertEquals(result.status, 'done', `expected done, got ${result.status}`);
  assertEquals(session.get(0, 'result'), 1200);
});

Deno.test('msgpack.decode loop on a small heap yields and recovers (PINS the flat-guard false OOM)', () => {
  // 96 KB heap: the HEAP→CODE gap can never reach the old flat 512 KB
  // entry demand, so the FIRST decode used to false-OOM with the heap
  // nearly empty. With the count-proportional checks inside the
  // container builders, a small decode fits trivially; the loop's
  // transient trees (including the nested map, which exercises the
  // msgpack_to_object recursion) recover via gc.
  const session = freshSession({ heapSize: 96 * 1024 });
  parseAndSetup(session, `
    let bytes = msgpack.encode({ a: 1, b: [1, 2, 3], c: "hello", d: { e: 2 } });
    let total = 0;
    for (let i = 0; i < 300; i = i + 1) {
      const obj = msgpack.decode(bytes);
      total = total + obj.a + obj.d.e;
    }
    let result = total;
  `);

  const result = runWithRecovery(session);
  assertEquals(result.status, 'done', `expected done, got ${result.status}`);
  assertEquals(session.get(0, 'result'), 900);
});

Deno.test('Object.assign(obj, msgpackMap) loop under pressure yields and recovers', () => {
  const session = freshSession({ heapSize: 96 * 1024 });
  parseAndSetup(session, 'let payload = null;');
  session.run(0, 10000);

  exposeMsgpack(session, 'payload', encodeFixMapOfStringKeys(6));

  parseAndSetup(session, `
    let total = 0;
    for (let i = 0; i < 300; i = i + 1) {
      const merged = Object.assign({}, payload);
      total = total + Object.keys(merged).length;
    }
    let result = total;
  `);

  const result = runWithRecovery(session);
  assertEquals(result.status, 'done', `expected done, got ${result.status}`);
  assertEquals(session.get(0, 'result'), 1800);
});

Deno.test('Object.assign(obj, obj) loop under pressure yields and recovers', () => {
  // 8 source keys against a fresh {} target (capacity 4): every
  // iteration forces the target's grow branch, the previously
  // unguarded blind allocation in METHOD_OBJECT_ASSIGN.
  const session = freshSession({ heapSize: 96 * 1024 });
  parseAndSetup(session, `
    let source = { a: 1, b: 2, c: 3, d: 4, e: 5, f: 6, g: 7, h: 8 };
    let total = 0;
    for (let i = 0; i < 300; i = i + 1) {
      const merged = Object.assign({}, source);
      total = total + Object.keys(merged).length;
    }
    let result = total;
  `);

  const result = runWithRecovery(session);
  assertEquals(result.status, 'done', `expected done, got ${result.status}`);
  assertEquals(session.get(0, 'result'), 2400);
});

Deno.test('JSON.stringify(decoded refs) loop under pressure yields and recovers', () => {
  // The MSGPACK_REF branch of json_stringify_value materializes
  // containers mid-serialization through the count-proportional
  // builders; a pressure refusal there must unwind the serializer's
  // -1 channel, yield, and retry cleanly after gc.
  const session = freshSession({ heapSize: 96 * 1024 });
  parseAndSetup(session, `
    let decoded = msgpack.decode(msgpack.encode({ a: [ { x: 1 }, [2, 3] ] }));
    let total = 0;
    for (let i = 0; i < 300; i = i + 1) {
      const s = JSON.stringify(decoded);
      total = total + s.length;
    }
    let result = total;
  `);

  const result = runWithRecovery(session);
  assertEquals(result.status, 'done', `expected done, got ${result.status}`);
  assertEquals(session.get(0, 'result'), '{"a":[{"x":1},[2,3]]}'.length * 300);
});

Deno.test('msgpack.decode of a hostile declared count errors cleanly, never allocates', () => {
  // array32 header declaring 2^32-1 elements in a 5-byte payload.
  // Unchecked, count*16 wraps the size math past every heap estimate
  // and the fill loop scribbles past the code pointer. The peek-time
  // count-vs-remaining-bytes check rejects it as malformed input.
  const session = freshSession({ heapSize: 96 * 1024 });
  const mem = session.memoryImage;
  const bytes = [0xdd, 0xff, 0xff, 0xff, 0xff];
  const bufPtr = mem.allocateArrayBuffer(bytes.length);
  const absBytes = mem.abs(bufPtr + 4);
  const u8 = new Uint8Array(mem.memory.buffer);
  for (let i = 0; i < bytes.length; i++) u8[absBytes + i] = bytes[i];
  const descriptorPtr = mem.allocateTypedArrayDescriptor(bufPtr, 0, bytes.length);
  mem.scopeSetRaw(mem.getContextScope(0), mem.internString('input'), TYPE.UINT8ARRAY, descriptorPtr, 0);

  session.parse(`
    let threw = false;
    try { msgpack.decode(input) } catch (e) { threw = true }
    let result = threw;
  `);
  const result = runWithRecovery(session);
  // Either surface is a clean refusal: a catchable in-sandbox error,
  // or a structured error return. What must NOT happen: success, a
  // pressure spin, or a trap.
  if (result.status === 'error') return;
  assertEquals(result.status, 'done', `expected done or error, got ${result.status}`);
  assertEquals(session.get(0, 'result'), true, 'decode of hostile count must throw');
});

Deno.test('Array method on msgpack array receiver (materialize-then-iterate) recovers under pressure', () => {
  // .forEach forces $msgpack_to_array materialization at the receiver
  // entry-point (line 17413 region in interpreter.wat).
  const session = freshSession({ heapSize: 96 * 1024 });
  parseAndSetup(session, 'let payload = null;');
  session.run(0, 10000);

  exposeMsgpack(session, 'payload', encodeFixArrayOfSmallInts(5));

  parseAndSetup(session, `
    let total = 0;
    for (let i = 0; i < 300; i = i + 1) {
      payload.forEach((x) => { total = total + x });
    }
    let result = total;
  `);

  const result = runWithRecovery(session);
  assertEquals(result.status, 'done', `expected done, got ${result.status}`);
  // sum 0+1+2+3+4 = 10 per iteration, 300 iters → 3000.
  assertEquals(session.get(0, 'result'), 3000);
});

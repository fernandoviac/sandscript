/**
 * Test msgpack ref support for read-only msgpack data.
 *
 * Run with: deno task test tests/fuel/test-msgpack.js
 */

import { assertEquals, assert, assertThrows } from "https://deno.land/std@0.208.0/assert/mod.ts";
import { createSession } from '../../src/fuel/session.js';
import { parseAndSetup } from './test-helpers.js';
import { freshSession } from '../../src/host-owned-session.js';
import { UncaughtScriptError } from '../../src/runtime/errors.js';

// Layout A: msgpack bytes live inside an OBJ.ARRAYBUFFER on the SS heap,
// allocated through MemoryImage.allocateMsgpackBytes. Tests no longer
// scribble into a free memory region — that pre-Layout-A pattern poisoned
// the GC walker.

function writeMsgpackPayload(mem, bytes) {
  const dataPointer = mem.allocateMsgpackBytes(bytes.length);
  const bytesAbsolute = mem.abs(dataPointer + 4);
  const u8 = new Uint8Array(mem.memory.buffer);
  for (let i = 0; i < bytes.length; i++) {
    u8[bytesAbsolute + i] = bytes[i];
  }
  return dataPointer;
}

function encodeFixstr(str) {
  const encoder = new TextEncoder();
  const bytes = encoder.encode(str);
  if (bytes.length > 31) throw new Error('fixstr too long');
  return [0xa0 | bytes.length, ...bytes];
}

function encodeStr8(str) {
  const encoder = new TextEncoder();
  const bytes = encoder.encode(str);
  if (bytes.length > 255) throw new Error('str8 too long');
  return [0xd9, bytes.length, ...bytes];
}

function encodeFixmap(obj) {
  const entries = Object.entries(obj);
  if (entries.length > 15) throw new Error('fixmap too large');
  const bytes = [0x80 | entries.length];
  for (const [key, value] of entries) {
    bytes.push(...encodeFixstr(key));
    if (typeof value === 'string') {
      bytes.push(...encodeFixstr(value));
    } else if (typeof value === 'number') {
      if (Number.isInteger(value) && value >= 0 && value <= 127) {
        bytes.push(value);
      } else if (Number.isInteger(value) && value >= -32 && value < 0) {
        bytes.push(0xe0 | (value + 32));
      } else {
        const buffer = new ArrayBuffer(8);
        new DataView(buffer).setFloat64(0, value, false);
        bytes.push(0xcb, ...new Uint8Array(buffer));
      }
    } else if (typeof value === 'boolean') {
      bytes.push(value ? 0xc3 : 0xc2);
    } else if (value === null) {
      bytes.push(0xc0);
    } else {
      throw new Error(`Unsupported value type: ${typeof value}`);
    }
  }
  return bytes;
}

function encodeFixarray(arr) {
  if (arr.length > 15) throw new Error('fixarray too large');
  const bytes = [0x90 | arr.length];
  for (const value of arr) {
    if (typeof value === 'string') {
      bytes.push(...encodeFixstr(value));
    } else if (typeof value === 'number') {
      if (Number.isInteger(value) && value >= 0 && value <= 127) {
        bytes.push(value);
      } else if (Number.isInteger(value) && value >= -32 && value < 0) {
        bytes.push(0xe0 | (value + 32));
      } else {
        const buffer = new ArrayBuffer(8);
        new DataView(buffer).setFloat64(0, value, false);
        bytes.push(0xcb, ...new Uint8Array(buffer));
      }
    } else if (typeof value === 'boolean') {
      bytes.push(value ? 0xc3 : 0xc2);
    } else if (value === null) {
      bytes.push(0xc0);
    } else {
      throw new Error(`Unsupported value type: ${typeof value}`);
    }
  }
  return bytes;
}

function encodeValue(value) {
  if (value === null) {
    return [0xc0];
  } else if (typeof value === 'boolean') {
    return [value ? 0xc3 : 0xc2];
  } else if (typeof value === 'string') {
    return encodeFixstr(value);
  } else if (typeof value === 'number') {
    if (Number.isInteger(value) && value >= 0 && value <= 127) {
      return [value];
    } else if (Number.isInteger(value) && value >= -32 && value < 0) {
      return [0xe0 | (value + 32)];
    } else {
      const buffer = new ArrayBuffer(8);
      new DataView(buffer).setFloat64(0, value, false);
      return [0xcb, ...new Uint8Array(buffer)];
    }
  } else if (Array.isArray(value)) {
    if (value.length > 15) throw new Error('fixarray too large');
    const bytes = [0x90 | value.length];
    for (const item of value) {
      bytes.push(...encodeValue(item));
    }
    return bytes;
  } else if (typeof value === 'object') {
    const entries = Object.entries(value);
    if (entries.length > 15) throw new Error('fixmap too large');
    const bytes = [0x80 | entries.length];
    for (const [key, val] of entries) {
      bytes.push(...encodeFixstr(key));
      bytes.push(...encodeValue(val));
    }
    return bytes;
  } else {
    throw new Error(`Unsupported value type: ${typeof value}`);
  }
}

async function runMsgpack(source, msgpackValue) {
  const session = await freshSession();

  parseAndSetup(session, 'let message = null;');
  session.run(0, 10000);

  const mem = session.mem;
  const dataPointer = writeMsgpackPayload(mem, msgpackValue);

  const scope = mem.getRootScope();
  const messageOffset = mem.internString('message');
  const valuePtr = mem.scopeLookup(scope, messageOffset);

  if (!valuePtr) {
    throw new Error('Failed to find message variable in scope');
  }

  mem.writeMsgpackRef(valuePtr, dataPointer, 0);

  parseAndSetup(session, source);
  const result = session.run(0, 10000);
  if (result.status === 'error') {
    throw new Error(`Runtime error: ${JSON.stringify(result.error)}`);
  }

  return { session, value: session.get(0, 'message') };
}

async function setupMsgpack(value) {
  const msgpack = encodeValue(value);
  const session = await freshSession();
  parseAndSetup(session, 'let message = null; let result = null;');
  session.run(0, 10000);
  const mem = session.mem;
  const dataPointer = writeMsgpackPayload(mem, msgpack);
  const scope = mem.getRootScope();
  const messageOffset = mem.internString('message');
  const valuePtr = mem.scopeLookup(scope, messageOffset);
  mem.writeMsgpackRef(valuePtr, dataPointer, 0);
  return session;
}

function assertClose(actual, expected, epsilon = 0.0001) {
  assert(Math.abs(actual - expected) <= epsilon, `Expected ${expected}, got ${actual}`);
}

function assertArrayEqual(actual, expected) {
  assert(Array.isArray(actual), `Expected array, got ${typeof actual}`);
  assertEquals(actual.length, expected.length);
  for (let i = 0; i < expected.length; i++) {
    assertEquals(actual[i], expected[i], `Element [${i}] mismatch`);
  }
}

// =============================================================================
// Scalar String Tests
// =============================================================================

Deno.test("MsgPack: scalar string - fixstr hello", async () => {
  const { value } = await runMsgpack('message', encodeFixstr('hello'));
  assertEquals(value, 'hello');
});

Deno.test("MsgPack: scalar string - empty fixstr", async () => {
  const { value } = await runMsgpack('message', encodeFixstr(''));
  assertEquals(value, '');
});

Deno.test("MsgPack: scalar string - str8", async () => {
  const { value } = await runMsgpack('message', encodeStr8('longer string value'));
  assertEquals(value, 'longer string value');
});

// =============================================================================
// Scalar Number Tests
// =============================================================================

Deno.test("MsgPack: scalar integer - positive fixint", async () => {
  const { value } = await runMsgpack('message', [42]);
  assertEquals(value, 42);
});

Deno.test("MsgPack: scalar integer - negative fixint -1", async () => {
  const { value } = await runMsgpack('message', [0xff]);
  assertEquals(value, -1);
});

Deno.test("MsgPack: scalar integer - negative fixint -10", async () => {
  const { value } = await runMsgpack('message', [0xf6]);
  assertEquals(value, -10);
});

Deno.test("MsgPack: scalar integer - uint8", async () => {
  const { value } = await runMsgpack('message', [0xcc, 200]);
  assertEquals(value, 200);
});

Deno.test("MsgPack: scalar integer - uint16", async () => {
  const { value } = await runMsgpack('message', [0xcd, 0x03, 0xe8]);
  assertEquals(value, 1000);
});

Deno.test("MsgPack: scalar integer - uint32", async () => {
  const { value } = await runMsgpack('message', [0xce, 0x00, 0x01, 0x86, 0xa0]);
  assertEquals(value, 100000);
});

Deno.test("MsgPack: scalar integer - int8", async () => {
  const { value } = await runMsgpack('message', [0xd0, 0x9c]);
  assertEquals(value, -100);
});

Deno.test("MsgPack: scalar integer - int16", async () => {
  const { value } = await runMsgpack('message', [0xd1, 0xfc, 0x18]);
  assertEquals(value, -1000);
});

Deno.test("MsgPack: scalar integer - int32", async () => {
  const { value } = await runMsgpack('message', [0xd2, 0xff, 0xfe, 0x79, 0x60]);
  assertEquals(value, -100000);
});

Deno.test("MsgPack: scalar float - float32", async () => {
  const buffer = new ArrayBuffer(4);
  new DataView(buffer).setFloat32(0, 3.14, false);
  const bytes = new Uint8Array(buffer);
  const { value } = await runMsgpack('message', [0xca, ...bytes]);
  assertClose(value, 3.14, 0.001);
});

Deno.test("MsgPack: scalar float - float64", async () => {
  const buffer = new ArrayBuffer(8);
  new DataView(buffer).setFloat64(0, 3.141592653589793, false);
  const bytes = new Uint8Array(buffer);
  const { value } = await runMsgpack('message', [0xcb, ...bytes]);
  assertClose(value, 3.141592653589793, 0.000000001);
});

// =============================================================================
// Scalar Bool/Null Tests
// =============================================================================

Deno.test("MsgPack: scalar null", async () => {
  const { value } = await runMsgpack('message', [0xc0]);
  assertEquals(value, null);
});

Deno.test("MsgPack: scalar bool - true", async () => {
  const { value } = await runMsgpack('message', [0xc3]);
  assertEquals(value, true);
});

Deno.test("MsgPack: scalar bool - false", async () => {
  const { value } = await runMsgpack('message', [0xc2]);
  assertEquals(value, false);
});

// =============================================================================
// Map Access Tests
// =============================================================================

Deno.test("MsgPack: flat map access - string property", async () => {
  const session = await setupMsgpack({ name: 'alice', age: 30 });
  parseAndSetup(session, 'message.name');
  session.run(0, 10000);
  assertEquals(session.get(0, 'message').name, 'alice');
});

Deno.test("MsgPack: flat map access - integer property", async () => {
  const session = await setupMsgpack({ name: 'bob', age: 25 });
  parseAndSetup(session, 'message.age');
  session.run(0, 10000);
  assertEquals(session.get(0, 'message').age, 25);
});

Deno.test("MsgPack: missing key returns undefined", async () => {
  const session = await setupMsgpack({ foo: 1 });
  parseAndSetup(session, 'result = message.bar');
  session.run(0, 10000);
  assertEquals(session.get(0, 'result'), undefined);
});

// =============================================================================
// Array Tests
// =============================================================================

Deno.test("MsgPack: array indexing - first element", async () => {
  const session = await setupMsgpack([10, 20, 30]);
  parseAndSetup(session, 'result = message[0]');
  session.run(0, 10000);
  assertEquals(session.get(0, 'result'), 10);
});

Deno.test("MsgPack: array indexing - middle element", async () => {
  const session = await setupMsgpack([10, 20, 30]);
  parseAndSetup(session, 'result = message[1]');
  session.run(0, 10000);
  assertEquals(session.get(0, 'result'), 20);
});

Deno.test("MsgPack: array indexing - last element", async () => {
  const session = await setupMsgpack([10, 20, 30]);
  parseAndSetup(session, 'result = message[2]');
  session.run(0, 10000);
  assertEquals(session.get(0, 'result'), 30);
});

Deno.test("MsgPack: array indexing - out of bounds returns undefined", async () => {
  const session = await setupMsgpack([1, 2]);
  parseAndSetup(session, 'result = message[99]');
  session.run(0, 10000);
  assertEquals(session.get(0, 'result'), undefined);
});

Deno.test("MsgPack: array length", async () => {
  const session = await setupMsgpack([1, 2, 3, 4, 5]);
  parseAndSetup(session, 'result = message.length');
  session.run(0, 10000);
  assertEquals(session.get(0, 'result'), 5);
});

// =============================================================================
// Nested Access Tests
// =============================================================================

Deno.test("MsgPack: nested map access - message.user.id", async () => {
  const session = await setupMsgpack({ user: { id: 123, name: 'bob' } });
  parseAndSetup(session, 'result = message.user.id');
  session.run(0, 10000);
  assertEquals(session.get(0, 'result'), 123);
});

Deno.test("MsgPack: nested map access - message.user.name", async () => {
  const session = await setupMsgpack({ user: { id: 123, name: 'bob' } });
  parseAndSetup(session, 'result = message.user.name');
  session.run(0, 10000);
  assertEquals(session.get(0, 'result'), 'bob');
});

Deno.test("MsgPack: nested array in map - message.items[0].id", async () => {
  const session = await setupMsgpack({ items: [{ id: 1 }, { id: 2 }] });
  parseAndSetup(session, 'result = message.items[0].id');
  session.run(0, 10000);
  assertEquals(session.get(0, 'result'), 1);
});

Deno.test("MsgPack: nested array in map - message.items[1].id", async () => {
  const session = await setupMsgpack({ items: [{ id: 1 }, { id: 2 }] });
  parseAndSetup(session, 'result = message.items[1].id');
  session.run(0, 10000);
  assertEquals(session.get(0, 'result'), 2);
});

Deno.test("MsgPack: deeply nested access - message.a.b.c.d", async () => {
  const session = await setupMsgpack({ a: { b: { c: { d: 'deep' } } } });
  parseAndSetup(session, 'result = message.a.b.c.d');
  session.run(0, 10000);
  assertEquals(session.get(0, 'result'), 'deep');
});

Deno.test("MsgPack: nested array of arrays - message[0][1]", async () => {
  const session = await setupMsgpack([[1, 2, 3], [4, 5, 6]]);
  parseAndSetup(session, 'result = message[0][1]');
  session.run(0, 10000);
  assertEquals(session.get(0, 'result'), 2);
});

Deno.test("MsgPack: nested missing key returns undefined", async () => {
  const session = await setupMsgpack({ user: { name: 'bob' } });
  parseAndSetup(session, 'result = message.user.missing');
  session.run(0, 10000);
  assertEquals(session.get(0, 'result'), undefined);
});

Deno.test("MsgPack: nested access with array length", async () => {
  const session = await setupMsgpack({ items: [1, 2, 3, 4] });
  parseAndSetup(session, 'result = message.items.length');
  session.run(0, 10000);
  assertEquals(session.get(0, 'result'), 4);
});

// =============================================================================
// Assignment Error Tests
// =============================================================================

Deno.test("MsgPack: assignment to msgpack property throws error", async () => {
  const session = await setupMsgpack({ x: 1 });
  parseAndSetup(session, 'message.x = 2');
  const err = assertThrows(() => session.run(0, 10000), UncaughtScriptError);
  assertEquals(err.scriptError.codeName, 'MSGPACK_READONLY');
});

Deno.test("MsgPack: assignment to nested msgpack property throws error", async () => {
  const session = await setupMsgpack({ user: { name: 'bob' } });
  parseAndSetup(session, 'message.user.name = "alice"');
  const err = assertThrows(() => session.run(0, 10000), UncaughtScriptError);
  assertEquals(err.scriptError.codeName, 'MSGPACK_READONLY');
});

Deno.test("MsgPack: assignment to msgpack array element throws error", async () => {
  const session = await setupMsgpack([1, 2, 3]);
  parseAndSetup(session, 'message[0] = 99');
  const err = assertThrows(() => session.run(0, 10000), UncaughtScriptError);
  assertEquals(err.scriptError.codeName, 'MSGPACK_READONLY');
});

// =============================================================================
// Array Method Tests
// =============================================================================

Deno.test("MsgPack: map method exists on msgpack array", async () => {
  const session = await setupMsgpack([1, 2, 3]);
  parseAndSetup(session, 'result = typeof message.map');
  session.run(0, 10000);
  assertEquals(session.get(0, 'result'), 'function');
});

Deno.test("MsgPack: map on msgpack array", async () => {
  const session = await setupMsgpack([1, 2, 3]);
  parseAndSetup(session, 'result = message.map(x => x * 2)');
  session.run(0, 10000);
  assertArrayEqual(session.get(0, 'result'), [2, 4, 6]);
});

Deno.test("MsgPack: map on msgpack array of objects", async () => {
  const session = await setupMsgpack([{ id: 1 }, { id: 2 }, { id: 3 }]);
  parseAndSetup(session, 'result = message.map(x => x.id)');
  session.run(0, 10000);
  assertArrayEqual(session.get(0, 'result'), [1, 2, 3]);
});

Deno.test("MsgPack: filter on msgpack array", async () => {
  const session = await setupMsgpack([1, 2, 3, 4, 5]);
  parseAndSetup(session, 'result = message.filter(x => x > 2)');
  session.run(0, 10000);
  assertArrayEqual(session.get(0, 'result'), [3, 4, 5]);
});

Deno.test("MsgPack: forEach on msgpack array", async () => {
  const session = await setupMsgpack([1, 2, 3]);
  parseAndSetup(session, 'let sum = 0; message.forEach(x => { sum = sum + x }); result = sum');
  session.run(0, 10000);
  assertEquals(session.get(0, 'result'), 6);
});

Deno.test("MsgPack: find on msgpack array", async () => {
  const session = await setupMsgpack([{ id: 1 }, { id: 2 }, { id: 3 }]);
  parseAndSetup(session, 'result = message.find(x => x.id === 2)');
  session.run(0, 10000);
  assertEquals(session.get(0, 'result').id, 2);
});

Deno.test("MsgPack: findIndex on msgpack array", async () => {
  const session = await setupMsgpack([{ id: 1 }, { id: 2 }, { id: 3 }]);
  parseAndSetup(session, 'result = message.findIndex(x => x.id === 2)');
  session.run(0, 10000);
  assertEquals(session.get(0, 'result'), 1);
});

Deno.test("MsgPack: some on msgpack array", async () => {
  const session = await setupMsgpack([1, 2, 3]);
  parseAndSetup(session, 'result = message.some(x => x > 2)');
  session.run(0, 10000);
  assertEquals(session.get(0, 'result'), true);
});

Deno.test("MsgPack: every on msgpack array", async () => {
  const session = await setupMsgpack([2, 4, 6]);
  parseAndSetup(session, 'result = message.every(x => x % 2 === 0)');
  session.run(0, 10000);
  assertEquals(session.get(0, 'result'), true);
});

Deno.test("MsgPack: reduce on msgpack array", async () => {
  const session = await setupMsgpack([1, 2, 3, 4]);
  parseAndSetup(session, 'result = message.reduce((acc, x) => acc + x, 0)');
  session.run(0, 10000);
  assertEquals(session.get(0, 'result'), 10);
});

Deno.test("MsgPack: indexOf on msgpack array", async () => {
  const session = await setupMsgpack([10, 20, 30]);
  parseAndSetup(session, 'result = message.indexOf(20)');
  session.run(0, 10000);
  assertEquals(session.get(0, 'result'), 1);
});

Deno.test("MsgPack: includes on msgpack array", async () => {
  const session = await setupMsgpack([10, 20, 30]);
  parseAndSetup(session, 'result = message.includes(20)');
  session.run(0, 10000);
  assertEquals(session.get(0, 'result'), true);
});

Deno.test("MsgPack: slice on msgpack array", async () => {
  const session = await setupMsgpack([1, 2, 3, 4, 5]);
  parseAndSetup(session, 'result = message.slice(1, 4)');
  session.run(0, 10000);
  assertArrayEqual(session.get(0, 'result'), [2, 3, 4]);
});

Deno.test("MsgPack: map on empty msgpack array", async () => {
  const session = await setupMsgpack([]);
  parseAndSetup(session, 'result = message.map(x => x * 2)');
  session.run(0, 10000);
  assertArrayEqual(session.get(0, 'result'), []);
});

Deno.test("MsgPack: chained operations on msgpack array", async () => {
  const session = await setupMsgpack([1, 2, 3, 4, 5]);
  parseAndSetup(session, 'result = message.filter(x => x > 2).map(x => x * 10)');
  session.run(0, 10000);
  assertArrayEqual(session.get(0, 'result'), [30, 40, 50]);
});

// =============================================================================
// Object Methods on MsgPack
// =============================================================================

Deno.test("MsgPack: Object.keys on msgpack map", async () => {
  const session = await setupMsgpack({ name: 'alice', age: 30 });
  parseAndSetup(session, 'result = Object.keys(message)');
  session.run(0, 10000);
  assertArrayEqual(session.get(0, 'result'), ['name', 'age']);
});

Deno.test("MsgPack: Object.keys on empty msgpack map", async () => {
  const session = await setupMsgpack({});
  parseAndSetup(session, 'result = Object.keys(message)');
  session.run(0, 10000);
  assertArrayEqual(session.get(0, 'result'), []);
});

Deno.test("MsgPack: Object.keys on msgpack array returns indices", async () => {
  const session = await setupMsgpack([10, 20, 30]);
  parseAndSetup(session, 'result = Object.keys(message)');
  session.run(0, 10000);
  assertArrayEqual(session.get(0, 'result'), ['0', '1', '2']);
});

Deno.test("MsgPack: Object.values on msgpack map", async () => {
  const session = await setupMsgpack({ name: 'alice', age: 30 });
  parseAndSetup(session, 'result = Object.values(message)');
  session.run(0, 10000);
  assertEquals(session.get(0, 'result')[0], 'alice');
  assertEquals(session.get(0, 'result')[1], 30);
});

Deno.test("MsgPack: Object.values on msgpack array", async () => {
  const session = await setupMsgpack([10, 20, 30]);
  parseAndSetup(session, 'result = Object.values(message)');
  session.run(0, 10000);
  assertArrayEqual(session.get(0, 'result'), [10, 20, 30]);
});

Deno.test("MsgPack: Object.entries on msgpack map", async () => {
  const session = await setupMsgpack({ x: 1, y: 2 });
  parseAndSetup(session, 'result = Object.entries(message)');
  session.run(0, 10000);
  const entries = session.get(0, 'result');
  assertEquals(entries.length, 2);
  assertEquals(entries[0][0], 'x');
  assertEquals(entries[0][1], 1);
  assertEquals(entries[1][0], 'y');
  assertEquals(entries[1][1], 2);
});

Deno.test("MsgPack: Object.assign clones msgpack map", async () => {
  const session = await setupMsgpack({ name: 'alice', age: 30 });
  parseAndSetup(session, 'result = Object.assign({}, message)');
  session.run(0, 10000);
  const clone = session.get(0, 'result');
  assertEquals(clone.name, 'alice');
  assertEquals(clone.age, 30);
});

Deno.test("MsgPack: Object.assign merges msgpack into existing object", async () => {
  const session = await setupMsgpack({ b: 2 });
  parseAndSetup(session, 'let target = { a: 1 }; Object.assign(target, message); result = target');
  session.run(0, 10000);
  const merged = session.get(0, 'result');
  assertEquals(merged.a, 1);
  assertEquals(merged.b, 2);
});

Deno.test("MsgPack: cloned msgpack object is mutable", async () => {
  const session = await setupMsgpack({ x: 1 });
  parseAndSetup(session, 'let clone = Object.assign({}, message); clone.x = 2; result = clone.x');
  session.run(0, 10000);
  assertEquals(session.get(0, 'result'), 2);
});

Deno.test("MsgPack: Object.keys on nested msgpack", async () => {
  const session = await setupMsgpack({ outer: { inner: 1 } });
  parseAndSetup(session, 'result = Object.keys(message.outer)');
  session.run(0, 10000);
  assertArrayEqual(session.get(0, 'result'), ['inner']);
});

Deno.test("MsgPack: Array.isArray on msgpack array returns true", async () => {
  const session = await setupMsgpack([1, 2, 3]);
  parseAndSetup(session, 'result = Array.isArray(message)');
  session.run(0, 10000);
  assertEquals(session.get(0, 'result'), true);
});

Deno.test("MsgPack: Array.isArray on msgpack map returns false", async () => {
  const session = await setupMsgpack({ a: 1 });
  parseAndSetup(session, 'result = Array.isArray(message)');
  session.run(0, 10000);
  assertEquals(session.get(0, 'result'), false);
});

Deno.test("MsgPack: Array.from on msgpack array clones to mutable array", async () => {
  const session = await setupMsgpack([1, 2, 3]);
  parseAndSetup(session, 'result = Array.from(message)');
  session.run(0, 10000);
  assertArrayEqual(session.get(0, 'result'), [1, 2, 3]);
});

Deno.test("MsgPack: Array.from clone is mutable", async () => {
  const session = await setupMsgpack([1, 2, 3]);
  parseAndSetup(session, 'let clone = Array.from(message); clone.push(4); result = clone');
  session.run(0, 10000);
  assertArrayEqual(session.get(0, 'result'), [1, 2, 3, 4]);
});

Deno.test("MsgPack: Array.from on msgpack map returns empty array", async () => {
  const session = await setupMsgpack({ a: 1 });
  parseAndSetup(session, 'result = Array.from(message)');
  session.run(0, 10000);
  assertArrayEqual(session.get(0, 'result'), []);
});

// ============================================================================
// MsgpackRef marshaling via airlock
// ============================================================================

// ============================================================================
// MsgpackRef marshaling via airlock
// ============================================================================

Deno.test('MsgpackRef: marshaled via setupCallbackContext', async () => {
  const { MsgpackRef } = await import('../../src/fuel/airlock.js');
  const session = await freshSession();

  parseAndSetup(session, `
    let result = null
    function handler(e) { result = e.data.name }
  `);
  session.run(0, 10000);

  const payload = new Uint8Array(encodeValue({ name: 'alice', age: 30 }));
  const dataPointer = session.airlock.allocateMsgpackBytes(payload);

  // Get closure pointer from the handler variable
  const handlerValue = session.get(0, 'handler');
  const handle = session.airlock.registerClosure(handlerValue._dataLo, 0);

  const slot = session.mem.allocateContext();
  session.airlock.setupCallbackContext(slot, handle, [{
    data: new MsgpackRef(dataPointer),
  }]);

  const runResult = session.run(slot, 10000);
  assertEquals(runResult.status, 'done');
  assertEquals(session.get(0, 'result'), 'alice');
});

Deno.test('MsgpackRef: nested property access in callback', async () => {
  const { MsgpackRef } = await import('../../src/fuel/airlock.js');
  const session = await freshSession();

  parseAndSetup(session, `
    let result = null
    function handler(e) { result = e.data.user.name }
  `);
  session.run(0, 10000);

  const payload = new Uint8Array(encodeValue({ user: { name: 'bob', id: 42 } }));
  const dataPointer = session.airlock.allocateMsgpackBytes(payload);

  const handlerValue = session.get(0, 'handler');
  const handle = session.airlock.registerClosure(handlerValue._dataLo, 0);

  const slot = session.mem.allocateContext();
  session.airlock.setupCallbackContext(slot, handle, [{
    data: new MsgpackRef(dataPointer),
  }]);

  const runResult = session.run(slot, 10000);
  assertEquals(runResult.status, 'done');
  assertEquals(session.get(0, 'result'), 'bob');
});

Deno.test('MsgpackRef: array access in callback', async () => {
  const { MsgpackRef } = await import('../../src/fuel/airlock.js');
  const session = await freshSession();

  parseAndSetup(session, `
    let result = null
    function handler(e) { result = e.data.items[1] }
  `);
  session.run(0, 10000);

  const payload = new Uint8Array(encodeValue({ items: ['a', 'b', 'c'] }));
  const dataPointer = session.airlock.allocateMsgpackBytes(payload);

  const handlerValue = session.get(0, 'handler');
  const handle = session.airlock.registerClosure(handlerValue._dataLo, 0);

  const slot = session.mem.allocateContext();
  session.airlock.setupCallbackContext(slot, handle, [{
    data: new MsgpackRef(dataPointer),
  }]);

  const runResult = session.run(slot, 10000);
  assertEquals(runResult.status, 'done');
  assertEquals(session.get(0, 'result'), 'b');
});

// =============================================================================
// Object spread / Object.assign of msgpack ARRAY refs. Array refs used to
// contribute nothing. Elements land under decimal string keys, mirroring the
// TYPE_ARRAY spread branch; nested containers become msgpack refs.
// =============================================================================

Deno.test("MsgPack: object spread of array ref yields indexed properties", async () => {
  const session = await setupMsgpack([10, 20, 30]);
  parseAndSetup(session, `
    let spread = {...message};
    result = spread["0"] + spread["1"] + spread["2"];
  `);
  const runResult = session.run(0, 10000);
  assertEquals(runResult.status, 'done');
  assertEquals(session.get(0, 'result'), 60);
});

Deno.test("MsgPack: Object.assign from array ref yields indexed properties", async () => {
  const session = await setupMsgpack(['a', 'b']);
  parseAndSetup(session, `
    let target = Object.assign({ keep: 1 }, message);
    result = target["0"] + target["1"] + target.keep;
  `);
  const runResult = session.run(0, 10000);
  assertEquals(runResult.status, 'done');
  assertEquals(session.get(0, 'result'), 'ab1');
});

Deno.test("MsgPack: object spread of array ref with nested container elements", async () => {
  const session = await setupMsgpack([{ x: 5 }, [7, 8]]);
  parseAndSetup(session, `
    let spread = {...message};
    result = spread["0"].x + spread["1"][1];
  `);
  const runResult = session.run(0, 10000);
  assertEquals(runResult.status, 'done');
  assertEquals(session.get(0, 'result'), 13);
});

Deno.test("MsgPack: object spread of empty array ref contributes nothing", async () => {
  const session = await setupMsgpack([]);
  parseAndSetup(session, `
    let spread = {...message};
    result = Object.keys(spread).length;
  `);
  const runResult = session.run(0, 10000);
  assertEquals(runResult.status, 'done');
  assertEquals(session.get(0, 'result'), 0);
});

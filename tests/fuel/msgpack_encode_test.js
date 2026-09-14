import { assertEquals, assert } from "https://deno.land/std@0.208.0/assert/mod.ts";
import { freshSession } from '../../src/host-owned-session.js';
import { TYPE } from '../../src/fuel/constants.js';
import { decode, encode } from '../../src/membrane/msgpack.js';

async function evalCode(code) {
  const session = await freshSession();
  session.parse(code);
  const runResult = session.run(0, 10000);
  if (runResult.status === 'error') {
    throw new Error(`Execution error: ${JSON.stringify(runResult.error)}`);
  }
  return session.get(0, 'result');
}

async function evalWithBytes(code, bytes) {
  const session = await freshSession();
  const mem = session.memoryImage;
  const bufPtr = mem.allocateArrayBuffer(bytes.length);
  const absBytes = mem.abs(bufPtr + 4);
  const u8 = new Uint8Array(mem.memory.buffer);
  for (let i = 0; i < bytes.length; i++) {
    u8[absBytes + i] = bytes[i];
  }
  const descriptorPtr = mem.allocateTypedArrayDescriptor(bufPtr, 0, bytes.length);
  const globalScope = mem.getContextScope(0);
  mem.scopeSetRaw(globalScope, mem.internString('input'), TYPE.UINT8ARRAY, descriptorPtr, 0);
  session.parse(code);
  const runResult = session.run(0, 10000);
  if (runResult.status === 'error') {
    throw new Error(`Execution error: ${JSON.stringify(runResult.error)}`);
  }
  return session.get(0, 'result');
}

Deno.test("msgpack.encode: null", async () => {
  const bytes = await evalCode('let result = msgpack.encode(null)');
  assertEquals(decode(bytes), null);
});

Deno.test("msgpack.encode: undefined → nil", async () => {
  const bytes = await evalCode('let result = msgpack.encode(undefined)');
  assertEquals(decode(bytes), null);
});

Deno.test("msgpack.encode: true", async () => {
  const bytes = await evalCode('let result = msgpack.encode(true)');
  assertEquals(decode(bytes), true);
});

Deno.test("msgpack.encode: false", async () => {
  const bytes = await evalCode('let result = msgpack.encode(false)');
  assertEquals(decode(bytes), false);
});

Deno.test("msgpack.encode: positive fixint (42)", async () => {
  const bytes = await evalCode('let result = msgpack.encode(42)');
  assertEquals(decode(bytes), 42);
  assertEquals(bytes.length, 1);
});

Deno.test("msgpack.encode: zero", async () => {
  const bytes = await evalCode('let result = msgpack.encode(0)');
  assertEquals(decode(bytes), 0);
  assertEquals(bytes.length, 1);
});

Deno.test("msgpack.encode: negative fixint (-1)", async () => {
  const bytes = await evalCode('let result = msgpack.encode(-1)');
  assertEquals(decode(bytes), -1);
  assertEquals(bytes.length, 1);
});

Deno.test("msgpack.encode: negative fixint (-32)", async () => {
  const bytes = await evalCode('let result = msgpack.encode(-32)');
  assertEquals(decode(bytes), -32);
  assertEquals(bytes.length, 1);
});

Deno.test("msgpack.encode: uint8 (200)", async () => {
  const bytes = await evalCode('let result = msgpack.encode(200)');
  assertEquals(decode(bytes), 200);
  assertEquals(bytes.length, 2);
});

Deno.test("msgpack.encode: int8 (-100)", async () => {
  const bytes = await evalCode('let result = msgpack.encode(-100)');
  assertEquals(decode(bytes), -100);
  assertEquals(bytes.length, 2);
});

Deno.test("msgpack.encode: uint16 (1000)", async () => {
  const bytes = await evalCode('let result = msgpack.encode(1000)');
  assertEquals(decode(bytes), 1000);
  assertEquals(bytes.length, 3);
});

Deno.test("msgpack.encode: int16 (-1000)", async () => {
  const bytes = await evalCode('let result = msgpack.encode(-1000)');
  assertEquals(decode(bytes), -1000);
  assertEquals(bytes.length, 3);
});

Deno.test("msgpack.encode: uint32 (100000)", async () => {
  const bytes = await evalCode('let result = msgpack.encode(100000)');
  assertEquals(decode(bytes), 100000);
  assertEquals(bytes.length, 5);
});

Deno.test("msgpack.encode: int32 (-100000)", async () => {
  const bytes = await evalCode('let result = msgpack.encode(-100000)');
  assertEquals(decode(bytes), -100000);
  assertEquals(bytes.length, 5);
});

Deno.test("msgpack.encode: float (3.14)", async () => {
  const bytes = await evalCode('let result = msgpack.encode(3.14)');
  assertEquals(decode(bytes), 3.14);
  assertEquals(bytes[0], 0xcb);
});

Deno.test("msgpack.encode: empty string", async () => {
  const bytes = await evalCode('let result = msgpack.encode("")');
  assertEquals(decode(bytes), '');
  assertEquals(bytes.length, 1);
});

Deno.test("msgpack.encode: short string (fixstr)", async () => {
  const bytes = await evalCode('let result = msgpack.encode("hello")');
  assertEquals(decode(bytes), 'hello');
  assertEquals(bytes[0], 0xa0 | 5);
});

Deno.test("msgpack.encode: empty array", async () => {
  const bytes = await evalCode('let result = msgpack.encode([])');
  const decoded = decode(bytes);
  assert(Array.isArray(decoded));
  assertEquals(decoded.length, 0);
});

Deno.test("msgpack.encode: array of ints", async () => {
  const bytes = await evalCode('let result = msgpack.encode([1, 2, 3])');
  assertEquals(decode(bytes), [1, 2, 3]);
});

Deno.test("msgpack.encode: nested array", async () => {
  const bytes = await evalCode('let result = msgpack.encode([1, [2, 3]])');
  assertEquals(decode(bytes), [1, [2, 3]]);
});

Deno.test("msgpack.encode: empty object", async () => {
  const bytes = await evalCode('let result = msgpack.encode({})');
  const decoded = decode(bytes);
  assertEquals(typeof decoded, 'object');
  assertEquals(Object.keys(decoded).length, 0);
});

Deno.test("msgpack.encode: simple object", async () => {
  const bytes = await evalCode('let result = msgpack.encode({a: 1, b: "two"})');
  const decoded = decode(bytes);
  assertEquals(decoded.a, 1);
  assertEquals(decoded.b, 'two');
});

Deno.test("msgpack.encode: nested object", async () => {
  const bytes = await evalCode('let result = msgpack.encode({x: {y: 42}})');
  const decoded = decode(bytes);
  assertEquals(decoded.x.y, 42);
});

Deno.test("msgpack.encode: object skips functions", async () => {
  const bytes = await evalCode('let o = {a: 1, b: function() {}}; let result = msgpack.encode(o)');
  const decoded = decode(bytes);
  assertEquals(decoded.a, 1);
  assertEquals(decoded.b, undefined);
});

Deno.test("msgpack.encode: Uint8Array → bin format", async () => {
  const bytes = await evalCode('let result = msgpack.encode(new Uint8Array([1, 2, 3]))');
  const decoded = decode(bytes);
  assert(decoded instanceof Uint8Array);
  assertEquals(decoded, new Uint8Array([1, 2, 3]));
});

Deno.test("msgpack.encode: round-trip via msgpack.decode", async () => {
  const result = await evalCode(`
    let encoded = msgpack.encode({name: "test", values: [1, 2, 3], flag: true})
    let decoded = msgpack.decode(encoded)
    let result = decoded.name + ":" + decoded.values.length + ":" + decoded.flag
  `);
  assertEquals(result, 'test:3:true');
});

Deno.test("JSON.stringify of decoded nested containers matches the original", async () => {
  // Containers nested inside arrays stay TYPE_MSGPACK_REF after decode.
  // json_stringify_value used to send them through its unknown-type null
  // catch-all; the REF branch now materializes and recurses, preserving the
  // exact round-trip.
  const result = await evalCode(`
    let original = { a: [ { x: 42 }, [7, 8], "s" ], b: { c: [ { d: 1 } ] } }
    let decoded = msgpack.decode(msgpack.encode(original))
    let result = JSON.stringify(decoded) === JSON.stringify(original)
  `);
  assertEquals(result, true);
});

Deno.test("JSON.stringify of a decoded ref value directly", async () => {
  const result = await evalCode(`
    let decoded = msgpack.decode(msgpack.encode({ a: [ { x: 42 } ] }))
    let result = JSON.stringify(decoded.a[0])
  `);
  assertEquals(result, '{"x":42}');
});

Deno.test("msgpack.decode: null from external bytes", async () => {
  const result = await evalWithBytes('let result = msgpack.decode(input)', encode(null));
  assertEquals(result, null);
});

Deno.test("msgpack.decode: boolean from external bytes", async () => {
  assertEquals(await evalWithBytes('let result = msgpack.decode(input)', encode(true)), true);
  assertEquals(await evalWithBytes('let result = msgpack.decode(input)', encode(false)), false);
});

Deno.test("msgpack.decode: integers from external bytes", async () => {
  assertEquals(await evalWithBytes('let result = msgpack.decode(input)', encode(0)), 0);
  assertEquals(await evalWithBytes('let result = msgpack.decode(input)', encode(42)), 42);
  assertEquals(await evalWithBytes('let result = msgpack.decode(input)', encode(-1)), -1);
  assertEquals(await evalWithBytes('let result = msgpack.decode(input)', encode(200)), 200);
  assertEquals(await evalWithBytes('let result = msgpack.decode(input)', encode(-100)), -100);
  assertEquals(await evalWithBytes('let result = msgpack.decode(input)', encode(50000)), 50000);
  assertEquals(await evalWithBytes('let result = msgpack.decode(input)', encode(-50000)), -50000);
  assertEquals(await evalWithBytes('let result = msgpack.decode(input)', encode(100000)), 100000);
});

Deno.test("msgpack.decode: float from external bytes", async () => {
  const result = await evalWithBytes('let result = msgpack.decode(input)', encode(3.14));
  assertEquals(result, 3.14);
});

Deno.test("msgpack.decode: string from external bytes", async () => {
  assertEquals(await evalWithBytes('let result = msgpack.decode(input)', encode('hello')), 'hello');
  assertEquals(await evalWithBytes('let result = msgpack.decode(input)', encode('')), '');
  assertEquals(await evalWithBytes('let result = msgpack.decode(input)', encode('a longer string that exceeds fixstr')), 'a longer string that exceeds fixstr');
});

Deno.test("msgpack.decode: array from external bytes", async () => {
  const result = await evalWithBytes(
    'let arr = msgpack.decode(input); let result = arr[0] + arr[1] + arr[2]',
    encode([10, 20, 30]));
  assertEquals(result, 60);
});

Deno.test("msgpack.decode: nested object from external bytes", async () => {
  const result = await evalWithBytes(
    'let obj = msgpack.decode(input); let result = obj.name + ":" + obj.nested.x',
    encode({ name: 'test', nested: { x: 42 } }));
  assertEquals(result, 'test:42');
});

Deno.test("msgpack.decode: array", async () => {
  const result = await evalCode(`
    let result = msgpack.decode(msgpack.encode([10, 20, 30]))
    result = result[0] + result[1] + result[2]
  `);
  assertEquals(result, 60);
});

Deno.test("msgpack.decode: object", async () => {
  const result = await evalCode(`
    let obj = msgpack.decode(msgpack.encode({x: 1, y: 2}))
    let result = obj.x + obj.y
  `);
  assertEquals(result, 3);
});

Deno.test("msgpack.encode: max positive fixint (127)", async () => {
  const bytes = await evalCode('let result = msgpack.encode(127)');
  assertEquals(decode(bytes), 127);
  assertEquals(bytes.length, 1);
});

Deno.test("msgpack.encode: boundary uint8 (128)", async () => {
  const bytes = await evalCode('let result = msgpack.encode(128)');
  assertEquals(decode(bytes), 128);
  assertEquals(bytes.length, 2);
  assertEquals(bytes[0], 0xcc);
});

Deno.test("msgpack.encode: boundary uint8 (255)", async () => {
  const bytes = await evalCode('let result = msgpack.encode(255)');
  assertEquals(decode(bytes), 255);
  assertEquals(bytes.length, 2);
});

Deno.test("msgpack.encode: boundary uint16 (256)", async () => {
  const bytes = await evalCode('let result = msgpack.encode(256)');
  assertEquals(decode(bytes), 256);
  assertEquals(bytes.length, 3);
  assertEquals(bytes[0], 0xcd);
});

Deno.test("msgpack.encode: boundary int8 (-33)", async () => {
  const bytes = await evalCode('let result = msgpack.encode(-33)');
  assertEquals(decode(bytes), -33);
  assertEquals(bytes.length, 2);
  assertEquals(bytes[0], 0xd0);
});

Deno.test("msgpack.encode: boundary int8 (-128)", async () => {
  const bytes = await evalCode('let result = msgpack.encode(-128)');
  assertEquals(decode(bytes), -128);
  assertEquals(bytes.length, 2);
});

Deno.test("msgpack.encode: boundary int16 (-129)", async () => {
  const bytes = await evalCode('let result = msgpack.encode(-129)');
  assertEquals(decode(bytes), -129);
  assertEquals(bytes.length, 3);
  assertEquals(bytes[0], 0xd1);
});

Deno.test("msgpack.encode: bare function throws TypeError", async () => {
  const result = await evalCode(`
    let caught = false
    function f() {}
    try { msgpack.encode(f) } catch(e) { caught = true }
    let result = caught
  `);
  assertEquals(result, true);
});

Deno.test("msgpack.encode: circular object reference throws TypeError", async () => {
  const result = await evalCode(`
    let caught = false
    try {
      let o = {}
      o.self = o
      msgpack.encode(o)
    } catch(e) { caught = true }
    let result = caught
  `);
  assertEquals(result, true);
});

Deno.test("msgpack.encode: circular array reference throws TypeError", async () => {
  const result = await evalCode(`
    let caught = false
    try {
      let a = []
      a.push(a)
      msgpack.encode(a)
    } catch(e) { caught = true }
    let result = caught
  `);
  assertEquals(result, true);
});

Deno.test("msgpack.encode: bigint beyond i64 throws TypeError", async () => {
  const result = await evalCode(`
    let caught = false
    try {
      let big = 99999999999999999999999999999999n
      msgpack.encode(big)
    } catch(e) { caught = true }
    let result = caught
  `);
  assertEquals(result, true);
});

Deno.test("msgpack.encode: bare symbol throws TypeError", async () => {
  const result = await evalCode(`
    let caught = false
    try {
      let s = Symbol('x')
      msgpack.encode(s)
    } catch(e) { caught = true }
    let result = caught
  `);
  assertEquals(result, true);
});

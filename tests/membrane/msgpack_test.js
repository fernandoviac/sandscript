/**
 * Local msgpack encode/decode test suite (src/membrane/msgpack.js).
 *
 * Run with: deno task test tests/membrane/msgpack_test.js
 *
 * This module replaced an external CDN import; these tests pin exact
 * round-trip behavior for the value space the membrane's value arena
 * and runtime/serialize-error.js actually rely on — plain JSON-shaped
 * data, Uint8Array, and BigInt (via the ext-type extension).
 */

import { assertEquals, assert, assertThrows } from "https://deno.land/std@0.208.0/assert/mod.ts";
import { encode, decode } from '../../src/membrane/msgpack.js';

function roundTrip(value) {
  return decode(encode(value));
}

Deno.test("msgpack: null and undefined both decode to null", () => {
  assertEquals(roundTrip(null), null);
  assertEquals(roundTrip(undefined), null);
});

Deno.test("msgpack: booleans", () => {
  assertEquals(roundTrip(true), true);
  assertEquals(roundTrip(false), false);
});

Deno.test("msgpack: small positive and negative integers (fixint range)", () => {
  assertEquals(roundTrip(0), 0);
  assertEquals(roundTrip(127), 127);
  assertEquals(roundTrip(-1), -1);
  assertEquals(roundTrip(-32), -32);
});

Deno.test("msgpack: integers crossing uint8/16/32 boundaries", () => {
  assertEquals(roundTrip(128), 128);
  assertEquals(roundTrip(255), 255);
  assertEquals(roundTrip(256), 256);
  assertEquals(roundTrip(65535), 65535);
  assertEquals(roundTrip(65536), 65536);
  assertEquals(roundTrip(4294967295), 4294967295);
});

Deno.test("msgpack: integers crossing int8/16/32 boundaries (negative)", () => {
  assertEquals(roundTrip(-33), -33);
  assertEquals(roundTrip(-128), -128);
  assertEquals(roundTrip(-129), -129);
  assertEquals(roundTrip(-32768), -32768);
  assertEquals(roundTrip(-32769), -32769);
  assertEquals(roundTrip(-2147483648), -2147483648);
});

Deno.test("msgpack: floats", () => {
  assertEquals(roundTrip(1.5), 1.5);
  assertEquals(roundTrip(-3.25), -3.25);
});

Deno.test("msgpack: strings across fixstr/str8/str16 boundaries", () => {
  assertEquals(roundTrip(""), "");
  assertEquals(roundTrip("hello"), "hello");
  assertEquals(roundTrip("x".repeat(31)), "x".repeat(31));   // fixstr max
  assertEquals(roundTrip("x".repeat(32)), "x".repeat(32));   // str8
  assertEquals(roundTrip("x".repeat(255)), "x".repeat(255));
  assertEquals(roundTrip("x".repeat(256)), "x".repeat(256)); // str16
});

Deno.test("msgpack: arrays, including nested", () => {
  assertEquals(roundTrip([]), []);
  assertEquals(roundTrip([1, 2, 3]), [1, 2, 3]);
  assertEquals(roundTrip([1, [2, 3], { a: 4 }]), [1, [2, 3], { a: 4 }]);
});

Deno.test("msgpack: plain objects, including nested", () => {
  assertEquals(roundTrip({}), {});
  assertEquals(roundTrip({ a: 1, b: 2 }), { a: 1, b: 2 });
  assertEquals(
    roundTrip({ callIdToSlot: { "abc": 3, "xyz": 7 }, generation: 12 }),
    { callIdToSlot: { "abc": 3, "xyz": 7 }, generation: 12 },
  );
});

Deno.test("msgpack: Uint8Array survives as bin", () => {
  const bytes = new Uint8Array([1, 2, 3, 255, 0]);
  const result = roundTrip(bytes);
  assert(result instanceof Uint8Array);
  assertEquals(Array.from(result), [1, 2, 3, 255, 0]);
});

Deno.test("msgpack: BigInt survives via ext type, including values beyond Number range", () => {
  assertEquals(roundTrip(0n), 0n);
  assertEquals(roundTrip(9_999_999_999_999_999n), 9_999_999_999_999_999n);
  assertEquals(roundTrip(-9_999_999_999_999_999n), -9_999_999_999_999_999n);
  // Genuinely beyond Number.MAX_SAFE_INTEGER and beyond 64 bits.
  const huge = 123456789012345678901234567890n;
  assertEquals(roundTrip(huge), huge);
});

Deno.test("msgpack: encode throws on unsupported types (functions, symbols)", () => {
  assertThrows(() => encode(() => {}), TypeError);
  assertThrows(() => encode(Symbol('x')), TypeError);
});

Deno.test("msgpack: mixed nested structure with all supported types", () => {
  const value = {
    name: "test",
    count: 42,
    big: 99999999999999999999n,
    bytes: new Uint8Array([9, 8, 7]),
    nested: { list: [1, "two", null, true, false] },
  };
  const result = roundTrip(value);
  assertEquals(result.name, "test");
  assertEquals(result.count, 42);
  assertEquals(result.big, 99999999999999999999n);
  assert(result.bytes instanceof Uint8Array);
  assertEquals(Array.from(result.bytes), [9, 8, 7]);
  assertEquals(result.nested, { list: [1, "two", null, true, false] });
});

/**
 * MessagePack bin decoding and ref-access coverage for a receiver that
 * previously trapped with `memory access out of bounds`:
 *
 * 1. The encoder emits bin8/16/32 for Uint8Array, but the decoder's
 *    $msgpack_peek_type REJECTED those byte codes — reading any
 *    bin-valued field raised ERR_MSGPACK_INVALID (surfaced as
 *    "Unknown error"). Bin now decodes as a real Uint8Array at every
 *    read site (decode materializers, GET_PROP, GET_INDEX, GET_VAR)
 *    and never becomes a TYPE_MSGPACK_REF.
 *
 * 2. INSTANCEOF on a TYPE_MSGPACK_REF fell through to the generic
 *    object prototype-chain walk, which dereferenced the ref's
 *    parent-blob data pointer as an object header: data-dependent
 *    garbage — a wrong answer when the walk stayed in bounds, a raw
 *    WASM trap when it didn't. Refs now answer by their decoded
 *    shape: array refs like arrays, map refs like plain objects.
 *
 * 3. GET_INDEX on a MAP ref always took the array path (key coerced
 *    to a number, msgpack_array_get returns -1, undefined pushed) —
 *    so `ref[key]` returned undefined for every key even though
 *    Object.keys(ref) listed them, silently emptying jsonSafe-style
 *    walks (out[k] = value[k] over Object.keys). Map refs now route
 *    bracket access through the same key lookup as dot access.
 */

import { assertEquals, assert } from "https://deno.land/std@0.208.0/assert/mod.ts";
import { freshSession } from '../../src/host-owned-session.js';

function runToDone(session) {
  let result = session.run(0, 50_000_000);
  while (result.status === 'memory_pressure') {
    session.gc();
    result = session.run(0, 50_000_000);
  }
  return result;
}

Deno.test('bin round-trips through encode/decode as a real Uint8Array', () => {
  const session = freshSession();
  session.parse(`
    let decoded = msgpack.decode(msgpack.encode({ bin: Uint8Array.of(7, 8, 9) }))
    let isU8 = decoded.bin instanceof Uint8Array
    let len = decoded.bin.length
    let first = decoded.bin[0]
    let last = decoded.bin[2]
  `);
  assertEquals(runToDone(session).status, 'done');
  assertEquals(session.get(0, 'isU8'), true);
  assertEquals(session.get(0, 'len'), 3);
  assertEquals(session.get(0, 'first'), 7);
  assertEquals(session.get(0, 'last'), 9);
});

Deno.test('bin nested inside arrays and maps decodes at every access path', () => {
  const session = freshSession();
  session.parse(`
    let bin = Uint8Array.of(1, 2, 3, 4, 5)
    let decoded = msgpack.decode(msgpack.encode({
      list: [bin, { inner: bin }],
      deep: { holder: bin }
    }))
    let fromArray = decoded.list[0].length
    let fromMapRef = decoded.list[1].inner.length
    let fromDeep = decoded.deep.holder.length
  `);
  assertEquals(runToDone(session).status, 'done');
  assertEquals(session.get(0, 'fromArray'), 5);
  assertEquals(session.get(0, 'fromMapRef'), 5);
  assertEquals(session.get(0, 'fromDeep'), 5);
});

Deno.test('bin larger than 255 bytes (bin16) round-trips', () => {
  const session = freshSession();
  session.parse(`
    let big = new Uint8Array(1000)
    big[0] = 11
    big[999] = 22
    let decoded = msgpack.decode(msgpack.encode({ big: big }))
    let len = decoded.big.length
    let first = decoded.big[0]
    let last = decoded.big[999]
  `);
  assertEquals(runToDone(session).status, 'done');
  assertEquals(session.get(0, 'len'), 1000);
  assertEquals(session.get(0, 'first'), 11);
  assertEquals(session.get(0, 'last'), 22);
});

Deno.test('instanceof on msgpack refs answers by decoded shape, never traps', () => {
  const session = freshSession();
  session.parse(`
    let decoded = msgpack.decode(msgpack.encode({
      list: [{ n: 1 }, [2, 3]]
    }))
    let mapRef = decoded.list[0]
    let arrayRef = decoded.list[1]
    let mapIsU8 = mapRef instanceof Uint8Array
    let mapIsArray = mapRef instanceof Array
    let mapIsObject = mapRef instanceof Object
    let arrayIsArray = arrayRef instanceof Array
    let arrayIsU8 = arrayRef instanceof Uint8Array
    let arrayIsObject = arrayRef instanceof Object
  `);
  assertEquals(runToDone(session).status, 'done');
  assertEquals(session.get(0, 'mapIsU8'), false);
  assertEquals(session.get(0, 'mapIsArray'), false);
  assertEquals(session.get(0, 'mapIsObject'), true);
  assertEquals(session.get(0, 'arrayIsArray'), true);
  assertEquals(session.get(0, 'arrayIsU8'), false);
  assertEquals(session.get(0, 'arrayIsObject'), true);
});

Deno.test('bracket access on a map ref is a key lookup, matching dot access', () => {
  const session = freshSession();
  session.parse(`
    let decoded = msgpack.decode(msgpack.encode({ list: [{ n: 7, s: "x" }] }))
    let ref = decoded.list[0]
    let viaBracket = ref["n"]
    let viaDot = ref.n
    let viaKeysWalk = ref[Object.keys(ref)[0]]
    let missing = ref["nope"]
  `);
  assertEquals(runToDone(session).status, 'done');
  assertEquals(session.get(0, 'viaBracket'), 7);
  assertEquals(session.get(0, 'viaDot'), 7);
  assertEquals(session.get(0, 'viaKeysWalk'), 7);
  assertEquals(session.get(0, 'missing'), undefined);
});

Deno.test('non-string keys on a map ref coerce to their string form', () => {
  const session = freshSession();
  session.parse(`
    let decoded = msgpack.decode(msgpack.encode({ list: [{ "0": "zero" }] }))
    let ref = decoded.list[0]
    let viaNumber = ref[0]
  `);
  assertEquals(runToDone(session).status, 'done');
  assertEquals(session.get(0, 'viaNumber'), 'zero');
});

Deno.test('the observer jsonSafe recursion reproduces the full decoded tree', () => {
  // A topology-style recursive conversion must traverse decoded maps, arrays,
  // and binary values. Before the fix it either trapped on `instanceof` over a
  // ref or silently replaced every nested map with `{}`.
  const session = freshSession();
  session.parse(`
    let jsonSafe = (value) => {
      if (value instanceof Uint8Array) { return { __bytesLength: value.length } }
      if (Array.isArray(value)) {
        let out = []
        let i = 0
        while (i < value.length) { out.push(jsonSafe(value[i])); i = i + 1 }
        return out
      }
      if (value !== null && typeof value === "object") {
        let out = {}
        let keys = Object.keys(value)
        let i = 0
        while (i < keys.length) { out[keys[i]] = jsonSafe(value[keys[i]]); i = i + 1 }
        return out
      }
      return value
    }
    let bin = Uint8Array.of(1, 2, 3, 4, 5)
    let payload = {
      meta: { author: "abcdef", tags: ["x", "y"], nested: { deep: { deeper: 42 } } },
      bin: bin,
      list: [{ n: 1, b: bin }, { n: 2 }, [3, [4, { z: bin }]]],
      num: 12,
      s: "hello"
    }
    let summary = JSON.stringify(jsonSafe(msgpack.decode(msgpack.encode(payload))))
  `);
  assertEquals(runToDone(session).status, 'done');
  assertEquals(
    session.get(0, 'summary'),
    '{"meta":{"author":"abcdef","tags":["x","y"],"nested":{"deep":{"deeper":42}}},'
    + '"bin":{"__bytesLength":5},'
    + '"list":[{"n":1,"b":{"__bytesLength":5}},{"n":2},[3,[4,{"z":{"__bytesLength":5}}]]],'
    + '"num":12,"s":"hello"}');
});

Deno.test('JS-side session.get reads bin values out of a stored ref tree', () => {
  // memory-reader's unmarshalMsgpack lacked bin arms too — and its
  // unsupported-type fallback advanced ONE byte, desyncing every
  // sibling after a bin in the same container.
  const session = freshSession();
  session.parse(`
    let decoded = msgpack.decode(msgpack.encode({
      list: [{ before: 1, bin: Uint8Array.of(9, 9, 9), after: 2 }]
    }))
    let keep = decoded.list[0]
  `);
  assertEquals(runToDone(session).status, 'done');
  const keep = session.get(0, 'keep');
  assertEquals(keep.before, 1);
  assert(keep.bin instanceof Uint8Array, 'bin field must unmarshal as Uint8Array');
  assertEquals(Array.from(keep.bin), [9, 9, 9]);
  assertEquals(keep.after, 2, 'sibling AFTER the bin must not desync');
});

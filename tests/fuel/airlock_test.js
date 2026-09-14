/**
 * Airlock test suite.
 *
 * Run with: deno task test tests/fuel/airlock_test.js
 */

import { assertEquals, assert } from "https://deno.land/std@0.208.0/assert/mod.ts";
import { Handle, isHandle } from '../../src/fuel/airlock.js';
import { TYPE } from '../../src/fuel/index.js';
import { freshSession } from '../../src/host-owned-session.js';

function createTestContext() {
  const session = freshSession();
  return { memoryImage: session.memoryImage, wasm: session.airlock.wasm, airlock: session.airlock };
}

function createAirlock() {
  return freshSession().airlock;
}

// =============================================================================
// Basic Registration
// =============================================================================

Deno.test("Airlock: register() returns a Handle wrapper", () => {
  const airlock = createAirlock();

  const handle = airlock.register({ name: 'test' });

  assert(isHandle(handle));
  assertEquals(handle.slot, 0);
});

Deno.test("Airlock: register() bumps slot for each call", () => {
  const airlock = createAirlock();

  const h1 = airlock.register({ name: 'first' });
  const h2 = airlock.register({ name: 'second' });

  assertEquals(h1.slot, 0);
  assertEquals(h2.slot, 1);
});

Deno.test("Airlock: lookup() returns registered object", () => {
  const airlock = createAirlock();
  const obj = { name: 'test' };

  const handle = airlock.register(obj);

  assertEquals(airlock.lookup(handle), obj);
});

// =============================================================================
// Handler Registration
// =============================================================================

Deno.test("Airlock: setHandler() registers handler", () => {
  const airlock = createAirlock();
  const handle = airlock.register({});

  airlock.setHandler(handle, 'test', () => 42);

  assert(airlock.handlers.has(`${handle.slot}:test`));
});

Deno.test("Airlock: setHandlers() registers multiple handlers", () => {
  const airlock = createAirlock();
  const handle = airlock.register({});

  airlock.setHandlers(handle, {
    add: ({ args }) => args[0] + args[1],
    multiply: ({ args }) => args[0] * args[1],
  });

  assert(airlock.handlers.has(`${handle.slot}:add`));
  assert(airlock.handlers.has(`${handle.slot}:multiply`));
});

// =============================================================================
// Handle wrapper
// =============================================================================

Deno.test("Handle: stores slot and version", () => {
  const h = new Handle(42, 3);
  assertEquals(h.slot, 42);
  assertEquals(h.version, 3);
  assert(isHandle(h));
});

// =============================================================================
// Marshalling Options
// =============================================================================

Deno.test("Airlock: marshallingOptions().marshal is undefined (detectors handle wrappers)", () => {
  // Wrapper-type detection (External, MsgpackRef, Promise) moved from
  // marshallingOptions().marshal into the global detector chain registered
  // on MemoryImage at airlock init. The .marshal callback is intentionally
  // left as undefined; callers that pass these options to writeValueAt
  // will skip the per-call override and fall through to the detector chain
  // (and then generic marshalling).
  const airlock = createAirlock();
  const options = airlock.marshallingOptions();

  assertEquals(options.marshal, undefined);
});

Deno.test("Airlock: detector chain handles External", () => {
  // The behavior previously asserted via marshallingOptions().marshal now
  // happens inside writeValueAt via the airlock's registered detector chain.
  const airlock = createAirlock();
  const detectors = airlock.memoryImage._marshalDetectors;
  // First detector is the Handle one (registered first in the airlock ctor).
  // The detector carries the handle's VERSION in dataHi so dispatch can
  // reject a stale handle value.
  const result = detectors[0](new Handle(5, 1));
  assertEquals(result, { type: TYPE.EXTERNAL, dataLo: 5, dataHi: 1 });

  // Detector returns undefined for unrelated values.
  assertEquals(detectors[0](42), undefined);
  assertEquals(detectors[0]("hello"), undefined);
  assertEquals(detectors[0]({ x: 1 }), undefined);
});

Deno.test("Airlock: marshallingOptions().unmarshal handles TYPE_EXTERNAL", () => {
  const airlock = createAirlock();
  // Allocate slots 0..7 so slot 7 is live for unmarshalling.
  for (let i = 0; i <= 7; i++) airlock.register({ i });
  const options = airlock.marshallingOptions();

  const result = options.unmarshal(TYPE.EXTERNAL, 7, 0);

  assert(isHandle(result));
  assertEquals(result.slot, 7);
});

Deno.test("Airlock: marshallingOptions().unmarshal returns undefined for other types", () => {
  const airlock = createAirlock();
  const options = airlock.marshallingOptions();

  assertEquals(options.unmarshal(TYPE.STRING, 100, 0), undefined);
  assertEquals(options.unmarshal(TYPE.FLOAT, 0, 0), undefined);
});

// =============================================================================
// Declare External
// =============================================================================

Deno.test("Airlock: declare() makes handle accessible in scope", () => {
  const { memoryImage, wasm, airlock } = createTestContext();

  const obj = { value: 42 };
  const id = airlock.register(obj);
  airlock.declare('TestObj', id);

  // Verify by checking the scope has an entry for TestObj
  const scopePointer = memoryImage.getRootScope();
  const entries = memoryImage.getScopeEntries(scopePointer);

  const entry = entries.find(e => e.name === 'TestObj');
  assert(entry, 'TestObj should be found in scope');
  assertEquals(entry.type, TYPE.EXTERNAL);
  assertEquals(entry.dataLo, id.slot);
  // declare() used to
  // hardcode dataHi=0 for every top-level identifier (postMessage,
  // setTimeout, box, landing, ...) — the SS value carried NO version at
  // all, so the stale-handle check at dispatch (_rejectIfStaleHandle)
  // silently no-op'd for the single most common way a handle reaches SS
  // code. A freshly-registered handle's version is always >= 1
  // (register() increments from the slot's prior value), so dataHi === 0
  // here would mean the fix regressed back to the old unversioned
  // behavior.
  assertEquals(entry.dataHi, id.version);
  assert(entry.dataHi > 0, 'a freshly-registered handle always has version >= 1');
});

Deno.test("Airlock: declare() with same name rebinds to new handle", () => {
  const { memoryImage, wasm, airlock } = createTestContext();

  const a = airlock.register({ tag: 'a' });
  const b = airlock.register({ tag: 'b' });
  airlock.declare('thing', a);
  airlock.declare('thing', b);

  const scopePointer = memoryImage.getRootScope();
  const entries = memoryImage.getScopeEntries(scopePointer);
  const matches = entries.filter(e => e.name === 'thing');

  assertEquals(matches.length, 1, 'rebind should not duplicate the entry');
  assertEquals(matches[0].dataLo, b.slot, 'rebind should overwrite to the new handle');
});

// =============================================================================
// allocateMsgpackBytes — segment-relative msgpack storage
// =============================================================================

Deno.test("Airlock: allocateMsgpackBytes round-trips bytes through the heap", () => {
  const { memoryImage, wasm, airlock } = createTestContext();

  const payload = new Uint8Array([0x82, 0xa1, 0x6e, 0x05, 0xa1, 0x6b, 0xa2, 0x67, 0x6f]);
  const dataPointer = airlock.allocateMsgpackBytes(payload);

  // Length field at offset 0 of the data region.
  const length = memoryImage.view.getUint32(memoryImage.abs(dataPointer), true);
  assertEquals(length, payload.length, 'length field should record payload byteLength');

  // Bytes start at dataPointer + 4 (after the length field).
  const bytesAbs = memoryImage.abs(dataPointer + 4);
  for (let i = 0; i < payload.length; i++) {
    assertEquals(memoryImage.u8[bytesAbs + i], payload[i], `byte ${i} should match payload`);
  }
});

Deno.test("Airlock: allocateMsgpackBytes accepts byteOffset and byteLength", () => {
  const { memoryImage, wasm, airlock } = createTestContext();

  const source = new Uint8Array([0x00, 0x00, 0x82, 0xa1, 0x78, 0x01, 0x00, 0x00]);
  // Copy only the middle four bytes.
  const dataPointer = airlock.allocateMsgpackBytes(source, 2, 4);

  const length = memoryImage.view.getUint32(memoryImage.abs(dataPointer), true);
  assertEquals(length, 4);

  const bytesAbs = memoryImage.abs(dataPointer + 4);
  assertEquals(memoryImage.u8[bytesAbs + 0], 0x82);
  assertEquals(memoryImage.u8[bytesAbs + 1], 0xa1);
  assertEquals(memoryImage.u8[bytesAbs + 2], 0x78);
  assertEquals(memoryImage.u8[bytesAbs + 3], 0x01);
});

Deno.test("Airlock: allocateMsgpackBytes accepts an ArrayBuffer", () => {
  const { memoryImage, wasm, airlock } = createTestContext();

  const buffer = new ArrayBuffer(3);
  new Uint8Array(buffer).set([0xc3, 0xc2, 0x80]);

  const dataPointer = airlock.allocateMsgpackBytes(buffer);
  const length = memoryImage.view.getUint32(memoryImage.abs(dataPointer), true);
  assertEquals(length, 3);

  const bytesAbs = memoryImage.abs(dataPointer + 4);
  assertEquals(memoryImage.u8[bytesAbs + 0], 0xc3);
  assertEquals(memoryImage.u8[bytesAbs + 1], 0xc2);
  assertEquals(memoryImage.u8[bytesAbs + 2], 0x80);
});

Deno.test("Airlock: allocateMsgpackBytes wraps the bytes in a real GC header", () => {
  const { memoryImage, wasm, airlock } = createTestContext();

  const heapBefore = memoryImage.getHeapPointer();
  const payload = new Uint8Array(64);
  payload.fill(0xab);

  const dataPointer = airlock.allocateMsgpackBytes(payload);

  // The bytes block should sit immediately after a GC header. Header
  // pointer = data pointer - GC_HEADER_SIZE (8).
  const headerPointer = dataPointer - 8;
  const headerWord = memoryImage.view.getUint32(memoryImage.abs(headerPointer), true);
  const objType = (headerWord >>> 24) & 0xff;
  const headerSize = headerWord & 0x00ffffff;

  // Object type is ARRAYBUFFER (8), reusing the existing binary-buffer
  // representation.
  assertEquals(objType, 8, 'header should encode OBJ.ARRAYBUFFER');

  // headerSize includes the 8-byte GC header plus the data region
  // (4 length bytes + payload bytes), aligned up to 16.
  assert(headerSize >= 8 + 4 + payload.length,
    `header size ${headerSize} should cover header + length + bytes`);
  assertEquals(headerSize % 16, 0, 'header size should be 16-byte aligned');

  // Heap pointer should have advanced by the header size.
  const heapAfter = memoryImage.getHeapPointer();
  assertEquals(heapAfter - heapBefore, headerSize,
    'heap should advance by the header-encoded total size');
});

// =============================================================================
// currentSlot + slot-capture wrapping
// =============================================================================

Deno.test("Airlock: currentSlot is null outside any handler invocation", () => {
  const airlock = createAirlock();
  assertEquals(airlock.currentSlot, null);
});

Deno.test("Airlock: _invokeWithSlotCapture sets currentSlot for the call's sync portion", () => {
  const airlock = createAirlock();
  let seenSlot = -1;
  airlock._invokeWithSlotCapture(7, () => {
    seenSlot = airlock.currentSlot;
  }, {});
  assertEquals(seenSlot, 7);
  assertEquals(airlock.currentSlot, null);
});

Deno.test("Airlock: _invokeWithSlotCapture restores prior slot after nested invocation", () => {
  const airlock = createAirlock();
  let outerBefore = -1, outerAfter = -1, innerSlot = -1;
  airlock._invokeWithSlotCapture(3, () => {
    outerBefore = airlock.currentSlot;
    airlock._invokeWithSlotCapture(9, () => {
      innerSlot = airlock.currentSlot;
    }, {});
    outerAfter = airlock.currentSlot;
  }, {});
  assertEquals(outerBefore, 3);
  assertEquals(innerSlot, 9);
  assertEquals(outerAfter, 3);
  assertEquals(airlock.currentSlot, null);
});

Deno.test("Airlock: _invokeWithSlotCapture works with slot 0 (no zero-sentinel ambiguity)", () => {
  const airlock = createAirlock();
  let seen = -1;
  airlock._invokeWithSlotCapture(0, () => {
    seen = airlock.currentSlot;
  }, {});
  assertEquals(seen, 0);
  assertEquals(airlock.currentSlot, null);
});

Deno.test("Airlock: _invokeWithSlotCapture clears cell even when handler throws", () => {
  const airlock = createAirlock();
  let threw = false;
  try {
    airlock._invokeWithSlotCapture(5, () => { throw new Error("boom"); }, {});
  } catch (_e) {
    threw = true;
  }
  assert(threw);
  assertEquals(airlock.currentSlot, null);
});

Deno.test("Airlock: handlers capture currentSlot synchronously, close over it for async work", async () => {
  // Contract: the cell is reliable only for sync reads during the
  // handler's sync portion. Async error-capture and ledger-write
  // machinery should snapshot the slot at handler entry and close
  // over it — not re-read airlock.currentSlot after an await.
  const airlock = createAirlock();
  let observedAtRejection = -1;
  const handler = () => {
    const slotAtEntry = airlock.currentSlot;
    return Promise.reject(new Error("async boom")).catch((err) => {
      observedAtRejection = slotAtEntry;
      throw err;
    });
  };
  try {
    await airlock._invokeWithSlotCapture(11, handler, {});
  } catch (_e) { /* expected */ }
  assertEquals(observedAtRejection, 11);
  assertEquals(airlock.currentSlot, null);
});

Deno.test("Airlock: async handler resolution leaves currentSlot null after settlement", async () => {
  const airlock = createAirlock();
  const out = await airlock._invokeWithSlotCapture(4, () =>
    Promise.resolve("ok"), {});
  assertEquals(out, "ok");
  assertEquals(airlock.currentSlot, null);
});

// =============================================================================
// ensureHandle / ensureGrant
// =============================================================================

Deno.test("Airlock: ensureHandle mints on first call, reuses on second", () => {
  const airlock = createAirlock();
  let factoryCalls = 0;
  const predicate = (entry) => entry.metadata?.kind === 'streamer';
  const factory = () => {
    factoryCalls++;
    return airlock.register({ name: 'streamer-impl' }, { kind: 'streamer' });
  };
  const first = airlock.ensureHandle(predicate, factory);
  const second = airlock.ensureHandle(predicate, factory);
  assertEquals(factoryCalls, 1);
  assertEquals(first.slot, second.slot);
  assertEquals(first.version, second.version);
});

Deno.test("Airlock: ensureGrant mints on first call, reuses on second", () => {
  const airlock = createAirlock();
  let factoryCalls = 0;
  const predicate = (entry) => entry.identifier === 'capability:read';
  const factory = () => {
    factoryCalls++;
    return airlock.membrane.createGrant('capability:read');
  };
  const first = airlock.ensureGrant(predicate, factory);
  const second = airlock.ensureGrant(predicate, factory);
  assertEquals(factoryCalls, 1);
  assertEquals(first.slot, second.slot);
});

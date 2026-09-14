/**
 * ArrayBuffer and Uint8Array infrastructure tests.
 *
 * Run with: deno task test tests/fuel/arraybuffer_test.js
 */

import { assertEquals, assert } from "https://deno.land/std@0.208.0/assert/mod.ts";
import {
  MemoryManipulator,
  instantiateSync,
  layoutVat,
  Collector,
  TYPE,
  OBJ,
  GC_HEADER_SIZE,
} from '../../src/fuel/index.js';

function createTestContext() {
  const memory = new WebAssembly.Memory({ initial: 16, maximum: 256, shared: true });
  const wasm = instantiateSync(memory);
  const mem = new MemoryManipulator(memory);
  mem.setWasmInstance(wasm);
  layoutVat(mem.memory, mem.baseOffset, { segmentSize: mem.segmentSize });
  mem.bootstrap();
  return { memory, wasm, mem };
}

// =============================================================================
// ArrayBuffer Allocation
// =============================================================================

Deno.test("ArrayBuffer: allocateArrayBuffer returns data pointer", () => {
  const { mem } = createTestContext();

  const bufPtr = mem.allocateArrayBuffer(10);

  // Should be a valid pointer (after GC header)
  assert(bufPtr > 0);
  assert(bufPtr >= mem.getHeapStart() + GC_HEADER_SIZE);
});

Deno.test("ArrayBuffer: getArrayBufferByteLength returns correct length", () => {
  const { mem } = createTestContext();

  const bufPtr = mem.allocateArrayBuffer(42);
  const length = mem.getArrayBufferByteLength(bufPtr);

  assertEquals(length, 42);
});

Deno.test("ArrayBuffer: bytes are zero-initialized", () => {
  const { mem } = createTestContext();

  const bufPtr = mem.allocateArrayBuffer(10);

  for (let i = 0; i < 10; i++) {
    const val = mem.readUint8ArrayElement(bufPtr, 0, i);
    assertEquals(val, 0, `byte ${i} should be 0`);
  }
});

Deno.test("ArrayBuffer: heap pointer advances correctly", () => {
  const { mem } = createTestContext();

  const heapBefore = mem.getHeapPointer();
  mem.allocateArrayBuffer(16);
  const heapAfter = mem.getHeapPointer();

  // Should have allocated: 8 (GC header) + 4 (length) + 16 (bytes) = 28, aligned to 32
  assert(heapAfter > heapBefore);
  assertEquals((heapAfter - heapBefore) % 8, 0, 'should be 8-byte aligned');
});

// =============================================================================
// Uint8Array Read/Write
// =============================================================================

Deno.test("Uint8Array: writeUint8ArrayElement writes byte", () => {
  const { mem } = createTestContext();

  const bufPtr = mem.allocateArrayBuffer(10);
  const written = mem.writeUint8ArrayElement(bufPtr, 0, 5, 42);

  assert(written);
  assertEquals(mem.readUint8ArrayElement(bufPtr, 0, 5), 42);
});

Deno.test("Uint8Array: write wraps to 0-255", () => {
  const { mem } = createTestContext();

  const bufPtr = mem.allocateArrayBuffer(10);

  // 256 wraps to 0
  mem.writeUint8ArrayElement(bufPtr, 0, 0, 256);
  assertEquals(mem.readUint8ArrayElement(bufPtr, 0, 0), 0);

  // 257 wraps to 1
  mem.writeUint8ArrayElement(bufPtr, 0, 1, 257);
  assertEquals(mem.readUint8ArrayElement(bufPtr, 0, 1), 1);

  // -1 wraps to 255
  mem.writeUint8ArrayElement(bufPtr, 0, 2, -1);
  assertEquals(mem.readUint8ArrayElement(bufPtr, 0, 2), 255);

  // -2 wraps to 254
  mem.writeUint8ArrayElement(bufPtr, 0, 3, -2);
  assertEquals(mem.readUint8ArrayElement(bufPtr, 0, 3), 254);
});

Deno.test("Uint8Array: read out of bounds returns -1", () => {
  const { mem } = createTestContext();

  const bufPtr = mem.allocateArrayBuffer(5);

  assertEquals(mem.readUint8ArrayElement(bufPtr, 0, 5), -1);
  assertEquals(mem.readUint8ArrayElement(bufPtr, 0, 100), -1);
  assertEquals(mem.readUint8ArrayElement(bufPtr, 0, -1), -1);
});

Deno.test("Uint8Array: write out of bounds returns false", () => {
  const { mem } = createTestContext();

  const bufPtr = mem.allocateArrayBuffer(5);

  assertEquals(mem.writeUint8ArrayElement(bufPtr, 0, 5, 42), false);
  assertEquals(mem.writeUint8ArrayElement(bufPtr, 0, 100, 42), false);
});

Deno.test("Uint8Array: byteOffset works correctly", () => {
  const { mem } = createTestContext();

  const bufPtr = mem.allocateArrayBuffer(10);

  // Write at absolute positions
  mem.writeUint8ArrayElement(bufPtr, 0, 5, 55);
  mem.writeUint8ArrayElement(bufPtr, 0, 6, 66);

  // Read with byteOffset
  assertEquals(mem.readUint8ArrayElement(bufPtr, 5, 0), 55);
  assertEquals(mem.readUint8ArrayElement(bufPtr, 5, 1), 66);
  assertEquals(mem.readUint8ArrayElement(bufPtr, 6, 0), 66);
});

Deno.test("Uint8Array: byteOffset bounds checking", () => {
  const { mem } = createTestContext();

  const bufPtr = mem.allocateArrayBuffer(10);

  // Offset 8, length 2 - can read indices 0 and 1
  assertEquals(mem.readUint8ArrayElement(bufPtr, 8, 1), 0);  // valid
  assertEquals(mem.readUint8ArrayElement(bufPtr, 8, 2), -1); // out of bounds
});

// =============================================================================
// Value Layout
// =============================================================================

Deno.test("ArrayBuffer: pushArrayBufferValue creates correct value", () => {
  const { mem } = createTestContext();

  const bufPtr = mem.allocateArrayBuffer(10);
  const pendingBefore = mem.getContextPendingPointer(0);

  mem.pushArrayBufferValue(0, bufPtr);

  const pendingAfter = mem.getContextPendingPointer(0);
  assertEquals(pendingAfter - pendingBefore, 16, 'should push 16 bytes');

  // Read value back
  const valuePtr = pendingBefore;
  const absPtr = mem.abs(valuePtr);
  const type = mem.view.getUint32(absPtr, true);
  const flags = mem.view.getUint32(absPtr + 4, true);
  const dataLo = mem.view.getUint32(absPtr + 8, true);
  const dataHi = mem.view.getUint32(absPtr + 12, true);

  assertEquals(type, TYPE.ARRAYBUFFER);
  assertEquals(flags, 0);
  assertEquals(dataLo, bufPtr);
  assertEquals(dataHi, 0);
});

Deno.test("Uint8Array: pushUint8ArrayValue creates correct value", () => {
  const { mem } = createTestContext();

  const bufPtr = mem.allocateArrayBuffer(100);
  const pendingBefore = mem.getContextPendingPointer(0);

  mem.pushUint8ArrayValue(0, bufPtr, 10, 50);

  const pendingAfter = mem.getContextPendingPointer(0);
  assertEquals(pendingAfter - pendingBefore, 16, 'should push 16 bytes');

  // Read value back
  const valuePtr = pendingBefore;
  const absPtr = mem.abs(valuePtr);
  const type = mem.view.getUint32(absPtr, true);
  const flags = mem.view.getUint32(absPtr + 4, true);
  const descriptorPtr = mem.view.getUint32(absPtr + 8, true);
  const dataHi = mem.view.getUint32(absPtr + 12, true);

  assertEquals(type, TYPE.UINT8ARRAY);
  assertEquals(flags, 0);           // flags = 0 (free for scope flags)
  assert(descriptorPtr > 0);        // descriptor pointer in data_lo
  assertEquals(dataHi, 0);          // data_hi = 0 (unused)

  // Read descriptor to verify contents
  const descAbs = mem.abs(descriptorPtr);
  const descBufPtr = mem.view.getUint32(descAbs, true);
  const descOffset = mem.view.getUint32(descAbs + 4, true);
  const descLength = mem.view.getUint32(descAbs + 8, true);

  assertEquals(descBufPtr, bufPtr); // ArrayBuffer pointer
  assertEquals(descOffset, 10);     // byteOffset
  assertEquals(descLength, 50);     // length
});

// =============================================================================
// GC Integration
// =============================================================================

Deno.test("GC: ArrayBuffer heap object has correct type", () => {
  const { mem } = createTestContext();

  const bufPtr = mem.allocateArrayBuffer(10);
  const headerPtr = bufPtr - GC_HEADER_SIZE;

  // Read header
  const absHeader = mem.abs(headerPtr);
  const header = mem.view.getUint32(absHeader, true);
  const objType = (header >> 24) & 0xFF;

  assertEquals(objType, OBJ.ARRAYBUFFER);
});

Deno.test("GC: collector handles ArrayBuffer type in markValue", () => {
  const { mem } = createTestContext();

  const bufPtr = mem.allocateArrayBuffer(10);

  // Push ArrayBuffer value to pending stack
  mem.pushArrayBufferValue(0, bufPtr);

  // Note: Context exit condition is set by WASM execution, not manually.
  // The GC will check if it's safe to run based on the current state.

  // Create collector and run mark phase (should not crash)
  const collector = new Collector(mem);
  collector.markPhase();

  // ArrayBuffer should be marked
  const headerPtr = bufPtr - GC_HEADER_SIZE;
  assert(collector.isMarked(headerPtr), 'ArrayBuffer should be marked');
});

Deno.test("GC: collector handles Uint8Array type in markValue", () => {
  const { mem } = createTestContext();

  const bufPtr = mem.allocateArrayBuffer(10);

  // Push Uint8Array value to pending stack
  mem.pushUint8ArrayValue(0, bufPtr, 0, 10);

  // Note: Context exit condition is set by WASM execution, not manually.
  // The GC will check if it's safe to run based on the current state.

  // Create collector and run mark phase
  const collector = new Collector(mem);
  collector.markPhase();

  // ArrayBuffer should be marked (via Uint8Array reference)
  const headerPtr = bufPtr - GC_HEADER_SIZE;
  assert(collector.isMarked(headerPtr), 'ArrayBuffer should be marked via Uint8Array');
});

Deno.test("GC: unreferenced ArrayBuffer is collected", () => {
  const { mem } = createTestContext();

  // Allocate ArrayBuffer but don't keep a reference to it
  const bufPtr = mem.allocateArrayBuffer(100);

  // Note: Context exit condition is set by WASM execution, not manually.
  // The GC will check if it's safe to run based on the current state.

  // Run GC
  const collector = new Collector(mem);
  const result = collector.collect();

  // Should have collected something
  assert(result.heapCollected > 0, 'Should collect unreferenced ArrayBuffer');
});

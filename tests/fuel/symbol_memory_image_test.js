/**
 * 2a.1 — Symbol heap type at the memory-image layer.
 *
 * This file exercises the lowest level of Symbol support: the heap allocator
 * and structured readback. Language-level access (Symbol(), Symbol.for, typeof,
 * identity, method surface, coercion) lands in later 2a sub-commits and is
 * tested separately.
 *
 * Run with: deno task test tests/fuel/symbol_memory_image_test.js
 */

import { assertEquals, assert } from "https://deno.land/std@0.208.0/assert/mod.ts";
import { MemoryImage, instantiateSync, layoutVat, TYPE } from '../../src/fuel/index.js';

function createTestMemoryImage() {
  const memory = new WebAssembly.Memory({ initial: 16, maximum: 256, shared: true });
  const wasm = instantiateSync(memory);
  const memoryImage = new MemoryImage(memory);
  memoryImage.setWasmInstance(wasm);
  layoutVat(memoryImage.memory, memoryImage.baseOffset, { segmentSize: memoryImage.segmentSize });
  memoryImage.bootstrap();
  return memoryImage;
}

Deno.test("Symbol allocator: allocates a heap object with description offset", () => {
  const memoryImage = createTestMemoryImage();
  const descriptionOffset = memoryImage.internString('x');
  const symbolPointer = memoryImage.allocateSymbol(descriptionOffset);
  assert(symbolPointer > 0, 'allocator returned a valid heap pointer');

  const readDescriptionOffset = memoryImage.readSymbolDescription(symbolPointer);
  assertEquals(readDescriptionOffset, descriptionOffset);
});

Deno.test("Symbol allocator: zero description means 'undescribed'", () => {
  const memoryImage = createTestMemoryImage();
  const symbolPointer = memoryImage.allocateSymbol(0);
  assertEquals(memoryImage.readSymbolDescription(symbolPointer), 0);
});

Deno.test("Symbol allocator: two calls with same description produce distinct pointers", () => {
  const memoryImage = createTestMemoryImage();
  const descriptionOffset = memoryImage.internString('x');
  const a = memoryImage.allocateSymbol(descriptionOffset);
  const b = memoryImage.allocateSymbol(descriptionOffset);
  assert(a !== b, 'each Symbol() call allocates a fresh heap object');
});

Deno.test("Symbol readback: readValueAt returns structured form", () => {
  const memoryImage = createTestMemoryImage();
  const descriptionOffset = memoryImage.internString('myAtom');
  const symbolPointer = memoryImage.allocateSymbol(descriptionOffset);

  // Synthesize a value slot pointing at the Symbol and read it back.
  const scratchValueAddress = memoryImage.getHeapPointer();
  const abs = memoryImage.abs(scratchValueAddress);
  memoryImage.view.setUint32(abs, TYPE.SYMBOL, true);       // type
  memoryImage.view.setUint32(abs + 4, 0, true);             // flags
  memoryImage.view.setUint32(abs + 8, symbolPointer, true); // dataLo
  memoryImage.view.setUint32(abs + 12, 0, true);            // dataHi

  const readback = memoryImage.readValueAt(scratchValueAddress);
  assertEquals(readback, {
    kind: 'symbol',
    description: 'myAtom',
    registered: false,  // 2a.1: registry doesn't exist yet
  });
});

Deno.test("Symbol readback: undescribed Symbol reads as description=undefined", () => {
  const memoryImage = createTestMemoryImage();
  const symbolPointer = memoryImage.allocateSymbol(0);

  const scratchValueAddress = memoryImage.getHeapPointer();
  const abs = memoryImage.abs(scratchValueAddress);
  memoryImage.view.setUint32(abs, TYPE.SYMBOL, true);
  memoryImage.view.setUint32(abs + 4, 0, true);
  memoryImage.view.setUint32(abs + 8, symbolPointer, true);
  memoryImage.view.setUint32(abs + 12, 0, true);

  const readback = memoryImage.readValueAt(scratchValueAddress);
  assertEquals(readback, {
    kind: 'symbol',
    description: undefined,
    registered: false,
  });
});

Deno.test("isSymbolRegistered: stub returns false (registry not built yet in 2a.1)", () => {
  const memoryImage = createTestMemoryImage();
  const symbolPointer = memoryImage.allocateSymbol(memoryImage.internString('x'));
  assertEquals(memoryImage.isSymbolRegistered(symbolPointer), false);
});

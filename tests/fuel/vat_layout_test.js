/**
 * Tests for the pure vat-layout functions in src/fuel/vat-layout.js.
 *
 * Coverage:
 *   - computeVatLayout returns coherent offsets + byteLength.
 *   - layoutVat writes a magic + state header readable by
 *     MemoryImage's existing readers (validateMagic, getHeapStart,
 *     etc.).
 *   - readVatLayout round-trips with computeVatLayout.
 *   - A session constructed via layoutVat + MemoryImage.bootstrap
 *     produces a functioning interpreter.
 */

import { assertEquals, assertThrows, assert } from "https://deno.land/std@0.208.0/assert/mod.ts";
import {
  computeVatLayout,
  layoutVat,
  readVatLayout,
} from '../../src/fuel/vat-layout.js';
import { DRONE_FORMAT_VERSION } from '../../src/persisted-format.js';
import { freshSession } from '../../src/host-owned-session.js';
import { MemoryImage, instantiateSync, VERSION, HEADER, STATE } from '../../src/fuel/index.js';
import { createSession } from '../../src/fuel/session.js';

Deno.test("computeVatLayout: returns coherent byteLength and region offsets", () => {
  const layout = computeVatLayout({});
  assert(layout.byteLength > 0);
  assert(layout.regionOffsets.heapStart < layout.regionOffsets.heapEnd);
  assert(layout.regionOffsets.stringStart > layout.regionOffsets.heapStart);
  assertEquals(layout.regionOffsets.heapEnd, layout.regionOffsets.stringStart);
  // codeStart sits 16 bytes below stringStart (room for code-block header).
  assertEquals(layout.regionOffsets.codeStart, layout.regionOffsets.stringStart - 16);
});

Deno.test("computeVatLayout: default heap fits ordinary exact algebraic operations", () => {
  const layout = computeVatLayout({});
  assertEquals(
    layout.regionOffsets.heapEnd - layout.regionOffsets.heapStart,
    8 * 1024 * 1024,
  );
});

Deno.test("computeVatLayout: rejects scratchSize below the minimum", () => {
  // The interpreter's fixed-extent scratch staging must always fit.
  // $scratch_ptr traps on overflow, so a session too small for it is a host
  // configuration error at creation time.
  assertThrows(
    () => computeVatLayout({ scratchSize: 64 }),
    Error,
    'below the minimum');
  // The minimum itself is legal.
  const layout = computeVatLayout({ scratchSize: 256 });
  assertEquals(layout.regionSizes.scratch, 256);
});

Deno.test("computeVatLayout: honours custom segmentSize", () => {
  const segmentSize = 2 * 1024 * 1024;
  const layout = computeVatLayout({ segmentSize, stringTableSize: 128 * 1024 });
  assertEquals(layout.byteLength, segmentSize);
  assertEquals(layout.regionOffsets.stringStart, segmentSize - 128 * 1024);
});

Deno.test("computeVatLayout: throws when fixed regions overflow segment", () => {
  assertThrows(
    () => computeVatLayout({ segmentSize: 1024, stringTableSize: 256 * 1024 }),
    Error,
    'exceeds segment size',
  );
});

Deno.test("layoutVat: writes SANDFUEL magic + version fields readable by MemoryImage", () => {
  const layout = computeVatLayout({});
  const memory = new WebAssembly.Memory({
    initial: Math.ceil(layout.byteLength / 65536),
    maximum: 256,
    shared: true,
  });
  layoutVat(memory, 0, {});

  // Construct a MemoryImage and use its readers — proves the bytes
  // we wrote match the format MemoryImage expects.
  const mi = new MemoryImage(memory, 0, layout.byteLength);
  mi.validateMagic();
  assertEquals(mi.getDroneFormatVersion(), DRONE_FORMAT_VERSION);
  assertEquals(mi.getBytecodeVersion(),  VERSION.BYTECODE);
  assertEquals(mi.getTypeVersion(),      VERSION.TYPE);
  assertEquals(mi.getBuiltinVersion(),   VERSION.BUILTIN);
});

Deno.test("layoutVat: STATE region pointers match layout", () => {
  const layout = computeVatLayout({});
  const memory = new WebAssembly.Memory({
    initial: Math.ceil(layout.byteLength / 65536),
    maximum: 256,
    shared: true,
  });
  layoutVat(memory, 0, {});
  const mi = new MemoryImage(memory, 0, layout.byteLength);

  assertEquals(mi.getHeapStart(),     layout.regionOffsets.heapStart);
  assertEquals(mi.getHeapEnd(),       layout.regionOffsets.heapEnd);
  // Layout v18: parallel context-pointer and allocation-generation tables
  // are the first two aligned heap objects.
  const tableTotal = (8 + layout.contextTableSize + 15) & ~15;
  assertEquals(mi.getHeapPointer(),
    layout.regionOffsets.heapStart + tableTotal * 2);
  assertEquals(mi.getContextTablePointer(), layout.regionOffsets.heapStart + 8);
  assertEquals(mi.getContextGenerationTablePointer(),
    layout.regionOffsets.heapStart + tableTotal + 8);
  assert(mi.getContextTableCapacity() >= layout.contextTableSize / 4);
  assertEquals(mi.getStringStart(),   layout.regionOffsets.stringStart);
  assertEquals(mi.getStringPointer(), layout.regionOffsets.stringPointer);
});

Deno.test("layoutVat: writes at non-zero baseOffset correctly", () => {
  const layout = computeVatLayout({});
  // Allocate enough memory for vat-at-baseOffset.
  const baseOffset = 1024 * 1024;
  const memory = new WebAssembly.Memory({
    initial: Math.ceil((baseOffset + layout.byteLength) / 65536),
    maximum: 256,
    shared: true,
  });
  layoutVat(memory, baseOffset, {});

  const mi = new MemoryImage(memory, baseOffset, layout.byteLength);
  mi.validateMagic();
  assertEquals(mi.getHeapStart(), layout.regionOffsets.heapStart);
});

Deno.test("layoutVat: throws when buffer is too small", () => {
  const memory = new WebAssembly.Memory({ initial: 1, maximum: 256, shared: true });
  // 64 KB is way less than the default vat size.
  assertThrows(
    () => layoutVat(memory, 0, {}),
    RangeError,
    'overflow buffer',
  );
});

Deno.test("readVatLayout: round-trips with computeVatLayout", () => {
  const layoutIn = computeVatLayout({});
  const memory = new WebAssembly.Memory({
    initial: Math.ceil(layoutIn.byteLength / 65536),
    maximum: 256,
    shared: true,
  });
  layoutVat(memory, 0, {});

  const view = new Uint8Array(memory.buffer, 0, layoutIn.byteLength);
  const layoutOut = readVatLayout(view, 0);

  assertEquals(layoutOut.byteLength, layoutIn.byteLength);
  assertEquals(layoutOut.regionOffsets.heapStart,     layoutIn.regionOffsets.heapStart);
  assertEquals(layoutOut.regionOffsets.heapEnd,       layoutIn.regionOffsets.heapEnd);
  assertEquals(layoutOut.regionOffsets.stringStart,   layoutIn.regionOffsets.stringStart);
  assertEquals(layoutOut.regionOffsets.stringPointer, layoutIn.regionOffsets.stringPointer);
  assertEquals(layoutOut.regionOffsets.codeStart,     layoutIn.regionOffsets.codeStart);
  assertEquals(layoutOut.versions.droneFormat, DRONE_FORMAT_VERSION);
  assertEquals(layoutOut.versions.bytecode, VERSION.BYTECODE);
});

Deno.test("readVatLayout: rejects bytes without SANDFUEL magic", () => {
  const buffer = new ArrayBuffer(1024);
  const view = new Uint8Array(buffer);
  assertThrows(
    () => readVatLayout(view, 0),
    Error,
    'magic mismatch',
  );
});

Deno.test("layoutVat + MemoryImage.bootstrap produces a working session", () => {
  // Drive the new layout-then-bootstrap flow directly and verify the
  // resulting session passes the same internal-consistency checks the
  // legacy initialize() path satisfies. Sizes won't necessarily match
  // freshSession()'s defaults — both paths take options.
  const layout = computeVatLayout({});
  const memory = new WebAssembly.Memory({
    initial: Math.ceil(layout.byteLength / 65536),
    maximum: 256,
    shared: true,
  });
  layoutVat(memory, 0, {});

  const wasm = instantiateSync(memory);
  const mi = new MemoryImage(memory, 0, layout.byteLength);
  mi.setWasmInstance(wasm);
  const context0 = mi.bootstrap();
  assertEquals(context0, 0);

  // Internal-consistency checks:
  //   - heap is non-empty after builtins (initializeBuiltins
  //     allocates several prototype objects).
  //   - string pointer has advanced past the hash table (builtin
  //     names were interned).
  //   - root scope is set.
  assert(mi.getHeapPointer() > mi.getHeapStart(),
    `heap pointer (${mi.getHeapPointer()}) should be past heap start (${mi.getHeapStart()})`);
  assert(mi.getStringPointer() > layout.regionOffsets.stringPointer,
    `string pointer (${mi.getStringPointer()}) should be past initial position ` +
    `(${layout.regionOffsets.stringPointer}) after interning builtins`);
  assert(mi.getRootScope() !== 0, 'root scope should be set after bootstrap');
});

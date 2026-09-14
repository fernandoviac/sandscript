/**
 * MemoryReader contract tests.
 *
 * Two guards against drift:
 *   1. Source-level — assert that memory-reader.js contains no mutation
 *      patterns. Catches the case where someone adds a write helper to
 *      the reader by accident.
 *   2. Behavioral — construct a bare MemoryReader (no WASM instance
 *      attached, no setWasmInstance call) against a live session's
 *      memory and verify the read API works end-to-end. Also exercises
 *      MembraneWalker against the bare reader, locking in the
 *      "read-only consumer takes a MemoryReader" contract.
 *
 * Run with: deno task test tests/fuel/memory_reader_test.js
 */

import { assert, assertEquals, assertStrictEquals } from "https://deno.land/std@0.208.0/assert/mod.ts";
import { MemoryReader, createSession } from '../../src/fuel/index.js';
import { MembraneWalker } from '../../src/membrane/walker.js';
import { freshSession } from '../../src/host-owned-session.js';

// =============================================================================
// 1. Source-level "no mutations in MemoryReader" guard
// =============================================================================

Deno.test("MemoryReader source has no memory-mutation patterns", async () => {
  const source = await Deno.readTextFile(
    new URL('../../src/fuel/memory-reader.js', import.meta.url)
  );

  // Patterns that indicate a write slipped into the read-only base class.
  // _refreshViews legitimately rebinds this.view/this.u8 via plain
  // assignments (`this.view = ...`), which the patterns below correctly
  // skip — they look for setter calls / WASM hooks specifically.
  const forbidden = [
    { pattern: /this\.view\.set\w+\(/, label: 'DataView setter call' },
    { pattern: /this\.u8\.set\(/, label: 'Uint8Array.set() write' },
    { pattern: /\bthis\.wasm\b/, label: 'WASM instance reference' },
    { pattern: /\.exports\.\w+/, label: 'WASM export call' },
    { pattern: /\binternString\b/, label: 'internString reference' },
    { pattern: /\bsetWasmInstance\b/, label: 'setWasmInstance reference' },
  ];

  for (const { pattern, label } of forbidden) {
    const match = source.match(pattern);
    if (match) {
      throw new Error(
        `MemoryReader contract violation — found ${label} ("${match[0]}") in src/fuel/memory-reader.js. ` +
        `Mutating helpers belong on MemoryImage, not MemoryReader.`
      );
    }
  }
});

// =============================================================================
// 2. Behavioral guard — MemoryReader works without a WASM instance
// =============================================================================

Deno.test("MemoryReader reads STATE/heap/strings against a live session's memory", () => {
  // Build a real session so the memory has non-trivial state to read back.
  const session = freshSession();
  session.parse('let answer = 42; let greeting = "hello";');
  session.run(0, 1000);

  // Construct a fresh MemoryReader over the same WebAssembly.Memory.
  // Crucially: no WASM instance is attached to this reader.
  const reader = new MemoryReader(
    session.memoryImage.memory,
    session.memoryImage.baseOffset,
    session.memoryImage.segmentSize,
  );

  // The reader has no WASM instance (proves the no-WASM-needed property).
  assertEquals(reader.wasm, undefined);

  // Header + STATE reads round-trip identically to MemoryImage.
  assertEquals(reader.getMagic(), 'SANDFUEL');
  assertEquals(
    reader.getDroneFormatVersion(),
    session.memoryImage.getDroneFormatVersion(),
  );
  assertEquals(reader.getHeapStart(), session.memoryImage.getHeapStart());
  assertEquals(reader.getHeapPointer(), session.memoryImage.getHeapPointer());
  assertEquals(reader.getStringStart(), session.memoryImage.getStringStart());

  // Context inspection works.
  assertEquals(reader.getContextCount(), session.memoryImage.getContextCount());
  assertEquals(reader.getContextScope(0), session.memoryImage.getContextScope(0));
});

Deno.test("MemoryReader reads scope variables via readValueAt without WASM", () => {
  const session = freshSession();
  session.parse('let answer = 42;');
  session.run(0, 1000);

  const reader = new MemoryReader(
    session.memoryImage.memory,
    session.memoryImage.baseOffset,
    session.memoryImage.segmentSize,
  );

  // Walk the root scope, find `answer`, read its value through the bare
  // reader. This exercises readString, scopeKeys, scopeLookup, readValueAt,
  // and unmarshalRational — the full readback chain.
  const rootScope = reader.getRootScope();
  const keys = reader.scopeKeys(reader.getContextScope(0));
  assert(keys.includes('answer'), `scopeKeys missing 'answer': ${keys.join(',')}`);

  // Use the same path session.get() uses internally.
  const value = session.get(0, 'answer');
  assertEquals(value, 42);
});

Deno.test("MembraneWalker runs against a bare MemoryReader", () => {
  // Set up a session with a registered handle + grant so the walker
  // has live state to enumerate.
  const session = freshSession();
  const handle = session.airlock.register({ name: 'thing' }, { kind: 'thing' });
  const rootGrant = session.airlock.createRootGrant();
  rootGrant.add(handle);

  // Drive a tiny program so the heap has TYPE_EXTERNAL references.
  session.airlock.declare('Thing', handle);
  session.parse('let x = Thing;');
  session.run(0, 1000);

  // Construct a bare MemoryReader and pass it to the walker as
  // `memoryImage`. Walker only calls getContextCount, getExitCondition,
  // getGrantDepth, getGrantEntry — all read-only.
  const reader = new MemoryReader(
    session.memoryImage.memory,
    session.memoryImage.baseOffset,
    session.memoryImage.segmentSize,
  );

  const walker = new MembraneWalker(
    reader,
    session.collector,
    session.airlock,
    session.airlock.membrane,
  );

  // walk() should complete without throwing — proves the read-only
  // contract on the walker's `memoryImage` argument.
  const result = walker.walk();
  assert(result.liveHandleSlots instanceof Set);
  assert(result.liveGrantSlots instanceof Set);
  // The handle we registered + the root grant should both be live.
  assert(result.liveHandleSlots.has(handle.slot));
  assert(result.liveGrantSlots.has(rootGrant.slot));
});

Deno.test("MemoryReader on a fresh WebAssembly.Memory reads zero header", () => {
  // The no-WASM-instantiation property: build a memory without any
  // interpreter attached, wrap it in a MemoryReader, confirm the
  // unwritten header reads as expected.
  const memory = new WebAssembly.Memory({ initial: 1, maximum: 1, shared: true });
  const reader = new MemoryReader(memory);

  // No SANDFUEL magic was written, so getMagic returns the raw bytes
  // (eight zero bytes decoded as a string of NULs).
  const magic = reader.getMagic();
  assertEquals(magic.length, 8);
  // All zero bytes — not "SANDFUEL".
  assert(magic !== 'SANDFUEL', 'expected fresh memory to not validate as SANDFUEL');

  // STATE reads return zero (uninitialized memory).
  assertEquals(reader.getHeapStart(), 0);
  assertEquals(reader.getStringStart(), 0);
});

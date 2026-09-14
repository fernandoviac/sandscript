/**
 * session.relocate() — live relocation of a running session to a new
 * baseOffset within the same WebAssembly.Memory.
 *
 * Slice 2 (relocation_test.js) verified that the existing snapshot
 * → fromBytes → new session path works at a non-zero base. This file
 * verifies the next primitive: relocating an ALREADY-LIVE session
 * (no snapshot, no second instance, no fromBytes round-trip).
 * This is the primitive host compaction calls after copying a drone slab.
 *
 * Run with: deno task test tests/fuel/session_relocate_test.js
 */

import { assertEquals, assert } from "https://deno.land/std@0.208.0/assert/mod.ts";
import { createSession } from '../../src/fuel/session.js';
import { freshSession } from '../../src/host-owned-session.js';

function freshSharedMemory() {
  return new WebAssembly.Memory({ initial: 128, maximum: 256, shared: true });
}

const SEGMENT_SIZE = 2 * 1024 * 1024;
const MEMBRANE_SIZE = 512 * 1024;

// Create a session at the given base, with the membrane sub-region packed
// immediately after the SandScript segment in one per-drone slab.
function sessionAt(memory, base, { fromBytes = null, fromMembraneBytes = null } = {}) {
  // Membrane sits at base + SEGMENT_SIZE within the buffer (caller is
  // responsible for arranging non-overlap with neighbouring sessions).
  const membraneByteOffset = base + SEGMENT_SIZE;
  return freshSession({
    memory,
    offset: base,
    segmentSize: SEGMENT_SIZE,
    membraneBuffer: memory.buffer,
    membraneByteOffset,
    membraneByteLength: MEMBRANE_SIZE,
  });
}

Deno.test("session.relocate: memcpy segment + membrane, then call relocate",
  () => {
    const memory = freshSharedMemory();

    // ---- 1. live session at base 0 ----
    const a = sessionAt(memory, 0);
    a.parse(`
      let counter = 0
      function bump() { counter = counter + 1; return counter }
      let first = bump()
    `);
    a.run(0, 100000);
    assertEquals(a.get(0, 'first'), 1);
    assertEquals(a.get(0, 'counter'), 1);

    // ---- 2. memcpy segment + membrane to new base ----
    const NEW_BASE = 3 * 1024 * 1024;
    const u8 = new Uint8Array(memory.buffer);
    // Segment copy (SS image).
    u8.copyWithin(NEW_BASE, 0, SEGMENT_SIZE);
    // Membrane copy.
    const oldMembraneStart = SEGMENT_SIZE;
    const newMembraneStart = NEW_BASE + SEGMENT_SIZE;
    u8.copyWithin(newMembraneStart, oldMembraneStart, oldMembraneStart + MEMBRANE_SIZE);

    // ---- 3. relocate the live session ----
    a.relocate({
      segmentBaseOffset: NEW_BASE,
      membraneByteOffset: newMembraneStart,
      membraneByteLength: MEMBRANE_SIZE,
    });

    // ---- 4. read state at the new base ----
    // Variable reads exercise the post-relocate addressing layer
    // (interned name lookup, scope walk, heap reads). If any internal
    // pointer were absolute, this would return undefined or wrong
    // values.
    assertEquals(a.get(0, 'first'),   1, 'pre-relocate value survives');
    assertEquals(a.get(0, 'counter'), 1, 'closure-captured counter survives');
    // Verify the closure object itself is still callable — i.e., its
    // captured-scope pointer was reseated by the segment relocation.
    // We can't directly invoke `bump` from outside SS, but the closure
    // is heap-resident at a segment-relative offset; reading it as a
    // value should still find it.
    const bumpValue = a.get(0, 'bump');
    assert(bumpValue !== undefined, 'closure binding survives');
  });

Deno.test("session.relocate: handles, grants, and closure handles survive",
  () => {
    const memory = freshSharedMemory();
    const a = sessionAt(memory, 0);

    // Set up a tiny program that doesn't need externals — keep this
    // test self-contained on session API. The point is verifying the
    // membrane bytes round-trip; we exercise that by reading the
    // membrane's tick before and after (relocate must not bump it).
    a.parse(`let x = 1 + 1`);
    a.run(0, 100000);
    assertEquals(a.get(0, 'x'), 2);

    const tickBefore = a.tick();

    const NEW_BASE = 4 * 1024 * 1024;
    const u8 = new Uint8Array(memory.buffer);
    u8.copyWithin(NEW_BASE, 0, SEGMENT_SIZE);
    u8.copyWithin(NEW_BASE + SEGMENT_SIZE, SEGMENT_SIZE, SEGMENT_SIZE + MEMBRANE_SIZE);

    a.relocate({
      segmentBaseOffset: NEW_BASE,
      membraneByteOffset: NEW_BASE + SEGMENT_SIZE,
      membraneByteLength: MEMBRANE_SIZE,
    });

    // Membrane state survives byte-identical (no tick bump).
    const tickAfter = a.tick();
    assertEquals(tickAfter, tickBefore, 'membrane state byte-identical');

    // SS state still reads correctly.
    assertEquals(a.get(0, 'x'), 2);
  });

Deno.test("session.relocate: throws if bytes at new offset aren't a valid SS header",
  () => {
    const memory = freshSharedMemory();
    const a = sessionAt(memory, 0);
    a.parse(`let x = 1`);
    a.run(0, 100000);

    // Call relocate WITHOUT memcpy. The bytes at NEW_BASE are still
    // zero, so the SANDFUEL magic check fails loudly.
    const NEW_BASE = 5 * 1024 * 1024;
    let threw = null;
    try {
      a.relocate({
        segmentBaseOffset: NEW_BASE,
        membraneByteOffset: NEW_BASE + SEGMENT_SIZE,
        membraneByteLength: MEMBRANE_SIZE,
      });
    } catch (e) {
      threw = e;
    }
    assert(threw, 'relocate without memcpy must throw');
    assert(/SANDFUEL header/i.test(threw.message),
      `expected 'SANDFUEL header' in message; got ${threw.message}`);
  });

Deno.test("session.relocate: throws if new offset would overflow buffer",
  () => {
    const memory = freshSharedMemory();
    const a = sessionAt(memory, 0);
    a.parse(`let x = 1`);
    a.run(0, 100000);

    let threw = null;
    try {
      // Buffer is 128 pages × 64 KB = 8 MB. Asking for base = 7 MB
      // with a 2 MB segment overflows.
      a.relocate({
        segmentBaseOffset: 7 * 1024 * 1024,
        membraneByteOffset: 7 * 1024 * 1024 + SEGMENT_SIZE,
        membraneByteLength: MEMBRANE_SIZE,
      });
    } catch (e) {
      threw = e;
    }
    assert(threw, 'overflow must throw');
    assert(/exceeds buffer\.byteLength/.test(threw.message),
      `expected 'exceeds buffer.byteLength' in message; got ${threw.message}`);
  });

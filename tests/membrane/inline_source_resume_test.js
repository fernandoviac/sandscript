/**
 * Snapshot/resume with `inlineSource: true` must survive runtime work
 * that allocates many contexts. A drone that ran
 * past the default 10-context limit silently overran the AST region,
 * which then caused `astWriter.initialize()` on resume to throw a
 * dialect-mismatch error.
 *
 * Run with: deno task test tests/membrane/inline_source_resume_test.js
 */

import { assertEquals, assert } from "https://deno.land/std@0.208.0/assert/mod.ts";
import { DIALECT_SAND } from '../../src/fuel/ast.js';
import {
  AST_REGION,
  STATE,
} from '../../src/fuel/constants.js';
import { freshSession, restoreSession, snapshotSession } from '../../src/host-owned-session.js';

// =============================================================================
// Growable slot→pointer table: no fixed concurrency ceiling
// =============================================================================

Deno.test("allocateContext grows the table past its initial capacity", () => {
  // Layout v10: the slot→pointer table is a growable heap object.
  // Allocating past the initial capacity reallocs it (2x) instead of
  // throwing — concurrency is bounded by the heap alone.
  const session = freshSession({ inlineSource: true, contextTableSize: 4 * 10 });
  const mem = session.memoryImage;
  const initialCapacity = mem.getContextTableCapacity();
  // At least the requested 10 slots; 16-byte block alignment may add spare.
  assert(initialCapacity >= 10 && initialCapacity < 20,
    `initial capacity ~10, got ${initialCapacity}`);

  // Slot 0 is consumed at session init; allocate well past the initial
  // capacity (three doublings' worth).
  for (let i = 1; i < initialCapacity * 8; i++) {
    const slot = mem.allocateContext();
    assertEquals(slot, i);
    assert(mem.getContextBase(slot) !== 0, `slot ${slot} has a table entry`);
  }

  assert(mem.getContextTableCapacity() >= initialCapacity * 8,
    'table capacity grew to cover the allocated slots');
  // Entries published before the growths survived the copies.
  assert(mem.getContextBase(0) !== 0, 'slot 0 entry survived table growth');
});

Deno.test("the AST region's dialect header survives table growth", () => {
  // Pre-v10 the table sat just below AST_REGION and overrunning it corrupted
  // the dialect header. The table is heap-allocated now;
  // growth must never touch the AST region.
  const session = freshSession({ inlineSource: true, contextTableSize: 4 * 10 });
  session.parse('let x = 1');

  const mem = session.memoryImage;
  const target = mem.getContextTableCapacity() * 4;
  for (let i = 1; i < target; i++) {
    mem.allocateContext();
  }

  // Header still intact.
  const absBase = mem.abs(mem.getAstRegionBase());
  assertEquals(mem.view.getUint32(absBase, true), DIALECT_SAND);
});

// =============================================================================
// Host-tunable contextTableSize (pre-sizing hint, not a ceiling)
// =============================================================================

Deno.test("contextTableSize option pre-sizes the table; growth still works beyond it", () => {
  const small = freshSession({ inlineSource: true, contextTableSize: 4 * 10 });
  const baseCapacity = small.memoryImage.getContextTableCapacity();

  const enlarged = freshSession({ inlineSource: true, contextTableSize: 4 * 32 });
  const mem = enlarged.memoryImage;
  const capacity = mem.getContextTableCapacity();
  assert(capacity >= 32 && capacity > baseCapacity,
    `pre-sized capacity covers the request: ${capacity}`);
  // Allocate past the pre-sized capacity (slot 0 is taken at init) — the
  // hint avoids early doublings but never bounds concurrency.
  for (let i = 1; i < capacity + 5; i++) {
    mem.allocateContext();
  }
  assert(mem.getContextTableCapacity() > capacity, 'table grew past the hint');
});

// =============================================================================
// End-to-end: parse + run + snapshot + resume with inlineSource: true
// =============================================================================

Deno.test("inlineSource resume: empty-AST round-trip (no parse before snapshot)", () => {
  const original = freshSession({ inlineSource: true });
  const snap = snapshotSession(original);

  const restored = restoreSession(snap.vatBytes, snap.membraneBytes, { inlineSource: true });

  // The dialect header was written lazily, so an unparsed source session
  // restores into a session whose AST writer initializes the header for
  // the first time. We just need restore to not throw.
  restored.parse('let x = 1');
  restored.run(0, 1000);
  assertEquals(restored.get(0, 'x'), 1);
});

Deno.test("inlineSource resume: parse + run + snapshot + resume + run again", () => {
  const original = freshSession({ inlineSource: true });
  original.parse('let counter = 0');
  original.run(0, 1000);

  const snap = snapshotSession(original);

  const restored = restoreSession(snap.vatBytes, snap.membraneBytes, { inlineSource: true });

  // Append more code post-restore. Per slice 4 contract, we must seek the
  // resumed context to the new program's startIndex.
  const result = restored.parse('counter = counter + 5');
  restored.mem.setContextInstructionIndex(0, result.startIndex);
  restored.mem.clearExitCondition(0);
  restored.run(0, 1000);
  assertEquals(restored.get(0, 'counter'), 5);
});

Deno.test("inlineSource resume: multiple parse cycles before snapshot", () => {
  const original = freshSession({ inlineSource: true });
  original.parse('let a = 1');
  original.run(0, 1000);
  // Successive parses append; run() restarts at instruction 0 by default,
  // which would re-execute `let a` and throw REDECLARATION. The slice 4
  // contract is: seek the context to the new program's startIndex.
  let result = original.parse('let b = 2');
  original.mem.setContextInstructionIndex(0, result.startIndex);
  original.mem.clearExitCondition(0);
  original.run(0, 1000);
  result = original.parse('let c = a + b');
  original.mem.setContextInstructionIndex(0, result.startIndex);
  original.mem.clearExitCondition(0);
  original.run(0, 1000);

  const snap = snapshotSession(original);

  const restored = restoreSession(snap.vatBytes, snap.membraneBytes, { inlineSource: true });

  assertEquals(restored.get(0, 'a'), 1);
  assertEquals(restored.get(0, 'b'), 2);
  assertEquals(restored.get(0, 'c'), 3);

  // The restored session can keep parsing.
  const post = restored.parse('let d = c * 2');
  restored.mem.setContextInstructionIndex(0, post.startIndex);
  restored.mem.clearExitCondition(0);
  restored.run(0, 1000);
  assertEquals(restored.get(0, 'd'), 6);
});

// =============================================================================
// inlineSource: false → true / true → false mismatch
// =============================================================================

// Removed: under host-owned-memory the inlineSource flag on restore
// is meaningless — restoreSession reads astRegionSize from the
// snapshot bytes, so a no-AST snapshot stays a no-AST session
// regardless of what the caller passes. (Previously, the test asked
// that opting INTO inlineSource on restore would throw when the
// snapshot lacked an AST region; that error path is gone because
// the flag itself is.)

Deno.test("inlineSource: true → false on resume — restore succeeds, AST is dead weight", () => {
  const original = freshSession({ inlineSource: true });
  original.parse('let x = 42');
  original.run(0, 1000);
  const snap = snapshotSession(original);

  // Restore without inlineSource — the writer is the no-op writer; AST
  // bytes ride along but nothing reads them.
  const restored = restoreSession(snap.vatBytes, snap.membraneBytes, { inlineSource: false });

  assertEquals(restored.get(0, 'x'), 42);
});

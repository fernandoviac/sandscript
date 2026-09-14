/**
 * Tests for multi-context execution data structures.
 * Phase 2: Context 0 is auto-allocated during initialize().
 */

import {
  assertEquals,
  assertThrows,
} from "https://deno.land/std@0.208.0/assert/mod.ts";
import { createTestContext } from './interpreter-test-utils.js';
import { freshSession } from '../../src/host-owned-session.js';
import {
  CONTEXT_STATUS_FREE,
} from '../../src/fuel/constants.js';

Deno.test("context 0 is auto-allocated during initialize", () => {
  const { mem } = createTestContext();
  // Phase 2: context 0 is allocated automatically
  assertEquals(mem.getContextCount(), 1);
  // Context 0 should have valid exit condition (not FREE)
  assertEquals(mem.getExitCondition(0) !== CONTEXT_STATUS_FREE, true);
});

Deno.test("additional allocations return sequential slots", () => {
  const { mem } = createTestContext();
  // Context 0 already allocated, so next is 1
  assertEquals(mem.allocateContext(), 1);
  assertEquals(mem.allocateContext(), 2);
  assertEquals(mem.allocateContext(), 3);
  assertEquals(mem.getContextCount(), 4);
});

Deno.test("freed context is reused", () => {
  const { mem } = createTestContext();
  // Context 0 already allocated
  const slot1 = mem.allocateContext();  // slot 1
  const slot2 = mem.allocateContext();  // slot 2

  mem.freeContext(slot1);

  const slot3 = mem.allocateContext();
  assertEquals(slot3, 1);  // reused slot1
});

Deno.test("allocation reuses lowest free slot first", () => {
  const { mem } = createTestContext();
  // Context 0 already allocated
  const slot1 = mem.allocateContext();  // slot 1
  const slot2 = mem.allocateContext();  // slot 2
  const slot3 = mem.allocateContext();  // slot 3

  mem.freeContext(slot1);
  mem.freeContext(slot3);

  assertEquals(mem.allocateContext(), 1);  // lowest free slot
  assertEquals(mem.allocateContext(), 3);  // next free slot
  assertEquals(mem.allocateContext(), 4);  // new slot
});

Deno.test("free context has CONTEXT_STATUS_FREE", () => {
  const { mem } = createTestContext();
  const slot = mem.allocateContext();  // slot 1 (0 already allocated)

  mem.freeContext(slot);

  assertEquals(mem.getExitCondition(slot), CONTEXT_STATUS_FREE);
});

Deno.test("context state fields are independent", () => {
  const { mem } = createTestContext();
  // Context 0 already allocated, use it and allocate another
  const slot0 = 0;
  const slot1 = mem.allocateContext();  // slot 1

  mem.setContextScope(slot0, 1000);
  mem.setContextScope(slot1, 2000);
  mem.setContextInstructionIndex(slot0, 100);
  mem.setContextInstructionIndex(slot1, 200);

  assertEquals(mem.getContextScope(slot0), 1000);
  assertEquals(mem.getContextScope(slot1), 2000);
  assertEquals(mem.getContextInstructionIndex(slot0), 100);
  assertEquals(mem.getContextInstructionIndex(slot1), 200);
});

Deno.test("stack pointers initialize to their own block bases (Design B)", () => {
  const { mem } = createTestContext();
  // Design B: each stack is its own heap block. An empty stack's top pointer
  // equals that stack block's base (read from the state block).
  const slot = 0;

  assertEquals(mem.getContextPendingPointer(slot), mem.getPendingStackBase(slot));
  assertEquals(mem.getContextCallStackPointer(slot), mem.getCallStackBase(slot));
  assertEquals(mem.getContextTryStackPointer(slot), mem.getTryStackBase(slot));
  assertEquals(mem.getContextGrantStackPointer(slot), mem.getGrantStackBase(slot));
});

Deno.test("context object bases are distinct heap pointers (Design B)", () => {
  const { mem } = createTestContext();
  // Design B: context objects live on the heap, so bases are NOT a fixed
  // stride apart — only required to be distinct, non-zero pointers.
  const slot1 = mem.allocateContext();

  const base0 = mem.getContextBase(0);
  const base1 = mem.getContextBase(slot1);

  assertEquals(base0 > 0, true);
  assertEquals(base1 > 0, true);
  assertEquals(base0 !== base1, true);
});

Deno.test("context table pointer is set after initialize", () => {
  const { mem } = createTestContext();
  const tablePointer = mem.getContextTablePointer();
  // Table pointer should be non-zero after initialization
  assertEquals(tablePointer > 0, true);
});

Deno.test("no free slots when all contexts in use", () => {
  const { mem } = createTestContext();
  // Context 0 auto-allocated, allocate more
  const slot1 = mem.allocateContext();
  const slot2 = mem.allocateContext();

  // All slots in use, next allocation gets new slot
  assertEquals(mem.getContextCount(), 3);
  const slot3 = mem.allocateContext();
  assertEquals(slot3, 3);
  assertEquals(mem.getContextCount(), 4);
});

// Test removed: "can set and get current context"
// The host-owned execution model removes the concept of "current context" from memory.
// The host (session/inspector) tracks which context to run.

Deno.test("context completion fields work", () => {
  const { mem } = createTestContext();
  // Use context 0 (already allocated)
  const slot = 0;

  mem.setContextCompletionType(slot, 2);
  mem.setContextCompletionValue(slot, 12345);

  assertEquals(mem.getContextCompletionType(slot), 2);
  assertEquals(mem.getContextCompletionValue(slot), 12345);
});

// CODE_BLOCK field removed in Phase 2 (only one code block per session)

Deno.test("context continuation id field works", () => {
  const { mem } = createTestContext();
  const slot = mem.allocateContext();

  mem.setContextContinuationId(slot, 42);
  assertEquals(mem.getContextContinuationId(slot), 42);
});

// =============================================================================
// Extended Allocation Tests
// =============================================================================

Deno.test("many allocate/free cycles reuse slots", () => {
  // Design B: the default context region (slot→pointer table) holds 1024 slots,
  // ample for the handful here — no size override needed.
  const { mem } = createTestContext();

  // Allocate 10 contexts (0 is already allocated)
  const slots = [];
  for (let i = 0; i < 10; i++) {
    slots.push(mem.allocateContext());
  }
  assertEquals(mem.getContextCount(), 11);

  // Free all
  for (const slot of slots) {
    mem.freeContext(slot);
  }

  // Reallocate - should reuse freed slots in order (lowest first)
  const reallocated = [];
  for (let i = 0; i < 10; i++) {
    reallocated.push(mem.allocateContext());
  }

  // Should reuse slots 1-10 in ascending order
  assertEquals(reallocated[0], 1);
  assertEquals(reallocated[9], 10);
});

Deno.test("interleaved allocate/free reuses lowest slot", () => {
  const { mem } = createTestContext();

  const slot1 = mem.allocateContext(); // 1
  const slot2 = mem.allocateContext(); // 2
  mem.freeContext(slot1);              // free 1
  const slot3 = mem.allocateContext(); // should get 1 (lowest free)
  assertEquals(slot3, slot1);

  mem.freeContext(slot2);              // free 2
  mem.freeContext(slot3);              // free 1 again
  const slot4 = mem.allocateContext(); // should get 1 (lowest free)
  const slot5 = mem.allocateContext(); // should get 2
  assertEquals(slot4, slot1);
  assertEquals(slot5, slot2);
});

Deno.test("context count doesn't grow when reusing freed slots", () => {
  const { mem } = createTestContext();

  const initialCount = mem.getContextCount();

  // Allocate and free same slot repeatedly
  for (let i = 0; i < 20; i++) {
    const slot = mem.allocateContext();
    mem.freeContext(slot);
  }

  // Count should only have grown by 1 (the one slot we kept reusing)
  assertEquals(mem.getContextCount(), initialCount + 1);
});

Deno.test("slot identity preserved after multiple free/realloc", () => {
  const { mem } = createTestContext();

  const slot = mem.allocateContext();

  // Free and reallocate multiple times. Design B: the slot NUMBER (identity)
  // is reused, but the context object is freshly heap-allocated each time, so
  // its base may differ — identity is the stable thing, not the address.
  for (let i = 0; i < 5; i++) {
    mem.freeContext(slot);
    const realloc = mem.allocateContext();
    assertEquals(realloc, slot);
    assertEquals(mem.getContextBase(realloc) > 0, true);
  }
});

Deno.test("context allocation generations reject stale slot owners", () => {
  const { mem } = createTestContext();
  const slot = mem.allocateContext();
  const firstGeneration = mem.getContextGeneration(slot);
  assertEquals(firstGeneration, 1);
  assertEquals(mem.isContextIdentityLive(slot, firstGeneration), true);

  mem.freeContext(slot, firstGeneration);
  assertEquals(mem.isContextIdentityLive(slot, firstGeneration), false);
  assertEquals(mem.getContextGeneration(slot), firstGeneration);

  assertEquals(mem.allocateContext(), slot);
  const secondGeneration = mem.getContextGeneration(slot);
  assertEquals(secondGeneration, firstGeneration + 1);
  assertEquals(mem.isContextIdentityLive(slot, firstGeneration), false);
  assertEquals(mem.isContextIdentityLive(slot, secondGeneration), true);
  assertThrows(
    () => mem.freeContext(slot, firstGeneration),
    Error,
    "stale context identity",
  );
  assertEquals(mem.isContextIdentityLive(slot, secondGeneration), true);
});

Deno.test("session.run rejects a stale asynchronous context identity", () => {
  const session = freshSession();
  const slot = session.memoryImage.allocateContext();
  const generation = session.memoryImage.getContextGeneration(slot);
  session.memoryImage.freeContext(slot, generation);
  assertEquals(session.memoryImage.allocateContext(), slot);

  assertThrows(
    () => session.run({ slot, generation }, 100),
    Error,
    "stale context identity",
  );
});

// =============================================================================
// Context State Independence Tests
// =============================================================================

Deno.test("multiple contexts have independent stack pointers", () => {
  const { mem } = createTestContext();

  const slot0 = 0; // Already allocated
  const slot1 = mem.allocateContext();
  const slot2 = mem.allocateContext();

  // Modify stack pointers independently
  const base0 = mem.getContextBase(slot0);
  const base1 = mem.getContextBase(slot1);
  const base2 = mem.getContextBase(slot2);

  mem.setContextPendingPointer(slot0, base0 + 0x0010);
  mem.setContextPendingPointer(slot1, base1 + 0x0020);
  mem.setContextPendingPointer(slot2, base2 + 0x0030);

  assertEquals(mem.getContextPendingPointer(slot0), base0 + 0x0010);
  assertEquals(mem.getContextPendingPointer(slot1), base1 + 0x0020);
  assertEquals(mem.getContextPendingPointer(slot2), base2 + 0x0030);
});

Deno.test("context exit condition is FREE after freeContext", () => {
  const { mem } = createTestContext();

  const slot = mem.allocateContext();

  // Free resets to FREE
  mem.freeContext(slot);
  assertEquals(mem.getExitCondition(slot), CONTEXT_STATUS_FREE);
});

// Removed: "context fuel field works" test
// Fuel is now owned by JS (airlock.js), not stored per-context in memory.

// =============================================================================
// Boundary Tests
// =============================================================================

Deno.test("allocating many contexts doesn't corrupt memory", () => {
  // Design B: default table holds 1024 slots, ample for the 21 used here.
  const { mem } = createTestContext();

  const slots = [];
  // Allocate 20 contexts
  for (let i = 0; i < 20; i++) {
    slots.push(mem.allocateContext());
  }

  // Write unique values to each
  for (let i = 0; i < slots.length; i++) {
    mem.setContextScope(slots[i], 1000 + i);
    mem.setContextInstructionIndex(slots[i], 2000 + i);
  }

  // Verify all values are intact
  for (let i = 0; i < slots.length; i++) {
    assertEquals(mem.getContextScope(slots[i]), 1000 + i);
    assertEquals(mem.getContextInstructionIndex(slots[i]), 2000 + i);
  }
});

Deno.test("context bases don't overlap", () => {
  const { mem } = createTestContext();

  const slots = [];
  for (let i = 0; i < 5; i++) {
    slots.push(mem.allocateContext());
  }

  // Design B: context objects are distinct heap allocations, so their bases
  // must all be unique (no fixed stride).
  const bases = slots.map((s) => mem.getContextBase(s));
  assertEquals(new Set(bases).size, bases.length);
  for (const base of bases) assertEquals(base > 0, true);
});

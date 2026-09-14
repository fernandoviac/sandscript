/**
 * Host-side context stack pushes must grow beyond their initial capacity.
 * Per-stack growth shrank the initial stack-block sizes to the common case
 * and wired growth into the WAT push paths, but left the host-side push helpers
 * (pushFrame / pushPending / pushTryEntry / pushGrantEntry /
 * pushGrantEntryForCallback) throwing on overflow. A host callback with six
 * nested approved grants overflowed `pushGrantEntry` at the fifth grant.
 *
 * These tests pin: each host push helper grows its stack when the initial
 * 4-entry / common-case block fills, mirroring the WAT $grow_stack path.
 */

import { freshSession } from '../../src/host-owned-session.js';
import { CTX } from '../../src/fuel/constants.js';
import { assertEquals } from "https://deno.land/std@0.208.0/assert/mod.ts";

function stackCapacity(mem, baseField, limitField) {
  const sb = mem.abs(mem.getContextStateBase(0));
  return mem.view.getUint32(sb + limitField, true) - mem.view.getUint32(sb + baseField, true);
}

Deno.test("pushGrantEntry grows past the 4-entry initial grant stack", () => {
  const s = freshSession();
  const m = s.memoryImage;
  // The pending stack base has 16 zero bytes, perfect for the identifier copy.
  const idAddr = m.getPendingStackBase(0);
  const before = stackCapacity(m, CTX.GRANT_STACK_BASE, CTX.GRANT_STACK_LIMIT);

  // 8 entries (256 bytes) past the 128-byte initial — must grow.
  for (let i = 0; i < 8; i++) m.pushGrantEntry(0, idAddr, 1000 + i, 0);

  assertEquals(stackCapacity(m, CTX.GRANT_STACK_BASE, CTX.GRANT_STACK_LIMIT) > before, true);
});

Deno.test("pushGrantEntryForCallback grows past the 4-entry initial grant stack", () => {
  const s = freshSession();
  const m = s.memoryImage;
  const before = stackCapacity(m, CTX.GRANT_STACK_BASE, CTX.GRANT_STACK_LIMIT);

  for (let i = 0; i < 8; i++) m.pushGrantEntryForCallback(0, 2000 + i);

  assertEquals(stackCapacity(m, CTX.GRANT_STACK_BASE, CTX.GRANT_STACK_LIMIT) > before, true);
});

Deno.test("pushTryEntry grows past the 4-entry initial try stack", () => {
  const s = freshSession();
  const m = s.memoryImage;
  const before = stackCapacity(m, CTX.TRY_STACK_BASE, CTX.TRY_STACK_LIMIT);

  for (let i = 0; i < 8; i++) m.pushTryEntry(0, 100 + i, 200 + i);

  assertEquals(stackCapacity(m, CTX.TRY_STACK_BASE, CTX.TRY_STACK_LIMIT) > before, true);
});

Deno.test("pushFrame grows past the initial call stack", () => {
  const s = freshSession();
  const m = s.memoryImage;
  const before = stackCapacity(m, CTX.CALL_STACK_BASE, CTX.CALL_STACK_LIMIT);

  // FRAME_SIZE is 60; initial 512 bytes ≈ 8 frames. 12 forces growth.
  for (let i = 0; i < 12; i++) m.pushFrame(0, 0, 0, 0, 0);

  assertEquals(stackCapacity(m, CTX.CALL_STACK_BASE, CTX.CALL_STACK_LIMIT) > before, true);
});

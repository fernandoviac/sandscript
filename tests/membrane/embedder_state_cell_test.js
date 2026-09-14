/**
 * Embedder-state cell.
 *
 * Single mutable, snapshot-surviving cell for the embedder's
 * correlation state. Singular (no name keying), arena-stored,
 * msgpack-opaque to sandscript.
 */

import { assertEquals, assert } from "https://deno.land/std@0.208.0/assert/mod.ts";
import {
  Membrane,
  HEADER,
  VALUE_POINTER_NULL,
} from '../../src/membrane/index.js';
import { freshMembrane, freshSession, restoreSession, snapshotSession } from '../../src/host-owned-session.js';
import { createSession } from '../../src/fuel/session.js';

Deno.test("v8: embedder-state pointer slot exists at header offset 268", () => {
  assertEquals(HEADER.EMBEDDER_STATE_VALUE_POINTER, 268);
});

Deno.test("v8: fresh membrane initializes the embedder-state cell to NULL", () => {
  const m = freshMembrane();
  const ptr = m.view.getUint32(HEADER.EMBEDDER_STATE_VALUE_POINTER, true);
  assertEquals(ptr, VALUE_POINTER_NULL);
  assertEquals(m.getEmbedderState(), null);
});

Deno.test("setEmbedderState / getEmbedderState round-trip", () => {
  const m = freshMembrane();
  m.setEmbedderState({ callIdToSlot: { "abc": 3, "xyz": 7 }, generation: 12 });
  const back = m.getEmbedderState();
  assertEquals(back.callIdToSlot.abc, 3);
  assertEquals(back.callIdToSlot.xyz, 7);
  assertEquals(back.generation, 12);
});

Deno.test("setEmbedderState(null) clears the cell", () => {
  const m = freshMembrane();
  m.setEmbedderState({ foo: 1 });
  assert(m.getEmbedderState() !== null);
  m.setEmbedderState(null);
  assertEquals(m.getEmbedderState(), null);
  // Header pointer is back to the NULL sentinel.
  assertEquals(
    m.view.getUint32(HEADER.EMBEDDER_STATE_VALUE_POINTER, true),
    VALUE_POINTER_NULL);
});

Deno.test("setEmbedderState(undefined) clears the cell", () => {
  const m = freshMembrane();
  m.setEmbedderState({ foo: 1 });
  m.setEmbedderState(undefined);
  assertEquals(m.getEmbedderState(), null);
});

Deno.test("setEmbedderState overwrites prior value", () => {
  const m = freshMembrane();
  m.setEmbedderState({ generation: 1 });
  m.setEmbedderState({ generation: 2 });
  assertEquals(m.getEmbedderState().generation, 2);
});

Deno.test("Embedder state survives snapshot/restore (session-level)", () => {
  const original = freshSession();
  original.airlock.membrane.setEmbedderState({
    correlations: [{ callId: "c1", slot: 4 }, { callId: "c2", slot: 7 }],
    epoch: 42,
  });
  const snap = snapshotSession(original);

  const restored = restoreSession(snap.vatBytes, snap.membraneBytes);
  const recovered = restored.airlock.membrane.getEmbedderState();
  assertEquals(recovered.epoch, 42);
  assertEquals(recovered.correlations.length, 2);
  assertEquals(recovered.correlations[0].callId, "c1");
  assertEquals(recovered.correlations[0].slot, 4);
});

Deno.test("Embedder state survives compaction", () => {
  const session = freshSession();
  const m = session.airlock.membrane;
  m.setEmbedderState({ marker: 'before-compact', big: 'x'.repeat(200) });
  // Churn the arena so compaction has work to do — multiple
  // overwrites of the same cell orphan arena bytes.
  for (let i = 0; i < 5; i++) {
    m.setEmbedderState({ marker: 'before-compact', big: 'x'.repeat(200), iter: i });
  }
  const arenaUsedBefore = m.view.getUint32(HEADER.VALUE_ARENA_USED, true);
  session.airlock.compactMembrane();
  const arenaUsedAfter = m.view.getUint32(HEADER.VALUE_ARENA_USED, true);
  assert(arenaUsedAfter < arenaUsedBefore,
    `compaction should reclaim orphaned arena bytes: before=${arenaUsedBefore} after=${arenaUsedAfter}`);
  const after = m.getEmbedderState();
  assertEquals(after.marker, 'before-compact');
  assertEquals(after.iter, 4);
});

Deno.test("Compaction preserves NULL embedder-state cell", () => {
  const session = freshSession();
  const m = session.airlock.membrane;
  // Never call setEmbedderState — cell stays NULL.
  session.airlock.compactMembrane();
  assertEquals(m.getEmbedderState(), null);
  assertEquals(
    m.view.getUint32(HEADER.EMBEDDER_STATE_VALUE_POINTER, true),
    VALUE_POINTER_NULL);
});

Deno.test("Embedder state and capability state coexist", () => {
  const session = freshSession();
  const m = session.airlock.membrane;
  m.setCapabilityState('fetch', { lastSeq: 99 });
  m.setEmbedderState({ correlations: 7 });
  assertEquals(m.getCapabilityState('fetch').lastSeq, 99);
  assertEquals(m.getEmbedderState().correlations, 7);

  // Both survive snapshot/restore together.
  const snap = snapshotSession(session);
  const restored = restoreSession(snap.vatBytes, snap.membraneBytes);
  const rm = restored.airlock.membrane;
  assertEquals(rm.getCapabilityState('fetch').lastSeq, 99);
  assertEquals(rm.getEmbedderState().correlations, 7);
});

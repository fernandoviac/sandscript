/**
 * v9 linked-promise PARKED_CONTEXT_SLOT field.
 *
 * Run with: deno task test tests/membrane/linked_promise_parked_context_slot_test.js
 *
 * A per-entry i32 field in the membrane linked-promise table records which
 * SandScript context a context.suspend settlement should wake.
 * JS-Promise-backed entries leave the field at its -1 sentinel.
 *
 * These tests cover the membrane-layer contract only:
 *   - registerLinkedPromise defaults parkedContextSlot to -1.
 *   - registerLinkedPromise with an explicit option stores the slot.
 *   - enumerateLinkedPromises surfaces the field per entry.
 *   - The field survives a snapshot/restore round-trip.
 */

import { assertEquals } from "https://deno.land/std@0.208.0/assert/mod.ts";
import {
  Membrane,
  LINKED_PROMISE_NO_PARKED_CONTEXT,
} from '../../src/membrane/index.js';
import { freshMembrane } from '../../src/host-owned-session.js';

Deno.test("registerLinkedPromise: parkedContextSlot defaults to -1 (JS-Promise path)", () => {
  const m = freshMembrane();
  const slot = m.registerLinkedPromise(0x1000);
  const entries = m.enumerateLinkedPromises();
  assertEquals(entries.length, 1);
  assertEquals(entries[0].slot, slot);
  assertEquals(entries[0].parkedContextSlot, LINKED_PROMISE_NO_PARKED_CONTEXT);
});

Deno.test("registerLinkedPromise: explicit parked identity is stored and surfaced", () => {
  const m = freshMembrane();
  const slot = m.registerLinkedPromise(0x2000, {
    parkedContextSlot: 42,
    parkedContextGeneration: 7,
  });
  const entries = m.enumerateLinkedPromises();
  assertEquals(entries.length, 1);
  assertEquals(entries[0].slot, slot);
  assertEquals(entries[0].parkedContextSlot, 42);
  assertEquals(entries[0].parkedContextGeneration, 7);
});

Deno.test("registerLinkedPromise: parkedContextSlot survives snapshot/restore", () => {
  const original = freshMembrane();
  const jsBacked = original.registerLinkedPromise(0x3000);
  const suspendBacked = original.registerLinkedPromise(0x4000, {
    parkedContextSlot: 7,
    parkedContextGeneration: 11,
  });

  const bytes = original.bytes();
  // Attach over the existing bytes via the bare Membrane constructor
  // (freshMembrane always lays out fresh, which would clobber the
  // snapshot we just captured).
  const buffer = bytes.slice().buffer;
  const restored = new Membrane({ buffer, byteOffset: 0, byteLength: buffer.byteLength });

  const entries = restored.enumerateLinkedPromises();
  // Index by slot — enumeration order is slot ascending but be explicit.
  const bySlot = new Map(entries.map(e => [e.slot, e]));
  assertEquals(bySlot.get(jsBacked).parkedContextSlot, LINKED_PROMISE_NO_PARKED_CONTEXT);
  assertEquals(bySlot.get(suspendBacked).parkedContextSlot, 7);
  assertEquals(bySlot.get(suspendBacked).parkedContextGeneration, 11);
});

Deno.test("_readLinkedPromiseParkedContextSlot: returns -1 for non-live slots", () => {
  const m = freshMembrane();
  const slot = m.registerLinkedPromise(0x5000, { parkedContextSlot: 99 });
  assertEquals(m._readLinkedPromiseParkedContextSlot(slot), 99);
  m._freeLinkedPromiseSlot(slot);
  assertEquals(m._readLinkedPromiseParkedContextSlot(slot), LINKED_PROMISE_NO_PARKED_CONTEXT);
});

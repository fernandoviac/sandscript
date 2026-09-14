/**
 * Capability-state table region in the membrane SAB. These tests verify the
 * header slots and constructor option, createSession option, initialized NULL
 * sentinels, snapshot/restore persistence, and resizeRegions growth and
 * shrinkage.
 */

import { assertEquals, assertThrows } from "https://deno.land/std@0.208.0/assert/mod.ts";
import {
  Membrane,
  MEMBRANE_HEADER_SIZE,
  HEADER,
  CAPABILITY_STATE_ENTRY_SIZE,
  DEFAULT_CAPABILITY_STATE_TABLE_CAPACITY,
  VALUE_POINTER_NULL,
  MembraneOutOfSpaceError,
} from '../../src/membrane/index.js';
import { DRONE_FORMAT_VERSION } from '../../src/persisted-format.js';
import { freshMembrane, freshSession, restoreSession, snapshotSession } from '../../src/host-owned-session.js';
import { createSession } from '../../src/fuel/session.js';

Deno.test("v7: capability-state table header slots exist at 260/264", () => {
  assertEquals(HEADER.CAPABILITY_STATE_TABLE_OFFSET,   260);
  assertEquals(HEADER.CAPABILITY_STATE_TABLE_CAPACITY, 264);
});

Deno.test("aggregate drone format version is current", () => {
  assertEquals(DRONE_FORMAT_VERSION, 3);
});

Deno.test("v7: fresh membrane initializes the capability-state table after the ledger", () => {
  const m = freshMembrane();
  const offset = m.view.getUint32(HEADER.CAPABILITY_STATE_TABLE_OFFSET, true);
  const capacity = m.view.getUint32(HEADER.CAPABILITY_STATE_TABLE_CAPACITY, true);
  assertEquals(capacity, DEFAULT_CAPABILITY_STATE_TABLE_CAPACITY);
  // Offset must sit past the ledger and inside the buffer.
  assertEquals(offset > 0, true);
  assertEquals(offset + capacity * CAPABILITY_STATE_ENTRY_SIZE <= m.byteLength, true);
});

Deno.test("v7: every table entry initializes to NULL sentinels", () => {
  const m = freshMembrane({ capabilityStateTableCapacity: 16 });
  const offset = m.view.getUint32(HEADER.CAPABILITY_STATE_TABLE_OFFSET, true);
  for (let i = 0; i < 16; i++) {
    const entry = offset + i * CAPABILITY_STATE_ENTRY_SIZE;
    assertEquals(m.view.getUint32(entry, true),     VALUE_POINTER_NULL);
    assertEquals(m.view.getUint32(entry + 4, true), VALUE_POINTER_NULL);
  }
});

Deno.test("v7: freshSession() flows through to the membrane", () => {
  const session = freshSession({ capabilityStateTableCapacity: 32 });
  const m = session.airlock.membrane;
  assertEquals(
    m.view.getUint32(HEADER.CAPABILITY_STATE_TABLE_CAPACITY, true),
    32);
});

Deno.test("v7: capability-state table survives snapshot/restore", () => {
  const session = freshSession({ capabilityStateTableCapacity: 24 });
  const bytes = snapshotSession(session).membraneBytes;
  const restored = restoreSession(snapshotSession(session).vatBytes, bytes);
  const m = restored.airlock.membrane;
  assertEquals(
    m.view.getUint32(HEADER.CAPABILITY_STATE_TABLE_CAPACITY, true),
    24);
  // Sentinels still in place.
  const offset = m.view.getUint32(HEADER.CAPABILITY_STATE_TABLE_OFFSET, true);
  for (let i = 0; i < 24; i++) {
    const entry = offset + i * CAPABILITY_STATE_ENTRY_SIZE;
    assertEquals(m.view.getUint32(entry, true),     VALUE_POINTER_NULL);
    assertEquals(m.view.getUint32(entry + 4, true), VALUE_POINTER_NULL);
  }
});

Deno.test("v7: resizeRegions can grow the capability-state table; new tail entries are NULL-initialized", () => {
  // resizeRegions needs envelope headroom to grow a region — that's a
  // host responsibility (see the "oversized buffer is fine" test).
  // 4 KB of slack comfortably absorbs +24 slots * 8 bytes.
  const buffer = new ArrayBuffer(2 * 1024 * 1024);
  const m = freshMembrane({ buffer, capabilityStateTableCapacity: 8 });
  m.resizeRegions({ capabilityStateTableCapacity: 32 });
  assertEquals(
    m.view.getUint32(HEADER.CAPABILITY_STATE_TABLE_CAPACITY, true),
    32);
  const offset = m.view.getUint32(HEADER.CAPABILITY_STATE_TABLE_OFFSET, true);
  for (let i = 0; i < 32; i++) {
    const entry = offset + i * CAPABILITY_STATE_ENTRY_SIZE;
    assertEquals(m.view.getUint32(entry, true),     VALUE_POINTER_NULL,
      `slot ${i} namePointer must be NULL`);
    assertEquals(m.view.getUint32(entry + 4, true), VALUE_POINTER_NULL,
      `slot ${i} valuePointer must be NULL`);
  }
});

Deno.test("v7: resizeRegions can shrink the capability-state table when no populated slots are past the boundary", () => {
  const m = freshMembrane({ capabilityStateTableCapacity: 32 });
  // Every slot starts NULL, so shrinking an untouched table is safe.
  m.resizeRegions({ capabilityStateTableCapacity: 8 });
  assertEquals(
    m.view.getUint32(HEADER.CAPABILITY_STATE_TABLE_CAPACITY, true),
    8);
});

Deno.test("v7: resizeRegions rejects shrink that would orphan a populated slot", () => {
  const m = freshMembrane({ capabilityStateTableCapacity: 32 });
  // Poke a non-NULL namePointer into slot 16, past the shrink boundary of 8.
  // The guard reads namePointer to detect occupancy.
  const offset = m.view.getUint32(HEADER.CAPABILITY_STATE_TABLE_OFFSET, true);
  const slot16Entry = offset + 16 * CAPABILITY_STATE_ENTRY_SIZE;
  m.view.setUint32(slot16Entry, 0x1234, true); // fake populated namePointer
  assertThrows(
    () => m.resizeRegions({ capabilityStateTableCapacity: 8 }),
    MembraneOutOfSpaceError,
    'capabilityStateTableCapacity',
  );
});

Deno.test("v7: resizeRegions preserves populated entries across grow", () => {
  const buffer = new ArrayBuffer(2 * 1024 * 1024);
  const m = freshMembrane({ buffer, capabilityStateTableCapacity: 4 });
  // Poke a fake populated entry into slot 2.
  const oldOffset = m.view.getUint32(HEADER.CAPABILITY_STATE_TABLE_OFFSET, true);
  const slot2 = oldOffset + 2 * CAPABILITY_STATE_ENTRY_SIZE;
  m.view.setUint32(slot2,     0xCAFE0000, true); // fake namePointer
  m.view.setUint32(slot2 + 4, 0xCAFE0001, true); // fake valuePointer

  m.resizeRegions({ capabilityStateTableCapacity: 16 });

  const newOffset = m.view.getUint32(HEADER.CAPABILITY_STATE_TABLE_OFFSET, true);
  const slot2New = newOffset + 2 * CAPABILITY_STATE_ENTRY_SIZE;
  assertEquals(m.view.getUint32(slot2New, true),     0xCAFE0000);
  assertEquals(m.view.getUint32(slot2New + 4, true), 0xCAFE0001);
});

// ============================================================================
// Public capability-state API
// ============================================================================

Deno.test("setCapabilityState / getCapabilityState round-trip", () => {
  const m = freshMembrane();
  m.setCapabilityState('fetch', { nextRequestId: 42 });
  assertEquals(m.getCapabilityState('fetch'), { nextRequestId: 42 });
});

Deno.test("getCapabilityState returns null for an unknown name", () => {
  const m = freshMembrane();
  assertEquals(m.getCapabilityState('never-set'), null);
});

Deno.test("setCapabilityState overwrites a prior value", () => {
  const m = freshMembrane();
  m.setCapabilityState('http-ingress', { phase: 'negotiating' });
  m.setCapabilityState('http-ingress', { phase: 'connected', listeners: 3 });
  assertEquals(m.getCapabilityState('http-ingress'),
    { phase: 'connected', listeners: 3 });
});

Deno.test("setCapabilityState(name, null) clears the cell; getCapabilityState returns null", () => {
  const m = freshMembrane();
  m.setCapabilityState('counter', 5);
  m.setCapabilityState('counter', null);
  assertEquals(m.getCapabilityState('counter'), null);
  // The slot is still leased — setting again works without growing the table.
  m.setCapabilityState('counter', 7);
  assertEquals(m.getCapabilityState('counter'), 7);
});

Deno.test("multiple distinct names live in distinct slots", () => {
  const m = freshMembrane();
  m.setCapabilityState('a', 1);
  m.setCapabilityState('b', 'two');
  m.setCapabilityState('c', [3, 3, 3]);
  assertEquals(m.getCapabilityState('a'), 1);
  assertEquals(m.getCapabilityState('b'), 'two');
  assertEquals(m.getCapabilityState('c'), [3, 3, 3]);
});

Deno.test("setCapabilityState throws when the table is full and the name is new", () => {
  const m = freshMembrane({ capabilityStateTableCapacity: 3 });
  m.setCapabilityState('a', 1);
  m.setCapabilityState('b', 2);
  m.setCapabilityState('c', 3);
  assertThrows(
    () => m.setCapabilityState('d', 4),
    MembraneOutOfSpaceError,
    'Capability state table full',
  );
  // Overwriting an existing name in a full table is still allowed.
  m.setCapabilityState('a', 99);
  assertEquals(m.getCapabilityState('a'), 99);
});

Deno.test("setCapabilityState rejects non-string / empty names", () => {
  const m = freshMembrane();
  assertThrows(() => m.setCapabilityState('', 1), TypeError);
  assertThrows(() => m.setCapabilityState(null, 1), TypeError);
  assertThrows(() => m.setCapabilityState(42, 1), TypeError);
  assertThrows(() => m.getCapabilityState(''), TypeError);
});

Deno.test("capability state survives snapshot/restore via createSession", () => {
  const session = freshSession();
  session.airlock.membrane.setCapabilityState('fetch', { nextRequestId: 7 });
  session.airlock.membrane.setCapabilityState('http-ingress.listeners', ['a', 'b']);

  const snap = snapshotSession(session);
  const restored = restoreSession(snap.vatBytes, snap.membraneBytes);

  assertEquals(
    restored.airlock.membrane.getCapabilityState('fetch'),
    { nextRequestId: 7 });
  assertEquals(
    restored.airlock.membrane.getCapabilityState('http-ingress.listeners'),
    ['a', 'b']);
});

Deno.test("resizeRegions grows the table without disturbing populated entries", () => {
  const buffer = new ArrayBuffer(2 * 1024 * 1024);
  const m = freshMembrane({ buffer, capabilityStateTableCapacity: 4 });
  m.setCapabilityState('a', 1);
  m.setCapabilityState('b', { nested: 'value' });
  m.resizeRegions({ capabilityStateTableCapacity: 32 });
  assertEquals(m.getCapabilityState('a'), 1);
  assertEquals(m.getCapabilityState('b'), { nested: 'value' });
  // New tail slots are empty.
  assertEquals(m.getCapabilityState('c'), null);
  // ... and writable.
  m.setCapabilityState('c', 3);
  assertEquals(m.getCapabilityState('c'), 3);
});

Deno.test("compactMembrane preserves capability state and reclaims orphaned bytes", () => {
  const session = freshSession({ valueArenaSize: 4096 });
  const m = session.airlock.membrane;
  // Overwrite the same cell many times — each overwrite orphans the
  // previous value's arena bytes.
  for (let i = 0; i < 50; i++) {
    m.setCapabilityState('counter', { tick: i, payload: 'x'.repeat(20) });
  }
  const arenaUsedBefore = m.view.getUint32(HEADER.VALUE_ARENA_USED, true);
  session.airlock.compactMembrane();
  const arenaUsedAfter = m.view.getUint32(HEADER.VALUE_ARENA_USED, true);
  // The cell's final value survives compaction.
  assertEquals(m.getCapabilityState('counter'),
    { tick: 49, payload: 'x'.repeat(20) });
  // And the arena was actually compacted — only one (name, value) pair's
  // worth of bytes remains for this cell, plus whatever else is live.
  assertEquals(arenaUsedAfter < arenaUsedBefore, true,
    `arena should shrink: before=${arenaUsedBefore}, after=${arenaUsedAfter}`);
});

Deno.test("compactMembrane preserves a cleared (null-valued) capability cell", () => {
  const session = freshSession();
  const m = session.airlock.membrane;
  m.setCapabilityState('phase', 'init');
  m.setCapabilityState('phase', null); // cleared, slot still leased
  session.airlock.compactMembrane();
  assertEquals(m.getCapabilityState('phase'), null);
  // And re-setting still works after compaction.
  m.setCapabilityState('phase', 'connected');
  assertEquals(m.getCapabilityState('phase'), 'connected');
});

/**
 * Membrane format v5 test suite covering the runtime-state cell and
 * in-flight ledger regions.
 *
 * Run with: deno task test tests/membrane/format_v5_test.js
 */

import { assertEquals, assert } from "https://deno.land/std@0.208.0/assert/mod.ts";
import {
  Membrane,
  MEMBRANE_HEADER_SIZE,
  HEADER,
  RUNTIME_STATE,
  RUNTIME_STATE_CELL_BYTES,
  LEDGER_CAPACITY,
  DEFAULT_LEDGER_CAPACITY,
  LEDGER_ENTRY_BYTES,
  LEDGER_REGION_BYTES,
} from '../../src/membrane/index.js';
import { DRONE_FORMAT_VERSION } from '../../src/persisted-format.js';
import { computeMembraneLayout } from '../../src/membrane/membrane-layout.js';
import { freshMembrane, freshSession, restoreSession, snapshotSession } from '../../src/host-owned-session.js';
import { createSession } from '../../src/fuel/session.js';
import { createLedgerView, LEDGER_ACTIVITY } from '../../src/runtime/ledger.js';
import { createRuntimeStateView } from '../../src/runtime/runtime-state.js';

// =============================================================================
// Format identity
// =============================================================================

Deno.test("aggregate drone format version is current", () => {
  assertEquals(DRONE_FORMAT_VERSION, 3);
});

Deno.test("v11: header is 296 bytes (cost-ledger fields grew it from 280)", () => {
  assertEquals(MEMBRANE_HEADER_SIZE, 296);
});

Deno.test("v14: cost-ledger segment fields use reserved header words", () => {
  assertEquals(HEADER.COST_LEDGER_FLAGS, 276);
  assertEquals(HEADER.COST_LEDGER_WRITE_INDEX, 288);
  assertEquals(HEADER.COST_LEDGER_SEGMENT_GENERATION, 292);
  const membrane = freshMembrane();
  assertEquals(
    membrane.view.getUint32(HEADER.COST_LEDGER_FLAGS, true), 0);
  assertEquals(
    membrane.view.getUint32(
      HEADER.COST_LEDGER_SEGMENT_GENERATION, true),
    1);
});

Deno.test("v7: HEADER has RUNTIME_STATE_OFFSET, LEDGER_OFFSET, LEDGER_CAPACITY fields", () => {
  // Header field layout: 248 + 4 + 4 + 4 + (260..267 capability-state)
  // + remaining slack to 280.
  assertEquals(HEADER.RUNTIME_STATE_OFFSET, 248);
  assertEquals(HEADER.LEDGER_OFFSET,        252);
  assertEquals(HEADER.LEDGER_CAPACITY,      256);
  assertEquals(HEADER.CAPABILITY_STATE_TABLE_OFFSET,   260);
  assertEquals(HEADER.CAPABILITY_STATE_TABLE_CAPACITY, 264);
});

Deno.test("v5: ledger region constants are exposed", () => {
  assertEquals(RUNTIME_STATE_CELL_BYTES, 4);
  assertEquals(LEDGER_ENTRY_BYTES, 24);
  assertEquals(LEDGER_CAPACITY, 256);
  assertEquals(LEDGER_REGION_BYTES, 256 * 24);
  assertEquals(LEDGER_REGION_BYTES, 6144);
});

// =============================================================================
// Fresh membrane initial state
// =============================================================================

Deno.test("v5: fresh membrane writes runtime-state cell offset and ledger offset into the header", () => {
  const m = freshMembrane({
    handleTableCapacity: 16,
    grantTableCapacity: 8,
    idListPoolSize: 256,
    rootGrantsListCapacity: 4,
    valueArenaSize: 256,
    closureHandleTableCapacity: 4,
    linkedPromiseTableCapacity: 4,
    mutationLogCapacity: 16,
    costLedgerCapacity: 16,
  });
  const runtimeStateOffset = m.view.getUint32(HEADER.RUNTIME_STATE_OFFSET, true);
  const ledgerOffset       = m.view.getUint32(HEADER.LEDGER_OFFSET, true);
  const ledgerCapacity     = m.view.getUint32(HEADER.LEDGER_CAPACITY, true);

  // Both offsets sit past the header, within the membrane's window.
  assert(runtimeStateOffset >= MEMBRANE_HEADER_SIZE,
    `runtimeStateOffset ${runtimeStateOffset} must be past header`);
  assert(ledgerOffset >= MEMBRANE_HEADER_SIZE,
    `ledgerOffset ${ledgerOffset} must be past header`);
  assert(ledgerOffset + LEDGER_REGION_BYTES <= m.byteLength,
    `ledger region must fit within the membrane window`);
  // The cell sits just before the ledger (they're adjacent in v5).
  assertEquals(runtimeStateOffset + RUNTIME_STATE_CELL_BYTES, ledgerOffset,
    'cell and ledger should be adjacent in v5');
  assertEquals(ledgerCapacity, LEDGER_CAPACITY);
});

Deno.test("v5: fresh runtime-state cell holds SCHEDULER_IDLE", () => {
  const m = freshMembrane();
  const runtimeStateOffset = m.view.getUint32(HEADER.RUNTIME_STATE_OFFSET, true);
  const cellValue = m.view.getUint32(runtimeStateOffset, true);
  assertEquals(cellValue, RUNTIME_STATE.SCHEDULER_IDLE);
});

Deno.test("v5: fresh ledger region is entirely zero (every entry FREE)", () => {
  const m = freshMembrane();
  const ledgerOffset = m.view.getUint32(HEADER.LEDGER_OFFSET, true);
  const u8 = new Uint8Array(m.buffer, m.byteOffset + ledgerOffset, LEDGER_REGION_BYTES);
  for (let i = 0; i < u8.length; i++) {
    if (u8[i] !== 0) {
      throw new Error(`ledger byte ${i} is ${u8[i]}, expected 0`);
    }
  }
});

// =============================================================================
// resizeRegions: diagnostic-region offsets shift when earlier regions grow
// =============================================================================

Deno.test("v5: resizeRegions shifts ledger and state-cell offsets when handleTable grows", () => {
  // Start with a small membrane so we have headroom to grow into.
  // Use a host-supplied buffer larger than `required` so resize
  // has space.
  const initial = {
    handleTableCapacity: 16,
    grantTableCapacity: 8,
    idListPoolSize: 256,
    rootGrantsListCapacity: 4,
    valueArenaSize: 256,
    closureHandleTableCapacity: 4,
    linkedPromiseTableCapacity: 4,
    mutationLogCapacity: 16,
    costLedgerCapacity: 16,
  };
  // Pre-compute a generously-sized envelope so resize has room.
  const envelope = 64 * 1024;
  const buffer = new ArrayBuffer(envelope);
  const m = freshMembrane({ buffer, ...initial });

  const oldStateOffset  = m.view.getUint32(HEADER.RUNTIME_STATE_OFFSET, true);
  const oldLedgerOffset = m.view.getUint32(HEADER.LEDGER_OFFSET, true);

  // Grow handleTable by 16 slots (32 bytes each = 512 extra bytes).
  // Every region after handle table — including the two v5 regions —
  // shifts right by 512.
  m.resizeRegions({ handleTableCapacity: 32 });

  const newStateOffset  = m.view.getUint32(HEADER.RUNTIME_STATE_OFFSET, true);
  const newLedgerOffset = m.view.getUint32(HEADER.LEDGER_OFFSET, true);

  assertEquals(newStateOffset - oldStateOffset, 16 * 32,
    'state cell shifted right by exactly the handle-table growth');
  assertEquals(newLedgerOffset - oldLedgerOffset, 16 * 32,
    'ledger shifted right by exactly the handle-table growth');

  // Cell still adjacent to ledger.
  assertEquals(newStateOffset + RUNTIME_STATE_CELL_BYTES, newLedgerOffset);

  // Capacity unchanged.
  assertEquals(m.view.getUint32(HEADER.LEDGER_CAPACITY, true), LEDGER_CAPACITY);
});

Deno.test("v5: resizeRegions preserves the state-cell value across a region move", () => {
  // Put the cell into a non-default state, resize, confirm the
  // value survives the move.
  const envelope = 64 * 1024;
  const buffer = new ArrayBuffer(envelope);
  const m = freshMembrane({
    buffer,
    handleTableCapacity: 16, grantTableCapacity: 8,
    idListPoolSize: 256, rootGrantsListCapacity: 4,
    valueArenaSize: 256, closureHandleTableCapacity: 4,
    linkedPromiseTableCapacity: 4, mutationLogCapacity: 16,
    costLedgerCapacity: 16,
  });

  // Write GC into the cell.
  const oldStateOffset = m.view.getUint32(HEADER.RUNTIME_STATE_OFFSET, true);
  m.view.setUint32(oldStateOffset, RUNTIME_STATE.GC, true);

  // Resize.
  m.resizeRegions({ handleTableCapacity: 32 });

  // Read the cell at its NEW offset; should still hold GC.
  const newStateOffset = m.view.getUint32(HEADER.RUNTIME_STATE_OFFSET, true);
  assertEquals(m.view.getUint32(newStateOffset, true), RUNTIME_STATE.GC);
});

Deno.test("v5: resizeRegions preserves ledger bytes across a region move", () => {
  // Write a recognizable pattern into the ledger region, resize,
  // confirm the bytes survived intact at the new offset.
  const envelope = 64 * 1024;
  const buffer = new ArrayBuffer(envelope);
  const m = freshMembrane({
    buffer,
    handleTableCapacity: 16, grantTableCapacity: 8,
    idListPoolSize: 256, rootGrantsListCapacity: 4,
    valueArenaSize: 256, closureHandleTableCapacity: 4,
    linkedPromiseTableCapacity: 4, mutationLogCapacity: 16,
    costLedgerCapacity: 16,
  });

  const oldLedgerOffset = m.view.getUint32(HEADER.LEDGER_OFFSET, true);
  // Write a sentinel u32 word into the first u32 of every entry
  // for the first 4 entries — pattern A0, A1, A2, A3.
  for (let i = 0; i < 4; i++) {
    m.view.setUint32(oldLedgerOffset + i * LEDGER_ENTRY_BYTES, 0xA0 + i, true);
  }

  m.resizeRegions({ handleTableCapacity: 32 });

  const newLedgerOffset = m.view.getUint32(HEADER.LEDGER_OFFSET, true);
  for (let i = 0; i < 4; i++) {
    assertEquals(
      m.view.getUint32(newLedgerOffset + i * LEDGER_ENTRY_BYTES, true),
      0xA0 + i,
      `ledger entry ${i} byte 0 should survive resize`);
  }
});

// =============================================================================
// ledgerCapacity is a configurable session option because legitimate
// concurrent workloads can exceed the default capacity of 256. It follows the
// same treatment as costLedgerCapacity: set at session
// creation, not resizable later through resizeRegions.
// =============================================================================

Deno.test("ledgerCapacity: DEFAULT_LEDGER_CAPACITY matches the historical fixed LEDGER_CAPACITY (256)", () => {
  assertEquals(DEFAULT_LEDGER_CAPACITY, 256);
  assertEquals(LEDGER_CAPACITY, DEFAULT_LEDGER_CAPACITY);
});

Deno.test("ledgerCapacity: computeMembraneLayout honors a custom ledgerCapacity and sizes the region accordingly", () => {
  const defaultLayout = computeMembraneLayout({});
  const customLayout = computeMembraneLayout({ ledgerCapacity: 1024 });

  assertEquals(defaultLayout.capacities.ledgerCapacity, DEFAULT_LEDGER_CAPACITY);
  assertEquals(customLayout.capacities.ledgerCapacity, 1024);

  // Every region after the ledger shifts right by the extra entries'
  // worth of bytes; total byteLength grows by exactly that amount.
  const extraBytes = (1024 - DEFAULT_LEDGER_CAPACITY) * LEDGER_ENTRY_BYTES;
  assertEquals(customLayout.byteLength - defaultLayout.byteLength, extraBytes);
});

Deno.test("ledgerCapacity: rejects a non-positive value", () => {
  let threw = null;
  try { computeMembraneLayout({ ledgerCapacity: 0 }); } catch (e) { threw = e; }
  assert(threw, 'ledgerCapacity: 0 must throw');
  assert(threw.message.includes('ledgerCapacity'), threw.message);

  threw = null;
  try { computeMembraneLayout({ ledgerCapacity: -4 }); } catch (e) { threw = e; }
  assert(threw, 'negative ledgerCapacity must throw');
});

Deno.test("ledgerCapacity: freshMembrane with a custom ledgerCapacity writes it into the header and sizes the region", () => {
  const CUSTOM_CAPACITY = 512;
  const m = freshMembrane({
    handleTableCapacity: 16, grantTableCapacity: 8,
    idListPoolSize: 256, rootGrantsListCapacity: 4,
    valueArenaSize: 256, closureHandleTableCapacity: 4,
    linkedPromiseTableCapacity: 4, mutationLogCapacity: 16,
    costLedgerCapacity: 16, ledgerCapacity: CUSTOM_CAPACITY,
  });
  assertEquals(m.view.getUint32(HEADER.LEDGER_CAPACITY, true), CUSTOM_CAPACITY);

  const ledgerOffset = m.view.getUint32(HEADER.LEDGER_OFFSET, true);
  assert(ledgerOffset + CUSTOM_CAPACITY * LEDGER_ENTRY_BYTES <= m.byteLength,
    'the larger ledger region must fit within the membrane window');
});

Deno.test("ledgerCapacity: a session with 300 concurrent DRIVING_ROOT claims (past the 256 default) succeeds when ledgerCapacity is raised", () => {
  const CUSTOM_CAPACITY = 512;
  const m = freshMembrane({
    handleTableCapacity: 16, grantTableCapacity: 8,
    idListPoolSize: 256, rootGrantsListCapacity: 4,
    valueArenaSize: 256, closureHandleTableCapacity: 4,
    linkedPromiseTableCapacity: 4, mutationLogCapacity: 16,
    costLedgerCapacity: 16, ledgerCapacity: CUSTOM_CAPACITY,
  });
  const ledgerOffset = m.view.getUint32(HEADER.LEDGER_OFFSET, true);
  const ledgerCapacity = m.view.getUint32(HEADER.LEDGER_CAPACITY, true);
  const ledger = createLedgerView({
    buffer: m.buffer, byteOffset: m.byteOffset + ledgerOffset, capacity: ledgerCapacity,
  });

  const claimed = [];
  for (let i = 0; i < 300; i++) {
    const idx = ledger.claim({ contextSlot: i, activity: LEDGER_ACTIVITY.DRIVING_ROOT });
    claimed.push(idx);
  }
  assert(claimed.every((idx) => idx !== -1),
    `every claim should succeed with ledgerCapacity=${CUSTOM_CAPACITY}; got -1 for ` +
    `${claimed.filter((idx) => idx === -1).length} of 300 claims`);
});

Deno.test("ledgerCapacity: resizeRegions preserves a custom ledgerCapacity (like costLedgerCapacity, it is not itself resizable)", () => {
  const envelope = 64 * 1024;
  const buffer = new ArrayBuffer(envelope);
  const CUSTOM_CAPACITY = 300;
  const m = freshMembrane({
    buffer,
    handleTableCapacity: 16, grantTableCapacity: 8,
    idListPoolSize: 256, rootGrantsListCapacity: 4,
    valueArenaSize: 256, closureHandleTableCapacity: 4,
    linkedPromiseTableCapacity: 4, mutationLogCapacity: 16,
    costLedgerCapacity: 16, ledgerCapacity: CUSTOM_CAPACITY,
  });

  m.resizeRegions({ handleTableCapacity: 32 });

  assertEquals(m.view.getUint32(HEADER.LEDGER_CAPACITY, true), CUSTOM_CAPACITY,
    'ledgerCapacity must survive resizeRegions unchanged — it has no resize parameter, ' +
    'same treatment as costLedgerCapacity');
  const newLedgerOffset = m.view.getUint32(HEADER.LEDGER_OFFSET, true);
  assert(newLedgerOffset + CUSTOM_CAPACITY * LEDGER_ENTRY_BYTES <= m.byteLength,
    'the (unchanged-capacity) ledger region must still fit at its new offset');
});

// =============================================================================
// Snapshot/restore: diagnostic regions are NOT preserved (the contract)
// =============================================================================

Deno.test("v5: fromBytes restore resets state cell to SCHEDULER_IDLE even if it held a different value", () => {
  // Make a fresh membrane, put it in a non-idle state, snapshot,
  // restore through the constructor's fromBytes branch.
  const original = freshMembrane();
  const stateOffset = original.view.getUint32(HEADER.RUNTIME_STATE_OFFSET, true);
  original.view.setUint32(stateOffset, RUNTIME_STATE.GC, true);
  // Confirm pre-snapshot state.
  assertEquals(original.view.getUint32(stateOffset, true), RUNTIME_STATE.GC);

  const bytes = original.bytes();

  // Host-side restore: copy bytes into a fresh SAB-sized buffer,
  // construct with fromBytes: true (which expects the header to
  // already be in place at the given offset).
  const restoreBuffer = new ArrayBuffer(bytes.byteLength);
  new Uint8Array(restoreBuffer).set(bytes);
  const restored = freshMembrane({
    buffer: restoreBuffer,
    fromBytes: true,
  });

  const restoredStateOffset = restored.view.getUint32(HEADER.RUNTIME_STATE_OFFSET, true);
  assertEquals(restored.view.getUint32(restoredStateOffset, true),
    RUNTIME_STATE.SCHEDULER_IDLE,
    'state cell reset to SCHEDULER_IDLE on fromBytes restore');
});

Deno.test("v5: fromBytes restore zeroes the ledger even if it held data", () => {
  const original = freshMembrane();
  const ledgerOffset = original.view.getUint32(HEADER.LEDGER_OFFSET, true);
  // Plant a non-zero activity in entry 0 so any failure to zero
  // would be visible.
  original.view.setUint32(ledgerOffset + 0x04 /* ACTIVITY field */,
    1 /* DRIVING_ROOT */, true);
  // Plant another at entry 7.
  original.view.setUint32(
    ledgerOffset + 7 * LEDGER_ENTRY_BYTES + 0x04,
    3 /* AWAITING_PROMISE */, true);

  const bytes = original.bytes();

  const restoreBuffer = new ArrayBuffer(bytes.byteLength);
  new Uint8Array(restoreBuffer).set(bytes);
  const restored = freshMembrane({
    buffer: restoreBuffer,
    fromBytes: true,
  });

  const restoredLedgerOffset = restored.view.getUint32(HEADER.LEDGER_OFFSET, true);
  const u8 = new Uint8Array(
    restored.buffer,
    restored.byteOffset + restoredLedgerOffset,
    LEDGER_REGION_BYTES);
  for (let i = 0; i < u8.length; i++) {
    if (u8[i] !== 0) {
      throw new Error(
        `ledger byte ${i} is ${u8[i]} after restore, expected 0`);
    }
  }
});

Deno.test("ledgerCapacity: session restore (readMembraneLayout attach path) zeroes the ENTIRE region for a custom (larger-than-default) ledgerCapacity", () => {
  // _resetDiagnosticsOnRestore must read ledgerCapacity from the header
  // rather than assuming the fixed 256-entry default — otherwise a
  // custom capacity would leave the tail of the region un-zeroed.
  // Uses the real embedder restore path (readMembraneLayout attach,
  // not a re-layoutMembrane call) — same shape as the "v5 end-to-end"
  // test above, with a non-default ledgerCapacity.
  const CUSTOM_CAPACITY = 512;
  const original = freshSession({ ledgerCapacity: CUSTOM_CAPACITY });
  const membrane = original.airlock.membrane;
  const ledgerOffset = membrane.view.getUint32(HEADER.LEDGER_OFFSET, true);
  assertEquals(membrane.view.getUint32(HEADER.LEDGER_CAPACITY, true), CUSTOM_CAPACITY);

  // Plant non-zero activity at entry 0, entry 300 (past the OLD fixed
  // default of 256 — the region the old fixed-constant code would
  // have missed), and the very last entry.
  membrane.view.setUint32(ledgerOffset + 0x04, 1, true);
  membrane.view.setUint32(ledgerOffset + 300 * LEDGER_ENTRY_BYTES + 0x04, 2, true);
  membrane.view.setUint32(ledgerOffset + (CUSTOM_CAPACITY - 1) * LEDGER_ENTRY_BYTES + 0x04, 3, true);

  const snap = snapshotSession(original);
  const restored = restoreSession(snap.vatBytes, snap.membraneBytes);
  const restoredMembrane = restored.airlock.membrane;

  assertEquals(restoredMembrane.view.getUint32(HEADER.LEDGER_CAPACITY, true), CUSTOM_CAPACITY,
    'capacity itself must survive the restore unchanged');
  const restoredLedgerOffset = restoredMembrane.view.getUint32(HEADER.LEDGER_OFFSET, true);
  for (let i = 0; i < CUSTOM_CAPACITY; i++) {
    const activity = restoredMembrane.view.getUint32(
      restoredLedgerOffset + i * LEDGER_ENTRY_BYTES + 4, true);
    if (activity !== 0) {
      throw new Error(`ledger entry ${i} activity=${activity} after restore, expected 0 ` +
        `(region size must scale with the custom ledgerCapacity, not the old fixed default)`);
    }
  }
});

Deno.test("v5: loadBytes restore also resets diagnostic regions", () => {
  // The other restore path: construct an empty membrane, then
  // loadBytes(). Same reset semantics must apply (single helper
  // serves both paths).
  const original = freshMembrane();
  const stateOffset = original.view.getUint32(HEADER.RUNTIME_STATE_OFFSET, true);
  const ledgerOffset = original.view.getUint32(HEADER.LEDGER_OFFSET, true);
  original.view.setUint32(stateOffset, RUNTIME_STATE.QUIESCED, true);
  original.view.setUint32(ledgerOffset + 0x04, 2 /* DISPATCHING_CLOSURE */, true);

  const bytes = original.bytes();

  // Restore into a fresh membrane via loadBytes.
  const restored = freshMembrane({
    buffer: new ArrayBuffer(bytes.byteLength),
  });
  restored.loadBytes(bytes);

  const restoredStateOffset = restored.view.getUint32(HEADER.RUNTIME_STATE_OFFSET, true);
  const restoredLedgerOffset = restored.view.getUint32(HEADER.LEDGER_OFFSET, true);

  assertEquals(restored.view.getUint32(restoredStateOffset, true),
    RUNTIME_STATE.SCHEDULER_IDLE,
    'state cell reset on loadBytes');
  // First entry's activity field — should be FREE (0), not the
  // DISPATCHING_CLOSURE we planted.
  assertEquals(restored.view.getUint32(restoredLedgerOffset + 0x04, true),
    0, 'ledger entry 0 zeroed on loadBytes');
});

Deno.test("v5: snapshot bytes themselves carry the pre-restore data (the reset happens on the restoring side)", () => {
  // Sanity check: bytes() should return raw bytes including
  // whatever was in the diagnostic regions. The "reset on restore"
  // contract is a property of the restore code path, not of the
  // serialized bytes. This matters because an external observer
  // could in principle snapshot the bytes mid-run and inspect them
  // forensically.
  const original = freshMembrane();
  const stateOffset = original.view.getUint32(HEADER.RUNTIME_STATE_OFFSET, true);
  original.view.setUint32(stateOffset, RUNTIME_STATE.GC, true);

  const bytes = original.bytes();
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const bytesStateOffset = view.getUint32(HEADER.RUNTIME_STATE_OFFSET, true);
  // The bytes themselves carry GC at the state-cell offset.
  assertEquals(view.getUint32(bytesStateOffset, true), RUNTIME_STATE.GC);
});

// =============================================================================
// End-to-end through the public session API
//
// The previous restore tests exercise the raw Membrane primitives
// (fromBytes: true / loadBytes). Embedders interact through
// snapshotSession(session) and createSession({ fromBytes,
// fromMembraneBytes }); this test covers that path end-to-end.
// =============================================================================

Deno.test("v5 end-to-end: snapshotSession(session) + createSession restore resets diagnostic regions", () => {
  const original = freshSession();
  const membrane = original.airlock.membrane;

  // Poke the original session's diagnostic regions into non-default
  // state: state cell to GC, an arbitrary ledger entry's activity to
  // DRIVING_ROOT. (We're writing into the raw membrane bytes; the
  // runtime layer isn't wired yet — that's Phase 3.)
  const stateOffset  = membrane.view.getUint32(HEADER.RUNTIME_STATE_OFFSET, true);
  const ledgerOffset = membrane.view.getUint32(HEADER.LEDGER_OFFSET, true);
  membrane.view.setUint32(stateOffset, RUNTIME_STATE.GC, true);
  // Entry 0, activity field (offset 4 within the entry).
  membrane.view.setUint32(ledgerOffset + 4, LEDGER_ACTIVITY.DRIVING_ROOT, true);
  // Entry 5 too, with a different activity — to confirm whole-region zeroing.
  membrane.view.setUint32(
    ledgerOffset + 5 * LEDGER_ENTRY_BYTES + 4,
    LEDGER_ACTIVITY.AWAITING_PROMISE, true);

  // Snapshot through the embedder-facing API.
  const snap = snapshotSession(original);

  // Restore through createSession with both heap and membrane bytes
  // — the full embedder flow.
  const restored = restoreSession(snap.vatBytes, snap.membraneBytes);
  const restoredMembrane = restored.airlock.membrane;

  // The restored session's diagnostic regions are reset.
  const restoredStateOffset  = restoredMembrane.view.getUint32(HEADER.RUNTIME_STATE_OFFSET, true);
  const restoredLedgerOffset = restoredMembrane.view.getUint32(HEADER.LEDGER_OFFSET, true);

  assertEquals(restoredMembrane.view.getUint32(restoredStateOffset, true),
    RUNTIME_STATE.SCHEDULER_IDLE,
    'state cell reset to SCHEDULER_IDLE after session restore');

  // Every entry's activity field is 0 (FREE).
  for (let i = 0; i < LEDGER_CAPACITY; i++) {
    const activity = restoredMembrane.view.getUint32(
      restoredLedgerOffset + i * LEDGER_ENTRY_BYTES + 4, true);
    if (activity !== 0) {
      throw new Error(
        `ledger entry ${i} activity=${activity} after restore, expected 0`);
    }
  }
});

// =============================================================================
// View modules wired to real membrane regions
//
// Phase 1 tested the view modules in isolation (against ad-hoc
// ArrayBuffers); Phase 2 tested membrane region allocation in
// isolation. These tests prove the two compose: a fresh membrane's
// regions, when bound by a createLedgerView / createRuntimeStateView
// pointed at header-advertised offsets, behave identically to the
// isolated-ArrayBuffer case.
// =============================================================================

Deno.test("v5 integration: createRuntimeStateView bound to a fresh membrane's cell reads SCHEDULER_IDLE", () => {
  const m = freshMembrane();
  const stateOffset = m.view.getUint32(HEADER.RUNTIME_STATE_OFFSET, true);
  const cell = createRuntimeStateView({
    buffer: m.buffer,
    byteOffset: m.byteOffset + stateOffset,
  });
  assertEquals(cell.get(), RUNTIME_STATE.SCHEDULER_IDLE);
});

Deno.test("v5 integration: state-cell view set() then get() round-trips via the membrane region", () => {
  const m = freshMembrane();
  const stateOffset = m.view.getUint32(HEADER.RUNTIME_STATE_OFFSET, true);
  const cell = createRuntimeStateView({
    buffer: m.buffer,
    byteOffset: m.byteOffset + stateOffset,
  });

  for (const name of Object.keys(RUNTIME_STATE)) {
    const value = RUNTIME_STATE[name];
    cell.set(value);
    assertEquals(cell.get(), value, `${name} round-trip through membrane region`);
    // The membrane's own view sees the same value.
    assertEquals(m.view.getUint32(stateOffset, true), value,
      `${name} visible through membrane.view too`);
  }
});

Deno.test("v5 integration: createLedgerView bound to a fresh membrane's region walks empty", () => {
  const m = freshMembrane();
  const ledgerOffset   = m.view.getUint32(HEADER.LEDGER_OFFSET, true);
  const ledgerCapacity = m.view.getUint32(HEADER.LEDGER_CAPACITY, true);
  const ledger = createLedgerView({
    buffer: m.buffer,
    byteOffset: m.byteOffset + ledgerOffset,
    capacity: ledgerCapacity,
  });
  assertEquals(ledger.walk(), []);
  assertEquals(ledger.capacity, 256);
});

Deno.test("v5 integration: ledger view claim/free works against the membrane region", () => {
  const m = freshMembrane();
  const ledgerOffset   = m.view.getUint32(HEADER.LEDGER_OFFSET, true);
  const ledgerCapacity = m.view.getUint32(HEADER.LEDGER_CAPACITY, true);
  const ledger = createLedgerView({
    buffer: m.buffer,
    byteOffset: m.byteOffset + ledgerOffset,
    capacity: ledgerCapacity,
  });

  const idx = ledger.claim({
    contextSlot: 12,
    activity: LEDGER_ACTIVITY.DRIVING_ROOT,
    id1: 42,
    beganAtTick: 9999,
  });
  assertEquals(idx, 0);

  // walk() through the bound view sees the entry.
  const entries = ledger.walk();
  assertEquals(entries.length, 1);
  assertEquals(entries[0].contextSlot, 12);
  assertEquals(entries[0].activity,    LEDGER_ACTIVITY.DRIVING_ROOT);
  assertEquals(entries[0].id1,         42);
  assertEquals(entries[0].beganAtTick, 9999);

  // The membrane sees the same bytes — a separate view bound to the
  // same offset would read identically.
  const directActivity = m.view.getUint32(
    ledgerOffset + 0 * LEDGER_ENTRY_BYTES + 4 /* ACTIVITY field */, true);
  assertEquals(directActivity, LEDGER_ACTIVITY.DRIVING_ROOT);

  // Free and confirm walk is empty again.
  ledger.free(idx);
  assertEquals(ledger.walk(), []);
});

Deno.test("v5 integration: ledger and state cell sit at non-overlapping bytes inside the membrane", () => {
  // Sanity check the region layout — a write through one view must
  // not corrupt the other.
  const m = freshMembrane();
  const stateOffset  = m.view.getUint32(HEADER.RUNTIME_STATE_OFFSET, true);
  const ledgerOffset = m.view.getUint32(HEADER.LEDGER_OFFSET, true);
  const cell = createRuntimeStateView({
    buffer: m.buffer,
    byteOffset: m.byteOffset + stateOffset,
  });
  const ledger = createLedgerView({
    buffer: m.buffer,
    byteOffset: m.byteOffset + ledgerOffset,
    capacity: 256,
  });

  // Set state cell to GC.
  cell.set(RUNTIME_STATE.GC);
  // Claim a ledger entry.
  ledger.claim({ contextSlot: 7, activity: LEDGER_ACTIVITY.DRIVING_ROOT });

  // Both still read what we wrote — they didn't clobber each other.
  assertEquals(cell.get(), RUNTIME_STATE.GC);
  assertEquals(ledger.walk()[0].contextSlot, 7);
});

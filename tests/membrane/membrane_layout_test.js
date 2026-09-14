/**
 * Tests for the pure membrane-layout functions in
 * src/membrane/membrane-layout.js, including the v10 TOTAL_BYTE_LENGTH
 * self-description field.
 */

import { assertEquals, assertThrows, assert } from "https://deno.land/std@0.208.0/assert/mod.ts";
import {
  computeMembraneLayout,
  layoutMembrane,
  readMembraneLayout,
} from '../../src/membrane/membrane-layout.js';
import {
  Membrane,
  HEADER,
  MEMBRANE_MAGIC,
  MEMBRANE_HEADER_SIZE,
  RUNTIME_STATE,
} from '../../src/membrane/index.js';
import { DRONE_FORMAT_VERSION } from '../../src/persisted-format.js';

Deno.test("computeMembraneLayout: returns coherent byteLength and offsets", () => {
  const layout = computeMembraneLayout({});
  assert(layout.byteLength > MEMBRANE_HEADER_SIZE);
  assertEquals(layout.regionOffsets.handleTable, MEMBRANE_HEADER_SIZE);
  // Each region offset must be strictly greater than the previous.
  const offsets = [
    layout.regionOffsets.handleTable,
    layout.regionOffsets.grantTable,
    layout.regionOffsets.idListPool,
    layout.regionOffsets.rootGrantsList,
    layout.regionOffsets.valueArena,
    layout.regionOffsets.closureHandleTable,
    layout.regionOffsets.linkedPromiseTable,
    layout.regionOffsets.mutationLog,
    layout.regionOffsets.runtimeStateCell,
    layout.regionOffsets.ledger,
    layout.regionOffsets.capabilityStateTable,
  ];
  for (let i = 1; i < offsets.length; i++) {
    assert(offsets[i] > offsets[i - 1],
      `region offsets not monotonic: ${offsets[i - 1]} then ${offsets[i]} at index ${i}`);
  }
});

Deno.test("computeMembraneLayout: rejects non-power-of-two mutation log capacity", () => {
  assertThrows(
    () => computeMembraneLayout({ mutationLogCapacity: 1000 }),
    Error,
    'power of two',
  );
});

Deno.test("layoutMembrane: writes magic, version, and TOTAL_BYTE_LENGTH", () => {
  const layout = computeMembraneLayout({});
  const buffer = new ArrayBuffer(layout.byteLength);
  layoutMembrane(buffer, 0, {});

  const view = new DataView(buffer);
  assertEquals(view.getUint32(HEADER.MAGIC,             true), MEMBRANE_MAGIC);
  assertEquals(view.getUint32(HEADER.DRONE_FORMAT_VERSION,           true), DRONE_FORMAT_VERSION);
  assertEquals(view.getUint32(HEADER.TOTAL_BYTE_LENGTH, true), layout.byteLength);
});

Deno.test("layoutMembrane: produces a buffer attachable by Membrane", () => {
  const layout = computeMembraneLayout({});
  const buffer = new ArrayBuffer(layout.byteLength);
  layoutMembrane(buffer, 0, {});

  // Pass fromBytes:true so Membrane skips its own re-init path and
  // attaches to the bytes we wrote. The constructor will validate
  // magic + version.
  const m = new Membrane({
    buffer, byteOffset: 0, byteLength: layout.byteLength,
    fromBytes: true,
  });
  assertEquals(m.byteLength, layout.byteLength);
  // Operate on it to confirm it's functional.
  const handle = m.register({}, null);
  assert(handle.slot >= 0);
});

Deno.test("layoutMembrane: writes at non-zero byteOffset correctly", () => {
  const layout = computeMembraneLayout({});
  const byteOffset = 8192;
  const buffer = new ArrayBuffer(byteOffset + layout.byteLength);
  layoutMembrane(buffer, byteOffset, {});

  const view = new DataView(buffer, byteOffset, layout.byteLength);
  assertEquals(view.getUint32(HEADER.MAGIC,             true), MEMBRANE_MAGIC);
  assertEquals(view.getUint32(HEADER.TOTAL_BYTE_LENGTH, true), layout.byteLength);

  const m = new Membrane({
    buffer, byteOffset, byteLength: layout.byteLength,
    fromBytes: true,
  });
  assertEquals(m.byteLength, layout.byteLength);
});

Deno.test("layoutMembrane: runtime-state cell seeded to SCHEDULER_IDLE", () => {
  const layout = computeMembraneLayout({});
  const buffer = new ArrayBuffer(layout.byteLength);
  layoutMembrane(buffer, 0, {});

  const view = new DataView(buffer);
  assertEquals(
    view.getUint32(layout.regionOffsets.runtimeStateCell, true),
    RUNTIME_STATE.SCHEDULER_IDLE);
});

Deno.test("layoutMembrane: throws when buffer is too small", () => {
  const layout = computeMembraneLayout({});
  const tooSmall = new ArrayBuffer(layout.byteLength - 1);
  assertThrows(
    () => layoutMembrane(tooSmall, 0, {}),
    RangeError,
    'overflow buffer',
  );
});

Deno.test("readMembraneLayout: round-trips with computeMembraneLayout", () => {
  const layoutIn = computeMembraneLayout({});
  const buffer = new ArrayBuffer(layoutIn.byteLength);
  layoutMembrane(buffer, 0, {});

  const layoutOut = readMembraneLayout(new Uint8Array(buffer), 0);
  assertEquals(layoutOut.byteLength, layoutIn.byteLength);
  assertEquals(layoutOut.version,    DRONE_FORMAT_VERSION);
  assertEquals(layoutOut.regionOffsets.handleTable,         layoutIn.regionOffsets.handleTable);
  assertEquals(layoutOut.regionOffsets.grantTable,          layoutIn.regionOffsets.grantTable);
  assertEquals(layoutOut.regionOffsets.capabilityStateTable, layoutIn.regionOffsets.capabilityStateTable);
  assertEquals(layoutOut.capacities.handleTableCapacity,     layoutIn.capacities.handleTableCapacity);
  assertEquals(layoutOut.capacities.mutationLogCapacity,     layoutIn.capacities.mutationLogCapacity);
});

Deno.test("readMembraneLayout: rejects bytes without membrane magic", () => {
  const buffer = new ArrayBuffer(1024);
  assertThrows(
    () => readMembraneLayout(new Uint8Array(buffer), 0),
    Error,
    'magic mismatch',
  );
});

Deno.test("readMembraneLayout: rejects a non-current aggregate version", () => {
  const buffer = new ArrayBuffer(MEMBRANE_HEADER_SIZE);
  const view = new DataView(buffer);
  view.setUint32(HEADER.MAGIC, MEMBRANE_MAGIC, true);
  view.setUint32(HEADER.DRONE_FORMAT_VERSION, 9, true);
  assertThrows(
    () => readMembraneLayout(new Uint8Array(buffer), 0),
    Error,
    'unsupported drone format version',
  );
});

Deno.test("Membrane constructor: rejects calls without a buffer", () => {
  // Under the host-owned-memory contract the Membrane constructor
  // is attach-only — there's no auto-allocate path. Callers must
  // first allocate + layoutMembrane.
  assertThrows(
    () => new Membrane(),
    TypeError,
    'buffer',
  );
});

Deno.test("Membrane constructor: rejects v9 bytes", () => {
  // Build a hand-crafted "v9 membrane" buffer (magic + version=9
  // + plausible TOTAL_BYTE_LENGTH) and confirm the constructor
  // refuses to attach to it. Hard-cutover versioning.
  const layout = computeMembraneLayout({});
  const buffer = new ArrayBuffer(layout.byteLength);
  const view = new DataView(buffer);
  view.setUint32(HEADER.MAGIC,             MEMBRANE_MAGIC, true);
  view.setUint32(HEADER.DRONE_FORMAT_VERSION,           9,              true);
  view.setUint32(HEADER.TOTAL_BYTE_LENGTH, layout.byteLength, true);
  assertThrows(
    () => new Membrane({ buffer, byteOffset: 0, byteLength: layout.byteLength }),
    Error,
    'version',
  );
});

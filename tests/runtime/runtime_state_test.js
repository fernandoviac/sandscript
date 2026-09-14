/**
 * Unit tests for src/runtime/runtime-state.js — the SAB-backed
 * runtime-state cell.
 *
 * Some tests exercise Atomics.wait, which requires a real
 * SharedArrayBuffer (Atomics.wait on a plain ArrayBuffer throws).
 * Those tests construct a SAB explicitly; the rest use plain
 * ArrayBuffer (cheaper and equivalent for set/get/rebind).
 *
 * Run with: deno task test tests/runtime/runtime_state_test.js
 */

import { assertEquals, assert, assertThrows } from "https://deno.land/std@0.208.0/assert/mod.ts";
import {
  createRuntimeStateView,
  RUNTIME_STATE,
  runtimeStateName,
  RUNTIME_STATE_CELL_BYTES,
} from '../../src/runtime/runtime-state.js';

// =============================================================================
// Constants & enum
// =============================================================================

Deno.test("constants: cell is 4 bytes (one u32)", () => {
  assertEquals(RUNTIME_STATE_CELL_BYTES, 4);
});

Deno.test("RUNTIME_STATE enum values match the retired RuntimeParkedState (rename, not value shuffle)", () => {
  assertEquals(RUNTIME_STATE.RUNNING,             0);
  assertEquals(RUNTIME_STATE.SCHEDULER_IDLE,      1);
  assertEquals(RUNTIME_STATE.INBOUND_LOOP,        2);
  assertEquals(RUNTIME_STATE.OUTBOUND_DRAIN,      3);
  assertEquals(RUNTIME_STATE.DRAINING_ROOT_SLOTS, 4);
  assertEquals(RUNTIME_STATE.GC,                  5);
  assertEquals(RUNTIME_STATE.QUIESCED,            6);
});

Deno.test("runtimeStateName: known values and unknown fallback", () => {
  assertEquals(runtimeStateName(RUNTIME_STATE.RUNNING),             'RUNNING');
  assertEquals(runtimeStateName(RUNTIME_STATE.SCHEDULER_IDLE),      'SCHEDULER_IDLE');
  assertEquals(runtimeStateName(RUNTIME_STATE.INBOUND_LOOP),        'INBOUND_LOOP');
  assertEquals(runtimeStateName(RUNTIME_STATE.OUTBOUND_DRAIN),      'OUTBOUND_DRAIN');
  assertEquals(runtimeStateName(RUNTIME_STATE.DRAINING_ROOT_SLOTS), 'DRAINING_ROOT_SLOTS');
  assertEquals(runtimeStateName(RUNTIME_STATE.GC),                  'GC');
  assertEquals(runtimeStateName(RUNTIME_STATE.QUIESCED),            'QUIESCED');
  assertEquals(runtimeStateName(42), 'unknown(42)');
  assertEquals(runtimeStateName(-1), 'unknown(-1)');
});

// =============================================================================
// Helpers
// =============================================================================

function freshCellOnArrayBuffer({ byteOffset = 0 } = {}) {
  const buffer = new ArrayBuffer(byteOffset + RUNTIME_STATE_CELL_BYTES);
  return {
    buffer,
    byteOffset,
    cell: createRuntimeStateView({ buffer, byteOffset }),
  };
}

function freshCellOnSAB({ byteOffset = 0 } = {}) {
  const buffer = new SharedArrayBuffer(byteOffset + RUNTIME_STATE_CELL_BYTES);
  return {
    buffer,
    byteOffset,
    cell: createRuntimeStateView({ buffer, byteOffset }),
  };
}

// =============================================================================
// get / set — basic round-trip (ArrayBuffer is fine; no wait)
// =============================================================================

Deno.test("fresh cell on a zero ArrayBuffer reads as 0 (= RUNNING)", () => {
  const { cell } = freshCellOnArrayBuffer();
  assertEquals(cell.get(), RUNTIME_STATE.RUNNING);
});

Deno.test("set then get round-trips every enum value", () => {
  const { cell } = freshCellOnArrayBuffer();
  for (const name of Object.keys(RUNTIME_STATE)) {
    const value = RUNTIME_STATE[name];
    cell.set(value);
    assertEquals(cell.get(), value, `failed round-trip for ${name}`);
  }
});

Deno.test("set: overwrites the previous value", () => {
  const { cell } = freshCellOnArrayBuffer();
  cell.set(RUNTIME_STATE.GC);
  assertEquals(cell.get(), RUNTIME_STATE.GC);
  cell.set(RUNTIME_STATE.RUNNING);
  assertEquals(cell.get(), RUNTIME_STATE.RUNNING);
});

Deno.test("set: idempotent — setting the same value twice doesn't change anything observable", () => {
  const { cell } = freshCellOnArrayBuffer();
  cell.set(RUNTIME_STATE.QUIESCED);
  cell.set(RUNTIME_STATE.QUIESCED);
  assertEquals(cell.get(), RUNTIME_STATE.QUIESCED);
});

Deno.test("set: coerces non-integer numeric inputs via |0 (defense against accidental float)", () => {
  const { cell } = freshCellOnArrayBuffer();
  // 3.7 | 0 === 3 — this is the same coercion Atomics.store applies.
  cell.set(3.7);
  assertEquals(cell.get(), 3);
});

Deno.test("createRuntimeStateView: binds at non-zero byteOffset", () => {
  // Verify that the view actually reads from the requested offset,
  // not from offset 0.
  const headerBytes = 256;
  const buffer = new ArrayBuffer(headerBytes + RUNTIME_STATE_CELL_BYTES);
  // Write a distinctive pattern in the "header" so any read from
  // offset 0 by mistake would surface as a wrong value.
  new DataView(buffer).setUint32(0, 0xDEADBEEF, true);
  const cell = createRuntimeStateView({ buffer, byteOffset: headerBytes });
  assertEquals(cell.get(), 0, 'reads from headerBytes, not offset 0');
  cell.set(RUNTIME_STATE.GC);
  // Cell wrote at headerBytes, not at offset 0.
  assertEquals(new DataView(buffer).getUint32(headerBytes, true), RUNTIME_STATE.GC);
  assertEquals(new DataView(buffer).getUint32(0, true), 0xDEADBEEF,
    'header bytes untouched');
});

// =============================================================================
// wait — requires SharedArrayBuffer
// =============================================================================

Deno.test("wait: returns 'not-equal' when the cell's current value already differs from currentState", () => {
  // The main-thread version of Atomics.wait on a SAB cell that
  // already holds a different value returns 'not-equal' synchronously.
  const { cell } = freshCellOnSAB();
  cell.set(RUNTIME_STATE.GC);
  // Tell wait() we expect RUNNING; the cell holds GC, so the
  // wait returns immediately.
  const result = cell.wait(RUNTIME_STATE.RUNNING, 1000);
  assertEquals(result, 'not-equal');
});

Deno.test("wait: returns 'timed-out' when the cell stays at currentState past the timeout", () => {
  // Main-thread wait WILL block synchronously on a SAB cell when
  // the value matches. Use a short timeout (10ms) so the test
  // doesn't hang.
  const { cell } = freshCellOnSAB();
  cell.set(RUNTIME_STATE.RUNNING);
  const start = performance.now();
  const result = cell.wait(RUNTIME_STATE.RUNNING, 10);
  const elapsed = performance.now() - start;
  assertEquals(result, 'timed-out');
  // Sanity: actually waited (at least most of the timeout).
  // Some slop allowed because timer resolution varies.
  assert(elapsed >= 5,
    `expected ~10ms wait, only blocked ${elapsed}ms — wait() didn't actually wait`);
});

Deno.test("wait: returns 'ok' when another agent stores a new value during the wait", () => {
  // Same-thread test: schedule a set() via setTimeout that fires
  // *after* the wait starts blocking. But Atomics.wait on the
  // main thread blocks synchronously, so a same-thread setTimeout
  // can't fire until wait returns. Use a real Worker for this.
  //
  // We construct a tiny worker that, on receiving a SAB, calls
  // Atomics.store + Atomics.notify on it after a short delay.
  // The main thread then enters wait() and expects to be woken.
  const { cell, buffer, byteOffset } = freshCellOnSAB();
  cell.set(RUNTIME_STATE.RUNNING);

  const workerSrc = `
    self.onmessage = (e) => {
      const { buffer, byteOffset } = e.data;
      const view = new Int32Array(buffer, byteOffset, 1);
      // Slight delay so the main thread is already inside wait().
      // 25ms is comfortably longer than the thread bootstrap.
      setTimeout(() => {
        Atomics.store(view, 0, ${RUNTIME_STATE.GC});
        Atomics.notify(view, 0, +Infinity);
      }, 25);
    };
  `;
  const blob = new Blob([workerSrc], { type: 'application/javascript' });
  const worker = new Worker(URL.createObjectURL(blob), { type: 'module' });
  worker.postMessage({ buffer, byteOffset });

  // Block until the worker stores GC. 2 seconds is well under any
  // reasonable CI timeout but well over the 25ms the worker sleeps.
  const result = cell.wait(RUNTIME_STATE.RUNNING, 2000);
  worker.terminate();

  assertEquals(result, 'ok');
  assertEquals(cell.get(), RUNTIME_STATE.GC, 'worker successfully stored new value');
});

Deno.test("wait: defaults to Infinity timeout when not specified", () => {
  // Just confirm the no-timeout call path doesn't throw. Use a
  // 'not-equal' setup so wait returns immediately (we don't
  // actually want to block forever).
  const { cell } = freshCellOnSAB();
  cell.set(RUNTIME_STATE.GC);
  const result = cell.wait(RUNTIME_STATE.RUNNING);
  assertEquals(result, 'not-equal');
});

// =============================================================================
// rebind
// =============================================================================

Deno.test("rebind: view follows the new buffer/offset", () => {
  // Like the ledger rebind test: write to region A, memcpy to
  // region B, zero A, rebind, confirm get() reads from B.
  const buffer = new ArrayBuffer(1024);
  const offsetA = 0;
  const offsetB = 512;
  const cell = createRuntimeStateView({ buffer, byteOffset: offsetA });
  cell.set(RUNTIME_STATE.GC);

  const bytes = new Uint8Array(buffer);
  bytes.copyWithin(offsetB, offsetA, offsetA + RUNTIME_STATE_CELL_BYTES);
  bytes.fill(0, offsetA, offsetA + RUNTIME_STATE_CELL_BYTES);

  cell.rebind(buffer, offsetB);
  assertEquals(cell.get(), RUNTIME_STATE.GC, 'reads from new offset');
});

Deno.test("rebind: to a new buffer entirely", () => {
  const bufferA = new ArrayBuffer(64);
  const cell = createRuntimeStateView({ buffer: bufferA, byteOffset: 0 });
  cell.set(RUNTIME_STATE.QUIESCED);
  assertEquals(cell.get(), RUNTIME_STATE.QUIESCED);

  // New buffer; the cell now reads whatever is at offset 128 there
  // (which is 0 = RUNNING).
  const bufferB = new ArrayBuffer(256);
  cell.rebind(bufferB, 128);
  assertEquals(cell.get(), RUNTIME_STATE.RUNNING);

  // Subsequent writes land in bufferB at offset 128, not bufferA.
  cell.set(RUNTIME_STATE.GC);
  assertEquals(new DataView(bufferB).getUint32(128, true), RUNTIME_STATE.GC);
  // bufferA still has QUIESCED at offset 0.
  assertEquals(new DataView(bufferA).getUint32(0, true), RUNTIME_STATE.QUIESCED);
});

Deno.test("rebind: diagnostic accessors reflect the new binding", () => {
  const { cell, buffer } = freshCellOnArrayBuffer();
  assertEquals(cell.__peekOffset(), 0);
  assertEquals(cell.__peekBufferByteLength(), buffer.byteLength);

  const newBuffer = new ArrayBuffer(2048);
  cell.rebind(newBuffer, 256);
  assertEquals(cell.__peekOffset(), 256);
  assertEquals(cell.__peekBufferByteLength(), 2048);
});

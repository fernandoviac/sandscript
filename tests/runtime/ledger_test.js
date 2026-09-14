/**
 * Unit tests for src/runtime/ledger.js — the SAB-backed
 * in-flight-activity presence table.
 *
 * Run with: deno task test tests/runtime/ledger_test.js
 */

import { assertEquals, assert, assertThrows } from "https://deno.land/std@0.208.0/assert/mod.ts";
import {
  createLedgerView,
  LEDGER_ENTRY_BYTES,
  LEDGER_FIELD,
  LEDGER_ACTIVITY,
  LEDGER_ACTIVITY_RUNTIME_RESERVED_MAX,
  ledgerActivityName,
} from '../../src/runtime/ledger.js';

// =============================================================================
// Constants
// =============================================================================

Deno.test("constants: entry size is 24 bytes", () => {
  assertEquals(LEDGER_ENTRY_BYTES, 24);
});

Deno.test("constants: field offsets are 4-byte aligned and total 24 bytes", () => {
  // Six u32 fields = 24 bytes.
  assertEquals(LEDGER_FIELD.CONTEXT_SLOT,  0x00);
  assertEquals(LEDGER_FIELD.ACTIVITY,      0x04);
  assertEquals(LEDGER_FIELD.ID_1,          0x08);
  assertEquals(LEDGER_FIELD.ID_2,          0x0C);
  assertEquals(LEDGER_FIELD.CALL_ID,       0x10);
  assertEquals(LEDGER_FIELD.BEGAN_AT_TICK, 0x14);
});

Deno.test("constants: FREE is 0, runtime activities are 1..3, reserved max is 63", () => {
  assertEquals(LEDGER_ACTIVITY.FREE,                0);
  assertEquals(LEDGER_ACTIVITY.DRIVING_ROOT,        1);
  assertEquals(LEDGER_ACTIVITY.DISPATCHING_CLOSURE, 2);
  assertEquals(LEDGER_ACTIVITY.AWAITING_PROMISE,    3);
  // Value 4 is reserved for a future AWAITING_ASYNC_PEER split
  // — v1 doesn't distinguish JS-promise await from SS-peer await.
  assertEquals(LEDGER_ACTIVITY.AWAITING_ASYNC_PEER, undefined);
  assertEquals(LEDGER_ACTIVITY_RUNTIME_RESERVED_MAX, 63);
});

Deno.test("ledgerActivityName: known values, FREE, and unknown fallback", () => {
  assertEquals(ledgerActivityName(LEDGER_ACTIVITY.FREE),                'free');
  assertEquals(ledgerActivityName(LEDGER_ACTIVITY.DRIVING_ROOT),        'driving-root');
  assertEquals(ledgerActivityName(LEDGER_ACTIVITY.DISPATCHING_CLOSURE), 'dispatching-closure');
  assertEquals(ledgerActivityName(LEDGER_ACTIVITY.AWAITING_PROMISE),    'awaiting-promise');
  // Reserved-but-unused activity ids fall through to the unknown
  // formatter (value 4 reserved for AWAITING_ASYNC_PEER).
  assertEquals(ledgerActivityName(4), 'unknown-activity-4');
  assertEquals(ledgerActivityName(99), 'unknown-activity-99');
  assertEquals(ledgerActivityName(0xFFFF), 'unknown-activity-65535');
});

// =============================================================================
// Helpers
// =============================================================================

function freshLedger(capacity = 4, { byteOffset = 0 } = {}) {
  // The view module accepts plain ArrayBuffer (tests don't need
  // cross-realm sharing). It must be 4-byte aligned at byteOffset.
  const buffer = new ArrayBuffer(byteOffset + capacity * LEDGER_ENTRY_BYTES);
  return {
    buffer,
    byteOffset,
    ledger: createLedgerView({ buffer, byteOffset, capacity }),
  };
}

// =============================================================================
// createLedgerView — construction
// =============================================================================

Deno.test("createLedgerView: rejects capacity <= 0", () => {
  const buffer = new ArrayBuffer(24);
  assertThrows(
    () => createLedgerView({ buffer, byteOffset: 0, capacity: 0 }),
    Error, 'capacity must be > 0');
  assertThrows(
    () => createLedgerView({ buffer, byteOffset: 0, capacity: -1 }),
    Error, 'capacity must be > 0');
});

Deno.test("createLedgerView: capacity is exposed as a read-only property", () => {
  const { ledger } = freshLedger(16);
  assertEquals(ledger.capacity, 16);
});

Deno.test("createLedgerView: fresh ledger walks empty", () => {
  const { ledger } = freshLedger(4);
  assertEquals(ledger.walk(), []);
});

Deno.test("createLedgerView: binds at non-zero byteOffset", () => {
  // Header-style layout: 4 KB of "header" bytes before the ledger.
  // Verifies that walk() reads from the right offset and doesn't
  // accidentally see header bytes.
  const headerBytes = 4096;
  const capacity = 4;
  const buffer = new ArrayBuffer(headerBytes + capacity * LEDGER_ENTRY_BYTES);
  // Write nonzero bytes into the "header" so anything reading
  // from offset 0 by mistake would see them.
  new Uint8Array(buffer, 0, headerBytes).fill(0xAA);
  const ledger = createLedgerView({ buffer, byteOffset: headerBytes, capacity });
  assertEquals(ledger.walk(), [], 'should not see header bytes as entries');
  const idx = ledger.claim({
    contextSlot: 7,
    activity: LEDGER_ACTIVITY.DRIVING_ROOT,
    beganAtTick: 1000,
  });
  assertEquals(idx, 0);
  const entries = ledger.walk();
  assertEquals(entries.length, 1);
  assertEquals(entries[0].contextSlot, 7);
  assertEquals(entries[0].beganAtTick, 1000);
});

// =============================================================================
// claim
// =============================================================================

Deno.test("claim: writes all fields and returns the entry index", () => {
  const { ledger } = freshLedger(4);
  const idx = ledger.claim({
    contextSlot: 7,
    activity: LEDGER_ACTIVITY.DRIVING_ROOT,
    id1: 100,
    id2: 200,
    callId: 999,
    beganAtTick: 12345,
  });
  assertEquals(idx, 0, 'first claim picks entry 0');
  const entries = ledger.walk();
  assertEquals(entries.length, 1);
  assertEquals(entries[0], {
    entryIndex: 0,
    contextSlot: 7,
    activity: LEDGER_ACTIVITY.DRIVING_ROOT,
    id1: 100,
    id2: 200,
    callId: 999,
    beganAtTick: 12345,
  });
});

Deno.test("claim: defaults missing fields to 0", () => {
  const { ledger } = freshLedger(4);
  const idx = ledger.claim({
    activity: LEDGER_ACTIVITY.AWAITING_PROMISE,
  });
  assertEquals(idx, 0);
  const entries = ledger.walk();
  assertEquals(entries[0], {
    entryIndex: 0,
    contextSlot: 0,
    activity: LEDGER_ACTIVITY.AWAITING_PROMISE,
    id1: 0,
    id2: 0,
    callId: 0,
    beganAtTick: 0,
  });
});

Deno.test("claim: contextSlot=0 is a real value, not a sentinel", () => {
  // Slot 0 is the root context. The ledger MUST accept and
  // preserve contextSlot=0 verbatim; treating 0 as "no slot"
  // would mask all root-slot activity.
  const { ledger } = freshLedger(4);
  ledger.claim({
    contextSlot: 0,
    activity: LEDGER_ACTIVITY.DRIVING_ROOT,
  });
  const entries = ledger.walk();
  assertEquals(entries.length, 1);
  assertEquals(entries[0].contextSlot, 0);
});

Deno.test("claim: contextSlot=0xFFFFFFFF (embedder 'no slot' sentinel) is preserved", () => {
  const { ledger } = freshLedger(4);
  ledger.claim({
    contextSlot: 0xFFFFFFFF,
    activity: 64, // embedder activity
  });
  const entries = ledger.walk();
  assertEquals(entries[0].contextSlot, 0xFFFFFFFF);
});

Deno.test("claim: activity=0 throws", () => {
  const { ledger } = freshLedger(4);
  assertThrows(
    () => ledger.claim({ contextSlot: 1, activity: 0 }),
    Error, 'activity=0 (FREE) is invalid');
});

Deno.test("claim: returns -1 when the table is full", () => {
  const { ledger } = freshLedger(3);
  assertEquals(ledger.claim({ activity: LEDGER_ACTIVITY.DRIVING_ROOT }), 0);
  assertEquals(ledger.claim({ activity: LEDGER_ACTIVITY.DRIVING_ROOT }), 1);
  assertEquals(ledger.claim({ activity: LEDGER_ACTIVITY.DRIVING_ROOT }), 2);
  assertEquals(ledger.claim({ activity: LEDGER_ACTIVITY.DRIVING_ROOT }), -1);
  // Free one, claim again — should reuse that slot.
  ledger.free(1);
  assertEquals(ledger.claim({ activity: LEDGER_ACTIVITY.DRIVING_ROOT }), 1);
});

Deno.test("claim: linear-scan picks the lowest free entry", () => {
  const { ledger } = freshLedger(5);
  ledger.claim({ activity: 1 }); // entry 0
  ledger.claim({ activity: 1 }); // entry 1
  ledger.claim({ activity: 1 }); // entry 2
  ledger.free(1);
  ledger.free(0);
  // Lowest free is 0, then 1.
  assertEquals(ledger.claim({ activity: 2 }), 0);
  assertEquals(ledger.claim({ activity: 2 }), 1);
  assertEquals(ledger.claim({ activity: 2 }), 3);
});

Deno.test("claim: each entry holds independent data", () => {
  const { ledger } = freshLedger(8);
  for (let i = 0; i < 5; i++) {
    ledger.claim({
      contextSlot: 100 + i,
      activity: LEDGER_ACTIVITY.DRIVING_ROOT,
      id1: 1000 + i,
      callId: 2000 + i,
      beganAtTick: 3000 + i,
    });
  }
  const entries = ledger.walk();
  assertEquals(entries.length, 5);
  for (let i = 0; i < 5; i++) {
    assertEquals(entries[i].contextSlot, 100 + i);
    assertEquals(entries[i].id1,         1000 + i);
    assertEquals(entries[i].callId,      2000 + i);
    assertEquals(entries[i].beganAtTick, 3000 + i);
  }
});

// =============================================================================
// free
// =============================================================================

Deno.test("free: zeroes the entry and makes it claimable again", () => {
  const { ledger } = freshLedger(4);
  const idx = ledger.claim({
    contextSlot: 7,
    activity: LEDGER_ACTIVITY.DRIVING_ROOT,
    id1: 100,
  });
  assertEquals(ledger.walk().length, 1);
  ledger.free(idx);
  assertEquals(ledger.walk(), []);
  // The freed slot is reclaimable.
  const idx2 = ledger.claim({ activity: LEDGER_ACTIVITY.AWAITING_PROMISE });
  assertEquals(idx2, idx, 'freed entry reused');
});

Deno.test("free: is idempotent", () => {
  const { ledger } = freshLedger(4);
  const idx = ledger.claim({ activity: LEDGER_ACTIVITY.DRIVING_ROOT });
  ledger.free(idx);
  ledger.free(idx); // second free on the same entry — no-op
  ledger.free(idx); // third — still fine
  assertEquals(ledger.walk(), []);
});

Deno.test("free: -1 is a no-op (the 'claim failed' sentinel)", () => {
  const { ledger } = freshLedger(4);
  ledger.claim({ activity: LEDGER_ACTIVITY.DRIVING_ROOT });
  // free(-1) must not corrupt entry 0.
  ledger.free(-1);
  assertEquals(ledger.walk().length, 1);
});

Deno.test("free: out-of-range entryIndex is a no-op", () => {
  const { ledger } = freshLedger(4);
  ledger.claim({ activity: LEDGER_ACTIVITY.DRIVING_ROOT });
  ledger.free(4);    // off the end
  ledger.free(100);  // way off the end
  ledger.free(-99);  // way negative
  assertEquals(ledger.walk().length, 1);
});

// =============================================================================
// write
// =============================================================================

Deno.test("write: partial update of fields on a claimed entry", () => {
  const { ledger } = freshLedger(4);
  const idx = ledger.claim({
    contextSlot: 7,
    activity: LEDGER_ACTIVITY.DRIVING_ROOT,
    id1: 100,
    id2: 200,
    callId: 999,
    beganAtTick: 12345,
  });
  ledger.write(idx, { id1: 555, callId: 9999 });
  const entries = ledger.walk();
  assertEquals(entries[0].id1, 555,    'id1 updated');
  assertEquals(entries[0].callId, 9999, 'callId updated');
  // Other fields untouched.
  assertEquals(entries[0].contextSlot, 7);
  assertEquals(entries[0].id2, 200);
  assertEquals(entries[0].beganAtTick, 12345);
  assertEquals(entries[0].activity, LEDGER_ACTIVITY.DRIVING_ROOT);
});

Deno.test("write: out-of-range entryIndex is a no-op", () => {
  const { ledger } = freshLedger(4);
  ledger.claim({ activity: LEDGER_ACTIVITY.DRIVING_ROOT, id1: 100 });
  ledger.write(99, { id1: 999 });   // off the end
  ledger.write(-1, { id1: 999 });   // sentinel
  const entries = ledger.walk();
  assertEquals(entries[0].id1, 100, 'untouched by out-of-range writes');
});

// =============================================================================
// walk
// =============================================================================

Deno.test("walk: returns entries in entry-index order (not chronological)", () => {
  const { ledger } = freshLedger(4);
  // Claim, free, claim — re-use entry 0, but claim entry 1 later.
  ledger.claim({ activity: 1, beganAtTick: 100 }); // entry 0
  ledger.claim({ activity: 1, beganAtTick: 200 }); // entry 1
  ledger.free(0);
  ledger.claim({ activity: 1, beganAtTick: 300 }); // entry 0 (reused)
  const entries = ledger.walk();
  // Order should be by entryIndex (0 then 1), even though entry 1
  // was claimed first chronologically.
  assertEquals(entries.length, 2);
  assertEquals(entries[0].entryIndex, 0);
  assertEquals(entries[0].beganAtTick, 300);
  assertEquals(entries[1].entryIndex, 1);
  assertEquals(entries[1].beganAtTick, 200);
});

Deno.test("walk: skips FREE entries even with mixed occupancy", () => {
  const { ledger } = freshLedger(8);
  for (let i = 0; i < 8; i++) {
    ledger.claim({ contextSlot: i, activity: LEDGER_ACTIVITY.DRIVING_ROOT });
  }
  // Free every other entry.
  ledger.free(1);
  ledger.free(3);
  ledger.free(5);
  ledger.free(7);
  const entries = ledger.walk();
  assertEquals(entries.length, 4);
  assertEquals(entries.map(e => e.entryIndex), [0, 2, 4, 6]);
  assertEquals(entries.map(e => e.contextSlot), [0, 2, 4, 6]);
});

Deno.test("walk: torn-read safety — a partially-written entry is reported as-is, not skipped or thrown", () => {
  // Simulate a torn write: ACTIVITY is set (claim's CAS succeeded)
  // but the trailing Atomics.store calls haven't completed yet.
  // The walker should report the entry with whatever fields are
  // currently visible — never throw.
  const capacity = 4;
  const buffer = new ArrayBuffer(capacity * LEDGER_ENTRY_BYTES);
  const ledger = createLedgerView({ buffer, byteOffset: 0, capacity });
  // Manually set entry 1's ACTIVITY without touching other fields,
  // mimicking the window between CAS-on-activity and the
  // subsequent Atomics.store of the other fields.
  const view = new Int32Array(buffer);
  const entryWords = LEDGER_ENTRY_BYTES / 4;
  view[1 * entryWords + LEDGER_FIELD.ACTIVITY / 4] = LEDGER_ACTIVITY.DRIVING_ROOT;
  // Other fields remain zero.
  const entries = ledger.walk();
  assertEquals(entries.length, 1, 'walker should see the torn entry');
  assertEquals(entries[0], {
    entryIndex: 1,
    contextSlot: 0,
    activity: LEDGER_ACTIVITY.DRIVING_ROOT,
    id1: 0, id2: 0, callId: 0, beganAtTick: 0,
  });
});

// =============================================================================
// rebind
// =============================================================================

Deno.test("rebind: view follows the new buffer/offset", () => {
  // Build a source buffer with two regions; "move" the ledger
  // bytes from region A to region B by memcpy, then rebind. The
  // ledger should now read from B.
  const capacity = 4;
  const regionBytes = capacity * LEDGER_ENTRY_BYTES;

  const buffer = new ArrayBuffer(1024);
  const offsetA = 0;
  const offsetB = 512;

  const ledger = createLedgerView({
    buffer, byteOffset: offsetA, capacity,
  });
  ledger.claim({
    contextSlot: 42,
    activity: LEDGER_ACTIVITY.DRIVING_ROOT,
    id1: 7,
  });
  // Memcpy region A → B.
  const bytes = new Uint8Array(buffer);
  bytes.copyWithin(offsetB, offsetA, offsetA + regionBytes);
  // Zero out region A so any stale read would surface as empty.
  bytes.fill(0, offsetA, offsetA + regionBytes);

  ledger.rebind(buffer, offsetB);
  const entries = ledger.walk();
  assertEquals(entries.length, 1, 'sees the entry at the new offset');
  assertEquals(entries[0].contextSlot, 42);
  assertEquals(entries[0].id1, 7);
});

Deno.test("rebind: capacity is preserved (fixed for the format version)", () => {
  const { ledger, buffer } = freshLedger(16);
  // Move it; capacity must remain 16.
  const newBuffer = new ArrayBuffer(buffer.byteLength + 1024);
  // Copy the existing region into the new buffer at a new offset.
  new Uint8Array(newBuffer, 256, 16 * LEDGER_ENTRY_BYTES)
    .set(new Uint8Array(buffer, 0, 16 * LEDGER_ENTRY_BYTES));
  ledger.rebind(newBuffer, 256);
  assertEquals(ledger.capacity, 16);
});

Deno.test("rebind: diagnostic accessors reflect the new binding", () => {
  const { ledger, buffer } = freshLedger(4);
  assertEquals(ledger.__peekOffset(), 0);
  assertEquals(ledger.__peekBufferByteLength(), buffer.byteLength);

  const newBuffer = new ArrayBuffer(2048);
  ledger.rebind(newBuffer, 128);
  assertEquals(ledger.__peekOffset(), 128);
  assertEquals(ledger.__peekBufferByteLength(), 2048);
});

// =============================================================================
// Concurrent CAS — only one of two racing claims on a contended slot wins
// =============================================================================
//
// We can't easily run two real threads in a deno task test, but we can
// exercise the CAS protocol directly: pre-claim every slot but
// one, then prove that exactly one of two back-to-back claims
// against the contended slot succeeds.

Deno.test("CAS: when only one entry is FREE, two claims compete and exactly one wins the contended slot", () => {
  const { ledger } = freshLedger(3);
  // Claim entries 0 and 1.
  ledger.claim({ activity: LEDGER_ACTIVITY.DRIVING_ROOT });
  ledger.claim({ activity: LEDGER_ACTIVITY.DRIVING_ROOT });
  // Now only entry 2 is FREE. Two competing claims: one gets 2,
  // the other gets -1.
  const a = ledger.claim({ contextSlot: 100, activity: LEDGER_ACTIVITY.DRIVING_ROOT });
  const b = ledger.claim({ contextSlot: 200, activity: LEDGER_ACTIVITY.DRIVING_ROOT });
  assertEquals(a, 2);
  assertEquals(b, -1);
  const entries = ledger.walk();
  assertEquals(entries.length, 3);
  assertEquals(entries[2].contextSlot, 100);
});

Deno.test("CAS: claim's CAS rejects a non-FREE slot — the activity field protects against double-claim", () => {
  // Manually set entry 0's ACTIVITY (simulating a racing claim
  // having won the CAS). A subsequent claim must skip past entry
  // 0 and pick entry 1.
  const capacity = 4;
  const buffer = new ArrayBuffer(capacity * LEDGER_ENTRY_BYTES);
  const view = new Int32Array(buffer);
  const entryWords = LEDGER_ENTRY_BYTES / 4;
  view[0 * entryWords + LEDGER_FIELD.ACTIVITY / 4] = LEDGER_ACTIVITY.DRIVING_ROOT;

  const ledger = createLedgerView({ buffer, byteOffset: 0, capacity });
  const idx = ledger.claim({ contextSlot: 5, activity: LEDGER_ACTIVITY.AWAITING_PROMISE });
  assertEquals(idx, 1, 'skipped past pre-claimed entry 0');
});

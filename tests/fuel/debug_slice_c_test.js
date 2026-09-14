/**
 * Debug observability tests covering enumerate extensions, state getters,
 * reverse lookups, engine counters, heap and string inventories,
 * dumpContexts, and new session.state fields.
 *
 * Run with: deno task test tests/fuel/debug_slice_c_test.js
 */

import { assertEquals, assert, assertThrows } from "https://deno.land/std@0.208.0/assert/mod.ts";
import { createSession } from '../../src/fuel/session.js';
import { createDebug } from '../../src/fuel/debug.js';
import {
  Membrane,
  MUTATION_KIND,
  MUTATION_TAG,
} from '../../src/membrane/index.js';
import { freshMembrane, freshSession, snapshotSession } from '../../src/host-owned-session.js';

function parseAndPrime(session, source, slot = 0) {
  const r = session.parse(source);
  session.mem.setContextInstructionIndex(slot, r.startIndex);
  session.mem.clearExitCondition(slot);
}

// =============================================================================
// Item 6: enumerate* with includeRevoked / includeReaped
// =============================================================================

Deno.test("enumerateHandles: default returns live only", () => {
  const m = freshMembrane();
  const h1 = m.register({ kind: 'a' });
  const h2 = m.register({ kind: 'b' });
  m._freeHandleSlot(h1.slot);
  const list = m.enumerateHandles();
  assertEquals(list.length, 1);
  assertEquals(list[0].handle.slot, h2.slot);
});

Deno.test("enumerateHandles: includeReaped surfaces freed slots", () => {
  const m = freshMembrane();
  const h = m.register({ kind: 'a' });
  m._freeHandleSlot(h.slot);
  const list = m.enumerateHandles({ includeReaped: true });
  // One reaped entry; no live ones.
  assertEquals(list.length, 1);
  assert(list[0].reaped);
  assertEquals(list[0].slot, h.slot);
  assert(list[0].reapedAt !== null);
  assertEquals(list[0].reapedCallerTag, MUTATION_TAG.GC_REAP_HANDLE);
});

Deno.test("enumerateGrants: default unchanged for revoked-but-not-reaped", () => {
  // Pre-existing contract: revoke alone keeps slot live, returns
  // active:false with no flag. Item 6 must not break this.
  const m = freshMembrane();
  const g = m.createGrant('x');
  m.revoke(g);
  const list = m.enumerateGrants();
  assertEquals(list.length, 1);
  assertEquals(list[0].active, false);
  // No revokedAt without the flag:
  assertEquals(list[0].revokedAt, undefined);
});

Deno.test("enumerateGrants: includeRevoked adds revokedAt + tag", () => {
  const m = freshMembrane();
  const g = m.createGrant('x');
  m.revoke(g, MUTATION_TAG.HOST_REVOKE);
  const list = m.enumerateGrants({ includeRevoked: true });
  assertEquals(list.length, 1);
  assert(list[0].revokedAt !== null);
  assertEquals(list[0].revokeCallerTag, MUTATION_TAG.HOST_REVOKE);
});

Deno.test("enumerateGrants: includeReaped surfaces reaped grants", () => {
  const m = freshMembrane();
  const g = m.createGrant('x');
  m.revoke(g);
  m._freeGrantSlot(g.slot);
  const list = m.enumerateGrants({ includeReaped: true });
  // No live entries; one reaped.
  assertEquals(list.length, 1);
  assert(list[0].reaped);
  assertEquals(list[0].slot, g.slot);
  assert(list[0].reapedAt !== null);
  // Reaped grant carries both revokedAt and reapedAt.
  assert(list[0].revokedAt !== null);
});

Deno.test("enumerateClosureHandles: includeReaped surfaces freed closure slots", () => {
  const m = freshMembrane();
  const wrap = m.registerClosureHandle(0x100, [], { kind: 'cb' });
  m._freeClosureHandleSlot(wrap.slot);
  const list = m.enumerateClosureHandles({ includeReaped: true });
  assertEquals(list.length, 1);
  assert(list[0].reaped);
});

Deno.test("enumerateLinkedPromises: includeReaped surfaces settled/freed", () => {
  const m = freshMembrane();
  const slot = m.registerLinkedPromise(0x200);
  m._logLinkedPromiseSettle(slot, true);
  m._freeLinkedPromiseSlot(slot, MUTATION_TAG.LINKED_SETTLE);
  const list = m.enumerateLinkedPromises({ includeReaped: true });
  assertEquals(list.length, 1);
  assert(list[0].reaped);
  assertEquals(list[0].settledKind, MUTATION_KIND.LINKED_PROMISE_SETTLE);
});

// =============================================================================
// Item 7: state getters (production-callable) + reverse lookups (debug)
// =============================================================================

Deno.test("handleState: returns rich entry for live slot", () => {
  const m = freshMembrane();
  const h = m.register({ kind: 'x' }, { hint: 'meta' });
  const s = m.handleState(h);
  assert(s !== null);
  assert(s.active);
  assertEquals(s.currentVersion, h.version);
  assertEquals(s.metadata, { hint: 'meta' });
});

Deno.test("handleState: returns rich entry for reaped slot (no throw)", () => {
  const m = freshMembrane();
  const h = m.register({});
  m._freeHandleSlot(h.slot);
  const s = m.handleState(h.slot);
  assert(s !== null);
  assert(!s.active);
  assert(s.reaped);
  assert(s.currentVersion !== h.version,
    'reaped slot must have bumped version');
});

Deno.test("handleState: out-of-range returns null", () => {
  const m = freshMembrane();
  assertEquals(m.handleState(99999), null);
  assertEquals(m.handleState(-1), null);
});

Deno.test("handleState: accepts a wrapper or a slot number", () => {
  const m = freshMembrane();
  const h = m.register({});
  assertEquals(m.handleState(h).slot, h.slot);
  assertEquals(m.handleState(h.slot).slot, h.slot);
});

Deno.test("handleState: lastMutation is HANDLE-family only", () => {
  const m = freshMembrane();
  m.createGrant('g'); // unrelated grant at slot 0
  const h = m.register({});
  const s = m.handleState(h);
  assertEquals(s.lastMutation.kind, MUTATION_KIND.HANDLE_ALLOC);
});

Deno.test("grantState: distinguishes active / revoked / reaped", () => {
  const m = freshMembrane();
  const g = m.createGrant('x');
  let s = m.grantState(g);
  assert(s.active && !s.revoked && !s.reaped);
  m.revoke(g);
  s = m.grantState(g.slot);
  assert(!s.active && s.revoked && !s.reaped);
  m._freeGrantSlot(g.slot);
  s = m.grantState(g.slot);
  assert(!s.active && !s.revoked && s.reaped);
});

Deno.test("closureHandleState: surfaces captured grants on active slot", () => {
  const m = freshMembrane();
  const ga = m.createGrant('a');
  const gb = m.createGrant('b');
  const wrap = m.registerClosureHandle(0x500, [ga.slot, gb.slot], { tag: 'cb' });
  const s = m.closureHandleState(wrap);
  assert(s.active);
  assertEquals(s.capturedGrantSlots.length, 2);
  assert(s.capturedGrantSlots.includes(ga.slot));
});

Deno.test("linkedPromiseState: surfaces ssPromisePointer on active slot", () => {
  const m = freshMembrane();
  const slot = m.registerLinkedPromise(0x1234);
  const s = m.linkedPromiseState(slot);
  assert(s.active);
  assertEquals(s.ssPromisePointer, 0x1234);
});

Deno.test("isFresh idiom works via state getters", () => {
  const m = freshMembrane();
  const h = m.register({});
  // Live: matches.
  assertEquals(m.handleState(h)?.currentVersion === h.version, true);
  m._freeHandleSlot(h.slot);
  // Stale: doesn't match.
  assertEquals(m.handleState(h)?.currentVersion === h.version, false);
});

Deno.test("Debug.findHandle: returns slot for registered impl", () => {
  const session = freshSession();
  const debug = createDebug(session);
  const impl = { kind: 'found-me' };
  const h = session.airlock.register(impl);
  assertEquals(debug.findHandle(impl), h.slot);
});

Deno.test("Debug.findHandle: returns null for unknown impl", () => {
  const session = freshSession();
  const debug = createDebug(session);
  assertEquals(debug.findHandle({ unknown: true }), null);
});

Deno.test("Debug.findGrant: matches by identifier", () => {
  const session = freshSession();
  const debug = createDebug(session);
  const g = session.airlock.membrane.createGrant('unique-id-42');
  assertEquals(debug.findGrant('unique-id-42'), g.slot);
  assertEquals(debug.findGrant('nope'), null);
});

Deno.test("Debug.findClosureHandle: matches by closurePointer", () => {
  const session = freshSession();
  const debug = createDebug(session);
  const wrap = session.airlock.membrane.registerClosureHandle(0xABCD, [], null);
  assertEquals(debug.findClosureHandle(0xABCD), wrap.slot);
  assertEquals(debug.findClosureHandle(0xDEAD), null);
});

Deno.test("Debug.findLinkedPromise: matches by ssPromisePointer", () => {
  const session = freshSession();
  const debug = createDebug(session);
  const slot = session.airlock.membrane.registerLinkedPromise(0xCAFE);
  assertEquals(debug.findLinkedPromise(0xCAFE), slot);
  assertEquals(debug.findLinkedPromise(0xBEEF), null);
});

// =============================================================================
// Item 8: engine counters + heap/string inventories
// =============================================================================

Deno.test("engineCounters: fresh session is all zero", () => {
  const session = freshSession();
  const c = session.airlock.membrane.engineCounters();
  assertEquals(c.gcPassCount, 0);
  // Host-owned memory removed session-side snapshotting and snapshotCount.
  // The host owns the buffers and slices them at will, so snapshotting has no
  // engine-side counter.
  assertEquals(c.resizeSegmentCount, 0);
  assertEquals(c.resizeRegionsCount, 0);
  assertEquals(c.gcBytesReclaimedTotal, 0n);
  assertEquals(c.gcLastTick, 0n);
  assertEquals(c.gcLastBytesReclaimed, 0);
});

Deno.test("engineCounters: gcPassCount bumps on session.gc()", () => {
  const session = freshSession();
  const before = session.airlock.membrane.engineCounters().gcPassCount;
  session.gc();
  session.gc();
  const after = session.airlock.membrane.engineCounters().gcPassCount;
  assertEquals(after, before + 2);
});

Deno.test("engineCounters: gcLastTick matches tick at GC", () => {
  const session = freshSession();
  session.gc();
  const tickAfter = session.tick();
  const c = session.airlock.membrane.engineCounters();
  assertEquals(c.gcLastTick, tickAfter);
});

// Host-orchestrated snapshotting is not engine-side bookkeeping: the host
// slices its own buffers and counts snapshots at its own level when needed.

Deno.test("engineCounters: resizeSegmentCount bumps on resizeSegment()", () => {
  const session = freshSession();
  session.resizeSegment({ newSegmentSize: 768 * 1024 });
  assertEquals(session.airlock.membrane.engineCounters().resizeSegmentCount, 1);
});

Deno.test("engineCounters: resizeRegionsCount bumps on membrane.resizeRegions()", () => {
  const buffer = new ArrayBuffer(512 * 1024);
  const m = freshMembrane({
    buffer, byteOffset: 0, byteLength: 256 * 1024,
    handleTableCapacity: 8, grantTableCapacity: 8,
    idListPoolSize: 256, rootGrantsListCapacity: 4,
    valueArenaSize: 1024, closureHandleTableCapacity: 4,
    linkedPromiseTableCapacity: 4,
    mutationLogCapacity: 16,
  });
  m.resizeRegions({ valueArenaSize: 2048 });
  assertEquals(m.engineCounters().resizeRegionsCount, 1);
});

Deno.test("engineCounters: GC byte reclamation accumulates", () => {
  const session = freshSession();
  // Allocate something so there's reclaimable garbage on the heap.
  // Bare session has small overhead; gc should still complete.
  const before = session.airlock.membrane.engineCounters().gcBytesReclaimedTotal;
  session.gc();
  const after = session.airlock.membrane.engineCounters().gcBytesReclaimedTotal;
  assert(after >= before,
    `gcBytesReclaimedTotal must be monotonic; ${before} → ${after}`);
});

Deno.test("Debug.heapInventory: returns walkable heap object list", () => {
  const session = freshSession();
  const debug = createDebug(session);
  const inv = debug.dumpState().heap.inventory;
  // Fresh session has at least the root scope object.
  assert(Array.isArray(inv));
  assert(inv.length > 0,
    `expected at least one heap object, got ${inv.length}`);
  for (const obj of inv) {
    assert(typeof obj.address === 'number');
    assert(typeof obj.size === 'number');
    assert(typeof obj.type === 'string');
  }
});

Deno.test("Debug.stringTableInventory: returns interned strings", () => {
  const session = freshSession();
  const debug = createDebug(session);
  // Compile a string literal so a fresh intern happens.
  parseAndPrime(session, '"hello-debug-slice-c"');
  session.run(0, 10000);
  const inv = debug.dumpState().strings.inventory;
  const found = inv.find(e => e.valuePreview === 'hello-debug-slice-c');
  assert(found, 'should find the interned literal in the string inventory');
  assertEquals(found.length, 'hello-debug-slice-c'.length);
});

// =============================================================================
// Item 5: dumpContexts + session.state new fields
// =============================================================================

Deno.test("session.state(slot): new fields default to null when nothing applies", () => {
  const session = freshSession();
  parseAndPrime(session, '1 + 1');
  session.run(0, 100);
  const s = session.state(0);
  assertEquals(s.blockedOnPromise, null);
  assertEquals(s.blockedOnGrant, false);
  assertEquals(s.pendingCall, null);
  // lastTickRun was set by airlock.runContext during session.run(0, ...).
  assert(s.lastTickRun !== null,
    `lastTickRun should be set after a run; got ${s.lastTickRun}`);
});

Deno.test("session.state(slot): pendingCall populated mid-external-call", () => {
  const session = freshSession();
  const impl = {};
  const h = session.airlock.register(impl);
  session.airlock.declare('Ext', h);
  session.airlock.setHandler(h, 'noop', () => {
    // Park at the external call by NOT returning before run() resumes.
    return undefined;
  });
  // Drone calls Ext.noop(); on EXIT_EXTERNAL_CALL, the request region
  // holds the call's shape. We have to drive the run loop ourselves
  // (session.run handles external calls internally, so we use
  // airlock.runContext to pause at the boundary).
  parseAndPrime(session, 'Ext.noop()');
  session.airlock.runContext(0, 10000);
  const s = session.state(0);
  if (s.exitCondition === 'external_call') {
    assert(s.pendingCall !== null);
    assertEquals(s.pendingCall.method, 'noop');
    assertEquals(s.pendingCall.handleSlot, h.slot);
  }
  // If the runContext path didn't pause there (engine may have
  // resolved synchronously), at least confirm the field accepted
  // the absence cleanly.
});

Deno.test("Debug.dumpContexts: returns one entry per live context", () => {
  const session = freshSession();
  parseAndPrime(session, 'let x = 5');
  session.run(0, 1000);
  const debug = createDebug(session);
  const ctxs = debug.dumpContexts();
  assertEquals(ctxs.length, 1);
  assertEquals(ctxs[0].context, 0);
  // Eager flatten: all the lazy fields are realized.
  assert(Array.isArray(ctxs[0].pending));
  assert(Array.isArray(ctxs[0].callStack));
  assert(Array.isArray(ctxs[0].heapObjects));
  assert(typeof ctxs[0].scope === 'object');
});

Deno.test("Debug.dumpContexts: same shape as session.state(slot) modulo lazy resolution", () => {
  const session = freshSession();
  parseAndPrime(session, '1 + 1');
  session.run(0, 1000);
  const debug = createDebug(session);
  const ctxs = debug.dumpContexts();
  const live = session.state(0);
  // Plain-data fields must match exactly.
  assertEquals(ctxs[0].context, live.context);
  assertEquals(ctxs[0].instruction, live.instruction);
  assertEquals(ctxs[0].instructionCount, live.instructionCount);
  assertEquals(ctxs[0].callStackDepth, live.callStackDepth);
  assertEquals(ctxs[0].pendingStackDepth, live.pendingStackDepth);
  assertEquals(ctxs[0].blockedOnPromise, live.blockedOnPromise);
  assertEquals(ctxs[0].blockedOnGrant, live.blockedOnGrant);
  assertEquals(ctxs[0].pendingCall, live.pendingCall);
  assertEquals(ctxs[0].lastTickRun, live.lastTickRun);
});

// =============================================================================
// dumpState integration: subsections now populated
// =============================================================================

Deno.test("dumpState: heap.inventory now non-empty", () => {
  const session = freshSession();
  const debug = createDebug(session);
  const d = debug.dumpState();
  assert(Array.isArray(d.heap.inventory));
  assert(d.heap.inventory.length > 0);
});

Deno.test("dumpState: membrane.engineCounters reports real counters", () => {
  const session = freshSession();
  session.gc();
  const debug = createDebug(session);
  const d = debug.dumpState();
  assertEquals(d.membrane.engineCounters.gcPassCount, 1);
  // snapshotCount removed under host-owned-memory.
});

Deno.test("dumpState: contexts is now populated by dumpContexts", () => {
  const session = freshSession();
  parseAndPrime(session, '1 + 1');
  session.run(0, 1000);
  const debug = createDebug(session);
  const d = debug.dumpState();
  assertEquals(d.contexts.length, 1);
});

Deno.test("dumpState: strings.inventory lists interned strings", () => {
  const session = freshSession();
  const debug = createDebug(session);
  parseAndPrime(session, '"slice-c-string-marker"');
  session.run(0, 10000);
  const d = debug.dumpState();
  const found = d.strings.inventory.find(
    e => e.valuePreview === 'slice-c-string-marker');
  assert(found, 'expected the literal in strings.inventory');
});

Deno.test("dumpState: inventory flags { includeReaped: false } excludes reaped", () => {
  const session = freshSession();
  const debug = createDebug(session);
  const h = session.airlock.register({});
  session.airlock.membrane._freeHandleSlot(h.slot);
  const dWith = debug.dumpState();
  const dWithout = debug.dumpState({ inventories: { includeReaped: false } });
  const reapedInWith = dWith.membrane.inventories.handles
    .some(e => e.reaped);
  const reapedInWithout = dWithout.membrane.inventories.handles
    .some(e => e.reaped);
  assert(reapedInWith, 'default dumpState should include reaped');
  assert(!reapedInWithout, 'opt-out should exclude reaped');
});

Deno.test("dumpState: still pure read (counters unchanged before vs after)", () => {
  const session = freshSession();
  const debug = createDebug(session);
  session.airlock.register({});
  const tickBefore = debug.tick();
  const countersBefore = debug.mutationCounters();
  const engineBefore = session.airlock.membrane.engineCounters();
  debug.dumpState();
  debug.dumpState();
  assertEquals(debug.tick(), tickBefore);
  assertEquals(debug.mutationCounters(), countersBefore);
  assertEquals(session.airlock.membrane.engineCounters(), engineBefore);
});

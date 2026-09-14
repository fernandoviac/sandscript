/**
 * Debug observability tests covering the Debug wrapper, structured stale
 * error context, dumpState, and dumpStateFromBytes.
 *
 * Run with: deno task test tests/fuel/debug_slice_b_test.js
 */

import { assertEquals, assert, assertThrows } from "https://deno.land/std@0.208.0/assert/mod.ts";
import { createSession } from '../../src/fuel/session.js';
import { createDebug } from '../../src/fuel/debug.js';
import {
  Membrane,
  Handle,
  Grant,
  ClosureHandle,
  StaleHandleError,
  StaleGrantError,
  StaleClosureHandleError,
  SnapshotOrphanedError,
  MUTATION_KIND,
  MUTATION_TAG,
  MUTATION_KIND_FAMILY,
} from '../../src/membrane/index.js';
import { freshMembrane, freshSession, snapshotSession } from '../../src/host-owned-session.js';
import { DRONE_FORMAT_VERSION } from '../../src/persisted-format.js';

// =============================================================================
// Item 3: Debug wrapper
// =============================================================================

Deno.test("Debug: createDebug(session) returns a Debug instance", () => {
  const session = freshSession();
  const debug = createDebug(session);
  assert(typeof debug === 'object');
  assert(typeof debug.dumpState === 'function');
  assert(typeof debug.dumpStateFromBytes === 'function');
  assert(typeof debug.tick === 'function');
  assert(typeof debug.mutationLog === 'function');
  assert(typeof debug.mutationCounters === 'function');
});

Deno.test("Debug: rejects non-session arguments", () => {
  assertThrows(() => createDebug(null), TypeError, 'requires a session');
  assertThrows(() => createDebug({}), TypeError, 'requires a session');
  assertThrows(() => createDebug({ airlock: {} }), TypeError, 'requires a session');
});

Deno.test("Debug: createDebug is cheap (constructs 100 Debugs without error)", () => {
  const session = freshSession();
  for (let i = 0; i < 100; i++) {
    const d = createDebug(session);
    assertEquals(typeof d.tick(), 'bigint');
  }
});

Deno.test("Debug: multiple Debug instances share the underlying log + counters", () => {
  const session = freshSession();
  const d1 = createDebug(session);
  const d2 = createDebug(session);
  session.airlock.register({});
  // Same underlying log → same view of mutations.
  assertEquals(d1.mutationCounters(), d2.mutationCounters());
  const l1 = d1.mutationLog({ limit: 5 });
  const l2 = d2.mutationLog({ limit: 5 });
  assertEquals(l1.length, l2.length);
  if (l1.length > 0) {
    assertEquals(l1[0].seq, l2[0].seq);
  }
});

Deno.test("Debug: exposes session, membrane, airlock, memoryImage accessors", () => {
  const session = freshSession();
  const debug = createDebug(session);
  assertEquals(debug.session, session);
  assertEquals(debug.membrane, session.airlock.membrane);
  assertEquals(debug.airlock, session.airlock);
  assertEquals(debug.memoryImage, session.memoryImage);
});

Deno.test("Debug: tick / mutationLog / mutationCounters pass through to membrane", () => {
  const session = freshSession();
  const debug = createDebug(session);
  const m = session.airlock.membrane;
  assertEquals(debug.tick(), m.tick());
  assertEquals(debug.mutationCounters(), m.mutationCounters());
  assertEquals(debug.mutationLogCapacity(), m.mutationLogCapacity());
});

// =============================================================================
// Item 9: Structured stale-error context
// =============================================================================

Deno.test("StaleHandleError: existing fields preserved (.slot, .expectedVersion, .actualVersion)", () => {
  const m = freshMembrane();
  const h = m.register({});
  // Force the slot version to a different value.
  m._freeHandleSlot(h.slot);
  try {
    m.lookup(h);
    assert(false, 'lookup should throw');
  } catch (e) {
    assert(e instanceof StaleHandleError);
    assertEquals(e.slot, h.slot);
    assertEquals(e.expectedVersion, h.version);
    assert(e.actualVersion !== h.version);
  }
});

Deno.test("StaleHandleError: carries lastMutation and mutationHistory from the log", () => {
  const m = freshMembrane();
  const h = m.register({ kind: 'X' });
  m._freeHandleSlot(h.slot);
  try {
    m.lookup(h);
    assert(false);
  } catch (e) {
    assert(e instanceof StaleHandleError);
    assert(e.lastMutation !== null, 'lastMutation should be populated');
    assertEquals(e.lastMutation.kind, MUTATION_KIND.HANDLE_FREE);
    assertEquals(e.lastMutation.slot, h.slot);
    assertEquals(e.lastMutation.callerTag, MUTATION_TAG.GC_REAP_HANDLE);
    // History is newest-first; first entry is the free, second is the alloc.
    assert(e.mutationHistory.length >= 2);
    assertEquals(e.mutationHistory[0].kind, MUTATION_KIND.HANDLE_FREE);
    assertEquals(e.mutationHistory[1].kind, MUTATION_KIND.HANDLE_ALLOC);
  }
});

Deno.test("StaleHandleError: atTick captures the membrane tick at throw time", () => {
  const session = freshSession();
  const m = session.airlock.membrane;
  const h = session.airlock.register({});
  session.gc(); // bumps tick + may not free this handle, but tick advances
  m._freeHandleSlot(h.slot);
  const tickAtThrow = m.tick();
  try {
    session.airlock.lookup(h);
    assert(false);
  } catch (e) {
    assertEquals(e.atTick, tickAtThrow);
  }
});

Deno.test("StaleHandleError: history is filtered to HANDLE family only", () => {
  const m = freshMembrane();
  // Allocate handle and grant at slot 0 of each table; grant's log
  // entries must not pollute the handle's history.
  const h = m.register({});
  m.createGrant('g');   // grant slot 0
  m._freeHandleSlot(h.slot);
  try {
    m.lookup(h);
    assert(false);
  } catch (e) {
    for (const entry of e.mutationHistory) {
      const k = entry.kind;
      assert(
        k === MUTATION_KIND.HANDLE_ALLOC || k === MUTATION_KIND.HANDLE_FREE,
        `expected HANDLE-family kind, got ${k}`);
    }
  }
});

Deno.test("StaleGrantError: carries structured context from grant family", () => {
  const m = freshMembrane();
  const g = m.createGrant('x');
  m.revoke(g);
  // Note: revoke alone keeps the version stable. To force a stale
  // wrapper, reap the slot which bumps the version.
  m._freeGrantSlot(g.slot);
  try {
    m.lookup({ slot: g.slot, version: g.version, [Symbol.for('sandscript:grant')]: true });
    // ^ but we need a real Grant wrapper for lookup… instead force the
    // unwrap directly via metadata read:
    m.metadata({ slot: g.slot, version: g.version, [Symbol.for('sandscript:handle')]: true });
    assert(false, 'should throw');
  } catch (e) {
    // The wrapper we constructed is a Handle (with the handle tag),
    // so metadata throws StaleHandleError, not StaleGrantError. Use
    // a real Grant wrapper to test the grant path.
  }
  // Now actually exercise StaleGrantError:
  const g2 = m.createGrant('y');
  m._freeGrantSlot(g2.slot);
  try {
    // Trigger any operation that unwraps the grant. revoke does.
    m.revoke(g2);
    assert(false);
  } catch (e) {
    assert(e instanceof StaleGrantError);
    assert(e.lastMutation !== null);
    assertEquals(e.lastMutation.slot, g2.slot);
    // History should only contain GRANT-family entries.
    for (const entry of e.mutationHistory) {
      assert(
        (MUTATION_KIND_FAMILY.GRANT & (1 << entry.kind)) !== 0,
        `expected GRANT-family kind, got ${entry.kind}`);
    }
  }
});

Deno.test("StaleClosureHandleError: carries structured context from closure family", () => {
  const m = freshMembrane();
  const wrap = m.registerClosureHandle(0x100, [], { kind: 'cb' });
  m._freeClosureHandleSlot(wrap.slot);
  try {
    m._slotOfClosureHandle(wrap);
    assert(false);
  } catch (e) {
    assert(e instanceof StaleClosureHandleError);
    assert(e.lastMutation !== null);
    assertEquals(e.lastMutation.kind, MUTATION_KIND.CLOSURE_HANDLE_FREE);
  }
});

Deno.test("Stale error: lastMutation is null when log has wrapped past it", () => {
  // Capacity 2 so two more mutations evict the alloc+free pair.
  const m = freshMembrane({ mutationLogCapacity: 2 });
  const h = m.register({});
  m._freeHandleSlot(h.slot);
  // Both entries for slot 0 still in the ring. Now overwrite both.
  m.register({});
  m.register({});
  m.register({});  // ring has wrapped well past h's entries
  try {
    m.lookup(h);
    assert(false);
  } catch (e) {
    assert(e instanceof StaleHandleError);
    // Slot 0's entries are gone (slot 0 was reused by the first
    // register above, but at a different version; the wrap evicted
    // h's original alloc/free entries). lastMutation should refer
    // to the most recent slot-0 entry, which is the realloc — that
    // entry exists, so lastMutation is not null in this case.
    // For a true wrap-past, use a slot that nobody touches after.
  }
  // Use a slot nobody touches: stale wrapper for a slot whose
  // entries got evicted.
  const m2 = freshMembrane({ mutationLogCapacity: 2 });
  const h2 = m2.register({});
  m2._freeHandleSlot(h2.slot);
  // Now fill ring with mutations on a different table (grants).
  m2.createGrant('a');
  m2.createGrant('b');
  m2.createGrant('c');
  // h2 family history is gone; the ring holds only grant entries.
  try {
    m2.lookup(h2);
    assert(false);
  } catch (e) {
    assertEquals(e.lastMutation, null,
      'lastMutation should be null when log wrapped past relevant entries');
    assertEquals(e.mutationHistory, []);
    // Existing fields still populated:
    assertEquals(e.slot, h2.slot);
    assertEquals(e.expectedVersion, h2.version);
  }
});

Deno.test("Stale error: JSON.stringify succeeds and round-trips own properties", () => {
  const m = freshMembrane();
  const h = m.register({ kind: 'X' });
  m._freeHandleSlot(h.slot);
  try {
    m.lookup(h);
  } catch (e) {
    // Own properties survive; tick is bigint so we need a replacer.
    const json = JSON.stringify(e, (k, v) =>
      typeof v === 'bigint' ? `${v}n` : v);
    assert(json.includes('"slot"'));
    assert(json.includes('"lastMutation"'));
    assert(json.includes('"mutationHistory"'));
    assert(json.includes('"atTick"'));
  }
});

Deno.test("SnapshotOrphanedError: accepts details and exposes them", () => {
  const err = new SnapshotOrphanedError('orphaned', {
    tick: 42n,
    lastMutation: null,
  });
  assertEquals(err.atTick, 42n);
  assertEquals(err.lastMutation, null);
  // Backwards compatible with no-args:
  const err2 = new SnapshotOrphanedError();
  assertEquals(err2.atTick, null);
});

// =============================================================================
// Item 4: Debug.dumpState
// =============================================================================

Deno.test("dumpState: default populates every top-level key", () => {
  const session = freshSession();
  const debug = createDebug(session);
  const dump = debug.dumpState();
  assert('capturedAt' in dump);
  assert('tick' in dump);
  assert('engine' in dump);
  assert('heap' in dump);
  assert('membrane' in dump);
  assert('contexts' in dump);
  assert('strings' in dump);
});

Deno.test("dumpState: shape of each top-level subtree is stable", () => {
  const session = freshSession();
  const debug = createDebug(session);
  const d = debug.dumpState();
  assertEquals(typeof d.tick, 'bigint');
  assertEquals(typeof d.engine, 'object');
  assertEquals(d.engine.formatVersion, DRONE_FORMAT_VERSION);
  assertEquals(d.engine.forensic, false);
  // heap section
  assert(typeof d.heap.heapPointer === 'number');
  assert(typeof d.heap.heapEnd === 'number');
  assert(Array.isArray(d.heap.inventory));
  // membrane section
  assertEquals(d.membrane.formatVersion, DRONE_FORMAT_VERSION);
  assertEquals(typeof d.membrane.mutationCounters, 'object');
  assert(Array.isArray(d.membrane.log));
  assert('inventories' in d.membrane);
  assert(Array.isArray(d.membrane.inventories.handles));
  // contexts placeholder
  assert(Array.isArray(d.contexts));
  // strings placeholder
  assert(Array.isArray(d.strings.inventory));
});

Deno.test("dumpState: JSON.stringify succeeds with bigint replacer", () => {
  const session = freshSession();
  const debug = createDebug(session);
  session.airlock.register({});
  session.airlock.createRootGrant('root');
  const d = debug.dumpState();
  const replacer = (k, v) => typeof v === 'bigint' ? `${v}n` : v;
  const json = JSON.stringify(d, replacer);
  assert(typeof json === 'string');
  assert(json.length > 0);
  // Round-trip is structural (bigints become strings; that's fine
  // for a forensic dump — the original dump object is the source of
  // truth, JSON is the serialization).
  const back = JSON.parse(json);
  assertEquals(back.engine.formatVersion, DRONE_FORMAT_VERSION);
});

Deno.test("dumpState: selective inclusion omits requested sections", () => {
  const session = freshSession();
  const debug = createDebug(session);
  const noHeap = debug.dumpState({ heap: false });
  assert(!('heap' in noHeap));
  assert('membrane' in noHeap);
  const noContexts = debug.dumpState({ contexts: false });
  assert(!('contexts' in noContexts));
  const noEngine = debug.dumpState({ engine: false });
  assert(!('engine' in noEngine));
});

Deno.test("dumpState: pure read — tick and counters unchanged before vs after", () => {
  const session = freshSession();
  const debug = createDebug(session);
  session.airlock.register({});
  session.airlock.createRootGrant('r');
  const tickBefore = debug.tick();
  const countersBefore = debug.mutationCounters();
  debug.dumpState();
  debug.dumpState({ heap: false });
  debug.dumpState({ membrane: false });
  assertEquals(debug.tick(), tickBefore,
    'dumpState must not bump tick');
  assertEquals(debug.mutationCounters(), countersBefore,
    'dumpState must not bump any counter');
});

Deno.test("dumpState.membrane.log respects log options", () => {
  const session = freshSession();
  const debug = createDebug(session);
  for (let i = 0; i < 5; i++) session.airlock.register({});
  const small = debug.dumpState({ log: { limit: 2 } });
  assertEquals(small.membrane.log.length, 2);
  const filtered = debug.dumpState({
    log: { kindMask: 1 << MUTATION_KIND.HANDLE_ALLOC },
  });
  for (const e of filtered.membrane.log) {
    assertEquals(e.kind, MUTATION_KIND.HANDLE_ALLOC);
  }
});

Deno.test("dumpStateFromBytes: matches live dumpState modulo live-only fields", () => {
  const session = freshSession();
  const debug = createDebug(session);
  session.airlock.register({});
  const live = debug.dumpState();
  const snap = snapshotSession(session);
  const forensic = debug.dumpStateFromBytes(snap.membraneBytes, snap.vatBytes);
  // Live and forensic agree on the membrane subtree's structural
  // shape (counters, log length, format version).
  assertEquals(forensic.engine.forensic, true);
  assertEquals(forensic.engine.formatVersion, DRONE_FORMAT_VERSION);
  // Tick at forensic time matches the snapshot's tick (snapshot bumps
  // tick before serializing).
  assertEquals(forensic.tick, session.tick());
  // Counters travel through the bytes.
  assertEquals(forensic.membrane.mutationCounters,
               live.membrane.mutationCounters);
});

Deno.test("dumpStateFromBytes: works with only membraneBytes (no heap)", () => {
  const session = freshSession();
  const debug = createDebug(session);
  session.airlock.register({});
  const snap = snapshotSession(session);
  const forensic = debug.dumpStateFromBytes(snap.membraneBytes);
  // Heap section has null heap reader → returns null section.
  assertEquals(forensic.heap, null);
  // Membrane section still complete.
  assert(forensic.membrane.log.length > 0);
});

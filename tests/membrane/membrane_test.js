/**
 * Membrane test suite.
 *
 * Run with: deno task test tests/membrane/membrane_test.js
 *
 * Slice 1 of snapshottable-membrane: register/lookup/setHandler return and
 * accept Handle wrappers (not raw integer ids). Direct access to internal
 * Maps is gone — tests probe through the public wrapped API.
 */

import { assertEquals, assertThrows, assert } from "https://deno.land/std@0.208.0/assert/mod.ts";
import {
  Membrane,
  Handle,
  Grant,
  isHandle,
  isGrant,
  MembraneOutOfSpaceError,
  StaleHandleError,
  StaleGrantError,
  MEMBRANE_HEADER_SIZE,
  RUNTIME_STATE_CELL_BYTES,
  LEDGER_REGION_BYTES,
  CAPABILITY_STATE_ENTRY_SIZE,
  DEFAULT_CAPABILITY_STATE_TABLE_CAPACITY,
  LINKED_PROMISE_ENTRY_SIZE,
  COST_LEDGER_ENTRY_SIZE,
  DEFAULT_COST_LEDGER_CAPACITY,
  OBJECT_HANDLE_ENTRY_SIZE,
  DEFAULT_OBJECT_HANDLE_TABLE_CAPACITY,
} from '../../src/membrane/index.js';
import { freshMembrane } from '../../src/host-owned-session.js';

// =============================================================================
// Basic Registration
// =============================================================================

Deno.test("Membrane: register() returns a Handle wrapper", () => {
  const membrane = freshMembrane();
  const handle = membrane.register({ name: 'first' });
  assert(isHandle(handle));
  assertEquals(handle.slot, 0);
  assertEquals(handle.version, 1);
});

Deno.test("Membrane: register() bumps slot for each call", () => {
  const membrane = freshMembrane();
  const h0 = membrane.register({ name: 'first' });
  const h1 = membrane.register({ name: 'second' });
  const h2 = membrane.register({ name: 'third' });
  assertEquals(h0.slot, 0);
  assertEquals(h1.slot, 1);
  assertEquals(h2.slot, 2);
});

Deno.test("Membrane: lookup() returns registered value", () => {
  const membrane = freshMembrane();
  const obj = { name: 'test' };
  const handle = membrane.register(obj);
  assertEquals(membrane.lookup(handle), obj);
});

Deno.test("Membrane: metadata() returns provided metadata", () => {
  const membrane = freshMembrane();
  const meta = { description: 'test handle' };
  const handle = membrane.register({}, meta);
  assertEquals(membrane.metadata(handle), meta);
});

Deno.test("Membrane: lookup() with stale Handle throws StaleHandleError", () => {
  const membrane = freshMembrane();
  const handle = membrane.register({});
  // Synthesize a stale handle: same slot, different version.
  const stale = new Handle(handle.slot, handle.version + 99);
  assertThrows(
    () => membrane.lookup(stale),
    StaleHandleError,
  );
});

Deno.test("Membrane: lookup() with non-Handle throws TypeError", () => {
  const membrane = freshMembrane();
  assertThrows(
    () => membrane.lookup(0),
    TypeError,
    'Expected a Handle',
  );
});

// =============================================================================
// Grant Creation (slice 2: SAB-resident grant table + inverse index)
// =============================================================================

Deno.test("Membrane: createGrant() returns grant with incrementing id", () => {
  const membrane = freshMembrane();
  const grant0 = membrane.createGrant('first');
  const grant1 = membrane.createGrant('second');
  assertEquals(grant0.slot, 0);
  assertEquals(grant1.slot, 1);
});

Deno.test("Membrane: grant starts with empty handles set", () => {
  const membrane = freshMembrane();
  const grant = membrane.createGrant('test');
  assertEquals(grant.handleSlots().size, 0);
});

Deno.test("Membrane: grant starts active", () => {
  const membrane = freshMembrane();
  const grant = membrane.createGrant('test');
  assertEquals(grant.active, true);
});

Deno.test("Membrane: grant has identifier", () => {
  const membrane = freshMembrane();
  const grant = membrane.createGrant('filesystem');
  assertEquals(grant.identifier, 'filesystem');
});

// =============================================================================
// Grant Population
// =============================================================================

Deno.test("Membrane: grant.add() accepts Handle and tracks slot", () => {
  const membrane = freshMembrane();
  const handle = membrane.register({});
  const grant = membrane.createGrant('test');

  grant.add(handle);

  assert(grant.handleSlots().has(handle.slot));
});

Deno.test("Membrane: multiple grants can contain same handle", () => {
  const membrane = freshMembrane();
  const handle = membrane.register({});
  const grant1 = membrane.createGrant('first');
  const grant2 = membrane.createGrant('second');

  grant1.add(handle);
  grant2.add(handle);

  assert(grant1.handleSlots().has(handle.slot));
  assert(grant2.handleSlots().has(handle.slot));
});

Deno.test("Membrane: grant.add() throws for unknown handle slot", () => {
  const membrane = freshMembrane();
  const grant = membrane.createGrant('test');
  // Synthesize a Handle with version 0 for slot 999 — not registered.
  const phantom = new Handle(999, 0);
  // The version check fires first because the slot is out of range and
  // _readHandleVersion returns 0; the handle's version is also 0, so
  // unwrapHandle succeeds, then _handleSlotIsLive returns false and grant.add
  // throws "Unknown handle".
  assertThrows(
    () => grant.add(phantom),
    Error,
    'Unknown handle',
  );
});

Deno.test("Membrane: grant.add() throws on revoked grant", () => {
  const membrane = freshMembrane();
  const handle = membrane.register({});
  const grant = membrane.createGrant('test');

  membrane.revoke(grant);

  assertThrows(
    () => grant.add(handle),
    Error,
    'Cannot add handle to revoked grant',
  );
});

Deno.test("Membrane: grant.add() with stale Handle throws StaleHandleError", () => {
  const membrane = freshMembrane();
  const handle = membrane.register({});
  const grant = membrane.createGrant('test');
  const stale = new Handle(handle.slot, handle.version + 99);
  assertThrows(
    () => grant.add(stale),
    StaleHandleError,
  );
});

// =============================================================================
// Authorization Check
// =============================================================================

Deno.test("Membrane: handle with no grants is never authorized", () => {
  const membrane = freshMembrane();
  const handle = membrane.register({});
  const grant = membrane.createGrant('test');
  const activeGrants = new Set([grant.slot]);
  assertEquals(membrane.check(handle, activeGrants), false);
});

Deno.test("Membrane: handle authorized when grant in active set", () => {
  const membrane = freshMembrane();
  const handle = membrane.register({});
  const grant = membrane.createGrant('test');
  grant.add(handle);

  const activeGrants = new Set([grant.slot]);
  assertEquals(membrane.check(handle, activeGrants), true);
});

Deno.test("Membrane: handle not authorized with empty active set", () => {
  const membrane = freshMembrane();
  const handle = membrane.register({});
  const grant = membrane.createGrant('test');
  grant.add(handle);

  const emptySet = new Set();
  assertEquals(membrane.check(handle, emptySet), false);
});

Deno.test("Membrane: handle with multiple grants — ANY active is sufficient", () => {
  // Authorization rule (see Membrane.checkBySlot): a handle is callable
  // iff (a) at least one grant in its list is active AND (b) no grant
  // in its list is revoked. ANY-active (OR semantics) is what makes the
  // idiomatic "fresh grant per onGrantRequest" pattern work across
  // multiple block entries — old grants from previous blocks sit
  // dormant in the list, contributing nothing, while the current
  // block's grant authorizes the call.
  const membrane = freshMembrane();
  const handle = membrane.register({});
  const grant1 = membrane.createGrant('first');
  const grant2 = membrane.createGrant('second');

  grant1.add(handle);
  grant2.add(handle);

  const set1 = new Set([grant1.slot]);
  const set2 = new Set([grant2.slot]);
  const setBoth = new Set([grant1.slot, grant2.slot]);
  const empty = new Set();

  // Any active grant in the handle's list authorizes.
  assertEquals(membrane.check(handle, set1), true);
  assertEquals(membrane.check(handle, set2), true);
  assertEquals(membrane.check(handle, setBoth), true);
  // No active grants → denied.
  assertEquals(membrane.check(handle, empty), false);
});

Deno.test("Membrane: check() with stale Handle returns false (treated as denied)", () => {
  const membrane = freshMembrane();
  const handle = membrane.register({});
  const grant = membrane.createGrant('test');
  grant.add(handle);
  const activeGrants = new Set([grant.slot]);

  const stale = new Handle(handle.slot, handle.version + 99);
  assertEquals(membrane.check(stale, activeGrants), false);
});

// =============================================================================
// Revocation
// =============================================================================

Deno.test("Membrane: revoke() marks grant as dead", () => {
  const membrane = freshMembrane();
  const grant = membrane.createGrant('test');

  assertEquals(grant.active, true);
  membrane.revoke(grant);
  assertEquals(grant.active, false);
});

Deno.test("Membrane: handles requiring revoked grant fail check", () => {
  const membrane = freshMembrane();
  const handle = membrane.register({});
  const grant = membrane.createGrant('test');
  grant.add(handle);

  const activeGrants = new Set([grant.slot]);
  assertEquals(membrane.check(handle, activeGrants), true);

  membrane.revoke(grant);
  assertEquals(membrane.check(handle, activeGrants), false);
});

Deno.test("Membrane: revoked grant in active set doesn't help", () => {
  const membrane = freshMembrane();
  const handle = membrane.register({});
  const grant = membrane.createGrant('test');
  grant.add(handle);

  const activeGrants = new Set([grant.slot]);
  membrane.revoke(grant);

  assertEquals(membrane.check(handle, activeGrants), false);
});

// =============================================================================
// Compound Grants
// =============================================================================

Deno.test("Membrane: handle in grants A and B — either active is sufficient", () => {
  // Same as the "multiple grants" test above; this one is grouped
  // under "Compound Grants" but the rule is identical: OR on
  // activeness, AND on not-revoked.
  const membrane = freshMembrane();
  const handle = membrane.register({});
  const grantA = membrane.createGrant('A');
  const grantB = membrane.createGrant('B');

  grantA.add(handle);
  grantB.add(handle);

  const setA = new Set([grantA.slot]);
  const setB = new Set([grantB.slot]);
  const setBoth = new Set([grantA.slot, grantB.slot]);

  assertEquals(membrane.check(handle, setA), true);
  assertEquals(membrane.check(handle, setB), true);
  assertEquals(membrane.check(handle, setBoth), true);
});

Deno.test("Membrane: revoking A makes handle unauthorized even if B active", () => {
  const membrane = freshMembrane();
  const handle = membrane.register({});
  const grantA = membrane.createGrant('A');
  const grantB = membrane.createGrant('B');

  grantA.add(handle);
  grantB.add(handle);

  const setBoth = new Set([grantA.slot, grantB.slot]);
  assertEquals(membrane.check(handle, setBoth), true);

  membrane.revoke(grantA);
  assertEquals(membrane.check(handle, setBoth), false);
});

Deno.test("Membrane: adding grant C to handle does not change ANY-active behavior", () => {
  // The OR-on-activeness rule means adding more grants to a handle
  // does NOT make authorization stricter. As long as at least one
  // grant in the list is active, the call goes through. This is
  // intentional: it lets capabilities accumulate fresh grants over
  // a drone's lifetime (one per block invocation, per the
  // canonical onGrantRequest pattern) without each new grant
  // poisoning past authorizations.
  const membrane = freshMembrane();
  const handle = membrane.register({});
  const grantA = membrane.createGrant('A');
  const grantB = membrane.createGrant('B');
  const grantC = membrane.createGrant('C');

  grantA.add(handle);
  grantB.add(handle);

  const setAB = new Set([grantA.slot, grantB.slot]);
  assertEquals(membrane.check(handle, setAB), true);

  grantC.add(handle);

  // Adding C to the handle's list does NOT deny when A and B are
  // still active. C being inactive is fine; the OR rule passes
  // because A (and B) are active.
  assertEquals(membrane.check(handle, setAB), true);

  const setABC = new Set([grantA.slot, grantB.slot, grantC.slot]);
  assertEquals(membrane.check(handle, setABC), true);

  // No grant active → denied (regardless of how many grants are
  // in the handle's list).
  const setEmpty = new Set();
  assertEquals(membrane.check(handle, setEmpty), false);
});

// =============================================================================
// SAB-resident handle table behavior (slice 1)
// =============================================================================

Deno.test("Membrane: register() past handleTableCapacity throws MembraneOutOfSpaceError", () => {
  const membrane = freshMembrane({ handleTableCapacity: 4 });
  for (let i = 0; i < 4; i++) {
    membrane.register({ i });
  }
  assertThrows(
    () => membrane.register({}),
    MembraneOutOfSpaceError,
  );
});

Deno.test("Membrane: failed register() leaves table state intact", () => {
  const membrane = freshMembrane({ handleTableCapacity: 2 });
  const h0 = membrane.register({ a: 1 });
  const h1 = membrane.register({ a: 2 });
  try {
    membrane.register({});
    assert(false, 'should have thrown');
  } catch (e) {
    assert(e instanceof MembraneOutOfSpaceError);
  }
  // Existing handles still resolvable.
  assertEquals(membrane.lookup(h0), { a: 1 });
  assertEquals(membrane.lookup(h1), { a: 2 });
});

Deno.test("Membrane: handleForSlot returns wrapper with current version", () => {
  const membrane = freshMembrane();
  const h = membrane.register({ id: 7 });
  const reissued = membrane.handleForSlot(h.slot);
  assertEquals(reissued.slot, h.slot);
  assertEquals(reissued.version, h.version);
  assertEquals(membrane.lookup(reissued), { id: 7 });
});

Deno.test("Membrane: enumerateHandles returns live handles only", () => {
  const membrane = freshMembrane();
  const h0 = membrane.register({ a: 1 }, { kind: 'first' });
  const h1 = membrane.register({ a: 2 }, { kind: 'second' });
  const list = membrane.enumerateHandles();
  assertEquals(list.length, 2);
  assertEquals(list[0].handle.slot, h0.slot);
  assertEquals(list[0].metadata, { kind: 'first' });
  assertEquals(list[1].handle.slot, h1.slot);
  assertEquals(list[1].metadata, { kind: 'second' });
});

// =============================================================================
// Snapshot / Restore (slice 1)
// =============================================================================

Deno.test("Membrane: snapshot/restore preserves handle slots and versions", () => {
  const original = freshMembrane({ handleTableCapacity: 16 });
  const h0 = original.register({ name: 'a' }, { kind: 'A' });
  const h1 = original.register({ name: 'b' }, { kind: 'B' });

  const bytes = original.bytes();

  // Restore into a fresh membrane. The receiver's capacities must
  // match the source (or the layout-fit validator throws because
  // defaults make the receiver's layout bigger than the source's
  // buffer). `handleTableCapacity: 16` mirrors the original here;
  // a future iteration could have the receiver read capacities
  // from the snapshot header instead.
  const restored = freshMembrane({
    buffer: new ArrayBuffer(bytes.byteLength),
    handleTableCapacity: 16,
    fromBytes: false, // we'll loadBytes after construction
  });
  restored.loadBytes(bytes);

  // The restored membrane has live slots at the same positions as the original.
  // Implementations and metadata are JS-side and are not preserved; slots and
  // versions are. The host re-binds implementations through _bindImpl.
  const reissued0 = restored.handleForSlot(h0.slot);
  const reissued1 = restored.handleForSlot(h1.slot);
  assertEquals(reissued0.slot, h0.slot);
  assertEquals(reissued0.version, h0.version);
  assertEquals(reissued1.slot, h1.slot);
  assertEquals(reissued1.version, h1.version);
});

Deno.test("Membrane: enumerateHandles after restore returns the right slots", () => {
  const original = freshMembrane({ handleTableCapacity: 16 });
  original.register({ a: 1 });
  original.register({ a: 2 });
  original.register({ a: 3 });
  const bytes = original.bytes();

  const restored = freshMembrane({
    buffer: new ArrayBuffer(bytes.byteLength),
    handleTableCapacity: 16, // match source; see note in sibling test above.
  });
  restored.loadBytes(bytes);

  const list = restored.enumerateHandles();
  assertEquals(list.length, 3);
  assertEquals(list.map(e => e.handle.slot), [0, 1, 2]);
});

Deno.test("Membrane: loadBytes rejects size mismatch", () => {
  const m = freshMembrane({ handleTableCapacity: 16 });
  const bytes = new Uint8Array(10);
  assertThrows(
    () => m.loadBytes(bytes),
    Error,
    'Buffer size mismatch',
  );
});

// =============================================================================
// SAB-resident grants (slice 2)
// =============================================================================

Deno.test("Membrane: Grant wrapper has slot/version + isGrant() detects it", () => {
  const membrane = freshMembrane();
  const grant = membrane.createGrant('test');
  assert(isGrant(grant));
  assert(grant instanceof Grant);
  assertEquals(grant.slot, 0);
  assertEquals(grant.version, 1);
});

Deno.test("Membrane: revoke() leaves slot live but flips active to false", () => {
  const membrane = freshMembrane();
  const grant = membrane.createGrant('test');
  assertEquals(grant.active, true);
  membrane.revoke(grant);
  assertEquals(grant.active, false);
  // Wrapper still resolves — version unchanged, slot still live.
  // (Compaction in slice 3 frees the slot once nothing references it.)
  assertEquals(membrane._grantSlotIsLive(grant.slot), true);
});

Deno.test("Membrane: revoke() with stale Grant throws StaleGrantError", () => {
  const membrane = freshMembrane();
  const grant = membrane.createGrant('test');
  const stale = new Grant(membrane, grant.slot, grant.version + 99);
  assertThrows(() => membrane.revoke(stale), StaleGrantError);
});

Deno.test("Membrane: createGrant() past grantTableCapacity throws", () => {
  const membrane = freshMembrane({ grantTableCapacity: 3 });
  membrane.createGrant('a');
  membrane.createGrant('b');
  membrane.createGrant('c');
  assertThrows(() => membrane.createGrant('d'), MembraneOutOfSpaceError);
});

Deno.test("Membrane: grant identifier survives in the value arena", () => {
  const membrane = freshMembrane();
  const g0 = membrane.createGrant('fs');
  const g1 = membrane.createGrant({ kind: 'object-identifier', path: '/tmp' });
  const g2 = membrane.createGrant(['array', 'identifier']);
  assertEquals(g0.identifier, 'fs');
  assertEquals(g1.identifier, { kind: 'object-identifier', path: '/tmp' });
  assertEquals(g2.identifier, ['array', 'identifier']);
});

Deno.test("Membrane: grant metadata survives in the value arena", () => {
  const membrane = freshMembrane();
  const grant = membrane.createGrant('fs', { description: 'filesystem access' });
  assertEquals(grant.metadata, { description: 'filesystem access' });
});

Deno.test("Membrane: handle declarationName survives in the value arena", () => {
  const membrane = freshMembrane();
  const handle = membrane.register({});
  membrane.setDeclarationName(handle, 'MyApi');
  assertEquals(membrane.declarationName(handle), 'MyApi');
});

Deno.test("Membrane: grant.add() updates SAB inverse index — bidirectional", () => {
  const membrane = freshMembrane();
  const h0 = membrane.register({});
  const h1 = membrane.register({});
  const grant = membrane.createGrant('test');

  grant.add(h0);
  grant.add(h1);

  // Grant's handle list contains both slots.
  assertEquals(grant.handleSlots(), new Set([h0.slot, h1.slot]));

  // Each handle's grant list contains the grant slot.
  assertEquals(membrane._readHandleGrantSet(h0.slot), new Set([grant.slot]));
  assertEquals(membrane._readHandleGrantSet(h1.slot), new Set([grant.slot]));
});

Deno.test("Membrane: grant.add() is idempotent (no duplicates in lists)", () => {
  const membrane = freshMembrane();
  const handle = membrane.register({});
  const grant = membrane.createGrant('test');

  grant.add(handle);
  grant.add(handle);
  grant.add(handle);

  assertEquals(grant.handleSlots().size, 1);
  assertEquals(membrane._readHandleGrantSet(handle.slot).size, 1);
});

Deno.test("Membrane: enumerateGrants() returns all live grants with metadata", () => {
  const membrane = freshMembrane();
  const g0 = membrane.createGrant('first', { kind: 'A' });
  const g1 = membrane.createGrant('second', { kind: 'B' });
  const handle = membrane.register({});
  g0.add(handle);

  const list = membrane.enumerateGrants();
  assertEquals(list.length, 2);
  assertEquals(list[0].grant.slot, g0.slot);
  assertEquals(list[0].identifier, 'first');
  assertEquals(list[0].metadata, { kind: 'A' });
  assertEquals(list[0].active, true);
  assertEquals(list[0].handleSlots, [handle.slot]);
  assertEquals(list[1].grant.slot, g1.slot);
  assertEquals(list[1].identifier, 'second');
  assertEquals(list[1].handleSlots, []);
});

Deno.test("Membrane: enumerateGrants() reflects revoked state", () => {
  const membrane = freshMembrane();
  const grant = membrane.createGrant('test');
  membrane.revoke(grant);
  const list = membrane.enumerateGrants();
  assertEquals(list.length, 1);
  assertEquals(list[0].active, false);
});

// =============================================================================
// Root grants (slice 2: stored in SAB rootGrantsList)
// =============================================================================

Deno.test("Membrane: markAsRootGrant adds slot to rootGrantSlots()", () => {
  const membrane = freshMembrane();
  const grant = membrane.createGrant('root-test');
  membrane.markAsRootGrant(grant);
  const roots = membrane.rootGrantSlots();
  assert(roots.has(grant.slot));
  assertEquals(roots.size, 1);
});

Deno.test("Membrane: markAsRootGrant is idempotent", () => {
  const membrane = freshMembrane();
  const grant = membrane.createGrant('root-test');
  membrane.markAsRootGrant(grant);
  membrane.markAsRootGrant(grant);
  membrane.markAsRootGrant(grant);
  assertEquals(membrane.rootGrantSlots().size, 1);
});

Deno.test("Membrane: rootGrantsList past capacity throws MembraneOutOfSpaceError", () => {
  const membrane = freshMembrane({ rootGrantsListCapacity: 2, grantTableCapacity: 8 });
  membrane.markAsRootGrant(membrane.createGrant('a'));
  membrane.markAsRootGrant(membrane.createGrant('b'));
  assertThrows(
    () => membrane.markAsRootGrant(membrane.createGrant('c')),
    MembraneOutOfSpaceError,
  );
});

Deno.test("Membrane: enumerateGrants surfaces isRoot flag", () => {
  const membrane = freshMembrane();
  const root = membrane.createGrant('root');
  const normal = membrane.createGrant('normal');
  membrane.markAsRootGrant(root);
  const list = membrane.enumerateGrants();
  const rootEntry = list.find(e => e.grant.slot === root.slot);
  const normalEntry = list.find(e => e.grant.slot === normal.slot);
  assertEquals(rootEntry.isRoot, true);
  assertEquals(normalEntry.isRoot, false);
});

// =============================================================================
// Snapshot/restore: grants + inverse index + roots round-trip via SAB
// =============================================================================

Deno.test("Membrane: grant table survives snapshot/restore", () => {
  const original = freshMembrane();
  const h0 = original.register({});
  const h1 = original.register({});
  const g0 = original.createGrant('first', { kind: 'A' });
  const g1 = original.createGrant('second', { kind: 'B' });
  g0.add(h0);
  g0.add(h1);
  g1.add(h1);
  original.markAsRootGrant(g0);

  const bytes = original.bytes();
  const restored = freshMembrane({ buffer: new ArrayBuffer(bytes.byteLength) });
  restored.loadBytes(bytes);

  // Grants reconstructed at the same slots with same versions.
  const restoredG0 = restored.grantForSlot(g0.slot);
  const restoredG1 = restored.grantForSlot(g1.slot);
  assertEquals(restoredG0.slot, g0.slot);
  assertEquals(restoredG0.version, g0.version);
  assertEquals(restoredG1.slot, g1.slot);
  assertEquals(restoredG1.version, g1.version);

  // Identifiers + metadata round-trip through the value arena.
  assertEquals(restoredG0.identifier, 'first');
  assertEquals(restoredG0.metadata, { kind: 'A' });
  assertEquals(restoredG1.identifier, 'second');

  // Inverse index round-trips: each grant's handle set is intact.
  assertEquals(restoredG0.handleSlots(), new Set([h0.slot, h1.slot]));
  assertEquals(restoredG1.handleSlots(), new Set([h1.slot]));

  // Each handle's grant set is intact.
  assertEquals(restored._readHandleGrantSet(h0.slot), new Set([g0.slot]));
  assertEquals(restored._readHandleGrantSet(h1.slot), new Set([g0.slot, g1.slot]));

  // Root grants survive.
  assertEquals(restored.rootGrantSlots(), new Set([g0.slot]));
});

Deno.test("Membrane: revoked flag survives snapshot/restore", () => {
  const original = freshMembrane();
  const grant = original.createGrant('to-revoke');
  original.revoke(grant);

  const bytes = original.bytes();
  const restored = freshMembrane({ buffer: new ArrayBuffer(bytes.byteLength) });
  restored.loadBytes(bytes);

  assertEquals(restored._isGrantActive(grant.slot), false);
});

Deno.test("Membrane: handle declarationName survives snapshot/restore", () => {
  const original = freshMembrane();
  const handle = original.register({});
  original.setDeclarationName(handle, 'GlobalApi');

  const bytes = original.bytes();
  const restored = freshMembrane({ buffer: new ArrayBuffer(bytes.byteLength) });
  restored.loadBytes(bytes);

  assertEquals(restored.declarationNameBySlot(handle.slot), 'GlobalApi');
});

Deno.test("Membrane: checkBySlot uses SAB inverse index after restore", () => {
  const original = freshMembrane();
  const handle = original.register({});
  const grant = original.createGrant('test');
  grant.add(handle);

  const bytes = original.bytes();
  const restored = freshMembrane({ buffer: new ArrayBuffer(bytes.byteLength) });
  restored.loadBytes(bytes);

  const activeSet = new Set([grant.slot]);
  assertEquals(restored.checkBySlot(handle.slot, activeSet), true);
  assertEquals(restored.checkBySlot(handle.slot, new Set()), false);
});

// =============================================================================
// Layout-fit validation at construction
//
// When a host packs multiple membranes into a SAB, an undersized
// byteLength used to silently corrupt the layout: _initializeHeader
// would walk the region cursor past view.byteLength, write
// valid-looking offsets, then crash hundreds of operations later
// inside a DataView write. The validator added alongside these
// tests now fires at construction. The error message names the
// regions and the shortfall so the host can see which budget to bump.
// =============================================================================

Deno.test("Membrane: undersized host buffer throws MembraneOutOfSpaceError at construction", () => {
  // Defaults total ~373 KB (header 256 + handle 128K + grant 8K +
  // idListPool 64K + rootGrants 128 + valueArena 64K + closureHandle
  // 32K + linkedPromise 4K + mutationLog 32K). A 64 KB buffer is
  // way too small for the defaults.
  const tooSmall = new ArrayBuffer(64 * 1024);
  assertThrows(
    () => freshMembrane({ buffer: tooSmall }),
    MembraneOutOfSpaceError,
    'Membrane layout requires',
  );
});

Deno.test("Membrane: layout error reports each region size and the shortfall", () => {
  const tooSmall = new ArrayBuffer(64 * 1024);
  let captured = null;
  try { freshMembrane({ buffer: tooSmall }); }
  catch (e) { captured = e; }
  assert(captured instanceof MembraneOutOfSpaceError);
  // Must surface each region's byte size so the host knows where
  // to look. Skip the exact numbers — those drift as defaults
  // change; assert structurally.
  for (const region of [
    'header',
    'handleTable',
    'grantTable',
    'idListPool',
    'rootGrants',
    'valueArena',
    'closureHandleTable',
    'linkedPromiseTable',
    'mutationLog',
  ]) {
    assert(captured.message.includes(region),
      `error must name region "${region}"; got: ${captured.message}`);
  }
  assert(captured.message.includes('shortfall'),
    `error must report shortfall; got: ${captured.message}`);
});

Deno.test("Membrane: undersized packed-host buffer throws (mutationLog v4 case)", () => {
  // Regression for a 512 KB host membrane with a 256 KB id-list pool.
  // After the mutation-log region was added, the full layout required about
  // 533 KB and extended 12,672 bytes past the buffer. Construction must
  // refuse the layout instead of failing hundreds of operations later.
  const buffer = new ArrayBuffer(512 * 1024);
  assertThrows(
    () => freshMembrane({
      buffer,
      idListPoolSize: 256 * 1024,
      // every other region at sandscript defaults, including the
      // 1024-entry mutation log that overflows the budget.
    }),
    MembraneOutOfSpaceError,
    'Membrane layout requires',
  );
});

Deno.test("Membrane: exact-fit buffer constructs cleanly", () => {
  // Compute the exact required size for default regions; construct
  // with that. Must not throw. (Boundary case: required ===
  // byteLength.) Constants imported from the membrane so a future
  // format bump doesn't silently desync this test.
  const handleBytes      = 4096 * 32;
  const grantBytes       = 256 * 32;
  const idListBytes      = 65536;
  const rootGrantsBytes  = 32 * 4;
  const valueArenaBytes  = 65536;
  const closureBytes     = 1024 * 32;
  const linkedBytes      = 256 * LINKED_PROMISE_ENTRY_SIZE;
  const mutationBytes    = 1024 * 32;
  const capabilityStateBytes =
    DEFAULT_CAPABILITY_STATE_TABLE_CAPACITY * CAPABILITY_STATE_ENTRY_SIZE;
  const costLedgerBytes =
    DEFAULT_COST_LEDGER_CAPACITY * COST_LEDGER_ENTRY_SIZE;
  const objectHandleBytes =
    DEFAULT_OBJECT_HANDLE_TABLE_CAPACITY * OBJECT_HANDLE_ENTRY_SIZE;
  const total = MEMBRANE_HEADER_SIZE + handleBytes + grantBytes + idListBytes +
    rootGrantsBytes + valueArenaBytes + closureBytes + linkedBytes +
    mutationBytes + RUNTIME_STATE_CELL_BYTES + LEDGER_REGION_BYTES +
    capabilityStateBytes + costLedgerBytes + objectHandleBytes;
  const buffer = new ArrayBuffer(total);
  const membrane = freshMembrane({ buffer });
  // Constructed cleanly; basic operation works.
  const handle = membrane.register({ k: 'tiny' });
  assert(isHandle(handle));
});

Deno.test("Membrane: oversized buffer is fine (host packs other data)", () => {
  // The host may leave padding around the membrane for later resize.
  // The validator must allow `required <= byteLength`, not require equality.
  const buffer = new ArrayBuffer(2 * 1024 * 1024);
  const membrane = freshMembrane({ buffer, byteLength: 1024 * 1024 });
  const handle = membrane.register({ k: 'padded' });
  assert(isHandle(handle));
});

// =============================================================================
// Grant enumeration (operator surface: identifier-addressed revocation)
// =============================================================================

Deno.test("Membrane: listGrants() is empty on a fresh membrane", () => {
  const membrane = freshMembrane();
  assertEquals(membrane.listGrants(), []);
});

Deno.test("Membrane: listGrants() enumerates live grants slot-ascending with identifier and active", () => {
  const membrane = freshMembrane();
  membrane.createGrant('filesystem');
  const network = membrane.createGrant('network');

  membrane.revoke(network);

  assertEquals(membrane.listGrants(), [
    { slot: 0, identifier: 'filesystem', active: true, root: false },
    // Revoked slots stay live until compaction — listed, active: false.
    { slot: 1, identifier: 'network', active: false, root: false },
  ]);
});

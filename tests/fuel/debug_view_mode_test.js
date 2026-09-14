/**
 * Tests for createDebug's view-mode + the new module-level exports
 * createDebugFromBytes / dumpStateFromBytes.
 *
 * Background: a host that has a live Membrane or raw membrane bytes but no
 * full session needs a Debug instance bound to that remote drone slab. View
 * mode lets createDebug accept either a session or a
 * `{ membrane, ... }` view object.
 *
 * Run with: deno task test tests/fuel/debug_view_mode_test.js
 */

import {
  assertEquals, assert, assertThrows,
} from "https://deno.land/std@0.208.0/assert/mod.ts";
import { freshSession } from '../../src/host-owned-session.js';
import { createSession } from '../../src/fuel/session.js';
import {
  createDebug,
  createDebugFromBytes,
  dumpStateFromBytes,
} from '../../src/fuel/debug.js';
import { Membrane } from '../../src/membrane/index.js';

// =============================================================================
// Module-level exports
// =============================================================================

Deno.test('dumpStateFromBytes: module-level export works without a Debug instance', () => {
  const session = freshSession();
  session.airlock.membrane.tick(); // touch membrane so seq is set
  const membraneBytes = session.airlock.membrane.bytes();

  const dump = dumpStateFromBytes(membraneBytes);

  assert('tick' in dump, 'dump.tick present');
  assert('engine' in dump, 'dump.engine present');
  assert('membrane' in dump, 'dump.membrane present');
  assertEquals(dump.engine.forensic, true,
    'forensic flag set on byte-derived dumps');
  // Contexts section is empty (no live session).
  assertEquals(dump.contexts, []);
});

Deno.test('dumpStateFromBytes: heap bytes are optional', () => {
  const session = freshSession();
  const membraneBytes = session.airlock.membrane.bytes();
  const dump = dumpStateFromBytes(membraneBytes);
  assert('heap' in dump, 'heap section present');
  // Without heap bytes, the heap section may be empty/null but
  // the call shouldn't throw.
});

// =============================================================================
// createDebugFromBytes
// =============================================================================

Deno.test('createDebugFromBytes: returns a Debug instance bound to the bytes', () => {
  const session = freshSession();
  session.airlock.membrane.tick();
  const membraneBytes = session.airlock.membrane.bytes();

  const debug = createDebugFromBytes(membraneBytes);

  // Methods available on the view-mode Debug:
  assert(typeof debug.dumpState === 'function');
  assert(typeof debug.mutationLog === 'function');
  assert(typeof debug.mutationCounters === 'function');
  assert(typeof debug.tick === 'function');
  assert(typeof debug.findGrant === 'function');

  // tick reads from the bytes — frozen snapshot, not advancing.
  const tickA = debug.tick();
  const tickB = debug.tick();
  assertEquals(tickA, tickB);
});

Deno.test('createDebugFromBytes: dumpContexts returns [] in view mode', () => {
  const session = freshSession();
  const debug = createDebugFromBytes(session.airlock.membrane.bytes());
  assertEquals(debug.dumpContexts(), [],
    'no MemoryImage to flatten; dumpContexts returns []');
});

Deno.test('createDebugFromBytes: mutationCounters works against the bytes', () => {
  const session = freshSession();
  // Trigger a mutation: register a grant.
  session.airlock.membrane.createGrant('test-grant');
  const debug = createDebugFromBytes(session.airlock.membrane.bytes());
  const counters = debug.mutationCounters();
  assert(counters.grantCreate >= 1,
    `grantCreate counter visible: ${counters.grantCreate}`);
});

// =============================================================================
// createDebug accepts a view object
// =============================================================================

Deno.test('createDebug: accepts { membrane } view', () => {
  const session = freshSession();
  const liveMembrane = session.airlock.membrane;

  // Pass the live membrane directly — same instance the session uses.
  const debug = createDebug({ membrane: liveMembrane });

  // Reads against the same live membrane the session is using.
  // Mutations through the session are visible here.
  session.airlock.membrane.createGrant('view-mode-grant');
  const counters = debug.mutationCounters();
  assert(counters.grantCreate >= 1,
    `view debug sees live mutations: ${counters.grantCreate}`);
});

Deno.test('createDebug: view mode without session — dumpContexts is []', () => {
  const session = freshSession();
  const debug = createDebug({ membrane: session.airlock.membrane });
  // No session passed → no MemoryImage → dumpContexts is [].
  assertEquals(debug.dumpContexts(), []);
  // dumpState's contexts section likewise.
  const dump = debug.dumpState();
  assertEquals(dump.contexts, []);
});

Deno.test('createDebug: view mode with session — dumpContexts works', () => {
  const session = freshSession();
  // Pass both: same effective surface as the original
  // createDebug(session), but expressed via the view shape.
  const debug = createDebug({
    membrane: session.airlock.membrane,
    memoryImage: session.memoryImage,
    session,
  });
  // dumpContexts walks live contexts — exact same as a session-mode Debug.
  const ctx = debug.dumpContexts();
  assert(Array.isArray(ctx), 'dumpContexts returns an array in full-shape view');
});

Deno.test('createDebug: rejects bad input', () => {
  assertThrows(() => createDebug(null), TypeError);
  assertThrows(() => createDebug({}), TypeError);
  assertThrows(() => createDebug({ foo: 'bar' }), TypeError);
  // A view object without a membrane: rejected.
  assertThrows(() => createDebug({ memoryImage: {} }), TypeError);
});

// =============================================================================
// Live-membrane view mode + mutation watcher (Option C's key use case)
// =============================================================================

Deno.test('createDebug view mode: setMutationWatcher fires on the same membrane', () => {
  const session = freshSession();
  const debug = createDebug({ membrane: session.airlock.membrane });

  const events = [];
  // kindMask 0xFFFFFFFF — every kind.
  debug.setMutationWatcher(0xFFFFFFFF, (event) => events.push(event));

  // Trigger a mutation through the session.
  session.airlock.membrane.createGrant('watcher-grant');

  assert(events.length >= 1,
    `watcher fired at least once on live mutations: ${events.length}`);

  debug.clearMutationWatcher();
  const before = events.length;
  session.airlock.membrane.createGrant('another-grant');
  assertEquals(events.length, before,
    'clearMutationWatcher stops the watcher');
});

// =============================================================================
// Backward compatibility: createDebug(session) still works
// =============================================================================

Deno.test('createDebug: original session-only call works unchanged', () => {
  const session = freshSession();
  const debug = createDebug(session);
  // Exercise a few methods to confirm the session path is intact.
  assert(typeof debug.tick === 'function');
  assert(typeof debug.dumpState === 'function');
  assert(typeof debug.dumpContexts === 'function');
  const dump = debug.dumpState();
  assert('tick' in dump);
});

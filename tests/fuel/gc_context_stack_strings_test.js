/**
 * Context-state string ids across string compaction.
 *
 * The mark phase walks a suspended context's grant stack and completion
 * value (so their strings are RETAINED and relocate), but the update
 * phase must also FORWARD the ids stored in the context state itself —
 * otherwise the context resumes with stale ids into the vacated table tail.
 * Reads can then fault outside the string region, silently drop MessagePack
 * values, or trap during WAT concatenation.
 *
 * Two gaps pinned here:
 *
 *   1. updateGrantStackStringsForContext walked a stale local
 *      GRANT_ENTRY_SIZE = 24 over 32-byte entries (the pre-SCOPE_POINTER
 *      layout) — the same stale-stride bug fixed earlier in
 *      markGrantStackForContext, whose doc comment warns the stride MUST
 *      come from constants. Entry 0 forwarded correctly; every deeper
 *      grant identifier was read mid-entry and the real ids at +32, +64…
 *      went unforwarded. A suspended context under nested grants resumed
 *      with a stale identifier — the "requires a grant not in the
 *      current grant stack" family.
 *
 *   2. The completion value (CTX.COMPLETION_VALUE_STORAGE, live while a
 *      finally block runs with a pending return/throw) was marked but
 *      never forwarded: a context parked inside `try { return "s" }
 *      finally { <suspend> }` resumed and returned a stale id.
 *
 * Run with: deno task test tests/fuel/gc_context_stack_strings_test.js
 */

import { assert, assertEquals } from "https://deno.land/std@0.208.0/assert/mod.ts";
import { freshSession } from '../../src/host-owned-session.js';
import { parseAndSetup } from './test-helpers.js';
import {
  GRANT_ENTRY,
  TYPE,
  COMPLETION_RETURN,
  TRY_ENTRY,
} from '../../src/fuel/constants.js';

function setupSuspendingApi(session) {
  const { airlock } = session;
  const apiHandle = airlock.register({});
  airlock.setHandler(apiHandle, 'echo', ({ context }) => context.suspend(() => {}));
  airlock.declare('Api', apiHandle);
  const root = airlock.createRootGrant('app');
  root.add(apiHandle);
  airlock.onGrantRequest = (identifier) => {
    const grant = airlock.membrane.createGrant(identifier);
    return { approved: true, grant };
  };
}

function internGarbagePadding(session) {
  // Interned BEFORE the program parses, referenced by nothing — the
  // first collection reclaims them and every later intern relocates.
  for (let i = 0; i < 50; i++) {
    session.mem.internString(`garbage_padding_string_${i}_${'x'.repeat(40)}`);
  }
}

function readGrantIdentifierId(mem, slot, index) {
  const { identifierAddr } = mem.getGrantEntry(slot, index);
  const abs = mem.abs(identifierAddr);
  assertEquals(mem.view.getUint32(abs, true), TYPE.STRING,
    `grant entry ${index} identifier must be a string value`);
  return mem.view.getUint32(abs + 8, true);
}

Deno.test('grant-stack identifier ids are forwarded across string compaction at the real 32-byte stride', () => {
  const session = freshSession();
  setupSuspendingApi(session);
  internGarbagePadding(session);

  parseAndSetup(session, `
    grant "grant_identifier_alpha_prose" {
      grant "grant_identifier_beta_prose" {
        Api.echo()
      }
    }
  `);
  const r = session.run(0, 100000);
  assertEquals(r.status, 'suspended', 'context must park inside both grants');
  assertEquals(session.mem.getGrantDepth(0), 2, 'two nested grants on the stack');

  const betaBefore = readGrantIdentifierId(session.mem, 0, 1);
  assertEquals(session.mem.readString(betaBefore), 'grant_identifier_beta_prose');

  const stats = session.gc();
  assert(stats.stringsCollected > 0, 'setup must force string compaction');

  // The hash table was rebuilt, so interning the same text returns the
  // canonical (relocated) id without allocating a new entry.
  const canonicalBeta = session.mem.internString('grant_identifier_beta_prose');
  assert(canonicalBeta !== betaBefore,
    'beta identifier string must relocate in this setup');

  const alphaAfter = readGrantIdentifierId(session.mem, 0, 0);
  const betaAfter = readGrantIdentifierId(session.mem, 0, 1);

  // BOTH entries must carry forwarded ids — pre-fix, entry 1 kept the
  // stale pre-compaction id (the update walked 24-byte strides over
  // 32-byte entries and never touched it).
  assertEquals(session.mem.readString(alphaAfter), 'grant_identifier_alpha_prose');
  assertEquals(betaAfter, canonicalBeta,
    'entry 1 identifier id must be the canonical post-compaction id');
  assertEquals(session.mem.readString(betaAfter), 'grant_identifier_beta_prose');
});

Deno.test('completion value string id is forwarded across string compaction (return through suspended finally)', () => {
  const session = freshSession();
  setupSuspendingApi(session);
  internGarbagePadding(session);

  parseAndSetup(session, `
    function work() {
      try {
        return "completion_value_prose_that_relocates";
      } finally {
        Api.echo();
      }
    }
    work()
  `);
  const r = session.run(0, 100000);
  assertEquals(r.status, 'suspended', 'context must park inside the finally');

  // v11: the pending RETURN completion lives in the disarmed try entry
  // (the finally's holder), not in the context completion slot.
  assertEquals(session.mem.getTryDepth(0), 1, 'the finally holder entry is parked');
  assertEquals(session.mem.getTryEntry(0, 0).completionType, COMPLETION_RETURN,
    'the pending RETURN completion is stashed in the entry while the finally runs');
  const entryValueAddr = session.mem.getTryStackBase(0) + TRY_ENTRY.COMPLETION_VALUE;
  const idBefore = session.mem.view.getUint32(session.mem.abs(entryValueAddr) + 8, true);
  assertEquals(session.mem.readString(idBefore), 'completion_value_prose_that_relocates');

  const stats = session.gc();
  assert(stats.stringsCollected > 0, 'setup must force string compaction');

  const canonical = session.mem.internString('completion_value_prose_that_relocates');
  assert(canonical !== idBefore, 'completion string must relocate in this setup');

  // Direct entry check: the id must have been forwarded...
  const entryValueAddrAfter = session.mem.getTryStackBase(0) + TRY_ENTRY.COMPLETION_VALUE;
  const idAfter = session.mem.view.getUint32(session.mem.abs(entryValueAddrAfter) + 8, true);
  assertEquals(idAfter, canonical,
    'completion value id must be the canonical post-compaction id');
  assertEquals(session.mem.readString(idAfter), 'completion_value_prose_that_relocates');

  // ...and the end-to-end path agrees: resume the finally, the function
  // returns the original string.
  const { resolve } = session.airlock.pendingContexts.get(0);
  resolve(undefined);
  const resumed = session.run(0, 100000);
  assertEquals(resumed.status, 'done');
  assertEquals(session.result(0), 'completion_value_prose_that_relocates');
});

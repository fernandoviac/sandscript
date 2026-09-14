/**
 * Per-context request blocks (layout v8).
 *
 * The external request block lives INSIDE each context object
 * (CTX.REQUEST_BLOCK) — previously ONE global scratch region served
 * every context, so with N slots parked at external yields only the
 * LAST yielder's payload existed: the collector could neither mark nor
 * forward the other slots' staged args, and the gate load test rotted
 * at ~48 concurrent parks (verify mode named
 * `context[48].requestBase.arg[0]`).
 *
 * This test parks TWO contexts at external calls with distinct method
 * names and string args, runs a string-compacting collection, and
 * asserts each slot's request block still names ITS OWN call — plus a
 * clean context-state string audit over both parked blocks.
 *
 * Run with: deno task test tests/fuel/per_context_request_block_test.js
 */

import { assert, assertEquals } from "https://deno.land/std@0.208.0/assert/mod.ts";
import { freshSession } from '../../src/host-owned-session.js';
import { parseAndSetup } from './test-helpers.js';
import { auditStringReferences } from '../../src/fuel/string-audit.js';
import { EXIT_EXTERNAL_CALL } from '../../src/fuel/constants.js';

Deno.test('two contexts parked at external calls keep their own request blocks across gc', async () => {
  const session = freshSession();
  const { airlock } = session;
  const apiHandle = airlock.register({});
  airlock.setHandler(apiHandle, 'alphaSuspendingMethod',
    ({ context }) => context.suspend(() => {}));
  airlock.setHandler(apiHandle, 'betaSuspendingMethod',
    ({ context }) => context.suspend(() => {}));
  airlock.declare('Api', apiHandle);
  const root = airlock.createRootGrant('app');
  root.add(apiHandle);

  for (let i = 0; i < 50; i++) {
    session.mem.internString(`garbage_padding_string_${i}_${'x'.repeat(40)}`);
  }

  parseAndSetup(session, `
    let runAlpha = async () => { Api.alphaSuspendingMethod("argument_for_alpha_prose") }
    let runBeta = async () => { Api.betaSuspendingMethod("argument_for_beta_prose") }
    runAlpha()
    runBeta()
  `);

  // Drive: the two async calls spawn contexts which park at their
  // external calls (single-owner rotation).
  const queue = [{
    slot: 0,
    generation: session.mem.getContextGeneration(0),
  }];
  const parked = new Set();
  while (queue.length > 0 && parked.size < 2) {
    const contextIdentity = queue.shift();
    const r = await session.run(contextIdentity, 100000);
    if (r.status === 'async_call') {
      queue.push(r.asyncContext, contextIdentity);
      continue;
    }
    if (r.status === 'suspended') {
      parked.add(contextIdentity.slot);
      continue;
    }
    if (r.status === 'await' || r.status === 'promise_method') {
      queue.push(contextIdentity);
      continue;
    }
  }
  assertEquals(parked.size, 2, 'two contexts parked at their suspending calls');
  const slots = [...parked];
  for (const s of slots) {
    assertEquals(session.mem.getExitCondition(s), EXIT_EXTERNAL_CALL,
      `slot ${s} parked at EXIT_EXTERNAL_CALL`);
  }

  // Each parked slot's request block names ITS OWN method — with the
  // old global scratch, both reads returned the LAST yielder's block.
  const methodNames = slots.map((s) =>
    session.mem.readString(session.mem.getExternalRequest(s).methodOffset));
  assertEquals(new Set(methodNames).size, 2,
    `each slot keeps its own methodOffset (got ${methodNames.join(', ')})`);

  const stats = session.gc();
  assert(stats.stringsCollected > 0, 'setup must force string compaction');

  // Post-compaction: both blocks still coherent — same method names,
  // and the context-state audit (which covers requestBase.methodOffset
  // and the staged args PER SLOT) is clean.
  const after = slots.map((s) =>
    session.mem.readString(session.mem.getExternalRequest(s).methodOffset));
  assertEquals(new Set(after).size, 2);
  assertEquals(after.sort(), methodNames.sort());

  const report = auditStringReferences(session.mem);
  assertEquals(report.findings, [],
    'both parked request blocks audit clean after compaction');
  assert(report.checkedContexts >= 3, 'the audit walked all allocated contexts');
});

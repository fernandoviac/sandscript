/**
 * Queued MsgpackRef arguments must remain valid across collection.
 *
 * MsgpackRef args passed to scheduleClosureCall wait in the runtime's
 * closure queue before setupCallbackContext marshals them. Their blobs
 * (allocateMsgpackBytes) have NO SS-heap reference in that window, so a
 * heap gc used to collect them (and never forward the JS-held raw
 * parentDataPointer) — the fire then marshaled a dangling MSGPACK_REF
 * into its callback scope, and the NEXT collection's mark walk detonated
 * on it (abs() OOB, image poisoned).
 *
 * Fixed by airlock.hooks.inFlightMsgpackRefs: the runtime surfaces queued
 * refs, session.gc() unions their blobs into the collect() external roots
 * and rewrites each ref's parentDataPointer from the returned forwarding.
 *
 * This test is DETERMINISTIC: scheduleClosureCall enqueues synchronously
 * (the drainer runs async), so calling session.gc() right after
 * scheduling guarantees the refs are still queued when the collection
 * runs. Pre-fix it fails at that gc (verify audits) or on the fire
 * (dangling ref). All collector verify-mode audits are armed.
 */

import { assertEquals } from "https://deno.land/std@0.208.0/assert/mod.ts";
import { RuntimeBuilder } from '../../src/runtime/test-harness.js';
import { MsgpackRef } from '../../src/fuel/airlock.js';

function tick(ms = 0) { return new Promise(r => setTimeout(r, ms)); }
async function waitFor(condition, { timeout = 15000, label = 'condition' } = {}) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    if (condition()) return;
    await tick(2);
  }
  throw new Error(`waitFor timed out: ${label}`);
}

// Minimal msgpack encoder: fixmap/fixstr/fixint.
function enc(value) {
  if (typeof value === 'number') {
    if (Number.isInteger(value) && value >= 0 && value <= 127) return [value];
    throw new Error('small ints only');
  }
  if (typeof value === 'string') {
    const b = new TextEncoder().encode(value);
    if (b.length > 31) throw new Error('fixstr only');
    return [0xa0 | b.length, ...b];
  }
  const entries = Object.entries(value);
  if (entries.length > 15) throw new Error('fixmap only');
  const out = [0x80 | entries.length];
  for (const [k, v] of entries) { out.push(...enc(k)); out.push(...enc(v)); }
  return out;
}

Deno.test('queued MsgpackRef args survive a gc before the drainer marshals them', async () => {
  const captured = { closures: [], sums: [] };
  const errors = [];

  const { runtime, session, channels } = new RuntimeBuilder()
    .capability({
      name: 'host',
      setup: (al) => {
        const rootGrant = al.createRootGrant();
        const handle = al.register({});
        rootGrant.add(handle);
        al.setHandler(handle, 'register', ({ args }) => {
          captured.closures.push(args[0]);
          return null;
        });
        al.setHandler(handle, 'note', ({ args }) => {
          captured.sums.push(args[0]);
          return null;
        });
        al.declare('Host', handle);
      },
    })
    .onInboundMessage(() => { /* unused — fires are scheduled directly */ })
    .onHandlerError((e) => { errors.push(e); })
    .build();
  session.collector.verifyAfterCollect = true;

  await runtime.start();
  session.parse(`
    Host.register((rec) => {
      Host.note(rec.seq + ":" + rec.tag)
    })
  `);
  await runtime.run(0);

  const FIRES = 12;
  const airlock = session.airlock;
  for (let n = 0; n < FIRES; n++) {
    const bytes = new Uint8Array(enc({ seq: n, tag: 'record-' + n }));
    const ref = new MsgpackRef(airlock.allocateMsgpackBytes(bytes));
    runtime.scheduleClosureCall(captured.closures[0], [ref], {});
  }

  // The refs are all still queued (the drainer runs asynchronously).
  // This collection used to reap every blob and leave the raw
  // parentDataPointers dangling.
  session.gc();
  // A second collection moves the (now-rooted) blobs again — the
  // forwarding rewrite must keep the refs current across repeats.
  session.gc();

  await waitFor(() => captured.sums.length === FIRES || errors.length > 0,
    { label: `fires complete (got ${captured.sums.length}, errors ${errors.length})` });

  await runtime.terminate();
  channels.close();

  if (errors.length > 0) {
    throw new Error(`handler errors: ${errors.map(e => e?.message ?? String(e)).slice(0, 3).join(' | ')}`);
  }
  assertEquals(captured.sums.length, FIRES);
  for (let n = 0; n < FIRES; n++) {
    assertEquals(captured.sums[n], `${n}:record-${n}`);
  }
});

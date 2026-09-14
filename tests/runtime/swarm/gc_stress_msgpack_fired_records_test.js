/**
 * GC stress over fired MsgpackRef records that once exposed a poisoned
 * collection image.
 *
 * The triggering shape fires replay records as MsgpackRef arguments: nested
 * containers become lazy heap refs while per-visitor folds shift entries,
 * concatenate multi-byte UTF-8, stringify and parse request bodies, merge
 * objects, marshal Uint8Array digests back to the host, suspend mid-fire, and
 * arrive in bursts on a deliberately tight heap.
 *
 * Root cause found with this harness: MsgpackRef args waiting in the
 * runtime's closure queue had NO SS-heap reference — a gc in the queue
 * window collected their blobs and left the JS-held raw
 * parentDataPointer dangling; the fire marshaled a poisoned
 * MSGPACK_REF into the callback scope and a LATER collection's mark
 * walk detonated (abs() OOB). Fixed via
 * airlock.hooks.inFlightMsgpackRefs + session.gc() external-root
 * forwarding. The same hunt surfaced the promise-method safepoint
 * pointer-convention bugs and the Promise.all aggregator stash (see
 * safepoint_gc_audit_test.js's value-coverage tests).
 *
 * Runs with EVERY collector verify-mode audit armed: pre/post
 * heap-walk, pre/post context-roots (scope-binding value checks), and
 * the setMark header-set guard — a regression fails at the collection
 * that creates it, attributably, instead of poisoning the image
 * collections later.
 */

import { assertEquals } from "https://deno.land/std@0.208.0/assert/mod.ts";
import { RuntimeBuilder } from '../../../src/runtime/test-harness.js';
import { MsgpackRef } from '../../../src/fuel/airlock.js';

const u8 = (s) => new TextEncoder().encode(s);
function tick(ms = 0) { return new Promise(r => setTimeout(r, ms)); }
async function waitFor(condition, { timeout = 30000, label = 'condition' } = {}) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    if (condition()) return;
    await tick(2);
  }
  throw new Error(`waitFor timed out: ${label}`);
}

// Minimal msgpack encoder (fixmap/fixarray/fixstr/str8/fixint).
function enc(value) {
  if (typeof value === 'number') {
    if (Number.isInteger(value) && value >= 0 && value <= 127) return [value];
    throw new Error('small ints only');
  }
  if (typeof value === 'string') {
    const b = new TextEncoder().encode(value);
    if (b.length <= 31) return [0xa0 | b.length, ...b];
    if (b.length <= 255) return [0xd9, b.length, ...b];
    throw new Error('str too long');
  }
  if (Array.isArray(value)) {
    if (value.length > 15) throw new Error('fixarray only');
    const out = [0x90 | value.length];
    for (const v of value) out.push(...enc(v));
    return out;
  }
  const entries = Object.entries(value);
  if (entries.length > 15) throw new Error('fixmap only');
  const out = [0x80 | entries.length];
  for (const [k, v] of entries) { out.push(...enc(k)); out.push(...enc(v)); }
  return out;
}

const SOURCE = `
  let threads = {}
  Host.register(async (rec) => {
    let visitor = rec.visitor
    let t = threads[visitor]
    if (t === undefined) { t = []; threads[visitor] = t }
    t.push({ role: rec.role, content: rec.content + " — mode décodé ✨" })
    if (t.length > 8) t.shift()
    let sys = ""
    let i = 0
    while (i < 4) { sys = sys + "Tu es Uranie, muse de l'astronomie — un mode code étoilé. "; i = i + 1 }
    let body = JSON.stringify({ model: "claude", system: sys, messages: t,
      tools: [{ name: "decode", mode: "ode ode ode" }] })
    let id = await Host.tick(rec.seq)
    let parsed = JSON.parse(body)
    let merged = Object.assign({}, parsed, { id: id, tags: rec.meta.tags })
    let digest = Host.digest(body)
    let uuid = Host.uuid()
    let reply = { content: [{ type: "text",
      text: "ok " + uuid + " d" + digest.length + " over " + merged.messages.length + " " + rec.meta.inner[0].k }] }
    let j = 0
    while (j < reply.content.length) {
      if (reply.content[j].type === "text") {
        t.push({ role: "assistant", content: reply.content[j].text })
        if (t.length > 8) t.shift()
      }
      j = j + 1
    }
    Host.note(rec.seq)
  })
`;

async function runChurn({ heapSize, fires, burst, label }) {
  const captured = { closures: [], notes: [] };
  const errors = [];
  const airlockRef = {};
  let runtimeRef;

  const { runtime, session, host, channels } = new RuntimeBuilder()
    .sessionOptions({ heapSize })
    .capability({
      name: 'host',
      setup: (al) => {
        airlockRef.al = al;
        const rootGrant = al.createRootGrant();
        const handle = al.register({});
        rootGrant.add(handle);
        al.setHandler(handle, 'register', ({ args }) => {
          captured.closures.push(args[0]);
          return null;
        });
        al.setHandler(handle, 'tick', ({ args, context }) =>
          context.suspend((resolve) => { setTimeout(() => resolve(args[0] * 2), 1); }));
        al.setHandler(handle, 'digest', ({ args }) => {
          const out = new Uint8Array(32);
          const s = String(args[0] ?? '');
          for (let i = 0; i < 32; i++) out[i] = (s.charCodeAt(i % Math.max(1, s.length)) + i) & 0xff;
          return out;
        });
        al.setHandler(handle, 'uuid', () => crypto.randomUUID());
        al.setHandler(handle, 'note', ({ args }) => {
          captured.notes.push(args[0]);
          return null;
        });
        al.declare('Host', handle);
      },
    })
    .onInboundMessage((payload) => {
      const n = Number(new TextDecoder().decode(payload));
      const record = {
        seq: n % 128,
        visitor: 'visitor-' + (n % 5),
        role: 'user',
        content: 'turn ' + n + ' — un mode décodé, encode & decode ',
        meta: { tags: ['a', 'ode ', 'b'], inner: [{ k: 'nested-' + (n % 7) }] },
      };
      const bytes = new Uint8Array(enc(record));
      const ref = new MsgpackRef(airlockRef.al.allocateMsgpackBytes(bytes));
      runtimeRef.scheduleClosureCall(captured.closures[0], [ref], {});
    })
    .onHandlerError((e) => { errors.push(e); })
    .build();
  runtimeRef = runtime;
  session.collector.verifyAfterCollect = true;

  await runtime.start();
  session.parse(SOURCE);
  await runtime.run(0);

  for (let n = 0; n < fires; n++) {
    await host.send(u8(String(n)));
    if (n % burst === burst - 1) await tick(1);
  }
  await waitFor(() => captured.notes.length === fires || errors.length > 0,
    { label: `${label}: fires complete (got ${captured.notes.length}, errors ${errors.length})` });

  await runtime.terminate();
  channels.close();

  if (errors.length > 0) {
    throw new Error(`${label}: handler errors surfaced: ` +
      errors.map(e => e?.message ?? String(e)).slice(0, 3).join(' | '));
  }
  assertEquals(captured.notes.length, fires, `${label}: every fire completed`);
}

Deno.test('gc stress: msgpack-ref fired records, tight heap, boot burst', async () => {
  await runChurn({ heapSize: 128 * 1024, fires: 150, burst: 8, label: 'ref-burst-128K' });
});

Deno.test('gc stress: msgpack-ref fired records, wider bursts', async () => {
  await runChurn({ heapSize: 192 * 1024, fires: 150, burst: 16, label: 'ref-burst-192K' });
});

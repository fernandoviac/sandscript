/**
 * GC stress over fired closures with awaits and string/object churn. The
 * former failure was an intermittent `collect: collection failed mid-phase —
 * abs(...): out of bounds` from Collector.abs during moveObjects.
 *
 * The failing workload's shape, distilled: an async fired closure (the
 * inbound CALLBACK path — box subscriptions, connection.message) that
 * pushes {role, content} object turns into per-key arrays (bounded,
 * shifting), concatenates sizeable strings, SUSPENDS mid-fire on a host
 * call, and finishes on resume — many fires in flight at once, on a
 * SMALL heap so pressure-GC runs constantly, including while fires sit
 * suspended at their awaits.
 *
 * Run with SS_VERIFY_COLLECTIONS=1 to arm the post-collection audit:
 * the verify pass names the FIRST dangling reference instead of letting
 * the wreckage explode collections later.
 */

import { assertEquals } from "https://deno.land/std@0.208.0/assert/mod.ts";
import { RuntimeBuilder } from '../../../src/runtime/test-harness.js';

const u8 = (s) => new TextEncoder().encode(s);
function tick(ms = 0) { return new Promise(r => setTimeout(r, ms)); }
async function waitFor(condition, { timeout = 20000, label = 'condition' } = {}) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    if (condition()) return;
    await tick(2);
  }
  throw new Error(`waitFor timed out: ${label}`);
}

function hostCapability(captured) {
  return {
    name: 'host',
    setup: (al) => {
      const rootGrant = al.createRootGrant();
      const handle = al.register({});
      rootGrant.add(handle);
      al.setHandler(handle, 'register', ({ args }) => {
        captured.closures.push(args[0]);
        return null;
      });
      // A SUSPENDING call — the fire parks here while other fires run
      // (and while pressure-GC moves the heap under it).
      al.setHandler(handle, 'tick', ({ args, context }) =>
        context.suspend((resolve) => { setTimeout(() => resolve(args[0] * 10), 1); }));
      al.setHandler(handle, 'note', ({ args }) => {
        captured.notes.push(args[0]);
        return null;
      });
      al.declare('Host', handle);
    },
  };
}

async function runChurn({ heapSize, fires, label }) {
  const captured = { closures: [], notes: [] };
  const errors = [];
  let runtimeRef;

  const { runtime, session, host, channels } = new RuntimeBuilder()
    .sessionOptions({ heapSize })
    .capability(hostCapability(captured))
    .onInboundMessage((payload) => {
      const n = Number(new TextDecoder().decode(payload));
      runtimeRef.scheduleClosureCall(captured.closures[0], [n], {});
    })
    .onHandlerError((e) => { errors.push(e); })
    .build();
  runtimeRef = runtime;
  await runtime.start();

  // The spirit's shape: per-visitor threads of {role, content} objects,
  // bounded with shift; heavy concatenation; a suspend mid-fire; more
  // churn on resume.
  session.parse(`
    let threads = {}
    let threadOf = (k) => {
      let t = threads[k]
      if (t === undefined) { t = []; threads[k] = t }
      return t
    }
    let push = (k, role, text) => {
      let t = threadOf(k)
      t.push({ role: role, content: "" + text })
      if (t.length > 24) t.shift()
    }
    let copy = (m) => {
      let out = []
      let i = 0
      while (i < m.length) { out.push(m[i]); i = i + 1 }
      return out
    }
    let pad = ""
    let i = 0
    while (i < 6) { pad = pad + "the quick brown fox jumps over the lazy dog and runs away — "; i = i + 1 }
    Host.register(async (n) => {
      let visitor = "visitor-" + (n % 7)
      push(visitor, "user", pad + " message " + n)
      let mid = await Host.tick(n)
      let msgs = copy(threadOf(visitor))
      let assembled = ""
      let j = 0
      while (j < msgs.length) { assembled = assembled + msgs[j].role + ":" + msgs[j].content.length + " "; j = j + 1 }
      push(visitor, "assistant", "reply " + mid + " over " + assembled + pad)
      Host.note(n)
    })
  `);
  await runtime.run(0);

  // Fire in overlapping bursts: several fires suspended at Host.tick at
  // any moment while new fires allocate — pressure-GC lands in between.
  for (let n = 0; n < fires; n++) {
    await host.send(u8(String(n)));
    if (n % 5 === 4) await tick(1);
  }

  await waitFor(() => captured.notes.length === fires || errors.length > 0,
    { label: `${label}: all fires complete (got ${captured.notes.length})` });

  await runtime.terminate();
  channels.close();

  if (errors.length > 0) {
    throw new Error(`${label}: handler errors surfaced: ${errors.map(e => e?.message ?? String(e)).slice(0, 3).join(' | ')}`);
  }
  assertEquals(captured.notes.length, fires, `${label}: every fire completed`);
}

Deno.test("gc stress: fired closures with awaits + churn on a small heap survive collections", async () => {
  await runChurn({ heapSize: 128 * 1024, fires: 160, label: 'tight-heap' });
});

Deno.test("gc stress: heavier churn, tighter heap", async () => {
  await runChurn({ heapSize: 96 * 1024, fires: 240, label: 'tighter-heap' });
});

// This workload adds JSON.stringify/parse of nested trees and a burst at boot.
// Replay delivers many fires without a pause immediately after a large source
// parse while earlier fires remain suspended.
//
// JSON.stringify's entry pressure pre-check used to demand roughly 530 KB of
// heap headroom on every call regardless of input size, falsely reporting OOM
// for a 200-byte stringify with more than 90% of the heap free whenever the
// code/AST region sat high. The guard is now proportional: the entry check
// covers only initial buffers, and each growth step or tree allocation is
// checked at its own site and yields EXIT_MEMORY_PRESSURE for a post-GC retry.
Deno.test("gc stress: JSON tree churn and boot burst", async () => {
  const captured = { closures: [], notes: [] };
  const errors = [];
  let runtimeRef;

  const { runtime, session, host, channels } = new RuntimeBuilder()
    .sessionOptions({ heapSize: 256 * 1024, scratchSize: 256 * 1024 })
    .capability(hostCapability(captured))
    .onInboundMessage((payload) => {
      const n = Number(new TextDecoder().decode(payload));
      runtimeRef.scheduleClosureCall(captured.closures[0], [n], {});
    })
    .onHandlerError((e) => { errors.push(e); })
    .build();
  runtimeRef = runtime;
  await runtime.start();

  session.parse(`
    let threads = {}
    let threadOf = (k) => {
      let t = threads[k]
      if (t === undefined) { t = []; threads[k] = t }
      return t
    }
    let pad = ""
    let i = 0
    while (i < 3) { pad = pad + "You are an astronomy assistant receiving a repeated host message. "; i = i + 1 }
    Host.register(async (n) => {
      let visitor = "visitor-" + (n % 5)
      let t = threadOf(visitor)
      t.push({ role: "user", content: pad + " turn " + n })
      if (t.length > 8) t.shift()
      // The model-call body: stringify the whole thread with the system
      // prompt, then parse a nested reply — big transient trees.
      let body = JSON.stringify({ model: "claude-haiku", max_tokens: 400, system: pad, messages: t })
      let mid = await Host.tick(n)
      let parsed = JSON.parse(body)
      let reply = { content: [{ type: "text", text: "reply " + mid + " over " + parsed.messages.length + " " + pad }] }
      let j = 0
      while (j < reply.content.length) {
        if (reply.content[j].type === "text") {
          t.push({ role: "assistant", content: reply.content[j].text })
          if (t.length > 8) t.shift()
        }
        j = j + 1
      }
      Host.note(n)
    })
  `);
  await runtime.run(0);

  // BOOT BURST: fires delivered in tight back-to-back groups (a fromSeq-0
  // replay), a breath between groups so suspended fires drain — enough
  // concurrency to land pressure-GC mid-flight without a genuine
  // all-at-once capacity wall (that wall is a real OOM, a different test).
  const fires = 120;
  for (let n = 0; n < fires; n++) {
    await host.send(u8(String(n)));
    if (n % 8 === 7) await tick(1);
  }

  await waitFor(() => captured.notes.length === fires || errors.length > 0,
    { label: `boot-burst: all fires complete (got ${captured.notes.length})` });

  await runtime.terminate();
  channels.close();

  if (errors.length > 0) {
    throw new Error(`boot-burst: handler errors surfaced: ${errors.map(e => e?.message ?? String(e)).slice(0, 3).join(' | ')}`);
  }
  assertEquals(captured.notes.length, fires, 'boot-burst: every fire completed');
});

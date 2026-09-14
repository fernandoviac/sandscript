/**
 * Tests for the test harness itself — paired channels and
 * the RuntimeBuilder. These run before the end-to-end test
 * so a harness bug doesn't masquerade as a runtime bug.
 *
 * Run with: deno task test tests/runtime/test_harness_test.js
 */

import { assertEquals, assert, assertRejects } from "https://deno.land/std@0.208.0/assert/mod.ts";
import { createPairedChannels, RuntimeBuilder } from '../../src/runtime/test-harness.js';
import { collectMessages } from './host-helpers.js';

const u8 = (s) => new TextEncoder().encode(s);
const utf = (b) => new TextDecoder().decode(b);

// =============================================================================
// createPairedChannels
// =============================================================================

Deno.test("paired channels: a.send → b's subscriber", async () => {
  const { a, b } = createPairedChannels();
  const sink = collectMessages(b);
  await a.send(u8('hello'));
  const got = await sink.nextMessage();
  assertEquals(utf(got.payload), 'hello');
  assertEquals(got.sequenceNumber, 1n);
  sink.unsubscribe();
});

Deno.test("paired channels: b.send → a's subscriber", async () => {
  const { a, b } = createPairedChannels();
  const sink = collectMessages(a);
  await b.send(u8('world'));
  const got = await sink.nextMessage();
  assertEquals(utf(got.payload), 'world');
  sink.unsubscribe();
});

Deno.test("paired channels: bidirectional with separate sequence counters", async () => {
  const { a, b } = createPairedChannels();
  const aSink = collectMessages(a);
  const bSink = collectMessages(b);
  await a.send(u8('a1'));
  await a.send(u8('a2'));
  await b.send(u8('b1'));
  assertEquals((await bSink.nextMessage()).sequenceNumber, 1n);
  assertEquals((await bSink.nextMessage()).sequenceNumber, 2n);
  assertEquals((await aSink.nextMessage()).sequenceNumber, 1n);
  aSink.unsubscribe();
  bSink.unsubscribe();
});

Deno.test("paired channels: nextMessage parks until send arrives", async () => {
  const { a, b } = createPairedChannels();
  const sink = collectMessages(b);
  const promise = sink.nextMessage();
  // a hasn't sent anything — promise must be pending.
  let resolved = false;
  promise.then(() => { resolved = true; });
  await new Promise(r => setTimeout(r, 5));
  assert(!resolved, 'nextMessage should not resolve before send');
  await a.send(u8('late'));
  const got = await promise;
  assertEquals(utf(got.payload), 'late');
  sink.unsubscribe();
});

Deno.test("paired channels: messages buffer until a subscriber registers", async () => {
  const { a, b } = createPairedChannels();
  // Send first, subscribe later. The harness's enqueue path
  // pushes to the queue when no subscriber is present; the
  // onMessage call drains the queue synchronously.
  await a.send(u8('first'));
  await a.send(u8('second'));
  const sink = collectMessages(b);
  const r1 = await sink.nextMessage();
  const r2 = await sink.nextMessage();
  assertEquals(utf(r1.payload), 'first');
  assertEquals(utf(r2.payload), 'second');
  sink.unsubscribe();
});

Deno.test("paired channels: trySend always succeeds when open", async () => {
  const { a, b } = createPairedChannels();
  const sink = collectMessages(b);
  assertEquals(a.trySend(u8('quick')), true);
  assertEquals(utf((await sink.nextMessage()).payload), 'quick');
  sink.unsubscribe();
});

Deno.test("paired channels: send copies bytes (sender may reuse buffer)", async () => {
  const { a, b } = createPairedChannels();
  const sink = collectMessages(b);
  const buf = u8('original');
  await a.send(buf);
  // Mutate sender's buffer; received bytes must be unchanged.
  buf[0] = 'X'.charCodeAt(0);
  const got = await sink.nextMessage();
  assertEquals(utf(got.payload), 'original');
  sink.unsubscribe();
});

Deno.test("paired channels: close prevents further sends", async () => {
  const { a, close } = createPairedChannels();
  close();
  await assertRejects(() => a.send(u8('x')), Error, 'closed');
  assertEquals(a.trySend(u8('x')), false);
});

Deno.test("paired channels: duplicate onMessage throws", () => {
  const { a } = createPairedChannels();
  a.onMessage(() => {});
  let threw = false;
  try { a.onMessage(() => {}); }
  catch (e) {
    threw = true;
    assert(e.message.includes('subscriber'));
  }
  assert(threw);
});

// =============================================================================
// RuntimeBuilder — minimal smoke test (deeper coverage in end-to-end suite)
// =============================================================================

Deno.test("RuntimeBuilder: builds a runtime with the requested capabilities and channels", () => {
  let setupCalled = false;
  const { runtime, host, session } = new RuntimeBuilder()
    .capability({
      name: 'noop',
      setup: () => { setupCalled = true; },
    })
    .onInboundMessage(() => {})
    .build();
  assert(runtime);
  assert(host);
  assert(session);
  assert(session.airlock);
  // Setup is not called until start() — Builder only constructs.
  assert(!setupCalled);
});

Deno.test("RuntimeBuilder: hostService and subsystem maps land where capabilities can resolve them", async () => {
  let observed = null;
  const { runtime, host, channels } = new RuntimeBuilder()
    .hostService('clock', () => 42)
    .subsystem('cache', { get: () => 'cached' })
    .capability({
      name: 'reads',
      needs: { clock: 'host-service', cache: 'subsystem' },
      setup: (airlock, ctx) => {
        observed = { clock: ctx.clock(), cache: ctx.cache.get() };
      },
    })
    .onInboundMessage(() => {})
    .build();
  await runtime.start();
  assertEquals(observed, { clock: 42, cache: 'cached' });
  await runtime.terminate();
  channels.close();
});

/**
 * Intrinsic STATE-cell GC regression.
 *
 * After the first pressure collection, fresh request slots used to fail in
 * `drainStreamToString(...)` with `TypeError: Not a function`. Although
 * handle-method dispatch state was initially suspect, the failing callee was
 * `decoder.decode` on a freshly constructed TextDecoder.
 *
 * Root cause: `Collector.markIntrinsics` / `updateIntrinsics` omitted
 * three heap-pointer STATE cells:
 *
 *  - TEXT_ENCODER_PROTOTYPE / TEXT_DECODER_PROTOTYPE — the prototype
 *    objects survive transitively (the global constructor objects
 *    hold them as `.prototype`) but RELOCATE during heap compaction;
 *    the WAT constructors keep reading the stale STATE pointer, so
 *    every post-GC instance gets a garbage prototype and
 *    `.encode`/`.decode` resolve to undefined.
 *
 *  - STRING_PROTOTYPE — the STATE cell is the object's ONLY root, so
 *    the first compaction collected it outright and primitive-string
 *    symbol dispatch (string for..of) walked a dead object.
 *
 * These tests force a heap compaction with live garbage and pin that
 * the three intrinsics keep working afterwards. They FAIL before the
 * fix with `Uncaught Not a function (received undefined)`.
 */

import { assertEquals, assert } from "https://deno.land/std@0.208.0/assert/mod.ts";
import { freshSession } from '../../src/host-owned-session.js';
import { parseAndRun } from './test-helpers.js';
import { RuntimeBuilder } from '../../src/runtime/test-harness.js';

/** Churn the heap/string table so compaction has something to move. */
function churn(session) {
  parseAndRun(session, `
    let junk = "";
    let junkIndex = 0;
    while (junkIndex < 200) {
      junk = junk + "abcdefgh";
      junkIndex = junkIndex + 1;
    }
    junk = "";
  `, 0, 1000000);
}

Deno.test('TextDecoder/TextEncoder survive heap compaction', () => {
  const session = freshSession();

  churn(session);
  parseAndRun(session, `
    let before = new TextDecoder().decode(new TextEncoder().encode("hi"))
  `, 0, 1000000);
  assertEquals(session.get(0, 'before'), 'hi');

  session.gc();

  parseAndRun(session, `
    let after = new TextDecoder().decode(new TextEncoder().encode("hi"))
    let decodeType = typeof new TextDecoder().decode
    let encodeType = typeof new TextEncoder().encode
  `, 0, 1000000);
  assertEquals(session.get(0, 'after'), 'hi',
    'TextDecoder.decode must survive heap compaction');
  assertEquals(session.get(0, 'decodeType'), 'function');
  assertEquals(session.get(0, 'encodeType'), 'function');
});

Deno.test('primitive-string iteration survives heap compaction', () => {
  const session = freshSession({
    heapSize: 768 * 1024,
    stringTableSize: 512 * 1024,
  });

  churn(session);
  parseAndRun(session, `
    let before = ""
    for (let ch of "abc") { before = before + ch }
  `, 0, 1000000);
  assertEquals(session.get(0, 'before'), 'abc');

  session.gc();

  parseAndRun(session, `
    let after = ""
    for (let ch of "xyz") { after = after + ch }
  `, 0, 1000000);
  assertEquals(session.get(0, 'after'), 'xyz',
    'string for..of must survive heap compaction (STRING_PROTOTYPE root)');
});

Deno.test('request-burst gate shape: fresh slots keep draining streams after gc', async () => {
  // Public-API repro of the original report: declared root handle,
  // pinned namespace handle behind a getter, suspending `read` minting
  // fresh stream/reader handles, fresh slot per request, gc between
  // requests. Before the fix request 3+ failed at the drain step with
  // "Not a function" (the TextDecoder at the end of the drain helper).
  let onRequestClosure = null;
  const reports = new Map();
  function expectReport(correlationId) {
    const entry = {};
    entry.promise = new Promise((resolve) => { entry.resolve = resolve; });
    reports.set(correlationId, entry);
    return entry.promise;
  }

  const cap = {
    name: 'resource',
    needs: {},
    setup(airlock) {
      const root = airlock.register({}, { kind: 'resource-root' });
      airlock.declare('resource', root);
      const claimNs = airlock.pin(airlock.register({}, { kind: 'claim-ns' }));
      airlock.setGetter(root, 'claim', () => claimNs);

      const grant = airlock.createRootGrant('root');
      grant.add(root);
      grant.add(claimNs);

      airlock.setHandler(claimNs, 'read', ({ args, context }) => {
        const uuid = args[0];
        return context.suspend((resolve) => {
          setTimeout(() => {
            const chunks = [
              new TextEncoder().encode(`{"uuid":"`),
              new TextEncoder().encode(`${uuid}"}`),
            ];
            const streamHandle = airlock.register({}, { kind: 'stream', uuid });
            grant.add(streamHandle);
            airlock.setHandler(streamHandle, 'getReader', () => {
              const readerHandle = airlock.register({}, { kind: 'reader', uuid });
              grant.add(readerHandle);
              let chunkIndex = 0;
              airlock.setHandler(readerHandle, 'read', ({ context: readContext }) =>
                readContext.suspend((resolveRead) => {
                  setTimeout(() => {
                    if (chunkIndex < chunks.length) {
                      resolveRead({ done: false, value: chunks[chunkIndex++] });
                    } else {
                      resolveRead({ done: true });
                    }
                  }, 0);
                }));
              return readerHandle;
            });
            resolve(streamHandle);
          }, 0);
        });
      });

      const registerHandle = airlock.register({}, { kind: 'register' });
      airlock.declare('onRequest', registerHandle);
      grant.add(registerHandle);
      airlock.setHandler(registerHandle, null, ({ args }) => {
        onRequestClosure = args[0];
      });

      const reportHandle = airlock.register({}, { kind: 'report' });
      airlock.declare('report', reportHandle);
      grant.add(reportHandle);
      airlock.setHandler(reportHandle, null, ({ args }) => {
        const [correlationId, message] = args;
        const entry = reports.get(correlationId);
        if (entry) { reports.delete(correlationId); entry.resolve(message); }
      });

      return {};
    },
  };

  const { runtime, session } = new RuntimeBuilder()
    .onInboundMessage(() => {})
    .capability(cap)
    .build();
  await runtime.start();

  const parsed = session.parse(`
    let drainStreamToString = async (stream) => {
      let reader = stream.getReader()
      let chunks = []
      let done = false
      while (!done) {
        let res = await reader.read()
        if (res.done) {
          done = true
        } else {
          chunks.push(res.value)
        }
      }
      let totalLength = 0
      let i = 0
      while (i < chunks.length) {
        totalLength = totalLength + chunks[i].length
        i = i + 1
      }
      let merged = new Uint8Array(totalLength)
      let offset = 0
      i = 0
      while (i < chunks.length) {
        merged.set(chunks[i], offset)
        offset = offset + chunks[i].length
        i = i + 1
      }
      let decoder = new TextDecoder()
      return decoder.decode(merged)
    }

    let handleRequest = async (correlationId) => {
      let result = "?"
      try {
        let bodyText = await drainStreamToString(resource.claim.read(correlationId))
        result = "OK " + bodyText
      } catch (e) {
        result = "FAILED: " + e.message
      }
      report(correlationId, result)
    }

    onRequest(handleRequest)
  `);
  session.setInstruction(0, parsed.startIndex);
  await runtime.run(0);
  assert(onRequestClosure, 'onRequest closure should be registered');

  const results = [];
  for (let requestIndex = 0; requestIndex < 8; requestIndex++) {
    if (requestIndex === 3) session.gc();
    const correlationId = `corr-${requestIndex}`;
    const reported = expectReport(correlationId);
    runtime.scheduleClosureCall(onRequestClosure, [correlationId], {});
    let timeoutId;
    try {
      const out = await Promise.race([
        reported,
        new Promise((_, reject) => {
          timeoutId = setTimeout(
            () => reject(new Error(`request ${requestIndex} timed out`)), 5000);
        }),
      ]);
      results.push(out);
    } finally {
      clearTimeout(timeoutId);
    }
  }

  await runtime.terminate();

  for (let requestIndex = 0; requestIndex < 8; requestIndex++) {
    assertEquals(results[requestIndex], `OK {"uuid":"corr-${requestIndex}"}`,
      `request ${requestIndex} must drain successfully (got: ${results[requestIndex]})`);
  }
});

/**
 * Regression suite for GC corruption during repeated await-loop delivery.
 *
 * Root cause: `MsgpackRef` used to store an absolute address into a
 * heap region allocated without a GC header. When compaction walked
 * the heap, it read the msgpack opcodes as a malformed object header
 * and corrupted state on the way past — surfacing as
 * `"asyncNoop is not defined"`, `"Undefined reference"`, or `"Array"`
 * (the post-GC bogus type of a moved-but-not-forwarded value).
 *
 * The segment-relative layout wraps the bytes in a real OBJ.ARRAYBUFFER and
 * stores a (parent_data_ptr, offset) pair on the value, so:
 *
 *   - the heap walker advances past the bytes via the length prefix,
 *   - the parent pointer is forwarded by the collector like any other
 *     DATA pointer,
 *   - the offset is a stable byte offset that doesn't move.
 *
 * These tests pin the invariants that prevent that failure shape.
 *
 * Run with: deno task test tests/fuel/msgpack_ref_gc_test.js
 */

import { assertEquals, assert } from "https://deno.land/std@0.208.0/assert/mod.ts";
import { createSession } from '../../src/fuel/session.js';
import { MsgpackRef } from '../../src/fuel/airlock.js';
import { parseAndSetup } from './test-helpers.js';
import { freshSession } from '../../src/host-owned-session.js';

// Minimal msgpack encoder covering the shapes the regression needs:
// fixmap, fixarray, fixstr, fixint, true/false, nil, float64.
function encodeValue(value) {
  if (value === null) return [0xc0];
  if (typeof value === 'boolean') return [value ? 0xc3 : 0xc2];
  if (typeof value === 'string') {
    const bytes = new TextEncoder().encode(value);
    if (bytes.length > 31) throw new Error('fixstr only');
    return [0xa0 | bytes.length, ...bytes];
  }
  if (typeof value === 'number') {
    if (Number.isInteger(value) && value >= 0 && value <= 127) return [value];
    if (Number.isInteger(value) && value >= -32 && value < 0) return [0xe0 | (value + 32)];
    const buffer = new ArrayBuffer(8);
    new DataView(buffer).setFloat64(0, value, false);
    return [0xcb, ...new Uint8Array(buffer)];
  }
  if (Array.isArray(value)) {
    if (value.length > 15) throw new Error('fixarray only');
    const out = [0x90 | value.length];
    for (const item of value) out.push(...encodeValue(item));
    return out;
  }
  const entries = Object.entries(value);
  if (entries.length > 15) throw new Error('fixmap only');
  const out = [0x80 | entries.length];
  for (const [k, v] of entries) {
    out.push(...encodeValue(k));
    out.push(...encodeValue(v));
  }
  return out;
}

function bindMsgpackRef(session, varName, jsValue) {
  const payload = new Uint8Array(encodeValue(jsValue));
  const dataPointer = session.airlock.allocateMsgpackBytes(payload);
  const mem = session.mem;
  const scope = mem.getRootScope();
  const valuePointer = mem.scopeLookup(scope, mem.internString(varName));
  mem.writeMsgpackRef(valuePointer, dataPointer, 0);
  return dataPointer;
}

// =============================================================================
// Direct GC survival
// =============================================================================

Deno.test('MsgpackRef survives a GC cycle and still reads correctly', async () => {
  const session = await freshSession();

  parseAndSetup(session, `
    let message = null
    let after = null
  `);
  session.run(0, 10000);

  bindMsgpackRef(session, 'message', { name: 'alice', age: 30 });

  // Force a full collection. The OBJ.ARRAYBUFFER holding the bytes
  // may relocate; the MsgpackRef's parent_data_ptr must follow it.
  session.gc();

  parseAndSetup(session, 'after = message.name');
  const result = session.run(0, 10000);
  assertEquals(result.status, 'done');
  assertEquals(session.get(0, 'after'), 'alice');
});

Deno.test('MsgpackRef survives many back-to-back GCs', async () => {
  const session = await freshSession();

  parseAndSetup(session, `
    let message = null
    let total = 0
  `);
  session.run(0, 10000);

  bindMsgpackRef(session, 'message', { items: [1, 2, 3, 4, 5] });

  for (let i = 0; i < 20; i++) session.gc();

  // The ref still resolves and indexed access still works.
  parseAndSetup(session, `
    total = message.items[0] + message.items[4]
  `);
  const result = session.run(0, 10000);
  assertEquals(result.status, 'done');
  assertEquals(session.get(0, 'total'), 6);
});

Deno.test('MsgpackRef in a sub-property still resolves after GC', async () => {
  const session = await freshSession();

  parseAndSetup(session, `
    let message = null
    let result = null
  `);
  session.run(0, 10000);

  bindMsgpackRef(session, 'message', {
    user: { name: 'bob', id: 42 },
    items: ['x', 'y', 'z'],
  });

  // Sub-region access first (so the inner reference is exercised),
  // then a GC, then re-access through the same parent ref.
  parseAndSetup(session, 'result = message.user.name');
  session.run(0, 10000);
  assertEquals(session.get(0, 'result'), 'bob');

  session.gc();

  parseAndSetup(session, 'result = message.items[2]');
  session.run(0, 10000);
  assertEquals(session.get(0, 'result'), 'z');
});

// =============================================================================
// Heap-pressure regression
// =============================================================================

Deno.test('MsgpackRef does not corrupt the heap walker under repeated allocate-then-GC pressure', async () => {
  // The pre-Layout-A bug surfaced once GC walked past msgpack bytes
  // that lacked a GC header. Even one such walk corrupted nearby
  // objects. The test allocates many msgpack payloads, runs GC, and
  // confirms that subsequent variable lookups in an unrelated scope still
  // resolve. The canary is `"asyncNoop is not defined"` after a name lookup
  // crosses a corrupted region.
  const session = await freshSession();

  parseAndSetup(session, `
    let probe = "intact"
    let echo = null
  `);
  session.run(0, 10000);

  // Allocate many short-lived payloads. We retain the first one in a
  // declared variable so it's a live root through GC; the rest are
  // unreachable and should be reclaimed.
  bindMsgpackRef(session, 'echo', { tag: 'first', n: 0 });
  for (let i = 1; i < 200; i++) {
    const payload = new Uint8Array(encodeValue({ tag: 'transient', n: i }));
    session.airlock.allocateMsgpackBytes(payload);
    if ((i % 17) === 0) session.gc();
  }

  // Force several more cycles to exercise compaction with the
  // surviving msgpack ref present.
  for (let i = 0; i < 5; i++) session.gc();

  // The unrelated name lookup is the corruption canary in miniature.
  parseAndSetup(session, 'probe = probe + "!"');
  const result = session.run(0, 10000);
  assertEquals(result.status, 'done');
  assertEquals(session.get(0, 'probe'), 'intact!');

  // The retained ref still reads correctly.
  parseAndSetup(session, 'probe = echo.tag');
  session.run(0, 10000);
  assertEquals(session.get(0, 'probe'), 'first');
});

// =============================================================================
// Callback delivery with declared globals
// =============================================================================

Deno.test('Repeated msgpack-payload callback invocations preserve declared-name lookup across GC', async () => {
  // Mirrors the failing listener pattern at a smaller scale:
  //   - a global is declared via airlock.declare,
  //   - a closure references that global,
  //   - the closure is invoked many times via setupCallbackContext,
  //     each time receiving an event whose .data is a fresh
  //     MsgpackRef,
  //   - GC runs between invocations.
  //
  // Pre-Layout-A this would eventually fail with the symptom
  // "<global> is not defined" once compaction walked past a
  // header-less msgpack region and corrupted the scope lookup chain.
  const session = await freshSession();
  const airlock = session.airlock;

  // Declared global the closure will reference on every iteration.
  // Whether the value is a real handler or just a marker doesn't
  // matter — the regression is in the *lookup*, not the call.
  const markerHandle = airlock.register({ kind: 'asyncNoopMarker' });
  airlock.declare('asyncNoop', markerHandle);

  parseAndSetup(session, `
    let received = null
    let probe = 0
    function handler(e) {
      // Reference the declared global on every call. Pre-Layout-A,
      // this lookup is what fails after GC corrupts the scope chain.
      const _marker = asyncNoop
      received = e.data.n
      probe = probe + 1
    }
  `);
  session.run(0, 10000);

  const handlerValue = session.get(0, 'handler');
  const closureHandle = airlock.registerClosure(handlerValue._dataLo, 0);

  const ITERATIONS = 200;
  for (let i = 0; i < ITERATIONS; i++) {
    const slot = session.mem.allocateContext();
    airlock.setupCallbackContext(slot, closureHandle, [{
      data: new MsgpackRef(
        airlock.allocateMsgpackBytes(new Uint8Array(encodeValue({ n: i })))),
    }]);
    const result = session.run(slot, 10000);
    assertEquals(result.status, 'done',
      `iteration ${i} should complete; got ${JSON.stringify(result)}`);
    assertEquals(session.get(0, 'received'), i,
      `iteration ${i} should observe its own n`);
    session.mem.freeContext(slot);
    if ((i % 13) === 0) session.gc();
  }

  assertEquals(session.get(0, 'probe'), ITERATIONS);
});

// =============================================================================
// Decode-produced refs (msgpack_to_object → msgpack_to_array threading)
// =============================================================================

Deno.test('decode-produced nested-container refs survive GC (parent_data_ptr threading)', async () => {
  // msgpack.decode of a map whose ARRAY values contain containers:
  // msgpack_to_object materializes those arrays via msgpack_to_array,
  // whose container elements become TYPE_MSGPACK_REF. The parent
  // pointer used to be passed as 0 on this path — the refs read
  // correctly until the first compaction moved the blob, then
  // silently dangled (inner.x came back undefined). Confirmed live
  // with scratchpad probe-parent0-ref.js, 2026-07-04.
  const session = await freshSession();

  parseAndSetup(session, `
    let bytes = msgpack.encode({ a: [ { x: 42 }, [7, 8] ] })
    let obj = msgpack.decode(bytes)
    let inner = obj.a[0]
    let innerArr = obj.a[1]
    let out = null
  `);
  session.run(0, 100000);

  // Force a full collection: the blob relocates; the refs' parent
  // pointers must follow it.
  session.gc();

  parseAndSetup(session, 'out = inner.x + innerArr[0] + innerArr[1]');
  const result = session.run(0, 100000);
  assertEquals(result.status, 'done', `expected done, got ${JSON.stringify(result.error ?? result.status)}`);
  assertEquals(session.get(0, 'out'), 57);
});

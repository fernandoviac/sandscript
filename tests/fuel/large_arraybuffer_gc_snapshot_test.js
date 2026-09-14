import { assertEquals } from "https://deno.land/std@0.208.0/assert/mod.ts";
import { freshSession, restoreSession, snapshotSession } from '../../src/host-owned-session.js';
import { parseAndRun } from './test-helpers.js';

// 12 + byteLength rounds to 16MiB + 24 at alignment 8, but +32 at
// alignment 16. A power-of-two byteLength would miss that mismatch.
const BYTE_LENGTH = 16 * 1024 * 1024 + 12;
const HEAP_SIZE = 24 * 1024 * 1024;

function run(session, source) {
  assertEquals(parseAndRun(session, source).status, 'done');
}

function collectAndRestore(session, check) {
  check(session);
  session.gc();
  check(session);

  const snapshot = snapshotSession(session);
  const restored = restoreSession(snapshot.vatBytes, snapshot.membraneBytes, {
    gcCollector: 'js',
  });
  check(restored);
  // Exercise the JS size decoder as well as the native collector, on a
  // restored image rather than pointers retained in the original host.
  restored.gc();
  // Reuse reclaimed heap space: an undersized move must not let this new
  // allocation overwrite the retained buffer's middle or last marker.
  run(restored, `
    let replacement = new Uint8Array(65536);
    replacement[0] = 213;
    replacement[65535] = 214;
  `);
  check(restored);
  run(restored, 'observed = [replacement[0], replacement[65535]];');
  assertEquals(restored.get(0, 'observed'), [213, 214]);
}

Deno.test('large native ArrayBuffer preserves bytes and its neighbor through GC and restore', () => {
  const session = freshSession({ heapSize: HEAP_SIZE, gcCollector: 'wat' });
  run(session, `
    let garbage = new ArrayBuffer(65536);
    let buffer = new ArrayBuffer(${BYTE_LENGTH});
    let neighbor = { label: 'native-neighbor', values: [37, 59] };
    let bytes = new Uint8Array(buffer);
    bytes[0] = 17;
    bytes[8388608] = 83;
    bytes[${BYTE_LENGTH - 1}] = 241;
    garbage = null;
    let observed = null;
  `);

  // The unreachable prefix forces relocation. Packed-size overflow used
  // to truncate the move/heap walk or spill into the object-type byte.
  collectAndRestore(session, (current) => {
    run(current, `observed = [
      buffer.byteLength, bytes.length, bytes[0], bytes[8388608],
      bytes[${BYTE_LENGTH - 1}], neighbor.label,
      neighbor.values[0], neighbor.values[1]
    ];`);
    assertEquals(current.get(0, 'observed'), [
      BYTE_LENGTH, BYTE_LENGTH, 17, 83, 241, 'native-neighbor', 37, 59,
    ]);
  });
});

Deno.test('large host msgpack buffer preserves bin bytes and its neighbor through GC and restore', () => {
  // Bin access materializes a native copy. Allow the parent plus two
  // checkpoint copies before the next explicit collection.
  const session = freshSession({ heapSize: 64 * 1024 * 1024, gcCollector: 'wat' });
  run(session, 'let message = null; let neighbor = null; let observed = null;');

  // A complete MessagePack [bin32, 91], generated in memory. The seven
  // framing bytes make the physical allocation BYTE_LENGTH, not merely
  // the decoded bin's length. No large on-disk fixture is needed.
  const binLength = BYTE_LENGTH - 7;
  const payload = new Uint8Array(BYTE_LENGTH);
  payload[0] = 0x92;
  payload[1] = 0xc6;
  new DataView(payload.buffer).setUint32(2, binLength, false);
  payload[6] = 17;
  payload[6 + 8388608] = 83;
  payload[6 + binLength - 1] = 241;
  payload[BYTE_LENGTH - 1] = 91;

  const mem = session.mem;
  const scope = mem.getRootScope();
  const messageSlot = mem.scopeLookup(scope, mem.internString('message'));
  const neighborSlot = mem.scopeLookup(scope, mem.internString('neighbor'));
  // Unrooted prefix ensures GC actually slides the large buffer down.
  mem.allocateArrayBuffer(65536);
  const parent = session.airlock.allocateMsgpackBytes(payload);
  mem.writeMsgpackRef(messageSlot, parent, 0);
  // Allocate the observable neighbor immediately after the msgpack block.
  // Keeping legacy align16 for this large allocation would leave an
  // eight-byte gap that the sentinel's align8 decoder mistakes for a header.
  mem.writeValueAt(neighborSlot, { label: 'msgpack-neighbor', values: [37, 59] });

  collectAndRestore(session, (current) => {
    // Decode afresh at every checkpoint, so a preserved earlier copy
    // cannot conceal corruption of the host-allocated parent buffer.
    run(current, `{
      let bin = message[0];
      observed = [
        bin.length, bin[0], bin[8388608], bin[${binLength - 1}],
        message[1], neighbor.label, neighbor.values[0], neighbor.values[1]
      ];
    }`);
    assertEquals(current.get(0, 'observed'), [
      binLength, 17, 83, 241, 91, 'msgpack-neighbor', 37, 59,
    ]);
  });
});

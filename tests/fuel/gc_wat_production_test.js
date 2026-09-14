/**
 * Production wiring for the WAT collector.
 *
 * session.gc() and compactMembrane() route through gc_collect when the
 * session is created with gcCollector: 'wat'; 'differential' runs both
 * collectors and compares every output (the soak gate).
 */
import { assert, assertEquals, assertThrows } from "https://deno.land/std@0.208.0/assert/mod.ts";
import { freshSession, snapshotSession } from '../../src/host-owned-session.js';
import { parseAndRun } from './test-helpers.js';

const PROGRAM = `
  let keep = 'live_marker_string';
  let m = new Map(); m.set('k', { nested: [keep, 12345678901234567890n] });
  function makeAdder(n) { return (x) => x + n; }
  let add2 = makeAdder(2);
  let sum = add2(40);
  let trash = null;
  for (let i = 0; i < 30; i++) { trash = { filler: 'garbage_' + i }; }
  trash = null;
`;

function churn(session) {
  for (let i = 0; i < 40; i++) {
    session.mem.internString(`garbage_padding_${i}_${'x'.repeat(30)}`);
  }
  parseAndRun(session, PROGRAM);
}

Deno.test('wat collector: gc() collects and the session keeps running', () => {
  const session = freshSession({ gcCollector: 'wat' });
  churn(session);

  const stats = session.gc();
  assert(stats.heapCollected > 0, 'garbage collected');
  assert(stats.stringsCollected > 0, 'strings compacted');
  assert('handlesFreed' in stats && 'grantsFreed' in stats, 'membrane stats surfaced');

  parseAndRun(session, `let after = keep + '|' + add2(sum);`);
  assertEquals(session.get(0, 'after'), 'live_marker_string|44');

  // A second collection over the compacted image works too.
  const again = session.gc();
  assert(again.heapCollected >= 0);
});

Deno.test('wat collector: byte-identical to a js-collector session end-to-end', () => {
  const jsSession = freshSession({ gcCollector: 'js' });
  const watSession = freshSession({ gcCollector: 'wat' });
  churn(jsSession);
  churn(watSession);

  jsSession.gc();
  watSession.gc();

  const jsBytes = snapshotSession(jsSession).vatBytes;
  const watBytes = snapshotSession(watSession).vatBytes;
  assertEquals(watBytes.length, jsBytes.length);
  for (let i = 0; i < jsBytes.length; i++) {
    if (jsBytes[i] !== watBytes[i]) {
      throw new Error(`segments diverge at byte ${i}: js ${jsBytes[i]} vs wat ${watBytes[i]}`);
    }
  }
});

Deno.test('differential mode: gc() runs both collectors and agrees', () => {
  const session = freshSession({ gcCollector: 'differential', inlineSource: true });
  churn(session);
  session.parse(`let second_root = 'chain_marker';`);

  const stats = session.gc();
  assert(stats.heapCollected > 0);
  // No GcDifferentialDivergence thrown = the two collectors agreed on
  // every output for this image.
});

Deno.test('wat collector: compactMembrane routes through mark-only mode', () => {
  const session = freshSession({ gcCollector: 'wat' });
  churn(session);
  session.mem.declareExternal('extThing', 7);

  const stats = session.airlock.compactMembrane();
  assert(typeof stats.handlesFreed === 'number');

  // The externally-referenced value is still intact afterwards.
  parseAndRun(session, `let still = keep;`);
  assertEquals(session.get(0, 'still'), 'live_marker_string');
});

Deno.test('wat collector: nonzero baseOffset (multi-vat-style placement)', () => {
  // The vat starts 64 KB into the memory — everything in the collector
  // flows through $abs/$base_offset, and this pins it.
  const offset = 65536;
  const makeMemory = () => new WebAssembly.Memory({ initial: 64, maximum: 16384, shared: true });
  const segmentBytes = (session) =>
    session.mem.u8.slice(session.mem.abs(0), session.mem.abs(session.mem.segmentSize));

  const jsSession = freshSession({
    memory: makeMemory(), offset, gcCollector: 'js', heapSize: 768 * 1024,
  });
  const watSession = freshSession({
    memory: makeMemory(), offset, gcCollector: 'wat', heapSize: 768 * 1024,
  });
  churn(jsSession);
  churn(watSession);
  const jsStats = jsSession.gc();
  const watStats = watSession.gc();
  assert(watStats.heapCollected > 0 && watStats.stringsCollected > 0);
  assertEquals(watStats.heapCollected, jsStats.heapCollected);

  const jsBytes = segmentBytes(jsSession);
  const watBytes = segmentBytes(watSession);
  for (let i = 0; i < jsBytes.length; i++) {
    if (jsBytes[i] !== watBytes[i]) {
      throw new Error(`offset-${offset} segments diverge at byte ${i}`);
    }
  }

  // snapshotSession honours the offset (it sliced [0, byteLength)
  // regardless of placement until 2026-07-05).
  const snapshot = snapshotSession(watSession).vatBytes;
  assertEquals(snapshot.length, watBytes.length);
  for (let i = 0; i < snapshot.length; i++) {
    if (snapshot[i] !== watBytes[i]) {
      throw new Error(`snapshotSession missliced at byte ${i}`);
    }
  }

  parseAndRun(watSession, `let after = keep + '|' + add2(sum);`);
  assertEquals(watSession.get(0, 'after'), 'live_marker_string|44');

  // Differential mode at the same offset agrees with itself too.
  const diffSession = freshSession({
    memory: makeMemory(), offset, gcCollector: 'differential', heapSize: 768 * 1024,
  });
  churn(diffSession);
  diffSession.gc();
});

Deno.test('wat collector: detected failure poisons the session', () => {
  const session = freshSession({ gcCollector: 'wat' });
  churn(session);
  // A handle slot beyond the membrane's table capacity: the observer
  // write fails with GC_ERR_HANDLE_SLOT_RANGE (a silently dropped
  // liveness bit would become a wrongful eviction).
  session.mem.declareExternal('corrupt', 99999999);

  const first = assertThrows(() => session.gc(), Error);
  assertEquals(first.name, 'FatalCollectionError');
  assert(first.fatalCollection === true);
  assert(first.message.includes('0x42'), `stamp decoded in message: ${first.message}`);

  // Sticky: the next collection refuses without touching the image.
  const second = assertThrows(() => session.gc(), Error);
  assertEquals(second.name, 'FatalCollectionError');
  assert(second.message.includes('poisoned'));
});

Deno.test('wat collector: zero-size header before heapPointer is fatal', () => {
  const session = freshSession({ gcCollector: 'wat' });
  churn(session);

  const image = session.memoryImage;
  const heapStart = image.getHeapStart();
  const absoluteHeapStart = image.abs(heapStart);
  const headerWord = image.view.getUint32(absoluteHeapStart, true);
  image.view.setUint32(absoluteHeapStart, headerWord & 0xFF000000, true);

  const failure = assertThrows(() => session.gc(), Error);
  assertEquals(failure.name, 'FatalCollectionError');
  assert(failure.fatalCollection === true);
  assert(failure.message.includes('0x46'), `stamp decoded in message: ${failure.message}`);
  assert(failure.message.includes(`detail ${heapStart}`), `header identified in message: ${failure.message}`);
});

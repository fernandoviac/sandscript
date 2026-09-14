/**
 * RegExp snapshot/restore: paused regex operations survive a byte-level
 * snapshot and resume in a freshly restored session without duplicate
 * mutation or lost progress.
 *
 * The workload crosses every continuation the integration owns:
 * pattern compilation, exec-shaped matching, the string-method loops,
 * matchAll iteration, and staged replacement callbacks, with lastIndex
 * and partially built results live at pause time.
 */
import { assert, assertEquals } from "https://deno.land/std@0.208.0/assert/mod.ts";
import { freshSession, restoreSession, snapshotSession } from '../../src/host-owned-session.js';
import { parseAndSetup } from './test-helpers.js';

const WORKLOAD = String.raw`
  let s = "xx abc-2026 def-11 ghi-999 é€𝄞 tail";
  let out = [];
  out.push(s.search(/def-\d+/));
  out.push(s.match(/(\w+)-(\d+)/).index);
  out.push(s.match(/[a-z]+-\d+/g));
  out.push(s.split(/-|\s+/));
  out.push(s.replace(/(\w+)-(\d+)/g, "[$2:$1]"));
  out.push(s.replace(/[aeiou]/g, (m, off) => m.toUpperCase() + off));
  let g = /(\w+)-(\d+)/g;
  let seq = [];
  let m;
  while ((m = g.exec(s)) !== null) { seq.push([m[1], m[2], g.lastIndex]); }
  out.push(seq);
  let mm = [];
  for (const hit of s.matchAll(/(\w+)-(\d+)/g)) mm.push([hit[0], hit.index]);
  out.push(mm);
  let done = 1;
`;

const SLOTS = ['out', 'done'];

function expectedValues() {
  const session = freshSession({ inlineSource: true });
  parseAndSetup(session, WORKLOAD);
  const result = session.run(0, 100000000);
  assertEquals(result.status, 'done');
  const expected = {};
  for (const name of SLOTS) expected[name] = session.get(0, name);
  return expected;
}

Deno.test('regexp snapshot: paused operations survive restore at EVERY pause', () => {
  const expected = expectedValues();
  let session = freshSession({ inlineSource: true });
  parseAndSetup(session, WORKLOAD);
  let pauses = 0;
  let restores = 0;
  for (let i = 0; i < 500000; i++) {
    session.mem.wasm.exports.run(25, 0);
    const condition = session.mem.getExitCondition(0);
    if (condition === 15) { session.gc(); continue; }
    if (condition === 2) {
      pauses++;
      // Snapshot the paused session and CONTINUE IN THE RESTORED COPY.
      // Every regex continuation - compile workspace, match threads,
      // partially built results, staged callback frames, lastIndex -
      // must cross the byte boundary intact, repeatedly.
      const snap = snapshotSession(session);
      session = restoreSession(snap.vatBytes, snap.membraneBytes);
      restores++;
      continue;
    }
    break;
  }
  assertEquals(session.mem.getExitCondition(0), 1, 'chained-restore run completes');
  assert(pauses > 50, `regex work actually paused under tiny fuel (got ${pauses})`);
  assertEquals(restores, pauses, 'every pause crossed a snapshot/restore');
  for (const name of SLOTS) {
    assertEquals(session.get(0, name), expected[name], `slot ${name}`);
  }
});

Deno.test('regexp snapshot: snapshotting a paused session perturbs neither side', () => {
  const expected = expectedValues();
  const original = freshSession({ inlineSource: true });
  parseAndSetup(original, WORKLOAD);
  // Run to a pause somewhere in the middle of the regex work.
  let pauses = 0;
  let midSnapshot = null;
  for (let i = 0; i < 500000; i++) {
    original.mem.wasm.exports.run(25, 0);
    const condition = original.mem.getExitCondition(0);
    if (condition === 15) { original.gc(); continue; }
    if (condition === 2) {
      pauses++;
      if (pauses === 40 && midSnapshot === null) {
        midSnapshot = snapshotSession(original);
      }
      continue;
    }
    break;
  }
  assert(midSnapshot !== null, 'reached the mid-workload pause');
  assertEquals(original.mem.getExitCondition(0), 1, 'original completes after snapshot');
  for (const name of SLOTS) {
    assertEquals(original.get(0, name), expected[name], `original slot ${name}`);
  }
  // The restored twin resumes from the middle and lands on the same values.
  const twin = restoreSession(midSnapshot.vatBytes, midSnapshot.membraneBytes);
  for (let i = 0; i < 500000; i++) {
    twin.mem.wasm.exports.run(25, 0);
    const condition = twin.mem.getExitCondition(0);
    if (condition === 15) { twin.gc(); continue; }
    if (condition === 2) continue;
    break;
  }
  assertEquals(twin.mem.getExitCondition(0), 1, 'twin completes');
  for (const name of SLOTS) {
    assertEquals(twin.get(0, name), expected[name], `twin slot ${name}`);
  }
});

Deno.test('regexp snapshot: gc pressure plus restore on the same pauses', () => {
  const expected = expectedValues();
  let session = freshSession({ inlineSource: true });
  // Heap churn so compaction relocates the subject, pattern strings,
  // program buffers, and continuations before each snapshot.
  for (let i = 0; i < 30; i++) {
    session.mem.internString(`garbage_pad_${i}_${'y'.repeat(40)}`);
  }
  parseAndSetup(session, WORKLOAD);
  let pauses = 0;
  for (let i = 0; i < 500000; i++) {
    session.mem.wasm.exports.run(25, 0);
    const condition = session.mem.getExitCondition(0);
    if (condition === 15) { session.gc(); continue; }
    if (condition === 2) {
      pauses++;
      // Compact FIRST (relocating everything), then snapshot the
      // compacted image and continue in the restored copy.
      session.gc();
      const snap = snapshotSession(session);
      session = restoreSession(snap.vatBytes, snap.membraneBytes);
      continue;
    }
    break;
  }
  assertEquals(session.mem.getExitCondition(0), 1, 'gc+restore run completes');
  assert(pauses > 50, `paused repeatedly (got ${pauses})`);
  for (const name of SLOTS) {
    assertEquals(session.get(0, name), expected[name], `slot ${name}`);
  }
});

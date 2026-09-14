/**
 * In-place closure retargeting for live code patching.
 *
 * Retarget edits existing closure objects (START/END/FLAGS) so every
 * holder — array element, membrane handle, promise handler — runs v2
 * with zero rewiring. applyPatch does it automatically; these tests
 * drive the full cycle and assert held closures upgrade, the
 * free-variable check refuses incompatible ones, and the
 * unambiguous-match rule governs anonymous callbacks.
 */
import { assert, assertEquals } from "https://deno.land/std@0.208.0/assert/mod.ts";
import { freshSession, restoreSession, snapshotSession } from '../../src/host-owned-session.js';
import { parseAndRun } from './test-helpers.js';
import { diffNewSource } from '../../src/fuel/code-diff.js';
import { auditLiveReferences } from '../../src/fuel/patch-audit.js';
import { applyPatch, retargetClosures } from '../../src/fuel/patch-apply.js';
import { readMembraneLayout } from '../../src/membrane/membrane-layout.js';
import { CLOSURE_HANDLE_ENTRY_SIZE } from '../../src/membrane/index.js';

function patchCycle(liveSession, newSource, options) {
  const { vatBytes, membraneBytes } = snapshotSession(liveSession);
  const scratch = restoreSession(vatBytes, membraneBytes);
  scratch.gc();
  const diff = diffNewSource(scratch, newSource);
  assert(!diff.parseFailed, 'new source must parse');
  const audit = auditLiveReferences(scratch.mem, scratch.airlock.membrane, diff);
  const report = applyPatch(scratch, diff, audit, options);
  return { scratch, diff, audit, report };
}

Deno.test('named function held in an array runs v2 after automatic retarget', () => {
  const live = freshSession({ inlineSource: true });
  parseAndRun(live, `
    function job(v) { return v * 2; }
    let queue = [job];
  `);

  const { scratch, report } = patchCycle(live, `
    function job(v) { return v * 3; }
    let queue = [job];
  `);

  // The held closure was retargeted, not just the binding.
  assert(report.retarget.retargeted.some((entry) => entry.name === 'job'));
  parseAndRun(scratch, `
    let direct = job(4);
    let held = queue[0](4);
  `);
  assertEquals(scratch.get(0, 'direct'), 12); // by name → v2
  assertEquals(scratch.get(0, 'held'), 12);   // held closure → v2 (retargeted)
});

Deno.test('membrane closure handle runs v2 after retarget; membrane bytes unchanged', () => {
  const live = freshSession({ inlineSource: true });
  parseAndRun(live, `function callback(v) { return v + 10; }`);
  const closureValue = live.getExact(0, 'callback');
  const handle = live.airlock.registerClosure(closureValue._dataLo, 0);

  const beforeMembrane = snapshotSession(live).membraneBytes;
  const { scratch, report } = patchCycle(live, `function callback(v) { return v + 20; }`);

  const entry = report.retarget.retargeted.find((e) => e.name === 'callback');
  assert(entry, 'callback closure should be retargeted');
  assert(entry.membraneSlots.length >= 1, 'membrane slot should be listed');

  // Zero rewiring: the CLOSURE-HANDLE-TABLE region is byte-identical
  // (the handle still points at the same closure object — retarget
  // edited the heap, not the membrane). The header's OPERATION_TICK
  // (offset 120) legitimately bumps on the gc/run during patching, so
  // we compare the handle-table region specifically rather than the
  // whole buffer.
  const afterMembrane = snapshotSession(scratch).membraneBytes;
  const layout = readMembraneLayout(beforeMembrane, 0);
  const tableStart = layout.regionOffsets.closureHandleTable;
  const tableEnd = tableStart +
    layout.capacities.closureHandleTableCapacity * CLOSURE_HANDLE_ENTRY_SIZE;
  let firstDiff = -1;
  for (let i = tableStart; i < tableEnd; i++) {
    if (beforeMembrane[i] !== afterMembrane[i]) { firstDiff = i; break; }
  }
  assertEquals(firstDiff, -1, `closure-handle table changed at offset ${firstDiff}`);

  // The closure object the handle points at now runs v2.
  parseAndRun(scratch, `let r = callback(5);`);
  assertEquals(scratch.get(0, 'r'), 25);
});

Deno.test('free-variable mismatch refuses retarget; closure keeps v1', () => {
  const live = freshSession({ inlineSource: true });
  // makeAdder returns a closure capturing `base`. v2's returned body
  // references `step`, which the captured scope does not have.
  parseAndRun(live, `
    function makeAdder(base) {
      function add(v) { return v + base; }
      return add;
    }
    let adder = makeAdder(100);
  `);
  assertEquals(live.get(0, 'adder') !== undefined, true);

  const { scratch, report } = patchCycle(live, `
    function makeAdder(base) {
      function add(v) { return v + base + step; }
      return add;
    }
    let adder = makeAdder(100);
  `);

  const refusal = report.retarget.refused.find(
    (entry) => entry.reason === 'freeVarMismatch');
  assert(refusal, 'add closure should be refused for missing free var');
  assert(refusal.missingNames.includes('step'));

  // The held closure still runs v1 (base only) — no crash on `step`.
  parseAndRun(scratch, `let out = adder(5);`);
  assertEquals(scratch.get(0, 'out'), 105);
});

Deno.test('added root binding referenced by the new body resolves and retargets', () => {
  const live = freshSession({ inlineSource: true });
  parseAndRun(live, `
    function job(v) { return v * 2; }
    let held = [job];
  `);

  // v2 adds a root const the new body references.
  const { scratch, report } = patchCycle(live, `
    const FACTOR = 5;
    function job(v) { return v * FACTOR; }
    let held = [job];
  `);

  assert(report.retarget.retargeted.some((entry) => entry.name === 'job'),
    'job should retarget — FACTOR resolves at root scope');
  parseAndRun(scratch, `let r = held[0](3);`);
  assertEquals(scratch.get(0, 'r'), 15);
});

Deno.test('sync → async change updates FUNCTION_FLAGS on retarget', () => {
  const live = freshSession({ inlineSource: true });
  parseAndRun(live, `
    function task() { return 1; }
    let held = [task];
  `);

  const { scratch } = patchCycle(live, `
    async function task() { return 2; }
    let held = [task];
  `);

  const closureValue = scratch.getExact(0, 'task');
  assert(scratch.mem.isAsyncClosure(closureValue._dataLo),
    'retargeted by-name closure is async');
  // The held closure object is the same one — also async now.
  parseAndRun(scratch, `let h = held[0];`);
  const heldValue = scratch.getExact(0, 'h');
  assert(scratch.mem.isAsyncClosure(heldValue._dataLo),
    'held closure object updated to async');
});

Deno.test('unambiguous: sole changed anonymous callback retargets', () => {
  const live = freshSession({ inlineSource: true });
  parseAndRun(live, `let handlers = [(e) => e + 1];`);

  const { scratch, report } = patchCycle(live, `let handlers = [(e) => e + 100];`);

  // One changed anonymous child of the toplevel → unambiguous.
  assert(report.retarget.retargeted.length >= 1,
    'sole anonymous callback should retarget');
  assertEquals(report.retarget.refused.length, 0);
  parseAndRun(scratch, `let r = handlers[0](1);`);
  assertEquals(scratch.get(0, 'r'), 101);
});

Deno.test('ambiguous: multiple changed anonymous siblings are refused, drain on v1', () => {
  const live = freshSession({ inlineSource: true });
  parseAndRun(live, `let handlers = [(e) => e + 1, (e) => e + 2];`);

  const { scratch, report } = patchCycle(live, `let handlers = [(e) => e + 10, (e) => e + 20];`);

  // Both changed anonymous siblings → ambiguous, both refused.
  const ambiguous = report.retarget.refused.filter(
    (entry) => entry.reason === 'ambiguousMatch');
  assertEquals(ambiguous.length, 2);
  assertEquals(report.retarget.retargeted.length, 0);

  // Held closures still run v1.
  parseAndRun(scratch, `let a = handlers[0](1); let b = handlers[1](1);`);
  assertEquals(scratch.get(0, 'a'), 2); // v1: +1
  assertEquals(scratch.get(0, 'b'), 3); // v1: +2
});

Deno.test('naming ambiguous siblings is the escape hatch — both retarget', () => {
  const live = freshSession({ inlineSource: true });
  parseAndRun(live, `
    let handlers = [
      function onClick(e) { return e + 1; },
      function onHover(e) { return e + 2; },
    ];
  `);

  const { scratch, report } = patchCycle(live, `
    let handlers = [
      function onClick(e) { return e + 10; },
      function onHover(e) { return e + 20; },
    ];
  `);

  // Named function expressions match by fact → both retarget.
  assertEquals(report.retarget.refused.length, 0);
  assert(report.retarget.retargeted.some((e) => e.name === 'onClick'));
  assert(report.retarget.retargeted.some((e) => e.name === 'onHover'));
  parseAndRun(scratch, `let a = handlers[0](1); let b = handlers[1](1);`);
  assertEquals(scratch.get(0, 'a'), 11);
  assertEquals(scratch.get(0, 'b'), 21);
});

Deno.test('retarget deferred when the migration run suspends', () => {
  const live = freshSession({ inlineSource: true });
  parseAndRun(live, `
    function job(v) { return v * 2; }
    let held = [job];
    const C = 1;
  `);

  // A changed const initializer that needs more fuel than we give →
  // migration run pauses, retarget deferred.
  const { report } = patchCycle(live, `
    function job(v) { return v * 3; }
    let held = [job];
    const C = (function () { let i = 0; while (i < 5000) { i = i + 1; } return i; })();
  `, { fuel: 200 });

  assertEquals(report.migration.status, 'paused');
  assert(report.retarget.deferred === true);
});

Deno.test('gc() between rebind and retarget: own walk stays correct', () => {
  const live = freshSession({ inlineSource: true });
  parseAndRun(live, `
    function job(v) { return v * 2; }
    let queue = [job];
  `);

  // Run applyPatch with retarget DISABLED-by-suspension is overkill;
  // instead call the pieces manually with a gc wedged between.
  const { vatBytes, membraneBytes } = snapshotSession(live);
  const scratch = restoreSession(vatBytes, membraneBytes);
  scratch.gc();
  const diff = diffNewSource(scratch, `
    function job(v) { return v * 3; }
    let queue = [job];
  `);
  const audit = auditLiveReferences(scratch.mem, scratch.airlock.membrane, diff);

  // Rebind only (no auto-retarget path): emulate by deleting+running
  // is what applyPatch does — just run it, then gc, then retarget
  // again (idempotent: already-retargeted closures now point at the
  // new range, whose start is no longer a changed unit's OLD start).
  applyPatch(scratch, diff, audit);
  scratch.gc();
  const second = retargetClosures(scratch, diff, audit);
  // Nothing left to do — the closures already point at v2.
  assertEquals(second.retargeted.length, 0);

  parseAndRun(scratch, `let r = queue[0](4);`);
  assertEquals(scratch.get(0, 'r'), 12);
});

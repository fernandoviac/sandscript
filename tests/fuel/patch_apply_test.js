/**
 * Patch application for live code.
 *
 * Full cycle under test: live session → snapshot → restore scratch →
 * gc → diffNewSource → auditLiveReferences → applyPatch → use the
 * scratch as the patched session.
 */
import { assert, assertEquals, assertThrows } from "https://deno.land/std@0.208.0/assert/mod.ts";
import { freshSession, restoreSession, snapshotSession } from '../../src/host-owned-session.js';
import { parseAndRun, parseAndSetup } from './test-helpers.js';
import { diffNewSource } from '../../src/fuel/code-diff.js';
import { auditLiveReferences } from '../../src/fuel/patch-audit.js';
import { applyPatch, PatchError } from '../../src/fuel/patch-apply.js';
import { UncaughtScriptError } from '../../src/runtime/errors.js';

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

function reranNames(report) {
  return report.reran.flatMap((entry) => entry.names);
}

Deno.test('scenario 1: handler bug fix — state survives, new calls run v2', () => {
  const live = freshSession({ inlineSource: true });
  parseAndRun(live, `
    let total = 0;
    function bump() { total = total + 1; return total; }
    let r = bump();
  `);
  assertEquals(live.get(0, 'total'), 1);

  const { scratch, report } = patchCycle(live, `
    let total = 0;
    function bump() { total = total + 10; return total; }
    let r = bump();
  `);

  assertEquals(reranNames(report), ['bump']);
  // Runtime state survived — NOT re-initialized to 0.
  assertEquals(scratch.get(0, 'total'), 1);
  assertEquals(scratch.get(0, 'r'), 1);
  parseAndRun(scratch, `let afterPatch = bump();`);
  assertEquals(scratch.get(0, 'afterPatch'), 11);
});

Deno.test('scenario 2: added state binding referenced by the changed function', () => {
  const live = freshSession({ inlineSource: true });
  parseAndRun(live, `
    let count = 0;
    function onMessage(m) { count = count + 1; return count; }
    let first = onMessage('a');
  `);

  const { scratch, report } = patchCycle(live, `
    let count = 0;
    let recent = [];
    function onMessage(m) { recent.push(m); count = count + 1; return recent.length * 100 + count; }
    let first = onMessage('a');
  `);

  assertEquals(report.reran, [
    { names: ['recent'], kind: 'addedBinding' },
    { names: ['onMessage'], kind: 'changedFunction' },
  ]);
  // The patch is coherent: the rebound function finds `recent`.
  parseAndRun(scratch, `let second = onMessage('b');`);
  assertEquals(scratch.get(0, 'second'), 102); // 1 recent * 100 + count 2
  assertEquals(scratch.get(0, 'count'), 2);    // accumulated state continued
});

Deno.test('scenario 3: changed const re-applies, changed let preserves runtime value', () => {
  const live = freshSession({ inlineSource: true });
  parseAndRun(live, `
    const LIMIT = 100;
    let total = 5;
    function check(v) { return v < LIMIT; }
  `);
  parseAndRun(live, `total = 50;`);

  const { scratch, report } = patchCycle(live, `
    const LIMIT = 200;
    let total = 7;
    function check(v) { return v < LIMIT; }
  `);

  assertEquals(reranNames(report), ['LIMIT']);
  assertEquals(scratch.get(0, 'LIMIT'), 200);
  assertEquals(scratch.get(0, 'total'), 50); // runtime value, not 7
  assert(report.reported.some(
    (entry) => entry.reason === 'changedLetInitializer' && entry.names.includes('total')));
  // check was identical — not re-run — and sees the new const.
  parseAndRun(scratch, `let ok = check(150);`);
  assertEquals(scratch.get(0, 'ok'), true);
});

Deno.test('removed function and removed data binding are both deleted', () => {
  const live = freshSession({ inlineSource: true });
  parseAndRun(live, `
    function gone() { return 1; }
    let oldData = 3;
    function stays() { return 2; }
  `);

  const { scratch, report } = patchCycle(live, `
    function stays() { return 2; }
  `);

  assertEquals(new Set(report.deleted), new Set(['gone', 'oldData']));
  assertEquals(scratch.get(0, 'gone'), undefined);
  assertEquals(scratch.get(0, 'oldData'), undefined);
  parseAndRun(scratch, `let s = stays();`);
  assertEquals(scratch.get(0, 's'), 2);
  assertThrows(() => parseAndRun(scratch, `gone();`), UncaughtScriptError);
});

Deno.test('new top-level effects run during patch migration', () => {
  const live = freshSession({ inlineSource: true });
  parseAndRun(live, `
    let log = [];
    log.push('boot');
    function f() { return log.length; }
  `);

  const { scratch, report } = patchCycle(live, `
    let log = [];
    log.push('boot');
    log.push('registered');
    function f() { return log.length; }
  `);

  assertEquals(scratch.get(0, 'log'), ['boot', 'registered']);
  assert(report.reran.some(
    (entry) => entry.kind === 'addedStatement' && entry.names.length === 0));
  assert(!report.reported.some((entry) => entry.reason === 'statementNotRun'));
});

Deno.test('const arrow re-runs; let arrow binding is preserved but its body retargets', () => {
  const live = freshSession({ inlineSource: true });
  parseAndRun(live, `
    const scale = (v) => v * 2;
    let handler = (v) => v + 1;
  `);

  const { scratch, report } = patchCycle(live, `
    const scale = (v) => v * 3;
    let handler = (v) => v + 9;
  `);

  // The const initializer re-runs; the let initializer does NOT (the
  // binding's runtime value is preserved, reported as changed).
  assertEquals(reranNames(report), ['scale']);
  assert(report.reported.some((entry) => entry.names.includes('handler')));

  // The preserved `handler` closure still points at the original arrow body,
  // which lies in the old range of a changed unit, so auto-retarget upgrades
  // it to v2. A runtime reassignment to an unrelated closure would remain
  // untouched because its body would not belong to a changed range.
  parseAndRun(scratch, `let a = scale(4); let b = handler(4);`);
  assertEquals(scratch.get(0, 'a'), 12); // v2 (const re-run)
  assertEquals(scratch.get(0, 'b'), 13); // v2 (arrow body retargeted: 4 + 9)
});

Deno.test('async function rebind carries the async closure flag', () => {
  const live = freshSession({ inlineSource: true });
  parseAndRun(live, `async function fetchIt() { return 1; }`);

  const { scratch } = patchCycle(live, `async function fetchIt() { return 2; }`);

  const closureValue = scratch.getExact(0, 'fetchIt');
  assert(scratch.mem.isAsyncClosure(closureValue._dataLo));
});

Deno.test('value-held closure: audit reports rewire tier, retarget upgrades it to v2', () => {
  const live = freshSession({ inlineSource: true });
  parseAndRun(live, `
    function job(v) { return v * 2; }
    let queue = [job];
  `);

  const { scratch, report } = patchCycle(live, `
    function job(v) { return v * 3; }
    let queue = [job];
  `);

  // The audit classified job as rewire (held in the array, not just by
  // name) — that's the input that drove retarget.
  assert(report.draining.some((entry) => entry.name === 'job' && entry.tier === 'rewire'));
  // Auto-retarget upgrades the held closure, so both the name and the array
  // element run v2.
  assert(report.retarget.retargeted.some((entry) => entry.name === 'job'));
  parseAndRun(scratch, `
    let direct = job(4);
    let held = queue[0](4);
  `);
  assertEquals(scratch.get(0, 'direct'), 12); // by name → v2
  assertEquals(scratch.get(0, 'held'), 12);   // held closure → v2 (retargeted)
});

Deno.test('destructuring declarations: partial binding additions preserve state and report', () => {
  // Patterns are real AST nodes (format v2), so the patcher extracts
  // the bound names from the pattern tree. Adding a name to an existing
  // let-pattern is the same partial-addition case as plain lets:
  // re-running would clobber live state, so it reports instead.
  const live = freshSession({ inlineSource: true });
  parseAndRun(live, `
    let src = { a: 1, b: 2, c: 3 };
    let { a, b } = src;
  `);
  parseAndRun(live, `a = 42;`);

  const { scratch, report } = patchCycle(live, `
    let src = { a: 1, b: 2, c: 3 };
    let { a, b, c } = src;
  `);

  assert(report.reported.some(
    (entry) => entry.reason === 'partialBindingAddition' && entry.names.includes('c')));
  assertEquals(scratch.get(0, 'a'), 42);       // not clobbered
  assertEquals(scratch.get(0, 'c'), undefined); // not auto-added — reported instead
});

Deno.test('destructuring declarations: wholly new patterns are synthesized', () => {
  // A destructuring declaration whose names are ALL new is an added
  // binding — the pattern statement reprints and re-runs. Before AST
  // format v2 this was impossible (destructuringNotApplied).
  const live = freshSession({ inlineSource: true });
  parseAndRun(live, `
    let src = { a: 1, b: 2 };
  `);

  const { scratch, report } = patchCycle(live, `
    let src = { a: 1, b: 2 };
    let { a: first, b: second } = src;
  `);

  assert(!report.reported.some((entry) => entry.reason === 'destructuringNotApplied'));
  assertEquals(scratch.get(0, 'first'), 1);
  assertEquals(scratch.get(0, 'second'), 2);
});

Deno.test('onUpgrade convention: state-shape migration via invokeExport', () => {
  const live = freshSession({ inlineSource: true });
  parseAndRun(live, `
    let shape = { value: 7 };
    function read() { return shape.value; }
  `);

  const { scratch, report } = patchCycle(live, `
    let shape = { value: 7 };
    function read() { return shape[0]; }
    export function onUpgrade() { shape = [shape.value]; return 'migrated'; }
  `);

  assert(reranNames(report).includes('onUpgrade'));
  const slot = scratch.invokeExport('onUpgrade', []);
  const result = scratch.run(slot, 100000);
  assertEquals(result.status, 'done');
  scratch.mem.freeContext(slot);

  parseAndRun(scratch, `let migrated = read();`);
  assertEquals(scratch.get(0, 'migrated'), 7);
});

Deno.test('parked activation drains v1; post-drain calls run v2', () => {
  const live = freshSession({ inlineSource: true });
  parseAndSetup(live, `
    function tag() {
      let i = 0;
      while (i < 50) { i = i + 1; }
      return 'v1-' + i;
    }
    let r = tag();
  `);
  const parked = live.run(0, 100);
  assertEquals(parked.status, 'paused');

  const { scratch } = patchCycle(live, `
    function tag() {
      let i = 0;
      while (i < 50) { i = i + 1; }
      return 'v2-' + i;
    }
    let r = tag();
  `);

  // Drain the parked activation — it completes on v1.
  const drained = scratch.run(0, 100000);
  assertEquals(drained.status, 'done');
  assertEquals(scratch.get(0, 'r'), 'v1-50');

  // The next invocation runs v2.
  parseAndRun(scratch, `let next = tag();`);
  assertEquals(scratch.get(0, 'next'), 'v2-50');
});

Deno.test('migration run that exhausts fuel surfaces status and keeps the slot', () => {
  const live = freshSession({ inlineSource: true });
  parseAndRun(live, `
    function heavy() {
      let i = 0;
      while (i < 5000) { i = i + 1; }
      return i;
    }
    const CACHED = 1;
  `);

  const { scratch, report } = patchCycle(live, `
    function heavy() {
      let i = 0;
      while (i < 5000) { i = i + 1; }
      return i;
    }
    const CACHED = heavy();
  `, { fuel: 200 });

  assertEquals(report.migration.status, 'paused');
  assert(report.migration.slot !== null);
  // The host drives the migration to completion before adopting —
  // including the documented gc-and-retry on memory pressure.
  let finished;
  for (let step = 0; step < 20; step++) {
    finished = scratch.run(report.migration, 1000000);
    if (finished.status === 'done') break;
    if (finished.status === 'memory_pressure') scratch.gc();
  }
  assertEquals(finished.status, 'done');
  scratch.mem.freeContext(report.migration.slot);
  assertEquals(scratch.get(0, 'CACHED'), 5000);
});

Deno.test('exports map on the scratch reflects the new source', () => {
  const live = freshSession({ inlineSource: true });
  parseAndRun(live, `export function oldApi() { return 1; }`);

  const { scratch } = patchCycle(live, `
    export function oldApi() { return 1; }
    export function newApi() { return 2; }
  `);

  assert(scratch.exports().has('newApi'));
});

Deno.test('gc() after the patch keeps the patched world coherent', () => {
  const live = freshSession({ inlineSource: true });
  parseAndRun(live, `
    let total = 3;
    function bump() { total = total + 1; return total; }
  `);

  const { scratch } = patchCycle(live, `
    let total = 3;
    function bump() { total = total + 2; return total; }
  `);

  scratch.gc();
  parseAndRun(scratch, `let after = bump();`);
  assertEquals(scratch.get(0, 'after'), 5);
  assertEquals(scratch.get(0, 'total'), 5);
});

Deno.test('missing AST region: clear error, nothing applied', () => {
  const live = freshSession(); // no inlineSource
  parseAndRun(live, `function f() { return 1; }`);

  const { vatBytes, membraneBytes } = snapshotSession(live);
  const scratch = restoreSession(vatBytes, membraneBytes);
  scratch.gc();
  const diff = diffNewSource(scratch, `function f() { return 2; }`);
  const audit = auditLiveReferences(scratch.mem, scratch.airlock.membrane, diff);

  assertThrows(() => applyPatch(scratch, diff, audit), PatchError);
  // Untouched: f still runs v1.
  parseAndRun(scratch, `let r = f();`);
  assertEquals(scratch.get(0, 'r'), 1);
});

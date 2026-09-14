/**
 * Code differ: parse-into-copy driver, matching, normalized comparison,
 * verdicts, and heap implications.
 *
 * The flow under test is the live-patching phase-1 contract: snapshot
 * the live vat, restore a scratch copy, append-parse the new source
 * into the scratch, and compare old vs new code within the one block.
 */
import { assert, assertEquals } from "https://deno.land/std@0.208.0/assert/mod.ts";
import { freshSession, restoreSession, snapshotSession } from '../../src/host-owned-session.js';
import { parseAndRun } from './test-helpers.js';
import { diffAppendedCode, diffNewSource } from '../../src/fuel/code-diff.js';

const BIG = '123456789012345678901234567890';

function scratchFrom(liveSession) {
  const { vatBytes, membraneBytes } = snapshotSession(liveSession);
  return restoreSession(vatBytes, membraneBytes);
}

function unitByName(result, name) {
  const matches = result.units.filter((u) => u.name === name);
  assertEquals(matches.length, 1, `expected exactly one unit named ${name}`);
  return matches[0];
}

function toplevel(result) {
  return result.units.find((u) => u.parentId === null);
}

Deno.test('identical reparse: every unit identical, strings fully dedupe', () => {
  const source = `
    function add(a, b) { return a + b; }
    function fmt(v) { return 'value: ' + v; }
    let total = add(1, 2);
  `;
  const live = freshSession();
  parseAndRun(live, source);

  const scratch = scratchFrom(live);
  const result = diffNewSource(scratch, source);

  assert(!result.parseFailed);
  for (const unit of result.units) {
    assertEquals(unit.verdict, 'identical',
      `unit ${unit.name ?? unit.kind} should be identical, got ${unit.verdict}: ` +
      JSON.stringify(unit.causes));
  }
  // Shared interning history: an identical reparse interns nothing new.
  assertEquals(result.heapImplications.stringTableDelta, 0);
  assert(result.heapImplications.codeGrowth > 0);
});

Deno.test('bigint literals compare by value across fresh parse-time allocations', () => {
  const source = `function big() { return ${BIG}n; }`;
  const live = freshSession();
  parseAndRun(live, source);

  const scratch = scratchFrom(live);
  const result = diffNewSource(scratch, source);

  assertEquals(unitByName(result, 'big').verdict, 'identical');
  // The reparse DID allocate a fresh heap bigint — value-compare is
  // what made the verdict identical, not pointer equality.
  assertEquals(result.heapImplications.parseAllocations.length, 1);
  assertEquals(String(result.heapImplications.parseAllocations[0].value), BIG);
});

Deno.test('body edit: that unit changed, siblings identical, toplevel changed via nesting', () => {
  const live = freshSession();
  parseAndRun(live, `
    function stays(v) { return v + 1; }
    function edited(v) { return v * 2; }
  `);

  const scratch = scratchFrom(live);
  const result = diffNewSource(scratch, `
    function stays(v) { return v + 1; }
    function edited(v) { return v * 3; }
  `);

  assertEquals(unitByName(result, 'stays').verdict, 'identical');
  const edited = unitByName(result, 'edited');
  assertEquals(edited.verdict, 'changed');
  assert(edited.causes.some((c) => c.kind === 'operand'));
  const root = toplevel(result);
  assertEquals(root.verdict, 'changed');
  assert(root.causes.some((c) => c.kind === 'nestedUnit'));
});

Deno.test('rename is removed + added, never a content match', () => {
  const live = freshSession();
  parseAndRun(live, `function sendReport(d) { return d; }`);

  const scratch = scratchFrom(live);
  const result = diffNewSource(scratch, `function submitReport(d) { return d; }`);

  const send = unitByName(result, 'sendReport');
  const submit = unitByName(result, 'submitReport');
  assertEquals(send.verdict, 'removed');
  assertEquals(send.newRange, null);
  assertEquals(submit.verdict, 'added');
  assertEquals(submit.oldRange, null);
});

Deno.test('matchBasis: name for named functions, null for added/removed', () => {
  const live = freshSession();
  parseAndRun(live, `
    function keep() { return 1; }
    function renameOld() { return 2; }
  `);

  const scratch = scratchFrom(live);
  const result = diffNewSource(scratch, `
    function keep() { return 1; }
    function renameNew() { return 2; }
  `);

  // Root is matched by identity.
  assertEquals(toplevel(result).matchBasis, 'name');
  // Named function paired by name.
  assertEquals(unitByName(result, 'keep').matchBasis, 'name');
  // Rename halves were never paired.
  assertEquals(unitByName(result, 'renameOld').matchBasis, null);
  assertEquals(unitByName(result, 'renameNew').matchBasis, null);
});

Deno.test('matchBasis: ordinal for ambiguous changed anonymous siblings', () => {
  const live = freshSession();
  // Two anonymous arrows held in a structure; both change in v2 with
  // no content anchor and no name → ordinal fallback.
  parseAndRun(live, `let hs = [(e) => e + 1, (e) => e + 2];`);

  const scratch = scratchFrom(live);
  const result = diffNewSource(scratch, `let hs = [(e) => e + 10, (e) => e + 20];`);

  const anonymous = result.units.filter(
    (u) => u.name === null && u.kind === 'function');
  assertEquals(anonymous.length, 2);
  for (const unit of anonymous) {
    assertEquals(unit.verdict, 'changed');
    assertEquals(unit.matchBasis, 'ordinal');
  }
});

Deno.test('matchBasis: content for an unchanged anonymous callback', () => {
  const live = freshSession();
  // One anonymous arrow unchanged, surrounding code changed so the
  // parent differs but the arrow matches by identical content.
  parseAndRun(live, `let r = [1].map((v) => v * 2); let x = 1;`);

  const scratch = scratchFrom(live);
  const result = diffNewSource(scratch, `let r = [1].map((v) => v * 2); let x = 99;`);

  const anonymous = result.units.find(
    (u) => u.name === null && u.kind === 'function');
  assertEquals(anonymous.verdict, 'identical');
  assertEquals(anonymous.matchBasis, 'content');
});

Deno.test('added and removed functions, including nested subtrees', () => {
  const live = freshSession();
  parseAndRun(live, `
    function keep() { return 1; }
    function dropMe() { let inner = () => 9; return inner(); }
  `);

  const scratch = scratchFrom(live);
  const result = diffNewSource(scratch, `
    function keep() { return 1; }
    function fresh() { return 2; }
  `);

  assertEquals(unitByName(result, 'keep').verdict, 'identical');
  const dropped = unitByName(result, 'dropMe');
  assertEquals(dropped.verdict, 'removed');
  assertEquals(unitByName(result, 'fresh').verdict, 'added');
  // dropMe's nested arrow is removed along with it, parented under it.
  const inner = unitByName(result, 'inner');
  assertEquals(inner.verdict, 'removed');
  assertEquals(inner.parentId, dropped.id);
});

Deno.test('anonymous nested arrow edit: outer changed with nested cause', () => {
  const live = freshSession();
  parseAndRun(live, `function scale(xs) { return xs.map((v) => v * 2); }`);

  const scratch = scratchFrom(live);
  const result = diffNewSource(scratch, `function scale(xs) { return xs.map((v) => v * 3); }`);

  const scale = unitByName(result, 'scale');
  assertEquals(scale.verdict, 'changed');
  assert(scale.causes.some((c) => c.kind === 'nestedUnit'));
  const anonymous = result.units.find((u) => u.name === null && u.kind === 'function');
  assertEquals(anonymous.verdict, 'changed');
});

Deno.test('reordered siblings: each function identical, parent changed', () => {
  const live = freshSession();
  parseAndRun(live, `
    function first() { return 1; }
    function second() { return 2; }
  `);

  const scratch = scratchFrom(live);
  const result = diffNewSource(scratch, `
    function second() { return 2; }
    function first() { return 1; }
  `);

  assertEquals(unitByName(result, 'first').verdict, 'identical');
  assertEquals(unitByName(result, 'second').verdict, 'identical');
  assertEquals(toplevel(result).verdict, 'changed');
});

Deno.test('changed top-level initializer: toplevel changed, functions identical', () => {
  const live = freshSession();
  parseAndRun(live, `
    let limit = 10;
    function check(v) { return v < limit; }
  `);

  const scratch = scratchFrom(live);
  const result = diffNewSource(scratch, `
    let limit = 20;
    function check(v) { return v < limit; }
  `);

  assertEquals(unitByName(result, 'check').verdict, 'identical');
  const root = toplevel(result);
  assertEquals(root.verdict, 'changed');
  assert(root.causes.some((c) => c.kind === 'operand'));
});

Deno.test('jump normalization: identical function after a sibling of different length', () => {
  // `tail` sits after `pad` in the stream; in the new version `pad`
  // is longer, shifting every absolute index in and around `tail`.
  // Ordinal normalization must still see `tail` as identical.
  const live = freshSession();
  parseAndRun(live, `
    function pad() { return 1; }
    function tail(v) { if (v > 0) { return v; } return -v; }
  `);

  const scratch = scratchFrom(live);
  const result = diffNewSource(scratch, `
    function pad() { let a = 1; let b = 2; let c = 3; return a + b + c; }
    function tail(v) { if (v > 0) { return v; } return -v; }
  `);

  assertEquals(unitByName(result, 'pad').verdict, 'changed');
  assertEquals(unitByName(result, 'tail').verdict, 'identical');
});

Deno.test('differ never touches the live vat', () => {
  const live = freshSession();
  parseAndRun(live, `function f(v) { return v + 1; } let r = f(1);`);

  const before = snapshotSession(live).vatBytes;
  const scratch = scratchFrom(live);
  diffNewSource(scratch, `function f(v) { return v + 2; }`);
  const after = snapshotSession(live).vatBytes;

  assertEquals(after.length, before.length);
  let firstDifference = -1;
  for (let i = 0; i < before.length; i++) {
    if (before[i] !== after[i]) { firstDifference = i; break; }
  }
  assertEquals(firstDifference, -1, `live vat byte changed at offset ${firstDifference}`);
});

Deno.test('verdicts stable across gc() on the scratch between parse and compare', () => {
  const source = `
    function big() { return ${BIG}n; }
    function fmt(v) { return 'value: ' + v; }
  `;
  const live = freshSession();
  parseAndRun(live, source);

  const scratch = scratchFrom(live);
  const boundary = scratch.mem.codeBlockInstructionCount();
  scratch.parse(source);

  // Compaction relocates strings and the parse-time bigints; the
  // collector forwards code operands (366cd3b + the table-derived
  // sets), so comparison results must not change.
  scratch.gc();

  const result = diffAppendedCode(scratch.mem, boundary);
  for (const unit of result.units) {
    assertEquals(unit.verdict, 'identical',
      `unit ${unit.name ?? unit.kind}: ${JSON.stringify(unit.causes)}`);
  }
});

Deno.test('parse failure: parseFailed result, appended code truncated', () => {
  const live = freshSession();
  parseAndRun(live, `function f() { return 1; }`);

  const scratch = scratchFrom(live);
  const boundary = scratch.mem.codeBlockInstructionCount();
  const result = diffNewSource(scratch, `function broken( {`);

  assert(result.parseFailed);
  assertEquals(result.boundary, boundary);
  assertEquals(scratch.mem.codeBlockInstructionCount(), boundary);
});

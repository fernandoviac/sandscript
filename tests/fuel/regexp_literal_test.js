/**
 * RegExp literal tests — lexical goal selection, LIT_REGEXP evaluation
 * through the statically imported regex engine, error surfaces, fuel
 * resumption, and GC safety of paused compiles.
 */
import { assert, assertEquals, assertThrows } from "https://deno.land/std@0.208.0/assert/mod.ts";
import { freshSession } from '../../src/host-owned-session.js';
import { parseAndRun } from './test-helpers.js';
import { GC_HEADER_SIZE, REGEXP } from '../../src/fuel/constants.js';
import { REGEX_PROGRAM } from '../../src/fuel/regex-engine-contract.js';

// session.get materializes RegExp values as the structured
// { kind, source, flags, lastIndex } snapshot. The compiled program is
// internal state: byte-identity assertions locate the descriptor through
// the debug heap walk (these tests keep exactly one RegExp per session).
function onlyRegExpProgram(session) {
  const descriptors = session.mem.enumerateHeapObjects()
    .filter((heapObject) => heapObject.type === 'regexp');
  assertEquals(descriptors.length, 1, 'exactly one RegExp descriptor on the heap');
  const dataAbsolute = session.mem.abs(descriptors[0].address + GC_HEADER_SIZE);
  const programData = session.mem.view.getUint32(
    dataAbsolute + REGEXP.PROGRAM_BUFFER, true);
  assert(programData !== 0, 'program pointer committed');
  const byteLength = session.mem.view.getUint32(session.mem.abs(programData), true);
  return Array.from(new Uint8Array(
    session.mem.memory.buffer,
    session.mem.abs(programData + 4),
    byteLength,
  ));
}

Deno.test('regexp literal: lexical goal separates regex from division', () => {
  const session = freshSession({ inlineSource: true });
  parseAndRun(session, `
    let r = /ab+c/gi;
    let q = 12 / 2;
    q /= 2;
    let s = (2 + 4) / 3;
    let inArray = [/a/, /b/g];
    let asArg = ((x) => x)(/z/i);
    let eqStart = /=x/;
    let classSlash = /[/]/;
    let escaped = /a\\/b/;
  `);
  assertEquals(session.get(0, 'q'), 3);
  assertEquals(session.get(0, 's'), 2);
  assertEquals(session.get(0, 'r'),
    { kind: 'regexp', source: 'ab+c', flags: 'gi', lastIndex: 0 });
  assertEquals(session.get(0, 'eqStart').source, '=x');
  assertEquals(session.get(0, 'classSlash').source, '[/]');
  assertEquals(session.get(0, 'escaped').source, 'a\\/b');
});

Deno.test('regexp literal: compiles a validated engine program at evaluation', () => {
  const session = freshSession({ inlineSource: true });
  parseAndRun(session, `let r = /a|bc*/;`);
  assertEquals(session.get(0, 'r').source, 'a|bc*');
  const program = onlyRegExpProgram(session);
  const magic = new DataView(new Uint8Array(program.slice(0, 4)).buffer).getUint32(0, true);
  assertEquals(magic, REGEX_PROGRAM.MAGIC);
});

Deno.test('regexp literal: flag validation at parse time', () => {
  const cases = [
    ['let a = /x/u;', "flag 'u' is not supported"],
    ['let b = /x/v;', "flag 'v' is not supported"],
    ['let c = /x/gg;', "Duplicate RegExp flag 'g'"],
    ['let d = /x/q;', "Invalid RegExp flag 'q'"],
    ['let e = /x;', 'Unterminated regular expression'],
  ];
  for (const [source, message] of cases) {
    const session = freshSession({ inlineSource: true });
    // session.parse wraps the parser's SyntaxError in a ParseError.
    assertThrows(() => session.parse(source), Error, message);
  }
});

Deno.test('regexp literal: pattern errors throw catchable SyntaxError at evaluation', () => {
  const session = freshSession({ inlineSource: true });
  parseAndRun(session, `
    let caught = '';
    try { let bad = /a{3,1}/; } catch (e) { caught = '' + e; }
  `);
  assertEquals(session.get(0, 'caught'), 'SyntaxError');
});

Deno.test('regexp literal: permanently excluded constructs fail loud', () => {
  const session = freshSession({ inlineSource: true });
  parseAndRun(session, `
    let backref = '';
    let lookahead = '';
    try { let a = /(a)\\1/; } catch (e) { backref = '' + e; }
    try { let b = /a(?=b)/; } catch (e) { lookahead = '' + e; }
    let alive = 'still running';
  `);
  // ERR_NOT_SUPPORTED surfaces on the TypeError prototype, matching the
  // delete/in/Math.random convention.
  assertEquals(session.get(0, 'backref'), 'TypeError');
  assertEquals(session.get(0, 'lookahead'), 'TypeError');
  assertEquals(session.get(0, 'alive'), 'still running');
});

Deno.test('regexp literal: tiny fuel grants compile identically', () => {
  const source = 'let r = /ab+c|x[0-9]{2,4}/gi; let done = 42;';
  const uninterrupted = freshSession({ inlineSource: true });
  parseAndRun(uninterrupted, source);
  const expected = onlyRegExpProgram(uninterrupted);

  const tiny = freshSession({ inlineSource: true });
  tiny.parse(source);
  let pauses = 0;
  for (let i = 0; i < 20000; i++) {
    tiny.mem.wasm.exports.run(1, 0);
    const condition = tiny.mem.getExitCondition(0);
    if (condition === 15) { tiny.gc(); continue; }
    if (condition === 2) { pauses++; continue; }
    break;
  }
  assertEquals(tiny.mem.getExitCondition(0), 1, 'tiny-fuel run completes');
  assert(pauses > 5, 'compile actually paused under tiny fuel');
  assertEquals(tiny.get(0, 'done'), 42);
  assertEquals(
    onlyRegExpProgram(tiny),
    expected,
    'resumed compile emits byte-identical program',
  );
});

Deno.test('regexp literal: paused compiles survive compacting GC', () => {
  const source = 'let r = /ab+c|x[0-9]{2,4}/gi; let done = 7;';
  const uninterrupted = freshSession({ inlineSource: true });
  parseAndRun(uninterrupted, source);
  const expected = onlyRegExpProgram(uninterrupted);

  const session = freshSession({ inlineSource: true });
  // Real string garbage so compaction moves the pattern string, plus heap
  // churn so the workspaces and program buffer relocate.
  for (let i = 0; i < 30; i++) {
    session.mem.internString(`garbage_pad_${i}_${'y'.repeat(40)}`);
  }
  session.parse(source);
  let pauses = 0;
  let collections = 0;
  for (let i = 0; i < 20000; i++) {
    session.mem.wasm.exports.run(1, 0);
    const condition = session.mem.getExitCondition(0);
    if (condition === 15) { session.gc(); collections++; continue; }
    if (condition === 2) {
      pauses++;
      session.gc();
      collections++;
      continue;
    }
    break;
  }
  assertEquals(session.mem.getExitCondition(0), 1, 'run completes');
  assert(pauses > 5 && collections > 5, 'paused and collected repeatedly');
  assertEquals(session.get(0, 'done'), 7);
  assertEquals(
    onlyRegExpProgram(session),
    expected,
    'compile resumed across relocation emits byte-identical program',
  );
});

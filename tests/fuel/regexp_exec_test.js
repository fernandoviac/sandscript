/**
 * RegExp exec/test tests — match results and metadata (index/input/groups,
 * d-flag indices), lastIndex commit semantics for g/y, Unicode-scalar
 * indices, subject coercion, detached calls, the fuelless-route rejection,
 * and fuel-pause/GC equivalence of resumable matches.
 */
import { assert, assertEquals } from "https://deno.land/std@0.208.0/assert/mod.ts";
import { freshSession } from '../../src/host-owned-session.js';
import { parseAndRun } from './test-helpers.js';

Deno.test('regexp exec: match array, captures, index, input', () => {
  const session = freshSession({ inlineSource: true });
  parseAndRun(session, `
    let m = /a(b+)(x)?/.exec('zzabbbc');
    let idx = m.index;
    let inp = m.input;
    let grp = m.groups;
    let miss = /a/.exec('nope');
    let isArr = Array.isArray(m);
    let mapped = m.map((v) => typeof v);
  `);
  assertEquals(session.get(0, 'm'), ['abbb', 'bbb', undefined]);
  assertEquals(session.get(0, 'idx'), 2);
  assertEquals(session.get(0, 'inp'), 'zzabbbc');
  assertEquals(session.get(0, 'grp'), undefined, 'no named captures → groups undefined');
  assertEquals(session.get(0, 'miss'), null);
  assertEquals(session.get(0, 'isArr'), true, 'match result is an ordinary array');
  assertEquals(session.get(0, 'mapped'), ['string', 'string', 'undefined']);
});

Deno.test('regexp exec: participating empty capture is "", unset is undefined', () => {
  const session = freshSession({ inlineSource: true });
  parseAndRun(session, `
    let m = /(a*)(b)?c/.exec('c');
    let types = [typeof m[1], typeof m[2]];
  `);
  assertEquals(session.get(0, 'm'), ['c', '', undefined]);
  assertEquals(session.get(0, 'types'), ['string', 'undefined']);
});

Deno.test('regexp test: boolean result, shares lastIndex semantics', () => {
  const session = freshSession({ inlineSource: true });
  parseAndRun(session, `
    let hit = /b+/.test('abc');
    let missVal = /q/.test('abc');
    let g = /o/g;
    let t1 = g.test('oo'); let l1 = g.lastIndex;
    let t2 = g.test('oo'); let l2 = g.lastIndex;
    let t3 = g.test('oo'); let l3 = g.lastIndex;
  `);
  assertEquals(session.get(0, 'hit'), true);
  assertEquals(session.get(0, 'missVal'), false);
  assertEquals(session.get(0, 't1'), true);
  assertEquals(session.get(0, 'l1'), 1);
  assertEquals(session.get(0, 't2'), true);
  assertEquals(session.get(0, 'l2'), 2);
  assertEquals(session.get(0, 't3'), false, 'exhausted global misses');
  assertEquals(session.get(0, 'l3'), 0, 'miss resets lastIndex');
});

Deno.test('regexp exec: global loop advances lastIndex, miss resets it', () => {
  const session = freshSession({ inlineSource: true });
  parseAndRun(session, `
    let g = /o/g;
    let s = 'foo boo';
    let indices = [];
    let m;
    while ((m = g.exec(s)) !== null) { indices.push(m.index); }
    let after = g.lastIndex;
    let over = /a/g; over.lastIndex = 99;
    let overMiss = over.exec('a');
    let overLi = over.lastIndex;
  `);
  assertEquals(session.get(0, 'indices'), [1, 2, 5, 6]);
  assertEquals(session.get(0, 'after'), 0);
  assertEquals(session.get(0, 'overMiss'), null, 'lastIndex past the end misses');
  assertEquals(session.get(0, 'overLi'), 0);
});

Deno.test('regexp exec: sticky anchors at lastIndex exactly', () => {
  const session = freshSession({ inlineSource: true });
  parseAndRun(session, `
    let y = /ab/y;
    let missAt0 = y.exec('zab');
    y.lastIndex = 1;
    let hitAt1 = y.exec('zab');
    let after = y.lastIndex;
    let nonG = /b/;
    nonG.lastIndex = 0;
    let plain = nonG.exec('abc');
    let plainLi = nonG.lastIndex;
  `);
  assertEquals(session.get(0, 'missAt0'), null);
  assertEquals(session.get(0, 'hitAt1'), ['ab']);
  assertEquals(session.get(0, 'after'), 3);
  assertEquals(session.get(0, 'plain'), ['b']);
  assertEquals(session.get(0, 'plainLi'), 0, 'non-g/y never mutates lastIndex');
});

Deno.test('regexp exec: zero-length matches follow JS lastIndex rules', () => {
  // exec itself never bumps past an empty match — the one-scalar
  // advancement rule belongs to the string-method loops (epic ruling).
  const session = freshSession({ inlineSource: true });
  parseAndRun(session, `
    let empty = /(?:)/g;
    let e1 = empty.exec('ab'); let l1 = empty.lastIndex;
    let e2 = empty.exec('ab'); let l2 = empty.lastIndex;
  `);
  assertEquals(session.get(0, 'e1'), ['']);
  assertEquals(session.get(0, 'l1'), 0);
  assertEquals(session.get(0, 'e2'), ['']);
  assertEquals(session.get(0, 'l2'), 0);
});

Deno.test('regexp exec: named captures populate groups', () => {
  const session = freshSession({ inlineSource: true });
  parseAndRun(session, `
    let m = /(?<year>\\d{4})-(?<month>\\d{2})/.exec('on 2026-08 ok');
    let year = m.groups.year;
    let month = m.groups.month;
    let unset = /(?<opt>x)?y/.exec('y');
    let optType = typeof unset.groups.opt;
  `);
  assertEquals(session.get(0, 'm'), ['2026-08', '2026', '08']);
  assertEquals(session.get(0, 'year'), '2026');
  assertEquals(session.get(0, 'month'), '08');
  assertEquals(session.get(0, 'optType'), 'undefined', 'unset named capture is undefined');
});

Deno.test('regexp exec: d flag produces scalar index pairs and indices.groups', () => {
  const session = freshSession({ inlineSource: true });
  parseAndRun(session, `
    let m = /(?<word>[a-z]+)-([0-9]+)/d.exec('xx abc-2026');
    let ind = m.indices;
    let full = ind[0];
    let byName = ind.groups.word;
    let noD = /a/.exec('a');
    let noInd = noD.indices;
  `);
  assertEquals(session.get(0, 'ind'), [[3, 11], [3, 6], [7, 11]]);
  assertEquals(session.get(0, 'full'), [3, 11]);
  assertEquals(session.get(0, 'byName'), [3, 6]);
  assertEquals(session.get(0, 'noInd'), undefined, 'no d flag → indices undefined');
});

Deno.test('regexp exec: indices count Unicode scalars, not bytes or UTF-16 units', () => {
  // Deliberate divergence from JS (which exposes UTF-16 code-unit
  // indices); the epic owns the scalar-unit ruling.
  const session = freshSession({ inlineSource: true });
  parseAndRun(session, `
    let g = /b/g;
    let m = g.exec('\u{1F600}\u{1F600}b');
    let idx = m.index;
    let li = g.lastIndex;
    let cap = /(\u{1F600}+)/.exec('a\u{1F600}\u{1F600}z');
  `);
  assertEquals(session.get(0, 'idx'), 2, 'two astral scalars precede the match');
  assertEquals(session.get(0, 'li'), 3);
  assertEquals(session.get(0, 'cap'), ['\u{1F600}\u{1F600}', '\u{1F600}\u{1F600}']);
});

Deno.test('regexp exec: subject coerces to string, absent subject is "undefined"', () => {
  const session = freshSession({ inlineSource: true });
  parseAndRun(session, `
    let num = /2/.test(422);
    let bool = /ru/.exec(true);
    let noArg = /und/.test();
    let nul = /nul/.test(null);
  `);
  assertEquals(session.get(0, 'num'), true);
  assertEquals(session.get(0, 'bool'), ['ru']);
  assertEquals(session.get(0, 'noArg'), true);
  assertEquals(session.get(0, 'nul'), true);
});

Deno.test('regexp exec: detached method keeps its bound receiver', () => {
  const session = freshSession({ inlineSource: true });
  parseAndRun(session, `
    let re = /ab/g;
    let f = re.exec;
    let m = f('zzab');
    let idx = m.index;
    let li = re.lastIndex;
  `);
  assertEquals(session.get(0, 'm'), ['ab']);
  assertEquals(session.get(0, 'idx'), 2);
  assertEquals(session.get(0, 'li'), 4, 'detached call still commits lastIndex');
});

Deno.test('regexp exec: call/apply routing fails loud, never silently', () => {
  // The fuel-resumable step runs inline in CALL/CALL_METHOD; the
  // fuelless dispatch path cannot pause, so it rejects instead of
  // returning undefined through the unknown-method fallback.
  const session = freshSession({ inlineSource: true });
  parseAndRun(session, `
    let re = /ab/;
    let viaCall;
    try { viaCall = re.exec.call(re, 'ab'); }
    catch (e) { viaCall = 'threw:' + (e instanceof TypeError); }
    let alive = 'still running';
  `);
  assertEquals(session.get(0, 'viaCall'), 'threw:true');
  assertEquals(session.get(0, 'alive'), 'still running');
});

Deno.test('regexp exec: metadata names stay undefined on plain arrays', () => {
  const session = freshSession({ inlineSource: true });
  parseAndRun(session, `
    let plain = [1, 2];
    let vals = [typeof plain.index, typeof plain.input, typeof plain.groups, typeof plain.indices];
  `);
  assertEquals(session.get(0, 'vals'), ['undefined', 'undefined', 'undefined', 'undefined']);
});

const FUEL_EQUIVALENCE_SOURCE = `
  let re = /(?<word>[a-z]+)-([0-9]{2,4})/dg;
  let s = 'xx abc-2026 yy zz-99 end \u{1F600}q-777';
  let r1 = re.exec(s); let l1 = re.lastIndex;
  let r2 = re.exec(s); let l2 = re.lastIndex;
  let r3 = re.exec(s); let l3 = re.lastIndex;
  let r4 = re.exec(s); let l4 = re.lastIndex;
  let i1 = r1.index; let w1 = r1.groups.word; let d1 = r1.indices;
  let i3 = r3.index; let w3 = r3.groups.word; let d3 = r3.indices;
  let done = 42;
`;
const FUEL_EQUIVALENCE_SLOTS = [
  'r1', 'l1', 'r2', 'l2', 'r3', 'l3', 'r4', 'l4',
  'i1', 'w1', 'd1', 'i3', 'w3', 'd3',
];

function expectedEquivalenceValues() {
  const session = freshSession({ inlineSource: true });
  parseAndRun(session, FUEL_EQUIVALENCE_SOURCE);
  const expected = {};
  for (const name of FUEL_EQUIVALENCE_SLOTS) expected[name] = session.get(0, name);
  return expected;
}

Deno.test('regexp exec: tiny fuel grants match identically', () => {
  const expected = expectedEquivalenceValues();

  const tiny = freshSession({ inlineSource: true });
  tiny.parse(FUEL_EQUIVALENCE_SOURCE);
  let pauses = 0;
  for (let i = 0; i < 200000; i++) {
    tiny.mem.wasm.exports.run(1, 0);
    const condition = tiny.mem.getExitCondition(0);
    if (condition === 15) { tiny.gc(); continue; }
    if (condition === 2) { pauses++; continue; }
    break;
  }
  assertEquals(tiny.mem.getExitCondition(0), 1, 'tiny-fuel run completes');
  assert(pauses > 50, 'matching actually paused under tiny fuel');
  assertEquals(tiny.get(0, 'done'), 42);
  for (const name of FUEL_EQUIVALENCE_SLOTS) {
    assertEquals(tiny.get(0, name), expected[name], `slot ${name}`);
  }
});

Deno.test('regexp exec: paused matches survive compacting GC', () => {
  const expected = expectedEquivalenceValues();

  const session = freshSession({ inlineSource: true });
  // Real string garbage so compaction moves the subject and pattern
  // strings, plus heap churn so the program buffer and continuation move.
  for (let i = 0; i < 30; i++) {
    session.mem.internString(`garbage_pad_${i}_${'y'.repeat(40)}`);
  }
  session.parse(FUEL_EQUIVALENCE_SOURCE);
  let pauses = 0;
  let collections = 0;
  for (let i = 0; i < 200000; i++) {
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
  assert(pauses > 50 && collections > 50, 'paused and collected repeatedly');
  for (const name of FUEL_EQUIVALENCE_SLOTS) {
    assertEquals(session.get(0, name), expected[name], `slot ${name}`);
  }
});

/**
 * RegExp string methods — match, matchAll, search, regexp split, and
 * regexp replace/replaceAll (string replacements, replacement tokens,
 * and replacement callbacks), including lastIndex commit rules,
 * empty-match scalar advancement, sticky probing, matchAll clone
 * isolation and laziness, callback staging (nested regex operations,
 * throwing callbacks), the fuelless call/apply rejection, and
 * uninterrupted / tiny-fuel / gc-every-pause equivalence.
 */

import { assert, assertEquals } from "https://deno.land/std@0.208.0/assert/mod.ts";
import { parseAndRun, parseAndSetup } from './test-helpers.js';
import { freshSession } from '../../src/host-owned-session.js';

Deno.test('regexp string methods: search returns scalar indices and preserves lastIndex', () => {
  const session = freshSession({ inlineSource: true });
  parseAndRun(session, String.raw`
    let hit = "abcdef".search(/cd/);
    let miss = "abcdef".search(/zz/);
    let scalar = "xé€y".search(/y/);
    let viaString = "aXb".search("Xb");
    let re = /b/g; re.lastIndex = 77;
    let ignored = "abc".search(re);
    let li = re.lastIndex;
    let anchoredMiss = "ab".search(/^b/);
  `);
  assertEquals(session.get(0, 'hit'), 2);
  assertEquals(session.get(0, 'miss'), -1);
  assertEquals(session.get(0, 'scalar'), 3, 'index counts Unicode scalars');
  assertEquals(session.get(0, 'viaString'), 1, 'string argument compiles');
  assertEquals(session.get(0, 'ignored'), 1, 'search ignores lastIndex');
  assertEquals(session.get(0, 'li'), 77, 'search preserves lastIndex');
  assertEquals(session.get(0, 'anchoredMiss'), -1);
});

Deno.test('regexp string methods: non-global match is exec on the receiver', () => {
  const session = freshSession({ inlineSource: true });
  parseAndRun(session, String.raw`
    let m = "zzabbbc".match(/a(b+)(x)?/);
    let parts = [m[0], m[1], m[2], m.index, m.input];
    let named = "john smith".match(/(?<first>\w+) (?<last>\w+)/);
    let groups = [named.groups.first, named.groups.last];
    let missing = "abc".match(/z/);
    let sticky = /\d/y; sticky.lastIndex = 1;
    let anchored = "a1b2".match(sticky);
    let stickyLi = sticky.lastIndex;
    let noArg = "ab".match();
    let noArgParts = [noArg[0], noArg.index];
  `);
  assertEquals(session.get(0, 'parts'), ['abbb', 'bbb', undefined, 2, 'zzabbbc']);
  assertEquals(session.get(0, 'groups'), ['john', 'smith']);
  assertEquals(session.get(0, 'missing'), null);
  assertEquals(session.get(0, 'anchored')[0], '1', 'sticky anchors at lastIndex');
  assertEquals(session.get(0, 'stickyLi'), 2, 'non-global match commits lastIndex per exec');
  assertEquals(session.get(0, 'noArgParts'), ['', 0], 'match() uses the empty pattern');
});

Deno.test('regexp string methods: global match collects all and resets lastIndex', () => {
  const session = freshSession({ inlineSource: true });
  parseAndRun(session, String.raw`
    let re = /\d/g; re.lastIndex = 3;
    let all = "a1b2c3".match(re);
    let li = re.lastIndex;
    let none = "abc".match(/\d/g);
    let empties = "ab".match(/(?:)/g);
    let scalars = "é€𝄞".match(/(?:)/g);
    let chars = "aé𝄞b".match(/./g);
    let anchored = "112a1".match(/1/gy);
  `);
  assertEquals(session.get(0, 'all'), ['1', '2', '3'], 'global match starts at 0');
  assertEquals(session.get(0, 'li'), 0, 'global match resets lastIndex');
  assertEquals(session.get(0, 'none'), null);
  assertEquals(session.get(0, 'empties'), ['', '', ''], 'empty matches advance one scalar');
  assertEquals(session.get(0, 'scalars'), ['', '', '', ''], 'scalar advancement across multibyte');
  assertEquals(session.get(0, 'chars'), ['a', 'é', '𝄞', 'b']);
  assertEquals(session.get(0, 'anchored'), ['1', '1'], 'sticky global stops at first gap');
});

Deno.test('regexp string methods: matchAll is a lazy iterator over a clone', () => {
  const session = freshSession({ inlineSource: true });
  parseAndRun(session, String.raw`
    let re = /(\w)(\d)/g;
    re.lastIndex = 2;
    let it = "a1b2c3".matchAll(re);
    re.lastIndex = 99; // mutating the original after the call has no effect
    let first = it.next();
    let firstParts = [first.done, first.value[0], first.value[1], first.value[2], first.value.index];
    let rest = [];
    for (const m of it) rest.push(m[0]);
    let exhausted = [it.next().done, it.next().value];
    let originalLi = re.lastIndex;
    let spread = [..."x7y8".matchAll(/\d/g)].length;
    let viaString = [];
    for (const m of "q9r9".matchAll("9")) viaString.push(m.index);
    let empties = [];
    for (const m of "ab".matchAll(/(?:)/g)) empties.push(m.index);
    let named = [...("k=v".matchAll(/(?<key>\w)=(?<val>\w)/g))][0].groups.key;
  `);
  assertEquals(session.get(0, 'firstParts'), [false, 'b2', 'b', '2', 2],
    'the clone starts at the captured lastIndex');
  assertEquals(session.get(0, 'rest'), ['c3'], 'iteration is over the clone, not the mutated original');
  assertEquals(session.get(0, 'exhausted'), [true, undefined]);
  assertEquals(session.get(0, 'originalLi'), 99, 'the original RegExp is never touched');
  assertEquals(session.get(0, 'spread'), 2);
  assertEquals(session.get(0, 'viaString'), [1, 3], 'string argument compiles with g');
  assertEquals(session.get(0, 'empties'), [0, 1, 2], 'empty matches advance one scalar');
  assertEquals(session.get(0, 'named'), 'k');
});

Deno.test('regexp string methods: matchAll requires a global RegExp', () => {
  const session = freshSession({ inlineSource: true });
  parseAndRun(session, String.raw`
    let message = null;
    try { "a".matchAll(/a/); } catch (e) { message = e.message; }
  `);
  assertEquals(session.get(0, 'message'), 'matchAll requires a global RegExp');
});

Deno.test('regexp string methods: split inserts captures and honors the limit', () => {
  const session = freshSession({ inlineSource: true });
  parseAndRun(session, String.raw`
    let basic = "a,b,,c".split(/,/);
    let captured = "a-b_c".split(/([-_])/);
    let unset = "a1b".split(/(x)|(\d)/);
    let limited = "a1b2c3d".split(/\d/, 2);
    let limitCaptures = "a-b_c".split(/([-_])/, 2);
    let limitZero = "abc".split(/b/, 0);
    let trailing = "ab".split(/b/);
    let emptyHit = "".split(/(?:)/);
    let emptyMiss = "".split(/x/);
    let everyScalar = "aé𝄞".split(/(?:)/);
    let atEnd = "ab".split(/$/);
    let re = /,/g; re.lastIndex = 55;
    let li0 = "a,b".split(re);
    let li = re.lastIndex;
    let sticky = "a1b2".split(/\d/y);
    let legacy = "a,b".split(",");
  `);
  assertEquals(session.get(0, 'basic'), ['a', 'b', '', 'c']);
  assertEquals(session.get(0, 'captured'), ['a', '-', 'b', '_', 'c']);
  assertEquals(session.get(0, 'unset'), ['a', undefined, '1', 'b'],
    'non-participating captures insert undefined');
  assertEquals(session.get(0, 'limited'), ['a', 'b']);
  assertEquals(session.get(0, 'limitCaptures'), ['a', '-'], 'the limit counts captures too');
  assertEquals(session.get(0, 'limitZero'), []);
  assertEquals(session.get(0, 'trailing'), ['a', ''], 'trailing empty segment is kept');
  assertEquals(session.get(0, 'emptyHit'), [], 'empty subject with a match splits to nothing');
  assertEquals(session.get(0, 'emptyMiss'), ['']);
  assertEquals(session.get(0, 'everyScalar'), ['a', 'é', '𝄞'], 'empty pattern splits between scalars');
  assertEquals(session.get(0, 'atEnd'), ['ab'], 'a match at the end of input never splits');
  assertEquals(session.get(0, 'li'), 55, 'split never touches lastIndex');
  assertEquals(session.get(0, 'sticky'), ['a', 'b', ''], 'sticky separators probe forward');
  assertEquals(session.get(0, 'legacy'), ['a', 'b'], 'string separators stay on the legacy path');
});

Deno.test('regexp string methods: replace expands replacement tokens', () => {
  const session = freshSession({ inlineSource: true });
  parseAndRun(session, String.raw`
    let single = "a1b2".replace(/\d/, "#");
    let all = "a1b2".replace(/\d/g, "#");
    let tokens = "ab".replace(/(a)(b)/, "[$2$1]$$&x");
    let named = "john smith".replace(/(?<first>\w+) (?<last>\w+)/, "$<last>, $<first>");
    let unknownName = "ab".replace(/(?<x>a)/, "<$<nope>>");
    let noNamesLiteral = "ab".replace(/a/, "$<x>");
    let unsetEmpty = "ab".replace(/(a)|(z)/, "[$2]");
    let invalidIndex = "ab".replace(/a/, "$5");
    let twoDigit = "abcdefghijkl".replace(/(a)(b)(c)(d)(e)(f)(g)(h)(i)(j)(k)/, "$10$11");
    let dollarTail = "a".replace(/a/, "x$");
  `);
  assertEquals(session.get(0, 'single'), 'a#b2');
  assertEquals(session.get(0, 'all'), 'a#b#');
  assertEquals(session.get(0, 'tokens'), '[ba]$&x');
  // The $-backtick (match prefix) token cannot ride in a template
  // literal; its SandScript source arrives via an ordinary quoted
  // string. JS: "xyx".replace(/y/, "$&$'$`") === "xyxxx".
  const around = freshSession({ inlineSource: true });
  parseAndRun(around,
    'let ampAround = "xyx".replace(/y/, "$&$\'$' + '\u0060");');
  assertEquals(around.get(0, 'ampAround'), 'xyxxx');
  assertEquals(session.get(0, 'named'), 'smith, john');
  assertEquals(session.get(0, 'unknownName'), '<>b', 'unknown names in a named pattern expand empty');
  assertEquals(session.get(0, 'noNamesLiteral'), '$<x>b', 'named token stays literal without named groups');
  assertEquals(session.get(0, 'unsetEmpty'), '[]b');
  assertEquals(session.get(0, 'invalidIndex'), '$5b', 'out-of-range indices stay literal');
  assertEquals(session.get(0, 'twoDigit'), 'jkl', 'two-digit capture references');
  assertEquals(session.get(0, 'dollarTail'), 'x$');
});

Deno.test('regexp string methods: replace lastIndex commits per exec rules', () => {
  const session = freshSession({ inlineSource: true });
  parseAndRun(session, String.raw`
    let g = /\d/g; g.lastIndex = 42;
    let gr = "a1b2".replace(g, "#");
    let gLi = g.lastIndex;
    let y = /\d/y; y.lastIndex = 1;
    let yr = "a1b2".replace(y, "#");
    let yLi = y.lastIndex;
    let yMissRe = /\d/y; yMissRe.lastIndex = 99;
    let yMiss = "a1b2".replace(yMissRe, "#");
    let yMissLi = yMissRe.lastIndex;
    let plain = /x/; // no g, no y: untouched
    let pr = "x".replace(plain, "!");
    let pLi = plain.lastIndex;
    let empties = "ab".replace(/(?:)/g, "-");
    let astral = "𝄞x".replace(/(?:)/g, ".");
  `);
  assertEquals(session.get(0, 'gr'), 'a#b#');
  assertEquals(session.get(0, 'gLi'), 0);
  assertEquals(session.get(0, 'yr'), 'a#b2');
  assertEquals(session.get(0, 'yLi'), 2);
  assertEquals(session.get(0, 'yMiss'), 'a1b2', 'sticky origin past the end misses');
  assertEquals(session.get(0, 'yMissLi'), 0);
  assertEquals(session.get(0, 'pr'), '!');
  assertEquals(session.get(0, 'pLi'), 0);
  assertEquals(session.get(0, 'empties'), '-a-b-');
  assertEquals(session.get(0, 'astral'), '.𝄞.x.', 'empty replacements advance whole scalars');
});

Deno.test('regexp string methods: replaceAll requires g and equals global replace', () => {
  const session = freshSession({ inlineSource: true });
  parseAndRun(session, String.raw`
    let message = null;
    try { "a".replaceAll(/a/, "x"); } catch (e) { message = e.message; }
    let viaAll = "a1b1".replaceAll(/1/g, "-");
    let viaReplace = "a1b1".replace(/1/g, "-");
    let legacy = "a.b".replaceAll(".", "!");
  `);
  assertEquals(session.get(0, 'message'), 'replaceAll requires a global RegExp');
  assertEquals(session.get(0, 'viaAll'), 'a-b-');
  assertEquals(session.get(0, 'viaReplace'), 'a-b-');
  assertEquals(session.get(0, 'legacy'), 'a!b', 'string patterns stay on the legacy path');
});

Deno.test('regexp string methods: replacement callbacks receive the spec arguments', () => {
  const session = freshSession({ inlineSource: true });
  parseAndRun(session, String.raw`
    let calls = [];
    let r1 = "a1b22c".replace(/(\d+)/g, (m, p1, off, s) => {
      calls.push([m, p1, off, s]);
      return "<" + m + ">";
    });
    let r2 = "john smith".replace(/(?<first>\w+) (?<last>\w+)/,
      (m, a, b, off, s, groups) => groups.last + " " + groups.first);
    let r3 = "v".replace(/v/, () => 42);
    let r4 = "aXa".replace(/a/g, (m, off) => "" + off);
    let unset = "ab".replace(/(a)|(z)/, (m, p1, p2) => (p2 === undefined) ? "U" : "D");
    let scalarOff = "é€x".replace(/x/, (m, off) => "" + off);
  `);
  assertEquals(session.get(0, 'calls'),
    [['1', '1', 1, 'a1b22c'], ['22', '22', 3, 'a1b22c']]);
  assertEquals(session.get(0, 'r1'), 'a<1>b<22>c');
  assertEquals(session.get(0, 'r2'), 'smith john');
  assertEquals(session.get(0, 'r3'), '42', 'callback results coerce with ToString');
  assertEquals(session.get(0, 'r4'), '0X2');
  assertEquals(session.get(0, 'unset'), 'Ub');
  assertEquals(session.get(0, 'scalarOff'), 'é€2', 'offsets count Unicode scalars');
});

Deno.test('regexp string methods: callbacks nest regex work and unwind cleanly on throw', () => {
  const session = freshSession({ inlineSource: true });
  parseAndRun(session, String.raw`
    let nested = "a1c3".replace(/\d/g, (m) => "b2".match(/\d/g)[0]);
    let thrown = null;
    try {
      "abc".replace(/b/g, (m) => { throw new Error("boom"); });
    } catch (e) { thrown = e.message; }
    // The throw unwound a staged replace frame; fresh regex operations
    // must find no stale paused state.
    let after = "x1y2".replace(/\d/g, (m) => "[" + m + "]");
    let afterSplit = "p,q".split(/,/);
  `);
  assertEquals(session.get(0, 'nested'), 'a2c2', 'nested regex operations inside callbacks');
  assertEquals(session.get(0, 'thrown'), 'boom');
  assertEquals(session.get(0, 'after'), 'x[1]y[2]');
  assertEquals(session.get(0, 'afterSplit'), ['p', 'q']);
});

Deno.test('regexp string methods: detached bound methods work; call/apply reject loudly', () => {
  const session = freshSession({ inlineSource: true });
  parseAndRun(session, String.raw`
    let detached = "a1b2".match;
    let viaDetached = detached(/\d/g);
    let callErr = null;
    try { "ab".match.call("ab", /a/); } catch (e) { callErr = e.name; }
  `);
  assertEquals(session.get(0, 'viaDetached'), ['1', '2'],
    'a detached bound method still carries its receiver');
  assert(session.get(0, 'callErr') !== null,
    'call/apply cannot route the fuel-resumable step and must fail loudly');
});

// ---------------------------------------------------------------------------
// Fuel-pause and GC-relocation equivalence across every string method.
// ---------------------------------------------------------------------------

const FUEL_EQUIVALENCE_SOURCE = String.raw`
  let s = "xx abc-2026 def-11 ghi-999 é€𝄞 tail";
  let out = [];
  out.push(s.search(/def-\d+/));
  out.push(s.match(/(\w+)-(\d+)/).index);
  out.push(s.match(/[a-z]+-\d+/g));
  out.push(s.split(/-|\s+/));
  out.push(s.split(/(\d+)/, 5));
  out.push(s.replace(/(\w+)-(\d+)/g, "[$2:$1]"));
  out.push(s.replace(/[aeiou]/g, (m, off) => m.toUpperCase() + off));
  out.push("aaa bbb".replace(/(a+)|(b+)/g, (m, a, b, off, str) => (a ? "A" + a.length : "B" + b.length) + ":" + off));
  let mm = [];
  for (const m of s.matchAll(/(\w+)-(\d+)/g)) mm.push([m[0], m[1], m[2], m.index]);
  out.push(mm);
  out.push("".split(/x/));
  out.push("aéb€c".match(/./g));
  let done = 1;
`;

const FUEL_EQUIVALENCE_SLOTS = ['out', 'done'];

function expectedEquivalenceValues() {
  const session = freshSession({ inlineSource: true });
  parseAndSetup(session, FUEL_EQUIVALENCE_SOURCE);
  const result = session.run(0, 100000000);
  assertEquals(result.status, 'done');
  const expected = {};
  for (const name of FUEL_EQUIVALENCE_SLOTS) {
    expected[name] = session.get(0, name);
  }
  return expected;
}

Deno.test('regexp string methods: tiny fuel grants produce identical results', () => {
  const expected = expectedEquivalenceValues();
  const tiny = freshSession({ inlineSource: true });
  parseAndSetup(tiny, FUEL_EQUIVALENCE_SOURCE);
  let pauses = 0;
  for (let i = 0; i < 500000; i++) {
    tiny.mem.wasm.exports.run(1, 0);
    const condition = tiny.mem.getExitCondition(0);
    if (condition === 15) { tiny.gc(); continue; }
    if (condition === 2) { pauses++; continue; }
    break;
  }
  assertEquals(tiny.mem.getExitCondition(0), 1, 'tiny-fuel run completes');
  assert(pauses > 100, 'the string methods actually paused under tiny fuel');
  for (const name of FUEL_EQUIVALENCE_SLOTS) {
    assertEquals(tiny.get(0, name), expected[name], `slot ${name}`);
  }
});

Deno.test('regexp string methods: paused operations survive gc on every pause', () => {
  const expected = expectedEquivalenceValues();
  const session = freshSession({ inlineSource: true });
  // Real string garbage so compaction moves the subject and pattern
  // strings, plus heap churn so buffers and continuations relocate.
  for (let i = 0; i < 30; i++) {
    session.mem.internString(`garbage_pad_${i}_${'y'.repeat(40)}`);
  }
  parseAndSetup(session, FUEL_EQUIVALENCE_SOURCE);
  let pauses = 0;
  let collections = 0;
  for (let i = 0; i < 500000; i++) {
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
  assert(pauses > 100 && collections > 100, 'paused and collected repeatedly');
  for (const name of FUEL_EQUIVALENCE_SLOTS) {
    assertEquals(session.get(0, name), expected[name], `slot ${name}`);
  }
});

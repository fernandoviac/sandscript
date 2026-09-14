/**
 * RegExp differential verification through the public session contract.
 *
 * Every case source here is simultaneously valid SandScript and valid
 * JavaScript. Each runs twice: through the public SandScript session
 * API (WASM engine) and through the host's own JavaScript engine
 * (new Function). Every named binding must agree exactly. Subjects in
 * the shared table stay below the astral plane so JavaScript's UTF-16
 * indices numerically equal SandScript's Unicode-scalar indices; the
 * intended divergences (scalar indices over astral subjects,
 * unsupported syntax) get their own explicit assertions below.
 *
 * Raw match results never bind a compared name directly: JavaScript
 * match arrays carry index/input/groups as OWN properties that deep
 * equality would see, while SandScript's readback returns plain
 * arrays. Sources spread whatever they want compared.
 *
 * The unsupported-syntax test doubles as the no-host-fallback proof:
 * lookbehind and backreferences work in every host JavaScript engine,
 * so the only way SandScript can reject them is by matching inside
 * its own engine.
 */
import { assertEquals } from "https://deno.land/std@0.208.0/assert/mod.ts";
import { freshSession } from '../../src/host-owned-session.js';
import { parseAndRun } from './test-helpers.js';

/**
 * Run `source` through a fresh SandScript session and through the host
 * JavaScript engine, then assert that every binding in `names` agrees.
 */
function differential(source, names) {
  const session = freshSession({ inlineSource: true });
  parseAndRun(session, source);
  const js = new Function(
    `${source}; return { ${names.join(', ')} };`)();
  for (const name of names) {
    assertEquals(session.get(0, name), js[name], `binding ${name}`);
  }
}

Deno.test('regexp differential: exec metadata, captures, and flags', () => {
  differential(String.raw`
    let m = /a(b+)(x)?/.exec('zzabbbc');
    let spread = [m[0], m[1], m[2], m.index, m.input, m.length];
    let named = /(?<yr>\d{4})-(?<mo>\d{2})/.exec('on 2026-08 ok');
    let namedGroups = [named.groups.yr, named.groups.mo, named.index];
    let d = /(a)(?<b>b)?/d.exec('xab');
    let dIndices = [d.indices[0], d.indices[1], d.indices[2], d.indices.groups.b];
    let ci = /AbC/i.test('xxabcxx');
    let dotAll = [/a.c/s.test('a\nc'), /a.c/.test('a\nc')];
    let multi = 'one\ntwo\nthree'.match(/^t\w+/gm);
    let miss = /q/.exec('abc');
  `, ['spread', 'namedGroups', 'dIndices', 'ci', 'dotAll', 'multi', 'miss']);
});

Deno.test('regexp differential: quantifiers, classes, alternation, anchors', () => {
  differential(String.raw`
    let greedy = /a.+b/.exec('xaXXbYYb')[0];
    let lazy = /a.+?b/.exec('xaXXbYYb')[0];
    let bounded = /\d{2,3}/.exec('a1234b')[0];
    let boundedLazy = /\d{2,3}?/.exec('a1234b')[0];
    let optional = ['color', 'colour'].map((w) => /colou?r/.test(w));
    let star = /zo*/.exec('zzz')[0];
    let classes = ['a-f0', '[x]', 'g_9'].map((s) => [
      /[a-f\d]+/.test(s), /[^a-f\d]/.test(s), /[\]\[]/.test(s),
    ]);
    let shorthand = /\w+\s\W\D\S/.exec('ab !zX')[0];
    let alts = ['cat', 'dog', 'cow'].map((s) => (/^(cat|dog)$/.exec(s) || ['miss'])[0]);
    let anchors = [/^ab/.test('abc'), /bc$/.test('abc'), /^abc$/.test('abc'), /^b/.test('abc')];
    let escaped = /a\.b\*c/.test('a.b*c');
    let escapedMiss = /a\.b/.test('aXb');
  `, ['greedy', 'lazy', 'bounded', 'boundedLazy', 'optional', 'star',
      'classes', 'shorthand', 'alts', 'anchors', 'escaped', 'escapedMiss']);
});

Deno.test('regexp differential: lastIndex protocol across g and y', () => {
  differential(String.raw`
    let g = /o/g;
    let s = 'foo boo';
    let seq = [];
    let m;
    while ((m = g.exec(s)) !== null) { seq.push([m[0], m.index, g.lastIndex]); }
    let afterMiss = g.lastIndex;
    let y = /ab/y;
    let yMiss0 = y.exec('zab');
    y.lastIndex = 1;
    let yHitRaw = y.exec('zab');
    let yHit = [yHitRaw[0], yHitRaw.index];
    let yAfter = y.lastIndex;
    let plain = /b/;
    plain.lastIndex = 7;
    let plainHitRaw = plain.exec('abc');
    let plainHit = [plainHitRaw[0], plainHitRaw.index];
    let plainLi = plain.lastIndex;
    let over = /a/g; over.lastIndex = 99;
    let overMiss = over.exec('a');
    let overLi = over.lastIndex;
  `, ['seq', 'afterMiss', 'yMiss0', 'yHit', 'yAfter',
      'plainHit', 'plainLi', 'overMiss', 'overLi']);
});

Deno.test('regexp differential: empty-match advancement everywhere', () => {
  differential(String.raw`
    let execIdx = [];
    let e = /x?/g;
    let m;
    let guard = 0;
    while ((m = e.exec('ab')) !== null && guard < 10) { execIdx.push(m.index); guard++; }
    let matchAll2 = 'aa'.match(/b?/g);
    let splitAll = 'abc'.split(/x?/);
    let replaced = 'ab'.replace(/x?/g, '-');
    let searchEmpty = 'ab'.search(/x?/);
  `, ['execIdx', 'matchAll2', 'splitAll', 'replaced', 'searchEmpty']);
});

Deno.test('regexp differential: the six string methods agree', () => {
  differential(String.raw`
    let s = 'xx abc-2026 def-11 ghi-999 tail';
    let m1raw = s.match(/([a-z]+)-(\d+)/);
    let m1 = [m1raw[0], m1raw[1], m1raw[2], m1raw.index, m1raw.input, m1raw.length];
    let mg = s.match(/[a-z]+-\d+/g);
    let mMiss = s.match(/zzz/);
    let mgMiss = s.match(/zzz/g);
    let all = [];
    for (const hit of s.matchAll(/([a-z]+)-(\d+)/g)) {
      all.push([hit[0], hit[1], hit[2], hit.index]);
    }
    let found = s.search(/def/);
    let foundMiss = s.search(/zzz/);
    let parts = s.split(/\s+/);
    let partsCaptured = s.split(/(-)/);
    let partsLimited = s.split(/\s+/, 2);
    let r1 = s.replace(/\d+/, '#');
    let rg = s.replace(/\d+/g, '#');
    let rTokens = 'john smith'.replace(/(?<first>\w+) (?<last>\w+)/, '$<last>, $<first> ($&)');
    let rDollar = 'a1'.replace(/\d/, '$$');
    let rAll = s.replaceAll(/\d+/g, 'N');
    let rCb = s.replace(/(\w+)-(\d+)/g, (whole, word, num, offset, input) =>
      '[' + num + ':' + word + ':' + offset + ':' + input.length + ']');
    let rCbNamed = 'a-1'.replace(/(?<w>\w)-(?<n>\d)/, (...args) => {
      const groups = args[args.length - 1];
      return groups.w + groups.n;
    });
  `, ['m1', 'mg', 'mMiss', 'mgMiss', 'all', 'found', 'foundMiss',
      'parts', 'partsCaptured', 'partsLimited', 'r1', 'rg', 'rTokens',
      'rDollar', 'rAll', 'rCb', 'rCbNamed']);
});

Deno.test('regexp differential: constructor forms and coercion', () => {
  differential(String.raw`
    let viaNew = new RegExp('a(b+)c', 'gi');
    let viaCall = RegExp('\\d+');
    let sources = [viaNew.source, viaNew.flags, viaCall.source];
    let hitRaw = viaNew.exec('xxABBBCyy');
    let hit = [hitRaw[0], hitRaw[1], hitRaw.index];
    let coercedRaw = 'a1b2'.match('\\d');
    let coerced = [coercedRaw[0], coercedRaw.index, coercedRaw.input];
    let searchStr = 'a1b2'.search('\\d');
    let splitStr = 'a1b2'.split('b');
    let empty = new RegExp('').source;
    let emptyTest = new RegExp('').test('anything');
  `, ['sources', 'hit', 'coerced', 'searchStr', 'splitStr', 'empty', 'emptyTest']);
});

Deno.test('regexp differential: BMP non-ASCII subjects agree exactly', () => {
  // é (2 UTF-8 bytes) and € (3 UTF-8 bytes) are single UTF-16 units in
  // JavaScript and single scalars in SandScript, so indices agree while
  // the engine's byte-offset conversion is genuinely exercised.
  differential(String.raw`
    let s = 'aébé€c';
    let idx = s.search(/€/);
    let m = /b./.exec(s);
    let hit = [m[0], m.index];
    let parts = s.split(/é/);
    let replaced = s.replace(/é/g, 'E');
    let scalars = s.split(/(?:)/);
  `, ['idx', 'hit', 'parts', 'replaced', 'scalars']);
});

Deno.test('regexp intended divergence: indices count Unicode scalars, not UTF-16 units', () => {
  // 𝄞 (U+1D11E) is one Unicode scalar but two UTF-16 code units. This
  // is the epic's documented, deliberate divergence from JavaScript:
  // every script-visible index is a scalar count.
  const source = String.raw`
    let s = 'x𝄞abc';
    let idx = s.search(/abc/);
    let m = /abc/.exec(s);
    let execIdx = m.index;
    let g = /b/g;
    g.exec(s);
    let li = g.lastIndex;
    let scalarSplit = s.split(/(?:)/).length;
  `;
  const session = freshSession({ inlineSource: true });
  parseAndRun(session, source);
  // SandScript: scalar indices — x=0, 𝄞=1, a=2, b=3, c=4.
  assertEquals(session.get(0, 'idx'), 2);
  assertEquals(session.get(0, 'execIdx'), 2);
  assertEquals(session.get(0, 'li'), 4);
  assertEquals(session.get(0, 'scalarSplit'), 5);
  // Host JavaScript: UTF-16 indices — the surrogate pair occupies
  // units 1-2, so everything after it lands one unit later, and the
  // empty split cleaves the pair. Asserting the divergence keeps this
  // test honest about WHY the values above are not JavaScript's.
  const js = new Function(`${source}; return { idx, execIdx, li, scalarSplit };`)();
  assertEquals(js.idx, 3);
  assertEquals(js.execIdx, 3);
  assertEquals(js.li, 5);
  assertEquals(js.scalarSplit, 6, 'JS splits the surrogate pair');
});

Deno.test('regexp intended divergence: unsupported syntax rejects, proving no host fallback', () => {
  // Each of these constructs works in every host JavaScript engine. If
  // any host-delegated matching path existed they would silently
  // succeed; the loud rejection proves matching happens only inside
  // the sandboxed WASM engine. Deliberate exclusions surface on the
  // TypeError prototype (the ERR_NOT_SUPPORTED convention, matching
  // delete/in/Math.random); malformed syntax stays SyntaxError.
  const rejected = [
    [String.raw`new RegExp('(a)\\1')`, 'TypeError'],       // backreference
    [String.raw`new RegExp('(?<=a)b')`, 'TypeError'],      // lookbehind
    [String.raw`new RegExp('(?<!a)b')`, 'TypeError'],      // negative lookbehind
    [String.raw`new RegExp('a\\p{L}', 'u')`, 'TypeError'], // u flag / property escapes
    [String.raw`new RegExp('a{3,1}')`, 'SyntaxError'],     // malformed bounds
  ];
  for (const [expr, expected] of rejected) {
    if (expected === 'TypeError') {
      // Sanity: the host accepts what SandScript deliberately excludes.
      new Function(`return ${expr};`)();
    }
    const session = freshSession({ inlineSource: true });
    parseAndRun(session, `
      let outcome = 'no throw';
      try { ${expr}; } catch (e) { outcome = '' + e; }
    `);
    assertEquals(session.get(0, 'outcome'), expected, expr);
  }
});

/**
 * RegExp constructor and property-surface tests — new/call construction,
 * cloning, runtime flag validation, source/flags/lastIndex and the flag
 * booleans, instanceof, string coercion, and fuel-pause equivalence of
 * constructor compiles.
 */
import { assert, assertEquals } from "https://deno.land/std@0.208.0/assert/mod.ts";
import { freshSession } from '../../src/host-owned-session.js';
import { parseAndRun } from './test-helpers.js';

Deno.test('regexp constructor: new and call forms build equivalent descriptors', () => {
  const session = freshSession({ inlineSource: true });
  parseAndRun(session, `
    let viaNew = new RegExp('ab+c', 'gi');
    let viaCall = RegExp('ab+c', 'gi');
    let lit = /ab+c/gi;
  `);
  const viaNew = session.get(0, 'viaNew');
  const viaCall = session.get(0, 'viaCall');
  const lit = session.get(0, 'lit');
  for (const value of [viaNew, viaCall, lit]) {
    assertEquals(value.kind, 'regexp');
    assertEquals(value.source, 'ab+c');
    assertEquals(value.flags, 'gi');
    assertEquals(value.lastIndex, 0);
  }
});

Deno.test('regexp constructor: zero-argument and undefined-pattern forms', () => {
  const session = freshSession({ inlineSource: true });
  parseAndRun(session, `
    let empty = new RegExp();
    let undef = new RegExp(undefined, 'g');
    let sources = [empty.source, undef.source];
    let flags = [empty.flags, undef.flags];
  `);
  // The stored pattern is empty; .source renders the JS-compatible "(?:)".
  assertEquals(session.get(0, 'sources'), ['(?:)', '(?:)']);
  assertEquals(session.get(0, 'flags'), ['', 'g']);
});

Deno.test('regexp constructor: clones a RegExp pattern with fresh state', () => {
  const session = freshSession({ inlineSource: true });
  parseAndRun(session, `
    let original = new RegExp('a[0-9]+', 'gi');
    original.lastIndex = 5;
    let clone = new RegExp(original);
    let reflagged = new RegExp(original, 'm');
    let facts = [
      clone.source, clone.flags, clone.lastIndex,
      reflagged.source, reflagged.flags,
    ];
  `);
  assertEquals(session.get(0, 'facts'), ['a[0-9]+', 'gi', 0, 'a[0-9]+', 'm']);
});

Deno.test('regexp constructor: runtime flag and pattern validation', () => {
  const session = freshSession({ inlineSource: true });
  parseAndRun(session, `
    let errs = [];
    try { new RegExp('a', 'gg'); } catch (e) { errs.push('' + e); }
    try { new RegExp('a', 'q'); } catch (e) { errs.push('' + e); }
    try { new RegExp('a', 'u'); } catch (e) { errs.push('' + e); }
    try { new RegExp('a', 'v'); } catch (e) { errs.push('' + e); }
    try { new RegExp('a{3,1}'); } catch (e) { errs.push('' + e); }
    try { new RegExp(5); } catch (e) { errs.push('' + e); }
    try { new RegExp('a', 5); } catch (e) { errs.push('' + e); }
    let alive = 'still running';
  `);
  assertEquals(session.get(0, 'errs'), [
    'SyntaxError',                                     // duplicate flag
    'SyntaxError',                                     // unknown flag
    'TypeError',                                       // u: deliberately unsupported
    'TypeError',                                       // v: deliberately unsupported
    'SyntaxError',                                     // pattern error
    'TypeError: RegExp pattern must be a string or RegExp',
    'TypeError: RegExp flags must be a string',
  ]);
  assertEquals(session.get(0, 'alive'), 'still running');
});

Deno.test('regexp properties: flag booleans, canonical flags order, source escaping', () => {
  const session = freshSession({ inlineSource: true });
  parseAndRun(session, `
    let r = new RegExp('x', 'ysimdg');
    let bools = [r.global, r.ignoreCase, r.multiline, r.dotAll, r.hasIndices, r.sticky];
    let plain = new RegExp('y');
    let plainBools = [plain.global, plain.sticky];
    let slash = new RegExp('a/b');
    let classSlash = /[/]/;
    let sources = [slash.source, classSlash.source];
    let strings = ['' + slash, '' + new RegExp('', 'g'), '' + /ab/gi];
    let unknown = r.unknownProperty;
  `);
  assertEquals(session.get(0, 'bools'), [true, true, true, true, true, true]);
  // JS canonical .flags order over the accepted set: d g i m s y.
  assertEquals(session.get(0, 'plainBools'), [false, false]);
  // Unescaped slashes escape in .source and toString (EscapeRegExpPattern);
  // author-written escapes are preserved as written.
  assertEquals(session.get(0, 'sources'), ['a\\/b', '[\\/]']);
  assertEquals(session.get(0, 'strings'), ['/a\\/b/', '/(?:)/g', '/ab/gi']);
  assertEquals(session.get(0, 'unknown'), undefined);
});

Deno.test('regexp properties: lastIndex reads, writes, and validation', () => {
  const session = freshSession({ inlineSource: true });
  parseAndRun(session, `
    let r = /a/g;
    let before = r.lastIndex;
    r.lastIndex = 12;
    let after = r.lastIndex;
    let assigned = (r.lastIndex = 3);
    let errs = [];
    try { r.lastIndex = -1; } catch (e) { errs.push('' + e); }
    try { r.lastIndex = 1.5; } catch (e) { errs.push('' + e); }
    try { r.lastIndex = 'x'; } catch (e) { errs.push('' + e); }
    try { r.source = 'nope'; } catch (e) { errs.push('' + e); }
    let final = r.lastIndex;
  `);
  assertEquals(session.get(0, 'before'), 0);
  assertEquals(session.get(0, 'after'), 12);
  assertEquals(session.get(0, 'assigned'), 3);
  assertEquals(session.get(0, 'errs'), [
    'RangeError: lastIndex must be a non-negative integer',
    'RangeError: lastIndex must be a non-negative integer',
    'TypeError: lastIndex must be a non-negative integer',
    'TypeError: Not an object',
  ]);
  assertEquals(session.get(0, 'final'), 3);
});

Deno.test('regexp values: instanceof, typeof, and reference identity', () => {
  const session = freshSession({ inlineSource: true });
  parseAndRun(session, `
    let r = new RegExp('a');
    let facts = [
      r instanceof RegExp,
      /b/ instanceof RegExp,
      ({}) instanceof RegExp,
      r instanceof Object,
      typeof r,
    ];
    let same = r === r;
    let different = new RegExp('a') === new RegExp('a');
  `);
  assertEquals(session.get(0, 'facts'), [true, true, false, true, 'object']);
  assertEquals(session.get(0, 'same'), true);
  assertEquals(session.get(0, 'different'), false);
});

Deno.test('regexp constructor: tiny fuel grants compile identically', () => {
  const source = `
    let r = new RegExp('ab+c|x[0-9]{2,4}', 'gi');
    let done = r.source + '|' + r.flags;
  `;
  const uninterrupted = freshSession({ inlineSource: true });
  parseAndRun(uninterrupted, source);
  const expected = uninterrupted.get(0, 'done');

  const tiny = freshSession({ inlineSource: true });
  tiny.parse(source);
  let pauses = 0;
  for (let i = 0; i < 20000; i++) {
    tiny.mem.wasm.exports.run(1, 0);
    const condition = tiny.mem.getExitCondition(0);
    if (condition === 15) { tiny.gc(); continue; }
    if (condition === 2) { pauses++; tiny.gc(); continue; }
    break;
  }
  assertEquals(tiny.mem.getExitCondition(0), 1, 'tiny-fuel run completes');
  assert(pauses > 5, 'constructor compile actually paused under tiny fuel');
  assertEquals(tiny.get(0, 'done'), expected);
  assertEquals(
    tiny.get(0, 'r'),
    uninterrupted.get(0, 'r'),
    'resumed constructor compile produces an identical descriptor',
  );
});

Deno.test('proof namespace type renumbering: Proof surface still resolves', () => {
  // TYPE_PROOF_NAMESPACE moved off the unregistered 0x2B that collided
  // with TYPE.REGEXP. Pin that both surfaces coexist in one program.
  const session = freshSession({ inlineSource: true });
  parseAndRun(session, `
    let r = /a/g;
    let regexpSource = r.source;
    let proofIsThere = typeof Proof;
    let proofProp = Proof.Term !== undefined;
  `);
  assertEquals(session.get(0, 'regexpSource'), 'a');
  assertEquals(session.get(0, 'proofIsThere'), 'object');
  assertEquals(session.get(0, 'proofProp'), true);
});

/**
 * ES2025 set-theoretic methods with Set-like arguments.
 *
 * A Set-like — any object with callable has()/keys() — drives the seven
 * methods through operation-specific native continuation frames:
 * intersection/difference/isSubsetOf/isDisjointFrom probe other.has(v)
 * per element of the receiver; union/symmetricDifference/isSupersetOf
 * drain other.keys()'s iterator. Plain Set arguments keep the native
 * fast path. The Set-like's numeric `size` is not consulted (it only
 * feeds the spec's internal strategy choices, never results).
 */

import { assertEquals } from "https://deno.land/std@0.208.0/assert/mod.ts";
import { parseAndSetup } from './test-helpers.js';
import { freshSession } from '../../src/host-owned-session.js';

function run(source) {
  const session = freshSession();
  parseAndSetup(session, source);
  const result = session.run(0, 50_000_000);
  if (result.status === 'error') {
    throw new Error(`Error: ${result.error.message}`);
  }
  return session;
}

const SETLIKE = `
    let setLike = {
      size: 2,
      has(v) { return v === 2 || v === 3; },
      keys() {
        let vals = [2, 3];
        let i = 0;
        return { next() { if (i >= vals.length) return { done: true }; let v = vals[i]; i = i + 1; return { value: v, done: false }; } };
      },
    };
`;

Deno.test("set-like: intersection", () => {
  const s = run(SETLIKE + `
    let out = new Set([1, 2, 3]).intersection(setLike);
    let size = out.size; let has2 = out.has(2); let has1 = out.has(1);
  `);
  assertEquals(s.get(0, 'size'), 2);
  assertEquals(s.get(0, 'has2'), true);
  assertEquals(s.get(0, 'has1'), false);
});

Deno.test("set-like: difference", () => {
  const s = run(SETLIKE + `
    let out = new Set([1, 2, 3]).difference(setLike);
    let size = out.size; let has1 = out.has(1);
  `);
  assertEquals(s.get(0, 'size'), 1);
  assertEquals(s.get(0, 'has1'), true);
});

Deno.test("set-like: union", () => {
  const s = run(SETLIKE + `
    let out = new Set([1, 2]).union(setLike);
    let size = out.size; let has1 = out.has(1); let has3 = out.has(3);
  `);
  assertEquals(s.get(0, 'size'), 3);
  assertEquals(s.get(0, 'has1'), true);
  assertEquals(s.get(0, 'has3'), true);
});

Deno.test("set-like: symmetricDifference", () => {
  const s = run(SETLIKE + `
    let out = new Set([1, 2]).symmetricDifference(setLike);
    let size = out.size; let has1 = out.has(1); let has2 = out.has(2); let has3 = out.has(3);
  `);
  assertEquals(s.get(0, 'size'), 2);
  assertEquals(s.get(0, 'has1'), true);
  assertEquals(s.get(0, 'has2'), false);
  assertEquals(s.get(0, 'has3'), true);
});

Deno.test("set-like: isSubsetOf both verdicts", () => {
  const s = run(SETLIKE + `
    let yes = new Set([2, 3]).isSubsetOf(setLike);
    let no = new Set([1, 2]).isSubsetOf(setLike);
  `);
  assertEquals(s.get(0, 'yes'), true);
  assertEquals(s.get(0, 'no'), false);
});

Deno.test("set-like: isSupersetOf both verdicts", () => {
  const s = run(SETLIKE + `
    let yes = new Set([1, 2, 3]).isSupersetOf(setLike);
    let no = new Set([1, 2]).isSupersetOf(setLike);
  `);
  assertEquals(s.get(0, 'yes'), true);
  assertEquals(s.get(0, 'no'), false);
});

Deno.test("set-like: isDisjointFrom both verdicts", () => {
  const s = run(SETLIKE + `
    let yes = new Set([7, 8]).isDisjointFrom(setLike);
    let no = new Set([3, 9]).isDisjointFrom(setLike);
  `);
  assertEquals(s.get(0, 'yes'), true);
  assertEquals(s.get(0, 'no'), false);
});

Deno.test("set-like: plain Set arguments keep the native fast path", () => {
  const s = run(`let size = new Set([1, 2]).union(new Set([2, 3])).size;`);
  assertEquals(s.get(0, 'size'), 3);
});

Deno.test("set-like: empty receiver completes without foreign calls", () => {
  const s = run(SETLIKE + `
    let interSize = new Set([]).intersection(setLike).size;
    let disjoint = new Set([]).isDisjointFrom(setLike);
  `);
  assertEquals(s.get(0, 'interSize'), 0);
  assertEquals(s.get(0, 'disjoint'), true);
});

Deno.test("set-like: missing has()/keys() throw catchable TypeErrors", () => {
  const s = run(`
    let noHas = { keys() { return {}; } };
    let noKeys = { has(v) { return true; } };
    let a = ""; let b = "";
    try { new Set([1]).intersection(noHas); } catch (e) { a = "threw"; }
    try { new Set([1]).union(noKeys); } catch (e) { b = "threw"; }
  `);
  assertEquals(s.get(0, 'a'), 'threw');
  assertEquals(s.get(0, 'b'), 'threw');
});

Deno.test("set-like: non-object argument throws catchably", () => {
  const s = run(`
    let r = "";
    try { new Set([1]).union(42); } catch (e) { r = "threw"; }
  `);
  assertEquals(s.get(0, 'r'), 'threw');
});

Deno.test("set-like: throw inside has() propagates catchably", () => {
  const s = run(`
    let bad = { has(v) { throw new Error("boom"); } };
    let r = "";
    try { new Set([1]).intersection(bad); } catch (e) { r = e.message; }
  `);
  assertEquals(s.get(0, 'r'), 'boom');
});

Deno.test("set-like: block-bodied has() (returns undefined) is a falsy verdict", () => {
  const s = run(`
    let quiet = { has(v) { let x = v; } };
    let out = new Set([1, 2]).difference(quiet);
    let size = out.size;
  `);
  assertEquals(s.get(0, 'size'), 2);
});

Deno.test("set-like: receiver with tombstones (deleted entries) iterates correctly", () => {
  const s = run(SETLIKE + `
    let base = new Set([1, 2, 3, 9]);
    base.delete(9);
    base.delete(1);
    let out = base.intersection(setLike);
    let size = out.size;
  `);
  assertEquals(s.get(0, 'size'), 2);
});

Deno.test("set-like: results survive gc", () => {
  const session = freshSession();
  parseAndSetup(session, SETLIKE + `
    let out = new Set([1, 2]).union(setLike);
    let waste = [];
    for (let i = 0; i < 100; i++) waste.push({ junk: [i] });
    waste = null;
  `);
  session.run(0, 50_000_000);
  session.gc();
  const parseResult = session.parse('let alive = out.size + (out.has(3) ? 100 : 0)');
  session.mem.setContextInstructionIndex(0, parseResult.startIndex);
  session.run(0, 10_000_000);
  assertEquals(session.get(0, 'alive'), 103);
});

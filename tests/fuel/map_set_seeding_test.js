/**
 * Map/Set constructor seeding from general iterables exercises
 * foreign-callable re-entry machinery.
 *
 * `new Map(iterable)` / `new Set(iterable)` with a non-Array object
 * argument resolve `iterable[Symbol.iterator]` (own or prototype), then
 * drive `iterator.next()` from a native continuation frame in the RETURN
 * handlers: phase 0 awaits the iterator object and resolves its `next`
 * method; phase 1 consumes `{ value, done }` steps and adds
 * entries until done. The plain-Array fast path is unchanged.
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

Deno.test("seeding: Set from a custom iterable", () => {
  const s = run(`
    let src = {
      [Symbol.iterator]() {
        let i = 0;
        return {
          next() {
            if (i >= 3) return { done: true };
            i = i + 1;
            return { value: i * 10, done: false };
          },
        };
      },
    };
    let set = new Set(src);
    let size = set.size;
    let has20 = set.has(20);
  `);
  assertEquals(s.get(0, 'size'), 3);
  assertEquals(s.get(0, 'has20'), true);
});

Deno.test("seeding: Map from a custom iterable of pairs", () => {
  const s = run(`
    let src = {
      [Symbol.iterator]() {
        let entries = [['a', 1], ['b', 2]];
        let i = 0;
        return {
          next() {
            if (i >= entries.length) return { done: true };
            let v = entries[i];
            i = i + 1;
            return { value: v, done: false };
          },
        };
      },
    };
    let m = new Map(src);
    let size = m.size; let va = m.get('a'); let vb = m.get('b');
  `);
  assertEquals(s.get(0, 'size'), 2);
  assertEquals(s.get(0, 'va'), 1);
  assertEquals(s.get(0, 'vb'), 2);
});

Deno.test("seeding: self-iterable object (Symbol.iterator returns this)", () => {
  const s = run(`
    let src = {
      i: 0,
      [Symbol.iterator]() { return this; },
      next() {
        if (this.i >= 2) return { done: true };
        this.i = this.i + 1;
        return { value: this.i, done: false };
      },
    };
    let set = new Set(src);
    let size = set.size; let has2 = set.has(2);
  `);
  assertEquals(s.get(0, 'size'), 2);
  assertEquals(s.get(0, 'has2'), true);
});

Deno.test("seeding: empty iterable gives an empty collection", () => {
  const s = run(`
    let src = {
      [Symbol.iterator]() {
        return { next() { return { done: true }; } };
      },
    };
    let size = new Set(src).size;
  `);
  assertEquals(s.get(0, 'size'), 0);
});

Deno.test("seeding: duplicate values dedupe in a Set", () => {
  const s = run(`
    let src = {
      [Symbol.iterator]() {
        let vals = [1, 2, 2, 1, 3];
        let i = 0;
        return {
          next() {
            if (i >= vals.length) return { done: true };
            let v = vals[i]; i = i + 1;
            return { value: v, done: false };
          },
        };
      },
    };
    let size = new Set(src).size;
  `);
  assertEquals(s.get(0, 'size'), 3);
});

Deno.test("seeding: array argument keeps the fast path", () => {
  const s = run(`let size = new Set([1, 2, 2, 3]).size;`);
  assertEquals(s.get(0, 'size'), 3);
});

Deno.test("seeding: result is usable immediately (chained forEach)", () => {
  const s = run(`
    let src = {
      [Symbol.iterator]() {
        let i = 0;
        return { next() { i = i + 1; return i > 4 ? { done: true } : { value: i, done: false }; } };
      },
    };
    let total = 0;
    new Set(src).forEach((v) => { total = total + v; });
  `);
  assertEquals(s.get(0, 'total'), 10);
});

Deno.test("seeding: non-iterable object throws catchable TypeError", () => {
  const s = run(`
    let r = "";
    try { let set = new Set({ a: 1 }); } catch (e) { r = "threw"; }
  `);
  assertEquals(s.get(0, 'r'), 'threw');
});

Deno.test("seeding: non-object iterator result throws catchably", () => {
  const s = run(`
    let src = { [Symbol.iterator]() { return { next() { return 5; } }; } };
    let r = "";
    try { let set = new Set(src); } catch (e) { r = "threw"; }
  `);
  assertEquals(s.get(0, 'r'), 'threw');
});

Deno.test("seeding: Map rejects non-pair step values catchably", () => {
  const s = run(`
    let src = {
      [Symbol.iterator]() {
        let i = 0;
        return { next() { i = i + 1; return i > 1 ? { done: true } : { value: 42, done: false }; } };
      },
    };
    let r = "";
    try { let m = new Map(src); } catch (e) { r = "threw"; }
  `);
  assertEquals(s.get(0, 'r'), 'threw');
});

Deno.test("seeding: throw inside Symbol.iterator propagates catchably", () => {
  const s = run(`
    let src = { [Symbol.iterator]() { throw new Error("boom"); } };
    let r = "";
    try { let set = new Set(src); } catch (e) { r = e.message; }
  `);
  assertEquals(s.get(0, 'r'), 'boom');
});

Deno.test("seeding: throw inside next() propagates catchably", () => {
  const s = run(`
    let src = {
      [Symbol.iterator]() {
        let i = 0;
        return {
          next() {
            i = i + 1;
            if (i === 2) throw new Error("mid-iteration");
            return { value: i, done: false };
          },
        };
      },
    };
    let r = "";
    try { let set = new Set(src); } catch (e) { r = e.message; }
  `);
  assertEquals(s.get(0, 'r'), 'mid-iteration');
});

Deno.test("seeding: larger iterable grows the collection across doublings", () => {
  const s = run(`
    let src = {
      [Symbol.iterator]() {
        let i = 0;
        return { next() { i = i + 1; return i > 50 ? { done: true } : { value: i, done: false }; } };
      },
    };
    let set = new Set(src);
    let size = set.size; let has50 = set.has(50); let has51 = set.has(51);
  `);
  assertEquals(s.get(0, 'size'), 50);
  assertEquals(s.get(0, 'has50'), true);
  assertEquals(s.get(0, 'has51'), false);
});

Deno.test("seeding: survives gc mid-session", () => {
  const session = freshSession();
  parseAndSetup(session, `
    let src = {
      [Symbol.iterator]() {
        let i = 0;
        return { next() { i = i + 1; return i > 5 ? { done: true } : { value: i, done: false }; } };
      },
    };
    let set = new Set(src);
    let waste = [];
    for (let i = 0; i < 100; i++) waste.push({ junk: [i] });
    waste = null;
  `);
  session.run(0, 50_000_000);
  session.gc();
  const parseResult = session.parse('let alive = set.size + (set.has(3) ? 100 : 0)');
  session.mem.setContextInstructionIndex(0, parseResult.startIndex);
  session.run(0, 10_000_000);
  assertEquals(session.get(0, 'alive'), 105);
});

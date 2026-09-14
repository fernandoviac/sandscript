/**
 * thisArg on iteration-method callbacks.
 *
 * A supplied thisArg rebinds the callback by cloning it: the clone's
 * captured scope is a fresh holder scope binding `this` = thisArg, and
 * its ARROW flag is set so every call site skips the this = undefined
 * binding — `this` resolves lexically through the holder. No
 * continuation code changed; reduce/reduceRight (arg2 = initial value)
 * and sort (no thisArg in spec) are excluded.
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

Deno.test("thisArg: Array.forEach", () => {
  const s = run(`
    let ctx = { mark: 'X' };
    let log = '';
    [1, 2].forEach(function (v) { log = log + this.mark + v; }, ctx);
  `);
  assertEquals(s.get(0, 'log'), 'X1X2');
});

Deno.test("thisArg: Array.map", () => {
  const s = run(`
    let ctx = { base: 10 };
    let out = [1, 2, 3].map(function (v) { return this.base + v; }, ctx);
    let r = out[0] * 100 + out[1] * 10 + out[2];
  `);
  assertEquals(s.get(0, 'r'), 1233);
});

Deno.test("thisArg: Array.filter / find / some / every", () => {
  const s = run(`
    let ctx = { min: 2 };
    let kept = [1, 2, 3].filter(function (v) { return v >= this.min; }, ctx).length;
    let found = [1, 2, 3].find(function (v) { return v === this.min; }, ctx);
    let someOver = [1, 2, 3].some(function (v) { return v > this.min; }, ctx);
    let allUnder = [1, 2, 3].every(function (v) { return v <= this.min; }, ctx);
  `);
  assertEquals(s.get(0, 'kept'), 2);
  assertEquals(s.get(0, 'found'), 2);
  assertEquals(s.get(0, 'someOver'), true);
  assertEquals(s.get(0, 'allUnder'), false);
});

Deno.test("thisArg: typed array forEach mutates the bound context", () => {
  const s = run(`
    let ctx = { total: 0 };
    new Uint8Array([1, 2, 3]).forEach(function (v) { this.total = this.total + v; }, ctx);
    let r = ctx.total;
  `);
  assertEquals(s.get(0, 'r'), 6);
});

Deno.test("thisArg: Set.forEach and Map.forEach", () => {
  const s = run(`
    let sumCtx = { sum: 0 };
    new Set([1, 2, 3]).forEach(function (v) { this.sum = this.sum + v; }, sumCtx);
    let keyCtx = { keys: '' };
    new Map([['a', 1], ['b', 2]]).forEach(function (v, k) { this.keys = this.keys + k; }, keyCtx);
    let r = sumCtx.sum; let keys = keyCtx.keys;
  `);
  assertEquals(s.get(0, 'r'), 6);
  assertEquals(s.get(0, 'keys'), 'ab');
});

Deno.test("thisArg: omitted keeps this = undefined", () => {
  const s = run(`
    let r = 0;
    [1].forEach(function (v) { r = (this === undefined) ? v : -1; });
  `);
  assertEquals(s.get(0, 'r'), 1);
});

Deno.test("thisArg: arrow callbacks keep their lexical this", () => {
  const s = run(`
    let ctx = { mark: 'X' };
    let r = 'unset';
    function outer() {
      [1].forEach((v) => { r = (this === undefined) ? 'lexical' : 'bound'; }, ctx);
    }
    outer();
  `);
  assertEquals(s.get(0, 'r'), 'lexical');
});

Deno.test("thisArg: reduce's second argument stays the initial value", () => {
  const s = run(`
    let r = [1, 2, 3].reduce(function (acc, v) { return acc + v; }, 100);
  `);
  assertEquals(s.get(0, 'r'), 106);
});

Deno.test("thisArg: primitive values bind too", () => {
  const s = run(`
    let r = 0;
    [1].forEach(function (v) { r = this + v; }, 41);
  `);
  assertEquals(s.get(0, 'r'), 42);
});

Deno.test("thisArg: the original callback is not mutated", () => {
  const s = run(`
    let ctx = { n: 5 };
    function cb(v) { return (this === undefined) ? v : this.n + v; }
    let withCtx = [1].map(cb, ctx)[0];
    let without = [1].map(cb)[0];
    let r = withCtx * 10 + without;
  `);
  assertEquals(s.get(0, 'r'), 61);
});

Deno.test("thisArg: survives across iterations and gc", () => {
  const session = freshSession();
  parseAndSetup(session, `
    let ctx = { total: 0 };
    let big = [];
    for (let i = 0; i < 50; i++) big.push(i);
    big.forEach(function (v) { this.total = this.total + v; }, ctx);
    let waste = [];
    for (let i = 0; i < 100; i++) waste.push({ junk: [i] });
    waste = null;
  `);
  session.run(0, 50_000_000);
  session.gc();
  const parseResult = session.parse('let after = ctx.total');
  session.mem.setContextInstructionIndex(0, parseResult.startIndex);
  session.run(0, 10_000_000);
  assertEquals(session.get(0, 'after'), 1225);
});

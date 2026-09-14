/**
 * 2026-07-05 builtins batch: reduceRight (plain arrays + the typed
 * direction fix), Array.of, Object.fromEntries, Number.prototype
 * toFixed/toString(radix), typed-array .at — plus the array_join
 * float-element corruption fix the batch surfaced.
 */

import { assertEquals } from "https://deno.land/std@0.208.0/assert/mod.ts";
import { parseAndSetup } from './test-helpers.js';
import { freshSession } from '../../src/host-owned-session.js';

function run(source) {
  const session = freshSession();
  parseAndSetup(session, source);
  const result = session.run(0, 20_000_000);
  if (result.status === 'error') {
    throw new Error(`Error: ${result.error.message}`);
  }
  return session;
}

Deno.test("reduceRight: folds right-to-left on plain arrays", () => {
  const s = run(`
    let noInit = [1, 2, 3].reduceRight(function (a, b) { return a - b; });
    let withInit = ['a', 'b', 'c'].reduceRight(function (a, b) { return a + b; }, 'z');
    let r = noInit + "|" + withInit;
  `);
  assertEquals(s.get(0, 'r'), '0|zcba');
});

Deno.test("reduceRight: indexes descend; edge cases match reduce's", () => {
  const s = run(`
    let idx = [];
    [5, 6, 7].reduceRight(function (a, b, i) { idx.push(i); return a; }, 0);
    let single = [42].reduceRight(function (a, b) { return -1; });
    let emptyInit = [].reduceRight(function (a) { return a; }, 'init');
    let threw = "";
    try { [].reduceRight(function (a) { return a; }); } catch (e) { threw = "threw"; }
    let r = idx.join(",") + "|" + single + "|" + emptyInit + "|" + threw;
  `);
  assertEquals(s.get(0, 'r'), '2,1,0|42|init|threw');
});

Deno.test("reduceRight: typed arrays fold right-to-left (direction was inverted)", () => {
  const s = run(`
    let order = new Int32Array([1, 2, 3]).reduceRight(function (a, b) { return a - b; });
    let idx = [];
    new Int32Array([5, 5, 5]).reduceRight(function (a, b, i) { idx.push(i); return a; }, 0);
    let ascendingStill = new Int32Array([1, 2, 3]).reduce(function (a, b) { return a - b; });
    let r = order + "|" + idx.join(",") + "|" + ascendingStill;
  `);
  assertEquals(s.get(0, 'r'), '0|2,1,0|-4');
});

Deno.test("Array.of: arguments become elements", () => {
  const s = run(`
    let r = JSON.stringify(Array.of(1, 'x', [2])) + "|" + Array.of().length + "|" + Array.of(5).length;
  `);
  assertEquals(s.get(0, 'r'), '[1,"x",[2]]|0|1');
});

Deno.test("Object.fromEntries: pair arrays, Maps, iterables; loud non-entries", () => {
  const s = run(`
    let fromPairs = JSON.stringify(Object.fromEntries([['a', 1], ['b', 2]]));
    let fromMap = JSON.stringify(Object.fromEntries(new Map([['k', 9]])));
    let numericKey = JSON.stringify(Object.fromEntries([[1, 'one']]));
    let empty = JSON.stringify(Object.fromEntries([]));
    let nullThrew = ""; try { Object.fromEntries(null); } catch (e) { nullThrew = "threw"; }
    let badThrew = ""; try { Object.fromEntries([1]); } catch (e) { badThrew = "threw"; }
    let r = fromPairs + "|" + fromMap + "|" + numericKey + "|" + empty + "|" + nullThrew + "|" + badThrew;
  `);
  assertEquals(s.get(0, 'r'), '{"a":1,"b":2}|{"k":9}|{"1":"one"}|{}|threw|threw');
});

Deno.test("Number.toString: radix 2-36, default 10, RangeError outside", () => {
  const s = run(`
    let hex = (255).toString(16);
    let bin = (255).toString(2);
    let frac = (3.5).toString(2);
    let neg = (-42).toString(36);
    let plain = (42).toString();
    let threw = ""; try { (5).toString(99); } catch (e) { threw = "threw"; }
    let r = hex + "|" + bin + "|" + frac + "|" + neg + "|" + plain + "|" + threw;
  `);
  assertEquals(s.get(0, 'r'), 'ff|11111111|11.1|-16|42|threw');
});

Deno.test("Number.toFixed: rounding, signs, zeros, RangeError outside 0-100", () => {
  const s = run(`
    let a = (1.5).toFixed(2);
    let b = (0).toFixed(2);
    let c = (-1.567).toFixed(1);
    let d = (1234.5678).toFixed(0);
    let e = (-0.004).toFixed(2);
    let f = (0.5).toFixed(0);
    let threw = ""; try { (5).toFixed(-1); } catch (err) { threw = "threw"; }
    let r = [a, b, c, d, e, f, threw].join("|");
  `);
  assertEquals(s.get(0, 'r'), '1.50|0.00|-1.6|1235|-0.00|1|threw');
});

Deno.test("Number properties: unknown keys read undefined", () => {
  const s = run(`let r = String((5).unknownProp) + "|" + String((1.5).x);`);
  assertEquals(s.get(0, 'r'), 'undefined|undefined');
});

Deno.test("typed .at: negative wraps, out-of-range undefined, BigInt elements", () => {
  const s = run(`
    let last = new Int32Array([10, 20, 30]).at(-1);
    let first = new Uint8Array([7, 8]).at(0);
    let oob = String(new Uint8Array([7, 8]).at(5));
    let big = new BigInt64Array([5n, -6n]).at(-1);
    let r = last + "|" + first + "|" + oob + "|" + (big === -6n);
  `);
  assertEquals(s.get(0, 'r'), '30|7|undefined|true');
});

Deno.test("join: float elements render correctly (heap-tail corruption fix)", () => {
  const s = run(`
    let a = [2.0, 1, 0].join(",");
    let pushed = []; pushed.push(2.5); pushed.push(1);
    let b = pushed.join(",");
    let c = String([1.5, "x", 2.25]);
    let r = a + "|" + b + "|" + c;
  `);
  assertEquals(s.get(0, 'r'), '2,1,0|2.5,1|1.5,x,2.25');
});

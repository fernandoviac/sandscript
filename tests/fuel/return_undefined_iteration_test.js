/**
 * OP_RETURN_UNDEFINED iteration continuations: block-bodied callbacks
 * with no explicit return.
 *
 * The RETURN_UNDEFINED handler used to route every iterating frame
 * (except sort and Map/Set forEach) into the generic forEach-style
 * walk: no per-method result processing, wrong callback arguments for
 * reduce (acc bound to the element), and an unconditional undefined
 * push on completion. So `[1,2].findIndex(x => {})` returned undefined
 * instead of -1, `.map(x => {})` returned undefined instead of an
 * array, `.every(x => {})` returned undefined instead of false, etc.
 * Same failure shape the typed-parity work fixed for sort comparators
 * (7e53d06) — these tests pin the fix for the rest of the callback
 * methods, both kinds.
 *
 * Callbacks that return SOMETIMES (mixed RETURN / RETURN_UNDEFINED
 * paths in one walk) are covered at the bottom — every method must
 * agree between the two cascades.
 *
 * Run with: deno task test tests/fuel/return_undefined_iteration_test.js
 */

import { assertEquals } from 'https://deno.land/std@0.208.0/assert/mod.ts';
import { parseAndSetup } from './test-helpers.js';
import { freshSession } from '../../src/host-owned-session.js';

function assertResult(source, varName, expected) {
  const session = freshSession();
  parseAndSetup(session, source);
  const result = session.run(0, 10_000_000);
  assertEquals(result.status, 'done',
    `expected status=done, got ${result.status} (${result.error?.message})`);
  assertEquals(session.get(0, varName), expected);
}

// =============================================================================
// Plain arrays, callback never returns
// =============================================================================

Deno.test("map: block-bodied callback fills the result with undefined", () => {
  assertResult(
    'let m = [1,2].map(x => { let y = x; }); let r = m.length === 2 && m[0] === undefined && m[1] === undefined',
    'r', true);
});

Deno.test("filter: block-bodied callback returns an empty array", () => {
  assertResult('let f = [1,2].filter(x => { let y = x; }); let r = f.length', 'r', 0);
});

Deno.test("find: block-bodied callback returns undefined", () => {
  assertResult('let r = [1,2].find(x => { let y = x; })', 'r', undefined);
});

Deno.test("findIndex: block-bodied callback returns -1", () => {
  assertResult('let r = [1,2].findIndex(x => { let y = x; })', 'r', -1);
});

Deno.test("some: block-bodied callback returns false", () => {
  assertResult('let r = [1,2].some(x => { let y = x; })', 'r', false);
});

Deno.test("every: block-bodied callback returns false (falsy exits the chain)", () => {
  assertResult('let r = [1,2].every(x => { let y = x; })', 'r', false);
});

Deno.test("every: block-bodied callback exits on the FIRST element", () => {
  assertResult(
    'let log = []; [1,2,3].every(x => { log.push(x); }); let r = log.join(",")',
    'r', '1');
});

Deno.test("reduce: block-bodied callback threads undefined as the accumulator", () => {
  assertResult(
    'let log = []; [1,2,3].reduce((acc, x) => { log.push(typeof acc + ":" + x); }, 9); let r = log.join(",")',
    'r', 'number:1,undefined:2,undefined:3');
});

Deno.test("reduce: block-bodied callback returns undefined overall", () => {
  assertResult(
    'let x0 = [1,2,3].reduce((acc, x) => { let y = x; }, 9); let r = typeof x0',
    'r', 'undefined');
});

Deno.test("reduceRight: block-bodied callback threads undefined descending", () => {
  assertResult(
    'let log = []; [1,2,3].reduceRight((acc, x) => { log.push(typeof acc + ":" + x); }, 9); let r = log.join(",")',
    'r', 'number:3,undefined:2,undefined:1');
});

Deno.test("flatMap: block-bodied callback appends undefined per element", () => {
  assertResult(
    'let m = [1,2].flatMap(x => { let y = x; }); let r = m.length === 2 && m[0] === undefined',
    'r', true);
});

// =============================================================================
// Typed arrays, callback never returns
// =============================================================================

Deno.test("typed map: block-bodied callback writes 0 per element", () => {
  assertResult(
    'let b = new Uint8Array(2); b[0] = 7; b[1] = 8; let m = b.map(x => { let y = x; }); ' +
    'let r = m.length === 2 && m[0] === 0 && m[1] === 0',
    'r', true);
});

Deno.test("typed filter: block-bodied callback returns an empty typed array", () => {
  assertResult(
    'let b = new Uint8Array(2); let f = b.filter(x => { let y = x; }); let r = f.length',
    'r', 0);
});

Deno.test("typed find: block-bodied callback returns undefined", () => {
  assertResult('let b = new Uint8Array(2); let r = b.find(x => { let y = x; })', 'r', undefined);
});

Deno.test("typed findIndex: block-bodied callback returns -1", () => {
  assertResult('let b = new Uint8Array(2); let r = b.findIndex(x => { let y = x; })', 'r', -1);
});

Deno.test("typed some: block-bodied callback returns false", () => {
  assertResult('let b = new Uint8Array(2); let r = b.some(x => { let y = x; })', 'r', false);
});

Deno.test("typed every: block-bodied callback returns false", () => {
  assertResult('let b = new Uint8Array(2); let r = b.every(x => { let y = x; })', 'r', false);
});

Deno.test("typed reduce: block-bodied callback threads undefined as the accumulator", () => {
  assertResult(
    'let b = new Uint8Array(3); b[0] = 1; b[1] = 2; b[2] = 3; let log = []; ' +
    'b.reduce((acc, x) => { log.push(typeof acc + ":" + x); }, 9); let r = log.join(",")',
    'r', 'number:1,undefined:2,undefined:3');
});

Deno.test("typed reduceRight: block-bodied callback returns undefined overall", () => {
  assertResult(
    'let b = new Uint8Array(3); let x0 = b.reduceRight((acc, x) => { let y = x; }, 9); let r = typeof x0',
    'r', 'undefined');
});

// =============================================================================
// Mixed paths: the callback returns on some elements only, so one walk
// exercises BOTH the RETURN and RETURN_UNDEFINED continuations.
// =============================================================================

Deno.test("map: mixed return/no-return produces holes only where absent", () => {
  assertResult(
    'let m = [1,2,3,4].map(x => { if (x % 2 === 0) return x * 10; }); ' +
    'let r = (m[0] === undefined) + ":" + m[1] + ":" + (m[2] === undefined) + ":" + m[3]',
    'r', 'true:20:true:40');
});

Deno.test("filter: mixed return keeps only truthy-returning elements", () => {
  assertResult(
    'let f = [1,2,3,4].filter(x => { if (x % 2 === 0) return true; }); let r = f.join(",")',
    'r', '2,4');
});

Deno.test("find: mixed return finds the first explicit truthy", () => {
  assertResult('let r = [1,2,3].find(x => { if (x === 2) return true; })', 'r', 2);
});

Deno.test("findLast: mixed return finds the last explicit truthy", () => {
  assertResult('let r = [2,1,2,3].findLast(x => { if (x === 2) return true; })', 'r', 2);
});

Deno.test("findLastIndex: mixed return finds the last explicit truthy index", () => {
  assertResult('let r = [2,1,2,3].findLastIndex(x => { if (x === 2) return true; })', 'r', 2);
});

Deno.test("some: mixed return true on a late element", () => {
  assertResult('let r = [1,2,3].some(x => { if (x === 3) return true; })', 'r', true);
});

Deno.test("every: truthy returns then a no-return element breaks the chain", () => {
  assertResult(
    'let log = []; let e = [1,2,0,4].every(x => { log.push(x); if (x !== 0) return true; }); ' +
    'let r = e + ":" + log.join(",")',
    'r', 'false:1,2,0');
});

Deno.test("reduce: mixed return alternates accumulator between value and undefined", () => {
  assertResult(
    'let log = []; [1,2,3].reduce((acc, x) => { log.push(typeof acc); if (x === 2) return "v"; }, 9); ' +
    'let r = log.join(",")',
    'r', 'number,undefined,string');
});

Deno.test("typed map: mixed return writes value or 0", () => {
  assertResult(
    'let b = new Uint8Array(3); b[0] = 1; b[1] = 2; b[2] = 3; ' +
    'let m = b.map(x => { if (x === 2) return 50; }); ' +
    'let r = m[0] + ":" + m[1] + ":" + m[2]',
    'r', '0:50:0');
});

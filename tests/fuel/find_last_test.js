/**
 * Array.prototype.findLast / findLastIndex and their typed-array mirrors.
 *
 * The findLast family shares $find_like_method with find/findIndex/
 * some/every but walks DESCENDING: the iteration frame starts at
 * len-1 and both RETURN continuations decrement the index (the shared
 * unsigned `index < len` check completes the walk when the index
 * wraps at -1 — the reduceRight trick). Defaults: findLast →
 * undefined, findLastIndex → -1.
 *
 * Run with: deno task test tests/fuel/find_last_test.js
 */

import { assert, assertEquals } from 'https://deno.land/std@0.208.0/assert/mod.ts';
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
// Plain arrays
// =============================================================================

Deno.test("findLast: is a function", () => {
  assertResult('let r = typeof [].findLast', 'r', 'function');
});

Deno.test("findLastIndex: is a function", () => {
  assertResult('let r = typeof [].findLastIndex', 'r', 'function');
});

Deno.test("findLast: returns the LAST match, not the first", () => {
  assertResult('let r = [1,2,3,4].findLast(x => x < 3)', 'r', 2);
});

Deno.test("findLastIndex: returns the LAST matching index", () => {
  assertResult('let r = [5,1,5,2].findLastIndex(x => x === 5)', 'r', 2);
});

Deno.test("findLast: no match returns undefined", () => {
  assertResult('let r = [1,2].findLast(x => x > 9)', 'r', undefined);
});

Deno.test("findLastIndex: no match returns -1", () => {
  assertResult('let r = [1,2].findLastIndex(x => x > 9)', 'r', -1);
});

Deno.test("findLast: empty array returns undefined", () => {
  assertResult('let r = [].findLast(x => true)', 'r', undefined);
});

Deno.test("findLastIndex: empty array returns -1", () => {
  assertResult('let r = [].findLastIndex(x => true)', 'r', -1);
});

Deno.test("findLast: walks descending (side-effect order)", () => {
  assertResult(
    'let log = []; [10,20,30].findLast(x => { log.push(x); return false; }); let r = log.join(",")',
    'r', '30,20,10');
});

Deno.test("findLast: index argument counts down from len-1", () => {
  assertResult(
    'let log = []; [10,20,30].findLast((x, i) => { log.push(i); return false; }); let r = log.join(",")',
    'r', '2,1,0');
});

Deno.test("findLast: stops at the first (from the end) match", () => {
  assertResult(
    'let log = []; [1,2,3,4].findLast(x => { log.push(x); return x % 2 === 0; }); let r = log.join(",")',
    'r', '4');
});

Deno.test("findLast: receives the array as third argument", () => {
  assertResult('let r = [10,20].findLast((x, i, a) => x === 10 && a.length === 2)', 'r', 10);
});

Deno.test("findLast: single element", () => {
  assertResult('let r = [7].findLast(x => x === 7)', 'r', 7);
});

Deno.test("findLast: thisArg rebinds this in a function callback", () => {
  assertResult(
    'let o = { limit: 25 }; let r = [10,20,30].findLast(function(x) { return x < this.limit; }, o)',
    'r', 20);
});

Deno.test("findLast: block-bodied callback with no return finds nothing", () => {
  assertResult('let r = [1,2].findLast(x => { let y = x; })', 'r', undefined);
});

Deno.test("findLastIndex: block-bodied callback with no return returns -1", () => {
  assertResult('let r = [1,2].findLastIndex(x => { let y = x; })', 'r', -1);
});

Deno.test("findLast: non-function callback throws TypeError", () => {
  const session = freshSession();
  parseAndSetup(session, 'let r = [1,2].findLast(5)');
  let thrown = null;
  try {
    session.run(0, 10_000_000);
  } catch (e) {
    thrown = e;
  }
  assert(thrown !== null, 'expected the run to throw');
  assert(thrown.message.includes('Not a function'),
    `expected Not a function, got: ${thrown.message}`);
});

// =============================================================================
// Typed arrays
// =============================================================================

Deno.test("typed findLast: is a function", () => {
  assertResult('let b = new Uint8Array(2); let r = typeof b.findLast', 'r', 'function');
});

Deno.test("typed findLast: returns the LAST match", () => {
  assertResult(
    'let b = new Uint8Array(4); b[0] = 1; b[1] = 2; b[2] = 3; b[3] = 4; let r = b.findLast(x => x < 3)',
    'r', 2);
});

Deno.test("typed findLastIndex: returns the LAST matching index", () => {
  assertResult(
    'let b = new Uint8Array(4); b[0] = 5; b[1] = 1; b[2] = 5; b[3] = 2; let r = b.findLastIndex(x => x === 5)',
    'r', 2);
});

Deno.test("typed findLast: no match returns undefined", () => {
  assertResult('let b = new Uint8Array(2); let r = b.findLast(x => x > 9)', 'r', undefined);
});

Deno.test("typed findLastIndex: no match returns -1", () => {
  assertResult('let b = new Uint8Array(2); let r = b.findLastIndex(x => x > 9)', 'r', -1);
});

Deno.test("typed findLast: empty returns undefined", () => {
  assertResult('let b = new Uint8Array(0); let r = b.findLast(x => true)', 'r', undefined);
});

Deno.test("typed findLast: walks descending with counting index", () => {
  assertResult(
    'let b = new Uint8Array(3); b[0] = 1; b[1] = 2; b[2] = 3; let log = []; ' +
    'b.findLast((x, i) => { log.push(x * 10 + i); return false; }); let r = log.join(",")',
    'r', '32,21,10');
});

Deno.test("typed findLastIndex: subarray window indexes are window-relative", () => {
  assertResult(
    'let b = new Uint8Array(5); b[0] = 9; b[1] = 1; b[2] = 2; b[3] = 3; b[4] = 9; ' +
    'let s = b.subarray(1, 4); let r = s.findLastIndex(x => x === 3)',
    'r', 2);
});

Deno.test("typed findLast: Float64Array elements", () => {
  assertResult(
    'let b = new Float64Array(3); b[0] = 1.5; b[1] = 2.5; b[2] = 0.5; let r = b.findLast(x => x > 1)',
    'r', 2.5);
});

// =============================================================================
// Parked across gc (mirrors typed_iteration_gc_pressure_test.js) — the
// findLast frame (ITER_RESULT = 0, typed receiver descriptor in
// ITER_RECEIVER) must survive compaction mid-walk.
// =============================================================================

function runWithRecovery(session, maxIters = 2000) {
  let pressureYields = 0;
  let result;
  for (let i = 0; i < maxIters; i++) {
    result = session.run(0, 1_000_000);
    if (result.status === 'memory_pressure') {
      pressureYields += 1;
      session.gc();
      continue;
    }
    if (result.status === 'paused') continue;
    return { result, pressureYields };
  }
  return { result, pressureYields };
}

const WASTE = `
    let waste = [];
    let k = 0;
    while (k < 40) { waste.push("garbage " + k); k = k + 1; }
`;

Deno.test('array findLast completes across mid-walk gc cycles', () => {
  // The predicate never matches, so the walk covers all 64 elements
  // (maximum garbage) and completes via the exhausted default.
  const session = freshSession({ heapSize: 256 * 1024 });
  parseAndSetup(session, `
    let arr = [];
    let i = 0;
    while (i < 64) { arr.push((i * 37) % 251); i = i + 1; }
    let found = arr.findLast((v) => {
      ${WASTE}
      return v > 300;
    });
    let result = found === undefined;
  `);
  const { result, pressureYields } = runWithRecovery(session);
  assertEquals(result.status, 'done',
    `expected done, got ${result.status} (error: ${JSON.stringify(result.error ?? null)})`);
  assertEquals(session.get(0, 'result'), true);
  assert(pressureYields > 0, 'expected at least one memory_pressure yield');
});

Deno.test('typed findLastIndex completes across mid-walk gc cycles (descriptor in ITER_RECEIVER survives)', () => {
  const session = freshSession({ heapSize: 256 * 1024 });
  parseAndSetup(session, `
    let b = new Uint8Array(64);
    let i = 0;
    while (i < 64) { b[i] = (i * 37) % 251; i = i + 1; }
    let result = b.findLastIndex((v) => {
      ${WASTE}
      return v > 300;
    });
  `);
  const { result, pressureYields } = runWithRecovery(session);
  assertEquals(result.status, 'done',
    `expected done, got ${result.status} (error: ${JSON.stringify(result.error ?? null)})`);
  assertEquals(session.get(0, 'result'), -1);
  assert(pressureYields > 0, 'expected at least one memory_pressure yield');
});

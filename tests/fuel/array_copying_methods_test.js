/**
 * Copying methods: toReversed / toSorted / with / toSpliced on arrays,
 * toReversed / toSorted / with on typed arrays.
 *
 * All allocate the copy FIRST (pressure pre-checked), then transform.
 * toSorted delegates to the existing sort machinery with the copy as
 * the receiver: the default form runs the in-place numeric sort loop
 * on the copy, and the comparator form stages a native sort continuation
 * whose operation-state handle owns the copy and insertion-sort state.
 * Completion returns that copy. toSpliced is arrays-only per
 * spec; typed arrays are fixed-length.
 *
 * Run with: deno task test tests/fuel/array_copying_methods_test.js
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
// toReversed
// =============================================================================

Deno.test("toReversed: reversed copy, original untouched, copy independent", () => {
  assertResult(
    'let a = [1,2,3]; let b = a.toReversed(); b[0] = 9; let r = a.join(",") + "|" + b.join(",")',
    'r', '1,2,3|9,2,1');
});

Deno.test("toReversed: empty array", () => {
  assertResult('let r = [].toReversed().length', 'r', 0);
});

Deno.test("toReversed: mixed value types survive", () => {
  assertResult('let r = [1,"a",true].toReversed().join(",")', 'r', 'true,a,1');
});

Deno.test("typed toReversed: reversed copy, original untouched", () => {
  assertResult(
    'let b = new Uint8Array(2); b[0] = 1; b[1] = 2; let c = b.toReversed(); c[0] = 9; ' +
    'let r = b.join(",") + "|" + c.join(",")',
    'r', '1,2|9,1');
});

Deno.test("typed toReversed: subarray receiver copies the window only", () => {
  assertResult(
    'let b = new Uint8Array(4); b[0] = 1; b[1] = 2; b[2] = 3; b[3] = 4; ' +
    'let s = b.subarray(1, 3); let r = s.toReversed().join(",") + "|" + b.join(",")',
    'r', '3,2|1,2,3,4');
});

Deno.test("BigInt64Array toReversed: 8-byte lanes copy exactly", () => {
  assertResult(
    'let b = new BigInt64Array(2); b[0] = 9007199254740993n; b[1] = -5n; ' +
    'let c = b.toReversed(); let r = (c[0] === -5n) + ":" + (c[1] === 9007199254740993n)',
    'r', 'true:true');
});

// =============================================================================
// toSorted
// =============================================================================

Deno.test("toSorted: default numeric sort on a copy", () => {
  assertResult(
    'let a = [3,1,2]; let b = a.toSorted(); let r = a.join(",") + "|" + b.join(",")',
    'r', '3,1,2|1,2,3');
});

Deno.test("toSorted: comparator sorts the copy, original untouched", () => {
  assertResult(
    'let a = [1,3,2]; let b = a.toSorted((x,y) => y - x); let r = a.join(",") + "|" + b.join(",")',
    'r', '1,3,2|3,2,1');
});

Deno.test("toSorted: empty and single-element copies", () => {
  assertResult(
    'let r = [].toSorted().length + ":" + [5].toSorted((x,y) => x - y).join(",")',
    'r', '0:5');
});

Deno.test("toSorted: frozen receiver is fine (the copy is sorted, not the receiver)", () => {
  assertResult('let a = Array.freeze([3,1]); let r = a.toSorted().join(",")', 'r', '1,3');
});

Deno.test("typed toSorted: default sorts copy, original untouched", () => {
  assertResult(
    'let b = new Uint8Array(3); b[0] = 3; b[1] = 1; b[2] = 2; ' +
    'let r = b.toSorted().join(",") + "|" + b.join(",")',
    'r', '1,2,3|3,1,2');
});

Deno.test("typed toSorted: comparator sorts copy, original untouched", () => {
  assertResult(
    'let b = new Uint8Array(3); b[0] = 1; b[1] = 3; b[2] = 2; ' +
    'let r = b.toSorted((x,y) => y - x).join(",") + "|" + b.join(",")',
    'r', '3,2,1|1,3,2');
});

Deno.test("Float64Array toSorted: default numeric", () => {
  assertResult(
    'let b = new Float64Array(3); b[0] = 2.5; b[1] = 0.5; b[2] = 1.5; let r = b.toSorted().join(",")',
    'r', '0.5,1.5,2.5');
});

// =============================================================================
// with
// =============================================================================

Deno.test("with: replaces one element on a copy", () => {
  assertResult(
    'let a = [1,2,3]; let b = a.with(1, 9); let r = a.join(",") + "|" + b.join(",")',
    'r', '1,2,3|1,9,3');
});

Deno.test("with: negative index wraps", () => {
  assertResult('let r = [1,2,3].with(-1, 9).join(",")', 'r', '1,2,9');
});

Deno.test("with: out-of-bounds index throws RangeError", () => {
  assertResult(
    'let r = 0; try { [1,2].with(2, 9); } catch (e) { r = e.message; }',
    'r', 'Invalid index');
});

Deno.test("with: negative out-of-bounds index throws RangeError", () => {
  assertResult(
    'let r = 0; try { [1,2].with(-3, 9); } catch (e) { r = e.message; }',
    'r', 'Invalid index');
});

Deno.test("with: missing value writes undefined", () => {
  assertResult(
    'let b = [1,2].with(0); let r = (b[0] === undefined) + ":" + b[1]',
    'r', 'true:2');
});

Deno.test("typed with: replaces one element on a copy, original untouched", () => {
  assertResult(
    'let b = new Uint8Array(3); b[0] = 1; b[1] = 2; b[2] = 3; ' +
    'let r = b.with(1, 9).join(",") + "|" + b.join(",")',
    'r', '1,9,3|1,2,3');
});

Deno.test("typed with: negative wraps; out-of-bounds throws", () => {
  assertResult(
    'let b = new Uint8Array(2); b[0] = 1; b[1] = 2; let m = 0; ' +
    'try { b.with(5, 1); } catch (e) { m = e.message; } ' +
    'let r = b.with(-1, 7).join(",") + "|" + m',
    'r', '1,7|Invalid index');
});

// =============================================================================
// toSpliced (arrays only)
// =============================================================================

Deno.test("toSpliced: no args copies unchanged", () => {
  assertResult('let r = [1,2,3].toSpliced().join(",")', 'r', '1,2,3');
});

Deno.test("toSpliced: start only deletes to the end", () => {
  assertResult('let r = [1,2,3,4].toSpliced(2).join(",")', 'r', '1,2');
});

Deno.test("toSpliced: delete a middle window", () => {
  assertResult('let r = [1,2,3,4].toSpliced(1, 2).join(",")', 'r', '1,4');
});

Deno.test("toSpliced: pure insertion", () => {
  assertResult('let r = [1,4].toSpliced(1, 0, 2, 3).join(",")', 'r', '1,2,3,4');
});

Deno.test("toSpliced: replace", () => {
  assertResult('let r = [1,9,3].toSpliced(1, 1, 2).join(",")', 'r', '1,2,3');
});

Deno.test("toSpliced: negative start wraps; big delete clamps", () => {
  assertResult(
    'let r = [1,2,3,4].toSpliced(-2, 1).join(",") + "|" + [1,2].toSpliced(1, 99).join(",")',
    'r', '1,2,4|1');
});

Deno.test("toSpliced: original untouched, copy independent", () => {
  assertResult(
    'let a = [1,2,3]; let b = a.toSpliced(0, 1); b[0] = 9; let r = a.join(",") + "|" + b.join(",")',
    'r', '1,2,3|9,3');
});

Deno.test("typed toSpliced: absent per spec (fixed length)", () => {
  assertResult('let b = new Uint8Array(2); let r = typeof b.toSpliced', 'r', 'undefined');
});

// =============================================================================
// In-place neighbors unchanged
// =============================================================================

Deno.test("reverse/sort/splice still mutate in place", () => {
  assertResult(
    'let a = [2,1]; a.sort(); let b = [1,2]; b.reverse(); let c = [1,2,3]; c.splice(1, 1); ' +
    'let r = a.join(",") + "|" + b.join(",") + "|" + c.join(",")',
    'r', '1,2|2,1|1,3');
});

// =============================================================================
// toSorted comparator parked across gc — the COPY lives in the native
// continuation's collector-visible operation state (typed copies use
// descriptor DATA pointers).
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

Deno.test('array toSorted comparator completes across mid-walk gc cycles (copy in ITER_RECEIVER survives)', () => {
  const session = freshSession({ heapSize: 256 * 1024 });
  parseAndSetup(session, `
    let arr = [];
    let i = 0;
    while (i < 64) { arr.push((i * 37) % 251); i = i + 1; }
    let sortedCopy = arr.toSorted((a, x) => {
      ${WASTE}
      return a - x;
    });
    let sorted = true;
    i = 1;
    while (i < 64) { if (sortedCopy[i - 1] > sortedCopy[i]) sorted = false; i = i + 1; }
    let untouched = arr[0] === 0 && arr[1] === 37 && arr.length === 64;
    let result = sorted && untouched;
  `);
  const { result, pressureYields } = runWithRecovery(session);
  assertEquals(result.status, 'done',
    `expected done, got ${result.status} (error: ${JSON.stringify(result.error ?? null)})`);
  assertEquals(session.get(0, 'result'), true);
  assert(pressureYields > 0, 'expected at least one memory_pressure yield');
});

Deno.test('typed toSorted comparator completes across mid-walk gc cycles (copy descriptor in ITER_RECEIVER survives)', () => {
  const session = freshSession({ heapSize: 256 * 1024 });
  parseAndSetup(session, `
    let b = new Uint8Array(64);
    let i = 0;
    while (i < 64) { b[i] = (i * 37) % 251; i = i + 1; }
    let sortedCopy = b.toSorted((a, x) => {
      ${WASTE}
      return a - x;
    });
    let sorted = true;
    i = 1;
    while (i < 64) { if (sortedCopy[i - 1] > sortedCopy[i]) sorted = false; i = i + 1; }
    let untouched = b[0] === 0 && b[1] === 37;
    let result = sorted && untouched;
  `);
  const { result, pressureYields } = runWithRecovery(session);
  assertEquals(result.status, 'done',
    `expected done, got ${result.status} (error: ${JSON.stringify(result.error ?? null)})`);
  assertEquals(session.get(0, 'result'), true);
  assert(pressureYields > 0, 'expected at least one memory_pressure yield');
});

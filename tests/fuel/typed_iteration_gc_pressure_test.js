/**
 * Native typed-array continuations parked across garbage collection.
 *
 * Continuation operation state can contain both header pointers and data
 * pointers. Typed-array receivers and map/filter result descriptors are data
 * pointers; array results and accumulator containers are header pointers.
 * The heap-backed state object declares those distinctions through its two
 * pointer masks, so both collectors mark and forward every word correctly.
 *
 * Sort's inner insertion index is ordinary numeric operation state. It must
 * remain outside both pointer masks even when its value happens to equal a
 * relocated object's old address.
 *
 * These tests drive each shape with an allocating callback on a deliberately
 * small heap so the continuation must park on memory pressure and recover
 * through host garbage collection mid-walk.
 *
 * Run with: deno task test tests/fuel/typed_iteration_gc_pressure_test.js
 */

import { assert, assertEquals } from 'https://deno.land/std@0.208.0/assert/mod.ts';
import { parseAndSetup } from './test-helpers.js';
import { freshSession } from '../../src/host-owned-session.js';

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

Deno.test('typed sort comparator completes across mid-walk gc cycles', () => {
  const session = freshSession({ heapSize: 256 * 1024 });
  parseAndSetup(session, `
    let b = new Uint8Array(64);
    let i = 0;
    while (i < 64) { b[i] = (i * 37) % 251; i = i + 1; }
    b.sort((a, x) => {
      ${WASTE}
      return a - x;
    });
    let sorted = true;
    i = 1;
    while (i < 64) { if (b[i - 1] > b[i]) sorted = false; i = i + 1; }
    let result = sorted;
  `);
  const { result, pressureYields } = runWithRecovery(session);
  assertEquals(result.status, 'done',
    `expected done, got ${result.status} (error: ${JSON.stringify(result.error ?? null)})`);
  assertEquals(session.get(0, 'result'), true);
  assert(pressureYields > 0,
    'the workload must actually park on pressure mid-sort — shrink the ' +
    'heap or grow the waste if this starts fitting without yields');
});

Deno.test('array sort comparator completes across mid-walk gc cycles (operation-owned inner index survives)', () => {
  // 64 elements walks the inner index well past the state pointer masks, so
  // treating it as a pointer during forwarding would scramble the walk.
  const session = freshSession({ heapSize: 256 * 1024 });
  parseAndSetup(session, `
    let arr = [];
    let i = 0;
    while (i < 64) { arr.push((i * 37) % 251); i = i + 1; }
    arr.sort((a, x) => {
      ${WASTE}
      return a - x;
    });
    let sorted = true;
    i = 1;
    while (i < 64) { if (arr[i - 1] > arr[i]) sorted = false; i = i + 1; }
    let result = sorted;
  `);
  const { result, pressureYields } = runWithRecovery(session);
  assertEquals(result.status, 'done',
    `expected done, got ${result.status} (error: ${JSON.stringify(result.error ?? null)})`);
  assertEquals(session.get(0, 'result'), true);
  assert(pressureYields > 0, 'expected at least one memory_pressure yield');
});

Deno.test('typed forEach completes across mid-walk gc cycles (operation-state descriptor survives)', () => {
  const session = freshSession({ heapSize: 256 * 1024 });
  parseAndSetup(session, `
    let b = new Uint8Array(64);
    let i = 0;
    while (i < 64) { b[i] = (i * 37) % 251; i = i + 1; }
    let sum = 0;
    b.forEach((v) => {
      ${WASTE}
      sum = sum + v;
    });
    let result = sum;
  `);
  const { result, pressureYields } = runWithRecovery(session);
  assertEquals(result.status, 'done',
    `expected done, got ${result.status} (error: ${JSON.stringify(result.error ?? null)})`);
  assertEquals(session.get(0, 'result'), 7826);
  assert(pressureYields > 0, 'expected at least one memory_pressure yield');
});

Deno.test('typed map completes across mid-walk gc cycles (operation-state result descriptor survives)', () => {
  const session = freshSession({ heapSize: 256 * 1024 });
  parseAndSetup(session, `
    let b = new Uint8Array(64);
    let i = 0;
    while (i < 64) { b[i] = i; i = i + 1; }
    let doubled = b.map((v) => {
      ${WASTE}
      return v * 2;
    });
    let ok = true;
    i = 0;
    while (i < 64) { if (doubled[i] !== i * 2) ok = false; i = i + 1; }
    let result = ok && doubled.length === 64;
  `);
  const { result, pressureYields } = runWithRecovery(session);
  assertEquals(result.status, 'done',
    `expected done, got ${result.status} (error: ${JSON.stringify(result.error ?? null)})`);
  assertEquals(session.get(0, 'result'), true);
  assert(pressureYields > 0, 'expected at least one memory_pressure yield');
});

Deno.test('typed filter completes across mid-walk gc cycles', () => {
  const session = freshSession({ heapSize: 256 * 1024 });
  parseAndSetup(session, `
    let b = new Uint8Array(64);
    let i = 0;
    while (i < 64) { b[i] = i; i = i + 1; }
    let evens = b.filter((v) => {
      ${WASTE}
      return v % 2 === 0;
    });
    let result = evens.length === 32 && evens[0] === 0 && evens[31] === 62;
  `);
  const { result, pressureYields } = runWithRecovery(session);
  assertEquals(result.status, 'done',
    `expected done, got ${result.status} (error: ${JSON.stringify(result.error ?? null)})`);
  assertEquals(session.get(0, 'result'), true);
  assert(pressureYields > 0, 'expected at least one memory_pressure yield');
});

Deno.test('typed reduce completes across mid-walk gc cycles (operation-state accumulator survives)', () => {
  const session = freshSession({ heapSize: 256 * 1024 });
  parseAndSetup(session, `
    let b = new Uint8Array(64);
    let i = 0;
    while (i < 64) { b[i] = i; i = i + 1; }
    let result = b.reduce((acc, v) => {
      ${WASTE}
      return acc + v;
    }, 0);
  `);
  const { result, pressureYields } = runWithRecovery(session);
  assertEquals(result.status, 'done',
    `expected done, got ${result.status} (error: ${JSON.stringify(result.error ?? null)})`);
  assertEquals(session.get(0, 'result'), 2016);
  assert(pressureYields > 0, 'expected at least one memory_pressure yield');
});

/**
 * $array_push_value's grow branch used to allocate its doubled data
 * block with no $check_heap_overflow. A spread-heavy loop whose
 * reallocation crossed the code block stamped a GC header over
 * bytecode territory and died at the dispatcher's HARD heap-vs-code
 * OOM ("heap collided with code block") instead of yielding
 * EXIT_MEMORY_PRESSURE for a gc-and-retry. The trigger is a chunked base64
 * encoder that spreads each byte chunk into `String.fromCharCode`; its
 * args-collection garbage (~80 transient bytes per element) can exhaust even
 * a multi-megabyte heap unless the drive yields for mid-operation collection.
 *
 * These tests pin the recovery contract: the same workloads on a
 * deliberately small heap must complete through memory_pressure
 * yields + host gc — and for flatMap, whose output array is a
 * PERSISTENT accumulator across callback returns, the park must be
 * resume-exact (no duplicated elements on retry).
 *
 * Run with: deno task test tests/fuel/array_grow_pressure_test.js
 */

import { assert, assertEquals } from 'https://deno.land/std@0.208.0/assert/mod.ts';
import { parseAndSetup } from './test-helpers.js';
import { freshSession } from '../../src/host-owned-session.js';

function runWithRecovery(session, maxIters = 500) {
  let pressureYields = 0;
  let result;
  for (let i = 0; i < maxIters; i++) {
    result = session.run(0, 1000000);
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

Deno.test('spread-heavy chunked base64 encode completes under a small heap (the clearance-check incident shape)', () => {
  const session = freshSession({ heapSize: 512 * 1024 });
  parseAndSetup(session, `
    let bytes = new Uint8Array(15360);
    let i = 0;
    while (i < bytes.length) { bytes[i] = i % 251; i = i + 1; }
    let pieces = [];
    let start = 0;
    while (start < bytes.length) {
      let end = start + 3072;
      if (end > bytes.length) end = bytes.length;
      pieces.push(btoa(String.fromCharCode(...bytes.subarray(start, end))));
      start = end;
    }
    let encoded = pieces.join("");
    let result = encoded.length;
  `);

  const { result, pressureYields } = runWithRecovery(session);
  assertEquals(result.status, 'done',
    `expected done, got ${result.status} (error: ${JSON.stringify(result.error ?? null)})`);
  // base64(15360 bytes) = 15360/3*4 = 20480 chars.
  assertEquals(session.get(0, 'result'), 20480);
  assert(pressureYields > 0,
    'the workload must actually exercise the pressure path — grow the ' +
    'payload or shrink the heap if this starts fitting without yields');
});

Deno.test('a large call-site spread parks and resumes instead of hard-OOMing', () => {
  // The args array is LIVE while it builds (rooted on the pending
  // stack), so a single spread's irreducible peak is roughly
  // 3x its final 16-bytes-per-element size at the last grow (old +
  // doubled block coexist during the copy). 6144 elements ≈ 128KB
  // final capacity peaks near 200KB — recoverable in a 512KB heap
  // once gc reclaims the per-element iterator garbage, fatal before
  // this fix (the grow stamped over the code block). A spread whose
  // live peak GENUINELY exceeds the heap now reports honest
  // persistent memory_pressure (host escalates), never corruption.
  const session = freshSession({ heapSize: 512 * 1024 });
  parseAndSetup(session, `
    let bytes = new Uint8Array(6144);
    let i = 0;
    while (i < bytes.length) { bytes[i] = 65 + (i % 26); i = i + 1; }
    let s = String.fromCharCode(...bytes);
    let result = s.length;
  `);

  const { result, pressureYields } = runWithRecovery(session);
  assertEquals(result.status, 'done',
    `expected done, got ${result.status} (error: ${JSON.stringify(result.error ?? null)})`);
  assertEquals(session.get(0, 'result'), 6144);
  assert(pressureYields > 0, 'expected at least one memory_pressure yield');
});

Deno.test('Array.prototype.flat completes under pressure (fresh target per retry — no duplicates)', () => {
  const session = freshSession({ heapSize: 384 * 1024 });
  parseAndSetup(session, `
    let nested = [];
    let i = 0;
    while (i < 100) {
      let inner = [];
      let k = 0;
      while (k < 40) { inner.push(i * 40 + k); k = k + 1; }
      nested.push(inner);
      i = i + 1;
    }
    let flattened = nested.flat();
    let result = flattened.length;
    let first = flattened[0];
    let last = flattened[3999];
  `);

  const { result } = runWithRecovery(session);
  assertEquals(result.status, 'done',
    `expected done, got ${result.status} (error: ${JSON.stringify(result.error ?? null)})`);
  assertEquals(session.get(0, 'result'), 4000);
  assertEquals(session.get(0, 'first'), 0);
  assertEquals(session.get(0, 'last'), 3999);
});

Deno.test('flatMap accumulates exactly once per element across pressure parks (resume-exact, no duplication)', () => {
  const session = freshSession({ heapSize: 384 * 1024 });
  parseAndSetup(session, `
    let source = [];
    let i = 0;
    while (i < 600) { source.push(i); i = i + 1; }
    let out = source.flatMap((n) => [n, n + 10000]);
    let result = out.length;
    let sum = 0;
    let k = 0;
    while (k < out.length) { sum = sum + out[k]; k = k + 1; }
  `);

  const { result } = runWithRecovery(session);
  assertEquals(result.status, 'done',
    `expected done, got ${result.status} (error: ${JSON.stringify(result.error ?? null)})`);
  assertEquals(session.get(0, 'result'), 1200);
  // sum = (0..599) + (10000..10599) = 179700 + 6179700; any duplicated
  // or dropped element on a pressure retry breaks this exactly.
  assertEquals(session.get(0, 'sum'), 179700 + 600 * 10000 + 179700);
});

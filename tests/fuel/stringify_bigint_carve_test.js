/**
 * Number-to-string conversion
 * allocates throwaway BigInts ($bigint_from_i64 + $bigint_to_decimal's
 * work clone) with NO pressure pre-check. Driven many times inside ONE
 * instruction — JSON.stringify over a numeric tree, array join — the
 * per-number ~64-byte carve compounds past the dispatcher's heap-slack
 * red zone and bump-allocates straight through STATE_CODE_POINTER, stamping
 * BigInt objects over bytecode. The observable failure is `Unknown opcode
 * 0x00` at a tick pc, with the code block interleaved with BigInt headers
 * holding Date.now() values.
 *
 * The fix: pressure pre-checks at the conversion entries
 * ($rational_to_decimal, $rational_abs_decimal's inline arm,
 * $bigint_to_decimal's clone, $f64_to_string's ≥2^63 arm,
 * $value_to_string's INTEGER arm) — refusal returns 0 with the
 * pressure flag set — plus flag-checks in $json_stringify_value's
 * number arms so the walk bails to a clean EXIT_MEMORY_PRESSURE
 * instead of writing string id 0 and carrying on.
 *
 * The churn loop below sweeps the heap pointer through the danger
 * window (just under the code pointer) with stringify's conversion
 * loop running — pre-fix this stamps BigInts over the code block
 * within a few iterations; post-fix every pass yields cleanly and
 * the run completes with the exact expected value.
 */

import { assertEquals } from 'https://deno.land/std@0.208.0/assert/mod.ts';
import { parseAndSetup } from './test-helpers.js';
import { freshSession } from '../../src/host-owned-session.js';

function runWithRecovery(session, maxIters = 500) {
  let result;
  for (let i = 0; i < maxIters; i++) {
    result = session.run(0, 10000000);
    if (result.status === 'memory_pressure') {
      session.gc();
      continue;
    }
    if (result.status === 'paused') continue;
    return result;
  }
  return result;
}

function codeBlockChecksum(session) {
  const mem = session.memoryImage;
  const codeStart = mem.getCodeStart();
  const codePointer = mem.getCodePointer();
  const count = mem.view.getUint32(mem.abs(codeStart), true);
  let hash = 0;
  for (let address = codePointer; address < codeStart + 16; address += 4) {
    hash = (Math.imul(hash, 31) + mem.view.getUint32(mem.abs(address), true)) | 0;
  }
  return { count, codePointer, hash };
}

Deno.test('JSON.stringify numeric churn never carves into the code block', () => {
  // 512 KB heap: each stringify pass converts 2000 numbers (~64
  // unguarded bytes per number pre-fix = ~128 KB of throwaway
  // bigints, double the 32 KB slack this heap size reserves), and the
  // churn sweeps the heap pointer through the just-under-code window
  // on every gc cycle.
  const session = freshSession({ heapSize: 512 * 1024 });
  parseAndSetup(session, `
    let numbers = []
    for (let i = 0; i < 2000; i = i + 1) {
      numbers.push(1000000 + i * 7)
    }
    let lastLength = 0
    for (let pass = 0; pass < 60; pass = pass + 1) {
      let s = JSON.stringify(numbers)
      lastLength = s.length
    }
    let result = lastLength
  `);

  const before = codeBlockChecksum(session);
  const result = runWithRecovery(session);
  const after = codeBlockChecksum(session);

  assertEquals(after.count, before.count,
    'code block instruction count must survive stringify churn');
  assertEquals(after.hash, before.hash,
    'code block bytes must survive stringify churn');
  assertEquals(result.status, 'done', `expected done, got ${result.status}`);
  // "[" + 2000 numbers (1000000..1013993, all 7 digits) + 1999 commas + "]"
  assertEquals(session.get(0, 'result'), 2 + 2000 * 7 + 1999);
});

Deno.test('array join numeric churn never carves into the code block', () => {
  const session = freshSession({ heapSize: 512 * 1024 });
  parseAndSetup(session, `
    let numbers = []
    for (let i = 0; i < 2000; i = i + 1) {
      numbers.push(2000000 + i * 3)
    }
    let lastLength = 0
    for (let pass = 0; pass < 60; pass = pass + 1) {
      let s = numbers.join(",")
      lastLength = s.length
    }
    let result = lastLength
  `);

  const before = codeBlockChecksum(session);
  const result = runWithRecovery(session);
  const after = codeBlockChecksum(session);

  assertEquals(after.count, before.count,
    'code block instruction count must survive join churn');
  assertEquals(after.hash, before.hash,
    'code block bytes must survive join churn');
  assertEquals(result.status, 'done', `expected done, got ${result.status}`);
  assertEquals(session.get(0, 'result'), 2000 * 7 + 1999);
});

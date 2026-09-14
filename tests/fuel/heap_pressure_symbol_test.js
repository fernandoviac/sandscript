/**
 * Cross-type arith follow-up: Symbol creation pre-check.
 *
 * METHOD_SYMBOL_CONSTRUCTOR and METHOD_SYMBOL_FOR each call
 * $symbol_allocate (16 bytes). The surrounding opcode pre-checks
 * (OP_LET_VAR for `let s = Symbol()`) usually catch the boundary
 * first, but the contract shouldn't rely on coincidence. Slice 3a-iv
 * follow-up: explicit 16-byte pre-check at both sites.
 */

import { assertEquals } from 'https://deno.land/std@0.208.0/assert/mod.ts';
import { parseAndSetup } from './test-helpers.js';
import { freshSession } from '../../src/host-owned-session.js';

function runWithRecovery(session, maxIters = 200) {
  let result;
  for (let i = 0; i < maxIters; i++) {
    result = session.run(0, 50000);
    if (result.status === 'memory_pressure') {
      session.gc();
      continue;
    }
    return result;
  }
  return result;
}

Deno.test('Symbol() loop yields and recovers under pressure', () => {
  const session = freshSession({ heapSize: 96 * 1024 });
  parseAndSetup(session, `
    let total = 0;
    for (let i = 0; i < 500; i = i + 1) {
      const s = Symbol("tag");
      total = total + 1;
    }
    let result = total;
  `);

  const result = runWithRecovery(session);
  assertEquals(result.status, 'done', `expected done, got ${result.status}`);
  assertEquals(session.get(0, 'result'), 500);
});

Deno.test('Symbol.for(key) loop yields and recovers under pressure', () => {
  const session = freshSession({ heapSize: 96 * 1024 });
  // Each iteration uses a fresh key so a new Symbol is registered
  // (otherwise the registry returns the same one and no allocation
  // happens after the first iteration).
  parseAndSetup(session, `
    let total = 0;
    for (let i = 0; i < 200; i = i + 1) {
      const s = Symbol.for("k" + i);
      total = total + 1;
    }
    let result = total;
  `);

  const result = runWithRecovery(session);
  assertEquals(result.status, 'done', `expected done, got ${result.status}`);
  assertEquals(session.get(0, 'result'), 200);
});

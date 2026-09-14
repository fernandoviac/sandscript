/**
 * Cross-type arith follow-up to slice 3b: OP_NEG TYPE_COMPLEX branch.
 *
 * Slice 3b wired OP_NEG for BIGINT and RATIONAL but left COMPLEX
 * unwired. $complex_negate allocates 2 × rational_negate + a
 * complex wrapper. Under a tight heap, a loop that allocates
 * complex values and negates them must yield pressure cleanly,
 * not silently overrun.
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

Deno.test('-complex unary negation loop yields and recovers', () => {
  const session = freshSession({ heapSize: 96 * 1024 });
  parseAndSetup(session, `
    let total = 0;
    for (let i = 0; i < 500; i = i + 1) {
      const z = Exact.complex(3n, 4n);
      const neg = -z;
      total = total + 1;
    }
    let result = total;
  `);

  const result = runWithRecovery(session);
  assertEquals(result.status, 'done', `expected done, got ${result.status}`);
  assertEquals(session.get(0, 'result'), 500);
});

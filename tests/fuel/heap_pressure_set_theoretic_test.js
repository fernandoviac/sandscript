/**
 * ES2025 Set-theoretic stream-processor pre-checks.
 *
 * Set.prototype.union / intersection / difference / symmetricDifference
 * each construct a fresh Set and grow it as values are discovered. The
 * result size depends on input traversal, so a length-pass-first model
 * isn't possible — we instead pre-check a conservative upper bound
 * (|this| + |other|) using $estimate_collection_build_size, which
 * accounts for the full doubling chain from initial capacity 4 up to
 * the worst-case capacity. On overflow the opcode yields cleanly
 * (return 0 + pressure flag → EXIT_MEMORY_PRESSURE).
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

Deno.test('Set.union loop under pressure yields and recovers', () => {
  const session = freshSession({ heapSize: 96 * 1024 });
  parseAndSetup(session, `
    let total = 0;
    for (let i = 0; i < 200; i = i + 1) {
      const a = new Set();
      a.add(1); a.add(2); a.add(3); a.add(4); a.add(5);
      const b = new Set();
      b.add(4); b.add(5); b.add(6); b.add(7); b.add(8);
      const u = a.union(b);
      total = total + u.size;
    }
    let result = total;
  `);

  const result = runWithRecovery(session);
  assertEquals(result.status, 'done', `expected done, got ${result.status}`);
  // |a ∪ b| = 8 per iter; 200 iters → 1600.
  assertEquals(session.get(0, 'result'), 1600);
});

Deno.test('Set.intersection loop under pressure yields and recovers', () => {
  const session = freshSession({ heapSize: 96 * 1024 });
  parseAndSetup(session, `
    let total = 0;
    for (let i = 0; i < 200; i = i + 1) {
      const a = new Set();
      a.add(1); a.add(2); a.add(3); a.add(4); a.add(5);
      const b = new Set();
      b.add(3); b.add(4); b.add(5); b.add(6); b.add(7);
      const x = a.intersection(b);
      total = total + x.size;
    }
    let result = total;
  `);

  const result = runWithRecovery(session);
  assertEquals(result.status, 'done', `expected done, got ${result.status}`);
  // |a ∩ b| = 3 per iter; 200 iters → 600.
  assertEquals(session.get(0, 'result'), 600);
});

Deno.test('Set.difference loop under pressure yields and recovers', () => {
  const session = freshSession({ heapSize: 96 * 1024 });
  parseAndSetup(session, `
    let total = 0;
    for (let i = 0; i < 200; i = i + 1) {
      const a = new Set();
      a.add(1); a.add(2); a.add(3); a.add(4); a.add(5);
      const b = new Set();
      b.add(3); b.add(4); b.add(5);
      const d = a.difference(b);
      total = total + d.size;
    }
    let result = total;
  `);

  const result = runWithRecovery(session);
  assertEquals(result.status, 'done', `expected done, got ${result.status}`);
  // |a \ b| = 2 per iter; 200 iters → 400.
  assertEquals(session.get(0, 'result'), 400);
});

Deno.test('Set.symmetricDifference loop under pressure yields and recovers', () => {
  const session = freshSession({ heapSize: 96 * 1024 });
  parseAndSetup(session, `
    let total = 0;
    for (let i = 0; i < 200; i = i + 1) {
      const a = new Set();
      a.add(1); a.add(2); a.add(3); a.add(4); a.add(5);
      const b = new Set();
      b.add(4); b.add(5); b.add(6); b.add(7); b.add(8);
      const s = a.symmetricDifference(b);
      total = total + s.size;
    }
    let result = total;
  `);

  const result = runWithRecovery(session);
  assertEquals(result.status, 'done', `expected done, got ${result.status}`);
  // |a △ b| = 6 per iter; 200 iters → 1200.
  assertEquals(session.get(0, 'result'), 1200);
});

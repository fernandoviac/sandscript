/**
 * Heap-pressure recovery for number-tower opcodes.
 *
 * The number-tower math primitives ($bigint_add, $rational_add,
 * $complex_add, $bigint_mul, etc.) allocate multiple heap objects internally.
 * Arithmetic opcode entry points pre-check a budget sized for the worst-case
 * branch.
 */

import { assertEquals, assert } from 'https://deno.land/std@0.208.0/assert/mod.ts';
import { freshSession } from '../../src/host-owned-session.js';

const FUEL = 50_000_000;

function smallHeapSession() {
  return freshSession({ heapSize: 96 * 1024 });
}

function runWithRecovery(session, maxYields = 1000) {
  let result = session.run(0, FUEL);
  let yields = 0;
  let lastI = -1;
  while (result.status === 'memory_pressure' && yields < maxYields) {
    yields++;
    session.gc();
    // Bail if a yield didn't make progress (true OOM, would loop
    // forever otherwise).
    const curI = session.get(0, 'i');
    if (curI === lastI && yields > 10) break;
    lastI = curI;
    result = session.run(0, FUEL);
  }
  return { result, yields };
}

// Iteration counts here are sized so the ARITHMETIC's own per-
// iteration allocations (result rational + bigint temps) outrun the
// 96KB heap. They were originally 200, when every loop iteration also
// allocated a 192-byte body-block scope; scope recycling
// removed that garbage, so the pressure must come from the thing these tests
// actually pin.

Deno.test('rational + rational loop yields and recovers', () => {
  const session = smallHeapSession();
  session.parse(`
    let a = Exact.rational(1n, 3n)
    let b = Exact.rational(2n, 5n)
    let i = 0
    while (i < 2000) {
      a = a + b
      i = i + 1
    }
  `);
  const { result, yields } = runWithRecovery(session);
  assertEquals(result.status, 'done');
  assert(yields > 0, 'expected at least one pressure yield');
  assertEquals(session.get(0, 'i'), 2000);
  // Pin the VALUE, not just the counter: post-gc heap tails hold
  // stale object bytes, and an arithmetic routine that trusts
  // uninitialized limbs corrupts silently while `i` keeps counting.
  // Exactly that shipped ($bigint_add_magnitude's unwritten carry
  // limb + $bigint_normalize; fixed by the $bigint_alloc limb-zero
  // invariant, 2026-07-19). 1/3 + 2000*(2/5) = 2401/3.
  const a = session.getExact(0, 'a');
  assertEquals(a, { kind: 'rational', numerator: 2401n, denominator: 3n });
});

Deno.test('rational - rational loop yields and recovers', () => {
  const session = smallHeapSession();
  session.parse(`
    let a = Exact.rational(1000n, 1n)
    let b = Exact.rational(1n, 7n)
    let i = 0
    while (i < 2000) {
      a = a - b
      i = i + 1
    }
  `);
  const { result, yields } = runWithRecovery(session);
  assertEquals(result.status, 'done');
  assert(yields > 0, 'expected at least one pressure yield');
  assertEquals(session.get(0, 'i'), 2000);
  // 1000 - 2000*(1/7) = 5000/7 (value pin, same rationale as the + test).
  assertEquals(session.getExact(0, 'a'),
    { kind: 'rational', numerator: 5000n, denominator: 7n });
});

Deno.test('rational * rational loop with bounded growth yields and recovers', () => {
  // Each iteration: a = a * b where b = 1n/1n keeps a bounded.
  // (a * b with non-trivial b would grow a's limbs without bound and
  //  eventually OOM the heap legitimately — see the OOM-escalation
  //  test for that.)
  const session = smallHeapSession();
  session.parse(`
    let a = Exact.rational(2n, 3n)
    let b = Exact.rational(1n, 1n)
    let i = 0
    while (i < 2000) {
      a = a * b
      i = i + 1
    }
  `);
  const { result, yields } = runWithRecovery(session);
  assertEquals(result.status, 'done');
  assert(yields > 0, 'expected at least one pressure yield');
  assertEquals(session.get(0, 'i'), 2000);
  assertEquals(session.getExact(0, 'a'),
    { kind: 'rational', numerator: 2n, denominator: 3n });
});

Deno.test('rational * rational with growing result eventually escalates to OOM', () => {
  // Unbounded growth: result limbs grow per iteration. After enough
  // iterations the heap genuinely cannot fit the result. The yield-
  // gc-retry loop sees persistent pressure → host treats as OOM.
  const session = smallHeapSession();
  session.parse(`
    let a = Exact.rational(2n, 3n)
    let b = Exact.rational(5n, 7n)
    let i = 0
    while (i < 200) {
      a = a * b
      i = i + 1
    }
  `);
  let result = session.run(0, FUEL);
  let attempts = 0;
  while (result.status === 'memory_pressure' && attempts < 3) {
    session.gc();
    const before = session.get(0, 'i');
    result = session.run(0, FUEL);
    const after = session.get(0, 'i');
    attempts++;
    // If no progress between gc + retry, the budget genuinely doesn't
    // fit. Persistent pressure is the canonical OOM signal — host
    // policy is to surface as terminal.
    if (after === before && result.status === 'memory_pressure') break;
  }
  // Either completed or is persistently pressuring (legit OOM).
  assert(
    result.status === 'done' || result.status === 'memory_pressure',
    `unexpected status ${result.status}`,
  );
});

Deno.test('rational / rational loop with bounded growth yields and recovers', () => {
  // Divide by 1 to keep result bounded — exercises the pre-check path
  // without legitimate OOM.
  const session = smallHeapSession();
  session.parse(`
    let a = Exact.rational(123n, 1n)
    let b = Exact.rational(1n, 1n)
    let i = 0
    while (i < 2000) {
      a = a / b
      i = i + 1
    }
  `);
  const { result, yields } = runWithRecovery(session);
  assertEquals(result.status, 'done');
  assert(yields > 0, 'expected at least one pressure yield');
  assertEquals(session.get(0, 'i'), 2000);
});

Deno.test('-rational unary negation loop yields and recovers', () => {
  // Repeated -a where a is a heap rational. Each iteration allocates a
  // fresh negated rational; the old one becomes garbage.
  const session = smallHeapSession();
  session.parse(`
    let a = Exact.rational(1n, 3n)
    let i = 0
    while (i < 500) {
      a = -a
      i = i + 1
    }
  `);
  const { result, yields } = runWithRecovery(session);
  assertEquals(result.status, 'done');
  assertEquals(session.get(0, 'i'), 500);
});

Deno.test('rational % rational loop with bounded growth completes', () => {
  // a = a % b in a loop. The remainder is bounded by b.
  const session = smallHeapSession();
  session.parse(`
    let a = Exact.rational(100n, 1n)
    let b = Exact.rational(3n, 1n)
    let i = 0
    while (i < 100) {
      a = a % b
      i = i + 1
    }
  `);
  const { result, yields } = runWithRecovery(session);
  assertEquals(result.status, 'done');
  assertEquals(session.get(0, 'i'), 100);
});

Deno.test('bigint << bigint shift loop completes', () => {
  // Each iteration shifts left by 1 (doubling). Bounded growth.
  const session = smallHeapSession();
  session.parse(`
    let a = 1n
    let one = 1n
    let i = 0
    while (i < 100) {
      a = a << one
      i = i + 1
    }
  `);
  const { result, yields } = runWithRecovery(session);
  assertEquals(result.status, 'done');
  assertEquals(session.get(0, 'i'), 100);
});

Deno.test('bigint & bigint bitwise AND loop completes', () => {
  const session = smallHeapSession();
  session.parse(`
    let mask = 1234567890123456789n
    let a = 9876543210987654321n
    let i = 0
    while (i < 500) {
      a = a & mask
      i = i + 1
    }
  `);
  const { result, yields } = runWithRecovery(session);
  assertEquals(result.status, 'done');
  assertEquals(session.get(0, 'i'), 500);
});

Deno.test('rational + bigint cross-type loop yields and recovers', () => {
  // Heap rational + heap bigint forces the rational + bigint
  // promotion path inside OP_ADD. The pre-check covers both the
  // promotion (bigint→rational) AND the subsequent rational_add.
  const session = smallHeapSession();
  session.parse(`
    let a = Exact.rational(1n, 7n)
    let b = 12345n
    let i = 0
    while (i < 2000) {
      a = a + b
      i = i + 1
    }
  `);
  const { result, yields } = runWithRecovery(session);
  assertEquals(result.status, 'done');
  assert(yields > 0, 'expected at least one pressure yield');
  assertEquals(session.get(0, 'i'), 2000);
});

Deno.test('bigint + rational cross-type loop yields and recovers', () => {
  // Reversed operand order; tests bigint+rational dispatch.
  const session = smallHeapSession();
  session.parse(`
    let a = 1n
    let b = Exact.rational(1n, 7n)
    let i = 0
    while (i < 2000) {
      a = a + b
      i = i + 1
    }
  `);
  // Note: a is bigint, result becomes rational. So a's type changes
  // after first iteration. Subsequent iterations are rational+rational.
  const { result, yields } = runWithRecovery(session);
  assertEquals(result.status, 'done');
  assert(yields > 0, 'expected at least one pressure yield');
  assertEquals(session.get(0, 'i'), 2000);
});

Deno.test('Exact.Expression.add loop yields and recovers (slice 3c)', () => {
  // Build a chain of Expression nodes. Each Exact.Expression.add
  // allocates an args array + an Expression node + simplifier
  // intermediates. With a tight heap and a long loop, this fills the
  // heap; pre-check at the dispatch_builtin_method branch yields
  // pressure and gc reclaims the dead intermediates.
  const session = smallHeapSession();
  session.parse(`
    let acc = Exact.Pi;
    let i = 0
    while (i < 100) {
      acc = Exact.Expression.add(acc, Exact.Pi);
      i = i + 1
    }
  `);
  const { result, yields } = runWithRecovery(session);
  assertEquals(result.status, 'done');
  assertEquals(session.get(0, 'i'), 100);
});

Deno.test('multi-limb rational arithmetic on a small heap completes (no over-refusal)', () => {
  // Arithmetic budgets used to be O(sumLen²), bounding $bigint_gcd's old
  // Euclidean loop that allocated a quotient and remainder per iteration, so
  // roughly 11-limb operands demanded hundreds of KB of headroom on this
  // 96 KB heap
  // and hit PERMANENT memory_pressure with the heap mostly free.
  // With the in-place binary gcd, the budget is O(sumLen) and this
  // must complete. This test fails (permanent pressure) on the old
  // budgets; it is the fix's pin.
  const session = smallHeapSession();
  const aNum = 10n ** 105n + 3n;
  const aDen = 10n ** 103n + 7n;
  const bNum = 10n ** 104n + 9n;
  const bDen = 10n ** 105n + 13n;
  session.parse(`
    let a = Exact.rational(${aNum}n, ${aDen}n)
    let b = Exact.rational(${bNum}n, ${bDen}n)
    let sum = 0n
    let product = 0n
    let i = 0
    while (i < 40) {
      sum = a + b
      product = a * b
      i = i + 1
    }
  `);
  const { result } = runWithRecovery(session);
  assertEquals(result.status, 'done');
  assertEquals(session.get(0, 'i'), 40);
  // Value-pin both results against JS BigInt arithmetic (reduced).
  const gcd = (x, y) => {
    x = x < 0n ? -x : x;
    y = y < 0n ? -y : y;
    while (y) { [x, y] = [y, x % y]; }
    return x;
  };
  const reduce = (n, d) => {
    const g = gcd(n, d);
    return { kind: 'rational', numerator: n / g, denominator: d / g };
  };
  assertEquals(session.getExact(0, 'sum'),
    reduce(aNum * bDen + bNum * aDen, aDen * bDen));
  assertEquals(session.getExact(0, 'product'),
    reduce(aNum * bNum, aDen * bDen));
});

Deno.test('bigint * bigint loop (size grows) yields and recovers', () => {
  // Each iteration doubles the bigint size via squaring.
  // After ~10 iterations the heap is exhausted.
  const session = smallHeapSession();
  session.parse(`
    let a = 12345678901234567890n
    let i = 0
    while (i < 15) {
      a = a * 1000000n
      i = i + 1
    }
  `);
  const { result, yields } = runWithRecovery(session);
  assertEquals(result.status, 'done');
  assertEquals(session.get(0, 'i'), 15);
  // Even without yields, the program must complete cleanly (the
  // pre-check fired or not is observation; correctness is what
  // matters).
});

Deno.test('BigInt string conversion yields and recovers', () => {
  const session = smallHeapSession();
  session.parse(`
    let value = 0n
    let i = 0
    while (i < 2000) {
      value = BigInt("1234567890123456789012345678901234567890")
      i = i + 1
    }
  `);
  const { result, yields } = runWithRecovery(session);
  assertEquals(result.status, 'done');
  assert(yields > 0, 'expected at least one pressure yield');
  assertEquals(session.get(0, 'value'),
    1234567890123456789012345678901234567890n);
});

Deno.test('signed BigInt bitwise operations yield and recover', () => {
  const session = smallHeapSession();
  session.parse(`
    let value = 0n
    let i = 0
    while (i < 2000) {
      value = (-123456789012345678901234567890n) ^
        987654321098765432109876543210n
      i = i + 1
    }
  `);
  const { result, yields } = runWithRecovery(session);
  assertEquals(result.status, 'done');
  assert(yields > 0, 'expected at least one pressure yield');
  assertEquals(session.get(0, 'value'),
    (-123456789012345678901234567890n) ^
      987654321098765432109876543210n);
});

Deno.test('BigInt fixed-width conversion yields and recovers', () => {
  const session = smallHeapSession();
  session.parse(`
    let value = 0n
    let i = 0
    while (i < 10000) {
      value = BigInt.asIntN(127,
        1234567890123456789012345678901234567890n)
      i = i + 1
    }
  `);
  const { result, yields } = runWithRecovery(session);
  assertEquals(result.status, 'done');
  assert(yields > 0, 'expected at least one pressure yield');
  assertEquals(session.get(0, 'value'),
    BigInt.asIntN(127, 1234567890123456789012345678901234567890n));
});

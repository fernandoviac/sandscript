/**
 * Memory-pressure yield behavior on string-table overflow.
 *
 * Runtime string concatenation beyond string-table capacity yields
 * `memory_pressure` rather than trapping with a raw WebAssembly
 * "memory access out of bounds" error. The host can then collect and retry or
 * surface OOM to SandScript.
 */

import { assertEquals } from "https://deno.land/std@0.208.0/assert/mod.ts";
import { createSession } from '../../src/fuel/session.js';
import { freshSession } from '../../src/host-owned-session.js';

Deno.test('concat past string-table size yields memory_pressure (not WASM trap)', () => {
  // 700 iterations of `s = s + "y"` fill the default 256 KB string table and
  // must yield cleanly with status 'memory_pressure'.
  const session = freshSession();
  session.parse(`
    let s = "x"
    let i = 0
    while (i < 700) { s = s + "y"; i = i + 1 }
  `);

  let result;
  try {
    result = session.run(0, 50_000_000);
  } catch (e) {
    throw new Error(
      `Expected yield with status 'memory_pressure', got WASM trap: ${e.message}`);
  }

  assertEquals(result.status, 'memory_pressure',
    `expected 'memory_pressure', got '${result.status}'`);
});

Deno.test('after memory_pressure yield, host gc + re-run completes the loop', () => {
  // Canonical scenario: dead intermediate strings. GC reclaims them
  // and the loop finishes on retry. How many gc rounds it takes
  // depends on where the yield lands relative to the table size (the
  // permanent builtin-string footprint shifts it as rings add
  // builtins), so the host protocol is the loop: gc + retry while
  // PROGRESS is being made. No progress across a gc means a real
  // regression (that's the escalates-to-OOM test's territory).
  const session = freshSession();
  session.parse(`
    let s = "x"
    let i = 0
    while (i < 700) { s = s + "y"; i = i + 1 }
    let finalLen = s.length
  `);

  let result = session.run(0, 50_000_000);
  // First run yields under pressure.
  assertEquals(result.status, 'memory_pressure');

  let previousProgress = -1;
  while (result.status === 'memory_pressure') {
    const progress = session.get(0, 'i');
    if (progress === previousProgress) {
      throw new Error(`gc + retry made no progress (stuck at i = ${progress})`);
    }
    previousProgress = progress;
    session.gc();
    result = session.run(0, 50_000_000);
  }
  assertEquals(result.status, 'done',
    `after gc rounds, expected 'done', got '${result.status}'`);

  assertEquals(session.get(0, 'finalLen'), 701);
});

Deno.test('memory_pressure escalates to OOM when gc reclaims nothing', () => {
  // Pathological scenario: every intermediate string is kept alive in
  // an array, so gc reclaims nothing. The host's retry yields under
  // pressure again; the host treats that as fatal and surfaces OOM.
  const session = freshSession();
  session.parse(`
    let arr = []
    let s = "x"
    let i = 0
    while (i < 700) {
      s = s + "y"
      arr[i] = s
      i = i + 1
    }
  `);

  let result = session.run(0, 50_000_000);
  assertEquals(result.status, 'memory_pressure');

  session.gc();
  result = session.run(0, 50_000_000);
  // Second yield under pressure — host treats as OOM.
  assertEquals(result.status, 'memory_pressure',
    `expected second 'memory_pressure' (no progress), got '${result.status}'`);

  // The host's policy at this point is to surface OOM. The interpreter
  // doesn't need to do that automatically — but a follow-up call that
  // converts the second yield into an error is the natural host policy.
  // For this test, the contract is just: it yields, doesn't trap.
});

Deno.test('memory_pressure yield preserves slot state for retry', () => {
  // The yielding instruction must not consume its operands, must not
  // advance the instruction pointer, and must leave the slot able to
  // continue normally after retry.
  const session = freshSession();
  const mem = session.airlock.memoryImage;
  session.parse(`
    let s = "x"
    let i = 0
    while (i < 700) { s = s + "y"; i = i + 1 }
    let finalLen = s.length
  `);

  let result = session.run(0, 50_000_000);
  assertEquals(result.status, 'memory_pressure');

  // gc + retry (looped while progress is made) must succeed for this
  // canonical case — see the progress note in the completes-the-loop
  // test above.
  let previousProgress = -1;
  while (result.status === 'memory_pressure') {
    const progress = session.get(0, 'i');
    if (progress === previousProgress) {
      throw new Error(`gc + retry made no progress (stuck at i = ${progress})`);
    }
    previousProgress = progress;
    session.gc();
    result = session.run(0, 50_000_000);
  }
  assertEquals(result.status, 'done');
  assertEquals(session.get(0, 'finalLen'), 701);

  // The drone can keep going after a yield + recovery.
  const r2 = session.parse(`let extra = s + "z"`);
  mem.setContextInstructionIndex(0, r2.startIndex);
  result = session.run(0, 50_000_000);
  // May or may not yield again depending on table state; either way no trap.
  if (result.status === 'memory_pressure') {
    session.gc();
    result = session.run(0, 50_000_000);
  }
  assertEquals(result.status, 'done');
  const extra = session.get(0, 'extra');
  assertEquals(typeof extra, 'string');
  assertEquals(extra.length, 702);
});

Deno.test('coerce branch (string + number) yields memory_pressure then recovers', () => {
  // s + i where i is a number forces the OP_ADD "String + other" coerce
  // branch. Same dead-intermediate-strings pattern; same yield path.
  const session = freshSession();
  session.parse(`
    let s = "x"
    let i = 0
    while (i < 700) { s = s + i; i = i + 1 }
    let finalLen = s.length
  `);

  let result;
  try {
    result = session.run(0, 100_000_000);
  } catch (e) {
    throw new Error(
      `Expected yield, got WASM trap: ${e.message}`);
  }
  // Either it completed (small enough not to overflow) or yielded.
  // Larger N is unpredictable in the coerce branch because the numeric
  // stringification adds variable bytes; what matters is no trap and
  // any yield is followed by a clean recovery.
  while (result.status === 'memory_pressure') {
    session.gc();
    result = session.run(0, 100_000_000);
  }
  assertEquals(result.status, 'done',
    `expected eventual 'done', got '${result.status}'`);
  // Should have accumulated 700 numeric stringifications.
  const finalLen = session.get(0, 'finalLen');
  if (typeof finalLen !== 'number' || finalLen < 700) {
    throw new Error(`unexpected finalLen: ${finalLen}`);
  }
});

Deno.test('coerce branch (number + string) yields memory_pressure then recovers', () => {
  // i + s where i is a number forces the "other + String" coerce branch.
  // Symmetric to the previous test.
  const session = freshSession();
  session.parse(`
    let s = "x"
    let i = 0
    while (i < 700) { s = i + s; i = i + 1 }
    let finalLen = s.length
  `);

  let result;
  try {
    result = session.run(0, 100_000_000);
  } catch (e) {
    throw new Error(`Expected yield, got WASM trap: ${e.message}`);
  }
  while (result.status === 'memory_pressure') {
    session.gc();
    result = session.run(0, 100_000_000);
  }
  assertEquals(result.status, 'done',
    `expected eventual 'done', got '${result.status}'`);
  const finalLen = session.get(0, 'finalLen');
  if (typeof finalLen !== 'number' || finalLen < 700) {
    throw new Error(`unexpected finalLen: ${finalLen}`);
  }
});

Deno.test('coerce branch preserves operand types across the yield', () => {
  // The yield must push the right operand back with its ORIGINAL type
  // (not coerced to string). On retry, the OP_ADD dispatcher re-enters
  // the same coerce branch — which would fail if the operand had become
  // a string. This test forces a small enough payload that one yield
  // + gc fully recovers, then asserts the result is structurally a
  // string with the right content.
  const session = freshSession();
  session.parse(`
    let s = ""
    let i = 0
    while (i < 1000) { s = s + i; i = i + 1 }
    let len = s.length
    let last3 = s.slice(s.length - 3)
  `);

  let result = session.run(0, 200_000_000);
  while (result.status === 'memory_pressure') {
    session.gc();
    result = session.run(0, 200_000_000);
  }
  assertEquals(result.status, 'done');

  // The last 3 chars should be "999" (i ran 0..999, last appended is 999).
  assertEquals(session.get(0, 'last3'), '999',
    `concatenated tail should preserve coerced numeric form`);
});

Deno.test('Array.join under pressure yields and recovers (builtin-method chokepoint)', () => {
  // Array.prototype.join chains many $string_concat calls internally.
  // With the chokepoint design, $string_concat self-signals pressure
  // and the OP_CALL_METHOD handler rolls back the pending stack and
  // yields. Host gc + retry completes.
  const session = freshSession();
  session.parse(`
    let n = 200
    let parts = []
    let i = 0
    while (i < n) {
      parts[i] = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
      i = i + 1
    }
    let joined = parts.join(",")
    let len = joined.length
  `);

  let result;
  try {
    result = session.run(0, 200_000_000);
  } catch (e) {
    throw new Error(`Array.join trapped: ${e.message}`);
  }
  while (result.status === 'memory_pressure') {
    session.gc();
    result = session.run(0, 200_000_000);
  }
  assertEquals(result.status, 'done');
  const len = session.get(0, 'len');
  // 200 strings of 52 chars + 199 commas = 10599 chars.
  assertEquals(len, 200 * 52 + 199);
});

Deno.test('Coerce of rational inside `+` no longer traps mid-chain', () => {
  // Repeated `s = s + r` where r is a rational forces the OP_ADD
  // "String + other" coerce branch on each iteration, each chaining
  // $string_concat calls inside $rational_to_decimal. With the
  // chokepoint, any internal concat signals pressure and OP_ADD
  // rolls back. Host gc + retry completes the loop.
  const session = freshSession();
  session.parse(`
    let s = "init"
    let r = Exact.rational(1n, 3n)
    let i = 0
    while (i < 500) { s = s + r; i = i + 1 }
    let len = s.length
    let head4 = "init"
    let isPrefix = s.slice(0, 4) === head4
  `);

  let result;
  try {
    result = session.run(0, 500_000_000);
  } catch (e) {
    throw new Error(`Coerce-in-chain trapped: ${e.message}`);
  }
  while (result.status === 'memory_pressure') {
    session.gc();
    result = session.run(0, 500_000_000);
  }
  assertEquals(result.status, 'done');
  // 4 chars of "init" + 500 instances of "1/3" = 4 + 1500 = 1504 chars.
  assertEquals(session.get(0, 'len'), 1504);
  // Pending-stack rollback preserved the left operand across each yield.
  assertEquals(session.get(0, 'isPrefix'), true);
});

Deno.test('resize interaction: bigger string table moves the pressure boundary', () => {
  // After engine.resizeSegment with a larger string table, drones
  // that previously yielded under pressure should now complete
  // without yielding. Verifies the cached $segment_size is refreshed
  // by the resize primitive.
  const memory = new WebAssembly.Memory({
    initial: Math.ceil((8 * 1024 * 1024) / 65536),
    maximum: Math.ceil((8 * 1024 * 1024) / 65536),
    shared: true,
  });
  const session = freshSession({ memory, offset: 0, heapSize: 768 * 1024 });

  // Grow the string table substantially before running the concat loop.
  session.resizeSegment({
    newSegmentSize: 4 * 1024 * 1024,
    newStringTableSize: 2 * 1024 * 1024,  // up from 256 KB default
  });

  session.parse(`
    let s = "x"
    let i = 0
    while (i < 700) { s = s + "y"; i = i + 1 }
    let finalLen = s.length
  `);

  const result = session.run(0, 50_000_000);
  assertEquals(result.status, 'done',
    `with 2 MB table, expected 'done' without yielding, got '${result.status}'`);
  assertEquals(session.get(0, 'finalLen'), 701);
});

Deno.test('str[i] single-char intern yields memory_pressure then recovers', () => {
  // GET_INDEX on a string interns the 1-byte result. If the table is
  // full at exactly that point, the handler must yield with the two
  // popped operands restored — not push the sentinel string id 0.
  //
  // Self-tuning setup: measure parse-time table usage with a tiny pad,
  // then solve for the pad length that makes the four dead concats
  // land within 8 bytes of the table end, so the 1-byte intern at
  // s[5] (aligned entry size 8) is the first allocation to overflow.
  // The pad-length steps move in multiples of 4 and can stride over
  // the 8-byte window for an unlucky parse-time base (the base shifts
  // whenever a builtin string is added), so the anchor length A is
  // varied too until some (A, P) pair lands.
  const align = (x) => (x + 3) & ~3;
  const makeCode = (A, P) => `
    let s = "${'q'.repeat(A)}"
    let p = "${'r'.repeat(P)}"
    let g = s + p
    g = p + s
    g = p + p
    g = s + s
    g = 0
    let c = s[5]
    let after = c + "!"
  `;

  let landedA = -1;
  let pad = -1;
  for (let A = 1000; A < 1016 && pad === -1; A++) {
    const probe = freshSession();
    probe.parse(makeCode(A, 8));
    const total = probe.state(0).stringTableTotal;
    const base = probe.state(0).stringTableUsed - align(4 + 8);
    const usedFinal = (P) => base + align(4 + P)
      + 2 * align(4 + A + P) + align(4 + 2 * P) + align(4 + 2 * A);
    for (let p = 8; p < 65536; p++) {
      const u = usedFinal(p);
      if (u <= total && u + 8 > total) { landedA = A; pad = p; break; }
    }
  }
  if (pad === -1) throw new Error('no (A, pad) pair lands in the 8-byte window');

  const session = freshSession();
  session.parse(makeCode(landedA, pad));

  let result;
  try {
    result = session.run(0, 5_000_000);
  } catch (e) {
    throw new Error(`Expected yield, got WASM trap: ${e.message}`);
  }
  assertEquals(result.status, 'memory_pressure',
    `expected the s[5] intern to yield, got '${result.status}'`);

  session.gc();
  result = session.run(0, 5_000_000);
  assertEquals(result.status, 'done',
    `after gc, expected 'done', got '${result.status}'`);
  assertEquals(session.get(0, 'c'), 'q');
  assertEquals(session.get(0, 'after'), 'q!');
});

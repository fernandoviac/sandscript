/**
 * GC must treat heap pointers baked into code operands as roots.
 *
 * The parser allocates BigInt heap objects at parse time and stores
 * their HEADER pointers in instruction operands (LIT_BIGINT for `5n`,
 * LIT_RATIONAL_BIGINT for integer literals beyond i64). Before the
 * markCodeBlockHeapOperands / updateCodeBlockHeapOperands pair, a
 * literal whose only reference was its operand got collected, and a
 * live-but-relocated one left a stale operand behind — either way the
 * next execution of the literal read garbage (observed as 0n).
 */
import { assertEquals } from "https://deno.land/std@0.208.0/assert/mod.ts";
import { freshSession } from '../../src/host-owned-session.js';
import { parseAndRun } from './test-helpers.js';

const BIG = '123456789012345678901234567890';

Deno.test('bigint literal survives GC when only referenced from code', () => {
  const session = freshSession();
  // Define but do NOT call — the literal's only reference is the
  // LIT_BIGINT operand. GC used to collect it.
  parseAndRun(session, `function f() { return ${BIG}n; }`);
  session.gc();
  parseAndRun(session, 'let result = f();');
  assertEquals(String(session.get(0, 'result')), BIG);
});

Deno.test('bigint literal operand is forwarded when the object relocates', () => {
  const session = freshSession();
  parseAndRun(session, `function f() { return ${BIG}n; }`);
  // Root the object via scope so it survives, then GC so compaction
  // relocates it. The operand must be forwarded along with the scope
  // reference; before the fix this returned 0n.
  parseAndRun(session, 'let before = f();');
  session.gc();
  parseAndRun(session, 'let after = f();');
  assertEquals(String(session.get(0, 'after')), BIG);
  assertEquals(String(session.get(0, 'before')), BIG);
});

Deno.test('huge integer literal (LIT_RATIONAL_BIGINT) survives GC', () => {
  const session = freshSession();
  // Beyond i64 range — parser marshals a heap BigInt numerator and
  // emits LIT_RATIONAL_BIGINT with its header pointer in operand1.
  parseAndRun(session, `function g() { return ${BIG}; }`);
  session.gc();
  parseAndRun(session, 'let result = g();');
  // Out-of-i32 rationals surface as the structured exact shape.
  const exact = session.getExact(0, 'result');
  assertEquals(String(exact.numerator), BIG);
  assertEquals(String(exact.denominator), '1');
});

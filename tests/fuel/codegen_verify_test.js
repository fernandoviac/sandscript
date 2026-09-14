/**
 * Bytecode stack-depth verifier (codegen-verify.js).
 *
 * The parse-time detector for the deferred-POP class: simulate operand
 * depth over the emitted code; every instruction must be reached at ONE
 * depth. The historic bug — `if (c) expr()` with the branch POP at the
 * jump target — is a join-mismatch, detectable without running a single
 * instruction.
 *
 * Validation strategy: (1) a battery of clean programs (the codegen
 * stress corpus shapes) must verify with ZERO findings — this also
 * validates the per-opcode effects table (a wrong entry produces a
 * false join-mismatch at a legitimate merge); (2) hand-repatching a
 * JUMP_IF_FALSE one instruction short (the exact historic emission)
 * must produce the join-mismatch finding.
 *
 * Run with: deno task test tests/fuel/codegen_verify_test.js
 */

import { assert, assertEquals } from "https://deno.land/std@0.208.0/assert/mod.ts";
import { freshSession } from '../../src/host-owned-session.js';
import { verifyCodeBlockStackDepth } from '../../src/fuel/codegen-verify.js';
import { OP } from '../../src/fuel/constants.js';

const CLEAN_PROGRAMS = [
  // The historic shape, correctly compiled post-fix.
  `let a = []
   let i = 0
   while (i < 6) {
     if (i === 99) a.push(i)
     i = i + 1
   }`,
  // Branch merges with equal arm effects.
  `let r = 0
   if (r === 0) r = 1
   else r = 2
   if (r === 1) { r = r + 1 } else { r = r - 1 }`,
  // Nested unbraced + dangling else.
  `let r = "none"
   if (true) if (false) r = "a"
   else r = "b"`,
  // Loops: while / do-while / for, braced + unbraced.
  `let s = 0
   for (let i = 0; i < 5; i = i + 1) s = s + i
   let n = 0
   do n = n + 1
   while (n < 4)`,
  // break / continue edges.
  `let a = []
   let i = 0
   while (true) {
     i = i + 1
     if (i === 2) continue
     if (i === 5) break
     a.push(i)
   }`,
  // Calls, methods, literals, functions, early return.
  `let f = (x, y) => { return x + y }
   let g = (n) => {
     if (n <= 1) return 1
     return n * g(n - 1)
   }
   let obj = { a: f(1, 2), b: [g(3), "s"], c: { d: true } }
   let got = obj.b[0] + obj.a`,
  // Ternary / short-circuit as statements + expression results.
  `let hits = 0
   let bump = () => { hits = hits + 1 }
   true ? bump() : bump()
   false && bump()
   true || bump()
   let v = hits === 1 ? "one" : "many"`,
  // REPL tail expression (deferred top-level POP).
  `let a = 20
   let b = 22
   a + b`,
  // try/catch/finally — statically verifiable since layout v9's
  // pending-position restore.
  `let log = []
   try {
     log.push("in")
     throw new Error("boom")
   } catch (e) {
     log.push(e.message)
   } finally {
     log.push("cleanup")
   }`,
  `let f = () => {
     try {
       return "kept"
     } finally {
       let sweep = 1
     }
   }
   let got = f()`,
  `let r = "outer"
   try {
     try { throw new Error("deep") } finally { r = "swept" }
   } catch (e) {
     r = e.message
   }`,
  // grant / denied (parse-only here; the denied target is the
  // GRANT_DENIED marker, so its edge carries the rejected-ids array).
  `let result = 0
   grant "fs" {
     result = 42
   } denied (ids) {
     result = ids.length
   }`,
  `let r = 0
   grant "a" {
     grant "b" { r = 2 }
   }`,
  // spread family.
  `let parts = [1, 2]
   let all = [0, ...parts, 3]
   let f = (a, b, c, d) => { return a + b + c + d }
   let sum = f(...all)
   let obj = { x: 1 }
   let merged = { ...obj, y: 2 }`,
  // switch with fallthrough (the verifier's first catch).
  `let log = []
   switch (1) {
     case 1:
       log.push("a")
     case 2:
       log.push("b")
       break
     default:
       log.push("c")
   }`,
];

Deno.test('verifier: clean programs verify with zero findings (effects table validation)', () => {
  for (const src of CLEAN_PROGRAMS) {
    const session = freshSession();
    session.parse(src);
    const report = verifyCodeBlockStackDepth(session.mem);
    assertEquals(report.findings, [],
      `clean program must have no findings:\n${src}`);
    assert(report.verified >= 1, 'at least the top-level region verifies');
  }
});

Deno.test('verifier: switch fallthrough no longer executes the next case label (first independent catch)', () => {
  // The verifier's day-one catch: the single-pass parser emitted each
  // case-test expression INLINE between bodies (dead copies of the test
  // chain), so fallthrough executed the next case's test — one leaked
  // operand per fallen-through label. Pre-fix this program produced a
  // join-mismatch at the case-2 body entry.
  const session = freshSession();
  session.parse(`
    let log = []
    switch (1) {
      case 1:
        log.push("a")
      case 2:
        log.push("b")
        break
      default:
        log.push("c")
    }
  `);
  const report = verifyCodeBlockStackDepth(session.mem);
  assertEquals(report.findings, [], 'fallthrough must not leak stack slots');

  // And the behavior stands: fallthrough accumulates both pushes.
  const r = session.run(0, 100000);
  assertEquals(r.status, 'done');
  assertEquals(session.get(0, 'log'), ['a', 'b']);
});

Deno.test('verifier: unknown opcodes make a region UNVERIFIED, never guessed', () => {
  const session = freshSession();
  session.parse(`
    let r = 1
    let s = r + 1
  `);
  // Hand-plant ITER_INIT, a reserved opcode that the parser never emits:
  // the region must bail, not guess.
  const count = session.mem.codeBlockInstructionCount();
  const codeStart = session.mem.getCodeStart();
  const instructionAddress = codeStart - 2 * 16; // instruction index 1 (INSTRUCTION_SIZE 16)
  session.mem.view.setUint8(session.mem.abs(instructionAddress), OP.ITER_INIT);

  const report = verifyCodeBlockStackDepth(session.mem);
  assertEquals(report.findings, [], 'no guessed findings');
  assert(report.unverified.length >= 1, 'the region with the reserved opcode reports unverified');
  assertEquals(report.unverified[0].opcode, OP.ITER_INIT);
});

Deno.test('verifier: the historic deferred-POP emission is a join-mismatch', () => {
  const session = freshSession();
  session.parse(`
    let sink = []
    let flag = false
    if (flag) sink.push(1)
    let after = 2
  `);

  // Locate the branch and re-create the historic bug: point the
  // JUMP_IF_FALSE one instruction SHORT, at the branch's POP.
  const count = session.mem.codeBlockInstructionCount();
  let jumpIndex = -1;
  for (let i = 0; i < count; i++) {
    if (session.mem.codeBlockReadInstruction(i).opcode === OP.JUMP_IF_FALSE) {
      jumpIndex = i;
    }
  }
  assert(jumpIndex !== -1, 'expected a JUMP_IF_FALSE');
  const goodTarget = session.mem.codeBlockReadInstruction(jumpIndex).operand1;
  assertEquals(session.mem.codeBlockReadInstruction(goodTarget - 1).opcode, OP.POP,
    'sanity: the branch POP sits just inside the skip range');

  const clean = verifyCodeBlockStackDepth(session.mem);
  assertEquals(clean.findings, [], 'correct emission verifies clean');

  session.mem.codeBlockPatch(jumpIndex, goodTarget - 1);

  const report = verifyCodeBlockStackDepth(session.mem);
  assert(report.findings.length >= 1, 'the mis-patched jump must be found');
  const finding = report.findings.find((f) => f.kind === 'join-mismatch');
  assert(finding, `expected a join-mismatch, got ${JSON.stringify(report.findings)}`);
  assertEquals(finding.index, goodTarget - 1,
    'the mismatch is AT the orphaned POP');
});

/**
 * Corrupt count operands must raise ERR_CORRUPT_OPERAND rather than drive an
 * unbounded write loop.
 *
 * A stomped RECONCILE_PARAMS operand1 (0x0d000020 = 218,103,840 as
 * paramCount) drove the undefined-pad
 * loop from the pending-stack block to the end of linear memory —
 * $pending_push writes blind, and the per-instruction safepoint only
 * guarantees slack for 4 values. The same class existed at MAKE_ARRAY
 * / MAKE_OBJECT (a corrupt huge count wraps the estimate's i32
 * multiply, defeating the pressure pre-check, then the copy loop
 * strides across all of memory), GRANT_END (unclamped pointer
 * subtraction), UNWIND_JUMP (try-stack pops below base with writes en
 * route), and CALL / CALL_METHOD / NEW (wild reads at
 * pending_pointer - (argc + 1) * VALUE_SIZE).
 *
 * The shared invariant, checked at each dispatch site: a count operand
 * can never exceed the real structure it indexes (operand-stack depth,
 * grant depth, try depth, $MAX_PARAMETER_COUNT). The parser never
 * emits such values — an out-of-range count IS corruption.
 *
 * Also covered here: legitimate wide parameter pads. RECONCILE_PARAMS
 * now pre-grows the pending stack for the whole pad burst (same shape
 * as the spread-unpack capacity loops), where it previously pushed
 * blind past the block's limit for any pad wider than the safepoint's
 * 4-value slack.
 */

import { assert, assertEquals } from 'https://deno.land/std@0.208.0/assert/mod.ts';
import { parseAndSetup } from './test-helpers.js';
import { freshSession } from '../../src/host-owned-session.js';
import { OP, INSTRUCTION_SIZE } from '../../src/fuel/constants.js';

const INCIDENT_PARAM_COUNT = 0x0d000020; // Representative corrupt count: 218,103,840.
const WRAPPING_COUNT = 0x10000000;       // * VALUE_SIZE (16) wraps i32 to 0

function findInstruction(mem, opcode, nth = 0) {
  const codeStart = mem.getCodeStart();
  const count = mem.view.getUint32(mem.abs(codeStart), true);
  let seen = 0;
  for (let index = 0; index < count; index++) {
    if (mem.codeBlockReadInstruction(index).opcode === opcode) {
      if (seen === nth) return index;
      seen++;
    }
  }
  throw new Error(`opcode 0x${opcode.toString(16)} not found in code block (${count} instructions)`);
}

function codeBlockChecksum(mem) {
  const codeStart = mem.getCodeStart();
  const codePointer = mem.getCodePointer();
  const count = mem.view.getUint32(mem.abs(codeStart), true);
  let hash = 0;
  for (let address = codePointer; address < codeStart + 16; address += 4) {
    hash = (Math.imul(hash, 31) + mem.view.getUint32(mem.abs(address), true)) | 0;
  }
  return { count, codePointer, hash };
}

function runExpectingCorruptOperand(session, label) {
  const before = codeBlockChecksum(session.mem);
  let thrown = null;
  try {
    session.run(0, 10_000_000);
  } catch (error) {
    thrown = error;
  }
  const after = codeBlockChecksum(session.mem);
  assert(thrown !== null, `${label}: expected an uncaught error, got none`);
  assertEquals(thrown.scriptError?.codeName, 'CORRUPT_OPERAND',
    `${label}: expected CORRUPT_OPERAND, got ${thrown.scriptError?.codeName ?? thrown.message}`);
  assert(thrown.scriptError.message.startsWith('Corrupt operand'),
    `${label}: message was "${thrown.scriptError.message}"`);
  assertEquals(after.hash, before.hash,
    `${label}: code block bytes must survive the refused instruction`);
  assertEquals(after.count, before.count,
    `${label}: code block instruction count must survive the refused instruction`);
  return thrown;
}

Deno.test('RECONCILE_PARAMS: corrupt paramCount raises CORRUPT_OPERAND, no flood', () => {
  const session = freshSession();
  parseAndSetup(session, `
    function f(a, b) { return a }
    let r = f(1, 2)
  `);
  const index = findInstruction(session.mem, OP.RECONCILE_PARAMS);
  session.mem.codeBlockPatch(index, INCIDENT_PARAM_COUNT);
  runExpectingCorruptOperand(session, 'paramCount');
});

Deno.test('RECONCILE_PARAMS: corrupt hasRest raises CORRUPT_OPERAND', () => {
  const session = freshSession();
  parseAndSetup(session, `
    function f(a) { return a }
    let r = f(1)
  `);
  const index = findInstruction(session.mem, OP.RECONCILE_PARAMS);
  session.mem.codeBlockEditInstruction(index, 'operand2', 7);
  runExpectingCorruptOperand(session, 'hasRest');
});

Deno.test('RECONCILE_PARAMS: hasRest with zero paramCount raises CORRUPT_OPERAND', () => {
  const session = freshSession();
  parseAndSetup(session, `
    function z() { return 1 }
    let r = z()
  `);
  const index = findInstruction(session.mem, OP.RECONCILE_PARAMS);
  session.mem.codeBlockEditInstruction(index, 'operand2', 1);
  runExpectingCorruptOperand(session, 'hasRest-without-params');
});

Deno.test('MAKE_ARRAY: corrupt count raises CORRUPT_OPERAND, estimate wrap unreachable', () => {
  const session = freshSession();
  parseAndSetup(session, `let a = [1, 2, 3]`);
  const index = findInstruction(session.mem, OP.MAKE_ARRAY);
  session.mem.codeBlockPatch(index, WRAPPING_COUNT);
  runExpectingCorruptOperand(session, 'MAKE_ARRAY count');
});

Deno.test('MAKE_OBJECT: corrupt count raises CORRUPT_OPERAND, estimate wrap unreachable', () => {
  const session = freshSession();
  parseAndSetup(session, `let o = { x: 1, y: 2 }`);
  const index = findInstruction(session.mem, OP.MAKE_OBJECT);
  session.mem.codeBlockPatch(index, WRAPPING_COUNT);
  runExpectingCorruptOperand(session, 'MAKE_OBJECT count');
});

Deno.test('CALL: corrupt argc raises CORRUPT_OPERAND instead of a wild closure read', () => {
  const session = freshSession();
  parseAndSetup(session, `
    function g(a) { return a }
    let r = g(5)
  `);
  const index = findInstruction(session.mem, OP.CALL);
  session.mem.codeBlockPatch(index, INCIDENT_PARAM_COUNT);
  runExpectingCorruptOperand(session, 'CALL argc');
});

Deno.test('CALL_METHOD: corrupt argc raises CORRUPT_OPERAND', () => {
  const session = freshSession();
  parseAndSetup(session, `
    let arr = [3, 1, 2]
    let r = arr.indexOf(2)
  `);
  const index = findInstruction(session.mem, OP.CALL_METHOD);
  session.mem.codeBlockPatch(index, INCIDENT_PARAM_COUNT);
  runExpectingCorruptOperand(session, 'CALL_METHOD argc');
});

Deno.test('NEW: corrupt argc raises CORRUPT_OPERAND', () => {
  const session = freshSession();
  parseAndSetup(session, `
    function Thing(v) { this.v = v }
    let t = new Thing(1)
  `);
  const index = findInstruction(session.mem, OP.NEW);
  session.mem.codeBlockPatch(index, INCIDENT_PARAM_COUNT);
  runExpectingCorruptOperand(session, 'NEW argc');
});

Deno.test('UNWIND_JUMP: corrupt unwind count raises CORRUPT_OPERAND past guest handlers', () => {
  // An UNWIND_JUMP is by construction inside a try — under the old
  // catchable raise, the enclosing finally/catch would intercept the
  // fault and relabel it (a finally rethrow turns engine errors into
  // USER_THROW). Vat faults bypass the throw machinery entirely
  // ($fault_error), so the corrupt count (0x1000 pops against a
  // 2-deep try stack) surfaces with its true code even from inside
  // try/catch/finally, refused before $unwind_toward walks below
  // base.
  const session = freshSession();
  parseAndSetup(session, `
    let caught = false
    try {
      while (true) {
        try { break } finally { let z = 1 }
      }
    } catch (e) { caught = true }
    let result = caught
  `);
  const index = findInstruction(session.mem, OP.UNWIND_JUMP);
  session.mem.codeBlockEditInstruction(index, 'operand2', 0x1000);
  runExpectingCorruptOperand(session, 'UNWIND_JUMP count');
});

Deno.test('vat faults are not catchable: corrupt CALL argc inside try/catch still surfaces', () => {
  // Guest code can neither swallow a substrate fault with catch (which would
  // make the drive report 'done' and hide the fault from the host) nor relabel
  // it through finally. The fault exits the drive directly with its true code.
  const session = freshSession();
  parseAndSetup(session, `
    function g(a) { return a }
    let swallowed = false
    try {
      g(5)
    } catch (e) { swallowed = true } finally { let z = 1 }
    let result = swallowed
  `);
  const index = findInstruction(session.mem, OP.CALL);
  session.mem.codeBlockPatch(index, INCIDENT_PARAM_COUNT);
  runExpectingCorruptOperand(session, 'CALL argc inside try/catch/finally');
});

Deno.test('GRANT_END: corrupt pop count raises CORRUPT_OPERAND', () => {
  const session = freshSession();
  // No source-level program parks at GRANT_END without a live grant
  // flow, so append a bare GRANT_END claiming 99 entries against an
  // empty grant stack and point the context at it.
  parseAndSetup(session, `let x = 1`);
  const index = session.mem.codeBlockAppend(OP.GRANT_END, 99, 0);
  session.mem.setContextInstructionIndex(0, index);
  session.mem.clearExitCondition(0);
  runExpectingCorruptOperand(session, 'GRANT_END count');
});

Deno.test('legit wide pad: 300 parameters called with no arguments', () => {
  const names = Array.from({ length: 300 }, (_, i) => `p${i}`);
  const session = freshSession();
  parseAndSetup(session, `
    function wide(${names.join(', ')}) {
      return ${names[0]} === undefined && ${names[299]} === undefined
    }
    let result = wide()
  `);
  const result = session.run(0, 10_000_000);
  assertEquals(result.status, 'done', `expected done, got ${result.status}`);
  assertEquals(session.get(0, 'result'), true);
});

Deno.test('legit wide pad: 300 parameters plus rest, called with two arguments', () => {
  const names = Array.from({ length: 300 }, (_, i) => `q${i}`);
  const session = freshSession();
  parseAndSetup(session, `
    function wideRest(${names.join(', ')}, ...tail) {
      return tail.length === 0 && ${names[299]} === undefined && ${names[0]} === 7
    }
    let result = wideRest(7, 8)
  `);
  const result = session.run(0, 10_000_000);
  assertEquals(result.status, 'done', `expected done, got ${result.status}`);
  assertEquals(session.get(0, 'result'), true);
});

Deno.test('parser refuses more than MAX_PARAMETER_COUNT parameters', () => {
  const session = freshSession();
  const params = Array(65536).fill('p').join(', ');
  let thrown = null;
  try {
    session.parse(`function tooWide(${params}) { return 1 }`);
  } catch (error) {
    thrown = error;
  }
  assert(thrown !== null, 'expected parse to throw');
  assert(String(thrown.message).includes('Too many parameters'),
    `message was "${thrown.message}"`);
});

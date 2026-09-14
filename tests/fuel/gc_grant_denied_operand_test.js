/**
 * GRANT_DENIED's operand1 (denied-clause parameter name, a string-table
 * offset) must be forwarded across string compaction.
 *
 * The collector's hardcoded string-opcode set predated GRANT_DENIED, so the
 * LET_VAR that follows it got forwarded while GRANT_DENIED kept the stale
 * offset. The WAT handler does not dereference the operand because the airlock
 * checks only the opcode at the jump target, so this produced no immediate
 * user-visible corruption. The stale offset nevertheless points into the
 * vacated table tail, which is not zeroed and is overwritten by later interns;
 * consumers such as the code differ would read garbage.
 *
 * The assertion compares GRANT_DENIED.operand1 against the operand of
 * the LET_VAR that binds the same parameter name: equal before
 * compaction, so they must stay equal after. Asserting on readString
 * alone would falsely pass — the stale bytes linger until overwritten.
 */
import { assert, assertEquals } from "https://deno.land/std@0.208.0/assert/mod.ts";
import { freshSession } from '../../src/host-owned-session.js';
import { OP } from '../../src/fuel/constants.js';

Deno.test('GRANT_DENIED param-name operand is forwarded across string compaction', () => {
  const session = freshSession();

  // Garbage strings interned BEFORE the grant program, so compaction
  // relocates everything interned after them.
  for (let i = 0; i < 50; i++) {
    session.mem.internString(`garbage_padding_string_${i}_${'x'.repeat(40)}`);
  }

  session.parse(`
    function tryIt(cap) {
      grant (cap) {
        return 1;
      } denied (revokedList) {
        return revokedList;
      }
    }
  `);

  const count = session.mem.codeBlockInstructionCount();
  let deniedIndex = -1;
  for (let i = 0; i < count; i++) {
    if (session.mem.codeBlockReadInstruction(i).opcode === OP.GRANT_DENIED) {
      deniedIndex = i;
    }
  }
  assert(deniedIndex !== -1, 'expected a GRANT_DENIED instruction');

  // The instruction after GRANT_DENIED's SCOPE_PUSH is the LET_VAR that
  // binds the same name — locate it by matching operand value instead
  // of position so the test doesn't pin emission layout.
  const offsetBefore = session.mem.codeBlockReadInstruction(deniedIndex).operand1;
  assertEquals(session.mem.readString(offsetBefore), 'revokedList');
  let letVarIndex = -1;
  for (let i = deniedIndex + 1; i < count; i++) {
    const instr = session.mem.codeBlockReadInstruction(i);
    if (instr.opcode === OP.LET_VAR && instr.operand1 === offsetBefore) {
      letVarIndex = i;
      break;
    }
  }
  assert(letVarIndex !== -1, 'expected a LET_VAR binding the denied parameter');

  const stats = session.gc();
  assert(stats.stringsCollected > 0, 'setup must force string compaction');

  const deniedAfter = session.mem.codeBlockReadInstruction(deniedIndex).operand1;
  const letVarAfter = session.mem.codeBlockReadInstruction(letVarIndex).operand1;

  // The string relocated (otherwise the test exercises nothing) ...
  assert(deniedAfter !== offsetBefore, 'param-name string must relocate in this setup');
  // ... and both operands were forwarded to the same new offset.
  assertEquals(deniedAfter, letVarAfter);
  assertEquals(session.mem.readString(deniedAfter), 'revokedList');
});

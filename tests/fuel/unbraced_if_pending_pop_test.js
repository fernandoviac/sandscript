/**
 * The deferred expression-statement POP must not escape an embedded
 * (unbraced) statement position.
 *
 * expressionStatement defers its POP (`pendingPop`) so the REPL can read
 * the last top-level expression's value. For an UNBRACED if-branch —
 * `if (c) out.push(p)` — the deferral escaped: ifStatement patched
 * JUMP_IF_FALSE to `here` while the POP was still pending, so the POP
 * flushed INTO the fall-through path, exactly at the jump target. Every
 * FALSE evaluation then executed an orphaned POP: one operand-stack
 * underflow per false branch.
 *
 * The trigger is `if (channelByName[p.channel] === undefined) out.push(p)`
 * inside a fold over resolved records. Each false branch used to underflow the
 * operand stack, so the outer `send` callee was replaced by the records array,
 * MessagePack frames acquired that array as their `kind`, and displaced string
 * ids faulted during later reads. Braced blocks were immune because block()
 * flushes the deferred POP.
 *
 * Run with: deno task test tests/fuel/unbraced_if_pending_pop_test.js
 */

import { assert, assertEquals } from "https://deno.land/std@0.208.0/assert/mod.ts";
import { freshSession } from '../../src/host-owned-session.js';
import { parseAndSetup } from './test-helpers.js';
import { OP } from '../../src/fuel/constants.js';

Deno.test('unbraced if: the branch POP stays inside the skipped range (structural)', () => {
  const session = freshSession();
  session.parse(`
    let sink = []
    let flag = false
    if (flag) sink.push(1)
  `);

  const count = session.mem.codeBlockInstructionCount();
  let jumpIndex = -1;
  for (let i = 0; i < count; i++) {
    if (session.mem.codeBlockReadInstruction(i).opcode === OP.JUMP_IF_FALSE) {
      jumpIndex = i;
    }
  }
  assert(jumpIndex !== -1, 'expected a JUMP_IF_FALSE');
  const target = session.mem.codeBlockReadInstruction(jumpIndex).operand1;

  // The instruction just before the jump target must be the branch's POP
  // — i.e. the POP is INSIDE the skipped range, not at the landing site.
  const beforeTarget = session.mem.codeBlockReadInstruction(target - 1);
  assertEquals(beforeTarget.opcode, OP.POP,
    'the then-branch expression POP must be skipped together with the branch');
});

Deno.test('unbraced if in a loop: false branches must not underflow the operand stack', () => {
  const session = freshSession();
  // The console-host shape: a mid-expression call whose body runs a loop
  // of FALSE unbraced-if branches. Pre-fix, each false branch popped one
  // outer operand — the callee slot ended up holding the loop's array.
  parseAndSetup(session, `
    let frame = null
    let deliver = (v) => { frame = v }
    let out = []
    let buildList = (n) => {
      let i = 0
      while (i < n) {
        if (i === 999999) out.push(i)
        i = i + 1
      }
      return "built-" + n
    }
    deliver({ kind: "parks-backfill", data: buildList(6) })
  `);
  const r = session.run(0, 100000);
  assertEquals(r.status, 'done',
    'pre-fix this throws "Not a function (received array)" at the deliver call');

  const frame = session.get(0, 'frame');
  assert(frame !== null && typeof frame === 'object', 'frame delivered');
  assertEquals(frame.kind, 'parks-backfill');
  assertEquals(frame.data, 'built-6');
});

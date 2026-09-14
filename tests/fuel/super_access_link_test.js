/**
 * Runtime substrate for the GET_SUPER and SET_SUPER opcodes.
 *
 * GET_SUPER (operand1 = name): [receiver, start] -> [receiver, value].
 * Walks the prototype chain FROM `start`, so the lookup skips the
 * receiver's own level; an accessor's getter runs with `this` = receiver;
 * the receiver stays on the stack under the result.
 *
 * SET_SUPER (operand1 = name): [receiver, start, value] -> [value].
 * An accessor found from `start` intercepts (setter `this` = receiver;
 * a missing setter half is a silent no-op); a data property or a miss
 * defines an OWN property on the receiver.
 *
 * These tests append both opcodes directly to the code block to isolate them
 * from parser emission.
 *
 * new_target_test.js exercises the `@newtarget` binding through
 * parser-emitted GET_VAR; raw-opcode coverage would only repeat GET_VAR.
 */

import { assert, assertEquals, assertThrows } from 'https://deno.land/std@0.208.0/assert/mod.ts';
import { parseAndSetup } from './test-helpers.js';
import { freshSession } from '../../src/host-owned-session.js';
import { OP } from '../../src/fuel/constants.js';

function runToDone(session, source, slot = 0, fuel = 100000) {
  const result = parseAndSetup(session, source, slot);
  const run = session.run(slot, fuel);
  assertEquals(run.status, 'done', `run failed: ${JSON.stringify(run)}`);
  return result;
}

/**
 * Append raw instructions after a parsed setup program and run them.
 * Each entry is [opcode, operand1?, operand2?].
 */
function appendAndRun(session, source, instructions) {
  runToDone(session, source);
  const mem = session.mem;
  let first = null;
  for (const [opcode, operand1 = 0, operand2 = 0] of instructions) {
    const index = mem.codeBlockAppend(opcode, operand1, operand2);
    if (first === null) first = index;
  }
  mem.setContextInstructionIndex(0, first);
  mem.clearExitCondition(0);
  return session.run(0, 100000);
}

const FIXTURE = `
  function Parent() {}
  Parent.prototype = {
    plain: 7,
    get title() { return this.tag + '!'; },
    set score(v) { this.stored = v * 2; },
    get onlyGet() { return 'ro'; }
  };
  let receiver = { tag: 'kid', level: 1 };
`;

// =============================================================================
// GET_SUPER
// =============================================================================

Deno.test('GET_SUPER reads a data property from the start object', () => {
  const session = freshSession();
  const S = (s) => session.mem.internString(s);
  const run = appendAndRun(session, FIXTURE, [
    [OP.GET_VAR, S('receiver')],
    [OP.GET_VAR, S('Parent')],
    [OP.GET_PROP, S('prototype')],
    [OP.GET_SUPER, S('plain')],
    [OP.LET_VAR, S('out')],
    [OP.LET_VAR, S('receiverBack')],
  ]);
  assertEquals(run.status, 'done', JSON.stringify(run));
  assertEquals(session.get(0, 'out'), 7);
  // The receiver stayed on the stack under the result.
  assertEquals(session.get(0, 'receiverBack'), { tag: 'kid', level: 1 });
});

Deno.test('GET_SUPER runs a getter with this = receiver', () => {
  const session = freshSession();
  const S = (s) => session.mem.internString(s);
  const run = appendAndRun(session, FIXTURE, [
    [OP.GET_VAR, S('receiver')],
    [OP.GET_VAR, S('Parent')],
    [OP.GET_PROP, S('prototype')],
    [OP.GET_SUPER, S('title')],
    [OP.LET_VAR, S('out')],
    [OP.POP],
  ]);
  assertEquals(run.status, 'done', JSON.stringify(run));
  assertEquals(session.get(0, 'out'), 'kid!');
});

Deno.test('GET_SUPER skips the receiver own level entirely', () => {
  const session = freshSession();
  const S = (s) => session.mem.internString(s);
  // receiver has its own `plain`; the lookup starts at the prototype and
  // must NOT see it.
  const run = appendAndRun(session, FIXTURE + `receiver.plain = 999;`, [
    [OP.GET_VAR, S('receiver')],
    [OP.GET_VAR, S('Parent')],
    [OP.GET_PROP, S('prototype')],
    [OP.GET_SUPER, S('plain')],
    [OP.LET_VAR, S('out')],
    [OP.POP],
  ]);
  assertEquals(run.status, 'done', JSON.stringify(run));
  assertEquals(session.get(0, 'out'), 7);
});

Deno.test('GET_SUPER miss reads as undefined', () => {
  const session = freshSession();
  const S = (s) => session.mem.internString(s);
  const run = appendAndRun(session, FIXTURE, [
    [OP.GET_VAR, S('receiver')],
    [OP.GET_VAR, S('Parent')],
    [OP.GET_PROP, S('prototype')],
    [OP.GET_SUPER, S('nothingHere')],
    [OP.LET_VAR, S('out')],
    [OP.POP],
  ]);
  assertEquals(run.status, 'done', JSON.stringify(run));
  assertEquals(session.get(0, 'out'), undefined);
});

Deno.test('GET_SUPER on a non-object start throws a catchable TypeError', () => {
  const session = freshSession();
  const S = (s) => session.mem.internString(s);
  const error = assertThrows(() => appendAndRun(session, FIXTURE + `let notAnObject = 42;`, [
    [OP.GET_VAR, S('receiver')],
    [OP.GET_VAR, S('notAnObject')],
    [OP.GET_SUPER, S('plain')],
    [OP.LET_VAR, S('out')],
    [OP.POP],
  ]));
  assert(String(error.message).includes('Not an object'),
    `expected TypeError shape, got: ${error.message}`);
});

// =============================================================================
// SET_SUPER
// =============================================================================

Deno.test('SET_SUPER runs an inherited setter with this = receiver', () => {
  const session = freshSession();
  const S = (s) => session.mem.internString(s);
  const run = appendAndRun(session, FIXTURE + `let v = 21;`, [
    [OP.GET_VAR, S('receiver')],
    [OP.GET_VAR, S('Parent')],
    [OP.GET_PROP, S('prototype')],
    [OP.GET_VAR, S('v')],
    [OP.SET_SUPER, S('score')],
    [OP.LET_VAR, S('result')],
    [OP.GET_VAR, S('receiver')],
    [OP.GET_PROP, S('stored')],
    [OP.LET_VAR, S('stored')],
  ]);
  assertEquals(run.status, 'done', JSON.stringify(run));
  // The assignment expression evaluates to the assigned value.
  assertEquals(session.get(0, 'result'), 21);
  // The setter wrote onto the RECEIVER, not the prototype.
  assertEquals(session.get(0, 'stored'), 42);
});

Deno.test('SET_SUPER with a setter-less accessor is a silent no-op', () => {
  const session = freshSession();
  const S = (s) => session.mem.internString(s);
  const run = appendAndRun(session, FIXTURE + `let v = 5;`, [
    [OP.GET_VAR, S('receiver')],
    [OP.GET_VAR, S('Parent')],
    [OP.GET_PROP, S('prototype')],
    [OP.GET_VAR, S('v')],
    [OP.SET_SUPER, S('onlyGet')],
    [OP.LET_VAR, S('result')],
  ]);
  assertEquals(run.status, 'done', JSON.stringify(run));
  // The expression still evaluates to the value.
  assertEquals(session.get(0, 'result'), 5);
  // No own shadow property was created on the receiver.
  assertEquals(session.get(0, 'receiver'), { tag: 'kid', level: 1 });
});

Deno.test('SET_SUPER over a chain data property defines own on the receiver', () => {
  const session = freshSession();
  const S = (s) => session.mem.internString(s);
  const run = appendAndRun(session, FIXTURE + `let v = 11;`, [
    [OP.GET_VAR, S('receiver')],
    [OP.GET_VAR, S('Parent')],
    [OP.GET_PROP, S('prototype')],
    [OP.GET_VAR, S('v')],
    [OP.SET_SUPER, S('plain')],
    [OP.LET_VAR, S('result')],
    [OP.GET_VAR, S('receiver')],
    [OP.GET_PROP, S('plain')],
    [OP.LET_VAR, S('own')],
    [OP.GET_VAR, S('Parent')],
    [OP.GET_PROP, S('prototype')],
    [OP.GET_PROP, S('plain')],
    [OP.LET_VAR, S('protoValue')],
  ]);
  assertEquals(run.status, 'done', JSON.stringify(run));
  assertEquals(session.get(0, 'result'), 11);
  assertEquals(session.get(0, 'own'), 11);
  // The prototype's data property is untouched.
  assertEquals(session.get(0, 'protoValue'), 7);
});

Deno.test('SET_SUPER miss defines own on the receiver', () => {
  const session = freshSession();
  const S = (s) => session.mem.internString(s);
  const run = appendAndRun(session, FIXTURE + `let v = 'fresh';`, [
    [OP.GET_VAR, S('receiver')],
    [OP.GET_VAR, S('Parent')],
    [OP.GET_PROP, S('prototype')],
    [OP.GET_VAR, S('v')],
    [OP.SET_SUPER, S('brandNew')],
    [OP.LET_VAR, S('result')],
    [OP.GET_VAR, S('receiver')],
    [OP.GET_PROP, S('brandNew')],
    [OP.LET_VAR, S('own')],
  ]);
  assertEquals(run.status, 'done', JSON.stringify(run));
  assertEquals(session.get(0, 'result'), 'fresh');
  assertEquals(session.get(0, 'own'), 'fresh');
});

Deno.test('GET_SUPER and SET_SUPER survive GC', () => {
  const session = freshSession();
  const S = (s) => session.mem.internString(s);
  const run = appendAndRun(session, FIXTURE + `let v = 3;`, [
    [OP.GET_VAR, S('receiver')],
    [OP.GET_VAR, S('Parent')],
    [OP.GET_PROP, S('prototype')],
    [OP.GET_VAR, S('v')],
    [OP.SET_SUPER, S('score')],
    [OP.POP],
  ]);
  assertEquals(run.status, 'done', JSON.stringify(run));
  session.gc();
  const mem = session.mem;
  const first = mem.codeBlockAppend(OP.GET_VAR, mem.internString('receiver'));
  mem.codeBlockAppend(OP.GET_VAR, mem.internString('Parent'));
  mem.codeBlockAppend(OP.GET_PROP, mem.internString('prototype'));
  mem.codeBlockAppend(OP.GET_SUPER, mem.internString('title'));
  mem.codeBlockAppend(OP.LET_VAR, mem.internString('afterGc'));
  mem.codeBlockAppend(OP.POP);
  mem.setContextInstructionIndex(0, first);
  mem.clearExitCondition(0);
  const second = session.run(0, 100000);
  assertEquals(second.status, 'done', JSON.stringify(second));
  assertEquals(session.get(0, 'afterGc'), 'kid!');
  assertEquals(session.get(0, 'receiver')?.stored, 6);
});

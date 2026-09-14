/**
 * Code differ operand-kind table coverage, kind-aware
 * decoding, unit-tree extraction, and the parser emission invariants
 * the extractor relies on.
 */
import { assert, assertEquals, assertExists } from "https://deno.land/std@0.208.0/assert/mod.ts";
import { freshSession } from '../../src/host-owned-session.js';
import { parseAndRun } from './test-helpers.js';
import { OP, OPCODE_OPERANDS, OPERAND_KIND } from '../../src/fuel/constants.js';
import { decodeInstruction, extractUnits, CLOSURE_OPCODES } from '../../src/fuel/code-diff.js';

function extractAll(session) {
  return extractUnits(session.mem, 0, session.mem.codeBlockInstructionCount());
}

// ===========================================================================
// Operand-kind table coverage
// ===========================================================================

Deno.test('every opcode has an operand-kind entry', () => {
  for (const [name, opcode] of Object.entries(OP)) {
    assertExists(OPCODE_OPERANDS[opcode], `OP.${name} (0x${opcode.toString(16)}) missing from OPCODE_OPERANDS`);
  }
});

Deno.test('every operand-kind entry maps a real opcode', () => {
  const opcodes = new Set(Object.values(OP));
  for (const key of Object.keys(OPCODE_OPERANDS)) {
    assert(opcodes.has(Number(key)), `OPCODE_OPERANDS has entry for unknown opcode ${key}`);
  }
});

Deno.test('pair kinds mark both operand slots', () => {
  for (const [opcode, kinds] of Object.entries(OPCODE_OPERANDS)) {
    for (const pairKind of [OPERAND_KIND.FLOAT64_PAIR, OPERAND_KIND.INTEGER64_PAIR]) {
      if (kinds[0] === pairKind || kinds[1] === pairKind) {
        assertEquals(kinds[0], kinds[1], `opcode ${opcode}: pair kind must occupy both slots`);
      }
    }
  }
});

// ===========================================================================
// Decoding
// ===========================================================================

Deno.test('decodeInstruction attaches operand kinds', () => {
  const session = freshSession();
  session.parse(`let greeting = 'hello';`);
  // LIT_STRING then LET_VAR.
  const lit = decodeInstruction(session.mem, 0);
  assertEquals(lit.opcode, OP.LIT_STRING);
  assertEquals(lit.operand1Kind, OPERAND_KIND.STRING_OFFSET);
  assertEquals(session.mem.readString(lit.operand1), 'hello');
  const letVar = decodeInstruction(session.mem, 1);
  assertEquals(letVar.opcode, OP.LET_VAR);
  assertEquals(letVar.operand1Kind, OPERAND_KIND.STRING_OFFSET);
  assertEquals(letVar.operand2Kind, OPERAND_KIND.INLINE);
  assertEquals(session.mem.readString(letVar.operand1), 'greeting');
});

// ===========================================================================
// Unit extraction + emission invariants
// ===========================================================================

Deno.test('function declaration: one named child, body excluded from toplevel', () => {
  const session = freshSession();
  session.parse(`function f(a) { return a + 1; } let x = f(2);`);
  const root = extractAll(session);

  assertEquals(root.kind, 'toplevel');
  assertEquals(root.children.length, 1);
  const f = root.children[0];
  assertEquals(f.kind, 'function');
  assertEquals(f.name, 'f');
  assertEquals(f.closureOpcode, OP.MAKE_CLOSURE);

  // Body range matches the MAKE_CLOSURE operands and sits 2 past it.
  const closure = decodeInstruction(session.mem, f.closureInstructionIndex);
  assertEquals(f.range, [closure.operand1, closure.operand2]);
  assertEquals(f.range[0], f.closureInstructionIndex + 2);

  // The toplevel owns no instruction inside the body.
  for (const index of root.ownedInstructionIndices) {
    assert(index < f.range[0] || index >= f.range[1],
      `toplevel owns instruction ${index} inside body range ${f.range}`);
  }
  // Body instructions are exactly the child's owned set (no grandchildren).
  assertEquals(f.ownedInstructionIndices.length, f.range[1] - f.range[0]);

  // First body instruction is RECONCILE_PARAMS.
  assertEquals(decodeInstruction(session.mem, f.range[0]).opcode, OP.RECONCILE_PARAMS);
});

Deno.test('nested arrow inside function nests in the unit tree', () => {
  const session = freshSession();
  session.parse(`function outer(xs) { let double = (v) => v * 2; return xs.map(double); }`);
  const root = extractAll(session);

  const outer = root.children[0];
  assertEquals(outer.name, 'outer');
  assertEquals(outer.children.length, 1);
  const arrow = outer.children[0];
  assertEquals(arrow.closureOpcode, OP.MAKE_ARROW_CLOSURE);
  assertEquals(arrow.name, 'double');
  // Nested body contained in parent body.
  assert(arrow.range[0] >= outer.range[0] && arrow.range[1] <= outer.range[1]);
});

Deno.test('inline arrow argument stays anonymous', () => {
  const session = freshSession();
  session.parse(`let doubled = [1, 2].map((v) => v * 2);`);
  const root = extractAll(session);
  assertEquals(root.children.length, 1);
  assertEquals(root.children[0].name, null);
});

Deno.test('async closures carry the async opcodes', () => {
  const session = freshSession();
  session.parse(`async function fetchIt(c) { return await c.get(); } let go = async () => 1;`);
  const root = extractAll(session);
  assertEquals(root.children.length, 2);
  assertEquals(root.children[0].closureOpcode, OP.MAKE_ASYNC_CLOSURE);
  assertEquals(root.children[0].name, 'fetchIt');
  assertEquals(root.children[1].closureOpcode, OP.MAKE_ASYNC_ARROW_CLOSURE);
  assertEquals(root.children[1].name, 'go');
});

Deno.test('property assignment recovers the name through SET_PROP', () => {
  const session = freshSession();
  session.parse(`let obj = {}; obj.handler = function() { return 1; };`);
  const root = extractAll(session);
  assertEquals(root.children.length, 1);
  assertEquals(root.children[0].name, 'handler');
});

Deno.test('try/catch/finally, grant/denied, and loops satisfy jump containment', () => {
  const session = freshSession();
  session.parse(`
    function risky(cap) {
      let total = 0;
      for (let i = 0; i < 3; i = i + 1) {
        if (i === 2) { break; }
        total = total + i;
      }
      while (total > 100) { total = total - 1; }
      try {
        grant (cap) {
          total = total + 1;
        } denied (revoked) {
          total = revoked.length;
        }
      } catch (e) {
        total = -1;
      } finally {
        total = total + 0;
      }
      return total;
    }
  `);
  // Extraction validates containment internally — reaching here means it held.
  const root = extractAll(session);
  const risky = root.children[0];
  assertEquals(risky.name, 'risky');

  // The body owns a TRY_PUSH and a GRANT_START with index-kind operands.
  const ownedOpcodes = risky.ownedInstructionIndices.map(
    (index) => decodeInstruction(session.mem, index).opcode);
  assert(ownedOpcodes.includes(OP.TRY_PUSH));
  assert(ownedOpcodes.includes(OP.GRANT_START));
  assert(ownedOpcodes.includes(OP.GRANT_DENIED));
});

Deno.test('sibling functions extract in source order with correct names', () => {
  const session = freshSession();
  session.parse(`
    function first() { return 1; }
    function second() { return 2; }
    let third = () => 3;
  `);
  const root = extractAll(session);
  assertEquals(root.children.map((c) => c.name), ['first', 'second', 'third']);
});

Deno.test('REPL-style append keeps earlier units stable', () => {
  const session = freshSession();
  session.parse(`function f() { return 1; }`);
  const before = extractAll(session);
  const boundary = session.mem.codeBlockInstructionCount();

  session.parse(`function g() { return 2; }`);
  const after = extractAll(session);

  // f's unit is bit-identical after the append.
  assertEquals(after.children[0].range, before.children[0].range);
  assertEquals(after.children[0].name, 'f');
  assertEquals(after.children[1].name, 'g');
  assert(after.children[1].range[0] >= boundary);
});

Deno.test('extraction works against a vat with live parked state and mutates nothing', () => {
  const session = freshSession();
  parseAndRun(session, `
    function compute(v) { return v * 2; }
    let result = compute(21);
  `);

  const codeBytesBefore = (() => {
    const count = session.mem.codeBlockInstructionCount();
    const out = [];
    for (let i = 0; i < count; i++) {
      const instr = session.mem.codeBlockReadInstruction(i);
      out.push(instr.opcode, instr.operand1, instr.operand2);
    }
    return out;
  })();

  const root = extractAll(session);
  assertEquals(root.children[0].name, 'compute');
  assertEquals(session.get(0, 'result'), 42);

  const codeBytesAfter = (() => {
    const count = session.mem.codeBlockInstructionCount();
    const out = [];
    for (let i = 0; i < count; i++) {
      const instr = session.mem.codeBlockReadInstruction(i);
      out.push(instr.opcode, instr.operand1, instr.operand2);
    }
    return out;
  })();
  assertEquals(codeBytesAfter, codeBytesBefore);
});

Deno.test('CLOSURE_OPCODES matches the operand-kind table', () => {
  // Every closure opcode is double-index-kind, and no other opcode is
  // double-index-kind except TRY_PUSH (whose operands are handler
  // targets, not a body range).
  for (const opcode of CLOSURE_OPCODES) {
    assertEquals(OPCODE_OPERANDS[opcode],
      [OPERAND_KIND.INSTRUCTION_INDEX, OPERAND_KIND.INSTRUCTION_INDEX]);
  }
  for (const [opcode, kinds] of Object.entries(OPCODE_OPERANDS)) {
    if (kinds[0] === OPERAND_KIND.INSTRUCTION_INDEX &&
        kinds[1] === OPERAND_KIND.INSTRUCTION_INDEX) {
      assert(CLOSURE_OPCODES.has(Number(opcode)) || Number(opcode) === OP.TRY_PUSH,
        `unexpected double-index opcode ${opcode}`);
    }
  }
});

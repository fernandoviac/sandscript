/**
 * Test Streaming Parser (Phase 2)
 *
 * Run with: deno task test tests/fuel/parser_test.js
 */

import { assertEquals, assert, assertThrows } from "https://deno.land/std@0.208.0/assert/mod.ts";
import { MemoryManipulator, Parser, instantiateSync, layoutVat, OP, CODE_BLOCK_FLAG } from '../../src/fuel/index.js';
import { freshSession, restoreSession, snapshotSession } from '../../src/host-owned-session.js';

function createTestContext() {
  const memory = new WebAssembly.Memory({ initial: 16, maximum: 256, shared: true });
  const wasm = instantiateSync(memory);
  const mem = new MemoryManipulator(memory);
  mem.setWasmInstance(wasm);
  layoutVat(mem.memory, mem.baseOffset, { segmentSize: mem.segmentSize });
  mem.bootstrap();
  return { memory, wasm, mem };
}

function testParse(source, expectedOps) {
  const { mem } = createTestContext();
  const parser = new Parser(mem);
  mem.allocateCodeBlock();
  parser.parse(source);

  const count = mem.codeBlockInstructionCount();
  const ops = [];
  for (let i = 0; i < count; i++) {
    const instr = mem.codeBlockReadInstruction(i);
    ops.push(instr.opcode);
  }

  for (let i = 0; i < expectedOps.length; i++) {
    assertEquals(ops[i], expectedOps[i], `Expected op[${i}] to match`);
  }

  return { ops, count };
}

// =============================================================================
// Basic Literals
// Note: Final expressions don't emit POP (deferred for REPL result)
// =============================================================================

Deno.test("Parser: integer literal", () => {
  // Integer literals emit LIT_RATIONAL_INTEGER (inline small-Rational).
  testParse('42', [OP.LIT_RATIONAL_INTEGER]);
});

Deno.test("Parser: float literal", () => {
  testParse('3.14', [OP.LIT_FLOAT]);
});

Deno.test("Parser: boolean true", () => {
  testParse('true', [OP.LIT_TRUE]);
});

Deno.test("Parser: boolean false", () => {
  testParse('false', [OP.LIT_FALSE]);
});

Deno.test("Parser: null literal", () => {
  testParse('null', [OP.LIT_NULL]);
});

Deno.test("Parser: string literal", () => {
  testParse('"hello"', [OP.LIT_STRING]);
});

// =============================================================================
// Binary Operators
// =============================================================================

Deno.test("Parser: addition", () => {
  testParse('1 + 2', [OP.LIT_RATIONAL_INTEGER, OP.LIT_RATIONAL_INTEGER, OP.ADD]);
});

Deno.test("Parser: subtraction", () => {
  testParse('5 - 3', [OP.LIT_RATIONAL_INTEGER, OP.LIT_RATIONAL_INTEGER, OP.SUB]);
});

Deno.test("Parser: multiplication", () => {
  testParse('2 * 3', [OP.LIT_RATIONAL_INTEGER, OP.LIT_RATIONAL_INTEGER, OP.MUL]);
});

Deno.test("Parser: division", () => {
  testParse('6 / 2', [OP.LIT_RATIONAL_INTEGER, OP.LIT_RATIONAL_INTEGER, OP.DIV]);
});

Deno.test("Parser: modulo", () => {
  testParse('7 % 3', [OP.LIT_RATIONAL_INTEGER, OP.LIT_RATIONAL_INTEGER, OP.MOD]);
});

Deno.test("Parser: operator precedence", () => {
  testParse('1 + 2 * 3', [
    OP.LIT_RATIONAL_INTEGER,  // 1
    OP.LIT_RATIONAL_INTEGER,  // 2
    OP.LIT_RATIONAL_INTEGER,  // 3
    OP.MUL,                   // 2 * 3
    OP.ADD,                   // 1 + (2*3)
  ]);
});

Deno.test("Parser: power operator (right-associative)", () => {
  testParse('2 ** 3 ** 2', [
    OP.LIT_RATIONAL_INTEGER,  // 2
    OP.LIT_RATIONAL_INTEGER,  // 3
    OP.LIT_RATIONAL_INTEGER,  // 2
    OP.POW,                   // 3 ** 2 = 9
    OP.POW,                   // 2 ** 9 = 512
  ]);
});

// =============================================================================
// Comparison Operators
// =============================================================================

Deno.test("Parser: strict equality", () => {
  testParse('1 === 2', [OP.LIT_RATIONAL_INTEGER, OP.LIT_RATIONAL_INTEGER, OP.EQ]);
});

Deno.test("Parser: strict inequality", () => {
  testParse('1 !== 2', [OP.LIT_RATIONAL_INTEGER, OP.LIT_RATIONAL_INTEGER, OP.NEQ]);
});

Deno.test("Parser: less than", () => {
  testParse('1 < 2', [OP.LIT_RATIONAL_INTEGER, OP.LIT_RATIONAL_INTEGER, OP.LT]);
});

Deno.test("Parser: greater than", () => {
  testParse('1 > 2', [OP.LIT_RATIONAL_INTEGER, OP.LIT_RATIONAL_INTEGER, OP.GT]);
});

Deno.test("Parser: less than or equal", () => {
  testParse('1 <= 2', [OP.LIT_RATIONAL_INTEGER, OP.LIT_RATIONAL_INTEGER, OP.LTE]);
});

Deno.test("Parser: greater than or equal", () => {
  testParse('1 >= 2', [OP.LIT_RATIONAL_INTEGER, OP.LIT_RATIONAL_INTEGER, OP.GTE]);
});

// =============================================================================
// Logical Operators
// =============================================================================

Deno.test("Parser: logical AND (short-circuit)", () => {
  testParse('a && b', [OP.GET_VAR, OP.AND, OP.GET_VAR]);
});

Deno.test("Parser: logical OR (short-circuit)", () => {
  testParse('a || b', [OP.GET_VAR, OP.OR, OP.GET_VAR]);
});

// =============================================================================
// Unary Operators
// =============================================================================

Deno.test("Parser: unary minus", () => {
  testParse('-5', [OP.LIT_RATIONAL_INTEGER, OP.NEG]);
});

Deno.test("Parser: logical not", () => {
  testParse('!true', [OP.LIT_TRUE, OP.NOT]);
});

Deno.test("Parser: typeof", () => {
  testParse('typeof x', [OP.GET_VAR, OP.TYPEOF]);
});

// =============================================================================
// Variables
// =============================================================================

Deno.test("Parser: variable declaration", () => {
  testParse('let x = 5', [OP.LIT_RATIONAL_INTEGER, OP.LET_VAR]);
});

Deno.test("Parser: variable access", () => {
  testParse('x', [OP.GET_VAR]);
});

Deno.test("Parser: variable assignment", () => {
  testParse('x = 10', [OP.LIT_RATIONAL_INTEGER, OP.SET_VAR]);
});

// =============================================================================
// Collections
// =============================================================================

Deno.test("Parser: array literal", () => {
  testParse('[1, 2, 3]', [
    OP.LIT_RATIONAL_INTEGER,
    OP.LIT_RATIONAL_INTEGER,
    OP.LIT_RATIONAL_INTEGER,
    OP.MAKE_ARRAY,
  ]);
});

Deno.test("Parser: object literal", () => {
  testParse('({ a: 1 })', [
    OP.LIT_STRING,             // key "a"
    OP.LIT_RATIONAL_INTEGER,   // value 1
    OP.MAKE_OBJECT,
  ]);
});

Deno.test("Parser: property access", () => {
  testParse('obj.foo', [OP.GET_VAR, OP.GET_PROP]);
});

Deno.test("Parser: index access", () => {
  testParse('arr[0]', [OP.GET_VAR, OP.LIT_RATIONAL_INTEGER, OP.GET_INDEX]);
});

// =============================================================================
// Functions
// =============================================================================

Deno.test("Parser: function call", () => {
  testParse('foo(1, 2)', [
    OP.GET_VAR,                // foo
    OP.LIT_RATIONAL_INTEGER,   // 1
    OP.LIT_RATIONAL_INTEGER,   // 2
    OP.CALL,
  ]);
});

Deno.test("Parser: return statement", () => {
  testParse('return 42', [OP.LIT_RATIONAL_INTEGER, OP.RETURN]);
});

Deno.test("Parser: ASI between bare return and let/const on next line", () => {
  // ECMAScript ASI: a LineTerminator after `return` terminates the statement,
  // even when the next token could otherwise start an expression.
  testParse("function f() { return\n let x = 1 }", [OP.MAKE_CLOSURE]);
  testParse("function f() { return\n const x = 1 }", [OP.MAKE_CLOSURE]);
  testParse("function f() { if (true) return\n let x = 1 }", [OP.MAKE_CLOSURE]);
  // Controls: same shapes with explicit terminators must still parse.
  testParse("function f() { return;\n let x = 1 }", [OP.MAKE_CLOSURE]);
  testParse("function f() { if (true) { return }\n let x = 1 }", [OP.MAKE_CLOSURE]);
});

// =============================================================================
// Control Flow
// =============================================================================

Deno.test("Parser: if statement", () => {
  testParse('if (true) { 1 }', [
    OP.LIT_TRUE,
    OP.JUMP_IF_FALSE,
    OP.SCOPE_PUSH,
    OP.LIT_RATIONAL_INTEGER,
    OP.POP,
    OP.SCOPE_POP,
  ]);
});

Deno.test("Parser: if-else statement", () => {
  testParse('if (true) { 1 } else { 2 }', [
    OP.LIT_TRUE,
    OP.JUMP_IF_FALSE,          // jump to else
    OP.SCOPE_PUSH,
    OP.LIT_RATIONAL_INTEGER,   // 1
    OP.POP,
    OP.SCOPE_POP,
    OP.JUMP,                   // jump over else
    OP.SCOPE_PUSH,
    OP.LIT_RATIONAL_INTEGER,   // 2
    OP.POP,
    OP.SCOPE_POP,
  ]);
});

Deno.test("Parser: while loop", () => {
  testParse('while (x) { 1 }', [
    OP.GET_VAR,                // x (condition)
    OP.JUMP_IF_FALSE,          // exit loop
    OP.SCOPE_PUSH,
    OP.LIT_RATIONAL_INTEGER,   // 1
    OP.POP,
    OP.SCOPE_POP,
    OP.JUMP,                   // back to condition
  ]);
});

// =============================================================================
// Backpatching
// =============================================================================

Deno.test("Parser: backpatching for if-else", () => {
  const { mem } = createTestContext();
  const parser = new Parser(mem);
  mem.allocateCodeBlock();
  parser.parse('if (true) { 1 } else { 2 }');
  const count = mem.codeBlockInstructionCount();

  // Find JUMP_IF_FALSE and verify it points after the then-branch
  const jumpIfFalse = mem.codeBlockReadInstruction(1);
  assertEquals(jumpIfFalse.operand1, 7, 'JUMP_IF_FALSE should jump to else branch');

  // Find JUMP and verify it points to the end of the statement (the
  // batch's two sentinel instructions — JUMP + RETURN, appended by
  // parse() for FINALLY_END return re-dispatch — sit after it).
  const jump = mem.codeBlockReadInstruction(6);
  assertEquals(jump.operand1, count - 2, 'JUMP should jump to statement end');
});

// =============================================================================
// REPL Mode
// =============================================================================

Deno.test("Parser: REPL mode - appending statements", () => {
  const { mem } = createTestContext();
  const parser = new Parser(mem);
  mem.allocateCodeBlock();

  parser.parse('let x = 1');
  const count1 = mem.codeBlockInstructionCount();

  parser.parse('let y = 2');
  const count2 = mem.codeBlockInstructionCount();

  parser.parse('x + y');
  const count3 = mem.codeBlockInstructionCount();

  // Each parse batch appends 2 sentinel instructions (JUMP + RETURN,
  // for FINALLY_END return re-dispatch) after its statements.
  assertEquals(count1, 4, 'First batch: 2 statement instructions + 2 sentinels');
  assertEquals(count2, 8, 'Second batch appends 2 + 2 more');
  // Final expression doesn't emit POP (deferred for REPL result)
  assertEquals(count3, 13, 'Third batch: 3 expression instructions + 2 sentinels (no final POP)');
});

// =============================================================================
// Grant Statements
// =============================================================================

Deno.test("Parser: grant single identifier", () => {
  // grant "fs" { }
  // Should emit: LIT_STRING, GRANT_START, SCOPE_PUSH, SCOPE_POP, GRANT_END, JUMP
  testParse('grant "fs" { }', [
    OP.LIT_STRING,
    OP.GRANT_START,
    OP.SCOPE_PUSH,
    OP.SCOPE_POP,
    OP.GRANT_END,
    OP.JUMP,
  ]);
});

Deno.test("Parser: grant with denied block", () => {
  // grant "fs" { } denied { }
  testParse('grant "fs" { } denied { }', [
    OP.LIT_STRING,
    OP.GRANT_START,
    OP.SCOPE_PUSH,
    OP.SCOPE_POP,
    OP.GRANT_END,
    OP.JUMP,
    OP.GRANT_DENIED,
    OP.SCOPE_PUSH,
    OP.SCOPE_POP,
  ]);
});

Deno.test("Parser: grant with denied parameter", () => {
  // grant "fs" { } denied (e) { }
  testParse('grant "fs" { } denied (e) { }', [
    OP.LIT_STRING,
    OP.GRANT_START,
    OP.SCOPE_PUSH,
    OP.SCOPE_POP,
    OP.GRANT_END,
    OP.JUMP,
    OP.GRANT_DENIED,
    OP.SCOPE_PUSH,
    OP.LET_VAR,  // bind e
    OP.SCOPE_POP,
  ]);
});

Deno.test("Parser: grant multiple identifiers", () => {
  // grant ("a", "b") { }
  testParse('grant ("a", "b") { }', [
    OP.LIT_STRING,  // "a"
    OP.LIT_STRING,  // "b"
    OP.GRANT_START, // pops 2 identifiers
    OP.SCOPE_PUSH,
    OP.SCOPE_POP,
    OP.GRANT_END,
    OP.JUMP,
  ]);
});

// =============================================================================
// Comments
// =============================================================================

Deno.test("Parser: single-line comments are skipped", () => {
  // Comments should not affect bytecode output
  testParse('let x = 1; // this is a comment\nx + 2', [
    OP.LIT_RATIONAL_INTEGER,   // 1
    OP.LET_VAR,                // let x
    OP.GET_VAR,                // x
    OP.LIT_RATIONAL_INTEGER,   // 2
    OP.ADD,
  ]);
});

Deno.test("Parser: multi-line comments are skipped", () => {
  testParse('/* comment */ let x = 1; /* another */ x', [
    OP.LIT_RATIONAL_INTEGER,
    OP.LET_VAR,
    OP.GET_VAR,
  ]);
});

Deno.test("Parser: comment between tokens", () => {
  testParse('1 /* plus */ + /* two */ 2', [
    OP.LIT_RATIONAL_INTEGER,
    OP.LIT_RATIONAL_INTEGER,
    OP.ADD,
  ]);
});

// =============================================================================
// Trailing commas in comma-separated lists
// =============================================================================

function expectParseOk(source) {
  const { mem } = createTestContext();
  const parser = new Parser(mem);
  mem.allocateCodeBlock();
  parser.parse(source);
}

function expectParseError(source) {
  assertThrows(() => {
    const { mem } = createTestContext();
    const parser = new Parser(mem);
    mem.allocateCodeBlock();
    parser.parse(source);
  });
}

Deno.test("Parser: trailing comma in call args", () => {
  expectParseOk('foo(a, b,)');
  expectParseOk('foo(a,)');
});

Deno.test("Parser: trailing comma in array literal", () => {
  expectParseOk('[1, 2, 3,]');
  expectParseOk('[1,]');
});

Deno.test("Parser: trailing comma in object literal", () => {
  expectParseOk('let x = {a: 1, b: 2,}');
  expectParseOk('let x = {a: 1,}');
});

Deno.test("Parser: trailing comma in object method shorthand", () => {
  expectParseOk('let x = { foo() {}, }');
});

Deno.test("Parser: trailing comma in function declaration params", () => {
  expectParseOk('function f(a, b,) {}');
});

Deno.test("Parser: trailing comma in arrow function params", () => {
  expectParseOk('let f = (a, b,) => a + b');
  expectParseOk('let f = (a,) => a');
});

Deno.test("Parser: empty arrow params still work", () => {
  expectParseOk('let f = () => 1');
});

Deno.test("Parser: trailing comma in new expression args", () => {
  expectParseOk('new Foo(a, b,)');
});

Deno.test("Parser: trailing comma in optional call", () => {
  expectParseOk('obj?.(a, b,)');
});

Deno.test("Parser: bare comma in empty call list rejected", () => {
  expectParseError('foo(,)');
});

Deno.test("Parser: double trailing comma rejected", () => {
  expectParseError('foo(a,,)');
});

Deno.test("Parser: elision in arg list rejected", () => {
  expectParseError('foo(a,,b)');
});

Deno.test("Parser: bare comma in empty array rejected", () => {
  expectParseError('[,]');
});

Deno.test("Parser: array elision rejected (out of scope)", () => {
  expectParseError('[1,,3]');
});

Deno.test("Parser: bare comma in empty object rejected", () => {
  expectParseError('let x = {,}');
});

Deno.test("Parser: bare comma in empty function params rejected", () => {
  expectParseError('function f(,) {}');
});

// =============================================================================
// Reserved-keyword diagnostics
//
// SandScript reserves a handful of keywords beyond the standard JS set
// — notably `grant` and `denied`, which support the grant block syntax.
// Authors writing JS-flavored drone code can be surprised when a name
// like `let denied = ...` rejects with the bare "Expected variable
// name" message. The parser detects this case and produces a clear
// error that names the offending token. SS-only keywords get a
// stronger hint than JS-overlapping keywords.
// =============================================================================

function captureParseError(source) {
  const { mem } = createTestContext();
  const parser = new Parser(mem);
  mem.allocateCodeBlock();
  try {
    parser.parse(source);
    return null;
  } catch (error) {
    return error;
  }
}

Deno.test("Parser: 'denied' as variable name names the keyword in the error", () => {
  const error = captureParseError('let denied = null');
  assert(error, 'expected parse to fail');
  assert(/'denied' is a reserved keyword in SandScript/.test(error.message),
    `expected SandScript-only keyword hint in error, got: ${error.message}`);
});

Deno.test("Parser: 'grant' as variable name names the keyword in the error", () => {
  const error = captureParseError('let grant = null');
  assert(error, 'expected parse to fail');
  assert(/'grant' is a reserved keyword in SandScript/.test(error.message),
    `expected SandScript-only keyword hint in error, got: ${error.message}`);
});

Deno.test("Parser: 'denied' as function name names the keyword in the error", () => {
  const error = captureParseError('function denied() {}');
  assert(error, 'expected parse to fail');
  assert(/'denied' is a reserved keyword in SandScript/.test(error.message),
    `expected SandScript-only keyword hint in error, got: ${error.message}`);
});

Deno.test("Parser: standard JS keyword as variable name still names the keyword", () => {
  // Standard JS keywords (`try`, `if`, etc.) get a less verbose hint
  // since drone authors won't be surprised — they just need to be
  // told which token clashed.
  const error = captureParseError('let try = 1');
  assert(error, 'expected parse to fail');
  assert(/'try' is a reserved keyword/.test(error.message),
    `expected keyword hint in error, got: ${error.message}`);
});

Deno.test("Parser: 'grant' / 'denied' as property name after dot is allowed", () => {
  // After a dot, reserved words are allowed as property names — the
  // existing consumePropertyName path covers this. The error path we
  // added shouldn't kick in.
  expectParseOk('obj.grant');
  expectParseOk('obj.denied');
});

// =============================================================================
// Hidden-binding counter across snapshot/restore
// =============================================================================

Deno.test("Parser: synthesized temps don't collide after snapshot/restore reparse", () => {
  // A restored session reconstructs the Parser. The @dst_* / @spread_*
  // counter used to restart at 0 and REDECLARATION against the bindings
  // an earlier parse left in the persisted top-level scope (hit by every
  // second `sand script` using spread or destructuring in one session).
  // The counter is now seeded from the code block's append position.
  function runIncrement(session, source) {
    const parseResult = session.parse(source);
    session.mem.setContextInstructionIndex(0, parseResult.startIndex);
    const result = session.run(0, 1_000_000);
    if (result.status === 'error') throw new Error(result.error.message);
  }

  const session = freshSession();
  runIncrement(session, 'let arr = [1, 2, 3]');
  runIncrement(session, 'let len = arr.push(...[4, 5])');

  const snap1 = snapshotSession(session);
  const restored = restoreSession(snap1.vatBytes, snap1.membraneBytes);
  runIncrement(restored, 'let m = Math.max(...[1, 9, 3])');
  runIncrement(restored, 'let {a} = {a: 1}');

  const snap2 = snapshotSession(restored);
  const restoredTwice = restoreSession(snap2.vatBytes, snap2.membraneBytes);
  runIncrement(restoredTwice, 'let {b} = {b: 2}');
  runIncrement(restoredTwice, 'let tail = [...arr, 6]');

  assertEquals(restoredTwice.get(0, 'len'), 5);
  assertEquals(restoredTwice.get(0, 'm'), 9);
  assertEquals(restoredTwice.get(0, 'a'), 1);
  assertEquals(restoredTwice.get(0, 'b'), 2);
  assertEquals(restoredTwice.get(0, 'tail').length, 6);
});

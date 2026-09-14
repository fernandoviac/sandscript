/**
 * Tests for the AST module (writer + reader).
 *
 * Slice 3 hooks the writer into the parser. These tests exercise the
 * encoding/decoding directly: every node type roundtrips, the multi-root
 * chain links correctly, and structural fields (operator kinds, flags,
 * intern offsets) survive a write→read pass.
 *
 * Run with: deno task test tests/fuel/ast_test.js
 */

import { assertEquals, assert } from "https://deno.land/std@0.208.0/assert/mod.ts";
import { createSession } from '../../src/fuel/session.js';
import {
  createAstWriter,
  createAstReader,
  DIALECT_SAND,
  FORMAT_VERSION,
  NODE,
  BinaryOp,
  LogicalOp,
  UnaryOp,
  UpdateOp,
  AssignOp,
  FLAG,
} from '../../src/fuel/ast.js';
import { freshSession, restoreSession, snapshotSession } from '../../src/host-owned-session.js';

function setup() {
  const session = freshSession({ inlineSource: true });
  const writer = createAstWriter(session.mem);
  const reader = createAstReader(session.mem);
  writer.initialize();
  return { session, writer, reader };
}

// =============================================================================
// Writer initializes header with SS dialect and format version
// =============================================================================

Deno.test("AST: writer initialize stamps SS dialect and version", () => {
  const session = freshSession({ inlineSource: true });
  const writer = createAstWriter(session.mem);
  writer.initialize();
  const header = session.getAstRegionHeader();
  assertEquals(header.dialect, DIALECT_SAND);
  assertEquals(header.formatVersion, FORMAT_VERSION);
  assertEquals(header.rootNodeOffset, 0);
  assertEquals(header.lastRootOffset, 0);
});

// =============================================================================
// Literals
// =============================================================================

Deno.test("AST: LiteralInteger roundtrip", () => {
  const { writer, reader } = setup();
  const off = writer.writeLiteralInteger(42n);
  const node = reader.readNode(off);
  assertEquals(node.type, 'LITERAL_INTEGER');
  assertEquals(node.value, 42n);
});

Deno.test("AST: LiteralInteger negative and large", () => {
  const { writer, reader } = setup();
  const a = writer.writeLiteralInteger(-1n);
  const b = writer.writeLiteralInteger(9007199254740993n); // > Number.MAX_SAFE_INTEGER
  assertEquals(reader.readNode(a).value, -1n);
  assertEquals(reader.readNode(b).value, 9007199254740993n);
});

Deno.test("AST: LiteralFloat roundtrip", () => {
  const { writer, reader } = setup();
  const off = writer.writeLiteralFloat(3.14);
  assertEquals(reader.readNode(off).value, 3.14);
});

Deno.test("AST: LiteralBoolean", () => {
  const { writer, reader } = setup();
  const t = writer.writeLiteralBoolean(true);
  const f = writer.writeLiteralBoolean(false);
  assertEquals(reader.readNode(t).value, true);
  assertEquals(reader.readNode(f).value, false);
});

Deno.test("AST: LiteralNull and LiteralUndefined", () => {
  const { writer, reader } = setup();
  const n = writer.writeLiteralNull();
  const u = writer.writeLiteralUndefined();
  assertEquals(reader.readNode(n).type, 'LITERAL_NULL');
  assertEquals(reader.readNode(u).type, 'LITERAL_UNDEFINED');
});

Deno.test("AST: LiteralString resolves intern offset to text", () => {
  const { session, writer, reader } = setup();
  const internOff = session.mem.internString('hello');
  const off = writer.writeLiteralString(internOff);
  const node = reader.readNode(off);
  assertEquals(node.value, 'hello');
});

Deno.test("AST: LiteralRational roundtrip", () => {
  const { writer, reader } = setup();
  const off = writer.writeLiteralRational(7n, 3n);
  const node = reader.readNode(off);
  assertEquals(node.numerator, 7n);
  assertEquals(node.denominator, 3n);
});

Deno.test("AST: LiteralBigInt roundtrip via decimal-string intern", () => {
  const { session, writer, reader } = setup();
  const big = '12345678901234567890';
  const internOff = session.mem.internString(big);
  const off = writer.writeLiteralBigInt(internOff);
  assertEquals(reader.readNode(off).value, BigInt(big));
});

// =============================================================================
// Names and access
// =============================================================================

Deno.test("AST: Identifier resolves name", () => {
  const { session, writer, reader } = setup();
  const off = writer.writeIdentifier(session.mem.internString('foo'));
  assertEquals(reader.readNode(off).name, 'foo');
});

Deno.test("AST: This and Super", () => {
  const { writer, reader } = setup();
  assertEquals(reader.readNode(writer.writeThis()).type, 'THIS');
  assertEquals(reader.readNode(writer.writeSuper()).type, 'SUPER');
});

Deno.test("AST: MemberAccess and IndexAccess", () => {
  const { session, writer, reader } = setup();
  const obj = writer.writeIdentifier(session.mem.internString('a'));
  const member = writer.writeMemberAccess(obj, session.mem.internString('b'));
  const index = writer.writeLiteralInteger(0n);
  const indexed = writer.writeIndexAccess(obj, index);

  const m = reader.readNode(member);
  assertEquals(m.type, 'MEMBER_ACCESS');
  assertEquals(m.name, 'b');
  assertEquals(m.object, obj);

  const i = reader.readNode(indexed);
  assertEquals(i.type, 'INDEX_ACCESS');
  assertEquals(i.index, index);
});

// =============================================================================
// Operators
// =============================================================================

Deno.test("AST: BinaryOp encodes operator kind", () => {
  const { session, writer, reader } = setup();
  const x = writer.writeIdentifier(session.mem.internString('x'));
  const five = writer.writeLiteralInteger(5n);
  const sum = writer.writeBinaryOp(BinaryOp.PLUS, x, five);
  const node = reader.readNode(sum);
  assertEquals(node.type, 'BINARY_OP');
  assertEquals(node.op, 'PLUS');
  assertEquals(node.opKind, BinaryOp.PLUS);
  assertEquals(node.left, x);
  assertEquals(node.right, five);
});

Deno.test("AST: All BinaryOp kinds round trip", () => {
  const { session, writer, reader } = setup();
  const x = writer.writeIdentifier(session.mem.internString('x'));
  const y = writer.writeIdentifier(session.mem.internString('y'));
  for (const [name, kind] of Object.entries(BinaryOp)) {
    const off = writer.writeBinaryOp(kind, x, y);
    const node = reader.readNode(off);
    assertEquals(node.op, name, `kind=${name}`);
  }
});

Deno.test("AST: LogicalOp distinguishes from BinaryOp", () => {
  const { session, writer, reader } = setup();
  const x = writer.writeIdentifier(session.mem.internString('x'));
  const y = writer.writeIdentifier(session.mem.internString('y'));
  const off = writer.writeLogicalOp(LogicalOp.AMP_AMP, x, y);
  const node = reader.readNode(off);
  assertEquals(node.type, 'LOGICAL_OP');
  assertEquals(node.op, 'AMP_AMP');
});

Deno.test("AST: UnaryOp", () => {
  const { session, writer, reader } = setup();
  const x = writer.writeIdentifier(session.mem.internString('x'));
  const off = writer.writeUnaryOp(UnaryOp.BANG, x);
  const node = reader.readNode(off);
  assertEquals(node.op, 'BANG');
  assertEquals(node.operand, x);
});

Deno.test("AST: Update encodes prefix flag", () => {
  const { session, writer, reader } = setup();
  const x = writer.writeIdentifier(session.mem.internString('x'));
  const pre = writer.writeUpdate(UpdateOp.PLUS_PLUS, x, true);
  const post = writer.writeUpdate(UpdateOp.PLUS_PLUS, x, false);
  assertEquals(reader.readNode(pre).prefix, true);
  assertEquals(reader.readNode(post).prefix, false);
});

Deno.test("AST: Assignment distinguishes = from +=", () => {
  const { session, writer, reader } = setup();
  const x = writer.writeIdentifier(session.mem.internString('x'));
  const v = writer.writeLiteralInteger(1n);
  const eq = writer.writeAssignment(AssignOp.EQ, x, v);
  const plusEq = writer.writeAssignment(AssignOp.PLUS_EQ, x, v);
  assertEquals(reader.readNode(eq).op, 'EQ');
  assertEquals(reader.readNode(plusEq).op, 'PLUS_EQ');
});

Deno.test("AST: Conditional", () => {
  const { session, writer, reader } = setup();
  const t = writer.writeIdentifier(session.mem.internString('t'));
  const a = writer.writeLiteralInteger(1n);
  const b = writer.writeLiteralInteger(2n);
  const off = writer.writeConditional(t, a, b);
  const node = reader.readNode(off);
  assertEquals(node.test, t);
  assertEquals(node.consequent, a);
  assertEquals(node.alternate, b);
});

Deno.test("AST: Sequence of expressions", () => {
  const { writer, reader } = setup();
  const a = writer.writeLiteralInteger(1n);
  const b = writer.writeLiteralInteger(2n);
  const c = writer.writeLiteralInteger(3n);
  const off = writer.writeSequence([a, b, c]);
  const node = reader.readNode(off);
  assertEquals(node.expressions, [a, b, c]);
});

// =============================================================================
// Calls
// =============================================================================

Deno.test("AST: Call with multiple args", () => {
  const { session, writer, reader } = setup();
  const callee = writer.writeIdentifier(session.mem.internString('f'));
  const args = [
    writer.writeLiteralInteger(1n),
    writer.writeLiteralInteger(2n),
    writer.writeLiteralInteger(3n),
  ];
  const off = writer.writeCall(callee, args);
  const node = reader.readNode(off);
  assertEquals(node.type, 'CALL');
  assertEquals(node.callee, callee);
  assertEquals(node.args, args);
});

Deno.test("AST: Call with zero args", () => {
  const { session, writer, reader } = setup();
  const callee = writer.writeIdentifier(session.mem.internString('f'));
  const off = writer.writeCall(callee, []);
  const node = reader.readNode(off);
  assertEquals(node.args, []);
});

Deno.test("AST: New", () => {
  const { session, writer, reader } = setup();
  const ctor = writer.writeIdentifier(session.mem.internString('Foo'));
  const off = writer.writeNew(ctor, []);
  assertEquals(reader.readNode(off).type, 'NEW');
});

// =============================================================================
// Control flow
// =============================================================================

Deno.test("AST: If with and without alternate", () => {
  const { writer, reader } = setup();
  const t = writer.writeLiteralBoolean(true);
  const cons = writer.writeBlock([]);
  const alt = writer.writeBlock([]);
  const ifWith = writer.writeIf(t, cons, alt);
  const ifWithout = writer.writeIf(t, cons, 0);
  const a = reader.readNode(ifWith);
  const b = reader.readNode(ifWithout);
  assertEquals(a.hasAlternate, true);
  assertEquals(a.alternate, alt);
  assertEquals(b.hasAlternate, false);
  assertEquals(b.alternate, 0);
});

Deno.test("AST: While", () => {
  const { writer, reader } = setup();
  const t = writer.writeLiteralBoolean(true);
  const body = writer.writeBlock([]);
  const off = writer.writeWhile(t, body);
  const node = reader.readNode(off);
  assertEquals(node.test, t);
  assertEquals(node.body, body);
});

Deno.test("AST: For with all parts", () => {
  const { session, writer, reader } = setup();
  const init = writer.writeVariableDecl(
    [writer.writeVariableBinding(session.mem.internString('i'), writer.writeLiteralInteger(0n))],
    false
  );
  const test = writer.writeLiteralBoolean(true);
  const update = writer.writeUpdate(UpdateOp.PLUS_PLUS, writer.writeIdentifier(session.mem.internString('i')), false);
  const body = writer.writeBlock([]);
  const off = writer.writeFor(init, test, update, body);
  const node = reader.readNode(off);
  assertEquals(node.init, init);
  assertEquals(node.test, test);
  assertEquals(node.update, update);
  assertEquals(node.body, body);
});

Deno.test("AST: Return with and without value", () => {
  const { writer, reader } = setup();
  const v = writer.writeLiteralInteger(1n);
  const withVal = writer.writeReturn(v);
  const bare = writer.writeReturn(0);
  assertEquals(reader.readNode(withVal).value, v);
  assertEquals(reader.readNode(bare).value, null);
});

Deno.test("AST: Try with catch only and finally only and both", () => {
  const { session, writer, reader } = setup();
  const block = writer.writeBlock([]);
  const catchParam = writer.writeVariableBinding(session.mem.internString('e'), 0);
  const catchBlock = writer.writeBlock([]);
  const finallyBlock = writer.writeBlock([]);

  const both = writer.writeTry(block, catchParam, catchBlock, finallyBlock);
  const catchOnly = writer.writeTry(block, catchParam, catchBlock, 0);
  const finallyOnly = writer.writeTry(block, 0, 0, finallyBlock);

  const a = reader.readNode(both);
  assertEquals(a.hasCatch, true);
  assertEquals(a.hasFinally, true);

  const b = reader.readNode(catchOnly);
  assertEquals(b.hasCatch, true);
  assertEquals(b.hasFinally, false);

  const c = reader.readNode(finallyOnly);
  assertEquals(c.hasCatch, false);
  assertEquals(c.hasFinally, true);
});

Deno.test("AST: Throw", () => {
  const { writer, reader } = setup();
  const v = writer.writeLiteralInteger(1n);
  const off = writer.writeThrow(v);
  assertEquals(reader.readNode(off).value, v);
});

Deno.test("AST: Break and Continue with labels", () => {
  const { session, writer, reader } = setup();
  const labeled = writer.writeBreak(session.mem.internString('outer'));
  const bare = writer.writeBreak(0);
  assertEquals(reader.readNode(labeled).label, 'outer');
  assertEquals(reader.readNode(bare).label, null);
});

// =============================================================================
// Declarations
// =============================================================================

Deno.test("AST: FunctionDecl with name and params", () => {
  const { session, writer, reader } = setup();
  const body = writer.writeBlock([]);
  const params = [
    writer.writeVariableBinding(session.mem.internString('x'), 0),
    writer.writeVariableBinding(session.mem.internString('y'), 0),
  ];
  const off = writer.writeFunctionDecl({
    nameOffset: session.mem.internString('add'),
    params,
    body,
    flags: 0,
  });
  const node = reader.readNode(off);
  assertEquals(node.name, 'add');
  assertEquals(node.params, params);
  assertEquals(node.body, body);
  assertEquals(node.isAsync, false);
  assertEquals(node.isArrow, false);
});

Deno.test("AST: FunctionDecl flags — async, arrow", () => {
  const { writer, reader } = setup();
  const body = writer.writeBlock([]);
  const arrowAsync = writer.writeFunctionDecl({
    params: [],
    body,
    flags: FLAG.FN_ASYNC | FLAG.FN_ARROW,
  });
  const node = reader.readNode(arrowAsync);
  assertEquals(node.isAsync, true);
  assertEquals(node.isArrow, true);
  assertEquals(node.name, null);  // anonymous
});

Deno.test("AST: VariableDecl with multiple bindings", () => {
  const { session, writer, reader } = setup();
  const a = writer.writeVariableBinding(session.mem.internString('a'), writer.writeLiteralInteger(1n));
  const b = writer.writeVariableBinding(session.mem.internString('b'), writer.writeLiteralInteger(2n));
  const off = writer.writeVariableDecl([a, b], false);
  const node = reader.readNode(off);
  assertEquals(node.bindings, [a, b]);
  assertEquals(node.isConst, false);
});

Deno.test("AST: VariableDecl const", () => {
  const { session, writer, reader } = setup();
  const a = writer.writeVariableBinding(session.mem.internString('x'), writer.writeLiteralInteger(1n));
  const off = writer.writeVariableDecl([a], true);
  assertEquals(reader.readNode(off).isConst, true);
});

Deno.test("AST: VariableBinding hasInitializer flag", () => {
  const { session, writer, reader } = setup();
  const init = writer.writeLiteralInteger(1n);
  const withInit = writer.writeVariableBinding(session.mem.internString('a'), init);
  const noInit = writer.writeVariableBinding(session.mem.internString('b'), 0);
  assertEquals(reader.readNode(withInit).hasInitializer, true);
  assertEquals(reader.readNode(withInit).initializer, init);
  assertEquals(reader.readNode(noInit).hasInitializer, false);
  assertEquals(reader.readNode(noInit).initializer, null);
});

Deno.test("AST: Block with statements", () => {
  const { writer, reader } = setup();
  const a = writer.writeExpressionStatement(writer.writeLiteralInteger(1n));
  const b = writer.writeExpressionStatement(writer.writeLiteralInteger(2n));
  const off = writer.writeBlock([a, b]);
  const node = reader.readNode(off);
  assertEquals(node.statements, [a, b]);
});

// =============================================================================
// Composite literals
// =============================================================================

Deno.test("AST: ArrayLiteral", () => {
  const { writer, reader } = setup();
  const a = writer.writeLiteralInteger(1n);
  const b = writer.writeLiteralInteger(2n);
  const off = writer.writeArrayLiteral([a, b]);
  assertEquals(reader.readNode(off).elements, [a, b]);
});

Deno.test("AST: ObjectLiteral with property flags", () => {
  const { session, writer, reader } = setup();
  const key = writer.writeIdentifier(session.mem.internString('k'));
  const value = writer.writeLiteralInteger(1n);
  const shorthand = writer.writeObjectProperty(key, value, FLAG.PROP_SHORTHAND);
  const computed = writer.writeObjectProperty(key, value, FLAG.PROP_COMPUTED);
  const off = writer.writeObjectLiteral([shorthand, computed]);
  const node = reader.readNode(off);
  assertEquals(node.properties.length, 2);
  assertEquals(reader.readNode(shorthand).isShorthand, true);
  assertEquals(reader.readNode(computed).isComputed, true);
});

// =============================================================================
// Async
// =============================================================================

Deno.test("AST: Await", () => {
  const { session, writer, reader } = setup();
  const arg = writer.writeIdentifier(session.mem.internString('p'));
  const off = writer.writeAwait(arg);
  assertEquals(reader.readNode(off).argument, arg);
});

// =============================================================================
// Root chain
// =============================================================================

Deno.test("AST: single root commit sets first and last to same offset", () => {
  const { session, writer, reader } = setup();
  const body = writer.writeBlock([]);
  const root = writer.writeRoot(body);
  writer.commitRoot(root);

  const header = session.getAstRegionHeader();
  assertEquals(header.rootNodeOffset, root);
  assertEquals(header.lastRootOffset, root);

  const roots = [...reader.iterateRoots()];
  assertEquals(roots.length, 1);
  assertEquals(roots[0], root);

  // Single root has nextRoot = 0.
  const node = reader.readNode(root);
  assertEquals(node.nextRoot, 0);
});

Deno.test("AST: multiple roots chain in append order", () => {
  const { session, writer, reader } = setup();
  const r1 = writer.writeRoot(writer.writeBlock([]));
  writer.commitRoot(r1);
  const r2 = writer.writeRoot(writer.writeBlock([]));
  writer.commitRoot(r2);
  const r3 = writer.writeRoot(writer.writeBlock([]));
  writer.commitRoot(r3);

  const header = session.getAstRegionHeader();
  assertEquals(header.rootNodeOffset, r1);
  assertEquals(header.lastRootOffset, r3);

  const roots = [...reader.iterateRoots()];
  assertEquals(roots, [r1, r2, r3]);

  // The chain itself: r1.nextRoot === r2, r2.nextRoot === r3, r3.nextRoot === 0.
  assertEquals(reader.readNode(r1).nextRoot, r2);
  assertEquals(reader.readNode(r2).nextRoot, r3);
  assertEquals(reader.readNode(r3).nextRoot, 0);
});

// =============================================================================
// Recursive read
// =============================================================================

Deno.test("AST: readTree expands nested children", () => {
  const { session, writer, reader } = setup();
  const x = writer.writeIdentifier(session.mem.internString('x'));
  const five = writer.writeLiteralInteger(5n);
  const sum = writer.writeBinaryOp(BinaryOp.PLUS, x, five);
  const tree = reader.readTree(sum);
  assertEquals(tree.type, 'BINARY_OP');
  assertEquals(tree.op, 'PLUS');
  assertEquals(tree.left.type, 'IDENTIFIER');
  assertEquals(tree.left.name, 'x');
  assertEquals(tree.right.type, 'LITERAL_INTEGER');
  assertEquals(tree.right.value, 5n);
});

Deno.test("AST: readTree returns null at sentinel offsets", () => {
  const { writer, reader } = setup();
  const ifNoAlt = writer.writeIf(writer.writeLiteralBoolean(true), writer.writeBlock([]), 0);
  const tree = reader.readTree(ifNoAlt);
  assertEquals(tree.alternate, null);
});

// =============================================================================
// Roundtrip with toBytes / fromBytes
// =============================================================================

Deno.test("AST: written tree survives toBytes/fromBytes", () => {
  const original = freshSession({ inlineSource: true });
  const writer = createAstWriter(original.mem);
  writer.initialize();
  const x = writer.writeIdentifier(original.mem.internString('x'));
  const five = writer.writeLiteralInteger(5n);
  const sum = writer.writeBinaryOp(BinaryOp.PLUS, x, five);
  const root = writer.writeRoot(writer.writeBlock([writer.writeExpressionStatement(sum)]));
  writer.commitRoot(root);

  const bytes = snapshotSession(original).vatBytes;
  const restored = restoreSession(bytes, null);
  const reader = createAstReader(restored.mem);

  const roots = [...reader.iterateRoots()];
  assertEquals(roots.length, 1);
  const rootNode = reader.readTree(roots[0]);
  assertEquals(rootNode.type, 'ROOT');
  assertEquals(rootNode.body.statements[0].expression.type, 'BINARY_OP');
  assertEquals(rootNode.body.statements[0].expression.op, 'PLUS');
  assertEquals(rootNode.body.statements[0].expression.left.name, 'x');
  assertEquals(rootNode.body.statements[0].expression.right.value, 5n);
});

/**
 * End-to-end tests for slice 3: parser produces AST nodes that decode back
 * via the reader to the structure the source describes.
 *
 * Run with: deno task test tests/fuel/ast_parser_integration_test.js
 */

import { assertEquals, assert } from "https://deno.land/std@0.208.0/assert/mod.ts";
import { createSession } from '../../src/fuel/session.js';
import { createAstReader, NODE } from '../../src/fuel/ast.js';
import { freshSession } from '../../src/host-owned-session.js';

function setup(source) {
  const session = freshSession({ inlineSource: true });
  session.parse(source);
  const reader = createAstReader(session.mem);
  const roots = [...reader.iterateRoots()];
  return { session, reader, roots };
}

// =============================================================================
// Top-level shape
// =============================================================================

Deno.test("Parser AST: produces exactly one root per parse", () => {
  const { roots } = setup('let x = 1');
  assertEquals(roots.length, 1);
});

Deno.test("Parser AST: multiple parse() calls produce multiple roots in order", () => {
  const session = freshSession({ inlineSource: true });
  session.parse('let x = 1');
  session.parse('let y = 2');
  session.parse('let z = 3');
  const reader = createAstReader(session.mem);
  const roots = [...reader.iterateRoots()];
  assertEquals(roots.length, 3);

  const r0 = reader.readTree(roots[0]);
  assertEquals(r0.body.statements[0].bindings[0].name, 'x');
  const r1 = reader.readTree(roots[1]);
  assertEquals(r1.body.statements[0].bindings[0].name, 'y');
  const r2 = reader.readTree(roots[2]);
  assertEquals(r2.body.statements[0].bindings[0].name, 'z');
});

// =============================================================================
// Literals and identifiers
// =============================================================================

Deno.test("Parser AST: integer literal", () => {
  const { reader, roots } = setup('let x = 42');
  const tree = reader.readTree(roots[0]);
  const init = tree.body.statements[0].bindings[0].initializer;
  assertEquals(init.type, 'LITERAL_INTEGER');
  assertEquals(init.value, 42n);
});

Deno.test("Parser AST: float literal", () => {
  const { reader, roots } = setup('let x = 3.14');
  const tree = reader.readTree(roots[0]);
  const init = tree.body.statements[0].bindings[0].initializer;
  assertEquals(init.type, 'LITERAL_FLOAT');
  assertEquals(init.value, 3.14);
});

Deno.test("Parser AST: string literal", () => {
  const { reader, roots } = setup('let s = "hello"');
  const tree = reader.readTree(roots[0]);
  const init = tree.body.statements[0].bindings[0].initializer;
  assertEquals(init.type, 'LITERAL_STRING');
  assertEquals(init.value, 'hello');
});

Deno.test("Parser AST: boolean literals", () => {
  const t = setup('let a = true');
  assertEquals(t.reader.readTree(t.roots[0]).body.statements[0].bindings[0].initializer.value, true);
  const f = setup('let b = false');
  assertEquals(f.reader.readTree(f.roots[0]).body.statements[0].bindings[0].initializer.value, false);
});

Deno.test("Parser AST: null and undefined", () => {
  const n = setup('let a = null');
  assertEquals(n.reader.readTree(n.roots[0]).body.statements[0].bindings[0].initializer.type, 'LITERAL_NULL');
  const u = setup('let b = undefined');
  assertEquals(u.reader.readTree(u.roots[0]).body.statements[0].bindings[0].initializer.type, 'LITERAL_UNDEFINED');
});

Deno.test("Parser AST: identifier reference", () => {
  const { reader, roots } = setup('let a = 1; let b = a');
  const tree = reader.readTree(roots[0]);
  const init = tree.body.statements[1].bindings[0].initializer;
  assertEquals(init.type, 'IDENTIFIER');
  assertEquals(init.name, 'a');
});

// =============================================================================
// Binary and unary operators
// =============================================================================

Deno.test("Parser AST: addition", () => {
  const { reader, roots } = setup('let x = 1 + 2');
  const tree = reader.readTree(roots[0]);
  const expr = tree.body.statements[0].bindings[0].initializer;
  assertEquals(expr.type, 'BINARY_OP');
  assertEquals(expr.op, 'PLUS');
  assertEquals(expr.left.value, 1n);
  assertEquals(expr.right.value, 2n);
});

Deno.test("Parser AST: chained binary respects precedence", () => {
  const { reader, roots } = setup('let x = 1 + 2 * 3');
  const tree = reader.readTree(roots[0]);
  const expr = tree.body.statements[0].bindings[0].initializer;
  // Should parse as 1 + (2 * 3)
  assertEquals(expr.op, 'PLUS');
  assertEquals(expr.left.value, 1n);
  assertEquals(expr.right.op, 'STAR');
  assertEquals(expr.right.left.value, 2n);
  assertEquals(expr.right.right.value, 3n);
});

Deno.test("Parser AST: comparison and equality", () => {
  const { reader, roots } = setup('let x = a < b; let y = a === b');
  const tree = reader.readTree(roots[0]);
  assertEquals(tree.body.statements[0].bindings[0].initializer.op, 'LT');
  assertEquals(tree.body.statements[1].bindings[0].initializer.op, 'EQ_EQ_EQ');
});

Deno.test("Parser AST: logical && and ||", () => {
  const { reader, roots } = setup('let a = x && y; let b = x || y');
  const tree = reader.readTree(roots[0]);
  const and = tree.body.statements[0].bindings[0].initializer;
  const or = tree.body.statements[1].bindings[0].initializer;
  assertEquals(and.type, 'LOGICAL_OP');
  assertEquals(and.op, 'AMP_AMP');
  assertEquals(or.type, 'LOGICAL_OP');
  assertEquals(or.op, 'PIPE_PIPE');
});

Deno.test("Parser AST: unary operators", () => {
  const { reader, roots } = setup('let a = -x; let b = !x; let c = typeof x; let d = ~x');
  const tree = reader.readTree(roots[0]);
  assertEquals(tree.body.statements[0].bindings[0].initializer.op, 'MINUS');
  assertEquals(tree.body.statements[1].bindings[0].initializer.op, 'BANG');
  assertEquals(tree.body.statements[2].bindings[0].initializer.op, 'TYPEOF');
  assertEquals(tree.body.statements[3].bindings[0].initializer.op, 'TILDE');
});

// =============================================================================
// Assignments and updates
// =============================================================================

Deno.test("Parser AST: simple assignment", () => {
  const { reader, roots } = setup('let x = 1; x = 2');
  const tree = reader.readTree(roots[0]);
  const stmt = tree.body.statements[1].expression;
  assertEquals(stmt.type, 'ASSIGNMENT');
  assertEquals(stmt.op, 'EQ');
  assertEquals(stmt.target.name, 'x');
  assertEquals(stmt.value.value, 2n);
});

Deno.test("Parser AST: compound assignment", () => {
  const { reader, roots } = setup('let x = 1; x += 5');
  const tree = reader.readTree(roots[0]);
  const stmt = tree.body.statements[1].expression;
  assertEquals(stmt.type, 'ASSIGNMENT');
  assertEquals(stmt.op, 'PLUS_EQ');
});

Deno.test("Parser AST: postfix update", () => {
  const { reader, roots } = setup('let x = 1; x++');
  const tree = reader.readTree(roots[0]);
  const stmt = tree.body.statements[1].expression;
  assertEquals(stmt.type, 'UPDATE');
  assertEquals(stmt.op, 'PLUS_PLUS');
  assertEquals(stmt.prefix, false);
});

// =============================================================================
// Calls and member access
// =============================================================================

Deno.test("Parser AST: function call", () => {
  const { reader, roots } = setup('let r = f(1, 2, 3)');
  const tree = reader.readTree(roots[0]);
  const call = tree.body.statements[0].bindings[0].initializer;
  assertEquals(call.type, 'CALL');
  assertEquals(call.callee.name, 'f');
  assertEquals(call.args.length, 3);
  assertEquals(call.args[0].value, 1n);
  assertEquals(call.args[1].value, 2n);
  assertEquals(call.args[2].value, 3n);
});

Deno.test("Parser AST: member access", () => {
  const { reader, roots } = setup('let r = obj.foo');
  const tree = reader.readTree(roots[0]);
  const access = tree.body.statements[0].bindings[0].initializer;
  assertEquals(access.type, 'MEMBER_ACCESS');
  assertEquals(access.object.name, 'obj');
  assertEquals(access.name, 'foo');
});

Deno.test("Parser AST: index access", () => {
  const { reader, roots } = setup('let r = arr[2]');
  const tree = reader.readTree(roots[0]);
  const access = tree.body.statements[0].bindings[0].initializer;
  assertEquals(access.type, 'INDEX_ACCESS');
  assertEquals(access.object.name, 'arr');
  assertEquals(access.index.value, 2n);
});

Deno.test("Parser AST: optional chain", () => {
  const { reader, roots } = setup('let r = a?.b');
  const tree = reader.readTree(roots[0]);
  const access = tree.body.statements[0].bindings[0].initializer;
  assertEquals(access.type, 'OPTIONAL_MEMBER');
  assertEquals(access.name, 'b');
});

// =============================================================================
// Control flow
// =============================================================================

Deno.test("Parser AST: if without else", () => {
  const { reader, roots } = setup('if (x) { y }');
  const tree = reader.readTree(roots[0]);
  const node = tree.body.statements[0];
  assertEquals(node.type, 'IF');
  assertEquals(node.test.name, 'x');
  assertEquals(node.consequent.type, 'BLOCK');
  assertEquals(node.alternate, null);
});

Deno.test("Parser AST: if with else", () => {
  const { reader, roots } = setup('if (x) { 1 } else { 2 }');
  const tree = reader.readTree(roots[0]);
  const node = tree.body.statements[0];
  assertEquals(node.type, 'IF');
  assertEquals(node.hasAlternate, true);
});

Deno.test("Parser AST: while", () => {
  const { reader, roots } = setup('while (x) { y }');
  const tree = reader.readTree(roots[0]);
  const node = tree.body.statements[0];
  assertEquals(node.type, 'WHILE');
  assertEquals(node.test.name, 'x');
});

Deno.test("Parser AST: for loop", () => {
  const { reader, roots } = setup('for (let i = 0; i < 10; i++) { 1 }');
  const tree = reader.readTree(roots[0]);
  const node = tree.body.statements[0];
  assertEquals(node.type, 'FOR');
  assertEquals(node.init.type, 'VARIABLE_DECL');
  assertEquals(node.test.type, 'BINARY_OP');
  assertEquals(node.update.type, 'UPDATE');
});

Deno.test("Parser AST: return", () => {
  const { reader, roots } = setup('function f() { return 1 + 2 }');
  const tree = reader.readTree(roots[0]);
  const fn = tree.body.statements[0];
  const body = fn.body;
  assertEquals(body.statements[0].type, 'RETURN');
  assertEquals(body.statements[0].value.type, 'BINARY_OP');
});

Deno.test("Parser AST: throw", () => {
  const { reader, roots } = setup('throw "oops"');
  const tree = reader.readTree(roots[0]);
  const node = tree.body.statements[0];
  assertEquals(node.type, 'THROW');
  assertEquals(node.value.value, 'oops');
});

Deno.test("Parser AST: try with catch and finally", () => {
  const { reader, roots } = setup('try { 1 } catch (e) { 2 } finally { 3 }');
  const tree = reader.readTree(roots[0]);
  const node = tree.body.statements[0];
  assertEquals(node.type, 'TRY');
  assertEquals(node.hasCatch, true);
  assertEquals(node.hasFinally, true);
  assertEquals(node.catchParam.name, 'e');
});

// =============================================================================
// Declarations
// =============================================================================

Deno.test("Parser AST: function declaration with params", () => {
  const { reader, roots } = setup('function add(a, b) { return a + b }');
  const tree = reader.readTree(roots[0]);
  const fn = tree.body.statements[0];
  assertEquals(fn.type, 'FUNCTION_DECL');
  assertEquals(fn.name, 'add');
  assertEquals(fn.params.length, 2);
  assertEquals(fn.params[0].name, 'a');
  assertEquals(fn.params[1].name, 'b');
  assertEquals(fn.isAsync, false);
  assertEquals(fn.isArrow, false);
});

Deno.test("Parser AST: arrow function expression body", () => {
  const { reader, roots } = setup('let f = x => x + 1');
  const tree = reader.readTree(roots[0]);
  const fn = tree.body.statements[0].bindings[0].initializer;
  assertEquals(fn.type, 'FUNCTION_DECL');
  assertEquals(fn.isArrow, true);
  assertEquals(fn.params.length, 1);
  assertEquals(fn.params[0].name, 'x');
  // Body is a Block with one synthetic Return
  assertEquals(fn.body.statements[0].type, 'RETURN');
});

Deno.test("Parser AST: arrow function block body", () => {
  const { reader, roots } = setup('let f = (a, b) => { return a + b }');
  const tree = reader.readTree(roots[0]);
  const fn = tree.body.statements[0].bindings[0].initializer;
  assertEquals(fn.type, 'FUNCTION_DECL');
  assertEquals(fn.isArrow, true);
  assertEquals(fn.params.length, 2);
});

Deno.test("Parser AST: const declaration", () => {
  const { reader, roots } = setup('const PI = 3.14');
  const tree = reader.readTree(roots[0]);
  const decl = tree.body.statements[0];
  assertEquals(decl.type, 'VARIABLE_DECL');
  assertEquals(decl.isConst, true);
});

Deno.test("Parser AST: multiple bindings in one decl", () => {
  const { reader, roots } = setup('let a = 1, b = 2, c = 3');
  const tree = reader.readTree(roots[0]);
  const decl = tree.body.statements[0];
  assertEquals(decl.bindings.length, 3);
  assertEquals(decl.bindings[0].name, 'a');
  assertEquals(decl.bindings[1].name, 'b');
  assertEquals(decl.bindings[2].name, 'c');
});

// =============================================================================
// Composite literals
// =============================================================================

Deno.test("Parser AST: array literal", () => {
  const { reader, roots } = setup('let a = [1, 2, 3]');
  const tree = reader.readTree(roots[0]);
  const arr = tree.body.statements[0].bindings[0].initializer;
  assertEquals(arr.type, 'ARRAY_LITERAL');
  assertEquals(arr.elements.length, 3);
  assertEquals(arr.elements[0].value, 1n);
});

Deno.test("Parser AST: object literal", () => {
  const { reader, roots } = setup('let o = { a: 1, b: 2 }');
  const tree = reader.readTree(roots[0]);
  const obj = tree.body.statements[0].bindings[0].initializer;
  assertEquals(obj.type, 'OBJECT_LITERAL');
  assertEquals(obj.properties.length, 2);
  assertEquals(obj.properties[0].type, 'OBJECT_PROPERTY');
});

// isComputed used to stay false for every computed key ({ [expr]: value }
// and { [expr]() {} }) — propFlags was only ever assigned FLAG.PROP_METHOD/
// getter/setter, never FLAG.PROP_COMPUTED, so a computed key's `key` node
// (the expression itself) was indistinguishable from a plain identifier
// key to any AST consumer. Found while building the undefined-variable
// structural check: it read a computed key's expression as a property
// NAME instead of walking it, silently skipping the read.
Deno.test("Parser AST: object literal computed key sets isComputed", () => {
  const { reader, roots } = setup('let o = { [k]: 1 }');
  const tree = reader.readTree(roots[0]);
  const prop = tree.body.statements[0].bindings[0].initializer.properties[0];
  assertEquals(prop.isComputed, true);
  assertEquals(prop.key.type, 'IDENTIFIER');
  assertEquals(prop.key.name, 'k');
});

Deno.test("Parser AST: object literal computed method key sets both isComputed and isMethod", () => {
  const { reader, roots } = setup('let o = { [k]() { return 1 } }');
  const tree = reader.readTree(roots[0]);
  const prop = tree.body.statements[0].bindings[0].initializer.properties[0];
  assertEquals(prop.isComputed, true);
  assertEquals(prop.isMethod, true);
});

Deno.test("Parser AST: object literal plain key does not set isComputed", () => {
  const { reader, roots } = setup('let o = { a: 1 }');
  const tree = reader.readTree(roots[0]);
  const prop = tree.body.statements[0].bindings[0].initializer.properties[0];
  assertEquals(prop.isComputed, false);
});

// =============================================================================
// Per-instruction attribution
// =============================================================================

Deno.test("Parser AST: simple expression instructions all carry astNode", () => {
  const session = freshSession({ inlineSource: true });
  session.parse('let x = 1 + 2');
  // LIT_RATIONAL_INTEGER 1, LIT_RATIONAL_INTEGER 2, ADD, LET_VAR x — at least
  // these four value-producing ops should be attributed.
  let attributed = 0;
  for (const instr of session.state(0).instructions) {
    if (instr.astNode !== 0) attributed++;
  }
  assert(attributed >= 4, `expected at least 4 attributed instructions, got ${attributed}`);
});

Deno.test("Parser AST: getAstNodeOffset on attributed instruction decodes to the right node", () => {
  const session = freshSession({ inlineSource: true });
  session.parse('let x = 42');
  const reader = createAstReader(session.mem);
  // First instruction is LIT_RATIONAL_INTEGER for 42.
  const off = session.getAstNodeOffset(0);
  assert(off !== null);
  const node = reader.readNode(off);
  assertEquals(node.type, 'LITERAL_INTEGER');
  assertEquals(node.value, 42n);
});

// =============================================================================
// Grant statements
// =============================================================================

Deno.test("Parser AST: grant with single identifier", () => {
  const { reader, roots } = setup('grant "fs" { let x = 1; }');
  const tree = reader.readTree(roots[0]);
  const grant = tree.body.statements[0];
  assertEquals(grant.type, 'GRANT');
  assertEquals(grant.identifiers.length, 1);
  assertEquals(grant.identifiers[0].type, 'LITERAL_STRING');
  assertEquals(grant.identifiers[0].value, 'fs');
  assertEquals(grant.body.type, 'BLOCK');
  assertEquals(grant.body.statements.length, 1);
  assertEquals(grant.body.statements[0].type, 'VARIABLE_DECL');
  assertEquals(grant.hasDenied, false);
  assertEquals(grant.deniedParam, null);
  assertEquals(grant.deniedBody, null);
});

Deno.test("Parser AST: grant with multiple identifiers", () => {
  const { reader, roots } = setup('grant ("a", "b", "c") { }');
  const tree = reader.readTree(roots[0]);
  const grant = tree.body.statements[0];
  assertEquals(grant.type, 'GRANT');
  assertEquals(grant.identifiers.length, 3);
  assertEquals(grant.identifiers[0].value, 'a');
  assertEquals(grant.identifiers[1].value, 'b');
  assertEquals(grant.identifiers[2].value, 'c');
});

Deno.test("Parser AST: grant with expression identifier", () => {
  const { reader, roots } = setup('let name = "x"; grant name { }');
  const tree = reader.readTree(roots[0]);
  const grant = tree.body.statements[1];
  assertEquals(grant.type, 'GRANT');
  assertEquals(grant.identifiers.length, 1);
  assertEquals(grant.identifiers[0].type, 'IDENTIFIER');
  assertEquals(grant.identifiers[0].name, 'name');
});

Deno.test("Parser AST: grant with denied block", () => {
  const { reader, roots } = setup('grant "fs" { let x = 1; } denied { let y = 2; }');
  const tree = reader.readTree(roots[0]);
  const grant = tree.body.statements[0];
  assertEquals(grant.type, 'GRANT');
  assertEquals(grant.hasDenied, true);
  assertEquals(grant.deniedParam, null);
  assertEquals(grant.deniedBody.type, 'BLOCK');
  assertEquals(grant.deniedBody.statements.length, 1);
  assertEquals(grant.deniedBody.statements[0].type, 'VARIABLE_DECL');
});

Deno.test("Parser AST: grant with denied block and parameter", () => {
  const { reader, roots } = setup('grant "fs" { } denied (ids) { let x = ids; }');
  const tree = reader.readTree(roots[0]);
  const grant = tree.body.statements[0];
  assertEquals(grant.type, 'GRANT');
  assertEquals(grant.hasDenied, true);
  assertEquals(grant.deniedParam, 'ids');
  assertEquals(grant.deniedBody.type, 'BLOCK');
  assertEquals(grant.deniedBody.statements.length, 1);
});

Deno.test("Parser AST: nested grants produce nested GRANT nodes", () => {
  const { reader, roots } = setup(`
    grant "outer" {
      grant "inner" {
        let x = 1;
      }
    }
  `);
  const tree = reader.readTree(roots[0]);
  const outer = tree.body.statements[0];
  assertEquals(outer.type, 'GRANT');
  assertEquals(outer.identifiers[0].value, 'outer');
  const inner = outer.body.statements[0];
  assertEquals(inner.type, 'GRANT');
  assertEquals(inner.identifiers[0].value, 'inner');
  assertEquals(inner.body.statements[0].type, 'VARIABLE_DECL');
});

Deno.test("Parser AST: grant body statements are all present", () => {
  const { reader, roots } = setup(`
    grant "api" {
      let a = 1;
      let b = 2;
      let c = a + b;
    }
  `);
  const tree = reader.readTree(roots[0]);
  const grant = tree.body.statements[0];
  assertEquals(grant.body.statements.length, 3);
  assertEquals(grant.body.statements[0].bindings[0].name, 'a');
  assertEquals(grant.body.statements[1].bindings[0].name, 'b');
  assertEquals(grant.body.statements[2].bindings[0].name, 'c');
});

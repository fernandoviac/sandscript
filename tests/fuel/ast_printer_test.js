/**
 * Tests for the AST pretty-printer (slice 5 of source-inlining).
 *
 * The printer's contract is "faithful reconstruction" — output is not
 * byte-for-byte the original source (whitespace and comments are gone)
 * but it parses back to the same AST.
 *
 * Tests fall into two groups:
 *   - Direct printer tests: verify that source → parse → print produces
 *     the expected text for each construct.
 *   - Roundtrip tests: verify source → parse → print → re-parse produces
 *     a structurally identical AST.
 *
 * Run with: deno task test tests/fuel/ast_printer_test.js
 */

import { assertEquals, assert } from "https://deno.land/std@0.208.0/assert/mod.ts";
import { createSession } from '../../src/fuel/session.js';
import { createAstReader } from '../../src/fuel/ast.js';
import { printNode, printAllRoots } from '../../src/fuel/ast-printer.js';
import { freshSession } from '../../src/host-owned-session.js';

// Helper: parse source and return the printed reconstruction of the first
// statement (or full body for some tests).
function printFirstStatement(source) {
  const session = freshSession({ inlineSource: true });
  session.parse(source);
  const reader = createAstReader(session.mem);
  const roots = [...reader.iterateRoots()];
  const root = reader.readTree(roots[0]);
  return printNode(root.body.statements[0]);
}

function printFirstInitializer(source) {
  // Convenience for `let x = <expr>` — print just <expr>.
  const session = freshSession({ inlineSource: true });
  session.parse(source);
  const reader = createAstReader(session.mem);
  const roots = [...reader.iterateRoots()];
  const root = reader.readTree(roots[0]);
  return printNode(root.body.statements[0].bindings[0].initializer);
}

function printAllStatements(source) {
  const session = freshSession({ inlineSource: true });
  session.parse(source);
  const reader = createAstReader(session.mem);
  return printAllRoots(reader);
}

// =============================================================================
// Literals
// =============================================================================

Deno.test("Printer: integer literal", () => {
  assertEquals(printFirstInitializer('let x = 42'), '42');
});

Deno.test("Printer: negative integer", () => {
  assertEquals(printFirstInitializer('let x = -5'), '-5');
});

Deno.test("Printer: float keeps decimal", () => {
  assertEquals(printFirstInitializer('let x = 3.14'), '3.14');
  // An integer-valued float should still be marked as a float.
  assertEquals(printFirstInitializer('let x = 5.0'), '5.0');
});

Deno.test("Printer: string literal preserves content", () => {
  assertEquals(printFirstInitializer('let x = "hello"'), '"hello"');
});

Deno.test("Printer: boolean and null", () => {
  assertEquals(printFirstInitializer('let a = true'), 'true');
  assertEquals(printFirstInitializer('let a = false'), 'false');
  assertEquals(printFirstInitializer('let a = null'), 'null');
  assertEquals(printFirstInitializer('let a = undefined'), 'undefined');
});

// =============================================================================
// Identifiers and access
// =============================================================================

Deno.test("Printer: identifier", () => {
  assertEquals(printFirstInitializer('let r = a; let x = a'), 'a');
});

Deno.test("Printer: member access", () => {
  assertEquals(printFirstInitializer('let r = obj.foo'), 'obj.foo');
});

Deno.test("Printer: index access", () => {
  assertEquals(printFirstInitializer('let r = arr[0]'), 'arr[0]');
});

Deno.test("Printer: optional chain", () => {
  assertEquals(printFirstInitializer('let r = a?.b'), 'a?.b');
});

// =============================================================================
// Operators
// =============================================================================

Deno.test("Printer: addition", () => {
  assertEquals(printFirstInitializer('let x = 1 + 2'), '1 + 2');
});

Deno.test("Printer: precedence (no extra parens needed for right-nested)", () => {
  // 1 + 2 * 3 prints as "1 + 2 * 3" — the AST nesting is preserved by
  // the operator-text spacing.
  assertEquals(printFirstInitializer('let x = 1 + 2 * 3'), '1 + 2 * 3');
});

Deno.test("Printer: comparison", () => {
  assertEquals(printFirstInitializer('let r = a < b'), 'a < b');
  assertEquals(printFirstInitializer('let r = a === b'), 'a === b');
});

Deno.test("Printer: logical operators", () => {
  assertEquals(printFirstInitializer('let r = a && b'), 'a && b');
  assertEquals(printFirstInitializer('let r = a || b'), 'a || b');
  assertEquals(printFirstInitializer('let r = a ?? b'), 'a ?? b');
});

Deno.test("Printer: unary operators", () => {
  assertEquals(printFirstInitializer('let r = -x'), '-x');
  assertEquals(printFirstInitializer('let r = !x'), '!x');
  assertEquals(printFirstInitializer('let r = typeof x'), 'typeof x');
  assertEquals(printFirstInitializer('let r = ~x'), '~x');
});

Deno.test("Printer: assignment", () => {
  // Need the second statement (the assignment, not the declaration).
  const session = freshSession({ inlineSource: true });
  session.parse('let x = 1; x = 2');
  const reader = createAstReader(session.mem);
  const root = reader.readTree([...reader.iterateRoots()][0]);
  assertEquals(printNode(root.body.statements[1]), 'x = 2');
});

Deno.test("Printer: compound assignment", () => {
  // The expression statement is `x += 5`.
  const session = freshSession({ inlineSource: true });
  session.parse('let x = 1; x += 5');
  const reader = createAstReader(session.mem);
  const root = reader.readTree([...reader.iterateRoots()][0]);
  assertEquals(printNode(root.body.statements[1]), 'x += 5');
});

Deno.test("Printer: postfix update", () => {
  const session = freshSession({ inlineSource: true });
  session.parse('let x = 1; x++');
  const reader = createAstReader(session.mem);
  const root = reader.readTree([...reader.iterateRoots()][0]);
  assertEquals(printNode(root.body.statements[1]), 'x++');
});

Deno.test("Printer: ternary", () => {
  assertEquals(printFirstInitializer('let r = a ? b : c'), 'a ? b : c');
});

// =============================================================================
// Calls
// =============================================================================

Deno.test("Printer: call no args", () => {
  assertEquals(printFirstInitializer('let r = f()'), 'f()');
});

Deno.test("Printer: call multiple args", () => {
  assertEquals(printFirstInitializer('let r = f(1, 2, 3)'), 'f(1, 2, 3)');
});

Deno.test("Printer: new expression", () => {
  assertEquals(printFirstInitializer('let r = new Foo(1)'), 'new Foo(1)');
});

// =============================================================================
// Control flow
// =============================================================================

Deno.test("Printer: if without else", () => {
  const out = printFirstStatement('if (x) { y }');
  // Inner block has one EXPRESSION_STMT for `y`, printed as `y;`.
  assert(out.startsWith('if (x)'));
  assert(out.includes('y;'));
});

Deno.test("Printer: if with else", () => {
  const out = printFirstStatement('if (x) { 1 } else { 2 }');
  assert(out.includes('if (x)'));
  assert(out.includes('else'));
});

Deno.test("Printer: while", () => {
  const out = printFirstStatement('while (x) { y }');
  assert(out.startsWith('while (x)'));
});

Deno.test("Printer: for", () => {
  const out = printFirstStatement('for (let i = 0; i < 10; i++) { 1 }');
  // Init clause uses `let i = 0` (we strip the trailing semicolon from
  // VARIABLE_DECL so it doesn't end up double-semicoloned in `for`).
  assert(out.startsWith('for (let i = 0; i < 10; i++)'));
});

Deno.test("Printer: return with value", () => {
  const out = printFirstStatement('function f() { return 1 + 2 }');
  assert(out.includes('return 1 + 2;'));
});

Deno.test("Printer: bare return", () => {
  const out = printFirstStatement('function f() { return; }');
  assert(out.includes('return;'));
});

Deno.test("Printer: throw", () => {
  assertEquals(printFirstStatement('throw "oops"'), 'throw "oops"');
});

Deno.test("Printer: try/catch/finally", () => {
  const out = printFirstStatement('try { 1 } catch (e) { 2 } finally { 3 }');
  assert(out.startsWith('try'));
  assert(out.includes('catch (e)'));
  assert(out.includes('finally'));
});

// =============================================================================
// Declarations
// =============================================================================

Deno.test("Printer: function declaration", () => {
  const out = printFirstStatement('function add(a, b) { return a + b }');
  assert(out.startsWith('function add(a, b)'));
  assert(out.includes('return a + b;'));
});

Deno.test("Printer: arrow expression body", () => {
  const out = printFirstInitializer('let f = x => x + 1');
  // Arrows always print as `(params) => { body }` — block form. Since the
  // expression body became a synthetic Return, the body is `{ return x + 1; }`.
  assert(out.startsWith('(x) =>'));
  assert(out.includes('return x + 1;'));
});

Deno.test("Printer: arrow block body", () => {
  const out = printFirstInitializer('let f = (a, b) => { return a + b }');
  assert(out.startsWith('(a, b) =>'));
});

Deno.test("Printer: async function", () => {
  const out = printFirstStatement('async function f() { return 1 }');
  assert(out.startsWith('async function f()'));
});

Deno.test("Printer: const declaration", () => {
  assertEquals(printFirstStatement('const PI = 3.14'), 'const PI = 3.14');
});

Deno.test("Printer: multiple bindings", () => {
  assertEquals(printFirstStatement('let a = 1, b = 2'), 'let a = 1, b = 2');
});

// =============================================================================
// Composite literals
// =============================================================================

Deno.test("Printer: array literal", () => {
  assertEquals(printFirstInitializer('let a = [1, 2, 3]'), '[1, 2, 3]');
});

Deno.test("Printer: empty array", () => {
  assertEquals(printFirstInitializer('let a = []'), '[]');
});

Deno.test("Printer: object literal", () => {
  assertEquals(printFirstInitializer('let o = { a: 1, b: 2 }'), '{ a: 1, b: 2 }');
});

Deno.test("Printer: empty object", () => {
  assertEquals(printFirstInitializer('let o = {}'), '{}');
});

// =============================================================================
// Multi-statement / multi-root output
// =============================================================================

Deno.test("Printer: prints all roots in order", () => {
  const out = printAllStatements('let a = 1; let b = 2');
  assert(out.includes('let a = 1;'));
  assert(out.includes('let b = 2;'));
});

Deno.test("Printer: multi-parse roots separated", () => {
  const session = freshSession({ inlineSource: true });
  session.parse('let a = 1');
  session.parse('let b = 2');
  const reader = createAstReader(session.mem);
  const out = printAllRoots(reader);
  assert(out.includes('let a = 1;'));
  assert(out.includes('let b = 2;'));
  // Roots should be separated by a blank line.
  assert(out.includes('\n\n'));
});

// =============================================================================
// Session-level helpers
// =============================================================================

Deno.test("Session.getSourceFor: returns null when inlineSource is off", () => {
  const session = freshSession();
  session.parse('let x = 1');
  assertEquals(session.getSourceFor(0), null);
});

Deno.test("Session.getSourceFor: returns printed source for an attributed instruction", () => {
  const session = freshSession({ inlineSource: true });
  session.parse('let x = 42');
  // First instruction is LIT_RATIONAL_INTEGER for 42.
  assertEquals(session.getSourceFor(0), '42');
});

Deno.test("Session.getSource: returns null when inlineSource is off", () => {
  const session = freshSession();
  session.parse('let x = 1');
  assertEquals(session.getSource(), null);
});

Deno.test("Session.getSource: returns full program source", () => {
  const session = freshSession({ inlineSource: true });
  session.parse('let x = 1 + 2');
  const out = session.getSource();
  assertEquals(out, 'let x = 1 + 2;');
});

Deno.test("Session.getSource: covers multi-parse output", () => {
  const session = freshSession({ inlineSource: true });
  session.parse('let a = 1');
  session.parse('function f() { return a }');
  const out = session.getSource();
  assert(out.includes('let a = 1;'));
  assert(out.includes('function f()'));
  assert(out.includes('return a;'));
});

// =============================================================================
// Roundtrip: source → parse → print → re-parse → same AST shape
// =============================================================================

Deno.test("Roundtrip: arithmetic expression preserves shape", () => {
  const original = 'let x = 1 + 2 * 3';
  const s1 = freshSession({ inlineSource: true });
  s1.parse(original);
  const printed = s1.getSource();

  const s2 = freshSession({ inlineSource: true });
  s2.parse(printed);
  const r2 = createAstReader(s2.mem);
  const tree2 = r2.readTree([...r2.iterateRoots()][0]);

  const expr = tree2.body.statements[0].bindings[0].initializer;
  assertEquals(expr.type, 'BINARY_OP');
  assertEquals(expr.op, 'PLUS');
  assertEquals(expr.right.op, 'STAR');
});

Deno.test("Roundtrip: function declaration preserves params and body", () => {
  const original = 'function add(a, b) { return a + b }';
  const s1 = freshSession({ inlineSource: true });
  s1.parse(original);
  const printed = s1.getSource();

  const s2 = freshSession({ inlineSource: true });
  s2.parse(printed);
  const r2 = createAstReader(s2.mem);
  const tree2 = r2.readTree([...r2.iterateRoots()][0]);

  const fn = tree2.body.statements[0];
  assertEquals(fn.type, 'FUNCTION_DECL');
  assertEquals(fn.name, 'add');
  assertEquals(fn.params.length, 2);
  assertEquals(fn.params[0].name, 'a');
  assertEquals(fn.params[1].name, 'b');
});

Deno.test("Roundtrip: control flow preserves structure", () => {
  const original = 'if (x) { y } else { z }';
  const s1 = freshSession({ inlineSource: true });
  s1.parse(original);
  const printed = s1.getSource();

  const s2 = freshSession({ inlineSource: true });
  s2.parse(printed);
  const r2 = createAstReader(s2.mem);
  const tree2 = r2.readTree([...r2.iterateRoots()][0]);

  const ifNode = tree2.body.statements[0];
  assertEquals(ifNode.type, 'IF');
  assertEquals(ifNode.hasAlternate, true);
});

Deno.test("Roundtrip: nontrivial program executes the same way", () => {
  // Parse, print, re-parse, run both, compare result.
  const original = `
    function add(a, b) { return a + b }
    let x = add(2, 3)
  `;
  const s1 = freshSession({ inlineSource: true });
  s1.parse(original);
  s1.run(0, 100000);
  const x1 = s1.get(0, 'x');

  // Reconstruct from printed source.
  const printed = s1.getSource();
  const s2 = freshSession();  // Run without AST tracking.
  s2.parse(printed);
  s2.run(0, 100000);
  const x2 = s2.get(0, 'x');

  assertEquals(x1, x2);
  assertEquals(x1, 5);
});

/**
 * Tests for the token-emitting AST printer (slice 5 → playground).
 *
 * The token path produces a flat Token[] alongside the same string
 * output as `printNode`. The most important invariant is
 * concatenation: `tokens.map(t => t.text).join('') === printNode(tree)`.
 *
 * Run with: deno task test tests/fuel/ast_printer_tokens_test.js
 */

import { assertEquals, assert } from "https://deno.land/std@0.208.0/assert/mod.ts";
import { createSession } from '../../src/fuel/session.js';
import { createAstReader } from '../../src/fuel/ast.js';
import {
  printNode,
  printAllRoots,
  printNodeToTokens,
  printAllRootsToTokens,
  TokenKind,
} from '../../src/fuel/ast-printer.js';
import { freshSession } from '../../src/host-owned-session.js';

// Helpers
function parse(source) {
  const session = freshSession({ inlineSource: true });
  session.parse(source);
  const reader = createAstReader(session.mem);
  return { session, reader, root: reader.readTree([...reader.iterateRoots()][0]) };
}

function firstStatement(source) {
  const { root } = parse(source);
  return root.body.statements[0];
}

function firstInitializer(source) {
  return firstStatement(source).bindings[0].initializer;
}

// =============================================================================
// 1. Concatenation invariant — the most important test
// =============================================================================

const FIXTURES = [
  'let x = 42',
  'let f = 3.14',
  'let s = "hello"',
  'let a = true',
  'let b = false',
  'let n = null',
  'let u = undefined',
  'let r = a; let x = a',
  'let r = obj.foo',
  'let r = arr[0]',
  'let r = a?.b',
  'let x = 1 + 2',
  'let x = 1 + 2 * 3',
  'let r = a < b; let y = a === b',
  'let a = x && y; let b = x || y',
  'let a = -x; let b = !x; let c = typeof x',
  'let x = 1; x = 2',
  'let x = 1; x += 5',
  'let x = 1; x++',
  'let r = a ? b : c',
  'let r = f(1, 2, 3)',
  'let r = new Foo(1)',
  'if (x) { y }',
  'if (x) { 1 } else { 2 }',
  'while (x) { y }',
  'for (let i = 0; i < 10; i++) { 1 }',
  'function f() { return 1 + 2 }',
  'throw "oops"',
  'try { 1 } catch (e) { 2 } finally { 3 }',
  'function add(a, b) { return a + b }',
  'let f = x => x + 1',
  'let f = (a, b) => { return a + b }',
  'async function f() { return 1 }',
  'const PI = 3.14',
  'let a = 1, b = 2',
  'let a = [1, 2, 3]',
  'let a = []',
  'let o = { a: 1, b: 2 }',
  'let o = {}',
];

Deno.test("Tokens: concatenation invariant for fixture set", () => {
  for (const src of FIXTURES) {
    const { reader } = parse(src);
    const tree = reader.readTree([...reader.iterateRoots()][0]);
    const stringOutput = printNode(tree);
    const tokens = printNodeToTokens(tree);
    const joined = tokens.map(t => t.text).join('');
    assertEquals(joined, stringOutput, `mismatch for: ${src}`);
  }
});

// =============================================================================
// 2. Per-token astNode correctness
// =============================================================================

Deno.test("Tokens: literal token attributes to its own node", () => {
  const init = firstInitializer('let x = 42');
  const tokens = printNodeToTokens(init);
  // Single token: '42'
  assertEquals(tokens.length, 1);
  assertEquals(tokens[0].text, '42');
  assertEquals(tokens[0].astNode, init.offset);
  assertEquals(tokens[0].kind, TokenKind.LITERAL_INT);
});

Deno.test("Tokens: identifier attributes to the IDENTIFIER node", () => {
  const init = firstInitializer('let r = a; let x = a');
  // `a` reference — a single IDENTIFIER node.
  assertEquals(init.type, 'IDENTIFIER');
  const tokens = printNodeToTokens(init);
  assertEquals(tokens.length, 1);
  assertEquals(tokens[0].text, 'a');
  assertEquals(tokens[0].astNode, init.offset);
  assertEquals(tokens[0].kind, TokenKind.IDENTIFIER);
});

Deno.test("Tokens: BinaryOp operator token attributes to the binop, operands to themselves", () => {
  const expr = firstInitializer('let x = 1 + 2');
  // expr is BINARY_OP. left is LITERAL_INTEGER 1; right is LITERAL_INTEGER 2.
  const tokens = printNodeToTokens(expr);
  // Expected sequence: '1', ' ', '+', ' ', '2'
  assertEquals(tokens.map(t => t.text), ['1', ' ', '+', ' ', '2']);
  assertEquals(tokens[0].astNode, expr.left.offset);
  assertEquals(tokens[1].astNode, expr.offset);  // ws sits inside binop
  assertEquals(tokens[2].astNode, expr.offset);  // operator owned by binop
  assertEquals(tokens[3].astNode, expr.offset);
  assertEquals(tokens[4].astNode, expr.right.offset);
  assertEquals(tokens[2].kind, TokenKind.OPERATOR);
});

Deno.test("Tokens: call parens attribute to the call node, args to their own subtrees", () => {
  const init = firstInitializer('let r = f(1, 2)');
  // CALL { callee: f (IDENTIFIER), args: [1, 2] }
  const tokens = printNodeToTokens(init);
  // Expected: 'f', '(', '1', ',', ' ', '2', ')'
  const texts = tokens.map(t => t.text);
  assertEquals(texts, ['f', '(', '1', ',', ' ', '2', ')']);
  assertEquals(tokens[0].astNode, init.callee.offset);  // 'f'
  assertEquals(tokens[1].astNode, init.offset);          // '(' on call
  assertEquals(tokens[2].astNode, init.args[0].offset);  // '1' on its literal
  assertEquals(tokens[3].astNode, init.offset);          // ',' on call
  assertEquals(tokens[5].astNode, init.args[1].offset);  // '2' on its literal
  assertEquals(tokens[6].astNode, init.offset);          // ')' on call
});

Deno.test("Tokens: 'let' keyword attributes to the first binding (not the DECL)", () => {
  // The keyword sits syntactically inside VARIABLE_DECL, but no
  // instruction is attributed to VARIABLE_DECL — LET_VAR is
  // attributed to the per-binding VARIABLE_BINDING node. To make
  // stepping onto LET_VAR highlight the whole 'let x = 1' span, the
  // printer attributes the keyword (and trailing space) to the first
  // binding for display purposes.
  const decl = firstStatement('let x = 1');
  assertEquals(decl.type, 'VARIABLE_DECL');
  const binding = decl.bindings[0];
  const tokens = printNodeToTokens(decl);
  // Expected: 'let', ' ', 'x', ' ', '=', ' ', '1'
  assertEquals(tokens[0].text, 'let');
  assertEquals(tokens[0].kind, TokenKind.KEYWORD);
  assertEquals(tokens[0].astNode, binding.offset);
  assert(tokens[0].ancestors.includes(binding.offset));
  assert(tokens[0].ancestors.includes(decl.offset));
  // Trailing space is also inside the ancestor scope so the highlight
  // is contiguous.
  assertEquals(tokens[1].text, ' ');
  assert(tokens[1].ancestors.includes(binding.offset));
});

Deno.test("Tokens: 'const' keyword attributes to the first binding the same way", () => {
  const decl = firstStatement('const x = 1');
  assertEquals(decl.type, 'VARIABLE_DECL');
  assertEquals(decl.isConst, true);
  const binding = decl.bindings[0];
  const tokens = printNodeToTokens(decl);
  assertEquals(tokens[0].text, 'const');
  assertEquals(tokens[0].kind, TokenKind.KEYWORD);
  assertEquals(tokens[0].astNode, binding.offset);
});

Deno.test("Tokens: multi-binding DECL — 'let' attributes to first binding only", () => {
  // For 'let a = 1, b = 2': stepping onto LET_VAR(a) should highlight
  // 'let a = 1', stepping onto LET_VAR(b) should highlight just 'b = 2'.
  // The 'let' keyword's ancestors must contain BINDING(a) but not BINDING(b).
  const decl = firstStatement('let a = 1, b = 2');
  assertEquals(decl.type, 'VARIABLE_DECL');
  const bindingA = decl.bindings[0];
  const bindingB = decl.bindings[1];
  const tokens = printNodeToTokens(decl);
  const letTok = tokens[0];
  assertEquals(letTok.text, 'let');
  assert(letTok.ancestors.includes(bindingA.offset),
    "'let' ancestors should include first binding");
  assert(!letTok.ancestors.includes(bindingB.offset),
    "'let' ancestors must NOT include second binding");
  // The shared comma between bindings stays at VARIABLE_DECL scope —
  // not attributed to either binding.
  const commaTok = tokens.find(t => t.text === ',');
  assert(commaTok);
  assertEquals(commaTok.astNode, decl.offset);
  assert(!commaTok.ancestors.includes(bindingA.offset));
  assert(!commaTok.ancestors.includes(bindingB.offset));
});

// =============================================================================
// 3. Ancestor chain shape
// =============================================================================

Deno.test("Tokens: nested binop ancestor chain runs leaf → root", () => {
  // 1 + (2 * 3) — the source produces 1 + 2 * 3 (no parens) since
  // multiplication has higher precedence; the tree is BINARY_OP(+,
  // 1, BINARY_OP(*, 2, 3)).
  const expr = firstInitializer('let x = 1 + 2 * 3');
  const outerOffset = expr.offset;
  const innerOffset = expr.right.offset;
  const tokens = printNodeToTokens(expr);
  // The token for '2' is the literal inside the inner binop.
  const t2 = tokens.find(t => t.text === '2');
  assert(t2);
  // ancestors[0] === self (literal), then inner binop, then outer binop.
  assertEquals(t2.ancestors[0], expr.right.left.offset);
  assertEquals(t2.ancestors[1], innerOffset);
  assertEquals(t2.ancestors[2], outerOffset);
  // ancestors[0] === astNode for every token.
  for (const t of tokens) {
    assertEquals(t.ancestors[0], t.astNode);
  }
});

Deno.test("Tokens: every token has astNode === ancestors[0]", () => {
  for (const src of FIXTURES) {
    const { reader } = parse(src);
    const tree = reader.readTree([...reader.iterateRoots()][0]);
    const tokens = printNodeToTokens(tree);
    for (const t of tokens) {
      assertEquals(t.ancestors[0], t.astNode, `mismatch for ${src} at "${t.text}"`);
    }
  }
});

// =============================================================================
// 4. Token kind taxonomy — every kind value is producible
// =============================================================================

Deno.test("Tokens: every TokenKind value is producible from real fixtures", () => {
  // Build one big tree that exercises every kind, then check coverage.
  const session = freshSession({ inlineSource: true });
  session.parse(`
    let i = 42;
    let f = 3.14;
    let s = "hi";
    let b = true;
    let n = null;
    let big = 99n;
    if (i) { i = i + 1 } else { i = i - 1 }
    function f(a) { return a }
    let arr = [1];
    let re = /ab+c/gi;
  `);
  const reader = createAstReader(session.mem);
  const tokens = printNodeToTokens(reader.readTree([...reader.iterateRoots()][0]));
  const seen = new Set(tokens.map(t => t.kind));

  // Every TokenKind value must show up.
  const expected = Object.values(TokenKind);
  // LITERAL_RATIONAL won't appear from this fixture (rationals aren't
  // produced by integer literals; they require explicit syntax). Drop
  // it from the strict-coverage check but lock in everything else.
  const expectStrict = expected.filter(k => k !== TokenKind.LITERAL_RATIONAL);
  for (const kind of expectStrict) {
    assert(seen.has(kind), `expected to see kind=${kind}, got: ${[...seen].join(', ')}`);
  }
});

// =============================================================================
// 5. Duplicates don't collide
// =============================================================================

Deno.test("Tokens: 1 + 1 + 1 produces three distinct literal tokens", () => {
  const expr = firstInitializer('let x = 1 + 1 + 1');
  // Tree: BINARY_OP(+, BINARY_OP(+, 1, 1), 1)
  const tokens = printNodeToTokens(expr);
  const ones = tokens.filter(t => t.text === '1');
  assertEquals(ones.length, 3, 'three literal-1 tokens');
  // All three have kind literal-int.
  for (const o of ones) assertEquals(o.kind, TokenKind.LITERAL_INT);
  // All three astNode offsets are distinct.
  const offsets = new Set(ones.map(o => o.astNode));
  assertEquals(offsets.size, 3, 'three distinct AST node offsets');
});

// =============================================================================
// 6. Empty / sentinel cases
// =============================================================================

Deno.test("Tokens: printNodeToTokens(null) returns []", () => {
  assertEquals(printNodeToTokens(null), []);
});

Deno.test("Tokens: printNodeToTokens(undefined) returns []", () => {
  assertEquals(printNodeToTokens(undefined), []);
});

Deno.test("Tokens: printAllRootsToTokens with no roots returns []", () => {
  // Build a session, but don't parse anything. The reader returns no roots.
  const session = freshSession({ inlineSource: true });
  const reader = createAstReader(session.mem);
  assertEquals(printAllRootsToTokens(reader), []);
});

Deno.test("Tokens: empty Block produces { } punctuation tokens with block as ancestor", () => {
  const expr = firstInitializer('let o = {}');  // OBJECT_LITERAL, not BLOCK
  // For an actual empty BLOCK, build via if (x) {}.
  const ifStmt = firstStatement('if (x) {}');
  const block = ifStmt.consequent;
  assertEquals(block.type, 'BLOCK');
  const tokens = printNodeToTokens(block);
  assertEquals(tokens.map(t => t.text), ['{', '}']);
  for (const t of tokens) {
    assertEquals(t.astNode, block.offset);
    assertEquals(t.kind, TokenKind.PUNCTUATION);
  }
});

// =============================================================================
// 7. printAllRootsToTokens separator
// =============================================================================

Deno.test("Tokens: printAllRootsToTokens emits a no-node separator between roots", () => {
  const session = freshSession({ inlineSource: true });
  session.parse('let a = 1');
  session.parse('let b = 2');
  const reader = createAstReader(session.mem);
  const tokens = printAllRootsToTokens(reader);

  // Find the '\n\n' separator.
  const sep = tokens.find(t => t.text === '\n\n');
  assert(sep, 'expected a \\n\\n separator token');
  assertEquals(sep.astNode, 0, 'separator owned by no node');
  assertEquals(sep.ancestors, [], 'separator has empty ancestor chain');
  assertEquals(sep.kind, TokenKind.WHITESPACE);

  // Concatenation invariant for the multi-root path too.
  const joined = tokens.map(t => t.text).join('');
  assertEquals(joined, printAllRoots(reader));
});

Deno.test("Tokens: printAllRootsToTokens does not emit a separator with one root", () => {
  const session = freshSession({ inlineSource: true });
  session.parse('let a = 1');
  const reader = createAstReader(session.mem);
  const tokens = printAllRootsToTokens(reader);
  // No '\n\n' should appear (any blank-line tokens come from inside a
  // single root, but a single 'let a = 1' produces none).
  const seps = tokens.filter(t => t.text === '\n\n');
  assertEquals(seps.length, 0);
});

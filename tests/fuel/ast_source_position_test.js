/**
 * Every AST node carries a real {line, col} source position in format
 * version 3. These tests pin that
 * no parser call site was left passing the {line:0, col:0} default —
 * a silent zero position would look like a bug to any future consumer
 * (checkSyntax-style tooling reporting "line 0").
 */

import { assertEquals, assert } from "https://deno.land/std@0.208.0/assert/mod.ts";
import { freshSession } from '../../src/host-owned-session.js';
import { createAstWriter } from '../../src/fuel/ast.js';

function collectNodes(tree, out = []) {
  if (tree === null || typeof tree !== 'object') return out;
  if ('line' in tree) out.push(tree);
  for (const key of Object.keys(tree)) {
    const val = tree[key];
    if (Array.isArray(val)) {
      for (const item of val) collectNodes(item, out);
    } else if (val && typeof val === 'object' && 'type' in val) {
      collectNodes(val, out);
    }
  }
  return out;
}

function parseAndCollect(source) {
  const session = freshSession({ inlineSource: true });
  session.parse(source);
  const reader = session.astReader();
  const nodes = [];
  for (const rootOffset of reader.iterateRoots()) {
    collectNodes(reader.readTree(rootOffset), nodes);
  }
  return nodes;
}

Deno.test("AST source position: no node defaults to {line:0, col:0} across a varied program", () => {
  const source = `let x = 10
let y = x * 2

function add(a, b) {
  return a + b
}

if (x > 5) {
  let z = add(x, y)
} else {
  let w = [1, 2, 3]
}

for (let i = 0; i < 3; i++) {
  console.log(i)
}

const obj = { a: 1, b: 2 }
let arrow = (p, q) => p + q

try {
  throw "boom"
} catch (e) {
} finally {
}

switch (x) {
  case 1:
    break
  default:
    break
}

let [aa, bb] = [1, 2]
let { cc, dd } = obj
`;
  const nodes = parseAndCollect(source);
  assert(nodes.length > 50, `expected a substantial node count, got ${nodes.length}`);
  const zeroPos = nodes.filter(n => n.line === 0 && n.col === 0);
  assertEquals(zeroPos.map(n => n.type), []);
});

Deno.test("AST source position: literal and identifier positions match source", () => {
  const nodes = parseAndCollect("let x = 10\nlet y = x * 2\n");
  const literal10 = nodes.find(n => n.type === 'LITERAL_INTEGER' && n.value === 10n);
  assertEquals(literal10.line, 1);
  assertEquals(literal10.col, 9);

  const identifierX = nodes.find(n => n.type === 'IDENTIFIER' && n.name === 'x');
  assertEquals(identifierX.line, 2);
  assertEquals(identifierX.col, 9);
});

Deno.test("AST source position: function decl and params attribute to their own tokens", () => {
  const nodes = parseAndCollect("function add(a, b) {\n  return a + b\n}\n");
  const fnDecl = nodes.find(n => n.type === 'FUNCTION_DECL');
  assertEquals(fnDecl.line, 1);
  assertEquals(fnDecl.col, 1);

  const paramA = nodes.find(n => n.type === 'VARIABLE_BINDING' && n.name === 'a');
  assertEquals(paramA.line, 1);
  assertEquals(paramA.col, 14);
});

Deno.test("AST source position: default {line:0, col:0} still works for synthetic nodes with no pos", () => {
  const session = freshSession({ inlineSource: true });
  const astWriter = createAstWriter(session.mem);
  astWriter.initialize();
  const offset = astWriter.writeLiteralInteger(5n);
  const node = session.astReader().readNode(offset);
  assertEquals(node.line, 0);
  assertEquals(node.col, 0);
});

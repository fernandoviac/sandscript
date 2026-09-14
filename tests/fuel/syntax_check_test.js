/**
 * Standalone parse-only syntax check (checkSyntax).
 */

import { assertEquals } from "https://deno.land/std@0.208.0/assert/mod.ts";
import { checkSyntax } from '../../src/fuel/syntax-check.js';

Deno.test("checkSyntax: valid source", () => {
  const result = checkSyntax("let x = 10\nlet y = x * 2\n");
  assertEquals(result, { ok: true });
});

Deno.test("checkSyntax: unbalanced parens reports line/column", () => {
  const result = checkSyntax("let x = (10\n");
  assertEquals(result.ok, false);
  assertEquals(result.line, 2);
  assertEquals(result.column, 1);
  assertEquals(result.type, 'SyntaxError');
});

Deno.test("checkSyntax: unclosed brace reports line/column", () => {
  const result = checkSyntax("function f() {\n  let x = 1;\n");
  assertEquals(result.ok, false);
  assertEquals(result.line, 3);
});

Deno.test("checkSyntax: reserved keyword gets a hint", () => {
  const result = checkSyntax("let grant = 5\n");
  assertEquals(result.ok, false);
  assertEquals(typeof result.message, 'string');
  assertEquals(result.message.includes('grant'), true);
});

Deno.test("checkSyntax: does not execute the source", () => {
  // If this ran, it would throw (division by zero is not a parse error
  // in SandScript, so this only proves parse-only if we check no crash
  // occurs and no side effects are observable — parse never runs code).
  const result = checkSyntax("let x = 1 / 0\n");
  assertEquals(result, { ok: true });
});

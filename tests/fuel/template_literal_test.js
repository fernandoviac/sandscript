/**
 * Tests for template literals: `text ${expr} more text`.
 *
 * Implemented as a parser desugaring to LIT_STRING + expression + OP.ADD
 * chains. The lexer emits TEMPLATE_NO_SUB / TEMPLATE_HEAD / TEMPLATE_MIDDLE
 * / TEMPLATE_TAIL tokens with substitution expressions in between, and
 * tracks brace depth so the `}` that closes `${ }` doesn't get confused
 * with regular RBRACE tokens.
 *
 * Run with: deno task test tests/fuel/template_literal_test.js
 */

import { assertEquals } from "https://deno.land/std@0.208.0/assert/mod.ts";
import { freshSession } from '../../src/host-owned-session.js';
import { parseAndSetup } from './test-helpers.js';

function run(source) {
  const session = freshSession();
  parseAndSetup(session, source);
  const result = session.run(0, 1_000_000);
  return { session, result };
}

function assertResult(source, varName, expected) {
  const { session, result } = run(source);
  assertEquals(result.status, 'done',
    `expected status=done, got ${result.status} (${result.error?.message})`);
  assertEquals(session.get(0, varName), expected);
}

function assertParseError(source, expectedFragment) {
  const session = freshSession();
  let msg = null;
  try {
    session.parse(source);
  } catch (parseError) {
    msg = parseError.message;
  }
  if (msg === null) {
    throw new Error(`expected parse to fail`);
  }
  if (!msg.includes(expectedFragment)) {
    throw new Error(`expected parse error to include "${expectedFragment}", got: ${msg}`);
  }
}

// =============================================================================
// No substitutions — equivalent to a plain string literal
// =============================================================================

Deno.test("template: plain text without substitutions", () => {
  assertResult('let r = `hello world`', 'r', 'hello world');
});

Deno.test("template: empty template", () => {
  assertResult('let r = ``', 'r', '');
});

Deno.test("template: identical to string literal", () => {
  assertResult('let r = `abc` === "abc"', 'r', true);
});

// =============================================================================
// Single substitution
// =============================================================================

Deno.test("template: single string substitution", () => {
  assertResult('let name = "world"; let r = `hello ${name}!`', 'r', 'hello world!');
});

Deno.test("template: single number substitution", () => {
  assertResult('let r = `count: ${42}`', 'r', 'count: 42');
});

Deno.test("template: starts with substitution", () => {
  assertResult('let x = 5; let r = `${x} items`', 'r', '5 items');
});

Deno.test("template: ends with substitution", () => {
  assertResult('let x = 5; let r = `count: ${x}`', 'r', 'count: 5');
});

Deno.test("template: only substitution, nothing else", () => {
  assertResult('let x = 42; let r = `${x}`', 'r', '42');
});

// =============================================================================
// Multiple substitutions
// =============================================================================

Deno.test("template: multiple substitutions", () => {
  assertResult('let a = 1; let b = 2; let r = `${a} + ${b} = ${a+b}`', 'r', '1 + 2 = 3');
});

Deno.test("template: two adjacent substitutions", () => {
  assertResult('let a = "x"; let b = "y"; let r = `${a}${b}`', 'r', 'xy');
});

// =============================================================================
// Expression-coercion in substitutions (matches JS via OP.ADD's string coercion)
// =============================================================================

Deno.test("template: bool coerces to string", () => {
  assertResult('let r = `${true}/${false}`', 'r', 'true/false');
});

Deno.test("template: null/undefined coerce to string", () => {
  assertResult('let r = `${null}/${undefined}`', 'r', 'null/undefined');
});

Deno.test("template: array coerces to comma-joined string", () => {
  assertResult('let r = `${[1,2,3]}`', 'r', '1,2,3');
});

Deno.test("template: nested array coerces recursively", () => {
  assertResult('let r = `${[[1,2],[3,4]]}`', 'r', '1,2,3,4');
});

Deno.test("template: object coerces to [object Object]", () => {
  assertResult('let r = `${ {a:1} }`', 'r', '[object Object]');
});

Deno.test("template: function-call result", () => {
  assertResult('function f() { return "x"; } let r = `${f()}!`', 'r', 'x!');
});

// =============================================================================
// Nested structures inside ${...}
// =============================================================================

Deno.test("template: nested object literal in substitution", () => {
  // Object braces inside `${}` must not be confused with the substitution's
  // closing `}`. Brace-depth tracking in the lexer handles this.
  assertResult('let r = `${ {a: 1, b: 2}.a }`', 'r', '1');
});

Deno.test("template: nested function call with object arg", () => {
  assertResult(`
    function pick(o) { return o.x; }
    let r = \`got: \${ pick({x: "hello"}) }\`;
  `, 'r', 'got: hello');
});

Deno.test("template: nested template inside substitution", () => {
  assertResult('let n = "world"; let r = `outer ${`inner ${n}`} end`',
    'r', 'outer inner world end');
});

Deno.test("template: deeply nested templates", () => {
  assertResult('let r = `${`${`${42}`}`}`', 'r', '42');
});

// =============================================================================
// Escapes
// =============================================================================

Deno.test("template: escape backtick", () => {
  assertResult('let r = `quote: \\` ok`', 'r', 'quote: ` ok');
});

Deno.test("template: escape dollar (prevents substitution)", () => {
  assertResult('let r = `dollar: \\${x}`', 'r', 'dollar: ${x}');
});

Deno.test("template: escape newline literal", () => {
  assertResult('let r = `line1\\nline2`', 'r', 'line1\nline2');
});

Deno.test("template: escape tab", () => {
  assertResult('let r = `a\\tb`', 'r', 'a\tb');
});

Deno.test("template: escape backslash", () => {
  assertResult('let r = `\\\\`', 'r', '\\');
});

// =============================================================================
// Multi-line templates (real newlines, no escape)
// =============================================================================

Deno.test("template: multi-line content preserved verbatim", () => {
  const src = 'let r = `line1\nline2`';
  assertResult(src, 'r', 'line1\nline2');
});

Deno.test("template: multi-line with substitution", () => {
  assertResult('let name = "Alice"; let r = `Dear ${name},\nThank you.`',
    'r', 'Dear Alice,\nThank you.');
});

// =============================================================================
// Type behavior
// =============================================================================

Deno.test("template: typeof is string", () => {
  assertResult('let r = typeof `abc`', 'r', 'string');
});

Deno.test("template: concat with regular string", () => {
  assertResult('let r = `tmpl` + " end"', 'r', 'tmpl end');
});

Deno.test("template: comparison with regular string", () => {
  assertResult('let r = `abc` === "abc" && "abc" === `abc`', 'r', true);
});

// =============================================================================
// Empty substitution edge cases
// =============================================================================

Deno.test("template: empty-string substitution", () => {
  assertResult('let r = `a${""}b`', 'r', 'ab');
});

Deno.test("template: substitution producing empty", () => {
  assertResult('let r = `[${[].join(",")}]`', 'r', '[]');
});

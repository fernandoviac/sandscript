import {
  assertNumericResult,
  assertStringResult,
  assertUndefinedResult,
  assertBooleanResult,
} from './interpreter-test-utils.js';

// =============================================================================
// replaceAll
// =============================================================================

Deno.test("replaceAll: replace all occurrences", () => {
  assertStringResult(
    'let r = "abcabc".replaceAll("b", "x")',
    'r', "axcaxc"
  );
});

Deno.test("replaceAll: no occurrences", () => {
  assertStringResult(
    'let r = "hello".replaceAll("x", "y")',
    'r', "hello"
  );
});

Deno.test("replaceAll: replace empty string", () => {
  assertStringResult(
    'let r = "abc".replaceAll("", "-")',
    'r', "-a-b-c-"
  );
});

Deno.test("replaceAll: single occurrence same as replace", () => {
  assertStringResult(
    'let r = "hello world".replaceAll("world", "there")',
    'r', "hello there"
  );
});

Deno.test("replaceAll: multiple adjacent", () => {
  assertStringResult(
    'let r = "aaa".replaceAll("a", "bb")',
    'r', "bbbbbb"
  );
});

Deno.test("replaceAll: empty source string", () => {
  assertStringResult(
    'let r = "".replaceAll("a", "b")',
    'r', ""
  );
});

// =============================================================================
// trimStart
// =============================================================================

Deno.test("trimStart: leading spaces", () => {
  assertStringResult(
    'let r = "  hello".trimStart()',
    'r', "hello"
  );
});

Deno.test("trimStart: no leading spaces", () => {
  assertStringResult(
    'let r = "hello  ".trimStart()',
    'r', "hello  "
  );
});

Deno.test("trimStart: both sides", () => {
  assertStringResult(
    'let r = "  hello  ".trimStart()',
    'r', "hello  "
  );
});

Deno.test("trimStart: all spaces", () => {
  assertStringResult(
    'let r = "   ".trimStart()',
    'r', ""
  );
});

Deno.test("trimStart: empty string", () => {
  assertStringResult(
    'let r = "".trimStart()',
    'r', ""
  );
});

Deno.test("trimStart: tabs and newlines", () => {
  assertStringResult(
    "let r = \"\\t\\n hello\".trimStart()",
    'r', "hello"
  );
});

// =============================================================================
// trimEnd
// =============================================================================

Deno.test("trimEnd: trailing spaces", () => {
  assertStringResult(
    'let r = "hello  ".trimEnd()',
    'r', "hello"
  );
});

Deno.test("trimEnd: no trailing spaces", () => {
  assertStringResult(
    'let r = "  hello".trimEnd()',
    'r', "  hello"
  );
});

Deno.test("trimEnd: both sides", () => {
  assertStringResult(
    'let r = "  hello  ".trimEnd()',
    'r', "  hello"
  );
});

Deno.test("trimEnd: all spaces", () => {
  assertStringResult(
    'let r = "   ".trimEnd()',
    'r', ""
  );
});

Deno.test("trimEnd: empty string", () => {
  assertStringResult(
    'let r = "".trimEnd()',
    'r', ""
  );
});

Deno.test("trimEnd: tabs and newlines", () => {
  assertStringResult(
    "let r = \"hello \\t\\n\".trimEnd()",
    'r', "hello"
  );
});

// =============================================================================
// String lastIndexOf
// =============================================================================

Deno.test("String lastIndexOf: basic", () => {
  assertNumericResult(
    'let r = "hello world hello".lastIndexOf("hello")',
    'r', 12
  );
});

Deno.test("String lastIndexOf: not found", () => {
  assertNumericResult(
    'let r = "hello".lastIndexOf("xyz")',
    'r', -1
  );
});

Deno.test("String lastIndexOf: single char", () => {
  assertNumericResult(
    'let r = "abcabc".lastIndexOf("c")',
    'r', 5
  );
});

Deno.test("String lastIndexOf: at start", () => {
  assertNumericResult(
    'let r = "abc".lastIndexOf("abc")',
    'r', 0
  );
});

Deno.test("String lastIndexOf: empty search", () => {
  assertNumericResult(
    'let r = "hello".lastIndexOf("")',
    'r', 5
  );
});

Deno.test("String lastIndexOf: empty source", () => {
  assertNumericResult(
    'let r = "".lastIndexOf("a")',
    'r', -1
  );
});

// =============================================================================
// String at
// =============================================================================

Deno.test("String at: positive index", () => {
  assertStringResult('let r = "hello".at(1)', 'r', "e");
});

Deno.test("String at: first char", () => {
  assertStringResult('let r = "hello".at(0)', 'r', "h");
});

Deno.test("String at: last char with -1", () => {
  assertStringResult('let r = "hello".at(-1)', 'r', "o");
});

Deno.test("String at: second to last with -2", () => {
  assertStringResult('let r = "hello".at(-2)', 'r', "l");
});

Deno.test("String at: out of bounds returns undefined", () => {
  assertUndefinedResult('let r = "hi".at(5)', 'r');
});

Deno.test("String at: negative out of bounds returns undefined", () => {
  assertUndefinedResult('let r = "hi".at(-5)', 'r');
});

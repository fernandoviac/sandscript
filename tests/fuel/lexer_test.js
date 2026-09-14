/**
 * Lexer Tests
 *
 * Run with: deno task test tests/fuel/lexer_test.js
 */

import { assertEquals, assertThrows } from "https://deno.land/std@0.208.0/assert/mod.ts";
import { Lexer, TokenType } from '../../src/fuel/lexer.js';

function tokenize(source) {
  const lexer = new Lexer(source);
  const tokens = [];
  let token;
  while ((token = lexer.next()).type !== TokenType.EOF) {
    tokens.push(token);
  }
  return tokens;
}

// =============================================================================
// Comment Tokens
// =============================================================================

Deno.test("Lexer: single-line comment token", () => {
  const tokens = tokenize('// hello');
  assertEquals(tokens.length, 1);
  assertEquals(tokens[0].type, TokenType.COMMENT);
  assertEquals(tokens[0].value, '// hello');
  assertEquals(tokens[0].start, 0);
  assertEquals(tokens[0].end, 8);
});

Deno.test("Lexer: single-line comment preserves position", () => {
  const tokens = tokenize('let x // comment');
  assertEquals(tokens.length, 3);
  assertEquals(tokens[0].type, TokenType.LET);
  assertEquals(tokens[1].type, TokenType.IDENTIFIER);
  assertEquals(tokens[2].type, TokenType.COMMENT);
  assertEquals(tokens[2].value, '// comment');
  assertEquals(tokens[2].start, 6);
  assertEquals(tokens[2].end, 16);
});

Deno.test("Lexer: multi-line comment token", () => {
  const tokens = tokenize('/* block */');
  assertEquals(tokens.length, 1);
  assertEquals(tokens[0].type, TokenType.COMMENT);
  assertEquals(tokens[0].value, '/* block */');
  assertEquals(tokens[0].start, 0);
  assertEquals(tokens[0].end, 11);
});

Deno.test("Lexer: multi-line comment spanning lines", () => {
  const tokens = tokenize('/* line1\nline2 */');
  assertEquals(tokens.length, 1);
  assertEquals(tokens[0].type, TokenType.COMMENT);
  assertEquals(tokens[0].value, '/* line1\nline2 */');
});

Deno.test("Lexer: unterminated multi-line comment reaches EOF", () => {
  const tokens = tokenize('/* unterminated');
  assertEquals(tokens.length, 1);
  assertEquals(tokens[0].type, TokenType.COMMENT);
  assertEquals(tokens[0].value, '/* unterminated');
  assertEquals(tokens[0].end, 15);
});

Deno.test("Lexer: multiple comments in sequence", () => {
  const tokens = tokenize('let x = 1; // first\n/* second */ y');

  const types = tokens.map(t => t.type);
  assertEquals(types, [
    TokenType.LET,
    TokenType.IDENTIFIER,
    TokenType.ASSIGN,
    TokenType.INTEGER,
    TokenType.SEMICOLON,
    TokenType.COMMENT,
    TokenType.COMMENT,
    TokenType.IDENTIFIER,
  ]);

  assertEquals(tokens[5].value, '// first');
  assertEquals(tokens[6].value, '/* second */');
});

Deno.test("Lexer: comment between operators", () => {
  const tokens = tokenize('1 /* plus */ + 2');
  const types = tokens.map(t => t.type);
  assertEquals(types, [
    TokenType.INTEGER,
    TokenType.COMMENT,
    TokenType.PLUS,
    TokenType.INTEGER,
  ]);
});

Deno.test("Lexer: empty single-line comment", () => {
  const tokens = tokenize('//');
  assertEquals(tokens.length, 1);
  assertEquals(tokens[0].type, TokenType.COMMENT);
  assertEquals(tokens[0].value, '//');
});

Deno.test("Lexer: empty multi-line comment", () => {
  const tokens = tokenize('/**/');
  assertEquals(tokens.length, 1);
  assertEquals(tokens[0].type, TokenType.COMMENT);
  assertEquals(tokens[0].value, '/**/');
});

Deno.test("Lexer: comment line/col tracking", () => {
  const tokens = tokenize('x\n// comment on line 2');
  assertEquals(tokens[1].type, TokenType.COMMENT);
  assertEquals(tokens[1].line, 2);
  assertEquals(tokens[1].col, 1);
});

// =============================================================================
// Loose equality rejection
// =============================================================================

Deno.test("Lexer: '==' throws with explicit message", () => {
  assertThrows(
    () => tokenize('1 == 1'),
    SyntaxError,
    "loose equality '==' is not supported; use '==='",
  );
});

Deno.test("Lexer: '!=' throws with explicit message", () => {
  assertThrows(
    () => tokenize('1 != 2'),
    SyntaxError,
    "loose equality '!=' is not supported; use '!=='",
  );
});

Deno.test("Lexer: '===' still tokenizes", () => {
  const tokens = tokenize('1 === 1');
  assertEquals(tokens.map(t => t.type), [TokenType.INTEGER, TokenType.EQ, TokenType.INTEGER]);
});

Deno.test("Lexer: '!==' still tokenizes", () => {
  const tokens = tokenize('1 !== 2');
  assertEquals(tokens.map(t => t.type), [TokenType.INTEGER, TokenType.NEQ, TokenType.INTEGER]);
});

Deno.test("Lexer: single '=' (assignment) still tokenizes", () => {
  const tokens = tokenize('x = 1');
  assertEquals(tokens.map(t => t.type), [TokenType.IDENTIFIER, TokenType.ASSIGN, TokenType.INTEGER]);
});

Deno.test("Lexer: single '!' (logical not) still tokenizes", () => {
  const tokens = tokenize('!x');
  assertEquals(tokens.map(t => t.type), [TokenType.NOT, TokenType.IDENTIFIER]);
});

Deno.test("Lexer: '=>' (arrow) still tokenizes", () => {
  const tokens = tokenize('() => 1');
  assertEquals(tokens.map(t => t.type), [TokenType.LPAREN, TokenType.RPAREN, TokenType.ARROW, TokenType.INTEGER]);
});

// =============================================================================
// String Escapes
//
// An escape that means something must mean it, and an escape the table does
// not know must be refused. The old default dropped the backslash, so
// "\u2193" became the letters u2193 and drew them into documents with
// nothing reported.
// =============================================================================

function stringValue(source) {
  return tokenize(source)[0].value;
}

Deno.test("Lexer: the simple escapes carry their control characters", () => {
  assertEquals(stringValue('"a\\nb"'), 'a\nb');
  assertEquals(stringValue('"a\\tb"'), 'a\tb');
  assertEquals(stringValue('"a\\rb"'), 'a\rb');
  assertEquals(stringValue('"a\\bb"'), 'a\bb');
  assertEquals(stringValue('"a\\fb"'), 'a\fb');
  assertEquals(stringValue('"a\\vb"'), 'a\vb');
  assertEquals(stringValue('"a\\0b"'), 'a\0b');
});

Deno.test("Lexer: the quoting escapes survive", () => {
  assertEquals(stringValue('"a\\\\b"'), 'a\\b');
  assertEquals(stringValue('"a\\"b"'), 'a"b');
  assertEquals(stringValue("'a\\'b'"), "a'b");
  assertEquals(stringValue('"a\\`b"'), 'a`b');
  assertEquals(stringValue('"a\\$b"'), 'a$b');
  assertEquals(stringValue('"a\\/b"'), 'a/b');
});

Deno.test("Lexer: a four-digit unicode escape is its character", () => {
  // The exact escapes that drew as letters: an arrow, a degree sign, a
  // minus sign, a bullet.
  assertEquals(stringValue('"\\u2193"'), '\u2193');
  assertEquals(stringValue('"\\u00B0"'), '\u00B0');
  assertEquals(stringValue('"\\u2212"'), '\u2212');
  assertEquals(stringValue('"\\u2022"'), '\u2022');
});

Deno.test("Lexer: a braced unicode escape reaches the astral planes", () => {
  assertEquals(stringValue('"\\u{1F300}"'), '\u{1F300}');
  assertEquals(stringValue('"\\u{41}"'), 'A');
  assertEquals(stringValue('"\\u{10FFFF}"'), '\u{10FFFF}');
});

Deno.test("Lexer: a lone surrogate stays expressible", () => {
  // \uXXXX addresses one code unit, so half a pair must survive on its own.
  assertEquals(stringValue('"\\uD83C"'), '\uD83C');
  assertEquals(stringValue('"\\uD83C\\uDF00"'), '\u{1F300}');
});

Deno.test("Lexer: a hex escape is its character", () => {
  assertEquals(stringValue('"\\x41"'), 'A');
  assertEquals(stringValue('"\\x00"'), '\0');
});

Deno.test("Lexer: an unknown escape is refused, and says what to write", () => {
  assertThrows(() => tokenize('"\\p"'), Error, 'Unknown escape "\\p"');
  assertThrows(() => tokenize('"\\d+"'), Error, 'Unknown escape "\\d"');
  // The message must name both exits, or the refusal is a dead end.
  assertThrows(() => tokenize('"\\p"'), Error, 'literal backslash');
  assertThrows(() => tokenize('"\\p"'), Error, '\\u{...}');
});

Deno.test("Lexer: a malformed escape payload is refused, never half-read", () => {
  assertThrows(() => tokenize('"\\u21"'), Error, 'needs 4 hexadecimal digits');
  assertThrows(() => tokenize('"\\xZZ"'), Error, 'needs 2 hexadecimal digits');
  assertThrows(() => tokenize('"\\u{}"'), Error, 'needs 1 to 6 hexadecimal digits');
  assertThrows(() => tokenize('"\\u{110000}"'), Error, 'above the highest code point');
});

Deno.test("Lexer: an octal escape is refused rather than guessed", () => {
  assertThrows(() => tokenize('"\\01"'), Error, 'Octal escapes are not supported');
  assertThrows(() => tokenize('"\\7"'), Error, 'Octal escapes are not supported');
});

Deno.test("Lexer: a line continuation joins two lines and adds nothing", () => {
  assertEquals(stringValue('"a\\\nb"'), 'ab');
  assertEquals(stringValue('"a\\\r\nb"'), 'ab');
});

Deno.test("Lexer: a template literal reads the same escape table", () => {
  assertEquals(stringValue('`\\u2193`'), '\u2193');
  assertEquals(stringValue('`\\u{1F300}`'), '\u{1F300}');
  assertEquals(stringValue('`\\x41`'), 'A');
  assertEquals(stringValue('`a\\`b`'), 'a`b');
  assertEquals(stringValue('`a\\${b}`'), 'a${b}');
  assertThrows(() => tokenize('`\\q`'), Error, 'Unknown escape "\\q"');
  assertThrows(() => tokenize('`\\u21`'), Error, 'needs 4 hexadecimal digits');
});

Deno.test("Lexer: a regular expression keeps its own escapes", () => {
  // The regex body is the engine's to read: \d must reach it untouched and
  // must never be judged against the string table. The lexer reads a '/'
  // under the division goal first, so the parser asks for the re-scan.
  const lexer = new Lexer('/\\d+/g');
  const slash = lexer.next();
  const regexp = lexer.rescanRegExpFrom(slash);
  assertEquals(regexp.type, TokenType.REGEXP);
  assertEquals(regexp.value.pattern, '\\d+');
  assertEquals(regexp.value.flags, 'g');
});

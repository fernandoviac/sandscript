/**
 * Test interpreter string methods, UTF-8 handling, and string concatenation.
 *
 * Run with: deno task test tests/fuel/interpreter-strings_test.js
 */

import {
  assertBooleanResult,
  assertNumericResult,
  assertStringResult,
} from './interpreter-test-utils.js';

// =============================================================================
// String Length
// =============================================================================

Deno.test("String: length basic", () => {
  assertNumericResult('let s = "hello"; let y = s.length', 'y', 5);
});

Deno.test("String: length empty", () => {
  assertNumericResult('let s = ""; let y = s.length', 'y', 0);
});

Deno.test("String: length one", () => {
  assertNumericResult('let s = "x"; let y = s.length', 'y', 1);
});

Deno.test("String: length spaces", () => {
  assertNumericResult('let s = "a b c"; let y = s.length', 'y', 5);
});

Deno.test("String: literal length", () => {
  assertNumericResult('let y = "test".length', 'y', 4);
});

// =============================================================================
// String Query Methods
// =============================================================================

Deno.test("String: indexOf found", () => {
  assertNumericResult('let s = "hello world"; let y = s.indexOf("wor")', 'y', 6);
});

Deno.test("String: indexOf not found", () => {
  assertNumericResult('let s = "hello world"; let y = s.indexOf("xyz")', 'y', -1);
});

Deno.test("String: indexOf at start", () => {
  assertNumericResult('let s = "hello world"; let y = s.indexOf("hel")', 'y', 0);
});

Deno.test("String: indexOf empty", () => {
  assertNumericResult('let s = "hello"; let y = s.indexOf("")', 'y', 0);
});

// fromIndex (the second argument) — the bug that broke the door's email
// validator (2026-07-04): s.indexOf(".", at) silently ignored `at`.
Deno.test("String: indexOf fromIndex skips an earlier match", () => {
  assertNumericResult('let s = "fernando.via@gmail.com"; let y = s.indexOf(".", 13)', 'y', 18);
});

Deno.test("String: indexOf fromIndex zero matches plain scan", () => {
  assertNumericResult('let s = "a.b.c"; let y = s.indexOf(".", 0)', 'y', 1);
});

Deno.test("String: indexOf fromIndex at the match position finds it", () => {
  assertNumericResult('let s = "a.b.c"; let y = s.indexOf(".", 3)', 'y', 3);
});

Deno.test("String: indexOf fromIndex past all matches is -1", () => {
  assertNumericResult('let s = "a.b.c"; let y = s.indexOf(".", 4)', 'y', -1);
});

Deno.test("String: indexOf negative fromIndex clamps to 0", () => {
  assertNumericResult('let s = "a.b"; let y = s.indexOf(".", -5)', 'y', 1);
});

Deno.test("String: indexOf fromIndex beyond length is -1", () => {
  assertNumericResult('let s = "abc"; let y = s.indexOf("b", 99)', 'y', -1);
});

Deno.test("String: indexOf empty search with fromIndex is min(fromIndex, length)", () => {
  assertNumericResult('let s = "abc"; let y = s.indexOf("", 2)', 'y', 2);
});

Deno.test("String: indexOf empty search with huge fromIndex is length", () => {
  assertNumericResult('let s = "abc"; let y = s.indexOf("", 99)', 'y', 3);
});

Deno.test("String: includes true", () => {
  assertNumericResult('let s = "hello world"; let y; if (s.includes("wor")) { y = 1 } else { y = 0 }', 'y', 1);
});

Deno.test("String: includes false", () => {
  assertNumericResult('let s = "hello world"; let y; if (s.includes("xyz")) { y = 1 } else { y = 0 }', 'y', 0);
});

Deno.test("String: startsWith true", () => {
  assertNumericResult('let s = "hello world"; let y; if (s.startsWith("hello")) { y = 1 } else { y = 0 }', 'y', 1);
});

Deno.test("String: startsWith false", () => {
  assertNumericResult('let s = "hello world"; let y; if (s.startsWith("world")) { y = 1 } else { y = 0 }', 'y', 0);
});

Deno.test("String: startsWith empty", () => {
  assertNumericResult('let s = "hello"; let y; if (s.startsWith("")) { y = 1 } else { y = 0 }', 'y', 1);
});

Deno.test("String: endsWith true", () => {
  assertNumericResult('let s = "hello world"; let y; if (s.endsWith("world")) { y = 1 } else { y = 0 }', 'y', 1);
});

Deno.test("String: endsWith false", () => {
  assertNumericResult('let s = "hello world"; let y; if (s.endsWith("hello")) { y = 1 } else { y = 0 }', 'y', 0);
});

Deno.test("String: endsWith empty", () => {
  assertNumericResult('let s = "hello"; let y; if (s.endsWith("")) { y = 1 } else { y = 0 }', 'y', 1);
});

// =============================================================================
// String Extraction Methods
// =============================================================================

Deno.test("String: charAt basic", () => {
  assertNumericResult('let s = "hello"; let c = s.charAt(1); let y = c.charCodeAt(0)', 'y', 101);
});

Deno.test("String: charAt out of bounds", () => {
  assertNumericResult('let s = "hi"; let c = s.charAt(10); let y = c.length', 'y', 0);
});

Deno.test("String: charAt negative", () => {
  assertNumericResult('let s = "hello"; let c = s.charAt(-1); let y = c.length', 'y', 0);
});

Deno.test("String: charCodeAt basic", () => {
  assertNumericResult('let s = "hello"; let y = s.charCodeAt(0)', 'y', 104);
});

Deno.test("String: charCodeAt second", () => {
  assertNumericResult('let s = "hello"; let y = s.charCodeAt(1)', 'y', 101);
});

Deno.test("String: slice basic", () => {
  assertNumericResult('let s = "hello world"; let r = s.slice(0, 5); let y = r.length', 'y', 5);
});

Deno.test("String: slice content", () => {
  assertNumericResult('let s = "hello world"; let r = s.slice(6, 11); let y = r.charCodeAt(0)', 'y', 119);
});

Deno.test("String: slice negative start", () => {
  assertNumericResult('let s = "hello"; let r = s.slice(-2); let y = r.length', 'y', 2);
});

Deno.test("String: slice no end", () => {
  assertNumericResult('let s = "hello"; let r = s.slice(2); let y = r.length', 'y', 3);
});

Deno.test("String: substring basic", () => {
  assertNumericResult('let s = "hello world"; let r = s.substring(0, 5); let y = r.length', 'y', 5);
});

Deno.test("String: substring swap", () => {
  assertNumericResult('let s = "hello"; let r = s.substring(3, 1); let y = r.length', 'y', 2);
});

Deno.test("String: substring negative", () => {
  assertNumericResult('let s = "hello"; let r = s.substring(-2, 3); let y = r.length', 'y', 3);
});

// =============================================================================
// String Transformation Methods
// =============================================================================

Deno.test("String: trim basic", () => {
  assertNumericResult('let s = "  hello  "; let r = s.trim(); let y = r.length', 'y', 5);
});

Deno.test("String: trim whitespace", () => {
  assertNumericResult('let s = "\\thello\\n"; let r = s.trim(); let y = r.length', 'y', 5);
});

Deno.test("String: trim all whitespace", () => {
  assertNumericResult('let s = "   "; let r = s.trim(); let y = r.length', 'y', 0);
});

Deno.test("String: toLowerCase basic", () => {
  assertNumericResult('let s = "HELLO"; let r = s.toLowerCase(); let y = r.charCodeAt(0)', 'y', 104);
});

Deno.test("String: toLowerCase mixed", () => {
  assertNumericResult('let s = "HeLLo"; let r = s.toLowerCase(); let y = r.charCodeAt(2)', 'y', 108);
});

Deno.test("String: toUpperCase basic", () => {
  assertNumericResult('let s = "hello"; let r = s.toUpperCase(); let y = r.charCodeAt(0)', 'y', 72);
});

Deno.test("String: toUpperCase mixed", () => {
  assertNumericResult('let s = "HeLLo"; let r = s.toUpperCase(); let y = r.charCodeAt(2)', 'y', 76);
});

Deno.test("String: split basic", () => {
  assertNumericResult('let s = "a,b,c"; let arr = s.split(","); let y = arr.length', 'y', 3);
});

Deno.test("String: split element", () => {
  assertNumericResult('let s = "hello world"; let arr = s.split(" "); let y = arr[1].length', 'y', 5);
});

Deno.test("String: split empty sep", () => {
  assertNumericResult('let s = "abc"; let arr = s.split(""); let y = arr.length', 'y', 3);
});

Deno.test("String: split no match", () => {
  assertNumericResult('let s = "hello"; let arr = s.split(","); let y = arr.length', 'y', 1);
});

Deno.test("String: split multi-char", () => {
  assertNumericResult('let s = "a::b::c"; let arr = s.split("::"); let y = arr.length', 'y', 3);
});

Deno.test("String: split equality with separator", () => {
  assertBooleanResult('let parts = "a.js".split("."); let y = parts[1] === "js"', 'y', true);
});

Deno.test("String: split equality with empty separator", () => {
  assertBooleanResult('let parts = "abc".split(""); let y = parts[1] === "b"', 'y', true);
});

Deno.test("String: split result as object key", () => {
  assertNumericResult('let m = { js: 42 }; let parts = "a.js".split("."); let y = m[parts[1]]', 'y', 42);
});

Deno.test("String: split first piece equality", () => {
  assertBooleanResult('let parts = "hello world".split(" "); let y = parts[0] === "hello"', 'y', true);
});

Deno.test("String: split last piece equality", () => {
  assertBooleanResult('let parts = "a,b,c".split(","); let y = parts[2] === "c"', 'y', true);
});

// =============================================================================
// String Padding/Repeat Methods
// =============================================================================

Deno.test("String: repeat basic", () => {
  assertNumericResult('let s = "ab"; let r = s.repeat(3); let y = r.length', 'y', 6);
});

Deno.test("String: repeat content", () => {
  assertNumericResult('let s = "ab"; let r = s.repeat(2); let y = r.charCodeAt(2)', 'y', 97);
});

Deno.test("String: repeat zero", () => {
  assertNumericResult('let s = "hello"; let r = s.repeat(0); let y = r.length', 'y', 0);
});

Deno.test("String: padStart basic", () => {
  assertNumericResult('let s = "hi"; let r = s.padStart(5); let y = r.length', 'y', 5);
});

Deno.test("String: padStart fill", () => {
  assertNumericResult('let s = "5"; let r = s.padStart(3, "0"); let y = r.charCodeAt(0)', 'y', 48);
});

Deno.test("String: padStart no change", () => {
  assertNumericResult('let s = "hello"; let r = s.padStart(3); let y = r.length', 'y', 5);
});

Deno.test("String: padEnd basic", () => {
  assertNumericResult('let s = "hi"; let r = s.padEnd(5); let y = r.length', 'y', 5);
});

Deno.test("String: padEnd fill", () => {
  assertNumericResult('let s = "a"; let r = s.padEnd(4, "bc"); let y = r.charCodeAt(3)', 'y', 98);
});

Deno.test("String: padEnd content", () => {
  assertNumericResult('let s = "hi"; let r = s.padEnd(5, "-"); let y = r.charCodeAt(0)', 'y', 104);
});

Deno.test("String: replace basic", () => {
  assertNumericResult('let s = "hello world"; let r = s.replace("world", "there"); let y = r.length', 'y', 11);
});

Deno.test("String: replace content", () => {
  assertNumericResult('let s = "hello world"; let r = s.replace("world", "x"); let y = r.charCodeAt(6)', 'y', 120);
});

Deno.test("String: replace not found", () => {
  assertNumericResult('let s = "hello"; let r = s.replace("xyz", "abc"); let y = r.length', 'y', 5);
});

Deno.test("String: replace first only", () => {
  assertNumericResult('let s = "aaa"; let r = s.replace("a", "b"); let y = r.charCodeAt(1)', 'y', 97);
});

// =============================================================================
// UTF-8 Tests
// =============================================================================

Deno.test("UTF-8: string length", () => {
  assertNumericResult('let s = "café"; let y = s.length', 'y', 4);
});

Deno.test("UTF-8: charCodeAt 2-byte", () => {
  assertNumericResult('let s = "café"; let y = s.charCodeAt(3)', 'y', 233);
});

Deno.test("UTF-8: charAt length", () => {
  assertNumericResult('let s = "café"; let c = s.charAt(3); let y = c.length', 'y', 1);
});

Deno.test("UTF-8: charAt charCodeAt", () => {
  assertNumericResult('let s = "café"; let c = s.charAt(3); let y = c.charCodeAt(0)', 'y', 233);
});

Deno.test("UTF-8: 3-byte length", () => {
  assertNumericResult('let s = "中文"; let y = s.length', 'y', 2);
});

Deno.test("UTF-8: 3-byte charCodeAt first", () => {
  assertNumericResult('let s = "中文"; let y = s.charCodeAt(0)', 'y', 0x4E2D);
});

Deno.test("UTF-8: 3-byte charCodeAt second", () => {
  assertNumericResult('let s = "中文"; let y = s.charCodeAt(1)', 'y', 0x6587);
});

Deno.test("UTF-8: mixed length", () => {
  assertNumericResult('let s = "a中b"; let y = s.length', 'y', 3);
});

Deno.test("UTF-8: mixed charCodeAt 0", () => {
  assertNumericResult('let s = "a中b"; let y = s.charCodeAt(0)', 'y', 97);
});

Deno.test("UTF-8: mixed charCodeAt 1", () => {
  assertNumericResult('let s = "a中b"; let y = s.charCodeAt(1)', 'y', 0x4E2D);
});

Deno.test("UTF-8: mixed charCodeAt 2", () => {
  assertNumericResult('let s = "a中b"; let y = s.charCodeAt(2)', 'y', 98);
});

Deno.test("UTF-8: 4-byte length", () => {
  assertNumericResult('let s = "😀"; let y = s.length', 'y', 1);
});

Deno.test("UTF-8: 4-byte charCodeAt", () => {
  assertNumericResult('let s = "😀"; let y = s.charCodeAt(0)', 'y', 0x1F600);
});

Deno.test("UTF-8: multiple emoji length", () => {
  assertNumericResult('let s = "😀😎"; let y = s.length', 'y', 2);
});

Deno.test("UTF-8: emoji charCodeAt second", () => {
  assertNumericResult('let s = "😀😎"; let y = s.charCodeAt(1)', 'y', 0x1F60E);
});

Deno.test("UTF-8: all byte lengths", () => {
  assertNumericResult('let s = "aéβ😀"; let y = s.length', 'y', 4);
});

Deno.test("UTF-8: toLowerCase ASCII range", () => {
  assertNumericResult('let s = "ABCXYZ"; let r = s.toLowerCase(); let y = r.charCodeAt(0)', 'y', 97);
});

Deno.test("UTF-8: toUpperCase ASCII range", () => {
  assertNumericResult('let s = "abcxyz"; let r = s.toUpperCase(); let y = r.charCodeAt(0)', 'y', 65);
});

Deno.test("UTF-8: toLowerCase Z", () => {
  assertNumericResult('let s = "Z"; let r = s.toLowerCase(); let y = r.charCodeAt(0)', 'y', 122);
});

Deno.test("UTF-8: toUpperCase z", () => {
  assertNumericResult('let s = "z"; let r = s.toUpperCase(); let y = r.charCodeAt(0)', 'y', 90);
});

// =============================================================================
// String Output Verification
// =============================================================================

Deno.test("String output: toUpperCase", () => {
  assertStringResult('let s = "hello"; let y = s.toUpperCase()', 'y', 'HELLO');
});

Deno.test("String output: toUpperCase mixed", () => {
  assertStringResult('let s = "HeLLo WoRLd"; let y = s.toUpperCase()', 'y', 'HELLO WORLD');
});

Deno.test("String output: toLowerCase", () => {
  assertStringResult('let s = "HELLO"; let y = s.toLowerCase()', 'y', 'hello');
});

Deno.test("String output: toLowerCase mixed", () => {
  assertStringResult('let s = "HeLLo WoRLd"; let y = s.toLowerCase()', 'y', 'hello world');
});

Deno.test("String output: charAt basic", () => {
  assertStringResult('let s = "hello"; let y = s.charAt(1)', 'y', 'e');
});

Deno.test("String output: charAt first", () => {
  assertStringResult('let s = "world"; let y = s.charAt(0)', 'y', 'w');
});

Deno.test("String output: charAt last", () => {
  assertStringResult('let s = "test"; let y = s.charAt(3)', 'y', 't');
});

Deno.test("String output: slice basic", () => {
  assertStringResult('let s = "hello world"; let y = s.slice(0, 5)', 'y', 'hello');
});

Deno.test("String output: slice from middle", () => {
  assertStringResult('let s = "hello world"; let y = s.slice(6, 11)', 'y', 'world');
});

Deno.test("String output: trim basic", () => {
  assertStringResult('let s = "  hello  "; let y = s.trim()', 'y', 'hello');
});

Deno.test("String output: repeat basic", () => {
  assertStringResult('let s = "ab"; let y = s.repeat(3)', 'y', 'ababab');
});

Deno.test("String output: padStart basic", () => {
  assertStringResult('let s = "5"; let y = s.padStart(3, "0")', 'y', '005');
});

Deno.test("String output: padEnd basic", () => {
  assertStringResult('let s = "x"; let y = s.padEnd(4, "-")', 'y', 'x---');
});

Deno.test("String output: replace basic", () => {
  assertStringResult('let s = "hello world"; let y = s.replace("world", "there")', 'y', 'hello there');
});

Deno.test("String output: substring basic", () => {
  assertStringResult('let s = "hello world"; let y = s.substring(0, 5)', 'y', 'hello');
});

Deno.test("String output: charAt UTF-8 2-byte", () => {
  assertStringResult('let s = "café"; let y = s.charAt(3)', 'y', 'é');
});

Deno.test("String output: toUpperCase preserves non-alpha", () => {
  assertStringResult('let s = "hello123"; let y = s.toUpperCase()', 'y', 'HELLO123');
});

Deno.test("String output: toLowerCase preserves non-alpha", () => {
  assertStringResult('let s = "HELLO123"; let y = s.toLowerCase()', 'y', 'hello123');
});

Deno.test("String output: 3-byte charAt", () => {
  assertStringResult('let s = "中文"; let y = s.charAt(1)', 'y', '文');
});

Deno.test("String output: 4-byte charAt", () => {
  assertStringResult('let s = "😀"; let y = s.charAt(0)', 'y', '😀');
});

Deno.test("String output: UTF-8 slice 3-byte", () => {
  assertStringResult('let s = "a中文b"; let y = s.slice(1, 3)', 'y', '中文');
});

Deno.test("String output: UTF-8 slice emoji", () => {
  assertStringResult('let s = "hi😀bye"; let y = s.slice(2, 3)', 'y', '😀');
});

// =============================================================================
// Latin-1 Case Conversion
// =============================================================================

Deno.test("Latin-1: toUpperCase café", () => {
  assertStringResult('let s = "café"; let y = s.toUpperCase()', 'y', 'CAFÉ');
});

Deno.test("Latin-1: toUpperCase résumé", () => {
  assertStringResult('let s = "résumé"; let y = s.toUpperCase()', 'y', 'RÉSUMÉ');
});

Deno.test("Latin-1: toUpperCase àöø", () => {
  assertStringResult('let s = "àöø"; let y = s.toUpperCase()', 'y', 'ÀÖØ');
});

Deno.test("Latin-1: toUpperCase þ", () => {
  assertStringResult('let s = "þ"; let y = s.toUpperCase()', 'y', 'Þ');
});

Deno.test("Latin-1: toLowerCase CAFÉ", () => {
  assertStringResult('let s = "CAFÉ"; let y = s.toLowerCase()', 'y', 'café');
});

Deno.test("Latin-1: toLowerCase RÉSUMÉ", () => {
  assertStringResult('let s = "RÉSUMÉ"; let y = s.toLowerCase()', 'y', 'résumé');
});

Deno.test("Latin-1: toLowerCase ÀÖØ", () => {
  assertStringResult('let s = "ÀÖØ"; let y = s.toLowerCase()', 'y', 'àöø');
});

Deno.test("Latin-1: toLowerCase Þ", () => {
  assertStringResult('let s = "Þ"; let y = s.toLowerCase()', 'y', 'þ');
});

Deno.test("Latin-1: toUpperCase mixed", () => {
  assertStringResult('let s = "hello café world"; let y = s.toUpperCase()', 'y', 'HELLO CAFÉ WORLD');
});

Deno.test("Latin-1: toLowerCase mixed", () => {
  assertStringResult('let s = "HELLO CAFÉ WORLD"; let y = s.toLowerCase()', 'y', 'hello café world');
});

Deno.test("Latin-1: toUpperCase division sign unchanged", () => {
  assertStringResult('let s = "a÷b"; let y = s.toUpperCase()', 'y', 'A÷B');
});

Deno.test("Latin-1: toLowerCase multiplication sign unchanged", () => {
  assertStringResult('let s = "A×B"; let y = s.toLowerCase()', 'y', 'a×b');
});

// =============================================================================
// String Concatenation
// =============================================================================

Deno.test("Concat: string + string basic", () => {
  assertStringResult('let x = "Hello" + " World"', 'x', 'Hello World');
});

Deno.test("Concat: string + string variables", () => {
  assertStringResult('let a = "foo"; let b = "bar"; let x = a + b', 'x', 'foobar');
});

Deno.test("Concat: string + string chained", () => {
  assertStringResult('let x = "a" + "b" + "c"', 'x', 'abc');
});

Deno.test("Concat: string + empty string", () => {
  assertStringResult('let x = "hello" + ""', 'x', 'hello');
});

Deno.test("Concat: empty string + string", () => {
  assertStringResult('let x = "" + "world"', 'x', 'world');
});

Deno.test("Concat: empty + empty", () => {
  assertStringResult('let x = "" + ""', 'x', '');
});

Deno.test("Concat: string + number coercion", () => {
  assertStringResult('let x = "value: " + 42', 'x', 'value: 42');
});

Deno.test("Concat: number + string coercion", () => {
  assertStringResult('let x = 42 + " is the answer"', 'x', '42 is the answer');
});

Deno.test("Concat: string + boolean coercion", () => {
  assertStringResult('let x = "flag: " + true', 'x', 'flag: true');
});

Deno.test("Concat: string + null coercion", () => {
  assertStringResult('let x = "val: " + null', 'x', 'val: null');
});

Deno.test("Concat: string + undefined coercion", () => {
  assertStringResult('let x = "val: " + undefined', 'x', 'val: undefined');
});

Deno.test("Concat: complex concatenation", () => {
  assertStringResult('let name = "World"; let x = "Hello, " + name + "!"', 'x', 'Hello, World!');
});

// =============================================================================
// String.prototype.concat (added 2026-07-05 — previously missing entirely,
// calls threw not-a-function)
// =============================================================================

Deno.test("String: concat two arguments", () => {
  assertStringResult('let y = "a".concat("b", "c")', 'y', 'abc');
});

Deno.test("String: concat coerces non-string arguments", () => {
  assertStringResult('let y = "x".concat(1, 2)', 'y', 'x12');
});

Deno.test("String: concat with no arguments returns receiver", () => {
  assertStringResult('let y = "solo".concat()', 'y', 'solo');
});

Deno.test("String: concat mixed value types", () => {
  assertStringResult('let y = "v=".concat(true, null)', 'y', 'v=truenull');
});

Deno.test("String: concat chains", () => {
  assertStringResult('let y = "a".concat("b").concat("c")', 'y', 'abc');
});

Deno.test("String: concat with spread arguments", () => {
  assertStringResult('let parts = ["b", "c"]; let y = "a".concat(...parts)', 'y', 'abc');
});

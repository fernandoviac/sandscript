/**
 * Tests for the btoa / atob global base64 functions.
 *
 * WHATWG semantics: btoa encodes a binary string (every code point <= 0xFF)
 * to base64; atob is a forgiving-base64 decode back to a binary string.
 * Both throw an Error whose name is "InvalidCharacterError" on bad input —
 * matching the DOMException name real JS throws, on the plain Error
 * prototype (instanceof Error true, instanceof TypeError false).
 *
 * Run with: deno task test tests/fuel/base64_test.js
 */

import { assertEquals } from "https://deno.land/std@0.208.0/assert/mod.ts";
import { freshSession } from '../../src/host-owned-session.js';
import { parseAndSetup } from './test-helpers.js';

function run(source) {
  const session = freshSession();
  parseAndSetup(session, source);
  session.run(0, 1_000_000);
  return session;
}

function assertResult(source, varName, expected) {
  const session = run(source);
  assertEquals(session.get(0, varName), expected);
}

// =============================================================================
// btoa — known vectors (all three padding cases)
// =============================================================================

Deno.test("btoa: empty string", () => {
  assertResult(`let r = btoa("")`, 'r', '');
});

Deno.test("btoa: one byte (two padding chars)", () => {
  assertResult(`let r = btoa("a")`, 'r', 'YQ==');
});

Deno.test("btoa: two bytes (one padding char)", () => {
  assertResult(`let r = btoa("ab")`, 'r', 'YWI=');
});

Deno.test("btoa: three bytes (no padding)", () => {
  assertResult(`let r = btoa("abc")`, 'r', 'YWJj');
});

Deno.test("btoa: longer ASCII string", () => {
  assertResult(`let r = btoa("Hello, World!")`, 'r', btoa("Hello, World!"));
});

Deno.test("btoa: all 64 alphabet outputs exercised", () => {
  const input = Array.from({ length: 48 }, (_, i) => i * 5 % 256);
  const source = `let r = btoa(String.fromCharCode(${input.join(',')}))`;
  assertResult(source, 'r', btoa(String.fromCharCode(...input)));
});

// =============================================================================
// btoa — high bytes (0x80-0xFF are valid binary-string code points)
// =============================================================================

Deno.test("btoa: single 0xFF byte", () => {
  assertResult(`let r = btoa(String.fromCharCode(255))`, 'r',
    btoa(String.fromCharCode(255)));
});

Deno.test("btoa: all 256 byte values", () => {
  const bytes = Array.from({ length: 256 }, (_, i) => i);
  const source = `
    let s = "";
    for (let i = 0; i < 256; i = i + 1) { s = s + String.fromCharCode(i); }
    let r = btoa(s);
  `;
  assertResult(source, 'r', btoa(String.fromCharCode(...bytes)));
});

// =============================================================================
// btoa — coercion and errors
// =============================================================================

Deno.test("btoa: non-string argument is stringified", () => {
  assertResult(`let r = btoa(123)`, 'r', btoa("123"));
});

Deno.test("btoa: code point above 0xFF throws InvalidCharacterError", () => {
  const source = `
    let name = "";
    let isError = false;
    let isTypeError = false;
    try { btoa("€"); } catch (e) {
      name = e.name;
      isError = e instanceof Error;
      isTypeError = e instanceof TypeError;
    }
  `;
  const session = run(source);
  assertEquals(session.get(0, 'name'), 'InvalidCharacterError');
  assertEquals(session.get(0, 'isError'), true);
  assertEquals(session.get(0, 'isTypeError'), false);
});

Deno.test("btoa: no arguments throws TypeError", () => {
  const source = `
    let isTypeError = false;
    try { btoa(); } catch (e) { isTypeError = e instanceof TypeError; }
  `;
  assertResult(source, 'isTypeError', true);
});

// =============================================================================
// atob — known vectors
// =============================================================================

Deno.test("atob: empty string", () => {
  assertResult(`let r = atob("")`, 'r', '');
});

Deno.test("atob: padded single byte", () => {
  assertResult(`let r = atob("YQ==")`, 'r', 'a');
});

Deno.test("atob: padded two bytes", () => {
  assertResult(`let r = atob("YWI=")`, 'r', 'ab');
});

Deno.test("atob: full group", () => {
  assertResult(`let r = atob("YWJj")`, 'r', 'abc');
});

Deno.test("atob: unpadded input accepted (forgiving)", () => {
  assertResult(`let r = atob("YWI")`, 'r', 'ab');
  assertResult(`let r = atob("YQ")`, 'r', 'a');
});

Deno.test("atob: embedded whitespace stripped", () => {
  assertResult(`let r = atob("YW\\nJj")`, 'r', 'abc');
  assertResult(`let r = atob(" Y W J j ")`, 'r', 'abc');
  assertResult(`let r = atob("YQ=\\n=")`, 'r', 'a');
});

Deno.test("atob: high bytes read back via charCodeAt", () => {
  const source = `
    let decoded = atob("${btoa(String.fromCharCode(0, 127, 128, 200, 255))}");
    let length = decoded.length;
    let b0 = decoded.charCodeAt(0);
    let b1 = decoded.charCodeAt(1);
    let b2 = decoded.charCodeAt(2);
    let b3 = decoded.charCodeAt(3);
    let b4 = decoded.charCodeAt(4);
  `;
  const session = run(source);
  assertEquals(session.get(0, 'length'), 5);
  assertEquals(session.get(0, 'b0'), 0);
  assertEquals(session.get(0, 'b1'), 127);
  assertEquals(session.get(0, 'b2'), 128);
  assertEquals(session.get(0, 'b3'), 200);
  assertEquals(session.get(0, 'b4'), 255);
});

// =============================================================================
// atob — invalid input throws InvalidCharacterError
// =============================================================================

function assertAtobThrows(input) {
  const source = `
    let name = "";
    try { atob("${input}"); } catch (e) { name = e.name; }
  `;
  const session = run(source);
  assertEquals(session.get(0, 'name'), 'InvalidCharacterError');
}

Deno.test("atob: invalid character throws", () => {
  assertAtobThrows('YW!j');
});

Deno.test("atob: length % 4 == 1 throws", () => {
  assertAtobThrows('YWJjZ');
  assertAtobThrows('=');
});

Deno.test("atob: misplaced padding throws", () => {
  assertAtobThrows('Y=Wj');
  assertAtobThrows('YQ=');
  assertAtobThrows('====');
  assertAtobThrows('YWJj====');
});

Deno.test("atob: non-ASCII input throws", () => {
  assertAtobThrows('YWJ€');
});

Deno.test("atob: no arguments throws TypeError", () => {
  const source = `
    let isTypeError = false;
    try { atob(); } catch (e) { isTypeError = e instanceof TypeError; }
  `;
  assertResult(source, 'isTypeError', true);
});

// =============================================================================
// Round trips
// =============================================================================

Deno.test("round trip: ASCII", () => {
  assertResult(`let r = atob(btoa("The quick brown fox"))`, 'r',
    'The quick brown fox');
});

Deno.test("round trip: all 256 byte values survive", () => {
  const source = `
    let s = "";
    for (let i = 0; i < 256; i = i + 1) { s = s + String.fromCharCode(i); }
    let decoded = atob(btoa(s));
    let ok = decoded.length === 256;
    for (let i = 0; i < 256; i = i + 1) {
      if (decoded.charCodeAt(i) !== i) { ok = false; }
    }
  `;
  assertResult(source, 'ok', true);
});

Deno.test("round trip: base64 text through atob then btoa", () => {
  assertResult(`let r = btoa(atob("YWJjZGVm"))`, 'r', 'YWJjZGVm');
});

// ---------------------------------------------------------------------------
// Typed-array string coercion: typed arrays used to fall through
// $value_to_string's
// empty-string fallback, so `"" + bytes` and btoa(bytes) silently
// produced "". ToString on a typed array now matches JS —
// comma-joined decimal elements (Array.prototype.toString semantics)
// — and btoa inherits it.
// ---------------------------------------------------------------------------

Deno.test("btoa(uint8Array) coerces like JS: base64 of the comma-joined decimals", () => {
  const source = `
    let bytes = new Uint8Array(3);
    bytes[0] = 97; bytes[1] = 98; bytes[2] = 99;
    let r = btoa(bytes);
  `;
  // Real JS: btoa(String(bytes)) = btoa("97,98,99") = "OTcsOTgsOTk=".
  assertResult(source, 'r', 'OTcsOTgsOTk=');
});

Deno.test("typed-array string coercion is comma-joined decimals, all shapes", () => {
  const source = `
    let bytes = new Uint8Array(3);
    bytes[0] = 97; bytes[1] = 98; bytes[2] = 99;
    let plain = "" + bytes;
    let floats = new Float32Array(2);
    floats[0] = 1.5; floats[1] = 2;
    let floatStr = "" + floats;
    let emptyStr = "" + new Uint8Array(0);
    let single = "" + new Uint8Array(1);
    let sub = "" + bytes.subarray(1, 3);
  `;
  assertResult(source, 'plain', '97,98,99');
  assertResult(source, 'floatStr', '1.5,2');
  assertResult(source, 'emptyStr', '');
  assertResult(source, 'single', '0');
  assertResult(source, 'sub', '98,99');
});

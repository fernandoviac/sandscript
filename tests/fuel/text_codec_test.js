/**
 * Tests for TextEncoder / TextDecoder.
 *
 * SS strings are stored as UTF-8 natively, so encode is memcpy + descriptor
 * wrap and decode is intern_string over the typed array's bytes. v1 does no
 * UTF-8 validation on decode and accepts (but ignores) the optional label
 * argument to new TextDecoder().
 *
 * Run with: deno task test tests/fuel/text_codec_test.js
 */

import { assertEquals } from "https://deno.land/std@0.208.0/assert/mod.ts";
import { freshSession } from '../../src/host-owned-session.js';
import { parseAndSetup } from './test-helpers.js';
import { UncaughtScriptError } from '../../src/runtime/errors.js';

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

function assertTypeError(source) {
  const session = freshSession();
  parseAndSetup(session, source);
  let err;
  try {
    session.run(0, 1_000_000);
    throw new Error(`expected error, got status=done`);
  } catch (e) {
    if (!(e instanceof UncaughtScriptError)) throw e;
    err = e.scriptError;
  }
  const code = err.codeName;
  if (code !== 'TypeError' && code !== 'USER_THROW') {
    throw new Error(`expected TypeError, got ${code}: ${err.message}`);
  }
}

// session.get returns Uint8Array values as a {0: byte, 1: byte, ...} object,
// not a real Uint8Array. Convert for easier comparison.
function bytesFrom(getResult) {
  return Object.values(getResult);
}

// =============================================================================
// TextEncoder.encode
// =============================================================================

Deno.test("TextEncoder: encode ASCII", () => {
  const session = run(`let r = new TextEncoder().encode("hi")`);

  assertEquals(bytesFrom(session.get(0, 'r')), [104, 105]);
});

Deno.test("TextEncoder: encode empty string", () => {
  const session = run(`let r = new TextEncoder().encode("")`);

  assertEquals(bytesFrom(session.get(0, 'r')), []);
});

Deno.test("TextEncoder: encode 2-byte UTF-8 (é)", () => {
  const session = run(`let r = new TextEncoder().encode("é")`);

  // U+00E9 → 0xC3 0xA9 in UTF-8
  assertEquals(bytesFrom(session.get(0, 'r')), [0xC3, 0xA9]);
});

Deno.test("TextEncoder: encode 4-byte UTF-8 (emoji)", () => {
  const session = run(`let r = new TextEncoder().encode("😀")`);

  // U+1F600 → 0xF0 0x9F 0x98 0x80 in UTF-8
  assertEquals(bytesFrom(session.get(0, 'r')), [0xF0, 0x9F, 0x98, 0x80]);
});

Deno.test("TextEncoder: byte length matches UTF-8 byte count", () => {
  assertResult(`let r = new TextEncoder().encode("héllo😀").length`, 'r', 10);
});

Deno.test("TextEncoder: encode with no args returns empty Uint8Array", () => {
  assertResult(`let r = new TextEncoder().encode().length`, 'r', 0);
});

// =============================================================================
// TextDecoder.decode
// =============================================================================

Deno.test("TextDecoder: decode ASCII", () => {
  assertResult(`let r = new TextDecoder().decode(new Uint8Array([104, 105]))`,
    'r', 'hi');
});

Deno.test("TextDecoder: decode 2-byte UTF-8", () => {
  // 0xC3 0xA9 → é
  assertResult(`let r = new TextDecoder().decode(new Uint8Array([0xC3, 0xA9]))`,
    'r', 'é');
});

Deno.test("TextDecoder: decode 4-byte UTF-8 (emoji)", () => {
  // 0xF0 0x9F 0x98 0x80 → 😀
  assertResult(
    `let r = new TextDecoder().decode(new Uint8Array([0xF0, 0x9F, 0x98, 0x80]))`,
    'r', '😀');
});

Deno.test("TextDecoder: decode empty Uint8Array returns empty string", () => {
  assertResult(`let r = new TextDecoder().decode(new Uint8Array(0))`,
    'r', '');
});

Deno.test("TextDecoder: decode with no args returns empty string", () => {
  assertResult(`let r = new TextDecoder().decode()`, 'r', '');
});

Deno.test("TextDecoder: decode rejects null", () => {
  assertTypeError(`let r = new TextDecoder().decode(null)`);
});

Deno.test("TextDecoder: decode rejects undefined", () => {
  assertTypeError(`let r = new TextDecoder().decode(undefined)`);
});

Deno.test("TextDecoder: decode rejects plain object", () => {
  assertTypeError(`let r = new TextDecoder().decode({})`);
});

Deno.test("TextDecoder: decode rejects string", () => {
  assertTypeError(`let r = new TextDecoder().decode("hi")`);
});

// =============================================================================
// Round-trip
// =============================================================================

Deno.test("Round-trip: ASCII", () => {
  assertResult(
    `let r = new TextDecoder().decode(new TextEncoder().encode("hello world"))`,
    'r', 'hello world');
});

Deno.test("Round-trip: empty string", () => {
  assertResult(
    `let r = new TextDecoder().decode(new TextEncoder().encode(""))`,
    'r', '');
});

Deno.test("Round-trip: multi-byte UTF-8 (héllo😀)", () => {
  assertResult(
    `let r = new TextDecoder().decode(new TextEncoder().encode("héllo😀"))`,
    'r', 'héllo😀');
});

Deno.test("Round-trip: every BMP boundary marker", () => {
  // Code points that sit on each UTF-8 byte-length boundary.
  // U+007F (1-byte), U+0080 (2-byte), U+07FF (2-byte boundary),
  // U+0800 (3-byte), U+FFFF (3-byte boundary), U+10000 (4-byte),
  // U+1F600 (4-byte emoji).
  const src = '\u{7F}\u{80}\u{7FF}\u{800}\u{FFFF}\u{10000}\u{1F600}';
  const session = run(
    `let r = new TextDecoder().decode(new TextEncoder().encode("${src}"))`);
  assertEquals(session.get(0, 'r'), src);
});

// =============================================================================
// Constructor shape
// =============================================================================

Deno.test("TextEncoder: instanceof works", () => {
  assertResult(`let r = (new TextEncoder()) instanceof TextEncoder`, 'r', true);
});

Deno.test("TextDecoder: instanceof works", () => {
  assertResult(`let r = (new TextDecoder()) instanceof TextDecoder`, 'r', true);
});

Deno.test("TextEncoder: not an instance of TextDecoder", () => {
  assertResult(`let r = (new TextEncoder()) instanceof TextDecoder`, 'r', false);
});

Deno.test("TextDecoder: accepts utf-8 label", () => {
  assertResult(
    `let r = new TextDecoder("utf-8").decode(new TextEncoder().encode("hi"))`,
    'r', 'hi');
});

Deno.test("TextDecoder: ignores non-utf-8 label in v1 (deliberate)", () => {
  // v1 does not validate the label; non-UTF-8 labels are silently treated
  // as UTF-8. Documented limitation.
  assertResult(
    `let r = new TextDecoder("utf-16le").decode(new TextEncoder().encode("hi"))`,
    'r', 'hi');
});

// =============================================================================
// Cross-instance: two encoders/decoders share semantics (stateless)
// =============================================================================

Deno.test("TextEncoder: separate instances produce identical bytes", () => {
  assertResult(`
    let a = new TextEncoder().encode("test");
    let b = new TextEncoder().encode("test");
    let r = a.length === b.length && a[0] === b[0] && a[3] === b[3];
  `, 'r', true);
});

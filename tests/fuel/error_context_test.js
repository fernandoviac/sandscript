/**
 * Tests for rich error context on thrown errors.
 *
 * Run with: deno task test tests/fuel/error_context_test.js
 */

import { assertEquals, assert } from "https://deno.land/std@0.208.0/assert/mod.ts";
import { createSession } from '../../src/fuel/session.js';
import { freshSession } from '../../src/host-owned-session.js';
import { UncaughtScriptError } from '../../src/runtime/errors.js';

function runAndGetError(session, source, slot = 0) {
  session.parse(source);
  try {
    session.run(slot, 10000);
  } catch (e) {
    if (e instanceof UncaughtScriptError) return e.scriptError;
    throw e;
  }
  return session.state(slot).error;
}

// =============================================================================
// DataView RangeError — caught errors have message + properties
// =============================================================================

Deno.test("Error context: DataView getInt8 out of bounds — caught", () => {
  const session = freshSession();
  session.parse(`
    let buf = new ArrayBuffer(4)
    let dv = new DataView(buf)
    let msg = ""
    let off = -1
    let bl = -1
    let es = -1
    try {
      dv.getInt8(10)
    } catch (e) {
      msg = e.message
      off = e.offset
      bl = e.bufferLength
      es = e.elementSize
    }
  `);
  session.run(0, 100000);

  assertEquals(session.get(0, 'msg'), 'Offset is outside the bounds of the DataView');
  assertEquals(session.get(0, 'off'), 10);
  assertEquals(session.get(0, 'bl'), 4);
  assertEquals(session.get(0, 'es'), 1);
});

Deno.test("Error context: integer-tagged properties stringify and key objects", () => {
  // e.offset is stored with the internal integer tag; it must coerce to
  // its decimal form in string concatenation and as a dynamic object key
  // (both go through $value_to_string).
  const session = freshSession();
  session.parse(`
    let buf = new ArrayBuffer(4)
    let dv = new DataView(buf)
    let s = ""
    let v = -1
    try {
      dv.getInt8(10)
    } catch (e) {
      s = "" + e.offset
      let obj = {}
      obj[e.offset] = 99
      v = obj["10"]
    }
  `);
  session.run(0, 100000);

  assertEquals(session.get(0, 's'), '10');
  assertEquals(session.get(0, 'v'), 99);
});

Deno.test("Error context: DataView getInt16 out of bounds — caught", () => {
  const session = freshSession();
  session.parse(`
    let buf = new ArrayBuffer(4)
    let dv = new DataView(buf)
    let es = -1
    try {
      dv.getInt16(3)
    } catch (e) {
      es = e.elementSize
    }
  `);
  session.run(0, 100000);

  assertEquals(session.get(0, 'es'), 2);
});

Deno.test("Error context: DataView getFloat64 out of bounds — caught", () => {
  const session = freshSession();
  session.parse(`
    let buf = new ArrayBuffer(4)
    let dv = new DataView(buf)
    let es = -1
    try {
      dv.getFloat64(0)
    } catch (e) {
      es = e.elementSize
    }
  `);
  session.run(0, 100000);

  assertEquals(session.get(0, 'es'), 8);
});

Deno.test("Error context: DataView setInt32 out of bounds — caught", () => {
  const session = freshSession();
  session.parse(`
    let buf = new ArrayBuffer(4)
    let dv = new DataView(buf)
    let off = -1
    let es = -1
    try {
      dv.setInt32(2, 42)
    } catch (e) {
      off = e.offset
      es = e.elementSize
    }
  `);
  session.run(0, 100000);

  assertEquals(session.get(0, 'off'), 2);
  assertEquals(session.get(0, 'es'), 4);
});

// =============================================================================
// DataView RangeError — uncaught errors have detailed message
// =============================================================================

Deno.test("Error context: DataView out of bounds — uncaught has detailed message", () => {
  const session = freshSession();
  const error = runAndGetError(session, `
    let buf = new ArrayBuffer(4)
    let dv = new DataView(buf)
    dv.getInt16(5)
  `);

  assertEquals(error.type, 'RangeError');
  assert(error.message.includes('Offset 5'));
  assert(error.message.includes('2-byte'));
  assert(error.message.includes('buffer length 4'));
});

// =============================================================================
// TypeError — caught errors have message + type property
// =============================================================================

Deno.test("Error context: not a function — caught", () => {
  const session = freshSession();
  session.parse(`
    let msg = ""
    let t = -1
    try {
      let x = 42
      x()
    } catch (e) {
      msg = e.message
      t = e.type
    }
  `);
  session.run(0, 100000);

  assertEquals(session.get(0, 'msg'), 'Not a function');
  assert(typeof session.get(0, 't') === 'number');
});

Deno.test("Error context: property of null — caught", () => {
  const session = freshSession();
  session.parse(`
    let msg = ""
    try {
      let x = null
      x.foo
    } catch (e) {
      msg = e.message
    }
  `);
  session.run(0, 100000);

  assertEquals(session.get(0, 'msg'), 'Cannot read property of null');
});

Deno.test("Error context: property of undefined — caught", () => {
  const session = freshSession();
  session.parse(`
    let msg = ""
    try {
      let x = undefined
      x.foo
    } catch (e) {
      msg = e.message
    }
  `);
  session.run(0, 100000);

  assertEquals(session.get(0, 'msg'), 'Cannot read property of undefined');
});

Deno.test("Error context: not a function — uncaught has type info", () => {
  const session = freshSession();
  const error = runAndGetError(session, `
    let x = 42
    x()
  `);

  assertEquals(error.type, 'TypeError');
  assert(error.message.includes('Not a function'));
  assert(error.message.includes('received'));
});

// =============================================================================
// ReferenceError — caught errors have message + name property
// =============================================================================

Deno.test("Error context: undefined variable — caught has message", () => {
  const session = freshSession();
  session.parse(`
    let msg = ""
    let id = ""
    try {
      undeclaredVar
    } catch (e) {
      msg = e.message
      id = e.identifier
    }
  `);
  session.run(0, 100000);

  assertEquals(session.get(0, 'msg'), 'Not defined');
  assertEquals(session.get(0, 'id'), 'undeclaredVar');
});

Deno.test("Error context: undefined variable — uncaught has name in message", () => {
  const session = freshSession();
  const error = runAndGetError(session, 'undeclaredVar');

  assertEquals(error.type, 'ReferenceError');
  assert(error.message.includes('undeclaredVar'));
  assert(error.message.includes('not defined'));
});

// =============================================================================
// JSON errors — new error codes
// =============================================================================

Deno.test("Error context: JSON.parse syntax error", () => {
  const session = freshSession();
  const error = runAndGetError(session, 'let x = JSON.parse("not json")');

  assertEquals(error.type, 'SyntaxError');
  assertEquals(error.codeName, 'JSON_PARSE');
});

Deno.test("Error context: JSON.stringify circular reference", () => {
  const session = freshSession();
  const error = runAndGetError(session, 'let obj = {}; obj.self = obj; JSON.stringify(obj)');

  assertEquals(error.type, 'TypeError');
  assertEquals(error.codeName, 'JSON_STRINGIFY');
  assert(error.message.includes('circular'));
});

// =============================================================================
// User-thrown errors still work
// =============================================================================

Deno.test("Error context: user throw with message is preserved", () => {
  const session = freshSession();
  session.parse(`
    let msg = ""
    try {
      throw new Error("custom message")
    } catch (e) {
      msg = e.message
    }
  `);
  session.run(0, 100000);

  assertEquals(session.get(0, 'msg'), 'custom message');
});

// =============================================================================
// BigInt mixed types
// =============================================================================

Deno.test("Error context: BigInt mixed types — caught", () => {
  // Integer literals are now Rational, and BigInt + Rational is allowed (returns
  // Rational). Use a Float literal to provoke the actual BigInt-mixing error.
  const session = freshSession();
  session.parse(`
    let msg = ""
    try {
      let x = 1n + 1.5
    } catch (e) {
      msg = e.message
    }
  `);
  session.run(0, 100000);

  assertEquals(session.get(0, 'msg'), 'Cannot mix BigInt and other types');
});

// Note: frozen object test omitted — Object.freeze is not yet implemented

/**
 * Comprehensive BigInt tests.
 */

import { assertEquals, assertThrows } from "https://deno.land/std@0.208.0/assert/mod.ts";
import { freshSession, restoreSession, snapshotSession } from '../../src/host-owned-session.js';
import { parseAndSetup } from './test-helpers.js';
import { UncaughtScriptError } from '../../src/runtime/errors.js';

function run(source) {
  const session = freshSession();
  parseAndSetup(session, source);
  try {
    session.run(0, 100000);
    return { session, error: null };
  } catch (e) {
    if (e instanceof UncaughtScriptError) return { session, error: e.scriptError };
    throw e;
  }
}

function evalBigInt(expr) {
  const { session, error } = run(`let r = ${expr};`);
  if (error) throw new Error(`Error evaluating '${expr}': ${error.message}`);
  return session.get(0, 'r');
}

function evalValue(source, varName) {
  const { session, error } = run(source);
  if (error) throw new Error(`Error: ${error.message}`);
  return session.get(0, varName);
}

// ===========================================================================
// Literals
// ===========================================================================

Deno.test("BigInt: decimal literal", () => {
  assertEquals(evalBigInt('123n'), 123n);
});

Deno.test("BigInt: zero literal", () => {
  assertEquals(evalBigInt('0n'), 0n);
});

Deno.test("BigInt: hex literal", () => {
  assertEquals(evalBigInt('0xFFn'), 255n);
});

Deno.test("BigInt: large literal beyond MAX_SAFE_INTEGER", () => {
  assertEquals(evalBigInt('9007199254740993n'), 9007199254740993n);
});

Deno.test("BigInt: very large literal", () => {
  assertEquals(evalBigInt('0xFFFFFFFFFFFFFFFFn'), 0xFFFFFFFFFFFFFFFFn);
});

// ===========================================================================
// typeof
// ===========================================================================

Deno.test("BigInt: typeof returns 'bigint'", () => {
  assertEquals(evalBigInt('typeof 42n'), "bigint");
});

Deno.test("BigInt: typeof on variable", () => {
  assertEquals(evalValue('let x = 123n; let t = typeof x;', 't'), "bigint");
});

// ===========================================================================
// Truthiness
// ===========================================================================

Deno.test("BigInt: 0n is falsy", () => {
  assertEquals(evalValue('let r = 0n ? "truthy" : "falsy";', 'r'), "falsy");
});

Deno.test("BigInt: 1n is truthy", () => {
  assertEquals(evalValue('let r = 1n ? "truthy" : "falsy";', 'r'), "truthy");
});

Deno.test("BigInt: -1n is truthy", () => {
  assertEquals(evalValue('let r = (-1n) ? "truthy" : "falsy";', 'r'), "truthy");
});

// ===========================================================================
// Addition
// ===========================================================================

Deno.test("BigInt: add positive", () => {
  assertEquals(evalBigInt('100n + 200n'), 300n);
});

Deno.test("BigInt: add with carry", () => {
  assertEquals(evalBigInt('0xFFFFFFFFn + 1n'), 0x100000000n);
});

Deno.test("BigInt: add negative", () => {
  assertEquals(evalBigInt('-5n + 3n'), -2n);
});

Deno.test("BigInt: add two negatives", () => {
  assertEquals(evalBigInt('-5n + (-3n)'), -8n);
});

Deno.test("BigInt: add to zero", () => {
  assertEquals(evalBigInt('0n + 42n'), 42n);
});

// ===========================================================================
// Subtraction
// ===========================================================================

Deno.test("BigInt: subtract positive", () => {
  assertEquals(evalBigInt('200n - 100n'), 100n);
});

Deno.test("BigInt: subtract to negative", () => {
  assertEquals(evalBigInt('100n - 200n'), -100n);
});

Deno.test("BigInt: subtract equal values", () => {
  assertEquals(evalBigInt('42n - 42n'), 0n);
});

// ===========================================================================
// Multiplication
// ===========================================================================

Deno.test("BigInt: multiply", () => {
  assertEquals(evalBigInt('10n * 10n'), 100n);
});

Deno.test("BigInt: multiply by zero", () => {
  assertEquals(evalBigInt('0n * 100n'), 0n);
});

Deno.test("BigInt: multiply negative", () => {
  assertEquals(evalBigInt('-2n * 3n'), -6n);
});

Deno.test("BigInt: multiply two negatives", () => {
  assertEquals(evalBigInt('-2n * (-3n)'), 6n);
});

Deno.test("BigInt: multiply large numbers", () => {
  assertEquals(evalBigInt('0xFFFFFFFFn * 0xFFFFFFFFn'), 0xFFFFFFFE00000001n);
});

// ===========================================================================
// Division
// ===========================================================================

Deno.test("BigInt: divide truncates toward zero", () => {
  assertEquals(evalBigInt('7n / 2n'), 3n);
});

Deno.test("BigInt: divide exact", () => {
  assertEquals(evalBigInt('100n / 10n'), 10n);
});

Deno.test("BigInt: divide negative truncates toward zero", () => {
  assertEquals(evalBigInt('-7n / 2n'), -3n);
});

Deno.test("BigInt: divide by negative", () => {
  assertEquals(evalBigInt('7n / (-2n)'), -3n);
});

Deno.test("BigInt: divide zero", () => {
  assertEquals(evalBigInt('0n / 5n'), 0n);
});

Deno.test("BigInt: division by zero throws error", () => {
  const { error } = run('let r = 1n / 0n;');
  assertEquals(error !== null, true);
});

Deno.test("BigInt: multi-limb division", () => {
  assertEquals(evalBigInt('0xFFFFFFFFFFFFFFFFn / 0xFFFFFFFFn'), 0x100000001n);
});

// ===========================================================================
// Modulo
// ===========================================================================

Deno.test("BigInt: modulo", () => {
  assertEquals(evalBigInt('7n % 3n'), 1n);
});

Deno.test("BigInt: modulo negative dividend", () => {
  assertEquals(evalBigInt('-7n % 3n'), -1n);
});

Deno.test("BigInt: modulo by zero throws error", () => {
  const { error } = run('let r = 1n % 0n;');
  assertEquals(error !== null, true);
});

// ===========================================================================
// Exponentiation
// ===========================================================================

Deno.test("BigInt: power of zero", () => {
  assertEquals(evalBigInt('2n ** 0n'), 1n);
});

Deno.test("BigInt: power", () => {
  assertEquals(evalBigInt('2n ** 10n'), 1024n);
});

Deno.test("BigInt: large power", () => {
  assertEquals(evalBigInt('2n ** 64n'), 18446744073709551616n);
});

Deno.test("BigInt: negative base odd exponent", () => {
  assertEquals(evalBigInt('(-2n) ** 3n'), -8n);
});

Deno.test("BigInt: negative base even exponent", () => {
  assertEquals(evalBigInt('(-2n) ** 4n'), 16n);
});

Deno.test("BigInt: zero to zero", () => {
  assertEquals(evalBigInt('0n ** 0n'), 1n);
});

// ===========================================================================
// Unary negation
// ===========================================================================

Deno.test("BigInt: unary negation", () => {
  assertEquals(evalBigInt('-42n'), -42n);
});

Deno.test("BigInt: negate zero", () => {
  assertEquals(evalBigInt('-0n'), 0n);
});

Deno.test("BigInt: double negation", () => {
  assertEquals(evalValue('let x = 42n; let r = -(-x);', 'r'), 42n);
});

// ===========================================================================
// Strict Equality (===)
// ===========================================================================

Deno.test("BigInt: strict equal same value", () => {
  assertEquals(evalBigInt('123n === 123n'), true);
});

Deno.test("BigInt: strict equal different value", () => {
  assertEquals(evalBigInt('123n === 456n'), false);
});

Deno.test("BigInt: strict equal zero", () => {
  assertEquals(evalBigInt('0n === 0n'), true);
});

Deno.test("BigInt: strict not equal different types", () => {
  assertEquals(evalBigInt('123n === 123'), false);
});

// ===========================================================================
// Comparison
// ===========================================================================

Deno.test("BigInt: less than", () => {
  assertEquals(evalBigInt('1n < 2n'), true);
  assertEquals(evalBigInt('2n < 1n'), false);
  assertEquals(evalBigInt('1n < 1n'), false);
});

Deno.test("BigInt: greater than", () => {
  assertEquals(evalBigInt('2n > 1n'), true);
  assertEquals(evalBigInt('1n > 2n'), false);
});

Deno.test("BigInt: less than or equal", () => {
  assertEquals(evalBigInt('1n <= 2n'), true);
  assertEquals(evalBigInt('1n <= 1n'), true);
  assertEquals(evalBigInt('2n <= 1n'), false);
});

Deno.test("BigInt: greater than or equal", () => {
  assertEquals(evalBigInt('2n >= 1n'), true);
  assertEquals(evalBigInt('1n >= 1n'), true);
  assertEquals(evalBigInt('1n >= 2n'), false);
});

Deno.test("BigInt: compare negative numbers", () => {
  assertEquals(evalBigInt('-1n < 0n'), true);
  assertEquals(evalBigInt('-1n > -2n'), true);
  assertEquals(evalBigInt('-1n < 1n'), true);
});

// ===========================================================================
// Type errors on mixed operations
// ===========================================================================

Deno.test("BigInt: add with Float throws TypeError", () => {
  // Integer literals are now Rational (exact), not Float. BigInt + Rational
  // is allowed (returns Rational), but BigInt + Float still throws.
  const { error } = run('let r = 1n + 1.5;');
  assertEquals(error.type, 'TypeError');
});

Deno.test("BigInt: Float add with BigInt throws TypeError", () => {
  const { error } = run('let r = 1.5 + 1n;');
  assertEquals(error.type, 'TypeError');
});

Deno.test("BigInt: add with Rational (integer literal) returns Rational", () => {
  // Integer literals are Rational; BigInt + Rational is well-defined.
  // session.get unwraps integer-Rationals in i32 range to plain Numbers.
  const { session, error } = run('let r = 1n + 1;');
  if (error) throw new Error(error.message);
  assertEquals(session.get(0, 'r'), 2);
  // The underlying type stays Rational — verify via getExact.
  assertEquals(session.getExact(0, 'r'), { kind: 'rational', numerator: 2n, denominator: 1n });
});

// ===========================================================================
// Marshalling roundtrip
// ===========================================================================

Deno.test("BigInt: marshal/unmarshal roundtrip via external", () => {
  const session = freshSession();
  const airlock = session.airlock;
  const id = airlock.register({});
  airlock.createRootGrant().add(id);
  let received = null;
  airlock.setHandler(id, 'send', ({ args }) => { received = args[0]; });
  airlock.setHandler(id, 'get', () => 9007199254740993n);
  airlock.declare('Api', id);

  parseAndSetup(session, `
    Api.send(42n);
    let r = Api.get();
  `);
  session.run(0, 10000);

  assertEquals(received, 42n);
  assertEquals(session.get(0, 'r'), 9007199254740993n);
});

// ===========================================================================
// GC
// ===========================================================================

Deno.test("BigInt: survives GC", () => {
  const session = freshSession();
  parseAndSetup(session, 'let x = 0xFFFFFFFFFFFFFFFFn;');
  session.run(0, 1000);
  session.gc();
  assertEquals(session.get(0, 'x'), 0xFFFFFFFFFFFFFFFFn);
});

Deno.test("BigInt: arithmetic result survives GC", () => {
  const session = freshSession();
  parseAndSetup(session, 'let x = 2n ** 64n;');
  session.run(0, 100000);
  session.gc();
  assertEquals(session.get(0, 'x'), 18446744073709551616n);
});

Deno.test("BigInt: boxed primitive survives GC", () => {
  const session = freshSession();
  parseAndSetup(session, 'let boxed = Object(0xFFFFFFFFFFFFFFFFn);');
  session.run(0, 1000);
  session.gc();
  session.parse('let result = boxed.valueOf();');
  session.run(0, 1000);
  assertEquals(session.get(0, 'result'), 0xFFFFFFFFFFFFFFFFn);
});

Deno.test("BigInt values and wrappers survive snapshot restore", () => {
  const session = freshSession();
  parseAndSetup(session, `
    let primitive = -123456789012345678901234567890n;
    let boxed = Object(primitive);
  `);
  session.run(0, 1000);
  const snapshot = snapshotSession(session);
  const restored = restoreSession(snapshot.vatBytes, snapshot.membraneBytes);
  restored.parse(`
    let primitiveResult = primitive ^ -1n;
    let boxedResult = boxed.valueOf();
  `);
  restored.run(0, 1000);
  assertEquals(restored.get(0, 'primitiveResult'),
    (-123456789012345678901234567890n) ^ -1n);
  assertEquals(restored.get(0, 'boxedResult'),
    -123456789012345678901234567890n);
});

// ===========================================================================
// Bitwise NOT
// ===========================================================================

Deno.test("BigInt: bitwise NOT", () => {
  assertEquals(evalBigInt('~0n'), -1n);
  assertEquals(evalBigInt('~(-1n)'), 0n);
  assertEquals(evalBigInt('~1n'), -2n);
  assertEquals(evalBigInt('~(-2n)'), 1n);
});

// ===========================================================================
// Bitwise AND/OR/XOR (positive operands)
// ===========================================================================

Deno.test("BigInt: bitwise AND", () => {
  assertEquals(evalBigInt('0xFFn & 0x0Fn'), 0x0Fn);
  assertEquals(evalBigInt('0xFFFFn & 0xFF00n'), 0xFF00n);
});

Deno.test("BigInt: bitwise OR", () => {
  assertEquals(evalBigInt('0xF0n | 0x0Fn'), 0xFFn);
});

Deno.test("BigInt: bitwise XOR", () => {
  assertEquals(evalBigInt('0xFFn ^ 0xAAn'), 0x55n);
});

// ===========================================================================
// Left/Right Shift
// ===========================================================================

Deno.test("BigInt: left shift", () => {
  assertEquals(evalBigInt('1n << 0n'), 1n);
  assertEquals(evalBigInt('1n << 1n'), 2n);
  assertEquals(evalBigInt('1n << 32n'), 4294967296n);
  assertEquals(evalBigInt('1n << 64n'), 18446744073709551616n);
  assertEquals(evalBigInt('0xFFn << 8n'), 0xFF00n);
});

Deno.test("BigInt: right shift", () => {
  assertEquals(evalBigInt('1024n >> 2n'), 256n);
  assertEquals(evalBigInt('0xFFn >> 4n'), 0x0Fn);
  assertEquals(evalBigInt('1n >> 1n'), 0n);
});

// ===========================================================================
// BigInt() constructor
// ===========================================================================

Deno.test("BigInt: BigInt(number)", () => {
  assertEquals(evalBigInt('BigInt(42)'), 42n);
  assertEquals(evalBigInt('BigInt(0)'), 0n);
  assertEquals(evalBigInt('BigInt(-5)'), -5n);
});

Deno.test("BigInt: BigInt(bigint) is identity", () => {
  assertEquals(evalBigInt('BigInt(42n)'), 42n);
});

Deno.test("BigInt: BigInt(boolean)", () => {
  assertEquals(evalBigInt('BigInt(true)'), 1n);
  assertEquals(evalBigInt('BigInt(false)'), 0n);
});

Deno.test("BigInt: new BigInt() throws TypeError", () => {
  const { error } = run('let r = new BigInt(42);');
  assertEquals(error !== null, true);
  assertEquals(error.type, 'TypeError');
});

// ===========================================================================
// Subtracting zero preserves sign (found 2026-07-19 via Ring 3b's
// complex_pow fold: $bigint_sub's zero-RHS shortcut returned a bare
// MAGNITUDE copy, so (-5n) - 0n evaluated to 5n and i**2 to +1)
// ===========================================================================

Deno.test("BigInt: subtracting zero preserves sign", () => {
  assertEquals(evalBigInt('-5n - 0n'), -5n);
  assertEquals(evalBigInt('(0n - 5n) - 0n'), -5n);
  assertEquals(evalBigInt('0n - 0n'), 0n);
  assertEquals(evalBigInt('5n - 0n'), 5n);
  assertEquals(evalBigInt('(0n - 12345678901234567890n) - 0n'), -12345678901234567890n);
});

// ===========================================================================
// ECMAScript BigInt completion
// ===========================================================================

Deno.test("BigInt: string conversion accepts canonical integer forms", () => {
  assertEquals(evalBigInt('BigInt("")'), 0n);
  assertEquals(evalBigInt('BigInt("  \\n\\t  ")'), 0n);
  assertEquals(evalBigInt('BigInt("  -123  ")'), -123n);
  assertEquals(evalBigInt('BigInt("+123")'), 123n);
  assertEquals(evalBigInt(`BigInt(${JSON.stringify("\u00A0123\u00A0")})`), 123n);
  assertEquals(evalBigInt('BigInt("0xFF")'), 255n);
  assertEquals(evalBigInt('BigInt("0Xff")'), 255n);
  assertEquals(evalBigInt('BigInt("0o17")'), 15n);
  assertEquals(evalBigInt('BigInt("0O17")'), 15n);
  assertEquals(evalBigInt('BigInt("0b101")'), 5n);
  assertEquals(evalBigInt('BigInt("0B101")'), 5n);
  assertEquals(evalBigInt('BigInt("90071992547409931234567890")'),
    90071992547409931234567890n);
});

Deno.test("BigInt: invalid string conversion throws SyntaxError", () => {
  for (const text of [
    "+", "-", "1.0", "1e3", "12x", "0x", "0b2", "+0xFF", "-0b1",
    "Infinity",
  ]) {
    const { error } = run(`let value = BigInt("${text}");`);
    assertEquals(error.type, "SyntaxError", text);
    assertEquals(error.name, "SyntaxError", text);
  }
});

Deno.test("BigInt: asIntN and asUintN wrap at fixed widths", () => {
  assertEquals(evalBigInt("BigInt.asIntN(8, 255n)"), -1n);
  assertEquals(evalBigInt("BigInt.asIntN(8, 128n)"), -128n);
  assertEquals(evalBigInt("BigInt.asIntN(8, -129n)"), 127n);
  assertEquals(evalBigInt("BigInt.asUintN(8, 256n)"), 0n);
  assertEquals(evalBigInt("BigInt.asUintN(8, -1n)"), 255n);
  assertEquals(evalBigInt("BigInt.asIntN(0, 99n)"), 0n);
  assertEquals(evalBigInt("BigInt.asUintN(0, -99n)"), 0n);
  assertEquals(evalBigInt("BigInt.asUintN(65, (1n << 70n) + 3n)"), 3n);
});

Deno.test("BigInt: fixed-width methods validate width and value", () => {
  assertEquals(run("let value = BigInt.asIntN(-1, 0n);").error.type, "RangeError");
  assertEquals(
    run("let value = BigInt.asUintN(9007199254740992, 0n);").error.type,
    "RangeError",
  );
  assertEquals(run("let value = BigInt.asIntN(8n, 0n);").error.type, "TypeError");
  assertEquals(run("let value = BigInt.asUintN(8, 1);").error.type, "TypeError");
});

Deno.test("BigInt: signed bitwise operations use infinite two's complement", () => {
  for (const [expression, expected] of [
    ["5n & 3n", 1n],
    ["-5n & 3n", 3n],
    ["5n & -3n", 5n],
    ["-5n & -3n", -7n],
    ["5n | 3n", 7n],
    ["-5n | 3n", -5n],
    ["5n | -3n", -3n],
    ["-5n | -3n", -1n],
    ["5n ^ 3n", 6n],
    ["-5n ^ 3n", -8n],
    ["5n ^ -3n", -8n],
    ["-5n ^ -3n", 6n],
    ["0n & -1n", 0n],
    ["0n | -1n", -1n],
    ["0n ^ -1n", -1n],
    ["4294967296n & -1n", 4294967296n],
    ["-4294967297n ^ 4294967296n", -1n],
  ]) {
    assertEquals(evalBigInt(expression), expected, expression);
  }
});

Deno.test("BigInt: prototype formatting supports every radix", () => {
  assertEquals(evalBigInt("(255n).toString()"), "255");
  assertEquals(evalBigInt("(255n).toString(16)"), "ff");
  assertEquals(evalBigInt("(-255n).toString(16)"), "-ff");
  assertEquals(evalBigInt("(35n).toString(36)"), "z");
  assertEquals(evalBigInt("(10n).toString(2)"), "1010");
  assertEquals(evalBigInt("(255n).toLocaleString()"), "255");
  assertEquals(run("let value = (1n).toString(1);").error.type, "RangeError");
  assertEquals(run("let value = (1n).toString(37);").error.type, "RangeError");
});

Deno.test("BigInt: primitive and boxed prototype methods", () => {
  const { session, error } = run(`
    let boxed = Object(255n);
    let primitiveKind = typeof boxed;
    let primitive = boxed.valueOf();
    let text = boxed.toString(16);
    let prototypeMatches = Object.getPrototypeOf(boxed) === BigInt.prototype;
    let tag = Object.prototype.toString.call(boxed);
  `);
  if (error) throw new Error(error.message);
  assertEquals(session.get(0, "primitiveKind"), "object");
  assertEquals(session.get(0, "primitive"), 255n);
  assertEquals(session.get(0, "text"), "ff");
  assertEquals(session.get(0, "prototypeMatches"), true);
  assertEquals(session.get(0, "tag"), "[object BigInt]");
});

Deno.test("BigInt: constructor and prototype descriptors", () => {
  const { session, error } = run(`
    let prototypeDescriptor = Object.getOwnPropertyDescriptor(BigInt, "prototype");
    let constructorDescriptor = Object.getOwnPropertyDescriptor(
      BigInt.prototype, "constructor");
    let toStringDescriptor = Object.getOwnPropertyDescriptor(
      BigInt.prototype, "toString");
    let prototypeFlags = !prototypeDescriptor.writable &&
      !prototypeDescriptor.enumerable && !prototypeDescriptor.configurable;
    let constructorFlags = constructorDescriptor.writable &&
      !constructorDescriptor.enumerable && constructorDescriptor.configurable;
    let methodFlags = toStringDescriptor.writable &&
      !toStringDescriptor.enumerable && toStringDescriptor.configurable;
  `);
  if (error) throw new Error(error.message);
  assertEquals(session.get(0, "prototypeFlags"), true);
  assertEquals(session.get(0, "constructorFlags"), true);
  assertEquals(session.get(0, "methodFlags"), true);
});

Deno.test("BigInt: object coercion follows ToPrimitive order and binding", () => {
  const { session, error } = run(`
    let order = "";
    let object = {
      valueOf: function () {
        order = order + "v";
        return {};
      },
      toString: function () {
        order = order + "s";
        return "41";
      }
    };
    let first = BigInt(object);
    let primitiveObject = {
      [Symbol.toPrimitive]: function (hint) {
        order = order + hint;
        return this === primitiveObject ? "42" : "0";
      },
      valueOf: function () {
        order = order + "x";
        return 0n;
      }
    };
    let second = BigInt(primitiveObject);
  `);
  if (error) throw new Error(error.message);
  assertEquals(session.get(0, "first"), 41n);
  assertEquals(session.get(0, "second"), 42n);
  assertEquals(session.get(0, "order"), "vsnumber");
});

Deno.test("BigInt: object coercion applies to width values and radix", () => {
  const { session, error } = run(`
    let bits = { valueOf: function () { return 8; } };
    let value = { valueOf: function () { return 255n; } };
    let radix = { valueOf: function () { return 16; } };
    let signed = BigInt.asIntN(bits, value);
    let text = (255n).toString(radix);
  `);
  if (error) throw new Error(error.message);
  assertEquals(session.get(0, "signed"), -1n);
  assertEquals(session.get(0, "text"), "ff");
});

Deno.test("BigInt: object coercion rejects non-primitive results", () => {
  const { error } = run(`
    let object = {
      valueOf: function () { return {}; },
      toString: function () { return {}; }
    };
    let value = BigInt(object);
  `);
  assertEquals(error.type, "TypeError");
});

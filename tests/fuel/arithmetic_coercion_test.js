import { assertEquals, assert, assertThrows } from "https://deno.land/std@0.208.0/assert/mod.ts";
import { parseAndSetup } from './test-helpers.js';
import { freshSession } from '../../src/host-owned-session.js';
import { UncaughtScriptError } from '../../src/runtime/errors.js';

function run(source) {
  const session = freshSession();
  parseAndSetup(session, source);
  session.run(0, 1000000);
  return session;
}

function expectThrow(source) {
  const session = freshSession();
  parseAndSetup(session, source);
  assertThrows(() => session.run(0, 1000000), UncaughtScriptError);
}

function get(source, name) {
  return run(source).get(0, name);
}

function expectNaN(source, name) {
  const value = get(source, name);
  assert(Number.isNaN(value), `expected NaN, got ${value}`);
}

// =============================================================================
// MUL — string coercion
// =============================================================================

Deno.test('MUL: "2" * 3 → 6', () => {
  assertEquals(get('let r = "2" * 3', 'r'), 6);
});

Deno.test('MUL: 4 * "5" → 20', () => {
  assertEquals(get('let r = 4 * "5"', 'r'), 20);
});

Deno.test('MUL: "3" * "7" → 21', () => {
  assertEquals(get('let r = "3" * "7"', 'r'), 21);
});

Deno.test('MUL: "1.5" * 2 → 3', () => {
  assertEquals(get('let r = "1.5" * 2', 'r'), 3);
});

Deno.test('MUL: "abc" * 2 → NaN', () => {
  expectNaN('let r = "abc" * 2', 'r');
});

Deno.test('MUL: "" * 5 → 0', () => {
  assertEquals(get('let r = "" * 5', 'r'), 0);
});

// =============================================================================
// SUB — string coercion
// =============================================================================

Deno.test('SUB: "10" - 3 → 7', () => {
  assertEquals(get('let r = "10" - 3', 'r'), 7);
});

Deno.test('SUB: 10 - "3" → 7', () => {
  assertEquals(get('let r = 10 - "3"', 'r'), 7);
});

Deno.test('SUB: "10" - "3" → 7', () => {
  assertEquals(get('let r = "10" - "3"', 'r'), 7);
});

Deno.test('SUB: "abc" - 1 → NaN', () => {
  expectNaN('let r = "abc" - 1', 'r');
});

// =============================================================================
// DIV — string coercion
// =============================================================================

Deno.test('DIV: "10" / 2 → 5', () => {
  assertEquals(get('let r = "10" / 2', 'r'), 5);
});

Deno.test('DIV: 10 / "2" → 5', () => {
  assertEquals(get('let r = 10 / "2"', 'r'), 5);
});

Deno.test('DIV: "15" / "3" → 5', () => {
  assertEquals(get('let r = "15" / "3"', 'r'), 5);
});

Deno.test('DIV: "abc" / 2 → NaN', () => {
  expectNaN('let r = "abc" / 2', 'r');
});

// =============================================================================
// MOD — string coercion
// =============================================================================

Deno.test('MOD: "10" % 3 → 1', () => {
  assertEquals(get('let r = "10" % 3', 'r'), 1);
});

Deno.test('MOD: 10 % "3" → 1', () => {
  assertEquals(get('let r = 10 % "3"', 'r'), 1);
});

Deno.test('MOD: "abc" % 3 → NaN', () => {
  expectNaN('let r = "abc" % 3', 'r');
});

// =============================================================================
// POW — string coercion
// =============================================================================

Deno.test('POW: "2" ** 3 → 8', () => {
  assertEquals(get('let r = "2" ** 3', 'r'), 8);
});

Deno.test('POW: 2 ** "3" → 8', () => {
  assertEquals(get('let r = 2 ** "3"', 'r'), 8);
});

Deno.test('POW: "abc" ** 2 → NaN', () => {
  expectNaN('let r = "abc" ** 2', 'r');
});

// =============================================================================
// SHL / SHR / USHR — string coercion
// =============================================================================

Deno.test('SHL: "2" << 1 → 4', () => {
  assertEquals(get('let r = "2" << 1', 'r'), 4);
});

Deno.test('SHL: 2 << "1" → 4', () => {
  assertEquals(get('let r = 2 << "1"', 'r'), 4);
});

Deno.test('SHR: "8" >> 1 → 4', () => {
  assertEquals(get('let r = "8" >> 1', 'r'), 4);
});

Deno.test('SHR: 8 >> "1" → 4', () => {
  assertEquals(get('let r = 8 >> "1"', 'r'), 4);
});

Deno.test('USHR: "8" >>> 1 → 4', () => {
  assertEquals(get('let r = "8" >>> 1', 'r'), 4);
});

Deno.test('USHR: 8 >>> "1" → 4', () => {
  assertEquals(get('let r = 8 >>> "1"', 'r'), 4);
});

// =============================================================================
// Unary plus — string parsing (currently broken: always returns NaN)
// =============================================================================

Deno.test('UPLUS: +"42" → 42', () => {
  assertEquals(get('let r = +"42"', 'r'), 42);
});

Deno.test('UPLUS: +"3.14" → 3.14', () => {
  assertEquals(get('let r = +"3.14"', 'r'), 3.14);
});

Deno.test('UPLUS: +"" → 0', () => {
  assertEquals(get('let r = +""', 'r'), 0);
});

Deno.test('UPLUS: +" 7 " → 7 (whitespace trimmed)', () => {
  assertEquals(get('let r = +" 7 "', 'r'), 7);
});

Deno.test('UPLUS: +"abc" → NaN', () => {
  expectNaN('let r = +"abc"', 'r');
});

// =============================================================================
// Boolean coercion in arithmetic
// =============================================================================

Deno.test('MUL: true * 5 → 5', () => {
  assertEquals(get('let r = true * 5', 'r'), 5);
});

Deno.test('MUL: false * 5 → 0', () => {
  assertEquals(get('let r = false * 5', 'r'), 0);
});

Deno.test('SUB: 10 - true → 9', () => {
  assertEquals(get('let r = 10 - true', 'r'), 9);
});

Deno.test('SUB: 10 - false → 10', () => {
  assertEquals(get('let r = 10 - false', 'r'), 10);
});

Deno.test('DIV: true / 2 → 0.5', () => {
  assertEquals(get('let r = true / 2', 'r'), 0.5);
});

// =============================================================================
// null coercion in arithmetic (null → 0)
// =============================================================================

Deno.test('MUL: null * 5 → 0', () => {
  assertEquals(get('let r = null * 5', 'r'), 0);
});

Deno.test('SUB: 10 - null → 10', () => {
  assertEquals(get('let r = 10 - null', 'r'), 10);
});

// =============================================================================
// undefined coercion in arithmetic (undefined → NaN)
// =============================================================================

Deno.test('MUL: undefined * 5 → NaN', () => {
  expectNaN('let r = undefined * 5', 'r');
});

Deno.test('SUB: 10 - undefined → NaN', () => {
  expectNaN('let r = 10 - undefined', 'r');
});

// =============================================================================
// BAND / BOR / BXOR — string coercion
// =============================================================================

Deno.test('BAND: "7" & 3 → 3', () => {
  assertEquals(get('let r = "7" & 3', 'r'), 3);
});

Deno.test('BOR: "5" | 2 → 7', () => {
  assertEquals(get('let r = "5" | 2', 'r'), 7);
});

Deno.test('BXOR: "7" ^ 3 → 4', () => {
  assertEquals(get('let r = "7" ^ 3', 'r'), 4);
});

// =============================================================================
// BNOT — string coercion
// =============================================================================

Deno.test('BNOT: ~"5" → -6', () => {
  assertEquals(get('let r = ~"5"', 'r'), -6);
});

Deno.test('BNOT: ~"0" → -1', () => {
  assertEquals(get('let r = ~"0"', 'r'), -1);
});

// =============================================================================
// Real-world idioms: string → number conversion
// =============================================================================

Deno.test('idiom: stringVar * 1 for number conversion', () => {
  assertEquals(get('let s = "42"; let r = s * 1', 'r'), 42);
});

Deno.test('idiom: stringVar - 0 for number conversion', () => {
  assertEquals(get('let s = "42"; let r = s - 0', 'r'), 42);
});

Deno.test('idiom: stringVar | 0 for integer truncation', () => {
  assertEquals(get('let s = "42"; let r = s | 0', 'r'), 42);
});

// =============================================================================
// NEG (unary minus) — ToNumber coercion (the last operator without it)
// =============================================================================

Deno.test('NEG: -"5" → -5', () => {
  assertEquals(get('let r = -"5"', 'r'), -5);
});

Deno.test('NEG: -"3.5" → -3.5', () => {
  assertEquals(get('let r = -"3.5"', 'r'), -3.5);
});

Deno.test('NEG: -true → -1', () => {
  assertEquals(get('let r = -true', 'r'), -1);
});

Deno.test('NEG: -false → -0', () => {
  assertEquals(get('let r = -false', 'r'), -0);
});

Deno.test('NEG: -null → -0', () => {
  assertEquals(get('let r = -null', 'r'), -0);
});

Deno.test('NEG: -undefined → NaN', () => {
  expectNaN('let x = undefined; let r = -x', 'r');
});

Deno.test('NEG: -"abc" → NaN', () => {
  expectNaN('let r = -"abc"', 'r');
});

Deno.test('NEG: -"" → -0', () => {
  assertEquals(get('let r = -""', 'r'), -0);
});

// =============================================================================
// ToInt32 — bitwise/shift operands must never trap the module.
// Pre-fix, every case here killed the interpreter with an uncaught
// "float unrepresentable in integer range" WASM trap.
// =============================================================================

Deno.test('ToInt32: NaN | 0 → 0', () => {
  assertEquals(get('let r = NaN | 0', 'r'), 0);
});

Deno.test('ToInt32: NaN & 1 → 0', () => {
  assertEquals(get('let r = NaN & 1', 'r'), 0);
});

Deno.test('ToInt32: ~NaN → -1', () => {
  assertEquals(get('let r = ~NaN', 'r'), -1);
});

Deno.test('ToInt32: NaN << 1 → 0', () => {
  assertEquals(get('let r = NaN << 1', 'r'), 0);
});

Deno.test('ToInt32: NaN >> 1 → 0', () => {
  assertEquals(get('let r = NaN >> 1', 'r'), 0);
});

Deno.test('ToInt32: NaN >>> 1 → 0', () => {
  assertEquals(get('let r = NaN >>> 1', 'r'), 0);
});

Deno.test('ToInt32: Infinity << 1 → 0', () => {
  assertEquals(get('let r = Infinity << 1', 'r'), 0);
});

Deno.test('ToInt32: -Infinity | 0 → 0', () => {
  assertEquals(get('let r = -Infinity | 0', 'r'), 0);
});

Deno.test('ToInt32: "abc" << 1 → 0 (NaN operand)', () => {
  assertEquals(get('let r = "abc" << 1', 'r'), 0);
});

Deno.test('ToInt32: 1e10 | 0 wraps modulo 2^32', () => {
  assertEquals(get('let r = 10000000000 | 0', 'r'), 1410065408);
});

Deno.test('ToInt32: 2147483648 | 0 wraps to -2147483648', () => {
  assertEquals(get('let r = 2147483648 | 0', 'r'), -2147483648);
});

Deno.test('ToInt32: 4294967296 << 1 → 0 (multiple of 2^32)', () => {
  assertEquals(get('let r = 4294967296 << 1', 'r'), 0);
});

Deno.test('ToInt32: -1e10 | 0 wraps modulo 2^32', () => {
  assertEquals(get('let r = -10000000000 | 0', 'r'), -1410065408);
});

Deno.test('ToInt32: fractional operand truncates toward zero', () => {
  assertEquals(get('let r = 5.9 | 0', 'r'), 5);
  assertEquals(get('let r = -5.9 | 0', 'r'), -5);
});

// =============================================================================
// Symbol refuses numeric coercion in EVERY arithmetic/bitwise op,
// with the messaged TypeError (not NaN, not a silent 0, not an
// empty-message throw).
// =============================================================================

function expectConvertThrow(expr) {
  const session = run(
    `let msg = "did not throw"
     try { let x = ${expr} } catch (e) { msg = e.message }`);
  assertEquals(session.get(0, 'msg'), 'Cannot convert to a number');
}

Deno.test('Symbol: sym * 2 throws messaged TypeError', () => {
  expectConvertThrow('Symbol("s") * 2');
});

Deno.test('Symbol: 2 * sym throws messaged TypeError', () => {
  expectConvertThrow('2 * Symbol("s")');
});

Deno.test('Symbol: sym - 1 throws messaged TypeError', () => {
  expectConvertThrow('Symbol("s") - 1');
});

Deno.test('Symbol: sym / 2 throws messaged TypeError', () => {
  expectConvertThrow('Symbol("s") / 2');
});

Deno.test('Symbol: sym % 2 throws messaged TypeError', () => {
  expectConvertThrow('Symbol("s") % 2');
});

Deno.test('Symbol: sym ** 2 throws messaged TypeError', () => {
  expectConvertThrow('Symbol("s") ** 2');
});

Deno.test('Symbol: sym << 1 throws messaged TypeError (was silent 0)', () => {
  expectConvertThrow('Symbol("s") << 1');
});

Deno.test('Symbol: sym >> 1 throws messaged TypeError (was silent 0)', () => {
  expectConvertThrow('Symbol("s") >> 1');
});

Deno.test('Symbol: sym >>> 1 throws messaged TypeError (was silent 0)', () => {
  expectConvertThrow('Symbol("s") >>> 1');
});

Deno.test('Symbol: sym | 1 throws messaged TypeError (was silent 0)', () => {
  expectConvertThrow('Symbol("s") | 1');
});

Deno.test('Symbol: sym & 1 throws messaged TypeError (was silent 0)', () => {
  expectConvertThrow('Symbol("s") & 1');
});

Deno.test('Symbol: sym ^ 1 throws messaged TypeError (was silent 0)', () => {
  expectConvertThrow('Symbol("s") ^ 1');
});

Deno.test('Symbol: ~sym throws messaged TypeError (was silent -1)', () => {
  expectConvertThrow('~Symbol("s")');
});

Deno.test('Symbol: -sym throws messaged TypeError (was empty message)', () => {
  expectConvertThrow('-Symbol("s")');
});

Deno.test('Symbol: +sym throws messaged TypeError (was empty message)', () => {
  expectConvertThrow('+Symbol("s")');
});

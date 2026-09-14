/**
 * Trap-audit regression tests: no f64→int conversion reachable from
 * sandboxed code may trap the WASM module. Before the audit, every
 * case in this file killed the interpreter with an uncaught
 * "float unrepresentable in integer range" trap — a sandboxed drone
 * could crash its own interpreter (and any state it held) with a
 * single expression like `[1,2,3].slice(NaN)`.
 *
 * Conversion semantics by class:
 *   - element indexes (arr[i], u8[i], str[i]): non-integral /
 *     negative / huge → the out-of-bounds path (undefined on reads).
 *   - method index/count args (slice, at, fill, splice, …):
 *     saturating truncation; existing per-site clamps and negative
 *     checks then apply (ToIntegerOrInfinity-compatible).
 *   - modular conversions (Math.imul, Math.clz32, fromCharCode,
 *     typed-array stores): ECMA ToInt32/ToUint16/ToUint8 via
 *     $f64_to_int32.
 *   - magnitudes beyond i64 (String(1e300), BigInt(1e300)): exact
 *     conversion via $bigint_from_f64.
 *
 * Run with: deno task test tests/fuel/trap_audit_test.js
 */
import { assertEquals, assert } from "https://deno.land/std@0.208.0/assert/mod.ts";
import { freshSession } from '../../src/host-owned-session.js';
import { parseAndSetup } from './test-helpers.js';

function get(source, name = 'r') {
  const session = freshSession();
  parseAndSetup(session, source);
  const result = session.run(0, 5_000_000);
  assertEquals(result.status, 'done',
    `expected status=done, got ${result.status} (${result.error?.message})`);
  return session.get(0, name);
}

// =============================================================================
// Element indexing — non-integral / out-of-range indexes are absent
// properties, not traps and not element 0.
// =============================================================================

Deno.test('trap-audit: arr[NaN] → undefined', () => {
  assertEquals(get('let a = [1,2,3]; let r = a[NaN]'), undefined);
});

Deno.test('trap-audit: arr[1e10] → undefined', () => {
  assertEquals(get('let a = [1,2,3]; let r = a[10000000000]'), undefined);
});

Deno.test('trap-audit: arr[0.5] → undefined (JS semantics, was arr[0])', () => {
  assertEquals(get('let a = [1,2,3]; let r = a[0.5]'), undefined);
});

Deno.test('trap-audit: u8[NaN] / u8[1e10] → undefined', () => {
  assertEquals(get('let u = new Uint8Array(4); let r = u[NaN]'), undefined);
  assertEquals(get('let u = new Uint8Array(4); let r = u[10000000000]'), undefined);
});

Deno.test('trap-audit: str[NaN] → undefined', () => {
  assertEquals(get('let s = "abc"; let r = s[NaN]'), undefined);
});

Deno.test('trap-audit: arr[NaN] = v throws like arr[-1] = v', () => {
  assertEquals(get(`let a = [1,2,3]
    let r = "no throw"
    try { a[NaN] = 5 } catch (e) { r = "threw" }`), 'threw');
});

// =============================================================================
// Method index/count arguments — saturate, then existing clamps apply.
// =============================================================================

Deno.test('trap-audit: arr.at / slice / fill / splice / flat with NaN and 1e10', () => {
  assertEquals(get('let r = [1,2,3].at(NaN)'), 1);              // ToIntegerOrInfinity(NaN) = 0
  assertEquals(get('let r = [1,2,3].at(10000000000)'), undefined);
  assertEquals(get('let r = [1,2,3].slice(NaN).length'), 3);
  assertEquals(get('let r = [1,2,3].slice(10000000000).length'), 0);
  assertEquals(get('let r = [1,2,3].fill(0, NaN)[0]'), 0);
  assertEquals(get('let r = [1,2,3].fill(0, 10000000000)[0]'), 1);
  assertEquals(get('let a = [1,2,3]; a.splice(NaN, 1); let r = a.length'), 2);
  assertEquals(get('let a = [1,2,3]; a.splice(10000000000); let r = a.length'), 3);
  assertEquals(get('let r = [[1],[2]].flat(NaN).length'), 2);
  assertEquals(get('let r = [1,2,3].copyWithin(NaN, 1)[0]'), 2);
});

Deno.test('trap-audit: string methods with NaN and 1e10 args', () => {
  assertEquals(get('let r = "abc".slice(10000000000)'), '');
  assertEquals(get('let r = "abc".slice(NaN)'), 'abc');
  assertEquals(get('let r = "abc".substring(NaN)'), 'abc');
  assertEquals(get('let r = "abc".charAt(NaN)'), 'a');
  assertEquals(get('let r = "abc".charAt(10000000000)'), '');
  assertEquals(get('let r = "abc".at(10000000000)'), undefined);
  assertEquals(get('let r = "abc".repeat(NaN)'), '');
  assertEquals(get('let r = "abc".padStart(NaN)'), 'abc');
  assertEquals(get('let r = "abc".padEnd(NaN)'), 'abc');
});

// =============================================================================
// Modular conversions — ECMA ToInt32 / ToUint16 family.
// =============================================================================

Deno.test('trap-audit: Math.imul matches JS for huge and NaN operands', () => {
  assertEquals(get('let r = Math.imul(10000000000, 2)'), -1474836480);
  assertEquals(get('let r = Math.imul(NaN, 2)'), 0);
});

Deno.test('trap-audit: Math.clz32 matches JS for huge and NaN operands', () => {
  assertEquals(get('let r = Math.clz32(NaN)'), 32);
  assertEquals(get('let r = Math.clz32(10000000000)'), 1);  // ToUint32(1e10) = 1410065408
});

Deno.test('trap-audit: String.fromCharCode with negative / NaN / huge', () => {
  assertEquals(get('let r = String.fromCharCode(0 - 1).length'), 1);
  assertEquals(get('let r = String.fromCharCode(NaN).length'), 1);
  assertEquals(get('let r = String.fromCharCode(10000000000).length'), 1);
});

Deno.test('trap-audit: String.fromCodePoint invalid → replacement character', () => {
  assertEquals(get('let r = String.fromCodePoint(NaN)'), '�');
  assertEquals(get('let r = String.fromCodePoint(0 - 1)'), '�');
  assertEquals(get('let r = String.fromCodePoint(65.5)'), '�');
  assertEquals(get('let r = String.fromCodePoint(65)'), 'A');
});

Deno.test('trap-audit: typed-array stores of NaN / huge', () => {
  assertEquals(get('let u = new Uint8Array(1); u[0] = NaN; let r = u[0]'), 0);
  assertEquals(get('let u = new Int32Array(1); u[0] = NaN; let r = u[0]'), 0);
  assertEquals(get('let u = new Int32Array(1); u[0] = 10000000000; let r = u[0]'), 2147483647);
});

// =============================================================================
// Magnitudes beyond i64 — exact via bigint_from_f64.
// =============================================================================

Deno.test('trap-audit: String(1e300) prints exact digits, with sign', () => {
  const s = get('let r = "" + 10e299');
  assertEquals(s.length, 301);
  assert(s.startsWith('1000000000000000052'), `unexpected digits: ${s.slice(0, 24)}…`);
  const n = get('let r = "" + (0 - 10e299)');
  assertEquals(n[0], '-');
  assertEquals(n.length, 302);
});

Deno.test('trap-audit: String(2^63) exact (first value past the old i64 path)', () => {
  assertEquals(get('let r = "" + 9223372036854775808'), '9223372036854775808');
});

Deno.test('trap-audit: BigInt(1e300) exact, BigInt(±non-finite) throws', () => {
  assertEquals(get('let r = String(BigInt(10e299)).length'), 301);
  assertEquals(get('let r = String(BigInt(0 - 10e299)).length'), 302);
  assertEquals(get('let r = String(BigInt(42))'), '42');
  assertEquals(get('let r = "x"; try { r = BigInt(Infinity) } catch (e) { r = "caught" }'), 'caught');
  assertEquals(get('let r = "x"; try { r = BigInt(NaN) } catch (e) { r = "caught" }'), 'caught');
  assertEquals(get('let r = "x"; try { r = BigInt(5.5) } catch (e) { r = "caught" }'), 'caught');
});

// =============================================================================
// Constructors, DataView, parseInt.
// =============================================================================

Deno.test('trap-audit: new Array with invalid lengths → RangeError', () => {
  assertEquals(get('let r = "x"; try { r = new Array(NaN) } catch (e) { r = e.message }'),
    'Invalid array length');
  assertEquals(get('let r = "x"; try { r = new Array(0 - 5) } catch (e) { r = e.message }'),
    'Invalid array length');
  assertEquals(get('let r = "x"; try { r = new Array(2.5) } catch (e) { r = e.message }'),
    'Invalid array length');
  assertEquals(get('let r = new Array(3).length'), 3);
});

Deno.test('trap-audit: new Uint8Array(NaN) → empty (ToIndex(NaN) = 0)', () => {
  assertEquals(get('let r = new Uint8Array(NaN).length'), 0);
});

Deno.test('trap-audit: DataView offsets with NaN / huge', () => {
  assertEquals(get(
    'let d = new DataView(new ArrayBuffer(8)); d.setInt32(NaN, 7); let r = d.getInt32(0)'), 7);
  assertEquals(get(
    `let d = new DataView(new ArrayBuffer(8))
     let r = "x"
     try { r = d.getInt32(10000000000) } catch (e) { r = "caught" }`), 'caught');
});

Deno.test('trap-audit: parseInt radix NaN → auto, huge → NaN result', () => {
  assertEquals(get('let r = parseInt("5", NaN)'), 5);
  assert(Number.isNaN(get('let r = parseInt("5", 10000000000)')));
});

// =============================================================================
// Trig argument reduction — beyond the iterative reduction's range,
// NaN (range-preserving) instead of a module trap or sin(x) > 1.
// =============================================================================

Deno.test('trap-audit: Math.sin/cos/tan(1e300) → NaN, normal args unaffected', () => {
  assertEquals(get('let r = isNaN(Math.sin(10e299))'), true);
  assertEquals(get('let r = isNaN(Math.cos(10e299))'), true);
  assertEquals(get('let r = isNaN(Math.tan(10e299))'), true);
  assertEquals(get('let s = Math.sin(1000000000); let r = (s >= 0 - 1) && (s <= 1)'), true);
  assertEquals(get('let r = Math.abs(Math.sin(1) - 0.8414709848078965) < 0.0000001'), true);
});

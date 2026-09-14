/**
 * Non-empty strings must be truthy in boolean context.
 *
 * Before this work, every string was falsy because $is_truthy and
 * $is_truthy_inline were reading the string's length prefix via $abs(id)
 * instead of $string_id_to_abs(id). Under format v7, interned ids are
 * table-relative, not segment-relative, so the load returned garbage
 * (typically 0) for every string id and the helper returned 0.
 */

import { assertEquals } from "https://deno.land/std@0.208.0/assert/mod.ts";
import { createSession } from '../../src/fuel/session.js';
import { freshSession } from '../../src/host-owned-session.js';

function run(source, vars) {
  const session = freshSession();
  session.parse(source);
  const r = session.run(0, 1_000_000);
  assertEquals(r.status, 'done');
  const out = {};
  for (const name of vars) out[name] = session.get(0, name);
  return out;
}

Deno.test('non-empty string is truthy in ternary', () => {
  const r = run(`let result = "hello" ? "yes" : "no"`, ['result']);
  assertEquals(r.result, 'yes');
});

Deno.test('empty string is falsy in ternary', () => {
  const r = run(`let result = "" ? "yes" : "no"`, ['result']);
  assertEquals(r.result, 'no');
});

Deno.test('string "0" is truthy (not numeric coercion)', () => {
  const r = run(`let result = "0" ? "yes" : "no"`, ['result']);
  assertEquals(r.result, 'yes');
});

Deno.test('string "false" is truthy (not boolean coercion)', () => {
  const r = run(`let result = "false" ? "yes" : "no"`, ['result']);
  assertEquals(r.result, 'yes');
});

Deno.test('non-empty string in if() takes the then branch', () => {
  const r = run(`
    let result = "no"
    if ("hello") { result = "yes" }
  `, ['result']);
  assertEquals(r.result, 'yes');
});

Deno.test('empty string in if() takes the else branch', () => {
  const r = run(`
    let result = "no"
    if ("") { result = "yes" } else { result = "else" }
  `, ['result']);
  assertEquals(r.result, 'else');
});

Deno.test('&& returns right operand when left string is truthy', () => {
  const r = run(`let result = "x" && "y"`, ['result']);
  assertEquals(r.result, 'y');
});

Deno.test('&& short-circuits when left string is empty', () => {
  const r = run(`let result = "" && "y"`, ['result']);
  assertEquals(r.result, '');
});

Deno.test('|| returns left operand when left string is truthy', () => {
  const r = run(`let result = "x" || "y"`, ['result']);
  assertEquals(r.result, 'x');
});

Deno.test('|| returns right operand when left string is empty', () => {
  const r = run(`let result = "" || "y"`, ['result']);
  assertEquals(r.result, 'y');
});

Deno.test('Boolean(nonEmptyString) is true', () => {
  const r = run(`let result = Boolean("hello")`, ['result']);
  assertEquals(r.result, true);
});

Deno.test('Boolean(emptyString) is false', () => {
  const r = run(`let result = Boolean("")`, ['result']);
  assertEquals(r.result, false);
});

Deno.test('idiomatic error stringification picks message when truthy', () => {
  // Regression idiom: String(e && e.message ? e.message : e).
  // With strings-are-truthy fixed, the ternary picks the message string.
  const r = run(`
    let message = "Request requires a grant"
    let result = message ? message : "fallback"
  `, ['result']);
  assertEquals(r.result, 'Request requires a grant');
});

Deno.test('runtime-built non-empty string is truthy', () => {
  // Result strings from .slice and concat go through the same chokepoint;
  // their truthiness must work the same way as literal strings.
  const r = run(`
    let s = "init1/3"
    let head = s.slice(0, 4)
    let result = head ? "yes" : "no"
  `, ['result']);
  assertEquals(r.result, 'yes');
});

Deno.test('concatenated non-empty string is truthy', () => {
  const r = run(`
    let s = "a" + "b"
    let result = s ? "yes" : "no"
  `, ['result']);
  assertEquals(r.result, 'yes');
});

Deno.test('truth-table sweep for non-string primitives stays correct', () => {
  // Regression guard — fix to $is_truthy / $is_truthy_inline must not touch
  // the other branches.
  const r = run(`
    let n0 = 0 ? "T" : "F"
    let n1 = 1 ? "T" : "F"
    let b0 = false ? "T" : "F"
    let b1 = true ? "T" : "F"
    let null0 = null ? "T" : "F"
    let undef0 = undefined ? "T" : "F"
    let bi0 = 0n ? "T" : "F"
    let bi1 = 1n ? "T" : "F"
    let arr = [] ? "T" : "F"
    let obj = {} ? "T" : "F"
  `, ['n0', 'n1', 'b0', 'b1', 'null0', 'undef0', 'bi0', 'bi1', 'arr', 'obj']);
  assertEquals(r.n0, 'F');
  assertEquals(r.n1, 'T');
  assertEquals(r.b0, 'F');
  assertEquals(r.b1, 'T');
  assertEquals(r.null0, 'F');
  assertEquals(r.undef0, 'F');
  assertEquals(r.bi0, 'F');
  assertEquals(r.bi1, 'T');
  assertEquals(r.arr, 'T');
  assertEquals(r.obj, 'T');
});

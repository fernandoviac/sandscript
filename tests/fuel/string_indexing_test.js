import { assertEquals } from "https://deno.land/std@0.208.0/assert/mod.ts";
import { freshSession } from '../../src/host-owned-session.js';
import { parseAndSetup } from './test-helpers.js';

function run(source) {
  const session = freshSession();
  parseAndSetup(session, source);
  const result = session.run(0, 1_000_000);
  return { session, result };
}

function assertResult(source, varName, expected) {
  const { session, result } = run(source);
  assertEquals(result.status, 'done',
    `expected status=done, got ${result.status} (${result.error?.message})`);
  assertEquals(session.get(0, varName), expected);
}

Deno.test("str[0] returns first character", () => {
  assertResult('let s = "hello"; let r = s[0]', 'r', 'h');
});

Deno.test("str[4] returns last character", () => {
  assertResult('let s = "hello"; let r = s[4]', 'r', 'o');
});

Deno.test("str[5] out of bounds returns undefined", () => {
  assertResult('let s = "hello"; let r = s[5]', 'r', undefined);
});

Deno.test("str[-1] returns undefined", () => {
  assertResult('let s = "hello"; let r = s[-1]', 'r', undefined);
});

Deno.test("str[i] with non-integral index returns undefined (JS semantics)", () => {
  // JS: "hello"[1.9] is a lookup of the property "1.9", which doesn't
  // exist → undefined. (An earlier revision truncated to s[1]; the
  // trap-audit fix aligned index handling with JS.)
  assertResult('let s = "hello"; let r = s[1.9]', 'r', undefined);
});

Deno.test("str[NaN] returns undefined", () => {
  assertResult('let s = "hello"; let r = s[NaN]', 'r', undefined);
});

Deno.test("str[i] on empty string returns undefined", () => {
  assertResult('let s = ""; let r = s[0]', 'r', undefined);
});

Deno.test("string literal indexing", () => {
  assertResult('let r = "abc"[1]', 'r', 'b');
});

Deno.test("repeated indexing returns same character", () => {
  assertResult('let s = "hello"; let a = s[0]; let b = s[0]; let r = a === b', 'r', true);
});

Deno.test("str[i] = x is a silent no-op", () => {
  assertResult('let s = "hello"; s[0] = "X"; let r = s[0]', 'r', 'h');
});

Deno.test("str[i] = x returns the assigned value", () => {
  assertResult('let s = "hello"; let r = (s[0] = "X")', 'r', 'X');
});

Deno.test("string indexing: multi-byte code point indexed by code-point position", () => {
  const { session, result } = run(`
    let s = "a\u{1F600}b";
    let a = s[0]; let b = s[1]; let c = s[2];
  `);
  assertEquals(result.status, 'done');
  assertEquals(session.get(0, 'a'), 'a');
  assertEquals(session.get(0, 'b'), '\u{1F600}');
  assertEquals(session.get(0, 'c'), 'b');
});

Deno.test("string indexing: out-of-bounds after a multi-byte code point", () => {
  assertResult('let s = "a\u{1F600}b"; let d = s[3];', 'd', undefined);
});

Deno.test("string indexing: 2-byte UTF-8 code point (Latin-1 supplement)", () => {
  const { session, result } = run(`
    let s = "a\u{00E9}b";
    let a = s[0]; let b = s[1]; let c = s[2]; let d = s[3];
  `);
  assertEquals(result.status, 'done');
  assertEquals(session.get(0, 'a'), 'a');
  assertEquals(session.get(0, 'b'), '\u{00E9}');
  assertEquals(session.get(0, 'c'), 'b');
  assertEquals(session.get(0, 'd'), undefined);
});

Deno.test("string indexing: 3-byte UTF-8 code point (CJK)", () => {
  const { session, result } = run(`
    let s = "a\u{4E2D}b";
    let a = s[0]; let b = s[1]; let c = s[2]; let d = s[3];
  `);
  assertEquals(result.status, 'done');
  assertEquals(session.get(0, 'a'), 'a');
  assertEquals(session.get(0, 'b'), '\u{4E2D}');
  assertEquals(session.get(0, 'c'), 'b');
  assertEquals(session.get(0, 'd'), undefined);
});

Deno.test("string indexing: negative index on multi-byte string returns undefined", () => {
  assertResult('let s = "a\u{1F600}b"; let r = s[-1];', 'r', undefined);
});

Deno.test("string indexing: all-multi-byte string", () => {
  const { session, result } = run(`
    let s = "\u{4E2D}\u{6587}\u{1F600}";
    let a = s[0]; let b = s[1]; let c = s[2]; let len = s.length;
  `);
  assertEquals(result.status, 'done');
  assertEquals(session.get(0, 'a'), '\u{4E2D}');
  assertEquals(session.get(0, 'b'), '\u{6587}');
  assertEquals(session.get(0, 'c'), '\u{1F600}');
  assertEquals(session.get(0, 'len'), 3);
});

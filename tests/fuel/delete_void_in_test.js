/**
 * delete / void / binary `in`.
 *
 * void: fully implemented (evaluate operand, discard, push undefined).
 * delete: real own-property removal for MEMBER_ACCESS/INDEX_ACCESS
 * (string-keyed) operands on Object/Function receivers; NOT_SUPPORTED
 * for array-index targets (no hole representation) and non-reference
 * operands (`delete x`, `delete 5`).
 * in: real has-property check — objects walk the prototype chain
 * (own + inherited, matching JS spec, unlike delete which is
 * own-property-only), arrays do an index bounds check.
 */

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

function expectRuntimeThrow(source) {
  const session = freshSession();
  const parseResult = session.parse(source);
  session.mem.setContextInstructionIndex(0, parseResult.startIndex);
  session.mem.clearExitCondition(0);
  assertThrows(() => session.run(0, 1000000), UncaughtScriptError);
}

// ---------------------------------------------------------------------------
// void
// ---------------------------------------------------------------------------

Deno.test("void: evaluates operand and yields undefined", () => {
  assertEquals(run(`let x = void 5;`).get(0, 'x'), undefined);
});

Deno.test("void: still runs side effects of its operand", () => {
  const session = run(`
    let calls = 0;
    function bump() { calls = calls + 1; return 1; }
    let r = void bump();
  `);
  assertEquals(session.get(0, 'calls'), 1);
  assertEquals(session.get(0, 'r'), undefined);
});

// ---------------------------------------------------------------------------
// delete: object property, dot and bracket form
// ---------------------------------------------------------------------------

Deno.test("delete: removes an own property (dot access)", () => {
  const session = run(`
    let obj = { a: 1, b: 2 };
    let removed = delete obj.a;
    let stillHasB = "b" in obj;
    let hasA = "a" in obj;
  `);
  assertEquals(session.get(0, 'removed'), true);
  assertEquals(session.get(0, 'hasA'), false);
  assertEquals(session.get(0, 'stillHasB'), true);
});

Deno.test("delete: removes an own property (bracket access, string literal key)", () => {
  const session = run(`
    let obj = { a: 1 };
    let removed = delete obj["a"];
    let hasA = "a" in obj;
  `);
  assertEquals(session.get(0, 'removed'), true);
  assertEquals(session.get(0, 'hasA'), false);
});

Deno.test("delete: bracket access with a computed (runtime) key", () => {
  const session = run(`
    let obj = { a: 1 };
    let key = "a";
    let removed = delete obj[key];
    let hasA = "a" in obj;
  `);
  assertEquals(session.get(0, 'removed'), true);
  assertEquals(session.get(0, 'hasA'), false);
});

Deno.test("delete: bracket access coerces a non-string key to string (ToPropertyKey)", () => {
  const session = run(`
    let obj = {};
    obj[42] = "answer";
    let removed = delete obj[42];
    let has = "42" in obj;
  `);
  assertEquals(session.get(0, 'removed'), true);
  assertEquals(session.get(0, 'has'), false);
});

Deno.test("delete: deleting a nonexistent property returns false, does not throw", () => {
  const session = run(`
    let obj = { a: 1 };
    let removed = delete obj.nope;
    let stillHasA = "a" in obj;
  `);
  assertEquals(session.get(0, 'removed'), false);
  assertEquals(session.get(0, 'stillHasA'), true);
});

Deno.test("delete: preserves insertion order of remaining keys (shift, not swap-with-last)", () => {
  const session = run(`
    let obj = { a: 1, b: 2, c: 3 };
    delete obj.a;
    let keys = [];
    for (let k in obj) { keys.push(k); }
  `);
  assertEquals(session.get(0, 'keys'), ['b', 'c']);
});

Deno.test("delete: chained member access only deletes the LAST link, not intermediate reads", () => {
  const session = run(`
    let obj = { inner: { a: 1, b: 2 } };
    let removed = delete obj.inner.a;
    let hasA = "a" in obj.inner;
    let hasB = "b" in obj.inner;
    let innerStillThere = "inner" in obj;
  `);
  assertEquals(session.get(0, 'removed'), true);
  assertEquals(session.get(0, 'hasA'), false);
  assertEquals(session.get(0, 'hasB'), true);
  assertEquals(session.get(0, 'innerStillThere'), true);
});

Deno.test("delete: mixed dot/bracket chain deletes only the last link", () => {
  const session = run(`
    let obj = { list: [{ a: 1 }] };
    let removed = delete obj.list[0].a;
    let hasA = "a" in obj.list[0];
  `);
  assertEquals(session.get(0, 'removed'), true);
  assertEquals(session.get(0, 'hasA'), false);
});

Deno.test("delete: object produced by a call expression works as a target", () => {
  const session = run(`
    let obj = { a: 1 };
    function getObj() { return obj; }
    let removed = delete getObj().a;
    let hasA = "a" in obj;
  `);
  assertEquals(session.get(0, 'removed'), true);
  assertEquals(session.get(0, 'hasA'), false);
});

// ---------------------------------------------------------------------------
// delete: method-call must NOT be mistaken for a delete target
// ---------------------------------------------------------------------------

Deno.test("delete: a method call as operand is NOT treated as a property reference", () => {
  // `delete obj.method()` — the call happens (method still exists
  // afterward), and delete operates on the call's return value, which
  // is not a reference. sandscript throws NOT_SUPPORTED for that case
  // rather than inventing a "true but did nothing" result — but the
  // critical regression this guards is that `obj.method` itself must
  // NOT be deleted as a side effect of parsing.
  expectRuntimeThrow(`
    let obj = { method: function() { return 1; } };
    let r = delete obj.method();
  `);
  const session = run(`
    let obj = { method: function() { return 1; } };
    let calledOk = false;
    try {
      let r = delete obj.method();
    } catch (e) {
      calledOk = typeof obj.method === "function";
    }
  `);
  assertEquals(session.get(0, 'calledOk'), true);
});

// ---------------------------------------------------------------------------
// delete: optional chaining
// ---------------------------------------------------------------------------

Deno.test("delete: optional chaining deletes when the object is present", () => {
  const session = run(`
    let obj = { a: 1 };
    let removed = delete obj?.a;
    let hasA = "a" in obj;
  `);
  assertEquals(session.get(0, 'removed'), true);
  assertEquals(session.get(0, 'hasA'), false);
});

Deno.test("delete: optional chaining short-circuits to undefined when the object is nullish", () => {
  const session = run(`
    let obj = null;
    let removed = delete obj?.a;
  `);
  assertEquals(session.get(0, 'removed'), undefined);
});

// ---------------------------------------------------------------------------
// delete: non-reference operand still throws (Slice 0 behavior retained)
// ---------------------------------------------------------------------------

Deno.test("delete: bare variable operand throws NOT_SUPPORTED", () => {
  expectRuntimeThrow(`let x = 5; let r = delete x;`);
});

Deno.test("delete: literal operand throws NOT_SUPPORTED", () => {
  expectRuntimeThrow(`let r = delete 5;`);
});

// ---------------------------------------------------------------------------
// delete: array index — explicit NOT_SUPPORTED (no hole representation)
// ---------------------------------------------------------------------------

Deno.test("delete: array index throws NOT_SUPPORTED rather than silently splicing or blanking", () => {
  expectRuntimeThrow(`let arr = [1, 2, 3]; let r = delete arr[1];`);
});

// ---------------------------------------------------------------------------
// in: objects (own + inherited), arrays, and non-object receivers
// ---------------------------------------------------------------------------

Deno.test("in: true for an own string-keyed property", () => {
  assertEquals(run(`let obj = { a: 1 }; let r = "a" in obj;`).get(0, 'r'), true);
});

Deno.test("in: false for a missing property", () => {
  assertEquals(run(`let obj = { a: 1 }; let r = "b" in obj;`).get(0, 'r'), false);
});

Deno.test("in: computed (non-literal) key", () => {
  const session = run(`
    let obj = { a: 1 };
    let key = "a";
    let r = key in obj;
  `);
  assertEquals(session.get(0, 'r'), true);
});

Deno.test("in: coerces a non-string key (ToPropertyKey)", () => {
  const session = run(`
    let obj = {};
    obj[42] = "answer";
    let r = 42 in obj;
  `);
  assertEquals(session.get(0, 'r'), true);
});

Deno.test("in: true for an inherited (prototype-chain) property — unlike delete, which is own-only", () => {
  const session = run(`
    function Base() {}
    Base.prototype.shared = 1;
    let instance = new Base();
    let r = "shared" in instance;
  `);
  assertEquals(session.get(0, 'r'), true);
});

Deno.test("in: array index within bounds is true, out of bounds is false", () => {
  const session = run(`
    let arr = [1, 2, 3];
    let a = 0 in arr;
    let b = 2 in arr;
    let c = 3 in arr;
    let d = 10 in arr;
  `);
  assertEquals(session.get(0, 'a'), true);
  assertEquals(session.get(0, 'b'), true);
  assertEquals(session.get(0, 'c'), false);
  assertEquals(session.get(0, 'd'), false);
});

Deno.test("in: throws TypeError for a non-object right-hand side", () => {
  expectRuntimeThrow(`let r = "a" in 5;`);
});

Deno.test("in and delete interact: deleting a key makes `in` report false", () => {
  const session = run(`
    let obj = { a: 1 };
    delete obj.a;
    let r = "a" in obj;
  `);
  assertEquals(session.get(0, 'r'), false);
});

// ---------------------------------------------------------------------------
// Regression: promoting `in` to a real keyword token must not break
// for...in loops, which previously matched `in` via IDENTIFIER-value
// comparison rather than a dedicated token.
// ---------------------------------------------------------------------------

Deno.test("for...in regression: let form still works after `in` became a real keyword", () => {
  const session = run(`
    let obj = { a: 1, b: 2 };
    let keys = [];
    for (let k in obj) { keys.push(k); }
  `);
  assertEquals(session.get(0, 'keys'), ['a', 'b']);
});

Deno.test("for...in regression: const form still works", () => {
  const session = run(`
    let obj = { a: 1 };
    let n = 0;
    for (const k in obj) { n = n + 1; }
  `);
  assertEquals(session.get(0, 'n'), 1);
});

// ---------------------------------------------------------------------------
// delete: non-plain-object receivers (Map/Set/Array via dot access) —
// no per-property model for these, so delete reports false rather than
// throwing or corrupting internal state.
// ---------------------------------------------------------------------------

Deno.test("delete: dot access on a Map receiver returns false, does not throw or corrupt the map", () => {
  const session = run(`
    let m = new Map();
    m.set("a", 1);
    let removed = delete m.a;
    let stillHasA = m.has("a");
  `);
  assertEquals(session.get(0, 'removed'), false);
  assertEquals(session.get(0, 'stillHasA'), true);
});

Deno.test("delete: dot access on an array receiver (non-index property) returns false", () => {
  const session = run(`
    let arr = [1, 2, 3];
    let removed = delete arr.length;
    let len = arr.length;
  `);
  assertEquals(session.get(0, 'removed'), false);
  assertEquals(session.get(0, 'len'), 3);
});

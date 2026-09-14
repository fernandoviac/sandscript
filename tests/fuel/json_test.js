/**
 * Test JSON.stringify and JSON.parse implementation.
 *
 * Run with: deno task test tests/fuel/json_test.js
 */

import { assertEquals } from "https://deno.land/std@0.208.0/assert/mod.ts";
import { createSession } from '../../src/fuel/session.js';
import { freshSession } from '../../src/host-owned-session.js';

async function evalCode(code) {
  const session = await freshSession();
  session.parse(code);
  const runResult = session.run(0, 10000);
  if (runResult.status === 'error') {
    throw new Error(`Execution error: ${JSON.stringify(runResult.error)}`);
  }
  return session.get(0, 'result');
}

// =============================================================================
// JSON.stringify tests
// =============================================================================

Deno.test("JSON.stringify: null", async () => {
  const result = await evalCode('let result = JSON.stringify(null)');
  assertEquals(result, 'null');
});

Deno.test("JSON.stringify: true", async () => {
  const result = await evalCode('let result = JSON.stringify(true)');
  assertEquals(result, 'true');
});

Deno.test("JSON.stringify: false", async () => {
  const result = await evalCode('let result = JSON.stringify(false)');
  assertEquals(result, 'false');
});

Deno.test("JSON.stringify: number", async () => {
  const result = await evalCode('let result = JSON.stringify(42)');
  assertEquals(result, '42');
});

Deno.test("JSON.stringify: negative number", async () => {
  const result = await evalCode('let result = JSON.stringify(-123)');
  assertEquals(result, '-123');
});

Deno.test("JSON.stringify: float", async () => {
  const result = await evalCode('let result = JSON.stringify(3.14)');
  assertEquals(result, '3.14');
});

Deno.test("JSON.stringify: string", async () => {
  const result = await evalCode('let result = JSON.stringify("hello")');
  assertEquals(result, '"hello"');
});

Deno.test("JSON.stringify: empty string", async () => {
  const result = await evalCode('let result = JSON.stringify("")');
  assertEquals(result, '""');
});

Deno.test("JSON.stringify: array", async () => {
  const result = await evalCode('let result = JSON.stringify([1, 2, 3])');
  assertEquals(result, '[1,2,3]');
});

Deno.test("JSON.stringify: empty array", async () => {
  const result = await evalCode('let result = JSON.stringify([])');
  assertEquals(result, '[]');
});

Deno.test("JSON.stringify: object", async () => {
  const result = await evalCode('let result = JSON.stringify({a: 1})');
  assertEquals(result, '{"a":1}');
});

Deno.test("JSON.stringify: empty object", async () => {
  const result = await evalCode('let result = JSON.stringify({})');
  assertEquals(result, '{}');
});

Deno.test("JSON.stringify: nested object", async () => {
  const result = await evalCode('let result = JSON.stringify({a: {b: 1}})');
  assertEquals(result, '{"a":{"b":1}}');
});

Deno.test("JSON.stringify: nested array", async () => {
  const result = await evalCode('let result = JSON.stringify([[1, 2], [3, 4]])');
  assertEquals(result, '[[1,2],[3,4]]');
});

Deno.test("JSON.stringify: mixed", async () => {
  const result = await evalCode('let result = JSON.stringify({a: [1, 2], b: "test"})');
  assertEquals(result, '{"a":[1,2],"b":"test"}');
});

Deno.test("JSON.stringify: an undefined root returns the undefined value (spec)", async () => {
  const result = await evalCode('let result = JSON.stringify(undefined)');
  assertEquals(result, undefined);
});

Deno.test("JSON.stringify: newline escape", async () => {
  const result = await evalCode('let result = JSON.stringify("a\\nb")');
  assertEquals(result, '"a\\nb"');
});

Deno.test("JSON.stringify: tab escape", async () => {
  const result = await evalCode('let result = JSON.stringify("a\\tb")');
  assertEquals(result, '"a\\tb"');
});

Deno.test("JSON.stringify: quote escape", async () => {
  const result = await evalCode('let result = JSON.stringify("a\\"b")');
  assertEquals(result, '"a\\"b"');
});

Deno.test("JSON.stringify: backslash escape", async () => {
  const result = await evalCode('let result = JSON.stringify("a\\\\b")');
  assertEquals(result, '"a\\\\b"');
});

Deno.test("JSON.stringify: NaN becomes null", async () => {
  const result = await evalCode('let result = JSON.stringify(NaN)');
  assertEquals(result, 'null');
});

Deno.test("JSON.stringify: Infinity becomes null", async () => {
  const result = await evalCode('let result = JSON.stringify(Infinity)');
  assertEquals(result, 'null');
});

Deno.test("JSON.stringify: -Infinity becomes null", async () => {
  const result = await evalCode('let result = JSON.stringify(-Infinity)');
  assertEquals(result, 'null');
});

Deno.test("JSON.stringify: omits functions", async () => {
  const result = await evalCode('let result = JSON.stringify({a: 1, b: () => 2})');
  assertEquals(result, '{"a":1}');
});

// =============================================================================
// JSON.parse tests
// =============================================================================

Deno.test("JSON.parse: null", async () => {
  const result = await evalCode('let result = JSON.parse("null")');
  assertEquals(result, null);
});

Deno.test("JSON.parse: true", async () => {
  const result = await evalCode('let result = JSON.parse("true")');
  assertEquals(result, true);
});

Deno.test("JSON.parse: false", async () => {
  const result = await evalCode('let result = JSON.parse("false")');
  assertEquals(result, false);
});

Deno.test("JSON.parse: number", async () => {
  const result = await evalCode('let result = JSON.parse("42")');
  assertEquals(result, 42);
});

Deno.test("JSON.parse: negative number", async () => {
  const result = await evalCode('let result = JSON.parse("-123")');
  assertEquals(result, -123);
});

Deno.test("JSON.parse: float", async () => {
  const result = await evalCode('let result = JSON.parse("3.14")');
  assertEquals(result, 3.14);
});

Deno.test("JSON.parse: string", async () => {
  const result = await evalCode(`let result = JSON.parse('"hello"')`);
  assertEquals(result, 'hello');
});

Deno.test("JSON.parse: empty string", async () => {
  const result = await evalCode(`let result = JSON.parse('""')`);
  assertEquals(result, '');
});

Deno.test("JSON.parse: array", async () => {
  const result = await evalCode('let result = JSON.parse("[1,2,3]")');
  assertEquals(result, [1, 2, 3]);
});

Deno.test("JSON.parse: empty array", async () => {
  const result = await evalCode('let result = JSON.parse("[]")');
  assertEquals(result, []);
});

Deno.test("JSON.parse: object", async () => {
  const result = await evalCode(`let result = JSON.parse('{"a":1}')`);
  assertEquals(result, {a: 1});
});

Deno.test("JSON.parse: empty object", async () => {
  const result = await evalCode('let result = JSON.parse("{}")');
  assertEquals(result, {});
});

Deno.test("JSON.parse: nested object", async () => {
  const result = await evalCode(`let result = JSON.parse('{"a":{"b":1}}')`);
  assertEquals(result, {a: {b: 1}});
});

Deno.test("JSON.parse: empty object nested in array preserves sibling elements", async () => {
  const result = await evalCode(`let parsed = JSON.parse('{"steps":[{"op":"create-box","args":{}}]}'); let result = parsed.steps.length`);
  assertEquals(result, 1);
});

Deno.test("JSON.parse: nested array", async () => {
  const result = await evalCode('let result = JSON.parse("[[1,2],[3,4]]")');
  assertEquals(result, [[1, 2], [3, 4]]);
});

Deno.test("JSON.parse: with whitespace", async () => {
  const result = await evalCode(`let result = JSON.parse('{ "a" : 1 }')`);
  assertEquals(result, {a: 1});
});

Deno.test("JSON.parse: with newlines", async () => {
  const result = await evalCode(`let result = JSON.parse('{\\n"a": 1\\n}')`);
  assertEquals(result, {a: 1});
});

Deno.test("JSON.parse: escaped newline", async () => {
  const result = await evalCode(`let result = JSON.parse('"a\\\\nb"')`);
  assertEquals(result, 'a\nb');
});

Deno.test("JSON.parse: escaped tab", async () => {
  const result = await evalCode(`let result = JSON.parse('"a\\\\tb"')`);
  assertEquals(result, 'a\tb');
});

Deno.test("JSON.parse: escaped quote", async () => {
  const result = await evalCode(`let result = JSON.parse('"a\\\\\\"b"')`);
  assertEquals(result, 'a"b');
});

Deno.test("JSON.parse: escaped backslash", async () => {
  const result = await evalCode(`let result = JSON.parse('"a\\\\\\\\b"')`);
  assertEquals(result, 'a\\b');
});

// =============================================================================
// Roundtrip tests
// =============================================================================

Deno.test("JSON roundtrip: object", async () => {
  const result = await evalCode('let obj = {a: 1, b: "test"}; let result = JSON.parse(JSON.stringify(obj))');
  assertEquals(result, {a: 1, b: "test"});
});

Deno.test("JSON roundtrip: array", async () => {
  const result = await evalCode('let arr = [1, "two", true, null]; let result = JSON.parse(JSON.stringify(arr))');
  assertEquals(result, [1, "two", true, null]);
});

Deno.test("JSON roundtrip: nested", async () => {
  const result = await evalCode('let obj = {arr: [1, {x: 2}]}; let result = JSON.parse(JSON.stringify(obj))');
  assertEquals(result, {arr: [1, {x: 2}]});
});

Deno.test("JSON roundtrip: complex", async () => {
  const result = await evalCode('let obj = {users: [{name: "alice", age: 30}, {name: "bob", age: 25}]}; let result = JSON.parse(JSON.stringify(obj))');
  assertEquals(result, {users: [{name: "alice", age: 30}, {name: "bob", age: 25}]});
});

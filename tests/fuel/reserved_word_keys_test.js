/**
 * Reserved words as property keys — JS allows any IdentifierName as
 * an object-literal key, a method-shorthand name, and a
 * destructuring-pattern key. Sandscript reserves more words than JS
 * (grant, denied), so this bites drone authors embedding JSON-Schema
 * literals: `{ const: "channel" }`, `{ enum: [...] }`.
 *
 * Shorthand stays invalid: `{ const }` would bind a variable that
 * cannot exist.
 */

import {
  createTestContext,
  runCode,
  assertNumericResult,
  assertStringResult,
} from './interpreter-test-utils.js';

import { assertThrows } from "https://deno.land/std@0.208.0/assert/mod.ts";

Deno.test("reserved word keys: { const: ... } parses and reads back", () => {
  assertStringResult(`
    let schema = { properties: { kind: { const: "channel" } } }
    let result = schema.properties.kind.const
  `, "result", "channel");
});

Deno.test("reserved word keys: statement keywords and literals as keys", () => {
  assertNumericResult(`
    let obj = { if: 1, new: 2, true: 3, grant: 4, denied: 5, catch: 6 }
    let result = obj.if + obj.new + obj.true + obj.grant + obj.denied + obj.catch
  `, "result", 21);
});

Deno.test("reserved word keys: method shorthand with keyword name", () => {
  assertNumericResult(`
    let obj = {
      catch(x) { return x + 1 }
    }
    let result = obj.catch(6)
  `, "result", 7);
});

Deno.test("reserved word keys: destructuring pattern key with rename", () => {
  assertStringResult(`
    let record = { const: "pinned", other: 1 }
    let { const: pinned } = record
    let result = pinned
  `, "result", "pinned");
});

Deno.test("reserved word keys: { async: v } still works (regression)", () => {
  assertNumericResult(`
    let obj = { async: 42 }
    let result = obj.async
  `, "result", 42);
});

Deno.test("reserved word keys: shorthand { const } is a parse error", () => {
  const { mem, wasm, parser } = createTestContext();
  assertThrows(
    () => runCode(mem, wasm, parser, `
      let obj = { const }
    `),
    Error,
    "Reserved word",
  );
});

Deno.test("reserved word keys: pattern shorthand { const } is a parse error", () => {
  const { mem, wasm, parser } = createTestContext();
  assertThrows(
    () => runCode(mem, wasm, parser, `
      let { const } = { const: 1 }
    `),
    Error,
    "Reserved-word pattern key",
  );
});

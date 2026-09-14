/**
 * Unit tests for toJsonSafe (src/sand/cli.js), the transform behind
 * `sand get <name>`'s JSON output. cli_test.js covers the same
 * function through the real CLI subprocess for the cases reachable
 * that way; this file covers toJsonSafe directly, including the
 * throw-on-unsupported-type case, which session.get() never actually
 * produces in practice (no function/symbol readback shape exists) but
 * which the function must still refuse rather than silently drop.
 */

import { assertEquals, assertThrows } from "https://deno.land/std@0.208.0/assert/mod.ts";
import { toJsonSafe } from '../../src/sand/cli.js';

Deno.test("toJsonSafe: null and undefined both become null", () => {
  assertEquals(toJsonSafe(null), null);
  assertEquals(toJsonSafe(undefined), null);
});

Deno.test("toJsonSafe: primitives pass through unchanged", () => {
  assertEquals(toJsonSafe(42), 42);
  assertEquals(toJsonSafe(-3.14), -3.14);
  assertEquals(toJsonSafe("hello"), "hello");
  assertEquals(toJsonSafe(true), true);
  assertEquals(toJsonSafe(false), false);
});

Deno.test("toJsonSafe: BigInt becomes {$bigint: '<digits>'}", () => {
  assertEquals(toJsonSafe(123n), { $bigint: "123" });
  assertEquals(toJsonSafe(0n), { $bigint: "0" });
  assertEquals(toJsonSafe(-99n), { $bigint: "-99" });
});

Deno.test("toJsonSafe: BigInt beyond Number.MAX_SAFE_INTEGER survives exactly, as a string", () => {
  const huge = 123456789012345678901234567890n;
  const result = toJsonSafe(huge);
  assertEquals(result, { $bigint: "123456789012345678901234567890" });
  // Round-trips through real JSON with no precision loss, since it's
  // carried as a string, not a JSON number.
  assertEquals(JSON.parse(JSON.stringify(result)).$bigint, "123456789012345678901234567890");
});

Deno.test("toJsonSafe: plain arrays recurse", () => {
  assertEquals(toJsonSafe([1, 2, 3]), [1, 2, 3]);
  assertEquals(toJsonSafe([1n, 2n]), [{ $bigint: "1" }, { $bigint: "2" }]);
  assertEquals(toJsonSafe([]), []);
});

Deno.test("toJsonSafe: plain objects recurse, including nested BigInts", () => {
  assertEquals(toJsonSafe({ a: 1, b: 2 }), { a: 1, b: 2 });
  assertEquals(toJsonSafe({ a: 1n }), { a: { $bigint: "1" } });
  assertEquals(toJsonSafe({}), {});
});

Deno.test("toJsonSafe: recurses through SandScript's tagged {kind} readback shapes", () => {
  // Mirrors memory-reader.js's actual rational readback shape.
  const rational = { kind: 'rational', numerator: 1n, denominator: 3n };
  assertEquals(toJsonSafe(rational), {
    kind: 'rational',
    numerator: { $bigint: "1" },
    denominator: { $bigint: "3" },
  });

  // Mirrors a shallow theorem readback (premises intentionally not
  // recursed — see memory-reader.js's TYPE.THEOREM case).
  const theorem = {
    kind: 'theorem',
    statement: { kind: 'expression', head: 'Equal', arguments: [1n, 1n] },
    hypotheses: [],
    rule: 'reflexivity',
    premiseCount: 0,
  };
  assertEquals(toJsonSafe(theorem), {
    kind: 'theorem',
    statement: { kind: 'expression', head: 'Equal', arguments: [{ $bigint: "1" }, { $bigint: "1" }] },
    hypotheses: [],
    rule: 'reflexivity',
    premiseCount: 0,
  });
});

Deno.test("toJsonSafe: throws on a value type outside SandScript's readback space", () => {
  assertThrows(() => toJsonSafe(() => {}), TypeError);
  assertThrows(() => toJsonSafe(function named() {}), TypeError);
  assertThrows(() => toJsonSafe(Symbol('x')), TypeError);
});

Deno.test("toJsonSafe: output is always valid, parseable JSON with no data loss", () => {
  const value = {
    name: "test",
    big: 99999999999999999999n,
    nested: { list: [1, "two", null, true, false, 3n] },
  };
  const json = JSON.stringify(toJsonSafe(value));
  const parsed = JSON.parse(json);
  assertEquals(parsed.name, "test");
  assertEquals(parsed.big, { $bigint: "99999999999999999999" });
  assertEquals(parsed.nested.list, [1, "two", null, true, false, { $bigint: "3" }]);
});

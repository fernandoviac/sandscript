/**
 * SCOPE_FLAG_CONST vs bound-method receiver types.
 *
 * The scope entry's flags word doubles as the stored VALUE's flags
 * word, and TYPE_BOUND_METHOD packs its receiver TYPE in the low byte.
 * The historic SCOPE_FLAG_CONST = 0x01 collided two ways:
 *
 *   - $scope_set preserved the low flag byte across assignment "for
 *     const", destroying receiver types: `m = arr.push` came back
 *     undispatchable (receiver type 0) while `let m = arr.push` worked.
 *     Found while building C3's for-await fallback.
 *   - Odd receiver types (TYPE_STRING 0x05, TYPE_SET 0x25) read as
 *     const: `let m = "x".slice; m = y` threw a false const error.
 *
 * SCOPE_FLAG_CONST is now bit 31 (no value-level flag uses it),
 * $scope_set preserves only that bit, and GET_VAR masks it out of the
 * pushed value's flags.
 */

import { assertEquals } from "https://deno.land/std@0.208.0/assert/mod.ts";
import { parseAndSetup } from './test-helpers.js';
import { freshSession } from '../../src/host-owned-session.js';

function run(source) {
  const session = freshSession();
  parseAndSetup(session, source);
  const result = session.run(0, 50_000_000);
  if (result.status === 'error') {
    throw new Error(result.error.message);
  }
  return session;
}

Deno.test("bound method assigned via = keeps its receiver type", () => {
  const s = run(`
    let arr = [1, 2];
    let m;
    m = arr[Symbol.iterator];
    let it = m();
    let r = it.next().value;
  `);
  assertEquals(s.get(0, 'r'), 1);
});

Deno.test("odd receiver types (string, set) are not falsely const", () => {
  const s = run(`
    let a = "hello".slice;
    a = "reassigned";
    let s2 = new Set([1]);
    let b = s2.has;
    b = 42;
    let r = a + "|" + b;
  `);
  assertEquals(s.get(0, 'r'), 'reassigned|42');
});

Deno.test("real const is still enforced, including for bound methods", () => {
  const s = run(`
    const x = 1;
    const m = [7, 8][Symbol.iterator];
    let errors = 0;
    try { x = 2; } catch (e) { errors = errors + 1; }
    try { m = 0; } catch (e) { errors = errors + 1; }
    let it = m();
    let r = errors + "|" + x + "|" + it.next().value;
  `);
  assertEquals(s.get(0, 'r'), '2|1|7');
});

Deno.test("value-level flags survive reassignment (inline rationals)", () => {
  const s = run(`
    let x = 5;
    x = 7;
    let r = x + 1;
  `);
  assertEquals(s.get(0, 'r'), 8);
});

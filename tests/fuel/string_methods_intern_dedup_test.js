/**
 * All eight string methods (slice, substring, toLowerCase, toUpperCase,
 * repeat, padStart, padEnd, and replace) route through $intern_string rather
 * than bump-allocating directly. Result strings deduplicate with existing
 * interned entries and gain the chokepoint's memory-pressure
 * protection.
 *
 * The original symptom: `s.slice(0, 4) === "init"` returned false
 * for `s = "init1/3"` because slice produced a fresh non-deduped
 * entry. The tests below assert dedup across all 8 methods.
 */

import { assertEquals } from "https://deno.land/std@0.208.0/assert/mod.ts";
import { createSession } from '../../src/fuel/session.js';
import { freshSession } from '../../src/host-owned-session.js';

Deno.test('slice() dedups with literal of same bytes', () => {
  const session = freshSession();
  session.parse(`
    let s = "init1/3"
    let head = "init"
    let eq = (s.slice(0, 4) === head)
  `);
  const r = session.run(0, 1_000_000);
  assertEquals(r.status, 'done');
  assertEquals(session.get(0, 'eq'), true);
});

Deno.test('substring() dedups with literal of same bytes', () => {
  const session = freshSession();
  session.parse(`
    let s = "init1/3"
    let head = "init"
    let eq = (s.substring(0, 4) === head)
  `);
  const r = session.run(0, 1_000_000);
  assertEquals(r.status, 'done');
  assertEquals(session.get(0, 'eq'), true);
});

Deno.test('toLowerCase() dedups with literal', () => {
  const session = freshSession();
  session.parse(`
    let lower = "init"
    let eq = ("INIT".toLowerCase() === lower)
  `);
  const r = session.run(0, 1_000_000);
  assertEquals(r.status, 'done');
  assertEquals(session.get(0, 'eq'), true);
});

Deno.test('toUpperCase() dedups with literal', () => {
  const session = freshSession();
  session.parse(`
    let upper = "INIT"
    let eq = ("init".toUpperCase() === upper)
  `);
  const r = session.run(0, 1_000_000);
  assertEquals(r.status, 'done');
  assertEquals(session.get(0, 'eq'), true);
});

Deno.test('repeat() dedups with literal', () => {
  const session = freshSession();
  session.parse(`
    let target = "ababab"
    let eq = ("ab".repeat(3) === target)
  `);
  const r = session.run(0, 1_000_000);
  assertEquals(r.status, 'done');
  assertEquals(session.get(0, 'eq'), true);
});

Deno.test('padStart() dedups with literal', () => {
  const session = freshSession();
  session.parse(`
    let target = "  ab"
    let eq = ("ab".padStart(4) === target)
  `);
  const r = session.run(0, 1_000_000);
  assertEquals(r.status, 'done');
  assertEquals(session.get(0, 'eq'), true);
});

Deno.test('padEnd() dedups with literal', () => {
  const session = freshSession();
  session.parse(`
    let target = "ab  "
    let eq = ("ab".padEnd(4) === target)
  `);
  const r = session.run(0, 1_000_000);
  assertEquals(r.status, 'done');
  assertEquals(session.get(0, 'eq'), true);
});

Deno.test('replace() dedups with literal', () => {
  const session = freshSession();
  session.parse(`
    let target = "abc"
    let eq = ("aXc".replace("X", "b") === target)
  `);
  const r = session.run(0, 1_000_000);
  assertEquals(r.status, 'done');
  assertEquals(session.get(0, 'eq'), true);
});

// The four late-found bypass sites (2026-07-11 sweep during the
// hash-index dedup fix): charAt, trim, Array.from(string), and
// Uint8Array join wrote [len][bytes] records straight at
// STATE_STRING_POINTER — no dedup, no hash registration, no capacity
// check. Same assertions as the original 8 methods above.

Deno.test('charAt() dedups with literal of same bytes', () => {
  const session = freshSession();
  session.parse(`
    let s = "abc"
    let eq = (s.charAt(0) === "a")
  `);
  const r = session.run(0, 1_000_000);
  assertEquals(r.status, 'done');
  assertEquals(session.get(0, 'eq'), true);
});

Deno.test('charAt() out of range returns the canonical empty string', () => {
  const session = freshSession();
  session.parse(`
    let s = "abc"
    let eq = (s.charAt(-1) === "") && (s.charAt(99) === "")
  `);
  const r = session.run(0, 1_000_000);
  assertEquals(r.status, 'done');
  assertEquals(session.get(0, 'eq'), true);
});

Deno.test('charAt() result works as an object key against a literal read', () => {
  // The end-to-end corruption shape: a non-deduped key id makes the
  // compiled literal read miss silently and yield undefined.
  const session = freshSession();
  session.parse(`
    let s = "abc"
    let o = {}
    o[s.charAt(0)] = 42
    let v = o["a"]
  `);
  const r = session.run(0, 1_000_000);
  assertEquals(r.status, 'done');
  assertEquals(session.get(0, 'v'), 42);
});

Deno.test('trim() dedups with literal of same bytes', () => {
  const session = freshSession();
  session.parse(`
    let eq = ("  init  ".trim() === "init")
  `);
  const r = session.run(0, 1_000_000);
  assertEquals(r.status, 'done');
  assertEquals(session.get(0, 'eq'), true);
});

Deno.test('trim() to nothing returns the canonical empty string', () => {
  const session = freshSession();
  session.parse(`
    let eq = ("   ".trim() === "")
  `);
  const r = session.run(0, 1_000_000);
  assertEquals(r.status, 'done');
  assertEquals(session.get(0, 'eq'), true);
});

Deno.test('Array.from(string) chars dedup with literals', () => {
  const session = freshSession();
  session.parse(`
    let chars = Array.from("ab")
    let eq = (chars[0] === "a") && (chars[1] === "b")
  `);
  const r = session.run(0, 1_000_000);
  assertEquals(r.status, 'done');
  assertEquals(session.get(0, 'eq'), true);
});

Deno.test('Uint8Array join: empty array returns the canonical empty string', () => {
  const session = freshSession();
  session.parse(`
    let u = new Uint8Array(0)
    let eq = (u.join(",") === "")
  `);
  const r = session.run(0, 1_000_000);
  assertEquals(r.status, 'done');
  assertEquals(session.get(0, 'eq'), true);
});

Deno.test('Uint8Array join: default separator dedups with literal result', () => {
  const session = freshSession();
  session.parse(`
    let u = Uint8Array.of(1, 2)
    let eq = (u.join() === "1,2")
  `);
  const r = session.run(0, 1_000_000);
  assertEquals(r.status, 'done');
  assertEquals(session.get(0, 'eq'), true);
});

Deno.test('repeated charAt out-of-range produces bounded string-table growth', () => {
  // The old direct-bump path wrote a fresh 4-byte empty-string entry on
  // EVERY out-of-range charAt — unbounded 4-byte entries, which is also
  // what undermined the hash-index sizing invariant (buckets are sized
  // for 8-byte-minimum entries with one unique 4-byte empty).
  const session = freshSession();
  const mem = session.airlock.memoryImage;

  session.parse(`let prime = "abc".charAt(-1)`);
  session.run(0, 1_000_000);
  const before = mem.getStringPointer();

  const p = session.parse(`
    let i = 0
    while (i < 1000) {
      let _ = "abc".charAt(-1)
      i = i + 1
    }
  `);
  mem.setContextInstructionIndex(0, p.startIndex);
  const r = session.run(0, 50_000_000);
  assertEquals(r.status, 'done');

  const after = mem.getStringPointer();
  const grew = after - before;
  if (grew > 256) {
    throw new Error(
      `String table grew by ${grew} bytes over 1000 out-of-range charAt ` +
      `calls; the empty-string result must not allocate (expected ~0 growth)`);
  }
});

Deno.test('repeated slicing produces bounded string-table growth', () => {
  // Without dedup, this would grow the string table by 1000 entries.
  // With dedup, each iteration finds the existing "a" entry and returns
  // its id. The table should grow by a single entry across the loop.
  const session = freshSession();
  const mem = session.airlock.memoryImage;

  session.parse(`let prime = "abc".slice(0, 1)`);  // pre-warm "a" into the table
  session.run(0, 1_000_000);
  const before = mem.getStringPointer();

  const p = session.parse(`
    let i = 0
    while (i < 1000) {
      let _ = "abc".slice(0, 1)
      i = i + 1
    }
  `);
  mem.setContextInstructionIndex(0, p.startIndex);
  const r = session.run(0, 50_000_000);
  assertEquals(r.status, 'done');

  const after = mem.getStringPointer();
  // 1000 iterations, dedup hits should mean roughly-no growth.
  // Allow a few bytes of slack for any unrelated interns the loop does.
  const grew = after - before;
  if (grew > 256) {
    throw new Error(
      `String table grew by ${grew} bytes over 1000 slice calls; ` +
      `dedup must be broken (expected ~0 growth)`);
  }
});

Deno.test('string methods under pressure yield then gc-and-retry completes', () => {
  // Fill the string table near capacity via concat, then call .repeat
  // which would otherwise have bump-allocated past the boundary.
  // With the chokepoint refactor + the BOUND_METHOD string-receiver
  // gc fix, the full yield → gc → retry → done cycle works.
  const session = freshSession();
  session.parse(`
    let pad = "p"
    let i = 0
    while (i < 600) { pad = pad + "p"; i = i + 1 }
    let big = pad.repeat(100)
    let len = big.length
  `);

  let result;
  try {
    result = session.run(0, 100_000_000);
  } catch (e) {
    throw new Error(`Expected yield, got WASM trap: ${e.message}`);
  }
  while (result.status === 'memory_pressure') {
    session.gc();
    result = session.run(0, 100_000_000);
  }
  assertEquals(result.status, 'done');
  assertEquals(session.get(0, 'len'), 601 * 100);
});

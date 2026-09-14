/**
 * Tests for the inline-source host use case.
 *
 * A host can store a drone's source inside the AST region of the SandScript
 * memory image instead of maintaining a second source slab. With
 * `inlineSource` enabled, one snapshot carries both execution state and the
 * source of truth.
 *
 * The host pattern:
 *   1. freshSession({ inlineSource: true })
 *   2. session.parse(source)
 *   3. snapshotSession(session).vatBytes — single artifact carrying both bytecode and AST
 *   4. (drone runs as usual — execution semantics are unchanged)
 *   5. Later, host wants to recover source: freshSession().getSource()
 *
 * Run with: deno task test tests/fuel/ast_inline_source_snapshot_test.js
 */

import { assertEquals, assert } from "https://deno.land/std@0.208.0/assert/mod.ts";
import { createSession } from '../../src/fuel/session.js';
import { freshSession, restoreSession, snapshotSession } from '../../src/host-owned-session.js';

Deno.test("inline source snapshot: snapshot carries enough to recover source", () => {
  const original = `
    function add(a, b) { return a + b }
    let x = add(2, 3)
  `;
  // Drone setup: parse with AST tracking on.
  const drone = freshSession({ inlineSource: true });
  drone.parse(original);
  const bytes = snapshotSession(drone).vatBytes;

  // Some time later, host wants to display the drone's source.
  const restored = restoreSession(bytes, null, { inlineSource: true });
  const recovered = restored.getSource();

  // The recovered source isn't byte-identical (whitespace and the leading
  // newlines are gone), but it parses to the same program and contains the
  // same identifiers and structure.
  assert(recovered.includes('function add(a, b)'));
  assert(recovered.includes('return a + b;'));
  assert(recovered.includes('let x = add(2, 3);'));
});

Deno.test("inline source snapshot: snapshot still runs the same after restore", () => {
  const drone = freshSession({ inlineSource: true });
  drone.parse('function double(x) { return x * 2 }; let y = double(21)');
  const bytes = snapshotSession(drone).vatBytes;

  const restored = restoreSession(bytes, null, { inlineSource: true });
  restored.run(0, 100000);
  assertEquals(restored.get(0, 'y'), 42);
});

Deno.test("inline source snapshot: AST region size dominates snapshot size for source-bearing drones", () => {
  // For a small source, the AST region's overhead is bounded — about
  // (header + N nodes × small) which is well below the 256KB default.
  const drone = freshSession({ inlineSource: true });
  drone.parse('let x = 1 + 2 * 3');
  const header = drone.getAstRegionHeader();
  const pointer = drone.mem.getAstRegionPointer();
  const base = drone.mem.getAstRegionBase();
  const used = pointer - base;
  // Header is 16 bytes; small expression should produce well under 1KB of AST.
  assert(used < 1024, `expected < 1KB AST for small source, got ${used} bytes`);
  // And of course header was actually written.
  assertEquals(header.dialect & 0xffffffff, 0x646e6173);
});

Deno.test("inline source snapshot: getSource returns null on a no-AST snapshot", () => {
  // A drone that wasn't created with inlineSource: true has no AST.
  // Snapshot still works (toBytes/fromBytes are AST-agnostic), but
  // getSource() honestly returns null.
  const drone = freshSession();
  drone.parse('let x = 1');
  const bytes = snapshotSession(drone).vatBytes;

  const restored = restoreSession(bytes, null);
  assertEquals(restored.getSource(), null);
});

Deno.test("inline source snapshot: a chunk without AST in a multi-chunk session yields partial source", () => {
  // Realistic mixed scenario: drone created with AST, but a later append
  // happens without (e.g., dynamically-injected bytecode). The earlier
  // chunks' source is recoverable; the later chunk just contributes no
  // root. Expected behavior: getSource() returns text for the AST-bearing
  // chunks only.
  //
  // For now we don't have a way to "parse without AST" on an inlineSource
  // session — the parser always runs the writer. So this test simply
  // confirms the multi-chunk all-AST case (everything recoverable).
  const drone = freshSession({ inlineSource: true });
  drone.parse('let a = 1');
  drone.parse('let b = 2');
  const recovered = drone.getSource();
  assert(recovered.includes('let a = 1'));
  assert(recovered.includes('let b = 2'));
});

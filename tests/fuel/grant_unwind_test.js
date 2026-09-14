/**
 * Grant-stack unwind hygiene (layout v12).
 *
 * Before v12, only GRANT_END ever popped the grant stack: EVERY abrupt
 * exit from a `grant {}` block — break, continue, return, throw —
 * leaked the entry, silently retaining its authorization for the rest
 * of the context (and `continue` accumulated one entry per iteration).
 *
 * v12 closes the family with three cooperating mechanisms:
 *   - every try entry snapshots the grant depth at its push; handler
 *     entry and every entry pop clamp the grant stack back to it,
 *   - the RETURN walk trims the departing frame's grant entries,
 *   - break/continue emit static GRANT_ENDs (plus a post-unwind
 *     trampoline) for the grants the runtime clamps can't see.
 *
 * The interleaving contract: a finally INSIDE a grant block still runs
 * with the grant active; a finally OUTSIDE it observes the grant
 * already released.
 */

import { assertEquals } from "https://deno.land/std@0.208.0/assert/mod.ts";
import { parseAndSetup } from './test-helpers.js';
import { freshSession } from '../../src/host-owned-session.js';

function grantSession() {
  const session = freshSession();
  const { airlock } = session;
  const handle = airlock.register({});
  const calls = [];
  airlock.setHandler(handle, 'ping', ({ args }) => {
    calls.push(args[0] ?? null);
    return 1;
  });
  airlock.declare('Cap', handle);
  // One long-lived grant per identifier (the standard capability
  // pattern), NOT a fresh createGrant per approval. The mid-approval
  // reap that once made the per-approval pattern hazardous is fixed
  // (approval window — see tests/fuel/grant_midapproval_reap_test.js);
  // the long-lived pattern simply keeps membrane churn out of what
  // these tests pin.
  const grants = new Map();
  airlock.onGrantRequest = (identifier) => {
    let grant = grants.get(identifier);
    if (!grant) {
      grant = airlock.membrane.createGrant(identifier);
      grant.add(handle);
      grants.set(identifier, grant);
    }
    return { approved: true, grant };
  };
  return { session, calls };
}

function run(session, source) {
  parseAndSetup(session, source);
  const result = session.run(0, 1_000_000);
  if (result.status === 'error') {
    throw new Error(result.error.message);
  }
  return result;
}

// =============================================================================
// Depth hygiene: every abrupt exit unwinds the grant stack to zero
// =============================================================================

Deno.test("grant unwind: break, continue, return, throw all release the entry", () => {
  const { session } = grantSession();
  run(session, `
    while (true) { grant "cap" { break; } }
    for (let i = 0; i < 3; i = i + 1) { grant "cap" { continue; } }
    function viaReturn() { grant "cap" { return 1; } }
    viaReturn();
    try { grant "cap" { throw "x"; } } catch (e) {}
    function viaThrow() { grant "cap" { throw "y"; } }
    try { viaThrow(); } catch (e) {}
  `);
  assertEquals(session.memoryImage.getGrantDepth(0), 0);
});

Deno.test("grant unwind: nested and multi-identifier grants release fully", () => {
  const { session } = grantSession();
  run(session, `
    while (true) {
      grant "a" {
        grant ("b", "c") { break; }
      }
    }
  `);
  assertEquals(session.memoryImage.getGrantDepth(0), 0);
});

Deno.test("grant unwind: continue does not accumulate entries across iterations", () => {
  const { session } = grantSession();
  run(session, `
    for (let i = 0; i < 200; i = i + 1) {
      grant "cap" { continue; }
    }
  `);
  assertEquals(session.memoryImage.getGrantDepth(0), 0);
});

// =============================================================================
// Authorization actually drops
// =============================================================================

Deno.test("grant unwind: authorization is gone after break leaks would have kept it", () => {
  const { session, calls } = grantSession();
  run(session, `
    while (true) { grant "cap" { Cap.ping("inside"); break; } }
    let after = "";
    try { Cap.ping("outside"); after = "allowed"; }
    catch (e) { after = "denied"; }
  `);
  assertEquals(session.get(0, 'after'), 'denied');
  assertEquals(calls, ['inside']);
});

Deno.test("grant unwind: authorization is gone after return out of a grant", () => {
  const { session, calls } = grantSession();
  run(session, `
    function f() { grant "cap" { return Cap.ping("in-fn"); } }
    f();
    let after = "";
    try { Cap.ping("outside"); after = "allowed"; }
    catch (e) { after = "denied"; }
  `);
  assertEquals(session.get(0, 'after'), 'denied');
  assertEquals(calls, ['in-fn']);
});

// =============================================================================
// Interleaving: finallys observe the grant state of their own position
// =============================================================================

Deno.test("grant unwind: finally INSIDE the grant runs with the grant active on break", () => {
  const { session } = grantSession();
  run(session, `
    let log = "";
    while (true) {
      grant "cap" {
        try { break; }
        finally {
          try { Cap.ping("cleanup"); log = "allowed"; }
          catch (e) { log = "denied"; }
        }
      }
    }
  `);
  assertEquals(session.get(0, 'log'), 'allowed');
  assertEquals(session.memoryImage.getGrantDepth(0), 0);
});

Deno.test("grant unwind: finally OUTSIDE the grant sees it already released on break", () => {
  const { session } = grantSession();
  run(session, `
    let log = "";
    while (true) {
      try {
        grant "cap" { break; }
      } finally {
        try { Cap.ping("late"); log = "allowed"; }
        catch (e) { log = "denied"; }
      }
    }
  `);
  assertEquals(session.get(0, 'log'), 'denied');
  assertEquals(session.memoryImage.getGrantDepth(0), 0);
});

Deno.test("grant unwind: finally INSIDE the grant runs with the grant active on return", () => {
  const { session } = grantSession();
  run(session, `
    let log = "";
    function f() {
      grant "cap" {
        try { return 1; }
        finally {
          try { Cap.ping("cleanup"); log = "allowed"; }
          catch (e) { log = "denied"; }
        }
      }
    }
    f();
  `);
  assertEquals(session.get(0, 'log'), 'allowed');
  assertEquals(session.memoryImage.getGrantDepth(0), 0);
});

Deno.test("grant unwind: same-frame catch outside the grant sees it released", () => {
  const { session } = grantSession();
  run(session, `
    let log = "";
    try {
      grant "cap" { throw "boom"; }
    } catch (e) {
      try { Cap.ping("in-catch"); log = "allowed"; }
      catch (err) { log = "denied"; }
    }
  `);
  assertEquals(session.get(0, 'log'), 'denied');
  assertEquals(session.memoryImage.getGrantDepth(0), 0);
});

Deno.test("grant unwind: catch INSIDE the grant keeps the grant active", () => {
  const { session } = grantSession();
  run(session, `
    let log = "";
    grant "cap" {
      try { throw "boom"; }
      catch (e) {
        try { Cap.ping("in-catch"); log = "allowed"; }
        catch (err) { log = "denied"; }
      }
    }
  `);
  assertEquals(session.get(0, 'log'), 'allowed');
  assertEquals(session.memoryImage.getGrantDepth(0), 0);
});

// =============================================================================
// Frame-boundary trims
// =============================================================================

Deno.test("grant unwind: return out of a grant inside a map callback trims the frame", () => {
  const { session } = grantSession();
  run(session, `
    let out = [1, 2, 3].map(function (x) {
      grant "cap" { return x * 10; }
    });
    let r = out.join(",");
  `);
  assertEquals(session.get(0, 'r'), '10,20,30');
  assertEquals(session.memoryImage.getGrantDepth(0), 0);
});

Deno.test("grant unwind: throw across a frame into an outer catch releases callee grants", () => {
  const { session } = grantSession();
  run(session, `
    function inner() { grant "cap" { throw "deep"; } }
    function outer() { grant "cap" { inner(); } }
    let log = "";
    try { outer(); }
    catch (e) {
      try { Cap.ping("post"); log = "allowed"; }
      catch (err) { log = "denied"; }
    }
  `);
  assertEquals(session.get(0, 'log'), 'denied');
  assertEquals(session.memoryImage.getGrantDepth(0), 0);
});

// =============================================================================
// Normal flow is unchanged
// =============================================================================

Deno.test("grant unwind: balanced grant blocks still authorize normally", () => {
  const { session, calls } = grantSession();
  run(session, `
    grant "cap" { Cap.ping("one"); }
    grant "cap" {
      grant "cap" { Cap.ping("two"); }
      Cap.ping("three");
    }
  `);
  assertEquals(calls, ['one', 'two', 'three']);
  assertEquals(session.memoryImage.getGrantDepth(0), 0);
});

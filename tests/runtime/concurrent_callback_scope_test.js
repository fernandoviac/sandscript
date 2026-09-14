/**
 * Four cases pin captured-scope integrity under host-driven concurrency:
 * synchronous fan-out, suspended asynchronous fan-out, recursion-driven stack
 * growth, and interleaved sibling closures sharing one parent scope. Every
 * invocation must retain its bindings without an out-of-bounds access or stale
 * scope pointer.
 */

import { RuntimeBuilder } from '../../src/runtime/test-harness.js';
import { assertEquals } from "https://deno.land/std@0.208.0/assert/mod.ts";

function tick(ms = 0) { return new Promise(r => setTimeout(r, ms)); }

async function waitFor(condition, { timeout = 2000, label = 'condition' } = {}) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    if (condition()) return;
    await tick(2);
  }
  throw new Error(`waitFor timed out: ${label}`);
}

// Shared cap helper — matches invoke_closure_test's pattern (real grant via
// membrane.createGrant + Cap declared by name; without this, grant blocks are
// revoked the instant they exit and closures captured inside are unusable).
function makeCap(handlers) {
  return {
    name: 'cap', needs: {},
    setup(airlock) {
      const h = airlock.register({});
      for (const [name, fn] of Object.entries(handlers)) {
        airlock.setHandler(h, name, fn);
      }
      airlock.setHandler(h, 'defer',
        ({ args }) => new Promise(r => setTimeout(() => r(args[0]), 1)));
      const grant = airlock.membrane.createGrant('cap');
      grant.add(h);
      airlock.declare('Cap', h);
      return { onGrantRequest: (id) => id === 'cap' ? grant : null };
    },
  };
}

async function buildAndBoot(droneSource, handlers) {
  const cap = makeCap(handlers);
  const { runtime, session } = new RuntimeBuilder()
    .onInboundMessage(() => {})
    .onHandlerError((e) => console.error('[handler error]', e.message))
    .capability(cap).build();
  await runtime.start();
  const r = session.parse(droneSource);
  session.setInstruction(0, r.startIndex);
  // The Runtime fanout wrapper's onGrantRequest is always async, so
  // runtime.run(0) suspends immediately after GRANT_START instead of running
  // the registration body within the same drive episode.
  await runtime.run(0);
  await waitFor(() => session.state(0).exitCondition === 'done',
    { label: 'grant body registration to run' });
  return { runtime, session };
}

// =========================================================================
// (1) 50 concurrent SYNC invokes sharing a captured `{}`.
// =========================================================================
Deno.test("repro #1: 50 concurrent sync invokes share captured var (PASSES)", async () => {
  let theClosure = null;
  const { runtime } = await buildAndBoot(`
    grant "cap" {
      let shared = {};
      shared["c"] = 0;
      Cap.reg(function(key) {
        shared[key] = (shared[key] || 0) + 1;
        return shared[key];
      })
    }
  `, { reg: ({ args }) => { theClosure = args[0]; return 0; } });

  const N = 50;
  const results = await Promise.all(Array.from({ length: N }, () =>
    runtime.invokeClosure(theClosure, ["c"]).then(v => ({ v, ok: true }),
                                                   e => ({ err: e.message, ok: false }))));
  assertEquals(results.filter(r => !r.ok).length, 0);
  await runtime.terminate();
});

// =========================================================================
// (2) 50 concurrent ASYNC closures, each reads-awaits-writes the shared var.
//     Interleaving via `await Cap.defer(...)`.
// =========================================================================
Deno.test("repro #2: 50 concurrent async invokes with interleaving (PASSES)", async () => {
  let theClosure = null;
  const { runtime } = await buildAndBoot(`
    grant "cap" {
      let pendingResponses = {};
      pendingResponses["seed"] = 0;
      Cap.reg(async function(key) {
        let before = pendingResponses[key];
        let dummy = await Cap.defer(key);
        pendingResponses[key] = (before || 0) + 1;
        return pendingResponses[key];
      })
    }
  `, { reg: ({ args }) => { theClosure = args[0]; return 0; } });

  const N = 50;
  const results = await Promise.all(Array.from({ length: N }, () =>
    runtime.invokeClosure(theClosure, ["seed"]).then(v => ({ ok: true }),
                                                     e => ({ err: e.message, ok: false }))));
  assertEquals(results.filter(r => !r.ok).length, 0);
  await runtime.terminate();
});

// =========================================================================
// (3) Closure with recursion to FORCE call-stack growth past the initial
//     8-frame block, reading the captured var AFTER the await (the precise
//     moment when a stale scope pointer would manifest).
// =========================================================================
Deno.test("repro #3: 100 concurrent async + recursion forces stack growth (PASSES)", async () => {
  let theClosure = null;
  const { runtime } = await buildAndBoot(`
    grant "cap" {
      let pendingResponses = {};
      Cap.reg(async function(key) {
        let v = pendingResponses[key] || 0;
        // Recursion to force the call stack past its initial ~8 frames.
        let rec = (n) => n < 1 ? 0 : 1 + rec(n - 1);
        v = v + rec(20);
        let d = await Cap.defer(key);
        // Read captured var AGAIN after the await — would catch a stale
        // scope pointer that survived a grow + relocation.
        let after = pendingResponses[key];
        pendingResponses[key] = (after || 0) + 1;
        return pendingResponses[key];
      })
    }
  `, { reg: ({ args }) => { theClosure = args[0]; return 0; } });

  const N = 100;
  const results = await Promise.all(Array.from({ length: N }, () =>
    runtime.invokeClosure(theClosure, ["seed"]).then(v => ({ ok: true }),
                                                     e => ({ err: e.message, ok: false }))));
  assertEquals(results.filter(r => !r.ok).length, 0);
  await runtime.terminate();
});

// =========================================================================
// (4) Three DISTINCT closures (A/B/C) all capturing the same parent scope,
//     fired interleaved — closest pure-SS analogue to the gate's
//     message + request + timeout callbacks sharing `pendingResponses`.
// =========================================================================
Deno.test("repro #4: three distinct closures share captured scope, fired interleaved (PASSES)", async () => {
  const closures = {};
  const { runtime } = await buildAndBoot(`
    grant "cap" {
      let pendingResponses = {};
      let counter = 0;
      Cap.regA(async function(id) {
        pendingResponses[id] = "A";
        let v = await Cap.defer(id);
        return pendingResponses[id];
      });
      Cap.regB(async function(id) {
        pendingResponses[id] = "B";
        let v = await Cap.defer(id);
        counter = counter + 1;
        return counter;
      });
      Cap.regC(async function(id) {
        let r = pendingResponses[id] || "miss";
        let v = await Cap.defer(id);
        return r;
      });
    }
  `, {
    regA: ({ args }) => { closures.A = args[0]; return 0; },
    regB: ({ args }) => { closures.B = args[0]; return 0; },
    regC: ({ args }) => { closures.C = args[0]; return 0; },
  });

  const N = 30;
  const promises = [];
  for (let i = 0; i < N; i++) {
    promises.push(runtime.invokeClosure(closures.A, [`id${i}`]).catch(e => ({ err: e.message })));
    promises.push(runtime.invokeClosure(closures.B, [`id${i}`]).catch(e => ({ err: e.message })));
    promises.push(runtime.invokeClosure(closures.C, [`id${i}`]).catch(e => ({ err: e.message })));
  }
  const results = await Promise.all(promises);
  assertEquals(results.filter(r => r && r.err).length, 0);
  await runtime.terminate();
});

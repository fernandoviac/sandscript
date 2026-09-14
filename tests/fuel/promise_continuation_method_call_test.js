/**
 * OP_CALL_METHOD on a Promise executor continuation.
 *
 * A request table stores each Promise executor's resolve function in an entry
 * (`pendingResponses[id] = { resolve, deadline }`), then a later event calls it
 * in method form: `waiter.resolve(value)`. Plain-call form (`resolve(value)`)
 * already worked because OP_CALL recognizes TYPE_PROMISE_RESOLVE and
 * TYPE_PROMISE_REJECT. OP_CALL_METHOD lacked those branches, so method form
 * threw "Not a function (received promise resolve)". These tests pin that
 * method-call dispatch.
 *
 * NOTE: the spread forms (OP_CALL_SPREAD / OP_CALL_METHOD_SPREAD) still have
 * no continuation branch — `resolve(...args)` fails loudly with the same
 * typed NOT_A_FUNCTION diagnostic. Left unfixed deliberately (no real-world
 * shape yet); this comment is the breadcrumb.
 */

import { assertEquals } from "https://deno.land/std@0.208.0/assert/mod.ts";
import { parseAndSetup } from './test-helpers.js';
import {
  EXIT_DONE,
  EXIT_ERROR,
  EXIT_AWAIT,
  EXIT_ASYNC_COMPLETE,
  EXIT_ASYNC_REJECTED,
} from '../../src/fuel/constants.js';
import { freshSession } from '../../src/host-owned-session.js';

// Same completion driver as promise_then_test.js — session.run settles
// promise_settle internally; spawned .then/waiter contexts come back under
// status 'promise_method' and are scheduled here.
function runToCompletion(session) {
  const mem = session.memoryImage;
  const airlock = session.airlock;
  const contexts = [{ slot: 0, generation: session.memoryImage.getContextGeneration(0) }]

  for (let iter = 0; iter < 1000; iter++) {
    let contextToRun = null;

    for (const ctx of contexts) {
      const exitCondition = mem.getExitCondition(ctx.slot);
      if (exitCondition === EXIT_DONE || exitCondition === EXIT_ERROR ||
          exitCondition === EXIT_ASYNC_COMPLETE || exitCondition === EXIT_ASYNC_REJECTED) {
        continue;
      }
      if (exitCondition === EXIT_AWAIT) {
        continue;
      }
      contextToRun = ctx;
      break;
    }

    if (!contextToRun) break;

    const result = session.run(contextToRun, 100);

    if (result.status === 'async_call' && result.asyncContext !== undefined) {
      contexts.push(result.asyncContext);
    }

    if (result.status === 'await') {
      airlock.handleAwait(contextToRun.slot);
    }

    if (result.status === 'async_complete') {
      const { waiters } = airlock.handleAsyncComplete(contextToRun.slot);
      for (const w of waiters) {
        if (!contexts.find(c => c.slot === w.slot && c.generation === w.generation)) {
          contexts.push(w);
        }
      }
    }

    if (result.status === 'async_rejected') {
      const { waiters } = airlock.handleAsyncRejected(contextToRun.slot);
      for (const w of waiters) {
        if (!contexts.find(c => c.slot === w.slot && c.generation === w.generation)) {
          contexts.push(w);
        }
      }
    }

    if (result.status === 'promise_method') {
      if (result.contexts) {
        for (const ctx of result.contexts) {
          if (!contexts.find(c => c.slot === ctx.slot && c.generation === ctx.generation)) {
            contexts.push(ctx);
          }
        }
      }
    }
  }
}

function runAndGet(source, varName) {
  const session = freshSession();
  parseAndSetup(session, source);
  runToCompletion(session);
  return session.get(0, varName);
}

// The executor is a SPAWNED context (not run synchronously at construction),
// so the shape needs three actors, like the live gate: the top level
// constructs the promise (executor stores the continuation into a shared
// object), one async context awaits it, another later METHOD-CALLS the
// stored continuation. runToCompletion schedules them in creation order:
// executor first (stores resolve), then the awaiter (suspends), then the
// settler (the OP_CALL_METHOD under test).

Deno.test("continuation method call: resolve stored on an object, called as holder.resolve(v)", () => {
  const result = runAndGet(`
    let holder = {}
    let x
    let thePromise = new Promise((resolve) => { holder.resolve = resolve })
    async function awaiter() {
      x = await thePromise
    }
    async function settler() {
      holder.resolve(42)
    }
    awaiter()
    settler()
  `, 'x');
  assertEquals(result, 42);
});

Deno.test("continuation method call: reject stored on an object, called as holder.reject(reason)", () => {
  const result = runAndGet(`
    let holder = {}
    let x = "unset"
    let thePromise = new Promise((resolve, reject) => { holder.reject = reject })
    async function awaiter() {
      try {
        await thePromise
      } catch (error) {
        x = error
      }
    }
    async function settler() {
      holder.reject("nope")
    }
    awaiter()
    settler()
  `, 'x');
  assertEquals(result, "nope");
});

Deno.test("continuation method call: the gate shape — fold entry {resolve, deadline}, object argument, stack intact after", () => {
  // Mirrors console-gate.drone: the entry holds MORE than the resolve (the
  // deadline), the argument is an object, and code KEEPS RUNNING after the
  // method call — under default strict-stack any operand imbalance traps.
  const session = freshSession();
  parseAndSetup(session, `
    let pendingResponses = {}
    let outcome
    let value
    let deadlineStillThere
    let afterCall
    let thePromise = new Promise((resolve) => {
      pendingResponses["r1"] = { resolve: resolve, deadline: 12345 }
    })
    async function awaiter() {
      let settled = await thePromise
      outcome = settled.outcome
      value = settled.value
    }
    async function settler() {
      let waiter = pendingResponses["r1"]
      waiter.resolve({ outcome: "ok", value: 7 })
      deadlineStillThere = waiter.deadline
      afterCall = "ran"
    }
    awaiter()
    settler()
  `);
  runToCompletion(session);
  assertEquals(session.get(0, 'outcome'), "ok");
  assertEquals(session.get(0, 'value'), 7);
  assertEquals(session.get(0, 'deadlineStillThere'), 12345);
  assertEquals(session.get(0, 'afterCall'), "ran");
});

Deno.test("continuation method call: stored resolve survives heap compaction", () => {
  const session = freshSession();
  parseAndSetup(session, `
    let holder = {}
    let settled
    let thePromise = new Promise((resolve) => {
      holder.resolve = resolve
    })
    async function awaiter() {
      settled = await thePromise
    }
    awaiter()
  `);
  runToCompletion(session);
  session.gc();
  parseAndSetup(session, "holder.resolve(42)");
  runToCompletion(session);
  assertEquals(session.get(0, "settled"), 42);
});

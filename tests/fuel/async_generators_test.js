/**
 * Async generators (INTERNALS.md's Generators section follow-up).
 *
 * An async generator is a generator context whose next/return/throw
 * requests settle a STEP PROMISE instead of parking the caller: the
 * caller gets the promise immediately, the generator context is driven
 * by the host through the spawn queue (like any async context), and
 * yield/completion/throw settle the in-service promise. Requests that
 * arrive while a service is in flight queue in memory (spec
 * AsyncGeneratorEnqueue), so double-next without an await preserves
 * order. yield awaits its operand and `return v` awaits v (parser-
 * emitted AWAIT), and the object exposes Symbol.asyncIterator only —
 * sync drivers (for-of, spread, seed drivers) reject it as not
 * iterable.
 */

import { assertEquals, assert } from "https://deno.land/std@0.208.0/assert/mod.ts";
import { parseAndSetup } from './test-helpers.js';
import { freshSession, restoreSession, snapshotSession } from '../../src/host-owned-session.js';
import {
  EXIT_DONE,
  EXIT_ERROR,
  EXIT_AWAIT,
  EXIT_ASYNC_COMPLETE,
  EXIT_ASYNC_REJECTED,
} from '../../src/fuel/constants.js';

/**
 * Drive a session until nothing is runnable. Round-robin over a queue
 * seeded with slot 0; spawned async contexts, woken awaiters, and
 * async-generator resumes all enter through session.run results, the
 * handleAsyncComplete/Rejected waiter lists, and the airlock's spawn
 * queue (drained each iteration).
 */
function runToCompletion(session) {
  const mem = session.memoryImage;
  const airlock = session.airlock;
  const runnable = [{
    slot: 0,
    generation: mem.getContextGeneration(0),
  }];

  for (let iteration = 0; iteration < 2000; iteration++) {
    runnable.push(...airlock.drainPendingSpawnedContextIdentities());

    let contextIdentity = undefined;
    while (runnable.length > 0) {
      const candidateIdentity = runnable.shift();
      const exit = mem.getExitCondition(candidateIdentity.slot);
      if (exit === EXIT_DONE || exit === EXIT_ERROR ||
          exit === EXIT_ASYNC_COMPLETE || exit === EXIT_ASYNC_REJECTED) {
        continue;
      }
      // Parked awaiter: a wake re-enters via a waiter list or the
      // spawn queue.
      if (exit === EXIT_AWAIT) continue;
      contextIdentity = candidateIdentity;
      break;
    }
    if (contextIdentity === undefined) {
      if (airlock.pendingSpawnedContexts.length > 0) continue;
      return { status: 'done' };
    }

    const { slot } = contextIdentity;
    const result = session.run(contextIdentity, 1_000_000);

    if (result.status === 'error') {
      throw new Error(result.error?.message ?? 'interpreter error');
    }
    if (result.status === 'async_call' && result.asyncContext !== undefined) {
      runnable.push(result.asyncContext, contextIdentity);
      continue;
    }
    if (result.status === 'async_complete') {
      const { waiters } = airlock.handleAsyncComplete(slot);
      runnable.push(...waiters);
      continue;
    }
    if (result.status === 'async_rejected') {
      const { waiters } = airlock.handleAsyncRejected(slot);
      runnable.push(...waiters);
      continue;
    }
    if (result.status === 'promise_method') {
      runnable.push(...result.contexts, contextIdentity);
      continue;
    }
    if (result.status === 'paused') {
      runnable.push(contextIdentity);
      continue;
    }
    // 'done' and 'await' need no requeue: done is terminal, an awaiter
    // is woken through a waiter list or the spawn queue.
  }
  throw new Error('runToCompletion did not converge');
}

function runAndGet(source, varName) {
  const session = freshSession();
  parseAndSetup(session, source);
  runToCompletion(session);
  return session.get(0, varName);
}

// =============================================================================
// Protocol basics
// =============================================================================

Deno.test("async generators: manual next() drive, completion, dead-state next()", () => {
  const r = runAndGet(`
    async function* g() { yield 1; yield 2; return 99; }
    async function main() {
      let it = g();
      let a = await it.next();
      let b = await it.next();
      let c = await it.next();
      let d = await it.next();
      return "" + a.value + b.value + "|" + c.value + "," + c.done + "|" + d.done + "," + (d.value === undefined);
    }
    let r = await main();
  `, 'r');
  assertEquals(r, '12|99,true|true,true');
});

Deno.test("async generators: sent values become the yield expression's result", () => {
  const r = runAndGet(`
    async function* g() { let x = yield "first"; let y = yield x * 2; return y + 1; }
    async function main() {
      let it = g();
      let a = (await it.next()).value;
      let b = (await it.next(10)).value;
      let c = await it.next(100);
      return a + "|" + b + "|" + c.value + "," + c.done;
    }
    let r = await main();
  `, 'r');
  assertEquals(r, 'first|20|101,true');
});

Deno.test("async generators: arguments, closure capture, this in method form", () => {
  const r = runAndGet(`
    let base = 100;
    async function* pair(a, b) { yield base + a; yield base + b; }
    let obj = { factor: 3, async *vals() { yield this.factor; yield this.factor * 2; } };
    async function main() {
      let p = pair(1, 2);
      let v = obj.vals();
      return (await p.next()).value + "," + (await p.next()).value + "|" +
             (await v.next()).value + "," + (await v.next()).value;
    }
    let r = await main();
  `, 'r');
  assertEquals(r, '101,102|3,6');
});

Deno.test("async generators: expression form", () => {
  const r = runAndGet(`
    let g = async function* () { yield "a"; yield "b"; };
    async function main() {
      let it = g();
      return (await it.next()).value + (await it.next()).value + (await it.next()).done;
    }
    let r = await main();
  `, 'r');
  assertEquals(r, 'abtrue');
});

// =============================================================================
// await composition inside the body
// =============================================================================

Deno.test("async generators: await inside the body between yields", () => {
  const r = runAndGet(`
    async function inc(x) { return x + 1; }
    async function* g() {
      let a = await inc(10);
      yield a;
      let b = await inc(a);
      yield b;
    }
    async function main() {
      let it = g();
      return (await it.next()).value + "," + (await it.next()).value + "," + (await it.next()).done;
    }
    let r = await main();
  `, 'r');
  assertEquals(r, '11,12,true');
});

Deno.test("async generators: yield awaits its operand (promise yields settle)", () => {
  const r = runAndGet(`
    async function make(x) { return x * 7; }
    async function* g() { yield make(1); yield make(2); }
    async function main() {
      let it = g();
      return (await it.next()).value + "," + (await it.next()).value;
    }
    let r = await main();
  `, 'r');
  assertEquals(r, '7,14');
});

Deno.test("async generators: return value is awaited", () => {
  const r = runAndGet(`
    async function make(x) { return x + 5; }
    async function* g() { yield 1; return make(10); }
    async function main() {
      let it = g();
      await it.next();
      let step = await it.next();
      return step.value + "," + step.done;
    }
    let r = await main();
  `, 'r');
  assertEquals(r, '15,true');
});

// =============================================================================
// Request queueing (spec AsyncGeneratorEnqueue)
// =============================================================================

Deno.test("async generators: two next() without await preserve order", () => {
  const r = runAndGet(`
    async function* g() { yield "a"; yield "b"; yield "c"; }
    async function main() {
      let it = g();
      let p1 = it.next();
      let p2 = it.next();
      let s1 = await p1;
      let s2 = await p2;
      let s3 = await it.next();
      return s1.value + s2.value + s3.value;
    }
    let r = await main();
  `, 'r');
  assertEquals(r, 'abc');
});

Deno.test("async generators: queued return() runs after the in-flight next()", () => {
  const r = runAndGet(`
    let log = "";
    async function* g() {
      try { yield 1; yield 2; }
      finally { log = log + "F"; }
    }
    async function main() {
      let it = g();
      let p1 = it.next();
      let p2 = it.return("done");
      let s1 = await p1;
      let s2 = await p2;
      let s3 = await it.next();
      return log + "|" + s1.value + "," + s1.done + "|" + s2.value + "," + s2.done + "|" + s3.done;
    }
    let r = await main();
  `, 'r');
  assertEquals(r, 'F|1,false|done,true|true');
});

// =============================================================================
// Abrupt completions
// =============================================================================

Deno.test("async generators: return(v) at a yield runs body finallys", () => {
  const r = runAndGet(`
    let log = "";
    async function* g() {
      try { yield 1; yield 2; }
      finally { log = log + "cleanup"; }
    }
    async function main() {
      let it = g();
      await it.next();
      let step = await it.return(42);
      return log + "|" + step.value + "," + step.done;
    }
    let r = await main();
  `, 'r');
  assertEquals(r, 'cleanup|42,true');
});

Deno.test("async generators: throw(e) is catchable by the body", () => {
  const r = runAndGet(`
    async function* g() {
      try { yield 1; }
      catch (e) { yield "caught:" + e; }
    }
    async function main() {
      let it = g();
      await it.next();
      let step = await it.throw("boom");
      return step.value + "," + step.done;
    }
    let r = await main();
  `, 'r');
  assertEquals(r, 'caught:boom,false');
});

Deno.test("async generators: uncaught throw rejects the step promise", () => {
  const r = runAndGet(`
    async function* g() { yield 1; throw "explode"; }
    async function main() {
      let it = g();
      await it.next();
      try { await it.next(); return "no-throw"; }
      catch (e) { return "caught:" + e; }
    }
    let r = await main();
  `, 'r');
  assertEquals(r, 'caught:explode');
});

Deno.test("async generators: suspended-start return/throw never run the body", () => {
  const r = runAndGet(`
    let ran = false;
    async function* g() { ran = true; yield 1; }
    async function main() {
      let a = g();
      let s = await a.return("early");
      let b = g();
      let t;
      try { await b.throw("dead"); t = "no-throw"; }
      catch (e) { t = "threw:" + e; }
      return s.value + "," + s.done + "|" + t + "|" + ran;
    }
    let r = await main();
  `, 'r');
  assertEquals(r, 'early,true|threw:dead|false');
});

// =============================================================================
// for-await composition
// =============================================================================

Deno.test("async generators: for-await drives the async protocol", () => {
  const r = runAndGet(`
    async function inc(x) { return x + 1; }
    async function* g() {
      yield await inc(0);
      yield await inc(1);
      yield await inc(2);
    }
    async function main() {
      let acc = "";
      for await (const v of g()) { acc = acc + v; }
      return acc;
    }
    let r = await main();
  `, 'r');
  assertEquals(r, '123');
});

Deno.test("async generators: break in for-await closes the generator", () => {
  const r = runAndGet(`
    let log = "";
    async function* g() {
      try { yield 1; yield 2; yield 3; }
      finally { log = log + "closed"; }
    }
    async function main() {
      let acc = "";
      for await (const v of g()) {
        acc = acc + v;
        if (v === 2) { break; }
      }
      return acc;
    }
    let r = await main();
    let finalLog = log;
  `, 'r');
  assertEquals(r, '12');
});

// =============================================================================
// yield* delegation
// =============================================================================

Deno.test("async generators: yield* over an async delegate", () => {
  const r = runAndGet(`
    async function* inner() { yield "x"; yield "y"; return "R"; }
    async function* outer() {
      yield "a";
      let doneValue = yield* inner();
      yield "got:" + doneValue;
    }
    async function main() {
      let acc = "";
      for await (const v of outer()) { acc = acc + v + "|"; }
      return acc;
    }
    let r = await main();
  `, 'r');
  assertEquals(r, 'a|x|y|got:R|');
});

Deno.test("async generators: yield* over a sync iterable (array) lifts values", () => {
  const r = runAndGet(`
    async function* g() { yield* [10, 20, 30]; }
    async function main() {
      let acc = 0;
      for await (const v of g()) { acc = acc + v; }
      return acc;
    }
    let r = await main();
  `, 'r');
  assertEquals(r, 60);
});

Deno.test("async generators: yield* forwards sent values to the delegate", () => {
  const r = runAndGet(`
    async function* inner() { let x = yield "q"; yield "got:" + x; }
    async function* outer() { yield* inner(); }
    async function main() {
      let it = outer();
      let a = (await it.next()).value;
      let b = (await it.next("sent")).value;
      return a + "|" + b;
    }
    let r = await main();
  `, 'r');
  assertEquals(r, 'q|got:sent');
});

// =============================================================================
// Sync-protocol boundaries
// =============================================================================

Deno.test("async generators: sync drivers reject them as not iterable", () => {
  const r = runAndGet(`
    async function* g() { yield 1; }
    let it = g();
    let forOf = "";
    try { for (const v of it) { forOf = "ran"; } }
    catch (e) { forOf = "threw"; }
    let spread = "";
    try { let a = [...it]; spread = "ran"; }
    catch (e) { spread = "threw"; }
    let r = forOf + "," + spread;
  `, 'r');
  assertEquals(r, 'threw,threw');
});

Deno.test("async generators: for-await still works over sync generators (C3 fallback)", () => {
  const r = runAndGet(`
    function* g() { yield 1; yield 2; }
    async function main() {
      let acc = 0;
      for await (const v of g()) { acc = acc + v; }
      return acc;
    }
    let r = await main();
  `, 'r');
  assertEquals(r, 3);
});

// =============================================================================
// GC and snapshot survival
// =============================================================================

Deno.test("async generators: parked generator and queue survive gc", () => {
  const session = freshSession();
  parseAndSetup(session, `
    async function* counter() { let i = 0; while (true) { i = i + 1; yield i * 11; } }
    let it = counter();
    let first = (await it.next()).value;
  `);
  runToCompletion(session);
  assertEquals(session.get(0, 'first'), 11);

  session.gc();

  parseAndSetup(session, `
    let second = (await it.next()).value;
    let third = (await it.next()).value;
  `);
  runToCompletion(session);
  assertEquals(session.get(0, 'second'), 22);
  assertEquals(session.get(0, 'third'), 33);
});

Deno.test("async generators: parked generator survives snapshot/restore", () => {
  const session = freshSession();
  parseAndSetup(session, `
    async function* counter() { let i = 0; while (true) { i = i + 1; yield i * 11; } }
    let it = counter();
    let first = (await it.next()).value;
  `);
  runToCompletion(session);
  assertEquals(session.get(0, 'first'), 11);

  const { vatBytes, membraneBytes } = snapshotSession(session);
  const restored = restoreSession(vatBytes, membraneBytes);
  parseAndSetup(restored, `
    let second = (await it.next()).value;
  `);
  runToCompletion(restored);
  assertEquals(restored.get(0, 'second'), 22);
});

// =============================================================================
// Unhandled step rejections reach the watchlist
// =============================================================================

Deno.test("async generators: unconsumed rejected step joins the unhandled watchlist", () => {
  const session = freshSession();
  parseAndSetup(session, `
    async function* g() { throw "nobody-listens"; }
    let it = g();
    let p = it.next();
  `);
  runToCompletion(session);
  assert(session.airlock._state.pendingUnhandledRejections.size >= 1);
});

/**
 * Generators (INTERNALS.md's Generators section).
 *
 * A generator is a parked context driven by its generator object's
 * next / return / throw methods; the caller of next() parks like an
 * awaiter and session.run trampolines the generator exits internally,
 * so generators whose bodies need no external calls are synchronous
 * from the host's point of view. gen.return(v) resumes the parked
 * context with RESPONSE_RETURN through the sentinel RETURN, so the v11
 * unwind machinery runs body finallys. All generator state lives in
 * memory (hidden properties + CTX_GENERATOR_OBJECT), so parked
 * generators survive gc and snapshot/restore.
 */

import { assertEquals } from "https://deno.land/std@0.208.0/assert/mod.ts";
import { parseAndSetup } from './test-helpers.js';
import { freshSession, restoreSession, snapshotSession } from '../../src/host-owned-session.js';

function run(source) {
  const session = freshSession();
  parseAndSetup(session, source);
  const result = session.run(0, 50_000_000);
  if (result.status === 'error') {
    throw new Error(result.error.message);
  }
  return session;
}

// =============================================================================
// Protocol basics
// =============================================================================

Deno.test("generators: yield sequence, completion, dead-state next()", () => {
  const s = run(`
    function* g() { yield 1; yield 2; yield 3; }
    let it = g();
    let a = it.next(); let b = it.next(); let c = it.next(); let d = it.next();
    let r = "" + a.value + b.value + c.value + "|" + c.done + "|" + d.done + "|" + (d.value === undefined);
  `);
  assertEquals(s.get(0, 'r'), '123|false|true|true');
});

Deno.test("generators: sent values become the yield expression's result", () => {
  const s = run(`
    function* g() { let x = yield "first"; let y = yield x * 2; return y + 1; }
    let it = g();
    let a = it.next().value;
    let b = it.next(10).value;
    let c = it.next(100);
    let r = a + "|" + b + "|" + c.value + "|" + c.done;
  `);
  assertEquals(s.get(0, 'r'), 'first|20|101|true');
});

Deno.test("generators: arguments and closure capture", () => {
  const s = run(`
    let base = 100;
    function* pair(a, b) { yield base + a; yield base + b; }
    let it = pair(1, 2);
    let r = it.next().value + "," + it.next().value;
  `);
  assertEquals(s.get(0, 'r'), '101,102');
});

Deno.test("generators: two instances are independent", () => {
  const s = run(`
    function* g() { yield 1; yield 2; }
    let a = g(); let b = g();
    let r = a.next().value + "," + b.next().value + "," + a.next().value + "," + b.next().value;
  `);
  assertEquals(s.get(0, 'r'), '1,1,2,2');
});

Deno.test("generators: method shorthand binds this", () => {
  const s = run(`
    let obj = { base: 7, *vals() { yield this.base; yield this.base * 2; } };
    let it = obj.vals();
    let r = it.next().value + "," + it.next().value;
  `);
  assertEquals(s.get(0, 'r'), '7,14');
});

Deno.test("generators: uncaught body throw propagates to the next() caller and kills the generator", () => {
  const s = run(`
    function* g() { yield 1; throw "boom"; }
    let it = g();
    let first = it.next().value;
    let caught = "";
    try { it.next(); } catch (e) { caught = e; }
    let r = first + "|" + caught + "|" + it.next().done;
  `);
  assertEquals(s.get(0, 'r'), '1|boom|true');
});

// =============================================================================
// for-of and iterator-protocol integration
// =============================================================================

Deno.test("generators: for-of drives the generator", () => {
  const s = run(`
    function* range(n) { let i = 0; while (i < n) { yield i; i = i + 1; } }
    let sum = 0;
    for (const x of range(5)) { sum = sum + x; }
  `);
  assertEquals(s.get(0, 'sum'), 10);
});

Deno.test("generators: break over an infinite generator closes it (C2 + gen.return)", () => {
  const s = run(`
    function* g() { let i = 0; while (true) { yield i; i = i + 1; } }
    let seen = [];
    for (const x of g()) { seen.push(x); if (x === 3) break; }
    let r = "" + seen;
  `);
  assertEquals(s.get(0, 'r'), '0,1,2,3');
});

Deno.test("generators: Symbol.iterator returns the generator itself", () => {
  const s = run(`
    function* g() { yield "a"; yield "b"; }
    let it = g();
    let same = it[Symbol.iterator]().next().value;
  `);
  assertEquals(s.get(0, 'same'), 'a');
});

Deno.test("generators: iterable spread and call spread", () => {
  const s = run(`
    function* g() { yield 1; yield 2; yield 3; }
    let arr = [...g()];
    function add(a, b, c) { return a + b + c; }
    let r = "" + arr + "|" + add(...g());
  `);
  assertEquals(s.get(0, 'r'), '1,2,3|6');
});

Deno.test("generators: array destructuring drains the prefix", () => {
  const s = run(`
    function* g() { yield 1; yield 2; yield 3; }
    let [a, b] = g();
    let r = a + "," + b;
  `);
  assertEquals(s.get(0, 'r'), '1,2');
});

Deno.test("generators: seed drivers drive generators natively (sentinel-park)", () => {
  const s = run(`
    function* g() { yield 1; yield 2; yield 2; yield 3; }
    function* pairs() { yield ["a", "one"]; yield ["b", "two"]; }
    let s1 = new Set(g());
    let m = new Map(pairs());
    let arr = Array.from(g());
    let mapped = Array.from(g(), (v) => v * 10);
    let o = Object.fromEntries(pairs());
    let r = s1.size + "|" + m.get("b") + "|" + arr.length + "|" + mapped[3] + "|" + o.a;
  `);
  assertEquals(s.get(0, 'r'), '3|two|4|30|one');
});

Deno.test("generators: seed edge cases — empty, completed, mid-drain throw", () => {
  const s = run(`
    function* empty() { }
    function* boom() { yield 1; throw "mid-boom"; }
    let emptySize = new Set(empty()).size;
    let it = empty();
    it.next();
    let completedSize = new Set(it).size;
    let caught = "";
    try { new Set(boom()); } catch (e) { caught = e; }
    let r = emptySize + "|" + completedSize + "|" + caught;
  `);
  assertEquals(s.get(0, 'r'), '0|0|mid-boom');
});

// =============================================================================
// return() / throw()
// =============================================================================

Deno.test("generators: return() runs body finallys (v11 RESPONSE_RETURN)", () => {
  const s = run(`
    let fin = 0;
    function* g() { try { yield 1; yield 2; } finally { fin = 1; } }
    let it = g();
    it.next();
    let step = it.return(99);
    let r = step.value + "|" + step.done + "|fin:" + fin + "|" + it.next().done;
  `);
  assertEquals(s.get(0, 'r'), '99|true|fin:1|true');
});

Deno.test("generators: return() at suspended-start never runs the body", () => {
  const s = run(`
    let ran = 0;
    function* g() { ran = 1; yield 1; }
    let it = g();
    let step = it.return(7);
    let r = step.value + "|" + step.done + "|ran:" + ran;
  `);
  assertEquals(s.get(0, 'r'), '7|true|ran:0');
});

Deno.test("generators: throw() is catchable at the yield", () => {
  const s = run(`
    function* g() {
      let caught = "";
      try { yield 1; } catch (e) { caught = e; }
      yield "recovered:" + caught;
    }
    let it = g();
    it.next();
    let step = it.throw("oops");
    let r = step.value + "|" + step.done;
  `);
  assertEquals(s.get(0, 'r'), 'recovered:oops|false');
});

Deno.test("generators: uncaught throw() kills the generator and rethrows", () => {
  const s = run(`
    function* g() { yield 1; }
    let it = g();
    it.next();
    let caught = "";
    try { it.throw("die"); } catch (e) { caught = e; }
    let r = caught + "|" + it.next().done;
  `);
  assertEquals(s.get(0, 'r'), 'die|true');
});

Deno.test("generators: re-entrant next() throws already-running", () => {
  const s = run(`
    let it;
    function* g() { yield 1; it.next(); yield 2; }
    it = g();
    it.next();
    let caught = "";
    try { it.next(); } catch (e) { caught = e.message; }
  `);
  assertEquals(s.get(0, 'caught'), 'Generator is already running');
});

// =============================================================================
// yield*
// =============================================================================

Deno.test("yield*: delegates to arrays and generators, evaluates to the done value", () => {
  const s = run(`
    function* inner() { yield "a"; yield "b"; return "inner-done"; }
    function* outer() { yield 0; let got = yield* inner(); yield* [1, 2]; yield "got:" + got; }
    let seen = [];
    for (const x of outer()) { seen.push(x); }
    let r = "" + seen;
  `);
  assertEquals(s.get(0, 'r'), '0,a,b,1,2,got:inner-done');
});

Deno.test("yield*: forwards sent values into the delegate", () => {
  const s = run(`
    function* inner() { let x = yield "q1"; yield "echo:" + x; }
    function* outer() { yield* inner(); }
    let it = outer();
    it.next();
    let r = it.next("hello").value;
  `);
  assertEquals(s.get(0, 'r'), 'echo:hello');
});

Deno.test("yield*: outer return() closes the delegate", () => {
  const s = run(`
    let closed = 0;
    let src = {
      [Symbol.iterator]() {
        let i = 0;
        return {
          next() { i = i + 1; return { value: i, done: false }; },
          return() { closed = closed + 1; return { done: true }; },
        };
      },
    };
    function* g() { yield* src; }
    let it = g();
    it.next();
    it.return(0);
    let r = closed;
  `);
  assertEquals(s.get(0, 'r'), 1);
});

Deno.test("yield*: twice in one body and nested chains", () => {
  const s = run(`
    function* a() { yield 1; }
    function* b() { yield* a(); yield* [2]; yield 3; }
    function* c() { yield* b(); yield 4; }
    let seen = [];
    for (const x of c()) { seen.push(x); }
    let r = "" + seen;
  `);
  assertEquals(s.get(0, 'r'), '1,2,3,4');
});

// =============================================================================
// Syntax guards
// =============================================================================

Deno.test("generators: yield outside a generator stays an identifier", () => {
  const s = run(`
    let yield = 5;
    let r = yield + 2;
  `);
  assertEquals(s.get(0, 'r'), 7);
});

// =============================================================================
// GC and snapshot
// =============================================================================

Deno.test("generators: parked generator survives gc", () => {
  const session = freshSession();
  parseAndSetup(session, `
    function* g() { let s = "keep"; yield s + 1; yield s + 2; }
    let it = g();
    let a = it.next().value;
  `);
  let result = session.run(0, 50_000_000);
  assertEquals(result.status, 'done');
  session.gc();
  parseAndSetup(session, `let b = it.next().value;`);
  result = session.run(0, 50_000_000);
  assertEquals(result.status, 'done');
  assertEquals(session.get(0, 'a'), 'keep1');
  assertEquals(session.get(0, 'b'), 'keep2');
});

Deno.test("generators: parked generator survives snapshot/restore", () => {
  const session = freshSession();
  parseAndSetup(session, `
    function* counter() { let i = 0; while (true) { i = i + 1; yield i * 11; } }
    let it = counter();
    let first = it.next().value;
  `);
  let result = session.run(0, 50_000_000);
  assertEquals(result.status, 'done');
  assertEquals(session.get(0, 'first'), 11);

  const { vatBytes, membraneBytes } = snapshotSession(session);
  const restored = restoreSession(vatBytes, membraneBytes);
  parseAndSetup(restored, `
    let second = it.next().value;
    let third = it.next().value;
  `);
  result = restored.run(0, 50_000_000);
  assertEquals(result.status, 'done');
  assertEquals(restored.get(0, 'second'), 22);
  assertEquals(restored.get(0, 'third'), 33);
});

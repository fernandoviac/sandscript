/**
 * Scope recycling regression pins.
 *
 * The interpreter recycles never-closure-captured scopes through a
 * free list fed by SCOPE_POP and a pending slot fed by RETURN
 * dispatch. These tests pin the two sides of that contract:
 *
 * 1. Correctness — closure-captured scopes keep their identity:
 *    per-iteration bindings observed by captured closures must stay
 *    distinct even though uncaptured sibling scopes recycle.
 * 2. The optimization itself — a closure-free loop generates no
 *    per-iteration scope garbage (no memory_pressure exits on a heap
 *    that the old per-iteration allocation blew through many times).
 */
import { assertEquals, assert } from "https://deno.land/std@0.208.0/assert/mod.ts";
import { freshSession } from '../../src/host-owned-session.js';

function run(source, opts = {}) {
  const session = freshSession(opts);
  const result = session.parse(source);
  session.mem.setContextInstructionIndex(0, result.startIndex);
  session.mem.clearExitCondition(0);
  let gcCount = 0;
  for (;;) {
    const out = session.run(0, 50_000_000);
    if (out.status === 'complete' || out.status === 'done') break;
    if (out.status === 'paused') { session.mem.clearExitCondition(0); continue; }
    if (out.status === 'memory_pressure') { session.gc(); gcCount++; continue; }
    throw new Error(`unexpected status ${out.status}`);
  }
  return { session, gcCount };
}

Deno.test('captured per-iteration bindings stay distinct across recycled iterations', () => {
  const { session } = run(`
    let fns = [];
    for (let i = 0; i < 3; i = i + 1) { let x = i * 10; fns.push(() => x); }
    let r = fns.map((f) => f());
  `);
  assertEquals(session.get(0, 'r'), [0, 10, 20]);
});

Deno.test('recycling loops before and after a capture loop leave captures intact', () => {
  const { session } = run(`
    let acc = 0;
    for (let i = 0; i < 200; i = i + 1) { let t = i; acc = acc + t; }
    let fns = [];
    for (let i = 0; i < 3; i = i + 1) { let x = i; fns.push(() => x); }
    for (let i = 0; i < 200; i = i + 1) { let t = 1; acc = acc + t; }
    let r = [acc, fns[0](), fns[1](), fns[2]()];
  `);
  assertEquals(session.get(0, 'r'), [20100, 0, 1, 2]);
});

Deno.test('callback-invocation scopes recycle; captures made inside callbacks survive', () => {
  const { session } = run(`
    let fns = [];
    [1, 2, 3].forEach((v) => { let d = v * 2; fns.push(() => d); });
    let plain = 0;
    [1, 2, 3].forEach((v) => { let d = v; plain = plain + d; });
    let r = [plain, fns[0](), fns[1](), fns[2]()];
  `);
  assertEquals(session.get(0, 'r'), [6, 2, 4, 6]);
});

Deno.test('function-call scopes recycle through the RETURN pending slot', () => {
  const { session } = run(`
    function add(a, b) { let s = a + b; return s; }
    let acc = 0;
    for (let i = 0; i < 2000; i = i + 1) { acc = add(acc, 1); }
    let r = acc;
  `);
  assertEquals(session.get(0, 'r'), 2000);
});

Deno.test('a function that creates closures per call does not recycle their scopes', () => {
  const { session } = run(`
    function makeCounter(start) {
      let n = start;
      return () => { n = n + 1; return n; };
    }
    let c1 = makeCounter(0);
    let c2 = makeCounter(100);
    c1(); c1();
    c2();
    let filler = 0;
    for (let i = 0; i < 500; i = i + 1) { let t = i; filler = filler + t; }
    let r = [c1(), c2(), filler];
  `);
  assertEquals(session.get(0, 'r'), [3, 102, 124750]);
});

Deno.test('bound function holder scopes are captured, not recycled', () => {
  const { session } = run(`
    function whoami() { return this.name; }
    let bound = whoami.bind({ name: "held" });
    let acc = 0;
    for (let i = 0; i < 500; i = i + 1) { let t = 1; acc = acc + t; }
    let r = [bound(), acc];
  `);
  assertEquals(session.get(0, 'r'), ['held', 500]);
});

Deno.test('try/catch inside a hot loop recycles cleanly', () => {
  const { session } = run(`
    let acc = 0;
    for (let i = 0; i < 300; i = i + 1) {
      try { let t = i; if (t % 100 === 50) { throw "x"; } acc = acc + 1; }
      catch (e) { let c = 1000; acc = acc + c; }
    }
    let r = acc;
  `);
  assertEquals(session.get(0, 'r'), 297 + 3 * 1000);
});

Deno.test('generator parked mid-block keeps its scopes while other code recycles', () => {
  const { session } = run(`
    function* gen() {
      for (let i = 0; i < 3; i = i + 1) { let v = i * 7; yield v; }
    }
    let g = gen();
    let first = g.next().value;
    let acc = 0;
    for (let i = 0; i < 500; i = i + 1) { let t = 1; acc = acc + t; }
    let r = [first, g.next().value, g.next().value, g.next().done, acc];
  `);
  assertEquals(session.get(0, 'r'), [0, 7, 14, true, 500]);
});

Deno.test('closure-free loop generates no per-iteration scope garbage', () => {
  // 500k iterations × the old 192-byte per-iteration allocation ≈ 92MB
  // of garbage — dozens of collections on an 8MB heap. With recycling
  // the loop must complete with zero memory_pressure exits.
  const { session, gcCount } = run(`
    let count = 0;
    for (let i = 0; i < 500000; i = i + 1) { count = count + 1; }
    let r = count;
  `, { heapSize: 8 * 1024 * 1024 });
  assertEquals(session.get(0, 'r'), 500000);
  assertEquals(gcCount, 0);
});

Deno.test('nested blocks in a hot loop all recycle (LIFO free list)', () => {
  const { session, gcCount } = run(`
    let count = 0;
    for (let i = 0; i < 200000; i = i + 1) { { { count = count + 1; } } }
    let r = count;
  `, { heapSize: 8 * 1024 * 1024 });
  assertEquals(session.get(0, 'r'), 200000);
  assertEquals(gcCount, 0);
});

Deno.test('gc mid-loop leaves recycling consistent (cache cleared on re-entry)', () => {
  // Force collections by allocating real garbage (arrays) alongside
  // recycled scopes, on a small heap. The loop must survive multiple
  // pressure→gc→resume cycles with recycling active before and after.
  const { session, gcCount } = run(`
    let acc = 0;
    for (let i = 0; i < 20000; i = i + 1) {
      let arr = [i, i + 1, i + 2, i, i + 1, i + 2, i, i + 1];
      acc = acc + arr[2] - arr[1];
    }
    let r = acc;
  `, { heapSize: 1 * 1024 * 1024 });
  assertEquals(session.get(0, 'r'), 20000);
  assert(gcCount > 0, `expected pressure collections, got ${gcCount}`);
});

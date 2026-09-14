/**
 * Unwind machinery v11 — per-entry completions on the try stack.
 *
 * Layout v11 moved the pending completion (type + 16-byte value) from
 * the single per-context slot into the try entry itself: entered
 * handlers DISARM their entry in place instead of popping it, and
 * FINALLY_END pops the entry and re-dispatches its stored completion
 * (RETURN completions re-dispatch through the sentinel RETURN
 * instruction each parse batch appends). break/continue crossing try
 * regions compile to UNWIND_JUMP, which pops crossed entries and
 * diverts through armed finallys with a JUMP completion.
 *
 * Every test here pins a real bug found in the pre-v11 machinery
 * (2026-07-07): stale catch frames after break, finallys running late
 * (at function return instead of at the jump), only the innermost
 * finally running on return, the shared completion slot clobbered by
 * nested machinery inside a finally, abrupt exits from catch skipping
 * finally, and iteration-callback returns through finally crashing the
 * interpreter (INVALID_OPERAND) or silently aborting iteration.
 */

import { assertEquals, assertThrows } from "https://deno.land/std@0.208.0/assert/mod.ts";
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

// =============================================================================
// break / continue crossing try regions
// =============================================================================

Deno.test("break out of try: no stale catch frame (later throw propagates)", () => {
  const s = run(`
    let caught = "";
    function f() {
      while (true) { try { break; } catch (e) { return "stale:" + e; } }
      throw "boom";
    }
    try { f(); } catch (e) { caught = e; }
  `);
  assertEquals(s.get(0, 'caught'), 'boom');
});

Deno.test("break through finally: finally runs AT the break", () => {
  const s = run(`
    let side = 0;
    function f() {
      while (true) { try { break; } finally { side = side + 1; } }
      return side;
    }
    let r = f();
  `);
  assertEquals(s.get(0, 'r'), 1);
  assertEquals(s.get(0, 'side'), 1);
});

Deno.test("continue through finally: finally runs every iteration", () => {
  const s = run(`
    let side = 0;
    function f() {
      let i = 0;
      while (i < 3) {
        i = i + 1;
        try { continue; } finally { side = side + 1; }
      }
      return side;
    }
    let r = f();
  `);
  assertEquals(s.get(0, 'r'), 3);
});

Deno.test("break crossing nested tries: both finallys run, inner first", () => {
  const s = run(`
    let order = [];
    while (true) {
      try {
        try { break; } finally { order.push("inner"); }
      } finally { order.push("outer"); }
    }
    let r = "" + order;
  `);
  assertEquals(s.get(0, 'r'), 'inner,outer');
});

Deno.test("break out of switch crossing a try runs its finally", () => {
  const s = run(`
    let side = 0;
    let r = 0;
    switch (1) {
      case 1:
        try { r = 10; break; } finally { side = 1; }
      case 2:
        r = 20;
    }
  `);
  assertEquals(s.get(0, 'r'), 10);
  assertEquals(s.get(0, 'side'), 1);
});

Deno.test("break inside a finally abandons the pending completion (real JS)", () => {
  const s = run(`
    let r = 0;
    while (true) {
      try { throw "x"; } finally { break; }
    }
    r = 7;
  `);
  assertEquals(s.get(0, 'r'), 7);
});

// =============================================================================
// return through finallys
// =============================================================================

Deno.test("nested finallys on return: BOTH run, inner first", () => {
  const s = run(`
    let order = [];
    function f() {
      try {
        try { return 1; } finally { order.push("a"); }
      } finally { order.push("b"); }
    }
    let r = f();
    let s2 = "" + order;
  `);
  assertEquals(s.get(0, 'r'), 1);
  assertEquals(s.get(0, 's2'), 'a,b');
});

Deno.test("function call inside a finally does not clobber the pending return", () => {
  const s = run(`
    function g() { try { return 99; } finally { } }
    function f() { try { return 1; } finally { let x = g(); } }
    let r = f();
  `);
  assertEquals(s.get(0, 'r'), 1);
});

Deno.test("try/catch inside a finally does not clobber the pending return", () => {
  const s = run(`
    function f() {
      try { return 1; } finally { try { throw "x"; } catch (e) { } }
    }
    let r = f();
  `);
  assertEquals(s.get(0, 'r'), 1);
});

Deno.test("return inside a finally replaces the pending completion", () => {
  const s = run(`
    function f() {
      try { return 1; } finally { return 2; }
    }
    let r = f();
  `);
  assertEquals(s.get(0, 'r'), 2);
});

Deno.test("throw in finally replaces the pending return", () => {
  const s = run(`
    function f() { try { return 1; } finally { throw "override"; } }
    let r = 0;
    try { r = f(); } catch (e) { r = 7; }
  `);
  assertEquals(s.get(0, 'r'), 7);
});

// =============================================================================
// abrupt exits from catch blocks
// =============================================================================

Deno.test("throw in catch still runs the finally", () => {
  const s = run(`
    let fin = 0; let caught = "";
    function f() {
      try { throw "one"; } catch (e) { throw "two"; } finally { fin = 1; }
    }
    try { f(); } catch (e) { caught = e; }
  `);
  assertEquals(s.get(0, 'fin'), 1);
  assertEquals(s.get(0, 'caught'), 'two');
});

Deno.test("return in catch runs the finally", () => {
  const s = run(`
    let fin = 0;
    function f() {
      try { throw "x"; } catch (e) { return 2; } finally { fin = 1; }
    }
    let r = f();
  `);
  assertEquals(s.get(0, 'r'), 2);
  assertEquals(s.get(0, 'fin'), 1);
});

Deno.test("break inside catch runs the finally", () => {
  const s = run(`
    let fin = 0;
    while (true) {
      try { throw "x"; } catch (e) { break; } finally { fin = fin + 1; }
    }
    let r = fin;
  `);
  assertEquals(s.get(0, 'r'), 1);
});

// =============================================================================
// iteration-callback returns through finally (pre-v11: crash / silent abort)
// =============================================================================

Deno.test("map callback return through finally", () => {
  const s = run(`
    let arr = [1, 2, 3].map(function (x) { try { return x * 2; } finally { } });
    let r = "" + arr;
  `);
  assertEquals(s.get(0, 'r'), '2,4,6');
});

Deno.test("forEach callback bare return through finally continues iterating", () => {
  const s = run(`
    let sum = 0;
    [1, 2, 3].forEach(function (x) {
      try { if (x === 2) { return; } } finally { sum = sum + x; }
    });
  `);
  assertEquals(s.get(0, 'sum'), 6);
});

Deno.test("filter callback return through finally", () => {
  const s = run(`
    let arr = [1, 2, 3, 4].filter(function (x) {
      try { return x % 2 === 0; } finally { }
    });
    let r = "" + arr;
  `);
  assertEquals(s.get(0, 'r'), '2,4');
});

// =============================================================================
// function boundaries
// =============================================================================

Deno.test("break inside a function inside a loop is a parse error", () => {
  assertThrows(
    () => run(`
      while (true) { let f = function () { break; }; }
    `),
    Error,
    "'break' outside of switch or loop",
  );
});

Deno.test("continue inside a function inside a loop is a parse error", () => {
  assertThrows(
    () => run(`
      while (true) { let f = function () { continue; }; }
    `),
    Error,
    "'continue' outside of loop",
  );
});

/**
 * Parser codegen stress corpus.
 *
 * Every scenario is a function body exercising a statement/branch shape
 * that stresses jump patching, the deferred expression-POP, scope
 * push/pop pairing, or loop/branch codegen. Each runs TWICE:
 *
 *   1. TOP    — plain call, result asserted.
 *   2. MID    — the console-host shape: the call sits mid-expression as
 *               an object-literal value with the callee and sibling
 *               operands parked BELOW it on the pending stack. Any
 *               stack-effect miscount displaces those operands.
 *
 * After every run the operand-stack underflow counter must read ZERO —
 * with the $pending_pop tripwire, any orphaned POP (the unbraced-if
 * deferred-POP bug, tests/fuel/unbraced_if_pending_pop_test.js) is a
 * test failure even when the visible result happens to survive.
 *
 * Grown from the 2026-07-02 console-host postmortem: the corpus is the
 * proactive net for the next codegen bug of this class.
 *
 * Run with: deno task test tests/fuel/parser_codegen_stress_test.js
 */

import { assert, assertEquals } from "https://deno.land/std@0.208.0/assert/mod.ts";
import { freshSession } from '../../src/host-owned-session.js';
import { parseAndSetup } from './test-helpers.js';

const SCENARIOS = [
  // --- the deferred-POP / unbraced-branch family ---
  { name: 'unbraced if, false, method-call statement (THE console bug)',
    body: `let a = []
           let i = 0
           while (i < 6) {
             if (i === 99) a.push(i)
             i = i + 1
           }
           return a.length`, expect: 0 },
  { name: 'unbraced if, true, method-call statement',
    body: `let a = []
           if (1 === 1) a.push(7)
           return a.length`, expect: 1 },
  { name: 'unbraced if, false, plain call statement',
    body: `let hits = 0
           let bump = () => { hits = hits + 1 }
           if (false) bump()
           return hits`, expect: 0 },
  { name: 'unbraced if, false, assignment statement',
    body: `let x = 5
           if (false) x = 9
           return x`, expect: 5 },
  { name: 'unbraced if as the LAST statement of the function',
    body: `let a = []
           if (false) a.push(1)`, expect: undefined },
  { name: 'unbraced if as the last statement of a braced block',
    body: `let a = []
           {
             if (false) a.push(1)
           }
           return a.length`, expect: 0 },
  { name: 'unbraced if/else, condition false',
    body: `let r = 0
           if (false) r = 1
           else r = 2
           return r`, expect: 2 },
  { name: 'unbraced if/else, condition true, call statements both arms',
    body: `let log = []
           if (true) log.push("t")
           else log.push("f")
           return log[0]`, expect: 't' },
  { name: 'unbraced else-if chain, middle arm taken',
    body: `let r = ""
           let v = 2
           if (v === 1) r = "one"
           else if (v === 2) r = "two"
           else r = "other"
           return r`, expect: 'two' },
  { name: 'nested unbraced ifs, outer true inner false',
    body: `let a = []
           if (true) if (false) a.push(1)
           return a.length`, expect: 0 },
  { name: 'dangling else binds to the inner if',
    body: `let r = "none"
           if (true) if (false) r = "inner-then"
           else r = "inner-else"
           return r`, expect: 'inner-else' },
  { name: 'many consecutive false unbraced ifs',
    body: `let a = []
           if (false) a.push(1)
           if (false) a.push(2)
           if (false) a.push(3)
           if (false) a.push(4)
           if (false) a.push(5)
           return a.length`, expect: 0 },

  // --- loops with expression-statement bodies ---
  { name: 'unbraced while body, expression statement',
    body: `let i = 0
           while (i < 3) i = i + 1
           return i`, expect: 3 },
  { name: 'unbraced while body, zero iterations',
    body: `let i = 9
           while (i < 3) i = i + 1
           return i`, expect: 9 },
  { name: 'unbraced while body, method-call statement',
    body: `let a = []
           let i = 0
           while (a.length < 3) a.push(i = i + 1)
           return a.length`, expect: 3 },
  { name: 'do-while, braced, runs once',
    body: `let n = 0
           do { n = n + 1 } while (false)
           return n`, expect: 1 },
  { name: 'do-while, unbraced expression body',
    body: `let n = 0
           do n = n + 1
           while (n < 4)
           return n`, expect: 4 },
  { name: 'for loop, braced body with pushes',
    body: `let a = []
           for (let i = 0; i < 4; i = i + 1) { a.push(i) }
           return a.length`, expect: 4 },
  { name: 'for loop, unbraced expression body',
    body: `let s = 0
           for (let i = 0; i < 5; i = i + 1) s = s + i
           return s`, expect: 10 },
  { name: 'for loop, zero iterations, unbraced body',
    body: `let s = 100
           for (let i = 9; i < 5; i = i + 1) s = s + i
           return s`, expect: 100 },
  { name: 'while containing false unbraced if per iteration + trailing work',
    body: `let a = []
           let i = 0
           while (i < 5) {
             if (i === 42) a.push(i)
             a.push(0)
             i = i + 1
           }
           return a.length`, expect: 5 },

  // --- break / continue ---
  { name: 'break out of a while mid-collection',
    body: `let a = []
           let i = 0
           while (true) {
             if (i === 3) break
             a.push(i)
             i = i + 1
           }
           return a.length`, expect: 3 },
  { name: 'continue skipping the push',
    body: `let a = []
           let i = 0
           while (i < 6) {
             i = i + 1
             if (i === 2) continue
             a.push(i)
           }
           return a.length`, expect: 5 },
  { name: 'unbraced if guarding break',
    body: `let i = 0
           while (i < 100) {
             if (i === 4) break
             i = i + 1
           }
           return i`, expect: 4 },

  // --- switch ---
  { name: 'switch: matching case with expression statements + break',
    body: `let log = []
           let v = 2
           switch (v) {
             case 1:
               log.push("one")
               break
             case 2:
               log.push("two")
               break
             default:
               log.push("other")
           }
           return log[0]`, expect: 'two' },
  { name: 'switch: fallthrough accumulates',
    body: `let log = []
           switch (1) {
             case 1:
               log.push("a")
             case 2:
               log.push("b")
               break
             default:
               log.push("c")
           }
           return log.length`, expect: 2 },
  { name: 'switch: no match falls to default',
    body: `let r = ""
           switch (99) {
             case 1:
               r = "one"
               break
             default:
               r = "default"
           }
           return r`, expect: 'default' },

  // --- try / catch / finally ---
  { name: 'try/catch: throw caught, expression statements both blocks',
    body: `let log = []
           try {
             log.push("in")
             throw new Error("boom")
           } catch (e) {
             log.push(e.message)
           }
           return log[1]`, expect: 'boom' },
  { name: 'try/finally: return value survives the finally',
    body: `let log = []
           try {
             return "kept"
           } finally {
             log.push("cleanup")
           }`, expect: 'kept' },
  { name: 'throw inside unbraced if, caught outside',
    body: `let r = "no"
           try {
             if (true) throw new Error("jump")
             r = "unreached"
           } catch (e) {
             r = e.message
           }
           return r`, expect: 'jump' },

  // --- expression-as-statement shapes ---
  { name: 'ternary used as a statement',
    body: `let a = []
           true ? a.push(1) : a.push(2)
           return a[0]`, expect: 1 },
  { name: 'logical AND short-circuit statement, falsy left',
    body: `let hits = 0
           let bump = () => { hits = hits + 1 }
           false && bump()
           return hits`, expect: 0 },
  { name: 'logical OR short-circuit statement, truthy left',
    body: `let hits = 0
           let bump = () => { hits = hits + 1 }
           true || bump()
           return hits`, expect: 0 },
  { name: 'lone semicolons between statements',
    body: `let x = 1;;;
           x = x + 1;;
           return x`, expect: 2 },
  { name: 'bare block as a statement',
    body: `let a = []
           {
             a.push(1)
             a.push(2)
           }
           return a.length`, expect: 2 },
  { name: 'empty braced branches',
    body: `let r = 3
           if (true) {} else {}
           while (false) {}
           return r`, expect: 3 },

  // --- functions and calls in statement positions ---
  { name: 'early return from inside a loop inside an if',
    body: `let i = 0
           if (true) {
             while (true) {
               i = i + 1
               if (i === 3) return i
             }
           }
           return -1`, expect: 3 },
  { name: 'immediately-invoked arrow as a statement',
    body: `let box = { n: 0 }
           let setup = (b) => { b.n = 41 }
           setup(box)
           return box.n + 1`, expect: 42 },
  { name: 'recursion evaluated mid-statement-chain',
    body: `let fact = (n) => {
             if (n <= 1) return 1
             return n * fact(n - 1)
           }
           let unused = []
           if (false) unused.push(fact(3))
           return fact(5)`, expect: 120 },
  { name: 'nested object/array literals inside a taken branch',
    body: `let out = []
           if (true) out.push({ a: [1, 2, { b: "deep" }], c: "top" })
           return out[0].a[2].b`, expect: 'deep' },
  { name: 'function with no return used as a statement',
    body: `let log = []
           let note = (m) => { log.push(m) }
           note("one")
           note("two")
           return log.length`, expect: 2 },

  // --- try/catch/finally under the v9 pending-position restore ---
  { name: 'caught mid-expression throw, execution continues clean',
    body: `let boom = () => { throw new Error("mid") }
           let caught = "no"
           try {
             let junk = { a: [1, boom()], b: 2 }
           } catch (e) {
             caught = e.message
           }
           return caught`, expect: 'mid' },
  { name: 'loop of caught throws stays flat',
    body: `let boom = () => { throw new Error("x") }
           let n = 0
           let i = 0
           while (i < 8) {
             try { let j = [boom()] } catch (e) { n = n + 1 }
             i = i + 1
           }
           return n`, expect: 8 },
  { name: 'return through finally inside the mid-expression harness',
    body: `let inner = () => {
             try {
               return "inner-kept"
             } finally {
               let sweep = 1
             }
           }
           return inner()`, expect: 'inner-kept' },
  { name: 'throw through finally to outer catch',
    body: `let r = "none"
           try {
             try { throw new Error("deep") } finally { r = "swept-first" }
           } catch (e) {
             r = r + "+" + e.message
           }
           return r`, expect: 'swept-first+deep' },

  // --- grant / denied ---
  { name: 'approved grant runs the block',
    body: `let r = 0
           grant "cap-a" { r = 41 }
           return r + 1`, expect: 42 },
  { name: 'denied grant takes the denied block with the ids array',
    body: `let r = "none"
           grant "deny-me" { r = "granted" } denied (ids) { r = "denied:" + ids.length }
           return r`, expect: 'denied:1' },

  // --- spread family ---
  { name: 'array spread + call spread + object spread',
    body: `let parts = [2, 3]
           let all = [1, ...parts, 4]
           let sum4 = (a, b, c, d) => { return a + b + c + d }
           let total = sum4(...all)
           let merged = { base: total, ...{ extra: 5 } }
           return merged.base + merged.extra`, expect: 15 },
];

function underflows(session) {
  return session.airlock.wasm.exports.stack_underflow_count();
}

// Grant scenarios: approve everything except the literal "deny-me".
function armGrants(session) {
  session.airlock.onGrantRequest = (identifier) => {
    if (identifier === 'deny-me') return { approved: false };
    const grant = session.airlock.membrane.createGrant(identifier);
    return { approved: true, grant };
  };
}

Deno.test('codegen stress: every scenario, top-level call', () => {
  for (const s of SCENARIOS) {
    const session = freshSession();
    armGrants(session);
    parseAndSetup(session, `
      let f = () => {
        ${s.body}
      }
      let result = f()
    `);
    const r = session.run(0, 1000000);
    assertEquals(r.status, 'done', `${s.name}: run must complete (${JSON.stringify(r)})`);
    assertEquals(session.get(0, 'result'), s.expect, `${s.name}: result`);
    assertEquals(underflows(session), 0, `${s.name}: operand-stack underflow`);
  }
});

Deno.test('codegen stress: every scenario, mid-expression (operands parked below)', () => {
  for (const s of SCENARIOS) {
    const session = freshSession();
    armGrants(session);
    parseAndSetup(session, `
      let frame = null
      let deliver = (v) => { frame = v }
      let f = () => {
        ${s.body}
      }
      deliver({ kind: "stress", data: f(), tail: "intact" })
    `);
    const r = session.run(0, 1000000);
    assertEquals(r.status, 'done', `${s.name} (mid): run must complete (${JSON.stringify(r)})`);
    const frame = session.get(0, 'frame');
    assert(frame !== null && typeof frame === 'object', `${s.name} (mid): frame delivered`);
    assertEquals(frame.kind, 'stress', `${s.name} (mid): kind survived below the call`);
    assertEquals(frame.tail, 'intact', `${s.name} (mid): tail survived above the call`);
    assertEquals(frame.data, s.expect, `${s.name} (mid): data`);
    assertEquals(underflows(session), 0, `${s.name} (mid): operand-stack underflow`);
  }
});

Deno.test('codegen stress: the REPL top-level deferral still leaves the last result readable', () => {
  const session = freshSession();
  parseAndSetup(session, `
    let a = 20
    let b = 22
    a + b
  `);
  const r = session.run(0, 100000);
  assertEquals(r.status, 'done');
  assertEquals(session.result(0), 42);
  assertEquals(underflows(session), 0);
});

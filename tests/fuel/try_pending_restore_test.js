/**
 * TRY entries save/restore the pending position (layout v9).
 *
 * Before v9, try entries carried no pending position: an abnormal exit
 * (throw→catch, throw→finally, return→finally) entered the handler at
 * whatever mid-expression depth the exit left behind, abandoning the
 * throwing expression's operands on the stack — they leaked until a
 * frame restore, and the unwind path relied on the pending-pop base
 * clamp to over-pop safely. With the saved position restored on every
 * abnormal entry, handler depth is statically the try's own depth and
 * nothing leaks.
 *
 * Run with: deno task test tests/fuel/try_pending_restore_test.js
 */

import { assert, assertEquals } from "https://deno.land/std@0.208.0/assert/mod.ts";
import { freshSession } from '../../src/host-owned-session.js';
import { parseAndSetup } from './test-helpers.js';

function run(source) {
  const session = freshSession();
  parseAndSetup(session, source);
  const r = session.run(0, 1000000);
  assertEquals(r.status, 'done', JSON.stringify(r));
  return session;
}

Deno.test('throw mid-expression: catch entry restores the operand stack (no abandoned operands)', () => {
  const session = run(`
    let caught = "no"
    let boom = () => { throw new Error("mid-expression") }
    let deliver = (v) => { return v }
    try {
      deliver({ kind: "k", a: 1, b: boom(), c: 2 })
    } catch (e) {
      caught = e.message
    }
    let after = "statements still run"
  `);
  assertEquals(session.get(0, 'caught'), 'mid-expression');
  assertEquals(session.get(0, 'after'), 'statements still run');
  // The throwing expression had callee + object operands parked; the
  // catch restore must drop them all. Nothing may remain (the last
  // statement is a declaration, not a REPL expression).
  assertEquals(session.mem.getPendingDepth(0), 0,
    'no abandoned operands after the caught mid-expression throw');
  assertEquals(session.airlock.wasm.exports.stack_underflow_count(), 0);
});

Deno.test('throw mid-expression → finally → rethrow → outer catch: both entries restore', () => {
  const session = run(`
    let log = []
    let boom = () => { throw new Error("deep") }
    try {
      try {
        let frame = { x: [1, 2, boom()], y: "unreached" }
      } finally {
        log.push("finally")
      }
    } catch (e) {
      log.push(e.message)
    }
    let tail = log.length
  `);
  assertEquals(session.get(0, 'log'), ['finally', 'deep']);
  assertEquals(session.mem.getPendingDepth(0), 0);
  assertEquals(session.airlock.wasm.exports.stack_underflow_count(), 0);
});

Deno.test('return through finally keeps the value; loops of caught throws do not grow the stack', () => {
  const session = run(`
    let boom = () => { throw new Error("again") }
    let work = () => {
      try {
        return "kept"
      } finally {
        let sweep = "cleanup"
      }
    }
    let kept = work()
    let i = 0
    while (i < 20) {
      try { let junk = { deep: [boom(), 1] } } catch (e) { }
      i = i + 1
    }
  `);
  assertEquals(session.get(0, 'kept'), 'kept');
  // 20 caught mid-expression throws: pre-v9 each leaked its abandoned
  // operands until something reset the stack; now the depth stays flat.
  assertEquals(session.mem.getPendingDepth(0), 0,
    'repeated caught throws must not accumulate stack junk');
  assertEquals(session.airlock.wasm.exports.stack_underflow_count(), 0);
});

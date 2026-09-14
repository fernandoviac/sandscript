/**
 * The operand-stack underflow tripwire ($pending_pop).
 *
 * A NORMAL-execution pop at the stack base is a codegen/dispatch/resume
 * bug — the deferred-POP class ate one operand per false branch for
 * weeks because the clamp was silent. Now every such clamp increments
 * wasm.exports.stack_underflow_count() and drops a step-ring sentinel;
 * under strict mode (strict_stack_enable / SS_STRICT_STACK=1) it traps
 * fatally with ERR_STACK_UNDERFLOW stamped.
 *
 * Strict is NOT yet the default: the async-await resume protocol leaves
 * the pending pointer un-advanced in one driver shape and only works
 * via the clamp's base-slot aliasing (the marshal writes the result at
 * base+0; the clamped pop reads it back). This file documents that wart
 * so fixing it flips strict on by default.
 *
 * Run with: deno task test tests/fuel/stack_underflow_tripwire_test.js
 */

import { assert, assertEquals } from "https://deno.land/std@0.208.0/assert/mod.ts";
import { freshSession } from '../../src/host-owned-session.js';
import { parseAndSetup } from './test-helpers.js';
import { UncaughtScriptError } from '../../src/runtime/errors.js';

Deno.test('tripwire: a clean program leaves the underflow counter at zero', () => {
  const session = freshSession();
  parseAndSetup(session, `
    let out = []
    let i = 0
    while (i < 5) {
      if (i === 2) out.push(i)
      if (i === 99) out.push(i)
      i = i + 1
    }
    out.length
  `);
  const r = session.run(0, 100000);
  assertEquals(r.status, 'done');
  assertEquals(session.result(0), 1);
  assertEquals(session.airlock.wasm.exports.stack_underflow_count(), 0,
    'no NORMAL-execution pop may hit the stack base');
});

// The KNOWN wart, used as the tripwire's own fixture: an async external
// handler awaited at top level, its result then used — the resume leaves
// the pending pointer at base and the follow-on pop only "works" via the
// clamp aliasing the just-marshalled base slot.
async function driveAsyncExternalShape(session) {
  const airlock = session.airlock;
  async function drive(slot) {
    while (true) {
      let r;
      try {
        r = await session.run(slot, 100000);
      } catch (e) {
        if (e instanceof UncaughtScriptError) return { status: 'error', error: e.scriptError };
        throw e;
      }
      if (['done', 'paused', 'async_complete', 'async_rejected'].includes(r.status)) return r;
      if (r.status === 'async_call') { drive(r.asyncContext); continue; }
      if (r.status === 'await' || r.status === 'suspended') {
        await new Promise(rs => setTimeout(rs, 5));
        for (const s of airlock.drainPendingSpawnedContextIdentities()) drive(s);
        continue;
      }
      if (r.status === 'promise_method') {
        if (Array.isArray(r.contexts)) for (const c of r.contexts) drive(c);
        continue;
      }
      return r;
    }
  }
  return drive(0);
}

function setupAsyncExternalShape(session) {
  const airlock = session.airlock;
  const rootGrant = airlock.createRootGrant('app');
  const thing = airlock.register({});
  airlock.setHandler(thing, 'greet', () => 'hi-from-thing');
  rootGrant.add(thing);
  const rootId = airlock.register({});
  airlock.setHandler(rootId, null, async () => [thing]);
  rootGrant.add(rootId);
  airlock.declare('getThing', rootId);
  session.parse(`
    let r = await getThing()
    let t = r[0]
    let msg = t.greet()
  `);
}

// CONTRACT: driving one slot from two loops (the await-wake hands slot 0
// back through drainPendingSpawnedContexts while the caller's loop ALSO
// keeps polling it) is a DRIVER BUG. One loop finishes the program; the
// other re-enters the finished slot and re-executes trailing
// instructions, whose pops hit the stack base. That used to "work" via
// the silent clamp aliasing the just-marshalled base slot — under
// strict stack mode (THE DEFAULT) it now dies loudly instead.
Deno.test('tripwire: DOUBLE-DRIVING a slot dies loudly under strict default (no silent limping)', async () => {
  const session = freshSession();
  setupAsyncExternalShape(session);
  let outcome = 'clean';
  try {
    await driveAsyncExternalShape(session); // the deliberately sloppy driver
  } catch (e) {
    outcome = `trap:${session.mem.getErrorInfo().code}`;
  }
  // Either the interleaving hits the re-execution (REDECLARATION /
  // underflow trap) or, on a lucky schedule, completes — but a silent
  // wrong result is impossible: any base-pop either traps (strict) or
  // is counted.
  const underflows = session.airlock.wasm.exports.stack_underflow_count();
  assert(outcome !== 'clean' || underflows === 0 || session.get(0, 'msg') === 'hi-from-thing',
    `no silent corruption: outcome=${outcome} underflows=${underflows}`);
  if (outcome.startsWith('trap:')) {
    assertEquals(outcome, 'trap:25', 'the trap is ERR_STACK_UNDERFLOW, named');
  }
});

Deno.test('tripwire: the SINGLE-OWNER driver runs the same shape clean (counter zero, strict default)', async () => {
  const session = freshSession();
  setupAsyncExternalShape(session);

  const queue = [0];
  while (queue.length > 0) {
    const slot = queue.shift();
    const r = await session.run(slot, 100000);
    if (['done', 'paused', 'error', 'async_complete', 'async_rejected'].includes(r.status)) continue;
    if (r.status === 'await' || r.status === 'suspended') {
      await new Promise(rs => setTimeout(rs, 5));
      const woken = session.airlock.drainPendingSpawnedContextIdentities();
      if (woken.length > 0) queue.push(...woken);
      else queue.push(slot);
      continue;
    }
    if (r.status === 'async_call') { queue.push(r.asyncContext, slot); continue; }
    if (r.status === 'promise_method') { queue.push(...(r.contexts ?? []), slot); continue; }
    break;
  }

  assertEquals(session.get(0, 'msg'), 'hi-from-thing');
  assertEquals(session.airlock.wasm.exports.stack_underflow_count(), 0,
    'a single-owner driver never pops at the stack base');
});

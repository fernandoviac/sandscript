/**
 * Swarm integration tests — nested grant blocks.
 *
 * The drone-side grant block is a stack: each `grant "X" {
 * ... }` pushes one frame onto the calling slot's grant
 * stack; the frame pops at block exit. A handle is callable
 * iff its grant is on the stack at call time. Nesting matters
 * because:
 *
 *   - The inner block sees both its own and the outer's
 *     handles authorized.
 *   - After the inner block exits, the outer's handles still
 *     work; the inner's do not.
 *   - After the outer exits, neither work.
 *
 * Pinned here:
 *
 *   - inner-only handle is denied outside the inner block,
 *     allowed inside
 *   - outer handle is allowed both inside and outside the
 *     inner block (but not outside the outer)
 *   - reusing the same identifier in both levels — verify
 *     that the inner block still authorizes that identifier's
 *     handles after the outer's endorsement also covers them
 *     (i.e. the second push doesn't disable the outer)
 *   - denial is control flow (not an exception): the body is
 *     skipped and the optional `denied` arm runs; an endorser
 *     throw counts as no-endorsement and surfaces via
 *     onHandlerError as an EndorserError
 *
 * Run with:
 *   deno task test tests/runtime/swarm/nested_grants_test.js
 */

import { assertEquals, assert } from "https://deno.land/std@0.208.0/assert/mod.ts";
import { RuntimeBuilder } from '../../../src/runtime/test-harness.js';

function tick(ms = 0) { return new Promise(r => setTimeout(r, ms)); }

async function waitFor(condition, { timeout = 2000, label = 'condition' } = {}) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    if (condition()) return;
    await tick(2);
  }
  throw new Error(`waitFor timed out: ${label}`);
}

// Every Runtime grant request passes through runGrantFanout, which returns a
// Promise even for zero or fully synchronous endorsers. runtime.run(0)
// therefore suspends after the first grant statement instead of completing
// the whole script in one drive episode. Slot 0 wakes through _continueRoot,
// so runtime.run(0)'s original promise does not resolve again for that
// continuation; poll engine state instead of awaiting a second drive.
async function runRootToCompletion(runtime, slot = 0) {
  await runtime.run(slot);
  await waitFor(() => runtime.getEngineState(slot).status === 'done',
    { label: `slot ${slot} to reach 'done'` });
  return runtime.getEngineState(slot);
}

/**
 * Two-capability fixture used by the nesting tests:
 *   - 'outer' endorses identifier "outer", covers Outer.touch()
 *   - 'inner' endorses identifier "inner", covers Inner.touch()
 *   - 'log'   is a root-grant capability the drone uses to
 *     surface what worked / what threw
 */
function buildCaps(log) {
  const outerCap = {
    name: 'outer',
    setup: (al) => {
      const handle = al.register({});
      al.setHandler(handle, 'touch', () => { log.push('outer'); return null; });
      al.declare('Outer', handle);
      return {
        onGrantRequest: (id) => {
          if (id !== 'outer') return null;
          const grant = al.membrane.createGrant(id);
          grant.add(handle);
          return grant;
        },
      };
    },
  };

  const innerCap = {
    name: 'inner',
    setup: (al) => {
      const handle = al.register({});
      al.setHandler(handle, 'touch', () => { log.push('inner'); return null; });
      al.declare('Inner', handle);
      return {
        onGrantRequest: (id) => {
          if (id !== 'inner') return null;
          const grant = al.membrane.createGrant(id);
          grant.add(handle);
          return grant;
        },
      };
    },
  };

  // Always-callable surface used by the drone to surface
  // outcomes back to the test (granted via root grant).
  const logCap = {
    name: 'log',
    setup: (al) => {
      const root = al.createRootGrant();
      const handle = al.register({});
      root.add(handle);
      al.setHandler(handle, 'mark', ({ args }) => { log.push(args[0]); return null; });
      al.declare('Log', handle);
    },
  };

  return [outerCap, innerCap, logCap];
}

// =============================================================================
// inner-only handle is denied outside, allowed inside
// =============================================================================

Deno.test("nested grants: inner handle is denied outside its block, allowed inside", async () => {
  const log = [];
  const { runtime, session, channels } = new RuntimeBuilder()
    .capabilities(buildCaps(log))
    .onInboundMessage(() => {})
    .onHandlerError(() => {})  // attribution noise expected on the denied call
    .build();
  await runtime.start();

  // Outside any grant: calling an unauthorized handle throws
  // GrantDeniedError — the drone catches and marks.
  // Inside grant "inner": Inner is authorized; the call succeeds.
  // (Grant denial is control flow; here the grant is approved
  // so no `denied` arm is needed.)
  session.parse(`
    try { Inner.touch(); Log.mark("inner-outside-ok"); }
    catch (_e) { Log.mark("inner-outside-denied"); }

    grant "inner" { Inner.touch(); Log.mark("inner-inside-ok"); }
  `);
  const r = await runRootToCompletion(runtime);
  assertEquals(r.status, 'done');

  assert(log.includes('inner-outside-denied'),
    `expected outside-denied; log=${JSON.stringify(log)}`);
  assert(!log.includes('inner-outside-ok'), 'outside call must not have run');
  assert(log.includes('inner'), 'inner handler ran inside the grant');
  assert(log.includes('inner-inside-ok'), 'drone reached the inside-ok mark');

  await runtime.terminate();
  channels.close();
});

// =============================================================================
// outer handle is allowed inside the inner block too
// =============================================================================

Deno.test("nested grants: outer-block handle remains callable inside an inner block", async () => {
  const log = [];
  const { runtime, session, channels } = new RuntimeBuilder()
    .capabilities(buildCaps(log))
    .onInboundMessage(() => {})
    .onHandlerError(() => {})
    .build();
  await runtime.start();

  session.parse(`
    grant "outer" {
      Outer.touch();              // works (in outer)
      grant "inner" {
        Outer.touch();            // still works (outer frame still live)
        Inner.touch();            // works (inner frame on top)
      }
      Outer.touch();              // still works (back to outer-only)
      try { Inner.touch(); Log.mark("inner-after-pop-ok"); }
      catch (_e) { Log.mark("inner-after-pop-denied"); }
    }
    try { Outer.touch(); Log.mark("outer-after-pop-ok"); }
    catch (_e) { Log.mark("outer-after-pop-denied"); }
  `);
  const r = await runRootToCompletion(runtime);
  assertEquals(r.status, 'done');

  // Three Outer.touch() calls succeeded inside outer.
  const outerCount = log.filter(x => x === 'outer').length;
  assertEquals(outerCount, 3, `outer touched 3 times; log=${JSON.stringify(log)}`);
  // Inner.touch() succeeded once.
  const innerCount = log.filter(x => x === 'inner').length;
  assertEquals(innerCount, 1);
  // After inner pops, Inner is denied.
  assert(log.includes('inner-after-pop-denied'));
  // After outer pops, Outer is denied.
  assert(log.includes('outer-after-pop-denied'));

  await runtime.terminate();
  channels.close();
});

// =============================================================================
// Re-using the same identifier nests cleanly — pin the actual stack behavior
// =============================================================================

Deno.test("nested grants: same identifier nested — outer authorization survives inner pop", async () => {
  const log = [];
  const { runtime, session, channels } = new RuntimeBuilder()
    .capabilities(buildCaps(log))
    .onInboundMessage(() => {})
    .onHandlerError(() => {})
    .build();
  await runtime.start();

  // Two pushes of the same identifier. Inside, Outer.touch
  // works (covered by both frames). After the inner pop, the
  // outer frame for "outer" must still authorize Outer.touch.
  session.parse(`
    grant "outer" {
      Outer.touch();              // 1
      grant "outer" {
        Outer.touch();            // 2 — still works
      }
      Outer.touch();              // 3 — outer frame still live after inner pop
    }
    try { Outer.touch(); Log.mark("ok"); }
    catch (_e) { Log.mark("denied"); }
  `);
  const r = await runRootToCompletion(runtime);
  assertEquals(r.status, 'done');

  assertEquals(log.filter(x => x === 'outer').length, 3,
    `expected 3 outer touches; log=${JSON.stringify(log)}`);
  assert(log.includes('denied'), 'after both pops, Outer is denied');

  await runtime.terminate();
  channels.close();
});

// =============================================================================
// Inner endorser throws → outer block's authorization remains intact
// =============================================================================

Deno.test("nested grants: inner endorser throw → denied → block skipped, denied block runs, outer continues", async () => {
  // A throwing endorser counts as no-endorsement. The grant
  // statement is a control-flow construct: on denial the body
  // is skipped — no throw into the drone. The optional `denied`
  // arm runs instead. The outer grant's authorization is
  // untouched. The endorser throw is surfaced to the embedder
  // via onHandlerError as an EndorserError.
  const log = [];
  const handlerErrors = [];

  const outerCap = {
    name: 'outer',
    setup: (al) => {
      const handle = al.register({});
      al.setHandler(handle, 'touch', () => { log.push('outer'); return null; });
      al.declare('Outer', handle);
      return {
        onGrantRequest: (id) => {
          if (id !== 'outer') return null;
          const grant = al.membrane.createGrant(id);
          grant.add(handle);
          return grant;
        },
      };
    },
  };

  const innerHandlerCap = {
    name: 'inner-handler',
    setup: (al) => {
      const handle = al.register({});
      al.setHandler(handle, 'touch', () => { log.push('inner'); return null; });
      al.declare('Inner', handle);
    },
  };

  // Endorser for 'inner' throws — but doesn't expose any handle.
  const badEndorserCap = {
    name: 'bad-endorser',
    setup: () => ({
      onGrantRequest: (id) => {
        if (id !== 'inner') return null;
        throw new Error('endorser exploded');
      },
    }),
  };

  const logCap = {
    name: 'log',
    setup: (al) => {
      const root = al.createRootGrant();
      const handle = al.register({});
      root.add(handle);
      al.setHandler(handle, 'mark', ({ args }) => { log.push(args[0]); return null; });
      al.declare('Log', handle);
    },
  };

  const { runtime, session, channels } = new RuntimeBuilder()
    .capabilities([outerCap, innerHandlerCap, badEndorserCap, logCap])
    .onInboundMessage(() => {})
    .onHandlerError((e) => handlerErrors.push(e))
    .build();
  await runtime.start();

  // No try/catch — denial is control flow, not an exception.
  // The `denied` arm gives the drone a clean way to react.
  session.parse(`
    grant "outer" {
      Outer.touch();
      grant "inner" {
        Log.mark("inner-body-entered");
        Inner.touch();
      } denied {
        Log.mark("inner-denied-block-ran");
      }
      Outer.touch();
      Log.mark("outer-after-denial");
    }
  `);
  const r = await runRootToCompletion(runtime);
  assertEquals(r.status, 'done');

  // Inner block body was skipped on denial.
  assert(!log.includes('inner-body-entered'),
    `inner body must not run on denial; log=${JSON.stringify(log)}`);
  assert(!log.includes('inner'), 'inner handler must not have run');
  // The denied arm ran instead.
  assert(log.includes('inner-denied-block-ran'),
    `denied block must run; log=${JSON.stringify(log)}`);
  // Outer block authorization survived; execution continued.
  assertEquals(log.filter(x => x === 'outer').length, 2,
    `outer touched twice; log=${JSON.stringify(log)}`);
  assert(log.includes('outer-after-denial'));

  // Endorser throw was surfaced to the embedder.
  assert(handlerErrors.some(e => e?.name === 'EndorserError'),
    `expected EndorserError; got ${handlerErrors.map(e => e?.name).join(', ')}`);

  await runtime.terminate();
  channels.close();
});

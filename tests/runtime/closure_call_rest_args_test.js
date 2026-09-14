/**
 * Host-scheduled closure calls stage arguments per the shared sizing rule.
 * airlock.setupCallbackContext sizes the marshalled argument list with
 * callback_staged_argc — declared parameter count for fixed arity (the
 * allocation-saving truncation a fixed callee cannot observe), the host's
 * FULL argument list for a rest-declaring callee, which collects every
 * staged value and therefore observes truncation.
 *
 * Run with: deno task test tests/runtime/closure_call_rest_args_test.js
 */
import { assertEquals } from "https://deno.land/std@0.208.0/assert/mod.ts";
import { RuntimeBuilder } from '../../src/runtime/test-harness.js';

async function driveWith(callbackSource) {
  let runtimeRef = null;
  const cap = {
    name: 'test',
    needs: {},
    setup(airlock) {
      const fireHandle = airlock.register({}, { kind: 'fire' });
      airlock.declare('fire', fireHandle);
      airlock.setHandler(fireHandle, null, ({ args }) => {
        runtimeRef.scheduleClosureCall(args[0], ['a', 'b', 'c'], {});
      });
      const grant = airlock.membrane.createGrant('test');
      grant.add(fireHandle);
      return { onGrantRequest(id) { return id === 'test' ? grant : null; } };
    },
  };

  // The closure drive runs in its own (non-root) slot; its 'done'
  // lifecycle event is the completion signal.
  let closureDone;
  const closureDrove = new Promise((resolve) => { closureDone = resolve; });
  const { runtime, session } = new RuntimeBuilder()
    .onInboundMessage(() => {})
    .capability(cap)
    .build();
  runtime.onSlotLifecycle = (ev) => {
    if (ev.kind === 'done' && ev.slot !== 0) closureDone();
  };
  runtimeRef = runtime;
  await runtime.start();

  const parsed = session.parse(`
    let got = null
    grant "test" {
      fire(${callbackSource})
    }
  `);
  session.setInstruction(0, parsed.startIndex);
  await runtime.run(0);
  await closureDrove;
  const got = session.get(0, 'got');
  await runtime.terminate();
  return got;
}

Deno.test("scheduleClosureCall: rest callback receives the host's full argument list", async () => {
  const got = await driveWith('(...xs) => { got = xs.join(",") }');
  assertEquals(got, 'a,b,c');
});

Deno.test("scheduleClosureCall: fixed-arity callback keeps the declared-count truncation", async () => {
  const got = await driveWith('(first) => { got = first }');
  assertEquals(got, 'a');
});

/**
 * Scope-corruption regression: a slot parked on context.suspend inside a
 * grant block and try/catch while the host repeatedly invokeClosure()s an SS
 * closure that was passed as a call argument and mutates top-level variables;
 * the suspension then rejects.
 *
 * In the original failure, the throw landed, the slot woke, and the catch
 * body's `caught = err.message` died with ASSIGN_UNDEFINED. Because `caught`
 * was a top-level binding, the root scope was unreachable from the woken slot.
 * At suspend the slot had scopeDepth=3 and tryDepth=1; at the error it had
 * scopeDepth=2 and tryDepth=0.
 *
 * If this test fails, the bug is in SandScript. If it passes, reproducing the
 * original corruption requires integration behavior outside SandScript.
 *
 * Run with:
 *   deno task test tests/runtime/suspend_reject_under_closure_load_test.js
 */

import { RuntimeBuilder } from '../../src/runtime/test-harness.js';

function tick(ms = 0) {
  return new Promise((r) => setTimeout(r, ms));
}

async function waitFor(condition, { timeout = 10000, label = 'condition' } = {}) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    if (condition()) return;
    await tick(5);
  }
  throw new Error(`waitFor timed out: ${label}`);
}

Deno.test('suspend reject after invokeClosure pump: catch assigns top-level variable', async () => {
  let stashedReject = null;
  let readClosureHandle = null;
  const handlerErrors = [];

  const { runtime, session, channels } = new RuntimeBuilder()
    .capability({
      name: 'slow-cap',
      setup: (al) => {
        const handle = al.ensureHandle(
          (e) => e.metadata?.kind === 'slow-cap-root',
          () => al.register({}, { kind: 'slow-cap-root' }),
        );
        al.pin(handle);
        al.setHandler(handle, 'start', ({ args, context }) => {
          readClosureHandle = args[0];
          return context.suspend((_resolve, reject) => {
            stashedReject = reject;
          });
        });
        al.declare('SlowCap', handle);
        return {
          onGrantRequest(identifier) {
            if (identifier !== 'slow') return null;
            const grant = al.membrane.createGrant(
              identifier, { kind: 'slow-cap-endorsement' });
            grant.add(handle);
            return grant;
          },
        };
      },
    })
    .onInboundMessage(() => {})
    .build();

  runtime.onHandlerError = (rejection) => { handlerErrors.push(rejection); };

  await runtime.start();

  session.parse(`
    let caught = null
    let pulledCount = 0
    let postReached = false
    grant "slow" {
      let i = 0
      try {
        await SlowCap.start(function() {
          let buf = new Uint8Array(1024)
          let k = 0
          while (k < 1024) { buf[k] = (i + k) % 256; k = k + 1 }
          i = i + 1
          pulledCount = i
          return { value: buf, done: false }
        })
      } catch (err) {
        caught = err.message
      }
      postReached = true
    }
  `);

  runtime.run(0);
  await waitFor(() => stashedReject !== null && readClosureHandle !== null,
    { label: 'slot parked at suspend with read closure captured' });

  // Pump: drive the captured closure 100 times while slot 0 is
  // parked — the P3.4 shape (fetch's runUploadPush pulling the
  // upload body chunk by chunk).
  for (let n = 0; n < 100; n++) {
    const out = await runtime.invokeClosure(readClosureHandle, []);
    if (out?.done !== false) {
      throw new Error(`pump iteration ${n}: unexpected closure return ${JSON.stringify(out)}`);
    }
  }
  if (session.get(0, 'pulledCount') !== 100) {
    throw new Error(`expected pulledCount=100 after pump, got ${session.get(0, 'pulledCount')}`);
  }

  // Now the platform "fetch" fails: reject the suspension.
  stashedReject(new Error('slow-error'));

  await waitFor(() => session.get(0, 'postReached') === true, {
    label: 'grant block completed after reject',
  });

  const caught = session.get(0, 'caught');
  if (caught !== 'slow-error') {
    throw new Error(`expected caught='slow-error', got ${JSON.stringify(caught)}`);
  }
  if (handlerErrors.length > 0) {
    throw new Error(`expected no handler errors, got: ` +
      `${handlerErrors[0]?.error?.message ?? handlerErrors[0]}`);
  }

  await runtime.terminate();
  channels.close();
});

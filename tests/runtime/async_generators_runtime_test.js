/**
 * Async generators under the Runtime (the production driver).
 *
 * The bare-session tests (tests/fuel/async_generators_test.js) drive
 * the spawn queue by hand; these pin the runtime-owned lifecycle:
 *
 *   - next() resumes the generator context through the spawn queue →
 *     _drainPendingSpawned → background drive.
 *   - A generator body awaiting a LINKED JS promise parks and wakes
 *     like any async context (suspendOnPromise machinery).
 *   - A yield settle ends the generator slot's drive with 'await'
 *     (parked, stays allocated); completion ends it with 'done' and
 *     the runtime frees the slot — no double free against the
 *     airlock (freeSlot: false on the settle path).
 *   - An abandoned generator (never exhausted) does not wedge the
 *     runtime or surface handler errors.
 */

import { assertEquals, assert } from "https://deno.land/std@0.208.0/assert/mod.ts";
import { RuntimeBuilder } from '../../src/runtime/test-harness.js';

function tick(ms = 0) { return new Promise(r => setTimeout(r, ms)); }

async function waitFor(condition, { timeout = 2000, label = 'condition' } = {}) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    if (condition()) return;
    await tick(2);
  }
  throw new Error(`waitFor timed out: ${label}`);
}

function capCap(captured) {
  return {
    name: 'cap',
    needs: {},
    setup(airlock) {
      const h = airlock.register({});
      airlock.setHandler(h, 'deferred', ({ args }) => {
        const x = args[0];
        return new Promise((resolve) => {
          setTimeout(() => resolve(x * 10), 0);
        });
      });
      airlock.setHandler(h, 'notify', ({ args }) => {
        captured.notifications.push(args[0]);
        return 0;
      });
      const grant = airlock.membrane.createGrant('cap');
      grant.add(h);
      airlock.declare('Cap', h);
      return {
        onGrantRequest(id) { return id === 'cap' ? grant : null; },
      };
    },
  };
}

async function buildRuntime() {
  const captured = { notifications: [], handlerErrors: [] };
  const { runtime, session } = new RuntimeBuilder()
    .capability(capCap(captured))
    .onInboundMessage(() => {})
    .onHandlerError((rejection) => { captured.handlerErrors.push(rejection); })
    .build();
  await runtime.start();
  return { runtime, session, captured };
}

Deno.test('async generators: runtime drives a body awaiting linked JS promises', async () => {
  const { runtime, session, captured } = await buildRuntime();

  const result = session.parse(`
    grant "cap" {
      async function* g() {
        let a = await Cap.deferred(1)
        yield a
        let b = await Cap.deferred(2)
        yield b
      }
      async function main() {
        let acc = ""
        for await (const v of g()) { acc = acc + v + "," }
        Cap.notify(acc)
      }
      main()
    }
  `);
  session.setInstruction(0, result.startIndex);
  await runtime.run(0);

  await waitFor(() => captured.notifications.length === 1, { label: 'for-await completion' });
  assertEquals(captured.notifications[0], '10,20,');
  assertEquals(captured.handlerErrors.length, 0);

  await runtime.terminate();
});

Deno.test('async generators: queued requests settle in order under the runtime', async () => {
  const { runtime, session, captured } = await buildRuntime();

  const result = session.parse(`
    grant "cap" {
      async function* g() {
        yield await Cap.deferred(1)
        yield await Cap.deferred(2)
        return "end"
      }
      async function main() {
        let it = g()
        let p1 = it.next()
        let p2 = it.next()
        let p3 = it.next()
        let s1 = await p1
        let s2 = await p2
        let s3 = await p3
        Cap.notify("" + s1.value + "|" + s2.value + "|" + s3.value + "," + s3.done)
      }
      main()
    }
  `);
  session.setInstruction(0, result.startIndex);
  await runtime.run(0);

  await waitFor(() => captured.notifications.length === 1, { label: 'queued settle' });
  assertEquals(captured.notifications[0], '10|20|end,true');
  assertEquals(captured.handlerErrors.length, 0);

  await runtime.terminate();
});

Deno.test('async generators: abandoned generator does not wedge the runtime', async () => {
  const { runtime, session, captured } = await buildRuntime();

  const result = session.parse(`
    grant "cap" {
      async function* g() { let i = 0; while (true) { i = i + 1; yield i } }
      async function main() {
        let it = g()
        let first = await it.next()
        Cap.notify(first.value)
      }
      main()
    }
  `);
  session.setInstruction(0, result.startIndex);
  await runtime.run(0);

  await waitFor(() => captured.notifications.length === 1, { label: 'first step' });
  assertEquals(captured.notifications[0], 1);
  assertEquals(captured.handlerErrors.length, 0);

  // The generator is parked at its second yield-park forever; terminate
  // must still resolve cleanly.
  await runtime.terminate();
});

Deno.test('async generators: uncaught body throw surfaces as unhandled rejection when unconsumed', async () => {
  const { runtime, session, captured } = await buildRuntime();

  const result = session.parse(`
    grant "cap" {
      async function* g() { throw new Error("nobody-listens") }
      let it = g()
      let p = it.next()
      Cap.notify("fired")
    }
  `);
  session.setInstruction(0, result.startIndex);
  await runtime.run(0);

  await waitFor(() => captured.notifications.length === 1, { label: 'script completion' });
  // The rejected step promise has no waiter; the runtime's idle drain
  // surfaces it through onHandlerError.
  await waitFor(() => captured.handlerErrors.length === 1, { label: 'unhandled rejection drain' });
  assert(String(captured.handlerErrors[0]?.reason?.message ?? captured.handlerErrors[0]).includes('nobody-listens'));

  await runtime.terminate();
});

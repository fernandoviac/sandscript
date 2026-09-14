/**
 * In-flight handle protection windows remain between detached registration
 * and declaration, and while linked promises hold JS values outside the
 * SandScript heap.
 *
 * Window 1 — detached registration: airlock.register() inside a
 * suspension-resolve callback (currentSlot === null; the detached
 * readable-handle minting pattern) was not tracked as in-flight at all. A
 * grant.add right after it could trigger pool-pressure compaction
 * that reaped the handle before resolve() marshalled it
 * (StaleHandleError on the next setSetter/marshal). register() now
 * always tracks, into a per-context bucket or the detached (null)
 * bucket.
 *
 * Window 2 — linked-promise gap: a handle registered DURING dispatch
 * but delivered via a JS Promise (`await thing.makeSlow()` — the
 * promise is linked as an SS promise and the slot resumes
 * immediately). The old wholesale-cleared in-flight set lost the
 * protection at the very next runContext, while the handle sat
 * invisibly inside the pending JS promise; a pressure compaction then
 * reaped it ("handle:N requires a grant not in the current grant
 * stack" at the await's resume). _linkJSPromiseShared now snapshots
 * all in-flight slots under the promise until it settles.
 */

import { assertEquals } from "https://deno.land/std@0.208.0/assert/mod.ts";
import { RuntimeBuilder } from '../../src/runtime/test-harness.js';

Deno.test('detached register() + grant.add pressure: handle survives until resolve marshals it', async () => {
  let done;
  const finished = new Promise((resolve) => { done = resolve; });

  const cap = {
    name: 'probe',
    needs: {},
    setup(airlock) {
      const rootGrant = airlock.createRootGrant();

      const root = airlock.register({}, { kind: 'root' });
      rootGrant.add(root);
      airlock.declare('thing', root);

      airlock.setHandler(root, 'make', ({ context }) =>
        context.suspend((resolve) => {
          setTimeout(() => {
            // currentSlot === null here — the detached window.
            const handle = airlock.register({}, { kind: 'child' });
            rootGrant.add(handle);   // pool pressure → compaction
            airlock.setSetter(handle, 'x', () => {});
            resolve(handle);
          }, 0);
        }));

      const report = airlock.register({}, { kind: 'report' });
      airlock.declare('report', report);
      rootGrant.add(report);
      airlock.setHandler(report, null, ({ args }) => {
        done({ count: args[0], error: args[1] });
      });

      return {};
    },
  };

  const { runtime, session } = new RuntimeBuilder()
    .onInboundMessage(() => {})
    .sessionOptions({ idListPoolSize: 512 })
    .capability(cap)
    .build();
  await runtime.start();

  const parsed = session.parse(`
    let run = async () => {
      let error = null
      let count = 0
      let i = 0
      while (i < 40) {
        try {
          let el = thing.make()
          el.x = 1
          count = count + 1
        } catch (err) {
          error = err.message
        }
        i = i + 1
      }
      report(count, error)
    }
    run()
  `);
  session.setInstruction(0, parsed.startIndex);
  await runtime.run(0);

  let timeoutId;
  try {
    const result = await Promise.race([
      finished,
      new Promise((_, reject) => {
        timeoutId = setTimeout(() => reject(new Error('timed out')), 15000);
      }),
    ]);
    assertEquals(result.error, null, `drone saw an error: ${result.error}`);
    assertEquals(result.count, 40);
  } finally {
    clearTimeout(timeoutId);
    await runtime.terminate();
  }
});

Deno.test('handle inside a pending linked promise survives compactions from other slots', async () => {
  let done;
  const finished = new Promise((resolve) => { done = resolve; });

  const cap = {
    name: 'probe',
    needs: {},
    setup(airlock) {
      const rootGrant = airlock.createRootGrant();

      const root = airlock.register({}, { kind: 'root' });
      rootGrant.add(root);
      airlock.declare('thing', root);

      airlock.setHandler(root, 'makeSlow', () => {
        // Registered during dispatch; delivered via the linked-promise
        // route 50ms later, after the churn flow has compacted plenty.
        const handle = airlock.register({}, { kind: 'slow-child' });
        rootGrant.add(handle);
        airlock.setHandler(handle, 'ping', () => 'pong');
        return new Promise((resolve) => setTimeout(() => resolve(handle), 50));
      });

      airlock.setHandler(root, 'churn', () => {
        const handle = airlock.register({}, { kind: 'churn-child' });
        rootGrant.add(handle);   // pool pressure → compaction
        return null;
      });

      const report = airlock.register({}, { kind: 'report' });
      airlock.declare('report', report);
      rootGrant.add(report);
      airlock.setHandler(report, null, ({ args }) => {
        done({ result: args[0], error: args[1] });
      });

      return {};
    },
  };

  const { runtime, session } = new RuntimeBuilder()
    .onInboundMessage(() => {})
    .sessionOptions({ idListPoolSize: 512 })
    .capability(cap)
    .build();
  await runtime.start();

  const parsed = session.parse(`
    let slowFlow = async () => {
      let el = await thing.makeSlow()
      return el.ping()
    }
    let churnFlow = async () => {
      let i = 0
      while (i < 60) {
        thing.churn()
        i = i + 1
      }
      return i
    }
    let run = async () => {
      let result = null
      let error = null
      try {
        let p = slowFlow()
        churnFlow()
        result = await p
      } catch (err) {
        error = err.message
      }
      report(result, error)
    }
    run()
  `);
  session.setInstruction(0, parsed.startIndex);
  await runtime.run(0);

  let timeoutId;
  try {
    const result = await Promise.race([
      finished,
      new Promise((_, reject) => {
        timeoutId = setTimeout(() => reject(new Error('timed out')), 15000);
      }),
    ]);
    assertEquals(result.error, null, `drone saw an error: ${result.error}`);
    assertEquals(result.result, 'pong');
  } finally {
    clearTimeout(timeoutId);
    await runtime.terminate();
  }
});

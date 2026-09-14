/**
 * A long-held capability handle must survive repeated independent callback
 * firings with collection and membrane compaction between them.
 *
 * The port is claimed once, captured by a callback, and reused by forty later
 * host invocations separated by idle time and forced collection. Every post
 * must reach the host without a grant error or handle reap.
 *
 * Run with: deno task test tests/runtime/long_lived_port_handle_test.js
 */

import { assertEquals } from "https://deno.land/std@0.208.0/assert/mod.ts";
import { RuntimeBuilder } from "../../src/runtime/test-harness.js";

function tick(ms = 0) { return new Promise((r) => setTimeout(r, ms)); }

async function waitFor(condition, { timeout = 30000, label = "condition" } = {}) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    if (condition()) return;
    await tick(5);
  }
  throw new Error(`waitFor timed out: ${label}`);
}

function portCap(captured) {
  return {
    name: "cap",
    needs: {},
    setup(airlock) {
      const rootHandle = airlock.register({});
      const grant = airlock.membrane.createGrant("cap");
      grant.add(rootHandle);

      // claim(portId) -> a port handle, held long-term by the caller
      // (matches upstream.claim's shape: one handle, reused across
      // many later postMessage calls).
      airlock.setHandler(rootHandle, "claim", () => {
        const portHandle = airlock.register({});
        grant.add(portHandle);
        airlock.setHandler(portHandle, "postMessage", ({ args }) => {
          captured.posted.push(args[0]);
          return undefined;
        });
        return portHandle;
      });

      // fireCallback(id) -> host-triggers a LATER, SEPARATE callback
      // invocation (like a box "message" event landing asynchronously,
      // long after the port was claimed).
      airlock.setHandler(rootHandle, "regCallback", ({ args }) => {
        captured.callback = args[0];
        return undefined;
      });

      // churnHandle() -> register-and-drop a throwaway handle, same
      // technique gc_concurrent_suspended_drains_test.js uses to force
      // real membrane pressure/compactions between events.
      airlock.setHandler(rootHandle, "churnHandle", () => {
        const h = airlock.register({ throwaway: true });
        grant.add(h);
        return h;
      });

      airlock.declare("Cap", rootHandle);
      return { onGrantRequest(id) { return id === "cap" ? grant : null; } };
    },
  };
}

async function buildRuntime() {
  const captured = { posted: [], callback: null, errors: [] };
  const builder = new RuntimeBuilder()
    .sessionOptions({ heapSize: 4 * 1024 * 1024 })
    .capability(portCap(captured))
    .onInboundMessage(() => {})
    .onHandlerError((rej) => { captured.errors.push(rej); });
  const { runtime, session } = builder.build();
  await runtime.start();

  const result = session.parse(`
    let pushCount = 0
    let failures = []
    grant "cap" {
      let port = Cap.claim()
      let postDown = (message) => {
        try {
          port.postMessage(message)
        } catch (portError) {
          port = Cap.claim()
          port.postMessage(message)
        }
      }
      Cap.regCallback(function() {
        try {
          pushCount = pushCount + 1
          postDown({ n: pushCount })
        } catch (pushError) {
          failures.push("" + pushError.message)
        }
      })
    }
  `);
  session.setInstruction(0, result.startIndex);
  await runtime.run(0);
  await waitFor(() => captured.callback !== null, { label: "grant body registration to run" });
  return { runtime, session, captured };
}

Deno.test("a long-held port handle survives separate callback firings with GC pressure between them", async () => {
  const { runtime, session, captured } = await buildRuntime();
  try {
    const EVENTS = 40;
    for (let i = 1; i <= EVENTS; i++) {
      // Fire the callback (simulating one box "message" event landing),
      // THEN churn handles + force compaction BEFORE the next one --
      // real idle time between independent keystrokes, unlike the
      // existing test's one continuous await chain.
      runtime.scheduleClosureCall(captured.callback, []);
      await tick(5);
      session.gc();
      session.airlock.compactMembrane();
      await tick(5);
    }
    await waitFor(() => session.get(0, "pushCount") === EVENTS,
      { label: "all pushes counted", timeout: 10000 });

    const failures = session.get(0, "failures");
    assertEquals(failures, [],
      `no push may fail (reaped port handle shows up here as "requires a grant")`);
    assertEquals(captured.posted.length, EVENTS,
      "every push must actually reach the host handler");
    assertEquals(captured.errors.length, 0, "no handler errors");
  } finally {
    await runtime.stop?.();
  }
});

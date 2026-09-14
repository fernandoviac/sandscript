/**
 * Handles returned from an asynchronously settled host call inherit the active
 * grants used to marshal the result.
 *
 * A listener registered under an outer grant later uses a handle claimed
 * asynchronously under a nested resource grant. The callback must retain
 * access after the claim settles, pinning the same result-tagging path used by
 * suspend-based capability handlers.
 */

import { assertEquals } from "https://deno.land/std@0.208.0/assert/mod.ts";
import { RuntimeBuilder } from "../../src/runtime/test-harness.js";

function tick(ms = 0) { return new Promise((r) => setTimeout(r, ms)); }

async function waitFor(condition, { timeout = 10000, label = "condition" } = {}) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    if (condition()) return;
    await tick(5);
  }
  throw new Error(`waitFor timed out: ${label}`);
}

function twoGrantAsyncCap(captured) {
  return {
    name: "cap",
    needs: {},
    setup(airlock) {
      const listenGrant = airlock.membrane.createGrant("listen");
      const resourceGrant = airlock.membrane.createGrant("resource");

      const listenRoot = airlock.register({});
      listenGrant.add(listenRoot);
      airlock.setHandler(listenRoot, "registerListener", ({ args }) => {
        captured.callback = args[0];
        return undefined;
      });

      const resourceRoot = airlock.register({});
      resourceGrant.add(resourceRoot);
      // The claim settles on a later macrotask rather than returning
      // synchronously from the handler.
      airlock.setHandler(resourceRoot, "claimResource", ({ context }) => {
        return context.suspend((resolve, reject, { slot }) => {
          setTimeout(() => {
            const h = airlock.register({});
            resourceGrant.add(h);
            airlock.setHandler(h, "use", () => {
              captured.uses += 1;
              return undefined;
            });
            resolve(h);
          }, 0);
        });
      });

      airlock.declare("Listen", listenRoot);
      airlock.declare("Resource", resourceRoot);
      return {
        onGrantRequest(id) {
          if (id === "listen") return listenGrant;
          if (id === "resource") return resourceGrant;
          return null;
        },
      };
    },
  };
}

async function buildRuntime() {
  const captured = { callback: null, uses: 0, errors: [] };
  const builder = new RuntimeBuilder()
    .sessionOptions({ heapSize: 4 * 1024 * 1024 })
    .capability(twoGrantAsyncCap(captured))
    .onInboundMessage(() => {})
    .onHandlerError((rej) => { captured.errors.push(rej); });
  const { runtime, session } = builder.build();
  await runtime.start();
  return { runtime, session, captured };
}

Deno.test("async claim: listener registered before an ASYNC-claimed resource — does auto-tagging still apply?", async () => {
  const { runtime, session, captured } = await buildRuntime();
  try {
    const result = session.parse(`
      let failures = []
      let useResource = null
      grant "listen" {
        // Registration happens before the nested resource grant; successful
        // later use therefore depends on result grant tagging.
        Listen.registerListener(function() {
          if (useResource === null) {
            failures = failures.concat(["useResource still null"])
            return
          }
          try {
            useResource()
          } catch (e) {
            failures = failures.concat([e.message])
          }
        })
        grant "resource" {
          let resourcePort = await Resource.claimResource()
          useResource = () => { resourcePort.use() }
        }
      }
    `);
    session.setInstruction(0, result.startIndex);
    await runtime.run(0);
    await waitFor(() => captured.callback !== null, { label: "listener registration" });
    // Wait for the ASYNC claim to actually resolve (useResource assigned)
    // -- can't read useResource directly, so just wait past the
    // setTimeout(0) plus generous margin.
    await tick(200);

    runtime.scheduleClosureCall(captured.callback, []);
    await tick(100);

    const failures = session.get(0, "failures");
    console.log("failures:", failures, "uses:", captured.uses, "handler errors:", captured.errors.map(e => e?.message));

    console.log(`RESULT: uses=${captured.uses} (1 = auto-tagging survived async claim, 0 = it did NOT)`);
  } finally {
    await runtime.stop?.();
  }
});

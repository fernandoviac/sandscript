/**
 * A handle returned by an asynchronous claim must remain authorized after an
 * intervening asynchronous claim suspends and resumes the same context.
 *
 * One grant block claims a port through context.suspend, posts once, awaits a
 * second independently-settled claim, then posts through the first handle
 * again. Both calls must reach the host.
 *
 * Run with: deno task test tests/runtime/async_claim_grant_retention_test.js
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

// Mirrors upstream/swarm.js's real shape: claim() suspends via
// context.suspend + a host-driven async resolve, mintPortHandle adds
// the freshly-minted handle to the SAME cached grant object.
function asyncPortCap(captured) {
  return {
    name: "cap",
    needs: {},
    setup(airlock) {
      const rootHandle = airlock.register({});
      let activeGrant = null;

      function mintPortHandle(portId) {
        const handle = airlock.register({});
        airlock.setHandler(handle, "postMessage", ({ args }) => {
          captured.posted.push({ portId, data: args[0] });
          return undefined;
        });
        if (activeGrant?.active) activeGrant.add(handle);
        return handle;
      }

      airlock.setHandler(rootHandle, "claim", ({ args, context }) => {
        const [portId] = args;
        return context.suspend((resolve, reject, { slot }) => {
          // Settlement happens on a later macrotask, matching an asynchronous
          // host round trip rather than a synchronous handler return.
          setTimeout(() => {
            const handle = mintPortHandle(portId);
            resolve(handle);
          }, 0);
        });
      });

      airlock.declare("Cap", rootHandle);
      return {
        onGrantRequest(id) {
          if (id !== "cap") return null;
          if (activeGrant?.active) return activeGrant;
          const grant = airlock.membrane.createGrant("cap");
          grant.add(rootHandle);
          activeGrant = grant;
          return grant;
        },
      };
    },
  };
}

async function buildRuntime() {
  const captured = { posted: [], errors: [] };
  const builder = new RuntimeBuilder()
    .sessionOptions({ heapSize: 4 * 1024 * 1024 })
    .capability(asyncPortCap(captured))
    .onInboundMessage(() => {})
    .onHandlerError((rej) => { captured.errors.push(rej); });
  const { runtime, session } = builder.build();
  await runtime.start();
  return { runtime, session, captured };
}

Deno.test("async claim retains a prior handle across an intervening awaited claim", async () => {
  const { runtime, session, captured } = await buildRuntime();
  try {
    const result = session.parse(`
      let pushCount = 0
      let failCount = 0
      let failures = []
      let done = false
      grant "cap" {
        let port = await Cap.claim("page-home")
        port.postMessage({ n: 1 })
        pushCount = 1
        let scratch = await Cap.claim("scratch-0")
        scratch = null
        try {
          port.postMessage({ n: 2 })
          pushCount = 2
        } catch (pushError) {
          failCount = 1
          failures = failures.concat([pushError.message])
        }
        done = true
      }
    `);
    session.setInstruction(0, result.startIndex);
    await runtime.run(0);

    await waitFor(() => session.get(0, "done") === true,
      { label: "grant body completion", timeout: 10000 });

    const failures = session.get(0, "failures");
    const pushCount = session.get(0, "pushCount");
    console.log("pushCount:", pushCount, "failures:", failures);
    console.log("posted:", JSON.stringify(captured.posted));
    console.log("handler errors:", captured.errors.map((e) => e?.message ?? String(e)));

    assertEquals(failures, [],
      `second postMessage on the pre-suspend-minted handle should not fail: ${JSON.stringify(failures)}`);
    assertEquals(pushCount, 2, "both pushes must succeed");
    assertEquals(captured.posted.length, 2, "both pushes must reach the host handler");
  } finally {
    await runtime.stop?.();
  }
});

/**
 * Callback contexts restore the grants captured when the closure is registered.
 *
 * registerClosure records getActiveGrantIds(callerContext) when a closure is
 * passed to the host. setupCallbackContext later seeds each firing with only
 * those recorded grants.
 *
 * The first case registers a listener before entering a sibling resource grant,
 * so assigning a resource-backed function later must not broaden the listener's
 * authority. The control registers while both grants are active and must retain
 * access. Together they pin registration-time capture rather than timing,
 * suspension, or retry behavior.
 *
 * Run with: deno task test tests/runtime/closure_grant_capture_test.js
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

// Two independent grant identifiers: "listen" (mints a listener-style
// registration point, mirrors "box") and "resource" (mints a handle
// gated on ITS OWN grant, mirrors "upstream"'s port).
function twoGrantCap(captured) {
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
      airlock.setHandler(resourceRoot, "mintResource", () => {
        const h = airlock.register({});
        resourceGrant.add(h);
        airlock.setHandler(h, "use", () => {
          captured.uses += 1;
          return undefined;
        });
        return h;
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
    .capability(twoGrantCap(captured))
    .onInboundMessage(() => {})
    .onHandlerError((rej) => { captured.errors.push(rej); });
  const { runtime, session } = builder.build();
  await runtime.start();
  return { runtime, session, captured };
}

Deno.test("closure captures grants at REGISTRATION time: registering before the resource grant means the resource is unreachable forever", async () => {
  const { runtime, session, captured } = await buildRuntime();
  try {
    const result = session.parse(`
      let failures = []
      // A module-scope function is assigned after the callback is registered.
      // Visibility of that function must not broaden the callback's grants.
      let useResource = null
      grant "listen" {
        // "resource" is not active at registration time.
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
      }
      // This sibling grant is deliberately not nested inside "listen".
      // marshalResultWithGrantTagging may add every grant active during a
      // returned handle's call, so nesting would make the resource reachable
      // and would not exercise registration-time capture.
      grant "resource" {
        let resourcePort = Resource.mintResource()
        useResource = () => { resourcePort.use() }
      }
    `);
    session.setInstruction(0, result.startIndex);
    await runtime.run(0);
    await waitFor(() => captured.callback !== null, { label: "listener registration" });

    // Fire the callback -- a FRESH context each time, seeded only from
    // capturedGrantSlots (captured at registration, before "resource"
    // existed).
    runtime.scheduleClosureCall(captured.callback, []);
    await tick(50);

    const failures = session.get(0, "failures");
    console.log("failures:", failures, "uses:", captured.uses, "handler errors:", captured.errors.map(e => e?.message));

    // EXPECTED (proving the mechanism): the resource is unreachable --
    // either the SS-level try/catch caught a grant error (visible in
    // `failures`), or the whole callback aborted before running any SS
    // code at all (visible as a handler error / zero uses). Either way,
    // `Resource.use()` must never actually have SUCCEEDED.
    assertEquals(captured.uses, 0,
      "resource.use() must NOT succeed — the listener never captured the resource grant");
  } finally {
    await runtime.stop?.();
  }
});

Deno.test("control: registering the listener AFTER entering the resource grant DOES capture it, and use() succeeds", async () => {
  const { runtime, session, captured } = await buildRuntime();
  try {
    const result = session.parse(`
      let failures = []
      grant "listen" {
        grant "resource" {
          let resourcePort = Resource.mintResource()
          // Registered AFTER "resource" is entered -- capturedGrantSlots
          // now includes BOTH listen and resource.
          Listen.registerListener(function() {
            try {
              resourcePort.use()
            } catch (e) {
              failures = failures.concat([e.message])
            }
          })
        }
      }
    `);
    session.setInstruction(0, result.startIndex);
    await runtime.run(0);
    await waitFor(() => captured.callback !== null, { label: "listener registration" });

    runtime.scheduleClosureCall(captured.callback, []);
    await tick(50);

    const failures = session.get(0, "failures");
    console.log("control failures:", failures, "uses:", captured.uses);

    assertEquals(failures, [], "no grant error expected");
    assertEquals(captured.uses, 1, "resource.use() must succeed when both grants were captured");
  } finally {
    await runtime.stop?.();
  }
});

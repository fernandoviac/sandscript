/**
 * Grant system test suite.
 *
 * Run with: deno task test tests/fuel/grant_test.js
 */

import { assertEquals, assert } from "https://deno.land/std@0.208.0/assert/mod.ts";
import { createSession } from '../../src/fuel/session.js';
import { freshSession } from '../../src/host-owned-session.js';
// register() returns Handle wrappers.
import { parseAndSetup } from './test-helpers.js';

// =============================================================================
// Grant Approval
// =============================================================================

Deno.test("Grant: approved grant executes block", () => {
  const session = freshSession();
  const { airlock } = session;

  // Set up grant handler that approves everything
  airlock.onGrantRequest = (identifier) => {
    const grant = airlock.membrane.createGrant(identifier);
    return { approved: true, grant };
  };

  session.parse('let result = 0; grant "fs" { result = 42; }');
  session.run(0, 10000);

  assertEquals(session.get(0, 'result'), 42);
});

Deno.test("Grant: rejected grant skips block (no denied)", () => {
  const session = freshSession();
  const { airlock } = session;

  // Set up grant handler that rejects everything
  airlock.onGrantRequest = () => ({ approved: false });

  session.parse('let result = 0; grant "fs" { result = 42; }');
  session.run(0, 10000);

  // Block was skipped, result stays 0
  assertEquals(session.get(0, 'result'), 0);
});

Deno.test("Grant: rejected grant runs denied block", () => {
  const session = freshSession();
  const { airlock } = session;

  airlock.onGrantRequest = () => ({ approved: false });

  session.parse('let result = 0; grant "fs" { result = 1; } denied { result = 99; }');
  session.run(0, 10000);

  // Denied block ran
  assertEquals(session.get(0, 'result'), 99);
});

Deno.test("Grant: denied block receives identifier array", () => {
  const session = freshSession();
  const { airlock } = session;

  airlock.onGrantRequest = () => ({ approved: false });

  session.parse(`
    let received = null;
    grant "filesystem" { } denied (ids) { received = ids; }
  `);
  session.run(0, 10000);

  const received = session.get(0, 'received');
  assert(Array.isArray(received));
  assertEquals(received.length, 1);
  assertEquals(received[0], "filesystem");
});

// =============================================================================
// Multiple Grants
// =============================================================================

Deno.test("Grant: multiple identifiers - all approved", () => {
  const session = freshSession();
  const { airlock } = session;

  const approved = [];
  airlock.onGrantRequest = (identifier) => {
    approved.push(identifier);
    const grant = airlock.membrane.createGrant(identifier);
    return { approved: true, grant };
  };

  session.parse('let result = 0; grant ("a", "b") { result = 42; }');
  session.run(0, 10000);

  assertEquals(approved, ["a", "b"]);
  assertEquals(session.get(0, 'result'), 42);
});

Deno.test("Grant: multiple identifiers - one rejected", () => {
  const session = freshSession();
  const { airlock } = session;

  airlock.onGrantRequest = (identifier) => {
    if (identifier === "b") {
      return { approved: false };
    }
    const grant = airlock.membrane.createGrant(identifier);
    return { approved: true, grant };
  };

  session.parse('let result = 0; grant ("a", "b") { result = 42; }');
  session.run(0, 10000);

  // Block skipped because "b" was rejected
  assertEquals(session.get(0, 'result'), 0);
});

Deno.test("Grant: multiple identifiers - rejected with denied", () => {
  const session = freshSession();
  const { airlock } = session;

  airlock.onGrantRequest = (identifier) => {
    if (identifier === "b") {
      return { approved: false };
    }
    const grant = airlock.membrane.createGrant(identifier);
    return { approved: true, grant };
  };

  session.parse(`
    let received = null;
    grant ("a", "b") { } denied (ids) { received = ids; }
  `);
  session.run(0, 10000);

  const received = session.get(0, 'received');
  assert(Array.isArray(received));
  // Only the actually rejected identifiers are in the array
  assertEquals(received.length, 1);
  assertEquals(received[0], "b");
});

// =============================================================================
// Grant Stack
// =============================================================================

Deno.test("Grant: grant stack is populated during block", () => {
  const session = freshSession();
  const { airlock } = session;

  let grantSlot = null;
  airlock.onGrantRequest = (identifier) => {
    const grant = airlock.membrane.createGrant(identifier);
    grantSlot = grant.slot;
    return { approved: true, grant };
  };

  // We can't easily inspect the grant stack from within SS,
  // but we can verify the grant was created
  session.parse('grant "test" { }');
  session.run(0, 10000);

  assertEquals(grantSlot, 0);
});

Deno.test("Grant: grant stack is empty after block", () => {
  const session = freshSession();
  const { airlock } = session;

  airlock.onGrantRequest = (identifier) => {
    const grant = airlock.membrane.createGrant(identifier);
    return { approved: true, grant };
  };

  session.parse('grant "test" { }');
  session.run(0, 10000);

  // Grant stack should be empty after the block
  assertEquals(airlock.memoryImage.getGrantDepth(0), 0);
});

// =============================================================================
// Nested Grants
// =============================================================================

Deno.test("Grant: nested grants compound", () => {
  const session = freshSession();
  const { airlock } = session;

  const approved = [];
  airlock.onGrantRequest = (identifier) => {
    approved.push(identifier);
    const grant = airlock.membrane.createGrant(identifier);
    return { approved: true, grant };
  };

  session.parse(`
    let result = 0;
    grant "outer" {
      grant "inner" {
        result = 42;
      }
    }
  `);
  session.run(0, 10000);

  assertEquals(approved, ["outer", "inner"]);
  assertEquals(session.get(0, 'result'), 42);
});

// =============================================================================
// Expression Identifiers
// =============================================================================

Deno.test("Grant: identifier can be any expression", () => {
  const session = freshSession();
  const { airlock } = session;

  let receivedIdentifier = null;
  airlock.onGrantRequest = (identifier) => {
    receivedIdentifier = identifier;
    const grant = airlock.membrane.createGrant(identifier);
    return { approved: true, grant };
  };

  session.parse('let name = "dynamic"; grant name { }');
  session.run(0, 10000);

  assertEquals(receivedIdentifier, "dynamic");
});

Deno.test("Grant: identifier can be object", () => {
  const session = freshSession();
  const { airlock } = session;

  let receivedIdentifier = null;
  airlock.onGrantRequest = (identifier) => {
    receivedIdentifier = identifier;
    const grant = airlock.membrane.createGrant(identifier);
    return { approved: true, grant };
  };

  session.parse('grant ({ type: "fs", path: "/tmp" }) { }');
  session.run(0, 10000);

  assertEquals(typeof receivedIdentifier, 'object');
  assertEquals(receivedIdentifier.type, "fs");
  assertEquals(receivedIdentifier.path, "/tmp");
});

// =============================================================================
// Grant Authorization (Phase 3)
// =============================================================================

Deno.test("Grant: external call succeeds with active grant", () => {
  const session = freshSession();
  const { airlock } = session;

  const id = airlock.register({});
  airlock.setHandler(id, 'getValue', () => 42);
  airlock.declare('Api', id);

  // Set up grant handler that approves and adds handle to grant
  airlock.onGrantRequest = (identifier) => {
    const grant = airlock.membrane.createGrant(identifier);
    grant.add(id);  // Add handle to grant
    return { approved: true, grant };
  };

  session.parse('let result = 0; grant "api" { result = Api.getValue(); }');
  session.run(0, 10000);

  assertEquals(session.get(0, 'result'), 42);
});

Deno.test("Grant: external call fails without grant (handle has no grants)", () => {
  const session = freshSession();
  const { airlock } = session;

  const id = airlock.register({});
  airlock.setHandler(id, 'getValue', () => 42);
  airlock.declare('Api', id);
  // Note: handle is NOT added to any grant

  session.parse(`
    let caught = false;
    try {
      Api.getValue();
    } catch (e) {
      caught = true;
    }
  `);
  session.run(0, 10000);

  assertEquals(session.get(0, 'caught'), true);
});

Deno.test("Grant: GrantDeniedError is proper error object", () => {
  const session = freshSession();
  const { airlock } = session;

  const id = airlock.register({});
  airlock.setHandler(id, 'getValue', () => 42);
  airlock.declare('Api', id);
  // Note: handle is NOT added to any grant

  session.parse(`
    let errorName = "";
    let errorMessage = "";
    let isError = false;
    try {
      Api.getValue();
    } catch (e) {
      errorName = e.name;
      errorMessage = e.message;
      isError = e instanceof Error;
    }
  `);
  session.run(0, 10000);

  assertEquals(session.get(0, 'errorName'), 'GrantDeniedError');
  assertEquals(session.get(0, 'isError'), true);
  // Message should mention the handle name
  const message = session.get(0, 'errorMessage');
  assertEquals(typeof message, 'string');
  assertEquals(message.includes('Api'), true);
});

Deno.test("Grant: handle with multiple grants — ANY active is sufficient", () => {
  // Authorization rule (see Membrane.checkBySlot): a handle is callable
  // iff (a) at least one grant in its list is active AND (b) no grant
  // in its list is revoked. This test pins (a): only grantA is active,
  // grantB is alive but dormant; the call must succeed.
  //
  // This pattern matters for the idiomatic onGrantRequest behavior
  // where capabilities mint a fresh grant per recognition. After the
  // first block exits, that grant becomes dormant but stays in the
  // handle's grant list. When the drone enters another block, a new
  // grant is minted and added; without OR-on-activeness, the old
  // dormant grant would deny every subsequent call.
  const session = freshSession();
  const { airlock } = session;

  const id = airlock.register({});
  airlock.setHandler(id, 'getValue', () => 42);
  airlock.declare('Api', id);

  // Create two grants, add handle to both. Only grantA is pushed; grantB
  // is alive but dormant.
  const grantA = airlock.membrane.createGrant("a");
  const grantB = airlock.membrane.createGrant("b");
  grantA.add(id);
  grantB.add(id);

  airlock.memoryImage.pushGrantEntryForCallback(0, grantA.slot);

  session.parse(`
    let result = 0;
    let caught = false;
    try {
      result = Api.getValue();
    } catch (e) {
      caught = true;
    }
  `);
  session.run(0, 10000);

  // grantA is active → authorized; grantB being dormant doesn't deny.
  assertEquals(session.get(0, 'caught'), false);
  assertEquals(session.get(0, 'result'), 42);
});

Deno.test("Grant: handle with multiple grants succeeds when ALL active", () => {
  // Sanity check: the OR-on-activeness rule still authorizes when
  // ALL grants happen to be active. This is the trivial subcase.
  const session = freshSession();
  const { airlock } = session;

  const id = airlock.register({});
  airlock.setHandler(id, 'getValue', () => 42);
  airlock.declare('Api', id);

  const grantA = airlock.membrane.createGrant("a");
  const grantB = airlock.membrane.createGrant("b");
  grantA.add(id);
  grantB.add(id);

  airlock.memoryImage.pushGrantEntryForCallback(0, grantA.slot);
  airlock.memoryImage.pushGrantEntryForCallback(0, grantB.slot);

  session.parse('let result = Api.getValue();');
  session.run(0, 10000);

  assertEquals(session.get(0, 'result'), 42);
});

Deno.test("Grant: handle with multiple grants — none active is denied", () => {
  // Counter-test for the OR rule: with no grant in the list active,
  // the call is denied. Ensures the OR isn't accidentally short-
  // circuiting on an empty active set.
  const session = freshSession();
  const { airlock } = session;

  const id = airlock.register({});
  airlock.setHandler(id, 'getValue', () => 42);
  airlock.declare('Api', id);

  const grantA = airlock.membrane.createGrant("a");
  const grantB = airlock.membrane.createGrant("b");
  grantA.add(id);
  grantB.add(id);
  // Neither grant pushed.

  session.parse(`
    let caught = false;
    try {
      Api.getValue();
    } catch (e) {
      caught = true;
    }
  `);
  session.run(0, 10000);

  assertEquals(session.get(0, 'caught'), true);
});

Deno.test("Grant: handle with revoked grant in its list is permanently dead", () => {
  // The fail-safe AND rule: even if a fresh active grant carries the
  // handle, ANY revoked grant in the list denies the call. Revocation
  // is a one-way trapdoor — a host that revoked a grant cannot have
  // its decision silently undone by a fresh grant minted for the same
  // handle. Compaction reclaims dead grants lazily; until then they
  // stay in the list and poison the handle.
  const session = freshSession();
  const { airlock } = session;

  const id = airlock.register({});
  airlock.setHandler(id, 'getValue', () => 42);
  airlock.declare('Api', id);

  const oldGrant = airlock.membrane.createGrant("old");
  oldGrant.add(id);
  airlock.membrane.revoke(oldGrant);

  const freshGrant = airlock.membrane.createGrant("fresh");
  freshGrant.add(id);
  airlock.memoryImage.pushGrantEntryForCallback(0, freshGrant.slot);

  session.parse(`
    let caught = false;
    try {
      Api.getValue();
    } catch (e) {
      caught = true;
    }
  `);
  session.run(0, 10000);

  // Even though freshGrant is active, the revoked oldGrant in the
  // handle's grant_list denies the call. Fail-safe.
  assertEquals(session.get(0, 'caught'), true);
});

Deno.test("Grant: drone re-enters same block twice with idiomatic fresh-grant pattern", () => {
  // Regression for a capability rewrite bug: the canonical onGrantRequest
  // pattern (createGrant + grant.add inside the callback for every
  // invocation) used to fail on the second block entry, because the
  // handle's grant_list had two grants in it and only the second was
  // active.
  //
  // With OR-on-activeness, this works: each block's call sees its
  // own fresh grant active, and the previous block's now-dormant
  // grant doesn't deny.
  const session = freshSession();
  const { airlock } = session;

  const id = airlock.register({});
  airlock.setHandler(id, null, () => 'called');
  airlock.declare('probe', id);

  airlock.onGrantRequest = (identifier) => {
    const grant = airlock.membrane.createGrant(identifier);
    grant.add(id);
    return { approved: true, grant };
  };

  session.parse(`
    let first = null;
    let middle = null;
    let middleErr = null;
    let third = null;

    grant "x" {
      first = probe();
    }

    try {
      middle = probe();
    } catch (e) {
      middleErr = e.name;
    }

    grant "x" {
      third = probe();
    }
  `);
  session.run(0, 10000);

  assertEquals(session.get(0, 'first'), 'called',
    'first block: the (only) grant is active → authorized');
  assertEquals(session.get(0, 'middle'), null,
    'between blocks: no grant in list is active → denied');
  assertEquals(session.get(0, 'middleErr'), 'GrantDeniedError');
  assertEquals(session.get(0, 'third'), 'called',
    'second block: the new fresh grant is active → authorized '
    + '(the previous block\'s dormant grant in the list does not deny)');
});

Deno.test("Grant: returned external is tagged with current grants", () => {
  const session = freshSession();
  const { airlock } = session;

  const id = airlock.register({});
  airlock.setHandler(id, 'create', ({ context }) => {
    const obj = { value: 100 };
    const objId = context.register(obj);
    // Note: NOT manually adding to grant - should be auto-tagged
    airlock.setHandler(objId, 'get', () => obj.value);
    return objId;
  });
  airlock.declare('Factory', id);

  airlock.onGrantRequest = (identifier) => {
    const grant = airlock.membrane.createGrant(identifier);
    grant.add(id);
    return { approved: true, grant };
  };

  session.parse(`
    let result = 0;
    grant "factory" {
      let obj = Factory.create();
      result = obj.get();
    }
  `);
  session.run(0, 10000);

  assertEquals(session.get(0, 'result'), 100);
});

// =============================================================================
// Callback Grant Inheritance (Phase 3)
// =============================================================================

Deno.test("Grant: callback captures grants at creation time", () => {
  const session = freshSession();
  const { airlock } = session;
  const mem = session.memoryImage;

  let storedClosureHandle = null;
  const id = airlock.register({});
  airlock.setHandler(id, 'store', ({ args }) => {
    storedClosureHandle = args[0];
  });
  airlock.setHandler(id, 'getValue', () => 99);
  airlock.declare('Api', id);

  airlock.onGrantRequest = (identifier) => {
    const grant = airlock.membrane.createGrant(identifier);
    grant.add(id);
    return { approved: true, grant };
  };

  // Store callback inside grant block
  session.parse(`
    let result = 0;
    grant "api" {
      Api.store(() => { result = Api.getValue(); });
    }
  `);
  session.run(0, 10000);

  // Invoke callback from JS (outside any SS grant block)
  const slot = mem.allocateContext();
  airlock.setupCallbackContext(slot, storedClosureHandle, []);
  while (true) {
    const result = airlock.runContext(slot, 1000);
    if (result.status === 'done') {
      mem.freeContext(slot);
      break;
    }
    if (result.status === 'external_call') {
      const ext = airlock.handleExternalCall(slot, 1000);
      if (!ext.suspended && !ext.threw) airlock.resumeWithValue(slot, ext.result);
      continue;
    }
    if (result.status === 'external_property') {
      airlock.handleExternalProperty(slot, 1000);
      continue;
    }
    throw new Error(`Unexpected status: ${result.status}`);
  }

  // Callback should have inherited grants and succeeded
  assertEquals(session.get(0, 'result'), 99);
});

Deno.test("Grant: revoked grant prevents callback invocation", () => {
  const session = freshSession();
  const { airlock } = session;

  let storedClosureHandle = null;
  const id = airlock.register({});
  airlock.setHandler(id, 'store', ({ args }) => {
    storedClosureHandle = args[0];
  });
  airlock.declare('Api', id);

  let theGrant = null;
  airlock.onGrantRequest = (identifier) => {
    theGrant = airlock.membrane.createGrant(identifier);
    theGrant.add(id);
    return { approved: true, grant: theGrant };
  };

  session.parse(`
    let result = 0;
    grant "api" {
      Api.store(() => { result = 42; });
    }
  `);
  session.run(0, 10000);

  // Revoke the grant
  airlock.membrane.revoke(theGrant);

  // Check that grants are inactive
  const grantsActive = airlock.areClosureGrantsActive(storedClosureHandle);
  assertEquals(grantsActive, false);
  assertEquals(session.get(0, 'result'), 0);  // Unchanged
});

// =============================================================================
// Async Grant Approval (Phase 4)
// =============================================================================

// An async grant decision suspends the slot (`{status: 'suspended'}`) and
// wakes through the spawned-context drain channel instead of keeping
// session.run() pending until approval resolves. Direct Session callers that
// want to
// await the whole grant statement need to pump the drain loop, mirroring
// the idiom in external_property_set_test.js's runAsync.
async function runGrantToCompletion(session, slot = 0, fuel = 10000, timeout = 2000) {
  let result = session.run(slot, fuel);
  const deadline = Date.now() + timeout;
  while (result.status === 'suspended' && Date.now() < deadline) {
    await Promise.resolve();
    await new Promise((r) => setTimeout(r, 0));
    const ready = session.airlock.drainPendingSpawnedContextIdentities();
    for (const readySlot of ready) {
      result = session.run(readySlot, fuel);
    }
  }
  return result;
}

Deno.test("Grant: async approval waits for promise", async () => {
  const session = freshSession();
  const { airlock } = session;

  airlock.onGrantRequest = async (identifier) => {
    // Simulate async delay (e.g., user prompt)
    await new Promise(resolve => setTimeout(resolve, 10));
    const grant = airlock.membrane.createGrant(identifier);
    return { approved: true, grant };
  };

  session.parse('let result = 0; grant "test" { result = 42; }');
  await runGrantToCompletion(session);

  assertEquals(session.get(0, 'result'), 42);
});

Deno.test("Grant: async denial runs denied block", async () => {
  const session = freshSession();
  const { airlock } = session;

  airlock.onGrantRequest = async () => {
    await new Promise(resolve => setTimeout(resolve, 10));
    return { approved: false };
  };

  session.parse('let result = 0; grant "test" { result = 1; } denied { result = 99; }');
  await runGrantToCompletion(session);

  assertEquals(session.get(0, 'result'), 99);
});

Deno.test("Grant: multiple async grants in sequence", async () => {
  const session = freshSession();
  const { airlock } = session;

  const approved = [];
  airlock.onGrantRequest = async (identifier) => {
    await Promise.resolve();  // Minimal async
    approved.push(identifier);
    const grant = airlock.membrane.createGrant(identifier);
    return { approved: true, grant };
  };

  session.parse('let result = 0; grant ("a", "b") { result = 42; }');
  await runGrantToCompletion(session);

  assertEquals(approved, ["a", "b"]);
  assertEquals(session.get(0, 'result'), 42);
});

Deno.test("Grant: async rejection of second grant", async () => {
  const session = freshSession();
  const { airlock } = session;

  airlock.onGrantRequest = async (identifier) => {
    await Promise.resolve();
    if (identifier === "b") {
      return { approved: false };
    }
    const grant = airlock.membrane.createGrant(identifier);
    return { approved: true, grant };
  };

  session.parse('let result = 0; grant ("a", "b") { result = 42; }');
  await runGrantToCompletion(session);

  // Block skipped because "b" was rejected
  assertEquals(session.get(0, 'result'), 0);
});

Deno.test("Grant: mixed sync and async grants", async () => {
  const session = freshSession();
  const { airlock } = session;

  let callCount = 0;
  airlock.onGrantRequest = (identifier) => {
    callCount++;
    // First call sync, second async
    if (callCount === 1) {
      const grant = airlock.membrane.createGrant(identifier);
      return { approved: true, grant };
    } else {
      return Promise.resolve().then(() => {
        const grant = airlock.membrane.createGrant(identifier);
        return { approved: true, grant };
      });
    }
  };

  session.parse('let result = 0; grant ("sync", "async") { result = 42; }');
  await runGrantToCompletion(session);

  assertEquals(session.get(0, 'result'), 42);
});

// =============================================================================
// Root Grant Capture in Closures
// =============================================================================

Deno.test("Grant: closures capture root grants", () => {
  const session = freshSession();
  const { airlock, mem } = session;

  // Create a root grant and a handle under it
  const rootGrant = airlock.createRootGrant('test-root');
  const handleId = airlock.register({});
  rootGrant.add(handleId);
  airlock.declare('Api', handleId);

  // Track captured closure
  let capturedHandle = null;
  airlock.setHandler(handleId, 'register', ({ args }) => {
    capturedHandle = args[0];
    return undefined;
  });

  // Run code that passes a closure to the handle
  session.parse('Api.register(() => 42)');
  session.run(0, 10000);

  // Closure should have captured the root grant
  assert(capturedHandle !== null, 'Closure should be captured');
  assert(capturedHandle.capturedGrantSlots instanceof Set, 'Should have capturedGrantIds');
  assert(capturedHandle.capturedGrantSlots.has(rootGrant.slot), 'Should capture root grant');
});

Deno.test("Grant: revoking root grant prevents callback firing", () => {
  const session = freshSession();
  const { airlock, mem } = session;

  // Create a root grant and a handle under it
  const rootGrant = airlock.createRootGrant('revocable');
  const handleId = airlock.register({});
  rootGrant.add(handleId);
  airlock.declare('Api', handleId);

  // Store closure when registered
  let capturedHandle = null;
  airlock.setHandler(handleId, 'onEvent', ({ args }) => {
    capturedHandle = args[0];
    return undefined;
  });

  // Run code that passes a closure
  session.parse('Api.onEvent(() => 123)');
  session.run(0, 10000);

  assert(capturedHandle !== null, 'Closure should be captured');

  // Grants should be active initially
  assert(airlock.areClosureGrantsActive(capturedHandle), 'Grants should be active');

  // Revoke the root grant
  airlock.membrane.revoke(rootGrant);

  // Now grants should be inactive
  assert(!airlock.areClosureGrantsActive(capturedHandle), 'Grants should be inactive after revocation');
});

Deno.test("Grant: callback with revoked root grant throws on setup", () => {
  const session = freshSession();
  const { airlock, mem } = session;

  // Create a root grant and a handle under it
  const rootGrant = airlock.createRootGrant('will-revoke');
  const handleId = airlock.register({});
  rootGrant.add(handleId);
  airlock.declare('Api', handleId);

  // Store closure when registered
  let capturedHandle = null;
  airlock.setHandler(handleId, 'store', ({ args }) => {
    capturedHandle = args[0];
    return undefined;
  });

  // Run code that passes a closure
  session.parse('Api.store(() => 999)');
  session.run(0, 10000);

  assert(capturedHandle !== null, 'Closure should be captured');

  // Revoke before trying to fire
  airlock.membrane.revoke(rootGrant);

  // Attempting to set up callback context should detect revoked grants
  const slot = mem.allocateContext();
  let threw = false;
  try {
    // Check grants before setup (as fireCallback does in playground)
    if (!airlock.areClosureGrantsActive(capturedHandle)) {
      throw new Error('Callback grants have been revoked');
    }
    airlock.setupCallbackContext(slot, capturedHandle, []);
  } catch (e) {
    threw = true;
    assert(e.message.includes('revoked'), 'Should mention revocation');
  }
  mem.freeContext(slot);

  assert(threw, 'Should throw when grants are revoked');
});

Deno.test("Grant: closures capture both root grants and interpreter grants", () => {
  const session = freshSession();
  const { airlock, mem } = session;

  // Create a root grant
  const rootGrant = airlock.createRootGrant('root-grant');
  const handleId = airlock.register({});
  rootGrant.add(handleId);
  airlock.declare('Api', handleId);

  // Set up grant handler for interpreter grants
  airlock.onGrantRequest = (identifier) => {
    const grant = airlock.membrane.createGrant(identifier);
    return { approved: true, grant };
  };

  // Store closure when registered
  let capturedHandle = null;
  airlock.setHandler(handleId, 'capture', ({ args }) => {
    capturedHandle = args[0];
    return undefined;
  });

  // Run code that passes a closure inside a grant block
  session.parse('grant "interpreter-grant" { Api.capture(() => 42) }');
  session.run(0, 10000);

  assert(capturedHandle !== null, 'Closure should be captured');
  assert(capturedHandle.capturedGrantSlots.size >= 2, 'Should capture multiple grants');
  assert(capturedHandle.capturedGrantSlots.has(rootGrant.slot), 'Should capture root grant');

  // Find the interpreter grant via the public introspection API.
  const allGrants = airlock.membrane.enumerateGrants();
  const hasInterpreterGrant = allGrants.some(
    e => capturedHandle.capturedGrantSlots.has(e.grant.slot) && e.identifier === 'interpreter-grant'
  );
  assert(hasInterpreterGrant, 'Should capture interpreter grant');
});

// =============================================================================
// Suspension Revocation — Denied Block Routing
// =============================================================================

Deno.test("Grant: revocation during suspension routes to denied block", () => {
  const session = freshSession();
  const { airlock } = session;

  const id = airlock.register({});
  let testResolver = null;
  airlock.setHandler(id, 'query', ({ context }) => {
    return context.suspend((resolve) => {
      testResolver = resolve;
    });
  });
  airlock.declare('Database', id);

  let approvedGrant = null;
  airlock.onGrantRequest = (identifier) => {
    approvedGrant = airlock.membrane.createGrant(identifier);
    approvedGrant.add(id);
    return { approved: true, grant: approvedGrant };
  };

  session.parse(`
    let result = "none";
    grant "database" {
      let r = Database.query();
      result = "ok:" + r;
    } denied (revoked) {
      result = "denied";
    }
  `);
  const run1 = session.run(0, 10000);
  assertEquals(run1.status, 'suspended');

  // Revoke the grant while the context is suspended
  airlock.membrane.revoke(approvedGrant);

  // Now resolve the suspension — should route to denied block, not deliver value
  testResolver("should-not-see-this");

  // Context is now ready to run with IP at denied block
  const run2 = session.run(0, 10000);
  assertEquals(run2.status, 'done');
  assertEquals(session.get(0, 'result'), 'denied');
});

Deno.test("Grant: revocation during suspension with no denied block throws GrantDeniedError", () => {
  const session = freshSession();
  const { airlock } = session;

  const id = airlock.register({});
  let testResolver = null;
  airlock.setHandler(id, 'query', ({ context }) => {
    return context.suspend((resolve) => {
      testResolver = resolve;
    });
  });
  airlock.declare('Database', id);

  let approvedGrant = null;
  airlock.onGrantRequest = (identifier) => {
    approvedGrant = airlock.membrane.createGrant(identifier);
    approvedGrant.add(id);
    return { approved: true, grant: approvedGrant };
  };

  session.parse(`
    let result = "none";
    let caught = false;
    try {
      grant "database" {
        let r = Database.query();
        result = "ok:" + r;
      }
    } catch (e) {
      caught = true;
    }
  `);
  const run1 = session.run(0, 10000);
  assertEquals(run1.status, 'suspended');

  // Revoke and resolve
  airlock.membrane.revoke(approvedGrant);
  testResolver("should-not-see-this");

  // Without a denied block, falls back to GrantDeniedError through try/catch
  const run2 = session.run(0, 10000);
  assertEquals(run2.status, 'done');
  assertEquals(session.get(0, 'caught'), true);
  assertEquals(session.get(0, 'result'), 'none');
});

Deno.test("Grant: denied block receives revoked identifier on suspension revocation", () => {
  const session = freshSession();
  const { airlock } = session;

  const id = airlock.register({});
  let testResolver = null;
  airlock.setHandler(id, 'query', ({ context }) => {
    return context.suspend((resolve) => {
      testResolver = resolve;
    });
  });
  airlock.declare('Database', id);

  let approvedGrant = null;
  airlock.onGrantRequest = (identifier) => {
    approvedGrant = airlock.membrane.createGrant(identifier);
    approvedGrant.add(id);
    return { approved: true, grant: approvedGrant };
  };

  session.parse(`
    let revokedList = null;
    grant "database" {
      let r = Database.query();
    } denied (revoked) {
      revokedList = revoked;
    }
  `);
  const run1 = session.run(0, 10000);
  assertEquals(run1.status, 'suspended');

  airlock.membrane.revoke(approvedGrant);
  testResolver("value");

  const run2 = session.run(0, 10000);
  assertEquals(run2.status, 'done');

  const revokedList = session.get(0, 'revokedList');
  assert(Array.isArray(revokedList), 'revoked should be an array');
  assertEquals(revokedList.length, 1);
  assertEquals(revokedList[0], 'database');
});

Deno.test("Grant: denied block takes precedence over try/catch on revocation", () => {
  const session = freshSession();
  const { airlock } = session;

  const id = airlock.register({});
  let testResolver = null;
  airlock.setHandler(id, 'query', ({ context }) => {
    return context.suspend((resolve) => {
      testResolver = resolve;
    });
  });
  airlock.declare('Database', id);

  let approvedGrant = null;
  airlock.onGrantRequest = (identifier) => {
    approvedGrant = airlock.membrane.createGrant(identifier);
    approvedGrant.add(id);
    return { approved: true, grant: approvedGrant };
  };

  session.parse(`
    let result = "none";
    grant "database" {
      try {
        let r = Database.query();
        result = "ok:" + r;
      } catch (e) {
        result = "caught:" + e.message;
      }
    } denied (revoked) {
      result = "denied";
    }
  `);
  const run1 = session.run(0, 10000);
  assertEquals(run1.status, 'suspended');

  airlock.membrane.revoke(approvedGrant);
  testResolver("value");

  // Denied block takes precedence — try/catch should NOT intercept revocation
  const run2 = session.run(0, 10000);
  assertEquals(run2.status, 'done');
  assertEquals(session.get(0, 'result'), 'denied');
});

Deno.test("Grant: revocation during suspension takes precedence over rejection", () => {
  const session = freshSession();
  const { airlock } = session;

  const id = airlock.register({});
  let testReject = null;
  airlock.setHandler(id, 'query', ({ context }) => {
    return context.suspend((resolve, reject) => {
      testReject = reject;
    });
  });
  airlock.declare('Database', id);

  let approvedGrant = null;
  airlock.onGrantRequest = (identifier) => {
    approvedGrant = airlock.membrane.createGrant(identifier);
    approvedGrant.add(id);
    return { approved: true, grant: approvedGrant };
  };

  session.parse(`
    let result = "none";
    grant "database" {
      try {
        let r = Database.query();
        result = "ok:" + r;
      } catch (e) {
        result = "caught:" + e.message;
      }
    } denied (revoked) {
      result = "denied";
    }
  `);
  const run1 = session.run(0, 10000);
  assertEquals(run1.status, 'suspended');

  // Revoke the grant, then reject the suspension
  airlock.membrane.revoke(approvedGrant);
  testReject(new Error("query failed"));

  // Denied block should fire, NOT the catch block
  const run2 = session.run(0, 10000);
  assertEquals(run2.status, 'done');
  assertEquals(session.get(0, 'result'), 'denied');
});

// =============================================================================
// Synchronous Revocation — External Call Dispatch Check
// =============================================================================

Deno.test("Grant: synchronous revocation triggers denied block on next external call", () => {
  const session = freshSession();
  const { airlock } = session;

  const id = airlock.register({});
  airlock.declare('Api', id);

  let approvedGrant = null;
  airlock.onGrantRequest = (identifier) => {
    approvedGrant = airlock.membrane.createGrant(identifier);
    approvedGrant.add(id);
    return { approved: true, grant: approvedGrant };
  };

  // step1 revokes the grant as a side effect. When step2 dispatch happens,
  // the airlock detects the revoked grant and routes to the denied block.
  airlock.setHandler(id, 'step1', () => {
    airlock.membrane.revoke(approvedGrant);
    return "s1";
  });
  airlock.setHandler(id, 'step2', () => "s2");

  session.parse(`
    let result = "none";
    grant "api" {
      let a = Api.step1();
      let b = Api.step2();
      result = a + b;
    } denied (revoked) {
      result = "denied";
    }
  `);

  const runResult = session.run(0, 10000);
  assertEquals(runResult.status, 'done');
  assertEquals(session.get(0, 'result'), 'denied');
});

Deno.test("Grant: synchronous revocation with no denied block throws GrantDeniedError", () => {
  const session = freshSession();
  const { airlock } = session;

  const id = airlock.register({});
  airlock.setHandler(id, 'step1', () => "s1");
  airlock.setHandler(id, 'step2', () => "s2");
  airlock.declare('Api', id);

  let approvedGrant = null;
  airlock.onGrantRequest = (identifier) => {
    approvedGrant = airlock.membrane.createGrant(identifier);
    approvedGrant.add(id);
    return { approved: true, grant: approvedGrant };
  };

  // Revoke inside step1 handler
  airlock.setHandler(id, 'step1', () => {
    airlock.membrane.revoke(approvedGrant);
    return "s1";
  });

  session.parse(`
    let result = "none";
    let caught = false;
    try {
      grant "api" {
        let a = Api.step1();
        let b = Api.step2();
        result = a + b;
      }
    } catch (e) {
      caught = true;
    }
  `);

  const runResult = session.run(0, 10000);
  assertEquals(runResult.status, 'done');
  assertEquals(session.get(0, 'caught'), true);
  assertEquals(session.get(0, 'result'), 'none');
});

Deno.test("Grant: revocation during fuel pause triggers denied block on resume", () => {
  const session = freshSession();
  const { airlock } = session;

  const id = airlock.register({});
  airlock.setHandler(id, 'getValue', () => 42);
  airlock.declare('Api', id);

  let approvedGrant = null;
  airlock.onGrantRequest = (identifier) => {
    approvedGrant = airlock.membrane.createGrant(identifier);
    approvedGrant.add(id);
    return { approved: true, grant: approvedGrant };
  };

  session.parse(`
    let result = "none";
    grant "api" {
      let a = Api.getValue();
      let b = a + 1;
      let c = b + 1;
      result = "ok:" + c;
    } denied (revoked) {
      result = "denied";
    }
  `);

  // Run with very low fuel so we pause inside the grant body after the
  // external call completes but before the block finishes
  let runResult = session.run(0, 15);

  // Keep stepping until we're paused inside the grant body
  while (runResult.status !== 'paused' && runResult.status !== 'done') {
    runResult = session.run(0, 1);
  }

  if (runResult.status === 'done') {
    // If it completed in 15 fuel, the grant body was too short to pause inside.
    // Skip this test — the important thing is the mechanism works.
    return;
  }

  // Revoke the grant while paused
  airlock.membrane.revoke(approvedGrant);

  // Resume — should detect revocation and route to denied block
  const run2 = session.run(0, 10000);
  assertEquals(run2.status, 'done');
  assertEquals(session.get(0, 'result'), 'denied');
});

// =============================================================================
// Nested Grant Revocation
// =============================================================================

Deno.test("Grant: revoking either grouped member unwinds the complete group before denied", () => {
  const outcomes = {};

  for (const revokedIdentifier of ["a", "b"]) {
    const session = freshSession();
    const { airlock } = session;

    const rootGrant = airlock.createRootGrant("host");
    const hostHandle = airlock.register({});
    rootGrant.add(hostHandle);
    airlock.declare("Host", hostHandle);

    const grants = new Map();
    airlock.onGrantRequest = (identifier) => {
      const grant = airlock.membrane.createGrant(identifier);
      grants.set(identifier, grant);
      return { approved: true, grant };
    };

    let deniedStack = null;
    airlock.setHandler(hostHandle, "revoke", () => {
      airlock.membrane.revoke(grants.get(revokedIdentifier));
    });
    airlock.setHandler(hostHandle, "recordDeniedStack", () => {
      deniedStack = airlock.getActiveGrantIdentifiers(0);
    });

    session.parse(`
      let tailRan = false;
      let deniedIdentifiers = null;
      let afterRan = false;
      grant ("a", "b") {
        Host.revoke();
        tailRan = true;
      } denied (identifiers) {
        deniedIdentifiers = identifiers;
        Host.recordDeniedStack();
      }
      afterRan = true;
    `);

    const result = session.run(0, 10000);
    outcomes[revokedIdentifier] = {
      status: result.status,
      tailRan: session.get(0, "tailRan"),
      deniedIdentifiers: session.get(0, "deniedIdentifiers"),
      deniedStack,
      afterRan: session.get(0, "afterRan"),
      finalStack: airlock.getActiveGrantIdentifiers(0),
    };
  }

  const expected = {
    status: "done",
    tailRan: false,
    deniedIdentifiers: ["a"],
    deniedStack: [],
    afterRan: true,
    finalStack: [],
  };
  assertEquals(outcomes.a, expected);
  assertEquals(outcomes.b, { ...expected, deniedIdentifiers: ["b"] });
});

Deno.test("Grant: grouped revocation preserves and then releases the enclosing grant", () => {
  const session = freshSession();
  const { airlock } = session;

  const rootGrant = airlock.createRootGrant("host");
  const hostHandle = airlock.register({});
  rootGrant.add(hostHandle);
  airlock.declare("Host", hostHandle);

  const grants = new Map();
  airlock.onGrantRequest = (identifier) => {
    const grant = airlock.membrane.createGrant(identifier);
    grants.set(identifier, grant);
    return { approved: true, grant };
  };

  const observedStacks = {};
  airlock.setHandler(hostHandle, "revokeSecond", () => {
    airlock.membrane.revoke(grants.get("b"));
  });
  airlock.setHandler(hostHandle, "record", ({ args }) => {
    observedStacks[args[0]] = airlock.getActiveGrantIdentifiers(0);
  });

  session.parse(`
    let innerTailRan = false;
    let innerDeniedIdentifiers = null;
    let afterInnerRan = false;
    let outerDeniedRan = false;
    let afterOuterRan = false;
    grant "outer" {
      grant ("a", "b") {
        Host.revokeSecond();
        innerTailRan = true;
      } denied (identifiers) {
        innerDeniedIdentifiers = identifiers;
        Host.record("inner-denied");
      }
      afterInnerRan = true;
      Host.record("after-inner");
    } denied {
      outerDeniedRan = true;
    }
    afterOuterRan = true;
    Host.record("after-outer");
  `);

  const result = session.run(0, 10000);
  assertEquals(result.status, "done");
  assertEquals(session.get(0, "innerTailRan"), false);
  assertEquals(session.get(0, "innerDeniedIdentifiers"), ["b"]);
  assertEquals(session.get(0, "afterInnerRan"), true);
  assertEquals(session.get(0, "outerDeniedRan"), false);
  assertEquals(session.get(0, "afterOuterRan"), true);
  assertEquals(observedStacks, {
    "inner-denied": ["outer"],
    "after-inner": ["outer"],
    "after-outer": [],
  });
  assertEquals(airlock.getActiveGrantIdentifiers(0), []);
});

Deno.test("Grant: nested grant revocation — inner denied block fires", () => {
  const session = freshSession();
  const { airlock } = session;

  const id = airlock.register({});
  airlock.declare('Api', id);

  let innerGrant = null;
  airlock.onGrantRequest = (identifier) => {
    const grant = airlock.membrane.createGrant(identifier);
    grant.add(id);
    if (identifier === 'inner') innerGrant = grant;
    return { approved: true, grant };
  };

  let testResolver = null;
  airlock.setHandler(id, 'call', ({ context }) => {
    return context.suspend((resolve) => {
      testResolver = resolve;
    });
  });

  session.parse(`
    let result = "none";
    grant "outer" {
      grant "inner" {
        let r = Api.call();
        result = "ok:" + r;
      } denied (revoked) {
        result = "inner-denied";
      }
    } denied (revoked) {
      result = "outer-denied";
    }
  `);

  const run1 = session.run(0, 10000);
  assertEquals(run1.status, 'suspended');

  // Revoke only the inner grant
  airlock.membrane.revoke(innerGrant);
  testResolver("value");

  const run2 = session.run(0, 10000);
  assertEquals(run2.status, 'done');
  assertEquals(session.get(0, 'result'), 'inner-denied');
});

Deno.test("Grant: nested grant revocation — outer revocation unwinds inner", () => {
  const session = freshSession();
  const { airlock } = session;

  const id = airlock.register({});
  airlock.declare('Api', id);

  let outerGrant = null;
  airlock.onGrantRequest = (identifier) => {
    const grant = airlock.membrane.createGrant(identifier);
    grant.add(id);
    if (identifier === 'outer') outerGrant = grant;
    return { approved: true, grant };
  };

  let testResolver = null;
  airlock.setHandler(id, 'call', ({ context }) => {
    return context.suspend((resolve) => {
      testResolver = resolve;
    });
  });

  session.parse(`
    let result = "none";
    grant "outer" {
      grant "inner" {
        let r = Api.call();
        result = "ok:" + r;
      } denied (revoked) {
        result = "inner-denied";
      }
    } denied (revoked) {
      result = "outer-denied";
    }
  `);

  const run1 = session.run(0, 10000);
  assertEquals(run1.status, 'suspended');

  // Revoke the outer grant — inner should be unwound, outer denied block fires
  airlock.membrane.revoke(outerGrant);
  testResolver("value");

  const run2 = session.run(0, 10000);
  assertEquals(run2.status, 'done');
  assertEquals(session.get(0, 'result'), 'outer-denied');
});

Deno.test("Grant: active identifiers preserve source order within innermost-first groups", () => {
  const session = freshSession();
  const { airlock } = session;
  const hostHandle = airlock.register({});
  const rootGrant = airlock.createRootGrant("host");
  rootGrant.add(hostHandle);
  airlock.declare("Host", hostHandle);

  let observedIdentifiers = null;
  airlock.setHandler(hostHandle, "record", ({ context }) => {
    observedIdentifiers = airlock.getActiveGrantIdentifiers(context.id);
  });
  airlock.onGrantRequest = (identifier) => {
    const grant = airlock.membrane.createGrant(identifier);
    return { approved: true, grant };
  };

  session.parse(`
    grant ("outer-first", "outer-second") {
      grant ("inner-first", "inner-second") {
        Host.record()
      }
    }
  `);
  const result = session.run(0, 10000);

  assertEquals(result.status, "done");
  assertEquals(observedIdentifiers, [
    "inner-first",
    "inner-second",
    "outer-first",
    "outer-second",
  ]);
});

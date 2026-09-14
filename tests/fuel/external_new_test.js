/**
 * Test `new` on externals — `new ExternalCallable(args)` should dispatch the
 * same as `ExternalCallable(args)` because externals are opaque host-managed
 * references; `new` has no special prototype-allocation semantics for them.
 *
 * Run with: deno task test tests/fuel/external_new_test.js
 */

import { assertEquals, assert } from "https://deno.land/std@0.208.0/assert/mod.ts";
import { createSession } from '../../src/fuel/session.js';
import { freshSession } from '../../src/host-owned-session.js';
// Slice 1 of snapshottable-membrane: register() returns Handle wrappers
// directly. Handlers that return a registered handle just return the
// wrapper; no need to re-wrap.

function createTestSession() {
  const session = freshSession();
  const { airlock } = session;
  const rootGrant = airlock.createRootGrant();
  return { session, airlock, rootGrant };
}

// Test 4 from the plan, promoted to the canary slot: a returned external from
// `new` must be fully wired — not just received. Property access via setGetter
// proves the returned handle survived the OP_NEW yield/resume round-trip.
Deno.test("new on direct-callable external returns a usable external", () => {
  const { session, airlock, rootGrant } = createTestSession();

  const ctorId = airlock.register({});
  rootGrant.add(ctorId);
  airlock.setHandler(ctorId, null, ({ context }) => {
    const instance = { aborted: false };
    const instanceId = context.register(instance);
    rootGrant.add(instanceId);
    airlock.setGetter(instanceId, 'aborted', () => instance.aborted);
    return instanceId;
  });
  airlock.declare('AbortController', ctorId);

  session.parse(`let r = new AbortController(); let done = r.aborted`);
  session.run(0, 10000);

  assertEquals(session.get(0, 'done'), false);
});

// Test 1: bare-call form and new-call form reach the same handler with the
// same args and produce observably identical results.
Deno.test("new ExternalCallable() observed identically to ExternalCallable()", () => {
  const { session, airlock, rootGrant } = createTestSession();

  let lastArgs = null;
  const id = airlock.register({});
  rootGrant.add(id);
  airlock.setHandler(id, null, ({ args }) => {
    lastArgs = args;
    return args.length;
  });
  airlock.declare('Make', id);

  session.parse(`let bare = Make(); let withNew = new Make()`);
  session.run(0, 10000);

  assertEquals(session.get(0, 'bare'), 0);
  assertEquals(session.get(0, 'withNew'), 0);
});

// Test 2: args reach the handler in declaration order under `new`.
Deno.test("new ExternalCallable(arg1, arg2) preserves arg order", () => {
  const { session, airlock, rootGrant } = createTestSession();

  let received = null;
  const id = airlock.register({});
  rootGrant.add(id);
  airlock.setHandler(id, null, ({ args }) => {
    received = args;
    return args[0] + args[1];
  });
  airlock.declare('Sum', id);

  session.parse(`let result = new Sum(40, 2)`);
  session.run(0, 10000);

  assertEquals(received, [40, 2]);
  assertEquals(session.get(0, 'result'), 42);
});

// Test 3: chaining — `new` returns an external, then a method call on the
// returned external dispatches its own setHandler.
Deno.test("new HasMethod().method() chains through to the instance handler", () => {
  const { session, airlock, rootGrant } = createTestSession();

  const ctorId = airlock.register({});
  rootGrant.add(ctorId);
  airlock.setHandler(ctorId, null, ({ context }) => {
    const instance = { headers: new Map() };
    const instanceId = context.register(instance);
    rootGrant.add(instanceId);
    airlock.setHandler(instanceId, 'set', ({ args, context: c }) => {
      const impl = airlock.lookup(c.handle);
      impl.headers.set(args[0], args[1]);
      return null;
    });
    airlock.setHandler(instanceId, 'get', ({ args, context: c }) => {
      const impl = airlock.lookup(c.handle);
      return impl.headers.get(args[0]) ?? null;
    });
    return instanceId;
  });
  airlock.declare('Headers', ctorId);

  session.parse(`
    let h = new Headers();
    h.set('content-type', 'application/json');
    let result = h.get('content-type')
  `);
  session.run(0, 10000);

  assertEquals(session.get(0, 'result'), 'application/json');
});

// Test 5 (added during dry-run review): `new obj.method(args)` — the
// EXTERNAL_METHOD form of OP_NEW. The constructor slot is a method handle
// resolved from a property access on an external, not a bare external.
Deno.test("new obj.method(args) dispatches the method handler", () => {
  const { session, airlock, rootGrant } = createTestSession();

  let methodArgs = null;
  const factoryId = airlock.register({});
  rootGrant.add(factoryId);
  airlock.setHandler(factoryId, 'Request', ({ args, context }) => {
    methodArgs = args;
    const req = { url: args[0], method: args[1]?.method ?? 'GET' };
    const reqId = context.register(req);
    rootGrant.add(reqId);
    airlock.setGetter(reqId, 'url', () => req.url);
    airlock.setGetter(reqId, 'method', () => req.method);
    return reqId;
  });
  airlock.declare('factory', factoryId);

  session.parse(`
    let r = new factory.Request('https://example.com', { method: 'POST' });
    let url = r.url;
    let m = r.method
  `);
  session.run(0, 10000);

  assertEquals(methodArgs[0], 'https://example.com');
  assertEquals(methodArgs[1].method, 'POST');
  assertEquals(session.get(0, 'url'), 'https://example.com');
  assertEquals(session.get(0, 'm'), 'POST');
});

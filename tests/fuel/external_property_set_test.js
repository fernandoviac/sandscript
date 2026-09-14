/**
 * Tests for EXIT_EXTERNAL_PROPERTY_SET: drone-side `external.prop = value`
 * (member-assignment) runs a host-side setter. The write-side twin of
 * EXIT_EXTERNAL_PROPERTY.
 */

import { assertEquals } from "https://deno.land/std@0.208.0/assert/mod.ts";
import { freshSession } from '../../src/host-owned-session.js';

function declareExternal(session, name, { methods = {}, getters = {}, setters = {} } = {}) {
  const airlock = session.airlock;
  const handleId = airlock.register({});
  const grant = airlock.createRootGrant(`test:${name}`);
  grant.add(handleId);
  for (const [m, fn] of Object.entries(methods)) {
    airlock.setHandler(handleId, m, fn);
  }
  for (const [p, fn] of Object.entries(getters)) {
    airlock.setGetter(handleId, p, fn);
  }
  for (const [p, fn] of Object.entries(setters)) {
    airlock.setSetter(handleId, p, fn);
  }
  airlock.declare(name, handleId);
  return handleId;
}

function run(code, setup) {
  const session = freshSession();
  setup(session);
  session.parse(code);
  const result = session.run(0, 100000);
  if (result.status === 'error') {
    return { status: 'error', error: result.error };
  }
  return { status: result.status, value: session.result(0) };
}

// Async variant: drains spawned/parked contexts across event-loop turns so a
// Promise-returning setter can settle and resume the slot.
async function runAsync(code, setup) {
  const session = freshSession();
  setup(session);
  session.parse(code);
  let result = session.run(0, 100000);
  // Pump until the slot is no longer suspended. Each turn we yield to the JS
  // event loop so the setter's Promise can settle, then resume the slot.
  let guard = 0;
  while (result.status === 'suspended' && guard++ < 100) {
    await Promise.resolve();
    await new Promise((r) => setTimeout(r, 0));
    const ready = session.airlock.drainPendingSpawnedContextIdentities();
    for (const slot of ready) {
      result = session.run(slot, 100000);
    }
    if (ready.length === 0) {
      // Nothing ready yet; give the microtask/macrotask queue another turn.
      continue;
    }
  }
  if (result.status === 'error') {
    return { status: 'error', error: result.error };
  }
  return { status: result.status, value: session.result(0) };
}

Deno.test("setter: fires with the assigned number", () => {
  let captured = null;
  const out = run(`obj.x = 42`, (s) => declareExternal(s, 'obj', {
    setters: { x: ({ value }) => { captured = value; } },
  }));
  assertEquals(out.status, 'done');
  assertEquals(captured, 42);
});

Deno.test("setter: assignment evaluates to the assigned value", () => {
  // An assignment is an expression: `obj.x = 7` evaluates to 7, regardless of
  // what the setter returns host-side.
  const out = run(`obj.x = 7`, (s) => declareExternal(s, 'obj', {
    setters: { x: () => 'setter-return-ignored' },
  }));
  assertEquals(out.status, 'done');
  assertEquals(out.value, 7);
});

Deno.test("setter: assigned value flows through a let binding", () => {
  let captured = null;
  const out = run(`
    let v = (obj.label = "hello");
    v
  `, (s) => declareExternal(s, 'obj', {
    setters: { label: ({ value }) => { captured = value; } },
  }));
  assertEquals(out.status, 'done');
  assertEquals(out.value, 'hello');
  assertEquals(captured, 'hello');
});

Deno.test("setter: fires with a boolean", () => {
  let captured = null;
  const out = run(`obj.hidden = true`, (s) => declareExternal(s, 'obj', {
    setters: { hidden: ({ value }) => { captured = value; } },
  }));
  assertEquals(out.status, 'done');
  assertEquals(captured, true);
});

Deno.test("setter: context.handle and context.method are populated", () => {
  let seenMethod = null;
  let seenHandle = false;
  const out = run(`obj.title = "x"`, (s) => declareExternal(s, 'obj', {
    setters: {
      title: ({ context }) => {
        seenMethod = context.method;
        seenHandle = context.handle != null;
      },
    },
  }));
  assertEquals(out.status, 'done');
  assertEquals(seenMethod, 'title');
  assertEquals(seenHandle, true);
});

Deno.test("setter + getter round-trip on the same handle", () => {
  let backing = 0;
  const out = run(`
    obj.count = 5;
    obj.count = obj.count + 10;
    obj.count
  `, (s) => declareExternal(s, 'obj', {
    setters: { count: ({ value }) => { backing = value; } },
    getters: { count: () => backing },
  }));
  assertEquals(out.status, 'done');
  assertEquals(out.value, 15);
});

Deno.test("multiple sequential property writes stay correct", () => {
  const writes = [];
  const out = run(`
    obj.p = 1;
    obj.p = 2;
    obj.p = 3;
  `, (s) => declareExternal(s, 'obj', {
    setters: { p: ({ value }) => { writes.push(value); } },
  }));
  assertEquals(out.status, 'done');
  assertEquals(writes, [1, 2, 3]);
});

Deno.test("no setter registered: assignment throws a catchable TypeError", () => {
  const out = run(`
    let caught = null;
    try { obj.readonly = 1; } catch (e) { caught = e.message; }
    caught
  `, (s) => declareExternal(s, 'obj', {
    getters: { readonly: () => 'fixed' },
  }));
  assertEquals(out.status, 'done');
  // The error names the property; a read-only handle registers no setter.
  assertEquals(out.value.includes('readonly'), true);
});

Deno.test("setter that throws propagates as a catchable exception", () => {
  const out = run(`
    let caught = null;
    try { obj.bad = 1; } catch (e) { caught = e.message; }
    caught
  `, (s) => declareExternal(s, 'obj', {
    setters: { bad: () => { throw new Error('boom'); } },
  }));
  assertEquals(out.status, 'done');
  assertEquals(out.value, 'boom');
});

Deno.test("assigning an external handle as a value passes the underlying object", () => {
  let received = null;
  const out = run(`parent.child = other`, (session) => {
    const airlock = session.airlock;
    const grant = airlock.createRootGrant('test:handles');

    const otherImpl = { tag: 'the-other' };
    const otherId = airlock.register(otherImpl);
    grant.add(otherId);
    airlock.declare('other', otherId);

    const parentId = airlock.register({});
    grant.add(parentId);
    airlock.setSetter(parentId, 'child', ({ value }) => { received = value; });
    airlock.declare('parent', parentId);
  });
  assertEquals(out.status, 'done');
  // The setter receives the underlying impl object, not a Handle wrapper —
  // mirroring how handleExternalCall unwraps Handle args.
  assertEquals(received != null && received.tag, 'the-other');
});

Deno.test("compound assignment on an external handle (read+write round-trip)", () => {
  // `obj.n += 1` compiles to GET_PROP (getter) then SET_PROP (setter). With a
  // getter and a setter both registered, the read-modify-write works end to
  // end. (The plan flagged compound assignment as a v1 concern; in practice
  // the parser lowers it to the existing getter+setter ops, so it Just Works
  // when both are registered.)
  let backing = 10;
  const out = run(`
    obj.n += 5;
    obj.n
  `, (s) => declareExternal(s, 'obj', {
    getters: { n: () => backing },
    setters: { n: ({ value }) => { backing = value; } },
  }));
  assertEquals(out.status, 'done');
  assertEquals(out.value, 15);
});

Deno.test("async setter: slot suspends then resumes with the assigned value", async () => {
  let captured = null;
  const out = await runAsync(`obj.async = 99`, (s) => declareExternal(s, 'obj', {
    setters: {
      async: ({ value, context }) => context.suspend((resolve) => {
        // resolve() with a DIFFERENT value: the assignment must still
        // evaluate to the assigned value (99), not the setter's resolve arg.
        setTimeout(() => { captured = value; resolve('setter-resolve-ignored'); }, 0);
      }),
    },
  }));
  assertEquals(out.status, 'done');
  assertEquals(captured, 99);
  // Assignment-as-expression: resumes with the assigned value, not whatever
  // the setter's resolve() passed.
  assertEquals(out.value, 99);
});

Deno.test("async setter: assigned value flows through a let binding", async () => {
  // Same as above but binds the assignment result so the resumed value is
  // actually observed downstream, not just discarded as a statement.
  const out = await runAsync(`
    let v = (obj.async = 7);
    v + 1
  `, (s) => declareExternal(s, 'obj', {
    setters: {
      async: ({ context }) => context.suspend((resolve) => {
        setTimeout(() => resolve('ignored'), 0);
      }),
    },
  }));
  assertEquals(out.status, 'done');
  assertEquals(out.value, 8);
});

Deno.test("Promise-returning setter: slot suspends then resumes with the assigned value", async () => {
  let captured = null;
  const out = await runAsync(`obj.p = 123`, (s) => declareExternal(s, 'obj', {
    setters: {
      p: ({ value }) => new Promise((resolve) => {
        setTimeout(() => { captured = value; resolve('ignored'); }, 0);
      }),
    },
  }));
  assertEquals(out.status, 'done');
  assertEquals(captured, 123);
  assertEquals(out.value, 123);
});

Deno.test("write to a handle outside the active grant stack is denied", () => {
  // A handle not reachable from any active grant must not accept a write.
  const out = run(`
    let caught = null;
    try { secret.x = 1; } catch (e) { caught = e.message; }
    caught
  `, (session) => {
    const airlock = session.airlock;
    // Register + declare WITHOUT adding to any grant — the handle is declared
    // (so the name resolves) but not authorized.
    const secretId = airlock.register({});
    airlock.setSetter(secretId, 'x', () => {});
    airlock.declare('secret', secretId);
  });
  assertEquals(out.status, 'done');
  // Grant denial surfaces as a catchable error mentioning the grant stack.
  assertEquals(typeof out.value, 'string');
  assertEquals(out.value.includes('grant'), true);
});

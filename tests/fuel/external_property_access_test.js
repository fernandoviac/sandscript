/**
 * Tests for EXIT_EXTERNAL_PROPERTY: drone-side `external.foo` (no call)
 * resolves to a host-side getter or falls through to a method-binding.
 */

import { assertEquals } from "https://deno.land/std@0.208.0/assert/mod.ts";
import { createSession } from '../../src/fuel/session.js';
import { freshSession } from '../../src/host-owned-session.js';
// Slice 1 of snapshottable-membrane: register() returns Handle wrappers.

function declareExternal(session, name, { methods = {}, getters = {} } = {}) {
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

Deno.test("getter: returns a number", () => {
  const out = run(`obj.foo`, (s) => declareExternal(s, 'obj', {
    getters: { foo: () => 42 },
  }));
  assertEquals(out.status, 'done');
  assertEquals(out.value, 42);
});

Deno.test("getter: returns a string", () => {
  const out = run(`obj.name`, (s) => declareExternal(s, 'obj', {
    getters: { name: () => 'hello' },
  }));
  assertEquals(out.status, 'done');
  assertEquals(out.value, 'hello');
});

Deno.test("getter: returns a boolean", () => {
  const out = run(`obj.ready`, (s) => declareExternal(s, 'obj', {
    getters: { ready: () => true },
  }));
  assertEquals(out.status, 'done');
  assertEquals(out.value, true);
});

Deno.test("getter + method on the same handle", () => {
  let counter = 0;
  const out = run(`
    let a = obj.value;
    obj.bump();
    let b = obj.value;
    [a, b]
  `, (s) => declareExternal(s, 'obj', {
    methods: { bump: () => ++counter },
    getters: { value: () => counter },
  }));
  assertEquals(out.status, 'done');
  assertEquals(out.value, [0, 1]);
});

Deno.test("no getter: existing method-call path still works", () => {
  // The baseline path is `obj.method()` — member-access immediately followed
  // by a call. With the new EXIT_EXTERNAL_PROPERTY exit, the no-getter case
  // pushes a TYPE_EXTERNAL_METHOD binding, and the next CALL opcode dispatches
  // it as a method exactly like before.
  const out = run(`obj.greet()`, (s) => declareExternal(s, 'obj', {
    methods: { greet: () => 'hi' },
  }));
  assertEquals(out.status, 'done');
  assertEquals(out.value, 'hi');
});

Deno.test("getter that throws propagates as a catchable exception", () => {
  const out = run(`
    let caught = null;
    try { let x = obj.bad; } catch (e) { caught = e.message; }
    caught
  `, (s) => declareExternal(s, 'obj', {
    getters: {
      bad: () => { throw new Error('boom'); },
    },
  }));
  assertEquals(out.status, 'done');
  assertEquals(out.value, 'boom');
});

Deno.test("multiple sequential property reads stay correct", () => {
  let n = 0;
  const out = run(`[obj.tick, obj.tick, obj.tick]`, (s) => declareExternal(s, 'obj', {
    getters: { tick: () => ++n },
  }));
  assertEquals(out.status, 'done');
  assertEquals(out.value, [1, 2, 3]);
});

Deno.test("getter result is itself an External (chained access)", () => {
  const out = run(`outer.inner.value`, (session) => {
    const airlock = session.airlock;
    const grant = airlock.createRootGrant('test:chain');

    const innerId = airlock.register({});
    grant.add(innerId);
    airlock.setGetter(innerId, 'value', () => 99);

    const outerId = airlock.register({});
    grant.add(outerId);
    airlock.setGetter(outerId, 'inner', () => innerId);
    airlock.declare('outer', outerId);
  });
  assertEquals(out.status, 'done');
  assertEquals(out.value, 99);
});

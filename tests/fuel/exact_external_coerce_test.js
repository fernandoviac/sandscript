/**
 * Tests for the per-handler `coerceExact: 'float'` option on External
 * handlers registered via airlock.setHandler(id, method, fn, options).
 *
 * Default behavior (no coerceExact):
 *   - Integer-valued Rationals in safe-integer range unwrap to plain Number.
 *   - Non-integer Rationals reach the handler as structured { kind, n, d }.
 *   - Complex reaches the handler as structured { kind, real, imaginary }.
 *
 * With coerceExact: 'float':
 *   - Every Rational (integer or not, safe-range or not) becomes a plain
 *     Number via numerator/denominator f64 division.
 *   - Complex arguments cause a TypeError at the boundary before the
 *     handler ever runs — Complex has no lossless float projection.
 */

import { assertEquals, assert } from "https://deno.land/std@0.208.0/assert/mod.ts";
import { createSession } from '../../src/fuel/session.js';
import { freshSession } from '../../src/host-owned-session.js';

function createTestSession() {
  const session = freshSession();
  const { airlock } = session;
  const rootGrant = airlock.createRootGrant();
  return { session, airlock, rootGrant };
}

// Default — integer-valued Rationals auto-unwrap.

Deno.test("External (default): integer-Rational arg unwraps to Number", () => {
  const { session, airlock, rootGrant } = createTestSession();
  const id = airlock.register({});
  rootGrant.add(id);
  let observed;
  airlock.setHandler(id, 'capture', ({ args }) => { observed = args[0]; return 0; });
  airlock.declare('Ext', id);
  session.parse(`Ext.capture(42);`);
  session.run(0, 10000);
  assertEquals(observed, 42);
  assertEquals(typeof observed, 'number');
});

Deno.test("External (default): non-integer Rational arrives structured", () => {
  const { session, airlock, rootGrant } = createTestSession();
  const id = airlock.register({});
  rootGrant.add(id);
  let observed;
  airlock.setHandler(id, 'capture', ({ args }) => { observed = args[0]; return 0; });
  airlock.declare('Ext', id);
  session.parse(`Ext.capture(Exact.rational(1n, 3n));`);
  session.run(0, 10000);
  assertEquals(observed, { kind: 'rational', numerator: 1n, denominator: 3n });
});

// coerceExact: 'float' — numeric coercion at the boundary.

Deno.test("External (coerceExact:'float'): non-integer Rational → Number", () => {
  const { session, airlock, rootGrant } = createTestSession();
  const id = airlock.register({});
  rootGrant.add(id);
  let observed;
  airlock.setHandler(id, 'capture', ({ args }) => { observed = args[0]; return 0; },
    { coerceExact: 'float' });
  airlock.declare('Ext', id);
  session.parse(`Ext.capture(Exact.rational(1n, 3n));`);
  session.run(0, 10000);
  assertEquals(typeof observed, 'number');
  // 1/3 is not exactly representable; check nearness instead.
  assert(Math.abs(observed - 1 / 3) < 1e-15);
});

Deno.test("External (coerceExact:'float'): integer Rational also passes as Number", () => {
  const { session, airlock, rootGrant } = createTestSession();
  const id = airlock.register({});
  rootGrant.add(id);
  let observed;
  airlock.setHandler(id, 'capture', ({ args }) => { observed = args[0]; return 0; },
    { coerceExact: 'float' });
  airlock.declare('Ext', id);
  session.parse(`Ext.capture(42);`);
  session.run(0, 10000);
  assertEquals(observed, 42);
  assertEquals(typeof observed, 'number');
});

Deno.test("External (coerceExact:'float'): multiple numeric args all coerced", () => {
  const { session, airlock, rootGrant } = createTestSession();
  const id = airlock.register({});
  rootGrant.add(id);
  let args;
  airlock.setHandler(id, 'capture', (call) => { args = call.args; return 0; },
    { coerceExact: 'float' });
  airlock.declare('Ext', id);
  session.parse(`Ext.capture(Exact.rational(1n, 4n), Exact.rational(3n, 4n), 2);`);
  session.run(0, 10000);
  assertEquals(args, [0.25, 0.75, 2]);
});

Deno.test("External (coerceExact:'float'): Complex arg throws TypeError at boundary", () => {
  const { session, airlock, rootGrant } = createTestSession();
  const id = airlock.register({});
  rootGrant.add(id);
  let handlerRan = false;
  airlock.setHandler(id, 'capture', () => { handlerRan = true; return 0; },
    { coerceExact: 'float' });
  airlock.declare('Ext', id);
  session.parse(`
    let caught = null;
    try { Ext.capture(Exact.i); } catch (e) { caught = e.message; }
  `);
  session.run(0, 10000);
  assert(!handlerRan, 'handler should not run when Complex rejected at boundary');
  const caught = session.get(0, 'caught');
  assert(typeof caught === 'string' && caught.includes('Complex'),
    `expected TypeError about Complex, got: ${caught}`);
});

// setHandlers with per-method coerceExact descriptor.

Deno.test("External: setHandlers accepts { fn, coerceExact } descriptors", () => {
  const { session, airlock, rootGrant } = createTestSession();
  const id = airlock.register({});
  rootGrant.add(id);
  let exactObserved, coercedObserved;
  airlock.setHandlers(id, {
    exact: ({ args }) => { exactObserved = args[0]; return 0; },
    coerced: { fn: ({ args }) => { coercedObserved = args[0]; return 0; },
                coerceExact: 'float' },
  });
  airlock.declare('Ext', id);
  session.parse(`
    Ext.exact(Exact.rational(1n, 3n));
    Ext.coerced(Exact.rational(1n, 3n));
  `);
  session.run(0, 10000);
  assertEquals(exactObserved, { kind: 'rational', numerator: 1n, denominator: 3n });
  assertEquals(typeof coercedObserved, 'number');
  assert(Math.abs(coercedObserved - 1 / 3) < 1e-15);
});

// Only the handler with the opt-in gets the coercion; the other handler on
// the same handle still sees exact values.

Deno.test("External: coerceExact is strictly per-method", () => {
  const { session, airlock, rootGrant } = createTestSession();
  const id = airlock.register({});
  rootGrant.add(id);
  let exactObserved, coercedObserved;
  airlock.setHandler(id, 'exact', ({ args }) => { exactObserved = args[0]; return 0; });
  airlock.setHandler(id, 'coerced', ({ args }) => { coercedObserved = args[0]; return 0; },
    { coerceExact: 'float' });
  airlock.declare('Ext', id);
  session.parse(`
    Ext.exact(Exact.rational(2n, 7n));
    Ext.coerced(Exact.rational(2n, 7n));
  `);
  session.run(0, 10000);
  assertEquals(exactObserved, { kind: 'rational', numerator: 2n, denominator: 7n });
  assertEquals(typeof coercedObserved, 'number');
});

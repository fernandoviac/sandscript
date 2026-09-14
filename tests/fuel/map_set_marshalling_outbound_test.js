/**
 * Map and Set marshalling outbound from SandScript to the host.
 *
 * Exercises readValueAt's TYPE.MAP / TYPE.SET cases (unmarshalMap /
 * unmarshalSet) by handing a kernel Map/Set to a JS External handler. Kernel
 * maps and sets once fell through readValueAt's switch and were lost.
 *
 * Covers:
 *   - Map -> JS Map and Set -> JS Set with correct entries.
 *   - Non-string keys (integer key, nested-Map key) — the arbitrary-key path
 *     that is the whole reason MAP mirrors JS Map rather than collapsing to {}.
 *   - Under coerceExact:'float', values and integer-in-range Rational keys
 *     coerce without collisions; non-integer Rational keys fail loudly.
 *
 * Run with: deno task test tests/fuel/map_set_marshalling_outbound_test.js
 */

import { assertEquals, assert } from "https://deno.land/std@0.208.0/assert/mod.ts";
import { freshSession } from '../../src/host-owned-session.js';

function createTestSession() {
  const session = freshSession();
  const { airlock } = session;
  const rootGrant = airlock.createRootGrant();
  return { session, airlock, rootGrant };
}

// Register a 'capture' handler that records args[0] and return the recorder.
function captureSession(handlerOptions) {
  const ctx = createTestSession();
  const id = ctx.airlock.register({});
  ctx.rootGrant.add(id);
  const box = { value: undefined, ran: false };
  ctx.airlock.setHandler(id, 'capture', ({ args }) => {
    box.ran = true;
    box.value = args[0];
    return 0;
  }, handlerOptions);
  ctx.airlock.declare('Ext', id);
  return { ...ctx, box };
}

// =============================================================================
// Map outbound
// =============================================================================

Deno.test("outbound Map: string + integer keys round-trip to a JS Map", () => {
  const { session, box } = captureSession();
  session.parse(`
    let m = new Map();
    m.set('a', 1);
    m.set(7, 'seven');
    Ext.capture(m);
  `);
  session.run(0, 10_000_000);

  assert(box.value instanceof Map, 'expected a JS Map');
  assertEquals(box.value.size, 2);
  assertEquals(box.value.get('a'), 1);
  // Integer key stays an integer key — NOT stringified.
  assertEquals(box.value.get(7), 'seven');
  assertEquals(box.value.has('7'), false);
});

Deno.test("outbound Map: a Map-valued key (arbitrary-key path)", () => {
  const { session, box } = captureSession();
  session.parse(`
    let inner = new Map();
    inner.set('k', 'v');
    let outer = new Map();
    outer.set(inner, 'has-map-key');
    Ext.capture(outer);
  `);
  session.run(0, 10_000_000);

  assert(box.value instanceof Map);
  assertEquals(box.value.size, 1);
  const [key, value] = [...box.value.entries()][0];
  assert(key instanceof Map, 'nested key should itself unmarshal to a JS Map');
  assertEquals(key.get('k'), 'v');
  assertEquals(value, 'has-map-key');
});

Deno.test("outbound Map: a Map-valued value (nested recursion)", () => {
  const { session, box } = captureSession();
  session.parse(`
    let inner = new Map();
    inner.set(1, 2);
    let outer = new Map();
    outer.set('inner', inner);
    Ext.capture(outer);
  `);
  session.run(0, 10_000_000);

  const inner = box.value.get('inner');
  assert(inner instanceof Map);
  assertEquals(inner.get(1), 2);
});

// =============================================================================
// Set outbound
// =============================================================================

Deno.test("outbound Set: mixed members round-trip to a JS Set", () => {
  const { session, box } = captureSession();
  session.parse(`
    let s = new Set();
    s.add(1);
    s.add('x');
    s.add(99);
    Ext.capture(s);
  `);
  session.run(0, 10_000_000);

  assert(box.value instanceof Set, 'expected a JS Set');
  assertEquals(box.value.size, 3);
  assert(box.value.has(1));
  assert(box.value.has('x'));
  assert(box.value.has(99));
  assertEquals(box.value.has('99'), false);
});

// =============================================================================
// Key-coercion contract under coerceExact: 'float'
// =============================================================================

Deno.test("outbound Map (coerceExact:'float'): integer Rational key coerces safely", () => {
  const { session, box } = captureSession({ coerceExact: 'float' });
  session.parse(`
    let m = new Map();
    m.set(5, 'five');
    Ext.capture(m);
  `);
  session.run(0, 10_000_000);

  assert(box.value instanceof Map);
  const key = [...box.value.keys()][0];
  assertEquals(typeof key, 'number');
  assertEquals(key, 5);
  assertEquals(box.value.get(5), 'five');
});

Deno.test("outbound Map (coerceExact:'float'): values coerce; key stays integer", () => {
  const { session, box } = captureSession({ coerceExact: 'float' });
  // A non-integer Rational VALUE is fine to coerce (one slot, no collision).
  session.parse(`
    let m = new Map();
    m.set(2, Exact.rational(1n, 3n));
    Ext.capture(m);
  `);
  session.run(0, 10_000_000);

  const v = box.value.get(2);
  assertEquals(typeof v, 'number');
  assert(Math.abs(v - 1 / 3) < 1e-15);
});

Deno.test("outbound Map (coerceExact:'float'): non-integer Rational key throws (fail loud)", () => {
  const { session, box } = captureSession({ coerceExact: 'float' });
  session.parse(`
    let caught = null;
    let m = new Map();
    m.set(Exact.rational(1n, 3n), 'third');
    try { Ext.capture(m); } catch (e) { caught = e.message; }
  `);
  session.run(0, 10_000_000);

  assert(!box.ran, 'handler must not run when a lossy key is rejected at the boundary');
  const caught = session.get(0, 'caught');
  assert(
    typeof caught === 'string' && caught.includes('Rational') && caught.includes('Map key'),
    `expected a fail-loud Rational-key TypeError, got: ${caught}`,
  );
});

Deno.test("outbound Set (coerceExact:'float'): non-integer Rational member throws (member = key path)", () => {
  const { session, box } = captureSession({ coerceExact: 'float' });
  session.parse(`
    let caught = null;
    let s = new Set();
    s.add(Exact.rational(2n, 7n));
    try { Ext.capture(s); } catch (e) { caught = e.message; }
  `);
  session.run(0, 10_000_000);

  assert(!box.ran, 'handler must not run when a lossy member is rejected at the boundary');
  const caught = session.get(0, 'caught');
  assert(
    typeof caught === 'string' && caught.includes('Rational'),
    `expected a fail-loud Rational-member TypeError, got: ${caught}`,
  );
});

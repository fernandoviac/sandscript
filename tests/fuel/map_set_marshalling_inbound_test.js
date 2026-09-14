/**
 * Map and Set marshalling inbound from host to SandScript.
 *
 * Exercises writeValueAt's / objectSetByMarshal's Map and Set arms (and the
 * marshalMap / marshalSet / allocateMap / allocateSet allocators) by having a
 * JS External handler RETURN a JS Map/Set, which the SS side then inspects.
 *
 * A JS Map or Set once fell through the generic object arm and marshalled as
 * an empty TYPE.OBJECT. These tests require a real Map or Set with working
 * has, get, and size behavior on the SandScript side.
 *
 * NOTE: SS-side `instanceof Map` is NOT used to verify — it is not a wired
 * idiom even for natively-built maps (a pre-existing limitation, orthogonal
 * to marshalling). We verify via .size / .get / .has, the same way the
 * comprehensive map_set_test.js does.
 *
 * Run with: deno task test tests/fuel/map_set_marshalling_inbound_test.js
 */

import { assertEquals, assert } from "https://deno.land/std@0.208.0/assert/mod.ts";
import { freshSession } from '../../src/host-owned-session.js';

function createTestSession() {
  const session = freshSession();
  const { airlock } = session;
  const rootGrant = airlock.createRootGrant();
  return { session, airlock, rootGrant };
}

// Register a handler that returns `producer()` (a JS value) and declare Ext.
function provide(producer, handlerOptions) {
  const ctx = createTestSession();
  const id = ctx.airlock.register({});
  ctx.rootGrant.add(id);
  ctx.airlock.setHandler(id, 'get', () => producer(), handlerOptions);
  ctx.airlock.declare('Ext', id);
  return ctx;
}

// =============================================================================
// Inbound Map — the silent-data-loss regression
// =============================================================================

Deno.test("inbound Map: SS sees a real Map (not an empty object)", () => {
  const { session } = provide(() => {
    const m = new Map();
    m.set('a', 1);
    m.set(7, 'seven');  // non-string key
    return m;
  });
  session.parse(`
    let m = Ext.get();
    let sz = m.size;
    let a = m.get('a');
    let seven = m.get(7);
    let has7 = m.has(7);
    let hasStr7 = m.has('7');
  `);
  const r = session.run(0, 10_000_000);
  assertEquals(r.status, 'done');
  // The regression: an empty object would give size 0 / undefined gets.
  assertEquals(session.get(0, 'sz'), 2);
  assertEquals(session.get(0, 'a'), 1);
  assertEquals(session.get(0, 'seven'), 'seven');
  assertEquals(session.get(0, 'has7'), true);
  // Integer key is a distinct key from the string '7'.
  assertEquals(session.get(0, 'hasStr7'), false);
});

Deno.test("inbound Set: SS sees a real Set with working has/size", () => {
  const { session } = provide(() => new Set([1, 'x', 99]));
  session.parse(`
    let s = Ext.get();
    let sz = s.size;
    let h99 = s.has(99);
    let hx = s.has('x');
    let hMissing = s.has(42);
  `);
  const r = session.run(0, 10_000_000);
  assertEquals(r.status, 'done');
  assertEquals(session.get(0, 'sz'), 3);
  assertEquals(session.get(0, 'h99'), true);
  assertEquals(session.get(0, 'hx'), true);
  assertEquals(session.get(0, 'hMissing'), false);
});

// =============================================================================
// Nesting — recursion + the objectSetByMarshal / arraySetByMarshal mirrors
// =============================================================================

Deno.test("inbound: Map value that is itself a Map (recursion)", () => {
  const { session } = provide(() => {
    const inner = new Map([['k', 'v']]);
    const outer = new Map();
    outer.set('inner', inner);
    return outer;
  });
  session.parse(`
    let o = Ext.get();
    let inner = o.get('inner');
    let v = inner.get('k');
    let innerSize = inner.size;
  `);
  const r = session.run(0, 10_000_000);
  assertEquals(r.status, 'done');
  assertEquals(session.get(0, 'innerSize'), 1);
  assertEquals(session.get(0, 'v'), 'v');
});

Deno.test("inbound: Map nested as an object property value (objectSetByMarshal arm)", () => {
  const { session } = provide(() => {
    const m = new Map([['x', 10]]);
    return { label: 'wrapped', payload: m };  // plain object whose value is a Map
  });
  session.parse(`
    let o = Ext.get();
    let label = o.label;
    let m = o.payload;
    let x = m.get('x');
    let sz = m.size;
  `);
  const r = session.run(0, 10_000_000);
  assertEquals(r.status, 'done');
  assertEquals(session.get(0, 'label'), 'wrapped');
  assertEquals(session.get(0, 'sz'), 1);
  assertEquals(session.get(0, 'x'), 10);
});

Deno.test("inbound: Map as an array element (arraySetByMarshal -> writeValueAt)", () => {
  const { session } = provide(() => [new Map([['a', 1]]), new Set([2, 3])]);
  session.parse(`
    let arr = Ext.get();
    let m = arr[0];
    let s = arr[1];
    let mGet = m.get('a');
    let sHas = s.has(3);
  `);
  const r = session.run(0, 10_000_000);
  assertEquals(r.status, 'done');
  assertEquals(session.get(0, 'mGet'), 1);
  assertEquals(session.get(0, 'sHas'), true);
});

// =============================================================================
// Round-trip — in then out returns an equivalent JS Map/Set
// =============================================================================

Deno.test("round-trip: JS Map -> SS -> JS Map is equivalent", () => {
  const ctx = createTestSession();
  const id = ctx.airlock.register({});
  ctx.rootGrant.add(id);
  const original = new Map([['a', 1], [7, 'seven']]);
  let out;
  ctx.airlock.setHandler(id, 'source', () => original);
  ctx.airlock.setHandler(id, 'sink', ({ args }) => { out = args[0]; return 0; });
  ctx.airlock.declare('Ext', id);

  // Bring the map in, hand the SAME SS map back out to the host.
  ctx.session.parse(`let m = Ext.source(); Ext.sink(m);`);
  ctx.session.run(0, 10_000_000);

  assert(out instanceof Map);
  assertEquals(out.size, 2);
  assertEquals(out.get('a'), 1);
  assertEquals(out.get(7), 'seven');
});

// =============================================================================
// Fail-loud — un-marshalable key/value
// =============================================================================

Deno.test("inbound Map with a function value fails loud (no silent drop)", () => {
  const { session } = provide(() => new Map([['fn', () => 1]]));
  session.parse(`let m = Ext.get();`);
  // The throw happens while marshalling the function-valued entry IN — the
  // existing "functions cannot cross" rule applied recursively to the value
  // slot. It surfaces as a JS exception from the host call (the boundary
  // cannot represent it), not a silent empty entry.
  let threw = false;
  let message = '';
  try {
    session.run(0, 10_000_000);
  } catch (e) {
    threw = true;
    message = e.message;
  }
  assert(threw, 'expected a fail-loud error for a function-valued Map entry');
  assert(
    message.includes('function'),
    `expected a "Cannot marshal value of type function" error, got: ${message}`,
  );
});

// =============================================================================
// GC safety — a gc() while/after an inbound map is built must not corrupt
// =============================================================================

Deno.test("inbound Map survives a gc() (no tail-slot corruption)", () => {
  const ctx = createTestSession();
  const id = ctx.airlock.register({});
  ctx.rootGrant.add(id);
  ctx.airlock.setHandler(id, 'get', () => {
    const m = new Map();
    for (let i = 0; i < 8; i++) m.set(i, `v${i}`);
    return m;
  });
  ctx.airlock.declare('Ext', id);

  // Bind the map and pre-compute reads so they survive into post-gc asserts.
  ctx.session.parse(`let m = Ext.get(); let before = m.size; let v3 = m.get(3); let v7 = m.get(7);`);
  ctx.session.run(0, 10_000_000);
  assertEquals(ctx.session.get(0, 'before'), 8);

  // Force a collection. `m` is reachable (a live binding), so the collector
  // walks its entries block (OBJ.MAP_ENTRIES, [0, slotCount)). A tail-slot or
  // mis-built entry would corrupt here. The bindings must survive intact.
  ctx.session.gc();

  assertEquals(ctx.session.get(0, 'before'), 8);
  assertEquals(ctx.session.get(0, 'v3'), 'v3');
  assertEquals(ctx.session.get(0, 'v7'), 'v7');
  // And the map header survived: its own size field reads back correct.
  assertEquals(ctx.session.get(0, 'm').size, 8);
});

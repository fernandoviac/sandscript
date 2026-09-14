/**
 * Object.getOwnPropertyDescriptor + the built-in `size` getter (B1).
 *
 * Own-property descriptors for object/function receivers: data entries
 * yield { value, writable, enumerable, configurable }, accessor entries
 * yield { get, set, enumerable, configurable } with the closure halves
 * as function values, and writable/configurable report false on frozen
 * objects. `size` on Map.prototype / Set.prototype yields the built-in
 * accessor descriptor — its `get` is a real function (the reserved
 * MAP_SIZE_GETTER / SET_SIZE_GETTER method ids, finally dispatched);
 * `m.size` itself keeps the GET_PROP fast path, which is spec-legal
 * because `size` lives on the prototype, so the INSTANCE descriptor is
 * undefined either way.
 */

import { assertEquals } from "https://deno.land/std@0.208.0/assert/mod.ts";
import { parseAndSetup } from './test-helpers.js';
import { freshSession } from '../../src/host-owned-session.js';

function run(source) {
  const session = freshSession();
  parseAndSetup(session, source);
  const result = session.run(0, 50_000_000);
  if (result.status === 'error') {
    throw new Error(result.error.message);
  }
  return session;
}

Deno.test("size on Map.prototype is an accessor descriptor with a function getter", () => {
  const s = run(`
    let desc = Object.getOwnPropertyDescriptor(Map.prototype, "size");
    let g = typeof desc.get;
    let st = typeof desc.set;
    let e = desc.enumerable;
    let c = desc.configurable;
  `);
  assertEquals(s.get(0, 'g'), 'function');
  assertEquals(s.get(0, 'st'), 'undefined');
  assertEquals(s.get(0, 'e'), false);
  assertEquals(s.get(0, 'c'), true);
});

Deno.test("size on Set.prototype is an accessor descriptor too", () => {
  const s = run(`
    let desc = Object.getOwnPropertyDescriptor(Set.prototype, "size");
    let g = typeof desc.get;
  `);
  assertEquals(s.get(0, 'g'), 'function');
});

Deno.test("detached size getter call throws the incompatible-receiver TypeError", () => {
  const s = run(`
    let desc = Object.getOwnPropertyDescriptor(Map.prototype, "size");
    let g = desc.get;
    let err = "";
    try { g(); } catch (e) { err = "threw"; }
  `);
  assertEquals(s.get(0, 'err'), 'threw');
});

Deno.test("instance size keeps the fast path; instance descriptor is undefined (size is on the prototype)", () => {
  const s = run(`
    let m = new Map([[1, "a"], [2, "b"], [3, "c"]]);
    let size = m.size;
    let t = typeof Object.getOwnPropertyDescriptor(m, "size");
  `);
  assertEquals(s.get(0, 'size'), 3);
  assertEquals(s.get(0, 't'), 'undefined');
});

Deno.test("data property descriptor", () => {
  const s = run(`
    let d = Object.getOwnPropertyDescriptor({ a: 42 }, "a");
    let v = d.value; let w = d.writable; let e = d.enumerable; let c = d.configurable;
  `);
  assertEquals(s.get(0, 'v'), 42);
  assertEquals(s.get(0, 'w'), true);
  assertEquals(s.get(0, 'e'), true);
  assertEquals(s.get(0, 'c'), true);
});

Deno.test("frozen objects report writable: false, configurable: false", () => {
  const s = run(`
    let d = Object.getOwnPropertyDescriptor(Object.freeze({ a: 1 }), "a");
    let w = d.writable; let c = d.configurable;
  `);
  assertEquals(s.get(0, 'w'), false);
  assertEquals(s.get(0, 'c'), false);
});

Deno.test("accessor entries yield get/set function halves", () => {
  const s = run(`
    let o = { get x() { return 5; }, set x(v) { } };
    let d = Object.getOwnPropertyDescriptor(o, "x");
    let g = typeof d.get; let st = typeof d.set; let e = d.enumerable;
    let gotten = o.x;
  `);
  assertEquals(s.get(0, 'g'), 'function');
  assertEquals(s.get(0, 'st'), 'function');
  assertEquals(s.get(0, 'e'), true);
  assertEquals(s.get(0, 'gotten'), 5);
});

Deno.test("getter-only accessor reports set: undefined", () => {
  const s = run(`
    let o = { get x() { return 5; } };
    let d = Object.getOwnPropertyDescriptor(o, "x");
    let g = typeof d.get; let st = typeof d.set;
  `);
  assertEquals(s.get(0, 'g'), 'function');
  assertEquals(s.get(0, 'st'), 'undefined');
});

Deno.test("missing properties and non-object receivers yield undefined", () => {
  const s = run(`
    let missing = typeof Object.getOwnPropertyDescriptor({ a: 1 }, "b");
    let inherited = typeof Object.getOwnPropertyDescriptor({}, "toString");
    let primitive = typeof Object.getOwnPropertyDescriptor(42, "a");
  `);
  assertEquals(s.get(0, 'missing'), 'undefined');
  assertEquals(s.get(0, 'inherited'), 'undefined');
  assertEquals(s.get(0, 'primitive'), 'undefined');
});

Deno.test("symbol keys resolve against the sym-entries block", () => {
  const s = run(`
    let o = { [Symbol.toStringTag]: "Zed" };
    let d = Object.getOwnPropertyDescriptor(o, Symbol.toStringTag);
    let v = d.value;
  `);
  assertEquals(s.get(0, 'v'), 'Zed');
});

Deno.test("non-string keys coerce like GET_INDEX", () => {
  const s = run(`
    let d = Object.getOwnPropertyDescriptor({ "3": "three" }, 3);
    let v = d.value;
  `);
  assertEquals(s.get(0, 'v'), 'three');
});

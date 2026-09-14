/**
 * Map and Set surface.
 *
 * Coverage:
 *   - Construction, including seeding from an array argument
 *     (new Map([[k,v],...]) / new Set([...])).
 *   - Map: get / set / has / delete / clear / size; SameValueZero key
 *     equality (NaN, +0/-0); chaining (.set returns the map).
 *   - Set: add / has / delete / clear / size; SameValueZero; chaining.
 *   - Iteration: keys / values / entries / Symbol.iterator on both
 *     types; iterators are self-iterable.
 *   - Map.prototype.forEach((value, key, map) => ...) / Set.prototype.forEach
 *     ((value, key, set) => ...) — tombstone-skipping, param-count-aware
 *     argument pushing, live re-read of entries during the callback.
 *   - Spec niceties: Map.prototype[Symbol.iterator] === Map.prototype.entries;
 *     Set.prototype.keys === Set.prototype.values === Set.prototype[Symbol.iterator].
 *   - ES2025 set-theoretic methods (union / intersection / difference /
 *     symmetricDifference / isSubsetOf / isSupersetOf / isDisjointFrom)
 *     with Set arguments.
 *   - Snapshot/restore preserves Map and Set contents.
 */

import { assertEquals } from "https://deno.land/std@0.208.0/assert/mod.ts";
import { parseAndSetup } from './test-helpers.js';
import { freshSession } from '../../src/host-owned-session.js';

function run(source) {
  const session = freshSession();
  parseAndSetup(session, source);
  const result = session.run(0, 10_000_000);
  if (result.status === 'error') {
    throw new Error(`Error: ${result.error.message}`);
  }
  return session;
}

// =============================================================================
// Map
// =============================================================================

Deno.test("Map: empty constructor; size is 0", () => {
  const s = run(`let m = new Map(); let sz = m.size;`);
  assertEquals(s.get(0, 'sz'), 0);
});

Deno.test("Map: constructor seeds from array of [k, v] pairs", () => {
  const s = run(`
    let m = new Map([['a', 1], ['b', 2], ['c', 3]]);
    let sz = m.size;
    let va = m.get('a'); let vb = m.get('b'); let vc = m.get('c');
    let out = '';
    for (let [k, v] of m) out = out + k + v;
  `);
  assertEquals(s.get(0, 'sz'), 3);
  assertEquals(s.get(0, 'va'), 1);
  assertEquals(s.get(0, 'vb'), 2);
  assertEquals(s.get(0, 'vc'), 3);
  assertEquals(s.get(0, 'out'), 'a1b2c3');
});

Deno.test("Map: constructor with empty array seeds an empty map", () => {
  const s = run(`let m = new Map([]); let sz = m.size;`);
  assertEquals(s.get(0, 'sz'), 0);
});

Deno.test("Map: constructor seeding accepts later duplicate keys (last wins)", () => {
  const s = run(`
    let m = new Map([['a', 1], ['a', 2]]);
    let sz = m.size; let v = m.get('a');
  `);
  assertEquals(s.get(0, 'sz'), 1);
  assertEquals(s.get(0, 'v'), 2);
});

Deno.test("Map: constructor can be seeded past initial capacity (forces growth)", () => {
  const s = run(`
    let arr = [];
    let i = 0;
    while (i < 20) { arr.push([i, i * 10]); i = i + 1; }
    let m = new Map(arr);
    let sz = m.size;
    let v0 = m.get(0); let v19 = m.get(19);
  `);
  assertEquals(s.get(0, 'sz'), 20);
  assertEquals(s.get(0, 'v0'), 0);
  assertEquals(s.get(0, 'v19'), 190);
});

Deno.test("Map: constructor rejects a non-array argument", () => {
  const s = run(`
    let caught = null;
    try { let m = new Map(42); } catch (e) { caught = e instanceof TypeError; }
  `);
  assertEquals(s.get(0, 'caught'), true);
});

Deno.test("Map: constructor rejects entries that aren't 2-element arrays", () => {
  const s = run(`
    let caught1 = null;
    try { let m = new Map([1, 2, 3]); } catch (e) { caught1 = e instanceof TypeError; }
    let caught2 = null;
    try { let m = new Map([['a', 1, 'extra']]); } catch (e) { caught2 = e instanceof TypeError; }
  `);
  assertEquals(s.get(0, 'caught1'), true);
  assertEquals(s.get(0, 'caught2'), true);
});

Deno.test("Map: set/get/has on string keys", () => {
  const s = run(`
    let m = new Map();
    m.set('a', 1); m.set('b', 2);
    let va = m.get('a'); let vb = m.get('b'); let vc = m.get('c');
    let ha = m.has('a'); let hc = m.has('c');
    let sz = m.size;
  `);
  assertEquals(s.get(0, 'va'), 1);
  assertEquals(s.get(0, 'vb'), 2);
  assertEquals(s.get(0, 'vc'), undefined);
  assertEquals(s.get(0, 'ha'), true);
  assertEquals(s.get(0, 'hc'), false);
  assertEquals(s.get(0, 'sz'), 2);
});

Deno.test("Map: set updates existing entries in place", () => {
  const s = run(`
    let m = new Map();
    m.set('a', 1); m.set('a', 10); m.set('a', 100);
    let v = m.get('a'); let sz = m.size;
  `);
  assertEquals(s.get(0, 'v'), 100);
  assertEquals(s.get(0, 'sz'), 1);
});

Deno.test("Map: delete returns true on hit, false on miss", () => {
  const s = run(`
    let m = new Map();
    m.set('a', 1); m.set('b', 2);
    let d1 = m.delete('a'); let d2 = m.delete('z');
    let sz = m.size; let ha = m.has('a');
  `);
  assertEquals(s.get(0, 'd1'), true);
  assertEquals(s.get(0, 'd2'), false);
  assertEquals(s.get(0, 'sz'), 1);
  assertEquals(s.get(0, 'ha'), false);
});

Deno.test("Map: clear removes all entries", () => {
  const s = run(`
    let m = new Map();
    m.set('a', 1); m.set('b', 2); m.set('c', 3);
    m.clear();
    let sz = m.size; let ha = m.has('a');
  `);
  assertEquals(s.get(0, 'sz'), 0);
  assertEquals(s.get(0, 'ha'), false);
});

Deno.test("Map: SameValueZero — NaN keys work", () => {
  const s = run(`
    let m = new Map();
    m.set(NaN, 'isnan');
    let v = m.get(NaN); let h = m.has(NaN);
  `);
  assertEquals(s.get(0, 'v'), 'isnan');
  assertEquals(s.get(0, 'h'), true);
});

Deno.test("Map: SameValueZero — +0 and -0 collapse", () => {
  const s = run(`
    let m = new Map();
    m.set(0, 'plus');
    let v = m.get(-0); let sz = m.size;
    m.set(-0, 'minus');  // overwrites the same slot
    let v2 = m.get(0); let sz2 = m.size;
  `);
  assertEquals(s.get(0, 'v'), 'plus');
  assertEquals(s.get(0, 'sz'), 1);
  assertEquals(s.get(0, 'v2'), 'minus');
  assertEquals(s.get(0, 'sz2'), 1);
});

Deno.test("Map: set returns the map (chainable)", () => {
  const s = run(`
    let m = new Map();
    let r = m.set('a', 1);
    let sameRef = r === m;
  `);
  assertEquals(s.get(0, 'sameRef'), true);
});

Deno.test("Map: works with various key types", () => {
  const s = run(`
    let m = new Map();
    m.set(1, 'int');
    m.set('1', 'str');
    m.set(true, 'bool');
    m.set(null, 'null');
    m.set(undefined, 'undef');
    let sz = m.size;
    let r1 = m.get(1); let rs = m.get('1');
    let rt = m.get(true); let rn = m.get(null); let ru = m.get(undefined);
  `);
  assertEquals(s.get(0, 'sz'), 5);
  assertEquals(s.get(0, 'r1'), 'int');
  assertEquals(s.get(0, 'rs'), 'str');
  assertEquals(s.get(0, 'rt'), 'bool');
  assertEquals(s.get(0, 'rn'), 'null');
  assertEquals(s.get(0, 'ru'), 'undef');
});

// =============================================================================
// Set
// =============================================================================

Deno.test("Set: empty constructor; size is 0", () => {
  const s = run(`let st = new Set(); let sz = st.size;`);
  assertEquals(s.get(0, 'sz'), 0);
});

Deno.test("Set: constructor seeds from an array, dropping duplicates", () => {
  const s = run(`
    let st = new Set([1, 2, 3, 2, 1]);
    let sz = st.size;
    let h1 = st.has(1); let h3 = st.has(3); let h9 = st.has(9);
    let out = '';
    for (let v of st) out = out + v;
  `);
  assertEquals(s.get(0, 'sz'), 3);
  assertEquals(s.get(0, 'h1'), true);
  assertEquals(s.get(0, 'h3'), true);
  assertEquals(s.get(0, 'h9'), false);
  assertEquals(s.get(0, 'out'), '123');
});

Deno.test("Set: constructor with empty array seeds an empty set", () => {
  const s = run(`let st = new Set([]); let sz = st.size;`);
  assertEquals(s.get(0, 'sz'), 0);
});

Deno.test("Set: constructor can be seeded past initial capacity (forces growth)", () => {
  const s = run(`
    let arr = [];
    let i = 0;
    while (i < 20) { arr.push(i); i = i + 1; }
    let st = new Set(arr);
    let sz = st.size;
    let h0 = st.has(0); let h19 = st.has(19);
  `);
  assertEquals(s.get(0, 'sz'), 20);
  assertEquals(s.get(0, 'h0'), true);
  assertEquals(s.get(0, 'h19'), true);
});

Deno.test("Set: seeded set supports further mutation", () => {
  const s = run(`
    let st = new Set([1, 2, 3]);
    st.add(4); st.delete(1);
    let sz = st.size;
    let h1 = st.has(1); let h4 = st.has(4);
  `);
  assertEquals(s.get(0, 'sz'), 3);
  assertEquals(s.get(0, 'h1'), false);
  assertEquals(s.get(0, 'h4'), true);
});

Deno.test("Set: constructor rejects a non-array argument", () => {
  const s = run(`
    let caught = null;
    try { let st = new Set(42); } catch (e) { caught = e instanceof TypeError; }
  `);
  assertEquals(s.get(0, 'caught'), true);
});

Deno.test("Set: add/has; duplicates ignored", () => {
  const s = run(`
    let st = new Set();
    st.add(1); st.add(2); st.add(1);  // dup
    let sz = st.size;
    let h1 = st.has(1); let h3 = st.has(3);
  `);
  assertEquals(s.get(0, 'sz'), 2);
  assertEquals(s.get(0, 'h1'), true);
  assertEquals(s.get(0, 'h3'), false);
});

Deno.test("Set: delete returns true on hit, false on miss", () => {
  const s = run(`
    let st = new Set();
    st.add(1); st.add(2);
    let d1 = st.delete(1); let d2 = st.delete(99);
    let sz = st.size;
  `);
  assertEquals(s.get(0, 'd1'), true);
  assertEquals(s.get(0, 'd2'), false);
  assertEquals(s.get(0, 'sz'), 1);
});

Deno.test("Set: clear removes all", () => {
  const s = run(`
    let st = new Set(); st.add(1); st.add(2);
    st.clear();
    let sz = st.size;
  `);
  assertEquals(s.get(0, 'sz'), 0);
});

Deno.test("Set: SameValueZero — NaN", () => {
  const s = run(`
    let st = new Set(); st.add(NaN); st.add(NaN);
    let sz = st.size; let h = st.has(NaN);
  `);
  assertEquals(s.get(0, 'sz'), 1);
  assertEquals(s.get(0, 'h'), true);
});

Deno.test("Set: add returns the set (chainable)", () => {
  const s = run(`
    let st = new Set();
    let r = st.add(1);
    let sameRef = r === st;
  `);
  assertEquals(s.get(0, 'sameRef'), true);
});

// =============================================================================
// Iteration
// =============================================================================

Deno.test("Map: for-of yields [k, v] in insertion order", () => {
  const s = run(`
    let m = new Map();
    m.set('a', 1); m.set('b', 2); m.set('c', 3);
    let out = '';
    for (let [k, v] of m) out = out + k + v;
  `);
  assertEquals(s.get(0, 'out'), 'a1b2c3');
});

Deno.test("Map: keys() yields keys in insertion order", () => {
  const s = run(`
    let m = new Map();
    m.set('x', 1); m.set('y', 2); m.set('z', 3);
    let out = '';
    for (let k of m.keys()) out = out + k;
  `);
  assertEquals(s.get(0, 'out'), 'xyz');
});

Deno.test("Map: values() yields values in insertion order", () => {
  const s = run(`
    let m = new Map();
    m.set('a', 10); m.set('b', 20); m.set('c', 30);
    let total = 0;
    for (let v of m.values()) total = total + v;
  `);
  assertEquals(s.get(0, 'total'), 60);
});

Deno.test("Map: entries() yields [k, v] pairs", () => {
  const s = run(`
    let m = new Map();
    m.set('a', 1);
    let result = null;
    for (let pair of m.entries()) result = pair;
    let p0 = result[0]; let p1 = result[1]; let len = result.length;
  `);
  assertEquals(s.get(0, 'p0'), 'a');
  assertEquals(s.get(0, 'p1'), 1);
  assertEquals(s.get(0, 'len'), 2);
});

Deno.test("Map.prototype[Symbol.iterator] === Map.prototype.entries", () => {
  const s = run(`
    let same = Map.prototype[Symbol.iterator] === Map.prototype.entries;
  `);
  assertEquals(s.get(0, 'same'), true);
});

Deno.test("Map: deletion mid-iteration skips deleted entry", () => {
  const s = run(`
    let m = new Map();
    m.set('a', 1); m.set('b', 2); m.set('c', 3);
    let out = '';
    let i = 0;
    for (let [k, v] of m) {
      if (i === 0) m.delete('b');  // delete before reading b
      out = out + k;
      i = i + 1;
    }
  `);
  // Spec: deletion of an entry that hasn't been visited yet skips it
  // during iteration. tombstoning makes this fall out naturally.
  assertEquals(s.get(0, 'out'), 'ac');
});

Deno.test("Map: insertion during iteration is visited", () => {
  const s = run(`
    let m = new Map();
    m.set('a', 1); m.set('b', 2);
    let out = '';
    let inserted = false;
    for (let [k] of m) {
      out = out + k;
      if (!inserted) { m.set('c', 3); inserted = true; }
    }
  `);
  assertEquals(s.get(0, 'out'), 'abc');
});

Deno.test("Set: for-of yields values in insertion order", () => {
  const s = run(`
    let st = new Set();
    st.add(10); st.add(20); st.add(30);
    let total = 0;
    for (let v of st) total = total + v;
  `);
  assertEquals(s.get(0, 'total'), 60);
});

Deno.test("Set.prototype.keys === Set.prototype.values", () => {
  const s = run(`let same = Set.prototype.keys === Set.prototype.values;`);
  assertEquals(s.get(0, 'same'), true);
});

Deno.test("Set.prototype[Symbol.iterator] === Set.prototype.values", () => {
  const s = run(`
    let same = Set.prototype[Symbol.iterator] === Set.prototype.values;
  `);
  assertEquals(s.get(0, 'same'), true);
});

Deno.test("Set: entries() yields [v, v] pairs (spec quirk)", () => {
  const s = run(`
    let st = new Set();
    st.add(42);
    let result = null;
    for (let pair of st.entries()) result = pair;
    let p0 = result[0]; let p1 = result[1];
  `);
  assertEquals(s.get(0, 'p0'), 42);
  assertEquals(s.get(0, 'p1'), 42);
});

Deno.test("Iterators are self-iterable", () => {
  // map.keys()[Symbol.iterator]() returns the same iterator object.
  const s = run(`
    let m = new Map(); m.set('a', 1); m.set('b', 2);
    let it = m.keys();
    let self = it[Symbol.iterator]();
    let same = self === it;
  `);
  assertEquals(s.get(0, 'same'), true);
});

// =============================================================================
// forEach callback invocation
// =============================================================================

Deno.test("Map.forEach invokes callback once per entry with (value, key, map)", () => {
  const s = run(`
    let m = new Map([['a', 1], ['b', 2], ['c', 3]]);
    let count = 0;
    let out = '';
    let sawMap = null;
    m.forEach((value, key, map) => {
      count = count + 1;
      out = out + key + value;
      sawMap = map === m;
    });
  `);
  assertEquals(s.get(0, 'count'), 3);
  assertEquals(s.get(0, 'out'), 'a1b2c3');
  assertEquals(s.get(0, 'sawMap'), true);
});

Deno.test("Set.forEach invokes callback once per entry with (value, key, set), key === value", () => {
  const s = run(`
    let st = new Set([1, 2, 3]);
    let sum = 0;
    let count = 0;
    let keysMatchValues = true;
    let sawSet = null;
    st.forEach((value, key, set) => {
      count = count + 1;
      sum = sum + value;
      if (value !== key) keysMatchValues = false;
      sawSet = set === st;
    });
  `);
  assertEquals(s.get(0, 'count'), 3);
  assertEquals(s.get(0, 'sum'), 6);
  assertEquals(s.get(0, 'keysMatchValues'), true);
  assertEquals(s.get(0, 'sawSet'), true);
});

Deno.test("Map.forEach on empty map returns undefined without calling back", () => {
  const s = run(`
    let m = new Map();
    let calls = 0;
    let ret = m.forEach((v) => { calls = calls + 1; });
    let isUndefined = ret === undefined;
  `);
  assertEquals(s.get(0, 'calls'), 0);
  assertEquals(s.get(0, 'isUndefined'), true);
});

Deno.test("Set.forEach on empty set returns undefined without calling back", () => {
  const s = run(`
    let st = new Set();
    let calls = 0;
    let ret = st.forEach((v) => { calls = calls + 1; });
    let isUndefined = ret === undefined;
  `);
  assertEquals(s.get(0, 'calls'), 0);
  assertEquals(s.get(0, 'isUndefined'), true);
});

Deno.test("Map.forEach callback with fewer declared params only receives those", () => {
  const s = run(`
    let m = new Map([['a', 1], ['b', 2]]);
    let count = 0;
    m.forEach(() => { count = count + 1; });
  `);
  assertEquals(s.get(0, 'count'), 2);
});

Deno.test("Map.forEach skips tombstoned (deleted) entries", () => {
  const s = run(`
    let m = new Map();
    m.set('a', 1); m.set('b', 2); m.set('c', 3);
    m.delete('b');
    let out = '';
    m.forEach((v, k) => { out = out + k + v; });
  `);
  assertEquals(s.get(0, 'out'), 'a1c3');
});

Deno.test("Set.forEach skips tombstoned (deleted) entries", () => {
  const s = run(`
    let st = new Set([1, 2, 3]);
    st.delete(2);
    let out = 0;
    st.forEach((v) => { out = out + v; });
  `);
  assertEquals(s.get(0, 'out'), 4);
});

Deno.test("Map.forEach: deletion mid-iteration skips deleted entry (matches for-of semantics)", () => {
  const s = run(`
    let m = new Map();
    m.set('a', 1); m.set('b', 2); m.set('c', 3);
    let out = '';
    let deleted = false;
    m.forEach((v, k) => {
      if (!deleted) { m.delete('b'); deleted = true; }
      out = out + k;
    });
  `);
  assertEquals(s.get(0, 'out'), 'ac');
});

Deno.test("Map.forEach: insertion during iteration is visited (matches for-of semantics)", () => {
  const s = run(`
    let m = new Map();
    m.set('a', 1); m.set('b', 2);
    let out = '';
    let inserted = false;
    m.forEach((v, k) => {
      out = out + k;
      if (!inserted) { m.set('c', 3); inserted = true; }
    });
  `);
  assertEquals(s.get(0, 'out'), 'abc');
});

Deno.test("Map.forEach: non-arrow callback without thisArg sees this === undefined, doesn't throw", () => {
  const s = run(`
    let m = new Map([['a', 1]]);
    let seen = false;
    m.forEach(function (v, k) { seen = (this === undefined); });
  `);
  assertEquals(s.get(0, 'seen'), true);
});

Deno.test("Map.forEach: non-arrow callback sees this === undefined across continuation calls", () => {
  const s = run(`
    let m = new Map([['a', 1], ['b', 2], ['c', 3]]);
    let ok = true;
    m.forEach(function (v, k) { if (this !== undefined) ok = false; });
  `);
  assertEquals(s.get(0, 'ok'), true);
});

Deno.test("Set.forEach: non-arrow callback sees this === undefined across continuation calls", () => {
  const s = run(`
    let st = new Set([1, 2, 3]);
    let ok = true;
    st.forEach(function (v) { if (this !== undefined) ok = false; });
  `);
  assertEquals(s.get(0, 'ok'), true);
});

// =============================================================================
// ES2025 Set-theoretic methods with Set arguments
// =============================================================================

Deno.test("Set.union: combines elements from both sets", () => {
  const s = run(`
    let a = new Set(); a.add(1); a.add(2); a.add(3);
    let b = new Set(); b.add(2); b.add(3); b.add(4);
    let u = a.union(b);
    let sz = u.size;
    let h1 = u.has(1); let h4 = u.has(4); let h5 = u.has(5);
  `);
  assertEquals(s.get(0, 'sz'), 4);
  assertEquals(s.get(0, 'h1'), true);
  assertEquals(s.get(0, 'h4'), true);
  assertEquals(s.get(0, 'h5'), false);
});

Deno.test("Set.intersection: elements in both sets", () => {
  const s = run(`
    let a = new Set(); a.add(1); a.add(2); a.add(3);
    let b = new Set(); b.add(2); b.add(3); b.add(4);
    let i = a.intersection(b);
    let sz = i.size;
    let h2 = i.has(2); let h3 = i.has(3); let h1 = i.has(1);
  `);
  assertEquals(s.get(0, 'sz'), 2);
  assertEquals(s.get(0, 'h2'), true);
  assertEquals(s.get(0, 'h3'), true);
  assertEquals(s.get(0, 'h1'), false);
});

Deno.test("Set.difference: elements in this but not other", () => {
  const s = run(`
    let a = new Set(); a.add(1); a.add(2); a.add(3);
    let b = new Set(); b.add(2); b.add(3); b.add(4);
    let d = a.difference(b);
    let sz = d.size;
    let h1 = d.has(1); let h2 = d.has(2);
  `);
  assertEquals(s.get(0, 'sz'), 1);
  assertEquals(s.get(0, 'h1'), true);
  assertEquals(s.get(0, 'h2'), false);
});

Deno.test("Set.symmetricDifference: elements in either but not both", () => {
  const s = run(`
    let a = new Set(); a.add(1); a.add(2); a.add(3);
    let b = new Set(); b.add(2); b.add(3); b.add(4);
    let sd = a.symmetricDifference(b);
    let sz = sd.size;
    let h1 = sd.has(1); let h4 = sd.has(4); let h2 = sd.has(2);
  `);
  assertEquals(s.get(0, 'sz'), 2);
  assertEquals(s.get(0, 'h1'), true);
  assertEquals(s.get(0, 'h4'), true);
  assertEquals(s.get(0, 'h2'), false);
});

Deno.test("Set.isSubsetOf: true when all of this' elements are in other", () => {
  const s = run(`
    let a = new Set(); a.add(1); a.add(2);
    let b = new Set(); b.add(1); b.add(2); b.add(3);
    let yes = a.isSubsetOf(b);
    let no = b.isSubsetOf(a);
  `);
  assertEquals(s.get(0, 'yes'), true);
  assertEquals(s.get(0, 'no'), false);
});

Deno.test("Set.isSupersetOf: true when all of other's elements are in this", () => {
  const s = run(`
    let a = new Set(); a.add(1); a.add(2); a.add(3);
    let b = new Set(); b.add(1); b.add(2);
    let yes = a.isSupersetOf(b);
    let no = b.isSupersetOf(a);
  `);
  assertEquals(s.get(0, 'yes'), true);
  assertEquals(s.get(0, 'no'), false);
});

Deno.test("Set.isDisjointFrom: true when no shared elements", () => {
  const s = run(`
    let a = new Set(); a.add(1); a.add(2);
    let b = new Set(); b.add(3); b.add(4);
    let c = new Set(); c.add(2); c.add(5);
    let yes = a.isDisjointFrom(b);
    let no = a.isDisjointFrom(c);
  `);
  assertEquals(s.get(0, 'yes'), true);
  assertEquals(s.get(0, 'no'), false);
});

Deno.test("Set-theoretic methods: empty Set behaves correctly", () => {
  const s = run(`
    let a = new Set(); a.add(1); a.add(2);
    let empty = new Set();
    let u_sz = a.union(empty).size;
    let i_sz = a.intersection(empty).size;
    let d_sz = a.difference(empty).size;
    let sd_sz = a.symmetricDifference(empty).size;
    let sub = empty.isSubsetOf(a);
    let sup = a.isSupersetOf(empty);
    let dis = a.isDisjointFrom(empty);
  `);
  assertEquals(s.get(0, 'u_sz'), 2);   // a ∪ ∅ = a
  assertEquals(s.get(0, 'i_sz'), 0);   // a ∩ ∅ = ∅
  assertEquals(s.get(0, 'd_sz'), 2);   // a \ ∅ = a
  assertEquals(s.get(0, 'sd_sz'), 2);  // a △ ∅ = a
  assertEquals(s.get(0, 'sub'), true); // ∅ ⊆ a
  assertEquals(s.get(0, 'sup'), true); // a ⊇ ∅
  assertEquals(s.get(0, 'dis'), true); // a disjoint from ∅
});

// =============================================================================
// GC survival
// =============================================================================

Deno.test("Map survives GC with contents intact", () => {
  const session = freshSession();
  parseAndSetup(session, `
    let m = new Map();
    m.set('a', 1); m.set('b', 2); m.set('c', 3);
  `);
  let r = session.run(0, 10_000_000);
  if (r.status === 'error') throw new Error(JSON.stringify(r.error));
  session.gc();

  const parseResult = session.parse(`
    let sz = m.size;
    let va = m.get('a'); let vb = m.get('b'); let vc = m.get('c');
  `);
  session.memoryImage.setContextInstructionIndex(0, parseResult.startIndex);
  r = session.run(0, 10_000_000);
  if (r.status === 'error') throw new Error(JSON.stringify(r.error));

  assertEquals(session.get(0, 'sz'), 3);
  assertEquals(session.get(0, 'va'), 1);
  assertEquals(session.get(0, 'vb'), 2);
  assertEquals(session.get(0, 'vc'), 3);
});

Deno.test("Set survives GC with contents intact", () => {
  const session = freshSession();
  parseAndSetup(session, `
    let st = new Set();
    st.add(10); st.add(20); st.add(30);
  `);
  let r = session.run(0, 10_000_000);
  if (r.status === 'error') throw new Error(JSON.stringify(r.error));
  session.gc();

  const parseResult = session.parse(`
    let sz = st.size;
    let h10 = st.has(10); let h99 = st.has(99);
  `);
  session.memoryImage.setContextInstructionIndex(0, parseResult.startIndex);
  r = session.run(0, 10_000_000);
  if (r.status === 'error') throw new Error(JSON.stringify(r.error));

  assertEquals(session.get(0, 'sz'), 3);
  assertEquals(session.get(0, 'h10'), true);
  assertEquals(session.get(0, 'h99'), false);
});

Deno.test("Seeded Map survives GC with contents intact", () => {
  const session = freshSession();
  parseAndSetup(session, `let m = new Map([['a', 1], ['b', 2], ['c', 3]]);`);
  let r = session.run(0, 10_000_000);
  if (r.status === 'error') throw new Error(JSON.stringify(r.error));
  session.gc();

  const parseResult = session.parse(`
    let sz = m.size;
    let va = m.get('a'); let vb = m.get('b'); let vc = m.get('c');
  `);
  session.memoryImage.setContextInstructionIndex(0, parseResult.startIndex);
  r = session.run(0, 10_000_000);
  if (r.status === 'error') throw new Error(JSON.stringify(r.error));

  assertEquals(session.get(0, 'sz'), 3);
  assertEquals(session.get(0, 'va'), 1);
  assertEquals(session.get(0, 'vb'), 2);
  assertEquals(session.get(0, 'vc'), 3);
});

Deno.test("Seeded Set survives GC with contents intact", () => {
  const session = freshSession();
  parseAndSetup(session, `let st = new Set([10, 20, 30]);`);
  let r = session.run(0, 10_000_000);
  if (r.status === 'error') throw new Error(JSON.stringify(r.error));
  session.gc();

  const parseResult = session.parse(`
    let sz = st.size;
    let h10 = st.has(10); let h99 = st.has(99);
  `);
  session.memoryImage.setContextInstructionIndex(0, parseResult.startIndex);
  r = session.run(0, 10_000_000);
  if (r.status === 'error') throw new Error(JSON.stringify(r.error));

  assertEquals(session.get(0, 'sz'), 3);
  assertEquals(session.get(0, 'h10'), true);
  assertEquals(session.get(0, 'h99'), false);
});

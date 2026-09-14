/**
 * The collector must not mark uninitialized Map or Set tail slots.
 *
 * Invariant: the collector must never read a value slot at an index >= the
 * owning container's live count. Array data elements [length, capacity),
 * Map/Set entries slots [slotCount, capacity) are allocated but unwritten;
 * they hold stale bytes and must not be walked as live values.
 *
 * The fix bounds every value-walk by the live count (length / slotCount),
 * matching markScope / markParamList. This test plants a recognizable
 * pointer-typed value into a tail slot, installs collector.valueObserver,
 * runs collect(), and asserts the observer is never invoked for a tail-slot
 * address. It fails if any walk (mark / relocate) reaches past the live count.
 */

import { assert } from "https://deno.land/std@0.208.0/assert/mod.ts";
import { parseAndSetup } from './test-helpers.js';
import { freshSession } from '../../src/host-owned-session.js';
import { TYPE, GC_HEADER_SIZE, VALUE_SIZE } from '../../src/fuel/constants.js';

function build(source) {
  const session = freshSession();
  parseAndSetup(session, source);
  const r = session.run(0, 50_000_000);
  if (r.status === 'error') throw new Error(`Error: ${r.error.message}`);
  return session;
}

function rawValue(mem, name) {
  const scope = mem.getContextScope(0);
  const off = mem.internString(name);
  const p = mem.scopeLookup(scope, off);
  assert(p, `var ${name} missing`);
  return {
    type: mem.view.getUint32(mem.abs(p), true),
    dataLo: mem.view.getUint32(mem.abs(p + 8), true),
  };
}

// Run collect() with an observer that records any read of an address inside
// [tailStart, tailEnd). Returns the list of tail reads.
function observeTailReads(session, tailStart, tailEnd) {
  const reads = [];
  session.collector.valueObserver = (type, dataLo, valueAddr) => {
    if (valueAddr >= tailStart && valueAddr < tailEnd) {
      reads.push({ type, dataLo, valueAddr });
    }
  };
  try {
    session.collector.collect(session.airlock.getClosureRoots());
  } finally {
    session.collector.valueObserver = null;
  }
  return reads;
}

Deno.test("GC tail invariant: Array data tail slots [length, capacity) are not walked", () => {
  // Pre-size by pushing then leave length < capacity: a literal of 3 grows
  // its backing store with spare capacity. Plant a pointer-typed value in
  // the first unused slot.
  const session = build(`
    let victim = { tag: "v" };
    let a = [];
    a.push(victim);
  `);
  const mem = session.memoryImage, v = mem.view;
  const victim = rawValue(mem, 'victim');
  assert(victim.type === TYPE.OBJECT);

  const arr = rawValue(mem, 'a');
  assert(arr.type === TYPE.ARRAY);
  const headerData = arr.dataLo + GC_HEADER_SIZE;
  const length = v.getUint32(mem.abs(headerData), true);
  const capacity = v.getUint32(mem.abs(headerData + 4), true);
  const dataBlockHeader = v.getUint32(mem.abs(headerData + 8), true);
  const dataStart = dataBlockHeader + GC_HEADER_SIZE;
  assert(capacity > length, `need length(${length}) < capacity(${capacity})`);

  // Plant a real OBJECT value in tail slot `length`.
  const tailAddr = dataStart + length * VALUE_SIZE;
  v.setUint32(mem.abs(tailAddr), TYPE.OBJECT, true);
  v.setUint32(mem.abs(tailAddr + 8), victim.dataLo, true);

  const reads = observeTailReads(session, dataStart + length * VALUE_SIZE,
                                          dataStart + capacity * VALUE_SIZE);
  assert(reads.length === 0,
    `collector read array tail slots: ${JSON.stringify(reads)}`);
});

Deno.test("GC tail invariant: Map entries tail slots [slotCount, capacity) are not walked", () => {
  const session = build(`
    let victim = { tag: "v" };
    let m = new Map();
    m.set("k", victim);
  `);
  const mem = session.memoryImage, v = mem.view;
  const victim = rawValue(mem, 'victim');

  const map = rawValue(mem, 'm');
  assert(map.type === TYPE.MAP);
  const headerData = map.dataLo + GC_HEADER_SIZE;
  const slotCount = v.getUint32(mem.abs(headerData + 4), true);
  const capacity = v.getUint32(mem.abs(headerData + 8), true);
  const entriesHeader = v.getUint32(mem.abs(headerData + 12), true);
  const entriesData = entriesHeader + GC_HEADER_SIZE;
  assert(capacity > slotCount, `need slotCount(${slotCount}) < capacity(${capacity})`);

  // Plant a real OBJECT into both key and value of tail slot `slotCount`.
  const tailAddr = entriesData + slotCount * 36;
  v.setUint32(mem.abs(tailAddr + 4), TYPE.OBJECT, true);       // key type
  v.setUint32(mem.abs(tailAddr + 4 + 8), victim.dataLo, true); // key data_lo
  v.setUint32(mem.abs(tailAddr + 20), TYPE.OBJECT, true);      // value type
  v.setUint32(mem.abs(tailAddr + 20 + 8), victim.dataLo, true);// value data_lo

  const reads = observeTailReads(session, entriesData + slotCount * 36,
                                          entriesData + capacity * 36);
  assert(reads.length === 0,
    `collector read map tail slots: ${JSON.stringify(reads)}`);
});

Deno.test("GC tail invariant: Set entries tail slots [slotCount, capacity) are not walked", () => {
  const session = build(`
    let victim = { tag: "v" };
    let s = new Set();
    s.add(victim);
  `);
  const mem = session.memoryImage, v = mem.view;
  const victim = rawValue(mem, 'victim');

  const set = rawValue(mem, 's');
  assert(set.type === TYPE.SET);
  const headerData = set.dataLo + GC_HEADER_SIZE;
  const slotCount = v.getUint32(mem.abs(headerData + 4), true);
  const capacity = v.getUint32(mem.abs(headerData + 8), true);
  const entriesHeader = v.getUint32(mem.abs(headerData + 12), true);
  const entriesData = entriesHeader + GC_HEADER_SIZE;
  assert(capacity > slotCount, `need slotCount(${slotCount}) < capacity(${capacity})`);

  // Plant a real OBJECT into the value of tail slot `slotCount`.
  const tailAddr = entriesData + slotCount * 20;
  v.setUint32(mem.abs(tailAddr + 4), TYPE.OBJECT, true);        // value type
  v.setUint32(mem.abs(tailAddr + 4 + 8), victim.dataLo, true);  // value data_lo

  const reads = observeTailReads(session, entriesData + slotCount * 20,
                                          entriesData + capacity * 20);
  assert(reads.length === 0,
    `collector read set tail slots: ${JSON.stringify(reads)}`);
});

Deno.test("GC tail invariant: live entries still marked + heap intact after collect", () => {
  // Sanity: the fix must still mark the LIVE slots. Build containers whose
  // values are otherwise-unreferenced objects; after gc(), they must survive
  // and be readable.
  const session = build(`
    let a = [];
    a.push({ n: 1 });
    a.push({ n: 2 });
    let m = new Map();
    m.set("x", { n: 3 });
    let s = new Set();
    s.add({ n: 4 });
  `);
  session.gc();
  parseAndSetup(session, `
    let r0 = a[0].n; let r1 = a[1].n;
    let r2 = m.get("x").n;
    let r3 = 0; for (let e of s) { r3 = e.n; }
  `);
  const r = session.run(0, 50_000_000);
  if (r.status === 'error') throw new Error(`Error: ${r.error.message}`);
  assert(session.get(0, 'r0') === 1, 'a[0] lost after gc');
  assert(session.get(0, 'r1') === 2, 'a[1] lost after gc');
  assert(session.get(0, 'r2') === 3, 'map value lost after gc');
  assert(session.get(0, 'r3') === 4, 'set value lost after gc');
});

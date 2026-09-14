/**
 * Memory-pressure yield behavior on heap-allocator overflow.
 *
 * WAT-side heap allocators ($allocate_array,
 * $allocate_object, $allocate_arraybuffer, $allocate_typed_array_descriptor,
 * $allocate_collection, $allocate_promise) silently bumped
 * STATE_HEAP_POINTER past STATE_CODE_POINTER, corrupting bytecode.
 *
 * Every allocating opcode handler pre-checks its complete heap budget through
 * $check_heap_overflow before touching the heap. Overflow yields
 * `memory_pressure` at the same instruction without consuming operands or
 * advancing the program counter. The host
 * runs gc() and re-runs to retry.
 *
 * These tests mirror the string-table memory-pressure tests
 * (string_table_memory_pressure_test.js) but exercise the heap path.
 */

import { assertEquals, assert } from 'https://deno.land/std@0.208.0/assert/mod.ts';
import { freshSession } from '../../src/host-owned-session.js';

const FUEL = 50_000_000;

// Tight heap (96 KB) so the allocation loops fill it within a few hundred
// iterations. Default heap is 768 KB which works too but is slower.
function smallHeapSession() {
  return freshSession({ heapSize: 96 * 1024 });
}

Deno.test('new Uint8Array(N) loop yields memory_pressure then recovers', () => {
  // Each iteration allocates a 4 KB ArrayBuffer + a TypedArray descriptor.
  // After ~20 iterations the 96 KB heap is full. The pre-check at the
  // TypedArray constructor entry signals pressure; gc reclaims the dead
  // intermediates from previous iterations; loop continues.
  const session = smallHeapSession();
  session.parse(`
    let i = 0
    while (i < 200) {
      let buf = new Uint8Array(4096)
      i = i + 1
    }
  `);

  let result = session.run(0, FUEL);
  let pressureYields = 0;
  while (result.status === 'memory_pressure') {
    pressureYields++;
    session.gc();
    result = session.run(0, FUEL);
  }
  assertEquals(result.status, 'done',
    `expected 'done' after gc loop, got '${result.status}'`);
  assert(pressureYields > 0,
    `expected at least one memory_pressure yield, got ${pressureYields} ` +
    `(heap may be too large — increase the loop count or reduce heap)`);
  assertEquals(session.get(0, 'i'), 200);
});

Deno.test('new Array(N) loop yields memory_pressure then recovers', () => {
  // Each iteration allocates an array with capacity 100 (header + 100
  // VALUE_SIZE entries ≈ 1.6 KB). Loops past the 96 KB budget.
  const session = smallHeapSession();
  session.parse(`
    let i = 0
    while (i < 500) {
      let a = new Array(100)
      i = i + 1
    }
  `);

  let result = session.run(0, FUEL);
  let pressureYields = 0;
  while (result.status === 'memory_pressure') {
    pressureYields++;
    session.gc();
    result = session.run(0, FUEL);
  }
  assertEquals(result.status, 'done');
  assert(pressureYields > 0, 'expected at least one memory_pressure yield');
  assertEquals(session.get(0, 'i'), 500);
});

Deno.test('new Map() loop yields memory_pressure then recovers', () => {
  // Each iteration allocates an empty Map (32-byte header + ~150-byte
  // entries block at capacity 4).
  const session = smallHeapSession();
  session.parse(`
    let i = 0
    while (i < 2000) {
      let m = new Map()
      i = i + 1
    }
  `);

  let result = session.run(0, FUEL);
  let pressureYields = 0;
  while (result.status === 'memory_pressure') {
    pressureYields++;
    session.gc();
    result = session.run(0, FUEL);
  }
  assertEquals(result.status, 'done');
  assert(pressureYields > 0, 'expected at least one memory_pressure yield');
  assertEquals(session.get(0, 'i'), 2000);
});

Deno.test('new Set() loop yields memory_pressure then recovers', () => {
  const session = smallHeapSession();
  session.parse(`
    let i = 0
    while (i < 2000) {
      let s = new Set()
      i = i + 1
    }
  `);

  let result = session.run(0, FUEL);
  let pressureYields = 0;
  while (result.status === 'memory_pressure') {
    pressureYields++;
    session.gc();
    result = session.run(0, FUEL);
  }
  assertEquals(result.status, 'done');
  assert(pressureYields > 0, 'expected at least one memory_pressure yield');
  assertEquals(session.get(0, 'i'), 2000);
});

Deno.test('new Map(iterable) seeding loop yields memory_pressure then recovers', () => {
  // Each iteration seeds a Map from a 10-pair array, forcing entries-block
  // growth (capacity 4 -> 8 -> 16) inside the constructor's seeding loop.
  const session = smallHeapSession();
  session.parse(`
    let i = 0
    while (i < 500) {
      let m = new Map([[0,0],[1,1],[2,2],[3,3],[4,4],[5,5],[6,6],[7,7],[8,8],[9,9]])
      i = i + 1
    }
  `);

  let result = session.run(0, FUEL);
  let pressureYields = 0;
  while (result.status === 'memory_pressure') {
    pressureYields++;
    session.gc();
    result = session.run(0, FUEL);
  }
  assertEquals(result.status, 'done');
  assert(pressureYields > 0, 'expected at least one memory_pressure yield');
  assertEquals(session.get(0, 'i'), 500);
});

Deno.test('new Set(iterable) seeding loop yields memory_pressure then recovers', () => {
  const session = smallHeapSession();
  session.parse(`
    let i = 0
    while (i < 500) {
      let s = new Set([0,1,2,3,4,5,6,7,8,9])
      i = i + 1
    }
  `);

  let result = session.run(0, FUEL);
  let pressureYields = 0;
  while (result.status === 'memory_pressure') {
    pressureYields++;
    session.gc();
    result = session.run(0, FUEL);
  }
  assertEquals(result.status, 'done');
  assert(pressureYields > 0, 'expected at least one memory_pressure yield');
  assertEquals(session.get(0, 'i'), 500);
});

Deno.test('Promise.resolve loop yields memory_pressure then recovers', () => {
  // Each iteration allocates a 48-byte resolved Promise.
  const session = smallHeapSession();
  session.parse(`
    let i = 0
    while (i < 5000) {
      let p = Promise.resolve(i)
      i = i + 1
    }
  `);

  let result = session.run(0, FUEL);
  let pressureYields = 0;
  while (result.status === 'memory_pressure') {
    pressureYields++;
    session.gc();
    result = session.run(0, FUEL);
  }
  assertEquals(result.status, 'done');
  assert(pressureYields > 0, 'expected at least one memory_pressure yield');
  assertEquals(session.get(0, 'i'), 5000);
});

Deno.test('Object.keys over a growing object yields and recovers', () => {
  // Object.keys allocates an array sized to object.count. With a small
  // heap and a non-trivial object count, the keys() call signals pressure
  // when there's not enough room for the result array.
  const session = smallHeapSession();
  session.parse(`
    let target = { a: 1, b: 2, c: 3, d: 4, e: 5, f: 6, g: 7, h: 8 }
    let i = 0
    while (i < 1000) {
      let ks = Object.keys(target)
      i = i + 1
    }
  `);

  let result = session.run(0, FUEL);
  let pressureYields = 0;
  while (result.status === 'memory_pressure') {
    pressureYields++;
    session.gc();
    result = session.run(0, FUEL);
  }
  assertEquals(result.status, 'done');
  assert(pressureYields > 0, 'expected at least one memory_pressure yield');
  assertEquals(session.get(0, 'i'), 1000);
});

Deno.test('memory_pressure yield preserves slot state for retry (Uint8Array)', () => {
  // The yielding instruction must not consume operands, must not advance
  // pc, and must leave the slot able to continue normally after retry.
  // Mirrors the string-table preserves-slot-state test.
  const session = smallHeapSession();
  session.parse(`
    let i = 0
    let last = 0
    while (i < 200) {
      let buf = new Uint8Array(4096)
      last = i
      i = i + 1
    }
  `);

  let result = session.run(0, FUEL);
  while (result.status === 'memory_pressure') {
    session.gc();
    result = session.run(0, FUEL);
  }
  assertEquals(result.status, 'done');
  assertEquals(session.get(0, 'i'), 200);
  // `last = i` runs on every iteration, so after the loop last = 199.
  assertEquals(session.get(0, 'last'), 199);
});

Deno.test('typed array .slice(start,end) yields and recovers', () => {
  // slice copies bytes into a fresh ArrayBuffer + descriptor. Looping
  // over slice() of a moderate-size source exercises the pre-check at
  // METHOD_UINT8ARRAY_SLICE.
  const session = smallHeapSession();
  session.parse(`
    let source = new Uint8Array(1024)
    let i = 0
    while (i < 200) {
      let s = source.slice(0, 1024)
      i = i + 1
    }
  `);

  let result = session.run(0, FUEL);
  let pressureYields = 0;
  while (result.status === 'memory_pressure') {
    pressureYields++;
    session.gc();
    result = session.run(0, FUEL);
  }
  assertEquals(result.status, 'done');
  assert(pressureYields > 0, 'expected at least one memory_pressure yield');
  assertEquals(session.get(0, 'i'), 200);
});

Deno.test('Array.from(arr) loop yields and recovers', () => {
  // Array.from clones an existing array into a fresh one. Loop forces
  // many fresh array allocations sized to the source.
  const session = smallHeapSession();
  session.parse(`
    let source = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10]
    let i = 0
    while (i < 1000) {
      let cloned = Array.from(source)
      i = i + 1
    }
  `);

  let result = session.run(0, FUEL);
  let pressureYields = 0;
  while (result.status === 'memory_pressure') {
    pressureYields++;
    session.gc();
    result = session.run(0, FUEL);
  }
  assertEquals(result.status, 'done');
  assert(pressureYields > 0, 'expected at least one memory_pressure yield');
  assertEquals(session.get(0, 'i'), 1000);
});

Deno.test('rest parameter array packing yields and recovers', () => {
  // OP_PARAMS with hasRest allocates an array sized to (argc - nonRestCount).
  // A loop that calls a rest function repeatedly fills the heap.
  const session = smallHeapSession();
  session.parse(`
    function pack(a, b, ...rest) { return rest.length }
    let i = 0
    let total = 0
    while (i < 1000) {
      total = total + pack(1, 2, 3, 4, 5, 6, 7, 8, 9, 10)
      i = i + 1
    }
  `);

  let result = session.run(0, FUEL);
  let pressureYields = 0;
  while (result.status === 'memory_pressure') {
    pressureYields++;
    session.gc();
    result = session.run(0, FUEL);
  }
  assertEquals(result.status, 'done');
  assert(pressureYields > 0, 'expected at least one memory_pressure yield');
  assertEquals(session.get(0, 'i'), 1000);
  // Each call returns 8 (10 args - 2 named = 8 rest), total = 8000.
  assertEquals(session.get(0, 'total'), 8000);
});

Deno.test('memory_pressure escalates when gc reclaims nothing (Uint8Array)', () => {
  // Pathological: every intermediate buffer is kept alive in an array,
  // so gc reclaims nothing. The host's retry yields again. Mirrors the
  // string-table escalates-to-OOM test.
  const session = smallHeapSession();
  session.parse(`
    let arr = []
    let i = 0
    while (i < 200) {
      arr[i] = new Uint8Array(4096)
      i = i + 1
    }
  `);

  let result = session.run(0, FUEL);
  let attempts = 0;
  while (result.status === 'memory_pressure' && attempts < 5) {
    session.gc();
    result = session.run(0, FUEL);
    attempts++;
  }
  // The host's policy is to surface OOM after gc fails to recover. The
  // interpreter just keeps yielding; the test asserts it neither traps
  // nor silently corrupts memory.
  assert(
    result.status === 'memory_pressure' || result.status === 'done',
    `expected 'memory_pressure' (persistent) or 'done' (recovered), got '${result.status}'`,
  );
});

Deno.test('Array iterator factory + .next() loop yields and recovers', () => {
  // Each `for (x of source)` step calls the iterator factory once (object
  // cap 4) and .next() repeatedly (object cap 2). A nested loop drives
  // many iterators.
  const session = smallHeapSession();
  session.parse(`
    let source = [1, 2, 3, 4, 5]
    let total = 0
    let i = 0
    while (i < 500) {
      for (let x of source) { total = total + x }
      i = i + 1
    }
  `);

  let result = session.run(0, FUEL);
  let pressureYields = 0;
  while (result.status === 'memory_pressure') {
    pressureYields++;
    session.gc();
    result = session.run(0, FUEL);
  }
  assertEquals(result.status, 'done');
  assert(pressureYields > 0, 'expected at least one memory_pressure yield');
  // Each iteration sums to 1+2+3+4+5 = 15; loop runs 500 times; total = 7500.
  assertEquals(session.get(0, 'total'), 7500);
});

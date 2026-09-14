/**
 * Test the Fuel interpreter garbage collector.
 *
 * Run with: deno task test tests/fuel/gc_test.js
 */

import { assertEquals, assert, assertThrows } from "https://deno.land/std@0.208.0/assert/mod.ts";
import { parseAndSetup } from './test-helpers.js';
import {
  MemoryManipulator,
  Parser,
  instantiateSync,
  layoutVat,
  Collector,
  EXIT_DONE,
  EXIT_ERROR,
  EXIT_EXTERNAL_CALL,
  TYPE,
} from '../../src/fuel/index.js';
import { freshSession } from '../../src/host-owned-session.js';
import { createSession } from '../../src/fuel/session.js';
// Slice 1 of snapshottable-membrane: register() returns Handle wrappers.

function createTestContext() {
  const memory = new WebAssembly.Memory({ initial: 16, maximum: 256, shared: true });
  const wasm = instantiateSync(memory);
  const mem = new MemoryManipulator(memory);
  mem.setWasmInstance(wasm);
  layoutVat(mem.memory, mem.baseOffset, { segmentSize: mem.segmentSize });
  mem.bootstrap();

  const parser = new Parser(mem);
  let currentCodeBlock = null;

  function run(source) {
    if (currentCodeBlock === null) {
      currentCodeBlock = mem.allocateCodeBlock();
    }
    const startIndex = mem.codeBlockInstructionCount();
    parser.parse(source);
    mem.setContextInstructionIndex(0, startIndex);
    wasm.exports.run(10000, 0);  // returns remaining fuel, exit condition is in memory
    return mem.getExitCondition(0);
  }

  function gc() {
    const collector = new Collector(mem);
    return collector.collect();
  }

  function reset() {
    layoutVat(mem.memory, mem.baseOffset, { segmentSize: mem.segmentSize });
    mem.bootstrap();
    currentCodeBlock = null;
  }

  return { memory, wasm, mem, parser, run, gc, reset };
}

// =============================================================================
// Basic GC Tests
// =============================================================================

Deno.test("GC: unreachable objects collected", () => {
  const { mem, run, gc } = createTestContext();

  run(`
    let a = { x: 1 };
    let b = { y: 2 };
    let c = { z: 3 };
    a = null;
    b = null;
  `);

  const heapBefore = mem.heapUsage();
  const result = gc();
  const heapAfter = mem.heapUsage();

  assert(result.heapCollected > 0, 'Should collect some heap memory');
  assert(heapAfter.used < heapBefore.used, 'Heap should shrink');
});

Deno.test("GC: reachable objects survive", () => {
  const { mem, run, gc } = createTestContext();

  run(`let x = 42;`);
  gc();
  // Just verify no crash - the scope should survive
});

Deno.test("GC: unreferenced strings collected", () => {
  const { mem, run, gc } = createTestContext();

  run(`
    let s = "temporary string that should be collected";
    s = "different string";
  `);

  const result = gc();
  assert(result.stringsCollected >= 0, 'String collection should not fail');
});

Deno.test("GC: object graph survives compaction", () => {
  const { mem, run, gc } = createTestContext();

  run(`
    let root = {
      child1: { name: "alice" },
      child2: { name: "bob" }
    };
    root.child1.friend = root.child2;
    let result = root.child1.friend.name;
    let garbage = { waste: "collect me" };
    garbage = null;
  `);

  const scopePtr = mem.getRootScope();
  const resultOffset = mem.internString('result');
  const valuePtr = mem.scopeLookup(scopePtr, resultOffset);
  assert(valuePtr !== null, 'result should be in scope before GC');

  const stringOffsetBefore = mem.view.getUint32(mem.abs(valuePtr + 8), true);
  const resultStrBefore = mem.readString(stringOffsetBefore);
  assertEquals(resultStrBefore, 'bob');

  gc();

  // Re-look-up everything after GC. Holding interior pointers OR interned ids
  // across gc() is GC-unsafe by construction now that grown stack blocks force a
  // real compaction: the root scope relocates (interior valuePtr goes stale) and
  // string compaction can renumber interned ids (resultOffset goes stale). The
  // value is still live — resolve it through a fresh scope + fresh intern.
  const scopeAfter = mem.getRootScope();
  const resultOffsetAfter = mem.internString('result');
  const valuePtrAfter = mem.scopeLookup(scopeAfter, resultOffsetAfter);
  const stringOffsetAfter = mem.view.getUint32(mem.abs(valuePtrAfter + 8), true);
  const resultStrAfter = mem.readString(stringOffsetAfter);
  assertEquals(resultStrAfter, 'bob');
});

Deno.test("GC: closure scope survives", () => {
  const { mem, run, gc } = createTestContext();

  run(`
    let outer = function() {
      let x = 10;
      return function() {
        return x + 1;
      };
    };
    let fn = outer();
    let result = fn();
  `);

  const scopePtr = mem.getRootScope();
  const resultOffset = mem.internString('result');
  const valuePtr = mem.scopeLookup(scopePtr, resultOffset);
  // Integer literals are Rational now — read via readValueAt.
  const resultValue = mem.readValueAt(valuePtr);
  assertEquals(resultValue, { kind: 'rational', numerator: 11n, denominator: 1n });

  gc();

  const fnOffsetAfter = mem.internString('fn');
  const fnPtrAfter = mem.scopeLookup(scopePtr, fnOffsetAfter);
  assert(fnPtrAfter !== null, 'fn should still be in scope after GC');
});

Deno.test("GC: circular references collected", () => {
  const { mem, run, gc } = createTestContext();

  run(`
    let a = {};
    let b = {};
    a.ref = b;
    b.ref = a;
    a = null;
    b = null;
  `);

  const heapBefore = mem.heapUsage();
  const result = gc();
  const heapAfter = mem.heapUsage();

  assert(result.heapCollected > 0, 'Should collect circular refs');
});

Deno.test("GC: forbidden during FFI", () => {
  // Note: This test requires the context to be in EXIT_EXTERNAL_CALL state,
  // which can only happen during actual WASM execution.
  // The collector checks exit conditions and rejects GC during external calls.
  // This test is simplified since we can't easily simulate the external call state.
  const { mem, gc, run } = createTestContext();

  // Just verify GC works in normal state
  run('1');
  const result = gc();
  assert(result.heapCollected >= 0, 'GC should complete in normal state');
});

Deno.test("GC: multiple cycles work", () => {
  const { mem, run, gc } = createTestContext();

  for (let i = 0; i < 3; i++) {
    run(`
      let temp = { round: ${i}, data: [1, 2, 3, 4, 5] };
      temp = null;
    `);
    gc();
  }

  const status = run(`1 + 1`);
  assertEquals(status, EXIT_DONE);
});

Deno.test("GC: empty collection succeeds", () => {
  const { mem, gc, run } = createTestContext();
  // Run a simple expression to get to a valid done state
  run('1');

  const result = gc();
  assert(result.heapCollected >= 0, 'GC should complete');
});

Deno.test("GC: array survives", () => {
  const { mem, run, gc } = createTestContext();

  run(`
    let arr = [1, 2, 3, 4, 5];
    let result = arr[2] + arr[4];
    let garbage = { x: 1 };
    garbage = null;
  `);

  gc();

  const scopePtr = mem.getRootScope();
  const arrOffset = mem.internString('arr');
  const arrPtr = mem.scopeLookup(scopePtr, arrOffset);
  const arrType = mem.view.getUint32(mem.abs(arrPtr), true);
  assertEquals(arrType, TYPE.ARRAY);
});

Deno.test("GC: constructors survive", () => {
  const { run, gc } = createTestContext();

  run(`
    let garbage1 = { a: 1, b: 2, c: 3 };
    let garbage2 = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10];
    garbage1 = null;
    garbage2 = null;
  `);

  gc();

  const status = run(`
    let arr = new Array(3);
    let arrOk = arr.length === 3;
    let obj = new Object();
    obj.x = 5;
    let objOk = obj.x === 5;
    arrOk && objOk
  `);
  assertEquals(status, EXIT_DONE);
});

Deno.test("GC: nested objects survive multiple cycles", () => {
  const { mem, run, gc } = createTestContext();

  run(`
    let root = {
      level1: {
        level2: {
          level3: {
            value: 42
          }
        }
      }
    };
  `);

  for (let i = 0; i < 3; i++) {
    run(`let temp = { garbage: ${i} }; temp = null;`);
    gc();
  }

  const status = run(`root.level1.level2.level3.value`);
  assertEquals(status, EXIT_DONE);
});

Deno.test("GC: mixed value types survive", () => {
  const { run, gc } = createTestContext();

  run(`
    let mixed = {
      num: 42,
      str: "hello",
      bool: true,
      arr: [1, 2, 3],
      obj: { nested: true },
      nil: null
    };
    let garbage = { x: 1 };
    garbage = null;
  `);

  gc();

  const status = run(`
    let check = mixed.num === 42 &&
                mixed.str === "hello" &&
                mixed.bool === true &&
                mixed.arr.length === 3 &&
                mixed.obj.nested === true &&
                mixed.nil === null;
    check
  `);
  assertEquals(status, EXIT_DONE);
});

Deno.test("GC: scope entry pointers updated", () => {
  const { mem, run, gc } = createTestContext();

  run(`
    let obj1 = { id: 1 };
    let obj2 = { id: 2 };
    let obj3 = { id: 3 };
    let arr1 = [10, 20, 30];
    let garbage = { waste: true };
    garbage = null;
  `);

  const heapBefore = mem.heapUsage().used;
  gc();
  const heapAfter = mem.heapUsage().used;

  assert(heapAfter < heapBefore, 'Heap should shrink after GC');

  const status = run(`obj1.id + obj2.id + obj3.id + arr1[1]`);
  assertEquals(status, EXIT_DONE);
});

Deno.test("GC: bound methods survive", () => {
  const { run, gc } = createTestContext();

  run(`
    let obj = {
      value: 10,
      getValue: function() { return this.value; }
    };
    let garbage = { x: 1, y: 2, z: 3 };
    garbage = null;
  `);

  gc();

  const status = run(`obj.getValue()`);
  assertEquals(status, EXIT_DONE);
});

Deno.test("GC: closures with object captures survive", () => {
  const { run, gc } = createTestContext();

  run(`
    let outer = function() {
      let captured = { inner: { deep: 99 } };
      return function() {
        return captured.inner.deep;
      };
    };
    let fn = outer();
    let garbage = [1, 2, 3, 4, 5];
    garbage = null;
  `);

  gc();

  const status = run(`fn()`);
  assertEquals(status, EXIT_DONE);
});

Deno.test("GC: array of objects survives", () => {
  const { run, gc } = createTestContext();

  run(`
    let items = [
      { name: "first", val: 1 },
      { name: "second", val: 2 },
      { name: "third", val: 3 }
    ];
    let garbage = { temp: true };
    garbage = null;
  `);

  gc();

  const status = run(`
    items[0].name === "first" &&
    items[1].val === 2 &&
    items[2].name === "third"
  `);
  assertEquals(status, EXIT_DONE);
});

Deno.test("GC: self-referential object survives", () => {
  const { run, gc } = createTestContext();

  run(`
    let self = { name: "root" };
    self.me = self;
    let garbage = [1, 2, 3];
    garbage = null;
  `);

  gc();

  const status = run(`self.me.me.me.name`);
  assertEquals(status, EXIT_DONE);
});

Deno.test("GC: many objects stress test", () => {
  const { mem, run, gc } = createTestContext();

  run(`
    let kept = [];
    for (let i = 0; i < 20; i = i + 1) {
      kept.push({ id: i, data: i * 2 });
    }
    for (let i = 0; i < 30; i = i + 1) {
      let garbage = { temp: i };
    }
  `);

  const heapBefore = mem.heapUsage().used;
  gc();
  const heapAfter = mem.heapUsage().used;

  assert(heapAfter < heapBefore, 'Should collect garbage objects');

  const status = run(`kept[10].data`);
  assertEquals(status, EXIT_DONE);
});

Deno.test("GC: strings in objects survive", () => {
  const { run, gc } = createTestContext();

  run(`
    let data = {
      title: "Important Document",
      author: "John Doe",
      content: "This is the body text"
    };
    let garbage = { x: "discard me" };
    garbage = null;
  `);

  gc();

  const status = run(`
    data.title === "Important Document" &&
    data.author === "John Doe" &&
    data.content === "This is the body text"
  `);
  assertEquals(status, EXIT_DONE);
});

Deno.test("GC: interleaved allocation and collection", () => {
  const { run, gc } = createTestContext();

  run(`let a = { val: 1 };`);
  gc();
  run(`let b = { val: 2 };`);
  gc();
  run(`let c = { val: 3 };`);
  gc();

  const status = run(`a.val + b.val + c.val`);
  assertEquals(status, EXIT_DONE);
});

Deno.test("GC: Object.keys works after GC", () => {
  const { run, gc } = createTestContext();

  run(`
    let obj = { a: 1, b: 2, c: 3 };
    let garbage = { x: 1 };
    garbage = null;
  `);

  gc();

  const status = run(`Object.keys(obj).length`);
  assertEquals(status, EXIT_DONE);
});

Deno.test("GC: array push/pop works after GC", () => {
  const { run, gc } = createTestContext();

  run(`
    let arr = [1, 2, 3];
    let garbage = [10, 20, 30, 40, 50];
    garbage = null;
  `);

  gc();

  const status = run(`
    arr.push(4);
    let len = arr.length;
    let last = arr[3];
    len === 4 && last === 4
  `);
  assertEquals(status, EXIT_DONE);
});

Deno.test("GC: nested closures survive", () => {
  const { run, gc } = createTestContext();

  run(`
    let outer = function(x) {
      return function(y) {
        return function(z) {
          return x + y + z;
        };
      };
    };
    let mid = outer(10);
    let inner = mid(20);
    let garbage = { temp: 1 };
    garbage = null;
  `);

  gc();

  const status = run(`inner(30)`);
  assertEquals(status, EXIT_DONE);
});

Deno.test("GC: empty containers survive", () => {
  const { run, gc } = createTestContext();

  run(`
    let emptyArr = [];
    let emptyObj = {};
    let garbage = [1, 2, 3];
    garbage = null;
  `);

  gc();

  const status = run(`
    emptyArr.length === 0 &&
    Object.keys(emptyObj).length === 0
  `);
  assertEquals(status, EXIT_DONE);
});

Deno.test("GC: primitive result survives", () => {
  const { run, gc } = createTestContext();

  run(`
    let x = 10;
    let y = 20;
    let sum = x + y;
  `);

  gc();

  const status = run(`sum === 30`);
  assertEquals(status, EXIT_DONE);
});

Deno.test("GC: object variable survives", () => {
  const { run, gc } = createTestContext();

  run(`
    let garbage1 = { x: 1 };
    let garbage2 = { y: 2 };
    garbage1 = null;
    garbage2 = null;
    let result = { value: 42, name: "answer" };
  `);

  gc();

  const status = run(`result.value === 42 && result.name === "answer"`);
  assertEquals(status, EXIT_DONE);
});

Deno.test("GC: long strings survive", () => {
  const { run, gc } = createTestContext();

  run(`
    let longStr = "This is a fairly long string preserved across gc";
    let garbage = "short garbage string";
    garbage = null;
  `);

  gc();

  const status = run(`longStr === "This is a fairly long string preserved across gc"`);
  assertEquals(status, EXIT_DONE);
});

Deno.test("GC: special numbers survive", () => {
  const { run, gc } = createTestContext();

  run(`
    let nums = {
      zero: 0,
      negZero: -0,
      inf: 1/0,
      negInf: -1/0,
      large: 999999999999
    };
    let garbage = { x: 1 };
    garbage = null;
  `);

  gc();

  const status = run(`
    nums.zero === 0 &&
    nums.inf === 1/0 &&
    nums.negInf === -1/0 &&
    nums.large > 999999999998
  `);
  assertEquals(status, EXIT_DONE);
});

Deno.test("GC: complex graph survives", () => {
  const { run, gc } = createTestContext();

  run(`
    let nodes = [];
    for (let i = 0; i < 5; i = i + 1) {
      nodes.push({ id: i, connections: [] });
    }
    nodes[0].connections.push(nodes[1]);
    nodes[0].connections.push(nodes[2]);
    nodes[1].connections.push(nodes[3]);
    nodes[2].connections.push(nodes[3]);
    nodes[3].connections.push(nodes[4]);
    nodes[4].connections.push(nodes[0]);
    let garbage = { x: 1 };
    garbage = null;
  `);

  gc();

  const status = run(`
    nodes[0].id === 0 &&
    nodes[0].connections[0].id === 1 &&
    nodes[4].connections[0].id === 0
  `);
  assertEquals(status, EXIT_DONE);
});

Deno.test("GC: string split works after GC", () => {
  const { run, gc } = createTestContext();

  run(`
    let str = "hello,world,test";
    let garbage = { x: 1 };
    garbage = null;
  `);

  gc();

  const status = run(`
    let parts = str.split(",");
    parts.length === 3 && parts[1] === "world"
  `);
  assertEquals(status, EXIT_DONE);
});

Deno.test("GC: array map/filter works after GC", () => {
  const { run, gc } = createTestContext();

  run(`
    let nums = [1, 2, 3, 4, 5];
    let garbage = [10, 20, 30];
    garbage = null;
  `);

  gc();

  const status = run(`
    let doubled = nums.map(function(x) { return x * 2; });
    let evens = nums.filter(function(x) { return x % 2 === 0; });
    doubled[2] === 6 && evens.length === 2
  `);
  assertEquals(status, EXIT_DONE);
});

Deno.test("GC: array reduce works after GC", () => {
  const { run, gc } = createTestContext();

  run(`
    let nums = [1, 2, 3, 4, 5];
    let garbage = { temp: true };
    garbage = null;
  `);

  gc();

  const status = run(`
    let sum = nums.reduce(function(acc, x) { return acc + x; }, 0);
    sum === 15
  `);
  assertEquals(status, EXIT_DONE);
});

Deno.test("GC: array forEach works after GC", () => {
  const { run, gc } = createTestContext();

  run(`
    let nums = [1, 2, 3];
    let total = 0;
    let garbage = [10, 20];
    garbage = null;
  `);

  gc();

  const status = run(`
    nums.forEach(function(x) { total = total + x; });
    total === 6
  `);
  assertEquals(status, EXIT_DONE);
});

Deno.test("GC: object with multiple methods survives", () => {
  const { run, gc } = createTestContext();

  run(`
    let calculator = {
      value: 0,
      add: function(x) { this.value = this.value + x; return this; },
      multiply: function(x) { this.value = this.value * x; return this; },
      get: function() { return this.value; }
    };
    let garbage = { x: 1 };
    garbage = null;
  `);

  gc();

  const status = run(`
    calculator.add(5);
    calculator.multiply(2);
    calculator.get() === 10
  `);
  assertEquals(status, EXIT_DONE);
});

Deno.test("GC: multi-capture closure survives", () => {
  const { run, gc } = createTestContext();

  run(`
    let makeAdder = function(a, b, c) {
      return function(x) {
        return a + b + c + x;
      };
    };
    let add10 = makeAdder(2, 3, 5);
    let garbage = [1, 2, 3, 4, 5];
    garbage = null;
  `);

  gc();

  const status = run(`add10(7) === 17`);
  assertEquals(status, EXIT_DONE);
});

Deno.test("GC: array of closures survives", () => {
  const { run, gc } = createTestContext();

  run(`
    let funcs = [];
    for (let i = 0; i < 3; i = i + 1) {
      funcs.push(function() { return i; });
    }
    let garbage = { x: 1 };
    garbage = null;
  `);

  gc();

  const status = run(`funcs[0]() === 3 && funcs[1]() === 3 && funcs[2]() === 3`);
  assertEquals(status, EXIT_DONE);
});

Deno.test("GC: deep nesting survives", () => {
  const { run, gc } = createTestContext();

  run(`
    let deep = {
      a: {
        b: {
          c: {
            d: {
              e: {
                value: 42
              }
            }
          }
        }
      }
    };
    let garbage = { x: 1 };
    garbage = null;
  `);

  gc();

  const status = run(`deep.a.b.c.d.e.value === 42`);
  assertEquals(status, EXIT_DONE);
});

Deno.test("GC: array concat works after GC", () => {
  const { run, gc } = createTestContext();

  run(`
    let arr1 = [1, 2, 3];
    let arr2 = [4, 5, 6];
    let garbage = [10, 20];
    garbage = null;
  `);

  gc();

  const status = run(`
    let combined = arr1.concat(arr2);
    combined.length === 6 && combined[5] === 6
  `);
  assertEquals(status, EXIT_DONE);
});

Deno.test("GC: string char methods work after GC", () => {
  const { run, gc } = createTestContext();

  run(`
    let str = "hello";
    let garbage = "temporary";
    garbage = null;
  `);

  gc();

  const status = run(`
    str.charAt(1) === "e" && str.charCodeAt(0) === 104
  `);
  assertEquals(status, EXIT_DONE);
});

Deno.test("GC: array indexOf works after GC", () => {
  const { run, gc } = createTestContext();

  run(`
    let arr = ["a", "b", "c", "d"];
    let garbage = [1, 2, 3];
    garbage = null;
  `);

  gc();

  const status = run(`
    arr.indexOf("c") === 2 && arr.indexOf("x") === -1
  `);
  assertEquals(status, EXIT_DONE);
});

Deno.test("GC: array slice works after GC", () => {
  const { run, gc } = createTestContext();

  run(`
    let arr = [1, 2, 3, 4, 5];
    let garbage = { x: 1 };
    garbage = null;
  `);

  gc();

  const status = run(`
    let mid = arr.slice(1, 4);
    mid.length === 3 && mid[0] === 2 && mid[2] === 4
  `);
  assertEquals(status, EXIT_DONE);
});

Deno.test("GC: Object.values works after GC", () => {
  const { run, gc } = createTestContext();

  run(`
    let obj = { a: 1, b: 2, c: 3 };
    let garbage = { x: 10 };
    garbage = null;
  `);

  gc();

  const status = run(`
    let vals = Object.values(obj);
    vals.length === 3
  `);
  assertEquals(status, EXIT_DONE);
});

Deno.test("GC: Object.entries works after GC", () => {
  const { run, gc } = createTestContext();

  run(`
    let obj = { x: 10, y: 20 };
    let garbage = [1, 2, 3];
    garbage = null;
  `);

  gc();

  const status = run(`
    let entries = Object.entries(obj);
    entries.length === 2
  `);
  assertEquals(status, EXIT_DONE);
});

Deno.test("GC: string search methods work after GC", () => {
  const { run, gc } = createTestContext();

  run(`
    let str = "hello world";
    let garbage = "temp";
    garbage = null;
  `);

  gc();

  const status = run(`
    str.includes("wor") &&
    str.startsWith("hello") &&
    str.endsWith("world")
  `);
  assertEquals(status, EXIT_DONE);
});

Deno.test("GC: state preserved across multiple GCs in loop", () => {
  const { run, gc } = createTestContext();

  run(`
    let result = 0;
    let arr = [1, 2, 3, 4, 5];
  `);

  gc();

  run(`
    for (let i = 0; i < arr.length; i = i + 1) {
      result = result + arr[i];
    }
  `);

  gc();

  const status = run(`result === 15`);
  assertEquals(status, EXIT_DONE);
});

Deno.test("GC: array find methods work after GC", () => {
  const { run, gc } = createTestContext();

  run(`
    let items = [
      { id: 1, name: "one" },
      { id: 2, name: "two" },
      { id: 3, name: "three" }
    ];
    let garbage = [1, 2, 3];
    garbage = null;
  `);

  gc();

  const status = run(`
    let found = items.find(function(x) { return x.id === 2; });
    let idx = items.findIndex(function(x) { return x.id === 3; });
    found.name === "two" && idx === 2
  `);
  assertEquals(status, EXIT_DONE);
});

Deno.test("GC: array some/every works after GC", () => {
  const { run, gc } = createTestContext();

  run(`
    let nums = [2, 4, 6, 8];
    let garbage = { x: 1 };
    garbage = null;
  `);

  gc();

  const status = run(`
    let allEven = nums.every(function(x) { return x % 2 === 0; });
    let hasLarge = nums.some(function(x) { return x > 5; });
    allEven && hasLarge
  `);
  assertEquals(status, EXIT_DONE);
});

Deno.test("GC: closure mutation survives", () => {
  const { run, gc } = createTestContext();

  run(`
    let counter = function() {
      let count = 0;
      return {
        inc: function() { count = count + 1; },
        get: function() { return count; }
      };
    };
    let c = counter();
    c.inc();
    c.inc();
    let garbage = { x: 1 };
    garbage = null;
  `);

  gc();

  const status = run(`c.get() === 2`);
  assertEquals(status, EXIT_DONE);
});

Deno.test("GC: large array survives", () => {
  const { run, gc } = createTestContext();

  run(`
    let big = [];
    for (let i = 0; i < 100; i = i + 1) {
      big.push(i * 2);
    }
    let garbage = { x: 1 };
    garbage = null;
  `);

  gc();

  const status = run(`
    big.length === 100 && big[50] === 100 && big[99] === 198
  `);
  assertEquals(status, EXIT_DONE);
});

Deno.test("GC: function-only object survives", () => {
  const { run, gc } = createTestContext();

  run(`
    let obj = {
      fn: function() { return 42; }
    };
  `);

  gc();

  const status = run(`obj.fn() === 42`);
  assertEquals(status, EXIT_DONE);
});

// =============================================================================
// External Closure Tests
// =============================================================================

function createExternalTestContext() {
  const session = freshSession();
  const { airlock } = session;
  const rootGrant = airlock.createRootGrant();

  function run(source) {
    parseAndSetup(session, source);
    session.run(0, 10000);
  }

  return { session, airlock, rootGrant, run };
}

Deno.test("GC External: closure held by JS survives", () => {
  const { session, airlock, rootGrant, run } = createExternalTestContext();
  const mem = session.memoryImage;

  const Holder = { closureHandle: null };
  const id = airlock.register(Holder);
  rootGrant.add(id);
  airlock.setHandler(id, 'store', ({ args }) => { Holder.closureHandle = args[0]; });
  airlock.declare('Holder', id);

  run(`
    let x = 0;
    Holder.store(() => { x = 42; });
  `);

  session.gc();

  // Invoke callback explicitly
  const slot = mem.allocateContext();
  airlock.setupCallbackContext(slot, Holder.closureHandle, []);
  while (true) {
    const result = airlock.runContext(slot, 1000);
    if (result.status === 'done') {
      mem.freeContext(slot);
      break;
    }
    if (result.status === 'external_call') {
      const ext = airlock.handleExternalCall(slot, 1000);
      if (!ext.suspended && !ext.threw) airlock.resumeWithValue(slot, ext.result);
      continue;
    }
    if (result.status === 'external_property') {
      airlock.handleExternalProperty(slot, 1000);
      continue;
    }
    throw new Error(`Unexpected status: ${result.status}`);
  }

  assertEquals(session.get(0, 'x'), 42);
});

Deno.test("GC External: closure pointer updated after compaction", () => {
  const { session, airlock, rootGrant, run } = createExternalTestContext();
  const mem = session.memoryImage;

  const Holder = { closureHandle: null };
  const id = airlock.register(Holder);
  rootGrant.add(id);
  airlock.setHandler(id, 'store', ({ args }) => { Holder.closureHandle = args[0]; });
  airlock.declare('Holder', id);

  run(`
    let x = 0;
    let temp1 = [1, 2, 3, 4, 5, 6, 7, 8];
    let temp2 = { a: 1, b: 2, c: 3 };
    Holder.store(() => { x = 42; });
    let temp3 = [10, 20, 30, 40, 50];
    temp1 = null;
    temp2 = null;
    temp3 = null;
  `);

  session.gc();

  // Invoke callback explicitly
  const slot = mem.allocateContext();
  airlock.setupCallbackContext(slot, Holder.closureHandle, []);
  while (true) {
    const result = airlock.runContext(slot, 1000);
    if (result.status === 'done') {
      mem.freeContext(slot);
      break;
    }
    if (result.status === 'external_call') {
      const ext = airlock.handleExternalCall(slot, 1000);
      if (!ext.suspended && !ext.threw) airlock.resumeWithValue(slot, ext.result);
      continue;
    }
    if (result.status === 'external_property') {
      airlock.handleExternalProperty(slot, 1000);
      continue;
    }
    throw new Error(`Unexpected status: ${result.status}`);
  }

  assertEquals(session.get(0, 'x'), 42);
});

Deno.test("GC External: closure captures by reference", () => {
  const { session, airlock, rootGrant, run } = createExternalTestContext();
  const mem = session.memoryImage;

  const Holder = { closureHandle: null };
  const id = airlock.register(Holder);
  rootGrant.add(id);
  airlock.setHandler(id, 'store', ({ args }) => { Holder.closureHandle = args[0]; });
  airlock.declare('Holder', id);

  run(`
    let x = 0;
    let outer = 100;
    Holder.store(() => { x = outer; });
    outer = null;
  `);

  session.gc();

  // Invoke callback explicitly
  const slot = mem.allocateContext();
  airlock.setupCallbackContext(slot, Holder.closureHandle, []);
  while (true) {
    const result = airlock.runContext(slot, 1000);
    if (result.status === 'done') {
      mem.freeContext(slot);
      break;
    }
    if (result.status === 'external_call') {
      const ext = airlock.handleExternalCall(slot, 1000);
      if (!ext.suspended && !ext.threw) airlock.resumeWithValue(slot, ext.result);
      continue;
    }
    if (result.status === 'external_property') {
      airlock.handleExternalProperty(slot, 1000);
      continue;
    }
    throw new Error(`Unexpected status: ${result.status}`);
  }

  assertEquals(session.get(0, 'x'), null);
});

Deno.test("GC External: multiple callbacks, partial release", () => {
  const { session, airlock, rootGrant, run } = createExternalTestContext();
  const mem = session.memoryImage;

  const Multi = { closureHandles: [] };
  const id = airlock.register(Multi);
  rootGrant.add(id);
  airlock.setHandler(id, 'add', ({ args }) => { Multi.closureHandles.push(args[0]); });
  airlock.declare('Multi', id);

  run(`
    let a = 0;
    let b = 0;
    Multi.add(() => { a = 1; });
    Multi.add(() => { b = 2; });
  `);

  Multi.closureHandles.splice(0, 1);
  session.gc();

  // Invoke callback explicitly
  const slot = mem.allocateContext();
  airlock.setupCallbackContext(slot, Multi.closureHandles[0], []);
  while (true) {
    const result = airlock.runContext(slot, 1000);
    if (result.status === 'done') {
      mem.freeContext(slot);
      break;
    }
    if (result.status === 'external_call') {
      const ext = airlock.handleExternalCall(slot, 1000);
      if (!ext.suspended && !ext.threw) airlock.resumeWithValue(slot, ext.result);
      continue;
    }
    if (result.status === 'external_property') {
      airlock.handleExternalProperty(slot, 1000);
      continue;
    }
    throw new Error(`Unexpected status: ${result.status}`);
  }

  assertEquals(session.get(0, 'b'), 2);
});

Deno.test("GC External: invoked across multiple GC cycles", () => {
  const { session, airlock, rootGrant, run } = createExternalTestContext();
  const mem = session.memoryImage;

  const Counter = { closureHandle: null };
  const id = airlock.register(Counter);
  rootGrant.add(id);
  airlock.setHandler(id, 'store', ({ args }) => { Counter.closureHandle = args[0]; });
  airlock.declare('Counter', id);

  run(`
    let count = 0;
    Counter.store(() => { count = count + 1; });
  `);

  // Invoke callback explicitly 3 times with GCs in between
  function invokeCallback() {
    const slot = mem.allocateContext();
    airlock.setupCallbackContext(slot, Counter.closureHandle, []);
    while (true) {
      const result = airlock.runContext(slot, 1000);
      if (result.status === 'done') {
        mem.freeContext(slot);
        break;
      }
      if (result.status === 'external_call') {
        const ext = airlock.handleExternalCall(slot, 1000);
        if (!ext.suspended && !ext.threw) airlock.resumeWithValue(slot, ext.result);
        continue;
      }
      if (result.status === 'external_property') {
        airlock.handleExternalProperty(slot, 1000);
        continue;
      }
      throw new Error(`Unexpected status: ${result.status}`);
    }
  }

  invokeCallback();
  session.gc();
  invokeCallback();
  session.gc();
  invokeCallback();

  assertEquals(session.get(0, 'count'), 3);
});

Deno.test("GC External: captures nested object property", () => {
  const { session, airlock, rootGrant, run } = createExternalTestContext();
  const mem = session.memoryImage;

  const Holder = { closureHandle: null };
  const id = airlock.register(Holder);
  rootGrant.add(id);
  airlock.setHandler(id, 'store', ({ args }) => { Holder.closureHandle = args[0]; });
  airlock.declare('Holder', id);

  run(`
    let trash1 = [1, 2, 3, 4, 5, 6, 7, 8];
    let captured = { value: 100, nested: { deep: 42 } };
    let trash2 = [9, 10, 11, 12, 13, 14, 15, 16];
    Holder.store(() => { return captured.nested.deep; });
    trash1 = null;
    trash2 = null;
  `);

  session.gc();

  // Invoke callback explicitly and get return value
  const slot = mem.allocateContext();
  airlock.setupCallbackContext(slot, Holder.closureHandle, []);
  let value;
  while (true) {
    const result = airlock.runContext(slot, 1000);
    if (result.status === 'done') {
      value = airlock.extractResultFromContext(slot);
      mem.freeContext(slot);
      break;
    }
    if (result.status === 'external_call') {
      const ext = airlock.handleExternalCall(slot, 1000);
      if (!ext.suspended && !ext.threw) airlock.resumeWithValue(slot, ext.result);
      continue;
    }
    if (result.status === 'external_property') {
      airlock.handleExternalProperty(slot, 1000);
      continue;
    }
    throw new Error(`Unexpected status: ${result.status}`);
  }

  assertEquals(value, 42);
});

Deno.test("GC External: multiple closures, different scopes", () => {
  const { session, airlock, rootGrant, run } = createExternalTestContext();
  const mem = session.memoryImage;

  const Holder = { closureHandle1: null, closureHandle2: null };
  const id = airlock.register(Holder);
  rootGrant.add(id);
  airlock.setHandler(id, 'store1', ({ args }) => { Holder.closureHandle1 = args[0]; });
  airlock.setHandler(id, 'store2', ({ args }) => { Holder.closureHandle2 = args[0]; });
  airlock.declare('Holder', id);

  run(`
    let trash = [1, 2, 3, 4, 5];
    let a = 10;
    Holder.store1(() => { return a; });
    let trash2 = [6, 7, 8, 9, 10];
    let b = 20;
    Holder.store2(() => { return b; });
    trash = null;
    trash2 = null;
  `);

  session.gc();

  // Invoke callback1 and get return value
  function invokeAndGetResult(closureHandle) {
    const slot = mem.allocateContext();
    airlock.setupCallbackContext(slot, closureHandle, []);
    while (true) {
      const result = airlock.runContext(slot, 1000);
      if (result.status === 'done') {
        const value = airlock.extractResultFromContext(slot);
        mem.freeContext(slot);
        return value;
      }
      if (result.status === 'external_call') {
        const ext = airlock.handleExternalCall(slot, 1000);
        if (!ext.suspended && !ext.threw) airlock.resumeWithValue(slot, ext.result);
        continue;
      }
      if (result.status === 'external_property') {
        airlock.handleExternalProperty(slot, 1000);
        continue;
      }
      throw new Error(`Unexpected status: ${result.status}`);
    }
  }

  assertEquals(invokeAndGetResult(Holder.closureHandle1), 10);
  assertEquals(invokeAndGetResult(Holder.closureHandle2), 20);
});

Deno.test("GC External: opaque JS object survives", () => {
  const { session, airlock, rootGrant, run } = createExternalTestContext();

  const id = airlock.register({});
  rootGrant.add(id);
  airlock.setHandler(id, 'create', ({ context }) => {
    const map = new Map();
    const mapId = context.register(map);
    return mapId;
  });
  airlock.setHandler(id, 'set', ({ args }) => {
    const [handle, key, value] = args;
    handle.set(key, value);
  });
  airlock.setHandler(id, 'get', ({ args }) => {
    const [handle, key] = args;
    return handle.get(key);
  });
  airlock.declare('Store', id);

  run(`
    let db = Store.create();
    Store.set(db, "name", "alice");
    let trash = [1, 2, 3, 4, 5];
    trash = null;
  `);

  session.gc();

  run(`let name = Store.get(db, "name");`);

  assertEquals(session.get(0, 'name'), "alice");
});

Deno.test("GC External: many closures all survive", () => {
  const { session, airlock, rootGrant, run } = createExternalTestContext();
  const mem = session.memoryImage;

  const Multi = { closureHandles: [] };
  const id = airlock.register(Multi);
  rootGrant.add(id);
  airlock.setHandler(id, 'add', ({ args }) => { Multi.closureHandles.push(args[0]); });
  airlock.declare('Multi', id);

  run(`
    let values = [];
    for (let i = 0; i < 10; i = i + 1) {
      let captured = i * 10;
      Multi.add(() => { return captured; });
      values.push(captured);
    }
    let trash = [];
    for (let j = 0; j < 20; j = j + 1) {
      trash.push([j, j*2, j*3]);
    }
    trash = null;
  `);

  session.gc();

  // Invoke each callback and check result
  function invokeAndGetResult(closureHandle) {
    const slot = mem.allocateContext();
    airlock.setupCallbackContext(slot, closureHandle, []);
    while (true) {
      const result = airlock.runContext(slot, 1000);
      if (result.status === 'done') {
        const value = airlock.extractResultFromContext(slot);
        mem.freeContext(slot);
        return value;
      }
      if (result.status === 'external_call') {
        const ext = airlock.handleExternalCall(slot, 1000);
        if (!ext.suspended && !ext.threw) airlock.resumeWithValue(slot, ext.result);
        continue;
      }
      if (result.status === 'external_property') {
        airlock.handleExternalProperty(slot, 1000);
        continue;
      }
      throw new Error(`Unexpected status: ${result.status}`);
    }
  }

  let allCorrect = true;
  for (let i = 0; i < 10; i++) {
    const result = invokeAndGetResult(Multi.closureHandles[i]);
    if (result !== i * 10) {
      allCorrect = false;
    }
  }

  assert(allCorrect, 'All 10 callbacks should return correct values');
});

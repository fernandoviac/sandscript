/**
 * Debug test for Uint8Array forEach crash.
 */

import { assertEquals, assert } from "https://deno.land/std@0.208.0/assert/mod.ts";
import { createSession } from '../../src/fuel/session.js';
import { freshSession } from '../../src/host-owned-session.js';

function runCode(code, debug = false) {
  const session = freshSession();
  if (debug) {
    session.memoryImage.debug = true;
  }
  session.parse(code);
  const runResult = session.run(0, 10000);
  if (runResult.status === 'error') {
    throw new Error(`Execution error: ${JSON.stringify(runResult.error)}`);
  }
  return { status: runResult.status, value: session.result(0) };
}

// Test 1: Most minimal case - single element, no outer variable
Deno.test("Debug: single element forEach, no outer var", () => {
  const result = runCode(`
    let arr = new Uint8Array(1);
    arr[0] = 42;
    let result = 0;
    arr.forEach((x) => { result = x; });
    result
  `);
  assertEquals(result.value, 42);
});

// Test 2: Two elements, callback does nothing with outer scope - with braces
Deno.test("Debug: two elements, callback with braces", () => {
  const session = freshSession();
  const mem = session.memoryImage;
  session.parse(`
    let arr = new Uint8Array(2);
    arr[0] = 1; arr[1] = 2;
    arr.forEach((x) => { 123; });
    "done"
  `);

  // Run step by step for debugging
  let totalFuel = 0;
  let result;
  for (let i = 0; i < 50; i++) {
    // Use proper accessors instead of hardcoded offsets
    const pc = mem.getContextInstructionIndex(0);
    const heapPtr = mem.getHeapPointer();
    const scopePtr = mem.getRootScope();
    const stackPtr = mem.getContextCallStackPointer(0);
    const pendingPtr = mem.getContextPendingPointer(0);
    const stackBase = mem.getCallStackBase(0);

    // Read frame info if stack has a frame (FRAME_SIZE = 56)
    let frameInfo = "";
    if (stackPtr > stackBase) {
      const frame = mem.getCurrentFrame(0);
      if (frame) {
        frameInfo = `, frame[flags=0x${frame.flags.toString(16)}]`;
      }
    }

    try {
      result = session.run(0, 1);
      totalFuel++;

      if (totalFuel >= 15) {  // Log to see callback execution
        console.log(`Fuel ${totalFuel}: PC=${pc}, heap=${heapPtr}, scope=${scopePtr}, stack=${stackPtr}, pending=${pendingPtr}${frameInfo}`);
      }
      if (result.status !== 'paused') {
        console.log(`Finished after ${totalFuel} steps, status=${result.status}`);
        break;
      }
    } catch (e) {
      console.log(`Crashed at fuel ${totalFuel + 1}, PC=${pc}, heap=${heapPtr}, scope=${scopePtr}, stack=${stackPtr}${frameInfo}:`, e.message);
      throw e;
    }
  }

  assertEquals(session.result(0), "done");
});

// Test 2b: Two elements, callback without braces (works)
Deno.test("Debug: two elements, callback without braces (works)", () => {
  const result = runCode(`
    let arr = new Uint8Array(2);
    arr[0] = 1; arr[1] = 2;
    arr.forEach((x) => x);
    "done"
  `);
  assertEquals(result.value, "done");
});

// Test 3: Two elements, callback returns expression (no assignment)
Deno.test("Debug: two elements, callback returns expression", () => {
  const result = runCode(`
    let arr = new Uint8Array(2);
    arr[0] = 1; arr[1] = 2;
    let last = 0;
    arr.forEach((x) => x);
    "done"
  `);
  assertEquals(result.value, "done");
});

// Test 4: Two elements, callback assigns to outer variable
Deno.test("Debug: two elements, callback assigns to outer var", () => {
  const result = runCode(`
    let arr = new Uint8Array(2);
    arr[0] = 1; arr[1] = 2;
    let last = 0;
    arr.forEach((x) => { last = x; });
    last
  `);
  assertEquals(result.value, 2);
});

// Test 5: Three elements, summing
Deno.test("Debug: three elements, summing", () => {
  const result = runCode(`
    let arr = new Uint8Array(3);
    arr[0] = 1; arr[1] = 2; arr[2] = 3;
    let sum = 0;
    arr.forEach((x) => { sum = sum + x; });
    sum
  `);
  assertEquals(result.value, 6);
});

// Test 6: Compare with regular Array (which works)
Deno.test("Debug: regular Array forEach works", () => {
  const result = runCode(`
    let arr = [1, 2, 3];
    let sum = 0;
    arr.forEach((x) => { sum = sum + x; });
    sum
  `);
  assertEquals(result.value, 6);
});

// Test 7: Regular Array with braces, no assignment - TRACE
Deno.test("Debug: regular Array forEach with braces works (trace)", () => {
  const session = freshSession();
  const mem = session.memoryImage;
  session.parse(`
    let arr = [1, 2];
    arr.forEach((x) => { x; });
    "done"
  `);

  // Run step by step
  let totalFuel = 0;
  let result;
  for (let i = 0; i < 50; i++) {
    const pc = mem.view.getUint32(mem.abs(0x54), true);
    const heapPtr = mem.view.getUint32(mem.abs(0x10), true);
    const scopePtr = mem.view.getUint32(mem.abs(0x18), true);
    const stackPtr = mem.view.getUint32(mem.abs(0x4C), true);
    try {
      result = session.run(0, 1);
      totalFuel++;
      if (totalFuel >= 8) {  // Log from callback onwards
        console.log(`Fuel ${totalFuel}: PC was ${pc}, heap=${heapPtr}, scope=${scopePtr}, stack=${stackPtr}`);
      }
      if (result.status !== 'paused') {
        console.log(`Finished at fuel ${totalFuel}, status=${result.status}`);
        break;
      }
    } catch (e) {
      console.log(`Crashed at fuel ${totalFuel + 1}, PC was ${pc}:`, e.message);
      throw e;
    }
  }

  assertEquals(session.result(0), "done");
});

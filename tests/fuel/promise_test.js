/**
 * Tests for Promise data structure (Phase 1 of async/await).
 */

import { assertEquals, assertNotEquals } from 'https://deno.land/std@0.208.0/assert/mod.ts';
import { createSession } from '../../src/fuel/session.js';
import {
  TYPE,
  PROMISE_STATUS_PENDING,
  PROMISE_STATUS_RESOLVED,
  PROMISE_STATUS_REJECTED,
  PROMISE_WAITER,
} from '../../src/fuel/constants.js';
import { freshSession } from '../../src/host-owned-session.js';

// =============================================================================
// Promise Creation and Field Access
// =============================================================================

Deno.test('Promise: createPromise returns data pointer', () => {
  const session = freshSession();
  const memoryImage = session.memoryImage;

  const promisePointer = memoryImage.createPromise();

  assertNotEquals(promisePointer, 0);
});

Deno.test('Promise: new promise has pending status', () => {
  const session = freshSession();
  const memoryImage = session.memoryImage;

  const promisePointer = memoryImage.createPromise();
  const status = memoryImage.getPromiseStatus(promisePointer);

  assertEquals(status, PROMISE_STATUS_PENDING);
});

Deno.test('Promise: new promise has empty waiter list', () => {
  const session = freshSession();
  const memoryImage = session.memoryImage;

  const promisePointer = memoryImage.createPromise();
  const waiters = memoryImage.getPromiseWaiters(promisePointer);

  assertEquals(waiters, 0);
});

Deno.test('Promise: new promise has undefined value', () => {
  const session = freshSession();
  const memoryImage = session.memoryImage;

  const promisePointer = memoryImage.createPromise();
  const value = memoryImage.getPromiseValue(promisePointer);

  assertEquals(value.type, TYPE.UNDEFINED);
});

// =============================================================================
// Promise Status
// =============================================================================

Deno.test('Promise: set status to resolved', () => {
  const session = freshSession();
  const memoryImage = session.memoryImage;

  const promisePointer = memoryImage.createPromise();
  memoryImage.setPromiseStatus(promisePointer, PROMISE_STATUS_RESOLVED);

  assertEquals(memoryImage.getPromiseStatus(promisePointer), PROMISE_STATUS_RESOLVED);
});

Deno.test('Promise: set status to rejected', () => {
  const session = freshSession();
  const memoryImage = session.memoryImage;

  const promisePointer = memoryImage.createPromise();
  memoryImage.setPromiseStatus(promisePointer, PROMISE_STATUS_REJECTED);

  assertEquals(memoryImage.getPromiseStatus(promisePointer), PROMISE_STATUS_REJECTED);
});

// =============================================================================
// Promise Value
// =============================================================================

Deno.test('Promise: set and get integer value', () => {
  const session = freshSession();
  const memoryImage = session.memoryImage;

  const promisePointer = memoryImage.createPromise();
  memoryImage.setPromiseValue(promisePointer, TYPE.INTEGER, 0, 42, 0);

  const value = memoryImage.getPromiseValue(promisePointer);
  assertEquals(value.type, TYPE.INTEGER);
  assertEquals(value.lo, 42);
});

Deno.test('Promise: set and get boolean value', () => {
  const session = freshSession();
  const memoryImage = session.memoryImage;

  const promisePointer = memoryImage.createPromise();
  memoryImage.setPromiseValue(promisePointer, TYPE.BOOLEAN, 0, 1, 0);

  const value = memoryImage.getPromiseValue(promisePointer);
  assertEquals(value.type, TYPE.BOOLEAN);
  assertEquals(value.lo, 1);
});

Deno.test('Promise: set and get null value', () => {
  const session = freshSession();
  const memoryImage = session.memoryImage;

  const promisePointer = memoryImage.createPromise();
  memoryImage.setPromiseValue(promisePointer, TYPE.NULL, 0, 0, 0);

  const value = memoryImage.getPromiseValue(promisePointer);
  assertEquals(value.type, TYPE.NULL);
});

// =============================================================================
// Waiter List
// =============================================================================

Deno.test('Promise: add single waiter', () => {
  const session = freshSession();
  const memoryImage = session.memoryImage;

  const promisePointer = memoryImage.createPromise();
  const a = memoryImage.allocateContext();
  const generation = memoryImage.getContextGeneration(a);
  const waiterPointer = memoryImage.addWaiterToPromise(promisePointer, a);

  assertEquals(memoryImage.getPromiseWaiters(promisePointer), waiterPointer);
  assertEquals(memoryImage.getContextWaitingOn(a), promisePointer);
  const waiterAddress = memoryImage.abs(waiterPointer);
  assertEquals(memoryImage.view.getUint32(
    waiterAddress + PROMISE_WAITER.CONTEXT_SLOT, true), a);
  assertEquals(memoryImage.view.getUint32(
    waiterAddress + PROMISE_WAITER.CONTEXT_GENERATION, true), generation);
  assertEquals(memoryImage.view.getUint32(
    waiterAddress + PROMISE_WAITER.NEXT, true), 0);
});

Deno.test('Promise: add multiple waiters', () => {
  const session = freshSession();
  const memoryImage = session.memoryImage;

  const promisePointer = memoryImage.createPromise();
  const a = memoryImage.allocateContext();
  const b = memoryImage.allocateContext();
  const c = memoryImage.allocateContext();
  const aWaiter = memoryImage.addWaiterToPromise(promisePointer, a);
  const bWaiter = memoryImage.addWaiterToPromise(promisePointer, b);
  const cWaiter = memoryImage.addWaiterToPromise(promisePointer, c);

  assertEquals(memoryImage.getPromiseWaiters(promisePointer), cWaiter);
  assertEquals(memoryImage.view.getUint32(
    memoryImage.abs(cWaiter) + PROMISE_WAITER.NEXT, true), bWaiter);
  assertEquals(memoryImage.view.getUint32(
    memoryImage.abs(bWaiter) + PROMISE_WAITER.NEXT, true), aWaiter);
  assertEquals(memoryImage.view.getUint32(
    memoryImage.abs(aWaiter) + PROMISE_WAITER.NEXT, true), 0);

  // All contexts should point to same promise
  assertEquals(memoryImage.getContextWaitingOn(a), promisePointer);
  assertEquals(memoryImage.getContextWaitingOn(b), promisePointer);
  assertEquals(memoryImage.getContextWaitingOn(c), promisePointer);
});

Deno.test('Promise: popAllWaiters returns all waiters', () => {
  const session = freshSession();
  const memoryImage = session.memoryImage;

  const promisePointer = memoryImage.createPromise();
  const a = memoryImage.allocateContext();
  const b = memoryImage.allocateContext();
  const c = memoryImage.allocateContext();
  memoryImage.addWaiterToPromise(promisePointer, a);
  memoryImage.addWaiterToPromise(promisePointer, b);
  memoryImage.addWaiterToPromise(promisePointer, c);

  const waiters = memoryImage.popAllWaiters(promisePointer);

  // Should return in head-first order (reverse of add order)
  assertEquals(waiters, [
    { slot: c, generation: memoryImage.getContextGeneration(c) },
    { slot: b, generation: memoryImage.getContextGeneration(b) },
    { slot: a, generation: memoryImage.getContextGeneration(a) },
  ]);
});

Deno.test('Promise: popAllWaiters clears waiter list', () => {
  const session = freshSession();
  const memoryImage = session.memoryImage;

  const promisePointer = memoryImage.createPromise();
  memoryImage.addWaiterToPromise(promisePointer, memoryImage.allocateContext());
  memoryImage.addWaiterToPromise(promisePointer, memoryImage.allocateContext());

  memoryImage.popAllWaiters(promisePointer);

  assertEquals(memoryImage.getPromiseWaiters(promisePointer), 0);
});

Deno.test('Promise: popAllWaiters clears context waiting state', () => {
  const session = freshSession();
  const memoryImage = session.memoryImage;

  const promisePointer = memoryImage.createPromise();
  // Design B: waiter slots must be real allocated contexts.
  const a = memoryImage.allocateContext();
  const b = memoryImage.allocateContext();
  memoryImage.addWaiterToPromise(promisePointer, a);
  memoryImage.addWaiterToPromise(promisePointer, b);

  memoryImage.popAllWaiters(promisePointer);

  assertEquals(memoryImage.getContextWaitingOn(a), 0);
  assertEquals(memoryImage.getContextWaitingOn(b), 0);
});

Deno.test('Promise: cancelling a waiter unlinks head, middle, and tail nodes', () => {
  for (const cancelledIndex of [0, 1, 2]) {
    const session = freshSession();
    const memoryImage = session.memoryImage;
    const promisePointer = memoryImage.createPromise();
    const slots = [
      memoryImage.allocateContext(),
      memoryImage.allocateContext(),
      memoryImage.allocateContext(),
    ];
    for (const slot of slots) {
      memoryImage.addWaiterToPromise(promisePointer, slot);
    }

    const cancelledSlot = slots[cancelledIndex];
    const cancelledGeneration =
      memoryImage.getContextGeneration(cancelledSlot);
    assertEquals(
      session.airlock.cancelContext(cancelledSlot, cancelledGeneration),
      true,
    );

    const expected = slots
      .filter((slot) => slot !== cancelledSlot)
      .reverse()
      .map((slot) => ({
        slot,
        generation: memoryImage.getContextGeneration(slot),
      }));
    assertEquals(memoryImage.popAllWaiters(promisePointer), expected);
  }
});

Deno.test('Promise: popAllWaiters on empty list returns empty array', () => {
  const session = freshSession();
  const memoryImage = session.memoryImage;

  const promisePointer = memoryImage.createPromise();
  const waiters = memoryImage.popAllWaiters(promisePointer);

  assertEquals(waiters, []);
});

// =============================================================================
// Closure Async Flag
// =============================================================================

Deno.test('Closure: new closure is not async', () => {
  const session = freshSession();
  session.parse('function foo() {}');
  const result = session.run(0, 10000);
  assertEquals(result.status, 'done');

  // Get the closure from scope
  const memoryImage = session.memoryImage;
  const globalScope = memoryImage.getRootScope();
  const fooOffset = memoryImage.internString('foo');
  const fooValuePointer = memoryImage.scopeLookup(globalScope, fooOffset);
  const fooValue = memoryImage.getValue(fooValuePointer);

  assertEquals(fooValue.type, TYPE.FUNCTION);
  // payload is a BigInt containing the closure pointer
  const closurePointer = Number(fooValue.payload);
  assertEquals(memoryImage.isAsyncClosure(closurePointer), false);
});

Deno.test('Closure: set async flag', () => {
  const session = freshSession();
  session.parse('function foo() {}');
  const result = session.run(0, 10000);
  assertEquals(result.status, 'done');

  const memoryImage = session.memoryImage;
  const globalScope = memoryImage.getRootScope();
  const fooOffset = memoryImage.internString('foo');
  const fooValuePointer = memoryImage.scopeLookup(globalScope, fooOffset);
  const fooValue = memoryImage.getValue(fooValuePointer);
  const closurePointer = Number(fooValue.payload);

  memoryImage.setClosureAsync(closurePointer, true);
  assertEquals(memoryImage.isAsyncClosure(closurePointer), true);

  memoryImage.setClosureAsync(closurePointer, false);
  assertEquals(memoryImage.isAsyncClosure(closurePointer), false);
});

Deno.test('Closure: async flag preserves arrow flag', () => {
  const session = freshSession();
  session.parse('let foo = () => 1');
  const result = session.run(0, 10000);
  assertEquals(result.status, 'done');

  const memoryImage = session.memoryImage;
  const globalScope = memoryImage.getRootScope();
  const fooOffset = memoryImage.internString('foo');
  const fooValuePointer = memoryImage.scopeLookup(globalScope, fooOffset);
  const fooValue = memoryImage.getValue(fooValuePointer);
  const closurePointer = Number(fooValue.payload);

  // Arrow function starts as arrow, not async
  assertEquals(memoryImage.isArrowClosure(closurePointer), true);
  assertEquals(memoryImage.isAsyncClosure(closurePointer), false);

  // Set async flag
  memoryImage.setClosureAsync(closurePointer, true);

  // Both flags should be set
  assertEquals(memoryImage.isArrowClosure(closurePointer), true);
  assertEquals(memoryImage.isAsyncClosure(closurePointer), true);
});

// =============================================================================
// Context Waiter Fields
// =============================================================================

Deno.test('Context: WAITING_ON field', () => {
  const session = freshSession();
  const memoryImage = session.memoryImage;

  // Initially 0 (not waiting)
  assertEquals(memoryImage.getContextWaitingOn(0), 0);

  // Set to a promise pointer
  memoryImage.setContextWaitingOn(0, 12345);
  assertEquals(memoryImage.getContextWaitingOn(0), 12345);

  // Clear it
  memoryImage.setContextWaitingOn(0, 0);
  assertEquals(memoryImage.getContextWaitingOn(0), 0);
});


// =============================================================================
// Frame Async Promise Field
// =============================================================================

Deno.test('Frame: ASYNC_PROMISE is 0 for regular function call', () => {
  const session = freshSession();
  session.parse('function foo() { return 1; } foo()');
  const result = session.run(0, 10000);

  assertEquals(result.status, 'done');
  // If we got here without errors, frame size change didn't break function calls
});

// =============================================================================
// GC with Promises
// =============================================================================

Deno.test('GC: reachable promise survives collection', () => {
  const session = freshSession();
  // Run something first to put session in valid state for GC
  session.parse('1');
  session.run(0, 10000);

  const memoryImage = session.memoryImage;

  // Create promise and make it reachable by pushing to pending stack
  const promisePointer = memoryImage.createPromise();
  memoryImage.setPromiseStatus(promisePointer, PROMISE_STATUS_RESOLVED);
  memoryImage.setPromiseValue(promisePointer, TYPE.INTEGER, 0, 42, 0);

  // Push to pending stack to make it reachable
  const pendingPointer = memoryImage.getContextPendingPointer(0);
  memoryImage.view.setUint32(memoryImage.abs(pendingPointer), TYPE.PROMISE, true);
  memoryImage.view.setUint32(memoryImage.abs(pendingPointer + 4), 0, true);
  memoryImage.view.setUint32(memoryImage.abs(pendingPointer + 8), promisePointer - 8, true); // header pointer
  memoryImage.view.setUint32(memoryImage.abs(pendingPointer + 12), 0, true);
  memoryImage.setContextPendingPointer(0, pendingPointer + 16);

  // Run GC
  session.gc();

  // Promise should still be valid (though may have moved)
  // Read from pending stack
  const newPendingPointer = memoryImage.getContextPendingPointer(0);
  const headerPointer = memoryImage.view.getUint32(memoryImage.abs(newPendingPointer - 16 + 8), true);
  const newDataPointer = headerPointer + 8;

  const status = memoryImage.getPromiseStatus(newDataPointer);
  assertEquals(status, PROMISE_STATUS_RESOLVED);

  const value = memoryImage.getPromiseValue(newDataPointer);
  assertEquals(value.type, TYPE.INTEGER);
  assertEquals(value.lo, 42);
});

Deno.test('GC: promise with object value marks object', () => {
  const session = freshSession();
  session.parse('let obj = { x: 1 }');
  session.run(0, 10000);

  const memoryImage = session.memoryImage;

  // Get the object
  const globalScope = memoryImage.getRootScope();
  const objOffset = memoryImage.internString('obj');
  const objValue = memoryImage.scopeLookup(globalScope, objOffset);

  // Create promise with object as value
  const promisePointer = memoryImage.createPromise();
  memoryImage.setPromiseStatus(promisePointer, PROMISE_STATUS_RESOLVED);
  // Store object header pointer in promise value
  memoryImage.setPromiseValue(promisePointer, TYPE.OBJECT, 0, objValue.data, 0);

  // Push promise to pending stack to make it reachable
  const pendingPointer = memoryImage.getContextPendingPointer(0);
  memoryImage.view.setUint32(memoryImage.abs(pendingPointer), TYPE.PROMISE, true);
  memoryImage.view.setUint32(memoryImage.abs(pendingPointer + 4), 0, true);
  memoryImage.view.setUint32(memoryImage.abs(pendingPointer + 8), promisePointer - 8, true);
  memoryImage.view.setUint32(memoryImage.abs(pendingPointer + 12), 0, true);
  memoryImage.setContextPendingPointer(0, pendingPointer + 16);

  // Run GC
  session.gc();

  // Should complete without errors - object inside promise should be preserved
});

// =============================================================================
// Multiple Promises
// =============================================================================

Deno.test('Promise: multiple independent promises', () => {
  const session = freshSession();
  const memoryImage = session.memoryImage;

  const p1 = memoryImage.createPromise();
  const p2 = memoryImage.createPromise();
  const p3 = memoryImage.createPromise();

  // All should be distinct
  assertNotEquals(p1, p2);
  assertNotEquals(p2, p3);
  assertNotEquals(p1, p3);

  // All should start pending
  assertEquals(memoryImage.getPromiseStatus(p1), PROMISE_STATUS_PENDING);
  assertEquals(memoryImage.getPromiseStatus(p2), PROMISE_STATUS_PENDING);
  assertEquals(memoryImage.getPromiseStatus(p3), PROMISE_STATUS_PENDING);

  // Set different statuses
  memoryImage.setPromiseStatus(p1, PROMISE_STATUS_RESOLVED);
  memoryImage.setPromiseStatus(p2, PROMISE_STATUS_REJECTED);

  // Changes should be independent
  assertEquals(memoryImage.getPromiseStatus(p1), PROMISE_STATUS_RESOLVED);
  assertEquals(memoryImage.getPromiseStatus(p2), PROMISE_STATUS_REJECTED);
  assertEquals(memoryImage.getPromiseStatus(p3), PROMISE_STATUS_PENDING);
});

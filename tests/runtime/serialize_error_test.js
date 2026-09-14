/**
 * Unit tests for src/runtime/serialize-error.js —
 * serializeThrownError() and its caps.
 *
 * Run with: deno task test tests/runtime/serialize_error_test.js
 */

import { assertEquals, assert } from "https://deno.land/std@0.208.0/assert/mod.ts";
import {
  serializeThrownError,
  ERROR_SERIALIZATION_LIMITS,
} from '../../src/runtime/serialize-error.js';

// =============================================================================
// Non-object throws
// =============================================================================

Deno.test("non-object: string throw", () => {
  const out = serializeThrownError('boom');
  assertEquals(out.name, null);
  assertEquals(out.message, 'boom');
  assertEquals(out.stack, null);
  assertEquals(out.cause, null);
  assertEquals(out.ownProperties, null);
  assertEquals(out.constructorChain, null);
  assertEquals(out.thrownType, 'string');
});

Deno.test("non-object: number throw", () => {
  const out = serializeThrownError(42);
  assertEquals(out.message, '42');
  assertEquals(out.thrownType, 'number');
});

Deno.test("non-object: undefined throw distinguishes from null", () => {
  const u = serializeThrownError(undefined);
  assertEquals(u.message, 'undefined');
  assertEquals(u.thrownType, 'undefined');
  const n = serializeThrownError(null);
  assertEquals(n.message, 'null');
  assertEquals(n.thrownType, 'object');
  // null is the only object whose thrownType lands as 'object' in
  // the non-object branch — it's handled by the typeof !== 'object'
  // check on null specifically.
});

Deno.test("non-object: bigint throw", () => {
  const out = serializeThrownError(123n);
  assertEquals(out.message, '123');
  assertEquals(out.thrownType, 'bigint');
});

// =============================================================================
// Plain Error
// =============================================================================

Deno.test("Error: name, message, stack captured", () => {
  const err = new Error('something broke');
  const out = serializeThrownError(err);
  assertEquals(out.name, 'Error');
  assertEquals(out.message, 'something broke');
  assert(typeof out.stack === 'string');
  assert(out.stack.includes('something broke'));
  assertEquals(out.thrownType, 'object');
});

Deno.test("Error: constructorChain captures hierarchy", () => {
  class MyErr extends TypeError {}
  const out = serializeThrownError(new MyErr('x'));
  assert(out.constructorChain.includes('MyErr'));
  assert(out.constructorChain.includes('TypeError'));
  assert(out.constructorChain.includes('Error'));
});

Deno.test("Error: own enumerable properties captured, dedicated fields dropped", () => {
  const err = new Error('msg');
  err.code = 'E_FOO';
  err.requestId = 'abc-123';
  const out = serializeThrownError(err);
  assertEquals(out.ownProperties.code, 'E_FOO');
  assertEquals(out.ownProperties.requestId, 'abc-123');
  // name/message/stack/cause must not appear in ownProperties even
  // if they happen to be enumerable.
  assertEquals(out.ownProperties.name, undefined);
  assertEquals(out.ownProperties.message, undefined);
  assertEquals(out.ownProperties.stack, undefined);
  assertEquals(out.ownProperties.cause, undefined);
});

Deno.test("Error: function and symbol props elided by typeof", () => {
  const err = new Error('msg');
  err.handler = () => {};
  err.tag = Symbol('x');
  const out = serializeThrownError(err);
  assertEquals(out.ownProperties.handler.__elided, 'function');
  assertEquals(out.ownProperties.tag.__elided, 'symbol');
});

// =============================================================================
// Cause chain
// =============================================================================

Deno.test("cause: shallow chain walked fully", () => {
  const root = new Error('root');
  const mid = new Error('mid', { cause: root });
  const top = new Error('top', { cause: mid });
  const out = serializeThrownError(top);
  assertEquals(out.message, 'top');
  assertEquals(out.cause.message, 'mid');
  assertEquals(out.cause.cause.message, 'root');
  assertEquals(out.cause.cause.cause, null);
});

Deno.test("cause: depth cap inserts truncated marker", () => {
  // Build a deep chain.
  let cur = new Error('layer-0');
  for (let i = 1; i < 25; i++) {
    cur = new Error(`layer-${i}`, { cause: cur });
  }
  const out = serializeThrownError(cur, { causeDepth: 3 });
  // depth=0 (layer-24), 1 (layer-23), 2 (layer-22) — at depth+1=3
  // we should hit the truncated marker.
  assertEquals(out.message, 'layer-24');
  assertEquals(out.cause.message, 'layer-23');
  assertEquals(out.cause.cause.message, 'layer-22');
  assertEquals(out.cause.cause.cause.truncated, true);
  assertEquals(out.cause.cause.cause.atDepth, 3);
});

Deno.test("cause: cycle detected and marked", () => {
  const a = new Error('a');
  const b = new Error('b', { cause: a });
  a.cause = b; // cycle
  const out = serializeThrownError(a);
  // a → b → cycle-ref back to a
  assertEquals(out.message, 'a');
  assertEquals(out.cause.message, 'b');
  assertEquals(out.cause.cause.cycle, true);
  assertEquals(out.cause.cause.ref, 0);
});

// =============================================================================
// Stack frame cap
// =============================================================================

Deno.test("stack: cap inserts truncation marker", () => {
  // Build a fake stack with many frames.
  const err = new Error('x');
  const frames = [];
  for (let i = 0; i < 50; i++) frames.push(`    at fakeFn${i} (/path:${i}:1)`);
  err.stack = `Error: x\n${frames.join('\n')}`;
  const out = serializeThrownError(err, { stackFramesPerLayer: 10 });
  assert(out.stack.includes('40 more frames truncated'));
  assert(out.stack.includes('at fakeFn0 '));
  assert(out.stack.includes('at fakeFn9 '));
  assert(!out.stack.includes('at fakeFn10 '));
});

Deno.test("stack: short stack returned unchanged", () => {
  const err = new Error('x');
  err.stack = 'Error: x\n    at A\n    at B';
  const out = serializeThrownError(err, { stackFramesPerLayer: 10 });
  assertEquals(out.stack, 'Error: x\n    at A\n    at B');
});

// =============================================================================
// Property byte cap
// =============================================================================

Deno.test("ownProps: default null cap accepts large values", () => {
  const err = new Error('x');
  err.bigStr = 'a'.repeat(10_000);
  const out = serializeThrownError(err);
  assertEquals(out.ownProperties.bigStr.length, 10_000);
});

Deno.test("ownProps: explicit cap elides oversized values", () => {
  const err = new Error('x');
  err.bigStr = 'a'.repeat(10_000);
  const out = serializeThrownError(err, { ownPropBytes: 100 });
  assertEquals(out.ownProperties.bigStr.__elided, 'string');
  assert(typeof out.ownProperties.bigStr.__bytes === 'number');
  assert(out.ownProperties.bigStr.__bytes > 100);
});

// =============================================================================
// msgpack-friendly survivors
// =============================================================================

Deno.test("ownProps: BigInt survives (msgpack-friendly)", () => {
  const err = new Error('x');
  err.big = 9_999_999_999_999_999n;
  const out = serializeThrownError(err);
  assertEquals(out.ownProperties.big, 9_999_999_999_999_999n);
});

Deno.test("ownProps: Uint8Array survives (msgpack-friendly)", () => {
  const err = new Error('x');
  err.bytes = new Uint8Array([1, 2, 3]);
  const out = serializeThrownError(err);
  assert(out.ownProperties.bytes instanceof Uint8Array);
  assertEquals(Array.from(out.ownProperties.bytes), [1, 2, 3]);
});

Deno.test("ownProps: nested plain object passes through", () => {
  const err = new Error('x');
  err.details = { kind: 'foo', count: 7 };
  const out = serializeThrownError(err);
  assertEquals(out.ownProperties.details.kind, 'foo');
  assertEquals(out.ownProperties.details.count, 7);
});

// =============================================================================
// Robustness
// =============================================================================

Deno.test("robust: getter that throws is elided", () => {
  const err = new Error('x');
  Object.defineProperty(err, 'bad', {
    enumerable: true,
    get() { throw new Error('getter blew up'); },
  });
  const out = serializeThrownError(err);
  assertEquals(out.ownProperties.bad.__elided, 'getter-threw');
});

Deno.test("robust: plain object thrown (not Error) handled", () => {
  const thrown = { code: 'X', detail: 'y' };
  const out = serializeThrownError(thrown);
  assertEquals(out.name, null);
  assertEquals(out.message, null);
  assertEquals(out.ownProperties.code, 'X');
  assertEquals(out.ownProperties.detail, 'y');
  assertEquals(out.thrownType, 'object');
});

Deno.test("robust: Object.create(null) handled (no constructor)", () => {
  const thrown = Object.create(null);
  thrown.x = 1;
  const out = serializeThrownError(thrown);
  assertEquals(out.constructorChain, null);
  assertEquals(out.ownProperties.x, 1);
});

// =============================================================================
// Limits export
// =============================================================================

Deno.test("limits: ERROR_SERIALIZATION_LIMITS is frozen", () => {
  assert(Object.isFrozen(ERROR_SERIALIZATION_LIMITS));
  assertEquals(ERROR_SERIALIZATION_LIMITS.CAUSE_DEPTH, 16);
  assertEquals(ERROR_SERIALIZATION_LIMITS.STACK_FRAMES_PER_LAYER, 256);
  assertEquals(ERROR_SERIALIZATION_LIMITS.OWN_PROP_BYTES, null);
});

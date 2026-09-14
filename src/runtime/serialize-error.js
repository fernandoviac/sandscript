/**
 * serializeThrownError — convert any thrown value into a plain
 * msgpack-friendly object capturing name, message, stack,
 * Error.cause chain, constructorChain, and own enumerable
 * properties.
 *
 * Used by the runtime to build the `error` section of
 * `runtimeHalf` passed to a `composeErrorEnvelope` callback.
 * Also exported as a runtime-layer utility for embedders that
 * want the same normalization in other error paths.
 *
 * Design rules:
 *   - Synchronous; no awaits, no microtask hops.
 *   - Never throws. Each accessor that could fail is wrapped
 *     in a try/catch and falls back to null. The whole walk
 *     must be safe to run inside a scheduler catch site.
 *   - msgpack-friendly output. BigInt and Uint8Array survive;
 *     every other non-plain value is elided.
 */

import { encode as encodeMsgpack } from '../membrane/msgpack.js';

export const ERROR_SERIALIZATION_LIMITS = Object.freeze({
  CAUSE_DEPTH:            16,
  STACK_FRAMES_PER_LAYER: 256,
  // null = no per-property byte cap. Embedders that need a cap
  // can pass one via opts.ownPropBytes.
  OWN_PROP_BYTES:         null,
});

/**
 * Serialize a thrown value into a plain msgpack-friendly object.
 *
 * @param {unknown} thrown - The raw thrown value (Error, primitive,
 *   plain object, anything).
 * @param {Object} [opts]
 * @param {number} [opts.causeDepth] - Max Error.cause chain depth.
 * @param {number} [opts.stackFramesPerLayer] - Max stack frames per
 *   layer (cause-chain frames count separately).
 * @param {number|null} [opts.ownPropBytes] - Per-property msgpack
 *   byte cap; null/undefined for no cap.
 * @returns {Object} Plain object with name, message, stack, cause,
 *   ownProperties, constructorChain, thrownType.
 */
export function serializeThrownError(thrown, opts = {}) {
  const causeDepth = opts.causeDepth ?? ERROR_SERIALIZATION_LIMITS.CAUSE_DEPTH;
  const stackFrames = opts.stackFramesPerLayer
    ?? ERROR_SERIALIZATION_LIMITS.STACK_FRAMES_PER_LAYER;
  const propBytes = opts.ownPropBytes ?? ERROR_SERIALIZATION_LIMITS.OWN_PROP_BYTES;
  const seen = new Map();
  return walkErrorOnce(thrown, 0, causeDepth, stackFrames, propBytes, seen);
}

function walkErrorOnce(thrown, depth, causeDepth, stackFrames, propBytes, seen) {
  // Non-object throws (string, number, undefined, null, etc.) get
  // a minimal record. `String(thrown)` for the message; everything
  // else null. Distinguishes "handler threw 42" from a real Error.
  if (thrown === null || typeof thrown !== 'object') {
    return {
      name: null,
      message: thrown === undefined ? 'undefined' : safeString(thrown),
      stack: null,
      cause: null,
      ownProperties: null,
      constructorChain: null,
      thrownType: typeof thrown,
    };
  }

  // Cycle detection. If we've seen this exact object earlier in
  // this walk, emit a cycle marker pointing back to where.
  if (seen.has(thrown)) {
    return { cycle: true, ref: seen.get(thrown) };
  }
  seen.set(thrown, depth);

  const name = typeof thrown.name === 'string' ? thrown.name : null;
  const message = typeof thrown.message === 'string'
    ? thrown.message
    : (thrown.message !== undefined ? safeString(thrown.message) : null);
  const stack = serializeStack(thrown.stack, stackFrames);
  const constructorChain = collectConstructorChain(thrown);
  const ownProperties = serializeOwnProperties(thrown, propBytes);
  let cause = null;
  if (depth + 1 < causeDepth && thrown.cause !== undefined) {
    cause = walkErrorOnce(
      thrown.cause, depth + 1, causeDepth, stackFrames, propBytes, seen);
  } else if (thrown.cause !== undefined) {
    cause = { truncated: true, atDepth: depth + 1 };
  }
  return {
    name,
    message,
    stack,
    cause,
    ownProperties,
    constructorChain,
    thrownType: 'object',
  };
}

function serializeStack(rawStack, framesCap) {
  if (typeof rawStack !== 'string') return null;
  const lines = rawStack.split('\n');
  if (lines.length <= framesCap + 1) return rawStack;
  const truncated = lines.slice(0, framesCap + 1);
  truncated.push(
    `    ... (${lines.length - framesCap - 1} more frames truncated)`);
  return truncated.join('\n');
}

function collectConstructorChain(obj) {
  const chain = [];
  let proto;
  try { proto = Object.getPrototypeOf(obj); }
  catch (_e) { return null; }
  // Cap walk at 16 — protects against pathological proto chains.
  for (let i = 0; i < 16 && proto && proto.constructor; i++) {
    const ctorName = proto.constructor.name;
    if (typeof ctorName === 'string' && ctorName !== '') {
      chain.push(ctorName);
    }
    if (proto.constructor === Object) break;
    try { proto = Object.getPrototypeOf(proto); }
    catch (_e) { break; }
  }
  return chain.length > 0 ? chain : null;
}

function serializeOwnProperties(obj, propBytes) {
  let keys;
  try { keys = Object.keys(obj); }
  catch (_e) { return null; }
  const out = {};
  let any = false;
  for (const key of keys) {
    // Skip fields that already ride in dedicated envelope slots.
    if (key === 'name' || key === 'message' || key === 'stack'
        || key === 'cause') continue;
    let value;
    try { value = obj[key]; }
    catch (_e) { value = { __elided: 'getter-threw' }; }
    out[key] = serializeOwnPropValue(value, propBytes);
    any = true;
  }
  return any ? out : null;
}

function serializeOwnPropValue(value, propBytes) {
  if (typeof value === 'function' || typeof value === 'symbol') {
    return { __elided: typeof value };
  }
  if (propBytes === null || propBytes === undefined) {
    // No size cap — just confirm encodability so a non-marshallable
    // value (e.g. host object) is elided rather than blowing up the
    // composer's encode call later.
    try { encodeMsgpack(value); }
    catch (_err) {
      const ctor = value?.constructor?.name;
      return { __elided: ctor ?? typeof value };
    }
    return value;
  }
  let bytes;
  try {
    bytes = encodeMsgpack(value);
  } catch (_err) {
    const ctor = value?.constructor?.name;
    return { __elided: ctor ?? typeof value };
  }
  if (bytes.byteLength > propBytes) {
    return {
      __elided: describeKind(value),
      __bytes: bytes.byteLength,
    };
  }
  return value;
}

function describeKind(value) {
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'Array';
  if (value instanceof Uint8Array) return 'Uint8Array';
  if (typeof value === 'bigint') return 'bigint';
  if (typeof value === 'string') return 'string';
  return value?.constructor?.name ?? typeof value;
}

function safeString(v) {
  try { return String(v); } catch (_err) { return '<unstringifiable>'; }
}

/**
 * Runtime error classes. Defined in one place so callers can
 * `instanceof`-check across modules without an import cycle.
 *
 * Validation errors throw synchronously from `Runtime.start()`.
 * Per-slot handler errors flow through `onHandlerError`.
 */

import { VAT_FAULT_ERROR_CODES, errorCodeToString } from '../fuel/constants.js';

/**
 * Vat-fault classification — the shared predicate for distinguishing
 * fatal execution-substrate faults from recoverable guest-script failures.
 * Two kinds of failure reach an embedder from a drive, and they demand opposite
 * policies:
 *
 *   - A SCRIPT ERROR (uncaught throw, TypeError, out-of-memory
 *     refusal, unhandled rejection): the guest program misbehaved,
 *     but the vat's integrity is intact. JS parity applies — e.g.
 *     an interval whose callback throws keeps firing.
 *
 *   - A VAT FAULT (unknown opcode, corrupt operand, heap/code
 *     collision, strict stack underflow, a raw WASM trap, a poisoned
 *     collection): the execution substrate itself is broken.
 *     Re-driving is meaningless at best and destructive at worst —
 *     the embedder should stop firing into the vat and escalate
 *     (cancel the interval, terminate or recycle the worker, restore
 *     from persistence).
 *
 * Interpreter-raised fault codes are NOT catchable by guest
 * try/catch/finally (the WAT's $fault_error bypasses the throw
 * machinery), so they always arrive here with their true code —
 * guest code cannot swallow or relabel them.
 *
 * Accepts every error form the drive path produces or forwards:
 * UncaughtScriptError / ScriptError (`.scriptError.{code,codeName}`),
 * a bare translated error (`.codeName`/`.code`), a raw WASM trap
 * (WebAssembly.RuntimeError), a FatalCollectionError
 * (`.fatalCollection`), and a wire-serialized error that carries a
 * pre-computed `vatFault: true` flag.
 */
export const VAT_FAULT_ERROR_CODE_NAMES = Object.freeze(
  new Set(VAT_FAULT_ERROR_CODES.map(errorCodeToString)));

export function isVatFault(error) {
  if (!error || typeof error !== 'object') return false;
  // Pre-computed flag on an error serialized from a worker to its embedder.
  if (error.vatFault === true) return true;
  // Poisoned collection: the image is unusable by contract.
  if (error.fatalCollection === true) return true;
  // Raw WASM trap (unreachable, memory access out of bounds). The
  // name check covers traps that crossed a serialization boundary.
  if (error instanceof WebAssembly.RuntimeError) return true;
  if (error.name === 'RuntimeError') return true;
  // Interpreter fault codes, in either carrier shape.
  const scriptError = error.scriptError ?? error;
  if (typeof scriptError.codeName === 'string'
      && VAT_FAULT_ERROR_CODE_NAMES.has(scriptError.codeName)) {
    return true;
  }
  if (typeof scriptError.code === 'number'
      && VAT_FAULT_ERROR_CODES.includes(scriptError.code)) {
    return true;
  }
  return false;
}

export class MissingDependencyError extends Error {
  constructor(capabilityName, depKey, depKind, depName) {
    super(
      `capability '${capabilityName}' declared need '${depKey}: ${depKind}' ` +
      `→ '${depName}', but no such ${depKind} was provided`);
    this.name = 'MissingDependencyError';
    this.capabilityName = capabilityName;
    this.depKey = depKey;
    this.depKind = depKind;
    this.depName = depName;
  }
}

export class CapabilityCycleError extends Error {
  constructor(cycle) {
    super(`capability dependency cycle: ${cycle.join(' → ')}`);
    this.name = 'CapabilityCycleError';
    this.cycle = cycle;
  }
}

export class MultipleEndorsementsError extends Error {
  constructor(identifier, endorsers) {
    super(
      `grant '${identifier}' was endorsed by multiple capabilities ` +
      `(${endorsers.join(', ')}); denied by single-claim policy`);
    this.name = 'MultipleEndorsementsError';
    this.identifier = identifier;
    this.endorsers = endorsers;
  }
}

export class RuntimeBootError extends Error {
  constructor(message, { cause, phase } = {}) {
    super(message, cause !== undefined ? { cause } : undefined);
    this.name = 'RuntimeBootError';
    this.phase = phase;
  }
}

export class DuplicateCapabilityNameError extends Error {
  constructor(name) {
    super(`capability name '${name}' was supplied more than once`);
    this.name = 'DuplicateCapabilityNameError';
    this.capabilityName = name;
  }
}

export class ParseError extends Error {
  constructor(message, semanticError) {
    super(message);
    this.name = 'ParseError';
    this.type = semanticError.type;
    this.line = semanticError.line;
    this.column = semanticError.column;
    this.hint = semanticError.hint;
    this.semanticError = semanticError;
  }
}

export class ResultMarshallingError extends TypeError {
  constructor(path, valueDescription) {
    super(`Runtime.invokeExport: result at ${path} is not JSON-shaped (${valueDescription})`);
    this.name = 'ResultMarshallingError';
    this.path = path;
    this.valueDescription = valueDescription;
  }
}

export class UncaughtScriptError extends Error {
  constructor(slot, scriptError, remainingFuel = null) {
    const thrown = scriptError.message || scriptError.codeName || 'unknown error';
    // A thrown error object's name (family or the class's own `name`
    // field) leads the diagnostic: `Uncaught ConfigFault: missing ...`.
    // USER_THROW only: other codes reuse `name` for the identifier
    // (`X is not defined` carries name === 'X').
    const label = scriptError.codeName === 'USER_THROW'
        && scriptError.name && !thrown.startsWith(`${scriptError.name}:`)
      ? `${scriptError.name}: ${thrown}`
      : thrown;
    super(`Uncaught ${label} (${scriptError.codeName} at pc ${scriptError.failPc})`);
    this.name = 'UncaughtScriptError';
    this.slot = slot;
    this.scriptError = scriptError;
    // Remaining fuel at the point the run threw. session.run computes
    // this and would otherwise drop it on the throw path; carrying it
    // lets the driver attribute the failing run's consumed fuel.
    this.remainingFuel = remainingFuel;
  }
}

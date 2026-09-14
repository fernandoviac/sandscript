/**
 * Runtime state — a single SAB-backed u32 cell holding the
 * scheduler's current process-wide state.
 *
 * The cell lives in the membrane SAB at the offset advertised
 * by HEADER.RUNTIME_STATE_OFFSET (membrane format v5+). This
 * module is pure SAB plumbing and does no allocation.
 *
 * The cell is the successor to RuntimeParkedState +
 * onParkedStateChange. JS-realm callers continue to read the
 * value through `runtime.stats.state`; cross-realm observers
 * read it via Atomics.load on this cell, and block on changes
 * via Atomics.wait. The runtime fires Atomics.notify after
 * every transition.
 *
 * The RUNTIME_STATE enum itself lives in src/membrane/index.js
 * — the membrane is the lower layer, owns the cell's bytes,
 * and is responsible for the cell's initial value. This module
 * re-exports the enum for runtime-layer convenience.
 *
 * Value ranges (mirrors the LEDGER_ACTIVITY convention):
 *   - 0..63    — sandscript-internal states. Reserved; embedders
 *                must not write these.
 *   - 64..65535 — embedder-defined states. Embedders write their
 *                own transitions for wait sites the runtime
 *                doesn't know about.
 *
 * Most-recent transition wins. Each side (runtime and embedder)
 * writes its own transitions; the cell reflects whichever happened
 * most recently. See RUNTIME_STATE in src/membrane/index.js for
 * the full contract.
 */

import {
  RUNTIME_STATE,
  RUNTIME_STATE_RUNTIME_RESERVED_MAX,
  runtimeStateName,
} from '../membrane/index.js';

export {
  RUNTIME_STATE,
  RUNTIME_STATE_RUNTIME_RESERVED_MAX,
  runtimeStateName,
};

export const RUNTIME_STATE_CELL_BYTES = 4;

/**
 * createRuntimeStateView({ buffer, byteOffset }) → RuntimeState
 *
 * Binds an Int32Array view (length 1) over the state cell and
 * returns an object exposing set/get/wait/rebind.
 *
 * @param {SharedArrayBuffer | ArrayBuffer} buffer
 * @param {number} byteOffset
 */
export function createRuntimeStateView({ buffer, byteOffset }) {
  let baseOffset = byteOffset >>> 0;
  let view = new Int32Array(buffer, baseOffset, 1);

  /**
   * Atomically store the new state and notify any Atomics.wait
   * observers blocked on the cell.
   */
  function set(state) {
    Atomics.store(view, 0, state | 0);
    Atomics.notify(view, 0, +Infinity);
  }

  /**
   * Atomically read the current state.
   */
  function get() {
    return Atomics.load(view, 0) >>> 0;
  }

  /**
   * Block until the cell holds something other than
   * `currentState`. Returns:
   *   - 'ok'         — woke after a transition off currentState
   *   - 'not-equal'  — cell didn't equal currentState at call time
   *   - 'timed-out'  — wait expired
   *
   * `timeoutMs` defaults to `Infinity` (wait forever).
   */
  function wait(currentState, timeoutMs) {
    const result = Atomics.wait(
      view, 0, currentState | 0,
      timeoutMs === undefined ? Infinity : timeoutMs);
    return result;
  }

  /**
   * Rebind to a new (buffer, byteOffset). Used by membrane
   * compaction (notifyMemoryRelocated). The new view picks up
   * whatever value the cell currently holds at the new offset.
   */
  function rebind(newBuffer, newByteOffset) {
    baseOffset = newByteOffset >>> 0;
    view = new Int32Array(newBuffer, baseOffset, 1);
  }

  return {
    set, get, wait, rebind,
    __peekOffset() { return baseOffset; },
    __peekBufferByteLength() { return view.buffer.byteLength; },
  };
}

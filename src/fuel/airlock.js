/**
 * Airlock: The execution boundary between JS and SandScript.
 *
 * The Airlock mediates ALL execution because every run needs grant context.
 * It:
 * - Owns the membrane (handle/grant tracking)
 * - Owns execution (calls wasm.run())
 * - Maintains handler registry
 * - Dispatches external calls to registered handlers
 * - Invokes callbacks with proper grant context
 * - Handles marshalling at the boundary
 */

import {
  Membrane,
  Handle,
  Grant,
  ClosureHandle,
  ObjectHandle,
  isHandle,
  isGrant,
  isClosureHandle,
  isObjectHandle,
  MembraneOutOfSpaceError,
  StaleHandleError,
  StaleGrantError,
  StaleClosureHandleError,
  StaleObjectHandleError,
  SnapshotOrphanedError,
  MUTATION_TAG,
  LEDGER_ACTIVITY,
  LINKED_PROMISE_NO_PARKED_CONTEXT,
} from '../membrane/index.js';
import { MembraneWalker } from '../membrane/walker.js';
import {
  TYPE,
  OBJ,
  OP,
  STATE,
  EXIT_DONE,
  EXIT_PAUSED_FUEL,
  EXIT_EXTERNAL_CALL,
  EXIT_ERROR,
  EXIT_GRANT_REQUEST,
  EXIT_ASYNC_CALL,
  EXIT_ASYNC_COMPLETE,
  EXIT_ASYNC_REJECTED,
  EXIT_AWAIT,
  EXIT_GENERATOR_CALL,
  EXIT_GENERATOR_NEXT,
  EXIT_GENERATOR_YIELD,
  EXIT_GENERATOR_COMPLETE,
  EXIT_GENERATOR_THROW,
  EXIT_CLASS_LINK_EXTERNAL,
  EXIT_INSTANCEOF_EXTERNAL,
  EXIT_EXTERNAL_HAS_PROPERTY,
  EXIT_EXTERNAL_DELETE_PROPERTY,
  RESPONSE_THROW,
  RESPONSE_RETURN,
  GRANT_ENTRY_SIZE,
  COMPLETION_NORMAL,
  COMPLETION_THROW,
  CLOSURE_FLAG_ASYNC,
  CLOSURE_FLAG_ARROW,
  CLOSURE_FLAG_GENERATOR,
  FUNCTION,
  BUILTIN_NAME,
  GC_HEADER_SIZE,
  FRAME,
  FRAME_SIZE,
  CONTEXT_CALL_STACK_OFFSET,
  CONTEXT_SIZE,
  CONTEXT_STATUS_FREE,
  PROMISE_STATUS_RESOLVED,
  PROMISE_STATUS_REJECTED,
  PROMISE_STATUS_PENDING,
  PROMISE,
  PROMISE_WAITER,
  THEN_HANDLER_FLAG_FINALLY,
  EXIT_PROMISE_METHOD,
  EXIT_EXTERNAL_PROPERTY,
  EXIT_EXTERNAL_PROPERTY_SET,
  EXIT_PROMISE_SETTLE,
  EXIT_MEMORY_PRESSURE,
  METHOD,
  CTX,
  CONTEXT_STATE_OFFSET,
  OBJECT_FLAG,
  FRAME_FLAG_CONSTRUCTOR,
  exitConditionToString,
} from './constants.js';
import { AttributedRejection, isAttributed, markAttributed } from './attributed-rejection.js';
import { HeapPressureSignal } from './memory-image.js';

// DEBUG-ONLY: module-level counters
// for the GC-header validator. The Airlock instance is Object.freeze'd, so
// per-run state lives here. Exported so a driver can read totals after a run.
// Off unless SANDSCRIPT_GC_ASSERT=1.
export const GC_ASSERT_STATE = { calls: 0, fails: 0, firstFail: null };
export function resetGcAssertState() { GC_ASSERT_STATE.calls = 0; GC_ASSERT_STATE.fails = 0; GC_ASSERT_STATE.firstFail = null; }

/**
 * Handle wrappers (see src/membrane/index.js) double as the marshalling
 * marker. When marshalling encounters a Handle, it serializes as
 * TYPE_EXTERNAL with the handle's slot as the payload. Re-export from
 * the airlock module so callers don't have to import the membrane
 * module directly.
 *
 * `External` is not re-exported. Callers must import and use `Handle`
 * directly so the public marshalling marker has a single name.
 */
export {
  Handle, Grant, ClosureHandle, ObjectHandle,
  isHandle, isGrant, isClosureHandle, isObjectHandle,
} from '../membrane/index.js';
export { AttributedRejection } from './attributed-rejection.js';

/**
 * Marker class for passing msgpack data as a native MSGPACK_REF value.
 * The bytes must already be written into the session's WASM memory at the
 * given absolute address. When marshalling encounters a MsgpackRef, it
 * writes TYPE_MSGPACK_REF directly — the interpreter can then navigate
 * the bytes with zero-copy property access.
 */
const MSGPACK_REF_TAG = Symbol.for('sandscript:msgpack-ref');

export function isMsgpackRef(value) {
  return value !== null && typeof value === 'object' && value[MSGPACK_REF_TAG] === true;
}

export class MsgpackRef {
  /**
   * Layout A reference: a (parent_data_ptr, offset) pair pointing into
   * an OBJ.ARRAYBUFFER on the SS heap. The byte length is read from the
   * parent's length prefix during reads, so callers don't pass it in.
   *
   * @param {number} parentDataPointer - DATA pointer to OBJ.ARRAYBUFFER
   *   produced by `Airlock.allocateMsgpackBytes`. The first 4 bytes at
   *   `abs(parentDataPointer)` hold the byte length of the payload.
   * @param {number} [offset=0] - Byte offset within the payload where
   *   this reference begins. The default points at the root value.
   */
  constructor(parentDataPointer, offset = 0) {
    this.parentDataPointer = parentDataPointer;
    this.offset = offset;
    this[MSGPACK_REF_TAG] = true;
  }
}

/**
 * Marker returned by context.suspend() to signal async suspension.
 * Detected by handleExternalCall() to set up the continuation.
 */
class SuspensionMarker {
  constructor(asyncCallback) {
    this.asyncCallback = asyncCallback;
  }
}

/**
 * Context object passed to external handlers.
 * Provides access to suspension API for async operations.
 */
class Context {
  constructor(airlock, contextSlot) {
    this.airlock = airlock;
    this.id = contextSlot;
    // Capture the generation from authoritative memory state at dispatch
    // time. `hostInvocationContext` re-verifies this exact
    // (slot, generation) identity before resolving, so a stale Context
    // retained past its invocation's termination can never resolve to the
    // slot's next occupant.
    this._generation = airlock.memoryImage.getContextGeneration(contextSlot);
  }

  /**
   * Host-owned invocation context.
   *
   * Resolves the opaque value the embedder supplied to
   * `Runtime.invokeExport(..., { hostInvocationContext })` for the
   * invocation-root context this dispatch executes in. Returns
   * `undefined` when the embedder supplied none, when this context is
   * not an invocation root (boot contexts, scheduled closure calls,
   * timer callbacks, spawned children), or once the invocation's
   * (slot, generation) identity is terminal or released.
   *
   * Host-only attribution surface: the value never crosses into the
   * SandScript heap, and there is no ambient fallback — resolution
   * works only through a retained Context whose captured identity is
   * still live. A retained Context keeps resolving across suspension,
   * including inside `context.suspend` async callbacks.
   */
  get hostInvocationContext() {
    return this.airlock.resolveHostInvocationContext(this.id, this._generation);
  }

  /**
   * Suspend execution and return control to the host.
   * The async callback receives (resolve, reject, { slot }).
   * - resolve(value): Resume execution with value on pending stack
   * - reject(error): Resume execution with error propagating through SS
   * - slot: durable linked-promise table id. Survives snapshot/restore;
   *   embedders persist this (typically via membrane.setEmbedderState)
   *   and use it post-restart with airlock.settleLinkedPromise(slot, ...)
   *   / airlock.rejectLinkedPromise(slot, ...) to wake the parked context.
   *   This is the snapshot-durable suspension path.
   *
   * @param {Function} asyncCallback - Called with (resolve, reject, { slot })
   * @returns {SuspensionMarker}
   */
  suspend(asyncCallback) {
    return new SuspensionMarker(asyncCallback);
  }
}

/**
 * Airlock manages execution and external call dispatch.
 *
 * # Snapshot/restore protocol
 *
 * Snapshotting follows the host-owned-memory contract: after quiescing the
 * runtime, the host slices its own vat memory and membrane buffer, then
 * restores by copying those bytes into freshly-allocated buffers
 * before calling `createSession({ memory, membraneBuffer, ... })`.
 * Sandscript exposes no snapshot/restore call on the session.
 *
 * After a restore (the host copied snapshot bytes into the
 * buffers), the membrane SAB is restored but JS-side state
 * (handler functions, getter functions, JS impl objects backing
 * each handle) is gone — JS closures and live objects don't
 * serialize. The host must re-establish them before drone code
 * resumes.
 *
 * Re-registration contract (four steps; the host MUST complete
 * all four before calling `session.run()`):
 *
 *   1. Walk surviving entries:
 *        - `airlock.membrane.enumerateHandles()` →
 *            `[{ handle, impl, metadata, declarationName }, …]`
 *          (impl is undefined post-restore — that's the marker
 *          telling you this entry needs re-binding.)
 *        - `airlock.membrane.enumerateGrants()` →
 *            `[{ grant, identifier, metadata, active, isRoot,
 *               handleSlots }, …]`
 *        - `airlock.enumerateClosureHandles()` →
 *            `[{ closureHandle, closurePointer,
 *               capturedGrantSlots, metadata, isNewWrapper }, …]`
 *
 *   2. For each handle entry, dispatch to the host's own setup
 *      code. Recommended: key on `metadata.kind` (or
 *      `declarationName` for declared globals). The exact shape
 *      of metadata is up to the host; for example,
 *      `{ kind: 'resource-method', resourceId: '...' }`.
 *
 *   3. Re-bind via the existing APIs:
 *        - `airlock.membrane._bindImpl(slot, impl)` — attach a
 *          fresh JS object as the handle's implementation.
 *        - `airlock.setHandler(handle, method, fn, options?)` —
 *          re-register a method handler.
 *        - `airlock.setHandlers(handle, methods)` — bulk re-register.
 *        - `airlock.setGetter(handle, propName, fn)` — re-register
 *          a property getter.
 *        - `airlock.setMemberInspector(handle, fn)` — re-register
 *          dynamic member classification.
 *      Same APIs the host uses on fresh-session setup. The handle
 *      already exists, so skip `register()`.
 *
 *      For closure handles, the host typically stuffs the wrapper
 *      into its own listener table keyed by metadata; nothing to
 *      "rebind" because the SAB carries closurePointer +
 *      capturedGrantSlots already. If the host doesn't want a
 *      surviving closure, call `airlock.dropClosureHandle(handle)`.
 *
 *   4. Resume drone execution via `session.run()`.
 *
 * # Loud-failure semantics
 *
 * If drone code calls a method handler the host forgot to
 * re-register, the airlock throws `TypeError: <declaredName>
 * has no method '<methodName>'` (or `is not directly callable`
 * for null-method direct-call handlers), routed as a thrown SS
 * exception so drone code can try/catch or propagate. This is
 * the safety net — the host's "did I forget to re-register
 * something?" detector is execution itself, not a structured API.
 *
 * Closure handles whose slot was reclaimed throw
 * `StaleClosureHandleError` on use.
 *
 * **Getters are different**: a missing getter does NOT throw.
 * The airlock falls through to method-binding semantics — the
 * drone gets back a TYPE_EXTERNAL_METHOD value, which behaves
 * normally if the drone immediately calls it (and would then
 * hit the missing-method-handler path) but otherwise produces
 * a value the drone may use unexpectedly. Hosts that rely on
 * getters should be careful to re-register them; consider
 * adding a one-line marker handler that throws if the host's
 * setup logic might miss them.
 */
export class Airlock {
  /**
   * @param {MemoryImage} memoryImage - Memory access
   * @param {Object} wasm - WASM instance with run() export
   * @param {Object} membraneOptions - Membrane construction options.
   *   Forwarded to the Membrane constructor unchanged. Under the
   *   host-owned-memory contract, the
   *   caller always provides an already-populated buffer (fresh-laid
   *   via layoutMembrane or restored by copying snapshot bytes in);
   *   the Membrane constructor validates magic + version and attaches.
   */
  constructor(memoryImage, wasm, membraneOptions = {}) {
    this.memoryImage = memoryImage;
    this.wasm = wasm;
    this.membrane = new Membrane(membraneOptions);
    // DEBUG-ONLY: GC-header assertions.
    // Off unless SANDSCRIPT_GC_ASSERT=1. See _assertGcType.
    this._gcAssertEnabled = (() => {
      try { return Deno?.env?.get?.('SANDSCRIPT_GC_ASSERT') === '1'; }
      catch { return false; }
    })();
    this.handlers = new Map();  // "handleSlot:method" → function
    this.handlerOptions = new Map();  // "handleSlot:method" → { coerceExact }
    this.getters = new Map();   // "handleSlot:propName" → function (sync getter)
    this.setters = new Map();   // "handleSlot:propName" → function (sync/async setter)
    this.memberInspectors = new Map(); // handleSlot → synchronous member classifier
    // Constructible-external registrations and branded-instance
    // forwarding handlers.
    // The membrane persists WHICH handles are constructible
    // (HANDLE_FLAG_CONSTRUCTIBLE); the handler functions live here and
    // must be re-registered by the capability after restore.
    this.constructibleRegistrations = new Map(); // handleSlot → { beginConstruction, completeConstruction, abortConstruction }
    // Host-initiated construction keeps the caller's retained constructor
    // handle by context identity. This lets the constructible-external
    // protocol borrow the exact slot/version instead of re-registering the
    // same closure when super() reaches beginConstruction. Context generation
    // prevents a recycled slot from inheriting an earlier construction.
    this._constructionNewTargetByContext = new Map();
    this.hasPropertyHandlers = new Map();        // handleSlot → function
    this.deletePropertyHandlers = new Map();     // handleSlot → function
    // Slots that received ANY host registration (handler/getter/setter)
    // in THIS vat life. This is evidence for the orphaned-handle gate:
    // the canonical resume pattern re-binds handlers against restored
    // handles without necessarily re-binding an impl, so a restored slot
    // with registrations is alive. Only a slot with neither impl nor any
    // registration is an orphan from a previous life. Never pruned: a slot
    // that ever registered in this life is this-life by definition; reuse
    // after a reap bumps the version and is handled by the stale-handle gate.
    this.slotsWithHostRegistrations = new Set();

    // Transient per-slot
    // "tick at last runContext() entry" map. Pure JS-side; not part
    // of any snapshot. Empty on a fresh airlock — host restart =
    // no runs yet, which is correct.
    this._lastTickRunBySlot = new Map();

    // =========================================================================
    // Mutable internal state — `_state` is an unfrozen sub-object so the
    // outer airlock can be Object.frozen at end of construction. Any
    // sandscript-owned field that must change post-construction lives
    // here. Reach via `this._state.collector` etc.
    //
    // Reason for this split: monkeypatching the airlock from a consumer
    // silently diverges the surface and makes pure-SandScript reproductions
    // of consumer bugs impossible to trust. Freezing the outer object makes
    // those patches throw loudly. SandScript's own mutations are corralled
    // here so the freeze does not break internal behavior.
    // =========================================================================
    this._state = {
      // Collector reference, wired in by session after construction (it
      // doesn't exist when the airlock is built). Compaction uses it
      // to walk the heap for live TYPE_EXTERNAL slots.
      collector: null,
      // The session's full heap GC, wired by setHeapGarbageCollect()
      // at session construction. Used to self-heal heap pressure
      // during linked-promise settle marshals (see that method's doc).
      heapGarbageCollect: null,
      // Set by rejectOrphanedLinkedPromises during session restore.
      // Cached BEFORE the linked-promise table is cleared so hosts can
      // surface the orphan count after createSession returns. Stays 0
      // for fresh-boot airlocks (no restore happened).
      lastOrphanedLinkedPromiseCount: 0,
      // Slots whose execution is an in-flight Promise executor (created
      // by `await new Promise((resolve, reject) => ...)`). Populated by
      // executor-construction sites; consumed by handleAsyncComplete /
      // handleAsyncRejected to find the parked context.
      executorContexts: new Set(),
      // Queue of context slots that sandscript has woken (e.g. via a
      // linked JS promise settling). The host drains this — see
      // hooks.onPendingSpawnedContexts below.
      pendingSpawnedContexts: [],
      // Host-owned generation captured when a context parks on a promise.
      // This survives freeing the context long enough to reject late settlement.
      awaitingGenerationBySlot: new Map(),
      // Calling-slot cell exposed via the `currentSlot` getter.
      // Set for the dynamic extent of every registered handler /
      // getter invocation so embedders that need slot-attributed
      // bookkeeping (in-flight ledgers, typed-error capture) can
      // read it without threading the slot through every layer.
      // `null` outside any handler/getter invocation. Slot 0 is a
      // legitimate id (`allocateContext` hands it out and can free
      // it for reuse), so a numeric sentinel would be ambiguous.
      currentSlot: null,
      // Per-slot stash of the AttributedRejection built when a
      // registered handler / getter threw (sync) or its returned
      // Promise rejected (async). Populated atomically with the
      // catch inside _invokeWithSlotCapture — no other slot
      // activity occurs between the throw and the capture, so the
      // diagnostic snapshot is the slot's state at the moment of
      // throw. The host retrieves it via consumeAttributedRejection
      // (or peekAttributedRejection) when it builds its
      // error envelope. The original error continues to
      // resumeWithThrow so SS-side error propagation is unchanged.
      attributedRejectionBySlot: new Map(),
      // Optional in-flight ledger view, wired in by the Runtime
      // via setLedger() after construction (the Airlock is built
      // by the session before the Runtime exists). When present,
      // handleAwait claims an AWAITING_PROMISE entry when a slot
      // parks; resume paths free it. When null, the airlock skips
      // ledger bookkeeping, so low-level embedders without a Runtime see
      // a no-op.
      ledger: null,
      // Host-invocation-context resolver, wired in by the Runtime via
      // setHostInvocationContextResolver() after construction. Receives a
      // (slot, generation) identity and returns the opaque embedder
      // value for the live invocation-root owner of that exact
      // identity, or undefined. When null (no Runtime wired in),
      // Context.hostInvocationContext reports undefined everywhere.
      hostInvocationContextResolver: null,
      // Per-slot map from contextSlot → ledger entry index, so a
      // resume path can free the exact entry the matching park
      // claimed. Cleared only by free; if claim returns -1 (table
      // full) we don't record a mapping and resume silently
      // skips the free.
      awaitingLedgerEntryBySlot: new Map(),
      // Unhandled-rejection watchlist. When an async function rejects
      // its promise and nobody is currently waiting for it (zero
      // waiters, zero .then/.catch handlers), we can't immediately
      // declare the rejection unhandled — a parent slot might be
      // about to `await` the promise a few instructions later. So we
      // record the promise pointer and the marshalled rejection value
      // here. When `handleAwait` later delivers the rejection to a
      // waiter (the parent's `catch`), we remove it from the
      // watchlist — it was handled. Anything still on the watchlist
      // after all runnable slots have settled is truly unhandled.
      // The runtime drains this watchlist when it goes idle and
      // surfaces each entry as an UncaughtScriptError.
      pendingUnhandledRejections: new Map(),
      // In-flight handle slots: registered by host code but not yet
      // marshalled onto the SS heap. Compaction adds them to the live
      // set so they survive reaping. Keyed by the context slot whose
      // dispatch registered them (`currentSlot` at register() time),
      // or null for registrations outside any dispatch (suspension
      // resolve callbacks, timers, reply handlers).
      //
      // Bucketing matters: a single wholesale-cleared set loses its
      // protection as soon as any other slot runs. For example, a
      // handle registered during slot X's dispatch but returned via a
      // JS Promise was reaped if slot Y ran (and compacted) before the
      // promise settled. Per-context buckets are cleared only when
      // THEIR context runs again — which can't happen before the
      // parked dispatch's value lands on the heap.
      //
      // The null bucket is cleared at the top of every runContext and
      // honored ONLY by pressure-triggered compaction: a detached
      // registration is only ever consumed synchronously (register →
      // grant.add/setHandler → resolve, all in one JS callback), so
      // the only gc that can interleave is the membrane's own
      // _retryOnPressure compact. At explicit compactions
      // (compactMembrane at quiescence, session.gc) detached handles
      // with no SS reference are orphans by the lazy-reclaim contract
      // and must be reaped — hosts mint-and-drop outside dispatch and
      // rely on it. A detached handle held across an await BEFORE
      // resolve() is still unprotected — that's the documented pin()
      // contract.
      inFlightHandleSlotBuckets: new Map(),
      // In-flight snapshots taken when a JS promise is linked as an SS
      // promise (_linkJSPromiseShared): every handle slot in-flight at
      // link time stays protected until that promise settles, because
      // the settle marshal is the only path that can still deliver
      // those handles to the heap. Keyed by the JS promise identity;
      // entries are deleted in _settleLinkedPromise. Compaction unions
      // these values alongside the buckets above.
      inFlightSnapshotsByLinkedPromise: new Map(),
      // Handle slots pinned for the lifetime of this airlock via
      // pin(handle). Compaction never reaps them. For long-lived
      // capability-surface handles (namespace objects returned by
      // getters, factory singletons) that live only in host-side
      // closures between dispatches — invisible to the membrane
      // walker, which can only see SS-heap references, grant
      // stacks, and root grants. JS-side only, deliberately NOT
      // persisted: capability setup() re-runs on every boot
      // (fresh spawn AND restore) and re-pins the handles it
      // creates; pins from a previous life die with its process.
      pinnedHandleSlots: new Set(),
      // Grant slots pinned via pin(grant) — same contract as
      // pinnedHandleSlots: live by fiat, JS-side only, never
      // persisted. For long-lived capability grants a host creates
      // once at setup and reuses per approval: between grant blocks
      // such a grant has no SS anchor (grant stack, root list,
      // closure capture, live handle's grant list), so without a pin
      // the first compaction reaps the slot; a later createGrant can
      // then reuse it, causing the host's stale wrapper to alias a
      // different authorization domain.
      pinnedGrantSlots: new Set(),
    };

    // =========================================================================
    // Host-facing hook namespace — `hooks` is an unfrozen sub-object so
    // consumers can install callbacks without mutating the airlock
    // itself. These hooks are documented sandscript extension points;
    // see each field's JSDoc for the contract.
    // =========================================================================
    this.hooks = {
      /**
       * Grant request callback. Called when the interpreter yields
       * EXIT_GRANT_REQUEST. May return a Promise for async approval.
       * @type {Function|null} (identifier) => { approved: boolean, grant?: Grant }
       */
      onGrantRequest: null,

      /**
       * Notification hook for "spawned contexts have been pushed".
       *
       * SandScript is passive during JS event-loop pauses: when a
       * linked JS Promise resolves and the host has drone slots
       * awaiting that promise, sandscript pushes those slots into
       * `_state.pendingSpawnedContexts` from inside a microtask (the
       * Promise's `.then`). Sandscript itself has no run loop and
       * cannot resume the slots — only the host can call
       * `session.run` again.
       *
       * Without a notification, every host-side promise source has
       * to remember to schedule its own drain after the promise
       * settles. That contract is invisible from any one site and
       * easy to forget; forgetting it causes drone code parked on
       * `await` to hang silently forever.
       *
       * With this hook, sandscript fires onPendingSpawnedContexts
       * synchronously after every push that adds work to the queue.
       * The host installs the hook once at airlock construction
       * (or shortly after) and points it at its drain logic.
       *
       * The hook is purely advisory — sandscript still doesn't run
       * any slot itself. The host decides what (and when) to drive.
       *
       * @type {Function|null} () => void
       */
      onPendingSpawnedContexts: null,

      // Observability hooks, threaded from Runtime during start().
      onExternalCall: null,
      onGrant: null,
      onSuspend: null,
      onSlotLifecycle: null,

      // Compaction hook — called after membrane.compact() frees
      // handle slots. Capabilities that cache Handle objects in
      // JS-side closures or Maps MUST use this to invalidate
      // stale entries; the GC only tracks SS-heap references and
      // has no visibility into host-side caches.
      onCompact: null,

      // Handle slots referenced by args that the
      // RUNTIME has enqueued for a fired closure call but not yet marshaled
      // onto the SS heap. The runtime's closure queue spans dispatch cycles, so
      // these handles have no SS-heap reference yet AND are not in the airlock's
      // per-dispatch in-flight buckets — a compaction would reap-and-reuse the
      // slot, leaving the queued arg a stale Handle that marshals corrupt.
      // The Runtime installs this (returns number[] of live handle slots);
      // compaction unions them into the live set. () => number[]
      inFlightClosureArgHandleSlots: null,

      // MsgpackRef objects referenced by
      // args the RUNTIME has enqueued for a fired closure call but not yet
      // marshaled onto the SS heap. Their blobs (OBJ.ARRAYBUFFER via
      // allocateMsgpackBytes) have NO SS-heap reference until the marshal, so
      // a heap gc in the queue window collected the blob and left the JS-held
      // raw parentDataPointer dangling — the fire then marshaled a poisoned
      // MSGPACK_REF into the callback scope, causing a later collection's
      // mark walk to dereference an invalid absolute address. session.gc() unions
      // these blobs into the collect() external roots and rewrites each ref's
      // parentDataPointer from the returned forwarding. () => MsgpackRef[]
      inFlightMsgpackRefs: null,

      // Orphaned-handle notification: restored but unbound handles fail
      // loudly.
      // Fired when drone code touches a handle whose slot survived a
      // restore in the membrane bytes but was never re-bound to a JS impl
      // in this vat life — the drone gets a named, catchable error (see
      // _rejectIfOrphanedHandle); this hook lets the embedder ALSO emit a
      // platform event so operators see the orphan without drone-side
      // cooperation. ({ handleId, declaredName, access }) => void
      onOrphanedHandle: null,
    };

    // setCollector(c) writes through to this._state.collector.
    // Internal sandscript code reads this._state.collector directly.

    // Root grant slots and handle declarationNames live in the membrane SAB.
    // Read via this.membrane.rootGrantSlots() / handle metadata.

    // Closure handles + linked promises also live in the membrane SAB.
    // The JS-side state that remains:
    //   - closureRegistry: FinalizationRegistry that frees the SAB slot when
    //     the host's JS wrapper is collected. The registered token is the
    //     SAB slot index.
    //   - linkedPromiseSlotByJSPromise: WeakMap<JSPromise, slotIndex>, used
    //     to free the SAB slot when the JS Promise settles. Not snapshottable
    //     (and irrelevant after restore — orphaned promises are rejected).
    // The held value is { slot, version } so this callback can detect
    // slot reallocation: if a host wrapper at (slot=N, version=V) becomes
    // unreachable AFTER the slot was freed and reused for a new wrapper
    // at (slot=N, version=V+2), the slot's current version no longer
    // matches V — freeing here would clobber the live new wrapper. The
    // version check skips that case; the live wrapper's own
    // FinalizationRegistry registration will free the slot when it's
    // actually unreachable.
    this.closureRegistry = new FinalizationRegistry(
      this.membrane._wrapFinalizationCallback(({ slot, version }) => {
        const currentVersion = this.membrane._readClosureHandleVersion(slot);
        if (currentVersion !== version) return;
        // FinalizationRegistry-driven free: distinct from explicit
        // dropClosureHandle() so log readers can tell why a slot went
        // away (JS GC vs host policy).
        this.membrane._freeClosureHandleSlot(slot, MUTATION_TAG.WRAPPER_GC);
      }));
    // Object-handle counterpart. Same version-checked shape. An
    // unreachable ObjectHandle wrapper can never be released explicitly,
    // so the registry frees the slot outright (retain count included) —
    // leaving it live would leak a permanent GC root.
    this.objectRegistry = new FinalizationRegistry(
      this.membrane._wrapFinalizationCallback(({ slot, version }) => {
        const currentVersion = this.membrane._readObjectHandleVersion(slot);
        if (currentVersion !== version) return;
        this.membrane._freeObjectHandleSlot(slot, MUTATION_TAG.WRAPPER_GC);
      }));
    this.linkedPromiseSlotByJSPromise = new WeakMap();

    // =========================================================================
    // Multi-Context Suspension State
    // =========================================================================

    /**
     * Per-slot queue of raw thrown values that have flowed through
     * reject(error) since the slot last drained.
     *
     * A queue preserves multiple rejections when a drone catches one
     * rejection and proceeds to another await before the host consumes
     * the diagnostic errors.
     *
     * Lifetime: cleared per-slot when:
     *   - resolve fires for that slot's continuation (the slot
     *     succeeded, so the recorded rejection — if any — is stale
     *     by definition);
     *   - the host calls consumeLastRejectionError(slot) to pop the
     *     head and signal it owns the diagnosis.
     *
     * Map<contextSlot:number, Array<thrown:any>>
     */
    this._rejectionErrorsBySlot = new Map();

    /**
     * Map from context slot to Promise callbacks.
     * When a callback suspends, we store { resolve, reject } here.
     * When the context completes, we resolve/reject the Promise and clean up.
     * @type {Map<number, { resolve: Function, reject: Function }>}
     */
    this.pendingContexts = new Map();

    /**
     * Stash for
     * resumeWithValue marshals that hit heap pressure mid-walk. The
     * handler has already run (side effects committed); we can't
     * re-invoke it on retry, so we hold its result here keyed by slot
     * until the host gcs and pumps session.run(slot, fuel) again.
     * Drained by airlock.runContext, which retries the marshal before
     * dispatching to WAT.
     * @type {Map<number, { value: *, options: Object, activeGrantIds: Set<number> }>}
     */
    this._deferredMarshals = new Map();

    // Register the marshalling detector chain. These run inside writeValueAt
    // for every JS value being written to SS memory. Stateless detectors
    // (External, MsgpackRef, Promise) work without caller cooperation; the
    // closure detector consumes options.closureCaptureContextSlot.
    this.memoryImage.setMarshalDetectors([
      (value) => {
        if (isHandle(value)) {
          // Carry the slot VERSION in data_hi
          // so dispatch can reject a stale handle value (one whose slot was
          // reaped — version bumped — while the value lingered in SS). A fresh
          // slot is always version >= 1, so a value with data_hi=0 is a legacy/
          // unversioned value and dispatch skips the check (back-compat).
          return { type: TYPE.EXTERNAL, dataLo: value.slot, dataHi: value.version ?? 0 };
        }
        return undefined;
      },
      (value) => {
        // An ObjectHandle result reifies as the referenced
        // TYPE_OBJECT value — identity, not a clone. Session, version,
        // liveness, and captured grants validate before the write; a
        // released, foreign, or grant-revoked handle throws.
        if (isObjectHandle(value)) {
          if (value.membrane !== this.membrane) {
            throw new TypeError('ObjectHandle belongs to another session');
          }
          if (this.membrane._readObjectHandleVersion(value.slot) !== value.version) {
            throw new TypeError('ObjectHandle has been released');
          }
          const pointer = this.membrane._readObjectPointer(value.slot);
          if (pointer === 0) {
            throw new TypeError('ObjectHandle has been released');
          }
          if (!this.areObjectGrantsActive(value)) {
            throw new TypeError('ObjectHandle has revoked grants');
          }
          return { type: TYPE.OBJECT, dataLo: pointer };
        }
        return undefined;
      },
      (value) => {
        // A ClosureHandle result reifies as the referenced
        // TYPE_FUNCTION value, preserving the identity of a class returned
        // through a host API. Same validation ladder as ObjectHandle.
        if (isClosureHandle(value)) {
          if (value.membrane !== this.membrane) {
            throw new TypeError('ClosureHandle belongs to another session');
          }
          if (this.membrane._readClosureHandleVersion(value.slot) !== value.version) {
            throw new TypeError('ClosureHandle has been released');
          }
          const pointer = this.membrane._readClosurePointer(value.slot);
          if (pointer === 0) {
            throw new TypeError('ClosureHandle has been released');
          }
          if (!this.areClosureGrantsActive(value)) {
            throw new TypeError('ClosureHandle has revoked grants');
          }
          return { type: TYPE.FUNCTION, dataLo: pointer };
        }
        return undefined;
      },
      (value) => {
        if (isMsgpackRef(value)) {
          return { type: TYPE.MSGPACK_REF, dataLo: value.parentDataPointer, dataHi: value.offset };
        }
        return undefined;
      },
      (value) => {
        if (value instanceof Promise) {
          // Link without a context identity here. Closures inside the
          // promise's resolved value require an explicit
          // closureCaptureContextSlot from the caller.
          const promiseDataPointer = this.linkJSPromise(value);
          const headerPointer = promiseDataPointer - GC_HEADER_SIZE;
          return { type: TYPE.PROMISE, dataLo: headerPointer };
        }
        return undefined;
      },
      (value) => {
        // ArrayBuffer: copy the bytes into an SS-heap-allocated
        // ArrayBuffer object and return its dataPointer. Without this
        // detector, ArrayBuffer falls into writeValueAt's generic
        // typeof === 'object' branch and gets marshalled as a plain
        // object, which silently corrupts binary data.
        if (value instanceof ArrayBuffer) {
          const byteLength = value.byteLength;
          const bufferDataPointer = this.memoryImage.allocateArrayBuffer(byteLength);
          const bytesPointer = this.memoryImage.getArrayBufferBytesPointer(bufferDataPointer);
          new Uint8Array(this.memoryImage.buffer, bytesPointer, byteLength)
            .set(new Uint8Array(value));
          return { type: TYPE.ARRAYBUFFER, dataLo: bufferDataPointer };
        }
        return undefined;
      },
      (value) => {
        // Uint8Array: allocate a fresh SS ArrayBuffer holding the
        // bytes (copying detaches the JS-side view from the SS heap),
        // then a typed-array descriptor pointing into it. Same reason
        // as the ArrayBuffer detector above — without this, drones
        // see a plain object.
        if (value instanceof Uint8Array) {
          const byteLength = value.byteLength;
          const bufferDataPointer = this.memoryImage.allocateArrayBuffer(byteLength);
          const bytesPointer = this.memoryImage.getArrayBufferBytesPointer(bufferDataPointer);
          new Uint8Array(this.memoryImage.buffer, bytesPointer, byteLength).set(value);
          const descriptorPointer = this.memoryImage.allocateTypedArrayDescriptor(
            bufferDataPointer, 0, value.length);
          return { type: TYPE.UINT8ARRAY, dataLo: descriptorPointer };
        }
        return undefined;
      },
      // NOTE: JS function marshalling is not supported by this detector
      // chain. Callers that marshal closures must supply
      // options.closureCaptureContextSlot through the supported marshalling
      // path; the generic path throws "Cannot marshal value of type function".
    ]);

    // Freeze the airlock object. Adding net-new fields from consumers
    // now throws a TypeError. The
    // accessor proxies above let legitimate field-setter idioms keep
    // working; `this.hooks` and `this._state` are unfrozen so the
    // documented mutable surfaces stay mutable.
    Object.freeze(this);
  }

  // ===========================================================================
  // Handle Registration
  // ===========================================================================

  /**
   * Register a JS object in the membrane.
   * @param {*} impl - The JS object to register
   * @param {Object} metadata - Optional metadata
   * @returns {Handle} - Wrapper carrying (slot, version)
   */
  register(impl, metadata = null) {
    const handle = this.membrane.register(impl, metadata);
    // Always track as in-flight. Inside a dispatch the bucket is the
    // dispatching context's slot; outside it (suspension resolve callbacks,
    // reply handlers, timers) the null bucket protects the handle across
    // any pool-pressure compaction triggered before it is marshalled.
    // See inFlightHandleSlotBuckets in the constructor.
    const bucketKey = this._state.currentSlot;
    let bucket = this._state.inFlightHandleSlotBuckets.get(bucketKey);
    if (!bucket) {
      bucket = new Set();
      this._state.inFlightHandleSlotBuckets.set(bucketKey, bucket);
    }
    bucket.add(handle.slot);
    return handle;
  }

  /**
   * Look up a registered object by Handle.
   * @param {Handle} handle
   * @returns {*} - The registered object, or undefined
   */
  lookup(handle) {
    return this.membrane.lookup(handle);
  }

  /**
   * Declare a handle in SandScript global scope.
   * @param {string} name - Variable name in SS
   * @param {Handle} handle - Handle wrapper from register()
   */
  declare(name, handle) {
    const slot = this.membrane.slotOf(handle);
    this.membrane.setDeclarationName(handle, name);
    // slotOf (unwrapHandle) already validated handle.version against the
    // live slot version above — it throws StaleHandleError first if they
    // ever disagreed, so handle.version is guaranteed current here. Thread
    // it through so this declared identifier's SS value carries a real
    // version too. Otherwise a top-level capability declaration would be
    // invisible to the stale-handle check.
    this.memoryImage.declareExternal(name, slot, handle.version);
  }

  /**
   * Pin a handle for the lifetime of this airlock: membrane
   * compaction will never reap its slot, even when no SS-heap
   * reference exists.
   *
   * For long-lived capability-surface handles that the capability
   * keeps only in host-side closures between dispatches (namespace
   * objects returned by getters, factory singletons). Such handles
   * are invisible to the membrane walker — it sees SS-heap
   * references, grant stacks, and root grants, not JS variables —
   * so without a pin the first compaction reaps them and the
   * capability's stale wrapper fails with a version mismatch on
   * its next use.
   *
   * Declared handles (declare()) don't need pinning: declaration
   * binds them into the SS root scope, which the walker reaches.
   *
   * Transient delivery handles usually don't need pinning either:
   * register() tracks every new handle as in-flight (per-dispatch
   * bucket, detached bucket, or linked-promise snapshot — see
   * inFlightHandleSlotBuckets). The one unprotected window is a
   * handle registered OUTSIDE a dispatch and then held across an
   * await/timer before being resolved/marshalled — sandscript
   * cannot attribute it to a future delivery. Either resolve in
   * the same synchronous callback that registered it, or pin.
   *
   * Also accepts a Grant: a long-lived grant the host creates once at
   * setup and reuses per approval has no SS anchor *between* grant
   * blocks (grant-stack entries pop at block exit), so without a pin
   * any compaction can reap it and a later createGrant can reuse the
   * slot under a different authorization domain. Per-approval grants created
   * inside onGrantRequest don't need pinning — the approval window
   * (handleGrantRequest) protects them until their stack entries push.
   *
   * JS-side only, deliberately not persisted — capability setup()
   * re-runs on every boot and re-pins its fresh handles and grants;
   * pins from a previous life die with its process, so stale slots
   * from a restored membrane stay reclaimable.
   *
   * @param {Handle|Grant} handleOrGrant - wrapper from register() / createGrant()
   * @returns {Handle|Grant} - the same wrapper, for chaining
   */
  pin(handleOrGrant) {
    if (isGrant(handleOrGrant)) {
      this._state.pinnedGrantSlots.add(this.membrane.slotOfGrant(handleOrGrant));
    } else {
      this._state.pinnedHandleSlots.add(this.membrane.slotOf(handleOrGrant));
    }
    return handleOrGrant;
  }

  /**
   * Release a pin(). The wrapper's slot returns to normal liveness
   * rules and is reaped by the next compaction unless something else
   * anchors it. For capability teardown: revoke the grant, unpin it,
   * and let compaction reclaim the slot.
   *
   * @param {Handle|Grant} handleOrGrant - the pinned wrapper
   * @returns {Handle|Grant} - the same wrapper, for chaining
   */
  unpin(handleOrGrant) {
    if (isGrant(handleOrGrant)) {
      this._state.pinnedGrantSlots.delete(this.membrane.slotOfGrant(handleOrGrant));
    } else {
      this._state.pinnedHandleSlots.delete(this.membrane.slotOf(handleOrGrant));
    }
    return handleOrGrant;
  }

  /**
   * Create a root grant that is always considered active.
   * All handles added to this grant will be accessible without explicit grant blocks.
   *
   * This works by setting the ROOT flag on the grant entry (and adding it to
   * the membrane's rootGrantsList in the SAB). The airlock unions
   * membrane.rootGrantSlots() into the active set on every authorization
   * check. The interpreter's grant stack is NOT modified.
   *
   * @param {string} identifier - Grant identifier (default: "__root__")
   * @returns {Grant} - The root grant
   */
  createRootGrant(identifier = '__root__') {
    const grant = this.membrane.createGrant(identifier);
    this.membrane.markAsRootGrant(grant);
    return grant;
  }

  /**
   * Slot of the SS context currently inside a registered handler or
   * getter invocation. `null` outside any invocation. Useful for
   * host-side machinery (in-flight ledgers, typed-error capture)
   * that needs to attribute work back to the calling SS context
   * without threading the slot through every layer manually.
   *
   * The cell is set on handler/getter entry and cleared on the
   * sync return of the call. Reading it from inside a `.then` /
   * `.catch` callback chained off the handler's returned Promise
   * is NOT supported — by the time those microtasks run, the
   * wrapper's sync portion has already restored the cell, and
   * any unrelated handler invocation may have set it to something
   * else in the meantime. Host machinery that needs a slot in
   * async paths should capture the slot synchronously (e.g.
   * `const slot = airlock.currentSlot;` at handler entry) and
   * close over it.
   *
   * @returns {number|null}
   */
  get currentSlot() {
    return this._state.currentSlot;
  }

  /**
   * Capture a synchronous snapshot of an SS context slot's state as a
   * plain object. Reads sandscript-internal slot fields through the
   * memory image so embedders never have to byte-walk the layout.
   *
   * The returned shape is part of sandscript's public surface: adding
   * fields is non-breaking; renaming or removing fields is a major
   * version change. msgpack-friendly throughout (numbers, bigints,
   * arrays of numbers, plain strings) so envelope embedders can
   * round-trip the snapshot without further coercion.
   *
   * @param {number} slot
   * @returns {Object} `{ slot, tick, instructionIndex, status,
   *   activeGrantIds, pendingStackDepth, callStackDepth, grantStackDepth,
   *   scopePointer, exitCondition }`, or `{ slot, status: 'invalid' }`
   *   when `slot` is out of range or its context is free.
   */
  captureSlotDiagnostic(slot) {
    const mem = this.memoryImage;
    const capacity = mem.getContextTableCapacity();
    if (!Number.isInteger(slot) || slot < 0 || slot >= capacity) {
      return { slot, status: 'invalid' };
    }
    const exitCondition = mem.getExitCondition(slot);
    if (exitCondition === CONTEXT_STATUS_FREE) {
      return { slot, status: 'invalid' };
    }
    const status = exitCondition === 0
      ? 'running'
      : exitConditionToString(exitCondition);
    return {
      slot,
      tick: this.membrane.tick(),
      instructionIndex: mem.getContextInstructionIndex(slot),
      status,
      exitCondition,
      activeGrantIds: [...mem.getActiveGrantIds(slot)],
      pendingStackDepth: mem.getPendingDepth(slot),
      callStackDepth: mem.getCallStackDepth(slot),
      grantStackDepth: mem.getGrantDepth(slot),
      scopePointer: mem.getContextScope(slot),
    };
  }

  /**
   * Invoke a registered handler/getter with `_state.currentSlot`
   * set to `slot` for the duration of the sync portion of the
   * call. Restores the prior value on return (sync or thrown) so
   * nested invocations compose correctly.
   *
   * Sync throws and async rejections both build an
   * `AttributedRejection` carrying the calling slot and a diagnostic
   * snapshot captured atomically with the catch (no other slot
   * activity occurs between the throw and the capture), then stash
   * it in `_state.attributedRejectionBySlot` keyed by `slot`. The
   * host retrieves it via `consumeAttributedRejection(slot)` when it
   * builds an error envelope. The original error continues to
   * propagate (sync throws are re-thrown unchanged for the caller's
   * `try/catch` to reach `resumeWithThrow`; async rejections settle
   * the chained Promise with the original reason) so SS-side error
   * propagation is unchanged.
   *
   * Happy path is unchanged: sync return value passes through; a
   * resolved Promise's fast path is preserved by using `.then` only
   * on the reject branch.
   *
   * @param {number} slot
   * @param {Function} fn
   * @param {Object} callArgs
   * @returns {*}
   */
  _invokeWithSlotCapture(slot, fn, callArgs) {
    const generation = Number.isInteger(slot)
        && slot >= 0
        && slot < this.memoryImage.getContextCount()
      ? this.memoryImage.getContextGeneration(slot)
      : null;
    const prev = this._state.currentSlot;
    this._state.currentSlot = slot;
    let result;
    try {
      result = fn(callArgs);
    } catch (e) {
      // Sync throw — capture diagnostic and stash, but skip if an
      // inner wrap already attributed this error: only the slot
      // that originated the throw owns the attribution. Outer
      // wraps see the same error propagating through and should
      // leave the inner stash untouched, so the host's
      // consumeAttributedRejection(slot) always returns the
      // throw-originating slot.
      if (!isAttributed(e)) {
        const diagnostic = this.captureSlotDiagnostic(slot);
        this._state.attributedRejectionBySlot.set(
          slot, new AttributedRejection(e, slot, diagnostic));
        markAttributed(e);
      }
      this._state.currentSlot = prev;
      throw e;
    }
    this._state.currentSlot = prev;
    // Async path: if the handler returned a Promise, attach a
    // reject-side observer that captures the diagnostic and stashes
    // the AttributedRejection — but return the ORIGINAL Promise
    // unchanged. Identity matters: sandscript's linked-promise
    // machinery keys settlement off the Promise's identity
    // (see linkedPromiseSlotByJSPromise), and downstream callers
    // observe settlement timing relative to the same Promise the
    // marshaller registered. Wrapping with .then would mint a new
    // Promise that settles one microtask later — silently breaking
    // the host's "settle then drain" rhythm. Instead we observe via
    // an unreturned .then; the observer's own rejection is
    // explicitly absorbed so it doesn't fire an UnhandledRejection
    // warning while the original Promise still rejects through its
    // normal channels.
    if (result !== null && typeof result === 'object' && typeof result.then === 'function') {
      result.then(undefined, (reason) => {
        if (generation !== null
            && !this.memoryImage.isContextIdentityLive(slot, generation)) {
          this._reportStaleSettlement(slot, generation);
          return;
        }
        if (isAttributed(reason)) return; // inner wrap won
        const diagnostic = this.captureSlotDiagnostic(slot);
        this._state.attributedRejectionBySlot.set(
          slot, new AttributedRejection(reason, slot, diagnostic));
        markAttributed(reason);
        // Don't re-throw: the original Promise (returned below)
        // already carries the rejection through every consumer
        // that needs it. Re-throwing here would surface an
        // UnhandledRejection from this observer chain.
      });
    }
    return result;
  }

  /**
   * Read (and remove) the AttributedRejection stashed for `slot`
   * by the most recent handler throw / async rejection. Returns
   * `null` if no rejection is stashed.
   *
   * Hosts call this from the path that surfaces a slot error
   * (error-envelope builder, cycle-error emit site, etc.). The
   * read consumes the entry so the next throw on the same slot
   * starts clean — the stash is bounded by "one entry per slot",
   * and a long-running slot that throws repeatedly without the
   * host consuming would overwrite the prior entry.
   *
   * @param {number} slot
   * @returns {AttributedRejection|null}
   */
  consumeAttributedRejection(slot) {
    const stash = this._state.attributedRejectionBySlot;
    const entry = stash.get(slot);
    if (entry === undefined) return null;
    stash.delete(slot);
    return entry;
  }

  /**
   * Read the AttributedRejection stashed for `slot` without
   * removing it. Useful for hosts that want to inspect without
   * commitment (e.g. during a debugger probe). Most hosts should
   * use `consumeAttributedRejection` so the entry doesn't linger.
   *
   * @param {number} slot
   * @returns {AttributedRejection|null}
   */
  peekAttributedRejection(slot) {
    const entry = this._state.attributedRejectionBySlot.get(slot);
    return entry === undefined ? null : entry;
  }

  /**
   * Drop any stashed AttributedRejection for `slot`. Called by
   * hosts that want to forget a slot's error state without
   * surfacing it (e.g. when the slot is being freed and the
   * host has already routed the error elsewhere).
   *
   * @param {number} slot
   */
  clearAttributedRejection(slot) {
    this._state.attributedRejectionBySlot.delete(slot);
  }

  /**
   * Idempotent find-or-create for handles. Walks
   * `membrane.enumerateHandles()` and returns the first entry's
   * handle for which `predicate(entry)` is truthy. If no entry
   * matches, calls `factory()` and returns its result.
   *
   * Intended for capability setup that runs on fresh boot and
   * again on snapshot resume: fresh boot mints, resume reuses.
   *
   * @param {(entry: Object) => boolean} predicate
   * @param {() => Handle} factory
   * @returns {Handle}
   */
  ensureHandle(predicate, factory) {
    const entries = this.membrane.enumerateHandles();
    for (const entry of entries) {
      if (predicate(entry)) return entry.handle;
    }
    return factory();
  }

  /**
   * Idempotent find-or-create for grants. Same shape as
   * `ensureHandle` but over `membrane.enumerateGrants()`.
   *
   * @param {(entry: Object) => boolean} predicate
   * @param {() => Grant} factory
   * @returns {Grant}
   */
  ensureGrant(predicate, factory) {
    const entries = this.membrane.enumerateGrants();
    for (const entry of entries) {
      if (predicate(entry)) return entry.grant;
    }
    return factory();
  }

  /**
   * Register a handler for a method on a handle.
   * @param {Handle} handle - Handle wrapper from register()
   * @param {string|null} method - Method name, or null for direct call handler
   * @param {Function} fn - Handler function: ({ args, context }) => result
   * @param {Object} [handlerOptions]
   * @param {'float'} [handlerOptions.coerceExact] - If 'float', coerce
   *   non-integer Rationals to plain JS Numbers before the handler sees
   *   them, and throw a TypeError for Complex args. Intended for handlers
   *   that are intrinsically float-domain (Math.*, canvas pixel coords,
   *   etc.) and have no meaningful exact interpretation.
   * @param {boolean} [handlerOptions.unwrapPromise] - If true and the
   *   handler returns a top-level JS Promise, session.run's loop awaits
   *   the Promise and marshals the resolved value (or throws the rejection)
   *   instead of letting the marshaller link it as an SS Promise. Intended
   *   for handlers that are async only as a JS-internal coordination
   *   detail (e.g. worker→main IPC) and should expose a sync surface to
   *   drone source. Nested Promises inside the resolved value are still
   *   linked by the marshaller — top-level only.
   * @param {number[]} [handlerOptions.retainObjectArgumentIndexes] -
   *   Zero-based indexes of top-level arguments the handler intends to
   *   RETAIN. Before the
   *   handler runs, each named argument that is a vat object becomes its
   *   interned ObjectHandle (a collector root). A function stays a
   *   ClosureHandle, a primitive stays a primitive. The handler must
   *   release each retained object argument it does not store.
   */
  setHandler(handle, method, fn, handlerOptions = {}) {
    const slot = this.membrane.slotOf(handle);
    const key = method === null ? `${slot}` : `${slot}:${method}`;
    this.slotsWithHostRegistrations.add(slot);
    this.handlers.set(key, fn);
    if (handlerOptions && (handlerOptions.coerceExact || handlerOptions.unwrapPromise
        || handlerOptions.heapViewTypedArrays || handlerOptions.retainObjectArgumentIndexes)) {
      const stored = {};
      if (handlerOptions.coerceExact) stored.coerceExact = handlerOptions.coerceExact;
      if (handlerOptions.unwrapPromise) stored.unwrapPromise = true;
      if (handlerOptions.heapViewTypedArrays) stored.heapViewTypedArrays = true;
      if (handlerOptions.retainObjectArgumentIndexes) {
        const indexes = handlerOptions.retainObjectArgumentIndexes;
        if (!Array.isArray(indexes)
            || indexes.some((i) => !Number.isInteger(i) || i < 0)) {
          throw new TypeError(
            'setHandler: retainObjectArgumentIndexes must be an array of non-negative integers');
        }
        stored.retainObjectArgumentIndexes = [...indexes];
      }
      this.handlerOptions.set(key, stored);
    }
  }

  /**
   * @param {string} handlerKey
   * @returns {boolean} - True if this handler was registered with
   *   `unwrapPromise: true`.
   */
  shouldUnwrapPromise(handlerKey) {
    const opts = this.handlerOptions.get(handlerKey);
    return !!(opts && opts.unwrapPromise);
  }

  /**
   * Register a getter for a property on a handle. When sandscript drone
   * code reads `external.propName` (no parentheses), the airlock yields
   * EXIT_EXTERNAL_PROPERTY and dispatches to this function. The return
   * value is marshalled back to drone code.
   *
   * The getter may return:
   *   - a value — marshalled to the drone synchronously
   *   - a Promise — the reading slot is parked via `suspendOnPromise`;
   *     when the Promise settles, the slot resumes with the resolved
   *     value (or throws the rejection)
   *   - a `SuspensionMarker` from `context.suspend(callback)` — the
   *     reading slot is parked; the callback's resolve/reject drives
   *     resume
   *
   * Getters are always-unwrap. There is no opt-in flag (in contrast to
   * `setHandler`'s `unwrapPromise` option) because `obj.foo` and
   * `await obj.foo` are spelled differently in drone code, and the
   * getter has no way to know which form the drone wrote. Drones that
   * don't `await` the read see the resolved value directly; the
   * suspension is invisible from inside the drone except through
   * ordering relative to other operations.
   *
   * Use async getters to match WHATWG/spec contracts where property
   * semantics are part of the contract (e.g., `reader.closed`,
   * `writer.ready`). For host-designed APIs without an external spec,
   * prefer methods — they make the cross-thread boundary explicit at
   * the call site.
   *
   * @param {Handle} handle - Handle wrapper from register()
   * @param {string} propName - Property name
   * @param {Function} fn - Getter: ({ context }) => value | Promise | SuspensionMarker
   */
  setGetter(handle, propName, fn) {
    const slot = this.membrane.slotOf(handle);
    this.slotsWithHostRegistrations.add(slot);
    this.getters.set(`${slot}:${propName}`, fn);
  }

  /**
   * Register a setter for a property on an external handle.
   *
   * The write-side twin of setGetter. When drone code assigns to the
   * property (`external.propName = value`), the interpreter yields
   * EXIT_EXTERNAL_PROPERTY_SET and the host runs `fn({ value, context })`.
   *
   * A property write is fire-and-forget from the drone's view: a plain
   * (sync) setter returns nothing the drone observes, and the slot resumes
   * without parking (the assignment expression evaluates to the assigned
   * value, which the host pushes back). A setter MAY return a Promise or a
   * SuspensionMarker (via context.suspend()) to model a genuinely-async
   * write; the slot then parks until it settles, exactly like an async
   * getter. There is no opt-in flag — `external.x = v` and
   * `await (external.x = v)` are spelled differently in drone code and the
   * setter cannot tell which the drone wrote.
   *
   * A handle that is read-only by design simply registers no setter for the
   * property; assigning to it is a loud error (see handleExternalPropertySet),
   * not a silent drop.
   *
   * @param {Handle} handle - Handle wrapper from register()
   * @param {string} propName - Property name
   * @param {Function} fn - Setter: ({ value, context }) => void | Promise | SuspensionMarker
   */
  setSetter(handle, propName, fn) {
    const slot = this.membrane.slotOf(handle);
    this.slotsWithHostRegistrations.add(slot);
    this.setters.set(`${slot}:${propName}`, fn);
  }

  setDefaultSetter(handle, fn) {
    const slot = this.membrane.slotOf(handle);
    this.slotsWithHostRegistrations.add(slot);
    this.setters.set(`${slot}:*`, fn);
  }

  /**
   * Register a default (fallback) getter for string-key reads that no
   * exact getter covers. Mirrors setDefaultSetter.
   * @param {Handle} handle
   * @param {Function} fn - Getter: ({ name, propName, context }) => value
   */
  setDefaultGetter(handle, fn) {
    const slot = this.membrane.slotOf(handle);
    this.slotsWithHostRegistrations.add(slot);
    this.getters.set(`${slot}:*`, fn);
  }

  /**
   * Register a default (fallback) method handler, invoked with the
   * requested method name and arguments when no exact method handler
   * covers the call. Exact registrations take precedence.
   * The handler reads the requested name from `context.method`.
   */
  setDefaultHandler(handle, fn) {
    const slot = this.membrane.slotOf(handle);
    this.slotsWithHostRegistrations.add(slot);
    this.handlers.set(`${slot}:*`, fn);
  }

  /**
   * Register a synchronous classifier for dynamic external members.
   *
   * The callback receives `{ name, context }` and returns exactly one
   * semantic classification:
   *   - `{ kind: 'absent' }`
   *   - `{ kind: 'data', writable: boolean }`
   *   - `{ kind: 'method' }`
   *
   * Exact getter, handler, and setter registrations take precedence.
   * A dynamic data member uses the default getter and, when writable,
   * the default setter. A dynamic method keeps the external-method
   * binding and exact/default handler dispatch.
   *
   * @param {Handle} handle - Handle wrapper from register()
   * @param {Function} fn - Synchronous member classifier
   */
  setMemberInspector(handle, fn) {
    if (typeof fn !== 'function') {
      throw new TypeError('setMemberInspector: fn must be a function');
    }
    const slot = this.membrane.slotOf(handle);
    this.slotsWithHostRegistrations.add(slot);
    this.memberInspectors.set(slot, fn);
  }

  /**
   * Register the presence probe for branded-instance forwarding: the
   * host must answer "does the backing value have this property?"
   * WITHOUT calling a getter.
   */
  setHasProperty(handle, fn) {
    const slot = this.membrane.slotOf(handle);
    this.slotsWithHostRegistrations.add(slot);
    this.hasPropertyHandlers.set(slot, fn);
  }

  /** Register the deletion handler for branded-instance forwarding. */
  setDeleteProperty(handle, fn) {
    const slot = this.membrane.slotOf(handle);
    this.slotsWithHostRegistrations.add(slot);
    this.deletePropertyHandlers.set(slot, fn);
  }

  /**
   * Register an external handle as constructible. A
   * SandScript class may then extend the handle; `super()` runs the
   * three-phase construction protocol against these handlers.
   *
   * All three handlers are required. A second registration for the
   * same handle throws. The membrane records the registration
   * (HANDLE_FLAG_CONSTRUCTIBLE) so restore can validate that the
   * capability re-registered before resume; the handler functions
   * themselves never persist.
   *
   * `beginConstruction` borrows its `newTarget` ClosureHandle. When
   * `constructClosure` starts from a retained handle, the argument is that
   * exact wrapper and slot/version. The caller keeps ownership and must
   * release the retained handle after construction is no longer needed.
   *
   * @param {Handle} handle
   * @param {{ beginConstruction: Function,
   *           completeConstruction: Function,
   *           abortConstruction: Function,
   *           receiverMetadata?: Function }} handlers
   */
  setConstructible(handle, handlers) {
    const slot = this.membrane.slotOf(handle);
    const {
      beginConstruction,
      completeConstruction,
      abortConstruction,
      receiverMetadata,
    } = handlers ?? {};
    if (typeof beginConstruction !== 'function' ||
        typeof completeConstruction !== 'function' ||
        typeof abortConstruction !== 'function') {
      throw new TypeError(
        'setConstructible: beginConstruction, completeConstruction, and ' +
        'abortConstruction are all required functions');
    }
    if (receiverMetadata !== undefined && typeof receiverMetadata !== 'function') {
      throw new TypeError('setConstructible: receiverMetadata must be a function');
    }
    if (this.constructibleRegistrations.has(slot)) {
      throw new Error(
        `setConstructible: handle slot ${slot} is already registered constructible`);
    }
    this.slotsWithHostRegistrations.add(slot);
    this.constructibleRegistrations.set(slot, {
      beginConstruction,
      completeConstruction,
      abortConstruction,
      receiverMetadata,
    });
    this.membrane.markHandleConstructible(slot);
  }

  /**
   * Read the identifier values currently on a context's grant stack.
   *
   * Returns the unmarshalled value (string, number, object, etc. — whatever
   * the drone wrote at `grant <expr> { ... }`) for each active grant frame.
   * Grant statements are ordered innermost-first. Multiple identifiers from
   * one parenthesized-list grant (`grant ("a", "b") { ... }`) stay together
   * in source order.
   *
   * Used by hosts that want to surface "what scopes did the drone declare
   * for this call?" to capability impls. The grant *ids* (used for
   * authorization) are integers internal to the host; the *identifiers* are
   * what the drone source named.
   *
   * @param {number} contextSlot
   * @returns {unknown[]}
   */
  getActiveGrantIdentifiers(contextSlot) {
    const memoryImage = this.memoryImage;
    const identifiers = [];
    let groupEndIndex = memoryImage.getGrantDepth(contextSlot) - 1;

    while (groupEndIndex >= 0) {
      const groupEndEntry = memoryImage.getGrantEntry(
        contextSlot,
        groupEndIndex,
      );
      let groupStartIndex = groupEndIndex;
      while (groupStartIndex > 0) {
        const precedingEntry = memoryImage.getGrantEntry(
          contextSlot,
          groupStartIndex - 1,
        );
        if (precedingEntry.deniedAddr !== groupEndEntry.deniedAddr
          || precedingEntry.scopePointer !== groupEndEntry.scopePointer
          || precedingEntry.frameDepth !== groupEndEntry.frameDepth) {
          break;
        }
        groupStartIndex--;
      }

      for (let index = groupStartIndex; index <= groupEndIndex; index++) {
        const entry = memoryImage.getGrantEntry(contextSlot, index);
        // Lexical grant frames carry the identifier inline. Callback frames
        // intentionally store null because they have no denied block; their
        // captured grant slot still names the authoritative persisted grant.
        const inlineIdentifier = memoryImage.readValueAt(entry.identifierAddr);
        identifiers.push(inlineIdentifier === null
          ? this.membrane.grantForSlot(entry.grantId).identifier
          : inlineIdentifier);
      }
      groupEndIndex = groupStartIndex - 1;
    }

    return identifiers;
  }

  /**
   * Register multiple handlers for a handle.
   * @param {Handle} handle - Handle wrapper from register()
   * @param {Object} methods - Map of method name → handler function OR
   *   { fn, coerceExact } descriptor.
   */
  setHandlers(handle, methods) {
    for (const [method, value] of Object.entries(methods)) {
      if (typeof value === 'function') {
        this.setHandler(handle, method, value);
      } else {
        this.setHandler(handle, method, value.fn, value);
      }
    }
  }

  // ===========================================================================
  // Execution
  // ===========================================================================

  /**
   * Run a single context until it yields.
   * This is a single-shot execution - no looping, no scheduling.
   * The caller owns the execution loop and decides what to do after each yield.
   *
   * @param {number} contextSlot - Context to run
   * @param {number} fuel - Amount of fuel
   * @returns {{ status: string, fuel: number, error?: any, asyncContext?: {slot:number,generation:number}, promise?: number }}
   */
  runContext(contextSlot, fuel) {
    const mem = this.memoryImage;

    // NOTE on finished slots: re-running a slot at EXIT_DONE continues
    // from the saved pc — that is the APPEND-AND-CONTINUE protocol
    // (parse more code, run again; the pc sits exactly at the append
    // point), so no terminal guard belongs here. The hazard of two
    // drivers running one slot concurrently is caught upstream by
    // session.run's per-slot drive lock.

    // Expire in-flight protection for THIS slot's previous dispatch
    // (its result — if any — is on the heap or in _deferredMarshals by
    // the time the host re-runs the slot) and for detached
    // registrations (consumed synchronously; see the bucket field's
    // comment). Other slots' buckets stay — their parked dispatches
    // may still hold unmarshalled handles inside pending JS promises.
    this._state.inFlightHandleSlotBuckets.delete(contextSlot);
    this._state.inFlightHandleSlotBuckets.delete(null);

    // Record the tick at which this slot was last entered.
    // Used by Debug.dumpContexts / session.state(slot) to surface
    // "when did the host last schedule this slot".
    this._lastTickRunBySlot.set(contextSlot, this.membrane.tick());

    // A previous
    // resumeWithValue / suspend-resolve may have hit
    // HeapPressureSignal and stashed its result for retry. Drain it
    // before running. On success the stash is consumed and the exit
    // condition cleared; the dispatcher resumes normally. On
    // persistent pressure, yield memory_pressure HERE, without
    // running the interpreter: the WAT pressure flag cannot carry
    // this signal (run() clears it at function entry), and running
    // a slot still parked at EXIT_EXTERNAL_CALL would re-dispatch
    // the external call — duplicate handler side effects. The host
    // gcs and re-runs; the next drain attempt then fits (or
    // persists, which the host escalates to OOM).
    if (this._drainDeferredMarshal(contextSlot) === 'pressure') {
      return { status: 'memory_pressure', fuel };
    }

    // Check for grant revocation before executing. This catches the case
    // where the host revoked a grant during a fuel pause — the context
    // would otherwise resume inside the revoked grant block.
    const grantDepth = mem.getGrantDepth(contextSlot);
    if (grantDepth > 0) {
      let hasRevoked = false;
      for (let i = 0; i < grantDepth; i++) {
        const entry = mem.getGrantEntry(contextSlot, i);
        const grant = this.membrane._getGrantById(entry.grantId);
        if (!grant || !grant.active) {
          hasRevoked = true;
          break;
        }
      }
      if (hasRevoked) {
        this.triggerRevocationHandler(contextSlot);
      }
    }

    // Run WASM with the given context
    const remainingFuel = this.wasm.exports.run(fuel, contextSlot);
    const exitCondition = mem.getExitCondition(contextSlot);

    if (exitCondition === EXIT_DONE) {
      return { status: 'done', fuel: remainingFuel };
    }

    if (exitCondition === EXIT_PAUSED_FUEL) {
      return { status: 'paused', fuel: remainingFuel };
    }

    if (exitCondition === EXIT_EXTERNAL_CALL) {
      return { status: 'external_call', fuel: remainingFuel };
    }

    if (exitCondition === EXIT_EXTERNAL_PROPERTY) {
      return { status: 'external_property', fuel: remainingFuel };
    }

    if (exitCondition === EXIT_EXTERNAL_PROPERTY_SET) {
      return { status: 'external_property_set', fuel: remainingFuel };
    }

    if (exitCondition === EXIT_GRANT_REQUEST) {
      return { status: 'grant_request', fuel: remainingFuel };
    }

    if (exitCondition === EXIT_ERROR) {
      const err = mem.getErrorInfo();
      return { status: 'error', fuel: remainingFuel, error: err };
    }

    if (exitCondition === EXIT_ASYNC_CALL) {
      // Return info about the async call so caller can handle it
      const result = this.handleAsyncCall(contextSlot);
      return {
        status: 'async_call',
        fuel: remainingFuel,
        asyncContext: result.asyncContext,
        promise: result.promise,
      };
    }

    if (exitCondition === EXIT_ASYNC_COMPLETE) {
      return { status: 'async_complete', fuel: remainingFuel };
    }

    if (exitCondition === EXIT_ASYNC_REJECTED) {
      return { status: 'async_rejected', fuel: remainingFuel };
    }

    if (exitCondition === EXIT_AWAIT) {
      return { status: 'await', fuel: remainingFuel };
    }

    if (exitCondition === EXIT_PROMISE_METHOD) {
      return { status: 'promise_method', fuel: remainingFuel };
    }

    if (exitCondition === EXIT_PROMISE_SETTLE) {
      return { status: 'promise_settle', fuel: remainingFuel };
    }

    if (exitCondition === EXIT_MEMORY_PRESSURE) {
      // Yield with status 'memory_pressure'. The dispatching opcode
      // (currently OP_ADD's string-concat branch) has NOT consumed its
      // operands and has NOT advanced the instruction pointer — calling
      // run(slot, ...) again re-executes the same op. The runtime decides
      // whether to collect and resume or surface OOM to the drone.
      return { status: 'memory_pressure', fuel: remainingFuel };
    }

    // Generators (INTERNALS.md's Generators section): session.run trampolines these.
    if (exitCondition === EXIT_GENERATOR_CALL) {
      return { status: 'generator_call', fuel: remainingFuel };
    }
    if (exitCondition === EXIT_GENERATOR_NEXT) {
      return { status: 'generator_next', fuel: remainingFuel };
    }
    if (exitCondition === EXIT_GENERATOR_YIELD) {
      return { status: 'generator_yield', fuel: remainingFuel };
    }
    if (exitCondition === EXIT_GENERATOR_COMPLETE) {
      return { status: 'generator_complete', fuel: remainingFuel };
    }
    if (exitCondition === EXIT_GENERATOR_THROW) {
      return { status: 'generator_throw', fuel: remainingFuel };
    }

    // extends-externals: serviced synchronously by session.run.
    if (exitCondition === EXIT_CLASS_LINK_EXTERNAL) {
      return { status: 'class_link_external', fuel: remainingFuel };
    }
    if (exitCondition === EXIT_INSTANCEOF_EXTERNAL) {
      return { status: 'instanceof_external', fuel: remainingFuel };
    }
    if (exitCondition === EXIT_EXTERNAL_HAS_PROPERTY) {
      return { status: 'external_has_property', fuel: remainingFuel };
    }
    if (exitCondition === EXIT_EXTERNAL_DELETE_PROPERTY) {
      return { status: 'external_delete_property', fuel: remainingFuel };
    }

    throw new Error(`Unknown exit condition: ${exitCondition}`);
  }

  // ===========================================================================
  // Async Function Handling
  // ===========================================================================

  /**
   * Handle EXIT_ASYNC_CALL: spawn a new context for an async function.
   *
   * Reads the async request from external_request_base:
   * - closurePointer: the async function closure
   * - argsPointer: pointer to args on caller's pending stack
   * - argCount: number of arguments
   *
   * Creates a new context, sets up the async function call.
   * The promise is created and pushed to the caller's pending stack.
   *
   * @param {number} callerContext - The calling context slot
   * @returns {{ asyncContext: {slot:number,generation:number}, promise: number }}
   */
  handleAsyncCall(callerContext) {
    const mem = this.memoryImage;

    // Read request from external_request_base.
    // Layout (extended for method form):
    //   [closurePointer:4][argsPointer:4][argCount:4]
    //   [receiverType:4][receiverFlags:4][receiverLo:4][receiverHi:4]
    // Method form: receiverType !== TYPE.UNDEFINED — bind `this` in the
    // spawned context's scope, and pop the receiver from the caller's
    // pending stack along with the closure.
    const requestBase = mem.getExternalRequestBase(callerContext);
    const closurePointer = mem.view.getUint32(mem.abs(requestBase), true);
    const argsPointer = mem.view.getUint32(mem.abs(requestBase + 4), true);
    const argCount = mem.view.getUint32(mem.abs(requestBase + 8), true);
    const receiverType = mem.view.getUint32(mem.abs(requestBase + 12), true);
    const receiverFlags = mem.view.getUint32(mem.abs(requestBase + 16), true);
    const receiverLo = mem.view.getUint32(mem.abs(requestBase + 20), true);
    const receiverHi = mem.view.getUint32(mem.abs(requestBase + 24), true);
    const isMethodCall = receiverType !== TYPE.UNDEFINED;

    // Read closure fields
    // Layout: [GC:8][prototype:4][count:4][capacity:4][flags:4][entries:4][sym_entries:4][start_instruction:4][end_instruction:4][scope:4][function_flags:4]
    const startInstruction = mem.view.getUint32(mem.abs(closurePointer + FUNCTION.START_INSTRUCTION), true);
    const capturedScope = mem.view.getUint32(mem.abs(closurePointer + FUNCTION.SCOPE), true);

    // Create the promise that this async function will return
    const promisePointer = mem.createPromise();

    // Allocate a new context for the async function with its own child scope
    const asyncContext = mem.createConfiguredContext({
      scopePointer: capturedScope,
      instructionIndex: startInstruction,
      createChildScope: true,
    });

    // Inherit caller's grants + root grants so the async function body
    // runs with the same authorization scope as the call site.
    const interpreterGrantIds = mem.getActiveGrantIds(callerContext);
    for (const grantId of interpreterGrantIds) {
      mem.pushGrantEntryForCallback(asyncContext, grantId);
    }
    for (const grantId of this.membrane.rootGrantSlots()) {
      mem.pushGrantEntryForCallback(asyncContext, grantId);
    }

    // Bind `this` for method-form async calls. The child scope was
    // created fresh; defining `this` here makes it visible to the body
    // (non-arrow async methods are expected to use it).
    if (isMethodCall) {
      const thisKeyOffset = mem.getBuiltinName(BUILTIN_NAME.THIS);
      mem.scopeSetRaw(mem.getContextScope(asyncContext), thisKeyOffset,
        receiverType, receiverLo, receiverHi);
    }

    // Bind `@newtarget` = undefined for non-arrow callees. Every non-arrow
    // invocation defines the hidden binding (async arrows inherit it
    // lexically, exactly like `this`). An async function is never invoked
    // through `new`, so the value is always undefined here.
    {
      const functionFlags = mem.view.getUint32(mem.abs(closurePointer + FUNCTION.FUNCTION_FLAGS), true);
      if ((functionFlags & CLOSURE_FLAG_ARROW) === 0) {
        mem.scopeSetRaw(mem.getContextScope(asyncContext),
          mem.getBuiltinName(BUILTIN_NAME.NEW_TARGET), TYPE.UNDEFINED, 0, 0);
      }
    }

    // Copy arguments from caller's pending stack to async context's pending stack
    for (let i = 0; i < argCount; i++) {
      const argOffset = argsPointer + i * 16; // VALUE_SIZE = 16
      const argType = mem.view.getUint32(mem.abs(argOffset), true);
      const argFlags = mem.view.getUint32(mem.abs(argOffset + 4), true);
      const argLo = mem.view.getUint32(mem.abs(argOffset + 8), true);
      const argHi = mem.view.getUint32(mem.abs(argOffset + 12), true);

      // Write directly to async context's pending stack
      const pendingPtr = mem.getContextPendingPointer(asyncContext);
      const absPtr = mem.abs(pendingPtr);
      mem.view.setUint32(absPtr, argType, true);
      mem.view.setUint32(absPtr + 4, argFlags, true);
      mem.view.setUint32(absPtr + 8, argLo, true);
      mem.view.setUint32(absPtr + 12, argHi, true);
      mem.setContextPendingPointer(asyncContext, pendingPtr + 16);
    }

    // Push a call frame for the async function
    // The frame's ASYNC_PROMISE field will hold our promise pointer
    mem.pushFrame(
      asyncContext,
      startInstruction,
      mem.getContextScope(asyncContext),
      0,           // astNode
      argCount     // argc — RECONCILE_PARAMS uses this to reshape the pending stack
    );

    // Set the ASYNC_PROMISE field in the frame we just pushed
    const stackPointer = mem.getContextCallStackPointer(asyncContext);
    const framePointer = stackPointer - FRAME_SIZE;
    mem.view.setUint32(mem.abs(framePointer + FRAME.ASYNC_PROMISE), promisePointer, true);

    // Pop the closure (and receiver, for method form) and args from caller's
    // pending stack. Stack layout was either:
    //   [..., closure, arg1, ..., argN]          (OP_CALL)
    //   [..., receiver, closure, arg1, ..., argN] (OP_CALL_METHOD)
    // argsPointer points at arg1; closure is one slot below; for method
    // form receiver is two slots below.
    const slotsBelowArgs = isMethodCall ? 2 : 1;
    const newPendingPointer = argsPointer - slotsBelowArgs * 16;
    mem.setContextPendingPointer(callerContext, newPendingPointer);

    // Push the promise to caller's pending stack
    // Write the promise value directly then advance pending pointer
    const promiseHeaderPointer = promisePointer - GC_HEADER_SIZE;
    const pendingPtr = mem.getContextPendingPointer(callerContext);
    const absPtr = mem.abs(pendingPtr);
    mem.view.setUint32(absPtr, TYPE.PROMISE, true);
    mem.view.setUint32(absPtr + 4, 0, true);
    mem.view.setUint32(absPtr + 8, promiseHeaderPointer, true);
    mem.view.setUint32(absPtr + 12, 0, true);
    mem.setContextPendingPointer(callerContext, pendingPtr + 16); // VALUE_SIZE

    // Caller's exit condition stays as-is (EXIT_ASYNC_CALL) - interpreter
    // will set it appropriately when it resumes

    // Return a generation-bearing identity; this value crosses a scheduling
    // boundary before the caller drives the new context.
    return {
      asyncContext: {
        slot: asyncContext,
        generation: mem.getContextGeneration(asyncContext),
      },
      promise: promisePointer,
    };
  }

  /**
   * Handle EXIT_GENERATOR_CALL (INTERNALS.md's Generators section): calling a function*
   * spawns a generator context parked at the body start and pushes a
   * generator object as the call's result. Mirrors handleAsyncCall minus
   * the promise: same request layout, grant inheritance, `this` binding,
   * and argument copy. All generator state lives in memory (hidden
   * properties on the generator object + CTX_GENERATOR_OBJECT), so parked
   * generators survive snapshot/restore.
   *
   * @param {number} callerContext
   * @returns {{ generatorContext: number, generatorObject: number }}
   */
  handleGeneratorCall(callerContext) {
    const mem = this.memoryImage;

    const requestBase = mem.getExternalRequestBase(callerContext);
    const closurePointer = mem.view.getUint32(mem.abs(requestBase), true);
    const argsPointer = mem.view.getUint32(mem.abs(requestBase + 4), true);
    const argCount = mem.view.getUint32(mem.abs(requestBase + 8), true);
    const receiverType = mem.view.getUint32(mem.abs(requestBase + 12), true);
    const receiverLo = mem.view.getUint32(mem.abs(requestBase + 20), true);
    const receiverHi = mem.view.getUint32(mem.abs(requestBase + 24), true);
    const isMethodCall = receiverType !== TYPE.UNDEFINED;

    const startInstruction = mem.view.getUint32(mem.abs(closurePointer + FUNCTION.START_INSTRUCTION), true);
    const capturedScope = mem.view.getUint32(mem.abs(closurePointer + FUNCTION.SCOPE), true);
    // Async generators (async function*) carry CLOSURE_FLAG_ASYNC in
    // addition to the generator flag; they spawn the same way but get
    // the promise-based protocol shape below.
    const functionFlags = mem.view.getUint32(mem.abs(closurePointer + FUNCTION.FUNCTION_FLAGS), true);
    const isAsync = (functionFlags & CLOSURE_FLAG_ASYNC) !== 0;

    const generatorContext = mem.createConfiguredContext({
      scopePointer: capturedScope,
      instructionIndex: startInstruction,
      createChildScope: true,
    });

    // Same authorization scope as the call site.
    for (const grantId of mem.getActiveGrantIds(callerContext)) {
      mem.pushGrantEntryForCallback(generatorContext, grantId);
    }
    for (const grantId of this.membrane.rootGrantSlots()) {
      mem.pushGrantEntryForCallback(generatorContext, grantId);
    }

    if (isMethodCall) {
      const thisKeyOffset = mem.getBuiltinName(BUILTIN_NAME.THIS);
      mem.scopeSetRaw(mem.getContextScope(generatorContext), thisKeyOffset,
        receiverType, receiverLo, receiverHi);
    }

    // Bind `@newtarget` = undefined for non-arrow callees (see the async
    // twin above). A generator is never invoked through `new`.
    if ((functionFlags & CLOSURE_FLAG_ARROW) === 0) {
      mem.scopeSetRaw(mem.getContextScope(generatorContext),
        mem.getBuiltinName(BUILTIN_NAME.NEW_TARGET), TYPE.UNDEFINED, 0, 0);
    }

    // Arguments wait on the generator's pending stack for the first
    // next() to run RECONCILE_PARAMS.
    for (let i = 0; i < argCount; i++) {
      const argOffset = argsPointer + i * 16;
      const pendingPtr = mem.getContextPendingPointer(generatorContext);
      const absPtr = mem.abs(pendingPtr);
      mem.view.setUint32(absPtr, mem.view.getUint32(mem.abs(argOffset), true), true);
      mem.view.setUint32(absPtr + 4, mem.view.getUint32(mem.abs(argOffset + 4), true), true);
      mem.view.setUint32(absPtr + 8, mem.view.getUint32(mem.abs(argOffset + 8), true), true);
      mem.view.setUint32(absPtr + 12, mem.view.getUint32(mem.abs(argOffset + 12), true), true);
      mem.setContextPendingPointer(generatorContext, pendingPtr + 16);
    }

    mem.pushFrame(
      generatorContext,
      startInstruction,
      mem.getContextScope(generatorContext),
      0,           // astNode
      argCount
    );

    // The generator object: hidden state (context slot + 1 so 0 means
    // completed; state 0 start / 1 yield / 2 running / 3 completed;
    // caller slot + 1 so 0 means none) plus the protocol methods.
    // Async generators swap the parked-caller key for the step-promise /
    // request-queue pair (their callers never park — the step-promise
    // key's PRESENCE is the async marker) and expose Symbol.asyncIterator
    // instead of Symbol.iterator, so sync-protocol drivers (for-of,
    // spread, seed drivers) correctly reject them as not iterable.
    const generatorObject = mem.allocateObject(8);
    mem.objectSetRaw(generatorObject,
      mem.getBuiltinName(BUILTIN_NAME.GENERATOR_CONTEXT_KEY), TYPE.INTEGER, generatorContext + 1, 0);
    mem.objectSetRaw(generatorObject,
      mem.getBuiltinName(BUILTIN_NAME.GENERATOR_STATE_KEY), TYPE.INTEGER, 0, 0);
    if (isAsync) {
      mem.objectSetRaw(generatorObject,
        mem.getBuiltinName(BUILTIN_NAME.ASYNC_GENERATOR_STEP_PROMISE_KEY), TYPE.INTEGER, 0, 0);
      mem.objectSetRaw(generatorObject,
        mem.getBuiltinName(BUILTIN_NAME.ASYNC_GENERATOR_QUEUE_KEY), TYPE.INTEGER, 0, 0);
    } else {
      mem.objectSetRaw(generatorObject,
        mem.getBuiltinName(BUILTIN_NAME.GENERATOR_CALLER_KEY), TYPE.INTEGER, 0, 0);
    }
    mem.objectSetBoundMethodWithReceiverType(generatorObject,
      mem.getBuiltinName(BUILTIN_NAME.ITER_NEXT_KEY), generatorObject, METHOD.GENERATOR_NEXT, TYPE.OBJECT);
    mem.objectSetBoundMethodWithReceiverType(generatorObject,
      mem.getBuiltinName(BUILTIN_NAME.RETURN_KEY), generatorObject, METHOD.GENERATOR_RETURN, TYPE.OBJECT);
    mem.objectSetBoundMethodWithReceiverType(generatorObject,
      mem.getBuiltinName(BUILTIN_NAME.THROW_KEY), generatorObject, METHOD.GENERATOR_THROW, TYPE.OBJECT);
    mem.objectSetSymbolKey(generatorObject,
      mem.getState(isAsync
        ? STATE.WELL_KNOWN_ASYNC_ITERATOR_SYMBOL
        : STATE.WELL_KNOWN_ITERATOR_SYMBOL),
      TYPE.BOUND_METHOD, generatorObject, METHOD.GENERATOR_SELF);

    mem.setContextGeneratorObject(generatorContext, generatorObject);

    // Pop the closure (and receiver) + args from the caller; push the
    // generator object as the call's result.
    const slotsBelowArgs = isMethodCall ? 2 : 1;
    mem.setContextPendingPointer(callerContext, argsPointer - slotsBelowArgs * 16);
    const pendingPtr = mem.getContextPendingPointer(callerContext);
    const absPtr = mem.abs(pendingPtr);
    mem.view.setUint32(absPtr, TYPE.OBJECT, true);
    mem.view.setUint32(absPtr + 4, 0, true);
    mem.view.setUint32(absPtr + 8, generatorObject, true);
    mem.view.setUint32(absPtr + 12, 0, true);
    mem.setContextPendingPointer(callerContext, pendingPtr + 16);

    return { generatorContext, generatorObject };
  }

  /**
   * Handle EXIT_GENERATOR_NEXT: the caller invoked gen.next / gen.return /
   * gen.throw (operation 0 / 1 / 2 in the request). Settled cases (dead
   * generator, protocol errors, return/throw at suspended-start) prepare
   * the caller immediately; otherwise the generator context is prepared
   * and the caller stays parked (its EXIT_GENERATOR_NEXT doubles as the
   * waiting marker resolveActiveGeneratorSlot follows).
   *
   * @param {number} callerContext
   * @returns {{ settled: boolean, generatorContext?: number }}
   */
  handleGeneratorRequest(callerContext) {
    const mem = this.memoryImage;

    const requestBase = mem.getExternalRequestBase(callerContext);
    const generatorObject = mem.view.getUint32(mem.abs(requestBase), true);
    const operation = mem.view.getUint32(mem.abs(requestBase + 4), true);
    const argType = mem.view.getUint32(mem.abs(requestBase + 8), true);
    const argFlags = mem.view.getUint32(mem.abs(requestBase + 12), true);
    const argLo = mem.view.getUint32(mem.abs(requestBase + 16), true);
    const argHi = mem.view.getUint32(mem.abs(requestBase + 20), true);

    const contextKey = mem.getBuiltinName(BUILTIN_NAME.GENERATOR_CONTEXT_KEY);
    const stateKey = mem.getBuiltinName(BUILTIN_NAME.GENERATOR_STATE_KEY);
    const callerKey = mem.getBuiltinName(BUILTIN_NAME.GENERATOR_CALLER_KEY);

    const contextProp = mem.objectFindOwnProperty(generatorObject, contextKey);
    if (!contextProp) {
      this._createAndPushErrorWithPressureRecovery(callerContext,
        STATE.TYPE_ERROR_PROTOTYPE, 'not a generator object');
      mem.setResponseType(callerContext, RESPONSE_THROW);
      mem.clearExitCondition(callerContext);
      return { settled: true };
    }

    const stepPromiseProp = mem.objectFindOwnProperty(generatorObject,
      mem.getBuiltinName(BUILTIN_NAME.ASYNC_GENERATOR_STEP_PROMISE_KEY));
    if (stepPromiseProp) {
      // Async generator: the caller gets a step promise immediately and
      // never parks. An idle generator services the request now (which
      // may resume its context through the spawn queue); an in-flight
      // one queues it (spec AsyncGeneratorEnqueue — where async
      // generators differ from sync's "already running" TypeError).
      const stepPromisePointer = mem.createPromise();
      this._pushValueToContext(callerContext, TYPE.PROMISE, 0,
        stepPromisePointer - GC_HEADER_SIZE, 0);
      mem.clearExitCondition(callerContext);

      const state = mem.objectFindOwnProperty(generatorObject, stateKey).lo;
      if (state === 2) {
        const request = mem.allocateObject(4);
        mem.objectSetRaw(request,
          mem.getBuiltinName(BUILTIN_NAME.REQUEST_OPERATION_KEY), TYPE.INTEGER, operation, 0);
        mem.objectSetRawWithFlags(request,
          mem.getBuiltinName(BUILTIN_NAME.REQUEST_VALUE_KEY), argType, argFlags, argLo, argHi);
        mem.objectSetRaw(request,
          mem.getBuiltinName(BUILTIN_NAME.REQUEST_PROMISE_KEY), TYPE.PROMISE,
          stepPromisePointer - GC_HEADER_SIZE, 0);
        mem.objectSetRaw(request,
          mem.getBuiltinName(BUILTIN_NAME.REQUEST_NEXT_KEY), TYPE.INTEGER, 0, 0);
        const queueKey = mem.getBuiltinName(BUILTIN_NAME.ASYNC_GENERATOR_QUEUE_KEY);
        const nextKey = mem.getBuiltinName(BUILTIN_NAME.REQUEST_NEXT_KEY);
        const headProp = mem.objectFindOwnProperty(generatorObject, queueKey);
        if (headProp.type !== TYPE.OBJECT) {
          mem.objectUpdateProperty(generatorObject, queueKey, TYPE.OBJECT, request, 0);
        } else {
          let tail = headProp.lo;
          for (let linkProp = mem.objectFindOwnProperty(tail, nextKey);
               linkProp.type === TYPE.OBJECT;
               linkProp = mem.objectFindOwnProperty(tail, nextKey)) {
            tail = linkProp.lo;
          }
          mem.objectUpdateProperty(tail, nextKey, TYPE.OBJECT, request, 0);
        }
      } else {
        this._serviceAsyncGeneratorRequest(generatorObject, operation,
          argType, argFlags, argLo, argHi, stepPromisePointer, callerContext);
      }
      return { settled: true };
    }

    const state = mem.objectFindOwnProperty(generatorObject, stateKey).lo;

    if (state === 3 || contextProp.lo === 0) {
      // Completed generator: next → { undefined, true }; return(v) →
      // { v, true }; throw(e) → rethrow in the caller.
      if (operation === 2) {
        this._pushValueToContext(callerContext, argType, argFlags, argLo, argHi);
        mem.setResponseType(callerContext, RESPONSE_THROW);
      } else if (operation === 1) {
        this._pushGeneratorStep(callerContext, argType, argFlags, argLo, argHi, true);
      } else {
        this._pushGeneratorStep(callerContext, TYPE.UNDEFINED, 0, 0, 0, true);
      }
      mem.clearExitCondition(callerContext);
      return { settled: true };
    }

    if (state === 2) {
      this._createAndPushErrorWithPressureRecovery(callerContext,
        STATE.TYPE_ERROR_PROTOTYPE, 'Generator is already running');
      mem.setResponseType(callerContext, RESPONSE_THROW);
      mem.clearExitCondition(callerContext);
      return { settled: true };
    }

    const generatorContext = contextProp.lo - 1;

    if (state === 0 && operation === 1) {
      // return(v) before the body ever ran: complete without executing.
      this._completeGenerator(generatorObject, generatorContext);
      this._pushGeneratorStep(callerContext, argType, argFlags, argLo, argHi, true);
      mem.clearExitCondition(callerContext);
      return { settled: true };
    }
    if (state === 0 && operation === 2) {
      // throw(e) before the body ever ran: the generator dies and the
      // exception surfaces at the call site.
      this._completeGenerator(generatorObject, generatorContext);
      this._pushValueToContext(callerContext, argType, argFlags, argLo, argHi);
      mem.setResponseType(callerContext, RESPONSE_THROW);
      mem.clearExitCondition(callerContext);
      return { settled: true };
    }

    if (state === 1) {
      // Parked at a yield: the pushed value becomes the yield
      // expression's result (next), the pending return value
      // (RESPONSE_RETURN — body finallys run), or the thrown exception
      // (RESPONSE_THROW — catchable by the body).
      this._pushValueToContext(generatorContext, argType, argFlags, argLo, argHi);
      if (operation === 1) {
        mem.setResponseType(generatorContext, RESPONSE_RETURN);
      } else if (operation === 2) {
        mem.setResponseType(generatorContext, RESPONSE_THROW);
      }
    }
    // state 0 + next(): the spawn already staged the arguments; the body
    // just runs from the top.

    mem.objectUpdateProperty(generatorObject, stateKey, TYPE.INTEGER, 2, 0);
    mem.objectUpdateProperty(generatorObject, callerKey, TYPE.INTEGER, callerContext + 1, 0);

    return { settled: false, generatorContext };
  }

  /**
   * Handle EXIT_GENERATOR_YIELD / _COMPLETE / _THROW from a generator
   * context: settle the parked caller with the step object (or the
   * rethrown exception) and hand back its slot.
   *
   * @param {number} generatorContext
   * @param {string} status - 'generator_yield' | 'generator_complete' | 'generator_throw'
   * @returns {{ callerContext: number }}
   */
  handleGeneratorSettle(generatorContext, status) {
    const mem = this.memoryImage;
    const generatorObject = mem.getContextGeneratorObject(generatorContext);
    const stateKey = mem.getBuiltinName(BUILTIN_NAME.GENERATOR_STATE_KEY);

    const stepPromiseProp = mem.objectFindOwnProperty(generatorObject,
      mem.getBuiltinName(BUILTIN_NAME.ASYNC_GENERATOR_STEP_PROMISE_KEY));
    if (stepPromiseProp) {
      // Async generator: settle the in-service step promise; woken
      // waiters and any resumed context reach the host through the
      // spawn queue. There is no parked caller to hand back — a yield
      // parks this slot until the next request wakes it; completion is
      // terminal for the slot (the driving host owns its free).
      const stepPromiseKey = mem.getBuiltinName(BUILTIN_NAME.ASYNC_GENERATOR_STEP_PROMISE_KEY);
      const stepPromisePointer = stepPromiseProp.lo + GC_HEADER_SIZE;
      mem.objectUpdateProperty(generatorObject, stepPromiseKey, TYPE.INTEGER, 0, 0);

      if (status === 'generator_yield') {
        const pendingPtr = mem.getContextPendingPointer(generatorContext) - 16;
        const absPtr = mem.abs(pendingPtr);
        const valueType = mem.view.getUint32(absPtr, true);
        const valueFlags = mem.view.getUint32(absPtr + 4, true);
        const valueLo = mem.view.getUint32(absPtr + 8, true);
        const valueHi = mem.view.getUint32(absPtr + 12, true);
        mem.setContextPendingPointer(generatorContext, pendingPtr);
        mem.objectUpdateProperty(generatorObject, stateKey, TYPE.INTEGER, 1, 0);
        this._resolveStepPromise(stepPromisePointer, valueType, valueFlags, valueLo, valueHi, false);
      } else if (status === 'generator_complete') {
        const pendingPtr = mem.getContextPendingPointer(generatorContext) - 16;
        const absPtr = mem.abs(pendingPtr);
        const valueType = mem.view.getUint32(absPtr, true);
        const valueFlags = mem.view.getUint32(absPtr + 4, true);
        const valueLo = mem.view.getUint32(absPtr + 8, true);
        const valueHi = mem.view.getUint32(absPtr + 12, true);
        this._completeGenerator(generatorObject, generatorContext, { freeSlot: false });
        this._resolveStepPromise(stepPromisePointer, valueType, valueFlags, valueLo, valueHi, true);
      } else {
        // generator_throw: exception in the completion slot.
        const valueAddr = mem.getContextCompletionValue(generatorContext);
        const absValue = mem.abs(valueAddr);
        const valueType = mem.view.getUint32(absValue, true);
        const valueFlags = mem.view.getUint32(absValue + 4, true);
        const valueLo = mem.view.getUint32(absValue + 8, true);
        const valueHi = mem.view.getUint32(absValue + 12, true);
        this._completeGenerator(generatorObject, generatorContext, { freeSlot: false });
        this._rejectStepPromise(stepPromisePointer, valueType, valueFlags, valueLo, valueHi, generatorContext);
      }

      // Drain now-serviceable queued requests. Immediate settles (the
      // generator just completed) keep draining; a resume puts the
      // generator back in flight and the NEXT settle continues here.
      const queueKey = mem.getBuiltinName(BUILTIN_NAME.ASYNC_GENERATOR_QUEUE_KEY);
      const nextKey = mem.getBuiltinName(BUILTIN_NAME.REQUEST_NEXT_KEY);
      while (true) {
        const headProp = mem.objectFindOwnProperty(generatorObject, queueKey);
        if (headProp.type !== TYPE.OBJECT) break;
        const request = headProp.lo;
        const linkProp = mem.objectFindOwnProperty(request, nextKey);
        mem.objectUpdateProperty(generatorObject, queueKey, linkProp.type, linkProp.lo, linkProp.hi);
        const requestOperation = mem.objectFindOwnProperty(request,
          mem.getBuiltinName(BUILTIN_NAME.REQUEST_OPERATION_KEY)).lo;
        const requestValue = mem.objectFindOwnProperty(request,
          mem.getBuiltinName(BUILTIN_NAME.REQUEST_VALUE_KEY));
        const requestPromise = mem.objectFindOwnProperty(request,
          mem.getBuiltinName(BUILTIN_NAME.REQUEST_PROMISE_KEY));
        this._serviceAsyncGeneratorRequest(generatorObject, requestOperation,
          requestValue.type, requestValue.flags, requestValue.lo, requestValue.hi,
          requestPromise.lo + GC_HEADER_SIZE, generatorContext);
        if (mem.objectFindOwnProperty(generatorObject, stateKey).lo === 2) break;
      }

      return { asyncGenerator: true, terminal: status !== 'generator_yield' };
    }

    const callerKey = mem.getBuiltinName(BUILTIN_NAME.GENERATOR_CALLER_KEY);
    const callerContext = mem.objectFindOwnProperty(generatorObject, callerKey).lo - 1;
    mem.objectUpdateProperty(generatorObject, callerKey, TYPE.INTEGER, 0, 0);

    if (status === 'generator_yield') {
      // Yielded value on the generator's pending stack top.
      const pendingPtr = mem.getContextPendingPointer(generatorContext) - 16;
      const absPtr = mem.abs(pendingPtr);
      const valueType = mem.view.getUint32(absPtr, true);
      const valueFlags = mem.view.getUint32(absPtr + 4, true);
      const valueLo = mem.view.getUint32(absPtr + 8, true);
      const valueHi = mem.view.getUint32(absPtr + 12, true);
      mem.setContextPendingPointer(generatorContext, pendingPtr);
      mem.objectUpdateProperty(generatorObject, stateKey, TYPE.INTEGER, 1, 0);
      this._pushGeneratorStep(callerContext, valueType, valueFlags, valueLo, valueHi, false);
      return { callerContext };
    }

    if (status === 'generator_complete') {
      const pendingPtr = mem.getContextPendingPointer(generatorContext) - 16;
      const absPtr = mem.abs(pendingPtr);
      const valueType = mem.view.getUint32(absPtr, true);
      const valueFlags = mem.view.getUint32(absPtr + 4, true);
      const valueLo = mem.view.getUint32(absPtr + 8, true);
      const valueHi = mem.view.getUint32(absPtr + 12, true);
      this._completeGenerator(generatorObject, generatorContext);
      this._pushGeneratorStep(callerContext, valueType, valueFlags, valueLo, valueHi, true);
      return { callerContext };
    }

    // generator_throw: exception in the generator's completion slot.
    const valueAddr = mem.getContextCompletionValue(generatorContext);
    const absValue = mem.abs(valueAddr);
    const valueType = mem.view.getUint32(absValue, true);
    const valueFlags = mem.view.getUint32(absValue + 4, true);
    const valueLo = mem.view.getUint32(absValue + 8, true);
    const valueHi = mem.view.getUint32(absValue + 12, true);
    this._completeGenerator(generatorObject, generatorContext);
    this._pushValueToContext(callerContext, valueType, valueFlags, valueLo, valueHi);
    mem.setResponseType(callerContext, RESPONSE_THROW);
    return { callerContext };
  }

  /**
   * Mark a generator completed and release its context slot.
   *
   * freeSlot: false for async-generator completions that arrive through
   * a settle — the host is mid-drive on that very slot and owns its
   * free (exactly like async-function contexts); freeing here would
   * double-free when the drive ends. Suspended-start completions (a
   * return()/throw() before the body ever ran) keep the default: no
   * host ever drove that slot, so the airlock is its only owner.
   */
  _completeGenerator(generatorObject, generatorContext, { freeSlot = true } = {}) {
    const mem = this.memoryImage;
    mem.objectUpdateProperty(generatorObject,
      mem.getBuiltinName(BUILTIN_NAME.GENERATOR_STATE_KEY), TYPE.INTEGER, 3, 0);
    mem.objectUpdateProperty(generatorObject,
      mem.getBuiltinName(BUILTIN_NAME.GENERATOR_CONTEXT_KEY), TYPE.INTEGER, 0, 0);
    mem.setContextGeneratorObject(generatorContext, 0);
    if (freeSlot) {
      const generation = mem.getContextGeneration(generatorContext);
      this.freeContext(generatorContext, generation);
    }
  }

  /**
   * Service one async-generator request (operation 0 next / 1 return /
   * 2 throw) against an IDLE generator — state 0, 1, or 3, never 2:
   * requests that arrive while a service is in flight sit in the queue
   * until the settle drains them. Dead-generator and suspended-start
   * abrupt cases settle the step promise directly; everything else
   * stages the resume exactly like the sync protocol and hands the
   * generator context to the host through the spawn queue.
   *
   * originSlot is diagnostics-only: it attributes an unconsumed
   * rejection on the unhandled watchlist.
   */
  _serviceAsyncGeneratorRequest(generatorObject, operation, argType, argFlags, argLo, argHi, stepPromisePointer, originSlot) {
    const mem = this.memoryImage;
    const stateKey = mem.getBuiltinName(BUILTIN_NAME.GENERATOR_STATE_KEY);
    const contextProp = mem.objectFindOwnProperty(generatorObject,
      mem.getBuiltinName(BUILTIN_NAME.GENERATOR_CONTEXT_KEY));
    const state = mem.objectFindOwnProperty(generatorObject, stateKey).lo;

    if (state === 3 || contextProp.lo === 0) {
      // Completed generator: next → { undefined, true }; return(v) →
      // { v, true }; throw(e) → the step promise rejects with e.
      if (operation === 2) {
        this._rejectStepPromise(stepPromisePointer, argType, argFlags, argLo, argHi, originSlot);
      } else if (operation === 1) {
        this._resolveStepPromise(stepPromisePointer, argType, argFlags, argLo, argHi, true);
      } else {
        this._resolveStepPromise(stepPromisePointer, TYPE.UNDEFINED, 0, 0, 0, true);
      }
      return;
    }

    const generatorContext = contextProp.lo - 1;

    if (state === 0 && operation === 1) {
      // return(v) before the body ever ran: complete without executing.
      this._completeGenerator(generatorObject, generatorContext);
      this._resolveStepPromise(stepPromisePointer, argType, argFlags, argLo, argHi, true);
      return;
    }
    if (state === 0 && operation === 2) {
      // throw(e) before the body ever ran: the generator dies and the
      // step promise rejects.
      this._completeGenerator(generatorObject, generatorContext);
      this._rejectStepPromise(stepPromisePointer, argType, argFlags, argLo, argHi, originSlot);
      return;
    }

    if (state === 1) {
      // Parked at a yield: same resume staging as the sync protocol —
      // the pushed value becomes the yield expression's result (next),
      // the pending return value (RESPONSE_RETURN — body finallys run),
      // or the thrown exception (RESPONSE_THROW — catchable).
      this._pushValueToContext(generatorContext, argType, argFlags, argLo, argHi);
      if (operation === 1) {
        mem.setResponseType(generatorContext, RESPONSE_RETURN);
      } else if (operation === 2) {
        mem.setResponseType(generatorContext, RESPONSE_THROW);
      }
    }
    // state 0 + next(): the spawn already staged the arguments; the body
    // just runs from the top.

    mem.objectUpdateProperty(generatorObject, stateKey, TYPE.INTEGER, 2, 0);
    mem.objectUpdateProperty(generatorObject,
      mem.getBuiltinName(BUILTIN_NAME.ASYNC_GENERATOR_STEP_PROMISE_KEY),
      TYPE.PROMISE, stepPromisePointer - GC_HEADER_SIZE, 0);
    this._enqueueSpawnedContexts([{
      slot: generatorContext,
      generation: mem.getContextGeneration(generatorContext),
    }]);
  }

  /**
   * Resolve an async-generator step promise with a fresh { value, done }
   * step object; woken waiters and .then handler contexts reach the
   * host through the spawn queue.
   */
  _resolveStepPromise(promisePointer, valueType, valueFlags, valueLo, valueHi, done) {
    const mem = this.memoryImage;
    const stepObject = mem.allocateObject(2);
    mem.objectSetRawWithFlags(stepObject,
      mem.getBuiltinName(BUILTIN_NAME.ITER_VALUE_KEY), valueType, valueFlags, valueLo, valueHi);
    mem.objectSetRaw(stepObject,
      mem.getBuiltinName(BUILTIN_NAME.ITER_DONE_KEY), TYPE.BOOLEAN, done ? 1 : 0, 0);
    mem.setPromiseStatus(promisePointer, PROMISE_STATUS_RESOLVED);
    mem.setPromiseValue(promisePointer, TYPE.OBJECT, 0, stepObject, 0);
    const waiters = mem.popAllWaiters(promisePointer);
    for (const waiterIdentity of waiters) { this._prepareWaiter(waiterIdentity.slot, waiterIdentity.generation, promisePointer, PROMISE_STATUS_RESOLVED,
      { type: TYPE.OBJECT, flags: 0, lo: stepObject, hi: 0 }); }
    const handlerContexts = this.processHandlers(promisePointer);
    this._enqueueSpawnedContexts([...waiters, ...handlerContexts]);
  }

  /**
   * Reject an async-generator step promise (an uncaught throw out of
   * the body, or a throw() request against a dead / suspended-start
   * generator). With no waiter or handler to consume it, the rejection
   * joins the unhandled watchlist like any async rejection; a later
   * await that consumes it removes the entry (handleAwait).
   */
  _rejectStepPromise(promisePointer, valueType, valueFlags, valueLo, valueHi, originSlot) {
    const mem = this.memoryImage;
    mem.setPromiseStatus(promisePointer, PROMISE_STATUS_REJECTED);
    mem.setPromiseValue(promisePointer, valueType, valueFlags, valueLo, valueHi);
    const value = { type: valueType, flags: valueFlags, lo: valueLo, hi: valueHi };
    const waiters = mem.popAllWaiters(promisePointer);
    for (const waiterIdentity of waiters) { this._prepareWaiter(waiterIdentity.slot, waiterIdentity.generation, promisePointer, PROMISE_STATUS_REJECTED, value); }
    const handlerContexts = this.processHandlers(promisePointer);
    if (waiters.length === 0 && handlerContexts.length === 0) {
      let rejectionValue = undefined;
      try {
        rejectionValue = mem.readValueAt(promisePointer + PROMISE.VALUE);
      } catch (_) {}
      this._state.pendingUnhandledRejections.set(promisePointer, {
        slot: originSlot ?? 0,
        value: rejectionValue,
      });
    }
    this._enqueueSpawnedContexts([...waiters, ...handlerContexts]);
  }

  /**
   * Push a raw value quad onto a context's pending stack.
   */
  _pushValueToContext(contextSlot, type, flags, lo, hi) {
    const mem = this.memoryImage;
    const pendingPtr = mem.getContextPendingPointer(contextSlot);
    const absPtr = mem.abs(pendingPtr);
    mem.view.setUint32(absPtr, type, true);
    mem.view.setUint32(absPtr + 4, flags, true);
    mem.view.setUint32(absPtr + 8, lo, true);
    mem.view.setUint32(absPtr + 12, hi, true);
    mem.setContextPendingPointer(contextSlot, pendingPtr + 16);
  }

  /**
   * Build a { value, done } step object and push it onto a context's
   * pending stack.
   */
  _pushGeneratorStep(contextSlot, valueType, valueFlags, valueLo, valueHi, done) {
    const mem = this.memoryImage;
    const stepObject = mem.allocateObject(2);
    mem.objectSetRawWithFlags(stepObject,
      mem.getBuiltinName(BUILTIN_NAME.ITER_VALUE_KEY), valueType, valueFlags, valueLo, valueHi);
    mem.objectSetRaw(stepObject,
      mem.getBuiltinName(BUILTIN_NAME.ITER_DONE_KEY), TYPE.BOOLEAN, done ? 1 : 0, 0);
    this._pushValueToContext(contextSlot, TYPE.OBJECT, 0, stepObject, 0);
  }

  /**
   * Follow a parked next()-caller chain to the innermost slot that is
   * actually runnable, so a host that re-runs the ORIGINAL slot after a
   * suspension inside a generator body lands on the right context.
   */
  resolveActiveGeneratorSlot(slot) {
    const mem = this.memoryImage;
    const contextKey = mem.getBuiltinName(BUILTIN_NAME.GENERATOR_CONTEXT_KEY);
    const stateKey = mem.getBuiltinName(BUILTIN_NAME.GENERATOR_STATE_KEY);
    let current = slot;
    for (let depth = 0; depth < 1024; depth++) {
      if (mem.getExitCondition(current) !== EXIT_GENERATOR_NEXT) return current;
      const requestBase = mem.getExternalRequestBase(current);
      const generatorObject = mem.view.getUint32(mem.abs(requestBase), true);
      const contextProp = mem.objectFindOwnProperty(generatorObject, contextKey);
      if (!contextProp || contextProp.lo === 0) return current;
      const state = mem.objectFindOwnProperty(generatorObject, stateKey).lo;
      if (state !== 2) return current;
      current = contextProp.lo - 1;
    }
    return current;
  }

  /**
   * Handle EXIT_ASYNC_COMPLETE: async function returned normally.
   *
   * Resolves the promise and prepares all waiters with the resolved value.
   * Waiters are returned ready to run — caller only decides scheduling.
   *
   * @param {number} contextSlot - The completing async context
   * @returns {{ promise: number, waiters: {slot:number,generation:number}[] }}
   */
  handleAsyncComplete(contextSlot) {
    const mem = this.memoryImage;

    // Get the async frame's ASYNC_PROMISE
    // bit 0: isFinally, bit 1: original was rejected
    //
    // The async frame is the BASE frame of the context (every async body
    // runs in its own spawned context, so frame 0 is the async fn's own
    // frame) — read it there, matching the WAT's own dispatch reads. At
    // EXIT_ASYNC_COMPLETE the WAT guarantees base == top (it only yields
    // on the last frame's return), but at EXIT_ASYNC_REJECTED the throw
    // unwind does NOT pop plain frames above the async frame. A capability
    // call parked inside a synchronous helper can resume with a throw while
    // that helper's frame is still on top. Reading the top frame would find
    // the wrong ASYNC_PROMISE field, potentially writing the rejection into
    // the segment header and walking garbage waiter slots.
    const stackPointer = mem.getContextCallStackPointer(contextSlot);
    this._assertAsyncFrameReadable('handleAsyncComplete', contextSlot, stackPointer);
    const framePointer = mem.getCallStackBase(contextSlot);
    const asyncPromiseField = mem.view.getUint32(mem.abs(framePointer + FRAME.ASYNC_PROMISE), true);
    const isFinally = (asyncPromiseField & 1) !== 0;
    const originalWasRejected = (asyncPromiseField & 2) !== 0;
    const promisePointer = asyncPromiseField & ~3;  // mask off flag bits 0-1
    mem.assertPromiseAt(promisePointer, `handleAsyncComplete(slot ${contextSlot})`);

    // Executor contexts (from new Promise(executor)): return value is always ignored.
    // Promise was either already settled by resolve/reject, or stays pending.
    if (this._state.executorContexts.has(contextSlot)) {
      this._state.executorContexts.delete(contextSlot);
      return { promise: promisePointer, waiters: [] };
    }

    // Pop the return value from pending stack
    const pendingPointer = mem.getContextPendingPointer(contextSlot);
    const valuePointer = pendingPointer - 16;
    const returnType = mem.view.getUint32(mem.abs(valuePointer), true);
    const returnFlags = mem.view.getUint32(mem.abs(valuePointer + 4), true);
    const returnLo = mem.view.getUint32(mem.abs(valuePointer + 8), true);
    const returnHi = mem.view.getUint32(mem.abs(valuePointer + 12), true);

    let resolveType, resolveFlags, resolveLo, resolveHi;
    let resolveStatus;

    if (isFinally) {
      // Finally handler: use the stashed original value, not the return value
      const originalValue = mem.getPromiseValue(promisePointer);
      resolveType = originalValue.type;
      resolveFlags = originalValue.flags;
      resolveLo = originalValue.lo;
      resolveHi = originalValue.hi;
      resolveStatus = originalWasRejected ? PROMISE_STATUS_REJECTED : PROMISE_STATUS_RESOLVED;
    } else {
      resolveType = returnType;
      resolveFlags = returnFlags;
      resolveLo = returnLo;
      resolveHi = returnHi;
      resolveStatus = PROMISE_STATUS_RESOLVED;
    }

    // Settle the promise
    mem.setPromiseStatus(promisePointer, resolveStatus);
    mem.setPromiseValue(promisePointer, resolveType, resolveFlags, resolveLo, resolveHi);

    // Pop waiters and prepare them
    const waiters = mem.popAllWaiters(promisePointer);
    for (const waiterIdentity of waiters) { this._prepareWaiter(waiterIdentity.slot, waiterIdentity.generation, promisePointer, resolveStatus,
      { type: resolveType, flags: resolveFlags, lo: resolveLo, hi: resolveHi }); }

    // Process .then() handlers
    const handlerContexts = this.processHandlers(promisePointer);

    return {
      promise: promisePointer,
      waiters: [...waiters, ...handlerContexts],
    };
  }

  /**
   * Handle EXIT_ASYNC_REJECTED: async function threw an uncaught exception.
   *
   * Rejects the promise and prepares all waiters with the rejection reason
   * and RESPONSE_THROW. Waiters are returned ready to run.
   *
   * @param {number} contextSlot - The rejecting async context
   * @returns {{ promise: number, waiters: {slot:number,generation:number}[] }}
   */
  handleAsyncRejected(contextSlot) {
    const mem = this.memoryImage;

    // An async body that rejects its promise is
    // terminal for this context — drain any owed construction aborts
    // before settling (the throw unwind stopped at the async frame, so
    // pending-constructor frames above it were never popped).
    this.abortAbandonedConstructions(contextSlot);

    // Get the frame's ASYNC_PROMISE (mask off flag bits 0-1)
    // BASE-frame read — see handleAsyncComplete's comment; this is the
    // path where the distinction is load-bearing (the throw unwind leaves
    // sync frames stacked above the async frame).
    const stackPointer = mem.getContextCallStackPointer(contextSlot);
    this._assertAsyncFrameReadable('handleAsyncRejected', contextSlot, stackPointer);
    const framePointer = mem.getCallStackBase(contextSlot);
    const asyncPromiseField = mem.view.getUint32(mem.abs(framePointer + FRAME.ASYNC_PROMISE), true);
    const promisePointer = asyncPromiseField & ~3;
    mem.assertPromiseAt(promisePointer, `handleAsyncRejected(slot ${contextSlot})`);

    // Get the error from completion value slot
    const valuePointer = mem.getContextCompletionValue(contextSlot);
    const completionType = mem.view.getUint32(mem.abs(valuePointer), true);
    const completionFlags = mem.view.getUint32(mem.abs(valuePointer + 4), true);
    const completionLo = mem.view.getUint32(mem.abs(valuePointer + 8), true);
    const completionHi = mem.view.getUint32(mem.abs(valuePointer + 12), true);

    // Executor contexts: if promise already settled, skip.
    // If still pending, reject with the thrown error.
    const isExecutor = this._state.executorContexts.has(contextSlot);
    if (isExecutor) {
      this._state.executorContexts.delete(contextSlot);
      if (mem.getPromiseStatus(promisePointer) !== PROMISE_STATUS_PENDING) {
        return { promise: promisePointer, waiters: [] };
      }
    }

    // Reject the promise (even for finally handlers — if the callback throws,
    // the child promise rejects with the thrown error, not the original value)
    mem.setPromiseStatus(promisePointer, PROMISE_STATUS_REJECTED);
    mem.setPromiseValue(promisePointer, completionType, completionFlags, completionLo, completionHi);

    // Pop waiters and prepare them with rejection reason + RESPONSE_THROW
    const value = { type: completionType, flags: completionFlags, lo: completionLo, hi: completionHi };
    const waiters = mem.popAllWaiters(promisePointer);
    for (const waiterIdentity of waiters) { this._prepareWaiter(waiterIdentity.slot, waiterIdentity.generation, promisePointer, PROMISE_STATUS_REJECTED, value); }

    // Process .then() handlers
    const handlerContexts = this.processHandlers(promisePointer);

    const allWaiters = [...waiters, ...handlerContexts];

    if (allWaiters.length === 0) {
      let rejectionValue = undefined;
      try {
        rejectionValue = mem.readValueAt(valuePointer, this.marshallingOptions(contextSlot));
      } catch (_) {}
      this._state.pendingUnhandledRejections.set(promisePointer, {
        slot: contextSlot,
        value: rejectionValue,
      });
    }

    return {
      promise: promisePointer,
      waiters: allWaiters,
    };
  }

  /**
   * A context that terminates with an uncaught
   * error (or rejects its async promise) can still owe construction
   * aborts — the staged duty chain (receivers the unwind walk already
   * latched) and any construction-pending receivers in frames the
   * unwind never popped. The dispatch loop will never drain them for a
   * dead context, so terminal paths call this instead. Each abort runs
   * exactly once (the PENDING flag / duty latch); a synchronous abort
   * failure rethrows after the drain finishes, and a rejected async
   * abort surfaces as an unhandled rejection — never swallowed.
   */
  abortAbandonedConstructions(contextSlot) {
    const mem = this.memoryImage;
    const backingKey = mem.getBuiltinName(BUILTIN_NAME.EXTERNAL_BACKING);
    const linkKey = mem.getBuiltinName(BUILTIN_NAME.CONSTRUCTION_LINK);
    const failures = [];

    const abortReceiver = (receiverPointer) => {
      const brand = mem.objectFindOwnProperty(receiverPointer, backingKey);
      if (!brand || brand.type !== TYPE.EXTERNAL) return;
      const registration = this.constructibleRegistrations.get(brand.flags - 1);
      if (!registration) {
        failures.push(new TypeError('Illegal constructor'));
        return;
      }
      try {
        const result = registration.abortConstruction(this.membrane.handleForSlot(brand.lo));
        if (result instanceof Promise) {
          result.catch((e) => {
            // Terminal context: nothing left to route the failure into.
            // Rethrow out of the microtask so the host observes it.
            queueMicrotask(() => { throw e; });
          });
        }
      } catch (e) {
        failures.push(e);
      }
    };

    // 1. Staged duty chain (PENDING already cleared by the stager).
    const contextBase = mem.getContextBase(contextSlot);
    const dutyAddress = mem.abs(contextBase + CONTEXT_STATE_OFFSET + CTX.CONSTRUCTION_DUTY);
    let duty = mem.view.getUint32(dutyAddress, true);
    mem.view.setUint32(dutyAddress, 0, true);
    while (duty !== 0) {
      abortReceiver(duty);
      const link = mem.objectFindOwnProperty(duty, linkKey);
      duty = (link && link.type === TYPE.OBJECT) ? link.lo : 0;
    }

    // 2. Constructor frames the unwind never popped. Innermost first.
    const callStackBase = mem.getCallStackBase(contextSlot);
    const stackPointer = mem.getContextCallStackPointer(contextSlot);
    for (let frameOffset = stackPointer - FRAME_SIZE;
         frameOffset >= callStackBase;
         frameOffset -= FRAME_SIZE) {
      const frameAbsolute = mem.abs(frameOffset);
      const flags = mem.view.getUint32(frameAbsolute + FRAME.FLAGS, true);
      if ((flags & FRAME_FLAG_CONSTRUCTOR) === 0) continue;
      const receiverPointer = mem.view.getUint32(
        frameAbsolute + FRAME.CONTINUATION_STATE_1, true);
      if (receiverPointer === 0) continue;
      const objectFlags = mem.getObjectFlags(receiverPointer);
      if ((objectFlags & OBJECT_FLAG.CONSTRUCTION_PENDING) === 0) continue;
      mem.setObjectFlags(receiverPointer,
        objectFlags & ~OBJECT_FLAG.CONSTRUCTION_PENDING);
      abortReceiver(receiverPointer);
    }

    if (failures.length > 0) throw failures[0];
  }

  /**
   * Tripwire for the isAsyncSlot hazard, on the WRITE-ADJACENT paths:
   * handleAsyncComplete / handleAsyncRejected read the top frame at
   * stackPointer - FRAME_SIZE. Design B stacks are their own heap
   * blocks, so on an EMPTY stack that read dereferences a neighboring
   * heap object — the "async promise" is then arbitrary bytes, and the
   * settle path walks (and CLEARS) a garbage waiter list through it.
   * isAsyncSlot guards this for itself; the settle handlers must refuse
   * just as loudly instead of corrupting the heap.
   *
   * @param {string} where
   * @param {number} contextSlot
   * @param {number} stackPointer
   */
  _assertAsyncFrameReadable(where, contextSlot, stackPointer) {
    const callStackBase = this.memoryImage.getCallStackBase(contextSlot);
    if (stackPointer <= callStackBase) {
      throw new Error(
        `${where}: slot ${contextSlot} has an EMPTY call stack ` +
        `(stackPointer=${stackPointer}, callStackBase=${callStackBase}) — ` +
        `the top-frame read at stackPointer-FRAME_SIZE would dereference a ` +
        `neighboring heap object (the isAsyncSlot hazard); refusing to ` +
        `settle through a garbage async-promise pointer`);
    }
  }

  isAsyncSlot(contextSlot) {
    const mem = this.memoryImage;
    const stackPointer = mem.getContextCallStackPointer(contextSlot);
    const callStackBase = mem.getCallStackBase(contextSlot);
    // No frame on the call stack → top-level code, not an async body. Design B:
    // each stack is its own heap block, so reading callStackBase - FRAME_SIZE
    // (the old behaviour on an empty stack) would dereference a neighbouring
    // heap object and spuriously report "async". Guard the empty case.
    if (stackPointer <= callStackBase) return false;
    // BASE frame, not top: "is this context an async body" is a property
    // of frame 0 (every async body runs in its own spawned context). A
    // top-frame read misclassifies the context as non-async whenever a
    // sync helper's frame sits above the async frame — see
    // handleAsyncComplete's comment for the fault that exposed this.
    const asyncPromiseField = mem.view.getUint32(mem.abs(callStackBase + FRAME.ASYNC_PROMISE), true);
    return (asyncPromiseField & ~3) !== 0;
  }

  /**
   * Handle EXIT_AWAIT: context hit an await expression.
   *
   * If the promise is pending, the context is already registered as a waiter
   * (done by WASM). It will be prepared later by handleAsyncComplete/handleAsyncRejected.
   *
   * If the promise is already settled, prepares the context with the value
   * (and RESPONSE_THROW if rejected) so it's ready to run immediately.
   *
   * @param {number} contextSlot - The awaiting context
   * @returns {{ pending: boolean }}
   */
  handleAwait(contextSlot) {
    const mem = this.memoryImage;

    // Read await request from external_request_base
    const requestBase = mem.getExternalRequestBase(contextSlot);
    const isPending = mem.view.getUint32(mem.abs(requestBase), true);
    const isRejected = mem.view.getUint32(mem.abs(requestBase + 4), true);
    const valuePointer = mem.view.getUint32(mem.abs(requestBase + 8), true);
    if (isPending) {
      // Context is now waiting on a pending promise.
      // WASM already added it to the waiter list. Record the
      // park in the in-flight ledger as AWAITING_PROMISE so an
      // external observer sees the slot is blocked. The resume
      // paths (handleAsyncComplete / handleAsyncRejected / any
      // path that wakes via pendingSpawnedContexts) free the
      // entry. v1 doesn't distinguish JS-promise await from
      // SS-peer await; both surface as AWAITING_PROMISE.
      this._claimAwaitingPromise(contextSlot);
      if (this.hooks.onSuspend) {
        this.hooks.onSuspend({ kind: 'park-await', slot: contextSlot });
      }
      return { pending: true };
    }

    // Promise is settled (or not a promise) — prepare the context
    const valueType = mem.view.getUint32(mem.abs(valuePointer), true);
    const valueFlags = mem.view.getUint32(mem.abs(valuePointer + 4), true);
    const valueLo = mem.view.getUint32(mem.abs(valuePointer + 8), true);
    const valueHi = mem.view.getUint32(mem.abs(valuePointer + 12), true);

    const pendingPtr = mem.getContextPendingPointer(contextSlot);
    const absPtr = mem.abs(pendingPtr);
    mem.view.setUint32(absPtr, valueType, true);
    mem.view.setUint32(absPtr + 4, valueFlags, true);
    mem.view.setUint32(absPtr + 8, valueLo, true);
    mem.view.setUint32(absPtr + 12, valueHi, true);
    mem.setContextPendingPointer(contextSlot, pendingPtr + 16);

    if (isRejected) {
      mem.setResponseType(contextSlot, RESPONSE_THROW);
      // The rejection was consumed by a waiter (a parent's `catch`
      // or `try/await`). If this promise was on the unhandled-
      // rejection watchlist, remove it — it's handled now. We match
      // by value pointer: the watchlist stores the promise pointer,
      // and the promise's value field is at promisePointer +
      // PROMISE.VALUE. The WASM wrote the value pointer here; walk
      // back to the promise pointer.
      const promisePointer = valuePointer - PROMISE.VALUE;
      this._state.pendingUnhandledRejections.delete(promisePointer);
    }

    mem.clearExitCondition(contextSlot);

    return { pending: false };
  }

  // ===========================================================================
  // Promise Executor Settle (resolve / reject)
  // ===========================================================================

  /**
   * Handle EXIT_PROMISE_SETTLE: executor body called resolve(value) or
   * reject(reason). The continuation values are TYPE_PROMISE_RESOLVE /
   * TYPE_PROMISE_REJECT — not host capabilities, so there is no membrane
   * check, no handler lookup, and no grant tagging. The host settles the
   * promise inline: writes the value, processes .then handlers, prepares
   * waiters.
   *
   * Request layout: [promisePointer:4][isReject:4][argsPointer:4][argCount:4]
   *
   * @param {number} contextSlot - The executor context that yielded
   * @returns {{ contexts: number[] }} - Spawned/woken contexts ready to run
   */
  handlePromiseSettle(contextSlot) {
    const mem = this.memoryImage;

    let requestBase = mem.getExternalRequestBase(contextSlot);
    const isReject = mem.view.getUint32(mem.abs(requestBase + 4), true) !== 0;
    const argsPointer = mem.view.getUint32(mem.abs(requestBase + 8), true);
    const argCount = mem.view.getUint32(mem.abs(requestBase + 12), true);

    // Read the settle value/reason before any possible gc. The request's
    // heap pointers move during collection, while this JS value remains
    // valid across the retry.
    const options = this.marshallingOptions(contextSlot);
    let value;
    if (argCount === 0) {
      value = undefined;
    } else {
      const args = mem.unmarshalArgs(argsPointer, argCount, options);
      value = args[0];
    }

    // Write undefined into the continuation slot the WAT pre-positioned
    // pending_pointer at. resolve/reject return undefined; this keeps
    // the post-yield pending stack invariant identical to EXIT_EXTERNAL_CALL
    // (host writes one value at pending_pointer, advances by VALUE_SIZE).
    mem.marshalResult(contextSlot, undefined);

    let promiseDataPointer;
    let garbageCollectAttempted = false;
    while (true) {
      // Re-read per attempt: gc forwards the promise pointer stored in
      // request_base, so the pointer captured before collection is stale.
      requestBase = mem.getExternalRequestBase(contextSlot);
      promiseDataPointer = mem.view.getUint32(mem.abs(requestBase), true);
      mem.assertPromiseAt(
        promiseDataPointer,
        `handlePromiseSettle(slot ${contextSlot})`,
      );

      // Idempotent: already-settled promise (e.g. drone called resolve twice,
      // or resolve after reject). Drop on the floor like the inline handler.
      if (mem.getPromiseStatus(promiseDataPointer) !== PROMISE_STATUS_PENDING) {
        mem.clearExitCondition(contextSlot);
        return { contexts: [] };
      }

      try {
        // Commit last: nobody reads VALUE while the promise is pending.
        // A pressure throw therefore leaves a retryable pending promise.
        mem.marshalPromiseValue(
          promiseDataPointer,
          value,
          this.marshallingOptions(contextSlot),
        );
        break;
      } catch (e) {
        if (!(e instanceof HeapPressureSignal)
            || garbageCollectAttempted
            || !this._state.heapGarbageCollect) {
          throw e;
        }
        garbageCollectAttempted = true;
        this._state.heapGarbageCollect();
      }
    }

    const newStatus = isReject ? PROMISE_STATUS_REJECTED : PROMISE_STATUS_RESOLVED;
    mem.setPromiseStatus(promiseDataPointer, newStatus);
    mem.clearExitCondition(contextSlot);

    const spawnedContexts = this.processHandlers(promiseDataPointer);
    const waiters = mem.popAllWaiters(promiseDataPointer);
    const settledValue = mem.getPromiseValue(promiseDataPointer);
    for (const waiterIdentity of waiters) { this._prepareWaiter(waiterIdentity.slot, waiterIdentity.generation, promiseDataPointer, newStatus, settledValue);
    spawnedContexts.push(waiterIdentity); }

    return { contexts: spawnedContexts };
  }

  // ===========================================================================
  // Promise Method Handling (.then/.catch/.finally)
  // ===========================================================================

  /**
   * Handle EXIT_PROMISE_METHOD: promise instance method or static method was called.
   *
   * Reads request from external_request_base:
   * [promiseHeaderPointer:4][methodId:4][argsPointer:4][argCount:4]
   *
   * If promiseHeaderPointer > 0: instance method (.then/.catch/.finally)
   * If promiseHeaderPointer === 0: static method or constructor
   *
   * @param {number} contextSlot - The calling context
   * @returns {{ contexts: number[] }} - Callback contexts ready to run
   */
  handlePromiseMethod(contextSlot) {
    const mem = this.memoryImage;

    // Read request
    const requestBase = mem.getExternalRequestBase(contextSlot);
    const promiseHeaderPointer = mem.view.getUint32(mem.abs(requestBase), true);
    const methodId = mem.view.getUint32(mem.abs(requestBase + 4), true);
    const argsPointer = mem.view.getUint32(mem.abs(requestBase + 8), true);
    const argCount = mem.view.getUint32(mem.abs(requestBase + 12), true);

    // Static/constructor dispatch (promiseHeaderPointer === 0)
    if (promiseHeaderPointer === 0) {
      return this._handlePromiseStatic(contextSlot, methodId, argsPointer, argCount);
    }

    // Instance method dispatch (.then/.catch/.finally)
    return this._handlePromiseInstance(contextSlot, promiseHeaderPointer, methodId, argsPointer, argCount);
  }

  /**
   * Handle promise instance methods: .then(), .catch(), .finally()
   */
  _handlePromiseInstance(contextSlot, promiseHeaderPointer, methodId, argsPointer, argCount) {
    const mem = this.memoryImage;

    // Promise data pointer = header + GC_HEADER_SIZE
    const promisePointer = promiseHeaderPointer + GC_HEADER_SIZE;

    // Extract closure arguments based on method
    let onResolved = 0;
    let onRejected = 0;
    let isFinally = false;

    if (methodId === METHOD.THEN) {
      // .then(onResolved, onRejected)
      if (argCount >= 1) {
        const arg0Type = mem.view.getUint32(mem.abs(argsPointer), true);
        if (arg0Type === TYPE.FUNCTION) {
          onResolved = mem.view.getUint32(mem.abs(argsPointer + 8), true); // header pointer
        }
      }
      if (argCount >= 2) {
        const arg1Type = mem.view.getUint32(mem.abs(argsPointer + 16), true);
        if (arg1Type === TYPE.FUNCTION) {
          onRejected = mem.view.getUint32(mem.abs(argsPointer + 16 + 8), true);
        }
      }
    } else if (methodId === METHOD.CATCH) {
      // .catch(onRejected)
      if (argCount >= 1) {
        const arg0Type = mem.view.getUint32(mem.abs(argsPointer), true);
        if (arg0Type === TYPE.FUNCTION) {
          onRejected = mem.view.getUint32(mem.abs(argsPointer + 8), true);
        }
      }
    } else if (methodId === METHOD.FINALLY) {
      // .finally(onFinally) — same callback for both resolve and reject
      isFinally = true;
      if (argCount >= 1) {
        const arg0Type = mem.view.getUint32(mem.abs(argsPointer), true);
        if (arg0Type === TYPE.FUNCTION) {
          const closurePtr = mem.view.getUint32(mem.abs(argsPointer + 8), true);
          onResolved = closurePtr;
          onRejected = closurePtr;
        }
      }
    }

    // Create child promise
    const childPromise = mem.createPromise();

    // Create handler entry and append to parent promise
    const handler = mem.createThenHandler(onResolved, onRejected, childPromise, isFinally);
    mem.appendThenHandler(promisePointer, handler);

    // Push child promise to caller's pending stack
    this._pushPromise(contextSlot, childPromise);

    mem.clearExitCondition(contextSlot);

    // If parent promise is already settled, process handlers now
    const status = mem.getPromiseStatus(promisePointer);
    if (status !== PROMISE_STATUS_PENDING) {
      const contexts = this.processHandlers(promisePointer);
      return { contexts };
    }

    return { contexts: [] };
  }

  /**
   * Handle promise static methods and constructor.
   */
  _handlePromiseStatic(contextSlot, methodId, argsPointer, argCount) {
    const mem = this.memoryImage;
    mem.clearExitCondition(contextSlot);

    if (methodId === METHOD.PROMISE_CONSTRUCTOR) {
      return this._handleNewPromise(contextSlot, argsPointer, argCount);
    }

    if (methodId === METHOD.PROMISE_ALL) {
      return this._handlePromiseAll(contextSlot, argsPointer, argCount);
    }

    if (methodId === METHOD.PROMISE_RACE) {
      return this._handlePromiseRace(contextSlot, argsPointer, argCount);
    }

    // Unknown static method — push undefined
    const pendingPtr = mem.getContextPendingPointer(contextSlot);
    const absPtr = mem.abs(pendingPtr);
    mem.view.setUint32(absPtr, TYPE.UNDEFINED, true);
    mem.view.setUint32(absPtr + 4, 0, true);
    mem.view.setUint32(absPtr + 8, 0, true);
    mem.view.setUint32(absPtr + 12, 0, true);
    mem.setContextPendingPointer(contextSlot, pendingPtr + 16);
    return { contexts: [] };
  }

  /**
   * Push a promise (data pointer) to a context's pending stack.
   */
  _pushPromise(contextSlot, promiseDataPointer) {
    const mem = this.memoryImage;
    const headerPointer = promiseDataPointer - GC_HEADER_SIZE;
    const pendingPtr = mem.getContextPendingPointer(contextSlot);
    const absPtr = mem.abs(pendingPtr);
    mem.view.setUint32(absPtr, TYPE.PROMISE, true);
    mem.view.setUint32(absPtr + 4, 0, true);
    mem.view.setUint32(absPtr + 8, headerPointer, true);
    mem.view.setUint32(absPtr + 12, 0, true);
    mem.setContextPendingPointer(contextSlot, pendingPtr + 16);
  }

  /**
   * Handle new Promise(executor).
   *
   * Creates a pending promise, registers resolve/reject external handles,
   * sets up the executor as a callback context with FRAME_ASYNC_PROMISE
   * (bit 2 = isExecutor).
   */
  _handleNewPromise(contextSlot, argsPointer, argCount) {
    const mem = this.memoryImage;

    // Validate executor argument
    if (argCount < 1) {
      this._createAndPushErrorWithPressureRecovery(contextSlot,STATE.TYPE_ERROR_PROTOTYPE, 'Promise resolver undefined is not a function');
      mem.setResponseType(contextSlot, RESPONSE_THROW);
      return { contexts: [] };
    }

    const executorType = mem.view.getUint32(mem.abs(argsPointer), true);
    if (executorType !== TYPE.FUNCTION) {
      this._createAndPushErrorWithPressureRecovery(contextSlot,STATE.TYPE_ERROR_PROTOTYPE, 'Promise resolver is not a function');
      mem.setResponseType(contextSlot, RESPONSE_THROW);
      return { contexts: [] };
    }

    const executorClosurePointer = mem.view.getUint32(mem.abs(argsPointer + 8), true);

    // Create the pending promise
    const promiseDataPointer = mem.createPromise();

    // Set up the executor as a callback context
    const closure = mem.getClosure(executorClosurePointer);
    const executorContext = mem.createConfiguredContext({
      scopePointer: closure.scope,
      instructionIndex: closure.startInstruction,
      createChildScope: true,
    });

    // Inherit caller's grants + root grants on the executor's grant stack
    // so the executor body runs with the same authorization scope as the
    // code that wrote `new Promise(...)`. There is no synthetic
    // "executor grant" — resolve/reject are not host capabilities, they're
    // in-band continuation values pushed onto the pending stack below.
    const interpreterGrantIds = mem.getActiveGrantIds(contextSlot);
    for (const grantId of interpreterGrantIds) {
      mem.pushGrantEntryForCallback(executorContext, grantId);
    }
    for (const grantId of this.membrane.rootGrantSlots()) {
      mem.pushGrantEntryForCallback(executorContext, grantId);
    }

    // Push resolve / reject onto the executor's pending stack as in-band
    // continuation values. CALL on these types yields EXIT_PROMISE_SETTLE,
    // routed by the host through handlePromiseSettle — no membrane,
    // no handler lookup, no grant tagging.
    {
      const pendingPointer = mem.getContextPendingPointer(executorContext);
      const absResolve = mem.abs(pendingPointer);
      mem.view.setUint32(absResolve, TYPE.PROMISE_RESOLVE, true);
      mem.view.setUint32(absResolve + 4, 0, true);
      mem.view.setUint32(absResolve + 8, promiseDataPointer, true);
      mem.view.setUint32(absResolve + 12, 0, true);
      const absReject = mem.abs(pendingPointer + 16); // + VALUE_SIZE
      mem.view.setUint32(absReject, TYPE.PROMISE_REJECT, true);
      mem.view.setUint32(absReject + 4, 0, true);
      mem.view.setUint32(absReject + 8, promiseDataPointer, true);
      mem.view.setUint32(absReject + 12, 0, true);
      mem.setContextPendingPointer(executorContext, pendingPointer + 32); // + 2 * VALUE_SIZE
    }

    // Track this context as an executor (for handleAsyncComplete/handleAsyncRejected)
    this._state.executorContexts.add(executorContext);

    // Push a call frame with FRAME_ASYNC_PROMISE pointing to the created promise
    const asyncPromiseField = promiseDataPointer;
    mem.pushFrame(
      executorContext,
      closure.startInstruction,
      mem.getContextScope(executorContext),
      0,    // astNode
      2     // argc: resolve + reject pushed above
    );
    const stackPointer = mem.getContextCallStackPointer(executorContext);
    const framePointer = stackPointer - FRAME_SIZE;
    mem.view.setUint32(mem.abs(framePointer + FRAME.ASYNC_PROMISE), asyncPromiseField, true);

    // Push the created promise to the caller's pending stack
    this._pushPromise(contextSlot, promiseDataPointer);

    return {
      contexts: [{
        slot: executorContext,
        generation: mem.getContextGeneration(executorContext),
      }],
    };
  }

  /**
   * Handle Promise.all(array).
   * Creates a result promise that resolves when all input promises resolve.
   * Uses aggregator ThenHandlers with callback pointer = 1 (reserved marker).
   *
   * The remaining count and results array header are stashed in the result
   * promise's VALUE field while pending:
   *   [type: TYPE_INTEGER][flags: 0][remaining_count: i32][results_array_header: i32]
   */
  _handlePromiseAll(contextSlot, argsPointer, argCount) {
    const mem = this.memoryImage;

    // Read array argument
    if (argCount < 1) {
      this._createAndPushErrorWithPressureRecovery(contextSlot,STATE.TYPE_ERROR_PROTOTYPE, 'Promise.all requires an array argument');
      mem.setResponseType(contextSlot, RESPONSE_THROW);
      return { contexts: [] };
    }

    const arg0Type = mem.view.getUint32(mem.abs(argsPointer), true);
    if (arg0Type !== TYPE.ARRAY) {
      this._createAndPushErrorWithPressureRecovery(contextSlot,STATE.TYPE_ERROR_PROTOTYPE, 'Promise.all requires an array argument');
      mem.setResponseType(contextSlot, RESPONSE_THROW);
      return { contexts: [] };
    }

    const arrayHeaderPointer = mem.view.getUint32(mem.abs(argsPointer + 8), true);
    const arrayLength = mem.view.getUint32(mem.abs(arrayHeaderPointer + 8), true);

    // Create result promise
    const resultPromise = mem.createPromise();
    const spawnedContexts = [];

    // Empty array → resolve immediately with []
    if (arrayLength === 0) {
      const emptyArray = mem.allocateArrayWithCapacity(0);
      mem.setPromiseStatus(resultPromise, PROMISE_STATUS_RESOLVED);
      // Write TYPE_ARRAY value into promise VALUE field
      const absData = mem.abs(resultPromise);
      mem.view.setUint32(absData + PROMISE.VALUE, TYPE.ARRAY, true);
      mem.view.setUint32(absData + PROMISE.VALUE + 4, 0, true);
      mem.view.setUint32(absData + PROMISE.VALUE + 8, emptyArray, true);
      mem.view.setUint32(absData + PROMISE.VALUE + 12, 0, true);

      this._pushPromise(contextSlot, resultPromise);
      return { contexts: [] };
    }

    // Create results array and set length = arrayLength
    const resultsArray = mem.allocateArrayWithCapacity(arrayLength);
    mem.view.setUint32(mem.abs(resultsArray + 8), arrayLength, true); // set length
    // Initialize all elements to undefined
    const dataPointer = mem.view.getUint32(mem.abs(resultsArray + 16), true);
    for (let i = 0; i < arrayLength; i++) {
      const elemPtr = mem.abs(dataPointer + GC_HEADER_SIZE + i * 16);
      mem.view.setUint32(elemPtr, TYPE.UNDEFINED, true);
      mem.view.setUint32(elemPtr + 4, 0, true);
      mem.view.setUint32(elemPtr + 8, 0, true);
      mem.view.setUint32(elemPtr + 12, 0, true);
    }

    // Stash results array and remaining count in result promise VALUE field:
    // [TYPE.ARRAY][remaining_count][results_array_header][0]
    // The stash MUST be collector-visible: the old encoding hid the
    // results-array header in the data_hi of an INTEGER-typed value, so
    // no mark/forward pass ever saw it — across element resolutions the
    // array was collected (or moved) out from under the aggregator, and
    // the final settle handed the awaiter a stale pointer.
    // Typing the stash as ARRAY with the header in data_lo makes
    // markValue/updateValuePointer keep it alive and forwarded; the
    // FLAGS field (ignored by every collector pass) carries `remaining`.
    // A pending promise's VALUE is never read outside the aggregator.
    let remaining = arrayLength;
    const absResult = mem.abs(resultPromise);
    mem.view.setUint32(absResult + PROMISE.VALUE, TYPE.ARRAY, true);
    mem.view.setUint32(absResult + PROMISE.VALUE + 4, remaining, true);
    mem.view.setUint32(absResult + PROMISE.VALUE + 8, resultsArray, true);
    mem.view.setUint32(absResult + PROMISE.VALUE + 12, 0, true);

    // Read input array data pointer
    const inputDataPointer = mem.view.getUint32(mem.abs(arrayHeaderPointer + 16), true);

    let rejected = false;
    for (let i = 0; i < arrayLength; i++) {
      if (rejected) break;

      const elemBase = mem.abs(inputDataPointer + GC_HEADER_SIZE + i * 16);
      const elemType = mem.view.getUint32(elemBase, true);
      const elemFlags = mem.view.getUint32(elemBase + 4, true);
      const elemLo = mem.view.getUint32(elemBase + 8, true);
      const elemHi = mem.view.getUint32(elemBase + 12, true);

      if (elemType === TYPE.PROMISE) {
        // It's a promise — check its status
        const promiseHeader = elemLo;
        const promiseData = promiseHeader + GC_HEADER_SIZE;
        const status = mem.getPromiseStatus(promiseData);

        if (status === PROMISE_STATUS_RESOLVED) {
          // Already resolved — store value in results
          const value = mem.getPromiseValue(promiseData);
          this._storeInResultsArray(resultsArray, i, value);
          remaining--;
          mem.view.setUint32(absResult + PROMISE.VALUE + 4, remaining, true);
        } else if (status === PROMISE_STATUS_REJECTED) {
          // Already rejected — reject result promise
          const value = mem.getPromiseValue(promiseData);
          mem.setPromiseStatus(resultPromise, PROMISE_STATUS_REJECTED);
          mem.view.setUint32(absResult + PROMISE.VALUE, value.type, true);
          mem.view.setUint32(absResult + PROMISE.VALUE + 4, value.flags, true);
          mem.view.setUint32(absResult + PROMISE.VALUE + 8, value.lo, true);
          mem.view.setUint32(absResult + PROMISE.VALUE + 12, value.hi, true);
          rejected = true;
        } else {
          // Pending — attach aggregator ThenHandler
          // callback=1 (aggregator marker), childPromise=resultPromise, flags=index
          const handler = mem.createThenHandler(1, 1, resultPromise, false);
          // Overwrite FLAGS field with index (repurposed for aggregator)
          mem.setThenHandlerFlags(handler, i);
          mem.appendThenHandler(promiseData, handler);
        }
      } else {
        // Not a promise — treat as already-resolved value. Preserve flags
        // so inline Rationals and other tagged values survive unchanged.
        const value = { type: elemType, flags: elemFlags, lo: elemLo, hi: elemHi };
        this._storeInResultsArray(resultsArray, i, value);
        remaining--;
        mem.view.setUint32(absResult + PROMISE.VALUE + 4, remaining, true);
      }
    }

    // If all resolved synchronously
    if (!rejected && remaining === 0) {
      mem.setPromiseStatus(resultPromise, PROMISE_STATUS_RESOLVED);
      const absData = mem.abs(resultPromise);
      mem.view.setUint32(absData + PROMISE.VALUE, TYPE.ARRAY, true);
      mem.view.setUint32(absData + PROMISE.VALUE + 4, 0, true);
      mem.view.setUint32(absData + PROMISE.VALUE + 8, resultsArray, true);
      mem.view.setUint32(absData + PROMISE.VALUE + 12, 0, true);
    }

    this._pushPromise(contextSlot, resultPromise);

    // If result promise was settled, process its handlers
    if (mem.getPromiseStatus(resultPromise) !== PROMISE_STATUS_PENDING) {
      const ctx = this.processHandlers(resultPromise);
      spawnedContexts.push(...ctx);
    }

    return { contexts: spawnedContexts };
  }

  /**
   * Handle Promise.race(array).
   * Creates a result promise that settles when the first input settles.
   */
  _handlePromiseRace(contextSlot, argsPointer, argCount) {
    const mem = this.memoryImage;

    // Read array argument
    if (argCount < 1) {
      this._createAndPushErrorWithPressureRecovery(contextSlot,STATE.TYPE_ERROR_PROTOTYPE, 'Promise.race requires an array argument');
      mem.setResponseType(contextSlot, RESPONSE_THROW);
      return { contexts: [] };
    }

    const arg0Type = mem.view.getUint32(mem.abs(argsPointer), true);
    if (arg0Type !== TYPE.ARRAY) {
      this._createAndPushErrorWithPressureRecovery(contextSlot,STATE.TYPE_ERROR_PROTOTYPE, 'Promise.race requires an array argument');
      mem.setResponseType(contextSlot, RESPONSE_THROW);
      return { contexts: [] };
    }

    const arrayHeaderPointer = mem.view.getUint32(mem.abs(argsPointer + 8), true);
    const arrayLength = mem.view.getUint32(mem.abs(arrayHeaderPointer + 8), true);

    // Create result promise
    const resultPromise = mem.createPromise();
    const spawnedContexts = [];

    // Empty array → forever pending (per JS spec)
    if (arrayLength === 0) {
      this._pushPromise(contextSlot, resultPromise);
      return { contexts: [] };
    }

    const inputDataPointer = mem.view.getUint32(mem.abs(arrayHeaderPointer + 16), true);

    let settled = false;
    for (let i = 0; i < arrayLength; i++) {
      if (settled) break;

      const elemBase = mem.abs(inputDataPointer + GC_HEADER_SIZE + i * 16);
      const elemType = mem.view.getUint32(elemBase, true);
      const elemFlags = mem.view.getUint32(elemBase + 4, true);
      const elemLo = mem.view.getUint32(elemBase + 8, true);
      const elemHi = mem.view.getUint32(elemBase + 12, true);

      if (elemType === TYPE.PROMISE) {
        const promiseHeader = elemLo;
        const promiseData = promiseHeader + GC_HEADER_SIZE;
        const status = mem.getPromiseStatus(promiseData);

        if (status === PROMISE_STATUS_RESOLVED) {
          const value = mem.getPromiseValue(promiseData);
          mem.setPromiseStatus(resultPromise, PROMISE_STATUS_RESOLVED);
          mem.setPromiseValue(resultPromise, value.type, value.flags, value.lo, value.hi);
          settled = true;
        } else if (status === PROMISE_STATUS_REJECTED) {
          const value = mem.getPromiseValue(promiseData);
          mem.setPromiseStatus(resultPromise, PROMISE_STATUS_REJECTED);
          mem.setPromiseValue(resultPromise, value.type, value.flags, value.lo, value.hi);
          settled = true;
        } else {
          // Pending — attach aggregator ThenHandler
          // For race: callback=1 (aggregator marker), childPromise=resultPromise, flags=-1 (race marker)
          const handler = mem.createThenHandler(1, 1, resultPromise, false);
          mem.setThenHandlerFlags(handler, -1); // -1 distinguishes race from all
          mem.appendThenHandler(promiseData, handler);
        }
      } else {
        // Not a promise — resolve immediately. Preserve element flags.
        mem.setPromiseStatus(resultPromise, PROMISE_STATUS_RESOLVED);
        const absData = mem.abs(resultPromise);
        mem.view.setUint32(absData + PROMISE.VALUE, elemType, true);
        mem.view.setUint32(absData + PROMISE.VALUE + 4, elemFlags, true);
        mem.view.setUint32(absData + PROMISE.VALUE + 8, elemLo, true);
        mem.view.setUint32(absData + PROMISE.VALUE + 12, elemHi, true);
        settled = true;
      }
    }

    this._pushPromise(contextSlot, resultPromise);

    // If result promise was settled, process its handlers
    if (mem.getPromiseStatus(resultPromise) !== PROMISE_STATUS_PENDING) {
      const ctx = this.processHandlers(resultPromise);
      spawnedContexts.push(...ctx);
    }

    return { contexts: spawnedContexts };
  }

  /**
   * Store a value into a results array at the given index.
   * @param {number} resultsArrayHeader - Header pointer to the results array
   * @param {number} index - Index in the array
   * @param {{ type, flags, lo, hi }} value - Tagged value to store
   */
  _storeInResultsArray(resultsArrayHeader, index, value) {
    const mem = this.memoryImage;
    const dataPointer = mem.view.getUint32(mem.abs(resultsArrayHeader + 16), true);
    const elemPtr = mem.abs(dataPointer + GC_HEADER_SIZE + index * 16);
    mem.view.setUint32(elemPtr, value.type, true);
    mem.view.setUint32(elemPtr + 4, value.flags, true);
    mem.view.setUint32(elemPtr + 8, value.lo, true);
    mem.view.setUint32(elemPtr + 12, value.hi, true);
  }

  /**
   * DEBUG-ONLY GC-header validator.
   *
   * Enabled by env SANDSCRIPT_GC_ASSERT=1. Given a heap DATA pointer (the
   * pointer AFTER the 8-byte GC header), assert it is in-bounds and its GC
   * header's object type matches `expectedObjType` (OBJ.*). On mismatch logs
   * the bad pointer, the actual type, and a label (recorded in
   * GC_ASSERT_STATE.firstFail), then RETURNS — deliberately does not throw,
   * so the corrupting run proceeds and its downstream face (DataView OOB /
   * negative typed-array length / silent hang) can still be observed in the
   * same run. Catches a relocated/garbage pointer at the instant of
   * dereference instead of only at its later symptom.
   *
   * Header word layout: (objType << 24) | packedSize, stored at
   * dataPointer - GC_HEADER_SIZE. Large ArrayBuffers have packedSize zero.
   * The top bit is the GC mark; mask it off when reading the type.
   *
   * Zero-cost when the flag is off (single boolean check, no allocation).
   */
  _assertGcType(dataPointer, expectedObjType, label) {
    if (!this._gcAssertEnabled) return;
    GC_ASSERT_STATE.calls++;
    const mem = this.memoryImage;
    const heapTop = mem.getHeapPointer();
    // A valid data pointer sits above its 8-byte header and below the heap top.
    if (!Number.isInteger(dataPointer) || dataPointer < GC_HEADER_SIZE || dataPointer >= heapTop) {
      GC_ASSERT_STATE.fails++;
      const msg = `GC-ASSERT[${label}]: data pointer ${dataPointer} out of heap bounds ` +
        `(GC_HEADER_SIZE=${GC_HEADER_SIZE}, heapTop=${heapTop})`;
      if (!GC_ASSERT_STATE.firstFail) GC_ASSERT_STATE.firstFail = msg;
      console.error(msg);
      return; // do NOT throw — let the corruption proceed so we can observe its downstream face too
    }
    const headerWord = mem.view.getUint32(mem.abs(dataPointer - GC_HEADER_SIZE), true);
    const actualType = (headerWord >>> 24) & 0x7f; // strip the mark bit
    if (actualType !== expectedObjType) {
      GC_ASSERT_STATE.fails++;
      const msg = `GC-ASSERT[${label}]: pointer ${dataPointer} has GC type ${actualType} ` +
        `(headerWord=0x${(headerWord >>> 0).toString(16)}), expected ${expectedObjType}` +
        ` — relocated/garbage pointer dereferenced`;
      if (!GC_ASSERT_STATE.firstFail) GC_ASSERT_STATE.firstFail = msg;
      console.error(msg);
    }
  }

  /**
   * Process all .then() handlers on a settled promise.
   * For each handler, prepares a callback context or settles the child promise directly.
   *
   * @param {number} promisePointer - Data pointer to the settled promise
   * @returns {number[]} - Context slots of spawned callback contexts (ready to run)
   */
  processHandlers(promisePointer) {
    const mem = this.memoryImage;
    const status = mem.getPromiseStatus(promisePointer);
    const value = mem.getPromiseValue(promisePointer);
    const handlers = mem.popAllHandlers(promisePointer);
    const spawnedContexts = [];

    for (const handler of handlers) {
      const callback = status === PROMISE_STATUS_RESOLVED
        ? handler.onResolved
        : handler.onRejected;

      if (callback === 1) {
        // Aggregator handler (Promise.all / Promise.race)
        // handler.childPromise = result promise, handler.flags = index (all) or -1 (race)
        const resultPromise = handler.childPromise;

        // DEBUG: the aggregator fires when a concurrently host-suspended
        // element promise resolves. If a context grow/relocation invalidated
        // the result-promise pointer stashed at Promise.all setup time, this
        // is where the garbage is first dereferenced (status read below, then
        // the results-array read/store). Assert the header is still a PROMISE.
        this._assertGcType(resultPromise, OBJ.PROMISE, 'aggregator:resultPromise');

        // Skip if result promise already settled (race: first wins; all: first rejection wins)
        if (mem.getPromiseStatus(resultPromise) !== PROMISE_STATUS_PENDING) {
          continue;
        }

        const flags = handler.flags;

        if (flags === -1) {
          // Promise.race — first settlement wins
          mem.setPromiseStatus(resultPromise, status);
          mem.setPromiseValue(resultPromise, value.type, value.flags, value.lo, value.hi);

          // Settling result promise triggers its own handlers and waiters
          const childWaiters = mem.popAllWaiters(resultPromise);
          for (const waiterIdentity of childWaiters) { this._prepareWaiter(waiterIdentity.slot, waiterIdentity.generation, resultPromise, status, value);
          spawnedContexts.push(waiterIdentity); }
          const childContexts = this.processHandlers(resultPromise);
          spawnedContexts.push(...childContexts);
        } else {
          // Promise.all — store value at index, decrement remaining
          const index = flags;

          if (status === PROMISE_STATUS_REJECTED) {
            // First rejection rejects the result promise
            mem.setPromiseStatus(resultPromise, PROMISE_STATUS_REJECTED);
            mem.setPromiseValue(resultPromise, value.type, value.flags, value.lo, value.hi);

            const childWaiters = mem.popAllWaiters(resultPromise);
            for (const waiterIdentity of childWaiters) { this._prepareWaiter(waiterIdentity.slot, waiterIdentity.generation, resultPromise, PROMISE_STATUS_REJECTED, value);
            spawnedContexts.push(waiterIdentity); }
            const childContexts = this.processHandlers(resultPromise);
            spawnedContexts.push(...childContexts);
          } else {
            // Resolved — read the stash: [TYPE.ARRAY][remaining][resultsArray][0]
            // (see _handlePromiseAll — the header lives in data_lo so the
            // collector keeps it alive and forwarded; remaining rides FLAGS).
            const absResult = mem.abs(resultPromise);
            let remaining = mem.view.getUint32(absResult + PROMISE.VALUE + 4, true);
            const resultsArray = mem.view.getUint32(absResult + PROMISE.VALUE + 8, true);

            // DEBUG: the stashed results-array pointer read from the result
            // promise's VALUE field is the prime corruption suspect — if it
            // is stale, _storeInResultsArray writes to a garbage address
            // (DataView OOB / negative typed-array length), or `remaining`
            // was read from the wrong place and never reaches 0 (silent hang).
            this._assertGcType(resultsArray, OBJ.ARRAY, 'aggregator:resultsArray');

            // Store value in results[index]
            this._storeInResultsArray(resultsArray, index, value);

            remaining--;
            mem.view.setUint32(absResult + PROMISE.VALUE + 4, remaining, true);

            if (remaining === 0) {
              // All resolved — settle result promise with results array
              // (the stash already has ARRAY/data_lo form; clear the
              // remaining count from FLAGS).
              mem.setPromiseStatus(resultPromise, PROMISE_STATUS_RESOLVED);
              mem.view.setUint32(absResult + PROMISE.VALUE, TYPE.ARRAY, true);
              mem.view.setUint32(absResult + PROMISE.VALUE + 4, 0, true);
              mem.view.setUint32(absResult + PROMISE.VALUE + 8, resultsArray, true);
              mem.view.setUint32(absResult + PROMISE.VALUE + 12, 0, true);

              const childWaiters = mem.popAllWaiters(resultPromise);
              for (const waiterIdentity of childWaiters) { const resultValue = mem.getPromiseValue(resultPromise);
              this._prepareWaiter(waiterIdentity.slot, waiterIdentity.generation, resultPromise, PROMISE_STATUS_RESOLVED, resultValue);
              spawnedContexts.push(waiterIdentity); }
              const childContexts = this.processHandlers(resultPromise);
              spawnedContexts.push(...childContexts);
            }
          }
        }

        continue;
      }

      if (callback === 0) {
        // No callback — pass through value to child promise
        mem.setPromiseStatus(handler.childPromise, status);
        mem.setPromiseValue(handler.childPromise, value.type, value.flags, value.lo, value.hi);

        // Settling the child may trigger its own handlers and waiters
        const childWaiters = mem.popAllWaiters(handler.childPromise);
        for (const waiterIdentity of childWaiters) { this._prepareWaiter(waiterIdentity.slot, waiterIdentity.generation, handler.childPromise, status, value);
        spawnedContexts.push(waiterIdentity); }
        const childContexts = this.processHandlers(handler.childPromise);
        spawnedContexts.push(...childContexts);
        continue;
      }

      // Spawn a callback context to run the handler
      const closurePointer = callback;
      const startInstruction = mem.view.getUint32(mem.abs(closurePointer + FUNCTION.START_INSTRUCTION), true);
      const capturedScope = mem.view.getUint32(mem.abs(closurePointer + FUNCTION.SCOPE), true);

      const callbackContext = mem.createConfiguredContext({
        scopePointer: capturedScope,
        instructionIndex: startInstruction,
        createChildScope: true,
      });

      // If finally handler, stash the original value in the child promise's VALUE field
      // so we can restore it on normal completion
      if (handler.isFinally) {
        mem.setPromiseValue(handler.childPromise, value.type, value.flags, value.lo, value.hi);
      }

      // Push the settled value as argument (unless finally — no args)
      if (!handler.isFinally) {
        const pendingPtr = mem.getContextPendingPointer(callbackContext);
        const absPtr = mem.abs(pendingPtr);
        mem.view.setUint32(absPtr, value.type, true);
        mem.view.setUint32(absPtr + 4, value.flags, true);
        mem.view.setUint32(absPtr + 8, value.lo, true);
        mem.view.setUint32(absPtr + 12, value.hi, true);
        mem.setContextPendingPointer(callbackContext, pendingPtr + 16);
      }

      // Push a call frame with ASYNC_PROMISE pointing to child promise
      // Use bit 0 to flag finally semantics, bit 1 for original-was-rejected
      // (promise pointers are aligned to at least 4 bytes)
      let asyncPromiseField = handler.childPromise;
      if (handler.isFinally) {
        asyncPromiseField |= 1;  // bit 0: isFinally
        if (status === PROMISE_STATUS_REJECTED) {
          asyncPromiseField |= 2;  // bit 1: original was rejected
        }
      }

      mem.pushFrame(
        callbackContext,
        startInstruction,
        mem.getContextScope(callbackContext),
        0,                              // astNode
        handler.isFinally ? 0 : 1       // argc: finally has no args, then/catch get the value
      );

      const stackPointer = mem.getContextCallStackPointer(callbackContext);
      const framePointer = stackPointer - FRAME_SIZE;
      mem.view.setUint32(mem.abs(framePointer + FRAME.ASYNC_PROMISE), asyncPromiseField, true);

      // Copy grants from the calling context's grant stack to the callback context
      // This is handled by the existing grant capture on closures

      spawnedContexts.push({
        slot: callbackContext,
        generation: mem.getContextGeneration(callbackContext),
      });
    }

    return spawnedContexts;
  }

  /**
   * Prepare a waiter context with a resolved/rejected value.
   * @param {number} waiterSlot - Context slot of the waiter
   * @param {number} waiterGeneration - Captured allocation generation
   * @param {number} promisePointer - The settled promise
   * @param {number} status - PROMISE_STATUS_RESOLVED or PROMISE_STATUS_REJECTED
   * @param {object} value - { type, flags, lo, hi }
   */
  _prepareWaiter(
    waiterSlot,
    waiterGeneration,
    promisePointer,
    status,
    value,
  ) {
    const mem = this.memoryImage;
    if (!mem.isContextIdentityLive(waiterSlot, waiterGeneration)) {
      this._reportStaleSettlement(waiterSlot, waiterGeneration);
      return false;
    }
    const pendingPtr = mem.getContextPendingPointer(waiterSlot);
    const absPtr = mem.abs(pendingPtr);
    mem.view.setUint32(absPtr, value.type, true);
    mem.view.setUint32(absPtr + 4, value.flags, true);
    mem.view.setUint32(absPtr + 8, value.lo, true);
    mem.view.setUint32(absPtr + 12, value.hi, true);
    mem.setContextPendingPointer(waiterSlot, pendingPtr + 16);

    if (status === PROMISE_STATUS_REJECTED) {
      mem.setResponseType(waiterSlot, RESPONSE_THROW);
    }
    mem.clearExitCondition(waiterSlot);

    // The waiter slot was parked on a promise (handleAwait
    // claimed an AWAITING_PROMISE ledger entry for it); the
    // settle just woke it. Free the entry — the slot is no
    // longer awaiting. _freeAwaitingPromise is a no-op when no
    // claim was recorded (ledger unset, or claim returned -1).
    this._freeAwaitingPromise(waiterSlot);
    return true;
  }

  // ===========================================================================
  // Marshalling
  // ===========================================================================

  /**
   * Create marshalling options for MemoryImage.
   * These callbacks handle External marker and closure conversion.
   * @param {number} contextSlot - Context for grant capture when wrapping closures
   * @returns {Object} - { marshal, unmarshal } callbacks
   */
  marshallingOptions(contextSlot) {
    return {
      // The marshal hook used to handle External / MsgpackRef / Promise here,
      // but those wrapper types are now detected globally via the detector
      // chain registered on MemoryImage at airlock init. Callers that need
      // a per-call override can still set options.marshal on writeValueAt
      // directly. Returning undefined here means "no override; let the
      // detector chain (and then generic marshalling) handle it."
      //
      // Closure marshalling (JS function → SS closure) is not currently
      // supported in either direction; writeValueAt's generic path throws
      // for typeof === 'function'.
      marshal: undefined,
      unmarshal: (type, dataLo, dataHi) => {
        if (type === TYPE.EXTERNAL) {
          // dataLo is the handle slot; produce a fresh Handle wrapper with
          // the current version. The slot is live because the heap walker
          // keeps it so (the value just came off the heap).
          return this.membrane.handleForSlot(dataLo);
        }
        if (type === TYPE.FUNCTION) {
          // Return a closure handle (not callable - caller invokes explicitly).
          // Needs contextSlot for grant capture; this is the unmarshal direction
          // (SS closure → JS handle), distinct from marshal (JS function → SS).
          return this.registerClosure(dataLo, contextSlot);
        }
        if (type === TYPE.OBJECT) {
          // A branded instance crosses the membrane
          // as its BACKING external handle — the host's own operations
          // (appendChild, dispatchEvent, ...) accept component instances
          // directly. Checks: brand flag, well-formed @externalBacking,
          // current handle version, and current-context authority over
          // the backing handle. A malformed or stale brand throws (the
          // caller's arg/result try/catch turns it into a vat TypeError).
          // Ordinary objects fall through to generic marshalling.
          const objectFlags = this.memoryImage.getObjectFlags(dataLo);
          if (objectFlags & OBJECT_FLAG.EXTERNAL_BACKED) {
            const brand = this.memoryImage.objectFindOwnProperty(
              dataLo,
              this.memoryImage.getBuiltinName(BUILTIN_NAME.EXTERNAL_BACKING));
            if (!brand || brand.type !== TYPE.EXTERNAL) {
              throw new TypeError(
                'Branded instance has a malformed external backing');
            }
            if (this.membrane._readHandleVersion(brand.lo) !== brand.hi) {
              throw new TypeError(
                'Branded instance has a stale external backing');
            }
            const activeGrantIds = new Set([
              ...this.memoryImage.getActiveGrantIds(contextSlot),
              ...this.membrane.rootGrantSlots(),
            ]);
            if (!this.membrane.checkBySlot(brand.lo, activeGrantIds)) {
              const declaredName =
                this.membrane.declarationNameBySlot(brand.lo) || `handle:${brand.lo}`;
              throw new TypeError(
                `${declaredName} requires a grant not in the current grant stack`);
            }
            return this.membrane.handleForSlot(brand.lo);
          }
          return undefined;
        }
        return undefined;  // Use default unmarshalling
      },
    };
  }

  /**
   * Register a SandScript closure and return a ClosureHandle wrapper.
   *
   * @param {number} closurePointer - Pointer to the closure in SS heap
   * @param {number} callerContext - Context slot to capture grants from
   * @param {*} [metadata] - Optional host-supplied identifier (msgpack-serializable);
   *   round-trips through snapshot/restore. Hosts use it to reattach the wrapper
   *   to their own listener tables after restore.
   * @returns {ClosureHandle}
   */
  registerClosure(closurePointer, callerContext, metadata = null) {
    if (metadata === null) {
      const retainedClosures = this.membrane.enumerateClosureHandles()
        .filter((entry) =>
          entry.closurePointer === closurePointer &&
          (entry.metadata === null || entry.metadata === undefined));
      if (retainedClosures.length === 1) {
        return retainedClosures[0].closureHandle;
      }
    }
    // Capture grants at registration time: interpreter grant stack + root grants.
    const capturedGrantSlots = new Set([
      ...this.memoryImage.getActiveGrantIds(callerContext),
      ...this.membrane.rootGrantSlots(),
    ]);

    const handle = this.membrane.registerClosureHandle(
      closurePointer, capturedGrantSlots, metadata,
    );

    // FinalizationRegistry: when the host drops its JS wrapper, free the SAB
    // slot. Registering once per slot is correct because the membrane's
    // wrapper cache returns the same JS identity for any subsequent
    // enumerate/forSlot calls — so all references to this slot will keep
    // the same wrapper alive, and the registry fires exactly once when
    // the last reference is collected.
    this.closureRegistry.register(handle, { slot: handle.slot, version: handle.version });

    return handle;
  }

  /**
   * Retain a live vat object and return its interned ObjectHandle
   * wrapper. Repeated
   * retention of the same object returns the same wrapper and bumps
   * its retain count.
   *
   * @param {number} objectPointer - HEADER pointer of a TYPE_OBJECT value
   * @param {number} callerContext - Context slot to capture grants from
   * @param {*} [metadata] - Optional host-supplied identifier
   * @returns {ObjectHandle}
   */
  retainObject(objectPointer, callerContext, metadata = null) {
    const capturedGrantSlots = new Set([
      ...this.memoryImage.getActiveGrantIds(callerContext),
      ...this.membrane.rootGrantSlots(),
    ]);
    const { handle, isNew } = this.membrane.retainObjectHandle(
      objectPointer, capturedGrantSlots, metadata,
    );
    if (isNew) {
      this.objectRegistry.register(handle, { slot: handle.slot, version: handle.version });
    }
    return handle;
  }

  /**
   * Drop one retention of an object handle. The SAB slot frees (and the
   * GC root disappears) when the retain count reaches zero. Throws
   * StaleObjectHandleError for a released or reallocated wrapper and on
   * retain-count underflow.
   *
   * @param {ObjectHandle} handle
   * @returns {boolean} true when this release freed the slot.
   */
  releaseObjectHandle(handle) {
    const slot = this.membrane._slotOfObjectHandle(handle);
    return this.membrane.releaseObjectHandleSlot(slot);
  }

  /**
   * Read a live object handle's heap HEADER pointer, or null when the
   * handle has been released.
   */
  getObjectPointer(handle) {
    const version = this.membrane._readObjectHandleVersion(handle.slot);
    if (version !== handle.version) return null;
    const pointer = this.membrane._readObjectPointer(handle.slot);
    return pointer === 0 ? null : pointer;
  }

  /**
   * True iff every grant captured at the object's first retention is
   * still active (mirrors areClosureGrantsActive).
   */
  areObjectGrantsActive(handle) {
    const slot = this.membrane._slotOfObjectHandle(handle);
    for (const grantSlot of this.membrane._readObjectCapturedGrantSet(slot)) {
      if (!this.membrane._isGrantActive(grantSlot)) return false;
    }
    return true;
  }

  /**
   * Enumerate live object handles (post-restore adoption walk). Same
   * shape as enumerateClosureHandles: register new wrappers with the
   * FinalizationRegistry exactly once.
   */
  enumerateObjectHandles() {
    const entries = this.membrane.enumerateObjectHandles();
    for (const entry of entries) {
      if (entry.isNewWrapper) {
        this.objectRegistry.register(entry.objectHandle, {
          slot: entry.objectHandle.slot,
          version: entry.objectHandle.version,
        });
      }
    }
    return entries;
  }

  /**
   * Replace an object handle's metadata (no version bump — mirrors
   * setClosureMetadata).
   */
  setObjectMetadata(handle, metadata) {
    const slot = this.membrane._slotOfObjectHandle(handle);
    this.membrane.setObjectMetadata(slot, metadata);
  }

  /**
   * Explicitly drop a closure handle. Frees the SAB slot immediately;
   * the wrapper is no longer valid (use will throw StaleClosureHandleError).
   * Hosts call this after restore for entries from enumerateClosureHandles
   * they don't want to keep.
   */
  dropClosureHandle(handle) {
    const slot = this.membrane._slotOfClosureHandle(handle);
    this.membrane._freeClosureHandleSlot(slot);
  }

  /**
   * Replace a closure handle's metadata.
   *
   * The auto-marshal path (drone-side function → host-side handle) registers
   * closures with `metadata: null` because it has no host-supplied annotation
   * to attach. Hosts that want to tag closures with structured metadata for
   * later reattachment via `enumerateClosureHandles().metadata` (e.g., on
   * snapshot/restore) call this method after receiving the auto-minted handle.
   *
   * Does NOT bump the wrapper's version — the same wrapper remains valid.
   * Hosts holding the handle in long-lived dispatch maps keep their
   * references intact.
   *
   * Throws `StaleClosureHandleError` if the wrapper has been dropped or
   * its slot reallocated.
   *
   * @param {ClosureHandle} handle
   * @param {*} metadata - msgpack-serializable, or null/undefined to clear.
   */
  setClosureMetadata(handle, metadata) {
    const slot = this.membrane._slotOfClosureHandle(handle);
    this.membrane.setClosureMetadata(slot, metadata);
  }

  // ===========================================================================
  // External Call Handling
  // ===========================================================================

  /**
   * Read the method/property name for the current external request,
   * bounded. A corrupt methodOffset must not blow the string table
   * while REPORTING the problem — that's the "intern bomb": readString
   * on a misaligned id used to return the rest of the string segment
   * as one giant string, the "has no method" message embedded it, and
   * createAndPushError's intern of that message threw, obscuring the
   * original bounds error.
   *
   * On an invalid id this pushes a bounded TypeError into the context,
   * sets the throw response, and returns null; callers translate null
   * into their path's threw-shape return.
   *
   * @param {number} contextSlot - The context making the request
   * @param {Object} request - mem.getExternalRequest(contextSlot) result
   * @param {string} kind - 'method' or 'property', for the message
   * @returns {string|null}
   */
  _readRequestNameBounded(contextSlot, request, kind) {
    const mem = this.memoryImage;
    try {
      return mem.readString(request.methodOffset);
    } catch (error) {
      if (!(error instanceof RangeError)) throw error;
      const declaredName = this.membrane.declarationNameBySlot(request.handleId)
        || `handle:${request.handleId}`;
      const errorMessage =
        `${declaredName}: external ${kind} access with invalid ` +
        `${kind}-name string id ${request.methodOffset} (${error.message})`;
      this._createAndPushErrorWithPressureRecovery(contextSlot,STATE.TYPE_ERROR_PROTOTYPE, errorMessage);
      mem.setResponseType(contextSlot, RESPONSE_THROW);
      return null;
    }
  }

  /**
   * Handle an external call from the interpreter.
   * Called when interpreter yields with EXIT_EXTERNAL_CALL.
   *
   * @param {number} contextSlot - The context making the external call
   * @param {number} fuel - Current remaining fuel
   * @param {Function} onResume - Optional callback when suspended context is ready to resume
   * @returns {Object} - { fuel, suspended? } - updated fuel and suspension flag
   */

  /**
   * Is the SS handle value behind this request
   * STALE? An SS external value now carries its slot version in data_hi, which
   * the WAT forwards as request.handleVersion. A fresh slot is version >= 1; a
   * reaped slot has its version bumped. So:
   *   - handleVersion === 0  → legacy/unversioned value, skip (back-compat).
   *   - handleVersion !== current slot version → stale (the slot was reaped,
   *     possibly reused by a different tenant). Reject.
   * On stale, push a recoverable TypeError and return true (caller throws).
   */
  _rejectIfStaleHandle(contextSlot, slot, handleVersion) {
    if (!handleVersion) return false; // 0 = unversioned/legacy → no check
    const current = this.membrane._readHandleVersion(slot);
    if (handleVersion === current) return false;
    const declaredName = this.membrane.declarationNameBySlot(slot) || `handle:${slot}`;
    this._createAndPushErrorWithPressureRecovery(
      contextSlot, STATE.TYPE_ERROR_PROTOTYPE,
      `${declaredName} is no longer available (stale handle: the underlying ` +
      `resource was released)`);
    this.memoryImage.setResponseType(contextSlot, RESPONSE_THROW);
    return true;
  }

  /**
   * Is the slot behind this request an ORPHAN from a previous vat life?
   * The membrane's handle table rides the restored bytes, so a handle
   * captured in a persisted closure still looks live after a respawn,
   * but its JS impl lives in `membrane._impls`, which is never serialized.
   * It exists only if this life’s capability setup re-bound the slot through
   * `ensureHandle` or `_bindImpl`. A live slot with no impl can never be
   * answered by anything host-side.
   *
   * The contract is to invalidate loudly: a named, catchable error tells
   * the drone to re-acquire the handle, and hooks.onOrphanedHandle lets the
   * embedder emit a platform event. This gate follows stale-handle detection
   * so a reaped slot keeps its own message, and precedes grant detection so
   * an orphan does not surface as a misleading authorization or missing-
   * method error.
   *
   * Evidence for "orphan" is the absence of BOTH bindings: no impl and no
   * handler/getter/setter registered for the slot this life
   * (`slotsWithHostRegistrations`). Impl alone is not required: a valid
   * resume path may re-bind handlers without re-binding an impl.
   */
  _rejectIfOrphanedHandle(contextSlot, slot, access) {
    if (!this.membrane._handleSlotIsLive(slot)) return false;
    if (this.membrane.lookupBySlot(slot) !== undefined) return false;
    if (this.slotsWithHostRegistrations.has(slot)) return false;
    const declaredName = this.membrane.declarationNameBySlot(slot) || `handle:${slot}`;
    this._createAndPushErrorWithPressureRecovery(
      contextSlot, STATE.TYPE_ERROR_PROTOTYPE,
      `${declaredName} did not survive respawn — the capability object this ` +
      `handle pointed at died with the previous process and was not re-bound ` +
      `in this vat life. Re-acquire it from its capability (reconnect) inside ` +
      `a catch for this error.`);
    this.memoryImage.setResponseType(contextSlot, RESPONSE_THROW);
    if (this.hooks.onOrphanedHandle) {
      try {
        this.hooks.onOrphanedHandle({ handleId: slot, declaredName, access });
      } catch { /* observability must never break dispatch */ }
    }
    return true;
  }

  handleExternalCall(contextSlot, fuel, onResume = null) {
    const mem = this.memoryImage;
    const request = mem.getExternalRequest(contextSlot);

    // methodOffset === 0 means direct call (no method name)
    // methodOffset > 0 means method call (read string at offset)
    const isDirectCall = request.methodOffset === 0;
    let methodName = null;
    if (!isDirectCall) {
      methodName = this._readRequestNameBounded(contextSlot, request, 'method');
      if (methodName === null) return { fuel, threw: true };
    }

    // Check if any grants on the context's stack have been revoked since
    // they were approved. This catches synchronous revocation — the grant
    // was revoked between steps (e.g., during a fuel pause) while the
    // context was still inside the grant block.
    const interpreterGrantIds = mem.getActiveGrantIds(contextSlot);
    let hasRevoked = false;
    for (const grantId of interpreterGrantIds) {
      const grant = this.membrane._getGrantById(grantId);
      if (!grant || !grant.active) {
        hasRevoked = true;
        break;
      }
    }
    if (hasRevoked) {
      this.triggerRevocationHandler(contextSlot);
      mem.clearExitCondition(contextSlot);
      return { fuel, threw: true };
    }

    // Check grant authorization before proceeding.
    // Combine interpreter's grant stack with root grants (always active).
    // request.handleId is a raw slot id read from the heap; use checkBySlot
    // (no Handle wrapper version validation — heap walker keeps slots live).
    const slot = request.handleId;
    // Reject a stale handle value (slot reaped underneath it) with a clean
    // recoverable error, BEFORE the grant check — otherwise a reaped slot
    // surfaces as a misleading "grant not in stack" (or, if reused, dispatches
    // to a different tenant).
    if (this._rejectIfStaleHandle(contextSlot, slot, request.handleVersion)) {
      return { fuel, threw: true };
    }
    if (this._rejectIfOrphanedHandle(contextSlot, slot,
          isDirectCall ? 'call' : `method '${methodName}'`)) {
      return { fuel, threw: true };
    }
    const activeGrantIds = new Set([...interpreterGrantIds, ...this.membrane.rootGrantSlots()]);
    if (!this.membrane.checkBySlot(slot, activeGrantIds)) {
      // Handle requires grants not satisfied by active grants - throw GrantDeniedError
      const declaredName = this.membrane.declarationNameBySlot(slot) || `handle:${slot}`;
      const errorMessage = `${declaredName} requires a grant not in the current grant stack`;
      this._createAndPushErrorWithPressureRecovery(contextSlot,STATE.GRANT_DENIED_ERROR_PROTOTYPE, errorMessage);
      mem.setResponseType(contextSlot, RESPONSE_THROW);
      return { fuel, threw: true };
    }

    // The three construction operations ride the
    // external-call exit with interned '@'-prefixed method names that
    // source code cannot spell. They dispatch to the constructible
    // registration, never to host method handlers, and manage their own
    // resume (super() resolves to undefined; completion and abort
    // resume valuelessly so the staged instruction retries cleanly).
    if (methodName === '@beginConstruction') {
      return this._handleConstructionBegin(contextSlot, fuel, slot, request, activeGrantIds, onResume);
    }
    if (methodName === '@completeConstruction') {
      return this._handleConstructionComplete(contextSlot, fuel, slot, request, activeGrantIds, onResume);
    }
    if (methodName === '@abortConstruction') {
      return this._handleConstructionAbort(contextSlot, fuel, slot, request, activeGrantIds, onResume);
    }

    const handlerKey = isDirectCall ? `${slot}` : `${slot}:${methodName}`;
    // An exact method registration takes
    // precedence; a method call may fall back to the handle's default
    // method handler (setDefaultHandler, key `slot:*`), which receives
    // the requested method name via context.method. A direct call
    // never falls back.
    const handler = this.handlers.get(handlerKey)
      ?? (!isDirectCall ? this.handlers.get(`${slot}:*`) : undefined);
    if (!handler) {
      // No explicit handler - throw proper error
      const declaredName = this.membrane.declarationNameBySlot(slot) || `handle:${slot}`;
      const errorMessage = isDirectCall
        ? `${declaredName} is not directly callable`
        : `${declaredName} has no method '${methodName}'`;
      this._createAndPushErrorWithPressureRecovery(contextSlot,STATE.TYPE_ERROR_PROTOTYPE, errorMessage);
      mem.setResponseType(contextSlot, RESPONSE_THROW);
      return { fuel, threw: true, handlerKey };
    }

    const options = this.marshallingOptions(contextSlot);

    // Thread per-handler coerceExact through to arg unmarshalling.
    // unmarshalArgs already applies the default integer-Rational unwrap;
    // 'float' additionally coerces non-integer Rationals to plain Numbers
    // and rejects Complex args at the External boundary.
    const perHandlerOptions = this.handlerOptions.get(handlerKey);
    if (perHandlerOptions && perHandlerOptions.coerceExact) {
      options.coerceExact = perHandlerOptions.coerceExact;
    }
    if (perHandlerOptions && perHandlerOptions.heapViewTypedArrays) {
      options.heapViewTypedArrays = true;
    }

    // Unmarshal args from SS heap
    let args;
    try {
      args = mem.unmarshalArgs(
        request.argsPointer,
        request.argCount,
        options
      );
    } catch (argError) {
      this._createAndPushErrorWithPressureRecovery(contextSlot,STATE.TYPE_ERROR_PROTOTYPE, argError.message);
      mem.setResponseType(contextSlot, RESPONSE_THROW);
      return { fuel, threw: true, handlerKey };
    }

    // Handler-selected argument retention. Each named top-level arg
    // whose RAW slot is a vat object becomes its interned ObjectHandle
    // (a collector root) instead of the unmarshalled copy or, for a branded
    // instance, its backing Handle.
    // Functions already unmarshal as ClosureHandles; primitives are
    // untouched.
    if (perHandlerOptions && perHandlerOptions.retainObjectArgumentIndexes) {
      for (const index of perHandlerOptions.retainObjectArgumentIndexes) {
        if (index >= request.argCount) continue;
        const rawSlot = mem.abs(request.argsPointer + index * 16);
        if (mem.view.getUint32(rawSlot, true) === TYPE.OBJECT) {
          args[index] = this.retainObject(
            mem.view.getUint32(rawSlot + 8, true), contextSlot);
        }
      }
    }

    // Convert Handle wrappers to actual objects for handler. Args were
    // already unmarshalled into Handle instances (see the unmarshal path
    // in marshallingOptions); lookupBySlot avoids re-validating the
    // version (the heap walker keeps the slot live).
    const unwrappedArgs = args.map(arg => {
      if (isHandle(arg)) {
        return this.membrane.lookupBySlot(arg.slot);
      }
      return arg;
    });

    // Build context object for handler. context.handle is the Handle
    // wrapper for the receiver.
    const context = new Context(this, contextSlot);
    context.handle = this.membrane.handleForSlot(request.handleId);
    context.method = methodName;
    context.register = (obj, meta) => this.register(obj, meta);

    const declaredName = this.membrane.declarationNameBySlot(slot) || null;

    if (this.hooks.onExternalCall) {
      this.hooks.onExternalCall({
        kind: 'call', slot: contextSlot, handleId: slot,
        declaredName, method: methodName, argCount: request.argCount,
      });
    }

    // The WAT pre-positioned the context's pending pointer to the slot where
    // the call's result should land before yielding EXIT_EXTERNAL_CALL — the
    // closure's slot for CALL paths (TYPE_EXTERNAL / TYPE_EXTERNAL_METHOD) and
    // the receiver's slot for the CALL_METHOD/TYPE_EXTERNAL_METHOD path. So
    // here we just leave it alone; marshalResult writes at the current pending
    // pointer and advances by VALUE_SIZE.

    try {
      // Call handler. `args` is the unwrapped form (Externals replaced with
      // their underlying objects via this.lookup); `rawArgs` preserves the
      // wrapper representation for handlers that need to re-marshal an
      // External back to SS memory without losing the wrapper type.
      const result = this._invokeWithSlotCapture(
        contextSlot,
        handler,
        { args: unwrappedArgs, rawArgs: args, context });

      // Check if handler returned a suspension marker
      if (result instanceof SuspensionMarker) {
        if (this.hooks.onExternalCall) {
          this.hooks.onExternalCall({
            kind: 'call-suspend', slot: contextSlot,
            handleId: slot, method: methodName,
          });
        }
        const resumeHook = onResume
          ?? ((identity) => { this._enqueueSpawnedContexts([identity]); });
        this._setupSuspension(contextSlot, result, options, activeGrantIds, resumeHook);
        return { fuel, suspended: true, handlerKey };
      }

      if (this.hooks.onExternalCall) {
        this.hooks.onExternalCall({
          kind: 'call-result', slot: contextSlot,
          handleId: slot, method: methodName,
        });
      }

      // Return the raw handler result. Disposition (marshal directly,
      // await first, etc.) is the caller's choice. The caller MUST follow
      // up with airlock.resumeWithValue(slot, ...) to actually resume the
      // slot — handleExternalCall no longer marshals automatically.
      return { fuel, result, handlerKey };
    } catch (e) {
      if (this.hooks.onExternalCall) {
        this.hooks.onExternalCall({
          kind: 'call-error', slot: contextSlot,
          handleId: slot, method: methodName, error: e,
        });
      }
      // Handler threw — propagate exception via RESPONSE_TYPE before returning.
      this.resumeWithThrow(contextSlot, e);
      return { fuel, threw: true, handlerKey };
    }
  }

  /**
   * Begin `super()` against a constructible external. The request
   * block carries the parent handle slot (grant-checked by the caller),
   * the construction args, the new.target closure pointer at +20, and
   * the pending pointer parked at the receiver's value slot.
   *
   * Runs the registration's beginConstruction(newTarget). The result
   * must be a live external Handle sharing a grant with the parent;
   * the receiver is then branded (@externalBacking with the parent
   * slot riding the entry's flags word, the pre-allocated
   * @constructionLink chain slot, EXTERNAL_BACKED |
   * CONSTRUCTION_PENDING) and super() resolves to undefined.
   */
  _handleConstructionBegin(contextSlot, fuel, parentSlot, request, activeGrantIds, onResume) {
    const mem = this.memoryImage;
    const registration = this.constructibleRegistrations.get(parentSlot);
    if (!registration) {
      this._createAndPushErrorWithPressureRecovery(
        contextSlot, STATE.TYPE_ERROR_PROTOTYPE, 'Illegal constructor');
      mem.setResponseType(contextSlot, RESPONSE_THROW);
      return { fuel, threw: true };
    }

    // The receiver sits at the parked pending pointer (the slot the
    // super() result will overwrite). Read it BEFORE anything can gc.
    const receiverSlotAddress = mem.abs(mem.getContextPendingPointer(contextSlot));
    const receiverPointer = mem.view.getUint32(receiverSlotAddress + 8, true);

    const constructionNewTarget =
      this._constructionNewTargetByContext.get(contextSlot);
    let newTarget = null;
    if (constructionNewTarget?.generation
        === mem.getContextGeneration(contextSlot)) {
      // Validate the retained slot/version immediately before lending the
      // handle to host code. _slotOfClosureHandle throws the normal stale-
      // handle error if the caller released or invalidated it meanwhile.
      this.membrane._slotOfClosureHandle(
        constructionNewTarget.closureHandle);
      newTarget = constructionNewTarget.closureHandle;
    } else {
      const requestBase = mem.getExternalRequestBase(contextSlot);
      const newTargetPointer =
        mem.view.getUint32(mem.abs(requestBase + 20), true);
      newTarget = newTargetPointer !== 0
        ? this.registerClosure(newTargetPointer, contextSlot, null)
        : null;
    }

    const finish = (backing) => {
      // The begin result must be a live external handle owned by a
      // grant the parent handle also carries.
      if (!isHandle(backing)
          || this.membrane._readHandleVersion(backing.slot) !== backing.version) {
        throw new TypeError('Construction returned no backing value');
      }
      const parentGrants = this.membrane._readHandleGrantSet(parentSlot);
      const backingGrants = this.membrane._readHandleGrantSet(backing.slot);
      let shared = false;
      for (const grantSlot of backingGrants) {
        if (parentGrants.has(grantSlot)) { shared = true; break; }
      }
      if (!shared) {
        throw new TypeError('Construction returned no backing value');
      }
      mem.brandExternalBackedReceiver(
        receiverPointer, backing.slot, backing.version, parentSlot);
    };

    try {
      // The trailing Context lets a constructible handler read
      // context.hostInvocationContext during host-initiated construction.
      const result = registration.beginConstruction(
        newTarget, new Context(this, contextSlot));
      if (result instanceof Promise) {
        const options = this.marshallingOptions(contextSlot);
        options.valuelessResume = false;
        // Async begin: brand on settle, then resume with undefined as
        // the super() result (the ordinary marshalled resume).
        const marker = new SuspensionMarker((resolve, reject) => {
          result.then((backing) => {
            try {
              finish(backing);
              resolve(undefined);
            } catch (finishError) {
              reject(finishError);
            }
          }, reject);
        });
        const resumeHook = onResume
          ?? ((identity) => { this._enqueueSpawnedContexts([identity]); });
        this._setupSuspension(contextSlot, marker, options, activeGrantIds, resumeHook);
        return { fuel, suspended: true };
      }
      finish(result);
      this.resumeWithValue(contextSlot, undefined);
      return { fuel, threw: true };
    } catch (e) {
      this.resumeWithThrow(contextSlot, e);
      return { fuel, threw: true };
    }
  }

  /**
   * Complete construction after the most-derived constructor frame returned with the
   * branded receiver as its final object. Retains the receiver as an
   * ObjectHandle, runs completeConstruction(backingHandle,
   * receiverObjectHandle), clears CONSTRUCTION_PENDING, and resumes the
   * staged RETURN valuelessly (the retry takes the ordinary return
   * tail once the flag is clear).
   */
  _handleConstructionComplete(contextSlot, fuel, parentSlot, request, activeGrantIds, onResume) {
    const mem = this.memoryImage;
    const requestBase = mem.getExternalRequestBase(contextSlot);
    const receiverPointer = mem.view.getUint32(mem.abs(requestBase + 20), true);

    const registration = this.constructibleRegistrations.get(parentSlot);
    if (!registration) {
      this._createAndPushErrorWithPressureRecovery(
        contextSlot, STATE.TYPE_ERROR_PROTOTYPE, 'Illegal constructor');
      mem.setResponseType(contextSlot, RESPONSE_THROW);
      return { fuel, threw: true };
    }

    const brand = mem.objectFindOwnProperty(
      receiverPointer, mem.getBuiltinName(BUILTIN_NAME.EXTERNAL_BACKING));
    if (!brand || brand.type !== TYPE.EXTERNAL) {
      this._createAndPushErrorWithPressureRecovery(
        contextSlot, STATE.TYPE_ERROR_PROTOTYPE, 'Construction returned no backing value');
      mem.setResponseType(contextSlot, RESPONSE_THROW);
      return { fuel, threw: true };
    }

    const clearPending = () => {
      mem.setObjectFlags(receiverPointer,
        mem.getObjectFlags(receiverPointer) & ~OBJECT_FLAG.CONSTRUCTION_PENDING);
    };

    try {
      const backingHandle = this.membrane.handleForSlot(brand.lo);
      const receiverMetadata =
        registration.receiverMetadata?.(backingHandle) ?? null;
      const receiverObjectHandle = this.retainObject(
        receiverPointer,
        contextSlot,
        receiverMetadata);
      if (receiverMetadata !== null) {
        this.setObjectMetadata(receiverObjectHandle, receiverMetadata);
      }
      const result = registration.completeConstruction(
        backingHandle, receiverObjectHandle, new Context(this, contextSlot));
      if (result instanceof Promise) {
        const options = this.marshallingOptions(contextSlot);
        options.valuelessResume = true;
        options.beforeValuelessResume = () => { clearPending(); };
        const marker = new SuspensionMarker((resolve, reject) => {
          result.then(() => resolve(undefined), reject);
        });
        const resumeHook = onResume
          ?? ((identity) => { this._enqueueSpawnedContexts([identity]); });
        this._setupSuspension(contextSlot, marker, options, activeGrantIds, resumeHook);
        return { fuel, suspended: true };
      }
      clearPending();
      mem.clearExitCondition(contextSlot);
      return { fuel, threw: true };
    } catch (e) {
      this.resumeWithThrow(contextSlot, e);
      return { fuel, threw: true };
    }
  }

  /**
   * Construction failure path: a pending construction was abandoned (constructor
   * throw unwound its frame, or the constructor returned a different
   * object). Runs abortConstruction(backingHandle) BEFORE the staged
   * instruction (typically the entered catch handler) executes, then
   * re-arms the duty chain for LIFO-nested constructions. An abort
   * failure is not swallowed: it becomes the reported error, with the
   * abandoned construction named as its cause.
   */
  _handleConstructionAbort(contextSlot, fuel, parentSlot, request, activeGrantIds, onResume) {
    const mem = this.memoryImage;
    const requestBase = mem.getExternalRequestBase(contextSlot);
    const receiverPointer = mem.view.getUint32(mem.abs(requestBase + 20), true);

    const rearmChain = () => {
      const link = mem.objectFindOwnProperty(
        receiverPointer, mem.getBuiltinName(BUILTIN_NAME.CONSTRUCTION_LINK));
      if (link && link.type === TYPE.OBJECT && link.lo !== 0) {
        const contextBase = mem.getContextBase(contextSlot);
        mem.view.setUint32(
          mem.abs(contextBase + CONTEXT_STATE_OFFSET + CTX.CONSTRUCTION_DUTY),
          link.lo, true);
      }
    };

    const registration = this.constructibleRegistrations.get(parentSlot);
    const brand = mem.objectFindOwnProperty(
      receiverPointer, mem.getBuiltinName(BUILTIN_NAME.EXTERNAL_BACKING));
    if (!registration || !brand || brand.type !== TYPE.EXTERNAL) {
      // An unbound parent (the capability did not re-register after
      // restore) fails the construction loudly.
      rearmChain();
      this._createAndPushErrorWithPressureRecovery(
        contextSlot, STATE.TYPE_ERROR_PROTOTYPE, 'Illegal constructor');
      mem.setResponseType(contextSlot, RESPONSE_THROW);
      return { fuel, threw: true };
    }

    const abortFailure = (e) => {
      const failure = e instanceof Error ? e : new Error(String(e));
      failure.kind = 'construction-abort-failure';
      failure.details = { cause: 'external construction was abandoned' };
      return failure;
    };

    try {
      const backingHandle = this.membrane.handleForSlot(brand.lo);
      const result = registration.abortConstruction(
        backingHandle, new Context(this, contextSlot));
      if (result instanceof Promise) {
        const options = this.marshallingOptions(contextSlot);
        options.valuelessResume = true;
        options.beforeValuelessResume = () => { rearmChain(); };
        const marker = new SuspensionMarker((resolve, reject) => {
          result.then(() => resolve(undefined),
            (e) => reject(abortFailure(e)));
        });
        const resumeHook = onResume
          ?? ((identity) => { this._enqueueSpawnedContexts([identity]); });
        this._setupSuspension(contextSlot, marker, options, activeGrantIds, resumeHook);
        return { fuel, suspended: true };
      }
      rearmChain();
      mem.clearExitCondition(contextSlot);
      return { fuel, threw: true };
    } catch (e) {
      rearmChain();
      this.resumeWithThrow(contextSlot, abortFailure(e));
      return { fuel, threw: true };
    }
  }

  /**
   * Read a receiver's construction-duty state for host-driven
   * construction (Runtime.constructClosure). Host construction runs the
   * constructor body as the context's top level — no
   * FRAME_FLAG_CONSTRUCTOR frame exists, so the in-vat completion and
   * abort staging never fires; the runtime performs the duties itself
   * through these helpers.
   *
   * @param {ObjectHandle} receiverHandle
   * @returns {null | {backingSlot: number, parentSlot: number}}
   *   null when the receiver has no pending construction.
   */
  readPendingConstruction(receiverHandle) {
    const mem = this.memoryImage;
    const receiverPointer = this.getObjectPointer(receiverHandle);
    if (receiverPointer === null) return null;
    if ((mem.getObjectFlags(receiverPointer) & OBJECT_FLAG.CONSTRUCTION_PENDING) === 0) {
      return null;
    }
    const brand = mem.objectFindOwnProperty(
      receiverPointer, mem.getBuiltinName(BUILTIN_NAME.EXTERNAL_BACKING));
    if (!brand || brand.type !== TYPE.EXTERNAL) {
      throw new TypeError('Construction returned no backing value');
    }
    return { backingSlot: brand.lo, parentSlot: brand.flags - 1 };
  }

  /**
   * Run completeConstruction for a host-driven construction.
   * Mirrors _handleConstructionComplete minus the vat resume: clears
   * CONSTRUCTION_PENDING on success (async: after settle); a handler
   * failure propagates unchanged.
   */
  async completeHostConstruction(receiverHandle, pending) {
    const registration = this.constructibleRegistrations.get(pending.parentSlot);
    if (!registration) {
      throw new TypeError('Illegal constructor');
    }
    const backingHandle = this.membrane.handleForSlot(pending.backingSlot);
    const receiverMetadata =
      registration.receiverMetadata?.(backingHandle) ?? null;
    if (receiverMetadata !== null) {
      this.setObjectMetadata(receiverHandle, receiverMetadata);
    }
    await registration.completeConstruction(backingHandle, receiverHandle);
    const mem = this.memoryImage;
    const receiverPointer = this.getObjectPointer(receiverHandle);
    mem.setObjectFlags(receiverPointer,
      mem.getObjectFlags(receiverPointer) & ~OBJECT_FLAG.CONSTRUCTION_PENDING);
  }

  /**
   * Run abortConstruction for an abandoned host-driven
   * construction. Clears CONSTRUCTION_PENDING first (the duty fires
   * exactly once); an abort failure is not swallowed — it is thrown
   * with the original construction failure attached as its cause.
   */
  async abortHostConstruction(receiverHandle, pending, originalFailure) {
    const mem = this.memoryImage;
    const receiverPointer = this.getObjectPointer(receiverHandle);
    if (receiverPointer !== null) {
      mem.setObjectFlags(receiverPointer,
        mem.getObjectFlags(receiverPointer) & ~OBJECT_FLAG.CONSTRUCTION_PENDING);
    }
    const registration = this.constructibleRegistrations.get(pending.parentSlot);
    if (!registration) {
      throw new TypeError('Illegal constructor');
    }
    const backingHandle = this.membrane.handleForSlot(pending.backingSlot);
    try {
      await registration.abortConstruction(backingHandle);
    } catch (e) {
      const failure = e instanceof Error ? e : new Error(String(e));
      failure.kind = 'construction-abort-failure';
      failure.cause = originalFailure;
      throw failure;
    }
  }

  /**
   * Resolve the semantic kind of one external member. Exact adapters define
   * their member before the dynamic inspector runs. A null result means the
   * handle has no inspector and must use the legacy dispatch rules.
   */
  _classifyExternalMember(contextSlot, slot, name) {
    const exactKey = `${slot}:${name}`;
    if (this.getters.has(exactKey)) {
      return {
        kind: 'data',
        writable: this.setters.has(exactKey) || this.setters.has(`${slot}:*`),
      };
    }
    if (this.handlers.has(exactKey)) {
      return { kind: 'method' };
    }
    if (this.setters.has(exactKey)) {
      return { kind: 'data', writable: true };
    }

    const inspector = this.memberInspectors.get(slot);
    if (!inspector) return null;

    const context = new Context(this, contextSlot);
    context.handle = this.membrane.handleForSlot(slot);
    context.method = name;
    context.register = (obj, meta) => this.register(obj, meta);
    const classification = this._invokeWithSlotCapture(
      contextSlot, inspector, { name, context });
    const declaredName = this.membrane.declarationNameBySlot(slot) || `handle:${slot}`;
    if (classification === null || typeof classification !== 'object'
        || Array.isArray(classification)
        || !Object.prototype.hasOwnProperty.call(classification, 'kind')
        || typeof classification.kind !== 'string') {
      throw new TypeError(
        `Member inspector for ${declaredName}.${name} returned a malformed result`);
    }

    if (classification.kind !== 'absent'
        && classification.kind !== 'data'
        && classification.kind !== 'method') {
      throw new TypeError(
        `Member inspector for ${declaredName}.${name} returned unknown kind '${classification.kind}'`);
    }

    const keys = Reflect.ownKeys(classification);
    if (classification.kind === 'data') {
      if (keys.length !== 2 || !keys.includes('writable')
          || typeof classification.writable !== 'boolean') {
        throw new TypeError(
          `Member inspector for ${declaredName}.${name} returned malformed data`);
      }
      return { kind: 'data', writable: classification.writable };
    }
    if (keys.length !== 1) {
      throw new TypeError(
        `Member inspector for ${declaredName}.${name} returned malformed ${classification.kind}`);
    }
    return { kind: classification.kind };
  }

  /**
   * Called when interpreter yields with EXIT_EXTERNAL_PROPERTY.
   *
   * Drone code did `external.propName` without a call. Exact registrations
   * or the member inspector classify the name before a default adapter runs.
   * Data runs an exact/default getter, method emits TYPE_EXTERNAL_METHOD, and
   * absent resumes with undefined. A handle without an inspector keeps the
   * legacy getter-or-method behavior.
   *
   * A getter may return a value (marshalled and pushed by the caller via
   * resumeWithValue), a Promise (caller decides; session.js parks via
   * suspendOnPromise), or a SuspensionMarker (parked here via
   * _setupSuspension, mirroring the method-side path). Always-unwrap for
   * properties: there is no opt-in flag, because `obj.foo` and
   * `await obj.foo` are spelled differently in drone code and the getter
   * has no way to know which the drone wrote.
   *
   * Return shape mirrors handleExternalCall:
   *   { fuel }                                — method binding, or grant
   *                                             denial / revocation
   *   { fuel, threw: true }                   — absent already resumed, or
   *                                             classification/getter threw
   *   { fuel, suspended: true }               — getter returned a
   *                                             SuspensionMarker; setup
   *                                             complete, slot parked
   *   { fuel, result }                        — getter returned a value
   *                                             (possibly a Promise); caller
   *                                             must follow up with
   *                                             resumeWithValue or
   *                                             suspendOnPromise
   *
   * @param {number} contextSlot - The context reading the property
   * @param {number} fuel - Current remaining fuel
   * @returns {Object}
   */
  handleExternalProperty(contextSlot, fuel) {
    const mem = this.memoryImage;
    const request = mem.getExternalRequest(contextSlot);
    const propName = this._readRequestNameBounded(contextSlot, request, 'property');
    if (propName === null) return { fuel };

    // Grant authorization, mirroring handleExternalCall. A property read on
    // a handle the drone can't see is a grant violation, same as a method
    // call would be.
    const interpreterGrantIds = mem.getActiveGrantIds(contextSlot);
    let hasRevoked = false;
    for (const grantId of interpreterGrantIds) {
      const grant = this.membrane._getGrantById(grantId);
      if (!grant || !grant.active) {
        hasRevoked = true;
        break;
      }
    }
    if (hasRevoked) {
      this.triggerRevocationHandler(contextSlot);
      mem.clearExitCondition(contextSlot);
      return { fuel };
    }

    const slot = request.handleId;
    // Reject a stale handle value before the grant check (see handleExternalCall).
    if (this._rejectIfStaleHandle(contextSlot, slot, request.handleVersion)) {
      return { fuel };
    }
    if (this._rejectIfOrphanedHandle(contextSlot, slot, `property '${propName}'`)) {
      return { fuel };
    }
    const activeGrantIds = new Set([...interpreterGrantIds, ...this.membrane.rootGrantSlots()]);
    if (!this.membrane.checkBySlot(slot, activeGrantIds)) {
      const declaredName = this.membrane.declarationNameBySlot(slot) || `handle:${slot}`;
      const errorMessage = `${declaredName} requires a grant not in the current grant stack`;
      this._createAndPushErrorWithPressureRecovery(contextSlot,STATE.GRANT_DENIED_ERROR_PROTOTYPE, errorMessage);
      mem.setResponseType(contextSlot, RESPONSE_THROW);
      return { fuel };
    }

    // A nonzero receiver pointer marks a branded-instance forward. Exact
    // registrations define their member first. Otherwise, a member inspector
    // classifies both plain handles and branded backing handles before a
    // default getter or default handler can choose the wrong semantics.
    const brandedReceiver = mem.view.getUint32(
      mem.abs(mem.getExternalRequestBase(contextSlot) + 20), true);
    let classification;
    try {
      classification = this._classifyExternalMember(contextSlot, slot, propName);
    } catch (classificationError) {
      this.resumeWithThrow(contextSlot, classificationError);
      return { fuel, threw: true };
    }

    let getter;
    if (classification !== null) {
      if (classification.kind === 'absent') {
        this.resumeWithValue(contextSlot, undefined);
        return { fuel, threw: true };
      }
      if (classification.kind === 'data') {
        getter = this.getters.get(`${slot}:${propName}`)
          ?? this.getters.get(`${slot}:*`);
        if (!getter) {
          const declaredName = this.membrane.declarationNameBySlot(slot) || `handle:${slot}`;
          this.resumeWithThrow(
            contextSlot,
            new TypeError(`${declaredName} has no getter adapter for data property '${propName}'`));
          return { fuel, threw: true };
        }
      }
    } else if (brandedReceiver !== 0) {
      // Legacy branded registrations use the separate presence probe.
      const hasProperty = this.hasPropertyHandlers.get(slot);
      if (!hasProperty) {
        const declaredName = this.membrane.declarationNameBySlot(slot) || `handle:${slot}`;
        this._createAndPushErrorWithPressureRecovery(
          contextSlot, STATE.TYPE_ERROR_PROTOTYPE,
          `${declaredName} has no presence probe registered (setHasProperty)`);
        mem.setResponseType(contextSlot, RESPONSE_THROW);
        return { fuel, threw: true };
      }
      let present;
      try {
        present = hasProperty({ name: propName, context: new Context(this, contextSlot) });
      } catch (probeError) {
        this.resumeWithThrow(contextSlot, probeError);
        return { fuel, threw: true };
      }
      if (!present) {
        this.resumeWithValue(contextSlot, undefined);
        return { fuel, threw: true };
      }
      getter = this.getters.get(`${slot}:${propName}`)
        ?? this.getters.get(`${slot}:*`);
    } else {
      getter = this.getters.get(`${slot}:${propName}`);
    }

    if (!getter) {
      const pendingPointer = mem.getContextPendingPointer(contextSlot);
      const absolute = mem.abs(pendingPointer);
      mem.view.setUint32(absolute, TYPE.EXTERNAL_METHOD, true);
      mem.view.setUint32(absolute + 4, 0, true);
      mem.view.setUint32(absolute + 8, slot, true);
      mem.view.setUint32(absolute + 12, request.methodOffset, true);
      mem.setContextPendingPointer(contextSlot, pendingPointer + 16);
      mem.clearExitCondition(contextSlot);
      return { fuel };
    }

    const declaredName = this.membrane.declarationNameBySlot(slot) || null;

    if (this.hooks.onExternalCall) {
      this.hooks.onExternalCall({
        kind: 'property-read', slot: contextSlot,
        handleId: slot, declaredName, property: propName,
      });
    }

    const context = new Context(this, contextSlot);
    context.handle = this.membrane.handleForSlot(slot);
    context.method = propName;
    context.register = (obj, meta) => this.register(obj, meta);

    try {
      const result = this._invokeWithSlotCapture(
        contextSlot, getter, { name: propName, propName, context });

      // Getter returned a SuspensionMarker via context.suspend(...). Park
      // the slot using the same primitive the method side uses; the
      // marker's asyncCallback drives resume/throw. The onResume hook
      // routes the slot through _enqueueSpawnedContexts so polling
      // embedders (and signal-driven ones via onPendingSpawnedContexts)
      // pick up the resume — same path suspendOnPromise wires.
      if (result instanceof SuspensionMarker) {
        if (this.hooks.onExternalCall) {
          this.hooks.onExternalCall({
            kind: 'property-read-suspend', slot: contextSlot,
            handleId: slot, property: propName,
          });
        }
        const options = this.marshallingOptions(contextSlot);
        const onResume = (identity) => {
          this._enqueueSpawnedContexts([identity]);
        };
        this._setupSuspension(contextSlot, result, options, activeGrantIds, onResume);
        return { fuel, suspended: true };
      }

      if (this.hooks.onExternalCall) {
        this.hooks.onExternalCall({
          kind: 'property-read-result', slot: contextSlot,
          handleId: slot, property: propName,
        });
      }

      // Return the raw result. session.js decides: Promise → suspend on
      // settle; everything else → resumeWithValue. Mirrors
      // handleExternalCall's return shape.
      return { fuel, result };
    } catch (e) {
      if (this.hooks.onExternalCall) {
        this.hooks.onExternalCall({
          kind: 'property-read-error', slot: contextSlot,
          handleId: slot, property: propName, error: e,
        });
      }
      this.resumeWithThrow(contextSlot, e);
      return { fuel, threw: true };
    }
  }

  /**
   * Shared front half of the two branded-forward boolean exits
   * (EXIT_EXTERNAL_HAS_PROPERTY / EXIT_EXTERNAL_DELETE_PROPERTY).
   * The WAT already advanced the
   * pc past the parked instruction and pre-positioned the pending
   * stack; the caller resumes with a boolean via resumeWithValue (or
   * suspends on a Promise result in session.run).
   *
   * Performs the same authorization ladder as handleExternalProperty:
   * revocation sweep, stale-handle rejection, orphaned-handle
   * gate, grant check. Returns null when it already serviced the exit
   * (error pushed), else { slot, propName }.
   */
  _authorizeBrandedBooleanExit(contextSlot, operationLabel) {
    const mem = this.memoryImage;
    const request = mem.getExternalRequest(contextSlot);
    const propName = this._readRequestNameBounded(contextSlot, request, 'property');
    if (propName === null) return null;

    const interpreterGrantIds = mem.getActiveGrantIds(contextSlot);
    let hasRevoked = false;
    for (const grantId of interpreterGrantIds) {
      const grant = this.membrane._getGrantById(grantId);
      if (!grant || !grant.active) {
        hasRevoked = true;
        break;
      }
    }
    if (hasRevoked) {
      this.triggerRevocationHandler(contextSlot);
      mem.clearExitCondition(contextSlot);
      return null;
    }

    const slot = request.handleId;
    if (this._rejectIfStaleHandle(contextSlot, slot, request.handleVersion)) {
      return null;
    }
    if (this._rejectIfOrphanedHandle(contextSlot, slot,
        `${operationLabel} '${propName}'`)) {
      return null;
    }
    const activeGrantIds = new Set([
      ...interpreterGrantIds, ...this.membrane.rootGrantSlots()]);
    if (!this.membrane.checkBySlot(slot, activeGrantIds)) {
      const declaredName = this.membrane.declarationNameBySlot(slot) || `handle:${slot}`;
      const errorMessage = `${declaredName} requires a grant not in the current grant stack`;
      this._createAndPushErrorWithPressureRecovery(
        contextSlot, STATE.GRANT_DENIED_ERROR_PROTOTYPE, errorMessage);
      mem.setResponseType(contextSlot, RESPONSE_THROW);
      return null;
    }
    return { slot, propName };
  }

  /**
   * Service EXIT_EXTERNAL_HAS_PROPERTY. `key in brandedInstance` missed
   * every vat own entry and the
   * prototype chain; ask the backing value through the registered
   * presence probe. Deterministic — never a getter. Missing
   * registration throws; absence is never inferred from a failure.
   *
   * Return shape mirrors handleExternalProperty:
   *   { fuel }               — already serviced (error pushed)
   *   { fuel, threw: true }  — probe threw (throw staged)
   *   { fuel, result }       — session resumes with Boolean(result),
   *                            suspending first on a Promise
   */
  handleExternalHasProperty(contextSlot, fuel) {
    const authorized = this._authorizeBrandedBooleanExit(contextSlot, 'presence of');
    if (authorized === null) return { fuel };
    const { slot, propName } = authorized;
    try {
      const classification = this._classifyExternalMember(contextSlot, slot, propName);
      if (classification !== null) {
        return { fuel, result: classification.kind !== 'absent' };
      }
    } catch (classificationError) {
      this.resumeWithThrow(contextSlot, classificationError);
      return { fuel, threw: true };
    }


    const hasProperty = this.hasPropertyHandlers.get(slot);
    if (!hasProperty) {
      const declaredName = this.membrane.declarationNameBySlot(slot) || `handle:${slot}`;
      this._createAndPushErrorWithPressureRecovery(
        contextSlot, STATE.TYPE_ERROR_PROTOTYPE,
        `${declaredName} has no presence probe registered (setHasProperty)`);
      this.memoryImage.setResponseType(contextSlot, RESPONSE_THROW);
      return { fuel, threw: true };
    }

    const context = new Context(this, contextSlot);
    context.handle = this.membrane.handleForSlot(slot);
    context.method = propName;
    try {
      const result = hasProperty({ name: propName, context });
      return { fuel, result };
    } catch (e) {
      this.resumeWithThrow(contextSlot, e);
      return { fuel, threw: true };
    }
  }

  /**
   * Service EXIT_EXTERNAL_DELETE_PROPERTY.
   * `delete brandedInstance.key` found no vat own entry; route the
   * deletion to the backing value through the registered deletion
   * handler. The host implements presence and deletion without calling
   * a getter: a missing property returns true, a failed host deletion
   * returns false. Missing registration throws.
   *
   * Return shape mirrors handleExternalHasProperty.
   */
  handleExternalDeleteProperty(contextSlot, fuel) {
    const authorized = this._authorizeBrandedBooleanExit(contextSlot, 'deletion of');
    if (authorized === null) return { fuel };
    const { slot, propName } = authorized;

    const deleteProperty = this.deletePropertyHandlers.get(slot);
    if (!deleteProperty) {
      const declaredName = this.membrane.declarationNameBySlot(slot) || `handle:${slot}`;
      this._createAndPushErrorWithPressureRecovery(
        contextSlot, STATE.TYPE_ERROR_PROTOTYPE,
        `${declaredName} has no deletion handler registered (setDeleteProperty)`);
      this.memoryImage.setResponseType(contextSlot, RESPONSE_THROW);
      return { fuel, threw: true };
    }

    const context = new Context(this, contextSlot);
    context.handle = this.membrane.handleForSlot(slot);
    context.method = propName;
    try {
      const result = deleteProperty({ name: propName, context });
      return { fuel, result };
    } catch (e) {
      this.resumeWithThrow(contextSlot, e);
      return { fuel, threw: true };
    }
  }

  /**
   * Service EXIT_CLASS_LINK_EXTERNAL.
   *
   * CLASS_LINK found a TYPE_EXTERNAL parent and yielded WITHOUT
   * consuming its operands and WITHOUT advancing the pc. The request
   * block carries [handleSlot, handleVersion]. This method:
   *
   *   1. rejects a stale handle value;
   *   2. throws the catchable TypeError "This external cannot be
   *      extended" for a handle with no constructible registration
   *      (the membrane flag is the persisted truth — a restored vat
   *      whose capability re-registered passes, one that did not
   *      fails loudly here);
   *   3. throws the existing membrane authorization error when the
   *      context does not hold the handle's grant;
   *   4. interns ONE surrogate prototype per handle (an ordinary
   *      object whose [[proto]] is %ObjectPrototype%), records it in
   *      the membrane (GC root, forwarded on compaction); and
   *   5. stages the surrogate pointer in the request block (+8
   *      marker, +12 pointer) and clears the exit so the interpreter
   *      re-dispatches CLASS_LINK and completes the link in-vat.
   *
   * No host/capability code runs — linking stays synchronous.
   */
  handleClassLinkExternal(contextSlot) {
    const mem = this.memoryImage;
    const requestBase = mem.getExternalRequestBase(contextSlot);
    const handleSlot = mem.view.getUint32(mem.abs(requestBase), true);
    const handleVersion = mem.view.getUint32(mem.abs(requestBase + 4), true);

    if (this._rejectIfStaleHandle(contextSlot, handleSlot, handleVersion)) {
      return;
    }

    if (!this.membrane.isHandleConstructible(handleSlot)) {
      this._createAndPushErrorWithPressureRecovery(
        contextSlot, STATE.TYPE_ERROR_PROTOTYPE,
        'This external cannot be extended');
      mem.setResponseType(contextSlot, RESPONSE_THROW);
      mem.clearExitCondition(contextSlot);
      return;
    }

    // Grant authorization, mirroring handleExternalProperty: naming an
    // external as a class parent is an access like any other.
    const interpreterGrantIds = mem.getActiveGrantIds(contextSlot);
    const activeGrantIds = new Set([
      ...interpreterGrantIds, ...this.membrane.rootGrantSlots()]);
    if (!this.membrane.checkBySlot(handleSlot, activeGrantIds)) {
      const declaredName = this.membrane.declarationNameBySlot(handleSlot) || `handle:${handleSlot}`;
      const errorMessage = `${declaredName} requires a grant not in the current grant stack`;
      this._createAndPushErrorWithPressureRecovery(
        contextSlot, STATE.GRANT_DENIED_ERROR_PROTOTYPE, errorMessage);
      mem.setResponseType(contextSlot, RESPONSE_THROW);
      mem.clearExitCondition(contextSlot);
      return;
    }

    let surrogate = this.membrane.readSurrogatePointer(handleSlot);
    if (surrogate === 0) {
      surrogate = mem.allocateObject(0);
      mem.setObjectPrototype(
        surrogate, mem.view.getUint32(mem.abs(STATE.OBJECT_PROTOTYPE), true));
      this.membrane.writeSurrogatePointer(handleSlot, surrogate);
    }

    mem.view.setUint32(mem.abs(requestBase + 8), 1, true);
    mem.view.setUint32(mem.abs(requestBase + 12), surrogate, true);
    mem.clearExitCondition(contextSlot);
  }

  /**
   * Service EXIT_INSTANCEOF_EXTERNAL. Same staging protocol as
   * handleClassLinkExternal, but read-only: a handle with a surrogate
   * stages its pointer for the in-vat chain walk; a handle with no
   * surrogate throws the existing not-callable TypeError. Deterministic
   * and grant-free — the walk confers no authority.
   */
  handleInstanceofExternal(contextSlot) {
    const mem = this.memoryImage;
    const requestBase = mem.getExternalRequestBase(contextSlot);
    const handleSlot = mem.view.getUint32(mem.abs(requestBase), true);
    const handleVersion = mem.view.getUint32(mem.abs(requestBase + 4), true);

    if (this._rejectIfStaleHandle(contextSlot, handleSlot, handleVersion)) {
      return;
    }

    const surrogate = this.membrane.readSurrogatePointer(handleSlot);
    if (surrogate === 0) {
      this._createAndPushErrorWithPressureRecovery(
        contextSlot, STATE.TYPE_ERROR_PROTOTYPE, 'Not a function');
      mem.setResponseType(contextSlot, RESPONSE_THROW);
      mem.clearExitCondition(contextSlot);
      return;
    }

    mem.view.setUint32(mem.abs(requestBase + 8), 1, true);
    mem.view.setUint32(mem.abs(requestBase + 12), surrogate, true);
    mem.clearExitCondition(contextSlot);
  }

  /**
   * Called when interpreter yields with EXIT_EXTERNAL_PROPERTY_SET.
   *
   * Drone code did `external.propName = value` (member-assignment). The
   * write-side twin of handleExternalProperty. The interpreter has popped
   * the value and the receiver from the pending stack and yielded; the
   * external_request block carries the handle slot (handleId), the property
   * name (methodOffset), and a single arg slot holding the assigned value
   * (argsPointer / argCount === 1). The WAT pre-positioned the context's
   * pending pointer to the receiver's slot, where the assignment's value —
   * an assignment is an expression — should land on resume.
   *
   * The Airlock classifies the member before it unmarshals the assigned
   * value. Writable data runs an exact/default setter. Read-only data,
   * methods, and absent plain-external members throw. An absent branded
   * member stages a retry that creates a vat expando.
   *
   * A synchronous setter resumes with the assigned value. A setter that
   * returns a Promise or SuspensionMarker parks until settlement. Success
   * still resumes with the original assigned value.
   *
   * Return shape mirrors handleExternalProperty:
   *   { fuel }                    — grant denial / revocation (error pushed)
   *   { fuel, threw: true }       — no setter, bad arg, or setter threw
   *   { fuel, suspended: true }   — setter returned a SuspensionMarker
   *   { fuel, result }            — setter ran; `result` is the assigned
   *                                 value (session.js resumes the slot;
   *                                 Promise → suspend on settle)
   *
   * @param {number} contextSlot - The context performing the assignment
   * @param {number} fuel - Current remaining fuel
   * @returns {Object}
   */
  handleExternalPropertySet(contextSlot, fuel) {
    const mem = this.memoryImage;
    const request = mem.getExternalRequest(contextSlot);
    const propName = this._readRequestNameBounded(contextSlot, request, 'property');
    if (propName === null) return { fuel, threw: true };

    // Grant authorization, mirroring handleExternalProperty. A property
    // write on a handle the drone can't see is a grant violation, same as a
    // read or a method call would be.
    const interpreterGrantIds = mem.getActiveGrantIds(contextSlot);
    let hasRevoked = false;
    for (const grantId of interpreterGrantIds) {
      const grant = this.membrane._getGrantById(grantId);
      if (!grant || !grant.active) {
        hasRevoked = true;
        break;
      }
    }
    if (hasRevoked) {
      this.triggerRevocationHandler(contextSlot);
      mem.clearExitCondition(contextSlot);
      return { fuel };
    }

    const slot = request.handleId;
    // Reject a stale handle value before the grant check (see handleExternalCall).
    if (this._rejectIfStaleHandle(contextSlot, slot, request.handleVersion)) {
      return { fuel };
    }
    if (this._rejectIfOrphanedHandle(contextSlot, slot, `set property '${propName}'`)) {
      return { fuel };
    }
    const activeGrantIds = new Set([...interpreterGrantIds, ...this.membrane.rootGrantSlots()]);
    if (!this.membrane.checkBySlot(slot, activeGrantIds)) {
      const declaredName = this.membrane.declarationNameBySlot(slot) || `handle:${slot}`;
      const errorMessage = `${declaredName} requires a grant not in the current grant stack`;
      this._createAndPushErrorWithPressureRecovery(contextSlot,STATE.GRANT_DENIED_ERROR_PROTOTYPE, errorMessage);
      mem.setResponseType(contextSlot, RESPONSE_THROW);
      return { fuel };
    }

    // A branded write parks at the same instruction so absence can create a
    // vat expando. A present dynamic member advances once and then follows
    // the same data-writability rules as a plain external handle.
    const requestBase = mem.getExternalRequestBase(contextSlot);
    const brandedReceiver = mem.view.getUint32(mem.abs(requestBase + 20), true);
    let classification;
    try {
      classification = this._classifyExternalMember(contextSlot, slot, propName);
    } catch (classificationError) {
      this.resumeWithThrow(contextSlot, classificationError);
      return { fuel, threw: true };
    }

    if (classification !== null) {
      if (brandedReceiver !== 0) {
        if (classification.kind === 'absent') {
          mem.view.setUint32(mem.abs(requestBase + 24), 1, true);
          mem.setContextPendingPointer(contextSlot, request.argsPointer + 16);
          mem.clearExitCondition(contextSlot);
          return { fuel };
        }
        mem.setContextInstructionIndex(
          contextSlot, mem.getContextInstructionIndex(contextSlot) + 1);
      }

      const declaredName = this.membrane.declarationNameBySlot(slot) || `handle:${slot}`;
      if (classification.kind === 'absent') {
        this._createAndPushErrorWithPressureRecovery(
          contextSlot, STATE.TYPE_ERROR_PROTOTYPE,
          `${declaredName} has no data property '${propName}'`);
        mem.setResponseType(contextSlot, RESPONSE_THROW);
        return { fuel, threw: true };
      }
      if (classification.kind === 'method') {
        this._createAndPushErrorWithPressureRecovery(
          contextSlot, STATE.TYPE_ERROR_PROTOTYPE,
          `${declaredName}.${propName} is a method, not a writable data property`);
        mem.setResponseType(contextSlot, RESPONSE_THROW);
        return { fuel, threw: true };
      }
      if (!classification.writable) {
        this._createAndPushErrorWithPressureRecovery(
          contextSlot, STATE.TYPE_ERROR_PROTOTYPE,
          `${declaredName}.${propName} is a read-only data property`);
        mem.setResponseType(contextSlot, RESPONSE_THROW);
        return { fuel, threw: true };
      }
    } else if (brandedReceiver !== 0) {
      // Legacy branded registrations use setHasProperty for this decision.
      const hasProperty = this.hasPropertyHandlers.get(slot);
      if (!hasProperty) {
        const declaredName = this.membrane.declarationNameBySlot(slot) || `handle:${slot}`;
        this._createAndPushErrorWithPressureRecovery(
          contextSlot, STATE.TYPE_ERROR_PROTOTYPE,
          `${declaredName} has no presence probe registered (setHasProperty)`);
        mem.setResponseType(contextSlot, RESPONSE_THROW);
        return { fuel, threw: true };
      }
      let present;
      try {
        present = hasProperty({ name: propName, context: new Context(this, contextSlot) });
      } catch (probeError) {
        this.resumeWithThrow(contextSlot, probeError);
        return { fuel, threw: true };
      }
      if (!present) {
        mem.view.setUint32(mem.abs(requestBase + 24), 1, true);
        mem.setContextPendingPointer(contextSlot, request.argsPointer + 16);
        mem.clearExitCondition(contextSlot);
        return { fuel };
      }
      mem.setContextInstructionIndex(
        contextSlot, mem.getContextInstructionIndex(contextSlot) + 1);
    }

    let setter = this.setters.get(`${slot}:${propName}`);
    if (!setter) setter = this.setters.get(`${slot}:*`);

    if (!setter) {
      const declaredName = this.membrane.declarationNameBySlot(slot) || `handle:${slot}`;
      const errorMessage = `${declaredName} has no setter for property '${propName}'`;
      this._createAndPushErrorWithPressureRecovery(contextSlot,STATE.TYPE_ERROR_PROTOTYPE, errorMessage);
      mem.setResponseType(contextSlot, RESPONSE_THROW);
      return { fuel, threw: true };
    }

    // Unmarshal the assigned value from its arg slot — same marshaller and
    // exact-numeric coercion the method-call arg path uses.
    const options = this.marshallingOptions(contextSlot);
    let value;
    try {
      const [unmarshalled] = mem.unmarshalArgs(request.argsPointer, request.argCount, options);
      // A Handle assigned as a value (`el.parent = otherEl`) unmarshals as a
      // Handle wrapper; hand the setter the underlying object, mirroring how
      // handleExternalCall unwraps Handle args.
      value = isHandle(unmarshalled)
        ? this.membrane.lookupBySlot(unmarshalled.slot)
        : unmarshalled;
    } catch (argError) {
      this._createAndPushErrorWithPressureRecovery(contextSlot,STATE.TYPE_ERROR_PROTOTYPE, argError.message);
      mem.setResponseType(contextSlot, RESPONSE_THROW);
      return { fuel, threw: true };
    }

    const declaredName = this.membrane.declarationNameBySlot(slot) || null;

    if (this.hooks.onExternalCall) {
      this.hooks.onExternalCall({
        kind: 'property-write', slot: contextSlot,
        handleId: slot, declaredName, property: propName,
      });
    }

    const context = new Context(this, contextSlot);
    context.handle = this.membrane.handleForSlot(slot);
    context.method = propName;
    context.register = (obj, meta) => this.register(obj, meta);

    try {
      const result = this._invokeWithSlotCapture(contextSlot, setter, { propName, value, context });

      // Async setter via context.suspend(): park the slot until the write
      // settles. On a successful settle the slot must resume with the
      // assigned `value` (assignment-as-expression), NOT whatever the setter
      // resolved with — the drone observes `x = (el.prop = v)` ⇒ x === v.
      // A rejection still propagates as a throw at the assignment site.
      // _setupSuspension installs marker.onSettle; wrap it to substitute the
      // assigned value on the resolve path. (We wrap here rather than in the
      // shared _setupSuspension because the getter path genuinely wants the
      // marker's value — only the setter overrides it.)
      if (result instanceof SuspensionMarker) {
        if (this.hooks.onExternalCall) {
          this.hooks.onExternalCall({
            kind: 'property-write-suspend', slot: contextSlot,
            handleId: slot, property: propName,
          });
        }
        const originalCallback = result.asyncCallback;
        const valueSubstitutingMarker = new SuspensionMarker(
          (resolve, reject, ctx) =>
            originalCallback(() => resolve(value), reject, ctx)
        );
        const onResume = (identity) => {
          this._enqueueSpawnedContexts([identity]);
        };
        this._setupSuspension(contextSlot, valueSubstitutingMarker, options, activeGrantIds, onResume);
        return { fuel, suspended: true, assignedValue: value };
      }

      if (this.hooks.onExternalCall) {
        this.hooks.onExternalCall({
          kind: 'property-write-result', slot: contextSlot,
          handleId: slot, property: propName,
        });
      }

      // Sync setter (the common case): no park. Return the assigned value as
      // the result; session.js resumes the slot with it. A Promise-returning
      // setter is handled by session.js (suspend on settle, then resume with
      // the assigned value).
      return { fuel, result, assignedValue: value };
    } catch (e) {
      if (this.hooks.onExternalCall) {
        this.hooks.onExternalCall({
          kind: 'property-write-error', slot: contextSlot,
          handleId: slot, property: propName, error: e,
        });
      }
      this.resumeWithThrow(contextSlot, e);
      return { fuel, threw: true };
    }
  }

  /**
   * Set up suspension state and create continuations.
   * Called when a handler returns a SuspensionMarker.
   *
   * The resolve/reject callbacks prepare the context for resumption but do NOT
   * automatically run it. Instead, they call the onResume callback (if provided)
   * so the caller can decide when/how to resume with appropriate fuel.
   *
   * @param {number} contextSlot - The context slot being suspended
   * @param {SuspensionMarker} marker - The suspension marker from the handler
   * @param {Object} options - Marshalling options
   * @param {Set<number>} activeGrantIds - Currently active grant IDs
   * @param {Function} onResume - Optional callback: (contextSlot) => void, called when ready to resume
   * @returns {Object} - { suspended: true }
   */
  _setupSuspension(contextSlot, marker, options, activeGrantIds, onResume = null) {
    if (this.hooks.onSuspend) {
      this.hooks.onSuspend({ kind: 'park-suspend', slot: contextSlot });
    }
    const mem = this.memoryImage;
    const contextGeneration = mem.getContextGeneration(contextSlot);
    const contextIdentity = {
      slot: contextSlot,
      generation: contextGeneration,
    };

    // Increment and capture continuation ID for stale detection
    const continuationId = mem.getContextContinuationId(contextSlot) + 1;
    mem.setContextContinuationId(contextSlot, continuationId);

    // Allocate a linked-promise
    // slot tagged with parkedContextSlot so the entry has a durable
    // identity that survives snapshot. The SS promise serves only as
    // an identity anchor — no SS-side waiters get pushed onto it (the
    // context is parked at EXIT_EXTERNAL_CALL / EXIT_EXTERNAL_PROPERTY,
    // not at await). Live-session wake stays in the closures below;
    // post-restore wake goes through _settleLinkedPromiseBySlot, which
    // reads parkedContextSlot and routes to resumeWithValue /
    // resumeWithThrow on the parked context.
    const promiseDataPointer = mem.createPromise();
    const linkedPromiseSlot = this.membrane.registerLinkedPromise(
      promiseDataPointer - GC_HEADER_SIZE,
      {
        parkedContextSlot: contextSlot,
        parkedContextGeneration: contextGeneration,
      },
    );

    // Claim an
    // AWAITING_PROMISE entry so the in-flight ledger surfaces this
    // slot's wait the same way the await-opcode path does
    // (handleAwait → _claimAwaitingPromise). Both paths are
    // semantically "this slot is parked awaiting external resolve";
    // they should look identical in observability surfaces.
    // The 4 non-stale terminal points in resolve/reject below pair
    // a _freeAwaitingPromise with each _freeLinkedPromiseSlot call.
    this._claimAwaitingPromise(contextSlot);

    // Context stays at its current exit condition while suspended
    // (EXIT_EXTERNAL_CALL for the method path, EXIT_EXTERNAL_PROPERTY for
    // the property path). Suspension is a caller concern — airlock parks
    // the slot, the resolve/reject continuations clear the exit condition
    // when the suspension is done.

    // Create resolve continuation
    const resolve = (value) => {
      if (!mem.isContextIdentityLive(contextSlot, contextGeneration)) return;
      // Check for stale continuation
      if (mem.getContextContinuationId(contextSlot) !== continuationId) {
        return; // Stale - ignore
      }
      // Check whether any grants on the context's grant stack have been
      // revoked while the suspension was pending. If so, route to the
      // denied block of the outermost revoked grant (grant/denied takes
      // precedence over try/catch). Falls back to GrantDeniedError if
      // no denied block exists.
      const currentStackGrants = mem.getActiveGrantIds(contextSlot);
      let hasRevoked = false;
      for (const grantId of currentStackGrants) {
        const grant = this.membrane._getGrantById(grantId);
        if (!grant || !grant.active) {
          hasRevoked = true;
          break;
        }
      }
      if (hasRevoked) {
        this.triggerRevocationHandler(contextSlot);
        mem.clearExitCondition(contextSlot);
        this.pendingContexts.delete(contextSlot);
        // Free the durable linked-promise slot before signaling the
        // host: a re-suspension on the same context during onResume
        // must not see a stale entry holding the old slot.
        if (this.membrane._linkedPromiseSlotIsLive(linkedPromiseSlot)) {
          this.membrane._freeLinkedPromiseSlot(linkedPromiseSlot, MUTATION_TAG.LINKED_SETTLE);
        }
        this._freeAwaitingPromise(contextSlot);
        if (onResume) onResume(contextIdentity);
        return;
      }

      // Construction completion/abort suspensions
      // resume WITHOUT marshalling a value — the retried instruction
      // re-reads its own stack (completion re-dispatches RETURN; abort
      // resumes at the not-yet-executed handler pc). The hook performs
      // the resolve-time bookkeeping (clearing CONSTRUCTION_PENDING /
      // re-arming the duty chain) before the resume.
      if (options.valuelessResume) {
        options.beforeValuelessResume?.(value);
      } else {
      // Marshal the value to the context's pending stack. Stamp
      // `.contextSlot` on any marshaller throw so diagnostic-envelope
      // builders can attribute failures whose throw sites do not know
      // the responsible slot.
      try {
        this._stampContextSlotOnThrow(contextSlot, () => {
          this.marshalResultWithGrantTagging(
            contextSlot, value, options, activeGrantIds);
        });
      } catch (e) {
        if (e instanceof HeapPressureSignal) {
          // The heap cannot fit the value right now. Stash it for
          // retry — runContext drains the stash at the top of the
          // next tick, and on persistent pressure yields
          // memory_pressure so the host gcs and re-runs.
          //
          // The suspension is consumed: complete the same terminal
          // bookkeeping as the success path (minus clearExitCondition,
          // which the drain performs once the marshal fits) and wake
          // the host via onResume. The wake is load-bearing — this
          // settle typically arrives while the runtime is idle (a
          // wire reply, a timer), so without it nobody ever drives
          // the slot again and it parks silently forever.
          this._deferredMarshals.set(contextSlot, { value, options, activeGrantIds });
          this.pendingContexts.delete(contextSlot);
          if (this.membrane._linkedPromiseSlotIsLive(linkedPromiseSlot)) {
            this.membrane._freeLinkedPromiseSlot(linkedPromiseSlot, MUTATION_TAG.LINKED_SETTLE);
          }
          this._freeAwaitingPromise(contextSlot);
          if (onResume) onResume(contextIdentity);
          return;
        }
        throw e;
      }
      }

      // Context is ready to resume - value is on pending stack,
      // RESPONSE_TYPE defaults to RESPONSE_NORMAL (0).

      // Clear exit condition so interpreter can resume
      mem.clearExitCondition(contextSlot);

      // Remove from pendingContexts now that resolution is complete
      this.pendingContexts.delete(contextSlot);

      // A successful
      // resolve invalidates any previously-stashed rejection for
      // this slot — those errors were caught/recovered from and
      // can't be the cause of a future cycle-error on this slot.
      this._rejectionErrorsBySlot.delete(contextSlot);

      // Free the durable linked-promise slot (see early-return arm
      // above for the ordering rationale).
      if (this.membrane._linkedPromiseSlotIsLive(linkedPromiseSlot)) {
        this.membrane._freeLinkedPromiseSlot(linkedPromiseSlot, MUTATION_TAG.LINKED_SETTLE);
      }
      this._freeAwaitingPromise(contextSlot);

      // Notify caller that context is ready to resume
      if (onResume) {
        onResume(contextIdentity);
      }
    };

    // Create reject continuation
    const reject = (error) => {
      if (!mem.isContextIdentityLive(contextSlot, contextGeneration)) return;
      // Check for stale continuation
      if (mem.getContextContinuationId(contextSlot) !== continuationId) {
        return; // Stale - ignore
      }

      // Check for grant revocation — same as resolve path.
      // If the grant was revoked, the denied block takes precedence
      // regardless of whether the external call succeeded or failed.
      const rejectStackGrants = mem.getActiveGrantIds(contextSlot);
      let rejectHasRevoked = false;
      for (const grantId of rejectStackGrants) {
        const grant = this.membrane._getGrantById(grantId);
        if (!grant || !grant.active) {
          rejectHasRevoked = true;
          break;
        }
      }
      if (rejectHasRevoked) {
        this.triggerRevocationHandler(contextSlot);
        mem.clearExitCondition(contextSlot);
        this.pendingContexts.delete(contextSlot);
        if (this.membrane._linkedPromiseSlotIsLive(linkedPromiseSlot)) {
          this.membrane._freeLinkedPromiseSlot(linkedPromiseSlot, MUTATION_TAG.LINKED_SETTLE);
        }
        this._freeAwaitingPromise(contextSlot);
        if (onResume) onResume(contextIdentity);
        return;
      }

      // Stash the raw thrown value with object identity preserved BEFORE the
      // SandScript-side shape rewrites it to a pending-stack error containing
      // only `.message`. Host diagnostic envelopes need the original stack,
      // cause chain, own properties, and BigInt fields.
      //
      // The FIFO queue is consumed explicitly or cleared by the next
      // successful resolve for this slot. Stamp `.contextSlot` on the stashed
      // object so readers receive attribution on the error itself.
      this._stampContextSlot(error, contextSlot);
      const queue = this._rejectionErrorsBySlot.get(contextSlot);
      if (queue) {
        queue.push(error);
      } else {
        this._rejectionErrorsBySlot.set(contextSlot, [error]);
      }

      // Create proper Error object on context's pending stack.
      // Stamp .contextSlot on any throw from
      // createAndPushError (e.g. out-of-memory on the SS heap) so
      // the failure attributes back to this slot.
      const errorMessage = error && error.message ? error.message : String(error);
      const errorProperties = {};
      if (typeof error?.kind === 'string') errorProperties.kind = error.kind;
      if (error?.details !== undefined) errorProperties.details = error.details;
      this._stampContextSlotOnThrow(contextSlot, () => {
        this._createAndPushErrorWithPressureRecovery(
          contextSlot, STATE.ERROR_PROTOTYPE, errorMessage, errorProperties);
      });

      // Signal exception via RESPONSE_TYPE - interpreter will process on resume
      mem.setResponseType(contextSlot, RESPONSE_THROW);

      // Clear exit condition so interpreter can resume
      mem.clearExitCondition(contextSlot);

      // Remove from pendingContexts now that rejection is complete
      this.pendingContexts.delete(contextSlot);

      // Free the durable linked-promise slot (see resolve closure
      // for the ordering rationale).
      if (this.membrane._linkedPromiseSlotIsLive(linkedPromiseSlot)) {
        this.membrane._freeLinkedPromiseSlot(linkedPromiseSlot, MUTATION_TAG.LINKED_SETTLE);
      }
      this._freeAwaitingPromise(contextSlot);

      // Notify caller that context is ready to resume
      if (onResume) {
        onResume(contextIdentity);
      }
    };

    // Store resolve/reject in pendingContexts so the host can settle the
    // suspension externally. Carry linkedPromiseSlot so callers reading
    // pendingContexts have the same identity that the suspend callback sees
    // via its third argument and that survives snapshot in the membrane SAB.
    this.pendingContexts.set(contextSlot, { resolve, reject, slot: linkedPromiseSlot });

    // Invoke the async callback with resolve/reject and the durable
    // linked-promise slot id. Invoke synchronously so resolvers are
    // available immediately to the host. Auto-reject on
    // synchronous throw or Promise rejection.
    //
    // Stamp .contextSlot
    // on the thrown error before routing through reject. The stamp
    // is idempotent — reject() will re-stamp during the stash phase
    // but at the same value, so no harm.
    try {
      const maybePromise = marker.asyncCallback(resolve, reject, { slot: linkedPromiseSlot });
      // If callback returns a Promise, catch rejections
      if (maybePromise && typeof maybePromise.catch === 'function') {
        maybePromise.catch(reject);
      }
    } catch (e) {
      this._stampContextSlot(e, contextSlot);
      reject(e);
    }

    return { suspended: true };
  }

  /**
   * Marshal a result back to SS, tagging any External handles with active grants.
   * This ensures returned handles inherit at least the same grants as the parent context.
   *
   * @param {number} contextSlot - The context to marshal into
   * @param {*} result - The result to marshal
   * @param {Object} options - Marshalling options
   * @param {Set<number>} activeGrantIds - Currently active grant IDs
   */
  marshalResultWithGrantTagging(contextSlot, result, options, activeGrantIds) {
    // Tag Handle results with all active grants before marshalling
    if (isHandle(result)) {
      for (const grantId of activeGrantIds) {
        const grant = this.membrane._getGrantById(grantId);
        if (grant && grant.active) {
          grant.add(result);
        }
      }
    }

    // Handle arrays and objects recursively
    if (Array.isArray(result)) {
      for (const item of result) {
        if (isHandle(item)) {
          for (const grantId of activeGrantIds) {
            const grant = this.membrane._getGrantById(grantId);
            if (grant && grant.active) {
              grant.add(item);
            }
          }
        }
      }
    } else if (result !== null && typeof result === 'object' && !isHandle(result)) {
      for (const value of Object.values(result)) {
        if (isHandle(value)) {
          for (const grantId of activeGrantIds) {
            const grant = this.membrane._getGrantById(grantId);
            if (grant && grant.active) {
              grant.add(value);
            }
          }
        }
      }
    }

    this.memoryImage.marshalResult(contextSlot, result, options);
  }

  /**
   * Resume a slot that yielded EXIT_EXTERNAL_CALL by marshalling `value`
   * onto its pending stack and clearing the exit condition.
   *
   * Promises in `value` are linked into SS Promises by the marshaller's
   * detector chain (top-level and nested) — the embedder must `await`
   * before calling if it wants the resolved value marshalled directly.
   *
   * Active grants are read from the slot's grant stack plus root grants.
   *
   * @param {number} contextSlot
   * @param {*} value
   */
  resumeWithValue(contextSlot, value) {
    const mem = this.memoryImage;
    const options = this.marshallingOptions(contextSlot);
    const activeGrantIds = new Set([
      ...mem.getActiveGrantIds(contextSlot),
      ...this.membrane.rootGrantSlots(),
    ]);
    try {
      this.marshalResultWithGrantTagging(contextSlot, value, options, activeGrantIds);
    } catch (e) {
      if (e instanceof HeapPressureSignal) {
        // The marshal hit
        // pressure mid-walk. mem.marshalResult rewound the heap
        // pointer; the pending stack has NOT advanced, so the slot's
        // EXIT_EXTERNAL_CALL state is intact. Stash the handler
        // result so airlock.runContext can retry the marshal after
        // the host gcs + pumps. We DO NOT clear the exit condition
        // here — the next runContext drains the stash and, on
        // persistent pressure, returns 'memory_pressure' itself so
        // the host gcs and re-runs (NOT via the WAT pressure flag,
        // which run() clears at entry and cannot carry across runs).
        // This path runs UNDER AN ACTIVE DRIVE (session.run's
        // external_call handling), so the drive loop reaches that
        // runContext without any extra wake; the idle-settle path
        // (_setupSuspension's resolve) must additionally fire
        // onResume — see the stash arm there.
        this._deferredMarshals.set(contextSlot, { value, options, activeGrantIds });
        return;
      }
      throw e;
    }
    mem.clearExitCondition(contextSlot);
  }

  /**
   * Drain a deferred marshal for a slot, if one was stashed
   * by a previous resumeWithValue / suspend-resolve that hit
   * HeapPressureSignal. Called by runContext at the top of each tick.
   * On success, clears the stash and the slot's exit condition.
   *
   * Returns a tri-state so runContext can act without consulting the
   * WAT pressure flag (which run() clears at function entry — it is
   * an intra-run signal and cannot carry host-side pressure across
   * runs):
   *   'none'    — no stash for this slot; dispatch normally.
   *   'drained' — stash marshalled, exit condition cleared; dispatch
   *               normally (the slot resumes with its value).
   *   'pressure'— stash remains; the heap still cannot fit the value.
   *               runContext must yield memory_pressure WITHOUT
   *               running the interpreter: the slot is still parked
   *               at EXIT_EXTERNAL_CALL / EXIT_EXTERNAL_PROPERTY, and
   *               running it would re-dispatch the external call
   *               (duplicate handler side effects). The host gcs and
   *               retries; if gc keeps reclaiming nothing the host's
   *               loop escalates to OOM.
   *
   * @param {number} contextSlot
   * @returns {'none'|'drained'|'pressure'}
   */
  _drainDeferredMarshal(contextSlot) {
    const stash = this._deferredMarshals.get(contextSlot);
    if (!stash) return 'none';
    try {
      this.marshalResultWithGrantTagging(
        contextSlot, stash.value, stash.options, stash.activeGrantIds);
    } catch (e) {
      if (e instanceof HeapPressureSignal) {
        return 'pressure';
      }
      throw e;
    }
    this._deferredMarshals.delete(contextSlot);
    this.memoryImage.clearExitCondition(contextSlot);
    return 'drained';
  }

  /**
   * Pressure-safe SS-error delivery. createAndPushError allocates —
   * an error object on the heap, the message in the string table —
   * and either can throw HeapPressureSignal at a full region. Every
   * caller is a dispatch error path (handler threw, grant denied,
   * missing method, bad Promise argument, suspension reject), where
   * a raw signal would escape session.run (or the host's reply
   * callback) instead of reaching the drone's try/catch — and where
   * there is no value-marshal machinery (deferred-marshal stash) to
   * ride. Same self-heal as the linked-promise settle: these sites
   * all run between WAT runs or in microtasks, exactly as quiescent
   * as the host's own gc points, so gc directly and retry once.
   * Persistent pressure after gc is genuine OOM and rethrows.
   *
   * The retry depends on the error PROTOTYPES surviving the gc:
   * Collector.updateIntrinsics forwards every STATE.*_PROTOTYPE cell.
   *
   * @param {number} contextSlot
   * @param {number} prototypeStateOffset - STATE.*_PROTOTYPE offset
   * @param {string} message
   */
  _createAndPushErrorWithPressureRecovery(
    contextSlot, prototypeStateOffset, message, properties = {}) {
    try {
      this.memoryImage.createAndPushError(
        contextSlot, prototypeStateOffset, message, properties);
    } catch (e) {
      if (!(e instanceof HeapPressureSignal) || !this._state.heapGarbageCollect) {
        throw e;
      }
      this._state.heapGarbageCollect();
      this.memoryImage.createAndPushError(
        contextSlot, prototypeStateOffset, message, properties);
    }
  }

  /**
   * Resume a slot that yielded EXIT_EXTERNAL_CALL by raising `error` as a
   * thrown exception inside the SS context.
   *
   * @param {number} contextSlot
   * @param {Error|string} error
   */
  resumeWithThrow(contextSlot, error) {
    const mem = this.memoryImage;
    const message = error && error.message ? error.message : String(error);
    const properties = {};
    if (typeof error?.kind === 'string') properties.kind = error.kind;
    if (error?.details !== undefined) properties.details = error.details;
    this._createAndPushErrorWithPressureRecovery(
      contextSlot, STATE.ERROR_PROTOTYPE, message, properties);
    mem.setResponseType(contextSlot, RESPONSE_THROW);
    mem.clearExitCondition(contextSlot);
  }

  /**
   * Suspend a slot until a JS Promise settles, then resume with the
   * resolved value (or throw the rejection). Used by callers that want to
   * await a handler's Promise return without becoming async themselves.
   *
   * On settle, the slot is pushed into `pendingSpawnedContexts` so
   * embedders that drive contexts via the same drain channel used for
   * `.then` handler spawns / await resumes pick it up automatically.
   * Polling embedders re-check the slot's exit condition each iteration;
   * signal-driven embedders wake on the spawn channel.
   *
   * @param {number} contextSlot
   * @param {Promise} jsPromise
   */
  suspendOnPromise(contextSlot, jsPromise) {
    if (this.hooks.onSuspend) {
      this.hooks.onSuspend({ kind: 'park-promise', slot: contextSlot });
    }
    const options = this.marshallingOptions(contextSlot);
    const activeGrantIds = new Set([
      ...this.memoryImage.getActiveGrantIds(contextSlot),
      ...this.membrane.rootGrantSlots(),
    ]);
    const marker = new SuspensionMarker((resolve, reject) => {
      jsPromise.then(resolve, reject);
    });
    const onResume = (identity) => {
      this._enqueueSpawnedContexts([identity]);
    };
    this._setupSuspension(contextSlot, marker, options, activeGrantIds, onResume);
  }

  /**
   * Suspend a slot parked at EXIT_GRANT_REQUEST on `handleGrantRequest`'s
   * async result, then resume via the runtime's normal drain channel.
   * Unlike `suspendOnPromise`, this is signal-only: `grantResult` is
   * `_processGrants`'s own promise, and `_processGrants` already calls
   * `_finalizeGrantApproval` or `_finalizeGrantRejection` itself, pushing
   * grant-stack entries and moving the instruction pointer synchronously
   * as the last step inside its own chain. By the time this method's `.then`
   * fires, the grant stack is already mutated and the interpreter is already
   * positioned to resume. There is no value to marshal and no revocation
   * check to run; `runContext` performs that check on every dispatch.
   * This is deliberately not a second `_setupSuspension` variant because
   * its value-marshal resume contract does not apply here.
   *
   * `grantResult` rejecting is a real path (an uncaught throw inside a
   * hook, or inside `_finalizeGrantApproval` itself) — there is no
   * synchronous caller left to catch it once this method has returned
   * `{status: 'suspended'}` to the host, so it's marshalled as a
   * SandScript-level throw at the parked `GRANT_START` instruction,
   * catchable by a `try`/`catch` around the `grant` statement. Async
   * rejection therefore follows the script-level error path rather than
   * escaping from `session.run()` as a raw host exception.
   *
   * `continuationId` is NOT read/bumped here — it's the exact value
   * `handleGrantRequest` already bumped and returned (`airlock.js`,
   * `handleGrantRequest`'s own comment on the bump). Both that function's
   * `_finalizeGrantApproval`/`_finalizeGrantRejection` calls AND this
   * method's own `settle()` must check against the SAME single bumped
   * value — there is exactly one park per grant statement (nothing else
   * can dispatch on a grant-parked slot before this settles, so there is
   * no second suspension to distinguish from), so there must be exactly
   * one bump, not two independent ones. Two reads or bumps at different
   * moments would desynchronize the checks and make a non-stale async grant
   * look stale. The bump's actual job: a slot freed and reused via
   * freeContext/allocateContext resets its continuation id to 0 via
   * _initializeContext's full zero, so a park captured at a PRE-bump
   * value of 0 would collide with a freshly-reused slot's ALSO-0
   * identity — bumping guarantees the captured value is one no fresh
   * init can produce again for this slot.
   *
   * @param {number} contextSlot
   * @param {Promise} grantResult - the Promise `handleGrantRequest` returned
   * @param {number} continuationId - the value `handleGrantRequest` bumped
   *   to and returned; pass through unchanged.
   */
  suspendOnGrantRequest(contextSlot, grantResult, continuationId) {
    if (this.hooks.onSuspend) {
      this.hooks.onSuspend({ kind: 'park-grant', slot: contextSlot });
    }
    const mem = this.memoryImage;
    const contextGeneration = mem.getContextGeneration(contextSlot);
    const promiseDataPointer = mem.createPromise();
    const linkedPromiseSlot = this.membrane.registerLinkedPromise(
      promiseDataPointer - GC_HEADER_SIZE,
      {
        parkedContextSlot: contextSlot,
        parkedContextGeneration: contextGeneration,
      },
    );

    this._claimAwaitingPromise(contextSlot);

    const settle = () => {
      if (!mem.isContextIdentityLive(contextSlot, contextGeneration)) {
        this._reportStaleSettlement(contextSlot, contextGeneration);
        return;
      }
      if (mem.getContextContinuationId(contextSlot) !== continuationId) return;
      if (this.membrane._linkedPromiseSlotIsLive(linkedPromiseSlot)) {
        this.membrane._freeLinkedPromiseSlot(
          linkedPromiseSlot, MUTATION_TAG.LINKED_SETTLE);
      }
      this._freeAwaitingPromise(contextSlot);
      this._enqueueSpawnedContexts([
        { slot: contextSlot, generation: contextGeneration },
      ]);
    };

    grantResult.then(
      () => settle(),
      (error) => {
        if (!mem.isContextIdentityLive(contextSlot, contextGeneration)) {
          this._reportStaleSettlement(contextSlot, contextGeneration);
          return;
        }
        if (mem.getContextContinuationId(contextSlot) !== continuationId) return;
        const errorMessage = error && error.message ? error.message : String(error);
        this._stampContextSlotOnThrow(contextSlot, () => {
          this._createAndPushErrorWithPressureRecovery(contextSlot, STATE.ERROR_PROTOTYPE, errorMessage);
        });
        mem.setResponseType(contextSlot, RESPONSE_THROW);
        mem.clearExitCondition(contextSlot);
        settle();
      }
    );
  }

  _reportStaleSettlement(slot, generation) {
    if (this.hooks.onSlotLifecycle) {
      this.hooks.onSlotLifecycle({
        kind: 'stale-settlement',
        slot,
        generation,
        currentGeneration: slot >= 0
            && slot < this.memoryImage.getContextCount()
          ? this.memoryImage.getContextGeneration(slot)
          : null,
      });
    }
  }

  /**
   * Cancel and reclaim one live context allocation.
   * @param {number} slot
   * @param {number} generation
   * @returns {boolean}
   */
  cancelContext(slot, generation) {
    const mem = this.memoryImage;
    if (!mem.isContextIdentityLive(slot, generation)) return false;

    mem.setContextContinuationId(
      slot, mem.getContextContinuationId(slot) + 1);
    const pending = this.pendingContexts.get(slot);
    if (pending) {
      if (this.membrane._linkedPromiseSlotIsLive(pending.slot)) {
        this.membrane._freeLinkedPromiseSlot(
          pending.slot, MUTATION_TAG.LINKED_SETTLE);
      }
      this.pendingContexts.delete(slot);
    }
    for (const linked of this.membrane.enumerateLinkedPromises()) {
      if (linked.parkedContextSlot === slot
          && this.membrane._linkedPromiseSlotIsLive(linked.slot)) {
        this.membrane._freeLinkedPromiseSlot(
          linked.slot, MUTATION_TAG.LINKED_SETTLE);
      }
    }
    const waitingPromise = mem.getContextWaitingOn(slot);
    if (waitingPromise !== 0) {
      mem.removeWaiterFromPromise(waitingPromise, slot, generation);
    }
    this._freeAwaitingPromise(slot);
    // Retain a generation tombstone until either a late settlement is
    // discarded or a new allocation parks in this slot.
    this._state.awaitingGenerationBySlot.set(slot, generation);
    this._state.executorContexts.delete(slot);
    this._deferredMarshals.delete(slot);
    const constructionNewTarget =
      this._constructionNewTargetByContext.get(slot);
    if (constructionNewTarget?.generation === generation) {
      this._constructionNewTargetByContext.delete(slot);
    }
    this._rejectionErrorsBySlot.delete(slot);
    this._state.attributedRejectionBySlot.delete(slot);
    this._state.inFlightHandleSlotBuckets.delete(slot);
    this._state.awaitingLedgerEntryBySlot.delete(slot);
    const queue = this._state.pendingSpawnedContexts;
    for (let index = queue.length - 1; index >= 0; index--) {
      const entrySlot = typeof queue[index] === 'number'
        ? queue[index]
        : queue[index].slot;
      if (entrySlot === slot) queue.splice(index, 1);
    }
    mem.freeContext(slot, generation);
    if (this.hooks.onSlotLifecycle) {
      this.hooks.onSlotLifecycle({ kind: 'cancel', slot, generation });
    }
    return true;
  }

  /**
   * Push context identities into `pendingSpawnedContexts` and fire
   * the `onPendingSpawnedContexts` hook (if the host installed one).
   *
   * @param {{slot:number, generation:number}[]} identities
   * @private
   */
  _enqueueSpawnedContexts(identities) {
    const queue = this._state.pendingSpawnedContexts;
    const fresh = [];
    for (const identity of identities) {
      if (identity === null
          || typeof identity !== 'object'
          || !Number.isInteger(identity.slot)
          || !Number.isInteger(identity.generation)) {
        throw new TypeError(
          'Airlock wake queue requires { slot, generation }');
      }
      const { slot, generation } = identity;
      if (!this.memoryImage.isContextIdentityLive(slot, generation)) continue;
      if (!queue.some((queued) =>
        queued.slot === slot && queued.generation === generation)
          && !fresh.some((queued) =>
            queued.slot === slot && queued.generation === generation)) {
        fresh.push(identity);
      }
    }
    if (fresh.length === 0) return;
    if (this.hooks.onSuspend) {
      for (const identity of fresh) {
        this.hooks.onSuspend({ kind: 'wake', ...identity });
      }
    }
    queue.push(...fresh);
    if (this.hooks.onPendingSpawnedContexts) {
      this.hooks.onPendingSpawnedContexts();
    }
  }

  // =========================================================================
  // Accessor proxies — these expose `_state` / `hooks` fields directly on
  // the airlock so callers can read and write the canonical names
  // (`airlock.pendingSpawnedContexts`, `airlock.onGrantRequest`, etc.).
  // The airlock object itself is Object.frozen at end of construction;
  // these accessors are how the legitimate fields stay writable while
  // monkey-patched additions (e.g. `airlock.ensureHandle = fn`) throw.
  //
  // For backwards compatibility with code that read `airlock.X` directly,
  // the getter returns the same value the field used to. For code that
  // assigned `airlock.X = v`, the setter writes through to the canonical
  // location. New code should prefer `airlock.hooks.X` and the
  // generation-bearing wake drain for clarity.
  // =========================================================================

  get pendingSpawnedContexts() {
    return this._state.pendingSpawnedContexts;
  }
  set pendingSpawnedContexts(_value) {
    // Reassigning the queue used to be how consumers cleared it:
    //   const spawned = airlock.pendingSpawnedContexts;
    //   airlock.pendingSpawnedContexts = [];   // swap in a fresh one
    //   for (const s of spawned) ...
    // That idiom is brittle (it relies on capturing the old reference
    // BEFORE the swap and assumes the airlock will let you replace
    // the field). With the airlock frozen the swap can't happen, and
    // any in-place semantics we paper over here would silently change
    // the meaning of code that still reads the captured reference
    // after the swap. The canonical generation-bearing drain primitive
    // returns the queued identities and empties the queue atomically.
    throw new TypeError(
      'airlock.pendingSpawnedContexts is read-only; use ' +
      'airlock.drainPendingSpawnedContextIdentities() to atomically ' +
      'read-and-clear the queue.');
  }

  get onGrantRequest() { return this.hooks.onGrantRequest; }
  set onGrantRequest(fn) { this.hooks.onGrantRequest = fn; }

  get onPendingSpawnedContexts() { return this.hooks.onPendingSpawnedContexts; }
  set onPendingSpawnedContexts(fn) { this.hooks.onPendingSpawnedContexts = fn; }

  get onExternalCall() { return this.hooks.onExternalCall; }
  set onExternalCall(fn) { this.hooks.onExternalCall = fn; }

  get onGrant() { return this.hooks.onGrant; }
  set onGrant(fn) { this.hooks.onGrant = fn; }

  get onSuspend() { return this.hooks.onSuspend; }
  set onSuspend(fn) { this.hooks.onSuspend = fn; }

  get onSlotLifecycle() { return this.hooks.onSlotLifecycle; }
  set onSlotLifecycle(fn) { this.hooks.onSlotLifecycle = fn; }

  get onCompact() { return this.hooks.onCompact; }
  set onCompact(fn) { this.hooks.onCompact = fn; }

  get collector() { return this._state.collector; }
  // No setter — collector must go through setCollector() (existing API).

  get lastOrphanedLinkedPromiseCount() {
    return this._state.lastOrphanedLinkedPromiseCount;
  }
  // No setter — sandscript-owned counter, internal write only.

  /**
   * Drain queued wake identities for generation-aware schedulers.
   * @returns {{slot:number, generation:number}[]}
   */
  drainPendingSpawnedContextIdentities() {
    const queue = this._state.pendingSpawnedContexts;
    if (queue.length === 0) return [];
    const drained = queue.slice();
    queue.length = 0;
    return drained;
  }


  // ===========================================================================
  // Grant Handling
  // ===========================================================================

  /**
   * Handle a grant request from the interpreter.
   * Called when interpreter yields with STATUS_GRANT_REQUEST.
   *
   * The interpreter has:
   * - Pushed N identifier values onto pending stack
   * - Written operand1 (denied addr) and operand2 (count) to scratch
   * - Yielded with STATUS_GRANT_REQUEST
   *
   * We need to:
   * - Read the identifier values from pending stack
   * - Call onGrantRequest for each (may be sync or async)
   * - Push grant entries to grant stack (or jump to denied)
   * - Continue execution
   *
   * @param {number} contextSlot - The context requesting grants
   * @returns {{result: undefined|Promise, continuationId: number}} -
   *   `result` is undefined for sync completion, a Promise for async;
   *   `continuationId` is the value bumped at park time (see the
   *   bump's own comment below) — the caller must pass it unchanged to
   *   `suspendOnGrantRequest` when `result` is a Promise.
   */
  handleGrantRequest(contextSlot) {
    const mem = this.memoryImage;
    const scratchBase = mem.getScratchBase();
    const deniedAddr = mem.view.getUint32(mem.abs(scratchBase), true);
    const identifierCount = mem.view.getUint32(mem.abs(scratchBase + 4), true);

    // Read identifier values from pending stack (they were pushed in order)
    const pendingPointer = mem.getContextPendingPointer(contextSlot);
    const identifiers = [];
    const identifierAddrs = [];

    for (let i = 0; i < identifierCount; i++) {
      const addr = pendingPointer - (identifierCount - i) * 16;
      identifierAddrs.push(addr);
      identifiers.push(mem.readValueAt(addr, this.marshallingOptions(contextSlot)));
    }

    // Pop identifier values from pending stack
    mem.setContextPendingPointer(contextSlot, pendingPointer - identifierCount * 16);

    // Bump the slot's continuation id while it is genuinely parked at
    // EXIT_GRANT_REQUEST, then thread that exact value through
    // _processGrants to _finalizeGrantApproval/_finalizeGrantRejection
    // (the actual grant-stack/instruction-pointer mutation sites) AND
    // return it to the caller so session.js can pass the SAME value to
    // suspendOnGrantRequest. Bumping (not just reading) matters: a slot
    // freed and reused via freeContext/allocateContext resets its
    // continuation id to 0 via _initializeContext's full zero, so a
    // captured value of 0 would collide with a freshly-reused slot's
    // ALSO-0 identity — bumping guarantees the captured value is one no
    // fresh init can ever produce again for this slot. Both call sites
    // MUST agree on this single bumped value (there is no other
    // suspension that can race a grant park to justify two independent
    // bumps — see suspendOnGrantRequest's own doc comment) or every
    // non-stale async grant looks stale to the finalize functions.
    const continuationId = mem.getContextContinuationId(contextSlot) + 1;
    mem.setContextContinuationId(contextSlot, continuationId);

    // The hook fires after the continuationId bump so an embedder can
    // persist everything resumeGrantRequest needs to re-drive this request
    // after restart. identifierAddrs and deniedAddr are not independently
    // recoverable from restored memory: reconstructing identifierAddrs
    // requires reversing pendingPointer, while deniedAddr occupies a
    // session-wide scratch region that any slot's next scratch use may
    // overwrite. This is the one moment all four values are known together
    // and safe to persist.
    if (this.hooks.onGrant) {
      this.hooks.onGrant({
        kind: 'request', slot: contextSlot, identifiers: identifiers.slice(),
        identifierAddrs: identifierAddrs.slice(), deniedAddr, continuationId,
      });
    }

    // Approval window: grants the host
    // creates inside onGrantRequest exist only as JS wrappers until
    // _finalizeGrantApproval pushes their stack entries. The window
    // keeps compaction from reaping them across that whole span —
    // including the event-loop turns of an async approval chain.
    const approvalWindow = this.membrane.beginGrantApprovalWindow();
    let result;
    try {
      // Process grants - may be sync or async
      result = this._processGrants(contextSlot, identifiers, identifierAddrs, deniedAddr, 0, [], [], continuationId);
    } catch (error) {
      this.membrane.endGrantApprovalWindow(approvalWindow);
      throw error;
    }
    if (result instanceof Promise) {
      return {
        result: result.finally(() => this.membrane.endGrantApprovalWindow(approvalWindow)),
        continuationId,
      };
    }
    this.membrane.endGrantApprovalWindow(approvalWindow);
    return { result, continuationId };
  }

  /**
   * Process grant requests one at a time (supports async).
   * Returns undefined for sync completion, Promise for async.
   * @param {number} contextSlot - The context requesting grants
   * @param {Array} rejected - Accumulator for rejected identifiers
   * @param {number} continuationId - the slot's continuation id captured
   *   at the moment the grant request was first read (handleGrantRequest);
   *   passed through unchanged so _finalizeGrantApproval/
   *   _finalizeGrantRejection can detect the slot going stale (freed and
   *   reused) during an async approval and skip mutating the new occupant.
   */
  _processGrants(contextSlot, identifiers, identifierAddrs, deniedAddr, index, grants, rejected = [], continuationId) {
    // Base case: all grants processed
    if (index >= identifiers.length) {
      if (rejected.length > 0) {
        // Some grants were rejected
        this._finalizeGrantRejection(contextSlot, rejected, deniedAddr, continuationId);
      } else {
        // All grants approved
        this._finalizeGrantApproval(contextSlot, grants, deniedAddr, continuationId);
      }
      return;
    }

    const identifier = identifiers[index];

    if (!this.hooks.onGrantRequest) {
      // No handler - reject all remaining
      const allRejected = [...rejected, ...identifiers.slice(index)];
      this._finalizeGrantRejection(contextSlot, allRejected, deniedAddr, continuationId);
      return;
    }

    const result = this.hooks.onGrantRequest(identifier);

    // Async path
    if (result instanceof Promise) {
      return result.then(({ approved, grant }) => {
        if (approved && grant) {
          grants.push({ identifier, identifierAddr: identifierAddrs[index], grant });
        } else {
          rejected.push(identifier);
        }
        return this._processGrants(contextSlot, identifiers, identifierAddrs, deniedAddr, index + 1, grants, rejected, continuationId);
      });
    }

    // Sync path
    const { approved, grant } = result;
    if (approved && grant) {
      grants.push({ identifier, identifierAddr: identifierAddrs[index], grant });
    } else {
      rejected.push(identifier);
    }
    return this._processGrants(contextSlot, identifiers, identifierAddrs, deniedAddr, index + 1, grants, rejected, continuationId);
  }

  /**
   * Shared gate for _finalizeGrantApproval/_finalizeGrantRejection:
   * true means "this call may mutate the slot"; false means the
   * finalize must be a structural no-op (a 'finalize-skipped' onGrant
   * event names the reason — the observable that makes a skipped
   * finalize diagnosable without hand-patching airlock internals).
   *
   * Two independent staleness axes:
   *
   * - continuation id (CROSS-park staleness): the slot was freed and
   *   reused while this approval was pending — the id no longer
   *   matches, and mutating would corrupt the new occupant.
   *
   * - duplicate finalize (same park, still-valid id): for example,
   *   resumeGrantRequest fired against a request whose live
   *   `_processGrants` chain is still in flight. Both chains carry the
   *   same id. Two conditions together make a
   *   duplicate a no-op in every ordering: a parked grant request
   *   always sits ON its GRANT_START and every finalize moves the
   *   instruction pointer off it (approval's +1, rejection's
   *   deniedAddr jump) — catches a duplicate arriving before the woken
   *   slot is driven; and the exit condition stays EXIT_GRANT_REQUEST
   *   only until that drive — catches a duplicate arriving after,
   *   without relying on codeBlockReadInstruction of a pc that may sit
   *   past the last instruction (it does no bounds check).
   *
   * @param {number} contextSlot
   * @param {number} continuationId - the value handleGrantRequest
   *   bumped to at park time, threaded through the approval chain.
   * @param {'approved'|'denied'} decision - which finalize is asking;
   *   forwarded on the skip event.
   * @returns {boolean}
   */
  _guardGrantFinalize(contextSlot, continuationId, decision) {
    const mem = this.memoryImage;
    let reason = null;
    if (mem.getContextContinuationId(contextSlot) !== continuationId) {
      reason = 'stale-continuation';
    } else if (mem.getExitCondition(contextSlot) !== EXIT_GRANT_REQUEST
      || mem.codeBlockReadInstruction(
        mem.getContextInstructionIndex(contextSlot)).opcode !== OP.GRANT_START) {
      reason = 'already-finalized';
    }
    if (reason === null) return true;
    if (this.hooks.onGrant) {
      this.hooks.onGrant({
        kind: 'finalize-skipped', slot: contextSlot, decision, reason,
        continuationId,
        currentContinuationId: mem.getContextContinuationId(contextSlot),
        instructionIndex: mem.getContextInstructionIndex(contextSlot),
      });
    }
    return false;
  }

  /**
   * Finalize grant approval - push grants to stack and continue.
   * @param {number} contextSlot - The context
   * @param {number} continuationId - see _processGrants's doc. If the
   *   slot's current continuation id no longer matches, the slot was
   *   freed and reused while this approval was pending — skip mutating
   *   the new occupant's grant stack entirely.
   */
  _finalizeGrantApproval(contextSlot, grants, deniedAddr, continuationId) {
    const mem = this.memoryImage;
    if (!this._guardGrantFinalize(contextSlot, continuationId, 'approved')) return;
    if (this.hooks.onGrant) {
      this.hooks.onGrant({
        kind: 'approved', slot: contextSlot,
        identifiers: grants.map(g => g.identifier),
        continuationId,
        instructionIndex: mem.getContextInstructionIndex(contextSlot),
      });
    }
    for (const { identifierAddr, grant } of grants) {
      mem.pushGrantEntry(contextSlot, identifierAddr, grant.slot, deniedAddr);
    }
    // Advance past GRANT_START - context is ready to resume
    mem.setContextInstructionIndex(contextSlot, mem.getContextInstructionIndex(contextSlot) + 1);
  }

  /**
   * Finalize grant rejection - jump to denied block or skip.
   * @param {number} contextSlot - The context
   * @param {number} continuationId - see _finalizeGrantApproval's doc.
   */
  _finalizeGrantRejection(contextSlot, identifiers, deniedAddr, continuationId) {
    const mem = this.memoryImage;
    // A duplicate rejection is worse than a duplicate approval:
    // marshalResult would push the rejected-identifiers array onto the
    // pending stack a second time on top of the pc corruption.
    if (!this._guardGrantFinalize(contextSlot, continuationId, 'denied')) return;
    if (this.hooks.onGrant) {
      this.hooks.onGrant({
        kind: 'denied', slot: contextSlot, rejected: identifiers.slice(),
        continuationId,
        instructionIndex: mem.getContextInstructionIndex(contextSlot),
      });
    }
    // deniedAddr is the jump target:
    // - If there's a denied block: points to GRANT_DENIED instruction
    // - If no denied block: points to "end" (after the JUMP)
    //
    // Check if we're jumping to GRANT_DENIED to push the rejected array.
    const targetOpcode = mem.codeBlockReadInstruction(deniedAddr).opcode;

    // OP.GRANT_DENIED = 0xC2
    if (targetOpcode === 0xC2) {
      // Jumping to denied block - push array of rejected identifiers.
      // marshalResult rolls partial allocations back, so retrying after
      // collection cannot duplicate the pending-stack entry.
      try {
        mem.marshalResult(contextSlot, identifiers, this.marshallingOptions(contextSlot));
      } catch (e) {
        if (!(e instanceof HeapPressureSignal) || !this._state.heapGarbageCollect) {
          throw e;
        }
        this._state.heapGarbageCollect();
        mem.marshalResult(contextSlot, identifiers, this.marshallingOptions(contextSlot));
      }
    }

    // Jump to denied block - context is ready to resume
    mem.setContextInstructionIndex(contextSlot, deniedAddr);
  }

  /**
   * Finish a grant request from OUTSIDE its original `onGrantRequest` /
   * `_processGrants` promise chain — the embedder-driven counterpart to
   * `settleLinkedPromise` for a slot parked at `EXIT_GRANT_REQUEST`.
   *
   * Needed because `_processGrants`'s own recursive chain is what
   * finalizes a grant (calling `_finalizeGrantApproval`/
   * `_finalizeGrantRejection` itself, synchronously, before
   * `suspendOnGrantRequest`'s settle ever runs) — that chain is an
   * ordinary JS async call stack with no existence beyond the process
   * that started it. After a restart there is no live chain left to
   * finish; this method re-drives one from recovered state instead.
   *
   * `linkedPromiseSlot` (NOT the interpreter context slot) identifies
   * which parked request to finish — same calling convention as
   * `settleLinkedPromise`/`rejectLinkedPromise`. The embedder finds it
   * via `airlock.enumerateLinkedPromises()`, correlating each entry's
   * `parkedContextSlot` against its own persisted grant-request record
   * (mirroring how `pendingCalls`-style embedder state correlates by
   * slot for ordinary external-call resume).
   *
   * Re-enters at the SAME place a live `handleGrantRequest` would —
   * `_processGrants` itself, from identifier index 0 — because the
   * interpreter never had a per-identifier notion of "already asked" to
   * begin with (`grant (a, b, c) { }` is parser sugar for exactly ONE
   * `GRANT_START`/park; see `parser.js`'s `grantStatement()`). This is
   * therefore only well-defined for a request that crashed BEFORE
   * `_processGrants` began accumulating decisions, or strictly AFTER it
   * finished — never mid-recursion, since a partial `grants`/`rejected`
   * accumulator is an ordinary JS local with no durability and cannot
   * be recovered at all. The embedder is responsible for only calling
   * this for requests it knows are in the "genuinely still parked, not
   * yet asked at all" state (nothing here re-derives that from the
   * restored bytes — see `deniedAddr`'s own note below).
   *
   * `deniedAddr` cannot be recovered from restored memory: it lives in
   * a single scratch region shared by the whole session (not
   * per-context) and reused by unrelated operations the moment any
   * slot dispatches again, so the embedder must have captured it itself
   * at request time (the same moment it captured `identifiers`/
   * `identifierAddrs`/`continuationId`) and pass it back in here.
   *
   * Continuation-id staleness (slot freed/reused since the request was
   * persisted) is checked by `_finalizeGrantApproval`/
   * `_finalizeGrantRejection` themselves, the same as any other grant
   * finalize call — no separate check needed here.
   *
   * @param {number} linkedPromiseSlot - the linked-promise slot
   *   `suspendOnGrantRequest` registered for this parked request
   *   (from `airlock.enumerateLinkedPromises()`, NOT the interpreter
   *   context slot).
   * @param {Object} request - recovered request state; the embedder's
   *   own responsibility to have captured and persisted all of it.
   * @param {Array} request.identifiers - the identifier values, in
   *   original order (index 0 first).
   * @param {Array<number>} request.identifierAddrs - matching heap
   *   addresses, same order.
   * @param {number} request.deniedAddr - jump target for denial
   *   (0 encodes "no denied block" per `handleGrantRequest`'s own
   *   convention).
   * @param {number} request.continuationId - the value
   *   `handleGrantRequest` bumped to and returned at request time;
   *   passed through unchanged to `_processGrants`.
   */
  resumeGrantRequest(linkedPromiseSlot, { identifiers, identifierAddrs, deniedAddr, continuationId }) {
    if (!this.membrane._linkedPromiseSlotIsLive(linkedPromiseSlot)) {
      throw new Error(
        `resumeGrantRequest: slot ${linkedPromiseSlot} is not a live linked-promise entry`);
    }
    const contextSlot = this.membrane._readLinkedPromiseParkedContextSlot(linkedPromiseSlot);
    const contextGeneration =
      this.membrane._readLinkedPromiseParkedContextGeneration(
        linkedPromiseSlot);
    if (contextSlot === LINKED_PROMISE_NO_PARKED_CONTEXT) {
      throw new Error(
        `resumeGrantRequest: linked-promise slot ${linkedPromiseSlot} has no parked context — ` +
        'not a grant-request suspension');
    }
    if (!this.memoryImage.isContextIdentityLive(
      contextSlot, contextGeneration)) {
      this._reportStaleSettlement(contextSlot, contextGeneration);
      this.membrane._freeLinkedPromiseSlot(
        linkedPromiseSlot, MUTATION_TAG.LINKED_SETTLE);
      return;
    }

    // Observable counterpart to the 'request' event: an embedder-driven
    // re-drive is a distinct lifecycle moment (a second approval chain
    // starting), and a 'resume' immediately followed by a
    // 'finalize-skipped' is the signature of a resume fired against a
    // request some live chain already owns.
    if (this.hooks.onGrant) {
      this.hooks.onGrant({
        kind: 'resume', slot: contextSlot, linkedPromiseSlot,
        identifiers: identifiers.slice(), continuationId,
      });
    }

    const approvalWindow = this.membrane.beginGrantApprovalWindow();
    let result;
    try {
      result = this._processGrants(contextSlot, identifiers, identifierAddrs, deniedAddr, 0, [], [], continuationId);
    } catch (error) {
      this.membrane.endGrantApprovalWindow(approvalWindow);
      this.membrane._logLinkedPromiseSettle(linkedPromiseSlot, false);
      this.membrane._freeLinkedPromiseSlot(linkedPromiseSlot, MUTATION_TAG.LINKED_SETTLE);
      throw error;
    }

    if (result instanceof Promise) {
      result = result.finally(() => this.membrane.endGrantApprovalWindow(approvalWindow));
      // Same settle() shape as suspendOnGrantRequest, minus the
      // continuationId re-check settle() does — _finalizeGrantApproval/
      // _finalizeGrantRejection already re-check it themselves, and
      // this linked-promise slot is a fresh registration (not the
      // original, long-gone one), so there is no separate stale-vs-live
      // distinction for IT to make.
      const settle = () => {
        if (this.membrane._linkedPromiseSlotIsLive(linkedPromiseSlot)) {
          this.membrane._logLinkedPromiseSettle(linkedPromiseSlot, true);
          this.membrane._freeLinkedPromiseSlot(linkedPromiseSlot, MUTATION_TAG.LINKED_SETTLE);
        }
        this._enqueueSpawnedContexts([{
          slot: contextSlot,
          generation: contextGeneration,
        }]);
      };
      result.then(settle, (error) => {
        const errorMessage = error && error.message ? error.message : String(error);
        this._stampContextSlotOnThrow(contextSlot, () => {
          this._createAndPushErrorWithPressureRecovery(contextSlot, STATE.ERROR_PROTOTYPE, errorMessage);
        });
        this.memoryImage.setResponseType(contextSlot, RESPONSE_THROW);
        this.memoryImage.clearExitCondition(contextSlot);
        settle();
      });
      return;
    }

    this.membrane.endGrantApprovalWindow(approvalWindow);
    this.membrane._logLinkedPromiseSettle(linkedPromiseSlot, true);
    this.membrane._freeLinkedPromiseSlot(linkedPromiseSlot, MUTATION_TAG.LINKED_SETTLE);
    this._enqueueSpawnedContexts([{
      slot: contextSlot,
      generation: contextGeneration,
    }]);
  }

  /**
   * Handle grant revocation by jumping to the denied block of the outermost
   * revoked grant. This is the revocation-time counterpart to
   * _finalizeGrantRejection (which handles request-time denial).
   *
   * Grant/denied takes precedence over try/catch. The try stack is only
   * consulted as a fallback when no denied block exists.
   *
   * @param {number} contextSlot - The context whose grants were revoked
   * @param {string} errorMessage - Descriptive message for fallback error
   */
  triggerRevocationHandler(contextSlot) {
    const mem = this.memoryImage;
    const depth = mem.getGrantDepth(contextSlot);

    // Walk the grant stack from bottom (outermost) to top (innermost)
    // to find the outermost revoked grant with a denied block.
    // Note: deniedAddr is non-zero even when there's no denied block (it
    // points to the "end" label). A real denied block is identified by the
    // opcode at deniedAddr being GRANT_DENIED (0xC2).
    let targetIndex = -1;
    let targetEntry = null;
    const revokedIdentifiers = [];

    for (let i = 0; i < depth; i++) {
      const entry = mem.getGrantEntry(contextSlot, i);
      const grant = this.membrane._getGrantById(entry.grantId);
      if (!grant || !grant.active) {
        revokedIdentifiers.push(grant?.identifier || `grant:${entry.grantId}`);
        if (targetIndex === -1 && entry.deniedAddr !== 0) {
          const opcode = mem.codeBlockReadInstruction(entry.deniedAddr).opcode;
          if (opcode === 0xC2) {
            targetIndex = i;
            targetEntry = entry;
          }
        }
      }
    }

    if (!targetEntry) {
      // No denied block on any revoked grant — fall back to GrantDeniedError.
      // Pop revoked grant entries so the runContext revocation check doesn't
      // re-trigger when the host resumes execution.
      for (let i = depth - 1; i >= 0; i--) {
        const entry = mem.getGrantEntry(contextSlot, i);
        const grant = this.membrane._getGrantById(entry.grantId);
        if (!grant || !grant.active) {
          mem.popGrantEntry(contextSlot);
        } else {
          break;
        }
      }
      const message =
        `Suspension orphaned: grant${revokedIdentifiers.length > 1 ? 's' : ''} ` +
        `${revokedIdentifiers.join(', ')} ${revokedIdentifiers.length > 1 ? 'were' : 'was'} ` +
        `revoked while the call was pending`;
      this._createAndPushErrorWithPressureRecovery(contextSlot,STATE.GRANT_DENIED_ERROR_PROTOTYPE, message);
      mem.setResponseType(contextSlot, RESPONSE_THROW);
      return;
    }

    // One GRANT_START pushes its identifiers contiguously, and every entry
    // from that dynamic grant statement records the same denied target,
    // scope, and frame depth. Recover the start of that complete group
    // before unwinding: routing through a later member's shared denied arm
    // must not leave its earlier siblings on the stack. Scope and frame
    // distinguish recursive activations of the same lexical GRANT_START.
    while (targetIndex > 0) {
      const precedingEntry = mem.getGrantEntry(contextSlot, targetIndex - 1);
      if (precedingEntry.deniedAddr !== targetEntry.deniedAddr
        || precedingEntry.scopePointer !== targetEntry.scopePointer
        || precedingEntry.frameDepth !== targetEntry.frameDepth) {
        break;
      }
      targetIndex--;
      targetEntry = precedingEntry;
    }

    // Unwind grant stack: pop all entries down to (and including) the target
    while (mem.getGrantDepth(contextSlot) > targetIndex) {
      mem.popGrantEntry(contextSlot);
    }

    // Restore scope to grant entry time
    mem.setContextScope(contextSlot, targetEntry.scopePointer);

    // Unwind call stack to grant entry depth
    const callStackBase = mem.getCallStackBase(contextSlot);
    const targetCallPointer = callStackBase + targetEntry.frameDepth * FRAME_SIZE;
    mem.setContextCallStackPointer(contextSlot, targetCallPointer);

    // Restore pending stack from the frame at the target depth.
    // If there are frames remaining, the top frame's pendingPointer tells us
    // where the pending stack was. If no frames remain (grant was at top level),
    // reset to the pending stack base.
    if (targetEntry.frameDepth > 0) {
      const frame = mem.getFrame(contextSlot, targetEntry.frameDepth - 1);
      mem.setContextPendingPointer(contextSlot, frame.pendingPointer);
    } else {
      mem.setContextPendingPointer(contextSlot, mem.getPendingStackBase(contextSlot));
    }

    // Pop any try entries that were pushed inside the grant body
    while (mem.getTryDepth(contextSlot) > 0) {
      const top = mem.peekTryEntry(contextSlot);
      if (top.frameDepth >= targetEntry.frameDepth) {
        mem.popTryEntry(contextSlot);
      } else {
        break;
      }
    }

    // Check if deniedAddr points to a GRANT_DENIED opcode (0xC2).
    // If so, push the revoked identifiers array for the parameter binding.
    const targetOpcode = mem.codeBlockReadInstruction(targetEntry.deniedAddr).opcode;
    if (targetOpcode === 0xC2) {
      mem.marshalResult(contextSlot, revokedIdentifiers, this.marshallingOptions(contextSlot));
    }

    // Jump to denied block
    mem.setContextInstructionIndex(contextSlot, targetEntry.deniedAddr);
  }

  // ===========================================================================
  // Callback Support
  // ===========================================================================

  /**
   * Wrap a SS closure pointer as a callable JS function.
   * Captures the active grants from the specified context at creation time.
   *
   * When called, the wrapper:
   * 1. Allocates a fresh context
   * 2. Sets up the callback with arguments
  /**
   * Check if all grants captured by a closure handle are still active.
   * @param {ClosureHandle} handle
   * @returns {boolean}
   */
  areClosureGrantsActive(handle) {
    for (const grantSlot of handle.capturedGrantSlots) {
      const grant = this.membrane._getGrantById(grantSlot);
      if (!grant || !grant.active) {
        return false;
      }
    }
    return true;
  }

  /**
   * Get the current closure pointer for a handle (may change after GC).
   * @param {ClosureHandle} handle
   * @returns {number|null}
   */
  getClosurePointer(handle) {
    const ptr = handle.closurePointer;
    return ptr === 0 ? null : ptr;
  }

  /**
   * Allocate a fresh SS context slot. Thin wrapper over
   * memoryImage.allocateContext so callers (notably the
   * runtime's closure drainer) don't have to reach past the
   * airlock into engine internals.
   *
   * The context object and its four stack blocks live on the SS heap, so
   * allocation under churn can hit HeapPressureSignal while collectable
   * transients occupy the space needed for a new stack block.
   * Same self-heal as _createAndPushErrorWithPressureRecovery:
   * every caller runs between WAT runs — exactly as quiescent as
   * the host's own gc points — so gc directly and retry once. A
   * failed first attempt leaks nothing: the slot table is only
   * written after all five allocations succeed, so at worst a few
   * orphaned blocks become garbage for the very gc that follows.
   * Persistent pressure after gc is genuine OOM and rethrows.
   *
   * @returns {number} slot
   */
  allocateContext() {
    let slot;
    try {
      slot = this.memoryImage.allocateContext();
    } catch (e) {
      if (!(e instanceof HeapPressureSignal) || !this._state.heapGarbageCollect) {
        throw e;
      }
      this._state.heapGarbageCollect();
      slot = this.memoryImage.allocateContext();
    }
    if (this.hooks.onSlotLifecycle) {
      this.hooks.onSlotLifecycle({ kind: 'allocate', slot });
    }
    return slot;
  }

  /**
   * Free a previously-allocated SS context slot. Companion to
   * allocateContext().
   *
   * @param {number} slot
   * @param {number} [generation]
   */
  freeContext(slot, generation = this.memoryImage.getContextGeneration(slot)) {
    const constructionNewTarget =
      this._constructionNewTargetByContext.get(slot);
    if (constructionNewTarget?.generation === generation) {
      this._constructionNewTargetByContext.delete(slot);
    }
    if (this.hooks.onSlotLifecycle) {
      this.hooks.onSlotLifecycle({ kind: 'free', slot, generation });
    }
    return this.memoryImage.freeContext(slot, generation);
  }


  /**
   * Wire in the in-flight ledger view. Called by the Runtime
   * after construction (the Airlock is built by the session
   * before the Runtime exists, so this can't be a ctor option).
   * When the ledger is set, handleAwait claims an
   * AWAITING_PROMISE entry on park and the resume paths
   * (_claimAwaitingPromise / _freeAwaitingPromise) free it.
   * When not set, both helpers are no-ops — embedders that
   * don't run a Runtime see no behavior change.
   *
   * @param {Object} ledger — createLedgerView output
   */
  setLedger(ledger) {
    this._state.ledger = ledger;
  }

  /**
   * Wire in the Runtime's host-invocation-context resolver. The resolver
   * queries the Runtime's generation-safe invocation owner registry; the
   * airlock keeps no second slot-to-owner map or copy of the opaque value.
   *
   * @param {(slot: number, generation: number) => any} resolver
   */
  setHostInvocationContextResolver(resolver) {
    this._state.hostInvocationContextResolver = resolver;
  }

  /**
   * Resolve the opaque host invocation context for an exact
   * (slot, generation) identity captured at Context construction.
   * Returns undefined unless a resolver is wired in AND the captured
   * identity is still live in authoritative memory state AND the
   * Runtime's owner registry holds a non-terminal owner for exactly
   * that identity. There is no ambient or process-global fallback.
   *
   * @param {number} slot
   * @param {number} generation
   * @returns {any}
   */
  resolveHostInvocationContext(slot, generation) {
    const resolver = this._state.hostInvocationContextResolver;
    if (resolver === null) return undefined;
    if (!this.memoryImage.isContextIdentityLive(slot, generation)) {
      return undefined;
    }
    return resolver(slot, generation);
  }

  /**
   * Internal: claim an AWAITING_PROMISE entry for `slot` and
   * record the entry index so the matching resume can free it.
   * Idempotent for slots that already have an entry (drops the
   * extra claim, keeps the original — re-entering handleAwait
   * for an already-parked slot shouldn't churn the ledger).
   *
   * If the ledger is unset (no Runtime wired in) or the table
   * is full (claim returns -1), the call is a no-op; the
   * matching free is silently skipped via the absence of a
   * map entry.
   *
   * @param {number} slot
   */
  _claimAwaitingPromise(slot) {
    const generation = this.memoryImage.getContextGeneration(slot);
    const existingGeneration =
      this._state.awaitingGenerationBySlot.get(slot);
    if (existingGeneration !== undefined
        && existingGeneration !== generation
        && this.memoryImage.isContextIdentityLive(
          slot, existingGeneration)) {
      throw new Error(
        `_claimAwaitingPromise: slot ${slot} changed generation while parked`);
    }
    this._state.awaitingGenerationBySlot.set(slot, generation);
    const ledger = this._state.ledger;
    if (!ledger) return;
    if (this._state.awaitingLedgerEntryBySlot.has(slot)) return;
    const idx = ledger.claim({
      contextSlot: slot,
      activity: LEDGER_ACTIVITY.AWAITING_PROMISE,
      beganAtTick: performance.now() | 0,
    });
    if (idx >= 0) {
      this._state.awaitingLedgerEntryBySlot.set(slot, idx);
    }
    // If idx === -1 (table full), don't record; the resume will
    // silently skip. Table saturation is a real signal — surfaced
    // by the runtime layer (Scheduler's DRIVING_ROOT claim already
    // does so) — but the airlock-side claims shouldn't double-fire
    // that signal.
  }

  /**
   * Internal: free an AWAITING_PROMISE entry for `slot`, if one
   * was claimed. No-op when the slot has no entry (either the
   * ledger is unset, the claim failed, or the slot never parked).
   *
   * @param {number} slot
   */
  _freeAwaitingPromise(slot) {
    this._state.awaitingGenerationBySlot.delete(slot);
    const ledger = this._state.ledger;
    if (!ledger) return;
    const idx = this._state.awaitingLedgerEntryBySlot.get(slot);
    if (idx === undefined) return;
    this._state.awaitingLedgerEntryBySlot.delete(slot);
    ledger.free(idx);
  }

  /**
   * Set up a context for callback execution.
   *
   * Allocates on the SS heap (the call scope, arg marshaling), so it
   * shares allocateContext's pressure exposure and self-heal: on
   * HeapPressureSignal, gc once and re-run the whole setup. The
   * re-run is safe by construction — the closure pointer is
   * re-resolved from the handle (the collector updates it), a fresh
   * scope replaces (and orphans) a partially-built one, and
   * resetContextStacks clears any partially-pushed grants/args
   * before they are redone. Persistent pressure rethrows: genuine
   * OOM. `_retryAfterGc` is internal — external callers always get
   * the self-healing form.
   *
   * @param {number} contextSlot - The context slot to set up
   * @param {Object} handle - Closure handle from registerClosure
   * @param {Array} args - JS arguments to pass
   */
  setupCallbackContext(contextSlot, handle, args, _retryAfterGc = true, receiver = null) {
    const mem = this.memoryImage;

    // Get current closure pointer (may have moved after GC)
    const closurePointer = this.getClosurePointer(handle);
    if (closurePointer === null) {
      throw new Error('Callback has been released');
    }

    try {
      const closure = mem.getClosure(closurePointer);

      // Initialize context state
      mem.setContextInstructionIndex(contextSlot, closure.startInstruction);

      // Create scope for callback (child of closure's captured scope)
      const callScope = mem.createScope(closure.scope);
      mem.setContextScope(contextSlot, callScope);

      // Reset stacks for this context
      mem.resetContextStacks(contextSlot);

      // Set normal completion type - freshly allocated context already has
      // exit condition 0 (no exit yet) and RESPONSE_NORMAL (0)
      mem.setContextCompletionType(contextSlot, COMPLETION_NORMAL);

      // Push captured grants to grant stack
      for (const grantSlot of handle.capturedGrantSlots) {
        mem.pushGrantEntryForCallback(contextSlot, grantSlot);
      }

      // For invokeClosureWithReceiver, bind `this` to the caller's
      // receiver value and `@newtarget` to undefined for non-arrow
      // callees (arrows inherit both lexically — leave them unbound).
      // `receiver` is a THUNK resolved here, after createScope's
      // allocation, so a heap gc during setup cannot stale the pointer;
      // once written, the scope entry is collector-forwarded.
      if (receiver !== null) {
        const functionFlags = mem.view.getUint32(
          mem.abs(closurePointer + FUNCTION.FUNCTION_FLAGS), true);
        if ((functionFlags & CLOSURE_FLAG_ARROW) === 0) {
          const resolved = receiver();
          mem.scopeSetRaw(callScope, mem.getBuiltinName(BUILTIN_NAME.THIS),
            resolved.type, resolved.lo, resolved.hi ?? 0);
          mem.scopeSetRaw(callScope, mem.getBuiltinName(BUILTIN_NAME.NEW_TARGET),
            TYPE.UNDEFINED, 0, 0);
        }
      }

      // Stage per the shared sizing rule (callback_staged_argc): only as
      // many arguments as the callee declares — extra values left on the
      // pending stack corrupt subsequent operations — except a
      // rest-declaring callee, which collects every staged argument and
      // must therefore receive the host's full argument list.
      const stagedCount = this.wasm.exports.callback_staged_argc(closurePointer, args.length);
      const argsToPass = args.slice(0, stagedCount);

      // Marshal arguments to pending stack
      const options = this.marshallingOptions(contextSlot);
      for (const arg of argsToPass) {
        mem.marshalResult(contextSlot, arg, options);
      }
    } catch (e) {
      if (!_retryAfterGc || !(e instanceof HeapPressureSignal)
          || !this._state.heapGarbageCollect) {
        throw e;
      }
      this._state.heapGarbageCollect();
      this.setupCallbackContext(contextSlot, handle, args, false, receiver);
    }
  }

  /**
   * Set up a context to run a class (or plain function) closure as a
   * CONSTRUCTOR with ordinary `new` semantics, initiated by the host
   * (Runtime.constructClosure). Mirrors OP_NEW's receiver setup:
   * allocates the receiver with the closure's `.prototype` as its
   * [[Prototype]] (falling back to %ObjectPrototype%), binds `this` to
   * it and `@newtarget` to the closure itself, then stages arguments
   * like an ordinary callback. Constructor return-object rules and the
   * completion/abort duties are the caller's responsibility at
   * terminal (Runtime._settleConstruct) — the constructor body executes
   * as the context's top level, so no FRAME_FLAG_CONSTRUCTOR frame
   * exists to perform them in-vat.
   *
   * Returns the receiver's interned ObjectHandle (already retained — a
   * collector root for the whole drive; the caller owns the release).
   *
   * @param {number} contextSlot
   * @param {ClosureHandle} handle
   * @param {Array} args
   * @returns {ObjectHandle}
   */
  setupConstructContext(contextSlot, handle, args, _retryAfterGc = true) {
    const mem = this.memoryImage;
    let closurePointer = this.getClosurePointer(handle);
    if (closurePointer === null) {
      throw new Error('Callback has been released');
    }
    const functionFlags = mem.view.getUint32(
      mem.abs(closurePointer + FUNCTION.FUNCTION_FLAGS), true);
    if (functionFlags
        & (CLOSURE_FLAG_ARROW | CLOSURE_FLAG_ASYNC | CLOSURE_FLAG_GENERATOR)) {
      throw new TypeError('constructClosure: closure is not constructible');
    }

    try {
      // Allocate the receiver FIRST (it can gc; the scope does not exist
      // yet, so nothing partial is orphaned). Prototype = the closure's
      // own `prototype` property when it is an object, else
      // %ObjectPrototype% — exactly OP_NEW's rule.
      const receiverPointer = mem.allocateObject(4);
      closurePointer = this.getClosurePointer(handle); // may have moved
      const prototypeEntry = mem.objectFindOwnProperty(
        closurePointer, mem.internString('prototype'));
      mem.setObjectPrototype(receiverPointer,
        prototypeEntry && prototypeEntry.type === TYPE.OBJECT
          ? prototypeEntry.lo
          : mem.view.getUint32(mem.abs(STATE.OBJECT_PROTOTYPE), true));

      // Root the receiver across the whole drive (heap GC forwards
      // object-handle pointers). Grants: captured from the closure,
      // which the grant stack below mirrors.
      const receiverHandle = this.retainObjectWithGrants(
        receiverPointer, handle.capturedGrantSlots);

      const closure = mem.getClosure(closurePointer);
      mem.setContextInstructionIndex(contextSlot, closure.startInstruction);
      const callScope = mem.createScope(closure.scope);
      mem.setContextScope(contextSlot, callScope);
      mem.resetContextStacks(contextSlot);
      mem.setContextCompletionType(contextSlot, COMPLETION_NORMAL);
      for (const grantSlot of handle.capturedGrantSlots) {
        mem.pushGrantEntryForCallback(contextSlot, grantSlot);
      }

      // Bind `this` = receiver, `@newtarget` = the constructor itself
      // (host construction is always most-derived).
      mem.scopeSetRaw(callScope, mem.getBuiltinName(BUILTIN_NAME.THIS),
        TYPE.OBJECT, this.getObjectPointer(receiverHandle), 0);
      mem.scopeSetRaw(callScope, mem.getBuiltinName(BUILTIN_NAME.NEW_TARGET),
        TYPE.FUNCTION, this.getClosurePointer(handle), 0);

      const stagedCount = this.wasm.exports.callback_staged_argc(
        this.getClosurePointer(handle), args.length);
      const argsToPass = args.slice(0, stagedCount);
      const options = this.marshallingOptions(contextSlot);
      for (const arg of argsToPass) {
        mem.marshalResult(contextSlot, arg, options);
      }
      this._constructionNewTargetByContext.set(contextSlot, {
        generation: mem.getContextGeneration(contextSlot),
        closureHandle: handle,
      });
      return receiverHandle;
    } catch (e) {
      if (!_retryAfterGc || !(e instanceof HeapPressureSignal)
          || !this._state.heapGarbageCollect) {
        throw e;
      }
      this._state.heapGarbageCollect();
      return this.setupConstructContext(contextSlot, handle, args, false);
    }
  }

  /**
   * Retain a vat object under an explicit grant set when there is no live
   * context to capture from, such as property reads and construct setup.
   */
  retainObjectWithGrants(objectPointer, capturedGrantSlots) {
    const { handle, isNew } = this.membrane.retainObjectHandle(
      objectPointer, new Set(capturedGrantSlots), null);
    if (isNew) {
      this.objectRegistry.register(handle, { slot: handle.slot, version: handle.version });
    }
    return handle;
  }

  /**
   * Register a closure handle under an explicit grant set when there is
   * no live context, such as property-result closures.
   */
  registerClosureWithGrants(closurePointer, capturedGrantSlots, metadata = null) {
    const handle = this.membrane.registerClosureHandle(
      closurePointer, new Set(capturedGrantSlots), metadata);
    this.closureRegistry.register(handle, { slot: handle.slot, version: handle.version });
    return handle;
  }

  /**
   * Raw view of a terminal context's result value (the last
   * pending-stack slot). The construct settle path needs the heap
   * POINTER identity, which extractResultFromContext's copying
   * unmarshal discards.
   *
   * @param {number} contextSlot
   * @returns {{type: number, flags: number, lo: number, hi: number}}
   */
  readContextResultRaw(contextSlot) {
    const mem = this.memoryImage;
    const pendingPointer = mem.getContextPendingPointer(contextSlot) - 16;
    const absolute = mem.abs(pendingPointer);
    return {
      type: mem.view.getUint32(absolute, true),
      flags: mem.view.getUint32(absolute + 4, true),
      lo: mem.view.getUint32(absolute + 8, true),
      hi: mem.view.getUint32(absolute + 12, true),
    };
  }

  /**
   * Extract result from a specific context's pending stack.
   *
   * @param {number} contextSlot - The context slot
   * @param {{jsonOnly?: boolean}} options - Reject non-JSON heap value types
   * @returns {*} - JS value
   */
  extractResultFromContext(contextSlot, options = {}) {
    const mem = this.memoryImage;
    const pendingDepth = mem.getPendingDepth(contextSlot);
    if (pendingDepth === 0) {
      return undefined;
    }
    const ptr = mem.getContextPendingPointer(contextSlot) - 16;
    const marshallingOptions = {
      ...this.marshallingOptions(contextSlot),
      unwrapRational: true,
    };
    if (options.jsonOnly) {
      const baseUnmarshal = marshallingOptions.unmarshal;
      marshallingOptions.unmarshal = (type, dataLo, dataHi) => {
        if (type !== TYPE.NULL
            && type !== TYPE.BOOLEAN
            && type !== TYPE.INTEGER
            && type !== TYPE.RATIONAL
            && type !== TYPE.FLOAT
            && type !== TYPE.STRING
            && type !== TYPE.ARRAY
            && type !== TYPE.OBJECT) {
          throw new TypeError(`non-JSON SandScript value type ${type}`);
        }
        return baseUnmarshal?.(type, dataLo, dataHi);
      };
    }
    return mem.readValueAt(ptr, marshallingOptions);
  }

  /**
   * Extract result from top of pending stack.
   * Returns undefined if pending stack is empty (for statements).
   * @param {number} contextSlot - The context slot
   * @returns {*} - JS value
   */
  extractResult(contextSlot) {
    return this.extractResultFromContext(contextSlot);
  }

  // ===========================================================================
  // GC Support
  // ===========================================================================

  // ===========================================================================
  // Compaction
  // ===========================================================================

  /**
   * Wire in the session's Collector. Called once by session construction
   * after both the airlock and the collector exist. Required for
   * compactMembrane().
   */
  setCollector(collector) {
    this._state.collector = collector;
    this.membrane.onPressure = () => { this.compactMembrane(); };
  }

  /**
   * Wire an alternative heap-reachable-handle-slots computation for
   * compactMembrane() — the WAT collector's mark-only mode (stage 2).
   * The provider receives the walker so a differential provider can
   * also run the JS path and compare. Called once by session
   * construction when the session's gcCollector is 'wat' or
   * 'differential', like setCollector.
   *
   * @param {(walker: MembraneWalker) => Set<number>} provider
   */
  setLiveHandleSlotsProvider(provider) {
    this._state.liveHandleSlotsProvider = provider;
  }

  /**
   * Wire in the session's full heap GC (session.js's gc closure: heap
   * collect + pointer forwarding + membrane compaction). Called once by
   * session construction, like setCollector.
   *
   * Used by _settleLinkedPromiseBySlot to self-heal heap pressure
   * during a linked-promise settle marshal. The settle runs in a
   * microtask — never inside a synchronous session.run or a handler
   * invocation — so it is exactly as quiescent as the host's own gc
   * points. There is no owning context slot to route a memory_pressure
   * yield through (the slot that produced the promise resumed long
   * ago), so the host-driven gc-and-retry loop that covers
   * resumeWithValue's deferred marshals cannot reach this path;
   * without the self-heal the HeapPressureSignal escapes the
   * jsPromise.then callback as an unhandled rejection and the settle
   * value is lost.
   */
  setHeapGarbageCollect(fn) {
    this._state.heapGarbageCollect = fn;
  }

  /**
   * Reject every linked promise in the SAB with SnapshotOrphanedError.
   * Called by createSession after restore: the JS half of
   * each linked promise is gone (continuation closures don't serialize),
   * so the SS Promise has no settlement path and must be rejected.
   *
   * Drone code awaiting one of these promises will see the rejection
   * thrown at the await site on the next session.run().
   *
   * @returns {number} Count of promises rejected.
   */
  rejectOrphanedLinkedPromises() {
    const mem = this.memoryImage;
    const orphans = this.membrane.enumerateLinkedPromises();
    // Cache the count BEFORE we clear the table, so callers that read
    // linkedPromiseCount() after this method returns don't see 0
    // unconditionally. Hosts (e.g. a drone-restarted event) want to
    // surface the orphan count to subscribers — without this, the
    // post-restore count is always 0 because clearAllLinkedPromises()
    // below empties the SAB table after the reject pass succeeds.
    this._state.lastOrphanedLinkedPromiseCount = orphans.length;
    for (const {
      ssPromisePointer,
      parkedContextSlot,
      parkedContextGeneration,
    } of orphans) {
      // Suspend-registered entries
      // have a real parkedContextSlot and no SS-side waiters on the SS
      // promise. The standard "reject the SS promise + wake waiters"
      // path below would silently fail to wake the parked context.
      // Route to resumeWithThrow directly, mirroring the suspend branch
      // in _settleLinkedPromiseBySlot.
      if (parkedContextSlot !== LINKED_PROMISE_NO_PARKED_CONTEXT) {
        if (!mem.isContextIdentityLive(
          parkedContextSlot, parkedContextGeneration)) {
          this._reportStaleSettlement(
            parkedContextSlot, parkedContextGeneration);
          continue;
        }
        this.resumeWithThrow(
          parkedContextSlot, new SnapshotOrphanedError());
        this._enqueueSpawnedContexts([{
          slot: parkedContextSlot,
          generation: parkedContextGeneration,
        }]);
        continue;
      }

      const promiseDataPointer = ssPromisePointer + GC_HEADER_SIZE;
      // Defensive: if the promise isn't actually pending (shouldn't happen,
      // but the SAB could be corrupted), skip.
      if (mem.getPromiseStatus(promiseDataPointer) !== PROMISE_STATUS_PENDING) continue;

      // Build an SS Error object for the rejection value (mirrors what
      // _settleLinkedPromise does for JS Errors). Sourcing the message
      // from SnapshotOrphanedError keeps the canonical public symbol
      // load-bearing rather than duplicating its message string here.
      const errorMessage = new SnapshotOrphanedError().message;
      const errorObj = mem.allocateObject(1);
      mem.setObjectPrototype(errorObj, mem.getState(STATE.ERROR_PROTOTYPE));
      const messageKey = mem.internString('message');
      mem.objectSetRaw(errorObj, messageKey, TYPE.STRING, mem.internString(errorMessage), 0);

      mem.setPromiseStatus(promiseDataPointer, PROMISE_STATUS_REJECTED);
      const absData = mem.abs(promiseDataPointer);
      mem.view.setUint32(absData + PROMISE.VALUE, TYPE.OBJECT, true);
      mem.view.setUint32(absData + PROMISE.VALUE + 4, 0, true);
      mem.view.setUint32(absData + PROMISE.VALUE + 8, errorObj, true);
      mem.view.setUint32(absData + PROMISE.VALUE + 12, 0, true);

      // Process handlers and waiters so any drone code blocked on this
      // promise can resume on the next run cycle.
      const spawnedContexts = this.processHandlers(promiseDataPointer);
      const waiters = mem.popAllWaiters(promiseDataPointer);
      const settledValue = mem.getPromiseValue(promiseDataPointer);
      for (const waiterIdentity of waiters) { this._prepareWaiter(waiterIdentity.slot, waiterIdentity.generation, promiseDataPointer, PROMISE_STATUS_REJECTED, settledValue);
      spawnedContexts.push(waiterIdentity); }
      this._enqueueSpawnedContexts(spawnedContexts);
    }

    // Free every linked-promise slot — they're all dealt with now.
    this.membrane.clearAllLinkedPromises();
    return orphans.length;
  }

  /**
   * Enumerate live linked promises with per-slot detail useful to embedders
   * correlating against their own persisted state.
   *
   * Returns an array of entries:
   *   - slot: linked-promise slot index
   *   - ssPromisePointer: header pointer of the SS Promise
   *   - parkedSlots: array of context slots currently waiting on the SS
   *     Promise. Empty when nothing is awaiting (handlers may still be
   *     attached via .then/.catch). Multiple entries possible — sandscript
   *     allows several waiters per promise.
   *   - parkedContextSlot: -1 for JS-Promise-backed entries (linkJSPromise);
   *     a real context slot for suspend-registered entries (context.suspend
   *     going through _setupSuspension). The two paths wake differently
   *     post-restore: standard SS-waiter wake vs. resumeWithValue on the
   *     named context.
   *
   * @returns {Array<{slot:number, ssPromisePointer:number, parkedSlots:number[], parkedContextSlot:number}>}
   */
  enumerateLinkedPromises() {
    const mem = this.memoryImage;
    const out = [];
    for (const entry of this.membrane.enumerateLinkedPromises()) {
      const promiseDataPointer = entry.ssPromisePointer + GC_HEADER_SIZE;
      const parkedSlots = [];
      let waiterPointer = mem.getPromiseWaiters(promiseDataPointer);
      const contextCapacity = mem.getContextTableCapacity();
      while (waiterPointer !== 0) {
        if (parkedSlots.length >= contextCapacity) {
          throw new Error(
            `enumerateLinkedPromises: waiter list of promise ${promiseDataPointer} ` +
            `exceeds the context table capacity (${contextCapacity})`);
        }
        const waiterAddress = mem.abs(waiterPointer);
        parkedSlots.push(mem.view.getUint32(
          waiterAddress + PROMISE_WAITER.CONTEXT_SLOT, true));
        waiterPointer = mem.view.getUint32(
          waiterAddress + PROMISE_WAITER.NEXT, true);
      }
      out.push({
        slot: entry.slot,
        ssPromisePointer: entry.ssPromisePointer,
        parkedSlots,
        parkedContextSlot: entry.parkedContextSlot,
      });
    }
    return out;
  }

  /**
   * Settle a single linked promise from the embedder side.
   *
   * Used by embedders that, post-restore, can recover the value for a
   * specific in-flight external call (typically by correlating the
   * linked-promise slot against persisted state stored via
   * `membrane.setEmbedderState`). Parked SS waiters are woken via the
   * normal spawned-context queue.
   *
   * Throws if `slot` is not a live linked-promise entry. (Already-settled
   * or never-allocated slots are a programming error on the embedder's
   * part, not a recoverable condition.)
   *
   * @param {number} slot
   * @param {*} value - SS value (marshalled the same way as a JS handler return)
   */
  settleLinkedPromise(slot, value) {
    if (!this.membrane._linkedPromiseSlotIsLive(slot)) {
      throw new Error(
        `settleLinkedPromise: slot ${slot} is not a live linked-promise entry`);
    }
    this._settleLinkedPromiseBySlot(slot, PROMISE_STATUS_RESOLVED, value);
  }

  /**
   * Reject a single linked promise from the embedder side. Mirror of
   * `settleLinkedPromise`; passes the value as a rejection reason and
   * sets status to REJECTED. JS Error instances are marshalled into an
   * SS Error object (preserving `.message`) the same way the auto-reject
   * path does.
   *
   * @param {number} slot
   * @param {*} error - Typically a JS Error; any SS-marshallable value works.
   */
  rejectLinkedPromise(slot, error) {
    if (!this.membrane._linkedPromiseSlotIsLive(slot)) {
      throw new Error(
        `rejectLinkedPromise: slot ${slot} is not a live linked-promise entry`);
    }
    this._settleLinkedPromiseBySlot(slot, PROMISE_STATUS_REJECTED, error);
  }

  /**
   * Reclaim dead handles, dead grants, orphaned id-list runs, and orphaned
   * arena bytes from the membrane buffer.
   *
   * Policy R1 (lazy reclaim): a slot is freed only if it has NO references
   * — not in the SS heap, not on any context's grant stack, not in the
   * closure-handle registry, not in rootGrants. Revoked grants whose slot
   * is still on a suspended drone's grant stack stay allocated; they are
   * reclaimed once the drone unwinds.
   *
   * Quiescence: must NOT be called from inside a handler that the airlock
   * invoked synchronously. Safe between dispatch cycles. Documented host
   * contract; no enforcement.
   *
   * @returns {Object} stats from the compaction pass
   */
  compactMembrane() {
    if (!this._state.collector) {
      throw new Error('compactMembrane: collector not wired (call setCollector first)');
    }
    const walker = new MembraneWalker(this.memoryImage, this._state.collector, this, this.membrane);
    const liveHandleSlots = this._state.liveHandleSlotsProvider
      ? this._state.liveHandleSlotsProvider(walker)
      : walker.collectLiveHandleSlots();
    // Pinned / in-flight / deferred-marshal roots are unioned by
    // _compactMembraneFromLiveHandleSlots — shared with the
    // session.gc() path so both compaction entry points protect
    // the same sets.
    return this._compactMembraneFromLiveHandleSlots(walker, liveHandleSlots);
  }

  /**
   * Membrane compaction when the heap-reachable handle slots were ALREADY
   * collected by a GC mark pass (session.gc() observes TYPE.EXTERNAL slots
   * inline and passes them here). Skips the walker's own mark phase; the
   * remainder of the walk and compaction is identical to compactMembrane().
   *
   * @param {Set<number>} liveHandleSlots - heap-reachable handle slots from
   *   the GC mark pass.
   * @returns {Object} stats from the compaction pass.
   */
  compactMembraneFromLiveHandleSlots(liveHandleSlots) {
    if (!this._state.collector) {
      throw new Error('compactMembraneFromLiveHandleSlots: collector not wired (call setCollector first)');
    }
    const walker = new MembraneWalker(this.memoryImage, this._state.collector, this, this.membrane);
    return this._compactMembraneFromLiveHandleSlots(walker, liveHandleSlots);
  }

  _compactMembraneFromLiveHandleSlots(walker, liveHandleSlots) {
    // Pinned handles are live by fiat — union them in BEFORE the
    // walk so step (5) (live handles contribute their authorizing
    // grants) covers them too. Liveness guard: a pinned slot can
    // only die through compaction (regular handles have no explicit
    // drop), so a dead entry here would be a bug — but a stale pin
    // must never resurrect a freed slot.
    for (const slot of this._state.pinnedHandleSlots) {
      if (this.membrane._handleSlotIsLive(slot)) liveHandleSlots.add(slot);
    }
    // In-flight handles (registered during the current dispatch,
    // not yet marshalled onto the SS heap) are roots for BOTH
    // compaction paths — membrane pressure (compactMembrane) and
    // heap gc (session.gc → here).
    // The detached (null-key) bucket is honored ONLY for pressure-
    // triggered compaction (membrane._retryOnPressure sets `compacting`
    // around the onPressure hook). It protects the synchronous
    // register → grant.add(pressure) → resolve window inside reply
    // callbacks. At an EXPLICIT compaction (compactMembrane called at
    // quiescence, session.gc) a detached handle with no SS reference is
    // an orphan by the lazy-reclaim contract — hosts that mint-and-drop
    // outside dispatch rely on those being reaped. Heap-pressure during
    // the resolve's marshal needs no bucket: the value is stashed in
    // _deferredMarshals (walked above) before any gc can run.
    const pressureTriggered = this.membrane._state.compacting;
    for (const [bucketKey, bucket] of this._state.inFlightHandleSlotBuckets) {
      if (bucketKey === null && !pressureTriggered) continue;
      for (const slot of bucket) {
        if (this.membrane._handleSlotIsLive(slot)) liveHandleSlots.add(slot);
      }
    }
    // Link-time snapshots: handles that may still be delivered by a
    // pending linked JS promise's settle marshal. Honored by both
    // compaction paths — the pending window legitimately spans
    // explicit gcs.
    for (const snapshot of this._state.inFlightSnapshotsByLinkedPromise.values()) {
      for (const slot of snapshot) {
        if (this.membrane._handleSlotIsLive(slot)) liveHandleSlots.add(slot);
      }
    }
    // Deferred marshals are roots too: a resolve that hit heap
    // pressure parked its VALUE in a JS-side stash awaiting the
    // post-gc drain. Any handle inside that value has no SS-heap
    // reference yet and may already have aged out of the in-flight
    // set (runContext clears it at the top of the wake) — without
    // this walk, the gc that the drain is waiting for would reap
    // the very handle the drain is about to marshal.
    for (const stash of this._deferredMarshals.values()) {
      collectHandleSlots(stash.value, liveHandleSlots);
    }
    // Handles held by args the runtime has enqueued
    // for a fired closure call but not yet marshaled. The closure queue spans
    // dispatch cycles (unlike the per-dispatch in-flight buckets above), so
    // without this a compaction reaps+reuses the slot and the queued arg
    // marshals as a stale Handle.
    if (this.hooks.inFlightClosureArgHandleSlots) {
      for (const slot of this.hooks.inFlightClosureArgHandleSlots()) {
        if (this.membrane._handleSlotIsLive(slot)) liveHandleSlots.add(slot);
      }
    }
    const liveSets = walker.walkFrom(liveHandleSlots);
    // Grant-side JS-holder roots,
    // mirroring the pinned/in-flight handle roots above: pinned grants
    // (long-lived capability grants held only in host variables between
    // grant blocks) and grants inside an open approval window (created
    // by onGrantRequest, stack entries not yet pushed). Unioned AFTER
    // walkFrom because nothing downstream derives from grant liveness —
    // grants reference neither grants nor handles. Both compaction
    // paths honor both sets: an async approval legitimately spans
    // event-loop turns, so even an explicit quiescent compaction can
    // interleave with an open window. Same liveness guard as pinned
    // handles — a stale pin must never resurrect a freed slot.
    for (const slot of this._state.pinnedGrantSlots) {
      if (this.membrane._grantSlotIsLive(slot)) liveSets.liveGrantSlots.add(slot);
    }
    for (const slot of this.membrane.openGrantApprovalWindowSlots()) {
      if (this.membrane._grantSlotIsLive(slot)) liveSets.liveGrantSlots.add(slot);
    }
    const stats = this.membrane.compact(liveSets);

    // Prune dispatch-map entries for the slots this pass freed. The maps
    // are keyed `${slot}` / `${slot}:name`; without pruning, a later
    // register() that reuses a freed slot inherits the previous tenant's
    // method handlers and getters, allowing the new handle to dispatch to
    // behavior registered for the released resource.
    if (stats.freedHandleSlots.length > 0) {
      const freed = new Set(stats.freedHandleSlots);
      for (const map of [this.handlers, this.handlerOptions, this.getters, this.setters]) {
        for (const key of map.keys()) {
          if (freed.has(parseInt(key, 10))) map.delete(key);
        }
      }
      // Slot-keyed maps prune alongside the string-keyed ones.
      for (const map of [this.constructibleRegistrations,
                         this.hasPropertyHandlers,
                         this.deletePropertyHandlers]) {
        for (const slot of map.keys()) {
          if (freed.has(slot)) map.delete(slot);
        }
      }
    }

    // Closure handles use a separate lazy
    // reclamation contract. Slots are freed only by explicit
    // dropClosureHandle() or by FinalizationRegistry firing when the
    // host's JS wrapper is collected. Compaction does NOT free closure-
    // handle slots on its own — the host might be planning to call
    // enumerateClosureHandles() and adopt them.
    //
    // What compaction DOES do for closure handles: repacks their
    // captured-grants list and metadata into the fresh pool/arena
    // (handled inside membrane.compact). So orphaned bytes get reclaimed
    // even though slots don't.
    stats.closureHandlesLive = this.membrane.enumerateClosureHandles().length;

    if (stats.handlesFreed > 0 && this.hooks.onCompact) {
      this.hooks.onCompact(liveSets.liveHandleSlots);
    }

    return stats;
  }

  /**
   * Returns the high-water mark of the SS heap's live set as a
   * segment-relative offset — the smallest value an SS-region resize
   * can shrink `heap_end` down to without losing live data.
   *
   * Caller must compact the heap first (so live data is packed in the
   * prefix `[heap_start, heap_pointer)`) and the shrink path must be
   * quiescent — any allocation between compact and shrink moves the
   * HWM. Same quiescence protocol as `compactMembrane()`.
   *
   * This read-only export exposes the post-compact heap floor to host
   * resize logic.
   */
  shrinkableHighWaterMark() {
    return this.wasm.exports.gc_shrinkable_high_water_mark();
  }

  /**
   * Count of currently-pending linked promises. Used by the host's run
   * loop to know whether to yield to the JS event loop and wait for
   * Promise settlement, and for host diagnostics.
   */
  linkedPromiseCount() {
    return this.membrane.enumerateLinkedPromises().length;
  }

  // =========================================================================
  // Slot stamping on internally-thrown SandScript errors
  //
  // Membrane lookups, marshalling, reject-path error construction, and
  // synchronous async-callback failures can throw while one context slot is
  // responsible. `_stampContextSlot` idempotently stamps that slot on the
  // original Error. `_stampContextSlotOnThrow` applies the stamp before
  // rethrowing at boundaries where the slot is known. Object identity, stack,
  // cause chain, and own properties remain intact for diagnostic envelopes.
  // =========================================================================

  /**
   * Stamp .contextSlot onto an error object (idempotent). No-op if
   * `err` is not an object, or already has a numeric .contextSlot.
   *
   * @param {any} err
   * @param {number} contextSlot
   * @returns {any} the (possibly-stamped) error
   */
  _stampContextSlot(err, contextSlot) {
    if (err === null || typeof err !== 'object') return err;
    if (typeof err.contextSlot === 'number') return err;
    try {
      err.contextSlot = contextSlot | 0;
    } catch (_e) {
      // Frozen / sealed error object — accept that the stamp didn't
      // take rather than masking the original throw.
    }
    return err;
  }

  /**
   * Run `fn()` with `.contextSlot` stamping on synchronous throw.
   * Returned values pass through untouched. Async (returned-promise)
   * rejections are not stamped by this wrapper. Async paths route through
   * reject() and the per-slot rejection queue, which hosts read through
   * lastRejectionError(slot).
   *
   * @template T
   * @param {number} contextSlot
   * @param {() => T} fn
   * @returns {T}
   */
  _stampContextSlotOnThrow(contextSlot, fn) {
    try {
      return fn();
    } catch (err) {
      this._stampContextSlot(err, contextSlot);
      throw err;
    }
  }

  // =========================================================================
  // Last-rejection error stash
  //
  // Hosts that build diagnostic envelopes around a cycle-error need
  // the *original* JS Error that was passed to reject() — sandscript's
  // own pending-stack representation only carries the .message. The
  // stash is keyed by contextSlot and ordered FIFO so a slot that
  // catches an early rejection (try/catch around await) and proceeds
  // to a second await doesn't lose either error.
  // =========================================================================

  /**
   * Read (without removing) the oldest stashed raw rejection error
   * for `contextSlot`, or null if no rejection has fired since the
   * slot's last successful resolve / consume.
   *
   * @param {number} contextSlot
   * @returns {any|null}
   */
  lastRejectionError(contextSlot) {
    const queue = this._rejectionErrorsBySlot.get(contextSlot);
    if (!queue || queue.length === 0) return null;
    return queue[0];
  }

  /**
   * Pop and return the oldest stashed raw rejection error for
   * `contextSlot`. The host calls this when it owns the diagnosis
   * (it has incorporated the error into a cycle-error envelope and
   * doesn't need it stashed anymore). Returns null if nothing was
   * stashed.
   *
   * @param {number} contextSlot
   * @returns {any|null}
   */
  consumeLastRejectionError(contextSlot) {
    const queue = this._rejectionErrorsBySlot.get(contextSlot);
    if (!queue || queue.length === 0) return null;
    const head = queue.shift();
    if (queue.length === 0) this._rejectionErrorsBySlot.delete(contextSlot);
    return head;
  }

  /**
   * Drop the entire rejection queue for `contextSlot`. Useful for
   * teardown paths that don't care to drain (the slot's done, the
   * host has moved on).
   *
   * @param {number} contextSlot
   */
  clearLastRejectionErrors(contextSlot) {
    this._rejectionErrorsBySlot.delete(contextSlot);
  }

  /**
   * Snapshot of membrane buffer occupancy. Hosts use this to decide when
   * to call compactMembrane() — or expose for telemetry.
   */
  membraneStats() {
    return this.membrane.stats();
  }

  /**
   * Get heap pointers that are still referenced by JS wrappers or by
   * pending linked promises. These are roots for GC: closure handles,
   * linked-promise SS promises, retained object handles, and every
   * surrogate prototype bound to a constructible handle.
   * @returns {Array<number>} - Array of header pointers
   */
  getClosureRoots() {
    const roots = this.membrane.closureHandleRootPointers();
    // Linked-promise SS Promise pointers must also be traced — their handler
    // chains and resolved values keep heap state alive.
    for (const lp of this.membrane.enumerateLinkedPromises()) {
      roots.push(lp.ssPromisePointer);
    }
    // Retained vat objects and surrogate prototypes.
    for (const ptr of this.membrane.objectHandleRootPointers()) {
      roots.push(ptr);
    }
    return roots;
  }

  /**
   * Update closure pointers (and linked-promise pointers) after GC compaction.
   * @param {Map<number, number>} forwarding - Old header pointer → new header pointer
   */
  updateClosurePointers(forwarding) {
    this.membrane.updateClosurePointersAfterGC(forwarding);
  }

  // ===========================================================================
  // Msgpack byte delivery
  // ===========================================================================

  /**
   * Allocate space for a msgpack payload on the SS heap and copy bytes
   * into it. Returns a segment-relative data pointer the host can hand
   * to the interpreter via a `MsgpackRef` value.
   *
   * The bytes get a real GC header so the heap walker advances over
   * them correctly during compaction, and the underlying heap object
   * survives GC as long as a `MsgpackRef` value references it.
   *
   * @param {Uint8Array | ArrayBuffer | ArrayBufferLike} source -
   *   The bytes to copy. May be a `Uint8Array`, an `ArrayBuffer`, or
   *   any TypedArray; in all cases `byteOffset` and `byteLength` apply.
   * @param {number} [byteOffset=0] - Starting offset within the source.
   * @param {number} [byteLength] - Number of bytes to copy. Defaults to
   *   the source's full byteLength minus byteOffset.
   * @returns {number} - Segment-relative data pointer to the
   *   newly-allocated bytes region. The region is laid out as
   *   `[length:4][bytes...]`; the caller's payload starts at
   *   `dataPointer + 4` (segment-relative) or
   *   `mem.abs(dataPointer + 4)` (absolute).
   */
  allocateMsgpackBytes(source, byteOffset = 0, byteLength) {
    const mem = this.memoryImage;

    // Normalise the source to a Uint8Array view of the requested span.
    const sourceBuffer = source.buffer ?? source;
    const sourceByteOffset = (source.byteOffset ?? 0) + byteOffset;
    const sourceByteLength = byteLength ?? (source.byteLength ?? source.length) - byteOffset;
    const sourceView = new Uint8Array(sourceBuffer, sourceByteOffset, sourceByteLength);

    // Allocate the heap region with a proper GC header.
    const dataPointer = mem.allocateMsgpackBytes(sourceByteLength);

    // Copy bytes into the data region. Bytes start at dataPointer + 4
    // (after the embedded length field).
    const bytesAbsolute = mem.abs(dataPointer + 4);
    mem.u8.set(sourceView, bytesAbsolute);

    return dataPointer;
  }

  // ===========================================================================
  // JS Promise ↔ SS Promise Bridging
  // ===========================================================================

  /**
   * Create a linked SS Promise from a JS Promise.
   *
   * Creates a pending SS Promise on the heap, registers its slot in the
   * membrane SAB so the heap pointer survives GC and snapshot/restore,
   * and attaches .then/.catch on the JS Promise to settle the SS Promise
   * when the JS Promise settles.
   *
   * On snapshot/restore, the JS Promise is gone — the SAB entry triggers
   * a SnapshotOrphanedError rejection on the restored SS Promise (handled
   * by createSession).
   *
   * Used by the auto-marshal path when an external-call handler returns
   * a Promise: the marshaller stores the returned `promiseDataPointer`
   * as the SS-side TYPE.PROMISE value the calling slot resumes with.
   *
   * @param {Promise} jsPromise - The JS Promise to link
   * @returns {number} - SS Promise data pointer
   */
  linkJSPromise(jsPromise) {
    return this._linkJSPromiseShared(jsPromise).promiseDataPointer;
  }

  /**
   * Register a JS Promise in the linked-promise table without returning
   * the SS-side data pointer to the caller. Same membrane / GC /
   * snapshot semantics as `linkJSPromise`, but no SS-interpreter caller
   * is consuming the result — so the slot doesn't park, no
   * EXIT_EXTERNAL_CALL plumbing, no marshalling.
   *
   * Use cases:
   *
   *   - **Capabilities that hold a long-pending host operation** without
   *     wanting to block the calling slot. E.g. a stream subscription
   *     whose lifetime promise should be tracked for orphan-on-restart
   *     semantics, but whose .subscribe() call should return immediately.
   *   - **Diagnostic tooling** that needs to put the airlock into a known
   *     state, such as one pending linked promise, without driving an
   *     external call. This permits quiescent restart-with-orphans checks
   *     without first pausing a slot.
   *
   * Returns the membrane SAB slot index for diagnostic purposes; most
   * callers ignore it.
   *
   * @param {Promise} jsPromise - The JS Promise to track
   * @returns {number} - Membrane linked-promise slot index
   */
  registerLinkedPromiseExternal(jsPromise) {
    return this._linkJSPromiseShared(jsPromise).slot;
  }

  /**
   * Shared body of linkJSPromise + registerLinkedPromiseExternal.
   * Returns both the data pointer (for the auto-marshal path) and the
   * slot (for the external-tracking path).
   * @private
   */
  _linkJSPromiseShared(jsPromise) {
    const mem = this.memoryImage;

    // Create pending SS Promise on the heap.
    const promiseDataPointer = mem.createPromise();
    const promiseHeaderPointer = promiseDataPointer - GC_HEADER_SIZE;

    // Register in the membrane SAB. The SAB stores header pointers (uniform
    // with closure handles); we convert at the boundary.
    const slot = this.membrane.registerLinkedPromise(promiseHeaderPointer);

    // Track JS Promise → SAB slot so the settlement callback can find the
    // entry to free. WeakMap so we don't keep promises alive ourselves.
    this.linkedPromiseSlotByJSPromise.set(jsPromise, slot);

    // Snapshot the current in-flight handle slots under this promise.
    // The value this promise resolves with may carry handles registered
    // during the dispatch that produced it, and the originating context
    // resumes (expiring its per-context bucket at the next runContext)
    // long before the settle marshals the value onto the heap. Without
    // the snapshot, a compaction in that window can reap the handle inside
    // the pending JS promise. The promise
    // detector is stateless — there is no per-context attribution at
    // link time — so this over-protects: every currently-in-flight
    // handle stays live until this promise settles. That only delays
    // reclamation; it never under-protects. Keyed by the JS promise
    // (not the SAB slot — the slot is freed mid-settle and can be
    // reused by a nested link before the settle marshal finishes).
    // Released in _settleLinkedPromise, after the settle marshal.
    const inFlightSnapshot = new Set();
    for (const bucket of this._state.inFlightHandleSlotBuckets.values()) {
      for (const handleSlot of bucket) inFlightSnapshot.add(handleSlot);
    }
    if (inFlightSnapshot.size > 0) {
      this._state.inFlightSnapshotsByLinkedPromise.set(jsPromise, inFlightSnapshot);
    }

    // Attach settlement callbacks
    jsPromise.then(
      (value) => this._settleLinkedPromise(jsPromise, PROMISE_STATUS_RESOLVED, value),
      (reason) => this._settleLinkedPromise(jsPromise, PROMISE_STATUS_REJECTED, reason),
    );

    return { promiseDataPointer, slot };
  }

  /**
   * Settle a linked SS Promise when its JS Promise settles.
   * Looks up the SAB slot, reads the (possibly GC-moved) header pointer,
   * marshals the value, processes handlers and waiters.
   *
   * @param {Promise} jsPromise - Identity key for the SAB slot lookup
   * @param {number} status - PROMISE_STATUS_RESOLVED or PROMISE_STATUS_REJECTED
   * @param {*} value - Resolved value or rejection reason
   */
  _settleLinkedPromise(jsPromise, status, value) {
    try {
      const slot = this.linkedPromiseSlotByJSPromise.get(jsPromise);
      if (slot === undefined) return; // Already settled, freed, or never registered.
      this.linkedPromiseSlotByJSPromise.delete(jsPromise);
      this._settleLinkedPromiseBySlot(slot, status, value);
    } finally {
      // The settle marshal has delivered (or definitively dropped) the
      // value — any handle slots snapshotted at link time are now
      // heap-reachable or garbage. Either way the snapshot's
      // protection ends here.
      this._state.inFlightSnapshotsByLinkedPromise.delete(jsPromise);
    }
  }

  /**
   * Slot-based settlement core. Used by both:
   *   - `_settleLinkedPromise(jsPromise, ...)` — the JS-Promise-driven path
   *     (handler returned a Promise that has now settled).
   *   - `settleLinkedPromise(slot, ...)` / `rejectLinkedPromise(slot, ...)`
   *     — the embedder-driven path (correlating against persisted state
   *     post-restore).
   *
   * The slot's entry in `linkedPromiseSlotByJSPromise` is left alone here;
   * callers responsible for the WeakMap (the JS-driven path) handle it.
   * The embedder path has no JS Promise to clean up — the slot's JS half
   * either never existed (post-restore) or is unreachable from sandscript.
   *
   * @param {number} slot
   * @param {number} status - PROMISE_STATUS_RESOLVED or PROMISE_STATUS_REJECTED
   * @param {*} value
   */
  _settleLinkedPromiseBySlot(slot, status, value) {
    if (!this.membrane._linkedPromiseSlotIsLive(slot)) return;

    const mem = this.memoryImage;

    // A non-sentinel
    // parkedContextSlot means this entry was registered by
    // _setupSuspension and the SS promise has no SS-side waiters — the
    // standard waiter wake at the bottom of this method would no-op,
    // so we route directly to resumeWithValue / resumeWithThrow on
    // the parked context instead. Embedders hit this path post-restore
    // (the original resolve/reject closures are gone with the worker;
    // a fresh mapping from external state correlates back to the slot
    // here).
    const parkedContextSlot = this.membrane._readLinkedPromiseParkedContextSlot(slot);
    const parkedContextGeneration =
      this.membrane._readLinkedPromiseParkedContextGeneration(slot);
    const hasParkedContext = parkedContextSlot !== LINKED_PROMISE_NO_PARKED_CONTEXT;

    // Heap-pressure self-heal: the settle marshal (and the SS Error
    // construction on the reject path) allocate, and can throw
    // HeapPressureSignal. This path has no owning context to route a
    // memory_pressure yield through, so on pressure we run the
    // session's gc directly (wired via setHeapGarbageCollect; settles
    // run in microtasks, which are exactly as quiescent as the host's
    // own gc points) and retry once. Persistent pressure after gc is a
    // genuine OOM and rethrows.
    //
    // Ordering inside an attempt is commit-last: nothing observable
    // (promise status, settle log, SAB slot free) happens until the
    // value is fully in the heap. The SAB slot in particular must stay
    // live across the gc — its header pointer is the only gc-forwarded
    // route back to the relocated SS promise, so it is re-read at the top
    // of every attempt. Freeing the slot or setting status before marshalling
    // would let a pressure throw leave the promise settled with a stale VALUE,
    // its waiters parked forever, the value unrecoverable, and the
    // HeapPressureSignal escaping jsPromise.then as an unhandled rejection.
    let garbageCollectAttempted = false;
    while (true) {
      try {
        if (hasParkedContext) {
          if (!mem.isContextIdentityLive(
            parkedContextSlot, parkedContextGeneration)) {
            this._reportStaleSettlement(
              parkedContextSlot, parkedContextGeneration);
            this.membrane._logLinkedPromiseSettle(
              slot, status === PROMISE_STATUS_RESOLVED);
            this.membrane._freeLinkedPromiseSlot(
              slot, MUTATION_TAG.LINKED_SETTLE);
            return;
          }
          // We deliberately do not apply revocation / grant-tagged
          // marshal / continuation-id checks here: post-restore the
          // SS-side grant stack was reconstructed from the snapshot
          // and the embedder is authoritative on whether to settle at all.
          // resumeWithValue handles its own pressure
          // (deferred-marshal stash, drained by the parked slot's next
          // runContext); resumeWithThrow's error construction can
          // throw pressure and rides this retry loop.
          if (status === PROMISE_STATUS_RESOLVED) {
            this.resumeWithValue(parkedContextSlot, value);
          } else {
            this.resumeWithThrow(parkedContextSlot, value);
          }
          this.membrane._logLinkedPromiseSettle(slot, status === PROMISE_STATUS_RESOLVED);
          this.membrane._freeLinkedPromiseSlot(slot, MUTATION_TAG.LINKED_SETTLE);
          this._enqueueSpawnedContexts([{
            slot: parkedContextSlot,
            generation: parkedContextGeneration,
          }]);
          return;
        }

        // Re-read per attempt: a gc between attempts relocates the SS
        // promise; the SAB entry's header pointer is forwarded.
        const headerPointer = this.membrane._readLinkedPromisePointer(slot);
        const promiseDataPointer = headerPointer + GC_HEADER_SIZE;

        // Don't settle if already settled (shouldn't happen, but
        // defensive). The slot is still consumed: log + free.
        if (mem.getPromiseStatus(promiseDataPointer) !== PROMISE_STATUS_PENDING) {
          this.membrane._logLinkedPromiseSettle(slot, status === PROMISE_STATUS_RESOLVED);
          this.membrane._freeLinkedPromiseSlot(slot, MUTATION_TAG.LINKED_SETTLE);
          return;
        }

        // Marshal the value into the promise's VALUE field, BEFORE
        // setting the status (nobody reads VALUE while pending, so a
        // pressure throw mid-marshal leaves a cleanly-pending promise
        // and orphan partial allocations the retry's gc reclaims).
        // Special handling for JS Error objects: create a proper SS
        // Error with message, since JS Error.message is non-enumerable
        // and won't survive generic marshalling.
        if (value instanceof Error) {
          const errorMessage = value.message || String(value);
          const errorObj = mem.allocateObject(1);
          mem.setObjectPrototype(errorObj, mem.getState(STATE.ERROR_PROTOTYPE));
          const messageKey = mem.internString('message');
          mem.objectSetRaw(errorObj, messageKey, TYPE.STRING, mem.internString(errorMessage), 0);
          const absData = mem.abs(promiseDataPointer);
          mem.view.setUint32(absData + PROMISE.VALUE, TYPE.OBJECT, true);
          mem.view.setUint32(absData + PROMISE.VALUE + 4, 0, true);
          mem.view.setUint32(absData + PROMISE.VALUE + 8, errorObj, true);
          mem.view.setUint32(absData + PROMISE.VALUE + 12, 0, true);
        } else {
          mem.marshalPromiseValue(promiseDataPointer, value, {});
        }
        mem.setPromiseStatus(promiseDataPointer, status);

        // Log the settle outcome BEFORE freeing the slot, so the
        // version recorded in the log matches the still-live slot's
        // version (the free bump happens next).
        this.membrane._logLinkedPromiseSettle(slot, status === PROMISE_STATUS_RESOLVED);
        this.membrane._freeLinkedPromiseSlot(slot, MUTATION_TAG.LINKED_SETTLE);

        // Process handlers and waiters — spawned contexts go to
        // pendingSpawnedContexts via _enqueueSpawnedContexts so the
        // host's onPendingSpawnedContexts hook fires and the host can
        // drain without polling.
        const spawnedContexts = this.processHandlers(promiseDataPointer);
        const waiters = mem.popAllWaiters(promiseDataPointer);
        const settledValue = mem.getPromiseValue(promiseDataPointer);
        for (const waiterIdentity of waiters) { this._prepareWaiter(waiterIdentity.slot, waiterIdentity.generation, promiseDataPointer, status, settledValue);
        spawnedContexts.push(waiterIdentity); }
        this._enqueueSpawnedContexts(spawnedContexts);
        return;
      } catch (e) {
        if (!(e instanceof HeapPressureSignal)
            || garbageCollectAttempted
            || !this._state.heapGarbageCollect) {
          throw e;
        }
        garbageCollectAttempted = true;
        this._state.heapGarbageCollect();
      }
    }
  }

  // ===========================================================================
  // Introspection APIs
  // ===========================================================================

  /**
   * Get handler method names registered for a handle.
   * @param {number} handleId - Handle ID
   * @returns {string[]} - Array of method names (empty array if none)
   */
  getHandlerNames(handleId) {
    const methods = [];
    for (const key of this.handlers.keys()) {
      // Keys are either "handleId" (direct call) or "handleId:method"
      if (key === String(handleId)) {
        methods.push('call');  // Direct call handler
      } else if (key.startsWith(`${handleId}:`)) {
        methods.push(key.slice(String(handleId).length + 1));
      }
    }
    return methods;
  }

  /**
   * Get the declared name for a handle.
   * @param {number} handleSlot - Handle slot
   * @returns {string|null} - Declared name or null if not declared
   */
  getDeclaredName(handleSlot) {
    return this.membrane.declarationNameBySlot(handleSlot) || null;
  }

  /**
   * Get all declarations as a map of handleSlot → name.
   * @returns {Map<number, string>}
   */
  getDeclarations() {
    const out = new Map();
    for (const entry of this.membrane.enumerateHandles()) {
      if (entry.declarationName) out.set(entry.handle.slot, entry.declarationName);
    }
    return out;
  }

  /**
   * Get callback info for a slot. Closure handles are SAB-resident; the host
   * typically has a ClosureHandle wrapper, so slot = handle.slot.
   * @returns {{closurePointer: number, capturedGrantIds: Set<number>}|null}
   */
  getCallbackInfo(slot) {
    if (!this.membrane._closureHandleSlotIsLive(slot)) return null;
    return {
      closurePointer: this.membrane._readClosurePointer(slot),
      capturedGrantIds: this.membrane._readCapturedGrantSet(slot),
    };
  }

  /**
   * Get all live closure handles with their info.
   * @returns {Array<{slot: number, closurePointer: number, capturedGrantIds: Set<number>}>}
   */
  getCallbacks() {
    return this.membrane.enumerateClosureHandles().map(e => ({
      slot: e.closureHandle.slot,
      closurePointer: e.closurePointer,
      capturedGrantIds: e.capturedGrantSlots,
    }));
  }

  /**
   * Enumerate live closure handles. Used by the host post-restore to walk
   * surviving closures and reattach them to its own listener tables.
   * Returns the wrappers + metadata; the host should hold any wrapper it
   * wants to keep, or call dropClosureHandle on ones it doesn't.
   */
  /**
   * Enumerate live closure handles and register newly-minted wrappers
   * with the FinalizationRegistry.
   *
   * Same return shape as `membrane.enumerateClosureHandles()`. The
   * difference: this method also wires JS-side wrapper-lifetime
   * tracking, so when the host eventually drops a wrapper, the SAB
   * slot is freed.
   *
   * Hosts should prefer THIS method over `membrane.enumerateClosureHandles()`
   * for the post-restore walk. The membrane-direct version is intended
   * for read-only introspection that does not change lifecycle.
   *
   * Walk the list,
   * match each entry to your listener table (typically by metadata),
   * STORE the wrapper to keep the slot alive — the FinalizationRegistry
   * fires when the wrapper is collected.
   */
  enumerateClosureHandles() {
    const list = this.membrane.enumerateClosureHandles();
    // Register newly-minted wrappers with FinalizationRegistry so JS-side
    // wrapper collection triggers SAB slot release. The cache guarantees
    // that wrappers minted on a previous enumerate/forSlot call return
    // the same identity here — we only register on first mint per slot
    // (isNewWrapper === true), avoiding double-registration that would
    // free the slot prematurely when one of two wrappers is collected.
    for (const entry of list) {
      if (entry.isNewWrapper) {
        this.closureRegistry.register(entry.closureHandle, entry.closureHandle.slot);
      }
    }
    return list;
  }

  /**
   * Relocate this airlock's memory image and membrane to new byte offsets
   * within the SAME WebAssembly.Memory buffer after a host has copied the
   * slab and needs the JS and WASM views to follow.
   *
   * @param {number} newSegmentBaseOffset - New base offset for the SS
   *   memory image (everything sandscript reads/writes is computed
   *   relative to this).
   * @param {number} newMembraneByteOffset - New byteOffset for the
   *   membrane within the SAB.
   * @param {number} [newMembraneByteLength] - New byteLength for the
   *   membrane (defaults to existing).
   */
  relocate(newSegmentBaseOffset, newMembraneByteOffset, newMembraneByteLength) {
    this.memoryImage.relocate(newSegmentBaseOffset);
    this.membrane.relocate(newMembraneByteOffset, newMembraneByteLength);
  }
}

// Walk a JS value tree and collect the slots of every Handle wrapper
// into `into`. Used by membrane compaction to treat deferred-marshal
// stashes as roots. Recurses into arrays and own enumerable
// properties of plain objects; binary leaves (Uint8Array /
// ArrayBuffer) and non-objects are skipped. Values reaching this
// walk come from host resolves — the same trees the marshaller
// itself walks, so the no-cycles assumption matches the marshal
// path's.
function collectHandleSlots(value, into) {
  if (value === null || typeof value !== 'object') return;
  if (isHandle(value)) {
    into.add(value.slot);
    return;
  }
  if (value instanceof Uint8Array || value instanceof ArrayBuffer) return;
  if (Array.isArray(value)) {
    for (const item of value) collectHandleSlots(item, into);
    return;
  }
  for (const item of Object.values(value)) collectHandleSlots(item, into);
}

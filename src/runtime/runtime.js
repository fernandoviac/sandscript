/**
 * Runtime — the canonical driver for a sandscript program.
 *
 * Composes the pieces in `src/runtime/`:
 *
 *   - capability resolution + topological ordering
 *   - setup orchestration (sequential, dependency-injected)
 *   - slot driver (status-dispatch loop + parked-slot resumption)
 *   - inbound message loop (inline)
 *   - closure-call queue (inline)
 *   - grant fanout — single-claim policy (inline)
 *   - lifecycle methods (quiesce / resume /
 *     notifyMemoryRelocated / gc / compactMembrane /
 *     terminate)
 *   - curated read-only stats surface
 *   - cross-realm-observable runtime-state cell
 *     (`runtime.runtimeState`, bound to the membrane SAB
 *     region — supersedes the JS-callback
 *     onParkedStateChange retired in v5 of the membrane
 *     format)
 *   - event hooks (onInboundMessage, onHandlerError)
 *
 * Spec: src/runtime/SPEC.md.
 *
 * Required session surface (read by this module — composed pieces
 * document their own additional requirements):
 *   - run(slot, fuel):                { status, error?, ... }
 *   - gc():                           { compacted, freed, ... }
 *   - relocate({ ... }):              void
 *   - resizeSegment({ ... }):         void
 *   - state(slot):                    object   (diagnostic)
 *   - registerExportClosure(name):    closure handle
 *   - memoryImage:
 *   - airlock:                        airlock instance, see below
 *
 * Required airlock surface (read by this module via session.airlock):
 *   - onGrantRequest:                 set by Runtime to fan out to capabilities
 *   - membrane:                       { resizeRegions, tick, captureDiagnostic }
 *   - membraneStats():                object
 *   - compactMembrane():              { freed, ... }
 *   - captureSlotDiagnostic(slot):    object
 *
 * Snapshotting is host-orchestrated: the host quiesces this runtime,
 * then snapshots its own vat memory and membrane buffer at will.
 * Sandscript exposes no snapshot/restore method on either
 * the session or the runtime. Resume vs boot is signaled via the
 * Runtime constructor's `resume: boolean` option.
 *
 * The scheduler and closure-drainer modules document the
 * additional session/airlock methods they each rely on.
 */

import {
  validateCapabilities,
  orderCapabilities,
  normalizeNeedSpec,
} from './capabilities.js';
import { RUNTIME_STATE, createRuntimeStateView } from './runtime-state.js';
import { createLedgerView, LEDGER_ACTIVITY } from './ledger.js';
import { serializeThrownError } from './serialize-error.js';
import { AttributedRejection } from '../fuel/attributed-rejection.js';
import {
  HEADER as MEMBRANE_HEADER,
  COST_KIND,
  isHandle,
  isClosureHandle,
  isObjectHandle,
} from '../membrane/index.js';
import { TYPE, STATE } from '../fuel/constants.js';
import {
  MissingDependencyError,
  CapabilityCycleError,
  MultipleEndorsementsError,
  RuntimeBootError,
  DuplicateCapabilityNameError,
  UncaughtScriptError,
  ResultMarshallingError,
} from './errors.js';

export const DEFAULT_FUEL = 100_000;

// Sentinel for "no scheduling slot is associated with this closure
// call" — used when scheduleClosureCall is invoked without a
// callerSlot (typical for JS-side timer fires or embedder entry
// points where no SS slot was active). Matches the ledger's
// reserved sentinel; the runtime never writes 0 as "no slot"
// (slot 0 is a real, legitimate slot id).
const NO_CALLER_SLOT = 0xFFFFFFFF;
const TEMPORARY_EXPORT_HANDLE_METADATA_KIND =
  'sandscript-runtime-temporary-export';
function validateJsonValue(value, path, ErrorClass, label, ancestors = new Set()) {
  if (value === null
      || typeof value === 'boolean'
      || typeof value === 'string') {
    return;
  }
  if (typeof value === 'number') {
    if (Number.isFinite(value)) return;
    throwJsonShapeError(ErrorClass, path, 'non-finite number', label);
  }
  if (typeof value !== 'object') {
    throwJsonShapeError(ErrorClass, path, typeof value, label);
  }
  if (ancestors.has(value)) {
    throwJsonShapeError(ErrorClass, path, 'cyclic object', label);
  }
  if (!Array.isArray(value) && Object.getPrototypeOf(value) !== Object.prototype) {
    const constructorName = value?.constructor?.name ?? 'non-plain object';
    throwJsonShapeError(ErrorClass, path, constructorName, label);
  }

  ancestors.add(value);
  if (Array.isArray(value)) {
    for (let index = 0; index < value.length; index++) {
      validateJsonValue(value[index], `${path}[${index}]`, ErrorClass, label, ancestors);
    }
  } else {
    for (const [key, child] of Object.entries(value)) {
      const childPath = /^[A-Za-z_$][A-Za-z0-9_$]*$/.test(key)
        ? `${path}.${key}`
        : `${path}[${JSON.stringify(key)}]`;
      validateJsonValue(child, childPath, ErrorClass, label, ancestors);
    }
  }
  ancestors.delete(value);
}

function throwJsonShapeError(ErrorClass, path, description, label) {
  if (ErrorClass === ResultMarshallingError) {
    throw new ResultMarshallingError(path, description);
  }
  throw new ErrorClass(
    `Runtime.invokeExport: ${label} at ${path} is not JSON-shaped (${description})`);
}


export class Runtime {
  constructor(opts) {
    this._validateConstructorOpts(opts);

    // The session is the interpreter (WASM engine + airlock +
    // memoryImage + parser). Runtime is one scheduler on top of one
    // session. The session is runtime-private after construction;
    // embedders use runtime methods only.
    this._session   = opts.session;
    this._inbound   = opts.inboundChannel;
    this._outbound  = opts.outboundChannel;

    // Capability inputs.
    this._capabilities = opts.capabilities;
    this._hostServices = opts.hostServices;
    this._subsystems   = opts.subsystems;

    // Wire limit passed through to cap.setup() options so caps can
    // size payloads to fit the channel.
    this._maxMessageBytes = opts.maxMessageBytes ?? undefined;

    // Hooks (mutable post-construction). Assignable as public
    // properties per SPEC.md. onParkedStateChange retired in v5
    // of the membrane format — embedders observe scheduler-state
    // transitions via runtime.runtimeState (a SAB cell with
    // Atomics.wait semantics).
    this.onInboundMessage          = opts.onInboundMessage ?? null;
    this.onHandlerError            = opts.onHandlerError ?? null;
    this.composeErrorEnvelope      = opts.composeErrorEnvelope ?? null;
    this.extraSchedulerBackpressure = opts.extraSchedulerBackpressure ?? null;

    // Fuel-exhaustion boundary hook (optional): consulted in
    // driveLoop's 'paused' case when a slot runs out of fuel.
    // Receives the slot and returns the number of fuel units to
    // inject for the next run — > 0 continues the drive with that
    // budget, falsy stops driving and leaves the slot parked (alive
    // and resumable, same shape as an await/suspended park; NOT a
    // kill — the embedder owns termination). May return the number
    // directly (sync, no await) or a Promise of it (awaited). When
    // null, driveLoop refills with the default quantum and continues
    // forever — byte-for-byte today's behavior. Mutable
    // post-construction. The runtime keeps no fuel policy; the
    // embedder decides both whether to continue and how much.
    this.onFuelExhausted           = opts.onFuelExhausted ?? null;

    // Observability hooks cover six independent concerns. Each is opt-in
    // and has zero cost when null.
    this.onExternalCall            = opts.onExternalCall ?? null;
    this.onGrant                   = opts.onGrant ?? null;
    this.onClosureDispatch         = opts.onClosureDispatch ?? null;
    this.onSlotLifecycle           = opts.onSlotLifecycle ?? null;
    this.onSuspend                 = opts.onSuspend ?? null;
    this.onGarbageCollect          = opts.onGarbageCollect ?? null;

    // Scheduler-idle notification (optional): a byte-free hook the
    // runtime calls at each arrival at final scheduler idle — after
    // the last concurrent drive returns, and after bootOnly()
    // completes. Called AFTER the runtime publishes SCHEDULER_IDLE,
    // synchronously, with no argument, and never awaited. The hook
    // reports a position only: it does not promise the runtime stays
    // idle after it returns. An embedder that needs stable bytes must
    // quiesce() the runtime (or use another complete concurrency
    // protocol) — the hook alone makes no later read coherent.
    //
    // Deliberately NOT keyed on runtime-state cell transitions:
    // _publishState dedupes no-op writes and the membrane constructs
    // the cell as SCHEDULER_IDLE, so bootOnly() on a fresh runtime
    // produces no cell edge a passive reader could observe. The hook
    // fires at the two named call sites regardless (see
    // _fireSchedulerIdle). quiesce()'s QUIESCED publication and
    // resume()'s idle publication do NOT fire the hook — an embedder
    // that quiesces in response to the notification would otherwise
    // loop. Throws surface via onHandlerError; validated at
    // construction (RuntimeBootError on a non-function).
    this._onSchedulerIdle = opts.onSchedulerIdle ?? null;

    // Diagnostic surfaces: views bound to the runtime-state cell
    // and the in-flight ledger inside the membrane SAB. The
    // membrane (v5+) allocated both regions and initialized them;
    // these bindings give JS-realm callers get/set/wait and
    // claim/walk/free APIs. Cross-realm observers read the
    // underlying bytes directly via Atomics.load.
    // notifyMemoryRelocated rebinds both views.
    {
      const membrane = this._session.airlock.membrane;
      const buffer = membrane.buffer;
      const baseOffset = membrane.byteOffset;
      const runtimeStateOffset = membrane.view.getUint32(
        MEMBRANE_HEADER.RUNTIME_STATE_OFFSET, true);
      const ledgerOffset = membrane.view.getUint32(
        MEMBRANE_HEADER.LEDGER_OFFSET, true);
      const ledgerCapacity = membrane.view.getUint32(
        MEMBRANE_HEADER.LEDGER_CAPACITY, true);
      this.runtimeState = createRuntimeStateView({
        buffer,
        byteOffset: baseOffset + runtimeStateOffset,
      });
      this.ledger = createLedgerView({
        buffer,
        byteOffset: baseOffset + ledgerOffset,
        capacity: ledgerCapacity,
      });
    }

    // Hand the ledger to the airlock so it can claim/free
    // entries for park/resume sites it knows about
    // (AWAITING_PROMISE). The airlock is constructed by the
    // session before the runtime exists, so we wire the ledger
    // in after the fact via a setter.
    this._session.airlock.setLedger(this.ledger);

    // Resolve host-owned invocation context through the existing
    // generation-safe invocation owner registry (_invokeWaiters) —
    // deliberately no second slot-to-owner map: insertion and removal
    // share the one owner lifecycle in _beginInvoke/_transitionInvoke,
    // so the association dies before freeContext permits reuse and
    // before the caller's result promise settles. A reused slot or a
    // stale generation never resolves.
    this._session.airlock.setHostInvocationContextResolver(
      (slot, generation) => {
        const owner = this._invokeWaiters.get(slot);
        if (!owner || owner.terminal || owner.generation !== generation) {
          return undefined;
        }
        return owner.opts.hostInvocationContext;
      });

    // Constructor-time options.
    this._fuel                    = opts.fuel ?? DEFAULT_FUEL;
    this.name                     = opts.name ?? 'sandscript-runtime';

    // Lifecycle flags.
    this._started    = false;
    this._terminated = false;

    // Capability setup return values, keyed by capability name.
    // Available to subsequent capabilities via `needs: { x: 'capability' }`.
    this._capabilityReturns = new Map();
    this._terminationHooks  = []; // { name, fn }
    this._resumeHooks       = []; // { name, fn }
    this._compactHooks      = []; // { name, fn }
    // Capability onUncaughtException hooks — fired for every error that
    // terminates a slot with NO drone code catching it (uncaught SS
    // throws, interpreter faults, OOM). NOT fired for handler throws
    // the drone catches, or for diagnostic signals. Lets a capability
    // carry drone exceptions to its embedder-facing surface (the DOM
    // capability forwards to its backend's reportException).
    this._uncaughtExceptionHooks = []; // { name, fn }
    this._ordered           = null; // set by start()

    // Capability grant-endorsers — populated during capability
    // setup. Each entry is { name, hook }; runGrantFanout fans
    // out to all of them when the airlock fires a grant request.
    this._grantEndorsers = [];

    // Slot-driver state (formerly the Scheduler class). The
    // driver is a status-dispatch loop, one invocation per
    // active slot, all running concurrently as JS microtasks.
    // It does not pick what to run; it drives whatever it's
    // told to.
    this._driverStats = {
      inFlight:    0,
      spawnedRuns: 0n,
      errors:      0n,
    };
    this._quiesced       = false;
    this._inFlightDrives = new Set();
    this._quiesceWaiters = [];
    // One active drive per context identity. A linked-promise settlement can
    // arrive while the drive that parked on it is still unwinding. Such a wake
    // is deferred until that drive has published its parked ownership; driving
    // the same slot concurrently loses one of the two state transitions.
    this._drivingSlotIdentities = new Map();

    // Closure-call queue. scheduleClosureCall enqueues;
    // _drainClosureQueue drains one entry at a time via
    // runClosureCall.
    this._closureQueue       = [];
    this._closureDraining    = false;
    // The closure-call entry currently being driven
    // (dequeued from _closureQueue but whose args may not be marshaled yet).
    // Its arg handles must stay compaction roots across that gap; see
    // _collectQueuedClosureArgHandleSlots and the drainer.
    this._drainingClosureCall = null;

    // Per-invocation ownership. A waiter carries the context allocation
    // generation so a wake for an older owner can never route to a reused slot.
    this._invokeWaiters = new Map();
    this._deferredWakes = new Map();
    // Abort requests observed while quiesced remain host-owned until resume;
    // mutating the SandScript image during a quiescent snapshot window is forbidden.
    this._deferredCancellations = new Map();
    // Deferred entries already own their abort listener. resume() moves the
    // same owner into _invokeWaiters after context allocation.
    this._deferredInvokes = [];
    // Slot 0 is the persistent top-level context: nothing ever calls
    // freeContext(0) directly, and embedders rely on driving fresh code
    // on it indefinitely, even after its original program awaits a
    // genuine async host call and finishes. Unlike invokeClosure calls,
    // slot 0 has no per-invocation owner. _rootSlots gives it permanent
    // runtime ownership so pendingSpawnedContexts wakes route through the
    // root drive path instead of the disposable background-drive path,
    // which frees ownerless slots on terminal. _drainPendingSpawned checks
    // both ownership registries before choosing the background path.
    this._rootSlots = new Set([0]);
    // Deferred cleanups for closure-call slots whose drive PARKED
    // (suspended / await / paused) instead of reaching terminal.
    // runClosureCall registers { slot → free + dropOnComplete };
    // the background drive that eventually drives the slot to a
    // terminal status consumes the entry via takeParkedCleanup.
    this._parkedSlotCleanups = new Map();
    // Last value written to runtime-state cell, used to dedup
    // no-op transitions (avoid Atomics.notify churn).
    this._publishedState = RUNTIME_STATE.SCHEDULER_IDLE;

    // Inbound subscription teardown. start() registers an
    // onMessage callback on the inbound channel; terminate()
    // calls this to unsubscribe.
    this._inboundUnsubscribe = null;

    // Resume mode is host-supplied. The host knows whether it just
    // laid out a fresh vat (resume=false) or copied snapshot bytes
    // into the buffers (resume=true). Capabilities that register
    // onBoot / onResume hooks may inspect this before start() runs.
    this._resume = Boolean(opts.resume);
    this._restoredInvocationRootsCancelled = false;
  }

  // --------------------------------------------------------
  // Public surface
  // --------------------------------------------------------

  /**
   * Cancel invocation contexts and release temporary export handles whose
   * process-local owners did not survive a snapshot restore. Valid exactly
   * once on a restored runtime before start().
   * @returns {number} number of invocation roots cancelled
   */
  cancelRestoredInvocationRoots() {
    if (!this._resume) {
      throw new Error(
        'Runtime.cancelRestoredInvocationRoots: runtime was not restored');
    }
    if (this._started) {
      throw new Error(
        'Runtime.cancelRestoredInvocationRoots: start() has already begun');
    }
    if (this._restoredInvocationRootsCancelled) {
      throw new Error(
        'Runtime.cancelRestoredInvocationRoots: operation already completed');
    }

    this._restoredInvocationRootsCancelled = true;
    const memoryImage = this._session.memoryImage;
    let cancelledCount = 0;
    for (let slot = 0; slot < memoryImage.getContextTableCapacity(); slot++) {
      if (memoryImage.getContextBase(slot) === 0
          || !memoryImage.isContextInvocationRoot(slot)) {
        continue;
      }
      const generation = memoryImage.getContextGeneration(slot);
      if (!this._session.airlock.cancelContext(slot, generation)) {
        throw new Error(
          `Runtime.cancelRestoredInvocationRoots: context ${slot} generation ` +
          `${generation} was not live`);
      }
      if (memoryImage.isContextIdentityLive(slot, generation)) {
        throw new Error(
          `Runtime.cancelRestoredInvocationRoots: context ${slot} generation ` +
          `${generation} remained live after cancellation`);
      }
      cancelledCount++;
    }
    for (const entry of this._session.airlock.enumerateClosureHandles()) {
      if (entry.metadata?.kind === TEMPORARY_EXPORT_HANDLE_METADATA_KIND) {
        this._session.airlock.dropClosureHandle(entry.closureHandle);
      }
    }
    return cancelledCount;
  }

  /**
   * Wire hooks, set up capabilities in dependency order,
   * start the channel main loop. Returns a Promise that
   * resolves when the runtime is booted and the main loop
   * is running.
   */
  async start() {
    if (this._started) {
      throw new RuntimeBootError('start() called twice', { phase: 'start' });
    }
    if (this._terminated) {
      throw new RuntimeBootError('start() called after terminate()', { phase: 'start' });
    }
    if (!this.onInboundMessage) {
      throw new RuntimeBootError(
        'onInboundMessage must be registered before start()',
        { phase: 'start' });
    }
    this._started = true;

    // ---- Capability resolution + setup -----------------
    try {
      validateCapabilities(this._capabilities, this._hostServices, this._subsystems);
    } catch (e) {
      throw new RuntimeBootError(
        `capability validation failed: ${e.message}`,
        { cause: e, phase: 'validate' });
    }

    try {
      this._ordered = orderCapabilities(this._capabilities);
    } catch (e) {
      throw new RuntimeBootError(
        `capability ordering failed: ${e.message}`,
        { cause: e, phase: 'order' });
    }

    // Wire the airlock's grant request to the fanout. Endorsers
    // are accumulated below as capabilities set up.
    this._session.airlock.onGrantRequest = (identifier) =>
      runGrantFanout(identifier, this._grantEndorsers,
        (err) => this._fireHandlerError(err));

    // Wire the airlock's spawn hook to our parked-slot drain.
    // Sandscript fires this whenever it pushes slots into
    // pendingSpawnedContexts (linked-promise settles, etc.).
    this._session.airlock.onPendingSpawnedContexts = () => this._drainPendingSpawned();

    // Thread observability hooks to the airlock so airlock-level
    // instrumentation sites can fire them.
    this._session.airlock.onExternalCall = this.onExternalCall;
    this._session.airlock.onGrant = this.onGrant;
    this._session.airlock.onSuspend = this.onSuspend;
    this._session.airlock.onSlotLifecycle = this.onSlotLifecycle;

    // Surface handle slots referenced by args the
    // runtime has enqueued for a fired closure call but not yet marshaled, so
    // membrane compaction keeps them alive across the queue's lifetime (it
    // spans dispatch cycles, beyond the airlock's per-dispatch in-flight set).
    this._session.airlock.hooks.inFlightClosureArgHandleSlots = () =>
      this._collectQueuedClosureArgHandleSlots();

    // Surface MsgpackRef args the runtime has enqueued but not yet marshaled,
    // so session.gc() keeps their blobs alive as external roots and forwards
    // each ref's raw parentDataPointer when compaction moves the blob. A
    // pressure GC during a queued fire burst must not collect blobs before
    // their MSGPACK_REF values are marshaled into callback scopes.
    this._session.airlock.hooks.inFlightMsgpackRefs = () =>
      this._collectQueuedClosureArgMsgpackRefs();

    this._session.airlock.onCompact = (liveHandleSlots) => {
      for (const hook of this._compactHooks) {
        try { hook.fn(liveHandleSlots); } catch (e) {
          this._fireHandlerError(e);
        }
      }
    };

    // ---- Setup each capability in dependency order ------
    for (const cap of this._ordered) {
      const resolvedContext = this._buildResolvedContext(cap);
      const options = { resume: this._resume, maxMessageBytes: this._maxMessageBytes };
      let result;
      try {
        result = await cap.setup(this._session.airlock, resolvedContext, options);
      } catch (e) {
        throw new RuntimeBootError(
          `capability '${cap.name}' setup threw: ${e.message}`,
          { cause: e, phase: 'setup' });
      }
      result = result ?? {};
      this._capabilityReturns.set(cap.name, result);

      // Wire the capability's hooks.
      if (typeof result.onGrantRequest === 'function') {
        this._grantEndorsers.push({ name: cap.name, hook: result.onGrantRequest });
      }
      if (typeof result.onDroneTerminated === 'function') {
        this._terminationHooks.push({ name: cap.name, fn: result.onDroneTerminated });
      }
      if (typeof result.onResume === 'function') {
        this._resumeHooks.push({ name: cap.name, fn: result.onResume });
      }
      if (typeof result.onCompact === 'function') {
        this._compactHooks.push({ name: cap.name, fn: result.onCompact });
      }
      if (typeof result.onUncaughtException === 'function') {
        this._uncaughtExceptionHooks.push({ name: cap.name, fn: result.onUncaughtException });
      }
    }

    // ---- Resume hooks ----------------------------------
    if (this._resume) {
      for (const hook of this._resumeHooks) {
        try {
          const out = hook.fn();
          if (out && typeof out.then === 'function') await out;
        } catch (e) {
          this._fireHandlerError(wrapErr(e,
            `capability '${hook.name}' onResume threw`));
        }
      }
    }

    // ---- Inbound message subscription ------------------
    // Defensive drain of anything already queued before the
    // subscription is established. resume() does the same — closes
    // the class of bug where a pre-start hook (capability setup,
    // embedder restore settlement) enqueues spawned contexts that
    // would otherwise sit parked until something else kicks the drain.
    this._drainPendingSpawned();

    // Subscribe to inbound messages. Wire's callback is
    // fire-and-forget: any Promise returned by the callback is
    // ignored, so wire delivers the next message as soon as it
    // arrives, regardless of whether prior onInboundMessage calls
    // have settled. That's the right shape — independent inbound
    // messages don't need consumer-side serialization at the wire
    // layer. If onInboundMessage's body needs serial ordering for
    // a particular concern, the embedder owns that.
    // Publish (not a raw cell write): a direct runtimeState.set
    // would desynchronize _publishState's dedupe bookkeeping, and a
    // later real publish of the same tracked value (bootOnly's
    // SCHEDULER_IDLE after start) would skip the cell write, leaving
    // the live cell stuck at INBOUND_LOOP for every reader.
    this._publishState(RUNTIME_STATE.INBOUND_LOOP);
    this._inboundUnsubscribe = this._inbound.onMessage((msg) => {
      this._publishState(RUNTIME_STATE.RUNNING);
      const { payload, sequenceNumber } = msg;
      // Fire and forget. onInboundMessage may be async; we don't
      // await — wire ignores our return value anyway. Errors
      // surface through the runtime's onHandlerError path inside
      // the embedder's onInboundMessage implementation.
      this.onInboundMessage(payload, sequenceNumber);
    });
  }

  /**
   * Send a payload via the outbound channel. The runtime
   * exposes this so capabilities and embedders share a
   * single send path with consistent error routing.
   *
   * Publishes RUNTIME_STATE.OUTBOUND_DRAIN to the runtime-state
   * cell while awaiting the channel's send() Promise — cross-
   * realm observers reading runtime.runtimeState see when the
   * worker is blocked on outbound capacity.
   */
  async send(payload) {
    this._publishState(RUNTIME_STATE.OUTBOUND_DRAIN);
    try {
      return await this._outbound.send(payload);
    } finally {
      this._publishState(RUNTIME_STATE.RUNNING);
    }
  }

  /**
   * Synchronous outbound send. Returns false if the channel
   * declined (typically a full ring); the embedder decides
   * how to back off.
   */
  trySend(payload) {
    return this._outbound.trySend(payload);
  }

  /**
   * Stop dispatching new work and wait for any currently
   * in-flight slot drives to return.
   *
   * "In flight" means a drive whose JS Promise has not yet
   * settled. A slot parked on `await` is NOT in-flight from
   * the runtime's perspective — its drive returned with
   * status 'await' and the Promise resolved. quiesce does
   * not wait for parked slots to unpark; the embedder is
   * responsible for that if it matters (e.g. before snapshot).
   *
   * While quiesced:
   *   - the inbound loop continues to deliver messages
   *     (onInboundMessage keeps firing)
   *   - scheduleClosureCall enqueues; the queue is drained
   *     on resume()
   *   - spawned slots queued by sandscript wait for resume
   *     to dispatch
   *   - outbound send / trySend continue to work
   */
  quiesce() {
    if (this._quiesced) {
      // Idempotent: a second quiesce just observes the
      // current state.
      if (this._inFlightDrives.size === 0) return Promise.resolve();
      return new Promise(resolve => this._quiesceWaiters.push(resolve));
    }
    this._quiesced = true;
    if (this._inFlightDrives.size === 0) {
      this._publishState(RUNTIME_STATE.QUIESCED);
      return Promise.resolve();
    }
    this._publishState(RUNTIME_STATE.DRAINING_ROOT_SLOTS);
    return new Promise(resolve => this._quiesceWaiters.push(resolve));
  }

  /**
   * Re-enable dispatch. Parked slots resume on their normal
   * signals; queued spawned slots dispatch.
   */
  resume() {
    if (!this._quiesced) return;
    this._quiesced = false;
    const deferredCancellations = [...this._deferredCancellations.entries()];
    this._deferredCancellations.clear();
    for (const [owner, reason] of deferredCancellations) {
      this._cancelInvoke(owner, reason);
    }
    this._publishState(this._driverStats.inFlight > 0
      ? RUNTIME_STATE.RUNNING
      : RUNTIME_STATE.SCHEDULER_IDLE);
    // Re-dispatch wakes that raced the quiesce tail through
    // _dispatchWoken (the dispatchChild path bypasses the airlock
    // queue). A slot never appears both here and in the airlock
    // queue — a park settles through exactly one wake channel — so
    // this cannot double-drive.
    const deferredWakes = [...this._deferredWakes.values()];
    this._deferredWakes.clear();
    for (const identity of deferredWakes) this._dispatchWoken(identity);
    this._drainPendingSpawned();
    const deferredInvokes = this._deferredInvokes;
    this._deferredInvokes = [];
    for (const owner of deferredInvokes) {
      if (!owner.terminal) this._beginInvoke(owner);
    }
    // Re-kick the closure drainer to flush calls scheduled
    // while quiesced.
    this._kickClosureDrainer();
  }

  /**
   * Propagate a memory relocation to engine + membrane.
   * Pure delegation. Caller is responsible for having
   * quiesced.
   */
  notifyMemoryRelocated(spec) {
    const {
      segmentBaseOffset,
      membraneByteOffset,
      membraneByteLength,
      newSegmentSize,
      newStringTableSize,
      newMembraneLayout,
    } = spec;

    if (segmentBaseOffset !== undefined || membraneByteOffset !== undefined) {
      this._session.relocate({
        segmentBaseOffset,
        membraneByteOffset,
        membraneByteLength,
      });
    }
    if (newSegmentSize !== undefined) {
      this._session.resizeSegment({
        newSegmentSize,
        newStringTableSize,
      });
    }
    if (newMembraneLayout !== undefined) {
      this._session.airlock.membrane.resizeRegions(newMembraneLayout);
    }

    // Rebind both diagnostic views to their (possibly moved)
    // regions. Relocation or region resize may have shifted
    // the cell and the ledger within the membrane SAB; the
    // views' typed-array bindings need to point at the new
    // bytes. The airlock holds its own reference to the
    // ledger via setLedger, so rebinding here updates that
    // reference transitively.
    const membrane = this._session.airlock.membrane;
    const buffer = membrane.buffer;
    const baseOffset = membrane.byteOffset;
    const runtimeStateOffset = membrane.view.getUint32(
      MEMBRANE_HEADER.RUNTIME_STATE_OFFSET, true);
    const ledgerOffset = membrane.view.getUint32(
      MEMBRANE_HEADER.LEDGER_OFFSET, true);
    this.runtimeState.rebind(buffer, baseOffset + runtimeStateOffset);
    this.ledger.rebind(buffer, baseOffset + ledgerOffset);
  }

  /**
   * Run a sandscript GC pass. Caller responsible for
   * serializing against the scheduler (typically via
   * quiesce()).
   */
  gc() {
    return this._session.gc();
  }

  /**
   * Compact the membrane's arenas. Caller responsible for
   * serialization.
   */
  compactMembrane() {
    return this._session.airlock.compactMembrane();
  }

  /**
   * Drive a root slot through ONE episode, up to and including
   * its next yield point.
   *
   * This is the public entry point for executing sandscript
   * drone code that the embedder has already parsed onto a
   * slot (typically slot 0 — the boot context). It dispatches
   * every status (async, await, suspended, memory_pressure,
   * etc.) within this episode and surfaces any
   * AttributedRejection through onHandlerError.
   *
   * The returned status is TERMINAL ('done'/'error'/'terminated')
   * only if the slot reaches one within this episode. A slot that
   * parks ('suspended'/'await') returns with that status instead —
   * same as fuel-exhausted/paused — because host-owned execution
   * returns control to the caller at every yield point rather than
   * looping through wakes internally. A caller that needs to observe
   * eventual completion across a park must wait/poll separately,
   * e.g. `runtime.getEngineState(slot).status === 'done'`; this single
   * awaited call does not do that.
   *
   * Embedders almost never call this from production code —
   * production drones receive work via inbound messages or
   * scheduled closures. Its primary use is at boot for the
   * one-shot "evaluate the top-level program" drive, and in
   * tests that exercise drone behavior end-to-end without
   * going through the channel loop.
   *
   * @param {number} [slot=0]
   * @returns {Promise<{ status: string, error?: any }>}
   */
  run(slot = 0) {
    if (!this._started) {
      throw new Error('Runtime.run: start() has not completed');
    }
    // Waiter-owned slots (a parked invokeClosure — e.g. a fuel
    // pause the embedder is re-driving after refueling) must route
    // through the invoke path so a terminal outcome settles the
    // caller's Promise and frees the slot. A raw drive here would
    // bypass the waiter, leaving the invokeClosure caller unsettled.
    // The caller of run() still gets the drive's status object either way.
    const waiter = this._invokeWaiters.get(slot);
    if (waiter) return this._continueInvoke(slot, waiter);
    return this._driveSlot(slot);
  }

  /**
   * Complete a slot's boot sequence (interpreter attached,
   * capabilities wired, membrane set up) WITHOUT dispatching a
   * single instruction of its top-level code — deliberately, not
   * as a side effect of running out of fuel.
   *
   * A `run(slot, { fuel: 0 })`-style drive still enters
   * `_driveLoop` and performs a real (if zero-instruction) drive
   * episode, so it collapses "boot finished" and "fuel exhausted"
   * into the same completion event. `bootOnly` is the alternative:
   * it reaches the same embedder-visible completion side effects
   * (state publish, scheduler-idle notification) as `_driveSlot`'s
   * own `.finally()`, but never calls `_driveLoop` and never touches
   * fuel accounting.
   *
   * @param {number} [slot=0]
   * @returns {Promise<{ status: string, error: null }>}
   */
  bootOnly(slot = 0) {
    if (!this._started) {
      throw new Error('Runtime.bootOnly: start() has not completed');
    }
    if (this._terminated) {
      return Promise.resolve({ status: 'terminated', error: null });
    }
    if (this._quiesced) {
      return Promise.resolve({ status: 'quiesced', error: null });
    }
    const ledgerEntry = this.ledger.claim({
      contextSlot: slot,
      activity: LEDGER_ACTIVITY.BOOTED_UNSTARTED,
      beganAtTick: performance.now() | 0,
    });
    this.ledger.free(ledgerEntry);  // free() is a no-op for -1
    this._publishState(RUNTIME_STATE.SCHEDULER_IDLE);
    this._fireSchedulerIdle();
    return Promise.resolve({ status: 'unstarted', error: null });
  }

  /**
   * Queue a registered closure for execution as a fresh slot.
   *
   * `opts.callerSlot` (optional) — the SS context slot that
   * scheduled this call. Surfaces on the DISPATCHING_CLOSURE
   * ledger entry as `contextSlot`. When omitted (e.g. a JS-side
   * timer fire with no associated slot), the ledger entry uses
   * the reserved max-u32 "no slot" sentinel.
   *
   * Per-call outcome hooks (all optional, all best-effort):
   * `opts.onMarshaled()` — delivery receipt: the args landed in the
   * vat; the closure owns the call from here. `opts.onMarshalError(err)`
   * — delivery FAILURE: the closure never received the args (marshal
   * refusal such as a string too long for vat scratch, slot exhaustion,
   * a freed/revoked closure, a closed delivery gate). `opts.onError(err)`
   * — the closure ran and ended in error (script error; the call WAS
   * delivered). Exactly one of onMarshaled/onMarshalError fires per
   * dispatched call; onError can only follow onMarshaled. Firers that
   * advance an ordered cursor (a box-subscription fold) advance on
   * onMarshaled and halt on onMarshalError — a script error is the
   * listener's own business.
   *
   * `opts.shouldDeliver()` (optional) — delivery gate, consulted at
   * dequeue: return false to drop the call as a delivery failure
   * (onMarshalError fires). Because the queue drains FIFO one call at
   * a time, a gate closed inside an earlier call's onMarshalError is
   * guaranteed to stop every call queued behind it — how an ordered
   * stream avoids executing records past a delivery hole.
   *
   * Calls scheduled while the runtime is quiesced are enqueued
   * but not dispatched until resume(); calls scheduled after
   * terminate() are dropped — no hook fires (the embedder is going
   * away with its whole dispatch state; recovery re-delivers).
   */
  scheduleClosureCall(closureHandle, args, opts = {}) {
    if (!this._started) {
      throw new Error('Runtime.scheduleClosureCall: start() has not completed');
    }
    if (this._terminated) return;

    // Claim a DISPATCHING_CLOSURE ledger entry on enqueue. The
    // entry survives until runClosureCall is ready to drive the
    // closure — at which point DRIVING_ROOT takes over. claim
    // returning -1 (table full) is handled transparently by
    // runClosureCall (free() is a no-op for -1).
    const closurePointer = this._session.airlock.getClosurePointer(closureHandle);
    let ledgerEntry = -1;
    if (closurePointer !== null) {
      ledgerEntry = this.ledger.claim({
        contextSlot: opts.callerSlot ?? NO_CALLER_SLOT,
        activity: LEDGER_ACTIVITY.DISPATCHING_CLOSURE,
        id1: closurePointer,
        beganAtTick: performance.now() | 0,
      });
    }
    this._closureQueue.push({ closureHandle, args, opts, ledgerEntry });
    if (this.onClosureDispatch) {
      this.onClosureDispatch({
        kind: 'enqueue',
        closurePointer,
        callerSlot: opts.callerSlot ?? null,
        correlationId: opts.traceCorrelationId ?? null,
      });
    }
    this._kickClosureDrainer();
  }

  /**
   * Collect the handle slots referenced by args of
   * every closure call currently enqueued (and not yet marshaled). These args
   * hold JS Handle objects whose membrane slots have no SS-heap reference yet;
   * the airlock's compaction unions these into the live set so a GC in the
   * queue window can't reap-and-reuse the slot under a still-pending arg.
   *
   * Duck-types a Handle as { slot:number, version:number } to avoid importing
   * membrane internals. Walks nested arrays/plain objects (callback args can be
   * structured, e.g. an http request object carrying handle fields).
   *
   * @returns {number[]} live (possibly duplicate) handle slots
   */
  _collectQueuedClosureArgHandleSlots() {
    const out = [];
    const seen = new Set();
    const visit = (v, depth) => {
      if (v === null || typeof v !== 'object' || depth > 8) return;
      if (seen.has(v)) return;
      seen.add(v);
      if (typeof v.slot === 'number' && typeof v.version === 'number') {
        out.push(v.slot);
        return; // a Handle is a leaf for this walk
      }
      if (Array.isArray(v)) {
        for (const e of v) visit(e, depth + 1);
        return;
      }
      for (const k of Object.keys(v)) visit(v[k], depth + 1);
    };
    for (const entry of this._closureQueue) {
      if (entry && entry.args) visit(entry.args, 0);
    }
    // The entry currently being driven: dequeued but possibly not yet marshaled
    // (a compaction during allocateContext, between dequeue and
    // setupCallbackContext's marshal, would otherwise reap its arg handles).
    if (this._drainingClosureCall && this._drainingClosureCall.args) {
      visit(this._drainingClosureCall.args, 0);
    }
    return out;
  }

  /**
   * Collect the MsgpackRef objects
   * referenced by args of every closure call currently enqueued (and not yet
   * marshaled). Their blobs live on the SS heap with NO SS-side reference
   * until the marshal writes the MSGPACK_REF value, so a heap gc in the
   * queue window must treat them as external roots — and forward each ref's
   * raw parentDataPointer when the blob moves (session.gc() does both via
   * airlock.hooks.inFlightMsgpackRefs).
   *
   * Duck-types a MsgpackRef via its Symbol.for tag, matching the Handle
   * duck-typing above. Same walk shape and depth bound.
   *
   * @returns {object[]} live (possibly duplicate) MsgpackRef objects
   */
  _collectQueuedClosureArgMsgpackRefs() {
    const MSGPACK_REF_TAG = Symbol.for('sandscript:msgpack-ref');
    const out = [];
    const seen = new Set();
    const visit = (v, depth) => {
      if (v === null || typeof v !== 'object' || depth > 8) return;
      if (seen.has(v)) return;
      seen.add(v);
      if (v[MSGPACK_REF_TAG] === true) {
        out.push(v);
        return;
      }
      if (Array.isArray(v)) {
        for (const e of v) visit(e, depth + 1);
        return;
      }
      for (const k of Object.keys(v)) visit(v[k], depth + 1);
    };
    for (const entry of this._closureQueue) {
      if (entry && entry.args) visit(entry.args, 0);
    }
    if (this._drainingClosureCall && this._drainingClosureCall.args) {
      visit(this._drainingClosureCall.args, 0);
    }
    return out;
  }

  /**
   * Invoke a registered SS closure and await its return value.
   *
   * Conceptually: like scheduleClosureCall, but returns a Promise
   * that resolves with the closure's return value (or rejects if
   * the closure throws or the slot terminates abnormally). The
   * closure runs on a fresh slot; the difference from
   * scheduleClosureCall is purely the return-value plumbing.
   *
   * Async closures (anything with `await` or `context.suspend`
   * inside) are supported transparently. The runtime owns the
   * wake-dispatch routing for the slot: when the slot parks and
   * later wakes via pendingSpawnedContexts, the runtime's
   * _drainPendingSpawned routes the wake back to this drive
   * (instead of fire-and-forget background-drive) so the terminal
   * status flows back to the Promise.
   *
   * @param {ClosureHandle} closureHandle
   * @param {Array} args - marshalled onto the closure's pending stack
   * @param {object} [opts]
   * @param {boolean} [opts.dropOnComplete=false]
   * @param {number} [opts.callerSlot]
   * @param {AbortSignal} [opts.signal]
   * @returns {Promise<any>}
   */
  invokeClosure(closureHandle, args, opts = {}) {
    if (!this._started) {
      return Promise.reject(
        new Error('Runtime.invokeClosure: start() has not completed'));
    }
    if (this._terminated) {
      return Promise.reject(
        new Error('Runtime.invokeClosure: runtime is terminated'));
    }
    const signal = opts.signal;
    if (signal !== undefined) this._validateAbortSignal(signal);
    if (signal?.aborted) return Promise.reject(signal.reason);

    return new Promise((resolve, reject) => {
      const owner = {
        closureHandle, args, opts, resolve, reject,
        slot: null, generation: null, abortListener: null, terminal: false,
      };
      if (signal) {
        owner.abortListener = () => this._cancelInvoke(owner, signal.reason);
        signal.addEventListener('abort', owner.abortListener, { once: true });
        if (signal.aborted) {
          this._cancelInvoke(owner, signal.reason);
          return;
        }
      }
      if (this._quiesced) {
        this._deferredInvokes.push(owner);
        return;
      }
      this._beginInvoke(owner);
    });
  }

  /**
   * Invoke one top-level exported function using an embedder-defined mapping
   * from a named argument record to the function's positional parameters.
   *
   * @param {string} exportName
   * @param {object} argumentRecord
   * @param {{parameterNames: string[], signal?: AbortSignal,
   *          hostInvocationContext?: any}} options -
   *   `hostInvocationContext` is an optional opaque host-only value
   *   associated with this invocation and exposed to capability
   *   handlers via `context.hostInvocationContext`. Never cloned,
   *   validated, serialized, or visible to SandScript source.
   * @returns {Promise<null|boolean|number|string|Array|object>}
   */
  async invokeExport(exportName, argumentRecord, options = {}) {
    if (typeof exportName !== 'string' || exportName.length === 0) {
      throw new TypeError('Runtime.invokeExport: exportName must be a non-empty string');
    }
    if (argumentRecord === null
        || typeof argumentRecord !== 'object'
        || Array.isArray(argumentRecord)
        || Object.getPrototypeOf(argumentRecord) !== Object.prototype) {
      throw new TypeError('Runtime.invokeExport: argumentRecord must be a plain object');
    }
    const parameterNames = options.parameterNames;
    if (!Array.isArray(parameterNames)
        || parameterNames.some((name) => typeof name !== 'string' || name.length === 0)
        || new Set(parameterNames).size !== parameterNames.length) {
      throw new TypeError(
        'Runtime.invokeExport: options.parameterNames must be an array of unique non-empty strings');
    }
    for (const parameterName of parameterNames) {
      if (!Object.hasOwn(argumentRecord, parameterName)) {
        throw new TypeError(
          `Runtime.invokeExport: argumentRecord is missing parameter '${parameterName}'`);
      }
    }
    validateJsonValue(argumentRecord, '$', TypeError, 'argument');
    const signal = options.signal;
    if (signal !== undefined) this._validateAbortSignal(signal);
    if (signal?.aborted) throw signal.reason;

    const closureHandle = this._session.registerExportClosure(exportName, {
      kind: TEMPORARY_EXPORT_HANDLE_METADATA_KIND,
    });
    try {
      return await this.invokeClosure(
        closureHandle,
        parameterNames.map((parameterName) => argumentRecord[parameterName]),
        {
          dropOnComplete: true,
          signal,
          // Internal delegation only: the public invokeClosure options
          // are not extended, and the value rides the invocation owner
          // untouched.
          hostInvocationContext: options.hostInvocationContext,
          validateResult: (value) => {
            validateJsonValue(value, '$', ResultMarshallingError, 'result');
          },
        },
      );
    } catch (error) {
      if (this._session.airlock.getClosurePointer(closureHandle) !== null) {
        this._session.airlock.dropClosureHandle(closureHandle);
      }
      throw error;
    }
  }

  /**
   * Construct a SandScript class (or plain function) with ordinary,
   * host-initiated `new` semantics. Allocates the receiver with the
   * closure's `.prototype`, sets `new.target` to the closure, runs
   * fields and body in the existing order, preserves constructor
   * return-object rules, and performs the completion (or abort) duty
   * for an external-backed receiver. Resolves with the interned
   * ObjectHandle of the final object; the caller owns its release.
   *
   * Accepts the invokeClosure option surface plus
   * `hostInvocationContext` (visible to airlock handlers reached by
   * this invocation and nowhere else).
   *
   * @param {ClosureHandle} closureHandle
   * @param {Array} argumentsList
   * @param {object} [options]
   * @returns {Promise<ObjectHandle>}
   */
  constructClosure(closureHandle, argumentsList = [], options = {}) {
    return this.invokeClosure(closureHandle, argumentsList, {
      ...options,
      construct: true,
    });
  }

  /**
   * Invoke a captured callback with an explicit receiver.
   * `receiverHandle` is an ObjectHandle (the callback runs with the
   * referenced vat object as `this`) or a same-session external Handle
   * (the callback runs with the external value as `this` — event
   * callbacks whose current target is a host value). The closure's
   * captured grants and the receiver's authority are checked BEFORE a
   * context is allocated.
   *
   * @param {ClosureHandle} closureHandle
   * @param {ObjectHandle|Handle} receiverHandle
   * @param {Array} argumentsList
   * @param {object} [options]
   * @returns {Promise<any>}
   */
  invokeClosureWithReceiver(closureHandle, receiverHandle, argumentsList = [], options = {}) {
    const airlock = this._session.airlock;
    const membrane = airlock.membrane;
    let receiver;
    if (isObjectHandle(receiverHandle)) {
      if (receiverHandle.membrane !== membrane) {
        return Promise.reject(new TypeError(
          'invokeClosureWithReceiver: receiver belongs to another session'));
      }
      if (membrane._readObjectHandleVersion(receiverHandle.slot) !== receiverHandle.version
          || airlock.getObjectPointer(receiverHandle) === null) {
        return Promise.reject(new TypeError(
          'invokeClosureWithReceiver: receiver handle has been released'));
      }
      if (!airlock.areObjectGrantsActive(receiverHandle)) {
        return Promise.reject(new TypeError(
          'invokeClosureWithReceiver: receiver has revoked grants'));
      }
      receiver = () => ({
        type: TYPE.OBJECT,
        lo: airlock.getObjectPointer(receiverHandle),
      });
    } else if (isHandle(receiverHandle)) {
      // A plain Handle carries no membrane back-reference; the F1
      // version check below is the same-session gate — a foreign or
      // reaped slot cannot match this membrane's current version.
      if (membrane._readHandleVersion(receiverHandle.slot) !== receiverHandle.version) {
        return Promise.reject(new TypeError(
          'invokeClosureWithReceiver: receiver handle is stale'));
      }
      const authority = new Set([
        ...closureHandle.capturedGrantSlots,
        ...membrane.rootGrantSlots(),
      ]);
      if (!membrane.checkBySlot(receiverHandle.slot, authority)) {
        return Promise.reject(new TypeError(
          'invokeClosureWithReceiver: receiver requires a grant the callback did not capture'));
      }
      receiver = () => ({
        type: TYPE.EXTERNAL,
        lo: receiverHandle.slot,
        hi: receiverHandle.version,
      });
    } else {
      return Promise.reject(new TypeError(
        'invokeClosureWithReceiver: receiver must be an ObjectHandle or a Handle'));
    }
    return this.invokeClosure(closureHandle, argumentsList, {
      ...options,
      receiver,
    });
  }

  /**
   * Read a static value or accessor from a captured class constructor.
   * A data function becomes a ClosureHandle, a data object an ObjectHandle,
   * and a primitive or structured value marshals normally. A static
   * accessor runs with the class as receiver.
   *
   * `options.resultConversion: "iterable-string-sequence"` consumes an
   * iterable result in the same invocation context and returns a
   * copied string array (`undefined` stays `undefined`).
   */
  async getClosureProperty(closureHandle, propertyName, options = {}) {
    if (typeof propertyName !== 'string' || propertyName.length === 0) {
      throw new TypeError('getClosureProperty: propertyName must be a non-empty string');
    }
    const airlock = this._session.airlock;
    const closurePointer = airlock.getClosurePointer(closureHandle);
    if (closurePointer === null) {
      throw new TypeError('getClosureProperty: closure handle has been freed');
    }
    if (!airlock.areClosureGrantsActive(closureHandle)) {
      throw new TypeError('getClosureProperty: closure has revoked grants');
    }
    const mem = this._session.memoryImage;
    const nameOffset = mem.internString(propertyName);
    const prop = mem.objectFindOwnProperty(closurePointer, nameOffset);
    const value = await this._resolvePropertyValue(
      prop, closureHandle, () => ({
        type: TYPE.FUNCTION,
        lo: airlock.getClosurePointer(closureHandle),
      }), options);
    if (options.resultConversion === 'iterable-string-sequence') {
      return this._convertIterableStringSequence(value, closureHandle, options);
    }
    return value;
  }

  /**
   * Read a property from a retained vat object, including prototype
   * objects and callback closures. Walks the SandScript prototype chain.
   * Accessors run with the object as receiver. Result conversion rules
   * match getClosureProperty.
   */
  async getObjectProperty(objectHandle, propertyName, options = {}) {
    if (typeof propertyName !== 'string' || propertyName.length === 0) {
      throw new TypeError('getObjectProperty: propertyName must be a non-empty string');
    }
    const airlock = this._session.airlock;
    if (!isObjectHandle(objectHandle)
        || objectHandle.membrane !== airlock.membrane) {
      throw new TypeError('getObjectProperty: expected a same-session ObjectHandle');
    }
    const pointer = airlock.getObjectPointer(objectHandle);
    if (pointer === null
        || airlock.membrane._readObjectHandleVersion(objectHandle.slot) !== objectHandle.version) {
      throw new TypeError('getObjectProperty: object handle has been released');
    }
    if (!airlock.areObjectGrantsActive(objectHandle)) {
      throw new TypeError('getObjectProperty: object has revoked grants');
    }
    const mem = this._session.memoryImage;
    const nameOffset = mem.internString(propertyName);
    let holder = pointer;
    let prop = null;
    while (holder !== 0) {
      prop = mem.objectFindOwnProperty(holder, nameOffset);
      if (prop) break;
      holder = mem.getObjectPrototype(holder);
    }
    const value = await this._resolvePropertyValue(
      prop, objectHandle, () => ({
        type: TYPE.OBJECT,
        lo: airlock.getObjectPointer(objectHandle),
      }), options);
    if (options.resultConversion === 'iterable-string-sequence') {
      return this._convertIterableStringSequence(value, objectHandle, options);
    }
    return value;
  }

  /** Drop one host-retained closure reference. */
  releaseClosureHandle(closureHandle) {
    const airlock = this._session.airlock;
    if (closureHandle?.membrane !== airlock.membrane) {
      throw new TypeError('releaseClosureHandle: handle belongs to another session');
    }
    if (airlock.membrane._readClosureHandleVersion(closureHandle.slot)
        !== closureHandle.version) {
      throw new TypeError('releaseClosureHandle: handle has already been released');
    }
    airlock.dropClosureHandle(closureHandle);
  }

  /** Drop one host-retained object reference. */
  releaseObjectHandle(objectHandle) {
    const airlock = this._session.airlock;
    if (objectHandle?.membrane !== airlock.membrane) {
      throw new TypeError('releaseObjectHandle: handle belongs to another session');
    }
    return airlock.releaseObjectHandle(objectHandle);
  }

  /**
   * Shared tail of getClosureProperty / getObjectProperty: resolve one
   * found property entry to a host value. `grantSource` supplies the
   * captured grant slots for handle minting; `receiver` is the thunk
   * bound as `this` when the entry is an accessor.
   */
  async _resolvePropertyValue(prop, grantSource, receiver, options) {
    const airlock = this._session.airlock;
    if (!prop) return undefined;
    if (prop.type === TYPE.ACCESSOR) {
      // Getter half = data_lo; a missing getter reads as undefined.
      if (prop.lo === 0) return undefined;
      const getterHandle = airlock.registerClosureWithGrants(
        prop.lo, grantSource.capturedGrantSlots);
      try {
        return await this.invokeClosure(getterHandle, [], {
          signal: options.signal,
          hostInvocationContext: options.hostInvocationContext,
          receiver,
          propertyResult: true,
        });
      } finally {
        if (airlock.getClosurePointer(getterHandle) !== null) {
          airlock.dropClosureHandle(getterHandle);
        }
      }
    }
    return this._readPropertyRaw(prop, grantSource.capturedGrantSlots);
  }

  /**
   * Convert one raw property entry {type, flags, lo, hi} to a host
   * value: function → ClosureHandle, object → ObjectHandle, external →
   * Handle, everything else → normal marshalling.
   */
  _readPropertyRaw(prop, capturedGrantSlots) {
    const airlock = this._session.airlock;
    const mem = this._session.memoryImage;
    if (prop.type === TYPE.FUNCTION) {
      return airlock.registerClosureWithGrants(prop.lo, capturedGrantSlots);
    }
    if (prop.type === TYPE.OBJECT) {
      return airlock.retainObjectWithGrants(prop.lo, capturedGrantSlots);
    }
    const scratch = mem.getScratchBase();
    const absolute = mem.abs(scratch);
    mem.view.setUint32(absolute, prop.type, true);
    mem.view.setUint32(absolute + 4, prop.flags ?? 0, true);
    mem.view.setUint32(absolute + 8, prop.lo, true);
    mem.view.setUint32(absolute + 12, prop.hi ?? 0, true);
    return mem.readValueAt(scratch, {
      unmarshal: (type, dataLo) => {
        if (type === TYPE.EXTERNAL) {
          return airlock.membrane.handleForSlot(dataLo);
        }
        if (type === TYPE.FUNCTION) {
          return airlock.registerClosureWithGrants(dataLo, capturedGrantSlots);
        }
        return undefined;
      },
    });
  }

  /**
   * With `resultConversion: "iterable-string-sequence"`, an undefined
   * result stays undefined; a copied array applies JavaScript string
   * conversion per item; another object must carry a SandScript
   * iterator, which is consumed by driven invocations in the same
   * conversation. Getter, iterator, and conversion failures propagate.
   */
  async _convertIterableStringSequence(value, grantSource, options) {
    if (value === undefined) return undefined;
    if (Array.isArray(value)) {
      return value.map((item) => String(item));
    }
    const airlock = this._session.airlock;
    const mem = this._session.memoryImage;
    if (!isObjectHandle(value)) {
      throw new TypeError(
        'iterable-string-sequence: result is not an object with an iterator');
    }
    let releasableIterable = value;
    try {
      const pointer = airlock.getObjectPointer(value);
      const iteratorSymbol = mem.view.getUint32(
        mem.abs(STATE.WELL_KNOWN_ITERATOR_SYMBOL), true);
      // Walk the chain for the Symbol.iterator entry.
      let holder = pointer;
      let factory = null;
      while (holder !== 0) {
        factory = mem.objectGetSymbolKey(holder, iteratorSymbol);
        if (factory) break;
        holder = mem.getObjectPrototype(holder);
      }
      if (!factory || factory.type !== TYPE.FUNCTION) {
        throw new TypeError(
          'iterable-string-sequence: result is not an object with an iterator');
      }
      const grants = grantSource.capturedGrantSlots;
      const factoryHandle = airlock.registerClosureWithGrants(factory.dataLo, grants);
      let iterator;
      try {
        iterator = await this.invokeClosure(factoryHandle, [], {
          signal: options.signal,
          receiver: () => ({ type: TYPE.OBJECT, lo: airlock.getObjectPointer(value) }),
          propertyResult: true,
        });
      } finally {
        if (airlock.getClosurePointer(factoryHandle) !== null) {
          airlock.dropClosureHandle(factoryHandle);
        }
      }
      if (!isObjectHandle(iterator)) {
        throw new TypeError('iterable-string-sequence: iterator is not an object');
      }
      const out = [];
      try {
        const next = await this.getObjectProperty(iterator, 'next', {
          signal: options.signal,
        });
        if (!isClosureHandle(next)) {
          throw new TypeError('iterable-string-sequence: iterator has no next method');
        }
        try {
          for (;;) {
            const step = await this.invokeClosureWithReceiver(
              next, iterator, [], { signal: options.signal });
            if (step === null || typeof step !== 'object') {
              throw new TypeError('iterable-string-sequence: iterator step is not an object');
            }
            if (step.done) break;
            out.push(String(step.value));
          }
        } finally {
          if (airlock.getClosurePointer(next) !== null) {
            airlock.dropClosureHandle(next);
          }
        }
      } finally {
        airlock.releaseObjectHandle(iterator);
      }
      return out;
    } finally {
      airlock.releaseObjectHandle(releasableIterable);
    }
  }

  _validateAbortSignal(signal) {
    if (signal === null
        || typeof signal !== 'object'
        || typeof signal.aborted !== 'boolean'
        || typeof signal.addEventListener !== 'function'
        || typeof signal.removeEventListener !== 'function') {
      throw new TypeError(
        'Runtime invocation signal must be an AbortSignal-compatible object');
    }
  }

  _beginInvoke(owner) {
    const { closureHandle, args } = owner;
    if (owner.terminal) return;
    if (this._terminated) {
      this._transitionInvoke(owner, {
        error: new Error('Runtime.invokeClosure: runtime is terminated'),
      });
      return;
    }
    if (this._session.airlock.getClosurePointer(closureHandle) === null) {
      this._transitionInvoke(owner, {
        error: new Error('Runtime.invokeClosure: closure handle has been freed'),
      });
      return;
    }
    if (!this._session.airlock.areClosureGrantsActive(closureHandle)) {
      this._transitionInvoke(owner, {
        error: new Error('Runtime.invokeClosure: closure has revoked grants'),
      });
      return;
    }

    try {
      owner.slot = this._session.airlock.allocateContext();
      owner.generation =
        this._session.memoryImage.getContextGeneration(owner.slot);
      this._session.memoryImage.markContextInvocationRoot(owner.slot);
      if (owner.opts.construct) {
        owner.receiverHandle = this._session.airlock.setupConstructContext(
          owner.slot, closureHandle, args);
      } else {
        this._session.airlock.setupCallbackContext(
          owner.slot, closureHandle, args, true, owner.opts.receiver ?? null);
      }
    } catch (error) {
      if (owner.slot !== null
          && this._session.memoryImage.isContextIdentityLive(
            owner.slot, owner.generation)) {
        this._session.airlock.freeContext(owner.slot, owner.generation);
      }
      owner.slot = null;
      owner.generation = null;
      this._transitionInvoke(owner, { error });
      return;
    }

    this._invokeWaiters.set(owner.slot, owner);
    this._driveSlot(owner.slot)
      .then((result) => {
        if (!owner.terminal) {
          this._settleInvokeIfTerminal(owner.slot, owner, result);
        }
      })
      .catch((error) => {
        this._transitionInvoke(owner, { error });
      });
  }

  _cancelInvoke(owner, reason) {
    if (owner.terminal || this._deferredCancellations.has(owner)) return;
    if (owner.slot === null) {
      const index = this._deferredInvokes.indexOf(owner);
      if (index !== -1) this._deferredInvokes.splice(index, 1);
    } else if (this._quiesced) {
      this._deferredCancellations.set(owner, reason);
      return;
    } else {
      this._session.airlock.cancelContext(owner.slot, owner.generation);
      this._deferredWakes.delete(owner.slot);
    }
    this._transitionInvoke(owner, {
      error: reason,
      rejectResult: true,
      contextAlreadyFreed: true,
    });
  }

  // Dequeue and drive exactly ONE _closureQueue entry through
  // runClosureCall. Shared by _kickClosureDrainer's auto-loop and the
  // test-only _drainOneClosureCallForTest hook, which permits an exact
  // interleaving by returning after one entry rather than draining the
  // queue to completion.
  //
  // Caller's responsibility: check _closureQueue.length > 0 first. Errors
  // from runClosureCall are reported via onHandlerError, matching the
  // auto-loop's behavior, rather than rejecting this call.
  async _driveOneQueuedClosureCall() {
    try {
      // Hold the entry being driven in
      // _drainingClosureCall so its arg handles stay compaction roots
      // across the gap between dequeue and setupCallbackContext's marshal
      // (allocateContext in that gap can trigger a compaction). Cleared in
      // runClosureCall's finally (passed as onArgsMarshaled), or below.
      const _entry = this._closureQueue.shift();
      this._drainingClosureCall = _entry;
      await runClosureCall(_entry, {
        onArgsMarshaled: () => { this._drainingClosureCall = null; },
        airlock:          this._session.airlock,
        driveSlot:        (slot, lifecycle) => this._driveSlot(slot, lifecycle),
        backpressure:     () => {
          const fn = this.extraSchedulerBackpressure;
          return fn ? fn() : undefined;
        },
        ledger:           this.ledger,
        isTerminated:     () => this._terminated,
        onClosureDispatch: this.onClosureDispatch,
        deferParkedCleanup: (identity, cleanup, opts) =>
          this._parkedSlotCleanups.set(
            identity.slot, { generation: identity.generation, cleanup, opts }),
      });
    } catch (err) {
      // An UncaughtScriptError was already surfaced by driveLoop's own
      // throw arm — with real slot attribution and the uncaught flag.
      // Re-firing here would report the same drone error twice (and
      // with the worse NO_CALLER_SLOT attribution). Everything else —
      // marshal failures, revoked-handle refusals, runtime bugs in
      // runClosureCall itself — still surfaces here.
      if (!(err instanceof UncaughtScriptError)) {
        this._fireHandlerError(wrapAsAttributedRejection(
          NO_CALLER_SLOT, err));
      }
    } finally {
      // At worst a one-call over-pin if the entry parked without ever
      // reaching onArgsMarshaled (harmless — see _kickClosureDrainer).
      this._drainingClosureCall = null;
    }
  }

  // Start the closure drainer if it isn't already running and
  // the runtime isn't quiesced. The drainer's loop also exits
  // when _quiesced flips on mid-drain; resume() re-kicks here.
  _kickClosureDrainer() {
    if (this._closureDraining) return;
    if (this._quiesced || this._terminated) return;
    if (this._closureQueue.length === 0) return;
    this._closureDraining = true;
    (async () => {
      while (this._closureQueue.length > 0
          && !this._terminated
          && !this._quiesced) {
        await this._driveOneQueuedClosureCall();
      }
      this._closureDraining = false;
    })();
  }

  /**
   * TEST-ONLY single-step closure drainer. Dequeues and drives exactly
   * ONE _closureQueue entry, then returns control — unlike
   * _kickClosureDrainer, which drains the whole queue to completion
   * once kicked.
   *
   * Must not be called concurrently with the auto-drainer: throws if
   * _kickClosureDrainer's loop is currently running (_closureDraining),
   * since both mutate _closureQueue/_drainingClosureCall and interleaving
   * them would race. A test that wants single-step control should drive
   * the WHOLE sequence through this method (never call scheduleClosureCall
   * expecting the auto-drainer to also run) — scheduleClosureCall itself
   * still calls _kickClosureDrainer, so this only stays single-stepped as
   * long as the auto-loop finds _closureQueue empty or the runtime
   * quiesced each time it would kick.
   *
   * @returns {boolean} true if an entry was drained, false if the queue
   *   was empty (nothing to do).
   */
  async _drainOneClosureCallForTest() {
    if (this._closureDraining) {
      throw new Error(
        '_drainOneClosureCallForTest: the auto-drainer (_kickClosureDrainer) ' +
        'is already running — single-stepping while it drains concurrently ' +
        'would race on _closureQueue/_drainingClosureCall. Quiesce the ' +
        'runtime or avoid scheduleClosureCall calls that auto-kick before ' +
        'using this method.');
    }
    if (this._closureQueue.length === 0) return false;
    await this._driveOneQueuedClosureCall();
    return true;
  }

  /**
   * Tear down. Fires every capability's onDroneTerminated,
   * stops the scheduler, stops the inbound loop. After
   * `terminate()`, the runtime is unusable.
   */
  async terminate() {
    if (this._terminated) return;
    this._terminated = true;

    // Settle every promise-owning surface that would otherwise
    // dangle: parked invokeClosure waiters (their wake channel is
    // dead — _drainPendingSpawned no-ops once terminated) and
    // invokes deferred by a quiesce window. In-FLIGHT drives don't
    // need this — they observe _terminated and resolve with the
    // 'terminated' sentinel, which _settleInvokeIfTerminal rejects.
    const terminatedError = () =>
      new Error('Runtime.invokeClosure: runtime is terminated');
    for (const owner of [...this._invokeWaiters.values()]) {
      this._transitionInvoke(owner, {
        error: terminatedError(),
        contextAlreadyFreed: true,
      });
    }
    const deferredInvokes = this._deferredInvokes;
    this._deferredInvokes = [];
    for (const owner of deferredInvokes) {
      this._transitionInvoke(owner, { error: terminatedError() });
    }
    this._deferredCancellations.clear();
    this._deferredWakes.clear();

    // Stop receiving inbound messages. Wire's unsubscribe is
    // best-effort — a message that's already mid-delivery may
    // still fire one more callback before the loop notices the
    // teardown flag. _terminated is already set above, so any
    // such late onInboundMessage call observes the terminated
    // state and short-circuits.
    if (this._inboundUnsubscribe) {
      this._inboundUnsubscribe();
      this._inboundUnsubscribe = null;
    }
    // _terminated is already set above; in-flight drives observe
    // it on their next loop iteration and exit. New _driveSlot
    // calls return a 'terminated' sentinel.

    // Fire termination hooks in reverse setup order (LIFO),
    // mirroring constructor/destructor convention.
    for (let i = this._terminationHooks.length - 1; i >= 0; i--) {
      const hook = this._terminationHooks[i];
      try {
        const out = hook.fn();
        if (out && typeof out.then === 'function') await out;
      } catch (e) {
        // Termination errors don't propagate; embedders that
        // need to know wire them through onHandlerError before
        // termination.
        this._fireHandlerError(wrapErr(e,
          `capability '${hook.name}' onDroneTerminated threw`));
      }
    }
  }

  // --------------------------------------------------------
  // Stats surface (curated, read-only)
  // --------------------------------------------------------

  getSchedulerStats() {
    return {
      inFlight:    this._driverStats.inFlight,
      parked:      this._session.airlock?.pendingSpawnedContexts?.length ?? 0,
      spawnedRuns: this._driverStats.spawnedRuns,
      errors:      this._driverStats.errors,
      state:       this.runtimeState.get(),
      closureQueueDepth: this._closureQueue.length,
      closureDraining: this._closureDraining,
      drivingSlots: [...this._drivingSlotIdentities.entries()]
        .map(([slot, generation]) => ({ slot, generation })),
      deferredWakes: [...this._deferredWakes.values()]
        .map(({ slot, generation }) => ({ slot, generation })),
      parkedCleanupSlots: [...this._parkedSlotCleanups.keys()],
    };
  }

  getEngineState(slot = 0) {
    return this._session.state(slot);
  }

  getMembraneStats() {
    return this._session.airlock.membraneStats();
  }

  getOperationTick() {
    return this._session.airlock.membrane.tick();
  }

  captureSlotDiagnostic(slot) {
    return this._session.airlock.captureSlotDiagnostic(slot);
  }

  captureMembraneDiagnostic(opts = {}) {
    return this._session.airlock.membrane.captureDiagnostic(opts);
  }

  // --------------------------------------------------------
  // Internal
  // --------------------------------------------------------

  _validateConstructorOpts(opts) {
    if (!opts || typeof opts !== 'object') {
      throw new RuntimeBootError('Runtime constructor requires an options object',
        { phase: 'validate' });
    }
    const required = ['session', 'inboundChannel', 'outboundChannel',
                      'capabilities', 'hostServices', 'subsystems'];
    for (const key of required) {
      if (opts[key] === undefined || opts[key] === null) {
        throw new RuntimeBootError(
          `Runtime constructor missing required option '${key}'`,
          { phase: 'validate' });
      }
    }
    if (typeof this._channelLike(opts.inboundChannel, 'inbound') === 'string') {
      throw new RuntimeBootError(
        this._channelLike(opts.inboundChannel, 'inbound'),
        { phase: 'validate' });
    }
    if (typeof this._channelLike(opts.outboundChannel, 'outbound') === 'string') {
      throw new RuntimeBootError(
        this._channelLike(opts.outboundChannel, 'outbound'),
        { phase: 'validate' });
    }
    if (opts.onSchedulerIdle !== undefined
        && opts.onSchedulerIdle !== null
        && typeof opts.onSchedulerIdle !== 'function') {
      throw new RuntimeBootError(
        "Runtime constructor option 'onSchedulerIdle' must be a function, null, or undefined",
        { phase: 'validate' });
    }
  }

  _channelLike(channel, role) {
    if (!channel || typeof channel !== 'object') {
      return `${role}Channel must be an object`;
    }
    if (role === 'inbound') {
      if (typeof channel.onMessage !== 'function') {
        return 'inboundChannel.onMessage must be a function';
      }
    } else {
      if (typeof channel.send !== 'function') {
        return 'outboundChannel.send must be a function';
      }
      if (typeof channel.trySend !== 'function') {
        return 'outboundChannel.trySend must be a function';
      }
    }
    return null;
  }

  /**
   * Build the resolvedContext object for a capability's
   * setup call: each declared need resolved to its value.
   */
  _buildResolvedContext(cap) {
    const needs = cap.needs ?? {};
    const resolved = {};
    for (const [needKey, needSpec] of Object.entries(needs)) {
      const { kind, name } = normalizeNeedSpec(needKey, needSpec);
      if (kind === 'host-service') {
        resolved[needKey] = this._hostServices[name];
      } else if (kind === 'subsystem') {
        resolved[needKey] = this._subsystems[name];
      } else if (kind === 'capability') {
        const depReturn = this._capabilityReturns.get(name);
        // If the dependency exports `.exports`, use that;
        // otherwise the whole return value.
        resolved[needKey] = (depReturn && 'exports' in depReturn)
          ? depReturn.exports
          : depReturn;
      }
    }
    return resolved;
  }

  // --------------------------------------------------------
  // Slot driver — internal
  // --------------------------------------------------------

  /**
   * Drive a single slot to terminal or first park. Adds lifecycle bookkeeping
   * around _driveLoop and serializes wakes against the drive that created the
   * park. `lifecycle.onParked` publishes caller-specific ownership before a
   * wake that arrived during the drive may re-enter the slot.
   */
  _driveSlot(slot, lifecycle = {}) {
    if (this._terminated) {
      return Promise.resolve({ status: 'terminated', error: null });
    }
    const generation = this._session.memoryImage.getContextGeneration(slot);
    if (this._quiesced) {
      const result = { status: 'quiesced', error: null };
      lifecycle.onParked?.(result);
      this._deferredWakes.set(slot, { slot, generation });
      return Promise.resolve(result);
    }
    const activeGeneration = this._drivingSlotIdentities.get(slot);
    if (activeGeneration !== undefined) {
      throw new Error(
        `Runtime._driveSlot: slot ${slot} generation ${generation} is already ` +
        `driving as generation ${activeGeneration}`);
    }
    this._drivingSlotIdentities.set(slot, generation);
    this._driverStats.inFlight++;
    this._driverStats.spawnedRuns++;
    this._publishState(RUNTIME_STATE.RUNNING);

    const ledgerEntry = this.ledger.claim({
      contextSlot: slot,
      activity: LEDGER_ACTIVITY.DRIVING_ROOT,
      beganAtTick: performance.now() | 0,
    });
    if (ledgerEntry === -1) {
      const error = new Error(
        `runtime ledger diagnostic table is at capacity (${this.ledger.capacity}) — ` +
        `DRIVING_ROOT for slot ${slot} was not recorded. This is an observability ` +
        `signal, NOT an error: the drive proceeds unaffected and no work is lost. ` +
        `It is expected under enough legitimately concurrent activity (many slots ` +
        `becoming drivable in the same tick). If it fires under normal load rather ` +
        `than a burst, walk runtime.ledger.walk() and check beganAtTick for entries ` +
        `that are unexpectedly old — that would indicate activities aren't being ` +
        `freed promptly, rather than simple capacity pressure.`);
      error.name = 'LedgerSaturatedError';
      error.isDiagnosticSignal = true;
      this._fireHandlerError(wrapAsAttributedRejection(slot, error));
    }

    let driveResult = null;
    const promise = this._driveLoop(slot)
      .catch((error) => {
        if (error instanceof UncaughtScriptError) throw error;
        this._fireHandlerError(wrapAsAttributedRejection(slot, error));
        return { status: 'error', error };
      })
      .then((result) => {
        driveResult = result;
        if (!isTerminalDriveStatus(result?.status)) {
          lifecycle.onParked?.(result);
        }
        return result;
      })
      .finally(() => {
        this.ledger.free(ledgerEntry);
        if (this._drivingSlotIdentities.get(slot) === generation) {
          this._drivingSlotIdentities.delete(slot);
        }
        const deferredWake = this._deferredWakes.get(slot);
        if (deferredWake?.generation === generation) {
          this._deferredWakes.delete(slot);
          if (isTerminalDriveStatus(driveResult?.status)) {
            this.onSlotLifecycle?.({
              kind: 'terminal-wake-dropped',
              slot,
              generation,
            });
          } else {
            this._dispatchWoken(deferredWake);
          }
        }
        this._driverStats.inFlight--;
        this._inFlightDrives.delete(promise);
        if (this._driverStats.inFlight === 0) {
          this._drainUnhandledRejections();
          const nextState = this._quiesced
            ? RUNTIME_STATE.QUIESCED
            : RUNTIME_STATE.SCHEDULER_IDLE;
          this._publishState(nextState);
          if (nextState === RUNTIME_STATE.SCHEDULER_IDLE) {
            this._fireSchedulerIdle();
          }
        }
        if (this._quiesced && this._inFlightDrives.size === 0) {
          const waiters = this._quiesceWaiters;
          this._quiesceWaiters = [];
          for (const waiter of waiters) waiter();
        }
      });
    this._inFlightDrives.add(promise);
    return promise;
  }

  /**
   * Drain the airlock's unhandled-rejection watchlist.
   *
   * When an async function's promise rejects and nobody is
   * currently awaiting or .then/.catch-ing it, the airlock adds
   * the promise to a watchlist instead of declaring it unhandled
   * immediately — a parent slot might be about to `await` the
   * promise a few instructions later. If the parent does
   * `await` and catches the rejection, `handleAwait` removes
   * the entry from the watchlist.
   *
   * This method runs when the runtime goes idle (all in-flight
   * drives complete, `inFlight === 0`). Anything still on the
   * watchlist at that point is truly unhandled — no slot will
   * ever consume it. Each entry is surfaced as an
   * UncaughtScriptError via onHandlerError.
   */
  _drainUnhandledRejections() {
    const pending = this._session.airlock._state.pendingUnhandledRejections;
    if (pending.size === 0) return;
    for (const [, entry] of pending) {
      const message = typeof entry.value === 'string'
        ? entry.value
        : (entry.value?.message ?? 'unhandled async rejection');
      const scriptError = {
        code: -1,
        codeName: 'UNHANDLED_ASYNC_REJECTION',
        message,
        failPc: null,
      };
      const err = new UncaughtScriptError(entry.slot, scriptError);
      this._fireHandlerError(
        wrapAsAttributedRejection(entry.slot, err), { uncaught: true });
    }
    pending.clear();
  }

  /**
   * Bound wrapper around `driveLoop` — supplies the runtime's
   * dependencies (session, fuel) and side-effect callbacks (drain
   * spawned, dispatch background, surface error, publish state,
   * bump errors counter, observe terminated).
   */
  _driveLoop(slot) {
    return driveLoop(slot, {
      session:          this._session,
      fuel:             this._fuel,
      onFuelExhausted:  this.onFuelExhausted,
      onSlotLifecycle:  this.onSlotLifecycle,
      onGarbageCollect: this.onGarbageCollect,
      isTerminated:     () => this._terminated,
      drainSpawned:     () => this._drainPendingSpawned(),
      dispatchChild:    (s) => this._dispatchWoken(s),
      surfaceError:     (rej, opts) => this._fireHandlerError(rej, opts),
      publishState:     (v) => this._publishState(v),
      bumpErrors:       () => { this._driverStats.errors++; },
      // Append a kind:FUEL entry to the membrane cost ledger at each
      // drive-episode boundary.
      recordFuelCost:   (slot, consumed) =>
        this._session.airlock.membrane.appendCostEntry(COST_KIND.FUEL, slot, { fuel: consumed }),
    });
  }

  /**
   * Drain the airlock's spawn queue and dispatch each woken slot.
   * No-op while quiesced or terminated.
   */
  _drainPendingSpawned() {
    if (this._quiesced || this._terminated) return;
    const identities =
      this._session.airlock.drainPendingSpawnedContextIdentities();
    for (const identity of identities) this._dispatchWoken(identity);
  }

  /**
   * Route a woken slot to the right continuation. Shared by
   * `_drainPendingSpawned` (the `pendingSpawnedContexts` queue) and
   * `driveLoop`'s `dispatchChild` (waiters returned directly by
   * `handleAsyncComplete` / `handleAsyncRejected` / `processHandlers`,
   * which bypass that queue) — both are wake points for a slot that
   * previously parked, so both must apply the same ownership check.
   *
   * Routing: slots registered in `_invokeWaiters` (parked
   * invokeClosure calls awaiting wake) take the invoke-drive path,
   * which extracts the return value on terminal and settles the
   * caller's Promise. Slots in `_rootSlots` (slot 0, the persistent
   * top-level context) take the root-drive path, which never frees
   * the slot. All other slots take the background-drive path
   * (fire-and-forget, freed on terminal).
   */
  _dispatchWoken(identity) {
    if (identity === null
        || typeof identity !== 'object'
        || !Number.isInteger(identity.slot)
        || !Number.isInteger(identity.generation)) {
      throw new TypeError(
        'Runtime wake dispatch requires { slot, generation }');
    }
    const { slot, generation } = identity;
    if (!this._session.memoryImage.isContextIdentityLive(slot, generation)) {
      this.onSlotLifecycle?.({
        kind: 'stale-settlement',
        slot,
        generation,
        currentGeneration:
          this._session.memoryImage.getContextGeneration(slot),
      });
      return;
    }
    const drivingGeneration = this._drivingSlotIdentities.get(slot);
    if (drivingGeneration === generation) {
      this._deferredWakes.set(slot, identity);
      return;
    }
    if (this._quiesced) {
      this._deferredWakes.set(slot, identity);
      return;
    }
    const waiter = this._invokeWaiters.get(slot);
    if (waiter && waiter.generation === generation) {
      this._continueInvoke(slot, waiter);
    } else if (this._rootSlots.has(slot)) {
      this._continueRoot(slot);
    } else {
      runBackgroundDrive(identity, {
        driveSlot: (contextSlot) => this._driveSlot(contextSlot),
        freeContext: (contextIdentity) => {
          const {
            slot: contextSlot,
            generation: contextGeneration,
          } = contextIdentity;
          if (this._session.memoryImage.isContextIdentityLive(
            contextSlot, contextGeneration)) {
            this._session.airlock.freeContext(
              contextSlot, contextGeneration);
          }
        },
        isTerminated: () => this._terminated,
        takeParkedCleanup: (contextSlot) =>
          this._takeParkedCleanup(contextSlot, generation),
      });
    }
  }

  /**
   * Drive a woken root slot (slot 0) to its next yield point.
   * Unlike `_continueInvoke` / `runBackgroundDrive`, this never
   * frees the slot on terminal — slot 0 has no return value to
   * extract and no owner waiting to be settled; it just persists,
   * `'done'` included, so its top-level bindings stay readable
   * (`session.js`'s `inspectionScope`) and the embedder can drive
   * fresh code on it later. Fire-and-forget: `_driveSlot` surfaces
   * every script error via `onHandlerError` (with the uncaught flag)
   * before rethrowing `UncaughtScriptError` — including a throw
   * delivered by a suspension's reject closure, which stashes no
   * AttributedRejection. The rejection is swallowed here rather than
   * left unhandled because `_driveSlot` has already surfaced it.
   */
  _continueRoot(slot) {
    this._driveSlot(slot).catch(() => {});
  }

  /**
   * Consume the deferred cleanup runClosureCall registered for a
   * slot whose drive parked. Returns undefined for slots with no
   * pending closure-call cleanup (async children, woken awaits) —
   * runBackgroundDrive then performs the plain free.
   */
  _takeParkedCleanup(slot, generation) {
    const entry = this._parkedSlotCleanups.get(slot);
    if (entry?.generation === generation) {
      this._parkedSlotCleanups.delete(slot);
      return entry;
    }
    return undefined;
  }

  /**
   * Drive a registered invokeClosure slot that just woke from
   * a park. If the drive reaches terminal, extract the return
   * value, settle the caller's Promise, free the slot, and
   * remove the registry entry. If the drive parks again, leave
   * the registry entry in place — the next wake re-enters here.
   */
  _continueInvoke(slot, waiter) {
    // Returns the drive's status object so run(slot) can delegate
    // here for waiter-owned slots and still hand its caller the
    // status it would have gotten from a raw drive. The error arm
    // resolves (with an 'error' status) rather than rejecting —
    // the WAITER owns error reporting for invoke slots; wake-path
    // callers (_dispatchWoken) ignore the return entirely.
    return this._driveSlot(slot)
      .then((result) => {
        if (!waiter.terminal) {
          this._settleInvokeIfTerminal(slot, waiter, result);
        }
        return result;
      })
      .catch((error) => {
        this._transitionInvoke(waiter, { error });
        return { status: 'error', error };
      });
  }

  _settleInvokeIfTerminal(slot, waiter, result) {
    switch (result.status) {
      case 'done': {
        if (waiter.opts?.construct) {
          this._settleConstructDone(slot, waiter);
          return;
        }
        try {
          let value;
          if (waiter.opts?.propertyResult) {
            // Property reads preserve identity for object and function
            // results (ObjectHandle / ClosureHandle) instead of copying
            // during unmarshal.
            const airlock = this._session.airlock;
            const raw = airlock.readContextResultRaw(slot);
            if (raw.type === TYPE.OBJECT) {
              value = airlock.retainObjectWithGrants(
                raw.lo, waiter.closureHandle.capturedGrantSlots);
            } else if (raw.type === TYPE.FUNCTION) {
              value = airlock.registerClosureWithGrants(
                raw.lo, waiter.closureHandle.capturedGrantSlots);
            } else {
              value = airlock.extractResultFromContext(slot, {});
            }
          } else {
            value = this._session.airlock.extractResultFromContext(
              slot,
              { jsonOnly: Boolean(waiter.opts?.validateResult) },
            );
          }
          waiter.opts?.validateResult?.(value);
          this._transitionInvoke(waiter, { value });
        } catch (error) {
          this._transitionInvoke(waiter, {
            error: waiter.opts?.validateResult
                && !(error instanceof ResultMarshallingError)
              ? new ResultMarshallingError(
                '$', `unmarshallable value: ${error.message}`)
              : error,
          });
        }
        return;
      }
      case 'terminated':
        this._transitionInvoke(waiter, {
          error: new Error(
            'Runtime.invokeClosure: runtime terminated mid-drive'),
          contextAlreadyFreed: true,
        });
        return;
      case 'error':
        this._transitionInvoke(waiter, { error: result.error });
        return;
      default:
        return;
    }
  }

  /**
   * Terminal settlement for a host-driven construction stages the
   * synchronous heap reads (raw result, receiver identity, pending
   * construction duty) BEFORE _transitionInvoke frees the context,
   * then resolves the caller with an async settle that performs the
   * completion (or abort) duty and yields the final ObjectHandle.
   */
  _settleConstructDone(slot, waiter) {
    const airlock = this._session.airlock;
    const receiverHandle = waiter.receiverHandle;
    let staged;
    try {
      const raw = airlock.readContextResultRaw(slot);
      const receiverPointer = airlock.getObjectPointer(receiverHandle);
      let finalPointer;
      if (raw.type === TYPE.OBJECT) {
        // JS [[Construct]]: an explicit object return replaces `this`.
        finalPointer = raw.lo;
      } else if (raw.type === TYPE.ARRAY || raw.type === TYPE.FUNCTION
          || raw.type === TYPE.MAP || raw.type === TYPE.SET
          || raw.type === TYPE.PROMISE) {
        throw new TypeError(
          'constructClosure: constructor returned a value that cannot back an ObjectHandle');
      } else {
        // Primitive or undefined return keeps the receiver.
        finalPointer = receiverPointer;
      }
      const pending = airlock.readPendingConstruction(receiverHandle);
      const finalHandle = finalPointer === receiverPointer
        ? receiverHandle
        : airlock.retainObjectWithGrants(
          finalPointer, waiter.closureHandle.capturedGrantSlots);
      staged = { pending, finalHandle };
    } catch (error) {
      this._transitionInvoke(waiter, { error });
      return;
    }
    const settle = (async () => {
      try {
        if (staged.pending) {
          if (staged.finalHandle !== receiverHandle) {
            const failure = new TypeError('Constructor returned a different object');
            await airlock.abortHostConstruction(
              receiverHandle, staged.pending, failure);
            throw failure;
          }
          await airlock.completeHostConstruction(receiverHandle, staged.pending);
        }
        if (staged.finalHandle !== receiverHandle) {
          airlock.releaseObjectHandle(receiverHandle);
        }
        return staged.finalHandle;
      } catch (error) {
        if (staged.finalHandle !== receiverHandle) {
          airlock.releaseObjectHandle(staged.finalHandle);
        }
        airlock.releaseObjectHandle(receiverHandle);
        throw error;
      }
    })();
    // owner._constructHandled: the reject-duty interceptor in
    // _transitionInvoke must not run for this resolve.
    waiter._constructHandled = true;
    this._transitionInvoke(waiter, { value: settle });
  }

  /**
   * Every reject path of a host-driven construction (script
   * throw, termination, cancellation, drive failure) owes the abort
   * duty for a still-pending receiver and the receiver root's release.
   * Returns a promise that always rejects — with the abort failure
   * (original failure attached as cause) when the abort itself fails.
   */
  _constructFailureSettle(owner, error) {
    const airlock = this._session.airlock;
    const receiverHandle = owner.receiverHandle;
    return (async () => {
      let reported = error;
      try {
        let pending = null;
        try {
          pending = airlock.readPendingConstruction(receiverHandle);
        } catch (brandError) {
          // A malformed brand never outranks the original failure.
        }
        if (pending) {
          await airlock.abortHostConstruction(receiverHandle, pending, error);
        }
      } catch (abortFailure) {
        reported = abortFailure;
      } finally {
        try {
          airlock.releaseObjectHandle(receiverHandle);
        } catch (releaseError) {
          // Already released (or never retained) — the failure below
          // is the caller's signal.
        }
      }
      throw reported;
    })();
  }

  _transitionInvoke(owner, {
    value,
    error,
    rejectResult = error !== undefined,
    contextAlreadyFreed = false,
  }) {
    if (owner.terminal) return false;
    owner.terminal = true;
    if (owner.opts.signal && owner.abortListener) {
      owner.opts.signal.removeEventListener('abort', owner.abortListener);
      owner.abortListener = null;
    }
    if (owner.slot !== null) {
      this._invokeWaiters.delete(owner.slot);
      this._deferredWakes.delete(owner.slot);
    }
    if (owner.opts?.dropOnComplete
        && this._session.airlock.getClosurePointer(owner.closureHandle) !== null) {
      this._session.airlock.dropClosureHandle(owner.closureHandle);
    }
    if (!contextAlreadyFreed
        && owner.slot !== null
        && this._session.memoryImage.isContextIdentityLive(
          owner.slot, owner.generation)) {
      this._session.airlock.freeContext(owner.slot, owner.generation);
    }
    // A rejecting host-driven construction owes the abort duty and the
    // receiver root's release, whichever path rejected it (script throw,
    // cancellation, termination, drive failure). The success settle marks
    // _constructHandled before transitioning.
    if (rejectResult && owner.opts?.construct && owner.receiverHandle
        && !owner._constructHandled) {
      owner._constructHandled = true;
      owner.resolve(this._constructFailureSettle(owner, error));
      return true;
    }
    if (rejectResult) owner.reject(error);
    else owner.resolve(value);
    return true;
  }

  /**
   * Fire the optional scheduler-idle notification hook. Called from
   * `_driveSlot`'s `.finally()` when the final concurrent drive
   * publishes SCHEDULER_IDLE, and from `bootOnly()` after its own
   * publish. Synchronous, no argument, never awaited. A throw is
   * caught here and routed through the attributed handler-error
   * path — it must never propagate into the `.finally()` block,
   * where it would reject the drive promise and skip the quiesce
   * waiters.
   */
  _fireSchedulerIdle() {
    if (this._onSchedulerIdle === null) return;
    try {
      this._onSchedulerIdle();
    } catch (err) {
      this._fireHandlerError(wrapAsAttributedRejection(NO_CALLER_SLOT, err));
    }
  }

  /**
   * Write to the runtime-state cell, deduping no-op transitions
   * to avoid Atomics.notify churn.
   */
  _publishState(value) {
    if (value === this._publishedState) return;
    this._publishedState = value;
    this.runtimeState.set(value);
  }

  _fireHandlerError(rejection, { uncaught = false } = {}) {
    // JS hook fires first — it's the guaranteed signal. The wire
    // emit is best-effort and opt-in (only fires when a composer
    // is registered and the rejection is slot-attributed). A
    // throw from the hook propagates — the embedder owns their
    // callback's try/catch.
    if (this.onHandlerError) this.onHandlerError(rejection);
    // `uncaught` marks a slot-terminal error no drone code caught
    // (driveLoop's UncaughtScriptError/OOM/'error' arms and the
    // unhandled-rejection drain set it). Only those reach capability
    // onUncaughtException hooks — a handler throw the drone catches
    // still flows through onHandlerError (post-run stash surfacing)
    // but is NOT an uncaught drone exception.
    if (uncaught) this._fireUncaughtExceptionHooks(rejection);
    if (!this.composeErrorEnvelope) return;
    if (!(rejection instanceof AttributedRejection)) return;
    this._emitHandlerErrorEnvelope(rejection);
  }

  /**
   * Hand an uncaught drone exception to every capability that
   * registered onUncaughtException from its setup() return. The
   * hook receives the ORIGINAL error (the AttributedRejection's
   * cause) — embedder-facing surfaces want the drone's own error,
   * not the attribution wrapper. A throwing hook is surfaced
   * through _fireHandlerError WITHOUT the uncaught flag (wrapErr
   * yields a plain RuntimeWrappedError), so a deterministically
   * throwing hook cannot recurse into itself.
   */
  _fireUncaughtExceptionHooks(rejection) {
    const error = rejection instanceof AttributedRejection
      ? (rejection.cause ?? rejection)
      : rejection;
    for (const hook of this._uncaughtExceptionHooks) {
      try {
        hook.fn(error);
      } catch (e) {
        this._fireHandlerError(wrapErr(e,
          `capability '${hook.name}' onUncaughtException threw`));
      }
    }
  }

  /**
   * Build runtimeHalf, invoke the embedder's composer, and post
   * the resulting bytes on the outbound channel. Synchronous up
   * to the trySend call; falls back to `await send` if the ring
   * is full (parks the scheduler on OUTBOUND_DRAIN — correct
   * backpressure for a worker throwing errors faster than the
   * host drains).
   *
   * Composer failures (throw, non-Uint8Array/non-null return)
   * are swallowed: no wire emit, no second call, no internal
   * counter. onHandlerError already fired so the embedder still
   * has a guaranteed signal.
   */
  _emitHandlerErrorEnvelope(rejection) {
    const runtimeHalf = this._buildRuntimeHalf(rejection);
    const bytes = this.composeErrorEnvelope(runtimeHalf, rejection);
    if (bytes === null || bytes === undefined) return;
    if (!(bytes instanceof Uint8Array)) return;

    // trySend first; fall back to awaiting send on full ring.
    // Don't await the fallback — fire-and-forget so we don't
    // block the catch site. The send() Promise resolves
    // independently and the embedder's onHandlerError already
    // fired regardless.
    if (this._outbound.trySend(bytes)) return;
    this.send(bytes).catch(() => {
      /* outbound channel error; swallow — embedder's
         onHandlerError already fired with the original
         rejection, and surfacing a secondary "couldn't ship
         the envelope" error would be noise. */
    });
  }

  /**
   * Assemble runtimeHalf — the plain object handed to the
   * embedder's composer. Five sections: error, ss, membrane,
   * slot, runtime. Each is recovered from an existing surface;
   * none introduces wire framing.
   */
  _buildRuntimeHalf(rejection) {
    const slot = rejection.slot;
    const errorSection    = serializeThrownError(rejection.cause);
    const ssSection       = this._session.airlock.captureSlotDiagnostic(slot);
    const membraneSection = this._session.airlock.membrane.captureDiagnostic({
      relevantSlot: slot,
    });
    const ledgerSnapshot  = this.ledger ? this.ledger.walk() : null;
    const inFlightCount   = this._driverStats.inFlight;
    const runtimeState    = this.runtimeState.get();

    return {
      error:    errorSection,
      ss:       ssSection,
      membrane: membraneSection,
      slot,
      runtime: {
        runtimeState,
        inFlightCount,
        ledgerSnapshot,
      },
    };
  }
}

function wrapErr(cause, message) {
  const e = new Error(message, cause !== undefined ? { cause } : undefined);
  e.name = 'RuntimeWrappedError';
  return e;
}

/**
 * Wrap a thrown JS value as an AttributedRejection so embedder
 * hooks see one consistent class regardless of whether the
 * wrapper came from sandscript (handler-throw path) or from the
 * runtime (memory_pressure, unexpected status, ledger saturation).
 */
function wrapAsAttributedRejection(slot, cause) {
  return new AttributedRejection(cause, slot, { slot, status: 'unknown' });
}

/**
 * The status-dispatch loop: call session.run, switch on the
 * returned status, decide whether to continue / park / finish.
 * One loop iteration per WASM yield; one call per active slot.
 *
 * Stateless and dependency-injected — the Runtime composes it
 * with bound callbacks; tests can call it directly with scripted
 * fakes.
 *
 * @param {number} slot
 * @param {{
 *   session:       { run, gc, airlock, memoryImage },
 *   fuel:          number,
 *   onFuelExhausted: ((slot: number) => number | Promise<number>) | null,
 *   onSlotLifecycle: ((event: object) => void) | null,
 *   onGarbageCollect: ((event: object) => void) | null,
 *   isTerminated:  () => boolean,
 *   drainSpawned:  () => void,
 *   dispatchChild: (slot: number) => void,
 *   surfaceError:  (rejection, opts?: { uncaught?: boolean }) => void,
 *   publishState:  (value: number) => void,
 *   bumpErrors:    () => void,
 * }} deps
 * @returns {Promise<{ status: string, error?: any }>}
 */
export async function driveLoop(slot, deps) {
  const {
    session, onFuelExhausted,
    onSlotLifecycle, onGarbageCollect,
    isTerminated, drainSpawned, dispatchChild,
    surfaceError, publishState, bumpErrors,
    recordFuelCost,
  } = deps;
  // Append a kind:FUEL entry to the membrane cost ledger at each
  // drive-episode boundary. This mirrors the consumedFuel reported via
  // onSlotLifecycle / the paused return value, but lands the number in
  // durable accounting storage rather than a live event. No-op when the
  // embedder didn't wire it.
  const recordFuel = (slot, consumed) => {
    if (recordFuelCost && consumed > 0) recordFuelCost(slot, consumed);
  };
  // `fuel` is the per-run budget; mutable because onFuelExhausted can
  // choose a different budget for the next run.
  let fuel = deps.fuel;

  // `next` lets the memory_pressure retry splice its result
  // back into the same switch instead of duplicating cases.
  let next = null;
  // Consumed fuel accumulated across every session.run in THIS drive
  // episode. A single embedder-visible drive can span multiple
  // session.run calls (the paused/refuel loop), so consumption must
  // sum, not report only the last run. session.run returns REMAINING
  // fuel as `resolved.fuel`; consumed for one run is `fuel -
  // resolved.fuel`, captured before any refuel mutates `fuel`. Forwarded
  // at the drive-episode boundary (terminal done/error, or park) via an
  // onSlotLifecycle 'fuel' event, then reset for the next episode.
  let consumedThisDrive = 0;
  while (true) {
    if (isTerminated()) return { status: 'terminated', error: null };

    let resolved;
    if (next !== null) {
      resolved = next;
      next = null;
    } else {
      try {
        const result = session.run(slot, fuel);
        resolved = (result && typeof result.then === 'function')
          ? await result : result;
      } catch (e) {
        if (e instanceof UncaughtScriptError) {
          // The throwing run's consumed fuel is dropped from the return
          // path; UncaughtScriptError carries the remaining fuel so we
          // can still attribute it. Null (e.g. async-rejection drain)
          // means no run budget to attribute.
          if (e.remainingFuel !== null) consumedThisDrive += fuel - e.remainingFuel;
          // Suspension reject closures do not populate the attributed stash;
          // that stash is written only when a JS handler throws through
          // _invokeWithSlotCapture. Every uncaught throw reaching this arm
          // must therefore fire the embedder's onHandlerError, using the
          // UncaughtScriptError itself when no stash exists. `_continueRoot`
          // swallows the rethrow because this arm owns surfacing it. `uncaught`
          // also routes the error to capability onUncaughtException hooks;
          // this arm runs only after the error escapes all drone code.
          const stash = session.airlock.consumeAttributedRejection(slot);
          surfaceError(
            stash ?? wrapAsAttributedRejection(slot, e),
            { uncaught: true });
          if (onSlotLifecycle) onSlotLifecycle({ kind: 'error', slot, error: e.scriptError, consumedFuel: consumedThisDrive });
          recordFuel(slot, consumedThisDrive);
          bumpErrors();
          drainSpawned();
          throw e;
        }
        throw e;
      }
      // session.run reports remaining fuel; accumulate this run's
      // consumption before any refuel can mutate `fuel`.
      consumedThisDrive += fuel - resolved.fuel;
      // After every run, surface any stashed attribution.
      const stash = session.airlock.consumeAttributedRejection(slot);
      if (stash !== null) surfaceError(stash);
    }

    switch (resolved.status) {
      case 'done':
        if (onSlotLifecycle) onSlotLifecycle({ kind: 'done', slot, consumedFuel: consumedThisDrive });
        recordFuel(slot, consumedThisDrive);
        drainSpawned();
        return { status: 'done', error: null };

      case 'paused': {
        // Out of fuel. With no hook, refill with the same quantum and
        // continue — byte-for-byte today's behavior. But if the quantum
        // is already <= 0, "refuel with the same quantum" refuels with
        // nothing: the next run would report 'paused' again having
        // executed zero instructions, forever, in a tight synchronous
        // loop that never yields to the event loop. Park for real
        // instead of spinning.
        if (!onFuelExhausted) {
          if (fuel <= 0) {
            recordFuel(slot, consumedThisDrive);
            return { status: 'paused', error: null, consumedFuel: consumedThisDrive };
          }
          continue;
        }
        // Ask the embedder how much fuel to inject next. Await only if
        // the hook returned a Promise; a sync number is used as-is
        // (no microtask hop for the common quota check).
        const r = onFuelExhausted(slot);
        const refuel = (r && typeof r.then === 'function') ? await r : r;
        // Falsy => stop driving, leave the slot parked (alive and
        // resumable, same as an await/suspended park). NOT a kill; the
        // embedder re-drives or terminates on its own schedule. The work
        // done before the park is real; surface its consumed fuel on the
        // park return (the re-drive starts a fresh accumulator).
        if (!refuel) {
          recordFuel(slot, consumedThisDrive);
          return { status: 'paused', error: null, consumedFuel: consumedThisDrive };
        }
        fuel = refuel;   // embedder-chosen budget for the next run
        continue;
      }

      case 'memory_pressure': {
        // Auto-GC and retry. A retried drive that makes PROGRESS and
        // pressures again later is NOT an OOM — an allocation-heavy
        // stretch (a loop building strings/objects per iteration) simply
        // outruns one collection and needs another; this case re-enters
        // for each round. Only a NO-PROGRESS retry — parked again at the
        // SAME instruction having consumed (almost) no fuel — means the
        // single pending operation genuinely cannot fit, which is the
        // real OOM. The old declare-OOM-on-second-pressure logic killed
        // any slot whose loop allocated more than one heap's worth of
        // transients (the console-host's ready handler died measuring 85
        // backfill entries — a FALSE OOM that lost the parks backfill,
        // 2026-07-02).
        const pcAtPressure = (() => {
          try { return session.airlock.memoryImage.getContextInstructionIndex(slot); }
          catch { return -1; }
        })();
        if (onGarbageCollect) onGarbageCollect({ kind: 'start', slot });
        publishState(RUNTIME_STATE.GC);
        const gcStartTime = performance.now();
        let gcResult;
        try { gcResult = session.gc(); } catch (gcErr) {
          surfaceError(wrapAsAttributedRejection(slot, gcErr), { uncaught: true });
          publishState(RUNTIME_STATE.RUNNING);
          // A FAILED COLLECTION IS FATAL — the collector marked the image
          // poisoned (half-marked, half-moved, half-forwarded). Returning a
          // per-slot error here (the old behavior) kept the vat executing
          // over the wreckage: that is how the live console-host silently
          // degraded into poisoned folds and sticky INVALID_OPERAND state
          // (2026-07-02). Propagate — the embedder's loud death + restore
          // from persisted bytes is the only sound recovery.
          if (gcErr?.fatalCollection) throw gcErr;
          return { status: 'error', error: gcErr };
        }
        if (onGarbageCollect) {
          onGarbageCollect({
            kind: 'complete', slot,
            heapCollected: gcResult.heapCollected ?? 0,
            handlesFreed: gcResult.handlesFreed ?? 0,
            grantsFreed: gcResult.grantsFreed ?? 0,
            durationMs: performance.now() - gcStartTime,
          });
        }
        publishState(RUNTIME_STATE.RUNNING);
        let retryResolved;
        try {
          const retry = session.run(slot, fuel);
          retryResolved = (retry && typeof retry.then === 'function')
            ? await retry : retry;
        } catch (e) {
          if (e instanceof UncaughtScriptError) {
            if (e.remainingFuel !== null) consumedThisDrive += fuel - e.remainingFuel;
            // Same no-stash surfacing contract as the primary run arm
            // above: this arm only runs for a throw no drone code caught.
            const stash = session.airlock.consumeAttributedRejection(slot);
            surfaceError(
              stash ?? wrapAsAttributedRejection(slot, e),
              { uncaught: true });
            if (onSlotLifecycle) onSlotLifecycle({ kind: 'error', slot, error: e.scriptError, consumedFuel: consumedThisDrive });
            recordFuel(slot, consumedThisDrive);
            bumpErrors();
            drainSpawned();
            throw e;
          }
          throw e;
        }
        // Accumulate the retry run's consumption. The result is spliced
        // into `next` below; the next-branch adds nothing when it later
        // consumes it, so this is the only place it's counted.
        const retryConsumed = fuel - retryResolved.fuel;
        consumedThisDrive += retryConsumed;
        const stash = session.airlock.consumeAttributedRejection(slot);
        if (stash !== null) surfaceError(stash);
        if (retryResolved.status === 'memory_pressure') {
          // PROGRESS CHECK. A second pressure after real progress (fuel
          // consumed, or parked at a different instruction) is a NEW
          // pressure event further along an allocation-heavy stretch —
          // splice it back so this case runs another collection round.
          // Only a no-progress retry — same instruction, essentially no
          // fuel — is the genuine "this one operation cannot fit" OOM.
          // (A loop can legitimately return to the SAME pc after a full
          // iteration, which is why fuel is the primary discriminator;
          // ε covers the re-execution cost of the single failing op.)
          const pcAfterRetry = (() => {
            try { return session.airlock.memoryImage.getContextInstructionIndex(slot); }
            catch { return -2; }
          })();
          const madeProgress = retryConsumed > 8
            || (pcAfterRetry !== pcAtPressure && retryConsumed > 0);
          if (madeProgress) {
            next = retryResolved;
            continue;
          }
          // Name the failing site: the pressure exit does NOT consume the
          // op or advance the instruction pointer, so the slot's current
          // instruction index IS the op that could not allocate. Include
          // region occupancy so a "region genuinely full" OOM is
          // distinguishable from an oversized single demand at a glance
          // (this line is often the ONLY surviving evidence — the step
          // ring wraps under traffic long before a human reads it).
          let site = '';
          try {
            const mem = session.airlock.memoryImage;
            const stringStart = mem.getStringStart();
            const stringUsed = mem.getStringPointer() - stringStart;
            const stringBudget = mem.segmentSize - stringStart;
            const heapStart = mem.getHeapStart();
            const heapUsed = mem.getHeapPointer() - heapStart;
            site = ` (slot=${slot} instructionIndex=${pcAfterRetry} ` +
              `stringRegion=${stringUsed}/${stringBudget} ` +
              `heapUsed=${heapUsed})`;
          } catch { /* diagnostics are best-effort */ }
          const oom = new Error(
            'sandscript memory_pressure persisted across runtime gc with no ' +
            'progress; the single pending operation does not fit ' +
            '(heap or string region)' + site);
          oom.name = 'MemoryPressureError';
          if (onGarbageCollect) onGarbageCollect({ kind: 'oom', slot });
          surfaceError(wrapAsAttributedRejection(slot, oom), { uncaught: true });
          recordFuel(slot, consumedThisDrive);
          return { status: 'error', error: oom, consumedFuel: consumedThisDrive };
        }
        // Splice the retry result so async_call / promise_method /
        // async_complete payloads dispatch correctly (sandscript
        // already advanced past the emitting op; falling through
        // would lose them).
        next = retryResolved;
        continue;
      }

      case 'await':
      case 'suspended':
        // Slot parked; sandscript will push it back into
        // pendingSpawnedContexts when its dependency settles. The work
        // done BEFORE the park is real and must be reported here — this
        // is the common "compute then await fetch(...)" case. Omitting it
        // silently dropped all pre-await fuel (it was accumulated into
        // consumedThisDrive, then discarded when the slot re-drove with a
        // fresh accumulator). The re-drive starts a new episode.
        if (onSlotLifecycle) onSlotLifecycle({ kind: resolved.status, slot, consumedFuel: consumedThisDrive });
        recordFuel(slot, consumedThisDrive);
        return { status: resolved.status, error: null, consumedFuel: consumedThisDrive };

      case 'async_call':
        if (resolved.asyncContext != null) {
          dispatchChild(resolved.asyncContext);
        }
        continue;

      case 'async_complete': {
        const settlement = session.airlock.handleAsyncComplete(slot);
        const waiters = settlement.waiters;
        if (Array.isArray(waiters)) {
          for (const waiter of waiters) dispatchChild(waiter);
        }
        if (onSlotLifecycle) onSlotLifecycle({ kind: 'done', slot, consumedFuel: consumedThisDrive });
        recordFuel(slot, consumedThisDrive);
        drainSpawned();
        return { status: 'done', error: null, consumedFuel: consumedThisDrive };
      }

      case 'async_rejected': {
        const settlement = session.airlock.handleAsyncRejected(slot);
        const waiters = settlement.waiters;
        if (Array.isArray(waiters)) {
          for (const waiter of waiters) dispatchChild(waiter);
        }
        if (onSlotLifecycle) onSlotLifecycle({ kind: 'done', slot, consumedFuel: consumedThisDrive });
        recordFuel(slot, consumedThisDrive);
        drainSpawned();
        return { status: 'done', error: null, consumedFuel: consumedThisDrive };
      }

      case 'promise_method': {
        const children = resolved.contexts;
        if (Array.isArray(children)) {
          for (const child of children) dispatchChild(child);
        }
        continue;
      }

      case 'error': {
        const translated = resolved.error;
        const message = translated
          ? translated.message || `error code ${translated.code}`
          : 'unknown interpreter error';
        const e = new Error(message);
        e.name = 'ScriptError';
        if (translated) e.scriptError = translated;
        bumpErrors();
        drainSpawned();
        surfaceError(wrapAsAttributedRejection(slot, e), { uncaught: true });
        if (onSlotLifecycle) onSlotLifecycle({ kind: 'error', slot, error: translated, consumedFuel: consumedThisDrive });
        recordFuel(slot, consumedThisDrive);
        return { status: 'error', error: e };
      }

      default: {
        const e = new Error(
          `runtime driver received unexpected status '${resolved.status}' ` +
          `from session.run`);
        e.name = 'UnexpectedDriverStatus';
        bumpErrors();
        surfaceError(wrapAsAttributedRejection(slot, e), { uncaught: true });
        return { status: 'error', error: e, consumedFuel: consumedThisDrive };
      }
    }
  }
}

/**
 * Statuses after which a slot's context is genuinely finished and
 * its slot can be returned to the pool. Everything else means the
 * slot is PARKED with live state (suspended/await: sandscript will
 * re-push it into pendingSpawnedContexts when its dependency
 * settles; paused: the embedder's fuel policy re-drives it;
 * quiesced: the drive was refused and the slot must survive to the
 * resume). Freeing a parked slot marks its context FREE while its
 * scope, stacks and pending value are still live — the collector
 * then skips it as a root (scope corruption on resume:
 * tests/runtime/gc_parked_suspend_control_test.js) and
 * allocateContext can hand the same slot to a concurrent closure
 * call (state clobber).
 */
function isTerminalDriveStatus(status) {
  return status === 'done' || status === 'error' || status === 'terminated';
}

/**
 * Schedule a background drive for a slot the runtime didn't
 * directly request — children spawned by sandscript via
 * async_call / promise_method, or parked slots woken via the
 * airlock's pendingSpawnedContexts queue. Fire-and-forget;
 * errors flow through driveSlot's own surfacing path.
 *
 * After the drive reaches a TERMINAL status: free the slot back to
 * the pool (sandscript allocated it but won't free it on its own).
 * A drive that ends parked (suspended / await / paused / quiesced)
 * leaves the slot allocated — the wake that eventually drives it to
 * terminal performs the free.
 *
 * `takeParkedCleanup` (optional) transfers ownership of deferred
 * closure-call cleanup: when a runClosureCall drive parked, its
 * free + dropOnComplete duties were registered against the slot;
 * the terminal background drive executes them instead of the plain
 * free.
 *
 * @param {{slot:number, generation:number}} identity
 * @param {{
 *   driveSlot:         (slot: number) => Promise<{status, error?}>,
 *   freeContext:       (identity: {slot:number, generation:number}) => void,
 *   isTerminated:      () => boolean,
 *   takeParkedCleanup?: (slot: number) => (() => void) | undefined,
 * }} deps
 */
export function runBackgroundDrive(identity, deps) {
  const { slot } = identity;
  const { driveSlot, freeContext, isTerminated, takeParkedCleanup } = deps;
  if (isTerminated()) return;
  // finish runs when the (previously parked) slot reaches terminal. `result`
  // carries the terminal status — if it's an error and the firer registered a
  // per-call onError (via deferParkedCleanup's opts), notify it. This is the
  // common case for an async listener that awaits before throwing: it parked
  // here, woke, and is now terminating in error.
  const finish = (result) => {
    const entry = takeParkedCleanup ? takeParkedCleanup(slot) : undefined;
    if (entry) {
      notifyCallError(entry.opts, result);
      entry.cleanup();
    } else {
      freeContext(identity);
    }
  };
  driveSlot(slot).then(
    (result) => {
      if (!isTerminalDriveStatus(result.status)) return;
      finish(result);
    },
    (err) => {
      // UncaughtScriptError path — the slot terminated. Free, then
      // re-throw so the rejection surfaces exactly as before.
      finish({ status: 'error', error: err });
      throw err;
    },
  );
}

/**
 * Run one queued closure call from start to finish: wait for
 * embedder backpressure, check the closure handle is still
 * live (and its grants aren't revoked), allocate a slot,
 * bind the closure, drive the slot, then free the slot and
 * (optionally) drop the handle.
 *
 * Stateless and dependency-injected — Runtime composes it with
 * bound deps; tests can call it directly with fakes.
 *
 * @param {{closureHandle, args, opts, ledgerEntry}} call
 * @param {{
 *   airlock: {
 *     getClosurePointer, areClosureGrantsActive,
 *     allocateContext, setupCallbackContext,
 *     freeContext, dropClosureHandle,
 *   },
 *   driveSlot:         (slot: number) => Promise<{status, error?}>,
 *   backpressure:      (() => Promise<void>) | null,
 *   ledger:            { free(idx): void },
 *   isTerminated:      () => boolean,
 *   onClosureDispatch: ((event: object) => void) | null,
 *   deferParkedCleanup?: (slot: number, cleanup: () => void) => void,
 * }} deps
 */
export async function runClosureCall(call, deps) {
  const { closureHandle, args, opts, ledgerEntry } = call;
  const {
    airlock, driveSlot, backpressure, ledger,
    isTerminated, onClosureDispatch, deferParkedCleanup,
  } = deps;

  if (backpressure) await backpressure();
  if (isTerminated()) {
    ledger.free(ledgerEntry);
    return;
  }

  // Firer-supplied delivery gate, consulted at dequeue time (the queue
  // drains FIFO, one call at a time, so a gate closed by an earlier
  // call's onMarshalError is guaranteed visible to every call queued
  // behind it). A closed gate is a delivery failure like the drops
  // below: the closure never sees the args. This exists for ordered
  // streams — once one record fails to deliver, executing the ones
  // queued behind it would put a hole in the middle of the listener's
  // fold; the firer closes the gate and re-delivers everything from
  // the hole onward in a fresh incarnation.
  if (typeof opts.shouldDeliver === 'function' && !opts.shouldDeliver()) {
    if (onClosureDispatch) {
      onClosureDispatch({
        kind: 'dropped',
        closurePointer: airlock.getClosurePointer(closureHandle),
        reason: 'gated',
      });
    }
    notifyMarshalError(opts, new Error('delivery gated by firer'));
    ledger.free(ledgerEntry);
    return;
  }

  // Liveness check. A dropped dispatch is a DELIVERY failure from the
  // firer's point of view — the closure never received the args — so it
  // notifies onMarshalError, not onError (which means "the closure ran
  // and ended in error"). Firers that track ordered delivery (a box
  // subscription cursor) treat the two very differently: an undelivered
  // record must not be skipped past.
  const closurePointer = airlock.getClosurePointer(closureHandle);
  if (closurePointer === null) {
    if (onClosureDispatch) onClosureDispatch({ kind: 'dropped', closurePointer, reason: 'freed' });
    notifyMarshalError(opts, new Error('closure freed before dispatch'));
    ledger.free(ledgerEntry);
    return;
  }
  // Grant-revocation check.
  if (!airlock.areClosureGrantsActive(closureHandle)) {
    if (onClosureDispatch) onClosureDispatch({ kind: 'dropped', closurePointer, reason: 'revoked' });
    notifyMarshalError(opts, new Error('closure grants revoked'));
    if (opts.dropOnComplete) airlock.dropClosureHandle(closureHandle);
    ledger.free(ledgerEntry);
    return;
  }

  // Allocate a slot. The slot→pointer table grows on demand, so the
  // only failure mode is genuine heap exhaustion — let it propagate
  // (after notifying the firer: args never reached the vat).
  let slot;
  let generation;
  try {
    slot = airlock.allocateContext();
    generation = airlock.memoryImage.getContextGeneration(slot);
  } catch (err) {
    notifyMarshalError(opts, err);
    ledger.free(ledgerEntry);
    throw err;
  }

  // Bound to a real slot — DISPATCHING_CLOSURE ends here.
  ledger.free(ledgerEntry);

  const cleanup = () => {
    if (airlock.memoryImage.isContextIdentityLive(slot, generation)) {
      airlock.freeContext(slot, generation);
    }
    if (opts.dropOnComplete
        && airlock.getClosurePointer(closureHandle) !== null) {
      airlock.dropClosureHandle(closureHandle);
    }
  };

  let marshaled = false;
  try {
    airlock.setupCallbackContext(slot, closureHandle, args);
    marshaled = true;
    // Args are now on the SS heap (the normal walk
    // covers them); end the in-flight pin window for this entry.
    deps.onArgsMarshaled?.();
    // Per-call delivery receipt: the args are in the vat — from here on the
    // closure OWNS the call (a body that throws is a script error, not a
    // delivery failure). Firers that advance an ordered cursor advance it on
    // exactly this signal.
    notifyMarshaled(opts);
    if (onClosureDispatch) {
      onClosureDispatch({
        kind: 'drive',
        slot,
        closurePointer,
        correlationId: opts.traceCorrelationId ?? null,
      });
    }
    const result = await driveSlot(slot, {
      onParked: () => {
        if (deferParkedCleanup) {
          // Publish this closure slot's terminal cleanup ownership before the
          // active drive releases a wake that arrived during its unwind.
          deferParkedCleanup({ slot, generation }, cleanup, opts);
        }
      },
    });
    if (isTerminalDriveStatus(result.status)) {
      // Per-call error notification: a scheduled closure that ends in an
      // error terminal status surfaces through onHandlerError globally, but
      // the FIRER of this specific call has no other way to learn THIS call
      // failed (scheduleClosureCall is fire-and-forget). opts.onError lets the
      // firer correlate the failure to whatever it dispatched the closure for
      // — e.g. an http cap 500-ing the request whose listener threw before
      // responding.
      notifyCallError(opts, result);
      cleanup();
      if (onClosureDispatch) {
        onClosureDispatch({
          kind: 'complete',
          slot,
          closurePointer,
          correlationId: opts.traceCorrelationId ?? null,
        });
      }
    }
  } catch (err) {
    // A JS-thrown error (not an SS terminal 'error' status) also fails the
    // call — notify the firer before rethrowing to the global handler. A
    // throw BEFORE the marshal completed (setupCallbackContext refusing an
    // arg — e.g. a string too long for the vat's scratch region) is a
    // DELIVERY failure: the closure never saw the args, so the firer gets
    // onMarshalError, not onError.
    if (marshaled) notifyCallError(opts, { status: 'error', error: err });
    else notifyMarshalError(opts, err);
    cleanup();
    throw err;
  }
}

// Fire opts.onError(error) if the firer asked for a per-call error signal and
// the drive ended in error. Best-effort: a throw from the firer's hook must
// not break slot cleanup or the global error path.
function notifyCallError(opts, result) {
  if (result?.status !== 'error') return;
  if (typeof opts?.onError !== 'function') return;
  try { opts.onError(result.error ?? null); }
  catch { /* firer's hook owns its own errors */ }
}

// Fire opts.onMarshaled() — the per-call delivery receipt: args landed in
// the vat and the closure now owns the call. Best-effort like notifyCallError.
function notifyMarshaled(opts) {
  if (typeof opts?.onMarshaled !== 'function') return;
  try { opts.onMarshaled(); }
  catch { /* firer's hook owns its own errors */ }
}

// Fire opts.onMarshalError(error) — the per-call delivery FAILURE: the
// closure never received the args (marshal refusal, slot exhaustion, a
// freed/revoked closure). Distinct from onError so a firer tracking ordered
// delivery can halt instead of skipping. Best-effort like notifyCallError.
function notifyMarshalError(opts, error) {
  if (typeof opts?.onMarshalError !== 'function') return;
  try { opts.onMarshalError(error ?? null); }
  catch { /* firer's hook owns its own errors */ }
}

/**
 * Fan a grant request out to every registered capability
 * endorser, apply single-claim policy, and return the airlock's
 * approval shape.
 *
 *   - 0 endorsements → denied
 *   - 1 endorsement  → approved with that endorser's value
 *   - 2+             → denied; surface MultipleEndorsementsError
 *
 * Endorsers may return their decision sync or as a Promise.
 * A throwing endorser counts as "no endorsement" and is surfaced
 * via onError as a wrapped EndorserError.
 *
 * @param {string} identifier
 * @param {Array<{name: string, hook: (id: string) => any}>} endorsers
 * @param {(err: Error) => void} onError
 * @returns {{approved: boolean, grant?: any} | Promise<{approved, grant?}>}
 */
export function runGrantFanout(identifier, endorsers, onError) {
  if (endorsers.length === 0) return { approved: false };

  const results = endorsers.map(({ name, hook }) => {
    let out;
    try { out = hook(identifier); }
    catch (err) {
      onError(wrapEndorserError(name, identifier, err));
      return Promise.resolve({ name, endorsement: null });
    }
    if (out && typeof out.then === 'function') {
      return out.then(
        v => ({ name, endorsement: v }),
        err => {
          onError(wrapEndorserError(name, identifier, err));
          return { name, endorsement: null };
        });
    }
    return Promise.resolve({ name, endorsement: out });
  });

  return Promise.all(results).then((all) => {
    const endorsements = all.filter(r =>
      r.endorsement !== null && r.endorsement !== undefined);
    if (endorsements.length === 0) return { approved: false };
    if (endorsements.length === 1) {
      return normalizeApproval(endorsements[0].endorsement);
    }
    onError(new MultipleEndorsementsError(identifier, endorsements.map(e => e.name)));
    return { approved: false };
  });
}

function wrapEndorserError(capabilityName, identifier, err) {
  const wrapped = new Error(
    `capability '${capabilityName}' onGrantRequest('${identifier}') threw: ${err?.message ?? err}`);
  wrapped.name = 'EndorserError';
  wrapped.cause = err;
  wrapped.capability = capabilityName;
  wrapped.identifier = identifier;
  return wrapped;
}

/**
 * Accept either the bare grant value (shorthand) or the
 * `{ approved, grant }` object the airlock expects, and
 * return the canonical shape.
 */
function normalizeApproval(endorsement) {
  if (endorsement && typeof endorsement === 'object'
      && 'approved' in endorsement) {
    return endorsement;
  }
  return { approved: true, grant: endorsement };
}

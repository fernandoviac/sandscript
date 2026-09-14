# `src/runtime/` — Specification

The canonical driver layer for sandscript. Where `src/fuel/`
exposes the session primitive (the interpreter, with its engine,
airlock, and membrane), `src/runtime/` composes that primitive
into a `Runtime` that boots, runs, snapshots, relocates, and shuts
down a sandscript program end-to-end.

This document is the reference. The implementation in
`src/runtime/*.js` is bound by it; the tests in
`tests/runtime/` validate against it; embedders integrate
against it.

---

## Module surface

```js
import {
  Runtime,
  // Free functions composing the runtime — exported so embedders
  // and tests can drive them in isolation. Runtime itself
  // composes them with bound deps; embedders normally don't
  // import them directly.
  driveLoop,
  runBackgroundDrive,
  runClosureCall,
  runGrantFanout,
  RUNTIME_STATE,
  runtimeStateName,
  createRuntimeStateView,
  createLedgerView,
  LEDGER_ACTIVITY,
  ledgerActivityName,
  MissingDependencyError,
  CapabilityCycleError,
  MultipleEndorsementsError,
  RuntimeBootError,
} from 'src/runtime/index.js';
```

`Runtime` is the only class. Everything else is a value, a
free function, or an error class.

---

## Construction

```js
new Runtime({
  // Required: a pre-built session (the interpreter — engine +
  // airlock + memoryImage + parser) from src/fuel/. The embedder
  // builds it so it can pre-stage state (snapshot bytes, deferred
  // resize, subsystem views) before the runtime takes over. Once
  // handed in, it is runtime-private; embedder access goes through
  // runtime methods only.
  session,

  // Required: channel pair. Anything matching wire's Channel
  // surface; the runtime imports zero wire types and uses no
  // instanceof checks. See "The channel contract" below.
  inboundChannel,
  outboundChannel,

  // Required: capability list and the maps for resolving
  // their `needs` declarations. See "The capability
  // contract" below.
  capabilities,    // Array<Capability>
  hostServices,    // { [name: string]: any }
  subsystems,      // { [name: string]: any }

  // Required iff the embedder wants to receive inbound
  // messages. The runtime refuses to enter its main loop
  // without it. Embedders that genuinely want no inbound
  // messages should supply an inbound channel that never
  // delivers, not a hook that swallows.
  onInboundMessage,  // (payload: Uint8Array, sequenceNumber: bigint) => void | Promise<void>

  // Optional: hooks.
  onHandlerError,             // (rejection: AttributedRejection) => void
  composeErrorEnvelope,       // (runtimeHalf, rejection: AttributedRejection) => Uint8Array | null
  extraSchedulerBackpressure, // async () => void
  // Note: runtime-state transitions are NOT delivered through a JS
  // callback. They are written to `runtime.runtimeState` — a SAB
  // cell observable across realms via Atomics.load / Atomics.wait.
  // See "runtime.runtimeState" and "RUNTIME_STATE" below.

  // Optional: scheduler-idle notification. The runtime calls this
  // hook at each arrival at final scheduler idle — after the last
  // concurrent drive returns, and after bootOnly(). Called after
  // the runtime publishes SCHEDULER_IDLE, synchronously, with no
  // argument, never awaited. See "Scheduler-idle notification"
  // below.
  onSchedulerIdle, // (() => void) | null

  // Optional: per-run fuel budget. Default 100_000.
  fuel,

  // Optional: name for debugging. Surfaces in error messages.
  name,
})
```

### Pre-construction contract

The embedder is responsible for:

- Building the `session` (typically `freshSession({...})` or
  `restoreSession(...)` from `src/host-owned-session.js`) with
  whatever memory/segment configuration it needs. The session
  carries its own airlock; no separate construction.
- Registering any pre-runtime handles or grants on
  `session.airlock` (these flow through the membrane and are
  visible to capability setup).
- Applying any deferred boot state: snapshot bytes,
  `session.airlock.membrane.resizeRegions(...)` for a deferred
  resize, etc.
- Wiring the channels.

The runtime does not touch the session during construction. The
first runtime-driven session access happens inside `start()`
(capability setup); the first slot drive happens after `start()`
enters its inbound loop.

### Post-construction contract

After `new Runtime(...)` returns, the session is runtime-private.
Embedders must use runtime methods for all further interaction.
Direct calls like `session.run(...)`,
`session.airlock.setHandler(...)`, or
`session.airlock.membrane.compact(...)` are contract violations
that produce undefined behavior — the runtime's internal
invariants (quiesce state, in-flight counters, parked-state
tracking) will not match reality.

The runtime keeps the session under a private field; it does
not expose it as a property. The curated stats methods (see
"Stats surface" below) are the read path.

---

## The channel contract

Two channel objects in the constructor — one inbound, one
outbound. Each must duck-type to this shape:

```
inboundChannel: {
  // Subscribe to incoming messages. Returns an unsubscribe
  // function. The callback is fire-and-forget — any return
  // value (including Promises) is ignored.
  onMessage(cb: ({ payload, sequenceNumber }) => void): () => void,
}

outboundChannel: {
  send(payload: Uint8Array):    Promise<void>,
  trySend(payload: Uint8Array): boolean,
}
```

This matches wire's `Channel` shape verbatim. The runtime
imports nothing from wire; the contract is structural. In
production these are wire `Channel` instances; in tests they
are fakes.

The runtime calls only the methods that apply to a role
(never `send` on inbound, never `onMessage` on outbound). A
channel supplied by the consumer may be unidirectional in its
own implementation; the runtime never crosses the role.

`sequenceNumber` is the per-message monotonic counter the
channel assigns. The runtime forwards it to
`onInboundMessage` unchanged. Embedders that don't care can
ignore it.

---

## The capability contract

A capability is a plain object with this shape:

```
{
  // Required: unique within the runtime instance. The runtime
  // uses this as the key for cross-capability dependency
  // resolution and for error messages.
  name: string,

  // Optional: dependency declarations. The runtime resolves
  // each entry's value against the appropriate source and
  // delivers them in `resolvedContext` to setup.
  //
  //   'host-service'  → resolved from `hostServices` map
  //   'subsystem'     → resolved from `subsystems` map
  //   'capability'    → resolved from another capability's
  //                     setup return value (its `exports`)
  needs?: {
    [key: string]: 'host-service' | 'subsystem' | 'capability',
  },

  // Required: called once per Runtime.start(), in
  // dependency-topological order. Receives the runtime-private
  // airlock, the resolvedContext object with exactly the keys
  // declared in `needs`, and options carrying boot/resume
  // metadata.
  //
  // Returns either nothing or an object with hooks/exports.
  setup(airlock, resolvedContext, options): void | {
    // Optional: grant-request endorser. The runtime collects
    // these across all capabilities and applies single-claim
    // policy (see "Grant fanout").
    onGrantRequest?(identifier: string): Endorsement | null | Promise<Endorsement | null>,

    // Optional: lifecycle hook fired when the drone terminates
    // (the runtime's `terminate()` method completes).
    onDroneTerminated?(): void | Promise<void>,

    // Optional: lifecycle hook fired after the runtime
    // successfully resumes from a snapshot. Boot mode skips
    // this hook entirely.
    onResume?(): void | Promise<void>,

    // Optional: fired for each error that terminates a slot with
    // no drone code catching it — an uncaught SS throw (including
    // one delivered by a rejecting external member read/write/
    // call), an unhandled SS async rejection, an interpreter
    // fault, or an OOM. The hook receives the ORIGINAL error (an
    // AttributedRejection's cause), not the attribution wrapper.
    // It does NOT fire for errors the drone catches, or for
    // diagnostic signals. A throwing hook surfaces through
    // `onHandlerError` and does not recurse.
    onUncaughtException?(error: Error): void,

    // Optional: capability-exports for other capabilities to
    // import via `needs: { foo: 'capability' }`. The runtime
    // delivers `exports` (or the whole return value if no
    // `exports` key is present) under the consumer's
    // declared key.
    exports?: any,
  },
}
```

`options.resume` is `true` when the runtime was constructed
against a restored engine (snapshot bytes were supplied at
`createSession` time) and `false` for a fresh boot. The
capability can branch on this for "mint fresh state vs. rebind
to restored state."

### Dynamic external member registration

A capability can register one dynamic member inspector for an external handle:

```javascript
airlock.setMemberInspector(handle, ({ name, context }) => result);
```

The inspector is synchronous. It returns exactly `{ kind: 'absent' }`,
`{ kind: 'data', writable: boolean }`, or `{ kind: 'method' }`. It does not
invoke a getter. The Airlock throws for every other result.

An exact getter or exact handler takes precedence over the inspector. An exact
setter defines writable data when neither earlier registration exists. The
inspector classifies every other name.

Data uses the exact or default getter and setter adapters. A read-only write
throws. A method keeps receiver binding and uses the exact or default handler.
An absent read returns `undefined`.

The same classification applies to plain external handles and branded backing
handles. An absent branded write creates a vat expando. An absent plain write
throws.

The membrane persists the handle but not the inspector or adapter functions.
Each capability registers them in `setup` on fresh boot and restore. Resume
setup finds the handle through `enumerateHandles()` and does not call
`register()` again.

### Capability-wide persistent state

A capability that owns state which doesn't belong to any single
handle — a monotonic request counter, a state-machine phase, a
watermark, a cache-invalidation timestamp — can store it in the
membrane's capability-state cell:

```js
airlock.membrane.setCapabilityState(name, value)
airlock.membrane.getCapabilityState(name)
```

- `name` is a free-form string. The capability's own `.name`
  is the canonical choice, but capabilities that want multiple
  internal scopes can prefix (`'http-ingress.listeners'`,
  `'http-ingress.request-counter'`) without paying for a
  msgpack-encoded composite payload on every read.
- `value` is anything msgpack-serializable; `null` clears the
  cell while keeping the table slot leased.
- `getCapabilityState(name)` returns the decoded value, or
  `null` for an unknown name or a cleared cell.
- The cell is **membrane-private**. SS code never reads or
  writes it directly. A capability that wants to expose
  derived state to SS code does so through handlers, as usual.
- The cell **survives snapshot/restore** as part of
  `membraneBytes`. A capability that wants to resume from
  prior state reads its cell in `setup` when
  `options.resume === true`.

Owner-only is a convention, not a sandbox boundary: two
capabilities sharing a key already clash at `airlock.declare`,
and nothing structurally stops capability A from calling
`getCapabilityState('B')`. Treat the cell as your own
bookkeeping.

**Pattern — serial counter that must not reuse ids across
restore:**

```js
const COUNTER_KEY = 'fetch.next-request-id';
let nextId = airlock.membrane.getCapabilityState(COUNTER_KEY) ?? 1;

function mintRequestId() {
  const id = nextId++;
  airlock.membrane.setCapabilityState(COUNTER_KEY, nextId);
  return id;
}
```

The counter is read once during `setup` (fresh-boot returns
`null` → seed at `1`; resume returns the persisted high-water
mark) and persisted on every mint. Snapshot bytes carry the
current `nextId`, so the next mint after restore picks up
where the pre-snapshot run left off — freed slot ids are not
reused, even though the snapshot left no other trace of them.

**Storage limits.** Capability state lives in the same value
arena as handle and closure metadata. A full table on `set`
throws `MembraneOutOfSpaceError("Capability state table full:
N slots used. Tune capabilityStateTableCapacity.")` — grow via
`runtime.notifyMemoryRelocated({ newMembraneLayout: {
capabilityStateTableCapacity: ... } })`, matching how the
closure-handle and linked-promise tables are tuned post-hoc.
Overwrite orphans the prior value's arena bytes until the
next `compactMembrane()` reclaims them.

### Dependency resolution

When `Runtime.start()` runs:

1. **Validate** — every `needs` entry's source is checked
   against its declared kind. Missing dependencies throw
   `MissingDependencyError(capabilityName, depKey, depKind, depName)`.
2. **Topologically order** — capabilities with
   `'capability'`-kind needs are ordered after their
   dependencies. Cycles throw
   `CapabilityCycleError(cycle: string[])`.
3. **Invoke `setup`** — in order, with `resolvedContext`
   populated. The setup return value is captured; its
   `exports` (or the whole return value) becomes available
   under the capability's `name` for downstream capabilities.

Setup is **sequential**. The runtime awaits each capability's
setup before starting the next. Parallel setup is rejected
because the resolution graph is the wrong place to discover
concurrency bugs.

---

## Grant fanout

When the airlock fires a grant request for an identifier, the
runtime:

1. Collects every capability's `onGrantRequest` hook (the
   ones returned from `setup`).
2. Invokes all hooks in parallel with the identifier.
3. Counts endorsements (return values that are non-null and
   non-undefined; null/undefined means "no endorsement").
4. Applies single-claim policy:
   - **0 endorsements** → grant denied (returns
     `{ approved: false }`).
   - **1 endorsement** → grant approved with that endorser's
     return value (returns `{ approved: true, grant: ... }`).
   - **≥2 endorsements** → grant denied; the runtime fires
     `onHandlerError` (if registered) with a raw
     `MultipleEndorsementsError` (not wrapped as
     `AttributedRejection` — it has no associated slot). A
     throwing endorser is treated as "no endorsement" and
     fires `onHandlerError` with an `EndorserError` wrapper.

A hook may return a `Promise`; the runtime awaits all returned
Promises before counting.

---

## Lifecycle methods

The runtime exposes a narrow surface for embedder-triggered
operations on the engine and airlock.

### Lifecycle

```js
await runtime.start()
```

Sets up capabilities in dependency order, wires
`airlock.onGrantRequest` (to grant fanout) and
`airlock.onPendingSpawnedContexts` (to the parked-slot drain
path), then enters the inbound loop. Returns a Promise that
resolves when the runtime is fully booted; rejects with
`RuntimeBootError` if setup fails.

```js
await runtime.quiesce()
```

Stop dispatching new work. Wait for any currently-running
slot drive to return from its current tick. Leave parked
slots in their parked state — does NOT wait for them to reach
terminal.

Resolves once the dispatcher is idle. Safe to follow with
host-side snapshot slicing (under host-owned memory the runtime no
longer exposes `takeSnapshot`; the host slices its own buffers),
`notifyMemoryRelocated`, `gc`, or any other operation that needs
the engine quiescent.

The quiesce model is deliberate: snapshot/relocation must
work while drones are parked on long-running streams or slow
host calls. Forcing every parked slot to drain to terminal
before snapshot would block snapshot arbitrarily long. The
parked-set freeze is correct because the parked-state
representation lives in the membrane (which is snapshotted
verbatim) and in JS-side WeakMaps (which are reconstructed on
resume, treating any orphaned promises as rejections per
`airlock.rejectOrphanedLinkedPromises`).

```js
runtime.resume()
```

Re-enable dispatch. Parked slots continue to wake on their
normal signals (the airlock's `pendingSpawnedContexts` queue).
New scheduled work proceeds.

Wakes that raced the quiesce tail are replayed first: a drive
finishing DURING quiesce can hand waiter slots directly to the
dispatcher (bypassing the airlock queue), and dispatching them
while quiesced would lose the wake — the runtime defers them
instead and `resume()` re-dispatches each exactly once. Then
the airlock queue drains, `invokeClosure` calls deferred by
the quiesce window begin, and the closure-call drainer
re-kicks.

```js
await runtime.terminate()
```

Stop dispatch, close the inbound loop, fire every
capability's `onDroneTerminated`. The runtime is unusable
after `terminate()` returns. Channels are not closed by the
runtime — the embedder owns their lifecycle.

### Snapshot

Snapshotting is host-orchestrated. The runtime exposes no
`takeSnapshot` method. The host:

1. Calls `runtime.quiesce()`.
2. Slices its own vat memory (`new Uint8Array(memory.buffer).slice(offset, offset + segmentSize)`) and its own membrane buffer (`new Uint8Array(membraneBuffer).slice(membraneByteOffset, membraneByteOffset + membraneByteLength)`).
3. Calls `runtime.resume()`.

The two byte arrays together are the snapshot. The membrane half
carries every membrane-resident structure: handle and grant tables,
value arena, closure-handle table, linked-promise table,
runtime-state cell, in-flight ledger, and the **capability-state
table** (see "Capability-wide persistent state" in the capability
contract). A capability that wrote to its cell before snapshot
reads the same value back via `getCapabilityState(name)` on the
restored side.

Invocation promises and abort listeners are process-local and do not survive
construction of a new runtime over restored bytes. Every context allocated by
`invokeClosure` or `invokeExport` carries a scalar invocation-root marker in the
vat snapshot. Temporary closure handles created by `invokeExport` carry reserved
runtime metadata in the membrane snapshot, including handles belonging to an
invocation deferred by quiesce before context allocation. An embedder whose
recovery policy does not rebind those invocations must clean them up before
scheduler startup:

```js
const runtime = new Runtime({ ...options, resume: true })
const cancelledCount = runtime.cancelRestoredInvocationRoots()
await runtime.start()
```

`cancelRestoredInvocationRoots()` is valid exactly once on a restored runtime
and only before `start()`. It walks the context table, cancels every marked
`(slot, generation)` through the ordinary context-cancellation primitive, drops
every temporary export handle carrying the reserved runtime metadata, and
returns the context cancellation count. It does not settle vanished JavaScript
promises, drop caller-owned `invokeClosure` handles, cancel unmarked scheduled
or detached contexts, or alter shared heap values. Calling it on a fresh
runtime, after `start()`, or a second time throws.

An invocation deferred by quiesce before context allocation exists only in the
old runtime's `_deferredInvokes` host state. It leaves no snapshot-owned root and
therefore is not included in the cancellation count, but its already-created
temporary `invokeExport` handle is snapshot-owned and is dropped. A same-process
`quiesce()`/`resume()` retains the host state and does not use restored-root
cleanup.

For tests, `src/host-owned-session.js` exports
`snapshotSession(session)` to wrap the slicing, and the
`RuntimeBuilder` test harness's `build()` result includes a
`snapshot()` callable that does the same.

### Memory relocation

```js
runtime.notifyMemoryRelocated({
  segmentBaseOffset,
  membraneByteOffset,
  membraneByteLength,
  newSegmentSize,
  newStringTableSize,
  newMembraneLayout,
})
```

Propagates the move to session and membrane. Pure delegation
to `session.relocate(...)`, `session.resizeSegment(...)` (if
sizes changed), and `session.airlock.membrane.resizeRegions(...)`
(if the membrane sub-region layout changed). Caller must have
quiesced; the runtime does not internally quiesce.

All fields are optional individually. If `newSegmentSize` is
absent, `resizeSegment` is not called. If `newMembraneLayout`
is absent, `resizeRegions` is not called.

### Garbage collection

```js
const result = runtime.gc()
```

Wraps `session.gc()`. Mutating. Embedders drive on their own
schedule. Caller responsible for serializing against
in-flight slot drives (typically via `quiesce()`).

### Membrane compaction

```js
const result = runtime.compactMembrane()
```

Wraps `airlock.compactMembrane()`. Mutating. Embedders drive
when arena fragmentation crosses an embedder-chosen threshold.
Caller responsible for serialization.

### Drive a slot

```js
const result = await runtime.run(slot = 0)
```

Drive a slot through ONE episode, up to and including its next
yield point. The caller is responsible for having parsed code
onto the slot (typically slot 0, the boot context). Dispatches
every `session.run` status, surfaces `AttributedRejection`
through `onHandlerError`, schedules spawned children. Returns
that episode's status object — which is the TERMINAL status
(`'done'`, `'error'`, `'terminated'`) only if the slot reached
one within this episode. A slot that parks (`'suspended'`,
`'await'`) returns with that status instead, same as the
paused/fuel-exhausted case: host-owned execution means the
runtime returns control at every yield point rather than
looping through wakes internally. A caller that needs to observe
the slot's eventual completion across a park must wait or poll
separately — for example,
`runtime.getEngineState(slot).status === 'done'`. A single
awaited `run()` call does not do this for the caller.

Production drones receive work via inbound messages or
scheduled closures, not direct calls to `run()`; the primary
uses are boot-time evaluation and tests.

### Boot a slot without driving it

```js
const result = await runtime.bootOnly(slot = 0)
```

Completes a slot's boot sequence (interpreter attached,
capabilities wired, membrane set up) WITHOUT dispatching a
single instruction of its top-level code — deliberately, not
as a side effect of running out of fuel. Reaches the same
embedder-visible completion side effects as `run()`
(state publish to `SCHEDULER_IDLE`, scheduler-idle
notification), but never
enters `_driveLoop` and never touches fuel accounting. Resolves
`{ status: 'unstarted', error: null }` — a status distinct from
`'paused'` (fuel exhaustion) and `'done'`/`'error'`
(a real drive that ran to a terminal state), because "never
intended to run at all" is not the same event class as either.

Records a `BOOTED_UNSTARTED` ledger entry (claimed and
immediately freed, mirroring `run()`'s own `DRIVING_ROOT`
bookkeeping shape) so `runtime.ledger`/step-ring tooling can
tell "this slot was deliberately never driven" apart from
"this slot has simply never been touched yet." Never increments
`spawnedRuns`/`inFlight` — this is not a drive episode.

Returns `{ status: 'terminated', error: null }` if the runtime
is terminated, or `{ status: 'quiesced', error: null }` if
quiesced — same guard shape as `run()`, without publishing a
state change in either case.

A later `run(slot)` against the same slot dispatches its
top-level code normally; `bootOnly` does not consume or alter
the slot's parsed code in any way, it only skips driving it
once.

### Closure callback scheduling

```js
runtime.scheduleClosureCall(closureHandle, args, { dropOnComplete, callerSlot } = {})
```

Schedule a registered closure as a fresh slot. The runtime
queues the call; an inline drainer (kicked idempotently per
schedule) awaits any embedder-supplied
`extraSchedulerBackpressure` hook, re-checks closure-handle
liveness against the membrane, allocates a slot, and drives
it via the same path as any other slot.

`dropOnComplete: true` frees the closure handle after the
slot terminates. Useful for one-shot callbacks (deferred
listeners that never re-fire).

`callerSlot` (optional) — the SS context slot that scheduled
this call. Surfaces on the `DISPATCHING_CLOSURE` ledger entry
as `contextSlot`. When omitted (typical for JS-side timer
fires or embedder entry points where no SS slot was active),
the ledger entry uses the reserved max-u32 (`0xFFFFFFFF`) "no
slot" sentinel — not slot `0`, which is a real, legitimate
slot id.

Returns nothing.

Natural rate limiting: the in-flight count is bounded by the
context region's capacity. Slots that can't be allocated
because the region is full park the drainer; it resumes when
any slot completes (closure-call or sandscript-spawned).

Calls scheduled while the runtime is quiesced are enqueued
but not dispatched until `resume()`. The drainer's loop also
exits if `quiesce()` flips on mid-drain; `resume()` re-kicks
the drainer to flush queued calls.

```js
await runtime.invokeClosure(closureHandle, args, {
  dropOnComplete,
  callerSlot,
  signal,
} = {})
```

Like `scheduleClosureCall`, but returns a Promise carrying the
closure's return value. Async closures are supported
transparently — the runtime routes the slot's wakes back to
this call across any number of park/wake cycles.

The returned Promise has a total settlement contract: it settles
on EVERY terminal outcome of the slot —

- resolves with the closure's return value on `done`;
- rejects with the script error on an SS-level throw
  (`UncaughtScriptError` path);
- rejects with the drive's error on an `'error'`-status
  terminal: hard OOM (`MemoryPressureError` — memory_pressure
  that persisted across a gc with no progress), a non-fatal gc
  failure, an interpreter-returned error status, or an
  unexpected driver status. The same error object is also
  surfaced through `onHandlerError`; the rejection is what
  lets the CALLER correlate it. The slot is freed and a
  `dropOnComplete` handle dropped in all of these cases;
- rejects with a runtime-terminated error if `terminate()`
  runs while the call is parked, deferred, or mid-drive.

Non-terminal parks do not settle the Promise: `await` /
`suspended` (settles after the wake completes the slot) and
`paused` (fuel exhaustion the embedder declined to refuel —
re-drive the slot with `runtime.run(slot)`, which routes
through the invoke path so the eventual terminal settles this
Promise).

Calls made while quiesced defer the ENTIRE setup — slot
allocation and arg marshal touch SS memory, which a
quiesce-holder (snapshot/relocation) may be moving — and begin
on `resume()`, with liveness/grant checks re-run at that
point.

`signal` is optional on both invocation methods and must be an `AbortSignal`.
Cancellation is cooperative at scheduler boundaries. While quiesced, an abort
is recorded in host state only; `resume()` applies it before any further
SandScript memory mutation. Cancelling an allocated invocation unlinks its
promise waiter, linked-promise correlation, queued wakes, and deferred work
before freeing the exact `(slot, generation)` allocation. Head, middle, and tail
waiter removal preserve the rest of the promise list. Every terminal transition
removes the abort listener exactly once, including success, script failure,
runtime failure, cancellation, and termination.

Invocation contexts carry a snapshot-owned root marker from allocation until
their context is reclaimed. The marker is scalar ownership state, not a traced
heap pointer. It lets a newly restored runtime distinguish orphaned invocation
roots from top-level, scheduled, generator, listener, and detached contexts
before `start()`.

### Named export invocation

```js
await runtime.invokeExport(exportName, argumentRecord, {
  parameterNames: ['firstArgument', 'secondArgument'],
  signal,
})
```

This is the bounded embedder entry point for one top-level exported function.
`argumentRecord` must be a plain JSON-shaped object. `parameterNames` is
explicit embedder metadata: its order defines the positional argument array,
and each entry names the record field to place at that position. SandScript
source parameter spelling is not inspected and is not an embedder ABI.

The runtime validates that the name is exported and its root binding is a
function before allocating a context. It then registers a temporary closure
handle and delegates to `invokeClosure` with one-shot cleanup. The invocation
therefore uses the ordinary scheduler, fresh context allocation, grant capture,
fuel and memory-pressure handling, quiesce deferral, suspension wakes, and
termination behavior.

`signal` is an optional `AbortSignal`. An already-aborted signal rejects before
allocating a context or registering a temporary export handle. A later abort
cancels only this invocation, removes its listener and owned correlations, and
releases its temporary handle and context. Cancellation never terminates the
shared runtime and does not recursively cancel detached work.

Every reusable context is identified by `(slot, generation)`, not by its slot
number alone. Allocation advances the persistent generation before publishing
the new context. Invocation owners, suspension callbacks, promise waiters,
deferred wakes, and queued resumptions retain that identity and validate it
before touching context memory. A late callback for a freed generation is
discarded and reported through the slot-lifecycle stale-settlement event; it
cannot resume, mutate, or free the replacement context occupying the same slot.

Completion accepts only `null`, booleans, finite numbers, strings, arrays, and
plain objects recursively containing those values. Unsupported SandScript heap
types are rejected before structured readback can disguise their source type;
the recursively unmarshalled JavaScript value is checked again for non-finite
numbers and cycles. Failures reject with `ResultMarshallingError`, whose
`path` names the failing result location. Result extraction and validation
finish before the temporary closure handle and invocation context are released.
Script throws and runtime failures remain rejections with their existing error
objects.

An async export and a returned SandScript Promise are execution suspension, not
a successful Promise-valued result: the invocation remains pending until that
Promise settles, then validates its fulfillment value. Arbitrary interactive
input has no entry point on this API. Host capability calls may still suspend
and resume through the ordinary scheduler.

Calls made while quiesced may register the temporary export handle, but defer
context allocation, argument marshalling, and dispatch until `resume()`.

### Host-owned invocation context

```js
await runtime.invokeExport(exportName, argumentRecord, {
  parameterNames,
  signal,
  hostInvocationContext,
})
```

`hostInvocationContext` is an optional opaque value the embedder associates
with one export invocation. Every host capability handler reached from that
invocation's root context reads the exact same value — by JavaScript
identity — from its handler `Context`:

```js
airlock.setHandler(handle, 'operation', ({ args, context }) => {
  const invocation = context.hostInvocationContext; // host-only routing
});
```

The association is host authority. SandScript source cannot observe, copy,
replace, serialize, or forge it: the runtime performs no cloning, traversal,
validation, or serialization, and the value never appears in a snapshot,
state inspection, trace, diagnostic, result, error, source-visible handle,
or membrane record. When the option is omitted — including every
`invokeClosure`, `scheduleClosureCall`, boot, timer, and spawned-child
context — `context.hostInvocationContext` reports `undefined`. The public
`invokeClosure` options are not extended; the export operation is the
attribution entry point.

Resolution is generation-safe. The handler `Context` captures its
`(slot, generation)` identity at dispatch; `hostInvocationContext` resolves
only while exactly that identity is live and owned by a non-terminal
invocation. The value stays available across suspension, linked-promise
waits, fuel refills, and pending-spawned wakes — including inside
`context.suspend` async callbacks, which run outside the handler's
synchronous extent. Every terminal path (result, throw, rejection,
result-marshalling failure, abort, termination, quiesced cancellation,
deferred rejection) clears the association before the slot can be reused
and before the caller's promise settles; a retained stale `Context`
afterwards reports `undefined` and can never resolve to the slot's next
occupant. There is no setter, no inheritance API, no ambient or
process-global fallback, and no automatic transfer to another export
started by a capability handler — a nested child export receives only the
value explicitly supplied when the embedder starts it.

The value is process-local and never persisted. Restored invocation roots
remain subject to `cancelRestoredInvocationRoots()` and cannot recover or
synthesize a host invocation context; capability-specific recovery is the
embedder's responsibility through its own persisted correlation records.

### Host reference contract

```js
await runtime.getClosureProperty(closureHandle, propertyName, options)
await runtime.getObjectProperty(objectHandle, propertyName, options)
await runtime.constructClosure(closureHandle, argumentsList, options)
await runtime.invokeClosureWithReceiver(
  closureHandle, receiverHandle, argumentsList, options)
runtime.releaseClosureHandle(closureHandle)
runtime.releaseObjectHandle(objectHandle)
```

`getClosureProperty` reads one static value or accessor from a captured
class constructor; `getObjectProperty` reads a property from a retained
vat object, walking the SandScript prototype chain. Both apply one
conversion rule: a data function becomes a normal `ClosureHandle`, a
data object becomes an interned `ObjectHandle` (a collector root the
caller must release), an external value becomes a `Handle`, and a
primitive or structured value uses normal marshalling. A static or
instance accessor runs its getter with the class (respectively the
object) as receiver through the ordinary invocation machinery, so
suspension, fuel, and grants behave like any callback.
`getClosureProperty` accepts
`resultConversion: "iterable-string-sequence"`: an `undefined` result
stays `undefined`; any other result must be an array or an object
carrying a SandScript iterator, which the runtime consumes by driven
invocations in the same conversation and converts each element with
JavaScript string conversion. Getter, iterator, and conversion
failures propagate.

`constructClosure` performs ordinary `new` semantics host-initiated:
the receiver is allocated with the closure's `.prototype` (falling
back to `%ObjectPrototype%`), `new.target` is the closure, fields and
body run in the existing order, and constructor return-object rules
apply. It resolves with the interned `ObjectHandle` of the final
object; a result that cannot back an `ObjectHandle` is a construction
error. For an external-backed receiver, settlement always closes
the paired external construction: `completeConstruction` on success,
and `abortConstruction` on every reject path (script throw,
cancellation, termination, or drive failure). An abort failure is
reported as the error with the original failure attached as its cause.
Arrow, async, and generator closures are rejected before a context is
allocated.

When the closure already has a retained `ClosureHandle`,
`beginConstruction(newTarget)` receives that exact wrapper and slot/version.
`constructClosure` associates the wrapper with the context slot and context
generation. The airlock validates the retained handle before the host call.
It removes the association when it frees or cancels the context. Compaction
can relocate the closure pointer without changing the handle identity.
After restore, closure enumeration reifies the persisted slot/version, and a
later construction associates that restored wrapper with its new context.
No public or persisted identity uses a raw closure pointer.

The constructible handler borrows `newTarget`. Construction does not allocate
another closure-handle slot and does not transfer ownership. The
caller must release its retained constructor handle after its last use. The
handler must not release the borrowed argument.

`invokeClosureWithReceiver` accepts an `ObjectHandle` or a
same-session external `Handle` as the receiver and invokes the
captured callback with the referenced vat object or external value as
`this` (`new.target` is `undefined`; arrow callees keep their lexical
bindings). The closure's captured grants and the receiver's authority
are validated before a context is allocated; a primitive receiver,
another session's handle, a stale generation, a released handle, or
revoked grants reject.

Both asynchronous invocation operations accept the existing
`signal` convention and `hostInvocationContext`, which follows the
generation-safe, host-only lifecycle documented above (visible to
airlock handlers reached by that invocation and nowhere else — a
constructible handler can read it during host-initiated construction).

`releaseClosureHandle` / `releaseObjectHandle` drop one host
retention; the collector root disappears when an object handle's
retain count reaches zero. Another session's handle, a stale
generation, an already-released handle, and a retain-count underflow
throw.

Two airlock surfaces complete the contract. A handler registered with
`airlock.setHandler(handle, method, fn, { retainObjectArgumentIndexes:
[index, ...] })` receives each named top-level vat-object argument as
its interned `ObjectHandle` (functions stay `ClosureHandle`s,
primitives stay primitives); the handler must release each retained
argument it does not store. And a handler may RETURN an
`ObjectHandle` or `ClosureHandle` from its session: result marshalling
reifies the referenced `TYPE_OBJECT` / `TYPE_FUNCTION` value by
identity — never a clone — after validating session, version,
liveness, and captured grants.

---

## Stats and diagnostics surface (read-only, curated)

The runtime exposes read access through narrow methods rather
than public getters. The private-after-construction rule
applies to *reads* as well as writes. Adding a new stats
method deliberately expands the public contract; embedders that
need more state should define that requirement with the runtime owner.

```js
runtime.getSchedulerStats(): {
  inFlight:    number,           // root slots currently being driven
  parked:      number,           // slots in airlock.pendingSpawnedContexts,
                                 // i.e. queued for dispatch (NOT the count
                                 // of slots currently parked on a linked
                                 // promise — those live in the membrane
                                 // and aren't surfaced here).
  spawnedRuns: bigint,           // total slot drives since start()
  errors:      bigint,           // total slot terminations with status 'error'
  state:       number,           // current RUNTIME_STATE value
                                 // (JS-realm mirror of runtime.runtimeState.get())
}

runtime.getEngineState(slot = 0): object
  // Wraps session.state(slot). The full diagnostic shape
  // session.state(slot) returns. Lazy getters preserved.

runtime.getMembraneStats(): object
  // Wraps session.airlock.membraneStats().

runtime.getOperationTick(): bigint
  // Wraps membrane.tick().

runtime.captureSlotDiagnostic(slot): object
  // Synchronous, msgpack-friendly plain-object snapshot. A live slot
  // reports slot, tick, instructionIndex, status, exitCondition,
  // activeGrantIds, pendingStackDepth, callStackDepth, grantStackDepth,
  // and scopePointer. An out-of-range or free slot reports
  // { slot, status: 'invalid' }.

runtime.captureMembraneDiagnostic(opts = {}): object
  // Synchronous, msgpack-friendly snapshot containing stats, tick,
  // recentMutations, and finalization: { recent, lifetime }.
  // recentMutationsCap defaults to 64. Supplying perSlotSlot adds
  // perSlotMutations, capped by perSlotCap (default 8).
```

Diagnostic captures complete synchronously, so callers observe the
state at the capture site rather than after deferred work. Their
plain-object schemas are public: adding fields is compatible, while
renaming or removing fields requires a major-version contract change.

---

## Event hooks

Hooks are instance properties; assignment is the registration
mechanism.

```js
runtime.onInboundMessage = (payload, sequenceNumber) => { ... }
```

Required iff the embedder wants to receive inbound. Fired
once per successfully received message. The runtime does no
decoding, no routing, no kind-based dispatch — bytes in.
Embedders own format and dispatch.

If `onInboundMessage` is not registered before `start()`,
`start()` rejects with `RuntimeBootError`.

```js
runtime.onHandlerError = (rejection) => { ... }
```

Optional. Fired with an `AttributedRejection` retrieved via
`airlock.consumeAttributedRejection(slot)` whenever a slot
run yields an error and the airlock has stashed an
attribution for that slot. The runtime consumes (not peeks),
so each attribution surfaces exactly once. If
`onHandlerError` is not registered, the runtime still
consumes — stashes do not accumulate — but drops the value.

The runtime does not introspect the payload, does not own
serialization policy, does not redirect error flow. It is the
seam through which embedder error pipelines plug in.

```js
runtime.composeErrorEnvelope = (runtimeHalf, rejection) => Uint8Array | null
```

Optional. When registered, fired after `onHandlerError` for
each `AttributedRejection`. The runtime assembles a plain
`runtimeHalf` object capturing engine/membrane/runtime state
*at the moment of throw* and hands it to the composer; the
composer returns the bytes to post on the outbound channel (or
`null` to skip the wire emit for this error).

`runtimeHalf` shape:

```js
{
  error:    <plain object from serializeThrownError(rejection.cause)>,
  ss:       <plain object from airlock.captureSlotDiagnostic(slot)>,
  membrane: <plain object from membrane.captureDiagnostic({ relevantSlot: slot })>,
  slot:     <number — rejection.slot>,
  runtime: {
    runtimeState:    <number — runtime.runtimeState.get()>,
    inFlightCount:   <number — runtime.getSchedulerStats().inFlight>,
    ledgerSnapshot:  <array of ledger entries from walk(), or null>,
  },
}
```

The composer is **synchronous**. It runs inside the runtime's
catch site and must return before the runtime posts. This
preserves the at-throw capture property: every read happens at
the moment of throw, not later.

The runtime posts via `outboundChannel.trySend(bytes)`; if the
ring is full, it falls back to `outboundChannel.send(bytes)`
fire-and-forget (the send-await path tags the runtime-state
cell with `OUTBOUND_DRAIN` while awaiting ring capacity).

A composer that throws propagates — same rule as
`onHandlerError`. The embedder owns their callback's
try/catch. A composer that returns a non-`Uint8Array`,
non-`null` value silently skips the wire emit (this is a
return-value check, not error swallow). `onHandlerError`
already fired before the composer ran, so the original error
has a guaranteed signal regardless.

The composer is only invoked for `AttributedRejection`
instances (handler-throw path). Non-attributed errors —
capability resume errors, multiple-endorser errors,
endorser-throw errors — fire `onHandlerError` only.

Errors thrown from `onInboundMessage` are not caught by the
runtime; they propagate out of the inbound loop. Errors thrown
from the closure-call drainer (`runClosureCall`) propagate as
unhandled rejections from its IIFE. Embedders that need those
wrapped should wrap them at their own callback site.

Sandscript does not introduce a `HANDLER_ERROR` message kind,
a numeric tag, or any wire convention. The outbound channel
remains transport-transparent; the composer's returned bytes
land on it verbatim. Embedder framing (kind bytes, routing
headers, msgpack encoding) is the composer's responsibility.

```js
runtime.extraSchedulerBackpressure = async () => { ... }
```

Constructor option AND assignable property — the runtime
reads it indirectly each time, so post-construction
assignment takes effect. If supplied, the closure-call
drainer awaits it before allocating each new slot. Embedder
gates on whatever matters (outbound ring fullness, host
load, etc.).

---

## Scheduler-idle notification

An optional byte-free hook. The runtime calls it at each arrival at
final scheduler idle. The hook reports a lifecycle position. It does
not copy bytes and it does not make any later read coherent.

### Wire-up

```js
const runtime = new Runtime({
  // ... other opts ...
  onSchedulerIdle: () => {
    // Typically a fire-and-forget post on the embedder's wire
    // channel signaling "the scheduler reached idle". One-shot
    // semantics (fire only on first idle) are the embedder's
    // job — set a flag, ignore subsequent fires.
  },
});
```

The constructor validates the option. A non-function value throws
`RuntimeBootError`.

### Call rules

1. The runtime calls the hook after it publishes `SCHEDULER_IDLE`.
2. The runtime calls the hook after the last concurrent drive
   returns — once per arrival at final scheduler idle, never while
   another drive is still in flight.
3. `bootOnly()` calls the hook after its own state publish.
4. `quiesce()` does not call the hook. The final drive under a
   quiesce publishes `QUIESCED` and resolves the quiesce waiters
   instead.
5. `resume()` does not call the hook, even when it publishes
   `SCHEDULER_IDLE`.
6. The runtime supplies no argument and does not await the hook.

Rules 4 and 5 exist because the intended consumer quiesces the
runtime in response to the notification. A notification fired from
the quiesce or resume path would re-trigger that consumer forever.

The hook fires at the two named call sites, not on runtime-state
cell transitions. The state publisher dedupes no-op writes and the
membrane constructs the runtime-state cell as `SCHEDULER_IDLE`, so
`bootOnly()` on a fresh runtime produces no cell edge at all — a
passive cell reader cannot observe that idle arrival. This is the
one deliberate exception to the v5 position that retired
`onParkedStateChange` in favor of passive runtime-state cell reads:
passive reads remain the way to observe state *values*, but the
bootOnly idle arrival has no observable edge, so it needs a hook.

### Coherence

The hook does not promise that the runtime remains idle after the
hook returns. New inbound work can start a drive immediately. An
embedder that needs stable bytes must `quiesce()` the runtime (or
use another complete concurrency protocol), capture, then
`resume()`.

**Must be fast.** The hook runs synchronously in the slot driver's
`.finally()` block. Slow embedder logic blocks the runtime from
serving the next inbound message. The intended use is a single
fire-and-forget operation (channel post, flag toggle, counter
increment), not embedder business logic.

**Throws surface via `onHandlerError`.** A throw from the hook is
wrapped in an `AttributedRejection` with `NO_CALLER_SLOT` and fed
to `onHandlerError`. The state is published before the hook runs,
so a throwing hook never leaves the state as `RUNNING`, never
rejects the drive promise, and never blocks quiesce waiters.

---

## `runtime.runtimeState`

```js
runtime.runtimeState.get(): number
runtime.runtimeState.set(state: number): void   // runtime-internal, embedders read only
runtime.runtimeState.wait(currentState: number, timeoutMs?: number): 'ok' | 'not-equal' | 'timed-out'
```

A view over a 4-byte SAB cell carved out of the membrane buffer
(membrane format v5+). The runtime writes state transitions to
this cell on every `_publishState` call (with no-op dedup);
cross-realm observers read with `Atomics.load` (via `get()`)
or block on transitions with `Atomics.wait` (via `wait()`).

JS-realm callers reading `runtime.getSchedulerStats().state`
get the same value (it's read live from the cell).

The cell is exposed by the `Runtime` constructor; embedders
don't construct it.

---

## `RUNTIME_STATE`

```js
export const RUNTIME_STATE = Object.freeze({
  RUNNING:               0,
  SCHEDULER_IDLE:        1,    // dispatcher between ticks, nothing to do
  INBOUND_LOOP:          2,    // awaiting receive()
  OUTBOUND_DRAIN:        3,    // awaiting send() backpressure
  DRAINING_ROOT_SLOTS:   4,    // awaiting in-flight slots to finish current tick
  GC:                    5,    // running gc() (synchronous, but tracked for telemetry)
  QUIESCED:              6,    // quiesce() completed; resume() not yet called
  // 7..63 reserved for future runtime-level wait sites.
  // Embedders may define their own values from 64 upward.
})
```

The numeric enum stored in `runtime.runtimeState`, mirrored
in the `state` field of `runtime.getSchedulerStats()`. Defined
in `src/membrane/` (the lower layer owns the cell's bytes and
initial value); re-exported from `src/runtime/index.js` for
embedder convenience.

---

## `runtime.ledger`

```js
runtime.ledger.walk(): Array<{
  entryIndex, contextSlot, activity, id1, id2, callId, beganAtTick
}>
runtime.ledger.claim(fields): number   // embedder-defined activities (≥64)
runtime.ledger.free(entryIndex): void  // ditto
runtime.ledger.capacity: number        // 256 by default, configurable — see below
```

A view over a table carved out of the membrane buffer (membrane
format v5+).

### Binary layout

Each entry is 24 bytes: six little-endian u32 words.

| offset | field         | contract |
|--------|---------------|----------|
| `0x00` | `contextSlot` | Context slot associated with the activity. Slot `0` is valid; `0xFFFFFFFF` is the conventional no-slot sentinel. |
| `0x04` | `activity`    | Synchronization field and activity tag. `0` means free, `1`–`63` are runtime-reserved, and `64`–`65535` are embedder-defined. |
| `0x08` | `id1`         | First activity-specific identifier, or `0`. |
| `0x0C` | `id2`         | Second activity-specific identifier, or `0`. |
| `0x10` | `callId`      | Monotonic activity-specific call identifier, or `0`. |
| `0x14` | `beganAtTick` | Low u32 of `performance.now()` captured at claim time, or a caller-supplied value. |

Claim scans for an entry whose `activity` is `0` and reserves it
with an atomic compare-and-exchange before storing the remaining
fields. Freeing zeroes the other five fields before atomically
publishing `activity = 0`. Cross-realm observers use
`Atomics.load`; a racing walk skips a free entry or reports a
claimed entry as observed. Because reservation publishes the
activity before the other fields, those fields may still be zero
or partially updated during a concurrent claim and are reported
as-is.

The entry count is the configurable `ledgerCapacity` session option,
which defaults to 256 and is set at session creation through
`createSession({ ledgerCapacity })` or
`freshSession({ ledgerCapacity })`. Like `costLedgerCapacity`, it is
not resizable later through `resizeRegions`; size it once from the
expected peak simultaneous `DRIVING_ROOT` activity (see "Saturation
contract" below).

The runtime claims entries for its own activities; embedders
extend the table with their own activities in the `≥64`
numeric range.

### Runtime-internal activities

| value | name                  | when claimed                                                                                          |
|-------|-----------------------|-------------------------------------------------------------------------------------------------------|
| 1     | `DRIVING_ROOT`        | The runtime is driving a slot. `contextSlot` is the slot. Freed when the drive resolves or errors. (Activity name kept historical for binary-contract stability; "root" no longer carries semantics in the codebase — every drive uses the same path.) |
| 2     | `DISPATCHING_CLOSURE` | A closure call sits in the dispatch queue. `contextSlot` is `callerSlot` from `scheduleClosureCall`, or `0xFFFFFFFF` if omitted. `id1` is the closure pointer. Freed just before the closure is driven (DRIVING_ROOT then supersedes). |
| 3     | `AWAITING_PROMISE`    | A slot parked on a pending promise (in `airlock.handleAwait`). `contextSlot` is the parked slot. Freed when the slot is woken via `_prepareWaiter`. v1 does not distinguish JS-promise await from SS-peer-slot await; value 4 is reserved for that future split. |
| 5     | `BOOTED_UNSTARTED`    | `runtime.bootOnly(slot)` completed a slot's boot without driving it. `contextSlot` is that slot. Claimed and immediately freed (synchronous, no in-flight window) — the entry exists purely as an observability marker distinguishing "deliberately never driven" from "never touched yet," not as a real activity duration. |

Value `4` is reserved for a future `AWAITING_ASYNC_PEER` split
(see `AWAITING_PROMISE` above). Activity values `6`–`63` are
reserved for future runtime-internal activities. Embedders
define their own activities at values `64`–`65535`.

### Saturation contract

If the ledger is full at the moment of claim, `claim()` returns `-1`
and the runtime surfaces a `LedgerSaturatedError` through
`onHandlerError`. The drive proceeds: saturation is a diagnostic
signal, not a hard failure. It can occur under legitimate concurrency
whenever many contexts become drivable in the same scheduler turn.
The runtime starts one unserialized `_driveSlot` call per slot, so
simultaneous `DRIVING_ROOT` claims can exceed the embedder's count of
logical operations when multiple wakes arrive together.
`LedgerSaturatedError` is tagged `isDiagnosticSignal: true`, allowing
an embedder to route or filter it without matching message text.

A saturation event means only that no entry was free at claim
time; it is not by itself evidence of a leak. Walking
`runtime.ledger.walk()` after the burst and seeing the table
return to empty (or to its prior steady-state size) confirms
entries are freeing normally. Repeated walks indicate a leak only
when entries remain present beyond the expected lifetime of their
activity; compare `beganAtTick` with the activity's normal duration
to distinguish retained work from transient capacity pressure.

If a workload's expected peak concurrent `DRIVING_ROOT` claims
exceeds the default 256, raise `ledgerCapacity` at session creation
rather than treating saturation as a hard failure or a leak.

The ledger is exposed by the `Runtime` constructor; embedders
don't construct it.

---

## Error classes

```js
class MissingDependencyError extends Error {
  capabilityName: string
  depKey:         string
  depKind:        'host-service' | 'subsystem' | 'capability'
  depName:        string
}

class CapabilityCycleError extends Error {
  cycle: string[]  // names of capabilities in the cycle, in order
}

class MultipleEndorsementsError extends Error {
  identifier: string
  endorsers:  string[]  // capability names that endorsed
}

class RuntimeBootError extends Error {
  cause: any  // the underlying problem
  phase: 'validate' | 'order' | 'setup' | 'start'
}
```

Validation errors throw synchronously from `Runtime.start()`.
Per-slot errors flow through `onHandlerError`.

---

## Internal composition — the four free functions

`Runtime` is the only class. The runtime's behavior is
composed from four free functions, each pure
(dependency-injected) and exported so tests can drive them
directly with scripted fakes:

| Function              | What it does                                                    |
|-----------------------|-----------------------------------------------------------------|
| `driveLoop`           | The status-dispatch loop for one slot. One iteration per WASM yield; switches on `session.run` return status; decides continue/park/finish. Called once per active slot via `Runtime._driveSlot` (the lifecycle wrapper that adds in-flight bookkeeping, ledger entries, and quiesce coordination). |
| `runBackgroundDrive`  | Fire-and-forget drive for slots the runtime didn't directly request — sandscript-spawned children (`async_call`, `promise_method`) and parked-slot wakes. After the drive completes: free the slot back to the pool and wake one parked closure-call waiter. |
| `runClosureCall`      | The full lifecycle of one queued closure call: backpressure → liveness check → grant-revocation check → allocate slot (parking on region-full) → bind closure → drive → free slot → maybe drop handle. Called by Runtime's inline closure-call drainer. |
| `runGrantFanout`      | Fan a grant request out to every registered capability endorser; apply single-claim policy (0 → denied, 1 → approved, 2+ → denied + `MultipleEndorsementsError`). Wired to `session.airlock.onGrantRequest`. |

Each function takes its world as parameters — no `this`, no
shared module state. Runtime composes them with bound deps;
embedders normally don't import them; tests do, and the
isolation surface is what the regression tests pin against.

---

## Slot-driver behavior

This section pins down the dispatch loop's semantics so the
implementation (the `driveLoop` free function and the
`Runtime._driveSlot` lifecycle wrapper, both in
`src/runtime/runtime.js`) and the tests in `tests/runtime/`
agree.

### Slot drive

For each slot the runtime drives (from `runtime.run`,
`scheduleClosureCall`, an `async_call` / `promise_method` child,
or a parked-slot wake via `airlock.pendingSpawnedContexts`), the
drive loop is:

1. Call `session.run(slot, fuel)` and read its return.
2. After every `session.run` return, regardless of status,
   check `airlock.consumeAttributedRejection(slot)`. If
   non-null and `onHandlerError` is registered, fire it.
3. Dispatch on `status`:
   - `'done'` — slot reached normal completion. Drain
     `airlock.drainPendingSpawnedContextIdentities()` and re-dispatch
     each drained `(slot, generation)` identity as a fresh background
     root drive. Mark this slot done. Decrement in-flight.
   - `'error'`, `'throw'` — slot terminated with an error.
     Drain spawned, dispatch each, mark done, decrement
     in-flight. `onHandlerError` already fired via step 2 if
     applicable.
   - `'paused'` — slot exhausted its fuel without terminating.
     The runtime re-drives the slot immediately with a fresh
     fuel budget. (Embedders that want to gate on fuel use
     `extraSchedulerBackpressure` for `scheduleClosureCall`.)
   - `'memory_pressure'` — slot wanted to extend the string
     table beyond its capacity. The runtime calls
     `runtime.gc()` and re-drives. If the re-drive yields
     `memory_pressure` again, the slot terminates with
     `RuntimeBootError`-shaped failure surfaced through
     `onHandlerError`. (Memory-pressure recovery is the
     runtime's only auto-GC trigger.)
   - `'await'`, `'suspended'` — slot is parked. Return from
     the drive loop; the slot will resume via the airlock's
     `pendingSpawnedContexts` queue.
   - `'async_call'` — sandscript spawned a child async
     context. Schedule the child (`result.asyncContext`) as a
     fresh background drive. Continue this slot.
   - `'promise_method'` — sandscript spawned `.then` /
     `.catch` / `.finally` handler contexts. Schedule each
     (`result.contexts`) as a fresh background drive. Continue
     this slot.
   - Anything else — unexpected. The runtime fires
     `onHandlerError` if registered (with a generic Error
     wrapped to preserve shape) and treats it as a terminal
     error for the slot.

### Pending spawned contexts (parked slot resumption)

The runtime registers `airlock.onPendingSpawnedContexts`
during `start()`. The hook fires synchronously when sandscript
pushes slots into the queue (e.g., when a linked JS Promise
settles and the airlock wakes a parked drone slot).

The handler:

1. If quiesced, do nothing — the queue stays populated; the
   slots get drained on `resume()`.
2. Otherwise, drain via
   `airlock.drainPendingSpawnedContextIdentities()` and schedule each
   drained `(slot, generation)` identity as a background drive.

### Backpressure and slot allocation

`scheduleClosureCall` is the embedder-facing way to spawn a
new slot for a registered closure. Its flow (implemented by
the inline `runClosureCall` free function plus a per-runtime
queue):

1. Push the call onto an internal queue.
2. The drainer (an inline async IIFE, kicked idempotently
   per `scheduleClosureCall`) reads the queue, one call at
   a time:
   - Await `extraSchedulerBackpressure()` if registered.
   - Verify the closure handle is still live (`airlock.getClosurePointer`
     is the source of truth). If not, drop and continue.
   - Verify captured grants haven't been revoked
     (`airlock.areClosureGrantsActive`). If they have, drop
     and (if `dropOnComplete`) drop the handle.
   - Allocate a context slot; if the context region is full,
     park until a slot frees (any slot — closure-call OR
     sandscript-spawned background drive).
   - Drive the slot.
3. After the slot completes, free the slot back to the pool;
   if `dropOnComplete` was set, drop the closure handle.

Natural rate limit: in-flight ≤ context region capacity. The
queue can grow unbounded; embedders that want to bound it
gate via `extraSchedulerBackpressure`.

### Inbound subscription

`start()` subscribes to the inbound channel via
`onMessage(cb)`. Pseudo-shape:

```
publishState(INBOUND_LOOP)   // deduped publish, never a raw cell write
inboundUnsubscribe = inboundChannel.onMessage((msg) => {
  publishState(RUNNING)
  // Fire-and-forget. Wire ignores any value the callback
  // returns (including Promises), so wire delivers the next
  // message regardless of whether onInboundMessage has settled.
  onInboundMessage(msg.payload, msg.sequenceNumber)
})
```

`terminate()` calls `inboundUnsubscribe()` to stop receiving.
There is no race against a parked `receive()` because there
is no parked `receive()` — wire's `onMessage` model means the
runtime has no pending-Promise to interrupt.

Slot-driver work — slot drives, parked-slot resumes,
closure-call dispatch — happens in microtasks spawned from
within `onInboundMessage` or the `onPendingSpawnedContexts`
hook. The inbound subscription itself does not drive slots
directly.

---

## What the runtime never does

- Imports anything from `~/Code/wire/`. The channel contract
  is structural.
- Imports anything from an embedder. Capabilities are an input.
- Touches `globalThis`, installs realm-level handlers,
  modifies any module-scope state. Multiple `Runtime`
  instances coexist in one worker without interference.
- Auto-decodes inbound messages. Bytes in.
- Auto-routes errors anywhere. The `onHandlerError` hook is
  the seam.
- Schedules automatic GC except for memory-pressure recovery.
- Closes channels. Embedders own channel lifecycle.

---

## Test contract

`tests/runtime/` validates this spec. The full surface is
exercised by an end-to-end test:

```
1. Build a paired-fake-channel runtime against a minimal
   capability that echoes inbound bytes back as outbound.
2. Send N messages, observe N outbound responses.
3. quiesce() — pending work completes.
4. Host-side snapshot — slice memory + membraneBuffer to produce
   { vatBytes, membraneBytes }.
5. Construct a second runtime from those bytes (copy into fresh
   buffers, pass to createSession + new Runtime).
6. resume()-equivalent (the second runtime's start() with
   options.resume = true).
7. Send M more messages, observe M more outbound responses
   from the resumed runtime.
8. terminate() — onDroneTerminated fires on every capability.
```

This single test exercises capability resolution, setup,
inbound/outbound, slot-driver dispatch, snapshot, resume, and
termination. Smaller tests cover individual edge cases
(missing dependency, cycle, multiple endorsers, etc.).

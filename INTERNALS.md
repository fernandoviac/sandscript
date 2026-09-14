# SandScript Internals

This document records durable architecture, security boundaries, and runtime
invariants. Source code, layout constants, and tests remain authoritative for
exact offsets, opcode numbers, and API signatures.

## Language Execution Model

### Declaration order

SandScript currently processes declarations in source order. Function
declarations are not hoisted, and `var` follows the same binding behavior as
`let`. Code must define a binding before reading it. A future declaration-
instantiation cutover is planned separately.

### Exports are metadata

`export` marks named top-level declarations for host discovery. It does not
create a module boundary, restrict global access, or change binding semantics.
The export marker is stored in the AST when inline source is enabled, allowing
`session.exports()` and source reconstruction to survive snapshot/restore.

Supported forms are named `export const`, `export let`, `export function`, and
`export async function`. There is no default export or export-list form.

### Classes and prototypes

Objects carry prototype links. Property reads, `in`, inherited accessors, class
inheritance, `super`, `instanceof`, and `Object.getPrototypeOf` use the in-vat
prototype graph. Prototype traversal is bounded to reject cycles or pathological
chains.

Classes compile to functions, prototype objects, hidden lexical bindings, and
class-link operations. Private members use class-unique hidden keys and remain
non-enumerable. Hidden runtime keys beginning with `@` are excluded from
ordinary enumeration, spread, and JSON serialization.

Host external values never become nodes in the vat prototype graph. A class
extending an external constructor links through an ordinary in-vat surrogate
prototype; property access crosses the membrane only through explicit airlock
operations.

### Generators and async execution

A generator is a parked execution context. Calling a generator allocates the
context without running its body; `next`, `return`, and `throw` resume it.
Generator state lives in managed memory and therefore participates in garbage
collection and snapshotting.

Async functions and async generators also execute in independently scheduled
contexts. Promise settlement and iterator requests wake those contexts through
the host driver. SandScript does not hide this scheduling boundary.

## Host-Owned Execution

The host owns the memory, session, execution loop, and scheduling policy.
SandScript does not implicitly select contexts or run them to completion.

- Fuel is supplied for each run and returned to the host; it is not persistent
  interpreter state.
- Context creation, selection, resumption, and cleanup are host decisions.
- Async calls and promise settlements expose runnable contexts to the host.
- Garbage collection and membrane compaction occur only at valid host-owned
  boundaries.

`Runtime` is a scheduler over constructor-supplied engine and airlock objects.
It does not own interpreter memory. Normal execution does not inspect memory;
step-observability mode performs snapshot/diff work only when explicitly
requested.

`MemoryReader` provides read-only access to live or snapshotted interpreter
memory without a WASM instance. `MemoryImage` extends it with mutation,
allocation, and WASM-dependent operations. Read-only tooling should depend on
`MemoryReader` rather than acquire writer authority.

## Contexts and Scopes

A context is a stable integer identity mapped to a movable heap object. Each
context contains an instruction index, scope pointer, completion state, and four
independently growable contiguous stacks:

- pending values;
- call frames;
- exception handlers;
- active grants.

Contexts share the heap, bytecode, string table, and root scope. Their stack
blocks and context records are traced and relocated by the collector. The
slot-to-pointer table preserves context identity across relocation and grows
with demand.

Scopes are heap objects linked through parent pointers. Multiple contexts may
share a scope chain. Closure creation marks reachable scopes as captured;
uncaptured scopes may be recycled after they become unreachable from active or
parked execution. The root scope exists independently of context 0 and holds
builtins, host declarations, and top-level bindings.

## Grant Authorization

A host handle is authorized when both conditions hold:

1. at least one grant attached to the handle is currently active, either on the
   context grant stack or in the root-grant set; and
2. none of the grants attached to the handle has been revoked.

Activeness is therefore OR-composed, while revocation is AND-enforced. Reusing a
capability across fresh grant blocks remains possible, but any revoked grant
permanently poisons that handle. Restoring access requires minting a new handle,
not attaching another grant to the old one.

A multi-identifier `grant (a, b, c)` statement is one interpreter yield. The
host may resolve its identifiers asynchronously, but the interpreter commits the
result atomically; no partially approved grant stack is observable.

Initial denial is control flow, not an exception: the grant body is skipped and
the optional `denied` arm runs. A direct unauthorized handle call throws
`GrantDeniedError`. If revocation occurs after a grant body starts, an explicit
`denied` arm takes precedence over `try/catch`; without one, denial propagates
through the normal exception path.

Handles returned while external code runs inherit every grant active on the
calling context, not only the grant to which capability code explicitly added
the handle. Nested grants therefore accumulate authority on returned handles;
sibling grant blocks do not.

## Snapshottable Membrane

The membrane stores host handles, grants, closure/object handles, linked
promises, metadata, and their inverse indexes in a `SharedArrayBuffer` separate
from the interpreter's linear-memory segment.

This separation is a security boundary. Interpreter bytecode cannot construct a
pointer into authorization state, so it cannot flip revocation flags, alter a
handle's grant list, or forge slot allocation state. JavaScript-side airlock,
collector, and membrane code may coordinate across both buffers.

Membrane identities are stable slot indexes. Host wrappers carry both slot and
version; reclaiming a slot increments its version so stale wrappers fail rather
than alias a newly allocated entry. Handle and grant slots remain stationary
while auxiliary identifier lists and encoded metadata may be repacked.

Host-facing metadata is msgpack-encoded in the membrane value arena. Execution
mechanics belong in vat memory; host-managed authorization, correlation, and
observability state belong in the membrane.

A complete persisted drone consists of the vat bytes and membrane bytes. The
host owns quiescing, copying, transporting, restoring, and reattaching both
buffers. `src/persisted-format.js` owns the aggregate persisted-format version;
section versions alone do not establish restore compatibility.

### Restore obligations

Snapshots contain bytes, not JavaScript objects or callback functions. Before
resuming a restored drone, the host must:

1. enumerate handles, grants, closure handles, and relevant linked promises;
2. use persisted metadata or declaration names to select setup code;
3. re-register callable implementations, handlers, accessors, inspectors,
   presence probes, deletion callbacks, and constructible hooks;
4. rebuild host listener and routing tables; and
5. resolve or reject orphaned linked promises according to embedder policy.

Missing method registrations fail loudly when invoked. Linked JavaScript
promises cannot themselves survive process migration; the membrane preserves SS
promise identity and parked waiter state so an embedder with durable correlation
data can settle them after restore. Embedders without such recovery should
reject them through the orphaned-promise API.

The membrane's embedder-state cell stores one opaque, msgpack-encoded value for
snapshot-durable host correlation data.

## Membrane Compaction

Membrane liveness is determined from vat reachability, context grant stacks,
root grants, retained closure/object handles, and transitive handle-to-grant and
grant-to-handle edges.

A slot is reclaimed only after no reachable reference remains. Revoked grants
still present on a suspended context's grant stack stay allocated until that
context unwinds. This permits raw grant slot indexes in interpreter stacks
without per-entry version fields.

Heap collection performs regular handle/grant slot reaping while it already has
the vat live set. Full `airlock.compactMembrane()` additionally repacks the
identifier-list pool and metadata arena. Full compaction is host-triggered and
must not run from inside a synchronously executing external handler.

Live slots never move during membrane compaction. Heap closure pointers stored
in membrane entries are roots and are rewritten after vat heap compaction; the
corresponding membrane slot identities remain unchanged.

## External Values and Classes

External values are opaque handle slots checked by the membrane before use.
Exact handlers, getters, and setters take precedence over dynamic member
classification. A member inspector classifies otherwise unknown names as absent,
data, or method without invoking host getters.

External-backed class instances remain ordinary vat objects for own fields,
private state, symbol keys, and inheritance. A miss may be forwarded to the
backing handle only through registered airlock behavior. Such an instance
marshals back to its backing handle after identity, version, and grant checks;
an ordinary vat object marshals by value unless retained through an object
handle.

External construction is transactional. Constructible handles register begin,
complete, and abort hooks. The vat uses an in-vat surrogate for inheritance,
brands the receiver during construction, and completes or aborts the host-side
resource when the most-derived construction settles. Abort duties unwind before
script exception handlers, preventing a catch block from observing an unresolved
construction obligation.

Retained closure and object handles preserve vat identity for host-initiated
calls, construction, receiver binding, and returned object/function values.
Their pointers are collector roots and are forwarded when the heap moves.

## Async External Surfaces

Method handlers are synchronous by default. A Promise returned from a normal
handler becomes an SS Promise. `{ unwrapPromise: true }` instead parks the
calling context and resumes it with the resolved value, making the boundary
appear synchronous to drone code.

Property getters always unwrap Promise or suspension results because property
syntax carries no method-level opt-in. Property setters may complete
synchronously or suspend; assignment resumes with the assigned value. Missing
setters fail rather than silently dropping writes.

Promise-backed suspension and `context.suspend` share linked-promise slots in
the membrane. Settlement wakes the parked context or SS promise waiters through
the normal runnable-context queue. A host must not re-enter a context while its
external operation remains pending.

## Live Code Patching

Persisted code references are instruction indexes, not byte addresses. The
bytecode block is append-only, so existing indexes remain stable when parsing
additional code.

Live patching parses replacement source into a copy of a parked vat, compares
normalized compilation units, appends changed code, and either:

- rebinds a top-level name to a new closure, leaving previously captured
  closures on old code; or
- retargets an existing closure in place when its captured scope satisfies the
  replacement's free-variable requirements.

Active frames, exception targets, and grant targets drain on their old code.
On-stack replacement is unsupported. Patch validation and application occur
transactionally in the copied image; the original bytes are the rollback.
Patches are not portable between divergent vat instances.

## Garbage Collection

The host may collect only at a safepoint: the WAT interpreter must be between
instructions with coherent stacks, and host code must not hold an otherwise
unrooted heap pointer across an allocation or collection.

Safe collection points are boundaries between top-level SandScript API calls. Do
not collect from inside airlock dispatch, marshalling, unmarshalling, or an
external callback. Any new internal collection trigger requires an audit of
JavaScript locals that retain heap pointers across sub-allocation.

Every pointer-bearing value and root must participate in both marking and
forwarding. Roots include context records and stacks, scopes, intrinsic state,
closures retained by the membrane, linked promises, queued msgpack references,
and heap pointers staged in exit request blocks. New value types or request
payloads must extend the canonical collector walkers; reduced type-specific
switches are prohibited.

The committed heap is a gap-free sequence of GC-headered objects. A zero or
malformed header before the heap pointer is corruption, not an end marker.
Collection failure is terminal; execution must not resume on a partially
processed image.

The heap grows upward while bytecode grows downward. Allocating opcodes estimate
their aggregate requirement and check the shared bound before side effects.
Insufficient space yields memory pressure; the runtime collects and retries the
instruction. If collection cannot provide enough space, out-of-memory remains a
host-visible terminal failure rather than a script-catchable exception.

## Error Construction

Interpreter-generated errors carry a pre-interned message and structured
properties in the heap. Caught errors therefore expose useful details without
requiring runtime string construction in WASM. Uncaught errors are translated by
`src/fuel/semantic-errors.js`, which formats those properties into host-side
diagnostics.

Throw helpers distinguish caught from uncaught propagation. Every caller must
honor that result; assuming a throw was caught can retry the failing instruction
indefinitely.

## `MSGPACK_REF`

`TYPE_MSGPACK_REF` is a zero-copy logical view over msgpack bytes stored in a
managed `OBJ.ARRAYBUFFER`. A value slot contains the parent data pointer and an
offset within the payload. The byte length comes from the parent object.

The parent pointer is segment-relative and forwarded by the collector. Derived
references keep the same parent and advance only their payload offset. Bound
methods on msgpack receivers also retain the parent pointer, with flags
identifying it as a data pointer for collector purposes.

Create backing storage through `Airlock.allocateMsgpackBytes` and pass the
returned data pointer to `MsgpackRef`. Headerless heap bytes and absolute host
addresses are invalid representations because neither can survive heap
compaction and relocation.

## Source-of-Truth Map

- Memory layouts and constants: `src/fuel/vat-layout.js`,
  `src/membrane/membrane-layout.js`, and `src/fuel/constants.js`
- Interpreter behavior: `src/fuel/interpreter.wat`
- Parsing and bytecode emission: `src/fuel/parser.js`
- Host boundary and restore protocol: `src/fuel/airlock.js`
- Membrane authorization: `src/membrane/index.js`
- Heap collection: `src/fuel/collector.js`
- Runtime scheduling: `src/runtime/runtime.js`
- Persisted compatibility: `src/persisted-format.js`
- Public surface and current limitations: `README.md`

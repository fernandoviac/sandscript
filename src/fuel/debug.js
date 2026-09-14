// debug-only
/**
 * Interpreter Debug wrapper — operational/forensic observability.
 *
 * `createDebug(session)` attaches a Debug instance to an existing
 * session. The Debug surface owns expensive forensic APIs: state
 * dumps, log reads, inventory walks, and snapshot diffs.
 *
 * Strict production / debug boundary
 * ----------------------------------
 *
 * This file is a DEBUG-ONLY module. Production source files must NOT
 * import it. Automated hygiene checks reject references to `debug.js`
 * or `createDebug` from files that are neither test code nor opted in
 * with a `// debug-only` header comment.
 *
 * Why: the interpreter is the sandboxed, security-critical layer.
 * Production code paths must remain observability-blind. The Debug
 * wrapper is for forensic / postmortem use, not for hot-path code.
 *
 * Lifecycle
 * ---------
 *
 * - createDebug(session) is cheap. No allocation in the engine and no
 *   wiring into host callbacks.
 * - Multiple Debug instances on one session are allowed. They share
 *   the underlying mutation log and counters (which live in the
 *   membrane SAB).
 * - The Debug instance does NOT hold a reference to anything that
 *   would prevent the session from being garbage-collected — it just
 *   holds a reference to the session itself.
 */

import {
  MEMBRANE_MAGIC,
  HEADER as MEMBRANE_HEADER,
  Membrane,
} from '../membrane/index.js';
import { DRONE_FORMAT_VERSION } from '../persisted-format.js';
import {
  STATE,
  HEADER_SIZE,
  CONTEXT_STATUS_FREE,
  hashTableBuckets,
  hashTableSize,
  opcodeToString,
  typeToString,
} from './constants.js';
import { readHeaderEventRing } from './header-event-ring.js';


/**
 * Attach a Debug wrapper to a session.
 *
 * @param {Object} session - A session from createSession().
 * @returns {Object} Debug instance with forensic APIs.
 */
// Pure-function exports: callers can use these without holding a
// Debug instance. Useful for offline forensic analysis where a
// session was never alive in this process.
export { diffSnapshots };

/**
 * dumpStateFromBytes(membraneBytes, vatBytes?, options?)
 *
 * Module-level forensic dump for callers that have only the raw
 * bytes (e.g. a host inspecting a remote worker's slab over a
 * SharedArrayBuffer, or postmortem analysis from a checkpoint
 * file). No session required. Returns the same shape as
 * Debug.dumpState({ contexts: false }) — the contexts section is
 * empty because there's no live MemoryImage to eager-flatten.
 *
 * For a host that has live worker bytes but no session, prefer
 * createDebugFromBytes(...) below — it returns
 * the full Debug surface bound to a forensic membrane (mutation
 * log reads, enumerate*, state getters, etc.). dumpStateFromBytes
 * is the one-shot equivalent.
 */
export function dumpStateFromBytes(membraneBytes, vatBytes, options = {}) {
  const forensicMembrane = forensicMembraneFromBytes(membraneBytes);
  const forensicHeapReader = vatBytes ? makeForensicHeapReader(
    cloneBuffer(vatBytes)) : null;
  return buildDumpState({
    membrane: forensicMembrane,
    forensicHeapReader,
    options,
    forensic: true,
  });
}

/**
 * createDebugFromBytes(membraneBytes, vatBytes?)
 *
 * Convenience constructor for callers that have only raw bytes.
 * Constructs a forensic Membrane from the supplied bytes and
 * binds a Debug instance to it (view-only mode — see createDebug
 * below). The returned Debug supports:
 *   - dumpState / dumpStateFromBytes (the latter delegates to the
 *     module-level export)
 *   - mutationLog, mutationCounters, mutationLogWriteIndex,
 *     mutationLogCapacity (frozen at the byte snapshot)
 *   - engineCounters, tick
 *   - enumerate* + state getters
 *   - findHandle / findGrant / findClosureHandle / findLinkedPromise
 *   - diffSnapshots
 *
 * Methods that need a live session (dumpContexts and eager string
 * inventory) return empty results. Mutation watchers attach to the
 * membrane's JavaScript-side subscriber list; a frozen forensic
 * membrane never mutates, so an installed watcher never fires.
 */
export function createDebugFromBytes(membraneBytes, vatBytes) {
  return createDebug({
    membrane: forensicMembraneFromBytes(membraneBytes),
    forensicHeapReader: vatBytes ? makeForensicHeapReader(
      cloneBuffer(vatBytes)) : null,
  });
}

// Internal: build a forensic Membrane from raw bytes. Shared by
// dumpStateFromBytes, createDebugFromBytes, and Debug.dumpStateFromBytes.
function forensicMembraneFromBytes(membraneBytes) {
  const buf = cloneBuffer(membraneBytes);
  return new Membrane({
    buffer: buf,
    byteOffset: 0,
    byteLength: membraneBytes.byteLength,
    fromBytes: true,
  });
}

function cloneBuffer(bytes) {
  const buf = new ArrayBuffer(bytes.byteLength);
  new Uint8Array(buf).set(bytes);
  return buf;
}

/**
 * createDebug(input)
 *
 * Two input shapes:
 *
 *   1. A session from createSession() — the full live surface.
 *      Mirrors the original contract; existing callers unchanged.
 *
 *   2. A view object { membrane, memoryImage?, session?,
 *      forensicHeapReader? } — used when the caller has a live
 *      Membrane but no full session, such as a host inspecting a
 *      remote worker's SAB-resident membrane. The membrane is
 *      required; everything else is optional.
 *
 * Methods that strictly need a live session degrade gracefully
 * in view-only mode:
 *   - dumpContexts returns [] (no MemoryImage to flatten).
 *   - dumpState's contexts section is empty for the same reason.
 *   - setMutationWatcher / clearMutationWatcher work IF the
 *     membrane is the live one (subscriber list is membrane-side).
 *     They don't work on a frozen forensic membrane — calling
 *     them is allowed but the watcher will never fire.
 */
export function createDebug(input) {
  let session = null;
  let airlock = null;
  let membrane = null;
  let memoryImage = null;
  let forensicHeapReader = null;

  if (input && input.airlock && input.airlock.membrane) {
    // Session shape (live or session-like).
    session = input;
    airlock = input.airlock;
    membrane = input.airlock.membrane;
    memoryImage = input.memoryImage ?? null;
  } else if (input && input.membrane) {
    // View shape: { membrane, memoryImage?, session?, forensicHeapReader? }
    membrane = input.membrane;
    memoryImage = input.memoryImage ?? null;
    session = input.session ?? null;
    airlock = session?.airlock ?? null;
    forensicHeapReader = input.forensicHeapReader ?? null;
  } else {
    throw new TypeError(
      'createDebug: requires a session object from createSession() ' +
      'or a view object { membrane, memoryImage?, session? }');
  }

  // -------------------------------------------------------------------------
  // dumpState
  // -------------------------------------------------------------------------

  function dumpState(options = {}) {
    // In view-only mode (no memoryImage, no session): the dump
    // includes everything the membrane carries, plus the heap
    // section via forensicHeapReader if present. dumpContexts is
    // a no-op (returns []) because there's no live state to walk.
    return buildDumpState({
      membrane,
      memoryImage,
      forensicHeapReader,
      dumpContexts,
      options,
      forensic: session === null,
    });
  }

  /**
   * Eager forensic view of every live context. Resolves all the lazy
   * getters on session.state(slot) into a JSON-serializable shape;
   * one entry per slot.
   *
   * This walks every live context and realizes its lazy state, so
   * hosts should reserve it for postmortem or aggregate inspection,
   * not hot paths.
   *
   * View-only mode: returns [] (no live MemoryImage / session to
   * walk). The dumpState contexts section is empty too.
   */
  function dumpContexts() {
    if (!memoryImage || !session) return [];
    const count = memoryImage.getContextCount();
    const out = [];
    for (let slot = 0; slot < count; slot++) {
      if (memoryImage.getExitCondition(slot) === CONTEXT_STATUS_FREE) continue;
      out.push(eagerStateForSlot(session, slot));
    }
    return out;
  }

  // Instance method — delegates to the module-level export so
  // callers that already hold a Debug get the same shape without
  // a separate import.
  function dumpStateFromBytesInstance(membraneBytes, vatBytes, options = {}) {
    return dumpStateFromBytes(membraneBytes, vatBytes, options);
  }

  // -------------------------------------------------------------------------
  // Reverse lookups.
  //
  // O(N) walks over active inventory. Debug-only because the cost
  // makes them unsuitable for hot paths. Useful for asking whether
  // the runtime holds a given JavaScript object and, if so, at which
  // slot.
  // -------------------------------------------------------------------------

  // -------------------------------------------------------------------------
  // Mutation watchers.
  //
  // One watcher per Debug instance. Setting a new watcher replaces
  // the existing one for THIS Debug; other Debugs on the same
  // session are unaffected. The watcher fires synchronously after
  // every membrane mutation whose KIND matches the kindMask.
  //
  // The watcher is transient state attached to the membrane's
  // JavaScript-side subscriber list. It is NOT persisted across
  // snapshots or shared between Debug instances, even on the same
  // session.
  // -------------------------------------------------------------------------

  // Token returned by membrane._addMutationWatcher; null when no
  // watcher is installed on this Debug instance.
  let mutationWatcherToken = null;

  function setMutationWatcher(kindMask, fn) {
    if (typeof kindMask !== 'number') {
      throw new TypeError('setMutationWatcher: kindMask must be a number');
    }
    if (typeof fn !== 'function') {
      throw new TypeError('setMutationWatcher: fn must be a function');
    }
    // Replace any existing watcher on THIS Debug instance.
    if (mutationWatcherToken !== null) {
      membrane._removeMutationWatcher(mutationWatcherToken);
    }
    mutationWatcherToken = membrane._addMutationWatcher(kindMask, fn);
  }

  function clearMutationWatcher() {
    if (mutationWatcherToken !== null) {
      membrane._removeMutationWatcher(mutationWatcherToken);
      mutationWatcherToken = null;
    }
  }

  function findHandle(impl) {
    // membrane._impls is a JS Map<slot, impl>. Walk it.
    for (const [slot, candidate] of membrane._impls) {
      if (candidate === impl) return slot;
    }
    return null;
  }

  function findGrant(identifier) {
    for (const entry of membrane.enumerateGrants()) {
      if (entry.identifier === identifier) return entry.grant.slot;
    }
    return null;
  }

  function findClosureHandle(closurePointer) {
    for (const entry of membrane.enumerateClosureHandles()) {
      if (entry.closurePointer === closurePointer) return entry.closureHandle.slot;
    }
    return null;
  }

  function findLinkedPromise(ssPromisePointer) {
    for (const entry of membrane.enumerateLinkedPromises()) {
      if (entry.ssPromisePointer === ssPromisePointer) return entry.slot;
    }
    return null;
  }

  // -------------------------------------------------------------------------
  // Bytecode / pending-stack inspection helpers.
  //
  // These debug-only diagnostics inspect interpreter state. All four
  // require a live session/memoryImage and throw in view-only mode.
  // -------------------------------------------------------------------------

  function _requireLiveSession(name) {
    if (!memoryImage) {
      throw new Error(`${name}: requires a live session (view-only Debug doesn't have a WASM instance)`);
    }
  }

  /**
   * Decode the instruction at $index. Returns
   *   { pc, opcode, opcodeName, operand1, operand2 }
   * or null if pc is out of range.
   */
  function readInstruction(pc) {
    _requireLiveSession('readInstruction');
    const wasm = memoryImage.wasm;
    const count = wasm.exports.debug_get_instr_count();
    if (pc < 0 || pc >= count) return null;
    const opcode = wasm.exports.debug_read_opcode(pc);
    const operand1 = wasm.exports.debug_read_operand1(pc);
    const operand2 = wasm.exports.debug_read_operand2(pc);
    return {
      pc,
      opcode,
      opcodeName: opcodeToString(opcode),
      operand1,
      operand2,
    };
  }

  /**
   * Disassemble `count` instructions starting at `start`. Returns an
   * array of strings, one per instruction:
   *   "  pc=42  GET_VAR          op1=0x1234 op2=0"
   * The opcode name is left-padded to 16 chars; operands are shown in
   * hex. Pass count=Infinity (or omit) to read to the end of the
   * bytecode.
   */
  function disassemble(start = 0, count = Infinity) {
    _requireLiveSession('disassemble');
    const total = memoryImage.wasm.exports.debug_get_instr_count();
    const end = Math.min(start + count, total);
    const lines = [];
    for (let pc = start; pc < end; pc++) {
      const instr = readInstruction(pc);
      if (!instr) break;
      const op1 = instr.operand1 ? `op1=0x${instr.operand1.toString(16)}` : 'op1=0';
      const op2 = instr.operand2 ? `op2=0x${instr.operand2.toString(16)}` : 'op2=0';
      lines.push(`  pc=${String(pc).padStart(4)}  ${instr.opcodeName.padEnd(20)} ${op1} ${op2}`);
    }
    return lines;
  }

  /**
   * Dump the full bytecode of the parsed program as a single string,
   * one instruction per line. Marks the PC of the given slot (if any)
   * with a `>` prefix.
   */
  function dumpBytecode(slot = null) {
    _requireLiveSession('dumpBytecode');
    const total = memoryImage.wasm.exports.debug_get_instr_count();
    const markPc = slot !== null ? memoryImage.getContextInstructionIndex(slot) : -1;
    const out = [];
    for (let pc = 0; pc < total; pc++) {
      const instr = readInstruction(pc);
      if (!instr) break;
      const marker = pc === markPc ? '>' : ' ';
      const op1 = `op1=0x${instr.operand1.toString(16).padStart(4, '0')}`;
      const op2 = `op2=0x${instr.operand2.toString(16).padStart(4, '0')}`;
      out.push(`${marker} pc=${String(pc).padStart(4)}  ${instr.opcodeName.padEnd(22)} ${op1} ${op2}`);
    }
    return out.join('\n');
  }

  /**
   * Walk the pending stack of a context slot and return one entry per
   * value: { index, type, typeName, flags, lo, hi, value? }. `value`
   * is the result of readValueAt when available (decoded heap data).
   *
   * Entries are returned from BOTTOM (index 0) to TOP (last). The TOP
   * is the most recently pushed value.
   */
  function dumpPendingStack(slot, options = {}) {
    _requireLiveSession('dumpPendingStack');
    const { decodeValues = false } = options;
    const pendingBase = memoryImage.getPendingStackBase(slot);
    const pendingPointer = memoryImage.getContextPendingPointer(slot);
    const depth = (pendingPointer - pendingBase) / 16;
    const view = memoryImage.view;
    const abs = (addr) => memoryImage.abs(addr);
    const result = [];
    for (let i = 0; i < depth; i++) {
      const at = pendingBase + i * 16;
      const type = view.getUint32(abs(at), true);
      const flags = view.getUint32(abs(at + 4), true);
      const lo = view.getUint32(abs(at + 8), true);
      const hi = view.getUint32(abs(at + 12), true);
      const entry = {
        index: i,
        type,
        typeName: typeToString(type),
        flags,
        lo,
        hi,
      };
      if (decodeValues) {
        try {
          entry.value = memoryImage.readValueAt(at);
        } catch (e) {
          entry.value = `<read failed: ${e.message}>`;
        }
      }
      result.push(entry);
    }
    return result;
  }

  /**
   * Read the header-event ring. It records every write to a global
   * STATE.* field (context-table growth, GC pointer forwarding, or
   * segment resize), every GC-cycle start/end, and every
   * getExitCondition zero-guard fire, together with the call site.
   * Returns { entries, writeHead, capacity }; entries is empty if the
   * session wasn't created with headerEventRingSize.
   */
  function dumpHeaderEventRing() {
    _requireLiveSession('dumpHeaderEventRing');
    return readHeaderEventRing(memoryImage.view, memoryImage.baseOffset);
  }

  // -------------------------------------------------------------------------
  // Convenience accessors — these mirror surfaces on membrane / session
  // so debug consumers don't need to reach through the session object.
  // (The originals stay where they are; this is just delegation.)
  // -------------------------------------------------------------------------

  return {
    dumpState,
    dumpStateFromBytes: dumpStateFromBytesInstance,
    dumpContexts,

    // Interpreter-internal diagnostics.
    readInstruction,
    disassemble,
    dumpBytecode,
    dumpPendingStack,
    dumpHeaderEventRing,

    // Tick + log reads:
    tick: () => membrane.tick(),
    mutationLog: (opts) => membrane.mutationLog(opts),
    mutationCounters: () => membrane.mutationCounters(),
    mutationLogWriteIndex: () => membrane.mutationLogWriteIndex(),
    mutationLogCapacity: () => membrane.mutationLogCapacity(),
    findLastMutationForSlot: (slot, opts) =>
      membrane.findLastMutationForSlot(slot, opts),
    findRecentMutationsForSlot: (slot, opts) =>
      membrane.findRecentMutationsForSlot(slot, opts),

    // FinalizationRegistry recent-fire counter from the membrane,
    // which owns both registries.
    recentFinalizationCount: (opts) => membrane.recentFinalizationCount(opts),
    lifetimeFinalizationFires: () => membrane.lifetimeFinalizationFires(),

    // State getters (production-callable on the membrane; surfaced
    // here for symmetry — Debug consumers don't need to reach
    // through to membrane for these).
    handleState: (slotOrHandle) => membrane.handleState(slotOrHandle),
    grantState: (slotOrGrant) => membrane.grantState(slotOrGrant),
    closureHandleState: (slotOrHandle) => membrane.closureHandleState(slotOrHandle),
    linkedPromiseState: (slot) => membrane.linkedPromiseState(slot),

    // Reverse lookups (debug-only — O(N) walks).
    findHandle,
    findGrant,
    findClosureHandle,
    findLinkedPromise,

    // Mutation watchers (one per Debug instance).
    setMutationWatcher,
    clearMutationWatcher,

    // Snapshot diff (pure function — also exported below as the
    // module-level diffSnapshots for callers who don't have a
    // Debug instance handy).
    diffSnapshots,

    // Expose internals for advanced use. Debug-only code can reach
    // them; the boundary check is at the import level.
    get session() { return session; },
    get membrane() { return membrane; },
    get airlock() { return airlock; },
    get memoryImage() { return memoryImage; },
  };
}

// =============================================================================
// dumpState construction (shared by live and forensic paths)
// =============================================================================

function buildDumpState({
  membrane,
  memoryImage = null,
  forensicHeapReader = null,
  dumpContexts = null,
  options = {},
  forensic = false,
}) {
  // Resolve the "include" flags. The default for a given section is
  // true; passing { heap: false } omits it. Sub-options like
  // log.limit / inventories.includeRevoked nest under their section.
  const includeTick     = options.tick     !== false;
  const includeEngine   = options.engine   !== false;
  const includeHeap     = options.heap     !== false;
  const includeMembrane = options.membrane !== false;
  const includeContexts = options.contexts !== false;
  const includeStrings  = options.strings  !== false;
  const logOpts         = options.log ?? {};
  const inventoryOpts   = options.inventories ?? {};

  const out = { capturedAt: Date.now() };

  if (includeTick) {
    out.tick = membrane.tick();
  }

  if (includeEngine) {
    out.engine = {
      formatVersion: DRONE_FORMAT_VERSION,
      forensic,
    };
  }

  if (includeHeap) {
    out.heap = buildHeapSection({ memoryImage, forensicHeapReader });
  }

  if (includeMembrane) {
    out.membrane = buildMembraneSection({
      membrane,
      logOpts,
      inventoryOpts,
    });
  }

  if (includeContexts) {
    // Eagerly flatten live contexts through dumpContexts. The
    // forensic path (dumpStateFromBytes) has no live memoryImage, so
    // its contexts array is empty.
    out.contexts = dumpContexts ? dumpContexts() : [];
  }

  if (includeStrings) {
    out.strings = {
      inventory: buildStringInventory({ memoryImage, forensicHeapReader }),
    };
  }

  return out;
}

// =============================================================================
// Snapshot diff
//
// Pure function. Accepts either raw snapshot bytes
// ({ vatBytes, membraneBytes, generation? }) or pre-parsed
// dumpState-shaped objects. Returns a structured diff.
// =============================================================================

function diffSnapshots(a, b) {
  const sa = coerceToDump(a);
  const sb = coerceToDump(b);
  return {
    tick:               { from: sa.tick ?? null, to: sb.tick ?? null },
    heap:    diffHeap(sa.heap, sb.heap),
    membrane: diffMembrane(sa.membrane, sb.membrane),
    contexts: diffContexts(sa.contexts ?? [], sb.contexts ?? []),
    strings:  diffStrings(sa.strings, sb.strings),
  };
}

// If `input` is a snapshot byte bundle, build a dumpState from it.
// If it's already a dump, return it. Otherwise throw.
function coerceToDump(input) {
  if (!input || typeof input !== 'object') {
    throw new TypeError('diffSnapshots: input must be a snapshot bytes ' +
      'object or a dumpState object');
  }
  // Heuristic: byte bundles have `membraneBytes`; dump objects have
  // `membrane` and `tick`.
  if (input.membraneBytes !== undefined) {
    // Construct a forensic dump using the same path Debug.dumpStateFromBytes
    // uses (so the shape is identical).
    return buildForensicDumpFromBytes(input.membraneBytes, input.vatBytes);
  }
  if (input.membrane !== undefined) {
    return input;
  }
  throw new TypeError('diffSnapshots: input must contain membraneBytes ' +
    'or be a dumpState object');
}

function buildForensicDumpFromBytes(membraneBytes, vatBytes) {
  const mbuf = new ArrayBuffer(membraneBytes.byteLength);
  new Uint8Array(mbuf).set(membraneBytes);
  const forensicMembrane = new Membrane({
    buffer: mbuf, byteOffset: 0, byteLength: membraneBytes.byteLength,
    fromBytes: true,
  });
  let forensicHeapReader = null;
  if (vatBytes) {
    const hbuf = new ArrayBuffer(vatBytes.byteLength);
    new Uint8Array(hbuf).set(vatBytes);
    forensicHeapReader = makeForensicHeapReader(hbuf);
  }
  return buildDumpState({
    membrane: forensicMembrane,
    forensicHeapReader,
    options: {},
    forensic: true,
  });
}

function diffHeap(ha, hb) {
  // Forensic dumps may have null heap sections (no vatBytes
  // supplied). Surface that explicitly rather than fabricating data.
  if (!ha || !hb) {
    return {
      available: false,
      reason: 'one or both snapshots lack vat bytes',
    };
  }
  const invA = ha.inventory ?? [];
  const invB = hb.inventory ?? [];
  // Match by address (segment-relative pointer). A GC pass between
  // the two snapshots will relocate every live object, so all
  // pointers will appear as added+removed. That's an accurate
  // reflection of what changed — we don't have a forwarding map to
  // pretend otherwise.
  const byAddrA = new Map(invA.map(o => [o.address, o]));
  const byAddrB = new Map(invB.map(o => [o.address, o]));
  const objectsAdded = [];
  const objectsRemoved = [];
  for (const [addr, obj] of byAddrB) {
    if (!byAddrA.has(addr)) objectsAdded.push(obj);
  }
  for (const [addr, obj] of byAddrA) {
    if (!byAddrB.has(addr)) objectsRemoved.push(obj);
  }
  return {
    available: true,
    bytesAllocated:
      Math.max(0, (hb.heapPointer ?? 0) - (ha.heapPointer ?? 0)),
    bytesFreed:
      Math.max(0, (ha.heapPointer ?? 0) - (hb.heapPointer ?? 0)),
    objectsAdded,
    objectsRemoved,
  };
}

function diffMembrane(ma, mb) {
  if (!ma || !mb) {
    return { available: false };
  }
  // Engine counters delta (gc passes between, etc.):
  const ecA = ma.engineCounters ?? {};
  const ecB = mb.engineCounters ?? {};
  const gcPassesBetween = (ecB.gcPassCount ?? 0) - (ecA.gcPassCount ?? 0);

  // Inventory diffs by slot identity. The membrane inventories
  // returned by dumpState may contain wrapper objects (Handle / Grant
  // / ClosureHandle); pull the slot off the wrapper or off the entry
  // directly.
  const handles        = diffByKey(ma.inventories?.handles ?? [],
                                   mb.inventories?.handles ?? [],
                                   handleKey);
  const grants         = diffByKey(ma.inventories?.grants ?? [],
                                   mb.inventories?.grants ?? [],
                                   grantKey);
  const closureHandles = diffByKey(ma.inventories?.closureHandles ?? [],
                                   mb.inventories?.closureHandles ?? [],
                                   closureHandleKey);
  const linkedPromises = diffByKey(ma.inventories?.linkedPromises ?? [],
                                   mb.inventories?.linkedPromises ?? [],
                                   linkedPromiseKey);

  // Log between: take B's log, filter entries whose seq falls in
  // (seqA, seqB]. We compute seqA = max(seq in A's log entries) so
  // we don't depend on a "lastSeq" field that doesn't exist. If A's
  // log was empty, seqA = 0 → returns all of B's log.
  const seqA = maxSeq(ma.log);
  const seqB = maxSeq(mb.log);
  const logBetween = (mb.log ?? []).filter(
    e => e.seq > seqA && e.seq <= seqB);

  return {
    available: true,
    statsBefore: ma.stats ?? null,
    statsAfter:  mb.stats ?? null,
    mutationCountersDelta: diffCounters(ma.mutationCounters, mb.mutationCounters),
    engineCountersDelta:   diffCounters(ma.engineCounters,   mb.engineCounters),
    gcPassesBetween,
    handles,
    grants,
    closureHandles,
    linkedPromises,
    logBetween,
  };
}

function diffByKey(arrA, arrB, keyFn) {
  const ka = new Map();
  for (const x of arrA) {
    const k = keyFn(x);
    if (k !== null) ka.set(k, x);
  }
  const kb = new Map();
  for (const x of arrB) {
    const k = keyFn(x);
    if (k !== null) kb.set(k, x);
  }
  const added = [], removed = [], versionChanged = [];
  for (const [k, x] of kb) {
    if (!ka.has(k)) added.push(x);
  }
  for (const [k, x] of ka) {
    if (!kb.has(k)) removed.push(x);
  }
  // For matched-on-both entries, surface a version change if the
  // version field differs. (Handles/grants/closures all carry a
  // wrapper with .version; reaped entries have a top-level version.)
  for (const [k, before] of ka) {
    const after = kb.get(k);
    if (!after) continue;
    const va = entryVersion(before);
    const vb = entryVersion(after);
    if (va !== null && vb !== null && va !== vb) {
      versionChanged.push({ slot: k, before, after });
    }
  }
  return { added, removed, versionChanged };
}

function handleKey(entry) {
  if (entry.handle) return entry.handle.slot;
  if (entry.slot !== undefined) return entry.slot;
  return null;
}

function grantKey(entry) {
  if (entry.grant) return entry.grant.slot;
  if (entry.slot !== undefined) return entry.slot;
  return null;
}

function closureHandleKey(entry) {
  if (entry.closureHandle) return entry.closureHandle.slot;
  if (entry.slot !== undefined) return entry.slot;
  return null;
}

function linkedPromiseKey(entry) {
  if (entry.slot !== undefined) return entry.slot;
  return null;
}

function entryVersion(entry) {
  if (entry.handle) return entry.handle.version;
  if (entry.grant) return entry.grant.version;
  if (entry.closureHandle) return entry.closureHandle.version;
  if (typeof entry.version === 'number') return entry.version;
  return null;
}

function diffCounters(a = {}, b = {}) {
  const out = {};
  const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
  for (const k of keys) {
    const va = toNumberOrBigInt(a[k]);
    const vb = toNumberOrBigInt(b[k]);
    if (va === null || vb === null) continue;
    if (typeof va === 'bigint' || typeof vb === 'bigint') {
      out[k] = BigInt(vb) - BigInt(va);
    } else {
      out[k] = vb - va;
    }
  }
  return out;
}

function toNumberOrBigInt(v) {
  if (typeof v === 'number') return v;
  if (typeof v === 'bigint') return v;
  return null;
}

function maxSeq(log) {
  if (!log || log.length === 0) return 0;
  let m = 0;
  for (const e of log) if (e.seq > m) m = e.seq;
  return m;
}

function diffContexts(ctxA, ctxB) {
  const byCtxA = new Map(ctxA.map(c => [c.context, c]));
  const byCtxB = new Map(ctxB.map(c => [c.context, c]));
  const added = [], removed = [], statusChanged = [];
  for (const [k, c] of byCtxB) {
    if (!byCtxA.has(k)) added.push(c);
  }
  for (const [k, c] of byCtxA) {
    if (!byCtxB.has(k)) removed.push(c);
  }
  for (const [k, before] of byCtxA) {
    const after = byCtxB.get(k);
    if (!after) continue;
    if (before.exitCondition !== after.exitCondition) {
      statusChanged.push({
        context: k,
        before: before.exitCondition,
        after: after.exitCondition,
      });
    }
  }
  return { added, removed, statusChanged };
}

function diffStrings(sa, sb) {
  if (!sa || !sb) return { available: false };
  const invA = sa.inventory ?? [];
  const invB = sb.inventory ?? [];
  // Match by hash — survives compaction (pointer can change but the
  // hash is content-derived).
  const byHashA = new Map(invA.map(e => [e.hash, e]));
  const byHashB = new Map(invB.map(e => [e.hash, e]));
  const internsAdded = [], internsRemoved = [];
  for (const [h, e] of byHashB) {
    if (!byHashA.has(h)) internsAdded.push(e);
  }
  for (const [h, e] of byHashA) {
    if (!byHashB.has(h)) internsRemoved.push(e);
  }
  return { available: true, internsAdded, internsRemoved };
}

// =============================================================================
// Per-context eager state
// =============================================================================

/**
 * Eager-flatten of session.state(slot). Resolves every lazy getter
 * into an own property so the resulting object is JSON-serializable
 * (modulo the bigint fields the caller already knows about).
 */
function eagerStateForSlot(session, slot) {
  const live = session.state(slot);
  // Plain-data fields are already own properties; the lazy ones
  // (error, scope, pending, callStack, tryStack, strings,
  // instructions, heapObjects) need to be realized.
  return {
    context: live.context,
    instruction: live.instruction,
    instructionCount: live.instructionCount,
    codeBlock: live.codeBlock,
    exitCondition: live.exitCondition,
    status: live.status,
    heapUsed: live.heapUsed,
    heapTotal: live.heapTotal,
    stringTableUsed: live.stringTableUsed,
    stringTableTotal: live.stringTableTotal,
    callStackDepth: live.callStackDepth,
    pendingStackDepth: live.pendingStackDepth,
    tryStackDepth: live.tryStackDepth,
    completionType: live.completionType,
    versions: live.versions,
    regions: live.regions,
    closureHandleCount: live.closureHandleCount,
    // Blocking and scheduling fields:
    blockedOnPromise: live.blockedOnPromise,
    blockedOnGrant: live.blockedOnGrant,
    pendingCall: live.pendingCall,
    lastTickRun: live.lastTickRun,
    blockedOnSlot: live.blockedOnSlot,
    spawnedBy: live.spawnedBy,
    // Realize the lazy getters:
    error: live.error,
    scope: live.scope,
    pending: live.pending,
    callStack: live.callStack,
    tryStack: live.tryStack,
    strings: live.strings,
    instructions: live.instructions,
    heapObjects: live.heapObjects,
  };
}

// =============================================================================
// Heap-side inventories
// =============================================================================

function buildStringInventory({ memoryImage, forensicHeapReader }) {
  // Forensic offline reads can't safely walk the intern table — we
  // need the live memoryImage's helpers for length-prefixed string
  // decode. Return empty for forensic dumps.
  if (forensicHeapReader || !memoryImage) return [];

  const regionSize = memoryImage.getStringEnd() - memoryImage.getStringStart();
  const bucketCount = hashTableBuckets(regionSize);
  const hashTableStart = memoryImage.getStringEnd() - hashTableSize(regionSize);
  const out = [];
  for (let i = 0; i < bucketCount; i++) {
    const bucketAddr = hashTableStart + i * 8;
    const absBucket = memoryImage.abs(bucketAddr);
    const hash = memoryImage.view.getUint32(absBucket, true);
    if (hash === 0) continue;
    const stringOffset = memoryImage.view.getUint32(absBucket + 4, true);
    if (stringOffset === 0) continue;
    const value = memoryImage.readString(stringOffset);
    out.push({
      pointer: stringOffset,
      length: value.length,
      valuePreview: value.length > 64 ? value.slice(0, 64) : value,
      hash,
      bucketIndex: i,
    });
  }
  return out;
}

function buildHeapSection({ memoryImage, forensicHeapReader }) {
  if (forensicHeapReader) {
    // Forensic path: only STATE-region fields are readable from bytes.
    // Heap inventory requires the live MemoryImage (and its WASM
    // module bindings) to walk objects safely; offline bytes don't
    // carry the structural info needed. Return placeholders.
    return forensicHeapReader.readHeapStats();
  }
  if (!memoryImage) {
    return null;
  }
  const v = memoryImage.view;
  const abs = (off) => memoryImage.abs(off);
  return {
    heapPointer:    v.getUint32(abs(STATE.HEAP_POINTER), true),
    heapStart:      v.getUint32(abs(STATE.HEAP_START), true),
    heapEnd:        v.getUint32(abs(STATE.HEAP_END), true),
    segmentSize:    v.getUint32(abs(STATE.SEGMENT_SIZE), true),
    stringPointer:  v.getUint32(abs(STATE.STRING_POINTER), true),
    stringStart:    v.getUint32(abs(STATE.STRING_START), true),
    // The existing non-destructive bump walk returns every allocated
    // object. Distinguishing dead objects from live ones would require
    // running the mark phase, which this pure read deliberately avoids.
    inventory: memoryImage.enumerateHeapObjects(),
    // The heap walker does not expose roots; an empty array preserves
    // the dump shape.
    rootSet: [],
  };
}

function buildMembraneSection({ membrane, logOpts, inventoryOpts }) {
  // mutationLog accepts { limit, kindMask } today. logOpts.since is
  // reserved for the seq-based reader; current API walks newest-first
  // up to limit (default = full ring).
  const log = membrane.mutationLog({
    limit: logOpts.limit,
    kindMask: logOpts.kindMask,
  });
  // Include revoked-but-not-reaped and reaped slots by default so
  // forensic dumps retain full per-table visibility. Callers that
  // need active entries only can pass
  // `inventories: { includeRevoked: false, includeReaped: false }`.
  const includeRevoked = inventoryOpts.includeRevoked ?? true;
  const includeReaped  = inventoryOpts.includeReaped  ?? true;
  const inventoryFlags = { includeRevoked, includeReaped };
  const inventories = {
    handles:        safeEnumerate(() => membrane.enumerateHandles(inventoryFlags)),
    grants:         safeEnumerate(() => membrane.enumerateGrants(inventoryFlags)),
    closureHandles: safeEnumerate(() => membrane.enumerateClosureHandles(inventoryFlags)),
    linkedPromises: safeEnumerate(() => membrane.enumerateLinkedPromises(inventoryFlags)),
  };
  return {
    formatVersion: DRONE_FORMAT_VERSION,
    magic:         MEMBRANE_MAGIC,
    stats:         membrane.stats(),
    mutationCounters: membrane.mutationCounters(),
    // Engine counters track host-observed operations such as GC passes,
    // snapshots, and resizes. They are all zero in a fresh session.
    engineCounters: membrane.engineCounters(),
    log,
    inventories,
  };
}

function safeEnumerate(fn) {
  // The enumerate methods return arrays of objects with class
  // wrappers (Handle, Grant, ClosureHandle) which are not JSON-
  // serializable as classes. dumpState callers either consume
  // structured objects directly, or JSON.stringify and accept that
  // the wrappers serialize as plain `{slot, version}` objects (the
  // own properties survive the round-trip via JSON, the methods/
  // prototypes don't — that's fine for a forensic dump).
  try {
    return fn();
  } catch (_err) {
    return [];
  }
}

// =============================================================================
// Forensic heap reader — minimal DataView over vat snapshot bytes
// that exposes the GC heap region's STATE fields. Doesn't construct
// a MemoryImage (which would try to bind to a WebAssembly.Memory).
// =============================================================================

function makeForensicHeapReader(buffer) {
  const view = new DataView(buffer);
  const baseOffset = 0; // forensic copies snapshot bytes starting at 0
  const abs = (off) => baseOffset + off;
  return {
    readHeapStats() {
      return {
        heapPointer:    view.getUint32(abs(STATE.HEAP_POINTER), true),
        heapStart:      view.getUint32(abs(STATE.HEAP_START), true),
        heapEnd:        view.getUint32(abs(STATE.HEAP_END), true),
        segmentSize:    view.getUint32(abs(STATE.SEGMENT_SIZE), true),
        stringPointer:  view.getUint32(abs(STATE.STRING_POINTER), true),
        stringStart:    view.getUint32(abs(STATE.STRING_START), true),
        inventory: [],
        rootSet: [],
      };
    },
  };
}

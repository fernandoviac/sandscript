/**
 * SandScript Fuel Session API
 *
 * The session owns resources (memory, parser) and provides a convenient API.
 * All execution is delegated to the Airlock, which mediates grant context.
 *
 * The session tracks a "current context" (default context 0) for simple usage.
 * For multi-context scenarios, use the airlock directly with explicit context slots.
 */

import { MemoryImage } from './memory-image.js';
import { Parser } from './parser.js';
import { Collector } from './collector.js';
import { makeExternalSlotObserver } from '../membrane/walker.js';
import {
  getBundledInterpreterModule,
  instantiateSync,
  instantiateFromModule,
} from './interpreter.wasm.js';
import { verifyCodeBlockStackDepth } from './codegen-verify.js';
import { Airlock } from './airlock.js';
import {
  computeGcScratchLayout,
  writeGcScratchBlock,
  writeGcScratchRoots,
  readGcScratchRoots,
} from './gc-scratch-layout.js';

// SS_VERIFY_CODEGEN=1: bytecode stack-depth verification after every
// parse (see codegen-verify.js). Same env-probe pattern as
// SS_VERIFY_COLLECTIONS in collector.js.
function verifyCodegenEnabled() {
  try { return globalThis.Deno?.env?.get('SS_VERIFY_CODEGEN') === '1'; }
  catch { return false; }
}
import {
  TYPE,
  STATE,
  STRING_DATA_START,
  exitConditionToString,
  opcodeToString,
} from './constants.js';
import { translateError, translateParserError, formatError } from './semantic-errors.js';
import { UncaughtScriptError, ParseError } from '../runtime/errors.js';
import { createAstWriter, createNoOpAstWriter, createAstReader } from './ast.js';
import { printNode, printAllRoots } from './ast-printer.js';

// Pending-stack value-type names are derived from the TYPE export so
// newly added types are included automatically rather than being
// omitted from a hand-written subset.
const VALUE_TYPE_NAMES = Object.fromEntries(
  Object.entries(TYPE).map(([name, id]) => [id, name.toLowerCase()]));

/**
 * Attach a SandScript session to host-owned memory.
 *
 * The caller is responsible for memory and buffer lifecycle:
 *
 *   - Vat memory: a `WebAssembly.Memory` already populated with vat
 *     bytes — either freshly laid out via `layoutVat(memory, offset,
 *     opts)` or restored by copying snapshot bytes into the buffer.
 *   - Membrane buffer: an `ArrayBuffer` / `SharedArrayBuffer`
 *     already populated with membrane bytes — either via
 *     `layoutMembrane(buffer, byteOffset, opts)` or by copying a
 *     snapshot.
 *
 * `createSession` does not allocate, lay out, or copy. It attaches a
 * `MemoryImage`, instantiates WASM, runs `init_regions` to seed the
 * WAT-side region globals from STATE, validates the SANDFUEL magic
 * and versions, and constructs an `Airlock` over the membrane
 * buffer. If the vat is freshly laid out (`STATE.ROOT_SCOPE === 0`),
 * the post-layout bootstrap runs (interns builtin names, allocates
 * context 0, creates the root scope, initializes builtins).
 * Otherwise the memory is presumed restored — no bootstrap.
 *
 * @param {Object} options
 * @param {WebAssembly.Memory} options.memory — Vat memory. Mandatory.
 * @param {number} [options.offset=0] — Segment base inside `memory`.
 * @param {number} options.segmentSize — Vat segment extent in bytes.
 *   Mandatory.
 * @param {ArrayBuffer|SharedArrayBuffer} options.membraneBuffer —
 *   Membrane buffer. Mandatory.
 * @param {number} [options.membraneByteOffset=0] — Membrane base
 *   inside `membraneBuffer`.
 * @param {number} options.membraneByteLength — Membrane extent in
 *   bytes. Mandatory.
 * @param {Uint8Array|ArrayBuffer|SharedArrayBuffer} [options.interpreterModuleBytes]
 *   Raw custom interpreter bytes to compile and instantiate.
 * @returns {Object} Session.
 */
export function createSession(options = {}) {
  if ('module' in options) {
    throw new TypeError(
      'createSession: opaque `module` is not supported; pass raw ' +
      '`interpreterModuleBytes` so SandScript can compile the module');
  }
  const {
    memory,
    interpreterModuleBytes = null,
    offset = 0,
    segmentSize,
    membraneBuffer,
    membraneByteOffset = 0,
    membraneByteLength,
  } = options;

  // Which collector runs session.gc() / compactMembrane's mark-only pass:
  //   'wat'          — the default production collector, with
  //                    segment-bounds guards for corrupt images.
  //   'js'           — the differential oracle and debug/forensics
  //                    collector.
  //   'differential' — JS collects the live image; WAT collects a
  //                    pre-collection copy and every output is
  //                    compared.
  // Option wins over the SS_GC_COLLECTOR env var.
  const gcCollector = options.gcCollector
    ?? (() => {
      try { return globalThis.Deno?.env?.get('SS_GC_COLLECTOR') || 'wat'; }
      catch { return 'wat'; }
    })();
  if (!['js', 'wat', 'differential'].includes(gcCollector)) {
    throw new TypeError(
      `createSession: gcCollector must be 'js', 'wat', or 'differential'; got '${gcCollector}'`);
  }

  if (!(memory instanceof WebAssembly.Memory)) {
    throw new TypeError(
      'createSession: `memory` (WebAssembly.Memory) is required. Allocate ' +
      'and lay out the vat with layoutVat before constructing the session.');
  }
  if (typeof segmentSize !== 'number' || segmentSize <= 0) {
    throw new TypeError(
      'createSession: `segmentSize` (positive number) is required.');
  }
  if (!membraneBuffer || typeof membraneBuffer.byteLength !== 'number') {
    throw new TypeError(
      'createSession: `membraneBuffer` (ArrayBuffer or SharedArrayBuffer) ' +
      'is required. Allocate and lay out the membrane with layoutMembrane ' +
      'before constructing the session.');
  }
  if (typeof membraneByteLength !== 'number' || membraneByteLength <= 0) {
    throw new TypeError(
      'createSession: `membraneByteLength` (positive number) is required.');
  }

  const memoryImage = new MemoryImage(memory, offset, segmentSize);

  const wasm = interpreterModuleBytes !== null
    ? instantiateFromModule(
      new WebAssembly.Module(interpreterModuleBytes),
      memoryImage.memory,
    )
    : instantiateFromModule(
      getBundledInterpreterModule(),
      memoryImage.memory,
    );
  memoryImage.setWasmInstance(wasm);

  // Pull the region globals across into the WAT side. STATE was
  // written by layoutVat (fresh) or copied from a snapshot (restore);
  // either way init_regions reads it.
  wasm.exports.init_regions();

  // DIAGNOSTIC (SS_WATCH_PENDING_BASE=1): per-instruction watchpoint on
  // the type word at pending base+0. When it flips to ARRAY while the
  // operand stack is non-empty, the dispatcher drops a sentinel entry
  // (pc 0xFEFE) into the step ring — the instruction BEFORE the
  // sentinel is the writer. Console-host callee-stomp hunt, 2026-07-02.
  try {
    if (globalThis.Deno?.env?.get('SS_WATCH_PENDING_BASE') === '1'
        && typeof wasm.exports.watch_pending_base_enable === 'function') {
      wasm.exports.watch_pending_base_enable();
    }
  } catch { /* env access denied — watch stays off */ }

  // Strict operand-stack mode is ON BY DEFAULT: a NORMAL-execution pop
  // at base is a fatal ERR_STACK_UNDERFLOW trap (see $pending_pop's
  // tripwire comment). SS_STRICT_STACK=0 is the escape hatch; the
  // underflow COUNTER (wasm.exports.stack_underflow_count) is always live.
  try {
    if (globalThis.Deno?.env?.get('SS_STRICT_STACK') === '0'
        && typeof wasm.exports.strict_stack_disable === 'function') {
      wasm.exports.strict_stack_disable();
    }
  } catch { /* env access denied — strict stays on */ }

  // Sanity-check what the host handed us. Hard-cutover versioning —
  // any prior format trips here.
  memoryImage.validateMagic();
  memoryImage.validateVersions();

  // Decide fresh vs already-bootstrapped from the memory itself.
  // STATE.ROOT_SCOPE is 0 after layoutVat (root scope is allocated
  // by bootstrap); non-zero after a snapshot is copied in. No
  // host-supplied flag.
  const freshlyLaidOut = memoryImage.getRootScope() === 0;
  if (freshlyLaidOut) {
    memoryImage.bootstrap();
  }

  // AST region presence is encoded in STATE.AST_REGION_SIZE — caller
  // passed astRegionSize > 0 to layoutVat, the writer wires up.
  // initialize() is idempotent: on a fresh region it writes the
  // dialect/format_version header; on a restored region it validates
  // those fields match this writer's dialect + version, throwing on
  // mismatch.
  const inlineSource = memoryImage.getAstRegionSize() > 0;
  const astWriter = inlineSource ? createAstWriter(memoryImage) : createNoOpAstWriter();
  if (inlineSource) {
    astWriter.initialize();
  }
  const parser = new Parser(memoryImage, astWriter);

  // Rebuild the authoritative export map from the persisted AST (v4
  // FN_EXPORTED / VAR_EXPORTED flags). On a fresh region there are no
  // roots and this is a no-op; on a restored region it recovers what a
  // fresh parser cannot know, so invokeExport survives snapshot/restore,
  // patch swaps, and detached respawns. Export flags are only ever
  // written by top-level export declarations, so a one-level walk of
  // each root's statement block is the complete surface. Without
  // inlineSource no program metadata persists at all — restored
  // non-inline sessions have no exports, same as they have no source.
  if (inlineSource) {
    const reader = createAstReader(memoryImage);
    for (const rootOffset of reader.iterateRoots()) {
      const root = reader.readNode(rootOffset);
      const block = reader.readNode(root.body);
      for (const statementOffset of block.statements) {
        const statement = reader.readNode(statementOffset);
        if (statement.type === 'FUNCTION_DECL' && statement.isExported) {
          parser.exports.set(statement.name, { type: 'function' });
        } else if (statement.type === 'CLASS_DECL' && statement.isExported) {
          parser.exports.set(statement.name, { type: 'class' });
        } else if (statement.type === 'VARIABLE_DECL' && statement.isExported) {
          for (const bindingOffset of statement.bindings) {
            const binding = reader.readNode(bindingOffset);
            parser.exports.set(binding.name, { type: statement.isConst ? 'const' : 'let' });
          }
        }
      }
    }
  }

  // Attach the membrane to the host-supplied buffer. The Membrane
  // constructor validates magic + version against the bytes the host
  // populated (via layoutMembrane on fresh init, or by copying a
  // snapshot).
  const airlock = new Airlock(memoryImage, wasm, {
    buffer: membraneBuffer,
    byteOffset: membraneByteOffset,
    byteLength: membraneByteLength,
  });


  const collector = new Collector(memoryImage);
  airlock.setCollector(collector);
  // Self-heal hook for linked-promise settle marshals: a settle has no
  // owning context slot to route memory_pressure through, so the
  // airlock runs the session gc directly and retries (see
  // Airlock.setHeapGarbageCollect). `gc` is the function declared in
  // the Garbage Collection section below (hoisted).
  airlock.setHeapGarbageCollect(gc);

  // No automatic post-restore orphan handling. The embedder owns the
  // decision: enumerate linked promises, correlate against its own
  // persisted state, and settle/reject as appropriate. Embedders with
  // no correlation state call airlock.rejectOrphanedLinkedPromises()
  // themselves to recover today's blanket-reject behavior.

  // ===========================================================================
  // State Inspection Helpers
  // ===========================================================================

  // Resolve the scope to inspect for a slot. A freed slot (zeroed slot→pointer
  // table entry) has no context state — but its top-level bindings live on in
  // the ROOT scope (the program completes; its globals persist for listeners),
  // so inspection falls back there. The old behavior read the scope pointer
  // out of the freed slot's RECLAIMABLE state block — undefined bytes after
  // the first collection.
  function inspectionScope(slot) {
    if (memoryImage.getContextBase(slot) === 0) return memoryImage.getRootScope();
    return memoryImage.getContextScope(slot);
  }

  function getAllVariables(slot) {
    const result = {};
    let scopePointer = inspectionScope(slot);

    while (scopePointer !== 0) {
      const absPointer = memoryImage.abs(scopePointer);
      const count = memoryImage.view.getUint32(absPointer + 4, true);
      const entriesPointer = memoryImage.view.getUint32(absPointer + 12, true);

      const entryDataStart = entriesPointer + 8;

      for (let i = 0; i < count; i++) {
        const entryOffset = entryDataStart + i * 20;
        const absEntryPointer = memoryImage.abs(entryOffset);
        const nameOffset = memoryImage.view.getUint32(absEntryPointer, true);
        const name = memoryImage.readString(nameOffset);

        if (name in result) continue;

        const valuePointer = entryOffset + 4;
        const value = memoryImage.readValueAt(valuePointer, { unwrapRational: true });
        result[name] = value;
      }

      scopePointer = memoryImage.view.getUint32(absPointer, true);
    }

    return result;
  }

  function getPendingStack(slot) {
    const result = [];
    const pendingBase = memoryImage.getPendingStackBase(slot);
    const pendingPointer = memoryImage.getContextPendingPointer(slot);
    const depth = (pendingPointer - pendingBase) / 16;

    for (let i = 0; i < depth; i++) {
      const ptr = pendingBase + i * 16;
      const type = memoryImage.getValueType(ptr);
      const value = memoryImage.readValueAt(ptr, { unwrapRational: true });

      result.push({
        type: VALUE_TYPE_NAMES[type] ?? `type_${type}`,
        value,
      });
    }

    return result;
  }

  function getVariable(slot, name) {
    const scope = inspectionScope(slot);
    const nameOffset = memoryImage.internString(name);
    const valuePointer = memoryImage.scopeLookup(scope, nameOffset);
    if (!valuePointer) {
      return undefined;
    }
    // JS-surface unwrap: integer-valued Rationals in i32 range come back as
    // plain JS Numbers so legacy consumers reading integer literals see
    // integers, not structured objects. getExact bypasses this.
    return memoryImage.readValueAt(valuePointer, { unwrapRational: true });
  }

  function listVars(slot) {
    const allVars = getAllVariables(slot);
    const builtins = new Set([
      // Core
      'Math', 'Object', 'Array', 'String', 'Number', 'Boolean', 'Function',
      'JSON', 'undefined', 'NaN', 'Infinity',
      // Errors
      'Error', 'TypeError', 'ReferenceError', 'RangeError', 'SyntaxError',
      // Global functions
      'parseInt', 'parseFloat', 'isNaN', 'isFinite', 'btoa', 'atob',
      // Binary data
      'ArrayBuffer', 'DataView',
      'Int8Array', 'Uint8Array', 'Uint8ClampedArray',
      'Int16Array', 'Uint16Array',
      'Int32Array', 'Uint32Array',
      'Float32Array', 'Float64Array',
      // Text codecs
      'TextEncoder', 'TextDecoder',
    ]);
    const result = [];
    for (const name of Object.keys(allVars)) {
      if (!builtins.has(name)) {
        result.push(name);
      }
    }
    return result;
  }

  // ===========================================================================
  // Garbage Collection
  // ===========================================================================

  // ---- WAT collector plumbing ----

  // The collector's scratch block lives OUTSIDE every vat segment and
  // is never snapshotted. Placement, in priority order:
  //   1. options.gcScratchOffset — the host owns placement (required
  //      for multi-vat memories with a fixed maximum).
  //   2. Pages claimed by growing the memory — multi-vat safe (fresh
  //      pages belong to nobody). Cached; re-claimed only if a later
  //      collection needs a bigger block.
  //   3. Fixed-maximum memory that cannot grow: the tail of the
  //      existing envelope. Correct only when this session owns the
  //      whole memory (the host-owned-session single-vat shape);
  //      recomputed per collection because the segment may grow into
  //      the envelope (resizeSegment), and guarded against overlap.
  let gcScratch = null; // { base, byteLength } — the grow-claimed kind only
  let gcPoisoned = null;

  function reserveGcScratch(byteLength) {
    if (options.gcScratchOffset !== undefined) {
      const base = options.gcScratchOffset;
      if (base + byteLength > memoryImage.buffer.byteLength) {
        throw new Error(
          `gc scratch: gcScratchOffset ${base} + ${byteLength} bytes exceeds ` +
          `the memory (${memoryImage.buffer.byteLength}).`);
      }
      return base;
    }
    if (gcScratch !== null && gcScratch.byteLength >= byteLength) {
      return gcScratch.base;
    }
    const pagesNeeded = Math.ceil(byteLength / 65536);
    try {
      const base = memoryImage.buffer.byteLength;
      memoryImage.memory.grow(pagesNeeded);
      memoryImage._refreshViews();
      gcScratch = { base, byteLength: pagesNeeded * 65536 };
      return base;
    } catch (growError) {
      const base = (memoryImage.buffer.byteLength - byteLength) & ~7;
      if (base < offset + memoryImage.segmentSize) {
        // Preserve the actual grow failure. Exhausting the memory's
        // configured maximum requires the host to budget more pages
        // for scratch, whereas a genuinely fixed maximum may permit
        // the envelope-tail fallback. Hiding the grow error makes
        // these distinct recovery paths indistinguishable.
        throw new Error(
          `gc scratch: the memory cannot grow by the ${pagesNeeded} pages the ` +
          `${byteLength}-byte scratch block needs ` +
          `(${memoryImage.buffer.byteLength / 65536} pages allocated; grow threw: ` +
          `${growError.message}), and the envelope tail ` +
          `(${memoryImage.buffer.byteLength - (offset + memoryImage.segmentSize)} ` +
          `bytes past the segment) cannot hold it. Raise the memory's maximum ` +
          `(the host must budget gc scratch past the segment — see ` +
          `computeGcScratchLayout) or pass gcScratchOffset.`);
      }
      return base;
    }
  }

  function gcScratchLayout(rootCount) {
    return computeGcScratchLayout({
      stringTableSize: memoryImage.segmentSize - memoryImage.getStringStart(),
      astRegionSize: memoryImage.getAstRegionSize(),
      handleTableCapacity: airlock.membrane.getHandleTableCapacity(),
      rootCapacity: Math.max(rootCount, 16),
    });
  }

  // Both WAT failure channels (stamp + trap, or a nonzero status)
  // funnel here: decode the [code][detail][phase] stamp, poison the
  // session, throw the same FatalCollectionError contract the JS
  // collector's poisoning uses.
  function gcWatFailure(cause) {
    const { code, detail } = memoryImage.getErrorInfo();
    const phase = memoryImage.view.getUint32(
      memoryImage.abs(memoryImage.getErrorInfoBase()) + 8, true);
    const fatal = new Error(
      `gc_collect failed (code 0x${code.toString(16)}, detail ${detail}, ` +
      `phase ${phase}): the image is now poisoned and must not be used` +
      (cause ? `: ${cause.message}` : ''),
      cause ? { cause } : undefined);
    fatal.name = 'FatalCollectionError';
    fatal.fatalCollection = true;
    gcPoisoned = fatal;
    return fatal;
  }

  function decodeHandleBitmap(bufferBytes, scratchBase, layout) {
    const { handleBitmap } = layout.sections;
    const slots = new Set();
    for (let slot = 0; slot < handleBitmap.capacity; slot++) {
      if ((bufferBytes[scratchBase + handleBitmap.offset + (slot >> 3)] >> (slot & 7)) & 1) {
        slots.add(slot);
      }
    }
    return slots;
  }

  // Run the WAT collector on the LIVE image. mode 0 = full collection,
  // mode 1 = mark-only (compactMembrane's liveness pass).
  function runWatCollect(mode, externalRoots) {
    if (gcPoisoned) {
      const refusal = new Error(
        `gc_collect: the image is poisoned by an earlier failed collection ` +
        `(${gcPoisoned.message}); the vat must be torn down and restored ` +
        `from persistence`);
      refusal.name = 'FatalCollectionError';
      refusal.fatalCollection = true;
      throw refusal;
    }
    const layout = gcScratchLayout(externalRoots.length);
    const scratchBase = reserveGcScratch(layout.byteLength);
    writeGcScratchBlock(memoryImage.buffer, scratchBase, layout);
    writeGcScratchRoots(memoryImage.buffer, scratchBase, layout, externalRoots);

    const heapStart = memoryImage.getHeapStart();
    const heapBefore = memoryImage.getHeapPointer();
    const stringBefore = memoryImage.getStringPointer();
    const stringDataStart = memoryImage.getStringStart() + STRING_DATA_START;

    let status;
    try {
      status = memoryImage.wasm.exports.gc_collect(scratchBase, mode);
    } catch (trapError) {
      throw gcWatFailure(trapError);
    }
    if (status !== 0) {
      throw gcWatFailure(null);
    }

    const forwardedRoots = readGcScratchRoots(memoryImage.buffer, scratchBase, layout);
    const forwarding = new Map();
    for (let i = 0; i < externalRoots.length; i++) {
      if (forwardedRoots[i] !== externalRoots[i]) {
        forwarding.set(externalRoots[i], forwardedRoots[i]);
      }
    }
    const liveHandleSlots = decodeHandleBitmap(memoryImage.u8, scratchBase, layout);
    const stats = mode === 1 ? null : {
      heapRetained: memoryImage.getHeapPointer() - heapStart,
      heapCollected: heapBefore - memoryImage.getHeapPointer(),
      stringsRetained: memoryImage.getStringPointer() - stringDataStart,
      stringsCollected: stringBefore - memoryImage.getStringPointer(),
      forwarding,
    };
    return { stats, forwarding, liveHandleSlots };
  }

  // Differential soak (gcCollector: 'differential' / SS_GC_COLLECTOR):
  // the JS collector already collected the live image; run the WAT
  // collector on the pre-collection copy in a scratch memory and
  // compare EVERYTHING — full segment bytes, forwarded roots, live
  // handle sets, stats. A divergence throws loudly; the live image is
  // fine (the JS result stands), so this does not poison.
  function runGcDifferentialCheck(preBytes, externalRoots, jsResult, jsLiveHandleSlots) {
    const layout = gcScratchLayout(externalRoots.length);
    const scratchBase = (preBytes.byteLength + 7) & ~7;
    const pages = Math.ceil((scratchBase + layout.byteLength) / 65536);
    const copyMemory = new WebAssembly.Memory({ initial: pages, maximum: 16384, shared: true });
    new Uint8Array(copyMemory.buffer).set(preBytes, 0);
    const copyWasm = instantiateSync(copyMemory);
    copyWasm.exports.init_regions();
    writeGcScratchBlock(copyMemory.buffer, scratchBase, layout);
    writeGcScratchRoots(copyMemory.buffer, scratchBase, layout, externalRoots);

    const diverge = (what) => {
      const error = new Error(
        `GC differential divergence (${what}): the WAT collector disagrees ` +
        `with the JS collector on this image. The live (JS) result stands; ` +
        `capture the pre-collection bytes and reproduce with the ` +
        `differential harness.`);
      error.name = 'GcDifferentialDivergence';
      throw error;
    };

    let watStatus;
    try {
      watStatus = copyWasm.exports.gc_collect(scratchBase, 0);
    } catch (trapError) {
      diverge(`WAT trapped: ${trapError.message}`);
    }
    if (watStatus !== 0) diverge(`WAT status ${watStatus}`);

    const copyBytes = new Uint8Array(copyMemory.buffer);
    const liveAbs = memoryImage.abs(0);
    for (let i = 0; i < preBytes.byteLength; i++) {
      if (copyBytes[i] !== memoryImage.u8[liveAbs + i]) {
        diverge(`segment byte ${i}: WAT ${copyBytes[i]} vs JS ${memoryImage.u8[liveAbs + i]}`);
      }
    }
    const forwardedRoots = readGcScratchRoots(copyMemory.buffer, scratchBase, layout);
    for (let i = 0; i < externalRoots.length; i++) {
      const jsForwarded = jsResult.forwarding.get(externalRoots[i]) ?? externalRoots[i];
      if (forwardedRoots[i] !== jsForwarded) {
        diverge(`root ${i}: WAT ${forwardedRoots[i]} vs JS ${jsForwarded}`);
      }
    }
    const watSlots = decodeHandleBitmap(copyBytes, scratchBase, layout);
    if (watSlots.size !== jsLiveHandleSlots.size
        || [...jsLiveHandleSlots].some((slot) => !watSlots.has(slot))) {
      diverge(`live handle sets: WAT ${[...watSlots]} vs JS ${[...jsLiveHandleSlots]}`);
    }
  }

  // compactMembrane's mark-only liveness pass routes through the same
  // collector selection (decided design item 7 — one liveness
  // implementation in production, not two).
  if (gcCollector === 'wat') {
    airlock.setLiveHandleSlotsProvider(
      () => runWatCollect(1, airlock.getClosureRoots()).liveHandleSlots);
  } else if (gcCollector === 'differential') {
    airlock.setLiveHandleSlotsProvider((walker) => {
      const jsSlots = walker.collectLiveHandleSlots();
      const watSlots = runWatCollect(1, airlock.getClosureRoots()).liveHandleSlots;
      if (watSlots.size !== jsSlots.size
          || [...jsSlots].some((slot) => !watSlots.has(slot))) {
        const error = new Error(
          `GC differential divergence (mark-only live handle sets): ` +
          `WAT ${[...watSlots]} vs JS ${[...jsSlots]}`);
        error.name = 'GcDifferentialDivergence';
        throw error;
      }
      return jsSlots;
    });
  }

  function gc() {
    // Bump the operation tick BEFORE running GC so any log entries
    // produced by GC reaping (compact-driven _freeHandleSlot /
    // _freeGrantSlot) get the new tick. The tick lives in the
    // membrane header — the interpreter never sees it.
    airlock.membrane.bumpTick();

    const externalRoots = airlock.getClosureRoots();

    // JS-held MsgpackRefs awaiting marshal (the runtime's closure queue)
    // have no SS-heap reference yet. Union their blob HEADER pointers
    // into the external roots so collection cannot reclaim a blob while
    // a queued ref still holds its raw parentDataPointer. collect() keeps
    // the blobs alive and reports their forwarding, then each ref is
    // rewritten after the pass. GC_HEADER_SIZE = 8: MsgpackRef carries
    // the blob's DATA pointer.
    const inFlightRefs = airlock.hooks.inFlightMsgpackRefs
      ? airlock.hooks.inFlightMsgpackRefs()
      : [];
    for (const ref of inFlightRefs) {
      externalRoots.push(ref.parentDataPointer - 8);
    }

    // Single-pass membrane handle/grant reclamation.
    // The full mark phase over the heap records every reachable
    // TYPE.EXTERNAL slot — the heap-reachable handle set the membrane
    // compactor needs (observer on the JS path, the handle bitmap on
    // the WAT path). The only thing the membrane needs beyond this set
    // is the non-heap roots (grant stacks, captured grants, root
    // grants), which compactMembraneFromLiveHandleSlots() computes
    // from the SAB.
    let gcResult;
    let liveHandleSlots;
    if (gcCollector === 'wat') {
      const wat = runWatCollect(0, externalRoots);
      gcResult = wat.stats;
      liveHandleSlots = wat.liveHandleSlots;
    } else {
      // 'js' and 'differential' both collect the LIVE image with the
      // JS collector; differential mode additionally runs the WAT
      // collector on a pre-collection copy and compares every output.
      const preBytes = gcCollector === 'differential'
        ? memoryImage.u8.slice(memoryImage.abs(0), memoryImage.abs(memoryImage.segmentSize))
        : null;
      // collect() sets/clears externalRoots itself but never touches
      // valueObserver, so installing it around the call is safe;
      // cleared in finally so a throw in compaction can't leave a
      // stale observer wired.
      liveHandleSlots = new Set();
      collector.valueObserver = makeExternalSlotObserver(liveHandleSlots);
      try {
        gcResult = collector.collect(externalRoots.slice());
      } finally {
        collector.valueObserver = null;
      }
      if (preBytes !== null) {
        runGcDifferentialCheck(preBytes, externalRoots, gcResult, liveHandleSlots);
      }
    }

    if (gcResult.forwarding) {
      airlock.updateClosurePointers(gcResult.forwarding);
      for (const ref of inFlightRefs) {
        const newHeader = gcResult.forwarding.get(ref.parentDataPointer - 8);
        if (newHeader !== undefined) {
          ref.parentDataPointer = newHeader + 8;
        }
      }
    }

    // Free membrane handle/grant slots unreachable from this pass's live set.
    // Handle slots are stable integer indices into the handle table — they do
    // NOT move when collect() relocates heap bytes — so this is order-
    // independent w.r.t. the heap forwarding fixup above.
    const membraneStats = airlock.compactMembraneFromLiveHandleSlots(liveHandleSlots);

    // Clear the memory-pressure flag: after a successful compact, the
    // table has room again (or doesn't — the next intern attempt will
    // re-signal if not). Without this, host calls between gc() and the
    // next run() (e.g. session.get for inspection) would spuriously
    // throw "String table full" on the stale flag.
    memoryImage.wasm.exports.clear_memory_pressure();

    // Record the GC pass in the membrane's engine counters.
    // heapCollected is the bytes reclaimed by this pass, so no
    // interpreter instrumentation is needed.
    airlock.membrane.recordGcPass(
      airlock.membrane.tick(),
      gcResult.heapCollected ?? 0,
    );

    // Surface membrane reclamation alongside heap stats so one GC pass
    // reports both.
    return {
      ...gcResult,
      handlesFreed: membraneStats.handlesFreed,
      grantsFreed: membraneStats.grantsFreed,
    };
  }

  // ===========================================================================
  // Session API
  // ===========================================================================
  //
  // Object.freeze the returned session so consumers cannot monkey-
  // patch new fields onto it. The airlock is frozen separately (see
  // Airlock constructor's tail). The getters below (memoryImage,
  // mem, parser, collector) keep working through the freeze.

  return Object.freeze({
    /**
     * The Airlock - use this for all external handle and execution operations.
     */
    airlock,

    /**
     * Relocate the session's memory image + membrane to new byte
     * offsets within the SAME WebAssembly.Memory buffer.
     *
     * Used when a host compacts a shared buffer by copying a drone's slab
     * to a new position, then needs the JS and WASM views to follow.
     *
     * The caller must have done the memcpy BEFORE calling relocate;
     * we validate (magic checks on both the SS image and the
     * membrane) that the bytes at the new offsets are intact.
     *
     * @param {Object} args
     * @param {number} args.segmentBaseOffset - New baseOffset for the
     *   SS memory image.
     * @param {number} args.membraneByteOffset - New byteOffset for
     *   the membrane within the buffer.
     * @param {number} [args.membraneByteLength] - New membrane
     *   byteLength (defaults to existing).
     */
    relocate({ segmentBaseOffset, membraneByteOffset, membraneByteLength }) {
      airlock.relocate(segmentBaseOffset, membraneByteOffset, membraneByteLength);
    },

    /**
     * Resize the SS region (heap + string table) in place. The host
     * owns the buffer envelope: a grow that exceeds it must be
     * preceded by a host envelope expansion.
     *
     * Caller must compact (session.gc()) before a shrink so the
     * heap_pointer reflects the true high-water mark; otherwise the
     * call throws.
     *
     * @param {Object} args
     * @param {number} args.newSegmentSize - New total segment size.
     * @param {number} [args.newStringTableSize] - Optional new string
     *   table size; defaults to the current string-table size.
     */
    resizeSegment({ newSegmentSize, newStringTableSize }) {
      // Tick bump lives outside the interpreter; record the resize in
      // the membrane's timeline so subsequent log entries can be
      // ordered against it.
      airlock.membrane.bumpTick();
      memoryImage.resizeSegment({ newSegmentSize, newStringTableSize });
      // Record the resize in the engine counters.
      airlock.membrane.recordResizeSegment();
    },

    /**
     * Parse source code into bytecode.
     * Pure compilation - does not modify execution state.
     * Caller must set instruction index and status before running.
     */
    parse(source) {
      const startIndex = memoryImage.codeBlockInstructionCount();

      try {
        parser.parse(source);
        parser.complete();
      } catch (e) {
        const semantic = translateParserError(e);
        throw new ParseError(formatError(semantic), semantic);
      }

      // SS_VERIFY_CODEGEN=1: run the bytecode stack-depth verifier over
      // the emitted code. A join-mismatch (an instruction reachable at
      // two depths — the deferred-POP class) is a PARSER bug: fail the
      // parse loudly instead of shipping bytecode that corrupts the
      // operand stack at runtime.
      if (verifyCodegenEnabled()) {
        const report = verifyCodeBlockStackDepth(memoryImage);
        if (report.findings.length > 0) {
          throw new Error(
            `codegen stack-depth verification failed: ` +
            `${JSON.stringify(report.findings)}`);
        }
      }


      return {
        instructions: memoryImage.codeBlockInstructionCount(),
        startIndex,
      };
    },

    /**
     * Run until fuel exhausted, done, or error.
     *
     * @param {number|{slot:number,generation:number}} contextIdentity
     *   Context identity to run. Numeric slots are accepted only for direct,
     *   synchronous host drives; asynchronous schedulers carry generations.
     * @param {number} fuel - Fuel budget (required)
     * @returns {Object} { status, fuel, error? }
     */
    run(contextIdentity, fuel) {
      let slot;
      if (typeof contextIdentity === 'number') {
        slot = contextIdentity;
      } else if (contextIdentity !== null
          && typeof contextIdentity === 'object'
          && Number.isInteger(contextIdentity.slot)
          && Number.isInteger(contextIdentity.generation)) {
        if (!memoryImage.isContextIdentityLive(
          contextIdentity.slot, contextIdentity.generation)) {
          throw new Error(
            `run: stale context identity (${contextIdentity.slot}, ` +
            `${contextIdentity.generation})`);
        }
        slot = contextIdentity.slot;
      } else {
        throw new TypeError(
          'run requires a context slot or { slot, generation }');
      }
      // Bump the operation tick on every host-driven scheduling
      // decision. The tick lives in the membrane header (NOT in the
      // interpreter segment); the interpreter never sees it. Mutation
      // log entries written during this run() inherit this tick as
      // their timestamp.
      airlock.membrane.bumpTick();

      let remainingFuel = fuel;

      // Generators (INTERNALS.md's Generators section): if this slot is parked waiting on
      // a generator (a suspension inside the generator body returned
      // control to the host), descend to the innermost runnable context.
      slot = airlock.resolveActiveGeneratorSlot(slot);

      while (true) {
        const result = airlock.runContext(slot, remainingFuel);
        remainingFuel = result.fuel;

        // Generator trampoline: these exits stay inside run(), so a
        // generator whose body needs no external calls is synchronous
        // from the host's point of view.
        if (result.status === 'generator_call') {
          airlock.handleGeneratorCall(slot);
          continue;
        }
        if (result.status === 'generator_next') {
          const generatorResult = airlock.handleGeneratorRequest(slot);
          if (!generatorResult.settled) {
            slot = generatorResult.generatorContext;
          }
          continue;
        }
        if (result.status === 'generator_yield'
            || result.status === 'generator_complete'
            || result.status === 'generator_throw') {
          const settleResult = airlock.handleGeneratorSettle(slot, result.status);
          if (settleResult.asyncGenerator) {
            // Async generator: the step promise settled inside
            // handleGeneratorSettle; woken waiters and any queued
            // resume reached the host through the spawn queue. Nothing
            // is runnable in THIS drive: a yield parks the slot until
            // the next request wakes it (same lifecycle as a parked
            // awaiter), completion is terminal (the driving host frees
            // the slot, as with async-function contexts).
            if (settleResult.terminal) {
              return { status: 'done', fuel: remainingFuel };
            }
            return { status: 'await', fuel: remainingFuel };
          }
          slot = settleResult.callerContext;
          continue;
        }

        if (result.status === 'done') {
          return result;
        }

        if (result.status === 'paused') {
          return result;
        }

        if (result.status === 'memory_pressure') {
          // The slot's pending instruction would overflow the string
          // table. The host decides whether to gc() and resume, or
          // treat as fatal. The instruction has not advanced — calling
          // run(slot, ...) again replays the same op.
          return result;
        }

        if (result.status === 'error') {
          // Async function bodies and .then/.catch/.finally handlers
          // have a non-zero ASYNC_PROMISE field in their frame. Their
          // errors must flow through the async rejection machinery
          // (EXIT_ASYNC_REJECTED → handleAsyncRejected → promise
          // rejects → parent's `await` catches). If we threw here,
          // the rejection would never reach the promise and any
          // parent `try { await f() } catch` would never fire.
          // Non-async slots (top-level code, sync closures) have
          // ASYNC_PROMISE === 0 — those are genuinely unhandled.
          const isAsyncBody = airlock.isAsyncSlot(slot);
          if (isAsyncBody) {
            if (result.error) {
              result.error = translateError(result.error.code, result.error.detail, null, memoryImage, slot);
            }
            return result;
          }
          // extends-externals D3: run any owed construction aborts before
          // surfacing the terminal error — the dead context's dispatch
          // loop will never drain them.
          airlock.abortAbandonedConstructions(slot);
          const translated = result.error
            ? translateError(result.error.code, result.error.detail, null, memoryImage, slot)
            : { code: -1, codeName: 'UNKNOWN', message: 'unknown error', failPc: null };
          throw new UncaughtScriptError(slot, translated, remainingFuel);
        }


        if (result.status === 'external_call') {
          const externalResult = airlock.handleExternalCall(slot, remainingFuel);
          remainingFuel = externalResult.fuel;
          if (externalResult.suspended) {
            return { status: 'suspended', fuel: remainingFuel };
          }
          if (!externalResult.threw) {
            const { result: handlerResult, handlerKey } = externalResult;
            if (handlerResult instanceof Promise && airlock.shouldUnwrapPromise(handlerKey)) {
              // Convert the Promise return into a suspension so the slot
              // resumes with the resolved value (sync from the drone's POV).
              // session.run can't await inline without becoming async itself,
              // so reuse the existing suspension machinery.
              airlock.suspendOnPromise(slot, handlerResult);
              return { status: 'suspended', fuel: remainingFuel };
            }
            airlock.resumeWithValue(slot, handlerResult);
          }
          // Check for spawned contexts from resolve/reject inside new Promise executor
          {
            const contexts =
              airlock.drainPendingSpawnedContextIdentities();
            if (contexts.length > 0) {
              return { status: 'promise_method', fuel: remainingFuel, contexts };
            }
          }
          continue;
        }

        if (result.status === 'external_property') {
          const propertyResult = airlock.handleExternalProperty(slot, remainingFuel);
          remainingFuel = propertyResult.fuel;
          if (propertyResult.suspended) {
            return { status: 'suspended', fuel: remainingFuel };
          }
          if (!propertyResult.threw && 'result' in propertyResult) {
            const getterResult = propertyResult.result;
            if (getterResult instanceof Promise) {
              // Always-unwrap for properties: there's no opt-in, because
              // `obj.foo` and `await obj.foo` are spelled differently in
              // drone code and the getter has no way to know which the
              // drone wrote. Mirrors the method-side unwrapPromise path.
              airlock.suspendOnPromise(slot, getterResult);
              return { status: 'suspended', fuel: remainingFuel };
            }
            airlock.resumeWithValue(slot, getterResult);
          }
          // Drain spawned contexts from any `new Promise(executor)` the
          // getter constructed — same as the external_call path.
          {
            const contexts =
              airlock.drainPendingSpawnedContextIdentities();
            if (contexts.length > 0) {
              return { status: 'promise_method', fuel: remainingFuel, contexts };
            }
          }
          continue;
        }

        if (result.status === 'external_property_set') {
          const setResult = airlock.handleExternalPropertySet(slot, remainingFuel);
          remainingFuel = setResult.fuel;
          if (setResult.suspended) {
            return { status: 'suspended', fuel: remainingFuel };
          }
          if (!setResult.threw && 'result' in setResult) {
            // An assignment is an expression evaluating to the assigned
            // value — NOT the setter's return. The drone observes
            // `x = (el.prop = v)` ⇒ x === v regardless of what the setter
            // computed host-side. So we always resume with assignedValue.
            const setterResult = setResult.result;
            if (setterResult instanceof Promise) {
              // Async write: wait for the setter's promise to settle, then
              // resume with the assigned value. A rejection propagates as a
              // throw at the assignment site.
              airlock.suspendOnPromise(
                slot,
                setterResult.then(() => setResult.assignedValue)
              );
              return { status: 'suspended', fuel: remainingFuel };
            }
            airlock.resumeWithValue(slot, setResult.assignedValue);
          }
          // Drain spawned contexts from any `new Promise(executor)` the
          // setter constructed — same as the external_property path.
          {
            const contexts =
              airlock.drainPendingSpawnedContextIdentities();
            if (contexts.length > 0) {
              return { status: 'promise_method', fuel: remainingFuel, contexts };
            }
          }
          continue;
        }

        // extends-externals D5: branded-instance presence probe
        // (`key in instance` missed the vat chain). The WAT already
        // advanced the pc and popped the operands; resume pushes the
        // boolean.
        if (result.status === 'external_has_property') {
          const hasResult = airlock.handleExternalHasProperty(slot, remainingFuel);
          remainingFuel = hasResult.fuel;
          if (!hasResult.threw && 'result' in hasResult) {
            const probeResult = hasResult.result;
            if (probeResult instanceof Promise) {
              airlock.suspendOnPromise(slot, probeResult.then(Boolean));
              return { status: 'suspended', fuel: remainingFuel };
            }
            airlock.resumeWithValue(slot, Boolean(probeResult));
          }
          continue;
        }

        // extends-externals D5: branded-instance backing deletion
        // (`delete instance.key` found no vat own entry).
        if (result.status === 'external_delete_property') {
          const deleteResult = airlock.handleExternalDeleteProperty(slot, remainingFuel);
          remainingFuel = deleteResult.fuel;
          if (!deleteResult.threw && 'result' in deleteResult) {
            const hostResult = deleteResult.result;
            if (hostResult instanceof Promise) {
              airlock.suspendOnPromise(slot, hostResult.then(Boolean));
              return { status: 'suspended', fuel: remainingFuel };
            }
            airlock.resumeWithValue(slot, Boolean(hostResult));
          }
          continue;
        }

        if (result.status === 'grant_request') {
          const { result: grantResult, continuationId } = airlock.handleGrantRequest(slot);
          // Suspend like every other park point instead of
          // promise-chaining this.run() itself. This lets the caller's
          // run() (and Runtime._driveSlot) finish immediately, as with
          // external calls and await.
          if (grantResult instanceof Promise) {
            airlock.suspendOnGrantRequest(slot, grantResult, continuationId);
            return { status: 'suspended', fuel: remainingFuel };
          }
          continue;
        }

        // extends-externals: both exits are serviced synchronously by
        // the airlock (membrane reads + surrogate interning; no
        // host/capability code) and re-dispatch the same instruction.
        if (result.status === 'class_link_external') {
          airlock.handleClassLinkExternal(slot);
          continue;
        }
        if (result.status === 'instanceof_external') {
          airlock.handleInstanceofExternal(slot);
          continue;
        }

        if (result.status === 'promise_method') {
          const pmResult = airlock.handlePromiseMethod(slot);
          if (pmResult.contexts.length > 0) {
            return {
              status: 'promise_method',
              fuel: remainingFuel,
              contexts: pmResult.contexts,
            };
          }
          // No spawned contexts — continue running (let WASM detect end-of-code)
          continue;
        }

        if (result.status === 'promise_settle') {
          // Executor called resolve(value) / reject(reason). Handler is
          // synchronous (no membrane, no handler lookup); spawned waiter +
          // .then handler contexts are surfaced to the caller for scheduling.
          const settleResult = airlock.handlePromiseSettle(slot);
          if (settleResult.contexts.length > 0) {
            return {
              status: 'promise_method',
              fuel: remainingFuel,
              contexts: settleResult.contexts,
            };
          }
          continue;
        }

        if (result.status === 'await') {
          // Fast path for await on a settled promise: handleAwait writes the
          // value to the pending stack and clears the exit condition so we
          // can keep running. If still pending, surface to the caller.
          const awaitResult = airlock.handleAwait(slot);
          if (awaitResult.pending) {
            return result;
          }
          continue;
        }

        // For other statuses (async_call, etc.), return and let caller handle
        return result;
      }

    },

    /**
     * Get the result value (top of pending stack).
     */
    result(slot) {
      return airlock.extractResult(slot);
    },

    /**
     * Get a variable from global scope. Integer-valued Rationals that fit
     * safely in i32 are unwrapped to plain JS Numbers for surface compatibility
     * with consumers that pre-date the exact-default switch; use getExact if
     * you need the structured { kind: 'rational', numerator, denominator } form.
     */
    get(slot, name) {
      return getVariable(slot, name);
    },

    /**
     * Get a variable from global scope without numeric unwrapping. Returns
     * the full structured shape for Rational / Complex values.
     */
    getExact(slot, name) {
      const scope = inspectionScope(slot);
      const nameOffset = memoryImage.internString(name);
      const valuePointer = memoryImage.scopeLookup(scope, nameOffset);
      if (!valuePointer) {
        return undefined;
      }
      return memoryImage.readValueAt(valuePointer);
    },

    /**
     * List user variables (excludes builtins).
     */
    listVars(slot) {
      return listVars(slot);
    },

    /**
     * Get comprehensive execution state with lazy getters.
     */
    state(slot) {
      const exitCondition = exitConditionToString(memoryImage.getExitCondition(slot));
      // Expose the blocking signals:
      // blockedOnPromise — the promise data pointer this slot is
      //   awaiting (0 = not waiting).
      // blockedOnGrant — true if the slot is parked on EXIT_GRANT_REQUEST.
      // pendingCall — if the slot is paused at an external call, the
      //   shape of the pending request (per-context block since
      //   layout v8 — always coherent with this slot's exit).
      // lastTickRun — tick at last runContext entry for this slot,
      //   from airlock._lastTickRunBySlot (transient JS-side state).
      const waitingOn = memoryImage.getContextWaitingOn(slot);
      const blockedOnPromise = waitingOn !== 0 ? waitingOn : null;
      const blockedOnGrant = exitCondition === 'grant_request';
      let pendingCall = null;
      if (exitCondition === 'external_call' || exitCondition === 'external_property') {
        const req = memoryImage.getExternalRequest(slot);
        const methodName = req.methodOffset !== 0
          ? memoryImage.readString(req.methodOffset)
          : null;
        pendingCall = {
          handleSlot: req.handleId,
          method: methodName,
          argCount: req.argCount,
          argsPointer: req.argsPointer,
        };
      }
      const lastTickRun = airlock._lastTickRunBySlot.has(slot)
        ? airlock._lastTickRunBySlot.get(slot)
        : null;
      return {
        // Execution
        context: slot,
        instruction: memoryImage.getContextInstructionIndex(slot),
        instructionCount: memoryImage.codeBlockInstructionCount(),
        codeBlock: memoryImage.getCodeBlock(),
        exitCondition,
        status: exitCondition,  // backwards compat alias
        // Note: fuel is owned by JS, not stored in memory

        // Memory usage
        heapUsed: memoryImage.getHeapPointer() - memoryImage.getHeapStart(),
        heapTotal: memoryImage.getHeapEnd() - memoryImage.getHeapStart(),
        stringTableUsed: memoryImage.getStringPointer() - memoryImage.getStringStart(),
        // Capacity ends where the derived hash index starts (region
        // tail) — not at the segment end.
        stringTableTotal: memoryImage.getStringDataEnd() - memoryImage.getStringStart(),

        // Stack depths
        callStackDepth: memoryImage.getCallStackDepth(slot),
        pendingStackDepth: memoryImage.getPendingDepth(slot),
        tryStackDepth: memoryImage.getTryDepth(slot),

        // Completion state
        completionType: memoryImage.getContextCompletionType(slot),

        // Versions
        versions: memoryImage.getVersions(),

        // Blocking and scheduling signals.
        blockedOnPromise,
        blockedOnGrant,
        pendingCall,
        lastTickRun,
        // The following are surfaced as null because the codebase
        // doesn't track them today; they're reserved fields in the
        // shape so dumps stay stable when a future slice wires them.
        blockedOnSlot: null,
        spawnedBy: null,

        // Memory layout
        regions: {
          heapStart: memoryImage.getHeapStart(),
          heapEnd: memoryImage.getHeapEnd(),
          heapPointer: memoryImage.getHeapPointer(),
          stringStart: memoryImage.getStringStart(),
          stringPointer: memoryImage.getStringPointer(),
          callStackBase: memoryImage.getCallStackBase(slot),
          pendingStackBase: memoryImage.getPendingStackBase(slot),
          tryStackBase: memoryImage.getTryStackBase(slot),
          externalRequestBase: memoryImage.getExternalRequestBase(slot),
          errorInfoBase: memoryImage.getErrorInfoBase(),
          scratchBase: memoryImage.getScratchBase(),
          codePointer: memoryImage.getCodePointer(),
        },

        // Airlock state
        closureHandleCount: airlock.membrane.enumerateClosureHandles().length,

        // Lazy getters
        get error() {
          const info = memoryImage.getErrorInfo();
          if (info.code === 0) return null;
          return translateError(info.code, info.detail, null, memoryImage, slot);
        },

        get scope() {
          return getAllVariables(slot);
        },

        get pending() {
          return getPendingStack(slot);
        },

        get callStack() {
          return memoryImage.getCallStack(slot);
        },

        get tryStack() {
          return memoryImage.getTryStack(slot);
        },

        get strings() {
          return [...memoryImage.enumerateStrings()];
        },

        get instructions() {
          const count = memoryImage.codeBlockInstructionCount();
          const result = [];
          for (let i = 0; i < count; i++) {
            const instr = memoryImage.codeBlockReadInstruction(i);
            result.push({
              index: i,
              opcode: opcodeToString(instr.opcode),
              operand1: instr.operand1,
              operand2: instr.operand2,
              astNode: instr.astNode,
            });
          }
          return result;
        },

        get heapObjects() {
          return memoryImage.enumerateHeapObjects();
        },
      };
    },

    /**
     * Get details about a specific instruction.
     */
    instruction(index) {
      const instr = memoryImage.codeBlockReadInstruction(index);
      return {
        opcode: opcodeToString(instr.opcode),
        operand1: instr.operand1,
        operand2: instr.operand2,
        astNode: instr.astNode,
      };
    },

    /**
     * Find all instructions whose AST attribution falls within the subtree
     * rooted at `rootAstOffset`. Uses the reader's recursive expansion to
     * enumerate every descendant offset, then scans instructions.
     *
     * Returns an empty array when inlineSource is off (no AST to walk).
     */
    instructionsForAstSubtree(rootAstOffset) {
      if (!memoryImage.isAstRegionInitialized() || !rootAstOffset) return [];
      const reader = createAstReader(memoryImage);

      const offsets = new Set();
      const collect = (node) => {
        if (!node || typeof node !== 'object') return;
        if (typeof node.offset === 'number') offsets.add(node.offset);
        for (const value of Object.values(node)) {
          if (Array.isArray(value)) {
            for (const v of value) collect(v);
          } else if (value && typeof value === 'object') {
            collect(value);
          }
        }
      };
      collect(reader.readTree(rootAstOffset));

      const count = memoryImage.codeBlockInstructionCount();
      const result = [];
      for (let i = 0; i < count; i++) {
        const instr = memoryImage.codeBlockReadInstruction(i);
        if (offsets.has(instr.astNode)) {
          result.push(i);
        }
      }
      return result;
    },

    /**
     * Jump to a specific instruction.
     */
    setInstruction(slot, index) {
      memoryImage.setContextInstructionIndex(slot, index);
    },

    /**
     * Reset code block for fresh parsing.
     */
    resetCode() {
      memoryImage.resetCodeBlock();
    },

    /**
     * Run garbage collection.
     */
    gc() {
      return gc();
    },

    /**
     * Current operation tick — a monotonic u64 bumped at coarse-op
     * host calls (run / gc / resize). Lives in the membrane header;
     * the interpreter is unaware of it. Production-callable.
     * @returns {bigint}
     */
    tick() {
      return airlock.membrane.tick();
    },

    /**
     * AST region access (slice 2 of source-inlining). The interpreter does
     * not interpret AST bytes — the dialect tag in the header tells the host
     * which decoder applies.
     *
     * Returns null when the region is empty (inlineSource was false, or no
     * AST has been written yet).
     */
    getAstRegion() {
      return memoryImage.copyAstRegion();
    },

    /**
     * Read the AST region's header (dialect, format_version, root node
     * offset). Returns null when the region is empty.
     */
    getAstRegionHeader() {
      return memoryImage.getAstRegionHeader();
    },

    /**
     * Return the astNode offset attributed to a given instruction, or null
     * if the instruction has no attribution (sentinel 0).
     */
    getAstNodeOffset(instructionIndex) {
      const instr = memoryImage.codeBlockReadInstruction(instructionIndex);
      return instr.astNode === 0 ? null : instr.astNode;
    },

    /**
     * Iterate every instruction with a non-zero astNode attribution. Yields
     * { instructionIndex, astNodeOffset } pairs. Hosts pass these offsets
     * (along with the AST region bytes from getAstRegion()) into their
     * dialect-specific decoder.
     */
    *iterateAstAttributions() {
      const count = memoryImage.codeBlockInstructionCount();
      for (let i = 0; i < count; i++) {
        const instr = memoryImage.codeBlockReadInstruction(i);
        if (instr.astNode !== 0) {
          yield { instructionIndex: i, astNodeOffset: instr.astNode };
        }
      }
    },

    /**
     * Pretty-print the AST node attributed to an instruction, returning
     * source-like text. Returns null when the instruction has no
     * attribution (sentinel astNode = 0) or when inlineSource is off.
     *
     * The output is a faithful reconstruction — comments and original
     * whitespace are gone, but it parses back to the same AST.
     */
    getSourceFor(instructionIndex) {
      const offset = this.getAstNodeOffset(instructionIndex);
      if (offset === null) return null;
      const reader = createAstReader(memoryImage);
      const tree = reader.readTree(offset);
      if (tree === null) return null;
      return printNode(tree);
    },

    /**
     * Print every root in the AST region as a single source string. Roots
     * are separated by a blank line — each represents one parse() call.
     * Returns null when inlineSource is off (no AST was written).
     */
    getSource() {
      if (!memoryImage.isAstRegionInitialized()) return null;
      const reader = createAstReader(memoryImage);
      return printAllRoots(reader);
    },

    /**
     * Convenience accessor for an AST reader bound to this session's
     * memory image. Useful when a host wants to walk the AST directly
     * without going through getSource()/getSourceFor().
     */
    astReader() {
      return createAstReader(memoryImage);
    },

    /**
     * Get the set of exported names, accumulated across every parse
     * and — for inlineSource sessions — rebuilt from the persisted
     * AST's export flags on restore.
     * Export is metadata only — signals intent, does not gate access.
     *
     * @returns {Map<string, {type: string}>} Map of name -> { type: 'const'|'let'|'function' }
     */
    exports() {
      return parser.exports;
    },

    /**
     * Resolve an exported function and register a temporary closure handle.
     * Validation completes before either a context or handle is allocated.
     *
     * @param {string} name - Exported function name
     * @param {*} [metadata] - Optional snapshot-owned closure-handle metadata
     * @returns {number} Closure handle
     */
    registerExportClosure(name, metadata = null) {
      if (!parser.exports.has(name)) {
        throw new Error(`'${name}' is not exported`);
      }

      const value = getVariable(0, name);
      if (!value || value._type !== TYPE.FUNCTION) {
        throw new Error(`Export '${name}' is not a function`);
      }
      return airlock.registerClosure(value._dataLo, 0, metadata);
    },

    /**
     * Prepare a context for invoking an exported function.
     * Returns a context slot ready for session.run(slot, fuel).
     * The host is responsible for running, extracting results, and freeing the context.
     *
     * @param {string} name - Exported function name
     * @param {Array} args - Arguments to pass
     * @returns {number} Context slot
     */
    invokeExport(name, args) {
      const handle = this.registerExportClosure(name);
      const slot = memoryImage.allocateContext();
      const generation = memoryImage.getContextGeneration(slot);
      try {
        airlock.setupCallbackContext(slot, handle, args);
      } catch (error) {
        memoryImage.freeContext(slot, generation);
        airlock.dropClosureHandle(handle);
        throw error;
      }
      return slot;
    },


    // Expose internals for advanced access
    get memoryImage() { return memoryImage; },
    // Backwards compatibility alias
    get mem() { return memoryImage; },
    get parser() { return parser; },
    get collector() { return collector; },
  });
}

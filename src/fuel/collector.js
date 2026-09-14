/**
 * SandScript Fuel Interpreter - Garbage Collector (JS)
 *
 * Mark-compact collector for the linear memory heap.
 * Host-triggered (no automatic GC).
 *
 * ROLE: this is the differential oracle and debug/forensics collector,
 * not the default collector. Normal sessions run the WAT port
 * (`gc_collect` in interpreter.wat), which mirrors this file line by line;
 * tests/fuel/differential_gc_test.js enforces byte-identical output.
 * Sessions opt back into this collector with gcCollector: 'js' (or
 * SS_GC_COLLECTOR=js), and gcCollector: 'differential' runs both and
 * compares. When changing heap shapes or collection behavior, change BOTH
 * implementations and let the differential suite arbitrate.
 *
 * IMPORTANT: Pointer Convention
 * - All pointers stored in state/values/objects are DATA pointers
 *   (pointing to the data area AFTER the 8-byte GC header)
 * - GC header is at (dataPointer - GC_HEADER_SIZE)
 * - When walking the heap, we iterate by HEADER pointers
 *
 * Phases:
 *   1. Mark - traverse from roots, mark reachable objects and strings
 *   2. Compute - calculate forwarding addresses for live objects
 *   3. Update - update all pointers to new addresses
 *   4. Compact - move objects to new addresses
 *   5. String compaction - same for string table, rebuild hash map
 *
 * GC re-entrancy invariant:
 *
 *   The collector NEVER calls the heap allocator (memoryImage.allocate,
 *   allocateObject, allocateArray*, allocateArrayBuffer, allocateBigInt,
 *   etc.) and NEVER calls $check_heap_overflow / signal_memory_pressure.
 *   All compaction writes go through raw `view.setUint32` / `setUint8`
 *   operations against the existing linear memory; objects are moved
 *   in place by computing new positions from the forwarding map.
 *   The single state-mutating call at the end of compactHeap is
 *   `manipulator.setHeapPointer(newHeapPointer)` (see line 2419),
 *   which is the atomic commit of the compaction — by then every
 *   pointer has already been forwarded and every object moved, so
 *   the heap pointer drop is observed by future allocations as the
 *   reclaimed budget.
 *
 *   This invariant guarantees that GC itself cannot trigger heap
 *   pressure (which would cause infinite recursion: a host-side
 *   gc() called in response to pressure would re-enter the
 *   allocator, re-signal pressure, and the host loop would never
 *   terminate). Tests pin the invariant; see
 *   tests/fuel/gc_during_gc_invariant_test.js.
 *
 *   If you need to add an allocation step to GC (e.g. for a side
 *   table), allocate from a host-side JS buffer, not from the SS
 *   linear-memory heap.
 *
 * Value-block walk invariant — bound by the LIVE COUNT, never capacity:
 *
 *   A value/entry block (array data, object/scope/sym entries, Map/Set
 *   entries) is allocated at some `capacity` but filled append-only; the
 *   tail [count, capacity) is reserved-but-unwritten and holds STALE bytes
 *   (a block landing on a previously-freed region is not zero). The owning
 *   container header carries the live count — `length` (arrays), `count`
 *   (objects/scopes/param-lists), `sym_count` (sym-entries), `slotCount`
 *   (Map/Set). Every walk that calls markValue / updateValuePointer /
 *   updateValueStringOffset on a slot MUST iterate [0, liveCount), never a
 *   count derived from the block's GC-header size. A stale pointer-typed
 *   `type` word in a tail slot would otherwise be dereferenced as a heap
 *   header (markValue) — heap corruption, not a benign over-retain.
 *
 *   The walk therefore lives in the PARENT container case (which has the
 *   live count); the standalone entries-block obj-type cases
 *   (OBJ.SCOPE_ENTRIES / OBJ.MAP_ENTRIES / OBJ.SET_ENTRIES) are NO-OPS, and
 *   OBJ.ARRAY_DATA / OBJ.OBJECT_DATA have no case at all (they fall through).
 *   The block is kept live by the parent's setMark / forwarding of the
 *   entries-header field. Do not "helpfully" re-add a standalone walk that
 *   reconstructs the count from block size — that is exactly the bug.
 *   tests/fuel/gc_tail_slot_invariant_test.js pins this.
 */

import {
  STATE,
  FRAME,
  FRAME_SIZE,
  FRAME_FLAG_NATIVE_CONTINUATION,
  VALUE_SIZE,
  FLAG_RATIONAL_INLINE,
  TYPE,
  OBJ,
  REGEXP,
  SCHEMA,
  GC_HEADER_SIZE,
  readGCHeaderSize,
  OPERAND_KIND,
  opcodesWithOperand1Kind,
  INSTRUCTION_SIZE,
  isTypedArrayType,
  CONTINUATION_KIND,
  // Context stack bases are read from state-block CTX.*_BASE fields.
  CONTEXT_STATE_OFFSET,
  CTX,
  CONTEXT_STATUS_FREE,
  TRY_ENTRY,
  TRY_ENTRY_SIZE,
  COMPLETION_THROW,
  COMPLETION_RETURN,
  GRANT_ENTRY,
  GRANT_ENTRY_SIZE,
  PROMISE,
  PROMISE_WAITER,
  THEN_HANDLER,
  EXIT_AWAIT,
  EXIT_ASYNC_CALL,
  EXIT_PROMISE_METHOD,
  EXIT_PROMISE_SETTLE,
  EXIT_EXTERNAL_CALL,
  EXIT_EXTERNAL_PROPERTY,
  EXIT_EXTERNAL_PROPERTY_SET,
  BUILTINS_SIZE,
  STRING_DATA_START,
  hashTableBuckets,
  hashTableSize,
  FNV_OFFSET_BASIS,
  FNV_PRIME,
  INTRINSIC_STATE_CELLS,
  HEADER_EVENT_KIND,
  HEADER_EVENT_FIELD,
  HEADER_EVENT_SITE,
  BUILTIN_NAME,
} from './constants.js';
import { writeHeaderEventRingEntry, writeParkedSlotsSnapshotEntry } from './header-event-ring.js';
import { createAstReader } from './ast.js';
import { auditStringReferences } from './string-audit.js';

// Code-operand opcode sets, derived from the operand-kind table in
// constants.js — the single source of truth shared with the code
// differ. Operand1 of these opcodes references the string table /
// heap and must be marked in the mark phase and forwarded across
// compaction.
const STRING_OPERAND_OPCODES = opcodesWithOperand1Kind(OPERAND_KIND.STRING_OFFSET);
const HEAP_OPERAND_OPCODES = opcodesWithOperand1Kind(OPERAND_KIND.HEAP_POINTER);

const NATIVE_CONTINUATION_KINDS = new Set(Object.values(CONTINUATION_KIND));

// Post-collection string-reference audit default: opt in via env
// (SS_VERIFY_COLLECTIONS=1) or per-collector via `verifyAfterCollect`.
// Costs a linear heap walk per collection — a debug/hunting affordance,
// not a production default.
const VERIFY_COLLECTIONS_DEFAULT = (() => {
  try { return globalThis.Deno?.env?.get('SS_VERIFY_COLLECTIONS') === '1'; }
  catch { return false; }
})();

/**
 * Garbage collector for fuel interpreter.
 */
export class Collector {
  /**
   * @param {MemoryManipulator} manipulator - Memory manipulator instance
   */
  constructor(manipulator) {
    this.manipulator = manipulator;
    this.memory = manipulator.memory;
    this.baseOffset = manipulator.baseOffset;
    this._refreshViews();

    // String mark bitmap - allocated during mark phase
    this.stringMarks = null;

    // String data starts after the hash table
    this.stringDataStart = null;

    // External roots (set by collect(), default empty for direct method calls)
    this.externalRoots = [];

    // Optional hook called by markValue for every value slot it visits.
    // Set this when running a "mark-only" pass (e.g. membrane walker) that
    // needs to observe values without affecting GC behavior. Signature:
    //   (type: number, dataLo: number, valueAddr: number) => void
    this.valueObserver = null;

    // VERIFY-MODE setMark guard: a Set of valid header addresses, armed
    // by collect() for the duration of the mark phase (see setMark).
    this._headerSet = null;
  }

  /**
   * Refresh typed array views (call after memory growth).
   */
  _refreshViews() {
    this.buffer = this.memory.buffer;
    this.view = new DataView(this.buffer);
    this.bytes = new Uint8Array(this.buffer);
  }

  /**
   * Convert segment-relative offset to absolute memory offset.
   */
  abs(offset) {
    const result = this.baseOffset + offset;
    if (result < 0 || result >= this.view.byteLength) {
      const stack = new Error().stack.split('\n').slice(1, 12).join('\n');
      throw new Error(`abs(${offset}): out of bounds\n${stack}`);
    }
    return result;
  }

  /**
   * Run garbage collection.
   *
   * @param {number[]} externalRoots - Optional array of HEADER pointers to treat as roots
   *   (e.g., closure pointers held by JS). These will be kept alive and their
   *   forwarding info returned so the caller can update external references.
   * @returns {object} - { heapCollected, heapRetained, stringsCollected, stringsRetained, forwarding }
   *   forwarding is a Map<oldHeaderPointer, newHeaderPointer> for external roots that moved
   */
  collect(externalRoots = []) {
    // GC safety is a caller concern. The caller must not call gc() while
    // FFI handlers are actively executing (they may hold JS references to
    // SS objects). Exit conditions are interpreter output and don't indicate
    // whether a handler is currently executing.

    // A collection that threw mid-phase left the image HALF-MUTATED — marks
    // partially applied, objects partially moved, string references
    // partially forwarded or zeroed. Nothing read from the image can be
    // trusted after that, and a SECOND collection over the wreckage
    // compounds it. Refuse loudly: continuing would turn an attributable
    // collection failure into delayed, unrelated symptoms such as poisoned
    // values, sticky INVALID_OPERAND, and phantom string ids.
    if (this.poisoned) {
      const refusal = new Error(
        `collect: the image is poisoned by an earlier failed collection ` +
        `(${this.poisoned.message}); the vat must be torn down and ` +
        `restored from persistence`);
      refusal.name = 'FatalCollectionError';
      refusal.fatalCollection = true;
      throw refusal;
    }

    this._refreshViews();

    // Store external roots for mark phase
    this.externalRoots = externalRoots;

    const startHeapPointer = this.manipulator.getHeapPointer();
    const startStringPointer = this.manipulator.getStringPointer();

    writeHeaderEventRingEntry(this.view, this.baseOffset, {
      kind: HEADER_EVENT_KIND.GC_CYCLE_START,
      site: HEADER_EVENT_SITE.JS_COLLECTOR_COLLECT,
      oldValue: startHeapPointer,
    });
    // Snapshot which context slots are parked at exactly this moment, before
    // the mark phase touches anything, so diagnostics can establish whether
    // a context was genuinely parked when this collection ran.
    writeParkedSlotsSnapshotEntry(this.view, this.baseOffset, this.manipulator, {
      site: HEADER_EVENT_SITE.JS_COLLECTOR_COLLECT,
    });

    try {
      // VERIFY-MODE pre-flight: the heap walk must already be parsable
      // BEFORE this collection touches anything. Every invariant the
      // post-collection audit checks also holds between collections —
      // allocators write full header words (clearing the mark bit) and
      // zero the forwarding word. A finding HERE means the MUTATOR
      // window since the previous collection (an allocator or raw
      // writer) desynced the walk stride. Without this early check,
      // moveObjects can interpret payload bytes as a forwarding pointer
      // (for example ASCII "ode " = 0x2065646f), producing an abs()
      // out-of-bounds failure that would be misattributed to this collection.
      if (this.verifyAfterCollect ?? VERIFY_COLLECTIONS_DEFAULT) {
        const preReport = this.auditHeapWalk({ maxFindings: 8, requireClearMarks: false });
        if (preReport.findings.length > 0) {
          throw new Error(
            `heap walk broken BEFORE collection — mutator-window ` +
            `corruption, not a collector fault: ` +
            `${JSON.stringify(preReport.findings)}`);
        }
        const preRoots = this.auditContextRoots({ maxFindings: 8, checkValues: true });
        if (preRoots.findings.length > 0) {
          throw new Error(
            `context roots stale BEFORE collection — the mutator window ` +
            `(or the PREVIOUS collection's forwarding) left them: ` +
            `${JSON.stringify(preRoots.findings)}`);
        }
        // Arm the setMark header-set guard: any mark of a non-header
        // address during this collection throws with the misdispatching
        // path (see setMark).
        const headers = new Set();
        {
          let hp = this.manipulator.getHeapStart();
          const end = this.manipulator.getHeapPointer();
          while (hp < end) {
            const size = this.readHeaderSize(hp);
            if (size === 0) break;
            headers.add(hp);
            hp += size;
          }
        }
        this._headerSet = headers;
      }

      // Phase 1: Mark
      this.markPhase();
      this._headerSet = null;

      // Phase 2-4: Compact heap (returns forwarding map for external roots)
      const { heapRetained, heapCollected, forwarding } = this.compactHeap();

      // Phase 5: Compact strings
      const { stringsRetained, stringsCollected } = this.compactStrings();

      // VERIFY MODE (SS_VERIFY_COLLECTIONS=1, or collector.verifyAfterCollect):
      // audit every string reference against the post-compaction region. A
      // finding means THIS collection left a dangling reference — a marking
      // or forwarding gap — and the throw below routes through the poison
      // machinery: fatal, attributed, with the exact objects named. The first
      // collection that rots a reference therefore fails at the source
      // instead of leaving a time bomb for a later read.
      if (this.verifyAfterCollect ?? VERIFY_COLLECTIONS_DEFAULT) {
        const report = auditStringReferences(this.manipulator, { maxFindings: 8 });
        if (report.regionCorrupt || report.findings.length > 0) {
          throw new Error(
            `string reference audit failed after collection: ` +
            `${report.findings.length} rotten reference(s)` +
            (report.regionCorrupt ? ' + corrupt region walk' : '') +
            ` — ${JSON.stringify(report.findings)}`);
        }
        // HEAP-WALK audit: the compacted heap must be a perfectly parsable
        // run of objects. A finding here names the collection that BROKE
        // the walk; otherwise the corruption may surface only during a
        // LATER moveObjects pass as an abs()-out-of-bounds failure.
        const heapReport = this.auditHeapWalk({ maxFindings: 8 });
        if (heapReport.findings.length > 0) {
          throw new Error(
            `heap-walk audit failed after collection: ` +
            `${JSON.stringify(heapReport.findings)}`);
        }
        // Context-roots audit: THIS collection must leave every slot's
        // roots pointing at correctly-typed post-move objects. A finding
        // names the forwarding gap at the collection that created it.
        const rootsReport = this.auditContextRoots({ maxFindings: 8, checkValues: true });
        if (rootsReport.findings.length > 0) {
          throw new Error(
            `context-roots audit failed after collection: ` +
            `${JSON.stringify(rootsReport.findings)}`);
        }
        // The WAT's cached region globals must agree with the STATE
        // header — drift means a resize/relocate path skipped its
        // refresh and every WAT-side string/region read is displaced.
        // Only auditable on a live vat (bytes-only images have no
        // wasm instance attached).
        if (this.manipulator.wasm) {
          const regions = this.manipulator.auditRegionGlobals();
          if (!regions.consistent) {
            throw new Error(
              `region-globals audit failed after collection: WAT cached ` +
              `globals drifted from the STATE header — ` +
              `${JSON.stringify(regions.mismatches)}`);
          }
        }
      }

      // Clean up
      this.externalRoots = [];

      writeHeaderEventRingEntry(this.view, this.baseOffset, {
        kind: HEADER_EVENT_KIND.GC_CYCLE_END,
        site: HEADER_EVENT_SITE.JS_COLLECTOR_COLLECT,
        newValue: this.manipulator.getHeapPointer(),
      });

      return {
        heapCollected,
        heapRetained,
        stringsCollected,
        stringsRetained,
        forwarding,
      };
    } catch (phaseError) {
      this._headerSet = null;
      // Mark the image unrecoverable and rethrow as fatal. Callers that
      // used to treat a gc failure as a per-slot error (the runtime's
      // memory_pressure retry) must let this propagate — the process/worker
      // dying loudly and recovering from persisted bytes is strictly better
      // than executing on a half-collected image.
      this.poisoned = phaseError;
      const fatal = new Error(
        `collect: collection failed mid-phase, the image is now poisoned ` +
        `and must not be used: ${phaseError.message}`,
        { cause: phaseError });
      fatal.name = 'FatalCollectionError';
      fatal.fatalCollection = true;
      throw fatal;
    }
  }

  // ===========================================================================
  // GC Header Operations
  //
  // These methods work with HEADER pointers (pointing to the GC header).
  // To get header from data pointer: headerPointer = dataPointer - GC_HEADER_SIZE
  // ===========================================================================

  /**
   * VERIFY-MODE heap-walk audit: after compaction the live heap must be a
   * perfectly parsable run of objects — every header size non-zero,
   * 16-aligned and in-bounds, every type a known OBJ value, every mark and
   * forwarding word cleared, and the walk landing EXACTLY on the heap
   * pointer. Costs one linear walk; verify-mode only.
   */
  auditHeapWalk({ maxFindings = 8, requireClearMarks = true } = {}) {
    const findings = [];
    const heapStart = this.manipulator.getHeapStart();
    const heapPointer = this.manipulator.getHeapPointer();
    const maxType = Math.max(...Object.values(OBJ));
    let p = heapStart;
    while (p < heapPointer && findings.length < maxFindings) {
      const word = this.view.getUint32(this.abs(p), true);
      const size = readGCHeaderSize(this.view, this.abs(p), word);
      const type = (word >> 24) & 0x7f;
      if (size === 0) {
        findings.push({ at: p, problem: 'zero size mid-heap', heapPointer });
        break;
      }
      // Heap objects are 4-aligned (sizes are built from 4-multiples;
      // several allocators stride UNALIGNED-to-16 on purpose — the walk
      // stride equals the stored size, which is the actual invariant and
      // is what the exact-landing check below enforces).
      if ((size & 0x3) !== 0) {
        findings.push({ at: p, problem: 'size not 4-aligned', size, type });
      }
      if (p + size > heapPointer) {
        findings.push({ at: p, problem: 'size overruns heap pointer', size, type, heapPointer });
        break;
      }
      if (type > maxType) {
        findings.push({ at: p, problem: 'unknown object type', type, size });
      }
      // Mark bits must be clear AFTER a collection (moveObjects clears
      // them). BETWEEN collections they may legitimately be set: the
      // membrane compactor runs a mark-only pass (collectLiveHandleSlots
      // → markPhase with no compaction) and leaves them for the next
      // real collection's clearAllMarks — so pre-collection callers pass
      // requireClearMarks: false.
      if (requireClearMarks && (word >>> 31) !== 0) {
        findings.push({ at: p, problem: 'mark bit set', type, size });
      }
      const forwarding = this.view.getUint32(this.abs(p) + 4, true);
      if (forwarding !== 0) {
        findings.push({ at: p, problem: 'forwarding not cleared', forwarding, type, size });
      }
      p += size;
    }
    if (findings.length === 0 && p !== heapPointer) {
      findings.push({ at: p, problem: 'walk missed the heap pointer', heapPointer });
    }
    return { findings };
  }

  /**
   * VERIFY-MODE context-roots audit: every allocated slot's root pointers
   * must address real, correctly-typed heap objects — the context object
   * itself (OBJ.CONTEXT), its four stack blocks (OBJ.STACK_BLOCK), its
   * scope (OBJ.SCOPE with a sane count/capacity and an in-heap
   * OBJ.SCOPE_ENTRIES block), and every call-stack frame's scope. A stale
   * root can make a later mark phase follow interior bytes that happen to
   * resemble a scope header, eventually failing as an unattributable abs()
   * out-of-bounds access. Run BEFORE a collection, a finding means the
   * mutator window wrote the stale root; run AFTER, the collection failed
   * to forward it.
   */
  auditContextRoots({ maxFindings = 8, checkValues = false } = {}) {
    const findings = [];
    const heapStart = this.manipulator.getHeapStart();
    const heapPointer = this.manipulator.getHeapPointer();

    const headerTypeAt = (dataPointer) => {
      const header = dataPointer - GC_HEADER_SIZE;
      if (header < heapStart || header >= heapPointer) return -1;
      return (this.view.getUint32(this.abs(header), true) >> 24) & 0x7f;
    };
    const expect = (slot, field, dataPointer, wantType) => {
      if (findings.length >= maxFindings) return false;
      const got = headerTypeAt(dataPointer);
      if (got !== wantType) {
        findings.push({ slot, field, pointer: dataPointer, wantType, gotType: got });
        return false;
      }
      return true;
    };
    // Value-slot integrity: for pointer-bearing value types, data_lo must
    // address a heap object whose GC-header type matches the value type.
    // This is the check that names the exact corrupt slot the mark phase
    // would otherwise detonate on (markValue dereferences these blindly).
    const headerTypeForValueType = (vt) => {
      if (vt === TYPE.ARRAY) return OBJ.ARRAY;
      if (vt === TYPE.OBJECT) return OBJ.OBJECT;
      if (vt === TYPE.FUNCTION) return OBJ.FUNCTION;
      if (vt === TYPE.PROMISE) return OBJ.PROMISE;
      if (vt === TYPE.EXPRESSION) return OBJ.EXPRESSION;
      if (vt === TYPE.MATRIX) return OBJ.MATRIX;
      if (vt === TYPE.THEOREM) return OBJ.THEOREM;
      if (vt === TYPE.ALGEBRAIC) return OBJ.ALGEBRAIC;
      if (vt === TYPE.COMPLEX_ALGEBRAIC) return OBJ.COMPLEX_ALGEBRAIC;
      if (vt === TYPE.REGEXP) return OBJ.REGEXP;
      if (vt === TYPE.SCHEMA) return OBJ.SCHEMA;
      if (vt === TYPE.MSGPACK_REF) return OBJ.ARRAYBUFFER;
      if (isTypedArrayType(vt)) return OBJ.TYPED_ARRAY_DESCRIPTOR;
      return null; // not a heap-pointer-bearing type we can validate
    };
    const checkValueSlot = (slot, field, valueAddr) => {
      if (findings.length >= maxFindings) return;
      const vt = this.view.getUint32(this.abs(valueAddr), true);
      const want = headerTypeForValueType(vt);
      if (want === null) return;
      const dataLo = this.view.getUint32(this.abs(valueAddr) + 8, true);
      if (dataLo === 0) return;
      // ARRAY/OBJECT/FUNCTION/PROMISE/EXPRESSION/MATRIX store HEADER
      // pointers; the data-pointer types (typed arrays, msgpack refs)
      // store DATA pointers (header at -8).
      const headerish = (vt === TYPE.ARRAY || vt === TYPE.OBJECT ||
                         vt === TYPE.FUNCTION || vt === TYPE.PROMISE ||
                         vt === TYPE.EXPRESSION || vt === TYPE.MATRIX ||
                         vt === TYPE.THEOREM || vt === TYPE.ALGEBRAIC ||
                         vt === TYPE.COMPLEX_ALGEBRAIC || vt === TYPE.REGEXP ||
                         vt === TYPE.SCHEMA)
        ? dataLo + GC_HEADER_SIZE  // normalize: headerTypeAt subtracts 8
        : dataLo;
      const got = headerTypeAt(headerish);
      if (got !== want) {
        findings.push({ slot, field, valueType: vt, dataLo, wantType: want, gotType: got });
      }
    };

    for (const slot of this.getAllocatedContexts()) {
      if (findings.length >= maxFindings) break;
      const base = this.manipulator.getContextBase(slot);
      if (!expect(slot, 'contextBase', base, OBJ.CONTEXT)) continue;
      const invocationRoot = this.view.getUint32(
        this.abs(this.manipulator.getContextStateBase(slot))
          + CTX.INVOCATION_ROOT,
        true,
      );
      if (invocationRoot !== 0 && invocationRoot !== 1) {
        findings.push({
          slot,
          field: 'invocationRoot',
          value: invocationRoot,
          expected: '0 or 1',
        });
      }
      const bounds = this.getContextStackBounds(slot);
      expect(slot, 'pendingBase', bounds.pendingBase, OBJ.STACK_BLOCK);
      expect(slot, 'callStackBase', bounds.callStackBase, OBJ.STACK_BLOCK);
      expect(slot, 'grantStackBase', bounds.grantStackBase, OBJ.STACK_BLOCK);
      expect(slot, 'tryStackBase', bounds.tryStackBase, OBJ.STACK_BLOCK);
      if (bounds.scope !== 0 && expect(slot, 'scope', bounds.scope, OBJ.SCOPE)) {
        // Walk the scope CHAIN (parents included) the same way markScope
        // recursion would, validating structure — and, with checkValues,
        // every binding value — at each level.
        let scopePtr = bounds.scope;
        let hops = 0;
        while (scopePtr !== 0 && hops < 64 && findings.length < maxFindings) {
          if (hops > 0 && !expect(slot, `scope.parent[${hops}]`, scopePtr, OBJ.SCOPE)) break;
          const absScope = this.abs(scopePtr);
          const count = this.view.getUint32(absScope + 4, true);
          const capacity = this.view.getUint32(absScope + 8, true);
          const entriesHeader = this.view.getUint32(absScope + 12, true);
          if (count > capacity) {
            findings.push({ slot, field: `scope[${hops}].count`, pointer: scopePtr, count, capacity });
            break;
          }
          if (entriesHeader !== 0) {
            const entriesType = entriesHeader >= heapStart && entriesHeader < heapPointer
              ? (this.view.getUint32(this.abs(entriesHeader), true) >> 24) & 0x7f
              : -1;
            if (entriesType !== OBJ.SCOPE_ENTRIES) {
              findings.push({ slot, field: `scope[${hops}].entries`, pointer: entriesHeader, gotType: entriesType });
              break;
            }
            if (checkValues) {
              for (let i = 0; i < count && findings.length < maxFindings; i++) {
                checkValueSlot(slot, `scope[${hops}].binding[${i}]`,
                  entriesHeader + GC_HEADER_SIZE + i * 20 + 4);
              }
            }
          }
          scopePtr = this.view.getUint32(absScope, true);
          hops++;
        }
      }
      // NOTE: pending-stack values are deliberately NOT value-checked.
      // Resume/restore choreography (promise-method result pushes, await
      // wakes) legitimately leaves DEAD slots inside [base, pointer)
      // holding stale pre-compaction values that are never read again —
      // the collector itself tolerates them (markObjectByHeaderPointer
      // bounds-checks and skips), and the setMark header-set guard
      // catches any in-bounds garbage a mark walk actually follows.
      // Scope bindings, by contrast, are live by definition ([0, count)),
      // so their value checks above are precise.
      // Call-stack frame scopes (0 allowed — top-level frames).
      for (let frameAddr = bounds.callStackBase;
           frameAddr < bounds.callStackPointer && findings.length < maxFindings;
           frameAddr += FRAME_SIZE) {
        const frameScope = this.view.getUint32(this.abs(frameAddr) + FRAME.SCOPE_POINTER, true);
        if (frameScope !== 0) {
          expect(slot, `frame@${frameAddr}.scope`, frameScope, OBJ.SCOPE);
        }
      }
    }
    return { findings };
  }

  /**
   * Read object type from GC header.
   * @param {number} headerPointer - Pointer to GC header
   */
  readHeaderType(headerPointer) {
    const headerWord = this.view.getUint32(this.abs(headerPointer), true);
    return (headerWord >> 24) & 0x7f;
  }

  /**
   * Read object size from GC header.
   * @param {number} headerPointer - Pointer to GC header
   */
  readHeaderSize(headerPointer) {
    return readGCHeaderSize(this.view, this.abs(headerPointer));
  }

  /**
   * Check if object is marked.
   * @param {number} headerPointer - Pointer to GC header
   */
  isMarked(headerPointer) {
    const headerWord = this.view.getUint32(this.abs(headerPointer), true);
    return (headerWord & 0x80000000) !== 0;
  }

  /**
   * Set mark bit on object.
   *
   * VERIFY MODE: when `_headerSet` is armed (built by collect() from a
   * pre-mark linear walk), a mark of any address that is NOT a real
   * object header refuses loudly. A misdispatched mark (a DATA pointer
   * handed to a HEADER-pointer path, or a garbage pointer followed off
   * a corrupt value) writes bit 31 into the INTERIOR of some other
   * object — silent heap corruption committed by the mark phase itself
   * that may surface only in a later collection as an abs()-out-of-bounds
   * failure. The throw here names the misdispatching call path at the FIRST
   * bad mark.
   *
   * @param {number} headerPointer - Pointer to GC header
   */
  setMark(headerPointer) {
    if (this._headerSet !== undefined && this._headerSet !== null
        && !this._headerSet.has(headerPointer)) {
      throw new Error(
        `setMark(${headerPointer}): not a heap object header — a ` +
        `misdispatched mark would corrupt the interior of another object`);
    }
    const absolutePointer = this.abs(headerPointer);
    const headerWord = this.view.getUint32(absolutePointer, true);
    this.view.setUint32(absolutePointer, headerWord | 0x80000000, true);
  }

  /**
   * Clear mark bit on object.
   * @param {number} headerPointer - Pointer to GC header
   */
  clearMark(headerPointer) {
    const absolutePointer = this.abs(headerPointer);
    const headerWord = this.view.getUint32(absolutePointer, true);
    this.view.setUint32(absolutePointer, headerWord & 0x7fffffff, true);
  }

  /**
   * Set forwarding pointer (new HEADER pointer after compaction).
   * @param {number} headerPointer - Pointer to GC header
   * @param {number} newHeaderPointer - New header pointer
   */
  setForwardingPointer(headerPointer, newHeaderPointer) {
    this.view.setUint32(this.abs(headerPointer) + 4, newHeaderPointer, true);
  }

  /**
   * Get forwarding pointer.
   * @param {number} headerPointer - Pointer to GC header
   * @returns {number} - New header pointer (0 if not set)
   */
  getForwardingPointer(headerPointer) {
    return this.view.getUint32(this.abs(headerPointer) + 4, true);
  }

  // ===========================================================================
  // Phase 1: Mark
  // ===========================================================================

  /**
   * Get all allocated context slots that are not free.
   * @returns {number[]} - Array of context slot indices
   */
  getAllocatedContexts() {
    const contextCount = this.manipulator.getContextCount();
    const allocated = [];

    for (let slot = 0; slot < contextCount; slot++) {
      // A table entry of 0 means the slot is unallocated or freed
      // (freeContext zeroes it), so skip it before reading its state block.
      if (this.manipulator.getContextBase(slot) === 0) continue;
      const exitCondition = this.manipulator.getExitCondition(slot);
      if (exitCondition !== CONTEXT_STATUS_FREE) {
        allocated.push(slot);
      } else {
        // Legacy image: the slot is FREE but its table entry still points at
        // the state block this collection is about to reclaim. Zero it NOW,
        // while the FREE read is still trustworthy — after this GC the entry
        // would dangle into reused bytes and a later collection would
        // resurrect a phantom context from them (walking and FORWARDING
        // through arbitrary data as if it were the context's stacks).
        this.manipulator.setContextPointer(slot, 0);
      }
    }

    return allocated;
  }

  /**
   * Get stack bounds for a specific context.
   * @param {number} slot - Context slot index
   * @returns {object} - Stack bases and pointers for this context
   */
  getContextStackBounds(slot) {
    // Stack bases are read from the state-block CTX.*_BASE fields because
    // each stack is its own heap block; they are not fixed offsets from base.
    const base = this.manipulator.getContextBase(slot);
    const stateBase = base + CONTEXT_STATE_OFFSET;
    const absStateBase = this.abs(stateBase);

    return {
      pendingBase: this.view.getUint32(absStateBase + CTX.PENDING_BASE, true),
      pendingPointer: this.view.getUint32(absStateBase + CTX.PENDING_POINTER, true),
      callStackBase: this.view.getUint32(absStateBase + CTX.CALL_STACK_BASE, true),
      callStackPointer: this.view.getUint32(absStateBase + CTX.CALL_STACK_POINTER, true),
      grantStackBase: this.view.getUint32(absStateBase + CTX.GRANT_STACK_BASE, true),
      grantStackPointer: this.view.getUint32(absStateBase + CTX.GRANT_STACK_POINTER, true),
      tryStackBase: this.view.getUint32(absStateBase + CTX.TRY_STACK_BASE, true),
      tryStackPointer: this.view.getUint32(absStateBase + CTX.TRY_STACK_POINTER, true),
      scope: this.view.getUint32(absStateBase + CTX.SCOPE, true),
      completionType: this.view.getUint32(absStateBase + CTX.COMPLETION_TYPE, true),
      completionValue: this.view.getUint32(absStateBase + CTX.COMPLETION_VALUE, true),
      generatorObject: this.view.getUint32(absStateBase + CTX.GENERATOR_OBJECT, true),
      regexState: this.view.getUint32(absStateBase + CTX.REGEX_STATE, true),
    };
  }

  /**
   * Mark phase - traverse from roots and mark all reachable objects.
   */
  markPhase() {
    // Clear all marks first
    this.clearAllMarks();

    // Initialize string mark bitmap
    this.initStringMarks();

    // The slot→pointer context table is itself a heap object; mark it so
    // compaction retains it. Its entries (context-object pointers) are walked
    // below and forwarded per-slot by updateContextPointers, not by the
    // generic object walk.
    this.markObjectByDataPointer(this.manipulator.getContextTablePointer());
    this.markObjectByDataPointer(
      this.manipulator.getContextGenerationTablePointer());

    // Mark from roots in ALL allocated contexts (not just current)
    const allocatedContexts = this.getAllocatedContexts();

    for (const slot of allocatedContexts) {
      this.markContextRoots(slot);
    }

    // External roots (closure HEADER pointers held by JS)
    for (const headerPointer of this.externalRoots) {
      if (headerPointer !== 0) {
        this.markObjectByHeaderPointer(headerPointer);
      }
    }

    // Mark strings used in the code block (so they're not compacted away)
    this.markCodeBlockStrings();

    // Mark heap objects referenced by code operands (parse-time bigint
    // literals). Without this, a literal whose only reference is its
    // instruction operand is collected — and even a live one relocates
    // without the operand being forwarded.
    this.markCodeBlockHeapOperands();

    // Mark strings used in builtins table (method names like "push", "length", etc.)
    this.markBuiltinStrings();

    // Mark strings referenced from AST nodes (identifier names, string
    // literals, bigint digit strings — the last typically have no other
    // reference at all).
    this.markAstStrings();

    // Mark intrinsic objects (prototypes stored in state header)
    this.markIntrinsics();
  }

  /**
   * Mark all roots in a specific context.
   * @param {number} slot - Context slot index
   */
  markContextRoots(slot) {
    const bounds = this.getContextStackBounds(slot);

    // 0. The context object and its four stack blocks are themselves heap
    //    objects. Mark them so the sweep retains them; their contents are
    //    marked by the per-stack walks below.
    this.markObjectByDataPointer(this.manipulator.getContextBase(slot));
    this.markObjectByDataPointer(bounds.pendingBase);
    this.markObjectByDataPointer(bounds.callStackBase);
    this.markObjectByDataPointer(bounds.grantStackBase);
    this.markObjectByDataPointer(bounds.tryStackBase);

    // 1. Scope (DATA pointer)
    if (bounds.scope !== 0) {
      this.markObjectByDataPointer(bounds.scope);
    }

    // 2. Pending stack entries
    this.markPendingStackForContext(bounds.pendingBase, bounds.pendingPointer);

    // 3. Call stack frames (scopes + iteration state + ASYNC_PROMISE)
    this.markCallStackForContext(bounds.callStackBase, bounds.callStackPointer);

    // 4. Grant stack entries (identifier values + entry scopes)
    this.markGrantStackForContext(bounds.grantStackBase, bounds.grantStackPointer);

    // 4b. Try stack entries: each holds the scope pointer to restore
    //     when unwinding to its catch/finally. Usually an ancestor of
    //     the current scope (so marked transitively anyway), but it
    //     must be marked in its own right — and, critically, FORWARDED
    //     in the update phase. Otherwise a parked slot can unwind
    //     through a pre-compaction scope address and resolve bindings
    //     against moved-away storage.
    this.markTryStackForContext(bounds.tryStackBase, bounds.tryStackPointer);

    // 5. Completion value (if in finally block or error state)
    if (bounds.completionType !== 0 && bounds.completionValue !== 0) {
      this.markValue(bounds.completionValue);
    }

    // 5b. Generator object (header pointer; 0 = not a generator context).
    if (bounds.generatorObject !== 0) {
      this.markObjectByHeaderPointer(bounds.generatorObject);
    }

    // Paused RegExp operation state (header pointer; 0 = none). The
    // NATIVE_CONTINUATION_STATE object's masks trace its buffers.
    if (bounds.regexState !== 0) {
      this.markObjectByHeaderPointer(bounds.regexState);
    }

    // 6. request_base payload — heap pointers the WAT left for the
    //    host to read. The slot whose CTX_EXIT_CONDITION matches a
    //    request_base-bearing exit must keep its referenced object
    //    alive until the host services the yield.
    this.markRequestBaseForContext(slot);
  }

  /**
   * Mark all values on a pending stack range.
   * @param {number} base - Stack base (segment-relative)
   * @param {number} pointer - Stack pointer (segment-relative)
   */
  markPendingStackForContext(base, pointer) {
    for (let addr = base; addr < pointer; addr += VALUE_SIZE) {
      this.markValue(addr);
    }
  }

  /**
   * Mark scopes and native-continuation state from a call stack range.
   * @param {number} base - Stack base (segment-relative)
   * @param {number} pointer - Stack pointer (segment-relative)
   */
  markCallStackForContext(base, pointer) {
    for (let frameAddr = base; frameAddr < pointer; frameAddr += FRAME_SIZE) {
      const absFrameAddr = this.abs(frameAddr);

      // Mark frame's scope (DATA pointer)
      const scopeDataPointer = this.view.getUint32(absFrameAddr + FRAME.SCOPE_POINTER, true);
      if (scopeDataPointer !== 0) {
        this.markObjectByDataPointer(scopeDataPointer);
      }

      const flags = this.view.getUint32(absFrameAddr + FRAME.FLAGS, true);
      if (flags & FRAME_FLAG_NATIVE_CONTINUATION) {
        const continuationKind = this.view.getUint32(
          absFrameAddr + FRAME.CONTINUATION_KIND,
          true,
        );
        if (!NATIVE_CONTINUATION_KINDS.has(continuationKind)) {
          throw new Error(`Unknown native continuation kind ${continuationKind}`);
        }

        const stateHandle = this.view.getUint32(
          absFrameAddr + FRAME.CONTINUATION_STATE_HANDLE,
          true,
        );
        if (stateHandle === 0) {
          throw new Error(`Native continuation ${continuationKind} has no state handle`);
        }
        this.markObjectByHeaderPointer(stateHandle);

        // CONTINUATION_CALLBACK stores the closure's HEADER pointer. It can be
        // the closure's only live reference while native work is suspended.
        const callback = this.view.getUint32(
          absFrameAddr + FRAME.CONTINUATION_CALLBACK,
          true,
        );
        if (callback !== 0) this.markObjectByHeaderPointer(callback);
      } else {
        // Mark CONTINUATION_STATE_4's ordinary-frame meaning: the implicit
        // promise an async function will resolve/reject. Bits 0-1 hold flags
        // (isFinally, originalWasRejected); strip them to get the data pointer.
        // Native continuation frames may use this slot as non-pointer state.
        const asyncPromiseField = this.view.getUint32(
          absFrameAddr + FRAME.CONTINUATION_STATE_4,
          true,
        );
        const asyncPromise = asyncPromiseField & ~3;
        if (asyncPromise !== 0) {
          this.markObjectByDataPointer(asyncPromise);
        }
      }
    }
  }

  /**
   * Mark grant stack entries: the 16-byte identifier value at offset
   * 0 and the entry's saved scope pointer (restored when unwinding
   * into a denied block).
   *
   * The stride MUST be the real GRANT_ENTRY_SIZE from constants. A
   * mismatched local stride would walk mid-entry after entry 0, interpret
   * unrelated words as identifiers, and leave the real later identifiers
   * unmarked.
   *
   * @param {number} base - Stack base (segment-relative)
   * @param {number} pointer - Stack pointer (segment-relative)
   */
  markGrantStackForContext(base, pointer) {
    for (let entryAddr = base; entryAddr < pointer; entryAddr += GRANT_ENTRY_SIZE) {
      // Identifier value is at offset 0, 16 bytes
      this.markValue(entryAddr);
      const scopeDataPointer = this.view.getUint32(
        this.abs(entryAddr + GRANT_ENTRY.SCOPE_POINTER), true);
      if (scopeDataPointer !== 0) {
        this.markObjectByDataPointer(scopeDataPointer);
      }
    }
  }

  /**
   * Mark try stack entries' saved scope pointers. Mirror of
   * `updateTryStackPointersForContext` in the update phase.
   * @param {number} base - Stack base (segment-relative)
   * @param {number} pointer - Stack pointer (segment-relative)
   */
  markTryStackForContext(base, pointer) {
    for (let entryAddr = base; entryAddr < pointer; entryAddr += TRY_ENTRY_SIZE) {
      const scopeDataPointer = this.view.getUint32(
        this.abs(entryAddr + TRY_ENTRY.SCOPE), true);
      if (scopeDataPointer !== 0) {
        this.markObjectByDataPointer(scopeDataPointer);
      }
      // A disarmed holder's pending THROW exception or RETURN value must
      // survive a GC that runs while its finally block executes.
      const completionType = this.view.getUint32(
        this.abs(entryAddr + TRY_ENTRY.COMPLETION_TYPE), true);
      if (completionType === COMPLETION_THROW || completionType === COMPLETION_RETURN) {
        this.markValue(entryAddr + TRY_ENTRY.COMPLETION_VALUE);
      }
    }
  }

  /**
   * Mark heap objects referenced by external_request_base for a
   * specific slot. Only fires if the slot is in one of the four
   * exit conditions whose request_base payload carries a heap
   * pointer. Mirror of `updateRequestBasePointersForContext`.
   *
   * **DEFENSIVE — not currently reachable.** `session.run` and
   * `airlock.runContext` call the matching `handleX` synchronously when
   * the WAT yields one of these four exit conditions, before returning to
   * the host. The host has no public-API window in which to call
   * `engine.gc()` between the WAT yield and the corresponding handler, so
   * the four `request_base` heap pointers are latent fragility rather than
   * an active path.
   *
   * This code is here because:
   *   1. The contract in INTERNALS.md says GC is safe at every
   *      `engine.run` exit. Enforcing it now means future
   *      architectural changes (async-aware host drivers,
   *      per-yield GC triggers) can't accidentally make the gap
   *      reachable.
   *   2. The cost is minimal — one EC read and at most one
   *      pointer-forward per allocated slot per GC cycle.
   *   3. Watermark tests in `tests/fuel/safepoint_gc_audit_test.js`
   *      drive raw `wasm.exports.run` to bypass the synchronous
   *      handleX dispatch and exercise this code path. Without
   *      these forwardings, those tests fail.
   *
   * See INTERNALS.md "Garbage Collector — Safepoint Contract".
   *
   * @param {number} slot - Context slot index
   */
  markRequestBaseForContext(slot) {
    const exitCondition = this.manipulator.getExitCondition(slot);
    const requestBase = this.manipulator.getExternalRequestBase(slot);
    const absReqBase = this.abs(requestBase);

    if (exitCondition === EXIT_AWAIT) {
      // request_base+8 = promise_data_ptr + PROMISE.VALUE on the settled
      // path (isPending=0); mark the promise so it survives + forwards.
      //
      // The request block is per-context, so one slot cannot observe another
      // slot's request payload. The liveness guard below is still required:
      // a slot's own block can hold an earlier settled-await write whose
      // promise has since been freed and its memory reused. That entry is
      // dead data because resume proceeds through the waiter list, so it is
      // safe and necessary to skip it.
      const isPending = this.view.getUint32(absReqBase, true);
      if (isPending === 0) {
        const valuePtr = this.view.getUint32(absReqBase + 8, true);
        if (valuePtr !== 0 && this._isLivePromise(valuePtr - PROMISE.VALUE)) {
          this.markObjectByDataPointer(valuePtr - PROMISE.VALUE);
        }
      }
      return;
    }

    if (exitCondition === EXIT_PROMISE_SETTLE) {
      // request_base+0 = promise data pointer.
      const promisePtr = this.view.getUint32(absReqBase, true);
      if (promisePtr !== 0) {
        this.markObjectByDataPointer(promisePtr);
      }
      return;
    }

    if (exitCondition === EXIT_PROMISE_METHOD) {
      // Layout: [promiseHeaderPointer:4][methodId:4][argsPointer:4][argCount:4]
      // (the WAT's promise-method yield). request_base+0 is a HEADER
      // pointer (TYPE_PROMISE values carry allocate_promise's header) —
      // this used to call markObjectByDataPointer, which setMark'd
      // header-8: a bit-31 flip inside the NEIGHBORING object's last
      // word. Static variants (Promise.all/race/constructor) write 0.
      const promisePtr = this.view.getUint32(absReqBase, true);
      if (promisePtr !== 0) {
        this.markObjectByHeaderPointer(promisePtr);
      }
      // The args sit ABOVE the pre-positioned pending pointer (the WAT
      // restored it to the bound-method slot before yielding), so the
      // normal [base, pointer) stack scan misses them — same shape as
      // the EXIT_EXTERNAL_* case below. For the static variants the
      // args are the whole payload (Promise.all's array of promises);
      // unmarked, the array was collected/moved under the yield and
      // handlePromiseMethod aggregated from stale slots.
      const argsPointer = this.view.getUint32(absReqBase + 8, true);
      const argCount = this.view.getUint32(absReqBase + 12, true);
      for (let argIndex = 0; argIndex < argCount; argIndex++) {
        this.markValue(argsPointer + argIndex * VALUE_SIZE);
      }
      return;
    }

    if (exitCondition === EXIT_ASYNC_CALL) {
      // Layout: [closureHeaderPointer:4][argsPointer:4][argCount:4]
      //         [receiverType:4][receiverFlags:4][receiverLo:4][receiverHi:4]
      // request_base+0 = closure header pointer. The args stay INSIDE
      // the scanned pending range (this yield does not restore the
      // pending pointer), but the method form copies the RECEIVER value
      // into the request block itself — a raw heap pointer with no
      // other root once the pending copy is popped on resume; mark it
      // as the 16-byte VALUE slot it is.
      const closurePtr = this.view.getUint32(absReqBase, true);
      if (closurePtr !== 0) {
        this.markObjectByHeaderPointer(closurePtr);
      }
      this.markValue(requestBase + 12);
      return;
    }

    if (exitCondition === EXIT_EXTERNAL_CALL
        || exitCondition === EXIT_EXTERNAL_PROPERTY
        || exitCondition === EXIT_EXTERNAL_PROPERTY_SET) {
      // Layout: [handleId:4][methodOffset:4][argsPointer:4][argCount:4].
      // handleId is a membrane slot (stable integer) and argsPointer a
      // pending-stack address (fixed memory) — but the payload is NOT
      // pointer-free, contrary to what this safepoint machinery
      // originally assumed:
      //   - methodOffset is an interned-STRING ID. String compaction
      //     moves entries; an unmarked or unforwarded id read post-GC
      //     decodes unrelated bytes as a length prefix or fails outside
      //     the string region.
      //   - the arg value slots sit ABOVE the pre-positioned pending
      //     pointer (the yield already "popped" callable and args), so
      //     the normal [base, pointer) stack scan misses them. Their
      //     heap/string referents must be marked here.
      // String forwarding for both happens in
      // updateRequestBaseStringsForContext (compactStrings phase);
      // heap-pointer forwarding for the args range happens in
      // updateRequestBasePointersForContext.
      const methodOffset = this.view.getUint32(absReqBase + 4, true);
      if (methodOffset !== 0) {
        this.markString(methodOffset);
      }
      const argsPointer = this.view.getUint32(absReqBase + 8, true);
      const argCount = this.view.getUint32(absReqBase + 12, true);
      for (let argIndex = 0; argIndex < argCount; argIndex++) {
        this.markValue(argsPointer + argIndex * VALUE_SIZE);
      }
      // A parked construction operation carries its branded receiver's
      // HEADER pointer at +20. For an abort the duty chain has already been
      // consumed, so this is the receiver's ONLY root; mark it here
      // (forwarding occurs in updateRequestBasePointersForContext). Begin
      // requests reuse +20 for the new.target closure header — also a heap
      // pointer, also marked by the same read. Discriminate on the interned
      // construction method names; ordinary external calls use +16 for the
      // handle version and carry nothing at +20.
      if (exitCondition === EXIT_EXTERNAL_CALL
          && this._isConstructionMethodOffset(methodOffset)) {
        const constructionPointer = this.view.getUint32(absReqBase + 20, true);
        if (constructionPointer !== 0) {
          this.markObjectByHeaderPointer(constructionPointer);
        }
      }
      return;
    }
  }

  /**
   * True iff an EXIT_EXTERNAL_CALL request's methodOffset names one of
   * the three construction operations whose request block carries a heap
   * HEADER pointer at +20.
   */
  _isConstructionMethodOffset(methodOffset) {
    if (methodOffset === 0) return false;
    const beginOffset = this.manipulator.getBuiltinName(BUILTIN_NAME.CONSTRUCT_BEGIN);
    const completeOffset = this.manipulator.getBuiltinName(BUILTIN_NAME.CONSTRUCT_COMPLETE);
    const abortOffset = this.manipulator.getBuiltinName(BUILTIN_NAME.CONSTRUCT_ABORT);
    return methodOffset === beginOffset
      || methodOffset === completeOffset
      || methodOffset === abortOffset;
  }

  /**
   * Mark intrinsic objects stored in state header.
   * These are the built-in prototypes/constructors/registries that
   * must survive GC.
   *
   * RANGE_ERROR_PROTOTYPE, RANGE_ERROR_CONSTRUCTOR, and SYMBOL_REGISTRY
   * are read directly from STATE after collection, so their state cells
   * must keep the objects live and receive forwarding updates. Typed-array
   * prototypes may also be reachable through live typed arrays, but rooting
   * them explicitly avoids depending on that incidental reachability.
   *
   * TEXT_ENCODER_PROTOTYPE and TEXT_DECODER_PROTOTYPE survive transitively
   * through their global constructors but can relocate; constructors that
   * read stale STATE pointers would then install moved-away prototypes.
   * STRING_PROTOTYPE has no other root, so omitting it would leave primitive
   * string symbol dispatch reading a collected object after compaction.
   *
   * The cell list is INTRINSIC_STATE_CELLS in constants.js — one list,
   * consumed here, by `updateIntrinsics`, and by the WAT collector's
   * host-written knowledge table. The full inventory is the set of
   * `setState(STATE.*, <heap pointer>)` calls in memory-image.js — when
   * adding one, add it to the constants.js list and every consumer inherits
   * it.
   *
   * STATE.ROOT_SCOPE is intentionally omitted from the list.
   * The root scope is reached as a transitive root via context 0's
   * CTX_SCOPE chain. If/when context 0 stops referencing it (e.g.,
   * a future feature where the root scope is meant to outlive
   * context 0), the list will need to grow. (It is a scope, not an
   * object — it could not use markObjectByHeaderPointer anyway.
   * Its CELL is still forwarded — see the tail of updateIntrinsics.)
   */
  markIntrinsics() {
    for (const offset of INTRINSIC_STATE_CELLS) {
      const headerPointer = this.manipulator.getState(offset);
      if (headerPointer !== 0) {
        this.markObjectByHeaderPointer(headerPointer);
      }
    }
  }

  /**
   * Mark all strings referenced by code instructions.
   * This prevents string compaction from invalidating code operands.
   *
   * The opcode set is derived from OPCODE_OPERANDS in constants.js
   * (operand1 kind STRING_OFFSET).
   */
  markCodeBlockStrings() {
    const instrCount = this.manipulator.codeBlockInstructionCount();
    if (instrCount === 0) return;
    const codeStart = this.manipulator.getCodeStart();

    // Instructions grow downward from code_start
    // instr_ptr = code_start - (index + 1) * INSTRUCTION_SIZE
    for (let i = 0; i < instrCount; i++) {
      const instrAddr = codeStart - (i + 1) * INSTRUCTION_SIZE;
      const absAddr = this.abs(instrAddr);
      const opcode = this.view.getUint8(absAddr);

      if (STRING_OPERAND_OPCODES.has(opcode)) {
        // operand1 is at offset 8 within the instruction
        const stringOffset = this.view.getUint32(absAddr + 8, true);
        if (stringOffset !== 0) {
          this.markString(stringOffset);
        }
      }
    }
  }

  /**
   * Mark heap objects referenced by code-block instruction operands.
   *
   * The parser allocates BigInt heap objects at parse time and bakes
   * their HEADER pointers into operand1 (LIT_BIGINT for `5n`,
   * LIT_RATIONAL_BIGINT for integer literals beyond i64). The opcode
   * set is derived from OPCODE_OPERANDS in constants.js (operand1
   * kind HEAP_POINTER).
   *
   * These are GC roots in their own right: a literal inside a function
   * body that hasn't executed (or will execute again) has no other
   * reference. Counterpart of `updateCodeBlockHeapOperands`.
   */
  markCodeBlockHeapOperands() {
    const instrCount = this.manipulator.codeBlockInstructionCount();
    if (instrCount === 0) return;
    const codeStart = this.manipulator.getCodeStart();

    for (let i = 0; i < instrCount; i++) {
      const instrAddr = codeStart - (i + 1) * INSTRUCTION_SIZE;
      const absAddr = this.abs(instrAddr);
      const opcode = this.view.getUint8(absAddr);

      if (HEAP_OPERAND_OPCODES.has(opcode)) {
        const headerPointer = this.view.getUint32(absAddr + 8, true);
        if (headerPointer !== 0) {
          this.markObjectByHeaderPointer(headerPointer);
        }
      }
    }
  }

  /**
   * Mark strings referenced from AST nodes.
   *
   * AST nodes carry string-table offsets (identifier names, string
   * literals, bigint digit strings, labels, grant denied-param names).
   * Most are shared with code operands and survive via
   * markCodeBlockStrings — but bigint digit strings are AST-only, and
   * a removed-then-reparsed program can leave AST-only references for
   * anything. Counterpart of `updateAstStrings`.
   */
  markAstStrings() {
    if (!this.manipulator.isAstRegionInitialized()) return;
    const reader = createAstReader(this.manipulator);
    for (const { stringOffset } of reader.iterateStringFields()) {
      this.markString(stringOffset);
    }
  }

  /**
   * Mark all strings in the builtins table.
   * The builtins table stores string offsets for built-in method names.
   */
  markBuiltinStrings() {
    const builtinsBase = this.manipulator.getBuiltinsBase();

    // Walk the entire BUILTINS region. Empty slots (offset 0) are
    // skipped, so iterating the full region is safe even though only
    // a subset of slots are populated. Mirrors `updateBuiltinsStrings`.
    //
    // The walk must cover BUILTINS_SIZE because later slots include Math
    // methods, Promise method names, Symbol-related names, and typed-array
    // names. Any omitted slot can be reclaimed during string compaction when
    // it is not also referenced by the code block, leaving a stale offset in
    // the builtin table.
    const slotCount = BUILTINS_SIZE / 4;

    for (let i = 0; i < slotCount; i++) {
      const slotAddr = builtinsBase + i * 4;
      const absSlotAddr = this.abs(slotAddr);
      const stringOffset = this.view.getUint32(absSlotAddr, true);

      if (stringOffset !== 0) {
        this.markString(stringOffset);
      }
    }
  }

  /**
   * Clear mark bits on all heap objects.
   */
  clearAllMarks() {
    const heapStart = this.manipulator.getHeapStart();
    const heapPointer = this.manipulator.getHeapPointer();

    // Walk by header pointers
    // Note: sizes in headers are actual sizes, not aligned - allocator places
    // objects consecutively without padding
    let headerPointer = heapStart;
    while (headerPointer < heapPointer) {
      const size = this.readHeaderSize(headerPointer);
      if (size === 0) {
        throw new Error(`zero-size heap header at ${headerPointer} before heap pointer ${heapPointer}`);
      }

      this.clearMark(headerPointer);
      this.setForwardingPointer(headerPointer, 0);
      headerPointer += size;
    }
  }

  /**
   * Initialize string mark bitmap.
   *
   * The collector tracks string ids in TABLE-RELATIVE space: an id is
   * the byte offset from string_start to the entry's length prefix.
   * Ids in [0, STRING_DATA_START) are the reserved prefix (never
   * returned as user-facing ids); real interned-string ids start at
   * STRING_DATA_START. The hash index lives at the region TAIL, past
   * the data span.
   */
  initStringMarks() {
    const stringStart = this.manipulator.getStringStart();
    const stringEnd = this.manipulator.getStringEnd();

    // Table-relative position of the first byte of string data. Real
    // interned ids satisfy id >= stringDataStart.
    this.stringDataStart = STRING_DATA_START;

    // One bit per 4 bytes in string data area
    const stringDataSize = (stringEnd - stringStart)
      - hashTableSize(stringEnd - stringStart) - STRING_DATA_START;
    const bitmapSize = Math.ceil(stringDataSize / 4 / 8);
    this.stringMarks = new Uint8Array(bitmapSize);
  }

  /**
   * Mark a string id as live. `id` is table-relative.
   */
  markString(id) {
    if (id === 0 || id < this.stringDataStart) return;

    const relativeOffset = id - this.stringDataStart;
    const bitIndex = Math.floor(relativeOffset / 4);
    const byteIndex = Math.floor(bitIndex / 8);
    const bitPos = bitIndex % 8;

    if (byteIndex < this.stringMarks.length) {
      this.stringMarks[byteIndex] |= (1 << bitPos);
    }
  }

  /**
   * Check if a string id is marked. `id` is table-relative.
   */
  isStringMarked(id) {
    if (id === 0) return true;
    if (id < this.stringDataStart) return true; // In hash table, not data

    const relativeOffset = id - this.stringDataStart;
    const bitIndex = Math.floor(relativeOffset / 4);
    const byteIndex = Math.floor(bitIndex / 8);
    const bitPos = bitIndex % 8;

    if (byteIndex >= this.stringMarks.length) return false;

    return (this.stringMarks[byteIndex] & (1 << bitPos)) !== 0;
  }

  /**
   * Mark a value (16-byte slot) at the given address.
   * @param {number} valueAddr - Address of the value slot
   */
  markValue(valueAddr) {
    const absolutePointer = this.abs(valueAddr);
    const type = this.view.getUint32(absolutePointer, true);

    if (this.valueObserver !== null) {
      const dataLo = this.view.getUint32(absolutePointer + 8, true);
      this.valueObserver(type, dataLo, valueAddr);
    }

    switch (type) {
      case TYPE.ARRAY:
      case TYPE.OBJECT:
      case TYPE.FUNCTION: {
        // Arrays, objects, and functions store HEADER pointers in data_lo
        const headerPointer = this.view.getUint32(absolutePointer + 8, true);
        if (headerPointer !== 0) {
          this.markObjectByHeaderPointer(headerPointer);
        }
        break;
      }
      case TYPE.ACCESSOR: {
        // Accessor property values carry two closure HEADER pointers:
        // getter in data_lo, setter in data_hi; either may be 0.
        const getterPointer = this.view.getUint32(absolutePointer + 8, true);
        if (getterPointer !== 0) {
          this.markObjectByHeaderPointer(getterPointer);
        }
        const setterPointer = this.view.getUint32(absolutePointer + 12, true);
        if (setterPointer !== 0) {
          this.markObjectByHeaderPointer(setterPointer);
        }
        break;
      }
      case TYPE.SCOPE: {
        // Scopes store DATA pointers in data_lo
        const dataPointer = this.view.getUint32(absolutePointer + 8, true);
        if (dataPointer !== 0) {
          this.markObjectByDataPointer(dataPointer);
        }
        break;
      }

      case TYPE.STRING: {
        const strOffset = this.view.getUint32(absolutePointer + 8, true);
        this.markString(strOffset);
        break;
      }

      case TYPE.EXTERNAL_METHOD: {
        // EXTERNAL_METHOD layout: [type:4][flags:4][data_lo:4][data_hi:4]
        // data_lo is a membrane handle slot (stable integer, not a heap
        // pointer). data_hi is the method name's interned-string id —
        // it must be kept live (and forwarded by updateValueStringOffset)
        // or the binding ships a stale id as the external request's
        // methodOffset after string compaction, causing the host to decode
        // unrelated table bytes as a string.
        const nameOffset = this.view.getUint32(absolutePointer + 12, true);
        if (nameOffset !== 0) {
          this.markString(nameOffset);
        }
        break;
      }

      case TYPE.BOUND_METHOD: {
        // BOUND_METHOD layout: [type:4][flags:4][data_lo:4][data_hi:4]
        // The receiver type is in flags' low byte. The data_lo
        // convention matches whatever type the receiver has:
        //   - String receivers: string-table ID (not a heap pointer).
        //   - Msgpack-ref receivers: DATA pointer to the parent ARRAYBUFFER.
        //   - Typed-array receivers: DATA pointer (descriptor).
        //   - Scope receivers: DATA pointer.
        //   - Everything else (Array, Object, Function, Promise, Map,
        //     Set, BigInt, Complex, etc.): HEADER pointer.
        // Every variant must follow the receiver type's pointer convention;
        // applying a single convention would either miss string liveness or
        // mark memory adjacent to a data-pointer receiver.
        const flags = this.view.getUint32(absolutePointer + 4, true);
        const receiverType = flags & 0xff;
        const receiver = this.view.getUint32(absolutePointer + 8, true);
        if (receiver !== 0) {
          if (receiverType === TYPE.STRING) {
            this.markString(receiver);
          } else if (
            receiverType === TYPE.MSGPACK_REF ||
            isTypedArrayType(receiverType) ||
            receiverType === TYPE.SCOPE
          ) {
            this.markObjectByDataPointer(receiver);
          } else {
            this.markObjectByHeaderPointer(receiver);
          }
        }
        break;
      }

      case TYPE.CONSTRUCTOR: {
        // object pointer is in bytes 8-11 (HEADER pointer from allocateObject)
        const headerPointer = this.view.getUint32(absolutePointer + 8, true);
        if (headerPointer !== 0) {
          this.markObjectByHeaderPointer(headerPointer);
        }
        break;
      }

      case TYPE.ARRAYBUFFER: {
        // ArrayBuffer stores DATA pointer in data_lo (offset +8)
        const dataPointer = this.view.getUint32(absolutePointer + 8, true);
        if (dataPointer !== 0) {
          this.markObjectByDataPointer(dataPointer);
        }
        break;
      }

      case TYPE.MSGPACK_REF: {
        // data_lo is a DATA pointer into the parent OBJ.ARRAYBUFFER that
        // holds the encoded msgpack bytes; data_hi is a byte offset within
        // that parent. Only data_lo references the heap.
        const parentDataPointer = this.view.getUint32(absolutePointer + 8, true);
        if (parentDataPointer !== 0) {
          this.markObjectByDataPointer(parentDataPointer);
        }
        break;
      }

      // TypedArray types all store descriptor DATA pointer in data_lo field (offset +8)
      case TYPE.UINT8ARRAY:
      case TYPE.INT8ARRAY:
      case TYPE.UINT8CLAMPEDARRAY:
      case TYPE.INT16ARRAY:
      case TYPE.UINT16ARRAY:
      case TYPE.INT32ARRAY:
      case TYPE.UINT32ARRAY:
      case TYPE.FLOAT32ARRAY:
      case TYPE.FLOAT64ARRAY:
      case TYPE.BIGINT64ARRAY:
      case TYPE.BIGUINT64ARRAY: {
        // TypedArray stores descriptor DATA pointer in data_lo field (offset +8)
        // The descriptor itself will mark the ArrayBuffer when traversed
        const descriptorDataPointer = this.view.getUint32(absolutePointer + 8, true);
        if (descriptorDataPointer !== 0) {
          this.markObjectByDataPointer(descriptorDataPointer);
        }
        break;
      }

      case TYPE.PROMISE_RESOLVE:
      case TYPE.PROMISE_REJECT: {
        // Executor continuations store the target promise DATA pointer in
        // data_lo. They can outlive the executor when user code stores
        // resolve/reject in an object, so the promise must remain live.
        const promiseDataPointer = this.view.getUint32(absolutePointer + 8, true);
        if (promiseDataPointer !== 0) {
          this.markObjectByDataPointer(promiseDataPointer);
        }
        break;
      }

      case TYPE.PROMISE:
      case TYPE.EXPRESSION:
      case TYPE.MATRIX:
      case TYPE.THEOREM:
      case TYPE.ALGEBRAIC:
      case TYPE.COMPLEX_ALGEBRAIC:
      case TYPE.REGEXP:
      case TYPE.SCHEMA: {
        // These values store heap HEADER pointers in data_lo. Their
        // object-specific traversals mark any child references.
        const headerPointer = this.view.getUint32(absolutePointer + 8, true);
        if (headerPointer !== 0) {
          this.markObjectByHeaderPointer(headerPointer);
        }
        break;
      }

      case TYPE.BIGINT: {
        // BigInt stores HEADER pointer in data_lo
        const headerPointer = this.view.getUint32(absolutePointer + 8, true);
        if (headerPointer !== 0) {
          this.markObjectByHeaderPointer(headerPointer);
        }
        break;
      }

      case TYPE.RATIONAL: {
        // Inline Rationals carry an i64 numerator in data_lo/data_hi and
        // do not reference the heap. Skip them.
        const flags = this.view.getUint32(absolutePointer + 4, true);
        if (flags & FLAG_RATIONAL_INLINE) break;
        const headerPointer = this.view.getUint32(absolutePointer + 8, true);
        if (headerPointer !== 0) {
          this.markObjectByHeaderPointer(headerPointer);
        }
        break;
      }

      case TYPE.COMPLEX: {
        // Complex stores HEADER pointer in data_lo
        const headerPointer = this.view.getUint32(absolutePointer + 8, true);
        if (headerPointer !== 0) {
          this.markObjectByHeaderPointer(headerPointer);
        }
        break;
      }

      case TYPE.SYMBOL: {
        // Symbol stores HEADER pointer in data_lo
        const headerPointer = this.view.getUint32(absolutePointer + 8, true);
        if (headerPointer !== 0) {
          this.markObjectByHeaderPointer(headerPointer);
        }
        break;
      }

      case TYPE.MAP:
      case TYPE.SET: {
        // Map/Set value slot — data_lo is the Map/Set header pointer.
        const headerPointer = this.view.getUint32(absolutePointer + 8, true);
        if (headerPointer !== 0) {
          this.markObjectByHeaderPointer(headerPointer);
        }
        break;
      }

      // Other types don't reference heap
    }
  }

  /**
   * Mark a heap object given its HEADER pointer.
   * @param {number} headerPointer - Pointer to GC header
   */
  markObjectByHeaderPointer(headerPointer) {
    // Sanity check
    const heapStart = this.manipulator.getHeapStart();
    const heapPointer = this.manipulator.getHeapPointer();
    if (headerPointer < heapStart || headerPointer >= heapPointer) {
      return;
    }

    // Already marked? Skip to avoid cycles
    if (this.isMarked(headerPointer)) return;

    // Mark this object
    this.setMark(headerPointer);

    // Data is after header
    const dataPointer = headerPointer + GC_HEADER_SIZE;

    // Traverse children based on object type
    const objType = this.readHeaderType(headerPointer);

    switch (objType) {
      case OBJ.ARRAY:
        this.markArray(dataPointer);
        break;

      case OBJ.OBJECT:
        this.markObjectEntries(dataPointer);
        break;

      case OBJ.SCOPE:
        this.markScope(dataPointer);
        break;

      case OBJ.FUNCTION:
        this.markClosure(dataPointer);
        break;

      case OBJ.ARRAY_DATA:
        // Elements are marked by markArray when processing the parent ARRAY,
        // bounded by the array's `length`. We must NOT re-walk here: this
        // standalone case has only the data block, not the parent header, so
        // it would have to derive the count from the block's GC size — i.e.
        // walk to capacity, reading unwritten tail slots [length, capacity)
        // as live values. Same pattern as SCOPE_ENTRIES below: the parent
        // walks the entries and the standalone case is a no-op.
        break;

      case OBJ.PARAM_LIST:
        this.markParamList(dataPointer);
        break;

      case OBJ.ARRAYBUFFER:
        // ArrayBuffer has no internal pointers to mark (just raw bytes)
        break;

      case OBJ.TYPED_ARRAY_DESCRIPTOR: {
        // Descriptor: [bufferPtr:4][byteOffset:4][length:4][sym_entries:4]
        // Mark the underlying ArrayBuffer
        const bufferPtr = this.view.getUint32(this.abs(dataPointer), true);
        if (bufferPtr !== 0) {
          this.markObjectByDataPointer(bufferPtr);
        }
        // Own symbol-keyed properties.
        this.markSymEntriesBlock(this.view.getUint32(this.abs(dataPointer + 12), true));
        break;
      }

      case OBJ.SCOPE_ENTRIES:
        // Scope entries are marked via markScope when processing the parent SCOPE
        // Do NOT process here - scope entries are 20-byte, not 16-byte VALUE slots
        break;

      case OBJ.PROMISE:
        this.markPromise(dataPointer);
        break;

      case OBJ.PROMISE_WAITER:
        this.markPromiseWaiter(dataPointer);
        break;

      case OBJ.THEN_HANDLER:
        this.markThenHandler(dataPointer);
        break;

      case OBJ.BIGINT:
        // Leaf object — no internal pointers to trace
        break;

      case OBJ.RATIONAL: {
        // Rational: [header: 8][numeratorPointer: 4][denominatorPointer: 4]
        // Mark both BigInt children.
        const numeratorPointer = this.view.getUint32(this.abs(dataPointer), true);
        const denominatorPointer = this.view.getUint32(this.abs(dataPointer + 4), true);
        if (numeratorPointer !== 0) this.markObjectByHeaderPointer(numeratorPointer);
        if (denominatorPointer !== 0) this.markObjectByHeaderPointer(denominatorPointer);
        break;
      }

      case OBJ.COMPLEX: {
        // Complex: [header: 8][realPointer: 4][imaginaryPointer: 4]
        // Mark both Rational children.
        const realPointer = this.view.getUint32(this.abs(dataPointer), true);
        const imaginaryPointer = this.view.getUint32(this.abs(dataPointer + 4), true);
        if (realPointer !== 0) this.markObjectByHeaderPointer(realPointer);
        if (imaginaryPointer !== 0) this.markObjectByHeaderPointer(imaginaryPointer);
        break;
      }

      case OBJ.SYMBOL: {
        // Symbol: [header: 8][descriptionStringOffset: 4][reserved: 4]
        // The description is an interned-string id and MUST be marked:
        // interned strings are collected and compacted like everything
        // else (the previous comment here assumed a permanent intern
        // table — that world ended when compactStrings landed). Unmarked,
        // a description whose only reference is the symbol was collected;
        // unforwarded (see updateObjectStringOffsets' OBJ.SYMBOL case),
        // it dangled after every move. Found by auditStringReferences on
        // the built-in well-known symbols after one collection.
        const descriptionOffset = this.view.getUint32(this.abs(dataPointer), true);
        if (descriptionOffset !== 0) {
          this.markString(descriptionOffset);
        }
        break;
      }

      case OBJ.EXPRESSION: {
        // Expression: [header: 8][headPointer: 4][argumentArrayPointer: 4]
        // Mark the head Symbol and the argument Array; the array's elements
        // are marked transitively via the OBJ.ARRAY case when that array
        // gets walked.
        const headPointer = this.view.getUint32(this.abs(dataPointer), true);
        const argumentArrayPointer = this.view.getUint32(this.abs(dataPointer + 4), true);
        if (headPointer !== 0) this.markObjectByHeaderPointer(headPointer);
        if (argumentArrayPointer !== 0) this.markObjectByHeaderPointer(argumentArrayPointer);
        break;
      }

      case OBJ.MATRIX: {
        // Matrix: [header: 8][rowCount: 4][columnCount: 4]
        // [entriesArrayPointer: 4][reserved: 4] — Ring 4. Only the entries
        // Array (HEADER pointer at data+8) is an edge; its elements are
        // marked transitively via the OBJ.ARRAY case.
        const entriesArrayPointer = this.view.getUint32(this.abs(dataPointer + 8), true);
        if (entriesArrayPointer !== 0) this.markObjectByHeaderPointer(entriesArrayPointer);
        break;
      }

      case OBJ.THEOREM: {
        // Proof handles own their artifact and, for scoped levels/terms,
        // the universe-owner buffer. Index and kind are scalars.
        const artifactBufferDataPointer =
          this.view.getUint32(this.abs(dataPointer), true);
        if (artifactBufferDataPointer !== 0) {
          this.markObjectByDataPointer(artifactBufferDataPointer);
        }
        const universeOwnerDataPointer =
          this.view.getUint32(this.abs(dataPointer + 12), true);
        if (universeOwnerDataPointer !== 0) {
          this.markObjectByDataPointer(universeOwnerDataPointer);
        }
        break;
      }

      case OBJ.REGEXP: {
        // RegExp descriptor: [patternStringOffset:4][flagsBitfield:4]
        // [lastIndex:4][programBufferDataPointer:4]. The pattern is an
        // interned-string id and MUST be marked (interned strings are
        // collected and compacted — see the OBJ.SYMBOL case). The
        // program buffer uses the ArrayBuffer DATA-pointer convention
        // and is zero until compilation commits. Flags and lastIndex
        // are scalars.
        const patternStringOffset =
          this.view.getUint32(this.abs(dataPointer + REGEXP.PATTERN_STRING), true);
        if (patternStringOffset !== 0) {
          this.markString(patternStringOffset);
        }
        const programBufferDataPointer =
          this.view.getUint32(this.abs(dataPointer + REGEXP.PROGRAM_BUFFER), true);
        if (programBufferDataPointer !== 0) {
          this.markObjectByDataPointer(programBufferDataPointer);
        }
        break;
      }

      case OBJ.SCHEMA: {
        // Schema descriptor: a 16-byte source value slot at data+0
        // (object, boolean, or msgpack ref — traced like an array
        // element) and the program ArrayBuffer DATA pointer at data+16;
        // options, limits, and compile fuel are scalars.
        this.markValue(dataPointer + SCHEMA.SOURCE);
        const schemaProgramPointer =
          this.view.getUint32(this.abs(dataPointer + SCHEMA.PROGRAM_BUFFER), true);
        if (schemaProgramPointer !== 0) {
          this.markObjectByDataPointer(schemaProgramPointer);
        }
        break;
      }

      case OBJ.ALGEBRAIC: {
        // AlgebraicNumber: [header: 8][coefficientsArrayPointer: 4]
        // [intervalArrayPointer: 4][fieldGeneratorPointer: 4]
        // [coordinatesArrayPointer: 4]. The field pair is zero for a
        // standalone generator.
        const coefficientsArrayPointer = this.view.getUint32(this.abs(dataPointer), true);
        const intervalArrayPointer = this.view.getUint32(this.abs(dataPointer + 4), true);
        const fieldGeneratorPointer = this.view.getUint32(this.abs(dataPointer + 8), true);
        const coordinatesArrayPointer = this.view.getUint32(this.abs(dataPointer + 12), true);
        if (coefficientsArrayPointer !== 0) this.markObjectByHeaderPointer(coefficientsArrayPointer);
        if (intervalArrayPointer !== 0) this.markObjectByHeaderPointer(intervalArrayPointer);
        if (fieldGeneratorPointer !== 0) this.markObjectByHeaderPointer(fieldGeneratorPointer);
        if (coordinatesArrayPointer !== 0) this.markObjectByHeaderPointer(coordinatesArrayPointer);
        break;
      }

      case OBJ.COMPLEX_ALGEBRAIC: {
        // ComplexAlgebraicNumber: two HEADER-pointer edges naming exact-real
        // BigInt, Rational, or AlgebraicNumber component values.
        const realPointer = this.view.getUint32(this.abs(dataPointer), true);
        const imaginaryPointer = this.view.getUint32(this.abs(dataPointer + 4), true);
        if (realPointer !== 0) this.markObjectByHeaderPointer(realPointer);
        if (imaginaryPointer !== 0) this.markObjectByHeaderPointer(imaginaryPointer);
        break;
      }
      case OBJ.NATIVE_CONTINUATION_STATE: {
        const headerPointerMask = this.view.getUint32(this.abs(dataPointer), true);
        const dataPointerMask = this.view.getUint32(this.abs(dataPointer + 4), true);
        if ((headerPointerMask & dataPointerMask) !== 0) {
          throw new Error("Native continuation state pointer masks overlap");
        }
        for (let stateIndex = 0; stateIndex < 5; stateIndex++) {
          const pointer = this.view.getUint32(
            this.abs(dataPointer + 8 + stateIndex * 4),
            true,
          );
          if (pointer === 0) continue;
          if (headerPointerMask & (1 << stateIndex)) {
            this.markObjectByHeaderPointer(pointer);
          } else if (dataPointerMask & (1 << stateIndex)) {
            this.markObjectByDataPointer(pointer);
          }
        }
        break;
      }


      case OBJ.MAP:
      case OBJ.SET: {
        // Map/Set header: [size:4][slotCount:4][capacity:4][entriesHeader:4][sym_entries:4].
        const slotCount = this.view.getUint32(this.abs(dataPointer + 4), true);
        const entriesHeader = this.view.getUint32(this.abs(dataPointer + 12), true);
        if (entriesHeader !== 0) {
          // Mark the entries block live, then walk its slots HERE, bounded by
          // the header's slotCount. The entries block is also dispatched as
          // OBJ.MAP_ENTRIES / OBJ.SET_ENTRIES in the heap walk, but that
          // standalone case has only the block (not slotCount) and would walk
          // to capacity over unwritten tail slots — so it is a no-op below and
          // the live-count-bounded walk lives here. markObjectByHeaderPointer
          // keeps the heap-bounds and cycle checks; it dispatches into the
          // no-op MAP_ENTRIES/SET_ENTRIES case.
          this.markObjectByHeaderPointer(entriesHeader);
          const entriesData = entriesHeader + GC_HEADER_SIZE;
          if (objType === OBJ.MAP) {
            // Per-slot: [tombstone:4][key:16][value:16] = 36 bytes. Tombstoned
            // slots live within [0, slotCount) and still carry heap references
            // we mark conservatively to keep them reachable until compaction.
            for (let i = 0; i < slotCount; i++) {
              const slotAddr = entriesData + i * 36;
              this.markValue(slotAddr + 4);    // key
              this.markValue(slotAddr + 20);   // value
            }
          } else {
            // Per-slot: [tombstone:4][value:16] = 20 bytes.
            for (let i = 0; i < slotCount; i++) {
              this.markValue(entriesData + i * 20 + 4);  // value
            }
          }
        }
        // Own symbol-keyed properties.
        this.markSymEntriesBlock(this.view.getUint32(this.abs(dataPointer + 16), true));
        break;
      }

      case OBJ.MAP_ENTRIES:
      case OBJ.SET_ENTRIES:
        // Slots are marked by the parent OBJ.MAP / OBJ.SET case, bounded by
        // the header's slotCount. No standalone walk here — see the note in
        // that case.
        break;

      case OBJ.CONTEXT:
      case OBJ.STACK_BLOCK:
        // Leaf for the type walker. A context object's pointer fields (stack
        // bases, scope) and a stack block's contents (values / frames) are
        // marked explicitly by markContextRoots when the slot is walked as a
        // root — not recursed here. Reaching one here (e.g. a stale pointer)
        // just keeps the block live; nothing to trace.
        break;
    }
  }

  /**
   * Mark a heap object given its DATA pointer.
   * @param {number} dataPointer - Pointer to object data (after GC header)
   */
  markObjectByDataPointer(dataPointer) {
    this.markObjectByHeaderPointer(dataPointer - GC_HEADER_SIZE);
  }

  /**
   * True iff `dataPointer` addresses a live in-heap object whose GC header
   * type is PROMISE. Used by the EXIT_AWAIT safepoint to distinguish a
   * CURRENT settled-await payload (points at a real promise) from a STALE one
   * whose promise was freed and its memory reused. See
   * markRequestBaseForContext for why stale payloads are dead data.
   * @param {number} dataPointer - candidate promise DATA pointer
   * @returns {boolean}
   */
  _isLivePromise(dataPointer) {
    const headerPointer = dataPointer - GC_HEADER_SIZE;
    const heapStart = this.manipulator.getHeapStart();
    const heapPointer = this.manipulator.getHeapPointer();
    if (headerPointer < heapStart || headerPointer >= heapPointer) return false;
    const header = this.view.getUint32(this.abs(headerPointer), true);
    return ((header >>> 24) & 0x7f) === OBJ.PROMISE;
  }

  /**
   * Mark array elements and data block.
   * @param {number} dataPointer - Pointer to array data
   */
  markArray(dataPointer) {
    const absoluteDataPointer = this.abs(dataPointer);

    // Array layout (data-relative): [length:4][capacity:4][data_ptr:4][flags:4][sym_entries:4]
    const length = this.view.getUint32(absoluteDataPointer, true);
    const dataBlockHeaderPointer = this.view.getUint32(absoluteDataPointer + 8, true);

    // Own symbol-keyed properties.
    this.markSymEntriesBlock(this.view.getUint32(absoluteDataPointer + 16, true));

    // Mark the data block (data_ptr is a HEADER pointer)
    if (dataBlockHeaderPointer !== 0) {
      // Sanity check: data_ptr should be in heap
      const heapStart = this.manipulator.getHeapStart();
      const heapPointer = this.manipulator.getHeapPointer();
      if (dataBlockHeaderPointer < heapStart || dataBlockHeaderPointer >= heapPointer) {
        return;
      }

      this.setMark(dataBlockHeaderPointer);

      // Data starts after GC header
      const dataBlockDataPointer = dataBlockHeaderPointer + GC_HEADER_SIZE;

      // Mark each element
      for (let i = 0; i < length; i++) {
        const elemAddr = dataBlockDataPointer + i * VALUE_SIZE;
        this.markValue(elemAddr);
      }
    }
  }

  /**
   * Mark object entries.
   * @param {number} dataPointer - Pointer to object data (after GC header)
   */
  markObjectEntries(dataPointer) {
    const absoluteDataPointer = this.abs(dataPointer);
    const entrySize = 20;

    // Object data layout (data-relative): [prototype:4][count:4][capacity:4][flags:4][entries:4][sym_entries:4]
    const prototypeHeaderPointer = this.view.getUint32(absoluteDataPointer, true);
    const count = this.view.getUint32(absoluteDataPointer + 4, true);
    const entriesHeaderPointer = this.view.getUint32(absoluteDataPointer + 16, true);
    const symEntriesHeaderPointer = this.view.getUint32(absoluteDataPointer + 20, true);

    // BigInt wrapper objects use an extended 48-byte object header. Their
    // internal [[BigIntData]] header pointer lives at data-relative +24.
    const objectHeader =
      this.view.getUint32(this.abs(dataPointer - GC_HEADER_SIZE), true);
    const objectHeaderSize = objectHeader & 0x00ffffff;
    if (objectHeaderSize > 32) {
      const bigintHeaderPointer =
        this.view.getUint32(absoluteDataPointer + 24, true);
      if (bigintHeaderPointer !== 0) {
        this.markObjectByHeaderPointer(bigintHeaderPointer);
      }
    }

    // Mark prototype if present (prototype is a HEADER pointer)
    if (prototypeHeaderPointer !== 0) {
      this.markObjectByHeaderPointer(prototypeHeaderPointer);
    }

    // String-keyed entries.
    if (entriesHeaderPointer !== 0) {
      this.setMark(entriesHeaderPointer);
      const entriesDataPointer = entriesHeaderPointer + GC_HEADER_SIZE;
      // Entry layout: [key_offset:4][type:4][flags:4][data_lo:4][data_hi:4]
      for (let i = 0; i < count; i++) {
        const entryAddr = entriesDataPointer + i * entrySize;
        const absEntryAddr = this.abs(entryAddr);
        const keyOffset = this.view.getUint32(absEntryAddr, true);
        this.markString(keyOffset);
        this.markValue(entryAddr + 4);
      }
    }

    // Symbol-keyed entries.
    this.markSymEntriesBlock(symEntriesHeaderPointer);
  }

  /**
   * Mark a sym-entries block and its contents. Shared by every receiver
   * kind that carries own symbol-keyed properties (objects, functions,
   * arrays, typed arrays, Map, Set).
   * Block layout: [GC:8][sym_count:4][sym_capacity:4][entries...] —
   * entries start at block + 16, 20 bytes each.
   * @param {number} symEntriesHeaderPointer - HEADER pointer of the block (0 = none)
   */
  markSymEntriesBlock(symEntriesHeaderPointer) {
    if (symEntriesHeaderPointer === 0) return;
    // Defense in depth: sym_entries is read directly from the receiver's data
    // block (for example, markArray reads offset +16) with no bounds check at
    // the call site, unlike the array DATA-block pointer. If an out-of-band
    // write clobbers sym_entries, following it would throw out of bounds
    // mid-mark and obscure the corrupting write behind the collection that
    // discovered it. Skip the invalid block and, under SANDSCRIPT_GC_ASSERT,
    // log the offending pointer to preserve an attributable diagnostic.
    const heapStart = this.manipulator.getHeapStart();
    const heapPointer = this.manipulator.getHeapPointer();
    if (symEntriesHeaderPointer < heapStart || symEntriesHeaderPointer >= heapPointer) {
      if (this._gcAssertEnabled === undefined) {
        try { this._gcAssertEnabled = Deno?.env?.get?.('SANDSCRIPT_GC_ASSERT') === '1'; }
        catch { this._gcAssertEnabled = false; }
      }
      if (this._gcAssertEnabled) {
        console.error(
          `GC-MARK: sym_entries pointer ${symEntriesHeaderPointer} ` +
          `(0x${(symEntriesHeaderPointer >>> 0).toString(16)}) out of heap ` +
          `[${heapStart}, ${heapPointer}) — clobbered receiver header; skipping`);
      }
      return;
    }
    this.setMark(symEntriesHeaderPointer);
    const symBlockData = symEntriesHeaderPointer + GC_HEADER_SIZE;
    const symCount = this.view.getUint32(this.abs(symBlockData), true);
    const symEntriesStart = symBlockData + 8;  // skip sym_count + sym_capacity
    for (let i = 0; i < symCount; i++) {
      const entryAddr = symEntriesStart + i * 20;
      // Key is a HEADER pointer to a symbol heap object.
      const symbolHeaderPointer = this.view.getUint32(this.abs(entryAddr), true);
      if (symbolHeaderPointer !== 0) {
        this.markObjectByHeaderPointer(symbolHeaderPointer);
      }
      this.markValue(entryAddr + 4);
    }
  }

  /**
   * Mark scope.
   * @param {number} dataPointer - Pointer to scope data
   */
  markScope(dataPointer) {
    const absoluteDataPointer = this.abs(dataPointer);

    // Scope layout: [parent:4][count:4][capacity:4][entries:4]
    const parentDataPointer = this.view.getUint32(absoluteDataPointer, true);
    const count = this.view.getUint32(absoluteDataPointer + 4, true);
    const entriesHeaderPointer = this.view.getUint32(absoluteDataPointer + 12, true);

    // Mark parent scope
    if (parentDataPointer !== 0) {
      this.markObjectByDataPointer(parentDataPointer);
    }

    // Mark entries block (entries is a HEADER pointer)
    if (entriesHeaderPointer !== 0) {
      this.setMark(entriesHeaderPointer);

      // Entry data starts after GC header
      const entriesDataPointer = entriesHeaderPointer + GC_HEADER_SIZE;

      // Entry layout: [key:4][type:4][flags:4][data_lo:4][data_hi:4] = 20 bytes
      for (let i = 0; i < count; i++) {
        const entryAddr = entriesDataPointer + i * 20;
        const absEntryAddr = this.abs(entryAddr);

        // Key is a string offset
        const keyOffset = this.view.getUint32(absEntryAddr, true);
        this.markString(keyOffset);

        // Value starts at entry + 4
        this.markValue(entryAddr + 4);
      }
    }
  }

  /**
   * Mark function (hybrid object-closure).
   * @param {number} dataPointer - Pointer to function data
   */
  markClosure(dataPointer) {
    const absoluteDataPointer = this.abs(dataPointer);

    // Function layout (data-relative): [proto:4][count:4][capacity:4][flags:4][entries:4][sym_entries:4][start:4][end:4][scope:4][function_flags:4]
    // First 24 bytes are object header - reuse markObjectEntries
    this.markObjectEntries(dataPointer);

    // Scope is at data-relative offset 32 (after object header + start + end)
    const scopeDataPointer = this.view.getUint32(absoluteDataPointer + 32, true);

    if (scopeDataPointer !== 0) {
      this.markObjectByDataPointer(scopeDataPointer);
    }
  }

  /**
   * Mark promise value.
   * @param {number} dataPointer - Pointer to promise data
   */
  markPromise(dataPointer) {
    const absoluteDataPointer = this.abs(dataPointer);

    // Promise layout: [status:4][value:16][waiters:4]
    // The value field is a standard 16-byte VALUE slot — mark it through
    // the canonical walker. The old bespoke switch here was a drifted
    // REDUCED copy of markValue: it treated typed-array/ArrayBuffer
    // values (DATA pointers) as HEADER pointers — a misdispatched
    // setMark that flips bit 31 inside another object's interior — and
    // silently skipped BigInt/Rational/Complex/Map/Set/msgpack-ref/
    // string values entirely (collected alive). Duplicated value
    // switches drift; markValue is the single authority.
    this.markValue(dataPointer + PROMISE.VALUE);

    const waitersHead = this.view.getUint32(
      absoluteDataPointer + PROMISE.WAITERS, true);
    if (waitersHead !== 0) this.markObjectByDataPointer(waitersHead);

    // Trace handler list (.then/.catch/.finally handlers)
    const handlersHead = this.view.getInt32(absoluteDataPointer + PROMISE.HANDLERS, true);
    if (handlersHead !== -1) {
      this.markObjectByDataPointer(handlersHead);
    }
  }

  markPromiseWaiter(dataPointer) {
    const next = this.view.getUint32(
      this.abs(dataPointer + PROMISE_WAITER.NEXT), true);
    if (next !== 0) this.markObjectByDataPointer(next);
  }

  /**
   * Mark a ThenHandler and its references.
   * @param {number} dataPointer - Pointer to handler data
   */
  markThenHandler(dataPointer) {
    const absoluteDataPointer = this.abs(dataPointer);

    // Trace onResolved closure
    const onResolved = this.view.getUint32(absoluteDataPointer + THEN_HANDLER.ON_RESOLVED, true);
    if (onResolved !== 0) {
      this.markObjectByHeaderPointer(onResolved);
    }

    // Trace onRejected closure
    const onRejected = this.view.getUint32(absoluteDataPointer + THEN_HANDLER.ON_REJECTED, true);
    if (onRejected !== 0) {
      this.markObjectByHeaderPointer(onRejected);
    }

    // Trace child promise
    const childPromise = this.view.getUint32(absoluteDataPointer + THEN_HANDLER.CHILD_PROMISE, true);
    if (childPromise !== 0) {
      this.markObjectByDataPointer(childPromise);
    }

    // Trace next handler in list
    const next = this.view.getInt32(absoluteDataPointer + THEN_HANDLER.NEXT, true);
    if (next !== -1) {
      this.markObjectByDataPointer(next);
    }
  }

  /**
   * Mark param list.
   * @param {number} dataPointer - Pointer to param list data
   */
  markParamList(dataPointer) {
    const absoluteDataPointer = this.abs(dataPointer);

    // Param list layout: [count:4][offset:4][offset:4]...
    const count = this.view.getUint32(absoluteDataPointer, true);

    for (let i = 0; i < count; i++) {
      const offset = this.view.getUint32(absoluteDataPointer + 4 + i * 4, true);
      this.markString(offset);
    }
  }

  // ===========================================================================
  // Phase 2-4: Heap Compaction
  // ===========================================================================

  /**
   * Compact the heap by moving live objects to the beginning.
   */
  compactHeap() {
    const heapStart = this.manipulator.getHeapStart();
    const oldHeapPointer = this.manipulator.getHeapPointer();

    // Phase 2: Compute forwarding addresses
    this.computeForwardingAddresses();

    // Build forwarding map for external roots BEFORE moving objects
    // (moveObjects clears forwarding pointers)
    const forwarding = this.buildExternalForwarding();

    // Phase 3: Update all pointers
    this.updatePointers();

    // Phase 4: Move objects
    const newHeapPointer = this.moveObjects();

    const heapRetained = newHeapPointer - heapStart;
    const heapCollected = oldHeapPointer - newHeapPointer;

    return { heapRetained, heapCollected, forwarding };
  }

  /**
   * Build forwarding map for external roots.
   * Must be called after computeForwardingAddresses but before moveObjects.
   *
   * @returns {Map<number, number>} - Map from old HEADER pointer to new HEADER pointer
   */
  buildExternalForwarding() {
    const forwarding = new Map();

    for (const oldHeaderPointer of this.externalRoots) {
      if (oldHeaderPointer === 0) continue;

      const newHeaderPointer = this.getNewHeaderPointer(oldHeaderPointer);
      if (newHeaderPointer !== oldHeaderPointer) {
        forwarding.set(oldHeaderPointer, newHeaderPointer);
      }
    }

    return forwarding;
  }

  /**
   * Compute forwarding addresses for all live objects.
   * Forwarding addresses are HEADER pointers.
   */
  computeForwardingAddresses() {
    const heapStart = this.manipulator.getHeapStart();
    const heapPointer = this.manipulator.getHeapPointer();

    let readHeaderPointer = heapStart;
    let writeHeaderPointer = heapStart;

    while (readHeaderPointer < heapPointer) {
      const size = this.readHeaderSize(readHeaderPointer);
      if (size === 0) {
        throw new Error(`zero-size heap header at ${readHeaderPointer} before heap pointer ${heapPointer}`);
      }

      if (this.isMarked(readHeaderPointer)) {
        // Live object - record where it will move to
        this.setForwardingPointer(readHeaderPointer, writeHeaderPointer);
        writeHeaderPointer += size;
      }

      readHeaderPointer += size;
    }
  }

  /**
   * Update all pointers to use forwarding addresses.
   */
  updatePointers() {
    const heapStart = this.manipulator.getHeapStart();
    const heapPointer = this.manipulator.getHeapPointer();

    // Update pointers in heap objects
    let headerPointer = heapStart;
    while (headerPointer < heapPointer) {
      const size = this.readHeaderSize(headerPointer);
      if (size === 0) {
        throw new Error(`zero-size heap header at ${headerPointer} before heap pointer ${heapPointer}`);
      }

      if (this.isMarked(headerPointer)) {
        this.updateObjectPointers(headerPointer);
      }

      headerPointer += size;
    }

    // Update root pointers in ALL allocated contexts
    const allocatedContexts = this.getAllocatedContexts();

    for (const slot of allocatedContexts) {
      this.updateContextPointers(slot);
    }

    // Update intrinsic state pointers — same set markIntrinsics walks.
    // In practice these objects are allocated first and never relocate
    // (compaction moves objects toward heap start; objects already
    // there stay put). But forwarding them is cheap and keeps the
    // contract honest if heap layout ever changes.
    this.updateIntrinsics();

    // Forward heap pointers baked into code operands (parse-time
    // bigint literals). Mirror of `markCodeBlockHeapOperands`.
    this.updateCodeBlockHeapOperands();
  }

  /**
   * Forward heap HEADER pointers in code-block instruction operands.
   * Same opcodes as `markCodeBlockHeapOperands` (derived from
   * OPCODE_OPERANDS). Must run after `computeForwardingAddresses` and
   * before `moveObjects`.
   */
  updateCodeBlockHeapOperands() {
    const instrCount = this.manipulator.codeBlockInstructionCount();
    if (instrCount === 0) return;
    const codeStart = this.manipulator.getCodeStart();

    for (let i = 0; i < instrCount; i++) {
      const instrAddr = codeStart - (i + 1) * INSTRUCTION_SIZE;
      const absAddr = this.abs(instrAddr);
      const opcode = this.view.getUint8(absAddr);

      if (HEAP_OPERAND_OPCODES.has(opcode)) {
        const oldHeaderPointer = this.view.getUint32(absAddr + 8, true);
        if (oldHeaderPointer !== 0) {
          const newHeaderPointer = this.getNewHeaderPointer(oldHeaderPointer);
          if (newHeaderPointer !== oldHeaderPointer) {
            this.view.setUint32(absAddr + 8, newHeaderPointer, true);
          }
        }
      }
    }
  }

  /**
   * Forward STATE pointers for intrinsic prototypes/constructors/
   * registries. Mirror of `markIntrinsics`; the two must stay in sync.
   */
  updateIntrinsics() {
    for (const offset of INTRINSIC_STATE_CELLS) {
      const oldHeaderPointer = this.manipulator.getState(offset);
      if (oldHeaderPointer !== 0) {
        const newHeaderPointer = this.getNewHeaderPointer(oldHeaderPointer);
        if (newHeaderPointer !== oldHeaderPointer) {
          this.view.setUint32(this.abs(offset), newHeaderPointer, true);
        }
      }
    }

    // STATE.ROOT_SCOPE holds a scope DATA pointer (not a header pointer, so it
    // can't ride the loop above). It is marked transitively via context 0's
    // CTX_SCOPE, but the cell itself still needs forwarding: once compaction
    // relocates the root scope, a stale cell would make getRootScope() return
    // the moved-away address.
    const oldRootScope = this.manipulator.getState(STATE.ROOT_SCOPE);
    if (oldRootScope !== 0) {
      const newRootScope = this.getNewDataPointer(oldRootScope);
      if (newRootScope !== oldRootScope) {
        this.view.setUint32(this.abs(STATE.ROOT_SCOPE), newRootScope, true);
        writeHeaderEventRingEntry(this.view, this.baseOffset, {
          kind: HEADER_EVENT_KIND.FIELD_WRITE,
          field: HEADER_EVENT_FIELD.ROOT_SCOPE,
          site: HEADER_EVENT_SITE.JS_COLLECTOR_UPDATE_INTRINSICS,
          oldValue: oldRootScope,
          newValue: newRootScope,
        });
      }
    }

    // STATE.CONTEXT_TABLE_POINTER holds the slot→pointer table's DATA
    // pointer — same forwarding rule as ROOT_SCOPE. Ordering matters:
    // updateIntrinsics runs AFTER the updateContextPointers loop, whose
    // setContextPointer writes resolve the table through this cell and
    // need the OLD address (moveObjects hasn't copied the bytes yet).
    const oldTable = this.manipulator.getContextTablePointer();
    const newTable = this.getNewDataPointer(oldTable);
    if (newTable !== oldTable) {
      this.view.setUint32(this.abs(STATE.CONTEXT_TABLE_POINTER), newTable, true);
      writeHeaderEventRingEntry(this.view, this.baseOffset, {
        kind: HEADER_EVENT_KIND.FIELD_WRITE,
        field: HEADER_EVENT_FIELD.CONTEXT_TABLE_POINTER,
        site: HEADER_EVENT_SITE.JS_COLLECTOR_UPDATE_INTRINSICS,
        oldValue: oldTable,
        newValue: newTable,
      });
    }

    const oldGenerationTable =
      this.manipulator.getContextGenerationTablePointer();
    const newGenerationTable = this.getNewDataPointer(oldGenerationTable);
    if (newGenerationTable !== oldGenerationTable) {
      this.view.setUint32(
        this.abs(STATE.CONTEXT_GENERATION_TABLE_POINTER),
        newGenerationTable,
        true,
      );
    }
  }

  /**
   * Update all root pointers in a specific context.
   * @param {number} slot - Context slot index
   */
  updateContextPointers(slot) {
    const bounds = this.getContextStackBounds(slot);
    const base = this.manipulator.getContextBase(slot);
    const stateBase = base + CONTEXT_STATE_OFFSET;
    const absStateBase = this.abs(stateBase);

    // Forward the heap pointer VALUES stored inside each stack first, using the
    // OLD bounds. Memory hasn't physically moved yet (moveObjects runs last),
    // so the old addresses are still readable here.
    this.updatePendingStackPointersForContext(bounds.pendingBase, bounds.pendingPointer);
    this.updateCallStackPointersForContext(bounds.callStackBase, bounds.callStackPointer);
    this.updateGrantStackPointersForContext(bounds.grantStackBase, bounds.grantStackPointer);
    this.updateTryStackPointersForContext(bounds.tryStackBase, bounds.tryStackPointer);

    // Scope (DATA pointer)
    if (bounds.scope !== 0) {
      const newDataPointer = this.getNewDataPointer(bounds.scope);
      if (newDataPointer !== bounds.scope) {
        this.view.setUint32(absStateBase + CTX.SCOPE, newDataPointer, true);
      }
    }

    // Completion value
    if (bounds.completionType !== 0 && bounds.completionValue !== 0) {
      this.updateValuePointer(bounds.completionValue);
    }

    // Generator object (header pointer)
    if (bounds.generatorObject !== 0) {
      const newHeaderPointer = this.getNewHeaderPointer(bounds.generatorObject);
      if (newHeaderPointer !== bounds.generatorObject) {
        this.view.setUint32(absStateBase + CTX.GENERATOR_OBJECT, newHeaderPointer, true);
      }
    }

    // Paused RegExp operation state (header pointer)
    if (bounds.regexState !== 0) {
      const newRegexState = this.getNewHeaderPointer(bounds.regexState);
      if (newRegexState !== bounds.regexState) {
        this.view.setUint32(absStateBase + CTX.REGEX_STATE, newRegexState, true);
      }
    }

    // Stack blocks move under compaction. Rewrite each stack's base, limit,
    // and top pointer to its new block address. A stack's contents move WITH
    // the block, so preserve the top's offset:
    // newTop = newBase + (oldTop - oldBase). Do this AFTER the content
    // forwarders above, which need the old base and top.
    this._forwardStackBlock(absStateBase, CTX.PENDING_BASE, CTX.PENDING_LIMIT,
      CTX.PENDING_POINTER, bounds.pendingBase, bounds.pendingPointer);
    this._forwardStackBlock(absStateBase, CTX.CALL_STACK_BASE, CTX.CALL_STACK_LIMIT,
      CTX.CALL_STACK_POINTER, bounds.callStackBase, bounds.callStackPointer);
    this._forwardStackBlock(absStateBase, CTX.TRY_STACK_BASE, CTX.TRY_STACK_LIMIT,
      CTX.TRY_STACK_POINTER, bounds.tryStackBase, bounds.tryStackPointer);
    this._forwardStackBlock(absStateBase, CTX.GRANT_STACK_BASE, CTX.GRANT_STACK_LIMIT,
      CTX.GRANT_STACK_POINTER, bounds.grantStackBase, bounds.grantStackPointer);

    // Request_base payload — heap pointers the WAT left for the host
    // to read via handleAwait / handleAsyncCall / handlePromiseSettle /
    // handlePromiseMethod. The collector must forward these or the
    // host will dereference stale addresses post-GC. See INTERNALS.md,
    // "Garbage Collector — Safepoint Contract".
    //
    // MUST run before the slot→pointer table update below: it reads the slot's
    // exit condition via getExitCondition → getContextBase → the table. If the
    // table already pointed at the new (not-yet-moved) location, that read would
    // hit uncopied bytes (moveObjects runs last) and miss the forward.
    //
    // The pending-block move delta rebases the request block's stored
    // argsPointer (a raw address into the pending STACK_BLOCK, which
    // relocates like any heap object).
    this.updateRequestBasePointersForContext(slot,
      this.getNewDataPointer(bounds.pendingBase) - bounds.pendingBase);

    // Forward the context object's own address in the slot→pointer table. Done
    // LAST: every per-slot read above resolves the context through the table and
    // needs the OLD address until moveObjects physically relocates the bytes.
    const newBase = this.getNewDataPointer(base);
    if (newBase !== base) {
      this.manipulator.setContextPointer(slot, newBase);
    }
  }

  /**
   * Forward one stack block's base/limit/top in a context's state block to the
   * block's new (post-compaction) address. The block's bytes move as a unit, so
   * the top and limit shift by the same delta as the base.
   * @param {number} absStateBase - absolute address of the state block
   * @param {number} baseField - CTX.*_BASE offset
   * @param {number} limitField - CTX.*_LIMIT offset
   * @param {number} topField - CTX.*_POINTER offset
   * @param {number} oldBase - old (current) block base (segment-relative data pointer)
   * @param {number} oldTop - old (current) top pointer
   */
  _forwardStackBlock(absStateBase, baseField, limitField, topField, oldBase, oldTop) {
    const newBase = this.getNewDataPointer(oldBase);
    if (newBase === oldBase) return; // block not moving
    const delta = newBase - oldBase;
    const oldLimit = this.view.getUint32(absStateBase + limitField, true);
    this.view.setUint32(absStateBase + baseField, newBase, true);
    this.view.setUint32(absStateBase + limitField, oldLimit + delta, true);
    this.view.setUint32(absStateBase + topField, oldTop + delta, true);
  }

  /**
   * Forward heap pointers in the external_request_base region that
   * belong to a slot whose CTX_EXIT_CONDITION is one of:
   *   EXIT_AWAIT (settled cases): request_base+8 = promise_data_ptr + PROMISE.VALUE
   *   EXIT_PROMISE_SETTLE:        request_base+0 = promise_data_ptr
   *   EXIT_PROMISE_METHOD (instance): request_base+0 = promise heap pointer
   *   EXIT_ASYNC_CALL:            request_base+0 = closure header pointer
   *
   * ...plus, for the external exits (EXIT_EXTERNAL_CALL,
   * EXIT_EXTERNAL_PROPERTY, EXIT_EXTERNAL_PROPERTY_SET), the heap
   * pointers inside the request's arg value slots — those sit ABOVE
   * the pre-positioned pending pointer, outside the normal stack
   * scan. (The request's methodOffset string id is forwarded
   * separately, in updateRequestBaseStringsForContext during
   * compactStrings.)
   *
   * The region is global, but only one slot can be in the
   * post-yield-pre-handler state at a time. Slots in any other exit
   * condition either don't write request_base (e.g. EXIT_DONE,
   * EXIT_ERROR) or wrote payloads safe under GC (EXIT_GRANT_REQUEST
   * reads its identifiers from below the pending pointer, inside the
   * scanned range).
   *
   * **Mostly DEFENSIVE.** See the long-form comment on
   * `markRequestBaseForContext` for the architectural background:
   * `session.run` services these yields synchronously, so the
   * post-yield-pre-handler window does not exist through the public API.
   * An EXTERNAL_METHOD binding remains ordinary heap/stack data and can
   * make the same stale method id observable, so both the binding and the
   * request block are handled.
   *
   * @param {number} slot - Context slot index
   */
  updateRequestBasePointersForContext(slot, pendingDelta = 0) {
    const exitCondition = this.manipulator.getExitCondition(slot);
    const requestBase = this.manipulator.getExternalRequestBase(slot);
    const absReqBase = this.abs(requestBase);

    if (exitCondition === EXIT_AWAIT) {
      // Layout: [isPending:4][isRejected:4][valuePointer:4]
      // valuePointer is non-zero only on settled (resolved/rejected)
      // paths; it points at promise_data_ptr + PROMISE.VALUE.
      //
      // Same staleness guard as the mark phase (markRequestBaseForContext):
      // forward only when valuePtr addresses a real live PROMISE. A stale
      // payload can point at a freed-and-reused slot; forwarding it via
      // getNewDataPointer would either move the wrong object's pointer or
      // write a bogus address into dead payload data. Skipping it is correct
      // because the payload is never re-read (resume uses the waiter list).
      const isPending = this.view.getUint32(absReqBase, true);
      if (isPending === 0) {
        const oldValuePtr = this.view.getUint32(absReqBase + 8, true);
        if (oldValuePtr !== 0 && this._isLivePromise(oldValuePtr - PROMISE.VALUE)) {
          const oldPromiseData = oldValuePtr - PROMISE.VALUE;
          const newPromiseData = this.getNewDataPointer(oldPromiseData);
          if (newPromiseData !== oldPromiseData) {
            this.view.setUint32(absReqBase + 8, newPromiseData + PROMISE.VALUE, true);
          }
        }
      }
      return;
    }

    if (exitCondition === EXIT_PROMISE_SETTLE) {
      // Layout: [promiseDataPointer:4][isReject:4][argsPointer:4][argCount:4]
      // promiseDataPointer is a heap data pointer; argsPointer is into
      // the pending stack (fixed memory, not a heap pointer).
      const oldPromisePtr = this.view.getUint32(absReqBase, true);
      if (oldPromisePtr !== 0) {
        const newPromisePtr = this.getNewDataPointer(oldPromisePtr);
        if (newPromisePtr !== oldPromisePtr) {
          this.view.setUint32(absReqBase, newPromisePtr, true);
        }
      }
      return;
    }

    if (exitCondition === EXIT_PROMISE_METHOD) {
      // Layout: [promiseHeaderPointer:4][methodId:4][argsPointer:4][argCount:4]
      // Two variants share this exit condition:
      //   - Instance methods on a promise (.then/.catch/.finally):
      //     request_base+0 = promise HEADER pointer (allocate_promise's
      //     return; the airlock adds GC_HEADER_SIZE itself). This used
      //     to forward via getNewDataPointer — a forwarding-map lookup
      //     at header-8 that always MISSED, leaving the pointer stale
      //     whenever the promise moved.
      //   - Static methods (Promise.all / Promise.race / Promise
      //     constructor): request_base+0 = 0 (no heap pointer).
      const oldPromisePtr = this.view.getUint32(absReqBase, true);
      if (oldPromisePtr !== 0) {
        const newPromisePtr = this.getNewHeaderPointer(oldPromisePtr);
        if (newPromisePtr !== oldPromisePtr) {
          this.view.setUint32(absReqBase, newPromisePtr, true);
        }
      }
      // Forward the args range above the pre-positioned pending pointer
      // (mirror of the mark-phase coverage; same shape as the
      // EXIT_EXTERNAL_* case), then rebase the stored argsPointer by the
      // pending block's move delta — it is a raw address into the OLD
      // block location.
      const argsPointer = this.view.getUint32(absReqBase + 8, true);
      const argCount = this.view.getUint32(absReqBase + 12, true);
      for (let argIndex = 0; argIndex < argCount; argIndex++) {
        this.updateValuePointer(argsPointer + argIndex * VALUE_SIZE);
      }
      if (argsPointer !== 0 && pendingDelta !== 0) {
        this.view.setUint32(absReqBase + 8, argsPointer + pendingDelta, true);
      }
      return;
    }

    if (exitCondition === EXIT_ASYNC_CALL) {
      // Layout: [closureHeaderPointer:4][argsPointer:4][argCount:4]
      //         [receiverType:4][receiverFlags:4][receiverLo:4][receiverHi:4]
      // closureHeaderPointer is a heap *header* pointer (per
      // airlock.handleAsyncCall, which does the +28/+36 reads
      // relative to that header). Use getNewHeaderPointer here.
      const oldClosurePtr = this.view.getUint32(absReqBase, true);
      if (oldClosurePtr !== 0) {
        const newClosurePtr = this.getNewHeaderPointer(oldClosurePtr);
        if (newClosurePtr !== oldClosurePtr) {
          this.view.setUint32(absReqBase, newClosurePtr, true);
        }
      }
      // The method form copies the receiver VALUE into the request block
      // (a raw heap pointer with no other in-block root) — forward it as
      // the 16-byte VALUE slot it is (mirror of the mark phase).
      this.updateValuePointer(requestBase + 12);
      // Rebase the stored argsPointer (at +4 in this layout) by the
      // pending block's move delta. The args VALUES live inside the
      // scanned pending range (this yield keeps the pointer high), so
      // only the raw address needs the shift.
      const oldArgsPointer = this.view.getUint32(absReqBase + 4, true);
      if (oldArgsPointer !== 0 && pendingDelta !== 0) {
        this.view.setUint32(absReqBase + 4, oldArgsPointer + pendingDelta, true);
      }
      return;
    }

    if (exitCondition === EXIT_EXTERNAL_CALL
        || exitCondition === EXIT_EXTERNAL_PROPERTY
        || exitCondition === EXIT_EXTERNAL_PROPERTY_SET) {
      // Layout: [handleId:4][methodOffset:4][argsPointer:4][argCount:4]
      // The value slots argsPointer addresses can hold heap pointers that
      // compaction relocates. They sit above the pre-positioned pending
      // pointer, so updatePendingStackPointersForContext misses them.
      // argsPointer is itself a raw address into a relocatable pending
      // STACK_BLOCK and must be rebased by the block's move delta.
      const argsPointer = this.view.getUint32(absReqBase + 8, true);
      const argCount = this.view.getUint32(absReqBase + 12, true);
      for (let argIndex = 0; argIndex < argCount; argIndex++) {
        this.updateValuePointer(argsPointer + argIndex * VALUE_SIZE);
      }
      if (argsPointer !== 0 && pendingDelta !== 0) {
        this.view.setUint32(absReqBase + 8, argsPointer + pendingDelta, true);
      }
      // Forward the construction pointer at +20 (the branded receiver for
      // complete/abort or the new.target closure for begin), mirroring the
      // mark phase.
      if (exitCondition === EXIT_EXTERNAL_CALL) {
        const methodOffset = this.view.getUint32(absReqBase + 4, true);
        if (this._isConstructionMethodOffset(methodOffset)) {
          const oldPointer = this.view.getUint32(absReqBase + 20, true);
          if (oldPointer !== 0) {
            const newPointer = this.getNewHeaderPointer(oldPointer);
            if (newPointer !== oldPointer) {
              this.view.setUint32(absReqBase + 20, newPointer, true);
            }
          }
        }
      }
      return;
    }
  }

  /**
   * Update pointers in a pending stack range.
   * @param {number} base - Stack base (segment-relative)
   * @param {number} pointer - Stack pointer (segment-relative)
   */
  updatePendingStackPointersForContext(base, pointer) {
    for (let addr = base; addr < pointer; addr += VALUE_SIZE) {
      this.updateValuePointer(addr);
    }
  }

  /**
   * Update pointers in a call stack range.
   * @param {number} base - Stack base (segment-relative)
   * @param {number} pointer - Stack pointer (segment-relative)
   */
  updateCallStackPointersForContext(base, pointer) {
    for (let frameAddr = base; frameAddr < pointer; frameAddr += FRAME_SIZE) {
      const absFrameAddr = this.abs(frameAddr);

      const oldScopeDataPointer = this.view.getUint32(absFrameAddr + FRAME.SCOPE_POINTER, true);
      if (oldScopeDataPointer !== 0) {
        const newScopeDataPointer = this.getNewDataPointer(oldScopeDataPointer);
        if (newScopeDataPointer !== oldScopeDataPointer) {
          this.view.setUint32(absFrameAddr + FRAME.SCOPE_POINTER, newScopeDataPointer, true);
        }
      }

      const flags = this.view.getUint32(absFrameAddr + FRAME.FLAGS, true);
      if (flags & FRAME_FLAG_NATIVE_CONTINUATION) {
        const continuationKind = this.view.getUint32(
          absFrameAddr + FRAME.CONTINUATION_KIND,
          true,
        );
        if (!NATIVE_CONTINUATION_KINDS.has(continuationKind)) {
          throw new Error(`Unknown native continuation kind ${continuationKind}`);
        }

        const stateHandleSlot = absFrameAddr + FRAME.CONTINUATION_STATE_HANDLE;
        const oldStateHandle = this.view.getUint32(stateHandleSlot, true);
        if (oldStateHandle === 0) {
          throw new Error(`Native continuation ${continuationKind} has no state handle`);
        }
        const newStateHandle = this.getNewHeaderPointer(oldStateHandle);
        if (newStateHandle !== oldStateHandle) {
          this.view.setUint32(stateHandleSlot, newStateHandle, true);
        }

        const oldCallback = this.view.getUint32(
          absFrameAddr + FRAME.CONTINUATION_CALLBACK,
          true,
        );
        if (oldCallback !== 0) {
          const newCallback = this.getNewHeaderPointer(oldCallback);
          if (newCallback !== oldCallback) {
            this.view.setUint32(
              absFrameAddr + FRAME.CONTINUATION_CALLBACK,
              newCallback,
              true,
            );
          }
        }
      } else {
        const oldAsyncPromiseField = this.view.getUint32(
          absFrameAddr + FRAME.CONTINUATION_STATE_4,
          true,
        );
        const oldAsyncPromise = oldAsyncPromiseField & ~3;
        if (oldAsyncPromise !== 0) {
          const flagBits = oldAsyncPromiseField & 3;
          const newAsyncPromise = this.getNewDataPointer(oldAsyncPromise);
          if (newAsyncPromise !== oldAsyncPromise) {
            this.view.setUint32(absFrameAddr + FRAME.ASYNC_PROMISE, newAsyncPromise | flagBits, true);
          }
        }
      }
    }
  }

  /**
   * Update pointers in a grant stack range.
   * @param {number} base - Stack base (segment-relative)
   * @param {number} pointer - Stack pointer (segment-relative)
   */
  updateGrantStackPointersForContext(base, pointer) {
    // Use GRANT_ENTRY_SIZE rather than duplicating the layout stride; a
    // mismatched stride would forward entry 0 and then walk mid-entry.
    for (let entryAddr = base; entryAddr < pointer; entryAddr += GRANT_ENTRY_SIZE) {
      // Identifier value is at offset 0
      this.updateValuePointer(entryAddr);
      // Saved scope pointer (restored on denied-block unwind)
      const absScopeAddr = this.abs(entryAddr + GRANT_ENTRY.SCOPE_POINTER);
      const oldScope = this.view.getUint32(absScopeAddr, true);
      if (oldScope !== 0) {
        const newScope = this.getNewDataPointer(oldScope);
        if (newScope !== oldScope) {
          this.view.setUint32(absScopeAddr, newScope, true);
        }
      }
    }
  }

  /**
   * Forward try stack entries' saved scope pointers. Without this, a
   * compaction that relocates scopes while a slot is parked inside a
   * try leaves the entry pointing at the scope's OLD address; the
   * eventual unwind-to-catch restores garbage and top-level bindings
   * vanish ("Cannot assign to undeclared variable"). Regression test:
   * tests/runtime/suspend_reject_under_closure_load_test.js.
   * @param {number} base - Stack base (segment-relative)
   * @param {number} pointer - Stack pointer (segment-relative)
   */
  updateTryStackPointersForContext(base, pointer) {
    for (let entryAddr = base; entryAddr < pointer; entryAddr += TRY_ENTRY_SIZE) {
      const absScopeAddr = this.abs(entryAddr + TRY_ENTRY.SCOPE);
      const oldScope = this.view.getUint32(absScopeAddr, true);
      if (oldScope !== 0) {
        const newScope = this.getNewDataPointer(oldScope);
        if (newScope !== oldScope) {
          this.view.setUint32(absScopeAddr, newScope, true);
        }
      }
      // v11: forward the entry's pending completion value (mirror of the
      // markTryStackForContext addition).
      const completionType = this.view.getUint32(
        this.abs(entryAddr + TRY_ENTRY.COMPLETION_TYPE), true);
      if (completionType === COMPLETION_THROW || completionType === COMPLETION_RETURN) {
        this.updateValuePointer(entryAddr + TRY_ENTRY.COMPLETION_VALUE);
      }
    }
  }

  /**
   * Given an old DATA pointer, return the new DATA pointer after compaction.
   * @param {number} oldDataPointer - Old data pointer
   * @returns {number} - New data pointer
   */
  getNewDataPointer(oldDataPointer) {
    // Validate pointer is within heap bounds
    const heapStart = this.manipulator.getHeapStart();
    const heapPointer = this.manipulator.getHeapPointer();
    if (oldDataPointer < heapStart || oldDataPointer >= heapPointer) {
      // Not a valid heap pointer - likely a corrupted or misinterpreted value
      // Return unchanged to avoid crash
      return oldDataPointer;
    }

    const oldHeaderPointer = oldDataPointer - GC_HEADER_SIZE;
    const newHeaderPointer = this.getForwardingPointer(oldHeaderPointer);
    if (newHeaderPointer === 0 || newHeaderPointer === oldHeaderPointer) {
      return oldDataPointer; // Not moving
    }
    return newHeaderPointer + GC_HEADER_SIZE;
  }

  /**
   * Get new HEADER pointer for old HEADER pointer.
   * Used for entries and data_ptr which store HEADER pointers.
   * @param {number} oldHeaderPointer - Old header pointer
   * @returns {number} - New header pointer
   */
  getNewHeaderPointer(oldHeaderPointer) {
    // Validate pointer is within heap bounds
    const heapStart = this.manipulator.getHeapStart();
    const heapPointer = this.manipulator.getHeapPointer();
    if (oldHeaderPointer < heapStart || oldHeaderPointer >= heapPointer) {
      // Not a valid heap pointer - likely a corrupted or misinterpreted value
      // Return unchanged to avoid crash
      return oldHeaderPointer;
    }

    const newHeaderPointer = this.getForwardingPointer(oldHeaderPointer);
    if (newHeaderPointer === 0 || newHeaderPointer === oldHeaderPointer) {
      return oldHeaderPointer; // Not moving
    }
    return newHeaderPointer;
  }

  /**
   * Update pointers within an object.
   * @param {number} headerPointer - Pointer to GC header
   */
  updateObjectPointers(headerPointer) {
    const objType = this.readHeaderType(headerPointer);
    const dataPointer = headerPointer + GC_HEADER_SIZE;

    switch (objType) {
      case OBJ.ARRAY:
        this.updateArrayPointers(dataPointer);
        break;

      case OBJ.OBJECT:
        this.updateObjectEntryPointers(dataPointer);
        break;

      case OBJ.SCOPE:
        this.updateScopePointers(dataPointer);
        break;

      case OBJ.FUNCTION:
        this.updateClosurePointers(dataPointer);
        break;

      case OBJ.ARRAY_DATA:
        // Element pointers are forwarded by updateArrayPointers via the parent
        // ARRAY, bounded by `length`. No standalone walk here because it would
        // read unwritten capacity-tail slots as values.
        break;

      case OBJ.SCOPE_ENTRIES:
        // Scope entries are updated by updateScopePointers when processing the parent SCOPE
        // Do NOT process here - scope entries are 20-byte, not 16-byte VALUE slots
        break;

      case OBJ.ARRAYBUFFER:
        // ArrayBuffer has no internal pointers to update (just raw bytes)
        break;

      case OBJ.TYPED_ARRAY_DESCRIPTOR:
        // Descriptor: [bufferPtr:4][byteOffset:4][length:4]
        // Update the bufferPtr (DATA pointer to ArrayBuffer)
        this.updateTypedArrayDescriptorPointers(headerPointer);
        break;

      case OBJ.PROMISE:
        this.updatePromisePointers(dataPointer);
        break;

      case OBJ.PROMISE_WAITER:
        this.updatePromiseWaiterPointer(dataPointer);
        break;

      case OBJ.THEN_HANDLER:
        this.updateThenHandlerPointers(dataPointer);
        break;

      case OBJ.BIGINT:
        // Leaf object — no internal pointers to update
        break;

      case OBJ.RATIONAL:
        this.updateRationalPointers(dataPointer);
        break;

      case OBJ.COMPLEX:
        this.updateComplexPointers(dataPointer);
        break;

      case OBJ.SYMBOL:
        // Symbol: [descriptionStringOffset: 4][reserved: 4]
        // Description is an intern-table offset (not a heap pointer), and
        // reserved is zero in 2a. Nothing to update during compaction.
        break;

      case OBJ.EXPRESSION:
        // Expression: [headPointer: 4][argumentArrayPointer: 4]
        // Both are heap pointers — update them via forwarding.
        this.updateExpressionPointers(dataPointer);
        break;

      case OBJ.MATRIX: {
        // Matrix: [rowCount: 4][columnCount: 4][entriesArrayPointer: 4]
        // [reserved: 4] — forward the entries Array header pointer at
        // data+8; the counts are not pointers.
        const oldEntries = this.view.getUint32(this.abs(dataPointer + 8), true);
        if (oldEntries !== 0) {
          const newEntries = this.getNewHeaderPointer(oldEntries);
          if (newEntries !== oldEntries) {
            this.view.setUint32(this.abs(dataPointer + 8), newEntries, true);
          }
        }
        break;
      }

      case OBJ.THEOREM: {
        // Forward both artifact and optional universe-owner data pointers.
        const oldArtifactBufferDataPointer =
          this.view.getUint32(this.abs(dataPointer), true);
        if (oldArtifactBufferDataPointer !== 0) {
          const newArtifactBufferDataPointer =
            this.getNewDataPointer(oldArtifactBufferDataPointer);
          if (newArtifactBufferDataPointer !== oldArtifactBufferDataPointer) {
            this.view.setUint32(
              this.abs(dataPointer), newArtifactBufferDataPointer, true);
          }
        }
        const oldUniverseOwnerDataPointer =
          this.view.getUint32(this.abs(dataPointer + 12), true);
        if (oldUniverseOwnerDataPointer !== 0) {
          const newUniverseOwnerDataPointer =
            this.getNewDataPointer(oldUniverseOwnerDataPointer);
          if (newUniverseOwnerDataPointer !== oldUniverseOwnerDataPointer) {
            this.view.setUint32(
              this.abs(dataPointer + 12), newUniverseOwnerDataPointer, true);
          }
        }
        break;
      }

      case OBJ.REGEXP: {
        // Forward the compiled-program ArrayBuffer data pointer at
        // data+12. The pattern string id is forwarded by the string
        // compaction pass; flags and lastIndex are scalars.
        const oldProgramBufferDataPointer =
          this.view.getUint32(this.abs(dataPointer + REGEXP.PROGRAM_BUFFER), true);
        if (oldProgramBufferDataPointer !== 0) {
          const newProgramBufferDataPointer =
            this.getNewDataPointer(oldProgramBufferDataPointer);
          if (newProgramBufferDataPointer !== oldProgramBufferDataPointer) {
            this.view.setUint32(
              this.abs(dataPointer + REGEXP.PROGRAM_BUFFER),
              newProgramBufferDataPointer,
              true);
          }
        }
        break;
      }

      case OBJ.SCHEMA: {
        // Forward the source value slot and the program ArrayBuffer
        // data pointer (mirror of the mark-phase OBJ.SCHEMA case).
        this.updateValuePointer(dataPointer + SCHEMA.SOURCE);
        const oldSchemaProgram =
          this.view.getUint32(this.abs(dataPointer + SCHEMA.PROGRAM_BUFFER), true);
        if (oldSchemaProgram !== 0) {
          const newSchemaProgram = this.getNewDataPointer(oldSchemaProgram);
          if (newSchemaProgram !== oldSchemaProgram) {
            this.view.setUint32(this.abs(dataPointer + SCHEMA.PROGRAM_BUFFER), newSchemaProgram, true);
          }
        }
        break;
      }

      case OBJ.ALGEBRAIC: {
        // Forward the defining-polynomial Array, interval Array, optional
        // field-generator AlgebraicNumber, and optional coordinates Array.
        for (const offset of [0, 4, 8, 12]) {
          const oldPointer = this.view.getUint32(this.abs(dataPointer + offset), true);
          if (oldPointer !== 0) {
            const newPointer = this.getNewHeaderPointer(oldPointer);
            if (newPointer !== oldPointer) {
              this.view.setUint32(this.abs(dataPointer + offset), newPointer, true);
            }
          }
        }
        break;
      }

      case OBJ.COMPLEX_ALGEBRAIC: {
        // Forward the two exact-real component HEADER pointers.
        for (const offset of [0, 4]) {
          const oldPointer = this.view.getUint32(this.abs(dataPointer + offset), true);
          if (oldPointer !== 0) {
            const newPointer = this.getNewHeaderPointer(oldPointer);
            if (newPointer !== oldPointer) {
              this.view.setUint32(this.abs(dataPointer + offset), newPointer, true);
            }
          }
        }
        break;
      }

      case OBJ.NATIVE_CONTINUATION_STATE: {
        const headerPointerMask = this.view.getUint32(this.abs(dataPointer), true);
        const dataPointerMask = this.view.getUint32(this.abs(dataPointer + 4), true);
        if ((headerPointerMask & dataPointerMask) !== 0) {
          throw new Error("Native continuation state pointer masks overlap");
        }
        for (let stateIndex = 0; stateIndex < 5; stateIndex++) {
          const slot = this.abs(dataPointer + 8 + stateIndex * 4);
          const oldPointer = this.view.getUint32(slot, true);
          if (oldPointer === 0) continue;
          let newPointer = oldPointer;
          if (headerPointerMask & (1 << stateIndex)) {
            newPointer = this.getNewHeaderPointer(oldPointer);
          } else if (dataPointerMask & (1 << stateIndex)) {
            newPointer = this.getNewDataPointer(oldPointer);
          }
          if (newPointer !== oldPointer) {
            this.view.setUint32(slot, newPointer, true);
          }
        }
        break;
      }

      case OBJ.MAP:
      case OBJ.SET: {
        // Map/Set header: [size:4][slotCount:4][capacity:4][entriesHeader:4][sym_entries:4].
        const slotCount = this.view.getUint32(this.abs(dataPointer + 4), true);
        // Update the entriesHeader pointer via the forwarding map.
        const oldEntriesHeader = this.view.getUint32(this.abs(dataPointer + 12), true);
        if (oldEntriesHeader !== 0) {
          const newEntriesHeader = this.getNewHeaderPointer(oldEntriesHeader);
          if (newEntriesHeader !== oldEntriesHeader) {
            this.view.setUint32(this.abs(dataPointer + 12), newEntriesHeader, true);
          }
          // Forward slot pointers HERE, bounded by slotCount — NOT in the
          // standalone MAP_ENTRIES/SET_ENTRIES case, which would walk to
          // capacity over unwritten tail slots. This pass rewrites pointers IN
          // PLACE at pre-move addresses (the physical memmove happens later),
          // so walk the OLD entries location.
          const entriesData = oldEntriesHeader + GC_HEADER_SIZE;
          if (objType === OBJ.MAP) {
            for (let i = 0; i < slotCount; i++) {
              const slotAddr = entriesData + i * 36;
              this.updateValuePointer(slotAddr + 4);    // key
              this.updateValuePointer(slotAddr + 20);   // value
            }
          } else {
            for (let i = 0; i < slotCount; i++) {
              this.updateValuePointer(entriesData + i * 20 + 4);  // value
            }
          }
        }
        // Own symbol-keyed properties (sym_entries at data-relative +16).
        this.updateSymEntriesSlot(dataPointer + 16);
        break;
      }

      case OBJ.MAP_ENTRIES:
      case OBJ.SET_ENTRIES:
        // Slots are forwarded by the parent OBJ.MAP / OBJ.SET case, bounded by
        // slotCount. No standalone walk here — see the note in that case.
        break;

      case OBJ.CONTEXT:
      case OBJ.STACK_BLOCK:
        // No-op in the generic heap walk. A context object's pointer fields
        // (stack bases/limits/tops, scope, completion) and a stack block's
        // contents are all forwarded by updateContextPointers, driven by the
        // slot scan in updatePointers — not here. Handling them in both places
        // would double-forward. The block's raw value/frame bytes that ARE
        // pointers are forwarded by the per-stack content walkers.
        break;
    }
  }

  /**
   * Update the numerator/denominator BigInt header pointers in a Rational
   * after compaction.
   * @param {number} dataPointer - Pointer to Rational data (after GC header)
   */
  updateRationalPointers(dataPointer) {
    const absNumeratorSlot = this.abs(dataPointer);
    const absDenominatorSlot = this.abs(dataPointer + 4);
    const oldNumerator = this.view.getUint32(absNumeratorSlot, true);
    const oldDenominator = this.view.getUint32(absDenominatorSlot, true);
    if (oldNumerator !== 0) {
      this.view.setUint32(absNumeratorSlot, this.getNewHeaderPointer(oldNumerator), true);
    }
    if (oldDenominator !== 0) {
      this.view.setUint32(absDenominatorSlot, this.getNewHeaderPointer(oldDenominator), true);
    }
  }

  /**
   * Update the real/imaginary Rational header pointers in a Complex
   * after compaction.
   * @param {number} dataPointer - Pointer to Complex data (after GC header)
   */
  updateComplexPointers(dataPointer) {
    const absRealSlot = this.abs(dataPointer);
    const absImaginarySlot = this.abs(dataPointer + 4);
    const oldReal = this.view.getUint32(absRealSlot, true);
    const oldImaginary = this.view.getUint32(absImaginarySlot, true);
    if (oldReal !== 0) {
      this.view.setUint32(absRealSlot, this.getNewHeaderPointer(oldReal), true);
    }
    if (oldImaginary !== 0) {
      this.view.setUint32(absImaginarySlot, this.getNewHeaderPointer(oldImaginary), true);
    }
  }

  /**
   * Update the head Symbol pointer and the argument Array pointer in an
   * Expression after compaction. Ring 2.
   * @param {number} dataPointer - Pointer to Expression data (after GC header)
   */
  updateExpressionPointers(dataPointer) {
    const absHeadSlot = this.abs(dataPointer);
    const absArgumentSlot = this.abs(dataPointer + 4);
    const oldHead = this.view.getUint32(absHeadSlot, true);
    const oldArgument = this.view.getUint32(absArgumentSlot, true);
    if (oldHead !== 0) {
      this.view.setUint32(absHeadSlot, this.getNewHeaderPointer(oldHead), true);
    }
    if (oldArgument !== 0) {
      this.view.setUint32(absArgumentSlot, this.getNewHeaderPointer(oldArgument), true);
    }
  }

  /**
   * Update pointers in a TypedArray descriptor.
   * @param {number} headerPointer - Pointer to GC header
   */
  updateTypedArrayDescriptorPointers(headerPointer) {
    const dataPointer = headerPointer + GC_HEADER_SIZE;
    const absAddr = this.abs(dataPointer);

    // bufferPtr is a DATA pointer
    const oldBufferPtr = this.view.getUint32(absAddr, true);
    if (oldBufferPtr !== 0) {
      const oldHeaderPointer = oldBufferPtr - GC_HEADER_SIZE;
      const newHeaderPointer = this.getNewHeaderPointer(oldHeaderPointer);
      const newDataPointer = newHeaderPointer + GC_HEADER_SIZE;
      this.view.setUint32(absAddr, newDataPointer, true);
    }

    // Own symbol-keyed properties (sym_entries at data-relative +12).
    this.updateSymEntriesSlot(dataPointer + 12);
  }

  /**
   * Update a value's heap pointer if it references a heap object.
   * @param {number} valueAddr - Address of value slot
   */
  updateValuePointer(valueAddr) {
    const absAddr = this.abs(valueAddr);
    const type = this.view.getUint32(absAddr, true);

    if (type === TYPE.PROMISE_RESOLVE || type === TYPE.PROMISE_REJECT) {
      // Executor continuations carry a promise DATA pointer, unlike ordinary
      // TYPE.PROMISE values, which carry a promise HEADER pointer.
      const oldPromiseDataPointer = this.view.getUint32(absAddr + 8, true);
      if (oldPromiseDataPointer !== 0) {
        const newPromiseDataPointer = this.getNewDataPointer(oldPromiseDataPointer);
        if (newPromiseDataPointer !== oldPromiseDataPointer) {
          this.view.setUint32(absAddr + 8, newPromiseDataPointer, true);
        }
      }
    } else if (
      type === TYPE.ARRAY || type === TYPE.OBJECT || type === TYPE.FUNCTION ||
      type === TYPE.PROMISE || type === TYPE.EXPRESSION || type === TYPE.MATRIX ||
      type === TYPE.THEOREM || type === TYPE.ALGEBRAIC ||
      type === TYPE.COMPLEX_ALGEBRAIC || type === TYPE.REGEXP ||
      type === TYPE.SCHEMA
    ) {
      // Arrays, objects, functions, promises, expressions, matrices,
      // and theorems store HEADER pointers (EXPRESSION was missing
      // here once — the mirror of the missing markValue case).
      const oldHeaderPointer = this.view.getUint32(absAddr + 8, true);
      if (oldHeaderPointer !== 0) {
        const newHeaderPointer = this.getNewHeaderPointer(oldHeaderPointer);
        if (newHeaderPointer !== oldHeaderPointer) {
          this.view.setUint32(absAddr + 8, newHeaderPointer, true);
        }
      }
    } else if (type === TYPE.ACCESSOR) {
      // Accessor property values: two closure HEADER pointers (getter in
      // data_lo, setter in data_hi; either may be 0).
      const oldGetter = this.view.getUint32(absAddr + 8, true);
      if (oldGetter !== 0) {
        const newGetter = this.getNewHeaderPointer(oldGetter);
        if (newGetter !== oldGetter) {
          this.view.setUint32(absAddr + 8, newGetter, true);
        }
      }
      const oldSetter = this.view.getUint32(absAddr + 12, true);
      if (oldSetter !== 0) {
        const newSetter = this.getNewHeaderPointer(oldSetter);
        if (newSetter !== oldSetter) {
          this.view.setUint32(absAddr + 12, newSetter, true);
        }
      }
    } else if (type === TYPE.SCOPE) {
      // Scopes store DATA pointers
      const oldDataPointer = this.view.getUint32(absAddr + 8, true);
      if (oldDataPointer !== 0) {
        const newDataPointer = this.getNewDataPointer(oldDataPointer);
        if (newDataPointer !== oldDataPointer) {
          this.view.setUint32(absAddr + 8, newDataPointer, true);
        }
      }
    } else if (type === TYPE.BOUND_METHOD) {
      // BOUND_METHOD layout: [type:4][flags:4][data_lo:4][data_hi:4]
      // The receiver type lives in flags' low byte. Heap-compaction
      // updates need to mirror the storage convention for whatever
      // type the receiver has:
      //   - String receivers: id, not a heap pointer (forwarded by
      //     updateValueStringOffset during string-compact).
      //   - Msgpack-ref receivers: DATA pointer (parent_data_ptr).
      //   - Typed-array receivers: DATA pointer (descriptor data_lo).
      //   - Scope receivers (unlikely): DATA pointer.
      //   - Everything else (Object, Array, Function, Promise, Map,
      //     Set, BigInt, Complex, etc.): HEADER pointer.
      const flags = this.view.getUint32(absAddr + 4, true);
      const receiverType = flags & 0xff;
      const oldReceiver = this.view.getUint32(absAddr + 8, true);
      if (oldReceiver !== 0) {
        if (receiverType === TYPE.STRING) {
          // String receivers: id, not a heap pointer. Forwarded by
          // updateValueStringOffset during the string-compact phase.
        } else if (
          receiverType === TYPE.MSGPACK_REF ||
          isTypedArrayType(receiverType) ||
          receiverType === TYPE.SCOPE
        ) {
          // DATA-pointer-storing receivers.
          const newReceiver = this.getNewDataPointer(oldReceiver);
          if (newReceiver !== oldReceiver) {
            this.view.setUint32(absAddr + 8, newReceiver, true);
          }
        } else {
          // HEADER-pointer-storing receivers.
          const newReceiver = this.getNewHeaderPointer(oldReceiver);
          if (newReceiver !== oldReceiver) {
            this.view.setUint32(absAddr + 8, newReceiver, true);
          }
        }
      }
    } else if (type === TYPE.CONSTRUCTOR) {
      // CONSTRUCTOR stores a HEADER pointer to the prototype object
      const oldHeaderPointer = this.view.getUint32(absAddr + 8, true);
      if (oldHeaderPointer !== 0) {
        const newHeaderPointer = this.getNewHeaderPointer(oldHeaderPointer);
        if (newHeaderPointer !== oldHeaderPointer) {
          this.view.setUint32(absAddr + 8, newHeaderPointer, true);
        }
      }
    } else if (type === TYPE.ARRAYBUFFER) {
      // ArrayBuffer stores DATA pointer at offset +8
      const oldDataPointer = this.view.getUint32(absAddr + 8, true);
      if (oldDataPointer !== 0) {
        const newDataPointer = this.getNewDataPointer(oldDataPointer);
        if (newDataPointer !== oldDataPointer) {
          this.view.setUint32(absAddr + 8, newDataPointer, true);
        }
      }
    } else if (type === TYPE.MSGPACK_REF) {
      // data_lo (offset +8) is a DATA pointer into the parent ARRAYBUFFER;
      // data_hi (offset +12) is a byte offset within that ARRAYBUFFER and is
      // invariant under compaction.
      const oldDataPointer = this.view.getUint32(absAddr + 8, true);
      if (oldDataPointer !== 0) {
        const newDataPointer = this.getNewDataPointer(oldDataPointer);
        if (newDataPointer !== oldDataPointer) {
          this.view.setUint32(absAddr + 8, newDataPointer, true);
        }
      }
    } else if (isTypedArrayType(type)) {
      // TypedArray stores descriptor DATA pointer at offset +8 (data_lo field)
      const oldDataPointer = this.view.getUint32(absAddr + 8, true);
      if (oldDataPointer !== 0) {
        const newDataPointer = this.getNewDataPointer(oldDataPointer);
        if (newDataPointer !== oldDataPointer) {
          this.view.setUint32(absAddr + 8, newDataPointer, true);
        }
      }
    } else if (type === TYPE.BIGINT || type === TYPE.COMPLEX) {
      // BigInt / Complex store a HEADER pointer at offset +8.
      const oldHeaderPointer = this.view.getUint32(absAddr + 8, true);
      if (oldHeaderPointer !== 0) {
        const newHeaderPointer = this.getNewHeaderPointer(oldHeaderPointer);
        if (newHeaderPointer !== oldHeaderPointer) {
          this.view.setUint32(absAddr + 8, newHeaderPointer, true);
        }
      }
    } else if (type === TYPE.RATIONAL) {
      // Heap Rationals store a HEADER pointer at offset +8. Inline
      // Rationals carry an i64 numerator and need no relocation.
      const flags = this.view.getUint32(absAddr + 4, true);
      if ((flags & FLAG_RATIONAL_INLINE) === 0) {
        const oldHeaderPointer = this.view.getUint32(absAddr + 8, true);
        if (oldHeaderPointer !== 0) {
          const newHeaderPointer = this.getNewHeaderPointer(oldHeaderPointer);
          if (newHeaderPointer !== oldHeaderPointer) {
            this.view.setUint32(absAddr + 8, newHeaderPointer, true);
          }
        }
      }
    } else if (type === TYPE.SYMBOL) {
      // Symbol stores a HEADER pointer at offset +8.
      const oldHeaderPointer = this.view.getUint32(absAddr + 8, true);
      if (oldHeaderPointer !== 0) {
        const newHeaderPointer = this.getNewHeaderPointer(oldHeaderPointer);
        if (newHeaderPointer !== oldHeaderPointer) {
          this.view.setUint32(absAddr + 8, newHeaderPointer, true);
        }
      }
    } else if (type === TYPE.MAP || type === TYPE.SET) {
      // Map/Set value slot: data_lo is a HEADER pointer to the Map/Set
      // header heap object.
      const oldHeaderPointer = this.view.getUint32(absAddr + 8, true);
      if (oldHeaderPointer !== 0) {
        const newHeaderPointer = this.getNewHeaderPointer(oldHeaderPointer);
        if (newHeaderPointer !== oldHeaderPointer) {
          this.view.setUint32(absAddr + 8, newHeaderPointer, true);
        }
      }
    }
  }

  /**
   * Update pointers in array.
   * @param {number} dataPointer - Array data pointer
   */
  updateArrayPointers(dataPointer) {
    const absoluteDataPointer = this.abs(dataPointer);

    // Array layout (data-relative): [length:4][capacity:4][data_ptr:4][flags:4][sym_entries:4]
    const length = this.view.getUint32(absoluteDataPointer, true);
    // data_ptr stores a HEADER pointer
    const oldDataBlockHeaderPointer = this.view.getUint32(absoluteDataPointer + 8, true);
    if (oldDataBlockHeaderPointer !== 0) {
      const newDataBlockHeaderPointer = this.getNewHeaderPointer(oldDataBlockHeaderPointer);
      if (newDataBlockHeaderPointer !== oldDataBlockHeaderPointer) {
        this.view.setUint32(absoluteDataPointer + 8, newDataBlockHeaderPointer, true);
      }
      // Forward element pointers here, bounded by `length` — NOT in the
      // standalone OBJ.ARRAY_DATA case, which lacks the parent header and
      // would walk to capacity over unwritten tail slots. This pass rewrites
      // pointers IN PLACE at pre-move addresses (the physical memmove happens
      // later), so walk the OLD data block location.
      const dataBlockDataPointer = oldDataBlockHeaderPointer + GC_HEADER_SIZE;
      for (let i = 0; i < length; i++) {
        this.updateValuePointer(dataBlockDataPointer + i * VALUE_SIZE);
      }
    }

    // Own symbol-keyed properties (sym_entries at data-relative +16).
    this.updateSymEntriesSlot(dataPointer + 16);
  }

  /**
   * Update pointers in object entries.
   * @param {number} dataPointer - Object data pointer (after GC header)
   */
  updateObjectEntryPointers(dataPointer) {
    const absoluteDataPointer = this.abs(dataPointer);
    const entrySize = 20;

    // Object data layout (data-relative): [prototype:4][count:4][capacity:4][flags:4][entries:4][sym_entries:4]
    const oldPrototypeHeaderPointer = this.view.getUint32(absoluteDataPointer, true);
    const count = this.view.getUint32(absoluteDataPointer + 4, true);
    const oldEntriesHeaderPointer = this.view.getUint32(absoluteDataPointer + 16, true);
    const oldSymEntriesHeaderPointer = this.view.getUint32(absoluteDataPointer + 20, true);

    const objectHeader =
      this.view.getUint32(this.abs(dataPointer - GC_HEADER_SIZE), true);
    const objectHeaderSize = objectHeader & 0x00ffffff;
    if (objectHeaderSize > 32) {
      const oldBigintHeaderPointer =
        this.view.getUint32(absoluteDataPointer + 24, true);
      if (oldBigintHeaderPointer !== 0) {
        this.view.setUint32(
          absoluteDataPointer + 24,
          this.getNewHeaderPointer(oldBigintHeaderPointer),
          true);
      }
    }

    // Update prototype (stores a HEADER pointer)
    if (oldPrototypeHeaderPointer !== 0) {
      const newPrototypeHeaderPointer = this.getNewHeaderPointer(oldPrototypeHeaderPointer);
      if (newPrototypeHeaderPointer !== oldPrototypeHeaderPointer) {
        this.view.setUint32(absoluteDataPointer, newPrototypeHeaderPointer, true);
      }
    }

    if (oldEntriesHeaderPointer !== 0) {
      const newEntriesHeaderPointer = this.getNewHeaderPointer(oldEntriesHeaderPointer);
      if (newEntriesHeaderPointer !== oldEntriesHeaderPointer) {
        this.view.setUint32(absoluteDataPointer + 16, newEntriesHeaderPointer, true);
      }

      // Update values in entries (using OLD pointer - objects haven't moved yet)
      const entriesDataPointer = oldEntriesHeaderPointer + GC_HEADER_SIZE;
      for (let i = 0; i < count; i++) {
        const entryAddr = entriesDataPointer + i * entrySize;
        this.updateValuePointer(entryAddr + 4);
      }
    }

    this.updateSymEntriesSlot(dataPointer + 20);
  }

  /**
   * Forward a sym-entries pointer slot and the contents of its block after
   * compaction. Shared by every receiver kind that carries own
   * symbol-keyed properties (objects, functions, arrays, typed arrays,
   * Map, Set). Walks the OLD block pointer — entries haven't moved yet.
   * @param {number} slotAddr - Relative address of the sym-entries pointer slot
   */
  updateSymEntriesSlot(slotAddr) {
    const oldSymEntriesHeaderPointer = this.view.getUint32(this.abs(slotAddr), true);
    if (oldSymEntriesHeaderPointer === 0) return;

    const newSymEntriesHeaderPointer = this.getNewHeaderPointer(oldSymEntriesHeaderPointer);
    if (newSymEntriesHeaderPointer !== oldSymEntriesHeaderPointer) {
      this.view.setUint32(this.abs(slotAddr), newSymEntriesHeaderPointer, true);
    }

    // Block layout: [GC:8][sym_count:4][sym_capacity:4][entries...]
    const symBlockData = oldSymEntriesHeaderPointer + GC_HEADER_SIZE;
    const symCount = this.view.getUint32(this.abs(symBlockData), true);
    const symEntriesStart = symBlockData + 8;
    for (let i = 0; i < symCount; i++) {
      const entryAddr = symEntriesStart + i * 20;
      // The symbol-pointer key (entry +0) is a HEADER pointer — update it.
      const oldSymbolPointer = this.view.getUint32(this.abs(entryAddr), true);
      if (oldSymbolPointer !== 0) {
        const newSymbolPointer = this.getNewHeaderPointer(oldSymbolPointer);
        if (newSymbolPointer !== oldSymbolPointer) {
          this.view.setUint32(this.abs(entryAddr), newSymbolPointer, true);
        }
      }
      this.updateValuePointer(entryAddr + 4);
    }
  }

  /**
   * Update pointers in scope.
   * @param {number} dataPointer - Scope data pointer
   */
  updateScopePointers(dataPointer) {
    const absoluteDataPointer = this.abs(dataPointer);

    // Update parent pointer
    const oldParentDataPointer = this.view.getUint32(absoluteDataPointer, true);
    if (oldParentDataPointer !== 0) {
      const newParentDataPointer = this.getNewDataPointer(oldParentDataPointer);
      if (newParentDataPointer !== oldParentDataPointer) {
        this.view.setUint32(absoluteDataPointer, newParentDataPointer, true);
      }
    }

    // Update entries (stores a HEADER pointer)
    const count = this.view.getUint32(absoluteDataPointer + 4, true);
    const oldEntriesHeaderPointer = this.view.getUint32(absoluteDataPointer + 12, true);

    if (oldEntriesHeaderPointer !== 0) {
      const newEntriesHeaderPointer = this.getNewHeaderPointer(oldEntriesHeaderPointer);
      if (newEntriesHeaderPointer !== oldEntriesHeaderPointer) {
        this.view.setUint32(absoluteDataPointer + 12, newEntriesHeaderPointer, true);
      }

      // Update values in entries (using OLD pointer - objects haven't moved yet)
      // Entry data starts after GC header
      const entriesDataPointer = oldEntriesHeaderPointer + GC_HEADER_SIZE;
      for (let i = 0; i < count; i++) {
        const entryAddr = entriesDataPointer + i * 20;
        this.updateValuePointer(entryAddr + 4);
      }
    }
  }

  /**
   * Update pointers in function (hybrid object-closure).
   * @param {number} dataPointer - Function data pointer
   */
  updateClosurePointers(dataPointer) {
    const absoluteDataPointer = this.abs(dataPointer);

    // Function layout (data-relative): [proto:4][count:4][capacity:4][flags:4][entries:4][sym_entries:4][start:4][end:4][scope:4][function_flags:4]
    // First 24 bytes are object header - reuse updateObjectEntryPointers
    this.updateObjectEntryPointers(dataPointer);

    // Scope is at data-relative offset 32 (after object header + start + end)
    const oldScopeDataPointer = this.view.getUint32(absoluteDataPointer + 32, true);
    if (oldScopeDataPointer !== 0) {
      const newScopeDataPointer = this.getNewDataPointer(oldScopeDataPointer);
      if (newScopeDataPointer !== oldScopeDataPointer) {
        this.view.setUint32(absoluteDataPointer + 32, newScopeDataPointer, true);
      }
    }
  }

  /**
   * Update pointers within a promise.
   * @param {number} dataPointer - Pointer to promise data
   */
  updatePromisePointers(dataPointer) {
    const absoluteDataPointer = this.abs(dataPointer);

    // Promise layout: [status:4][value:16][waiters:4]
    // The value field is a standard 16-byte VALUE slot — forward it
    // through the canonical walker (mirrors markPromise). The old
    // bespoke switch here was a drifted reduced copy of
    // updateValuePointer that silently skipped BigInt/Rational/Complex/
    // Map/Set/msgpack-ref/bound-method values (left un-forwarded after
    // a move).
    this.updateValuePointer(dataPointer + PROMISE.VALUE);

    const oldWaiters = this.view.getUint32(
      absoluteDataPointer + PROMISE.WAITERS, true);
    if (oldWaiters !== 0) {
      const newWaiters = this.getNewDataPointer(oldWaiters);
      if (newWaiters !== oldWaiters) {
        this.view.setUint32(
          absoluteDataPointer + PROMISE.WAITERS, newWaiters, true);
      }
    }

    // Update handlers list head (DATA pointer)
    const oldHandlers = this.view.getInt32(absoluteDataPointer + PROMISE.HANDLERS, true);
    if (oldHandlers !== -1) {
      const newHandlers = this.getNewDataPointer(oldHandlers);
      if (newHandlers !== oldHandlers) {
        this.view.setInt32(absoluteDataPointer + PROMISE.HANDLERS, newHandlers, true);
      }
    }
  }

  updatePromiseWaiterPointer(dataPointer) {
    const address = this.abs(dataPointer + PROMISE_WAITER.NEXT);
    const oldNext = this.view.getUint32(address, true);
    if (oldNext === 0) return;
    const newNext = this.getNewDataPointer(oldNext);
    if (newNext !== oldNext) this.view.setUint32(address, newNext, true);
  }

  /**
   * Update pointers in a ThenHandler.
   * @param {number} dataPointer - Pointer to handler data
   */
  updateThenHandlerPointers(dataPointer) {
    const absAddr = this.abs(dataPointer);

    // onResolved: closure HEADER pointer
    const oldResolved = this.view.getUint32(absAddr + THEN_HANDLER.ON_RESOLVED, true);
    if (oldResolved !== 0) {
      const newResolved = this.getNewHeaderPointer(oldResolved);
      if (newResolved !== oldResolved) {
        this.view.setUint32(absAddr + THEN_HANDLER.ON_RESOLVED, newResolved, true);
      }
    }

    // onRejected: closure HEADER pointer
    const oldRejected = this.view.getUint32(absAddr + THEN_HANDLER.ON_REJECTED, true);
    if (oldRejected !== 0) {
      const newRejected = this.getNewHeaderPointer(oldRejected);
      if (newRejected !== oldRejected) {
        this.view.setUint32(absAddr + THEN_HANDLER.ON_REJECTED, newRejected, true);
      }
    }

    // childPromise: DATA pointer
    const oldChild = this.view.getUint32(absAddr + THEN_HANDLER.CHILD_PROMISE, true);
    if (oldChild !== 0) {
      const newChild = this.getNewDataPointer(oldChild);
      if (newChild !== oldChild) {
        this.view.setUint32(absAddr + THEN_HANDLER.CHILD_PROMISE, newChild, true);
      }
    }

    // next: DATA pointer
    const oldNext = this.view.getInt32(absAddr + THEN_HANDLER.NEXT, true);
    if (oldNext !== -1) {
      const newNext = this.getNewDataPointer(oldNext);
      if (newNext !== oldNext) {
        this.view.setInt32(absAddr + THEN_HANDLER.NEXT, newNext, true);
      }
    }
  }

  /**
   * Move live objects to their new locations.
   */
  moveObjects() {
    const heapStart = this.manipulator.getHeapStart();
    const heapPointer = this.manipulator.getHeapPointer();

    let readHeaderPointer = heapStart;
    let newHeapPointer = heapStart;

    while (readHeaderPointer < heapPointer) {
      const size = this.readHeaderSize(readHeaderPointer);
      if (size === 0) {
        throw new Error(`zero-size heap header at ${readHeaderPointer} before heap pointer ${heapPointer}`);
      }

      if (this.isMarked(readHeaderPointer)) {
        const newHeaderPointer = this.getForwardingPointer(readHeaderPointer);

        if (newHeaderPointer !== readHeaderPointer) {
          // Move the object using copyWithin
          const absSrc = this.abs(readHeaderPointer);
          const absDst = this.abs(newHeaderPointer);
          this.bytes.copyWithin(absDst, absSrc, absSrc + size);
        }

        // Clear mark and forwarding pointer in new location
        this.clearMark(newHeaderPointer);
        this.setForwardingPointer(newHeaderPointer, 0);

        newHeapPointer = newHeaderPointer + size;
      }

      readHeaderPointer += size;
    }

    this.manipulator.setHeapPointer(newHeapPointer);
    if (newHeapPointer !== heapPointer) {
      writeHeaderEventRingEntry(this.view, this.baseOffset, {
        kind: HEADER_EVENT_KIND.FIELD_WRITE,
        field: HEADER_EVENT_FIELD.HEAP_POINTER,
        site: HEADER_EVENT_SITE.JS_COLLECTOR_MOVE_OBJECTS,
        oldValue: heapPointer,
        newValue: newHeapPointer,
      });
    }
    return newHeapPointer;
  }

  // ===========================================================================
  // Phase 5: String Compaction
  // ===========================================================================

  /**
   * Compact the string table by removing unmarked strings.
   *
   * All bookkeeping is in TABLE-RELATIVE id space (matching what's
   * stored on the heap). The bump-pointer STATE field is
   * segment-relative; we convert at the boundary.
   */
  compactStrings() {
    const stringStart = this.manipulator.getStringStart();
    const oldStringPointer = this.manipulator.getStringPointer();
    // Table-relative bump pointer = segment_pointer - string_start.
    const oldStringPointerRel = oldStringPointer - stringStart;

    // Build forwarding table (keys and values are table-relative ids).
    const stringForwarding = this.computeStringForwarding();

    // If no strings were collected, skip the rest
    if (stringForwarding.size === 0) {
      const stringsRetained = oldStringPointerRel - this.stringDataStart;
      return { stringsRetained, stringsCollected: 0 };
    }

    // Update all string offsets in the heap
    this.updateStringOffsets(stringForwarding);

    // Update string offsets in ALL allocated contexts
    const allocatedContexts = this.getAllocatedContexts();
    for (const slot of allocatedContexts) {
      const bounds = this.getContextStackBounds(slot);
      this.updatePendingStackStringsForContext(bounds.pendingBase, bounds.pendingPointer, stringForwarding);
      this.updateGrantStackStringsForContext(bounds.grantStackBase, bounds.grantStackPointer, stringForwarding);
      this.updateRequestBaseStringsForContext(slot, stringForwarding);
      // Completion value (live while a finally runs with a pending
      // return/throw): marked in markContextRoots, so the string
      // relocates — the stored id must relocate with it.
      if (bounds.completionType !== 0 && bounds.completionValue !== 0) {
        this.updateValueStringOffset(bounds.completionValue, stringForwarding);
      }
      // v11: per-entry pending completions on the try stack carry the
      // same class of value.
      for (let entryAddr = bounds.tryStackBase; entryAddr < bounds.tryStackPointer;
           entryAddr += TRY_ENTRY_SIZE) {
        const completionType = this.view.getUint32(
          this.abs(entryAddr + TRY_ENTRY.COMPLETION_TYPE), true);
        if (completionType === COMPLETION_THROW || completionType === COMPLETION_RETURN) {
          this.updateValueStringOffset(entryAddr + TRY_ENTRY.COMPLETION_VALUE, stringForwarding);
        }
      }
    }

    // Update string offsets in code block
    this.updateCodeBlockStrings(stringForwarding);

    // Update string offsets in builtins table
    this.updateBuiltinsStrings(stringForwarding);

    // Update string offsets in AST nodes. Must run BEFORE moveStrings:
    // the walker reads nodes (materializing strings) at their old
    // offsets while rewriting the fields to the forwarded ones.
    this.updateAstStrings(stringForwarding);

    // Move strings to new locations. Returns table-relative new bump.
    const newStringPointerRel = this.moveStrings(stringForwarding);

    // Rebuild hash table
    this.rebuildHashTable();

    const stringsRetained = newStringPointerRel - this.stringDataStart;
    const stringsCollected = oldStringPointerRel - newStringPointerRel;

    return { stringsRetained, stringsCollected };
  }

  /**
   * Compute forwarding for live strings.
   *
   * Keys and values are TABLE-RELATIVE ids (matching what's stored on
   * the heap). A value of 0 means "this id is dead; drop references".
   */
  computeStringForwarding() {
    const forwarding = new Map();
    const stringStart = this.manipulator.getStringStart();
    const stringPointerRel = this.manipulator.getStringPointer() - stringStart;

    let readId = this.stringDataStart;
    let writeId = this.stringDataStart;

    while (readId < stringPointerRel) {
      const absoluteReadPointer = this.manipulator.stringIdToAbs(readId);
      const length = this.view.getUint32(absoluteReadPointer, true);
      const entrySize = 4 + length;
      const alignedSize = (entrySize + 3) & ~3;

      if (this.isStringMarked(readId)) {
        if (readId !== writeId) {
          forwarding.set(readId, writeId);
        }
        writeId += alignedSize;
      } else {
        forwarding.set(readId, 0);
      }

      readId += alignedSize;
    }

    return forwarding;
  }

  /**
   * Update all string offsets in the heap.
   */
  updateStringOffsets(forwarding) {
    const heapStart = this.manipulator.getHeapStart();
    const heapPointer = this.manipulator.getHeapPointer();

    let headerPointer = heapStart;
    while (headerPointer < heapPointer) {
      const size = this.readHeaderSize(headerPointer);
      if (size === 0) {
        throw new Error(`zero-size heap header at ${headerPointer} before heap pointer ${heapPointer}`);
      }

      const objType = this.readHeaderType(headerPointer);
      const dataPointer = headerPointer + GC_HEADER_SIZE;
      this.updateObjectStringOffsets(dataPointer, objType, forwarding);

      headerPointer += size;
    }
  }

  /**
   * Update string offsets within a heap object.
   */
  updateObjectStringOffsets(dataPointer, objType, forwarding) {
    switch (objType) {
      case OBJ.ARRAY:
        this.updateArrayStringOffsets(dataPointer, forwarding);
        break;

      case OBJ.OBJECT:
        this.updateObjectEntryStringOffsets(dataPointer, forwarding);
        break;

      case OBJ.SCOPE:
        this.updateScopeStringOffsets(dataPointer, forwarding);
        break;

      case OBJ.FUNCTION:
        // Functions have object properties - reuse object entry string offset update
        this.updateObjectEntryStringOffsets(dataPointer, forwarding);
        break;

      case OBJ.PARAM_LIST:
        this.updateParamListStringOffsets(dataPointer, forwarding);
        break;

      case OBJ.ARRAY_DATA:
        // Elements' string offsets are updated by updateArrayStringOffsets via
        // the parent ARRAY, bounded by `length`. No standalone walk here — it
        // would walk to capacity over unwritten tail slots (same reason as the
        // ARRAY_DATA cases in markObject / updatePointers).
        break;

      case OBJ.SCOPE_ENTRIES:
        // Scope entries string offsets are updated via updateScopeStringOffsets
        break;

      case OBJ.ARRAYBUFFER:
        // ArrayBuffer has no string offsets to update (just raw bytes)
        break;

      case OBJ.TYPED_ARRAY_DESCRIPTOR:
        // The descriptor fields carry no string offsets, but symbol-keyed
        // property VALUES (sym_entries at data-relative +12) may be strings.
        this.updateSymEntriesStringOffsets(dataPointer + 12, forwarding);
        break;

      case OBJ.SYMBOL: {
        // [descriptionStringOffset:4] — an interned-string id; forward it
        // like any other string reference (mirror of the mark-phase
        // OBJ.SYMBOL case). Unforwarded, every string compaction left the
        // description dangling at its pre-move id.
        const absSymbol = this.abs(dataPointer);
        const oldOffset = this.view.getUint32(absSymbol, true);
        if (oldOffset !== 0) {
          const newOffset = forwarding.get(oldOffset);
          if (newOffset !== undefined && newOffset !== 0 && newOffset !== oldOffset) {
            this.view.setUint32(absSymbol, newOffset, true);
          }
        }
        break;
      }

      case OBJ.REGEXP: {
        // [patternStringOffset:4] at data+0 — an interned-string id;
        // forward it like any other string reference (mirror of the
        // mark-phase OBJ.REGEXP case).
        const absPattern = this.abs(dataPointer + REGEXP.PATTERN_STRING);
        const oldOffset = this.view.getUint32(absPattern, true);
        if (oldOffset !== 0) {
          const newOffset = forwarding.get(oldOffset);
          if (newOffset !== undefined && newOffset !== 0 && newOffset !== oldOffset) {
            this.view.setUint32(absPattern, newOffset, true);
          }
        }
        break;
      }

      case OBJ.SCHEMA: {
        // The source value slot is traced like an array element.
        this.updateValueStringOffset(dataPointer + SCHEMA.SOURCE, forwarding);
        break;
      }

      case OBJ.MAP:
      case OBJ.SET: {
        // Map/Set header: [size:4][slotCount:4][capacity:4][entriesHeader:4][sym_entries:4].
        // entriesHeader was already forwarded by the relocate pass, so it
        // points at the entries block's current location.
        const slotCount = this.view.getUint32(this.abs(dataPointer + 4), true);
        const entriesHeader = this.view.getUint32(this.abs(dataPointer + 12), true);
        if (entriesHeader !== 0) {
          // Update slot string offsets HERE, bounded by slotCount — NOT in the
          // standalone MAP_ENTRIES/SET_ENTRIES case, which would walk to
          // capacity over unwritten tail slots.
          const entriesData = entriesHeader + GC_HEADER_SIZE;
          if (objType === OBJ.MAP) {
            for (let i = 0; i < slotCount; i++) {
              const slotAddr = entriesData + i * 36;
              this.updateValueStringOffset(slotAddr + 4, forwarding);   // key
              this.updateValueStringOffset(slotAddr + 20, forwarding);  // value
            }
          } else {
            for (let i = 0; i < slotCount; i++) {
              this.updateValueStringOffset(entriesData + i * 20 + 4, forwarding);  // value
            }
          }
        }
        // Symbol-keyed property VALUES (sym_entries at data-relative +16).
        this.updateSymEntriesStringOffsets(dataPointer + 16, forwarding);
        break;
      }

      case OBJ.MAP_ENTRIES:
      case OBJ.SET_ENTRIES:
        // Slot string offsets are updated by the parent OBJ.MAP / OBJ.SET case,
        // bounded by slotCount. No standalone walk here.
        break;

      case OBJ.PROMISE:
        // The settled value is a standard 16-byte VALUE slot and can hold
        // a string id. This case was MISSING: a promise resolving a
        // string kept its pre-compaction id after any string compaction
        // (and the old markPromise never string-marked it either — both
        // now route through the canonical value walkers).
        this.updateValueStringOffset(dataPointer + PROMISE.VALUE, forwarding);
        break;
    }
  }

  /**
   * Update string offsets in array elements.
   */
  updateArrayStringOffsets(dataPointer, forwarding) {
    const absoluteDataPointer = this.abs(dataPointer);

    const length = this.view.getUint32(absoluteDataPointer, true);
    // data_ptr at +8 is a HEADER pointer; element data starts after its GC
    // header. (This pass runs in compactStrings, after moveObjects, so the
    // header pointer already reflects the post-move location.)
    const dataBlockHeaderPointer = this.view.getUint32(absoluteDataPointer + 8, true);

    if (dataBlockHeaderPointer !== 0) {
      const dataBlockDataPointer = dataBlockHeaderPointer + GC_HEADER_SIZE;
      for (let i = 0; i < length; i++) {
        const elemAddr = dataBlockDataPointer + i * VALUE_SIZE;
        this.updateValueStringOffset(elemAddr, forwarding);
      }
    }

    // Own symbol-keyed properties (sym_entries at data-relative +16).
    this.updateSymEntriesStringOffsets(dataPointer + 16, forwarding);
  }

  /**
   * Update string offsets in object entries.
   */
  updateObjectEntryStringOffsets(dataPointer, forwarding) {
    const absoluteDataPointer = this.abs(dataPointer);
    const entrySize = 20;

    // Object data layout (data-relative): [prototype:4][count:4][capacity:4][flags:4][entries:4][sym_entries:4]
    const count = this.view.getUint32(absoluteDataPointer + 4, true);
    // entries stores a HEADER pointer
    const entriesHeaderPointer = this.view.getUint32(absoluteDataPointer + 16, true);

    // Symbol-keyed entries: keys are symbol pointers (no string offset),
    // but the VALUES may be strings and need forwarding.
    this.updateSymEntriesStringOffsets(dataPointer + 20, forwarding);

    if (entriesHeaderPointer === 0) return;

    // Entry data starts after GC header
    const entriesDataPointer = entriesHeaderPointer + GC_HEADER_SIZE;

    for (let i = 0; i < count; i++) {
      const entryAddr = entriesDataPointer + i * entrySize;
      const absEntryAddr = this.abs(entryAddr);

      // Key is a string offset
      const oldKey = this.view.getUint32(absEntryAddr, true);
      const newKey = forwarding.get(oldKey);
      if (newKey !== undefined && newKey !== 0 && newKey !== oldKey) {
        this.view.setUint32(absEntryAddr, newKey, true);
      }

      // Value might be a string
      this.updateValueStringOffset(entryAddr + 4, forwarding);
    }
  }

  /**
   * Forward string offsets inside a sym-entries block's values after
   * string-table compaction. Shared by every receiver kind that carries
   * own symbol-keyed properties. Keys are symbol heap pointers and carry
   * no string offsets; the symbol's description offset is forwarded when
   * the walker visits the symbol object itself.
   * @param {number} slotAddr - Relative address of the sym-entries pointer slot
   */
  updateSymEntriesStringOffsets(slotAddr, forwarding) {
    const symEntriesHeaderPointer = this.view.getUint32(this.abs(slotAddr), true);
    if (symEntriesHeaderPointer === 0) return;
    const symBlockData = symEntriesHeaderPointer + GC_HEADER_SIZE;
    const symCount = this.view.getUint32(this.abs(symBlockData), true);
    const symEntriesStart = symBlockData + 8;
    for (let i = 0; i < symCount; i++) {
      this.updateValueStringOffset(symEntriesStart + i * 20 + 4, forwarding);
    }
  }

  /**
   * Update string offsets in scope bindings.
   */
  updateScopeStringOffsets(dataPointer, forwarding) {
    const absoluteDataPointer = this.abs(dataPointer);

    const count = this.view.getUint32(absoluteDataPointer + 4, true);
    // entries stores a HEADER pointer
    const entriesHeaderPointer = this.view.getUint32(absoluteDataPointer + 12, true);

    if (entriesHeaderPointer === 0) return;

    // Sanity check
    const heapStart = this.manipulator.getHeapStart();
    const heapPointer = this.manipulator.getHeapPointer();
    if (entriesHeaderPointer < heapStart || entriesHeaderPointer >= heapPointer) {
      return;
    }

    // Entry data starts after GC header
    const entriesDataPointer = entriesHeaderPointer + GC_HEADER_SIZE;

    for (let i = 0; i < count; i++) {
      const entryAddr = entriesDataPointer + i * 20;
      const absEntryAddr = this.abs(entryAddr);

      // Key is a string offset
      const oldKey = this.view.getUint32(absEntryAddr, true);
      const newKey = forwarding.get(oldKey);
      if (newKey !== undefined && newKey !== 0 && newKey !== oldKey) {
        this.view.setUint32(absEntryAddr, newKey, true);
      }

      // Value might be a string
      this.updateValueStringOffset(entryAddr + 4, forwarding);
    }
  }

  /**
   * Update string offsets in param list.
   */
  updateParamListStringOffsets(dataPointer, forwarding) {
    const absoluteDataPointer = this.abs(dataPointer);

    const count = this.view.getUint32(absoluteDataPointer, true);

    for (let i = 0; i < count; i++) {
      const offsetAddr = absoluteDataPointer + 4 + i * 4;
      const oldOffset = this.view.getUint32(offsetAddr, true);
      const newOffset = forwarding.get(oldOffset);
      if (newOffset !== undefined && newOffset !== 0 && newOffset !== oldOffset) {
        this.view.setUint32(offsetAddr, newOffset, true);
      }
    }
  }

  /**
   * Update a value's string offset if it's a string type.
   */
  updateValueStringOffset(valueAddr, forwarding) {
    const absAddr = this.abs(valueAddr);
    const type = this.view.getUint32(absAddr, true);

    if (type === TYPE.STRING) {
      const oldOffset = this.view.getUint32(absAddr + 8, true);
      const newOffset = forwarding.get(oldOffset);
      if (newOffset !== undefined && newOffset !== 0 && newOffset !== oldOffset) {
        this.view.setUint32(absAddr + 8, newOffset, true);
      }
    } else if (type === TYPE.BOUND_METHOD) {
      // For string receivers, BOUND_METHOD.data_lo is a string id
      // (not a heap pointer). The receiver type is stored in flags'
      // low byte. Without this update, methods bound to long-lived
      // strings retain pre-compaction ids and fail on their next use.
      const flags = this.view.getUint32(absAddr + 4, true);
      if ((flags & 0xff) === TYPE.STRING) {
        const oldId = this.view.getUint32(absAddr + 8, true);
        const newId = forwarding.get(oldId);
        if (newId !== undefined && newId !== 0 && newId !== oldId) {
          this.view.setUint32(absAddr + 8, newId, true);
        }
      }
    } else if (type === TYPE.EXTERNAL_METHOD) {
      // EXTERNAL_METHOD.data_hi is the method name's interned-string
      // id; the next call on the binding ships it as the external
      // request's methodOffset. Mirror of the markValue case.
      const oldId = this.view.getUint32(absAddr + 12, true);
      const newId = forwarding.get(oldId);
      if (newId !== undefined && newId !== 0 && newId !== oldId) {
        this.view.setUint32(absAddr + 12, newId, true);
      }
    }
  }

  /**
   * Forward string ids in the external request block for a slot
   * parked at an external yield (EXIT_EXTERNAL_CALL /
   * EXIT_EXTERNAL_PROPERTY / EXIT_EXTERNAL_PROPERTY_SET):
   *   - request_base+4 (methodOffset) is an interned-string id.
   *   - the request's arg value slots live ABOVE the pre-positioned
   *     pending pointer and are missed by the normal stack scan.
   * Mirror of the external-exit case in markRequestBaseForContext;
   * without this, the host's post-GC readString(methodOffset) interprets
   * unrelated table bytes as a length prefix or rejects the id as outside
   * the string region.
   *
   * @param {number} slot - Context slot index
   * @param {Map} forwarding - String forwarding table
   */
  updateRequestBaseStringsForContext(slot, forwarding) {
    const exitCondition = this.manipulator.getExitCondition(slot);
    if (exitCondition !== EXIT_EXTERNAL_CALL
        && exitCondition !== EXIT_EXTERNAL_PROPERTY
        && exitCondition !== EXIT_EXTERNAL_PROPERTY_SET) {
      return;
    }
    const absReqBase = this.abs(this.manipulator.getExternalRequestBase(slot));

    const oldOffset = this.view.getUint32(absReqBase + 4, true);
    if (oldOffset !== 0) {
      const newOffset = forwarding.get(oldOffset);
      if (newOffset !== undefined && newOffset !== 0 && newOffset !== oldOffset) {
        this.view.setUint32(absReqBase + 4, newOffset, true);
      }
    }

    const argsPointer = this.view.getUint32(absReqBase + 8, true);
    const argCount = this.view.getUint32(absReqBase + 12, true);
    this.updatePendingStackStringsForContext(
      argsPointer, argsPointer + argCount * VALUE_SIZE, forwarding);
  }

  /**
   * Update string offsets in a pending stack range.
   * @param {number} base - Stack base (segment-relative)
   * @param {number} pointer - Stack pointer (segment-relative)
   * @param {Map} forwarding - String forwarding table
   */
  updatePendingStackStringsForContext(base, pointer, forwarding) {
    for (let addr = base; addr < pointer; addr += VALUE_SIZE) {
      this.updateValueStringOffset(addr, forwarding);
    }
  }

  /**
   * Update string offsets in a grant stack range.
   * @param {number} base - Stack base (segment-relative)
   * @param {number} pointer - Stack pointer (segment-relative)
   * @param {Map} forwarding - String forwarding table
   */
  updateGrantStackStringsForContext(base, pointer, forwarding) {
    // The stride MUST be the real GRANT_ENTRY_SIZE from constants —
    // same rule as markGrantStackForContext. A stale local `24` (the
    // pre-SCOPE_POINTER layout) forwarded entry 0 correctly and then
    // walked mid-entry: every deeper grant identifier kept its stale
    // id across compaction, so a suspended context under nested
    // grants resumed into the "requires a grant not in the current
    // grant stack" family (tests/fuel/gc_context_stack_strings_test.js).
    for (let entryAddr = base; entryAddr < pointer; entryAddr += GRANT_ENTRY_SIZE) {
      // Identifier value is at offset 0
      this.updateValueStringOffset(entryAddr, forwarding);
    }
  }

  /**
   * Update string offsets in code block instructions.
   * Same opcodes as markCodeBlockStrings (derived from OPCODE_OPERANDS).
   */
  updateCodeBlockStrings(forwarding) {
    const instrCount = this.manipulator.codeBlockInstructionCount();
    if (instrCount === 0) return;
    const codeStart = this.manipulator.getCodeStart();

    // Instructions grow downward from code_start
    for (let i = 0; i < instrCount; i++) {
      const instrAddr = codeStart - (i + 1) * INSTRUCTION_SIZE;
      const absAddr = this.abs(instrAddr);
      const opcode = this.view.getUint8(absAddr);

      if (STRING_OPERAND_OPCODES.has(opcode)) {
        const oldOffset = this.view.getUint32(absAddr + 8, true);
        if (oldOffset !== 0) {
          const newOffset = forwarding.get(oldOffset);
          if (newOffset !== undefined && newOffset !== 0 && newOffset !== oldOffset) {
            this.view.setUint32(absAddr + 8, newOffset, true);
          }
        }
      }
    }
  }

  /**
   * Forward string offsets inside AST nodes across string compaction.
   * Same fields as `markAstStrings`. The yielded fieldPointer is
   * absolute — written directly, no abs().
   */
  updateAstStrings(forwarding) {
    if (!this.manipulator.isAstRegionInitialized()) return;
    const reader = createAstReader(this.manipulator);
    for (const { fieldPointer, stringOffset } of reader.iterateStringFields()) {
      const newOffset = forwarding.get(stringOffset);
      if (newOffset !== undefined && newOffset !== 0 && newOffset !== stringOffset) {
        this.view.setUint32(fieldPointer, newOffset, true);
      }
    }
  }

  /**
   * Update string offsets in the builtins table.
   * The builtins table stores string offsets for built-in method names.
   */
  updateBuiltinsStrings(forwarding) {
    const builtinsBase = this.manipulator.getBuiltinsBase();

    // The builtins region holds string-table offsets for every entry
    // in BUILTIN_NAME (constants.js). After string compaction, every
    // populated slot must be forwarded or the WAT's `read_builtin`
    // calls return stale offsets that no longer match the (forwarded)
    // operands in the bytecode.
    //
    // Walk the entire BUILTINS region. Empty slots (offset 0) are
    // skipped, so iterating the full region is safe even though only
    // a subset of slots are populated.
    //
    // The walk must cover BUILTINS_SIZE. Later slots include Promise methods,
    // typed-array names, and Symbol-related names; leaving any populated slot
    // unforwarded breaks dispatch after string compaction.
    const slotCount = BUILTINS_SIZE / 4;

    for (let i = 0; i < slotCount; i++) {
      const slotAddr = builtinsBase + i * 4;
      const absSlotAddr = this.abs(slotAddr);
      const oldOffset = this.view.getUint32(absSlotAddr, true);

      if (oldOffset !== 0) {
        const newOffset = forwarding.get(oldOffset);
        if (newOffset !== undefined && newOffset !== 0 && newOffset !== oldOffset) {
          this.view.setUint32(absSlotAddr, newOffset, true);
        }
      }
    }
  }

  /**
   * Move live strings to their new locations.
   *
   * Works in TABLE-RELATIVE ids. The bump pointer (STATE.STRING_POINTER)
   * is segment-relative; we convert at the boundary.
   *
   * Returns the new bump pointer as a TABLE-RELATIVE value (caller uses
   * it for the retained/collected tally).
   */
  moveStrings(forwarding) {
    const stringStart = this.manipulator.getStringStart();
    const stringPointerRel = this.manipulator.getStringPointer() - stringStart;

    let readId = this.stringDataStart;
    let newWriteId = this.stringDataStart;

    while (readId < stringPointerRel) {
      const absoluteReadPointer = this.manipulator.stringIdToAbs(readId);
      const length = this.view.getUint32(absoluteReadPointer, true);
      const entrySize = 4 + length;
      const alignedSize = (entrySize + 3) & ~3;

      if (this.isStringMarked(readId)) {
        const newId = forwarding.get(readId);
        const targetId = (newId !== undefined && newId !== 0) ? newId : readId;

        if (targetId !== readId) {
          // Move the string
          const absSrc = this.manipulator.stringIdToAbs(readId);
          const absDst = this.manipulator.stringIdToAbs(targetId);
          this.bytes.copyWithin(absDst, absSrc, absSrc + alignedSize);
        }

        newWriteId = targetId + alignedSize;
      }

      readId += alignedSize;
    }

    // Write back segment-relative bump pointer.
    this.manipulator.setStringPointer(stringStart + newWriteId);
    return newWriteId;
  }

  /**
   * Rebuild the hash table after string compaction.
   *
   * Walks live string entries in TABLE-RELATIVE id space and stores the
   * table-relative ids in the bucket payload column.
   */
  rebuildHashTable() {
    const stringStart = this.manipulator.getStringStart();
    const stringEnd = this.manipulator.getStringEnd();
    const stringPointerRel = this.manipulator.getStringPointer() - stringStart;
    const regionSize = stringEnd - stringStart;
    const bucketCount = hashTableBuckets(regionSize);

    // Clear the hash index (lives at the TAIL of the string region).
    const hashTableStart = this.abs(stringEnd - hashTableSize(regionSize));
    for (let i = 0; i < hashTableSize(regionSize); i += 4) {
      this.view.setUint32(hashTableStart + i, 0, true);
    }

    // Re-insert each live string
    let id = this.stringDataStart;
    while (id < stringPointerRel) {
      const absolutePointer = this.manipulator.stringIdToAbs(id);
      const length = this.view.getUint32(absolutePointer, true);
      const entrySize = 4 + length;
      const alignedSize = (entrySize + 3) & ~3;

      // Compute hash of string bytes
      const hash = this.computeStringHash(this.manipulator.stringIdToSegmentOffset(id) + 4, length);

      // Insert into hash table with ascending linear probing. A bucket
      // is free iff its OFFSET column is 0 (valid ids are >=
      // STRING_DATA_START > 0); the hash column is 0 for a legit
      // string whose FNV-1a hash is 0, so testing it could overwrite a
      // live bucket. Exhausting every bucket is proven-impossible
      // (the index is sized past the data span's max entry count) —
      // throw instead of silently leaving the entry out of the index,
      // mirroring the WAT rebuild's trap.
      let bucketIndex = hash % bucketCount;
      let inserted = false;

      for (let probe = 0; probe < bucketCount; probe++) {
        const bucketPointer = hashTableStart + bucketIndex * 8;
        const storedOffset = this.view.getUint32(bucketPointer + 4, true);

        if (storedOffset === 0) {
          // Empty bucket — insert. Bucket payload is table-relative id.
          this.view.setUint32(bucketPointer, hash, true);
          this.view.setUint32(bucketPointer + 4, id, true);
          inserted = true;
          break;
        }

        bucketIndex = (bucketIndex + 1) % bucketCount;
      }
      if (!inserted) {
        throw new Error(
          `rebuildHashTable: hash index saturated at id ${id} — ` +
          `structurally impossible under the derived sizing; a writer ` +
          `must have bypassed $intern_string`);
      }

      id += alignedSize;
    }
  }

  /**
   * Compute FNV-1a hash of string bytes.
   */
  computeStringHash(ptr, length) {
    let hash = FNV_OFFSET_BASIS;
    const absolutePointer = this.abs(ptr);

    for (let i = 0; i < length; i++) {
      const byte = this.bytes[absolutePointer + i];
      hash ^= byte;
      hash = Math.imul(hash, FNV_PRIME) >>> 0;
    }

    return hash;
  }
}

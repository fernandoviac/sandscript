/**
 * SandScript Fuel-Based Interpreter - Memory Image
 *
 * Provides typed access to interpreter state in linear memory.
 * Supports segment model (multiple interpreters in one WebAssembly.Memory).
 */

import { MemoryReader } from './memory-reader.js';
import {
  HEADER,
  HEADER_SIZE,
  VERSION,
  STATE,
  STATE_SIZE,
  REGION_SIZE,
  STRING_DATA_START,
  hashTableBuckets,
  hashTableSize,
  FNV_OFFSET_BASIS,
  FNV_PRIME,
  FRAME,
  FRAME_SIZE,
  VALUE_SIZE,
  BUILTINS_SIZE,
  FLAG_RATIONAL_INLINE,
  TYPE,
  OBJ,
  REGEXP,
  SCHEMA,
  ARRAY_FLAG,
  GC_HEADER_SIZE,
  SCRATCH_SIZE,
  TRY_ENTRY,
  TRY_ENTRY_SIZE,
  GRANT_ENTRY,
  GRANT_ENTRY_SIZE,
  INSTRUCTION_SIZE,
  CODE_BLOCK_FLAG,
  BUILTIN_NAME,
  CLOSURE_FLAG_ARROW,
  CLOSURE_FLAG_ASYNC,
  METHOD,
  OBJECT,
  OBJECT_FLAG,
  OBJECT_HEADER_SIZE,
  MAP_LAYOUT,
  SET_LAYOUT,
  MAP_HEADER_DATA_SIZE,
  ARRAY,
  ARRAY_HEADER_SIZE,
  TYPED_ARRAY_SYM_ENTRIES_OFFSET,
  FUNCTION,
  FUNCTION_HEADER_SIZE,
  SYM_ENTRIES,
  OP,
  // Context support (Design B: heap-allocated context object + per-stack blocks)
  CONTEXT_STATE_OFFSET,
  CONTEXT_OBJECT_SIZE,
  CONTEXT_PENDING_INITIAL_SIZE,
  CONTEXT_CALL_STACK_INITIAL_SIZE,
  CONTEXT_TRY_STACK_INITIAL_SIZE,
  CONTEXT_GRANT_STACK_INITIAL_SIZE,
  CTX,
  CONTEXT_STATUS_FREE,
  RESPONSE_NORMAL,
  RESPONSE_THROW,
  // Promise support
  PROMISE,
  PROMISE_DATA_SIZE,
  PROMISE_WAITER,
  PROMISE_WAITER_DATA_SIZE,
  PROMISE_STATUS_PENDING,
  // ThenHandler support
  THEN_HANDLER,
  THEN_HANDLER_DATA_SIZE,
  THEN_HANDLER_FLAG_FINALLY,
  AST_REGION,
  AST_REGION_HEADER_SIZE,
  HEADER_EVENT_KIND,
  HEADER_EVENT_FIELD,
  HEADER_EVENT_SITE,
} from './constants.js';
import { writeHeaderEventRingEntry } from './header-event-ring.js';
import { FORMAT_NAMES } from './schema-engine-contract.js';

/**
 * Signaled by JS-side allocators (MemoryImage.allocate and the inline
 * allocator helpers like allocateObject) when a heap-budget pre-check
 * detects that the next allocation would overrun into the bytecode
 * region.
 *
 * The WAT-side `$memory_pressure_signaled` flag is set before this is
 * thrown, but that flag is an INTRA-RUN signal only: run() clears it
 * at function entry, so pressure raised between runs does NOT make
 * the next run() yield 'memory_pressure'. Recovery paths must act on
 * the catch itself — the deferred-marshal path stashes the value and
 * runContext surfaces 'memory_pressure' directly when the drain
 * stays under pressure (see airlock._drainDeferredMarshal). If the
 * host instead waits for another run to observe the flag, run entry
 * clears it and the streaming context remains silently parked.
 *
 * Hosts can catch this at marshal/dispatch boundaries to treat it as
 * a recoverable signal (run gc, retry) rather than a terminal error.
 */
export class HeapPressureSignal extends Error {
  /**
   * @param {number} requestedBytes
   * @param {number} availableBytes
   * @param {string|null} [message] - Override for the default heap
   *   message. Used by string-table pressure, which carries the same
   *   "gc and retry" recovery contract but a different description.
   * @param {'heap'|'string-table'} [region]
   */
  constructor(requestedBytes, availableBytes, message = null, region = 'heap') {
    super(
      message ??
      (`Heap pressure: requested ${requestedBytes} bytes, available ${availableBytes} ` +
       `(would overrun bytecode region). Host should gc and retry the operation.`)
    );
    this.name = 'HeapPressureSignal';
    this.requestedBytes = requestedBytes;
    this.availableBytes = availableBytes;
    this.region = region;
  }
}

/**
 * MemoryImage provides typed access to interpreter state.
 *
 * Extends MemoryReader (the read-only base) and adds writers,
 * allocators, and the WASM-dependent helpers (`internString`,
 * `setWasmInstance`).
 */
export class MemoryImage extends MemoryReader {
  /**
   * @param {WebAssembly.Memory} memory - WASM memory instance
   * @param {number} baseOffset - Start of this interpreter's segment (default 0)
   * @param {number|null} segmentSize - Size of segment (default: entire memory)
   */
  constructor(memory, baseOffset = 0, segmentSize = null) {
    super(memory, baseOffset, segmentSize);

    // WASM instance (set by setWasmInstance after instantiation)
    this.wasm = null;
    this.encoder = new TextEncoder();

    // Marshalling detector chain. Each detector receives (jsValue, options)
    // and returns { type, dataLo?, dataHi? } to claim the value, or undefined
    // to defer. Registered once at startup by the host (typically airlock).
    // See docs on writeValueAt for the precedence rules.
    this._marshalDetectors = [];
  }

  /**
   * Register the marshalling detector chain. Called once at host init.
   *
   * Detectors are functions `(jsValue, options) => result | undefined` that
   * claim wrapper-typed values (External, MsgpackRef, Promise, JS function,
   * etc.). The first detector to return non-undefined wins. Detectors run
   * AFTER any per-call `options.marshal` override and BEFORE generic
   * JS-value marshalling.
   *
   * Stateless detectors (no `options` use) handle wrapper types whose
   * detection is independent of the calling context. Stateful detectors
   * may inspect `options.closureCaptureContextSlot` (or other options).
   *
   * @param {Array<(value: any, options: object) => ({type: number, dataLo?: number, dataHi?: number} | undefined)>} detectors
   */
  setMarshalDetectors(detectors) {
    this._marshalDetectors = detectors;
  }

  /**
   * Set the WASM instance for string interning.
   *
   * @param {WebAssembly.Instance} instance - WASM instance
   */
  setWasmInstance(instance) {
    this.wasm = instance;
    this.wasm.exports.init_segment(this.baseOffset);
  }

  /**
   * Relocate this memory image to a new baseOffset within the SAME
   * WebAssembly.Memory. The bytes at newBaseOffset must already be
   * valid (caller did the memcpy). After this call:
   *   - `this.baseOffset` is updated;
   *   - the WASM `init_segment(newBase)` is called so the
   *     interpreter's $base_offset matches;
   *   - `init_regions()` re-reads the region bases from STATE (which
   *     hold segment-relative offsets, unchanged by relocation, so
   *     this is effectively a no-op-but-required step in case a
   *     future build caches additional region values).
   *
   * The shared views (`this.view`, `this.u8`) cover the entire
   * underlying buffer, so they don't need rebuilding — only
   * `baseOffset` controls where reads/writes happen via `this.abs()`.
   *
   * @param {number} newBaseOffset - New segment base offset.
   */
  relocate(newBaseOffset) {
    if (typeof newBaseOffset !== 'number' || newBaseOffset < 0) {
      throw new Error(
        `MemoryImage.relocate: newBaseOffset must be a non-negative number, got ${newBaseOffset}`);
    }
    if (newBaseOffset + this.segmentSize > this.buffer.byteLength) {
      throw new Error(
        `MemoryImage.relocate: newBaseOffset (${newBaseOffset}) + segmentSize ` +
        `(${this.segmentSize}) exceeds buffer.byteLength (${this.buffer.byteLength})`);
    }
    this.baseOffset = newBaseOffset;
    if (this.wasm) {
      this.wasm.exports.init_segment(newBaseOffset);
      this.wasm.exports.init_regions();
    }
    // Magic validation: the bytes at newBaseOffset must still carry
    // the SANDFUEL header. validateMagic() throws on mismatch — wrap
    // it to add the relocation-specific context.
    try {
      this.validateMagic();
    } catch (e) {
      throw new Error(
        `MemoryImage.relocate: bytes at newBaseOffset=${newBaseOffset} ` +
        `don't carry a valid SANDFUEL header (${e.message}). ` +
        `Did the caller forget to memcpy the segment bytes before relocating?`);
    }
  }

  /**
   * Resize the SS region in place: grow or shrink the segment without
   * reconstructing state. Moves the code block + string table as one
   * contiguous block by `delta = new_string_start - old_string_start`,
   * rewrites the affected header fields, and refreshes the cached
   * `$string_start` global on the WAT side.
   *
   * Caller is responsible for:
   *   - having compacted the heap before a shrink (so `heap_pointer`
   *     is at the true high-water mark);
   *   - the buffer envelope: `newSegmentSize <= buffer.byteLength -
   *     baseOffset`. The host grows the buffer (or its slab) before
   *     calling for a grow that exceeds the current envelope.
   *
   * @param {object} args
   * @param {number} args.newSegmentSize - New total segment size (bytes).
   * @param {number} [args.newStringTableSize] - New string table size.
   *   Defaults to the current string-table size (`segmentSize -
   *   STATE.STRING_START`). Pass to grow/shrink the string table
   *   independently of the heap.
   */
  resizeSegment({ newSegmentSize, newStringTableSize }) {
    if (typeof newSegmentSize !== 'number' || newSegmentSize <= 0) {
      throw new Error(
        `MemoryImage.resizeSegment: newSegmentSize must be a positive ` +
        `number, got ${newSegmentSize}`);
    }
    if (newSegmentSize > this.buffer.byteLength - this.baseOffset) {
      throw new Error(
        `MemoryImage.resizeSegment: newSegmentSize (${newSegmentSize}) ` +
        `exceeds buffer envelope (${this.buffer.byteLength - this.baseOffset})`);
    }

    const oldSegmentSize     = this.segmentSize;
    const oldHeapEnd         = this.view.getUint32(this.abs(STATE.HEAP_END),       true);
    const oldStringStart     = this.view.getUint32(this.abs(STATE.STRING_START),   true);
    const oldStringPointer   = this.view.getUint32(this.abs(STATE.STRING_POINTER), true);
    const oldCodePointer     = this.view.getUint32(this.abs(STATE.CODE_POINTER),   true);
    const oldCodeBlock       = this.view.getUint32(this.abs(STATE.CODE_BLOCK),     true);
    const heapPointer        = this.view.getUint32(this.abs(STATE.HEAP_POINTER),   true);
    const oldStringTableSize = oldSegmentSize - oldStringStart;
    const newStringTable     = newStringTableSize ?? oldStringTableSize;

    if (typeof newStringTable !== 'number' || newStringTable % 8 !== 0
        || newStringTable - hashTableSize(newStringTable) - STRING_DATA_START <= 0) {
      throw new Error(
        `MemoryImage.resizeSegment: newStringTableSize must be a multiple ` +
        `of 8 leaving a positive data span past the derived hash index ` +
        `(hash-index sizing invariant), got ${newStringTable}`);
    }

    // Used bytes = reserved prefix + interned entries. The new region
    // must hold them in its DATA span — the derived hash index at the
    // tail is not available for entries.
    const stringBytesUsed = oldStringPointer - oldStringStart;
    if (newStringTable - hashTableSize(newStringTable) < stringBytesUsed) {
      throw new Error(
        `MemoryImage.resizeSegment: newStringTableSize (${newStringTable}) ` +
        `leaves a data span of ` +
        `${newStringTable - hashTableSize(newStringTable)} bytes, below ` +
        `current usage (${stringBytesUsed}); would lose interned data`);
    }

    const newStringStart = newSegmentSize - newStringTable;
    const delta          = newStringStart - oldStringStart;
    const newCodePointer = oldCodePointer + delta;

    // Heap floor: the relocated code pointer must sit above heap_pointer.
    if (newCodePointer < heapPointer) {
      throw new Error(
        `MemoryImage.resizeSegment: shrink would place CODE_POINTER ` +
        `(${newCodePointer}) below heap_pointer (${heapPointer}); ` +
        `call gc() first`);
    }

    // Move [oldCodePointer, oldSegmentSize) by `delta` bytes. Covers the
    // code block + string table as one contiguous unit. copyWithin is
    // memmove-safe for both directions of overlap.
    const u8 = this.u8;
    if (delta !== 0) {
      u8.copyWithin(
        this.abs(oldCodePointer + delta),
        this.abs(oldCodePointer),
        this.abs(oldSegmentSize));
    }

    // Zero the gap freed by the move.
    if (delta > 0) {
      // Grow: [oldCodePointer, newCodePointer) is fresh free heap space.
      u8.fill(0, this.abs(oldCodePointer), this.abs(newCodePointer));
    } else if (delta < 0) {
      // Shrink: [newSegmentSize, oldSegmentSize) is past the new segment
      // end. Zero so a future grow back into this range starts clean.
      u8.fill(0, this.abs(newSegmentSize), this.abs(oldSegmentSize));
    }

    // Update header fields.
    const newStringPointer = oldStringPointer + delta;
    const newCodeBlock     = oldCodeBlock + delta;
    this.view.setUint32(this.abs(STATE.HEAP_END),       newStringStart,   true);
    this.view.setUint32(this.abs(STATE.STRING_START),   newStringStart,   true);
    this.view.setUint32(this.abs(STATE.SEGMENT_SIZE),   newSegmentSize,   true);
    this.view.setUint32(this.abs(STATE.STRING_POINTER), newStringPointer, true);
    this.view.setUint32(this.abs(STATE.CODE_POINTER),   newCodePointer,   true);
    this.view.setUint32(this.abs(STATE.CODE_BLOCK),     newCodeBlock,     true);
    this.segmentSize = newSegmentSize;

    // Record one header-ring event per field this call actually
    // changes. resizeSegment writes these fields directly rather than
    // through the collector, so its mutations must be recorded here.
    for (const [field, oldValue, newValue] of [
      [HEADER_EVENT_FIELD.HEAP_END,       oldHeapEnd,       newStringStart], // HEAP_END always tracks STRING_START (see layoutVat)
      [HEADER_EVENT_FIELD.STRING_START,   oldStringStart,   newStringStart],
      [HEADER_EVENT_FIELD.SEGMENT_SIZE,   oldSegmentSize,   newSegmentSize],
      [HEADER_EVENT_FIELD.STRING_POINTER, oldStringPointer, newStringPointer],
      [HEADER_EVENT_FIELD.CODE_POINTER,   oldCodePointer,   newCodePointer],
      [HEADER_EVENT_FIELD.CODE_BLOCK,     oldCodeBlock,     newCodeBlock],
    ]) {
      if (oldValue !== newValue) {
        writeHeaderEventRingEntry(this.view, this.baseOffset, {
          kind: HEADER_EVENT_KIND.FIELD_WRITE,
          field,
          site: HEADER_EVENT_SITE.JS_RESIZE_SEGMENT,
          oldValue,
          newValue,
        });
      }
    }

    // A changed string-table size changes the DERIVED hash-index size,
    // so the index the block move carried along has the wrong bucket
    // count at the wrong tail position. Interned ids are unaffected
    // (they are offsets from stringStart and the index lives PAST the
    // data span), but the index must be rebuilt in place. Same-size
    // resizes move the index intact with the block — nothing to do.
    if (newStringTable !== oldStringTableSize) {
      this.rebuildStringHashIndex();
    }

    // Refresh WAT's cached $string_start and $segment_size globals
    // (also re-derives the hash-index sizing globals).
    if (this.wasm) {
      this.wasm.exports.refresh_string_region();
    }
  }

  /**
   * Rebuild the string hash index at the region tail from the interned
   * entries: zero all buckets, then re-insert ascending by id with
   * ascending linear probing — byte-identical to the collector's
   * rebuildHashTable / the WAT's $gc_rebuild_hash_table. Used by
   * resizeSegment when the string-table size (and therefore the
   * derived bucket count) changes.
   */
  rebuildStringHashIndex() {
    const stringStart = this.getStringStart();
    const stringEnd = this.getStringEnd();
    const regionSize = stringEnd - stringStart;
    const bucketCount = hashTableBuckets(regionSize);
    const hashTableStart = this.abs(stringEnd - hashTableSize(regionSize));
    const stringPointerRel = this.getStringPointer() - stringStart;

    this.u8.fill(0, hashTableStart, hashTableStart + hashTableSize(regionSize));

    let id = STRING_DATA_START;
    while (id < stringPointerRel) {
      const absolutePointer = this.abs(stringStart + id);
      const length = this.view.getUint32(absolutePointer, true);
      const alignedSize = (4 + length + 3) & ~3;

      let hash = FNV_OFFSET_BASIS;
      for (let i = 0; i < length; i++) {
        hash ^= this.u8[absolutePointer + 4 + i];
        hash = Math.imul(hash, FNV_PRIME) >>> 0;
      }

      // A bucket is free iff its OFFSET column is 0 (valid ids are >=
      // STRING_DATA_START > 0). Exhaustion is structurally impossible
      // under the derived sizing — throw rather than drop the entry.
      let bucketIndex = hash % bucketCount;
      let inserted = false;
      for (let probe = 0; probe < bucketCount; probe++) {
        const bucketPointer = hashTableStart + bucketIndex * 8;
        if (this.view.getUint32(bucketPointer + 4, true) === 0) {
          this.view.setUint32(bucketPointer, hash, true);
          this.view.setUint32(bucketPointer + 4, id, true);
          inserted = true;
          break;
        }
        bucketIndex = (bucketIndex + 1) % bucketCount;
      }
      if (!inserted) {
        throw new Error(
          `rebuildStringHashIndex: hash index saturated at id ${id} — ` +
          `structurally impossible under the derived sizing; a writer ` +
          `must have bypassed $intern_string`);
      }

      id += alignedSize;
    }
  }

  /**
   * Cross-check the WAT's cached region globals against their sources
   * of truth (the STATE header + this image's baseOffset). The WAT
   * caches these at init_regions / refresh_string_region time for hot
   * paths like $string_id_to_abs; a resize/relocate path that skips
   * the refresh leaves aged-string reads systematically displaced
   * while the stored heap remains intact. This fault is confined to
   * the live instance's cached read path, so the audit requires an
   * attached wasm instance; a bytes-only snapshot has no cached
   * globals to inspect.
   *
   * @returns {{ consistent: boolean,
   *             mismatches: Array<{ global: string, cached: number,
   *                                 expected: number }> }}
   */
  auditRegionGlobals() {
    if (!this.wasm) {
      throw new Error(
        'MemoryImage.auditRegionGlobals: no wasm instance attached — ' +
        'the cached globals only exist in a live vat');
    }
    const expected = {
      cached_base_offset: this.baseOffset,
      // (cached_external_request_base is NOT audited since layout v8:
      // it is a per-run cache of the current context's request block,
      // recomputed at run() entry, not a region base.)
      cached_error_info_base:
        this.view.getUint32(this.abs(STATE.ERROR_INFO_BASE), true),
      cached_builtins_base:
        this.view.getUint32(this.abs(STATE.BUILTINS_BASE), true),
      cached_string_start:
        this.view.getUint32(this.abs(STATE.STRING_START), true),
      cached_segment_size:
        this.view.getUint32(this.abs(STATE.SEGMENT_SIZE), true),
      // Derived, not stored: a stale value means a resize path skipped
      // refresh_string_region's $derive_string_index_layout.
      cached_hash_table_start:
        this.view.getUint32(this.abs(STATE.SEGMENT_SIZE), true)
        - hashTableSize(
            this.view.getUint32(this.abs(STATE.SEGMENT_SIZE), true)
            - this.view.getUint32(this.abs(STATE.STRING_START), true)),
    };
    const mismatches = [];
    for (const [name, expectedValue] of Object.entries(expected)) {
      const cached = this.wasm.exports[name]();
      if (cached !== expectedValue) {
        mismatches.push({ global: name, cached, expected: expectedValue });
      }
    }
    return { consistent: mismatches.length === 0, mismatches };
  }

  // ===========================================================================
  // SANDFUEL Header
  // ===========================================================================

  // SANDFUEL header readers (getMagic, validateMagic,
  // getDroneFormatVersion, getBytecodeVersion, getTypeVersion,
  // getBuiltinVersion, getVersions) live on MemoryReader.
  // Setters and writeMagic stay here.

  /**
   * Write the magic bytes.
   */
  writeMagic() {
    const magic = this.encoder.encode('SANDFUEL');
    this.u8.set(magic, this.abs(HEADER.MAGIC));
  }

  /**
   * Set the aggregate drone format version.
   * @param {number} v
   */
  setDroneFormatVersion(v) {
    this.view.setUint16(this.abs(HEADER.DRONE_FORMAT_VERSION), v, true);
  }

  /**
   * Set bytecode version.
   * @param {number} v
   */
  setBytecodeVersion(v) {
    this.view.setUint16(this.abs(HEADER.BYTECODE_VERSION), v, true);
  }

  /**
   * Set type version.
   * @param {number} v
   */
  setTypeVersion(v) {
    this.view.setUint16(this.abs(HEADER.TYPE_VERSION), v, true);
  }

  /**
   * Set builtin version.
   * @param {number} v
   */
  setBuiltinVersion(v) {
    this.view.setUint16(this.abs(HEADER.BUILTIN_VERSION), v, true);
  }

  // ===========================================================================
  // Initialization
  // ===========================================================================

  /**
   * Post-layout bootstrap: run the WASM init calls, intern builtin
   * names, allocate context 0, create the root scope, and initialize
   * builtins. Requires `this.wasm` to be set.
   *
   * Assumes the SANDFUEL header, STATE, and code-block header are
   * already in memory (written by `layoutVat`, or restored from
   * snapshot bytes). Does not write any of those itself.
   *
   * @returns {number} The context 0 slot.
   */
  bootstrap() {
    if (this.wasm) {
      // init_segment is called by setWasmInstance; init_regions reads
      // the region bases from STATE (which layoutVat just wrote) into
      // WASM-side cached globals.
      this.wasm.exports.init_segment(this.baseOffset);
      this.wasm.exports.init_regions();
      this.wasm.exports.init_string_table();

      // Pre-intern built-in names into the BUILTINS region.
      this.internBuiltinNames();
    }

    // Allocate context 0 for initialization. allocateContext() zeroes
    // the state block, so exit condition is 0 (no exit yet).
    const context0 = this.allocateContext();

    // Create root scope (parent == 0 means this is the global/root
    // scope). Capacity stored in scope header, so changing this
    // default has no versioning implications.
    const rootScope = this.createScope(0, 128);
    this.setState(STATE.ROOT_SCOPE, rootScope);
    this.setContextScope(context0, rootScope);

    // Initialize built-in objects and global functions.
    this.initializeBuiltins();

    return context0;
  }

  // ===========================================================================
  // State Header (global fields)
  // ===========================================================================

  // Heap & string-table getters (getHeapPointer, getHeapStart, getHeapEnd,
  // getStringPointer, getStringStart, getStringEnd) live on MemoryReader.

  setHeapPointer(v) {
    this.view.setUint32(this.abs(STATE.HEAP_POINTER), v, true);
  }

  setStringPointer(v) {
    this.view.setUint32(this.abs(STATE.STRING_POINTER), v, true);
  }

  /**
   * Get the root scope pointer.
   * The root scope contains builtins and externals, and exists independently of any context.
   *
   * @returns {number} - Root scope pointer
   */
  // getRootScope, getState, getCodePointer live on MemoryReader.

  /**
   * Set a state header field value.
   *
   * @param {number} stateOffset - Offset from STATE (e.g., STATE.OBJECT_PROTOTYPE)
   * @param {number} value - The value to set
   */
  setState(stateOffset, value) {
    this.view.setUint32(this.abs(stateOffset), value, true);
  }

  setCodePointer(v) {
    this.view.setUint32(this.abs(STATE.CODE_POINTER), v, true);
  }

  // Region base getters (getExternalRequestBase, getErrorInfoBase,
  // getScratchBase, getBuiltinsBase) live on MemoryReader.

  // ===========================================================================
  // Context Stack Base Helpers
  // ===========================================================================

  // Stack base getters (getCallStackBase, getPendingStackBase,
  // getTryStackBase, getGrantStackBase) live on MemoryReader.

  // ===========================================================================
  // Call Stack
  // ===========================================================================

  /**
   * Push a new frame onto the call stack.
   *
   * @param {number} slot - Context slot
   * @param {number} instructionIndex - Return instruction index
   * @param {number} scopePointer - Pointer to scope
   * @param {number} astNode - Offset into AST region (0 = no attribution)
   * @returns {number} - Frame index
   */
  pushFrame(slot, instructionIndex, scopePointer, astNode = 0, argc = 0) {
    // Grow the call stack if the frame won't fit, then re-read base/pointer
    // (the block may have relocated). Mirrors the WAT push path.
    if (this.getContextCallStackPointer(slot) + FRAME_SIZE > this.view.getUint32(
          this.abs(this.getContextStateBase(slot)) + CTX.CALL_STACK_LIMIT, true)) {
      this._growStack(slot, CTX.CALL_STACK_BASE, CTX.CALL_STACK_LIMIT, CTX.CALL_STACK_POINTER);
    }
    const stackPointer = this.getContextCallStackPointer(slot);
    const callStackBase = this.getCallStackBase(slot);

    const framePointer = this.abs(stackPointer);
    // Design B: store the pending position as an OFFSET from the pending base
    // (survives pending-stack relocation on growth), matching the WAT push path
    // ($save_frame_pending_base) and getFrame's resolve.
    const pendingOffset =
      this.getContextPendingPointer(slot) - this.getPendingStackBase(slot);

    this.view.setUint32(framePointer + FRAME.INSTRUCTION_INDEX, instructionIndex, true);
    this.view.setUint32(framePointer + FRAME.SCOPE_POINTER, scopePointer, true);
    this.view.setUint32(framePointer + FRAME.PENDING_POINTER, pendingOffset, true);
    this.view.setUint32(framePointer + FRAME.PENDING_COUNT, 0, true);
    this.view.setUint32(framePointer + FRAME.FLAGS, 0, true);
    this.view.setUint32(framePointer + FRAME.AST_NODE, astNode, true);
    this.view.setUint32(framePointer + FRAME.ARGC, argc, true);

    this.setContextCallStackPointer(slot, stackPointer + FRAME_SIZE);

    return (stackPointer - callStackBase) / FRAME_SIZE;
  }

  /**
   * Pop the top frame from the call stack.
   *
   * @param {number} slot - Context slot
   * @returns {object} - Frame data
   */
  popFrame(slot) {
    const stackPointer = this.getContextCallStackPointer(slot);
    const stackBase = this.getCallStackBase(slot);

    if (stackPointer <= stackBase) {
      throw new Error('Call stack underflow');
    }

    const newStackPointer = stackPointer - FRAME_SIZE;
    this.setContextCallStackPointer(slot, newStackPointer);

    return this.getFrame(slot, (newStackPointer - stackBase) / FRAME_SIZE);
  }

  // Frame readers (getFrame, getCurrentFrame, getCallStack,
  // getCallStackDepth) live on MemoryReader.

  /**
   * Set child index for a frame.
   *
   * @param {number} slot - Context slot
   * @param {number} index - Frame index
   * @param {number} value - New child index value
   */
  setFrameChildIndex(slot, index, value) {
    const frameOffset = this.getCallStackBase(slot) + index * FRAME_SIZE;
    const framePointer = this.abs(frameOffset);
    this.view.setUint32(framePointer + FRAME.CHILD_INDEX, value, true);
  }

  // ===========================================================================
  // Pending Values Stack
  // ===========================================================================

  /**
   * Push a value onto the pending stack.
   * Copies 16 bytes from the given address.
   *
   * @param {number} slot - Context slot
   * @param {number} valuePointer - Segment-relative pointer to value
   */
  pushPending(slot, valuePointer) {
    if (this.getContextPendingPointer(slot) + VALUE_SIZE > this.view.getUint32(
          this.abs(this.getContextStateBase(slot)) + CTX.PENDING_LIMIT, true)) {
      this._growStack(slot, CTX.PENDING_BASE, CTX.PENDING_LIMIT, CTX.PENDING_POINTER);
    }
    const pendingPointer = this.getContextPendingPointer(slot);

    // Copy 16 bytes
    const src = this.abs(valuePointer);
    const dst = this.abs(pendingPointer);
    for (let i = 0; i < VALUE_SIZE; i++) {
      this.u8[dst + i] = this.u8[src + i];
    }

    this.setContextPendingPointer(slot, pendingPointer + VALUE_SIZE);

    // Update current frame's pending count
    const stackPointer = this.getContextCallStackPointer(slot);
    if (stackPointer > this.getCallStackBase(slot)) {
      const framePointer = this.abs(stackPointer - FRAME_SIZE);
      const count = this.view.getUint32(framePointer + FRAME.PENDING_COUNT, true);
      this.view.setUint32(framePointer + FRAME.PENDING_COUNT, count + 1, true);
    }
  }

  /**
   * Pop a value from the pending stack.
   *
   * @param {number} slot - Context slot
   * @returns {number} - Segment-relative pointer to popped value (still in memory)
   */
  popPending(slot) {
    const pendingPointer = this.getContextPendingPointer(slot);
    const pendingBase = this.getPendingStackBase(slot);

    if (pendingPointer <= pendingBase) {
      throw new Error('Pending stack underflow');
    }

    const newPendingPointer = pendingPointer - VALUE_SIZE;
    this.setContextPendingPointer(slot, newPendingPointer);

    // Update current frame's pending count
    const stackPointer = this.getContextCallStackPointer(slot);
    if (stackPointer > this.getCallStackBase(slot)) {
      const framePointer = this.abs(stackPointer - FRAME_SIZE);
      const count = this.view.getUint32(framePointer + FRAME.PENDING_COUNT, true);
      if (count > 0) {
        this.view.setUint32(framePointer + FRAME.PENDING_COUNT, count - 1, true);
      }
    }

    return newPendingPointer;
  }

  // getPendingDepth lives on MemoryReader.

  // ===========================================================================
  // Heap Allocation
  // ===========================================================================

  /**
   * Pre-check that an allocation of `requestedBytes` will fit in the
   * heap region without overrunning into the bytecode region.
   *
   * If the request would overrun:
   *  - signals the WAT-side `$memory_pressure_signaled` flag (via the
   *    signal_memory_pressure export) so the next interpreter run()
   *    yields with status 'memory_pressure'.
   *  - throws a HeapPressureSignal (subclass of Error). Hosts catching
   *    it should treat it as a recoverable signal: run engine.gc(),
   *    then retry the operation. Persistent pressure after gc is a
   *    terminal OOM.
   *
   * The effective end of the heap is the bottom of the code block
   * (CODE_POINTER), not STATE_HEAP_END. The code block lives in
   * [codePointer, stringStart) and grows downward as instructions are
   * emitted. Allocating past codePointer silently corrupts executable
   * state even if the allocation itself appears to succeed.
   *
   * @param {number} requestedBytes - Total bytes the allocation needs.
   * @throws {HeapPressureSignal} if the allocation would overrun.
   */
  _checkHeapBudget(requestedBytes) {
    const heapPointer = this.getHeapPointer();
    const codePointer = this.getCodePointer();
    if (heapPointer + requestedBytes > codePointer) {
      // Signal the WAT-side flag so the next run() exits with
      // 'memory_pressure' even if the throw is caught.
      this.wasm.exports.signal_memory_pressure();
      throw new HeapPressureSignal(requestedBytes, codePointer - heapPointer);
    }
  }

  /**
   * Allocate memory on the heap with a GC header.
   *
   * @param {number} dataSize - Size of data (not including header)
   * @param {number} objType - Object type (OBJ.*)
   * @returns {number} - Segment-relative pointer to allocated memory (after header)
   */
  allocate(dataSize, objType) {
    if (objType === OBJ.ARRAYBUFFER &&
        (!Number.isInteger(dataSize) || dataSize < 4 || dataSize > 0xffffffff + 4)) {
      throw new RangeError('Invalid ArrayBuffer byte length');
    }
    const totalSize = GC_HEADER_SIZE + dataSize;
    let aligned = Math.ceil(totalSize / 16) * 16;
    if (objType === OBJ.ARRAYBUFFER && aligned >= 0x01000000) {
      // Extended headers derive their stride from the physical byte length.
      // Keep the old 16-byte layout for small generic allocations only.
      aligned = Math.ceil(totalSize / 8) * 8;
    }

    this._checkHeapBudget(aligned);

    const heapPointer = this.getHeapPointer();
    const absPointer = this.abs(heapPointer);

    // Write GC header
    // Header word: mark bit (1) + type (7) + packed size (24).
    // Only large ArrayBuffers use zero size, decoded from data+0.
    const packedSize = objType === OBJ.ARRAYBUFFER && aligned >= 0x01000000
      ? 0 : aligned & 0x00ffffff;
    const headerWord = (objType << 24) | packedSize;
    this.view.setUint32(absPointer, headerWord, true);
    this.view.setUint32(absPointer + 4, 0, true); // forwarding pointer

    this.setHeapPointer(heapPointer + aligned);

    // Return pointer to data (after header)
    return heapPointer + GC_HEADER_SIZE;
  }

  // ===========================================================================
  // AST Region Methods (slice 2 of source-inlining)
  //
  // An optional, append-only buffer carrying the AST that produced the
  // bytecode. The interpreter does not interpret AST bytes — node layout is a
  // host-side dialect contract. Hosts use the dialect tag in the header to
  // coordinate decoding.
  //
  // Layout (when astRegionSize > 0, after first allocation):
  //   [dialect:u32][format_version:u16][reserved:u16][root_node_offset:u32]
  //   [reserved:u32]
  //   [node bytes →]
  //
  // The 16-byte header is written lazily on first allocation so disabled
  // sessions (size 0) carry no header at all. The pointer starts at base;
  // a bare equality check (pointer === base) means "empty region".
  // ===========================================================================

  // AST region readers (getAstRegionBase, getAstRegionSize,
  // getAstRegionPointer, isAstRegionInitialized) live on MemoryReader.

  setAstRegionPointer(value) {
    this.view.setUint32(this.abs(STATE.AST_REGION_POINTER), value, true);
  }

  /**
   * Write the 16-byte region header. Idempotent: only runs on first call when
   * the region is empty. Caller must already have ensured astRegionSize >= 16.
   */
  initializeAstRegionHeader(dialect, formatVersion) {
    if (this.getAstRegionSize() < AST_REGION_HEADER_SIZE) {
      throw new Error(
        `AST region too small for header: have ${this.getAstRegionSize()} bytes, need ${AST_REGION_HEADER_SIZE}`
      );
    }
    if (this.isAstRegionInitialized()) {
      return; // Already initialized, header is written.
    }
    const base = this.getAstRegionBase();
    this.view.setUint32(this.abs(base + AST_REGION.DIALECT), dialect, true);
    this.view.setUint16(this.abs(base + AST_REGION.FORMAT_VERSION), formatVersion, true);
    this.view.setUint16(this.abs(base + AST_REGION.RESERVED_HEADER), 0, true);
    this.view.setUint32(this.abs(base + AST_REGION.FIRST_ROOT), 0, true);
    this.view.setUint32(this.abs(base + AST_REGION.LAST_ROOT), 0, true);
    this.setAstRegionPointer(base + AST_REGION_HEADER_SIZE);
  }

  // getAstRegionHeader and getAstRegionLastRootOffset live on MemoryReader.

  setAstRegionRootNodeOffset(offset) {
    if (!this.isAstRegionInitialized()) {
      throw new Error('AST region header not initialized');
    }
    const base = this.getAstRegionBase();
    this.view.setUint32(this.abs(base + AST_REGION.FIRST_ROOT), offset, true);
  }

  setAstRegionLastRootOffset(offset) {
    if (!this.isAstRegionInitialized()) {
      throw new Error('AST region header not initialized');
    }
    const base = this.getAstRegionBase();
    this.view.setUint32(this.abs(base + AST_REGION.LAST_ROOT), offset, true);
  }

  /**
   * Append a chunk of bytes to the AST region. Returns the offset where the
   * bytes were written (relative to the region base, i.e., a value suitable
   * for storing in an instruction's astNode field). Header must already be
   * initialized via initializeAstRegionHeader.
   */
  astRegionAlloc(byteLength) {
    if (!this.isAstRegionInitialized()) {
      throw new Error('AST region header not initialized; call initializeAstRegionHeader first');
    }
    const pointer = this.getAstRegionPointer();
    const base = this.getAstRegionBase();
    const size = this.getAstRegionSize();
    const newPointer = pointer + byteLength;
    if (newPointer - base > size) {
      throw new Error(
        `AST region exhausted: have ${size} bytes, need ${newPointer - base}`
      );
    }
    this.setAstRegionPointer(newPointer);
    return pointer - base; // offset relative to region base
  }

  // readAstRegionBytes and copyAstRegion live on MemoryReader.

  // ===========================================================================
  // CodeBlock Methods (Reverse-Growing)
  //
  // The code block grows backward from STRING_START. Layout:
  //
  //   [heap →→→→→→    ←←← code block][string table]
  //                  ↑               ↑
  //            CODE_POINTER      STRING_START
  //
  // Code block structure (header at high address, instructions grow down):
  //   [instr N]...[instr 1][instr 0][count 4B][flags 4B][GC header 8B]
  //   ↑                             ↑                                ↑
  //   CODE_POINTER              INSTR_0_PTR                    CODE_START
  //
  // CODE_START = STRING_START - 16 (fixed position for header)
  // INSTR_0_PTR = CODE_START - 8 - 8 = STRING_START - 24 (just below header)
  // Actually: header is [count:4][flags:4][gc_type:4][gc_fwd:4] = 16 bytes
  // So INSTR_0_PTR = STRING_START - 16 (first instruction slot)
  // ===========================================================================

  // getCodeStart and getInstructionZeroPointer live on MemoryReader.

  // getCodeBlock lives on MemoryReader.

  /**
   * Reset the code block for re-parsing.
   * Resets CODE_POINTER to just below header and clears instruction count.
   * Does NOT touch heap - preserves runtime objects (scopes, arrays, etc).
   */
  resetCodeBlock() {
    const codeStart = this.getCodeStart();

    // Reset code pointer to just below header
    this.setCodePointer(codeStart);

    // Reset instruction count and flags
    this.view.setUint32(this.abs(codeStart), 0, true); // count = 0
    this.view.setUint32(this.abs(codeStart + 4), 0, true); // flags = 0

    // Reset GC header size to 16 (header only)
    this.view.setUint32(this.abs(codeStart + 8), (OBJ.CODE_BLOCK << 24) | 16, true);
  }

  /**
   * Allocate a new CodeBlock.
   * For reverse-growing model, this just resets the single code block.
   * @returns {number} - Segment-relative pointer to CodeBlock data
   */
  allocateCodeBlock() {
    this.resetCodeBlock();
    return this.getCodeBlock();
  }

  // codeBlockInstructionCount lives on MemoryReader.

  /**
   * Truncate the code block to a specific instruction count.
   * Used for rollback on parse errors.
   * @param {number} count - Number of instructions to keep
   */
  codeBlockTruncate(count) {
    const codeStart = this.getCodeStart();
    const currentCount = this.view.getUint32(this.abs(codeStart), true);

    if (count < currentCount) {
      // Update count
      this.view.setUint32(this.abs(codeStart), count, true);

      // Reclaim space: CODE_POINTER = codeStart - count * INSTRUCTION_SIZE
      const newCodePointer = codeStart - count * INSTRUCTION_SIZE;
      this.setCodePointer(newCodePointer);

      // Update GC header size
      const headerSize = 16 + count * INSTRUCTION_SIZE;
      this.view.setUint32(this.abs(codeStart + 8), (OBJ.CODE_BLOCK << 24) | headerSize, true);
    }
  }

  // codeBlockGetFlags lives on MemoryReader.

  /**
   * Set flags for the code block.
   * @param {number} flags - Flags to set
   */
  codeBlockSetFlags(flags) {
    const codeStart = this.getCodeStart();
    this.view.setUint32(this.abs(codeStart + 4), flags, true);
  }

  /**
   * Emit an instruction to the code block.
   * Instructions grow downward from CODE_POINTER.
   *
   * Layout (16 bytes):
   *   [opcode:1][flags:1][reserved:2][astNode:4][operand1:4][operand2:4]
   *
   * @param {number} opcode - Instruction opcode (u8)
   * @param {number} operand1 - First operand (u32)
   * @param {number} operand2 - Second operand (u32)
   * @param {number} flags - Instruction flags (u8)
   * @param {number} astNode - Offset into AST region (u32, 0 = no attribution)
   * @returns {number} - Instruction index
   */
  emitInstruction(opcode, operand1 = 0, operand2 = 0, flags = 0, astNode = 0) {
    const codePointer = this.getCodePointer();
    const heapPointer = this.getHeapPointer();

    if (codePointer - INSTRUCTION_SIZE < heapPointer) {
      throw new Error('Out of memory: code block collided with heap');
    }

    const newCodePointer = codePointer - INSTRUCTION_SIZE;
    this.setCodePointer(newCodePointer);

    const instrPointer = this.abs(newCodePointer);
    this.view.setUint8(instrPointer, opcode);
    this.view.setUint8(instrPointer + 1, flags);
    this.view.setUint16(instrPointer + 2, 0, true); // reserved
    this.view.setUint32(instrPointer + 4, astNode, true);
    this.view.setUint32(instrPointer + 8, operand1, true);
    this.view.setUint32(instrPointer + 12, operand2, true);

    const codeStart = this.getCodeStart();
    const count = this.view.getUint32(this.abs(codeStart), true);
    this.view.setUint32(this.abs(codeStart), count + 1, true);

    const headerSize = 16 + (count + 1) * INSTRUCTION_SIZE;
    this.view.setUint32(this.abs(codeStart + 8), (OBJ.CODE_BLOCK << 24) | headerSize, true);

    return count;
  }

  /**
   * Append an instruction to the code block.
   * Delegates to emitInstruction.
   */
  codeBlockAppend(opcode, operand1 = 0, operand2 = 0, flags = 0, astNode = 0) {
    return this.emitInstruction(opcode, operand1, operand2, flags, astNode);
  }

  /**
   * Patch an instruction's operand1.
   *
   * @param {number} instructionIndex - Which instruction to patch
   * @param {number} value - New value for operand1
   */
  codeBlockPatch(instructionIndex, value) {
    // Instructions grow downward: instr_address = codeStart - (index + 1) * INSTRUCTION_SIZE
    const codeStart = this.getCodeStart();
    const instrOffset = codeStart - (instructionIndex + 1) * INSTRUCTION_SIZE;
    this.view.setUint32(this.abs(instrOffset + 8), value, true);
  }

  // codeBlockReadInstruction lives on MemoryReader.

  /**
   * Write a NOP instruction at the given index.
   * NOP is a true no-op: does nothing, no stack effect.
   *
   * @param {number} instructionIndex - Which instruction to overwrite
   */
  codeBlockWriteNop(instructionIndex) {
    const codeStart = this.getCodeStart();
    const instrOffset = codeStart - (instructionIndex + 1) * INSTRUCTION_SIZE;
    const instrPointer = this.abs(instrOffset);

    // Write NOP opcode, clear everything else
    this.view.setUint8(instrPointer, OP.NOP);
    this.view.setUint8(instrPointer + 1, 0); // flags
    this.view.setUint16(instrPointer + 2, 0, true); // reserved
    this.view.setUint32(instrPointer + 4, 0, true); // astNode
    this.view.setUint32(instrPointer + 8, 0, true); // operand1
    this.view.setUint32(instrPointer + 12, 0, true); // operand2
  }

  /**
   * Edit a specific field of an instruction.
   *
   * @param {number} instructionIndex - Which instruction to edit
   * @param {string} field - Field name: 'opcode', 'flags', 'operand1', 'operand2'
   * @param {number} value - New value
   */
  codeBlockEditInstruction(instructionIndex, field, value) {
    const codeStart = this.getCodeStart();
    const instrOffset = codeStart - (instructionIndex + 1) * INSTRUCTION_SIZE;
    const instrPointer = this.abs(instrOffset);

    switch (field) {
      case 'opcode':
        this.view.setUint8(instrPointer, value);
        break;
      case 'flags':
        this.view.setUint8(instrPointer + 1, value);
        break;
      case 'operand1':
        this.view.setUint32(instrPointer + 8, value, true);
        break;
      case 'operand2':
        this.view.setUint32(instrPointer + 12, value, true);
        break;
      case 'astNode':
        this.view.setUint32(instrPointer + 4, value, true);
        break;
      default:
        throw new Error(`Unknown instruction field: ${field}`);
    }
  }

  // ===========================================================================
  // Try Stack Methods
  // ===========================================================================

  // ===========================================================================
  // Try Stack Methods
  // ===========================================================================

  // getTryDepth lives on MemoryReader.

  /**
   * Push a try entry onto the try stack.
   *
   * @param {number} slot - Context slot
   * @param {number} catchIndex - Catch handler instruction index (0 if none)
   * @param {number} finallyIndex - Finally handler instruction index (0 if none)
   * @returns {number} - Entry index
   */
  pushTryEntry(slot, catchIndex, finallyIndex) {
    if (this.getContextTryStackPointer(slot) + TRY_ENTRY_SIZE > this.view.getUint32(
          this.abs(this.getContextStateBase(slot)) + CTX.TRY_STACK_LIMIT, true)) {
      this._growStack(slot, CTX.TRY_STACK_BASE, CTX.TRY_STACK_LIMIT, CTX.TRY_STACK_POINTER);
    }
    const tryPointer = this.getContextTryStackPointer(slot);
    const tryStackBase = this.getTryStackBase(slot);

    const entryPointer = this.abs(tryPointer);
    const frameDepth = this.getCallStackDepth(slot);

    this.view.setUint32(entryPointer + TRY_ENTRY.CATCH_INDEX, catchIndex, true);
    this.view.setUint32(entryPointer + TRY_ENTRY.FINALLY_INDEX, finallyIndex, true);
    this.view.setUint32(entryPointer + TRY_ENTRY.FRAME_DEPTH, frameDepth, true);
    this.view.setUint32(entryPointer + TRY_ENTRY.GRANT_DEPTH, this.getGrantDepth(slot), true);

    this.setContextTryStackPointer(slot, tryPointer + TRY_ENTRY_SIZE);

    return (tryPointer - tryStackBase) / TRY_ENTRY_SIZE;
  }

  /**
   * Pop the top try entry from the try stack.
   *
   * @param {number} slot - Context slot
   * @returns {object} - Try entry data
   */
  popTryEntry(slot) {
    const tryPointer = this.getContextTryStackPointer(slot);
    const tryBase = this.getTryStackBase(slot);

    if (tryPointer <= tryBase) {
      throw new Error('Try stack underflow');
    }

    const newTryPointer = tryPointer - TRY_ENTRY_SIZE;
    this.setContextTryStackPointer(slot, newTryPointer);

    return this.getTryEntry(slot, (newTryPointer - tryBase) / TRY_ENTRY_SIZE);
  }

  // peekTryEntry, getTryEntry, getTryStack live on MemoryReader.

  // ===========================================================================
  // Grant Stack Methods
  // ===========================================================================

  // getGrantDepth lives on MemoryReader.

  /**
   * Push a grant entry onto the grant stack.
   *
   * Grant entry layout (32 bytes):
   * - [0-15]: identifier value (16 bytes, copied inline)
   * - [16-19]: grantId (u32)
   * - [20-23]: deniedAddr (u32)
   * - [24-27]: scopePointer (u32) — scope when grant was entered
   * - [28-31]: frameDepth (u32) — call stack depth when grant was entered
   *
   * @param {number} slot - Context slot
   * @param {number} identifierValueAddr - Segment-relative address of 16-byte identifier value
   * @param {number} grantId - Grant ID from host
   * @param {number} deniedAddr - Jump target if grant is revoked (0 if no denied block)
   * @returns {number} - Entry index
   */
  pushGrantEntry(slot, identifierValueAddr, grantId, deniedAddr) {
    if (this.getContextGrantStackPointer(slot) + GRANT_ENTRY_SIZE > this.view.getUint32(
          this.abs(this.getContextStateBase(slot)) + CTX.GRANT_STACK_LIMIT, true)) {
      this._growStack(slot, CTX.GRANT_STACK_BASE, CTX.GRANT_STACK_LIMIT, CTX.GRANT_STACK_POINTER);
    }
    const grantPointer = this.getContextGrantStackPointer(slot);
    const grantStackBase = this.getGrantStackBase(slot);

    const entryPointer = this.abs(grantPointer);
    const srcPointer = this.abs(identifierValueAddr);

    // Copy 16-byte identifier value inline
    for (let i = 0; i < 16; i++) {
      this.u8[entryPointer + GRANT_ENTRY.IDENTIFIER + i] = this.u8[srcPointer + i];
    }

    this.view.setUint32(entryPointer + GRANT_ENTRY.GRANT_ID, grantId, true);
    this.view.setUint32(entryPointer + GRANT_ENTRY.DENIED_ADDR, deniedAddr, true);
    this.view.setUint32(entryPointer + GRANT_ENTRY.SCOPE_POINTER, this.getContextScope(slot), true);
    this.view.setUint32(entryPointer + GRANT_ENTRY.FRAME_DEPTH, this.getCallStackDepth(slot), true);

    this.setContextGrantStackPointer(slot, grantPointer + GRANT_ENTRY_SIZE);

    return (grantPointer - grantStackBase) / GRANT_ENTRY_SIZE;
  }

  /**
   * Push a grant entry for callback invocation.
   * Used when restoring captured grants for a callback.
   * The identifier is set to null since callbacks don't have denied blocks.
   *
   * @param {number} slot - Context slot
   * @param {number} grantId - Grant ID to push
   * @returns {number} - Entry index
   */
  pushGrantEntryForCallback(slot, grantId) {
    if (this.getContextGrantStackPointer(slot) + GRANT_ENTRY_SIZE > this.view.getUint32(
          this.abs(this.getContextStateBase(slot)) + CTX.GRANT_STACK_LIMIT, true)) {
      this._growStack(slot, CTX.GRANT_STACK_BASE, CTX.GRANT_STACK_LIMIT, CTX.GRANT_STACK_POINTER);
    }
    const grantPointer = this.getContextGrantStackPointer(slot);
    const grantStackBase = this.getGrantStackBase(slot);

    const entryPointer = this.abs(grantPointer);

    // Write null identifier (TYPE_NULL with zeroed data)
    this.view.setUint32(entryPointer + GRANT_ENTRY.IDENTIFIER, TYPE.NULL, true);
    this.view.setUint32(entryPointer + GRANT_ENTRY.IDENTIFIER + 4, 0, true);
    this.view.setUint32(entryPointer + GRANT_ENTRY.IDENTIFIER + 8, 0, true);
    this.view.setUint32(entryPointer + GRANT_ENTRY.IDENTIFIER + 12, 0, true);

    this.view.setUint32(entryPointer + GRANT_ENTRY.GRANT_ID, grantId, true);
    this.view.setUint32(entryPointer + GRANT_ENTRY.DENIED_ADDR, 0, true);  // No denied block
    this.view.setUint32(entryPointer + GRANT_ENTRY.SCOPE_POINTER, 0, true);
    this.view.setUint32(entryPointer + GRANT_ENTRY.FRAME_DEPTH, 0, true);

    this.setContextGrantStackPointer(slot, grantPointer + GRANT_ENTRY_SIZE);

    return (grantPointer - grantStackBase) / GRANT_ENTRY_SIZE;
  }

  /**
   * Pop the top grant entry from the grant stack.
   *
   * @param {number} slot - Context slot
   * @returns {object} - Grant entry data
   */
  popGrantEntry(slot) {
    const grantPointer = this.getContextGrantStackPointer(slot);
    const grantBase = this.getGrantStackBase(slot);

    if (grantPointer <= grantBase) {
      throw new Error('Grant stack underflow');
    }

    const newGrantPointer = grantPointer - GRANT_ENTRY_SIZE;
    this.setContextGrantStackPointer(slot, newGrantPointer);

    return this.getGrantEntry(slot, (newGrantPointer - grantBase) / GRANT_ENTRY_SIZE);
  }

  // getGrantEntry, getActiveGrantIds, findGrantEntriesById live on MemoryReader.

  // ===========================================================================
  // Values
  // ===========================================================================

  /**
   * Write a null value.
   *
   * @param {number} addr - Segment-relative address
   */
  writeNull(addr) {
    const absAddr = this.abs(addr);
    this.view.setUint32(absAddr, TYPE.NULL, true);
    this.view.setUint32(absAddr + 4, 0, true);
    this.view.setBigInt64(absAddr + 8, 0n, true);
  }

  /**
   * Write an undefined value.
   *
   * @param {number} addr - Segment-relative address
   */
  writeUndefined(addr) {
    const absAddr = this.abs(addr);
    this.view.setUint32(absAddr, TYPE.UNDEFINED, true);
    this.view.setUint32(absAddr + 4, 0, true);
    this.view.setBigInt64(absAddr + 8, 0n, true);
  }

  /**
   * Write a boolean value.
   *
   * @param {number} addr - Segment-relative address
   * @param {boolean} v - Boolean value
   */
  writeBoolean(addr, v) {
    const absAddr = this.abs(addr);
    this.view.setUint32(absAddr, TYPE.BOOLEAN, true);
    this.view.setUint32(absAddr + 4, 0, true);
    this.view.setBigInt64(absAddr + 8, v ? 1n : 0n, true);
  }

  /**
   * Write an integer value.
   *
   * @param {number} addr - Segment-relative address
   * @param {number|bigint} v - Integer value
   */
  writeInteger(addr, v) {
    const absAddr = this.abs(addr);
    this.view.setUint32(absAddr, TYPE.INTEGER, true);
    this.view.setUint32(absAddr + 4, 0, true);
    this.view.setBigInt64(absAddr + 8, BigInt(v), true);
  }

  /**
   * Write a float value.
   *
   * @param {number} addr - Segment-relative address
   * @param {number} v - Float value
   */
  writeFloat(addr, v) {
    const absAddr = this.abs(addr);
    this.view.setUint32(absAddr, TYPE.FLOAT, true);
    this.view.setUint32(absAddr + 4, 0, true);
    this.view.setFloat64(absAddr + 8, v, true);
  }

  /**
   * Write a string value.
   *
   * @param {number} addr - Segment-relative address
   * @param {number} stringOffset - String table offset
   */
  writeString(addr, stringOffset) {
    const absAddr = this.abs(addr);
    this.view.setUint32(absAddr, TYPE.STRING, true);
    this.view.setUint32(absAddr + 4, 0, true);
    this.view.setBigInt64(absAddr + 8, BigInt(stringOffset), true);
  }

  /**
   * Write an array value (pointer to heap array).
   *
   * @param {number} addr - Segment-relative address for VALUE slot
   * @param {number} arrayPointer - Segment-relative pointer to heap array
   */
  writeArray(addr, arrayPointer) {
    const absAddr = this.abs(addr);
    this.view.setUint32(absAddr, TYPE.ARRAY, true);
    this.view.setUint32(absAddr + 4, 0, true);
    this.view.setBigInt64(absAddr + 8, BigInt(arrayPointer), true);
  }

  /**
   * Write an object value (pointer to heap object).
   *
   * @param {number} addr - Segment-relative address for VALUE slot
   * @param {number} objectPointer - Segment-relative pointer to heap object
   */
  writeObject(addr, objectPointer) {
    const absAddr = this.abs(addr);
    this.view.setUint32(absAddr, TYPE.OBJECT, true);
    this.view.setUint32(absAddr + 4, 0, true);
    this.view.setBigInt64(absAddr + 8, BigInt(objectPointer), true);
  }

  // getValue, getValueType, getValuePointer live on MemoryReader.

  // ===========================================================================
  // Strings
  // ===========================================================================

  /**
   * Bounds-checked pointer into the scratch region — the JS mirror of
   * the WAT's $scratch_ptr. This is the only path JS code takes into
   * scratch; callers declare the full extent
   * [offset, offset + bytes) they are about to touch.
   *
   * @param {number} offset - Offset into the scratch region
   * @param {number} bytes - Extent the caller will touch
   * @returns {number} - Segment-relative pointer to scratch + offset
   */
  scratchPointerChecked(offset, bytes) {
    const scratchLimit = this.getScratchSize() || SCRATCH_SIZE;
    if (offset + bytes > scratchLimit) {
      throw new Error(
        `Scratch write out of bounds: [${offset}, ${offset + bytes}) exceeds ` +
        `the scratch region size ${scratchLimit}.`);
    }
    return this.getScratchBase() + offset;
  }

  /**
   * Intern a string using WASM.
   *
   * @param {string} str - String to intern
   * @returns {number} - Segment-relative offset to string entry
   */
  internString(str) {
    if (!this.wasm) {
      throw new Error('WASM instance not set - call setWasmInstance first');
    }

    const bytes = this.encoder.encode(str);

    const scratchLimit = this.getScratchSize() || SCRATCH_SIZE;
    if (bytes.length > scratchLimit) {
      const suggestedSize = Math.pow(2, Math.ceil(Math.log2(bytes.length * 2)));
      throw new Error(
        `String too long for interning: ${bytes.length} bytes (max ${scratchLimit}). ` +
        `The limit is the session's scratch region size — pass a larger ` +
        `scratchSize when creating the session, e.g. ` +
        `freshSession({ scratchSize: ${suggestedSize} })`);
    }

    // Snapshot the flag state on entry. If it was already set (from a
    // prior dispatcher yield), we don't want to mistake that for a
    // pressure event caused by THIS call. We only treat this call as
    // pressured if it actually returns the sentinel 0 (real ids start
    // at STRING_DATA_START; 0 is inside the reserved prefix and never
    // a valid entry id).
    const scratchPointer = this.abs(this.scratchPointerChecked(0, bytes.length));
    this.u8.set(bytes, scratchPointer);
    const id = this.wasm.exports.intern_string(scratchPointer, bytes.length);

    if (id === 0) {
      // This call hit the string-table bounds check. The WAT side has
      // set $memory_pressure_signaled; clear it before throwing so the
      // host's next call starts clean.
      this.wasm.exports.clear_memory_pressure();
      // Typed as HeapPressureSignal (region 'string-table') so every
      // pressure-recovery site — marshalResult's rollback,
      // resumeWithValue's deferred-marshal stash, the linked-promise
      // settle retry, the airlock's error-delivery retry — treats a
      // full string table exactly like a full heap: gc (which compacts
      // the string table too) and retry. Before 2026-06-12 this threw
      // a plain Error that sailed past all of them.
      throw new HeapPressureSignal(
        bytes.length, 0,
        `String table full while interning ${bytes.length}-byte string; ` +
        `call session.gc() or grow the string table via ` +
        `engine.resizeSegment() before retrying`,
        'string-table');
    }

    return id;
  }

  // readString lives on MemoryReader.

  /**
   * Pre-intern all built-in names into the BUILTINS segment.
   * Called during initialization after WASM is ready.
   */
  /**
   * The Schema global's builtin names (VERSION.BUILTIN v7). Split out so
   * the aggregate-version 2 -> 3 migration can replay it over a restored
   * image (tools/migrate-drone-bytes.js).
   */
  internSchemaBuiltinNames(intern) {
    intern(BUILTIN_NAME.COMPILE, "compile");
    intern(BUILTIN_NAME.VALIDATE, "validate");
    intern(BUILTIN_NAME.ASSERT, "assert");
    intern(BUILTIN_NAME.ERRORS, "errors");
    intern(BUILTIN_NAME.IS_SCHEMA, "isSchema");
    intern(BUILTIN_NAME.FORMATS, "formats");
    intern(BUILTIN_NAME.KEY_SCHEMA, "schema");
    intern(BUILTIN_NAME.KEY_DIALECT, "dialect");
    intern(BUILTIN_NAME.KEY_VALID, "valid");
    intern(BUILTIN_NAME.KEY_ERROR_COUNT, "errorCount");
    intern(BUILTIN_NAME.KEY_SCHEMAS, "schemas");
    intern(BUILTIN_NAME.KEY_BASE_URI, "baseUri");
    intern(BUILTIN_NAME.KEY_STRICT, "strict");
    intern(BUILTIN_NAME.KEY_MAX_DEPTH, "maxDepth");
    intern(BUILTIN_NAME.KEY_MAX_ERRORS, "maxErrors");
    intern(BUILTIN_NAME.KEY_ARENA_BYTES, "arenaBytes");
    intern(BUILTIN_NAME.LIT_ANNOTATE, "annotate");
    intern(BUILTIN_NAME.LIT_DIALECT_2020, "2020-12");
    intern(BUILTIN_NAME.LIT_DIALECT_2019, "2019-09");
    intern(BUILTIN_NAME.LIT_DIALECT_07, "draft-07");
    intern(BUILTIN_NAME.LIT_DIALECT_06, "draft-06");
    intern(BUILTIN_NAME.LIT_DIALECT_04, "draft-04");
    intern(BUILTIN_NAME.KEY_DOLLAR_SCHEMA, "$schema");
    intern(BUILTIN_NAME.KEY_KEYWORD, "keyword");
    intern(BUILTIN_NAME.KEY_PARAMS, "params");
    intern(BUILTIN_NAME.KEY_TYPE, "type");
    intern(BUILTIN_NAME.KEY_LIMIT, "limit");
    intern(BUILTIN_NAME.KEY_COMPARISON, "comparison");
    intern(BUILTIN_NAME.KEY_MULTIPLE_OF, "multipleOf");
    intern(BUILTIN_NAME.KEY_MISSING_PROPERTY, "missingProperty");
    intern(BUILTIN_NAME.KEY_PROPERTY, "property");
    intern(BUILTIN_NAME.KEY_I, "i");
    intern(BUILTIN_NAME.KEY_J, "j");
    intern(BUILTIN_NAME.KEY_MIN_CONTAINS, "minContains");
    intern(BUILTIN_NAME.KEY_MAX_CONTAINS, "maxContains");
    intern(BUILTIN_NAME.KEY_PATTERN, "pattern");
    intern(BUILTIN_NAME.KEY_FORMAT, "format");
    intern(BUILTIN_NAME.MSG_SCHEMA_SOURCE, "Schema requires an object or boolean schema");
    intern(BUILTIN_NAME.MSG_SCHEMA_OPTIONS, "Schema options must be an object");
    intern(BUILTIN_NAME.MSG_SCHEMA_RECEIVER, "Schema methods require a Schema receiver");
    intern(BUILTIN_NAME.MSG_SCHEMA_ASSERT, "value does not match schema");
    intern(BUILTIN_NAME.MSG_SCHEMA_INVALID, "invalid schema");
    intern(BUILTIN_NAME.MSG_SCHEMA_BUNDLE, "Schema options.schemas must be an array of [uri, schema] pairs");
    intern(BUILTIN_NAME.MSG_SCHEMA_LIMIT, "Schema limit exceeded");
    // Retired schema-message slots 0x758..0x7E0 stay uninitialized in fresh
    // vats. GC walks the full builtin region and skips zero cells; restored
    // vats retain and forward any old ids without renumbering later slots.
    intern(BUILTIN_NAME.KEY_DIAGNOSTIC, "diagnostic");
    intern(BUILTIN_NAME.COMPILE_SET, "compileSet");
    intern(BUILTIN_NAME.LIT_SET, "set");
    intern(BUILTIN_NAME.MSG_SCHEMA_SET_METHOD, "a schema set has match(value), matchAll(value), and test(value, index)");
    intern(BUILTIN_NAME.MSG_SCHEMA_ROUTE_INDEX, "route index out of range");
    intern(BUILTIN_NAME.MSG_SCHEMA_SET_SOURCE, "Schema.compileSet requires an array of schemas");
  }

  /**
   * Intern `str` and store its id at the builtin-name slot `offset`.
   */
  builtinNameWriter() {
    const builtinsBase = this.getBuiltinsBase();
    return (offset, str) => {
      if (offset + 4 > BUILTINS_SIZE) {
        throw new Error(
          `Builtin-name slot out of bounds: [${offset}, ${offset + 4}) exceeds ` +
          `BUILTINS_SIZE ${BUILTINS_SIZE}.`);
      }
      const stringOffset = this.internString(str);
      this.view.setUint32(this.abs(builtinsBase + offset), stringOffset, true);
    };
  }

  internBuiltinNames() {
    const builtinsBase = this.getBuiltinsBase();

    // Helper to intern and store at builtin offset
    const intern = (offset, str) => {
      if (offset + 4 > BUILTINS_SIZE) {
        throw new Error(
          `Builtin-name slot out of bounds: [${offset}, ${offset + 4}) exceeds ` +
          `BUILTINS_SIZE ${BUILTINS_SIZE}.`);
      }
      const stringOffset = this.internString(str);
      this.view.setUint32(this.abs(builtinsBase + offset), stringOffset, true);
    };

    // Typeof strings
    intern(BUILTIN_NAME.TYPEOF_UNDEFINED, 'undefined');
    intern(BUILTIN_NAME.TYPEOF_BOOLEAN, 'boolean');
    intern(BUILTIN_NAME.TYPEOF_NUMBER, 'number');
    intern(BUILTIN_NAME.TYPEOF_STRING, 'string');
    intern(BUILTIN_NAME.TYPEOF_OBJECT, 'object');
    intern(BUILTIN_NAME.TYPEOF_FUNCTION, 'function');

    // Special keywords
    intern(BUILTIN_NAME.THIS, 'this');
    intern(BUILTIN_NAME.LENGTH, 'length');

    // Array methods
    intern(BUILTIN_NAME.PUSH, 'push');
    intern(BUILTIN_NAME.POP, 'pop');
    intern(BUILTIN_NAME.SHIFT, 'shift');
    intern(BUILTIN_NAME.UNSHIFT, 'unshift');
    intern(BUILTIN_NAME.SLICE, 'slice');
    intern(BUILTIN_NAME.CONCAT, 'concat');
    intern(BUILTIN_NAME.JOIN, 'join');
    intern(BUILTIN_NAME.REVERSE, 'reverse');
    intern(BUILTIN_NAME.INDEX_OF, 'indexOf');
    intern(BUILTIN_NAME.INCLUDES, 'includes');
    intern(BUILTIN_NAME.MAP, 'map');
    intern(BUILTIN_NAME.FILTER, 'filter');
    intern(BUILTIN_NAME.REDUCE, 'reduce');
    intern(BUILTIN_NAME.FOR_EACH, 'forEach');
    intern(BUILTIN_NAME.FIND, 'find');
    intern(BUILTIN_NAME.FIND_INDEX, 'findIndex');
    intern(BUILTIN_NAME.SOME, 'some');
    intern(BUILTIN_NAME.EVERY, 'every');
    intern(BUILTIN_NAME.SPLICE, 'splice');
    intern(BUILTIN_NAME.SORT, 'sort');
    intern(BUILTIN_NAME.FLAT, 'flat');
    intern(BUILTIN_NAME.FLAT_MAP, 'flatMap');
    intern(BUILTIN_NAME.AT, 'at');

    // String methods
    intern(BUILTIN_NAME.CHAR_AT, 'charAt');
    intern(BUILTIN_NAME.CHAR_CODE_AT, 'charCodeAt');
    intern(BUILTIN_NAME.STRING_INDEX_OF, 'indexOf');
    intern(BUILTIN_NAME.STRING_INCLUDES, 'includes');
    intern(BUILTIN_NAME.STRING_SLICE, 'slice');
    intern(BUILTIN_NAME.SUBSTRING, 'substring');
    intern(BUILTIN_NAME.SPLIT, 'split');
    intern(BUILTIN_NAME.TRIM, 'trim');
    intern(BUILTIN_NAME.TO_LOWER_CASE, 'toLowerCase');
    intern(BUILTIN_NAME.TO_UPPER_CASE, 'toUpperCase');
    intern(BUILTIN_NAME.STARTS_WITH, 'startsWith');
    intern(BUILTIN_NAME.ENDS_WITH, 'endsWith');
    intern(BUILTIN_NAME.REPEAT, 'repeat');
    intern(BUILTIN_NAME.PAD_START, 'padStart');
    intern(BUILTIN_NAME.PAD_END, 'padEnd');
    intern(BUILTIN_NAME.REPLACE, 'replace');
    intern(BUILTIN_NAME.REPLACE_ALL, 'replaceAll');
    intern(BUILTIN_NAME.TRIM_START, 'trimStart');
    intern(BUILTIN_NAME.TRIM_END, 'trimEnd');
    intern(BUILTIN_NAME.STRING_LAST_INDEX_OF, 'lastIndexOf');
    intern(BUILTIN_NAME.STRING_AT, 'at');
    intern(BUILTIN_NAME.STRING_CONCAT, 'concat');

    // Literal strings for type conversion
    intern(BUILTIN_NAME.LIT_NULL, 'null');
    intern(BUILTIN_NAME.LIT_TRUE, 'true');
    intern(BUILTIN_NAME.LIT_FALSE, 'false');
    intern(BUILTIN_NAME.LIT_OBJECT_OBJECT, '[object Object]');
    intern(BUILTIN_NAME.LIT_NAN, 'NaN');
    intern(BUILTIN_NAME.LIT_INFINITY, 'Infinity');
    intern(BUILTIN_NAME.LIT_NEG_INFINITY, '-Infinity');
    intern(BUILTIN_NAME.LIT_OBJECT_FUNCTION, '[object Function]');
    intern(BUILTIN_NAME.LIT_EMPTY_STRING, '');

    // Symbol.toStringTag (B2): whole-literal tags for built-in types,
    // plus the fragments the user-tag path concatenates.
    intern(BUILTIN_NAME.LIT_OBJECT_PREFIX, '[object ');
    intern(BUILTIN_NAME.LIT_CLOSE_BRACKET, ']');
    intern(BUILTIN_NAME.LIT_OBJECT_MAP, '[object Map]');
    intern(BUILTIN_NAME.LIT_OBJECT_SET, '[object Set]');
    intern(BUILTIN_NAME.LIT_OBJECT_ARRAY, '[object Array]');
    intern(BUILTIN_NAME.LIT_OBJECT_UNDEFINED, '[object Undefined]');
    intern(BUILTIN_NAME.LIT_OBJECT_NULL, '[object Null]');
    intern(BUILTIN_NAME.LIT_OBJECT_BOOLEAN, '[object Boolean]');
    intern(BUILTIN_NAME.LIT_OBJECT_NUMBER, '[object Number]');
    intern(BUILTIN_NAME.LIT_OBJECT_STRING, '[object String]');
    intern(BUILTIN_NAME.LIT_OBJECT_PROMISE, '[object Promise]');

    // Object.getOwnPropertyDescriptor (B1): descriptor property names.
    intern(BUILTIN_NAME.WRITABLE, 'writable');
    intern(BUILTIN_NAME.ENUMERABLE, 'enumerable');
    intern(BUILTIN_NAME.CONFIGURABLE, 'configurable');
    intern(BUILTIN_NAME.GET_KEY, 'get');
    intern(BUILTIN_NAME.SET_KEY, 'set');

    // Generators (INTERNALS.md's Generators section): generator-object hidden state keys
    // and method-name strings.
    intern(BUILTIN_NAME.GENERATOR_CONTEXT_KEY, '@generatorContext');
    intern(BUILTIN_NAME.GENERATOR_STATE_KEY, '@generatorState');
    intern(BUILTIN_NAME.GENERATOR_CALLER_KEY, '@generatorCaller');
    intern(BUILTIN_NAME.RETURN_KEY, 'return');
    intern(BUILTIN_NAME.THROW_KEY, 'throw');
    intern(BUILTIN_NAME.CALL_NAME, 'call');
    intern(BUILTIN_NAME.APPLY_NAME, 'apply');
    intern(BUILTIN_NAME.BIND_NAME, 'bind');
    intern(BUILTIN_NAME.MSG_FUNCTION_METHOD_UNSUPPORTED,
      'call/apply/bind: unsupported form (async or generator callee, bind with partial arguments, or apply array beyond current stack capacity)');

    // Async generators: step-promise / request-queue hidden keys.
    intern(BUILTIN_NAME.ASYNC_GENERATOR_STEP_PROMISE_KEY, '@asyncGeneratorStepPromise');
    intern(BUILTIN_NAME.ASYNC_GENERATOR_QUEUE_KEY, '@asyncGeneratorQueue');
    intern(BUILTIN_NAME.REQUEST_OPERATION_KEY, '@requestOperation');
    intern(BUILTIN_NAME.REQUEST_VALUE_KEY, '@requestValue');
    intern(BUILTIN_NAME.REQUEST_PROMISE_KEY, '@requestPromise');
    intern(BUILTIN_NAME.REQUEST_NEXT_KEY, '@requestNext');

    // Error.prototype.toString() formatting.
    intern(BUILTIN_NAME.LIT_COLON_SPACE, ': ');

    // Array/TypedArray prototype method gaps
    intern(BUILTIN_NAME.FIND_LAST, 'findLast');
    intern(BUILTIN_NAME.FIND_LAST_INDEX, 'findLastIndex');
    intern(BUILTIN_NAME.VALUES, 'values');
    intern(BUILTIN_NAME.ENTRIES, 'entries');
    intern(BUILTIN_NAME.TO_REVERSED, 'toReversed');
    intern(BUILTIN_NAME.TO_SORTED, 'toSorted');
    intern(BUILTIN_NAME.WITH_NAME, 'with');
    intern(BUILTIN_NAME.TO_SPLICED, 'toSpliced');
    intern(BUILTIN_NAME.MSG_INVALID_INDEX, 'Invalid index');
    intern(BUILTIN_NAME.TO_LOCALE_STRING, 'toLocaleString');

    // Prototype chain related
    intern(BUILTIN_NAME.PROTOTYPE, 'prototype');
    intern(BUILTIN_NAME.CONSTRUCTOR, 'constructor');
    intern(BUILTIN_NAME.HAS_OWN_PROPERTY, 'hasOwnProperty');
    intern(BUILTIN_NAME.GET_PROTOTYPE_OF, 'getPrototypeOf');
    intern(BUILTIN_NAME.NAME, 'name');
    intern(BUILTIN_NAME.MESSAGE, 'message');

    // Error type names
    intern(BUILTIN_NAME.LIT_ERROR, 'Error');
    intern(BUILTIN_NAME.LIT_TYPE_ERROR, 'TypeError');
    intern(BUILTIN_NAME.LIT_REFERENCE_ERROR, 'ReferenceError');
    intern(BUILTIN_NAME.LIT_GRANT_DENIED_ERROR, 'GrantDeniedError');
    intern(BUILTIN_NAME.LIT_RANGE_ERROR, 'RangeError');

    // ArrayBuffer/Uint8Array property names
    intern(BUILTIN_NAME.BYTE_LENGTH, 'byteLength');
    intern(BUILTIN_NAME.BYTE_OFFSET, 'byteOffset');
    intern(BUILTIN_NAME.BUFFER, 'buffer');

    // Uint8Array method names
    intern(BUILTIN_NAME.SUBARRAY, 'subarray');
    intern(BUILTIN_NAME.FILL, 'fill');
    intern(BUILTIN_NAME.SET, 'set');
    intern(BUILTIN_NAME.COPY_WITHIN, 'copyWithin');
    intern(BUILTIN_NAME.LAST_INDEX_OF, 'lastIndexOf');
    intern(BUILTIN_NAME.REDUCE_RIGHT, 'reduceRight');
    intern(BUILTIN_NAME.FROM, 'from');
    intern(BUILTIN_NAME.OF, 'of');

    // DataView constructor and method names
    intern(BUILTIN_NAME.DATA_VIEW, 'DataView');
    intern(BUILTIN_NAME.GET_INT8, 'getInt8');
    intern(BUILTIN_NAME.GET_UINT8, 'getUint8');
    intern(BUILTIN_NAME.GET_INT16, 'getInt16');
    intern(BUILTIN_NAME.GET_UINT16, 'getUint16');
    intern(BUILTIN_NAME.GET_INT32, 'getInt32');
    intern(BUILTIN_NAME.GET_UINT32, 'getUint32');
    intern(BUILTIN_NAME.GET_FLOAT32, 'getFloat32');
    intern(BUILTIN_NAME.GET_FLOAT64, 'getFloat64');
    intern(BUILTIN_NAME.SET_INT8, 'setInt8');
    intern(BUILTIN_NAME.SET_UINT8, 'setUint8');
    intern(BUILTIN_NAME.SET_INT16, 'setInt16');
    intern(BUILTIN_NAME.SET_UINT16, 'setUint16');
    intern(BUILTIN_NAME.SET_INT32, 'setInt32');
    intern(BUILTIN_NAME.SET_UINT32, 'setUint32');
    intern(BUILTIN_NAME.SET_FLOAT32, 'setFloat32');
    intern(BUILTIN_NAME.SET_FLOAT64, 'setFloat64');

    // toString method name string
    intern(BUILTIN_NAME.TO_STRING_NAME, 'toString');

    // Typed array constructor names
    intern(BUILTIN_NAME.INT8ARRAY, 'Int8Array');
    intern(BUILTIN_NAME.UINT8CLAMPEDARRAY, 'Uint8ClampedArray');
    intern(BUILTIN_NAME.INT16ARRAY, 'Int16Array');
    intern(BUILTIN_NAME.UINT16ARRAY, 'Uint16Array');
    intern(BUILTIN_NAME.INT32ARRAY, 'Int32Array');
    intern(BUILTIN_NAME.UINT32ARRAY, 'Uint32Array');
    intern(BUILTIN_NAME.FLOAT32ARRAY, 'Float32Array');
    intern(BUILTIN_NAME.FLOAT64ARRAY, 'Float64Array');
    intern(BUILTIN_NAME.BYTES_PER_ELEMENT, 'BYTES_PER_ELEMENT');

    // Promise method names
    intern(BUILTIN_NAME.THEN, 'then');
    intern(BUILTIN_NAME.CATCH, 'catch');
    intern(BUILTIN_NAME.FINALLY, 'finally');

    // Typeof bigint
    intern(BUILTIN_NAME.TYPEOF_BIGINT, 'bigint');
    intern(BUILTIN_NAME.TYPEOF_SYMBOL, 'symbol');

    // Ring 2: Symbol property / method / toString fragments
    intern(BUILTIN_NAME.SYMBOL_DESCRIPTION, 'description');
    intern(BUILTIN_NAME.SYMBOL_LIT_PREFIX, 'Symbol(');
    intern(BUILTIN_NAME.SYMBOL_LIT_SUFFIX, ')');
    intern(BUILTIN_NAME.SYMBOL_LIT_EMPTY, 'Symbol()');

    // Ring 2 (2b.3): expression head names — interned so the sugar
    // constructors can look up the registry entry without re-interning.
    intern(BUILTIN_NAME.EXPRESSION_HEAD_ADD, 'Add');
    intern(BUILTIN_NAME.EXPRESSION_HEAD_SUBTRACT, 'Subtract');
    intern(BUILTIN_NAME.EXPRESSION_HEAD_MULTIPLY, 'Multiply');
    intern(BUILTIN_NAME.EXPRESSION_HEAD_DIVIDE, 'Divide');
    intern(BUILTIN_NAME.EXPRESSION_HEAD_POWER, 'Power');
    intern(BUILTIN_NAME.EXPRESSION_HEAD_NEGATE, 'Negate');

    // Ring 2 (2b.4): Exact.typeOf('expression') fine-grained tag.
    // Symbol tag reuses BUILTIN.TYPEOF_SYMBOL interned during 2a.2.
    intern(BUILTIN_NAME.EXACT_TYPEOF_EXPRESSION, 'expression');

    // Ring 4 (4a): Exact.Matrix typeOf tag + error messages. Static
    // messages only — dimension/index specifics ride as integer
    // properties on the error object (the throw_range_error_with_context
    // idiom), not baked into the string.
    intern(BUILTIN_NAME.EXACT_TYPEOF_MATRIX, 'matrix');
    intern(BUILTIN_NAME.MSG_MATRIX_ROWS_NOT_ARRAY, 'Exact.Matrix: expected an Array of row Arrays');
    intern(BUILTIN_NAME.MSG_MATRIX_RAGGED, 'Exact.Matrix: rows must all have the same length');
    intern(BUILTIN_NAME.MSG_MATRIX_ENTRY_TYPE, 'Exact.Matrix: entries must be Rational, Complex, BigInt, Symbol, Expression, or Matrix');
    intern(BUILTIN_NAME.MSG_MATRIX_NOT_MATRIX, 'Exact.Matrix: expected a Matrix');
    intern(BUILTIN_NAME.MSG_MATRIX_DIMENSION, 'Exact.Matrix: invalid dimensions');
    intern(BUILTIN_NAME.MSG_MATRIX_INDEX, 'Exact.Matrix.get: index out of bounds');

    // Ring 4 (4b): Conjugate head name + element-wise error messages.
    intern(BUILTIN_NAME.EXPRESSION_HEAD_CONJUGATE, 'Conjugate');
    intern(BUILTIN_NAME.MSG_MATRIX_SHAPE_MISMATCH, 'Exact.Matrix: shape mismatch');
    intern(BUILTIN_NAME.MSG_MATRIX_SCALE_SCALAR, 'Exact.Matrix.scale: scalar must be an exact or symbolic value (a Matrix only if 1x1)');

    // Ring 4 (4c): linear-algebra error messages.
    intern(BUILTIN_NAME.MSG_MATRIX_NOT_SQUARE, 'Exact.Matrix: matrix is not square');

    // Ring 4 (4d): inverse / solve error messages.
    intern(BUILTIN_NAME.MSG_MATRIX_SINGULAR, 'Exact.Matrix.inverse: matrix is singular');

    // Ring 5 (5a): Equal / NotEqual head names + match error messages.
    intern(BUILTIN_NAME.EXPRESSION_HEAD_EQUAL, 'Equal');
    intern(BUILTIN_NAME.EXPRESSION_HEAD_NOT_EQUAL, 'NotEqual');
    intern(BUILTIN_NAME.MSG_MATCH_VARIABLES, 'Exact.Expression.match: variables must be an Array of distinct Symbols');
    intern(BUILTIN_NAME.MSG_MATCH_VARIABLE_ABSENT, 'Exact.Expression.match: a listed variable does not occur in the pattern');

    // Ring 5 (5c): Determinant / Rank head names + rewrite messages.
    intern(BUILTIN_NAME.EXPRESSION_HEAD_DETERMINANT, 'Determinant');
    intern(BUILTIN_NAME.EXPRESSION_HEAD_RANK, 'Rank');
    // Exact.Expression transcendental heads and diagnostics.
    intern(BUILTIN_NAME.EXPRESSION_HEAD_EXP, 'Exp');
    intern(BUILTIN_NAME.EXPRESSION_HEAD_LOG, 'Log');
    intern(BUILTIN_NAME.MSG_EXPRESSION_UNARY_ARITY, 'Exact.Expression transcendental constructors require exactly 1 argument');
    intern(BUILTIN_NAME.MSG_EXPRESSION_APPROXIMATION, 'Exact.Expression.toApproximation: expected a supported real-valued exact expression');
    intern(BUILTIN_NAME.EXACT_CONSTANT_PI, 'Pi');

    // Symbolic calculus: ordering relation heads, derivative record keys,
    // and diagnostics.
    intern(BUILTIN_NAME.EXPRESSION_HEAD_LESS, 'Less');
    intern(BUILTIN_NAME.EXPRESSION_HEAD_LESS_EQUAL, 'LessEqual');
    intern(BUILTIN_NAME.EXPRESSION_HEAD_GREATER, 'Greater');
    intern(BUILTIN_NAME.EXPRESSION_HEAD_GREATER_EQUAL, 'GreaterEqual');
    intern(BUILTIN_NAME.MSG_DERIVATIVE_UNSUPPORTED_HEAD, 'Exact.Expression.derivative: no rule for head ');
    intern(BUILTIN_NAME.MSG_DERIVATIVE_ARGUMENTS, 'Exact.Expression derivative methods: expected an expression and Symbol variables');
    intern(BUILTIN_NAME.MSG_TAYLOR_ORDER, 'Exact.Expression.taylor: order must be a nonnegative exact integer within the resource bound');
    intern(BUILTIN_NAME.KEY_EXPRESSION, 'expression');
    intern(BUILTIN_NAME.KEY_CONDITIONS, 'conditions');
    intern(BUILTIN_NAME.KEY_EXPRESSIONS, 'expressions');
    intern(BUILTIN_NAME.KEY_MATRIX, 'matrix');
    intern(BUILTIN_NAME.KEY_POLYNOMIAL, 'polynomial');
    intern(BUILTIN_NAME.KEY_VARIABLE, 'variable');
    intern(BUILTIN_NAME.KEY_POINT, 'point');
    intern(BUILTIN_NAME.KEY_ORDER, 'order');

    // Exact solving and factorization: record keys, tagged-kind literals,
    // and diagnostics.
    intern(BUILTIN_NAME.KEY_UNIT, 'unit');
    intern(BUILTIN_NAME.KEY_FACTORS, 'factors');
    intern(BUILTIN_NAME.KEY_KIND, 'kind');
    intern(BUILTIN_NAME.KEY_SOLUTION, 'solution');
    intern(BUILTIN_NAME.KEY_PARTICULAR, 'particular');
    intern(BUILTIN_NAME.KEY_BASIS, 'basis');
    intern(BUILTIN_NAME.KEY_LOWER, 'lower');
    intern(BUILTIN_NAME.KEY_LOWER_CLOSED, 'lowerClosed');
    intern(BUILTIN_NAME.KEY_UPPER, 'upper');
    intern(BUILTIN_NAME.KEY_UPPER_CLOSED, 'upperClosed');
    intern(BUILTIN_NAME.KEY_SIGN, 'sign');
    intern(BUILTIN_NAME.KEY_INTERVAL, 'interval');
    intern(BUILTIN_NAME.KEY_ROOT, 'root');
    intern(BUILTIN_NAME.KEY_MULTIPLICITY, 'multiplicity');
    intern(BUILTIN_NAME.LIT_SOLVE_UNIQUE, 'unique');
    intern(BUILTIN_NAME.LIT_SOLVE_NONE, 'none');
    intern(BUILTIN_NAME.LIT_SOLVE_FAMILY, 'family');
    intern(BUILTIN_NAME.MSG_SOLVING_ARGUMENTS, 'Exact.Expression solving methods: expected a supported expression, relation, or variable list');
    intern(BUILTIN_NAME.MSG_SOLVING_UNSUPPORTED, 'Exact.Expression solving methods: unsupported expression class for the exact domain');
    intern(BUILTIN_NAME.MSG_SOLVING_POSITIVE_DIMENSIONAL, 'Exact.Expression.solveSystem: the system is not zero-dimensional');

    // Verified symbolic integration.
    intern(BUILTIN_NAME.EXPRESSION_HEAD_INTEGRAL, 'Integral');
    intern(BUILTIN_NAME.LIT_INTEGRAL_VERIFIED, 'verified');
    intern(BUILTIN_NAME.LIT_INTEGRAL_UNEVALUATED, 'unevaluated');
    intern(BUILTIN_NAME.MSG_INTEGRAL_ARGUMENTS, 'Exact.Expression integration methods: expected a supported expression, Symbol variable, and exact bounds');

    this.internSchemaBuiltinNames(intern);

    // Ring 6 (6a): Exact.AlgebraicNumber typeOf tag, error messages,
    // toString fragments, and JSON tagged-object pieces.
    intern(BUILTIN_NAME.EXACT_TYPEOF_ALGEBRAIC, 'algebraic');
    intern(BUILTIN_NAME.MSG_ALGEBRAIC_NOT_POLYNOMIAL, 'Exact.AlgebraicNumber.rootsOfPolynomial: expression is not a polynomial in the variable');
    intern(BUILTIN_NAME.MSG_ALGEBRAIC_COEFFICIENT_TYPE, 'Exact.AlgebraicNumber.rootsOfPolynomial: coefficients must be rational numerics');
    intern(BUILTIN_NAME.MSG_ALGEBRAIC_VARIABLE, 'Exact.AlgebraicNumber.rootsOfPolynomial: variable must be a Symbol');
    intern(BUILTIN_NAME.MSG_ALGEBRAIC_FROM_EXPRESSION, 'Exact.AlgebraicNumber.fromExpression: expression is not an exact numeric-radical tree');
    intern(BUILTIN_NAME.MSG_ALGEBRAIC_ARGUMENT, 'Exact.AlgebraicNumber: expected an AlgebraicNumber, Rational, or BigInt');
    intern(BUILTIN_NAME.MSG_ALGEBRAIC_DIVIDE_BY_ZERO, 'Exact.AlgebraicNumber.fromExpression: division by zero');
    intern(BUILTIN_NAME.MSG_ALGEBRAIC_WIDTH, 'Exact.AlgebraicNumber.toApproximation: widthExponent must be an integer');
    intern(BUILTIN_NAME.MSG_ALGEBRAIC_ZERO_POLYNOMIAL, 'Exact.AlgebraicNumber.rootsOfPolynomial: the zero polynomial has every value as a root');
    intern(BUILTIN_NAME.ALGEBRAIC_TOSTRING_PREFIX, 'algebraic(');
    intern(BUILTIN_NAME.EXACT_VARIABLE_X, 'x');
    intern(BUILTIN_NAME.EXACT_CARET, '^');
    intern(BUILTIN_NAME.EXACT_OPEN_PAREN, '(');
    intern(BUILTIN_NAME.EXACT_CLOSE_PAREN, ')');
    intern(BUILTIN_NAME.EXACT_COMMA_SEP, ', ');
    intern(BUILTIN_NAME.JSON_ALGEBRAIC_PREFIX, '{"$algebraic":{"definingPolynomial":[');
    intern(BUILTIN_NAME.JSON_ALGEBRAIC_MIDDLE, '],"isolatingInterval":[');
    intern(BUILTIN_NAME.JSON_ALGEBRAIC_SUFFIX, ']}}');
    intern(BUILTIN_NAME.JSON_QUOTE, '"');
    intern(BUILTIN_NAME.JSON_QUOTE_COMMA_QUOTE, '","');
    intern(BUILTIN_NAME.MSG_ALGEBRAIC_DEGREE, 'Exact.AlgebraicNumber.rootsOfPolynomial: polynomial degree is too large for isolation');
    intern(BUILTIN_NAME.MSG_ALGEBRAIC_ROOT_DOMAIN, 'Exact.AlgebraicNumber: even root of a negative value has no real result');
    intern(BUILTIN_NAME.MSG_ALGEBRAIC_ROOT_INDEX, 'Exact.AlgebraicNumber.nthRoot: root index must be a positive integer');
    intern(BUILTIN_NAME.EXACT_TYPEOF_COMPLEX_ALGEBRAIC, 'complexAlgebraic');
    intern(BUILTIN_NAME.COMPLEX_ALGEBRAIC_TOSTRING_PREFIX, 'complexAlgebraic(');
    intern(BUILTIN_NAME.JSON_COMPLEX_ALGEBRAIC_PREFIX, '{"$complexAlgebraic":{"realPart":');
    intern(BUILTIN_NAME.JSON_COMPLEX_ALGEBRAIC_MIDDLE, ',"imaginaryPart":');
    intern(BUILTIN_NAME.JSON_COMPLEX_ALGEBRAIC_SUFFIX, '}}');
    intern(BUILTIN_NAME.MSG_ALGEBRAIC_EXPONENT, 'Exact.AlgebraicNumber.fromExpression: rational exponent is out of range');
    intern(BUILTIN_NAME.MSG_ALGEBRAIC_MULTI_COEFFICIENT, 'Exact.AlgebraicNumber.rootsOfPolynomial: coefficients may involve only one algebraic value (multivariate elimination is Ring 7c)');
    intern(BUILTIN_NAME.MSG_ALGEBRAIC_TURNS, 'Exact.AlgebraicNumber.cosineOfTurns: argument must be a Rational number of turns');
    intern(BUILTIN_NAME.MSG_ALGEBRAIC_TOO_MANY_VARIABLES, 'Exact.AlgebraicNumber.rootsOfPolynomial: too many distinct algebraic values in one expression');
    intern(BUILTIN_NAME.MSG_ALGEBRAIC_TOO_MANY_FACTORS, 'Exact.AlgebraicNumber.rootsOfPolynomial: a single coefficient term has too many distinct algebraic factors');
    intern(BUILTIN_NAME.MSG_EXPRESSION_BINARY_ARITY, 'Exact.Expression.add/subtract/multiply/divide/power require exactly 2 arguments');
    intern(BUILTIN_NAME.MSG_ALGEBRAIC_DISAMBIGUATION_LIMIT, 'Exact.AlgebraicNumber: could not disambiguate the composed value among several isolated candidates within the refinement round limit');
    intern(BUILTIN_NAME.MSG_ALGEBRAIC_PRIMITIVE_ELEMENT_SHIFT_LIMIT, 'Exact.AlgebraicNumber.rootsOfPolynomial: primitive-element shift-multiplier search exceeded its bound');
    intern(BUILTIN_NAME.MSG_GROEBNER_EXPONENT_RANGE, 'Exact.Expression.groebnerBasis/polynomialReduce: polynomial exponent exceeds 4294967295');
    intern(BUILTIN_NAME.LIT_SYNTAX_ERROR, 'SyntaxError');
    intern(BUILTIN_NAME.BIGINT_AS_INT_N, 'asIntN');
    intern(BUILTIN_NAME.BIGINT_AS_UINT_N, 'asUintN');
    intern(BUILTIN_NAME.VALUE_OF, 'valueOf');

    // RegExp property/method names and messages (integration step 4).
    intern(BUILTIN_NAME.SOURCE, 'source');
    intern(BUILTIN_NAME.FLAGS, 'flags');
    intern(BUILTIN_NAME.GLOBAL, 'global');
    intern(BUILTIN_NAME.IGNORE_CASE, 'ignoreCase');
    intern(BUILTIN_NAME.MULTILINE, 'multiline');
    intern(BUILTIN_NAME.DOT_ALL, 'dotAll');
    intern(BUILTIN_NAME.HAS_INDICES, 'hasIndices');
    intern(BUILTIN_NAME.STICKY, 'sticky');
    intern(BUILTIN_NAME.LAST_INDEX, 'lastIndex');
    intern(BUILTIN_NAME.EXEC, 'exec');
    intern(BUILTIN_NAME.TEST, 'test');
    intern(BUILTIN_NAME.LIT_REGEXP_EMPTY_SOURCE, '(?:)');
    intern(BUILTIN_NAME.MSG_REGEXP_PATTERN, 'RegExp pattern must be a string or RegExp');
    intern(BUILTIN_NAME.MSG_REGEXP_FLAGS, 'RegExp flags must be a string');
    intern(BUILTIN_NAME.MSG_REGEXP_LAST_INDEX, 'lastIndex must be a non-negative integer');
    // Match-result metadata names (exec's array carries these through its
    // hidden sym-entries meta object) and the detached-call receiver guard.
    intern(BUILTIN_NAME.MATCH_INDEX, 'index');
    intern(BUILTIN_NAME.MATCH_INPUT, 'input');
    intern(BUILTIN_NAME.MATCH_GROUPS, 'groups');
    intern(BUILTIN_NAME.MATCH_INDICES, 'indices');
    intern(BUILTIN_NAME.MSG_REGEXP_RECEIVER, 'RegExp exec/test require a RegExp receiver');
    // RegExp string methods (integration step 5): method names, the
    // matchAll iterator's hidden slots, and flag-validation messages.
    intern(BUILTIN_NAME.MATCH, 'match');
    intern(BUILTIN_NAME.MATCH_ALL, 'matchAll');
    intern(BUILTIN_NAME.SEARCH, 'search');
    intern(BUILTIN_NAME.ITER_HIDDEN_REGEXP, '@regexp');
    intern(BUILTIN_NAME.ITER_HIDDEN_DONE, '@done');
    intern(BUILTIN_NAME.MSG_MATCHALL_GLOBAL, 'matchAll requires a global RegExp');
    intern(BUILTIN_NAME.MSG_REPLACEALL_GLOBAL, 'replaceAll requires a global RegExp');
    intern(BUILTIN_NAME.NEW_TARGET, '@newtarget');
    intern(BUILTIN_NAME.MSG_NOT_EXTENSIBLE, 'This built-in cannot be extended');
    intern(BUILTIN_NAME.MSG_PRIVATE_NOT_DECLARED, 'Private member is not declared on the receiver');
    // extends-externals (BUILTIN v6): branded-instance hidden key and
    // external link/construction diagnostics.
    intern(BUILTIN_NAME.EXTERNAL_BACKING, '@externalBacking');
    intern(BUILTIN_NAME.MSG_EXTERNAL_NOT_EXTENDABLE, 'This external cannot be extended');
    intern(BUILTIN_NAME.MSG_CONSTRUCTION_NO_BACKING, 'Construction returned no backing value');
    intern(BUILTIN_NAME.MSG_CONSTRUCTOR_DIFFERENT_OBJECT, 'Constructor returned a different object');
    intern(BUILTIN_NAME.MSG_RECEIVER_ALREADY_INITIALIZED, 'Receiver is already initialized');
    intern(BUILTIN_NAME.MSG_ILLEGAL_CONSTRUCTOR, 'Illegal constructor');
    intern(BUILTIN_NAME.CONSTRUCT_BEGIN, '@beginConstruction');
    intern(BUILTIN_NAME.CONSTRUCT_COMPLETE, '@completeConstruction');
    intern(BUILTIN_NAME.CONSTRUCT_ABORT, '@abortConstruction');
    intern(BUILTIN_NAME.CONSTRUCTION_LINK, '@constructionLink');
    intern(BUILTIN_NAME.EXACT_MINUS, '-');

    // Exact.typeOf fine-grained type names
    intern(BUILTIN_NAME.EXACT_TYPEOF_INTEGER, 'integer');
    intern(BUILTIN_NAME.EXACT_TYPEOF_RATIONAL, 'rational');
    intern(BUILTIN_NAME.EXACT_TYPEOF_COMPLEX, 'complex');
    intern(BUILTIN_NAME.EXACT_TYPEOF_FLOAT, 'float');

    // Exact.toString fragments
    intern(BUILTIN_NAME.EXACT_SLASH, '/');
    intern(BUILTIN_NAME.EXACT_IMAGINARY_UNIT, 'i');
    intern(BUILTIN_NAME.EXACT_NEG_IMAGINARY_UNIT, '-i');
    intern(BUILTIN_NAME.EXACT_PLUS_SEP, ' + ');
    intern(BUILTIN_NAME.EXACT_MINUS_SEP, ' - ');
    intern(BUILTIN_NAME.EXACT_ZERO, '0');

    // JSON tagged-object prefixes for exact types
    intern(BUILTIN_NAME.JSON_RATIONAL_PREFIX, '{"$rational":"');
    intern(BUILTIN_NAME.JSON_COMPLEX_PREFIX, '{"$complex":"');
    intern(BUILTIN_NAME.JSON_BIGINT_PREFIX, '{"$bigint":"');
    intern(BUILTIN_NAME.JSON_TAGGED_SUFFIX, '"}');

    // Hidden property names used by built-in iterator objects. They live
    // in the builtin table so WAT-side iterator factories can read them
    // via $read_builtin without re-interning at every call site.
    intern(BUILTIN_NAME.ITER_HIDDEN_ARRAY, '@array');
    intern(BUILTIN_NAME.ITER_HIDDEN_INDEX, '@index');
    intern(BUILTIN_NAME.ITER_HIDDEN_STRING, '@string');
    intern(BUILTIN_NAME.ITER_HIDDEN_BYTE_OFFSET, '@byteOffset');
    intern(BUILTIN_NAME.ITER_HIDDEN_BUFFER, '@buffer');
    intern(BUILTIN_NAME.ITER_NEXT_KEY, 'next');
    intern(BUILTIN_NAME.ITER_VALUE_KEY, 'value');
    intern(BUILTIN_NAME.ITER_DONE_KEY, 'done');

    // Map/Set string keys.
    intern(BUILTIN_NAME.MAP_SIZE, 'size');
    intern(BUILTIN_NAME.ITER_HIDDEN_COLL, '@coll');
    intern(BUILTIN_NAME.ITER_HIDDEN_KIND, '@kind');

    // BigInt typed array constructor names
    intern(BUILTIN_NAME.BIGINT64ARRAY, 'BigInt64Array');
    intern(BUILTIN_NAME.BIGUINT64ARRAY, 'BigUint64Array');

    // Error message builtins
    intern(BUILTIN_NAME.MSG_NOT_A_FUNCTION, 'Not a function');
    intern(BUILTIN_NAME.MSG_PROPERTY_OF_NULL, 'Cannot read property of null');
    intern(BUILTIN_NAME.MSG_PROPERTY_OF_UNDEFINED, 'Cannot read property of undefined');
    intern(BUILTIN_NAME.MSG_OUT_OF_BOUNDS, 'Offset is outside the bounds of the DataView');
    intern(BUILTIN_NAME.MSG_INVALID_ARRAY_LENGTH, 'Invalid array length');
    intern(BUILTIN_NAME.MSG_NOT_AN_OBJECT, 'Not an object');
    intern(BUILTIN_NAME.MSG_NOT_DEFINED, 'Not defined');
    intern(BUILTIN_NAME.MSG_MIXED_BIGINT, 'Cannot mix BigInt and other types');
    intern(BUILTIN_NAME.MSG_FROZEN_OBJECT, 'Cannot modify frozen object');

    // btoa / atob error name and messages
    intern(BUILTIN_NAME.LIT_INVALID_CHARACTER_ERROR, 'InvalidCharacterError');
    intern(BUILTIN_NAME.MSG_BTOA_INVALID_CHARACTER,
      'The string to be encoded contains characters outside of the Latin1 range.');
    intern(BUILTIN_NAME.MSG_ATOB_INVALID_CHARACTER, 'Failed to decode base64.');
    intern(BUILTIN_NAME.MSG_MISSING_ARGUMENT, '1 argument required, but only 0 present.');
    intern(BUILTIN_NAME.MSG_CANNOT_CONVERT_TO_NUMBER, 'Cannot convert to a number');
    intern(BUILTIN_NAME.MSG_ACCESSOR_UNSUPPORTED, 'Getter/setter property not supported in this operation');
    intern(BUILTIN_NAME.SETLIKE_HAS, 'has');
    intern(BUILTIN_NAME.SETLIKE_KEYS, 'keys');
    intern(BUILTIN_NAME.MSG_NOT_ITERABLE, 'Not iterable');
    intern(BUILTIN_NAME.MSG_DETACHED_CALLBACK,
      'Callback arguments need the method-call form (use Array.from(source, mapFn) directly)');
    intern(BUILTIN_NAME.FROM_ENTRIES, 'fromEntries');
    intern(BUILTIN_NAME.TO_FIXED, 'toFixed');
    intern(BUILTIN_NAME.MSG_INVALID_RADIX, 'toString() radix must be between 2 and 36');
    intern(BUILTIN_NAME.MSG_INVALID_FRACTION_DIGITS, 'toFixed() digits must be between 0 and 100');

    // Error context property names
    intern(BUILTIN_NAME.PROP_OFFSET, 'offset');
    intern(BUILTIN_NAME.PROP_BUFFER_LENGTH, 'bufferLength');
    intern(BUILTIN_NAME.PROP_ELEMENT_SIZE, 'elementSize');
    intern(BUILTIN_NAME.PROP_TYPE, 'type');
    intern(BUILTIN_NAME.PROP_IDENTIFIER, 'identifier');
    intern(BUILTIN_NAME.PROP_VALUE_LO, 'valueLo');
    intern(BUILTIN_NAME.PROP_VALUE_FLAGS, 'valueFlags');
    intern(BUILTIN_NAME.PROP_VALUE_HI, 'valueHi');
    intern(BUILTIN_NAME.PROP_VALUE_ADDR, 'valueAddr');
    intern(BUILTIN_NAME.PROP_STACK_BASE, 'stackBase');
  }

  // getBuiltinName lives on MemoryReader.

  // ===========================================================================
  // Scopes
  // ===========================================================================

  /**
   * Create a new scope.
   *
   * Scope layout: [GC 8][parent_pointer 4][count 4][capacity 4][entries_pointer 4]
   * Entries: array of [name_offset 4][value_pointer 4] pairs
   *
   * @param {number} parentPointer - Parent scope pointer (0 for global)
   * @returns {number} - Segment-relative pointer to scope
   */
  createScope(parentPointer, capacity = 8) {
    // Each entry is 20 bytes: [name:4][type:4][flags:4][data_lo:4][data_hi:4]
    const entriesSize = capacity * 20;

    // Allocate entries array (allocate returns DATA pointer, we need HEADER pointer)
    const entriesDataPointer = this.allocate(entriesSize, OBJ.SCOPE_ENTRIES);
    const entriesHeaderPointer = entriesDataPointer - GC_HEADER_SIZE;

    // Allocate scope header
    const scopePointer = this.allocate(24, OBJ.SCOPE);
    const absPointer = this.abs(scopePointer);

    this.view.setUint32(absPointer, parentPointer, true);
    this.view.setUint32(absPointer + 4, 0, true); // count
    this.view.setUint32(absPointer + 8, capacity, true);
    // Store HEADER pointer for entries (WAT expects header pointer and adds GC_HEADER_SIZE to access data)
    this.view.setUint32(absPointer + 12, entriesHeaderPointer, true);
    this.view.setUint32(absPointer + 16, 0, true); // flags (bit 0 = closure-captured; scope recycling)
    this.view.setUint32(absPointer + 20, 0, true); // reserved

    return scopePointer;
  }

  /**
   * Mark a scope chain closure-captured (flags bit 0 at data offset
   * 16) — the JS mirror of the WAT's $scope_mark_captured_chain. A
   * captured scope must never enter the interpreter's scope recycling
   * cache. Stops at the first already-marked scope: marking is monotone and
   * its ancestors are already marked.
   *
   * @param {number} scopePointer - Scope DATA pointer (0 allowed)
   */
  markScopeCaptured(scopePointer) {
    let scope = scopePointer;
    while (scope !== 0) {
      const absFlags = this.abs(scope) + 16;
      const flags = this.view.getUint32(absFlags, true);
      if (flags & 1) return;
      this.view.setUint32(absFlags, flags | 1, true);
      scope = this.view.getUint32(this.abs(scope), true);
    }
  }

  /**
   * Define a variable in a scope.
   *
   * @param {number} scopePointer - Scope pointer
   * @param {number} nameOffset - String table offset for name
   * @param {number} valuePointer - Pointer to value
   */
  scopeDefine(scopePointer, nameOffset, valuePointer) {
    const absPointer = this.abs(scopePointer);
    const count = this.view.getUint32(absPointer + 4, true);
    const capacity = this.view.getUint32(absPointer + 8, true);
    const entriesPointer = this.view.getUint32(absPointer + 12, true);

    // Entry is 20 bytes: [name:4][type:4][flags:4][data_lo:4][data_hi:4]
    // Entry data starts after GC header
    const entryDataStart = entriesPointer + GC_HEADER_SIZE;

    // Read value from valuePointer once.
    const absValuePointer = this.abs(valuePointer);
    const type = this.view.getUint32(absValuePointer, true);
    const flags = this.view.getUint32(absValuePointer + 4, true);
    const dataLo = this.view.getUint32(absValuePointer + 8, true);
    const dataHi = this.view.getUint32(absValuePointer + 12, true);

    // WAT-side scope_define rejects duplicates (LET_VAR shadowing is a
    // programmer error). The JS path is invoked via airlock.declare(), where
    // hosts expect "bind name to this value, idempotent": rebind on duplicate.
    for (let i = 0; i < count; i++) {
      const entryOffset = entryDataStart + i * 20;
      const absEntryPointer = this.abs(entryOffset);
      if (this.view.getUint32(absEntryPointer, true) === nameOffset) {
        this.view.setUint32(absEntryPointer + 4, type, true);
        this.view.setUint32(absEntryPointer + 8, flags, true);
        this.view.setUint32(absEntryPointer + 12, dataLo, true);
        this.view.setUint32(absEntryPointer + 16, dataHi, true);
        return;
      }
    }

    if (count >= capacity) {
      throw new Error('Scope capacity exceeded (TODO: grow)');
    }

    const entryOffset = entryDataStart + count * 20;
    const absEntryPointer = this.abs(entryOffset);

    this.view.setUint32(absEntryPointer, nameOffset, true);
    this.view.setUint32(absEntryPointer + 4, type, true);
    this.view.setUint32(absEntryPointer + 8, flags, true);
    this.view.setUint32(absEntryPointer + 12, dataLo, true);
    this.view.setUint32(absEntryPointer + 16, dataHi, true);

    this.view.setUint32(absPointer + 4, count + 1, true);
  }

  /**
   * Delete a binding from a scope (the given scope only — no parent
   * walk). Swap-last + decrement count; intra-scope entry order is
   * not semantically meaningful (lookup is linear first-match and
   * redeclaration is rejected, so names are unique within a scope).
   *
   * Used by patch application: WAT-side scope_define rejects
   * redeclaration, so re-running a selected declaration requires
   * deleting the existing binding first — and removed bindings are
   * deleted outright (the new source is the contract).
   *
   * @param {number} scopePointer - Scope DATA pointer
   * @param {number} nameOffset - String table offset for the name
   * @returns {boolean} - true if the binding existed and was deleted
   */
  scopeDeleteBinding(scopePointer, nameOffset) {
    const absPointer = this.abs(scopePointer);
    const count = this.view.getUint32(absPointer + 4, true);
    const entriesPointer = this.view.getUint32(absPointer + 12, true);
    const entryDataStart = entriesPointer + GC_HEADER_SIZE;

    for (let i = 0; i < count; i++) {
      const entryOffset = entryDataStart + i * 20;
      if (this.view.getUint32(this.abs(entryOffset), true) !== nameOffset) continue;

      const lastOffset = entryDataStart + (count - 1) * 20;
      if (lastOffset !== entryOffset) {
        for (let byte = 0; byte < 20; byte += 4) {
          this.view.setUint32(this.abs(entryOffset + byte),
            this.view.getUint32(this.abs(lastOffset + byte), true), true);
        }
      }
      this.view.setUint32(absPointer + 4, count - 1, true);
      return true;
    }
    return false;
  }

  // scopeLookup, scopeKeys, getScopeEntries live on MemoryReader.

  // ===========================================================================
  // Closures
  // ===========================================================================

  /**
   * Create a function object.
   *
   * Function layout: [GC:8][prototype:4][count:4][capacity:4][flags:4][entries:4][sym_entries:4][start_instruction:4][end_instruction:4][scope:4][function_flags:4]
   *
   * @param {number} startInstruction - First instruction index of function body
   * @param {number} endInstruction - Instruction index after RETURN (for bounds)
   * @param {number} scopePointer - Captured scope pointer (lexical environment)
   * @param {number} functionFlags - Closure flags (0 = regular, CLOSURE_FLAG_ARROW = arrow function)
   * @returns {number} - Segment-relative pointer to function
   */
  createClosure(startInstruction, endInstruction, scopePointer, functionFlags = 0) {
    // Function = object fields (24 bytes) + closure data (16 bytes) = 40 bytes after GC header
    const dataPointer = this.allocate(40, OBJ.FUNCTION);
    const absPointer = this.abs(dataPointer);

    // Object header (data-relative): prototype=0, count=0, capacity=0, flags=0, entries=0, sym_entries=0
    this.view.setUint32(absPointer, 0, true);       // prototype (offset 0)
    this.view.setUint32(absPointer + 4, 0, true);   // count (offset 4)
    this.view.setUint32(absPointer + 8, 0, true);   // capacity (offset 8)
    this.view.setUint32(absPointer + 12, 0, true);  // flags (offset 12)
    this.view.setUint32(absPointer + 16, 0, true);  // entries (offset 16)
    this.view.setUint32(absPointer + 20, 0, true);  // sym_entries (offset 20)

    // Closure data at offset 24 from data pointer
    this.view.setUint32(absPointer + 24, startInstruction, true);
    this.view.setUint32(absPointer + 28, endInstruction, true);
    this.view.setUint32(absPointer + 32, scopePointer, true);
    this.view.setUint32(absPointer + 36, functionFlags, true);

    // The closure captures its scope chain — exclude it from the
    // interpreter's scope recycling cache (mirrors MAKE_CLOSURE).
    this.markScopeCaptured(scopePointer);

    // Return header pointer (for consistency with TYPE_FUNCTION values)
    return dataPointer - GC_HEADER_SIZE;
  }

  // getClosure, isArrowClosure, isAsyncClosure live on MemoryReader.

  /**
   * Set the async flag on a closure.
   *
   * @param {number} closurePointer - Segment-relative pointer to closure
   * @param {boolean} isAsync - Whether the closure is async
   */
  setClosureAsync(closurePointer, isAsync) {
    const absPointer = this.abs(closurePointer);
    let functionFlags = this.view.getUint32(absPointer + FUNCTION.FUNCTION_FLAGS, true);
    if (isAsync) {
      functionFlags |= CLOSURE_FLAG_ASYNC;
    } else {
      functionFlags &= ~CLOSURE_FLAG_ASYNC;
    }
    this.view.setUint32(absPointer + FUNCTION.FUNCTION_FLAGS, functionFlags, true);
  }

  /**
   * Write a closure value at an address.
   *
   * @param {number} addr - Segment-relative address
   * @param {number} closurePointer - Segment-relative pointer to closure
   */
  writeClosure(addr, closurePointer) {
    const absAddr = this.abs(addr);
    this.view.setUint32(absAddr, TYPE.FUNCTION, true);
    this.view.setUint32(absAddr + 4, 0, true);
    this.view.setBigInt64(absAddr + 8, BigInt(closurePointer), true);
  }

  // ===========================================================================
  // Bound Methods
  // ===========================================================================

  /**
   * Write a bound method value at an address.
   *
   * Bound method value layout (16 bytes):
   *   [type: 4][receiver: 4][method_id_or_closure: 4][flags: 4]
   *
   * Flags:
   *   0 = built-in method (method_id_or_closure is METHOD.* constant)
   *   1 = user function (method_id_or_closure is closure pointer)
   *
   * @param {number} addr - Segment-relative address
   * @param {number} receiverPointer - Segment-relative pointer to receiver object
   * @param {number} methodIdOrClosure - Method ID (built-in) or closure pointer (user)
   * @param {number} flags - 0 for built-in, 1 for user function
   */
  writeBoundMethod(addr, receiverPointer, methodIdOrClosure, flags = 0) {
    const absAddr = this.abs(addr);
    this.view.setUint32(absAddr, TYPE.BOUND_METHOD, true);
    this.view.setUint32(absAddr + 4, receiverPointer, true);
    this.view.setUint32(absAddr + 8, methodIdOrClosure, true);
    this.view.setUint32(absAddr + 12, flags, true);
  }

  // readBoundMethod lives on MemoryReader.

  // ===========================================================================
  // External / Error Regions
  // ===========================================================================

  // getExternalRequest lives on MemoryReader.

  // unmarshalArgs lives on MemoryReader.

  /**
   * Marshal a result value and push it to the pending stack.
   *
   * marshalResult is the common entry point for airlock-side
   * marshalling (resumeWithValue, extractResultFromContext callers,
   * etc.). It can recurse into the heap allocator for arrays, objects,
   * or bigints, any of which may throw HeapPressureSignal if the
   * boundary is hit mid-walk.
   *
   * Rollback model: take a checkpoint of STATE_HEAP_POINTER on entry.
   * If writeValueAt throws HeapPressureSignal, rewind the heap pointer
   * to the checkpoint and re-throw. Any partial allocations the walk
   * managed to perform become orphan heap regions in the rolled-back
   * range; nothing references them (the destination pending slot was
   * never finalized — we still own its 16 bytes, and we never advanced
   * setContextPendingPointer), so discarding them is safe and the
   * retry will re-allocate from a clean heap.
   *
   * @param {number} slot - Context slot
   * @param {*} jsValue - JS value to marshal
   * @param {Object} options - Optional callbacks (passed to writeValueAt)
   * @throws {HeapPressureSignal} if heap pressure prevents marshalling.
   *   The caller (typically airlock.resumeWithValue) should treat this
   *   as a signal to gc + retry; the heap has been rewound and the
   *   pending pointer has NOT advanced.
   */
  marshalResult(slot, jsValue, options = {}) {
    const pendingPointer = this.getContextPendingPointer(slot);
    const heapCheckpoint = this.getHeapPointer();
    try {
      this.writeValueAt(pendingPointer, jsValue, options);
      this.setContextPendingPointer(slot, pendingPointer + VALUE_SIZE);
    } catch (e) {
      if (e instanceof HeapPressureSignal) {
        this.setHeapPointer(heapCheckpoint);
      }
      throw e;
    }
  }

  /**
   * Create an error object with the given prototype and message,
   * and push it to the pending stack for throwing.
   *
   * @param {number} slot - Context slot
   * @param {number} prototypeStateOffset - STATE offset for the error prototype (e.g., STATE.GRANT_DENIED_ERROR_PROTOTYPE)
   * @param {string} message - Error message
   * @param {object} [properties] - Additional enumerable error fields
   */
  createAndPushError(slot, prototypeStateOffset, message, properties = {}) {
    const prototype = this.getState(prototypeStateOffset);

    const propertyKeys = Object.keys(properties)
      .filter((key) => key !== 'message');
    const objectPointer = this.allocateObject(1 + propertyKeys.length);
    this.setObjectPrototype(objectPointer, prototype);

    // Set message property
    const messageNameOffset = this.getBuiltinName(BUILTIN_NAME.MESSAGE);
    const messageValueOffset = this.internString(message);
    this.objectSetString(objectPointer, messageNameOffset, messageValueOffset);
    for (const key of propertyKeys) {
      this.objectSetByMarshal(objectPointer, key, properties[key]);
    }

    // Push error object to pending stack
    const pendingPointer = this.getContextPendingPointer(slot);
    this.view.setUint32(this.abs(pendingPointer), TYPE.OBJECT, true);
    this.view.setUint32(this.abs(pendingPointer + 4), 0, true);
    this.view.setUint32(this.abs(pendingPointer + 8), objectPointer, true);
    this.view.setUint32(this.abs(pendingPointer + 12), 0, true);
    this.setContextPendingPointer(slot, pendingPointer + VALUE_SIZE);
  }

  /**
   * Write a TYPE_EXTERNAL value to a 16-byte value slot.
   *
   * @param {number} destinationPointer - Segment-relative pointer to value slot
   * @param {number} handleId - External handle ID
   * @param {number} [version] - Handle slot version used to reject
   *   stale handles. 0 means "unversioned/legacy — dispatch skips the
   *   stale-handle check for this value." A live handle's version is
   *   always >= 1 (register() increments from the slot's prior value
   *   before handing it out), so 0 is a safe, unambiguous sentinel.
   *   Defaults to 0 for the rare caller that does not have a version
   *   yet; declareExternal, the only current caller, always has one.
   */
  writeExternal(destinationPointer, handleId, version = 0) {
    const absolutePointer = this.abs(destinationPointer);
    this.view.setUint32(absolutePointer, TYPE.EXTERNAL, true);
    this.view.setUint32(absolutePointer + 4, 0, true);
    this.view.setUint32(absolutePointer + 8, handleId, true);
    this.view.setUint32(absolutePointer + 12, version, true);
  }

  /**
   * Declare an external handle in global scope.
   *
   * @param {string} name - Variable name
   * @param {number} handleId - External handle ID
   * @param {number} [version] - Handle slot version, see writeExternal.
   *   Airlock.declare (the sole real caller) validates it against the
   *   live slot via unwrapHandle before reaching here. Thus every
   *   top-level capability-declared identifier (postMessage, setTimeout,
   *   box, landing, ...) carries a real version, and a reused handle
   *   slot cannot be mistaken for the original capability. The version
   *   remains necessary even though declared globals normally live
   *   indefinitely: future callers may use declareExternal for values
   *   whose handles can go stale.
   */
  declareExternal(name, handleId, version = 0) {
    const nameOffset = this.internString(name);
    const scratchBase = this.scratchPointerChecked(0, VALUE_SIZE);
    this.writeExternal(scratchBase, handleId, version);
    // Declare into root scope
    const rootScope = this.getRootScope();
    this.scopeDefine(rootScope, nameOffset, scratchBase);
  }

  // getErrorInfo lives on MemoryReader.

  /**
   * Set error info.
   *
   * @param {number} code - Error code
   * @param {number} detail - Error detail (optional, defaults to 0)
   */
  setError(code, detail = 0) {
    const offset = this.abs(this.getErrorInfoBase());
    this.view.setUint32(offset, code, true);
    this.view.setUint32(offset + 4, detail, true);
  }

  // ===========================================================================
  // Stats
  // ===========================================================================

  // heapUsage and stringUsage live on MemoryReader.

  // ===========================================================================
  // Built-in Object Initialization
  // ===========================================================================

  /**
   * Allocate an empty object on the heap.
   * Object layout: [GC:8][prototype:4][count:4][capacity:4][entries:4]
   * Entries layout: [GC:8][entries: capacity * ENTRY_SIZE]
   *
   * @param {number} initialCapacity - Initial entry capacity (default 8)
   * @param {number|null} internalBigintHeader - optional [[BigIntData]]
   * @returns {number} - Segment-relative pointer to object
   */
  allocateObject(initialCapacity = 8, internalBigintHeader = null) {
    // Object header: 32 bytes (GC:8 + prototype:4 + count:4 + capacity:4 + flags:4 + entries:4 + sym_entries:4)
    // Entries block: GC:8 + capacity * 20 bytes.
    //
    // The 32-byte header is already 16-byte aligned. The entries block must
    // also be 16-byte aligned so later heap objects start on the same
    // 16-byte grid that BigInt / Rational / Complex / Expression allocators
    // use.
    const objectHeaderAlignedSize =
      internalBigintHeader === null ? OBJECT_HEADER_SIZE : 48;
    const entrySize = 20;
    const entriesDataRawSize = GC_HEADER_SIZE + initialCapacity * entrySize;
    const entriesDataAlignedSize = (entriesDataRawSize + 15) & ~15;
    this._checkHeapBudget(objectHeaderAlignedSize + entriesDataAlignedSize);

    const heapPointer = this.getHeapPointer();
    const objectPointer = heapPointer;

    // Write GC header for object.
    const absoluteObjectPointer = this.abs(objectPointer);
    this.view.setUint32(absoluteObjectPointer, objectHeaderAlignedSize | (OBJ.OBJECT << 24), true);
    this.view.setUint32(absoluteObjectPointer + 4, 0, true); // GC flags

    // Entries block begins after the object header.
    const entriesPointer = objectPointer + objectHeaderAlignedSize;

    // Write GC header for entries (OBJ.ARRAY_DATA is used for object entries too)
    const absoluteEntriesPointer = this.abs(entriesPointer);
    // Note: WASM uses OBJ_OBJECT_DATA (7) for object entries, but constants.js uses ARRAY_DATA (5)
    // Let's use 7 to match WASM
    this.view.setUint32(absoluteEntriesPointer, entriesDataAlignedSize | (7 << 24), true);
    this.view.setUint32(absoluteEntriesPointer + 4, 0, true); // GC flags

    // Object header fields
    this.view.setUint32(absoluteObjectPointer + 8, 0, true);               // prototype = 0 (null prototype for now)
    this.view.setUint32(absoluteObjectPointer + 12, 0, true);              // count = 0
    this.view.setUint32(absoluteObjectPointer + 16, initialCapacity, true); // capacity
    this.view.setUint32(absoluteObjectPointer + 20, 0, true);              // flags = 0
    this.view.setUint32(absoluteObjectPointer + 24, entriesPointer, true); // entries
    this.view.setUint32(absoluteObjectPointer + 28, 0, true);              // sym_entries = 0 (lazy)
    if (internalBigintHeader !== null) {
      this.view.setUint32(absoluteObjectPointer + 32, internalBigintHeader, true);
      this.view.setUint32(absoluteObjectPointer + 36, 0, true);
      this.view.setUint32(absoluteObjectPointer + 40, 0, true);
      this.view.setUint32(absoluteObjectPointer + 44, 0, true);
    }

    // Update heap pointer using the aligned entries size.
    this.setHeapPointer(entriesPointer + entriesDataAlignedSize);

    return objectPointer;
  }

  /**
   * Set the prototype of an object (for testing prototype chain).
   * Object layout: [GC:8][prototype:4][count:4][capacity:4][flags:4][entries:4]
   *
   * @param {number} objectPointer - Object header pointer
   * @param {number} prototypePointer - Prototype object header pointer (or 0 for null)
   */
  setObjectPrototype(objectPointer, prototypePointer) {
    const absoluteObjectPointer = this.abs(objectPointer);
    // prototype is at offset +8 (after 8-byte GC header)
    this.view.setUint32(absoluteObjectPointer + 8, prototypePointer, true);
  }

  // getObjectPrototype, getObjectFlags live on MemoryReader.

  /**
   * Set the flags of an object.
   *
   * @param {number} objectPointer - Object header pointer
   * @param {number} flags - Object flags
   */
  setObjectFlags(objectPointer, flags) {
    const absoluteObjectPointer = this.abs(objectPointer);
    this.view.setUint32(absoluteObjectPointer + 20, flags, true);
  }

  /**
   * Set the FROZEN flag on an object.
   *
   * @param {number} objectPointer - Object header pointer
   */
  setObjectFrozen(objectPointer) {
    const flags = this.getObjectFlags(objectPointer);
    this.setObjectFlags(objectPointer, flags | OBJECT_FLAG.FROZEN);
  }

  // isObjectFrozen lives on MemoryReader.

  /**
   * Set a property on an object.
   * Entry layout: [key:4][type:4][flags:4][data_lo:4][data_hi:4]
   *
   * @param {number} objectPointer - Object pointer
   * @param {number} keyOffset - String table offset for key
   * @param {number} type - Value type
   * @param {number} dataLo - Lower 32 bits of value payload
   * @param {number} dataHi - Upper 32 bits of value payload
   */
  objectSetRaw(objectPointer, keyOffset, type, dataLo, dataHi) {
    const absoluteObjectPointer = this.abs(objectPointer);
    // Object layout: [GC:8][prototype:4][count:4][capacity:4][flags:4][entries:4][sym_entries:4]
    const count = this.view.getUint32(absoluteObjectPointer + 12, true);
    const capacity = this.view.getUint32(absoluteObjectPointer + 16, true);
    const entriesPointer = this.view.getUint32(absoluteObjectPointer + 24, true);
    const entrySize = 20;

    if (count >= capacity) {
      throw new Error(`Object capacity exceeded: ${count} >= ${capacity}`);
    }

    // Entry at index = count
    const entryPointer = entriesPointer + GC_HEADER_SIZE + count * entrySize;
    const absoluteEntryPointer = this.abs(entryPointer);

    this.view.setUint32(absoluteEntryPointer, keyOffset, true);       // key
    this.view.setUint32(absoluteEntryPointer + 4, type, true);        // type
    this.view.setUint32(absoluteEntryPointer + 8, 0, true);           // flags
    this.view.setUint32(absoluteEntryPointer + 12, dataLo, true);     // data_lo
    this.view.setUint32(absoluteEntryPointer + 16, dataHi, true);     // data_hi

    // Increment count
    this.view.setUint32(absoluteObjectPointer + 12, count + 1, true);
  }

  /**
   * extends-externals D3: grow an object's entries block so at least
   * `needed` more entries fit. Mirrors the WAT $object_set_property
   * grow: allocate a doubled OBJECT_DATA block, copy the live entries,
   * repoint the object. The old block becomes garbage for the next GC.
   */
  objectEnsureEntryCapacity(objectPointer, needed) {
    const absoluteObjectPointer = this.abs(objectPointer);
    const count = this.view.getUint32(absoluteObjectPointer + 12, true);
    const capacity = this.view.getUint32(absoluteObjectPointer + 16, true);
    if (count + needed <= capacity) return;
    const entrySize = 20;
    let newCapacity = capacity === 0 ? 4 : capacity * 2;
    while (newCapacity < count + needed) newCapacity *= 2;
    const oldEntriesPointer = this.view.getUint32(absoluteObjectPointer + 24, true);
    const newEntriesPointer = this.allocate(
      GC_HEADER_SIZE + newCapacity * entrySize, OBJ.OBJECT_DATA);
    this.u8.copyWithin(
      this.abs(newEntriesPointer + GC_HEADER_SIZE),
      this.abs(oldEntriesPointer + GC_HEADER_SIZE),
      this.abs(oldEntriesPointer + GC_HEADER_SIZE + count * entrySize));
    this.view.setUint32(absoluteObjectPointer + 16, newCapacity, true);
    this.view.setUint32(absoluteObjectPointer + 24, newEntriesPointer, true);
  }

  /**
   * extends-externals D3: brand a receiver as external-backed. Writes
   * the hidden own entries the construction protocol depends on:
   *
   *   @externalBacking  — TYPE_EXTERNAL (lo = backing slot, hi =
   *     backing version); the entry's FLAGS word carries the parent
   *     handle slot + 1, so completion/abort can name the registration
   *     without any transient host state.
   *   @constructionLink — TYPE_UNDEFINED; the abort-duty chain slot,
   *     pre-allocated here so the throw-unwind walk never allocates.
   *
   * Then sets EXTERNAL_BACKED | CONSTRUCTION_PENDING on the object.
   */
  brandExternalBackedReceiver(objectPointer, backingSlot, backingVersion, parentSlot) {
    this.objectEnsureEntryCapacity(objectPointer, 2);
    const absoluteObjectPointer = this.abs(objectPointer);
    const count = this.view.getUint32(absoluteObjectPointer + 12, true);
    const entriesPointer = this.view.getUint32(absoluteObjectPointer + 24, true);
    const entrySize = 20;

    let entry = this.abs(entriesPointer + GC_HEADER_SIZE + count * entrySize);
    this.view.setUint32(entry, this.getBuiltinName(BUILTIN_NAME.EXTERNAL_BACKING), true);
    this.view.setUint32(entry + 4, TYPE.EXTERNAL, true);
    this.view.setUint32(entry + 8, parentSlot + 1, true);
    this.view.setUint32(entry + 12, backingSlot, true);
    this.view.setUint32(entry + 16, backingVersion, true);

    entry += entrySize;
    this.view.setUint32(entry, this.getBuiltinName(BUILTIN_NAME.CONSTRUCTION_LINK), true);
    this.view.setUint32(entry + 4, TYPE.UNDEFINED, true);
    this.view.setUint32(entry + 8, 0, true);
    this.view.setUint32(entry + 12, 0, true);
    this.view.setUint32(entry + 16, 0, true);

    this.view.setUint32(absoluteObjectPointer + 12, count + 2, true);
    this.setObjectFlags(objectPointer,
      this.getObjectFlags(objectPointer)
      | OBJECT_FLAG.EXTERNAL_BACKED | OBJECT_FLAG.CONSTRUCTION_PENDING);
  }

  /**
   * Allocate a symbol-entries block.
   *
   * Layout: [GC:8][sym_count:4][sym_capacity:4][entries...] where each entry
   * is 20 bytes: [symbolHeaderPointer:4][type:4][flags:4][data_lo:4][data_hi:4].
   *
   * @param {number} capacity - Number of slots
   * @returns {number} Header pointer to the block
   */
  allocateSymEntriesBlock(capacity) {
    const dataSize = 8 + capacity * 20;  // count(4) + capacity(4) + entries
    const totalSize = GC_HEADER_SIZE + dataSize;
    const aligned = (totalSize + 15) & ~15;
    this._checkHeapBudget(aligned);

    const headerPointer = this.getHeapPointer();
    const absHeader = this.abs(headerPointer);
    // Match WAT's object-entries GC type tag (OBJ.OBJECT_DATA = 7).
    this.view.setUint32(absHeader, aligned | (OBJ.OBJECT_DATA << 24), true);
    this.view.setUint32(absHeader + 4, 0, true);  // GC flags

    const absData = absHeader + GC_HEADER_SIZE;
    this.view.setUint32(absData, 0, true);        // sym_count = 0
    this.view.setUint32(absData + 4, capacity, true);

    this.setHeapPointer(headerPointer + aligned);
    return headerPointer;
  }

  /**
   * Set a symbol-keyed property on an object.
   * Allocates the symbol-entries block lazily on first use.
   *
   * For bootstrap use: the caller is responsible for ensuring enough
   * initial capacity. Throws if capacity is exceeded.
   *
   * @param {number} objectPointer - Object header pointer
   * @param {number} symbolPointer - Symbol header pointer (used as the key)
   * @param {number} type - Value type tag
   * @param {number} dataLo - Lower 32 bits of value payload
   * @param {number} dataHi - Upper 32 bits of value payload
   * @param {number} initialCapacity - Capacity if block must be allocated
   */
  objectSetSymbolKey(objectPointer, symbolPointer, type, dataLo, dataHi, initialCapacity = 4) {
    const absoluteObjectPointer = this.abs(objectPointer);
    let symEntriesHeaderPointer = this.view.getUint32(absoluteObjectPointer + 28, true);

    if (symEntriesHeaderPointer === 0) {
      symEntriesHeaderPointer = this.allocateSymEntriesBlock(initialCapacity);
      this.view.setUint32(absoluteObjectPointer + 28, symEntriesHeaderPointer, true);
    }

    const absSymEntries = this.abs(symEntriesHeaderPointer + GC_HEADER_SIZE);
    const symCount = this.view.getUint32(absSymEntries, true);
    const symCapacity = this.view.getUint32(absSymEntries + 4, true);
    const entryStride = 20;

    // Search for existing entry by symbol-pointer equality.
    for (let i = 0; i < symCount; i++) {
      const entryAbs = absSymEntries + 8 + i * entryStride;
      const entryKey = this.view.getUint32(entryAbs, true);
      if (entryKey === symbolPointer) {
        this.view.setUint32(entryAbs + 4, type, true);
        this.view.setUint32(entryAbs + 8, 0, true);
        this.view.setUint32(entryAbs + 12, dataLo, true);
        this.view.setUint32(entryAbs + 16, dataHi, true);
        return;
      }
    }

    if (symCount >= symCapacity) {
      throw new Error(`Symbol-entries capacity exceeded: ${symCount} >= ${symCapacity}`);
    }

    const entryAbs = absSymEntries + 8 + symCount * entryStride;
    this.view.setUint32(entryAbs, symbolPointer, true);
    this.view.setUint32(entryAbs + 4, type, true);
    this.view.setUint32(entryAbs + 8, 0, true);
    this.view.setUint32(entryAbs + 12, dataLo, true);
    this.view.setUint32(entryAbs + 16, dataHi, true);
    this.view.setUint32(absSymEntries, symCount + 1, true);
  }

  /**
   * Read a symbol-keyed property from an object's own table (no prototype walk).
   *
   * @param {number} objectPointer - Object header pointer
   * @param {number} symbolPointer - Symbol header pointer (key)
   * @returns {{type: number, flags: number, dataLo: number, dataHi: number} | null}
   */
  objectGetSymbolKey(objectPointer, symbolPointer) {
    const absoluteObjectPointer = this.abs(objectPointer);
    const symEntriesHeaderPointer = this.view.getUint32(absoluteObjectPointer + 28, true);
    if (symEntriesHeaderPointer === 0) return null;

    const absSymEntries = this.abs(symEntriesHeaderPointer + GC_HEADER_SIZE);
    const symCount = this.view.getUint32(absSymEntries, true);
    for (let i = 0; i < symCount; i++) {
      const entryAbs = absSymEntries + 8 + i * 20;
      if (this.view.getUint32(entryAbs, true) === symbolPointer) {
        return {
          type: this.view.getUint32(entryAbs + 4, true),
          flags: this.view.getUint32(entryAbs + 8, true),
          dataLo: this.view.getUint32(entryAbs + 12, true),
          dataHi: this.view.getUint32(entryAbs + 16, true),
        };
      }
    }
    return null;
  }

  /**
   * Set a float property on an object.
   *
   * @param {number} objectPointer - Object pointer
   * @param {number} keyOffset - String table offset for key
   * @param {number} value - Float value
   */
  objectSetFloat(objectPointer, keyOffset, value) {
    const buffer = new ArrayBuffer(8);
    const f64 = new Float64Array(buffer);
    const u32 = new Uint32Array(buffer);
    f64[0] = value;
    this.objectSetRaw(objectPointer, keyOffset, TYPE.FLOAT, u32[0], u32[1]);
  }

  /**
   * Set a string property on an object using a string table offset.
   *
   * @param {number} objectPointer - Object pointer
   * @param {number} keyOffset - String table offset for key
   * @param {number} valueOffset - String table offset for value
   */
  objectSetString(objectPointer, keyOffset, valueOffset) {
    this.objectSetRaw(objectPointer, keyOffset, TYPE.STRING, valueOffset, 0);
  }

  /**
   * Set a bound method property on an object.
   *
   * @param {number} objectPointer - Object pointer
   * @param {number} keyOffset - String table offset for key
   * @param {number} receiverPointer - Receiver object pointer
   * @param {number} methodId - Method ID from METHOD constants
   */
  /**
   * Append a property with an explicit value FLAGS word (objectSetRaw
   * zeroes flags, which destroys FLAG_RATIONAL_INLINE and friends —
   * generator step objects carry arbitrary user values).
   */
  objectSetRawWithFlags(objectPointer, keyOffset, type, flags, dataLo, dataHi) {
    this.objectSetRaw(objectPointer, keyOffset, type, dataLo, dataHi);
    const absoluteObjectPointer = this.abs(objectPointer);
    const count = this.view.getUint32(absoluteObjectPointer + 12, true);
    const entriesPointer = this.view.getUint32(absoluteObjectPointer + 24, true);
    const entryPointer = this.abs(entriesPointer + GC_HEADER_SIZE + (count - 1) * 20);
    this.view.setUint32(entryPointer + 8, flags, true);
  }

  /**
   * Find an OWN string-keyed property entry. Returns the decoded value
   * or null. (Generators: the airlock reads @generatorContext /
   * @generatorState / @generatorCaller off generator objects.)
   * @param {number} objectPointer - Object header pointer
   * @param {number} keyOffset - Interned key id
   * @returns {{type: number, flags: number, lo: number, hi: number} | null}
   */
  objectFindOwnProperty(objectPointer, keyOffset) {
    const absoluteObjectPointer = this.abs(objectPointer);
    const count = this.view.getUint32(absoluteObjectPointer + 12, true);
    const entriesPointer = this.view.getUint32(absoluteObjectPointer + 24, true);
    for (let i = 0; i < count; i++) {
      const entryPointer = this.abs(entriesPointer + GC_HEADER_SIZE + i * 20);
      if (this.view.getUint32(entryPointer, true) === keyOffset) {
        return {
          type: this.view.getUint32(entryPointer + 4, true),
          flags: this.view.getUint32(entryPointer + 8, true),
          lo: this.view.getUint32(entryPointer + 12, true),
          hi: this.view.getUint32(entryPointer + 16, true),
        };
      }
    }
    return null;
  }

  /**
   * Overwrite an existing OWN property's value in place. Throws if the
   * key is absent (callers own the object shape).
   * @param {number} objectPointer - Object header pointer
   * @param {number} keyOffset - Interned key id
   */
  objectUpdateProperty(objectPointer, keyOffset, type, dataLo, dataHi) {
    const absoluteObjectPointer = this.abs(objectPointer);
    const count = this.view.getUint32(absoluteObjectPointer + 12, true);
    const entriesPointer = this.view.getUint32(absoluteObjectPointer + 24, true);
    for (let i = 0; i < count; i++) {
      const entryPointer = this.abs(entriesPointer + GC_HEADER_SIZE + i * 20);
      if (this.view.getUint32(entryPointer, true) === keyOffset) {
        this.view.setUint32(entryPointer + 4, type, true);
        this.view.setUint32(entryPointer + 12, dataLo, true);
        this.view.setUint32(entryPointer + 16, dataHi, true);
        return;
      }
    }
    throw new Error('objectUpdateProperty: key not present');
  }

  /**
   * Bound method whose entry carries the receiver TYPE in the flags
   * word — the convention CALL_METHOD's dispatch reads. Own-entry
   * methods on concrete objects (generator objects) need it; prototype
   * entries don't (their receiver is rebound at lookup).
   */
  objectSetBoundMethodWithReceiverType(objectPointer, keyOffset, receiverPointer, methodId, receiverType) {
    this.objectSetRaw(objectPointer, keyOffset, TYPE.BOUND_METHOD, receiverPointer, methodId);
    // objectSetRaw wrote flags=0 into the just-appended entry; stamp the
    // receiver type over it.
    const absoluteObjectPointer = this.abs(objectPointer);
    const count = this.view.getUint32(absoluteObjectPointer + 12, true);
    const entriesPointer = this.view.getUint32(absoluteObjectPointer + 24, true);
    const entryPointer = this.abs(entriesPointer + GC_HEADER_SIZE + (count - 1) * 20);
    this.view.setUint32(entryPointer + 8, receiverType, true);
  }

  objectSetBoundMethod(objectPointer, keyOffset, receiverPointer, methodId) {
    // BOUND_METHOD in an object entry: data_lo = receiver pointer,
    // data_hi = method id as a full u32 (no bit packing; the builtin
    // dispatch table bound is the only limit on method-id range).
    this.objectSetRaw(objectPointer, keyOffset, TYPE.BOUND_METHOD, receiverPointer, methodId);
  }

  /**
   * Set a property on an object from a value pointer.
   *
   * @param {number} objectPointer - Object pointer
   * @param {number} keyOffset - String table offset for key
   * @param {number} valuePointer - Pointer to 16-byte value
   */
  objectSetFromPointer(objectPointer, keyOffset, valuePointer) {
    const absoluteValuePointer = this.abs(valuePointer);
    const type = this.view.getUint32(absoluteValuePointer, true);
    const dataLo = this.view.getUint32(absoluteValuePointer + 8, true);
    const dataHi = this.view.getUint32(absoluteValuePointer + 12, true);
    this.objectSetRaw(objectPointer, keyOffset, type, dataLo, dataHi);
  }

  /**
   * Allocate an empty array on the heap.
   * Array layout: [GC:8][length:4][capacity:4][data:4][flags:4][sym_entries:4]
   * Data layout: [GC:8][elements: capacity * 16]
   *
   * @param {number} initialCapacity - Initial capacity
   * @returns {number} - Segment-relative pointer to array header
   */
  allocateArrayWithCapacity(initialCapacity) {
    // Array header: 28 bytes (GC:8 + length:4 + capacity:4 + data:4 + flags:4 + sym_entries:4)
    const arrayHeaderSize = ARRAY_HEADER_SIZE;
    const arrayDataSize = GC_HEADER_SIZE + initialCapacity * VALUE_SIZE;
    this._checkHeapBudget(arrayHeaderSize + arrayDataSize);

    const heapPointer = this.getHeapPointer();
    const arrayPointer = heapPointer;

    // Write GC header for array
    const absoluteArrayPointer = this.abs(arrayPointer);
    this.view.setUint32(absoluteArrayPointer, arrayHeaderSize | (OBJ.ARRAY << 24), true);
    this.view.setUint32(absoluteArrayPointer + 4, 0, true); // GC flags

    // Data block: GC:8 + capacity * 16 ($arrayDataSize computed above
    // for the pressure pre-check; reuse it here).
    const dataPointer = arrayPointer + arrayHeaderSize;
    const dataSize = arrayDataSize;

    // Write GC header for data
    const absoluteDataPointer = this.abs(dataPointer);
    this.view.setUint32(absoluteDataPointer, dataSize | (OBJ.ARRAY_DATA << 24), true);
    this.view.setUint32(absoluteDataPointer + 4, 0, true); // GC flags

    // Array header fields
    this.view.setUint32(absoluteArrayPointer + ARRAY.LENGTH, 0, true);
    this.view.setUint32(absoluteArrayPointer + ARRAY.CAPACITY, initialCapacity, true);
    this.view.setUint32(absoluteArrayPointer + ARRAY.DATA_POINTER, dataPointer, true);
    this.view.setUint32(absoluteArrayPointer + ARRAY.FLAGS, 0, true);
    this.view.setUint32(absoluteArrayPointer + ARRAY.SYM_ENTRIES, 0, true);

    // Update heap pointer
    this.setHeapPointer(dataPointer + dataSize);

    return arrayPointer;
  }

  /**
   * Allocate a Map (or Set) header + GC-headered entries block, returning the
   * header pointer. Modeled on allocateArrayWithCapacity: header struct +
   * separate data block, placed contiguously, header words carry the actual
   * (unaligned) byte size so the GC heap walk can step over them.
   *
   * The header is `[GC:8][size:4][slotCount:4][capacity:4][entriesPtr:4]
   * [sym_entries:4]` (28 bytes total). `size`/`slotCount` start at 0 and are
   * bumped per written slot by the marshaller — the collector walks only
   * `[0, slotCount)`, so the unwritten slot tail is never read and does NOT
   * need zeroing. `sym_entries` IS zeroed because the collector follows it
   * whenever it is non-zero.
   *
   * @param {number} capacity - Number of slots to allocate in the entries block
   * @param {number} objType - OBJ.MAP or OBJ.SET (header)
   * @param {number} entriesObjType - OBJ.MAP_ENTRIES or OBJ.SET_ENTRIES
   * @param {number} slotStride - 36 (Map) or 20 (Set)
   * @param {Object} layout - MAP_LAYOUT or SET_LAYOUT (header field offsets)
   * @returns {number} - Segment-relative header pointer
   */
  allocateCollection(capacity, objType, entriesObjType, slotStride, layout) {
    // Header: GC:8 + size:4 + slotCount:4 + capacity:4 + entriesPtr:4 + sym:4
    const headerSize = GC_HEADER_SIZE + MAP_HEADER_DATA_SIZE;
    const entriesDataSize = GC_HEADER_SIZE + capacity * slotStride;
    this._checkHeapBudget(headerSize + entriesDataSize);

    const headerPointer = this.getHeapPointer();
    const absHeader = this.abs(headerPointer);
    this.view.setUint32(absHeader, headerSize | (objType << 24), true);
    this.view.setUint32(absHeader + 4, 0, true);  // GC flags

    // Entries block immediately follows the header.
    const entriesPointer = headerPointer + headerSize;
    const absEntries = this.abs(entriesPointer);
    this.view.setUint32(absEntries, entriesDataSize | (entriesObjType << 24), true);
    this.view.setUint32(absEntries + 4, 0, true);  // GC flags

    // Header fields. size/slotCount start 0 (marshaller bumps them); the
    // slot body is intentionally left unwritten (see doc comment).
    this.view.setUint32(absHeader + layout.SIZE, 0, true);
    this.view.setUint32(absHeader + layout.SLOT_COUNT, 0, true);
    this.view.setUint32(absHeader + layout.CAPACITY, capacity, true);
    this.view.setUint32(absHeader + layout.ENTRIES_PTR, entriesPointer, true);
    this.view.setUint32(absHeader + layout.SYM_ENTRIES, 0, true);

    this.setHeapPointer(entriesPointer + entriesDataSize);
    return headerPointer;
  }

  /** Allocate an empty Map with the given slot capacity. */
  allocateMap(capacity) {
    return this.allocateCollection(
      capacity, OBJ.MAP, OBJ.MAP_ENTRIES, MAP_LAYOUT.SLOT_STRIDE, MAP_LAYOUT);
  }

  /** Allocate an empty Set with the given slot capacity. */
  allocateSet(capacity) {
    return this.allocateCollection(
      capacity, OBJ.SET, OBJ.SET_ENTRIES, SET_LAYOUT.SLOT_STRIDE, SET_LAYOUT);
  }

  /**
   * Marshal a JS Map to a heap Map, returning the header pointer. Keys are
   * already unique (JS Map invariant), so slots are written linearly/
   * append-only with tombstone=0 and no probe/dedup — consistent with the
   * WAT linear scan (map_find_slot). slotCount/size are bumped AFTER each
   * slot is fully written, so the GC never walks an unwritten slot even if a
   * nested writeValueAt triggers a pressure throw mid-build.
   *
   * @param {Map} jsMap - JS Map to marshal
   * @param {Object} options - passed to writeValueAt for nested key/values
   * @returns {number} - Segment-relative header pointer
   */
  marshalMap(jsMap, options = {}) {
    const headerPointer = this.allocateMap(jsMap.size);
    let i = 0;
    for (const [key, value] of jsMap) {
      // Re-read entriesPointer each iteration: a nested writeValueAt may
      // allocate, and although the JS bump allocator never relocates a prior
      // block, re-reading matches arraySetByMarshal and is robust to any
      // future GC-during-marshal. abs() is re-derived per write below.
      const entriesPointer = this.view.getUint32(
        this.abs(headerPointer) + MAP_LAYOUT.ENTRIES_PTR, true);
      const slotPointer = entriesPointer + GC_HEADER_SIZE + i * MAP_LAYOUT.SLOT_STRIDE;
      this.view.setUint32(this.abs(slotPointer + MAP_LAYOUT.SLOT_TOMBSTONE), 0, true);
      this.writeValueAt(slotPointer + MAP_LAYOUT.SLOT_KEY, key, options);
      this.writeValueAt(slotPointer + MAP_LAYOUT.SLOT_VALUE, value, options);
      // Slot fully written — now publish it to the GC's live count.
      i++;
      const absHeader = this.abs(headerPointer);
      this.view.setUint32(absHeader + MAP_LAYOUT.SLOT_COUNT, i, true);
      this.view.setUint32(absHeader + MAP_LAYOUT.SIZE, i, true);
    }
    return headerPointer;
  }

  /**
   * Marshal a JS Set to a heap Set. Analogous to marshalMap: one writeValueAt
   * per member into the value slot, slotCount/size bumped after each write.
   *
   * @param {Set} jsSet - JS Set to marshal
   * @param {Object} options - passed to writeValueAt for nested members
   * @returns {number} - Segment-relative header pointer
   */
  marshalSet(jsSet, options = {}) {
    const headerPointer = this.allocateSet(jsSet.size);
    let i = 0;
    for (const member of jsSet) {
      const entriesPointer = this.view.getUint32(
        this.abs(headerPointer) + SET_LAYOUT.ENTRIES_PTR, true);
      const slotPointer = entriesPointer + GC_HEADER_SIZE + i * SET_LAYOUT.SLOT_STRIDE;
      this.view.setUint32(this.abs(slotPointer + SET_LAYOUT.SLOT_TOMBSTONE), 0, true);
      this.writeValueAt(slotPointer + SET_LAYOUT.SLOT_VALUE, member, options);
      i++;
      const absHeader = this.abs(headerPointer);
      this.view.setUint32(absHeader + SET_LAYOUT.SLOT_COUNT, i, true);
      this.view.setUint32(absHeader + SET_LAYOUT.SIZE, i, true);
    }
    return headerPointer;
  }

  /**
   * Set an array element from a value pointer.
   *
   * @param {number} arrayPointer - Array pointer
   * @param {number} index - Element index
   * @param {number} valuePointer - Pointer to 16-byte value
   */
  arraySetFromPointer(arrayPointer, index, valuePointer) {
    const absoluteArrayPointer = this.abs(arrayPointer);
    const length = this.view.getUint32(absoluteArrayPointer + 8, true);
    const capacity = this.view.getUint32(absoluteArrayPointer + 12, true);
    const dataPointer = this.view.getUint32(absoluteArrayPointer + 16, true);

    if (index >= capacity) {
      throw new Error(`Array index out of capacity: ${index} >= ${capacity}`);
    }

    // Copy 16 bytes from valuePointer to array slot
    const destAddr = dataPointer + GC_HEADER_SIZE + index * 16;
    const absoluteValuePointer = this.abs(valuePointer);
    const absDestAddr = this.abs(destAddr);

    for (let i = 0; i < 16; i++) {
      this.u8[absDestAddr + i] = this.u8[absoluteValuePointer + i];
    }

    // Update length if necessary
    if (index >= length) {
      this.view.setUint32(absoluteArrayPointer + 8, index + 1, true);
    }
  }

  // ===========================================================================
  // ArrayBuffer / Uint8Array
  // ===========================================================================

  /**
   * Allocate an ArrayBuffer on the heap.
   * ArrayBuffer heap object layout: [GC:8][byteLength:4][bytes...]
   *
   * @param {number} byteLength - Number of bytes
   * @returns {number} - Data pointer (after GC header) to ArrayBuffer object
   */
  allocateArrayBuffer(byteLength) {
    if (!Number.isInteger(byteLength) || byteLength < 0 || byteLength > 0xffffffff) {
      throw new RangeError('Invalid ArrayBuffer byte length');
    }
    // Calculate total size: GC header + length field + bytes, aligned to 8
    const dataSize = 4 + byteLength;  // length field + bytes
    const totalSize = GC_HEADER_SIZE + dataSize;
    const alignedSize = Math.ceil(totalSize / 8) * 8;
    this._checkHeapBudget(alignedSize);

    // Allocate on heap
    const headerPointer = this.getHeapPointer();
    this.setHeapPointer(headerPointer + alignedSize);

    // Write GC header
    const absHeaderPointer = this.abs(headerPointer);
    const packedSize = alignedSize >= 0x01000000 ? 0 : alignedSize;
    this.view.setUint32(absHeaderPointer, packedSize | (OBJ.ARRAYBUFFER << 24), true);
    this.view.setUint32(absHeaderPointer + 4, 0, true);  // forwarding pointer

    // Write length
    const dataPointer = headerPointer + GC_HEADER_SIZE;
    this.view.setUint32(this.abs(dataPointer), byteLength, true);

    // Zero-initialize bytes (WASM memory is zeroed, but be explicit)
    const bytesStart = this.abs(dataPointer + 4);
    for (let i = 0; i < byteLength; i++) {
      this.u8[bytesStart + i] = 0;
    }

    return dataPointer;
  }

  // getArrayBufferByteLength, getArrayBufferBytesPointer live on MemoryReader.

  /**
   * Create an ArrayBuffer value on the pending stack.
   *
   * @param {number} slot - Context slot
   * @param {number} dataPointer - ArrayBuffer data pointer (after GC header)
   */
  pushArrayBufferValue(slot, dataPointer) {
    const pendingPointer = this.getContextPendingPointer(slot);
    this.view.setUint32(this.abs(pendingPointer), TYPE.ARRAYBUFFER, true);
    this.view.setUint32(this.abs(pendingPointer + 4), 0, true);          // flags
    this.view.setUint32(this.abs(pendingPointer + 8), dataPointer, true); // data_lo
    this.view.setUint32(this.abs(pendingPointer + 12), 0, true);         // data_hi
    this.setContextPendingPointer(slot, pendingPointer + VALUE_SIZE);
  }

  /**
   * Create a Uint8Array value on the pending stack.
   * Layout: [type=UINT8ARRAY][flags=bufferDataPointer][data_lo=byteOffset][data_hi=length]
   *
   * @param {number} slot - Context slot
   * @param {number} bufferDataPointer - ArrayBuffer data pointer (after GC header)
   * @param {number} byteOffset - Offset into buffer
   * @param {number} length - Number of elements
   */
  pushUint8ArrayValue(slot, bufferDataPointer, byteOffset, length) {
    // Allocate descriptor: [bufferPtr:4][byteOffset:4][length:4]
    const descriptorPtr = this.allocateTypedArrayDescriptor(bufferDataPointer, byteOffset, length);

    const pendingPointer = this.getContextPendingPointer(slot);
    this.view.setUint32(this.abs(pendingPointer), TYPE.UINT8ARRAY, true);
    this.view.setUint32(this.abs(pendingPointer + 4), 0, true);                 // flags = 0 (free for scope flags)
    this.view.setUint32(this.abs(pendingPointer + 8), descriptorPtr, true);    // data_lo = descriptor pointer
    this.view.setUint32(this.abs(pendingPointer + 12), 0, true);               // data_hi = 0 (unused)
    this.setContextPendingPointer(slot, pendingPointer + VALUE_SIZE);
  }

  /**
   * Allocate a TypedArray descriptor on the heap.
   *
   * Layout: [GC:8][bufferPtr:4][byteOffset:4][length:4][sym_entries:4] = 24 bytes
   *
   * @param {number} bufferDataPointer - ArrayBuffer data pointer
   * @param {number} byteOffset - View's byte offset
   * @param {number} length - Number of elements
   * @returns {number} - Descriptor data pointer (after GC header)
   */
  allocateTypedArrayDescriptor(bufferDataPointer, byteOffset, length) {
    const dataPointer = this.allocate(16, OBJ.TYPED_ARRAY_DESCRIPTOR);  // 16 bytes of data

    // Write descriptor fields
    this.view.setUint32(this.abs(dataPointer), bufferDataPointer, true);
    this.view.setUint32(this.abs(dataPointer + 4), byteOffset, true);
    this.view.setUint32(this.abs(dataPointer + 8), length, true);
    this.view.setUint32(this.abs(dataPointer + TYPED_ARRAY_SYM_ENTRIES_OFFSET), 0, true);  // sym_entries = 0

    return dataPointer;
  }

  // readUint8ArrayElement lives on MemoryReader.

  /**
   * Write byte to Uint8Array.
   *
   * @param {number} bufferDataPointer - ArrayBuffer data pointer (after GC header)
   * @param {number} byteOffset - View's byte offset
   * @param {number} index - Element index
   * @param {number} value - Byte value (will be wrapped to 0-255)
   * @returns {boolean} - true if written, false if out of bounds
   */
  writeUint8ArrayElement(bufferDataPointer, byteOffset, index, value) {
    const bufferLength = this.view.getUint32(this.abs(bufferDataPointer), true);
    const absoluteIndex = byteOffset + index;
    if (absoluteIndex < 0 || absoluteIndex >= bufferLength) {
      return false;  // Out of bounds, silent no-op
    }
    const bytesStart = this.abs(bufferDataPointer + 4);
    this.u8[bytesStart + absoluteIndex] = value & 0xFF;
    return true;
  }

  /**
   * Write a TYPE_CONSTRUCTOR value.
   * Layout: [type=CONSTRUCTOR][padding][object_ptr][method_id]
   *
   * @param {number} addr - Segment-relative address
   * @param {number} objectPointer - Pointer to object with static methods
   * @param {number} methodId - Method ID for call/new dispatch
   */
  writeConstructor(addr, objectPointer, methodId) {
    const absAddr = this.abs(addr);
    this.view.setUint32(absAddr, TYPE.CONSTRUCTOR, true);
    this.view.setUint32(absAddr + 4, 0, true);  // padding
    this.view.setUint32(absAddr + 8, objectPointer, true);
    this.view.setUint32(absAddr + 12, methodId, true);
  }

  /**
   * Set a value in a scope.
   *
   * @param {number} scopePointer - Scope data pointer (after GC header)
   * @param {number} keyOffset - String table offset for key
   * @param {number} type - Value type
   * @param {number} dataLo - Lower 32 bits of value payload
   * @param {number} dataHi - Upper 32 bits of value payload
   */
  scopeSetRaw(scopePointer, keyOffset, type, dataLo, dataHi) {
    // Scope uses the same entry format as objects
    // Scope data layout (scopePointer points AFTER GC header):
    //   [parent:4][count:4][capacity:4][entries:4]
    const absoluteScopePointer = this.abs(scopePointer);
    const count = this.view.getUint32(absoluteScopePointer + 4, true);
    const capacity = this.view.getUint32(absoluteScopePointer + 8, true);
    const entriesPointer = this.view.getUint32(absoluteScopePointer + 12, true);

    if (count >= capacity) {
      throw new Error(`Scope capacity exceeded: ${count} >= ${capacity}`);
    }

    // Entry at index = count (entries points to GC header of entries block)
    const entryPointer = entriesPointer + GC_HEADER_SIZE + count * 20;
    const absoluteEntryPointer = this.abs(entryPointer);

    this.view.setUint32(absoluteEntryPointer, keyOffset, true);       // key
    this.view.setUint32(absoluteEntryPointer + 4, type, true);        // type
    this.view.setUint32(absoluteEntryPointer + 8, 0, true);           // flags
    this.view.setUint32(absoluteEntryPointer + 12, dataLo, true);     // data_lo
    this.view.setUint32(absoluteEntryPointer + 16, dataHi, true);     // data_hi

    // Increment count
    this.view.setUint32(absoluteScopePointer + 4, count + 1, true);
  }

  /**
   * Set a TYPE_OBJECT value in a scope.
   *
   * @param {number} scopePointer - Scope pointer
   * @param {number} keyOffset - String table offset for key
   * @param {number} objectPointer - Object pointer
   */
  scopeSetObject(scopePointer, keyOffset, objectPointer) {
    this.scopeSetRaw(scopePointer, keyOffset, TYPE.OBJECT, objectPointer, 0);
  }

  /**
   * Set a TYPE_CONSTRUCTOR value in a scope.
   *
   * @param {number} scopePointer - Scope pointer
   * @param {number} keyOffset - String table offset for key
   * @param {number} objectPointer - Object with static methods
   * @param {number} methodId - Method ID for call/new
   */
  scopeSetConstructor(scopePointer, keyOffset, objectPointer, methodId) {
    // Every constructor exposes its global binding name as a `name`
    // string property on its statics object (`Error.name === 'Error'`,
    // JavaScript parity). The scope key IS the name string. Each
    // constructor's allocateObject capacity reserves the extra slot.
    this.objectSetRaw(objectPointer, this.internString('name'), TYPE.STRING, keyOffset, 0);
    // TYPE_CONSTRUCTOR: data_lo = objectPointer, data_hi = methodId
    this.scopeSetRaw(scopePointer, keyOffset, TYPE.CONSTRUCTOR, objectPointer, methodId);
  }

  /**
   * Set a TYPE_BOUND_METHOD value in a scope.
   *
   * @param {number} scopePointer - Scope pointer
   * @param {number} keyOffset - String table offset for key
   * @param {number} receiverPointer - Receiver (0 for global functions)
   * @param {number} methodId - Method ID
   */
  scopeSetBoundMethod(scopePointer, keyOffset, receiverPointer, methodId) {
    this.scopeSetRaw(scopePointer, keyOffset, TYPE.BOUND_METHOD, receiverPointer, methodId);
  }

  /**
   * Set a float value in scope.
   *
   * @param {number} scopePointer - Scope pointer
   * @param {number} keyOffset - String table offset for variable name
   * @param {number} value - Float value
   */
  scopeSetFloat(scopePointer, keyOffset, value) {
    const buffer = new ArrayBuffer(8);
    const f64 = new Float64Array(buffer);
    const u32 = new Uint32Array(buffer);
    f64[0] = value;
    this.scopeSetRaw(scopePointer, keyOffset, TYPE.FLOAT, u32[0], u32[1]);
  }

  /**
   * Initialize built-in objects (Math, Object, Array, String, Number)
   * and global functions (parseInt, parseFloat, isNaN, isFinite, Boolean).
   *
   * Called by bootstrap(), after the root scope is created and before
   * parsing/running code.
   */
  initializeBuiltins() {
    // Use root scope (independent of any context)
    const globalScope = this.getRootScope();

    // =========================================================================
    // Built-in Prototypes
    // =========================================================================

    // Object.prototype - end of all prototype chains
    const objectPrototype = this.allocateObject(2);
    this.setObjectPrototype(objectPrototype, 0); // null prototype
    this.objectSetBoundMethod(objectPrototype, this.getBuiltinName(BUILTIN_NAME.HAS_OWN_PROPERTY), objectPrototype, METHOD.HAS_OWN_PROPERTY);
    this.objectSetBoundMethod(objectPrototype, this.getBuiltinName(BUILTIN_NAME.TO_STRING_NAME), objectPrototype, METHOD.OBJECT_TO_STRING);
    this.setObjectFrozen(objectPrototype);
    this.setState(STATE.OBJECT_PROTOTYPE, objectPrototype);

    // Array.prototype - inherits from Object.prototype
    const arrayPrototype = this.allocateObject(0);
    this.setObjectPrototype(arrayPrototype, objectPrototype);
    this.setObjectFrozen(arrayPrototype);
    this.setState(STATE.ARRAY_PROTOTYPE, arrayPrototype);

    // String.prototype (slice 3 of async-iteration): primitive strings
    // dispatch symbol-keyed property access (e.g. Symbol.iterator) through
    // this object. Inherits from Object.prototype; methods are looked up
    // here by the GET_INDEX symbol-key path.
    const stringPrototype = this.allocateObject(0);

    // BigInt.prototype - primitive BigInt property lookup starts here.
    const bigintPrototype = this.allocateObject(
      5,
      this.allocateBigInt(0, []));
    this.setObjectPrototype(bigintPrototype, objectPrototype);
    this.objectSetBoundMethod(bigintPrototype, this.getBuiltinName(BUILTIN_NAME.TO_STRING_NAME), 0, METHOD.BIGINT_TO_STRING);
    this.objectSetBoundMethod(bigintPrototype, this.getBuiltinName(BUILTIN_NAME.TO_LOCALE_STRING), 0, METHOD.BIGINT_TO_LOCALE_STRING);
    this.objectSetBoundMethod(bigintPrototype, this.getBuiltinName(BUILTIN_NAME.VALUE_OF), 0, METHOD.BIGINT_VALUE_OF);
    this.setState(STATE.BIGINT_PROTOTYPE, bigintPrototype);
    this.setObjectPrototype(stringPrototype, objectPrototype);
    this.setObjectFrozen(stringPrototype);
    this.setState(STATE.STRING_PROTOTYPE, stringPrototype);

    // Function.prototype - inherits from Object.prototype
    const functionPrototype = this.allocateObject(4);
    this.setObjectPrototype(functionPrototype, objectPrototype);
    // call / apply / bind (closure receivers; resolved through the
    // TYPE_FUNCTION prototype walk, invoked with the function in the
    // receiver stack slot).
    this.objectSetBoundMethod(functionPrototype,
      this.getBuiltinName(BUILTIN_NAME.CALL_NAME), 0, METHOD.FUNCTION_CALL);
    this.objectSetBoundMethod(functionPrototype,
      this.getBuiltinName(BUILTIN_NAME.APPLY_NAME), 0, METHOD.FUNCTION_APPLY);
    this.objectSetBoundMethod(functionPrototype,
      this.getBuiltinName(BUILTIN_NAME.BIND_NAME), 0, METHOD.FUNCTION_BIND);
    this.setObjectFrozen(functionPrototype);
    this.setState(STATE.FUNCTION_PROTOTYPE, functionPrototype);

    // Error.prototype - inherits from Object.prototype
    const errorPrototype = this.allocateObject(3);
    this.setObjectPrototype(errorPrototype, objectPrototype);
    this.objectSetString(errorPrototype, this.getBuiltinName(BUILTIN_NAME.NAME), this.getBuiltinName(BUILTIN_NAME.LIT_ERROR));
    this.objectSetString(errorPrototype, this.getBuiltinName(BUILTIN_NAME.MESSAGE), this.getBuiltinName(BUILTIN_NAME.LIT_EMPTY_STRING));
    this.objectSetBoundMethod(errorPrototype, this.getBuiltinName(BUILTIN_NAME.TO_STRING_NAME), errorPrototype, METHOD.ERROR_TO_STRING);
    this.setObjectFrozen(errorPrototype);
    this.setState(STATE.ERROR_PROTOTYPE, errorPrototype);

    // TypeError.prototype - inherits from Error.prototype
    const typeErrorPrototype = this.allocateObject(1);
    this.setObjectPrototype(typeErrorPrototype, errorPrototype);
    this.objectSetString(typeErrorPrototype, this.getBuiltinName(BUILTIN_NAME.NAME), this.getBuiltinName(BUILTIN_NAME.LIT_TYPE_ERROR));
    this.setObjectFrozen(typeErrorPrototype);
    this.setState(STATE.TYPE_ERROR_PROTOTYPE, typeErrorPrototype);

    // ReferenceError.prototype - inherits from Error.prototype
    const referenceErrorPrototype = this.allocateObject(1);
    this.setObjectPrototype(referenceErrorPrototype, errorPrototype);
    this.objectSetString(referenceErrorPrototype, this.getBuiltinName(BUILTIN_NAME.NAME), this.getBuiltinName(BUILTIN_NAME.LIT_REFERENCE_ERROR));
    this.setObjectFrozen(referenceErrorPrototype);
    this.setState(STATE.REFERENCE_ERROR_PROTOTYPE, referenceErrorPrototype);

    // GrantDeniedError.prototype - inherits from Error.prototype
    const grantDeniedErrorPrototype = this.allocateObject(1);
    this.setObjectPrototype(grantDeniedErrorPrototype, errorPrototype);
    this.objectSetString(grantDeniedErrorPrototype, this.getBuiltinName(BUILTIN_NAME.NAME), this.getBuiltinName(BUILTIN_NAME.LIT_GRANT_DENIED_ERROR));
    this.setObjectFrozen(grantDeniedErrorPrototype);
    this.setState(STATE.GRANT_DENIED_ERROR_PROTOTYPE, grantDeniedErrorPrototype);

    // RangeError.prototype - inherits from Error.prototype
    const rangeErrorPrototype = this.allocateObject(1);
    this.setObjectPrototype(rangeErrorPrototype, errorPrototype);
    this.objectSetString(rangeErrorPrototype, this.getBuiltinName(BUILTIN_NAME.NAME), this.getBuiltinName(BUILTIN_NAME.LIT_RANGE_ERROR));
    this.setObjectFrozen(rangeErrorPrototype);
    this.setState(STATE.RANGE_ERROR_PROTOTYPE, rangeErrorPrototype);

    // SyntaxError.prototype - inherits from Error.prototype
    const syntaxErrorPrototype = this.allocateObject(1);
    this.setObjectPrototype(syntaxErrorPrototype, errorPrototype);
    this.objectSetString(syntaxErrorPrototype, this.getBuiltinName(BUILTIN_NAME.NAME), this.getBuiltinName(BUILTIN_NAME.LIT_SYNTAX_ERROR));
    this.setObjectFrozen(syntaxErrorPrototype);
    this.setState(STATE.SYNTAX_ERROR_PROTOTYPE, syntaxErrorPrototype);

    // ArrayBuffer.prototype - inherits from Object.prototype
    const arrayBufferPrototype = this.allocateObject(0);
    this.setObjectPrototype(arrayBufferPrototype, objectPrototype);
    this.setObjectFrozen(arrayBufferPrototype);
    this.setState(STATE.ARRAYBUFFER_PROTOTYPE, arrayBufferPrototype);

    // Uint8Array.prototype - inherits from Object.prototype
    // (Future: will inherit from %TypedArray.prototype%)
    const uint8ArrayPrototype = this.allocateObject(0);
    this.setObjectPrototype(uint8ArrayPrototype, objectPrototype);
    this.setObjectFrozen(uint8ArrayPrototype);
    this.setState(STATE.UINT8ARRAY_PROTOTYPE, uint8ArrayPrototype);

    // DataView.prototype - inherits from Object.prototype
    const dataViewPrototype = this.allocateObject(0);
    this.setObjectPrototype(dataViewPrototype, objectPrototype);
    this.setObjectFrozen(dataViewPrototype);
    this.setState(STATE.DATAVIEW_PROTOTYPE, dataViewPrototype);

    // =========================================================================
    // Math object (not callable, just properties)
    // =========================================================================
    const mathObj = this.allocateObject(48); // 33 methods + 8 constants + room

    // Math constants
    this.objectSetFloat(mathObj, this.internString('PI'), Math.PI);
    this.objectSetFloat(mathObj, this.internString('E'), Math.E);
    this.objectSetFloat(mathObj, this.internString('LN2'), Math.LN2);
    this.objectSetFloat(mathObj, this.internString('LN10'), Math.LN10);
    this.objectSetFloat(mathObj, this.internString('LOG2E'), Math.LOG2E);
    this.objectSetFloat(mathObj, this.internString('LOG10E'), Math.LOG10E);
    this.objectSetFloat(mathObj, this.internString('SQRT2'), Math.SQRT2);
    this.objectSetFloat(mathObj, this.internString('SQRT1_2'), Math.SQRT1_2);

    // Math methods
    this.objectSetBoundMethod(mathObj, this.internString('abs'), mathObj, METHOD.MATH_ABS);
    this.objectSetBoundMethod(mathObj, this.internString('floor'), mathObj, METHOD.MATH_FLOOR);
    this.objectSetBoundMethod(mathObj, this.internString('ceil'), mathObj, METHOD.MATH_CEIL);
    this.objectSetBoundMethod(mathObj, this.internString('round'), mathObj, METHOD.MATH_ROUND);
    this.objectSetBoundMethod(mathObj, this.internString('trunc'), mathObj, METHOD.MATH_TRUNC);
    this.objectSetBoundMethod(mathObj, this.internString('sign'), mathObj, METHOD.MATH_SIGN);
    this.objectSetBoundMethod(mathObj, this.internString('min'), mathObj, METHOD.MATH_MIN);
    this.objectSetBoundMethod(mathObj, this.internString('max'), mathObj, METHOD.MATH_MAX);
    this.objectSetBoundMethod(mathObj, this.internString('pow'), mathObj, METHOD.MATH_POW);
    this.objectSetBoundMethod(mathObj, this.internString('sqrt'), mathObj, METHOD.MATH_SQRT);
    this.objectSetBoundMethod(mathObj, this.internString('cbrt'), mathObj, METHOD.MATH_CBRT);
    this.objectSetBoundMethod(mathObj, this.internString('hypot'), mathObj, METHOD.MATH_HYPOT);
    this.objectSetBoundMethod(mathObj, this.internString('sin'), mathObj, METHOD.MATH_SIN);
    this.objectSetBoundMethod(mathObj, this.internString('cos'), mathObj, METHOD.MATH_COS);
    this.objectSetBoundMethod(mathObj, this.internString('tan'), mathObj, METHOD.MATH_TAN);
    this.objectSetBoundMethod(mathObj, this.internString('asin'), mathObj, METHOD.MATH_ASIN);
    this.objectSetBoundMethod(mathObj, this.internString('acos'), mathObj, METHOD.MATH_ACOS);
    this.objectSetBoundMethod(mathObj, this.internString('atan'), mathObj, METHOD.MATH_ATAN);
    this.objectSetBoundMethod(mathObj, this.internString('atan2'), mathObj, METHOD.MATH_ATAN2);
    this.objectSetBoundMethod(mathObj, this.internString('sinh'), mathObj, METHOD.MATH_SINH);
    this.objectSetBoundMethod(mathObj, this.internString('cosh'), mathObj, METHOD.MATH_COSH);
    this.objectSetBoundMethod(mathObj, this.internString('tanh'), mathObj, METHOD.MATH_TANH);
    this.objectSetBoundMethod(mathObj, this.internString('asinh'), mathObj, METHOD.MATH_ASINH);
    this.objectSetBoundMethod(mathObj, this.internString('acosh'), mathObj, METHOD.MATH_ACOSH);
    this.objectSetBoundMethod(mathObj, this.internString('atanh'), mathObj, METHOD.MATH_ATANH);
    this.objectSetBoundMethod(mathObj, this.internString('log'), mathObj, METHOD.MATH_LOG);
    this.objectSetBoundMethod(mathObj, this.internString('log10'), mathObj, METHOD.MATH_LOG10);
    this.objectSetBoundMethod(mathObj, this.internString('log2'), mathObj, METHOD.MATH_LOG2);
    this.objectSetBoundMethod(mathObj, this.internString('log1p'), mathObj, METHOD.MATH_LOG1P);
    this.objectSetBoundMethod(mathObj, this.internString('exp'), mathObj, METHOD.MATH_EXP);
    this.objectSetBoundMethod(mathObj, this.internString('expm1'), mathObj, METHOD.MATH_EXPM1);
    this.objectSetBoundMethod(mathObj, this.internString('clz32'), mathObj, METHOD.MATH_CLZ32);
    this.objectSetBoundMethod(mathObj, this.internString('imul'), mathObj, METHOD.MATH_IMUL);
    this.objectSetBoundMethod(mathObj, this.internString('fround'), mathObj, METHOD.MATH_FROUND);
    this.objectSetBoundMethod(
      mathObj,
      this.internString('random'),
      mathObj,
      METHOD.MATH_RANDOM_UNSUPPORTED,
    );

    // Bind Math to global scope as TYPE_OBJECT (not callable)
    this.scopeSetObject(globalScope, this.internString('Math'), mathObj);

    // =========================================================================
    // Ring 2: Symbol registry — allocated before Exact so pre-registered
    // mathematical constants (Pi, E, Infinity) and Ring 2 expression heads
    // (Add, Multiply, …) can be registered as canonical symbols during the
    // Exact namespace setup via allocateRegisteredSymbol(...).
    // =========================================================================
    const symbolRegistry = this.allocateObject(32);
    this.setState(STATE.SYMBOL_REGISTRY, symbolRegistry);

    // =========================================================================
    // Exact namespace — Ring 1 (Rational, Complex) + Ring 2 (symbolic atoms)
    // =========================================================================
    // Capacity 24: 14 Ring-1 methods + Exact.i + Pi + E + Infinity +
    // Expression + headroom.
    const exactObj = this.allocateObject(24);
    this.objectSetBoundMethod(exactObj, this.internString('rational'), exactObj, METHOD.EXACT_RATIONAL);
    this.objectSetBoundMethod(exactObj, this.internString('isRational'), exactObj, METHOD.EXACT_IS_RATIONAL);
    this.objectSetBoundMethod(exactObj, this.internString('numerator'), exactObj, METHOD.EXACT_NUMERATOR);
    this.objectSetBoundMethod(exactObj, this.internString('denominator'), exactObj, METHOD.EXACT_DENOMINATOR);
    this.objectSetBoundMethod(exactObj, this.internString('equal'), exactObj, METHOD.EXACT_EQUAL);
    this.objectSetBoundMethod(exactObj, this.internString('isInteger'), exactObj, METHOD.EXACT_IS_INTEGER);
    this.objectSetBoundMethod(exactObj, this.internString('complex'), exactObj, METHOD.EXACT_COMPLEX);
    this.objectSetBoundMethod(exactObj, this.internString('isComplex'), exactObj, METHOD.EXACT_IS_COMPLEX);
    this.objectSetBoundMethod(exactObj, this.internString('real'), exactObj, METHOD.EXACT_REAL);
    this.objectSetBoundMethod(exactObj, this.internString('imaginary'), exactObj, METHOD.EXACT_IMAGINARY);
    this.objectSetBoundMethod(exactObj, this.internString('realize'), exactObj, METHOD.EXACT_REALIZE);
    this.objectSetBoundMethod(exactObj, this.internString('tryRealize'), exactObj, METHOD.EXACT_TRY_REALIZE);
    this.objectSetBoundMethod(exactObj, this.internString('typeOf'), exactObj, METHOD.EXACT_TYPE_OF);
    this.objectSetBoundMethod(exactObj, this.internString('toString'), exactObj, METHOD.EXACT_TO_STRING);

    // Exact.i — the imaginary unit, Complex(0, 1), pre-allocated so `Exact.i`
    // is a property lookup instead of a heap-allocating method call.
    const bigintZero = this.allocateBigInt(0, []);
    const bigintOne = this.allocateBigInt(0, [1]);
    const rationalZero = this.allocateRational(bigintZero, bigintOne);
    const rationalOne = this.allocateRational(bigintOne, bigintOne);
    const complexI = this.allocateComplex(rationalZero, rationalOne);
    this.objectSetRaw(exactObj, this.internString('i'), TYPE.COMPLEX, complexI, 0);

    // Ring 2: symbolic mathematical constants as registry-backed symbols.
    // Exact.Pi === Symbol.for('Pi'), etc. The global registry gives these
    // canonical identity across any code in the session.
    const piSymbol = this.allocateRegisteredSymbol('Pi');
    const eSymbol = this.allocateRegisteredSymbol('E');
    const infinitySymbol = this.allocateRegisteredSymbol('Infinity');
    this.objectSetRaw(exactObj, this.internString('Pi'), TYPE.SYMBOL, piSymbol, 0);
    this.objectSetRaw(exactObj, this.internString('E'), TYPE.SYMBOL, eSymbol, 0);
    this.objectSetRaw(exactObj, this.internString('Infinity'), TYPE.SYMBOL, infinitySymbol, 0);

    // Ring 2: Exact.Expression namespace — a sub-object on Exact holding
    // pre-registered head symbols (Add, Subtract, …) and (in 2b.3) the
    // construction / inspection builtins. Pre-registered heads are exposed
    // as properties so user code can dispatch on them:
    //   if (Exact.Expression.kind(e) === Exact.Expression.Add) { … }
    // Each head is a registry-backed symbol so Symbol.for('Add') returns
    // the exact same object.
    const expressionNamespace = this.allocateObject(80);
    const addSymbol = this.allocateRegisteredSymbol('Add');
    const subtractSymbol = this.allocateRegisteredSymbol('Subtract');
    const multiplySymbol = this.allocateRegisteredSymbol('Multiply');
    const divideSymbol = this.allocateRegisteredSymbol('Divide');
    const powerSymbol = this.allocateRegisteredSymbol('Power');
    const negateSymbol = this.allocateRegisteredSymbol('Negate');
    // Ring 4 (4b): Conjugate — introduced by conjugateTranspose but a
    // Ring 2 operator in its own right. Opaque except for simplify's
    // double-conjugate collapse and numeric-atom folding.
    const conjugateSymbol = this.allocateRegisteredSymbol('Conjugate');
    this.objectSetRaw(expressionNamespace, this.internString('Add'), TYPE.SYMBOL, addSymbol, 0);
    this.objectSetRaw(expressionNamespace, this.internString('Subtract'), TYPE.SYMBOL, subtractSymbol, 0);
    this.objectSetRaw(expressionNamespace, this.internString('Multiply'), TYPE.SYMBOL, multiplySymbol, 0);
    this.objectSetRaw(expressionNamespace, this.internString('Divide'), TYPE.SYMBOL, divideSymbol, 0);
    this.objectSetRaw(expressionNamespace, this.internString('Power'), TYPE.SYMBOL, powerSymbol, 0);
    this.objectSetRaw(expressionNamespace, this.internString('Negate'), TYPE.SYMBOL, negateSymbol, 0);
    this.objectSetRaw(expressionNamespace, this.internString('Conjugate'), TYPE.SYMBOL, conjugateSymbol, 0);
    // Ring 5 (5a): Equal / NotEqual — statement heads for the theorem
    // ring. Simplify recognizes neither (a statement is not a boolean;
    // Equal(2, 2) stays symbolic — truth is the theorem level's job);
    // registration provides canonical identity + namespace access.
    const equalSymbol = this.allocateRegisteredSymbol('Equal');
    const notEqualSymbol = this.allocateRegisteredSymbol('NotEqual');
    this.objectSetRaw(expressionNamespace, this.internString('Equal'), TYPE.SYMBOL, equalSymbol, 0);
    this.objectSetRaw(expressionNamespace, this.internString('NotEqual'), TYPE.SYMBOL, notEqualSymbol, 0);
    // Ring 5 (5c): Determinant / Rank — statement heads for the matrix
    // computation rules (first real consumers; Ring 4's Q7 discipline).
    // Opaque to simplify, like Conjugate before its fold rules.
    const determinantSymbol = this.allocateRegisteredSymbol('Determinant');
    const rankSymbol = this.allocateRegisteredSymbol('Rank');
    this.objectSetRaw(expressionNamespace, this.internString('Determinant'), TYPE.SYMBOL, determinantSymbol, 0);
    this.objectSetRaw(expressionNamespace, this.internString('Rank'), TYPE.SYMBOL, rankSymbol, 0);
    // Exp is the primitive transcendental head. Log uses the principal
    // branch: -Pi < imaginary part <= Pi. Sin, Cos, and Tan constructors
    // derive their trees from Exp and therefore need no registered heads.
    const expSymbol = this.allocateRegisteredSymbol('Exp');
    const logSymbol = this.allocateRegisteredSymbol('Log');
    this.objectSetRaw(expressionNamespace, this.internString('Exp'), TYPE.SYMBOL, expSymbol, 0);
    this.objectSetRaw(expressionNamespace, this.internString('Log'), TYPE.SYMBOL, logSymbol, 0);
    // Symbolic calculus: ordering relation heads. Conditions and inputs
    // to later solving; no arithmetic or simplification rule evaluates
    // them (statements are not booleans, like Equal / NotEqual).
    const lessSymbol = this.allocateRegisteredSymbol('Less');
    const lessEqualSymbol = this.allocateRegisteredSymbol('LessEqual');
    const greaterSymbol = this.allocateRegisteredSymbol('Greater');
    const greaterEqualSymbol = this.allocateRegisteredSymbol('GreaterEqual');
    this.objectSetRaw(expressionNamespace, this.internString('Less'), TYPE.SYMBOL, lessSymbol, 0);
    this.objectSetRaw(expressionNamespace, this.internString('LessEqual'), TYPE.SYMBOL, lessEqualSymbol, 0);
    this.objectSetRaw(expressionNamespace, this.internString('Greater'), TYPE.SYMBOL, greaterSymbol, 0);
    this.objectSetRaw(expressionNamespace, this.internString('GreaterEqual'), TYPE.SYMBOL, greaterEqualSymbol, 0);
    // Verified symbolic integration: the Integral head. An unevaluated
    // integral is an exact symbolic object; simplify applies only the safe
    // structural rules, never the integration search.
    const integralSymbol = this.allocateRegisteredSymbol('Integral');
    this.objectSetRaw(expressionNamespace, this.internString('Integral'), TYPE.SYMBOL, integralSymbol, 0);
    // Ring 2 (2b.3): construction builtins bound on the Expression namespace.
    this.objectSetBoundMethod(expressionNamespace, this.internString('make'),
      expressionNamespace, METHOD.EXACT_EXPRESSION_MAKE);
    this.objectSetBoundMethod(expressionNamespace, this.internString('add'),
      expressionNamespace, METHOD.EXACT_EXPRESSION_ADD);
    this.objectSetBoundMethod(expressionNamespace, this.internString('subtract'),
      expressionNamespace, METHOD.EXACT_EXPRESSION_SUBTRACT);
    this.objectSetBoundMethod(expressionNamespace, this.internString('multiply'),
      expressionNamespace, METHOD.EXACT_EXPRESSION_MULTIPLY);
    this.objectSetBoundMethod(expressionNamespace, this.internString('divide'),
      expressionNamespace, METHOD.EXACT_EXPRESSION_DIVIDE);
    this.objectSetBoundMethod(expressionNamespace, this.internString('power'),
      expressionNamespace, METHOD.EXACT_EXPRESSION_POWER);
    this.objectSetBoundMethod(expressionNamespace, this.internString('negate'),
      expressionNamespace, METHOD.EXACT_EXPRESSION_NEGATE);
    this.objectSetBoundMethod(expressionNamespace, this.internString('exp'),
      expressionNamespace, METHOD.EXACT_EXPRESSION_EXP);
    this.objectSetBoundMethod(expressionNamespace, this.internString('sin'),
      expressionNamespace, METHOD.EXACT_EXPRESSION_SIN);
    this.objectSetBoundMethod(expressionNamespace, this.internString('cos'),
      expressionNamespace, METHOD.EXACT_EXPRESSION_COS);
    this.objectSetBoundMethod(expressionNamespace, this.internString('tan'),
      expressionNamespace, METHOD.EXACT_EXPRESSION_TAN);
    this.objectSetBoundMethod(expressionNamespace, this.internString('log'),
      expressionNamespace, METHOD.EXACT_EXPRESSION_LOG);
    this.objectSetBoundMethod(expressionNamespace, this.internString('toApproximation'),
      expressionNamespace, METHOD.EXACT_EXPRESSION_TO_APPROXIMATION);
    // Symbolic calculus: derived elementary-function constructors and
    // the differentiation surface.
    this.objectSetBoundMethod(expressionNamespace, this.internString('sinh'),
      expressionNamespace, METHOD.EXACT_EXPRESSION_SINH);
    this.objectSetBoundMethod(expressionNamespace, this.internString('cosh'),
      expressionNamespace, METHOD.EXACT_EXPRESSION_COSH);
    this.objectSetBoundMethod(expressionNamespace, this.internString('tanh'),
      expressionNamespace, METHOD.EXACT_EXPRESSION_TANH);
    this.objectSetBoundMethod(expressionNamespace, this.internString('sqrt'),
      expressionNamespace, METHOD.EXACT_EXPRESSION_SQRT);
    this.objectSetBoundMethod(expressionNamespace, this.internString('asin'),
      expressionNamespace, METHOD.EXACT_EXPRESSION_ASIN);
    this.objectSetBoundMethod(expressionNamespace, this.internString('acos'),
      expressionNamespace, METHOD.EXACT_EXPRESSION_ACOS);
    this.objectSetBoundMethod(expressionNamespace, this.internString('atan'),
      expressionNamespace, METHOD.EXACT_EXPRESSION_ATAN);
    this.objectSetBoundMethod(expressionNamespace, this.internString('asinh'),
      expressionNamespace, METHOD.EXACT_EXPRESSION_ASINH);
    this.objectSetBoundMethod(expressionNamespace, this.internString('acosh'),
      expressionNamespace, METHOD.EXACT_EXPRESSION_ACOSH);
    this.objectSetBoundMethod(expressionNamespace, this.internString('atanh'),
      expressionNamespace, METHOD.EXACT_EXPRESSION_ATANH);
    this.objectSetBoundMethod(expressionNamespace, this.internString('derivative'),
      expressionNamespace, METHOD.EXACT_EXPRESSION_DERIVATIVE);
    this.objectSetBoundMethod(expressionNamespace, this.internString('gradient'),
      expressionNamespace, METHOD.EXACT_EXPRESSION_GRADIENT);
    this.objectSetBoundMethod(expressionNamespace, this.internString('jacobian'),
      expressionNamespace, METHOD.EXACT_EXPRESSION_JACOBIAN);
    this.objectSetBoundMethod(expressionNamespace, this.internString('hessian'),
      expressionNamespace, METHOD.EXACT_EXPRESSION_HESSIAN);
    this.objectSetBoundMethod(expressionNamespace, this.internString('taylor'),
      expressionNamespace, METHOD.EXACT_EXPRESSION_TAYLOR);
    // Exact solving and factorization.
    this.objectSetBoundMethod(expressionNamespace, this.internString('factor'),
      expressionNamespace, METHOD.EXACT_EXPRESSION_FACTOR);
    this.objectSetBoundMethod(expressionNamespace, this.internString('expandFactorization'),
      expressionNamespace, METHOD.EXACT_EXPRESSION_EXPAND_FACTORIZATION);
    this.objectSetBoundMethod(expressionNamespace, this.internString('degree'),
      expressionNamespace, METHOD.EXACT_EXPRESSION_DEGREE);
    this.objectSetBoundMethod(expressionNamespace, this.internString('coefficients'),
      expressionNamespace, METHOD.EXACT_EXPRESSION_COEFFICIENTS);
    this.objectSetBoundMethod(expressionNamespace, this.internString('content'),
      expressionNamespace, METHOD.EXACT_EXPRESSION_CONTENT);
    this.objectSetBoundMethod(expressionNamespace, this.internString('primitivePart'),
      expressionNamespace, METHOD.EXACT_EXPRESSION_PRIMITIVE_PART);
    this.objectSetBoundMethod(expressionNamespace, this.internString('solvePolynomial'),
      expressionNamespace, METHOD.EXACT_EXPRESSION_SOLVE_POLYNOMIAL);
    this.objectSetBoundMethod(expressionNamespace, this.internString('solveSystem'),
      expressionNamespace, METHOD.EXACT_EXPRESSION_SOLVE_SYSTEM);
    this.objectSetBoundMethod(expressionNamespace, this.internString('solveInequality'),
      expressionNamespace, METHOD.EXACT_EXPRESSION_SOLVE_INEQUALITY);
    this.objectSetBoundMethod(expressionNamespace, this.internString('signChart'),
      expressionNamespace, METHOD.EXACT_EXPRESSION_SIGN_CHART);
    this.objectSetBoundMethod(expressionNamespace, this.internString('satisfies'),
      expressionNamespace, METHOD.EXACT_EXPRESSION_SATISFIES);
    // Verified symbolic integration.
    this.objectSetBoundMethod(expressionNamespace, this.internString('integral'),
      expressionNamespace, METHOD.EXACT_EXPRESSION_INTEGRAL);
    this.objectSetBoundMethod(expressionNamespace, this.internString('definiteIntegral'),
      expressionNamespace, METHOD.EXACT_EXPRESSION_DEFINITE_INTEGRAL);
    this.objectSetBoundMethod(expressionNamespace, this.internString('antiderivative'),
      expressionNamespace, METHOD.EXACT_EXPRESSION_ANTIDERIVATIVE);
    // Ring 2 (2b.4): inspection accessors.
    this.objectSetBoundMethod(expressionNamespace, this.internString('kind'),
      expressionNamespace, METHOD.EXACT_EXPRESSION_KIND);
    this.objectSetBoundMethod(expressionNamespace, this.internString('args'),
      expressionNamespace, METHOD.EXACT_EXPRESSION_ARGS);
    this.objectSetBoundMethod(expressionNamespace, this.internString('argumentCount'),
      expressionNamespace, METHOD.EXACT_EXPRESSION_ARGUMENT_COUNT);
    this.objectSetBoundMethod(expressionNamespace, this.internString('isExpression'),
      expressionNamespace, METHOD.EXACT_EXPRESSION_IS_EXPRESSION);
    this.objectSetBoundMethod(expressionNamespace, this.internString('isAtom'),
      expressionNamespace, METHOD.EXACT_EXPRESSION_IS_ATOM);
    // Ring 2 (2c): equal + substitute.
    this.objectSetBoundMethod(expressionNamespace, this.internString('equal'),
      expressionNamespace, METHOD.EXACT_EXPRESSION_EQUAL);
    this.objectSetBoundMethod(expressionNamespace, this.internString('substitute'),
      expressionNamespace, METHOD.EXACT_EXPRESSION_SUBSTITUTE);
    // Ring 2 (2d): simplify / canonicalization.
    this.objectSetBoundMethod(expressionNamespace, this.internString('simplify'),
      expressionNamespace, METHOD.EXACT_EXPRESSION_SIMPLIFY);
    // Ring 3 (3a): polynomial recognition.
    this.objectSetBoundMethod(expressionNamespace, this.internString('isPolynomial'),
      expressionNamespace, METHOD.EXACT_EXPRESSION_IS_POLYNOMIAL);
    // Ring 3 (3b): uncapped expansion.
    this.objectSetBoundMethod(expressionNamespace, this.internString('expand'),
      expressionNamespace, METHOD.EXACT_EXPRESSION_EXPAND);
    // Ring 3 (3c): polynomial algebra.
    this.objectSetBoundMethod(expressionNamespace, this.internString('polynomialGcd'),
      expressionNamespace, METHOD.EXACT_EXPRESSION_POLYNOMIAL_GCD);
    this.objectSetBoundMethod(expressionNamespace, this.internString('polynomialDivide'),
      expressionNamespace, METHOD.EXACT_EXPRESSION_POLYNOMIAL_DIVIDE);
    this.objectSetBoundMethod(expressionNamespace, this.internString('collect'),
      expressionNamespace, METHOD.EXACT_EXPRESSION_COLLECT);
    // Ring 5 (5a): pattern matching.
    this.objectSetBoundMethod(expressionNamespace, this.internString('match'),
      expressionNamespace, METHOD.EXACT_EXPRESSION_MATCH);
    // Ring 6 (6c): bivariate elimination.
    this.objectSetBoundMethod(expressionNamespace, this.internString('resultant'),
      expressionNamespace, METHOD.EXACT_EXPRESSION_RESULTANT);
    // Ring 7c: sparse multivariate elimination.
    this.objectSetBoundMethod(expressionNamespace, this.internString('groebnerBasis'),
      expressionNamespace, METHOD.EXACT_EXPRESSION_GROEBNER_BASIS);
    this.objectSetBoundMethod(expressionNamespace, this.internString('polynomialReduce'),
      expressionNamespace, METHOD.EXACT_EXPRESSION_POLYNOMIAL_REDUCE);
    this.objectSetRaw(exactObj, this.internString('Expression'), TYPE.OBJECT, expressionNamespace, 0);

    // Ring 4: Exact.Matrix namespace — construction + inspection builtins.
    // No pre-registered Matrix head symbol (Q7, 2026-07-19): a Matrix value
    // is directly a legal Expression argument, so a wrapper head would
    // double-represent. Capacity 32: 11 builtins in 4a, 23 by the end of
    // Ring 4, plus headroom.
    const matrixNamespace = this.allocateObject(32);
    this.objectSetBoundMethod(matrixNamespace, this.internString('make'),
      matrixNamespace, METHOD.EXACT_MATRIX_MAKE);
    this.objectSetBoundMethod(matrixNamespace, this.internString('identity'),
      matrixNamespace, METHOD.EXACT_MATRIX_IDENTITY);
    this.objectSetBoundMethod(matrixNamespace, this.internString('zero'),
      matrixNamespace, METHOD.EXACT_MATRIX_ZERO);
    this.objectSetBoundMethod(matrixNamespace, this.internString('diagonal'),
      matrixNamespace, METHOD.EXACT_MATRIX_DIAGONAL);
    this.objectSetBoundMethod(matrixNamespace, this.internString('fromColumns'),
      matrixNamespace, METHOD.EXACT_MATRIX_FROM_COLUMNS);
    this.objectSetBoundMethod(matrixNamespace, this.internString('rows'),
      matrixNamespace, METHOD.EXACT_MATRIX_ROWS);
    this.objectSetBoundMethod(matrixNamespace, this.internString('columns'),
      matrixNamespace, METHOD.EXACT_MATRIX_COLUMNS);
    this.objectSetBoundMethod(matrixNamespace, this.internString('get'),
      matrixNamespace, METHOD.EXACT_MATRIX_GET);
    this.objectSetBoundMethod(matrixNamespace, this.internString('isMatrix'),
      matrixNamespace, METHOD.EXACT_MATRIX_IS_MATRIX);
    this.objectSetBoundMethod(matrixNamespace, this.internString('isSquare'),
      matrixNamespace, METHOD.EXACT_MATRIX_IS_SQUARE);
    this.objectSetBoundMethod(matrixNamespace, this.internString('equal'),
      matrixNamespace, METHOD.EXACT_MATRIX_EQUAL);
    // Ring 4 (4b): element-wise arithmetic + transpose.
    this.objectSetBoundMethod(matrixNamespace, this.internString('add'),
      matrixNamespace, METHOD.EXACT_MATRIX_ADD);
    this.objectSetBoundMethod(matrixNamespace, this.internString('subtract'),
      matrixNamespace, METHOD.EXACT_MATRIX_SUBTRACT);
    this.objectSetBoundMethod(matrixNamespace, this.internString('scale'),
      matrixNamespace, METHOD.EXACT_MATRIX_SCALE);
    this.objectSetBoundMethod(matrixNamespace, this.internString('negate'),
      matrixNamespace, METHOD.EXACT_MATRIX_NEGATE);
    this.objectSetBoundMethod(matrixNamespace, this.internString('transpose'),
      matrixNamespace, METHOD.EXACT_MATRIX_TRANSPOSE);
    this.objectSetBoundMethod(matrixNamespace, this.internString('conjugateTranspose'),
      matrixNamespace, METHOD.EXACT_MATRIX_CONJUGATE_TRANSPOSE);
    // Ring 4 (4c): multiplication + simple linear algebra.
    this.objectSetBoundMethod(matrixNamespace, this.internString('multiply'),
      matrixNamespace, METHOD.EXACT_MATRIX_MULTIPLY);
    this.objectSetBoundMethod(matrixNamespace, this.internString('trace'),
      matrixNamespace, METHOD.EXACT_MATRIX_TRACE);
    this.objectSetBoundMethod(matrixNamespace, this.internString('determinant'),
      matrixNamespace, METHOD.EXACT_MATRIX_DETERMINANT);
    // Ring 4 (4d): inverse, solve, rank.
    this.objectSetBoundMethod(matrixNamespace, this.internString('inverse'),
      matrixNamespace, METHOD.EXACT_MATRIX_INVERSE);
    this.objectSetBoundMethod(matrixNamespace, this.internString('solve'),
      matrixNamespace, METHOD.EXACT_MATRIX_SOLVE);
    this.objectSetBoundMethod(matrixNamespace, this.internString('rank'),
      matrixNamespace, METHOD.EXACT_MATRIX_RANK);
    this.objectSetRaw(exactObj, this.internString('Matrix'), TYPE.OBJECT, matrixNamespace, 0);


    // Ring 6 (6a): Exact.AlgebraicNumber namespace — real algebraic
    // numbers. Capacity 16: 10 methods in 6a, 6b adds squareRoot /
    // nthRoot plus headroom.
    const algebraicNamespace = this.allocateObject(16);
    this.objectSetBoundMethod(algebraicNamespace, this.internString('rootsOfPolynomial'),
      algebraicNamespace, METHOD.EXACT_ALGEBRAIC_ROOTS_OF_POLYNOMIAL);
    this.objectSetBoundMethod(algebraicNamespace, this.internString('fromExpression'),
      algebraicNamespace, METHOD.EXACT_ALGEBRAIC_FROM_EXPRESSION);
    this.objectSetBoundMethod(algebraicNamespace, this.internString('compare'),
      algebraicNamespace, METHOD.EXACT_ALGEBRAIC_COMPARE);
    this.objectSetBoundMethod(algebraicNamespace, this.internString('equals'),
      algebraicNamespace, METHOD.EXACT_ALGEBRAIC_EQUALS);
    this.objectSetBoundMethod(algebraicNamespace, this.internString('sign'),
      algebraicNamespace, METHOD.EXACT_ALGEBRAIC_SIGN);
    this.objectSetBoundMethod(algebraicNamespace, this.internString('isZero'),
      algebraicNamespace, METHOD.EXACT_ALGEBRAIC_IS_ZERO);
    this.objectSetBoundMethod(algebraicNamespace, this.internString('toApproximation'),
      algebraicNamespace, METHOD.EXACT_ALGEBRAIC_TO_APPROXIMATION);
    this.objectSetBoundMethod(algebraicNamespace, this.internString('definingPolynomial'),
      algebraicNamespace, METHOD.EXACT_ALGEBRAIC_DEFINING_POLYNOMIAL);
    this.objectSetBoundMethod(algebraicNamespace, this.internString('isolatingInterval'),
      algebraicNamespace, METHOD.EXACT_ALGEBRAIC_ISOLATING_INTERVAL);
    this.objectSetBoundMethod(algebraicNamespace, this.internString('isAlgebraicNumber'),
      algebraicNamespace, METHOD.EXACT_ALGEBRAIC_IS_ALGEBRAIC_NUMBER);
    this.objectSetBoundMethod(algebraicNamespace, this.internString('squareRoot'),
      algebraicNamespace, METHOD.EXACT_ALGEBRAIC_SQUARE_ROOT);
    this.objectSetBoundMethod(algebraicNamespace, this.internString('nthRoot'),
      algebraicNamespace, METHOD.EXACT_ALGEBRAIC_NTH_ROOT);
    this.objectSetBoundMethod(algebraicNamespace, this.internString('cosineOfTurns'),
      algebraicNamespace, METHOD.EXACT_ALGEBRAIC_COSINE_OF_TURNS);
    this.objectSetBoundMethod(algebraicNamespace, this.internString('sineOfTurns'),
      algebraicNamespace, METHOD.EXACT_ALGEBRAIC_SINE_OF_TURNS);
    this.objectSetRaw(exactObj, this.internString('AlgebraicNumber'), TYPE.OBJECT, algebraicNamespace, 0);

    // Ring 7: exact non-real algebraic numbers. Values canonicalize back
    // into the existing real tower whenever their imaginary part is zero.
    const complexAlgebraicNamespace = this.allocateObject(17);
    this.objectSetBoundMethod(complexAlgebraicNamespace, this.internString('fromParts'),
      complexAlgebraicNamespace, METHOD.EXACT_COMPLEX_ALGEBRAIC_FROM_PARTS);
    this.objectSetBoundMethod(complexAlgebraicNamespace, this.internString('isComplexAlgebraicNumber'),
      complexAlgebraicNamespace, METHOD.EXACT_COMPLEX_ALGEBRAIC_IS_COMPLEX);
    this.objectSetBoundMethod(complexAlgebraicNamespace, this.internString('realPart'),
      complexAlgebraicNamespace, METHOD.EXACT_COMPLEX_ALGEBRAIC_REAL_PART);
    this.objectSetBoundMethod(complexAlgebraicNamespace, this.internString('imaginaryPart'),
      complexAlgebraicNamespace, METHOD.EXACT_COMPLEX_ALGEBRAIC_IMAGINARY_PART);
    this.objectSetBoundMethod(complexAlgebraicNamespace, this.internString('add'),
      complexAlgebraicNamespace, METHOD.EXACT_COMPLEX_ALGEBRAIC_ADD);
    this.objectSetBoundMethod(complexAlgebraicNamespace, this.internString('subtract'),
      complexAlgebraicNamespace, METHOD.EXACT_COMPLEX_ALGEBRAIC_SUBTRACT);
    this.objectSetBoundMethod(complexAlgebraicNamespace, this.internString('multiply'),
      complexAlgebraicNamespace, METHOD.EXACT_COMPLEX_ALGEBRAIC_MULTIPLY);
    this.objectSetBoundMethod(complexAlgebraicNamespace, this.internString('divide'),
      complexAlgebraicNamespace, METHOD.EXACT_COMPLEX_ALGEBRAIC_DIVIDE);
    this.objectSetBoundMethod(complexAlgebraicNamespace, this.internString('negate'),
      complexAlgebraicNamespace, METHOD.EXACT_COMPLEX_ALGEBRAIC_NEGATE);
    this.objectSetBoundMethod(complexAlgebraicNamespace, this.internString('conjugate'),
      complexAlgebraicNamespace, METHOD.EXACT_COMPLEX_ALGEBRAIC_CONJUGATE);
    this.objectSetBoundMethod(complexAlgebraicNamespace, this.internString('modulusSquared'),
      complexAlgebraicNamespace, METHOD.EXACT_COMPLEX_ALGEBRAIC_MODULUS_SQUARED);
    this.objectSetBoundMethod(complexAlgebraicNamespace, this.internString('modulus'),
      complexAlgebraicNamespace, METHOD.EXACT_COMPLEX_ALGEBRAIC_MODULUS);
    this.objectSetBoundMethod(complexAlgebraicNamespace, this.internString('equals'),
      complexAlgebraicNamespace, METHOD.EXACT_COMPLEX_ALGEBRAIC_EQUALS);
    this.objectSetBoundMethod(complexAlgebraicNamespace, this.internString('squareRoot'),
      complexAlgebraicNamespace, METHOD.EXACT_COMPLEX_ALGEBRAIC_SQUARE_ROOT);
    this.objectSetBoundMethod(complexAlgebraicNamespace, this.internString('nthRoot'),
      complexAlgebraicNamespace, METHOD.EXACT_COMPLEX_ALGEBRAIC_NTH_ROOT);
    this.objectSetBoundMethod(complexAlgebraicNamespace, this.internString('rootsOfPolynomial'),
      complexAlgebraicNamespace, METHOD.EXACT_COMPLEX_ALGEBRAIC_ROOTS_OF_POLYNOMIAL);
    this.objectSetBoundMethod(complexAlgebraicNamespace, this.internString('toApproximation'),
      complexAlgebraicNamespace, METHOD.EXACT_COMPLEX_ALGEBRAIC_TO_APPROXIMATION);
    this.objectSetRaw(exactObj, this.internString('ComplexAlgebraicNumber'),
      TYPE.OBJECT, complexAlgebraicNamespace, 0);

    this.scopeSetObject(globalScope, this.internString('Exact'), exactObj);

    // =========================================================================
    // Array constructor (TYPE_CONSTRUCTOR)
    // =========================================================================
    const arrayObj = this.allocateObject(9);
    this.objectSetBoundMethod(arrayObj, this.internString('isArray'), arrayObj, METHOD.ARRAY_IS_ARRAY);
    this.objectSetBoundMethod(arrayObj, this.internString('from'), arrayObj, METHOD.ARRAY_FROM);
    this.objectSetBoundMethod(arrayObj, this.internString('of'), arrayObj, METHOD.ARRAY_OF);
    this.objectSetBoundMethod(arrayObj, this.internString('freeze'), arrayObj, METHOD.ARRAY_FREEZE);
    this.objectSetBoundMethod(arrayObj, this.internString('isFrozen'), arrayObj, METHOD.ARRAY_IS_FROZEN);

    this.scopeSetConstructor(globalScope, this.internString('Array'),
      arrayObj, METHOD.ARRAY_CONSTRUCTOR);

    // =========================================================================
    // Object constructor (TYPE_CONSTRUCTOR)
    // =========================================================================
    const objectObj = this.allocateObject(11);
    this.objectSetBoundMethod(objectObj, this.internString('keys'), objectObj, METHOD.OBJECT_KEYS);
    this.objectSetBoundMethod(objectObj, this.internString('values'), objectObj, METHOD.OBJECT_VALUES);
    this.objectSetBoundMethod(objectObj, this.internString('entries'), objectObj, METHOD.OBJECT_ENTRIES);
    this.objectSetBoundMethod(objectObj, this.internString('assign'), objectObj, METHOD.OBJECT_ASSIGN);
    this.objectSetBoundMethod(objectObj, this.internString('fromEntries'), objectObj, METHOD.OBJECT_FROM_ENTRIES);
    this.objectSetBoundMethod(objectObj, this.internString('getPrototypeOf'), objectObj, METHOD.OBJECT_GET_PROTOTYPE_OF);
    this.objectSetBoundMethod(objectObj, this.internString('freeze'), objectObj, METHOD.OBJECT_FREEZE);
    this.objectSetBoundMethod(objectObj, this.internString('isFrozen'), objectObj, METHOD.OBJECT_IS_FROZEN);
    this.objectSetBoundMethod(objectObj, this.internString('getOwnPropertyDescriptor'), objectObj,
      METHOD.OBJECT_GET_OWN_PROPERTY_DESCRIPTOR);
    // Object.prototype as a real property (B2) — the same convention Map
    // and the typed-array constructors use, so
    // `Object.prototype.toString` resolves through ordinary lookup.
    this.objectSetRaw(objectObj, this.getBuiltinName(BUILTIN_NAME.PROTOTYPE),
      TYPE.OBJECT, objectPrototype, 0);

    this.scopeSetConstructor(globalScope, this.internString('Object'),
      objectObj, METHOD.OBJECT_CONSTRUCTOR);

    // =========================================================================
    // String constructor (TYPE_CONSTRUCTOR)
    // =========================================================================
    const stringObj = this.allocateObject(5);
    this.objectSetBoundMethod(stringObj, this.internString('fromCharCode'), stringObj, METHOD.STRING_FROM_CHAR_CODE);
    this.objectSetBoundMethod(stringObj, this.internString('fromCodePoint'), stringObj, METHOD.STRING_FROM_CODE_POINT);

    this.scopeSetConstructor(globalScope, this.internString('String'),
      stringObj, METHOD.TO_STRING);

    // =========================================================================
    // Number constructor (TYPE_CONSTRUCTOR)
    // =========================================================================
    const numberObj = this.allocateObject(17);

    // Number static methods
    this.objectSetBoundMethod(numberObj, this.internString('isNaN'), numberObj, METHOD.NUMBER_IS_NAN);
    this.objectSetBoundMethod(numberObj, this.internString('isFinite'), numberObj, METHOD.NUMBER_IS_FINITE);
    this.objectSetBoundMethod(numberObj, this.internString('isInteger'), numberObj, METHOD.NUMBER_IS_INTEGER);
    this.objectSetBoundMethod(numberObj, this.internString('parseInt'), numberObj, METHOD.NUMBER_PARSE_INT);
    this.objectSetBoundMethod(numberObj, this.internString('parseFloat'), numberObj, METHOD.NUMBER_PARSE_FLOAT);

    // Number constants
    this.objectSetFloat(numberObj, this.internString('MAX_VALUE'), Number.MAX_VALUE);
    this.objectSetFloat(numberObj, this.internString('MIN_VALUE'), Number.MIN_VALUE);
    this.objectSetFloat(numberObj, this.internString('MAX_SAFE_INTEGER'), Number.MAX_SAFE_INTEGER);
    this.objectSetFloat(numberObj, this.internString('MIN_SAFE_INTEGER'), Number.MIN_SAFE_INTEGER);
    this.objectSetFloat(numberObj, this.internString('POSITIVE_INFINITY'), Infinity);
    this.objectSetFloat(numberObj, this.internString('NEGATIVE_INFINITY'), -Infinity);
    this.objectSetFloat(numberObj, this.internString('NaN'), NaN);
    this.objectSetFloat(numberObj, this.internString('EPSILON'), Number.EPSILON);

    this.scopeSetConstructor(globalScope, this.internString('Number'),
      numberObj, METHOD.TO_NUMBER);

    // =========================================================================
    // JSON object
    // =========================================================================
    const jsonObj = this.allocateObject(2);
    this.objectSetBoundMethod(jsonObj, this.internString('stringify'), jsonObj, METHOD.JSON_STRINGIFY);
    this.objectSetBoundMethod(jsonObj, this.internString('parse'), jsonObj, METHOD.JSON_PARSE);
    this.scopeSetObject(globalScope, this.internString('JSON'), jsonObj);

    // =========================================================================
    // msgpack object
    // =========================================================================
    const msgpackObj = this.allocateObject(2);
    this.objectSetBoundMethod(msgpackObj, this.internString('encode'), msgpackObj, METHOD.MSGPACK_ENCODE);
    this.objectSetBoundMethod(msgpackObj, this.internString('decode'), msgpackObj, METHOD.MSGPACK_DECODE);
    this.scopeSetObject(globalScope, this.internString('msgpack'), msgpackObj);

    // =========================================================================
    // Error constructors
    // =========================================================================

    // Error constructor
    const errorObj = this.allocateObject(2);
    this.objectSetRaw(errorObj, this.getBuiltinName(BUILTIN_NAME.PROTOTYPE), TYPE.OBJECT, errorPrototype, 0);
    this.scopeSetConstructor(globalScope, this.internString('Error'), errorObj, METHOD.ERROR_CONSTRUCTOR);
    this.setState(STATE.ERROR_CONSTRUCTOR, errorObj);

    // TypeError constructor
    const typeErrorObj = this.allocateObject(2);
    this.objectSetRaw(typeErrorObj, this.getBuiltinName(BUILTIN_NAME.PROTOTYPE), TYPE.OBJECT, typeErrorPrototype, 0);
    this.scopeSetConstructor(globalScope, this.internString('TypeError'), typeErrorObj, METHOD.TYPE_ERROR_CONSTRUCTOR);
    this.setState(STATE.TYPE_ERROR_CONSTRUCTOR, typeErrorObj);

    // ReferenceError constructor
    const referenceErrorObj = this.allocateObject(2);
    this.objectSetRaw(referenceErrorObj, this.getBuiltinName(BUILTIN_NAME.PROTOTYPE), TYPE.OBJECT, referenceErrorPrototype, 0);
    this.scopeSetConstructor(globalScope, this.internString('ReferenceError'), referenceErrorObj, METHOD.REFERENCE_ERROR_CONSTRUCTOR);
    this.setState(STATE.REFERENCE_ERROR_CONSTRUCTOR, referenceErrorObj);

    // RangeError constructor
    const rangeErrorObj = this.allocateObject(2);
    this.objectSetRaw(rangeErrorObj, this.getBuiltinName(BUILTIN_NAME.PROTOTYPE), TYPE.OBJECT, rangeErrorPrototype, 0);
    this.scopeSetConstructor(globalScope, this.internString('RangeError'), rangeErrorObj, METHOD.RANGE_ERROR_CONSTRUCTOR);
    this.setState(STATE.RANGE_ERROR_CONSTRUCTOR, rangeErrorObj);

    // SyntaxError constructor
    const syntaxErrorObj = this.allocateObject(2);
    this.objectSetRaw(syntaxErrorObj, this.getBuiltinName(BUILTIN_NAME.PROTOTYPE), TYPE.OBJECT, syntaxErrorPrototype, 0);
    this.scopeSetConstructor(globalScope, this.internString('SyntaxError'), syntaxErrorObj, METHOD.SYNTAX_ERROR_CONSTRUCTOR);
    this.setState(STATE.SYNTAX_ERROR_CONSTRUCTOR, syntaxErrorObj);

    // Function constructor (new Function() throws TypeError - sandbox safety)
    const functionObj = this.allocateObject(2);
    this.objectSetRaw(functionObj, this.getBuiltinName(BUILTIN_NAME.PROTOTYPE), TYPE.OBJECT, functionPrototype, 0);
    this.scopeSetConstructor(globalScope, this.internString('Function'), functionObj, METHOD.FUNCTION_CONSTRUCTOR);

    // =========================================================================
    // Promise constructor
    // =========================================================================
    const promiseObj = this.allocateObject(5);
    this.objectSetBoundMethod(promiseObj, this.internString('resolve'), promiseObj, METHOD.PROMISE_RESOLVE);
    this.objectSetBoundMethod(promiseObj, this.internString('reject'), promiseObj, METHOD.PROMISE_REJECT);
    this.objectSetBoundMethod(promiseObj, this.internString('all'), promiseObj, METHOD.PROMISE_ALL);
    this.objectSetBoundMethod(promiseObj, this.internString('race'), promiseObj, METHOD.PROMISE_RACE);
    this.scopeSetConstructor(globalScope, this.internString('Promise'), promiseObj, METHOD.PROMISE_CONSTRUCTOR);

    // =========================================================================
    // Global functions (TYPE_BOUND_METHOD with receiver = 0)
    // =========================================================================
    this.scopeSetBoundMethod(globalScope, this.internString('parseInt'), 0, METHOD.PARSE_INT);
    this.scopeSetBoundMethod(globalScope, this.internString('parseFloat'), 0, METHOD.PARSE_FLOAT);
    this.scopeSetBoundMethod(globalScope, this.internString('isNaN'), 0, METHOD.IS_NAN);
    this.scopeSetBoundMethod(globalScope, this.internString('isFinite'), 0, METHOD.IS_FINITE);
    this.scopeSetBoundMethod(globalScope, this.internString('btoa'), 0, METHOD.BTOA);
    this.scopeSetBoundMethod(globalScope, this.internString('atob'), 0, METHOD.ATOB);

    // Boolean constructor (TYPE_CONSTRUCTOR like String/Number)
    const booleanObj = this.allocateObject(1);
    this.scopeSetConstructor(globalScope, this.internString('Boolean'), booleanObj, METHOD.TO_BOOLEAN);

    // BigInt constructor (conversion function, NOT new-able)
    const bigintObj = this.allocateObject(6);
    this.objectSetBoundMethod(bigintObj, this.getBuiltinName(BUILTIN_NAME.BIGINT_AS_INT_N), bigintObj, METHOD.BIGINT_AS_INT_N);
    this.objectSetBoundMethod(bigintObj, this.getBuiltinName(BUILTIN_NAME.BIGINT_AS_UINT_N), bigintObj, METHOD.BIGINT_AS_UINT_N);
    this.objectSetRaw(bigintObj, this.getBuiltinName(BUILTIN_NAME.PROTOTYPE), TYPE.OBJECT, bigintPrototype, 0);
    this.objectSetString(bigintObj, this.getBuiltinName(BUILTIN_NAME.NAME), this.internString('BigInt'));
    this.objectSetRaw(bigintObj, this.getBuiltinName(BUILTIN_NAME.LENGTH), TYPE.INTEGER, 1, 0);
    this.objectSetRaw(bigintPrototype, this.getBuiltinName(BUILTIN_NAME.CONSTRUCTOR), TYPE.CONSTRUCTOR, bigintObj, METHOD.TO_BIGINT);
    this.scopeSetConstructor(globalScope, this.internString('BigInt'), bigintObj, METHOD.TO_BIGINT);

    this.setState(STATE.BIGINT_CONSTRUCTOR, bigintObj);
    // =========================================================================
    // ArrayBuffer and Uint8Array constructors
    // =========================================================================

    // ArrayBuffer constructor
    const arrayBufferObj = this.allocateObject(2);
    this.objectSetRaw(arrayBufferObj, this.getBuiltinName(BUILTIN_NAME.PROTOTYPE), TYPE.OBJECT, arrayBufferPrototype, 0);
    this.scopeSetConstructor(globalScope, this.internString('ArrayBuffer'), arrayBufferObj, METHOD.ARRAYBUFFER_CONSTRUCTOR);

    // Uint8Array constructor (with static from/of methods)
    const uint8ArrayObj = this.allocateObject(4);
    this.objectSetRaw(uint8ArrayObj, this.getBuiltinName(BUILTIN_NAME.PROTOTYPE), TYPE.OBJECT, uint8ArrayPrototype, 0);
    this.objectSetBoundMethod(uint8ArrayObj, this.internString('from'), uint8ArrayObj, METHOD.UINT8ARRAY_FROM);
    this.objectSetBoundMethod(uint8ArrayObj, this.internString('of'), uint8ArrayObj, METHOD.UINT8ARRAY_OF);
    this.scopeSetConstructor(globalScope, this.internString('Uint8Array'), uint8ArrayObj, METHOD.UINT8ARRAY_CONSTRUCTOR);

    // DataView constructor
    const dataViewObj = this.allocateObject(2);
    this.objectSetRaw(dataViewObj, this.getBuiltinName(BUILTIN_NAME.PROTOTYPE), TYPE.OBJECT, dataViewPrototype, 0);
    this.scopeSetConstructor(globalScope, this.internString('DataView'), dataViewObj, METHOD.DATAVIEW_CONSTRUCTOR);

    // Other typed array constructors (with static from/of methods)
    const int8ArrayObj = this.allocateObject(4);
    this.objectSetRaw(int8ArrayObj, this.getBuiltinName(BUILTIN_NAME.PROTOTYPE), TYPE.OBJECT, uint8ArrayPrototype, 0);
    this.objectSetBoundMethod(int8ArrayObj, this.internString('from'), int8ArrayObj, METHOD.INT8ARRAY_FROM);
    this.objectSetBoundMethod(int8ArrayObj, this.internString('of'), int8ArrayObj, METHOD.INT8ARRAY_OF);
    this.scopeSetConstructor(globalScope, this.internString('Int8Array'), int8ArrayObj, METHOD.INT8ARRAY_CONSTRUCTOR);

    const uint8ClampedArrayObj = this.allocateObject(4);
    this.objectSetRaw(uint8ClampedArrayObj, this.getBuiltinName(BUILTIN_NAME.PROTOTYPE), TYPE.OBJECT, uint8ArrayPrototype, 0);
    this.objectSetBoundMethod(uint8ClampedArrayObj, this.internString('from'), uint8ClampedArrayObj, METHOD.UINT8CLAMPEDARRAY_FROM);
    this.objectSetBoundMethod(uint8ClampedArrayObj, this.internString('of'), uint8ClampedArrayObj, METHOD.UINT8CLAMPEDARRAY_OF);
    this.scopeSetConstructor(globalScope, this.internString('Uint8ClampedArray'), uint8ClampedArrayObj, METHOD.UINT8CLAMPEDARRAY_CONSTRUCTOR);

    const int16ArrayObj = this.allocateObject(4);
    this.objectSetRaw(int16ArrayObj, this.getBuiltinName(BUILTIN_NAME.PROTOTYPE), TYPE.OBJECT, uint8ArrayPrototype, 0);
    this.objectSetBoundMethod(int16ArrayObj, this.internString('from'), int16ArrayObj, METHOD.INT16ARRAY_FROM);
    this.objectSetBoundMethod(int16ArrayObj, this.internString('of'), int16ArrayObj, METHOD.INT16ARRAY_OF);
    this.scopeSetConstructor(globalScope, this.internString('Int16Array'), int16ArrayObj, METHOD.INT16ARRAY_CONSTRUCTOR);

    const uint16ArrayObj = this.allocateObject(4);
    this.objectSetRaw(uint16ArrayObj, this.getBuiltinName(BUILTIN_NAME.PROTOTYPE), TYPE.OBJECT, uint8ArrayPrototype, 0);
    this.objectSetBoundMethod(uint16ArrayObj, this.internString('from'), uint16ArrayObj, METHOD.UINT16ARRAY_FROM);
    this.objectSetBoundMethod(uint16ArrayObj, this.internString('of'), uint16ArrayObj, METHOD.UINT16ARRAY_OF);
    this.scopeSetConstructor(globalScope, this.internString('Uint16Array'), uint16ArrayObj, METHOD.UINT16ARRAY_CONSTRUCTOR);

    const int32ArrayObj = this.allocateObject(4);
    this.objectSetRaw(int32ArrayObj, this.getBuiltinName(BUILTIN_NAME.PROTOTYPE), TYPE.OBJECT, uint8ArrayPrototype, 0);
    this.objectSetBoundMethod(int32ArrayObj, this.internString('from'), int32ArrayObj, METHOD.INT32ARRAY_FROM);
    this.objectSetBoundMethod(int32ArrayObj, this.internString('of'), int32ArrayObj, METHOD.INT32ARRAY_OF);
    this.scopeSetConstructor(globalScope, this.internString('Int32Array'), int32ArrayObj, METHOD.INT32ARRAY_CONSTRUCTOR);

    const uint32ArrayObj = this.allocateObject(4);
    this.objectSetRaw(uint32ArrayObj, this.getBuiltinName(BUILTIN_NAME.PROTOTYPE), TYPE.OBJECT, uint8ArrayPrototype, 0);
    this.objectSetBoundMethod(uint32ArrayObj, this.internString('from'), uint32ArrayObj, METHOD.UINT32ARRAY_FROM);
    this.objectSetBoundMethod(uint32ArrayObj, this.internString('of'), uint32ArrayObj, METHOD.UINT32ARRAY_OF);
    this.scopeSetConstructor(globalScope, this.internString('Uint32Array'), uint32ArrayObj, METHOD.UINT32ARRAY_CONSTRUCTOR);

    const float32ArrayObj = this.allocateObject(4);
    this.objectSetRaw(float32ArrayObj, this.getBuiltinName(BUILTIN_NAME.PROTOTYPE), TYPE.OBJECT, uint8ArrayPrototype, 0);
    this.objectSetBoundMethod(float32ArrayObj, this.internString('from'), float32ArrayObj, METHOD.FLOAT32ARRAY_FROM);
    this.objectSetBoundMethod(float32ArrayObj, this.internString('of'), float32ArrayObj, METHOD.FLOAT32ARRAY_OF);
    this.scopeSetConstructor(globalScope, this.internString('Float32Array'), float32ArrayObj, METHOD.FLOAT32ARRAY_CONSTRUCTOR);

    const float64ArrayObj = this.allocateObject(4);
    this.objectSetRaw(float64ArrayObj, this.getBuiltinName(BUILTIN_NAME.PROTOTYPE), TYPE.OBJECT, uint8ArrayPrototype, 0);
    this.objectSetBoundMethod(float64ArrayObj, this.internString('from'), float64ArrayObj, METHOD.FLOAT64ARRAY_FROM);
    this.objectSetBoundMethod(float64ArrayObj, this.internString('of'), float64ArrayObj, METHOD.FLOAT64ARRAY_OF);
    this.scopeSetConstructor(globalScope, this.internString('Float64Array'), float64ArrayObj, METHOD.FLOAT64ARRAY_CONSTRUCTOR);

    const bigint64ArrayObj = this.allocateObject(4);
    this.objectSetRaw(bigint64ArrayObj, this.getBuiltinName(BUILTIN_NAME.PROTOTYPE), TYPE.OBJECT, uint8ArrayPrototype, 0);
    this.objectSetBoundMethod(bigint64ArrayObj, this.internString('from'), bigint64ArrayObj, METHOD.BIGINT64ARRAY_FROM);
    this.objectSetBoundMethod(bigint64ArrayObj, this.internString('of'), bigint64ArrayObj, METHOD.BIGINT64ARRAY_OF);
    this.scopeSetConstructor(globalScope, this.internString('BigInt64Array'), bigint64ArrayObj, METHOD.BIGINT64ARRAY_CONSTRUCTOR);

    const biguint64ArrayObj = this.allocateObject(4);
    this.objectSetRaw(biguint64ArrayObj, this.getBuiltinName(BUILTIN_NAME.PROTOTYPE), TYPE.OBJECT, uint8ArrayPrototype, 0);
    this.objectSetBoundMethod(biguint64ArrayObj, this.internString('from'), biguint64ArrayObj, METHOD.BIGUINT64ARRAY_FROM);
    this.objectSetBoundMethod(biguint64ArrayObj, this.internString('of'), biguint64ArrayObj, METHOD.BIGUINT64ARRAY_OF);
    this.scopeSetConstructor(globalScope, this.internString('BigUint64Array'), biguint64ArrayObj, METHOD.BIGUINT64ARRAY_CONSTRUCTOR);

    // =========================================================================
    // Global constants
    // =========================================================================
    this.scopeSetFloat(globalScope, this.internString('Infinity'), Infinity);
    this.scopeSetFloat(globalScope, this.internString('NaN'), NaN);
    this.scopeSetRaw(globalScope, this.internString('undefined'), TYPE.UNDEFINED, 0, 0);

    // Note: String() and Number() are handled via TYPE_CONSTRUCTOR values above

    // =========================================================================
    // Ring 2: Symbol (JS-parity primitive) — 2a.2
    // =========================================================================
    // The Symbol global is a constructor-like object with two static methods
    // (.for and .keyFor). Calling Symbol(description) dispatches through
    // METHOD.SYMBOL_CONSTRUCTOR via scopeSetConstructor (same as Boolean,
    // BigInt, Number, etc.).
    const symbolObj = this.allocateObject(9);
    this.objectSetBoundMethod(symbolObj, this.internString('for'), symbolObj, METHOD.SYMBOL_FOR);
    this.objectSetBoundMethod(symbolObj, this.internString('keyFor'), symbolObj, METHOD.SYMBOL_KEY_FOR);

    // Well-known symbols: eagerly minted, NOT registry-backed. Per JS spec,
    // Symbol.iterator !== Symbol.for('Symbol.iterator') — they are distinct
    // symbol identities that happen to share a description string.
    const iteratorSymbol = this.allocateSymbol(this.internString('Symbol.iterator'));
    const asyncIteratorSymbol = this.allocateSymbol(this.internString('Symbol.asyncIterator'));
    const toStringTagSymbol = this.allocateSymbol(this.internString('Symbol.toStringTag'));
    const toPrimitiveSymbol = this.allocateSymbol(this.internString('Symbol.toPrimitive'));
    this.objectSetRaw(symbolObj, this.internString('iterator'), TYPE.SYMBOL, iteratorSymbol, 0);
    this.objectSetRaw(symbolObj, this.internString('asyncIterator'), TYPE.SYMBOL, asyncIteratorSymbol, 0);
    this.objectSetRaw(symbolObj, this.internString('toStringTag'), TYPE.SYMBOL, toStringTagSymbol, 0);
    this.objectSetRaw(symbolObj, this.internString('toPrimitive'), TYPE.SYMBOL, toPrimitiveSymbol, 0);
    this.wellKnownIteratorSymbol = iteratorSymbol;
    this.wellKnownAsyncIteratorSymbol = asyncIteratorSymbol;
    this.wellKnownToStringTagSymbol = toStringTagSymbol;
    // Mirror to STATE so WAT can read these directly.
    this.setState(STATE.WELL_KNOWN_ITERATOR_SYMBOL, iteratorSymbol);
    this.setState(STATE.WELL_KNOWN_ASYNC_ITERATOR_SYMBOL, asyncIteratorSymbol);
    this.setState(STATE.WELL_KNOWN_TO_STRING_TAG_SYMBOL, toStringTagSymbol);
    this.setState(STATE.WELL_KNOWN_TO_PRIMITIVE_SYMBOL, toPrimitiveSymbol);
    // Hidden match-metadata symbol (layout v22): keys the meta object
    // (index/input/groups/indices) in an exec result array's sym-entries
    // block. Deliberately NOT exposed on the Symbol global — script code
    // has no way to name it, so the metadata surface stays read-only.
    const regexpMatchMetaSymbol = this.allocateSymbol(this.internString('SandScript.regexpMatchMeta'));
    this.setState(STATE.REGEXP_MATCH_META_SYMBOL, regexpMatchMetaSymbol);
    this.objectSetSymbolKey(
      bigintPrototype,
      toStringTagSymbol,
      TYPE.STRING,
      this.internString('BigInt'),
      0,
      1);
    this.setObjectFrozen(bigintPrototype);

    // Attach Symbol.iterator to built-in prototypes. The stored
    // BOUND_METHOD value carries METHOD.X_ITERATOR_FACTORY in data_hi;
    // the receiver fields (flags + data_lo) are placeholders that
    // GET_INDEX rewrites at lookup time to the actual primitive.
    // The frozen flag on these prototypes is set against user code; the
    // JS-side helpers used here bypass that gate, which is the correct
    // semantics for bootstrap.
    this.objectSetSymbolKey(
      arrayPrototype, iteratorSymbol,
      TYPE.BOUND_METHOD, 0, METHOD.ARRAY_ITERATOR_FACTORY);
    this.objectSetSymbolKey(
      uint8ArrayPrototype, iteratorSymbol,
      TYPE.BOUND_METHOD, 0, METHOD.TYPED_ARRAY_ITERATOR_FACTORY);
    this.objectSetSymbolKey(
      stringPrototype, iteratorSymbol,
      TYPE.BOUND_METHOD, 0, METHOD.STRING_ITERATOR_FACTORY);

    // =========================================================================
    // Map and Set
    // =========================================================================
    // Map.prototype: instance methods + Symbol.iterator (which === entries).
    // The bound-method values stored here have placeholder receiver=0; the
    // GET_PROP / GET_INDEX path rewrites receiver to the actual map at
    // lookup time (same convention slice 3 established for arrays).
    const mapPrototype = this.allocateObject(12);
    this.setObjectPrototype(mapPrototype, objectPrototype);
    this.objectSetBoundMethod(mapPrototype, this.internString('get'),     0, METHOD.MAP_GET);
    this.objectSetBoundMethod(mapPrototype, this.internString('set'),     0, METHOD.MAP_SET);
    this.objectSetBoundMethod(mapPrototype, this.internString('has'),     0, METHOD.MAP_HAS);
    this.objectSetBoundMethod(mapPrototype, this.internString('delete'),  0, METHOD.MAP_DELETE);
    this.objectSetBoundMethod(mapPrototype, this.internString('clear'),   0, METHOD.MAP_CLEAR);
    this.objectSetBoundMethod(mapPrototype, this.internString('forEach'), 0, METHOD.MAP_FOREACH);
    this.objectSetBoundMethod(mapPrototype, this.internString('keys'),    0, METHOD.MAP_KEYS);
    this.objectSetBoundMethod(mapPrototype, this.internString('values'),  0, METHOD.MAP_VALUES);
    this.objectSetBoundMethod(mapPrototype, this.internString('entries'), 0, METHOD.MAP_ENTRIES_M);
    // Symbol.iterator === entries (per spec, same function object).
    this.objectSetSymbolKey(
      mapPrototype, iteratorSymbol,
      TYPE.BOUND_METHOD, 0, METHOD.MAP_ENTRIES_M);
    this.setObjectFrozen(mapPrototype);
    this.setState(STATE.MAP_PROTOTYPE, mapPrototype);

    // Map constructor object (callable via `new Map(...)`).
    const mapObj = this.allocateObject(3);
    this.objectSetRaw(mapObj, this.getBuiltinName(BUILTIN_NAME.PROTOTYPE),
      TYPE.OBJECT, mapPrototype, 0);
    this.scopeSetConstructor(globalScope, this.internString('Map'), mapObj, METHOD.MAP_CONSTRUCTOR);

    // Set.prototype: instance methods plus ES2025 set-theoretic methods.
    // .keys, .values, .entries — per spec, .keys === .values === Symbol.iterator
    // (same function object). entries() yields [v, v] pairs.
    const setPrototype = this.allocateObject(20);
    this.setObjectPrototype(setPrototype, objectPrototype);
    this.objectSetBoundMethod(setPrototype, this.internString('add'),     0, METHOD.SET_ADD);
    this.objectSetBoundMethod(setPrototype, this.internString('has'),     0, METHOD.SET_HAS);
    this.objectSetBoundMethod(setPrototype, this.internString('delete'),  0, METHOD.SET_DELETE);
    this.objectSetBoundMethod(setPrototype, this.internString('clear'),   0, METHOD.SET_CLEAR);
    this.objectSetBoundMethod(setPrototype, this.internString('forEach'), 0, METHOD.SET_FOREACH);
    this.objectSetBoundMethod(setPrototype, this.internString('keys'),    0, METHOD.SET_VALUES);
    this.objectSetBoundMethod(setPrototype, this.internString('values'),  0, METHOD.SET_VALUES);
    this.objectSetBoundMethod(setPrototype, this.internString('entries'), 0, METHOD.SET_ENTRIES_M);
    this.objectSetBoundMethod(setPrototype, this.internString('union'),                0, METHOD.SET_UNION);
    this.objectSetBoundMethod(setPrototype, this.internString('intersection'),         0, METHOD.SET_INTERSECTION);
    this.objectSetBoundMethod(setPrototype, this.internString('difference'),           0, METHOD.SET_DIFFERENCE);
    this.objectSetBoundMethod(setPrototype, this.internString('symmetricDifference'),  0, METHOD.SET_SYMMETRIC_DIFFERENCE);
    this.objectSetBoundMethod(setPrototype, this.internString('isSubsetOf'),           0, METHOD.SET_IS_SUBSET_OF);
    this.objectSetBoundMethod(setPrototype, this.internString('isSupersetOf'),         0, METHOD.SET_IS_SUPERSET_OF);
    this.objectSetBoundMethod(setPrototype, this.internString('isDisjointFrom'),       0, METHOD.SET_IS_DISJOINT_FROM);
    // Symbol.iterator === values
    this.objectSetSymbolKey(
      setPrototype, iteratorSymbol,
      TYPE.BOUND_METHOD, 0, METHOD.SET_VALUES);
    this.setObjectFrozen(setPrototype);
    this.setState(STATE.SET_PROTOTYPE, setPrototype);

    const setObj = this.allocateObject(3);
    this.objectSetRaw(setObj, this.getBuiltinName(BUILTIN_NAME.PROTOTYPE),
      TYPE.OBJECT, setPrototype, 0);
    this.scopeSetConstructor(globalScope, this.internString('Set'), setObj, METHOD.SET_CONSTRUCTOR);

    this.scopeSetConstructor(globalScope, this.internString('Symbol'), symbolObj, METHOD.SYMBOL_CONSTRUCTOR);
    // Note: Symbol registry is allocated earlier (right before the Exact
    // namespace setup) so that Ring 2's mathematical constants can populate
    // it with canonical atoms during Exact's construction.

    // =========================================================================
    // TextEncoder / TextDecoder
    //
    // Stateless codecs over UTF-8. SS strings are stored as UTF-8 natively,
    // so the encode/decode operations reduce to memcpy + intern in the WAT
    // handlers. The prototype objects here carry the bound methods; the
    // constructors (registered below) produce plain objects whose prototype
    // is one of these.
    // =========================================================================
    const textEncoderPrototype = this.allocateObject(1);
    this.setObjectPrototype(textEncoderPrototype, objectPrototype);
    this.objectSetBoundMethod(textEncoderPrototype, this.internString('encode'), 0, METHOD.TEXT_ENCODER_ENCODE);
    this.setObjectFrozen(textEncoderPrototype);
    this.setState(STATE.TEXT_ENCODER_PROTOTYPE, textEncoderPrototype);

    const textDecoderPrototype = this.allocateObject(1);
    this.setObjectPrototype(textDecoderPrototype, objectPrototype);
    this.objectSetBoundMethod(textDecoderPrototype, this.internString('decode'), 0, METHOD.TEXT_DECODER_DECODE);
    this.setObjectFrozen(textDecoderPrototype);
    this.setState(STATE.TEXT_DECODER_PROTOTYPE, textDecoderPrototype);

    const textEncoderObj = this.allocateObject(2);
    this.objectSetRaw(textEncoderObj, this.getBuiltinName(BUILTIN_NAME.PROTOTYPE),
      TYPE.OBJECT, textEncoderPrototype, 0);
    this.scopeSetConstructor(globalScope, this.internString('TextEncoder'),
      textEncoderObj, METHOD.TEXT_ENCODER_CONSTRUCTOR);

    const textDecoderObj = this.allocateObject(2);
    this.objectSetRaw(textDecoderObj, this.getBuiltinName(BUILTIN_NAME.PROTOTYPE),
      TYPE.OBJECT, textDecoderPrototype, 0);
    this.scopeSetConstructor(globalScope, this.internString('TextDecoder'),
      textDecoderObj, METHOD.TEXT_DECODER_CONSTRUCTOR);

    // =========================================================================
    // RegExp
    //
    // Instances are TYPE_REGEXP primitives: properties and methods resolve
    // directly in the GET_PROP/dispatch ladders, like strings. The prototype
    // object exists for instanceof identity and RegExp.prototype visibility,
    // not method storage. Construction compiles through the statically
    // imported regex engine inside the interpreter (resumable under fuel).
    // =========================================================================
    const regexpPrototype = this.allocateObject(1);
    this.setObjectPrototype(regexpPrototype, objectPrototype);
    this.setObjectFrozen(regexpPrototype);
    this.setState(STATE.REGEXP_PROTOTYPE, regexpPrototype);

    const regexpObj = this.allocateObject(2);
    this.objectSetRaw(regexpObj, this.getBuiltinName(BUILTIN_NAME.PROTOTYPE),
      TYPE.OBJECT, regexpPrototype, 0);
    this.scopeSetConstructor(globalScope, this.internString('RegExp'),
      regexpObj, METHOD.REGEXP_CONSTRUCTOR);

    this.installSchemaGlobal(globalScope, objectPrototype);
  }


  /**
   * Install the `Schema` global documented by the public schema API.
   * Called by initializeBuiltins on a fresh image and by the
   * aggregate-version 2 -> 3 migration over a restored one.
   *
   * Instances are TYPE_SCHEMA primitives (GET_PROP resolves test/validate/
   * assert/errors/schema/kind/dialect per instance). The constructor
   * object carries the static surface; `prototype` exists for instanceof
   * identity only and is found through the constructor object (no STATE
   * cell). Compilation and validation run the statically imported schema
   * engine inside the interpreter, resumable under fuel.
   */
  installSchemaGlobal(globalScope, objectPrototype) {
    const schemaPrototype = this.allocateObject(1);
    this.setObjectPrototype(schemaPrototype, objectPrototype);
    this.setObjectFrozen(schemaPrototype);

    const schemaFormats = this.allocateArrayWithCapacity(FORMAT_NAMES.length - 1);
    for (let i = 1; i < FORMAT_NAMES.length; i++) {
      const slot = this.abs(this.view.getUint32(this.abs(schemaFormats + ARRAY.DATA_POINTER), true)
        + GC_HEADER_SIZE + (i - 1) * VALUE_SIZE);
      this.view.setUint32(slot, TYPE.STRING, true);
      this.view.setUint32(slot + 4, 0, true);
      this.view.setUint32(slot + 8, this.internString(FORMAT_NAMES[i]), true);
      this.view.setUint32(slot + 12, 0, true);
    }
    this.view.setUint32(this.abs(schemaFormats + ARRAY.LENGTH), FORMAT_NAMES.length - 1, true);
    this.view.setUint32(this.abs(schemaFormats + ARRAY.FLAGS), ARRAY_FLAG.FROZEN, true);

    const schemaObj = this.allocateObject(8);
    this.objectSetRaw(schemaObj, this.getBuiltinName(BUILTIN_NAME.PROTOTYPE),
      TYPE.OBJECT, schemaPrototype, 0);
    this.objectSetBoundMethod(schemaObj, this.getBuiltinName(BUILTIN_NAME.COMPILE), schemaObj, METHOD.SCHEMA_COMPILE);
    this.objectSetBoundMethod(schemaObj, this.getBuiltinName(BUILTIN_NAME.TEST), schemaObj, METHOD.SCHEMA_TEST_STATIC);
    this.objectSetBoundMethod(schemaObj, this.getBuiltinName(BUILTIN_NAME.VALIDATE), schemaObj, METHOD.SCHEMA_VALIDATE_STATIC);
    this.objectSetBoundMethod(schemaObj, this.getBuiltinName(BUILTIN_NAME.IS_SCHEMA), schemaObj, METHOD.SCHEMA_IS_SCHEMA);
    this.objectSetBoundMethod(schemaObj, this.getBuiltinName(BUILTIN_NAME.COMPILE_SET), schemaObj, METHOD.SCHEMA_COMPILE_SET);
    this.objectSetRaw(schemaObj, this.getBuiltinName(BUILTIN_NAME.FORMATS), TYPE.ARRAY, schemaFormats, 0);
    this.scopeSetConstructor(globalScope, this.internString('Schema'),
      schemaObj, METHOD.SCHEMA_CONSTRUCTOR);
  }

  // ===========================================================================
  // Garbage Collection
  // ===========================================================================

  // ===========================================================================
  // External Support
  // ===========================================================================

  /**
   * Write a JS value to a 16-byte value slot in memory.
   * For objects/arrays, allocates on heap and writes pointer.
   *
   * @param {number} destinationPointer - Segment-relative pointer to value slot
   * @param {*} jsValue - JS value to write
   * @param {Object} options - Optional callbacks
   * @param {Function} options.marshal - (value) => { type, dataLo, dataHi } | undefined
   *   Called for each value. Return undefined to use default marshalling.
   */
  writeValueAt(destinationPointer, jsValue, options = {}) {
    const absolutePointer = this.abs(destinationPointer);

    // Per-call override (highest priority). Used by callers that need fully
    // custom marshalling.
    if (options.marshal) {
      const result = options.marshal(jsValue);
      if (result !== undefined) {
        this.view.setUint32(absolutePointer, result.type, true);
        this.view.setUint32(absolutePointer + 4, 0, true);
        this.view.setUint32(absolutePointer + 8, result.dataLo ?? 0, true);
        this.view.setUint32(absolutePointer + 12, result.dataHi ?? 0, true);
        return;
      }
    }

    // Detector chain — registered defaults for wrapper types
    // (External, MsgpackRef, Promise, JS function). Stateless wrappers
    // are detected without any caller cooperation; stateful ones (closures)
    // consume options.closureCaptureContextSlot.
    for (const detect of this._marshalDetectors) {
      const result = detect(jsValue, options);
      if (result !== undefined) {
        this.view.setUint32(absolutePointer, result.type, true);
        this.view.setUint32(absolutePointer + 4, 0, true);
        this.view.setUint32(absolutePointer + 8, result.dataLo ?? 0, true);
        this.view.setUint32(absolutePointer + 12, result.dataHi ?? 0, true);
        return;
      }
    }

    if (jsValue === null) {
      this.view.setUint32(absolutePointer, TYPE.NULL, true);
      this.view.setUint32(absolutePointer + 4, 0, true);
      this.view.setUint32(absolutePointer + 8, 0, true);
      this.view.setUint32(absolutePointer + 12, 0, true);
    } else if (jsValue === undefined) {
      this.view.setUint32(absolutePointer, TYPE.UNDEFINED, true);
      this.view.setUint32(absolutePointer + 4, 0, true);
      this.view.setUint32(absolutePointer + 8, 0, true);
      this.view.setUint32(absolutePointer + 12, 0, true);
    } else if (typeof jsValue === 'boolean') {
      this.view.setUint32(absolutePointer, TYPE.BOOLEAN, true);
      this.view.setUint32(absolutePointer + 4, 0, true);
      this.view.setUint32(absolutePointer + 8, jsValue ? 1 : 0, true);
      this.view.setUint32(absolutePointer + 12, 0, true);
    } else if (typeof jsValue === 'number') {
      this.view.setUint32(absolutePointer, TYPE.FLOAT, true);
      this.view.setUint32(absolutePointer + 4, 0, true);
      this.view.setFloat64(absolutePointer + 8, jsValue, true);
    } else if (typeof jsValue === 'string') {
      const offset = this.internString(jsValue);
      this.view.setUint32(absolutePointer, TYPE.STRING, true);
      this.view.setUint32(absolutePointer + 4, 0, true);
      this.view.setUint32(absolutePointer + 8, offset, true);
      this.view.setUint32(absolutePointer + 12, 0, true);
    } else if (typeof jsValue === 'bigint') {
      const heapPointer = this.marshalBigInt(jsValue);
      this.view.setUint32(absolutePointer, TYPE.BIGINT, true);
      this.view.setUint32(absolutePointer + 4, 0, true);
      this.view.setUint32(absolutePointer + 8, heapPointer, true);
      this.view.setUint32(absolutePointer + 12, 0, true);
    } else if (jsValue instanceof Uint8Array) {
      if (jsValue.buffer === this.buffer) {
        const bufferDataPointer = jsValue.byteOffset - this.baseOffset - 4;
        const descriptorPtr = this.allocateTypedArrayDescriptor(
          bufferDataPointer, 0, jsValue.byteLength);
        this.view.setUint32(absolutePointer, TYPE.UINT8ARRAY, true);
        this.view.setUint32(absolutePointer + 4, 0, true);
        this.view.setUint32(absolutePointer + 8, descriptorPtr, true);
        this.view.setUint32(absolutePointer + 12, 0, true);
      } else {
        const bufferDataPointer = this.allocateArrayBuffer(jsValue.byteLength);
        const bytesStart = this.abs(bufferDataPointer + 4);
        this.u8.set(jsValue, bytesStart);
        const descriptorPtr = this.allocateTypedArrayDescriptor(
          bufferDataPointer, 0, jsValue.byteLength);
        this.view.setUint32(absolutePointer, TYPE.UINT8ARRAY, true);
        this.view.setUint32(absolutePointer + 4, 0, true);
        this.view.setUint32(absolutePointer + 8, descriptorPtr, true);
        this.view.setUint32(absolutePointer + 12, 0, true);
      }
    } else if (jsValue instanceof ArrayBuffer) {
      const bufferDataPointer = this.allocateArrayBuffer(jsValue.byteLength);
      const bytesStart = this.abs(bufferDataPointer + 4);
      this.u8.set(new Uint8Array(jsValue), bytesStart);
      this.view.setUint32(absolutePointer, TYPE.ARRAYBUFFER, true);
      this.view.setUint32(absolutePointer + 4, 0, true);
      this.view.setUint32(absolutePointer + 8, bufferDataPointer, true);
      this.view.setUint32(absolutePointer + 12, 0, true);
    } else if (Array.isArray(jsValue)) {
      const heapPointer = this.marshalArray(jsValue, options);
      this.view.setUint32(absolutePointer, TYPE.ARRAY, true);
      this.view.setUint32(absolutePointer + 4, 0, true);
      this.view.setUint32(absolutePointer + 8, heapPointer, true);
      this.view.setUint32(absolutePointer + 12, 0, true);
    } else if (jsValue instanceof Map) {
      // MUST precede the generic `typeof === 'object'` arm: a JS Map has no
      // own enumerable keys, so marshalObject would produce an empty OBJECT
      // (silent data loss). MAP mirrors JS Map with arbitrary keys.
      const heapPointer = this.marshalMap(jsValue, options);
      this.view.setUint32(absolutePointer, TYPE.MAP, true);
      this.view.setUint32(absolutePointer + 4, 0, true);
      this.view.setUint32(absolutePointer + 8, heapPointer, true);
      this.view.setUint32(absolutePointer + 12, 0, true);
    } else if (jsValue instanceof Set) {
      const heapPointer = this.marshalSet(jsValue, options);
      this.view.setUint32(absolutePointer, TYPE.SET, true);
      this.view.setUint32(absolutePointer + 4, 0, true);
      this.view.setUint32(absolutePointer + 8, heapPointer, true);
      this.view.setUint32(absolutePointer + 12, 0, true);
    } else if (typeof jsValue === 'object') {
      const heapPointer = this.marshalObject(jsValue, options);
      this.view.setUint32(absolutePointer, TYPE.OBJECT, true);
      this.view.setUint32(absolutePointer + 4, 0, true);
      this.view.setUint32(absolutePointer + 8, heapPointer, true);
      this.view.setUint32(absolutePointer + 12, 0, true);
    } else {
      throw new Error(`Cannot marshal value of type ${typeof jsValue}`);
    }
  }

  /**
   * Allocate a msgpack byte region on the heap with a proper GC header.
   *
   * Same memory layout as `allocateArrayBuffer`: the data block stores
   * `[length:4][bytes...]` after the GC header. The bytes are
   * zero-initialised and the caller copies the payload into them.
   *
   * Reuses `OBJ.ARRAYBUFFER` rather than introducing a new OBJ type:
   * the GC walker handles ARRAYBUFFER correctly (no internal pointers,
   * leaf object), and the host-facing `MsgpackRef` value points at the
   * data pointer + an offset within these bytes.
   *
   * @param {number} byteLength - Number of msgpack bytes the region holds
   * @returns {number} - Segment-relative data pointer (points at the
   *   `[length:4][bytes...]` block after the GC header). Bytes start at
   *   `dataPointer + 4`.
   */
  allocateMsgpackBytes(byteLength) {
    const dataSize = 4 + byteLength;  // length field + bytes
    const dataPointer = this.allocate(dataSize, OBJ.ARRAYBUFFER);
    this.view.setUint32(this.abs(dataPointer), byteLength, true);
    // Bytes start at dataPointer + 4. The caller is expected to copy
    // its full payload into them; if not, the contents are
    // unspecified (may be zero, may be stale data from a freed
    // region of a prior allocation).
    return dataPointer;
  }

  /**
   * Write a TYPE_MSGPACK_REF value to a 16-byte value slot.
   * Layout A: data_lo holds a segment-relative DATA pointer to an
   * OBJ.ARRAYBUFFER (whose first 4 bytes hold the payload byteLength),
   * and data_hi holds the offset within that payload where this
   * reference begins. The byte length is recovered at read time from
   * the parent ARRAYBUFFER's length field, so it is not stored on the
   * value.
   *
   * @param {number} destinationPointer - Segment-relative pointer to value slot
   * @param {number} parentDataPointer - DATA pointer to OBJ.ARRAYBUFFER
   * @param {number} offset - Byte offset within the payload
   */
  writeMsgpackRef(destinationPointer, parentDataPointer, offset) {
    const absolutePointer = this.abs(destinationPointer);
    this.view.setUint32(absolutePointer, TYPE.MSGPACK_REF, true);
    this.view.setUint32(absolutePointer + 4, 0, true);
    this.view.setUint32(absolutePointer + 8, parentDataPointer, true);
    this.view.setUint32(absolutePointer + 12, offset, true);
  }

  /**
   * Marshal a JS array to heap, returning the header pointer.
   * Recursively marshals nested values.
   *
   * @param {Array} jsArray - JS array to marshal
   * @param {Object} options - Optional callbacks (passed to writeValueAt)
   * @returns {number} - Segment-relative header pointer to allocated array
   */
  marshalArray(jsArray, options = {}) {
    const arrayPointer = this.allocateArrayWithCapacity(jsArray.length);
    for (let i = 0; i < jsArray.length; i++) {
      this.arraySetByMarshal(arrayPointer, i, jsArray[i], options);
    }
    return arrayPointer;
  }

  /**
   * Set an array element by marshalling a JS value.
   * @param {number} arrayPointer - Header pointer to array
   * @param {number} index - Array index
   * @param {*} jsValue - JS value to set
   * @param {Object} options - Optional callbacks (passed to writeValueAt)
   */
  arraySetByMarshal(arrayPointer, index, jsValue, options = {}) {
    const absArray = this.abs(arrayPointer);
    const count = this.view.getUint32(absArray + GC_HEADER_SIZE, true);
    const capacity = this.view.getUint32(absArray + GC_HEADER_SIZE + 4, true);
    const elementsPointer = this.view.getUint32(absArray + GC_HEADER_SIZE + 8, true);

    if (index >= capacity) {
      throw new Error(`Array index ${index} out of bounds (capacity ${capacity})`);
    }

    // Elements are 16 bytes each, after GC header
    const elementPointer = elementsPointer + GC_HEADER_SIZE + index * VALUE_SIZE;
    this.writeValueAt(elementPointer, jsValue, options);

    // Update count if needed
    if (index >= count) {
      this.view.setUint32(absArray + GC_HEADER_SIZE, index + 1, true);
    }
  }

  /**
   * Marshal a JS object to heap, returning the header pointer.
   * Recursively marshals nested values.
   *
   * @param {Object} jsObj - JS object to marshal
   * @param {Object} options - Optional callbacks (passed to writeValueAt)
   * @returns {number} - Segment-relative header pointer to allocated object
   */
  marshalObject(jsObj, options = {}) {
    const keys = Object.keys(jsObj);
    const objectPointer = this.allocateObject(keys.length);
    for (const key of keys) {
      this.objectSetByMarshal(objectPointer, key, jsObj[key], options);
    }
    return objectPointer;
  }

  /**
   * Set an object property by marshalling a JS value.
   * @param {number} objectPointer - Header pointer to object
   * @param {string} key - Property name
   * @param {*} jsValue - JS value to set
   * @param {Object} options - Optional callbacks
   * @param {Function} options.marshal - (value) => { type, dataLo, dataHi } | undefined
   */
  objectSetByMarshal(objectPointer, key, jsValue, options = {}) {
    const keyOffset = this.internString(key);

    // Determine type and data for the value
    let type, dataLo = 0, dataHi = 0;

    // Try callback first for custom types (per-call override)
    if (options.marshal) {
      const result = options.marshal(jsValue);
      if (result !== undefined) {
        type = result.type;
        dataLo = result.dataLo ?? 0;
        dataHi = result.dataHi ?? 0;
        this.objectSetRaw(objectPointer, keyOffset, type, dataLo, dataHi);
        return;
      }
    }

    // Detector chain — registered defaults for wrapper types.
    for (const detect of this._marshalDetectors) {
      const result = detect(jsValue, options);
      if (result !== undefined) {
        this.objectSetRaw(objectPointer, keyOffset, result.type, result.dataLo ?? 0, result.dataHi ?? 0);
        return;
      }
    }

    if (jsValue === null) {
      type = TYPE.NULL;
    } else if (jsValue === undefined) {
      type = TYPE.UNDEFINED;
    } else if (typeof jsValue === 'boolean') {
      type = TYPE.BOOLEAN;
      dataLo = jsValue ? 1 : 0;
    } else if (typeof jsValue === 'number') {
      type = TYPE.FLOAT;
      // Store float64 as two u32s
      const tempBuf = new ArrayBuffer(8);
      const tempView = new DataView(tempBuf);
      tempView.setFloat64(0, jsValue, true);
      dataLo = tempView.getUint32(0, true);
      dataHi = tempView.getUint32(4, true);
    } else if (typeof jsValue === 'string') {
      type = TYPE.STRING;
      dataLo = this.internString(jsValue);
    } else if (typeof jsValue === 'bigint') {
      // Symmetry with the standalone marshal path (writeValueAt's
      // bigint arm above): SS marshals integers OUT to JS as BigInt
      // (when out of Number range or by option), so the same value
      // must round-trip back IN. Without this arm, capabilities that
      // receive a BigInt identifier from onGrantRequest and try to
      // surface it through a structured handler return value would
      // hit "Cannot marshal value of type bigint".
      type = TYPE.BIGINT;
      dataLo = this.marshalBigInt(jsValue);
    } else if (jsValue instanceof Uint8Array) {
      if (jsValue.buffer === this.buffer) {
        const bufferDataPointer = jsValue.byteOffset - this.baseOffset - 4;
        dataLo = this.allocateTypedArrayDescriptor(
          bufferDataPointer, 0, jsValue.byteLength);
      } else {
        const bufferDataPointer = this.allocateArrayBuffer(jsValue.byteLength);
        const bytesStart = this.abs(bufferDataPointer + 4);
        this.u8.set(jsValue, bytesStart);
        dataLo = this.allocateTypedArrayDescriptor(
          bufferDataPointer, 0, jsValue.byteLength);
      }
      type = TYPE.UINT8ARRAY;
    } else if (jsValue instanceof ArrayBuffer) {
      const bufferDataPointer = this.allocateArrayBuffer(jsValue.byteLength);
      const bytesStart = this.abs(bufferDataPointer + 4);
      this.u8.set(new Uint8Array(jsValue), bytesStart);
      dataLo = bufferDataPointer;
      type = TYPE.ARRAYBUFFER;
    } else if (Array.isArray(jsValue)) {
      type = TYPE.ARRAY;
      dataLo = this.marshalArray(jsValue, options);
    } else if (jsValue instanceof Map) {
      // Mirror of the writeValueAt arm — before the generic object arm — so a
      // JS Map nested as an object PROPERTY value marshals correctly too.
      type = TYPE.MAP;
      dataLo = this.marshalMap(jsValue, options);
    } else if (jsValue instanceof Set) {
      type = TYPE.SET;
      dataLo = this.marshalSet(jsValue, options);
    } else if (typeof jsValue === 'object') {
      type = TYPE.OBJECT;
      dataLo = this.marshalObject(jsValue, options);
    } else {
      throw new Error(`Cannot marshal value of type ${typeof jsValue}`);
    }

    this.objectSetRaw(objectPointer, keyOffset, type, dataLo, dataHi);
  }

  // readValueAt and the unmarshal* family (unmarshalArray, unmarshalObject,
  // unmarshalMsgpack*, unmarshalBigInt, unmarshalRational, unmarshalComplex)
  // live on MemoryReader.

  /**
   * Enumerate all interned strings in the hash table.
   * Yields each unique string stored in the string table.
   *
   * @yields {string} - Interned strings
   */
  *enumerateStrings() {
    const regionSize = this.getStringEnd() - this.getStringStart();
    const hashTableStart = this.getStringEnd() - hashTableSize(regionSize);
    const bucketCount = hashTableBuckets(regionSize);

    for (let i = 0; i < bucketCount; i++) {
      const bucketAddr = hashTableStart + i * 8;
      const absBucket = this.abs(bucketAddr);
      const hash = this.view.getUint32(absBucket, true);

      if (hash !== 0) {
        const stringOffset = this.view.getUint32(absBucket + 4, true);
        if (stringOffset !== 0) {
          yield this.readString(stringOffset);
        }
      }
    }
  }

  // enumerateHeapObjects lives on MemoryReader.

  // ===========================================================================
  // Execution Contexts (v6: multi-context support)
  // ===========================================================================

  // Context table and generation-table readers live on MemoryReader.

  /**
   * Set the number of allocated context slots.
   * @param {number} count
   */
  setContextCount(count) {
    this.view.setUint32(this.abs(STATE.CONTEXT_COUNT), count, true);
  }

  /**
   * Set a slot's context-object pointer in the slot→pointer table.
   * @param {number} slot
   * @param {number} contextPointer - segment-relative context object address
   */
  setContextPointer(slot, contextPointer) {
    const tableBase = this.getContextTablePointer();
    this.view.setUint32(this.abs(tableBase + slot * 4), contextPointer, true);
  }

  /**
   * Set one slot's allocation generation.
   * @param {number} slot
   * @param {number} generation
   */
  setContextGeneration(slot, generation) {
    const tableBase = this.getContextGenerationTablePointer();
    this.view.setUint32(this.abs(tableBase + slot * 4), generation, true);
  }

  /**
   * Grow one of a context's stacks to a block of double the capacity, copying
   * its live bytes. The JS mirror of the WAT $grow_stack (interpreter.wat): same
   * realloc-and-copy, same OBJ.STACK_BLOCK, same field rewrite, old block
   * orphaned for gc. Used by the host-side push helpers (pushFrame, pushPending,
   * pushTryEntry, pushGrantEntry*) so they grow on overflow instead of throwing
   * — matching the WAT push paths after the per-stack-growth change (f35041b).
   *
   * @param {number} slot
   * @param {number} baseField - CTX.*_BASE offset
   * @param {number} limitField - CTX.*_LIMIT offset
   * @param {number} pointerField - CTX.*_POINTER offset
   */
  _growStack(slot, baseField, limitField, pointerField) {
    const stateBase = this.abs(this.getContextStateBase(slot));
    const oldBase = this.view.getUint32(stateBase + baseField, true);
    const oldLimit = this.view.getUint32(stateBase + limitField, true);
    const oldPointer = this.view.getUint32(stateBase + pointerField, true);
    const used = oldPointer - oldBase;
    const newCapacity = (oldLimit - oldBase) * 2;

    // allocate() carves a GC-headed block and returns its segment-relative data
    // pointer. It throws HeapPressureSignal if the heap is full — propagated to
    // the caller, who handles it the same as any other allocation under pressure.
    const newBase = this.allocate(newCapacity, OBJ.STACK_BLOCK);

    // Copy live bytes old → new.
    this.u8.copyWithin(this.abs(newBase), this.abs(oldBase), this.abs(oldBase) + used);

    // Rewrite base/limit/pointer to the new block; the top keeps its offset.
    this.view.setUint32(stateBase + baseField, newBase, true);
    this.view.setUint32(stateBase + limitField, newBase + newCapacity, true);
    this.view.setUint32(stateBase + pointerField, newBase + used, true);
  }

  /**
   * Allocate a context slot.
   * Scans for first free slot, or allocates new slot if none free, growing
   * the slot→pointer table when the next slot would exceed its capacity.
   * Concurrency is bounded by the heap alone: the only failure mode is
   * HeapPressureSignal from the growth/context allocations (genuine OOM
   * once the caller's gc-and-retry doesn't relieve it).
   * @returns {number} - Slot index of allocated context
   */
  allocateContext() {
    const count = this.getContextCount();
    let slot = count;

    for (let i = 0; i < count; i++) {
      if (this.getExitCondition(i) === CONTEXT_STATUS_FREE) {
        slot = i;
        break;
      }
    }

    if (slot >= this.getContextTableCapacity()) {
      this._growContextTable(slot);
    }
    if (slot === count) {
      this.setContextCount(slot + 1);
      writeHeaderEventRingEntry(this.view, this.baseOffset, {
        kind: HEADER_EVENT_KIND.FIELD_WRITE,
        field: HEADER_EVENT_FIELD.CONTEXT_COUNT,
        site: HEADER_EVENT_SITE.JS_ALLOCATE_CONTEXT,
        slot,
        oldValue: count,
        newValue: slot + 1,
      });
    }

    const previousGeneration = this.getContextGeneration(slot);
    if (previousGeneration === 0xffffffff) {
      throw new Error(
        `allocateContext: generation exhausted for reusable slot ${slot}`);
    }
    this.setContextGeneration(slot, previousGeneration + 1);
    this._initializeContext(slot);
    return slot;
  }

  /**
   * Grow the slot→pointer table to a block of double the capacity, copying
   * the live entries. Same realloc-and-copy as _growStack: the old block is
   * orphaned for gc, and STATE.CONTEXT_TABLE_POINTER is repointed at the new
   * one. allocate() never moves existing objects, so the old table stays
   * readable for the copy; if it throws HeapPressureSignal, nothing was
   * repointed and the whole allocateContext retries cleanly after gc.
   * @param {number} [triggeringSlot] - The slot whose allocateContext call
   *   triggered this growth. 0xFF is recorded as "no slot" when called
   *   outside that path.
   */
  _growContextTable(triggeringSlot = 0xFF) {
    const oldTable = this.getContextTablePointer();
    const oldGenerationTable = this.getContextGenerationTablePointer();
    const oldBytes = this.getContextTableCapacity() * 4;
    const newTable = this.allocate(oldBytes * 2, OBJ.STACK_BLOCK);
    const newGenerationTable = this.allocate(oldBytes * 2, OBJ.STACK_BLOCK);
    const newHeaderWord = this.view.getUint32(
      this.abs(newTable - GC_HEADER_SIZE), true);
    const newBytes = (newHeaderWord & 0x00ffffff) - GC_HEADER_SIZE;

    this.u8.copyWithin(
      this.abs(newTable), this.abs(oldTable), this.abs(oldTable) + oldBytes);
    this.u8.copyWithin(
      this.abs(newGenerationTable),
      this.abs(oldGenerationTable),
      this.abs(oldGenerationTable) + oldBytes,
    );
    this.u8.fill(0, this.abs(newTable + oldBytes), this.abs(newTable + newBytes));
    this.u8.fill(
      0,
      this.abs(newGenerationTable + oldBytes),
      this.abs(newGenerationTable + newBytes),
    );

    this.setState(STATE.CONTEXT_TABLE_POINTER, newTable);
    this.setState(
      STATE.CONTEXT_GENERATION_TABLE_POINTER, newGenerationTable);
    writeHeaderEventRingEntry(this.view, this.baseOffset, {
      kind: HEADER_EVENT_KIND.CONTEXT_TABLE_GROWTH,
      site: HEADER_EVENT_SITE.JS_GROW_CONTEXT_TABLE,
      slot: triggeringSlot,
      oldValue: oldTable,
      newValue: newTable,
    });
  }

  /**
   * Initialize a context: allocate its heap context object + four stack blocks,
   * record the object in the slot→pointer table, and set up empty stacks.
   *
   * Design B: the context object IS the state block; each stack is its own
   * STACK_BLOCK heap object. The state block stores each stack's base/limit and
   * its top pointer (initially == base, i.e. empty).
   *
   * @param {number} slot - Context slot index
   */
  _initializeContext(slot) {
    // Allocate the context object (the state block) and the four stack blocks.
    // allocate() never moves existing objects, so these pointers stay valid
    // across the calls below.
    const contextPointer = this.allocate(CONTEXT_OBJECT_SIZE, OBJ.CONTEXT);
    const pendingBase    = this.allocate(CONTEXT_PENDING_INITIAL_SIZE,    OBJ.STACK_BLOCK);
    const callStackBase  = this.allocate(CONTEXT_CALL_STACK_INITIAL_SIZE, OBJ.STACK_BLOCK);
    const tryStackBase   = this.allocate(CONTEXT_TRY_STACK_INITIAL_SIZE,  OBJ.STACK_BLOCK);
    const grantStackBase = this.allocate(CONTEXT_GRANT_STACK_INITIAL_SIZE, OBJ.STACK_BLOCK);

    // Publish the context object's address into the slot→pointer table.
    this.setContextPointer(slot, contextPointer);

    const stateBase = this.abs(contextPointer + CONTEXT_STATE_OFFSET);

    // Zero the whole context object (exit condition 0 = "no exit yet").
    for (let i = 0; i < CONTEXT_OBJECT_SIZE; i += 4) {
      this.view.setUint32(stateBase + i, 0, true);
    }

    // Default scope to root. Every context needs SOME scope to run —
    // without one, the very first variable access dereferences scope
    // address 0 and the interpreter spuriously reports memory_pressure
    // (see CLAUDE.md, "A Fresh Context Needs a Default Scope"). bootstrap()
    // overwrites this for context 0 once the root scope itself exists
    // (getRootScope() reads 0 here, harmlessly, during that one call);
    // setupCallbackContext/createConfiguredContext overwrite it for
    // every other real caller with the scope the context actually
    // needs. This default only matters for a caller that runs a bare
    // allocateContext() slot without going through either.
    this.view.setUint32(stateBase + CTX.SCOPE, this.getRootScope(), true);

    // Stack block base/limit fields.
    this.view.setUint32(stateBase + CTX.PENDING_BASE, pendingBase, true);
    this.view.setUint32(stateBase + CTX.PENDING_LIMIT, pendingBase + CONTEXT_PENDING_INITIAL_SIZE, true);
    this.view.setUint32(stateBase + CTX.CALL_STACK_BASE, callStackBase, true);
    this.view.setUint32(stateBase + CTX.CALL_STACK_LIMIT, callStackBase + CONTEXT_CALL_STACK_INITIAL_SIZE, true);
    this.view.setUint32(stateBase + CTX.TRY_STACK_BASE, tryStackBase, true);
    this.view.setUint32(stateBase + CTX.TRY_STACK_LIMIT, tryStackBase + CONTEXT_TRY_STACK_INITIAL_SIZE, true);
    this.view.setUint32(stateBase + CTX.GRANT_STACK_BASE, grantStackBase, true);
    this.view.setUint32(stateBase + CTX.GRANT_STACK_LIMIT, grantStackBase + CONTEXT_GRANT_STACK_INITIAL_SIZE, true);

    // Empty stacks: top pointer == base.
    this.view.setUint32(stateBase + CTX.PENDING_POINTER, pendingBase, true);
    this.view.setUint32(stateBase + CTX.CALL_STACK_POINTER, callStackBase, true);
    this.view.setUint32(stateBase + CTX.TRY_STACK_POINTER, tryStackBase, true);
    this.view.setUint32(stateBase + CTX.GRANT_STACK_POINTER, grantStackBase, true);
  }

  /**
   * Free a context. The context object and its stack blocks become heap garbage
   * (reclaimed by the collector). Freeness lives in the slot→pointer TABLE (a
   * zeroed entry), never in the reclaimable state block: the old protocol —
   * "table entry kept, FREE exit condition read from the block" — dangled
   * after the first GC swept the block, and the next GC (or the reuse scan)
   * read whatever bytes had been reallocated there. Bytes ≠ FREE resurrected a
   * phantom context whose "stacks" were arbitrary data — the collector walked
   * and FORWARDED through them (silent heap poisoning, wasm OOB traps, and the
   * Collector.abs out-of-bounds storm; console-host corruption, 2026-07-02).
   * @param {number} slot - Context slot index
   */
  freeContext(slot, generation = this.getContextGeneration(slot)) {
    if (!this.isContextIdentityLive(slot, generation)) {
      throw new Error(
        `freeContext: stale context identity (${slot}, ${generation}); ` +
        `current generation is ${this.getContextGeneration(slot)}`);
    }
    const stateBase = this.abs(this.getContextStateBase(slot));
    this.view.setUint32(
      stateBase + CTX.EXIT_CONDITION, CONTEXT_STATUS_FREE, true);
    this.setContextPointer(slot, 0);
  }

  /**
   * Reset all stacks for a context to their empty state (top pointer == base).
   * Used when setting up a fresh context for callback execution.
   * @param {number} slot - Context slot index
   */
  resetContextStacks(slot) {
    const stateBase = this.abs(this.getContextStateBase(slot));
    this.view.setUint32(stateBase + CTX.PENDING_POINTER,
      this.view.getUint32(stateBase + CTX.PENDING_BASE, true), true);
    this.view.setUint32(stateBase + CTX.CALL_STACK_POINTER,
      this.view.getUint32(stateBase + CTX.CALL_STACK_BASE, true), true);
    this.view.setUint32(stateBase + CTX.TRY_STACK_POINTER,
      this.view.getUint32(stateBase + CTX.TRY_STACK_BASE, true), true);
    this.view.setUint32(stateBase + CTX.GRANT_STACK_POINTER,
      this.view.getUint32(stateBase + CTX.GRANT_STACK_BASE, true), true);
  }

  /**
   * Create a fully configured context ready to execute.
   *
   * @param {Object} options
   * @param {number} options.scopePointer - Scope to use (required)
   * @param {number} [options.instructionIndex=0] - Starting instruction
   * @param {boolean} [options.createChildScope=false] - If true, creates a child of scopePointer instead of using it directly
   * @returns {number} - Allocated context slot
   */
  createConfiguredContext(options) {
    const { scopePointer, instructionIndex = 0, createChildScope = false } = options;

    const slot = this.allocateContext();

    // Set up scope
    const actualScope = createChildScope
      ? this.createScope(scopePointer)
      : scopePointer;
    this.setContextScope(slot, actualScope);

    // Set instruction pointer (exit condition is already 0 from zeroed state block)
    this.setContextInstructionIndex(slot, instructionIndex);

    return slot;
  }

  // ---------------------------------------------------------------------------
  // Context state field accessors
  // ---------------------------------------------------------------------------

  // Context-state field readers (getExitCondition, getResponseType,
  // getContextInstructionIndex, getContextScope, getContextPendingPointer,
  // getContextCallStackPointer, getContextGrantStackPointer,
  // getContextTryStackPointer, getContextCompletionType,
  // getContextCompletionValue, getContextContinuationId,
  // getContextWaitingOn, getContextNextWaiter) live on MemoryReader.

  /**
   * Clear exit condition so context can resume.
   * Used when resuming a context that was paused (e.g., from AWAIT).
   * @param {number} slot
   */
  clearExitCondition(slot) {
    const stateBase = this.abs(this.getContextStateBase(slot));
    this.view.setUint32(stateBase + CTX.EXIT_CONDITION, 0, true);
  }

  /**
   * Set response type (host → interpreter input).
   * @param {number} slot
   * @param {number} type - RESPONSE_NORMAL or RESPONSE_THROW
   */
  setResponseType(slot, type) {
    const stateBase = this.abs(this.getContextStateBase(slot));
    this.view.setUint32(stateBase + CTX.RESPONSE_TYPE, type, true);
  }

  /**
   * Set context instruction index.
   * @param {number} slot
   * @param {number} value
   */
  setContextInstructionIndex(slot, value) {
    const stateBase = this.abs(this.getContextStateBase(slot));
    this.view.setUint32(stateBase + CTX.INSTRUCTION_INDEX, value, true);
  }

  /**
   * Set the host continuation identifier used to reject stale callbacks.
   * @param {number} slot
   * @param {number} continuationId
   */
  setContextContinuationId(slot, continuationId) {
    const stateBase = this.abs(this.getContextStateBase(slot));
    this.view.setUint32(
      stateBase + CTX.CONTINUATION_ID, continuationId, true);
  }

  /**
   * Set context scope pointer.
   * @param {number} slot
   * @param {number} value
   */
  setContextScope(slot, value) {
    const stateBase = this.abs(this.getContextStateBase(slot));
    this.view.setUint32(stateBase + CTX.SCOPE, value, true);
  }

  /**
   * Set context pending stack pointer.
   * @param {number} slot
   * @param {number} value
   */
  setContextPendingPointer(slot, value) {
    const stateBase = this.abs(this.getContextStateBase(slot));
    this.view.setUint32(stateBase + CTX.PENDING_POINTER, value, true);
  }

  /**
   * Set context call stack pointer.
   * @param {number} slot
   * @param {number} value
   */
  setContextCallStackPointer(slot, value) {
    const stateBase = this.abs(this.getContextStateBase(slot));
    this.view.setUint32(stateBase + CTX.CALL_STACK_POINTER, value, true);
  }

  /**
   * Set context grant stack pointer.
   * @param {number} slot
   * @param {number} value
   */
  setContextGrantStackPointer(slot, value) {
    const stateBase = this.abs(this.getContextStateBase(slot));
    this.view.setUint32(stateBase + CTX.GRANT_STACK_POINTER, value, true);
  }

  /**
   * Set context try stack pointer.
   * @param {number} slot
   * @param {number} value
   */
  setContextTryStackPointer(slot, value) {
    const stateBase = this.abs(this.getContextStateBase(slot));
    this.view.setUint32(stateBase + CTX.TRY_STACK_POINTER, value, true);
  }

  /**
   * Set context completion type.
   * @param {number} slot
   * @param {number} value
   */
  setContextCompletionType(slot, value) {
    const stateBase = this.abs(this.getContextStateBase(slot));
    this.view.setUint32(stateBase + CTX.COMPLETION_TYPE, value, true);
  }

  /**
   * Generator-object header pointer this context is the body of
   * (0 = not a generator context). INTERNALS.md's Generators section.
   * @param {number} slot
   */
  getContextGeneratorObject(slot) {
    const stateBase = this.abs(this.getContextStateBase(slot));
    return this.view.getUint32(stateBase + CTX.GENERATOR_OBJECT, true);
  }

  /**
   * @param {number} slot
   * @param {number} value - generator object HEADER pointer
   */
  setContextGeneratorObject(slot, value) {
    const stateBase = this.abs(this.getContextStateBase(slot));
    this.view.setUint32(stateBase + CTX.GENERATOR_OBJECT, value, true);
  }

  /**
   * Return whether a context is an embedder invocation root.
   * @param {number} slot
   * @returns {boolean}
   */
  isContextInvocationRoot(slot) {
    const stateBase = this.abs(this.getContextStateBase(slot));
    const value = this.view.getUint32(stateBase + CTX.INVOCATION_ROOT, true);
    if (value !== 0 && value !== 1) {
      throw new Error(
        `isContextInvocationRoot: context ${slot} has invalid marker ${value}`);
    }
    return value === 1;
  }

  /**
   * Mark a context as an embedder invocation root.
   * @param {number} slot
   */
  markContextInvocationRoot(slot) {
    const stateBase = this.abs(this.getContextStateBase(slot));
    this.view.setUint32(stateBase + CTX.INVOCATION_ROOT, 1, true);
  }

  /**
   * Set context completion value.
   * @param {number} slot
   * @param {number} value
   */
  setContextCompletionValue(slot, value) {
    const stateBase = this.abs(this.getContextStateBase(slot));
    this.view.setUint32(stateBase + CTX.COMPLETION_VALUE, value, true);
  }

  /**
   * Set the promise pointer this context is waiting on.
   * @param {number} slot
   * @param {number} promisePointer - Promise data pointer, or 0 if not waiting
   */
  setContextWaitingOn(slot, promisePointer) {
    const stateBase = this.abs(this.getContextStateBase(slot));
    this.view.setUint32(stateBase + CTX.WAITING_ON, promisePointer, true);
  }

  // ===========================================================================
  // Promise
  // ===========================================================================

  /**
   * Create a new pending promise on the heap.
   * @returns {number} - Data pointer to the new promise
   */
  createPromise() {
    // allocate() handles GC header and returns data pointer
    const dataPointer = this.allocate(PROMISE_DATA_SIZE, OBJ.PROMISE);
    const absData = this.abs(dataPointer);

    // Initialize promise fields
    this.view.setUint32(absData + PROMISE.STATUS, PROMISE_STATUS_PENDING, true);
    // Value: 16 bytes of zeros (undefined)
    this.view.setUint32(absData + PROMISE.VALUE, TYPE.UNDEFINED, true);
    this.view.setUint32(absData + PROMISE.VALUE + 4, 0, true);
    this.view.setUint32(absData + PROMISE.VALUE + 8, 0, true);
    this.view.setUint32(absData + PROMISE.VALUE + 12, 0, true);
    // Waiters: zero data pointer (empty list)
    this.view.setUint32(absData + PROMISE.WAITERS, 0, true);
    // Handlers: -1 (empty list)
    this.view.setInt32(absData + PROMISE.HANDLERS, -1, true);

    return dataPointer;
  }

  // getPromiseStatus lives on MemoryReader.

  /**
   * Set promise status.
   * @param {number} promisePointer - Data pointer to promise
   * @param {number} status - 0=pending, 1=resolved, 2=rejected
   */
  setPromiseStatus(promisePointer, status) {
    this.view.setUint32(this.abs(promisePointer) + PROMISE.STATUS, status, true);
  }

  // getPromiseValue lives on MemoryReader.

  /**
   * Set promise value (16-byte tagged value).
   * @param {number} promisePointer
   * @param {number} type
   * @param {number} flags
   * @param {number} lo
   * @param {number} hi
   */
  setPromiseValue(promisePointer, type, flags, lo, hi) {
    const address = this.abs(promisePointer) + PROMISE.VALUE;
    this.view.setUint32(address, type, true);
    this.view.setUint32(address + 4, flags, true);
    this.view.setUint32(address + 8, lo, true);
    this.view.setUint32(address + 12, hi, true);
  }

  /**
   * Marshal a JavaScript value into a promise's inline VALUE field.
   * @param {number} promisePointer
   * @param {*} value
   * @param {object} options
   */
  marshalPromiseValue(promisePointer, value, options = {}) {
    this.writeValueAt(promisePointer + PROMISE.VALUE, value, options);
  }

  /**
   * @param {number} promisePointer
   * @param {number} waiterPointer - PromiseWaiter data pointer, or zero
   */
  setPromiseWaiters(promisePointer, waiterPointer) {
    this.view.setUint32(
      this.abs(promisePointer) + PROMISE.WAITERS, waiterPointer, true);
  }

  /**
   * Add a generation-safe waiter node to a pending promise.
   * The node is fully initialized before it becomes the promise head.
   * @param {number} promisePointer
   * @param {number} contextSlot
   * @returns {number} waiter data pointer
   */
  addWaiterToPromise(promisePointer, contextSlot) {
    const currentHead = this.getPromiseWaiters(promisePointer);
    const waiterPointer =
      this.allocate(PROMISE_WAITER_DATA_SIZE, OBJ.PROMISE_WAITER);
    const address = this.abs(waiterPointer);
    this.view.setUint32(
      address + PROMISE_WAITER.CONTEXT_SLOT, contextSlot, true);
    this.view.setUint32(
      address + PROMISE_WAITER.CONTEXT_GENERATION,
      this.getContextGeneration(contextSlot), true);
    this.view.setUint32(
      address + PROMISE_WAITER.NEXT, currentHead, true);
    this.setContextWaitingOn(contextSlot, promisePointer);
    this.setPromiseWaiters(promisePointer, waiterPointer);
    return waiterPointer;
  }

  /**
   * Unlink one generation-safe waiter without disturbing neighboring nodes.
   * @param {number} promisePointer
   * @param {number} contextSlot
   * @param {number} contextGeneration
   * @returns {boolean}
   */
  removeWaiterFromPromise(
    promisePointer,
    contextSlot,
    contextGeneration,
  ) {
    let previous = 0;
    let current = this.getPromiseWaiters(promisePointer);
    const capacity = this.getContextTableCapacity();
    for (let visited = 0; current !== 0; visited++) {
      if (visited >= capacity) {
        throw new Error(
          `removeWaiterFromPromise: waiter list of promise ` +
          `${promisePointer} exceeds the context table capacity (${capacity})`);
      }
      const address = this.abs(current);
      const slot = this.view.getUint32(
        address + PROMISE_WAITER.CONTEXT_SLOT, true);
      const generation = this.view.getUint32(
        address + PROMISE_WAITER.CONTEXT_GENERATION, true);
      const next = this.view.getUint32(
        address + PROMISE_WAITER.NEXT, true);
      if (slot === contextSlot && generation === contextGeneration) {
        if (previous === 0) {
          this.setPromiseWaiters(promisePointer, next);
        } else {
          this.view.setUint32(
            this.abs(previous) + PROMISE_WAITER.NEXT, next, true);
        }
        if (this.isContextIdentityLive(contextSlot, contextGeneration)) {
          this.setContextWaitingOn(contextSlot, 0);
        }
        return true;
      }
      previous = current;
      current = next;
    }
    return false;
  }

  /**
   * Detach and decode every waiter node.
   * @param {number} promisePointer
   * @returns {Array<{slot:number, generation:number}>}
   */
  popAllWaiters(promisePointer) {
    const waiters = [];
    let current = this.getPromiseWaiters(promisePointer);
    this.setPromiseWaiters(promisePointer, 0);
    const capacity = this.getContextTableCapacity();
    while (current !== 0) {
      if (waiters.length >= capacity) {
        throw new Error(
          `popAllWaiters: waiter list of promise ${promisePointer} exceeds ` +
          `the context table capacity (${capacity})`);
      }
      const address = this.abs(current);
      const slot = this.view.getUint32(
        address + PROMISE_WAITER.CONTEXT_SLOT, true);
      const generation = this.view.getUint32(
        address + PROMISE_WAITER.CONTEXT_GENERATION, true);
      const next = this.view.getUint32(
        address + PROMISE_WAITER.NEXT, true);
      waiters.push({ slot, generation });
      if (this.isContextIdentityLive(slot, generation)) {
        this.setContextWaitingOn(slot, 0);
      }
      current = next;
    }
    return waiters;
  }

  // ===========================================================================
  // Promise Handler List (.then/.catch/.finally)
  // ===========================================================================

  // getPromiseHandlers lives on MemoryReader.

  /**
   * Set the head of a promise's handler list.
   * @param {number} promisePointer - Data pointer to promise
   * @param {number} handlerPointer - Handler data pointer, or -1 for empty
   */
  setPromiseHandlers(promisePointer, handlerPointer) {
    this.view.setInt32(this.abs(promisePointer) + PROMISE.HANDLERS, handlerPointer, true);
  }

  /**
   * Create a ThenHandler heap object.
   * @param {number} onResolved - Closure pointer (0 if none)
   * @param {number} onRejected - Closure pointer (0 if none)
   * @param {number} childPromise - Promise data pointer
   * @param {boolean} isFinally - Whether this is a .finally() handler
   * @returns {number} - Data pointer to the new handler
   */
  createThenHandler(onResolved, onRejected, childPromise, isFinally = false) {
    const dataPointer = this.allocate(THEN_HANDLER_DATA_SIZE, OBJ.THEN_HANDLER);
    const absData = this.abs(dataPointer);

    this.view.setUint32(absData + THEN_HANDLER.ON_RESOLVED, onResolved, true);
    this.view.setUint32(absData + THEN_HANDLER.ON_REJECTED, onRejected, true);
    this.view.setUint32(absData + THEN_HANDLER.CHILD_PROMISE, childPromise, true);
    this.view.setInt32(absData + THEN_HANDLER.NEXT, -1, true);
    this.view.setUint32(absData + THEN_HANDLER.FLAGS, isFinally ? THEN_HANDLER_FLAG_FINALLY : 0, true);

    return dataPointer;
  }

  // getThenHandler lives on MemoryReader.

  /**
   * Set the FLAGS field of a ThenHandler.
   * Used by Promise.all to store the index, and Promise.race to store -1.
   * @param {number} handlerPointer - Data pointer to handler
   * @param {number} flags - Value to write to FLAGS field
   */
  setThenHandlerFlags(handlerPointer, flags) {
    this.view.setInt32(this.abs(handlerPointer + THEN_HANDLER.FLAGS), flags, true);
  }

  /**
   * Append a handler to a promise's handler list (tail append).
   * @param {number} promisePointer - Data pointer to promise
   * @param {number} handlerPointer - Data pointer to handler to append
   */
  appendThenHandler(promisePointer, handlerPointer) {
    const head = this.getPromiseHandlers(promisePointer);
    if (head === -1) {
      this.setPromiseHandlers(promisePointer, handlerPointer);
      return;
    }
    // Walk to tail
    let current = head;
    while (true) {
      const absData = this.abs(current);
      const next = this.view.getInt32(absData + THEN_HANDLER.NEXT, true);
      if (next === -1) {
        this.view.setInt32(absData + THEN_HANDLER.NEXT, handlerPointer, true);
        return;
      }
      current = next;
    }
  }

  /**
   * Pop all handlers from a promise's handler list.
   * Returns the list and clears it from the promise.
   * @param {number} promisePointer - Data pointer to promise
   * @returns {object[]} - Array of { onResolved, onRejected, childPromise, isFinally }
   */
  popAllHandlers(promisePointer) {
    const handlers = [];
    let current = this.getPromiseHandlers(promisePointer);
    while (current !== -1) {
      const handler = this.getThenHandler(current);
      handlers.push(handler);
      current = handler.next;
    }
    this.setPromiseHandlers(promisePointer, -1);
    return handlers;
  }

  // ===========================================================================
  // Frame Async Promise
  // ===========================================================================

  // getFrameAsyncPromise lives on MemoryReader.

  /**
   * Set the async promise pointer in a call frame.
   * @param {number} framePointer - Absolute pointer to frame
   * @param {number} promisePointer - Promise data pointer, or 0 for non-async frames
   */
  setFrameAsyncPromise(framePointer, promisePointer) {
    this.view.setUint32(framePointer + FRAME.ASYNC_PROMISE, promisePointer, true);
  }

  // ===========================================================================
  // BigInt
  // ===========================================================================

  /**
   * Allocate a BigInt on the heap.
   *
   * Heap layout: [GC header: 8][sign: 4][length: 4][limbs: length * 4]
   * Limbs are 32-bit words, little-endian (least significant first).
   * The most significant limb is always non-zero (normalized).
   * Zero is represented as sign=0, length=0.
   *
   * @param {number} sign - 0 = positive/zero, 1 = negative
   * @param {Uint32Array|number[]} limbs - Limbs in little-endian order (normalized)
   * @returns {number} - Segment-relative header pointer
   */
  allocateBigInt(sign, limbs) {
    const limbCount = limbs.length;
    const dataSize = 8 + limbCount * 4; // sign + length + limbs
    const totalSize = GC_HEADER_SIZE + dataSize;
    const aligned = (totalSize + 15) & ~15;
    this._checkHeapBudget(aligned);

    const headerPointer = this.getHeapPointer();

    // GC header — store aligned size so heap-walk stride matches allocator stride.
    const absHeader = this.abs(headerPointer);
    this.view.setUint32(absHeader, aligned | (OBJ.BIGINT << 24), true);
    this.view.setUint32(absHeader + 4, 0, true);

    // Data: sign, length, limbs
    const absData = absHeader + GC_HEADER_SIZE;
    this.view.setUint32(absData, sign, true);
    this.view.setUint32(absData + 4, limbCount, true);
    for (let i = 0; i < limbCount; i++) {
      this.view.setUint32(absData + 8 + i * 4, limbs[i], true);
    }

    this.setHeapPointer(headerPointer + aligned);
    return headerPointer;
  }

  /**
   * Allocate a Rational heap object with given numerator/denominator BigInt
   * header pointers. Does not normalize — caller is responsible for passing
   * already-reduced inputs with denominator > 0.
   * @param {number} numeratorPointer - Segment-relative BigInt header pointer
   * @param {number} denominatorPointer - Segment-relative BigInt header pointer
   * @returns {number} - Segment-relative Rational header pointer
   */
  allocateRational(numeratorPointer, denominatorPointer) {
    const totalSize = 16; // 8 GC header + 4 numerator + 4 denominator
    const aligned = (totalSize + 15) & ~15;
    this._checkHeapBudget(aligned);

    const headerPointer = this.getHeapPointer();

    const absHeader = this.abs(headerPointer);
    this.view.setUint32(absHeader, aligned | (OBJ.RATIONAL << 24), true);
    this.view.setUint32(absHeader + 4, 0, true);

    const absData = absHeader + GC_HEADER_SIZE;
    this.view.setUint32(absData, numeratorPointer, true);
    this.view.setUint32(absData + 4, denominatorPointer, true);

    this.setHeapPointer(headerPointer + aligned);
    return headerPointer;
  }

  /**
   * Allocate a Complex heap object with given real/imaginary Rational header
   * pointers. Caller is responsible for passing normalized Rationals.
   * @param {number} realPointer - Segment-relative Rational header pointer
   * @param {number} imaginaryPointer - Segment-relative Rational header pointer
   * @returns {number} - Segment-relative Complex header pointer
   */
  allocateComplex(realPointer, imaginaryPointer) {
    const totalSize = 16;
    const aligned = (totalSize + 15) & ~15;
    this._checkHeapBudget(aligned);

    const headerPointer = this.getHeapPointer();

    const absHeader = this.abs(headerPointer);
    this.view.setUint32(absHeader, aligned | (OBJ.COMPLEX << 24), true);
    this.view.setUint32(absHeader + 4, 0, true);

    const absData = absHeader + GC_HEADER_SIZE;
    this.view.setUint32(absData, realPointer, true);
    this.view.setUint32(absData + 4, imaginaryPointer, true);

    this.setHeapPointer(headerPointer + aligned);
    return headerPointer;
  }

  /**
   * Allocate a Symbol heap object. Ring 2.
   * A Symbol is a named atom with identity; two Symbols created with the
   * same description are still distinct objects (===) unless both come
   * from the global registry via Symbol.for(key).
   * @param {number} descriptionStringOffset - Interned string offset for the
   *   description, or 0 for an undescribed symbol (Symbol() with no argument).
   * @returns {number} - Segment-relative Symbol header pointer
   */
  allocateSymbol(descriptionStringOffset) {
    const totalSize = 16;
    const aligned = (totalSize + 15) & ~15;
    this._checkHeapBudget(aligned);

    const headerPointer = this.getHeapPointer();

    const absHeader = this.abs(headerPointer);
    this.view.setUint32(absHeader, aligned | (OBJ.SYMBOL << 24), true);
    this.view.setUint32(absHeader + 4, 0, true);

    const absData = absHeader + GC_HEADER_SIZE;
    this.view.setUint32(absData, descriptionStringOffset, true);
    this.view.setUint32(absData + 4, 0, true);  // reserved

    this.setHeapPointer(headerPointer + aligned);
    return headerPointer;
  }

  // readSymbolDescription lives on MemoryReader.

  /**
   * Allocate a RegExp descriptor heap object.
   * Payload: [patternStringOffset:4][flagsBitfield:4][lastIndex:4]
   * [programBufferDataPointer:4]. The flags reuse the engine's
   * REGEX_FLAG bits (regex-engine-contract.js); lastIndex counts
   * Unicode scalar values and starts at 0; the program buffer is a
   * DATA pointer to an OBJ.ARRAYBUFFER holding the validated engine
   * program and stays 0 until compilation commits (the epic's
   * commit-point rule: the pointer is published only after successful
   * emission and validation).
   * @param {number} patternStringOffset - Interned string id of the
   *   source pattern text (without delimiters or flags).
   * @param {number} flags - REGEX_FLAG bitfield.
   * @returns {number} - Segment-relative RegExp header pointer
   */
  allocateRegExp(patternStringOffset, flags) {
    const totalSize = GC_HEADER_SIZE + REGEXP.SIZE;
    const aligned = (totalSize + 15) & ~15;
    this._checkHeapBudget(aligned);

    const headerPointer = this.getHeapPointer();

    const absHeader = this.abs(headerPointer);
    this.view.setUint32(absHeader, aligned | (OBJ.REGEXP << 24), true);
    this.view.setUint32(absHeader + 4, 0, true);

    const absData = absHeader + GC_HEADER_SIZE;
    this.view.setUint32(absData + REGEXP.PATTERN_STRING, patternStringOffset, true);
    this.view.setUint32(absData + REGEXP.FLAGS, flags, true);
    this.view.setUint32(absData + REGEXP.LAST_INDEX, 0, true);
    this.view.setUint32(absData + REGEXP.PROGRAM_BUFFER, 0, true);

    this.setHeapPointer(headerPointer + aligned);
    return headerPointer;
  }

  /**
   * Allocate an Expression heap object. Ring 2.
   * Expression is a head-and-args tree: the head is a Symbol identifying
   * the operator / function (Add, Multiply, Sin, etc.); the args are a
   * regular SandScript Array whose elements are Symbol / Rational /
   * Complex / BigInt / Expression. Type-checking of args happens at
   * construction time (2b.3) — this low-level allocator accepts any
   * pointers as given.
   * @param {number} headPointer - Segment-relative Symbol header pointer
   * @param {number} argumentArrayPointer - Segment-relative Array header pointer
   * @returns {number} - Segment-relative Expression header pointer
   */
  allocateExpression(headPointer, argumentArrayPointer) {
    const totalSize = 16;
    const aligned = (totalSize + 15) & ~15;
    this._checkHeapBudget(aligned);

    const headerPointer = this.getHeapPointer();

    const absHeader = this.abs(headerPointer);
    this.view.setUint32(absHeader, aligned | (OBJ.EXPRESSION << 24), true);
    this.view.setUint32(absHeader + 4, 0, true);

    const absData = absHeader + GC_HEADER_SIZE;
    this.view.setUint32(absData, headPointer, true);
    this.view.setUint32(absData + 4, argumentArrayPointer, true);

    this.setHeapPointer(headerPointer + aligned);
    return headerPointer;
  }

  // readExpressionHead, readExpressionArgumentArray live on MemoryReader.

  /**
   * Allocate a registry-backed Symbol and register it under the given
   * description. Used at initializeBuiltins time to pre-register well-known
   * math names (Pi, E, Infinity) and Ring 2 heads (Add, Multiply, etc.) so
   * that Symbol.for(name) returns the same heap object. Assumes the
   * SYMBOL_REGISTRY has been allocated (see initializeSymbolRegistry).
   *
   * @param {string} description - Registry key and Symbol description
   * @returns {number} - Segment-relative Symbol header pointer
   */
  allocateRegisteredSymbol(description) {
    const descriptionOffset = this.internString(description);
    const symbolPointer = this.allocateSymbol(descriptionOffset);
    const registryPointer = this.getState(STATE.SYMBOL_REGISTRY);
    if (!registryPointer) {
      throw new Error('Symbol registry not initialized');
    }
    this.objectSetRaw(registryPointer, descriptionOffset, TYPE.SYMBOL, symbolPointer, 0);
    return symbolPointer;
  }

  /**
   * Check whether a Symbol is in the global registry (created via
   * Symbol.for(key)). Registry-backed Symbols have canonical identity:
   * calling Symbol.for with the same key always returns the same heap
   * object. Fresh Symbols (from Symbol(description)) are each distinct.
   *
   * Implemented by scanning the registry Object's entries for a value
   * matching the given Symbol pointer. Linear in registry size; acceptable
   * because readback is not a hot path and registry size is small in
   * practice (built-ins + user-registered names).
   *
   * @param {number} headerPointer - Segment-relative Symbol header pointer
   * @returns {boolean}
   */
  // isSymbolRegistered lives on MemoryReader.

  // readBigInt lives on MemoryReader.

  /**
   * Marshal a JS BigInt to an SS BigInt heap object.
   * @param {bigint} jsBigInt - JS BigInt value
   * @returns {number} - Segment-relative header pointer
   */
  marshalBigInt(jsBigInt) {
    const sign = jsBigInt < 0n ? 1 : 0;
    let magnitude = jsBigInt < 0n ? -jsBigInt : jsBigInt;

    const limbs = [];
    while (magnitude > 0n) {
      limbs.push(Number(magnitude & 0xFFFFFFFFn));
      magnitude >>= 32n;
    }

    return this.allocateBigInt(sign, limbs);
  }

  // unmarshalBigInt lives on MemoryReader.

  // readRational lives on MemoryReader.

  // unmarshalRational lives on MemoryReader.

  // readComplex lives on MemoryReader.

  // unmarshalComplex lives on MemoryReader.

}

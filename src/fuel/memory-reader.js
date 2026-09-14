import {
  HEADER,
  STATE,
  TYPE,
  VERSION,
  FRAME,
  FRAME_SIZE,
  VALUE_SIZE,
  FLAG_RATIONAL_INLINE,
  AST_REGION,
  INSTRUCTION_SIZE,
  TRY_ENTRY,
  TRY_ENTRY_SIZE,
  GRANT_ENTRY,
  GRANT_ENTRY_SIZE,
  CLOSURE_FLAG_ARROW,
  CLOSURE_FLAG_ASYNC,
  GC_HEADER_SIZE,
  readGCHeaderSize,
  FUNCTION,
  OBJECT_FLAG,
  PROMISE,
  THEN_HANDLER,
  THEN_HANDLER_FLAG_FINALLY,
  CONTEXT_STATE_OFFSET,
  CONTEXT_STATUS_FREE,
  CTX,
  MAP_LAYOUT,
  SET_LAYOUT,
  HEADER_EVENT_KIND,
  HEADER_EVENT_SITE,
  STRING_DATA_START,
  hashTableSize,
  OBJ,
  REGEXP,
  SCHEMA,
  SCHEMA_OPT,
} from './constants.js';
import { DRONE_FORMAT_VERSION } from '../persisted-format.js';
import { REGEX_FLAG } from './regex-engine-contract.js';

// Heap-object class names for the debug inventory are derived from the
// authoritative OBJ export. This keeps the inventory synchronized when
// classes are added or their numeric identifiers change.
const OBJECT_CLASS_NAMES = Object.fromEntries(
  Object.entries(OBJ).map(([name, id]) => [id, name.toLowerCase()]));
import { writeHeaderEventRingEntry } from './header-event-ring.js';

/**
 * SandScript Fuel-Based Interpreter - Memory Reader
 *
 * Read-only typed access to interpreter state in linear memory.
 *
 * MemoryReader is the no-WASM-needed parent class of MemoryImage.
 * It supports the segment model and exposes every read-only accessor
 * (header/STATE getters, context inspection, string reads, value
 * unmarshalling, scope walking, AST region readers, code-block
 * readers) — but no writers, no allocators, no WASM dependency.
 *
 * Construction is identical in shape to MemoryImage so a MemoryReader
 * can be built against either a live WebAssembly.Memory (the primary
 * use case — host-side inspection of a running session) or any
 * ArrayBuffer / SharedArrayBuffer that holds a sandscript segment.
 *
 * If you need to mutate, use MemoryImage instead — it extends this
 * class and adds the writers + WASM-dependent helpers.
 *
 * Keeping these accessors here allows host-side inspection without mutation
 * or a WASM dependency; MemoryImage owns writers and WASM-dependent helpers.
 */

/**
 * MemoryReader — read-only typed access to interpreter state.
 */
export class MemoryReader {
  /**
   * @param {WebAssembly.Memory} memory - WASM memory instance (or any
   *   object exposing a `.buffer` ArrayBuffer/SharedArrayBuffer)
   * @param {number} baseOffset - Start of this interpreter's segment (default 0)
   * @param {number|null} segmentSize - Size of segment (default: entire memory)
   */
  constructor(memory, baseOffset = 0, segmentSize = null) {
    this.memory = memory;
    this.baseOffset = baseOffset;
    this._refreshViews();
    this.segmentSize = segmentSize ?? (this.buffer.byteLength - baseOffset);

    this.decoder = new TextDecoder();
  }

  /**
   * Refresh typed array views after memory growth.
   *
   * Mutates instance fields (`buffer`, `view`, `u8`) but does NOT
   * mutate memory contents. Lives on MemoryReader because reading a
   * grown buffer requires it.
   */
  _refreshViews() {
    this.buffer = this.memory.buffer;
    this.view = new DataView(this.buffer);
    this.u8 = new Uint8Array(this.buffer);
  }

  /**
   * Convert segment-relative offset to absolute memory offset.
   *
   * @param {number} offset - Segment-relative offset
   * @returns {number} - Absolute memory offset
   */
  abs(offset) {
    return this.baseOffset + offset;
  }

  // ===========================================================================
  // SANDFUEL Header
  // ===========================================================================

  /**
   * Get the magic bytes as a string.
   * @returns {string} - "SANDFUEL" if valid
   */
  getMagic() {
    const bytes = this.u8.slice(this.abs(HEADER.MAGIC), this.abs(HEADER.MAGIC) + 8);
    return this.decoder.decode(bytes);
  }

  /**
   * Validate the magic bytes.
   * @throws {Error} - If magic is invalid
   */
  validateMagic() {
    const magic = this.getMagic();
    if (magic !== 'SANDFUEL') {
      throw new Error(`Invalid magic: expected "SANDFUEL", got "${magic}"`);
    }
  }

  /**
   * Get the aggregate drone format version.
   * @returns {number}
   */
  getDroneFormatVersion() {
    return this.view.getUint16(this.abs(HEADER.DRONE_FORMAT_VERSION), true);
  }

  /**
   * Get bytecode version.
   * @returns {number}
   */
  getBytecodeVersion() {
    return this.view.getUint16(this.abs(HEADER.BYTECODE_VERSION), true);
  }

  /**
   * Get type version.
   * @returns {number}
   */
  getTypeVersion() {
    return this.view.getUint16(this.abs(HEADER.TYPE_VERSION), true);
  }

  /**
   * Get builtin version.
   * @returns {number}
   */
  getBuiltinVersion() {
    return this.view.getUint16(this.abs(HEADER.BUILTIN_VERSION), true);
  }

  /**
   * Get all persisted version fields.
   * @returns {object} - { droneFormat, bytecode, type, builtin }
   */
  getVersions() {
    return {
      droneFormat: this.getDroneFormatVersion(),
      bytecode: this.getBytecodeVersion(),
      type: this.getTypeVersion(),
      builtin: this.getBuiltinVersion(),
    };
  }

  /**
   * Validate the aggregate drone format and diagnostic section versions.
   * @throws {Error} - If any version field does not match
   */
  validateVersions() {
    const actual = this.getVersions();
    const mismatches = [];
    if (actual.droneFormat !== DRONE_FORMAT_VERSION) {
      mismatches.push(
        `droneFormat=${actual.droneFormat} (expected ${DRONE_FORMAT_VERSION})`);
    }
    if (actual.bytecode !== VERSION.BYTECODE) {
      mismatches.push(`bytecode=${actual.bytecode} (expected ${VERSION.BYTECODE})`);
    }
    if (actual.type !== VERSION.TYPE) {
      mismatches.push(`type=${actual.type} (expected ${VERSION.TYPE})`);
    }
    if (actual.builtin !== VERSION.BUILTIN) {
      mismatches.push(`builtin=${actual.builtin} (expected ${VERSION.BUILTIN})`);
    }
    if (mismatches.length > 0) {
      throw new Error(
        `Snapshot version mismatch: ${mismatches.join(', ')}. ` +
        `Sandscript snapshots use hard cutovers; pre-cutover snapshots ` +
        `cannot be restored. Regenerate the snapshot with the current ` +
        `version of sandscript.`);
    }
  }

  // ===========================================================================
  // STATE accessors
  // ===========================================================================

  /**
   * Get the root scope pointer.
   * @returns {number} - Root scope pointer
   */
  getRootScope() {
    return this.view.getUint32(this.abs(STATE.ROOT_SCOPE), true);
  }

  /**
   * Get a state header field value.
   *
   * @param {number} stateOffset - Offset from STATE (e.g., STATE.OBJECT_PROTOTYPE)
   * @returns {number} - The value
   */
  getState(stateOffset) {
    return this.view.getUint32(this.abs(stateOffset), true);
  }

  getCodePointer() {
    return this.view.getUint32(this.abs(STATE.CODE_POINTER), true);
  }

  // ===========================================================================
  // Heap & string-table layout
  // ===========================================================================

  getHeapPointer() {
    return this.view.getUint32(this.abs(STATE.HEAP_POINTER), true);
  }

  getHeapStart() {
    return this.view.getUint32(this.abs(STATE.HEAP_START), true);
  }

  getHeapEnd() {
    return this.view.getUint32(this.abs(STATE.HEAP_END), true);
  }

  getStringPointer() {
    return this.view.getUint32(this.abs(STATE.STRING_POINTER), true);
  }

  getStringStart() {
    return this.view.getUint32(this.abs(STATE.STRING_START), true);
  }

  /**
   * Convert a table-relative interned-string id to its absolute byte
   * address in the underlying buffer. Counterpart to the WAT-side
   * $string_id_to_abs helper.
   */
  stringIdToAbs(id) {
    return this.abs(this.getStringStart() + id);
  }

  /**
   * Convert a table-relative interned-string id to its segment-relative
   * absolute offset (useful for code paths that need to pass a
   * segment-relative pointer downstream, e.g. legacy byte-access helpers
   * before they're converted).
   */
  stringIdToSegmentOffset(id) {
    return this.getStringStart() + id;
  }

  getStringEnd() {
    return this.segmentSize;
  }

  /**
   * Segment-relative end of the interned-entry span — the start of the
   * hash index at the region tail. Derived from the region size, the
   * same pure function as the WAT's $derive_string_index_layout.
   */
  getStringDataEnd() {
    return this.getStringEnd()
      - hashTableSize(this.getStringEnd() - this.getStringStart());
  }

  // ===========================================================================
  // Region Base Offsets
  // ===========================================================================

  /**
   * Segment-relative base of a context's request block (layout v8:
   * per-context, inside the context object — no global scratch).
   * @param {number} slot - Context slot
   */
  getExternalRequestBase(slot) {
    if (typeof slot !== 'number') {
      throw new Error(
        'getExternalRequestBase requires a context slot — the request ' +
        'block is per-context since layout v8');
    }
    return this.getContextBase(slot) + CONTEXT_STATE_OFFSET + CTX.REQUEST_BLOCK;
  }

  getErrorInfoBase() {
    return this.view.getUint32(this.abs(STATE.ERROR_INFO_BASE), true);
  }

  getScratchBase() {
    return this.view.getUint32(this.abs(STATE.SCRATCH_BASE), true);
  }

  getScratchSize() {
    return this.view.getUint32(this.abs(STATE.SCRATCH_REGION_SIZE), true);
  }

  getBuiltinsBase() {
    return this.view.getUint32(this.abs(STATE.BUILTINS_BASE), true);
  }

  // ===========================================================================
  // Context Stack Base Helpers
  // ===========================================================================

  // Design B: each stack is its own heap block; its base is stored in the
  // context's state block (CTX.*_BASE), not at a fixed offset within a slab.

  /**
   * Get the call stack base for a context.
   * @param {number} slot - Context slot
   * @returns {number} - Segment-relative address
   */
  getCallStackBase(slot) {
    const stateBase = this.abs(this.getContextStateBase(slot));
    return this.view.getUint32(stateBase + CTX.CALL_STACK_BASE, true);
  }

  /**
   * Get the pending stack base for a context.
   * @param {number} slot - Context slot
   * @returns {number} - Segment-relative address
   */
  getPendingStackBase(slot) {
    const stateBase = this.abs(this.getContextStateBase(slot));
    return this.view.getUint32(stateBase + CTX.PENDING_BASE, true);
  }

  /**
   * Get the try stack base for a context.
   * @param {number} slot - Context slot
   * @returns {number} - Segment-relative address
   */
  getTryStackBase(slot) {
    const stateBase = this.abs(this.getContextStateBase(slot));
    return this.view.getUint32(stateBase + CTX.TRY_STACK_BASE, true);
  }

  /**
   * Get the grant stack base for a context.
   * @param {number} slot - Context slot
   * @returns {number} - Segment-relative address
   */
  getGrantStackBase(slot) {
    const stateBase = this.abs(this.getContextStateBase(slot));
    return this.view.getUint32(stateBase + CTX.GRANT_STACK_BASE, true);
  }

  // ===========================================================================
  // Call Stack frame readers
  // ===========================================================================

  /**
   * Get frame at index.
   *
   * @param {number} slot - Context slot
   * @param {number} index - Frame index
   * @returns {object} - Frame data
   */
  getFrame(slot, index) {
    const frameOffset = this.getCallStackBase(slot) + index * FRAME_SIZE;
    const framePointer = this.abs(frameOffset);

    return {
      instructionIndex: this.view.getUint32(framePointer + FRAME.INSTRUCTION_INDEX, true),
      scopePointer: this.view.getUint32(framePointer + FRAME.SCOPE_POINTER, true),
      // Design B: FRAME.PENDING_POINTER is stored as an OFFSET from the pending
      // stack base (so it survives pending-stack relocation on growth). Resolve
      // it to an absolute segment pointer here, the form callers expect.
      pendingPointer: this.getPendingStackBase(slot) +
        this.view.getUint32(framePointer + FRAME.PENDING_POINTER, true),
      pendingCount: this.view.getUint32(framePointer + FRAME.PENDING_COUNT, true),
      flags: this.view.getUint32(framePointer + FRAME.FLAGS, true),
      astNode: this.view.getUint32(framePointer + FRAME.AST_NODE, true),
    };
  }

  /**
   * Get current (top) frame, or null if stack is empty.
   *
   * @param {number} slot - Context slot
   * @returns {object|null} - Frame data or null
   */
  getCurrentFrame(slot) {
    const stackPointer = this.getContextCallStackPointer(slot);
    const stackBase = this.getCallStackBase(slot);

    if (stackPointer <= stackBase) {
      return null;
    }

    const index = (stackPointer - FRAME_SIZE - stackBase) / FRAME_SIZE;
    return this.getFrame(slot, index);
  }

  /**
   * Get all frames on the call stack.
   *
   * @param {number} slot - Context slot
   * @returns {Array<object>} - Array of frame data
   */
  getCallStack(slot) {
    const frames = [];
    const stackPointer = this.getContextCallStackPointer(slot);
    const stackBase = this.getCallStackBase(slot);
    const count = (stackPointer - stackBase) / FRAME_SIZE;

    for (let i = 0; i < count; i++) {
      frames.push(this.getFrame(slot, i));
    }

    return frames;
  }

  /**
   * Get call stack depth (number of frames).
   *
   * @param {number} slot - Context slot
   * @returns {number}
   */
  getCallStackDepth(slot) {
    const stackPointer = this.getContextCallStackPointer(slot);
    const stackBase = this.getCallStackBase(slot);
    return (stackPointer - stackBase) / FRAME_SIZE;
  }

  // ===========================================================================
  // Pending Values Stack (depth read)
  // ===========================================================================

  /**
   * Get pending stack depth (number of values).
   *
   * @param {number} slot - Context slot
   * @returns {number}
   */
  getPendingDepth(slot) {
    const pendingPointer = this.getContextPendingPointer(slot);
    const pendingBase = this.getPendingStackBase(slot);
    return (pendingPointer - pendingBase) / VALUE_SIZE;
  }

  // ===========================================================================
  // AST Region readers
  // ===========================================================================

  /**
   * Get the AST region base (segment-relative).
   */
  getAstRegionBase() {
    return this.view.getUint32(this.abs(STATE.AST_REGION_BASE), true);
  }

  /**
   * Get the AST region's reserved size in bytes.
   */
  getAstRegionSize() {
    return this.view.getUint32(this.abs(STATE.AST_REGION_SIZE), true);
  }

  /**
   * Get the current AST write pointer (segment-relative).
   */
  getAstRegionPointer() {
    return this.view.getUint32(this.abs(STATE.AST_REGION_POINTER), true);
  }

  /**
   * Has any AST data been written? True iff the pointer has advanced past base.
   */
  isAstRegionInitialized() {
    return this.getAstRegionPointer() > this.getAstRegionBase();
  }

  /**
   * Read header fields. Returns null if the region is uninitialized (no
   * header written yet) or disabled (size 0).
   *
   * `rootNodeOffset` remains the first-root offset for compatibility with
   * existing readers; `lastRootOffset` is the chain tail for O(1) appends.
   */
  getAstRegionHeader() {
    if (!this.isAstRegionInitialized()) return null;
    const base = this.getAstRegionBase();
    return {
      dialect: this.view.getUint32(this.abs(base + AST_REGION.DIALECT), true),
      formatVersion: this.view.getUint16(this.abs(base + AST_REGION.FORMAT_VERSION), true),
      rootNodeOffset: this.view.getUint32(this.abs(base + AST_REGION.FIRST_ROOT), true),
      lastRootOffset: this.view.getUint32(this.abs(base + AST_REGION.LAST_ROOT), true),
    };
  }

  getAstRegionLastRootOffset() {
    if (!this.isAstRegionInitialized()) return 0;
    const base = this.getAstRegionBase();
    return this.view.getUint32(this.abs(base + AST_REGION.LAST_ROOT), true);
  }

  /**
   * Read raw bytes from the AST region by offset (relative to region base)
   * and length. Returns a Uint8Array view (not a copy) into the underlying
   * memory buffer. Caller must not retain the view across operations that
   * may grow/relocate the underlying buffer.
   */
  readAstRegionBytes(offset, length) {
    const base = this.getAstRegionBase();
    const start = this.abs(base + offset);
    return new Uint8Array(this.buffer, start, length);
  }

  /**
   * Return a copy of the entire AST region (header + nodes), or null if the
   * region is uninitialized. The copy is safe to retain across other
   * operations.
   */
  copyAstRegion() {
    if (!this.isAstRegionInitialized()) return null;
    const base = this.getAstRegionBase();
    const pointer = this.getAstRegionPointer();
    const length = pointer - base;
    const start = this.abs(base);
    return new Uint8Array(this.buffer.slice(start, start + length));
  }

  // ===========================================================================
  // CodeBlock pointer helpers (read-only; full code-block reads come later)
  // ===========================================================================

  /**
   * Get the fixed code block start (header position).
   * @returns {number} - Segment-relative pointer to code block header
   */
  getCodeStart() {
    return this.getStringStart() - 16;
  }

  /**
   * Get pointer to instruction 0 position (just below header).
   * @returns {number} - Segment-relative pointer
   */
  getInstructionZeroPointer() {
    return this.getCodeStart(); // instruction 0 is at header - 16, but we store [count][flags] at header
  }

  /**
   * Get current CodeBlock pointer from state.
   * For reverse-growing model, this always returns the fixed code block start.
   * @returns {number} - Segment-relative pointer to CodeBlock data
   */
  getCodeBlock() {
    return this.getCodeStart();
  }

  /**
   * Get instruction count for the code block.
   * @returns {number} - Number of instructions
   */
  codeBlockInstructionCount() {
    const codeStart = this.getCodeStart();
    return this.view.getUint32(this.abs(codeStart), true);
  }

  /**
   * Get flags for the code block.
   * @returns {number} - Flags
   */
  codeBlockGetFlags() {
    const codeStart = this.getCodeStart();
    return this.view.getUint32(this.abs(codeStart + 4), true);
  }

  /**
   * Read an instruction from the code block.
   *
   * @param {number} instructionIndex - Which instruction to read
   * @returns {object} - Instruction data
   */
  codeBlockReadInstruction(instructionIndex) {
    // Instructions grow downward: instr_address = codeStart - (index + 1) * INSTRUCTION_SIZE
    const codeStart = this.getCodeStart();
    const instrOffset = codeStart - (instructionIndex + 1) * INSTRUCTION_SIZE;
    const instrPointer = this.abs(instrOffset);

    return {
      opcode: this.view.getUint8(instrPointer),
      flags: this.view.getUint8(instrPointer + 1),
      astNode: this.view.getUint32(instrPointer + 4, true),
      operand1: this.view.getUint32(instrPointer + 8, true),
      operand2: this.view.getUint32(instrPointer + 12, true),
    };
  }

  // ===========================================================================
  // Try Stack readers
  // ===========================================================================

  /**
   * Get try stack depth.
   * @param {number} slot - Context slot
   * @returns {number} - Number of entries
   */
  getTryDepth(slot) {
    return (this.getContextTryStackPointer(slot) - this.getTryStackBase(slot)) / TRY_ENTRY_SIZE;
  }

  /**
   * Peek the top try entry without popping.
   *
   * @param {number} slot - Context slot
   * @returns {object|null} - Try entry data or null if empty
   */
  peekTryEntry(slot) {
    const depth = this.getTryDepth(slot);
    if (depth === 0) return null;
    return this.getTryEntry(slot, depth - 1);
  }

  /**
   * Get try entry at index.
   *
   * @param {number} slot - Context slot
   * @param {number} index - Entry index
   * @returns {object} - Try entry data
   */
  getTryEntry(slot, index) {
    const entryOffset = this.getTryStackBase(slot) + index * TRY_ENTRY_SIZE;
    const entryPointer = this.abs(entryOffset);

    return {
      catchIndex: this.view.getUint32(entryPointer + TRY_ENTRY.CATCH_INDEX, true),
      finallyIndex: this.view.getUint32(entryPointer + TRY_ENTRY.FINALLY_INDEX, true),
      frameDepth: this.view.getUint32(entryPointer + TRY_ENTRY.FRAME_DEPTH, true),
      completionType: this.view.getUint32(entryPointer + TRY_ENTRY.COMPLETION_TYPE, true),
      grantDepth: this.view.getUint32(entryPointer + TRY_ENTRY.GRANT_DEPTH, true),
    };
  }

  /**
   * Get all entries on the try stack.
   * @param {number} slot - Context slot
   * @returns {Array<object>} - Array of try entry data
   */
  getTryStack(slot) {
    const entries = [];
    const depth = this.getTryDepth(slot);

    for (let i = 0; i < depth; i++) {
      entries.push(this.getTryEntry(slot, i));
    }

    return entries;
  }

  // ===========================================================================
  // Grant Stack readers
  // ===========================================================================

  /**
   * Get grant stack depth.
   * @param {number} slot - Context slot
   * @returns {number} - Number of entries
   */
  getGrantDepth(slot) {
    return (this.getContextGrantStackPointer(slot) - this.getGrantStackBase(slot)) / GRANT_ENTRY_SIZE;
  }

  /**
   * Get grant entry at index.
   *
   * @param {number} slot - Context slot
   * @param {number} index - Entry index
   * @returns {object} - Grant entry data
   */
  getGrantEntry(slot, index) {
    const entryOffset = this.getGrantStackBase(slot) + index * GRANT_ENTRY_SIZE;
    const entryPointer = this.abs(entryOffset);

    return {
      identifierAddr: entryOffset + GRANT_ENTRY.IDENTIFIER, // segment-relative
      grantId: this.view.getUint32(entryPointer + GRANT_ENTRY.GRANT_ID, true),
      deniedAddr: this.view.getUint32(entryPointer + GRANT_ENTRY.DENIED_ADDR, true),
      scopePointer: this.view.getUint32(entryPointer + GRANT_ENTRY.SCOPE_POINTER, true),
      frameDepth: this.view.getUint32(entryPointer + GRANT_ENTRY.FRAME_DEPTH, true),
    };
  }

  /**
   * Get active grant IDs as a Set.
   * Used by Airlock to check authorization.
   *
   * @param {number} slot - Context slot
   * @returns {Set<number>} - Set of active grant IDs
   */
  getActiveGrantIds(slot) {
    const grantIds = new Set();
    const depth = this.getGrantDepth(slot);

    for (let i = 0; i < depth; i++) {
      const entry = this.getGrantEntry(slot, i);
      grantIds.add(entry.grantId);
    }

    return grantIds;
  }

  /**
   * Find grant entries with a specific grant ID (for revocation).
   *
   * @param {number} slot - Context slot
   * @param {number} grantId - Grant ID to find
   * @returns {object[]} - Array of { index, entry } for matching entries
   */
  findGrantEntriesById(slot, grantId) {
    const matches = [];
    const depth = this.getGrantDepth(slot);

    for (let i = 0; i < depth; i++) {
      const entry = this.getGrantEntry(slot, i);
      if (entry.grantId === grantId) {
        matches.push({ index: i, entry });
      }
    }

    return matches;
  }

  // ===========================================================================
  // Value readers
  // ===========================================================================

  /**
   * Read a value.
   *
   * @param {number} addr - Segment-relative address
   * @returns {object} - { type, payload }
   */
  getValue(addr) {
    const absAddr = this.abs(addr);
    const type = this.view.getUint32(absAddr, true);

    let payload;
    if (type === TYPE.FLOAT) {
      payload = this.view.getFloat64(absAddr + 8, true);
    } else {
      payload = this.view.getBigInt64(absAddr + 8, true);
    }

    return { type, payload };
  }

  /**
   * Get value type.
   *
   * @param {number} addr - Segment-relative address
   * @returns {number} - Type tag
   */
  getValueType(addr) {
    return this.view.getUint32(this.abs(addr), true);
  }

  /**
   * Get value pointer (for heap-allocated values).
   *
   * @param {number} addr - Segment-relative address
   * @returns {number} - Pointer value
   */
  getValuePointer(addr) {
    return Number(this.view.getBigInt64(this.abs(addr) + 8, true));
  }

  /**
   * Read a bound method value from an address.
   *
   * @param {number} addr - Segment-relative address
   * @returns {object} - { receiver, methodIdOrClosure, isUserFunction }
   */
  readBoundMethod(addr) {
    const absAddr = this.abs(addr);
    return {
      receiver: this.view.getUint32(absAddr + 4, true),
      methodIdOrClosure: this.view.getUint32(absAddr + 8, true),
      isUserFunction: this.view.getUint32(absAddr + 12, true) === 1,
    };
  }

  // ===========================================================================
  // External request / Error info readers
  // ===========================================================================

  /**
   * Get external call request data from a context's request block.
   *
   * @param {number} slot - Context slot
   * @returns {object} - { handleId, methodOffset, argsPointer, argCount }
   */
  getExternalRequest(slot) {
    const offset = this.abs(this.getExternalRequestBase(slot));
    return {
      handleId: this.view.getUint32(offset, true),
      methodOffset: this.view.getUint32(offset + 4, true),
      argsPointer: this.view.getUint32(offset + 8, true),
      argCount: this.view.getUint32(offset + 12, true),
      // The handle value's version, forwarded by the WAT for the
      // CALL/PROPERTY/PROPERTY_SET external yield paths. A zero version marks
      // a legacy/unversioned value, so dispatch skips the staleness check.
      handleVersion: this.view.getUint32(offset + 16, true),
    };
  }

  /**
   * Get error info.
   *
   * @returns {object} - { code, detail }
   */
  getErrorInfo() {
    const offset = this.abs(this.getErrorInfoBase());
    return {
      code: this.view.getUint32(offset, true),
      detail: this.view.getUint32(offset + 4, true),
    };
  }

  // ===========================================================================
  // String reads
  // ===========================================================================

  /**
   * Read a string from the string table.
   *
   * @param {number} offset - Segment-relative offset to string entry
   * @returns {string} - The string
   */
  readString(id) {
    // `id` is a table-relative interned-string id (the byte offset
    // from string_start to the entry's length prefix). Entries live
    // past the hash table, below the table's high-water mark
    // (string_pointer). A corrupt id read here as trusted data is how
    // the "intern bomb" happened: a misaligned id lands inside an
    // entry's content bytes, those bytes decode as a giant length
    // prefix, and the caller gets the rest of the string segment as
    // one string (see tests/fuel/corrupt_method_offset_test.js).
    const usedExtent = this.getStringPointer() - this.getStringStart();
    if (id < STRING_DATA_START || id + 4 > usedExtent) {
      throw new RangeError(
        `readString: id ${id} is outside the interned-entry region ` +
        `[${STRING_DATA_START}, ${usedExtent})`);
    }
    const absOffset = this.stringIdToAbs(id);
    const length = this.view.getUint32(absOffset, true);
    if (id + 4 + length > usedExtent) {
      throw new RangeError(
        `readString: id ${id} is not a valid interned-string entry ` +
        `(length prefix ${length} overruns the string table's used ` +
        `extent ${usedExtent})`);
    }
    const bytes = this.u8.slice(absOffset + 4, absOffset + 4 + length);
    return this.decoder.decode(bytes);
  }

  // ===========================================================================
  // Built-in name lookup
  // ===========================================================================

  /**
   * Read a built-in name pointer from the BUILTINS segment.
   *
   * @param {number} offset - Offset within BUILTINS segment (e.g., BUILTIN_NAME.LENGTH)
   * @returns {number} - String table offset for the interned name
   */
  getBuiltinName(offset) {
    return this.view.getUint32(this.abs(this.getBuiltinsBase() + offset), true);
  }

  // ===========================================================================
  // Closure readers
  // ===========================================================================

  /**
   * Read closure data.
   *
   * @param {number} closurePointer - Segment-relative pointer to closure
   * @returns {object} - { startInstruction, endInstruction, scope, functionFlags }
   */
  getClosure(closurePointer) {
    const absPointer = this.abs(closurePointer);

    // Function layout (from HEADER pointer):
    // [GC:8][prototype:4][count:4][capacity:4][flags:4][entries:4][sym_entries:4][start_instruction:4][end_instruction:4][scope:4][function_flags:4]
    // Closure fields start at offset 32 from header (8 GC + 24 object header).
    return {
      startInstruction: this.view.getUint32(absPointer + FUNCTION.START_INSTRUCTION, true),
      endInstruction: this.view.getUint32(absPointer + FUNCTION.END_INSTRUCTION, true),
      scope: this.view.getUint32(absPointer + FUNCTION.SCOPE, true),
      functionFlags: this.view.getUint32(absPointer + FUNCTION.FUNCTION_FLAGS, true),
    };
  }

  /**
   * Check if a closure is an arrow function.
   *
   * @param {number} closurePointer - Segment-relative pointer to closure
   * @returns {boolean}
   */
  isArrowClosure(closurePointer) {
    const functionFlags = this.view.getUint32(this.abs(closurePointer) + FUNCTION.FUNCTION_FLAGS, true);
    return (functionFlags & CLOSURE_FLAG_ARROW) !== 0;
  }

  /**
   * Check if a closure is an async function.
   *
   * @param {number} closurePointer - Segment-relative pointer to closure
   * @returns {boolean}
   */
  isAsyncClosure(closurePointer) {
    const functionFlags = this.view.getUint32(this.abs(closurePointer) + FUNCTION.FUNCTION_FLAGS, true);
    return (functionFlags & CLOSURE_FLAG_ASYNC) !== 0;
  }

  // ===========================================================================
  // Scope readers
  // ===========================================================================

  /**
   * Look up a variable in a scope (and parent scopes).
   *
   * @param {number} scopePointer - Scope pointer
   * @param {number} nameOffset - String table offset for name
   * @returns {number|null} - Value pointer or null if not found
   */
  scopeLookup(scopePointer, nameOffset) {
    while (scopePointer !== 0) {
      const absPointer = this.abs(scopePointer);
      const count = this.view.getUint32(absPointer + 4, true);
      const entriesPointer = this.view.getUint32(absPointer + 12, true);

      // Entry data starts after GC header
      const entryDataStart = entriesPointer + GC_HEADER_SIZE;

      for (let i = 0; i < count; i++) {
        // Entry is 20 bytes: [name:4][type:4][flags:4][data_lo:4][data_hi:4]
        const entryOffset = entryDataStart + i * 20;
        const absEntryPointer = this.abs(entryOffset);
        const entryName = this.view.getUint32(absEntryPointer, true);

        if (entryName === nameOffset) {
          // Return pointer to value (starts at offset +4 within entry)
          return entryOffset + 4;
        }
      }

      // Check parent scope
      scopePointer = this.view.getUint32(absPointer, true);
    }

    return null;
  }

  /**
   * Get all variable names in scope (current scope only, not parent chain).
   *
   * @param {number} scopePointer - Segment-relative pointer to scope
   * @returns {string[]} - Variable names
   */
  scopeKeys(scopePointer) {
    const keys = [];
    const absPointer = this.abs(scopePointer);
    const count = this.view.getUint32(absPointer + 4, true);
    const entriesPointer = this.view.getUint32(absPointer + 12, true);
    const entryDataStart = entriesPointer + GC_HEADER_SIZE;

    for (let i = 0; i < count; i++) {
      const entryOffset = entryDataStart + i * 20;
      const absEntryPointer = this.abs(entryOffset);
      const nameOffset = this.view.getUint32(absEntryPointer, true);
      const name = this.readString(nameOffset);
      keys.push(name);
    }

    return keys;
  }

  /**
   * Get all [name, valuePointer] pairs in ONE scope frame (no parent
   * walk). The third sibling of scopeKeys (names only) and scopeLookup
   * (walks parents, needs a nameOffset not a name string, returns one
   * pointer) — this is the one that lets a caller decode every binding
   * in a single frame via readValueAt, without re-interning a name back
   * to an offset just to re-derive a pointer scopeLookup already had.
   *
   * @param {number} scopePointer - Segment-relative pointer to scope
   * @returns {Array<{name: string, valuePointer: number}>}
   */
  scopeEntries(scopePointer) {
    const out = [];
    const absPointer = this.abs(scopePointer);
    const count = this.view.getUint32(absPointer + 4, true);
    const entriesPointer = this.view.getUint32(absPointer + 12, true);
    const entryDataStart = entriesPointer + GC_HEADER_SIZE;

    for (let i = 0; i < count; i++) {
      // Entry is 20 bytes: [name:4][type:4][flags:4][data_lo:4][data_hi:4].
      // readValueAt expects a pointer to a value slot (type/flags/dataLo/
      // dataHi starting at the pointer) — that's entryOffset + 4, the
      // exact offset scopeLookup already returns for a matched entry.
      const entryOffset = entryDataStart + i * 20;
      const absEntryPointer = this.abs(entryOffset);
      const nameOffset = this.view.getUint32(absEntryPointer, true);
      out.push({ name: this.readString(nameOffset), valuePointer: entryOffset + 4 });
    }

    return out;
  }

  // ===========================================================================
  // Heap walking & usage stats
  // ===========================================================================

  /**
   * Get heap usage statistics.
   *
   * @returns {object} - { used, total, percent }
   */
  heapUsage() {
    const heapPointer = this.getHeapPointer();
    const heapStart = this.getHeapStart();
    const heapEnd = this.getHeapEnd();
    const used = heapPointer - heapStart;
    const total = heapEnd - heapStart;
    const percent = ((used / total) * 100).toFixed(1);

    return { used, total, percent };
  }

  /**
   * Get string table usage statistics.
   *
   * @returns {object} - { used, total, percent }
   */
  stringUsage() {
    const stringPointer = this.getStringPointer();
    const stringDataStart = this.getStringStart() + STRING_DATA_START;
    const stringDataEnd = this.getStringDataEnd();
    const used = stringPointer - stringDataStart;
    const total = stringDataEnd - stringDataStart;
    const percent = ((used / total) * 100).toFixed(1);

    return { used, total, percent };
  }

  /**
   * Enumerate all objects on the heap.
   * Walks the heap from start to current pointer, yielding object info.
   *
   * @returns {Array<object>} - Array of heap object info
   */
  enumerateHeapObjects() {
    const objects = [];
    const heapStart = this.getHeapStart();
    const heapPointer = this.getHeapPointer();

    let ptr = heapStart;
    while (ptr < heapPointer) {
      const absPtr = this.abs(ptr);
      const headerWord = this.view.getUint32(absPtr, true);
      const objType = (headerWord >> 24) & 0x7f;
      const size = readGCHeaderSize(this.view, absPtr, headerWord);

      if (size === 0) {
        break; // Invalid header, stop walking
      }

      objects.push({
        address: ptr,
        type: OBJECT_CLASS_NAMES[objType] ?? `type_${objType}`,
        size,
      });

      ptr += size;
    }

    return objects;
  }

  /**
   * Get all entries in scope (current scope only, not parent chain).
   *
   * @param {number} scopePointer - Segment-relative pointer to scope
   * @returns {Array<{name: string, type: number, flags: number, dataLo: number, dataHi: number}>}
   */
  getScopeEntries(scopePointer) {
    const entries = [];
    const absPointer = this.abs(scopePointer);
    const count = this.view.getUint32(absPointer + 4, true);
    const entriesPointer = this.view.getUint32(absPointer + 12, true);
    const entryDataStart = entriesPointer + GC_HEADER_SIZE;

    for (let i = 0; i < count; i++) {
      const entryOffset = entryDataStart + i * 20;
      const absEntryPointer = this.abs(entryOffset);
      const nameOffset = this.view.getUint32(absEntryPointer, true);
      entries.push({
        name: this.readString(nameOffset),
        type: this.view.getUint32(absEntryPointer + 4, true),
        flags: this.view.getUint32(absEntryPointer + 8, true),
        dataLo: this.view.getUint32(absEntryPointer + 12, true),
        dataHi: this.view.getUint32(absEntryPointer + 16, true),
      });
    }

    return entries;
  }

  // ===========================================================================
  // Object readers
  // ===========================================================================

  /**
   * Get the prototype of an object.
   *
   * @param {number} objectPointer - Object header pointer
   * @returns {number} - Prototype object header pointer (or 0 for null)
   */
  getObjectPrototype(objectPointer) {
    const absoluteObjectPointer = this.abs(objectPointer);
    return this.view.getUint32(absoluteObjectPointer + 8, true);
  }

  /**
   * Get the flags of an object.
   * Object layout: [GC:8][prototype:4][count:4][capacity:4][flags:4][entries:4]
   *
   * @param {number} objectPointer - Object header pointer
   * @returns {number} - Object flags
   */
  getObjectFlags(objectPointer) {
    const absoluteObjectPointer = this.abs(objectPointer);
    return this.view.getUint32(absoluteObjectPointer + 20, true);
  }

  /**
   * Check if an object is frozen.
   *
   * @param {number} objectPointer - Object header pointer
   * @returns {boolean} - True if object is frozen
   */
  isObjectFrozen(objectPointer) {
    return (this.getObjectFlags(objectPointer) & OBJECT_FLAG.FROZEN) !== 0;
  }

  // ===========================================================================
  // ArrayBuffer / Uint8Array readers
  // ===========================================================================

  /**
   * Get the byte length of an ArrayBuffer.
   *
   * @param {number} bufferDataPointer - ArrayBuffer data pointer (after GC header)
   * @returns {number} - Byte length
   */
  getArrayBufferByteLength(bufferDataPointer) {
    return this.view.getUint32(this.abs(bufferDataPointer), true);
  }

  /**
   * Get a pointer to the raw bytes of an ArrayBuffer.
   *
   * @param {number} bufferDataPointer - ArrayBuffer data pointer (after GC header)
   * @returns {number} - Absolute pointer to first byte
   */
  getArrayBufferBytesPointer(bufferDataPointer) {
    return this.abs(bufferDataPointer + 4);
  }

  /**
   * Read byte from Uint8Array.
   *
   * @param {number} bufferDataPointer - ArrayBuffer data pointer (after GC header)
   * @param {number} byteOffset - View's byte offset
   * @param {number} index - Element index
   * @returns {number} - Byte value (0-255) or -1 if out of bounds
   */
  readUint8ArrayElement(bufferDataPointer, byteOffset, index) {
    const bufferLength = this.view.getUint32(this.abs(bufferDataPointer), true);
    const absoluteIndex = byteOffset + index;
    if (absoluteIndex < 0 || absoluteIndex >= bufferLength) {
      return -1;  // Out of bounds
    }
    const bytesStart = this.abs(bufferDataPointer + 4);
    return this.u8[bytesStart + absoluteIndex];
  }

  // ===========================================================================
  // Marshalling readers
  // ===========================================================================

  /**
   * Unmarshal arguments from the pending stack for an external call.
   *
   * @param {number} argsPointer - Pointer to first argument value slot
   * @param {number} argCount - Number of arguments
   * @param {Object} options - Optional callbacks (passed to readValueAt)
   * @returns {Array} - Array of JS values
   */
  unmarshalArgs(argsPointer, argCount, options = {}) {
    // External handler args unwrap integer-Rationals recursively for JS surface compat.
    const unwrapOptions = { ...options, unwrapRational: true };
    const args = [];
    for (let i = 0; i < argCount; i++) {
      const valuePointer = argsPointer + i * VALUE_SIZE;
      args.push(this.readValueAt(valuePointer, unwrapOptions));
    }
    return args;
  }

  /**
   * Read a JS value from a 16-byte value slot in memory.
   * For objects/arrays, follows heap pointers and reconstructs.
   *
   * @param {number} sourcePointer - Segment-relative pointer to value slot
   * @param {Object} options - Optional callbacks
   * @param {Function} options.unmarshal - (type, dataLo, dataHi) => value | undefined
   *   Called for each value. Return undefined to use default unmarshalling.
   * @returns {*} - JS value
   */
  readValueAt(sourcePointer, options = {}) {
    const absolutePointer = this.abs(sourcePointer);
    const type = this.view.getUint32(absolutePointer, true);
    const dataLo = this.view.getUint32(absolutePointer + 8, true);
    const dataHi = this.view.getUint32(absolutePointer + 12, true);

    // Try callback first for custom types
    if (options.unmarshal) {
      const result = options.unmarshal(type, dataLo, dataHi);
      if (result !== undefined) {
        return result;
      }
    }

    switch (type) {
      case TYPE.UNDEFINED:
        return undefined;
      case TYPE.NULL:
        return null;
      case TYPE.BOOLEAN:
        return dataLo !== 0;
      case TYPE.INTEGER:
        return dataLo;  // Integer stored in dataLo
      case TYPE.FLOAT:
        return this.view.getFloat64(absolutePointer + 8, true);
      case TYPE.STRING:
        return this.readString(dataLo);
      case TYPE.ARRAY:
        return this.unmarshalArray(dataLo, options);
      case TYPE.OBJECT:
        return this.unmarshalObject(dataLo, options);
      case TYPE.ACCESSOR:
        // Getter/setter property value. The reader can't invoke the
        // getter (the interpreter isn't running), so accessor-backed
        // properties read as undefined from the host side.
        return undefined;
      case TYPE.MAP:
        return this.unmarshalMap(dataLo, options);
      case TYPE.SET:
        return this.unmarshalSet(dataLo, options);
      case TYPE.MSGPACK_REF: {
        // Layout A: dataLo = parent_data_ptr (segment-relative DATA pointer
        // into an OBJ.ARRAYBUFFER whose first 4 bytes are byteLength), and
        // dataHi = offset into the payload.
        const parentAbsolute = this.abs(dataLo);
        const parentByteLength = this.view.getUint32(parentAbsolute, true);
        const absoluteAddress = parentAbsolute + 4 + dataHi;
        const length = parentByteLength - dataHi;
        return this.unmarshalMsgpack(absoluteAddress, length);
      }
      case TYPE.ARRAYBUFFER: {
        // dataLo = ArrayBuffer dataPointer (after GC header).
        // Layout: [byteLength:4][bytes...]. Copy out into a fresh
        // JS ArrayBuffer so the JS-side caller has a stable view
        // independent of any later GC of the SS heap.
        const byteLength = this.view.getUint32(this.abs(dataLo), true);
        const bytesStart = this.abs(dataLo + 4);
        const out = new ArrayBuffer(byteLength);
        new Uint8Array(out).set(
          new Uint8Array(this.buffer, bytesStart, byteLength));
        return out;
      }
      case TYPE.UINT8ARRAY: {
        const descriptorAbsolute = this.abs(dataLo);
        const bufferDataPointer = this.view.getUint32(descriptorAbsolute, true);
        const byteOffset = this.view.getUint32(descriptorAbsolute + 4, true);
        const length = this.view.getUint32(descriptorAbsolute + 8, true);
        const bytesStart = this.abs(bufferDataPointer + 4) + byteOffset;
        if (options.heapViewTypedArrays) {
          return new Uint8Array(this.buffer, bytesStart, length);
        }
        const out = new Uint8Array(length);
        out.set(new Uint8Array(this.buffer, bytesStart, length));
        return out;
      }
      case TYPE.BIGINT:
        return this.unmarshalBigInt(dataLo);
      case TYPE.RATIONAL: {
        // Check the inline flag in the flags field (offset +4) of the slot.
        const flags = this.view.getUint32(absolutePointer + 4, true);
        let rational;
        if (flags & FLAG_RATIONAL_INLINE) {
          // Inline: dataLo + dataHi form a signed i64 numerator; denominator = 1.
          const view = new DataView(new ArrayBuffer(8));
          view.setUint32(0, dataLo, true);
          view.setUint32(4, dataHi, true);
          rational = {
            kind: 'rational',
            numerator: view.getBigInt64(0, true),
            denominator: 1n,
          };
        } else {
          rational = this.unmarshalRational(dataLo);
        }
        // coerceExact: 'float' — External handlers that want the old Number
        // surface (Math.*-style intrinsics). Every Rational becomes
        // numerator/denominator f64, even non-integer or large ones. Opt-in
        // because precision loss here is the exact pitfall the exact-number
        // work is avoiding by default.
        if (options.coerceExact === 'float') {
          return Number(rational.numerator) / Number(rational.denominator);
        }
        // JS-surface unwrap: when the caller requested it (e.g. arrays inside
        // a session.result() or External arg batch), integer-valued Rationals in
        // JS-safe-integer range come back as plain Numbers so [10, 20, 30]
        // looks like a JS number array rather than an array of Rational shapes.
        // Uses 2^53 as the boundary — the largest integer JS Numbers represent
        // exactly. Values outside this range stay structured to avoid
        // precision loss.
        if (options.unwrapRational && rational.denominator === 1n) {
          const n = rational.numerator;
          if (n >= -9007199254740992n && n <= 9007199254740992n) {
            return Number(n);
          }
        }
        return rational;
      }
      case TYPE.COMPLEX:
        // coerceExact: 'float' cannot meaningfully project Complex to a
        // single Number, so reject it at the External boundary rather than
        // silently discarding the imaginary part.
        if (options.coerceExact === 'float') {
          throw new TypeError(
            'Cannot coerce Complex to Float at External boundary (handler opted in to coerceExact: "float")'
          );
        }
        return this.unmarshalComplex(dataLo);
      case TYPE.REGEXP: {
        // Structured readback, like Symbol: a live host RegExp would lie
        // about lastIndex units (SandScript counts Unicode scalar values,
        // JS counts UTF-16 units), so readback stays a snapshot shape.
        const dataAbsolute = this.abs(dataLo + GC_HEADER_SIZE);
        const source = this.readString(
          this.view.getUint32(dataAbsolute + REGEXP.PATTERN_STRING, true));
        const flagsWord = this.view.getUint32(dataAbsolute + REGEXP.FLAGS, true);
        let flags = '';
        if (flagsWord & REGEX_FLAG.HAS_INDICES) flags += 'd';
        if (flagsWord & REGEX_FLAG.GLOBAL) flags += 'g';
        if (flagsWord & REGEX_FLAG.IGNORE_CASE) flags += 'i';
        if (flagsWord & REGEX_FLAG.MULTILINE) flags += 'm';
        if (flagsWord & REGEX_FLAG.DOT_ALL) flags += 's';
        if (flagsWord & REGEX_FLAG.STICKY) flags += 'y';
        return {
          kind: 'regexp',
          source,
          flags,
          lastIndex: this.view.getUint32(dataAbsolute + REGEXP.LAST_INDEX, true),
        };
      }
      case TYPE.SCHEMA: {
        // Structured readback: the source schema value, the dialect the
        // program was compiled under, and the program size.
        const dataAbsolute = this.abs(dataLo + GC_HEADER_SIZE);
        const options = this.view.getUint32(dataAbsolute + SCHEMA.OPTIONS, true);
        const programPointer = this.view.getUint32(dataAbsolute + SCHEMA.PROGRAM_BUFFER, true);
        return {
          kind: 'schema',
          schema: this.readValueAt(dataLo + GC_HEADER_SIZE + SCHEMA.SOURCE, options),
          dialect: (options & SCHEMA_OPT.DIALECT_04) ? 'draft-04'
            : (options & SCHEMA_OPT.DIALECT_07) ? 'draft-07' : '2020-12',
          strict: (options & SCHEMA_OPT.STRICT) !== 0,
          formats: (options & SCHEMA_OPT.FORMAT_ANNOTATE) ? 'annotate' : 'assert',
          programBytes: programPointer === 0 ? 0 : this.view.getUint32(this.abs(programPointer), true),
        };
      }
      case TYPE.SYMBOL: {
        // coerceExact: 'float' cannot project a symbolic atom onto a Number.
        if (options.coerceExact === 'float') {
          throw new TypeError(
            'Cannot coerce Symbol to Float at External boundary (handler opted in to coerceExact: "float")'
          );
        }
        // Structured readback: { kind, description, registered }.
        // Live JS symbols would lie about identity across the WASM/JS boundary;
        // structured data is honest about what readback is (a snapshot, not a
        // live reference). Matches Ring 1's Rational/Complex readback shape.
        const descriptionOffset = this.readSymbolDescription(dataLo);
        const description = descriptionOffset === 0
          ? undefined
          : this.readString(descriptionOffset);
        const registered = this.isSymbolRegistered(dataLo);
        return { kind: 'symbol', description, registered };
      }
      case TYPE.EXPRESSION: {
        // Expression readback mirrors Symbol's honesty: structured, not a
        // live object. Shape is { kind, head, arguments } where head is the
        // same structured-symbol shape we use for leaf Symbols, and
        // arguments is a JS array whose elements are recursively readback.
        // Nested (not flat) so a symbol in the head slot looks identical to
        // a symbol in an argument slot.
        if (options.coerceExact === 'float') {
          throw new TypeError(
            'Cannot coerce Expression to Float at External boundary (handler opted in to coerceExact: "float")'
          );
        }
        return this.readExpressionShape(dataLo, options);
      }
      case TYPE.MATRIX: {
        // Matrix readback: { kind, rows, columns, entries } with entries
        // as a nested 2D array (entries[i][j]), recursively in Ring 1/
        // Ring 2 readback shape. dataLo is the HEADER pointer to
        // [rowCount:4][columnCount:4][entriesArrayPointer:4][reserved:4].
        if (options.coerceExact === 'float') {
          throw new TypeError(
            'Cannot coerce Matrix to Float at External boundary (handler opted in to coerceExact: "float")'
          );
        }
        const matrixData = this.abs(dataLo + 8);
        const rowCount = this.view.getUint32(matrixData, true);
        const columnCount = this.view.getUint32(matrixData + 4, true);
        const entriesArrayPointer = this.view.getUint32(matrixData + 8, true);
        const flat = entriesArrayPointer
          ? this.unmarshalArray(entriesArrayPointer, options)
          : [];
        const entries = [];
        for (let i = 0; i < rowCount; i++) {
          entries.push(flat.slice(i * columnCount, (i + 1) * columnCount));
        }
        return { kind: 'matrix', rows: rowCount, columns: columnCount, entries };
      }
      case TYPE.ALGEBRAIC: {
        // AlgebraicNumber readback: { kind, definingPolynomial,
        // isolatingInterval } — coefficients as BigInts ascending by
        // degree, endpoints as rational shapes. Approximation is an
        // explicit exit (toApproximation), so coerceExact: 'float' is
        // refused like the other exact-symbolic types.
        if (options.coerceExact === 'float') {
          throw new TypeError(
            'Cannot coerce AlgebraicNumber to Float at External boundary (handler opted in to coerceExact: "float")'
          );
        }
        return this.unmarshalAlgebraic(dataLo, options);
      }
      case TYPE.COMPLEX_ALGEBRAIC: {
        if (options.coerceExact === 'float') {
          throw new TypeError(
            'Cannot coerce ComplexAlgebraicNumber to Float at External boundary (handler opted in to coerceExact: "float")'
          );
        }
        const complexData = this.abs(dataLo + GC_HEADER_SIZE);
        const realPointer = this.view.getUint32(complexData, true);
        const imaginaryPointer = this.view.getUint32(complexData + 4, true);
        return {
          kind: 'complex-algebraic',
          real: this.unmarshalExactRealHeader(realPointer, options),
          imaginary: this.unmarshalExactRealHeader(imaginaryPointer, options),
        };
      }
      default:
        // For closures, externals, etc. - return a descriptor
        return { _type: type, _dataLo: dataLo, _dataHi: dataHi };
    }
  }

  /**
   * Expression readback shape from a HEADER pointer: { kind, head,
   * arguments }, head in structured-symbol shape, arguments
   * recursively unmarshalled. Shared by the TYPE.EXPRESSION value
   * case and Theorem statement readback (which holds a bare
   * Expression header, not a value slot).
   */
  readExpressionShape(headerPointer, options) {
    const headPointer = this.readExpressionHead(headerPointer);
    const argumentArrayPointer = this.readExpressionArgumentArray(headerPointer);
    // Read head as a Symbol structurally (even if it's some future
    // non-Symbol head type, readValueAt will handle it).
    const headDescriptionOffset = this.readSymbolDescription(headPointer);
    const headDescription = headDescriptionOffset === 0
      ? undefined
      : this.readString(headDescriptionOffset);
    const headRegistered = this.isSymbolRegistered(headPointer);
    const head = { kind: 'symbol', description: headDescription, registered: headRegistered };
    const argumentsValue = argumentArrayPointer
      ? this.unmarshalArray(argumentArrayPointer, options)
      : [];
    return { kind: 'expression', head, arguments: argumentsValue };
  }

  /**
   * Unmarshal a heap array to a JS array.
   * @param {number} headerPointer - Header pointer to array
   * @param {Object} options - Optional callbacks (passed to readValueAt)
   * @returns {Array} - JS array
   */
  unmarshalArray(headerPointer, options = {}) {
    const absArray = this.abs(headerPointer);
    const count = this.view.getUint32(absArray + GC_HEADER_SIZE, true);
    const elementsPointer = this.view.getUint32(absArray + GC_HEADER_SIZE + 8, true);

    const result = [];
    for (let i = 0; i < count; i++) {
      const elementPointer = elementsPointer + GC_HEADER_SIZE + i * VALUE_SIZE;
      result.push(this.readValueAt(elementPointer, options));
    }
    return result;
  }

  /**
   * Unmarshal a heap object to a JS object.
   * Object layout: [GC:8][prototype:4][count:4][capacity:4][flags:4][entries:4]
   * @param {number} headerPointer - Header pointer to object
   * @param {Object} options - Optional callbacks (passed to readValueAt)
   * @returns {Object} - JS object
   */
  unmarshalObject(headerPointer, options = {}) {
    const absObj = this.abs(headerPointer);
    const entrySize = 20;
    // Object layout: [GC:8][prototype:4][count:4][capacity:4][flags:4][entries:4]
    const count = this.view.getUint32(absObj + 12, true);       // count at offset 12
    const entriesPointer = this.view.getUint32(absObj + 24, true);  // entries at offset 24

    const result = {};
    const absEntries = this.abs(entriesPointer) + GC_HEADER_SIZE;

    for (let i = 0; i < count; i++) {
      // Entry: [nameOffset:4][type:4][flags:4][dataLo:4][dataHi:4]
      const entryAddr = absEntries + i * entrySize;
      const nameOffset = this.view.getUint32(entryAddr, true);
      const key = this.readString(nameOffset);

      // Read value from entry (type starts at +4)
      const valuePointer = entriesPointer + GC_HEADER_SIZE + i * entrySize + 4;
      result[key] = this.readValueAt(valuePointer, options);
    }
    return result;
  }

  /**
   * Unmarshal a heap Map to a JS Map.
   *
   * Map header (header-relative): [GC:8][size:4][slotCount:4][capacity:4]
   * [entriesPointer:4][sym_entries:4]. The entries block is its own
   * GC-headered allocation; each slot is [tombstone:4][key:16][value:16]
   * (stride 36), tombstone 0 = live.
   *
   * Order: a kernel Map promises no order, but a JS Map preserves insertion
   * order. We return entries in slot order — the boundary may EXPOSE an order
   * the kernel does not PROMISE; the host must not rely on it.
   *
   * @param {number} headerPointer - Segment-relative header pointer to the Map
   * @param {Object} options - Optional callbacks (passed to readValueAt)
   * @returns {Map} - JS Map
   */
  unmarshalMap(headerPointer, options = {}) {
    const absMap = this.abs(headerPointer);
    const slotCount = this.view.getUint32(absMap + MAP_LAYOUT.SLOT_COUNT, true);
    const entriesPointer = this.view.getUint32(absMap + MAP_LAYOUT.ENTRIES_PTR, true);

    const result = new Map();
    for (let i = 0; i < slotCount; i++) {
      const slotPointer = entriesPointer + GC_HEADER_SIZE + i * MAP_LAYOUT.SLOT_STRIDE;
      // Skip tombstoned slots (tombstone field non-zero = empty/deleted).
      if (this.view.getUint32(this.abs(slotPointer + MAP_LAYOUT.SLOT_TOMBSTONE), true) !== 0) {
        continue;
      }
      const key = this.readMapKey(slotPointer + MAP_LAYOUT.SLOT_KEY, options);
      const value = this.readValueAt(slotPointer + MAP_LAYOUT.SLOT_VALUE, options);
      result.set(key, value);
    }
    return result;
  }

  /**
   * Unmarshal a heap Set to a JS Set. Slot layout [tombstone:4][value:16]
   * (stride 20). Set members are read via readMapKey (a member is a key):
   * the same float-coercion collapse hazard applies, so members get the same
   * guarded coercion path as Map keys.
   *
   * @param {number} headerPointer - Segment-relative header pointer to the Set
   * @param {Object} options - Optional callbacks (passed to readValueAt)
   * @returns {Set} - JS Set
   */
  unmarshalSet(headerPointer, options = {}) {
    const absSet = this.abs(headerPointer);
    const slotCount = this.view.getUint32(absSet + SET_LAYOUT.SLOT_COUNT, true);
    const entriesPointer = this.view.getUint32(absSet + SET_LAYOUT.ENTRIES_PTR, true);

    const result = new Set();
    for (let i = 0; i < slotCount; i++) {
      const slotPointer = entriesPointer + GC_HEADER_SIZE + i * SET_LAYOUT.SLOT_STRIDE;
      if (this.view.getUint32(this.abs(slotPointer + SET_LAYOUT.SLOT_TOMBSTONE), true) !== 0) {
        continue;
      }
      result.add(this.readMapKey(slotPointer + SET_LAYOUT.SLOT_VALUE, options));
    }
    return result;
  }

  /**
   * Read a Map key (or Set member) with guarded float-coercion.
   *
   * Map values honor `coerceExact:'float'` freely (one slot, no collision).
   * Keys are different: a lossy float projection can collapse two distinct
   * keys into one JS Map slot, silently dropping an entry. So under
   * `coerceExact:'float'`:
   *   - integer-valued Rational keys in JS safe-integer range MAY coerce to a
   *     Number — distinct integers stay distinct, no collision (matches what
   *     `unwrapRational` already does);
   *   - non-integer Rational keys, or integer keys outside safe range, THROW
   *     (fail loud), matching the Complex/Symbol/Expression key precedent
   *     (those throw via their own readValueAt arms, reached because we pass
   *     full options through for any non-Rational key type).
   *
   * @param {number} keyPointer - Segment-relative pointer to the key value slot
   * @param {Object} options - Optional callbacks
   * @returns {*} - JS key
   */
  readMapKey(keyPointer, options = {}) {
    const keyType = this.view.getUint32(this.abs(keyPointer), true);
    if (keyType === TYPE.RATIONAL && options.coerceExact === 'float') {
      // Read the key EXACTLY (suppress coercion) so we can decide whether the
      // float projection would be collision-safe before committing to it.
      const exact = this.readValueAt(keyPointer, { ...options, coerceExact: undefined });
      // exact is either a structured Rational {kind, numerator, denominator}
      // or — if unwrapRational was set and it's a small integer — a Number.
      if (typeof exact === 'number') {
        return exact;  // already a safe-integer Number; collision-safe
      }
      const isInteger = exact.denominator === 1n;
      const inSafeRange =
        exact.numerator >= -9007199254740992n && exact.numerator <= 9007199254740992n;
      if (isInteger && inSafeRange) {
        return Number(exact.numerator);  // collision-safe integer projection
      }
      throw new TypeError(
        'Cannot coerce non-integer (or out-of-safe-range) Rational Map key to ' +
        'Float at External boundary (handler opted in to coerceExact: "float") — ' +
        'lossy key projection could collapse distinct keys'
      );
    }
    // Any other key type: read with full options. Complex/Symbol/Expression
    // keys throw via their own arms under coerceExact:'float'.
    return this.readValueAt(keyPointer, options);
  }

  /**
   * Unmarshal a msgpack value from memory.
   * @param {number} addr - Absolute address of msgpack bytes
   * @param {number} length - Length of msgpack data
   * @returns {*} - JS value
   */
  unmarshalMsgpack(addr, length) {
    const { value } = this.unmarshalMsgpackWithLength(addr, addr + length);
    return value;
  }

  /**
   * Unmarshal a msgpack value and return the next address.
   * @param {number} addr - Current position
   * @param {number} endAddr - End boundary
   * @returns {Object} - { value, nextAddr }
   */
  unmarshalMsgpackWithLength(addr, endAddr) {
    const u8 = new Uint8Array(this.memory.buffer);

    if (addr >= endAddr) {
      return { value: undefined, nextAddr: addr };
    }

    const byte = u8[addr];

    // Positive fixint (0x00-0x7f)
    if (byte <= 0x7f) {
      return { value: byte, nextAddr: addr + 1 };
    }

    // Negative fixint (0xe0-0xff)
    if (byte >= 0xe0) {
      return { value: (byte | 0xffffff00) >> 0, nextAddr: addr + 1 };
    }

    // Fixmap (0x80-0x8f)
    if (byte >= 0x80 && byte <= 0x8f) {
      const count = byte & 0x0f;
      return this.unmarshalMsgpackMap(addr + 1, endAddr, count);
    }

    // Fixarray (0x90-0x9f)
    if (byte >= 0x90 && byte <= 0x9f) {
      const count = byte & 0x0f;
      return this.unmarshalMsgpackArray(addr + 1, endAddr, count);
    }

    // Fixstr (0xa0-0xbf)
    if (byte >= 0xa0 && byte <= 0xbf) {
      const len = byte & 0x1f;
      const str = new TextDecoder().decode(u8.slice(addr + 1, addr + 1 + len));
      return { value: str, nextAddr: addr + 1 + len };
    }

    // nil (0xc0)
    if (byte === 0xc0) return { value: null, nextAddr: addr + 1 };
    // false (0xc2)
    if (byte === 0xc2) return { value: false, nextAddr: addr + 1 };
    // true (0xc3)
    if (byte === 0xc3) return { value: true, nextAddr: addr + 1 };

    // bin8/16/32 (0xc4-0xc6) — mirror of the WAT decoder's bin
    // support: materialize a copied Uint8Array. Falling to the
    // unsupported-type arm below would be worse than a wrong value:
    // its nextAddr advances one byte, desyncing every subsequent
    // sibling in the containing walk.
    if (byte === 0xc4) {
      const len = u8[addr + 1];
      return { value: u8.slice(addr + 2, addr + 2 + len), nextAddr: addr + 2 + len };
    }
    if (byte === 0xc5) {
      const len = this.view.getUint16(addr + 1, false);
      return { value: u8.slice(addr + 3, addr + 3 + len), nextAddr: addr + 3 + len };
    }
    if (byte === 0xc6) {
      const len = this.view.getUint32(addr + 1, false);
      return { value: u8.slice(addr + 5, addr + 5 + len), nextAddr: addr + 5 + len };
    }

    // float32 (0xca)
    if (byte === 0xca) {
      return { value: this.view.getFloat32(addr + 1, false), nextAddr: addr + 5 };
    }
    // float64 (0xcb)
    if (byte === 0xcb) {
      return { value: this.view.getFloat64(addr + 1, false), nextAddr: addr + 9 };
    }

    // uint8 (0xcc)
    if (byte === 0xcc) return { value: u8[addr + 1], nextAddr: addr + 2 };
    // uint16 (0xcd)
    if (byte === 0xcd) return { value: this.view.getUint16(addr + 1, false), nextAddr: addr + 3 };
    // uint32 (0xce)
    if (byte === 0xce) return { value: this.view.getUint32(addr + 1, false), nextAddr: addr + 5 };
    // uint64 (0xcf)
    if (byte === 0xcf) {
      const hi = this.view.getUint32(addr + 1, false);
      const lo = this.view.getUint32(addr + 5, false);
      return { value: hi * 4294967296 + lo, nextAddr: addr + 9 };
    }

    // int8 (0xd0)
    if (byte === 0xd0) return { value: this.view.getInt8(addr + 1), nextAddr: addr + 2 };
    // int16 (0xd1)
    if (byte === 0xd1) return { value: this.view.getInt16(addr + 1, false), nextAddr: addr + 3 };
    // int32 (0xd2)
    if (byte === 0xd2) return { value: this.view.getInt32(addr + 1, false), nextAddr: addr + 5 };
    // int64 (0xd3)
    if (byte === 0xd3) {
      const hi = this.view.getInt32(addr + 1, false);
      const lo = this.view.getUint32(addr + 5, false);
      return { value: hi * 4294967296 + lo, nextAddr: addr + 9 };
    }

    // str8 (0xd9)
    if (byte === 0xd9) {
      const len = u8[addr + 1];
      const str = new TextDecoder().decode(u8.slice(addr + 2, addr + 2 + len));
      return { value: str, nextAddr: addr + 2 + len };
    }
    // str16 (0xda)
    if (byte === 0xda) {
      const len = this.view.getUint16(addr + 1, false);
      const str = new TextDecoder().decode(u8.slice(addr + 3, addr + 3 + len));
      return { value: str, nextAddr: addr + 3 + len };
    }
    // str32 (0xdb)
    if (byte === 0xdb) {
      const len = this.view.getUint32(addr + 1, false);
      const str = new TextDecoder().decode(u8.slice(addr + 5, addr + 5 + len));
      return { value: str, nextAddr: addr + 5 + len };
    }

    // array16 (0xdc)
    if (byte === 0xdc) {
      const count = this.view.getUint16(addr + 1, false);
      return this.unmarshalMsgpackArray(addr + 3, endAddr, count);
    }
    // array32 (0xdd)
    if (byte === 0xdd) {
      const count = this.view.getUint32(addr + 1, false);
      return this.unmarshalMsgpackArray(addr + 5, endAddr, count);
    }

    // map16 (0xde)
    if (byte === 0xde) {
      const count = this.view.getUint16(addr + 1, false);
      return this.unmarshalMsgpackMap(addr + 3, endAddr, count);
    }
    // map32 (0xdf)
    if (byte === 0xdf) {
      const count = this.view.getUint32(addr + 1, false);
      return this.unmarshalMsgpackMap(addr + 5, endAddr, count);
    }

    // Unsupported type
    return { value: undefined, nextAddr: addr + 1 };
  }

  /**
   * Unmarshal a msgpack array.
   * @param {number} addr - Start of array elements
   * @param {number} endAddr - End boundary
   * @param {number} count - Number of elements
   * @returns {Object} - { value: Array, nextAddr }
   */
  unmarshalMsgpackArray(addr, endAddr, count) {
    const arr = [];
    let pos = addr;
    for (let i = 0; i < count && pos < endAddr; i++) {
      const { value, nextAddr } = this.unmarshalMsgpackWithLength(pos, endAddr);
      arr.push(value);
      pos = nextAddr;
    }
    return { value: arr, nextAddr: pos };
  }

  /**
   * Unmarshal a msgpack map.
   * @param {number} addr - Start of map entries
   * @param {number} endAddr - End boundary
   * @param {number} count - Number of key-value pairs
   * @returns {Object} - { value: Object, nextAddr }
   */
  unmarshalMsgpackMap(addr, endAddr, count) {
    const obj = {};
    let pos = addr;
    for (let i = 0; i < count && pos < endAddr; i++) {
      const { value: key, nextAddr: keyEnd } = this.unmarshalMsgpackWithLength(pos, endAddr);
      const { value: val, nextAddr: valEnd } = this.unmarshalMsgpackWithLength(keyEnd, endAddr);
      if (typeof key === 'string') {
        obj[key] = val;
      }
      pos = valEnd;
    }
    return { value: obj, nextAddr: pos };
  }

  /**
   * Unmarshal an SS BigInt to a JS BigInt.
   * @param {number} headerPointer - Segment-relative header pointer
   * @returns {bigint} - JS BigInt value
   */
  unmarshalBigInt(headerPointer) {
    const { sign, limbs } = this.readBigInt(headerPointer);

    let result = 0n;
    for (let i = limbs.length - 1; i >= 0; i--) {
      result = (result << 32n) | BigInt(limbs[i]);
    }

    return sign ? -result : result;
  }

  /**
   * Unmarshal an SS Rational to a structured JS object with JS BigInts.
   * @param {number} headerPointer - Segment-relative Rational header pointer
   * @returns {{ kind: 'rational', numerator: bigint, denominator: bigint }}
   */
  unmarshalRational(headerPointer) {
    const { numeratorPointer, denominatorPointer } = this.readRational(headerPointer);
    return {
      kind: 'rational',
      numerator: this.unmarshalBigInt(numeratorPointer),
      denominator: this.unmarshalBigInt(denominatorPointer),
    };
  }

  /**
   * Unmarshal an SS Complex to a structured JS object.
   * @param {number} headerPointer - Segment-relative Complex header pointer
   * @returns {{ kind: 'complex', real: object, imaginary: object }}
   */
  unmarshalComplex(headerPointer) {
    const { realPointer, imaginaryPointer } = this.readComplex(headerPointer);
    return {
      kind: 'complex',
      real: this.unmarshalRational(realPointer),
      imaginary: this.unmarshalRational(imaginaryPointer),
    };
  }

  /**
   * Unmarshal an AlgebraicNumber heap header.
   * @param {number} headerPointer
   * @param {object} options
   * @returns {{ kind: 'algebraic', definingPolynomial: unknown[], isolatingInterval: unknown[] }}
   */
  unmarshalAlgebraic(headerPointer, options = {}) {
    const algebraicData = this.abs(headerPointer + GC_HEADER_SIZE);
    const coefficientsArrayPointer = this.view.getUint32(algebraicData, true);
    const intervalArrayPointer = this.view.getUint32(algebraicData + 4, true);
    const definingPolynomial = coefficientsArrayPointer
      ? this.unmarshalArray(coefficientsArrayPointer, options)
      : [];
    const isolatingInterval = intervalArrayPointer
      ? this.unmarshalArray(intervalArrayPointer, options)
      : [];
    return { kind: 'algebraic', definingPolynomial, isolatingInterval };
  }

  /**
   * Unmarshal a canonical exact-real component from its heap header.
   * @param {number} headerPointer
   * @param {object} options
   * @returns {bigint | object}
   */
  unmarshalExactRealHeader(headerPointer, options = {}) {
    const objectType = (this.view.getUint32(this.abs(headerPointer), true) >>> 24) & 0x7f;
    if (objectType === OBJ.BIGINT) return this.unmarshalBigInt(headerPointer);
    if (objectType === OBJ.RATIONAL) return this.unmarshalRational(headerPointer);
    if (objectType === OBJ.ALGEBRAIC) return this.unmarshalAlgebraic(headerPointer, options);
    throw new TypeError(`Invalid ComplexAlgebraicNumber component object type ${objectType}`);
  }

  // ===========================================================================
  // BigInt / Rational / Complex / Symbol / Expression readers
  // ===========================================================================

  /**
   * Read a BigInt from the heap.
   * @param {number} headerPointer - Segment-relative header pointer
   * @returns {{ sign: number, limbs: Uint32Array }}
   */
  readBigInt(headerPointer) {
    const absData = this.abs(headerPointer) + GC_HEADER_SIZE;
    const sign = this.view.getUint32(absData, true);
    const length = this.view.getUint32(absData + 4, true);
    const limbs = new Uint32Array(length);
    for (let i = 0; i < length; i++) {
      limbs[i] = this.view.getUint32(absData + 8 + i * 4, true);
    }
    return { sign, limbs };
  }

  /**
   * Read a Rational from the heap and return its numerator/denominator
   * pointers (as segment-relative header pointers).
   * @param {number} headerPointer - Segment-relative Rational header pointer
   * @returns {{ numeratorPointer: number, denominatorPointer: number }}
   */
  readRational(headerPointer) {
    const absData = this.abs(headerPointer) + GC_HEADER_SIZE;
    const numeratorPointer = this.view.getUint32(absData, true);
    const denominatorPointer = this.view.getUint32(absData + 4, true);
    return { numeratorPointer, denominatorPointer };
  }

  /**
   * Read a Complex from the heap and return its real/imaginary Rational
   * pointers.
   * @param {number} headerPointer - Segment-relative Complex header pointer
   * @returns {{ realPointer: number, imaginaryPointer: number }}
   */
  readComplex(headerPointer) {
    const absData = this.abs(headerPointer) + GC_HEADER_SIZE;
    const realPointer = this.view.getUint32(absData, true);
    const imaginaryPointer = this.view.getUint32(absData + 4, true);
    return { realPointer, imaginaryPointer };
  }

  /**
   * Read a Symbol's description string offset.
   * @param {number} headerPointer - Segment-relative Symbol header pointer
   * @returns {number} - Interned string offset (0 for undescribed)
   */
  readSymbolDescription(headerPointer) {
    const absData = this.abs(headerPointer) + GC_HEADER_SIZE;
    return this.view.getUint32(absData, true);
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
  isSymbolRegistered(headerPointer) {
    const registryPointer = this.getState(STATE.SYMBOL_REGISTRY);
    if (!registryPointer) return false;
    // Object layout: [GC:8][prototype:4][count:4][capacity:4][flags:4][entries:4]
    // Entry layout:  [nameOffset:4][type:4][flags:4][dataLo:4][dataHi:4]
    const absObj = this.abs(registryPointer);
    const count = this.view.getUint32(absObj + 12, true);
    const entriesPointer = this.view.getUint32(absObj + 24, true);
    if (!entriesPointer || count === 0) return false;
    const absEntries = this.abs(entriesPointer) + GC_HEADER_SIZE;
    const entrySize = 20;
    for (let i = 0; i < count; i++) {
      const entryAddr = absEntries + i * entrySize;
      const entryType = this.view.getUint32(entryAddr + 4, true);
      const entryDataLo = this.view.getUint32(entryAddr + 12, true);
      if (entryType === TYPE.SYMBOL && entryDataLo === headerPointer) {
        return true;
      }
    }
    return false;
  }

  /**
   * Read an Expression's head pointer (points at a Symbol).
   * @param {number} headerPointer - Segment-relative Expression header pointer
   * @returns {number} - Symbol header pointer
   */
  readExpressionHead(headerPointer) {
    const absData = this.abs(headerPointer) + GC_HEADER_SIZE;
    return this.view.getUint32(absData, true);
  }

  /**
   * Read an Expression's argument array pointer.
   * @param {number} headerPointer - Segment-relative Expression header pointer
   * @returns {number} - Array header pointer
   */
  readExpressionArgumentArray(headerPointer) {
    const absData = this.abs(headerPointer) + GC_HEADER_SIZE;
    return this.view.getUint32(absData + 4, true);
  }

  // ===========================================================================
  // Context inspection
  // ===========================================================================

  /**
   * Get the number of allocated context slots.
   * @returns {number}
   */
  getContextCount() {
    return this.view.getUint32(this.abs(STATE.CONTEXT_COUNT), true);
  }

  /**
   * Get the slot→pointer context table's DATA pointer (layout v10: the
   * table is a growable STACK_BLOCK heap object; this cell is forwarded
   * by the collector when compaction moves it).
   * @returns {number}
   */
  getContextTablePointer() {
    return this.view.getUint32(this.abs(STATE.CONTEXT_TABLE_POINTER), true);
  }

  /**
   * Get the slot→allocation-generation table's DATA pointer.
   * @returns {number}
   */
  getContextGenerationTablePointer() {
    return this.view.getUint32(
      this.abs(STATE.CONTEXT_GENERATION_TABLE_POINTER), true);
  }

  /**
   * Return the allocation generation currently assigned to a slot.
   * A generation remains readable after the context is freed.
   * @param {number} slot
   * @returns {number}
   */
  getContextGeneration(slot) {
    if (!Number.isInteger(slot) || slot < 0 || slot >= this.getContextTableCapacity()) {
      throw new Error(`getContextGeneration: slot ${slot} is outside the context table`);
    }
    return this.view.getUint32(
      this.abs(this.getContextGenerationTablePointer() + slot * 4), true);
  }

  /**
   * Test whether one generation still owns an allocated context slot.
   * @param {number} slot
   * @param {number} generation
   * @returns {boolean}
   */
  isContextIdentityLive(slot, generation) {
    return Number.isInteger(generation)
      && generation !== 0
      && this.getContextGeneration(slot) === generation
      && this.getContextBase(slot) !== 0;
  }

  /**
   * Get the segment-relative base address of a context's object by slot index.
   *
   * The slot→pointer table holds one i32 per slot — the context object's
   * segment-relative address. The context object lives on the heap and moves
   * under compaction; the table entry is updated on move. A table entry of 0
   * means the slot is unallocated.
   *
   * Bounds tripwire: a slot outside the table names a context that cannot
   * exist. Corrupted linked slot identifiers from heap structures are the
   * canonical source. Without this check, an in-view table read can produce a
   * silent wild base that later writes through the heap, while an out-of-view
   * read produces an uninformative DataView RangeError. Rejecting it here
   * keeps the failure named and localized at the reader boundary.
   *
   * @param {number} slot - Context slot index
   * @returns {number} - Segment-relative address of the context object
   */
  getContextBase(slot) {
    const tableBase = this.getContextTablePointer();
    if (!Number.isInteger(slot) || slot < 0) {
      throw new Error(`getContextBase: slot ${slot} is not a valid slot index`);
    }
    const headerWord = this.view.getUint32(this.abs(tableBase - GC_HEADER_SIZE), true);
    const capacity = Math.floor(((headerWord & 0x00ffffff) - GC_HEADER_SIZE) / 4);
    if (slot >= capacity) {
      throw new Error(
        `getContextBase: slot ${slot} is outside the context table ` +
        `(capacity ${capacity}) — a corrupted slot id (promise waiter list, ` +
        `child list, or embedder-held slot) names a context that cannot exist`);
    }
    return this.view.getUint32(this.abs(tableBase + slot * 4), true);
  }

  /**
   * Get the state block address of a context.
   * @param {number} slot - Context slot index
   * @returns {number} - Absolute address of context state block
   */
  getContextStateBase(slot) {
    const base = this.getContextBase(slot);
    if (base === 0) throw new Error(`getContextStateBase: slot ${slot} is free (zeroed table entry)`);
    return base + CONTEXT_STATE_OFFSET;
  }

  /**
   * Capacity of the slot→pointer table in slots. Layout v10: the table is a
   * heap object, so its capacity is its GC header's size word (which includes
   * the header) minus the header, over 4 bytes per slot. Works on fresh and
   * restored sessions — the header rides the snapshot with the heap.
   */
  getContextTableCapacity() {
    const tablePointer = this.getContextTablePointer();
    const headerWord = this.view.getUint32(this.abs(tablePointer - GC_HEADER_SIZE), true);
    return Math.floor(((headerWord & 0x00ffffff) - GC_HEADER_SIZE) / 4);
  }

  /**
   * Get context exit condition.
   * @param {number} slot
   * @returns {number} EXIT_* constant, 0 (no exit yet), or CONTEXT_STATUS_FREE
   */
  getExitCondition(slot) {
    // A zeroed slot→pointer table entry IS the freeness marker (freeContext
    // zeroes it; the context object may already be reclaimed). Report FREE
    // without touching the heap: reused state-block bytes could otherwise
    // fabricate a context and send later heap traversal through non-pointers.
    if (this.getContextBase(slot) === 0) {
      // This is the read-side complement to the header-write ring. It is
      // recorded unconditionally because legitimately free slots also take
      // this path. A burst across different slots in a short span, rather than
      // any single event, is the anomaly signature a diagnostic reader uses.
      writeHeaderEventRingEntry(this.view, this.baseOffset, {
        kind: HEADER_EVENT_KIND.ZERO_GUARD_FIRED,
        site: HEADER_EVENT_SITE.JS_MEMORY_READER_GET_EXIT_CONDITION,
        slot,
      });
      return CONTEXT_STATUS_FREE;
    }
    const stateBase = this.abs(this.getContextStateBase(slot));
    return this.view.getUint32(stateBase + CTX.EXIT_CONDITION, true);
  }

  /**
   * Get response type (host → interpreter input).
   * @param {number} slot
   * @returns {number} RESPONSE_NORMAL or RESPONSE_THROW
   */
  getResponseType(slot) {
    const stateBase = this.abs(this.getContextStateBase(slot));
    return this.view.getUint32(stateBase + CTX.RESPONSE_TYPE, true);
  }

  /**
   * Get context instruction index.
   * @param {number} slot
   * @returns {number}
   */
  getContextInstructionIndex(slot) {
    const stateBase = this.abs(this.getContextStateBase(slot));
    return this.view.getUint32(stateBase + CTX.INSTRUCTION_INDEX, true);
  }

  /**
   * Get context scope pointer.
   * @param {number} slot
   * @returns {number}
   */
  getContextScope(slot) {
    const stateBase = this.abs(this.getContextStateBase(slot));
    return this.view.getUint32(stateBase + CTX.SCOPE, true);
  }

  /**
   * Get context pending stack pointer (relative to context base).
   * @param {number} slot
   * @returns {number}
   */
  getContextPendingPointer(slot) {
    const stateBase = this.abs(this.getContextStateBase(slot));
    return this.view.getUint32(stateBase + CTX.PENDING_POINTER, true);
  }

  /**
   * Get context call stack pointer (relative to context base).
   * @param {number} slot
   * @returns {number}
   */
  getContextCallStackPointer(slot) {
    const stateBase = this.abs(this.getContextStateBase(slot));
    return this.view.getUint32(stateBase + CTX.CALL_STACK_POINTER, true);
  }

  /**
   * Get context grant stack pointer (relative to context base).
   * @param {number} slot
   * @returns {number}
   */
  getContextGrantStackPointer(slot) {
    const stateBase = this.abs(this.getContextStateBase(slot));
    return this.view.getUint32(stateBase + CTX.GRANT_STACK_POINTER, true);
  }

  /**
   * Get context try stack pointer (relative to context base).
   * @param {number} slot
   * @returns {number}
   */
  getContextTryStackPointer(slot) {
    const stateBase = this.abs(this.getContextStateBase(slot));
    return this.view.getUint32(stateBase + CTX.TRY_STACK_POINTER, true);
  }

  /**
   * Get context completion type.
   * @param {number} slot
   * @returns {number}
   */
  getContextCompletionType(slot) {
    const stateBase = this.abs(this.getContextStateBase(slot));
    return this.view.getUint32(stateBase + CTX.COMPLETION_TYPE, true);
  }

  /**
   * Get context completion value.
   * @param {number} slot
   * @returns {number}
   */
  getContextCompletionValue(slot) {
    const stateBase = this.abs(this.getContextStateBase(slot));
    return this.view.getUint32(stateBase + CTX.COMPLETION_VALUE, true);
  }

  /**
   * Get context continuation ID.
   * @param {number} slot
   * @returns {number}
   */
  getContextContinuationId(slot) {
    const stateBase = this.abs(this.getContextStateBase(slot));
    return this.view.getUint32(stateBase + CTX.CONTINUATION_ID, true);
  }

  /**
   * Get the promise pointer this context is waiting on.
   * @param {number} slot
   * @returns {number} - Promise data pointer, or 0 if not waiting
   */
  getContextWaitingOn(slot) {
    const stateBase = this.abs(this.getContextStateBase(slot));
    return this.view.getUint32(stateBase + CTX.WAITING_ON, true);
  }


  // ===========================================================================
  // Promise readers
  // ===========================================================================

  /**
   * Validate that `promisePointer` addresses a live in-heap object whose
   * GC header type is OBJ.PROMISE; throw a named, value-carrying error if
   * not. This is the reader-side counterpart to the collector's live-promise
   * validation.
   *
   * Callers are settle paths about to walk and clear promise state through
   * the pointer. A stale or overwritten pointer would not merely read garbage:
   * popAllWaiters would clear links through whatever the WAITERS word names.
   * Validation here keeps the failure at the reader boundary instead of
   * allowing a later, uninformative DataView RangeError.
   *
   * OBJ.PROMISE = 11 (constants.js OBJ block); the header's type field is
   * bits 24-30, matching the collector's check.
   *
   * @param {number} promisePointer - candidate promise DATA pointer
   * @param {string} where - caller name for the error message
   */
  assertPromiseAt(promisePointer, where) {
    const headerPointer = promisePointer - GC_HEADER_SIZE;
    const heapStart = this.getHeapStart();
    const heapPointer = this.getHeapPointer();
    if (headerPointer < heapStart || headerPointer >= heapPointer) {
      throw new Error(
        `${where}: promise pointer ${promisePointer} is outside the live ` +
        `heap [${heapStart}, ${heapPointer}) — a stale (un-forwarded or ` +
        `reaped) promise reference`);
    }
    const header = this.view.getUint32(this.abs(headerPointer), true);
    const objType = (header >>> 24) & 0x7f;
    if (objType !== 11 /* OBJ.PROMISE */) {
      throw new Error(
        `${where}: promise pointer ${promisePointer} names a live heap ` +
        `object of type ${objType}, not a promise (header 0x${header.toString(16)}) ` +
        `— the pointer is stale and its memory was reused`);
    }
  }

  /**
   * Get promise status.
   * @param {number} promisePointer - Data pointer to promise
   * @returns {number} - 0=pending, 1=resolved, 2=rejected
   */
  getPromiseStatus(promisePointer) {
    return this.view.getUint32(this.abs(promisePointer) + PROMISE.STATUS, true);
  }

  /**
   * Get promise value (16-byte tagged value).
   * @param {number} promisePointer - Data pointer to promise
   * @returns {object} - { type, flags, lo, hi }
   */
  getPromiseValue(promisePointer) {
    const absAddr = this.abs(promisePointer) + PROMISE.VALUE;
    return {
      type: this.view.getUint32(absAddr, true),
      flags: this.view.getUint32(absAddr + 4, true),
      lo: this.view.getUint32(absAddr + 8, true),
      hi: this.view.getUint32(absAddr + 12, true),
    };
  }

  /**
   * Get the PromiseWaiter data pointer at the head of a promise's list.
   * @param {number} promisePointer
   * @returns {number} PromiseWaiter data pointer, or zero
   */
  getPromiseWaiters(promisePointer) {
    return this.view.getUint32(
      this.abs(promisePointer) + PROMISE.WAITERS, true);
  }

  /**
   * Get the head of a promise's handler list.
   * @param {number} promisePointer - Data pointer to promise
   * @returns {number} - Handler data pointer, or -1 for empty
   */
  getPromiseHandlers(promisePointer) {
    return this.view.getInt32(this.abs(promisePointer) + PROMISE.HANDLERS, true);
  }

  /**
   * Read a ThenHandler's fields.
   * @param {number} handlerPointer - Data pointer to handler
   * @returns {object} - { onResolved, onRejected, childPromise, next, isFinally }
   */
  getThenHandler(handlerPointer) {
    const absData = this.abs(handlerPointer);
    const rawFlags = this.view.getInt32(absData + THEN_HANDLER.FLAGS, true);
    return {
      onResolved: this.view.getUint32(absData + THEN_HANDLER.ON_RESOLVED, true),
      onRejected: this.view.getUint32(absData + THEN_HANDLER.ON_REJECTED, true),
      childPromise: this.view.getUint32(absData + THEN_HANDLER.CHILD_PROMISE, true),
      next: this.view.getInt32(absData + THEN_HANDLER.NEXT, true),
      isFinally: (rawFlags & THEN_HANDLER_FLAG_FINALLY) !== 0,
      flags: rawFlags,
    };
  }

  // ===========================================================================
  // Frame async-promise reader
  // ===========================================================================

  /**
   * Get the async promise pointer from a call frame.
   * @param {number} framePointer - Absolute pointer to frame
   * @returns {number} - Promise data pointer, or 0 for non-async frames
   */
  getFrameAsyncPromise(framePointer) {
    return this.view.getUint32(framePointer + FRAME.ASYNC_PROMISE, true);
  }
}

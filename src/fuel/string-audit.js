// String-reference audit used by the collector's verify mode and external
// audit operations. Kept separate from debug.js so production code can use
// the validator without importing debug-only facilities.

import {
  OBJ,
  TYPE,
  GC_HEADER_SIZE,
  readGCHeaderSize,
  VALUE_SIZE,
  STRING_DATA_START,
  GRANT_ENTRY_SIZE,
  EXIT_EXTERNAL_CALL,
  EXIT_EXTERNAL_PROPERTY,
  EXIT_EXTERNAL_PROPERTY_SET,
} from './constants.js';

/**
 * auditStringReferences(memoryImage, options?) → report
 *
 * Validate every string reference reachable by a LINEAR heap walk against
 * the string region's actual entry starts. A reference is ROTTEN when it
 * does not name a real entry: pointing outside [STRING_DATA_START, bump),
 * mid-entry, or at a heap address. Reads through rotten references fail
 * differently by path: msgpack.encode silently drops the value, JS-side
 * reads throw readString-out-of-region, and WAT-side concatenation traps
 * with memory-access-out-of-bounds.
 *
 * Coverage mirrors the collector's string-forwarding walk
 * (updateObjectStringOffsets): OBJECT/FUNCTION entries (keys + values +
 * sym-entries), ARRAY elements (+ sym-entries), SCOPE entries, MAP/SET
 * slots (+ sym-entries), SYMBOL descriptions, TYPED_ARRAY_DESCRIPTOR
 * sym-entries — PLUS every allocated context's string-bearing state,
 * mirroring compactStrings' per-context forwarders: pending-stack value
 * slots, grant-stack identifiers (real 32-byte stride), the completion
 * value, and the external request block (methodOffset + staged args)
 * when the slot is parked at an external yield. Context findings carry
 * `where: "context[slot]...."` and objType 'context'; this coverage is
 * what catches rot in CONTEXT-STACK state that a pure heap walk cannot
 * see. A finding here therefore maps 1:1 onto a forwarding gap or an
 * out-of-band write.
 * Deliberately NOT covered (same as the forwarder's per-parent
 * bounding): raw ARRAY_DATA / OBJECT_DATA / SCOPE_ENTRIES / MAP_ENTRIES
 * / SET_ENTRIES tails, code-block operands, AST nodes, and call/try
 * stacks (no string-bearing fields).
 *
 * Read-only; safe on a live image between runs and on restored bytes.
 *
 * @param {Object} memoryImage - MemoryReader/MemoryImage (abs, view, region accessors)
 * @param {Object} [options]
 * @param {number} [options.maxFindings=64] - stop collecting after this many
 * @returns {{ checkedObjects: number, checkedReferences: number,
 *             checkedContexts: number, validStrings: number,
 *             regionCorrupt: boolean,
 *             findings: Array<{ headerPointer: number,
 *                               objType: number|'context',
 *                               where: string, id: number }> }}
 */
export function auditStringReferences(memoryImage, { maxFindings = 64 } = {}) {
  const mem = memoryImage;
  const stringStart = mem.getStringStart();
  const bumpRel = mem.getStringPointer() - stringStart;

  // 1. Enumerate the REAL entry starts. An id is only valid if it lands
  //    exactly on one (in-range but mid-entry is still rot).
  const validIds = new Set();
  let regionCorrupt = false;
  {
    let id = STRING_DATA_START;
    while (id < bumpRel) {
      const length = mem.view.getUint32(mem.abs(stringStart + id), true);
      if (length > bumpRel - id) { regionCorrupt = true; break; }
      validIds.add(id);
      id += (4 + length + 3) & ~3;
    }
  }

  const report = {
    checkedObjects: 0,
    checkedReferences: 0,
    checkedContexts: 0,
    validStrings: validIds.size,
    regionCorrupt,
    findings: [],
  };

  const flag = (headerPointer, objType, where, id) => {
    if (report.findings.length < maxFindings) {
      report.findings.push({ headerPointer, objType, where, id });
    }
  };
  const checkId = (headerPointer, objType, where, id, zeroOk = false) => {
    report.checkedReferences += 1;
    if (id === 0 && zeroOk) return;
    if (!validIds.has(id)) flag(headerPointer, objType, where, id);
  };
  // A 16-byte value slot: STRING carries its id in data_lo; BOUND_METHOD
  // with a string receiver carries an id in data_lo; EXTERNAL_METHOD
  // carries the method-name id in data_hi (0 tolerated, mirroring the
  // collector's markValue guard).
  const checkValueSlot = (headerPointer, objType, where, slotRel) => {
    const abs = mem.abs(slotRel);
    const type = mem.view.getUint32(abs, true);
    if (type === TYPE.STRING) {
      checkId(headerPointer, objType, where, mem.view.getUint32(abs + 8, true));
    } else if (type === TYPE.BOUND_METHOD) {
      const flags = mem.view.getUint32(abs + 4, true);
      if ((flags & 0xff) === TYPE.STRING) {
        checkId(headerPointer, objType, `${where}.receiver`, mem.view.getUint32(abs + 8, true));
      }
    } else if (type === TYPE.EXTERNAL_METHOD) {
      checkId(headerPointer, objType, `${where}.methodName`, mem.view.getUint32(abs + 12, true), true);
    }
  };
  const checkSymEntries = (headerPointer, objType, slotRel) => {
    const symHeader = mem.view.getUint32(mem.abs(slotRel), true);
    if (symHeader === 0) return;
    const symData = symHeader + GC_HEADER_SIZE;
    const symCount = mem.view.getUint32(mem.abs(symData), true);
    for (let i = 0; i < symCount; i++) {
      checkValueSlot(headerPointer, objType, `sym[${i}]`, symData + 8 + i * 20 + 4);
    }
  };
  const checkEntryTable = (headerPointer, objType, entriesHeader, count) => {
    if (entriesHeader === 0) return;
    const entriesData = entriesHeader + GC_HEADER_SIZE;
    for (let i = 0; i < count; i++) {
      const entryRel = entriesData + i * 20;
      checkId(headerPointer, objType, `key[${i}]`, mem.view.getUint32(mem.abs(entryRel), true));
      checkValueSlot(headerPointer, objType, `value[${i}]`, entryRel + 4);
    }
  };

  const heapStart = mem.getHeapStart();
  const heapPointer = mem.getHeapPointer();
  let headerPointer = heapStart;
  while (headerPointer < heapPointer) {
    const word = mem.view.getUint32(mem.abs(headerPointer), true);
    const size = readGCHeaderSize(mem.view, mem.abs(headerPointer), word);
    if (size === 0) break;
    const objType = (word >>> 24) & 0x7f;
    const data = headerPointer + GC_HEADER_SIZE;
    report.checkedObjects += 1;

    switch (objType) {
      case OBJ.OBJECT:
      case OBJ.FUNCTION: {
        // [prototype:4][count:4][capacity:4][flags:4][entries:4][sym:4]
        const count = mem.view.getUint32(mem.abs(data + 4), true);
        const entriesHeader = mem.view.getUint32(mem.abs(data + 16), true);
        checkEntryTable(headerPointer, objType, entriesHeader, count);
        checkSymEntries(headerPointer, objType, data + 20);
        break;
      }
      case OBJ.ARRAY: {
        // [length:4][?:4][elementsHeader:4][?:4][sym:4]
        const length = mem.view.getUint32(mem.abs(data), true);
        const elementsHeader = mem.view.getUint32(mem.abs(data + 8), true);
        if (elementsHeader !== 0) {
          const elements = elementsHeader + GC_HEADER_SIZE;
          for (let i = 0; i < length; i++) {
            checkValueSlot(headerPointer, objType, `elem[${i}]`, elements + i * VALUE_SIZE);
          }
        }
        checkSymEntries(headerPointer, objType, data + 16);
        break;
      }
      case OBJ.SCOPE: {
        // [parent:4][count:4][capacity:4][entriesHeader:4]
        const count = mem.view.getUint32(mem.abs(data + 4), true);
        const entriesHeader = mem.view.getUint32(mem.abs(data + 12), true);
        if (entriesHeader >= heapStart && entriesHeader < heapPointer) {
          checkEntryTable(headerPointer, objType, entriesHeader, count);
        }
        break;
      }
      case OBJ.MAP:
      case OBJ.SET: {
        const slotCount = mem.view.getUint32(mem.abs(data + 4), true);
        const entriesHeader = mem.view.getUint32(mem.abs(data + 12), true);
        if (entriesHeader !== 0) {
          const entriesData = entriesHeader + GC_HEADER_SIZE;
          if (objType === OBJ.MAP) {
            for (let i = 0; i < slotCount; i++) {
              checkValueSlot(headerPointer, objType, `mapKey[${i}]`, entriesData + i * 36 + 4);
              checkValueSlot(headerPointer, objType, `mapValue[${i}]`, entriesData + i * 36 + 20);
            }
          } else {
            for (let i = 0; i < slotCount; i++) {
              checkValueSlot(headerPointer, objType, `setValue[${i}]`, entriesData + i * 20 + 4);
            }
          }
        }
        checkSymEntries(headerPointer, objType, data + 16);
        break;
      }
      case OBJ.SYMBOL: {
        // [descriptionStringOffset:4] — 0 = no description.
        checkId(headerPointer, objType, 'description', mem.view.getUint32(mem.abs(data), true), true);
        break;
      }
      case OBJ.REGEXP: {
        // [patternStringOffset:4] at data+0 — the source pattern id.
        checkId(headerPointer, objType, 'pattern', mem.view.getUint32(mem.abs(data), true), true);
        break;
      }
      case OBJ.TYPED_ARRAY_DESCRIPTOR: {
        checkSymEntries(headerPointer, objType, data + 12);
        break;
      }
      default:
        break;
    }

    headerPointer += size;
  }

  // Context-state walk — mirrors compactStrings' per-context forwarders.
  // Call and try stacks are skipped: no string-bearing fields (frames
  // hold scope/iteration/promise pointers; try entries hold indices +
  // a scope pointer).
  const contextCount = mem.getContextCount();
  for (let slot = 0; slot < contextCount; slot++) {
    if (mem.getContextBase(slot) === 0) continue;
    report.checkedContexts += 1;
    const where = (part) => `context[${slot}].${part}`;
    const checkContextValueSlot = (part, slotRel) => {
      const abs = mem.abs(slotRel);
      const type = mem.view.getUint32(abs, true);
      if (type === TYPE.STRING) {
        checkId(slotRel, 'context', where(part), mem.view.getUint32(abs + 8, true));
      } else if (type === TYPE.BOUND_METHOD) {
        const flags = mem.view.getUint32(abs + 4, true);
        if ((flags & 0xff) === TYPE.STRING) {
          checkId(slotRel, 'context', where(`${part}.receiver`), mem.view.getUint32(abs + 8, true));
        }
      } else if (type === TYPE.EXTERNAL_METHOD) {
        checkId(slotRel, 'context', where(`${part}.methodName`), mem.view.getUint32(abs + 12, true), true);
      }
    };

    // Pending (operand) stack: 16-byte value slots in [base, pointer).
    const pendingBase = mem.getPendingStackBase(slot);
    const pendingPointer = mem.getContextPendingPointer(slot);
    for (let addr = pendingBase, i = 0; addr < pendingPointer; addr += VALUE_SIZE, i++) {
      checkContextValueSlot(`pending[${i}]`, addr);
    }

    // Grant-stack identifiers are value slots at entry offset 0. Use the
    // shared 32-byte entry stride so later identifiers are not skipped.
    const grantBase = mem.getGrantStackBase(slot);
    const grantPointer = mem.getContextGrantStackPointer(slot);
    for (let addr = grantBase, i = 0; addr < grantPointer; addr += GRANT_ENTRY_SIZE, i++) {
      checkContextValueSlot(`grant[${i}].identifier`, addr);
    }

    // Completion value (live while a finally runs with a pending
    // return/throw) — same guard as markContextRoots.
    const completionType = mem.getContextCompletionType(slot);
    const completionValue = mem.getContextCompletionValue(slot);
    if (completionType !== 0 && completionValue !== 0) {
      checkContextValueSlot('completionValue', completionValue);
    }

    // External request block for a slot parked at an external yield:
    // methodOffset id + the staged arg value slots (they sit ABOVE the
    // pre-positioned pending pointer, missed by the stack scan). Each parked
    // slot's per-context request block is audited independently.
    const exitCondition = mem.getExitCondition(slot);
    if (exitCondition === EXIT_EXTERNAL_CALL
        || exitCondition === EXIT_EXTERNAL_PROPERTY
        || exitCondition === EXIT_EXTERNAL_PROPERTY_SET) {
      const requestBase = mem.getExternalRequestBase(slot);
      const absReqBase = mem.abs(requestBase);
      checkId(requestBase, 'context', where('requestBase.methodOffset'),
        mem.view.getUint32(absReqBase + 4, true), true);
      const argsPointer = mem.view.getUint32(absReqBase + 8, true);
      const argCount = mem.view.getUint32(absReqBase + 12, true);
      for (let i = 0; i < argCount; i++) {
        checkContextValueSlot(`requestBase.arg[${i}]`, argsPointer + i * VALUE_SIZE);
      }
    }
  }

  return report;
}

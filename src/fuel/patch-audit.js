/**
 * Live-state audit for live code patching.
 *
 * Given a vat and a differ result (`diffNewSource` /
 * `diffAppendedCode` output), find every live reference into code the
 * diff marked `changed` or `removed`, and classify each such unit
 * into a patch tier:
 *
 *   'trivial' — no live references; patching is rebinding only.
 *   'rewire'  — heap closures (possibly exposed as membrane closure
 *               handles) point into the old body; the patcher must
 *               rebind or retarget them.
 *   'active'  — execution state sits inside the old body (program
 *               counter, frame return address, try/grant handler
 *               target, or an in-flight iteration callback); that
 *               activation drains on the old code.
 *
 * PRECONDITION: run `session.gc()` on the scratch BEFORE
 * `diffNewSource`. The closure walk reads the raw heap; without a
 * prior collection a dead-but-uncollected closure into a changed unit
 * forces 'rewire' falsely. The audit itself is strictly read-only.
 *
 * Holder attribution is deliberately out of scope: the heap walk
 * finds every closure regardless of holder (scope binding, array
 * element, pending-stack value, promise handler record); the patcher
 * retargets by header pointer, so holders don't matter to it. The
 * one exception is membrane closure handles, whose slots are joined
 * in because the patcher and the host care which handles are
 * affected.
 */

import {
  OBJ,
  readGCHeaderSize,
  FUNCTION,
  FRAME,
  FRAME_SIZE,
  FRAME_FLAG_NATIVE_CONTINUATION,
  CONTEXT_STATUS_FREE,
} from './constants.js';

/**
 * @param {object} memoryImage - MemoryImage of the audited vat
 * @param {object} membrane - the session's Membrane (closure handles)
 * @param {object} diffResult - diffNewSource / diffAppendedCode output
 * @returns {{ unitFindings: Array, identicalUnitCount: number }}
 */
export function auditLiveReferences(memoryImage, membrane, diffResult) {
  // Auditable targets: changed/removed units with an old range.
  // Added units have no old code, so nothing can reference them.
  const targets = diffResult.units.filter(
    (unit) => (unit.verdict === 'changed' || unit.verdict === 'removed') &&
              unit.oldRange !== null);

  const findingsByUnitId = new Map();
  for (const unit of targets) {
    findingsByUnitId.set(unit.id, {
      unitId: unit.id,
      name: unit.name,
      verdict: unit.verdict,
      tier: 'trivial',
      closures: [],
      activeReferences: [],
    });
  }

  // Innermost target containing an instruction index. Units nest
  // properly (parent ranges contain child ranges, siblings are
  // disjoint), so smallest-containing-range is the innermost. The
  // toplevel unit spans all of old code; a reference inside a
  // function body attributes to the function, not the toplevel.
  function targetContaining(instructionIndex) {
    let innermost = null;
    for (const unit of targets) {
      const [start, end] = unit.oldRange;
      if (instructionIndex < start || instructionIndex >= end) continue;
      if (innermost === null ||
          (end - start) < (innermost.oldRange[1] - innermost.oldRange[0])) {
        innermost = unit;
      }
    }
    return innermost;
  }

  // --- Heap closures -------------------------------------------------
  // Raw header walk, same traversal as the collector's clearAllMarks
  // (decoded sizes are actual sizes; objects are consecutive).
  const closureFindingByHeaderPointer = new Map();
  {
    const heapPointer = memoryImage.getHeapPointer();
    let headerPointer = memoryImage.getHeapStart();
    while (headerPointer < heapPointer) {
      const headerWord = memoryImage.view.getUint32(
        memoryImage.abs(headerPointer), true);
      const objectType = (headerWord >>> 24) & 0x7f;
      const size = readGCHeaderSize(memoryImage.view,
        memoryImage.abs(headerPointer), headerWord);
      if (size === 0) break;

      if (objectType === OBJ.FUNCTION) {
        const startInstruction = memoryImage.view.getUint32(
          memoryImage.abs(headerPointer + FUNCTION.START_INSTRUCTION), true);
        const endInstruction = memoryImage.view.getUint32(
          memoryImage.abs(headerPointer + FUNCTION.END_INSTRUCTION), true);
        const unit = targetContaining(startInstruction);
        if (unit) {
          const closureFinding = {
            headerPointer,
            startInstruction,
            endInstruction,
            membraneSlots: [],
          };
          findingsByUnitId.get(unit.id).closures.push(closureFinding);
          closureFindingByHeaderPointer.set(headerPointer, closureFinding);
        }
      }
      headerPointer += size;
    }
  }

  // Join membrane closure handles onto the heap findings by header
  // pointer. A handle whose closure is not in any changed unit is
  // simply unaffected by the patch.
  for (const entry of membrane.enumerateClosureHandles()) {
    const closureFinding = closureFindingByHeaderPointer.get(entry.closurePointer);
    if (closureFinding) closureFinding.membraneSlots.push(entry.slot);
  }

  // --- Per-context active references ---------------------------------
  function addActiveReference(unitId, reference) {
    findingsByUnitId.get(unitId).activeReferences.push(reference);
  }
  function checkIndex(contextSlot, kind, instructionIndex, extra) {
    const unit = targetContaining(instructionIndex);
    if (unit) {
      addActiveReference(unit.id,
        { contextSlot, kind, instructionIndex, ...extra });
    }
  }

  const contextCount = memoryImage.getContextCount();
  for (let contextSlot = 0; contextSlot < contextCount; contextSlot++) {
    if (memoryImage.getExitCondition(contextSlot) === CONTEXT_STATUS_FREE) {
      continue;
    }

    checkIndex(contextSlot, 'pc',
      memoryImage.getContextInstructionIndex(contextSlot));

    const frames = memoryImage.getCallStack(contextSlot);
    for (let frameIndex = 0; frameIndex < frames.length; frameIndex++) {
      const frame = frames[frameIndex];
      checkIndex(contextSlot, 'returnAddress', frame.instructionIndex,
        { frameIndex });

      if (frame.flags & FRAME_FLAG_NATIVE_CONTINUATION) {
        // CONTINUATION_CALLBACK is an active code reference while native work
        // is suspended. Retargeting it would mix old and new code within one
        // native operation.
        const frameOffset =
          memoryImage.getCallStackBase(contextSlot) + frameIndex * FRAME_SIZE;
        const callbackHeaderPointer = memoryImage.view.getUint32(
          memoryImage.abs(frameOffset + FRAME.CONTINUATION_CALLBACK), true);
        if (callbackHeaderPointer !== 0) {
          const callbackStart = memoryImage.view.getUint32(
            memoryImage.abs(callbackHeaderPointer + FUNCTION.START_INSTRUCTION),
            true);
          checkIndex(contextSlot, 'nativeContinuationCallback', callbackStart,
            { frameIndex, closureHeaderPointer: callbackHeaderPointer });
        }
      }
    }

    const tryDepth = memoryImage.getTryDepth(contextSlot);
    for (let entryIndex = 0; entryIndex < tryDepth; entryIndex++) {
      const entry = memoryImage.getTryEntry(contextSlot, entryIndex);
      if (entry.catchIndex !== 0) {
        checkIndex(contextSlot, 'catch', entry.catchIndex, { entryIndex });
      }
      if (entry.finallyIndex !== 0) {
        checkIndex(contextSlot, 'finally', entry.finallyIndex, { entryIndex });
      }
    }

    const grantDepth = memoryImage.getGrantDepth(contextSlot);
    for (let entryIndex = 0; entryIndex < grantDepth; entryIndex++) {
      const entry = memoryImage.getGrantEntry(contextSlot, entryIndex);
      if (entry.deniedAddr !== 0) {
        checkIndex(contextSlot, 'denied', entry.deniedAddr, { entryIndex });
      }
    }
  }

  // --- Tiers -----------------------------------------------------------
  const unitFindings = [];
  for (const unit of targets) {
    const finding = findingsByUnitId.get(unit.id);
    finding.tier = finding.activeReferences.length > 0 ? 'active'
      : finding.closures.length > 0 ? 'rewire'
      : 'trivial';
    unitFindings.push(finding);
  }

  return {
    unitFindings,
    identicalUnitCount:
      diffResult.units.filter((unit) => unit.verdict === 'identical').length,
  };
}

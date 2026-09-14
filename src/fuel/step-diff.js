/**
 * Step-diff — pure snapshot and diff helpers for one-instruction observation.
 *
 * Lifted out of the old inspector module. Takes a memoryImage and a context
 * slot; returns plain structured data. No state, no run loop, no session
 * coupling beyond the memory accessors.
 *
 * Standalone diagnostic tool — no longer used by the Runtime (superseded by
 * the WAT-native step ring, see step-ring.js). Callers snapshot/diff directly.
 */

import { opcodeToString } from './constants.js';

export function snapshot(memoryImage, slot) {
  return {
    pending: snapshotPending(memoryImage, slot),
    callStack: memoryImage.getCallStack(slot),
    scope: snapshotScope(memoryImage, slot),
    tryStack: snapshotTryStack(memoryImage, slot),
    grantStack: snapshotGrantStack(memoryImage, slot),
    stateHeader: snapshotStateHeader(memoryImage, slot),
    errorInfo: memoryImage.getErrorInfo(),
  };
}

export function diff(before, after) {
  return {
    pending: diffPending(before.pending, after.pending),
    callStack: diffCallStack(before.callStack, after.callStack),
    scope: diffScope(before.scope, after.scope),
    tryStack: diffTryStack(before.tryStack, after.tryStack),
    grantStack: diffGrantStack(before.grantStack, after.grantStack),
    stateHeader: diffStateHeader(before.stateHeader, after.stateHeader),
    errorInfo: diffErrorInfo(before.errorInfo, after.errorInfo),
  };
}

function snapshotPending(memoryImage, slot) {
  const result = [];
  const pendingBase = memoryImage.getPendingStackBase(slot);
  const pendingPointer = memoryImage.getContextPendingPointer(slot);
  const depth = (pendingPointer - pendingBase) / 16;
  for (let i = 0; i < depth; i++) {
    const ptr = pendingBase + i * 16;
    const type = memoryImage.getValueType(ptr);
    const value = memoryImage.readValueAt(ptr);
    result.push({ type, value, pointer: ptr });
  }
  return result;
}

function snapshotScope(memoryImage, slot) {
  return {
    pointer: memoryImage.getContextScope(slot),
    depth: getScopeDepth(memoryImage, slot),
  };
}

function getScopeDepth(memoryImage, slot) {
  let depth = 0;
  let ptr = memoryImage.getContextScope(slot);
  while (ptr !== 0) {
    depth++;
    ptr = memoryImage.view.getUint32(memoryImage.abs(ptr), true);
  }
  return depth;
}

function snapshotTryStack(memoryImage, slot) {
  const depth = memoryImage.getTryDepth(slot);
  const entries = [];
  for (let i = 0; i < depth; i++) {
    entries.push(memoryImage.getTryEntry(slot, i));
  }
  return entries;
}

function snapshotGrantStack(memoryImage, slot) {
  const depth = memoryImage.getGrantDepth(slot);
  const entries = [];
  for (let i = 0; i < depth; i++) {
    entries.push(memoryImage.getGrantEntry(slot, i));
  }
  return entries;
}

function snapshotStateHeader(memoryImage, slot) {
  return {
    instructionIndex: memoryImage.getContextInstructionIndex(slot),
    exitCondition: memoryImage.getExitCondition(slot),
    heapPointer: memoryImage.getHeapPointer(),
    stringPointer: memoryImage.getStringPointer(),
    scope: memoryImage.getContextScope(slot),
    pendingPointer: memoryImage.getContextPendingPointer(slot),
    callStackPointer: memoryImage.getContextCallStackPointer(slot),
    tryStackPointer: memoryImage.getContextTryStackPointer(slot),
    grantStackPointer: memoryImage.getContextGrantStackPointer(slot),
  };
}

function diffPending(before, after) {
  const pushed = [];
  const popped = [];
  for (let i = after.length; i < before.length; i++) popped.push(before[i]);
  for (let i = before.length; i < after.length; i++) pushed.push(after[i]);
  return { pushed, popped };
}

function diffCallStack(before, after) {
  return { pushed: after.slice(before.length), popped: before.slice(after.length) };
}

function diffScope(before, after) {
  const result = { pushed: [], popped: [], depthChange: after.depth - before.depth };
  if (after.depth > before.depth) {
    result.pushed.push({ depth: after.depth, pointer: after.pointer });
  } else if (after.depth < before.depth) {
    result.popped.push({ depth: before.depth, pointer: before.pointer });
  }
  return result;
}

function diffTryStack(before, after) {
  return { pushed: after.slice(before.length), popped: before.slice(after.length) };
}

function diffGrantStack(before, after) {
  return { pushed: after.slice(before.length), popped: before.slice(after.length) };
}

function diffStateHeader(before, after) {
  const result = {};
  for (const key of Object.keys(after)) {
    if (before[key] !== after[key]) {
      result[key] = { from: before[key], to: after[key] };
    }
  }
  return result;
}

function diffErrorInfo(before, after) {
  if (before.code !== after.code || before.detail !== after.detail) {
    return { from: before, to: after };
  }
  return null;
}

export function readInstruction(memoryImage, instructionIndex) {
  const instr = memoryImage.codeBlockReadInstruction(instructionIndex);
  return {
    index: instructionIndex,
    opcode: instr.opcode,
    opcodeName: opcodeToString(instr.opcode),
    operand1: instr.operand1,
    operand2: instr.operand2,
  };
}

/**
 * Current depths of all per-slot stacks. Cheap O(1) reads from the
 * memory image; useful for graphing without reconstructing depths
 * from the diff.
 */
export function depths(memoryImage, slot) {
  return {
    pendingDepth:    memoryImage.getPendingDepth(slot),
    callDepth:       memoryImage.getCallStackDepth(slot),
    scopeDepth:      scopeChainDepth(memoryImage, slot),
    tryDepth:        memoryImage.getTryDepth(slot),
    grantDepth:      memoryImage.getGrantDepth(slot),
  };
}

/**
 * Heap-region pointer state plus deltas vs. the prior snapshot.
 * `before` is optional; without it, deltas are null.
 */
export function heap(memoryImage, before) {
  const heapPointer   = memoryImage.getHeapPointer();
  const stringPointer = memoryImage.getStringPointer();
  return {
    heapPointer,
    stringPointer,
    heapDelta:   before ? heapPointer   - before.heapPointer   : null,
    stringDelta: before ? stringPointer - before.stringPointer : null,
  };
}

function scopeChainDepth(memoryImage, slot) {
  let depth = 0;
  let ptr = memoryImage.getContextScope(slot);
  while (ptr !== 0) {
    depth++;
    ptr = memoryImage.view.getUint32(memoryImage.abs(ptr), true);
  }
  return depth;
}

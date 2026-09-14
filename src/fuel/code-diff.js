/**
 * Code differ: kind-aware instruction decoding, code-unit extraction,
 * normalized matching, and change verdicts.
 *
 * A "code unit" is a top-level segment or a function body. Function
 * bodies are delimited by the MAKE_CLOSURE family's operands and are
 * emitted inline by the parser:
 *
 *   [closureIndex    ] MAKE_*CLOSURE  operand1=bodyStart operand2=bodyEnd
 *   [closureIndex + 1] JUMP           operand1=bodyEnd
 *   [bodyStart ..    ] RECONCILE_PARAMS, ...body..., RETURN/RETURN_UNDEFINED
 *   [bodyEnd         ] ...enclosing code continues...
 *
 * with bodyStart = closureIndex + 2 and bodyEnd exclusive. Bodies
 * nest. The instructions of a unit are therefore non-contiguous: an
 * enclosing unit has holes where its children's bodies sit. The
 * extractor records each unit's owned instruction indices explicitly
 * so later comparison can normalize index-typed operands by ordinal
 * position within the unit (NOT by distance from unit start — a
 * jump over a child body lands relative to the child's length).
 *
 * The extractor validates the emission invariants as it walks and
 * throws CodeShapeError on violation: the differ must never guess
 * about code whose shape it doesn't understand.
 *
 * Production module — the patcher depends on it, so it must not
 * import from debug.js.
 */

import { OP, OPCODE_OPERANDS, OPERAND_KIND } from './constants.js';
import { createAstReader } from './ast.js';

export const CLOSURE_OPCODES = new Set([
  OP.MAKE_CLOSURE,
  OP.MAKE_ARROW_CLOSURE,
  OP.MAKE_ASYNC_CLOSURE,
  OP.MAKE_ASYNC_ARROW_CLOSURE,
  OP.MAKE_GENERATOR_CLOSURE,
  OP.MAKE_ASYNC_GENERATOR_CLOSURE,
]);

export class CodeShapeError extends Error {
  constructor(message, instructionIndex) {
    super(`${message} (at instruction ${instructionIndex})`);
    this.name = 'CodeShapeError';
    this.instructionIndex = instructionIndex;
  }
}

/**
 * Decode one instruction with its operand kinds attached.
 *
 * Throws CodeShapeError for an opcode missing from OPCODE_OPERANDS —
 * that means the table fell behind the opcode set, which tests assert
 * against, or the code block is corrupt.
 *
 * @param {object} memoryImage - MemoryImage / MemoryReader
 * @param {number} index - Instruction index
 */
export function decodeInstruction(memoryImage, index) {
  const instruction = memoryImage.codeBlockReadInstruction(index);
  const kinds = OPCODE_OPERANDS[instruction.opcode];
  if (!kinds) {
    throw new CodeShapeError(
      `opcode 0x${instruction.opcode.toString(16)} has no OPCODE_OPERANDS entry`,
      index);
  }
  return {
    index,
    opcode: instruction.opcode,
    operand1: instruction.operand1,
    operand2: instruction.operand2,
    astNode: instruction.astNode,
    operand1Kind: kinds[0],
    operand2Kind: kinds[1],
  };
}

/**
 * Extract the code-unit tree for the instruction range [start, end).
 *
 * Returns the root unit:
 *
 *   {
 *     kind: 'toplevel' | 'function',
 *     closureOpcode,             // null for toplevel
 *     closureInstructionIndex,   // index of MAKE_*CLOSURE, null for toplevel
 *     name,                      // recovered binding name or null (anonymous)
 *     range: [start, end],       // absolute span INCLUDING child-body holes
 *     ownedInstructionIndices,   // this unit's instructions, holes excluded
 *     children,                  // nested units in source order
 *   }
 *
 * Validates while walking:
 *   - body starts exactly 2 past its MAKE_*CLOSURE (the skip JUMP sits between),
 *   - the skip JUMP targets exactly bodyEnd,
 *   - bodies nest entirely within their parent range,
 *   - every index-typed operand of an owned instruction targets within
 *     the unit's span (0-sentinels of TRY_PUSH / GRANT_START allowed).
 *
 * Name recovery for matching, in priority order:
 *   1. The MAKE_*CLOSURE's AST attribution (FUNCTION_DECL.name) — the
 *      function's OWN name. Covers `function f(){}` declarations AND
 *      named function expressions in any position (array elements,
 *      arguments), which the instruction heuristic below cannot see.
 *      Only available when the session has an AST region.
 *   2. A LET_VAR / SET_VAR / SET_PROP immediately after the body —
 *      the binding the closure is assigned to (`let f = ...`,
 *      `obj.f = ...`). The AST-free fallback.
 * Anything else stays anonymous.
 */
export function extractUnits(memoryImage, start, end) {
  const hasAst = memoryImage.isAstRegionInitialized();
  const astReader = hasAst ? createAstReader(memoryImage) : null;

  function nameFromAst(closureInstruction) {
    if (!astReader || !closureInstruction || !closureInstruction.astNode) return null;
    const node = astReader.readNode(closureInstruction.astNode);
    return node && node.type === 'FUNCTION_DECL' && node.name ? node.name : null;
  }

  function walk(rangeStart, rangeEnd, kind, closureInstruction) {
    const unit = {
      kind,
      closureOpcode: closureInstruction ? closureInstruction.opcode : null,
      closureInstructionIndex: closureInstruction ? closureInstruction.index : null,
      name: null,
      range: [rangeStart, rangeEnd],
      ownedInstructionIndices: [],
      children: [],
    };

    let i = rangeStart;
    while (i < rangeEnd) {
      const instruction = decodeInstruction(memoryImage, i);
      unit.ownedInstructionIndices.push(i);

      if (CLOSURE_OPCODES.has(instruction.opcode)) {
        const bodyStart = instruction.operand1;
        const bodyEnd = instruction.operand2;

        if (bodyStart !== i + 2) {
          throw new CodeShapeError(
            `closure body starts at ${bodyStart}, expected ${i + 2}`, i);
        }
        if (bodyEnd > rangeEnd || bodyEnd <= bodyStart) {
          throw new CodeShapeError(
            `closure body [${bodyStart}, ${bodyEnd}) escapes unit range ` +
            `[${rangeStart}, ${rangeEnd})`, i);
        }
        const skipJump = decodeInstruction(memoryImage, i + 1);
        if (skipJump.opcode !== OP.JUMP || skipJump.operand1 !== bodyEnd) {
          throw new CodeShapeError(
            `expected JUMP ${bodyEnd} after MAKE_*CLOSURE, found ` +
            `opcode 0x${skipJump.opcode.toString(16)} operand1 ${skipJump.operand1}`,
            i + 1);
        }
        unit.ownedInstructionIndices.push(i + 1);

        const child = walk(bodyStart, bodyEnd, 'function', instruction);
        child.name = nameFromAst(instruction);
        if (child.name === null && bodyEnd < rangeEnd) {
          const after = decodeInstruction(memoryImage, bodyEnd);
          if (after.opcode === OP.LET_VAR || after.opcode === OP.SET_VAR ||
              after.opcode === OP.SET_PROP) {
            child.name = memoryImage.readString(after.operand1);
          }
        }
        unit.children.push(child);

        i = bodyEnd;
        continue;
      }

      // Jump-containment invariant for the unit's own index operands.
      // MAKE_*CLOSURE operands are handled structurally above; here every
      // remaining index operand must stay within the unit's span. The
      // 0-sentinel ("no catch" / "no finally" / "no denied block") can
      // never be a real in-unit target because instruction 0 precedes
      // any unit that contains a TRY_PUSH or GRANT_START.
      for (const [kindField, operandField] of [
        ['operand1Kind', 'operand1'],
        ['operand2Kind', 'operand2'],
      ]) {
        if (instruction[kindField] !== OPERAND_KIND.INSTRUCTION_INDEX) continue;
        const target = instruction[operandField];
        if (target === 0 &&
            (instruction.opcode === OP.TRY_PUSH || instruction.opcode === OP.GRANT_START)) {
          continue;
        }
        if (target < rangeStart || target > rangeEnd) {
          throw new CodeShapeError(
            `${operandField} targets ${target}, outside unit range ` +
            `[${rangeStart}, ${rangeEnd}]`, i);
        }
      }

      i++;
    }

    return unit;
  }

  return walk(start, end, 'toplevel', null);
}

// ===========================================================================
// Matching, normalized comparison, and verdicts
// ===========================================================================

/**
 * Ordinal position of an instruction-index target within a unit.
 *
 * A unit's span has holes where child bodies sit, so index operands
 * are compared by ordinal among the unit's OWN instructions: a jump
 * over a child body targets the next owned instruction regardless of
 * the child's length. `rangeEnd` (one past the unit) is a valid
 * "jump to end" target and maps to ownedInstructionIndices.length.
 *
 * A target inside a hole has no ordinal; the parser never emits a
 * jump into a sibling's body, so that's a shape violation.
 */
function ordinalOfTarget(unit, target, atInstructionIndex) {
  if (target === unit.range[1]) return unit.ownedInstructionIndices.length;
  const owned = unit.ownedInstructionIndices;
  let low = 0, high = owned.length - 1;
  while (low <= high) {
    const mid = (low + high) >> 1;
    if (owned[mid] === target) return mid;
    if (owned[mid] < target) low = mid + 1;
    else high = mid - 1;
  }
  throw new CodeShapeError(
    `index operand targets ${target}, inside a child-body hole of unit ` +
    `[${unit.range[0]}, ${unit.range[1]})`, atInstructionIndex);
}

/**
 * Compare old vs new code within ONE code block split at `boundary`:
 * old code is [0, boundary), new code is [boundary, count). Both
 * sides share the string table (string operands compare raw) and the
 * heap (bigint operands compare by dereferenced value).
 *
 * Returns { boundary, units } where `units` is a flat list:
 *
 *   { id, parentId, kind, name,
 *     oldRange,    // [start, end] or null (added)
 *     newRange,    // [start, end] or null (removed)
 *     verdict,     // 'identical' | 'changed' | 'added' | 'removed'
 *     causes,      // for changed: first divergences, nested-unit ids
 *     matchBasis } // how this unit was paired with its partner:
 *                  // 'name' | 'content' | 'ordinal', or null for
 *                  // added/removed units. Closure retargeting reads
 *                  // it to refuse ambiguous anonymous matches.
 *
 * Matching: named children match by name (pairwise in order on
 * collision); anonymous children match within their matched parent
 * by normalized-content equality first, then by ordinal among the
 * unmatched remainder. A rename is deliberately removed + added —
 * matching by content across different names would be a guess, and
 * patch application acts on bindings.
 */
export function diffAppendedCode(
  memoryImage,
  boundary,
  newStart = boundary,
  oldStart = 0,
  oldEnd = boundary,
  newEnd = memoryImage.codeBlockInstructionCount(),
) {
  const oldRoot = extractUnits(memoryImage, oldStart, oldEnd);
  const newRoot = extractUnits(memoryImage, newStart, newEnd);

  // Memoized pairwise comparison — anonymous matching tries candidate
  // pairs, and the winning pair's result is reused for the verdict.
  const comparisonMemo = new Map();
  function compareUnits(oldUnit, newUnit) {
    let perOld = comparisonMemo.get(oldUnit);
    if (perOld && perOld.has(newUnit)) return perOld.get(newUnit);
    const result = computeComparison(oldUnit, newUnit);
    if (!perOld) { perOld = new Map(); comparisonMemo.set(oldUnit, perOld); }
    perOld.set(newUnit, result);
    return result;
  }

  function matchChildren(oldUnit, newUnit) {
    const matched = new Map();   // oldChild → newChild
    const matchBasis = new Map(); // oldChild → 'name' | 'content' | 'ordinal'
    const matchedNew = new Set();

    // Named: pair by name, in order on collision. A named match is a
    // fact, not a guess — closure retargeting can accept it.
    const newByName = new Map();
    for (const child of newUnit.children) {
      if (child.name === null) continue;
      if (!newByName.has(child.name)) newByName.set(child.name, []);
      newByName.get(child.name).push(child);
    }
    for (const child of oldUnit.children) {
      if (child.name === null) continue;
      const candidates = newByName.get(child.name);
      if (candidates && candidates.length > 0) {
        const partner = candidates.shift();
        matched.set(child, partner);
        matchBasis.set(child, 'name');
        matchedNew.add(partner);
      }
    }

    // Anonymous: content-equality first.
    const oldAnonymous = oldUnit.children.filter((c) => c.name === null);
    const newAnonymous = newUnit.children.filter(
      (c) => c.name === null && !matchedNew.has(c));
    const stillUnmatchedOld = [];
    for (const child of oldAnonymous) {
      let partner = null;
      for (const candidate of newAnonymous) {
        if (matchedNew.has(candidate)) continue;
        if (compareUnits(child, candidate).verdict === 'identical') {
          partner = candidate;
          break;
        }
      }
      if (partner) {
        matched.set(child, partner);
        matchBasis.set(child, 'content');
        matchedNew.add(partner);
      } else {
        stillUnmatchedOld.push(child);
      }
    }
    // Ordinal pairing among the remainder is a last-resort guess. Closure
    // retargeting refuses ordinal-matched anonymous closures when more than
    // one is in play because a wrong pairing would swap callback behavior.
    const remainderNew = newAnonymous.filter((c) => !matchedNew.has(c));
    for (let i = 0; i < stillUnmatchedOld.length && i < remainderNew.length; i++) {
      matched.set(stillUnmatchedOld[i], remainderNew[i]);
      matchBasis.set(stillUnmatchedOld[i], 'ordinal');
      matchedNew.add(remainderNew[i]);
    }

    const removed = oldUnit.children.filter((c) => !matched.has(c));
    const added = newUnit.children.filter((c) => !matchedNew.has(c));
    return { matched, matchBasis, removed, added };
  }

  function computeComparison(oldUnit, newUnit) {
    const causes = [];
    const childMatch = matchChildren(oldUnit, newUnit);

    if (childMatch.removed.length > 0 || childMatch.added.length > 0) {
      causes.push({
        kind: 'children',
        removed: childMatch.removed.length,
        added: childMatch.added.length,
      });
    }

    const oldOwned = oldUnit.ownedInstructionIndices;
    const newOwned = newUnit.ownedInstructionIndices;
    if (oldOwned.length !== newOwned.length) {
      causes.push({
        kind: 'length',
        oldCount: oldOwned.length,
        newCount: newOwned.length,
      });
    }

    // Positional child correspondence for closure operands: the k-th
    // closure op in the owned sequence delimits the k-th child. The
    // name-based matching above drives added/removed/changed
    // reporting; HERE position is what makes the parent identical —
    // reordered children change the parent even if each body matched.
    let oldClosureOrdinal = 0;
    let newClosureOrdinal = 0;
    const lockstep = Math.min(oldOwned.length, newOwned.length);
    for (let k = 0; k < lockstep; k++) {
      const oldInstruction = decodeInstruction(memoryImage, oldOwned[k]);
      const newInstruction = decodeInstruction(memoryImage, newOwned[k]);

      if (oldInstruction.opcode !== newInstruction.opcode) {
        // Streams diverged — positional comparison past this point is
        // noise. Record the first divergence and stop.
        causes.push({
          kind: 'opcode',
          position: k,
          oldIndex: oldOwned[k],
          newIndex: newOwned[k],
        });
        break;
      }

      if (CLOSURE_OPCODES.has(oldInstruction.opcode)) {
        const oldChild = oldUnit.children[oldClosureOrdinal++];
        const newChild = newUnit.children[newClosureOrdinal++];
        if (childMatch.matched.get(oldChild) !== newChild) {
          causes.push({ kind: 'closure', position: k });
        } else if (compareUnits(oldChild, newChild).verdict !== 'identical') {
          causes.push({ kind: 'nestedUnit', position: k });
        }
        continue;
      }

      for (const [kindField, operandField] of [
        ['operand1Kind', 'operand1'],
        ['operand2Kind', 'operand2'],
      ]) {
        const kind = oldInstruction[kindField];
        if (kind === OPERAND_KIND.NONE) continue;
        const oldValue = oldInstruction[operandField];
        const newValue = newInstruction[operandField];

        let equal;
        if (kind === OPERAND_KIND.INSTRUCTION_INDEX) {
          const sentinelCapable =
            oldInstruction.opcode === OP.TRY_PUSH ||
            oldInstruction.opcode === OP.GRANT_START;
          if (sentinelCapable && (oldValue === 0 || newValue === 0)) {
            equal = oldValue === 0 && newValue === 0;
          } else {
            equal = ordinalOfTarget(oldUnit, oldValue, oldOwned[k]) ===
                    ordinalOfTarget(newUnit, newValue, newOwned[k]);
          }
        } else if (kind === OPERAND_KIND.HEAP_POINTER) {
          // Bigint literals don't intern — re-parsing allocates a
          // fresh heap object — so compare the dereferenced values.
          equal = memoryImage.unmarshalBigInt(oldValue) ===
                  memoryImage.unmarshalBigInt(newValue);
        } else {
          // INLINE, STRING_OFFSET (shared interning history), and the
          // 64-bit pair halves all compare raw.
          equal = oldValue === newValue;
        }

        if (!equal) {
          causes.push({
            kind: 'operand',
            position: k,
            operand: operandField,
            oldIndex: oldOwned[k],
            newIndex: newOwned[k],
          });
        }
      }
    }

    return {
      verdict: causes.length === 0 ? 'identical' : 'changed',
      causes,
      childMatch,
    };
  }

  // Assemble the flat unit list from the matched tree, depth-first.
  const units = [];
  let nextId = 0;

  function emitSubtree(unit, verdict, parentId) {
    const id = nextId++;
    units.push({
      id,
      parentId,
      kind: unit.kind,
      name: unit.name,
      oldRange: verdict === 'added' ? null : unit.range,
      newRange: verdict === 'removed' ? null : unit.range,
      verdict,
      causes: [],
      // added/removed units were not paired — no basis applies.
      matchBasis: null,
    });
    for (const child of unit.children) emitSubtree(child, verdict, id);
  }

  // `matchBasis` is how THIS unit was paired with its partner: 'name'
  // / 'content' / 'ordinal' for a child (set by the parent's matcher),
  // or 'name' for the root (matched by identity). Closure retargeting
  // reads it to apply the unambiguous-match rule.
  function emitPair(oldUnit, newUnit, parentId, basis) {
    const comparison = compareUnits(oldUnit, newUnit);
    const id = nextId++;
    units.push({
      id,
      parentId,
      kind: oldUnit.kind,
      name: oldUnit.name,
      oldRange: oldUnit.range,
      newRange: newUnit.range,
      verdict: comparison.verdict,
      causes: comparison.causes,
      matchBasis: basis,
    });
    for (const oldChild of oldUnit.children) {
      const partner = comparison.childMatch.matched.get(oldChild);
      if (partner) {
        emitPair(oldChild, partner, id, comparison.childMatch.matchBasis.get(oldChild));
      }
    }
    for (const removedChild of comparison.childMatch.removed) {
      emitSubtree(removedChild, 'removed', id);
    }
    for (const addedChild of comparison.childMatch.added) {
      emitSubtree(addedChild, 'added', id);
    }
    return id;
  }

  emitPair(oldRoot, newRoot, null, 'name');
  return { boundary, units };
}

/**
 * Diff a session's existing code against a new version of the source.
 *
 * The session is expected to be a SCRATCH copy of the live vat
 * (snapshot + restore) — this function appends the new source's
 * instructions, strings, parse-time heap allocations, and AST nodes
 * to it. It never touches the vat it was copied from.
 *
 * On parse failure the appended partial instructions are truncated
 * back to the boundary and { parseFailed: true, error } is returned
 * (interned strings and partial AST writes are not rolled back — the
 * scratch copy is disposable).
 *
 * Adds a heap-implications summary to the diffAppendedCode result:
 *   parseAllocations — heap objects the new code's literals allocated
 *   stringTableDelta — bytes of newly interned strings
 *   astRegionDelta   — bytes of new AST nodes
 *   codeGrowth       — instructions appended
 */
export function diffNewSource(session, newSource) {
  const memoryImage = session.mem;
  const boundary = memoryImage.codeBlockInstructionCount();
  const stringPointerBefore = memoryImage.getStringPointer();
  const astPointerBefore = memoryImage.getAstRegionPointer();

  // Every completed patch parse is bracketed by two impossible-target
  // jumps. The source between the latest completed pair is the currently
  // active version; synthesized migration programs appended after the
  // closing barrier are history, not part of that version. The first patch
  // has no completed pair and therefore compares against the original
  // [0, boundary) program.
  const HALT_TARGET = 0x7FFFFFFF;
  const priorBarriers = [];
  for (let instructionIndex = 0; instructionIndex < boundary; instructionIndex++) {
    const instruction = decodeInstruction(memoryImage, instructionIndex);
    if (instruction.opcode === OP.JUMP && instruction.operand1 === HALT_TARGET) {
      priorBarriers.push(instructionIndex);
    }
  }
  const oldStart = priorBarriers.length >= 2
    ? priorBarriers[priorBarriers.length - 2] + 1
    : 0;
  const oldEnd = priorBarriers.length >= 2
    ? priorBarriers[priorBarriers.length - 1]
    : boundary;

  // Halt barrier between the old program and the appended new code.
  // A context draining old code to natural completion runs PAST the
  // old end — the dispatcher only stops at pc >= total count, and the
  // appended code now sits exactly there. Without the barrier a
  // drained slot falls through into the new version's toplevel and
  // re-executes it, causing top-level declarations to be redeclared.
  // The barrier jumps past all valid code; the pc >= count check turns
  // it into a clean DONE.
  memoryImage.codeBlockAppend(OP.JUMP, HALT_TARGET);
  const newStart = boundary + 1;

  try {
    session.parse(newSource);
  } catch (error) {
    memoryImage.codeBlockTruncate(boundary);
    return { parseFailed: true, error, boundary };
  }

  // Close the active-source range before patch application appends its
  // synthesized migration program. A later patch can therefore recover
  // the exact prior source range without persisted host-side metadata.
  const newEnd = memoryImage.codeBlockInstructionCount();
  memoryImage.codeBlockAppend(OP.JUMP, HALT_TARGET);

  const result = diffAppendedCode(
    memoryImage,
    boundary,
    newStart,
    oldStart,
    oldEnd,
    newEnd,
  );

  const count = memoryImage.codeBlockInstructionCount();
  const parseAllocations = [];
  for (let i = newStart; i < count; i++) {
    const instruction = decodeInstruction(memoryImage, i);
    if (instruction.operand1Kind === OPERAND_KIND.HEAP_POINTER &&
        instruction.operand1 !== 0) {
      parseAllocations.push({
        instructionIndex: i,
        opcode: instruction.opcode,
        headerPointer: instruction.operand1,
        value: memoryImage.unmarshalBigInt(instruction.operand1),
      });
    }
  }

  return {
    ...result,
    heapImplications: {
      parseAllocations,
      stringTableDelta: memoryImage.getStringPointer() - stringPointerBefore,
      astRegionDelta: memoryImage.getAstRegionPointer() - astPointerBefore,
      codeGrowth: count - boundary,
    },
  };
}

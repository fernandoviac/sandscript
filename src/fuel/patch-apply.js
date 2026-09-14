/**
 * Patch application for live code patching.
 *
 * Patch = partial re-run of the new source's top level, plus deletion
 * of removed bindings. One executor: the selected statements are
 * printed from the new AST into a synthesized program, parsed
 * (appending after the diff parse's code), and run through the
 * completely ordinary pipeline in a fresh context at the root scope.
 * Re-running `function f() { ...new body... }` IS the rebind — MAKE_CLOSURE
 * + LET_VAR over the fresh body.
 *
 * The selection function (diff verdict × the language's mutability
 * classes):
 *
 *   function declaration, changed or added        → re-run (rebind/define)
 *   let/const binding, all names new               → re-run (initialize)
 *   const declaration, initializer changed        → re-run (source-derived)
 *   const declaration, partial-name addition      → re-run (const semantics
 *                                                    sanction re-evaluation)
 *   let binding that exists, initializer changed  → preserve + report
 *   let destructuring with SOME new names         → preserve + report
 *                                                    (re-running would clobber
 *                                                    sibling state)
 *   anything else top-level                       → never re-run
 *                                                    (changed/added → report)
 *
 * `let f = () => ...` is deliberately a DATA binding here, not a
 * function: it may have been reassigned at runtime. Authors who mean
 * "code, source-derived" write `function f()` or `const f = ...`.
 *
 * Contract / preconditions:
 * - scratchSession is the disposable copy (snapshot → restore → gc →
 *   diffNewSource → auditLiveReferences). On any failure the host
 *   discards it; the original session is the rollback.
 * - The host has already re-registered its JS-side airlock handlers
 *   on the scratch (the embedder-owned restore step) — selected
 *   initializers may perform external calls.
 * - Requires the AST region (`inlineSource`): selection and synthesis
 *   read both ASTs. Throws PatchError otherwise.
 * - If the migration run does not complete synchronously (suspends on
 *   a promise-returning handler, exhausts fuel, signals memory
 *   pressure), the report's `migration.status` says so and
 *   `migration.slot` stays allocated — the host drives it to
 *   completion with its normal scheduling before adopting the
 *   scratch.
 */

import {
  OP, SCOPE_FLAG_CONST, FUNCTION,
  CLOSURE_FLAG_ARROW, CLOSURE_FLAG_ASYNC, OBJ, GC_HEADER_SIZE,
  readGCHeaderSize,
} from './constants.js';
import { extractUnits } from './code-diff.js';
import { createAstReader } from './ast.js';
import { printNode } from './ast-printer.js';

// A VARIABLE_DECL bindings entry is either a VARIABLE_BINDING (named) or
// a destructuring pattern node (AST format v2+).
function isPatternNode(node) {
  return node.type === 'ARRAY_PATTERN' || node.type === 'OBJECT_PATTERN';
}

// All names a bindings entry introduces: the binding's own name, or every
// identifier bound anywhere inside a pattern (through nesting and rest).
function bindingBoundNames(binding) {
  if (!isPatternNode(binding)) {
    return binding.name === null ? [] : [binding.name];
  }
  const names = [];
  const entries = binding.type === 'ARRAY_PATTERN' ? binding.elements : binding.properties;
  for (const element of entries) {
    if (element.isHole) continue;
    if (element.nestedPattern) {
      names.push(...bindingBoundNames(element.nestedPattern));
    } else if (element.name !== null) {
      names.push(element.name);
    }
  }
  return names;
}

function effectStatementKey(statement) {
  if (statement.type === 'EXPRESSION_STMT'
      && statement.expression?.type === 'CALL') {
    return `call:${printNode(statement.expression.callee)}`;
  }
  return statement.type;
}

// Closure opcode → FUNCTION_FLAGS. The new unit's closure opcode is
// the new source's truth about arrow-ness / async-ness; a sync→async
// change must update the flags or the promise machinery misdrives.
const CLOSURE_OPCODE_FLAGS = {
  [OP.MAKE_CLOSURE]: 0,
  [OP.MAKE_ARROW_CLOSURE]: CLOSURE_FLAG_ARROW,
  [OP.MAKE_ASYNC_CLOSURE]: CLOSURE_FLAG_ASYNC,
  [OP.MAKE_ASYNC_ARROW_CLOSURE]: CLOSURE_FLAG_ARROW | CLOSURE_FLAG_ASYNC,
};

export class PatchError extends Error {
  constructor(message) {
    super(message);
    this.name = 'PatchError';
  }
}

/**
 * @param {object} scratchSession - session over the scratch vat
 * @param {object} diffResult - diffNewSource output (same scratch)
 * @param {object} auditResult - auditLiveReferences output (same scratch)
 * @param {object} [options]
 * @param {number} [options.fuel=1000000] - budget for the migration run
 * @returns {{
 *   reran: Array<{names: string[], kind: string}>,
 *   deleted: string[],
 *   reported: Array<{names: string[], reason: string, source?: string}>,
 *   draining: Array<{unitId: number, name: string|null, tier: string}>,
 *   migration: {slot: number|null, status: string, fuel: number}|null,
 *   migrationSource: string,
 * }}
 */
export function applyPatch(scratchSession, diffResult, auditResult, options = {}) {
  const { fuel = 1_000_000 } = options;
  const memoryImage = scratchSession.mem;

  if (!memoryImage.isAstRegionInitialized()) {
    throw new PatchError(
      'applyPatch requires the AST region (create the session with inlineSource) — ' +
      'selection and synthesis read both versions\' ASTs.');
  }
  if (diffResult.parseFailed) {
    throw new PatchError('diff result reports parseFailed — nothing to apply.');
  }

  // The toplevel unit's ranges come from the diff (its newRange starts
  // past the halt barrier diffNewSource emits between old and new code).
  const toplevelRanges = diffResult.units.find((unit) => unit.parentId === null);
  const oldToplevel = extractUnits(memoryImage, ...toplevelRanges.oldRange);
  const newToplevel = extractUnits(memoryImage, ...toplevelRanges.newRange);

  // Depth-0 binding scan: names actually bound by a toplevel's own
  // LET_VARs, with constness from the instruction's scope flags.
  // Parser-internal destructuring temps (@dst_*) are excluded.
  function depthZeroBindings(unit) {
    const bindings = new Map();
    let depth = 0;
    for (const index of unit.ownedInstructionIndices) {
      const instruction = memoryImage.codeBlockReadInstruction(index);
      if (instruction.opcode === OP.SCOPE_PUSH) depth++;
      else if (instruction.opcode === OP.SCOPE_POP) depth--;
      else if (instruction.opcode === OP.LET_VAR && depth === 0) {
        const name = memoryImage.readString(instruction.operand1);
        if (name.startsWith('@')) continue;
        bindings.set(name, {
          nameOffset: instruction.operand1,
          isConst: (instruction.operand2 & SCOPE_FLAG_CONST) !== 0,
        });
      }
    }
    return bindings;
  }
  const oldBindings = depthZeroBindings(oldToplevel);
  const newBindings = depthZeroBindings(newToplevel);

  // AST statements. The new version is the LAST root (the diff
  // parse); everything before it is the old program's parse history.
  const reader = createAstReader(memoryImage);
  const roots = [...reader.iterateRoots()];
  if (roots.length < 2) {
    throw new PatchError(
      `expected at least two AST roots (program history + diff parse), found ${roots.length}.`);
  }
  const newStatements = reader.readTree(roots[roots.length - 1]).body.statements;
  const oldStatements = roots.slice(0, -1)
    .flatMap((offset) => reader.readTree(offset).body.statements);

  // Old-side declaration index plus effect-statement multisets. Effects
  // are paired by operation identity before any surplus new statements
  // are selected. A changed listener callback remains the same register
  // operation and is handled by closure retargeting; an additional
  // registration or other effect has no old counterpart and must run.
  const oldDeclarationByName = new Map();
  const oldEffectTextsByKey = new Map();
  const newEffectTextsByKey = new Map();
  const indexEffectStatements = (statements, destination) => {
    for (const statement of statements) {
      if (statement.type === 'FUNCTION_DECL' || statement.type === 'VARIABLE_DECL') continue;
      const key = effectStatementKey(statement);
      const texts = destination.get(key) ?? [];
      texts.push(printNode(statement));
      destination.set(key, texts);
    }
  };
  for (const statement of oldStatements) {
    if (statement.type === 'FUNCTION_DECL') {
      oldDeclarationByName.set(statement.name, statement);
    } else if (statement.type === 'VARIABLE_DECL') {
      for (const binding of statement.bindings) {
        for (const name of bindingBoundNames(binding)) {
          oldDeclarationByName.set(name, statement);
        }
      }
    }
  }
  indexEffectStatements(oldStatements, oldEffectTextsByKey);
  indexEffectStatements(newStatements, newEffectTextsByKey);

  const oldExactTextRemainingByKey = new Map();
  const unmatchedNewRemainingByKey = new Map();
  const newEffectSelectionBudgetByKey = new Map();
  for (const [key, newTexts] of newEffectTextsByKey) {
    const oldTextCounts = new Map();
    for (const text of oldEffectTextsByKey.get(key) ?? []) {
      oldTextCounts.set(text, (oldTextCounts.get(text) ?? 0) + 1);
    }
    oldExactTextRemainingByKey.set(key, new Map(oldTextCounts));
    let exactMatches = 0;
    for (const text of newTexts) {
      const remaining = oldTextCounts.get(text) ?? 0;
      if (remaining > 0) {
        oldTextCounts.set(text, remaining - 1);
        exactMatches++;
      }
    }
    const unmatchedNew = newTexts.length - exactMatches;
    const unmatchedOld = (oldEffectTextsByKey.get(key)?.length ?? 0) - exactMatches;
    unmatchedNewRemainingByKey.set(key, unmatchedNew);
    newEffectSelectionBudgetByKey.set(key, Math.max(0, unmatchedNew - unmatchedOld));
  }

  // Function verdicts: the diff's top-level function units by name.
  const toplevelUnit = diffResult.units.find((unit) => unit.parentId === null);
  const functionVerdicts = new Map();
  for (const unit of diffResult.units) {
    if (unit.parentId === toplevelUnit.id && unit.name !== null) {
      functionVerdicts.set(unit.name, unit.verdict);
    }
  }

  // --- Selection ------------------------------------------------------
  const selected = [];
  const reported = [];
  for (const statement of newStatements) {
    if (statement.type === 'FUNCTION_DECL') {
      const name = statement.name;
      if (!oldBindings.has(name)) {
        selected.push({ statement, kind: 'addedFunction', names: [name] });
      } else if (functionVerdicts.get(name) !== 'identical') {
        selected.push({ statement, kind: 'changedFunction', names: [name] });
      }
      continue;
    }

    if (statement.type === 'VARIABLE_DECL') {
      // Destructuring patterns are real AST nodes (ARRAY_PATTERN /
      // OBJECT_PATTERN with the initializer as a child) since AST
      // format v2 — the statement reprints and synthesizes like any
      // other declaration, with the pattern's bound names extracted
      // from the pattern tree. A binding that is neither named nor a
      // pattern would be unprintable; the parser does not produce one, but
      // keep the guard defensive.
      if (statement.bindings.some((binding) =>
            binding.name === null && !isPatternNode(binding))) {
        reported.push({ names: [], reason: 'destructuringNotApplied' });
        continue;
      }
      const names = statement.bindings.flatMap((binding) => bindingBoundNames(binding));
      const existing = names.filter((name) => oldBindings.has(name));
      if (existing.length === 0) {
        selected.push({ statement, kind: 'addedBinding', names });
        continue;
      }
      const oldStatement = oldDeclarationByName.get(existing[0]);
      const initializerChanged =
        !oldStatement || printNode(oldStatement) !== printNode(statement);
      if (statement.isConst) {
        if (initializerChanged || existing.length < names.length) {
          selected.push({ statement, kind: 'changedConst', names });
        }
      } else if (existing.length < names.length) {
        reported.push({ names, reason: 'partialBindingAddition' });
      } else if (initializerChanged) {
        reported.push({ names, reason: 'changedLetInitializer' });
      }
      continue;
    }

    const key = effectStatementKey(statement);
    const printed = printNode(statement);
    const exactTextRemaining = oldExactTextRemainingByKey.get(key);
    const exactMatchesRemaining = exactTextRemaining?.get(printed) ?? 0;
    if (exactMatchesRemaining > 0) {
      exactTextRemaining.set(printed, exactMatchesRemaining - 1);
      continue;
    }

    const unmatchedRemaining = unmatchedNewRemainingByKey.get(key) ?? 0;
    const selectionBudget = newEffectSelectionBudgetByKey.get(key) ?? 0;
    unmatchedNewRemainingByKey.set(key, unmatchedRemaining - 1);
    if (unmatchedRemaining <= selectionBudget) {
      selected.push({ statement, kind: 'addedStatement', names: [] });
    }
  }

  // Removed bindings: depth-0-bound by the old top level, not by the
  // new. Functions and data bindings uniformly.
  const removedNames = [...oldBindings.keys()]
    .filter((name) => !newBindings.has(name));

  // Added bindings not covered by any selected statement are reported
  // so the host can migrate them explicitly; they would otherwise be
  // invisible.
  const coveredNames = new Set(selected.flatMap((selection) => selection.names));
  const uncoveredAdded = [...newBindings.keys()].filter(
    (name) => !oldBindings.has(name) && !coveredNames.has(name));
  if (uncoveredAdded.length > 0) {
    reported.push({ names: uncoveredAdded, reason: 'addedBindingNotApplied' });
  }

  // --- Synthesize + parse (before any mutation) -------------------------
  const migrationSource = selected
    .map((selection) => printNode(selection.statement))
    .join('\n');

  let parseInfo = null;
  if (migrationSource.length > 0) {
    const countBeforeParse = memoryImage.codeBlockInstructionCount();
    try {
      parseInfo = scratchSession.parse(migrationSource);
    } catch (error) {
      memoryImage.codeBlockTruncate(countBeforeParse);
      throw new PatchError(
        `synthesized migration program failed to parse (printer/parser mismatch?): ${error.message}`);
    }
  }

  // --- Delete (removals + clear-before-redeclare) -----------------------
  // WAT-side scope_define rejects redeclaration, so every selected
  // statement's existing bindings must be deleted before the run.
  const rootScope = memoryImage.getRootScope();
  const deletions = new Set(removedNames);
  for (const selection of selected) {
    for (const name of selection.names) {
      if (oldBindings.has(name)) deletions.add(name);
    }
  }
  const deleted = [];
  for (const name of deletions) {
    const nameOffset = memoryImage.internString(name);
    if (memoryImage.scopeDeleteBinding(rootScope, nameOffset) &&
        removedNames.includes(name)) {
      deleted.push(name);
    }
  }

  // --- Run the migration program ----------------------------------------
  let migration = null;
  if (parseInfo) {
    const slot = memoryImage.allocateContext();
    const generation = memoryImage.getContextGeneration(slot);
    memoryImage.setContextScope(slot, rootScope);
    memoryImage.setContextInstructionIndex(slot, parseInfo.startIndex);
    memoryImage.clearExitCondition(slot);
    const runResult = scratchSession.run(slot, fuel);
    migration = {
      slot,
      generation,
      status: runResult.status,
      fuel: runResult.fuel,
    };
    if (runResult.status === 'done') {
      memoryImage.freeContext(slot, generation);
      migration.slot = null;
    }
  }

  // Retarget value-held closures only after the migration settles because
  // a suspended run has not finished mutating the scopes inspected by the
  // free-variable check. The host must drive a suspended run to completion
  // and then call retargetClosures directly; the result reports the deferral.
  let retarget = null;
  if (migration && migration.slot !== null) {
    retarget = { retargeted: [], refused: [], deferred: true };
  } else {
    retarget = retargetClosures(scratchSession, diffResult, auditResult);
  }

  return {
    reran: selected.map((selection) => ({
      names: selection.names,
      kind: selection.kind,
    })),
    deleted,
    reported,
    draining: auditResult.unitFindings
      .filter((finding) => finding.tier !== 'trivial')
      .map((finding) => ({
        unitId: finding.unitId,
        name: finding.name,
        tier: finding.tier,
      })),
    migration,
    migrationSource,
    retarget,
  };
}

/**
 * Retarget value-held closures in place: edit the existing closure
 * objects (START_INSTRUCTION / END_INSTRUCTION / FUNCTION_FLAGS) to
 * point at the new bodies, so every holder — membrane handle, array
 * element, promise handler record — observes the new code without
 * rewiring because the heap pointer is unchanged.
 *
 * Own heap walk: the audit's recorded closure pointers may have been
 * invalidated by a gc between audit and here (e.g. the host gc'd to
 * finish a memory-pressure migration run). We re-walk for function
 * objects whose START_INSTRUCTION falls in a changed unit's oldRange.
 *
 * Gated per closure by a free-variable check (the new body's free
 * names must resolve through the closure's captured scope chain) and
 * by the unambiguous-match rule. Named closures and content-matched
 * anonymous closures are unambiguous; ordinal-matched anonymous
 * closures retarget only when they are the sole changed anonymous
 * child of their parent. Mid-iteration callbacks are refused because
 * retargeting would mix old and new code within one map() call.
 *
 * @returns {{ retargeted: Array, refused: Array }}
 */
export function retargetClosures(scratchSession, diffResult, auditResult) {
  const memoryImage = scratchSession.mem;

  // Changed units with a new body, indexed by their old range. (Added
  // units have no old closures; removed units have no new body.)
  const changedUnits = diffResult.units.filter(
    (unit) => unit.verdict === 'changed' && unit.oldRange !== null &&
              unit.newRange !== null && unit.kind === 'function');

  // Sibling-ambiguity: a changed anonymous unit is ambiguous when its
  // parent has more than one changed anonymous child (the configuration
  // where the differ's ordinal fallback could swap two callbacks).
  const changedAnonByParent = new Map();
  for (const unit of changedUnits) {
    if (unit.name !== null) continue;
    if (!changedAnonByParent.has(unit.parentId)) {
      changedAnonByParent.set(unit.parentId, []);
    }
    changedAnonByParent.get(unit.parentId).push(unit);
  }

  // Mid-iteration closures are refused to avoid mixing old and new code.
  const activeIterationPointers = new Set();
  for (const finding of auditResult.unitFindings) {
    for (const reference of finding.activeReferences) {
      if (reference.kind === 'iterationCallback' &&
          reference.closureHeaderPointer) {
        activeIterationPointers.add(reference.closureHeaderPointer);
      }
    }
  }

  // Membrane closure handles by closure pointer, for the report.
  const membraneSlotsByPointer = new Map();
  for (const entry of scratchSession.airlock.membrane.enumerateClosureHandles()) {
    if (!membraneSlotsByPointer.has(entry.closurePointer)) {
      membraneSlotsByPointer.set(entry.closurePointer, []);
    }
    membraneSlotsByPointer.get(entry.closurePointer).push(entry.slot);
  }

  // Per-unit precompute: the eligibility verdict (retarget vs refuse-
  // basis) and the new body's free-variable name set.
  function freeVariableNames(unit) {
    const bound = new Set();
    const used = new Set();
    const [start, end] = unit.newRange;
    for (let index = start; index < end; index++) {
      const instruction = memoryImage.codeBlockReadInstruction(index);
      if (instruction.opcode === OP.LET_VAR) {
        bound.add(instruction.operand1);
      } else if (instruction.opcode === OP.GET_VAR || instruction.opcode === OP.SET_VAR) {
        used.add(instruction.operand1);
      }
    }
    const thisOffset = memoryImage.internString('this');
    const free = [];
    for (const nameOffset of used) {
      if (!bound.has(nameOffset) && nameOffset !== thisOffset) free.push(nameOffset);
    }
    return free;
  }

  function ambiguityRefusal(unit) {
    // Named matches and content matches are facts/anchored; ordinal
    // matches of a sole changed anonymous child are unambiguous (no
    // peer to confuse it with). Only multiple changed anonymous
    // siblings are refused.
    if (unit.name !== null) return null;
    if (unit.matchBasis === 'content') return null;
    const siblings = changedAnonByParent.get(unit.parentId) ?? [];
    return siblings.length > 1 ? 'ambiguousMatch' : null;
  }

  const unitByOldStart = new Map();
  const unitMeta = new Map();
  for (const unit of changedUnits) {
    unitByOldStart.set(unit.oldRange[0], unit);
    unitMeta.set(unit.id, {
      free: freeVariableNames(unit),
      ambiguity: ambiguityRefusal(unit),
      newFlags: null, // filled lazily from the new closure opcode below
    });
  }

  // Resolve a name through a captured scope chain (DATA pointers).
  function resolvesInChain(scopeDataPointer, nameOffset) {
    return memoryImage.scopeLookup(scopeDataPointer, nameOffset) !== null;
  }

  const retargeted = [];
  const refused = [];

  // Heap walk for function objects in a changed unit's old body.
  const heapPointer = memoryImage.getHeapPointer();
  let headerPointer = memoryImage.getHeapStart();
  while (headerPointer < heapPointer) {
    const headerWord = memoryImage.view.getUint32(memoryImage.abs(headerPointer), true);
    const objectType = (headerWord >>> 24) & 0x7f;
    const size = readGCHeaderSize(memoryImage.view,
      memoryImage.abs(headerPointer), headerWord);
    if (size === 0) break;

    if (objectType === OBJ.FUNCTION) {
      const startInstruction = memoryImage.view.getUint32(
        memoryImage.abs(headerPointer + FUNCTION.START_INSTRUCTION), true);
      const unit = unitByOldStart.get(startInstruction);
      if (unit) {
        const meta = unitMeta.get(unit.id);
        const membraneSlots = membraneSlotsByPointer.get(headerPointer) ?? [];

        if (activeIterationPointers.has(headerPointer)) {
          refused.push({ unitId: unit.id, name: unit.name,
            closureHeaderPointer: headerPointer, reason: 'activeIteration' });
        } else if (meta.ambiguity) {
          refused.push({ unitId: unit.id, name: unit.name,
            closureHeaderPointer: headerPointer, reason: meta.ambiguity });
        } else {
          // Free-variable check against THIS closure's captured scope.
          const capturedScope = memoryImage.view.getUint32(
            memoryImage.abs(headerPointer + FUNCTION.SCOPE), true);
          const missing = meta.free.filter(
            (nameOffset) => !resolvesInChain(capturedScope, nameOffset));
          if (missing.length > 0) {
            refused.push({ unitId: unit.id, name: unit.name,
              closureHeaderPointer: headerPointer, reason: 'freeVarMismatch',
              missingNames: missing.map((o) => memoryImage.readString(o)) });
          } else {
            // The edit: new body range + flags from the new closure
            // opcode (read once per unit, cached).
            if (meta.newFlags === null) {
              const newClosureOpcode = memoryImage.codeBlockReadInstruction(
                unit.newRange[0] - 2).opcode; // body starts at MAKE_*CLOSURE + 2
              meta.newFlags = CLOSURE_OPCODE_FLAGS[newClosureOpcode] ?? 0;
            }
            memoryImage.view.setUint32(
              memoryImage.abs(headerPointer + FUNCTION.START_INSTRUCTION),
              unit.newRange[0], true);
            memoryImage.view.setUint32(
              memoryImage.abs(headerPointer + FUNCTION.END_INSTRUCTION),
              unit.newRange[1], true);
            memoryImage.view.setUint32(
              memoryImage.abs(headerPointer + FUNCTION.FUNCTION_FLAGS),
              meta.newFlags, true);
            retargeted.push({ unitId: unit.id, name: unit.name,
              closureHeaderPointer: headerPointer, membraneSlots });
          }
        }
      }
    }
    headerPointer += size;
  }

  // Aggregate per unit for the report (closureCount + union of slots).
  const retargetedByUnit = new Map();
  for (const entry of retargeted) {
    if (!retargetedByUnit.has(entry.unitId)) {
      retargetedByUnit.set(entry.unitId, {
        unitId: entry.unitId, name: entry.name,
        closureCount: 0, membraneSlots: [] });
    }
    const aggregate = retargetedByUnit.get(entry.unitId);
    aggregate.closureCount++;
    aggregate.membraneSlots.push(...entry.membraneSlots);
  }

  return { retargeted: [...retargetedByUnit.values()], refused };
}

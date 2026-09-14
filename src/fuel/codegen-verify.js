// Bytecode stack-depth verifier — the parse-time detector for the
// deferred-POP bug class (an orphaned POP reachable on one edge but not
// the other). Production-legit like string-audit.js; NOT in debug.js.

import { OP } from './constants.js';

/**
 * Net operand-stack effect per opcode (pushes − pops), for opcodes whose
 * effect is static. `null` = effect depends on operand1:
 * handled explicitly in the simulator. Opcodes absent from BOTH this
 * table and the dynamic set make the containing region UNVERIFIABLE
 * (skipped, never guessed).
 */
const STATIC_EFFECTS = new Map([
  [OP.LIT_INT, +1], [OP.LIT_FLOAT, +1], [OP.LIT_STRING, +1],
  [OP.LIT_NULL, +1], [OP.LIT_UNDEFINED, +1], [OP.LIT_TRUE, +1],
  [OP.LIT_FALSE, +1], [OP.LIT_BIGINT, +1], [OP.LIT_RATIONAL_INTEGER, +1],
  [OP.LIT_RATIONAL_BIGINT, +1], [OP.LIT_WELL_KNOWN_SYMBOL, +1],

  [OP.GET_VAR, +1],
  [OP.SET_VAR, 0],    // pops the value, pushes it back (assignment value)
  [OP.LET_VAR, -1],

  [OP.ADD, -1], [OP.SUB, -1], [OP.MUL, -1], [OP.DIV, -1], [OP.MOD, -1],
  [OP.POW, -1], [OP.EQ, -1], [OP.NEQ, -1], [OP.LT, -1], [OP.GT, -1],
  [OP.LTE, -1], [OP.GTE, -1], [OP.BAND, -1], [OP.BOR, -1], [OP.BXOR, -1],
  [OP.SHL, -1], [OP.SHR, -1], [OP.USHR, -1], [OP.INSTANCEOF, -1],

  [OP.NEG, 0], [OP.NOT, 0], [OP.BNOT, 0], [OP.UPLUS, 0], [OP.TYPEOF, 0],

  [OP.SCOPE_PUSH, 0], [OP.SCOPE_POP, 0],

  [OP.MAKE_CLOSURE, +1], [OP.MAKE_ARROW_CLOSURE, +1],
  [OP.MAKE_ASYNC_CLOSURE, +1], [OP.MAKE_ASYNC_ARROW_CLOSURE, +1],
  [OP.MAKE_GENERATOR_CLOSURE, +1], [OP.MAKE_ASYNC_GENERATOR_CLOSURE, +1],

  [OP.YIELD, 0],      // yielded value → sent value (park/resume swap)

  [OP.GET_PROP, 0],   // receiver → value (name is an operand)
  [OP.SET_PROP, -1],  // receiver, value → value
  [OP.GET_INDEX, -1], // receiver, index → value
  [OP.SET_INDEX, -2], // receiver, index, value → value
  [OP.GET_SUPER, 0],  // receiver, start → receiver, value (name is an operand)
  [OP.SET_SUPER, -2], // receiver, start, value → value

  [OP.AWAIT, 0],      // promise → resolved value
  [OP.POP, -1], [OP.DUP, +1], [OP.SWAP, 0], [OP.NOP, 0],

  [OP.TRY_POP, 0],      // pops a TRY entry, not an operand; the runtime
                        // finally-jump arrives at the same depth the
                        // TRY_PUSH seed already declared
  [OP.FINALLY_END, 0],  // re-dispatches the stashed completion; the
                        // normal-completion fall-through stays at depth
  [OP.PUSH_COMPLETION_KIND, +1], // pushes the top try entry's completion type
  [OP.GRANT_END, 0],    // pops a GRANT entry, not an operand
  [OP.GRANT_DENIED, 0], // denied-block marker; the ids array (if any)
                        // was accounted at the GRANT_START edge
  [OP.ASSERT_ITER_RESULT, 0], // peeks the top value

  [OP.ARRAY_PUSH_ONE, -1],     // [array, value] → [array]
  [OP.OBJ_MERGE_SPREAD, -1],   // [obj, src] → [obj]
  [OP.CALL_SPREAD, -1],        // [callee, argsArray] → [result]
  [OP.CALL_METHOD_SPREAD, -2], // [receiver, method, argsArray] → [result]
  [OP.CLASS_LINK, -1],         // [parent, class] → [class]
]);

// Effect = f(operand1).
const DYNAMIC_EFFECTS = new Map([
  [OP.CALL, (argc) => -argc],              // callee + argc → result
  [OP.CALL_METHOD, (argc) => -(argc + 1)], // receiver + method + argc → result
  [OP.NEW, (argc) => -argc],               // constructor + argc → instance
  [OP.MAKE_ARRAY, (n) => 1 - n],
  [OP.MAKE_OBJECT, (n) => 1 - 2 * n],
]);

// Path terminators (no fall-through successor).
const TERMINATORS = new Set([OP.RETURN, OP.RETURN_UNDEFINED, OP.THROW]);
const TERMINATOR_POPS = new Map([[OP.RETURN, -1], [OP.RETURN_UNDEFINED, 0], [OP.THROW, -1]]);

const CLOSURE_OPS = new Set([
  OP.MAKE_CLOSURE, OP.MAKE_ARROW_CLOSURE,
  OP.MAKE_ASYNC_CLOSURE, OP.MAKE_ASYNC_ARROW_CLOSURE,
  OP.MAKE_GENERATOR_CLOSURE, OP.MAKE_ASYNC_GENERATOR_CLOSURE,
]);

/**
 * verifyCodeBlockStackDepth(mem, options?) → report
 *
 * Simulate operand-stack depth over the emitted bytecode, one REGION at
 * a time (the top level from `fromIndex`, plus each closure body named
 * by a MAKE_*CLOSURE operand). Within a region a worklist propagates
 * depth along fall-through and jump edges; every instruction must be
 * reached at ONE depth. The two finding kinds:
 *
 *   - `join-mismatch` — an instruction reachable at two different
 *     depths. THE deferred-POP signature: `if (c) expr()` compiled the
 *     branch POP at the jump target, so the fall-through edge arrived
 *     one deeper than the jump edge — every false evaluation then ran
 *     an orphaned POP (the console-host callee-slot corruption,
 *     2026-07-02). A codegen bug, always.
 *
 *   - `negative-depth` — the simulated depth dips below the region's
 *     entry baseline. For the top level this is an absolute underflow;
 *     for closure bodies the baseline is relative (bodies run above
 *     their frame's saved position), so a dip below entry is equally
 *     illegal.
 *
 * Coverage: every opcode the parser currently emits is modeled —
 * including try/catch/finally (layout v9's pending-position restore
 * makes handler-entry depths static), grant/denied, and the spread
 * family. Regions containing anything else (the reserved ITER_*
 * opcodes, future additions) are reported UNVERIFIED and skipped —
 * the verifier never guesses.
 *
 * @param {Object} mem - MemoryReader/MemoryImage (codeBlockReadInstruction)
 * @param {Object} [options]
 * @param {number} [options.fromIndex=0] - first instruction of the top-level region
 * @returns {{ regions: number, verified: number,
 *             unverified: Array<{start: number, blockedBy: number, opcodeName?: string}>,
 *             findings: Array<{ kind: string, index: number,
 *                               depths?: number[], depth?: number }> }}
 */
export function verifyCodeBlockStackDepth(mem, { fromIndex = 0 } = {}) {
  const count = mem.codeBlockInstructionCount();
  const report = { regions: 0, verified: 0, unverified: [], findings: [] };

  // Region entries: top level + every closure body in [fromIndex, count).
  const regionStarts = new Set([fromIndex]);
  for (let i = fromIndex; i < count; i++) {
    const inst = mem.codeBlockReadInstruction(i);
    if (CLOSURE_OPS.has(inst.opcode)) {
      regionStarts.add(inst.operand1);
    }
  }

  for (const start of regionStarts) {
    report.regions += 1;
    const depthAt = new Map();
    const worklist = [[start, 0]];
    let blocked = null;
    const regionFindings = [];

    while (worklist.length > 0 && blocked === null) {
      let [index, depth] = worklist.pop();
      if (index >= count) continue;

      // A closure body opens with RECONCILE_PARAMS: whatever the caller
      // pushed is reshaped to exactly paramCount (operand1) values. The
      // region's depth baseline is defined FROM that point.
      if (index === start
          && mem.codeBlockReadInstruction(index).opcode === OP.RECONCILE_PARAMS) {
        depth = mem.codeBlockReadInstruction(index).operand1;
        index = index + 1;
      }

      if (depthAt.has(index)) {
        if (depthAt.get(index) !== depth) {
          regionFindings.push({
            kind: 'join-mismatch', index,
            depths: [depthAt.get(index), depth].sort((a, b) => a - b),
          });
        }
        continue;
      }
      depthAt.set(index, depth);

      const inst = mem.codeBlockReadInstruction(index);
      const { opcode, operand1 } = inst;

      if (TERMINATORS.has(opcode)) {
        const after = depth + TERMINATOR_POPS.get(opcode);
        if (after < 0) regionFindings.push({ kind: 'negative-depth', index, depth: after });
        continue;
      }
      if (opcode === OP.JUMP) {
        worklist.push([operand1, depth]);
        continue;
      }
      if (opcode === OP.UNWIND_JUMP) {
        // Unconditional control transfer; the unwind itself touches try
        // entries, not operands, and any finally it diverts through is
        // reached at that finally's own TRY_PUSH edge.
        worklist.push([operand1, depth]);
        continue;
      }
      if (opcode === OP.JUMP_IF_FALSE || opcode === OP.JUMP_IF_TRUE) {
        const after = depth - 1;
        if (after < 0) {
          regionFindings.push({ kind: 'negative-depth', index, depth: after });
          continue;
        }
        worklist.push([index + 1, after]);
        worklist.push([operand1, after]);
        continue;
      }

      if (opcode === OP.TRY_PUSH) {
        // operand1 = catch index (0 = none), operand2 = finally index.
        // Layout v9 restores the pending pointer to the try's entry
        // position on every abnormal handler entry, so the edges are
        // statically: catch @ depth+1 (the caught error is pushed),
        // finally @ depth (throw/return paths push nothing; the
        // TRY_POP fall-through arrives at the same depth).
        worklist.push([index + 1, depth]);
        if (inst.operand1 !== 0) worklist.push([inst.operand1, depth + 1]);
        if (inst.operand2 !== 0) worklist.push([inst.operand2, depth]);
        continue;
      }

      if (opcode === OP.GRANT_START) {
        // operand1 = denied address (may point PAST the grant when no
        // denied block), operand2 = identifier count. The host pops the
        // identifiers at the yield; on denial it pushes the rejected-ids
        // array ONLY when the denied target is a GRANT_DENIED marker.
        const base = depth - inst.operand2;
        if (base < 0) {
          regionFindings.push({ kind: 'negative-depth', index, depth: base });
          continue;
        }
        worklist.push([index + 1, base]);
        if (inst.operand1 !== 0 && inst.operand1 < count) {
          const deniedIsMarker =
            mem.codeBlockReadInstruction(inst.operand1).opcode === OP.GRANT_DENIED;
          worklist.push([inst.operand1, base + (deniedIsMarker ? 1 : 0)]);
        }
        continue;
      }

      let effect;
      if (STATIC_EFFECTS.has(opcode)) {
        effect = STATIC_EFFECTS.get(opcode);
      } else if (DYNAMIC_EFFECTS.has(opcode)) {
        effect = DYNAMIC_EFFECTS.get(opcode)(operand1);
      } else {
        blocked = { start, blockedBy: index, opcode };
        break;
      }

      const after = depth + effect;
      if (after < 0) {
        regionFindings.push({ kind: 'negative-depth', index, depth: after });
        continue;
      }
      worklist.push([index + 1, after]);
    }

    if (blocked !== null) {
      report.unverified.push(blocked);
    } else {
      report.verified += 1;
      report.findings.push(...regionFindings);
    }
  }

  return report;
}

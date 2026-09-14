import { assert, assertEquals } from 'https://deno.land/std@0.208.0/assert/mod.ts';
import { freshSession, restoreSession, snapshotSession } from '../../src/host-owned-session.js';
import { createDebug } from '../../src/fuel/debug.js';
import {
  CTX, GC_HEADER_SIZE, NATIVE_CONTINUATION_STATE, SCHEMA_PH,
  EXIT_DONE, EXIT_PAUSED_FUEL, EXIT_MEMORY_PRESSURE, EXIT_ERROR,
  ERR_CORRUPT_OPERAND, HEAP_SLACK_HEADROOM,
} from '../../src/fuel/constants.js';
import { SCHEMA_COMPILE, SCHEMA_STATUS } from '../../src/fuel/schema-engine-contract.js';
import { parseAndSetup } from './test-helpers.js';

function continuation(session) {
  const mem = session.mem;
  const root = mem.view.getUint32(mem.abs(mem.getContextStateBase(0) + CTX.REGEX_STATE), true);
  if (!root) return null;
  const values = mem.abs(root + GC_HEADER_SIZE + NATIVE_CONTINUATION_STATE.VALUES);
  return {
    phase: mem.view.getUint32(values, true) & 0xff,
    input: mem.view.getUint32(values + 4, true),
  };
}

// Reach the genuine allocation-pressure boundary after measurement, without
// forging a phase or changing an engine counter. The unrooted tail reservation
// is rolled back before snapshotting, so it cannot alter subsequent allocation
// geometry or force a collection of the buffers being tested.
function measuredSnapshot() {
  const session = freshSession({ inlineSource: true });
  parseAndSetup(session, `
    let marker = 41;
    let schema = Schema.compile({ type: 'number' });
    let verdict = schema.test(1);
    marker = marker + 1;
  `);
  const debug = createDebug(session);
  let parked = false;
  for (let i = 0; i < 1000; i++) {
    const instruction = debug.readInstruction(session.mem.getContextInstructionIndex(0));
    assert(instruction, debug.dumpBytecode(0));
    session.mem.wasm.exports.run(1, 0);
    assertEquals(session.mem.getExitCondition(0), EXIT_PAUSED_FUEL, debug.dumpBytecode(0));
    if (continuation(session)?.phase === SCHEMA_PH.COMPILE_MEASURE) {
      parked = true;
      break;
    }
  }
  assert(parked, 'compile measurement must actually suspend');
  const mem = session.mem;
  const checkpoint = mem.getHeapPointer();
  // Leave the dispatcher's safepoint headroom intact, but less than the
  // emission workspace (its compile-frame region alone exceeds 64 KiB).
  const reservation = mem.getCodePointer() - checkpoint - HEAP_SLACK_HEADROOM - 8;
  assert(reservation > GC_HEADER_SIZE + 4);
  mem.allocateArrayBuffer(reservation - GC_HEADER_SIZE - 4);
  mem.wasm.exports.run(10000000, 0);
  assertEquals(mem.getExitCondition(0), EXIT_MEMORY_PRESSURE);
  assertEquals(continuation(session)?.phase, SCHEMA_PH.COMPILE_MEASURED);
  mem.setHeapPointer(checkpoint);
  return snapshotSession(session);
}

Deno.test('schema setup: malformed restored input faults after debiting emission setup exactly once', () => {
  const snapshot = measuredSnapshot();
  let firstWork;
  for (const grant of [1, 10000000]) {
    const session = restoreSession(snapshot.vatBytes, snapshot.membraneBytes);
    const mem = session.mem;
    const state = continuation(session);
    assertEquals(state.phase, SCHEMA_PH.COMPILE_MEASURED);
    // Corrupt ONLY the encoded schema root, after it was measured. The real
    // emitter copies/zeros its workspace and program, initializes keyword and
    // resource tables, then rejects nil as a schema. No import is mocked and
    // no work total is injected. This is not an ordinary valid-schema case.
    mem.view.setUint8(mem.abs(state.input + 4), 0xc0);
    const allocationStart = mem.getHeapPointer();
    const remaining = mem.wasm.exports.run(grant, 0);
    assertEquals(mem.getExitCondition(0), EXIT_ERROR);
    assertEquals(mem.getErrorInfo().code, ERR_CORRUPT_OPERAND);
    assertEquals(mem.getErrorInfo().detail, SCHEMA_STATUS.SYNTAX_ERROR);
    assertEquals(continuation(session), null, 'failed initialization must discard its continuation');
    assertEquals(session.get(0, 'marker'), 41, 'fault must not execute the following statements');

    // The two real allocations are [program ArrayBuffer][emission ArrayBuffer].
    // Read the abandoned emission workspace before any collection/reallocation.
    // Its total is the initializer's actual retained charge; measurement was
    // already paid before the snapshot and must not be debited again here.
    const programAllocationBytes = mem.view.getUint32(mem.abs(allocationStart), true) & 0x00ffffff;
    const emission = mem.abs(allocationStart + programAllocationBytes + GC_HEADER_SIZE + 4);
    const work = mem.view.getBigUint64(emission + SCHEMA_COMPILE.HEADER.WORK_CHARGED, true);
    assert(work > 0n, 'the real initializer must have done positive work before failing');
    assertEquals(BigInt(grant - remaining), work, 'debit exactly the failed initialization, not measurement or a second step');
    if (firstWork === undefined) firstWork = work;
    else assertEquals(work, firstWork, 'a tiny scheduling grant must not change atomic setup work');
    if (grant === 1) assert(remaining < 0, 'a failed atomic setup may overrun its grant without becoming a fuel pause');
  }
});

Deno.test('schema setup: an uncorrupted measured snapshot resumes through emission debt and collection', () => {
  const snapshot = measuredSnapshot();
  let session = restoreSession(snapshot.vatBytes, snapshot.membraneBytes);
  session.mem.wasm.exports.run(1, 0);
  assertEquals(session.mem.getExitCondition(0), EXIT_PAUSED_FUEL);
  assertEquals(continuation(session)?.phase, SCHEMA_PH.COMPILE_EMIT);
  // Initialization succeeded, so only the engine's next positive step owns
  // setup debt. Exercise the parked, relocatable path rather than restarting it.
  session.gc();
  const paused = snapshotSession(session);
  session = restoreSession(paused.vatBytes, paused.membraneBytes);
  session.mem.wasm.exports.run(10000000, 0);
  assertEquals(session.mem.getExitCondition(0), EXIT_DONE);
  assertEquals(continuation(session), null);
  assertEquals(session.get(0, 'verdict'), true);
  assertEquals(session.get(0, 'marker'), 42);
});

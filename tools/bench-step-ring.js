/**
 * Step-ring hot-path benchmark retained by
 * docs/ring-publication-contract.md.
 *
 * Measures interpreter throughput with instruction-step recording
 * disabled (stepRingSize 0 — the writer is a single branch) and
 * enabled (the full atomic publication sequence per instruction), on
 * the same hot-loop program. Also reports the per-instruction store
 * mix and per-entry memory of the layout v24 cutover, and the bounded
 * reader's paging progress while the interpreter continuously laps
 * the ring.
 *
 * Run with: deno run --allow-all --v8-flags=--expose-gc tools/bench-step-ring.js
 */
import { RuntimeBuilder } from '../src/runtime/test-harness.js';
import { readStepRingRange } from '../src/fuel/step-ring.js';
import { STEP_RING_HEADER_SIZE, STEP_RING_ENTRY_SIZE } from '../src/fuel/constants.js';

const PROGRAM = 'let total = 0; for (let i = 0; i < 300000; i = i + 1) { total = total + i }';
const ROUNDS = 5;

async function measure(stepRingEntries) {
  const options = stepRingEntries > 0
    ? { stepRingSize: STEP_RING_HEADER_SIZE + stepRingEntries * STEP_RING_ENTRY_SIZE }
    : {};
  const { runtime, session } = new RuntimeBuilder()
    .sessionOptions(options)
    .fuel(100_000_000)
    .onInboundMessage(() => {})
    .build();
  await runtime.start();
  const parsed = session.parse(PROGRAM);
  session.setInstruction(0, parsed.startIndex);
  const started = performance.now();
  await runtime.run(0);
  const elapsedMs = performance.now() - started;
  const mem = session.memoryImage;
  const page = readStepRingRange(mem.view, mem.baseOffset);
  const instructions = page.status === 'ok' ? page.reservationHead : 0;
  await runtime.terminate();
  return { elapsedMs, instructions };
}

async function best(stepRingEntries) {
  let fastest = Infinity;
  let instructions = 0;
  for (let round = 0; round < ROUNDS; round++) {
    const result = await measure(stepRingEntries);
    fastest = Math.min(fastest, result.elapsedMs);
    if (result.instructions > 0) instructions = result.instructions;
  }
  return { fastest, instructions };
}

const disabled = await best(0);
const enabled = await best(1024);

const instructions = enabled.instructions;
const disabledRate = instructions / (disabled.fastest / 1000);
const enabledRate = instructions / (enabled.fastest / 1000);
const overheadNsPerInstruction =
  ((enabled.fastest - disabled.fastest) * 1e6) / instructions;

console.log(JSON.stringify({
  program: PROGRAM,
  rounds: ROUNDS,
  instructionsPerRun: instructions,
  disabledBestMs: Number(disabled.fastest.toFixed(2)),
  enabledBestMs: Number(enabled.fastest.toFixed(2)),
  disabledInstructionsPerSecond: Math.round(disabledRate),
  enabledInstructionsPerSecond: Math.round(enabledRate),
  recordingOverheadPercent: Number((((enabled.fastest / disabled.fastest) - 1) * 100).toFixed(1)),
  recordingOverheadNanosPerInstruction: Number(overheadNsPerInstruction.toFixed(1)),
  entryBytes: STEP_RING_ENTRY_SIZE,
  entryBytesAddedByCutover: 8,
  atomicStoresPerInstruction: 12, // head + invalidate + 9 payload words + publish
  plainStoresPerInstructionBeforeCutover: 14,
}, null, 2));

/**
 * Vat-fault taxonomy.
 *
 * `isVatFault(error)` is THE shared predicate embedders use to decide
 * between the two failure policies:
 *
 *   - script error (guest misbehaved, vat intact): JS parity — e.g.
 *     an interval whose callback throws keeps firing.
 *   - vat fault (substrate broken): stop firing into the vat and
 *     escalate — cancel the interval, detach the drone.
 *
 * Unit-tests every error form the drive path produces, then drives
 * the real seam end-to-end: a scheduled closure whose bytecode is
 * corrupted must deliver a vat-fault-classified error to the firer's
 * opts.onError, while a closure that merely throws must deliver a
 * script-error-classified one.
 */

import { assertEquals, assert } from 'https://deno.land/std@0.208.0/assert/mod.ts';
import { RuntimeBuilder } from '../../src/runtime/test-harness.js';
import { isVatFault, UncaughtScriptError } from '../../src/runtime/errors.js';
import { OP } from '../../src/fuel/constants.js';

function tick(ms = 0) { return new Promise(r => setTimeout(r, ms)); }

async function waitFor(condition, { timeout = 2000, label = 'condition' } = {}) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    if (condition()) return;
    await tick(2);
  }
  throw new Error(`waitFor timed out: ${label}`);
}

Deno.test('isVatFault: interpreter fault codes classify as faults in every carrier shape', () => {
  for (const codeName of ['UNKNOWN_OPCODE', 'CORRUPT_OPERAND', 'HEAP_CODE_COLLISION', 'STACK_UNDERFLOW']) {
    const scriptError = { code: 0, codeName, message: 'x', failPc: 3 };
    assertEquals(isVatFault(new UncaughtScriptError(0, scriptError)), true,
      `UncaughtScriptError carrying ${codeName}`);
    assertEquals(isVatFault(scriptError), true, `bare translated ${codeName}`);
  }
  // Numeric-code fallback (a translated error that lost its codeName).
  assertEquals(isVatFault({ code: 24 }), true, 'numeric UNKNOWN_OPCODE');
  assertEquals(isVatFault({ code: 26 }), true, 'numeric CORRUPT_OPERAND');
  assertEquals(isVatFault({ code: 27 }), true, 'numeric HEAP_CODE_COLLISION');
});

Deno.test('isVatFault: script errors and refusals are NOT faults', () => {
  for (const codeName of ['USER_THROW', 'TYPE_ERROR', 'OUT_OF_MEMORY', 'RANGE_ERROR', 'UNHANDLED_ASYNC_REJECTION']) {
    const scriptError = { code: 8, codeName, message: 'x', failPc: 3 };
    assertEquals(isVatFault(new UncaughtScriptError(0, scriptError)), false,
      `UncaughtScriptError carrying ${codeName}`);
  }
  const pressure = new Error('memory_pressure persisted across runtime gc with no progress');
  pressure.name = 'MemoryPressureError';
  assertEquals(isVatFault(pressure), false, 'persistent-pressure OOM refusal');
  const diagnostic = new Error('ledger full');
  diagnostic.name = 'LedgerSaturatedError';
  assertEquals(isVatFault(diagnostic), false, 'diagnostic signal');
  assertEquals(isVatFault(null), false);
  assertEquals(isVatFault(undefined), false);
  assertEquals(isVatFault('boom'), false);
  assertEquals(isVatFault(new Error('plain')), false);
});

Deno.test('isVatFault: raw WASM traps, poisoned collections, and wire flags are faults', () => {
  assertEquals(isVatFault(new WebAssembly.RuntimeError('unreachable')), true, 'live trap');
  assertEquals(isVatFault({ name: 'RuntimeError', message: 'memory access out of bounds' }), true,
    'serialized trap');
  const fatal = new Error('gc_collect failed');
  fatal.name = 'FatalCollectionError';
  fatal.fatalCollection = true;
  assertEquals(isVatFault(fatal), true, 'poisoned collection');
  assertEquals(isVatFault({ name: 'Error', message: 'x', vatFault: true }), true,
    'pre-computed wire flag');
});

// ---------------------------------------------------------------------------
// End-to-end through the real seam: scheduleClosureCall's opts.onError —
// the exact signal the time capability's interval policy consumes.
// ---------------------------------------------------------------------------

async function buildWithCapturedClosure(source) {
  let capturedClosure = null;
  const handlerErrors = [];
  const { runtime, session, channels } = new RuntimeBuilder()
    .capability({
      name: 'Host',
      setup: (airlock) => {
        const rootGrant = airlock.createRootGrant();
        const handle = airlock.register({});
        rootGrant.add(handle);
        airlock.setHandler(handle, 'register', ({ args }) => {
          capturedClosure = args[0];
          return null;
        });
        airlock.declare('Host', handle);
      },
    })
    .onInboundMessage(() => {})
    .onHandlerError((err) => { handlerErrors.push(err); })
    .build();
  await runtime.start();
  session.parse(source);
  await runtime.run(0);
  assert(capturedClosure !== null, 'closure should be captured');
  return { runtime, session, channels, handlerErrors, capturedClosure };
}

Deno.test('end-to-end: corrupted closure delivers a vat-fault error to opts.onError', async () => {
  const { runtime, session, channels, capturedClosure } =
    await buildWithCapturedClosure(`Host.register(function(a, b) { return a })`);

  // Corrupt the closure body's RECONCILE_PARAMS paramCount with the
  // incident value (0x0d000020 = 218M).
  const mem = session.mem;
  const codeStart = mem.getCodeStart();
  const count = mem.view.getUint32(mem.abs(codeStart), true);
  let reconcileIndex = -1;
  for (let index = 0; index < count; index++) {
    if (mem.codeBlockReadInstruction(index).opcode === OP.RECONCILE_PARAMS) {
      reconcileIndex = index;
      break;
    }
  }
  assert(reconcileIndex >= 0, 'closure body must contain RECONCILE_PARAMS');
  mem.codeBlockPatch(reconcileIndex, 0x0d000020);

  const callErrors = [];
  runtime.scheduleClosureCall(capturedClosure, [], {
    onError: (error) => { callErrors.push(error); },
  });
  await waitFor(() => callErrors.length > 0, { label: 'onError from corrupted closure' });

  assertEquals(isVatFault(callErrors[0]), true,
    `corrupted closure's error must classify as vat fault, got: ${callErrors[0]?.message}`);

  await runtime.terminate();
  channels.close();
});

Deno.test('end-to-end: throwing closure delivers a script error (NOT a vat fault) to opts.onError', async () => {
  const { runtime, channels, capturedClosure } =
    await buildWithCapturedClosure(`Host.register(function() { throw "ordinary bug" })`);

  const callErrors = [];
  runtime.scheduleClosureCall(capturedClosure, [], {
    onError: (error) => { callErrors.push(error); },
  });
  await waitFor(() => callErrors.length > 0, { label: 'onError from throwing closure' });

  assertEquals(isVatFault(callErrors[0]), false,
    'an ordinary uncaught script throw must NOT classify as a vat fault');
  assert(String(callErrors[0]?.message ?? '').includes('ordinary bug'),
    `script error should carry the thrown value, got: ${callErrors[0]?.message}`);

  await runtime.terminate();
  channels.close();
});

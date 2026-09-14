import {
  assert,
  assertEquals,
  assertRejects,
} from "https://deno.land/std@0.208.0/assert/mod.ts";
import {
  ResultMarshallingError,
  RuntimeBuilder,
} from '../../src/runtime/index.js';
import { CONTEXT_STATUS_FREE } from '../../src/fuel/constants.js';

async function buildRuntime(source, configure = (builder) => builder) {
  const builder = configure(new RuntimeBuilder().onInboundMessage(() => {}));
  const built = builder.build();
  await built.runtime.start();
  built.session.parse(source);
  const result = await built.runtime.run(0);
  assertEquals(result.status, 'done');
  return built;
}

async function closeRuntime({ runtime, channels }) {
  await runtime.terminate();
  channels.close();
}

function liveContextSlots(session) {
  let count = 0;
  for (let slot = 0; slot < session.memoryImage.getContextCount(); slot++) {
    if (session.memoryImage.getExitCondition(slot) !== CONTEXT_STATUS_FREE) count++;
  }
  return count;
}

function commandCapability(captured, { approve = true } = {}) {
  return {
    name: 'command-host',
    needs: {},
    setup(airlock) {
      const handle = airlock.register({});
      const returnedHandle = airlock.register({ kind: 'returned-handle' });
      airlock.setHandler(handle, 'nested', ({ args, context }) =>
        context.suspend((resolve) => {
          captured.resolveNested = (value = { nested: args[0] * 3 }) => resolve(value);
          captured.nestedEntered();
        }));
      airlock.setHandler(handle, 'handleValue', () => returnedHandle);
      airlock.declare('Command', handle);
      const grant = airlock.membrane.createGrant('command');
      grant.add(handle);
      grant.add(returnedHandle);
      return {
        onGrantRequest(identifier) {
          return approve && identifier === 'command' ? grant : null;
        },
      };
    },
  };
}

Deno.test('Runtime.invokeExport: named numeric arguments and synchronous result', async () => {
  const built = await buildRuntime('export const add = (x, y) => x + y');
  assertEquals(
    await built.runtime.invokeExport('add', { x: 6, y: 9 }, { parameterNames: ['x', 'y'] }),
    15,
  );
  await closeRuntime(built);
});

Deno.test('Runtime.invokeExport: explicit metadata defines positional adaptation', async () => {
  const built = await buildRuntime('export const subtract = (left, right) => left - right');
  assertEquals(
    await built.runtime.invokeExport(
      'subtract',
      { minuend: 20, subtrahend: 3 },
      { parameterNames: ['minuend', 'subtrahend'] },
    ),
    17,
  );
  await closeRuntime(built);
});

Deno.test('Runtime.invokeExport: asynchronous export returns after suspension', async () => {
  const built = await buildRuntime('export async function double(value) { return await Promise.resolve(value * 2) }');
  assertEquals(
    await built.runtime.invokeExport('double', { value: 8 }, { parameterNames: ['value'] }),
    16,
  );
  await closeRuntime(built);
});

Deno.test('Runtime.invokeExport: every JSON value family survives nested output', async () => {
  const built = await buildRuntime(`
    export const values = () => ({
      nullValue: null,
      falseValue: false,
      trueValue: true,
      numberValue: 12.5,
      stringValue: "text",
      arrayValue: [null, false, 3, "four", { nested: [true] }],
      objectValue: { child: { count: 2 } }
    })
  `);
  assertEquals(
    await built.runtime.invokeExport('values', {}, { parameterNames: [] }),
    {
      nullValue: null,
      falseValue: false,
      trueValue: true,
      numberValue: 12.5,
      stringValue: 'text',
      arrayValue: [null, false, 3, 'four', { nested: [true] }],
      objectValue: { child: { count: 2 } },
    },
  );
  await closeRuntime(built);
});

Deno.test('Runtime.invokeExport: rejects missing and non-function exports before context allocation', async () => {
  const built = await buildRuntime('export const value = 3');
  const contextsBefore = liveContextSlots(built.session);
  const handlesBefore = built.session.airlock.membrane.enumerateClosureHandles().length;
  await assertRejects(
    () => built.runtime.invokeExport('missing', {}, { parameterNames: [] }),
    Error,
    'not exported',
  );
  await assertRejects(
    () => built.runtime.invokeExport('value', {}, { parameterNames: [] }),
    Error,
    'not a function',
  );
  assertEquals(liveContextSlots(built.session), contextsBefore);
  assertEquals(built.session.airlock.membrane.enumerateClosureHandles().length, handlesBefore);
  await closeRuntime(built);
});

Deno.test('Runtime.invokeExport: validates named-record inputs before invocation', async () => {
  const built = await buildRuntime('export const identity = (value) => value');
  await assertRejects(
    () => built.runtime.invokeExport('identity', [], { parameterNames: ['value'] }),
    TypeError,
    'plain object',
  );
  await assertRejects(
    () => built.runtime.invokeExport('identity', {}, { parameterNames: ['value'] }),
    TypeError,
    "missing parameter 'value'",
  );
  await assertRejects(
    () => built.runtime.invokeExport('identity', { value: Infinity }, { parameterNames: ['value'] }),
    TypeError,
    '$.value',
  );
  await closeRuntime(built);
});

Deno.test('Runtime.invokeExport: unsupported and nested return values name their paths', async () => {
  const built = await buildRuntime(`
    export const missing = () => undefined
    export const nonFinite = () => ({ items: [1, 0 / 0] })
    export const closure = () => (() => 1)
  `);
  const missingError = await assertRejects(
    () => built.runtime.invokeExport('missing', {}, { parameterNames: [] }),
    ResultMarshallingError,
    '$',
  );
  assertEquals(missingError.path, '$');
  const nestedError = await assertRejects(
    () => built.runtime.invokeExport('nonFinite', {}, { parameterNames: [] }),
    ResultMarshallingError,
    '$.items[1]',
  );
  assertEquals(nestedError.path, '$.items[1]');
  await assertRejects(
    () => built.runtime.invokeExport('closure', {}, { parameterNames: [] }),
    ResultMarshallingError,
    '$',
  );
  await closeRuntime(built);
});

Deno.test('Runtime.invokeExport: rejects bigint, symbol, and cyclic return families', async () => {
  const built = await buildRuntime(`
    export const bigintValue = () => 1n
    export const symbolValue = () => Symbol("value")
    export const cyclicValue = () => {
      let value = {}
      value.self = value
      return value
    }
  `);
  for (const exportName of ['bigintValue', 'symbolValue', 'cyclicValue']) {
    await assertRejects(
      () => built.runtime.invokeExport(exportName, {}, { parameterNames: [] }),
      ResultMarshallingError,
      undefined,
      `${exportName} must reject`,
    );
  }
  await closeRuntime(built);
});

Deno.test('Runtime.invokeExport: rejects host handles and other non-JSON containers', async () => {
  const captured = { nestedEntered() {} };
  const built = await buildRuntime(`
    export const mapValue = () => new Map()
    export const bufferValue = () => new ArrayBuffer(8)
    export function handleValue() {
      grant "command" { return Command.handleValue() }
      denied { return null }
    }
  `, (builder) => builder.capability(commandCapability(captured)));
  for (const exportName of ['mapValue', 'bufferValue', 'handleValue']) {
    await assertRejects(
      () => built.runtime.invokeExport(exportName, {}, { parameterNames: [] }),
      ResultMarshallingError,
      '$',
    );
  }
  await closeRuntime(built);
});

Deno.test('Runtime.invokeExport: thrown script errors reject unchanged', async () => {
  const built = await buildRuntime('export const fail = () => { throw { type: "Failure", message: "broken" } }');
  const error = await assertRejects(
    () => built.runtime.invokeExport('fail', {}, { parameterNames: [] }),
    Error,
    'broken',
  );
  assert(error.scriptError !== undefined);
  await closeRuntime(built);
});

Deno.test('Runtime.invokeExport: same export runs concurrently in separate slots', async () => {
  const built = await buildRuntime(`
    export async function echo(value) {
      let result = await Promise.resolve(value)
      return { value: result }
    }
  `);
  const [first, second] = await Promise.all([
    built.runtime.invokeExport('echo', { value: 1 }, { parameterNames: ['value'] }),
    built.runtime.invokeExport('echo', { value: 2 }, { parameterNames: ['value'] }),
  ]);
  assertEquals(first, { value: 1 });
  assertEquals(second, { value: 2 });
  await closeRuntime(built);
});

Deno.test('Runtime.invokeExport: success and failure release slots and closure handles', async () => {
  const built = await buildRuntime(`
    export const succeed = () => ({ ok: true })
    export const fail = () => { throw "failure" }
  `);
  const contextsBefore = liveContextSlots(built.session);
  const handlesBefore = built.session.airlock.membrane.enumerateClosureHandles().length;
  await built.runtime.invokeExport('succeed', {}, { parameterNames: [] });
  await assertRejects(
    () => built.runtime.invokeExport('fail', {}, { parameterNames: [] }),
    Error,
  );
  assertEquals(liveContextSlots(built.session), contextsBefore);
  assertEquals(built.session.airlock.membrane.enumerateClosureHandles().length, handlesBefore);
  assertEquals(built.runtime.getSchedulerStats().inFlight, 0);
  await closeRuntime(built);
});

Deno.test('Runtime.invokeExport: quiesce defers setup until resume', async () => {
  const built = await buildRuntime('export const answer = () => 42');
  await built.runtime.quiesce();
  const contextsBefore = liveContextSlots(built.session);
  const pending = built.runtime.invokeExport('answer', {}, { parameterNames: [] });
  await Promise.resolve();
  assertEquals(liveContextSlots(built.session), contextsBefore);
  built.runtime.resume();
  assertEquals(await pending, 42);
  await closeRuntime(built);
});

Deno.test('Runtime.invokeExport: approved grant and nested capability suspension return JSON', async () => {
  let nestedEnteredResolve;
  const nestedEntered = new Promise((resolve) => { nestedEnteredResolve = resolve; });
  const captured = {
    resolveNested: null,
    nestedEntered: nestedEnteredResolve,
  };
  const built = await buildRuntime(`
    export async function invokeNested(value) {
      grant "command" {
        let nested = await Command.nested(value)
        return { outer: true, nested }
      } denied {
        return { denied: true }
      }
    }
  `, (builder) => builder.capability(commandCapability(captured)));
  const pending = built.runtime.invokeExport(
    'invokeNested',
    { value: 7 },
    { parameterNames: ['value'] },
  );
  await nestedEntered;
  captured.resolveNested();
  assertEquals(await pending, { outer: true, nested: { nested: 21 } });
  await closeRuntime(built);
});

Deno.test('Runtime.invokeExport: denied grant follows the language denied branch', async () => {
  const captured = { nestedEntered() {} };
  const built = await buildRuntime(`
    export async function invokeDenied() {
      grant "command" {
        return await Command.nested(1)
      } denied {
        return { denied: true }
      }
    }
  `, (builder) => builder.capability(commandCapability(captured, { approve: false })));
  assertEquals(
    await built.runtime.invokeExport('invokeDenied', {}, { parameterNames: [] }),
    { denied: true },
  );
  await closeRuntime(built);
});

Deno.test('Runtime.invokeExport: fuel pause and refill settle the original invocation', async () => {
  const built = await buildRuntime(`
    export function busy(count) {
      let index = 0
      while (index < count) { index = index + 1 }
      return index
    }
  `);
  built.runtime._fuel = 50;
  let pausedSlotResolve;
  const pausedSlot = new Promise((resolve) => { pausedSlotResolve = resolve; });
  let refuelResolve;
  const refuel = new Promise((resolve) => { refuelResolve = resolve; });
  built.runtime.onFuelExhausted = (slot) => {
    pausedSlotResolve(slot);
    return refuel;
  };
  const pending = built.runtime.invokeExport(
    'busy',
    { count: 10000 },
    { parameterNames: ['count'] },
  );
  const slot = await pausedSlot;
  assert(slot > 0);
  refuelResolve(10_000_000);
  assertEquals(await pending, 10000);
  await closeRuntime(built);
});

Deno.test('Runtime.invokeExport: terminate cancels a suspended one-shot invocation', async () => {
  let nestedEnteredResolve;
  const nestedEntered = new Promise((resolve) => { nestedEnteredResolve = resolve; });
  const captured = {
    resolveNested: null,
    nestedEntered: nestedEnteredResolve,
  };
  const built = await buildRuntime(`
    export async function pending(value) {
      grant "command" { return await Command.nested(value) }
      denied { return null }
    }
  `, (builder) => builder.capability(commandCapability(captured)));
  const invocation = built.runtime.invokeExport(
    'pending',
    { value: 1 },
    { parameterNames: ['value'] },
  );
  await nestedEntered;
  await built.runtime.terminate();
  await assertRejects(() => invocation, Error, 'terminated');
  assertEquals(built.runtime.getSchedulerStats().inFlight, 0);
  built.channels.close();
});

Deno.test('Runtime.invokeExport: quiesced snapshot preserves a pending invocation', async () => {
  let nestedEnteredResolve;
  const nestedEntered = new Promise((resolve) => { nestedEnteredResolve = resolve; });
  const captured = {
    resolveNested: null,
    nestedEntered: nestedEnteredResolve,
  };
  const built = await buildRuntime(`
    export async function pending(value) {
      grant "command" { return await Command.nested(value) }
      denied { return null }
    }
  `, (builder) => builder.capability(commandCapability(captured)));
  const invocation = built.runtime.invokeExport(
    'pending',
    { value: 4 },
    { parameterNames: ['value'] },
  );
  await nestedEntered;
  await built.runtime.quiesce();
  const snapshot = built.snapshot();
  assert(snapshot.vatBytes.byteLength > 0);
  assert(snapshot.membraneBytes.byteLength > 0);
  built.runtime.resume();
  captured.resolveNested();
  assertEquals(await invocation, { nested: 12 });
  await closeRuntime(built);
});

Deno.test('Runtime.invokeExport: restored cleanup drops allocated and pre-allocation temporary handles', async () => {
  let nestedEnteredResolve;
  const nestedEntered = new Promise((resolve) => { nestedEnteredResolve = resolve; });
  const captured = {
    resolveNested: null,
    nestedEntered: nestedEnteredResolve,
  };
  const built = await buildRuntime(`
    export async function pending(value) {
      grant "command" { return await Command.nested(value) }
      denied { return null }
    }
    export const deferred = (value) => value
  `, (builder) => builder.capability(commandCapability(captured)));
  const handlesBefore =
    built.session.airlock.enumerateClosureHandles().length;
  const allocatedOutcome = built.runtime.invokeExport(
    'pending',
    { value: 4 },
    { parameterNames: ['value'] },
  ).then(
    (value) => ({ value }),
    (error) => ({ error }),
  );
  await nestedEntered;
  assertEquals(
    built.session.airlock.enumerateClosureHandles().length,
    handlesBefore + 1,
  );

  await built.runtime.quiesce();
  const deferredOutcome = built.runtime.invokeExport(
    'deferred',
    { value: 8 },
    { parameterNames: ['value'] },
  ).then(
    (value) => ({ value }),
    (error) => ({ error }),
  );
  await Promise.resolve();
  assertEquals(
    built.session.airlock.enumerateClosureHandles().length,
    handlesBefore + 2,
  );
  const snapshot = built.snapshot();

  const restoredCaptured = {
    resolveNested: null,
    nestedEntered() {},
  };
  const restored = new RuntimeBuilder()
    .fromSnapshot(snapshot)
    .capability(commandCapability(restoredCaptured))
    .onInboundMessage(() => {})
    .build();
  assertEquals(
    restored.session.airlock.enumerateClosureHandles().length,
    handlesBefore + 2,
  );
  assertEquals(restored.runtime.cancelRestoredInvocationRoots(), 1);
  assertEquals(
    restored.session.airlock.enumerateClosureHandles().length,
    handlesBefore,
  );
  await restored.runtime.start();
  await restored.runtime.terminate();
  restored.channels.close();

  await built.runtime.terminate();
  assert((await allocatedOutcome).error instanceof Error);
  assert((await deferredOutcome).error instanceof Error);
  built.channels.close();
});

Deno.test('Runtime.invokeExport: heap-pressure recovery preserves the result', async () => {
  const garbageCollections = [];
  const built = await buildRuntime(`
    export function churn(count) {
      let index = 0
      let total = 0
      while (index < count) {
        let temporary = { index, text: "temporary-allocation-" + index }
        total = total + temporary.index
        index = index + 1
      }
      return total
    }
  `, (builder) => builder.sessionOptions({ heapSize: 128 * 1024 }));
  built.runtime.onGarbageCollect = (event) => { garbageCollections.push(event); };
  assertEquals(
    await built.runtime.invokeExport('churn', { count: 2000 }, { parameterNames: ['count'] }),
    1999000,
  );
  assert(garbageCollections.length > 0, 'the fixture must trigger heap-pressure collection');
  await closeRuntime(built);
});

Deno.test('Runtime.invokeExport: already-aborted signal allocates no context or closure handle', async () => {
  const built = await buildRuntime('export const answer = () => 42');
  const controller = new AbortController();
  const reason = { kind: 'cancelled-before-start' };
  controller.abort(reason);
  const contextsBefore = liveContextSlots(built.session);
  const handlesBefore =
    built.session.airlock.membrane.enumerateClosureHandles().length;
  let caught;
  try {
    await built.runtime.invokeExport('answer', {}, {
      parameterNames: [],
      signal: controller.signal,
    });
  } catch (error) {
    caught = error;
  }
  assertEquals(caught, reason);
  assertEquals(liveContextSlots(built.session), contextsBefore);
  assertEquals(
    built.session.airlock.membrane.enumerateClosureHandles().length,
    handlesBefore,
  );
  await closeRuntime(built);
});

Deno.test('Runtime.invokeExport: quiesce-deferred invocation aborts without beginning on resume', async () => {
  const built = await buildRuntime('export const answer = () => 42');
  await built.runtime.quiesce();
  const controller = new AbortController();
  const reason = new Error('cancelled while quiesced');
  const contextsBefore = liveContextSlots(built.session);
  const invocation = built.runtime.invokeExport('answer', {}, {
    parameterNames: [],
    signal: controller.signal,
  });
  controller.abort(reason);
  await assertRejects(() => invocation, Error, reason.message);
  built.runtime.resume();
  await Promise.resolve();
  assertEquals(liveContextSlots(built.session), contextsBefore);
  await closeRuntime(built);
});

Deno.test('Runtime.invokeExport: cancellation isolates a suspended invocation across slot reuse', async () => {
  let nestedEnteredResolve;
  const nestedEntered = new Promise((resolve) => {
    nestedEnteredResolve = resolve;
  });
  const captured = {
    resolveNested: null,
    nestedEntered: nestedEnteredResolve,
  };
  const built = await buildRuntime(`
    export async function suspended(value) {
      grant "command" {
        let nested = await Command.nested(value)
        return { nested }
      } denied {
        return { denied: true }
      }
    }
    export const immediate = (value) => ({ value })
  `, (builder) => builder.capability(commandCapability(captured)));

  const controller = new AbortController();
  const reason = new Error('cancel one invocation');
  const cancelled = built.runtime.invokeExport(
    'suspended',
    { value: 7 },
    { parameterNames: ['value'], signal: controller.signal },
  );
  const survivor = built.runtime.invokeExport(
    'immediate',
    { value: 11 },
    { parameterNames: ['value'] },
  );
  await nestedEntered;
  controller.abort(reason);
  await assertRejects(() => cancelled, Error, reason.message);
  assertEquals(await survivor, { value: 11 });

  const replacement = await built.runtime.invokeExport(
    'immediate',
    { value: 13 },
    { parameterNames: ['value'] },
  );
  assertEquals(replacement, { value: 13 });
  captured.resolveNested();
  await Promise.resolve();
  assertEquals(
    await built.runtime.invokeExport(
      'immediate',
      { value: 17 },
      { parameterNames: ['value'] },
    ),
    { value: 17 },
  );
  await closeRuntime(built);
});

Deno.test('Runtime.invokeExport: rejects a non-AbortSignal before allocation', async () => {
  const built = await buildRuntime('export const answer = () => 42');
  const contextsBefore = liveContextSlots(built.session);
  await assertRejects(
    () => built.runtime.invokeExport('answer', {}, {
      parameterNames: [],
      signal: {},
    }),
    TypeError,
    'AbortSignal',
  );
  assertEquals(liveContextSlots(built.session), contextsBefore);
  await closeRuntime(built);
});

Deno.test('Runtime.invokeExport: abort frees a fuel-paused invocation', async () => {
  const built = await buildRuntime(`
    export function busy(count) {
      let index = 0
      while (index < count) { index = index + 1 }
      return index
    }
  `);
  built.runtime._fuel = 20;
  let pausedSlotResolve;
  const pausedSlot = new Promise((resolve) => {
    pausedSlotResolve = resolve;
  });
  built.runtime.onFuelExhausted = (slot) => {
    pausedSlotResolve(slot);
    return 0;
  };
  const controller = new AbortController();
  const reason = new Error('cancel fuel-paused invocation');
  const invocation = built.runtime.invokeExport(
    'busy',
    { count: 10000 },
    { parameterNames: ['count'], signal: controller.signal },
  );
  const slot = await pausedSlot;
  controller.abort(reason);
  await assertRejects(() => invocation, Error, reason.message);
  assertEquals(
    built.session.memoryImage.getExitCondition(slot),
    CONTEXT_STATUS_FREE,
  );
  assertEquals(built.runtime.getSchedulerStats().inFlight, 0);
  await closeRuntime(built);
});

Deno.test('Runtime.invokeExport: abort while quiesced cancels an allocated invocation', async () => {
  let nestedEnteredResolve;
  const nestedEntered = new Promise((resolve) => {
    nestedEnteredResolve = resolve;
  });
  const captured = {
    resolveNested: null,
    nestedEntered: nestedEnteredResolve,
  };
  const built = await buildRuntime(`
    export async function suspended(value) {
      grant "command" { return await Command.nested(value) }
      denied { return null }
    }
  `, (builder) => builder.capability(commandCapability(captured)));
  const controller = new AbortController();
  const reason = new Error('cancel allocated invocation while quiesced');
  const invocation = built.runtime.invokeExport(
    'suspended',
    { value: 5 },
    { parameterNames: ['value'], signal: controller.signal },
  );
  await nestedEntered;
  await built.runtime.quiesce();
  const bytesBeforeAbort = built.snapshot().vatBytes;
  let settled = false;
  invocation.then(
    () => { settled = true; },
    () => { settled = true; },
  );
  controller.abort(reason);
  await Promise.resolve();
  assertEquals(settled, false);
  const bytesAfterAbort = built.snapshot().vatBytes;
  assertEquals(bytesAfterAbort, bytesBeforeAbort);
  built.runtime.resume();
  await assertRejects(() => invocation, Error, reason.message);
  captured.resolveNested();
  await Promise.resolve();
  assertEquals(built.runtime.getSchedulerStats().inFlight, 0);
  await closeRuntime(built);
});

Deno.test('Runtime.invokeExport: abort wins a same-turn late settlement race', async () => {
  let nestedEnteredResolve;
  const nestedEntered = new Promise((resolve) => {
    nestedEnteredResolve = resolve;
  });
  const captured = {
    resolveNested: null,
    nestedEntered: nestedEnteredResolve,
  };
  const built = await buildRuntime(`
    export async function suspended(value) {
      grant "command" { return await Command.nested(value) }
      denied { return null }
    }
    export const immediate = (value) => value
  `, (builder) => builder.capability(commandCapability(captured)));
  const controller = new AbortController();
  const reason = new Error('race cancellation');
  const invocation = built.runtime.invokeExport(
    'suspended',
    { value: 3 },
    { parameterNames: ['value'], signal: controller.signal },
  );
  await nestedEntered;
  controller.abort(reason);
  captured.resolveNested();
  await assertRejects(() => invocation, Error, reason.message);
  assertEquals(
    await built.runtime.invokeExport(
      'immediate',
      { value: 19 },
      { parameterNames: ['value'] },
    ),
    19,
  );
  assertEquals(built.runtime.getSchedulerStats().inFlight, 0);
  await closeRuntime(built);
});

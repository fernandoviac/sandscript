import {
  assert,
  assertEquals,
  assertRejects,
  assertStrictEquals,
} from "https://deno.land/std@0.208.0/assert/mod.ts";
import {
  ResultMarshallingError,
  RuntimeBuilder,
} from '../../src/runtime/index.js';

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

function makeSignal() {
  let resolveSignal;
  const promise = new Promise((resolve) => { resolveSignal = resolve; });
  return { promise, resolve: resolveSignal };
}

// Capability observing context.hostInvocationContext on every call.
// `observe` records synchronously; `wait` suspends and records both the
// handler-time value and (later, inside the suspend async callback) the
// retained-context value. `handleValue` returns a host handle so an
// export can force a ResultMarshallingError terminal path.
function attributionCapability(captured) {
  return {
    name: 'attribution-host',
    needs: {},
    setup(airlock) {
      const handle = airlock.register({});
      const returnedHandle = airlock.register({ kind: 'returned-handle' });
      airlock.setHandler(handle, 'observe', ({ args, context }) => {
        captured.observations.push({
          tag: args[0],
          stage: args[1] ?? null,
          slot: context.id,
          value: context.hostInvocationContext,
        });
        captured.contexts.push(context);
        captured.onObserve?.();
        return null;
      });
      airlock.setHandler(handle, 'wait', ({ args, context }) =>
        context.suspend((resolve) => {
          captured.waiters.push({
            tag: args[0],
            context,
            valueInsideSuspendCallback: context.hostInvocationContext,
            resolve,
          });
          captured.onWait?.();
        }));
      airlock.setHandler(handle, 'handleValue', () => returnedHandle);
      airlock.declare('Attribution', handle);
      const grant = airlock.membrane.createGrant('attribution');
      grant.add(handle);
      grant.add(returnedHandle);
      return {
        onGrantRequest(identifier) {
          return identifier === 'attribution' ? grant : null;
        },
      };
    },
  };
}

function freshCaptured() {
  return {
    observations: [],
    contexts: [],
    waiters: [],
    onObserve: null,
    onWait: null,
  };
}

const ATTRIBUTION_SOURCE = `
  export async function oneShot(tag) {
    grant "attribution" {
      Attribution.observe(tag, "only")
      return tag
    } denied { return null }
  }
  export async function interactive(tag) {
    grant "attribution" {
      Attribution.observe(tag, "before")
      let received = await Attribution.wait(tag)
      Attribution.observe(tag, "after")
      return received
    } denied { return null }
  }
  export async function throwing(tag) {
    grant "attribution" {
      Attribution.observe(tag, "before")
      throw new Error("deliberate failure")
    } denied { return null }
  }
  export async function invalidResult(tag) {
    grant "attribution" {
      Attribution.observe(tag, "before")
      return Attribution.handleValue()
    } denied { return null }
  }
`;

async function buildAttributionRuntime(captured) {
  return await buildRuntime(
    ATTRIBUTION_SOURCE,
    (builder) => builder.capability(attributionCapability(captured)),
  );
}

Deno.test('hostInvocationContext: omitted option reports undefined on the first capability call', async () => {
  const captured = freshCaptured();
  const built = await buildAttributionRuntime(captured);
  assertEquals(
    await built.runtime.invokeExport('oneShot', { tag: 'plain' }, { parameterNames: ['tag'] }),
    'plain',
  );
  assertEquals(captured.observations.length, 1);
  assertStrictEquals(captured.observations[0].value, undefined);
  await closeRuntime(built);
});

Deno.test('hostInvocationContext: primitive and object values preserve exact identity', async () => {
  const captured = freshCaptured();
  const built = await buildAttributionRuntime(captured);
  const objectToken = { queue: Symbol('input'), nested: { handle: () => {} } };
  await built.runtime.invokeExport('oneShot', { tag: 'obj' }, {
    parameterNames: ['tag'],
    hostInvocationContext: objectToken,
  });
  await built.runtime.invokeExport('oneShot', { tag: 'prim' }, {
    parameterNames: ['tag'],
    hostInvocationContext: 'primitive-token',
  });
  assertStrictEquals(captured.observations[0].value, objectToken);
  assertStrictEquals(captured.observations[1].value, 'primitive-token');
  await closeRuntime(built);
});

Deno.test('hostInvocationContext: suspension and resume preserve the value; a settled invocation goes stale', async () => {
  const captured = freshCaptured();
  const built = await buildAttributionRuntime(captured);
  const token = { invocation: 'A' };
  const waitParked = makeSignal();
  captured.onWait = waitParked.resolve;
  const pending = built.runtime.invokeExport('interactive', { tag: 'A' }, {
    parameterNames: ['tag'],
    hostInvocationContext: token,
  });
  await waitParked.promise;
  // Retained context resolves while suspended, both at handler time and
  // inside the suspend async callback (outside the handler's synchronous
  // dynamic extent) — the stream-capability operating point.
  assertStrictEquals(captured.waiters[0].valueInsideSuspendCallback, token);
  assertStrictEquals(captured.waiters[0].context.hostInvocationContext, token);
  captured.waiters[0].resolve('input-line');
  assertEquals(await pending, 'input-line');
  assertStrictEquals(captured.observations[0].value, token); // before
  assertStrictEquals(captured.observations[1].value, token); // after resume
  // Terminal invocation: every retained Context goes stale.
  assertStrictEquals(captured.waiters[0].context.hostInvocationContext, undefined);
  for (const context of captured.contexts) {
    assertStrictEquals(context.hostInvocationContext, undefined);
  }
  await closeRuntime(built);
});

Deno.test('hostInvocationContext: many concurrent invocations never cross-associate under adversarial interleaving', async () => {
  const captured = freshCaptured();
  const built = await buildAttributionRuntime(captured);
  const count = 5;
  const tokens = Array.from({ length: count }, (_, i) => ({ invocation: i }));
  const pendings = [];
  for (let i = 0; i < count; i++) {
    const parked = makeSignal();
    captured.onWait = parked.resolve;
    pendings.push(built.runtime.invokeExport('interactive', { tag: `inv-${i}` }, {
      parameterNames: ['tag'],
      hostInvocationContext: tokens[i],
    }));
    await parked.promise;
  }
  // Every suspended invocation observes exactly its own token.
  for (let i = 0; i < count; i++) {
    assertStrictEquals(captured.waiters[i].valueInsideSuspendCallback, tokens[i]);
  }
  // Resolve in reverse order — an interleaving a single "current
  // invocation" variable cannot survive.
  for (let i = count - 1; i >= 0; i--) {
    captured.waiters[i].resolve(`payload-${i}`);
    assertEquals(await pendings[i], `payload-${i}`);
  }
  for (const observation of captured.observations) {
    const index = Number(observation.tag.slice('inv-'.length));
    assertStrictEquals(observation.value, tokens[index]);
  }
  await closeRuntime(built);
});

Deno.test('hostInvocationContext: slot reuse cannot expose a prior invocation value', async () => {
  const captured = freshCaptured();
  const built = await buildAttributionRuntime(captured);
  const firstToken = { generation: 'first' };
  await built.runtime.invokeExport('oneShot', { tag: 'first' }, {
    parameterNames: ['tag'],
    hostInvocationContext: firstToken,
  });
  const firstObservation = captured.observations[0];
  const firstContext = captured.contexts[0];
  assertStrictEquals(firstObservation.value, firstToken);

  // Sequential invocation reuses the freed slot with a new generation.
  await built.runtime.invokeExport('oneShot', { tag: 'second' }, {
    parameterNames: ['tag'],
  });
  const secondObservation = captured.observations[1];
  assertEquals(secondObservation.slot, firstObservation.slot);
  assertStrictEquals(secondObservation.value, undefined);
  // The prior invocation's stale Context must not resolve to the slot's
  // next occupant even while that occupant runs.
  const thirdToken = { generation: 'third' };
  const parked = makeSignal();
  captured.onWait = parked.resolve;
  const pending = built.runtime.invokeExport('interactive', { tag: 'third' }, {
    parameterNames: ['tag'],
    hostInvocationContext: thirdToken,
  });
  await parked.promise;
  assertEquals(captured.waiters[0].context.id, firstContext.id);
  assertStrictEquals(firstContext.hostInvocationContext, undefined);
  assertStrictEquals(captured.waiters[0].context.hostInvocationContext, thirdToken);
  captured.waiters[0].resolve(null);
  assertEquals(await pending, null);
  await closeRuntime(built);
});

Deno.test('hostInvocationContext: thrown export clears the association', async () => {
  const captured = freshCaptured();
  const built = await buildAttributionRuntime(captured);
  const token = { path: 'throw' };
  await assertRejects(
    () => built.runtime.invokeExport('throwing', { tag: 't' }, {
      parameterNames: ['tag'],
      hostInvocationContext: token,
    }),
    Error,
    'deliberate failure',
  );
  assertStrictEquals(captured.observations[0].value, token);
  assertStrictEquals(captured.contexts[0].hostInvocationContext, undefined);
  await closeRuntime(built);
});

Deno.test('hostInvocationContext: result-marshalling failure clears the association', async () => {
  const captured = freshCaptured();
  const built = await buildAttributionRuntime(captured);
  const token = { path: 'invalid-result' };
  await assertRejects(
    () => built.runtime.invokeExport('invalidResult', { tag: 'i' }, {
      parameterNames: ['tag'],
      hostInvocationContext: token,
    }),
    ResultMarshallingError,
  );
  assertStrictEquals(captured.observations[0].value, token);
  assertStrictEquals(captured.contexts[0].hostInvocationContext, undefined);
  await closeRuntime(built);
});

Deno.test('hostInvocationContext: abort mid-suspension clears the association', async () => {
  const captured = freshCaptured();
  const built = await buildAttributionRuntime(captured);
  const token = { path: 'abort' };
  const controller = new AbortController();
  const parked = makeSignal();
  captured.onWait = parked.resolve;
  const pending = built.runtime.invokeExport('interactive', { tag: 'a' }, {
    parameterNames: ['tag'],
    hostInvocationContext: token,
    signal: controller.signal,
  });
  await parked.promise;
  assertStrictEquals(captured.waiters[0].context.hostInvocationContext, token);
  const reason = new Error('cancel attribution invocation');
  controller.abort(reason);
  await assertRejects(() => pending, Error, reason.message);
  assertStrictEquals(captured.waiters[0].context.hostInvocationContext, undefined);
  await closeRuntime(built);
});

Deno.test('hostInvocationContext: terminate mid-suspension clears the association', async () => {
  const captured = freshCaptured();
  const built = await buildAttributionRuntime(captured);
  const token = { path: 'terminate' };
  const parked = makeSignal();
  captured.onWait = parked.resolve;
  const pending = built.runtime.invokeExport('interactive', { tag: 't' }, {
    parameterNames: ['tag'],
    hostInvocationContext: token,
  }).then(
    (value) => ({ value }),
    (error) => ({ error }),
  );
  await parked.promise;
  assertStrictEquals(captured.waiters[0].context.hostInvocationContext, token);
  await built.runtime.terminate();
  assert((await pending).error instanceof Error);
  assertStrictEquals(captured.waiters[0].context.hostInvocationContext, undefined);
  built.channels.close();
});

Deno.test('hostInvocationContext: fuel pause and refill preserve the value', async () => {
  const captured = freshCaptured();
  const built = await buildRuntime(`
    export async function busyThenObserve(count, tag) {
      grant "attribution" {
        let index = 0
        while (index < count) { index = index + 1 }
        Attribution.observe(tag, "after-refill")
        return index
      } denied { return null }
    }
  `, (builder) => builder.capability(attributionCapability(captured)));
  built.runtime._fuel = 20;
  let paused = false;
  built.runtime.onFuelExhausted = () => {
    paused = true;
    return 100000;
  };
  const token = { path: 'fuel' };
  assertEquals(
    await built.runtime.invokeExport('busyThenObserve', { count: 500, tag: 'f' }, {
      parameterNames: ['count', 'tag'],
      hostInvocationContext: token,
    }),
    500,
  );
  assert(paused, 'the invocation must actually exhaust fuel');
  assertStrictEquals(captured.observations[0].value, token);
  await closeRuntime(built);
});

Deno.test('hostInvocationContext: quiesce-deferred invocation receives the right value on resume', async () => {
  const captured = freshCaptured();
  const built = await buildAttributionRuntime(captured);
  const token = { path: 'deferred' };
  await built.runtime.quiesce();
  const pending = built.runtime.invokeExport('oneShot', { tag: 'd' }, {
    parameterNames: ['tag'],
    hostInvocationContext: token,
  });
  await Promise.resolve();
  assertEquals(captured.observations.length, 0);
  built.runtime.resume();
  assertEquals(await pending, 'd');
  assertStrictEquals(captured.observations[0].value, token);
  await closeRuntime(built);
});

Deno.test('hostInvocationContext: cancellation before allocation never publishes the value', async () => {
  const captured = freshCaptured();
  const built = await buildAttributionRuntime(captured);
  const controller = new AbortController();
  await built.runtime.quiesce();
  const pending = built.runtime.invokeExport('oneShot', { tag: 'c' }, {
    parameterNames: ['tag'],
    hostInvocationContext: { path: 'never-published' },
    signal: controller.signal,
  });
  const reason = new Error('abort before allocation');
  controller.abort(reason);
  await assertRejects(() => pending, Error, reason.message);
  built.runtime.resume();
  // Drain any residual scheduling; no handler may ever have observed it.
  await built.runtime.invokeExport('oneShot', { tag: 'sentinel' }, {
    parameterNames: ['tag'],
  });
  assertEquals(captured.observations.length, 1);
  assertEquals(captured.observations[0].tag, 'sentinel');
  assertStrictEquals(captured.observations[0].value, undefined);
  await closeRuntime(built);
});

Deno.test('hostInvocationContext: scheduled and unrelated closure calls do not inherit the value', async () => {
  const captured = freshCaptured();
  const built = await buildAttributionRuntime(captured);
  const token = { path: 'root-only' };
  const parked = makeSignal();
  captured.onWait = parked.resolve;
  const pending = built.runtime.invokeExport('interactive', { tag: 'root' }, {
    parameterNames: ['tag'],
    hostInvocationContext: token,
  });
  await parked.promise;

  // A scheduled closure call while the attributed invocation is live.
  const scheduledHandle = built.session.registerExportClosure('oneShot');
  const observed = makeSignal();
  captured.onObserve = observed.resolve;
  built.runtime.scheduleClosureCall(scheduledHandle, ['scheduled'], {
    dropOnComplete: true,
  });
  await observed.promise;
  captured.onObserve = null;
  const scheduledObservation = captured.observations
    .find((observation) => observation.tag === 'scheduled');
  assertStrictEquals(scheduledObservation.value, undefined);

  // An unrelated invokeClosure without the option.
  const plainHandle = built.session.registerExportClosure('oneShot');
  assertEquals(
    await built.runtime.invokeClosure(plainHandle, ['plain'], { dropOnComplete: true }),
    'plain',
  );
  const plainObservation = captured.observations
    .find((observation) => observation.tag === 'plain');
  assertStrictEquals(plainObservation.value, undefined);

  captured.waiters[0].resolve('done');
  assertEquals(await pending, 'done');
  assertStrictEquals(
    captured.observations.find((observation) => observation.tag === 'root').value,
    token,
  );
  await closeRuntime(built);
});

Deno.test('hostInvocationContext: a nested export receives only its explicitly supplied value', async () => {
  const captured = freshCaptured();
  const built = await buildAttributionRuntime(captured);
  const parentToken = { invocation: 'parent' };
  const childToken = { invocation: 'child' };
  const parked = makeSignal();
  captured.onWait = parked.resolve;
  const parent = built.runtime.invokeExport('interactive', { tag: 'parent' }, {
    parameterNames: ['tag'],
    hostInvocationContext: parentToken,
  });
  await parked.promise;
  // The embedder starts a nested child export from the suspended parent's
  // capability boundary, supplying the child's own context explicitly.
  assertEquals(
    await built.runtime.invokeExport('oneShot', { tag: 'child' }, {
      parameterNames: ['tag'],
      hostInvocationContext: childToken,
    }),
    'child',
  );
  captured.waiters[0].resolve('parent-done');
  assertEquals(await parent, 'parent-done');
  const byTag = new Map(
    captured.observations.map((observation) => [observation.tag, observation]));
  assertStrictEquals(byTag.get('child').value, childToken);
  assertStrictEquals(byTag.get('parent').value, parentToken);
  await closeRuntime(built);
});

Deno.test('hostInvocationContext: snapshots contain no opaque value; restored roots stay cancelled and contextless', async () => {
  const captured = freshCaptured();
  // inlineSource persists the AST so the restored session recovers its
  // export map and can run fresh invocations after restore.
  const built = await buildRuntime(ATTRIBUTION_SOURCE, (builder) => builder
    .sessionOptions({ inlineSource: true })
    .capability(attributionCapability(captured)));
  const sentinel = 'HOST-INVOCATION-OPAQUE-7f3a2b';
  const token = { secret: sentinel };
  const parked = makeSignal();
  captured.onWait = parked.resolve;
  const pending = built.runtime.invokeExport('interactive', { tag: 'snap' }, {
    parameterNames: ['tag'],
    hostInvocationContext: token,
  }).then(
    (value) => ({ value }),
    (error) => ({ error }),
  );
  await parked.promise;
  await built.runtime.quiesce();
  const snapshot = built.snapshot();
  const decoder = new TextDecoder('latin1');
  assert(!decoder.decode(snapshot.vatBytes).includes(sentinel));
  assert(!decoder.decode(snapshot.membraneBytes).includes(sentinel));

  const restoredCaptured = freshCaptured();
  const restored = new RuntimeBuilder()
    .fromSnapshot(snapshot)
    .capability(attributionCapability(restoredCaptured))
    .onInboundMessage(() => {})
    .build();
  assertEquals(restored.runtime.cancelRestoredInvocationRoots(), 1);
  await restored.runtime.start();
  // The restored runtime attributes only what the embedder explicitly
  // supplies to new invocations — nothing is recovered or synthesized.
  const freshToken = { life: 'restored' };
  assertEquals(
    await restored.runtime.invokeExport('oneShot', { tag: 'fresh' }, {
      parameterNames: ['tag'],
      hostInvocationContext: freshToken,
    }),
    'fresh',
  );
  assertEquals(restoredCaptured.observations.length, 1);
  assertStrictEquals(restoredCaptured.observations[0].value, freshToken);
  await restored.runtime.terminate();
  restored.channels.close();

  built.runtime.resume();
  await built.runtime.terminate();
  assert((await pending).error instanceof Error);
  built.channels.close();
});

// --- Shell-epic acceptance fixtures -------------------------------------

// Invocation-bound standard streams: two concurrent interactive exports on
// one runtime; the host capability routes every read and write purely by
// context.hostInvocationContext (resolved inside the suspend async
// callback). No byte or EOF crosses between executions.
function streamsCapability(captured) {
  return {
    name: 'streams-host',
    needs: {},
    setup(airlock) {
      const handle = airlock.register({});
      airlock.setHandler(handle, 'read', ({ context }) => {
        if (context.hostInvocationContext === undefined) {
          throw new Error('standard input is not available for this invocation');
        }
        return context.suspend((resolve) => {
          // Routed inside the async callback — outside the handler's
          // synchronous extent — exactly how a stream capability operates.
          const queue = captured.queues.get(context.hostInvocationContext);
          if (queue.pending.length > 0) resolve(queue.pending.shift());
          else queue.readers.push(resolve);
          captured.onRead?.();
        });
      });
      airlock.setHandler(handle, 'write', ({ args, context }) => {
        captured.output.get(context.hostInvocationContext).push(args[0]);
        return null;
      });
      airlock.declare('Streams', handle);
      const grant = airlock.membrane.createGrant('streams');
      grant.add(handle);
      return {
        onGrantRequest(identifier) {
          return identifier === 'streams' ? grant : null;
        },
      };
    },
  };
}

const STREAMS_SOURCE = `
  export async function pump(count) {
    grant "streams" {
      let index = 0
      while (index < count) {
        let value = await Streams.read()
        Streams.write(value)
        index = index + 1
      }
      return index
    } denied { return null }
  }
  export async function readOnce() {
    grant "streams" {
      return await Streams.read()
    } denied { return null }
  }
`;

Deno.test('hostInvocationContext: invocation-bound streams never cross bytes between concurrent executions', async () => {
  const captured = {
    queues: new Map(),
    output: new Map(),
    onRead: null,
  };
  const built = await buildRuntime(
    STREAMS_SOURCE,
    (builder) => builder.capability(streamsCapability(captured)),
  );
  const tokenA = { stream: 'A' };
  const tokenB = { stream: 'B' };
  for (const token of [tokenA, tokenB]) {
    captured.queues.set(token, { pending: [], readers: [] });
    captured.output.set(token, []);
  }
  const feed = (token, value) => {
    const queue = captured.queues.get(token);
    if (queue.readers.length > 0) queue.readers.shift()(value);
    else queue.pending.push(value);
  };
  const awaitRead = async (start) => {
    const parked = makeSignal();
    captured.onRead = parked.resolve;
    start?.();
    await parked.promise;
    captured.onRead = null;
  };

  let pendingA, pendingB;
  await awaitRead(() => {
    pendingA = built.runtime.invokeExport('pump', { count: 2 }, {
      parameterNames: ['count'],
      hostInvocationContext: tokenA,
    });
  });
  await awaitRead(() => {
    pendingB = built.runtime.invokeExport('pump', { count: 2 }, {
      parameterNames: ['count'],
      hostInvocationContext: tokenB,
    });
  });
  // Adversarial interleaving: B advances first, A finishes first.
  await awaitRead(() => feed(tokenB, 'b1'));
  await awaitRead(() => feed(tokenA, 'a1'));
  feed(tokenA, 'a2');
  assertEquals(await pendingA, 2);
  feed(tokenB, 'b2');
  assertEquals(await pendingB, 2);
  assertEquals(captured.output.get(tokenA), ['a1', 'a2']);
  assertEquals(captured.output.get(tokenB), ['b1', 'b2']);
  await closeRuntime(built);
});

Deno.test('hostInvocationContext: one-shot invocation without a context is denied stream input by capability policy', async () => {
  const captured = {
    queues: new Map(),
    output: new Map(),
    onRead: null,
  };
  const built = await buildRuntime(
    STREAMS_SOURCE,
    (builder) => builder.capability(streamsCapability(captured)),
  );
  await assertRejects(
    () => built.runtime.invokeExport('readOnce', {}, { parameterNames: [] }),
    Error,
    'standard input is not available',
  );
  await closeRuntime(built);
});

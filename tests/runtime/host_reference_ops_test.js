/**
 * Host reference operations on a stub runtime that registers an
 * HTMLElement-shaped constructible external: getClosureProperty,
 * getObjectProperty, constructClosure, invokeClosureWithReceiver, release
 * operations, handler argument retention, and vat-handle reification.
 */

import {
  assert,
  assertEquals,
  assertRejects,
  assertStrictEquals,
  assertThrows,
} from 'https://deno.land/std@0.208.0/assert/mod.ts';
import { RuntimeBuilder } from '../../src/runtime/index.js';

/**
 * Boot a runtime with the dom stub capability, run `source` at the
 * top level, and wait for its `ready` flag (a top-level grant block
 * parks on the fanout and completes in the background).
 */
async function buildHarness(source, options = {}) {
  const state = {
    lifecycle: [],
    defined: null,
    kept: null,
    backing: null,
    hostContexts: [],
    newTargets: [],
  };
  const capability = {
    name: 'dom-host',
    needs: {},
    setup(airlock) {
      state.airlock = airlock;
      const html = airlock.register({});
      const registry = airlock.register({});
      const grant = airlock.membrane.createGrant('dom');
      grant.add(html);
      grant.add(registry);
      state.grant = grant;
      state.htmlHandle = html;
      airlock.setConstructible(html, {
        beginConstruction(newTarget, context) {
          state.newTargets.push(newTarget);
          state.lifecycle.push('begin');
          state.hostContexts.push(context?.hostInvocationContext);
          if (options.beginThrows) throw new Error('begin refused');
          const backing = airlock.register({ kind: 'element' });
          grant.add(backing);
          state.backing = backing;
          airlock.setHasProperty(backing, ({ name }) => name === 'attachShadow');
          airlock.setHandler(backing, 'attachShadow', ({ args }) => {
            state.lifecycle.push(['attachShadow', args[0]]);
            return 'shadow';
          });
          return backing;
        },
        receiverMetadata() {
          state.receiverMetadataRequested = true;
          return options.receiverMetadata ?? null;
        },
        completeConstruction(backingHandle, receiverObjectHandle) {
          state.lifecycle.push('complete');
          state.completedReceiver = receiverObjectHandle;
        },
        abortConstruction() {
          state.lifecycle.push('abort');
        },
      });
      airlock.setHandler(registry, 'define', ({ args }) => {
        state.defined = args[0];
        return null;
      });
      airlock.setHandler(registry, 'keep', ({ args }) => {
        state.kept = args[0];
        return null;
      }, { retainObjectArgumentIndexes: [0] });
      airlock.setHandler(registry, 'giveBack', () => state.kept);
      airlock.setHandler(registry, 'giveBackClass', () => state.defined);
      airlock.declare('HTMLElement', html);
      airlock.declare('registry', registry);
      return {
        onGrantRequest(identifier) {
          return identifier === 'dom' ? grant : null;
        },
      };
    },
  };
  const built = new RuntimeBuilder()
    .onInboundMessage(() => {})
    .capability(capability)
    .build();
  await built.runtime.start();
  built.session.parse(source);
  await built.runtime.run(0);
  for (let i = 0; i < 200 && built.session.get(0, 'ready') !== true; i++) {
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assertEquals(built.session.get(0, 'ready'), true, 'top-level grant body never completed');
  return { ...built, state };
}

async function closeHarness(built) {
  await built.runtime.terminate();
  built.channels.close();
}

const PANEL_SOURCE = `
  let ready = false;
  grant "dom" {
    class StatusPanel extends HTMLElement {
      static observedAttributes = ["status", "level"];
      static get themeName() { return "dark"; }
      constructor() {
        super();
        this.label = "fresh";
        this.shadowRootRef = this.attachShadow("open");
      }
      connectedCallback() {
        this.label = "connected";
      }
    }
    registry.define(StatusPanel);
    ready = true;
  } denied {}
`;

// =============================================================================
// Static reads
// =============================================================================

Deno.test('host reference ops: static array converts to a string sequence', async () => {
  const built = await buildHarness(PANEL_SOURCE);
  const attrs = await built.runtime.getClosureProperty(
    built.state.defined, 'observedAttributes',
    { resultConversion: 'iterable-string-sequence' });
  assertEquals(attrs, ['status', 'level']);
  await closeHarness(built);
});

Deno.test('host reference ops: a custom iterable static converts to strings', async () => {
  const built = await buildHarness(`
    let ready = false;
    grant "dom" {
      class Iterish extends HTMLElement {
        static observedAttributes = {
          [Symbol.iterator]() {
            let n = 0;
            return { next() { n = n + 1; return { value: n * 10, done: n > 3 }; } };
          }
        };
      }
      registry.define(Iterish);
      ready = true;
    } denied {}
  `);
  const attrs = await built.runtime.getClosureProperty(
    built.state.defined, 'observedAttributes',
    { resultConversion: 'iterable-string-sequence' });
  assertEquals(attrs, ['10', '20', '30']);
  await closeHarness(built);
});

Deno.test('host reference ops: static getter runs with the class as receiver; misses stay undefined', async () => {
  const built = await buildHarness(PANEL_SOURCE);
  assertEquals(await built.runtime.getClosureProperty(built.state.defined, 'themeName'), 'dark');
  assertEquals(await built.runtime.getClosureProperty(built.state.defined, 'absent'), undefined);
  assertEquals(await built.runtime.getClosureProperty(
    built.state.defined, 'absent', { resultConversion: 'iterable-string-sequence' }), undefined);
  await closeHarness(built);
});

Deno.test('host reference ops: prototype callbacks read as stable closure handles', async () => {
  const built = await buildHarness(PANEL_SOURCE);
  const runtime = built.runtime;
  const airlock = built.state.airlock;
  const prototypeHandle = await runtime.getClosureProperty(built.state.defined, 'prototype');
  const first = await runtime.getObjectProperty(prototypeHandle, 'connectedCallback');
  const second = await runtime.getObjectProperty(prototypeHandle, 'connectedCallback');
  // Stability = both handles reference the same vat closure.
  assertEquals(airlock.getClosurePointer(first), airlock.getClosurePointer(second));
  runtime.releaseClosureHandle(first);
  runtime.releaseClosureHandle(second);
  runtime.releaseObjectHandle(prototypeHandle);
  await closeHarness(built);
});

// =============================================================================
// Host construction and receiver invocation
// =============================================================================

Deno.test('host reference ops: construction runs begin, forwarding, and complete in order', async () => {
  const built = await buildHarness(PANEL_SOURCE);
  const instance = await built.runtime.constructClosure(built.state.defined, []);
  assertEquals(built.state.lifecycle, ['begin', ['attachShadow', 'open'], 'complete']);
  // completeConstruction saw the same interned handle the caller got.
  assertStrictEquals(built.state.completedReceiver, instance);
  assertEquals(await built.runtime.getObjectProperty(instance, 'label'), 'fresh');
  built.runtime.releaseObjectHandle(instance);
  await closeHarness(built);
});

Deno.test('host reference ops: construction persists host metadata on the receiver', async () => {
  const metadata = { kind: 'custom-element-instance', resourceIdentifier: 7 };
  const built = await buildHarness(PANEL_SOURCE, { receiverMetadata: metadata });
  const instance = await built.runtime.constructClosure(built.state.defined, []);
  assertEquals(built.state.receiverMetadataRequested, true);
  assertEquals(built.state.completedReceiver.metadata, metadata);
  built.runtime.releaseObjectHandle(instance);
  await closeHarness(built);
});

Deno.test('host reference ops: construction lends retained constructor identity to beginConstruction', async () => {
  const built = await buildHarness(PANEL_SOURCE);
  const constructorHandle = built.state.defined;
  const definedIdentity = `${constructorHandle.slot}:${constructorHandle.version}`;
  assertEquals(definedIdentity, '0:1',
    'fixture must reproduce the original retained constructor identity');
  const closureCount = built.state.airlock.membrane
    .enumerateClosureHandles().length;

  const instance = await built.runtime.constructClosure(constructorHandle, []);
  const beginTarget = built.state.newTargets[0];
  assertStrictEquals(beginTarget, constructorHandle);
  assertEquals(`${beginTarget.slot}:${beginTarget.version}`, '0:1',
    'beginConstruction must not receive the former second capture at 1:1');
  assertEquals(
    built.state.airlock.membrane.enumerateClosureHandles().length,
    closureCount,
    'construction must not allocate another closure-handle slot');

  built.runtime.releaseObjectHandle(instance);
  await closeHarness(built);
});

Deno.test('host reference ops: source construction reuses the retained constructor identity', async () => {
  const source = PANEL_SOURCE.replace(
    'ready = true;',
    'ready = true; instance = new StatusPanel();',
  );
  const built = await buildHarness(source);
  assertStrictEquals(built.state.newTargets[0], built.state.defined);
  assertEquals(
    `${built.state.newTargets[0].slot}:${built.state.newTargets[0].version}`,
    `${built.state.defined.slot}:${built.state.defined.version}`,
  );
  built.runtime.releaseObjectHandle(built.state.completedReceiver);
  await closeHarness(built);
});

Deno.test('host reference ops: compacted constructor keeps retained identity at beginConstruction', async () => {
  const discardedAllocations = Array.from(
    { length: 64 },
    (_, index) => `discarded = { value: ${index} };`,
  ).join('\n');
  const built = await buildHarness(`
    let ready = false;
    grant "dom" {
      let discarded = null;
      ${discardedAllocations}
      discarded = null;
      class CompactedPanel extends HTMLElement {
        constructor() { super(); }
      }
      registry.define(CompactedPanel);
      ready = true;
    } denied {}
  `);
  const constructorHandle = built.state.defined;
  const pointerBeforeCompaction = constructorHandle.closurePointer;
  built.session.gc();
  assert(
    constructorHandle.closurePointer !== pointerBeforeCompaction,
    'fixture must relocate the retained constructor during compaction',
  );

  const instance = await built.runtime.constructClosure(constructorHandle, []);
  assertStrictEquals(built.state.newTargets[0], constructorHandle);
  assertEquals(
    `${built.state.newTargets[0].slot}:${built.state.newTargets[0].version}`,
    `${constructorHandle.slot}:${constructorHandle.version}`,
  );

  built.runtime.releaseObjectHandle(instance);
  await closeHarness(built);
});

Deno.test('host reference ops: receiver invocation runs callbacks on the original instance', async () => {
  const built = await buildHarness(PANEL_SOURCE);
  const runtime = built.runtime;
  const instance = await runtime.constructClosure(built.state.defined, []);
  const connected = await runtime.getObjectProperty(instance, 'connectedCallback');
  await runtime.invokeClosureWithReceiver(connected, instance, []);
  assertEquals(await runtime.getObjectProperty(instance, 'label'), 'connected');
  runtime.releaseClosureHandle(connected);
  runtime.releaseObjectHandle(instance);
  await closeHarness(built);
});

Deno.test('host reference ops: an external handle serves as the callback receiver', async () => {
  const built = await buildHarness(`
    let ready = false;
    let seen = null;
    grant "dom" {
      registry.define(function () { seen = this.probe(); return seen; });
      ready = true;
    } denied {}
  `);
  const airlock = built.state.airlock;
  const target = airlock.register({});
  built.state.grant.add(target);
  airlock.setHandler(target, 'probe', () => 'external-this');
  const result = await built.runtime.invokeClosureWithReceiver(
    built.state.defined, target, []);
  assertEquals(result, 'external-this');
  await closeHarness(built);
});

Deno.test('host reference ops: a begin refusal aborts nothing and rejects the construction', async () => {
  const built = await buildHarness(PANEL_SOURCE, { beginThrows: true });
  await assertRejects(
    () => built.runtime.constructClosure(built.state.defined, []),
    Error, 'begin refused');
  assertEquals(built.state.lifecycle, ['begin']);
  await closeHarness(built);
});

Deno.test('host reference ops: two concurrent constructions keep their own host contexts', async () => {
  const built = await buildHarness(PANEL_SOURCE);
  const [a, b] = await Promise.all([
    built.runtime.constructClosure(built.state.defined, [], { hostInvocationContext: 'ctx-a' }),
    built.runtime.constructClosure(built.state.defined, [], { hostInvocationContext: 'ctx-b' }),
  ]);
  assertEquals([...built.state.hostContexts].sort(), ['ctx-a', 'ctx-b']);
  built.runtime.releaseObjectHandle(a);
  built.runtime.releaseObjectHandle(b);
  await closeHarness(built);
});

// =============================================================================
// Retention, reification, release
// =============================================================================

Deno.test('host reference ops: retained arguments reify back by identity', async () => {
  const built = await buildHarness(`
    let ready = false;
    let identityMatch = null;
    grant "dom" {
      const kept = { marker: 41 };
      registry.keep(kept);
      identityMatch = (registry.giveBack() === kept);
      ready = true;
    } denied {}
  `);
  assertEquals(built.session.get(0, 'identityMatch'), true);
  assert(built.state.kept?.constructor?.name === 'ObjectHandle');
  built.runtime.releaseObjectHandle(built.state.kept);
  await closeHarness(built);
});

Deno.test('host reference ops: a returned closure handle reifies as the registered class', async () => {
  const built = await buildHarness(`
    let ready = false;
    let classMatch = null;
    grant "dom" {
      class Widget extends HTMLElement {}
      registry.define(Widget);
      classMatch = (registry.giveBackClass() === Widget);
      ready = true;
    } denied {}
  `);
  assertEquals(built.session.get(0, 'classMatch'), true);
  await closeHarness(built);
});

Deno.test('host reference ops: retention interning preserves exact root counts', async () => {
  const built = await buildHarness(PANEL_SOURCE);
  const runtime = built.runtime;
  const airlock = built.state.airlock;
  const instance = await runtime.constructClosure(built.state.defined, []);
  const baseline = instance.retainCount;
  const again = airlock.retainObject(
    airlock.getObjectPointer(instance) && instance.objectPointer, 0);
  assertStrictEquals(again, instance, 'repeated retention returns the interned wrapper');
  assertEquals(instance.retainCount, baseline + 1);
  runtime.releaseObjectHandle(instance);
  assertEquals(instance.retainCount, baseline);
  runtime.releaseObjectHandle(instance);
  await closeHarness(built);
});

Deno.test('host reference ops: released and stale handles throw', async () => {
  const built = await buildHarness(PANEL_SOURCE);
  const runtime = built.runtime;
  const instance = await runtime.constructClosure(built.state.defined, []);
  const connected = await runtime.getObjectProperty(instance, 'connectedCallback');
  runtime.releaseClosureHandle(connected);
  assertThrows(() => runtime.releaseClosureHandle(connected), TypeError, 'released');
  await assertRejects(
    () => runtime.invokeClosureWithReceiver(connected, instance, []),
    Error);
  runtime.releaseObjectHandle(instance);
  assertThrows(() => runtime.releaseObjectHandle(instance));
  await assertRejects(
    () => runtime.getObjectProperty(instance, 'label'),
    TypeError, 'released');
  await assertRejects(
    () => runtime.invokeClosureWithReceiver(built.state.defined, 42, []),
    TypeError, 'ObjectHandle or a Handle');
  await closeHarness(built);
});

// =============================================================================
// Snapshot / restore
// =============================================================================

Deno.test('host reference ops: retained handles, registrations, and surrogates survive restore', async () => {
  const built = await buildHarness(PANEL_SOURCE);
  const instance = await built.runtime.constructClosure(built.state.defined, []);
  const snapshotBytes = built.snapshot();
  await closeHarness(built);

  const restoredState = { lifecycle: [] };
  const restored = new RuntimeBuilder()
    .fromSnapshot({
      vatBytes: snapshotBytes.vatBytes,
      membraneBytes: snapshotBytes.membraneBytes,
    })
    .onInboundMessage(() => {})
    .build();
  const airlock = restored.session.airlock;
  // The membrane remembers WHICH handle is constructible and its
  // surrogate; the capability must re-register the handlers.
  const constructibleSlots = airlock.membrane.constructibleHandleSlots();
  assertEquals(constructibleSlots.length, 1);
  const objectHandles = airlock.membrane.enumerateObjectHandles();
  assert(objectHandles.length >= 1, 'retained object handle survived restore');
  airlock.setConstructible(
    airlock.membrane.handleForSlot(constructibleSlots[0]), {
      beginConstruction() {
        restoredState.lifecycle.push('begin');
        const backing = airlock.register({});
        // The backing must share a grant with the parent handle.
        const grants = airlock.membrane._readHandleGrantSet(constructibleSlots[0]);
        for (const grantSlot of grants) {
          airlock.membrane.addHandleToGrantSlot?.(grantSlot, backing.slot);
        }
        return backing;
      },
      completeConstruction() { restoredState.lifecycle.push('complete'); },
      abortConstruction() { restoredState.lifecycle.push('abort'); },
    });
  await restored.runtime.start();
  void instance;
  await restored.runtime.terminate();
  restored.channels.close();
});

Deno.test('host reference ops: restored constructor keeps retained identity at beginConstruction', async () => {
  const built = await buildHarness(PANEL_SOURCE);
  const definedIdentity = {
    slot: built.state.defined.slot,
    version: built.state.defined.version,
  };
  const snapshotBytes = built.snapshot();
  await closeHarness(built);

  const restored = new RuntimeBuilder()
    .fromSnapshot({
      vatBytes: snapshotBytes.vatBytes,
      membraneBytes: snapshotBytes.membraneBytes,
    })
    .onInboundMessage(() => {})
    .build();
  const airlock = restored.session.airlock;
  const restoredConstructor = airlock.enumerateClosureHandles()
    .find(({ closureHandle }) =>
      closureHandle.slot === definedIdentity.slot
      && closureHandle.version === definedIdentity.version)
    ?.closureHandle;
  assert(restoredConstructor, 'retained constructor must survive restore');
  const constructibleSlot = airlock.membrane.constructibleHandleSlots()[0];
  let beginTarget = null;
  airlock.setConstructible(
    airlock.membrane.handleForSlot(constructibleSlot), {
      beginConstruction(newTarget) {
        beginTarget = newTarget;
        const backing = airlock.register({});
        for (const grantSlot of airlock.membrane
          ._readHandleGrantSet(constructibleSlot)) {
          airlock.membrane.grantForSlot(grantSlot).add(backing);
        }
        airlock.setHasProperty(
          backing, ({ name }) => name === 'attachShadow');
        airlock.setHandler(backing, 'attachShadow', () => 'shadow');
        return backing;
      },
      completeConstruction() {},
      abortConstruction() {},
    });

  await restored.runtime.start();
  const instance = await restored.runtime.constructClosure(
    restoredConstructor, []);
  assertStrictEquals(beginTarget, restoredConstructor);
  assertEquals(
    { slot: beginTarget.slot, version: beginTarget.version },
    definedIdentity,
  );

  restored.runtime.releaseObjectHandle(instance);
  restored.runtime.releaseClosureHandle(restoredConstructor);
  await restored.runtime.terminate();
  restored.channels.close();
});

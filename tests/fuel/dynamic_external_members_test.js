import {
  assertEquals,
  assertStringIncludes,
} from "https://deno.land/std@0.208.0/assert/mod.ts";
import { parseAndSetup } from './test-helpers.js';
import {
  freshSession,
  restoreSession,
  snapshotSession,
} from '../../src/host-owned-session.js';

function runToDone(session, source) {
  parseAndSetup(session, source);
  const result = session.run(0, 500000);
  assertEquals(result.status, 'done', JSON.stringify(result));
}

function grantAndDeclare(airlock, name, handle) {
  const grant = airlock.createRootGrant(`test:${name}`);
  grant.add(handle);
  airlock.declare(name, handle);
  return grant;
}

function registerDynamicSurface(
  airlock,
  handle,
  state,
  classifications,
  trace = [],
) {
  airlock.setMemberInspector(handle, ({ name }) => {
    trace.push(['inspect', name]);
    return classifications[name] ?? { kind: 'absent' };
  });
  airlock.setDefaultGetter(handle, ({ name }) => {
    trace.push(['get', name]);
    return state[name];
  });
  airlock.setDefaultSetter(handle, ({ propName, value }) => {
    trace.push(['set', propName, value]);
    state[propName] = value;
  });
  airlock.setDefaultHandler(handle, ({ args, context }) => {
    trace.push(['call', context.method, args]);
    return `${context.method}:${args.join(':')}`;
  });
  return trace;
}

Deno.test('dynamic members: plain external dispatches data, methods, absence, and writability', () => {
  const session = freshSession();
  const handle = session.airlock.register({});
  grantAndDeclare(session.airlock, 'Host', handle);
  const state = {
    readable: 'read-value',
    writable: 'before',
    readOnly: 'fixed',
  };
  const trace = registerDynamicSurface(session.airlock, handle, state, {
    readable: { kind: 'data', writable: false },
    writable: { kind: 'data', writable: true },
    readOnly: { kind: 'data', writable: false },
    action: { kind: 'method' },
  });

  runToDone(session, `
    const readable = Host.readable;
    const before = Host.writable;
    const assigned = (Host.writable = "after");
    const after = Host.writable;
    const called = Host.action("x", 2);
    const missing = Host.missing === undefined;
    let readOnlyMessage = "";
    try { Host.readOnly = "changed"; }
    catch (error) { readOnlyMessage = error.message; }
  `);

  assertEquals(session.get(0, 'readable'), 'read-value');
  assertEquals(session.get(0, 'before'), 'before');
  assertEquals(session.get(0, 'assigned'), 'after');
  assertEquals(session.get(0, 'after'), 'after');
  assertEquals(session.get(0, 'called'), 'action:x:2');
  assertEquals(session.get(0, 'missing'), true);
  assertStringIncludes(session.get(0, 'readOnlyMessage'), 'read-only data property');
  assertEquals(state.readOnly, 'fixed');
  assertEquals(trace, [
    ['inspect', 'readable'],
    ['get', 'readable'],
    ['inspect', 'writable'],
    ['get', 'writable'],
    ['inspect', 'writable'],
    ['set', 'writable', 'after'],
    ['inspect', 'writable'],
    ['get', 'writable'],
    ['inspect', 'action'],
    ['call', 'action', ['x', 2]],
    ['inspect', 'missing'],
    ['inspect', 'readOnly'],
  ]);
});

Deno.test('dynamic members: branded backing uses classification before default adapters', () => {
  const session = freshSession();
  const { airlock } = session;
  const grant = airlock.createRootGrant('test:branded');
  const parent = airlock.register({});
  const backing = airlock.register({});
  grant.add(parent);
  grant.add(backing);
  airlock.declare('HostElement', parent);

  const state = { title: 'before', readOnly: 'fixed' };
  const trace = registerDynamicSurface(airlock, backing, state, {
    title: { kind: 'data', writable: true },
    readOnly: { kind: 'data', writable: false },
    action: { kind: 'method' },
  });
  airlock.setConstructible(parent, {
    beginConstruction() { return backing; },
    completeConstruction() {},
    abortConstruction() {},
  });

  runToDone(session, `
    class Widget extends HostElement {
      constructor() {
        super();
        this.local = "vat-value";
      }
    }
    const widget = new Widget();
    const before = widget.title;
    const assigned = (widget.title = "after");
    const after = widget.title;
    const called = widget.action("b");
    const missing = widget.missing === undefined;
    const local = widget.local;
    const hasTitle = "title" in widget;
    const hasMissing = "missing" in widget;
    let readOnlyMessage = "";
    try { widget.readOnly = "changed"; }
    catch (error) { readOnlyMessage = error.message; }
  `);

  assertEquals(session.get(0, 'before'), 'before');
  assertEquals(session.get(0, 'assigned'), 'after');
  assertEquals(session.get(0, 'after'), 'after');
  assertEquals(session.get(0, 'called'), 'action:b');
  assertEquals(session.get(0, 'missing'), true);
  assertEquals(session.get(0, 'local'), 'vat-value');
  assertEquals(session.get(0, 'hasTitle'), true);
  assertEquals(session.get(0, 'hasMissing'), false);
  assertStringIncludes(session.get(0, 'readOnlyMessage'), 'read-only data property');
  assertEquals(state.readOnly, 'fixed');
  assertEquals(trace.some(([operation, name]) => operation === 'get' && name === 'action'), false);
  assertEquals(trace.some(([operation, name]) => operation === 'call' && name === 'action'), true);
});

Deno.test('dynamic members: a default getter cannot shadow a branded method', () => {
  const session = freshSession();
  const { airlock } = session;
  const grant = airlock.createRootGrant('test:branded-shadow');
  const parent = airlock.register({});
  const backing = airlock.register({});
  grant.add(parent);
  grant.add(backing);
  airlock.declare('HostElement', parent);

  airlock.setMemberInspector(backing, ({ name }) =>
    name === 'action' ? { kind: 'method' } : { kind: 'absent' });
  airlock.setDefaultGetter(backing, () => 'shadow-value');
  airlock.setDefaultHandler(backing, ({ context }) => `called:${context.method}`);
  // This legacy probe models the old branded dispatch precondition. The
  // inspector must choose the method before the default getter can run.
  airlock.setHasProperty(backing, () => true);
  airlock.setConstructible(parent, {
    beginConstruction() { return backing; },
    completeConstruction() {},
    abortConstruction() {},
  });

  runToDone(session, `
    class Widget extends HostElement {}
    const result = new Widget().action();
  `);

  assertEquals(session.get(0, 'result'), 'called:action');
});

Deno.test('dynamic members: exact getters and handlers precede the inspector', () => {
  const session = freshSession();
  const { airlock } = session;
  const handle = airlock.register({});
  grantAndDeclare(airlock, 'Host', handle);
  const inspected = [];

  airlock.setMemberInspector(handle, ({ name }) => {
    inspected.push(name);
    if (name === 'dynamicData') return { kind: 'data', writable: false };
    if (name === 'dynamicMethod') return { kind: 'method' };
    throw new Error(`inspector must not receive ${name}`);
  });
  airlock.setGetter(handle, 'exactData', () => 'exact-data');
  airlock.setHandler(handle, 'exactMethod', () => 'exact-method');
  airlock.setDefaultGetter(handle, ({ name }) => `default:${name}`);
  airlock.setDefaultHandler(handle, ({ context }) => `default-call:${context.method}`);

  runToDone(session, `
    const exactData = Host.exactData;
    const exactMethod = Host.exactMethod();
    const dynamicData = Host.dynamicData;
    const dynamicMethod = Host.dynamicMethod();
  `);

  assertEquals(session.get(0, 'exactData'), 'exact-data');
  assertEquals(session.get(0, 'exactMethod'), 'exact-method');
  assertEquals(session.get(0, 'dynamicData'), 'default:dynamicData');
  assertEquals(session.get(0, 'dynamicMethod'), 'default-call:dynamicMethod');
  assertEquals(inspected, ['dynamicData', 'dynamicMethod']);
});

Deno.test('dynamic members: unknown and malformed classifications throw loudly', () => {
  const session = freshSession();
  const { airlock } = session;
  const handle = airlock.register({});
  grantAndDeclare(airlock, 'Host', handle);
  airlock.setDefaultGetter(handle, () => 'must-not-run');
  airlock.setMemberInspector(handle, ({ name }) => {
    if (name === 'unknown') return { kind: 'callable' };
    if (name === 'missingWritable') return { kind: 'data' };
    return { kind: 'method', writable: false };
  });

  runToDone(session, `
    let unknownMessage = "";
    let missingWritableMessage = "";
    let additionalFieldMessage = "";
    try { Host.unknown; }
    catch (error) { unknownMessage = error.message; }
    try { Host.missingWritable; }
    catch (error) { missingWritableMessage = error.message; }
    try { Host.additionalField; }
    catch (error) { additionalFieldMessage = error.message; }
  `);

  assertStringIncludes(session.get(0, 'unknownMessage'), "unknown kind 'callable'");
  assertStringIncludes(session.get(0, 'missingWritableMessage'), 'returned malformed data');
  assertStringIncludes(session.get(0, 'additionalFieldMessage'), 'returned malformed method');
});

Deno.test('dynamic members: restore re-registers the inspector and adapters on the surviving handle', () => {
  const original = freshSession();
  const handle = original.airlock.register({}, { kind: 'dynamic-host' });
  grantAndDeclare(original.airlock, 'RestoredHost', handle);
  parseAndSetup(original, `
    const restoredData = RestoredHost.value;
    const restoredMethod = RestoredHost.action("restored");
  `);
  const snapshot = snapshotSession(original);

  const restored = restoreSession(snapshot.vatBytes, snapshot.membraneBytes);
  const entry = restored.airlock.membrane.enumerateHandles()
    .find((candidate) => candidate.metadata?.kind === 'dynamic-host');
  const state = { value: 'rebound-value' };
  registerDynamicSurface(restored.airlock, entry.handle, state, {
    value: { kind: 'data', writable: false },
    action: { kind: 'method' },
  });

  const result = restored.run(0, 500000);
  assertEquals(result.status, 'done', JSON.stringify(result));
  assertEquals(restored.get(0, 'restoredData'), 'rebound-value');
  assertEquals(restored.get(0, 'restoredMethod'), 'action:restored');
});

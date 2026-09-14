/**
 * Session-level class linking against a constructible external on a stub
 * host: three-phase construction, instanceof through the surrogate,
 * branded forwarding, and argument unwrapping.
 */

import { assert, assertEquals } from 'https://deno.land/std@0.208.0/assert/mod.ts';
import { parseAndSetup } from './test-helpers.js';
import { freshSession } from '../../src/host-owned-session.js';

/**
 * Build a session with an `HTMLElement`-shaped constructible external
 * plus a `registry` helper handle for logging and argument capture.
 * Every backing handle registers the complete forwarding surface.
 */
function buildHost(options = {}) {
  const session = freshSession();
  const airlock = session.airlock;
  const grant = airlock.createRootGrant('test:dom');
  const parent = airlock.register({});
  grant.add(parent);
  airlock.declare('HTMLElement', parent);

  const plain = airlock.register({});
  grant.add(plain);
  airlock.declare('PlainExternal', plain);

  const registry = airlock.register({});
  grant.add(registry);
  airlock.declare('registry', registry);

  const log = [];
  const backings = [];
  const received = [];
  airlock.setHandler(registry, 'log', ({ args }) => {
    log.push(args[0]);
    return null;
  });
  airlock.setHandler(registry, 'take', ({ args }) => {
    received.push(args[0]);
    return null;
  });

  const hostState = options.hostState ?? {};
  airlock.setConstructible(parent, {
    beginConstruction(newTarget) {
      log.push('begin');
      if (options.beginResult !== undefined) return options.beginResult;
      const backing = airlock.register({ kind: 'element' });
      grant.add(backing);
      backings.push(backing);
      airlock.setHasProperty(backing, ({ name }) =>
        name in hostState || name === 'hostMethod');
      // An exact getter, not a default getter: lookup checks exact getter,
      // default getter, then method binding, so a catch-all default getter
      // would shadow host methods.
      airlock.setGetter(backing, 'title', () => hostState.title);
      airlock.setDefaultSetter(backing, ({ propName, value }) => {
        hostState[propName] = value;
      });
      airlock.setDeleteProperty(backing, ({ name }) => {
        delete hostState[name];
        return true;
      });
      airlock.setHandler(backing, 'hostMethod', ({ args }) => {
        log.push(['hostMethod', ...args]);
        if (options.hostMethodThrows) throw new Error('host method failed');
        return 'host-result';
      });
      return backing;
    },
    completeConstruction() {
      log.push('complete');
      if (options.completeThrows) throw new Error('complete failed');
    },
    abortConstruction() {
      log.push('abort');
      if (options.abortThrows) throw new Error('abort failed');
    },
  });

  return { session, airlock, grant, parent, registry, log, backings, received, hostState };
}

function runToDone(session, source, fuel = 200000) {
  parseAndSetup(session, source);
  const run = session.run(0, fuel);
  assertEquals(run.status, 'done', `run failed: ${JSON.stringify(run)}`);
}

// =============================================================================
// Link and authority
// =============================================================================

Deno.test('extends-externals: a registered external parent links', () => {
  const host = buildHost();
  runToDone(host.session, `
    class Panel extends HTMLElement {}
    const linked = typeof Panel === "function";
  `);
  assertEquals(host.session.get(0, 'linked'), true);
});

Deno.test('extends-externals: an unregistered external parent throws the exact error', () => {
  const host = buildHost();
  runToDone(host.session, `
    let message = null;
    try { class Bad extends PlainExternal {} } catch (e) { message = e.message; }
  `);
  assertEquals(host.session.get(0, 'message'), 'This external cannot be extended');
});

Deno.test('extends-externals: a denied parent handle throws the membrane authorization error', () => {
  const session = freshSession();
  const airlock = session.airlock;
  // NOT a root grant, and the source never enters a grant block.
  const grant = airlock.membrane.createGrant('private');
  const parent = airlock.register({});
  grant.add(parent);
  airlock.declare('HTMLElement', parent);
  airlock.setConstructible(parent, {
    beginConstruction() { throw new Error('unreachable'); },
    completeConstruction() {},
    abortConstruction() {},
  });
  runToDone(session, `
    let message = null;
    try { class Bad extends HTMLElement {} } catch (e) { message = e.message; }
  `);
  assert(String(session.get(0, 'message')).includes('grant'),
    `expected a grant denial, got: ${session.get(0, 'message')}`);
});

Deno.test('extends-externals: two classes with one parent share one surrogate', () => {
  const host = buildHost();
  runToDone(host.session, `
    class A extends HTMLElement {}
    class B extends HTMLElement {}
    const sharedSurrogate =
      Object.getPrototypeOf(A.prototype) === Object.getPrototypeOf(B.prototype);
  `);
  assertEquals(host.session.get(0, 'sharedSurrogate'), true);
});

Deno.test('extends-externals: a static miss on the derived class stays in the vat', () => {
  const host = buildHost();
  runToDone(host.session, `
    class Panel extends HTMLElement {}
    const missing = Panel.someStatic === undefined;
  `);
  assertEquals(host.session.get(0, 'missing'), true);
  // No host operation ran for the static read: only the link happened.
  assertEquals(host.log.length, 0);
});

// =============================================================================
// Construction
// =============================================================================

Deno.test('extends-externals: default and user constructors call begin and complete once', () => {
  const host = buildHost();
  runToDone(host.session, `
    class Implicit extends HTMLElement {}
    class Explicit extends HTMLElement { constructor() { super(); } }
    const a = new Implicit();
    const b = new Explicit();
  `);
  assertEquals(host.log, ['begin', 'complete', 'begin', 'complete']);
});

Deno.test('extends-externals: begin precedes derived fields; completion follows the body', () => {
  const host = buildHost();
  runToDone(host.session, `
    class Panel extends HTMLElement {
      marker = registry.log("field");
      constructor() {
        super();
        registry.log("body");
      }
    }
    new Panel();
  `);
  assertEquals(host.log, ['begin', 'field', 'body', 'complete']);
});

Deno.test('extends-externals: new.target is the most-derived class across three levels', () => {
  const session = freshSession();
  const airlock = session.airlock;
  const grant = airlock.createRootGrant('test:dom');
  const parent = airlock.register({});
  grant.add(parent);
  airlock.declare('HTMLElement', parent);
  let newTargetName = null;
  airlock.setConstructible(parent, {
    beginConstruction(newTarget) {
      const mem = session.memoryImage;
      const nameProp = mem.objectFindOwnProperty(
        airlock.getClosurePointer(newTarget), mem.internString('name'));
      newTargetName = nameProp ? mem.readString(nameProp.lo) : null;
      const backing = airlock.register({});
      grant.add(backing);
      return backing;
    },
    completeConstruction() {},
    abortConstruction() {},
  });
  runToDone(session, `
    class Base extends HTMLElement {}
    class Mid extends Base {}
    class Leaf extends Mid {}
    new Leaf();
  `);
  assertEquals(newTargetName, 'Leaf');
});

Deno.test('extends-externals: a wrong begin result throws the exact error', () => {
  const host = buildHost({ beginResult: 42 });
  runToDone(host.session, `
    class Panel extends HTMLElement {}
    let message = null;
    try { new Panel(); } catch (e) { message = e.message; }
  `);
  assertEquals(host.session.get(0, 'message'), 'Construction returned no backing value');
  assertEquals(host.log, ['begin']);
});

Deno.test('extends-externals: an unbound registration throws Illegal constructor', () => {
  const host = buildHost();
  runToDone(host.session, `class Panel extends HTMLElement {}`);
  // Simulate a restored vat whose capability never re-registered the
  // construction handlers (the membrane flag survived; the JS maps did not).
  host.airlock.constructibleRegistrations.clear();
  parseAndSetup(host.session, `
    class Panel2 extends HTMLElement {}
    let message = null;
    try { new Panel2(); } catch (e) { message = e.message; }
  `);
  assertEquals(host.session.run(0, 200000).status, 'done');
  assertEquals(host.session.get(0, 'message'), 'Illegal constructor');
});

Deno.test('extends-externals: a different constructor result aborts and throws', () => {
  const host = buildHost();
  runToDone(host.session, `
    class Panel extends HTMLElement {
      constructor() { super(); return { impostor: true }; }
    }
    let message = null;
    try { new Panel(); } catch (e) { message = e.message; }
  `);
  assertEquals(host.session.get(0, 'message'), 'Constructor returned a different object');
  assertEquals(host.log, ['begin', 'abort']);
});

Deno.test('extends-externals: a constructor throw aborts once and stays catchable', () => {
  const host = buildHost();
  runToDone(host.session, `
    class Panel extends HTMLElement {
      constructor() { super(); throw new Error("body failed"); }
    }
    let message = null;
    try { new Panel(); } catch (e) { message = e.message; }
  `);
  assertEquals(host.session.get(0, 'message'), 'body failed');
  assertEquals(host.log, ['begin', 'abort']);
});

Deno.test('extends-externals: an abort failure becomes the reported error', () => {
  const host = buildHost({ abortThrows: true });
  // The abort duty drains at the dispatch-loop head, before the
  // entered catch executes; its failure supersedes the construction
  // failure and reaches the host as the terminal error.
  parseAndSetup(host.session, `
    class Panel extends HTMLElement {
      constructor() { super(); throw new Error("body failed"); }
    }
    try { new Panel(); } catch (e) {}
  `);
  let thrown = null;
  try {
    host.session.run(0, 200000);
  } catch (e) {
    thrown = e;
  }
  assert(thrown !== null, 'expected the abort failure to reach the host');
  assert(String(thrown.message).includes('abort failed'),
    `expected the abort failure, got: ${thrown.message}`);
  assertEquals(host.log, ['begin', 'abort']);
});

Deno.test('extends-externals: a second initialization of one receiver throws', () => {
  const host = buildHost();
  // A second TEXTUAL super() is a parse error ("Call super() exactly
  // once in a constructor"); a loop re-executes the single call site.
  runToDone(host.session, `
    class Panel extends HTMLElement {
      constructor() { for (let i = 0; i < 2; i = i + 1) { super(); } }
    }
    let message = null;
    try { new Panel(); } catch (e) { message = e.message; }
  `);
  assertEquals(host.session.get(0, 'message'), 'Receiver is already initialized');
  // The begin phase ran exactly once; the abandoned construction aborts.
  assertEquals(host.log.filter((e) => e === 'begin').length, 1);
});

Deno.test('extends-externals: nested constructions complete inner-first', () => {
  const host = buildHost();
  runToDone(host.session, `
    class Inner extends HTMLElement {}
    class Outer extends HTMLElement {
      constructor() {
        super();
        this.child = new Inner();
      }
    }
    new Outer();
  `);
  assertEquals(host.log, ['begin', 'begin', 'complete', 'complete']);
});

Deno.test('extends-externals: revocation prevents construction loudly', () => {
  const session = freshSession();
  const airlock = session.airlock;
  const grant = airlock.membrane.createGrant('dom');
  const parent = airlock.register({});
  grant.add(parent);
  airlock.declare('HTMLElement', parent);
  airlock.setConstructible(parent, {
    beginConstruction() { throw new Error('must not run'); },
    completeConstruction() {},
    abortConstruction() {},
  });
  airlock.onGrantRequest = (id) =>
    id === 'dom' ? { approved: true, grant } : { approved: false };
  runToDone(session, `
    let linked = false;
    grant "dom" { class Panel extends HTMLElement {} linked = true } denied {}
  `);
  assertEquals(session.get(0, 'linked'), true);
  airlock.membrane.revoke(grant);
  parseAndSetup(session, `
    let outcome = "unset";
    grant "dom" {
      class Panel2 extends HTMLElement {}
      outcome = "linked";
    } denied { outcome = "denied"; }
  `);
  const run = session.run(0, 200000);
  // A revoked grant must not authorize the link: either the fanout
  // denies or the link fails loudly — it never silently links.
  assert(session.get(0, 'outcome') !== 'linked',
    `revoked grant still linked (run: ${run.status})`);
});

// =============================================================================
// instanceof
// =============================================================================

Deno.test('extends-externals: instanceof answers through class and parent handle', () => {
  const host = buildHost();
  runToDone(host.session, `
    class Panel extends HTMLElement {}
    const p = new Panel();
    const ofClass = p instanceof Panel;
    const ofParent = p instanceof HTMLElement;
    const plainObject = ({}) instanceof HTMLElement;
  `);
  assertEquals(host.session.get(0, 'ofClass'), true);
  assertEquals(host.session.get(0, 'ofParent'), true);
  assertEquals(host.session.get(0, 'plainObject'), false);
});

Deno.test('extends-externals: instanceof a non-constructible external throws', () => {
  const host = buildHost();
  runToDone(host.session, `
    let message = null;
    try { const x = ({}) instanceof PlainExternal; } catch (e) { message = e.message; }
  `);
  assert(host.session.get(0, 'message') !== null);
});

// =============================================================================
// Branded forwarding
// =============================================================================

Deno.test('extends-externals: vat members take precedence; host surface forwards', () => {
  const host = buildHost({ hostState: { title: 'host-title' } });
  runToDone(host.session, `
    class Panel extends HTMLElement {
      #secret = "hidden";
      constructor() {
        super();
        this.name = "vat-name";     // vat expando (absent host-side)
        this.title = "vat-title";   // host-named: routed to the backing value
      }
      ping() { return "vat-ping"; }
      get vatProp() { return "vat-get"; }
      readSecret() { return this.#secret; }
    }
    const p = new Panel();
    const ping = p.ping();
    const vatProp = p.vatProp;
    const name = p.name;
    const title = p.title;
    const secret = p.readSecret();
    const hostMethod = p.hostMethod("a", 1);
    const inTitle = "title" in p;
    const inMissing = "nope" in p;
    const keys = Object.keys(p).join(",");
    const delTitle = delete p.title;
    const delName = delete p.name;
    const nameAfter = p.name === undefined;
  `);
  const s = host.session;
  assertEquals(s.get(0, 'ping'), 'vat-ping');
  assertEquals(s.get(0, 'vatProp'), 'vat-get');
  assertEquals(s.get(0, 'name'), 'vat-name');
  assertEquals(s.get(0, 'title'), 'vat-title');   // write reached the host, read forwards
  assertEquals(host.hostState.title, undefined);  // deleted through the host handler
  assertEquals(s.get(0, 'secret'), 'hidden');
  assertEquals(s.get(0, 'hostMethod'), 'host-result');
  assertEquals(host.log.filter((e) => Array.isArray(e)),
    [['hostMethod', 'a', 1]]);
  assertEquals(s.get(0, 'inTitle'), true);
  assertEquals(s.get(0, 'inMissing'), false);
  // Reflection reports only vat own entries; host names and hidden
  // '@' keys never appear.
  assertEquals(s.get(0, 'keys'), 'name');
  assertEquals(s.get(0, 'delTitle'), true);
  assertEquals(s.get(0, 'delName'), true);
  assertEquals(s.get(0, 'nameAfter'), true);
});

Deno.test('extends-externals: host method failure propagates as a catchable error', () => {
  const host = buildHost({ hostMethodThrows: true });
  runToDone(host.session, `
    class Panel extends HTMLElement { constructor() { super(); } }
    const p = new Panel();
    let message = null;
    try { p.hostMethod(); } catch (e) { message = e.message; }
  `);
  assertEquals(host.session.get(0, 'message'), 'host method failed');
});

Deno.test('extends-externals: forwarding survives a heap gc', () => {
  const host = buildHost({ hostState: { title: 'host-title' } });
  runToDone(host.session, `
    class Panel extends HTMLElement { constructor() { super(); } }
    const p = new Panel();
  `);
  host.session.gc();
  parseAndSetup(host.session, `
    class Panel2 extends HTMLElement { constructor() { super(); } }
    const q = new Panel2();
    const title = q.title;
  `);
  assertEquals(host.session.run(0, 200000).status, 'done');
  assertEquals(host.session.get(0, 'title'), 'host-title');
});

// =============================================================================
// Argument unwrapping
// =============================================================================

Deno.test('extends-externals: a branded instance unwraps to its backing handle', () => {
  const host = buildHost();
  runToDone(host.session, `
    class Panel extends HTMLElement { constructor() { super(); } }
    const p = new Panel();
    registry.take(p);
    registry.take({ ordinary: 1 });
  `);
  // The handler received the ORIGINAL backing implementation object by
  // identity, not a copy of the wrapper.
  assertEquals(host.received.length, 2);
  assertEquals(host.received[0], host.airlock.membrane.lookupBySlot(host.backings[0].slot));
  assertEquals(host.received[0].kind, 'element');
  assertEquals(host.received[1], { ordinary: 1 });
});

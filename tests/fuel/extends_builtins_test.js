/**
 * Classes extending built-in constructors.
 *
 * A class may extend the built-ins whose instances are plain objects:
 * the Error family (Error, TypeError, ReferenceError, RangeError,
 * SyntaxError) and Object. CLASS_LINK allowlists the parent by method
 * id; super() against a built-in parent initializes `this` in place
 * (Error: own `message`; Object: nothing) and pushes undefined; static
 * super access accepts a constructor-valued lookup start. Every other
 * built-in stays a catchable TypeError.
 *
 * Also pins two construct-flag regressions found while wiring this
 * feature: the synthesized default derived constructor and the base
 * ctor-with-fields trampoline both dropped the @newtarget propagation
 * flag from their CALL_METHOD_SPREAD emission.
 */

import { assert, assertEquals, assertThrows } from 'https://deno.land/std@0.208.0/assert/mod.ts';
import { parseAndSetup } from './test-helpers.js';
import { freshSession, restoreSession, snapshotSession } from '../../src/host-owned-session.js';

function run(source, session = freshSession({ inlineSource: true })) {
  parseAndSetup(session, source);
  const r = session.run(0, 500000);
  assertEquals(r.status, 'done', `run failed: ${JSON.stringify(r)}`);
  return session;
}

// =============================================================================
// Error-family parents
// =============================================================================

Deno.test('extends TypeError: explicit constructor, message, name, chain', () => {
  const s = run(`
    class ParseFault extends TypeError {
      constructor(where) {
        super('bad parse at ' + where);
        this.where = where;
      }
      describe() { return this.name + ': ' + this.message; }
    }
    let f = new ParseFault('line 3');
    let message = f.message;
    let where = f.where;
    let name = f.name;
    let described = f.describe();
    let ownKeys = Object.keys(f);
    let chain = [f instanceof ParseFault, f instanceof TypeError, f instanceof Error];
  `);
  assertEquals(s.get(0, 'message'), 'bad parse at line 3');
  assertEquals(s.get(0, 'where'), 'line 3');
  assertEquals(s.get(0, 'name'), 'TypeError');
  assertEquals(s.get(0, 'described'), 'TypeError: bad parse at line 3');
  assertEquals(s.get(0, 'ownKeys'), ['message', 'where']);
  assertEquals(s.get(0, 'chain'), [true, true, true]);
});

Deno.test('extends TypeError: synthesized default constructor forwards arguments', () => {
  const s = run(`
    class Fault extends TypeError {}
    let f = new Fault('boom');
    let message = f.message;
    let isType = f instanceof TypeError;
  `);
  assertEquals(s.get(0, 'message'), 'boom');
  assertEquals(s.get(0, 'isType'), true);
});

Deno.test('extends Error family: every member links and constructs', () => {
  const s = run(`
    class A extends Error { }
    class B extends ReferenceError { }
    class C extends RangeError { }
    class D extends SyntaxError { }
    let msgs = [new A('a').message, new B('b').message, new C('c').message, new D('d').message];
    let chain = [
      new A('a') instanceof Error,
      new B('b') instanceof ReferenceError,
      new C('c') instanceof RangeError,
      new D('d') instanceof SyntaxError
    ];
  `);
  assertEquals(s.get(0, 'msgs'), ['a', 'b', 'c', 'd']);
  assertEquals(s.get(0, 'chain'), [true, true, true, true]);
});

Deno.test('extends Error: super() without argument sets the empty message', () => {
  const s = run(`
    class Bare extends Error {
      constructor() { super(); }
    }
    let b = new Bare();
    let message = b.message;
    let ownKeys = Object.keys(b);
  `);
  assertEquals(s.get(0, 'message'), '');
  assertEquals(s.get(0, 'ownKeys'), ['message']);
});

Deno.test('extends Error: super(msg) converts a non-string argument', () => {
  const s = run(`
    class Coded extends Error {
      constructor(code) { super(code); }
    }
    let message = new Coded(404).message;
    let typeOf = typeof new Coded(404).message;
  `);
  assertEquals(s.get(0, 'message'), '404');
  assertEquals(s.get(0, 'typeOf'), 'string');
});

Deno.test('extends Error: super() evaluates to undefined and fields run after it', () => {
  const s = run(`
    class Layered extends Error {
      late = 'field';
      constructor() {
        this.early = 'pre-super';
        let superResult = super('mid');
        this.superResult = String(superResult);
      }
    }
    let l = new Layered();
    let shape = [l.early, l.message, l.late, l.superResult];
  `);
  assertEquals(s.get(0, 'shape'), ['pre-super', 'mid', 'field', 'undefined']);
});

Deno.test('extends TypeError: name field shadows the inherited name', () => {
  const s = run(`
    class NamedFault extends TypeError {
      name = 'NamedFault';
    }
    let n = new NamedFault('x');
    let name = n.name;
    let inheritedStillThere = new TypeError('y').name;
  `);
  assertEquals(s.get(0, 'name'), 'NamedFault');
  assertEquals(s.get(0, 'inheritedStillThere'), 'TypeError');
});

Deno.test('extends Error: three-level chain initializes through both super() hops', () => {
  const s = run(`
    class Mid extends Error {
      constructor(msg) {
        super('mid:' + msg);
        this.midSaw = msg;
      }
    }
    class Leaf extends Mid {
      constructor() {
        super('leaf');
        this.leaf = true;
      }
    }
    let l = new Leaf();
    let shape = [l.message, l.midSaw, l.leaf];
    let chain = [l instanceof Leaf, l instanceof Mid, l instanceof Error];
  `);
  assertEquals(s.get(0, 'shape'), ['mid:leaf', 'leaf', true]);
  assertEquals(s.get(0, 'chain'), [true, true, true]);
});

Deno.test('extends Error: thrown derived errors are catchable with intact state', () => {
  const s = run(`
    class Fault extends Error {
      constructor(msg, code) {
        super(msg);
        this.code = code;
      }
    }
    let caught = null;
    try { throw new Fault('boom', 7); } catch (e) {
      caught = [e.message, e.code, e instanceof Fault, e instanceof Error];
    }
  `);
  assertEquals(s.get(0, 'caught'), ['boom', 7, true, true]);
});

Deno.test('extends Error: an uncaught derived error reaches the host with its message', () => {
  const session = freshSession({ inlineSource: true });
  parseAndSetup(session, `
    class Fault extends Error { name = 'CustomFault'; }
    throw new Fault('escaped');
  `);
  const err = assertThrows(() => {
    const r = session.run(0, 500000);
    if (r.status !== 'done') throw new Error(`exit ${r.status}: ${JSON.stringify(r.error ?? r)}`);
  });
  assert(String(err.message).includes('escaped'), `host diagnostic missing message: ${err.message}`);
});

// =============================================================================
// Object parent
// =============================================================================

Deno.test('extends Object: super() is a no-op initialization', () => {
  const s = run(`
    class Bag extends Object {
      constructor() {
        super();
        this.kind = 'bag';
      }
    }
    let b = new Bag();
    let kind = b.kind;
    let ownKeys = Object.keys(b);
    let isBag = b instanceof Bag;
  `);
  assertEquals(s.get(0, 'kind'), 'bag');
  assertEquals(s.get(0, 'ownKeys'), ['kind']);
  assertEquals(s.get(0, 'isBag'), true);
});

Deno.test('extends Object: constructor-object statics inherit through the class', () => {
  const s = run(`
    class Bag extends Object {}
    let keysType = typeof Bag.keys;
    let works = Bag.keys({ a: 1, b: 2 });
  `);
  assertEquals(s.get(0, 'keysType'), 'function');
  assertEquals(s.get(0, 'works'), ['a', 'b']);
});

// =============================================================================
// Static super access with a constructor start
// =============================================================================

Deno.test('extends Object: static super reads the parent constructor entries', () => {
  const s = run(`
    class Bag extends Object {
      static probeKeys(o) { return super.keys(o); }
      static missing() { return super.noSuchStatic; }
    }
    let viaSuper = Bag.probeKeys({ x: 1 });
    let missType = typeof Bag.missing();
  `);
  assertEquals(s.get(0, 'viaSuper'), ['x']);
  assertEquals(s.get(0, 'missType'), 'undefined');
});

Deno.test('extends Error: static super write defines own on the class', () => {
  const s = run(`
    class Fault extends Error {
      static tag() { super.marker = 'tagged'; return Fault.marker; }
    }
    let tagged = Fault.tag();
    let notOnError = typeof Error.marker;
  `);
  assertEquals(s.get(0, 'tagged'), 'tagged');
  assertEquals(s.get(0, 'notOnError'), 'undefined');
});

// =============================================================================
// Rejections
// =============================================================================

Deno.test('extends of an exotic-instance built-in throws a catchable TypeError', () => {
  const s = run(`
    let rejections = [];
    try { class M extends Map {} } catch (e) { rejections.push(e.message); }
    try { class S extends Set {} } catch (e) { rejections.push(e.message); }
    try { class U extends Uint8Array {} } catch (e) { rejections.push(e.message); }
    try { class T extends String {} } catch (e) { rejections.push(e.message); }
    let allTypeErrors = rejections.length === 4;
  `);
  assertEquals(s.get(0, 'rejections'), [
    'This built-in cannot be extended',
    'This built-in cannot be extended',
    'This built-in cannot be extended',
    'This built-in cannot be extended'
  ]);
  assertEquals(s.get(0, 'allTypeErrors'), true);
});

Deno.test('extends rejection is a TypeError instance', () => {
  const s = run(`
    let kind = '';
    try { class M extends Map {} } catch (e) {
      kind = (e instanceof TypeError) + ':' + e.name;
    }
  `);
  assertEquals(s.get(0, 'kind'), 'true:TypeError');
});

// =============================================================================
// Construct-flag regressions (found wiring this feature)
// =============================================================================

Deno.test('new.target: synthesized default derived constructor propagates it', () => {
  const s = run(`
    class P { constructor() { this.nt = new.target === D; } }
    class D extends P {}
    let viaDefault = new D().nt;
  `);
  assertEquals(s.get(0, 'viaDefault'), true);
});

Deno.test('new.target: base constructor with fields sees the class', () => {
  const s = run(`
    class B {
      x = 1;
      constructor() { this.nt = new.target === B; }
    }
    let baseWithFields = new B().nt;
  `);
  assertEquals(s.get(0, 'baseWithFields'), true);
});

// =============================================================================
// Round-trips
// =============================================================================

Deno.test('extends Error: getSource round-trips and re-runs', () => {
  const source = `
    class Fault extends TypeError {
      constructor(where) {
        super('at ' + where);
        this.where = where;
      }
    }
    let m = new Fault('here').message;
  `;
  const s = run(source);
  assertEquals(s.get(0, 'm'), 'at here');
  const printed = s.getSource();
  assert(printed.includes('extends TypeError'), printed);
  const twin = run(printed);
  assertEquals(twin.get(0, 'm'), 'at here');
});

Deno.test('extends Error: classes and instances survive snapshot/restore', () => {
  const s = run(`
    class Fault extends Error {
      constructor(msg) { super(msg); }
      shout() { return this.message + '!'; }
    }
    let before = new Fault('persisted');
    let beforeMsg = before.shout();
  `);
  assertEquals(s.get(0, 'beforeMsg'), 'persisted!');
  const snap = snapshotSession(s);
  const restored = restoreSession(snap.vatBytes, snap.membraneBytes);
  parseAndSetup(restored, `
    let after = new Fault('revived');
    let afterShape = [after.shout(), after instanceof Fault, after instanceof Error, before.message];
  `);
  const r = restored.run(0, 500000);
  assertEquals(r.status, 'done', JSON.stringify(r));
  assertEquals(restored.get(0, 'afterShape'), ['revived!', true, true, 'persisted']);
});

Deno.test('extends Error: derived classes and instances survive gc', () => {
  const s = run(`
    class Fault extends TypeError {
      constructor(msg) { super(msg); this.kept = [1, 2, 3]; }
    }
    let f = new Fault('survives');
  `);
  s.gc();
  parseAndSetup(s, `
    let afterGc = [f.message, f.kept, f instanceof TypeError, new Fault('fresh').message];
  `);
  const r = s.run(0, 500000);
  assertEquals(r.status, 'done', JSON.stringify(r));
  assertEquals(s.get(0, 'afterGc'), ['survives', [1, 2, 3], true, 'fresh']);
});

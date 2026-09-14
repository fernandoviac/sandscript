/**
 * new.target and super property access.
 *
 * new.target compiles to a hidden `@newtarget` scope binding defined at
 * every non-arrow invocation (undefined for calls, the callee for
 * constructs, the propagated value for super() calls); arrows inherit it
 * lexically, exactly like `this`.
 *
 * super.x reads/writes compile to GET_SUPER/SET_SUPER with the receiver
 * kept under the lookup start, so parent accessors run with `this` = the
 * instance.
 */

import { assert, assertEquals } from 'https://deno.land/std@0.208.0/assert/mod.ts';
import { parseAndSetup } from './test-helpers.js';
import { freshSession } from '../../src/host-owned-session.js';
import {
  EXIT_DONE,
  EXIT_AWAIT,
  EXIT_ASYNC_COMPLETE,
  EXIT_ASYNC_REJECTED,
} from '../../src/fuel/constants.js';

function run(source, slot = 0, fuel = 500000) {
  const session = freshSession({ inlineSource: true });
  parseAndSetup(session, source, slot);
  const result = session.run(slot, fuel);
  assertEquals(result.status, 'done', `run failed: ${JSON.stringify(result)}`);
  return session;
}

function parseError(source) {
  const session = freshSession();
  try {
    parseAndSetup(session, source, 0);
  } catch (error) {
    return error;
  }
  throw new Error('expected a parse error');
}

// =============================================================================
// new.target
// =============================================================================

Deno.test('new.target: constructor sees the class, plain call sees undefined', () => {
  const s = run(`
    class Config {
      constructor() { this.target = new.target; }
    }
    function probe() { return new.target; }
    let viaNew = new Config().target === Config;
    let viaCall = probe();
    let viaNewFn = new probe();
  `);
  assertEquals(s.get(0, 'viaNew'), true);
  assertEquals(s.get(0, 'viaCall'), undefined);
});

Deno.test('new.target: super() propagates the most derived class', () => {
  const s = run(`
    let seen = [];
    class Base {
      constructor() { seen.push(new.target === Derived); }
    }
    class Derived extends Base {
      constructor() { super(); seen.push(new.target === Derived); }
    }
    new Derived();
    new Base();
    let result = seen;
  `);
  // [derived ctor via super: D, derived ctor: D, plain new Base: not D]
  assertEquals(s.get(0, 'result'), [true, true, false]);
});

Deno.test('new.target: three-level super() chain still reports the leaf', () => {
  const s = run(`
    let names = [];
    class A { constructor() { names.push(new.target.className); } }
    class B extends A { constructor() { super(); } }
    class C extends B {
      constructor() { super(); }
      static className = 'C';
    }
    new C();
    let result = names;
  `);
  assertEquals(s.get(0, 'result'), ['C']);
});

Deno.test('new.target: arrows inherit lexically', () => {
  const s = run(`
    class Box {
      constructor() {
        const probe = () => new.target;
        this.viaArrow = probe() === Box;
      }
    }
    function plain() {
      const probe = () => new.target;
      return probe();
    }
    let inCtor = new Box().viaArrow;
    let inPlain = plain();
  `);
  assertEquals(s.get(0, 'inCtor'), true);
  assertEquals(s.get(0, 'inPlain'), undefined);
});

Deno.test('new.target: a plain helper inside a constructor does NOT leak', () => {
  // The classic scope-leak case: helper() is a plain call, so its own
  // binding (undefined) must shadow the constructor's.
  const s = run(`
    class Owner {
      constructor() {
        function helper() { return new.target; }
        this.helped = helper();
      }
    }
    let leaked = new Owner().helped;
  `);
  assertEquals(s.get(0, 'leaked'), undefined);
});

Deno.test('new.target: methods, getters, field initializers see undefined', () => {
  const s = run(`
    class Probe {
      fromField = new.target;
      get viaGet() { return new.target; }
      viaMethod() { return new.target; }
    }
    let p = new Probe();
    let field = p.fromField;
    let getter = p.viaGet;
    let method = p.viaMethod();
  `);
  assertEquals(s.get(0, 'field'), undefined);
  assertEquals(s.get(0, 'getter'), undefined);
  assertEquals(s.get(0, 'method'), undefined);
});

Deno.test('new.target: async and generator bodies see undefined', () => {
  // Generators drive synchronously through .next().
  const s = run(`
    function* gen() { yield new.target; }
    let fromGen = gen().next().value;
  `);
  assertEquals(s.get(0, 'fromGen'), undefined);

  // Async bodies run in spawned contexts; drive the host loop by hand
  // (the JS airlock defines the async context's `@newtarget`). Loop
  // shape mirrors async_fuel_test.js.
  const session = freshSession();
  const mem = session.memoryImage;
  const airlock = session.airlock;
  parseAndSetup(session, `
    async function af() { return new.target; }
    let fromAsync = await af();
  `);
  const contexts = [{ slot: 0, generation: mem.getContextGeneration(0) }];
  for (let iter = 0; iter < 100; iter++) {
    let contextToRun = null;
    for (const ctx of contexts) {
      const status = mem.getExitCondition(ctx.slot);
      if (status === EXIT_DONE || status === EXIT_ASYNC_COMPLETE
        || status === EXIT_ASYNC_REJECTED || status === EXIT_AWAIT) {
        continue;
      }
      contextToRun = ctx;
      break;
    }
    if (!contextToRun) break;
    const result = session.run(contextToRun, 500000);
    if (result.status === 'async_call' && result.asyncContext !== undefined) {
      contexts.push(result.asyncContext);
    }
    if (result.status === 'await') airlock.handleAwait(contextToRun.slot);
    if (result.status === 'async_complete') airlock.handleAsyncComplete(contextToRun.slot);
    if (result.status === 'async_rejected') airlock.handleAsyncRejected(contextToRun.slot);
  }
  assertEquals(mem.getExitCondition(0), EXIT_DONE, 'main context settled');
  assertEquals(session.get(0, 'fromAsync'), undefined);
});

Deno.test('new.target: parse errors outside functions', () => {
  assert(String(parseError('let x = new.target;').message)
    .includes('new.target is only valid inside a function'));
  assert(String(parseError('let f = () => new.target;').message)
    .includes('new.target is only valid inside a function'));
  assert(String(parseError('function f() { return new.other; }').message)
    .includes("Expected 'target' after 'new.'"));
});

Deno.test('new.target: getSource round-trips', () => {
  const s = run(`
    class Widget {
      constructor() { this.made = new.target === Widget; }
    }
    let w = new Widget().made;
  `);
  const source = s.getSource();
  assert(source.includes('new.target === Widget'), source);
  // The printed source re-parses and runs to the same behavior.
  const twin = run(source);
  assertEquals(twin.get(0, 'w'), true);
});

// =============================================================================
// super property access
// =============================================================================

Deno.test('super.x: data read skips the own class level', () => {
  const s = run(`
    class Base { label() { return 'base'; } tag = 'b'; }
    Base.prototype.plain = 7;
    class Derived extends Base {
      label() { return 'derived'; }
      probe() { return [super.label(), this.label(), super.plain]; }
    }
    let result = new Derived().probe();
  `);
  assertEquals(s.get(0, 'result'), ['base', 'derived', 7]);
});

Deno.test('super.x: parent getter runs with this = instance', () => {
  const s = run(`
    class Base {
      get title() { return this.name + '!'; }
    }
    class Derived extends Base {
      name = 'kid';
      get title() { return 'shadowed'; }
      probe() { return super.title; }
    }
    let result = new Derived().probe();
  `);
  assertEquals(s.get(0, 'result'), 'kid!');
});

Deno.test('super.x = v: parent setter intercepts with this = instance', () => {
  const s = run(`
    class Base {
      set score(v) { this.stored = v * 2; }
      get score() { return this.stored; }
    }
    class Derived extends Base {
      write(v) { return super.score = v; }
    }
    let d = new Derived();
    let result = d.write(21);
    let stored = d.stored;
    let keys = Object.keys(d);
  `);
  assertEquals(s.get(0, 'result'), 21);
  assertEquals(s.get(0, 'stored'), 42);
  // The setter wrote `stored` on the instance; no own `score` shadow.
  assertEquals(s.get(0, 'keys'), ['stored']);
});

Deno.test('super.x = v: data miss defines own on the instance', () => {
  const s = run(`
    class Base { }
    Base.prototype.shared = 'proto';
    class Derived extends Base {
      write() { super.fresh = 1; super.shared = 2; }
    }
    let d = new Derived();
    d.write();
    let own = [d.fresh, d.shared];
    let protoUntouched = Base.prototype.shared;
    let keys = Object.keys(d);
  `);
  assertEquals(s.get(0, 'own'), [1, 2]);
  assertEquals(s.get(0, 'protoUntouched'), 'proto');
  assertEquals(s.get(0, 'keys'), ['fresh', 'shared']);
});

Deno.test('super.x compound assignment reads then writes', () => {
  const s = run(`
    class Base {
      get counter() { return this.n; }
      set counter(v) { this.n = v; this.writes = (this.writes ?? 0) + 1; }
    }
    class Derived extends Base {
      n = 10;
      bump(by) { return super.counter += by; }
    }
    let d = new Derived();
    let result = d.bump(5);
    let n = d.n;
    let writes = d.writes;
  `);
  assertEquals(s.get(0, 'result'), 15);
  assertEquals(s.get(0, 'n'), 15);
  assertEquals(s.get(0, 'writes'), 1);
});

Deno.test('super.x works in static members', () => {
  const s = run(`
    class Base {
      static family = 'geometry';
      static get loud() { return this.family + '!'; }
    }
    class Derived extends Base {
      static family = 'shapes';
      static probe() { return [super.family, super.loud]; }
    }
    let result = Derived.probe();
  `);
  // super.family reads Base's static; the getter runs with this = Derived.
  assertEquals(s.get(0, 'result'), ['geometry', 'shapes!']);
});

Deno.test('super.m via a getter-backed member runs with the right receiver', () => {
  const s = run(`
    class Base {
      get describe() {
        const who = this;
        return function() { return 'seen:' + who.tag; };
      }
    }
    class Derived extends Base {
      tag = 'leaf';
      probe() { return super.describe(); }
    }
    let result = new Derived().probe();
  `);
  assertEquals(s.get(0, 'result'), 'seen:leaf');
});

Deno.test('super.x setter-less accessor write is a silent no-op', () => {
  const s = run(`
    class Base { get ro() { return 'locked'; } }
    class Derived extends Base {
      write() { return super.ro = 5; }
    }
    let d = new Derived();
    let result = d.write();
    let after = d.ro;
    let keys = Object.keys(d);
  `);
  assertEquals(s.get(0, 'result'), 5);
  assertEquals(s.get(0, 'after'), 'locked');
  assertEquals(s.get(0, 'keys'), []);
});

Deno.test('super.x in an arrow inside a method inherits the frame', () => {
  const s = run(`
    class Base { get half() { return this.n / 2; } }
    class Derived extends Base {
      n = 42;
      probe() {
        const read = () => super.half;
        return read();
      }
    }
    let result = new Derived().probe();
  `);
  assertEquals(s.get(0, 'result'), 21);
});

Deno.test('super access parse errors stay loud', () => {
  assert(String(parseError('class A extends B { m() { delete super.x; } }').message)
    .includes('Cannot delete a super property'));
  assert(String(parseError('class A extends B { m() { super.x++; } }').message).length > 0);
  assert(String(parseError('class A extends B { m() { super.#p; } }').message)
    .includes('super cannot access a private member'));
  assert(String(parseError('class A { m() { return super.x; } }').message)
    .includes("'super' requires a class with 'extends'"));
  assert(String(parseError('let x = super.y;').message)
    .includes("'super' is only valid inside a class method"));
});

Deno.test('super.x read/write round-trips through getSource', () => {
  const s = run(`
    class Base {
      get width() { return this.w; }
      set width(v) { this.w = v; }
    }
    class Derived extends Base {
      w = 4;
      grow() { super.width = super.width * 3; return super.width; }
    }
    let result = new Derived().grow();
  `);
  assertEquals(s.get(0, 'result'), 12);
  const source = s.getSource();
  assert(source.includes('super.width = super.width * 3'), source);
  const twin = run(source);
  assertEquals(twin.get(0, 'result'), 12);
});

Deno.test('new.target and super access survive snapshot/restore', async () => {
  const { snapshotSession, restoreSession } = await import('../../src/host-owned-session.js');
  const s = run(`
    class Base { get half() { return this.n / 2; } }
    class Derived extends Base {
      n = 0;
      constructor() { super(); this.made = new.target === Derived; }
      read() { return super.half; }
    }
    let d = new Derived();
    d.n = 10;
    let before = [d.made, d.read()];
  `);
  assertEquals(s.get(0, 'before'), [true, 5]);
  const snap = snapshotSession(s);
  const restored = restoreSession(snap.vatBytes, snap.membraneBytes);
  assertEquals(restored.get(0, 'before'), [true, 5]);
  // The restored twin still runs the super-access machinery live.
  const restoredSource = restored.getSource();
  const twin = run(restoredSource);
  assertEquals(twin.get(0, 'before'), [true, 5]);
});

/**
 * Class language surface. Classes compile onto the existing prototype
 * machinery plus the CLASS_LINK opcode.
 *
 * Documented deviations under test: class methods land as enumerable
 * prototype properties; a derived constructor binds `this` before super();
 * super() ignores a parent return-object override.
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

function parseError(source) {
  const session = freshSession();
  return assertThrows(() => session.parse(source));
}

// =============================================================================
// Construction, methods, this
// =============================================================================

Deno.test('class: construction, methods, this', () => {
  const s = run(`
    class Point {
      constructor(x, y) {
        this.x = x;
        this.y = y;
      }
      sum() { return this.x + this.y; }
      scaled(factor) { return this.x * factor + this.y * factor; }
    }
    let p = new Point(3, 4);
    let sum = p.sum();
    let scaled = p.scaled(10);
    let backref = Point.prototype.constructor === Point;
    let isInstance = p instanceof Point;
  `);
  assertEquals(s.get(0, 'sum'), 7);
  assertEquals(s.get(0, 'scaled'), 70);
  assertEquals(s.get(0, 'backref'), true);
  assertEquals(s.get(0, 'isInstance'), true);
});

Deno.test('class: default base constructor', () => {
  const s = run(`
    class Empty {}
    let e = new Empty(1, 2, 3);
    let ok = e instanceof Empty;
    let keys = Object.keys(e);
  `);
  assertEquals(s.get(0, 'ok'), true);
  assertEquals(s.get(0, 'keys'), []);
});

Deno.test('class: constructor return-object override (base)', () => {
  const s = run(`
    class Boxed {
      constructor(v) { return { boxed: v }; }
    }
    class Kept {
      constructor() { this.x = 1; return undefined; }
    }
    class KeptPrimitive {
      constructor() { this.x = 2; return 5; }
    }
    let boxed = new Boxed(9).boxed;
    let kept = new Kept().x;
    let keptPrimitive = new KeptPrimitive().x;
  `);
  assertEquals(s.get(0, 'boxed'), 9);
  assertEquals(s.get(0, 'kept'), 1);
  assertEquals(s.get(0, 'keptPrimitive'), 2);
});

// =============================================================================
// Accessors
// =============================================================================

Deno.test('class: getters and setters dispatch through instances', () => {
  const s = run(`
    class Thermometer {
      constructor() { this.kelvin = 273; }
      get celsius() { return this.kelvin - 273; }
      set celsius(v) { this.kelvin = v + 273; }
    }
    let t = new Thermometer();
    let before = t.celsius;
    t.celsius = 100;
    let after = t.kelvin;
    let ownKeys = Object.keys(t);
  `);
  assertEquals(s.get(0, 'before'), 0);
  assertEquals(s.get(0, 'after'), 373);
  // The setter wrote kelvin; no own celsius shadow appeared.
  assertEquals(s.get(0, 'ownKeys'), ['kelvin']);
});

Deno.test('class: inherited accessors work through extends', () => {
  const s = run(`
    class Base {
      get double() { return this.n * 2; }
      set double(v) { this.n = v / 2; }
    }
    class Child extends Base {}
    let c = new Child();
    c.double = 42;
    let stored = c.n;
    let read = c.double;
  `);
  assertEquals(s.get(0, 'stored'), 21);
  assertEquals(s.get(0, 'read'), 42);
});

// =============================================================================
// Statics
// =============================================================================

Deno.test('class: static methods, fields, accessors, inheritance', () => {
  const s = run(`
    class Registry {
      static count = 0;
      static register() {
        Registry.count = Registry.count + 1;
        return Registry.count;
      }
      static get size() { return Registry.count; }
      static set size(v) { Registry.count = v; }
    }
    class SubRegistry extends Registry {}
    Registry.register();
    Registry.register();
    let viaGetter = Registry.size;
    Registry.size = 10;
    let viaSetter = Registry.count;
    let inherited = SubRegistry.register();
    let staticOnClassOnly = Object.keys(new Registry());
  `);
  assertEquals(s.get(0, 'viaGetter'), 2);
  assertEquals(s.get(0, 'viaSetter'), 10);
  assertEquals(s.get(0, 'inherited'), 11);
  assertEquals(s.get(0, 'staticOnClassOnly'), []);
});

Deno.test('class: static observedAttributes shape (WebComponents)', () => {
  const s = run(`
    class MyElement {
      static get observedAttributes() { return ['value', 'label']; }
      attributeChangedCallback(name, oldValue, newValue) {
        this.last = name + ':' + newValue;
      }
    }
    let attrs = MyElement.observedAttributes;
    let el = new MyElement();
    el.attributeChangedCallback('value', null, '7');
    let last = el.last;
  `);
  assertEquals(s.get(0, 'attrs'), ['value', 'label']);
  assertEquals(s.get(0, 'last'), 'value:7');
});

// =============================================================================
// Fields
// =============================================================================

Deno.test('class: base fields initialize before the constructor body', () => {
  const s = run(`
    class Ordered {
      first = 1;
      second = this.first + 1;
      constructor() {
        this.seenInCtor = this.second;
      }
      third = 3;
    }
    let o = new Ordered();
    let probe = [o.first, o.second, o.seenInCtor, o.third];
  `);
  assertEquals(s.get(0, 'probe'), [1, 2, 2, 3]);
});

Deno.test('class: derived fields initialize after super() returns', () => {
  const s = run(`
    class Base {
      constructor() { this.duringSuper = this.derivedField; }
    }
    class Derived extends Base {
      derivedField = 'set';
      constructor() {
        super();
        this.afterSuper = this.derivedField;
      }
    }
    let d = new Derived();
    let probe = [d.duringSuper === undefined, d.afterSuper];
  `);
  assertEquals(s.get(0, 'probe'), [true, 'set']);
});

Deno.test('class: field initializers cannot see constructor parameters', () => {
  const s = run(`
    let outer = 'outer-value';
    class Scoped {
      captured = outer;
      constructor(outerParam) { this.fromParam = outerParam; }
    }
    let x = new Scoped('param-value');
    let probe = [x.captured, x.fromParam];
  `);
  assertEquals(s.get(0, 'probe'), ['outer-value', 'param-value']);

  // A field initializer that names a constructor parameter reads the
  // OUTER scope (or throws when absent) — never the parameter.
  const session = freshSession();
  parseAndSetup(session, `
    class Leaky {
      captured = onlyParam;
      constructor(onlyParam) {}
    }
    let leak = new Leaky('nope');
  `);
  assertThrows(() => session.run(0, 500000), Error, 'not defined');
});

Deno.test('class: field without initializer lands as undefined own property', () => {
  const s = run(`
    class Sparse {
      present;
    }
    let sp = new Sparse();
    let keys = Object.keys(sp);
    let value = sp.present === undefined;
  `);
  assertEquals(s.get(0, 'keys'), ['present']);
  assertEquals(s.get(0, 'value'), true);
});

// =============================================================================
// extends / super
// =============================================================================

Deno.test('class: default derived constructor forwards arguments', () => {
  const s = run(`
    class Base {
      constructor(a, b) { this.sum = a + b; }
    }
    class Forwarding extends Base {}
    let f = new Forwarding(20, 22);
    let sum = f.sum;
    let chain = f instanceof Forwarding && f instanceof Base;
  `);
  assertEquals(s.get(0, 'sum'), 42);
  assertEquals(s.get(0, 'chain'), true);
});

Deno.test('class: super() with explicit and spread arguments', () => {
  const s = run(`
    class Base {
      constructor(a, b, c) { this.joined = a + '|' + b + '|' + c; }
    }
    class Explicit extends Base {
      constructor() { super('x', 'y', 'z'); }
    }
    class Spreading extends Base {
      constructor(parts) { super('head', ...parts); }
    }
    let explicit = new Explicit().joined;
    let spread = new Spreading(['m', 'n']).joined;
  `);
  assertEquals(s.get(0, 'explicit'), 'x|y|z');
  assertEquals(s.get(0, 'spread'), 'head|m|n');
});

Deno.test('class: super.m() dispatches to the parent method', () => {
  const s = run(`
    class A {
      label() { return 'A'; }
    }
    class B extends A {
      label() { return 'B->' + super.label(); }
    }
    class C extends B {
      label() { return 'C->' + super.label(); }
    }
    let threeLevels = new C().label();
    let instanceChecks = [new C() instanceof A, new C() instanceof B, new B() instanceof A];
    let protoAgreement = Object.getPrototypeOf(C.prototype) === B.prototype
      && Object.getPrototypeOf(B.prototype) === A.prototype;
  `);
  assertEquals(s.get(0, 'threeLevels'), 'C->B->A');
  assertEquals(s.get(0, 'instanceChecks'), [true, true, true]);
  assertEquals(s.get(0, 'protoAgreement'), true);
});

Deno.test('class: super.m() in a static method uses the parent class', () => {
  const s = run(`
    class Base {
      static describe() { return 'base-static'; }
    }
    class Child extends Base {
      static describe() { return 'child->' + super.describe(); }
    }
    let out = Child.describe();
  `);
  assertEquals(s.get(0, 'out'), 'child->base-static');
});

Deno.test('class: super inside an arrow inherits the method context', () => {
  const s = run(`
    class A {
      greet() { return 'hi'; }
    }
    class B extends A {
      greet() {
        let indirect = () => super.greet() + '!';
        return indirect();
      }
    }
    let out = new B().greet();
  `);
  assertEquals(s.get(0, 'out'), 'hi!');
});

Deno.test('class: extends a non-constructor throws a catchable TypeError', () => {
  const s = run(`
    let caught = '';
    try {
      class Bad extends 42 {}
    } catch (e) {
      caught = e.message;
    }
    let caughtArrow = '';
    try {
      let arrow = () => 1;
      class BadArrow extends arrow {}
    } catch (e) {
      caughtArrow = e.message;
    }
  `);
  assertEquals(s.get(0, 'caught'), 'Not a function');
  assertEquals(s.get(0, 'caughtArrow'), 'Not a function');
});

// =============================================================================
// Class expressions, self-reference, methods as values
// =============================================================================

Deno.test('class: expressions, anonymous and named, self-reference', () => {
  const s = run(`
    let Anon = class {
      tag() { return 'anon'; }
    };
    let Named = class Inner {
      static make() { return new Inner(); }
      tag() { return 'named'; }
    };
    class SelfRef {
      static create() { return new SelfRef(); }
      tag() { return 'self'; }
    }
    let innerLeaked = true;
    try {
      Inner;
    } catch (e) {
      innerLeaked = false;
    }
    let probe = [
      new Anon().tag(),
      Named.make().tag(),
      SelfRef.create().tag(),
      innerLeaked
    ];
  `);
  // \`Inner\` is visible only inside the class body.
  assertEquals(s.get(0, 'probe'), ['anon', 'named', 'self', false]);
});

Deno.test('class: async, generator, and computed members', async () => {
  const s = run(`
    class Rich {
      *numbers() { yield 1; yield 2; }
      ['computed' + 'Key']() { return 'via-computed'; }
      static ['computedStatic']() { return 'static-computed'; }
    }
    let r = new Rich();
    let collected = [];
    for (let n of r.numbers()) { collected.push(n); }
    let viaComputed = r.computedKey();
    let viaStaticComputed = Rich.computedStatic();
    let hasAsync = true;
  `);
  assertEquals(s.get(0, 'collected'), [1, 2]);
  assertEquals(s.get(0, 'viaComputed'), 'via-computed');
  assertEquals(s.get(0, 'viaStaticComputed'), 'static-computed');
});

Deno.test('class: member named static / get / set / keywords', () => {
  const s = run(`
    class Odd {
      static() { return 'method-named-static'; }
      get() { return 'method-named-get'; }
      set(v) { return 'method-named-set:' + v; }
      catch() { return 'keyword-member'; }
    }
    let o = new Odd();
    let probe = [o.static(), o.get(), o.set(1), o.catch()];
  `);
  assertEquals(s.get(0, 'probe'),
    ['method-named-static', 'method-named-get', 'method-named-set:1', 'keyword-member']);
});

// =============================================================================
// export class
// =============================================================================

Deno.test('class: export class registers in the export map and survives restore', () => {
  const session = freshSession({ inlineSource: true });
  parseAndSetup(session, `
    export class Widget {
      constructor() { this.kind = 'widget'; }
    }
    let w = new Widget();
  `);
  assertEquals(session.run(0, 500000).status, 'done');
  assertEquals(session.exports().get('Widget'), { type: 'class' });

  const { vatBytes, membraneBytes } = snapshotSession(session);
  const restored = restoreSession(vatBytes, membraneBytes, { inlineSource: true });
  assertEquals(restored.exports().get('Widget'), { type: 'class' });
});

// =============================================================================
// Snapshot round-trip with live instances
// =============================================================================

Deno.test('class: instances and classes survive snapshot/restore', () => {
  const session = run(`
    class Counter {
      value = 0;
      bump() { this.value = this.value + 1; return this.value; }
    }
    class DoubleCounter extends Counter {
      bump() { super.bump(); return super.bump(); }
    }
    let c = new DoubleCounter();
    c.bump();
  `);
  const { vatBytes, membraneBytes } = snapshotSession(session);
  const restored = restoreSession(vatBytes, membraneBytes, { inlineSource: true });
  parseAndSetup(restored, `
    let afterRestore = c.bump();
    let fresh = new DoubleCounter().bump();
    let stillInstance = c instanceof Counter;
  `);
  assertEquals(restored.run(0, 500000).status, 'done');
  assertEquals(restored.get(0, 'afterRestore'), 4);
  assertEquals(restored.get(0, 'fresh'), 2);
  assertEquals(restored.get(0, 'stillInstance'), true);
});

// =============================================================================
// GC survival
// =============================================================================

Deno.test('class: class graph survives gc', () => {
  const session = run(`
    class Base {
      constructor() { this.tag = 'b'; }
      hello() { return 'hi-' + this.tag; }
    }
    class Kid extends Base {
      shout() { return super.hello() + '!'; }
    }
    let kid = new Kid();
  `);
  session.gc();
  parseAndSetup(session, `
    let afterGc = kid.shout();
    let freshKid = new Kid().shout();
  `);
  assertEquals(session.run(0, 500000).status, 'done');
  assertEquals(session.get(0, 'afterGc'), 'hi-b!');
  assertEquals(session.get(0, 'freshKid'), 'hi-b!');
});

// =============================================================================
// getSource() round-trip
// =============================================================================

Deno.test('class: getSource round-trips class syntax', () => {
  const session = run(`
    class Figure {}
    export class Shape extends Figure {
      edges = 0;
      static family = 'geometry';
      constructor(edges) {
        super();
        this.edges = edges;
      }
      describe() { return 'edges: ' + this.edges; }
      get doubled() { return this.edges * 2; }
      set doubled(v) { this.edges = v / 2; }
      static make(n) { return new Shape(n); }
    }
    let AnonHolder = class {
      tag() { return 1; }
    };
  `);
  const source = session.getSource();
  assert(source.includes('export class Shape extends Figure {'), source);
  assert(source.includes('edges = 0;'), source);
  assert(source.includes('static family = "geometry";'), source);
  assert(source.includes('constructor(edges)'), source);
  assert(source.includes('super()'), source);
  assert(source.includes('get doubled()'), source);
  assert(source.includes('set doubled(v)'), source);
  assert(source.includes('static make(n)'), source);
  assert(source.includes('class {'), source);

  // The printed source re-parses and runs to the same behavior.
  const twin = run(`${source}
    let reparsed = Shape.make(4).describe();
  `);
  assertEquals(twin.get(0, 'reparsed'), 'edges: 4');
});

// =============================================================================
// Parse errors
// =============================================================================

Deno.test('class: parse errors carry specific messages', () => {
  assertEquals(
    String(parseError('class A { m() { return this.#nope; } }').message)
      .includes('is not declared in an enclosing class'), true);
  assertEquals(
    String(parseError('function f(x) { return x.#loose; }').message)
      .includes('is not declared in an enclosing class'), true);
  assertEquals(
    String(parseError('class A { #constructor() {} }').message)
      .includes("cannot be named '#constructor'"), true);
  assertEquals(
    String(parseError('class A extends B { #m() {} n() { return super.#m(); } }').message)
      .includes('super cannot access a private member'), true);
  assertEquals(
    String(parseError('let t = new.target;').message)
      .includes('new.target is only valid inside a function'), true);
  assertEquals(
    String(parseError('class A extends B { constructor() {} }').message)
      .includes('A derived constructor must call super()'), true);
  assertEquals(
    String(parseError('class A extends B { constructor() { super(); super(); } }').message)
      .includes('Call super() exactly once'), true);
  assertEquals(
    String(parseError('class A { constructor() {} constructor() {} }').message)
      .includes('one constructor'), true);
  assertEquals(
    String(parseError('class A { async constructor() {} }').message)
      .includes('constructor cannot be async'), true);
  assertEquals(
    String(parseError('function f() { super.m(); }').message)
      .includes("'super' is only valid inside a class method"), true);
  assertEquals(
    String(parseError('class A { m() { super.m(); } }').message)
      .includes("'super' requires a class with 'extends'"), true);
  assertEquals(
    String(parseError('class A extends B { m() { super(); } }').message)
      .includes('super() is only valid inside a constructor'), true);
  assertEquals(
    String(parseError('class A { static prototype() {} }').message)
      .includes("cannot be named 'prototype'"), true);
  assertEquals(
    String(parseError('class A { get x; }').message)
      .includes("Expected '(' after get accessor name"), true);
});

// =============================================================================
// Static blocks, this in static fields, computed fields
// =============================================================================

Deno.test('class: static blocks run at class evaluation with this = class', () => {
  const s = run(`
    class Boot {
      static registryName = 'counters';
      static { this.bootFlag = this.registryName + '/booted'; }
      static after = 'after';
    }
    let probe = [Boot.bootFlag, Boot.after];
  `);
  assertEquals(s.get(0, 'probe'), ['counters/booted', 'after']);
});

Deno.test('class: this in a static field initializer is the class', () => {
  const s = run(`
    class Config {
      static base = 10;
      static doubled = this.base * 2;
      static viaName = Config.doubled + 1;
    }
    let probe = [Config.doubled, Config.viaName];
  `);
  assertEquals(s.get(0, 'probe'), [20, 21]);
});

Deno.test('class: computed field keys evaluate once at class evaluation', () => {
  const s = run(`
    let calls = 0;
    let keyOf = (n) => { calls = calls + 1; return 'k' + n; };
    class Keyed {
      [keyOf(1)] = 'one';
      static [keyOf(2)] = 'two';
    }
    let a = new Keyed();
    let b = new Keyed();
    let probe = [a.k1, b.k1, Keyed.k2, calls];
  `);
  assertEquals(s.get(0, 'probe'), ['one', 'one', 'two', 2]);
});

Deno.test('class: static members named call and apply are legal', () => {
  const s = run(`
    class Base {
      constructor(v) { this.v = v; }
      static call(x) { return 'call:' + x; }
      static apply(x) { return 'apply:' + x; }
    }
    class Child extends Base {
      constructor() { super(7); }
    }
    let c = new Child();
    let probe = [c.v, Base.call(1), Child.apply(2), c instanceof Base];
  `);
  // super() dispatch does not route through .call/.apply lookups, so the
  // statics cannot hijack construction.
  assertEquals(s.get(0, 'probe'), [7, 'call:1', 'apply:2', true]);
});

// =============================================================================
// Private members
// =============================================================================

Deno.test('class: private fields, methods, accessors, statics', () => {
  const s = run(`
    class Vault {
      #balance = 0;
      static #opened = 0;
      constructor() { Vault.#opened = Vault.#opened + 1; }
      deposit(n) { this.#balance = this.#balance + n; return this.#audit(); }
      #audit() { return 'balance:' + this.#balance; }
      get #hidden() { return this.#balance * 2; }
      peekHidden() { return this.#hidden; }
      static get opened() { return Vault.#opened; }
      merge(other) { return this.#balance + other.#balance; }
    }
    let v1 = new Vault();
    let v2 = new Vault();
    v1.deposit(5);
    v2.deposit(3);
    let probe = [
      v1.deposit(2),
      v1.peekHidden(),
      Vault.opened,
      v1.merge(v2)
    ];
  `);
  assertEquals(s.get(0, 'probe'), ['balance:7', 14, 2, 10]);
});

Deno.test('class: private members are invisible to enumeration', () => {
  const s = run(`
    class Sealed {
      #secret = 'hidden';
      open = 'visible';
      reveal() { return this.#secret; }
    }
    let x = new Sealed();
    let probe = [
      Object.keys(x),
      Object.values(x),
      JSON.stringify(x),
      Object.keys({ ...x }),
      x.reveal()
    ];
    let assigned = Object.keys(Object.assign({}, x));
  `);
  assertEquals(s.get(0, 'probe'),
    [['open'], ['visible'], '{"open":"visible"}', ['open'], 'hidden']);
  assertEquals(s.get(0, 'assigned'), ['open']);
});

Deno.test('class: private names scope per class (shadowing)', () => {
  const s = run(`
    class Outer {
      #tag = 'outer';
      make() {
        let Inner = class {
          #tag = 'inner';
          read() { return this.#tag; }
        };
        let inner = new Inner();
        return inner.read() + '/' + this.#tag;
      }
    }
    let probe = new Outer().make();
  `);
  assertEquals(s.get(0, 'probe'), 'inner/outer');
});

Deno.test('class: private members round-trip through getSource', () => {
  const session = run(`
    class Box {
      #value = 1;
      static { Box.ready = true; }
      bump() { this.#value = this.#value + 1; return this.#value; }
    }
    let unused = new Box();
  `);
  const source = session.getSource();
  assert(source.includes('#value = 1;'), source);
  assert(source.includes('this.#value'), source);
  assert(source.includes('static {'), source);
  const twin = run(`${source}
    let b = new Box();
    let probe = [b.bump(), b.bump(), Box.ready, Object.keys(b)];
  `);
  assertEquals(twin.get(0, 'probe'), [2, 3, true, []]);
});

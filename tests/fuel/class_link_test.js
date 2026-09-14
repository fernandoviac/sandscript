/**
 * Runtime substrate for class support.
 *
 * Part A — member-store prototype walk: SET_PROP and
 * SET_INDEX consult the prototype chain on an own miss. An inherited
 * accessor's setter intercepts the write with `this` = the receiver; an
 * inherited accessor without a setter half completes silently (non-strict
 * JS); an inherited DATA property keeps the own-create (shadowing) behavior.
 *
 * Part B — the CLASS_LINK opcode: pops the class
 * constructor and parent constructor, writes both inheritance edges, and
 * pushes the class constructor back. These tests append CLASS_LINK directly
 * to isolate the opcode from parser emission.
 */

import { assert, assertEquals, assertThrows } from 'https://deno.land/std@0.208.0/assert/mod.ts';
import { parseAndSetup } from './test-helpers.js';
import { freshSession } from '../../src/host-owned-session.js';
import { OP } from '../../src/fuel/constants.js';

function runToDone(session, source, slot = 0, fuel = 100000) {
  const result = parseAndSetup(session, source, slot);
  const run = session.run(slot, fuel);
  assertEquals(run.status, 'done', `run failed: ${JSON.stringify(run)}`);
  return result;
}

// =============================================================================
// Part A — inherited setters through SET_PROP
// =============================================================================

Deno.test('inherited setter fires with this = receiver (SET_PROP)', () => {
  const session = freshSession();
  runToDone(session, `
    function P() {}
    P.prototype = {
      get half() { return this.n / 2; },
      set half(v) { this.n = v * 2; }
    };
    let p = new P();
    p.half = 21;
    let stored = p.n;
    let readBack = p.half;
    let ownKeys = Object.keys(p);
  `);
  assertEquals(session.get(0, 'stored'), 42);
  assertEquals(session.get(0, 'readBack'), 21);
  // The setter wrote `n`; no own `half` shadow property was created.
  assertEquals(session.get(0, 'ownKeys'), ['n']);
});

Deno.test('inherited setter fires through SET_INDEX (computed key)', () => {
  const session = freshSession();
  runToDone(session, `
    function P() {}
    P.prototype = { set v(x) { this.backing = x + 1; } };
    let p = new P();
    let key = 'v';
    p[key] = 10;
    let stored = p.backing;
    let ownKeys = Object.keys(p);
  `);
  assertEquals(session.get(0, 'stored'), 11);
  assertEquals(session.get(0, 'ownKeys'), ['backing']);
});

Deno.test('inherited getter-only accessor: silent no-op, no own shadow', () => {
  const session = freshSession();
  runToDone(session, `
    function P() {}
    P.prototype = { get g() { return 7; } };
    let p = new P();
    p.g = 99;
    let value = p.g;
    let ownKeys = Object.keys(p);
  `);
  assertEquals(session.get(0, 'value'), 7);
  assertEquals(session.get(0, 'ownKeys'), []);
});

Deno.test('inherited DATA property still shadows with an own property', () => {
  const session = freshSession();
  runToDone(session, `
    function P() {}
    P.prototype.d = 1;
    let p = new P();
    p.d = 2;
    let own = p.d;
    let inherited = P.prototype.d;
    let ownKeys = Object.keys(p);
  `);
  assertEquals(session.get(0, 'own'), 2);
  assertEquals(session.get(0, 'inherited'), 1);
  assertEquals(session.get(0, 'ownKeys'), ['d']);
});

Deno.test('setter found two levels up the chain', () => {
  const session = freshSession();
  runToDone(session, `
    function A() {}
    A.prototype = { set deep(v) { this.got = v; } };
    function B() {}
    B.prototype = new A();
    let b = new B();
    b.deep = 5;
    let got = b.got;
    let ownKeys = Object.keys(b);
  `);
  assertEquals(session.get(0, 'got'), 5);
  assertEquals(session.get(0, 'ownKeys'), ['got']);
});

Deno.test('own accessor still wins over an inherited accessor', () => {
  const session = freshSession();
  runToDone(session, `
    function P() {}
    P.prototype = { set s(v) { this.fromProto = v; } };
    let p = new P();
    let seen = 0;
    Object.assign(p, {});
    let holder = { set s(v) { seen = v; } };
    holder.s = 3;
    let ownSetter = seen;
    p.s = 4;
    let protoSetter = p.fromProto;
  `);
  assertEquals(session.get(0, 'ownSetter'), 3);
  assertEquals(session.get(0, 'protoSetter'), 4);
});

Deno.test('setter throw propagates as a catchable error', () => {
  const session = freshSession();
  runToDone(session, `
    function P() {}
    P.prototype = { set s(v) { throw { message: 'rejected: ' + v }; } };
    let p = new P();
    let caught = '';
    try {
      p.s = 9;
    } catch (e) {
      caught = e.message;
    }
  `);
  assertEquals(session.get(0, 'caught'), 'rejected: 9');
});

Deno.test('assignment expression still evaluates to the assigned value', () => {
  const session = freshSession();
  runToDone(session, `
    function P() {}
    P.prototype = { set s(v) { this.x = v; } };
    let p = new P();
    let expressionValue = (p.s = 13);
    let getterOnly = new P();
    P.prototype = { get g() { return 1; } };
    function Q() {}
    Q.prototype = { get g() { return 1; } };
    let q = new Q();
    let silentValue = (q.g = 27);
  `);
  assertEquals(session.get(0, 'expressionValue'), 13);
  assertEquals(session.get(0, 'silentValue'), 27);
});

// =============================================================================
// Part B — CLASS_LINK opcode
// =============================================================================

/**
 * Parse and run a program that defines parent and child constructor
 * functions, then append [GET_VAR parent, GET_VAR child, CLASS_LINK,
 * LET_VAR resultName] and run the appended tail. Returns the session.
 */
function linkViaOpcode(session, source, parentName, childName, resultName) {
  runToDone(session, source);
  const mem = session.mem;
  const first = mem.codeBlockAppend(OP.GET_VAR, mem.internString(parentName));
  mem.codeBlockAppend(OP.GET_VAR, mem.internString(childName));
  mem.codeBlockAppend(OP.CLASS_LINK);
  mem.codeBlockAppend(OP.LET_VAR, mem.internString(resultName));
  mem.setContextInstructionIndex(0, first);
  mem.clearExitCondition(0);
  return session.run(0, 100000);
}

const LINK_FIXTURE = `
  function Base(tag) {
    this.tag = tag;
  }
  Base.prototype.describe = function() { return 'base:' + this.tag; };
  Base.prototype.hello = function() { return 'hi'; };
  Base.staticHelper = function(x) { return x * 10; };
  function Derived(tag) {
    this.tag = tag;
    this.extra = true;
  }
  Derived.prototype.describe = function() { return 'derived:' + this.tag; };
`;

Deno.test('CLASS_LINK wires both inheritance edges', () => {
  const session = freshSession();
  const run = linkViaOpcode(session, LINK_FIXTURE, 'Base', 'Derived', 'LinkedDerived');
  assertEquals(run.status, 'done', `link run failed: ${JSON.stringify(run)}`);

  const check = session.parse(`
    let d = new Derived('x');
    let inheritedMethod = d.hello();
    let overriddenMethod = d.describe();
    let isInstance = d instanceof Base;
    let staticInherited = Derived.staticHelper(4);
    let protoLinked = Object.getPrototypeOf(Derived.prototype) === Base.prototype;
    let resultIsClass = LinkedDerived === Derived;
  `);
  session.mem.setContextInstructionIndex(0, check.startIndex);
  session.mem.clearExitCondition(0);
  const run2 = session.run(0, 100000);
  assertEquals(run2.status, 'done', `check run failed: ${JSON.stringify(run2)}`);

  assertEquals(session.get(0, 'inheritedMethod'), 'hi');
  assertEquals(session.get(0, 'overriddenMethod'), 'derived:x');
  assertEquals(session.get(0, 'isInstance'), true);
  assertEquals(session.get(0, 'staticInherited'), 40);
  assertEquals(session.get(0, 'protoLinked'), true);
  assertEquals(session.get(0, 'resultIsClass'), true);
});

Deno.test('CLASS_LINK graph survives GC', () => {
  const session = freshSession();
  const run = linkViaOpcode(session, LINK_FIXTURE, 'Base', 'Derived', 'LinkedDerived');
  assertEquals(run.status, 'done');

  session.gc();

  const check = session.parse(`
    let d = new Derived('g');
    let afterGc = d.hello() + '/' + d.describe();
    let stillInstance = d instanceof Base;
    let stillStatic = Derived.staticHelper(2);
  `);
  session.mem.setContextInstructionIndex(0, check.startIndex);
  session.mem.clearExitCondition(0);
  const run2 = session.run(0, 100000);
  assertEquals(run2.status, 'done', `post-gc run failed: ${JSON.stringify(run2)}`);

  assertEquals(session.get(0, 'afterGc'), 'hi/derived:g');
  assertEquals(session.get(0, 'stillInstance'), true);
  assertEquals(session.get(0, 'stillStatic'), 20);
});

Deno.test('CLASS_LINK inherited setter dispatches after link', () => {
  const session = freshSession();
  const run = linkViaOpcode(session, `
    function Base() {}
    Base.prototype = { set level(v) { this.stored = v * 3; } };
    function Derived() {}
  `, 'Base', 'Derived', 'LinkedDerived');
  assertEquals(run.status, 'done');

  const check = session.parse(`
    let d = new Derived();
    d.level = 7;
    let viaChain = d.stored;
  `);
  session.mem.setContextInstructionIndex(0, check.startIndex);
  session.mem.clearExitCondition(0);
  assertEquals(session.run(0, 100000).status, 'done');
  assertEquals(session.get(0, 'viaChain'), 21);
});

Deno.test('CLASS_LINK rejects a non-function parent with a TypeError', () => {
  const session = freshSession();
  const error = assertThrows(() => linkViaOpcode(session, `
    let NotAFunction = 42;
    function Derived() {}
  `, 'NotAFunction', 'Derived', 'ignored'));
  assert(String(error.message).includes('Not a function'),
    `expected TypeError shape, got: ${error.message}`);
});

Deno.test('CLASS_LINK rejects an arrow-function parent', () => {
  const session = freshSession();
  const error = assertThrows(() => linkViaOpcode(session, `
    let Arrow = () => 1;
    function Derived() {}
  `, 'Arrow', 'Derived', 'ignored'));
  assert(String(error.message).includes('Not a function'),
    `expected TypeError shape, got: ${error.message}`);
});

Deno.test('CLASS_LINK rejects an async-function parent', () => {
  const session = freshSession();
  const error = assertThrows(() => linkViaOpcode(session, `
    async function Later() { return 1; }
    function Derived() {}
  `, 'Later', 'Derived', 'ignored'));
  assert(String(error.message).includes('Not a function'),
    `expected TypeError shape, got: ${error.message}`);
});

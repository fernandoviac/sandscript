/**
 * Uncaught-name diagnostics, constructor/class `name`, and loud private
 * misses.
 *
 * An uncaught thrown error object reaches the host as
 * `Uncaught <name>: <message> (...)`; the family classifies through a
 * prototype-chain walk, and an own `name` field overrides it.
 * `Ctor.name` and `Class.name` are readable string properties.
 * A private access on an object whose class did not declare the name throws a
 * catchable TypeError instead of reading undefined or creating an own field;
 * `delete obj.#x` is a parse error.
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

function uncaughtMessage(source) {
  const session = freshSession({ inlineSource: true });
  parseAndSetup(session, source);
  const err = assertThrows(() => {
    const r = session.run(0, 500000);
    if (r.status !== 'done') throw new Error(`exit ${r.status}`);
  });
  return String(err.message);
}

function parseError(source) {
  const session = freshSession();
  return assertThrows(() => session.parse(source));
}

// =============================================================================
// Uncaught diagnostics carry the name
// =============================================================================

Deno.test('uncaught: derived error with own name field carries it', () => {
  const msg = uncaughtMessage(`
    class ConfigFault extends TypeError { name = 'ConfigFault'; }
    throw new ConfigFault('missing dbUrl');
  `);
  assert(msg.startsWith('Uncaught ConfigFault: missing dbUrl'), msg);
});

Deno.test('uncaught: derived error without own name reports its family', () => {
  const msg = uncaughtMessage(`
    class Fault extends RangeError {}
    throw new Fault('out of bounds');
  `);
  assert(msg.startsWith('Uncaught RangeError: out of bounds'), msg);
});

Deno.test('uncaught: plain family errors carry the family name', () => {
  assert(uncaughtMessage(`throw new TypeError('boom');`)
    .startsWith('Uncaught TypeError: boom'));
  assert(uncaughtMessage(`throw new SyntaxError('bad');`)
    .startsWith('Uncaught SyntaxError: bad'));
  assert(uncaughtMessage(`throw new Error('plain');`)
    .startsWith('Uncaught Error: plain'));
});

Deno.test('uncaught: non-object throws are unchanged', () => {
  const msg = uncaughtMessage(`throw 'bare string';`);
  assert(msg.startsWith('Uncaught bare string'), msg);
});

Deno.test('uncaught: reference errors keep the identifier shape', () => {
  const msg = uncaughtMessage(`nowhere();`);
  assert(msg.includes('nowhere is not defined'), msg);
  assert(!msg.includes('nowhere: nowhere'), msg);
});

// =============================================================================
// Constructor and class names
// =============================================================================

Deno.test('name: built-in constructors expose their binding name', () => {
  const s = run(`
    let names = [Error.name, TypeError.name, ReferenceError.name,
      RangeError.name, SyntaxError.name, Object.name, Map.name, Set.name,
      Array.name, Promise.name, Uint8Array.name, RegExp.name];
  `);
  assertEquals(s.get(0, 'names'), ['Error', 'TypeError', 'ReferenceError',
    'RangeError', 'SyntaxError', 'Object', 'Map', 'Set',
    'Array', 'Promise', 'Uint8Array', 'RegExp']);
});

Deno.test('name: classes expose their declared name', () => {
  const s = run(`
    class Widget {}
    class Derived extends Widget {}
    class FaultChild extends TypeError {}
    let names = [Widget.name, Derived.name, FaultChild.name];
  `);
  assertEquals(s.get(0, 'names'), ['Widget', 'Derived', 'FaultChild']);
});

Deno.test('name: a static name member shadows the automatic one', () => {
  const s = run(`
    class Branded { static name = 'Custom'; }
    let name = Branded.name;
  `);
  assertEquals(s.get(0, 'name'), 'Custom');
});

Deno.test('name: an anonymous class expression has none (deviation)', () => {
  const s = run(`
    let C = class {};
    let nameType = typeof C.name;
  `);
  assertEquals(s.get(0, 'nameType'), 'undefined');
});

// =============================================================================
// Loud private misses
// =============================================================================

Deno.test('private: wrong-class read throws a catchable TypeError', () => {
  const s = run(`
    class Holder {
      #secret = 42;
      static readFrom(obj) { return obj.#secret; }
    }
    let right = Holder.readFrom(new Holder());
    let caught = '';
    try { Holder.readFrom({ plain: 1 }); } catch (e) {
      caught = (e instanceof TypeError) + '|' + e.message;
    }
  `);
  assertEquals(s.get(0, 'right'), 42);
  assertEquals(s.get(0, 'caught'),
    'true|Private member is not declared on the receiver');
});

Deno.test('private: wrong-class write throws instead of own-creating', () => {
  const s = run(`
    class Holder {
      #secret = 42;
      static writeTo(obj) { obj.#secret = 7; }
    }
    let stranger = { plain: 1 };
    let caught = '';
    try { Holder.writeTo(stranger); } catch (e) { caught = e.message; }
    let untouched = Object.keys(stranger);
  `);
  assertEquals(s.get(0, 'caught'), 'Private member is not declared on the receiver');
  assertEquals(s.get(0, 'untouched'), ['plain']);
});

Deno.test('private: wrong-class method call throws on the load', () => {
  const s = run(`
    class Holder {
      #compute() { return 1; }
      static callOn(obj) { return obj.#compute(); }
    }
    let caught = '';
    try { Holder.callOn({}); } catch (e) { caught = e.message; }
  `);
  assertEquals(s.get(0, 'caught'), 'Private member is not declared on the receiver');
});

Deno.test('private: optional chain still throws on a wrong class, short-circuits on nullish', () => {
  const s = run(`
    class Holder {
      #secret = 5;
      static probe(obj) { return obj?.#secret; }
    }
    let onNull = String(Holder.probe(null));
    let caught = '';
    try { Holder.probe({}); } catch (e) { caught = e.message; }
    let right = Holder.probe(new Holder());
  `);
  assertEquals(s.get(0, 'onNull'), 'undefined');
  assertEquals(s.get(0, 'caught'), 'Private member is not declared on the receiver');
  assertEquals(s.get(0, 'right'), 5);
});

Deno.test('private: right-class fields, methods, accessors, compound stay working', () => {
  const s = run(`
    class Counter {
      #count = 0;
      #step = 2;
      get #doubled() { return this.#count * 2; }
      set #reset(v) { this.#count = v; }
      #bump() { this.#count += this.#step; }
      exercise() {
        this.#bump();
        this.#bump();
        let d = this.#doubled;
        this.#reset = 10;
        this.#count++;
        return [d, this.#count];
      }
    }
    let out = new Counter().exercise();
    let hidden = Object.keys(new Counter());
  `);
  assertEquals(s.get(0, 'out'), [8, 11]);
  assertEquals(s.get(0, 'hidden'), []);
});

Deno.test('private: initializers create even when a base holds other privates', () => {
  const s = run(`
    class Base { #baseSecret = 'b'; readBase() { return this.#baseSecret; } }
    class Kid extends Base { #kidSecret = 'k'; readKid() { return this.#kidSecret; } }
    let kid = new Kid();
    let both = [kid.readBase(), kid.readKid()];
  `);
  assertEquals(s.get(0, 'both'), ['b', 'k']);
});

Deno.test('private: delete on a private member is a parse error', () => {
  const err = parseError(`
    class A { #x = 1; drop() { delete this.#x; } }
  `);
  assert(String(err.message).includes('delete cannot target a private member'),
    String(err.message));
});

// =============================================================================
// Round-trips
// =============================================================================

Deno.test('round-trip: names and private brands survive getSource and snapshot', () => {
  const source = `
    class Holder {
      #secret = 3;
      static readFrom(obj) { return obj.#secret; }
    }
    let right = Holder.readFrom(new Holder());
    let holderName = Holder.name;
    let caught = '';
    try { Holder.readFrom({}); } catch (e) { caught = e.message; }
  `;
  const s = run(source);
  assertEquals(s.get(0, 'right'), 3);
  assertEquals(s.get(0, 'holderName'), 'Holder');
  assertEquals(s.get(0, 'caught'), 'Private member is not declared on the receiver');

  const twin = run(s.getSource());
  assertEquals(twin.get(0, 'right'), 3);
  assertEquals(twin.get(0, 'holderName'), 'Holder');

  const snap = snapshotSession(s);
  const restored = restoreSession(snap.vatBytes, snap.membraneBytes);
  parseAndSetup(restored, `
    let afterRight = Holder.readFrom(new Holder());
    let afterCaught = '';
    try { Holder.readFrom({}); } catch (e) { afterCaught = e.message; }
  `);
  const r = restored.run(0, 500000);
  assertEquals(r.status, 'done', JSON.stringify(r));
  assertEquals(restored.get(0, 'afterRight'), 3);
  assertEquals(restored.get(0, 'afterCaught'),
    'Private member is not declared on the receiver');
});

Deno.test('round-trip: optional private access prints the source spelling', () => {
  const s = run(`
    class Holder {
      #secret = 9;
      static probe(obj) { return obj?.#secret; }
    }
    let right = Holder.probe(new Holder());
    let onNull = String(Holder.probe(null));
  `);
  assertEquals(s.get(0, 'right'), 9);
  assertEquals(s.get(0, 'onNull'), 'undefined');
  const printed = s.getSource();
  assert(printed.includes('?.#secret'), printed);
  assert(!printed.includes('@#secret'), printed);
  const twin = run(printed);
  assertEquals(twin.get(0, 'right'), 9);
});

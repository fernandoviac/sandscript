/**
 * Complex construction tests — Phase 1b of the exact-numbers extension.
 *
 * Covers Exact.complex(real, imaginary) and its no-collapse invariant:
 * a Complex with zero imaginary part is a first-class Complex heap value,
 * distinct from any Rational.
 *
 * Also covers projection accessors: Exact.real, Exact.imaginary,
 * Exact.realize, Exact.tryRealize, and Exact.isComplex.
 */

import { assertEquals } from "https://deno.land/std@0.208.0/assert/mod.ts";
import { createSession } from '../../src/fuel/session.js';
import { parseAndSetup } from './test-helpers.js';
import { freshSession } from '../../src/host-owned-session.js';
import { UncaughtScriptError } from '../../src/runtime/errors.js';

function run(source) {
  const session = freshSession();
  parseAndSetup(session, source);
  try {
    session.run(0, 100000);
    return { session, error: null };
  } catch (e) {
    if (e instanceof UncaughtScriptError) return { session, error: e.scriptError };
    throw e;
  }
}

function evalValue(expression, name = 'r') {
  const { session, error } = run(`let ${name} = ${expression};`);
  if (error) throw new Error(`Error evaluating '${expression}': ${error.message}`);
  return session.getExact(0, name);
}

Deno.test("Complex: construction with BigInt args", () => {
  assertEquals(evalValue('Exact.complex(3n, 4n)'), {
    kind: 'complex',
    real: { kind: 'rational', numerator: 3n, denominator: 1n },
    imaginary: { kind: 'rational', numerator: 4n, denominator: 1n },
  });
});

Deno.test("Complex: construction with Rational args", () => {
  assertEquals(evalValue('Exact.complex(Exact.rational(1n, 2n), Exact.rational(3n, 4n))'), {
    kind: 'complex',
    real: { kind: 'rational', numerator: 1n, denominator: 2n },
    imaginary: { kind: 'rational', numerator: 3n, denominator: 4n },
  });
});

Deno.test("Complex: mixed BigInt and Rational args", () => {
  assertEquals(evalValue('Exact.complex(5n, Exact.rational(1n, 2n))'), {
    kind: 'complex',
    real: { kind: 'rational', numerator: 5n, denominator: 1n },
    imaginary: { kind: 'rational', numerator: 1n, denominator: 2n },
  });
});

Deno.test("Complex: no collapse — zero imaginary produces Complex, not Rational", () => {
  const value = evalValue('Exact.complex(5n, 0n)');
  assertEquals(value.kind, 'complex');
  assertEquals(value.real.numerator, 5n);
  assertEquals(value.imaginary.numerator, 0n);
});

Deno.test("Complex: Exact.isComplex returns true for Complex", () => {
  const { session, error } = run(`let r = Exact.isComplex(Exact.complex(1n, 2n));`);
  if (error) throw new Error(error.message);
  assertEquals(session.getExact(0, 'r'), true);
});

Deno.test("Complex: Exact.isComplex returns false for non-Complex", () => {
  const { session, error } = run(`
    let a = Exact.isComplex(Exact.rational(1n, 2n));
    let b = Exact.isComplex(5n);
    let c = Exact.isComplex(1.5);
  `);
  if (error) throw new Error(error.message);
  assertEquals(session.getExact(0, 'a'), false);
  assertEquals(session.getExact(0, 'b'), false);
  assertEquals(session.getExact(0, 'c'), false);
});

Deno.test("Complex: Exact.real extracts the real part", () => {
  assertEquals(evalValue('Exact.real(Exact.complex(3n, 4n))'), {
    kind: 'rational',
    numerator: 3n,
    denominator: 1n,
  });
});

Deno.test("Complex: Exact.imaginary extracts the imaginary part", () => {
  assertEquals(evalValue('Exact.imaginary(Exact.complex(3n, 4n))'), {
    kind: 'rational',
    numerator: 4n,
    denominator: 1n,
  });
});

Deno.test("Complex: Exact.real on Rational is identity", () => {
  assertEquals(evalValue('Exact.real(Exact.rational(5n, 7n))'), {
    kind: 'rational',
    numerator: 5n,
    denominator: 7n,
  });
});

Deno.test("Complex: Exact.imaginary on Rational is 0/1", () => {
  assertEquals(evalValue('Exact.imaginary(Exact.rational(5n, 7n))'), {
    kind: 'rational',
    numerator: 0n,
    denominator: 1n,
  });
});

Deno.test("Complex: Exact.realize on Complex(a, 0) returns Rational(a)", () => {
  assertEquals(evalValue('Exact.realize(Exact.complex(7n, 0n))'), {
    kind: 'rational',
    numerator: 7n,
    denominator: 1n,
  });
});

Deno.test("Complex: Exact.realize on Complex with nonzero imaginary throws", () => {
  const { error } = run(`let r = Exact.realize(Exact.complex(3n, 4n));`);
  if (!error) throw new Error('expected TypeError on Exact.realize with nonzero imaginary');
});

Deno.test("Complex: Exact.realize on Rational is identity", () => {
  assertEquals(evalValue('Exact.realize(Exact.rational(5n, 7n))'), {
    kind: 'rational',
    numerator: 5n,
    denominator: 7n,
  });
});

Deno.test("Complex: Exact.tryRealize on Complex(a, 0) returns Rational(a)", () => {
  assertEquals(evalValue('Exact.tryRealize(Exact.complex(7n, 0n))'), {
    kind: 'rational',
    numerator: 7n,
    denominator: 1n,
  });
});

Deno.test("Complex: Exact.tryRealize on Complex with nonzero imaginary returns unchanged", () => {
  const value = evalValue('Exact.tryRealize(Exact.complex(3n, 4n))');
  assertEquals(value.kind, 'complex');
  assertEquals(value.real.numerator, 3n);
  assertEquals(value.imaginary.numerator, 4n);
});

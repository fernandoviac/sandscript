/**
 * Complex arithmetic tests — Phase 1b.
 *
 * Exercises OP_ADD, OP_SUB, OP_MUL, OP_DIV, OP_POW, OP_NEG, OP_EQ, and OP_NEQ
 * for Complex values and mixed-type promotion (Complex × Rational,
 * Complex × BigInt). Confirms arithmetic is closed on Complex (no collapse).
 *
 * Also covers semantic equality (Exact.equal) across Complex / Rational /
 * BigInt, and Float-contagion rejection.
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

function complex(real, imaginary) {
  return {
    kind: 'complex',
    real: { kind: 'rational', numerator: real, denominator: 1n },
    imaginary: { kind: 'rational', numerator: imaginary, denominator: 1n },
  };
}

Deno.test("Complex: (1+i) + (2+3i) = 3+4i", () => {
  assertEquals(
    evalValue('Exact.complex(1n, 1n) + Exact.complex(2n, 3n)'),
    complex(3n, 4n),
  );
});

Deno.test("Complex: (1+i) - (2+3i) = -1-2i", () => {
  assertEquals(
    evalValue('Exact.complex(1n, 1n) - Exact.complex(2n, 3n)'),
    complex(-1n, -2n),
  );
});

Deno.test("Complex: (1+i) * (1-i) = 2+0i (no collapse)", () => {
  assertEquals(
    evalValue('Exact.complex(1n, 1n) * Exact.complex(1n, -1n)'),
    complex(2n, 0n),
  );
});

Deno.test("Complex: (1+i) / (1-i) = 0+i", () => {
  assertEquals(
    evalValue('Exact.complex(1n, 1n) / Exact.complex(1n, -1n)'),
    complex(0n, 1n),
  );
});

Deno.test("Complex: i * i = -1+0i (no collapse)", () => {
  assertEquals(
    evalValue('Exact.complex(0n, 1n) * Exact.complex(0n, 1n)'),
    complex(-1n, 0n),
  );
});

Deno.test("Complex: i ** 4 = 1+0i", () => {
  assertEquals(
    evalValue('Exact.complex(0n, 1n) ** 4n'),
    complex(1n, 0n),
  );
});

Deno.test("Complex: i ** 3 = 0-i", () => {
  assertEquals(
    evalValue('Exact.complex(0n, 1n) ** 3n'),
    complex(0n, -1n),
  );
});

Deno.test("Complex: negation", () => {
  assertEquals(
    evalValue('-Exact.complex(3n, 4n)'),
    complex(-3n, -4n),
  );
});

Deno.test("Complex: division by zero throws", () => {
  const { error } = run(`let r = Exact.complex(1n, 2n) / Exact.complex(0n, 0n);`);
  if (!error) throw new Error('expected error on division by zero');
});

Deno.test("Complex: non-trivial division", () => {
  // (3 + 4i) / (1 + 2i) = ((3+4i)(1-2i)) / 5 = (3-6i+4i+8)/5 = (11 - 2i)/5
  assertEquals(
    evalValue('Exact.complex(3n, 4n) / Exact.complex(1n, 2n)'),
    {
      kind: 'complex',
      real: { kind: 'rational', numerator: 11n, denominator: 5n },
      imaginary: { kind: 'rational', numerator: -2n, denominator: 5n },
    },
  );
});

Deno.test("Complex + Rational promotes Rational to Complex", () => {
  assertEquals(
    evalValue('Exact.complex(3n, 4n) + Exact.rational(1n, 2n)'),
    {
      kind: 'complex',
      real: { kind: 'rational', numerator: 7n, denominator: 2n },
      imaginary: { kind: 'rational', numerator: 4n, denominator: 1n },
    },
  );
});

Deno.test("Rational + Complex promotes Rational to Complex", () => {
  assertEquals(
    evalValue('Exact.rational(1n, 2n) + Exact.complex(3n, 4n)'),
    {
      kind: 'complex',
      real: { kind: 'rational', numerator: 7n, denominator: 2n },
      imaginary: { kind: 'rational', numerator: 4n, denominator: 1n },
    },
  );
});

Deno.test("Complex + BigInt promotes BigInt to Complex", () => {
  assertEquals(
    evalValue('Exact.complex(3n, 4n) + 5n'),
    complex(8n, 4n),
  );
});

Deno.test("BigInt * Complex promotes BigInt to Complex", () => {
  assertEquals(
    evalValue('3n * Exact.complex(1n, 2n)'),
    complex(3n, 6n),
  );
});

Deno.test("Complex + Float throws TypeError", () => {
  const { error } = run(`let r = Exact.complex(1n, 2n) + 0.5;`);
  if (!error) throw new Error('expected TypeError on Complex + Float');
});

Deno.test("Float + Complex throws TypeError", () => {
  const { error } = run(`let r = 0.5 + Exact.complex(1n, 2n);`);
  if (!error) throw new Error('expected TypeError on Float + Complex');
});

Deno.test("Complex structural equality: === true for same value", () => {
  const { session, error } = run(`let r = Exact.complex(1n, 2n) === Exact.complex(1n, 2n);`);
  if (error) throw new Error(error.message);
  assertEquals(session.getExact(0, 'r'), true);
});

Deno.test("Complex structural equality: !== for different imaginary", () => {
  const { session, error } = run(`let r = Exact.complex(1n, 2n) === Exact.complex(1n, 3n);`);
  if (error) throw new Error(error.message);
  assertEquals(session.getExact(0, 'r'), false);
});

Deno.test("Complex === Rational is false (different type tags)", () => {
  // Complex(5, 0) is structurally different from Rational(5)
  const { session, error } = run(`let r = Exact.complex(5n, 0n) === Exact.rational(5n, 1n);`);
  if (error) throw new Error(error.message);
  assertEquals(session.getExact(0, 'r'), false);
});

Deno.test("Exact.equal: Complex(a, 0) === Rational(a) semantically true", () => {
  const { session, error } = run(`let r = Exact.equal(Exact.complex(5n, 0n), Exact.rational(5n, 1n));`);
  if (error) throw new Error(error.message);
  assertEquals(session.getExact(0, 'r'), true);
});

Deno.test("Exact.equal: Complex(a, b≠0) ≠ Rational semantically", () => {
  const { session, error } = run(`let r = Exact.equal(Exact.complex(5n, 1n), Exact.rational(5n, 1n));`);
  if (error) throw new Error(error.message);
  assertEquals(session.getExact(0, 'r'), false);
});

Deno.test("Exact.equal: Complex(a, 0) === BigInt(a) semantically true", () => {
  const { session, error } = run(`let r = Exact.equal(Exact.complex(5n, 0n), 5n);`);
  if (error) throw new Error(error.message);
  assertEquals(session.getExact(0, 'r'), true);
});

Deno.test("Exact.equal: Complex vs. Complex semantic equality", () => {
  const { session, error } = run(`let r = Exact.equal(Exact.complex(3n, 4n), Exact.complex(3n, 4n));`);
  if (error) throw new Error(error.message);
  assertEquals(session.getExact(0, 'r'), true);
});

Deno.test("Complex GC: long-lived complex survives many allocations", () => {
  const { session, error } = run(`
    let kept = Exact.complex(3n, 4n);
    let sum = Exact.complex(0n, 0n);
    for (let i = 0; i < 100; i = i + 1) {
      sum = sum + Exact.complex(1n, 1n);
    }
    let final = kept;
  `);
  if (error) throw new Error(error.message);
  assertEquals(session.getExact(0, 'final'), complex(3n, 4n));
});

Deno.test("Complex arithmetic chain: (1+i)^8 = 16+0i", () => {
  // (1+i)^2 = 2i; (2i)^2 = -4; (-4)^2 = 16
  // Also: (1+i)^8 = ((1+i)^2)^4 = (2i)^4 = 16
  assertEquals(
    evalValue('Exact.complex(1n, 1n) ** 8n'),
    complex(16n, 0n),
  );
});

Deno.test("Complex: chained arithmetic preserves Complex type", () => {
  // ((1+i) + (1-i)) * (2+2i) = 2 * (2+2i) = 4+4i
  assertEquals(
    evalValue('(Exact.complex(1n, 1n) + Exact.complex(1n, -1n)) * Exact.complex(2n, 2n)'),
    complex(4n, 4n),
  );
});

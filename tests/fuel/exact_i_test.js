/**
 * Tests for Exact.i — the pre-allocated imaginary unit.
 *
 * Exact.i is Complex(0, 1) constructed during initializeBuiltins and
 * exposed as a property on the Exact namespace. It was previously
 * deferred because pre-allocation triggered a pre-existing GC alignment
 * bug; that bug is fixed, so Exact.i is now a first-class property.
 */

import { assertEquals } from "https://deno.land/std@0.208.0/assert/mod.ts";
import { createSession } from '../../src/fuel/session.js';
import { parseAndSetup } from './test-helpers.js';
import { freshSession } from '../../src/host-owned-session.js';

function run(source) {
  const session = freshSession();
  parseAndSetup(session, source);
  const result = session.run(0, 1000000);
  if (result.status === 'error') {
    throw new Error(`Error: ${result.error.message}`);
  }
  return session;
}

Deno.test("Exact.i: is a Complex with real=0 and imaginary=1", () => {
  const session = run(`let x = Exact.i;`);
  assertEquals(session.getExact(0, 'x'), {
    kind: 'complex',
    real: { kind: 'rational', numerator: 0n, denominator: 1n },
    imaginary: { kind: 'rational', numerator: 1n, denominator: 1n },
  });
});

Deno.test("Exact.i: Exact.isComplex(Exact.i) is true", () => {
  const session = run(`let x = Exact.isComplex(Exact.i);`);
  assertEquals(session.getExact(0, 'x'), true);
});

Deno.test("Exact.i: i * i equals Complex(-1, 0)", () => {
  const session = run(`let x = Exact.i * Exact.i;`);
  assertEquals(session.getExact(0, 'x'), {
    kind: 'complex',
    real: { kind: 'rational', numerator: -1n, denominator: 1n },
    imaginary: { kind: 'rational', numerator: 0n, denominator: 1n },
  });
});

Deno.test("Exact.i: (1 + i)(1 - i) equals Complex(2, 0) — no collapse", () => {
  const session = run(`
    let a = Exact.complex(1n, 1n);
    let b = Exact.complex(1n, -1n);
    let x = a * b;
  `);
  assertEquals(session.getExact(0, 'x'), {
    kind: 'complex',
    real: { kind: 'rational', numerator: 2n, denominator: 1n },
    imaginary: { kind: 'rational', numerator: 0n, denominator: 1n },
  });
});

Deno.test("Exact.i: i ** 4 equals Complex(1, 0)", () => {
  const session = run(`let x = Exact.i ** 4n;`);
  assertEquals(session.getExact(0, 'x'), {
    kind: 'complex',
    real: { kind: 'rational', numerator: 1n, denominator: 1n },
    imaginary: { kind: 'rational', numerator: 0n, denominator: 1n },
  });
});

Deno.test("Exact.i: survives a GC cycle via unrelated heap churn", () => {
  // Exact.i is pre-allocated into the setup heap region. Confirm that a
  // runtime-triggered GC does not clobber it or misidentify its header.
  const session = run(`
    let filler = 0n;
    for (let i = 0; i < 500; i = i + 1) {
      filler = filler + (2n ** 50n);
    }
    let x = Exact.i;
  `);
  assertEquals(session.getExact(0, 'x'), {
    kind: 'complex',
    real: { kind: 'rational', numerator: 0n, denominator: 1n },
    imaginary: { kind: 'rational', numerator: 1n, denominator: 1n },
  });
});

Deno.test("Exact.i: Exact.equal with Complex(0, 1) is true", () => {
  const session = run(`let x = Exact.equal(Exact.i, Exact.complex(0n, 1n));`);
  assertEquals(session.getExact(0, 'x'), true);
});

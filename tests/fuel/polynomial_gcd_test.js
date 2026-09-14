/**
 * Ring 3 (3c) — Exact.Expression.polynomialGcd.
 *
 * Semantic GCD over the exact coefficient rings: Euclidean in Q[x]
 * normalized to primitive form with a positive real leading
 * coefficient (lex order); multivariate via main-variable recursion
 * with content removal (primitive pseudo-remainder sequence — no
 * coefficient division inside the PRS); numeric leaves bottom out in
 * rational gcd, Gaussian-integer Euclid (real-sign normalized, no
 * i-rotation), or the conservative 1 for general Complex pairs.
 * Honorary atoms participate: gcd(Sin(x)², Sin(x)) = Sin(x).
 */

import { assertEquals } from "https://deno.land/std@0.208.0/assert/mod.ts";
import { parseAndSetup } from './test-helpers.js';
import { freshSession } from '../../src/host-owned-session.js';
import { UncaughtScriptError } from '../../src/runtime/errors.js';

function run(source) {
  const session = freshSession({ heapSize: 8 * 1024 * 1024 });
  parseAndSetup(session, `
    let x = Symbol.for('x');
    let y = Symbol.for('y');
    let E = Exact.Expression;
    ${source}
  `);
  try {
    const result = session.run(0, 100000000);
    return { session, result, error: null };
  } catch (e) {
    if (e instanceof UncaughtScriptError) {
      return { session, result: { status: 'error' }, error: e.scriptError };
    }
    throw e;
  }
}

function render(value) {
  if (value === null || typeof value !== 'object') {
    return typeof value === 'bigint' ? `${value}n` : String(value);
  }
  if (value.kind === 'symbol') return value.description;
  if (value.kind === 'rational') {
    return value.denominator === 1n
      ? `${value.numerator}`
      : `${value.numerator}/${value.denominator}`;
  }
  if (value.kind === 'complex') {
    return `Complex(${render(value.real)}, ${render(value.imaginary)})`;
  }
  if (value.kind === 'expression') {
    return `${value.head.description}(${value.arguments.map(render).join(', ')})`;
  }
  return JSON.stringify(value);
}

function gcdOf(argsSource) {
  const { session, result } = run(`let r = E.polynomialGcd(${argsSource});`);
  if (result.status !== 'done') {
    throw new Error(`run ended ${result.status}: ${result.error?.message ?? ''}`);
  }
  return render(session.getExact(0, 'r'));
}

// ---------- Numeric leaves ----------

Deno.test("polynomialGcd: integers — gcd(12, 18) = 6", () => {
  assertEquals(gcdOf('12n, 18n'), '6');
});

Deno.test("polynomialGcd: rationals — gcd(4/3, 2/3) = 2/3", () => {
  assertEquals(gcdOf('Exact.rational(4n, 3n), Exact.rational(2n, 3n)'), '2/3');
});

Deno.test("polynomialGcd: rationals — gcd(1/2, 1/3) = 1/6 (gcd/lcm formula)", () => {
  assertEquals(gcdOf('Exact.rational(1n, 2n), Exact.rational(1n, 3n)'), '1/6');
});

Deno.test("polynomialGcd: Gaussian integers — gcd(2+2i, 4) = 2+2i", () => {
  assertEquals(gcdOf('Exact.complex(2n, 2n), 4n'), 'Complex(2, 2)');
});

Deno.test("polynomialGcd: Gaussian — gcd(5, 3+4i) is a proper Gaussian divisor", () => {
  // 5 = (2+i)(2-i); 3+4i = (2+i)². gcd = 2+i (up to the sign fix).
  assertEquals(gcdOf('5n, Exact.complex(3n, 4n)'), 'Complex(2, 1)');
});

Deno.test("polynomialGcd: general Complex pair is conservative 1", () => {
  assertEquals(gcdOf('Exact.complex(1n, 2n), Exact.rational(1n, 2n)'), '1');
});

// ---------- Univariate ----------

Deno.test("polynomialGcd: gcd(x² - 1, x - 1) = x - 1", () => {
  assertEquals(gcdOf('E.subtract(E.power(x, 2n), 1n), E.subtract(x, 1n)'), 'Add(x, -1)');
});

Deno.test("polynomialGcd: gcd(x³ + x, x² + 1) = x² + 1", () => {
  assertEquals(gcdOf('E.add(E.power(x, 3n), x), E.add(E.power(x, 2n), 1n)'),
    'Add(Power(x, 2), 1n)');
});

Deno.test("polynomialGcd: coprime inputs → 1", () => {
  assertEquals(gcdOf('E.add(x, 1n), E.add(x, 2n)'), '1');
});

Deno.test("polynomialGcd: primitive normalization strips integer content — gcd(2x+2, 4x+4) = x+1", () => {
  assertEquals(gcdOf('E.add(E.multiply(2n, x), 2n), E.add(E.multiply(4n, x), 4n)'),
    'Add(x, 1)');
});

Deno.test("polynomialGcd: rational coefficients — gcd(x/2 + 1/2, x + 1) = x + 1", () => {
  assertEquals(
    gcdOf('E.add(E.multiply(Exact.rational(1n, 2n), x), Exact.rational(1n, 2n)), E.add(x, 1n)'),
    'Add(x, 1)');
});

Deno.test("polynomialGcd: sign normalization — gcd(1 - x, x² - 1) has a positive leading coefficient", () => {
  assertEquals(gcdOf('E.subtract(1n, x), E.subtract(E.power(x, 2n), 1n)'), 'Add(x, -1)');
});

Deno.test("polynomialGcd: repeated roots — gcd((x+1)², (x+1)(x+2)) = x+1", () => {
  assertEquals(
    gcdOf('E.expand(E.power(E.add(x, 1n), 2n)), E.expand(E.multiply(E.add(x, 1n), E.add(x, 2n)))'),
    'Add(x, 1)');
});

// ---------- Identities ----------

Deno.test("polynomialGcd: gcd(a, 0) = a", () => {
  assertEquals(gcdOf('E.add(x, 1n), 0n'), 'Add(x, 1n)');
});

Deno.test("polynomialGcd: gcd(0, b) = b", () => {
  assertEquals(gcdOf('0n, E.add(x, 1n)'), 'Add(x, 1n)');
});

Deno.test("polynomialGcd: gcd(a, a) = a", () => {
  assertEquals(gcdOf('E.add(x, 1n), E.add(x, 1n)'), 'Add(x, 1n)');
});

Deno.test("polynomialGcd: commutative", () => {
  const forward = gcdOf('E.subtract(E.power(x, 2n), 1n), E.subtract(x, 1n)');
  const backward = gcdOf('E.subtract(x, 1n), E.subtract(E.power(x, 2n), 1n)');
  assertEquals(forward, backward);
});

Deno.test("polynomialGcd: gcd with a constant — gcd(5, 10x + 15) = 5", () => {
  assertEquals(gcdOf('5n, E.add(E.multiply(10n, x), 15n)'), '5');
});

// ---------- Multivariate ----------

Deno.test("polynomialGcd: gcd(xy, x²y) = xy", () => {
  assertEquals(gcdOf('E.multiply(x, y), E.multiply(E.power(x, 2n), y)'),
    'Multiply(x, y)');
});

Deno.test("polynomialGcd: content recursion — gcd(xy + x, y + 1) = y + 1", () => {
  assertEquals(gcdOf('E.add(E.multiply(x, y), x), E.add(y, 1n)'), 'Add(y, 1n)');
});

Deno.test("polynomialGcd: multivariate common factor — gcd((x+y)x, (x+y)y) = x + y", () => {
  assertEquals(
    gcdOf('E.expand(E.multiply(E.add(x, y), x)), E.expand(E.multiply(E.add(x, y), y))'),
    'Add(x, y)');
});

// ---------- Honorary atoms ----------

Deno.test("polynomialGcd: opaque atoms — gcd(Sin(x)², Sin(x)) = Sin(x)", () => {
  assertEquals(
    gcdOf("E.power(E.make(Symbol.for('Sin'), [x]), 2n), E.make(Symbol.for('Sin'), [x])"),
    'Sin(x)');
});

// ---------- Gaussian units (Ring 4d regression) ----------
//
// The Gaussian-Euclid branch used to return the UNIT i for coprime
// pairs like gcd(1, i) — the -1 sign normalization has no imaginary-
// axis mirror, and Q6's no-i-rotation rule was misapplied to units.
// A unit "gcd" fed the 3d Divide cancellation a divisor it could
// divide out forever: simplify(Divide(1, i)) presented as permanent
// memory pressure, and the symbolic form corrupted the heap mid-
// rewrite. Units normalize to 1; proper factors keep orientation.

Deno.test("polynomialGcd: coprime Gaussian pairs give 1, not a unit", () => {
  assertEquals(gcdOf('1n, Exact.i'), '1');
  assertEquals(gcdOf('Exact.i, 1n'), '1');
  assertEquals(gcdOf('Exact.complex(0n, -1n), 3n'), '1');
});

Deno.test("polynomialGcd: non-unit Gaussian factors keep their orientation", () => {
  assertEquals(gcdOf('Exact.complex(2n, 2n), 4n'), 'Complex(2, 2)');
});

Deno.test("simplify: Divide by i converges (the unit-gcd rewrite loop pin)", () => {
  const { session, result } = run(`
    let a = E.simplify(E.divide(1n, Exact.i));
    let aOk = Exact.equal(a, Exact.complex(0n, -1n));
    let b = E.simplify(E.divide(x, Exact.i));
    let bIsExpression = E.isExpression(b);
  `);
  assertEquals(result.status, 'done');
  assertEquals(session.get(0, 'aOk'), true);
  // x / i stays symbolic (Multiply(-i, x)) — the point is it terminates.
  assertEquals(session.get(0, 'bIsExpression'), true);
});

// ---------- Validation ----------

Deno.test("polynomialGcd: non-polynomial input throws TypeError", () => {
  const { result, error } = run('let r = E.polynomialGcd(E.divide(x, y), x);');
  assertEquals(result.status, 'error');
  assertEquals(error.type, 'TypeError');
});

Deno.test("polynomialGcd: missing argument throws TypeError", () => {
  const { result, error } = run('let r = E.polynomialGcd(x);');
  assertEquals(result.status, 'error');
  assertEquals(error.type, 'TypeError');
});

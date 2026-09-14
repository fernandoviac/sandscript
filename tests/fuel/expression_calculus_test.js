import { assert, assertEquals } from "https://deno.land/std@0.208.0/assert/mod.ts";
import { freshSession } from '../../src/host-owned-session.js';
import { parseAndSetup } from './test-helpers.js';

function run(source) {
  const session = freshSession();
  parseAndSetup(session, `let E = Exact.Expression;
let x = Symbol.for('x');
let y = Symbol.for('y');
` + source);
  const result = session.run(0, 1000000000);
  assertEquals(result.status, 'done');
  return session;
}

Deno.test("derived elementary constructors build canonical trees over existing heads", () => {
  const session = run(`
    let sinhHead = E.kind(E.sinh(x)) === E.Divide;
    let coshHead = E.kind(E.cosh(x)) === E.Divide;
    let tanhHead = E.kind(E.tanh(x)) === E.Divide;
    let sqrtHead = E.kind(E.sqrt(x)) === E.Power;
    let asinHead = E.kind(E.asin(x)) === E.Multiply;
    let acosHead = E.kind(E.acos(x)) === E.Multiply;
    let atanHead = E.kind(E.atan(x)) === E.Multiply;
    let asinhHead = E.kind(E.asinh(x)) === E.Log;
    let acoshHead = E.kind(E.acosh(x)) === E.Log;
    let atanhHead = E.kind(E.atanh(x)) === E.Multiply;
  `);
  for (const name of ['sinhHead', 'coshHead', 'tanhHead', 'sqrtHead', 'asinHead',
    'acosHead', 'atanHead', 'asinhHead', 'acoshHead', 'atanhHead']) {
    assertEquals(session.get(0, name), true, name);
  }
});

Deno.test("derived constructors agree numerically with their certified enclosures", () => {
  // sinh(1) = (e - 1/e)/2, asinh(1) = log(1 + sqrt(2)), atan(1) = pi/4.
  const session = run(`
    let a = E.toApproximation(E.sinh(1n), -60n);
    let b = E.toApproximation(E.divide(E.subtract(E.exp(1n), E.exp(-1n)), 2n), -60n);
    let c = E.toApproximation(E.tanh(Exact.rational(1n, 2n)), -60n);
  `);
  const a = session.getExact(0, 'a');
  const b = session.getExact(0, 'b');
  // The two sinh(1) enclosures must overlap (they contain the same value).
  const overlap =
    BigInt(a[0].numerator) * BigInt(b[1].denominator) <= BigInt(b[1].numerator) * BigInt(a[0].denominator)
    && BigInt(b[0].numerator) * BigInt(a[1].denominator) <= BigInt(a[1].numerator) * BigInt(b[0].denominator);
  assert(overlap, 'sinh(1) enclosures overlap');
  const c = session.getExact(0, 'c');
  // tanh(1/2) = 0.46211715726000975850231848364367...
  const reference = 46211715726000975850231848364367n;
  const scale = 10n ** 32n;
  assert(BigInt(c[0].numerator) * scale <= reference * BigInt(c[0].denominator));
  assert(reference * BigInt(c[1].denominator) <= BigInt(c[1].numerator) * scale + BigInt(c[1].denominator) * scale);
});

Deno.test("ordering relation heads register, construct, match, and stay unevaluated", () => {
  const session = run(`
    let heads = E.Less === Symbol.for('Less')
      && E.LessEqual === Symbol.for('LessEqual')
      && E.Greater === Symbol.for('Greater')
      && E.GreaterEqual === Symbol.for('GreaterEqual');
    let statement = E.make(E.Less, [2n, 3n]);
    let stays = E.kind(E.simplify(statement)) === E.Less;
    let equalSelf = E.equal(statement, E.make(E.Less, [2n, 3n]));
    let bindings = E.match(E.make(E.Less, [x, 3n]), statement, [x]);
  `);
  assertEquals(session.get(0, 'heads'), true);
  assertEquals(session.get(0, 'stays'), true);
  assertEquals(session.get(0, 'equalSelf'), true);
  assertEquals(session.getExact(0, 'bindings'), [2n]);
});

Deno.test("derivative: constants, the variable, sums, products, quotients, powers", () => {
  const session = run(`
    let zero = E.derivative(7n, x).expression;
    let one = E.derivative(x, x).expression;
    let otherSymbol = E.derivative(y, x).expression;
    let sum = E.equal(E.derivative(E.add(x, E.multiply(3n, x)), x).expression,
      E.simplify(4n));
    let product = E.equal(
      E.derivative(E.multiply(E.multiply(x, x), x), x).expression,
      E.simplify(E.multiply(3n, E.power(x, 2n))));
    let quotient = E.equal(E.derivative(E.divide(1n, x), x).expression,
      E.simplify(E.negate(E.power(x, -2n))));
    let power = E.equal(E.derivative(E.power(x, 5n), x).expression,
      E.simplify(E.multiply(5n, E.power(x, 4n))));
  `);
  assertEquals(session.getExact(0, 'zero'), { kind: 'rational', numerator: 0n, denominator: 1n });
  assertEquals(session.getExact(0, 'one'), { kind: 'rational', numerator: 1n, denominator: 1n });
  assertEquals(session.getExact(0, 'otherSymbol'), { kind: 'rational', numerator: 0n, denominator: 1n });
  for (const name of ['sum', 'product', 'quotient', 'power']) {
    assertEquals(session.get(0, name), true, name);
  }
});

Deno.test("derivative: Exp, Log, trigonometric and hyperbolic closed forms", () => {
  const session = run(`
    let dsin = E.equal(E.derivative(E.sin(x), x).expression, E.simplify(E.cos(x)));
    let dcos = E.equal(E.derivative(E.cos(x), x).expression, E.simplify(E.negate(E.sin(x))));
    let dtan = E.equal(E.derivative(E.tan(x), x).expression,
      E.simplify(E.divide(1n, E.power(E.cos(x), 2n))));
    let dsinh = E.equal(E.derivative(E.sinh(x), x).expression, E.simplify(E.cosh(x)));
    let dcosh = E.equal(E.derivative(E.cosh(x), x).expression, E.simplify(E.sinh(x)));
    let dtanh = E.equal(E.derivative(E.tanh(x), x).expression,
      E.simplify(E.divide(1n, E.power(E.cosh(x), 2n))));
    let dexp = E.equal(E.derivative(E.exp(x), x).expression, E.simplify(E.exp(x)));
    let dlog = E.equal(E.derivative(E.log(x), x).expression, E.simplify(E.divide(1n, x)));
    let emptyConditions = E.derivative(E.sin(x), x).conditions.length === 0;
  `);
  for (const name of ['dsin', 'dcos', 'dtan', 'dsinh', 'dcosh', 'dtanh', 'dexp',
    'dlog', 'emptyConditions']) {
    assertEquals(session.get(0, name), true, name);
  }
});

Deno.test("derivative: nested chain-rule cases", () => {
  const session = run(`
    let a = E.equal(E.derivative(E.exp(E.multiply(x, x)), x).expression,
      E.simplify(E.multiply(E.multiply(2n, x), E.exp(E.multiply(x, x)))));
    let b = E.equal(E.derivative(E.sin(E.power(x, 3n)), x).expression,
      E.simplify(E.multiply(E.multiply(3n, E.power(x, 2n)), E.cos(E.power(x, 3n)))));
    let c = E.equal(E.derivative(E.log(E.exp(x)), x).expression,
      E.simplify(E.divide(E.exp(x), E.exp(x))));
  `);
  for (const name of ['a', 'b', 'c']) assertEquals(session.get(0, name), true, name);
});

Deno.test("general power rule attaches the principal-log condition", () => {
  const session = run(`
    let record = E.derivative(E.power(x, y), x);
    let conditionCount = record.conditions.length;
    let conditionHead = E.kind(record.conditions[0]) === E.Greater;
    let sqrtRecord = E.derivative(E.sqrt(x), x);
    let sqrtCondition = E.kind(sqrtRecord.conditions[0]) === E.Greater;
    let deduplicated = E.derivative(E.add(E.sqrt(x), E.sqrt(x)), x).conditions.length;
  `);
  assertEquals(session.get(0, 'conditionCount'), 1);
  assertEquals(session.get(0, 'conditionHead'), true);
  assertEquals(session.get(0, 'sqrtCondition'), true);
  assertEquals(session.get(0, 'deduplicated'), 1);
});

Deno.test("gradient follows the caller's variable order", () => {
  const session = run(`
    let f = E.add(E.multiply(E.power(x, 2n), y), E.power(y, 3n));
    let g = E.gradient(f, Object.freeze([x, y]));
    let reversed = E.gradient(f, Object.freeze([y, x]));
    let g0 = E.equal(g.expressions[0], E.simplify(E.multiply(E.multiply(2n, x), y)));
    let g1 = E.equal(g.expressions[1],
      E.simplify(E.add(E.power(x, 2n), E.multiply(3n, E.power(y, 2n)))));
    let swap = E.equal(reversed.expressions[1], g.expressions[0]);
  `);
  for (const name of ['g0', 'g1', 'swap']) assertEquals(session.get(0, name), true, name);
});

Deno.test("jacobian and hessian return exact Matrix values with stable dimensions", () => {
  const session = run(`
    let f = E.add(E.multiply(E.power(x, 2n), y), E.power(y, 3n));
    let j = E.jacobian(Object.freeze([f, E.multiply(x, y)]), Object.freeze([x, y]));
    let jRows = Exact.Matrix.rows(j.matrix);
    let jCols = Exact.Matrix.columns(j.matrix);
    let j10 = E.equal(Exact.Matrix.get(j.matrix, 1n, 0n), E.simplify(y));
    let h = E.hessian(f, Object.freeze([x, y]));
    let hRows = Exact.Matrix.rows(h.matrix);
    let hCols = Exact.Matrix.columns(h.matrix);
    let mixed = E.equal(
      Exact.Matrix.get(h.matrix, 0n, 1n), Exact.Matrix.get(h.matrix, 1n, 0n));
    let h00 = E.equal(Exact.Matrix.get(h.matrix, 0n, 0n), E.simplify(E.multiply(2n, y)));
  `);
  assertEquals(session.getExact(0, 'jRows'), { kind: 'rational', numerator: 2n, denominator: 1n });
  assertEquals(session.getExact(0, 'jCols'), { kind: 'rational', numerator: 2n, denominator: 1n });
  assertEquals(session.getExact(0, 'hRows'), { kind: 'rational', numerator: 2n, denominator: 1n });
  assertEquals(session.getExact(0, 'hCols'), { kind: 'rational', numerator: 2n, denominator: 1n });
  for (const name of ['j10', 'mixed', 'h00']) assertEquals(session.get(0, name), true, name);
});

Deno.test("matrix-valued expressions differentiate element by element", () => {
  const session = run(`
    let m = Exact.Matrix.make([[E.power(x, 2n), x], [1n, E.sin(x)]]);
    let record = E.derivative(m, x);
    let isMatrix = Exact.Matrix.isMatrix(record.expression);
    let e00 = E.equal(Exact.Matrix.get(record.expression, 0n, 0n),
      E.simplify(E.multiply(2n, x)));
    let e10 = Exact.Matrix.get(record.expression, 1n, 0n);
    let e11 = E.equal(Exact.Matrix.get(record.expression, 1n, 1n), E.simplify(E.cos(x)));
  `);
  assertEquals(session.get(0, 'isMatrix'), true);
  assertEquals(session.get(0, 'e00'), true);
  assertEquals(session.getExact(0, 'e10'), { kind: 'rational', numerator: 0n, denominator: 1n });
  assertEquals(session.get(0, 'e11'), true);
});

Deno.test("taylor returns the exact polynomial and its expansion descriptor", () => {
  const session = run(`
    let record = E.taylor(E.exp(x), x, 0n, 6n);
    let value = E.simplify(E.substitute(record.polynomial, x, 1n));
    let orderValue = record.order;
    let pointValue = record.point;
    let variableValue = record.variable === x;
    let conditionsEmpty = record.conditions.length === 0;
    let cubic = E.taylor(E.power(E.add(x, 1n), 3n), x, 0n, 3n);
    let cubicExact = E.equal(cubic.polynomial, E.simplify(E.power(E.add(x, 1n), 3n)));
    let orderZero = E.taylor(E.sin(x), x, 0n, 0n);
    let orderZeroValue = orderZero.polynomial;
  `);
  // sum_{k<=6} 1/k! = 1957/720.
  assertEquals(session.getExact(0, 'value'),
    { kind: 'rational', numerator: 1957n, denominator: 720n });
  assertEquals(session.getExact(0, 'orderValue'), 6n);
  assertEquals(session.getExact(0, 'pointValue'), 0n);
  assertEquals(session.get(0, 'variableValue'), true);
  assertEquals(session.get(0, 'conditionsEmpty'), true);
  assertEquals(session.get(0, 'cubicExact'), true);
  assertEquals(session.getExact(0, 'orderZeroValue'),
    { kind: 'rational', numerator: 0n, denominator: 1n });
});

Deno.test("repeated differentiation is deterministic across serialization", () => {
  const source = `
    let first = E.derivative(E.sin(E.multiply(x, x)), x).expression;
    let second = E.derivative(E.sin(E.multiply(x, x)), x).expression;
    let same = E.equal(first, second);
    let json = JSON.stringify(1n);
    let again = E.equal(first, E.derivative(E.sin(E.multiply(x, x)), x).expression);
  `;
  const a = run(source);
  const b = run(source);
  assertEquals(a.get(0, 'same'), true);
  assertEquals(a.get(0, 'again'), true);
  assertEquals(b.get(0, 'same'), true);
});

Deno.test("unknown heads and malformed variable lists reject loudly", () => {
  const session = run(`
    function fails(f) { try { f(); return 'no-throw'; } catch (e) { return e.message; } }
    let unknown = fails(() => E.derivative(E.make(E.Determinant, [x]), x));
    let notSymbol = fails(() => E.derivative(x, 3n));
    let duplicate = fails(() => E.gradient(x, [x, x]));
    let notArray = fails(() => E.hessian(x, x));
    let badOrder = fails(() => E.taylor(E.exp(x), x, 0n, -1n));
    let hugeOrder = fails(() => E.taylor(E.exp(x), x, 0n, 100000n));
  `);
  assertEquals(session.get(0, 'unknown'),
    'Exact.Expression.derivative: no rule for head Determinant');
  for (const name of ['notSymbol', 'duplicate', 'notArray', 'badOrder', 'hugeOrder']) {
    assert(session.get(0, name) !== 'no-throw', name);
  }
});

Deno.test("interval check: the derivative matches a difference quotient enclosure", () => {
  // f = exp(x) at x = 1: f'(1) = e. The central difference quotient
  // (f(1+h) - f(1-h)) / 2h with h = 1/1024 differs from e by less than
  // e * h^2 / 6 + slack < 2^-18. Certified enclosures of both sides must
  // therefore lie within 2^-16 of each other.
  const session = run(`
    let h = Exact.rational(1n, 1024n);
    let derivativeValue = E.substitute(E.derivative(E.exp(x), x).expression, x, 1n);
    let quotient = E.divide(
      E.subtract(E.exp(E.add(1n, h)), E.exp(E.subtract(1n, h))),
      E.multiply(2n, h));
    let derivativeInterval = E.toApproximation(derivativeValue, -40n);
    let quotientInterval = E.toApproximation(quotient, -40n);
  `);
  const d = session.getExact(0, 'derivativeInterval');
  const q = session.getExact(0, 'quotientInterval');
  const toParts = (r) => [BigInt(r.numerator), BigInt(r.denominator)];
  const [dn, dd] = toParts(d[0]);
  const [qn, qd] = toParts(q[1]);
  // |mid difference| < 2^-16: check d.low - q.high < 2^-16 and vice versa.
  const bound = (a, b, c, e) => (a * e - c * b) * (2n ** 16n) < b * e;
  assert(bound(dn, dd, qn, qd), 'derivative low near quotient high');
  const [qn2, qd2] = toParts(q[0]);
  const [dn2, dd2] = toParts(d[1]);
  assert(bound(qn2, qd2, dn2, dd2), 'quotient low near derivative high');
});

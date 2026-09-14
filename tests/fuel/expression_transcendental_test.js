import { assertEquals } from "https://deno.land/std@0.208.0/assert/mod.ts";
import { freshSession } from '../../src/host-owned-session.js';
import { parseAndSetup } from './test-helpers.js';

function run(source) {
  const session = freshSession();
  parseAndSetup(session, source);
  const result = session.run(0, 1000000000);
  assertEquals(result.status, 'done');
  return session;
}

Deno.test("Exp and principal Log are registered unary heads", () => {
  const session = run(`
    let x = Symbol.for('x');
    let exponential = Exact.Expression.exp(x);
    let logarithm = Exact.Expression.log(x);
    let expHeadMatches = Exact.Expression.kind(exponential) === Exact.Expression.Exp;
    let logHeadMatches = Exact.Expression.kind(logarithm) === Exact.Expression.Log;
  `);
  assertEquals(session.get(0, 'expHeadMatches'), true);
  assertEquals(session.get(0, 'logHeadMatches'), true);
  assertEquals(session.getExact(0, 'exponential').head.description, 'Exp');
  assertEquals(session.getExact(0, 'logarithm').head.description, 'Log');
});

Deno.test("Sin, Cos, and Tan derive from Exp", () => {
  const session = run(`
    let x = Symbol.for('x');
    let sine = Exact.Expression.sin(x);
    let cosine = Exact.Expression.cos(x);
    let tangent = Exact.Expression.tan(x);
  `);
  const sine = session.getExact(0, 'sine');
  const cosine = session.getExact(0, 'cosine');
  const tangent = session.getExact(0, 'tangent');
  assertEquals(sine.head.description, 'Divide');
  assertEquals(sine.arguments[0].head.description, 'Subtract');
  assertEquals(sine.arguments[0].arguments[0].head.description, 'Exp');
  assertEquals(cosine.head.description, 'Divide');
  assertEquals(cosine.arguments[0].head.description, 'Add');
  assertEquals(tangent.head.description, 'Divide');
});

Deno.test("Exp zero simplifies exactly and returns a rational enclosure", () => {
  const session = run(`
    let value = Exact.Expression.simplify(Exact.Expression.exp(0n));
    let interval = Exact.Expression.toApproximation(Exact.Expression.exp(0n), -40n);
  `);
  assertEquals(session.getExact(0, 'value'), {
    kind: 'rational',
    numerator: 1n,
    denominator: 1n,
  });
  assertEquals(session.getExact(0, 'interval'), [
    { kind: 'rational', numerator: 1n, denominator: 1n },
    { kind: 'rational', numerator: 1n, denominator: 1n },
  ]);
});

Deno.test("Exp expressions round-trip through exact readback", () => {
  const session = run(`let value = Exact.Expression.exp(Symbol.for('x'));`);
  const value = session.getExact(0, 'value');
  assertEquals(value.kind, 'expression');
  assertEquals(value.head.description, 'Exp');
  assertEquals(value.arguments[0].description, 'x');
});


Deno.test("Sin substitution folds to the exact algebraic special point", () => {
  const session = run(`
    let x = Symbol.for('x');
    let symbolic = Exact.Expression.sin(x);
    let point = Exact.Expression.multiply(Exact.Pi, Exact.rational(1n, 3n));
    let substituted = Exact.Expression.substitute(symbolic, x, point);
    let value = Exact.Expression.simplify(substituted);
    let expected = Exact.AlgebraicNumber.sineOfTurns(Exact.rational(1n, 6n));
    let equal = Exact.AlgebraicNumber.equals(value, expected);
    let interval = Exact.Expression.toApproximation(substituted, -30n);
  `);
  assertEquals(session.get(0, 'equal'), true);
  const interval = session.getExact(0, 'interval');
  assertEquals(interval.length, 2);
});

Deno.test("Cosine and tangent fold at algebraic special angles", () => {
  for (const denominator of [4n, 5n, 6n, 8n, 12n]) {
    const session = freshSession({ heapSize: 8 * 1024 * 1024 });
    parseAndSetup(session, `
      let E = Exact.Expression;
      let A = Exact.AlgebraicNumber;
      let denominator = ${denominator}n;
      let angle = E.multiply(Exact.Pi, Exact.rational(1n, denominator));
      let turns = Exact.rational(1n, 2n * denominator);
      let cosine = E.simplify(E.cos(angle));
      let tangent = E.simplify(E.tan(angle));
      let expectedCosine = A.cosineOfTurns(turns);
      let expectedTangent = A.sineOfTurns(turns) / expectedCosine;
      let cosineMatches = A.equals(cosine, expectedCosine);
      let tangentMatches = A.equals(tangent, expectedTangent);
    `);
    let result = null;
    for (let attempt = 0; attempt < 20; attempt++) {
      result = session.run(0, 1000000000);
      if (result.status === 'done') break;
      if (result.status !== 'memory_pressure') break;
      session.gc();
    }
    assertEquals(result.status, 'done', `Pi/${denominator}`);
    assertEquals(session.get(0, 'cosineMatches'), true, `cos(Pi/${denominator})`);
    assertEquals(session.get(0, 'tangentMatches'), true, `tan(Pi/${denominator})`);
  }
});

Deno.test("simplify realizes a zero-imaginary complex fold to its real part", () => {
  // The Euler fold of sin(Pi/6) divides by 2i, so its exact arithmetic ends
  // in the complex 1/2 + 0i. simplify must realize that to the rational 1/2,
  // and toApproximation must return the degenerate real enclosure.
  const session = run(`
    let E = Exact.Expression;
    let x = Symbol.for('x');
    let point = E.substitute(E.sin(x), x, E.multiply(Exact.Pi, Exact.rational(1n, 6n)));
    let folded = E.simplify(point);
    let foldedType = Exact.typeOf(folded);
    let foldedIsHalf = E.equal(folded, Exact.rational(1n, 2n));
    let interval = E.toApproximation(point, -30n);
  `);
  assertEquals(session.get(0, 'foldedType'), 'rational');
  assertEquals(session.get(0, 'foldedIsHalf'), true);
  assertEquals(session.getExact(0, 'interval'), [
    { kind: 'rational', numerator: 1n, denominator: 2n },
    { kind: 'rational', numerator: 1n, denominator: 2n },
  ]);
});

Deno.test("Exp is opaque to polynomial operations", () => {
  const session = run(`
    let x = Symbol.for('x');
    let exponential = Exact.Expression.exp(x);
    let polynomial = Exact.Expression.isPolynomial(exponential, x);
    let expanded = Exact.Expression.expand(exponential);
    let unchanged = Exact.Expression.equal(exponential, expanded);
  `);
  assertEquals(session.get(0, 'polynomial'), true);
  assertEquals(session.get(0, 'unchanged'), true);
});
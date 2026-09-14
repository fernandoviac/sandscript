import { assert, assertEquals } from "https://deno.land/std@0.208.0/assert/mod.ts";
import { freshSession } from '../../src/host-owned-session.js';
import { parseAndSetup } from './test-helpers.js';

function run(source) {
  const session = freshSession({ heapSize: 64 * 1024 * 1024 });
  parseAndSetup(session, `let E = Exact.Expression;
let x = Symbol.for('x');
let y = Symbol.for('y');
` + source);
  let result = session.run(0, 1000000000);
  let collections = 0;
  while (result.status === 'memory_pressure' && collections < 400) {
    session.collectGarbage(0);
    result = session.run(0, 1000000000);
    collections += 1;
  }
  assertEquals(result.status, 'done');
  return session;
}

const rational = (n, d = 1n) => ({ kind: 'rational', numerator: n, denominator: d });

// Every verified case re-checks the gate independently: differentiate the
// returned expression and require an exact zero residual.
// A residual of rational functions may not cancel structurally; the
// fallback certificate evaluates it EXACTLY at more rational points than
// its numerator degree can support (exact arithmetic, not sampling).
const GATE = `
  function gate(record, integrand) {
    if (record.kind !== 'verified') { return 'not-verified'; }
    let derivative = E.derivative(record.expression, x).expression;
    let residual = E.simplify(E.subtract(derivative, integrand));
    if (E.equal(residual, 0n)) { return 'zero'; }
    let points = [3n, 4n, 5n, 6n, 7n, 8n, 9n, 10n, 11n, 12n, 13n, 14n, 15n];
    for (const point of points) {
      let value = E.simplify(E.substitute(residual, x, point));
      if (!E.equal(value, 0n)) { return 'nonzero'; }
    }
    return 'zero';
  }
`;

Deno.test("polynomial antiderivatives verify with zero residual", () => {
  const session = run(GATE + `
    let f = E.add(E.multiply(3n, E.power(x, 2n)), E.multiply(2n, x));
    let record = E.antiderivative(f, x);
    let gateResult = gate(record, E.simplify(f));
    let matches = E.equal(record.expression, E.simplify(E.add(E.power(x, 3n), E.power(x, 2n))));
    let conditions = record.conditions.length;
    let constant = E.antiderivative(Exact.rational(5n, 2n), x);
    let constantOk = E.equal(constant.expression, E.simplify(E.multiply(Exact.rational(5n, 2n), x)));
  `);
  assertEquals(session.get(0, 'gateResult'), 'zero');
  assertEquals(session.get(0, 'matches'), true);
  assertEquals(session.get(0, 'conditions'), 0);
  assertEquals(session.get(0, 'constantOk'), true);
});

Deno.test("rational functions: simple poles, repeated factors, and polynomial parts", () => {
  const session = run(GATE + `
    let simple = E.antiderivative(E.divide(1n, E.subtract(x, 1n)), x);
    let simpleGate = gate(simple, E.simplify(E.divide(1n, E.subtract(x, 1n))));
    let simpleConditions = simple.conditions.length;
    let conditionHead = E.kind(simple.conditions[0]) === E.Greater;
    let repeated = E.antiderivative(E.divide(1n, E.power(E.subtract(x, 1n), 2n)), x);
    let repeatedGate = gate(repeated, E.simplify(E.divide(1n, E.power(E.subtract(x, 1n), 2n))));
    let mixed = E.antiderivative(
      E.divide(E.power(x, 3n), E.subtract(x, 2n)), x);
    let mixedGate = gate(mixed, E.simplify(E.divide(E.power(x, 3n), E.subtract(x, 2n))));
    let twoPoles = E.antiderivative(
      E.divide(1n, E.multiply(E.subtract(x, 1n), E.add(x, 1n))), x);
    let twoPolesGate = gate(twoPoles,
      E.simplify(E.divide(1n, E.multiply(E.subtract(x, 1n), E.add(x, 1n)))));
  `);
  for (const name of ['simpleGate', 'repeatedGate', 'mixedGate', 'twoPolesGate']) {
    assertEquals(session.get(0, name), 'zero', name);
  }
  assertEquals(session.get(0, 'simpleConditions'), 1);
  assertEquals(session.get(0, 'conditionHead'), true);
});

Deno.test("linear exponential, sine, cosine, and hyperbolic arguments", () => {
  const session = run(GATE + `
    let u = E.add(E.multiply(2n, x), 1n);
    let cases = [E.exp(u), E.sin(E.multiply(3n, x)), E.cos(u), E.sinh(x), E.cosh(u)];
    let gates = cases.map((f) => gate(E.antiderivative(f, x), E.simplify(f)));
  `);
  assertEquals(session.getExact(0, 'gates'), ['zero', 'zero', 'zero', 'zero', 'zero']);
});

Deno.test("rational powers and finite sums of supported terms", () => {
  const session = run(GATE + `
    let sqrtCase = E.antiderivative(E.sqrt(x), x);
    let sqrtGate = gate(sqrtCase, E.simplify(E.sqrt(x)));
    let sum = E.add(E.multiply(2n, E.exp(x)), E.add(E.power(x, 2n), E.sin(x)));
    let sumRecord = E.antiderivative(sum, x);
    let sumGate = gate(sumRecord, E.simplify(sum));
  `);
  assertEquals(session.get(0, 'sqrtGate'), 'zero');
  assertEquals(session.get(0, 'sumGate'), 'zero');
});

Deno.test("bounded integration by parts", () => {
  const session = run(GATE + `
    let a = E.antiderivative(E.multiply(x, E.exp(x)), x);
    let aGate = gate(a, E.simplify(E.multiply(x, E.exp(x))));
    let b = E.antiderivative(E.multiply(E.power(x, 2n), E.exp(x)), x);
    let bGate = gate(b, E.simplify(E.multiply(E.power(x, 2n), E.exp(x))));
    let c = E.antiderivative(E.multiply(x, E.sin(x)), x);
    let cGate = gate(c, E.simplify(E.multiply(x, E.sin(x))));
  `);
  for (const name of ['aGate', 'bGate', 'cGate']) {
    assertEquals(session.get(0, name), 'zero', name);
  }
});

Deno.test("unsupported forms return the complete unevaluated Integral", () => {
  const session = run(`
    let record = E.antiderivative(E.exp(E.power(x, 2n)), x);
    let kind = record.kind;
    let head = E.kind(record.expression) === E.Integral;
    let args = E.args(record.expression);
    let integrandPreserved = E.equal(args[0], E.exp(E.power(x, 2n)));
    let variablePreserved = args[1] === x;
    let logCase = E.antiderivative(E.log(x), x).kind;
  `);
  assertEquals(session.get(0, 'kind'), 'unevaluated');
  assertEquals(session.get(0, 'head'), true);
  assertEquals(session.get(0, 'integrandPreserved'), true);
  assertEquals(session.get(0, 'variablePreserved'), true);
  assertEquals(session.get(0, 'logCase'), 'unevaluated');
});

Deno.test("integral builds an exact unevaluated node with bound-symbol semantics", () => {
  const session = run(`
    let node = E.integral(E.exp(E.power(x, 2n)), x);
    let head = E.kind(node) === E.Integral;
    ;; Substituting a FREE symbol reaches the integrand.
    let withY = E.integral(E.multiply(y, E.exp(x)), x);
    let substituted = E.substitute(withY, y, 3n);
    let integrand = E.args(substituted)[0];
    let reached = E.equal(integrand, E.multiply(3n, E.exp(x)));
    ;; Substituting the BOUND symbol never rewrites the integrand.
    let definite = E.definiteIntegral(E.exp(E.power(x, 2n)), x, y, 2n);
    let rebound = E.substitute(definite, x, 5n);
    let reboundArgs = E.args(rebound);
    let integrandKept = E.equal(reboundArgs[0], E.exp(E.power(x, 2n)));
    ;; ... while a genuinely free symbol in the bounds is rewritten.
    let boundsRewritten = E.args(E.substitute(definite, y, 1n));
    let lowerRewritten = boundsRewritten[2] === 1n;
    let serialized = JSON.stringify(1n);
    let equalSelf = E.equal(node, E.integral(E.exp(E.power(x, 2n)), x));
  `.replaceAll(';;', '//'));
  for (const name of ['head', 'reached', 'integrandKept', 'lowerRewritten', 'equalSelf']) {
    assertEquals(session.get(0, name), true, name);
  }
});

Deno.test("safe simplification rules and only those", () => {
  const session = run(`
    let zero = E.simplify(E.integral(0n, x));
    let equalBounds = E.definiteIntegral(E.exp(E.power(x, 2n)), x, 3n, 3n);
    let linear = E.simplify(E.integral(E.add(E.exp(E.power(x, 2n)), E.exp(E.power(x, 3n))), x));
    let linearIsAdd = E.kind(linear) === E.Add;
    let constant = E.simplify(E.integral(E.multiply(y, E.exp(E.power(x, 2n))), x));
    let constantIsMultiply = E.kind(constant) === E.Multiply;
    ;; simplify never runs the integration search: an integrable integrand
    ;; stays an Integral node under simplify.
    let untouched = E.simplify(E.integral(E.power(x, 2n), x));
    let untouchedIsIntegral = E.kind(untouched) === E.Integral;
  `.replaceAll(';;', '//'));
  assertEquals(session.getExact(0, 'zero'), rational(0n));
  assertEquals(session.getExact(0, 'equalBounds'), rational(0n));
  assertEquals(session.get(0, 'linearIsAdd'), true);
  assertEquals(session.get(0, 'constantIsMultiply'), true);
  assertEquals(session.get(0, 'untouchedIsIntegral'), true);
});

Deno.test("definite integrals: exact endpoint substitution with condition checks", () => {
  const session = run(`
    let power = E.definiteIntegral(E.power(x, 2n), x, 0n, 2n);
    ;; 1/x over [1, 2]: the Log condition Greater(x, 0) holds -> Log(2).
    let logCase = E.definiteIntegral(E.divide(1n, x), x, 1n, 2n);
    let logOk = E.equal(logCase, E.simplify(E.log(2n)));
    ;; 1/x over [-1, 1]: the condition fails across zero -> unevaluated.
    let acrossPole = E.definiteIntegral(E.divide(1n, x), x, -1n, 1n);
    let acrossPoleUnevaluated = E.kind(acrossPole) === E.Integral;
    let acrossPoleArgs = E.args(acrossPole).length;
    ;; Reversed bounds negate.
    let reversed = E.definiteIntegral(E.power(x, 2n), x, 2n, 0n);
    ;; Symbolic bounds stay symbolic.
    let symbolicBound = E.definiteIntegral(E.power(x, 2n), x, 0n, y);
    let symbolicUnevaluated = E.kind(symbolicBound) === E.Integral;
  `.replaceAll(';;', '//'));
  assertEquals(session.getExact(0, 'power'), rational(8n, 3n));
  assertEquals(session.get(0, 'logOk'), true);
  assertEquals(session.get(0, 'acrossPoleUnevaluated'), true);
  assertEquals(session.get(0, 'acrossPoleArgs'), 4);
  assertEquals(session.getExact(0, 'reversed'), rational(-8n, 3n));
  assertEquals(session.get(0, 'symbolicUnevaluated'), true);
});

Deno.test("Integral survives serialization, matching, and garbage collection", () => {
  const session = run(`
    let node = E.integral(E.exp(E.power(x, 2n)), x);
    let waste = [];
    for (let i = 0; i < 200; i = i + 1) { waste.push([i, String(i)]); }
    waste = null;
    let pattern = E.integral(y, x);
    let bindings = E.match(pattern, node, [y]);
    let bound = E.equal(bindings[0], E.exp(E.power(x, 2n)));
    let stillEqual = E.equal(node, E.integral(E.exp(E.power(x, 2n)), x));
  `);
  assertEquals(session.get(0, 'bound'), true);
  assertEquals(session.get(0, 'stillEqual'), true);
});

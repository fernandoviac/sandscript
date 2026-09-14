import { assertEquals } from "https://deno.land/std@0.208.0/assert/mod.ts";
import { freshSession } from "../../src/host-owned-session.js";
import { parseAndSetup } from "./test-helpers.js";

function simplify(expressionSource, additionalSource = "") {
  const session = freshSession({ heapSize: 64 * 1024 * 1024 });
  parseAndSetup(
    session,
    `
    let E = Exact.Expression;
    let half = Exact.rational(1n, 2n);
    let third = Exact.rational(1n, 3n);
    let quarter = Exact.rational(1n, 4n);
    let x = Symbol.for('x');
    let y = Symbol.for('y');
    let z = Symbol.for('z');
    ${additionalSource}
    let result = E.simplify(${expressionSource});
  `,
  );
  const execution = session.run(0, 100000000);
  if (execution.status !== "done") throw new Error(JSON.stringify(execution));
  return { session, value: session.getExact(0, "result") };
}

function formatExact(value) {
  if (typeof value === "bigint") return `${value}`;
  if (typeof value === "number") return `${value}`;
  if (value.kind === "rational") {
    return value.denominator === 1n
      ? `${value.numerator}`
      : `${value.numerator}/${value.denominator}`;
  }
  if (value.kind === "symbol") return value.description;
  if (value.kind === "expression") {
    return `${value.head.description}(${
      value.arguments.map(formatExact).join(",")
    })`;
  }
  if (value.kind === "complex") {
    return `Complex(${formatExact(value.real)},${
      formatExact(value.imaginary)
    })`;
  }
  return value.kind;
}

function simplifiedText(expressionSource, additionalSource = "") {
  return formatExact(simplify(expressionSource, additionalSource).value);
}

Deno.test("radical decision: sqrt(2) times sqrt(8) folds to 4", () => {
  assertEquals(
    simplifiedText("E.multiply(E.power(2n, half), E.power(8n, half))"),
    "4",
  );
});

Deno.test("radical decision: identical square roots subtract to zero", () => {
  assertEquals(
    simplifiedText("E.subtract(E.power(2n, half), E.power(2n, half))"),
    "0",
  );
});

Deno.test("radical decision: cube roots of 2 and 4 multiply to 2", () => {
  assertEquals(
    simplifiedText("E.multiply(E.power(2n, third), E.power(4n, third))"),
    "2",
  );
});

Deno.test("radical decision: a nonzero radical divided by itself folds to one", () => {
  assertEquals(
    simplifiedText("E.divide(E.power(2n, half), E.power(2n, half))"),
    "1",
  );
});

Deno.test("radical decision: additive inverse radicals fold to zero", () => {
  assertEquals(
    simplifiedText("E.add(E.power(3n, half), E.negate(E.power(3n, half)))"),
    "0",
  );
});

Deno.test("radical decision: a rational result reached through a degree-two field folds exactly", () => {
  assertEquals(
    simplifiedText(
      "E.add(E.multiply(E.power(2n, half), E.power(8n, half)), 3n)",
    ),
    "7",
  );
});

Deno.test("radical decision: scalar multiple identity folds exactly", () => {
  assertEquals(
    simplifiedText(
      "E.subtract(E.multiply(2n, E.power(2n, half)), E.power(8n, half))",
    ),
    "0",
  );
});

Deno.test("radical decision: conjugate product folds to negative six", () => {
  assertEquals(
    simplifiedText(`E.multiply(
    E.add(E.power(2n, half), E.power(8n, half)),
    E.subtract(E.power(2n, half), E.power(8n, half)))`),
    "-6",
  );
});

Deno.test("radical decision: fourth-root product with rational value folds", () => {
  assertEquals(
    simplifiedText("E.multiply(E.power(2n, quarter), E.power(8n, quarter))"),
    "2",
  );
});

Deno.test("radical decision: a folded result is an idempotent simplify fixed point", () => {
  const session = simplify(
    "E.multiply(E.power(2n, half), E.power(8n, half))",
    "let original = E.multiply(E.power(2n, half), E.power(8n, half));",
  );
  parseAndSetup(
    session.session,
    "let fixed = E.equal(Exact.Expression.simplify(result), result);",
  );
  const execution = session.session.run(0, 1000000);
  assertEquals(execution.status, "done");
  assertEquals(session.session.get(0, "fixed"), true);
});

Deno.test("radical decision: an irrational square root remains symbolic", () => {
  assertEquals(simplifiedText("E.power(2n, half)"), "Power(2,1/2)");
});

Deno.test("radical decision: sqrt(2) plus sqrt(8) remains symbolic", () => {
  assertEquals(
    simplifiedText("E.add(E.power(2n, half), E.power(8n, half))"),
    "Add(Power(2,1/2),Power(8,1/2))",
  );
});

Deno.test("radical decision: sqrt(2) minus sqrt(8) remains symbolic", () => {
  assertEquals(
    simplifiedText("E.subtract(E.power(2n, half), E.power(8n, half))"),
    "Add(Power(2,1/2),Multiply(-1,Power(8,1/2)))",
  );
});

Deno.test("radical decision: nested irrational radical remains in expression form", () => {
  assertEquals(
    simplifiedText("E.power(E.power(2n, half), half)"),
    "Power(Power(2,1/2),1/2)",
  );
});

Deno.test("radical decision: negative even root is a quiet symbolic refusal", () => {
  assertEquals(simplifiedText("E.power(-2n, half)"), "Power(-2,1/2)");
});

Deno.test("radical decision: division by zero is a quiet symbolic refusal", () => {
  assertEquals(
    simplifiedText("E.divide(E.power(2n, half), 0n)"),
    "Multiply(Power(0,-1),Power(2,1/2))",
  );
});

Deno.test("radical decision: an opaque parent still simplifies a maximal radical child", () => {
  assertEquals(
    simplifiedText(
      "E.make(Symbol.for('Sin'), [E.multiply(E.power(2n, half), E.power(8n, half))])",
    ),
    "Sin(4)",
  );
});

Deno.test("radical decision: a symbolic parent bounds the exact child region", () => {
  assertEquals(
    simplifiedText(
      "E.add(x, E.multiply(E.power(2n, half), E.power(8n, half)))",
    ),
    "Add(x,4)",
  );
});

Deno.test("radical decision: an irrational maximal region is not partially evaluated", () => {
  assertEquals(
    simplifiedText(
      "E.add(E.multiply(E.power(2n, half), E.power(8n, half)), E.power(3n, half))",
    ),
    "Add(Power(3,1/2),Power(16,1/2))",
  );
});

Deno.test("radical decision: an invalid maximal region is not partially evaluated", () => {
  assertEquals(
    simplifiedText(
      "E.add(E.power(-1n, half), E.multiply(E.power(2n, half), E.power(8n, half)))",
    ),
    "Add(Power(-1,1/2),Power(16,1/2))",
  );
});

Deno.test("radical decision: Complex input remains outside the exact-real evaluator", () => {
  assertEquals(
    simplifiedText("E.power(Exact.complex(1n, 1n), half)"),
    "Power(Complex(1,1),1/2)",
  );
});

Deno.test("radical canonicalization: same-base rational exponents add", () => {
  assertEquals(
    simplifiedText("E.multiply(E.power(x, half), E.power(x, third))"),
    "Power(x,5/6)",
  );
});

Deno.test("radical canonicalization: two same-base half powers collapse to the base", () => {
  assertEquals(
    simplifiedText("E.multiply(E.power(x, half), E.power(x, half))"),
    "x",
  );
});

Deno.test("radical canonicalization: opposite fractional powers cancel", () => {
  assertEquals(
    simplifiedText(
      "E.multiply(E.power(x, Exact.rational(2n, 3n)), E.power(x, Exact.rational(-2n, 3n)))",
    ),
    "1",
  );
});

Deno.test("radical canonicalization: odd-denominator equal exponents combine unknown bases", () => {
  assertEquals(
    simplifiedText("E.multiply(E.power(x, third), E.power(y, third))"),
    "Power(Multiply(x,y),1/3)",
  );
});

Deno.test("radical canonicalization: even-denominator equal exponents preserve unknown branches", () => {
  assertEquals(
    simplifiedText("E.multiply(E.power(x, half), E.power(y, half))"),
    "Multiply(Power(x,1/2),Power(y,1/2))",
  );
});

Deno.test("radical canonicalization: even-denominator exponents combine squared bases", () => {
  assertEquals(
    simplifiedText(
      "E.multiply(E.power(E.power(x, 2n), half), E.power(E.power(y, 2n), half))",
    ),
    "Power(Multiply(Power(x,2),Power(y,2)),1/2)",
  );
});

Deno.test("radical canonicalization: positive numeric bases combine under square roots", () => {
  assertEquals(
    simplifiedText("E.multiply(E.power(2n, half), E.power(3n, half))"),
    "Power(6,1/2)",
  );
});

Deno.test("radical canonicalization: negative numeric bases refuse even-denominator combination", () => {
  assertEquals(
    simplifiedText("E.multiply(E.power(-2n, half), E.power(-3n, half))"),
    "Multiply(Power(-3,1/2),Power(-2,1/2))",
  );
});

Deno.test("radical canonicalization: three odd-denominator powers combine in one pass", () => {
  assertEquals(
    simplifiedText(
      "E.make(E.Multiply, [E.power(x, third), E.power(y, third), E.power(z, third)])",
    ),
    "Power(Multiply(x,y,z),1/3)",
  );
});

Deno.test("radical canonicalization: distinct bases with distinct exponents stay separate", () => {
  assertEquals(
    simplifiedText("E.multiply(E.power(x, half), E.power(y, third))"),
    "Multiply(Power(x,1/2),Power(y,1/3))",
  );
});

Deno.test("radical canonicalization: combined odd-root form is idempotent", () => {
  const { session } = simplify(
    "E.multiply(E.power(x, third), E.power(y, third))",
  );
  parseAndSetup(session, "let fixed = E.equal(E.simplify(result), result);");
  const execution = session.run(0, 1000000);
  assertEquals(execution.status, "done");
  assertEquals(session.get(0, "fixed"), true);
});

Deno.test("radical simplification result survives both collectors", () => {
  for (const gcCollector of ["wat", "js"]) {
    const session = freshSession({ heapSize: 1024 * 1024, gcCollector });
    parseAndSetup(
      session,
      `
      let E = Exact.Expression;
      let half = Exact.rational(1n, 2n);
      let result = E.simplify(E.multiply(E.power(2n, half), E.power(8n, half)));
    `,
    );
    const execution = session.run(0, 100000000);
    assertEquals(execution.status, "done");
    session.gc();
    assertEquals(formatExact(session.getExact(0, "result")), "4");
  }
});

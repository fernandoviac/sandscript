import { assertEquals } from "https://deno.land/std@0.208.0/assert/mod.ts";
import { freshSession } from "../../src/host-owned-session.js";
import { parseAndSetup } from "./test-helpers.js";

const EXACTAS_HEAP_SIZE = 8 * 1024 * 1024;
const EXACTAS_FUEL_GRANT = 20_000_000;

function runContract(source, options = {}) {
  const session = freshSession({
    heapSize: options.heapSize ?? EXACTAS_HEAP_SIZE,
    ...(options.gcCollector ? { gcCollector: options.gcCollector } : {}),
  });
  try {
    parseAndSetup(session, source);
    return {
      session,
      result: session.run(0, options.fuel ?? EXACTAS_FUEL_GRANT),
      hostError: null,
    };
  } catch (hostError) {
    return { session, result: null, hostError };
  }
}

function assertContractDone(contract, label) {
  assertEquals(contract.hostError, null, `${label}: host exception`);
  assertEquals(contract.result.status, "done", `${label}: execution status`);
}

const EXACT_NUMERIC_SETUP = `
  let E = Exact.Expression;
  let A = Exact.AlgebraicNumber;
  let C = Exact.ComplexAlgebraicNumber;
  let sqrt2 = A.squareRoot(2n);
  let complexAlgebraic = C.fromParts(sqrt2, 1n);
`;

const NUMERIC_FIXTURES = [
  { name: "bigint", source: "2n" },
  { name: "rational", source: "Exact.rational(2n, 3n)" },
  { name: "complex", source: "Exact.complex(1n, 1n)" },
  { name: "algebraic", source: "sqrt2" },
  { name: "complex-algebraic", source: "complexAlgebraic" },
];

const BINARY_NUMERIC_HEADS = [
  { name: "Add", method: "add", operator: "+" },
  { name: "Subtract", method: "subtract", operator: "-" },
  { name: "Multiply", method: "multiply", operator: "*" },
  { name: "Divide", method: "divide", operator: "/" },
];

Deno.test("exact surface matrix: ordered numeric pairs match exact operators", () => {
  for (const head of BINARY_NUMERIC_HEADS) {
    for (const left of NUMERIC_FIXTURES) {
      for (const right of NUMERIC_FIXTURES) {
        const label = `${head.name}(${left.name}, ${right.name})`;
        const contract = runContract(
          EXACT_NUMERIC_SETUP + `
          let left = ${left.source};
          let right = ${right.source};
          let folded = E.simplify(E.${head.method}(left, right));
          let expected = left ${head.operator} right;
          let matches = C.equals(folded, expected);
        `,
          { heapSize: 32 * 1024 * 1024 },
        );
        assertContractDone(contract, label);
        assertEquals(contract.session.get(0, "matches"), true, label);
      }
    }
  }
});

const POWER_CASES = [
  {
    name: "integer power",
    expression: "E.power(2n, 3n)",
    outcome: "exact",
    expected: "8n",
  },
  {
    name: "algebraic square",
    expression: "E.power(sqrt2, 2n)",
    outcome: "exact",
    expected: "2n",
  },
  {
    name: "complex square",
    expression: "E.power(Exact.i, 2n)",
    outcome: "exact",
    expected: "-1n",
  },
  {
    name: "symbolic power",
    expression: "E.power(Symbol.for('x'), 2n)",
    outcome: "head",
    expected: "Power",
  },
  {
    name: "defined zero exponent",
    expression: "E.power(7n, 0n)",
    outcome: "exact",
    expected: "1n",
  },
  {
    name: "zero reciprocal",
    expression: "E.power(0n, -1n)",
    outcome: "head",
    expected: "Power",
  },
];

Deno.test("exact surface matrix: Power and Negate own explicit contracts", () => {
  for (const testCase of POWER_CASES) {
    const contract = runContract(
      EXACT_NUMERIC_SETUP + `
      let folded = E.simplify(${testCase.expression});
      let matches = ${
        testCase.outcome === "exact"
          ? `C.equals(folded, ${testCase.expected})`
          : `Exact.typeOf(folded) === 'expression' && E.kind(folded).description === '${testCase.expected}'`
      };
    `,
    );
    assertContractDone(contract, testCase.name);
    assertEquals(contract.session.get(0, "matches"), true, testCase.name);
  }

  for (const fixture of NUMERIC_FIXTURES) {
    const label = `Negate(${fixture.name})`;
    const contract = runContract(
      EXACT_NUMERIC_SETUP + `
      let value = ${fixture.source};
      let folded = E.simplify(E.negate(value));
      let matches = C.equals(folded, 0n - value);
    `,
      { heapSize: 32 * 1024 * 1024 },
    );
    assertContractDone(contract, label);
    assertEquals(contract.session.get(0, "matches"), true, label);
  }
});

Deno.test("exact surface matrix: symbolic, matrix, float, and undefined boundaries", () => {
  const contract = runContract(`
    let E = Exact.Expression;
    let x = Symbol.for('x');
    let symbolicAdd = E.simplify(E.add(x, 2n));
    let symbolicDivide = E.simplify(E.divide(2n, x));
    let matrix = Exact.Matrix.make([[1n, 2n], [3n, 4n]]);
    let matrixAdd = E.simplify(E.add(matrix, matrix));
    let matrixMultiply = E.simplify(E.multiply(matrix, matrix));
    let floatRefusal = '';
    try { E.add(1.5, 2n); } catch (error) { floatRefusal = error.name; }
    let undefinedValue = E.simplify(E.divide(0n, 0n));
    let undefinedSubtract = E.simplify(E.subtract(undefinedValue, undefinedValue));
    let undefinedPower = E.simplify(E.power(undefinedValue, 0n));
    let outcomes = [
      Exact.typeOf(symbolicAdd),
      E.kind(symbolicDivide).description,
      Exact.typeOf(matrixAdd),
      Exact.typeOf(matrixMultiply),
      floatRefusal,
      E.kind(undefinedSubtract).description,
      E.kind(undefinedPower).description,
    ];
  `);
  assertContractDone(contract, "boundary matrix");
  assertEquals(contract.session.getExact(0, "outcomes"), [
    "expression",
    "Multiply",
    "expression",
    "expression",
    "TypeError",
    "Add",
    "Power",
  ]);
});

const TRIGONOMETRIC_CASES = [
  {
    denominator: 1n,
    extra:
      "C.equals(cosine, -1n) && C.equals(sine, 0n) && C.equals(tangent, 0n)",
  },
  { denominator: 2n, pole: true },
  {
    denominator: 3n,
    extra:
      "C.equals(cosine, Exact.rational(1n, 2n)) && C.equals(sine * sine, Exact.rational(3n, 4n)) && C.equals(tangent * tangent, 3n)",
  },
  {
    denominator: 4n,
    extra:
      "C.equals(cosine, sine) && C.equals(cosine * cosine, Exact.rational(1n, 2n)) && C.equals(tangent, 1n)",
  },
  {
    denominator: 5n,
    bounds: [
      "Exact.rational(4n, 5n)",
      "Exact.rational(9n, 10n)",
      "Exact.rational(1n, 2n)",
      "Exact.rational(3n, 5n)",
      "Exact.rational(7n, 10n)",
      "Exact.rational(4n, 5n)",
    ],
  },
  {
    denominator: 6n,
    extra:
      "C.equals(cosine * cosine, Exact.rational(3n, 4n)) && C.equals(sine, Exact.rational(1n, 2n)) && C.equals(tangent * tangent, Exact.rational(1n, 3n))",
  },
  {
    denominator: 8n,
    bounds: [
      "Exact.rational(9n, 10n)",
      "1n",
      "Exact.rational(3n, 10n)",
      "Exact.rational(2n, 5n)",
      "Exact.rational(2n, 5n)",
      "Exact.rational(1n, 2n)",
    ],
  },
  {
    denominator: 12n,
    bounds: [
      "Exact.rational(9n, 10n)",
      "1n",
      "Exact.rational(1n, 5n)",
      "Exact.rational(3n, 10n)",
      "Exact.rational(1n, 5n)",
      "Exact.rational(3n, 10n)",
    ],
  },
];

Deno.test("exact surface matrix: trigonometric fixtures use independent identities and bounds", () => {
  for (const testCase of TRIGONOMETRIC_CASES) {
    const denominator = testCase.denominator;
    const boundsCheck = testCase.bounds
      ? `A.compare(cosine, ${testCase.bounds[0]}) > 0
          && A.compare(cosine, ${testCase.bounds[1]}) < 0
          && A.compare(sine, ${testCase.bounds[2]}) > 0
          && A.compare(sine, ${testCase.bounds[3]}) < 0
          && A.compare(tangent, ${testCase.bounds[4]}) > 0
          && A.compare(tangent, ${testCase.bounds[5]}) < 0`
      : "true";
    const contract = runContract(
      `
      let E = Exact.Expression;
      let A = Exact.AlgebraicNumber;
      let C = Exact.ComplexAlgebraicNumber;
      let angle = E.multiply(Exact.Pi, Exact.rational(1n, ${denominator}n));
      let cosine = E.simplify(E.cos(angle));
      let sine = E.simplify(E.sin(angle));
      let tangent = E.simplify(E.tan(angle));
      let identityMatches = C.equals(cosine * cosine + sine * sine, 1n);
      let tangentIdentityMatches = ${
        testCase.pole ? "true" : "C.equals(tangent * cosine, sine)"
      };
      let fixedMatches = ${testCase.extra ?? boundsCheck};
      let poleType = '';
      let poleMessage = '';
      if (${testCase.pole ? "true" : "false"}) {
        try { E.toApproximation(tangent, -20n); }
        catch (error) { poleType = error.name; poleMessage = error.message; }
      }
    `,
      {
        heapSize: 8 * 1024 * 1024,
        gcCollector: denominator === 12n ? "differential" : undefined,
      },
    );
    let collectionCount = 0;
    while (
      contract.result?.status === "memory_pressure" && collectionCount < 20
    ) {
      contract.session.gc();
      contract.result = contract.session.run(0, EXACTAS_FUEL_GRANT);
      collectionCount++;
    }
    if (denominator === 12n) {
      assertEquals(collectionCount > 0, true, "Pi/12 must exercise collection");
    }
    const label = `Pi/${denominator}`;
    assertContractDone(contract, label);
    assertEquals(contract.session.get(0, "identityMatches"), true, label);
    assertEquals(
      contract.session.get(0, "tangentIdentityMatches"),
      true,
      label,
    );
    if (testCase.pole) {
      assertEquals(contract.session.get(0, "poleType"), "TypeError", label);
      assertEquals(
        contract.session.get(0, "poleMessage"),
        "Exact.Expression.toApproximation: expected a supported real-valued exact expression",
        label,
      );
    } else {
      assertEquals(contract.session.get(0, "fixedMatches"), true, label);
    }
  }
});

Deno.test("exact surface matrix: introspection, text, and roots meet consumer contracts", () => {
  const introspection = runContract(`
    let A = Exact.AlgebraicNumber;
    let E = Exact.Expression;
    let value = A.squareRoot(2n);
    let polynomial = A.definingPolynomial(value);
    let x = Symbol.for('x');
    let atRoot = E.simplify(E.substitute(polynomial, x, value));
    let symbolTexts = [
      Exact.toString(x),
      Exact.toString(Exact.Pi),
      Exact.toString(Exact.E),
      Exact.toString(Exact.Infinity),
      Exact.toString(Symbol('fresh')),
      Exact.toString(Symbol()),
    ];
    let polynomialMatches = E.equal(atRoot, 0n);
  `);
  assertContractDone(introspection, "introspection and text");
  assertEquals(introspection.session.get(0, "polynomialMatches"), true);
  assertEquals(introspection.session.getExact(0, "symbolTexts"), [
    "x",
    "Pi",
    "E",
    "Infinity",
    "fresh",
    "Symbol()",
  ]);

  const rootCases = [
    { degree: 3n, operation: "subtract", constant: 1n },
    { degree: 3n, operation: "subtract", constant: 2n },
    { degree: 4n, operation: "subtract", constant: 1n },
    { degree: 4n, operation: "add", constant: 1n },
  ];
  for (const rootCase of rootCases) {
    const label = `roots degree ${rootCase.degree} ${rootCase.operation}`;
    const contract = runContract(`
      let E = Exact.Expression;
      let C = Exact.ComplexAlgebraicNumber;
      let x = Symbol.for('x');
      let roots = C.rootsOfPolynomial(
        E.${rootCase.operation}(
          E.power(x, ${rootCase.degree}n), ${rootCase.constant}n), x);
    `);
    assertContractDone(contract, label);
    assertEquals(
      contract.session.getExact(0, "roots").length,
      Number(rootCase.degree),
      label,
    );
    contract.session.gc();
    assertEquals(
      contract.session.getExact(0, "roots").length,
      Number(rootCase.degree),
      `${label} after collection`,
    );
  }
});

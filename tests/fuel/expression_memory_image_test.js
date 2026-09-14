/**
 * 2b.2 — Expression heap type at the memory-image layer.
 *
 * Tests the low-level allocator, accessors, and structured readback for
 * TYPE.EXPRESSION. Language-level construction (Exact.Expression.make,
 * .add, .multiply etc.) lands in 2b.3 and is tested separately.
 *
 * Also tests the new pre-registered mathematical constants and
 * Expression head symbols that Exact namespace now exposes:
 *   Exact.Pi, Exact.E, Exact.Infinity — registry-backed atoms
 *   Exact.Expression.Add / Subtract / Multiply / Divide / Power / Negate
 *
 * Run with: deno task test tests/fuel/expression_memory_image_test.js
 */

import { assertEquals, assert } from "https://deno.land/std@0.208.0/assert/mod.ts";
import { MemoryImage, instantiateSync, layoutVat, TYPE } from '../../src/fuel/index.js';
import { createSession } from '../../src/fuel/session.js';
import { parseAndSetup } from './test-helpers.js';
import { freshSession } from '../../src/host-owned-session.js';

function createTestMemoryImage() {
  const memory = new WebAssembly.Memory({ initial: 16, maximum: 256, shared: true });
  const wasm = instantiateSync(memory);
  const memoryImage = new MemoryImage(memory);
  memoryImage.setWasmInstance(wasm);
  layoutVat(memoryImage.memory, memoryImage.baseOffset, { segmentSize: memoryImage.segmentSize });
  memoryImage.bootstrap();
  return memoryImage;
}

function run(source) {
  const session = freshSession();
  parseAndSetup(session, source);
  const result = session.run(0, 1000000);
  if (result.status === 'error') {
    throw new Error(`Error: ${result.error.message}`);
  }
  return session;
}

// Low-level allocator

Deno.test("Expression allocator: allocates a heap object with head + args", () => {
  const memoryImage = createTestMemoryImage();
  const headSymbol = memoryImage.allocateSymbol(memoryImage.internString('MyHead'));
  const argsArray = memoryImage.allocateArrayWithCapacity(0);
  const expressionPointer = memoryImage.allocateExpression(headSymbol, argsArray);
  assert(expressionPointer > 0);
  assertEquals(memoryImage.readExpressionHead(expressionPointer), headSymbol);
  assertEquals(memoryImage.readExpressionArgumentArray(expressionPointer), argsArray);
});

Deno.test("Expression allocator: each call produces a distinct pointer", () => {
  const memoryImage = createTestMemoryImage();
  const headSymbol = memoryImage.allocateSymbol(memoryImage.internString('H'));
  const a = memoryImage.allocateExpression(headSymbol, memoryImage.allocateArrayWithCapacity(0));
  const b = memoryImage.allocateExpression(headSymbol, memoryImage.allocateArrayWithCapacity(0));
  assert(a !== b);
});

Deno.test("Expression readback: returns { kind, head, arguments } nested", () => {
  const memoryImage = createTestMemoryImage();
  const headSymbol = memoryImage.allocateSymbol(memoryImage.internString('Add'));
  const argsArray = memoryImage.allocateArrayWithCapacity(0);
  const expressionPointer = memoryImage.allocateExpression(headSymbol, argsArray);

  const scratchValueAddress = memoryImage.getHeapPointer();
  const abs = memoryImage.abs(scratchValueAddress);
  memoryImage.view.setUint32(abs, TYPE.EXPRESSION, true);
  memoryImage.view.setUint32(abs + 4, 0, true);
  memoryImage.view.setUint32(abs + 8, expressionPointer, true);
  memoryImage.view.setUint32(abs + 12, 0, true);

  const readback = memoryImage.readValueAt(scratchValueAddress);
  assertEquals(readback.kind, 'expression');
  assertEquals(readback.head, {
    kind: 'symbol',
    description: 'Add',
    registered: false,  // this particular head isn't in the registry
  });
  assertEquals(readback.arguments, []);
});

// Pre-registered Exact constants (language-level)

Deno.test("Exact.Pi is a registry-backed Symbol with description 'Pi'", () => {
  const session = run(`let d = Exact.Pi.description; let r = Exact.Pi === Symbol.for('Pi');`);
  assertEquals(session.get(0, 'd'), 'Pi');
  assertEquals(session.get(0, 'r'), true);
});

Deno.test("Exact.E is a registry-backed Symbol with description 'E'", () => {
  const session = run(`let d = Exact.E.description; let r = Exact.E === Symbol.for('E');`);
  assertEquals(session.get(0, 'd'), 'E');
  assertEquals(session.get(0, 'r'), true);
});

Deno.test("Exact.Infinity is a Symbol (not the float Infinity)", () => {
  assertEquals(run(`let x = typeof Exact.Infinity;`).get(0, 'x'), 'symbol');
  assertEquals(run(`let x = typeof Infinity;`).get(0, 'x'), 'number');
  assertEquals(run(`let x = Exact.Infinity === Infinity;`).get(0, 'x'), false);
  assertEquals(run(`let x = Exact.Infinity === Symbol.for('Infinity');`).get(0, 'x'), true);
});

Deno.test("Exact.Pi, Exact.E, Exact.Infinity are all distinct", () => {
  assertEquals(run(`let x = Exact.Pi === Exact.E;`).get(0, 'x'), false);
  assertEquals(run(`let x = Exact.Pi === Exact.Infinity;`).get(0, 'x'), false);
  assertEquals(run(`let x = Exact.E === Exact.Infinity;`).get(0, 'x'), false);
});

// Pre-registered expression heads

Deno.test("Exact.Expression.Add is a registry-backed Symbol", () => {
  assertEquals(run(`let x = typeof Exact.Expression.Add;`).get(0, 'x'), 'symbol');
  assertEquals(run(`let x = Exact.Expression.Add === Symbol.for('Add');`).get(0, 'x'), true);
  assertEquals(run(`let x = Exact.Expression.Add.description;`).get(0, 'x'), 'Add');
});

Deno.test("Expression heads: all six are distinct registry-backed Symbols", () => {
  const session = run(`
    let heads = [
      Exact.Expression.Add,
      Exact.Expression.Subtract,
      Exact.Expression.Multiply,
      Exact.Expression.Divide,
      Exact.Expression.Power,
      Exact.Expression.Negate
    ];
    let descriptions = [
      Exact.Expression.Add.description,
      Exact.Expression.Subtract.description,
      Exact.Expression.Multiply.description,
      Exact.Expression.Divide.description,
      Exact.Expression.Power.description,
      Exact.Expression.Negate.description
    ];
    // Pairwise distinctness: every head !== every other head.
    let allDistinct = true;
    for (let i = 0; i < heads.length; i = i + 1) {
      for (let j = 0; j < heads.length; j = j + 1) {
        if (i !== j && heads[i] === heads[j]) { allDistinct = false; }
      }
    }
  `);
  assertEquals(session.get(0, 'descriptions'), ['Add', 'Subtract', 'Multiply', 'Divide', 'Power', 'Negate']);
  assertEquals(session.get(0, 'allDistinct'), true);
  // heads itself round-trips via getExact as six distinct symbols
  const headsReadback = session.getExact(0, 'heads');
  assertEquals(headsReadback.length, 6);
  const descriptionsSeen = new Set(headsReadback.map((h) => h.description));
  assertEquals(descriptionsSeen.size, 6);
  for (const h of headsReadback) {
    assertEquals(h.kind, 'symbol');
    assertEquals(h.registered, true);
  }
});

Deno.test("Expression heads: registry identity via Symbol.for", () => {
  const pairs = ['Add', 'Subtract', 'Multiply', 'Divide', 'Power', 'Negate'];
  for (const name of pairs) {
    const session = run(`let x = Exact.Expression.${name} === Symbol.for('${name}');`);
    assertEquals(session.get(0, 'x'), true, `head ${name} should match Symbol.for('${name}')`);
  }
});

// Symbol.for continuity — can register-then-retrieve without losing identity

Deno.test("Registry continuity: Symbol.for('Pi') before and after Exact.Pi access", () => {
  const session = run(`
    let a = Symbol.for('Pi');
    let b = Exact.Pi;
    let c = Symbol.for('Pi');
    let eq1 = a === b;
    let eq2 = b === c;
  `);
  assertEquals(session.get(0, 'eq1'), true);
  assertEquals(session.get(0, 'eq2'), true);
});

// isSymbolRegistered on a pre-registered symbol returns true via readback

Deno.test("Exact.Pi readback shows registered: true", () => {
  const session = run(`let p = Exact.Pi;`);
  assertEquals(session.getExact(0, 'p'), {
    kind: 'symbol',
    description: 'Pi',
    registered: true,
  });
});

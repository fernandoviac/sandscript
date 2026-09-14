/**
 * Shared utilities for interpreter tests.
 */

import { assertEquals, assert, assertThrows } from "https://deno.land/std@0.208.0/assert/mod.ts";
import {
  MemoryManipulator,
  Parser,
  instantiateSync,
  layoutVat,
  EXIT_DONE,
  EXIT_ERROR,
  VERSION,
  TYPE,
} from '../../src/fuel/index.js';

/**
 * Create a fresh test context with isolated memory.
 */
export function createTestContext(initOptions = {}) {
  const memory = new WebAssembly.Memory({ initial: 16, maximum: 256, shared: true });
  const wasm = instantiateSync(memory);
  const mem = new MemoryManipulator(memory);
  mem.setWasmInstance(wasm);
  layoutVat(mem.memory, mem.baseOffset, { ...initOptions, segmentSize: mem.segmentSize });
  mem.bootstrap();
  const parser = new Parser(mem);
  return { memory, wasm, mem, parser };
}

/**
 * Run code and return the result status.
 */
export function runCode(mem, wasm, parser, source, fuel = 10000) {
  mem.allocateCodeBlock();
  parser.parse(source);
  mem.setContextInstructionIndex(0, 0);
  mem.clearExitCondition(0);
  wasm.exports.run(fuel, 0);  // pass context slot 0
  return mem.getExitCondition(0);
}

/**
 * Get a variable's value from the current scope.
 */
export function getVariable(mem, varName) {
  const scope = mem.getRootScope();
  const nameOffset = mem.internString(varName);
  const valuePtr = mem.scopeLookup(scope, nameOffset);
  if (!valuePtr) return undefined;
  return mem.getValue(valuePtr);
}

/**
 * Get a numeric variable value.
 */
export function getNumericVar(mem, varName) {
  const scope = mem.getRootScope();
  const nameOffset = mem.internString(varName);
  const valuePtr = mem.scopeLookup(scope, nameOffset);
  if (!valuePtr) return undefined;
  const type = mem.getValueType(valuePtr);
  if (type === TYPE.FLOAT) {
    return mem.view.getFloat64(mem.abs(valuePtr) + 8, true);
  }
  if (type === TYPE.INTEGER) {
    return Number(mem.view.getBigInt64(mem.abs(valuePtr) + 8, true));
  }
  if (type === TYPE.RATIONAL) {
    const readback = mem.readValueAt(valuePtr);
    if (readback && readback.kind === 'rational') {
      if (readback.denominator === 1n) {
        return Number(readback.numerator);
      }
      return Number(readback.numerator) / Number(readback.denominator);
    }
  }
  return undefined;
}

/**
 * Get a string variable value.
 */
export function getStringVar(mem, varName) {
  const val = getVariable(mem, varName);
  if (!val || val.type !== 5) return undefined; // TYPE_STRING = 5
  const strId = Number(val.payload);
  // String ids are table-relative; route through the memory reader.
  return mem.readString(strId);
}

/**
 * Get a boolean variable value.
 */
export function getBooleanVar(mem, varName) {
  const val = getVariable(mem, varName);
  if (!val || val.type !== 2) return undefined; // TYPE_BOOLEAN = 2
  return Number(val.payload) !== 0;
}

/**
 * Check if a variable is undefined type.
 */
export function isUndefinedVar(mem, varName) {
  const val = getVariable(mem, varName);
  return val && val.type === 1; // TYPE_UNDEFINED = 1
}

/**
 * Get array length from a variable.
 */
export function getArrayLength(mem, varName) {
  const val = getVariable(mem, varName);
  if (!val || val.type !== 6) return undefined; // TYPE_ARRAY = 6
  const arrPtr = Number(val.payload);
  return mem.view.getUint32(mem.abs(arrPtr + 8), true);
}

/**
 * Get array elements as JS array.
 */
export function getArrayElements(mem, varName) {
  const scope = mem.getRootScope();
  const nameOffset = mem.internString(varName);
  const valuePtr = mem.scopeLookup(scope, nameOffset);
  if (!valuePtr) return undefined;
  const type = mem.getValueType(valuePtr);
  if (type !== TYPE.ARRAY) return undefined;
  const arrPtr = mem.view.getUint32(mem.abs(valuePtr) + 8, true);
  const len = mem.view.getUint32(mem.abs(arrPtr + 8), true);
  const dataPtr = mem.view.getUint32(mem.abs(arrPtr + 16), true);

  const elements = [];
  for (let i = 0; i < len; i++) {
    const elemPtr = dataPtr + 8 + i * 16;
    const elemType = mem.view.getUint32(mem.abs(elemPtr), true);
    const elemLo = mem.view.getUint32(mem.abs(elemPtr + 8), true);
    const elemHi = mem.view.getUint32(mem.abs(elemPtr + 12), true);

    if (elemType === TYPE.FLOAT) {
      const buffer = new ArrayBuffer(8);
      const u32 = new Uint32Array(buffer);
      const f64 = new Float64Array(buffer);
      u32[0] = elemLo;
      u32[1] = elemHi;
      elements.push(f64[0]);
    } else if (elemType === TYPE.INTEGER) {
      elements.push(elemLo < 0x80000000 ? elemLo : elemLo - 0x100000000);
    } else if (elemType === TYPE.BOOLEAN) {
      elements.push(elemLo !== 0);
    } else if (elemType === TYPE.STRING) {
      elements.push(mem.readString(elemLo));
    } else if (elemType === TYPE.RATIONAL) {
      const readback = mem.readValueAt(elemPtr);
      if (readback && readback.kind === 'rational') {
        if (readback.denominator === 1n) {
          const n = readback.numerator;
          if (n >= -(1n << 53n) && n <= (1n << 53n)) {
            elements.push(Number(n));
          } else {
            elements.push(n);
          }
        } else {
          elements.push(Number(readback.numerator) / Number(readback.denominator));
        }
      } else {
        elements.push(`<type ${elemType}>`);
      }
    } else {
      elements.push(`<type ${elemType}>`);
    }
  }
  return elements;
}

/**
 * Run code and assert a numeric variable has expected value.
 */
export function assertNumericResult(source, varName, expected) {
  const { mem, wasm, parser } = createTestContext();
  const status = runCode(mem, wasm, parser, source);
  assertEquals(status, EXIT_DONE, `Expected EXIT_DONE, got ${status}`);
  const actual = getNumericVar(mem, varName);
  if (Number.isNaN(expected)) {
    assert(Number.isNaN(actual), `Expected NaN, got ${actual}`);
  } else {
    assertEquals(actual, expected);
  }
}

/**
 * Run code and assert a string variable has expected value.
 */
export function assertStringResult(source, varName, expected) {
  const { mem, wasm, parser } = createTestContext();
  const status = runCode(mem, wasm, parser, source);
  assertEquals(status, EXIT_DONE, `Expected EXIT_DONE, got ${status}`);
  const actual = getStringVar(mem, varName);
  assertEquals(actual, expected);
}

/**
 * Run code and assert a boolean variable has expected value.
 */
export function assertBooleanResult(source, varName, expected) {
  const { mem, wasm, parser } = createTestContext();
  const status = runCode(mem, wasm, parser, source);
  assertEquals(status, EXIT_DONE, `Expected EXIT_DONE, got ${status}`);
  const actual = getBooleanVar(mem, varName);
  assertEquals(actual, expected);
}

/**
 * Run code and assert a variable is undefined.
 */
export function assertUndefinedResult(source, varName) {
  const { mem, wasm, parser } = createTestContext();
  const status = runCode(mem, wasm, parser, source);
  assertEquals(status, EXIT_DONE, `Expected EXIT_DONE, got ${status}`);
  assert(isUndefinedVar(mem, varName), `Expected ${varName} to be undefined`);
}

/**
 * Run code and assert array elements match.
 */
export function assertArrayResult(source, varName, expected) {
  const { mem, wasm, parser } = createTestContext();
  const status = runCode(mem, wasm, parser, source);
  assertEquals(status, EXIT_DONE, `Expected EXIT_DONE, got ${status}`);
  const actual = getArrayElements(mem, varName);
  assertEquals(actual, expected);
}

/**
 * Run code and assert it produces a specific error code.
 */
export function assertErrorCode(source, expectedCode) {
  const { mem, wasm, parser } = createTestContext();
  const status = runCode(mem, wasm, parser, source);
  assertEquals(status, EXIT_ERROR, `Expected EXIT_ERROR, got ${status}`);
  const err = mem.getErrorInfo();
  assertEquals(err.code, expectedCode, `Expected error code ${expectedCode}, got ${err.code}`);
}

/**
 * Assert code throws a parse error containing expected message.
 */
export function assertParseError(source, expectedMessage) {
  const { mem, parser } = createTestContext();
  mem.allocateCodeBlock();
  assertThrows(
    () => parser.parse(source),
    Error,
    expectedMessage
  );
}

/**
 * Run code and assert result is positive or negative Infinity.
 */
export function assertInfinityResult(source, varName, positive = true) {
  const { mem, wasm, parser } = createTestContext();
  const status = runCode(mem, wasm, parser, source);
  assertEquals(status, EXIT_DONE, `Expected EXIT_DONE, got ${status}`);
  const actual = getNumericVar(mem, varName);
  assert(!Number.isFinite(actual) && !Number.isNaN(actual), `Expected Infinity, got ${actual}`);
  if (positive) {
    assert(actual > 0, `Expected positive Infinity, got ${actual}`);
  } else {
    assert(actual < 0, `Expected negative Infinity, got ${actual}`);
  }
}

/**
 * Run code and assert result is NaN.
 */
export function assertNaNResult(source, varName) {
  const { mem, wasm, parser } = createTestContext();
  const status = runCode(mem, wasm, parser, source);
  assertEquals(status, EXIT_DONE, `Expected EXIT_DONE, got ${status}`);
  const actual = getNumericVar(mem, varName);
  assert(Number.isNaN(actual), `Expected NaN, got ${actual}`);
}

// Re-export common assertions and constants
export { assertEquals, assert, assertThrows };
export { EXIT_DONE, EXIT_ERROR, VERSION };
export const STATUS_DONE = EXIT_DONE;
export const STATUS_ERROR = EXIT_ERROR;

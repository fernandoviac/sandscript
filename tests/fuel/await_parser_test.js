/**
 * Tests for await keyword parser validation.
 *
 * Await is valid:
 * - At top level (module script context)
 * - Inside async functions
 *
 * Await is invalid:
 * - Inside non-async functions (even if nested in async)
 */

import { assert } from "https://deno.land/std@0.208.0/assert/mod.ts";
import { OP } from '../../src/fuel/constants.js';
import { freshSession } from '../../src/host-owned-session.js';

// parse() throws ParseError on failure (673de61) — valid sources must
// parse without throwing; invalid sources must throw with the
// expected message.
function parseAndCheckError(source, expectedErrorSubstr = null) {
  const session = freshSession();

  if (expectedErrorSubstr) {
    let thrown = null;
    try { session.parse(source); }
    catch (e) { thrown = e; }
    assert(thrown !== null, 'Expected ParseError but parse succeeded');
    const msg = thrown.message || String(thrown);
    assert(msg.includes(expectedErrorSubstr),
      `Expected error containing "${expectedErrorSubstr}" but got: ${msg}`);
    return null;
  }

  return session.parse(source);
}

// ===========================================================================
// Valid await contexts
// ===========================================================================

Deno.test("Parser: await at top level is valid", () => {
  parseAndCheckError(`await Promise.resolve(42);`);
});

Deno.test("Parser: await in async function is valid", () => {
  parseAndCheckError(`
    async function foo() {
      await Promise.resolve(42);
    }
  `);
});

Deno.test("Parser: await in async arrow function (block body) is valid", () => {
  parseAndCheckError(`
    const foo = async () => {
      await Promise.resolve(42);
    };
  `);
});

Deno.test("Parser: await in async arrow function (expression body) is valid", () => {
  parseAndCheckError(`const foo = async x => await x;`);
});

Deno.test("Parser: await in async arrow with single param is valid", () => {
  parseAndCheckError(`const foo = async x => await x;`);
});

Deno.test("Parser: await in async function expression is valid", () => {
  parseAndCheckError(`
    const foo = async function() {
      await Promise.resolve(42);
    };
  `);
});

Deno.test("Parser: multiple awaits in async function are valid", () => {
  parseAndCheckError(`
    async function foo() {
      let a = await Promise.resolve(1);
      let b = await Promise.resolve(2);
      return a + b;
    }
  `);
});

Deno.test("Parser: await in nested async arrow inside async function is valid", () => {
  parseAndCheckError(`
    async function outer() {
      const inner = async () => await Promise.resolve(42);
      return inner();
    }
  `);
});

// ===========================================================================
// Invalid await contexts
// ===========================================================================

Deno.test("Parser: await in non-async function is invalid", () => {
  parseAndCheckError(`
    function foo() {
      await Promise.resolve(42);
    }
  `, 'await is only valid in async functions');
});

Deno.test("Parser: await in non-async arrow function (block body) is invalid", () => {
  parseAndCheckError(`
    const foo = () => {
      await Promise.resolve(42);
    };
  `, 'await is only valid in async functions');
});

Deno.test("Parser: await in non-async arrow function (expression body) is invalid", () => {
  parseAndCheckError(`const foo = x => await x;`, 'await is only valid in async functions');
});

Deno.test("Parser: await in nested non-async function inside async function is invalid", () => {
  parseAndCheckError(`
    async function outer() {
      function inner() {
        await Promise.resolve(42);
      }
    }
  `, 'await is only valid in async functions');
});

Deno.test("Parser: await in nested non-async arrow inside async function is invalid", () => {
  parseAndCheckError(`
    async function outer() {
      const inner = () => await Promise.resolve(42);
    }
  `, 'await is only valid in async functions');
});

Deno.test("Parser: await in function expression inside async function is invalid", () => {
  parseAndCheckError(`
    async function outer() {
      const inner = function() {
        await Promise.resolve(42);
      };
    }
  `, 'await is only valid in async functions');
});

// ===========================================================================
// AWAIT opcode emission
// ===========================================================================

Deno.test("Parser: await emits AWAIT opcode", () => {
  const session = freshSession();
  session.parse(`
    async function foo() {
      await 1;
    }
  `);

  const mem = session.memoryImage;
  const instrCount = mem.codeBlockInstructionCount();

  // Find AWAIT opcode in the code block
  let foundAwait = false;
  for (let i = 0; i < instrCount; i++) {
    const instr = mem.codeBlockReadInstruction(i);
    if (instr.opcode === OP.AWAIT) {
      foundAwait = true;
      break;
    }
  }

  assert(foundAwait, 'AWAIT opcode not found in generated bytecode');
});

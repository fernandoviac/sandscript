import { assertEquals, assert } from "https://deno.land/std@0.208.0/assert/mod.ts";
import { freshSession } from '../../src/host-owned-session.js';
import { RuntimeBuilder } from '../../src/runtime/test-harness.js';
import { UncaughtScriptError } from '../../src/runtime/errors.js';

function tick(ms = 0) { return new Promise(r => setTimeout(r, ms)); }

function runAndGet(session, source, varName, slot = 0) {
  session.parse(source);
  session.run(slot, 10000);
  return session.get(slot, varName);
}

Deno.test("try/catch catches const assignment", () => {
  const session = freshSession();
  const caught = runAndGet(session, `
    let caught = false
    try { const x = 1; x = 2 } catch(e) { caught = true }
  `, 'caught');
  assertEquals(caught, true);
});

Deno.test("try/catch catches JSON.stringify circular reference", () => {
  const session = freshSession();
  const caught = runAndGet(session, `
    let caught = false
    try {
      let obj = {}
      obj.self = obj
      JSON.stringify(obj)
    } catch(e) { caught = true }
  `, 'caught');
  assertEquals(caught, true);
});

Deno.test("try/catch catches RangeError from bigint exponent", () => {
  const session = freshSession();
  const caught = runAndGet(session, `
    let caught = false
    try { 1n ** (-1n) } catch(e) { caught = true }
  `, 'caught');
  assertEquals(caught, true);
});

Deno.test("try/catch catches scope redeclaration", () => {
  const session = freshSession();
  const caught = runAndGet(session, `
    let caught = false
    try { let x = 1; let x = 2 } catch(e) { caught = true }
  `, 'caught');
  assertEquals(caught, true);
});

Deno.test("async: const assignment rejects the promise", async () => {
  let handlerErrors = [];
  const { runtime, session, channels } = new RuntimeBuilder()
    .onInboundMessage(() => {})
    .onHandlerError((err) => { handlerErrors.push(err); })
    .build();
  await runtime.start();

  session.parse(`
    let result = "pending"
    async function inner() { const x = 1; x = 2; return x }
    try { result = await inner() } catch(e) { result = "caught" }
  `);

  await runtime.run(0);
  await tick(200);

  assertEquals(session.get(0, 'result'), 'caught');
  assertEquals(handlerErrors.length, 0);

  await runtime.terminate();
  channels.close();
});

Deno.test("async: unawaited error surfaces via onHandlerError", async () => {
  let handlerErrors = [];
  const { runtime, session, channels } = new RuntimeBuilder()
    .onInboundMessage(() => {})
    .onHandlerError((err) => { handlerErrors.push(err); })
    .build();
  await runtime.start();

  session.parse(`
    async function inner() { const x = 1; x = 2; return x }
    inner()
  `);

  await runtime.run(0);
  await tick(200);

  assert(handlerErrors.length > 0, 'error should surface via onHandlerError');

  await runtime.terminate();
  channels.close();
});

Deno.test("uncaught const assignment still throws UncaughtScriptError", () => {
  const session = freshSession();
  session.parse(`const x = 1; x = 2`);
  let threw = false;
  try {
    session.run(0, 10000);
  } catch (e) {
    threw = true;
    assert(e instanceof UncaughtScriptError);
    assertEquals(e.scriptError.codeName, 'CONST_ASSIGNMENT');
  }
  assert(threw, 'should have thrown UncaughtScriptError');
});

Deno.test("uncaught const assignment through finally keeps translated error", () => {
  const session = freshSession();
  session.parse(`
    const value = 1
    try {
      value = 2
    } finally {
      let cleanupRan = true
    }
  `);
  let thrown = null;
  try {
    session.run(0, 10000);
  } catch (error) {
    if (!(error instanceof UncaughtScriptError)) throw error;
    thrown = error.scriptError;
  }
  assert(thrown !== null, 'should have thrown UncaughtScriptError');
  assertEquals(thrown.codeName, 'CONST_ASSIGNMENT');
  assertEquals(thrown.message, "Assignment to constant variable 'value'");
  assertEquals(thrown.failPc, 5);
});

Deno.test("uncaught JSON.stringify circular still throws UncaughtScriptError", () => {
  const session = freshSession();
  session.parse(`let o = {}; o.s = o; JSON.stringify(o)`);
  let threw = false;
  try {
    session.run(0, 10000);
  } catch (e) {
    threw = true;
    assert(e instanceof UncaughtScriptError);
    assertEquals(e.scriptError.codeName, 'JSON_STRINGIFY');
  }
  assert(threw, 'should have thrown UncaughtScriptError');
});

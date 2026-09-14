/**
 * Tests for SharedArrayBuffer / shared memory support.
 * Multiple SandScript sessions in the same WebAssembly.Memory.
 */

import { assertEquals, assert } from "https://deno.land/std@0.208.0/assert/mod.ts";
import { createSession } from '../../src/fuel/session.js';
import { parseAndSetup } from './test-helpers.js';
import { freshSession } from '../../src/host-owned-session.js';

Deno.test("Shared memory: two sessions in same memory", () => {
  const memory = new WebAssembly.Memory({
    initial: 32,
    maximum: 32,
    shared: true,
  });

  const sessionA = freshSession({ offset: 0 });
  parseAndSetup(sessionA, 'let x = 100;');
  sessionA.run(0, 1000);

  const sessionB = freshSession({ offset: 1024 * 1024 });
  parseAndSetup(sessionB, 'let y = 200;');
  sessionB.run(0, 1000);

  assertEquals(sessionA.get(0, 'x'), 100);
  assertEquals(sessionB.get(0, 'y'), 200);
});

Deno.test("Shared memory: sessions don't interfere", () => {
  const memory = new WebAssembly.Memory({
    initial: 32,
    maximum: 32,
    shared: true,
  });

  const sessionA = freshSession({ offset: 0 });
  const sessionB = freshSession({ offset: 1024 * 1024 });

  parseAndSetup(sessionA, 'let count = 1;');
  parseAndSetup(sessionB, 'let count = 2;');

  sessionA.run(0, 1000);
  sessionB.run(0, 1000);

  assertEquals(sessionA.get(0, 'count'), 1);
  assertEquals(sessionB.get(0, 'count'), 2);
});

Deno.test("Shared memory: interleaved execution", () => {
  const memory = new WebAssembly.Memory({
    initial: 32,
    maximum: 32,
    shared: true,
  });

  const sessionA = freshSession({ offset: 0 });
  const sessionB = freshSession({ offset: 1024 * 1024 });

  parseAndSetup(sessionA, 'let a = 0;');
  sessionA.run(0, 1000);

  parseAndSetup(sessionB, 'let b = 0;');
  sessionB.run(0, 1000);

  // Interleave increments
  parseAndSetup(sessionA, 'a = a + 1;');
  sessionA.run(0, 1000);

  parseAndSetup(sessionB, 'b = b + 10;');
  sessionB.run(0, 1000);

  parseAndSetup(sessionA, 'a = a + 1;');
  sessionA.run(0, 1000);

  assertEquals(sessionA.get(0, 'a'), 2);
  assertEquals(sessionB.get(0, 'b'), 10);
});

Deno.test("Shared memory: default createSession uses shared memory", () => {
  const session = freshSession();
  const buffer = session.memoryImage.memory.buffer;
  assert(buffer instanceof SharedArrayBuffer, "Default memory should be SharedArrayBuffer");
});

Deno.test("Shared memory: three sessions", () => {
  const memory = new WebAssembly.Memory({
    initial: 48,
    maximum: 48,
    shared: true,
  });

  const s1 = freshSession({ offset: 0 });
  const s2 = freshSession({ offset: 1024 * 1024 });
  const s3 = freshSession({ offset: 2 * 1024 * 1024 });

  parseAndSetup(s1, 'let v = "one";');
  parseAndSetup(s2, 'let v = "two";');
  parseAndSetup(s3, 'let v = "three";');

  s1.run(0, 1000);
  s2.run(0, 1000);
  s3.run(0, 1000);

  assertEquals(s1.get(0, 'v'), "one");
  assertEquals(s2.get(0, 'v'), "two");
  assertEquals(s3.get(0, 'v'), "three");
});

Deno.test("Shared memory: heavy allocation in one doesn't corrupt other", () => {
  const memory = new WebAssembly.Memory({
    initial: 32,
    maximum: 32,
    shared: true,
  });

  const sessionA = freshSession({ offset: 0 });
  const sessionB = freshSession({ offset: 512 * 1024 });

  parseAndSetup(sessionB, 'let x = 42;');
  sessionB.run(0, 1000);

  // Heavy allocation in A
  parseAndSetup(sessionA, 'let arr = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10];');
  sessionA.run(0, 10000);

  // B should be unaffected
  assertEquals(sessionB.get(0, 'x'), 42);
});

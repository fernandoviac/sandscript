import { assertEquals, assert } from 'https://deno.land/std@0.208.0/assert/mod.ts';
import { freshSession } from '../../src/host-owned-session.js';
import { REGION_SIZE } from '../../src/fuel/constants.js';

async function evalCode(code, opts = {}) {
  const session = await freshSession(opts);
  const parseResult = session.parse(code);
  const runResult = session.run(0, 100000);
  if (runResult.status === 'error') {
    throw new Error(`Runtime error: ${JSON.stringify(runResult.error)}`);
  }
  return session.get(0, 'result');
}

function assertInternError(err) {
  assert(err.message.includes('too long for interning'),
    `expected interning error, got: ${err.message}`);
  assert(err.message.includes('scratchSize'),
    `expected the error to name the scratchSize remediation, got: ${err.message}`);
}

Deno.test('default scratch size accepts multi-kilobyte string literals', async () => {
  const longStr = 'a'.repeat(8192);
  const result = await evalCode(`let result = "${longStr}"`);
  assertEquals(result, longStr);
});

Deno.test('257-byte string literal round-trips identically', async () => {
  const longStr = 'x'.repeat(257);
  const result = await evalCode(`let result = "${longStr}"`);
  assertEquals(result, longStr);
});

Deno.test('default scratch size rejects literals over the default limit at parse', async () => {
  const longStr = 'a'.repeat(REGION_SIZE.SCRATCH + 1);
  try {
    await evalCode(`let result = "${longStr}"`);
    throw new Error('should have thrown');
  } catch (err) {
    assertInternError(err);
  }
});

Deno.test('enlarged scratch size accepts strings over the default limit', async () => {
  const longStr = 'b'.repeat(REGION_SIZE.SCRATCH + 100);
  const result = await evalCode(
    `let s = "${longStr}"\nlet result = s.length`,
    { scratchSize: REGION_SIZE.SCRATCH * 2 });
  assertEquals(result, REGION_SIZE.SCRATCH + 100);
});

Deno.test('reduced scratch size rejects strings over its limit at parse', async () => {
  const longStr = 'c'.repeat(600);
  try {
    await evalCode(`let result = "${longStr}"`, { scratchSize: 512 });
    throw new Error('should have thrown');
  } catch (err) {
    assertInternError(err);
  }
});

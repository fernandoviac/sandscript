/**
 * Schema snapshot/restore — paused Schema operations must survive a
 * byte-level snapshot and resume in a freshly restored session, and must
 * survive collections that relocate every buffer they hold.
 *
 * The workload crosses each continuation the language surface owns:
 * compile (measure and emit phases, with a regex sub-compile), TEST-mode
 * validation, VALIDATE-mode validation with error materialization, the
 * one-shots, assert's throw path, and a bundle compile.
 */
import { assert, assertEquals } from "https://deno.land/std@0.208.0/assert/mod.ts";
import { freshSession, restoreSession, snapshotSession } from '../../src/host-owned-session.js';
import { parseAndSetup } from './test-helpers.js';

const WORKLOAD = String.raw`
  const s = Schema.compile({
    type: 'object',
    required: ['kind', 'id'],
    properties: {
      kind: { enum: ['landing', 'takeoff'] },
      id: { type: 'string', pattern: '^[a-z]+-[0-9]+$', maxLength: 12 },
      tags: { type: 'array', items: { type: 'string' }, uniqueItems: true },
      n: { type: 'integer', minimum: 1, multipleOf: 0.5 },
    },
    additionalProperties: false,
    anyOf: [{ required: ['tags'] }, { required: ['n'] }],
  });
  let out = [];
  out.push(s.test({ kind: 'landing', id: 'ab-1', n: 2 }));
  out.push(s.test({ kind: 'landing', id: 'ab-1', tags: ['a', 'a'] }));
  out.push(s.validate({ kind: 'x', id: 'AB', tags: ['a', 'a'], n: 0.25, extra: 1 }));
  out.push(s.errors({ id: 'ab-1' }));
  out.push(Schema.test({ type: 'number', maximum: 3 }, 5));
  out.push(Schema.validate({ type: 'string' }, 5).errors[0].message);
  let asserted = null;
  try { s.assert({ kind: 'takeoff', id: 'zz-9', n: 1 }); asserted = 'ok'; } catch (e) { asserted = e.message; }
  out.push(asserted);
  try { s.assert({ kind: 'takeoff' }); } catch (e) { out.push([e.name, e.message, e.errors.length]); }
  const bundle = Schema.compile({ $ref: 'https://example.com/point' }, {
    schemas: [['https://example.com/point', { type: 'object', properties: { x: { type: 'number' } }, required: ['x'] }]],
  });
  out.push([bundle.test({ x: 1 }), bundle.test({ y: 1 }), bundle.dialect, bundle.kind]);
  let done = 1;
`;

const SLOTS = ['out', 'done'];

function expectedValues() {
  const session = freshSession({ inlineSource: true });
  parseAndSetup(session, WORKLOAD);
  const result = session.run(0, 100000000);
  assertEquals(result.status, 'done');
  const expected = {};
  for (const name of SLOTS) expected[name] = session.get(0, name);
  return expected;
}

Deno.test('schema snapshot: paused operations survive restore at EVERY pause', () => {
  const expected = expectedValues();
  assertEquals(expected.out[0], true);
  assertEquals(expected.out[1], false);
  assertEquals(expected.out[2].valid, false);
  let session = freshSession({ inlineSource: true });
  parseAndSetup(session, WORKLOAD);
  let pauses = 0;
  let restores = 0;
  for (let i = 0; i < 500000; i++) {
    session.mem.wasm.exports.run(25, 0);
    const condition = session.mem.getExitCondition(0);
    if (condition === 15) { session.gc(); continue; }
    if (condition === 2) {
      pauses++;
      const snap = snapshotSession(session);
      session = restoreSession(snap.vatBytes, snap.membraneBytes);
      restores++;
      continue;
    }
    break;
  }
  assertEquals(session.mem.getExitCondition(0), 1, 'chained-restore run completes');
  assert(pauses > 50, `schema work actually paused under tiny fuel (got ${pauses})`);
  assertEquals(restores, pauses, 'every pause crossed a snapshot/restore');
  for (const name of SLOTS) {
    assertEquals(session.get(0, name), expected[name], `slot ${name}`);
  }
});

Deno.test('schema snapshot: a collection at every pause relocates every parked buffer', () => {
  const expected = expectedValues();
  const session = freshSession({ inlineSource: true });
  parseAndSetup(session, WORKLOAD);
  let pauses = 0;
  for (let i = 0; i < 500000; i++) {
    session.mem.wasm.exports.run(25, 0);
    const condition = session.mem.getExitCondition(0);
    if (condition === 15) { session.gc(); continue; }
    if (condition === 2) {
      pauses++;
      // a full collection between grants: the input bytes, workspaces,
      // program, continuation, and descriptor all move
      session.gc();
      continue;
    }
    break;
  }
  assertEquals(session.mem.getExitCondition(0), 1);
  assert(pauses > 50, `paused (got ${pauses})`);
  for (const name of SLOTS) {
    assertEquals(session.get(0, name), expected[name], `slot ${name}`);
  }
});

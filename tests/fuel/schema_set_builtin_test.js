// Schema sets inside a session: Schema.compileSet / match / matchAll /
// test(value, index) must agree with the host binding on the same routes
// and documents, under whole grants and under tiny grants (every set
// operation pauses and resumes), and survive snapshot/restore mid-flight.
import { assert, assertEquals } from 'https://deno.land/std@0.208.0/assert/mod.ts';
import { freshSession, restoreSession, snapshotSession } from '../../src/host-owned-session.js';
import { parseAndSetup } from './test-helpers.js';
import { createSchemaEngine } from '../../src/schema/index.js';

const ROUTES = [
  { type: 'object', required: ['kind'], properties: { kind: { const: 'landing' } } },
  { type: 'object', required: ['kind', 'tenant'], properties: { kind: { const: 'takeoff' }, tenant: { type: 'string' } } },
  { type: 'object', required: ['kind'], properties: { kind: { enum: ['landing', 'takeoff'] } }, additionalProperties: false },
  { type: 'object', required: ['kind', 'n'], properties: { kind: { const: 'hold' }, n: { type: ['integer', 'null'] } } },
  { type: 'object', properties: { tags: { type: 'array', items: { type: 'string', pattern: '^[a-z]+$' }, uniqueItems: true } } },
  { anyOf: [{ required: ['x'] }, { required: ['kind'] }], not: { required: ['forbidden'] } },
  true,
  false,
  { $ref: '#/$defs/p', $defs: { p: { type: 'object', required: ['p'], properties: { p: { minimum: 3 } } } } },
];

const DOCS = [
  { kind: 'landing' },
  { kind: 'takeoff', tenant: 'blue' },
  { kind: 'takeoff', tenant: 5 },
  { kind: 'hold', n: null },
  { kind: 'hold', n: 1.5 },
  { kind: 'landing', extra: 1, tags: ['a', 'b'] },
  { tags: ['a', 'a'] },
  { tags: ['A'] },
  { x: 1, forbidden: true },
  { p: 2 },
  { p: 3 },
  'string',
  [1, 2],
  null,
];

function hostResults(engine) {
  const set = engine.compileSet(ROUTES);
  const out = DOCS.map((doc) => ({
    match: set.match(doc),
    all: set.matchAll(doc).map((r) => ({ index: r.index, valid: r.valid, errors: r.errors })),
    first: set.test(doc, 0),
    last: set.test(doc, ROUTES.length - 1),
  }));
  set.dispose();
  return out;
}

const SOURCE = `
  const set = Schema.compileSet(${JSON.stringify(ROUTES)});
  const docs = ${JSON.stringify(DOCS)};
  let out = docs.map((doc) => ({
    match: set.match(doc),
    all: set.matchAll(doc),
    first: set.test(doc, 0),
    last: set.test(doc, ${ROUTES.length - 1}),
  }));
  let facts = [set.kind, set.size, Schema.isSchema(set)];
  let done = 1;
`;

Deno.test('schema set builtin: agrees with the host binding', () => {
  const expected = hostResults(createSchemaEngine());
  const session = freshSession({ inlineSource: true });
  parseAndSetup(session, SOURCE);
  const result = session.run(0, 100000000);
  assertEquals(result.status, 'done');
  assertEquals(session.get(0, 'facts'), ['set', ROUTES.length, true]);
  assertEquals(session.get(0, 'out'), expected);
});

Deno.test('schema set builtin: tiny grants with a snapshot/restore at every pause', () => {
  const expected = hostResults(createSchemaEngine());
  let session = freshSession({ inlineSource: true });
  parseAndSetup(session, SOURCE);
  let pauses = 0;
  for (let i = 0; i < 2000000; i++) {
    session.mem.wasm.exports.run(25, 0);
    const condition = session.mem.getExitCondition(0);
    if (condition === 15) { session.gc(); continue; }
    if (condition === 2) {
      pauses++;
      const snap = snapshotSession(session);
      session = restoreSession(snap.vatBytes, snap.membraneBytes);
      continue;
    }
    break;
  }
  assertEquals(session.mem.getExitCondition(0), 1, 'run completes');
  assert(pauses > 100, `set work paused under tiny fuel (got ${pauses})`);
  assertEquals(session.get(0, 'done'), 1);
  assertEquals(session.get(0, 'out'), expected);
});

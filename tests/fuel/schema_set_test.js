// Schema sets: one program for N routes must decide exactly what N single
// validations decide — verdicts in TEST mode (match), verdicts and error
// lists in VALIDATE mode (matchAll) — over discriminator routes (the
// gate-decidable shape), corpus schemas (everything else), boolean routes,
// bundles, tiny fuel grants, and programs reloaded from bytes.
import { assertEquals, assertThrows } from 'https://deno.land/std@0.208.0/assert/mod.ts';
import { createSchemaEngine } from '../../src/schema/index.js';

const ROOT = new URL('../../fixtures/json-schema-test-suite/tests/draft2020-12/', import.meta.url);

// Deterministic PRNG so a failure reproduces.
function rng(seed) {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const KINDS = ['landing', 'takeoff', 'taxi', 'hold', 'divert'];
const TENANTS = ['blue', 'red', 'green'];

// Discriminator-heavy routes: required + const/enum/type on the required
// keys, sometimes with a residual keyword.
function discriminatorRoutes(count, random) {
  const routes = [];
  for (let i = 0; i < count; i++) {
    const kind = KINDS[Math.floor(random() * KINDS.length)];
    const route = { type: 'object', required: ['kind'], properties: { kind: { const: kind } } };
    const roll = random();
    if (roll < 0.3) {
      route.required.push('tenant');
      route.properties.tenant = { type: 'string' };
    } else if (roll < 0.5) {
      route.required.push('tenant');
      route.properties.tenant = { enum: TENANTS.slice(0, 1 + Math.floor(random() * 3)) };
    } else if (roll < 0.65) {
      route.properties.priority = { type: 'integer', minimum: 1 };
    } else if (roll < 0.75) {
      route.additionalProperties = false;
    } else if (roll < 0.85) {
      route.required.push('n');
      route.properties.n = { type: ['integer', 'null'] };
    }
    routes.push(route);
  }
  return routes;
}

function documents(random, count) {
  const docs = [];
  for (let i = 0; i < count; i++) {
    const roll = random();
    if (roll < 0.1) { docs.push(['a', 1, null][i % 3]); continue; }
    const doc = { kind: KINDS[Math.floor(random() * (KINDS.length + 1))] ?? 7 };
    if (random() < 0.7) doc.tenant = random() < 0.8 ? TENANTS[Math.floor(random() * 3)] : 42;
    if (random() < 0.4) doc.priority = random() < 0.5 ? Math.floor(random() * 5) : 2.5;
    if (random() < 0.4) doc.n = random() < 0.5 ? 3 : (random() < 0.5 ? null : 'x');
    if (random() < 0.3) doc.extra = { deep: [1, 2] };
    docs.push(doc);
  }
  return docs;
}

async function corpusSchemas(files) {
  const out = [];
  for (const name of files) {
    const groups = JSON.parse(await Deno.readTextFile(new URL(name, ROOT)));
    for (const group of groups) out.push({ schema: group.schema, data: group.tests.map((t) => t.data) });
  }
  return out;
}

function stripFuel(result) {
  const { fuelCharged: _fuel, ...rest } = result;
  return rest;
}

// The contract: set verdicts and error lists equal single validations.
function assertEquivalent(engine, routes, docs, options = {}) {
  const set = engine.compileSet(routes, options);
  const singles = routes.map((r) => engine.compile(r, options));
  try {
    assertEquals(set.kind, 'set');
    assertEquals(set.routeCount, routes.length);
    for (const doc of docs) {
      const verdicts = singles.map((s) => s.test(doc));
      const expectedMatch = verdicts.flatMap((v, i) => (v ? [i] : []));
      assertEquals(set.match(doc, options), expectedMatch, `match ${JSON.stringify(doc)}`);
      const all = set.matchAll(doc, options);
      assertEquals(all.length, routes.length);
      for (let i = 0; i < routes.length; i++) {
        const single = stripFuel(singles[i].validate(doc, options));
        assertEquals(all[i].index, i);
        assertEquals(all[i].valid, single.valid, `route ${i} verdict on ${JSON.stringify(doc)}`);
        assertEquals(all[i].errors, single.errors, `route ${i} errors on ${JSON.stringify(doc)}`);
      }
      for (const i of [0, routes.length - 1]) {
        assertEquals(set.test(doc, i, options), verdicts[i]);
      }
    }
  } finally {
    set.dispose();
    for (const s of singles) s.dispose();
  }
}

Deno.test('schema set: discriminator routes match exactly like N single validations', () => {
  const engine = createSchemaEngine();
  const random = rng(7);
  for (let round = 0; round < 6; round++) {
    const routes = discriminatorRoutes(16 + round * 20, random);
    assertEquivalent(engine, routes, documents(random, 40));
  }
});

Deno.test('schema set: routes of every corpus shape are evaluated exactly as alone', async () => {
  const engine = createSchemaEngine();
  const random = rng(11);
  const groups = await corpusSchemas([
    'properties.json', 'required.json', 'type.json', 'anyOf.json', 'oneOf.json', 'allOf.json',
    'enum.json', 'const.json', 'additionalProperties.json', 'items.json', 'not.json', 'if-then-else.json',
    'dependentRequired.json', 'uniqueItems.json', 'pattern.json', 'minimum.json', 'ref.json',
  ]);
  // routes the dialect refuses alone (excluded regex constructs) are
  // refused in a set too; they are not part of the equivalence claim
  const compilable = groups.filter((g) => {
    try { engine.compile(g.schema).dispose(); return true; } catch { return false; }
  });
  const routes = compilable.map((g) => g.schema);
  const docs = compilable.flatMap((g) => g.data).filter(() => random() < 0.5);
  assertEquivalent(engine, routes, docs);
});

Deno.test('schema set: boolean routes, duplicate routes, and a bundle', () => {
  const engine = createSchemaEngine();
  const point = { type: 'object', required: ['x'], properties: { x: { type: 'number' } } };
  const routes = [
    true,
    false,
    { $ref: 'https://example.com/point' },
    { $ref: 'https://example.com/point' },
    { type: 'object', required: ['kind'], properties: { kind: { const: 'a' } } },
    { type: 'object', required: ['kind'], properties: { kind: { const: 'a' } } },
    { required: ['kind'] },
  ];
  const options = { schemas: [['https://example.com/point', point]] };
  assertEquivalent(engine, routes, [{ x: 1 }, { x: 'no' }, { kind: 'a' }, { kind: 'b', x: 2 }, 5, []], options);
});

Deno.test('schema set: one-unit fuel grants decide the same set as one grant', () => {
  const engine = createSchemaEngine();
  const random = rng(3);
  const routes = discriminatorRoutes(24, random);
  routes.push({ type: 'object', properties: { extra: { type: 'object', properties: { deep: { items: { type: 'integer' } } } } } });
  const set = engine.compileSet(routes);
  for (const doc of documents(random, 12)) {
    const whole = set.match(doc);
    const tiny = set.match(doc, { grant: 1 });
    assertEquals(tiny, whole);
    assertEquals(set.matchAll(doc, { grant: 1 }).map((r) => [r.valid, r.errors]), set.matchAll(doc).map((r) => [r.valid, r.errors]));
  }
  set.dispose();
});

Deno.test('schema set: programs reload as sets and keep their verdicts', () => {
  const engine = createSchemaEngine();
  const other = createSchemaEngine();
  const routes = discriminatorRoutes(10, rng(5));
  const set = engine.compileSet(routes);
  const loaded = other.load(set.programBytes);
  assertEquals(loaded.kind, 'set');
  assertEquals(loaded.routeCount, 10);
  for (const doc of documents(rng(9), 10)) {
    assertEquals(loaded.match(doc), set.match(doc));
  }
  assertThrows(() => set.validate({}), TypeError);
  assertThrows(() => set.test({}, 10), RangeError);
});

Deno.test('schema set: the gate pass makes fan-out cost one walk, not N', () => {
  // 64 discriminator routes: the set costs a gate pass plus one unit per
  // route; N single validations cost N full walks. A route with a
  // residual keyword still evaluates once its gates pass (and costs more
  // than a fully gated one); a route whose gates miss never evaluates.
  const engine = createSchemaEngine();
  const n = 64;
  const route = (i, extra) => ({ type: 'object', required: ['kind'], properties: { kind: { const: 'k' + (i % 8) } }, ...extra });
  const gated = engine.compileSet(Array.from({ length: n }, (_, i) => route(i, {})));
  const residual = engine.compileSet(Array.from({ length: n }, (_, i) => route(i, { additionalProperties: false })));
  const singles = Array.from({ length: n }, (_, i) => engine.compile(route(i, {})));
  const doc = { kind: 'k3', p1: 1, p2: 2, p3: 3, p4: 4, p5: 5, p6: 6, p7: 7, p8: 8 };
  const fuelOf = (compiled) => {
    let spent = 0;
    engine._runProgram(compiled, doc, 0, {}, (_c, _s, account) => { spent = engine._spent(account); });
    return spent;
  };
  assertEquals(gated.match(doc), [3, 11, 19, 27, 35, 43, 51, 59]);
  assertEquals(residual.match(doc), []);
  const setFuel = fuelOf(gated);
  const residualFuel = fuelOf(residual);
  const singlesFuel = singles.reduce((sum, s) => sum + fuelOf(s), 0);
  if (!(setFuel < residualFuel)) throw new Error(`fully gated routes evaluate nothing: ${setFuel} vs ${residualFuel}`);
  if (!(setFuel * 4 < singlesFuel)) throw new Error(`set fan-out should be far under N walks: ${setFuel} vs ${singlesFuel}`);
});

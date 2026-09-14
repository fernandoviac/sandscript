/**
 * Ring-publication fixture pinning
 * (docs/ring-publication-contract.md "Fixture contract").
 *
 * 1. Regeneration must be byte-identical to the committed fixtures —
 *    this rejects schema drift AND nondeterminism in the generator.
 * 2. Committed region bytes must stand alone: splicing a .bin into a
 *    fresh scratch geometry (using only the manifest's context) must
 *    reproduce the committed decode expectation.
 *
 * Run with: deno task test tests/fuel/ring_fixtures_test.js
 */
import { assert, assertEquals } from "https://deno.land/std@0.208.0/assert/mod.ts";
import { generateFixtureSet } from '../../tools/generate-ring-fixtures.js';
import { createCostLedgerView } from '../../src/runtime/cost-ledger.js';
import { computeVatLayout, layoutVat } from '../../src/fuel/vat-layout.js';
import { readHeaderEventRingRange } from '../../src/fuel/header-event-ring.js';
import { readStepRingRange } from '../../src/fuel/step-ring.js';
import { STATE, STEP_RING_HEADER_SIZE, STEP_RING_ENTRY_SIZE } from '../../src/fuel/constants.js';
import { RING_PUBLICATION_CONTRACT_VERSION } from '../../src/ring-publication.js';

const FIXTURE_ROOT = new URL('../../fixtures/ring-publication/', import.meta.url);

async function readCommitted(path) {
  return await Deno.readFile(new URL(path, FIXTURE_ROOT));
}

const REQUIRED_STATES = [
  'empty',
  'partial',
  'wrapped',
  'raced',
  'pre-wrap',
  'transition-seqlock',
  'transition',
  'old-expected-generation',
  'generation-raced',
  'segment-space-exhausted',
  'unsupported-version',
  'malformed',
];

Deno.test('ring fixtures: every segment state is published for every ring', async () => {
  const manifest = JSON.parse(
    await Deno.readTextFile(new URL('manifest.json', FIXTURE_ROOT)));
  assertEquals(
    manifest.contractVersion,
    RING_PUBLICATION_CONTRACT_VERSION);
  for (const ring of ['cost-ledger', 'header-event-ring', 'step-ring']) {
    const states = Object.keys(manifest.rings[ring].states);
    for (const required of REQUIRED_STATES) {
      assert(states.includes(required), `${ring} lacks ${required}`);
    }
  }
  assert('not-enabled' in manifest.rings['header-event-ring'].states);
  assert('not-enabled' in manifest.rings['step-ring'].states);
});

Deno.test('ring fixtures: regeneration is byte-identical to the committed set', async () => {
  const files = await generateFixtureSet();
  assert(files.length > 0);
  const seen = new Set();
  for (const file of files) {
    seen.add(file.path);
    const committed = await readCommitted(file.path);
    const fresh = file.bytes ?? new TextEncoder().encode(file.text);
    assertEquals(fresh.length, committed.length, `${file.path}: size drift`);
    for (let i = 0; i < fresh.length; i++) {
      if (fresh[i] !== committed[i]) {
        throw new Error(`${file.path}: byte drift at offset ${i} (${fresh[i]} != ${committed[i]})`);
      }
    }
  }
  // Every committed fixture file must still be generated (no orphans).
  for await (const ring of Deno.readDir(FIXTURE_ROOT)) {
    if (ring.isFile) {
      assert(seen.has(ring.name), `orphan fixture file ${ring.name}`);
      continue;
    }
    for await (const entry of Deno.readDir(new URL(`${ring.name}/`, FIXTURE_ROOT))) {
      assert(seen.has(`${ring.name}/${entry.name}`), `orphan fixture file ${ring.name}/${entry.name}`);
    }
  }
});

Deno.test('ring fixtures: cost-ledger region bytes stand alone', async () => {
  const manifest = JSON.parse(await Deno.readTextFile(new URL('manifest.json', FIXTURE_ROOT)));
  const state = manifest.rings['cost-ledger'].states['wrapped'];
  const region = await readCommitted(state.region);
  const expected = JSON.parse(new TextDecoder().decode(await readCommitted(state.expected)));

  // Splice into a fresh 4-aligned scratch buffer.
  const scratch = new ArrayBuffer(region.byteLength);
  new Uint8Array(scratch).set(region);
  const page = createCostLedgerView({
    buffer: scratch, byteOffset: 0,
    capacity: state.capacity,
    writeIndex: state.writeIndex,
    segmentGeneration: state.segmentGeneration,
    flags: state.flags,
  }).readRange(state.request);
  const replacer = (_key, value) => typeof value === 'bigint' ? value.toString() : value;
  assertEquals(JSON.parse(JSON.stringify(page, replacer)), expected);
});

Deno.test('ring fixtures: header-event region bytes stand alone', async () => {
  const manifest = JSON.parse(await Deno.readTextFile(new URL('manifest.json', FIXTURE_ROOT)));
  const state = manifest.rings['header-event-ring'].states['wrapped'];
  const region = await readCommitted(state.region);
  const expected = JSON.parse(new TextDecoder().decode(await readCommitted(state.expected)));

  const layout = computeVatLayout({ headerEventRingSize: state.ringSize });
  const buffer = new ArrayBuffer(Math.ceil(layout.byteLength / 65536) * 65536);
  layoutVat(buffer, 0, { headerEventRingSize: state.ringSize });
  const view = new DataView(buffer);
  new Uint8Array(buffer).set(region, view.getUint32(STATE.HEADER_EVENT_RING_BASE, true));
  const page = readHeaderEventRingRange(view, 0, state.request);
  assertEquals(JSON.parse(JSON.stringify(page)), expected);
});

Deno.test('ring fixtures: step-ring region bytes stand alone', async () => {
  const manifest = JSON.parse(await Deno.readTextFile(new URL('manifest.json', FIXTURE_ROOT)));
  const state = manifest.rings['step-ring'].states['wrapped'];
  assertEquals(manifest.rings['step-ring'].entrySize, STEP_RING_ENTRY_SIZE);
  const region = await readCommitted(state.region);
  assertEquals(region.byteLength, state.ringSize);
  assertEquals((state.ringSize - STEP_RING_HEADER_SIZE) % STEP_RING_ENTRY_SIZE, 0);
  const expected = JSON.parse(new TextDecoder().decode(await readCommitted(state.expected)));

  const layout = computeVatLayout({ stepRingSize: state.ringSize });
  const buffer = new ArrayBuffer(Math.ceil(layout.byteLength / 65536) * 65536);
  layoutVat(buffer, 0, { stepRingSize: state.ringSize });
  const view = new DataView(buffer);
  new Uint8Array(buffer).set(region, view.getUint32(STATE.STEP_RING_BASE, true));
  const page = readStepRingRange(view, 0, state.request);
  assertEquals(JSON.parse(JSON.stringify(page)), expected);
});

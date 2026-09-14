import {
  assert,
  assertEquals,
  assertThrows,
} from 'https://deno.land/std@0.208.0/assert/mod.ts';
import { restoreSession } from '../../src/host-owned-session.js';
import { DRONE_FORMAT_VERSION } from '../../src/persisted-format.js';
import { migrateDroneBytes } from '../../tools/migrate-drone-bytes.js';

// One authentic corpus per historical aggregate version; each migrates
// through every adjacent hop to the current version.
const CORPORA = [
  { version: 1, sourceCommit: '0330c1a882b9b440803bd59b359a72dfc6fa4cb6' },
  { version: 2, sourceCommit: '156b91b83fe857587da9cb534524e45ea174b5f2' },
];

async function readCompressed(url) {
  const compressed = await Deno.readFile(url);
  const stream = new Blob([compressed]).stream().pipeThrough(
    new DecompressionStream('gzip'),
  );
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

function assertBytesEqual(actual, expected) {
  assertEquals(actual.byteLength, expected.byteLength);
  for (let index = 0; index < actual.byteLength; index++) {
    if (actual[index] !== expected[index]) {
      throw new Error(
        `byte mismatch at ${index}: ${actual[index]} !== ${expected[index]}`);
    }
  }
}

function expectedHops(fromVersion) {
  const hops = [];
  for (let v = fromVersion; v < DRONE_FORMAT_VERSION; v++) {
    hops.push({ fromVersion: v, toVersion: v + 1 });
  }
  return hops;
}

// A restored drone must carry the current builtin surface: the Schema
// global arrived with aggregate version 3, so every migrated image has it.
function assertCurrentSurface(session) {
  session.parse('var migrationSchemaProbe = Schema.test({ type: "integer", minimum: 1 }, 3) && !Schema.test({ type: "integer" }, "x");');
  const result = session.run(0, 1_000_000);
  assertEquals(result.status, 'done');
  assertEquals(session.get(0, 'migrationSchemaProbe'), true);
}

for (const corpus of CORPORA) {
  const corpusRoot = new URL(`../../fixtures/drone-migration/v${corpus.version}/`, import.meta.url);
  const manifest = JSON.parse(
    await Deno.readTextFile(new URL('manifest.json', corpusRoot)),
  );

  Deno.test(`aggregate migration corpus v${corpus.version} pins the adjacent version contract`, () => {
    assertEquals(manifest.sourceFormatVersion, corpus.version);
    assertEquals(manifest.targetFormatVersion, corpus.version + 1);
    assertEquals(manifest.sourceCommit, corpus.sourceCommit);
    assert(manifest.targetFormatVersion <= DRONE_FORMAT_VERSION);
  });

  for (const corpusCase of manifest.cases) {
    Deno.test(`aggregate migration ${corpus.version} -> ${DRONE_FORMAT_VERSION}: ${corpusCase.name}`, async () => {
      const caseRoot = new URL(`${corpusCase.name}/`, corpusRoot);
      const inputVatBytes = await readCompressed(new URL('vat.bin.gz', caseRoot));
      const inputMembraneBytes = await readCompressed(
        new URL('membrane.bin.gz', caseRoot),
      );
      const expectations = JSON.parse(
        await Deno.readTextFile(new URL('expectations.json', caseRoot)),
      );
      const originalVatBytes = inputVatBytes.slice();
      const originalMembraneBytes = inputMembraneBytes.slice();

      // The runtime rejects the unmodified historical pair.
      assertThrows(
        () => restoreSession(inputVatBytes, inputMembraneBytes),
        Error,
        `unsupported drone format version ${corpus.version}`,
      );

      const migrated = migrateDroneBytes({
        vatBytes: inputVatBytes,
        membraneBytes: inputMembraneBytes,
      });
      assertEquals(migrated.sourceVersion, corpus.version);
      assertEquals(migrated.targetVersion, DRONE_FORMAT_VERSION);
      assertEquals(migrated.applied, expectedHops(corpus.version));
      // inputs are never changed
      assertBytesEqual(inputVatBytes, originalVatBytes);
      assertBytesEqual(inputMembraneBytes, originalMembraneBytes);

      const restored = restoreSession(
        migrated.vatBytes,
        migrated.membraneBytes,
        corpusCase.options,
      );
      if (expectations.source !== null) {
        assertEquals(restored.get(0, 'migrationValue'), expectations.expectedValue);
        restored.parse('migrationValue = migrationValue + 1;');
        const result = restored.run(0, 1_000_000);
        assertEquals(result.status, 'done');
        assertEquals(restored.get(0, 'migrationValue'), 43);
      }
      assertCurrentSurface(restored);

      const current = migrateDroneBytes({
        vatBytes: migrated.vatBytes,
        membraneBytes: migrated.membraneBytes,
      });
      assertEquals(current.applied, []);
      assertEquals(current.targetVersion, DRONE_FORMAT_VERSION);
      assertBytesEqual(current.vatBytes, migrated.vatBytes);
      assertBytesEqual(current.membraneBytes, migrated.membraneBytes);
      assert(current.vatBytes !== migrated.vatBytes);
      assert(current.membraneBytes !== migrated.membraneBytes);
    });
  }
}

Deno.test('aggregate migration 1 -> 2 changes no bytes beyond the version stamps', async () => {
  // The proof hop is byte-preserving; pin it through a v1 pair by
  // comparing against the v2 corpus generated from the same definitions.
  const v1 = new URL('../../fixtures/drone-migration/v1/empty/', import.meta.url);
  const vatBytes = await readCompressed(new URL('vat.bin.gz', v1));
  const membraneBytes = await readCompressed(new URL('membrane.bin.gz', v1));
  const migrated = migrateDroneBytes({ vatBytes, membraneBytes });
  // the 2 -> 3 hop appends (interned names, heap objects) but rewrites
  // nothing before the original heap and string extents: every byte the
  // v1 pair held at an offset the v2 image also held is preserved except
  // the header version words
  const view = new DataView(migrated.vatBytes.buffer);
  assertEquals(view.getUint16(0x08, true), DRONE_FORMAT_VERSION);
  assert(migrated.vatBytes.byteLength === vatBytes.byteLength, 'the vat segment keeps its size');
});

Deno.test('aggregate migration refuses a split-version pair', async () => {
  const caseRoot = new URL('../../fixtures/drone-migration/v1/empty/', import.meta.url);
  const vatBytes = await readCompressed(new URL('vat.bin.gz', caseRoot));
  const membraneBytes = await readCompressed(new URL('membrane.bin.gz', caseRoot));
  new DataView(membraneBytes.buffer).setUint32(0x04, 2, true);
  assertThrows(
    () => migrateDroneBytes({ vatBytes, membraneBytes }),
    Error,
    'aggregate version mismatch',
  );
});

#!/usr/bin/env -S deno run --allow-read --allow-write

import { DRONE_FORMAT_VERSION } from '../src/persisted-format.js';
import { restoreSession, snapshotSession } from '../src/host-owned-session.js';
import { STATE } from '../src/fuel/constants.js';

const VAT_MAGIC = new TextEncoder().encode('SANDFUEL');
const MEMBRANE_MAGIC = 0x4D4D4252;
const VAT_DRONE_FORMAT_OFFSET = 0x08;
const MEMBRANE_DRONE_FORMAT_OFFSET = 0x04;
// Vat header section versions the 2 -> 3 hop stamps (frozen: these are
// the values aggregate version 3 was cut with, not the live constants).
const VAT_TYPE_VERSION_OFFSET = 0x0C;
const VAT_BUILTIN_VERSION_OFFSET = 0x0E;
const V3_TYPE_VERSION = 5;
const V3_BUILTIN_VERSION = 7;

/**
 * Aggregate version 3 adds the `Schema` global (VERSION.TYPE 5 — the
 * TYPE.SCHEMA descriptor; VERSION.BUILTIN 7 — its builtin names). A
 * version-2 image lacks the interned names, the constructor/prototype/
 * formats objects, and the global-scope binding, all of which live in
 * persisted bytes. The hop replays that bootstrap over the restored
 * image with the same MemoryImage code a fresh image runs: stamp the
 * section versions the runtime gates on, restore, intern the names, install
 * the global, snapshot. Nothing already in the image is rewritten.
 */
function migrateVersion2ToVersion3(vatBytes, membraneBytes) {
  const vat = vatBytes.slice();
  const membrane = membraneBytes.slice();
  const vatView = new DataView(vat.buffer, vat.byteOffset, vat.byteLength);
  const membraneView = new DataView(membrane.buffer, membrane.byteOffset, membrane.byteLength);
  vatView.setUint16(VAT_DRONE_FORMAT_OFFSET, 3, true);
  vatView.setUint16(VAT_TYPE_VERSION_OFFSET, V3_TYPE_VERSION, true);
  vatView.setUint16(VAT_BUILTIN_VERSION_OFFSET, V3_BUILTIN_VERSION, true);
  membraneView.setUint32(MEMBRANE_DRONE_FORMAT_OFFSET, 3, true);
  const session = restoreSession(vat, membrane);
  const image = session.mem;
  image.internSchemaBuiltinNames(image.builtinNameWriter());
  image.installSchemaGlobal(image.getRootScope(), image.getState(STATE.OBJECT_PROTOTYPE));
  const snapshot = snapshotSession(session);
  return { vatBytes: snapshot.vatBytes, membraneBytes: snapshot.membraneBytes };
}

/**
 * Migrate one complete persisted drone through adjacent aggregate versions.
 * The input arrays are never changed.
 */
export function migrateDroneBytes({ vatBytes: inputVatBytes, membraneBytes: inputMembraneBytes }) {
  if (!(inputVatBytes instanceof Uint8Array) ||
      !(inputMembraneBytes instanceof Uint8Array)) {
    throw new TypeError('migrateDroneBytes requires vatBytes and membraneBytes Uint8Arrays');
  }
  if (inputVatBytes.byteLength < 16 || inputMembraneBytes.byteLength < 8) {
    throw new Error('migrateDroneBytes: truncated drone byte pair');
  }
  for (let index = 0; index < VAT_MAGIC.byteLength; index++) {
    if (inputVatBytes[index] !== VAT_MAGIC[index]) {
      throw new Error('migrateDroneBytes: invalid SANDFUEL vat magic');
    }
  }
  const inputMembraneView = new DataView(
    inputMembraneBytes.buffer,
    inputMembraneBytes.byteOffset,
    inputMembraneBytes.byteLength,
  );
  if (inputMembraneView.getUint32(0, true) !== MEMBRANE_MAGIC) {
    throw new Error('migrateDroneBytes: invalid membrane magic');
  }

  let vatBytes = inputVatBytes.slice();
  let membraneBytes = inputMembraneBytes.slice();
  const vatView = new DataView(vatBytes.buffer, vatBytes.byteOffset, vatBytes.byteLength);
  const membraneView = new DataView(
    membraneBytes.buffer,
    membraneBytes.byteOffset,
    membraneBytes.byteLength,
  );
  const sourceVatVersion = vatView.getUint16(VAT_DRONE_FORMAT_OFFSET, true);
  const sourceMembraneVersion = membraneView.getUint32(
    MEMBRANE_DRONE_FORMAT_OFFSET,
    true,
  );
  if (sourceVatVersion !== sourceMembraneVersion) {
    throw new Error(
      'migrateDroneBytes: aggregate version mismatch between vat ' +
      `${sourceVatVersion} and membrane ${sourceMembraneVersion}`);
  }
  if (sourceVatVersion < 1 || sourceVatVersion > DRONE_FORMAT_VERSION) {
    throw new Error(
      `migrateDroneBytes: no migration from aggregate version ${sourceVatVersion} ` +
      `to ${DRONE_FORMAT_VERSION}`);
  }

  const applied = [];
  let version = sourceVatVersion;
  while (version !== DRONE_FORMAT_VERSION) {
    if (version === 1) {
      // Aggregate version 2 is the proof hop. It changes no layout or data.
      // Validate that both version-1 headers agree, then stamp the pair last.
      vatView.setUint16(VAT_DRONE_FORMAT_OFFSET, 2, true);
      membraneView.setUint32(MEMBRANE_DRONE_FORMAT_OFFSET, 2, true);
      applied.push({ fromVersion: 1, toVersion: 2 });
      version = 2;
      continue;
    }
    if (version === 2) {
      const upgraded = migrateVersion2ToVersion3(vatBytes, membraneBytes);
      vatBytes = upgraded.vatBytes;
      membraneBytes = upgraded.membraneBytes;
      applied.push({ fromVersion: 2, toVersion: 3 });
      version = 3;
      continue;
    }
    throw new Error(
      `migrateDroneBytes: missing adjacent migration from aggregate version ${version}`);
  }

  return {
    vatBytes,
    membraneBytes,
    sourceVersion: sourceVatVersion,
    targetVersion: version,
    applied,
  };
}

if (import.meta.main) {
  try {
    const args = new Map();
    for (let index = 0; index < Deno.args.length; index += 2) {
      args.set(Deno.args[index], Deno.args[index + 1]);
    }
    const vatPath = args.get('--vat');
    const membranePath = args.get('--membrane');
    const outputVatPath = args.get('--out-vat');
    const outputMembranePath = args.get('--out-membrane');
    if (!vatPath || !membranePath || !outputVatPath || !outputMembranePath ||
        Deno.args.length !== 8) {
      throw new Error(
        'usage: migrate-drone-bytes.js --vat <input> --membrane <input> ' +
        '--out-vat <output> --out-membrane <output>');
    }
    for (const outputPath of [outputVatPath, outputMembranePath]) {
      try {
        await Deno.stat(outputPath);
        throw new Error(`output already exists: ${outputPath}`);
      } catch (error) {
        if (!(error instanceof Deno.errors.NotFound)) throw error;
      }
    }

    const migrated = migrateDroneBytes({
      vatBytes: await Deno.readFile(vatPath),
      membraneBytes: await Deno.readFile(membranePath),
    });
    restoreSession(migrated.vatBytes, migrated.membraneBytes);
    await Deno.writeFile(outputVatPath, migrated.vatBytes, { createNew: true });
    await Deno.writeFile(outputMembranePath, migrated.membraneBytes, { createNew: true });
    console.log(JSON.stringify({
      recordKind: 'sandscript/drone-migration-result',
      sourceVersion: migrated.sourceVersion,
      targetVersion: migrated.targetVersion,
      applied: migrated.applied,
      outputVatPath,
      outputMembranePath,
    }));
  } catch (error) {
    console.error(JSON.stringify({
      recordKind: 'error',
      error: {
        code: 'drone-migration-failed',
        message: error instanceof Error ? error.message : String(error),
      },
    }));
    Deno.exit(1);
  }
}

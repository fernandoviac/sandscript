/**
 * Corrupt method-name id repro — the "intern bomb" mechanism.
 *
 * A browser receiver exposed this failure: a
 * freshly spawned drone rejects once with `String too long for interning:
 * ~245 KB`. The oversized value is a malformed error message:
 * "handle:19 has no method '<the drone's entire string table>'".
 *
 * Mechanism: `external_request.methodOffset` arrives corrupt (upstream
 * trigger still unknown). `MemoryReader.readString` trusts the uint32
 * length prefix at whatever offset it's given — a misaligned id reads
 * string-content bytes as a length, yielding a giant garbage slice.
 * `handleExternalCall` then embeds that garbage in the
 * "has no method" message, and `createAndPushError` → `internString`
 * blows the scratch limit. The real error is destroyed by its own
 * error report.
 *
 * These tests pin the DESIRED contract and FAIL before the fix:
 *
 *  1. readString validates the id: it must point at a real entry
 *     inside the used string-table extent, and the entry's length
 *     must not overrun it. Violations throw RangeError instead of
 *     returning a giant (or silently empty) garbage string.
 *
 *  2. handleExternalCall with a corrupt methodOffset surfaces a
 *     BOUNDED, catchable SS-side error — it must not throw a JS-side
 *     "String too long for interning" out of the airlock.
 */

import {
  assert,
  assertEquals,
  assertThrows,
} from "https://deno.land/std@0.208.0/assert/mod.ts";
import { freshSession } from '../../src/host-owned-session.js';
import { parseAndRun } from './test-helpers.js';

/**
 * Intern a marker string and return an id pointing INSIDE its content
 * bytes. The bytes at the corrupt position ('xxxx' = 0x78787878 as a
 * little-endian uint32) decode as a ~2 GB length prefix — the shape
 * that produces the intern bomb in the wild.
 */
function makeCorruptStringId(memoryImage) {
  const markerId = memoryImage.internString('x'.repeat(64));
  // Sanity: the marker itself reads back fine.
  assertEquals(memoryImage.readString(markerId), 'x'.repeat(64));
  // 4 skips the real length prefix; 8 more lands mid-content.
  return markerId + 4 + 8;
}

Deno.test('readString rejects a misaligned id whose fake length overruns the table', () => {
  const session = freshSession();
  const memoryImage = session.airlock.memoryImage;

  const corruptId = makeCorruptStringId(memoryImage);

  assertThrows(
    () => memoryImage.readString(corruptId),
    RangeError,
    undefined,
    'readString must reject an id whose length prefix overruns the ' +
    'used string-table extent, not return a giant garbage string',
  );
});

Deno.test('readString rejects an id beyond the used string-table extent', () => {
  const session = freshSession();
  const memoryImage = session.airlock.memoryImage;

  memoryImage.internString('anchor entry');

  // Ids are table-relative byte offsets; the used extent in id-space
  // is (string_pointer - string_start). Anything at or past it points
  // into NUL padding — today that silently reads length 0 and
  // returns "".
  const usedExtent =
    memoryImage.getStringPointer() - memoryImage.getStringStart();
  const beyondId = usedExtent + 64;

  assertThrows(
    () => memoryImage.readString(beyondId),
    RangeError,
    undefined,
    'readString must reject an id past the used extent, not silently ' +
    'return an empty string',
  );
});

Deno.test('readString rejects an id inside the hash-table region', () => {
  const session = freshSession();
  const memoryImage = session.airlock.memoryImage;

  memoryImage.internString('anchor entry');

  // Real entry ids start AFTER the hash-table region (internString
  // documents 0 as never a valid entry id). Offset 0 is the start of
  // the hash table.
  assertThrows(
    () => memoryImage.readString(0),
    RangeError,
    undefined,
    'readString must reject ids inside the hash-table region',
  );
});

Deno.test('external method binding survives string-table compaction', () => {
  // The UPSTREAM TRIGGER of the intern bomb, reachable through the
  // public session API — no memory pokes needed.
  //
  // `let f = Api.computeAnswerValue` pushes a TYPE_EXTERNAL_METHOD
  // value whose data_hi is the method name's interned-string id. The
  // collector knows nothing about EXTERNAL_METHOD: the id is neither
  // marked nor forwarded. When a GC compacts the string table (here:
  // a pile of dead runtime concat intermediates; in the wild: a young
  // drone's boot-time interning pressure), every live string above
  // the dead region shifts down — and the binding still carries the
  // OLD id. The next `f(...)` ships the stale id as methodOffset and
  // reads garbage (or, pre-bounding, the entire string segment — the
  // intern bomb).
  const session = freshSession();
  const airlock = session.airlock;

  const apiHandle = airlock.register({}, { kind: 'api' });
  airlock.declare('Api', apiHandle);
  airlock.setHandler(apiHandle, 'computeAnswerValue',
    ({ args }) => args[0] * 2);
  airlock.createRootGrant('root-api').add(apiHandle);

  // Fill the string table with runtime-interned garbage that dies
  // before the GC: concat intermediates, then drop the survivor. The
  // point is a LARGE dead region (so compaction relocates everything
  // above it), not a full table — 150 iterations leave headroom for
  // the bootstrap interns, which grow with every ring (Ring 6's
  // messages/fragments overflowed the old 200-iteration fill).
  parseAndRun(session, `
    let junk = "";
    let i = 0;
    while (i < 150) {
      junk = junk + "abcdefgh";
      i = i + 1;
    }
    junk = "";
  `, 0, 1000000);

  // Parse AFTER the junk run so 'computeAnswerValue' is interned
  // above the doomed region, then bind and use the method once.
  parseAndRun(session, `
    let f = Api.computeAnswerValue;
    let before = f(1);
  `, 0, 100000);
  assertEquals(session.get(0, 'before'), 2);

  // Compact. The junk dies; the method-name string survives (it's a
  // code-block operand) but RELOCATES.
  session.gc();

  // The binding must still work — its data_hi must have been
  // forwarded along with every other reference to the string.
  parseAndRun(session, `
    let after = f(2);
  `, 0, 100000);
  assertEquals(session.get(0, 'after'), 4,
    'method binding must survive string-table compaction');
});

Deno.test('corrupt methodOffset surfaces a bounded catchable SS error, not an intern bomb', () => {
  const session = freshSession();
  const airlock = session.airlock;
  const memoryImage = airlock.memoryImage;

  const gadgetHandle = airlock.register({}, { kind: 'gadget' });
  airlock.declare('Gadget', gadgetHandle);
  airlock.setHandler(gadgetHandle, 'poke', () => 42);
  airlock.createRootGrant('root-gadget').add(gadgetHandle);

  session.parse(`
    let caught = "none";
    try {
      Gadget.poke();
    } catch (e) {
      caught = e.message;
    }
  `);

  const corruptId = makeCorruptStringId(memoryImage);

  // Drive the context manually (mirroring session.run's dispatch) so
  // we can corrupt the request block's methodOffset field between the
  // interpreter's yield and the airlock's read — simulating whatever
  // upstream trigger corrupts it in the wild.
  let fuel = 100000;
  let sawExternalCall = false;
  while (true) {
    const result = airlock.runContext(0, fuel);
    fuel = result.fuel;

    if (result.status === 'done') break;

    if (result.status === 'external_call') {
      sawExternalCall = true;
      const requestBase = memoryImage.getExternalRequestBase(0);
      memoryImage.view.setUint32(
        memoryImage.abs(requestBase + 4), corruptId, true);

      // BEFORE the fix this throws the JS-side intern bomb:
      // "String too long for interning: N bytes (max 65536)".
      const externalResult = airlock.handleExternalCall(0, fuel);
      fuel = externalResult.fuel;
      if (!externalResult.threw) {
        airlock.resumeWithValue(0, externalResult.result);
      }
      continue;
    }

    if (result.status === 'external_property') {
      const propertyResult = airlock.handleExternalProperty(0, fuel);
      fuel = propertyResult.fuel;
      if (!propertyResult.threw && 'result' in propertyResult) {
        airlock.resumeWithValue(0, propertyResult.result);
      }
      continue;
    }

    throw new Error(
      `unexpected run status ${result.status}: ${JSON.stringify(result)}`);
  }

  assert(sawExternalCall, 'script should have made an external method call');

  const caught = session.get(0, 'caught');
  assert(caught !== 'none', 'SS code should have caught an error');
  assert(caught.length < 300,
    `SS error message must be bounded; got ${caught.length} chars: ` +
    `${JSON.stringify(caught.slice(0, 120))}...`);
});

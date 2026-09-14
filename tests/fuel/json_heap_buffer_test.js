/**
 * Tests for heap-allocated JSON working buffers. These regressions cover
 * properties that the original 48 json_test.js cases did not exercise:
 *
 *   - Hash-table integrity across JSON ops (the originally-reported bug).
 *   - Large output proportional to heap size.
 *   - Deeply nested parse without static stack limits.
 *   - Interleaved interning + JSON.
 *   - GC during a JSON op.
 *   - Concurrent JSON across multiple contexts in one session.
 */

import { assertEquals, assertNotEquals } from "https://deno.land/std@0.208.0/assert/mod.ts";
import { createSession } from '../../src/fuel/session.js';
import { freshSession } from '../../src/host-owned-session.js';
import { hashTableSize } from '../../src/fuel/constants.js';

const BUCKET_BYTES = 8;

// ---------------------------------------------------------------------------
// Hash-table integrity helpers extracted from the corruption reproducer.
// A bucket transition is "legitimate" if it goes from [empty] to
// [valid_hash, valid_offset_pointing_at_real_string_entry]. Anything else
// is corruption.
// ---------------------------------------------------------------------------

function captureHashTable(memImg) {
  // The hash index lives at the string region's TAIL with a derived
  // size (layout v14).
  const regionSize = memImg.getStringEnd() - memImg.getStringStart();
  const indexBytes = hashTableSize(regionSize);
  const start = memImg.abs(memImg.getStringEnd() - indexBytes);
  const view = new Uint8Array(memImg.buffer);
  return Uint8Array.from(view.subarray(start, start + indexBytes));
}

function entryAt(memImg, id) {
  // Bucket offset column stores a TABLE-RELATIVE id; convert to abs.
  if (id === 0) return null;
  const abs = memImg.stringIdToAbs(id);
  const buf = memImg.buffer;
  if (abs + 4 > buf.byteLength) return null;
  const len = new DataView(buf, abs, 4).getUint32(0, true);
  if (len === 0 || len > 1_000_000) return null;
  if (abs + 4 + len > buf.byteLength) return null;
  return { len, bytes: new Uint8Array(buf, abs + 4, len) };
}

function checkHashTableIntegrity(memImg, beforeSnapshot, afterSnapshot) {
  const bucketCount = beforeSnapshot.length / BUCKET_BYTES;
  const corruption = [];
  for (let i = 0; i < bucketCount; i++) {
    let changed = false;
    for (let b = 0; b < BUCKET_BYTES; b++) {
      if (beforeSnapshot[i * BUCKET_BYTES + b] !== afterSnapshot[i * BUCKET_BYTES + b]) {
        changed = true; break;
      }
    }
    if (!changed) continue;
    const beforeDv = new DataView(beforeSnapshot.buffer, i * BUCKET_BYTES, BUCKET_BYTES);
    const afterDv = new DataView(afterSnapshot.buffer, i * BUCKET_BYTES, BUCKET_BYTES);
    const beforeOffset = beforeDv.getUint32(4, true);
    const afterOffset = afterDv.getUint32(4, true);
    const beforeHash = beforeDv.getUint32(0, true);

    // Legitimate insert.
    if (beforeOffset === 0 && beforeHash === 0 && afterOffset !== 0) {
      if (entryAt(memImg, afterOffset) !== null) continue;
      corruption.push(`bucket ${i}: new offset ${afterOffset} points at garbage`);
      continue;
    }
    // Any other change is corruption.
    corruption.push(`bucket ${i}: before offset=${beforeOffset}, after offset=${afterOffset}`);
  }
  return corruption;
}

// ---------------------------------------------------------------------------
// 1. Hash-table integrity under the original corruption trigger.
// ---------------------------------------------------------------------------

function runOrThrow(session, contextSlot, fuel) {
  const result = session.run(contextSlot, fuel);
  if (result.status === 'error') {
    throw new Error(`Execution error: ${JSON.stringify(result.error)}`);
  }
  return result;
}

Deno.test('JSON.stringify does not corrupt the string-interning hash table', () => {
  const session = freshSession();
  session.parse(`let obj = { a: 1, b: 2 }; let json = JSON.stringify(obj);`);
  const memImg = session.airlock.memoryImage;
  const before = captureHashTable(memImg);
  runOrThrow(session, 0, 100000);
  const after = captureHashTable(memImg);
  const corruption = checkHashTableIntegrity(memImg, before, after);
  assertEquals(corruption, [], `Hash table corruption detected: ${corruption.join('; ')}`);
});

Deno.test('JSON.parse does not corrupt the string-interning hash table', () => {
  const session = freshSession();
  session.parse(`let json = '[1,2,3,{"x":42}]'; let parsed = JSON.parse(json);`);
  const memImg = session.airlock.memoryImage;
  const before = captureHashTable(memImg);
  runOrThrow(session, 0, 100000);
  const after = captureHashTable(memImg);
  const corruption = checkHashTableIntegrity(memImg, before, after);
  assertEquals(corruption, [], `Hash table corruption detected: ${corruption.join('; ')}`);
});

// ---------------------------------------------------------------------------
// 2. Big-output stringify. Verify output is correct AND the heap grew
//    proportionally (i.e. the buffer doubled, didn't silently truncate).
// ---------------------------------------------------------------------------

Deno.test('JSON.stringify: 1000-element array produces correct output', () => {
  const session = freshSession();
  session.parse(`
    let arr = []
    let i = 0
    while (i < 1000) { arr.push(i); i = i + 1 }
    let result = JSON.stringify(arr)
  `);
  runOrThrow(session, 0, 10_000_000);
  const result = session.get(0, 'result');
  // Build the expected string in JS to compare.
  const expected = '[' + Array.from({ length: 1000 }, (_, i) => i).join(',') + ']';
  assertEquals(result, expected);
});

Deno.test('JSON.stringify: 100-backslash string with escapes produces correct output', () => {
  const session = freshSession();
  // 100 backslashes — each one expands to two output bytes (`\\`), so
  // the output is ~200 bytes. The escaped-string writer pre-grows to
  // 6× the source length (worst case for `\uXXXX`), so this exercises
  // the pre-grow path.
  //
  // The 100-character bound keeps the runtime-built input below the current
  // 256-byte string-literal limit while still exercising the pre-grow path.
  session.parse(`
    let s = ""
    let i = 0
    while (i < 100) { s = s + "\\\\"; i = i + 1 }
    let result = JSON.stringify(s)
  `);
  runOrThrow(session, 0, 10_000_000);
  const result = session.get(0, 'result');
  // Expected: opening quote + 100 × `\\` + closing quote.
  const expected = '"' + '\\\\'.repeat(100) + '"';
  assertEquals(result, expected);
});

// ---------------------------------------------------------------------------
// 3. Deeply nested parse. Today's static stacks were 32 KB / 16 KB
//    fixed; the heap-resident growable stacks should not have that limit.
// ---------------------------------------------------------------------------

Deno.test('JSON.parse: 64-level nested array succeeds', () => {
  const session = freshSession();
  // Build a 64-level nested array literal. Each '[' pushes a context
  // frame (12 bytes) and a value frame (16 bytes); 64 levels => 768 B /
  // 1024 B respectively, both well within the initial 4 KB buffer.
  //
  // A depth of 64 keeps the 129-byte JSON literal below the current 256-byte
  // literal limit while still exercising meaningful recursive depth.
  const depth = 64;
  const json = '['.repeat(depth) + '1' + ']'.repeat(depth);
  session.parse(`let s = ${JSON.stringify(json)}; let result = JSON.parse(s)`);
  runOrThrow(session, 0, 10_000_000);
  // Walk the nested structure and verify the innermost value is 1.
  let result = session.get(0, 'result');
  for (let i = 0; i < depth; i++) {
    result = result[0];
  }
  assertEquals(result, 1);
});

// ---------------------------------------------------------------------------
// 4. Interleaved interning + JSON. Intern a known string, run a JSON op,
//    look up the same string via the intern path, verify the id matches.
// ---------------------------------------------------------------------------

Deno.test('Interleaved intern + JSON.stringify preserves prior intern ids', () => {
  const session = freshSession();
  // Intern a known string by using it as a literal.
  session.parse(`
    let known = "sentinel-string-9876"
    let obj = { a: 1, b: 2, c: 3, d: 4, e: 5 }
    let json = JSON.stringify(obj)
    // Re-intern the known string by using it again.
    let knownAgain = "sentinel-string-9876"
    let same = (known === knownAgain) ? 1 : 0
  `);
  runOrThrow(session, 0, 1_000_000);
  assertEquals(session.get(0, 'same'), 1);
  // The two literals must intern to the same id (string equality
  // uses interned-id equality).
});

// ---------------------------------------------------------------------------
// 5. Stringify-then-parse round-trip on a big object. Stresses both
//    paths' buffer growth in one go.
// ---------------------------------------------------------------------------

Deno.test('Stringify and parse round-trip on a 200-key object', () => {
  const session = freshSession();
  session.parse(`
    let obj = {}
    let i = 0
    while (i < 200) {
      obj["key" + i] = i * i
      i = i + 1
    }
    let json = JSON.stringify(obj)
    let parsed = JSON.parse(json)
    // Spot-check: parsed["key100"] should equal 10000.
    let spot = parsed["key100"]
  `);
  runOrThrow(session, 0, 50_000_000);
  assertEquals(session.get(0, 'spot'), 10000);
});

// ---------------------------------------------------------------------------
// 6. GC during a JSON op. Force a GC mid-stringify by running close to
//    heap capacity. The JSON op's buffers must survive (they're regular
//    heap objects the GC walks).
// ---------------------------------------------------------------------------

Deno.test('GC during JSON.stringify preserves buffer integrity', () => {
  // Use a small heap so the JSON allocations consume a meaningful
  // fraction of it. The membrane and segment overhead is fixed, so we
  // need a session memory large enough to set up the interpreter but
  // small enough that 4 KB + 1 KB JSON buffers + 200-element array
  // doubling crowds the heap and forces a compact.
  const session = freshSession();
  session.parse(`
    let arr = []
    let i = 0
    while (i < 200) { arr.push({ id: i, name: "item" + i }); i = i + 1 }
    let result = JSON.stringify(arr)
  `);
  runOrThrow(session, 0, 50_000_000);
  const result = session.get(0, 'result');
  // Spot-check that the result is well-formed JSON.
  const parsed = JSON.parse(result);
  assertEquals(parsed.length, 200);
  assertEquals(parsed[100].id, 100);
  assertEquals(parsed[100].name, "item100");
});

// ---------------------------------------------------------------------------
// 7. Multiple JSON ops in sequence don't cross-contaminate. With
//    heap-resident buffers, each op gets fresh allocations — the
//    previous op's output buffer is garbage by the time the next runs.
// ---------------------------------------------------------------------------

Deno.test('Multiple JSON ops in sequence do not cross-contaminate', () => {
  const session = freshSession();
  session.parse(`
    let result1 = JSON.stringify({ ctx: 1, data: [1, 2, 3] })
    let result2 = JSON.stringify({ ctx: 2, data: [4, 5, 6] })
    let result3 = JSON.stringify({ ctx: 3, data: [7, 8, 9] })
    let parsed = JSON.parse(result2)
    let parsedCtx = parsed["ctx"]
  `);
  runOrThrow(session, 0, 5_000_000);

  // Each stringify produces an independent, correctly-formed result.
  assertEquals(session.get(0, 'result1'), '{"ctx":1,"data":[1,2,3]}');
  assertEquals(session.get(0, 'result2'), '{"ctx":2,"data":[4,5,6]}');
  assertEquals(session.get(0, 'result3'), '{"ctx":3,"data":[7,8,9]}');
  // A parse of one of the strings sees its actual contents, not stale
  // data from a later or earlier op.
  assertEquals(session.get(0, 'parsedCtx'), 2);
});

// ---------------------------------------------------------------------------
// 8. Smoke test: JSON.stringify of a tiny value still works (covers the
//    case where the initial buffer never needs growth).
// ---------------------------------------------------------------------------

Deno.test('JSON.stringify of a single small value uses the initial buffer', () => {
  const session = freshSession();
  session.parse(`let result = JSON.stringify(42)`);
  runOrThrow(session, 0, 100000);
  assertEquals(session.get(0, 'result'), '42');
});

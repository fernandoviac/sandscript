/**
 * String-table hash-index saturation regressions for layout v14. The index
 * used to have a fixed 2048
 * buckets at the region front, and silently broke the dedup invariant
 * once it saturated — $intern_string's exhausted probe loop EVICTED a
 * live bucket, and the GC rebuild silently omitted every live string past the
 * bucket count. Sustained string-table churn then made every property read
 * on decoded capability results return null because
 * $object_find_string_entry compares keys with a raw i32.eq on the interned
 * id, with no byte-equality
 * fallback — so a duplicate entry for the same bytes makes every
 * lookup that mixes the two ids miss silently.
 *
 * Since v14 the index lives at the region TAIL with a bucket count
 * derived from the region size (strictly more buckets than the data
 * span can hold entries), so saturation is structurally impossible and
 * the old eviction/drop paths are traps. These tests retain enough
 * unique live strings to have saturated the old fixed index many
 * times over.
 *
 * Repro shape mirrors the live failure: source-code identifiers
 * ("depotName", "fromSeq") intern at parse time (canonical ids in the
 * bytecode); a churned run then interns 20k unique live strings; a
 * subsequent msgpack.decode re-interns the key names and the compiled
 * property access must still resolve them.
 */

import { assertEquals } from 'https://deno.land/std@0.208.0/assert/mod.ts';
import { freshSession } from '../../src/host-owned-session.js';
import { parseAndSetup } from './test-helpers.js';

function runToDone(session, maxIters = 2000) {
  let result;
  for (let i = 0; i < maxIters; i++) {
    result = session.run(0, 200000);
    if (result.status === 'memory_pressure') {
      session.gc();
      continue;
    }
    if (result.status === 'paused') continue;
    if (result.status === 'out_of_fuel') continue;
    return result;
  }
  return result;
}

// Enough unique retained strings to have filled the old fixed
// 2048-bucket index ten times over — pre-fix, the parse-time buckets
// for "depotName" / "fromSeq" were deterministically evicted by the
// end of the loop.
const CHURN = `
  let keep = []
  let i = 0
  while (i < 20000) { keep.push("u_" + i); i = i + 1 }
`;

const DECODE_AND_READ = `
  let decoded = msgpack.decode(msgpack.encode({ depotName: "front", fromSeq: 12 }))
  let gotName = decoded.depotName
  let gotSeq = decoded.fromSeq
`;

Deno.test('msgpack.decode keys still match compiled property ids after hash-index saturation', () => {
  const session = freshSession({
    heapSize: 2 * 1024 * 1024,
    stringTableSize: 1024 * 1024,
  });
  parseAndSetup(session, CHURN + DECODE_AND_READ);
  const result = runToDone(session);
  assertEquals(result.status, 'done', `expected done, got ${result.status}`);
  assertEquals(session.get(0, 'gotName'), 'front');
  assertEquals(session.get(0, 'gotSeq'), 12);
});

Deno.test('late-interned keys still resolve after a GC rebuild over 20k live strings', () => {
  const session = freshSession({
    heapSize: 2 * 1024 * 1024,
    stringTableSize: 1024 * 1024,
  });
  // Phase 1: accumulate 20k unique LIVE strings, then bind an object
  // property under a key interned LATE — its id sits far past the
  // first 2048 live entries, so the pre-fix rebuild (which re-inserted
  // ascending and silently dropped everything past the bucket count)
  // deterministically left it out of the index. Parse-time canonical
  // ids like "depotName" can NOT pin this site: they are re-inserted
  // first and always keep their buckets.
  parseAndSetup(session, CHURN + `
    let lateKey = "late" + "_probe_" + 7
    let holder = {}
    holder[lateKey] = 99
  `);
  const churnResult = runToDone(session);
  assertEquals(churnResult.status, 'done', `churn: expected done, got ${churnResult.status}`);
  session.gc();
  // Phase 2: re-intern the same key bytes via a DIFFERENT runtime
  // construction (a dropped index entry would make this a duplicate
  // id) and read the property back through it. Also re-check the
  // parse-time canonical keys via the decode path.
  parseAndSetup(session, `
    let probe = "la" + "te_probe" + "_7"
    let gotLate = holder[probe]
  ` + DECODE_AND_READ);
  const result = runToDone(session);
  assertEquals(result.status, 'done', `decode: expected done, got ${result.status}`);
  assertEquals(session.get(0, 'gotLate'), 99);
  assertEquals(session.get(0, 'gotName'), 'front');
  assertEquals(session.get(0, 'gotSeq'), 12);
});

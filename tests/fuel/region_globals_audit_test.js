/**
 * auditRegionGlobals: cross-check the WAT's cached region globals
 * ($base_offset, $string_start, $segment_size, request/error/builtins
 * bases) against their sources of truth (STATE header + baseOffset).
 *
 * The WAT caches these at init_regions / refresh_string_region time; a
 * resize/relocate path that skips the refresh leaves every WAT-side
 * region read systematically displaced while the stored heap stays
 * intact. This audit makes drift in any read-path region global observable at
 * quiescent points, and verify mode (SS_VERIFY_COLLECTIONS=1) checks it after
 * every collection.
 *
 * Run with: deno task test tests/fuel/region_globals_audit_test.js
 */

import { assert, assertEquals } from "https://deno.land/std@0.208.0/assert/mod.ts";
import { freshSession } from '../../src/host-owned-session.js';
import { Collector, STATE } from '../../src/fuel/index.js';

Deno.test('region globals: consistent on a fresh session and across resizeSegment', () => {
  const memory = new WebAssembly.Memory({ initial: 64, maximum: 64, shared: true });
  const session = freshSession({ memory, offset: 0, heapSize: 768 * 1024 });
  const mem = session.airlock.memoryImage;

  session.parse(`let s = "hello region globals"`);
  const r = session.run(0, 100000);
  assertEquals(r.status, 'done');

  const fresh = mem.auditRegionGlobals();
  assertEquals(fresh.mismatches, [], 'fresh session must be consistent');
  assert(fresh.consistent);

  session.resizeSegment({ newSegmentSize: 2 * 1024 * 1024 });

  const resized = mem.auditRegionGlobals();
  assertEquals(resized.mismatches, [],
    'resizeSegment must refresh the cached globals (string_start + segment_size move)');
});

Deno.test('region globals: header drift is detected and named', () => {
  const session = freshSession();
  const mem = session.airlock.memoryImage;

  const realStringStart = mem.view.getUint32(mem.abs(STATE.STRING_START), true);
  // Simulate a mover that updated the header but skipped the WAT
  // refresh: the cached global now disagrees with the header.
  mem.view.setUint32(mem.abs(STATE.STRING_START), realStringStart + 64, true);

  const report = mem.auditRegionGlobals();
  assertEquals(report.consistent, false);
  // A drifted STRING_START also drifts the DERIVED hash-index start
  // (its bucket count is a pure function of the region size), so the
  // audit names both.
  assertEquals(report.mismatches.length, 2);
  assertEquals(report.mismatches[0].global, 'cached_string_start');
  assertEquals(report.mismatches[0].cached, realStringStart);
  assertEquals(report.mismatches[0].expected, realStringStart + 64);
  assertEquals(report.mismatches[1].global, 'cached_hash_table_start');

  mem.view.setUint32(mem.abs(STATE.STRING_START), realStringStart, true);
  assert(mem.auditRegionGlobals().consistent, 'restored header audits clean');
});

Deno.test('verify mode: a collection over drifted region globals dies loudly', () => {
  const session = freshSession();
  const mem = session.airlock.memoryImage;
  session.parse(`let keep = "content so the collection has work"`);
  session.run(0, 100000);

  const realStringStart = mem.view.getUint32(mem.abs(STATE.STRING_START), true);
  mem.view.setUint32(mem.abs(STATE.STRING_START), realStringStart + 64, true);

  const collector = new Collector(mem);
  collector.verifyAfterCollect = true;
  let error = null;
  try { collector.collect(); } catch (e) { error = e; }

  // Restore before asserting so a failure doesn't cascade.
  mem.view.setUint32(mem.abs(STATE.STRING_START), realStringStart, true);

  assert(error, 'verify mode must throw on drifted region globals');
  assertEquals(error.name, 'FatalCollectionError');
  assert(String(error.message).includes('region-globals audit failed')
    || String(error.message).includes('cached_string_start')
    || String(error.message).includes('audit failed'),
    `must name the drift, got: ${String(error.message).slice(0, 160)}`);
});

// FinalizationRegistry recent-fire counter on Membrane.
//
// Unit tests against the membrane's recent-fire counter surface.
// Drives _countFinalizationFire directly to exercise the bucket
// rotation logic without relying on real GC (FR firing is non-
// deterministic).
//
// Run with: deno task test tests/membrane/finalization_counter_test.js

import { assert, assertEquals }
  from "https://deno.land/std@0.208.0/assert/mod.ts";
import { freshMembrane } from '../../src/host-owned-session.js';
import { Membrane, DEFAULT_FR_WINDOW_TICKS } from '../../src/membrane/index.js';

function newMembrane() {
  // Default options — fresh in-process buffer.
  return freshMembrane();
}

Deno.test('recentFinalizationCount: zero before any fires', () => {
  const m = newMembrane();
  assertEquals(m.recentFinalizationCount(), 0);
  assertEquals(m.lifetimeFinalizationFires(), 0);
});

Deno.test('recentFinalizationCount: counts fires within one tick', () => {
  const m = newMembrane();
  for (let i = 0; i < 5; i++) m._countFinalizationFire();
  assertEquals(m.recentFinalizationCount(), 5);
  assertEquals(m.lifetimeFinalizationFires(), 5);
});

Deno.test('recentFinalizationCount: window slides on tick advance', () => {
  const m = newMembrane();
  m._countFinalizationFire();          // tick T: 1 fire
  m.bumpTick();                        // now T+1
  m._countFinalizationFire();          // tick T+1: 1 fire
  m._countFinalizationFire();          // tick T+1: 2 fires
  assertEquals(m.recentFinalizationCount(), 3);
  assertEquals(m.lifetimeFinalizationFires(), 3);
});

Deno.test('recentFinalizationCount: opts.windowTicks scopes the read', () => {
  const m = newMembrane();
  // Three fires across three consecutive ticks.
  m._countFinalizationFire();
  m.bumpTick(); m._countFinalizationFire();
  m.bumpTick(); m._countFinalizationFire();
  assertEquals(m.recentFinalizationCount({ windowTicks: 3 }), 3);
  assertEquals(m.recentFinalizationCount({ windowTicks: 1 }), 1);
  // Window larger than the configured bucket count clamps.
  assertEquals(
    m.recentFinalizationCount({ windowTicks: DEFAULT_FR_WINDOW_TICKS + 1000 }),
    3);
});

Deno.test('recentFinalizationCount: fires outside the window expire', () => {
  const m = newMembrane();
  m._countFinalizationFire();
  // Advance past the window — the early fire should fall out.
  for (let i = 0; i < DEFAULT_FR_WINDOW_TICKS + 5; i++) m.bumpTick();
  m._countFinalizationFire();
  assertEquals(m.recentFinalizationCount(), 1,
    'old fire fell out of the window; only the new fire remains');
  assertEquals(m.lifetimeFinalizationFires(), 2,
    'lifetime keeps both');
});

Deno.test('recentFinalizationCount: gap between fires zeros intermediate buckets', () => {
  const m = newMembrane();
  m._countFinalizationFire();   // bucket A
  // Skip 5 ticks; intermediate buckets should be zero.
  for (let i = 0; i < 5; i++) m.bumpTick();
  m._countFinalizationFire();   // bucket A+6
  // Both fires sit within the window.
  assertEquals(m.recentFinalizationCount(), 2);
  // Now skip past the original — only the recent one should remain.
  for (let i = 0; i < DEFAULT_FR_WINDOW_TICKS; i++) m.bumpTick();
  assertEquals(m.recentFinalizationCount(), 0,
    'both fires now outside window after skipping');
});

Deno.test('recentFinalizationCount: huge tick jump short-circuits to clear', () => {
  const m = newMembrane();
  m._countFinalizationFire();
  // Bump way past the window (simulates a snapshot/restore tick jump).
  for (let i = 0; i < DEFAULT_FR_WINDOW_TICKS * 10; i++) m.bumpTick();
  m._countFinalizationFire();
  assertEquals(m.recentFinalizationCount(), 1,
    'after huge jump, only the new fire counts');
});

Deno.test('_wrapFinalizationCallback: returned function increments and forwards', () => {
  const m = newMembrane();
  let received = null;
  const wrapped = m._wrapFinalizationCallback((heldValue) => {
    received = heldValue;
  });
  wrapped({ slot: 7 });
  assertEquals(received.slot, 7,
    'original callback ran with its held value');
  assertEquals(m.recentFinalizationCount(), 1,
    'counter incremented as a side effect');
  assertEquals(m.lifetimeFinalizationFires(), 1);
});

Deno.test('membrane is still frozen after counter wiring', () => {
  const m = newMembrane();
  let threw = false;
  try { m.somethingNew = 1; } catch (_e) { threw = true; }
  assert(threw, 'adding a new field to the membrane throws (still frozen)');
});

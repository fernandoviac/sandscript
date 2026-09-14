/**
 * Ghost dispatch regression found while auditing handle lifetimes.
 *
 * The airlock's dispatch maps (handlers / handlerOptions / getters /
 * setters) are keyed `${slot}` / `${slot}:name` and were never pruned
 * when compaction freed a handle slot. A later register() reusing the
 * slot inherited the dead tenant's entries: property reads hit the old
 * tenant's getters, method calls hit the old tenant's handlers —
 * capability confusion with a possibly more-privileged dead handle.
 *
 * Compaction now reports the exact freed slots
 * (stats.freedHandleSlots) and the airlock prunes all four maps.
 */

import { assertEquals, assert } from "https://deno.land/std@0.208.0/assert/mod.ts";
import { freshSession } from '../../src/host-owned-session.js';
import { parseAndRun } from './test-helpers.js';

Deno.test('a reused handle slot does not inherit the dead tenant\'s handlers or getters', () => {
  const session = freshSession();
  const airlock = session.airlock;

  const grant = airlock.createRootGrant('root');
  const factory = airlock.register({}, { kind: 'factory' });
  airlock.declare('Factory', factory);
  grant.add(factory);

  let tenantASlot = null;
  airlock.setHandler(factory, 'makeA', () => {
    const a = airlock.register({}, { kind: 'tenant-a' });
    tenantASlot = airlock.membrane.slotOf(a);
    grant.add(a);
    airlock.setGetter(a, 'status', () => 'GHOST-GETTER-A');
    airlock.setHandler(a, 'zap', () => 'GHOST-METHOD-A');
    return a;
  });

  let tenantBSlot = null;
  airlock.setHandler(factory, 'makeB', () => {
    // Tenant B deliberately has NO 'status' getter and NO 'zap' handler.
    const b = airlock.register({}, { kind: 'tenant-b' });
    tenantBSlot = airlock.membrane.slotOf(b);
    grant.add(b);
    airlock.setHandler(b, 'poke', () => 'b-poke');
    return b;
  });

  // Tenant A reaches the drone, gets used, and is dropped.
  parseAndRun(session, `
    let tmp = Factory.makeA()
    let aStatus = tmp.status
    tmp = 0
  `, 0, 1000000);
  assertEquals(session.get(0, 'aStatus'), 'GHOST-GETTER-A');

  // Compaction reaps tenant A's slot.
  session.gc();
  assertEquals(airlock.membrane._handleSlotIsLive(tenantASlot), false,
    'tenant A slot should be reaped (no SS reference remains)');

  // Tenant B reuses the slot. It must see ONLY its own dispatch entries.
  parseAndRun(session, `
    let b = Factory.makeB()
    let bStatus = b.status
    let bPoke = b.poke()
    let zapResult = "not-called"
    try { zapResult = b.zap() } catch (e) { zapResult = "threw: " + e.message }
  `, 0, 1000000);

  assertEquals(tenantBSlot, tenantASlot,
    'precondition: tenant B must reuse tenant A\'s freed slot for this test to bite');
  assert(session.get(0, 'bStatus') !== 'GHOST-GETTER-A',
    'b.status must not hit the dead tenant\'s getter');
  assertEquals(session.get(0, 'bPoke'), 'b-poke');
  const zapResult = session.get(0, 'zapResult');
  assert(typeof zapResult === 'string' && zapResult.includes("has no method 'zap'"),
    `b.zap() must fail loudly (no ghost handler), got: ${JSON.stringify(zapResult)}`);
});

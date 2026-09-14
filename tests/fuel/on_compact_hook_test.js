import { assertEquals, assert } from "https://deno.land/std@0.208.0/assert/mod.ts";
import { parseAndSetup } from './test-helpers.js';
import { freshSession } from '../../src/host-owned-session.js';

function createExternalTestContext() {
  const session = freshSession();
  const { airlock } = session;
  const rootGrant = airlock.createRootGrant();

  function run(source) {
    parseAndSetup(session, source);
    session.run(0, 10000);
  }

  return { session, airlock, rootGrant, run };
}

Deno.test("onCompact: hook fires after gc reaps handles", () => {
  const { session, airlock, rootGrant, run } = createExternalTestContext();

  let compactCallCount = 0;
  let lastLiveSet = null;
  airlock.onCompact = (liveHandleSlots) => {
    compactCallCount++;
    lastLiveSet = new Set(liveHandleSlots);
  };

  const parent = airlock.register({}, { kind: 'parent' });
  rootGrant.add(parent);
  airlock.declare('thing', parent);

  const child = airlock.register({}, { kind: 'child' });
  rootGrant.add(child);
  airlock.setGetter(parent, 'child', () => child);

  run('{ let c = thing.child }');

  assert(airlock.membrane._handleSlotIsLive(child.slot), 'child live before gc');

  session.gc();

  assertEquals(compactCallCount, 1, 'onCompact should fire once');
  assert(lastLiveSet.has(parent.slot), 'parent should be in live set');
  assert(!lastLiveSet.has(child.slot), 'child should NOT be in live set');
  assert(!airlock.membrane._handleSlotIsLive(child.slot), 'child reaped after gc');
});

Deno.test("onCompact: hook does not fire when nothing is reaped", () => {
  const { session, airlock, rootGrant, run } = createExternalTestContext();

  let compactCallCount = 0;
  airlock.onCompact = () => { compactCallCount++; };

  const handle = airlock.register({}, { kind: 'keeper' });
  rootGrant.add(handle);
  airlock.declare('thing', handle);

  run('let kept = thing');

  session.gc();

  assertEquals(compactCallCount, 0, 'onCompact should not fire when nothing reaped');
});

Deno.test("onCompact: cached handle invalidation pattern", () => {
  const { session, airlock, rootGrant, run } = createExternalTestContext();

  const parent = airlock.register({}, { kind: 'parent' });
  rootGrant.add(parent);

  let cachedChild = null;
  const childCache = new Map();

  airlock.setGetter(parent, 'child', () => {
    if (childCache.has('child')) return childCache.get('child');
    cachedChild = airlock.register({}, { kind: 'child' });
    rootGrant.add(cachedChild);
    childCache.set('child', cachedChild);
    airlock.setSetter(cachedChild, 'x', () => {});
    return cachedChild;
  });

  airlock.onCompact = (liveHandleSlots) => {
    for (const [key, handle] of childCache) {
      if (!liveHandleSlots.has(handle.slot)) childCache.delete(key);
    }
  };

  airlock.declare('thing', parent);

  run('{ let c = thing.child }');

  assert(childCache.has('child'), 'cache populated after first access');
  const firstSlot = cachedChild.slot;

  session.gc();

  assert(!childCache.has('child'), 'cache cleared by onCompact');
  assert(!airlock.membrane._handleSlotIsLive(firstSlot), 'old slot reaped');

  run('{ let c = thing.child; c.x = 1 }');

  assert(childCache.has('child'), 'cache repopulated after second access');
  assert(airlock.membrane._handleSlotIsLive(cachedChild.slot), 'new handle is live');
});

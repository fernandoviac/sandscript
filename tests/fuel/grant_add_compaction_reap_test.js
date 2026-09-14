import { assertEquals, assert } from "https://deno.land/std@0.208.0/assert/mod.ts";
import { freshSession } from '../../src/host-owned-session.js';
import { parseAndSetup } from './test-helpers.js';

Deno.test("grant.add compaction reaps the handle being added", () => {
  // Small id-list pool so grant.add triggers pool pressure quickly.
  const session = freshSession({ idListPoolSize: 512 });
  const airlock = session.airlock;
  const rootGrant = airlock.createRootGrant();

  const root = airlock.register({}, { kind: 'root' });
  rootGrant.add(root);
  airlock.declare('thing', root);

  airlock.setHandler(root, 'make', () => {
    // Register a handle, then add it to the grant.
    // If the pool is full, grant.add triggers compaction,
    // which reaps the handle we just registered (it has no
    // SS heap reference yet — the getter hasn't returned).
    const handle = airlock.register({}, { kind: 'child' });
    rootGrant.add(handle);
    airlock.setSetter(handle, 'x', () => {});
    return handle;
  });

  parseAndSetup(session, `
    let error = null
    let count = 0
    let i = 0
    while (i < 40) {
      try {
        let el = thing.make()
        el.x = 1
        count = count + 1
      } catch (err) {
        error = err.message
      }
      i = i + 1
    }
  `);
  session.run(0, 1000000);

  const error = session.get(0, 'error');
  const count = session.get(0, 'count');

  if (error) {
    console.log(`error at count=${count}: ${error}`);
  }

  assertEquals(error, null, `should complete, got: ${error}`);
  assertEquals(count, 40);
});

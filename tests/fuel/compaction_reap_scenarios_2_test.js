import { assertEquals, assert } from "https://deno.land/std@0.208.0/assert/mod.ts";
import { freshSession } from '../../src/host-owned-session.js';
import { parseAndSetup } from './test-helpers.js';

// Scenario 6: many setters registered on one handle exhaust the
// arena or pool, triggering compaction that reaps the handle
// before it's returned.
Deno.test("compaction reap: bulk setter registration exhausts pool", () => {
  const session = freshSession({ idListPoolSize: 512, valueArenaSize: 512 });
  const airlock = session.airlock;
  const rootGrant = airlock.createRootGrant();

  const root = airlock.register({}, { kind: 'root' });
  rootGrant.add(root);
  airlock.declare('thing', root);

  const STYLE_PROPS = [
    'color', 'backgroundColor', 'display', 'position',
    'width', 'height', 'margin', 'padding',
    'border', 'borderRadius', 'fontSize', 'fontWeight',
    'opacity', 'overflow', 'flex', 'gap',
    'top', 'left', 'right', 'bottom',
  ];

  airlock.setHandler(root, 'makeStyled', () => {
    const handle = airlock.register({}, { kind: 'styled' });
    rootGrant.add(handle);
    for (const prop of STYLE_PROPS) {
      airlock.setSetter(handle, prop, () => {});
    }
    return handle;
  });

  parseAndSetup(session, `
    let error = null
    let count = 0
    let i = 0
    while (i < 20) {
      try {
        let el = thing.makeStyled()
        el.color = "red"
        count = count + 1
      } catch (err) {
        error = err.message
      }
      i = i + 1
    }
  `);
  session.run(0, 1000000);

  const error = session.get(0, 'error');
  assertEquals(error, null, `bulk setter registration: ${error}`);
  assertEquals(session.get(0, 'count'), 20);
});

// Scenario 7: grant.add appends to two lists (handle→grant and
// grant→handle). The second _appendToIdList triggers compaction
// after the first partially succeeded.
Deno.test("compaction reap: grant.add second list append triggers pressure", () => {
  // Use a pool size that's just enough to survive the first append
  // but not the second.
  const session = freshSession({ idListPoolSize: 512 });
  const airlock = session.airlock;
  const rootGrant = airlock.createRootGrant();

  const root = airlock.register({}, { kind: 'root' });
  rootGrant.add(root);
  airlock.declare('thing', root);

  airlock.setHandler(root, 'make', () => {
    const handle = airlock.register({}, { kind: 'child' });
    rootGrant.add(handle);
    airlock.setSetter(handle, 'x', () => {});
    return handle;
  });

  parseAndSetup(session, `
    let error = null
    let count = 0
    let i = 0
    while (i < 30) {
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
  assertEquals(error, null, `second list append: ${error}`);
  assertEquals(session.get(0, 'count'), 30);
});

// Scenario 8: airlock.declare writes the name string to the value
// arena. If the arena is tight, declare triggers compaction and
// reaps handles registered in the same external call.
Deno.test("compaction reap: declare triggers arena pressure", () => {
  const session = freshSession({ valueArenaSize: 1024 });
  const airlock = session.airlock;
  const rootGrant = airlock.createRootGrant();

  const root = airlock.register({}, { kind: 'root' });
  rootGrant.add(root);
  airlock.declare('factory', root);

  let counter = 0;
  airlock.setHandler(root, 'makeAndDeclare', () => {
    counter++;
    const handle = airlock.register({}, {
      kind: 'declared-child',
      tag: 'item-' + counter,
    });
    rootGrant.add(handle);
    airlock.declare('dynamic_' + counter, handle);
    airlock.setSetter(handle, 'x', () => {});
    return handle;
  });

  parseAndSetup(session, `
    let error = null
    let count = 0
    let i = 0
    while (i < 15) {
      try {
        let el = factory.makeAndDeclare()
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
  assertEquals(error, null, `declare arena pressure: ${error}`);
  assertEquals(session.get(0, 'count'), 15);
});

// Scenario 9 (createGrant grant-table pressure) removed: creates a
// new grant per iteration without freeing, which exhausts the grant
// table regardless of the in-flight handle fix. Not a handle-reaping
// scenario — it's a grant-table sizing concern.

// Scenario 10: handle added to two grants — the second grant.add
// triggers compaction. The handle has one grant entry already, but
// the walker doesn't see it on the heap (handler hasn't returned).
Deno.test("compaction reap: second grant.add on same handle triggers pressure", () => {
  const session = freshSession({ idListPoolSize: 512 });
  const airlock = session.airlock;
  const rootGrant = airlock.createRootGrant();

  const grantA = airlock.createRootGrant('alpha');
  const grantB = airlock.createRootGrant('beta');

  const root = airlock.register({}, { kind: 'root' });
  rootGrant.add(root);
  grantA.add(root);
  grantB.add(root);
  airlock.declare('thing', root);

  airlock.setHandler(root, 'make', () => {
    const handle = airlock.register({}, { kind: 'dual-grant' });
    grantA.add(handle);
    grantB.add(handle);
    airlock.setSetter(handle, 'x', () => {});
    return handle;
  });

  parseAndSetup(session, `
    let error = null
    let count = 0
    let i = 0
    while (i < 30) {
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
  assertEquals(error, null, `second grant.add: ${error}`);
  assertEquals(session.get(0, 'count'), 30);
});

import { assertEquals, assert } from "https://deno.land/std@0.208.0/assert/mod.ts";
import { freshSession } from '../../src/host-owned-session.js';
import { parseAndSetup } from './test-helpers.js';

function tick(ms = 0) { return new Promise(r => setTimeout(r, ms)); }

async function waitFor(condition, { timeout = 2000, label = 'condition' } = {}) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    if (condition()) return;
    await tick(5);
  }
  throw new Error(`waitFor timed out: ${label}`);
}

// Scenario 1: grant.add pool pressure (same as grant_add_compaction_reap_test)
// Kept here for completeness alongside the other scenarios.
Deno.test("compaction reap: grant.add triggers pool pressure", () => {
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
  assertEquals(error, null, `grant.add pool pressure: ${error}`);
  assertEquals(session.get(0, 'count'), 40);
});

// Scenario 2: handle table pressure — register fills the table,
// second register in the same handler triggers compaction that
// reaps the first handle.
Deno.test("compaction reap: second register reaps first in same handler", () => {
  const session = freshSession({ handleTableCapacity: 8 });
  const airlock = session.airlock;
  const rootGrant = airlock.createRootGrant();

  const root = airlock.register({}, { kind: 'root' });
  rootGrant.add(root);
  airlock.declare('thing', root);

  airlock.setHandler(root, 'makePair', () => {
    const first = airlock.register({}, { kind: 'first' });
    rootGrant.add(first);
    airlock.setSetter(first, 'x', () => {});

    const second = airlock.register({}, { kind: 'second' });
    rootGrant.add(second);
    airlock.setSetter(second, 'y', () => {});

    return first;
  });

  parseAndSetup(session, `
    let error = null
    let count = 0
    let i = 0
    while (i < 20) {
      try {
        let el = thing.makePair()
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
  assertEquals(error, null, `second register reaps first: ${error}`);
  assertEquals(session.get(0, 'count'), 20);
});

// Scenario 3: value arena pressure — register with large metadata
// fills the arena, triggering compaction mid-register.
Deno.test("compaction reap: arena pressure during register metadata", () => {
  const session = freshSession({ valueArenaSize: 512 });
  const airlock = session.airlock;
  const rootGrant = airlock.createRootGrant();

  const root = airlock.register({}, { kind: 'root' });
  rootGrant.add(root);
  airlock.declare('thing', root);

  let counter = 0;
  airlock.setHandler(root, 'make', () => {
    counter++;
    const handle = airlock.register({}, {
      kind: 'child',
      label: 'item-' + counter,
      description: 'a handle with enough metadata to pressure the arena',
    });
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
  assertEquals(error, null, `arena pressure: ${error}`);
  assertEquals(session.get(0, 'count'), 30);
});

// Scenario 4: chained getter pattern — el.style.prop = value,
// where .style returns a handle that is never stored in an SS
// variable (it's a temporary). Compaction during the next
// register reaps it.
Deno.test("compaction reap: chained getter temporary under pressure", () => {
  const session = freshSession({ idListPoolSize: 1024 });
  const airlock = session.airlock;
  const rootGrant = airlock.createRootGrant();

  const root = airlock.register({}, { kind: 'root' });
  rootGrant.add(root);
  airlock.declare('Dom', root);

  airlock.setHandler(root, 'make', () => {
    const node = {};
    const handle = airlock.register(node, { kind: 'element' });
    rootGrant.add(handle);

    airlock.setGetter(handle, 'style', () => {
      const styleHandle = airlock.register({}, { kind: 'style' });
      rootGrant.add(styleHandle);
      airlock.setSetter(styleHandle, 'color', () => {});
      airlock.setSetter(styleHandle, 'padding', () => {});
      airlock.setDefaultSetter(styleHandle, () => {});
      return styleHandle;
    });

    airlock.setSetter(handle, 'textContent', () => {});
    return handle;
  });

  parseAndSetup(session, `
    let error = null
    let count = 0
    let i = 0
    while (i < 30) {
      try {
        let el = Dom.make()
        el.style.color = "red"
        el.style.padding = "4px"
        el.textContent = "hi"
        count = count + 1
      } catch (err) {
        error = err.message
      }
      i = i + 1
    }
  `);
  session.run(0, 1000000);

  const error = session.get(0, 'error');
  assertEquals(error, null, `chained getter temporary: ${error}`);
  assertEquals(session.get(0, 'count'), 30);
});

// Scenario 5: closure callback path — handle registered inside a
// A scheduled closure callback adds to a grant while allocation pressure
// triggers compaction, matching the host callback boundary.
Deno.test("compaction reap: closure callback with grant.add pressure", async () => {
  const { RuntimeBuilder } = await import('../../src/runtime/test-harness.js');

  let runtimeRef = null;

  const cap = {
    name: 'test',
    needs: {},
    setup(airlock) {
      const root = airlock.register({}, { kind: 'root' });
      airlock.declare('thing', root);

      const fireHandle = airlock.register({}, { kind: 'fire' });
      airlock.declare('fire', fireHandle);
      airlock.setHandler(fireHandle, null, ({ args }) => {
        runtimeRef.scheduleClosureCall(args[0], [], {});
      });

      airlock.setHandler(root, 'make', () => {
        const handle = airlock.register({}, { kind: 'child' });
        airlock.setSetter(handle, 'x', () => {});
        return handle;
      });

      return {
        async onGrantRequest(identifier) {
          if (identifier !== 'test') return null;
          for (const entry of airlock.membrane.enumerateGrants()) {
            if (entry.metadata?.kind === 'test-grant') return entry.grant;
          }
          const grant = airlock.membrane.createGrant(identifier, { kind: 'test-grant' });
          grant.add(root);
          grant.add(fireHandle);
          return grant;
        },
      };
    },
  };

  const { runtime, session } = new RuntimeBuilder()
    .onInboundMessage(() => {})
    .sessionOptions({ idListPoolSize: 512 })
    .capability(cap)
    .build();

  runtimeRef = runtime;
  await runtime.start();

  const parsed = session.parse(`
    let error = null
    let count = 0
    grant "test" {
      let callback = () => {
        try {
          let el = thing.make()
          el.x = 1
          count = count + 1
        } catch (err) {
          error = err.message
        }
      }
      let i = 0
      while (i < 30) {
        fire(callback)
        i = i + 1
      }
    }
  `);
  session.setInstruction(0, parsed.startIndex);
  // The async onGrantRequest hook suspends runtime.run(0) before the grant
  // body's 30 fire(callback) scheduling calls run, so wait for those calls
  // to be scheduled and settled rather than using a flat timing sleep.
  await runtime.run(0);
  await waitFor(() => session.get(0, 'count') === 30 || session.get(0, 'error') !== null,
    { label: 'closure callback loop to finish', timeout: 5000 });

  const error = session.get(0, 'error');
  const count = session.get(0, 'count');

  if (error) console.log(`error at count=${count}: ${error}`);

  assertEquals(error, null, `closure callback: ${error}`);
  assertEquals(count, 30);

  await runtime.terminate();
});

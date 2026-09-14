import { assertEquals, assert } from "https://deno.land/std@0.208.0/assert/mod.ts";
import { freshSession } from '../../src/host-owned-session.js';
import { parseAndSetup } from './test-helpers.js';

Deno.test("compaction reaps temporary handle mid-expression", () => {
  // Tiny handle table so pressure fires quickly
  const session = freshSession({ handleTableCapacity: 8 });
  const airlock = session.airlock;
  const rootGrant = airlock.createRootGrant();

  const styleCache = new Map();

  const root = airlock.register({}, { kind: 'root' });
  rootGrant.add(root);

  airlock.setHandler(root, 'make', () => {
    const node = {};
    const handle = airlock.register(node, { kind: 'element' });
    rootGrant.add(handle);

    airlock.setGetter(handle, 'style', () => {
      const cached = styleCache.get(node);
      if (cached) return cached;
      const styleHandle = airlock.register(node, { kind: 'style' });
      rootGrant.add(styleHandle);
      styleCache.set(node, styleHandle);
      airlock.setSetter(styleHandle, 'color', () => {});
      airlock.setDefaultSetter(styleHandle, () => {});
      return styleHandle;
    });

    airlock.setSetter(handle, 'textContent', () => {});
    return handle;
  });

  airlock.declare('Dom', root);

  // onCompact clears the style cache
  airlock.onCompact = (liveHandleSlots) => {
    for (const [node, handle] of styleCache) {
      if (!liveHandleSlots.has(handle.slot)) styleCache.delete(node);
    }
  };

  parseAndSetup(session, `
    let error = null
    let count = 0
    let i = 0
    while (i < 20) {
      try {
        let el = Dom.make()
        el.style.color = "red"
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
  const count = session.get(0, 'count');

  if (error) {
    console.log(`error at count=${count}: ${error}`);
  }

  assertEquals(error, null, `should complete, got: ${error}`);
  assertEquals(count, 20);
});

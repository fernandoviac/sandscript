import { assertEquals, assert } from "https://deno.land/std@0.208.0/assert/mod.ts";
import { parseAndSetup } from './test-helpers.js';
import { freshSession } from '../../src/host-owned-session.js';
import { RuntimeBuilder } from '../../src/runtime/test-harness.js';

function tick(ms = 0) { return new Promise(r => setTimeout(r, ms)); }

async function waitFor(condition, { timeout = 2000, label = 'condition' } = {}) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    if (condition()) return;
    await tick(2);
  }
  throw new Error(`waitFor timed out: ${label}`);
}

Deno.test("onCompact: style-handle pattern — temporary .style access survives pressure compaction", async () => {
  const nodeToStyleHandle = new Map();
  let compactCount = 0;

  const cap = {
    name: 'dom',
    needs: {},
    setup(airlock) {
      const root = airlock.register({}, { kind: 'dom-root' });
      airlock.declare('Dom', root);

      function makeElement() {
        const node = { style: {} };
        const handle = airlock.register(node, { kind: 'element' });

        airlock.setGetter(handle, 'style', () => {
          const cached = nodeToStyleHandle.get(node);
          if (cached) return cached;
          const styleHandle = airlock.register(node.style, { kind: 'style' });
          nodeToStyleHandle.set(node, styleHandle);
          airlock.setSetter(styleHandle, 'color', ({ value }) => { node.style.color = value; });
          airlock.setSetter(styleHandle, 'padding', ({ value }) => { node.style.padding = value; });
          airlock.setDefaultSetter(styleHandle, ({ propName, value }) => { node.style[propName] = value; });
          return styleHandle;
        });

        airlock.setSetter(handle, 'textContent', () => {});
        return handle;
      }

      airlock.setHandler(root, 'createElement', () => makeElement());

      return {
        async onGrantRequest(identifier) {
          if (identifier !== 'dom') return null;
          for (const entry of airlock.membrane.enumerateGrants()) {
            if (entry.metadata?.kind === 'dom-grant') return entry.grant;
          }
          const grant = airlock.membrane.createGrant(identifier, { kind: 'dom-grant' });
          grant.add(root);
          return grant;
        },

        onCompact(liveHandleSlots) {
          compactCount++;
          for (const [node, handle] of nodeToStyleHandle) {
            if (!liveHandleSlots.has(handle.slot)) nodeToStyleHandle.delete(node);
          }
        },
      };
    },
  };

  const { runtime, session } = new RuntimeBuilder()
    .onInboundMessage(() => {})
    .sessionOptions({ handleTableCapacity: 16 })
    .capability(cap)
    .build();

  await runtime.start();

  // Each iteration creates an element + accesses .style (temporary)
  // With handleTableCapacity=16, pressure compaction fires mid-loop.
  // The .style handle is never stored in an SS variable — it's a
  // temporary expression result in `el.style.color = "red"`.
  const parsed = session.parse(`
    let error = null
    let iterations = 0
    grant "dom" {
      let i = 0
      while (i < 30) {
        try {
          let el = Dom.createElement()
          el.style.color = "red"
          el.style.padding = "4px"
          el.textContent = "hi"
          iterations = iterations + 1
        } catch (err) {
          error = err.message
        }
        i = i + 1
      }
    }
  `);
  session.setInstruction(0, parsed.startIndex);
  // Under Runtime, the async onGrantRequest hook makes runtime.run(0) return
  // 'suspended' immediately after GRANT_START rather than running the whole
  // 30-iteration
  // loop to 'done' within one drive episode. Poll for actual completion.
  await runtime.run(0);
  await waitFor(() => session.state(0).exitCondition === 'done',
    { label: 'grant body loop to finish' });

  const error = session.get(0, 'error');
  assert(compactCount >= 1, `compaction should fire under pressure, fired ${compactCount}`);

  if (error) {
    console.log(`error: ${error}`);
    console.log(`compactCount: ${compactCount}`);
    console.log(`nodeToStyleHandle size: ${nodeToStyleHandle.size}`);
  }

  assertEquals(error, null, `should complete without error, got: ${error}`);

  await runtime.terminate();
});

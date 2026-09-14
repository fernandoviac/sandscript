import { assertEquals, assert } from "https://deno.land/std@0.208.0/assert/mod.ts";
import { RuntimeBuilder } from '../../src/runtime/test-harness.js';

function tick(ms = 0) { return new Promise(r => setTimeout(r, ms)); }

async function waitFor(condition, { timeout = 2000, label = 'condition' } = {}) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    if (condition()) return;
    await tick(5);
  }
  throw new Error(`waitFor timed out: ${label}`);
}

Deno.test("onCompact: closure callback with temporary style handles under pressure", async () => {
  const nodeToStyleHandle = new Map();
  let compactCount = 0;
  let runtimeRef = null;

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
          airlock.setSetter(styleHandle, 'borderBottom', ({ value }) => { node.style.borderBottom = value; });
          airlock.setSetter(styleHandle, 'marginRight', ({ value }) => { node.style.marginRight = value; });
          airlock.setDefaultSetter(styleHandle, ({ propName, value }) => { node.style[propName] = value; });
          return styleHandle;
        });

        airlock.setSetter(handle, 'textContent', () => {});
        airlock.setHandler(handle, 'setAttribute', () => {});
        airlock.setHandler(handle, 'append', () => {});
        return handle;
      }

      airlock.setHandler(root, 'createElement', () => makeElement());

      const fireHandle = airlock.register({}, { kind: 'fire' });
      airlock.declare('fire', fireHandle);
      airlock.setHandler(fireHandle, null, ({ args }) => {
        const closureHandle = args[0];
        runtimeRef.scheduleClosureCall(closureHandle, [], {});
      });

      return {
        async onGrantRequest(identifier) {
          if (identifier !== 'dom') return null;
          for (const entry of airlock.membrane.enumerateGrants()) {
            if (entry.metadata?.kind === 'dom-grant') return entry.grant;
          }
          const grant = airlock.membrane.createGrant(identifier, { kind: 'dom-grant' });
          grant.add(root);
          grant.add(fireHandle);
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

  runtimeRef = runtime;
  await runtime.start();

  const parsed = session.parse(`
    let error = null
    let count = 0
    grant "dom" {
      let callback = () => {
        try {
          count = count + 1
          let row = Dom.createElement()
          row.setAttribute("role", "listitem")
          row.style.padding = "6px 0"
          row.style.borderBottom = "1px solid #2b313a"
          let label = Dom.createElement()
          label.style.marginRight = "10px"
          label.textContent = "SENT"
          row.append(label)
          let detail = Dom.createElement()
          detail.style.color = "#8b949e"
          detail.textContent = "item"
          row.append(detail)
        } catch (err) {
          error = err.message
        }
      }
      let i = 0
      while (i < 20) {
        fire(callback)
        i = i + 1
      }
    }
  `);
  session.setInstruction(0, parsed.startIndex);
  // The async onGrantRequest hook suspends runtime.run(0) before the grant
  // body's 20 fire(callback) scheduling calls run, so wait for those calls
  // to be scheduled and settled rather than using a flat timing sleep.
  await runtime.run(0);
  await waitFor(() => session.get(0, 'count') === 20 || session.get(0, 'error') !== null,
    { label: 'closure callbacks to drain', timeout: 5000 });

  const error = session.get(0, 'error');
  const count = session.get(0, 'count');

  if (error) {
    console.log(`error at count=${count}: ${error}`);
    console.log(`compactCount: ${compactCount}`);
  }

  assert(compactCount >= 1, `compaction should fire under pressure, fired ${compactCount}`);
  assertEquals(error, null, `should complete without error, got: ${error}`);
  assertEquals(count, 20, `all 20 callbacks should complete`);

  await runtime.terminate();
});

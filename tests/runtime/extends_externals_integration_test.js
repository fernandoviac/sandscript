/**
 * A stub host declares an HTMLElement handle, registers it as constructible,
 * and drives StatusPanel source through definition-time static reads, host
 * construction, constructor candidate delivery, object-handle reification,
 * and each lifecycle callback. This fixture proves the SandScript substrate
 * end to end without depending on another repository's integration harness.
 */

import {
  assert,
  assertEquals,
  assertStrictEquals,
} from 'https://deno.land/std@0.208.0/assert/mod.ts';
import { RuntimeBuilder } from '../../src/runtime/index.js';

// The StatusPanel source is wrapped in the grant that carries the stub host's
// handles.
const SOURCE = `
  let ready = false;
  grant "dom" {
    class StatusPanel extends HTMLElement {
      static observedAttributes = ["status"];
      constructor() {
        super();
        this.attachShadow({ mode: "open" });
      }
      connectedCallback() {
        this.shadowRoot.textContent = "ready";
      }
      attributeChangedCallback(name, oldValue, newValue) {
        this.shadowRoot.textContent = newValue;
      }
    }
    customElements.define("status-panel", StatusPanel);
    ready = true;
  } denied {}
`;

Deno.test('integration: StatusPanel defines, constructs, and runs every lifecycle callback', async () => {
  // ---- Stub host ----
  const host = {
    definitions: new Map(),   // tag name -> { classHandle, observedAttributes }
    elements: new Map(),      // backing Handle slot -> element record
    lifecycleLog: [],
  };
  let airlockRef = null;
  const capability = {
    name: 'dom-stub',
    needs: {},
    setup(airlock) {
      airlockRef = airlock;
      const html = airlock.register({});
      const customElements = airlock.register({});
      const grant = airlock.membrane.createGrant('dom');
      grant.add(html);
      grant.add(customElements);
      host.grant = grant;

      airlock.setConstructible(html, {
        beginConstruction() {
          const element = { shadowRoot: null, attributes: new Map() };
          const backing = airlock.register(element);
          grant.add(backing);
          host.elements.set(backing.slot, element);
          airlock.setHasProperty(backing, ({ name }) =>
            name === 'attachShadow' || name === 'shadowRoot');
          airlock.setGetter(backing, 'shadowRoot', () => {
            // The shadow root is itself a host value with a writable
            // textContent surface.
            return element.shadowRootHandle;
          });
          airlock.setHandler(backing, 'attachShadow', ({ args }) => {
            assertEquals(args[0], { mode: 'open' });
            element.shadowRoot = { textContent: '' };
            const shadowHandle = airlock.register(element.shadowRoot);
            grant.add(shadowHandle);
            airlock.setHasProperty(shadowHandle, ({ name }) => name === 'textContent');
            airlock.setGetter(shadowHandle, 'textContent',
              () => element.shadowRoot.textContent);
            airlock.setSetter(shadowHandle, 'textContent', ({ value }) => {
              element.shadowRoot.textContent = value;
            });
            element.shadowRootHandle = shadowHandle;
            host.lifecycleLog.push(['attachShadow', backing.slot]);
            return shadowHandle;
          });
          host.lifecycleLog.push(['begin', backing.slot]);
          return backing;
        },
        completeConstruction(backingHandle, receiverObjectHandle) {
          host.lifecycleLog.push(['complete', backingHandle.slot]);
          host.elements.get(backingHandle.slot).instanceHandle = receiverObjectHandle;
        },
        abortConstruction(backingHandle) {
          host.lifecycleLog.push(['abort', backingHandle.slot]);
        },
      });

      airlock.setHandler(customElements, 'define', ({ args }) => {
        const [tagName, classHandle] = args;
        // Constructor candidate delivery: the class arrives as a
        // ClosureHandle the host retains for later construction.
        host.definitions.set(tagName, { classHandle });
        return null;
      });
      airlock.declare('HTMLElement', html);
      airlock.declare('customElements', customElements);
      return {
        onGrantRequest(identifier) {
          return identifier === 'dom' ? grant : null;
        },
      };
    },
  };

  // ---- Boot and define ----
  const built = new RuntimeBuilder()
    .onInboundMessage(() => {})
    .capability(capability)
    .build();
  const runtime = built.runtime;
  await runtime.start();
  built.session.parse(SOURCE);
  await runtime.run(0);
  for (let i = 0; i < 200 && built.session.get(0, 'ready') !== true; i++) {
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assertEquals(built.session.get(0, 'ready'), true);
  assert(host.definitions.has('status-panel'));
  const definition = host.definitions.get('status-panel');

  // ---- Definition-time static read (the Web Components define path) ----
  definition.observedAttributes = await runtime.getClosureProperty(
    definition.classHandle, 'observedAttributes',
    { resultConversion: 'iterable-string-sequence' });
  assertEquals(definition.observedAttributes, ['status']);

  // ---- Host construction (document.createElement("status-panel")) ----
  const instance = await runtime.constructClosure(definition.classHandle, []);
  assertEquals(host.lifecycleLog.map((entry) => entry[0]),
    ['begin', 'attachShadow', 'complete']);
  const [, backingSlot] = host.lifecycleLog[0];
  const element = host.elements.get(backingSlot);
  assertEquals(element.shadowRoot.textContent, '');
  // The interned handle the host keeps IS the constructed instance.
  assertStrictEquals(element.instanceHandle, instance);

  // ---- connectedCallback ----
  const connected = await runtime.getObjectProperty(instance, 'connectedCallback');
  await runtime.invokeClosureWithReceiver(connected, instance, []);
  assertEquals(element.shadowRoot.textContent, 'ready');

  // ---- attributeChangedCallback ----
  const attributeChanged = await runtime.getObjectProperty(
    instance, 'attributeChangedCallback');
  await runtime.invokeClosureWithReceiver(
    attributeChanged, instance, ['status', null, 'critical']);
  assertEquals(element.shadowRoot.textContent, 'critical');

  // ---- Object-handle reification: an event-target style return ----
  // A handler returning the retained instance hands the drone the
  // ORIGINAL vat object; instanceof answers through the surrogate.
  const probe = airlockRef.register({});
  host.grant.add(probe);
  airlockRef.setHandler(probe, 'target', () => instance);
  airlockRef.declare('probe', probe);
  built.session.parse(`
    let sameIdentity = null;
    let isPanel = null;
    grant "dom" {
      const target = probe.target();
      isPanel = target instanceof HTMLElement;
      sameIdentity = (probe.target() === target);
    } denied {}
  `);
  await runtime.run(0);
  for (let i = 0; i < 200 && built.session.get(0, 'sameIdentity') === null; i++) {
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assertEquals(built.session.get(0, 'isPanel'), true);
  assertEquals(built.session.get(0, 'sameIdentity'), true);

  // ---- Cleanup ----
  runtime.releaseClosureHandle(connected);
  runtime.releaseClosureHandle(attributeChanged);
  runtime.releaseObjectHandle(instance);
  await runtime.terminate();
  built.channels.close();
});

import { assertEquals, assert } from "https://deno.land/std@0.208.0/assert/mod.ts";
import { RuntimeBuilder } from '../../src/runtime/test-harness.js';

Deno.test("Gap 2: handler returns Uint8Array, drone receives it", async () => {
  let observed = null;
  const { runtime, session, channels } = new RuntimeBuilder()
    .capability({
      name: 'host',
      setup: (al) => {
        const rootGrant = al.createRootGrant();
        const handle = al.register({});
        rootGrant.add(handle);
        al.setHandler(handle, 'makeBytes', () => {
          return new Uint8Array([10, 20, 30]);
        });
        al.setHandler(handle, 'check', ({ args }) => {
          observed = args[0];
          return null;
        });
        al.declare('Host', handle);
      },
    })
    .onInboundMessage(() => {})
    .build();
  await runtime.start();

  session.parse(`
    const buf = Host.makeBytes();
    const results = [buf[0], buf[1], buf[2], buf.length];
    Host.check(results);
  `);

  const result = await runtime.run(0);
  assertEquals(result.status, 'done');
  assertEquals(observed, [10, 20, 30, 3]);

  await runtime.terminate();
  channels.close();
});

Deno.test("Gap 2: handler returns ArrayBuffer, drone receives it", async () => {
  let observed = null;
  const { runtime, session, channels } = new RuntimeBuilder()
    .capability({
      name: 'host',
      setup: (al) => {
        const rootGrant = al.createRootGrant();
        const handle = al.register({});
        rootGrant.add(handle);
        al.setHandler(handle, 'makeBuffer', () => {
          const ab = new ArrayBuffer(3);
          new Uint8Array(ab).set([5, 10, 15]);
          return ab;
        });
        al.setHandler(handle, 'check', ({ args }) => {
          observed = args[0];
          return null;
        });
        al.declare('Host', handle);
      },
    })
    .onInboundMessage(() => {})
    .build();
  await runtime.start();

  session.parse(`
    const ab = Host.makeBuffer();
    const view = new Uint8Array(ab);
    const results = [view[0], view[1], view[2], view.length];
    Host.check(results);
  `);

  const result = await runtime.run(0);
  assertEquals(result.status, 'done');
  assertEquals(observed, [5, 10, 15, 3]);

  await runtime.terminate();
  channels.close();
});

Deno.test("Gap 1: heapViewTypedArrays — handler mutates Uint8Array in-place, drone sees mutation", async () => {
  let observed = null;
  const { runtime, session, channels } = new RuntimeBuilder()
    .capability({
      name: 'host',
      setup: (al) => {
        const rootGrant = al.createRootGrant();
        const handle = al.register({});
        rootGrant.add(handle);
        al.setHandler(handle, 'fillRandom', ({ args }) => {
          const buf = args[0];
          buf[0] = 42;
          buf[1] = 99;
          buf[2] = 7;
          return null;
        }, { heapViewTypedArrays: true });
        al.setHandler(handle, 'check', ({ args }) => {
          observed = args[0];
          return null;
        });
        al.declare('Host', handle);
      },
    })
    .onInboundMessage(() => {})
    .build();
  await runtime.start();

  session.parse(`
    const buf = new Uint8Array(3);
    Host.fillRandom(buf);
    const results = [buf[0], buf[1], buf[2]];
    Host.check(results);
  `);

  const result = await runtime.run(0);
  assertEquals(result.status, 'done');
  assertEquals(observed, [42, 99, 7]);

  await runtime.terminate();
  channels.close();
});

Deno.test("Gap 1: without heapViewTypedArrays, handler mutation is invisible to drone", async () => {
  let observed = null;
  const { runtime, session, channels } = new RuntimeBuilder()
    .capability({
      name: 'host',
      setup: (al) => {
        const rootGrant = al.createRootGrant();
        const handle = al.register({});
        rootGrant.add(handle);
        al.setHandler(handle, 'fillRandom', ({ args }) => {
          const buf = args[0];
          buf[0] = 42;
          buf[1] = 99;
          buf[2] = 7;
          return null;
        });
        al.setHandler(handle, 'check', ({ args }) => {
          observed = args[0];
          return null;
        });
        al.declare('Host', handle);
      },
    })
    .onInboundMessage(() => {})
    .build();
  await runtime.start();

  session.parse(`
    const buf = new Uint8Array(3);
    Host.fillRandom(buf);
    const results = [buf[0], buf[1], buf[2]];
    Host.check(results);
  `);

  const result = await runtime.run(0);
  assertEquals(result.status, 'done');
  assertEquals(observed, [0, 0, 0]);

  await runtime.terminate();
  channels.close();
});

Deno.test("By-ref return: heap-view Uint8Array returned from handler skips copy", async () => {
  let observed = null;
  const { runtime, session, channels } = new RuntimeBuilder()
    .capability({
      name: 'host',
      setup: (al) => {
        const rootGrant = al.createRootGrant();
        const handle = al.register({});
        rootGrant.add(handle);
        al.setHandler(handle, 'getRandomValues', ({ args }) => {
          const buf = args[0];
          buf[0] = 11;
          buf[1] = 22;
          buf[2] = 33;
          return buf;
        }, { heapViewTypedArrays: true });
        al.setHandler(handle, 'check', ({ args }) => {
          observed = args[0];
          return null;
        });
        al.declare('Host', handle);
      },
    })
    .onInboundMessage(() => {})
    .build();
  await runtime.start();

  session.parse(`
    const buf = new Uint8Array(3);
    const returned = Host.getRandomValues(buf);
    const results = [buf[0], buf[1], buf[2], returned[0], returned[1], returned[2]];
    Host.check(results);
  `);

  const result = await runtime.run(0);
  assertEquals(result.status, 'done');
  assertEquals(observed, [11, 22, 33, 11, 22, 33]);

  await runtime.terminate();
  channels.close();
});

Deno.test("By-ref return: foreign Uint8Array returned from handler is copied normally", async () => {
  let observed = null;
  const { runtime, session, channels } = new RuntimeBuilder()
    .capability({
      name: 'host',
      setup: (al) => {
        const rootGrant = al.createRootGrant();
        const handle = al.register({});
        rootGrant.add(handle);
        al.setHandler(handle, 'makeFresh', () => {
          return new Uint8Array([77, 88, 99]);
        });
        al.setHandler(handle, 'check', ({ args }) => {
          observed = args[0];
          return null;
        });
        al.declare('Host', handle);
      },
    })
    .onInboundMessage(() => {})
    .build();
  await runtime.start();

  session.parse(`
    const buf = Host.makeFresh();
    const results = [buf[0], buf[1], buf[2]];
    Host.check(results);
  `);

  const result = await runtime.run(0);
  assertEquals(result.status, 'done');
  assertEquals(observed, [77, 88, 99]);

  await runtime.terminate();
  channels.close();
});

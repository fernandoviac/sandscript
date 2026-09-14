/**
 * A capability rejection delivered to a context parked INSIDE A SYNC
 * FRAME of an async body must reject the async fn's own promise — not
 * "promise 0".
 *
 * The triggering shape is:
 *
 *   async fn (no try/catch) → sync helper → suspending cap call → reject
 *
 * The park leaves the sync helper's PLAIN frame on top of the async
 * frame. The WAT's throw dispatch decides EXIT_ASYNC_REJECTED by
 * reading the BASE frame's ASYNC_PROMISE and does NOT pop the plain
 * frames above it before yielding. The airlock's settle handlers used
 * to read the TOP frame instead: they found ASYNC_PROMISE = 0 and
 * settled "promise 0" — writing the rejection status/value/waiters
 * into the SEGMENT HEADER (stomping the snapshot magic bytes) and
 * walking a garbage waiter list (raw DataView OOB pre-tripwires; the
 * drone's listener then died and its subscription halted).
 *
 * Pinned here:
 *   1. The exact sandwich: catch in the awaiting listener fires with
 *      the rejection message, and the closure survives to a second
 *      fire (red pre-fix: catch never ran, handler error
 *      'promise pointer 0').
 *   2. A deeper sandwich (two sync frames) behaves the same.
 *   3. The resolve path through a sync frame still delivers the value
 *      (EXIT_ASYNC_COMPLETE's base==top guarantee — regression guard
 *      for the base-frame read).
 */

import { assertEquals, assert } from "https://deno.land/std@0.208.0/assert/mod.ts";
import { RuntimeBuilder } from '../../src/runtime/test-harness.js';

function tick(ms = 0) { return new Promise(r => setTimeout(r, ms)); }

async function waitFor(condition, { timeout = 3000, label = 'condition' } = {}) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    if (condition()) return;
    await tick(2);
  }
  throw new Error(`waitFor timed out: ${label}`);
}

async function buildRig() {
  const captured = { listener: null, settlers: [], handlerErrors: [] };
  const cap = {
    name: 'cap',
    setup(airlock) {
      const h = airlock.register({});
      airlock.setHandler(h, 'reg', ({ args }) => { captured.listener = args[0]; return 0; });
      airlock.setHandler(h, 'manual', ({ context }) => {
        return context.suspend((resolve, reject) => {
          captured.settlers.push({ resolve, reject });
        });
      });
      const grant = airlock.membrane.createGrant('cap');
      grant.add(h);
      airlock.declare('Cap', h);
      return {
        onGrantRequest(id) { return id === 'cap' ? grant : null; },
      };
    },
  };
  const { runtime, session, channels } = new RuntimeBuilder()
    .capability(cap)
    .onInboundMessage(() => {})
    .onHandlerError((rej) => { captured.handlerErrors.push(rej); })
    .build();
  await runtime.start();
  return { runtime, session, channels, captured };
}

async function teardown(rig) {
  await rig.runtime.terminate();
  rig.channels.close();
}

Deno.test('cap rejection through async→sync→cap sandwich reaches the awaiting catch; listener survives', async () => {
  const rig = await buildRig();
  const { runtime, session, captured } = rig;

  const parsed = session.parse(`
    let caught = null
    let fires = 0
    grant "cap" {
      let syncGet = (name) => {
        return Cap.manual(name)
      }
      let readThing = async (name) => {
        let value = syncGet(name)
        return value
      }
      Cap.reg(async (event) => {
        fires = fires + 1
        try {
          await readThing("NOPE")
        } catch (err) {
          caught = err.message
        }
      })
    }
  `);
  session.setInstruction(0, parsed.startIndex);
  await runtime.run(0);
  await waitFor(() => captured.listener !== null, { label: 'listener registered' });

  runtime.scheduleClosureCall(captured.listener, [{ n: 1 }], {});
  await waitFor(() => captured.settlers.length === 1, { label: 'cap call parked' });

  captured.settlers[0].reject(new Error('sandwich rejection'));
  await waitFor(() => session.get(0, 'caught') !== null, { label: 'listener catch' });
  assertEquals(session.get(0, 'caught'), 'sandwich rejection');

  // Survival: the listener must take a second fire after the caught throw.
  runtime.scheduleClosureCall(captured.listener, [{ n: 2 }], {});
  await waitFor(() => session.get(0, 'fires') === 2, { label: 'second fire' });

  assertEquals(captured.handlerErrors.length, 0,
    `no handler errors expected, got: ${captured.handlerErrors.map((r) => r?.cause?.message ?? r?.message).join(' | ')}`);
  await teardown(rig);
});

Deno.test('two stacked sync frames between the async body and the cap call behave the same', async () => {
  const rig = await buildRig();
  const { runtime, session, captured } = rig;

  const parsed = session.parse(`
    let caught = null
    grant "cap" {
      let inner = (name) => {
        return Cap.manual(name)
      }
      let outer = (name) => {
        return inner(name)
      }
      let readThing = async (name) => {
        let value = outer(name)
        return value
      }
      Cap.reg(async (event) => {
        try {
          await readThing("NOPE")
        } catch (err) {
          caught = err.message
        }
      })
    }
  `);
  session.setInstruction(0, parsed.startIndex);
  await runtime.run(0);
  await waitFor(() => captured.listener !== null, { label: 'listener registered' });

  runtime.scheduleClosureCall(captured.listener, [{}], {});
  await waitFor(() => captured.settlers.length === 1, { label: 'cap call parked' });
  captured.settlers[0].reject(new Error('deep sandwich rejection'));
  await waitFor(() => session.get(0, 'caught') !== null, { label: 'listener catch' });
  assertEquals(session.get(0, 'caught'), 'deep sandwich rejection');
  assertEquals(captured.handlerErrors.length, 0);
  await teardown(rig);
});

Deno.test('cap RESOLUTION through the same sandwich still delivers the value', async () => {
  const rig = await buildRig();
  const { runtime, session, captured } = rig;

  const parsed = session.parse(`
    let got = null
    grant "cap" {
      let syncGet = (name) => {
        return Cap.manual(name)
      }
      let readThing = async (name) => {
        let value = syncGet(name)
        return value
      }
      Cap.reg(async (event) => {
        got = await readThing("YES")
      })
    }
  `);
  session.setInstruction(0, parsed.startIndex);
  await runtime.run(0);
  await waitFor(() => captured.listener !== null, { label: 'listener registered' });

  runtime.scheduleClosureCall(captured.listener, [{}], {});
  await waitFor(() => captured.settlers.length === 1, { label: 'cap call parked' });
  captured.settlers[0].resolve('the-value');
  await waitFor(() => session.get(0, 'got') !== null, { label: 'value delivered' });
  assertEquals(session.get(0, 'got'), 'the-value');
  assertEquals(captured.handlerErrors.length, 0);
  await teardown(rig);
});

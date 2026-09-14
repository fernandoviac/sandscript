import {
  assert,
  assertEquals,
} from "https://deno.land/std@0.208.0/assert/mod.ts";
import { freshSession } from "../../src/host-owned-session.js";
import { PROMISE } from "../../src/fuel/constants.js";
import { HeapPressureSignal } from "../../src/fuel/memory-image.js";

Deno.test("internal promise settlement marshal under heap pressure self-heals via gc", () => {
  const session = freshSession({ heapSize: 128 * 1024 });
  const memoryImage = session.memoryImage;
  const airlock = session.airlock;
  const parsed = session.parse(`
    let value = []
    let index = 0
    while (index < 100) {
      value.push(index)
      index = index + 1
    }
    let promise = new Promise((resolve) => resolve(value))
  `);
  session.setInstruction(0, parsed.startIndex);

  const constructorResult = session.run(0, 100000);
  assertEquals(constructorResult.status, "promise_method");
  assertEquals(constructorResult.contexts.length, 1);
  const executorIdentity = constructorResult.contexts[0];
  const executorSlot = executorIdentity.slot;
  const settleExit = airlock.runContext(executorIdentity.slot, 100000);
  assertEquals(settleExit.status, "promise_settle");

  // Fill the remaining heap with unreachable blocks after the executor has
  // yielded but before the host marshals its settlement value. Collection can
  // reclaim every filler block, making the first marshal fail and the retry fit.
  let pressureObserved = false;
  for (let allocation = 0; allocation < 10000; allocation++) {
    try {
      memoryImage.allocate(256, 0);
    } catch (error) {
      if (!(error instanceof HeapPressureSignal)) throw error;
      pressureObserved = true;
      break;
    }
  }
  assert(pressureObserved, "filler must reach heap pressure");

  const garbageCollectionsBefore =
    airlock.membrane.engineCounters().gcPassCount;
  const settleResult = airlock.handlePromiseSettle(executorSlot);
  assertEquals(settleResult.contexts, []);
  const garbageCollectionsAfter = airlock.membrane.engineCounters().gcPassCount;
  assert(
    garbageCollectionsAfter > garbageCollectionsBefore,
    "settlement must recover by collecting and retrying",
  );

  const requestBase = memoryImage.getExternalRequestBase(executorSlot);
  const promiseDataPointer = memoryImage.view.getUint32(
    memoryImage.abs(requestBase),
    true,
  );
  const settledValue = memoryImage.readValueAt(
    promiseDataPointer + PROMISE.VALUE,
    airlock.marshallingOptions(executorSlot),
  );
  assertEquals(settledValue.length, 100);
  assertEquals(settledValue[99], 99);
});

Deno.test("rejected grant identifier marshal under heap pressure self-heals via gc", () => {
  const session = freshSession({ heapSize: 128 * 1024 });
  const memoryImage = session.memoryImage;
  const airlock = session.airlock;
  airlock.onGrantRequest = () => ({ approved: false });
  const parsed = session.parse(`
    let deniedLength = null
    grant "filesystem" {
      deniedLength = -1
    } denied (identifiers) {
      deniedLength = identifiers.length
    }
  `);
  session.setInstruction(0, parsed.startIndex);

  const grantExit = airlock.runContext(0, 100000);
  assertEquals(grantExit.status, "grant_request");

  let pressureObserved = false;
  for (let allocation = 0; allocation < 10000; allocation++) {
    try {
      memoryImage.allocate(256, 0);
    } catch (error) {
      if (!(error instanceof HeapPressureSignal)) throw error;
      pressureObserved = true;
      break;
    }
  }
  assert(pressureObserved, "filler must reach heap pressure");
  pressureObserved = false;
  for (let allocation = 0; allocation < 100; allocation++) {
    try {
      memoryImage.allocate(16, 0);
    } catch (error) {
      if (!(error instanceof HeapPressureSignal)) throw error;
      pressureObserved = true;
      break;
    }
  }
  assert(pressureObserved, "small filler must consume the final heap headroom");

  const garbageCollectionsBefore =
    airlock.membrane.engineCounters().gcPassCount;
  airlock.handleGrantRequest(0);
  const garbageCollectionsAfter = airlock.membrane.engineCounters().gcPassCount;
  assert(
    garbageCollectionsAfter > garbageCollectionsBefore,
    "grant rejection must recover by collecting and retrying",
  );

  session.run(0, 100000);
  assertEquals(session.get(0, "deniedLength"), 1);
});

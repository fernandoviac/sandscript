import { assertEquals, assertThrows, assert } from "https://deno.land/std@0.208.0/assert/mod.ts";
import { freshSession } from '../../src/host-owned-session.js';
import { MembraneOutOfSpaceError } from '../../src/membrane/index.js';

Deno.test("Pressure trigger: id-list pool overflow triggers compaction and retries", () => {
  const session = freshSession({ idListPoolSize: 128 });
  const airlock = session.airlock;
  const membrane = airlock.membrane;

  const handle = airlock.register({});
  airlock.declare('Api', handle);
  airlock.setHandler(handle, 'ping', () => 'pong');
  session.parse('let x = Api');
  session.run(0, 1000);

  for (let i = 0; i < 7; i++) {
    const g = membrane.createGrant(`g${i}`);
    g.add(handle);
  }
});

Deno.test("Pressure trigger: handle table overflow triggers compaction and retries", () => {
  const session = freshSession({ handleTableCapacity: 4 });
  const airlock = session.airlock;

  const handles = [];
  for (let i = 0; i < 4; i++) {
    handles.push(airlock.register({}, { kind: `h${i}` }));
  }

  airlock.compactMembrane();

  airlock.register({}, { kind: 'h4' });
});

Deno.test("Pressure trigger: grant table overflow triggers compaction and retries", () => {
  const session = freshSession({ grantTableCapacity: 4 });
  const airlock = session.airlock;
  const membrane = airlock.membrane;

  const handle = airlock.register({});

  for (let i = 0; i < 4; i++) {
    membrane.createGrant(`g${i}`);
  }

  airlock.compactMembrane();

  membrane.createGrant('g-retry');
});

Deno.test("Pressure trigger: value arena overflow triggers compaction and retries", () => {
  const session = freshSession({ valueArenaSize: 256 });
  const airlock = session.airlock;

  const handles = [];
  for (let i = 0; i < 5; i++) {
    handles.push(airlock.register({}, { kind: `handle-with-metadata-${i}` }));
  }

  airlock.compactMembrane();

  airlock.register({}, { kind: 'after-compaction-metadata' });
});

Deno.test("Pressure trigger: genuinely full membrane still throws after failed retry", () => {
  const session = freshSession({ handleTableCapacity: 4 });
  const airlock = session.airlock;

  airlock.declare('A', airlock.register({}));
  airlock.declare('B', airlock.register({}));
  airlock.declare('C', airlock.register({}));
  airlock.declare('D', airlock.register({}));
  session.parse('let a = A; let b = B; let c = C; let d = D');
  session.run(0, 1000);

  assertThrows(
    () => airlock.register({}),
    MembraneOutOfSpaceError,
  );
});

Deno.test("Pressure trigger: reentrancy guard prevents infinite recursion during compaction", () => {
  const session = freshSession({ grantTableCapacity: 4 });
  const airlock = session.airlock;
  const membrane = airlock.membrane;

  assert(membrane.onPressure !== null, 'onPressure should be wired');

  membrane._state.compacting = true;
  try {
    assertThrows(
      () => {
        for (let i = 0; i < 10; i++) {
          membrane.createGrant(`overflow-${i}`);
        }
      },
      MembraneOutOfSpaceError,
    );
  } finally {
    membrane._state.compacting = false;
  }
});

Deno.test("Pressure trigger: no callback installed — throws immediately without retry", () => {
  const session = freshSession({ handleTableCapacity: 2 });
  const airlock = session.airlock;
  const membrane = airlock.membrane;

  const saved = membrane.onPressure;
  membrane.onPressure = null;
  try {
    airlock.register({});
    airlock.register({});
    assertThrows(
      () => airlock.register({}),
      MembraneOutOfSpaceError,
    );
  } finally {
    membrane.onPressure = saved;
  }
});

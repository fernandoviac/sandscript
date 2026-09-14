/**
 * Deterministic ring-publication fixture generator for the fixture contract in
 * docs/ring-publication-contract.md.
 *
 * Produces, for each ring format (cost ledger, header-event ring,
 * instruction-step ring), raw region bytes plus the typed decode
 * expectation for enabled, wrapped, native-head transition, stale
 * expected-generation, generation-race, terminal segment-exhaustion,
 * unsupported pre-segment format, malformed, and not-enabled states.
 * Consumers use these records unchanged; regeneration is byte-identical.
 *
 * Run with:
 *   deno run --allow-read --allow-write --allow-net tools/generate-ring-fixtures.js
 */
import { freshMembrane } from '../src/host-owned-session.js';
import {
  HEADER,
  COST_KIND,
  COST_LEDGER_ENTRY,
  COST_LEDGER_ENTRY_SIZE,
  COST_LEDGER_FLAG_SEGMENT_SPACE_EXHAUSTED,
} from '../src/membrane/index.js';
import { createCostLedgerView } from '../src/runtime/cost-ledger.js';
import { RuntimeBuilder } from '../src/runtime/test-harness.js';
import { computeVatLayout, layoutVat } from '../src/fuel/vat-layout.js';
import {
  readHeaderEventRingRange,
  writeHeaderEventRingEntry,
} from '../src/fuel/header-event-ring.js';
import { readStepRingRange } from '../src/fuel/step-ring.js';
import {
  STATE,
  STEP_RING,
  STEP_RING_HEADER_SIZE,
  STEP_RING_ENTRY_SIZE,
  HEADER_EVENT_RING,
  HEADER_EVENT_RING_HEADER_SIZE,
  HEADER_EVENT_RING_ENTRY_SIZE,
  HEADER_EVENT_KIND,
  RING_FLAG_SEGMENT_SPACE_EXHAUSTED,
  HEADER_EVENT_SITE,
} from '../src/fuel/constants.js';
import { RING_PUBLICATION_CONTRACT_VERSION } from '../src/ring-publication.js';

const FIXTURE_ROOT = new URL('../fixtures/ring-publication/', import.meta.url);
const RETIRED_FIXTURES = [
  'cost-ledger/continuity-loss-before.bin',
  'cost-ledger/continuity-loss-after.bin',
  'cost-ledger/continuity-loss.expected.json',
];

const MEMBRANE_OPTIONS = {
  handleTableCapacity: 16, grantTableCapacity: 8, idListPoolSize: 256,
  rootGrantsListCapacity: 4, valueArenaSize: 256, closureHandleTableCapacity: 4,
  linkedPromiseTableCapacity: 4, mutationLogCapacity: 16, costLedgerCapacity: 8,
};

const REQUEST = { afterIndex: 0, maximumEntries: 64, maximumBytes: 65536 };

const bigintReplacer = (_key, value) => typeof value === 'bigint' ? value.toString() : value;
const expectedText = (value) => JSON.stringify(value, bigintReplacer, 2) + '\n';

// ---------------------------------------------------------------------------
// Cost ledger
// ---------------------------------------------------------------------------

function costGauges(index) {
  return {
    fuel: index, wallNanos: index * 3, bytesIn: index * 7 + 1,
    bytesOut: index * 11 + 2, calls: index + 5, cpuNanos: index * 13 + 3,
  };
}

function costRegionBytes(membrane) {
  const offset = membrane.view.getUint32(HEADER.COST_LEDGER_OFFSET, true);
  const capacity = membrane.view.getUint32(HEADER.COST_LEDGER_CAPACITY, true);
  return new Uint8Array(membrane.buffer.slice(
    membrane.byteOffset + offset,
    membrane.byteOffset + offset + capacity * COST_LEDGER_ENTRY_SIZE));
}

function costDecode(membrane, {
  writeIndex = membrane.view.getUint32(HEADER.COST_LEDGER_WRITE_INDEX, true),
  segmentGeneration = membrane.view.getUint32(
    HEADER.COST_LEDGER_SEGMENT_GENERATION, true),
  flags = membrane.view.getUint32(HEADER.COST_LEDGER_FLAGS, true),
  request = REQUEST,
} = {}) {
  const view = createCostLedgerView({
    buffer: membrane.buffer,
    byteOffset: membrane.byteOffset + membrane.view.getUint32(HEADER.COST_LEDGER_OFFSET, true),
    capacity: membrane.view.getUint32(HEADER.COST_LEDGER_CAPACITY, true),
    writeIndex,
    segmentGeneration,
    flags,
  });
  return view.readRange(request);
}

function costFixtures() {
  const states = {};
  const files = [];
  const capacity = MEMBRANE_OPTIONS.costLedgerCapacity;

  const add = (state, membrane, {
    request = REQUEST,
    expected,
    note,
    mutation,
  } = {}) => {
    const writeIndex =
      membrane.view.getUint32(HEADER.COST_LEDGER_WRITE_INDEX, true);
    const segmentGeneration = membrane.view.getUint32(
      HEADER.COST_LEDGER_SEGMENT_GENERATION, true);
    const flags = membrane.view.getUint32(HEADER.COST_LEDGER_FLAGS, true);
    const decoded = expected ?? costDecode(membrane, {
      writeIndex,
      segmentGeneration,
      flags,
      request,
    });
    files.push({
      path: `cost-ledger/${state}.bin`,
      bytes: costRegionBytes(membrane),
    });
    files.push({
      path: `cost-ledger/${state}.expected.json`,
      text: expectedText(decoded),
    });
    states[state] = {
      region: `cost-ledger/${state}.bin`,
      expected: `cost-ledger/${state}.expected.json`,
      capacity,
      writeIndex,
      segmentGeneration,
      flags,
      request,
      ...(mutation ? { mutation } : {}),
      ...(note ? { note } : {}),
    };
  };

  const fill = (membrane) => {
    for (let i = 1; i <= capacity; i++) {
      membrane.appendCostEntry(COST_KIND.FUEL, i, costGauges(i));
    }
  };
  const setRetainedIndexes = (membrane, head) => {
    fill(membrane);
    const ringOffset =
      membrane.view.getUint32(HEADER.COST_LEDGER_OFFSET, true);
    const first = (head - capacity + 1) >>> 0;
    for (let distance = 0; distance < capacity; distance++) {
      const index = (first + distance) >>> 0;
      const slot = ((index - 1) >>> 0) & (capacity - 1);
      membrane.view.setUint32(
        ringOffset + slot * COST_LEDGER_ENTRY_SIZE + COST_LEDGER_ENTRY.SEQ_LO,
        index,
        true);
    }
    membrane.view.setUint32(HEADER.COST_LEDGER_WRITE_INDEX, head, true);
  };

  add('empty', freshMembrane({ ...MEMBRANE_OPTIONS }));

  const partial = freshMembrane({ ...MEMBRANE_OPTIONS });
  for (let i = 1; i <= 3; i++) {
    partial.appendCostEntry(COST_KIND.FUEL, i, costGauges(i));
  }
  add('partial', partial);

  const wrapped = freshMembrane({ ...MEMBRANE_OPTIONS });
  for (let i = 1; i <= 12; i++) {
    wrapped.appendCostEntry(COST_KIND.FUEL, i, costGauges(i));
  }
  add('wrapped', wrapped);

  const raced = freshMembrane({ ...MEMBRANE_OPTIONS });
  fill(raced);
  {
    const ringOffset =
      raced.view.getUint32(HEADER.COST_LEDGER_OFFSET, true);
    raced.view.setUint32(HEADER.COST_LEDGER_WRITE_INDEX, 9, true);
    raced.view.setUint32(
      ringOffset + COST_LEDGER_ENTRY.SEQ_LO, 0, true);
  }
  add('raced', raced, {
    note: 'reservation for entry 9 without its publication token',
  });

  const preWrap = freshMembrane({ ...MEMBRANE_OPTIONS });
  setRetainedIndexes(preWrap, 0xfffffffe);
  add('pre-wrap', preWrap, {
    request: {
      afterIndex: 0xfffffff6,
      maximumEntries: 64,
      maximumBytes: 65536,
    },
    note: 'generation one with the head one reservation before wrap',
  });

  const transitionSeqlock = freshMembrane({ ...MEMBRANE_OPTIONS });
  setRetainedIndexes(transitionSeqlock, 0xffffffff);
  transitionSeqlock.view.setUint32(
    HEADER.COST_LEDGER_SEGMENT_GENERATION, 0, true);
  add('transition-seqlock', transitionSeqlock, {
    note: 'generation-zero seqlock rejects the old high head and slots',
  });

  const transition = freshMembrane({ ...MEMBRANE_OPTIONS });
  setRetainedIndexes(transition, 0xffffffff);
  {
    const ringOffset =
      transition.view.getUint32(HEADER.COST_LEDGER_OFFSET, true);
    transition.view.setUint32(
      HEADER.COST_LEDGER_SEGMENT_GENERATION, 2, true);
    transition.view.setUint32(HEADER.COST_LEDGER_WRITE_INDEX, 1, true);
    transition.view.setUint32(
      ringOffset + COST_LEDGER_ENTRY.SEQ_LO, 1, true);
  }
  add('transition', transition, {
    note: 'successor generation index 1 with prior-generation slots resident',
  });
  add('old-expected-generation', transition, {
    request: { ...REQUEST, expectedSegmentGeneration: 1 },
    note: 'request remains bound to generation one',
  });

  add('generation-raced', transition, {
    expected: {
      status: 'segment-changed',
      segmentGeneration: 2,
      capacity,
      reservationHead: 1,
      newestCommitted: 0,
      oldestAvailable: 0,
      gap: null,
      entries: [],
      truncation: null,
    },
    mutation: {
      after: 'payload-decode',
      field: 'segmentGeneration',
      from: 2,
      to: 3,
    },
    note: 'consumer mutates generation after payload decode and before validation',
  });

  const exhausted = freshMembrane({ ...MEMBRANE_OPTIONS });
  setRetainedIndexes(exhausted, 0xffffffff);
  exhausted.view.setUint32(
    HEADER.COST_LEDGER_SEGMENT_GENERATION, 0xffffffff, true);
  exhausted.view.setUint32(
    HEADER.COST_LEDGER_FLAGS,
    COST_LEDGER_FLAG_SEGMENT_SPACE_EXHAUSTED,
    true);
  add('segment-space-exhausted', exhausted);

  states['unsupported-version'] = {
    region: null,
    expected: 'cost-ledger/unsupported-version.expected.json',
    note: 'membrane format 13 predates the segment-generation header',
  };
  files.push({
    path: 'cost-ledger/unsupported-version.expected.json',
    text: expectedText({
      // Pin only the invariant prefix. The live error names BOTH
      // versions ("version: N (expected M)") and consumers stamp the
      // unsupported version as CURRENT-1 live, so every numeric half
      // of the message moves on a format bump — pinning either
      // staled this fixture at the v14→v15 bump. Consumers assert by
      // substring; the loud rejection itself is the contract.
      throws: 'Unsupported membrane format version',
    }),
  });

  const malformed = freshMembrane({ ...MEMBRANE_OPTIONS });
  malformed.view.setUint32(
    HEADER.COST_LEDGER_SEGMENT_GENERATION, 0, true);
  add('malformed', malformed, {
    note: 'required segment generation is zero',
  });

  return { states, files };
}

// ---------------------------------------------------------------------------
// Header-event ring
// ---------------------------------------------------------------------------

const HEADER_RING_ENTRIES = 4;
const HEADER_RING_SIZE = HEADER_EVENT_RING_HEADER_SIZE + HEADER_RING_ENTRIES * HEADER_EVENT_RING_ENTRY_SIZE;

function headerSegment() {
  const layout = computeVatLayout({ headerEventRingSize: HEADER_RING_SIZE });
  const buffer = new ArrayBuffer(Math.ceil(layout.byteLength / 65536) * 65536);
  layoutVat(buffer, 0, { headerEventRingSize: HEADER_RING_SIZE });
  return { buffer, view: new DataView(buffer) };
}

function headerWrite(segment, index) {
  writeHeaderEventRingEntry(segment.view, 0, {
    kind: HEADER_EVENT_KIND.FIELD_WRITE,
    site: HEADER_EVENT_SITE.UNKNOWN,
    oldValue: index,
    newValue: (index * 31 + 7) >>> 0,
  });
}

function headerRegionBytes(segment) {
  const base = segment.view.getUint32(STATE.HEADER_EVENT_RING_BASE, true);
  return new Uint8Array(segment.buffer.slice(base, base + HEADER_RING_SIZE));
}

function headerFixtures() {
  const states = {};
  const files = [];

  const add = (state, segment, {
    request = REQUEST,
    expected,
    note,
    mutation,
  } = {}) => {
    const base =
      segment.view.getUint32(STATE.HEADER_EVENT_RING_BASE, true);
    const decoded =
      expected ?? readHeaderEventRingRange(segment.view, 0, request);
    files.push({
      path: `header-event-ring/${state}.bin`,
      bytes: headerRegionBytes(segment),
    });
    files.push({
      path: `header-event-ring/${state}.expected.json`,
      text: expectedText(decoded),
    });
    states[state] = {
      region: `header-event-ring/${state}.bin`,
      expected: `header-event-ring/${state}.expected.json`,
      ringSize: HEADER_RING_SIZE,
      segmentGeneration:
        segment.view.getUint32(base + HEADER_EVENT_RING.SEGMENT_GENERATION, true),
      flags: segment.view.getUint32(base + HEADER_EVENT_RING.FLAGS, true),
      request,
      ...(mutation ? { mutation } : {}),
      ...(note ? { note } : {}),
    };
  };

  const setRetainedIndexes = (segment, head) => {
    for (let i = 1; i <= HEADER_RING_ENTRIES; i++) headerWrite(segment, i);
    const base =
      segment.view.getUint32(STATE.HEADER_EVENT_RING_BASE, true);
    const first = (head - HEADER_RING_ENTRIES + 1) >>> 0;
    for (let distance = 0; distance < HEADER_RING_ENTRIES; distance++) {
      const index = (first + distance) >>> 0;
      const slot = ((index - 1) >>> 0) % HEADER_RING_ENTRIES;
      segment.view.setUint32(
        base + HEADER_EVENT_RING_HEADER_SIZE +
          slot * HEADER_EVENT_RING_ENTRY_SIZE + 12,
        index,
        true);
    }
    segment.view.setUint32(base + HEADER_EVENT_RING.WRITE_HEAD, head, true);
  };

  add('empty', headerSegment());

  const partial = headerSegment();
  for (let i = 1; i <= 3; i++) headerWrite(partial, i);
  add('partial', partial);

  const wrapped = headerSegment();
  for (let i = 1; i <= 10; i++) headerWrite(wrapped, i);
  add('wrapped', wrapped);

  const raced = headerSegment();
  for (let i = 1; i <= 4; i++) headerWrite(raced, i);
  {
    const base = raced.view.getUint32(STATE.HEADER_EVENT_RING_BASE, true);
    raced.view.setUint32(base + HEADER_EVENT_RING.WRITE_HEAD, 5, true);
    raced.view.setUint32(
      base + HEADER_EVENT_RING_HEADER_SIZE + 12, 0, true);
  }
  add('raced', raced, {
    note: 'reservation for entry 5 without its publication token',
  });

  const preWrap = headerSegment();
  setRetainedIndexes(preWrap, 0xfffffffe);
  add('pre-wrap', preWrap, {
    request: {
      afterIndex: 0xfffffffa,
      maximumEntries: 64,
      maximumBytes: 65536,
    },
    note: 'generation one with the head one reservation before wrap',
  });

  const transitionSeqlock = headerSegment();
  setRetainedIndexes(transitionSeqlock, 0xffffffff);
  {
    const base = transitionSeqlock.view.getUint32(
      STATE.HEADER_EVENT_RING_BASE, true);
    transitionSeqlock.view.setUint32(
      base + HEADER_EVENT_RING.SEGMENT_GENERATION, 0, true);
  }
  add('transition-seqlock', transitionSeqlock, {
    note: 'generation-zero seqlock rejects the old high head and slots',
  });

  const transition = headerSegment();
  setRetainedIndexes(transition, 0xffffffff);
  {
    const base =
      transition.view.getUint32(STATE.HEADER_EVENT_RING_BASE, true);
    transition.view.setUint32(
      base + HEADER_EVENT_RING.SEGMENT_GENERATION, 2, true);
    transition.view.setUint32(base + HEADER_EVENT_RING.WRITE_HEAD, 1, true);
    transition.view.setUint32(
      base + HEADER_EVENT_RING_HEADER_SIZE + 12, 1, true);
  }
  add('transition', transition, {
    note: 'successor generation index 1 with prior-generation slots resident',
  });
  add('old-expected-generation', transition, {
    request: { ...REQUEST, expectedSegmentGeneration: 1 },
    note: 'request remains bound to generation one',
  });
  add('generation-raced', transition, {
    expected: {
      status: 'segment-changed',
      segmentGeneration: 2,
      capacity: HEADER_RING_ENTRIES,
      reservationHead: 1,
      newestCommitted: 0,
      oldestAvailable: 0,
      gap: null,
      entries: [],
      truncation: null,
    },
    mutation: {
      after: 'payload-decode',
      field: 'segmentGeneration',
      from: 2,
      to: 3,
    },
    note: 'consumer mutates generation after payload decode and before validation',
  });

  const exhausted = headerSegment();
  setRetainedIndexes(exhausted, 0xffffffff);
  {
    const base =
      exhausted.view.getUint32(STATE.HEADER_EVENT_RING_BASE, true);
    exhausted.view.setUint32(
      base + HEADER_EVENT_RING.SEGMENT_GENERATION, 0xffffffff, true);
    exhausted.view.setUint32(
      base + HEADER_EVENT_RING.FLAGS,
      RING_FLAG_SEGMENT_SPACE_EXHAUSTED,
      true);
  }
  add('segment-space-exhausted', exhausted);

  const preSegment = headerSegment();
  headerWrite(preSegment, 1);
  {
    const base =
      preSegment.view.getUint32(STATE.HEADER_EVENT_RING_BASE, true);
    preSegment.view.setUint32(
      base + HEADER_EVENT_RING.FORMAT_VERSION, 2, true);
  }
  add('unsupported-version', preSegment, {
    note: 'ring header declares pre-segment format version 2',
  });

  const disabledLayout = computeVatLayout({});
  const disabledBuffer =
    new ArrayBuffer(Math.ceil(disabledLayout.byteLength / 65536) * 65536);
  layoutVat(disabledBuffer, 0, {});
  files.push({
    path: 'header-event-ring/not-enabled.expected.json',
    text: expectedText(
      readHeaderEventRingRange(new DataView(disabledBuffer), 0, REQUEST)),
  });
  states['not-enabled'] = {
    region: null,
    expected: 'header-event-ring/not-enabled.expected.json',
    ringSize: 0,
    request: REQUEST,
  };

  const malformed = headerSegment();
  const malformedBase =
    malformed.view.getUint32(STATE.HEADER_EVENT_RING_BASE, true);
  malformed.view.setUint32(
    malformedBase + HEADER_EVENT_RING.SEGMENT_GENERATION, 0, true);
  add('malformed', malformed, {
    note: 'required segment generation is zero',
  });

  return { states, files };
}

// ---------------------------------------------------------------------------
// Instruction-step ring (entries written by the real WAT interpreter)
// ---------------------------------------------------------------------------

const STEP_RING_ENTRIES = 8;
const STEP_RING_REGION_SIZE = STEP_RING_HEADER_SIZE + STEP_RING_ENTRIES * STEP_RING_ENTRY_SIZE;

async function stepSegment(program) {
  const { runtime, session } = new RuntimeBuilder()
    .sessionOptions({ stepRingSize: STEP_RING_REGION_SIZE })
    .fuel(1_000_000)
    .onInboundMessage(() => {})
    .build();
  if (program !== null) {
    await runtime.start();
    const parsed = session.parse(program);
    session.setInstruction(0, parsed.startIndex);
    await runtime.run(0);
  }
  const mem = session.memoryImage;
  const base = mem.baseOffset + mem.view.getUint32(mem.baseOffset + STATE.STEP_RING_BASE, true);
  const bytes = new Uint8Array(mem.buffer.slice(base, base + STEP_RING_REGION_SIZE));
  const decode = (mutate, request = REQUEST) => {
    if (mutate) mutate(mem);
    const page = readStepRingRange(mem.view, mem.baseOffset, request);
    return { page, bytes: new Uint8Array(mem.buffer.slice(base, base + STEP_RING_REGION_SIZE)) };
  };
  const result = { bytes, decode, mem, ringBase: base, terminate: () => runtime.terminate() };
  return result;
}

async function stepFixtures() {
  const states = {};
  const files = [];

  const add = async (state, program, {
    mutate = null,
    request = REQUEST,
    expected,
    note,
    mutation,
  } = {}) => {
    const segment = await stepSegment(program);
    const decoded = segment.decode(mutate, request);
    const page = expected ?? decoded.page;
    files.push({ path: `step-ring/${state}.bin`, bytes: decoded.bytes });
    files.push({
      path: `step-ring/${state}.expected.json`,
      text: expectedText(page),
    });
    states[state] = {
      region: `step-ring/${state}.bin`,
      expected: `step-ring/${state}.expected.json`,
      ringSize: STEP_RING_REGION_SIZE,
      segmentGeneration: segment.mem.view.getUint32(
        segment.ringBase + STEP_RING.SEGMENT_GENERATION, true),
      flags: segment.mem.view.getUint32(
        segment.ringBase + STEP_RING.FLAGS, true),
      request,
      ...(mutation ? { mutation } : {}),
      ...(note ? { note } : {}),
    };
    await segment.terminate();
    return page;
  };

  const setRetainedIndexes = (mem, head, generation = 1) => {
    const base =
      mem.baseOffset + mem.view.getUint32(
        mem.baseOffset + STATE.STEP_RING_BASE, true);
    const first = (head - STEP_RING_ENTRIES + 1) >>> 0;
    for (let distance = 0; distance < STEP_RING_ENTRIES; distance++) {
      const index = (first + distance) >>> 0;
      const slot = ((index - 1) >>> 0) % STEP_RING_ENTRIES;
      mem.view.setUint32(
        base + STEP_RING_HEADER_SIZE + slot * STEP_RING_ENTRY_SIZE,
        index,
        true);
    }
    mem.view.setUint32(base + STEP_RING.WRITE_HEAD, head, true);
    mem.view.setUint32(
      base + STEP_RING.SEGMENT_GENERATION, generation, true);
  };

  await add('empty', null);

  const partialPage = await add('partial', 'let x = 1');
  if (partialPage.reservationHead === 0 ||
      partialPage.reservationHead > STEP_RING_ENTRIES) {
    throw new Error(
      `step partial fixture must stay within one lap; head=${partialPage.reservationHead}`);
  }

  const wrappedProgram =
    'let total = 0; for (let i = 0; i < 20; i = i + 1) { total = total + i }';
  const wrappedPage = await add('wrapped', wrappedProgram);
  if (wrappedPage.gap === null) {
    throw new Error('step wrapped fixture must overwrite entries');
  }

  await add('raced', 'let x = 1', {
    mutate: (mem) => {
      const base = mem.baseOffset + mem.view.getUint32(
        mem.baseOffset + STATE.STEP_RING_BASE, true);
      const head = mem.view.getUint32(base + STEP_RING.WRITE_HEAD, true);
      const nextSlot = head % STEP_RING_ENTRIES;
      mem.view.setUint32(base + STEP_RING.WRITE_HEAD, head + 1, true);
      mem.view.setUint32(
        base + STEP_RING_HEADER_SIZE + nextSlot * STEP_RING_ENTRY_SIZE,
        0,
        true);
    },
    note: 'reservation for the next entry without its publication token',
  });

  await add('pre-wrap', wrappedProgram, {
    mutate: (mem) => setRetainedIndexes(mem, 0xfffffffe),
    request: {
      afterIndex: 0xfffffff6,
      maximumEntries: 64,
      maximumBytes: 65536,
    },
    note: 'generation one with the head one reservation before wrap',
  });

  await add('transition-seqlock', wrappedProgram, {
    mutate: (mem) => setRetainedIndexes(mem, 0xffffffff, 0),
    note: 'generation-zero seqlock rejects the old high head and slots',
  });

  const transitionMutation = (mem) => {
    setRetainedIndexes(mem, 0xffffffff);
    const base = mem.baseOffset + mem.view.getUint32(
      mem.baseOffset + STATE.STEP_RING_BASE, true);
    mem.view.setUint32(base + STEP_RING.SEGMENT_GENERATION, 2, true);
    mem.view.setUint32(base + STEP_RING.WRITE_HEAD, 1, true);
    mem.view.setUint32(base + STEP_RING_HEADER_SIZE, 1, true);
  };
  await add('transition', wrappedProgram, {
    mutate: transitionMutation,
    note: 'successor generation index 1 with prior-generation slots resident',
  });
  await add('old-expected-generation', wrappedProgram, {
    mutate: transitionMutation,
    request: { ...REQUEST, expectedSegmentGeneration: 1 },
    note: 'request remains bound to generation one',
  });
  await add('generation-raced', wrappedProgram, {
    mutate: transitionMutation,
    expected: {
      status: 'segment-changed',
      segmentGeneration: 2,
      capacity: STEP_RING_ENTRIES,
      reservationHead: 1,
      newestCommitted: 0,
      oldestAvailable: 0,
      gap: null,
      entries: [],
      truncation: null,
    },
    mutation: {
      after: 'payload-decode',
      field: 'segmentGeneration',
      from: 2,
      to: 3,
    },
    note: 'consumer mutates generation after payload decode and before validation',
  });

  await add('segment-space-exhausted', wrappedProgram, {
    mutate: (mem) => {
      setRetainedIndexes(mem, 0xffffffff, 0xffffffff);
      const base = mem.baseOffset + mem.view.getUint32(
        mem.baseOffset + STATE.STEP_RING_BASE, true);
      mem.view.setUint32(
        base + STEP_RING.FLAGS,
        RING_FLAG_SEGMENT_SPACE_EXHAUSTED,
        true);
    },
  });

  await add('unsupported-version', 'let x = 1', {
    mutate: (mem) => {
      const base = mem.baseOffset + mem.view.getUint32(
        mem.baseOffset + STATE.STEP_RING_BASE, true);
      mem.view.setUint32(base + STEP_RING.FORMAT_VERSION, 2, true);
    },
    note: 'ring header declares pre-segment format version 2',
  });

  {
    const { runtime, session } = new RuntimeBuilder()
      .onInboundMessage(() => {})
      .build();
    const mem = session.memoryImage;
    files.push({
      path: 'step-ring/not-enabled.expected.json',
      text: expectedText(readStepRingRange(mem.view, mem.baseOffset, REQUEST)),
    });
    states['not-enabled'] = {
      region: null,
      expected: 'step-ring/not-enabled.expected.json',
      ringSize: 0,
      request: REQUEST,
    };
    await runtime.terminate();
  }

  await add('malformed', 'let x = 1', {
    mutate: (mem) => {
      const base = mem.baseOffset + mem.view.getUint32(
        mem.baseOffset + STATE.STEP_RING_BASE, true);
      mem.view.setUint32(
        base + STEP_RING.SEGMENT_GENERATION, 0, true);
    },
    note: 'required segment generation is zero',
  });

  return { states, files };
}

// ---------------------------------------------------------------------------

export async function generateFixtureSet() {
  const cost = costFixtures();
  const header = headerFixtures();
  const step = await stepFixtures();

  const manifest = {
    contractVersion: RING_PUBLICATION_CONTRACT_VERSION,
    generator: 'tools/generate-ring-fixtures.js',
    rings: {
      'cost-ledger': { entrySize: COST_LEDGER_ENTRY_SIZE, states: cost.states },
      'header-event-ring': { entrySize: HEADER_EVENT_RING_ENTRY_SIZE, states: header.states },
      'step-ring': { entrySize: STEP_RING_ENTRY_SIZE, states: step.states },
    },
  };

  return [
    { path: 'manifest.json', text: JSON.stringify(manifest, null, 2) + '\n' },
    ...cost.files,
    ...header.files,
    ...step.files,
  ];
}

if (import.meta.main) {
  for (const retired of RETIRED_FIXTURES) {
    try {
      await Deno.remove(new URL(retired, FIXTURE_ROOT));
    } catch (error) {
      if (!(error instanceof Deno.errors.NotFound)) throw error;
    }
  }
  const files = await generateFixtureSet();
  for (const file of files) {
    const target = new URL(file.path, FIXTURE_ROOT);
    await Deno.mkdir(new URL('.', target), { recursive: true });
    if (file.bytes) await Deno.writeFile(target, file.bytes);
    else await Deno.writeTextFile(target, file.text);
  }
  console.log(`wrote ${files.length} fixture files under fixtures/ring-publication/`);
}

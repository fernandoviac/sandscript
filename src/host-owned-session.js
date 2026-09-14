/**
 * Test helpers for the host-owned-memory contract.
 *
 * `createSession` is strictly attach-only: the caller allocates memory,
 * lays it out (via layoutVat / layoutMembrane) or copies snapshot bytes
 * in, and then passes both buffers to createSession. The runtime, debug
 * tooling, and tests therefore need a few lines of boilerplate every
 * time they want a session. These helpers wrap that boilerplate so test
 * code can stay focused on what it is actually testing.
 *
 * Exports:
 *   freshSession(opts?)
 *     Allocate, lay out, and construct a brand-new session. Opts
 *     mirror the union of computeVatLayout + computeMembraneLayout
 *     option names (no namespacing — the names don't collide).
 *
 *   restoreSession(vatBytes, membraneBytes, opts?)
 *     Allocate memory + buffer sized to the input bytes, copy them
 *     in, and construct a session that resumes from the snapshot.
 *
 *   snapshotSession(session)
 *     Slice the session's vat memory and membrane buffer into
 *     detached `Uint8Array`s. The host would normally do this
 *     itself after quiescing the runtime — these helpers expose the
 *     same one-call convenience for tests.
 *
 * None of this is part of the public API. It is test infrastructure;
 * production hosts own their session lifecycle.
 */

import {
  computeVatLayout,
  layoutVat,
  readVatLayout,
} from './fuel/vat-layout.js';
import {
  computeMembraneLayout,
  layoutMembrane,
  readMembraneLayout,
} from './membrane/membrane-layout.js';
import { Membrane, MembraneOutOfSpaceError, HANDLE_ENTRY_SIZE, GRANT_ENTRY_SIZE, CLOSURE_HANDLE_ENTRY_SIZE, OBJECT_HANDLE_ENTRY_SIZE, LINKED_PROMISE_ENTRY_SIZE, MUTATION_LOG_ENTRY_SIZE, CAPABILITY_STATE_ENTRY_SIZE, COST_LEDGER_ENTRY_SIZE, RUNTIME_STATE_CELL_BYTES, LEDGER_ENTRY_BYTES, MEMBRANE_HEADER_SIZE } from './membrane/index.js';
import { createSession } from './fuel/session.js';
import { computeGcScratchLayout } from './fuel/gc-scratch-layout.js';

const PAGE = 65536;

/**
 * Worst-case GC scratch block size (bytes) for a vat/membrane layout
 * pairing, computed the same way `session.js`'s `gcScratchLayout`
 * does at collection time — but upfront, from layout constants alone,
 * so the caller can budget `WebAssembly.Memory`'s `maximum` to
 * actually hold it.
 *
 * `stringTableSize`/`astRegionSize` are fixed per vat. `rootCapacity`
 * is runtime-variable (live closure handles + linked promises) but
 * bounded by their table capacities — also fixed per membrane — so
 * the true worst case is knowable without running anything.
 *
 * @param {object} vatLayout - from computeVatLayout
 * @param {object} membraneLayout - from computeMembraneLayout
 * @returns {number} bytes
 */
function worstCaseGcScratchBytes(vatLayout, membraneLayout) {
  const rootCapacity = Math.max(
    membraneLayout.capacities.closureHandleTableCapacity
      + membraneLayout.capacities.linkedPromiseTableCapacity,
    16);
  return computeGcScratchLayout({
    stringTableSize: vatLayout.regionSizes.stringTable,
    astRegionSize: vatLayout.regionSizes.astRegion,
    handleTableCapacity: membraneLayout.capacities.handleTableCapacity,
    rootCapacity,
  }).byteLength;
}

/**
 * `WebAssembly.Memory({ initial, maximum })` sized so
 * `reserveGcScratch`'s grow path always has room. `maximum` must exceed
 * `initial` by at least the worst-case scratch block; otherwise the
 * first collection that needs to grow scratch fails before a
 * pressure-retry can be attempted.
 *
 * @param {object} vatLayout - from computeVatLayout
 * @param {object} membraneLayout - from computeMembraneLayout
 * @param {number} offset - byte offset the vat starts at in the buffer
 * @returns {WebAssembly.Memory}
 */
function allocateSessionMemory(vatLayout, membraneLayout, offset) {
  const initialPages = pagesFor(offset + vatLayout.byteLength);
  const scratchPages = pagesFor(worstCaseGcScratchBytes(vatLayout, membraneLayout));
  return new WebAssembly.Memory({
    initial: initialPages,
    maximum: initialPages + scratchPages,
    shared: true,
  });
}

// Per-session bookkeeping. Session objects are Object.frozen, so we
// stash the memory + buffer + layouts in a side-table keyed by the
// session value rather than monkey-patching the session itself.
const _sessionBuffers = new WeakMap();

/**
 * Look up the memory + membrane buffer + layouts for a session
 * constructed via freshSession / restoreSession. Returns null for
 * sessions constructed outside this helper.
 */
export function sessionBuffers(session) {
  return _sessionBuffers.get(session) ?? null;
}

function pagesFor(byteLength, base = 0) {
  return Math.ceil((base + byteLength) / PAGE);
}

/**
 * Split a single options bag into vat-layout opts and
 * membrane-layout opts by recognized key. Keys not recognized by
 * either are silently ignored — callers can pass session-level
 * options alongside layout options without filtering.
 */
function splitLayoutOpts(opts) {
  const vatKeys = new Set([
    'segmentSize', 'stringTableSize',
    'errorInfoSize', 'scratchSize', 'builtinsSize',
    'contextTableSize', 'astRegionSize', 'stepRingSize', 'headerEventRingSize', 'heapSize',
    'inlineSource',
  ]);
  const membraneKeys = new Set([
    'handleTableCapacity', 'grantTableCapacity', 'idListPoolSize',
    'rootGrantsListCapacity', 'valueArenaSize',
    'closureHandleTableCapacity', 'linkedPromiseTableCapacity',
    'objectHandleTableCapacity',
    'mutationLogCapacity', 'capabilityStateTableCapacity',
    'costLedgerCapacity', 'ledgerCapacity',
  ]);
  const vatOpts = {};
  const membraneOpts = {};
  for (const [k, v] of Object.entries(opts)) {
    if (vatKeys.has(k)) vatOpts[k] = v;
    if (membraneKeys.has(k)) membraneOpts[k] = v;
  }
  // `inlineSource: true` is a tests-friendly shorthand for a
  // non-trivial AST region.
  if (vatOpts.inlineSource && vatOpts.astRegionSize === undefined) {
    vatOpts.astRegionSize = 256 * 1024;
  }
  delete vatOpts.inlineSource;
  return { vatOpts, membraneOpts };
}

/**
 * Construct a fresh session.
 *
 * @param {object} [opts] Layout options (union of vat + membrane).
 * @returns {object} session — plus `memory`, `membraneBuffer`,
 *   `vatLayout`, `membraneLayout` attached for tests that need to
 *   reach back to the underlying buffers.
 */
export function freshSession(opts = {}) {
  if ('module' in opts) {
    throw new TypeError(
      'freshSession: opaque `module` is not supported; pass raw ' +
      '`interpreterModuleBytes`');
  }
  const { vatOpts, membraneOpts } = splitLayoutOpts(opts);

  const vatLayout = computeVatLayout(vatOpts);
  const membraneLayout = computeMembraneLayout(membraneOpts);
  // Allow the caller to pre-allocate the WebAssembly.Memory (tests
  // that exercise resize-into-headroom need a buffer larger than the
  // initial vat). When provided, layoutVat writes into it at the
  // caller's offset.
  const offset = opts.offset ?? 0;
  const memory = opts.memory ?? allocateSessionMemory(vatLayout, membraneLayout, offset);
  layoutVat(memory, offset, vatOpts);

  // SharedArrayBuffer so Atomics.wait / Atomics.notify on the
  // runtime-state cell and ledger work across realms. Tests that
  // explicitly want a non-shared buffer pass `sharedMembrane: false`.
  // When the caller pre-allocates a membrane buffer (typically the
  // same SAB that holds the vat memory, packed into adjacent
  // sub-regions), we lay out into it at the requested byteOffset.
  const useSharedMembrane = opts.sharedMembrane !== false;
  const membraneByteOffset = opts.membraneByteOffset ?? 0;
  const membraneBuffer = opts.membraneBuffer ?? (useSharedMembrane
    ? new SharedArrayBuffer(membraneLayout.byteLength)
    : new ArrayBuffer(membraneLayout.byteLength));
  // When the host pinned the buffer, honour their byteLength
  // (typically the slot the slab reserved); otherwise the membrane
  // is exactly layout-sized.
  const membraneByteLength = opts.membraneByteLength
    ?? (opts.membraneBuffer
        ? opts.membraneBuffer.byteLength - membraneByteOffset
        : membraneLayout.byteLength);
  layoutMembrane(membraneBuffer, membraneByteOffset, membraneOpts);

  const session = createSession({
    memory,
    offset,
    segmentSize: vatLayout.byteLength,
    membraneBuffer,
    membraneByteOffset,
    membraneByteLength,
    interpreterModuleBytes: opts.interpreterModuleBytes,
    ...(opts.gcCollector ? { gcCollector: opts.gcCollector } : {}),
  });

  _sessionBuffers.set(session, { memory, membraneBuffer, vatLayout, membraneLayout, offset });
  return session;
}

/**
 * Construct a THROWAWAY session and parse `source` into it, growing the
 * AST region until the parse fits. The AST's byte size is only knowable
 * by parsing, and a vat's AST region is fixed at layout time, so any
 * fixed default can reject a sufficiently large source. For a session
 * that exists only to be parsed and walked (structural checks, dry-run
 * tooling), relay a fresh, larger session and reparse until the source
 * fits.
 *
 * Doubles from opts.astRegionSize (or the 256KB inlineSource default)
 * on every "AST region exhausted" ParseError; anything else (real
 * syntax errors, allocation failure) rethrows untouched. Terminates:
 * a finite source has a finite AST, and each retry doubles the region.
 *
 * NOT for persistent vats — each vat's AST region size is an explicit
 * vatOptions decision and part of its memory footprint. This helper is
 * for harness sessions that are discarded after parsing.
 *
 * @param {string} source
 * @param {object} [opts] Same options bag as freshSession.
 * @returns {object} session with `source` already parsed.
 */
export function freshSessionParsedFor(source, opts = {}) {
  let astRegionSize = opts.astRegionSize ?? 256 * 1024;
  while (true) {
    const session = freshSession({ ...opts, astRegionSize });
    try {
      session.parse(source);
      return session;
    } catch (error) {
      const message = typeof error?.message === 'string' ? error.message : '';
      if (!message.includes('AST region exhausted')) throw error;
      astRegionSize = astRegionSize * 2;
    }
  }
}

/**
 * Construct a standalone Membrane (no session).
 *
 * For tests that exercise the Membrane in isolation. Allocates a
 * buffer sized to the requested capacities, lays it out, attaches.
 *
 * If `opts.buffer` is supplied, the membrane is windowed over it
 * (host-allocated path). Otherwise an `ArrayBuffer` is allocated
 * here and owned by the returned object.
 *
 * @param {object} [opts] — capacity options (forwarded to
 *   computeMembraneLayout) plus an optional `buffer` /
 *   `byteOffset` / `byteLength` window.
 * @returns {Membrane}
 */
export function freshMembrane(opts = {}) {
  const { buffer: hostBuffer, byteOffset = 0, byteLength: hostByteLength, sharedMembrane = true, ...layoutOpts } = opts;
  const layout = computeMembraneLayout(layoutOpts);

  // When the host supplies a buffer, validate it before writing any
  // bytes so an undersized multi-region envelope reports the required
  // and available sizes rather than a downstream DataView RangeError.
  const availableLength = hostByteLength
    ?? (hostBuffer ? hostBuffer.byteLength - byteOffset : layout.byteLength);
  if (layout.byteLength > availableLength) {
    const c = layout.capacities;
    throw new MembraneOutOfSpaceError(
      `Membrane layout requires ${layout.byteLength} bytes but host supplied ${availableLength} ` +
      `(shortfall ${layout.byteLength - availableLength}). ` +
      `Regions: header=${MEMBRANE_HEADER_SIZE}, ` +
      `handleTable=${c.handleTableCapacity * HANDLE_ENTRY_SIZE}, ` +
      `grantTable=${c.grantTableCapacity * GRANT_ENTRY_SIZE}, ` +
      `idListPool=${c.idListPoolSize}, ` +
      `rootGrants=${c.rootGrantsListCapacity * 4}, ` +
      `valueArena=${c.valueArenaSize}, ` +
      `closureHandleTable=${c.closureHandleTableCapacity * CLOSURE_HANDLE_ENTRY_SIZE}, ` +
      `linkedPromiseTable=${c.linkedPromiseTableCapacity * LINKED_PROMISE_ENTRY_SIZE}, ` +
      `mutationLog=${c.mutationLogCapacity * MUTATION_LOG_ENTRY_SIZE}, ` +
      `runtimeStateCell=${RUNTIME_STATE_CELL_BYTES}, ` +
      `ledger=${c.ledgerCapacity * LEDGER_ENTRY_BYTES}, ` +
      `capabilityStateTable=${c.capabilityStateTableCapacity * CAPABILITY_STATE_ENTRY_SIZE}, ` +
      `costLedger=${c.costLedgerCapacity * COST_LEDGER_ENTRY_SIZE}, ` +
      `objectHandleTable=${c.objectHandleTableCapacity * OBJECT_HANDLE_ENTRY_SIZE}.`);
  }

  const buffer = hostBuffer
    ?? (sharedMembrane
        ? new SharedArrayBuffer(layout.byteLength)
        : new ArrayBuffer(layout.byteLength));
  // When the caller pinned a buffer, the membrane window spans the
  // whole buffer (or the host-supplied byteLength). When we
  // allocated ourselves, the buffer is exactly layout-sized.
  const byteLength = hostByteLength
    ?? (hostBuffer ? hostBuffer.byteLength - byteOffset : layout.byteLength);
  layoutMembrane(buffer, byteOffset, layoutOpts);
  return new Membrane({ buffer, byteOffset, byteLength });
}

/**
 * Construct a session that resumes from snapshot bytes.
 *
 * Allocates memory + buffer sized to the bytes, copies them in, and
 * attaches. The membrane bytes self-describe their byteLength (v10
 * TOTAL_BYTE_LENGTH); the vat bytes self-describe their segmentSize
 * (STATE.SEGMENT_SIZE).
 *
 * @param {Uint8Array} vatBytes
 * @param {Uint8Array} membraneBytes
 * @param {object} [opts]
 * @returns {object} session
 */
export function restoreSession(vatBytes, membraneBytes, opts = {}) {
  if ('module' in opts) {
    throw new TypeError(
      'restoreSession: opaque `module` is not supported; pass raw ' +
      '`interpreterModuleBytes`');
  }
  const vatLayout = readVatLayout(vatBytes, 0);

  // Membrane: caller may pass null when they have only a vat
  // snapshot (e.g. tests that don't exercise capabilities). In that
  // case we lay out a fresh membrane on the side. Real hosts always
  // pass both halves. Computed before `memory` below: the worst-case
  // GC scratch budget needs its capacities.
  const useSharedMembrane = opts.sharedMembrane !== false;
  let membraneLayout, membraneBuffer;
  if (membraneBytes) {
    membraneLayout = readMembraneLayout(membraneBytes, 0);
    membraneBuffer = useSharedMembrane
      ? new SharedArrayBuffer(membraneLayout.byteLength)
      : new ArrayBuffer(membraneLayout.byteLength);
    new Uint8Array(membraneBuffer).set(membraneBytes, 0);
  } else {
    const { membraneOpts } = splitLayoutOpts(opts);
    membraneLayout = computeMembraneLayout(membraneOpts);
    membraneBuffer = useSharedMembrane
      ? new SharedArrayBuffer(membraneLayout.byteLength)
      : new ArrayBuffer(membraneLayout.byteLength);
    layoutMembrane(membraneBuffer, 0, membraneOpts);
  }

  const offset = opts.offset ?? 0;
  const memory = opts.memory ?? allocateSessionMemory(vatLayout, membraneLayout, offset);
  new Uint8Array(memory.buffer).set(vatBytes, offset);

  const session = createSession({
    memory,
    offset,
    segmentSize: vatLayout.byteLength,
    membraneBuffer,
    membraneByteOffset: 0,
    membraneByteLength: membraneLayout.byteLength,
    interpreterModuleBytes: opts.interpreterModuleBytes,
    ...(opts.gcCollector ? { gcCollector: opts.gcCollector } : {}),
  });

  _sessionBuffers.set(session, { memory, membraneBuffer, vatLayout, membraneLayout, offset });
  return session;
}

/**
 * Slice a session's vat memory and membrane buffer into detached
 * `Uint8Array`s.
 *
 * The session must be a `freshSession` / `restoreSession` return value
 * so its host-owned buffer references are available in the side table.
 *
 * @param {object} session
 * @returns {{ vatBytes: Uint8Array, membraneBytes: Uint8Array }}
 */
export function snapshotSession(session) {
  const handles = _sessionBuffers.get(session);
  if (!handles) {
    throw new Error(
      'snapshotSession: session was not constructed via freshSession / ' +
      'restoreSession — the underlying buffers are not reachable.');
  }
  // Bump the tick before slicing so the snapshot bytes carry a fresh
  // value in the membrane header.
  session.airlock.membrane.bumpTick();
  const { memory, membraneBuffer, vatLayout, membraneLayout, offset = 0 } = handles;
  const vatBytes      = new Uint8Array(memory.buffer)
    .slice(offset, offset + vatLayout.byteLength);
  const membraneBytes = new Uint8Array(membraneBuffer)
    .slice(0, membraneLayout.byteLength);
  return { vatBytes, membraneBytes };
}

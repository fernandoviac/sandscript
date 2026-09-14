# Ring publication contract

Durable implementation contract for SandScript's continuous shared-memory
event-ring publication. The executable half of this contract is
`src/ring-publication.js`; the deterministic fixtures are under
`fixtures/ring-publication/`.

## Publication protocol

Every adopted ring version follows one seqlock-style protocol with a
single producer thread per ring and any number of concurrent
shared-memory readers:

1. The producer checks the terminal flag. Once
   `segment-space-exhausted` is set, publication to that ring is a
   permanent no-op; runtime execution continues.
2. When the current head is `0xffffffff`, the producer atomically stores
   generation zero as a transition seqlock, atomically resets the head
   to zero, atomically publishes the successor nonzero generation, and
   returns without touching a slot. If generation is already
   `0xffffffff`, it atomically sets the terminal flag instead and
   returns without changing the generation, head, or any slot.
3. The producer atomically advances the ring's 32-bit reservation head
   BEFORE touching the reused slot.
4. The producer atomically INVALIDATES the slot's publication token to
   the 0 sentinel. The previous lap's token equals exactly the index a
   slow reader still expects; overwriting the payload under a
   still-valid token would let that reader accept a torn record.
5. The producer writes the complete entry payload with ATOMIC stores.
   JavaScript and WebAssembly expose no store fences; only
   sequentially-consistent atomics respect per-agent program order.
6. The producer atomically publishes the slot's publication token: the
   exact 1-based entry index, as a u32.
7. A reader atomically loads generation before the reservation head.
   Generation zero rejects the whole page as a transient malformed
   observation. Otherwise it checks any `expectedSegmentGeneration` and
   terminal flags, validates each token before and after atomic payload
   decoding, then atomically loads generation and flags again. A
   generation change rejects the whole page. A token change returns only
   the validated prefix with typed truncation.

Invariants:

- Generation starts at one. Zero is never a valid segment: it appears
  only as the writer's transition seqlock and readers always reject it.
- `segmentGeneration` is an opaque segment discriminator, not a wrap
  count. Consumers start a new source cursor segment whenever it changes. A
  missed transition is an unknown-size continuity-loss gap; consumers never
  multiply generation differences by `2^32`.
- Generation never aliases. At generation `0xffffffff`, the next native
  head wrap sets `RING_FLAG_SEGMENT_SPACE_EXHAUSTED` and permanently
  stops ring publication without blocking the runtime. Recovery requires
  a new runtime/source incarnation.
- Zero remains the "never published" token sentinel. The boundary
  diagnostic whose wrapped index would be zero is dropped without
  touching a slot; accepted successor entries begin at index one.
- After a generation transition, head < capacity identifies the
  successor segment's retained indexes 1..head. Prior-generation high
  tokens remaining in other slots are discarded and can never be
  attached to the successor.
- Heads and tokens stay 32-bit. There is no wide producer cursor.
- Reads are bounded by `maximumEntries` and `maximumBytes`, decode only
  candidate slots, page oldest-first, and never spin waiting for a hot
  writer.
- Every writer uses transition order `generation = 0` → `head = 0` →
  `generation = successor`, or normal publication order reservation →
  invalidation → atomic payload → token publication.

## Typed read results

`RING_READ_STATUS` (whole read): `ok`, `not-enabled` (region never
allocated), `unsupported-version` (reported with the exact declared
version), `segment-changed` (the observed generation differs from the
expected generation or changed during the read),
`segment-space-exhausted` (typed terminal source condition),
`invalid-cursor` (request cursor ahead of the reservation head), and
`malformed` (inconsistent geometry or zero generation).

`RING_READ_TRUNCATION` remains separate from whole-read status:
`entry-limit`, `byte-limit`, `overrun` (writer lapped the requested
page before its pre-decode token check), and `raced` (token changed
between the pre- and post-decode loads). `segment-changed` and
`segment-space-exhausted` return no entries and no truncation.

Every successful result carries `segmentGeneration`, `capacity`,
`reservationHead`, `newestCommitted`, `oldestAvailable`, an exact
ordinary-overwrite `gap` (`{ firstMissingIndex, lastMissingIndex }` or
`null`), and entries tagged with their 1-based `index`.

`not-applicable` (a drone kind that has no such ring at all) is a consumer
source disposition, not a decoder result — a decoder is never invoked without
a SandScript vat or membrane to read.

## Ring formats and version signals

### Cost ledger (membrane)

- Region: membrane, `HEADER.COST_LEDGER_OFFSET` / `_CAPACITY`; always
  allocated (capacity is a positive power of two). Entry: 96 bytes
  (`COST_LEDGER_ENTRY`), unchanged.
- Header fields: flags at byte 276, reservation head at byte 288, and
  `COST_LEDGER_SEGMENT_GENERATION` at byte 292. Both new fields consume
  reserved words; `MEMBRANE_HEADER_SIZE` remains 296 bytes.
- Publication token: the entry's `SEQ_LO` u32. `SEQ_HI` stays reserved.
- Version signal: `MEMBRANE_FORMAT_VERSION = 14`. Format 13 is the
  atomic-token format without cursor segments and is unsupported by
  the current runtime.
- Writer: `Membrane.appendCostEntry`. Terminal exhaustion drops only
  the accounting event; the caller's runtime operation continues.
- Decoder: `createCostLedgerView(...).readRange(...)` in
  `src/runtime/cost-ledger.js`, the single bounded decoder. Snapshot
  readers supply head/generation/flags values; live readers supply all
  three byte offsets for atomic pre/post validation.

### Header-event ring (vat)

- Region: vat, `STATE.HEADER_EVENT_RING_BASE` / `_SIZE`; size 0 =
  `not-enabled`. Entry: 32 bytes (`HEADER_EVENT_RING_ENTRY`), unchanged;
  the 16 reserved payload bytes still carry parked-slot bitmaps.
- Header: reservation head at offset 0, flags at 4, format at 8, and
  `SEGMENT_GENERATION` at the formerly-reserved offset 12.
- Publication token: `ENTRY_INDEX`, the exact 1-based entry index.
- `HEADER_EVENT_RING_FORMAT_VERSION = 3`; pre-segment format 2 is
  rejected as `unsupported-version`.
- Writers: `writeHeaderEventRingEntry` /
  `writeParkedSlotsSnapshotEntry` (JavaScript) and
  `$header_event_ring_write` /
  `$header_event_ring_write_parked_slots` (WebAssembly). All implement
  identical wrap and exhaustion ordering.
- Decoder: `readHeaderEventRingRange` in
  `src/fuel/header-event-ring.js`.

### Instruction-step ring (vat)

- Region: vat, `STATE.STEP_RING_BASE` / `_SIZE`; size 0 = `not-enabled`.
- Entry: expanded 32 → 40 bytes with the aligned publication token
  first; all fields naturally aligned (`STEP_RING_ENTRY`):

  | offset | size | field |
  |-------:|-----:|-------|
  | 0 | u32 | publicationToken |
  | 4 | u32 | instructionIndex |
  | 8 | u32 | scopePointer |
  | 12 | u32 | heapPointer |
  | 16 | u32 | stringPointer |
  | 20 | u16 | opcode |
  | 22 | u16 | pendingDepth |
  | 24 | u16 | callDepth |
  | 26 | u16 | tryDepth |
  | 28 | u16 | grantDepth |
  | 30 | u8 | slot |
  | 31 | u8 | status |
  | 32 | u8 | errorCode |
  | 33 | u8 | completionType |
  | 34 | 6 bytes | reserved |

- Header: reservation head at offset 0, flags at 4, format at 8, and
  `SEGMENT_GENERATION` at formerly-reserved offset 12.
- `STEP_RING_FORMAT_VERSION = 3`; pre-segment format 2 is rejected as
  `unsupported-version`.
- Writer: `$step_ring_write` (WebAssembly), the only step emitter. At
  terminal exhaustion it returns from the diagnostic write only; the
  instruction dispatch continues.
- Decoder: `readStepRingRange` in `src/fuel/step-ring.js`.

### Step hot-path measurement (implementation report)

Measured 2026-08-04 on an Apple M4 (Deno, `tools/bench-step-ring.js`,
hot integer loop, 5,700,013 instructions per run, best of 5):

| configuration | best ms | instructions/s | overhead |
|---|---:|---:|---:|
| recording disabled (`stepRingSize` 0) | 104.8 | 54.4M | — |
| pre-cutover writer (14 plain stores) | 161.0 | 35.4M | +52.7% (9.7 ns/instr) |
| v24 atomic writer (12 atomic stores) | 165.8 | 34.4M | +58.2% (10.7 ns/instr) |

- Per-instruction store mix: 14 plain stores → 12 atomic stores (head
  reservation, token invalidation, 9 payload words, token publication).
- Memory: +8 bytes per entry (32 → 40).
- The atomic publication contract itself costs ~1.0 ns/instruction on
  top of what unsafe recording already cost; the dominant cost of step
  recording predates the cutover. Recording stays opt-in
  (`stepRingSize`, default 0) and the disabled path is unchanged (one
  branch per dispatch).
- Bounded-reader progress under a continuously lapping writer is
  proven by tests/fuel/step_ring_publication_test.js (the concurrent
  proof pages throughout a 30k-instruction run against a 64-entry ring
  and never spins, returning typed gaps and validated prefixes).

## Stored-byte format

One aggregate drone format covers the complete vat and membrane byte pair.
`src/persisted-format.js` owns its current version.
Both byte headers carry the same aggregate version.
The runtime restores only the current aggregate version.

Internal section versions describe their encodings.
They do not form independent migration tracks.
The aggregate version advances for each persisted-byte change in any section.

Aggregate version 1 established this contract at commit `0330c1a`.
Aggregate version 2 changes no layout or data.
Its migration stamps the complete pair and proves the adjacent-hop mechanism.
No migration from the removed section-based format families is supported.

`tools/migrate-drone-bytes.js` owns the monotonic migration chain.
`tests/fuel/drone_migration_test.js` verifies its version 1 corpus.
Follow the
[persisted-format cutover runbook](operations/persisted-format-cutover.md) for
each subsequent format change.

## Fixture contract

Deterministic fixtures live in `fixtures/ring-publication/`, generated
by `deno run --allow-read --allow-write tools/generate-ring-fixtures.js`
and pinned by `tests/fuel/ring_fixtures_test.js` (regeneration must be
byte-identical; decode results must match the expectation files).

`fixtures/ring-publication/manifest.json`:

```json
{
  "contractVersion": 2,
  "rings": {
    "<ring>": {
      "states": {
        "<state>": {
          "region": "...bin",
          "expected": "...json",
          "segmentGeneration": 1,
          "flags": 0
        }
      }
    }
  }
}
```

Per ring, the published states cover `empty`, `partial`, `wrapped`
(exact ordinary-overwrite gap), `raced` (reservation without token),
`pre-wrap` (generation one, head one reservation before native wrap),
`transition-seqlock` (generation zero with the old high head and slots,
always rejected), `transition` (successor entries with prior-generation
slots resident), `old-expected-generation`, `generation-raced`,
`segment-space-exhausted`, `unsupported-version` (the exact
pre-segment format), and malformed/not-enabled dispositions where
applicable. Generation-race entries include the deterministic mutation
schedule consumers apply between payload decode and post-validation.

Each byte-backed state ships the raw region bytes and a complete typed
decode expectation for the bounded request recorded in the manifest.
For the membrane cost ledger, generation and flags live in the membrane
header and are therefore recorded beside the raw entry-region bytes in
the manifest.

Consumers use the fixtures unchanged; a consumer maintaining a
hand-copied approximation of these layouts is a contract violation.

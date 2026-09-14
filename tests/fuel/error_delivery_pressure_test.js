/**
 * Pressure-safe error delivery at the edge of handle-lifetime recovery.
 *
 * createAndPushError allocates: an error object on the heap and the
 * message in the string table. Every dispatch error path (handler
 * threw, grant denied, missing method, bad Promise argument,
 * suspension reject) funnels through it, and a pressure throw there
 * escaped session.run (or the host's reply callback) as a raw signal —
 * the drone's try/catch never saw the real error.
 *
 * Two fixes pinned here:
 *
 *  1. internString's table-full throw is now a typed
 *     HeapPressureSignal (region 'string-table') instead of a plain
 *     Error, so every pressure-recovery site (marshal stash, settle
 *     retry, error-delivery retry) treats a full string table exactly
 *     like a full heap: gc — which compacts the string table — and
 *     retry.
 *
 *  2. The airlock's _createAndPushErrorWithPressureRecovery self-heals
 *     (gc + one retry) like the linked-promise settle does, so a
 *     handler throw whose message doesn't fit the string table still
 *     reaches the drone's catch after the gc reclaims dead interns.
 */

import { assertEquals, assert } from "https://deno.land/std@0.208.0/assert/mod.ts";
import { freshSession } from '../../src/host-owned-session.js';
import { HeapPressureSignal } from '../../src/fuel/memory-image.js';
import { RuntimeBuilder } from '../../src/runtime/test-harness.js';

Deno.test('internString throws a typed HeapPressureSignal when the string table is full', () => {
  const session = freshSession();
  const memoryImage = session.airlock.memoryImage;

  // Fill the table with unique live strings until it overflows. The
  // default table is 256 KB; 1 KB per entry bounds the loop well under
  // the 1000-iteration guard.
  let caught = null;
  for (let i = 0; i < 1000; i++) {
    try {
      memoryImage.internString(`filler-${i}-` + 'x'.repeat(1024));
    } catch (e) {
      caught = e;
      break;
    }
  }

  assert(caught !== null, 'the fill loop should have overflowed the string table');
  assert(caught instanceof HeapPressureSignal,
    `table-full must throw HeapPressureSignal, got ${caught.constructor.name}: ${caught.message}`);
  assertEquals(caught.region, 'string-table');
  assert(caught.message.includes('String table full'),
    `message should stay descriptive, got: ${caught.message}`);
});

Deno.test('handler throw with an uninternable message self-heals via gc and reaches the drone', async () => {
  let done;
  const finished = new Promise((resolve) => { done = resolve; });

  // 63 KB message (just under the 64 KB scratch cap): larger than the
  // ~58 KB of string-table space left after the drone's fill, smaller
  // than what a gc reclaims (the fill's ~184 KB of concat
  // intermediates are all dead by throw time).
  const bigMessage = 'M'.repeat(63 * 1024);

  const cap = {
    name: 'probe',
    needs: {},
    setup(airlock) {
      const rootGrant = airlock.createRootGrant();
      const root = airlock.register({}, { kind: 'root' });
      rootGrant.add(root);
      airlock.declare('thing', root);

      airlock.setHandler(root, 'explode', () => {
        throw new Error(bigMessage);
      });

      const report = airlock.register({}, { kind: 'report' });
      airlock.declare('report', report);
      rootGrant.add(report);
      airlock.setHandler(report, null, ({ args }) => {
        done({ caughtLength: args[0], caughtPrefix: args[1] });
      });

      return {};
    },
  };

  const { runtime, session } = new RuntimeBuilder()
    .onInboundMessage(() => {})
    .capability(cap)
    .build();
  await runtime.start();

  // The concat loop interns strings of length 16, 32, … 16·150 —
  // ≈ 180 KB of intermediates, all dead once junk is cleared. That
  // leaves the 256 KB table too full for the 40 KB message until a gc
  // compacts the dead interns away.
  const parsed = session.parse(`
    let run = async () => {
      let junk = ""
      let i = 0
      while (i < 150) {
        junk = junk + "abcdefghabcdefgh"
        i = i + 1
      }
      junk = ""
      let caughtLength = null
      let caughtPrefix = null
      try {
        thing.explode()
      } catch (err) {
        caughtLength = err.message.length
        caughtPrefix = err.message.slice(0, 4)
      }
      report(caughtLength, caughtPrefix)
    }
    run()
  `);
  session.setInstruction(0, parsed.startIndex);

  const gcPassesBefore = session.airlock.membrane.engineCounters().gcPassCount;
  await runtime.run(0);

  let timeoutId;
  try {
    const result = await Promise.race([
      finished,
      new Promise((_, reject) => {
        timeoutId = setTimeout(
          () => reject(new Error('drone never reported — error delivery died')), 10000);
      }),
    ]);
    const gcPassesAfter = session.airlock.membrane.engineCounters().gcPassCount;
    assert(gcPassesAfter > gcPassesBefore,
      'error delivery must have hit string-table pressure and self-healed via gc — ' +
      'if this fails the fill no longer forces pressure and the test is vacuous; retune it');
    assertEquals(result.caughtLength, bigMessage.length,
      'drone must catch the full handler error message after the gc-retry');
    assertEquals(result.caughtPrefix, 'MMMM');
  } finally {
    clearTimeout(timeoutId);
    await runtime.terminate();
  }
});

/**
 * JSON.parse reviver behavior:
 * the JSON_INTERNALIZE driver walks the freshly parsed result bottom-up
 * per InternalizeJSONProperty, staging one reviver call per entry plus
 * the root call reviver.call({"": root}, "", root). Value-level
 * host-parity cases live in differential_builtins_test.js; this file
 * pins the SandScript-specific contract: `this` binding, the loud
 * spread-path rejection, exact rest-callee arity (no V8 source-access
 * context argument), and survival across fuel pauses, GC on every
 * pause, and mid-walk snapshot/restore.
 *
 * Run with: deno task test tests/fuel/json_reviver_test.js
 */
import { assert, assertEquals } from "https://deno.land/std@0.208.0/assert/mod.ts";
import { freshSession, snapshotSession, restoreSession } from '../../src/host-owned-session.js';
import { parseAndSetup, parseAndRun } from './test-helpers.js';

Deno.test('reviver: this is the holder at every depth', () => {
  const session = freshSession();
  const result = parseAndRun(session, `
    let holders = [];
    JSON.parse('{"a":{"b":1},"c":[2]}', function (k, v) {
      if (k === 'b') holders.push(this.b === 1);
      if (k === '0') holders.push(this[0] === 2);
      if (k === '') holders.push(typeof this === 'object');
      return v;
    });
    let out = holders.join(',');
  `, 0, 10_000_000);
  assertEquals(result.status, 'done');
  assertEquals(session.get(0, 'out'), 'true,true,true');
});

Deno.test('reviver: rest callee receives exactly (key, value)', () => {
  const session = freshSession();
  const result = parseAndRun(session, `
    let shapes = [];
    JSON.parse('{"a":1}', (...kv) => { shapes.push(kv.length); return kv[1] });
    let out = shapes.join(',');
  `, 0, 10_000_000);
  assertEquals(result.status, 'done');
  assertEquals(session.get(0, 'out'), '2,2');
});

Deno.test('reviver: spread route rejects a function reviver loudly', () => {
  const session = freshSession();
  const result = parseAndRun(session, `
    let out = 'unset';
    try { JSON.parse(...['{"a":1}', (k, v) => v]) }
    catch (e) { out = 'threw' }
  `, 0, 10_000_000);
  assertEquals(result.status, 'done');
  assertEquals(session.get(0, 'out'), 'threw');
});

Deno.test('reviver: non-callable second argument stays ignored (spec IsCallable gate)', () => {
  const session = freshSession();
  const result = parseAndRun(session, `let out = JSON.parse('{"a":7}', 5).a;`, 0, 10_000_000);
  assertEquals(result.status, 'done');
  assertEquals(session.get(0, 'out'), 7);
});

// ---------------------------------------------------------------------------
// Resumability: the walk's state array and staged frames must survive fuel
// pauses, a GC at every pause, and snapshot/restore mid-walk.
// ---------------------------------------------------------------------------

const WORKLOAD = String.raw`
  let calls = 0;
  const revived = JSON.parse(
    '{"a":[1,2,3],"b":{"c":4,"d":[5,{"e":6}]},"f":7}',
    (k, v) => {
      calls = calls + 1;
      return typeof v === 'number' ? v * 10 : v;
    });
  let out = JSON.stringify(revived);
  let done = 1;
`;
const EXPECTED_OUT = '{"a":[10,20,30],"b":{"c":40,"d":[50,{"e":60}]},"f":70}';
const EXPECTED_CALLS = 12; // 6 numbers + 3 arrays/objects nested + a,b + root

function expectedValues() {
  const session = freshSession();
  parseAndSetup(session, WORKLOAD);
  const result = session.run(0, 100_000_000);
  assertEquals(result.status, 'done');
  assertEquals(session.get(0, 'out'), EXPECTED_OUT);
  assertEquals(session.get(0, 'calls'), EXPECTED_CALLS);
}

Deno.test('reviver: walk survives tiny-fuel pauses with GC at every pause', () => {
  expectedValues();
  const session = freshSession();
  parseAndSetup(session, WORKLOAD);
  let pauses = 0;
  for (let i = 0; i < 500000; i++) {
    session.mem.wasm.exports.run(20, 0);
    const condition = session.mem.getExitCondition(0);
    if (condition === 15) { session.gc(); continue; }
    if (condition === 2) { pauses++; session.gc(); continue; }
    break;
  }
  assertEquals(session.mem.getExitCondition(0), 1, 'paused run completes');
  assert(pauses > 5, `reviver work actually paused under tiny fuel (got ${pauses})`);
  assertEquals(session.get(0, 'out'), EXPECTED_OUT);
  assertEquals(session.get(0, 'calls'), EXPECTED_CALLS);
});

Deno.test('reviver: walk survives snapshot/restore at EVERY pause', () => {
  let session = freshSession();
  parseAndSetup(session, WORKLOAD);
  let pauses = 0;
  for (let i = 0; i < 500000; i++) {
    session.mem.wasm.exports.run(20, 0);
    const condition = session.mem.getExitCondition(0);
    if (condition === 15) { session.gc(); continue; }
    if (condition === 2) {
      pauses++;
      const snap = snapshotSession(session);
      session = restoreSession(snap.vatBytes, snap.membraneBytes);
      continue;
    }
    break;
  }
  assertEquals(session.mem.getExitCondition(0), 1, 'chained-restore run completes');
  assert(pauses > 5, `walk actually paused (got ${pauses})`);
  assertEquals(session.get(0, 'out'), EXPECTED_OUT);
  assertEquals(session.get(0, 'calls'), EXPECTED_CALLS);
});

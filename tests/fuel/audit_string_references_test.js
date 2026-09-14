/**
 * auditStringReferences validates every string reference after collection.
 * A healthy image audits clean; a deliberately poisoned object entry that
 * points mid-string, into the heap, or at id zero is found and named. This
 * pins detection of stale ids left behind when a moved string-table tail is
 * read through long-lived object entries.
 *
 * Run with: deno task test tests/fuel/audit_string_references_test.js
 */

import { assert, assertEquals } from "https://deno.land/std@0.208.0/assert/mod.ts";
import {
  MemoryManipulator,
  Parser,
  instantiateSync,
  layoutVat,
  Collector,
  auditStringReferences,
  TYPE,
  GC_HEADER_SIZE,
} from '../../src/fuel/index.js';
import { freshSession } from '../../src/host-owned-session.js';
import { parseAndSetup } from './test-helpers.js';

function createTestContext() {
  const memory = new WebAssembly.Memory({ initial: 16, maximum: 256, shared: true });
  const wasm = instantiateSync(memory);
  const mem = new MemoryManipulator(memory);
  mem.setWasmInstance(wasm);
  layoutVat(mem.memory, mem.baseOffset, { segmentSize: mem.segmentSize });
  mem.bootstrap();
  const parser = new Parser(mem);
  let code = null;
  function run(source) {
    if (code === null) code = mem.allocateCodeBlock();
    const startIndex = mem.codeBlockInstructionCount();
    parser.parse(source);
    mem.setContextInstructionIndex(0, startIndex);
    wasm.exports.run(100000, 0);
    return mem.getExitCondition(0);
  }
  return { mem, run };
}

Deno.test('audit: a healthy image has zero findings (before and after gc)', () => {
  const { mem, run } = createTestContext();
  run(`
    let park = { parkId: "chart-orion-crew-observatory", channel: "observatory" }
    let order = ["chart-orion-crew-observatory"]
    let byId = {}
    byId[order[0]] = park
    let arr = [park, "loose-string", 42]
    let m = new Map()
    m.set("map-key", "map-value")
  `);

  const before = auditStringReferences(mem);
  assertEquals(before.findings, [], 'clean before gc');
  assert(before.checkedReferences > 10, 'the walk must actually check references');
  assert(!before.regionCorrupt, 'string region walks cleanly');

  new Collector(mem).collect();

  const after = auditStringReferences(mem);
  assertEquals(after.findings, [], 'clean after gc');
});

Deno.test('audit: a poisoned string reference is found and named', () => {
  const { mem, run } = createTestContext();
  run(`let holder = { field: "the-poisoned-target" }`);

  // Locate holder's entry table via a clean audit's walk shape: find the
  // OBJECT whose value slot holds a string, then poison that slot's id with
  // a heap address (the live rot's exact signature: id 598280-style).
  const clean = auditStringReferences(mem);
  assertEquals(clean.findings, [], 'sanity: clean before poisoning');

  // Walk the heap for the entry whose key reads "field".
  const heapStart = mem.getHeapStart();
  const heapPointer = mem.getHeapPointer();
  let poisoned = 0;
  let headerPointer = heapStart;
  while (headerPointer < heapPointer && poisoned === 0) {
    const word = mem.view.getUint32(mem.abs(headerPointer), true);
    const size = word & 0x00ffffff;
    if (size === 0) break;
    const objType = (word >>> 24) & 0x7f;
    if (objType === 1 /* OBJ.OBJECT */) {
      const data = headerPointer + GC_HEADER_SIZE;
      const count = mem.view.getUint32(mem.abs(data + 4), true);
      const entriesHeader = mem.view.getUint32(mem.abs(data + 16), true);
      if (entriesHeader !== 0) {
        const entriesData = entriesHeader + GC_HEADER_SIZE;
        for (let i = 0; i < count; i++) {
          const entryRel = entriesData + i * 20;
          let key = '';
          try { key = mem.readString(mem.view.getUint32(mem.abs(entryRel), true)); } catch { continue; }
          const valueType = mem.view.getUint32(mem.abs(entryRel + 4), true);
          if (key === 'field' && valueType === TYPE.STRING) {
            mem.view.setUint32(mem.abs(entryRel + 4 + 8), heapStart + 12345, true);
            poisoned += 1;
            break;
          }
        }
      }
    }
    headerPointer += size;
  }
  assertEquals(poisoned, 1, 'test setup: exactly one slot poisoned');

  const report = auditStringReferences(mem);
  assertEquals(report.findings.length, 1, 'the poisoned reference is found');
  const finding = report.findings[0];
  assert(finding.where.startsWith('value['), `named as an entry value, got ${finding.where}`);
  assertEquals(finding.id, heapStart + 12345, 'the rotten id is reported');

  // VERIFY MODE: a collection over the poisoned image must fail loudly
  // through the poison machinery, naming the rotten reference — and a
  // second collection must refuse (the image is poisoned).
  const collector = new Collector(mem);
  collector.verifyAfterCollect = true;
  let verifyError = null;
  try { collector.collect(); } catch (e) { verifyError = e; }
  assert(verifyError, 'verify mode must throw on a rotten reference');
  assertEquals(verifyError.name, 'FatalCollectionError');
  assert(String(verifyError.message).includes('string reference audit failed'),
    `must name the audit, got: ${verifyError.message.slice(0, 120)}`);

  let second = null;
  try { collector.collect(); } catch (e) { second = e; }
  assert(second && String(second.message).includes('earlier failed collection'),
    'the poisoned image refuses further collections');
});

// =============================================================================
// Context-state coverage (pending / grant / completion / request-base)
// =============================================================================

function suspendedKitchenSinkSession() {
  // A context parked mid-expression, inside nested grants, inside a
  // finally with a pending RETURN completion, with string args staged
  // in the external request block — every context-state string home
  // the auditor covers, live at once.
  const session = freshSession();
  const { airlock } = session;
  const apiHandle = airlock.register({});
  airlock.setHandler(apiHandle, 'echo', ({ context }) => context.suspend(() => {}));
  airlock.declare('Api', apiHandle);
  const root = airlock.createRootGrant('app');
  root.add(apiHandle);
  airlock.onGrantRequest = (identifier) => {
    const grant = airlock.membrane.createGrant(identifier);
    return { approved: true, grant };
  };

  parseAndSetup(session, `
    function work() {
      try {
        return "completion_string_in_flight";
      } finally {
        grant "grant_identifier_alpha_prose" {
          grant "grant_identifier_beta_prose" {
            let combined = "pending_operand_string" + Api.echo("request_arg_string");
          }
        }
      }
    }
    work()
  `);
  const r = session.run(0, 100000);
  assertEquals(r.status, 'suspended', 'context must park inside the whole stack');
  return session;
}

Deno.test('audit: suspended context state audits clean, including across string compaction', () => {
  const session = suspendedKitchenSinkSession();

  const before = auditStringReferences(session.mem);
  assertEquals(before.findings, [], 'clean while parked');
  assert(before.checkedContexts >= 1, 'the context walk must run');

  // Garbage so the collection compacts strings — pre-fix (stale grant
  // stride + unforwarded completion value) this audit flagged the
  // context's stale ids.
  for (let i = 0; i < 50; i++) {
    session.mem.internString(`garbage_padding_string_${i}_${'x'.repeat(40)}`);
  }
  const stats = session.gc();
  assert(stats.stringsCollected > 0, 'setup must force string compaction');

  const after = auditStringReferences(session.mem);
  assertEquals(after.findings, [], 'context-state ids must all be forwarded');
});

Deno.test('audit: a poisoned grant identifier in a suspended context is found and named', () => {
  const session = suspendedKitchenSinkSession();
  assertEquals(session.mem.getGrantDepth(0), 2, 'two nested grants parked');

  const { identifierAddr } = session.mem.getGrantEntry(0, 1);
  const heapStart = session.mem.getHeapStart();
  session.mem.view.setUint32(session.mem.abs(identifierAddr) + 8, heapStart + 4321, true);

  const report = auditStringReferences(session.mem);
  assertEquals(report.findings.length, 1, 'the poisoned identifier is found');
  const finding = report.findings[0];
  assertEquals(finding.objType, 'context');
  assertEquals(finding.where, 'context[0].grant[1].identifier');
  assertEquals(finding.id, heapStart + 4321);
});

Deno.test('audit: a poisoned pending-stack operand in a suspended context is found and named', () => {
  const session = suspendedKitchenSinkSession();

  // Find the pending slot holding a string ("pending_operand_string"
  // waits on the operand stack for the concat).
  const base = session.mem.getPendingStackBase(0);
  const pointer = session.mem.getContextPendingPointer(0);
  let poisonedAt = -1;
  for (let addr = base, i = 0; addr < pointer; addr += 16, i++) {
    if (session.mem.view.getUint32(session.mem.abs(addr), true) === TYPE.STRING) {
      session.mem.view.setUint32(session.mem.abs(addr) + 8, 7, true); // mid-hash-table: invalid
      poisonedAt = i;
      break;
    }
  }
  assert(poisonedAt >= 0, 'test setup: a string operand must be parked on the pending stack');

  const report = auditStringReferences(session.mem);
  assertEquals(report.findings.length, 1, 'the poisoned operand is found');
  assertEquals(report.findings[0].where, `context[0].pending[${poisonedAt}]`);
});

// ---------------------------------------------------------------------------
// String.fromCharCode / String.fromCodePoint intern discipline: these methods
// used to write
// [len][bytes] records directly into the string region and advance the bump
// pointer from the data end instead of the entry start. That roughly doubled
// each step, left an unreachable gap after every string, and broke alignment
// for later interns. A chunked base64-building loop triggers the corruption
// in one call. Both methods now stage in heap-tail scratch and go through
// $intern_string like btoa and the slice/case methods.
// ---------------------------------------------------------------------------

Deno.test('audit: a fromCharCode concat loop leaves the string region walkable and aligned', () => {
  const session = freshSession();
  parseAndSetup(session, `
    let out = "";
    let i = 0;
    while (i < 40) {
      out = out + String.fromCharCode(65 + (i % 26));
      i = i + 1;
    }
    let codePoints = String.fromCodePoint(72, 105, 128169);
    let single = String.fromCharCode(33);
  `, 0);
  const result = session.run(0, 200000);
  assertEquals(result.status, 'done');
  assertEquals(session.get(0, 'out').length, 40);
  assertEquals(session.get(0, 'out').slice(0, 5), 'ABCDE');
  assertEquals(session.get(0, 'codePoints'), 'Hi\u{1F4A9}');
  assertEquals(session.get(0, 'single'), '!');

  const report = auditStringReferences(session.memoryImage);
  assertEquals(report.regionCorrupt, false,
    'the entry walk must reach the bump pointer without tearing');
  assertEquals(report.findings, []);
  assertEquals(
    (session.memoryImage.getStringPointer() - session.memoryImage.getStringStart()) % 4, 0,
    'the bump pointer must stay 4-aligned');
});

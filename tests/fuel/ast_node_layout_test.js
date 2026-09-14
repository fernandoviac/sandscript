/**
 * NODE_LAYOUT pinning tests for the WAT collector.
 *
 * NODE_LAYOUT is the single declarative walking table for the AST:
 * readTree materializes children by its names, the GC string walk
 * (iterateStringFields) follows its offsets, and the stage-2 WAT
 * collector consumes it as a host-written knowledge table. A tag or
 * field missing from the table means strings go stale after string
 * compaction — silently, far from the cause. These tests pin:
 *
 *   1. every NODE tag has a layout entry;
 *   2. on a program exercising every string-carrying construct and
 *      every child-edge kind (scalar, count-prefixed array, root
 *      chain), the walk reaches every marker string;
 *   3. the walk's yield survives a string-compacting gc intact
 *      (getSource round-trip on the every-construct program).
 */
import { assert, assertEquals } from "https://deno.land/std@0.208.0/assert/mod.ts";
import { freshSession } from '../../src/host-owned-session.js';
import { NODE, NODE_LAYOUT, createAstReader } from '../../src/fuel/ast.js';

// Parse-only source (never run — undeclared identifiers are fine at
// parse time) touching every string-carrying tag the parser emits and
// routing marker strings through diverse child edges: conditional
// branches, switch cases, try/finally, loop bodies, call args,
// template parts, object properties, sequence, optional chains, grant
// bodies. (LABELED, TAGGED_TEMPLATE, SPREAD, SUPER exist in the AST
// dialect but have no parser emission — the table-completeness test
// above still covers their entries.)
const FIRST_SOURCE = `
  let uniqBound = 'uniq_string_lit';
  let uniqBig = 987654321098765432109876543210n;
  let cond = flag ? deepA.condProp : condAlt;
  let seq = (sideA = 1, sideB = 2.5, true, null, undefined);
  let arr = [1, uniqBound, spreadSrc];
  let obj = { plainKey: nestedIdent, other: receiver.uniqProp };
  let opt = maybe?.optProp ?? maybe?.[optIndex];
  let made = new Ctor(ctorArg);
  let called = fn?.(optCallArg);
  let tpl = \`before \${tplIdent} after\`;
  function namedFn(paramOne, paramTwo) {
    if (paramOne) { return paramOne.retProp; } else { throw paramTwo; }
  }
  async function asyncFn() { let got = await awaited.awaitProp; }
  for (let i = 0; i < 3; i++) {
    while (whileTest.whileProp) { break; }
    do { emptyOk; } while (doTest);
    ;
  }
  for (let k in kSource.inProp) { continue; }
  for (let v of vSource.ofProp) { v; }
  try { risky.tryProp; } catch (caughtParam) { caughtParam.catchProp; }
  finally { fin.finallyProp; }
  switch (disc.switchProp) {
    case caseTest.caseProp: caseBody.caseBodyProp; break;
    default: defBody.defaultProp;
  }
  grant ("cap_marker") { granted.grantBodyProp; } denied (deniedIds) {
    deniedIds.deniedBodyProp;
  }
`;

// Second parse: pins the ROOT chain edge — its strings are reachable
// only by following nextRoot from the first root.
const SECOND_SOURCE = `let second_parse_marker = other.second_prop;`;

const EXPECTED_STRINGS = [
  'uniq_string_lit',
  '987654321098765432109876543210', // bigint digit string, AST-only
  'uniqBound', 'condProp', 'uniqProp', 'optProp',
  'namedFn', 'paramTwo', 'retProp', 'awaitProp',
  'whileProp', 'inProp', 'ofProp',
  'tryProp', 'catchProp', 'finallyProp',
  'switchProp', 'caseProp', 'caseBodyProp', 'defaultProp',
  'tplIdent',
  'cap_marker', 'deniedIds', 'grantBodyProp', 'deniedBodyProp',
  'second_parse_marker', 'second_prop',
];

Deno.test('NODE_LAYOUT: every NODE tag has a layout entry', () => {
  for (const [name, tag] of Object.entries(NODE)) {
    assert(NODE_LAYOUT[tag] !== undefined, `NODE.${name} (0x${tag.toString(16)}) missing from NODE_LAYOUT`);
  }
});

Deno.test('NODE_LAYOUT walk reaches every marker string across the root chain', () => {
  const session = freshSession({ inlineSource: true });
  session.parse(FIRST_SOURCE);
  session.parse(SECOND_SOURCE);

  const reader = createAstReader(session.mem);
  const reached = new Set();
  for (const { stringOffset } of reader.iterateStringFields()) {
    reached.add(session.mem.readString(stringOffset));
  }

  for (const expected of EXPECTED_STRINGS) {
    assert(reached.has(expected), `walk missed "${expected}" — a NODE_LAYOUT edge or string field is missing`);
  }
});

Deno.test('every-construct source round-trips through a string-compacting gc', () => {
  const session = freshSession({ inlineSource: true });
  // Garbage interned first so compaction relocates everything after it.
  for (let i = 0; i < 50; i++) {
    session.mem.internString(`garbage_padding_string_${i}_${'x'.repeat(40)}`);
  }
  session.parse(FIRST_SOURCE);
  session.parse(SECOND_SOURCE);

  const before = session.getSource();
  const stats = session.gc();
  assert(stats.stringsCollected > 0, 'setup must force string compaction');

  // Poison the vacated string-table tail so stale ids read garbage
  // deterministically instead of intact ghost bytes.
  const start = session.mem.abs(session.mem.getStringPointer());
  const end = session.mem.abs(session.mem.baseOffset + session.mem.segmentSize);
  new Uint8Array(session.mem.buffer, start, end - start).fill(0xAA);

  assertEquals(session.getSource(), before);
});

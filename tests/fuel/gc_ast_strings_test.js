/**
 * AST nodes carry string-table offsets (identifier names, string
 * literals, bigint digit strings, labels, grant denied-param names).
 * The collector must mark them (bigint digit strings typically have NO
 * other reference) and forward them across string compaction — before
 * markAstStrings/updateAstStrings, getSource() on any inlineSource
 * session corrupted after the first string-compacting gc().
 *
 * Found during live-patching phase 3 (the patcher reads old AST roots
 * on a freshly gc'd scratch). Fourth member of the code-reference GC
 * family: LIT_BIGINT operands (366cd3b), GRANT_DENIED names,
 * ITER_CALLBACK closures (5099a29), and now AST string fields.
 */
import { assert, assertEquals } from "https://deno.land/std@0.208.0/assert/mod.ts";
import { freshSession } from '../../src/host-owned-session.js';
import { parseAndRun } from './test-helpers.js';

const SOURCE = `
  let label = 'count of widgets';
  let big = 123456789012345678901234567890n;
  function describe(n) { return label + ': ' + n; }
  let summary = describe(2);
`;

// Poison the free string-table span. Compaction moves live strings
// down without zeroing the vacated tail, so stale references keep
// reading intact ghost bytes — poisoning makes corruption
// deterministic instead of latent. The span ends at the data end —
// the derived hash index at the region tail (layout v14) is live
// structure, not free space.
function scrubFreeStringTable(session) {
  const start = session.mem.abs(session.mem.getStringPointer());
  const end = session.mem.abs(session.mem.getStringDataEnd());
  new Uint8Array(session.mem.buffer, start, end - start).fill(0xAA);
}

Deno.test('getSource round-trips across a string-compacting gc', () => {
  const session = freshSession({ inlineSource: true });
  // Garbage strings interned BEFORE the program, so compaction
  // relocates everything the program interned.
  for (let i = 0; i < 50; i++) {
    session.mem.internString(`garbage_padding_string_${i}_${'x'.repeat(40)}`);
  }
  parseAndRun(session, SOURCE);

  const before = session.getSource();
  assert(before.includes('count of widgets'));
  assert(before.includes('123456789012345678901234567890'));

  const stats = session.gc();
  assert(stats.stringsCollected > 0, 'setup must force string compaction');
  scrubFreeStringTable(session);

  assertEquals(session.getSource(), before);
});

Deno.test('AST-only strings (bigint digits) survive gc and execution continues', () => {
  const session = freshSession({ inlineSource: true });
  for (let i = 0; i < 50; i++) {
    session.mem.internString(`garbage_padding_string_${i}_${'x'.repeat(40)}`);
  }
  parseAndRun(session, SOURCE);

  session.gc();
  scrubFreeStringTable(session);

  // The program still runs correctly after compaction + poisoning.
  parseAndRun(session, `let again = describe(big);`);
  assert(String(session.get(0, 'again')).startsWith('count of widgets: '));
});

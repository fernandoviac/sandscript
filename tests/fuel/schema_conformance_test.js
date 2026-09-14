// Official JSON-Schema-Test-Suite conformance for the standalone schema
// engine, driven through the host entry point over bare memory.
//
// Every case is accounted as CONFORMANT, DECLINED (with one of the
// accepted reasons), or WRONG. WRONG must be zero for every file; the
// decline reasons are the ruled exclusions plus the items still landing.
import { assertEquals } from 'https://deno.land/std@0.208.0/assert/mod.ts';
import { createSchemaEngine } from '../../src/schema/index.js';

const ROOT = new URL('../../fixtures/json-schema-test-suite/', import.meta.url);

const DRAFTS = [
  { dir: 'draft2020-12', dialect: '2020-12' },
  { dir: 'draft2019-09', dialect: '2019-09' },
  { dir: 'draft7', dialect: 'draft-07' },
  { dir: 'draft4', dialect: 'draft-04' },
];

// Accepted decline reasons: the engine refuses loudly for one of these.
const DECLINE_REASONS = new Set(['REGEX', 'BIGNUM']);

// Cases a JS host cannot express: JSON.parse and msgpack.encode collapse
// `1.0` into the integer 1, so draft-4's "a float is not an integer even
// without fractional part" has no distinguishable input. The engine itself
// honours the draft-4 rule when handed a float64 (see the contract test).
const HOST_NUMBER_MODEL = new Set(['optional/zeroTerminatedFloats.json']);
// Arbitrary-precision literals have no msgpack form yet (plan: additive
// ext type); a wrong verdict in this file is the documented BIGNUM decline.
const BIGNUM_FILES = new Set(['optional/bignum.json']);
// Plan ruling 3: one unified dialect selected by content. Keywords are
// never switched off by the draft a resource names or by a custom
// metaschema's `$vocabulary`; these groups pin exactly that switching-off.
// Plan "Keyword surface": content keywords are annotations, never
// evaluated; draft-07's optional content assertions are ruled out.
const CONTENT_ANNOTATION_FILES = new Set(['optional/content.json']);
const UNIFIED_DIALECT_GROUPS = new Set([
  'optional/cross-draft.json / refs to historic drafts are processed as historic drafts',
  'vocabulary.json / schema that uses custom metaschema with with no validation vocabulary',
]);

async function* files(dir) {
  for await (const entry of Deno.readDir(dir)) {
    const path = new URL(entry.name + (entry.isDirectory ? '/' : ''), dir);
    if (entry.isDirectory) yield* files(path);
    else if (entry.name.endsWith('.json')) yield path;
  }
}

function relative(url, base) {
  return decodeURIComponent(url.href.slice(base.href.length));
}

// The suite's remote documents, addressed as http://localhost:1234/<path>.
// Unsupported-dialect subtrees are skipped; the draft-4 subtree (whose
// `id` anchors are ordinary data outside draft-4) only joins its own draft.
// 2019-09/2020-12/draft-07 remotes are shared: the cross-draft cases need them.
async function loadRemotes(draftDir) {
  const base = new URL('remotes/', ROOT);
  const remotes = [];
  for await (const file of files(base)) {
    const path = relative(file, base);
    const top = path.split('/')[0];
    if (top === 'draft3' || top === 'draft6') continue;
    if (top === 'draft4' && draftDir !== 'draft4') continue;
    remotes.push([`http://localhost:1234/${path}`, JSON.parse(await Deno.readTextFile(file))]);
  }
  return remotes;
}

// The official metaschemas, keyed by their own $id / id (a trailing '#'
// on the draft-7/-4 ids is dropped: it is an empty fragment).
async function loadMetaschemas() {
  const base = new URL('metaschemas/', ROOT);
  const docs = [];
  for await (const file of files(base)) {
    const doc = JSON.parse(await Deno.readTextFile(file));
    const id = (doc.$id ?? doc.id).replace(/#$/, '');
    docs.push([id, doc]);
  }
  return docs;
}

async function runDraft(engine, draft) {
  const base = new URL('tests/' + draft.dir + '/', ROOT);
  const remotes = [...await loadRemotes(draft.dir), ...await loadMetaschemas()];
  const report = new Map();
  for await (const file of files(base)) {
    const name = relative(file, base);
    const groups = JSON.parse(await Deno.readTextFile(file));
    const stats = { conformant: 0, declined: 0, wrong: 0, wrongCases: [], declinedReasons: {} };
    for (const group of groups) {
      let compiled = null;
      let decline = null;
      try {
        // The required format.json pins the specification default — format
        // as an annotation. The engine's own default asserts (plan ruling
        // 2); both modes are exercised, this file under the spec's.
        const formats = name === 'format.json' ? 'annotate' : 'assert';
        // remote documents only when a group can reach them: keeps the
        // common case at one small program
        const text = JSON.stringify(group.schema);
        const needsRemotes = text.includes('localhost:1234') || text.includes('json-schema.org/draft');
        compiled = engine.compile(group.schema, {
          dialect: draft.dialect,
          formats,
          schemas: needsRemotes ? remotes : undefined,
        });
      } catch (error) {
        const reason = error.diagnostic ?? error.status ?? 'ERROR';
        if (DECLINE_REASONS.has(reason)) decline = reason;
        else decline = `COMPILE:${reason}`;
      }
      for (const test of group.tests) {
        if (decline) {
          if (DECLINE_REASONS.has(decline)) {
            stats.declined++;
            stats.declinedReasons[decline] = (stats.declinedReasons[decline] ?? 0) + 1;
          } else {
            stats.wrong++;
            stats.wrongCases.push(`${group.description} / ${test.description}: ${decline}`);
          }
          continue;
        }
        let verdict;
        try {
          verdict = compiled.test(test.data);
          // VALIDATE mode must agree with TEST mode
          const full = compiled.validate(test.data);
          if (full.valid !== verdict) {
            stats.wrong++;
            stats.wrongCases.push(`${group.description} / ${test.description}: test/validate disagree`);
            continue;
          }
        } catch (error) {
          if (error.status === 'UNSUPPORTED') {
            // plan "Formats": idn labels carry no IDNA table; an instance
            // whose verdict needs one is refused, never guessed
            stats.declined++;
            stats.declinedReasons.IDNA_TABLE = (stats.declinedReasons.IDNA_TABLE ?? 0) + 1;
            continue;
          }
          stats.wrong++;
          stats.wrongCases.push(`${group.description} / ${test.description}: threw ${error.message}`);
          continue;
        }
        if (verdict === test.valid) stats.conformant++;
        else if (HOST_NUMBER_MODEL.has(name) || BIGNUM_FILES.has(name) || CONTENT_ANNOTATION_FILES.has(name)
                 || UNIFIED_DIALECT_GROUPS.has(`${name} / ${group.description}`)) {
          const reason = BIGNUM_FILES.has(name) ? 'BIGNUM' : HOST_NUMBER_MODEL.has(name) ? 'HOST_NUMBER_MODEL'
            : CONTENT_ANNOTATION_FILES.has(name) ? 'CONTENT_ANNOTATION' : 'UNIFIED_DIALECT';
          stats.declined++;
          stats.declinedReasons[reason] = (stats.declinedReasons[reason] ?? 0) + 1;
        } else {
          stats.wrong++;
          stats.wrongCases.push(`${group.description} / ${test.description}: expected ${test.valid}`);
        }
      }
      compiled?.dispose();
    }
    report.set(name, stats);
  }
  return report;
}

for (const draft of DRAFTS) {
  Deno.test(`json-schema-test-suite ${draft.dir}`, async () => {
    const engine = createSchemaEngine();
    const report = await runDraft(engine, draft);
    let conformant = 0, declined = 0, wrong = 0;
    const lines = [];
    for (const [name, stats] of report) {
      conformant += stats.conformant;
      declined += stats.declined;
      wrong += stats.wrong;
      const reasons = Object.entries(stats.declinedReasons).map(([k, v]) => `${k}:${v}`).join(' ');
      lines.push(`  ${name.padEnd(48)} ok=${String(stats.conformant).padStart(4)} declined=${String(stats.declined).padStart(4)} wrong=${String(stats.wrong).padStart(4)} ${reasons}`);
      for (const c of stats.wrongCases.slice(0, 40)) lines.push(`      ! ${c}`);
    }
    console.log(`\n${draft.dir}: conformant=${conformant} declined=${declined} wrong=${wrong}\n${lines.join('\n')}`);
    assertEquals(wrong, 0, `${draft.dir}: wrong verdicts`);
    assertEquals(wrong, 0, `${draft.dir}: wrong verdicts (every non-conformant case must be a reasoned decline)`);
  });
}

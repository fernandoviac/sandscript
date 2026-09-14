// The official JSON-Schema-Test-Suite driven through the `Schema` global
// inside a session — the same corpus tests/fuel/schema_conformance_test.js
// runs through the bare-memory host binding. Verdicts must agree with the
// host binding case for case: the language surface is a binding over the
// same engine, never a second implementation.
//
// One session per corpus file; each group is fed as a JSON literal the
// script decodes with JSON.parse, compiles with Schema.compile, and checks
// with both test() and validate(). Small fuel grants exercise the pause
// and resume path on every operation.
import { assertEquals } from 'https://deno.land/std@0.208.0/assert/mod.ts';
import { freshSession } from '../../src/host-owned-session.js';
import { parseAndSetup } from './test-helpers.js';
import { createSchemaEngine } from '../../src/schema/index.js';

const ROOT = new URL('../../fixtures/json-schema-test-suite/', import.meta.url);

// Corpus groups arrive as one JSON literal each (the metaschema bundle is
// ~120KB), so the string scratch and table are sized well above the
// drone defaults; the heap holds the decoded bundle plus compiled programs.
const SESSION_OPTIONS = {
  inlineSource: true,
  heapSize: 64 * 1024 * 1024,
  stringTableSize: 64 * 1024 * 1024,
  scratchSize: 2 * 1024 * 1024,
  astRegionSize: 4 * 1024 * 1024,
};

const DRAFTS = [
  { dir: 'draft2020-12', dialect: '2020-12' },
  { dir: 'draft2019-09', dialect: '2019-09' },
  { dir: 'draft7', dialect: 'draft-07' },
  { dir: 'draft4', dialect: 'draft-04' },
];

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
  const meta = new URL('metaschemas/', ROOT);
  for await (const file of files(meta)) {
    const document = JSON.parse(await Deno.readTextFile(file));
    remotes.push([(document.$id ?? document.id).replace(/#$/, ''), document]);
  }
  return remotes;
}

function runToCompletion(session, grant) {
  for (let i = 0; i < 1_000_000; i++) {
    const r = session.run(0, grant);
    if (r.status === 'done') return r;
    if (r.status === 'paused') continue;
    if (r.status === 'memory_pressure') { session.gc?.(); continue; }
    throw new Error(`unexpected run status ${JSON.stringify(r)}`);
  }
  throw new Error('run did not complete');
}

// Verdict of one group through the host binding: per test [testVerdict,
// validateVerdict] or a decline string.
function hostVerdicts(engine, group, draft, remotes, formats) {
  let compiled;
  try {
    compiled = engine.compile(group.schema, { dialect: draft.dialect, formats, schemas: remotes });
  } catch (error) {
    return `compile:${error.diagnostic ?? error.status ?? 'ERROR'}`;
  }
  try {
    return group.tests.map((test) => {
      try {
        return [compiled.test(test.data), compiled.validate(test.data).valid];
      } catch (error) {
        return `threw:${error.status ?? error.message}`;
      }
    });
  } finally {
    compiled.dispose();
  }
}

let runCounter = 0;
function builtinVerdicts(session, group, draft, remotes, formats, grant) {
  const payload = JSON.stringify({ schema: group.schema, tests: group.tests.map((t) => t.data), remotes: remotes ?? null });
  // one script per group; top-level bindings are per-run, so the
  // outcome lives on a per-run global name
  const tag = `o${++runCounter}`;
  const source = `
    var ${tag} = null;
    {
      const G = JSON.parse(${JSON.stringify(payload)});
      let compiled = null;
      try {
        compiled = Schema.compile(G.schema, { dialect: ${JSON.stringify(draft.dialect)}, formats: ${JSON.stringify(formats)}, schemas: G.remotes === null ? undefined : G.remotes });
      } catch (e) {
        ${tag} = 'compile:' + e.name + ':' + e.message;
      }
      if (compiled !== null) {
        ${tag} = G.tests.map((data) => {
          try { return [compiled.test(data), compiled.validate(data).valid]; }
          catch (e) { return 'threw:' + e.name + ':' + e.message; }
        });
      }
    }
  `;
  parseAndSetup(session, source);
  runToCompletion(session, grant);
  return session.get(0, tag);
}

// Host and builtin verdict streams must agree: identical boolean pairs,
// and a decline on one side is a decline on the other.
function agree(host, builtin) {
  if (typeof host === 'string' || typeof builtin === 'string') {
    return typeof host === 'string' && typeof builtin === 'string';
  }
  if (host.length !== builtin.length) return false;
  for (let i = 0; i < host.length; i++) {
    const a = host[i], b = builtin[i];
    if (typeof a === 'string' || typeof b === 'string') {
      if (!(typeof a === 'string' && typeof b === 'string')) return false;
      continue;
    }
    if (a[0] !== b[0] || a[1] !== b[1]) return false;
  }
  return true;
}

async function runDraft(draft, grant) {
  const engine = createSchemaEngine();
  const remotes = await loadRemotes(draft.dir);
  const base = new URL('tests/' + draft.dir + '/', ROOT);
  const mismatches = [];
  let groups = 0;
  for await (const file of files(base)) {
    const name = relative(file, base);
    const corpus = JSON.parse(await Deno.readTextFile(file));
    const session = freshSession(SESSION_OPTIONS);
    for (const group of corpus) {
      groups++;
      const formats = name === 'format.json' ? 'annotate' : 'assert';
      const text = JSON.stringify(group.schema);
      const needsRemotes = text.includes('localhost:1234') || text.includes('json-schema.org/draft');
      const bundle = needsRemotes ? remotes : undefined;
      const host = hostVerdicts(engine, group, draft, bundle, formats);
      const builtin = builtinVerdicts(session, group, draft, bundle, formats, grant);
      if (!agree(host, builtin)) {
        mismatches.push(`${name} / ${group.description}: host=${JSON.stringify(host)} builtin=${JSON.stringify(builtin)}`);
      }
    }
  }
  return { groups, mismatches };
}

for (const draft of DRAFTS) {
  Deno.test(`Schema builtin agrees with the host binding: ${draft.dir}`, async () => {
    const { groups, mismatches } = await runDraft(draft, 1_000_000);
    console.log(`\n${draft.dir}: ${groups} groups, ${mismatches.length} mismatches`);
    for (const line of mismatches.slice(0, 40)) console.log(`  ! ${line}`);
    assertEquals(mismatches.length, 0, `${draft.dir}: builtin/host verdict mismatches`);
  });
}

Deno.test('Schema builtin: tiny fuel grants pause and resume every operation', async () => {
  const draft = DRAFTS[0];
  const engine = createSchemaEngine();
  const base = new URL('tests/' + draft.dir + '/', ROOT);
  const session = freshSession(SESSION_OPTIONS);
  const mismatches = [];
  for (const name of ['properties.json', 'ref.json', 'unevaluatedProperties.json', 'pattern.json']) {
    const corpus = JSON.parse(await Deno.readTextFile(new URL(name, base)));
    for (const group of corpus) {
      const host = hostVerdicts(engine, group, draft, undefined, 'assert');
      const builtin = builtinVerdicts(session, group, draft, undefined, 'assert', 7);
      if (!agree(host, builtin)) mismatches.push(`${name} / ${group.description}`);
    }
  }
  assertEquals(mismatches, []);
});

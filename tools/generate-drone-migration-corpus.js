#!/usr/bin/env -S deno run --allow-read --allow-write --allow-run

// The exact commit that writes each aggregate version (docs/operations/
// persisted-format-cutover.md "Aggregate version history").
const SOURCE_COMMITS = {
  1: '0330c1a882b9b440803bd59b359a72dfc6fa4cb6',
  2: '156b91b83fe857587da9cb534524e45ea174b5f2',
};

const args = new Map();
for (let index = 0; index < Deno.args.length; index += 2) {
  args.set(Deno.args[index], Deno.args[index + 1]);
}
const sourceWorktree = args.get('--source-worktree');
const outputRoot = args.get('--out');
const sourceVersionArg = Number(args.get('--version') ?? 1);
if (!sourceWorktree || !outputRoot || Deno.args.length < 4 || Deno.args.length > 6) {
  throw new Error(
    'usage: generate-drone-migration-corpus.js ' +
    '--source-worktree <version-N-worktree> --out <directory> [--version N]');
}
const EXPECTED_SOURCE_COMMIT = SOURCE_COMMITS[sourceVersionArg];
if (!EXPECTED_SOURCE_COMMIT) {
  throw new Error(`no source commit recorded for aggregate version ${sourceVersionArg}`);
}

const revisionCommand = new Deno.Command('git', {
  args: ['-C', sourceWorktree, 'rev-parse', 'HEAD'],
  stdout: 'piped',
  stderr: 'piped',
});
const revisionResult = await revisionCommand.output();
if (!revisionResult.success) {
  throw new Error(new TextDecoder().decode(revisionResult.stderr).trim());
}
const sourceCommit = new TextDecoder().decode(revisionResult.stdout).trim();
if (sourceCommit !== EXPECTED_SOURCE_COMMIT) {
  throw new Error(
    `source worktree is ${sourceCommit}; expected ${EXPECTED_SOURCE_COMMIT}`);
}

const sourceRoot = new URL(`file://${sourceWorktree.replaceAll(' ', '%20')}/`);
const { DRONE_FORMAT_VERSION: sourceFormatVersion } =
  await import(new URL('src/persisted-format.js', sourceRoot).href);
if (sourceFormatVersion !== sourceVersionArg) {
  throw new Error(
    `source commit declares aggregate drone format ${sourceFormatVersion}; expected ${sourceVersionArg}`);
}
const {
  freshSession,
  snapshotSession,
} = await import(new URL('src/host-owned-session.js', sourceRoot).href);

await Deno.mkdir(outputRoot, { recursive: true });
const cases = [];
async function writeCompressed(path, bytes) {
  const stream = new Blob([bytes]).stream().pipeThrough(new CompressionStream('gzip'));
  await Deno.writeFile(path, new Uint8Array(await new Response(stream).arrayBuffer()));
}

for (const definition of [
  {
    name: 'empty',
    options: {},
    source: null,
    expectedValue: null,
  },
  {
    name: 'executed-inline-source',
    options: {
      inlineSource: true,
      astRegionSize: 16 * 1024,
      stepRingSize: 4096,
      headerEventRingSize: 4096,
    },
    source: 'let migrationValue = 40 + 2;',
    expectedValue: 42,
  },
]) {
  const session = freshSession(definition.options);
  let runStatus = null;
  if (definition.source !== null) {
    session.parse(definition.source);
    const result = session.run(0, 1_000_000);
    runStatus = result.status;
    if (runStatus !== 'done') {
      throw new Error(`${definition.name}: expected done, got ${runStatus}`);
    }
    const value = session.get(0, 'migrationValue');
    if (value !== definition.expectedValue) {
      throw new Error(
        `${definition.name}: expected value ${definition.expectedValue}, got ${value}`);
    }
  }
  const snapshot = snapshotSession(session);
  const caseRoot = `${outputRoot}/${definition.name}`;
  await Deno.mkdir(caseRoot);
  await writeCompressed(`${caseRoot}/vat.bin.gz`, snapshot.vatBytes);
  await writeCompressed(`${caseRoot}/membrane.bin.gz`, snapshot.membraneBytes);
  await Deno.writeTextFile(
    `${caseRoot}/expectations.json`,
    JSON.stringify({
      source: definition.source,
      expectedValue: definition.expectedValue,
      runStatus,
    }, null, 2) + '\n',
  );
  cases.push({ name: definition.name, options: definition.options });
}

await Deno.writeTextFile(
  `${outputRoot}/manifest.json`,
  JSON.stringify({
    contractVersion: 1,
    sourceCommit,
    sourceFormatVersion,
    targetFormatVersion: sourceFormatVersion + 1,
    cases,
  }, null, 2) + '\n',
);
console.log(JSON.stringify({
  recordKind: 'sandscript/drone-migration-corpus-generated',
  sourceCommit,
  sourceFormatVersion,
  targetFormatVersion: sourceFormatVersion + 1,
  caseCount: cases.length,
}));

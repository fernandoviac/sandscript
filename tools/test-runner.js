// Custom test runner for sandscript. It emits structured, jq-queryable
// output for AI-agent consumption.
//
// Output (always both — file is written even when stdout is piped):
//   stdout                — NDJSON. One {kind:"test",...} line per test, then
//                           one final {kind:"summary",...} line with totals.
//   .test-results.ndjson  — same NDJSON stream, mirrored to disk.
//   .test-summary.json    — pretty-printed summary, for quick `jq .` access.
//
// Usage:
//   deno task test                        # all tests
//   deno task test path/to/file_test.js   # specific files
//   deno task test --filter resolver      # name/file substring match
//   deno task test --file-shard-index 0 --file-shard-count 8 tests/fuel/
//
// Agent recipes:
//   jq -c 'select(.status=="failed")' .test-results.ndjson
//   jq . .test-summary.json
//   deno task test | jq -c 'select(.status=="failed")'   # live stream
//
// Notes:
//   - Sequential execution. No parallelism, no op/resource sanitizers
//     (intentional — both caused more problems than they solved).
//   - Tests register via Deno.test(name, fn) or Deno.test.ignore(name, fn).
//     Object-form and .only are not supported.
//   - Non-`_test.js` helper files living inside tests/ (e.g.
//     tests/fuel/test-helpers.js) are never picked up — walkTestDir only
//     collects files whose name ends in `_test.js`.

const outputDirectory = Deno.env.get("SANDSCRIPT_TEST_OUTPUT_DIRECTORY") ?? ".";
const RESULTS_PATH = `${outputDirectory}/.test-results.ndjson`;
const SUMMARY_PATH = `${outputDirectory}/.test-summary.json`;

const args = Deno.args;
let filter = null;
let shardIndex = null;
let shardCount = null;
let fileShardIndex = null;
let fileShardCount = null;
const excludedFiles = new Set();
const includedTestShards = new Map();
const excludedTestNames = new Set();
const explicitFiles = [];
for (let argumentIndex = 0; argumentIndex < args.length; argumentIndex++) {
  if (args[argumentIndex] === "--filter") {
    filter = args[++argumentIndex];
  } else if (args[argumentIndex] === "--shard-index") {
    shardIndex = Number(args[++argumentIndex]);
  } else if (args[argumentIndex] === "--shard-count") {
    shardCount = Number(args[++argumentIndex]);
  } else if (args[argumentIndex] === "--file-shard-index") {
    fileShardIndex = Number(args[++argumentIndex]);
  } else if (args[argumentIndex] === "--file-shard-count") {
    fileShardCount = Number(args[++argumentIndex]);
  } else if (args[argumentIndex] === "--exclude-file") {
    excludedFiles.add(args[++argumentIndex]);
  } else if (args[argumentIndex] === "--include-test-shard") {
    const file = args[++argumentIndex];
    const index = Number(args[++argumentIndex]);
    const count = Number(args[++argumentIndex]);
    if (includedTestShards.has(file)) {
      throw new Error(`test shard file selected more than once: ${file}`);
    }
    includedTestShards.set(file, { index, count });
  } else if (args[argumentIndex] === "--exclude-test-name") {
    const name = args[++argumentIndex];
    if (!name || excludedTestNames.has(name)) {
      throw new Error(`test name excluded more than once: ${name}`);
    }
    excludedTestNames.add(name);
  } else {
    explicitFiles.push(args[argumentIndex]);
  }
}
if (
  !Number.isInteger(shardIndex) ||
  !Number.isInteger(shardCount) ||
  shardIndex < 0 ||
  shardCount < 1 ||
  shardIndex >= shardCount
) {
  if (shardIndex !== null || shardCount !== null) {
    throw new Error(
      "--shard-index and --shard-count must select one zero-based shard",
    );
  }
}
if (
  !Number.isInteger(fileShardIndex) ||
  !Number.isInteger(fileShardCount) ||
  fileShardIndex < 0 ||
  fileShardCount < 1 ||
  fileShardIndex >= fileShardCount
) {
  if (fileShardIndex !== null || fileShardCount !== null) {
    throw new Error(
      "--file-shard-index and --file-shard-count must select one zero-based file shard",
    );
  }
}
if (shardIndex !== null && fileShardIndex !== null) {
  throw new Error("test shards and file shards cannot be combined");
}
for (const [file, selection] of includedTestShards) {
  if (
    !file ||
    !Number.isInteger(selection.index) ||
    !Number.isInteger(selection.count) ||
    selection.index < 0 ||
    selection.count < 1 ||
    selection.index >= selection.count
  ) {
    throw new Error(
      "--include-test-shard must select one zero-based shard from one file",
    );
  }
}

async function listTestFiles() {
  const files = [];
  if (explicitFiles.length === 0) {
    await walkTestDir("tests", files);
  } else {
    for (const path of explicitFiles) {
      const normalizedPath = path.replace(/\/+$/, "");
      const information = await Deno.stat(normalizedPath);
      if (information.isDirectory) {
        await walkTestDir(normalizedPath, files);
      } else if (information.isFile && normalizedPath.endsWith("_test.js")) {
        files.push(normalizedPath);
      } else {
        throw new Error(
          `test input is not a test file or directory: ${normalizedPath}`,
        );
      }
    }
  }
  files.sort();
  for (let fileIndex = 1; fileIndex < files.length; fileIndex++) {
    if (files[fileIndex] === files[fileIndex - 1]) {
      throw new Error(`test file selected more than once: ${files[fileIndex]}`);
    }
  }
  for (const excludedFile of excludedFiles) {
    if (!files.includes(excludedFile)) {
      throw new Error(`excluded test file was not selected: ${excludedFile}`);
    }
  }
  const includedFiles = files.filter((file) => !excludedFiles.has(file));
  const selectedFiles = fileShardCount === null
    ? includedFiles
    : includedFiles.slice(
      fileShardIndex * Math.ceil(includedFiles.length / fileShardCount),
      (fileShardIndex + 1) * Math.ceil(includedFiles.length / fileShardCount),
    );
  for (const file of includedTestShards.keys()) {
    if (!excludedFiles.has(file)) {
      throw new Error(`included test shard file was not excluded: ${file}`);
    }
    selectedFiles.push(file);
  }
  selectedFiles.sort();
  return selectedFiles;
}

async function walkTestDir(dir, out) {
  for await (const entry of Deno.readDir(dir)) {
    const path = `${dir}/${entry.name}`;
    if (entry.isFile && entry.name.endsWith("_test.js")) {
      out.push(path);
    } else if (
      entry.isDirectory && entry.name !== "fixtures" && entry.name !== "helpers"
    ) {
      await walkTestDir(path, out);
    }
  }
}

const registry = [];
let currentFile = null;

function register(name, fn, options = {}) {
  registry.push({
    file: currentFile,
    name,
    fn,
    ignored: options.ignored ?? false,
  });
}

const fakeDenoTest = (name, fn) => register(name, fn, { ignored: false });
fakeDenoTest.ignore = (name, fn) => register(name, fn, { ignored: true });
fakeDenoTest.only = () => {
  throw new Error("Deno.test.only is not supported by this runner");
};

const realDenoTest = Deno.test;
Deno.test = fakeDenoTest;

const files = await listTestFiles();

for (const file of files) {
  currentFile = file;
  try {
    await import(`${Deno.cwd()}/${file}`);
  } catch (err) {
    registry.push({
      file,
      name: "<module load>",
      fn: null,
      ignored: false,
      loadError: err,
    });
  }
}
currentFile = null;
Deno.test = realDenoTest;

for (const excludedTestName of excludedTestNames) {
  const matchCount = registry.filter((test) =>
    test.name === excludedTestName
  ).length;
  if (matchCount !== 1) {
    throw new Error(
      `excluded test name must match exactly once: ${excludedTestName} matched ${matchCount}`,
    );
  }
}
const eligible = registry.filter((test) => !excludedTestNames.has(test.name));
const filtered = filter
  ? eligible.filter((test) =>
    test.name.includes(filter) || test.file.includes(filter)
  )
  : eligible;
const selectedTestCounts = new Map();
const partitioned = filtered.filter((test) => {
  const selection = includedTestShards.get(test.file);
  if (!selection) return true;
  const testIndex = selectedTestCounts.get(test.file) ?? 0;
  selectedTestCounts.set(test.file, testIndex + 1);
  return testIndex % selection.count === selection.index;
});
const selectedTests = shardCount === null
  ? partitioned
  : partitioned.filter((_, testIndex) => testIndex % shardCount === shardIndex);
// The runner writes ONLY NDJSON to stdout. We route the real stdout writer
// through a captured handle and silence console.* during test execution so
// nothing else can pollute the structured stream — captured console output
// gets attached to its test's NDJSON record instead.
const realStdoutWrite = Deno.stdout.write.bind(Deno.stdout);
const encoder = new TextEncoder();
const resultsFile = await Deno.open(RESULTS_PATH, {
  write: true,
  create: true,
  truncate: true,
});

async function emit(obj) {
  const bytes = encoder.encode(JSON.stringify(obj) + "\n");
  await realStdoutWrite(bytes);
  await resultsFile.write(bytes);
}

function formatError(err) {
  if (!err) return null;
  if (err instanceof Error) {
    return {
      name: err.name,
      message: err.message,
      stack: err.stack ?? null,
    };
  }
  return { name: "NonError", message: String(err), stack: null };
}

let captureStdout = [];
let captureStderr = [];

function formatArgs(args) {
  return args
    .map((
      a,
    ) => (typeof a === "string" ? a : Deno.inspect(a, { colors: false })))
    .join(" ");
}

console.log = (...a) => {
  captureStdout.push(formatArgs(a));
};
console.info = (...a) => {
  captureStdout.push(formatArgs(a));
};
console.debug = (...a) => {
  captureStdout.push(formatArgs(a));
};
console.error = (...a) => {
  captureStderr.push(formatArgs(a));
};
console.warn = (...a) => {
  captureStderr.push(formatArgs(a));
};

const totals = { total: 0, passed: 0, failed: 0, ignored: 0, errored: 0 };
const fileTotals = new Map();

function bumpFile(file, key) {
  let row = fileTotals.get(file);
  if (!row) {
    row = {
      file,
      total: 0,
      passed: 0,
      failed: 0,
      ignored: 0,
      errored: 0,
      durationMs: 0,
    };
    fileTotals.set(file, row);
  }
  row[key]++;
  row.total++;
  return row;
}

const runStart = performance.now();

// Force a GC pass at each test-file boundary. Every Worker-backed test
// leaves WebAssembly.Memory/SharedArrayBuffer backing stores (V8's
// "external" memory) unreclaimed until V8 decides to collect on its
// own — across many sequential test files that adds up to a very large
// deferred collection, and if that automatic pass happens to land
// inside a resource-heavy test (many concurrent Workers spawning at
// once) the two contend and the test hangs until its own timeout.
// An explicit gc() between files keeps external memory bounded instead of
// deferring one large collection into a resource-heavy test. The call requires
// --v8-flags=--expose-gc, which is wired into the `test` task.
let lastGcFile = null;

for (const t of selectedTests) {
  if (t.file !== lastGcFile) {
    if (typeof gc === "function") gc();
    lastGcFile = t.file;
  }
  totals.total++;

  if (t.loadError) {
    totals.errored++;
    bumpFile(t.file, "errored");
    await emit({
      kind: "test",
      file: t.file,
      name: t.name,
      status: "errored",
      durationMs: 0,
      error: formatError(t.loadError),
      stdout: [],
      stderr: [],
    });
    continue;
  }

  if (t.ignored) {
    totals.ignored++;
    bumpFile(t.file, "ignored");
    await emit({
      kind: "test",
      file: t.file,
      name: t.name,
      status: "ignored",
      durationMs: 0,
      error: null,
      stdout: [],
      stderr: [],
    });
    continue;
  }

  captureStdout = [];
  captureStderr = [];
  const start = performance.now();
  let error = null;
  let status = "passed";

  try {
    await t.fn();
  } catch (err) {
    error = err;
    status = "failed";
  }

  const durationMs = Math.round((performance.now() - start) * 1000) / 1000;

  if (status === "passed") {
    totals.passed++;
    const row = bumpFile(t.file, "passed");
    row.durationMs += durationMs;
  } else {
    totals.failed++;
    const row = bumpFile(t.file, "failed");
    row.durationMs += durationMs;
  }

  await emit({
    kind: "test",
    file: t.file,
    name: t.name,
    status,
    durationMs,
    error: formatError(error),
    stdout: captureStdout,
    stderr: captureStderr,
  });
}

const totalDurationMs = Math.round((performance.now() - runStart) * 1000) /
  1000;

const summary = {
  kind: "summary",
  ...totals,
  durationMs: totalDurationMs,
  files: [...fileTotals.values()].sort((a, b) => a.file.localeCompare(b.file)),
};

await emit(summary);
resultsFile.close();
await Deno.writeTextFile(SUMMARY_PATH, JSON.stringify(summary, null, 2) + "\n");

Deno.exit(totals.failed + totals.errored === 0 ? 0 : 1);

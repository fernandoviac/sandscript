/**
 * CLI Integration Tests
 *
 * Tests the sand CLI by invoking it as a subprocess and verifying output.
 * Run with: deno task test tests/cli/cli_test.js
 */

import { assertEquals, assertStringIncludes } from "https://deno.land/std@0.208.0/assert/mod.ts";

const CLI_PATH = new URL("../../src/sand/cli.js", import.meta.url).pathname;

// The subprocess overrides HOME (below), which would also move DENO_DIR
// (defaults to $HOME/Library/Caches/deno) into the empty temp home and
// force the CLI's CDN imports to re-download — a hang on a cold cache.
// Pin DENO_DIR to the real, warm cache so only the session directory is
// isolated, not the module cache.
const DENO_DIR = Deno.env.get("DENO_DIR")
  ?? `${Deno.env.get("HOME")}/Library/Caches/deno`;

// The CLI resolves its session directory from HOME (~/.sandscript). Each
// test gets its own temp HOME so sessions never collide — required because
// Deno runs test files in parallel and the CLI's default-session state is
// otherwise a single shared ~/.sandscript that tests would race on.
//
// `sandHome()` creates an isolated home and returns a `sand` bound to it.
// A fresh temp home is already empty, so no separate cleanup step is needed
// before a test.
async function sandHome() {
  const home = await Deno.makeTempDir({ prefix: "sand-cli-test-" });
  return async (...args) => {
    const cmd = new Deno.Command("deno", {
      args: ["run", "--allow-all", CLI_PATH, ...args],
      env: { HOME: home, USERPROFILE: home, DENO_DIR },
      stdout: "piped",
      stderr: "piped",
    });
    const { code, stdout, stderr } = await cmd.output();
    return {
      code,
      stdout: new TextDecoder().decode(stdout).trim(),
      stderr: new TextDecoder().decode(stderr).trim(),
    };
  };
}

// =============================================================================
// Basic Commands
// =============================================================================

Deno.test("CLI: --version", async () => {
  const sand = await sandHome();
  const { stdout } = await sand("--version");
  assertStringIncludes(stdout, "sand");
});

Deno.test("CLI: --help", async () => {
  const sand = await sandHome();
  const { stdout } = await sand("--help");
  assertStringIncludes(stdout, "Usage:");
  assertStringIncludes(stdout, "script");
  assertStringIncludes(stdout, "session");
});

// =============================================================================
// Script Execution
// =============================================================================

Deno.test("CLI: script basic", async () => {
  const sand = await sandHome();
  await sand("script", "let x = 10");
  const { stdout } = await sand("get", "x");
  assertEquals(stdout, "10");
});

Deno.test("CLI: script arithmetic", async () => {
  const sand = await sandHome();
  await sand("script", "let x = 10");
  await sand("script", "let y = x * 2 + 5");
  const { stdout } = await sand("get", "y");
  assertEquals(stdout, "25");
});

Deno.test("CLI: script Math functions", async () => {
  const sand = await sandHome();
  await sand("script", "let area = Math.PI * Math.pow(5, 2)");
  const { stdout } = await sand("get", "area");
  assertStringIncludes(stdout, "78.53");
});

Deno.test("CLI: script syntax error", async () => {
  const sand = await sandHome();
  const { code, stderr } = await sand("script", "let x = ");
  assertEquals(code, 1);
  assertStringIncludes(stderr, "Unexpected");
});

// =============================================================================
// Functions Across Sessions
// =============================================================================

Deno.test("CLI: arrow function persists", async () => {
  const sand = await sandHome();
  await sand("script", "let f = (x) => x + 1");
  await sand("script", "let c = f(3)");
  const { stdout } = await sand("get", "c");
  assertEquals(stdout, "4");
});

Deno.test("CLI: named function via arrow", async () => {
  const sand = await sandHome();
  await sand("script", "let double = (x) => x * 2");
  await sand("script", "let result = double(21)");
  const { stdout } = await sand("get", "result");
  assertEquals(stdout, "42");
});

// =============================================================================
// Arrays
// =============================================================================

Deno.test("CLI: array creation and access", async () => {
  const sand = await sandHome();
  await sand("script", "let nums = [1, 2, 3, 4, 5]");
  await sand("script", "let first = nums[0]");
  await sand("script", "let last = nums[4]");

  let { stdout } = await sand("get", "first");
  assertEquals(stdout, "1");

  ({ stdout } = await sand("get", "last"));
  assertEquals(stdout, "5");
});

Deno.test("CLI: array length", async () => {
  const sand = await sandHome();
  await sand("script", "let nums = [1, 2, 3, 4, 5]");
  await sand("script", "let len = nums.length");
  const { stdout } = await sand("get", "len");
  assertEquals(stdout, "5");
});

Deno.test("CLI: array reduce", async () => {
  const sand = await sandHome();
  await sand("script", "let nums = [1, 2, 3, 4, 5]");
  await sand("script", "let sum = nums.reduce((a, b) => a + b, 0)");
  const { stdout } = await sand("get", "sum");
  assertEquals(stdout, "15");
});

Deno.test("CLI: array map", async () => {
  const sand = await sandHome();
  await sand("script", "let nums = [1, 2, 3]");
  await sand("script", "let doubled = nums.map((n) => n * 2)");
  const { stdout } = await sand("get", "doubled");
  assertEquals(stdout, "[2,4,6]");
});

Deno.test("CLI: array filter", async () => {
  const sand = await sandHome();
  await sand("script", "let nums = [1, 2, 3, 4, 5]");
  await sand("script", "let evens = nums.filter((n) => n % 2 === 0)");
  const { stdout } = await sand("get", "evens");
  assertEquals(stdout, "[2,4]");
});

// =============================================================================
// Session Management
// =============================================================================

Deno.test("CLI: session new and list", async () => {
  const sand = await sandHome();
  await sand("session", "new", "test1");
  await sand("session", "new", "test2");
  const { stdout } = await sand("session", "list");
  assertStringIncludes(stdout, "test2"); // Current session
  assertStringIncludes(stdout, "test1");
});

Deno.test("CLI: session use", async () => {
  const sand = await sandHome();
  await sand("session", "new", "first");
  await sand("script", "let x = 100");
  await sand("session", "new", "second");
  await sand("script", "let x = 200");

  // Switch back to first
  await sand("session", "use", "first");
  const { stdout } = await sand("get", "x");
  assertEquals(stdout, "100");
});

Deno.test("CLI: session save-as", async () => {
  const sand = await sandHome();
  await sand("script", "let data = 42");
  await sand("session", "save-as", "backup");

  // Create new session, verify backup still works
  await sand("session", "new", "other");
  await sand("session", "use", "backup");
  const { stdout } = await sand("get", "data");
  assertEquals(stdout, "42");
});

Deno.test("CLI: session save-as persists as current across a fresh process, with no session use in between", async () => {
  const sand = await sandHome();
  await sand("script", "let data = 42");
  await sand("session", "save-as", "forked");

  // No `session use`/`session new` here — a brand new subprocess reads
  // state.json to resolve "current". If save-as didn't persist the
  // switch, this would fall back to whatever was current before the
  // fork (or a new anonymous session) instead of "forked".
  const { stdout: list } = await sand("session", "list");
  assertStringIncludes(list, "* forked");

  const { stdout } = await sand("get", "data");
  assertEquals(stdout, "42");
});

Deno.test("CLI: session rename", async () => {
  const sand = await sandHome();
  await sand("session", "new", "oldname");
  await sand("script", "let x = 1");
  await sand("session", "rename", "newname");

  const { stdout: list } = await sand("session", "list");
  assertStringIncludes(list, "newname");

  // Data still there
  const { stdout } = await sand("get", "x");
  assertEquals(stdout, "1");
});

Deno.test("CLI: session delete", async () => {
  const sand = await sandHome();
  await sand("session", "new", "keep");
  await sand("session", "new", "todelete");
  await sand("session", "use", "keep");
  await sand("session", "delete", "todelete");

  const { stdout } = await sand("session", "list");
  assertStringIncludes(stdout, "keep");
});

Deno.test("CLI: loaded session is read-only", async () => {
  const sand = await sandHome();
  // Create and save a session
  await sand("session", "new", "saved");
  await sand("script", "let original = 1");
  await sand("session", "save");

  // Switch away and back (loads from disk as read-only)
  await sand("session", "new", "other");
  await sand("session", "use", "saved");

  // Add something
  await sand("script", "let ephemeral = 999");

  // Switch away and back - ephemeral should be gone
  await sand("session", "use", "other");
  await sand("session", "use", "saved");

  const { code } = await sand("get", "ephemeral");
  assertEquals(code, 1); // Should fail - ephemeral doesn't persist

  const { stdout } = await sand("get", "original");
  assertEquals(stdout, "1"); // Original should still exist
});

// =============================================================================
// Inspect
// =============================================================================

Deno.test("CLI: inspect state", async () => {
  const sand = await sandHome();
  await sand("script", "let x = 10");
  const { stdout } = await sand("inspect");
  assertStringIncludes(stdout, "status:");
  assertStringIncludes(stdout, "done");
});

Deno.test("CLI: inspect scope", async () => {
  const sand = await sandHome();
  await sand("script", "let x = 10");
  await sand("script", "let y = 20");
  const { stdout } = await sand("inspect", "scope");
  assertStringIncludes(stdout, "x = 10");
  assertStringIncludes(stdout, "y = 20");
});

// =============================================================================
// Step/Debug
// =============================================================================

Deno.test("CLI: step load and resume", async () => {
  const sand = await sandHome();
  const loadResult = await sand("step", "let a = 1; let b = 2; let c = a + b");

  // Should report loaded
  assertEquals(loadResult.stdout, "loaded");

  // Resume
  await sand("step");

  // Should be done
  let { stdout } = await sand("inspect");
  assertStringIncludes(stdout, "done");

  // Variable should exist
  ({ stdout } = await sand("get", "c"));
  assertEquals(stdout, "3");
});

Deno.test("CLI: step with fuel limit", async () => {
  const sand = await sandHome();
  await sand("step", "let x = 1; let y = 2; let z = 3");
  await sand("step", "2"); // Run 2 steps

  let { stdout } = await sand("inspect");
  assertStringIncludes(stdout, "paused"); // Should still be paused

  await sand("step"); // Run to completion

  ({ stdout } = await sand("inspect"));
  assertStringIncludes(stdout, "done");
});

Deno.test("CLI: step resume reports consumed fuel (not undefined)", async () => {
  const sand = await sandHome();
  // Load a few instructions, then resume with a fuel budget. The resume
  // branch prints JSON {status, fuelUsed}; fuelUsed must be the consumed
  // count (budget - remaining), not undefined.
  await sand("step", "let a = 1; let b = 2; let c = a + b");
  const { stdout } = await sand("step", "1000");

  const parsed = JSON.parse(stdout);
  assertEquals(parsed.status, "done");
  assertEquals(typeof parsed.fuelUsed, "number");
  // The program runs several instructions, so consumption is positive
  // and well under the 1000 budget.
  assertEquals(parsed.fuelUsed > 0 && parsed.fuelUsed < 1000, true);
});

Deno.test("CLI: step resume mid-program reports partial consumed fuel", async () => {
  const sand = await sandHome();
  // Load, then resume with a tiny budget that can't finish — status is
  // paused and fuelUsed equals the budget that was burned.
  await sand("step", "let x = 1; let y = 2; let z = 3; let w = x + y + z");
  const { stdout } = await sand("step", "2");

  const parsed = JSON.parse(stdout);
  assertEquals(parsed.status, "paused");
  assertEquals(parsed.fuelUsed, 2);
});

// =============================================================================
// File Execution
// =============================================================================

Deno.test("CLI: run file", async () => {
  const sand = await sandHome();

  // Create temp file
  const tempFile = await Deno.makeTempFile({ suffix: ".ss" });
  await Deno.writeTextFile(tempFile, `
let a = 10
let b = 20
let sum = a + b
`);

  await sand(tempFile);
  const { stdout } = await sand("get", "sum");
  assertEquals(stdout, "30");

  await Deno.remove(tempFile);
});

Deno.test("CLI: run file with shebang", async () => {
  const sand = await sandHome();

  const tempFile = await Deno.makeTempFile({ suffix: ".ss" });
  await Deno.writeTextFile(tempFile, `#!/usr/bin/env sand
let magic = 42
`);

  await sand(tempFile);
  const { stdout } = await sand("get", "magic");
  assertEquals(stdout, "42");

  await Deno.remove(tempFile);
});

// =============================================================================
// Verbose and Save Flags
// =============================================================================

Deno.test("CLI: --verbose flag", async () => {
  const sand = await sandHome();
  const { stdout } = await sand("script", "let x = 10", "--verbose");
  assertStringIncludes(stdout, "x = 10");
});

// =============================================================================
// Get Command
// =============================================================================

Deno.test("CLI: get lists all variables", async () => {
  const sand = await sandHome();
  await sand("script", "let a = 1");
  await sand("script", "let b = 2");
  await sand("script", "let c = 3");
  const { stdout } = await sand("get");
  assertStringIncludes(stdout, "a");
  assertStringIncludes(stdout, "b");
  assertStringIncludes(stdout, "c");
});

Deno.test("CLI: get undefined variable", async () => {
  const sand = await sandHome();
  const { code, stderr } = await sand("get", "nonexistent");
  assertEquals(code, 1);
  assertStringIncludes(stderr, "undefined");
});

Deno.test("CLI: get reports the current session name on stderr, not mixed into stdout's variable list", async () => {
  const sand = await sandHome();
  await sand("script", "let a = 1");
  await sand("session", "new", "named-session");
  await sand("script", "let b = 2");
  const { stdout, stderr } = await sand("get");
  assertStringIncludes(stderr, "session: named-session");
  assertEquals(stdout.includes("session:"), false);
  assertStringIncludes(stdout, "b");
});

// =============================================================================
// get's output is real JSON, not a pretty-printer's display syntax
// =============================================================================

Deno.test("CLI: get emits real JSON for arrays and objects (parseable, no display syntax)", async () => {
  const sand = await sandHome();
  await sand("script", "let obj = {a: 1, b: [1, 2, 3]}");
  const { stdout } = await sand("get", "obj");
  assertEquals(JSON.parse(stdout), { a: 1, b: [1, 2, 3] });
});

Deno.test("CLI: get tags BigInt as {$bigint} since JSON has no native arbitrary-precision integer", async () => {
  const sand = await sandHome();
  await sand("script", "let big = 99999999999999999999n");
  const { stdout } = await sand("get", "big");
  assertEquals(JSON.parse(stdout), { $bigint: "99999999999999999999" });
});

Deno.test("CLI: get on a Rational recurses through the tagged {kind} shape, reaching nested BigInts", async () => {
  const sand = await sandHome();
  await sand("script", "let r = Exact.rational(1n, 3n)");
  const { stdout } = await sand("get", "r");
  assertEquals(JSON.parse(stdout), {
    kind: "rational",
    numerator: { $bigint: "1" },
    denominator: { $bigint: "3" },
  });
});

// =============================================================================
// Runtime error handling (session.run() throws UncaughtScriptError for
// synchronous top-level errors instead of returning {status: 'error'} —
// scriptCommand must catch it and print a clean message, not crash with
// a raw stack trace).
// =============================================================================

Deno.test("CLI: script runtime error exits 1 with a clean message, not a raw stack trace", async () => {
  const sand = await sandHome();
  const { code, stderr } = await sand("script", "let x = undefinedVariable + 1");
  assertEquals(code, 1);
  assertStringIncludes(stderr, "undefinedVariable");
  assertEquals(stderr.includes("UncaughtScriptError"), false);
  assertEquals(stderr.includes("at Object.run"), false);
});

Deno.test("CLI: session stays usable for later scripts after a runtime error", async () => {
  const sand = await sandHome();
  await sand("script", "let a = 1");
  const { code } = await sand("script", "let x = undefinedVariable + 1");
  assertEquals(code, 1);

  // The session is not corrupted by the prior error — both the earlier
  // variable and a brand new one still work normally.
  const { stdout: aValue } = await sand("get", "a");
  assertEquals(aValue, "1");

  await sand("script", "let b = 2");
  const { stdout: bValue } = await sand("get", "b");
  assertEquals(bValue, "2");
});

// =============================================================================
// Error Handling
// =============================================================================

Deno.test("CLI: unknown command", async () => {
  const sand = await sandHome();
  const { code, stderr } = await sand("unknowncommand");
  assertEquals(code, 1);
  assertStringIncludes(stderr, "Unknown command");
});

Deno.test("CLI: script without code", async () => {
  const sand = await sandHome();
  const { code, stderr } = await sand("script");
  assertEquals(code, 1);
  assertStringIncludes(stderr, "Usage");
});

// =============================================================================
// Check Command (syntax + structural checks)
// =============================================================================

Deno.test("CLI: check valid file exits 0 with no output", async () => {
  const sand = await sandHome();
  const tempFile = await Deno.makeTempFile({ suffix: ".ss" });
  await Deno.writeTextFile(tempFile, "let x = 10\nlet y = x * 2\ny\n");

  const { code, stdout, stderr } = await sand("check", tempFile);
  assertEquals(code, 0);
  assertEquals(stdout, "");
  assertEquals(stderr, "");

  await Deno.remove(tempFile);
});

Deno.test("CLI: check invalid file exits 1 with line/column", async () => {
  const sand = await sandHome();
  const tempFile = await Deno.makeTempFile({ suffix: ".ss" });
  await Deno.writeTextFile(tempFile, "let x = (10\n");

  const { code, stderr } = await sand("check", tempFile);
  assertEquals(code, 1);
  assertStringIncludes(stderr, "line 2, col 1");

  await Deno.remove(tempFile);
});

Deno.test("CLI: check does not run the file", async () => {
  const sand = await sandHome();
  const tempFile = await Deno.makeTempFile({ suffix: ".ss" });
  await Deno.writeTextFile(tempFile, "let x = 10\n");

  await sand("check", tempFile);
  const { code, stderr } = await sand("get", "x");
  assertEquals(code, 1);
  assertStringIncludes(stderr, "undefined");

  await Deno.remove(tempFile);
});

Deno.test("CLI: check missing file", async () => {
  const sand = await sandHome();
  const { code, stderr } = await sand("check", "/nonexistent/path/file.ss");
  assertEquals(code, 1);
  assertStringIncludes(stderr, "cannot read");
});

Deno.test("CLI: check without file argument", async () => {
  const sand = await sandHome();
  const { code, stderr } = await sand("check");
  assertEquals(code, 1);
  assertStringIncludes(stderr, "Usage");
});

Deno.test("CLI: check reports unused-binding as a structural finding", async () => {
  const sand = await sandHome();
  const tempFile = await Deno.makeTempFile({ suffix: ".ss" });
  await Deno.writeTextFile(tempFile, "let x = 1\n");

  const { code, stderr } = await sand("check", tempFile);
  assertEquals(code, 1);
  assertStringIncludes(stderr, "unused-binding");
  assertStringIncludes(stderr, "'x'");

  await Deno.remove(tempFile);
});

Deno.test("CLI: check reports const-reassignment as a structural finding", async () => {
  const sand = await sandHome();
  const tempFile = await Deno.makeTempFile({ suffix: ".ss" });
  await Deno.writeTextFile(tempFile, "const x = 1\nx = 2\nx\n");

  const { code, stderr } = await sand("check", tempFile);
  assertEquals(code, 1);
  assertStringIncludes(stderr, "const-reassignment");

  await Deno.remove(tempFile);
});

Deno.test("CLI: check stops at the parse error and does not run structural checks on unparseable code", async () => {
  const sand = await sandHome();
  const tempFile = await Deno.makeTempFile({ suffix: ".ss" });
  await Deno.writeTextFile(tempFile, "let x = (10\n");

  const { code, stderr } = await sand("check", tempFile);
  assertEquals(code, 1);
  assertStringIncludes(stderr, "line 2, col 1");
  // Only the parse error is reported — no structural findings mixed in.
  assertEquals(stderr.includes("unused-binding"), false);

  await Deno.remove(tempFile);
});

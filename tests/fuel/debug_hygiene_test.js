/**
 * Production / debug hygiene check.
 *
 * `src/fuel/debug.js` is a debug-only module. Production source files must
 * not import it or reference `createDebug`. This test walks the production
 * source tree and fails on any production file that touches the debug
 * surface.
 *
 * Production = anything under `src/` that does NOT carry a
 * `// debug-only` opt-in header on its first non-comment line.
 *
 * Exempt: tests (under `tests/`) and the Debug module itself.
 */

import { assert } from "https://deno.land/std@0.208.0/assert/mod.ts";
import { walk } from "https://deno.land/std@0.208.0/fs/walk.ts";

const SRC_ROOT = new URL('../../src/', import.meta.url).pathname;

// Files that are allowed to reference the debug surface even though
// they live under src/. Each must carry a `// debug-only` header
// comment on its first non-blank line; this list is just the set of
// expected debug-only modules.
const KNOWN_DEBUG_ONLY = new Set([
  'src/fuel/debug.js',
]);

function isDebugOnlyFile(content) {
  // First non-blank, non-shebang line must be the marker comment.
  const lines = content.split('\n');
  for (const raw of lines) {
    const line = raw.trim();
    if (line === '' || line.startsWith('#!')) continue;
    return /^\/\/\s*debug-only\b/.test(line);
  }
  return false;
}

Deno.test("hygiene: no production file imports debug.js", async () => {
  const offenders = [];
  for await (const entry of walk(SRC_ROOT, { exts: ['.js'] })) {
    if (!entry.isFile) continue;
    const content = await Deno.readTextFile(entry.path);
    // Path relative to repo root for clearer error messages:
    const rel = entry.path.slice(entry.path.indexOf('/src/') + 1);
    if (KNOWN_DEBUG_ONLY.has(rel)) continue;
    if (isDebugOnlyFile(content)) continue;
    // Look for any reference to the debug module path or to the
    // createDebug entry point. Comments are allowed (the boundary
    // rule is "no runtime reference"), so we scan for `import`
    // statements and unbraced `createDebug` calls specifically.
    const offenses = [];
    if (/import[^;]*['"][^'"]*\/debug\.js['"]/m.test(content)) {
      offenses.push("imports debug.js");
    }
    if (/\bcreateDebug\s*\(/.test(content)) {
      offenses.push("calls createDebug(...)");
    }
    if (offenses.length > 0) {
      offenders.push({ file: rel, offenses });
    }
  }
  assert(
    offenders.length === 0,
    `Production source files must not reference debug-only surfaces.\n` +
    `Each offender either belongs under tests/ or must opt in with a\n` +
    `'// debug-only' header on its first line.\n\n` +
    offenders.map(o =>
      `  ${o.file}:\n    - ${o.offenses.join('\n    - ')}`).join('\n')
  );
});

Deno.test("hygiene: every known debug-only file carries the opt-in header", async () => {
  for (const rel of KNOWN_DEBUG_ONLY) {
    const path = new URL(`../../${rel}`, import.meta.url).pathname;
    const content = await Deno.readTextFile(path);
    assert(isDebugOnlyFile(content),
      `${rel} is listed as a debug-only module but does not carry ` +
      `a '// debug-only' header comment on its first non-blank line.`);
  }
});

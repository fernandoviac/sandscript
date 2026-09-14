/**
 * Region-write-discipline verifier.
 *
 * The fixed vat regions (scratch, error info, builtins) may only be
 * touched through their helper functions ($scratch_ptr,
 * $stamp_error_info / $error_info_code / $error_info_detail /
 * $error_info_instruction_index,
 * $read_builtin). A grep cannot track a raw pointer through locals, so
 * the enforced invariant is address derivation: to write into a region
 * you must first FIND it, and finding it requires mentioning its base
 * name. This tool fails the build when a restricted base name appears
 * anywhere outside its allowlisted functions (or its own global
 * declaration).
 *
 * Residual this cannot catch: a caller passing $scratch_ptr a declared
 * extent smaller than what it then writes. Extents are static one-line
 * declarations adjacent to their stores, reviewed per site; the
 * SCRATCH_MINIMUM_SIZE floor in computeVatLayout bounds the blast
 * radius of a lie to the region itself.
 *
 * Runs as part of `deno task wasm` (imported by build-fuel-wasm.js)
 * and standalone:
 *
 *   deno run --allow-read tools/verify-region-write-discipline.js
 */

const DEFAULT_WAT_PATH = new URL('../src/fuel/interpreter.wat', import.meta.url).pathname;

// Restricted base name → functions allowed to mention it. Every name's
// own `(global $name ...)` declaration is implicitly allowed. Adding a
// function here means it becomes part of a region's trusted surface —
// it must bounds-check (or be read-only like $read_builtin).
const DISCIPLINE = {
  '$STATE_SCRATCH_BASE':    ['scratch_ptr'],
  '$STATE_ERROR_INFO_BASE': ['init_regions'],
  '$STATE_BUILTINS_BASE':   ['init_regions'],
  '$error_info_base':       ['init_regions', 'cached_error_info_base',
                             'stamp_error_info', 'error_info_code', 'error_info_detail',
                             'error_info_instruction_index',
                             // The WAT collector writes a fixed failure record:
                             // [code][detail][phase].
                             'gc_stamp_error_info'],
  '$builtins_base':         ['init_regions', 'cached_builtins_base', 'read_builtin',
                             // The collector forwards builtins-slot string ids
                             // across string compaction; this is a bounded writer.
                             'gc_update_builtin_strings'],
};

/**
 * Scan WAT source text for discipline violations. Pure — no I/O.
 *
 * @param {string} source — full interpreter.wat text
 * @returns {{ violations: Array<{name, line, functionName, text}>,
 *             stale: string[] }}
 *   violations — restricted-name mentions outside the allowlist.
 *   stale — restricted names that never appear at all, or allowlisted
 *   functions that don't exist: the discipline map no longer matches
 *   the WAT and must be updated, not ignored.
 */
export function scanRegionDiscipline(source) {
  const lines = source.split('\n');
  const violations = [];
  const seenNames = new Set();
  const seenFunctions = new Set();

  const matchers = Object.entries(DISCIPLINE).map(([name, allowed]) => ({
    name,
    allowed: new Set(allowed),
    // \$name not followed by a word char (so $error_info_base doesn't
    // match inside $error_info_base_2), and the $ sigil anchors the
    // start (so $cached_error_info_base doesn't match).
    pattern: new RegExp(name.replace(/\$/g, '\\$') + '(?![A-Za-z0-9_])'),
    declaration: new RegExp('\\(global ' + name.replace(/\$/g, '\\$') + '(?![A-Za-z0-9_])'),
  }));

  let currentFunction = null;
  for (let lineIndex = 0; lineIndex < lines.length; lineIndex++) {
    // Strip line comments before matching — prose may name the bases.
    const text = lines[lineIndex].replace(/;;.*$/, '');

    const funcMatch = text.match(/^\s*\(func \$([A-Za-z0-9_]+)/);
    if (funcMatch) {
      currentFunction = funcMatch[1];
      seenFunctions.add(funcMatch[1]);
    }

    for (const { name, allowed, pattern, declaration } of matchers) {
      if (!pattern.test(text)) continue;
      seenNames.add(name);
      if (declaration.test(text)) continue;
      if (currentFunction !== null && allowed.has(currentFunction)) continue;
      violations.push({
        name,
        line: lineIndex + 1,
        functionName: currentFunction,
        text: lines[lineIndex].trim(),
      });
    }
  }

  const stale = [];
  for (const [name, allowed] of Object.entries(DISCIPLINE)) {
    if (!seenNames.has(name)) {
      stale.push(`restricted name ${name} never appears — discipline map is stale`);
    }
    for (const functionName of allowed) {
      if (!seenFunctions.has(functionName)) {
        stale.push(`allowlisted function $${functionName} (for ${name}) does not exist — discipline map is stale`);
      }
    }
  }

  return { violations, stale };
}

/**
 * Verify the real WAT and report to the console.
 *
 * @param {object} [options]
 * @param {string} [options.watPath] — override the WAT file (tests).
 * @returns {{ ok: boolean, violations: Array, stale: string[] }}
 */
export async function verifyRegionWriteDiscipline({ watPath = DEFAULT_WAT_PATH } = {}) {
  const source = await Deno.readTextFile(watPath);
  const { violations, stale } = scanRegionDiscipline(source);
  const ok = violations.length === 0 && stale.length === 0;

  if (!ok) {
    console.error('Region-write-discipline verification FAILED.');
    for (const violation of violations) {
      console.error(
        `  VIOLATION  ${watPath}:${violation.line}  ${violation.name} referenced ` +
        `${violation.functionName ? `in $${violation.functionName}` : 'at top level'} — ` +
        `only ${DISCIPLINE[violation.name].map((f) => '$' + f).join(', ')} may touch this region.\n` +
        `             ${violation.text}`);
    }
    for (const message of stale) {
      console.error(`  STALE      ${message}`);
    }
  }

  return { ok, violations, stale };
}

if (import.meta.main) {
  const report = await verifyRegionWriteDiscipline();
  if (report.ok) {
    console.log(
      `Region write discipline OK: ${Object.keys(DISCIPLINE).length} region base names ` +
      `confined to their helper functions.`);
  }
  Deno.exit(report.ok ? 0 : 1);
}

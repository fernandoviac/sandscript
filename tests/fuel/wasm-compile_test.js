/**
 * Quick test to verify WASM compiles correctly after changes.
 *
 * Run with: deno task test tests/fuel/wasm-compile_test.js
 */

import { assert, assertEquals, assertExists, assertThrows } from "https://deno.land/std@0.208.0/assert/mod.ts";
import { instantiateSync, compileModule, instantiateFromModule } from '../../src/fuel/index.js';

Deno.test("WASM: instantiates successfully", () => {
  const memory = new WebAssembly.Memory({ initial: 16, maximum: 256, shared: true });
  const wasm = instantiateSync(memory);
  assertExists(wasm);
  assertExists(wasm.exports);
});

Deno.test("WASM: exports expected functions", () => {
  const memory = new WebAssembly.Memory({ initial: 16, maximum: 256, shared: true });
  const wasm = instantiateSync(memory);
  const exports = Object.keys(wasm.exports);
  assert(exports.length > 0, "Should have exports");
  assert(exports.includes("run"), "Should export run function");
});

Deno.test("WASM: statically imports the regex engine", async () => {
  const module = await compileModule();
  const regexImports = WebAssembly.Module.imports(module)
    .filter((entry) => entry.module === 'regex');
  const names = regexImports.map((entry) => entry.name).sort();
  assertEquals(names, [
    'continuation_size',
    'emission_workspace_size',
    'emit_pattern',
    'initialize_emission_workspace',
    'initialize_match',
    'initialize_program_emission',
    'measured_program_size',
    'run_match',
    'scan_pattern',
    'scan_workspace_size',
    'validate_program',
  ]);
  assert(
    regexImports.every((entry) => entry.kind === 'function'),
    'regex imports must all be functions',
  );
  // Construction refuses an import object without the engine. A missing
  // namespace surfaces as TypeError, a missing function as LinkError;
  // either way construction is loud.
  const memory = new WebAssembly.Memory({ initial: 16, maximum: 256, shared: true });
  assertThrows(() => new WebAssembly.Instance(module, { env: { memory } }));
  assertThrows(
    () => new WebAssembly.Instance(module, { env: { memory }, regex: {}, schema: {} }),
    WebAssembly.LinkError,
  );
  // The schema engine is a second static import namespace.
  const schemaImports = WebAssembly.Module.imports(module);
  assert(
    schemaImports.some((entry) => entry.module === 'schema' && entry.name === 'run_validation'),
    'the interpreter statically imports the schema engine',
  );
  // The precompiled-module path wires the engine automatically.
  const wasm = instantiateFromModule(module, memory);
  assertExists(wasm.exports.run);
});

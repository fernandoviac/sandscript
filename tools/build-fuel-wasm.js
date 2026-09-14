/**
 * Build script for fuel-based interpreter WASM module.
 *
 * Compiles interpreter.wat → interpreter.wasm → interpreter.wasm.js (base64)
 *
 * Usage:
 *   deno run --allow-read --allow-write --allow-run tools/build-fuel-wasm.js
 */

import { verifyLayoutConstants } from './verify-layout-constants.js';
import { verifyRegionWriteDiscipline } from './verify-region-write-discipline.js';

const FUEL_DIR = new URL('../src/fuel/', import.meta.url).pathname;
const WAT_PATH = `${FUEL_DIR}interpreter.wat`;
const PROOF_KERNEL_WAT_PATH = `${FUEL_DIR}proof-kernel.wat`;
const PROOF_RECURSORS_WAT_PATH = `${FUEL_DIR}proof-recursors.wat`;
const PROOF_CORE_DATA_WAT_PATH = `${FUEL_DIR}proof-core-data.wat`;
const PROOF_LITERAL_DATA_WAT_PATH = `${FUEL_DIR}proof-literal-data.wat`;
const PROOF_ARTIFACT_CHECK_WAT_PATH = `${FUEL_DIR}proof-artifact-check.wat`;
const PROOF_NATIVE_RUNTIME_WAT_PATH = `${FUEL_DIR}proof-native-runtime.wat`;
const PROOF_NATIVE_CONTINUATION_WAT_PATH = `${FUEL_DIR}proof-native-continuation.wat`;
const PROOF_WORK_EXPANDED_WAT_PATH = `${FUEL_DIR}proof-work-expanded.wat`;
const PROOF_NATIVE_BUILDERS_WAT_PATH = `${FUEL_DIR}proof-native-builders-continuation.wat`;
const PROOF_NATIVE_STATE_CONTINUATION_WAT_PATH = `${FUEL_DIR}proof-native-state-continuation.wat`;
const PROOF_NATIVE_ELABORATION_CONTINUATION_WAT_PATH = `${FUEL_DIR}proof-native-elaboration-continuation.wat`;
const WASM_PATH = `${FUEL_DIR}interpreter.wasm`;
const JS_PATH = `${FUEL_DIR}interpreter.wasm.js`;

async function main() {
  console.log('Building fuel interpreter WASM...');
  console.log(`  WAT:  ${WAT_PATH}`);
  console.log(`  WASM: ${WASM_PATH}`);
  console.log(`  JS:   ${JS_PATH}`);

  // Step 0: Layout constants must agree with constants.js before
  // anything compiles — a drifted offset ships silent memory
  // corruption.
  console.log('\n0. Verifying layout constants against constants.js...');
  const layoutReport = await verifyLayoutConstants();
  if (!layoutReport.ok) {
    Deno.exit(1);
  }
  console.log(`   OK: ${layoutReport.verified}/${layoutReport.total} WAT globals verified.`);

  // Step 0.5: Fixed-region bases may only be referenced by their
  // helper functions — an unchecked region write ships silent
  // corruption of the neighboring region.
  console.log('\n0.5. Verifying region write discipline...');
  const disciplineReport = await verifyRegionWriteDiscipline();
  if (!disciplineReport.ok) {
    Deno.exit(1);
  }
  console.log('   OK: region base names confined to their helpers.');

  // Step 1: Compile the interpreter and proof module fragments.
  console.log('\n1. Compiling WAT to WASM...');
  const interpreterWat = await Deno.readTextFile(WAT_PATH);
  const [proofKernelWat, proofRecursorsWat, proofCoreDataWat, proofLiteralDataWat, proofArtifactCheckWat, proofNativeRuntimeWat, proofNativeContinuationWat, proofWorkExpandedWat, proofNativeBuildersWat, proofNativeStateContinuationWat, proofNativeElaborationContinuationWat] =
    await Promise.all([
      PROOF_KERNEL_WAT_PATH,
      PROOF_RECURSORS_WAT_PATH,
      PROOF_CORE_DATA_WAT_PATH,
      PROOF_LITERAL_DATA_WAT_PATH,
      PROOF_ARTIFACT_CHECK_WAT_PATH,
      PROOF_NATIVE_RUNTIME_WAT_PATH,
      PROOF_NATIVE_CONTINUATION_WAT_PATH,
      PROOF_WORK_EXPANDED_WAT_PATH,
      PROOF_NATIVE_BUILDERS_WAT_PATH,
      PROOF_NATIVE_STATE_CONTINUATION_WAT_PATH,
      PROOF_NATIVE_ELABORATION_CONTINUATION_WAT_PATH,
    ].map((path) => Deno.readTextFile(path)));
  const moduleClose = interpreterWat.lastIndexOf(')');
  if (moduleClose < 0 || interpreterWat.slice(moduleClose + 1).trim() !== '') {
    throw new Error('interpreter.wat has no unique final module delimiter');
  }
  const combinedWatPath = await Deno.makeTempFile({ prefix: 'sand-proof-', suffix: '.wat' });
  await Deno.writeTextFile(combinedWatPath,
    `${interpreterWat.slice(0, moduleClose)}\n${proofCoreDataWat}\n${proofLiteralDataWat}\n${proofKernelWat}\n${proofRecursorsWat}\n${proofArtifactCheckWat}\n${proofNativeRuntimeWat}\n${proofNativeContinuationWat}\n${proofWorkExpandedWat}\n${proofNativeBuildersWat}\n${proofNativeStateContinuationWat}\n${proofNativeElaborationContinuationWat}\n)\n`);
  const wat2wasm = new Deno.Command('wat2wasm', {
    args: ['--enable-threads', combinedWatPath, '-o', WASM_PATH],
    stdout: 'piped',
    stderr: 'piped',
  });

  const { code, stdout, stderr } = await wat2wasm.output();
  await Deno.remove(combinedWatPath);

  if (code !== 0) {
    console.error('wat2wasm failed:');
    console.error(new TextDecoder().decode(stderr));
    Deno.exit(1);
  }

  if (stdout.length > 0) {
    console.log(new TextDecoder().decode(stdout));
  }

  // Step 2: Read WASM binary
  console.log('2. Reading WASM binary...');
  const wasmBinary = await Deno.readFile(WASM_PATH);
  console.log(`   Size: ${wasmBinary.length} bytes`);

  // Step 3: Base64 encode
  console.log('3. Base64 encoding...');
  let binaryStr = '';
  for (let i = 0; i < wasmBinary.length; i++) {
    binaryStr += String.fromCharCode(wasmBinary[i]);
  }
  const base64 = btoa(binaryStr);
  console.log(`   Base64 length: ${base64.length} chars`);

  // Step 4: Generate JS module
  console.log('4. Generating JS module...');
  const jsContent = `/**
 * Fuel-based interpreter WASM module (auto-generated).
 *
 * DO NOT EDIT - regenerate with: deno run --allow-read --allow-write --allow-run tools/build-fuel-wasm.js
 */

import {
  WASM_BASE64 as REGEX_WASM_BASE64,
  instantiateRegexSync,
} from './regex-engine.wasm.js';
import { REGEX_PROGRAM } from './regex-engine-contract.js';
import {
  WASM_BASE64 as SCHEMA_WASM_BASE64,
  instantiateSchemaSync,
} from './schema-engine.wasm.js';
import { SCHEMA_PROGRAM } from './schema-engine-contract.js';

export const WASM_BASE64 = "${base64}";

/**
 * The bundled module is decoded and compiled once per process.
 */
let bundledModule = null;

export function getBundledInterpreterModule() {
  if (bundledModule === null) {
    bundledModule = new WebAssembly.Module(decodeBase64(WASM_BASE64));
  }
  return bundledModule;
}

function decodeBase64(base64) {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
}

// The interpreter statically imports the standalone RegExp engine's
// compiler and executor. The engine is instantiated against the same
// shared memory BEFORE the interpreter on every construction path, and
// construction fails loudly on a missing export (LinkError) or a format
// version that disagrees with regex-engine-contract.js.
const REGEX_IMPORT_NAMES = [
  'scan_workspace_size',
  'scan_pattern',
  'measured_program_size',
  'emission_workspace_size',
  'initialize_program_emission',
  'initialize_emission_workspace',
  'emit_pattern',
  'validate_program',
  'continuation_size',
  'initialize_match',
  'run_match',
];

function checkedExports(instance, names, label, version, expectedVersion) {
  if (version !== expectedVersion) {
    throw new Error(
      \`\${label} engine format version \${version} does not match \` +
      \`\${label}-engine-contract.js version \${expectedVersion}\`);
  }
  const imports = {};
  for (const name of names) {
    const exported = instance.exports[name];
    if (typeof exported !== 'function') {
      throw new Error(\`\${label} engine export missing: \${name}\`);
    }
    imports[name] = exported;
  }
  return imports;
}

// The interpreter also statically imports the standalone JSON Schema
// engine (which itself imports the regex engine's full export set). Same
// discipline: instantiated against the shared memory before the
// interpreter, loud on a missing export or a format version drift.
const SCHEMA_IMPORT_NAMES = [
  'compile_workspace_size',
  'measure_schema',
  'measured_program_size',
  'emission_workspace_size',
  'initialize_emission',
  'emit_program',
  'compile_work_charged',
  'compile_work_overflow',
  'compile_diagnostic',
  'keyword_name',
  'continuation_size',
  'initialize_validation',
  'rebind_validation',
  'run_validation',
  'validation_work_charged',
  'validation_work_overflow',
  'error_stored',
  'error_count',
  'render_error_complete',
  'program_route_count',
  'route_result',
];

function engineImports(memory, regexModule, schemaModule) {
  const regexInstance = regexModule
    ? instantiateRegexSync(memory, regexModule)
    : instantiateRegexSync(memory);
  const regex = checkedExports(regexInstance, REGEX_IMPORT_NAMES, 'regex',
    regexInstance.exports.format_version(), REGEX_PROGRAM.VERSION);
  const schemaInstance = schemaModule
    ? instantiateSchemaSync(memory, regexInstance, schemaModule)
    : instantiateSchemaSync(memory, regexInstance);
  const schema = checkedExports(schemaInstance, SCHEMA_IMPORT_NAMES, 'schema',
    schemaInstance.exports.format_version(), SCHEMA_PROGRAM.VERSION);
  return { regex, schema };
}

/**
 * Instantiate the WASM module with the given memory.
 *
 * @param {WebAssembly.Memory} memory - Shared memory instance
 * @returns {Promise<WebAssembly.Instance>} - WASM instance with exports
 */
export async function instantiate(memory) {
  // Chrome caps synchronous main-thread compilation at 8KB; compile the
  // regex engine asynchronously here.
  const regexModule = await WebAssembly.compile(decodeBase64(REGEX_WASM_BASE64));
  const schemaModule = await WebAssembly.compile(decodeBase64(SCHEMA_WASM_BASE64));
  const { regex, schema } = engineImports(memory, regexModule, schemaModule);
  return WebAssembly.instantiate(
    getBundledInterpreterModule(),
    { env: { memory }, regex, schema },
  );
}

export function instantiateSync(memory) {
  const { regex, schema } = engineImports(memory);
  return new WebAssembly.Instance(
    getBundledInterpreterModule(),
    { env: { memory }, regex, schema },
  );
}

export async function compileModule() {
  return getBundledInterpreterModule();
}

/**
 * Instantiate from a pre-compiled module (synchronous).
 * Use this in workers after receiving a compiled module.
 *
 * @param {WebAssembly.Module} module - Pre-compiled WASM module
 * @param {WebAssembly.Memory} memory - Memory instance
 * @param {WebAssembly.Module} [regexModule] - Pre-compiled regex engine
 *   module (skips its sync compilation).
 * @returns {WebAssembly.Instance}
 */
export function instantiateFromModule(module, memory, regexModule, schemaModule) {
  const { regex, schema } = engineImports(memory, regexModule, schemaModule);
  return new WebAssembly.Instance(module, { env: { memory }, regex, schema });
}
`;

  await Deno.writeTextFile(JS_PATH, jsContent);

  // Step 5: Clean up .wasm file (optional - keep for debugging)
  // await Deno.remove(WASM_PATH);

  console.log('\nDone!');
  console.log(`Generated: ${JS_PATH}`);
}

main().catch((err) => {
  console.error(err);
  Deno.exit(1);
});

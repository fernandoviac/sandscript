// Runtime host: link genuine modules, invoke one complete WAT scenario, read
// only the fixed outer result. No input encoding, schema calls, grant loops,
// allocation/copying, or diagnostic decoding occurs in this host.
import { assert, assertEquals } from 'https://deno.land/std@0.208.0/assert/mod.ts';
import { compileRegexModule, instantiateRegexSync, WASM_BASE64 as REGEX_BYTES } from '../../src/fuel/regex-engine.wasm.js';
import { compileSchemaModule, instantiateSchemaSync, WASM_BASE64 as SCHEMA_BYTES } from '../../src/fuel/schema-engine.wasm.js';
import { CASES, compileDirectProofModule, instantiateDirectProofSync, WASM_BASE64 as CALLER_BYTES } from './direct-proof.wasm.js';

const schemaFunctions = [
  'initialize_work_budget', 'compile_direct', 'validate_direct', 'render_error_direct',
  'validate_program', 'program_total_bytes', 'program_route_count', 'validation_result',
  'validation_work_charged', 'error_stored', 'error_record', 'route_count', 'route_result',
  'error_count', 'render_failure_direct', 'format_number', 'parse_number_utf16', 'format_number_hex',
];
const decodeBase64 = (text) => Uint8Array.from(atob(text), (character) => character.charCodeAt(0));

Deno.test('direct WAT caller: source-free imports, byte-identical wrappers, one invocation per scenario', async () => {
  const regexModule = compileRegexModule();
  const schemaModule = compileSchemaModule();
  const callerModule = compileDirectProofModule();
  const imports = {
    regex: WebAssembly.Module.imports(regexModule),
    schema: WebAssembly.Module.imports(schemaModule),
    caller: WebAssembly.Module.imports(callerModule),
  };
  assertEquals(imports.regex, [{ module: 'env', name: 'memory', kind: 'memory' }]);
  assertEquals(imports.caller, [
    { module: 'env', name: 'memory', kind: 'memory' },
    ...schemaFunctions.map((name) => ({ module: 'schema', name, kind: 'function' })),
  ]);
  assertEquals(imports.schema.filter((entry) => entry.kind === 'memory'), [{ module: 'env', name: 'memory', kind: 'memory' }]);
  for (const entry of imports.schema.filter((entry) => entry.kind !== 'memory')) {
    assertEquals(entry.kind, 'function');
    assertEquals(entry.module, 'regex');
    assert(WebAssembly.Module.exports(regexModule).some((value) => value.kind === 'function' && value.name === entry.name));
  }
  assertEquals(WebAssembly.Module.exports(callerModule).map((entry) => [entry.name, entry.kind]), [
    ['case_count', 'function'], ['result_pointer', 'function'], ['result_size', 'function'], ['run_case', 'function'],
  ]);
  for (const [path, base64] of [
    ['../../src/fuel/regex-engine.wasm', REGEX_BYTES],
    ['../../src/fuel/schema-engine.wasm', SCHEMA_BYTES],
    ['./direct-proof.wasm', CALLER_BYTES],
  ]) {
    assertEquals(await Deno.readFile(new URL(path, import.meta.url)), decodeBase64(base64), `${path}: wrapper/raw identity`);
  }
  const memory = new WebAssembly.Memory({ initial: 1, maximum: 16384, shared: true });
  const regex = instantiateRegexSync(memory, regexModule);
  const schema = instantiateSchemaSync(memory, regex, schemaModule);
  const caller = instantiateDirectProofSync(memory, schema, callerModule).exports;
  assertEquals(caller.case_count(), CASES.length);
  assertEquals(caller.result_size(), 32);
  console.log(JSON.stringify({ directProofImports: imports }));
  for (let caseId = 0; caseId < CASES.length; caseId++) {
    const failure = caller.run_case(caseId); // exactly ONCE for the complete scenario
    const pointer = caller.result_pointer();
    const record = new DataView(memory.buffer, pointer, caller.result_size());
    const result = {
      caseId: record.getUint32(0, true), name: CASES[caseId],
      status: record.getUint32(4, true), failureCode: record.getUint32(8, true),
      expectedStatus: record.getUint32(12, true), phase: record.getUint32(16, true),
      reserved: record.getUint32(20, true), consumedWork: record.getBigUint64(24, true).toString(),
    };
    console.log(JSON.stringify(result));
    assertEquals(result.caseId, caseId);
    assertEquals(result.reserved, 0);
    assertEquals(failure, result.failureCode);
    assertEquals(failure, 0, `${CASES[caseId]}: ${JSON.stringify(result)}`);
    assertEquals(result.status, result.expectedStatus);
    assert(result.status !== 1, 'direct helpers must never expose PAUSED');
  }
  assert(memory.buffer.byteLength > 65536, 'the WAT caller must exercise its own memory.grow');
});

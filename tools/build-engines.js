// Builds every standalone engine module, regex first (the schema engine
// imports it). Runs before tools/build-fuel-wasm.js under `deno task wasm`
// so a stale engine artifact is a build-order impossibility.
import { buildRegexWasm } from './build-regex-wasm.js';
import { buildSchemaWasm } from './build-schema-wasm.js';

console.log('Building regex engine...');
await buildRegexWasm();
console.log('Building schema engine...');
await buildSchemaWasm();
console.log('Engines built.');

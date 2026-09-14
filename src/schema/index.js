// Host entry point for the standalone JSON Schema engine.
//
// Dependency closure: the two engine .wasm.js files, their contracts, and
// membrane/msgpack.js — never interpreter.wasm.js. The engine that runs
// here is byte-for-byte the one the SandScript `Schema` global uses.

import { instantiateRegexSync } from '../fuel/regex-engine.wasm.js';
import { REGEX_PROGRAM } from '../fuel/regex-engine-contract.js';
import { instantiateSchemaSync } from '../fuel/schema-engine.wasm.js';
import {
  FORMAT_NAMES,
  SCHEMA_CONTINUATION,
  SCHEMA_DIRECT,
  SCHEMA_LIMIT,
  SCHEMA_PROGRAM,
  SCHEMA_STATUS,
  SCHEMA_WORK_BUDGET,
} from '../fuel/schema-engine-contract.js';
import { decode as msgpackDecode, encode as msgpackEncode } from '../membrane/msgpack.js';

const PAGE = 65536;
const STATUS_NAME = Object.fromEntries(Object.entries(SCHEMA_STATUS).map(([k, v]) => [v, k]));
const { HEADER: CH, MODE, ROUTE_RESULT: RR } = SCHEMA_CONTINUATION;
const { HEADER: DH } = SCHEMA_DIRECT;
const { HEADER: BH, FLAG: BF } = SCHEMA_WORK_BUDGET;

export class SchemaError extends Error {
  constructor(message, details = {}) {
    super(message);
    this.name = 'SchemaError';
    Object.assign(this, details);
  }
}

export class SchemaValidationError extends SchemaError {
  constructor(errors) {
    super(errors.length ? errors[0].message + (errors[0].instancePath ? ` at ${errors[0].instancePath}` : '') : 'invalid');
    this.name = 'SchemaValidationError';
    this.errors = errors;
  }
}
// Keep the facade's Number-valued result shape without pretending that an
// unrepresentable charge is exact. The source retains the authoritative u64.
function workNumber(value) {
  const work = BigInt.asUintN(64, value);
  return work <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(work) : Infinity;
}


function dialectBits(schema, options) {
  let dialect = options.dialect;
  if (!dialect && schema && typeof schema === 'object' && typeof schema.$schema === 'string') {
    const id = schema.$schema;
    if (id.includes('draft-04')) dialect = 'draft-04';
    else if (id.includes('draft-06') || id.includes('draft-07')) dialect = 'draft-07';
    else if (id.includes('2019-09')) dialect = '2019-09';
  }
  switch (dialect) {
    case 'draft-04': return SCHEMA_PROGRAM.OPTION.DIALECT_04;
    case 'draft-06':
    case 'draft-07': return SCHEMA_PROGRAM.OPTION.DIALECT_07;
    default: return 0;
  }
}

export function createSchemaEngine({ memory, initialPages = 64, maximumPages = 16384 } = {}) {
  return new SchemaEngine(memory, initialPages, maximumPages);
}

class SchemaEngine {
  constructor(memory, initialPages, maximumPages) {
    this.memory = memory ?? new WebAssembly.Memory({ initial: initialPages, maximum: maximumPages, shared: true });
    this.regex = instantiateRegexSync(this.memory);
    if (this.regex.exports.format_version() !== REGEX_PROGRAM.VERSION) {
      throw new SchemaError('regex engine format version mismatch');
    }
    this.instance = instantiateSchemaSync(this.memory, this.regex);
    this.exports = this.instance.exports;
    if (this.exports.format_version() !== SCHEMA_PROGRAM.VERSION) {
      throw new SchemaError('schema engine format version mismatch');
    }
    // Layout: [0, pinnedEnd) pinned programs, growing up; scratch above.
    this.pinnedEnd = 64;
    this.pinnedFree = new Map();
    this.scratchBase = 0;
    this.scratchCursor = 0;
    this.formats = Object.freeze(FORMAT_NAMES.slice(1));
  }

  get bytes() {
    return new Uint8Array(this.memory.buffer);
  }
  get view() {
    return new DataView(this.memory.buffer);
  }

  _ensure(end) {
    const have = this.memory.buffer.byteLength;
    if (end <= have) return;
    const pages = Math.ceil((end - have) / PAGE);
    this.memory.grow(pages);
  }

  _scratchReset() {
    this.scratchBase = (this.pinnedEnd + 7) & ~7;
    this.scratchCursor = this.scratchBase;
  }

  _scratchAlloc(bytes) {
    const start = (this.scratchCursor + 7) & ~7;
    this._ensure(start + bytes);
    this.scratchCursor = start + bytes;
    return start;
  }

  _pinnedAlloc(bytes) {
    const size = (bytes + 7) & ~7;
    const free = this.pinnedFree.get(size);
    if (free && free.length) return free.pop();
    const start = this.pinnedEnd;
    this._ensure(start + size);
    this.pinnedEnd = start + size;
    return start;
  }

  _pinnedFreeBlock(offset, bytes) {
    const size = (bytes + 7) & ~7;
    if (!this.pinnedFree.has(size)) this.pinnedFree.set(size, []);
    this.pinnedFree.get(size).push(offset);
  }

  _toMsgpack(input) {
    if (input instanceof Uint8Array) return input;
    if (input && typeof input === 'object' && !Array.isArray(input) && 'json' in input && Object.keys(input).length === 1) {
      return this.transcodeJson(input.json);
    }
    return msgpackEncode(input);
  }

  // JSON text → msgpack bytes, byte-for-byte what msgpack.encode(JSON.parse
  // (text)) produces. The engine converts in one pass; a number outside its
  // exact fast path (more than 15 significant digits, or a decimal exponent
  // beyond ±22) comes back UNSUPPORTED and the host parser takes over —
  // never a double-rounded value.
  transcodeJson(text, options = {}) {
    const bytes = typeof text === 'string' ? new TextEncoder().encode(text) : text;
    if (!(bytes instanceof Uint8Array)) throw new TypeError('transcodeJson requires a string or Uint8Array');
    const x = this.exports;
    this._scratchReset();
    const input = this._scratchAlloc(bytes.length);
    this.bytes.set(bytes, input);
    const cap = bytes.length * 3 + 16;
    const out = this._scratchAlloc(cap);
    const [status, , n] = x.transcode_json(input, bytes.length, out, cap, options.fuel ?? 0x7fffffff);
    if (status === SCHEMA_STATUS.OK) return this.bytes.slice(out, out + n);
    if (status === SCHEMA_STATUS.UNSUPPORTED) {
      return msgpackEncode(JSON.parse(typeof text === 'string' ? text : new TextDecoder().decode(bytes)));
    }
    if (status === SCHEMA_STATUS.PAUSED) throw new SchemaError('transcode fuel exhausted', { status: 'PAUSED' });
    throw new SchemaError(`invalid JSON at byte ${n}: ${STATUS_NAME[status]}`, { status: STATUS_NAME[status], offset: n });
  }


  _budget(options) {
    const fuel = options.fuel ?? Infinity;
    let allowance = 0n;
    if (fuel !== Infinity) {
      if (!Number.isFinite(fuel)) throw new SchemaError('invalid schema fuel', { status: 'INVALID_ARGUMENT' });
      allowance = BigInt(Math.max(0, Math.floor(fuel)));
      if (allowance >= (1n << 64n) - 1n) throw new SchemaError('invalid schema fuel', { status: 'INVALID_ARGUMENT' });
    }
    const budget = this._scratchAlloc(SCHEMA_WORK_BUDGET.SIZE);
    const status = this.exports.initialize_work_budget(
      budget, SCHEMA_WORK_BUDGET.SIZE, allowance,
      BF.FACADE_TERMINAL | (fuel === Infinity ? BF.FACADE_UNLIMITED : 0),
    );
    if (status !== SCHEMA_STATUS.OK) throw new SchemaError('invalid schema budget', { status: STATUS_NAME[status] });
    return budget;
  }

  _spent(account) {
    return workNumber(this.view.getBigUint64(account.budget + BH.CONSUMED, true));
  }

  _failed(status, account, operation) {
    if (status !== SCHEMA_STATUS.WORK_LIMIT_EXCEEDED &&
        this.view.getUint32(account.scratch + DH.STATE, true) === SCHEMA_DIRECT.STATE.TERMINAL) {
      let capacity = 2048;
      const output = this._scratchAlloc(capacity);
      for (;;) {
        const [renderStatus, bytes] = this.exports.render_failure_direct(
          account.scratch, account.capacity, output, capacity, account.budget,
        );
        if (renderStatus === SCHEMA_STATUS.BUFFER_TOO_SMALL) {
          this._ensure(output + bytes);
          capacity = bytes;
          this.scratchCursor = output + capacity;
          continue;
        }
        if (renderStatus === SCHEMA_STATUS.WORK_LIMIT_EXCEEDED) {
          return this._failed(renderStatus, account, operation);
        }
        if (renderStatus !== SCHEMA_STATUS.OK) {
          throw new SchemaError('engine failure rendering failed', { status: STATUS_NAME[renderStatus] });
        }
        const { message, ...details } = msgpackDecode(this.bytes.subarray(output, output + bytes));
        throw new SchemaError(message, { ...details, fuelCharged: this._spent(account) });
      }
    }
    const exhausted = status === SCHEMA_STATUS.WORK_LIMIT_EXCEEDED;
    const name = exhausted ? 'PAUSED' : STATUS_NAME[status];
    throw new SchemaError(exhausted ? `${operation} fuel exhausted` : `${operation} failed: ${name}`, {
      status: name,
      fuelCharged: this._spent(account),
      ...(this.view.getUint32(account.budget + BH.OVERFLOW, true) ? { workOverflow: true } : {}),
    });
  }

  // Only whole-region allocation remains here. The returned requirement is
  // chosen by WASM; grants, phases, arena policy and retained debt stay there.
  _direct(budget, invoke) {
    const scratch = this._scratchAlloc(SCHEMA_DIRECT.HEADER_SIZE);
    let capacity = SCHEMA_DIRECT.HEADER_SIZE;
    let initialize = 1;
    for (;;) {
      const [status, required] = invoke(scratch, capacity, initialize);
      if (status !== SCHEMA_STATUS.BUFFER_TOO_SMALL) return { budget, scratch, capacity, status };
      this._ensure(scratch + required);
      capacity = required;
      this.scratchCursor = scratch + capacity;
      initialize = 0;
    }
  }

  compile(schema, options = {}) {
    return this._compile(schema, options, false);
  }

  // One program for N routes (plan "Schema sets"): match(input) decides
  // every route with one walk; the verdicts equal N single validations.
  compileSet(schemas, options = {}) {
    if (!Array.isArray(schemas)) throw new TypeError('compileSet requires an array of schemas');
    return this._compile(schemas, options, true);
  }

  _compile(schema, options, set) {
    const x = this.exports;
    // A bundle [root, baseUri|null, [uri, document]...] carries the root's
    // base URI and every additional resource $ref may reach. A set is
    // always the bundle form with the routes array as its root.
    let input = schema;
    if (set || options.schemas || options.baseUri) {
      input = [schema, options.baseUri ?? null, ...(options.schemas ?? []).map(([uri, document]) => [uri, document])];
    }
    const schemaBytes = this._toMsgpack(input);
    let bits = 0;
    if (options.strict) bits |= SCHEMA_PROGRAM.OPTION.STRICT;
    if (options.formats === 'annotate') bits |= SCHEMA_PROGRAM.OPTION.FORMAT_ANNOTATE;
    if (set) bits |= SCHEMA_PROGRAM.OPTION.SET;
    bits |= dialectBits(set ? null : schema, options);
    this._scratchReset();
    const budget = this._budget(options);
    const schemaAddr = this._scratchAlloc(schemaBytes.length);
    this.bytes.set(schemaBytes, schemaAddr);
    const account = this._direct(budget, (scratch, capacity, initialize) =>
      x.compile_direct(schemaAddr, schemaBytes.length, bits, scratch, capacity, budget, initialize, options.grant ?? 0));
    const { status, scratch } = account;
    const spent = this._spent(account);
    if (status !== SCHEMA_STATUS.OK) this._failed(status, account, 'compile');
    const staged = scratch + this.view.getUint32(scratch + DH.RESULT_OFFSET, true);
    const programSize = this.view.getUint32(scratch + DH.RESULT_CAPACITY, true);
    // Pinned growth may overlap scratch: finish the host-owned copy first.
    const programBytes = this.bytes.slice(staged, staged + programSize);
    const program = this._pinnedAlloc(programSize);
    this.bytes.set(programBytes, program);
    const source = schema instanceof Uint8Array ? null : schema;
    return set
      ? new CompiledSet(this, program, programSize, source, spent)
      : new CompiledSchema(this, program, programSize, source, spent);
  }

  load(programBytes) {
    const program = this._pinnedAlloc(programBytes.length);
    this.bytes.set(programBytes, program);
    const status = this.exports.validate_program(program, programBytes.length);
    if (status !== SCHEMA_STATUS.OK) {
      this._pinnedFreeBlock(program, programBytes.length);
      throw new SchemaError(`program rejected: ${STATUS_NAME[status]}`, { status: STATUS_NAME[status] });
    }
    return this.exports.program_route_count(program) > 0
      ? new CompiledSet(this, program, programBytes.length, null, 0)
      : new CompiledSchema(this, program, programBytes.length, null, 0);
  }

  // Run `compiled`'s program over `input` to completion (growing the arena
  // on demand) and hand the finished continuation to `finish`.
  _runProgram(compiled, input, mode, options, finish) {
    if (compiled.disposed) throw new SchemaError('compiled schema was disposed');
    const x = this.exports;
    const docBytes = this._toMsgpack(input);
    const maxDepth = options.maxDepth ?? SCHEMA_LIMIT.DEFAULT_MAX_DEPTH;
    // maxErrors is per route: a set stores up to that many for every route
    const routes = compiled.kind === 'set' ? compiled.routeCount : 1;
    const errorCapacity = mode === MODE.TEST ? 0 : Math.min(65536, (options.maxErrors ?? SCHEMA_LIMIT.DEFAULT_ERROR_CAPACITY) * routes);
    const arenaBytes = options.arenaBytes ?? SCHEMA_LIMIT.DEFAULT_ARENA_BYTES;
    this._scratchReset();
    const budget = this._budget(options);
    const doc = this._scratchAlloc(docBytes.length);
    this.bytes.set(docBytes, doc);
    const account = this._direct(budget, (scratch, capacity, initialize) =>
      x.validate_direct(compiled.program, compiled.size, doc, docBytes.length, mode | MODE.TRUSTED,
        maxDepth, errorCapacity, arenaBytes, scratch, capacity, budget, initialize, options.grant ?? 0));
    if (account.status !== SCHEMA_STATUS.VALID && account.status !== SCHEMA_STATUS.INVALID) {
      this._failed(account.status, account, 'validation');
    }
    const cont = account.scratch + this.view.getUint32(account.scratch + DH.RESULT_OFFSET, true);
    return finish(cont, account.status, account);
  }
}

class CompiledSchema {
  constructor(engine, program, size, schema, compileFuel) {
    this.engine = engine;
    this.program = program;
    this.size = size;
    this.schema = schema;
    this.compileFuel = compileFuel;
    this.kind = 'schema';
    this.disposed = false;
  }

  get programBytes() {
    return this.engine.bytes.slice(this.program, this.program + this.size);
  }

  dispose() {
    if (this.disposed) return;
    this.disposed = true;
    this.engine._pinnedFreeBlock(this.program, this.size);
  }

  test(input, options = {}) {
    return this._run(input, MODE.TEST, options).valid;
  }

  validate(input, options = {}) {
    return this._run(input, MODE.VALIDATE, options);
  }

  assert(input, options = {}) {
    const result = this._run(input, MODE.VALIDATE, options);
    if (!result.valid) throw new SchemaValidationError(result.errors);
    return input;
  }

  errors(input, options = {}) {
    return this._run(input, MODE.VALIDATE, options).errors;
  }

  _run(input, mode, options) {
    return this.engine._runProgram(this, input, mode, options, (cont, status, account) => {
      if (status === SCHEMA_STATUS.VALID) {
        return { valid: true, errors: [], fuelCharged: this.engine._spent(account) };
      }
      const errors = mode === MODE.TEST ? [] : this._decodeErrors(cont, 0, this.engine.view.getUint32(cont + CH.ERROR_STORED, true), account);
      return {
        valid: false,
        errors,
        errorCount: this.engine.view.getUint32(cont + CH.ERROR_COUNT, true),
        fuelCharged: this.engine._spent(account),
      };
    });
  }

  // Complete records and authoritative work come from the same renderer for
  // every consumer. Growth retries preserve the settled continuation and debit
  // failed output attempts before requesting another rendering window.
  _decodeErrors(cont, start, count, account) {
    const engine = this.engine;
    const x = engine.exports;
    const errors = [];
    let cap = 8192;
    let out = engine._scratchAlloc(cap);
    for (let i = start; i < start + count; i++) {
      let n;
      for (;;) {
        const [status, bytes] = x.render_error_direct(
          this.program, this.size, account.scratch, account.capacity, i, out, cap, account.budget,
        );
        if (status === SCHEMA_STATUS.BUFFER_TOO_SMALL) {
          cap = bytes;
          out = engine._scratchAlloc(cap);
          continue;
        }
        if (status !== SCHEMA_STATUS.OK) engine._failed(status, account, 'validation');
        n = bytes;
        break;
      }
      const record = msgpackDecode(engine.bytes.slice(out, out + n));
      errors.push(record);
    }
    return errors;
  }
}

// A compiled schema set: N routes in one program. Verdicts are identical
// to N single validations; TEST mode skips evaluation for routes the
// gate pass decides, VALIDATE mode evaluates every undecided route so the
// per-route error lists equal single validation.
class CompiledSet extends CompiledSchema {
  constructor(engine, program, size, schemas, compileFuel) {
    super(engine, program, size, schemas, compileFuel);
    this.kind = 'set';
    this.size_ = engine.exports.program_route_count(program);
  }

  get routeCount() {
    return this.size_;
  }

  // Indices of the matching routes.
  match(input, options = {}) {
    return this.engine._runProgram(this, input, MODE.TEST, options, (cont) => this._verdicts(cont).flatMap((v, i) => (v ? [i] : [])));
  }

  // Every route's { index, valid, errors }.
  matchAll(input, options = {}) {
    return this.engine._runProgram(this, input, MODE.VALIDATE, options, (cont, _status, account) => {
      const x = this.engine.exports;
      const view = this.engine.view;
      const out = [];
      for (let i = 0; i < this.size_; i++) {
        const r = x.route_result(cont, i);
        const valid = view.getUint32(r + RR.VERDICT, true) === 1;
        out.push({
          index: i,
          valid,
          errors: valid ? [] : this._decodeErrors(cont, view.getUint32(r + RR.ERROR_START, true), view.getUint32(r + RR.ERROR_COUNT, true), account),
        });
      }
      return out;
    });
  }

  // One route of the set.
  test(input, index, options = {}) {
    if (!Number.isInteger(index) || index < 0 || index >= this.size_) throw new RangeError('route index out of range');
    return this.engine._runProgram(this, input, MODE.TEST, options, (cont) => this._verdicts(cont)[index]);
  }

  validate() {
    throw new TypeError('a schema set has matchAll(value), not validate(value)');
  }

  _verdicts(cont) {
    const x = this.engine.exports;
    const view = this.engine.view;
    const out = new Array(this.size_);
    for (let i = 0; i < this.size_; i++) {
      out[i] = view.getUint32(x.route_result(cont, i) + RR.VERDICT, true) === 1;
    }
    return out;
  }
}

export { SCHEMA_STATUS, SCHEMA_LIMIT };

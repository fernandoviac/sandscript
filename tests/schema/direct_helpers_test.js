// Checked direct boundaries. These are source-regression tests, not the separate
// single-call WASM/native acceptance harness. No compiler/arena/grant policy here:
// resource retries allocate exactly the engine's returned whole-region size.
import { assert, assertEquals } from 'https://deno.land/std@0.208.0/assert/mod.ts';
import { instantiateRegexSync } from '../../src/fuel/regex-engine.wasm.js';
import { instantiateSchemaSync } from '../../src/fuel/schema-engine.wasm.js';
import { encode, decode } from '../../src/membrane/msgpack.js';
import {
  SCHEMA_STATUS as S, SCHEMA_DIRECT as D, SCHEMA_WORK_BUDGET as B,
  SCHEMA_PROGRAM as P, SCHEMA_CONTINUATION as C,
} from '../../src/fuel/schema-engine-contract.js';

const MAX = (1n << 64n) - 2n;
const DH = D.HEADER;
const BH = B.HEADER;

class MemoryCaller {
  constructor() {
    this.memory = new WebAssembly.Memory({ initial: 64, maximum: 16384, shared: true });
    this.x = instantiateSchemaSync(this.memory, instantiateRegexSync(this.memory)).exports;
    this.cursor = 64;
  }
  get view() { return new DataView(this.memory.buffer); }
  get bytes() { return new Uint8Array(this.memory.buffer); }
  alloc(n) {
    const p = Math.ceil(this.cursor / 8) * 8;
    this.cursor = p + n;
    if (this.cursor > this.memory.buffer.byteLength) {
      this.memory.grow(Math.ceil((this.cursor - this.memory.buffer.byteLength) / 65536));
    }
    return p;
  }
  stage(bytes) {
    const p = this.alloc(bytes.length);
    this.bytes.set(bytes, p);
    return p;
  }
  budget(allowance = MAX, flags = 0) {
    const p = this.alloc(B.SIZE);
    assertEquals(this.x.initialize_work_budget(p, B.SIZE, allowance, flags), S.OK);
    return p;
  }
  work(b) { return this.view.getBigUint64(b + BH.CONSUMED, true); }
  copyLive(s, capacity) {
    const live = this.view.getUint32(s + DH.LIVE_BYTES, true);
    const next = this.alloc(capacity);
    this.bytes.copyWithin(next, s, s + live);
    return next;
  }
  region(b, invoke, initial = D.HEADER_SIZE) {
    let capacity = initial;
    let scratch = this.alloc(capacity);
    let initialize = 1;
    const shortages = [];
    for (let guard = 0; guard < 32; guard++) {
      const [status, required] = invoke(scratch, capacity, initialize);
      if (status !== S.BUFFER_TOO_SMALL) return { status, scratch, capacity, budget: b, shortages };
      assert(required > capacity, 'a genuine resource return must provide a larger region');
      shortages.push({ work: this.work(b), state: this.view.getUint32(scratch + DH.STATE, true) });
      scratch = this.copyLive(scratch, required);
      capacity = required;
      initialize = 0;
    }
    throw new Error('resource re-entry did not terminate');
  }
  compile(schema, allowance = MAX, grant = 0) {
    const bytes = encode(schema);
    const input = this.stage(bytes);
    const b = this.budget(allowance);
    const result = this.region(b, (s, cap, init) => this.x.compile_direct(input, bytes.length, 0, s, cap, b, init, grant));
    if (result.status === S.OK) {
      result.program = result.scratch + this.view.getUint32(result.scratch + DH.RESULT_OFFSET, true);
      result.size = this.x.program_total_bytes(result.program);
      result.bytes = this.bytes.slice(result.program, result.program + result.size);
    }
    return result;
  }
  validate(program, document, { allowance = MAX, arena = 16384, mode = C.MODE.TEST, errors = 0, grant = 0 } = {}) {
    const bytes = document instanceof Uint8Array ? document : encode(document);
    const input = this.stage(bytes);
    const b = this.budget(allowance);
    return this.region(b, (s, cap, init) => this.x.validate_direct(
      program.program, program.size, input, bytes.length, mode, 256, errors, arena, s, cap, b, init, grant,
    ));
  }
}

Deno.test('direct strict budgets admit exact completion and reject atomic terminal overrun', () => {
  const h = new MemoryCaller();
  const schema = { type: 'object', required: ['kind'], properties: { kind: { const: 'a' } } };
  const compiled = h.compile(schema);
  assertEquals(compiled.status, S.OK);
  const compileWork = h.work(compiled.budget);
  const exactCompile = h.compile(schema, compileWork);
  assertEquals(exactCompile.status, S.OK);
  assertEquals(exactCompile.bytes, compiled.bytes);
  assertEquals(h.compile(schema, compileWork - 1n).status, S.WORK_LIMIT_EXCEEDED);

  // A set's gate pass is atomic. Strict checks/setup are paid before that pass.
  const bundle = encode([[schema], null]);
  const input = h.stage(bundle);
  const b = h.budget();
  const set = h.region(b, (s, cap, init) => h.x.compile_direct(input, bundle.length, P.OPTION.SET, s, cap, b, init, 0));
  assertEquals(set.status, S.OK);
  set.program = set.scratch + h.view.getUint32(set.scratch + DH.RESULT_OFFSET, true);
  set.size = h.x.program_total_bytes(set.program);
  const full = h.validate(set, { kind: 'a' });
  assertEquals(full.status, S.VALID);
  const cost = h.work(full.budget);
  assertEquals(h.validate(set, { kind: 'a' }, { allowance: cost }).status, S.VALID);
  const over = h.validate(set, { kind: 'a' }, { allowance: cost - 1n });
  assertEquals(over.status, S.WORK_LIMIT_EXCEEDED);
  assertEquals(h.view.getUint32(over.budget + BH.ENGINE_STATUS, true), S.VALID);
  assertEquals(h.work(over.budget), cost);
  assertEquals(h.validate(set, { kind: 'a' }, { grant: 1 }).status, S.VALID);
});

Deno.test('direct zero, sticky and checked-u64 overflow budgets never replenish', () => {
  const h = new MemoryCaller();
  const empty = h.compile(true, 0n);
  assertEquals(empty.status, S.WORK_LIMIT_EXCEEDED);
  assertEquals(h.work(empty.budget), 0n);
  const source = h.stage(encode(true));
  assertEquals(h.x.compile_direct(source, 1, 0, empty.scratch, empty.capacity, empty.budget, 1, 0), [S.WORK_LIMIT_EXCEEDED, 0]);
  const bad = h.alloc(B.SIZE);
  assertEquals(h.x.initialize_work_budget(bad, B.SIZE, -1n, 0), S.INVALID_ARGUMENT);
  assertEquals(h.x.initialize_work_budget(bad + 1, B.SIZE, 10n, 0), S.INVALID_ARGUMENT);

  const b = h.budget();
  // Restored aggregate history close to UINT64_MAX: the next source debit
  // must saturate, not wrap to an apparently unused allowance.
  h.view.setBigUint64(b + BH.CONSUMED, MAX - 1n, true);
  const overflow = h.region(b, (s, cap, init) => h.x.compile_direct(source, 1, 0, s, cap, b, init, 0));
  assertEquals(overflow.status, S.WORK_LIMIT_EXCEEDED);
  assertEquals(h.work(b), (1n << 64n) - 1n);
  assertEquals(h.view.getUint32(b + BH.OVERFLOW, true), 1);
  const before = h.bytes.slice(b, b + B.SIZE);
  assertEquals(h.x.compile_direct(source, 1, 0, overflow.scratch, overflow.capacity, b, 1, 0), [S.WORK_LIMIT_EXCEEDED, 0]);
  assertEquals(h.bytes.slice(b, b + B.SIZE), before);
});

Deno.test('direct compilation retains measurement and budget through insufficient scratch and relocation', () => {
  const h = new MemoryCaller();
  const schema = { $defs: { item: { pattern: '^a+$' } }, items: { $ref: '#/$defs/item' } };
  const baseline = h.compile(schema);
  assertEquals(baseline.status, S.OK);
  const bytes = encode(schema);
  let input = h.stage(bytes);
  const b = h.budget();
  let s = h.alloc(64);
  const first = h.x.compile_direct(input, bytes.length, 0, s, 64, b, 1, 1);
  assertEquals(first[0], S.BUFFER_TOO_SMALL);
  s = h.copyLive(s, first[1]);
  const emission = h.x.compile_direct(input, bytes.length, 0, s, first[1], b, 0, 1);
  assertEquals(emission[0], S.BUFFER_TOO_SMALL);
  assertEquals(h.view.getUint32(s + DH.STATE, true), D.STATE.NEED_EMISSION);
  const measuredWork = h.work(b);
  assert(measuredWork > 0n);
  assertEquals(h.x.compile_direct(input, bytes.length, 0, s, first[1], b, 0, 1), emission);
  assertEquals(h.work(b), measuredWork, 'a sizing retry cannot repeat measurement');
  h.bytes.fill(0xc1, input, input + bytes.length); // old input owner is released
  input = h.stage(bytes);
  s = h.copyLive(s, emission[1]);
  assertEquals(h.x.compile_direct(input, bytes.length, 0, s, emission[1], b, 0, 1), [S.OK, 0]);
  const p = s + h.view.getUint32(s + DH.RESULT_OFFSET, true);
  assertEquals(h.bytes.slice(p, p + h.x.program_total_bytes(p)), baseline.bytes);
  assertEquals(h.work(b), h.work(baseline.budget));
});

Deno.test('direct validation rebinds identical program and document owners at a resource return', () => {
  const h = new MemoryCaller();
  const p = h.compile({ pattern: '^a+$' });
  const baseline = h.validate(p, 'aaaa');
  assertEquals(baseline.status, S.VALID);
  const bytes = encode('aaaa');
  const oldDocument = h.stage(bytes);
  const b = h.budget();
  let scratch = h.alloc(64);
  const sized = h.x.validate_direct(p.program, p.size, oldDocument, bytes.length,
    0, 256, 0, 16384, scratch, 64, b, 1, 0);
  assertEquals(sized[0], S.BUFFER_TOO_SMALL);
  const checked = h.work(b);
  const program = h.stage(p.bytes);
  const document = h.stage(bytes);
  h.bytes.fill(0xc1, p.program, p.program + p.size);
  h.bytes.fill(0xc1, oldDocument, oldDocument + bytes.length);
  assertEquals(h.x.validate_direct(program, p.size, document, bytes.length,
    0, 256, 0, 16384, scratch, 64, b, 0, 0), sized);
  assertEquals(h.work(b), checked);
  scratch = h.copyLive(scratch, sized[1]);
  assertEquals(h.x.validate_direct(program, p.size, document, bytes.length,
    0, 256, 0, 16384, scratch, sized[1], b, 0, 0), [S.VALID, 0]);
  assertEquals(h.work(b), h.work(baseline.budget));
});

Deno.test('direct arena restarts retain failed debt and charge program checking only once', () => {
  const h = new MemoryCaller();
  const p = h.compile({ type: 'array', uniqueItems: true, items: { type: 'integer' } });
  const doc = Array.from({ length: 64 }, (_, i) => i);
  const full = h.validate(p, doc, { arena: 8 });
  assertEquals(full.status, S.VALID);
  assert(full.shortages.length >= 2, 'initial continuation then engine-selected arena growth');
  const check = full.shortages[0].work;
  const failed = full.shortages[1].work;
  assert(check > 0n, 'program-check work is bound before the first resource return');
  assert(failed > check, 'the failed arena attempt is not free');
  const exact = h.validate(p, doc, { arena: 8, allowance: h.work(full.budget) });
  assertEquals(exact.status, S.VALID);
  assertEquals(h.work(exact.budget), h.work(full.budget));
  const exhausted = h.validate(p, doc, { arena: 8, allowance: failed });
  assertEquals(exhausted.status, S.WORK_LIMIT_EXCEEDED);
  assertEquals(h.work(exhausted.budget), failed, 'no fresh attempt after equality');
});

Deno.test('direct failed setup and finite reference-chain/document work remain terminal errors', () => {
  const h = new MemoryCaller();
  const p = h.compile(true);
  const malformed = encode(Array.from({ length: 129 }, () => null));
  malformed[malformed.length - 1] = 0xc1;
  const bad = h.validate(p, malformed);
  assertEquals(bad.status, S.CORRUPT_DOCUMENT);
  assert(h.work(bad.budget) >= 129n);
  assertEquals(h.view.getUint32(bad.budget + BH.PHASE, true), B.PHASE.VALIDATION_SETUP);
  // str32 payload length wraps an old i32 skip back into the input range.
  const wrapped = new Uint8Array([0xdb, 0xff, 0xff, 0xff, 0xfb]);
  assertEquals(h.validate(p, wrapped).status, S.CORRUPT_DOCUMENT);
  const defs = { d0: true };
  for (let i = 1; i <= 12; i++) defs[`d${i}`] = { allOf: [
    { $ref: `#/$defs/d${i - 1}` }, { $ref: `#/$defs/d${i - 1}` },
  ] };
  const chain = { $defs: defs, $ref: '#/$defs/d12' };
  assertEquals(h.compile(chain, 1n).status, S.WORK_LIMIT_EXCEEDED);
  const compiled = h.compile(chain);
  assertEquals(compiled.status, S.OK);
  const exhausted = h.validate(compiled, null, { allowance: 10000n });
  assertEquals(exhausted.status, S.WORK_LIMIT_EXCEEDED);
  const array = h.compile({ items: { type: 'integer' } });
  assertEquals(h.validate(array, Array.from({ length: 10000 }, (_, i) => i), { allowance: 1000n }).status, S.WORK_LIMIT_EXCEEDED);
});

Deno.test('direct complete rendering retains evaluation, debits failed output, and chooses the next capacity', () => {
  const h = new MemoryCaller();
  const missing = '雪/~'.repeat(1000);
  const p = h.compile({ required: [missing] });
  const run = h.validate(p, {}, { mode: C.MODE.VALIDATE, errors: 1 });
  assertEquals(run.status, S.INVALID);
  const cont = run.scratch + h.view.getUint32(run.scratch + DH.RESULT_OFFSET, true);
  const sourceWork = h.x.validation_work_charged(cont);
  let cap = 8192;
  let out = h.alloc(cap);
  const before = h.work(run.budget);
  const short = h.x.render_error_direct(p.program, p.size, run.scratch, run.capacity, 0, out, cap, run.budget);
  assertEquals(short[0], S.BUFFER_TOO_SMALL);
  assert(short[1] > cap);
  const debt = h.work(run.budget);
  assert(debt > before);
  cap = short[1];
  out = h.alloc(cap);
  const [status, length] = h.x.render_error_direct(p.program, p.size, run.scratch, run.capacity, 0, out, cap, run.budget);
  assertEquals(status, S.OK);
  assertEquals(decode(h.bytes.slice(out, out + length)).params, { missingProperty: missing });
  assert(h.work(run.budget) > debt);
  assertEquals(h.x.validation_work_charged(cont), sourceWork);
  assertEquals(h.x.validation_result(cont), S.INVALID);
  const unchanged = h.work(run.budget);
  assertEquals(h.x.render_error_direct(p.program, p.size, run.scratch, run.capacity, 0, run.scratch, 8192, run.budget)[0], S.INVALID_ARGUMENT);
  assertEquals(h.work(run.budget), unchanged);
  const limited = h.validate(p, {}, { mode: C.MODE.VALIDATE, errors: 1, allowance: debt });
  assertEquals(limited.status, S.INVALID);
  out = h.alloc(8192);
  assertEquals(h.x.render_error_direct(p.program, p.size, limited.scratch, limited.capacity,
    0, out, 8192, limited.budget), [S.WORK_LIMIT_EXCEEDED, 0]);
  assertEquals(h.work(limited.budget), debt);
  assertEquals(h.x.render_error_direct(p.program, p.size, limited.scratch, limited.capacity,
    0, out, 8192, limited.budget), [S.WORK_LIMIT_EXCEEDED, 0]);
  assertEquals(h.work(limited.budget), debt, 'a render shortage cannot replenish its allowance');
});

Deno.test('direct program admission refuses corrupt deep offsets without reading another owner', () => {
  const h = new MemoryCaller();
  const original = h.compile({ allOf: [{ type: 'integer' }, { minimum: 0 }], $dynamicAnchor: 'here' });
  assertEquals(original.status, S.OK);
  const corruptions = [
    (v) => v.setUint32(P.HEADER_SIZE, 0x3ffffff0, true), // synthesized node pointer beyond actual memory: used to trap
    (v) => v.setUint32(P.HEADER.CODE_BYTES, 0xfffffff0, true), // wrapped region geometry
    (v) => v.setUint32(P.HEADER.RESOURCE_TABLE_OFFSET, 0xfffffff8, true),
    (v) => {
      const table = v.getUint32(P.HEADER.RESOURCE_TABLE_OFFSET, true);
      v.setUint32(table + 4, 0xfffffff0, true); // nested anchor list
    },
    (v) => {
      const code = v.getUint32(P.HEADER.CODE_OFFSET, true);
      const end = code + v.getUint32(P.HEADER.CODE_BYTES, true);
      for (let pc = code; pc < end; pc += 16) {
        if (v.getUint32(pc, true) === 18) { // ALL_OF's list count used to wrap *4
          v.setUint32(v.getUint32(pc + 4, true), 0x40000000, true);
          return;
        }
      }
      throw new Error('fixture did not contain allOf');
    },
  ];
  for (const corrupt of corruptions) {
    const bytes = original.bytes.slice();
    corrupt(new DataView(bytes.buffer));
    const program = { program: h.stage(bytes), size: bytes.length };
    assertEquals(h.x.validate_program(program.program, program.size), S.CORRUPT_PROGRAM);
    const run = h.validate(program, 1);
    assertEquals(run.status, S.CORRUPT_PROGRAM);
    assert(h.work(run.budget) > 0n, 'even failed deep checking is charged');
  }
  const b = h.budget();
  const scratch = h.alloc(64);
  const doc = h.stage(encode(1));
  assertEquals(h.x.validate_direct(0xfffffff8, 80, doc, 1, 0, 256, 0, 8, scratch, 64, b, 1, 0)[0], S.INVALID_ARGUMENT);
  assertEquals(h.x.compile_direct(doc, 1, 0, doc, 64, b, 1, 0)[0], S.INVALID_ARGUMENT);
  assertEquals(h.work(b), 0n);
});

Deno.test('failed helper rendering retains terminal diagnostics and aggregate retry debt', () => {
  const h = new MemoryCaller();
  const failed = h.compile({ $ref: '#/missing' });
  assertEquals(failed.status, S.SYNTAX_ERROR);
  const before = h.work(failed.budget);
  const output = h.alloc(2048);
  const render = (capacity, pointer = output) => h.x.render_failure_direct(
    failed.scratch, failed.capacity, pointer, capacity, failed.budget,
  );
  assertEquals(render(8), [S.BUFFER_TOO_SMALL, 2048]);
  const shortWork = h.work(failed.budget);
  assert(shortWork > before, 'failed output attempts are charged');
  const terminal = h.bytes.slice(failed.scratch, failed.scratch + failed.capacity);
  const [status, n] = render(2048);
  assertEquals(status, S.OK);
  assertEquals(decode(h.bytes.subarray(output, output + n)), {
    message: 'schema compile failed: SYNTAX_ERROR', status: 'SYNTAX_ERROR',
    diagnostic: 'REF_UNRESOLVABLE', keyword: '$ref', schemaOffset: 6, detail: 0,
  });
  assertEquals(h.bytes.subarray(failed.scratch, failed.scratch + failed.capacity), terminal);
  const renderWork = h.work(failed.budget) - shortWork;
  assert(renderWork > 0n);
  assertEquals(render(2048, failed.scratch), [S.INVALID_ARGUMENT, 0]);
  assertEquals(h.work(failed.budget), shortWork + renderWork);

  // A new explicit operation may choose an exact budget; output re-entry may
  // not replenish it, nor turn exhaustion into the original syntax refusal.
  for (const delta of [0n, -1n]) {
    const retry = h.compile({ $ref: '#/missing' }, before + renderWork + delta);
    assertEquals(retry.status, S.SYNTAX_ERROR);
    const answer = h.x.render_failure_direct(retry.scratch, retry.capacity, output, 2048, retry.budget);
    assertEquals(answer[0], delta === 0n ? S.OK : S.WORK_LIMIT_EXCEEDED);
    if (delta < 0n) {
      const consumed = h.work(retry.budget);
      assertEquals(h.x.render_failure_direct(retry.scratch, retry.capacity, output, 2048, retry.budget),
        [S.WORK_LIMIT_EXCEEDED, 0]);
      assertEquals(h.work(retry.budget), consumed);
    }
  }
});

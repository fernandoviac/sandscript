import { assertEquals } from "https://deno.land/std@0.208.0/assert/mod.ts";
import { freshSession } from "../../src/host-owned-session.js";

// Untrusted wire fixtures exercise the WAT structural boundary directly. They
// are deliberately not claimed to be well-typed declarations or proof evidence.
function wireFixture() {
  const words = [0x50524631, 2, 0, 0];
  const refs = {};
  function record(name, tag, ...payload) {
    const reference = words.length * 4;
    refs[name] = reference;
    words.push(payload.length + 2, tag, ...payload);
    return reference;
  }
  const zero = record("zero", 0x101, 0);
  const parameter = record("parameter", 0x101, 1, 0);
  const successor = record("successor", 0x101, 2, zero);
  const maximum = record("maximum", 0x101, 3, successor, parameter);
  record("imax", 0x101, 4, maximum, parameter);
  const sort = record("sort", 1, zero);
  const bound = record("bound", 2, 0);
  const empty = record("empty", 0x100, 0);
  const context = record("context", 0x102, 1, empty);
  const name = record("name", 0x10b, 0, 3, 0x0041004e); // N, NUL, A
  const numbered = record("numbered", 0x10c, name, 0xffffffff);
  // These limb and byte words resemble record headers/references, but are data.
  record("natural", 24, 4, 3, 0x101, zero + 4, 1);
  record("string", 25, 5, 0x80989ff0, 0); // U+1F600, NUL
  record("projection", 23, 4, 0, bound);
  const descriptor = record("descriptor", 0x104, sort, 0, numbered);
  const constructors = record("constructors", 0x100, 1, descriptor);
  const group = record("group", 0x105, 1, 4);
  const assumption = record("assumption", 0x200, context, sort, name);
  const definition = record("definition", 0x201, context, sort, bound, 0);
  const opaque = record("opaque", 0x202, context, sort, bound, 0);
  const theorem = record("theorem", 0x203, context, sort, bound, 0);
  const inductive = record("inductive", 0x204, context, sort, 0, 0, constructors, group, 0);
  const rule = record("rule", 0x10a, 4, 0, 0, bound);
  const rules = record("rules", 0x100, 1, rule);
  const recursor = record("recursor", 0x206, context, sort, 4, group, 0, 0, 1, 1, rules, 0, 0);
  const quotient = record("quotient", 0x207, context, sort, 0, 0);
  const declarations = record("declarations", 0x100, 7,
    assumption, definition, opaque, theorem, inductive, recursor, quotient);
  words[2] = words.length;
  words[3] = declarations;
  const bytes = new Uint8Array(words.length * 4);
  const view = new DataView(bytes.buffer);
  words.forEach((word, index) => view.setUint32(index * 4, word, true));
  return { bytes, refs };
}

function validator(bytes) {
  const session = freshSession();
  // The structural walk owns one record containing its marks and DFS stack.
  const workspace = 2 * bytes.length + 12;
  const base = session.mem.wasm.exports.test_carve_scratch(bytes.length + workspace);
  const destination = new Uint8Array(session.mem.buffer, session.mem.abs(base), bytes.length);
  const view = new DataView(destination.buffer, destination.byteOffset, destination.byteLength);
  return (mutate = () => {}) => {
    destination.set(bytes);
    mutate(view);
    const before = destination.slice();
    const result = session.mem.wasm.exports.proof_validate_artifact(base, bytes.length, workspace);
    assertEquals(destination, before, "validation must not mutate caller-owned artifact bytes");
    return result;
  };
}

Deno.test("v2 wire accepts DAG levels, scalar literals, structured names and named declaration metadata", () => {
  const { bytes } = wireFixture();
  assertEquals(validator(bytes)(), 0);
});

Deno.test("v2 wire rejects old versions, retired terms, source and private work records", () => {
  const { bytes, refs } = wireFixture();
  const check = validator(bytes);
  assertEquals(check((v) => v.setUint32(4, 1, true)) !== 0, true);
  for (const tag of [14, 17, 18, 19, 20, 21, 22, 0x10d, 0x10e, 0x10f, 0x110]) {
    assertEquals(check((v) => v.setUint32(refs.projection + 4, tag, true)) !== 0, true);
  }
});

Deno.test("v2 wire rejects forged graph edges and declaration-array boundaries", () => {
  const { bytes, refs } = wireFixture();
  const check = validator(bytes);
  const mutations = [
    [refs.sort + 8, 0],
    [refs.successor + 12, refs.zero + 4],
    [refs.maximum + 16, refs.sort],
    [refs.maximum + 12, refs.maximum],
    [refs.projection + 16, refs.name],
    [refs.name + 8, refs.numbered],
    [refs.numbered + 8, refs.bound],
    [refs.descriptor + 16, refs.sort],
    [refs.assumption + 16, refs.zero],
    [refs.rule + 20, refs.context],
    [refs.rules + 12, refs.descriptor],
    [refs.recursor + 20, refs.empty],
    [refs.recursor + 40, refs.constructors],
    [refs.recursor + 48, refs.bound],
    [refs.quotient + 20, refs.zero],
    [refs.declarations + 12, refs.assumption + 4],
    [12, refs.empty],
  ];
  for (const [offset, value] of mutations) {
    assertEquals(check((v) => v.setUint32(offset, value, true)) !== 0, true,
      `forged reference at byte ${offset}`);
  }
  assertEquals(check(), 0, "a rejected graph must not poison the next validation");
});

Deno.test("v2 wire rejects noncanonical scalar encodings and overflowing lengths", () => {
  const { bytes, refs } = wireFixture();
  const check = validator(bytes);
  for (const [offset, value] of [
    [refs.zero, 0x40000003],
    [refs.zero + 8, 1],
    [refs.parameter + 12, 0xffffffff],
    [refs.natural + 8, 0xffffffff],
    [refs.natural + 24, 0],
    [refs.projection + 8, 7],
    [refs.projection + 12, 0xffffffff],
    [refs.rule + 12, 0xffffffff],
    [refs.recursor + 44, 2],
    [refs.quotient + 16, 4],
    [refs.group + 12, 7],
    [refs.string + 8, 0xffffffff],
    [refs.name + 12, 0xffffffff],
  ]) {
    assertEquals(check((v) => v.setUint32(offset, value, true)) !== 0, true,
      `noncanonical scalar at byte ${offset}`);
  }
});

Deno.test("v2 wire rejects malformed UTF-8 and nonzero string or name padding", () => {
  const { bytes, refs } = wireFixture();
  const check = validator(bytes);
  for (const payload of [
    [0xc0, 0x80], // overlong NUL
    [0xe0, 0x80, 0x80], // overlong three-byte sequence
    [0xed, 0xa0, 0x80], // surrogate
    [0xf4, 0x90, 0x80, 0x80], // above U+10FFFF
    [0xf0, 0x9f, 0x98], // truncated scalar
    [0x80], // isolated continuation
  ]) {
    assertEquals(check((v) => {
      v.setUint32(refs.string + 8, 5, true);
      for (let i = 0; i < 8; i++) v.setUint8(refs.string + 12 + i, 0);
      payload.forEach((byte, i) => v.setUint8(refs.string + 12 + i, byte));
    }) !== 0, true);
  }
  assertEquals(check((v) => v.setUint8(refs.string + 19, 1)) !== 0, true);
  assertEquals(check((v) => v.setUint8(refs.name + 19, 1)) !== 0, true);
});

Deno.test("v2 wire detects cycles through ordinary arrays rather than relying on recursion fuel", () => {
  const words = [0x50524631, 2, 0, 0, 4, 0x100, 1, 16, 3, 0x100, 0];
  words[2] = words.length;
  words[3] = 32;
  const bytes = new Uint8Array(words.length * 4);
  const view = new DataView(bytes.buffer);
  words.forEach((word, i) => view.setUint32(i * 4, word, true));
  assertEquals(validator(bytes)() !== 0, true);
});

Deno.test("v2 wire reports resource exhaustion before recursive consumers see a deeply nested level", () => {
  const words = [0x50524631, 2, 0, 0, 3, 0x101, 0];
  let previous = 16;
  for (let i = 0; i < 600; i++) {
    const current = words.length * 4;
    words.push(4, 0x101, 2, previous);
    previous = current;
  }
  words[3] = words.length * 4;
  words.push(3, 0x100, 0);
  words[2] = words.length;
  const bytes = new Uint8Array(words.length * 4);
  const view = new DataView(bytes.buffer);
  words.forEach((word, i) => view.setUint32(i * 4, word, true));
  assertEquals(validator(bytes)(), 29);
});

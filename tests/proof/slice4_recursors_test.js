import { assertEquals } from "https://deno.land/std@0.208.0/assert/mod.ts";
import { freshSession } from "../../src/host-owned-session.js";
import { parseAndSetup } from "../fuel/test-helpers.js";
import { runState } from "./state-helpers.js";

function run(source) {
  const session = freshSession();
  parseAndSetup(session, source);
  let result;
  do {
    result = runState(session, 10_000_000);
  } while (result.status === "paused");
  assertEquals(result.status, "done");
  return session;
}

const helpers = `
  function app(f, args) {
    for (let i = 0; i < args.length; i++) f = Proof.Term.apply(f, args[i]);
    return f;
  }
  function assume(env, type) {
    let index = Proof.declarationCount(env);
    let next = Proof.assumption(env, type);
    return [next, Proof.Term.global(next, index)];
  }
  function rejects(term, type) {
    try { Proof.Term.check(term, type); return false; }
    catch (error) { return true; }
  }
  let U = Proof.Term.type(0);
  let base = Proof.assumption(Proof.Term.proposition());
  let ni = Proof.declarationCount(base);
  let nr = Proof.Term.inductiveReference(ni);
  let natEnv = Proof.inductive(base, U,
    Proof.Term.sequence([nr, Proof.Term.product(nr, nr)]), 0,
    Proof.Name.str(0, "RecTestNat"));
  let N = Proof.Term.inductive(natEnv, ni);
  let zero = Proof.Term.constructor(natEnv, ni, 0);
  let succ = Proof.Term.constructor(natEnv, ni, 1);
  let one = app(succ, [zero]);
  let two = app(succ, [one]);
`;

Deno.test("Slice4 generated recursor performs recursive iota and preserves trailing applications", () => {
  const session = run(`
    ${helpers}
    let rec = Proof.Term.recursor(natEnv, ni, 1);
    let motive = Proof.Term.lambda(N, N);
    let step = Proof.Term.lambda(N, Proof.Term.lambda(N, app(succ, [Proof.Term.bound(0)])));
    let evaluated = app(rec, [motive, zero, step, two]);
    let row = assume(natEnv, Proof.Term.product(N, U)); let env = row[0]; let F = row[1];
    row = assume(env, app(F, [two])); env = row[0]; let witness = row[1];
    let checked = Proof.Term.check(witness, app(F, [evaluated]));
    let identity = Proof.Term.lambda(N, Proof.Term.bound(0));
    let functionMotive = Proof.Term.lambda(N, Proof.Term.product(N, N));
    let functionStep = Proof.Term.lambda(N,
      Proof.Term.lambda(Proof.Term.product(N, N), Proof.Term.bound(0)));
    let trailing = app(rec, [functionMotive, identity, functionStep, two, two]);
    let trailingChecked = Proof.Term.check(witness, app(F, [trailing]));
    let sealed = Proof.definition(app(F, [trailing]), trailingChecked);
    let observed = [Proof.checkArtifact(Proof.artifact(sealed)),
      Proof.Term.isTerm(checked), rejects(witness, app(F, [app(rec, [motive, zero, step, one])]))];
  `);
  assertEquals(session.get(0, "observed"), [true, true, true]);
});

Deno.test("Slice4 indexed recursor eliminates exact result fields, not nested index occurrences", () => {
  const session = run(`
    ${helpers}
    let directIndex = Proof.declarationCount(natEnv);
    let directRef = Proof.Term.inductiveReference(directIndex);
    let directCtor = Proof.Term.product(N, app(directRef, [Proof.Term.bound(0)]));
    let directEnv = Proof.inductive(natEnv,
      Proof.Term.product(N, Proof.Term.proposition()), Proof.Term.sequence([directCtor]), 0);
    let Direct = Proof.Term.inductive(directEnv, directIndex);
    let directMajor = app(Proof.Term.constructor(directEnv, directIndex, 0), [two]);
    let directMotive = Proof.Term.lambda(N,
      Proof.Term.lambda(app(Direct, [Proof.Term.bound(0)]), N));
    let directRec = app(Proof.Term.recursor(directEnv, directIndex, 1),
      [directMotive, Proof.Term.lambda(N, Proof.Term.bound(0)), two, directMajor]);
    let row = assume(directEnv, Proof.Term.product(N, U)); let env = row[0]; let F = row[1];
    row = assume(env, app(F, [two])); env = row[0]; let witness = row[1];
    let checked = Proof.Term.check(witness, app(F, [directRec]));
    let published = Proof.definition(app(F, [directRec]), checked);

    let nestedIndex = Proof.declarationCount(natEnv);
    let nestedRef = Proof.Term.inductiveReference(nestedIndex);
    let nestedCtor = Proof.Term.product(N, app(nestedRef, [app(succ, [Proof.Term.bound(0)])]));
    let nestedEnv = Proof.inductive(natEnv,
      Proof.Term.product(N, Proof.Term.proposition()), Proof.Term.sequence([nestedCtor]), 0);
    let Nested = Proof.Term.inductive(nestedEnv, nestedIndex);
    let nestedMajor = app(Proof.Term.constructor(nestedEnv, nestedIndex, 0), [one]);
    let nestedMotive = Proof.Term.lambda(N,
      Proof.Term.lambda(app(Nested, [Proof.Term.bound(0)]), N));
    let nestedRec = app(Proof.Term.recursor(nestedEnv, nestedIndex),
      [nestedMotive, Proof.Term.lambda(N, Proof.Term.bound(0)), two, nestedMajor]);
    let rejected = false;
    try { Proof.Term.infer(nestedRec); } catch (error) { rejected = true; }
    let observed = [Proof.checkArtifact(Proof.artifact(published)), rejected,
      Proof.checkArtifact(Proof.artifact(nestedEnv))];
  `);
  assertEquals(session.get(0, "observed"), [true, true, true]);
});

Deno.test("Slice4 K reduction checks the neutral proof's exact indexed type", () => {
  const session = run(`
    ${helpers}
    let eqi = Proof.declarationCount(natEnv);
    let er = Proof.Term.inductiveReference(eqi);
    let et = Proof.Term.product(N, Proof.Term.product(N, Proof.Term.proposition()));
    let reflType = Proof.Term.product(N, app(er, [Proof.Term.bound(0), Proof.Term.bound(0)]));
    let eqEnv = Proof.inductive(natEnv, et, Proof.Term.sequence([reflType]), 1);
    let Eq = Proof.Term.inductive(eqEnv, eqi);
    let row = assume(eqEnv, app(Eq, [zero, zero])); let env = row[0]; let neutral = row[1];
    row = assume(env, app(Eq, [zero, one])); env = row[0]; let unequal = row[1];
    row = assume(env, Proof.Term.product(N, U)); env = row[0]; let F = row[1];
    row = assume(env, app(F, [zero])); env = row[0]; let witness = row[1];
    let motive = Proof.Term.lambda(N,
      Proof.Term.lambda(app(Eq, [zero, Proof.Term.bound(0)]), N));
    let rec = Proof.Term.recursor(env, eqi, 1);
    let good = app(rec, [zero, motive, zero, zero, neutral]);
    let bad = app(rec, [zero, motive, zero, one, unequal]);
    let checked = Proof.Term.check(witness, app(F, [good]));
    let observed = [Proof.checkArtifact(Proof.artifact(Proof.definition(app(F, [good]), checked))),
      rejects(witness, app(F, [bad]))];
  `);
  assertEquals(session.get(0, "observed"), [true, true]);
});

// An independent pointer-free mutual fixture. Its recursors are written from
// the mathematical Even/Odd signatures, not copied out of the implementation.
function mutualFixture() {
  const words = [0x50524631, 2, 0, 0];
  const refs = {};
  const record = (tag, ...payload) => {
    const ref = words.length * 4;
    words.push(payload.length + 2, tag, ...payload);
    return ref;
  };
  const zeroLevel = record(0x101, 0);
  const oneLevel = record(0x101, 2, zeroLevel);
  const uLevel = record(0x101, 1, 0);
  const empty = record(0x100, 0);
  const levels = record(0x100, 1, uLevel);
  const monomorphic = record(0x102, 0, empty);
  const polymorphic = record(0x102, 1, empty);
  const group = record(0x105, 2, 0, 1);
  const sort = (level) => ({ tag: 1, level });
  const ind = (index) => ({ tag: 4, index });
  const ctor = (index, ordinal) => ({ tag: 5, index, ordinal });
  const global = (index) => ({ tag: 3, index });
  const variable = (name) => ({ name });
  const pi = (name, domain, body) => ({ tag: 6, name, domain, body });
  const lam = (name, domain, body) => ({ tag: 7, name, domain, body });
  const app = (head, ...args) => args.reduce((f, x) => ({ tag: 8, f, x }), head);
  const E = ind(0), O = ind(1), ez = ctor(0, 0), es = ctor(0, 1), os = ctor(1, 0);
  const Ce = variable("Ce"), Co = variable("Co"), e = variable("e"), o = variable("o");
  const prefix = [
    ["Ce", pi("e", E, sort(uLevel))],
    ["Co", pi("o", O, sort(uLevel))],
    ["z", app(Ce, ez)],
    ["s", pi("o", O, pi("ih", app(Co, o), app(Ce, app(es, o))))],
    ["t", pi("e", E, pi("ih", app(Ce, e), app(Co, app(os, e))))],
  ];
  const wrap = (bind, body) => prefix.reduceRight((tail, [name, domain]) => bind(name, domain, tail), body);
  const compile = (t, scope = []) => {
    if (t.tag === undefined) {
      const index = scope.lastIndexOf(t.name);
      if (index < 0) throw new Error(`unbound fixture variable ${t.name}`);
      return record(2, scope.length - index - 1);
    }
    if (t.tag === 1) return record(1, t.level);
    if (t.tag === 3) return record(3, t.index, levels);
    if (t.tag === 4) return record(4, t.index, empty);
    if (t.tag === 5) return record(5, t.index, t.ordinal, empty);
    if (t.tag === 8) return record(8, compile(t.f, scope), compile(t.x, scope));
    return record(t.tag, compile(t.domain, scope), compile(t.body, [...scope, t.name]));
  };
  const eZeroType = compile(E);
  const eStepType = compile(pi("o", O, E));
  const oStepType = compile(pi("e", E, O));
  const eCtors = record(0x100, 2, record(0x104, eZeroType, 0, 0), record(0x104, eStepType, 0, 0));
  const oCtors = record(0x100, 1, record(0x104, oStepType, 0, 0));
  const universe = compile(sort(oneLevel));
  const eDecl = record(0x204, monomorphic, universe, 0, 0, eCtors, group, 0);
  const oDecl = record(0x204, monomorphic, universe, 0, 0, oCtors, group, 0);
  const common = prefix.map(([name]) => variable(name));
  const eZeroRhs = compile(wrap(lam, variable("z")));
  const eStepRhs = compile(wrap(lam, lam("o", O,
    app(variable("s"), o, app(global(3), ...common, o)))));
  const oStepRhs = compile(wrap(lam, lam("e", E,
    app(variable("t"), e, app(global(2), ...common, e)))));
  refs.eStepRule = record(0x10a, 0, 1, 1, eStepRhs);
  const eRules = record(0x100, 2, record(0x10a, 0, 0, 0, eZeroRhs), refs.eStepRule);
  const oRules = record(0x100, 1, record(0x10a, 1, 0, 1, oStepRhs));
  const eType = compile(wrap(pi, pi("e", E, app(Ce, e))));
  const oType = compile(wrap(pi, pi("o", O, app(Co, o))));
  refs.eRec = record(0x206, polymorphic, eType, 0, group, 0, 0, 2, 3, eRules, 0, 0);
  refs.oRec = record(0x206, polymorphic, oType, 1, group, 0, 0, 2, 3, oRules, 0, 0);
  refs.eZeroRhs = eZeroRhs;
  refs.eType = eType;
  refs.oType = oType;
  words[3] = record(0x100, 4, eDecl, oDecl, refs.eRec, refs.oRec);
  words[2] = words.length;
  const bytes = new Uint8Array(words.length * 4);
  const view = new DataView(bytes.buffer);
  words.forEach((word, i) => view.setUint32(i * 4, word, true));
  return { bytes, refs };
}

function checkFixture(bytes) {
  const session = freshSession();
  const workspace = 2 * 1024 * 1024;
  const base = session.mem.wasm.exports.test_carve_scratch(bytes.length + workspace);
  new Uint8Array(session.mem.buffer, session.mem.abs(base), bytes.length).set(bytes);
  return session.mem.wasm.exports.proof_check_artifact(base, bytes.length, workspace);
}

Deno.test("Slice4 independently authored mutual recursors check with cross-family induction hypotheses", () => {
  assertEquals(checkFixture(mutualFixture().bytes), 0);
});

Deno.test("Slice4 artifact checking rejects forged recursor owner, counts, type, K flag and underapplied RHS", () => {
  const { bytes, refs } = mutualFixture();
  for (const [offset, value] of [
    [refs.eRec + 16, 1],
    [refs.eRec + 24, 1],
    [refs.eRec + 28, 1],
    [refs.eRec + 32, 1],
    [refs.eRec + 36, 2],
    [refs.eRec + 44, 1],
    [refs.eRec + 12, refs.oType],
    [refs.eStepRule + 12, 0],
    [refs.eStepRule + 16, 0],
    [refs.eStepRule + 20, refs.eZeroRhs],
  ]) {
    const forged = bytes.slice();
    new DataView(forged.buffer).setUint32(offset, value, true);
    assertEquals(checkFixture(forged) !== 0, true, `forged recursor word at ${offset}`);
  }
});

import { assertEquals } from "https://deno.land/std@0.208.0/assert/mod.ts";
import { freshSession } from "../../src/host-owned-session.js";
import { parseAndSetup } from "../fuel/test-helpers.js";
import { runState } from "./state-helpers.js";

function run(source) {
  const session = freshSession();
  parseAndSetup(session, source);
  const result = runState(session, 10_000_000);
  assertEquals(result.status, "done");
  return session;
}

const setup = `
  function app(f, args) {
    for (let i = 0; i < args.length; i++) f = Proof.Term.apply(f, args[i]);
    return f;
  }
  function rejects(f) {
    try { f(); return false; } catch (error) { return true; }
  }
  let core = Proof.Core.environment();
  let env = Proof.quotient(core);
  let natIndex = Proof.declarationIndex(env, Proof.Name.str(0, "Nat"));
  let eqIndex = Proof.declarationIndex(env, Proof.Name.str(0, "Eq"));
  let quotName = Proof.Name.str(0, "Quot");
  let quotIndex = Proof.declarationIndex(env, quotName);
  let mkIndex = Proof.declarationIndex(env, Proof.Name.str(quotName, "mk"));
  let liftIndex = Proof.declarationIndex(env, Proof.Name.str(quotName, "lift"));
  let indIndex = Proof.declarationIndex(env, Proof.Name.str(quotName, "ind"));
  let nat = Proof.Term.global(env, natIndex);
  let zero = Proof.Term.constructor(env, natIndex, 0);
  let eq = Proof.Term.global(env, eqIndex, 1);
  let refl = Proof.Term.constructor(env, eqIndex, 0, 1);
  let p = app(eq, [nat, zero, zero]);
  let hz = app(refl, [nat, zero]);
  let r = Proof.Term.lambda(nat, Proof.Term.lambda(nat,
    app(eq, [nat, Proof.Term.bound(1), Proof.Term.bound(0)])));
  let qtype = app(Proof.Term.global(env, quotIndex, 1), [nat, r]);
  let qzero = app(Proof.Term.global(env, mkIndex, 1), [nat, r, zero]);
`;

Deno.test("quotient lift computes with checked respect and preserves trailing application", () => {
  const session = run(setup + `
    let id = Proof.Term.lambda(nat, Proof.Term.bound(0));
    let respect = Proof.Term.lambda(nat, Proof.Term.lambda(nat,
      Proof.Term.lambda(app(eq, [nat, Proof.Term.bound(1), Proof.Term.bound(0)]),
        Proof.Term.bound(0))));
    let lifted = app(Proof.Term.global(env, liftIndex, 1, 1),
      [nat, r, nat, id, respect, qzero]);
    let equality = app(eq, [nat, lifted, zero]);
    let theorem = Proof.theorem(equality, hz);

    let arrow = Proof.Term.product(nat, nat);
    let constantId = Proof.Term.lambda(nat, id);
    let idRefl = app(refl, [arrow, id]);
    let respectFunction = Proof.Term.lambda(nat, Proof.Term.lambda(nat,
      Proof.Term.lambda(app(eq, [nat, Proof.Term.bound(1), Proof.Term.bound(0)]),
        idRefl)));
    let trailing = app(Proof.Term.global(env, liftIndex, 1, 1),
      [nat, r, arrow, constantId, respectFunction, qzero, zero]);
    let trailingTheorem = Proof.theorem(app(eq, [nat, trailing, zero]), hz);
    let repeated = Proof.quotient(env);
    let observed = [
      Proof.checkArtifact(Proof.Theorem.artifact(theorem)),
      Proof.checkArtifact(Proof.Theorem.artifact(trailingTheorem)),
      Proof.declarationCount(repeated) === Proof.declarationCount(env),
      Proof.checkArtifact(Proof.artifact(repeated)),
      Proof.declarationCount(core) + 4 === Proof.declarationCount(env)
    ];
  `);
  assertEquals(session.get(0, "observed"), [true, true, true, true, true]);
});

Deno.test("quotient induction is dependent and Prop-only, over arbitrary Sort levels", () => {
  const session = run(setup + `
    let motive = Proof.Term.lambda(qtype,
      app(eq, [qtype, Proof.Term.bound(0), Proof.Term.bound(0)]));
    let branch = Proof.Term.lambda(nat, app(refl, [qtype,
      app(Proof.Term.global(env, mkIndex, 1), [nat, r, Proof.Term.bound(0)])]));
    let induction = app(Proof.Term.global(env, indIndex, 1),
      [nat, r, motive, branch, qzero]);
    let theorem = Proof.theorem(app(eq, [qtype, qzero, qzero]), induction);
    let typeMotive = Proof.Term.lambda(qtype, nat);
    let wrongMotive = rejects(() => Proof.Term.infer(
      app(Proof.Term.global(env, indIndex, 1),
        [nat, r, typeMotive, Proof.Term.lambda(nat, zero), qzero])));

    let proofRelation = Proof.Term.lambda(p, Proof.Term.lambda(p, p));
    let proofQuotient = app(Proof.Term.global(env, quotIndex, 0), [p, proofRelation]);
    let proofMk = app(Proof.Term.global(env, mkIndex, 0), [p, proofRelation, hz]);
    Proof.Term.check(proofMk, proofQuotient);
    Proof.Term.check(proofQuotient, Proof.Term.proposition());

    let typeZero = Proof.Term.type(0);
    let typeRelation = Proof.Term.lambda(typeZero, Proof.Term.lambda(typeZero, p));
    let largeQuotient = app(Proof.Term.global(env, quotIndex, 2), [typeZero, typeRelation]);
    let largeMk = app(Proof.Term.global(env, mkIndex, 2), [typeZero, typeRelation, nat]);
    Proof.Term.check(largeMk, largeQuotient);
    Proof.Term.check(largeQuotient, Proof.Term.type(1));
    let wrongUniverse = rejects(() => Proof.Term.infer(
      app(Proof.Term.global(env, mkIndex, 0), [nat, r, zero])));
    let observed = [Proof.checkArtifact(Proof.Theorem.artifact(theorem)), wrongMotive,
      wrongUniverse, Proof.Term.isTerm(proofMk), Proof.Term.isTerm(largeMk)];
  `);
  assertEquals(session.get(0, "observed"), [true, true, true, true, true]);
});

Deno.test("quotient lift rejects malformed respect proofs and mismatched major instances", () => {
  const session = run(setup + `
    let id = Proof.Term.lambda(nat, Proof.Term.bound(0));
    let malformed = rejects(() => Proof.Term.infer(
      app(Proof.Term.global(env, liftIndex, 1, 1), [nat, r, nat, id, zero, qzero])));
    let omitted = rejects(() => Proof.Term.infer(
      app(Proof.Term.global(env, liftIndex, 1, 1), [nat, r, nat, id, qzero])));
    let constantRelation = Proof.Term.lambda(nat, Proof.Term.lambda(nat, p));
    let respect = Proof.Term.lambda(nat, Proof.Term.lambda(nat,
      Proof.Term.lambda(app(eq, [nat, Proof.Term.bound(1), Proof.Term.bound(0)]),
        Proof.Term.bound(0))));
    let otherMajor = app(Proof.Term.global(env, mkIndex, 1), [nat, constantRelation, zero]);
    let mismatch = rejects(() => Proof.Term.infer(
      app(Proof.Term.global(env, liftIndex, 1, 1), [nat, r, nat, id, respect, otherMajor])));
    let observed = [malformed, omitted, mismatch, Proof.checkArtifact(Proof.artifact(env))];
  `);
  assertEquals(session.get(0, "observed"), [true, true, true, true]);
});

Deno.test("quotient installation rejects collisions and forged package types atomically", () => {
  const session = run(setup + `
    let collision = Proof.definition(Proof.Term.type(0),
      Proof.Term.global(core, natIndex), quotName);
    let collisionCount = Proof.declarationCount(collision);
    let collisionRejected = rejects(() => Proof.quotient(collision));
    let bytes = Proof.artifact(env);
    function word(offset) {
      return (bytes[offset] | (bytes[offset + 1] << 8) |
        (bytes[offset + 2] << 16) | (bytes[offset + 3] << 24)) >>> 0;
    }
    function put(offset, value) {
      bytes[offset] = value & 255;
      bytes[offset + 1] = (value >>> 8) & 255;
      bytes[offset + 2] = (value >>> 16) & 255;
      bytes[offset + 3] = (value >>> 24) & 255;
    }
    let declarations = word(12);
    let liftDecl = word(declarations + 12 + liftIndex * 4);
    let mkDecl = word(declarations + 12 + mkIndex * 4);
    let liftType = word(liftDecl + 12);
    put(liftDecl + 12, word(mkDecl + 12));
    let forgedType = !Proof.checkArtifact(bytes);
    put(liftDecl + 12, liftType);
    put(liftDecl + 16, 1);
    let forgedKind = !Proof.checkArtifact(bytes);
    put(liftDecl + 16, 2);
    put(declarations, word(declarations) - 1);
    put(declarations + 8, word(declarations + 8) - 1);
    put(8, word(8) - 1);
    let partialPackage = !Proof.checkArtifact(bytes.slice(0, bytes.length - 4));
    let naturalCore = Proof.Core.Natural.environment();
    let missingEq = rejects(() => Proof.quotient(naturalCore));
    let naturalCoreIndex = Proof.declarationIndex(naturalCore, Proof.Name.str(0, "Nat"));
    let fakeEq = Proof.definition(Proof.Term.type(0),
      Proof.Term.global(naturalCore, naturalCoreIndex), Proof.Name.str(0, "Eq"));
    let malformedEq = rejects(() => Proof.quotient(fakeEq));
    let observed = [collisionRejected, Proof.declarationCount(collision) === collisionCount,
      Proof.checkArtifact(Proof.artifact(collision)), forgedType, forgedKind,
      partialPackage, missingEq, malformedEq,
      Proof.checkArtifact(Proof.artifact(env))];
  `);
  assertEquals(session.get(0, "observed"), [true, true, true, true, true, true, true, true, true]);
});

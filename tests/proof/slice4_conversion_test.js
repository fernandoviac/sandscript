import { assertEquals } from "https://deno.land/std@0.208.0/assert/mod.ts";
import { freshSession } from "../../src/host-owned-session.js";
import { parseAndSetup } from "../fuel/test-helpers.js";

function run(source) {
  const session = freshSession();
  parseAndSetup(session, source);
  let result;
  do {
    result = session.run(0, 10_000_000);
  } while (result.status === "paused");
  assertEquals(result.status, "done");
  return session;
}

const assumptionHelpers = `
  function assume(environment, type) {
    let index = Proof.declarationCount(environment);
    let next = Proof.assumption(environment, type);
    return [next, Proof.Term.global(next, index)];
  }
  function rejects(term, type) {
    try { Proof.Term.check(term, type); return false; }
    catch (error) { return true; }
  }
`;

Deno.test("Slice4 proof irrelevance checks both proofs and their proposition types", () => {
  const session = run(`
    ${assumptionHelpers}
    let prop = Proof.Term.proposition();
    let type = Proof.Term.type(0);
    let env = Proof.assumption(prop);
    let P = Proof.Term.global(env, 0);
    let row = assume(env, P); env = row[0]; let p = row[1];
    row = assume(env, P); env = row[0]; let q = row[1];
    row = assume(env, Proof.Term.product(P, type)); env = row[0]; let F = row[1];
    row = assume(env, Proof.Term.apply(F, p)); env = row[0]; let witness = row[1];
    let checked = Proof.Term.check(witness, Proof.Term.apply(F, q));
    let published = Proof.definition(Proof.Term.apply(F, q), checked);
    row = assume(env, prop); env = row[0]; let Q = row[1];
    row = assume(env, Q); env = row[0]; let otherProof = row[1];
    // Beta would erase the bad argument. It must still be checked before
    // proof irrelevance can inspect the resulting proposition type.
    let forged = Proof.Term.apply(Proof.Term.lambda(P, p), type);
    let observed = [
      Proof.checkArtifact(Proof.artifact(published)),
      rejects(witness, Proof.Term.apply(F, otherProof)),
      rejects(witness, Proof.Term.apply(F, forged)),
      rejects(p, Q),
    ];
  `);
  assertEquals(session.get(0, "observed"), [true, true, true, true]);
});

Deno.test("Slice4 function eta preserves open binder contexts and rejects different functions", () => {
  const session = run(`
    ${assumptionHelpers}
    let type = Proof.Term.type(0);
    let env = Proof.assumption(type);
    let A = Proof.Term.global(env, 0);
    let functionType = Proof.Term.product(A, A);
    let row = assume(env, functionType); env = row[0]; let f = row[1];
    row = assume(env, Proof.Term.product(functionType, type)); env = row[0]; let F = row[1];
    row = assume(env, Proof.Term.apply(F, f)); env = row[0]; let witness = row[1];
    let expansion = Proof.Term.lambda(A, Proof.Term.apply(f, Proof.Term.bound(0)));
    let checked = Proof.Term.check(witness, Proof.Term.apply(F, expansion));
    let dependentBody = Proof.Term.lambda(functionType,
      Proof.Term.lambda(Proof.Term.apply(F, Proof.Term.bound(0)), Proof.Term.bound(0)));
    let dependentType = Proof.Term.product(functionType,
      Proof.Term.product(Proof.Term.apply(F, Proof.Term.bound(0)),
        Proof.Term.apply(F, Proof.Term.lambda(A,
          Proof.Term.apply(Proof.Term.bound(2), Proof.Term.bound(0))))));
    let dependent = Proof.Term.check(dependentBody, dependentType);
    let published = Proof.definition(dependentType, dependent);
    let observed = [
      Proof.Term.isTerm(checked),
      Proof.checkArtifact(Proof.artifact(published)),
      rejects(witness, Proof.Term.apply(F, Proof.Term.lambda(A, Proof.Term.bound(0)))),
      rejects(witness, Proof.Term.apply(F,
        Proof.Term.lambda(Proof.Term.proposition(), Proof.Term.bound(0)))),
    ];
  `);
  assertEquals(session.get(0, "observed"), [true, true, true, true]);
});

Deno.test("Slice4 structure eta includes neutral unit inhabitants but not multiple constructors", () => {
  const session = run(`
    ${assumptionHelpers}
    let type = Proof.Term.type(0);
    let base = Proof.assumption(type);
    let A = Proof.Term.global(base, 0);
    let familyIndex = Proof.declarationCount(base);
    let unitEnv = Proof.inductive(base, type,
      Proof.Term.sequence([Proof.Term.inductiveReference(familyIndex)]), 0);
    let Unit = Proof.Term.inductive(unitEnv, familyIndex);
    let row = assume(unitEnv, Unit); let env = row[0]; let u = row[1];
    row = assume(env, Unit); env = row[0]; let v = row[1];
    row = assume(env, Proof.Term.product(Unit, type)); env = row[0]; let F = row[1];
    row = assume(env, Proof.Term.apply(F, u)); env = row[0]; let witness = row[1];
    let unitProof = Proof.Term.check(witness, Proof.Term.apply(F, v));
    let unitPublished = Proof.definition(Proof.Term.apply(F, v), unitProof);

    let boxIndex = Proof.declarationCount(base);
    let boxEnv = Proof.inductive(base, type,
      Proof.Term.sequence([Proof.Term.product(A, Proof.Term.inductiveReference(boxIndex))]), 0);
    let Box = Proof.Term.inductive(boxEnv, boxIndex);
    row = assume(boxEnv, Box); env = row[0]; let box = row[1];
    row = assume(env, Proof.Term.product(Box, type)); env = row[0]; let G = row[1];
    row = assume(env, Proof.Term.apply(G, box)); env = row[0]; let boxWitness = row[1];
    let rebuilt = Proof.Term.apply(Proof.Term.constructor(env, boxIndex, 0),
      Proof.Term.projection(env, boxIndex, 0, box));
    let boxProof = Proof.Term.check(boxWitness, Proof.Term.apply(G, rebuilt));
    let boxPublished = Proof.definition(Proof.Term.apply(G, rebuilt), boxProof);

    let twoIndex = Proof.declarationCount(base);
    let twoEnv = Proof.inductive(base, type, Proof.Term.sequence([
      Proof.Term.inductiveReference(twoIndex), Proof.Term.inductiveReference(twoIndex)]), 0);
    let Two = Proof.Term.inductive(twoEnv, twoIndex);
    let first = Proof.Term.constructor(twoEnv, twoIndex, 0);
    let second = Proof.Term.constructor(twoEnv, twoIndex, 1);
    row = assume(twoEnv, Proof.Term.product(Two, type)); env = row[0]; let H = row[1];
    row = assume(env, Proof.Term.apply(H, first)); env = row[0]; let twoWitness = row[1];
    let observed = [
      Proof.checkArtifact(Proof.artifact(unitPublished)),
      Proof.checkArtifact(Proof.artifact(boxPublished)),
      rejects(twoWitness, Proof.Term.apply(H, second)),
    ];
  `);
  assertEquals(session.get(0, "observed"), [true, true, true]);
});

Deno.test("Slice4 delta unfolds definitions but not opaque declarations and sorts are noncumulative", () => {
  const session = run(`
    ${assumptionHelpers}
    let prop = Proof.Term.proposition();
    let type = Proof.Term.type(0);
    let transparent = Proof.definition(type, prop);
    let opaque = Proof.opaqueDefinition(type, prop);
    let transparentType = Proof.Term.global(transparent, 0);
    let opaqueType = Proof.Term.global(opaque, 0);
    let expected = Proof.Term.product(prop, prop);
    let transparentIdentity = Proof.Term.lambda(transparentType, Proof.Term.bound(0));
    let opaqueIdentity = Proof.Term.lambda(opaqueType, Proof.Term.bound(0));
    let checked = Proof.Term.check(transparentIdentity, expected);
    let published = Proof.definition(expected, checked);
    let observed = [
      Proof.checkArtifact(Proof.artifact(published)),
      rejects(opaqueIdentity, expected),
      rejects(prop, Proof.Term.type(1)),
      rejects(type, type),
    ];
  `);
  assertEquals(session.get(0, "observed"), [true, true, true, true]);
});

Deno.test("Slice4 zeta substitutes checked let values before dependent inference", () => {
  const session = run(`
    ${assumptionHelpers}
    let prop = Proof.Term.proposition();
    let type = Proof.Term.type(0);
    let expected = Proof.Term.product(prop, prop);
    let dependent = Proof.Term.localDefinition(type, prop,
      Proof.Term.lambda(prop, Proof.Term.apply(
        Proof.Term.lambda(Proof.Term.bound(1), Proof.Term.bound(0)),
        Proof.Term.bound(0))));
    let checked = Proof.Term.check(dependent, expected);
    let published = Proof.definition(expected, checked);
    let forged = Proof.Term.localDefinition(prop, type,
      Proof.Term.lambda(prop, Proof.Term.bound(0)));
    let observed = [
      Proof.checkArtifact(Proof.artifact(published)),
      rejects(forged, expected),
    ];
  `);
  assertEquals(session.get(0, "observed"), [true, true]);
});

Deno.test("Slice4 application spines preserve dependent domains and reject beta-erased bad arguments", () => {
  const session = run(`
    ${assumptionHelpers}
    let T = Proof.Term;
    let type = T.type(0);
    let env = Proof.assumption(type);
    let A = T.global(env, 0);
    let row = assume(env, A); env = row[0]; let a = row[1];
    row = assume(env, type); env = row[0]; let B = row[1];
    row = assume(env, B); env = row[0]; let b = row[1];
    row = assume(env, T.product(A, type)); env = row[0]; let F = row[1];
    row = assume(env, T.apply(F, a)); env = row[0]; let witness = row[1];
    let select = T.lambda(type, T.lambda(T.bound(0),
      T.lambda(type, T.lambda(T.bound(0), T.bound(2)))));
    let first = T.apply(T.apply(select, A), a);
    let partial = T.apply(first, B);
    let applied = T.apply(partial, b);
    let checked = T.check(witness, T.apply(F, applied));
    let published = Proof.definition(T.apply(F, applied), checked);
    let partialPublished = Proof.definition(T.product(B, A), partial);

    // The remaining telescope is an application, not syntactically a Product.
    // Pending arguments must be substituted before forcing that boundary.
    let barrier = T.lambda(type, T.apply(
      T.lambda(type, T.lambda(T.bound(0), T.bound(0))), T.bound(0)));
    let throughBarrier = T.apply(T.apply(barrier, A), a);
    let barrierChecked = T.check(witness, T.apply(F, throughBarrier));
    let barrierPublished = Proof.definition(T.apply(F, throughBarrier), barrierChecked);
    let wrongFirst = T.apply(T.apply(T.apply(T.apply(select, A), b), B), b);
    let erasedWrongLast = T.apply(partial, a);
    let observed = [
      Proof.checkArtifact(Proof.artifact(published)),
      Proof.checkArtifact(Proof.artifact(partialPublished)),
      Proof.checkArtifact(Proof.artifact(barrierPublished)),
      rejects(witness, T.apply(F, wrongFirst)),
      rejects(witness, T.apply(F, erasedWrongLast)),
    ];
  `);
  assertEquals(session.get(0, "observed"), [true, true, true, true, true]);
});

Deno.test("Slice4 artifact recheck rejects a forged proof despite proof irrelevance", () => {
  const session = run(`
    let prop = Proof.Term.proposition();
    let identityType = Proof.Term.product(prop,
      Proof.Term.product(Proof.Term.bound(0), Proof.Term.bound(1)));
    let identity = Proof.Term.lambda(prop,
      Proof.Term.lambda(Proof.Term.bound(0), Proof.Term.bound(0)));
    let theorem = Proof.theorem(identityType, identity);
    let artifact = Proof.Theorem.artifact(theorem);
  `);
  const artifact = new Uint8Array(session.get(0, "artifact"));
  const view = new DataView(artifact.buffer);
  const declarations = view.getUint32(12, true);
  const declaration = view.getUint32(declarations + 12, true);
  const outerLambda = view.getUint32(declaration + 16, true);
  const innerLambda = view.getUint32(outerLambda + 12, true);
  const body = view.getUint32(innerLambda + 12, true);
  assertEquals(view.getUint32(body + 4, true), 2);
  // Keep the wire graph canonical but replace the proof binder with the
  // outer proposition binder. P is a type, not a proof of itself.
  view.setUint32(body + 8, 1, true);
  const rejected = run(`
    let artifact = new Uint8Array([${Array.from(artifact).join(",")}]);
    let rejected = !Proof.checkArtifact(artifact);
  `);
  assertEquals(rejected.get(0, "rejected"), true);
});

import { assertEquals } from "https://deno.land/std@0.208.0/assert/mod.ts";
import {
  freshSession,
  restoreSession,
  snapshotSession,
} from "../../src/host-owned-session.js";
import { parseAndSetup } from "../fuel/test-helpers.js";

function runToDone(session, fuel = 10_000_000) {
  let result = session.run(0, fuel);
  for (let attempts = 0;
    (result.status === "memory_pressure" || result.status === "paused") && attempts < 500;
    attempts += 1) {
    if (result.status === "memory_pressure") session.gc();
    result = session.run(0, fuel);
  }
  assertEquals(result.status, "done");
  return result;
}

function run(source) {
  const session = freshSession();
  parseAndSetup(session, source);
  const result = runToDone(session, 10_000_000);
  assertEquals(result.status, "done");
  return session;
}

Deno.test("native Proof.Term builds canonical core term forms in WAT", () => {
  const session = run(`
    let proposition = Proof.Term.proposition();
    let typeZero = Proof.Term.type(0);
    let boundZero = Proof.Term.bound(0);
    let product = Proof.Term.product(typeZero, boundZero);
    let lambda = Proof.Term.lambda(typeZero, boundZero);
    let application = Proof.Term.apply(lambda, typeZero);
    let naturalLiteral = Proof.Term.naturalLiteral(Proof.Core.Natural.environment(), 42n);
    let localDefinition = Proof.Term.localDefinition(
      typeZero,
      proposition,
      Proof.Term.bound(0)
    );
    let recursiveReference = Proof.Term.recursiveReference(3);
    let inductiveReference = Proof.Term.inductiveReference(4);
    let branch = Proof.Term.branch(0, boundZero);
    let branches = Proof.Term.sequence([branch]);
    let match = Proof.Term.match(typeZero, boundZero, branches);
    let recursiveDefinition = Proof.Term.recursiveDefinition(typeZero, lambda, 0);
    let recursiveDefinitions = Proof.Term.sequence([recursiveDefinition]);
    let fixedPoint = Proof.Term.fixedPoint(recursiveDefinitions, 0);
    let cofixedPoint = Proof.Term.cofixedPoint(recursiveDefinitions, 0);
    let nestedFixedPoint = Proof.Term.fixedPoint(
      Proof.Term.sequence([recursiveDefinition]),
      0
    );
    let result = [
      Proof.Term.isTerm(proposition),
      Proof.Term.isTerm(typeZero),
      Proof.Term.isTerm(boundZero),
      Proof.Term.isTerm(product),
      Proof.Term.isTerm(lambda),
      Proof.Term.isTerm(application),
      Proof.Term.isTerm(naturalLiteral),
      Proof.Term.isTerm(localDefinition),
      Proof.Term.isTerm(recursiveReference),
      Proof.Term.isTerm(inductiveReference),
      Proof.Term.isTerm(branch),
      Proof.Term.isTerm(branches),
      Proof.Term.isTerm(match),
      Proof.Term.isTerm(recursiveDefinition),
      Proof.Term.isTerm(fixedPoint),
      Proof.Term.isTerm(cofixedPoint),
      Proof.Term.isTerm(nestedFixedPoint),
      Proof.Term.tag(proposition),
      Proof.Term.tag(typeZero),
      Proof.Term.tag(boundZero),
      Proof.Term.tag(product),
      Proof.Term.tag(lambda),
      Proof.Term.tag(application),
      Proof.Term.tag(naturalLiteral),
      Proof.Term.tag(localDefinition),
      Proof.Term.tag(recursiveReference),
      Proof.Term.tag(inductiveReference),
      Proof.Term.tag(branch),
      Proof.Term.tag(match),
      Proof.Term.tag(recursiveDefinition),
      Proof.Term.tag(fixedPoint),
      Proof.Term.tag(cofixedPoint),
      Proof.Term.tag(nestedFixedPoint),
    ];
  `);

  assertEquals(session.get(0, "result"), [
    true, true, true, true, true, true, true, true, true, true, true, false,
    true, true, true, true, true, 1, 1, 2, 6, 7, 8, 24, 9, 13, 4, 15, 10,
    16, 11, 12, 11,
  ]);
});

Deno.test("native Proof.Term handles survive collector relocation", () => {
  const session = run(`
    let proofType = Proof.Term.type(0);
    let identityBody = Proof.Term.bound(0);
    let identity = Proof.Term.lambda(proofType, identityBody);
    let branch = Proof.Term.branch(0, identity);
    let branches = Proof.Term.sequence([branch]);
    let match = Proof.Term.match(proofType, identityBody, branches);
    let recursiveDefinition = Proof.Term.recursiveDefinition(proofType, identity, 0);
    let recursiveDefinitions = Proof.Term.sequence([recursiveDefinition]);
    let fixedPoint = Proof.Term.fixedPoint(recursiveDefinitions, 0);
  `);

  session.gc();
  const parseResult = session.parse(`
    let result = [
      Proof.Term.isTerm(identity),
      Proof.Term.tag(identity),
      Proof.Term.tag(proofType),
      Proof.Term.tag(identityBody),
      Proof.Term.tag(branch),
      Proof.Term.isTerm(branches),
      Proof.Term.tag(match),
      Proof.Term.tag(fixedPoint),
    ];
  `);
  session.mem.setContextInstructionIndex(0, parseResult.startIndex);
  const result = runToDone(session, 10_000_000);
  assertEquals(result.status, "done");
  assertEquals(session.get(0, "result"), [true, 7, 1, 2, 15, false, 10, 11]);
});

Deno.test("native Proof.theorem checks and seals a proof term in WAT", () => {
  const session = run(`
    let propositionSort = Proof.Term.proposition();
    let premise = Proof.Term.bound(0);
    let conclusion = Proof.Term.bound(1);
    let implication = Proof.Term.product(premise, conclusion);
    let proposition = Proof.Term.product(propositionSort, implication);

    let localPremise = Proof.Term.bound(0);
    let innerProof = Proof.Term.lambda(premise, localPremise);
    let proof = Proof.Term.lambda(propositionSort, innerProof);
    let theorem = Proof.theorem(proposition, proof);
    let inspectedProposition = Proof.Theorem.proposition(theorem);
    let inspectedProof = Proof.Theorem.proofTerm(theorem);
    let artifact = Proof.Theorem.artifact(theorem);
    let validArtifactAccepted = Proof.checkArtifact(artifact);
    let validArtifactError = Proof.errorCode();
    let loadedTheorem = Proof.loadArtifact(artifact, 0);
    let loadedProposition = Proof.Theorem.proposition(loadedTheorem);
    let repeatedProposition =
      Proof.Term.product(loadedProposition, loadedProposition);
    let repeatedProof =
      Proof.Term.lambda(loadedProposition, Proof.Term.bound(0));
    let resealedTheorem = Proof.theorem(repeatedProposition, repeatedProof);
    let globalProof = Proof.Term.global(loadedTheorem, 0);
    let dependentTheorem =
      Proof.theorem(loadedProposition, globalProof);
    let loadedDependentTheorem =
      Proof.loadArtifact(Proof.Theorem.artifact(dependentTheorem), 1);
    artifact[0] = 0;
    let corruptArtifactRejected = !Proof.checkArtifact(artifact);
    let corruptArtifactError = Proof.errorCode();
    let theoremUnaffected = Proof.checkArtifact(Proof.Theorem.artifact(theorem));
    let unaffectedArtifactError = Proof.errorCode();
    let loadedTheoremUnaffected =
      Proof.checkArtifact(Proof.Theorem.artifact(loadedTheorem));
    let result = [
      Proof.Theorem.isTheorem(theorem),
      Proof.Theorem.isTheorem(proposition),
      Proof.Term.isTerm(theorem),
      Proof.Term.isTerm(inspectedProposition),
      Proof.Term.isTerm(inspectedProof),
      Proof.Term.tag(inspectedProposition),
      Proof.Term.tag(inspectedProof),
      typeof theorem,
      Proof.Theorem.isTheorem(loadedTheorem),
      Proof.Term.tag(loadedProposition),
      Proof.Theorem.isTheorem(resealedTheorem),
      Proof.Term.tag(globalProof),
      Proof.Theorem.isTheorem(dependentTheorem),
      Proof.Theorem.isTheorem(loadedDependentTheorem),
      validArtifactAccepted,
      corruptArtifactRejected,
      theoremUnaffected,
      validArtifactError,
      corruptArtifactError,
      unaffectedArtifactError,
      loadedTheoremUnaffected,
    ];
  `);

  assertEquals(session.get(0, "result"), [
    true, false, false, true, true, 6, 7, "object", true, 6, true,
    3, true, true, true, true, true, 0, 1, 0, true,
  ]);
});
Deno.test("native theorem artifacts and term views survive collector relocation", () => {
  const session = run(`
    let propositionSort = Proof.Term.proposition();
    let premise = Proof.Term.bound(0);
    let conclusion = Proof.Term.bound(1);
    let proposition = Proof.Term.product(
      propositionSort,
      Proof.Term.product(premise, conclusion)
    );
    let proof = Proof.Term.lambda(
      propositionSort,
      Proof.Term.lambda(premise, Proof.Term.bound(0))
    );
    let theorem = Proof.theorem(proposition, proof);
  `);

  session.gc();
  const parseResult = session.parse(`

    let result = [
      Proof.Theorem.isTheorem(theorem),
      Proof.Term.tag(Proof.Theorem.proposition(theorem)),
      Proof.Term.tag(Proof.Theorem.proofTerm(theorem)),
      Proof.checkArtifact(Proof.Theorem.artifact(theorem)),
    ];
  `);
  session.mem.setContextInstructionIndex(0, parseResult.startIndex);
  const result = runToDone(session, 10_000_000);
  assertEquals(result.status, "done");
  assertEquals(session.get(0, "result"), [true, 6, 7, true]);
});

Deno.test("native assumptions extend checked declaration environments", () => {
  const session = run(`
    let propositionSort = Proof.Term.proposition();
    let premise = Proof.Term.bound(0);
    let conclusion = Proof.Term.bound(1);
    let proposition = Proof.Term.product(
      propositionSort,
      Proof.Term.product(premise, conclusion)
    );
    let environment = Proof.assumption(proposition);
    let assumedProof = Proof.Term.global(environment, 0);
    let theorem = Proof.theorem(proposition, assumedProof);
    let artifact = Proof.Theorem.artifact(theorem);
    let loaded = Proof.loadArtifact(artifact, 1);
    let result = [
      Proof.Theorem.isTheorem(environment),
      Proof.Term.isTerm(environment),
      Proof.Term.tag(assumedProof),
      Proof.Theorem.isTheorem(theorem),
      Proof.Theorem.isTheorem(loaded),
      Proof.checkArtifact(artifact),
    ];
  `);

  assertEquals(session.get(0, "result"), [
    false, false, 3, true, true, true,
  ]);
});


Deno.test("native definitions extend checked declaration environments", () => {
  const session = run(`
    let propositionSort = Proof.Term.proposition();
    let premise = Proof.Term.bound(0);
    let conclusion = Proof.Term.bound(1);
    let proposition = Proof.Term.product(
      propositionSort,
      Proof.Term.product(premise, conclusion)
    );
    let proof = Proof.Term.lambda(
      propositionSort,
      Proof.Term.lambda(premise, Proof.Term.bound(0))
    );
    let environment = Proof.definition(proposition, proof);
    let unfoldedProof = Proof.Term.global(environment, 0);
    let theorem = Proof.theorem(proposition, unfoldedProof);
    let artifact = Proof.Theorem.artifact(theorem);
    let opaqueEnvironment = Proof.opaqueDefinition(proposition, proof);
    let opaqueProof = Proof.Term.global(opaqueEnvironment, 0);
    let opaqueTheorem = Proof.theorem(proposition, opaqueProof);
    let loaded = Proof.loadArtifact(artifact, 1);
    let localDefinition = Proof.Term.localDefinition(
      Proof.Term.type(0),
      Proof.Term.proposition(),
      Proof.Term.bound(0)
    );
    let localEnvironment = Proof.definition(
      Proof.Term.type(0),
      localDefinition
    );
    let localGlobal = Proof.Term.global(localEnvironment, 0);
    let result = [
      Proof.Theorem.isTheorem(environment),
      Proof.Term.isTerm(environment),
      Proof.Term.tag(unfoldedProof),
      Proof.Theorem.isTheorem(theorem),
      Proof.Theorem.isTheorem(loaded),
      Proof.checkArtifact(artifact),
      Proof.Theorem.isTheorem(opaqueEnvironment),
      Proof.Term.tag(opaqueProof),
      Proof.Theorem.isTheorem(opaqueTheorem),
      Proof.Theorem.isTheorem(localEnvironment),
      Proof.Term.tag(localGlobal),
    ];
  `);

  assertEquals(session.get(0, "result"), [
    false, false, 3, true, true, true, false, 3, true,
    false, 3,
  ]);
});

Deno.test("native checker rejects malformed canonical artifact bytes in WAT", () => {
  const session = run(`
    let propositionSort = Proof.Term.proposition();
    let premise = Proof.Term.bound(0);
    let conclusion = Proof.Term.bound(1);
    let proposition = Proof.Term.product(
      propositionSort,
      Proof.Term.product(premise, conclusion)
    );
    let proof = Proof.Term.lambda(
      propositionSort,
      Proof.Term.lambda(premise, Proof.Term.bound(0))
    );
    let theorem = Proof.theorem(proposition, proof);

    let badMagic = Proof.Theorem.artifact(theorem);
    badMagic[0] = 0;
    let badMagicRejected = !Proof.checkArtifact(badMagic);
    let badMagicError = Proof.errorCode();

    let badVersion = Proof.Theorem.artifact(theorem);
    badVersion[4] = 1;
    let corruptLoadRejected = false;
    try {
      Proof.loadArtifact(badMagic, 0);
    } catch (error) {
      corruptLoadRejected = error instanceof TypeError;
    }
    let declarationIndexRejected = false;
    try {
      Proof.loadArtifact(Proof.Theorem.artifact(theorem), 1);
    } catch (error) {
      declarationIndexRejected = error instanceof RangeError;
    }
    let badVersionRejected = !Proof.checkArtifact(badVersion);
    let badVersionError = Proof.errorCode();

    let badLength = Proof.Theorem.artifact(theorem);
    badLength[8] = 0;
    let badLengthRejected = !Proof.checkArtifact(badLength);
    let badLengthError = Proof.errorCode();

    let badDeclarationsReference = Proof.Theorem.artifact(theorem);
    badDeclarationsReference[12] = 0;
    let badDeclarationsReferenceRejected =
      !Proof.checkArtifact(badDeclarationsReference);
    let badDeclarationsReferenceError = Proof.errorCode();

    let result = [
      badMagicRejected, badMagicError,
      badVersionRejected, badVersionError,
      badLengthRejected, badLengthError,
      badDeclarationsReferenceRejected, badDeclarationsReferenceError,
      corruptLoadRejected,
      declarationIndexRejected,
    ];
  `);

  assertEquals(session.get(0, "result"), [
    true, 1,
    true, 1,
    true, 1,
    true, 3,
    true, true,
  ]);
});

Deno.test("native Proof.theorem rejects an ill-typed proof term", () => {
  const session = run(`
    let propositionSort = Proof.Term.proposition();
    let premise = Proof.Term.bound(0);
    let conclusion = Proof.Term.bound(1);
    let implication = Proof.Term.product(premise, conclusion);
    let proposition = Proof.Term.product(propositionSort, implication);
    let rejected = false;
    try {
      Proof.theorem(proposition, propositionSort);
    } catch (error) {
      rejected = error instanceof TypeError;
    }
    let invalidAssumptionRejected = false;
    try {
      Proof.assumption(Proof.Term.bound(0));
    } catch (error) {
      invalidAssumptionRejected = error instanceof TypeError;
    }
    let result = [rejected, invalidAssumptionRejected];
  `);

  assertEquals(session.get(0, "result"), [true, true]);
});

Deno.test("native proof terms and environments survive vat snapshot restoration", () => {
  const session = run(`
    let propositionSort = Proof.Term.proposition();
    let premise = Proof.Term.bound(0);
    let conclusion = Proof.Term.bound(1);
    let proposition = Proof.Term.product(
      propositionSort,
      Proof.Term.product(premise, conclusion)
    );
    let proof = Proof.Term.lambda(
      propositionSort,
      Proof.Term.lambda(premise, Proof.Term.bound(0))
    );
    let environment = Proof.assumption(proposition);
    let theorem = Proof.theorem(proposition, proof);
    let artifactBeforeRestore = Proof.Theorem.artifact(theorem);
  `);
  const snapshot = snapshotSession(session);
  const restored = restoreSession(snapshot.vatBytes, snapshot.membraneBytes);
  parseAndSetup(restored, `
    let globalTerm = Proof.Term.global(environment, 0);
    let artifactAfterRestore = Proof.Theorem.artifact(theorem);
    let loaded = Proof.loadArtifact(artifactAfterRestore, 0);
    let result = [
      Proof.Term.isTerm(globalTerm),
      Proof.Term.tag(globalTerm),
      Proof.Theorem.isTheorem(theorem),
      Proof.Theorem.isTheorem(loaded),
      Proof.checkArtifact(artifactAfterRestore),
      artifactBeforeRestore.length === artifactAfterRestore.length,
    ];
  `);
  const result = runToDone(restored, 10_000_000);
  assertEquals(result.status, "done");
  assertEquals(restored.get(0, "result"), [
    true, 3, true, true, true, true,
  ]);
});

Deno.test("native core Natural and recursive addition pass kernel checking", () => {
  const session = run(`
    let environment = Proof.Core.Natural.environment();
    let natural = Proof.Term.inductive(environment, 0);
    let stage = 1;
    let zero;
    let successor;
    let one;
    let zeroDefinition;
    let oneDefinition;
    let naturalMatch;
    let additionDefinition;
    let failure = 0;
    try {
      zero = Proof.Term.constructor(environment, 0, 0);
      stage = 2;
      successor = Proof.Term.constructor(environment, 0, 1);
      stage = 3;
      one = Proof.Term.apply(successor, zero);
      let zeroBranch = Proof.Term.branch(0, zero);
      let successorBranch = Proof.Term.branch(1, one);
      let branches = Proof.Term.sequence([zeroBranch, successorBranch]);
      naturalMatch = Proof.Term.match(natural, zero, branches);
      stage = 4;
      zeroDefinition = Proof.definition(natural, zero);
      stage = 5;
      oneDefinition = Proof.definition(natural, one);
      stage = 6;
      let additionType = Proof.Term.product(
        natural,
        Proof.Term.product(natural, natural)
      );
      let recursiveCall = Proof.Term.apply(
        Proof.Term.apply(
          Proof.Term.recursiveReference(0),
          Proof.Term.bound(0)
        ),
        Proof.Term.bound(1)
      );
      let additionZeroBranch = Proof.Term.branch(0, Proof.Term.bound(0));
      let additionSuccessorBranch = Proof.Term.branch(
        1,
        Proof.Term.lambda(
          natural,
          Proof.Term.apply(successor, recursiveCall)
        )
      );
      let additionBranches = Proof.Term.sequence([
        additionZeroBranch,
        additionSuccessorBranch,
      ]);
      let additionBody = Proof.Term.lambda(
        natural,
        Proof.Term.lambda(
          natural,
          Proof.Term.match(
            Proof.Term.bound(1),
            Proof.Term.lambda(natural, natural),
            additionBranches
          )
        )
      );
      let additionRecursiveDefinition = Proof.Term.recursiveDefinition(
        additionType,
        additionBody,
        0
      );
      let additionRecursiveDefinitions = Proof.Term.sequence([
        additionRecursiveDefinition,
      ]);
      let addition = Proof.Term.fixedPoint(additionRecursiveDefinitions, 0);
      additionDefinition = Proof.definition(additionType, addition);
      stage = 7;
    } catch (error) {
      failure = stage;
    }
    let result = [
      Proof.Theorem.isTheorem(environment),
      Proof.Term.isTerm(environment),
      Proof.Term.isTerm(natural),
      Proof.Term.tag(natural),
      Proof.Term.isTerm(zero),
      Proof.Term.tag(zero),
      Proof.Term.isTerm(successor),
      Proof.Term.tag(successor),
      Proof.Term.tag(naturalMatch),
      Proof.Theorem.isTheorem(zeroDefinition),
      Proof.Theorem.isTheorem(oneDefinition),
      Proof.Theorem.isTheorem(additionDefinition),
      failure,
      stage,
    ];
  `);
  assertEquals(session.get(0, "result"), [
    false, false, true, 4, true, 5, true, 5, 10, false, false, false, 0, 7,
  ]);
});

Deno.test("native inductive declarations append generic equality", () => {
  const session = run(`
    let naturalEnvironment = Proof.Core.Natural.environment();
    let natural = Proof.Term.inductive(naturalEnvironment, 0);
    let zero = Proof.Term.constructor(naturalEnvironment, 0, 0);
    let equalityReference = Proof.Term.inductiveReference(Proof.declarationCount(naturalEnvironment));
    let typeZero = Proof.Term.type(0);
    let equalityType = Proof.Term.product(
      typeZero,
      Proof.Term.product(
        Proof.Term.bound(0),
        Proof.Term.product(Proof.Term.bound(1), Proof.Term.proposition())
      )
    );
    let reflexivityType = Proof.Term.product(
      typeZero,
      Proof.Term.product(
        Proof.Term.bound(0),
        Proof.Term.apply(
          Proof.Term.apply(
            Proof.Term.apply(equalityReference, Proof.Term.bound(1)),
            Proof.Term.bound(0)
          ),
          Proof.Term.bound(0)
        )
      )
    );
    let equalityEnvironment = Proof.inductive(
      naturalEnvironment,
      equalityType,
      Proof.Term.sequence([reflexivityType]),
      1
    );
    let equality = Proof.Term.inductive(equalityEnvironment, 2);
    let reflexivity = Proof.Term.constructor(equalityEnvironment, 2, 0);
    let proposition = Proof.Term.apply(
      Proof.Term.apply(
        Proof.Term.apply(equality, natural),
        zero
      ),
      zero
    );
    let proof = Proof.Term.apply(
      Proof.Term.apply(reflexivity, natural),
      zero
    );
    let theorem = Proof.theorem(proposition, proof);
    let result = [
      Proof.Theorem.isTheorem(equalityEnvironment),
      Proof.Term.tag(equality),
      Proof.Theorem.isTheorem(theorem),
    ];
  `);
  assertEquals(session.get(0, "result"), [false, 4, true]);
});

Deno.test("native proof checks open addition associativity", () => {
  const session = freshSession();
  parseAndSetup(session, `
    let naturalEnvironment = Proof.Core.Natural.environment();
    let natural = Proof.Term.inductive(naturalEnvironment, 0);
    let zero = Proof.Term.constructor(naturalEnvironment, 0, 0);
    let successor = Proof.Term.constructor(naturalEnvironment, 0, 1);
    let additionType = Proof.Term.product(
      natural,
      Proof.Term.product(natural, natural)
    );
    let additionRecursiveCall = Proof.Term.apply(
      Proof.Term.apply(
        Proof.Term.recursiveReference(0),
        Proof.Term.bound(0)
      ),
      Proof.Term.bound(1)
    );
    let additionBranches = Proof.Term.sequence([
      Proof.Term.branch(0, Proof.Term.bound(0)),
      Proof.Term.branch(
        1,
        Proof.Term.lambda(
          natural,
          Proof.Term.apply(successor, additionRecursiveCall)
        )
      ),
    ]);
    let additionBody = Proof.Term.lambda(
      natural,
      Proof.Term.lambda(
        natural,
        Proof.Term.match(
          Proof.Term.bound(1),
          Proof.Term.lambda(natural, natural),
          additionBranches
        )
      )
    );
    let addition = Proof.Term.fixedPoint(
      Proof.Term.sequence([
        Proof.Term.recursiveDefinition(additionType, additionBody, 0),
      ]),
      0
    );
    let additionEnvironment = Proof.definition(additionType, addition);
    naturalEnvironment = null;
    natural = null;
    zero = null;
    successor = null;
    additionType = null;
    additionRecursiveCall = null;
    additionBranches = null;
    additionBody = null;
    addition = null;

    let equalityReference = Proof.Term.inductiveReference(Proof.declarationCount(additionEnvironment));
    let typeZero = Proof.Term.type(0);
    let equalityType = Proof.Term.product(
      typeZero,
      Proof.Term.product(
        Proof.Term.bound(0),
        Proof.Term.product(Proof.Term.bound(1), Proof.Term.proposition())
      )
    );
    let reflexivityType = Proof.Term.product(
      typeZero,
      Proof.Term.product(
        Proof.Term.bound(0),
        Proof.Term.apply(
          Proof.Term.apply(
            Proof.Term.apply(equalityReference, Proof.Term.bound(1)),
            Proof.Term.bound(0)
          ),
          Proof.Term.bound(0)
        )
      )
    );
    let coreEnvironment = Proof.inductive(
      additionEnvironment,
      equalityType,
      Proof.Term.sequence([reflexivityType]),
      1
    );
    additionEnvironment = null;
    equalityReference = null;
    typeZero = null;
    equalityType = null;
    reflexivityType = null;
    natural = Proof.Term.inductive(coreEnvironment, 0);
    successor = Proof.Term.constructor(coreEnvironment, 0, 1);
    let add = Proof.Term.global(coreEnvironment, 2);
    let equality = Proof.Term.inductive(coreEnvironment, 3);
    let reflexivity = Proof.Term.constructor(coreEnvironment, 3, 0);

    let addAB = Proof.Term.apply(
      Proof.Term.apply(add, Proof.Term.bound(2)),
      Proof.Term.bound(1)
    );
    let addABThenC = Proof.Term.apply(
      Proof.Term.apply(add, addAB),
      Proof.Term.bound(0)
    );
    let addBC = Proof.Term.apply(
      Proof.Term.apply(add, Proof.Term.bound(1)),
      Proof.Term.bound(0)
    );
    let addAThenBC = Proof.Term.apply(
      Proof.Term.apply(add, Proof.Term.bound(2)),
      addBC
    );
    let associativityStatement = Proof.Term.apply(
      Proof.Term.apply(
        Proof.Term.apply(equality, natural),
        addABThenC
      ),
      addAThenBC
    );
    let associativityType = Proof.Term.product(
      natural,
      Proof.Term.product(
        natural,
        Proof.Term.product(natural, associativityStatement)
      )
    );
    addAB = null;
    addABThenC = null;
    addBC = null;
    addAThenBC = null;
    associativityStatement = null;

    let predicateAddNB = Proof.Term.apply(
      Proof.Term.apply(add, Proof.Term.bound(0)),
      Proof.Term.bound(2)
    );
    let predicateLeft = Proof.Term.apply(
      Proof.Term.apply(add, predicateAddNB),
      Proof.Term.bound(1)
    );
    let predicateAddBC = Proof.Term.apply(
      Proof.Term.apply(add, Proof.Term.bound(2)),
      Proof.Term.bound(1)
    );
    let predicateRight = Proof.Term.apply(
      Proof.Term.apply(add, Proof.Term.bound(0)),
      predicateAddBC
    );
    let naturalPredicate = Proof.Term.lambda(
      natural,
      Proof.Term.apply(
        Proof.Term.apply(
          Proof.Term.apply(equality, natural),
          predicateLeft
        ),
        predicateRight
      )
    );
    predicateAddNB = null;
    predicateLeft = null;
    predicateAddBC = null;
    predicateRight = null;

    let zeroResult = Proof.Term.apply(
      Proof.Term.apply(add, Proof.Term.bound(1)),
      Proof.Term.bound(0)
    );
    let zeroProof = Proof.Term.apply(
      Proof.Term.apply(reflexivity, natural),
      zeroResult
    );
    zeroResult = null;

    let recursiveProof = Proof.Term.apply(
      Proof.Term.apply(
        Proof.Term.apply(
          Proof.Term.recursiveReference(0),
          Proof.Term.bound(0)
        ),
        Proof.Term.bound(2)
      ),
      Proof.Term.bound(1)
    );
    let equalityProofType = Proof.Term.apply(
      Proof.Term.apply(
        Proof.Term.apply(equality, natural),
        Proof.Term.bound(1)
      ),
      Proof.Term.bound(0)
    );
    let successorLeft = Proof.Term.apply(successor, Proof.Term.bound(2));
    let successorRight = Proof.Term.apply(successor, Proof.Term.bound(1));
    let successorEquality = Proof.Term.apply(
      Proof.Term.apply(
        Proof.Term.apply(equality, natural),
        successorLeft
      ),
      successorRight
    );
    let congruencePredicate = Proof.Term.lambda(
      natural,
      Proof.Term.lambda(
        natural,
        Proof.Term.lambda(equalityProofType, successorEquality)
      )
    );
    equalityProofType = null;
    successorLeft = null;
    successorRight = null;
    successorEquality = null;
    let reflexivitySuccessor = Proof.Term.apply(
      Proof.Term.apply(reflexivity, natural),
      Proof.Term.apply(successor, Proof.Term.bound(0))
    );
    let congruenceBranches = Proof.Term.sequence([
      Proof.Term.branch(
        0,
        Proof.Term.lambda(natural, reflexivitySuccessor)
      ),
    ]);
    reflexivitySuccessor = null;
    let successorProof = Proof.Term.lambda(
      natural,
      Proof.Term.match(
        recursiveProof,
        congruencePredicate,
        congruenceBranches
      )
    );
    recursiveProof = null;
    congruencePredicate = null;
    congruenceBranches = null;
    let associativityBranches = Proof.Term.sequence([
      Proof.Term.branch(0, zeroProof),
      Proof.Term.branch(1, successorProof),
    ]);
    zeroProof = null;
    successorProof = null;
    let associativityBody = Proof.Term.lambda(
      natural,
      Proof.Term.lambda(
        natural,
        Proof.Term.lambda(
          natural,
          Proof.Term.match(
            Proof.Term.bound(2),
            naturalPredicate,
            associativityBranches
          )
        )
      )
    );
    naturalPredicate = null;
    associativityBranches = null;
    let associativity = Proof.Term.fixedPoint(
      Proof.Term.sequence([
        Proof.Term.recursiveDefinition(
          associativityType,
          associativityBody,
          0
        ),
      ]),
      0
    );
    associativityBody = null;
    let theorem = Proof.theorem(associativityType, associativity);
    let result = [
      Proof.Theorem.isTheorem(theorem),
      Proof.errorCode(),
    ];
  `);
  let runResult = runToDone(session, 10_000_000);
  assertEquals(runResult.status, "done");
  assertEquals(session.get(0, "result"), [true, 0]);
});

Deno.test("native core List and append pass kernel checking", () => {
  const session = freshSession({ heapSize: 64 * 1024 * 1024 });
  parseAndSetup(session, `
    let naturalEnvironment = Proof.Core.Natural.environment();
    let equalityReference = Proof.Term.inductiveReference(Proof.declarationCount(naturalEnvironment));
    let typeZero = Proof.Term.type(0);
    let equalityType = Proof.Term.product(
      typeZero,
      Proof.Term.product(
        Proof.Term.bound(0),
        Proof.Term.product(Proof.Term.bound(1), Proof.Term.proposition())
      )
    );
    let reflexivityType = Proof.Term.product(
      typeZero,
      Proof.Term.product(
        Proof.Term.bound(0),
        Proof.Term.apply(
          Proof.Term.apply(
            Proof.Term.apply(equalityReference, Proof.Term.bound(1)),
            Proof.Term.bound(0)
          ),
          Proof.Term.bound(0)
        )
      )
    );
    let equalityEnvironment = Proof.inductive(
      naturalEnvironment,
      equalityType,
      Proof.Term.sequence([reflexivityType]),
      1
    );

    let listReference = Proof.Term.inductiveReference(Proof.declarationCount(equalityEnvironment));
    let listType = Proof.Term.product(typeZero, typeZero);
    let emptyListType = Proof.Term.product(
      typeZero,
      Proof.Term.apply(listReference, Proof.Term.bound(0))
    );
    let listOfParameterAfterHead = Proof.Term.apply(
      listReference,
      Proof.Term.bound(1)
    );
    let listOfParameterAfterTail = Proof.Term.apply(
      listReference,
      Proof.Term.bound(2)
    );
    let prependType = Proof.Term.product(
      typeZero,
      Proof.Term.product(
        Proof.Term.bound(0),
        Proof.Term.product(
          listOfParameterAfterHead,
          listOfParameterAfterTail
        )
      )
    );
    let listEnvironment = Proof.inductive(
      equalityEnvironment,
      listType,
      Proof.Term.sequence([emptyListType, prependType]),
      1
    );
    naturalEnvironment = null;
    equalityReference = null;
    equalityType = null;
    reflexivityType = null;
    equalityEnvironment = null;
    listReference = null;
    listType = null;
    emptyListType = null;
    listOfParameterAfterHead = null;
    listOfParameterAfterTail = null;
    prependType = null;

    let list = Proof.Term.inductive(listEnvironment, 4);
    let prepend = Proof.Term.constructor(listEnvironment, 4, 1);
    let listOfParameter = Proof.Term.apply(list, Proof.Term.bound(0));
    let listOfParameterAfterFirstList = Proof.Term.apply(
      list,
      Proof.Term.bound(1)
    );
    let listOfParameterAfterSecondList = Proof.Term.apply(
      list,
      Proof.Term.bound(2)
    );
    let appendType = Proof.Term.product(
      typeZero,
      Proof.Term.product(
        listOfParameter,
        Proof.Term.product(
          listOfParameterAfterFirstList,
          listOfParameterAfterSecondList
        )
      )
    );

    let recursiveAppend = Proof.Term.apply(
      Proof.Term.apply(
        Proof.Term.apply(
          Proof.Term.recursiveReference(0),
          Proof.Term.bound(4)
        ),
        Proof.Term.bound(0)
      ),
      Proof.Term.bound(2)
    );
    let prependRecursiveAppend = Proof.Term.apply(
      Proof.Term.apply(
        Proof.Term.apply(prepend, Proof.Term.bound(4)),
        Proof.Term.bound(1)
      ),
      recursiveAppend
    );
    let appendBranches = Proof.Term.sequence([
      Proof.Term.branch(0, Proof.Term.bound(0)),
      Proof.Term.branch(
        1,
        Proof.Term.lambda(
          Proof.Term.bound(2),
          Proof.Term.lambda(
            Proof.Term.apply(list, Proof.Term.bound(3)),
            prependRecursiveAppend
          )
        )
      ),
    ]);
    let appendPredicate = Proof.Term.lambda(
      Proof.Term.apply(list, Proof.Term.bound(2)),
      Proof.Term.apply(list, Proof.Term.bound(3))
    );
    let appendBody = Proof.Term.lambda(
      typeZero,
      Proof.Term.lambda(
        Proof.Term.apply(list, Proof.Term.bound(0)),
        Proof.Term.lambda(
          Proof.Term.apply(list, Proof.Term.bound(1)),
          Proof.Term.match(
            Proof.Term.bound(1),
            appendPredicate,
            appendBranches
          )
        )
      )
    );
    let append = Proof.Term.fixedPoint(
      Proof.Term.sequence([
        Proof.Term.recursiveDefinition(appendType, appendBody, 1),
      ]),
      0
    );
    let appendEnvironment = Proof.definition(appendType, append);
    listEnvironment = null;
    list = Proof.Term.inductive(appendEnvironment, 4);
    prepend = Proof.Term.constructor(appendEnvironment, 4, 1);
    let emptyList = Proof.Term.constructor(appendEnvironment, 4, 0);
    let appendFunction = Proof.Term.global(appendEnvironment, 6);
    let equality = Proof.Term.inductive(appendEnvironment, 2);
    let reflexivity = Proof.Term.constructor(appendEnvironment, 2, 0);
    appendType = null;
    appendBody = null;
    append = null;
    recursiveAppend = null;
    prependRecursiveAppend = null;
    appendBranches = null;
    appendPredicate = null;
    listOfParameter = null;
    listOfParameterAfterFirstList = null;
    listOfParameterAfterSecondList = null;

    let appendFirstSecond = Proof.Term.apply(
      Proof.Term.apply(
        Proof.Term.apply(appendFunction, Proof.Term.bound(3)),
        Proof.Term.bound(2)
      ),
      Proof.Term.bound(1)
    );
    let appendFirstSecondThenThird = Proof.Term.apply(
      Proof.Term.apply(
        Proof.Term.apply(appendFunction, Proof.Term.bound(3)),
        appendFirstSecond
      ),
      Proof.Term.bound(0)
    );
    let appendSecondThird = Proof.Term.apply(
      Proof.Term.apply(
        Proof.Term.apply(appendFunction, Proof.Term.bound(3)),
        Proof.Term.bound(1)
      ),
      Proof.Term.bound(0)
    );
    let appendFirstThenSecondThird = Proof.Term.apply(
      Proof.Term.apply(
        Proof.Term.apply(appendFunction, Proof.Term.bound(3)),
        Proof.Term.bound(2)
      ),
      appendSecondThird
    );
    let listAtAssociativity = Proof.Term.apply(
      list,
      Proof.Term.bound(3)
    );
    let appendAssociativityStatement = Proof.Term.apply(
      Proof.Term.apply(
        Proof.Term.apply(equality, listAtAssociativity),
        appendFirstSecondThenThird
      ),
      appendFirstThenSecondThird
    );
    let appendAssociativityType = Proof.Term.product(
      typeZero,
      Proof.Term.product(
        Proof.Term.apply(list, Proof.Term.bound(0)),
        Proof.Term.product(
          Proof.Term.apply(list, Proof.Term.bound(1)),
          Proof.Term.product(
            Proof.Term.apply(list, Proof.Term.bound(2)),
            appendAssociativityStatement
          )
        )
      )
    );
    appendFirstSecond = null;
    appendFirstSecondThenThird = null;
    appendSecondThird = null;
    appendFirstThenSecondThird = null;
    listAtAssociativity = null;
    appendAssociativityStatement = null;

    let predicateAppendCurrentSecond = Proof.Term.apply(
      Proof.Term.apply(
        Proof.Term.apply(appendFunction, Proof.Term.bound(4)),
        Proof.Term.bound(0)
      ),
      Proof.Term.bound(2)
    );
    let predicateLeft = Proof.Term.apply(
      Proof.Term.apply(
        Proof.Term.apply(appendFunction, Proof.Term.bound(4)),
        predicateAppendCurrentSecond
      ),
      Proof.Term.bound(1)
    );
    let predicateAppendSecondThird = Proof.Term.apply(
      Proof.Term.apply(
        Proof.Term.apply(appendFunction, Proof.Term.bound(4)),
        Proof.Term.bound(2)
      ),
      Proof.Term.bound(1)
    );
    let predicateRight = Proof.Term.apply(
      Proof.Term.apply(
        Proof.Term.apply(appendFunction, Proof.Term.bound(4)),
        Proof.Term.bound(0)
      ),
      predicateAppendSecondThird
    );
    let listAtPredicate = Proof.Term.apply(list, Proof.Term.bound(4));
    let listAssociativityPredicate = Proof.Term.lambda(
      Proof.Term.apply(list, Proof.Term.bound(3)),
      Proof.Term.apply(
        Proof.Term.apply(
          Proof.Term.apply(equality, listAtPredicate),
          predicateLeft
        ),
        predicateRight
      )
    );
    predicateAppendCurrentSecond = null;
    predicateLeft = null;
    predicateAppendSecondThird = null;
    predicateRight = null;
    listAtPredicate = null;

    let emptyBranchResult = Proof.Term.apply(
      Proof.Term.apply(
        Proof.Term.apply(appendFunction, Proof.Term.bound(3)),
        Proof.Term.bound(1)
      ),
      Proof.Term.bound(0)
    );
    let emptyBranchProof = Proof.Term.apply(
      Proof.Term.apply(
        reflexivity,
        Proof.Term.apply(list, Proof.Term.bound(3))
      ),
      emptyBranchResult
    );
    emptyBranchResult = null;

    let recursiveAssociativityProof = Proof.Term.apply(
      Proof.Term.apply(
        Proof.Term.apply(
          Proof.Term.apply(
            Proof.Term.recursiveReference(0),
            Proof.Term.bound(5)
          ),
          Proof.Term.bound(0)
        ),
        Proof.Term.bound(3)
      ),
      Proof.Term.bound(2)
    );
    let congruenceListAtLeft = Proof.Term.apply(
      list,
      Proof.Term.bound(5)
    );
    let congruenceListAtRight = Proof.Term.apply(
      list,
      Proof.Term.bound(6)
    );
    let congruenceEqualityList = Proof.Term.apply(
      list,
      Proof.Term.bound(7)
    );
    let congruencePremise = Proof.Term.apply(
      Proof.Term.apply(
        Proof.Term.apply(equality, congruenceEqualityList),
        Proof.Term.bound(1)
      ),
      Proof.Term.bound(0)
    );
    let prependLeft = Proof.Term.apply(
      Proof.Term.apply(
        Proof.Term.apply(prepend, Proof.Term.bound(8)),
        Proof.Term.bound(4)
      ),
      Proof.Term.bound(2)
    );
    let prependRight = Proof.Term.apply(
      Proof.Term.apply(
        Proof.Term.apply(prepend, Proof.Term.bound(8)),
        Proof.Term.bound(4)
      ),
      Proof.Term.bound(1)
    );
    let congruenceConclusion = Proof.Term.apply(
      Proof.Term.apply(
        Proof.Term.apply(equality, Proof.Term.apply(list, Proof.Term.bound(8))),
        prependLeft
      ),
      prependRight
    );
    let prependCongruencePredicate = Proof.Term.lambda(
      congruenceListAtLeft,
      Proof.Term.lambda(
        congruenceListAtRight,
        Proof.Term.lambda(congruencePremise, congruenceConclusion)
      )
    );
    congruenceListAtLeft = null;
    congruenceListAtRight = null;
    congruenceEqualityList = null;
    congruencePremise = null;
    prependLeft = null;
    prependRight = null;
    congruenceConclusion = null;

    let reflexivePrepend = Proof.Term.apply(
      Proof.Term.apply(
        Proof.Term.apply(prepend, Proof.Term.bound(6)),
        Proof.Term.bound(2)
      ),
      Proof.Term.bound(0)
    );
    let prependCongruenceReflexivity = Proof.Term.apply(
      Proof.Term.apply(
        reflexivity,
        Proof.Term.apply(list, Proof.Term.bound(6))
      ),
      reflexivePrepend
    );
    let prependCongruenceBranches = Proof.Term.sequence([
      Proof.Term.branch(
        0,
        Proof.Term.lambda(
          Proof.Term.apply(list, Proof.Term.bound(5)),
          prependCongruenceReflexivity
        )
      ),
    ]);
    reflexivePrepend = null;
    prependCongruenceReflexivity = null;

    let prependBranchProof = Proof.Term.lambda(
      Proof.Term.bound(3),
      Proof.Term.lambda(
        Proof.Term.apply(list, Proof.Term.bound(4)),
        Proof.Term.match(
          recursiveAssociativityProof,
          prependCongruencePredicate,
          prependCongruenceBranches
        )
      )
    );
    recursiveAssociativityProof = null;
    prependCongruencePredicate = null;
    prependCongruenceBranches = null;
    let associativityBranches = Proof.Term.sequence([
      Proof.Term.branch(0, emptyBranchProof),
      Proof.Term.branch(1, prependBranchProof),
    ]);
    emptyBranchProof = null;
    prependBranchProof = null;
    let appendAssociativityBody = Proof.Term.lambda(
      typeZero,
      Proof.Term.lambda(
        Proof.Term.apply(list, Proof.Term.bound(0)),
        Proof.Term.lambda(
          Proof.Term.apply(list, Proof.Term.bound(1)),
          Proof.Term.lambda(
            Proof.Term.apply(list, Proof.Term.bound(2)),
            Proof.Term.match(
              Proof.Term.bound(2),
              listAssociativityPredicate,
              associativityBranches
            )
          )
        )
      )
    );
    listAssociativityPredicate = null;
    associativityBranches = null;
    let appendAssociativity = Proof.Term.fixedPoint(
      Proof.Term.sequence([
        Proof.Term.recursiveDefinition(
          appendAssociativityType,
          appendAssociativityBody,
          1
        ),
      ]),
      0
    );
    appendAssociativityBody = null;
    let appendAssociativityTheorem = Proof.theorem(
      appendAssociativityType,
      appendAssociativity
    );
    let result = [
      Proof.Term.tag(Proof.Term.inductive(appendEnvironment, 4)),
      Proof.Term.tag(Proof.Term.global(appendEnvironment, 6)),
      Proof.Theorem.isTheorem(appendAssociativityTheorem),
      Proof.errorCode(),
    ];
  `);
  let runResult = runToDone(session, 10_000_000);
  assertEquals(runResult.status, "done");
  assertEquals(session.get(0, "result"), [4, 3, true, 0]);
});

Deno.test("native length-indexed Vector head safety passes kernel checking", () => {
  const session = freshSession({ heapSize: 32 * 1024 * 1024 });
  parseAndSetup(session, `
    let naturalEnvironment = Proof.Core.Natural.environment();
    let natural = Proof.Term.inductive(naturalEnvironment, 0);
    let zero = Proof.Term.constructor(naturalEnvironment, 0, 0);
    let successor = Proof.Term.constructor(naturalEnvironment, 0, 1);
    let vectorReference = Proof.Term.inductiveReference(Proof.declarationCount(naturalEnvironment));
    let typeZero = Proof.Term.type(0);
    let vectorType = Proof.Term.product(
      typeZero,
      Proof.Term.product(natural, typeZero)
    );
    let emptyVectorType = Proof.Term.product(
      typeZero,
      Proof.Term.apply(
        Proof.Term.apply(vectorReference, Proof.Term.bound(0)),
        zero
      )
    );
    let vectorTailType = Proof.Term.apply(
      Proof.Term.apply(vectorReference, Proof.Term.bound(2)),
      Proof.Term.bound(1)
    );
    let successorLength = Proof.Term.apply(
      successor,
      Proof.Term.bound(2)
    );
    let prependedVectorType = Proof.Term.apply(
      Proof.Term.apply(vectorReference, Proof.Term.bound(3)),
      successorLength
    );
    let prependVectorType = Proof.Term.product(
      typeZero,
      Proof.Term.product(
        natural,
        Proof.Term.product(
          Proof.Term.bound(1),
          Proof.Term.product(vectorTailType, prependedVectorType)
        )
      )
    );
    let vectorEnvironment = Proof.inductive(
      naturalEnvironment,
      vectorType,
      Proof.Term.sequence([emptyVectorType, prependVectorType]),
      1
    );
    naturalEnvironment = null;
    vectorReference = null;
    vectorType = null;
    emptyVectorType = null;
    vectorTailType = null;
    successorLength = null;
    prependedVectorType = null;
    prependVectorType = null;

    natural = Proof.Term.inductive(vectorEnvironment, 0);
    successor = Proof.Term.constructor(vectorEnvironment, 0, 1);
    let vector = Proof.Term.inductive(vectorEnvironment, 2);
    let vectorAtSuccessor = Proof.Term.apply(
      Proof.Term.apply(vector, Proof.Term.bound(1)),
      Proof.Term.apply(successor, Proof.Term.bound(0))
    );
    let headType = Proof.Term.product(
      typeZero,
      Proof.Term.product(
        natural,
        Proof.Term.product(vectorAtSuccessor, Proof.Term.bound(2))
      )
    );

    let vectorPredicateDomain = Proof.Term.apply(
      Proof.Term.apply(vector, Proof.Term.bound(3)),
      Proof.Term.bound(0)
    );
    let headPredicate = Proof.Term.lambda(
      natural,
      Proof.Term.lambda(
        vectorPredicateDomain,
        Proof.Term.bound(4)
      )
    );
    let constructorTailType = Proof.Term.apply(
      Proof.Term.apply(vector, Proof.Term.bound(4)),
      Proof.Term.bound(1)
    );
    let headBranch = Proof.Term.branch(
      1,
      Proof.Term.lambda(
        natural,
        Proof.Term.lambda(
          Proof.Term.bound(3),
          Proof.Term.lambda(constructorTailType, Proof.Term.bound(1))
        )
      )
    );
    let headBody = Proof.Term.lambda(
      typeZero,
      Proof.Term.lambda(
        natural,
        Proof.Term.lambda(
          vectorAtSuccessor,
          Proof.Term.match(
            Proof.Term.bound(0),
            headPredicate,
            Proof.Term.sequence([headBranch])
          )
        )
      )
    );
    let headEnvironment = Proof.definition(headType, headBody);
    let result = [
      Proof.Term.tag(Proof.Term.inductive(headEnvironment, 2)),
      Proof.Term.tag(Proof.Term.global(headEnvironment, 4)),
      Proof.errorCode(),
    ];
  `);
  let runResult = runToDone(session, 10_000_000);
  assertEquals(runResult.status, "done");
  assertEquals(session.get(0, "result"), [4, 3, 0]);
});

Deno.test("native finite type supports checked case analysis", () => {
  const session = run(`
    let naturalEnvironment = Proof.Core.Natural.environment();
    let finiteReference = Proof.Term.inductiveReference(Proof.declarationCount(naturalEnvironment));
    let typeZero = Proof.Term.type(0);
    let finiteEnvironment = Proof.inductive(
      naturalEnvironment,
      typeZero,
      Proof.Term.sequence([finiteReference, finiteReference]),
      0
    );
    let finite = Proof.Term.inductive(finiteEnvironment, 2);
    let caseType = Proof.Term.product(
      typeZero,
      Proof.Term.product(
        Proof.Term.bound(0),
        Proof.Term.product(
          Proof.Term.bound(1),
          Proof.Term.product(finite, Proof.Term.bound(3))
        )
      )
    );
    let caseBody = Proof.Term.lambda(
      typeZero,
      Proof.Term.lambda(
        Proof.Term.bound(0),
        Proof.Term.lambda(
          Proof.Term.bound(1),
          Proof.Term.lambda(
            finite,
            Proof.Term.match(
              Proof.Term.bound(0),
              Proof.Term.lambda(finite, Proof.Term.bound(4)),
              Proof.Term.sequence([
                Proof.Term.branch(0, Proof.Term.bound(2)),
                Proof.Term.branch(1, Proof.Term.bound(1)),
              ])
            )
          )
        )
      )
    );
    let caseEnvironment = Proof.definition(caseType, caseBody);
    let result = [
      Proof.Term.tag(Proof.Term.inductive(caseEnvironment, 2)),
      Proof.Term.tag(Proof.Term.global(caseEnvironment, 4)),
      Proof.errorCode(),
    ];
  `);
  assertEquals(session.get(0, "result"), [4, 3, 0]);
});

Deno.test("WAT checker directly accepts sound artifacts and rejects forged proofs", () => {
  const session = run(`
    let propositionSort = Proof.Term.proposition();
    let premise = Proof.Term.bound(0);
    let proposition = Proof.Term.product(
      propositionSort,
      Proof.Term.product(premise, Proof.Term.bound(1))
    );
    let proof = Proof.Term.lambda(
      propositionSort,
      Proof.Term.lambda(premise, Proof.Term.bound(0))
    );
    let theorem = Proof.theorem(proposition, proof);
    let result = Proof.Theorem.artifact(theorem);
  `);
  const artifact = session.get(0, "result");
  const artifactBytes = new Uint8Array(artifact);
  const workspaceLength = 4 * 1024 * 1024;
  const artifactBase = session.mem.wasm.exports.test_carve_scratch(
    artifactBytes.byteLength + workspaceLength,
  );
  const destination = new Uint8Array(
    session.mem.buffer,
    session.mem.abs(artifactBase),
    artifactBytes.byteLength,
  );
  const checker = session.mem.wasm.exports.proof_check_artifact;
  const check = (mutate) => {
    destination.set(artifactBytes);
    mutate(new DataView(
      session.mem.buffer,
      session.mem.abs(artifactBase),
      artifactBytes.byteLength,
    ));
    return checker(artifactBase, artifactBytes.byteLength, workspaceLength);
  };
  const records = [];
  const artifactView = new DataView(
    artifactBytes.buffer,
    artifactBytes.byteOffset,
    artifactBytes.byteLength,
  );
  for (let offset = 16; offset < artifactBytes.byteLength;) {
    records.push({
      offset,
      wordCount: artifactView.getUint32(offset, true),
      tag: artifactView.getUint32(offset + 4, true),
    });
    offset += artifactView.getUint32(offset, true) * 4;
  }
  const theoremDeclaration = records.find((record) => record.tag === 0x203);
  const boundTerm = records.find((record) => record.tag === 2);
  assertEquals(check(() => {}), 0);
  assertEquals(check((view) => view.setUint32(0, 0, true)), 1);
  assertEquals(
    check((view) => view.setUint32(records[0].offset, 1, true)),
    2,
  );
  assertEquals(
    check((view) => view.setUint32(boundTerm.offset + 8, 999, true)) !== 0,
    true,
  );
  assertEquals(
    check((view) => {
      view.setUint32(
        theoremDeclaration.offset + 16,
        view.getUint32(theoremDeclaration.offset + 12, true),
        true,
      );
    }) !== 0,
    true,
  );
});

Deno.test("native core modules expose checked declarations and lemmas", () => {
  const session = freshSession({ heapSize: 64 * 1024 * 1024 });
  parseAndSetup(session, `
    let coreEnvironment = Proof.Core.environment();
    let listEnvironment = Proof.Core.List.environment();
    let vectorEnvironment = Proof.Core.Vector.environment();
    let listTags = [];
    let listTypeFlags = [];
    let listBodyFlags = [];
    let listCount = Proof.declarationCount(listEnvironment);
    for (let index = 0; index < listCount; index = index + 1) {
      listTags.push(Proof.declarationTag(listEnvironment, index));
      listTypeFlags.push(Proof.Term.isTerm(
        Proof.declarationType(listEnvironment, index),
      ));
      listBodyFlags.push(Proof.Term.isTerm(
        Proof.declarationBody(listEnvironment, index),
      ));
    }
    let append = Proof.declarationBody(listEnvironment, listCount - 2);
    let associativityType = Proof.declarationType(listEnvironment, listCount - 1);
    let associativityProof = Proof.declarationBody(listEnvironment, listCount - 1);
    let associativityTheorem = Proof.theorem(
      associativityType,
      associativityProof,
    );
    let listArtifact = Proof.artifact(listEnvironment);
    let result = [
      Proof.declarationCount(coreEnvironment),
      listCount,
      Proof.declarationCount(vectorEnvironment),
      listTags,
      listTypeFlags,
      listBodyFlags,
      Proof.Term.tag(append),
      Proof.Term.tag(associativityProof),
      Proof.Theorem.isTheorem(associativityTheorem),
      Proof.checkArtifact(listArtifact),
    ];
  `);
  let runResult = runToDone(session, 100_000_000);
  assertEquals(runResult.status, "done");
  assertEquals(session.get(0, "result"), [
    10,
    8,
    10,
    [0x204, 0x206, 0x204, 0x206, 0x204, 0x206, 0x201, 0x203],
    [true, true, true, true, true, true, true, true],
    [false, false, false, false, false, false, true, true],
    11,
    11,
    true,
    true,
  ]);
});

Deno.test("native core List artifact survives vat restoration", () => {
  const session = freshSession({ heapSize: 64 * 1024 * 1024 });
  parseAndSetup(session, `
    let listEnvironment = Proof.Core.List.environment();
    let artifactLength = Proof.artifact(listEnvironment).length;
  `);
  let runResult = runToDone(session, 100_000_000);
  assertEquals(runResult.status, "done");

  const snapshot = snapshotSession(session);
  const restored = restoreSession(snapshot.vatBytes, snapshot.membraneBytes);
  parseAndSetup(restored, `
    let restoredArtifact = Proof.artifact(listEnvironment);
    let listCount = Proof.declarationCount(listEnvironment);
    let result = [
      Proof.declarationCount(listEnvironment),
      Proof.declarationTag(listEnvironment, listCount - 2),
      Proof.declarationTag(listEnvironment, listCount - 1),
      Proof.Term.isTerm(Proof.declarationBody(listEnvironment, listCount - 1)),
      Proof.checkArtifact(restoredArtifact),
      restoredArtifact.length === artifactLength,
    ];
  `);
  runResult = runToDone(restored, 100_000_000);
  assertEquals(runResult.status, "done");
  assertEquals(restored.get(0, "result"), [
    8,
    0x201,
    0x203,
    true,
    true,
    true,
  ]);
});

Deno.test("native dependency and assumption inspection walks checked terms", () => {
  const session = freshSession({ heapSize: 64 * 1024 * 1024 });
  parseAndSetup(session, `
    let propositionSort = Proof.Term.proposition();
    let proposition = Proof.Term.product(
      propositionSort,
      Proof.Term.bound(0),
    );
    let assumptionEnvironment = Proof.assumption(proposition);
    let assumedProof = Proof.Term.global(assumptionEnvironment, 0);
    let assumedTheorem = Proof.theorem(proposition, assumedProof);
    let theoremEnvironment = Proof.environment(assumedTheorem);
    let listEnvironment = Proof.Core.List.environment();
    let assumptionEnvironmentCount =
      Proof.assumptionCount(assumptionEnvironment);
    let firstIsAssumption = Proof.isAssumption(assumptionEnvironment, 0);
    let firstSelfDependency =
      Proof.dependsOn(assumptionEnvironment, 0, 0);
    let theoremEnvironmentCount = Proof.assumptionCount(theoremEnvironment);
    let theoremFirstIsAssumption = Proof.isAssumption(theoremEnvironment, 0);
    let theoremSecondIsAssumption = Proof.isAssumption(theoremEnvironment, 1);
    let theoremDependency = Proof.dependsOn(theoremEnvironment, 1, 0);
    let listAssumptionCount = Proof.assumptionCount(listEnvironment);
    let appendListDependency = Proof.dependsOn(listEnvironment, 6, 4);
    let appendEqualityDependency = Proof.dependsOn(listEnvironment, 6, 2);
    let theoremEqualityDependency = Proof.dependsOn(listEnvironment, 7, 2);
    let theoremListDependency = Proof.dependsOn(listEnvironment, 7, 4);
    let theoremAppendDependency = Proof.dependsOn(listEnvironment, 7, 6);
    let theoremNaturalDependency = Proof.dependsOn(listEnvironment, 7, 0);
    let result = [
      assumptionEnvironmentCount,
      firstIsAssumption,
      firstSelfDependency,
      theoremEnvironmentCount,
      theoremFirstIsAssumption,
      theoremSecondIsAssumption,
      theoremDependency,
      listAssumptionCount,
      appendListDependency,
      appendEqualityDependency,
      theoremEqualityDependency,
      theoremListDependency,
      theoremAppendDependency,
      theoremNaturalDependency,
    ];
  `);
  let runResult = runToDone(session, 100_000_000);
  assertEquals(runResult.status, "done");
  assertEquals(session.get(0, "result"), [
    1,
    true,
    false,
    1,
    true,
    false,
    true,
    0,
    true,
    false,
    true,
    true,
    true,
    false,
  ]);
});

Deno.test("native named binders resolve lexical scope before kernel checking", () => {
  const session = run(`
    let propositionSort = Proof.Term.proposition();
    let proposition = Proof.Term.namedProduct(
      "Proposition",
      propositionSort,
      Proof.Term.namedProduct(
        "premise",
        Proof.Term.named("Proposition"),
        Proof.Term.named("Proposition")
      )
    );
    let proof = Proof.Term.namedLambda(
      "Proposition",
      propositionSort,
      Proof.Term.namedLambda(
        "premise",
        Proof.Term.named("Proposition"),
        Proof.Term.named("premise")
      )
    );
    let theorem = Proof.theorem(proposition, proof);

    let shadowedProposition = Proof.Term.namedProduct(
      "item",
      propositionSort,
      Proof.Term.namedProduct(
        "item",
        propositionSort,
        Proof.Term.namedProduct(
          "proof",
          Proof.Term.named("item"),
          Proof.Term.named("item")
        )
      )
    );
    let shadowedProof = Proof.Term.namedLambda(
      "item",
      propositionSort,
      Proof.Term.namedLambda(
        "item",
        propositionSort,
        Proof.Term.namedLambda(
          "proof",
          Proof.Term.named("item"),
          Proof.Term.named("proof")
        )
      )
    );
    let shadowedTheorem = Proof.theorem(shadowedProposition, shadowedProof);

    let dangling = Proof.Term.named("dangling");
    let danglingRejected = false;
    try {
      Proof.theorem(propositionSort, dangling);
    } catch (error) {
      danglingRejected = true;
    }
    let result = [
      Proof.Term.tag(proposition),
      Proof.Term.tag(proof),
      Proof.Theorem.isTheorem(theorem),
      Proof.Theorem.isTheorem(shadowedTheorem),
      Proof.Term.isTerm(dangling),
      danglingRejected,
    ];
  `);

  assertEquals(session.get(0, "result"), [6, 7, true, true, true, true]);
});

Deno.test("native unification solves repeated holes and rejects unsound solutions", () => {
  const session = run(`
    let propositionSort = Proof.Term.proposition();
    let hole = Proof.Term.metavariable(0);
    let pattern = Proof.Term.product(
      hole,
      Proof.Term.product(
        hole,
        Proof.Term.product(Proof.Term.bound(1), Proof.Term.bound(2))
      )
    );
    let proposition = Proof.Term.product(
      propositionSort,
      Proof.Term.product(
        propositionSort,
        Proof.Term.product(Proof.Term.bound(1), Proof.Term.bound(2))
      )
    );
    let elaborated = Proof.Term.unify(pattern, proposition);
    let proof = Proof.Term.lambda(
      propositionSort,
      Proof.Term.lambda(
        propositionSort,
        Proof.Term.lambda(Proof.Term.bound(1), Proof.Term.bound(0))
      )
    );
    let theorem = Proof.theorem(elaborated, proof);

    let occursCode = 0;
    try {
      let recursiveHole = Proof.Term.metavariable(1);
      Proof.Term.unify(
        recursiveHole,
        Proof.Term.apply(recursiveHole, propositionSort)
      );
    } catch (error) {
      occursCode = Proof.errorCode();
    }

    let scopeCode = 0;
    try {
      Proof.Term.unify(Proof.Term.metavariable(2), Proof.Term.bound(0));
    } catch (error) {
      scopeCode = Proof.errorCode();
    }

    let mismatchCode = 0;
    try {
      Proof.Term.unify(propositionSort, Proof.Term.type(0));
    } catch (error) {
      mismatchCode = Proof.errorCode();
    }

    let unsolvedCode = 0;
    try {
      Proof.Term.unify(
        Proof.Term.metavariable(3),
        Proof.Term.metavariable(3)
      );
    } catch (error) {
      unsolvedCode = Proof.errorCode();
    }

    let result = [
      Proof.Term.tag(elaborated),
      Proof.Theorem.isTheorem(theorem),
      occursCode,
      scopeCode,
      mismatchCode,
      unsolvedCode,
    ];
  `);

  assertEquals(session.get(0, "result"), [6, true, 70, 71, 72, 73]);
});

Deno.test("native contextual metavariables enforce declared binder scopes", () => {
  const session = run(`
    let propositionSort = Proof.Term.proposition();
    let contextualHole = Proof.Term.metavariable(
      10,
      Proof.Term.sequence([Proof.Term.bound(0)])
    );
    let contextualSolution = Proof.Term.unify(
      contextualHole,
      Proof.Term.bound(0)
    );
    let proposition = Proof.Term.product(
      propositionSort,
      Proof.Term.product(Proof.Term.bound(0), Proof.Term.bound(1))
    );
    let proof = Proof.Term.lambda(
      propositionSort,
      Proof.Term.lambda(Proof.Term.bound(0), contextualSolution)
    );
    let theorem = Proof.theorem(proposition, proof);

    let undeclaredDependencyCode = 0;
    try {
      Proof.Term.unify(
        Proof.Term.metavariable(
          11,
          Proof.Term.sequence([Proof.Term.bound(1)])
        ),
        Proof.Term.bound(0)
      );
    } catch (error) {
      undeclaredDependencyCode = Proof.errorCode();
    }

    let inconsistentScopeCode = 0;
    try {
      let firstOccurrence = Proof.Term.metavariable(
        12,
        Proof.Term.sequence([Proof.Term.bound(0)])
      );
      let secondOccurrence = Proof.Term.metavariable(
        12,
        Proof.Term.sequence([Proof.Term.bound(1)])
      );
      Proof.Term.unify(
        Proof.Term.product(firstOccurrence, secondOccurrence),
        Proof.Term.product(Proof.Term.bound(0), Proof.Term.bound(1))
      );
    } catch (error) {
      inconsistentScopeCode = Proof.errorCode();
    }

    let duplicateScopeRejected = false;
    try {
      Proof.Term.metavariable(
        13,
        Proof.Term.sequence([Proof.Term.bound(0), Proof.Term.bound(0)])
      );
    } catch (error) {
      duplicateScopeRejected = true;
    }

    let nonBinderScopeRejected = false;
    try {
      Proof.Term.metavariable(
        14,
        Proof.Term.sequence([propositionSort])
      );
    } catch (error) {
      nonBinderScopeRejected = true;
    }

    let result = [
      Proof.Term.tag(contextualSolution),
      Proof.Theorem.isTheorem(theorem),
      undeclaredDependencyCode,
      inconsistentScopeCode,
      duplicateScopeRejected,
      nonBinderScopeRejected,
    ];
  `);

  assertEquals(session.get(0, "result"), [2, true, 71, 75, true, true]);
});

Deno.test("native term inference checking and coercion produce kernel-checked terms", () => {
  const session = run(`
    let propositionSort = Proof.Term.proposition();
    let identityType = Proof.Term.product(
      propositionSort,
      Proof.Term.product(Proof.Term.bound(0), Proof.Term.bound(1))
    );
    let identityProof = Proof.Term.lambda(
      propositionSort,
      Proof.Term.lambda(Proof.Term.bound(0), Proof.Term.bound(0))
    );

    let inferredPropositionType = Proof.Term.infer(propositionSort);
    let inferredIdentityType = Proof.Term.infer(identityProof);
    let checkedIdentity = Proof.Term.check(identityProof, inferredIdentityType);
    let checkedTheorem = Proof.theorem(identityType, checkedIdentity);

    let identityCoercion = Proof.Term.lambda(identityType, Proof.Term.bound(0));
    let coercedIdentity = Proof.Term.coerce(
      identityProof,
      identityType,
      identityCoercion
    );
    let coercedTheorem = Proof.theorem(identityType, coercedIdentity);

    let invalidCheckRejected = false;
    try {
      Proof.Term.check(propositionSort, identityType);
    } catch (error) {
      invalidCheckRejected = true;
    }

    let invalidCoercionRejected = false;
    try {
      Proof.Term.coerce(
        propositionSort,
        identityType,
        Proof.Term.lambda(propositionSort, Proof.Term.bound(0))
      );
    } catch (error) {
      invalidCoercionRejected = true;
    }

    let result = [
      Proof.Term.tag(inferredPropositionType),
      Proof.Term.tag(inferredIdentityType),
      Proof.Term.tag(checkedIdentity),
      Proof.Theorem.isTheorem(checkedTheorem),
      Proof.Term.tag(coercedIdentity),
      Proof.Theorem.isTheorem(coercedTheorem),
      invalidCheckRejected,
      invalidCoercionRejected,
    ];
  `);

  assertEquals(
    session.get(0, "result"),
    [1, 6, 7, true, 8, true, true, true],
  );
});

Deno.test("expected types elaborate nested anonymous lambdas", () => {
  const session = run(`
    let propositionSort = Proof.Term.proposition();
    let expectedType = Proof.Term.product(
      propositionSort,
      Proof.Term.product(propositionSort, propositionSort)
    );
    let source = Proof.Term.lambda(
      Proof.Term.lambda(Proof.Term.bound(0))
    );
    let checked = Proof.Term.check(source, expectedType);
    let observed = [
      Proof.Term.tag(checked),
      Proof.Term.tag(Proof.Term.infer(checked)),
    ];
  `);
  assertEquals(session.get(0, "observed"), [7, 6]);
});

Deno.test("native elaborated application resolves implicit and named arguments", () => {
  const session = run(`
    let propositionSort = Proof.Term.proposition();
    let typeZero = Proof.Term.type(0);
    let typeOne = Proof.Term.type(1);
    let genericIdentity = Proof.Term.lambda(
      typeOne,
      Proof.Term.lambda(Proof.Term.bound(0), Proof.Term.bound(0))
    );

    let positional = Proof.Term.elaborateApply(
      genericIdentity,
      ["Type", "value"],
      [true, false],
      [""],
      Proof.Term.sequence([propositionSort])
    );
    let positionalType = Proof.Term.infer(positional);

    let named = Proof.Term.elaborateApply(
      genericIdentity,
      ["Type", "value"],
      [true, false],
      ["value", "Type"],
      Proof.Term.sequence([propositionSort, typeZero])
    );
    let namedType = Proof.Term.infer(named);

    let missingExplicitCode = 0;
    try {
      Proof.Term.elaborateApply(
        genericIdentity,
        ["Type", "value"],
        [true, false],
        [],
        Proof.Term.sequence([])
      );
    } catch (error) {
      missingExplicitCode = Proof.errorCode();
    }

    let unresolvedImplicitCode = 0;
    try {
      Proof.Term.elaborateApply(
        Proof.Term.lambda(typeOne, Proof.Term.bound(0)),
        ["Type"],
        [true],
        [],
        Proof.Term.sequence([])
      );
    } catch (error) {
      unresolvedImplicitCode = Proof.errorCode();
    }

    let unknownNameCode = 0;
    try {
      Proof.Term.elaborateApply(
        genericIdentity,
        ["Type", "value"],
        [true, false],
        ["missing"],
        Proof.Term.sequence([propositionSort])
      );
    } catch (error) {
      unknownNameCode = Proof.errorCode();
    }

    let duplicateParameterCode = 0;
    try {
      Proof.Term.elaborateApply(
        genericIdentity,
        ["Type", "Type"],
        [true, false],
        [""],
        Proof.Term.sequence([propositionSort])
      );
    } catch (error) {
      duplicateParameterCode = Proof.errorCode();
    }

    let duplicateArgumentCode = 0;
    try {
      Proof.Term.elaborateApply(
        genericIdentity,
        ["Type", "value"],
        [true, false],
        ["value", "value"],
        Proof.Term.sequence([propositionSort, propositionSort])
      );
    } catch (error) {
      duplicateArgumentCode = Proof.errorCode();
    }

    let metadataLengthCode = 0;
    try {
      Proof.Term.elaborateApply(
        genericIdentity,
        ["Type", "value"],
        [true],
        [""],
        Proof.Term.sequence([propositionSort])
      );
    } catch (error) {
      metadataLengthCode = Proof.errorCode();
    }

    let nonFunctionCode = 0;
    try {
      Proof.Term.elaborateApply(
        propositionSort,
        ["value"],
        [false],
        [""],
        Proof.Term.sequence([propositionSort])
      );
    } catch (error) {
      nonFunctionCode = Proof.errorCode();
    }

    let result = [
      Proof.Term.tag(positional),
      Proof.Term.tag(positionalType),
      Proof.Term.tag(named),
      Proof.Term.tag(namedType),
      missingExplicitCode,
      unresolvedImplicitCode,
      unknownNameCode,
      duplicateParameterCode,
      duplicateArgumentCode,
      metadataLengthCode,
      nonFunctionCode,
    ];
  `);

  assertEquals(
    session.get(0, "result"),
    [8, 1, 8, 1, 76, 73, 76, 76, 76, 76, 77],
  );
});

Deno.test("native class resolution drives deterministic notation inference", () => {
  const session = run(`
    let typeZero = Proof.Term.type(0);
    let typeOne = Proof.Term.type(1);
    let propositionSort = Proof.Term.proposition();
    let typeEndomorphism = Proof.Term.product(typeZero, typeZero);
    let directEndomorphism = Proof.Term.lambda(typeZero, Proof.Term.bound(0));
    let notationArgument = Proof.Term.product(propositionSort, propositionSort);
    function sameClosedType(actual, expected) {
      try {
        Proof.Term.check(
          Proof.Term.lambda(expected, Proof.Term.bound(0)),
          Proof.Term.product(actual, actual)
        );
        return true;
      } catch (_) {
        return false;
      }
    }
    let genericWithDependency = Proof.Term.lambda(
      typeOne,
      Proof.Term.lambda(
        Proof.Term.bound(0),
        Proof.Term.lambda(Proof.Term.bound(1), Proof.Term.bound(1))
      )
    );
    let candidates = Proof.Term.sequence([
      genericWithDependency,
      directEndomorphism,
      propositionSort,
    ]);

    let resolvedBridge = Proof.Term.resolveInstance(
      typeEndomorphism,
      candidates,
      [1, 0, 0],
      [1, 0, 0],
      [20, 10, 1],
      8,
      32
    );
    let resolvedDirect = Proof.Term.resolveInstance(
      typeEndomorphism,
      candidates,
      [1, 0, 0],
      [1, 0, 0],
      [10, 20, 1],
      8,
      32
    );
    let resolvedAfterRejectedCandidate = Proof.Term.resolveInstance(
      typeZero,
      Proof.Term.sequence([directEndomorphism, propositionSort]),
      [0, 0],
      [0, 0],
      [20, 1],
      4,
      8
    );
    let rejectedCandidateCheck = Proof.Term.check(
      resolvedAfterRejectedCandidate,
      typeZero
    );
    let notationApplication = Proof.Term.apply(
      resolvedBridge,
      notationArgument
    );
    let notationType = Proof.Term.infer(notationApplication);
    let resolvedBridgeCheck = Proof.Term.check(
      resolvedBridge,
      typeEndomorphism
    );
    let resolvedDirectCheck = Proof.Term.check(
      resolvedDirect,
      typeEndomorphism
    );
    let resolvedBesideRejectedTie = Proof.Term.resolveInstance(
      typeEndomorphism,
      Proof.Term.sequence([directEndomorphism, propositionSort]),
      [0, 0],
      [0, 0],
      [10, 10],
      4,
      8
    );
    let rejectedTieCheck = Proof.Term.check(
      resolvedBesideRejectedTie,
      typeEndomorphism
    );

    let noCandidateCode = 0;
    try {
      Proof.Term.resolveInstance(
        propositionSort,
        Proof.Term.sequence([directEndomorphism]),
        [0],
        [0],
        [1],
        4,
        8
      );
    } catch (error) {
      noCandidateCode = Proof.errorCode();
    }

    let candidateBoundCode = 0;
    try {
      Proof.Term.resolveInstance(
        typeZero,
        Proof.Term.sequence([directEndomorphism, propositionSort]),
        [0, 0],
        [0, 0],
        [20, 1],
        4,
        1
      );
    } catch (error) {
      candidateBoundCode = Proof.errorCode();
    }

    let loopCode = 0;
    try {
      Proof.Term.resolveInstance(
        typeEndomorphism,
        Proof.Term.sequence([
          Proof.Term.lambda(typeEndomorphism, Proof.Term.bound(0)),
        ]),
        [0],
        [1],
        [1],
        8,
        16
      );
    } catch (error) {
      loopCode = Proof.errorCode();
    }
    let ambiguityCode = 0;
    try {
      Proof.Term.resolveInstance(
        typeEndomorphism,
        Proof.Term.sequence([directEndomorphism, directEndomorphism]),
        [0, 0],
        [0, 0],
        [10, 10],
        4,
        8
      );
    } catch (error) {
      ambiguityCode = Proof.errorCode();
    }

    let bridgeResult = Proof.Term.apply(resolvedBridgeCheck, notationArgument);
    let directResult = Proof.Term.apply(resolvedDirectCheck, notationArgument);
    let result = [
      sameClosedType(bridgeResult, propositionSort),
      sameClosedType(bridgeResult, notationArgument),
      sameClosedType(directResult, notationArgument),
      sameClosedType(directResult, propositionSort),
      sameClosedType(notationType, typeZero),
      sameClosedType(notationApplication, propositionSort),
      sameClosedType(rejectedCandidateCheck, propositionSort),
      sameClosedType(Proof.Term.apply(rejectedTieCheck, notationArgument), notationArgument),
      noCandidateCode,
      candidateBoundCode,
      loopCode,
      ambiguityCode,
    ];
  `);

  assertEquals(
    session.get(0, "result"),
    [true, false, true, false, true, true, true, true, 78, 79, 80, 81],
  );
  const snapshot = snapshotSession(session);
  const restored = restoreSession(snapshot.vatBytes, snapshot.membraneBytes);
  parseAndSetup(restored, `
    let restoredBridgeCheck = Proof.Term.check(
      resolvedBridge,
      typeEndomorphism
    );
    let restoredDirectCheck = Proof.Term.check(
      resolvedDirect,
      typeEndomorphism
    );
    let restoredBridgeResult = Proof.Term.apply(restoredBridgeCheck, notationArgument);
    let restoredDirectResult = Proof.Term.apply(restoredDirectCheck, notationArgument);
    let restoredResult = [
      sameClosedType(restoredBridgeResult, propositionSort),
      sameClosedType(restoredBridgeResult, notationArgument),
      sameClosedType(restoredDirectResult, notationArgument),
      sameClosedType(restoredDirectResult, propositionSort),
      sameClosedType(Proof.Term.check(resolvedAfterRejectedCandidate, typeZero), propositionSort),
    ];
  `);
  const restoredRun = runToDone(restored, 100_000_000);
  assertEquals(restoredRun.status, "done");
  assertEquals(restored.get(0, "restoredResult"), [true, false, true, false, true]);
});

Deno.test("native universe scopes bind scoped type levels through continuations", () => {
  const session = run(`
    let callbackCount = 0;
    let tags = [];
    let result = Proof.universes(["u", "v"], (universes) => {
      callbackCount = callbackCount + 1;
      Proof.constrain(universes.u, "<", universes.v);
      Proof.constrain(universes.u, "<=", universes.v);
      Proof.constrain(universes.u, "=", universes.u);
      tags.push(Proof.Term.tag(Proof.Term.type(universes.u)));
      tags.push(Proof.Term.tag(Proof.Term.type(universes.v)));
    });
    let observed = [callbackCount, tags, result];
  `);

  assertEquals(session.get(0, "observed"), [1, [1, 1], undefined]);
});

Deno.test("native universe bindings preserve order, freshness, and scope ownership", () => {
  const session = run(`
    let firstUniverse;
    let firstOrder;
    Proof.universes(["u", "v"], (universes) => {
      firstUniverse = universes.u;
      firstOrder = Object.keys(universes);
    });
    let escapedRejected = false;
    try {
      Proof.Term.type(firstUniverse);
    } catch (error) {
      escapedRejected = true;
    }
    let secondUniverse;
    let secondOrder;
    Proof.universes(["u", "v"], (universes) => {
      secondUniverse = universes.u;
      secondOrder = Object.keys(universes);
    });
    let observed = [
      firstOrder,
      secondOrder,
      firstUniverse === secondUniverse,
      escapedRejected,
    ];
  `);

  assertEquals(
    session.get(0, "observed"),
    [["u", "v"], ["u", "v"], false, true],
  );
});

Deno.test("native universe scopes reject inconsistent and cyclic constraints", () => {
  const session = run(`
    let strictSelfRejected = false;
    try {
      Proof.universes(["u"], (universes) => {
        Proof.constrain(universes.u, "<", universes.u);
      });
    } catch (error) {
      strictSelfRejected = true;
    }

    let cycleRejected = false;
    try {
      Proof.universes(["u", "v"], (universes) => {
        Proof.constrain(universes.u, "<", universes.v);
        Proof.constrain(universes.v, "<=", universes.u);
      });
    } catch (error) {
      cycleRejected = true;
    }

    let equalityAccepted = true;
    Proof.universes(["u", "v"], (universes) => {
      Proof.constrain(universes.u, "=", universes.v);
    });
    let observed = [strictSelfRejected, cycleRejected, equalityAccepted];
  `);

  assertEquals(session.get(0, "observed"), [true, true, true]);
});

Deno.test("native universe scopes append ordered assumptions in one environment", () => {
  const session = run(`
    let environment = Proof.universes(["u", "v"], (universes) => {
      Proof.constrain(universes.u, "<", universes.v);
      let first = Proof.assumption(Proof.Term.type(universes.u));
      return Proof.assumption(first, Proof.Term.type(universes.v));
    });
    let observed = [
      Proof.declarationCount(environment),
      Proof.declarationTag(environment, 0),
      Proof.declarationTag(environment, 1),
    ];
  `);

  assertEquals(session.get(0, "observed"), [2, 512, 512]);
});

Deno.test("native universe publication retains only reachable ordered universes", () => {
  const session = run(`
    let directlyReachable = Proof.universes(
      ["unusedBefore", "used", "unusedAfter"],
      (universes) => Proof.assumption(Proof.Term.type(universes.used))
    );
    let constraintReachable = Proof.universes(
      ["left", "right", "unused"],
      (universes) => {
        Proof.constrain(universes.left, "<", universes.right);
        return Proof.assumption(Proof.Term.type(universes.left));
      }
    );
    let direct = Proof.Term.global(directlyReachable, 0, 2);
    let constrained = Proof.Term.global(constraintReachable, 0, 2, 3);
    let directChecked = Proof.Term.check(direct, Proof.Term.type(2));
    let constrainedChecked = Proof.Term.check(constrained, Proof.Term.type(2));
    let unusedDirectRejected = false;
    try {
      Proof.Term.infer(Proof.Term.global(directlyReachable, 0, 0, 2, 3));
    } catch (error) { unusedDirectRejected = true; }
    let unusedConstraintRejected = false;
    try {
      Proof.Term.infer(Proof.Term.global(constraintReachable, 0, 2, 3, 4));
    } catch (error) { unusedConstraintRejected = true; }
    let reversedRejected = false;
    try {
      Proof.Term.infer(Proof.Term.global(constraintReachable, 0, 3, 2));
    } catch (error) { reversedRejected = true; }
    let observed = [
      Proof.checkArtifact(Proof.artifact(directlyReachable)),
      Proof.checkArtifact(Proof.artifact(constraintReachable)),
      Proof.Term.isTerm(directChecked),
      Proof.Term.isTerm(constrainedChecked),
      unusedDirectRejected,
      unusedConstraintRejected,
      reversedRejected,
    ];
  `);
  assertEquals(session.get(0, "observed"), [true, true, true, true, true, true, true]);
});


Deno.test("generalized declarations accept fresh and explicit universe instances", () => {
  const session = run(`
    let polymorphic = Proof.universes(["u"], (universes) =>
      Proof.assumption(Proof.Term.type(universes.u)));
    let proof = Proof.Term.global(polymorphic, 0, 0);
    let inferred = Proof.Term.infer(proof);
    let checked = Proof.Term.check(proof, inferred);
    let freshProof = Proof.Term.global(polymorphic, 0);
    let freshInferred = Proof.Term.infer(freshProof);
    let freshChecked = Proof.Term.check(freshProof, inferred);
    let constrained = Proof.universes(["u", "v"], (universes) => {
      Proof.constrain(universes.u, "<", universes.v);
      return Proof.assumption(Proof.Term.type(universes.v));
    });
    let validConstrained = Proof.Term.global(constrained, 0, 0, 1);
    let freshConstrained = Proof.Term.global(constrained, 0);
    let freshConstrainedInferred = Proof.Term.infer(freshConstrained);
    let freshConstrainedChecked = Proof.Term.check(
      freshConstrained,
      Proof.Term.infer(validConstrained)
    );
    let invalidConstraintRejected = false;
    try {
      Proof.Term.infer(Proof.Term.global(constrained, 0, 1, 0));
    } catch (error) {
      invalidConstraintRejected = true;
    }
    let observed = [
      Proof.Term.tag(proof),
      Proof.Term.tag(inferred),
      Proof.Term.tag(checked),
      Proof.Term.tag(Proof.Term.infer(validConstrained)),
      Proof.Term.tag(freshInferred),
      Proof.Term.tag(freshChecked),
      Proof.Term.tag(freshConstrainedInferred),
      Proof.Term.tag(freshConstrainedChecked),
      invalidConstraintRejected,
      Proof.errorCode(),
    ];
  `);
  assertEquals(
    session.get(0, "observed"),
    [3, 1, 3, 1, 1, 3, 1, 3, true, 0],
  );
});


Deno.test("generalized inductive constructors use fresh and explicit universes", () => {
  const session = run(`
    let baseEnvironment = Proof.Core.Natural.environment();
    let familyIndex = Proof.declarationCount(baseEnvironment);
    let polymorphicEnvironment = Proof.universes(["u", "v"], (universes) => {
      Proof.constrain(universes.u, "<", universes.v);
      let familyReference = Proof.Term.inductiveReference(
        familyIndex,
        universes.u,
        universes.v
      );
      return Proof.inductive(
        baseEnvironment,
        Proof.Term.type(universes.v),
        Proof.Term.sequence([familyReference]),
        0
      );
    });
    let freshConstructor = Proof.Term.constructor(
      polymorphicEnvironment,
      familyIndex,
      0
    );
    let explicitConstructor = Proof.Term.constructor(
      polymorphicEnvironment,
      familyIndex,
      0,
      4,
      5
    );
    let freshType = Proof.Term.infer(freshConstructor);
    let explicitType = Proof.Term.infer(explicitConstructor);
    let invalidRejected = false;
    try {
      Proof.Term.infer(
        Proof.Term.constructor(polymorphicEnvironment, familyIndex, 0, 5, 5)
      );
    } catch (error) {
      invalidRejected = true;
    }
    let observed = [
      Proof.Term.tag(freshConstructor),
      Proof.Term.tag(freshType),
      Proof.Term.tag(explicitConstructor),
      Proof.Term.tag(explicitType),
      invalidRejected,
      Proof.errorCode(),
    ];
  `);

  assertEquals(session.get(0, "observed"), [5, 4, 5, 4, true, 60]);
});
Deno.test("native universe publication rejects ambiguous and unrelated results", () => {
  const session = run(`
    let emptyResult = Proof.universes(["u"], (universes) => {
      let scopedType = Proof.Term.type(universes.u);
    });

    let discardedCandidateRejected = false;
    try {
      Proof.universes(["u"], (universes) => {
        Proof.assumption(Proof.Term.type(universes.u));
      });
    } catch (error) {
      discardedCandidateRejected = true;
    }

    let termRejected = false;
    try {
      Proof.universes(["u"], (universes) => {
        return Proof.Term.type(universes.u);
      });
    } catch (error) {
      termRejected = true;
    }

    let universeRejected = false;
    try {
      Proof.universes(["u"], (universes) => {
        return universes.u;
      });
    } catch (error) {
      universeRejected = true;
    }

    let preexistingEnvironmentRejected = false;
    let preexistingEnvironment = Proof.Core.Natural.environment();
    try {
      Proof.universes(["u"], (universes) => {
        return preexistingEnvironment;
      });
    } catch (error) {
      preexistingEnvironmentRejected = true;
    }

    let independentBranchRejected = false;
    try {
      Proof.universes(["u", "v"], (universes) => {
        let proposition = Proof.Term.proposition();
        Proof.assumption(preexistingEnvironment, proposition);
        return Proof.assumption(preexistingEnvironment, proposition);
      });
    } catch (error) {
      independentBranchRejected = true;
    }

    let observed = [
      emptyResult,
      discardedCandidateRejected,
      termRejected,
      universeRejected,
      preexistingEnvironmentRejected,
      independentBranchRejected,
    ];
  `);

  assertEquals(session.get(0, "observed"), [
    undefined,
    true,
    true,
    true,
    true,
    true,
  ]);
});

Deno.test("nested universe scopes transfer ownership to the outer transaction", () => {
  const session = run(`
    let nestedEnvironment = Proof.universes(["u"], (outerUniverses) => {
      return Proof.universes(["v"], (innerUniverses) => {
        return Proof.assumption(Proof.Term.type(innerUniverses.v));
      });
    });

    let outerFailureRejected = false;
    try {
      Proof.universes(["u"], (outerUniverses) => {
        Proof.universes(["v"], (innerUniverses) => {
          return Proof.assumption(Proof.Term.type(innerUniverses.v));
        });
        throw "outer failure";
      });
    } catch (error) {
      outerFailureRejected = true;
    }

    let observed = [
      Proof.declarationCount(nestedEnvironment),
      Proof.checkArtifact(Proof.artifact(nestedEnvironment)),
      Proof.Term.isTerm(Proof.Term.check(
        Proof.Term.global(nestedEnvironment, 0, 0),
        Proof.Term.type(0)
      )),
      outerFailureRejected,
    ];
  `);

  assertEquals(session.get(0, "observed"), [1, true, true, true]);
});

Deno.test("native universe transaction survives vat restoration during callback", () => {
  const source = `
    let callbackCount = 0;
    let environment = Proof.universes(["u", "v", "unused"], (universes) => {
      callbackCount = callbackCount + 1;
      let total = 0;
      for (let index = 0; index < 100; index = index + 1) {
        total = total + index;
      }
      Proof.constrain(universes.u, "<", universes.v);
      return Proof.assumption(Proof.Term.type(universes.u));
    });
    let artifact = Proof.artifact(environment);
    let freshReference = Proof.Term.global(environment, 0);
    let freshType = Proof.Term.infer(freshReference);
    let reuseEnvironment = Proof.definition(freshType, freshReference);
    let reuseArtifact = Proof.artifact(reuseEnvironment);
    let observed = [
      callbackCount,
      Proof.declarationCount(environment),
      Proof.checkArtifact(artifact),
      Proof.Term.tag(freshReference),
      Proof.Term.tag(freshType),
      Proof.checkArtifact(reuseArtifact),
    ];
  `;
  const uninterrupted = run(source);

  const interrupted = freshSession();
  parseAndSetup(interrupted, source);
  const interruptedRun = interrupted.run(0, 100);
  assertEquals(interruptedRun.status, "paused");
  interrupted.gc();
  const snapshot = snapshotSession(interrupted);
  const restored = restoreSession(snapshot.vatBytes, snapshot.membraneBytes);
  const restoredRun = runToDone(restored, 10_000_000);
  assertEquals(restored.get(0, "observed"), [1, 1, true, 3, 1, true]);
  assertEquals(
    restored.get(0, "artifact"),
    uninterrupted.get(0, "artifact"),
  );
  assertEquals(
    restored.get(0, "reuseArtifact"),
    uninterrupted.get(0, "reuseArtifact"),
  );
});

Deno.test("native Proof.field preserves UTF-8 names and implicitness", () => {
  const session = run(`
    let explicitField = Proof.field("vertical", false);
    let implicitField = Proof.field("λ", true);
    let fields = Proof.Term.sequence([explicitField, implicitField]);
    let naturalEnvironment = Proof.Core.Natural.environment();
    let natural = Proof.Term.inductiveReference(0);
    let constructor = Proof.Term.product(
      natural,
      Proof.Term.product(natural, Proof.Term.inductiveReference(2))
    );
    let recordEnvironment = Proof.record(
      naturalEnvironment,
      Proof.Term.type(0),
      constructor,
      0,
      fields
    );
    let observed = [
      Proof.Term.tag(explicitField),
      Proof.Term.tag(implicitField),
      Proof.declarationCount(recordEnvironment),
      Proof.checkArtifact(Proof.artifact(recordEnvironment)),
    ];
  `);

  assertEquals(session.get(0, "observed"), [264, 264, 6, true]);
});

Deno.test("native Proof.record generates a checked projection for one explicit field", () => {
  const session = run(`
    let naturalEnvironment = Proof.Core.Natural.environment();
    let recordEnvironment = Proof.record(
      naturalEnvironment,
      Proof.Term.type(0),
      Proof.Term.product(
        Proof.Term.inductiveReference(0),
        Proof.Term.inductiveReference(2)
      ),
      0,
      Proof.Term.sequence([Proof.field("value", false)])
    );
    let natural = Proof.Term.inductive(recordEnvironment, 0);
    let zero = Proof.Term.constructor(recordEnvironment, 0, 0);
    let make = Proof.Term.constructor(recordEnvironment, 2, 0);
    let record = Proof.Term.apply(make, zero);
    let projected = Proof.Term.apply(
      Proof.Term.global(recordEnvironment, 4),
      record
    );
    let checked = Proof.Term.check(projected, natural);
    let observed = [
      Proof.declarationCount(recordEnvironment),
      Proof.Term.tag(checked),
      Proof.checkArtifact(Proof.artifact(recordEnvironment)),
    ];
  `);
  assertEquals(session.get(0, "observed"), [5, 8, true]);
});

Deno.test("native Proof.record projects fields of a parameterized record", () => {
  const session = run(`
    let naturalEnvironment = Proof.Core.Natural.environment();
    let typeZero = Proof.Term.type(0);
    let boxEnvironment = Proof.record(
      naturalEnvironment,
      Proof.Term.product(typeZero, typeZero),
      Proof.Term.product(
        typeZero,
        Proof.Term.product(
          Proof.Term.bound(0),
          Proof.Term.apply(
            Proof.Term.inductiveReference(2),
            Proof.Term.bound(1)
          )
        )
      ),
      1,
      Proof.Term.sequence([Proof.field("content", false)])
    );
    let natural = Proof.Term.inductive(boxEnvironment, 0);
    let zero = Proof.Term.constructor(boxEnvironment, 0, 0);
    let box = Proof.Term.apply(
      Proof.Term.apply(
        Proof.Term.constructor(boxEnvironment, 2, 0),
        natural
      ),
      zero
    );
    let projected = Proof.Term.apply(
      Proof.Term.apply(Proof.Term.global(boxEnvironment, 4), natural),
      box
    );
    let checked = Proof.Term.check(projected, natural);
    let observed = [
      Proof.declarationCount(boxEnvironment),
      Proof.Term.tag(checked),
      Proof.checkArtifact(Proof.artifact(boxEnvironment)),
    ];
  `);
  assertEquals(session.get(0, "observed"), [5, 8, true]);
});

Deno.test("native Proof.record projects a dependent later field through the earlier projection", () => {
  const session = run(`
    let naturalEnvironment = Proof.Core.Natural.environment();
    let typeZero = Proof.Term.type(0);
    let equalityReference = Proof.Term.inductiveReference(Proof.declarationCount(naturalEnvironment));
    let equalityType = Proof.Term.product(
      typeZero,
      Proof.Term.product(
        Proof.Term.bound(0),
        Proof.Term.product(Proof.Term.bound(1), Proof.Term.proposition())
      )
    );
    let reflexivityType = Proof.Term.product(
      typeZero,
      Proof.Term.product(
        Proof.Term.bound(0),
        Proof.Term.apply(
          Proof.Term.apply(
            Proof.Term.apply(equalityReference, Proof.Term.bound(1)),
            Proof.Term.bound(0)
          ),
          Proof.Term.bound(0)
        )
      )
    );
    let equalityEnvironment = Proof.inductive(
      naturalEnvironment,
      equalityType,
      Proof.Term.sequence([reflexivityType]),
      1
    );
    let naturalReference = Proof.Term.inductiveReference(0);
    let witnessType = Proof.Term.apply(
      Proof.Term.apply(
        Proof.Term.apply(
          Proof.Term.inductiveReference(2),
          naturalReference
        ),
        Proof.Term.bound(0)
      ),
      Proof.Term.bound(0)
    );
    let recordEnvironment = Proof.record(
      equalityEnvironment,
      Proof.Term.type(0),
      Proof.Term.product(
        naturalReference,
        Proof.Term.product(witnessType, Proof.Term.inductiveReference(4))
      ),
      0,
      Proof.Term.sequence([
        Proof.field("count", false),
        Proof.field("witness", false),
      ])
    );
    let natural = Proof.Term.inductive(recordEnvironment, 0);
    let equality = Proof.Term.inductive(recordEnvironment, 2);
    let zero = Proof.Term.constructor(recordEnvironment, 0, 0);
    let reflexivity = Proof.Term.constructor(recordEnvironment, 2, 0);
    let record = Proof.Term.apply(
      Proof.Term.apply(
        Proof.Term.constructor(recordEnvironment, 4, 0),
        zero
      ),
      Proof.Term.apply(Proof.Term.apply(reflexivity, natural), zero)
    );
    let projectedCount = Proof.Term.apply(
      Proof.Term.global(recordEnvironment, 6),
      record
    );
    let projectedWitness = Proof.Term.apply(
      Proof.Term.global(recordEnvironment, 7),
      record
    );
    let checkedCount = Proof.Term.check(projectedCount, natural);
    let checkedWitness = Proof.Term.check(
      projectedWitness,
      Proof.Term.apply(
        Proof.Term.apply(Proof.Term.apply(equality, natural), zero),
        zero
      )
    );
    let observed = [
      Proof.declarationCount(recordEnvironment),
      Proof.Term.tag(checkedCount),
      Proof.Term.tag(checkedWitness),
      Proof.checkArtifact(Proof.artifact(recordEnvironment)),
    ];
  `);
  assertEquals(session.get(0, "observed"), [8, 8, 8, true]);
});

Deno.test("native Proof.record rejects every source contract violation before publication", () => {
  const session = run(`
    let naturalEnvironment = Proof.Core.Natural.environment();
    let typeZero = Proof.Term.type(0);
    let naturalReference = Proof.Term.inductiveReference(0);
    let singleFieldConstructor = Proof.Term.product(
      naturalReference,
      Proof.Term.inductiveReference(2)
    );
    let attempt = (type, constructor, parameterCount, fields) => {
      try {
        Proof.record(
          naturalEnvironment,
          type,
          constructor,
          parameterCount,
          fields
        );
        return false;
      } catch (error) {
        return true;
      }
    };
    let observed = [
      attempt(typeZero, singleFieldConstructor, 0, Proof.Term.sequence([
        Proof.field("first", false),
        Proof.field("second", false),
      ])),
      attempt(typeZero, singleFieldConstructor, 0, Proof.Term.sequence([
        typeZero,
      ])),
      attempt(typeZero, singleFieldConstructor, 0, Proof.Term.sequence([
        Proof.field("", false),
      ])),
      attempt(
        typeZero,
        Proof.Term.product(
          naturalReference,
          Proof.Term.product(
            naturalReference,
            Proof.Term.inductiveReference(2)
          )
        ),
        0,
        Proof.Term.sequence([
          Proof.field("twice", false),
          Proof.field("twice", true),
        ])
      ),
      attempt(
        typeZero,
        Proof.Term.product(naturalReference, naturalReference),
        0,
        Proof.Term.sequence([Proof.field("value", false)])
      ),
      attempt(
        Proof.Term.product(naturalReference, typeZero),
        Proof.Term.product(
          naturalReference,
          Proof.Term.apply(
            Proof.Term.inductiveReference(2),
            Proof.Term.bound(0)
          )
        ),
        0,
        Proof.Term.sequence([Proof.field("value", false)])
      ),
      attempt(typeZero, singleFieldConstructor, 0, Proof.Term.sequence([
        Proof.field("value", false),
      ])),
    ];
  `);
  assertEquals(
    session.get(0, "observed"),
    [true, true, true, true, true, true, false],
  );
});

Deno.test("native Proof.record publishes canonical metadata and no source descriptors", () => {
  const session = run(`
    let explicitField = Proof.field("vertical", false);
    let implicitField = Proof.field("λ", true);
    let naturalEnvironment = Proof.Core.Natural.environment();
    let naturalReference = Proof.Term.inductiveReference(0);
    let recordEnvironment = Proof.record(
      naturalEnvironment,
      Proof.Term.type(0),
      Proof.Term.product(
        naturalReference,
        Proof.Term.product(naturalReference, Proof.Term.inductiveReference(2))
      ),
      0,
      Proof.Term.sequence([explicitField, implicitField])
    );
    let artifact = Proof.artifact(recordEnvironment);
    // loadArtifact validates the complete artifact before it resolves the
    // declaration index; the RangeError is only reachable past acceptance.
    let acceptedIndependently = false;
    try {
      Proof.loadArtifact(artifact, 99);
    } catch (error) {
      acceptedIndependently = error instanceof RangeError;
    }
    let observed = [
      Proof.declarationCount(recordEnvironment),
      acceptedIndependently,
      Proof.checkArtifact(artifact),
    ];
  `);
  assertEquals(session.get(0, "observed"), [6, true, true]);

  const artifactBytes = new Uint8Array(session.get(0, "artifact"));
  const view = new DataView(
    artifactBytes.buffer,
    artifactBytes.byteOffset,
    artifactBytes.byteLength,
  );
  const records = [];
  for (let offset = 16; offset < artifactBytes.byteLength;) {
    records.push({
      offset,
      wordCount: view.getUint32(offset, true),
      tag: view.getUint32(offset + 4, true),
    });
    offset += view.getUint32(offset, true) * 4;
  }
  // No source descriptor or scratch elaboration record survives publication.
  assertEquals(records.some((record) => record.tag === 0x108), false);

  // The declarations array lists prior entries, the inductive and its
  // recursor, then the projection definitions in field order.
  const declarationsReference = view.getUint32(12, true);
  assertEquals(view.getUint32(declarationsReference + 8, true), 6);
  const declarationTags = [0, 1, 2, 3, 4, 5].map((index) =>
    view.getUint32(
      view.getUint32(declarationsReference + 12 + index * 4, true) + 4,
      true,
    )
  );
  assertEquals(declarationTags, [0x204, 0x206, 0x204, 0x206, 0x201, 0x201]);

  // The record constructor carries one canonical metadata record per field
  // with the actual projection declaration indices.
  const metadata = records.filter((record) => record.tag === 0x107);
  assertEquals(metadata.length, 2);
  const decoder = new TextDecoder();
  const fields = metadata.map((record) => ({
    nameLength: view.getUint32(record.offset + 8, true),
    implicit: view.getUint32(record.offset + 12, true),
    projectionIndex: view.getUint32(record.offset + 16, true),
    name: decoder.decode(
      artifactBytes.subarray(
        record.offset + 20,
        record.offset + 20 + view.getUint32(record.offset + 8, true),
      ),
    ),
  }));
  assertEquals(fields, [
    { nameLength: 8, implicit: 0, projectionIndex: 4, name: "vertical" },
    { nameLength: 2, implicit: 1, projectionIndex: 5, name: "λ" },
  ]);

  // The metadata-bearing constructor declaration references that array.
  const constructorDeclarations = records.filter(
    (record) => record.tag === 0x104,
  );
  assertEquals(
    constructorDeclarations.some((record) => record.wordCount === 5),
    true,
  );
});

Deno.test("native Proof.record construction is deterministic across retries and rejections", () => {
  const source = `
    let build = () => {
      let naturalEnvironment = Proof.Core.Natural.environment();
      let naturalReference = Proof.Term.inductiveReference(0);
      return Proof.record(
        naturalEnvironment,
        Proof.Term.type(0),
        Proof.Term.product(
          naturalReference,
          Proof.Term.product(
            naturalReference,
            Proof.Term.inductiveReference(2)
          )
        ),
        0,
        Proof.Term.sequence([
          Proof.field("left", false),
          Proof.field("right", true),
        ])
      );
    };
    let first = Proof.artifact(build());
    let rejected = false;
    try {
      Proof.record(
        Proof.Core.Natural.environment(),
        Proof.Term.type(0),
        Proof.Term.inductiveReference(2),
        0,
        Proof.Term.sequence([Proof.field("orphan", false)])
      );
    } catch (error) {
      rejected = true;
    }
    let second = Proof.artifact(build());
    let observed = [rejected];
  `;
  const first = run(source);
  const second = run(source);
  assertEquals(first.get(0, "observed"), [true]);
  assertEquals(first.get(0, "first"), first.get(0, "second"));
  assertEquals(first.get(0, "first"), second.get(0, "first"));
});

Deno.test("native Proof.record survives collection and vat restoration", () => {
  const source = `
    let counter = 0;
    for (let index = 0; index < 100; index = index + 1) {
      counter = counter + index;
    }
    let naturalEnvironment = Proof.Core.Natural.environment();
    let naturalReference = Proof.Term.inductiveReference(0);
    let recordEnvironment = Proof.record(
      naturalEnvironment,
      Proof.Term.type(0),
      Proof.Term.product(
        naturalReference,
        Proof.Term.product(naturalReference, Proof.Term.inductiveReference(2))
      ),
      0,
      Proof.Term.sequence([
        Proof.field("left", false),
        Proof.field("right", true),
      ])
    );
    let artifact = Proof.artifact(recordEnvironment);
    let observed = [
      Proof.declarationCount(recordEnvironment),
      Proof.checkArtifact(artifact),
    ];
  `;
  const uninterrupted = run(source);

  const interrupted = freshSession();
  parseAndSetup(interrupted, source);
  const interruptedRun = interrupted.run(0, 100);
  assertEquals(interruptedRun.status, "paused");
  interrupted.gc();
  const snapshot = snapshotSession(interrupted);
  const restored = restoreSession(snapshot.vatBytes, snapshot.membraneBytes);
  const restoredRun = runToDone(restored, 10_000_000);
  assertEquals(restoredRun.status, "done");
  assertEquals(restored.get(0, "observed"), [6, true]);
  assertEquals(restored.get(0, "artifact"), uninterrupted.get(0, "artifact"));
});


Deno.test("native expected source forms build, reject at the kernel, and stay out of artifacts", () => {
  const session = run(`
    let env = Proof.Core.Natural.environment();
    let natural = Proof.Term.inductive(env, 0);
    let zero = Proof.Term.constructor(env, 0, 0);

    let expectedLambda = Proof.Term.lambda(Proof.Term.bound(0));
    let expectedConstructor = Proof.Term.constructor(
      env, 0, 1, Proof.Term.sequence([zero])
    );
    let expectedRecord = Proof.Term.record(
      ["vertical", "λ"],
      Proof.Term.sequence([zero, zero])
    );
    let expectedMatch = Proof.Term.match(
      zero,
      Proof.Term.sequence([Proof.Term.branch(0, zero)])
    );

    // The kernel never accepts a source-only tag.
    let inferRejected = 0;
    try { Proof.Term.infer(expectedConstructor); } catch (e) { inferRejected = inferRejected + 1; }
    try { Proof.Term.infer(expectedRecord); } catch (e) { inferRejected = inferRejected + 1; }
    try { Proof.Term.infer(expectedMatch); } catch (e) { inferRejected = inferRejected + 1; }
    let sealRejected = false;
    try {
      Proof.theorem(natural, expectedMatch);
    } catch (e) { sealRejected = true; }

    // Composition through larger source terms relocates the new records.
    let composite = Proof.Term.apply(expectedMatch, expectedRecord);

    // Out-of-range indices reject before any handle is published.
    let badDeclarationRejected = false;
    try {
      Proof.Term.constructor(env, 5, 0, Proof.Term.sequence([zero]));
    } catch (e) { badDeclarationRejected = true; }
    let badConstructorRejected = false;
    try {
      Proof.Term.constructor(env, 0, 9, Proof.Term.sequence([zero]));
    } catch (e) { badConstructorRejected = true; }

    let observed = [
      Proof.Term.tag(expectedLambda),
      Proof.Term.tag(expectedConstructor),
      Proof.Term.tag(expectedRecord),
      Proof.Term.tag(expectedMatch),
      inferRejected,
      sealRejected,
      Proof.Term.tag(composite),
      badDeclarationRejected,
      badConstructorRejected,
    ];
  `);
  assertEquals(
    session.get(0, "observed"),
    [19, 20, 21, 22, 3, true, 8, true, true],
  );
});

Deno.test("native canonical validation rejects expected source tags in artifact bytes", () => {
  const session = run(`
    let env = Proof.Core.Natural.environment();
    let artifact = Proof.artifact(env);
    let observed = [Proof.checkArtifact(artifact)];
  `);
  assertEquals(session.get(0, "observed"), [true]);
  const artifactBytes = new Uint8Array(session.get(0, "artifact"));
  const view = new DataView(
    artifactBytes.buffer,
    artifactBytes.byteOffset,
    artifactBytes.byteLength,
  );
  const workspaceLength = 4 * 1024 * 1024;
  const artifactBase = session.mem.wasm.exports.test_carve_scratch(
    artifactBytes.byteLength + workspaceLength,
  );
  const destination = new Uint8Array(
    session.mem.buffer,
    session.mem.abs(artifactBase),
    artifactBytes.byteLength,
  );
  const checker = session.mem.wasm.exports.proof_check_artifact;
  // Find one term record and forge each source-only tag over it; canonical
  // validation must reject every one.
  let termOffset = 0;
  for (let offset = 16; offset < artifactBytes.byteLength;) {
    const tag = view.getUint32(offset + 4, true);
    if (tag >= 1 && tag <= 16) {
      termOffset = offset;
      break;
    }
    offset += view.getUint32(offset, true) * 4;
  }
  for (const forgedTag of [19, 20, 21, 22]) {
    destination.set(artifactBytes);
    new DataView(
      session.mem.buffer,
      session.mem.abs(artifactBase),
      artifactBytes.byteLength,
    ).setUint32(termOffset + 4, forgedTag, true);
    const result = checker(
      artifactBase,
      artifactBytes.byteLength,
      workspaceLength,
    );
    assertEquals(result !== 0, true);
  }
});

Deno.test("native named locals resolve through expected source forms", () => {
  const session = run(`
    let env = Proof.Core.Natural.environment();
    let natural = Proof.Term.inductive(env, 0);
    let zero = Proof.Term.constructor(env, 0, 0);

    // namedLambda resolves the named local inside a nested expected lambda
    // one binder deeper, and inside expected constructor, record, and match
    // children at the binder's own depth.
    let throughExpectedLambda = Proof.Term.namedLambda(
      "outer",
      natural,
      Proof.Term.lambda(Proof.Term.named("outer"))
    );
    let throughExpectedConstructor = Proof.Term.namedLambda(
      "value",
      natural,
      Proof.Term.constructor(
        env, 0, 1,
        Proof.Term.sequence([Proof.Term.named("value")])
      )
    );
    let throughExpectedRecord = Proof.Term.namedLambda(
      "value",
      natural,
      Proof.Term.record(
        ["field"],
        Proof.Term.sequence([Proof.Term.named("value")])
      )
    );
    let throughExpectedMatch = Proof.Term.namedLambda(
      "value",
      natural,
      Proof.Term.match(
        Proof.Term.named("value"),
        Proof.Term.sequence([
          Proof.Term.branch(0, Proof.Term.named("value")),
        ])
      )
    );
    let observed = [
      Proof.Term.tag(throughExpectedLambda),
      Proof.Term.tag(throughExpectedConstructor),
      Proof.Term.tag(throughExpectedRecord),
      Proof.Term.tag(throughExpectedMatch),
    ];
  `);
  assertEquals(session.get(0, "observed"), [7, 7, 7, 7]);
});

Deno.test("native expected source forms survive vat restoration", () => {
  const source = `
    let counter = 0;
    for (let index = 0; index < 100; index = index + 1) {
      counter = counter + index;
    }
    let env = Proof.Core.Natural.environment();
    let zero = Proof.Term.constructor(env, 0, 0);
    let expectedRecord = Proof.Term.record(
      ["vertical", "λ"],
      Proof.Term.sequence([zero, zero])
    );
    let expectedMatch = Proof.Term.match(
      zero,
      Proof.Term.sequence([Proof.Term.branch(0, zero)])
    );
    let observed = [
      Proof.Term.tag(expectedRecord),
      Proof.Term.tag(expectedMatch),
    ];
  `;
  const uninterrupted = run(source);
  assertEquals(uninterrupted.get(0, "observed"), [21, 22]);

  const interrupted = freshSession();
  parseAndSetup(interrupted, source);
  const interruptedRun = interrupted.run(0, 100);
  assertEquals(interruptedRun.status, "paused");
  interrupted.gc();
  const snapshot = snapshotSession(interrupted);
  const restored = restoreSession(snapshot.vatBytes, snapshot.membraneBytes);
  const restoredRun = runToDone(restored, 10_000_000);
  assertEquals(restoredRun.status, "done");
  assertEquals(restored.get(0, "observed"), [21, 22]);
});

Deno.test("native elaboration lowers expected constructors and nested source forms", () => {
  const session = run(`
    let env = Proof.Core.Natural.environment();
    let natural = Proof.Term.inductive(env, 0);
    let zero = Proof.Term.constructor(env, 0, 0);
    let one = Proof.Term.check(
      Proof.Term.constructor(env, 0, 1, Proof.Term.sequence([zero])),
      natural
    );
    // A nested expected match supplies the constructor field.
    let nested = Proof.Term.check(
      Proof.Term.constructor(env, 0, 1, Proof.Term.sequence([
        Proof.Term.match(zero, Proof.Term.sequence([
          Proof.Term.branch(0, zero),
          Proof.Term.branch(1, Proof.Term.lambda(natural, Proof.Term.bound(0))),
        ])),
      ])),
      natural
    );
    let tooFewRejected = false;
    try {
      Proof.Term.check(
        Proof.Term.constructor(env, 0, 1, Proof.Term.sequence([])),
        natural
      );
    } catch (e) { tooFewRejected = true; }
    let tooManyRejected = false;
    try {
      Proof.Term.check(
        Proof.Term.constructor(env, 0, 0, Proof.Term.sequence([zero])),
        natural
      );
    } catch (e) { tooManyRejected = true; }
    let observed = [
      Proof.Term.tag(one),
      Proof.Term.tag(nested),
      tooFewRejected,
      tooManyRejected,
    ];
  `);
  assertEquals(session.get(0, "observed"), [8, 8, true, true]);
});

Deno.test("native elaboration lowers record literals through canonical field metadata", () => {
  const session = run(`
    let env = Proof.Core.Natural.environment();
    let naturalReference = Proof.Term.inductiveReference(0);
    let recordEnvironment = Proof.record(
      env, Proof.Term.type(0),
      Proof.Term.product(
        naturalReference,
        Proof.Term.product(naturalReference, Proof.Term.inductiveReference(2))
      ),
      0,
      Proof.Term.sequence([
        Proof.field("left", false),
        Proof.field("right", false),
      ])
    );
    let pairType = Proof.Term.inductive(recordEnvironment, 2);
    let natural = Proof.Term.inductive(recordEnvironment, 0);
    let zero = Proof.Term.constructor(recordEnvironment, 0, 0);
    let one = Proof.Term.apply(
      Proof.Term.constructor(recordEnvironment, 0, 1), zero);
    // Values supplied out of declaration order map through the metadata.
    let literal = Proof.Term.check(
      Proof.Term.record(
        ["right", "left"],
        Proof.Term.sequence([one, zero])
      ),
      pairType
    );
    // The elaborated literal is an ordinary core term: it rechecks and the
    // generated projection applies to it.
    let projected = Proof.Term.check(
      Proof.Term.apply(Proof.Term.global(recordEnvironment, 4), literal),
      natural
    );
    let attempt = (names, values) => {
      try {
        Proof.Term.check(
          Proof.Term.record(names, values), pairType);
        return false;
      } catch (e) { return true; }
    };
    let observed = [
      Proof.Term.tag(literal),
      Proof.Term.tag(projected),
      attempt(["left", "unknown"], Proof.Term.sequence([zero, zero])),
      attempt(["left", "left"], Proof.Term.sequence([zero, zero])),
      attempt(["left"], Proof.Term.sequence([zero])),
      attempt(["left", "right"], Proof.Term.sequence([zero])),
    ];
  `);
  assertEquals(
    session.get(0, "observed"),
    [8, 8, true, true, true, true],
  );
});

Deno.test("native elaboration lowers a dependent record literal out of field order", () => {
  const session = run(`
    let naturalEnvironment = Proof.Core.Natural.environment();
    let typeZero = Proof.Term.type(0);
    let equalityReference = Proof.Term.inductiveReference(Proof.declarationCount(naturalEnvironment));
    let equalityType = Proof.Term.product(
      typeZero,
      Proof.Term.product(
        Proof.Term.bound(0),
        Proof.Term.product(Proof.Term.bound(1), Proof.Term.proposition())
      )
    );
    let reflexivityType = Proof.Term.product(
      typeZero,
      Proof.Term.product(
        Proof.Term.bound(0),
        Proof.Term.apply(
          Proof.Term.apply(
            Proof.Term.apply(equalityReference, Proof.Term.bound(1)),
            Proof.Term.bound(0)
          ),
          Proof.Term.bound(0)
        )
      )
    );
    let equalityEnvironment = Proof.inductive(
      naturalEnvironment,
      equalityType,
      Proof.Term.sequence([reflexivityType]),
      1
    );
    let naturalReference = Proof.Term.inductiveReference(0);
    let witnessType = Proof.Term.apply(
      Proof.Term.apply(
        Proof.Term.apply(Proof.Term.inductiveReference(2), naturalReference),
        Proof.Term.bound(0)
      ),
      Proof.Term.bound(0)
    );
    let recordEnvironment = Proof.record(
      equalityEnvironment,
      Proof.Term.type(0),
      Proof.Term.product(
        naturalReference,
        Proof.Term.product(witnessType, Proof.Term.inductiveReference(4))
      ),
      0,
      Proof.Term.sequence([
        Proof.field("count", false),
        Proof.field("witness", false),
      ])
    );
    let natural = Proof.Term.inductive(recordEnvironment, 0);
    let zero = Proof.Term.constructor(recordEnvironment, 0, 0);
    let reflexivity = Proof.Term.constructor(recordEnvironment, 2, 0);
    let recordType = Proof.Term.inductive(recordEnvironment, 4);
    // The later witness field depends on the earlier count field; supplying
    // the literal out of order still checks in declaration order.
    let literal = Proof.Term.check(
      Proof.Term.record(
        ["witness", "count"],
        Proof.Term.sequence([
          Proof.Term.apply(
            Proof.Term.apply(reflexivity, natural), zero),
          zero,
        ])
      ),
      recordType
    );
    let observed = [Proof.Term.tag(literal)];
  `);
  assertEquals(session.get(0, "observed"), [8]);
});

Deno.test("native elaboration derives a constant motive for motive-less matches", () => {
  const session = run(`
    let env = Proof.Core.Natural.environment();
    let natural = Proof.Term.inductive(env, 0);
    let zero = Proof.Term.constructor(env, 0, 0);
    // Predecessor with a motive-less match under a source lambda.
    let predecessor = Proof.Term.check(
      Proof.Term.lambda(
        Proof.Term.match(Proof.Term.bound(0), Proof.Term.sequence([
          Proof.Term.branch(0, zero),
          Proof.Term.branch(1, Proof.Term.lambda(natural, Proof.Term.bound(0))),
        ]))
      ),
      Proof.Term.product(natural, natural)
    );
    let badOrdinalRejected = false;
    try {
      Proof.Term.check(
        Proof.Term.match(zero, Proof.Term.sequence([
          Proof.Term.branch(7, zero),
        ])),
        natural
      );
    } catch (e) { badOrdinalRejected = true; }
    let missingBranchRejected = false;
    try {
      Proof.Term.check(
        Proof.Term.match(zero, Proof.Term.sequence([
          Proof.Term.branch(0, zero),
        ])),
        natural
      );
    } catch (e) { missingBranchRejected = true; }
    let observed = [
      Proof.Term.tag(predecessor),
      badOrdinalRejected,
      missingBranchRejected,
    ];
  `);
  assertEquals(session.get(0, "observed"), [7, true, true]);
});

Deno.test("native elaboration is the default route for nested source forms", () => {
  const session = run(`
    let env = Proof.Core.Natural.environment();
    let natural = Proof.Term.inductive(env, 0);
    let zero = Proof.Term.constructor(env, 0, 0);
    // The source match sits under a core lambda root: routing must select
    // elaboration from the artifact contents, not the root tag.
    let predecessor = Proof.Term.check(
      Proof.Term.lambda(natural,
        Proof.Term.match(Proof.Term.bound(0), Proof.Term.sequence([
          Proof.Term.branch(0, zero),
          Proof.Term.branch(1, Proof.Term.lambda(natural, Proof.Term.bound(0))),
        ]))),
      Proof.Term.product(natural, natural)
    );
    let observed = [Proof.Term.tag(predecessor)];
  `);
  assertEquals(session.get(0, "observed"), [7]);
});

Deno.test("native declaration sealing elaborates source bodies", () => {
  const session = run(`
    let env = Proof.Core.Natural.environment();
    let natural = Proof.Term.inductive(env, 0);
    let zero = Proof.Term.constructor(env, 0, 0);
    let predecessorType = Proof.Term.product(natural, natural);
    let predecessorBody = Proof.Term.lambda(
      Proof.Term.match(Proof.Term.bound(0), Proof.Term.sequence([
        Proof.Term.branch(0, zero),
        Proof.Term.branch(1, Proof.Term.lambda(natural, Proof.Term.bound(0))),
      ])));
    let defined = Proof.definition(predecessorType, predecessorBody);
    let opaque = Proof.opaqueDefinition(predecessorType, predecessorBody);
    let propositionSort = Proof.Term.proposition();
    let identityProposition = Proof.Term.product(
      propositionSort,
      Proof.Term.product(Proof.Term.bound(0), Proof.Term.bound(1)));
    let theorem = Proof.theorem(identityProposition,
      Proof.Term.lambda(propositionSort, Proof.Term.lambda(Proof.Term.bound(0))));
    let illTypedRejected = false;
    try {
      Proof.definition(predecessorType,
        Proof.Term.lambda(
          Proof.Term.record(["x"], Proof.Term.sequence([zero]))));
    } catch (e) { illTypedRejected = true; }
    // Sealed artifacts are canonical: checkArtifact independently rechecks.
    let accepted = Proof.checkArtifact(Proof.artifact(defined));
    let observed = [
      Proof.declarationCount(defined),
      Proof.declarationCount(opaque),
      Proof.Theorem.isTheorem(theorem),
      illTypedRejected,
      accepted,
    ];
  `);
  assertEquals(session.get(0, "observed"), [3, 3, true, true, true]);
});

Deno.test("native generalized environment artifacts pass independent rechecking", () => {
  const session = run(`
    let baseEnvironment = Proof.Core.Natural.environment();
    let familyIndex = Proof.declarationCount(baseEnvironment);
    let polymorphicEnvironment = Proof.universes(["u", "v"], (universes) => {
      Proof.constrain(universes.u, "<", universes.v);
      let familyReference = Proof.Term.inductiveReference(
        familyIndex, universes.u, universes.v);
      return Proof.inductive(
        baseEnvironment,
        Proof.Term.type(universes.v),
        Proof.Term.sequence([familyReference]),
        0
      );
    });
    // Monomorphic declarations keep zero-variable contexts, so references
    // with empty universe-argument arrays remain valid under the checker.
    let accepted = Proof.checkArtifact(Proof.artifact(polymorphicEnvironment));
    let inferred = Proof.Term.infer(
      Proof.Term.constructor(polymorphicEnvironment, familyIndex, 0));
    let observed = [accepted, Proof.Term.tag(inferred)];
  `);
  assertEquals(session.get(0, "observed"), [true, 4]);
});



Deno.test("native match rejects a branch for an impossible indexed constructor", () => {
  const session = freshSession({ heapSize: 32 * 1024 * 1024 });
  parseAndSetup(session, `
    let naturalEnvironment = Proof.Core.Natural.environment();
    let natural = Proof.Term.inductive(naturalEnvironment, 0);
    let zero = Proof.Term.constructor(naturalEnvironment, 0, 0);
    let successor = Proof.Term.constructor(naturalEnvironment, 0, 1);
    let vectorReference = Proof.Term.inductiveReference(Proof.declarationCount(naturalEnvironment));
    let typeZero = Proof.Term.type(0);
    let vectorType = Proof.Term.product(
      typeZero,
      Proof.Term.product(natural, typeZero)
    );
    let emptyVectorType = Proof.Term.product(
      typeZero,
      Proof.Term.apply(
        Proof.Term.apply(vectorReference, Proof.Term.bound(0)),
        zero
      )
    );
    let vectorTailType = Proof.Term.apply(
      Proof.Term.apply(vectorReference, Proof.Term.bound(2)),
      Proof.Term.bound(1)
    );
    let successorLength = Proof.Term.apply(
      successor,
      Proof.Term.bound(2)
    );
    let prependedVectorType = Proof.Term.apply(
      Proof.Term.apply(vectorReference, Proof.Term.bound(3)),
      successorLength
    );
    let prependVectorType = Proof.Term.product(
      typeZero,
      Proof.Term.product(
        natural,
        Proof.Term.product(
          Proof.Term.bound(1),
          Proof.Term.product(vectorTailType, prependedVectorType)
        )
      )
    );
    let vectorEnvironment = Proof.inductive(
      naturalEnvironment,
      vectorType,
      Proof.Term.sequence([emptyVectorType, prependVectorType]),
      1
    );

    natural = Proof.Term.inductive(vectorEnvironment, 0);
    successor = Proof.Term.constructor(vectorEnvironment, 0, 1);
    let vector = Proof.Term.inductive(vectorEnvironment, 2);
    let vectorAtSuccessor = Proof.Term.apply(
      Proof.Term.apply(vector, Proof.Term.bound(1)),
      Proof.Term.apply(successor, Proof.Term.bound(0))
    );
    let headType = Proof.Term.product(
      typeZero,
      Proof.Term.product(
        natural,
        Proof.Term.product(vectorAtSuccessor, Proof.Term.bound(2))
      )
    );
    let vectorPredicateDomain = Proof.Term.apply(
      Proof.Term.apply(vector, Proof.Term.bound(3)),
      Proof.Term.bound(0)
    );
    let headPredicate = Proof.Term.lambda(
      natural,
      Proof.Term.lambda(
        vectorPredicateDomain,
        Proof.Term.bound(4)
      )
    );
    let constructorTailType = Proof.Term.apply(
      Proof.Term.apply(vector, Proof.Term.bound(4)),
      Proof.Term.bound(1)
    );
    let headBranch = Proof.Term.branch(
      1,
      Proof.Term.lambda(
        natural,
        Proof.Term.lambda(
          Proof.Term.bound(3),
          Proof.Term.lambda(constructorTailType, Proof.Term.bound(1))
        )
      )
    );
    // The scrutinee's length index is successor(n), so the empty
    // constructor is impossible: supplying its branch must reject.
    let impossibleBranch = Proof.Term.branch(0, Proof.Term.bound(2));
    let headBody = Proof.Term.lambda(
      typeZero,
      Proof.Term.lambda(
        natural,
        Proof.Term.lambda(
          vectorAtSuccessor,
          Proof.Term.match(
            Proof.Term.bound(0),
            headPredicate,
            Proof.Term.sequence([impossibleBranch, headBranch])
          )
        )
      )
    );
    let impossibleBranchRejected = false;
    try {
      Proof.definition(headType, headBody);
    } catch (error) {
      impossibleBranchRejected = true;
    }
    let observed = [impossibleBranchRejected, Proof.errorCode()];
  `);
  let runResult = runToDone(session, 10_000_000);
  assertEquals(runResult.status, "done");
  assertEquals(session.get(0, "observed"), [true, 52]);
});

Deno.test("native proof states refine goals and seal kernel-checked terms", () => {
  const session = run(`
    let propositionSort = Proof.Term.proposition();
    let identityProposition = Proof.Term.product(
      propositionSort,
      Proof.Term.product(Proof.Term.bound(0), Proof.Term.bound(1))
    );
    let env = Proof.assumption(identityProposition);
    let statement = Proof.Term.product(
      identityProposition, identityProposition);
    let state = Proof.State.begin(env, statement);
    let introduced = Proof.State.introduce(state, 0);
    let closed = Proof.State.exact(introduced, 0, Proof.Term.bound(0));
    let proofTerm = Proof.State.seal(closed);
    let theorem = Proof.theorem(statement, proofTerm);
    let observed = [
      Proof.State.goalCount(state),
      Proof.State.goalCount(introduced),
      Proof.State.goalCount(closed),
      Proof.Theorem.isTheorem(theorem),
      Proof.checkArtifact(Proof.Theorem.artifact(theorem)),
    ];
  `);
  assertEquals(session.get(0, "observed"), [
    1,
    1,
    0,
    true,
    true,
  ]);
});

Deno.test("native failed tactics throw and leave the input state unchanged", () => {
  const session = run(`
    let propositionSort = Proof.Term.proposition();
    let identityProposition = Proof.Term.product(
      propositionSort,
      Proof.Term.product(Proof.Term.bound(0), Proof.Term.bound(1))
    );
    let env = Proof.assumption(identityProposition);
    let statement = Proof.Term.product(
      identityProposition, identityProposition);
    let introduced = Proof.State.introduce(
      Proof.State.begin(env, statement), 0);
    let targetBefore = Proof.Term.render(Proof.State.goalTarget(introduced, 0));
    let illTypedRejected = false;
    let illTypedCode = 0;
    try {
      Proof.State.exact(introduced, 0, Proof.Term.proposition());
    } catch (error) {
      illTypedRejected = true;
      illTypedCode = Proof.errorCode();
    }
    let missingGoalRejected = false;
    let missingGoalCode = 0;
    try {
      Proof.State.exact(introduced, 5, Proof.Term.bound(0));
    } catch (error) {
      missingGoalRejected = true;
      missingGoalCode = Proof.errorCode();
    }
    let closed = Proof.State.exact(introduced, 0, Proof.Term.bound(0));
    let sealedEarlyRejected = false;
    let sealedEarlyCode = 0;
    try {
      Proof.State.seal(introduced);
    } catch (error) {
      sealedEarlyRejected = true;
      sealedEarlyCode = Proof.errorCode();
    }
    let introduceLeafRejected = false;
    let introduceLeafCode = 0;
    try {
      // The open goal is the identity proposition; three more
      // introductions unwrap both products and reach the bound leaf.
      Proof.State.introduce(
        Proof.State.introduce(
          Proof.State.introduce(introduced, 0), 0), 0);
    } catch (error) {
      introduceLeafRejected = true;
      introduceLeafCode = Proof.errorCode();
    }
    let observed = [
      illTypedRejected,
      missingGoalRejected, missingGoalCode,
      sealedEarlyRejected, sealedEarlyCode,
      introduceLeafRejected, introduceLeafCode,
      Proof.State.goalCount(introduced),
      Proof.Term.render(Proof.State.goalTarget(introduced, 0)) ===
        targetBefore,
      Proof.State.goalCount(closed),
    ];
  `);
  assertEquals(session.get(0, "observed"), [
    true,
    true, 82,
    true, 81,
    true, 80,
    1,
    true,
    0,
  ]);
});

Deno.test("native proof states survive collection and vat restoration mid-proof", () => {
  const source = `
    let counter = 0;
    for (let index = 0; index < 100; index = index + 1) {
      counter = counter + 1;
    }
    let propositionSort = Proof.Term.proposition();
    let identityProposition = Proof.Term.product(
      propositionSort,
      Proof.Term.product(Proof.Term.bound(0), Proof.Term.bound(1))
    );
    let env = Proof.assumption(identityProposition);
    let statement = Proof.Term.product(
      identityProposition, identityProposition);
    let introduced = Proof.State.introduce(
      Proof.State.begin(env, statement), 0);
    for (let index = 0; index < 100; index = index + 1) {
      counter = counter + 1;
    }
    let closed = Proof.State.exact(introduced, 0, Proof.Term.bound(0));
    let proofTerm = Proof.State.seal(closed);
    let observed = [
      Proof.State.goalCount(introduced),
      Proof.checkArtifact(
        Proof.Theorem.artifact(Proof.theorem(statement, proofTerm))),
    ];
  `;
  const uninterrupted = freshSession();
  parseAndSetup(uninterrupted, source);
  assertEquals(runToDone(uninterrupted, 10_000_000).status, "done");

  const interrupted = freshSession();
  parseAndSetup(interrupted, source);
  const interruptedRun = interrupted.run(0, 100);
  assertEquals(interruptedRun.status, "paused");
  interrupted.gc();
  const snapshot = snapshotSession(interrupted);
  const restored = restoreSession(snapshot.vatBytes, snapshot.membraneBytes);
  const restoredRun = runToDone(restored, 10_000_000);
  assertEquals(restoredRun.status, "done");
  assertEquals(
    restored.get(0, "observed"),
    uninterrupted.get(0, "observed"),
  );
  assertEquals(restored.get(0, "observed"), [
    1,
    true,
  ]);
});

Deno.test("native constructor and apply tactics open and close argument goals", () => {
  const session = run(`
    let env = Proof.Core.Natural.environment();
    let natural = Proof.Term.inductive(env, 0);
    let state = Proof.State.begin(env, natural);
    let one = Proof.State.constructor(state, 0, 1);
    let zero = Proof.State.constructor(one, 0, 0);
    let numeral = Proof.State.seal(zero);
    let propositionSort = Proof.Term.proposition();
    let identityProposition = Proof.Term.product(
      propositionSort,
      Proof.Term.product(Proof.Term.bound(0), Proof.Term.bound(1))
    );
    let assumptionEnvironment = Proof.assumption(identityProposition);
    let applied = Proof.State.apply(
      Proof.State.begin(assumptionEnvironment, identityProposition), 0,
      Proof.Term.global(assumptionEnvironment, 0));
    let observed = [
      Proof.State.goalCount(one),
      Proof.State.goalCount(zero),
      Proof.Term.isTerm(Proof.Term.check(numeral, natural)),
      Proof.State.goalCount(applied),
      Proof.checkArtifact(Proof.Theorem.artifact(
        Proof.theorem(identityProposition, Proof.State.seal(applied)))),
    ];
  `);
  assertEquals(session.get(0, "observed"), [
    1,
    0,
    true,
    0,
    true,
  ]);
});

Deno.test("native apply leaves unsolved argument holes as ordered goals", () => {
  const session = run(`
    let propositionSort = Proof.Term.proposition();
    let identityProposition = Proof.Term.product(
      propositionSort,
      Proof.Term.product(Proof.Term.bound(0), Proof.Term.bound(1))
    );
    let assumptionEnvironment = Proof.assumption(identityProposition);
    let introduced = Proof.State.introduce(
      Proof.State.introduce(
        Proof.State.begin(assumptionEnvironment, identityProposition), 0), 0);
    // The goal is #1 under context [#0, Prop]. Applying the assumed
    // identity solves the proposition hole by unification and leaves
    // exactly the proof-argument hole as one goal.
    let applied = Proof.State.apply(
      introduced, 0, Proof.Term.global(assumptionEnvironment, 0));
    let closed = Proof.State.assumption(applied, 0);
    let proofTerm = Proof.State.seal(closed);
    let theorem = Proof.theorem(identityProposition, proofTerm);
    let observed = [
      Proof.State.goalCount(applied),
      Proof.State.goalCount(closed),
      Proof.checkArtifact(Proof.Theorem.artifact(theorem)),
    ];
  `);
  assertEquals(session.get(0, "observed"), [
    1,
    0,
    true,
  ]);
});

Deno.test("native tactic rejections report codes and preserve inputs", () => {
  const session = run(`
    let propositionSort = Proof.Term.proposition();
    let identityProposition = Proof.Term.product(
      propositionSort,
      Proof.Term.product(Proof.Term.bound(0), Proof.Term.bound(1))
    );
    let assumptionEnvironment = Proof.assumption(identityProposition);
    let state = Proof.State.begin(assumptionEnvironment, identityProposition);
    let constructorRejected = false;
    let constructorCode = 0;
    try {
      // The goal target is a product, not an inductive family.
      Proof.State.constructor(state, 0, 0);
    } catch (error) {
      constructorRejected = true;
      constructorCode = Proof.errorCode();
    }
    let assumptionRejected = false;
    let assumptionCode = 0;
    try {
      // The empty context offers no convertible hypothesis.
      Proof.State.assumption(state, 0);
    } catch (error) {
      assumptionRejected = true;
      assumptionCode = Proof.errorCode();
    }
    let applyRejected = false;
    try {
      // A saturated proposition cannot reach the goal by application.
      Proof.State.apply(state, 0, Proof.Term.proposition());
    } catch (error) {
      applyRejected = true;
    }
    let observed = [
      constructorRejected, constructorCode,
      assumptionRejected, assumptionCode,
      applyRejected,
      Proof.State.goalCount(state),
    ];
  `);
  assertEquals(session.get(0, "observed"), [
    true, 86,
    true, 84,
    true,
    1,
  ]);
});

Deno.test("native cases splits a hypothesis into dependent constructor goals", () => {
  const session = run(`
    let env = Proof.Core.Natural.environment();
    let natural = Proof.Term.inductive(env, 0);
    let split = Proof.State.cases(
      Proof.State.introduce(
        Proof.State.begin(env, Proof.Term.product(natural, natural)), 0),
      0, 0);
    let closed = Proof.State.exact(
      Proof.State.introduce(
        Proof.State.constructor(split, 0, 0), 0),
      0, Proof.Term.bound(0));
    let proofTerm = Proof.State.seal(closed);
    let observed = [
      Proof.State.goalCount(split),
      Proof.Term.tag(
        Proof.Term.check(proofTerm, Proof.Term.product(natural, natural))),
    ];
  `);
  assertEquals(session.get(0, "observed"), [
    2,
    7,
  ]);
});

Deno.test("native induction supplies induction hypotheses through a checked fixed point", () => {
  const session = run(`
    let env = Proof.Core.Natural.environment();
    let natural = Proof.Term.inductive(env, 0);
    let split = Proof.State.induction(
      Proof.State.introduce(
        Proof.State.begin(env, Proof.Term.product(natural, natural)), 0),
      0, 0);
    // Zero branch: zero. Successor branch: introduce the induction
    // hypothesis, then answer with its successor.
    let closed = Proof.State.exact(
      Proof.State.constructor(
        Proof.State.introduce(
          Proof.State.constructor(split, 0, 0), 0),
        0, 1),
      0, Proof.Term.bound(0));
    let proofTerm = Proof.State.seal(closed);
    let observed = [
      Proof.State.goalCount(split),
      Proof.Term.tag(
        Proof.Term.check(proofTerm, Proof.Term.product(natural, natural))),
    ];
  `);
  assertEquals(session.get(0, "observed"), [
    2,
    7,
  ]);
});

Deno.test("native cases rejects non-inductive and missing hypotheses", () => {
  const session = run(`
    let propositionSort = Proof.Term.proposition();
    let identityProposition = Proof.Term.product(
      propositionSort,
      Proof.Term.product(Proof.Term.bound(0), Proof.Term.bound(1))
    );
    let assumptionEnvironment = Proof.assumption(identityProposition);
    let introduced = Proof.State.introduce(
      Proof.State.begin(
        assumptionEnvironment,
        Proof.Term.product(identityProposition, identityProposition)), 0);
    let nonInductiveRejected = false;
    let nonInductiveCode = 0;
    try {
      Proof.State.cases(introduced, 0, 0);
    } catch (error) {
      nonInductiveRejected = true;
      nonInductiveCode = Proof.errorCode();
    }
    let missingRejected = false;
    let missingCode = 0;
    try {
      Proof.State.cases(introduced, 0, 7);
    } catch (error) {
      missingRejected = true;
      missingCode = Proof.errorCode();
    }
    let observed = [
      nonInductiveRejected, nonInductiveCode,
      missingRejected, missingCode,
      Proof.State.goalCount(introduced),
    ];
  `);
  assertEquals(session.get(0, "observed"), [
    true, 86,
    true, 82,
    1,
  ]);
});

Deno.test("native change and reduce retarget goals under kernel conversion", () => {
  const session = run(`
    let env = Proof.Core.Natural.environment();
    let natural = Proof.Term.inductive(env, 0);
    let split = Proof.State.cases(
      Proof.State.introduce(
        Proof.State.begin(env, Proof.Term.product(natural, natural)), 0),
      0, 0);
    let reduced = Proof.State.reduce(split, 0);
    let changed = Proof.State.change(reduced, 0, natural);
    let inconvertibleRejected = false;
    let inconvertibleCode = 0;
    try {
      Proof.State.change(reduced, 0, Proof.Term.type(0));
    } catch (error) {
      inconvertibleRejected = true;
      inconvertibleCode = Proof.errorCode();
    }
    let closed = Proof.State.exact(
      Proof.State.introduce(
        Proof.State.constructor(changed, 0, 0), 0),
      0, Proof.Term.bound(0));
    let proofTerm = Proof.State.seal(closed);
    let observed = [
      inconvertibleRejected, inconvertibleCode,
      Proof.Term.tag(
        Proof.Term.check(proofTerm, Proof.Term.product(natural, natural))),
    ];
  `);
  assertEquals(session.get(0, "observed"), [
    true, 88,
    7,
  ]);
});

Deno.test("native reflexivity closes equality goals and rejects other families", () => {
  const session = run(`
    let env = Proof.Core.environment();
    let natural = Proof.Term.inductive(env, 0);
    let equality = Proof.Term.inductive(env, 2, 1);
    let zero = Proof.Term.constructor(env, 0, 0);
    let proposition = Proof.Term.apply(
      Proof.Term.apply(
        Proof.Term.apply(equality, natural),
        zero),
      zero);
    let state = Proof.State.begin(env, proposition);
    let closed = Proof.State.reflexivity(state, 0);
    let proofTerm = Proof.State.seal(closed);
    let theorem = Proof.theorem(proposition, proofTerm);
    let nonEquality = Proof.State.begin(env, natural);
    let rejected = false;
    let errorCode = 0;
    try {
      Proof.State.reflexivity(nonEquality, 0);
    } catch (error) {
      rejected = true;
      errorCode = Proof.errorCode();
    }
    let observed = [
      Proof.State.goalCount(closed),
      Proof.checkArtifact(Proof.Theorem.artifact(theorem)),
      rejected,
      errorCode,
      Proof.State.goalCount(nonEquality),
    ];
  `);
  assertEquals(session.get(0, "observed"), [
    0,
    true,
    true,
    89,
    1,
  ]);
});

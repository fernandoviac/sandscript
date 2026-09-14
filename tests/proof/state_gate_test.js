import { assertEquals } from "https://deno.land/std@0.208.0/assert/mod.ts";
import {
  freshSession,
  restoreSession,
  snapshotSession,
} from "../../src/host-owned-session.js";
import { parseAndSetup } from "../fuel/test-helpers.js";
import { additionFixture, equalityFixture, naturalFixture, runState, tacticHelpers, termHelpers } from "./state-helpers.js";

function execute(session, source) {
  parseAndSetup(session, source);
  assertEquals(runState(session).status, "done");
  return session;
}

function run(source) {
  return execute(freshSession({ heapSize: 64 * 1024 * 1024 }),
    tacticHelpers + termHelpers + source);
}

const arithmeticProofs = `
  // All variables are universally quantified. No theorem declaration from a
  // prebuilt arithmetic module is used as evidence.
  nat = Proof.Term.inductiveReference(0);
  eq = Proof.Term.inductiveReference(eqIndex);
  function inductionProof(statement, introductions, hypothesis, step) {
    let state = introduceMany(Proof.State.begin(env, statement), 0, introductions);
    state = Proof.State.induction(state, 0, hypothesis);
    state = constructorBranches(state, 0, [
      function(s, g) { return Proof.State.reflexivity(s, g); },
      function(s, g) {
        return step(Proof.State.reduce(Proof.State.introduce(s, g), g), g);
      }
    ]);
    return checked(state, statement);
  }
  let addZeroLeftType = pi([nat], equal(nat, plus(zero, b(0)), b(0)));
  let addZeroLeft = checked(Proof.State.reflexivity(
    Proof.State.introduce(Proof.State.begin(env, addZeroLeftType), 0), 0), addZeroLeftType);
  let addZeroRightType = pi([nat], equal(nat, plus(b(0), zero), b(0)));
  let addZeroRight = inductionProof(addZeroRightType, 1, 0, function(s, g) {
    return Proof.State.assumption(Proof.State.congruence(s, g), g);
  });
  let addAssocType = pi([nat, nat, nat], equal(nat,
    plus(plus(b(2), b(1)), b(0)), plus(b(2), plus(b(1), b(0)))));
  let addAssoc = inductionProof(addAssocType, 3, 2, function(s, g) {
    return Proof.State.assumption(Proof.State.congruence(s, g), g);
  });
  let mulZeroLeftType = pi([nat], equal(nat, times(zero, b(0)), zero));
  let mulZeroLeft = checked(Proof.State.reflexivity(
    Proof.State.introduce(Proof.State.begin(env, mulZeroLeftType), 0), 0), mulZeroLeftType);
  let mulZeroRightType = pi([nat], equal(nat, times(b(0), zero), zero));
  let mulZeroRight = inductionProof(mulZeroRightType, 1, 0, function(s, g) {
    return Proof.State.assumption(s, g);
  });
  let one = app(succ, [zero]);
  let mulOneRightType = pi([nat], equal(nat, times(b(0), one), b(0)));
  let mulOneRight = inductionProof(mulOneRightType, 1, 0, function(s, g) {
    return Proof.State.assumption(Proof.State.congruence(s, g), g);
  });
  let mulOneLeftType = pi([nat], equal(nat, times(one, b(0)), b(0)));
  let mulOneLeft = checked(Proof.State.apply(Proof.State.reduce(
    Proof.State.introduce(Proof.State.begin(env, mulOneLeftType), 0), 0),
    0, app(addZeroRight, [b(0)])), mulOneLeftType);
  // (a + b) * c = a * c + b * c, with an actual induction and a rewrite by IH.
  let distributionType = pi([nat, nat, nat], equal(nat,
    times(plus(b(2), b(1)), b(0)), plus(times(b(2), b(0)), times(b(1), b(0)))));
  let distribution = inductionProof(distributionType, 3, 2, function(s, g) {
    // Expose one recursive equation, preserving the global-headed IH rather
    // than fully unfolding the recursive calls under symbolic arguments.
    s = Proof.State.change(s, g, equal(nat,
      plus(b(3), times(plus(b(1), b(4)), b(3))),
      plus(plus(b(3), times(b(1), b(3))), times(b(4), b(3)))));
    s = Proof.State.rewrite(s, g, 0);
    return Proof.State.apply(Proof.State.symmetry(s, g), g,
      app(addAssoc, [b(3), times(b(1), b(3)), times(b(4), b(3))]));
  });
  let observed = [
    Proof.Term.isTerm(addZeroLeft), Proof.Term.isTerm(addZeroRight),
    Proof.Term.isTerm(addAssoc), Proof.Term.isTerm(mulZeroLeft),
    Proof.Term.isTerm(mulZeroRight), Proof.Term.isTerm(mulOneLeft),
    Proof.Term.isTerm(mulOneRight), Proof.Term.isTerm(distribution),
    Proof.assumptionCount(env)
  ];
`;

Deno.test("state gate: natural addition and multiplication laws are tactic proofs", () => {
  const session = run(naturalFixture + arithmeticProofs);
  assertEquals(session.get(0, "observed"), [true, true, true, true, true, true, true, true, 0]);
});

Deno.test("state gate: polymorphic list append associativity by induction and congruence", () => {
  const session = run(equalityFixture + `
    // Declare only the data and append, not the prebuilt associativity proof.
    let listIndex = Proof.declarationCount(env);
    let listRef = Proof.Term.inductiveReference(listIndex);
    env = Proof.inductive(env, pi([type], type), Proof.Term.sequence([
      pi([type], app(listRef, [b(0)])),
      pi([type, b(0), app(listRef, [b(1)])], app(listRef, [b(2)]))
    ]), 1);
    let list = Proof.Term.inductive(env, listIndex);
    let cons = Proof.Term.constructor(env, listIndex, 1);
    let appendType = pi([type, app(list, [b(0)]), app(list, [b(1)])], app(list, [b(2)]));
    let appendBody = lam([type, app(list, [b(0)]), app(list, [b(1)])],
      Proof.Term.match(b(1), lam([app(list, [b(2)])], app(list, [b(3)])),
        Proof.Term.sequence([
          Proof.Term.branch(0, b(0)),
          Proof.Term.branch(1, lam([b(2), app(list, [b(3)])],
            app(cons, [b(4), b(1), app(Proof.Term.recursiveReference(0), [b(4), b(0), b(2)])])))
        ])));
    let appendIndex = Proof.declarationCount(env);
    env = Proof.definition(appendType, recursive(appendType, appendBody, 1));
    list = Proof.Term.inductive(env, listIndex);
    eq = Proof.Term.inductive(env, eqIndex);
    let append = Proof.Term.global(env, appendIndex);
    let statement = pi([type, app(list, [b(0)]), app(list, [b(1)]), app(list, [b(2)])],
      app(eq, [app(list, [b(3)]),
        app(append, [b(3), app(append, [b(3), b(2), b(1)]), b(0)]),
        app(append, [b(3), b(2), app(append, [b(3), b(1), b(0)])])
      ]));
    let state = Proof.State.induction(introduceMany(Proof.State.begin(env, statement), 0, 4), 0, 2);
    state = constructorBranches(state, 0, [
      function(s, g) { return Proof.State.reflexivity(s, g); },
      function(s, g) {
        s = Proof.State.introduce(s, g);
        s = Proof.State.congruence(Proof.State.reduce(s, g), g);
        return Proof.State.assumption(s, g);
      }
    ]);
    let proof = checked(state, statement);
    let observed = [Proof.State.goalCount(state), Proof.Term.isTerm(proof), Proof.assumptionCount(env)];
  `);
  assertEquals(session.get(0, "observed"), [0, true, 0]);
});

const transportPrefix = equalityFixture + `
  // forall (A : Type) (P : A -> Prop) (x y : A), x = y -> P x -> P y.
  let statement = pi([type, pi([b(0)], Proof.Term.proposition()), b(1), b(2),
    equal(b(3), b(1), b(0)), app(b(3), [b(2)])], app(b(4), [b(2)]));
  let state = introduceMany(Proof.State.begin(env, statement), 0, 6);
  let before = Proof.artifact(state);
`;
const transportFinish = `
  let resumed = Proof.artifact(state);
  let closed = Proof.State.assumption(Proof.State.rewrite(state, 0, 1, true), 0);
  let proof = checked(closed, statement);
  let after = Proof.artifact(state);
  let observed = [Proof.State.goalCount(state), Proof.State.goalCount(closed), Proof.Term.render(proof)];
  let theoremBytes = Proof.Theorem.artifact(Proof.theorem(statement, proof));
`;

Deno.test("state gate: generic equality transport preserves a real mid-proof state across GC and restoration", () => {
  const direct = run(transportPrefix);
  const interrupted = run(transportPrefix);
  const before = interrupted.get(0, "before");
  interrupted.gc();
  const snapshot = snapshotSession(interrupted);
  const restored = restoreSession(snapshot.vatBytes, snapshot.membraneBytes);
  execute(direct, transportFinish);
  execute(restored, transportFinish);
  assertEquals(restored.get(0, "resumed"), before);
  assertEquals(restored.get(0, "after"), before);
  assertEquals(restored.get(0, "observed"), direct.get(0, "observed"));
  assertEquals(restored.get(0, "theoremBytes"), direct.get(0, "theoremBytes"));
  assertEquals(restored.get(0, "observed").slice(0, 2), [1, 0]);
});

Deno.test("state gate: length-indexed vector append has additive length", () => {
  const session = run(additionFixture + `
    // Environment-free references avoid copying the entire declaration graph
    // into every repeated binder domain. Constructors/globals carry the graph.
    nat = Proof.Term.inductiveReference(0);
    let vectorIndex = Proof.declarationCount(env);
    let vectorRef = Proof.Term.inductiveReference(vectorIndex);
    env = Proof.inductive(env, pi([type, nat], type), Proof.Term.sequence([
      pi([type], app(vectorRef, [b(0), zero])),
      pi([type, nat, b(1), app(vectorRef, [b(2), b(1)])],
        app(vectorRef, [b(3), app(succ, [b(2)])]))
    ]), 1);
    let vector = vectorRef;
    let cons = Proof.Term.constructor(env, vectorIndex, 1);
    add = Proof.Term.global(env, addIndex);
    // append : forall A n, Vec A n -> forall m, Vec A m -> Vec A (n+m).
    let appendType = pi([type, nat, app(vector, [b(1), b(0)]), nat,
      app(vector, [b(3), b(0)])], app(vector, [b(4), plus(b(3), b(1))]));
    let recurse = app(Proof.Term.recursiveReference(0), [b(7), b(2), b(0), b(4), b(3)]);
    let appendBody = lam([type, nat, app(vector, [b(1), b(0)]), nat,
      app(vector, [b(3), b(0)])],
      Proof.Term.match(b(2),
        lam([nat, app(vector, [b(5), b(0)])],
          app(vector, [b(6), plus(b(1), b(3))])),
        Proof.Term.sequence([
          Proof.Term.branch(0, b(0)),
          Proof.Term.branch(1,
            lam([nat, b(5), app(vector, [b(6), b(1)])],
              app(cons, [b(7), plus(b(2), b(4)), b(1), recurse])))
        ])));
    let appendIndex = Proof.declarationCount(env);
    env = Proof.definition(appendType, recursive(appendType, appendBody, 2));
    let append = Proof.Term.global(env, appendIndex);
    // Vector length projects its index, unlike List length which traverses
    // constructors. Checking append above enforces the index on both branches.
    let lengthType = pi([type, nat, app(vector, [b(1), b(0)])],
      Proof.Term.inductive(env, 0));
    let lengthIndex = Proof.declarationCount(env);
    env = Proof.definition(lengthType,
      lam([type, nat, app(vector, [b(1), b(0)])], b(1)));
    let length = Proof.Term.global(env, lengthIndex);
    eq = Proof.Term.inductiveReference(eqIndex);
    add = Proof.Term.global(env, addIndex);
    append = Proof.Term.global(env, appendIndex);
    let statement = pi([type, nat, app(vector, [b(1), b(0)]), nat,
      app(vector, [b(3), b(0)])], equal(nat,
        app(length, [b(4), plus(b(3), b(1)), app(append, [b(4), b(3), b(2), b(1), b(0)])]),
        plus(app(length, [b(4), b(3), b(2)]), app(length, [b(4), b(1), b(0)]))));
    let state = introduceMany(Proof.State.begin(env, statement), 0, 5);
    state = Proof.State.reflexivity(Proof.State.reduce(state, 0), 0);
    let proof = checked(state, statement);
    let observed = [Proof.State.goalCount(state), Proof.Term.isTerm(proof), Proof.assumptionCount(env)];
  `);
  assertEquals(session.get(0, "observed"), [0, true, 0]);
});

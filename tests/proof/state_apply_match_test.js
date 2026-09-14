import { assertEquals } from "https://deno.land/std@0.208.0/assert/mod.ts";
import { freshSession } from "../../src/host-owned-session.js";
import { parseAndSetup } from "../fuel/test-helpers.js";
import { runState } from "./state-helpers.js";

Deno.test("native apply reduces an equality motive before matching its target", () => {
  const session = freshSession({ heapSize: 64 * 1024 * 1024 });
  parseAndSetup(session, `
    let env = Proof.Core.environment();
    let natural = Proof.Term.inductive(env, 0);
    let equality = Proof.Term.inductive(env, 2, 1);
    let reflexivity = Proof.Term.constructor(env, 2, 0, 1);
    let bound = (index) => Proof.Term.bound(index);
    let eq = (left, right) => Proof.Term.apply(
      Proof.Term.apply(Proof.Term.apply(equality, natural), left), right);
    let proposition = Proof.Term.product(natural,
      Proof.Term.product(natural,
        Proof.Term.product(eq(bound(1), bound(0)), eq(bound(1), bound(2)))));
    let state = Proof.State.begin(env, proposition);
    state = Proof.State.introduce(state, 0);
    state = Proof.State.introduce(state, 0);
    state = Proof.State.introduce(state, 0);
    let motive = Proof.Term.lambda(natural,
      Proof.Term.lambda(eq(bound(3), bound(0)), eq(bound(1), bound(4))));
    let branch = Proof.Term.branch(0,
      Proof.Term.apply(Proof.Term.apply(reflexivity, natural), bound(2)));
    let eliminator = Proof.Term.match(bound(0), motive, Proof.Term.sequence([branch]));
    let closed = Proof.State.apply(state, 0, eliminator);
    let theorem = Proof.theorem(proposition, Proof.State.seal(closed));
    let observed = [
      Proof.State.goalCount(state),
      Proof.State.goalCount(closed),
      Proof.checkArtifact(Proof.Theorem.artifact(theorem)),
    ];
  `);
  assertEquals(runState(session, 10_000_000).status, "done");
  assertEquals(session.get(0, "observed"), [1, 0, true]);
});

Deno.test("native state artifact inspection cannot mutate or certify an open proof", () => {
  const session = freshSession();
  parseAndSetup(session, `
    let env = Proof.Core.Natural.environment();
    let natural = Proof.Term.inductive(env, 0);
    let state = Proof.State.begin(env, natural);
    let bytes = Proof.artifact(state);
    let accepted = Proof.checkArtifact(bytes);
    let theoremRejected = false;
    try { Proof.Theorem.artifact(state); } catch (error) { theoremRejected = true; }
    let first = bytes[0];
    bytes[0] = first ^ 255;
    let copy = Proof.artifact(state);
    let observed = [
      accepted, theoremRejected, copy[0] === first, Proof.State.goalCount(state),
    ];
  `);
  assertEquals(runState(session, 10_000_000).status, "done");
  assertEquals(session.get(0, "observed"), [false, true, true, 1]);
});

Deno.test("native apply rejects a lambda whose body cannot be inferred", () => {
  const session = freshSession();
  parseAndSetup(session, `
    let env = Proof.Core.Natural.environment();
    let natural = Proof.Term.inductive(env, 0);
    let state = Proof.State.begin(env, natural);
    let rejected = false;
    let code = 0;
    try {
      Proof.State.apply(state, 0, Proof.Term.lambda(natural, Proof.Term.bound(99)));
    } catch (error) {
      rejected = true;
      code = Proof.errorCode();
    }
    let observed = [rejected, code, Proof.State.goalCount(state)];
  `);
  assertEquals(runState(session, 10_000_000).status, "done");
  assertEquals(session.get(0, "observed"), [true, 31, 1]);
});

Deno.test("native elimination still rejects proof-relevant propositions into Type", () => {
  const session = freshSession();
  parseAndSetup(session, `
    let env = Proof.Core.Natural.environment();
    let propositionIndex = Proof.declarationCount(env);
    let proposition = Proof.Term.inductiveReference(propositionIndex);
    env = Proof.inductive(env, Proof.Term.proposition(),
      Proof.Term.sequence([proposition, proposition]), 0);
    let natural = Proof.Term.inductive(env, 0);
    let source = Proof.Term.inductive(env, propositionIndex);
    let zero = Proof.Term.constructor(env, 0, 0);
    let branches = Proof.Term.sequence([
      Proof.Term.branch(0, zero), Proof.Term.branch(1, zero),
    ]);
    let proof = Proof.Term.lambda(source, Proof.Term.match(
      Proof.Term.bound(0), Proof.Term.lambda(source, natural), branches));
    let state = Proof.State.begin(env, Proof.Term.product(source, natural));
    let rejected = false;
    let code = 0;
    try { Proof.State.exact(state, 0, proof); } catch (error) {
      rejected = true;
      code = Proof.errorCode();
    }
    let observed = [rejected, code, Proof.State.goalCount(state)];
  `);
  assertEquals(runState(session, 10_000_000).status, "done");
  assertEquals(session.get(0, "observed"), [true, 61, 1]);
});

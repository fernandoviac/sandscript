import { assertEquals } from "https://deno.land/std@0.208.0/assert/mod.ts";
import { freshSession } from "../../src/host-owned-session.js";
import { parseAndSetup } from "../fuel/test-helpers.js";
import { equalityFixture, runState, tacticHelpers, termHelpers } from "./state-helpers.js";

Deno.test("native induction preserves an inductive carrier's contextual type parameter", () => {
  const session = freshSession({ heapSize: 32 * 1024 * 1024 });
  parseAndSetup(session, tacticHelpers + termHelpers + equalityFixture + `
    let listIndex = Proof.declarationCount(env);
    let listRef = Proof.Term.inductiveReference(listIndex);
    env = Proof.inductive(env, pi([type], type), Proof.Term.sequence([
      pi([type], app(listRef, [b(0)])),
      pi([type, b(0), app(listRef, [b(1)])], app(listRef, [b(2)]))
    ]), 1);
    let list = Proof.Term.inductive(env, listIndex);
    let statement = pi([type, app(list, [b(0)])],
      equal(app(list, [b(1)]), b(0), b(0)));
    let state = introduceMany(Proof.State.begin(env, statement), 0, 2);
    state = Proof.State.induction(state, 0, 0);
    state = Proof.State.reflexivity(state, 0);
    state = Proof.State.reflexivity(Proof.State.introduce(state, 0), 0);
    let term = Proof.State.seal(state);
    let theorem = Proof.theorem(statement, term);
    let observed = [Proof.State.goalCount(state),
      Proof.checkArtifact(Proof.Theorem.artifact(theorem))];
  `);
  assertEquals(runState(session).status, "done");
  assertEquals(session.get(0, "observed"), [0, true]);
});

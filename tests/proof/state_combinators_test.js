import { assertEquals } from "https://deno.land/std@0.208.0/assert/mod.ts";
import { freshSession } from "../../src/host-owned-session.js";
import { parseAndSetup } from "../fuel/test-helpers.js";
import { equalityFixture, runState, tacticHelpers, termHelpers } from "./state-helpers.js";

function run(source) {
  const session = freshSession({ heapSize: 64 * 1024 * 1024 });
  parseAndSetup(session, tacticHelpers + termHelpers + equalityFixture + source);
  assertEquals(runState(session).status, "done");
  return session;
}

Deno.test("state combinators: sequence, optional and first success preserve immutable backtracking", () => {
  const session = run(`
    let equation = equal(nat, zero, zero);
    let statement = pi([equation], equation);
    let original = Proof.State.begin(env, statement);
    let before = Proof.artifact(original);
    function failAfterProgress(s, g) {
      s = Proof.State.introduce(s, g);
      return Proof.State.exact(s, g, Proof.Term.proposition());
    }
    let attempted = optional(original, 0, failAfterProgress);
    let attempts = [];
    let closed = firstSuccess(attempted, 0, [
      function(s, g) { attempts.push(0); return failAfterProgress(s, g); },
      function(s, g) {
        attempts.push(1);
        return sequence(s, g, [Proof.State.introduce, Proof.State.assumption]);
      },
      function(s, g) { attempts.push(2); throw new TypeError("must not run"); }
    ]);
    checked(closed, statement);
    let after = Proof.artifact(original);
    let attemptedBytes = Proof.artifact(attempted);
    let allFailed = false;
    try { firstSuccess(original, 0, [failAfterProgress, failAfterProgress]); }
    catch (error) { allFailed = true; }
    let emptyFailed = false;
    try { firstSuccess(original, 0, []); } catch (error) { emptyFailed = true; }
    let observed = [attempts, Proof.State.goalCount(original), Proof.State.goalCount(closed), allFailed, emptyFailed];
  `);
  assertEquals(session.get(0, "observed"), [[0, 1], 1, 0, true, true]);
  assertEquals(session.get(0, "after"), session.get(0, "before"));
  assertEquals(session.get(0, "attemptedBytes"), session.get(0, "before"));
});

Deno.test("state combinators: all goals visits original goals once even when tactics split or close them", () => {
  const session = run(`
    let statement = equal(nat, zero, zero);
    let initial = Proof.State.transitivity(Proof.State.begin(env, statement), 0, zero);
    let visits = [];
    let split = allGoals(initial, function(s, g) {
      visits.push(g);
      return Proof.State.transitivity(s, g, zero);
    });
    let splitCount = Proof.State.goalCount(split);
    let closed = allGoals(split, Proof.State.reflexivity);
    checked(closed, statement);
    let observed = [visits, splitCount, Proof.State.goalCount(closed), Proof.State.goalCount(initial)];
  `);
  assertEquals(session.get(0, "observed"), [[1, 0], 4, 0, 2]);
});

Deno.test("state combinators: bounded repetition stops at the bound, failure and a closed goal", () => {
  const session = run(`
    let equation = equal(nat, zero, zero);
    let statement = pi([equation, equation], equation);
    let state = Proof.State.begin(env, statement);
    let calls = 0;
    let same = boundedRepeat(state, 0, function(s, g) { calls = calls + 1; return s; }, 3);
    let noCalls = boundedRepeat(same, 0, function(s, g) { calls = calls + 100; return s; }, 0);
    let introduced = boundedRepeat(noCalls, 0, Proof.State.introduce, 8);
    let closed = boundedRepeat(introduced, 0, Proof.State.assumption, 8);
    checked(closed, statement);
    let observed = [calls, Proof.State.goalCount(state), Proof.State.goalCount(closed)];
  `);
  assertEquals(session.get(0, "observed"), [3, 1, 0]);
});

Deno.test("state combinators: focus and constructor branches tolerate goal renumbering", () => {
  const session = run(`
    let equation = equal(nat, zero, zero);
    let split = Proof.State.transitivity(Proof.State.begin(env, equation), 0, zero);
    let focused = focus(split, 1, Proof.State.reflexivity);
    let remaining = Proof.State.goalCount(focused);
    checked(Proof.State.reflexivity(focused, 0), equation);
    let statement = pi([nat], equal(nat, b(0), b(0)));
    let cases = Proof.State.cases(Proof.State.introduce(Proof.State.begin(env, statement), 0), 0, 0);
    let order = [];
    let closed = constructorBranches(cases, 0, [
      function(s, g) { order.push(0); return Proof.State.constructor(s, g, 0); },
      function(s, g) {
        order.push(1);
        return sequence(s, g, [Proof.State.introduce, Proof.State.reflexivity]);
      }
    ]);
    checked(closed, statement);
    let observed = [remaining, order, Proof.State.goalCount(closed), Proof.State.goalCount(cases)];
  `);
  assertEquals(session.get(0, "observed"), [1, [1, 0], 0, 2]);
});

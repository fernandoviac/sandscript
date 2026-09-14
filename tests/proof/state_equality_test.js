import { assertEquals } from "https://deno.land/std@0.208.0/assert/mod.ts";
import { freshSession } from "../../src/host-owned-session.js";
import { parseAndSetup } from "../fuel/test-helpers.js";
import { runState } from "./state-helpers.js";

// Equality follows two custom families and their recursors, away from Core Eq.
const setup = `
  let T = Proof.Term;
  let S = Proof.State;
  function ap(f, x) { return T.apply(f, x); }
  function b(i) { return T.bound(i); }
  function pi(A, B) { return T.product(A, B); }
  let env = Proof.Core.Natural.environment();
  env = Proof.inductive(env, T.proposition(), T.sequence([]), 0);
  let unitIndex = Proof.declarationCount(env);
  env = Proof.inductive(env, T.proposition(),
    T.sequence([T.inductiveReference(unitIndex)]), 0);
  let eqIndex = Proof.declarationCount(env);
  let eqRef = T.inductiveReference(eqIndex);
  let eqArity = pi(T.type(0), pi(b(0), pi(b(1), T.proposition())));
  let reflType = pi(T.type(0), pi(b(0), ap(ap(ap(eqRef, b(1)), b(0)), b(0))));
  env = Proof.inductive(env, eqArity, T.sequence([reflType]), 1);
  let N = T.inductive(env, 0);
  let zero = T.constructor(env, 0, 0);
  let succ = T.constructor(env, 0, 1);
  let E = T.inductive(env, eqIndex);
  function eq(A, x, y) { return ap(ap(ap(E, A), x), y); }
  function intro(s, n) {
    for (let i = 0; i < n; i = i + 1) s = S.introduce(s, 0);
    return s;
  }
  function checked(s, target) {
    let term = S.seal(s);
    return Proof.checkArtifact(Proof.Theorem.artifact(Proof.theorem(target, term)));
  }
  function unchanged(s, f) {
    let bytes = Proof.artifact(s);
    let target = T.render(S.goalTarget(s, 0));
    let count = S.goalCount(s);
    let actual = -1;
    try { f(s); } catch (error) { actual = Proof.errorCode(); }
    let after = Proof.artifact(s);
    let same = bytes.length === after.length;
    for (let i = 0; i < bytes.length; i = i + 1) {
      if (bytes[i] !== after[i]) same = false;
    }
    return [actual, same && count === S.goalCount(s) &&
      target === T.render(S.goalTarget(s, 0))];
  }
`;

function run(source) {
  const session = freshSession({ heapSize: 32 * 1024 * 1024 });
  parseAndSetup(session, setup + source);
  assertEquals(runState(session).status, "done");
  return session.get(0, "observed");
}

Deno.test("native equality symmetry and transitivity preserve contextual endpoints", () => {
  assertEquals(run(`
    let symmetric = pi(N, pi(N, pi(eq(N, b(1), b(0)), eq(N, b(1), b(2)))));
    let state = intro(S.begin(env, symmetric), 3);
    let reversed = S.symmetry(state, 0);
    let symmetryOpen = S.goalCount(reversed);
    reversed = S.assumption(reversed, 0);
    let transitive = pi(N, pi(N, pi(N,
      pi(eq(N, b(2), b(1)), pi(eq(N, b(2), b(1)), eq(N, b(4), b(2)))))));
    let chain = intro(S.begin(env, transitive), 5);
    chain = S.transitivity(chain, 0, b(3));
    let transitivityOpen = S.goalCount(chain);
    chain = S.assumption(chain, 0);
    chain = S.assumption(chain, 0);
    let bad = S.begin(env, N);
    let observed = [symmetryOpen, transitivityOpen,
      checked(reversed, symmetric), checked(chain, transitive),
      unchanged(bad, function(s) { S.symmetry(s, 0); }),
      unchanged(bad, function(s) { S.transitivity(s, 0, zero); }),
      S.goalCount(state)];
  `), [1, 2, true, true, [89, true], [89, true], 1]);
});

Deno.test("native equality rewrite and substitute abstract occurrences below binders", () => {
  assertEquals(run(`
    // Equality transport through an arbitrary dependent predicate, and through
    // a product whose body mentions the rewritten variable beneath a binder.
    let target = pi(N, pi(N, pi(pi(N, T.proposition()),
      pi(eq(N, b(2), b(1)), pi(ap(b(1), b(2)), ap(b(2), b(4)))))));
    let state = intro(S.begin(env, target), 5);
    let rewritten = S.rewrite(state, 0, 1);
    rewritten = S.assumption(rewritten, 0);
    let substituted = S.substitute(state, 0, 1);
    substituted = S.assumption(substituted, 0);
    let backwardTarget = pi(N, pi(N, pi(pi(N, T.proposition()),
      pi(eq(N, b(2), b(1)), pi(ap(b(1), b(3)), ap(b(2), b(3)))))));
    let backward = intro(S.begin(env, backwardTarget), 5);
    backward = S.rewrite(backward, 0, 1, true);
    backward = S.assumption(backward, 0);
    let nestedTarget = pi(N, pi(N, pi(eq(N, b(1), b(0)),
      pi(N, eq(N, b(3), b(2))))));
    let nested = intro(S.begin(env, nestedTarget), 3);
    nested = S.rewrite(nested, 0, 0);
    nested = S.introduce(nested, 0);
    nested = S.reflexivity(nested, 0);
    let absentTarget = pi(N, pi(N, pi(eq(N, b(1), b(0)), eq(N, zero, zero))));
    let absent = intro(S.begin(env, absentTarget), 3);
    let notEq = intro(S.begin(env, pi(N, N)), 1);
    let observed = [checked(rewritten, target), checked(substituted, target),
      checked(backward, backwardTarget), checked(nested, nestedTarget),
      unchanged(absent, function(s) { S.rewrite(s, 0, 0); }),
      unchanged(notEq, function(s) { S.substitute(s, 0, 0); })];
  `), [true, true, true, true, [91, true], [90, true]]);
});

Deno.test("native congruence opens one equality per nonconvertible argument", () => {
  assertEquals(run(`
    let functionType = pi(N, pi(N, N));
    let target = pi(functionType, pi(N, pi(N, pi(N, pi(N,
      pi(eq(N, b(3), b(2)), pi(eq(N, b(2), b(1)),
        eq(N, ap(ap(b(6), b(5)), b(3)), ap(ap(b(6), b(4)), b(2))))))))));
    let state = intro(S.begin(env, target), 7);
    state = S.congruence(state, 0);
    let count = S.goalCount(state);
    state = S.assumption(state, 0);
    state = S.assumption(state, 0);
    let bad = S.begin(env, eq(N, zero, ap(succ, zero)));
    let observed = [count, checked(state, target),
      unchanged(bad, function(s) { S.congruence(s, 0); })];
  `), [2, true, [94, true]]);
});

Deno.test("native discriminate derives arbitrary goals from distinct constructors", () => {
  assertEquals(run(`
    let target = pi(eq(N, zero, ap(succ, zero)), N);
    let state = intro(S.begin(env, target), 1);
    state = S.discriminate(state, 0, 0);
    let bad = intro(S.begin(env, pi(eq(N, zero, zero), N)), 1);
    // The arbitrary target is computational, so validate a definition rather
    // than passing its Type-valued statement to the Prop-only theorem API.
    let observed = [S.goalCount(state),
      Proof.checkArtifact(Proof.artifact(Proof.definition(target, S.seal(state)))),
      unchanged(bad, function(s) { S.discriminate(s, 0, 0); })];
  `), [0, true, [92, true]]);
});

Deno.test("native inject exposes constructor-field equations in the continuation", () => {
  assertEquals(run(`
    let target = pi(N, pi(N, pi(eq(N, ap(succ, b(1)), ap(succ, b(0))),
      eq(N, b(2), b(1)))));
    let state = intro(S.begin(env, target), 3);
    state = S.inject(state, 0, 0);
    let count = S.goalCount(state);
    state = S.introduce(state, 0);
    state = S.assumption(state, 0);
    let bad = intro(S.begin(env, pi(eq(N, zero, ap(succ, zero)), N)), 1);
    let observed = [count, checked(state, target),
      unchanged(bad, function(s) { S.inject(s, 0, 0); })];
  `), [1, true, [93, true]]);
});

Deno.test("native equality rejects dependent-field injection without changing the state", () => {
  assertEquals(run(`
    let dependentIndex = Proof.declarationCount(env);
    let dependentRef = T.inductiveReference(dependentIndex);
    let constructorType = pi(N, pi(eq(N, b(0), b(0)), dependentRef));
    env = Proof.inductive(env, T.type(0), T.sequence([constructorType]), 0);
    N = T.inductive(env, 0);
    E = T.inductive(env, eqIndex);
    let D = T.inductive(env, dependentIndex);
    let C = T.constructor(env, dependentIndex, 0);
    let R = T.constructor(env, eqIndex, 0);
    function value(x) { return ap(ap(C, x), ap(ap(R, N), x)); }
    let equality = eq(D, value(b(1)), value(b(0)));
    let target = pi(N, pi(N, pi(equality, N)));
    let state = intro(S.begin(env, target), 3);
    let congruenceTarget = pi(N, pi(N, equality));
    let congruenceState = intro(S.begin(env, congruenceTarget), 2);
    let observed = [
      unchanged(state, function(s) { S.inject(s, 0, 0); }),
      unchanged(congruenceState, function(s) { S.congruence(s, 0); })
    ];
  `), [[93, true], [94, true]]);
});

Deno.test("native reflexivity checks conversion beneath equality applications", () => {
  assertEquals(run(`
    let identity = T.lambda(N, b(0));
    let target = pi(N, eq(N, ap(identity, b(0)), b(0)));
    let state = intro(S.begin(env, target), 1);
    let closed = S.reflexivity(state, 0);
    let observed = [S.goalCount(closed), checked(closed, target), S.goalCount(state)];
  `), [0, true, 1]);
});

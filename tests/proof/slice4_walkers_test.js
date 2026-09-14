import { assertEquals } from "https://deno.land/std@0.208.0/assert/mod.ts";
import { freshSession } from "../../src/host-owned-session.js";
import { parseAndSetup } from "../fuel/test-helpers.js";
import { runState } from "./state-helpers.js";

const setup = `
  let T = Proof.Term;
  let S = Proof.State;
  let env = Proof.Core.environment();
  let natIndex = Proof.declarationIndex(env, Proof.Name.str(0, "Nat"));
  let eqIndex = Proof.declarationIndex(env, Proof.Name.str(0, "Eq"));
  let N = T.inductive(env, natIndex);
  let E = T.inductive(env, eqIndex, 1);
  function b(i) { return T.bound(i); }
  function ap(f, x) { return T.apply(f, x); }
  function pi(A, B) { return T.product(A, B); }
  function lam(A, body) { return T.lambda(A, body); }
  function eq(A, x, y) { return ap(ap(ap(E, A), x), y); }
  function checked(target, state) {
    return Proof.checkArtifact(Proof.Theorem.artifact(
      Proof.theorem(target, S.seal(state))));
  }
  function rejected(f) {
    try { f(); } catch (error) { return true; }
    return false;
  }
  function sameBytes(left, right) {
    if (left.length !== right.length) return false;
    for (let i = 0; i < left.length; i = i + 1) {
      if (left[i] !== right[i]) return false;
    }
    return true;
  }
  let boxIndex = Proof.declarationCount(env);
  env = Proof.inductive(env, T.type(0),
    T.sequence([pi(N, T.inductiveReference(boxIndex))]), 0);
  N = T.inductive(env, natIndex);
  E = T.inductive(env, eqIndex, 1);
  let Box = T.inductive(env, boxIndex);
  let mkBox = T.constructor(env, boxIndex, 0);
  function proj(x) { return T.projection(env, boxIndex, 0, x); }
  function nat(n) { return T.naturalLiteral(env, n); }
`;

function run(source) {
  const session = freshSession({ heapSize: 32 * 1024 * 1024 });
  parseAndSetup(session, setup + source);
  let result;
  do {
    result = runState(session, 10_000_000);
  } while (result.status === "paused");
  assertEquals(result.status, "done");
  return session.get(0, "observed");
}

Deno.test("Slice 4 projection substitution preserves enclosing and inner binders", () => {
  assertEquals(run(`
    let source = proj(T.named("record"));
    let before = T.render(source);
    let fn = T.namedLambda("record", Box, lam(N, source));
    let statement = eq(N, ap(ap(fn, ap(mkBox, nat(37))), nat(9)), nat(37));
    let state = S.reflexivity(S.begin(env, statement), 0);
    let observed = [checked(statement, state),
      before === T.render(source),
      Proof.checkArtifact(Proof.artifact(Proof.definition(pi(Box, pi(N, N)), fn)))];
  `), [true, true, true]);
});

Deno.test("Slice 4 equality rewriting visits projection structure below a product", () => {
  assertEquals(run(`
    let target = pi(Box, pi(Box, pi(eq(Box, b(1), b(0)),
      pi(N, eq(N, proj(b(3)), proj(b(2)))))));
    let state = S.begin(env, target);
    state = S.introduce(state, 0);
    state = S.introduce(state, 0);
    state = S.introduce(state, 0);
    let before = Proof.artifact(state);
    let next = S.rewrite(state, 0, 0);
    next = S.introduce(next, 0);
    next = S.reflexivity(next, 0);
    let observed = [checked(target, next), S.goalCount(state),
      sameBytes(before, Proof.artifact(state))];
  `), [true, 1, true]);
});

Deno.test("Slice 4 projection unification enforces occurs and free-variable scope checks", () => {
  assertEquals(run(`
    let pattern = proj(T.metavariable(71));
    let before = T.render(pattern);
    let solved = T.unify(pattern, proj(ap(mkBox, nat(23))));
    let statement = eq(N, solved, nat(23));
    let state = S.reflexivity(S.begin(env, statement), 0);
    let hole = T.metavariable(72);
    let observed = [checked(statement, state),
      before === T.render(pattern),
      rejected(function() { T.unify(hole, proj(hole)); }),
      rejected(function() { T.unify(T.metavariable(73), proj(b(0))); })];
  `), [true, true, true, true]);
});

Deno.test("Slice 4 universe instantiation traverses matches and recursive definitions", () => {
  assertEquals(run(`
    let functionIndex = Proof.declarationCount(env);
    let polymorphic = Proof.universes(["u", "v"], function(levels) {
      let U = T.type(Proof.Level.imax(levels.u, levels.v));
      let type = pi(U, pi(N, pi(b(1), b(2))));
      let motive = lam(N, b(3));
      let body = lam(U, lam(N, lam(b(1), T.match(b(1), motive,
        T.sequence([T.branch(0, b(0)), T.branch(1, lam(N, b(1)))])))));
      return Proof.definition(type, body);
    });
    let f = T.global(polymorphic, functionIndex, 5, 0);
    let value = ap(ap(ap(f, N), nat(3)), nat(29));
    let statement = eq(N, value, nat(29));
    let matchState = S.reflexivity(S.begin(polymorphic, statement), 0);
    let recursiveIndex = Proof.declarationCount(env);
    let recursive = Proof.universes(["u"], function(levels) {
      let U = T.type(levels.u);
      let innerType = pi(N, pi(b(1), b(2)));
      let recursiveCall = ap(ap(T.recursiveReference(0), b(0)), b(1));
      let body = lam(N, lam(b(1), T.match(b(1), lam(N, b(3)),
        T.sequence([T.branch(0, b(0)), T.branch(1, lam(N, recursiveCall))]))));
      let fixed = T.fixedPoint(T.sequence([T.recursiveDefinition(innerType, body, 0)]), 0);
      return Proof.definition(pi(U, innerType), lam(U, fixed));
    });
    let g = T.global(recursive, recursiveIndex, 0);
    let recursiveValue = ap(ap(ap(g, N), nat(3)), nat(31));
    let recursiveStatement = eq(N, recursiveValue, nat(31));
    let recursiveState = S.reflexivity(S.begin(recursive, recursiveStatement), 0);
    let observed = [checked(statement, matchState), checked(recursiveStatement, recursiveState),
      rejected(function() { T.infer(ap(T.global(polymorphic, functionIndex, 0, 1), N)); })];
  `), [true, true, true]);
});

Deno.test("Slice 4 literal payloads remain leaves through binder and hole transforms", () => {
  assertEquals(run(`
    let value = nat(18446744073709551616000000000000000000000000000000n);
    let before = T.render(value);
    let fn = lam(N, value);
    let statement = eq(N, ap(fn, nat(0)), value);
    let state = S.reflexivity(S.begin(env, statement), 0);
    let text = T.stringLiteral(env, "a\\u0000\\\"\\\\λ");
    let observed = [checked(statement, state), before === T.render(value),
      T.render(T.unify(T.metavariable(74), value)), T.render(text)];
  `), [true, true, "18446744073709551616000000000000000000000000000000", '"a\\u0000\\"\\\\λ"']);
});

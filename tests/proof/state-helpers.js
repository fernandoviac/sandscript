// The host resumes fuel pauses and collects when native proof work needs space.
export function runState(session, fuel = 100_000_000) {
  let result = session.run(0, fuel);
  let collections = 0;
  while (result.status === "paused" || result.status === "memory_pressure") {
    if (result.status === "memory_pressure") {
      if (collections === 100) break;
      session.gc();
      collections++;
    }
    result = session.run(0, fuel);
  }
  return result;
}

// SandScript source, not host implementations: all tactics execute in the vat.
// Tactics have the uniform (state, goal) signature and return immutable states.
export const tacticHelpers = `
  function sequence(state, goal, tactics) {
    for (let i = 0; i < tactics.length; i = i + 1) {
      state = tactics[i](state, goal);
    }
    return state;
  }
  // Visit the original goals right-to-left; newly opened goals are not revisited.
  function allGoals(state, tactic) {
    for (let goal = Proof.State.goalCount(state) - 1; goal >= 0; goal = goal - 1) {
      state = tactic(state, goal);
    }
    return state;
  }
  function firstSuccess(state, goal, tactics) {
    for (let i = 0; i < tactics.length; i = i + 1) {
      try { return tactics[i](state, goal); } catch (error) {
        if (i === tactics.length - 1) { throw error; }
      }
    }
    throw new TypeError("firstSuccess requires a tactic");
  }
  // An explicit bound also terminates tactics which succeed without progress.
  function boundedRepeat(state, goal, tactic, bound) {
    for (let i = 0; i < bound; i = i + 1) {
      if (goal >= Proof.State.goalCount(state)) { return state; }
      try { state = tactic(state, goal); } catch (error) { return state; }
    }
    return state;
  }
  function optional(state, goal, tactic) {
    try { return tactic(state, goal); } catch (error) { return state; }
  }
  function focus(state, goal, tactic) { return tactic(state, goal); }
  // Call on the consecutive branch goals returned by cases/induction. Branch
  // handlers run in constructor order semantically, but are scheduled from the
  // right so closing or splitting one branch cannot renumber an earlier one.
  function constructorBranches(state, goal, tactics) {
    for (let i = tactics.length - 1; i >= 0; i = i - 1) {
      state = tactics[i](state, goal + i);
    }
    return state;
  }
`;

// Compact term constructors shared by the gate fixtures. These only build
// ordinary kernel terms; no host code implements proof logic.
export const termHelpers = `
  function b(index) { return Proof.Term.bound(index); }
  function app(fn, args) {
    for (let i = 0; i < args.length; i = i + 1) {
      fn = Proof.Term.apply(fn, args[i]);
    }
    return fn;
  }
  function pi(domains, result) {
    for (let i = domains.length - 1; i >= 0; i = i - 1) {
      result = Proof.Term.product(domains[i], result);
    }
    return result;
  }
  function lam(domains, result) {
    for (let i = domains.length - 1; i >= 0; i = i - 1) {
      result = Proof.Term.lambda(domains[i], result);
    }
    return result;
  }
  function recursive(type, body, argument) {
    return Proof.Term.fixedPoint(Proof.Term.sequence([
      Proof.Term.recursiveDefinition(type, body, argument)
    ]), 0);
  }
  function introduceMany(state, goal, count) {
    for (let i = 0; i < count; i = i + 1) {
      state = Proof.State.introduce(state, goal);
    }
    return state;
  }
  function checked(state, statement) {
    let proof = Proof.State.seal(state);
    let theorem = Proof.theorem(statement, proof);
    if (!Proof.Theorem.isTheorem(theorem) ||
        !Proof.checkArtifact(Proof.Theorem.artifact(theorem))) {
      throw new TypeError("sealed gate theorem failed kernel recheck");
    }
    return proof;
  }
`;

export const equalityFixture = `
  let env = Proof.Core.Natural.environment();
  let nat = Proof.Term.inductive(env, 0);
  let zero = Proof.Term.constructor(env, 0, 0);
  let succ = Proof.Term.constructor(env, 0, 1);
  let type = Proof.Term.type(0);
  let eqIndex = Proof.declarationCount(env);
  let eqRef = Proof.Term.inductiveReference(eqIndex);
  env = Proof.inductive(env,
    pi([type, b(0), b(1)], Proof.Term.proposition()),
    Proof.Term.sequence([pi([type, b(0)], app(eqRef, [b(1), b(0), b(0)]))]), 1);
  let eq = Proof.Term.inductive(env, eqIndex);
  nat = Proof.Term.inductive(env, 0);
  zero = Proof.Term.constructor(env, 0, 0);
  succ = Proof.Term.constructor(env, 0, 1);
  function equal(domain, left, right) { return app(eq, [domain, left, right]); }
`;

export const additionFixture = equalityFixture + `
  let binary = pi([nat, nat], nat);
  let addBody = lam([nat, nat], Proof.Term.match(b(1), lam([nat], nat),
    Proof.Term.sequence([
      Proof.Term.branch(0, b(0)),
      Proof.Term.branch(1, lam([nat], app(succ, [
        app(Proof.Term.recursiveReference(0), [b(0), b(1)])
      ])))
    ])));
  let addIndex = Proof.declarationCount(env);
  env = Proof.definition(binary, recursive(binary, addBody, 0));
  let add = Proof.Term.global(env, addIndex);
  nat = Proof.Term.inductive(env, 0);
  zero = Proof.Term.constructor(env, 0, 0);
  binary = pi([nat, nat], nat);
  eq = Proof.Term.inductive(env, eqIndex);
  succ = Proof.Term.constructor(env, 0, 1);
  function plus(a, c) { return app(add, [a, c]); }
`;

export const naturalFixture = additionFixture + `
  let mulBody = lam([nat, nat], Proof.Term.match(b(1), lam([nat], nat),
    Proof.Term.sequence([
      Proof.Term.branch(0, zero),
      Proof.Term.branch(1, lam([nat], app(add, [b(1),
        app(Proof.Term.recursiveReference(0), [b(0), b(1)])
      ])))
    ])));
  let mulIndex = Proof.declarationCount(env);
  env = Proof.definition(binary, recursive(binary, mulBody, 0));
  let mul = Proof.Term.global(env, mulIndex);
  // Carry the full environment, including equality, in every statement.
  nat = Proof.Term.inductive(env, 0);
  eq = Proof.Term.inductive(env, eqIndex);
  zero = Proof.Term.constructor(env, 0, 0);
  succ = Proof.Term.constructor(env, 0, 1);
  add = Proof.Term.global(env, addIndex);
  function times(a, c) { return app(mul, [a, c]); }
`;

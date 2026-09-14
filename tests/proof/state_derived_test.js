import { assertEquals } from "https://deno.land/std@0.208.0/assert/mod.ts";
import { freshSession } from "../../src/host-owned-session.js";
import { parseAndSetup } from "../fuel/test-helpers.js";
import { runState } from "./state-helpers.js";

const prelude = `
  let b = (index) => Proof.Term.bound(index);
  let pi = (domain, body) => Proof.Term.product(domain, body);
  let lam = (domain, body) => Proof.Term.lambda(domain, body);
  let ap = (fn, argument) => Proof.Term.apply(fn, argument);
  let prop = Proof.Term.proposition();
  let P = pi(prop, pi(b(0), b(1)));
  let identity = lam(prop, lam(b(0), b(0)));
  let env = Proof.assumption(P);
  let observed = [];
  function checked(statement, state) {
    let theorem = Proof.theorem(statement, Proof.State.seal(state));
    return Proof.checkArtifact(Proof.Theorem.artifact(theorem));
  }
  function rejected(state, attempt, semanticFailure) {
    let before = Proof.artifact(state);
    let count = Proof.State.goalCount(state);
    let target = Proof.Term.render(Proof.State.goalTarget(state, 0));
    let code = 0;
    try { attempt(state); } catch (error) { code = Proof.errorCode(); }
    let after = Proof.artifact(state);
    let unchanged = before.length === after.length;
    for (let index = 0; index < before.length; index = index + 1) {
      unchanged = unchanged && before[index] === after[index];
    }
    observed.push(semanticFailure ? code !== 0 && code !== 20 && code !== 29 : code);
    observed.push(unchanged && count === Proof.State.goalCount(state) &&
      target === Proof.Term.render(Proof.State.goalTarget(state, 0)));
  }
`;

function run(source, expected, heapSize = 64 * 1024 * 1024) {
  const session = freshSession({ heapSize });
  parseAndSetup(session, prelude + source);
  assertEquals(runState(session, 30_000_000).status, "done");
  assertEquals(session.get(0, "observed"), expected);
}

Deno.test("native refine supplies typed argument goals and rejects an incompatible conclusion", () => {
  run(`
    let state = Proof.State.begin(env, P);
    let refined = Proof.State.refine(state, 0, lam(P, b(0)));
    observed.push(Proof.State.goalCount(refined));
    observed.push(checked(P, Proof.State.exact(refined, 0, identity)));
    rejected(state, (s) => Proof.State.refine(s, 0, prop));
  `, [1, true, 85, true]);
});

Deno.test("native revert and clear embed shortened dependent contexts without capture", () => {
  run(`
    let statement = pi(prop, pi(b(0), pi(b(1), b(2))));
    let state = Proof.State.begin(env, statement);
    state = Proof.State.introduce(state, 0);
    state = Proof.State.introduce(state, 0);
    state = Proof.State.introduce(state, 0);
    let reverted = Proof.State.revert(state, 0);
    let reopened = Proof.State.introduce(reverted, 0);
    observed.push(checked(statement, Proof.State.exact(reopened, 0, b(1))));
    let cleared = Proof.State.clear(state, 0);
    observed.push(checked(statement, Proof.State.exact(cleared, 0, b(0))));
    let empty = Proof.State.begin(env, P);
    rejected(empty, (s) => Proof.State.revert(s, 0));
    let dependent = Proof.State.introduce(Proof.State.begin(env, pi(prop, b(0))), 0);
    rejected(dependent, (s) => Proof.State.clear(s, 0));
    rejected(empty, (s) => Proof.State.clear(s, 0));
  `, [true, true, 95, true, 95, true, 95, true]);
});

Deno.test("native have pose specialize and infer use the selected local context", () => {
  run(`
    let state = Proof.State.begin(env, P);
    let have = Proof.State.have(state, 0, P);
    observed.push(Proof.State.goalCount(have));
    have = Proof.State.exact(have, 0, identity);
    observed.push(checked(P, Proof.State.assumption(have, 0)));
    let posed = Proof.State.pose(state, 0, identity);
    observed.push(checked(P, Proof.State.assumption(posed, 0)));
    let statement = pi(pi(P, P), P);
    let local = Proof.State.introduce(Proof.State.begin(env, statement), 0);
    let specialized = Proof.State.specialize(local, 0, 0, identity);
    observed.push(checked(statement, Proof.State.assumption(specialized, 0)));
    let inferred = Proof.State.infer(local, 0, ap(b(0), identity));
    observed.push(Proof.Term.render(inferred) === Proof.Term.render(P));
    // These calls must reject semantically, not merely exhaust resources.
    rejected(state, (s) => Proof.State.have(s, 0, identity), true);
    rejected(state, (s) => Proof.State.pose(s, 0, b(0)), true);
    rejected(local, (s) => Proof.State.specialize(s, 0, 0, prop), true);
    rejected(state, (s) => Proof.State.infer(s, 0, b(0)), true);
  `, [2, true, true, true, true, true, true, true, true, true, true, true, true]);
});

Deno.test("native constructor-derived tactics enforce shape and respect existential parameters", () => {
  run(`
    let reference = Proof.Term.inductiveReference(1);
    let pairEnv = Proof.inductive(env, prop,
      Proof.Term.sequence([pi(P, pi(P, reference))]), 0);
    let pair = Proof.Term.inductive(pairEnv, 1);
    let state = Proof.State.begin(pairEnv, pair);
    let split = Proof.State.split(state, 0);
    observed.push(Proof.State.goalCount(split));
    split = Proof.State.exact(split, 0, identity);
    split = Proof.State.exact(split, 0, identity);
    observed.push(checked(pair, split));
    let sumEnv = Proof.inductive(env, prop,
      Proof.Term.sequence([pi(P, reference), pi(P, reference)]), 0);
    let sum = Proof.Term.inductive(sumEnv, 1);
    let sumState = Proof.State.begin(sumEnv, sum);
    observed.push(checked(sum, Proof.State.exact(Proof.State.left(sumState, 0), 0, identity)));
    observed.push(checked(sum, Proof.State.exact(Proof.State.right(sumState, 0), 0, identity)));
    let existentialEnv = Proof.inductive(env, pi(prop, prop),
      Proof.Term.sequence([pi(prop, pi(b(0), ap(reference, b(1))))]), 1);
    let existential = ap(Proof.Term.inductive(existentialEnv, 1), P);
    let existentialState = Proof.State.begin(existentialEnv, existential);
    observed.push(checked(existential, Proof.State.exists(existentialState, 0, identity)));
    rejected(sumState, (s) => Proof.State.split(s, 0));
    rejected(state, (s) => Proof.State.left(s, 0));
    rejected(state, (s) => Proof.State.right(s, 0));
    rejected(sumState, (s) => Proof.State.exists(s, 0, identity));
  `, [2, true, true, true, true, 100, true, 100, true, 100, true, 100, true]);
});

Deno.test("native contradiction destruct and inversion build checked elimination proofs", () => {
  run(`
    let emptyEnv = Proof.inductive(env, prop, Proof.Term.sequence([]), 0);
    let empty = Proof.Term.inductive(emptyEnv, 1);
    let absurdStatement = pi(empty, P);
    let absurd = Proof.State.introduce(Proof.State.begin(emptyEnv, absurdStatement), 0);
    observed.push(checked(absurdStatement, Proof.State.contradiction(absurd, 0)));
    let unitRef = Proof.Term.inductiveReference(1);
    let unitEnv = Proof.inductive(env, prop, Proof.Term.sequence([unitRef]), 0);
    let unit = Proof.Term.inductive(unitEnv, 1);
    let statement = pi(unit, P);
    let state = Proof.State.introduce(Proof.State.begin(unitEnv, statement), 0);
    let destructed = Proof.State.destruct(state, 0, 0);
    observed.push(checked(statement, Proof.State.exact(destructed, 0, identity)));
    let inverted = Proof.State.inversion(state, 0, 0);
    observed.push(checked(statement, Proof.State.exact(inverted, 0, identity)));
    let plain = Proof.State.introduce(Proof.State.begin(env, pi(P, P)), 0);
    rejected(plain, (s) => Proof.State.contradiction(s, 0));
    rejected(plain, (s) => Proof.State.destruct(s, 0, 0));
    rejected(plain, (s) => Proof.State.inversion(s, 0, 0));
  `, [true, true, true, 96, true, 86, true, 101, true]);
});

Deno.test("native inversion retains an index equation for every equality index", () => {
  run(`
    let core = Proof.Core.environment();
    let natural = Proof.Term.inductive(core, 0);
    let equality = Proof.Term.inductive(core, 2, 1);
    let zero = Proof.Term.constructor(core, 0, 0);
    let eq = (left, right) => ap(ap(ap(equality, natural), left), right);
    let statement = pi(eq(zero, zero), P);
    let state = Proof.State.introduce(Proof.State.begin(core, statement), 0);
    let inverted = Proof.State.inversion(state, 0, 0);
    observed.push(Proof.State.goalCount(inverted));
    // Canonical Eq fixes A and left: refl has no field, only right is an index.
    let expected = pi(eq(zero, zero), P);
    observed.push(Proof.Term.isTerm(Proof.Term.check(
      Proof.Term.lambda(Proof.State.goalTarget(inverted, 0), b(0)),
      pi(expected, expected))));
    inverted = Proof.State.introduce(inverted, 0);
    observed.push(Proof.Term.isTerm(Proof.Term.check(
      Proof.Term.lambda(Proof.State.goalTarget(inverted, 0), b(0)),
      pi(P, P))));
    observed.push(checked(statement, Proof.State.exact(inverted, 0, identity)));
  `, [1, true, true, true]);
});

Deno.test("native decide evaluates nullary constructors and equality but does not open goals", () => {
  run(`
    let unitEnv = Proof.inductive(env, prop,
      Proof.Term.sequence([Proof.Term.inductiveReference(1)]), 0);
    let unit = Proof.Term.inductive(unitEnv, 1);
    observed.push(checked(unit, Proof.State.decide(Proof.State.begin(unitEnv, unit), 0)));
    let core = Proof.Core.environment();
    let natural = Proof.Term.inductive(core, 0);
    let equality = Proof.Term.inductive(core, 2, 1);
    let zero = Proof.Term.constructor(core, 0, 0);
    let successor = Proof.Term.constructor(core, 0, 1);
    let eq = (left, right) => ap(ap(ap(equality, natural), left), right);
    let statement = eq(ap(lam(natural, b(0)), zero), zero);
    observed.push(checked(statement, Proof.State.decide(Proof.State.begin(core, statement), 0)));
    let unequal = Proof.State.begin(core, eq(zero, ap(successor, zero)));
    rejected(unequal, (s) => Proof.State.decide(s, 0));
    let undecidable = Proof.State.begin(env, P);
    rejected(undecidable, (s) => Proof.State.decide(s, 0));
    let familyIndex = Proof.declarationCount(core);
    let reference = Proof.Term.inductiveReference(familyIndex);
    let familyEnv = Proof.inductive(core, pi(natural, prop),
      Proof.Term.sequence([ap(reference, zero), ap(reference, ap(successor, zero))]), 0);
    let family = Proof.Term.inductive(familyEnv, familyIndex);
    zero = Proof.Term.constructor(familyEnv, 0, 0);
    successor = Proof.Term.constructor(familyEnv, 0, 1);
    let laterConstructor = ap(family, ap(successor, zero));
    observed.push(checked(laterConstructor,
      Proof.State.decide(Proof.State.begin(familyEnv, laterConstructor), 0)));
  `, [true, true, 97, true, 97, true, true]);
});

Deno.test("native simplify descends under binders and unfold expands only the selected definition", () => {
  run(`
    let firstEnv = Proof.definition(prop, P);
    let first = Proof.Term.global(firstEnv, 0);
    let secondEnv = Proof.definition(prop, pi(first, first));
    let second = Proof.Term.global(secondEnv, 1);
    first = Proof.Term.global(secondEnv, 0);
    let statement = pi(first, second);
    let state = Proof.State.begin(secondEnv, statement);
    let unfolded = Proof.State.unfold(state, 0, 0);
    observed.push(Proof.Term.render(Proof.State.goalTarget(unfolded, 0)) ===
      Proof.Term.render(pi(P, second)));
    let simplified = Proof.State.simplify(state, 0);
    observed.push(Proof.Term.render(Proof.State.goalTarget(simplified, 0)) ===
      Proof.Term.render(pi(P, pi(P, P))));
    let evidence = lam(P, lam(P, b(0)));
    observed.push(checked(statement, Proof.State.exact(unfolded, 0, evidence)));
    observed.push(checked(statement, Proof.State.exact(simplified, 0, evidence)));
    let plain = Proof.State.begin(env, P);
    rejected(plain, (s) => Proof.State.unfold(s, 0, 0));
    rejected(plain, (s) => Proof.State.simplify(s, 3));
  `, [true, true, true, true, 98, true, 82, true]);
});

Deno.test("native inversion transports a genuinely dependent index telescope", () => {
  run(`
    let core = Proof.Core.environment();
    let vectorIndex = Proof.declarationCount(core);
    let natural = Proof.Term.inductive(core, 0);
    let zero = Proof.Term.constructor(core, 0, 0);
    let vectorReference = Proof.Term.inductiveReference(vectorIndex);
    let vectors = Proof.inductive(core, pi(natural, Proof.Term.type(0)),
      Proof.Term.sequence([ap(vectorReference, zero)]), 0);
    natural = Proof.Term.inductive(vectors, 0);
    let vector = Proof.Term.inductive(vectors, vectorIndex);
    let familyIndex = Proof.declarationCount(vectors);
    let reference = Proof.Term.inductiveReference(familyIndex);
    let familyType = pi(natural, pi(ap(vector, b(0)), pi(ap(vector, b(1)), prop)));
    let constructorType = pi(natural, pi(ap(vector, b(0)), pi(ap(vector, b(1)),
      ap(ap(ap(reference, b(2)), b(1)), b(0)))));
    let indexedEnv = Proof.inductive(vectors, familyType,
      Proof.Term.sequence([constructorType]), 0);
    let family = Proof.Term.inductive(indexedEnv, familyIndex);
    zero = Proof.Term.constructor(indexedEnv, 0, 0);
    let empty = Proof.Term.constructor(indexedEnv, vectorIndex, 0);
    let instance = ap(ap(ap(family, zero), empty), empty);
    let statement = pi(instance, P);
    let state = Proof.State.introduce(Proof.State.begin(indexedEnv, statement), 0);
    let inverted = Proof.State.inversion(state, 0, 0);
    observed.push(Proof.State.goalCount(inverted));
    for (let index = 0; index < 6; index = index + 1) {
      inverted = Proof.State.introduce(inverted, 0);
    }
    observed.push(checked(statement, Proof.State.exact(inverted, 0, identity)));
  `, [1, true], 256 * 1024 * 1024);
});

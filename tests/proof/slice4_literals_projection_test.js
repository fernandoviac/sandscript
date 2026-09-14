import { assertEquals } from "https://deno.land/std@0.208.0/assert/mod.ts";
import { freshSession } from "../../src/host-owned-session.js";
import { parseAndSetup } from "../fuel/test-helpers.js";

function run(source, withFixture = false) {
  const session = freshSession({ heapSize: 64 * 1024 * 1024 });
  if (withFixture) {
    const bytes = Deno.readFileSync(new URL("./lean/literal-canonical-v2.bin", import.meta.url));
    const key = session.mem.internString("fixture");
    const slot = session.mem.scratchPointerChecked(0, 16);
    session.mem.writeValueAt(slot, bytes);
    session.mem.scopeDefine(session.mem.getRootScope(), key, slot);
  }
  parseAndSetup(session, source);
  let result;
  for (let turn = 0; turn < 10000; turn++) {
    result = session.run(0, 1000000);
    if (result.status !== "paused") break;
  }
  assertEquals(result.status, "done");
  return session;
}

const helpers = `
  function b(index) { return Proof.Term.bound(index); }
  function app(fn, args) {
    for (let i = 0; i < args.length; i = i + 1) fn = Proof.Term.apply(fn, args[i]);
    return fn;
  }
  function pi(domains, result) {
    for (let i = domains.length - 1; i >= 0; i = i - 1) result = Proof.Term.product(domains[i], result);
    return result;
  }
  function name(text) { return Proof.Name.str(0, text); }
  function reject(fn) {
    try { fn(); return false; } catch (error) {
      if (Proof.errorCode() === 20 || Proof.errorCode() === 29) throw error;
      return true;
    }
  }
  function sameType(left, right) {
    Proof.Term.check(Proof.Term.lambda(left, b(0)), pi([right], right));
    return true;
  }
`;

Deno.test("Slice4 natural literals preserve arbitrary unsigned limbs and lazy successor views", () => {
  const session = run(helpers + `
    let env = Proof.Core.Natural.environment();
    let natIndex = Proof.declarationIndex(env, name("Nat"));
    let nat = Proof.Term.inductive(env, natIndex);
    env = Proof.assumption(env, pi([nat], Proof.Term.proposition()), name("LiteralPredicate"));
    nat = Proof.Term.inductive(env, natIndex);
    let pred = Proof.Term.global(env, Proof.declarationIndex(env, name("LiteralPredicate")));
    let succ = Proof.Term.constructor(env, natIndex, 1);
    let big = Proof.Term.naturalLiteral(env, 340282366920938463463374607431768211455n);
    let next = Proof.Term.naturalLiteral(env, 340282366920938463463374607431768211456n);
    let zero = Proof.Term.naturalLiteral(env, 0);
    let one = Proof.Term.naturalLiteral(env, 1n);
    let constructorZero = Proof.Term.constructor(env, natIndex, 0);
    let observed = [
      sameType(Proof.Term.infer(big), nat),
      sameType(app(pred, [app(succ, [big])]), app(pred, [next])),
      sameType(app(pred, [zero]), app(pred, [constructorZero])),
      sameType(app(pred, [one]), app(pred, [app(succ, [constructorZero])])),
      reject(() => Proof.Term.naturalLiteral(env, -1)),
      reject(() => Proof.Term.naturalLiteral(env, -1n)),
      reject(() => Proof.Term.naturalLiteral(env, 0.5)),
      reject(() => Proof.Term.naturalLiteral(env, 9007199254740992)),
      reject(() => Proof.Term.naturalLiteral(env, "123")),
      reject(() => sameType(app(pred, [big]), app(pred, [next])))
    ];
  `);
  assertEquals(session.get(0, "observed"), Array(10).fill(true));
});

Deno.test("Slice4 dependent projection substitutes earlier fields in an open context", () => {
  const session = run(helpers + `
    let env = Proof.Core.Natural.environment();
    let natIndex = Proof.declarationIndex(env, name("Nat"));
    let pairIndex = Proof.declarationCount(env);
    env = Proof.inductive(env, Proof.Term.type(1), Proof.Term.sequence([
      pi([Proof.Term.type(0), b(0)], Proof.Term.inductiveReference(pairIndex))
    ]), 0, name("DependentPair"), [name("makeDependentPair")]);
    pairIndex = Proof.declarationIndex(env, name("DependentPair"));
    let pair = Proof.Term.inductive(env, pairIndex);
    let nat = Proof.Term.inductive(env, natIndex);
    let value = app(Proof.Term.constructor(env, pairIndex, 0), [nat, Proof.Term.naturalLiteral(env, 37n)]);
    let first = Proof.Term.projection(env, pairIndex, 0, value);
    let second = Proof.Term.projection(env, pairIndex, 1, value);
    let dependentFunction = Proof.Term.lambda(pair, Proof.Term.projection(env, pairIndex, 1, b(0)));
    let dependentType = pi([pair], Proof.Term.projection(env, pairIndex, 0, b(0)));
    let observed = [
      sameType(first, nat),
      sameType(Proof.Term.infer(second), nat),
      sameType(Proof.Term.infer(dependentFunction), dependentType),
      reject(() => Proof.Term.infer(Proof.Term.projection(env, pairIndex, 2, value))),
      reject(() => Proof.Term.projection(env, pairIndex, 4294967296, value)),
      reject(() => Proof.Term.projection(env, pairIndex, -1, value)),
      reject(() => Proof.Term.infer(Proof.Term.projection(env, pairIndex, 4294967295, value))),
      Proof.checkArtifact(Proof.artifact(env))
    ];
  `);
  assertEquals(session.get(0, "observed"), Array(8).fill(true));
});

Deno.test("Slice4 projection rejects a stored family different from the target family", () => {
  const session = run(helpers + `
    let env = Proof.Core.Natural.environment();
    let natIndex = Proof.declarationIndex(env, name("Nat"));
    let firstIndex = Proof.declarationCount(env);
    env = Proof.inductive(env, Proof.Term.type(0), Proof.Term.sequence([
      pi([Proof.Term.inductiveReference(natIndex)], Proof.Term.inductiveReference(firstIndex))
    ]), 0, name("FirstBox"), [name("makeFirstBox")]);
    let secondIndex = Proof.declarationCount(env);
    env = Proof.inductive(env, Proof.Term.type(0), Proof.Term.sequence([
      pi([Proof.Term.inductiveReference(natIndex)], Proof.Term.inductiveReference(secondIndex))
    ]), 0, name("SecondBox"), [name("makeSecondBox")]);
    firstIndex = Proof.declarationIndex(env, name("FirstBox"));
    secondIndex = Proof.declarationIndex(env, name("SecondBox"));
    let firstType = Proof.Term.inductive(env, firstIndex);
    let value = app(Proof.Term.constructor(env, firstIndex, 0), [Proof.Term.naturalLiteral(env, 19)]);
    let observed = [
      reject(() => Proof.Term.infer(Proof.Term.projection(env, secondIndex, 0, value))),
      reject(() => Proof.Term.infer(Proof.Term.lambda(firstType,
        Proof.Term.projection(env, secondIndex, 0, b(0))))),
      reject(() => Proof.Term.infer(Proof.Term.projection(env, natIndex, 0,
        Proof.Term.naturalLiteral(env, 3))))
    ];
  `);
  assertEquals(session.get(0, "observed"), [true, true, true]);
});

Deno.test("Slice4 Prop projections reject hidden data and dependent proof fields but allow independent proofs", () => {
  const session = run(helpers + `
    let env = Proof.Core.Natural.environment();
    let natIndex = Proof.declarationIndex(env, name("Nat"));
    let nat = Proof.Term.inductive(env, natIndex);
    env = Proof.assumption(env, pi([nat], Proof.Term.proposition()), name("HiddenPredicate"));
    let predicateIndex = Proof.declarationIndex(env, name("HiddenPredicate"));
    let dependentIndex = Proof.declarationCount(env);
    let predicate = Proof.Term.global(env, predicateIndex);
    env = Proof.inductive(env, Proof.Term.proposition(), Proof.Term.sequence([
      pi([Proof.Term.inductiveReference(natIndex), app(predicate, [b(0)])],
        Proof.Term.inductiveReference(dependentIndex))
    ]), 0, name("HiddenDependent"), [name("makeHiddenDependent")]);
    let independentIndex = Proof.declarationCount(env);
    predicate = Proof.Term.global(env, predicateIndex);
    let fixedProofType = app(predicate, [Proof.Term.naturalLiteral(env, 0)]);
    env = Proof.inductive(env, Proof.Term.proposition(), Proof.Term.sequence([
      pi([Proof.Term.inductiveReference(natIndex), fixedProofType],
        Proof.Term.inductiveReference(independentIndex))
    ]), 0, name("HiddenIndependent"), [name("makeHiddenIndependent")]);
    dependentIndex = Proof.declarationIndex(env, name("HiddenDependent"));
    independentIndex = Proof.declarationIndex(env, name("HiddenIndependent"));
    let dependent = Proof.Term.inductive(env, dependentIndex);
    let independent = Proof.Term.inductive(env, independentIndex);
    predicate = Proof.Term.global(env, predicateIndex);
    fixedProofType = app(predicate, [Proof.Term.naturalLiteral(env, 0)]);
    let allowed = Proof.Term.lambda(independent, Proof.Term.projection(env, independentIndex, 1, b(0)));
    let observed = [
      reject(() => Proof.Term.infer(Proof.Term.lambda(dependent,
        Proof.Term.projection(env, dependentIndex, 0, b(0))))),
      reject(() => Proof.Term.infer(Proof.Term.lambda(dependent,
        Proof.Term.projection(env, dependentIndex, 1, b(0))))),
      sameType(Proof.Term.infer(allowed), pi([independent], fixedProofType))
    ];
  `);
  assertEquals(session.get(0, "observed"), [true, true, true]);
});


const fixtureMetadata = JSON.parse(Deno.readTextFileSync(
  new URL("./lean/literal-canonical-v2.json", import.meta.url),
));
const fixturePrelude = helpers + `
  if (!Proof.checkArtifact(fixture)) throw new TypeError("canonical fixture failed checking");
  let env = Proof.environment(Proof.loadArtifact(fixture, ${fixtureMetadata.loadTheoremIndex}));
  if (!Proof.checkArtifact(Proof.artifact(env))) throw new TypeError("loaded fixture failed rechecking");
  function intrinsic(text) {
    let parts = text.split(".");
    let result = 0;
    for (let i = 0; i < parts.length; i = i + 1) result = Proof.Name.str(result, parts[i]);
    return Proof.declarationIndex(env, result);
  }
  let nat = Proof.Term.inductive(env, intrinsic("Nat"));
  let bool = Proof.Term.inductive(env, intrinsic("Bool"));
  let eq = Proof.Term.inductive(env, intrinsic("Eq"), 1);
  let refl = Proof.Term.constructor(env, intrinsic("Eq"), 0, 1);
  function numeral(value) { return Proof.Term.naturalLiteral(env, value); }
  function equation(type, left, right) {
    let statement = app(eq, [type, left, right]);
    let proof = app(refl, [type, left]);
    Proof.Term.check(proof, statement);
    return true;
  }
  function binary(operation, left, right) {
    return app(Proof.Term.global(env, intrinsic("Nat." + operation)), [numeral(left), numeral(right)]);
  }
`;

Deno.test("Slice4 authenticated Nat accelerators compute exact large values and Bool constructors", () => {
  const session = run(fixturePrelude + `
    let cases = [
      ["add", 1208925819614629174706177n, 18446744073709551619n, 1208944266358702884257796n], 
      ["sub", 79228162514264337593543950336n, 18446744073709551623n, 79228162495817593519834398713n], 
      ["mul", 1208925819614629174706177n, 18446744073709551619n, 22300745198530623145162514178236322739650563n], 
      ["div", 1267650600228229401496703205393n, 97n, 13068562888950818572130960880n], 
      ["mod", 1267650600228229401496703205393n, 97n, 33n], 
      ["gcd", 19014759003423441022450548080640n, 25387442211907212668829696n, 3626777458843887524118528n], 
      ["pow", 3n, 100n, 515377520732011331036461129765621272702107522001n], 
      ["land", 79228162514264338693055578115n, 79228162514264337597838917633n, 79228162514264337593543950337n], 
      ["lor", 79228162514264338693055578115n, 18446744078004518913n, 79228162532711082771060097027n], 
      ["xor", 79228162514264338693055578115n, 79228162514264337597838917633n, 1103806595074n], 
      ["shiftLeft", 1208925819614629174706177n, 129n, 822752278660603021077485271843409094368294859566004795210727424n], 
      ["shiftRight", 1532495540865890219487814710904163037117168849256448001n, 129n, 2251799813685250n], 
    ];
    let observed = [];
    for (let i = 0; i < cases.length; i = i + 1) {
      let row = cases[i];
      observed.push(equation(nat, binary(row[0], row[1], row[2]), numeral(row[3])));
    }
    let falseTerm = Proof.Term.constructor(env, intrinsic("Bool"), 0);
    let trueTerm = Proof.Term.constructor(env, intrinsic("Bool"), 1);
    observed.push(equation(bool, binary("beq", 18446744073709551617n, 18446744073709551617n), trueTerm));
    observed.push(equation(bool, binary("beq", 18446744073709551617n, 18446744073709551618n), falseTerm));
    observed.push(equation(bool, binary("ble", 18446744073709551617n, 18446744073709551618n), trueTerm));
    observed.push(equation(bool, binary("ble", 18446744073709551618n, 18446744073709551617n), falseTerm));
    observed.push(equation(nat, binary("sub", 7n, 1000000000000000000000000000000n), numeral(0)));
    observed.push(equation(nat, binary("div", 18446744073709551617n, 0n), numeral(0)));
    observed.push(equation(nat, binary("mod", 18446744073709551617n, 0n), numeral(18446744073709551617n)));
    observed.push(equation(nat, binary("shiftRight", 18446744073709551617n, 1099511627776n), numeral(0)));
    observed.push(equation(nat, binary("shiftLeft", 0n, 1099511627776n), numeral(0)));
    observed.push(equation(nat, binary("pow", 1n, 4294967295n), numeral(1)));
    observed.push(equation(nat, binary("pow", 0n, 4294967295n), numeral(0)));
    observed.push(equation(nat, binary("pow", 0n, 0n), numeral(1)));
    function resourceRefused(operation) {
      try { equation(nat, binary(operation, 2n, 4294967296n), numeral(0)); return false; }
      catch (error) { return Proof.errorCode() === 29; }
    }
    observed.push(resourceRefused("pow"));
    observed.push(resourceRefused("shiftLeft"));
  `, true);
  assertEquals(session.get(0, "observed"), Array(26).fill(true));
});

Deno.test("Slice4 strings expand through Unicode scalar Char.ofNat and String.ofList, preserving NUL", () => {
  const session = run(fixturePrelude + `
    let stringType = Proof.Term.inductive(env, intrinsic("String"));
    let charType = Proof.Term.inductive(env, intrinsic("Char"));
    let listIndex = intrinsic("List");
    let nil = app(Proof.Term.constructor(env, listIndex, 0, 0), [charType]);
    let cons = app(Proof.Term.constructor(env, listIndex, 1, 0), [charType]);
    let ofNat = Proof.Term.global(env, intrinsic("Char.ofNat"));
    let ofList = Proof.Term.global(env, intrinsic("String.ofList"));
    let scalars = [65, 0, 233, 119070, 66560];
    let chars = nil;
    for (let i = scalars.length - 1; i >= 0; i = i - 1) {
      chars = app(cons, [app(ofNat, [numeral(scalars[i])]), chars]);
    }
    let literal = Proof.Term.stringLiteral(env, "A\\u0000é𝄞𐐀");
    let expanded = app(ofList, [chars]);
    let observed = [
      equation(stringType, literal, expanded),
      equation(stringType, Proof.Term.stringLiteral(env, ""), app(ofList, [nil])),
      reject(() => equation(stringType, literal, Proof.Term.stringLiteral(env, "Aé𝄞𐐀")))
    ];
    let definition = Proof.definition(stringType, literal, name("UnicodeLiteralValue"));
    let artifact = Proof.artifact(definition);
    let offset = 16;
    let mutated = false;
    while (offset < artifact.length) {
      let words = artifact[offset] + artifact[offset + 1] * 256 + artifact[offset + 2] * 65536 + artifact[offset + 3] * 16777216;
      let tag = artifact[offset + 4] + artifact[offset + 5] * 256;
      if (tag === 25 && artifact[offset + 8] !== 0) {
        artifact[offset + 12] = 192;
        mutated = true;
        break;
      }
      offset = offset + words * 4;
    }
    observed.push(mutated && !Proof.checkArtifact(artifact));
  `, true);
  assertEquals(session.get(0, "observed"), [true, true, true, true]);
});

Deno.test("Slice4 a well-typed fake Nat.add receives no arithmetic authority from its name", () => {
  const session = run(helpers + `
    let env = Proof.Core.Natural.environment();
    let natIndex = Proof.declarationIndex(env, name("Nat"));
    let nat = Proof.Term.inductive(env, natIndex);
    let zero = Proof.Term.constructor(env, natIndex, 0);
    let addName = Proof.Name.str(name("Nat"), "add");
    env = Proof.definition(pi([nat, nat], nat),
      Proof.Term.lambda(nat, Proof.Term.lambda(nat, zero)), addName);
    nat = Proof.Term.inductive(env, natIndex);
    env = Proof.assumption(env, pi([nat], Proof.Term.proposition()), name("ForgeryPredicate"));
    let pred = Proof.Term.global(env, Proof.declarationIndex(env, name("ForgeryPredicate")));
    let fake = Proof.Term.global(env, Proof.declarationIndex(env, addName));
    let application = app(fake, [Proof.Term.naturalLiteral(env, 19), Proof.Term.naturalLiteral(env, 23)]);
    let computed = app(pred, [application]);
    let actual = app(pred, [Proof.Term.naturalLiteral(env, 0)]);
    let forged = app(pred, [Proof.Term.naturalLiteral(env, 42)]);
    let observed = [sameType(computed, actual), reject(() => sameType(computed, forged))];
  `);
  assertEquals(session.get(0, "observed"), [true, true]);
});

Deno.test("Slice4 rejects a noncanonical high zero limb on artifact recheck", () => {
  const session = run(helpers + `
    let env = Proof.Core.Natural.environment();
    let nat = Proof.Term.inductive(env, Proof.declarationIndex(env, name("Nat")));
    env = Proof.definition(nat, Proof.Term.naturalLiteral(env, 18446744073709551616n));
    let artifact = Proof.artifact(env);
    let before = Proof.checkArtifact(artifact);
    let offset = 16;
    let mutated = false;
    while (offset < artifact.length) {
      let words = artifact[offset] + artifact[offset + 1] * 256 + artifact[offset + 2] * 65536 + artifact[offset + 3] * 16777216;
      let tag = artifact[offset + 4] + artifact[offset + 5] * 256;
      if (tag === 24 && words > 3) {
        let top = offset + words * 4 - 4;
        artifact[top] = 0;
        artifact[top + 1] = 0;
        artifact[top + 2] = 0;
        artifact[top + 3] = 0;
        mutated = true;
        break;
      }
      offset = offset + words * 4;
    }
    let observed = [before, mutated, !Proof.checkArtifact(artifact)];
  `);
  assertEquals(session.get(0, "observed"), [true, true, true]);
});

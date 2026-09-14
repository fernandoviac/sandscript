import { assertEquals } from "https://deno.land/std@0.208.0/assert/mod.ts";
import {
  freshSession,
  restoreSession,
  snapshotSession,
} from "../../src/host-owned-session.js";
import { parseAndSetup } from "../fuel/test-helpers.js";

function evaluate(session, source) {
  parseAndSetup(session, source);
  let result = session.run(0, 100_000_000);
  while (result.status === "memory_pressure" || result.status === "paused") {
    if (result.status === "memory_pressure") session.gc();
    result = session.run(0, 100_000_000);
  }
  assertEquals(result.status, "done");
}

Deno.test("structured names distinguish segments, numeric components and anonymous declarations", () => {
  const session = freshSession();
  evaluate(session, `
    let prefix = Proof.Name.str(0, "Scope");
    let numeric = Proof.Name.num(prefix, 7);
    let string = Proof.Name.str(prefix, "7");
    let dotted = Proof.Name.str(0, "Scope.7");
    let env = Proof.assumption(Proof.Term.type(0), numeric);
    env = Proof.assumption(env, Proof.declarationType(env, 0), string);
    env = Proof.assumption(env, Proof.declarationType(env, 0), dotted);
    env = Proof.assumption(env, Proof.declarationType(env, 0));
    env = Proof.assumption(env, Proof.declarationType(env, 0), 0);
    let duplicateRejected = false;
    try {
      Proof.assumption(env, Proof.declarationType(env, 0),
        Proof.Name.num(Proof.Name.str(0, "Scope"), 7));
    } catch (error) { duplicateRejected = true; }
    let observed = [
      Proof.declarationIndex(env, numeric),
      Proof.declarationIndex(env, string),
      Proof.declarationIndex(env, dotted),
      Proof.declarationIndex(env, 0),
      Proof.declarationName(env, 3),
      Proof.declarationName(env, 4),
      duplicateRejected,
      Proof.declarationCount(env),
      Proof.checkArtifact(Proof.artifact(env)),
      Proof.Term.isTerm(numeric)
    ];
  `);
  assertEquals(session.get(0, "observed"), [0, 1, 2, -1, 0, 0, true, 5, true, false]);
});

Deno.test("structured declaration identities survive binary publication, collection and snapshot restore", () => {
  const session = freshSession();
  evaluate(session, `
    let originalName = Proof.Name.str(Proof.Name.num(0, 4294967295), "\u03bb\\u0000\ud83c\udf0c");
    let prop = Proof.Term.proposition();
    let statement = Proof.Term.product(prop,
      Proof.Term.product(Proof.Term.bound(0), Proof.Term.bound(1)));
    let body = Proof.Term.lambda(prop,
      Proof.Term.lambda(Proof.Term.bound(0), Proof.Term.bound(0)));
    let env = Proof.theorem(statement, body, originalName);
    let extractedName = Proof.declarationName(env, 0);
    let bytes = Proof.Theorem.artifact(env);
    let loaded = Proof.loadArtifact(bytes, 0);
    let before = [Proof.declarationIndex(loaded, extractedName), Proof.checkArtifact(bytes)];
  `);
  assertEquals(session.get(0, "before"), [0, true]);
  session.gc();
  const snapshot = snapshotSession(session);
  const restored = restoreSession(snapshot.vatBytes, snapshot.membraneBytes);
  evaluate(restored, `
    let equalName = Proof.Name.str(Proof.Name.num(0, 4294967295), "\u03bb\\u0000\ud83c\udf0c");
    let after = [
      Proof.declarationIndex(loaded, originalName),
      Proof.declarationIndex(loaded, extractedName),
      Proof.declarationIndex(loaded, equalName),
      Proof.declarationIndex(loaded, Proof.declarationName(loaded, 0)),
      Proof.checkArtifact(Proof.Theorem.artifact(loaded))
    ];
  `);
  assertEquals(restored.get(0, "after"), [0, 0, 0, 0, true]);
});

Deno.test("artifact rechecking rejects duplicate structured declaration identities", () => {
  const session = freshSession();
  evaluate(session, `
    let env = Proof.assumption(Proof.Term.type(0), Proof.Name.str(0, "First"));
    env = Proof.assumption(env, Proof.declarationType(env, 0), Proof.Name.str(0, "Second"));
    let bytes = Proof.artifact(env);
    function word(offset) {
      return bytes[offset] + bytes[offset + 1] * 256 +
        bytes[offset + 2] * 65536 + bytes[offset + 3] * 16777216;
    }
    function putWord(offset, value) {
      bytes[offset] = value & 255;
      bytes[offset + 1] = (value >>> 8) & 255;
      bytes[offset + 2] = (value >>> 16) & 255;
      bytes[offset + 3] = (value >>> 24) & 255;
    }
    let declarations = word(12);
    let first = word(declarations + 12);
    let second = word(declarations + 16);
    putWord(second + word(second) * 4 - 4, word(first + word(first) * 4 - 4));
    let rejected = !Proof.checkArtifact(bytes);
  `);
  assertEquals(session.get(0, "rejected"), true);
});

Deno.test("constructor and generated recursor names share the declaration collision domain", () => {
  const session = freshSession();
  evaluate(session, `
    let base = Proof.assumption(Proof.Term.type(0));
    let familyName = Proof.Name.str(0, "Box");
    let constructorName = Proof.Name.str(familyName, "mk");
    let box = Proof.inductive(base, Proof.Term.type(0),
      Proof.Term.sequence([Proof.Term.inductiveReference(1)]), 0,
      familyName, [constructorName]);
    let familyIndex = Proof.declarationIndex(box, familyName);
    let constructorCollision = false;
    let recursorCollision = false;
    try {
      Proof.assumption(box, Proof.declarationType(box, 0),
        Proof.constructorName(box, familyIndex, 0));
    } catch (error) { constructorCollision = true; }
    let recursorName = Proof.Name.str(familyName, "rec");
    try {
      Proof.assumption(box, Proof.declarationType(box, 0), recursorName);
    } catch (error) { recursorCollision = true; }
    let observed = [familyIndex, constructorCollision, recursorCollision,
      Proof.declarationIndex(box, recursorName) >= 0,
      Proof.checkArtifact(Proof.artifact(box))];
  `);
  assertEquals(session.get(0, "observed"), [1, true, true, true, true]);
});

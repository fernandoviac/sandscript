import { assertEquals } from "https://deno.land/std@0.208.0/assert/mod.ts";
import { freshSession, restoreSession, snapshotSession } from "../../src/host-owned-session.js";
import { parseAndSetup } from "../fuel/test-helpers.js";
import { runState } from "./state-helpers.js";

Deno.test("published proofs release checking workspace and survive collection and restore", () => {
  let session = freshSession({ heapSize: 1024 * 1024 });
  parseAndSetup(session, `
    let T = Proof.Term;
    let identity = T.lambda(T.proposition(), T.lambda(T.bound(0), T.bound(0)));
    let type = T.infer(identity);
    let held = [];
    for (let i = 0; i < 200; i++) held.push(T.check(identity, type));
  `);
  assertEquals(runState(session).status, "done");
  session.gc();
  const snapshot = snapshotSession(session);
  session = restoreSession(snapshot.vatBytes, snapshot.membraneBytes);
  parseAndSetup(session, `
    let first = Proof.definition(type, held[0]);
    let last = Proof.definition(type, held[199]);
    let observed = [held.length, Proof.checkArtifact(Proof.artifact(first)),
      Proof.checkArtifact(Proof.artifact(last))];
  `);
  assertEquals(runState(session).status, "done");
  assertEquals(session.get(0, "observed"), [200, true, true]);
});

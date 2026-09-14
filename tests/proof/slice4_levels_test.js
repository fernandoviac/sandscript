import { assertEquals } from "https://deno.land/std@0.208.0/assert/mod.ts";
import {
  freshSession,
  restoreSession,
  snapshotSession,
} from "../../src/host-owned-session.js";
import { parseAndSetup } from "../fuel/test-helpers.js";

const prelude = `
  let T = Proof.Term;
  let L = Proof.Level;
  function rejected(f) {
    try { f(); } catch (error) { return true; }
    return false;
  }
  function checks(term, type) {
    return !rejected(function() { T.check(term, type); });
  }
`;

function finish(session) {
  let result;
  do {
    result = session.run(0, 10_000_000);
    if (result.status === "memory_pressure") session.gc();
  } while (result.status === "paused" || result.status === "memory_pressure");
  assertEquals(result.status, "done");
  return session;
}

function run(source) {
  const session = freshSession({ heapSize: 16 * 1024 * 1024 });
  parseAndSetup(session, prelude + source);
  return finish(session);
}

Deno.test("Slice 4 Sort levels are exact and never cumulative or self-typed", () => {
  const session = run(`
    let prop = T.proposition();
    let zero = T.sort(0);
    let one = T.sort(L.successor(0));
    let observed = [
      checks(prop, T.type(0)),
      checks(zero, one),
      checks(T.type(0), T.type(1)),
      rejected(function() { T.check(zero, zero); }),
      rejected(function() { T.check(one, one); }),
      rejected(function() { T.check(zero, T.type(1)); }),
      rejected(function() { T.sort(-1); }),
      rejected(function() { L.successor(-1); }),
      rejected(function() { L.maximum(0, 0.5); }),
      rejected(function() { T.type(4294967296); })
    ];
  `);
  assertEquals(session.get(0, "observed"), Array(10).fill(true));
});

Deno.test("Slice 4 imax keeps a possibly-zero parameter conditional through generalization", () => {
  const session = run(`
    let env = Proof.universes(["unused", "u", "v"], function(levels) {
      return Proof.assumption(T.sort(L.imax(levels.u, levels.v)));
    });
    let zeroInstance = T.global(env, 0, 5, 0);
    let positiveInstance = T.global(env, 0, 5, 2);
    let observed = [
      Proof.checkArtifact(Proof.artifact(env)),
      checks(zeroInstance, T.proposition()),
      checks(positiveInstance, T.sort(5)),
      rejected(function() { T.check(zeroInstance, T.sort(5)); }),
      rejected(function() { T.check(positiveInstance, T.sort(2)); }),
      rejected(function() { T.infer(T.global(env, 0, 5)); })
    ];
  `);
  assertEquals(session.get(0, "observed"), Array(6).fill(true));
});

Deno.test("Slice 4 max normalization handles association, duplicate bases and successor distribution", () => {
  const session = run(`
    let env = Proof.universes(["u", "v"], function(levels) {
      let u = levels.u;
      let v = levels.v;
      let left = L.successor(L.maximum(u, L.maximum(v, u)));
      let right = L.maximum(L.successor(v), L.successor(u));
      let domain = T.sort(left);
      let target = T.sort(right);
      return Proof.definition(T.product(domain, target), T.lambda(domain, T.bound(0)));
    });
    let absorbed = Proof.universes(["u"], function(levels) {
      let left = T.sort(L.maximum(2, L.successor(L.successor(levels.u))));
      let right = T.sort(L.successor(L.successor(levels.u)));
      return Proof.definition(T.product(left, right), T.lambda(left, T.bound(0)));
    });
    let observed = [Proof.checkArtifact(Proof.artifact(env)),
      Proof.checkArtifact(Proof.artifact(absorbed))];
  `);
  assertEquals(session.get(0, "observed"), [true, true]);
});

Deno.test("Slice 4 product formation uses imax rather than maximum", () => {
  const session = run(`
    let env = Proof.universes(["u"], function(levels) {
      let U = T.sort(levels.u);
      let product = T.product(U, T.bound(0));
      let expected = T.sort(L.imax(L.successor(levels.u), levels.u));
      return Proof.definition(expected, product);
    });
    let observed = [Proof.checkArtifact(Proof.artifact(env)),
      checks(T.global(env, 0, 0), T.proposition()),
      checks(T.global(env, 0, 2), T.sort(3))];
  `);
  assertEquals(session.get(0, "observed"), [true, true, true]);
});

Deno.test("Slice 4 artifact validation rejects forged universe nodes and scope bounds", () => {
  const session = run(`
    let env = Proof.universes(["u"], function(levels) {
      return Proof.assumption(T.type(levels.u));
    });
    let original = Proof.artifact(env);
    function word(bytes, offset) {
      return bytes[offset] + bytes[offset + 1] * 256 +
        bytes[offset + 2] * 65536 + bytes[offset + 3] * 16777216;
    }
    function put(bytes, offset, value) {
      for (let i = 0; i < 4; i = i + 1) {
        bytes[offset + i] = value % 256;
        value = Math.floor(value / 256);
      }
    }
    function mutate(kind) {
      let bytes = Proof.artifact(env);
      let parameter = 0;
      let successor = 0;
      let sort = 0;
      for (let p = 16; p < bytes.length; p = p + word(bytes, p) * 4) {
        let tag = word(bytes, p + 4);
        if (tag === 257 && word(bytes, p + 8) === 1) parameter = p;
        if (tag === 257 && word(bytes, p + 8) === 2) successor = p;
        if (tag === 1) sort = p;
      }
      if (kind === 0) put(bytes, parameter + 12, 1);
      if (kind === 1) put(bytes, successor + 12, successor);
      if (kind === 2) put(bytes, successor + 12, sort);
      if (kind === 3) put(bytes, parameter + 8, 4);
      if (kind === 4) put(bytes, sort + 8, 0);
      if (kind === 5) put(bytes, sort + 8, sort);
      return !Proof.checkArtifact(bytes);
    }
    let observed = [Proof.checkArtifact(original), mutate(0), mutate(1),
      mutate(2), mutate(3), mutate(4), mutate(5), Proof.checkArtifact(original)];
  `);
  assertEquals(session.get(0, "observed"), Array(8).fill(true));
});

Deno.test("Slice 4 scoped Level ownership survives callback GC and snapshot, then expires", () => {
  const source = prelude + `
    let callbackCount = 0;
    let checkpoint = false;
    let escapedLevel;
    let escapedSort;
    let env = Proof.universes(["u", "v"], function(levels) {
      callbackCount = callbackCount + 1;
      escapedLevel = L.imax(L.successor(levels.u), levels.v);
      escapedSort = T.sort(escapedLevel);
      checkpoint = true;
      let counter = 0;
      while (counter < 1000) counter = counter + 1;
      let composed = L.maximum(escapedLevel, levels.v);
      return Proof.assumption(T.sort(composed));
    });
    let observed = [callbackCount, Proof.checkArtifact(Proof.artifact(env)),
      checks(T.global(env, 0, 2, 0), T.proposition()),
      rejected(function() { L.successor(escapedLevel); }),
      rejected(function() { T.type(escapedLevel); }),
      rejected(function() { T.product(escapedSort, T.proposition()); })];
  `;
  const session = freshSession({ heapSize: 16 * 1024 * 1024 });
  parseAndSetup(session, source);
  let result;
  do {
    result = session.run(0, 20);
    assertEquals(result.status, "paused");
  } while (session.get(0, "checkpoint") !== true);
  session.gc();
  const snapshot = snapshotSession(session);
  const restored = restoreSession(snapshot.vatBytes, snapshot.membraneBytes);
  finish(restored);
  assertEquals(restored.get(0, "observed"), [1, true, true, true, true, true]);
});

Deno.test("Slice 4 generalization preserves imported and generated declaration-local scopes", () => {
  const session = run(`
    let base = Proof.universes(["original"], function(levels) {
      return Proof.assumption(T.sort(levels.original));
    });
    let extended = Proof.universes(["unused", "used"], function(levels) {
      return Proof.assumption(base, T.sort(levels.used));
    });
    let emptyBase = Proof.assumption(T.proposition());
    let empty = Proof.universes(["unused"], function() {
      return Proof.inductive(emptyBase, T.type(0), T.sequence([]), 0);
    });
    let recursor = T.recursor(empty, 1, 0);
    let observed = [Proof.checkArtifact(Proof.artifact(extended)),
      checks(T.global(extended, 0, 4), T.sort(4)),
      checks(T.global(extended, 1, 3), T.sort(3)),
      Proof.checkArtifact(Proof.artifact(empty)),
      checks(recursor, T.infer(recursor)),
      rejected(function() { T.infer(T.recursor(empty, 1, 0, 1)); })];
  `);
  assertEquals(session.get(0, "observed"), Array(6).fill(true));
});

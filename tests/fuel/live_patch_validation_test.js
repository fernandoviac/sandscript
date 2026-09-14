import {
  assert,
  assertEquals,
} from "https://deno.land/std@0.208.0/assert/mod.ts";
import {
  freshSession,
  restoreSession,
  snapshotSession,
} from "../../src/host-owned-session.js";
import { diffNewSource } from "../../src/fuel/code-diff.js";
import { auditLiveReferences } from "../../src/fuel/patch-audit.js";
import { applyPatch, retargetClosures } from "../../src/fuel/patch-apply.js";
import { parseAndRun } from "./test-helpers.js";

function patchSession(liveSession, source, options = {}) {
  const { vatBytes, membraneBytes } = snapshotSession(liveSession);
  const scratchSession = restoreSession(vatBytes, membraneBytes);
  scratchSession.gc();
  const diff = diffNewSource(scratchSession, source);
  assert(!diff.parseFailed, "validation patch source must parse");
  const audit = auditLiveReferences(
    scratchSession.mem,
    scratchSession.airlock.membrane,
    diff,
  );
  const report = applyPatch(scratchSession, diff, audit, options);
  if (report.retarget?.deferred && report.migration?.slot !== null) {
    let status = report.migration.status;
    while (status !== "done") {
      if (status === "memory_pressure") scratchSession.gc();
      const result = scratchSession.run(report.migration.slot, 1_000_000);
      status = result.status;
    }
    scratchSession.mem.freeContext(report.migration.slot);
    report.migration.slot = null;
    report.migration.status = "done";
    report.retarget = retargetClosures(scratchSession, diff, audit);
  }
  return { session: scratchSession, diff, audit, report };
}

const adversarialChanges = [
  {
    name: "free-variable capture",
    oldSource: "let outer = 1; function target(value) { return value + outer; }",
    newSource: "let outer = 1; let other = 2; function target(value) { return value + other; }",
  },
  {
    name: "sync to async",
    oldSource: "function target(value) { return value + 1; }",
    newSource: "async function target(value) { return value + 1; }",
  },
  {
    name: "ordinary to arrow",
    oldSource: "function target(value) { return value + 1; }",
    newSource: "const target = (value) => value + 1;",
  },
  {
    name: "destructuring binding edit",
    oldSource: "let { value: left } = { value: 1 }; function target() { return left; }",
    newSource: "let { value: right } = { value: 1 }; function target() { return right; }",
  },
  {
    name: "deeply nested closure",
    oldSource: "function target() { function middle() { function inner() { return 1; } return inner; } return middle; }",
    newSource: "function target() { function middle() { function inner() { return 2; } return inner; } return middle; }",
  },
  {
    name: "temporal-dead-zone-sensitive reorder",
    oldSource: "function first() { return second(); } function second() { return 1; }",
    newSource: "function second() { return 1; } function first() { return second(); }",
  },
];

Deno.test("live patch P1: adversarial semantic edits never produce an all-identical diff", () => {
  for (const scenario of adversarialChanges) {
    const liveSession = freshSession({ inlineSource: true });
    parseAndRun(liveSession, scenario.oldSource);
    const { vatBytes, membraneBytes } = snapshotSession(liveSession);
    const scratchSession = restoreSession(vatBytes, membraneBytes);
    const diff = diffNewSource(scratchSession, scenario.newSource);
    assert(!diff.parseFailed, `${scenario.name}: source failed to parse`);
    assert(
      diff.units.some((unit) => unit.verdict !== "identical"),
      `${scenario.name}: semantic edit was classified entirely identical`,
    );
  }
});

Deno.test("live patch P2/P4: a membrane-only callback is audited and retargeted", () => {
  const liveSession = freshSession({ inlineSource: true });
  parseAndRun(liveSession, "function callback(value) { return value + 1; }");
  const closure = liveSession.getExact(0, "callback");
  liveSession.airlock.registerClosure(closure._dataLo, 0);

  const { session, audit, report } = patchSession(
    liveSession,
    "function callback(value) { return value + 10; }",
  );
  const finding = audit.unitFindings.find((entry) => entry.name === "callback");
  assert(finding, "membrane-held callback was absent from the audit");
  assert(
    finding.closures.some((closureFinding) =>
      closureFinding.membraneSlots.length > 0
    ),
    "audit omitted callback membrane slots",
  );
  assert(
    report.retarget.retargeted.some((entry) => entry.name === "callback"),
    "membrane-held callback was not retargeted",
  );
  parseAndRun(session, "let callbackResult = callback(2);");
  assertEquals(session.get(0, "callbackResult"), 12);
});

Deno.test("live patch P3: runtime-mutated let survives while changed const reruns", () => {
  const liveSession = freshSession({ inlineSource: true });
  parseAndRun(liveSession, "let mutable = 1; const derived = 10;");
  parseAndRun(liveSession, "mutable = 99;");

  const { session, report } = patchSession(
    liveSession,
    "let mutable = 2; const derived = 20;",
  );
  assertEquals(session.get(0, "mutable"), 99);
  assertEquals(session.get(0, "derived"), 20);
  assert(
    report.reported.some((entry) => entry.names.includes("mutable")),
    "preserved changed let was not reported",
  );
});

Deno.test("live patch P7: five successive patches equal one cumulative patch and a fresh compile", () => {
  const versionSource = (increment) => `
    let state = 0;
    function advance(value) { state = state + ${increment}; return value + state; }
  `;
  let chainedSession = freshSession({ inlineSource: true });
  parseAndRun(chainedSession, versionSource(1));
  parseAndRun(chainedSession, "let beforePatches = advance(0);");

  for (let increment = 2; increment <= 6; increment++) {
    chainedSession = patchSession(chainedSession, versionSource(increment)).session;
  }
  parseAndRun(chainedSession, "let chainedResult = advance(10);");

  const onePatchLive = freshSession({ inlineSource: true });
  parseAndRun(onePatchLive, versionSource(1));
  parseAndRun(onePatchLive, "let beforePatches = advance(0);");
  const onePatchSession = patchSession(onePatchLive, versionSource(6)).session;
  parseAndRun(onePatchSession, "let onePatchResult = advance(10);");

  const freshSessionAtLatest = freshSession({ inlineSource: true });
  parseAndRun(freshSessionAtLatest, versionSource(6));
  parseAndRun(freshSessionAtLatest, "state = 1; let freshResult = advance(10);");

  assertEquals(chainedSession.get(0, "chainedResult"), 17);
  assertEquals(onePatchSession.get(0, "onePatchResult"), 17);
  assertEquals(freshSessionAtLatest.get(0, "freshResult"), 17);

  const chainedBytes = snapshotSession(chainedSession).vatBytes.byteLength;
  const onePatchBytes = snapshotSession(onePatchSession).vatBytes.byteLength;
  assertEquals(chainedBytes, onePatchBytes, "patch history changed fixed vat image size");
});

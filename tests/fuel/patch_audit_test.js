/**
 * Live-state audit for live code patching.
 *
 * Flow under test: drive a live session into a known state (including
 * fuel-exhaustion parks mid-function), snapshot → restore a scratch,
 * gc() the scratch (the documented precondition), diffNewSource, then
 * auditLiveReferences and assert tier classifications.
 */
import { assert, assertEquals } from "https://deno.land/std@0.208.0/assert/mod.ts";
import { freshSession, restoreSession, snapshotSession } from '../../src/host-owned-session.js';
import { parseAndRun, parseAndSetup } from './test-helpers.js';
import { diffNewSource } from '../../src/fuel/code-diff.js';
import { auditLiveReferences } from '../../src/fuel/patch-audit.js';

function scratchFrom(liveSession) {
  const { vatBytes, membraneBytes } = snapshotSession(liveSession);
  return restoreSession(vatBytes, membraneBytes);
}

function auditAgainst(liveSession, newSource, { gcFirst = true } = {}) {
  const scratch = scratchFrom(liveSession);
  if (gcFirst) scratch.gc();
  const diff = diffNewSource(scratch, newSource);
  assert(!diff.parseFailed);
  const audit = auditLiveReferences(scratch.mem, scratch.airlock.membrane, diff);
  return { scratch, diff, audit };
}

function findingByName(audit, name) {
  const matches = audit.unitFindings.filter((f) => f.name === name);
  assertEquals(matches.length, 1, `expected one finding named ${name}`);
  return matches[0];
}

function kinds(finding) {
  return new Set(finding.activeReferences.map((r) => r.kind));
}

Deno.test('changed function never referenced is trivial', () => {
  const live = freshSession();
  parseAndRun(live, `function helper(v) { return v + 1; }`);
  // Defined but never called, never stored — the binding itself holds
  // a closure though! `function helper` runs MAKE_CLOSURE + LET_VAR,
  // so a closure exists in the root scope. Truly trivial needs the
  // function to never have been DEFINED by execution: parse it but
  // park execution before the declaration runs.
  const { audit } = auditAgainst(live, `function helper(v) { return v + 2; }`);
  // The toplevel ran, so helper's closure exists → rewire, not
  // trivial. The genuinely-trivial case is a changed function whose
  // declaration never executed:
  const live2 = freshSession();
  live2.parse(`function never(v) { return v + 1; }`);
  // No run — no closure was created.
  const result2 = auditAgainst(live2, `function never(v) { return v + 2; }`);
  assertEquals(findingByName(result2.audit, 'never').tier, 'trivial');
  // And the executed-declaration case really is rewire:
  assertEquals(findingByName(audit, 'helper').tier, 'rewire');
});

Deno.test('scope-bound closure also stored in an array: one closure entry', () => {
  const live = freshSession();
  parseAndRun(live, `
    function job(v) { return v * 2; }
    let queue = [job, job];
  `);
  const { audit } = auditAgainst(live, `
    function job(v) { return v * 3; }
    let queue = [job, job];
  `);
  const job = findingByName(audit, 'job');
  assertEquals(job.tier, 'rewire');
  // One heap closure object, regardless of how many holders.
  assertEquals(job.closures.length, 1);
  assertEquals(job.activeReferences.length, 0);
});

Deno.test('membrane closure handle slots are joined onto the closure finding', () => {
  const live = freshSession();
  parseAndRun(live, `function callback(v) { return v + 10; }`);
  const closureValue = live.getExact(0, 'callback');
  live.airlock.registerClosure(closureValue._dataLo, 0);

  const { audit } = auditAgainst(live, `function callback(v) { return v + 20; }`);
  const callback = findingByName(audit, 'callback');
  assertEquals(callback.tier, 'rewire');
  assertEquals(callback.closures.length, 1);
  assertEquals(callback.closures[0].membraneSlots.length, 1);
});

Deno.test('fuel-parked mid-function: active with kind pc', () => {
  const live = freshSession();
  parseAndSetup(live, `
    function spin() {
      let i = 0;
      while (i < 1000000) { i = i + 1; }
      return i;
    }
    let r = spin();
  `);
  const result = live.run(0, 500);
  assertEquals(result.status, 'paused');

  const { audit } = auditAgainst(live, `
    function spin() {
      let i = 0;
      while (i < 1000000) { i = i + 2; }
      return i;
    }
    let r = spin();
  `);
  const spin = findingByName(audit, 'spin');
  assertEquals(spin.tier, 'active');
  assert(kinds(spin).has('pc'));
});

Deno.test('parked in a callee: changed caller is active via returnAddress', () => {
  const live = freshSession();
  parseAndSetup(live, `
    function inner() {
      let i = 0;
      while (i < 1000000) { i = i + 1; }
      return i;
    }
    function outer() {
      let v = inner();
      return v + 1;
    }
    let r = outer();
  `);
  const result = live.run(0, 500);
  assertEquals(result.status, 'paused');

  // Only outer's body changes; inner is identical.
  const { audit } = auditAgainst(live, `
    function inner() {
      let i = 0;
      while (i < 1000000) { i = i + 1; }
      return i;
    }
    function outer() {
      let v = inner();
      return v + 2;
    }
    let r = outer();
  `);
  const outer = findingByName(audit, 'outer');
  assertEquals(outer.tier, 'active');
  assert(kinds(outer).has('returnAddress'));
  // inner is identical — it must not appear in the findings at all.
  assertEquals(audit.unitFindings.filter((f) => f.name === 'inner').length, 0);
});

Deno.test('parked inside try: catch target is an active reference', () => {
  const live = freshSession();
  parseAndSetup(live, `
    function risky() {
      try {
        let i = 0;
        while (i < 1000000) { i = i + 1; }
        return i;
      } catch (e) {
        return -1;
      }
    }
    let r = risky();
  `);
  const result = live.run(0, 500);
  assertEquals(result.status, 'paused');

  const { audit } = auditAgainst(live, `
    function risky() {
      try {
        let i = 0;
        while (i < 1000000) { i = i + 1; }
        return i;
      } catch (e) {
        return -2;
      }
    }
    let r = risky();
  `);
  const risky = findingByName(audit, 'risky');
  assertEquals(risky.tier, 'active');
  assert(kinds(risky).has('catch'));
  assert(kinds(risky).has('pc'));
});

Deno.test('parked inside an approved grant block: denied target is active', () => {
  const live = freshSession();
  live.airlock.onGrantRequest = (identifier) => {
    const grant = live.airlock.membrane.createGrant(identifier);
    return { approved: true, grant };
  };
  parseAndSetup(live, `
    function guarded() {
      let total = 0;
      grant ("cap") {
        let i = 0;
        while (i < 1000000) { i = i + 1; }
        total = i;
      } denied (revoked) {
        total = -1;
      }
      return total;
    }
    let r = guarded();
  `);
  const result = live.run(0, 800);
  assertEquals(result.status, 'paused');

  const { audit } = auditAgainst(live, `
    function guarded() {
      let total = 0;
      grant ("cap") {
        let i = 0;
        while (i < 1000000) { i = i + 1; }
        total = i;
      } denied (revoked) {
        total = -2;
      }
      return total;
    }
    let r = guarded();
  `);
  const guarded = findingByName(audit, 'guarded');
  assertEquals(guarded.tier, 'active');
  assert(kinds(guarded).has('denied'));
});

Deno.test('fuel-parked mid-map(): nativeContinuationCallback finding on the callback unit', () => {
  const live = freshSession();
  parseAndSetup(live, `
    function each(v) {
      let i = 0;
      while (i < 1000000) { i = i + 1; }
      return v + i;
    }
    let out = [1, 2, 3].map(each);
  `);
  const result = live.run(0, 800);
  assertEquals(result.status, 'paused');

  const { audit } = auditAgainst(live, `
    function each(v) {
      let i = 0;
      while (i < 1000000) { i = i + 1; }
      return v + i + 1;
    }
    let out = [1, 2, 3].map(each);
  `);
  const each = findingByName(audit, 'each');
  assertEquals(each.tier, 'active');
  assert(kinds(each).has('nativeContinuationCallback'));
});

Deno.test('dead closure: rewire without gc, trivial with the documented gc-first recipe', () => {
  const live = freshSession();
  // Anonymous function assigned then dropped — the closure is dead on
  // the heap. (Unit name is 't': name recovery reads the LET_VAR that
  // follows the body.)
  parseAndRun(live, `
    let t = function (v) { return v + 7; };
    t = 0;
  `);
  const newSource = `
    let t = function (v) { return v + 8; };
    t = 0;
  `;
  // Without the gc precondition the dead closure forces rewire.
  const withoutGc = auditAgainst(live, newSource, { gcFirst: false });
  assertEquals(findingByName(withoutGc.audit, 't').tier, 'rewire');
  // With the documented recipe it was collected first.
  const withGc = auditAgainst(live, newSource);
  assertEquals(findingByName(withGc.audit, 't').tier, 'trivial');
});

Deno.test('removed unit with a live closure is audited like a changed one', () => {
  const live = freshSession();
  parseAndRun(live, `function sendReport(d) { return d; }`);
  const { audit } = auditAgainst(live, `function submitReport(d) { return d; }`);
  const removed = findingByName(audit, 'sendReport');
  assertEquals(removed.verdict, 'removed');
  assertEquals(removed.tier, 'rewire');
  // The added unit has no old code — it is not audited.
  assertEquals(audit.unitFindings.filter((f) => f.name === 'submitReport').length, 0);
});

Deno.test('audit is read-only on the scratch vat', () => {
  const live = freshSession();
  parseAndRun(live, `function f(v) { return v + 1; } let r = f(1);`);
  const scratch = scratchFrom(live);
  scratch.gc();
  const diff = diffNewSource(scratch, `function f(v) { return v + 2; }`);

  const before = snapshotSession(scratch).vatBytes;
  auditLiveReferences(scratch.mem, scratch.airlock.membrane, diff);
  const after = snapshotSession(scratch).vatBytes;

  let firstDifference = -1;
  for (let i = 0; i < before.length; i++) {
    if (before[i] !== after[i]) { firstDifference = i; break; }
  }
  assertEquals(firstDifference, -1);
});

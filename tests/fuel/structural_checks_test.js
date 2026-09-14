/**
 * Structural correctness checks (findStructuralIssues) — unreachable code,
 * const-reassignment, undefined-variable-read, unused-binding. All four
 * share one scope-table walker; tests filter to the rule under test since
 * a test fixture can innocently trigger findings from other rules too
 * (e.g. an unread `let` used as filler for an unreachable-code test).
 */

import { assertEquals, assertThrows } from "https://deno.land/std@0.208.0/assert/mod.ts";
import { findStructuralIssues, findStructuralIssuesInSession, hasBlockingFindings } from '../../src/fuel/structural-checks.js';
import { freshSession } from '../../src/host-owned-session.js';

// Findings for one rule only, ignoring noise from the other three checks
// (e.g. an unread `let` used as filler in an unreachable-code fixture).
function findingsOf(rule, source, options) {
  return findStructuralIssues(source, options).findings.filter(f => f.rule === rule);
}

// =============================================================================
// unreachable-code
// =============================================================================

Deno.test("unreachable-code: statement after return in a function body", () => {
  const findings = findingsOf('unreachable-code', "function f() {\n  return 1\n  let x = 2\n}\n");
  assertEquals(findings.length, 1);
  assertEquals(findings[0].line, 3);
});

Deno.test("unreachable-code: statement after break in a loop", () => {
  const findings = findingsOf('unreachable-code', "while (true) {\n  break\n  let x = 1\n}\n");
  assertEquals(findings.length, 1);
  assertEquals(findings[0].line, 3);
});

Deno.test("unreachable-code: statement after continue in a loop", () => {
  const findings = findingsOf('unreachable-code', "while (true) {\n  continue\n  let x = 1\n}\n");
  assertEquals(findings.length, 1);
});

Deno.test("unreachable-code: statement after throw", () => {
  const findings = findingsOf('unreachable-code', "function f() {\n  throw 'x'\n  let x = 1\n}\n");
  assertEquals(findings.length, 1);
});

Deno.test("unreachable-code: no finding for clean code", () => {
  assertEquals(findingsOf('unreachable-code', "let x = 1\nlet y = x\n"), []);
});

Deno.test("unreachable-code: no finding when only one branch of if/else terminates", () => {
  assertEquals(findingsOf('unreachable-code',
    "let y = 0\nif (true) {\n  return 1\n} else {\n  y = 2\n}\n"), []);
});

Deno.test("unreachable-code: nested block's terminator does not affect outer block", () => {
  assertEquals(findingsOf('unreachable-code',
    "function f() {\n  if (true) {\n    return 1\n  }\n  return 2\n}\n"), []);
});

Deno.test("unreachable-code: return with no trailing statement is not flagged", () => {
  assertEquals(findingsOf('unreachable-code', "function f() {\n  return 1\n}\n"), []);
});

Deno.test("unreachable-code: only one finding per block even with multiple trailing statements", () => {
  const findings = findingsOf('unreachable-code',
    "function f() {\n  return 1\n  let x = 2\n  let y = 3\n}\n");
  assertEquals(findings.length, 1);
});

// =============================================================================
// const-reassignment
// =============================================================================

Deno.test("const-reassignment: plain assignment to const", () => {
  const findings = findingsOf('const-reassignment', "const x = 1\nx = 2\n");
  assertEquals(findings.length, 1);
  assertEquals(findings[0].line, 2);
});

Deno.test("const-reassignment: ++/-- on const", () => {
  assertEquals(findingsOf('const-reassignment', "const x = 1\nx++\n").length, 1);
  assertEquals(findingsOf('const-reassignment', "const x = 1\n--x\n").length, 1);
});

Deno.test("const-reassignment: compound assignment on const", () => {
  assertEquals(findingsOf('const-reassignment', "const x = 1\nx += 2\n").length, 1);
});

Deno.test("const-reassignment: let reassignment is fine", () => {
  assertEquals(findingsOf('const-reassignment', "let x = 1\nx = 2\n"), []);
});

Deno.test("const-reassignment: for-loop counter (let) reassignment is fine", () => {
  assertEquals(findingsOf('const-reassignment', "for (let i = 0; i < 3; i++) {}\n"), []);
});

Deno.test("const-reassignment: property write on a const object is not a binding write", () => {
  assertEquals(findingsOf('const-reassignment', "const obj = { a: 1 }\nobj.a = 2\n"), []);
});

Deno.test("const-reassignment: function param shadowing an outer const may be reassigned", () => {
  assertEquals(findingsOf('const-reassignment',
    "const x = 1\nfunction f(x) {\n  x = 2\n}\n"), []);
});

// =============================================================================
// undefined-variable
// =============================================================================

Deno.test("undefined-variable: read of an undeclared name", () => {
  const findings = findingsOf('undefined-variable', "let x = undeclaredThing\n");
  assertEquals(findings.length, 1);
  assertEquals(findings[0].line, 1);
});

Deno.test("undefined-variable: core builtins are not flagged", () => {
  assertEquals(findingsOf('undefined-variable',
    'let x = Math.sqrt(4)\nlet y = JSON.stringify(x)\n'), []);
});

Deno.test("undefined-variable: closures reading an outer binding are fine", () => {
  assertEquals(findingsOf('undefined-variable',
    "let x = 1\nfunction f() {\n  return x\n}\n"), []);
});

Deno.test("undefined-variable: class names, member names, and method bodies use their correct scopes", () => {
  const source = `
    class Panel extends HTMLElement {
      static observedAttributes = ["status"];
      constructor() {
        super();
        this.value = document.createElement("span");
      }
      connectedCallback() {
        customElements.get(Panel);
      }
    }
    customElements.define("scope-panel", Panel);
  `;
  assertEquals(findingsOf("undefined-variable", source, {
    extraGlobals: ["HTMLElement", "document", "customElements"],
  }), []);
});

Deno.test("undefined-variable: a named function expression can reference its own binding from inside its body", () => {
  // Real, common idiom (self-removing event listener; plain recursion):
  // the function body doesn't run until well after `let name = ...`
  // The walk visits a recursive listener's body while its initializer is
  // still being checked; that self-reference becomes valid when initialization
  // completes.
  assertEquals(findingsOf('undefined-variable',
    "let f = (n) => {\n  if (n > 0) {\n    return f(n - 1)\n  }\n  return 0\n}\nf(3)\n"), []);
  assertEquals(findingsOf('undefined-variable',
    "function outer() {\n  let listener = (e) => {\n    listener()\n  }\n  return listener\n}\n"), []);
});

Deno.test("undefined-variable: a plain (non-function) self-referencing initializer still resolves to its own binding, not an outer shadow", () => {
  // `let x = x` reads the newly-declared x (not a same-named outer one) —
  // matches TDZ intuition (you can't read a variable's own prior value
  // while initializing it) and means the read counts as a use, so `x`
  // isn't ALSO reported as an unused binding.
  const findings = findStructuralIssues("let x = 1\n{\n  let x = x\n}\n").findings;
  assertEquals(findings.filter(f => f.rule === 'undefined-variable'), []);
});

Deno.test("undefined-variable: function params are visible in the body", () => {
  assertEquals(findingsOf('undefined-variable', "function f(x) {\n  return x + 1\n}\n"), []);
});

Deno.test("undefined-variable: array/object destructuring targets are declared, not reads", () => {
  assertEquals(findingsOf('undefined-variable', "let [a, b] = [1, 2]\nlet c = a + b\n"), []);
  assertEquals(findingsOf('undefined-variable',
    "let { a, b } = { a: 1, b: 2 }\nlet c = a + b\n"), []);
});

Deno.test("undefined-variable: object literal non-computed keys are not reads", () => {
  assertEquals(findingsOf('undefined-variable', 'let obj = { a: 1, b: 2 }\n'), []);
});

Deno.test("undefined-variable: object literal computed keys ARE reads", () => {
  assertEquals(findingsOf('undefined-variable', 'let key = "a"\nlet obj = { [key]: 1 }\n'), []);
  assertEquals(findingsOf('undefined-variable', 'let obj = { [undeclaredKey]: 1 }\n').length, 1);
});

Deno.test("undefined-variable: shorthand property is a real read", () => {
  assertEquals(findingsOf('undefined-variable', "let a = 1\nlet obj = { a }\n"), []);
  assertEquals(findingsOf('undefined-variable', "let obj = { a }\n").length, 1);
});

Deno.test("undefined-variable: renamed destructuring key is not a read", () => {
  assertEquals(findingsOf('undefined-variable',
    "let obj = { a: 1 }\nlet { a: renamed } = obj\nlet c = renamed\n"), []);
});

Deno.test("undefined-variable: catch parameter is visible in the catch block", () => {
  assertEquals(findingsOf('undefined-variable',
    "try {\n  throw 1\n} catch (e) {\n  let x = e\n}\n"), []);
});

Deno.test("undefined-variable: grant capability string is not a read", () => {
  assertEquals(findingsOf('undefined-variable', 'grant "time" {\n  let x = 1\n}\n'), []);
});

Deno.test("undefined-variable: grant with a variable identifier reads that variable", () => {
  assertEquals(findingsOf('undefined-variable',
    'let capName = "time"\ngrant (capName) {\n  let x = 1\n}\n'), []);
  assertEquals(findingsOf('undefined-variable',
    'grant (undeclaredCapName) {\n  let x = 1\n}\n').length, 1);
});

Deno.test("undefined-variable: a top-level let can forward-reference a later sibling let/function in the same block", () => {
  // A family of mutually-referencing top-level functions may call a later
  // sibling from inside a body. No body runs until the whole block has
  // declared every binding, so the references are valid at execution time.
  assertEquals(findingsOf('undefined-variable',
    "let a = (x) => {\n  return b(x)\n}\nlet b = (x) => {\n  return x + 1\n}\na(1)\n"), []);
});

Deno.test("undefined-variable: three-way mutual forward reference among top-level function bindings", () => {
  const source = `
    let layoutInfixOperator = (node) => {
      return layoutExpression(node)
    }
    let layoutExpression = (node) => {
      return layoutFunction(node)
    }
    let layoutFunction = (node) => {
      return layoutInfixOperator(node)
    }
    layoutInfixOperator(1)
  `;
  assertEquals(findingsOf('undefined-variable', source), []);
});

Deno.test("undefined-variable: forward reference exemption does not extend into a later sibling's own local scope", () => {
  // `helper` calls `later` (a sibling top-level binding) — fine, forward
  // reference to a shared-block name. But `later`'s body reads
  // `localOnly`, which is declared INSIDE a different, earlier function's
  // own body — that name never enters the shared block scope, so it must
  // still be reported as undefined even though it appears earlier in the
  // source.
  const source = `
    let helper = (x) => {
      function inner() {
        let localOnly = 1
        return localOnly
      }
      return later(x) + inner()
    }
    let later = (x) => {
      return localOnly
    }
    helper(1)
  `;
  const findings = findingsOf('undefined-variable', source);
  assertEquals(findings.length, 1);
  assertEquals(findings[0].message.includes("'localOnly'"), true);
});

Deno.test("undefined-variable: for-of/for-in bindings are visible in the body", () => {
  assertEquals(findingsOf('undefined-variable',
    "let arr = [1, 2, 3]\nfor (const v of arr) {\n  let x = v\n}\n"), []);
});

Deno.test("undefined-variable: extraGlobals option treats extra names as defined", () => {
  assertEquals(findingsOf('undefined-variable', "let x = setTimeout\n").length, 1);
  assertEquals(
    findingsOf('undefined-variable', "let x = setTimeout\n", { extraGlobals: ['setTimeout'] }),
    []);
});

Deno.test("undefined-variable: session option reflects a live session's root scope", () => {
  const session = freshSession();
  session.mem.declareExternal('customCapabilityGlobal', 0, 0);
  assertEquals(
    findingsOf('undefined-variable', "let x = customCapabilityGlobal\n").length,
    1);
  assertEquals(
    findingsOf('undefined-variable', "let x = customCapabilityGlobal\n", { session }),
    []);
});

// =============================================================================
// unused-binding
// =============================================================================

Deno.test("unused-binding: top-level let never read", () => {
  const findings = findingsOf('unused-binding', "let x = 1\n");
  assertEquals(findings.length, 1);
  assertEquals(findings[0].line, 1);
});

Deno.test("unused-binding: const never read", () => {
  assertEquals(findingsOf('unused-binding', "const x = 1\n").length, 1);
});

Deno.test("unused-binding: read elsewhere is not flagged", () => {
  assertEquals(
    findingsOf('unused-binding', "let x = 1\nlet y = x + 1\nlet z = y\nz\n"),
    []);
});

Deno.test("unused-binding: unused local inside a function body", () => {
  assertEquals(
    findingsOf('unused-binding', "function f() {\n  let unused = 1\n  return 2\n}\n").length,
    1);
});

Deno.test("unused-binding: read via a nested closure counts as used", () => {
  assertEquals(findingsOf('unused-binding',
    "function outer() {\n  let x = 1\n  function inner() {\n    return x\n  }\n  return inner\n}\n"
  ), []);
});

Deno.test("unused-binding: a write alone does not count as a read", () => {
  assertEquals(findingsOf('unused-binding', "let x = 1\nx = 2\n").length, 1);
});

Deno.test("unused-binding: each unread destructured target is flagged independently", () => {
  const findings = findingsOf('unused-binding', "let [a, b] = [1, 2]\nlet c = a\n");
  assertEquals(findings.length, 2); // b, and c itself
});

Deno.test("unused-binding: function parameters are not flagged", () => {
  assertEquals(findingsOf('unused-binding', "function f(x) {\n  return 1\n}\n"), []);
});

Deno.test("unused-binding: catch parameters are not flagged", () => {
  assertEquals(findingsOf('unused-binding', "try {\n  throw 1\n} catch (e) {\n}\n"), []);
});

Deno.test("unused-binding: for-loop counter read in the test clause counts as used", () => {
  const findings = findingsOf('unused-binding', "for (let i = 0; i < 3; i++) {\n  let x = i\n}\n");
  // `i` is read by the test/update clauses and by `let x = i` — not flagged.
  // `x` itself is declared but never read — still flagged.
  assertEquals(findings.length, 1);
  assertEquals(findings[0].message.includes("'x'"), true);
});

Deno.test("unused-binding: function declarations are not flagged (not a let/const)", () => {
  assertEquals(findingsOf('unused-binding', "function f() {\n  return 1\n}\n"), []);
});

// =============================================================================
// severity: unused-binding is ALWAYS 'warn' (non-blocking), regardless of
// scope depth. A static walk can't tell a genuinely dead binding apart
// from a top-level one read externally via session.get(0, name) after the
// program parks, or a nested one that's finished, currently-shipping code
// written ahead of when it's wired up (found live: flow-row-source.js's
// cellPath, "Deferred, not silently dropped" per its own comment).
// =============================================================================

Deno.test("severity: top-level unused binding is 'warn'", () => {
  const findings = findingsOf('unused-binding', "let x = 1\n");
  assertEquals(findings.length, 1);
  assertEquals(findings[0].severity, 'warn');
});

Deno.test("severity: unused binding inside a function body is ALSO 'warn', not 'error'", () => {
  // A nested unused binding can be deliberately-deferred, currently-
  // shipping code (real production example: flow-row-source.js's
  // cellPath) — indistinguishable from genuinely dead code by a static
  // walk, so it must not block a spawn either.
  const findings = findingsOf('unused-binding',
    "function f() {\n  let unused = 1\n  return 2\n}\n");
  assertEquals(findings.length, 1);
  assertEquals(findings[0].severity, 'warn');
  assertEquals(hasBlockingFindings(findings), false);
});

Deno.test("severity: top-level binding only written (never read), like a drone exposing state via session.get, is warn-only and non-blocking", () => {
  // Top-level lets written inside a grant block can be read by the host through
  // session.get after the program parks. That read is invisible to a static
  // walk, so write-only findings must not block execution.
  const source = `
    let now1 = -1
    let now2 = -1
    grant "time" {
      now1 = Date.now()
      now2 = Date.now()
    }
  `;
  const { findings } = findStructuralIssues(source, { extraGlobals: ['Date'] });
  assertEquals(findings.every(f => f.rule === 'unused-binding' && f.severity === 'warn'), true);
  assertEquals(hasBlockingFindings(findings), false);
});

Deno.test("severity: unreachable-code, const-reassignment, and undefined-variable are all 'error'", () => {
  assertEquals(findingsOf('unreachable-code', "function f() {\n  return 1\n  let x = 2\n}\n")[0].severity, 'error');
  assertEquals(findingsOf('const-reassignment', "const x = 1\nx = 2\n")[0].severity, 'error');
  assertEquals(findingsOf('undefined-variable', "let x = undeclaredThing\n")[0].severity, 'error');
});

Deno.test("hasBlockingFindings: true when any error-severity finding exists, alongside warn-only ones", () => {
  const { findings } = findStructuralIssues("let x = 1\nlet y = undeclaredThing\n");
  // x: unused-binding/warn; y read of undeclaredThing: undefined-variable/error
  assertEquals(hasBlockingFindings(findings), true);
});

Deno.test("hasBlockingFindings: false for an empty findings array", () => {
  assertEquals(hasBlockingFindings([]), false);
});

// =============================================================================
// Cross-cutting: parse errors, empty findings shape
// =============================================================================

Deno.test("findStructuralIssues: clean, fully-used code has zero findings across all rules", () => {
  const { findings } = findStructuralIssues(
    "let x = 1\nlet y = x + 1\nfunction f(a) {\n  return a + y\n}\nlet z = f(x)\nz\n");
  assertEquals(findings, []);
});

// =============================================================================
// findStructuralIssuesInSession — the post-spawn-before-run entry point.
// Takes an already-live session (source already parsed into it, and any
// capability's globals already declared into its root scope) instead of a
// source string, so a capability-injected identifier like `setTimeout` is
// checked against what's REALLY declared rather than a guess.
// =============================================================================

Deno.test("findStructuralIssuesInSession: capability-declared global is not flagged", () => {
  const session = freshSession({ inlineSource: true });
  // Simulates a capability's setup() calling airlock.declare('setTimeout', handle)
  // before the runtime starts.
  session.mem.declareExternal('setTimeout', 0, 0);
  session.parse("let id = setTimeout\nid\n");

  const { findings } = findStructuralIssuesInSession(session);
  assertEquals(findings, []);
});

Deno.test("findStructuralIssuesInSession: still catches real findings against the live AST", () => {
  const session = freshSession({ inlineSource: true });
  session.mem.declareExternal('setTimeout', 0, 0);
  session.parse("let unused = 1\nsetTimeout(1, 2)\nlet x = undeclaredThing\nx\n");

  const rules = findStructuralIssuesInSession(session).findings.map(f => f.rule).sort();
  assertEquals(rules, ['undefined-variable', 'unused-binding']);
});

Deno.test("findStructuralIssuesInSession: throws when the session has no AST region", () => {
  const session = freshSession(); // no inlineSource — no AST region
  session.parse("let x = 1\nx\n");

  assertThrows(
    () => findStructuralIssuesInSession(session),
    Error,
    'no AST region');
});

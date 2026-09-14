/**
 * Structural correctness checks: dead code, undefined reads, bad writes.
 *
 * Parse-only, AST-based — no execution. Complements checkSyntax() ("does
 * this parse?") with "is this code structurally sound?": unreachable
 * statements, assignments to const, reads of undeclared variables, and
 * bindings that are never read. Not a code-quality/lint tool — no style
 * rules, no type checking.
 *
 * Every finding carries a `severity`: 'error' for unreachable-code,
 * const-reassignment, and undefined-variable — 'warn', always, for
 * unused-binding. A static walk cannot distinguish an unused top-level
 * binding from one the embedder reads after execution through the session
 * API. More generally, an unused binding does not make execution
 * structurally invalid, so unused-binding never blocks. A caller that wants
 * to block on findings should check for 'error' only — see
 * hasBlockingFindings().
 */

import { freshSession, freshSessionParsedFor } from '../host-owned-session.js';

// =============================================================================
// Unreachable code
// =============================================================================

// Node types that unconditionally end control flow within their own block:
// any sibling statement after one of these, at the same block nesting
// level, can never execute.
const TERMINATING_TYPES = new Set(['RETURN', 'THROW', 'BREAK', 'CONTINUE']);

function findUnreachableInBlock(block, findings) {
  if (block === null || block.type !== 'BLOCK') return;
  const stmts = block.statements;
  for (let i = 0; i < stmts.length; i++) {
    const stmt = stmts[i];
    if (stmt === null) continue;
    if (TERMINATING_TYPES.has(stmt.type) && i + 1 < stmts.length) {
      const next = stmts[i + 1];
      findings.push({
        rule: 'unreachable-code',
        severity: 'error',
        message: `unreachable statement after '${stmt.type.toLowerCase()}'`,
        line: next.line,
        column: next.col,
      });
      break; // one finding per block — the rest of the tail is the same defect
    }
  }
}

// Walk every BLOCK reachable from a root, checking each one independently
// (a nested block's own terminator doesn't make the outer block's tail
// unreachable — only a direct sibling statement does).
function walkForUnreachable(node, findings, visited) {
  if (node === null || typeof node !== 'object' || visited.has(node)) return;
  visited.add(node);
  if (node.type === 'BLOCK') {
    findUnreachableInBlock(node, findings);
  }
  for (const key of Object.keys(node)) {
    const val = node[key];
    if (Array.isArray(val)) {
      for (const item of val) walkForUnreachable(item, findings, visited);
    } else if (val && typeof val === 'object' && 'type' in val) {
      walkForUnreachable(val, findings, visited);
    }
  }
}

// =============================================================================
// Shared scope table
//
// One lexical scope per BLOCK node, plus synthetic wrapper scopes for
// constructs whose binding lives outside its own BLOCK (a for-loop's
// `let i` outlives each iteration's body scope; a catch parameter
// outlives the catch block). Mirrors the parser's SCOPE_PUSH/SCOPE_POP
// pairing (see parser.js's forStatement/forInBody/forOfBody/tryStatement/
// grantStatement/block comments) at the AST level, not bytecode.
// =============================================================================

class Scope {
  constructor(parent) {
    this.parent = parent;
    this.bindings = new Map(); // name -> { kind, node, used }
  }

  declare(name, kind, node) {
    this.bindings.set(name, { kind, node, used: false });
  }

  // Resolve a read: mark used and return the binding, searching outward.
  resolveRead(name) {
    let scope = this;
    while (scope !== null) {
      const binding = scope.bindings.get(name);
      if (binding) {
        binding.used = true;
        return binding;
      }
      scope = scope.parent;
    }
    return null;
  }

  // Resolve a write target without marking used (assigning to a binding
  // isn't a read of its current value).
  resolveWrite(name) {
    let scope = this;
    while (scope !== null) {
      const binding = scope.bindings.get(name);
      if (binding) return binding;
      scope = scope.parent;
    }
    return null;
  }
}

// Every name bound by a pattern (array/object destructuring), recursively.
// Yields { name, node } — node is the PATTERN_ELEMENT or VARIABLE_BINDING
// carrying that name, used for position/unused-reporting.
function* patternBindings(pattern) {
  if (pattern === null) return;
  if (pattern.type === 'ARRAY_PATTERN') {
    for (const el of pattern.elements) yield* patternElementBindings(el);
  } else if (pattern.type === 'OBJECT_PATTERN') {
    for (const el of pattern.properties) yield* patternElementBindings(el);
  }
}

function* patternElementBindings(el) {
  if (el === null) return;
  if (el.isHole) return;
  if (el.nestedPattern) {
    yield* patternBindings(el.nestedPattern);
    return;
  }
  if (el.name) yield { name: el.name, node: el };
}

// Visit an expression subtree for reads/writes, resolving names against
// the given scope. Declarations (VARIABLE_DECL, function params) are
// NOT introduced here — callers open scopes and declare bindings before
// descending into bodies that read them.
function walkExpression(node, scope, ctx) {
  if (node === null || typeof node !== 'object') return;
  switch (node.type) {
    case 'IDENTIFIER':
      ctx.onRead(node, scope);
      return;
    case 'ASSIGNMENT': {
      // target may be an IDENTIFIER (plain variable write) or a
      // MEMBER_ACCESS/INDEX_ACCESS (property write — not a binding write,
      // just walk the object expression as a read).
      if (node.target && node.target.type === 'IDENTIFIER') {
        ctx.onWrite(node.target, scope, node);
      } else {
        walkExpression(node.target, scope, ctx);
      }
      walkExpression(node.value, scope, ctx);
      return;
    }
    case 'UPDATE': {
      if (node.operand && node.operand.type === 'IDENTIFIER') {
        ctx.onWrite(node.operand, scope, node);
      } else {
        walkExpression(node.operand, scope, ctx);
      }
      return;
    }
    case 'FUNCTION_DECL':
      walkFunctionLike(node, scope, ctx);
      return;
    case 'OBJECT_PROPERTY': {
      // key is an IDENTIFIER/LITERAL_STRING node for plain and string
      // keys alike, even though a non-computed key is a property NAME,
      // not a variable read (`{ a: 1 }` never reads `a`). A computed key
      // (`{ [expr]: 1 }`) IS a real expression to walk. Shorthand
      // (`{ a }`) reads the key's name as the value — but the writer
      // sets `value` to that same read's IDENTIFIER node in that case
      // (see parser.js's shorthand handling), so walking `value` already
      // covers it; walking `key` too would double-count the read.
      if (node.isComputed) walkExpression(node.key, scope, ctx);
      walkExpression(node.value, scope, ctx);
      return;
    }
    case 'CLASS_DECL':
      walkClass(node, scope, ctx);
      return;
    default:
      break;
  }
  // Generic fallback: descend into every child node/array reachable from
  // this node (skip scalar fields — string, number, boolean, null).
  for (const key of Object.keys(node)) {
    if (key === 'type' || key === 'flags' || key === 'offset' || key === 'line' || key === 'col') continue;
    const val = node[key];
    if (Array.isArray(val)) {
      for (const item of val) walkExpression(item, scope, ctx);
    } else if (val && typeof val === 'object' && 'type' in val) {
      walkExpression(val, scope, ctx);
    }
  }
}

function walkClass(classNode, outerScope, ctx) {
  walkExpression(classNode.heritage, outerScope, ctx);
  const classScope = new Scope(outerScope);
  if (classNode.name) classScope.declare(classNode.name, 'class', classNode);
  for (const member of classNode.members) {
    if (member === null) continue;
    if (member.isComputed) walkExpression(member.key, classScope, ctx);
    if (member.isStaticBlock) {
      walkStatement(member.value, classScope, ctx);
    } else if (member.isField) {
      walkExpression(member.value, classScope, ctx);
    } else {
      walkFunctionLike(member.value, classScope, ctx);
    }
  }
  ctx.onScopeClose(classScope);
}

function walkFunctionLike(fnNode, outerScope, ctx) {
  const fnScope = new Scope(outerScope);
  for (const param of fnNode.params) {
    if (param === null) continue;
    if (param.type === 'VARIABLE_BINDING') {
      fnScope.declare(param.name, 'param', param);
      walkExpression(param.initializer, outerScope, ctx);
    } else if (param.type === 'SPREAD') {
      const inner = param.argument;
      if (inner && inner.type === 'VARIABLE_BINDING') {
        fnScope.declare(inner.name, 'param', inner);
      } else {
        for (const { name, node } of patternBindings(inner)) {
          fnScope.declare(name, 'param', node);
        }
      }
    } else if (param.type === 'ARRAY_PATTERN' || param.type === 'OBJECT_PATTERN') {
      for (const { name, node } of patternBindings(param)) {
        fnScope.declare(name, 'param', node);
      }
    }
  }
  walkStatement(fnNode.body, fnScope, ctx);
  ctx.onScopeClose(fnScope);
}

// Declare every name a VARIABLE_DECL introduces into `scope`, WITHOUT
// walking any initializer. Split out from declareVariableDecl so a BLOCK's
// pre-pass (see walkStatement's BLOCK case) can declare every top-level
// name before any initializer is walked — a forward reference from one
// top-level binding's initializer to a LATER sibling's name is legitimate
// (neither function body runs until the whole block has finished
// declaring everything), so the static walk must see the full sibling set
// before it starts checking reads, not build it up one statement at a time.
function declareVariableDeclNames(decl, scope) {
  const kind = decl.isConst ? 'const' : 'let';
  for (const binding of decl.bindings) {
    if (binding === null) continue;
    if (binding.type === 'VARIABLE_BINDING') {
      scope.declare(binding.name, kind, binding);
    } else if (binding.type === 'ARRAY_PATTERN' || binding.type === 'OBJECT_PATTERN') {
      for (const { name, node } of patternBindings(binding)) {
        scope.declare(name, kind, node);
      }
    }
  }
}

// Walk every VARIABLE_DECL binding's initializer against `scope`. Callers
// that already ran declareVariableDeclNames over the enclosing block don't
// need the names declared again here; callers that haven't (FOR's own
// init, which has no siblings to forward-reference) declare inline.
function walkVariableDeclInitializers(decl, scope, ctx) {
  for (const binding of decl.bindings) {
    if (binding === null) continue;
    if (binding.type === 'VARIABLE_BINDING' || binding.type === 'ARRAY_PATTERN' || binding.type === 'OBJECT_PATTERN') {
      walkExpression(binding.initializer, scope, ctx);
    }
  }
}

// Declare every binding a VARIABLE_DECL introduces into `scope` BEFORE
// walking its own initializer, so a named function expression can
// reference its own binding from inside its body — `let listener = (e)
// => { ... listener(...) ... }`, a real, common idiom (a self-removing
// event listener; plain recursion) that would otherwise read as
// "undefined" purely because the walk visits the function body eagerly
// as part of walking the initializer, even though that body doesn't
// actually RUN until well after the declaration completes. Declaring
// first also means later bindings in the same `let a = 1, b = a` still
// see earlier ones (a is declared, then b's initializer walks against a
// scope that already has it) — same left-to-right visibility as before,
// just reordered relative to the OWN binding rather than only siblings'.
//
// Used only where there's no block-level pre-pass to rely on (FOR's own
// init clause — a single VARIABLE_DECL with no siblings to forward-
// reference, so declare-then-walk is sufficient there).
function declareVariableDecl(decl, scope, ctx) {
  declareVariableDeclNames(decl, scope);
  walkVariableDeclInitializers(decl, scope, ctx);
}

function walkStatement(node, scope, ctx) {
  if (node === null) return;
  switch (node.type) {
    case 'BLOCK': {
      const blockScope = new Scope(scope);
      // Pre-pass: declare every direct-child let/const/function name into
      // blockScope BEFORE walking any statement body. None of these names'
      // initializers/bodies actually run until the whole block has finished
      // declaring everything — so a forward reference from an earlier
      // sibling's initializer to a later sibling's name (mutually-
      // referencing top-level function group; A calls B declared below it)
      // is legitimate and must resolve, not just a binding referencing
      // itself. Only direct children matter here — a nested block's own
      // declarations get their own blockScope when that BLOCK is walked.
      for (const stmt of node.statements) {
        if (stmt === null) continue;
        if (stmt.type === 'VARIABLE_DECL') {
          declareVariableDeclNames(stmt, blockScope);
        } else if (stmt.type === 'FUNCTION_DECL' && stmt.name) {
          blockScope.declare(stmt.name, 'function', stmt);
        } else if (stmt.type === 'CLASS_DECL' && stmt.name) {
          blockScope.declare(stmt.name, 'class', stmt);
        }
      }
      for (const stmt of node.statements) walkStatement(stmt, blockScope, ctx);
      ctx.onScopeClose(blockScope);
      return;
    }
    case 'VARIABLE_DECL':
      // Names already declared by the enclosing BLOCK's pre-pass (see
      // above) — just walk initializers now that every sibling is visible.
      walkVariableDeclInitializers(node, scope, ctx);
      return;
    case 'EXPRESSION_STMT':
      walkExpression(node.expression, scope, ctx);
      return;
    case 'IF':
      walkExpression(node.test, scope, ctx);
      walkStatement(node.consequent, scope, ctx);
      if (node.hasAlternate) walkStatement(node.alternate, scope, ctx);
      return;
    case 'WHILE':
      walkExpression(node.test, scope, ctx);
      walkStatement(node.body, scope, ctx);
      return;
    case 'DO_WHILE':
      walkStatement(node.body, scope, ctx);
      walkExpression(node.test, scope, ctx);
      return;
    case 'FOR': {
      const forScope = new Scope(scope);
      if (node.init) {
        if (node.init.type === 'VARIABLE_DECL') declareVariableDecl(node.init, forScope, ctx);
        else walkExpression(node.init.expression ?? node.init, forScope, ctx);
      }
      if (node.test) walkExpression(node.test, forScope, ctx);
      if (node.update) walkExpression(node.update, forScope, ctx);
      walkStatement(node.body, forScope, ctx);
      ctx.onScopeClose(forScope);
      return;
    }
    case 'FOR_IN':
    case 'FOR_OF': {
      const loopScope = new Scope(scope);
      walkExpression(node.iterable, scope, ctx);
      const binding = node.binding;
      if (binding) {
        if (binding.type === 'VARIABLE_BINDING') {
          loopScope.declare(binding.name, node.declarationKeyword === 'const' ? 'const' : 'let', binding);
        } else if (binding.type === 'ARRAY_PATTERN' || binding.type === 'OBJECT_PATTERN') {
          for (const { name, node: bindingNode } of patternBindings(binding)) {
            loopScope.declare(name, node.declarationKeyword === 'const' ? 'const' : 'let', bindingNode);
          }
        }
      }
      walkStatement(node.body, loopScope, ctx);
      ctx.onScopeClose(loopScope);
      return;
    }
    case 'BREAK':
    case 'CONTINUE':
      return;
    case 'RETURN':
    case 'THROW':
      if (node.value) walkExpression(node.value, scope, ctx);
      return;
    case 'TRY': {
      walkStatement(node.block, scope, ctx);
      if (node.hasCatch) {
        const catchScope = new Scope(scope);
        const param = node.catchParam;
        if (param && param.type === 'VARIABLE_BINDING') {
          catchScope.declare(param.name, 'param', param);
        }
        walkStatement(node.catchBlock, catchScope, ctx);
        ctx.onScopeClose(catchScope);
      }
      if (node.hasFinally) walkStatement(node.finallyBlock, scope, ctx);
      return;
    }
    case 'LABELED':
      walkStatement(node.body, scope, ctx);
      return;
    case 'SWITCH': {
      walkExpression(node.discriminant, scope, ctx);
      const switchScope = new Scope(scope);
      for (const c of node.cases) {
        if (c === null) continue;
        if (c.test) walkExpression(c.test, switchScope, ctx);
        for (const stmt of c.statements) walkStatement(stmt, switchScope, ctx);
      }
      ctx.onScopeClose(switchScope);
      return;
    }
    case 'FUNCTION_DECL': {
      // Function declaration as a statement: name binds in the
      // enclosing scope (already declared by the parser's LET_VAR before
      // the body runs — but for our purposes the name is available to
      // sibling/later statements and to the function's own body via
      // closure, so declare it in `scope`, then walk the body in a
      // child scope for its params/locals).
      if (node.name) scope.declare(node.name, 'function', node);
      walkFunctionLike(node, scope, ctx);
      return;
    }
    case 'CLASS_DECL':
      if (node.name) scope.declare(node.name, 'class', node);
      walkClass(node, scope, ctx);
      return;
    case 'GRANT': {
      for (const id of node.identifiers) walkExpression(id, scope, ctx);
      const bodyScope = new Scope(scope);
      walkStatement(node.body, bodyScope, ctx);
      ctx.onScopeClose(bodyScope);
      if (node.hasDenied) {
        const deniedScope = new Scope(scope);
        if (node.deniedParam) deniedScope.declare(node.deniedParam, 'param', node);
        walkStatement(node.deniedBody, deniedScope, ctx);
        ctx.onScopeClose(deniedScope);
      }
      return;
    }
    case 'EMPTY_STMT':
      return;
    default:
      // Fallback for any statement shape not explicitly handled above
      // (keeps the walker from silently stopping if a new statement
      // type is ever added to the AST).
      walkExpression(node, scope, ctx);
      return;
  }
}

// =============================================================================
// Undefined-read / const-write checks
//
// Names resolvable in the reference global scope are never "undefined".
// The reference may be a caller-supplied live session's root scope, a plain
// name list, or (by default) a bare freshSession() core scope. Capability
// globals must be read from the session because the embedder declares them
// dynamically; a static hand-maintained list would not reflect the actual
// execution environment.
// =============================================================================

function referenceGlobalNames({ session, extraGlobals } = {}) {
  const names = new Set();
  const refSession = session ?? freshSession();
  for (const name of Object.keys(refSession.state(0).scope)) names.add(name);
  if (extraGlobals) {
    for (const name of extraGlobals) names.add(name);
  }
  return names;
}

function checkReadsAndWrites(tree, globalNames, findings) {
  const rootScope = new Scope(null);
  const ctx = {
    onRead(identifierNode, scope) {
      const binding = scope.resolveRead(identifierNode.name);
      if (binding === null && !globalNames.has(identifierNode.name)) {
        findings.push({
          rule: 'undefined-variable',
          severity: 'error',
          message: `'${identifierNode.name}' is never declared`,
          line: identifierNode.line,
          column: identifierNode.col,
        });
      }
    },
    onWrite(identifierNode, scope, writeNode) {
      const binding = scope.resolveWrite(identifierNode.name);
      if (binding === null) {
        if (!globalNames.has(identifierNode.name)) {
          findings.push({
            rule: 'undefined-variable',
            severity: 'error',
            message: `'${identifierNode.name}' is never declared`,
            line: identifierNode.line,
            column: identifierNode.col,
          });
        }
        return;
      }
      if (binding.kind === 'const') {
        findings.push({
          rule: 'const-reassignment',
          severity: 'error',
          message: `'${identifierNode.name}' is declared const and cannot be reassigned`,
          line: writeNode.line,
          column: writeNode.col,
        });
      }
    },
    onScopeClose(scope) {
      // Only let/const bindings are reported — function params and
      // function declarations aren't flagged (removing an unused param
      // can break a call signature; an unused function declaration is
      // arguably dead code, but that's a different rule from "unused
      // binding" and not in scope here). resolveRead() marks `used`
      // through the parent chain, so a binding read only from inside a
      // nested closure is correctly NOT flagged — the read walks outward
      // from the closure's own scope and finds this one.
      //
      // Severity: always 'warn', never blocking, regardless of scope
      // depth. An apparent top-level non-use may be an embedder read through
      // the session API, and unused bindings do not make execution
      // structurally invalid. A checker should not block execution over
      // either case.
      for (const [name, binding] of scope.bindings) {
        if ((binding.kind === 'let' || binding.kind === 'const') && !binding.used) {
          findings.push({
            rule: 'unused-binding',
            severity: 'warn',
            message: `'${name}' is declared but never read`,
            line: binding.node.line,
            column: binding.node.col,
          });
        }
      }
    },
  };
  walkStatement(tree.body, rootScope, ctx);
}

// =============================================================================
// Public entry points
// =============================================================================

/**
 * True if any finding is severity 'error' — the policy a caller deciding
 * whether to block (refuse execution, fail a CI check, exit nonzero) should
 * use. A 'warn'-only result should not block.
 *
 * @param {Array<{severity: string}>} findings
 * @returns {boolean}
 */
export function hasBlockingFindings(findings) {
  return findings.some(f => f.severity === 'error');
}

// Shared core: walk every root an AST reader exposes, running both checks
// against a caller-supplied global-name set. The source-text and live-session
// entry points differ only in where the reader and global names come from.
function runChecks(reader, globalNames) {
  const findings = [];
  const visited = new Set();
  for (const rootOffset of reader.iterateRoots()) {
    const tree = reader.readTree(rootOffset);
    walkForUnreachable(tree, findings, visited);
    checkReadsAndWrites(tree, globalNames, findings);
  }
  return { findings };
}

/**
 * Standalone check: parse `source` fresh, without a live session or
 * embedder-provided capabilities, and run the structural checks against it.
 * This entry point is usable on a bare file with no host context.
 *
 * @param {string} source
 * @param {object} [options]
 * @param {object} [options.session] - A live session (capabilities already
 *   loaded) whose root scope defines what counts as a legitimate global.
 *   Falls back to a bare freshSession() (core builtins only) if omitted.
 *   NOTE: this session is consulted ONLY for its global scope — `source` is
 *   still parsed into its own throwaway session, not run against this one.
 * @param {string[]} [options.extraGlobals] - Extra names to treat as
 *   defined, alongside the reference session's scope.
 * @returns {{ findings: Array<{rule: string, message: string, line: number, column: number}> }}
 */
export function findStructuralIssues(source, options = {}) {
  // freshSessionParsedFor, not freshSession+parse: the throwaway parse
  // session grows its AST region to fit the source instead of failing
  // a legitimately large file against the fixed inlineSource default.
  const parseSession = freshSessionParsedFor(source, { inlineSource: true });
  const globalNames = referenceGlobalNames(options);
  return runChecks(parseSession.astReader(), globalNames);
}

/**
 * Live-session check: run the structural checks against the session's own
 * parsed AST and root scope; no source text is needed or consulted. Call it
 * after the embedder has registered every capability global in the root
 * scope, but before the first instruction executes. This makes injected
 * identifiers such as setTimeout and fetch visible to the checker while
 * still allowing a blocking finding to prevent execution.
 *
 * The session must have been created with an initialized AST region
 * (`inlineSource: true` or `astRegionSize > 0`). The reader traverses the
 * serialized AST stored in that region, so a session without one contains
 * nothing for this function to inspect and causes it to throw.
 *
 * @param {object} session - A live session after host capability registration.
 * @returns {{ findings: Array<{rule: string, message: string, line: number, column: number}> }}
 */
export function findStructuralIssuesInSession(session) {
  if (!session.mem.isAstRegionInitialized()) {
    throw new Error(
      'findStructuralIssuesInSession: session has no AST region — spawn ' +
      'with inlineSource: true / astRegionSize > 0 (development-mode ' +
      'spawns already default to this).');
  }
  const globalNames = new Set(Object.keys(session.state(0).scope));
  return runChecks(session.astReader(), globalNames);
}

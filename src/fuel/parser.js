/**
 * SandScript Fuel Streaming Parser
 *
 * Parses loose SandScript source and emits flat instructions to CodeBlocks.
 * This is a Pratt parser (top-down operator precedence) that emits bytecode
 * directly instead of building an AST.
 */

import { Lexer, TokenType, KEYWORD_TOKEN_TYPES } from './lexer.js';
import { OP, CODE_BLOCK_FLAG, SCOPE_FLAG_CONST, MAX_PARAMETER_COUNT } from './constants.js';
import {
  REGEX_FLAG_BY_LETTER,
  REGEX_UNSUPPORTED_FLAG_LETTERS,
  REGEX_LIMIT,
} from './regex-engine-contract.js';
import { BinaryOp, LogicalOp, UnaryOp, UpdateOp, AssignOp, FLAG } from './ast.js';

// TokenType values produced by the lexer for reserved keywords.
// Used by `consume` to recognize "user wrote a reserved word where
// we wanted an identifier" and produce a clear error message, and
// by the property-key sites that accept any IdentifierName per JS.
// Imported from lexer.js (derived from the KEYWORDS table) so it
// cannot drift — the previous hand-maintained copy here was already
// missing switch/case/default.

function isKeywordToken(type) {
  return type !== undefined && KEYWORD_TOKEN_TYPES.has(type);
}

// Keywords sandscript reserves that vanilla JS does NOT. Drone-source
// authors writing JS-flavored code can be surprised by these — they're
// the common stumbling block. Listed as source spellings so the
// error message can compare against the offending token's value.
const SANDSCRIPT_ONLY_KEYWORDS = new Set(['grant', 'denied']);

// Map a compound-assignment token to the AST AssignOp sub-tag.
function assignOpFromToken(token) {
  switch (token) {
    case TokenType.PLUS_ASSIGN: return AssignOp.PLUS_EQ;
    case TokenType.MINUS_ASSIGN: return AssignOp.MINUS_EQ;
    case TokenType.STAR_ASSIGN: return AssignOp.STAR_EQ;
    case TokenType.SLASH_ASSIGN: return AssignOp.SLASH_EQ;
    case TokenType.PERCENT_ASSIGN: return AssignOp.PERCENT_EQ;
    case TokenType.STAR_STAR_ASSIGN: return AssignOp.STAR_STAR_EQ;
    case TokenType.AMPERSAND_ASSIGN: return AssignOp.AMP_EQ;
    case TokenType.PIPE_ASSIGN: return AssignOp.PIPE_EQ;
    case TokenType.CARET_ASSIGN: return AssignOp.CARET_EQ;
    case TokenType.LSHIFT_ASSIGN: return AssignOp.LT_LT_EQ;
    case TokenType.RSHIFT_ASSIGN: return AssignOp.GT_GT_EQ;
    case TokenType.URSHIFT_ASSIGN: return AssignOp.GT_GT_GT_EQ;
    default: return AssignOp.EQ;
  }
}

// Map a binary-operator token to the AST BinaryOp sub-tag.
function binaryOpFromToken(token) {
  switch (token) {
    case TokenType.PLUS: return BinaryOp.PLUS;
    case TokenType.MINUS: return BinaryOp.MINUS;
    case TokenType.STAR: return BinaryOp.STAR;
    case TokenType.SLASH: return BinaryOp.SLASH;
    case TokenType.PERCENT: return BinaryOp.PERCENT;
    case TokenType.STAR_STAR: return BinaryOp.STAR_STAR;
    case TokenType.EQ: return BinaryOp.EQ_EQ_EQ;
    case TokenType.NEQ: return BinaryOp.NOT_EQ_EQ;
    case TokenType.LT: return BinaryOp.LT;
    case TokenType.GT: return BinaryOp.GT;
    case TokenType.LTE: return BinaryOp.LT_EQ;
    case TokenType.GTE: return BinaryOp.GT_EQ;
    case TokenType.INSTANCEOF: return BinaryOp.INSTANCEOF;
    case TokenType.IN: return BinaryOp.IN;
    case TokenType.AMPERSAND: return BinaryOp.AMP;
    case TokenType.PIPE: return BinaryOp.PIPE;
    case TokenType.CARET: return BinaryOp.CARET;
    case TokenType.LSHIFT: return BinaryOp.LT_LT;
    case TokenType.RSHIFT: return BinaryOp.GT_GT;
    case TokenType.URSHIFT: return BinaryOp.GT_GT_GT;
    default: return BinaryOp.PLUS;
  }
}

// Operator precedence levels
const PREC = {
  NONE: 0,
  COMMA: 1,        // ,
  ASSIGNMENT: 2,   // =, +=, -=, etc.
  TERNARY: 3,      // ? :
  NULLISH: 4,      // ??
  OR: 5,           // ||
  AND: 6,          // &&
  BIT_OR: 7,       // |
  BIT_XOR: 8,      // ^
  BIT_AND: 9,      // &
  EQUALITY: 10,    // === !==
  COMPARISON: 11,  // < > <= >=
  SHIFT: 12,       // << >> >>>
  TERM: 13,        // + -
  FACTOR: 14,      // * / %
  POWER: 15,       // **
  UNARY: 16,       // ! - ~ typeof ++ --
  CALL: 17,        // . () [] ?.
  PRIMARY: 18,
};

/**
 * Parser emits instructions directly to CodeBlocks.
 */
export class Parser {
  constructor(mem, astWriter = null) {
    this.mem = mem;
    // AST writer. When inlineSource is off, a
    // no-op stub is passed in so emit sites can unconditionally thread
    // astNode offsets without per-call null checks.
    this.ast = astWriter;
    this.lexer = new Lexer();
    this.current = null;
    this.previous = null;
    this.hadError = false;

    // For continuation blocks when we hit nested functions
    this.blockStack = [];

    // For break/continue - stack of { breaks: number[], continues: number[], continueTarget: number | null }
    this.loopStack = [];

    // v11 unwind counting: number of live try entries at the current
    // parse position within the current function — one per user try
    // (alive through its try, catch, AND finally blocks) plus one per
    // enclosing for-of iteration frame. break/continue compare this
    // against the snapshot stored on the target loopStack entry: a
    // nonzero delta compiles to UNWIND_JUMP (pop/divert that many
    // entries) instead of a plain JUMP. Function bodies save/restore it
    // together with loopStack.
    this.tryProtectionDepth = 0;

    // v12 grant unwind counting: live grant ENTRIES (one per granted
    // identifier, not per block) at the current parse position within
    // the current function, plus a parallel record of the grant depth
    // at each live protected entry's push. break/continue use these to
    // emit the static grant pops the runtime clamps can't see: a
    // GRANT_END for try-less crossings, and a post-unwind trampoline
    // GRANT_END for grants pushed below the outermost crossed try.
    // (return needs nothing here — the WAT return walk trims the
    // departing frame's grant entries.)
    this.grantProtectionDepth = 0;
    this.tryGrantDepths = [];

    // For method calls - set by dot/index, consumed by call
    // When true, call() emits CALL_METHOD instead of CALL
    this.pendingMethodCall = false;
    // For super() calls — set by superExpression, consumed by call():
    // CALL_METHOD/CALL_METHOD_SPREAD operand2 bit 0 makes the dispatch
    // propagate the caller's `@newtarget` binding into the callee scope
    // (JS reports the most derived class inside a parent constructor).
    this.pendingSuperCall = false;

    // For `delete <ref>` - set by unary() while parsing DELETE's operand.
    // dot()/index() check this to know whether THEY are the last link in
    // the postfix chain (no further `.`/`[`/`?.` follows): if so, they
    // must emit a reference (object + key), not a value read, so the
    // DELETE opcode can remove the property instead of operating on
    // whatever value happened to be there. Intermediate links in a chain
    // like `obj.a.b` still emit normal reads (GET_PROP 'a') since their
    // result feeds the next link, not the DELETE opcode.
    this.pendingDeleteTarget = false;

    // For REPL result - defer POP so final expression value stays on stack
    this.pendingPop = false;

    // For await/yield validation - track the kind of the current function
    // context. Stack of { isAsync, isGenerator } objects; empty = top level.
    this.functionStack = [];

    // For export declarations - tracks exported names as metadata
    this.exports = new Map();  // name -> { type: 'const'|'let'|'function' }

    // Class bodies track lexical `super` with one frame per non-arrow
    // function body; arrow bodies
    // inherit the enclosing frame by not pushing. kind is one of:
    // 'none' | 'ctor-base' | 'ctor-derived' | 'method-base'
    // | 'method-derived' | 'static-base' | 'static-derived'.
    this.superStack = [];
    // Set by class-member emission immediately before emitFunctionBody;
    // consumed once there. Non-arrow bodies default to 'none'.
    this.pendingSuperKind = null;
    // Private-name scoping: one Map per enclosing class body
    // (source '#name' → mangled hidden key). Pushed by classTail after
    // its prescan; searched innermost-first by resolvePrivateName.
    this.privateNameStack = [];

    // Scope depth counter - 0 at top level, incremented by SCOPE_PUSH
    this.scopeDepth = 0;

    // Counter for emitting unique hidden-binding names in destructuring
    // (e.g. @dst_src_3 / @dst_iter_3) so multiple destructurings in the
    // same scope don't collide on those internal locals.
    this.destructuringCounter = 0;
  }

  /**
   * Parse source and emit instructions to the code block.
   *
   * Each session has a single code block. In REPL mode, subsequent parse()
   * calls append instructions to the same code block.
   *
   * Streaming: instructions are emitted as parsing proceeds. If the input
   * is incomplete (e.g., unclosed block), partial instructions remain and
   * an "expecting" error is thrown. The caller can continue feeding input.
   *
   * @param {string} source - Source code
   */
  parse(source) {
    this.lexer.reset(source);
    this.hadError = false;
    this.blockStack = [];
    this.scopeDepth = 0;
    const rootStart = this.pos({ line: this.lexer.line, col: this.lexer.col });

    // Seed the hidden-binding counter (@dst_* / @spread_* temps) from the
    // code block's append position rather than 0. The counter only needs
    // to be unique per persistent scope, but a session restored from a
    // snapshot reconstructs the Parser — a plain instance counter restarts
    // at 0 and the next parse's `let @spread_iter_0` REDECLARATIONs
    // against the binding an earlier parse left in the persisted top-level
    // scope. The instruction count is part of the snapshot and strictly
    // increases across incremental parses, and every synthesized site
    // emits at least one instruction per counter consumed, so seeded
    // ranges never overlap.
    this.destructuringCounter = this.mem.codeBlockInstructionCount();

    this.advance();

    const stmtOffsets = [];
    while (!this.check(TokenType.EOF)) {
      // Top-level statements may leave their expression POP deferred
      // (pendingPop) so the REPL can read the last result; every
      // EMBEDDED statement position flushes on exit — see statement().
      this.atTopLevelStatement = true;
      const off = this.statement();
      if (off) stmtOffsets.push(off);
    }

    // Honor hadError: a syntax error detected mid-parse sets hadError and
    // throws a SyntaxError — but that throw can be swallowed by the
    // cover-grammar skim's try/catch (grouping()) or by error()'s own
    // cascading-error suppression (`if (this.hadError) return`). Without
    // this guard, parse() could return success while hadError === true,
    // emitting half-formed bytecode (e.g. `let x = (((` binds x = null).
    // The contract — established by the 256-byte string fix — is that a
    // parse failure must reach the caller, never propagate silently.
    if (this.hadError) {
      throw new SyntaxError('parse failed (syntax error detected during parsing)');
    }

    // v11 sentinel: FINALLY_END re-dispatches a pending RETURN completion
    // by jumping to instr_count - 1, which must hold a real RETURN
    // instruction — re-running a genuine RETURN gives the full opcode
    // semantics (remaining finallys, iteration continuations, async
    // completion) with no duplicated interpreter code, and any pressure
    // park inside the continuation resumes at a real instruction. The
    // JUMP skips it in normal flow (landing past the end = EXIT_DONE, and
    // = the append point for the next REPL batch). Each parse batch
    // appends its own sentinel; older ones become unreachable dead code.
    const sentinelJump = this.emit(OP.JUMP, 0);
    this.emit(OP.RETURN);
    this.patch(sentinelJump, this.here);

    // AST: wrap top-level statements in a Block, write a Root, commit it
    // into the chain. No-op writer collapses these to 0 returns.
    const blockOff = this.ast ? this.ast.writeBlock(stmtOffsets, rootStart) : 0;
    const rootOff = this.ast ? this.ast.writeRoot(blockOff, rootStart) : 0;
    if (this.ast && rootOff) this.ast.commitRoot(rootOff);

    // Don't mark COMPLETE - caller decides when the block is done
    // This allows REPL to keep appending
  }

  /**
   * Mark the current CodeBlock as complete.
   * Call this when done adding statements (e.g., end of file/session).
   */
  complete() {
    // Don't emit pending POP - let final expression value stay on stack for REPL
    this.pendingPop = false;

    if (!this.hadError) {
      this.mem.codeBlockSetFlags(CODE_BLOCK_FLAG.COMPLETE);
    }
  }

  // ===========================================================================
  // Token handling
  // ===========================================================================

  advance() {
    // A deferred lexical error throws only when its token is actually
    // consumed — a `/` at an expression position re-scans as a RegExp
    // literal and replaces the stale division-goal lookahead without
    // ever consuming it (see TokenType.INVALID).
    if (!this.skimming &&
        this.current && this.current.type === TokenType.INVALID) {
      throw this.current.value;
    }
    this.previous = this.current;
    this.current = this.lexer.next();

    // Skip comment tokens
    while (this.current.type === TokenType.COMMENT) {
      this.current = this.lexer.next();
    }
  }

  check(type) {
    return this.current.type === type;
  }

  match(type) {
    if (!this.check(type)) return false;
    this.advance();
    return true;
  }

  consume(type, message) {
    if (this.check(type)) {
      this.advance();
      return this.previous;
    }
    if (this.current && this.current.type === TokenType.INVALID) {
      throw this.current.value;
    }
    // When we expected an IDENTIFIER but the lexer produced a keyword
    // token, the user almost certainly tried to use a reserved word
    // as a variable / parameter / property name. Produce a clear
    // message that names the offending keyword instead of the bare
    // "Expected variable name" — especially important for keywords
    // sandscript reserves but vanilla JS does NOT (`grant`, `denied`),
    // since those will surprise drone authors who write valid JS.
    if (type === TokenType.IDENTIFIER && isKeywordToken(this.current?.type)) {
      const word = this.current?.value ?? '<unknown>';
      const sandscriptOnly = SANDSCRIPT_ONLY_KEYWORDS.has(word);
      const suffix = sandscriptOnly
        ? ` ('${word}' is a reserved keyword in SandScript — `
          + `it's the start of a grant block's denied { } arm or the `
          + `'grant' / 'denied' contextual keyword. Pick a different name.)`
        : ` ('${word}' is a reserved keyword.)`;
      this.error(`${message}${suffix}`);
    }
    this.error(message);
  }

  consumePropertyName() {
    if (this.check(TokenType.IDENTIFIER)) {
      this.advance();
      return this.previous;
    }
    // Allow reserved words as property names after dot (e.g. promise.catch, promise.finally)
    if (this.current && this.current.value && typeof this.current.value === 'string') {
      this.advance();
      return this.previous;
    }
    this.error('Expected property name after "."');
  }

  error(message) {
    if (this.hadError) return; // suppress cascading errors
    this.hadError = true;
    const token = this.current;
    throw new SyntaxError(`${message} at line ${token.line}, col ${token.col}`);
  }

  // ===========================================================================
  // Instruction emission
  // ===========================================================================

  emit(opcode, operand1 = 0, operand2 = 0, astNode = 0) {
    if (opcode === OP.SCOPE_PUSH) this.scopeDepth++;
    else if (opcode === OP.SCOPE_POP) this.scopeDepth--;
    return this.mem.codeBlockAppend(opcode, operand1, operand2, 0, astNode);
  }

  /**
   * Legacy alias for emit() — kept for compatibility with callers that
   * still pass token positions. Token positions used to be stored in
   * instruction bytes (sourceStart / sourceEnd); now only `astNode` is
   * stored. The start/end args are accepted but ignored.
   */
  emitWithSource(opcode, operand1, operand2, _start, _end, astNode = 0) {
    return this.mem.codeBlockAppend(opcode, operand1, operand2, 0, astNode);
  }

  /**
   * Build the { line, col } position object AST writer calls take, from a
   * lexer token (or the current token if omitted). Every this.ast.write*
   * call site passes the token marking that construct's start.
   */
  pos(token = this.current) {
    return { line: token.line, col: token.col };
  }

  /**
   * Get current instruction index (for backpatching).
   */
  get here() {
    return this.mem.codeBlockInstructionCount();
  }

  /**
   * Patch operand1 of an instruction.
   */
  patch(index, value) {
    this.mem.codeBlockPatch(index, value);
  }

  /**
   * Intern a string and return its offset.
   */
  internString(str) {
    return this.mem.internString(str);
  }

  // ===========================================================================
  // Statements
  // ===========================================================================

  statement() {
    // Top-level vs embedded: only the parse() loop sets the flag, and any
    // recursion below is embedded by definition. An EMBEDDED statement
    // must never leave a POP deferred past its own end — a control-flow
    // parent reads `this.here` for jump targets right after the embedded
    // statement returns, and a still-pending POP then flushes INTO the
    // fall-through path (an unbraced `if (c) expr()` executed an orphaned
    // POP on every false branch: one operand-stack underflow each — the
    // console-host callee-slot corruption, 2026-07-02; see
    // tests/fuel/unbraced_if_pending_pop_test.js).
    const isTopLevel = this.atTopLevelStatement === true;
    this.atTopLevelStatement = false;

    // Emit deferred POP from previous expression statement
    if (this.pendingPop) {
      this.emit(OP.POP);
      this.pendingPop = false;
    }

    const statementOffset = this.dispatchStatement();

    if (!isTopLevel && this.pendingPop) {
      this.emit(OP.POP);
      this.pendingPop = false;
    }
    return statementOffset;
  }

  dispatchStatement() {

    // Empty statement (standalone semicolon)
    if (this.match(TokenType.SEMICOLON)) {
      return this.ast ? this.ast.writeEmptyStatement(this.pos(this.previous)) : 0;
    }
    if (this.match(TokenType.LET)) {
      return this.variableDeclaration(false);
    } else if (this.match(TokenType.CONST)) {
      return this.variableDeclaration(true);
    } else if (this.match(TokenType.VAR)) {
      return this.variableDeclaration(false); // var is alias for let
    } else if (this.match(TokenType.FUNCTION)) {
      return this.functionDeclaration(false);
    } else if (this.match(TokenType.CLASS)) {
      return this.classDeclaration(false);
    } else if (this.match(TokenType.ASYNC)) {
      return this.asyncDeclarationOrExpression();
    } else if (this.match(TokenType.IF)) {
      return this.ifStatement();
    } else if (this.match(TokenType.WHILE)) {
      return this.whileStatement();
    } else if (this.match(TokenType.DO)) {
      return this.doWhileStatement();
    } else if (this.match(TokenType.FOR)) {
      return this.forStatement();
    } else if (this.match(TokenType.BREAK)) {
      return this.breakStatement();
    } else if (this.match(TokenType.CONTINUE)) {
      return this.continueStatement();
    } else if (this.match(TokenType.RETURN)) {
      return this.returnStatement();
    } else if (this.match(TokenType.THROW)) {
      return this.throwStatement();
    } else if (this.match(TokenType.TRY)) {
      return this.tryStatement();
    } else if (this.match(TokenType.GRANT)) {
      return this.grantStatement();
    } else if (this.match(TokenType.SWITCH)) {
      return this.switchStatement();
    } else if (this.match(TokenType.EXPORT)) {
      return this.exportDeclaration();
    } else if (this.match(TokenType.LBRACE)) {
      return this.block();
    } else {
      return this.expressionStatement();
    }
  }

  /**
   * Parse function declaration statement: function name(params) { body }
   * Binds the function to the name in the current scope.
   * @param {boolean} isAsync - If true, create an async function
   * @param {boolean} isExported - If true, mark the AST node FN_EXPORTED
   *   (top-level `export function`, persisted so restore can rebuild the
   *   export map)
   */
  functionDeclaration(isAsync = false, isExported = false) {
    const startTok = this.previous; // `function` (or `async`, if isAsync)
    // Generator declaration: `function* name() { ... }` (with isAsync:
    // `async function* name() { ... }`).
    const isGenerator = this.match(TokenType.STAR);
    // Require function name
    this.consume(TokenType.IDENTIFIER, "Expected function name");
    const nameStart = this.previous.start;
    const nameEnd = this.previous.end;
    // Recorded for exportDeclaration, which can't see past the `*` of a
    // generator declaration to capture the name itself.
    this.lastFunctionDeclarationName = this.previous.value;
    const name = this.internString(this.previous.value);

    // Parse parameters
    this.consume(TokenType.LPAREN, "Expected '(' after function name");
    const params = this.parseFunctionParams();

    // Parse body
    this.consume(TokenType.LBRACE, "Expected '{' before function body");
    const { paramBindings, bodyBlock, closureInstr } = this.emitFunctionBody(params, false, isAsync, isGenerator);

    // AST: write FunctionDecl. Attribute the MAKE_CLOSURE instruction to it.
    const fnNode = this.ast ? this.ast.writeFunctionDecl({
      nameOffset: name,
      params: paramBindings,
      body: bodyBlock,
      flags: (isAsync ? FLAG.FN_ASYNC : 0)
        | (isGenerator ? FLAG.FN_GENERATOR : 0)
        | (isExported ? FLAG.FN_EXPORTED : 0),
      pos: this.pos(startTok),
    }) : 0;
    this.attributeInstruction(closureInstr, fnNode);

    // Bind function to name in current scope
    this.emitWithSource(OP.LET_VAR, name, 0, nameStart, nameEnd, fnNode);
    return fnNode;
  }

  // ===========================================================================
  // Classes
  //
  // A class compiles onto the prototype machinery that already exists:
  // closures, MAKE_OBJECT, SET_PROP/SET_INDEX (accessor halves via
  // WRAP_GETTER/WRAP_SETTER), and the CLASS_LINK opcode. The
  // whole class evaluates inside one hidden scope (SCOPE_PUSH/POP) that
  // carries `@`-prefixed bindings user code cannot spell:
  //
  //   @super    the parent constructor (extends only)
  //   @proto    the prototype object under construction
  //   @ctor     the user constructor closure (when present)
  //   @field_N  one closure per instance-field initializer
  //   @fields   one closure that runs every @field_N in order
  //   @args     the synthesized wrapper's rest parameter
  //   @class    the finished class constructor
  //
  // Constructor synthesis:
  //   derived + user ctor            → the user ctor IS the class closure
  //                                    (super() sites run @fields inline)
  //   base + user ctor + no fields   → the user ctor IS the class closure
  //   anything else                  → wrapper closure: fields and/or
  //                                    @super.apply / @ctor.apply(this, @args)
  //
  // Static members are token-snapshot deferred (the parseFunctionParams
  // default-value pattern) and re-parsed after @class exists, so their
  // stores land directly on the class function object.
  // ===========================================================================

  classDeclaration(isExported = false) {
    const startTok = this.previous; // `class`
    this.consume(TokenType.IDENTIFIER, 'Expected class name');
    const nameTok = this.previous;
    const name = this.internString(nameTok.value);
    this.lastFunctionDeclarationName = nameTok.value;
    const classNode = this.classTail(startTok, name, nameTok, isExported, false);
    // Bind the class in the enclosing scope (let-like, matches JS).
    this.emitWithSource(OP.LET_VAR, name, 0, nameTok.start, nameTok.end, classNode);
    return classNode;
  }

  classExpression() {
    const startTok = this.previous; // `class`
    let name = 0;
    let nameTok = null;
    if (this.check(TokenType.IDENTIFIER)) {
      this.advance();
      nameTok = this.previous;
      name = this.internString(nameTok.value);
    }
    // Leaves the class value on the pending stack.
    return this.classTail(startTok, name, nameTok, false, true);
  }

  classTail(startTok, nameOffset, nameTok, isExported, isExpression) {
    const S = (s) => this.internString(s);
    this.emit(OP.SCOPE_PUSH);

    let heritageNode = 0;
    const isDerived = this.match(TokenType.EXTENDS);
    if (isDerived) {
      // JS evaluates the heritage before the body (LeftHandSideExpression).
      heritageNode = this.parsePrecedence(PREC.CALL);
      this.emit(OP.LET_VAR, S('@super'));
    }
    this.consume(TokenType.LBRACE, "Expected '{' before class body");

    // Private-name prescan: collect every depth-1 #name declaration so
    // methods can reference private members declared later in the body
    // (JS allows forward references). Each name mangles to a hidden
    // '@'-prefixed key; the class id is the class's first bytecode index,
    // unique per session and stable across snapshot/restore.
    const classId = this.here;
    const privateNames = new Map();
    this.scanPrivateDeclarations(classId, privateNames);
    this.privateNameStack.push(privateNames);

    this.emit(OP.MAKE_OBJECT, 0);
    this.emit(OP.LET_VAR, S('@proto'));

    const state = { isDerived, fieldCount: 0, hasCtor: false };
    const memberNodes = [];
    const deferredStatics = [];

    while (!this.check(TokenType.RBRACE) && !this.check(TokenType.EOF)) {
      if (this.match(TokenType.SEMICOLON)) continue;

      // `static` is contextual: a modifier only when a member follows;
      // otherwise it is a member NAME (`static() {}`, `static = 1`).
      let isStaticMember = false;
      if (this.check(TokenType.IDENTIFIER) && this.current.value === 'static') {
        const savedLexer = this.lexer.saveState();
        const savedCurrent = this.current;
        const savedPrevious = this.previous;
        this.advance();
        if (this.check(TokenType.LPAREN) || this.check(TokenType.ASSIGN)
            || this.check(TokenType.SEMICOLON) || this.check(TokenType.RBRACE)) {
          this.lexer.restoreState(savedLexer);
          this.current = savedCurrent;
          this.previous = savedPrevious;
        } else {
          isStaticMember = true;
        }
        if (isStaticMember && this.check(TokenType.LBRACE)) {
          // Static initialization block: defer like every static member;
          // the rewind wraps the block in a closure called with
          // `this` = the class.
          const snapLexer = this.lexer.saveState();
          const snapCurrent = this.current;
          const snapPrevious = this.previous;
          this.advance(); // consume `{`
          this.skimBalanced();
          memberNodes.push(0);
          deferredStatics.push({
            memberIndex: memberNodes.length - 1,
            kind: 'block',
            snapLexer, snapCurrent, snapPrevious,
          });
          continue;
        }
      }

      if (isStaticMember) {
        // Defer: statics store onto the class function object, which
        // does not exist yet. Snapshot the tokens, skim past the member,
        // re-parse after @class is bound (same snapshot/rewind pattern
        // parameter defaults use).
        const snapLexer = this.lexer.saveState();
        const snapCurrent = this.current;
        const snapPrevious = this.previous;
        this.skimClassMemberTail();
        memberNodes.push(0);
        deferredStatics.push({
          memberIndex: memberNodes.length - 1,
          snapLexer, snapCurrent, snapPrevious,
        });
      } else {
        memberNodes.push(this.parseClassMemberTail(false, state));
      }
    }
    this.consume(TokenType.RBRACE, "Expected '}' after class body");

    // @fields: one closure that runs every instance-field initializer in
    // source order with `this` = the instance. Always bound — a derived
    // user constructor references it from its super() site before the
    // parser knows whether fields exist.
    {
      const closureInstr = this.emit(OP.MAKE_CLOSURE, 0, 0);
      const jumpInstr = this.emit(OP.JUMP, 0);
      const bodyStart = this.here;
      this.emit(OP.RECONCILE_PARAMS, 0, 0);
      for (let i = 0; i < state.fieldCount; i++) {
        // @field_i.call(this) — CALL_METHOD binds `this` to the receiver,
        // so the receiver/method pair IS call-with-this.
        this.emit(OP.GET_VAR, S('this'));
        this.emit(OP.GET_VAR, S(`@field_${i}`));
        this.emit(OP.CALL_METHOD, 0);
        this.emit(OP.POP);
      }
      this.emit(OP.RETURN_UNDEFINED);
      const bodyEnd = this.here;
      this.patch(closureInstr, bodyStart);
      this.patchOperand2(closureInstr, bodyEnd);
      this.patch(jumpInstr, bodyEnd);
      this.emit(OP.LET_VAR, S('@fields'));
    }

    // Select the class closure according to the synthesis rules above.
    if (state.hasCtor && (state.isDerived || state.fieldCount === 0)) {
      this.emit(OP.GET_VAR, S('@ctor'));
    } else {
      const closureInstr = this.emit(OP.MAKE_CLOSURE, 0, 0);
      const jumpInstr = this.emit(OP.JUMP, 0);
      const bodyStart = this.here;
      this.emit(OP.RECONCILE_PARAMS, 1, 1); // one rest parameter
      this.emit(OP.LET_VAR, S('@args'));
      if (state.isDerived) {
        // Default derived constructor: super(...args), then fields.
        // [this, @super, @args] CALL_METHOD_SPREAD calls @super with
        // `this` bound and the rest array unpacked — no property hop
        // through .apply, so a (parent) static named apply cannot
        // hijack the dispatch.
        this.emit(OP.GET_VAR, S('this'));
        this.emit(OP.GET_VAR, S('@super'));
        this.emit(OP.GET_VAR, S('@args'));
        // operand2 bit 0: propagate @newtarget (and enable the built-in
        // parent branch) exactly like an explicit super() call.
        this.emit(OP.CALL_METHOD_SPREAD, 0, 1);
        this.emit(OP.POP);
        this.emitHiddenThisCall('@fields');
      } else {
        // Base: fields first, then the user constructor when present.
        this.emitHiddenThisCall('@fields');
        if (state.hasCtor) {
          this.emit(OP.GET_VAR, S('this'));
          this.emit(OP.GET_VAR, S('@ctor'));
          this.emit(OP.GET_VAR, S('@args'));
          // operand2 bit 0: the trampoline is the same invocation — the
          // user constructor must see the class closure's @newtarget.
          this.emit(OP.CALL_METHOD_SPREAD, 0, 1);
          // Return the call result so a constructor return-object
          // override survives through OP_NEW.
          this.emit(OP.RETURN);
        }
      }
      this.emit(OP.RETURN_UNDEFINED);
      const bodyEnd = this.here;
      this.patch(closureInstr, bodyStart);
      this.patchOperand2(closureInstr, bodyEnd);
      this.patch(jumpInstr, bodyEnd);
    }
    this.emit(OP.LET_VAR, S('@class'));

    // Wire prototype, constructor back-reference, inheritance edges.
    this.emit(OP.GET_VAR, S('@class'));
    this.emit(OP.GET_VAR, S('@proto'));
    this.emit(OP.SET_PROP, S('prototype'));
    this.emit(OP.POP);
    this.emit(OP.GET_VAR, S('@proto'));
    this.emit(OP.GET_VAR, S('@class'));
    this.emit(OP.SET_PROP, S('constructor'));
    this.emit(OP.POP);
    // `name` property (JS Class.name parity). Stored before the deferred
    // statics so a `static name = ...` member shadows it, matching the
    // JavaScript order. An anonymous class expression gets none
    // (documented deviation: JS infers one from the binding).
    if (nameOffset) {
      this.emit(OP.GET_VAR, S('@class'));
      this.emit(OP.LIT_STRING, nameOffset);
      this.emit(OP.SET_PROP, S('name'));
      this.emit(OP.POP);
    }
    if (isDerived) {
      this.emit(OP.GET_VAR, S('@super'));
      this.emit(OP.GET_VAR, S('@class'));
      this.emit(OP.CLASS_LINK);
      this.emit(OP.POP);
    }

    // Inner self-reference: the class name is visible (const) inside the
    // body scope. Bound BEFORE the deferred statics — JS initializes the
    // class binding before static blocks and static field initializers
    // run, and those routinely name the class.
    if (nameOffset) {
      this.emit(OP.GET_VAR, S('@class'));
      this.emitWithSource(OP.LET_VAR, nameOffset, SCOPE_FLAG_CONST,
        nameTok.start, nameTok.end, 0);
    }

    // Deferred statics: rewind and emit against @class.
    for (const d of deferredStatics) {
      const hereLexer = this.lexer.saveState();
      const hereCurrent = this.current;
      const herePrevious = this.previous;
      this.lexer.restoreState(d.snapLexer);
      this.current = d.snapCurrent;
      this.previous = d.snapPrevious;
      memberNodes[d.memberIndex] = d.kind === 'block'
        ? this.parseStaticBlock(state)
        : this.parseClassMemberTail(true, state);
      this.lexer.restoreState(hereLexer);
      this.current = hereCurrent;
      this.previous = herePrevious;
    }


    this.emit(OP.GET_VAR, S('@class'));
    this.emit(OP.SCOPE_POP);
    this.privateNameStack.pop();

    return this.ast ? this.ast.writeClassDecl({
      nameOffset,
      heritage: heritageNode,
      members: memberNodes,
      flags: (isExported ? FLAG.CLASS_EXPORTED : 0)
        | (isExpression ? FLAG.CLASS_EXPRESSION : 0),
      pos: this.pos(startTok),
    }) : 0;
  }

  /**
   * Parse one class member and emit its store. Instance members store
   * onto @proto during the body pass; static members reach here only on
   * the post-@class rewind and store onto @class.
   */
  parseClassMemberTail(isStatic, state) {
    const S = (s) => this.internString(s);
    const startTok = this.current;
    const targetVar = isStatic ? '@class' : '@proto';
    const memberFlags = isStatic ? FLAG.MEMBER_STATIC : 0;

    // `async` modifier — a modifier only when a member key (or `*`)
    // follows; otherwise `async` is the member name.
    let isAsync = false;
    if (this.check(TokenType.ASYNC)) {
      const savedLexer = this.lexer.saveState();
      const savedCurrent = this.current;
      const savedPrevious = this.previous;
      this.advance();
      if (this.check(TokenType.IDENTIFIER) || this.check(TokenType.STRING)
          || this.check(TokenType.NUMBER) || this.check(TokenType.INTEGER)
          || this.check(TokenType.LBRACKET) || this.check(TokenType.STAR)
          || this.check(TokenType.PRIVATE_NAME)
          || (this.current && KEYWORD_TOKEN_TYPES.has(this.current.type))) {
        isAsync = true;
      } else {
        this.lexer.restoreState(savedLexer);
        this.current = savedCurrent;
        this.previous = savedPrevious;
      }
    }

    const isGenerator = this.match(TokenType.STAR);

    // `get` / `set` accessor keyword — contextual like object literals.
    let accessorKind = null;
    if (!isAsync && !isGenerator && this.check(TokenType.IDENTIFIER)
        && (this.current.value === 'get' || this.current.value === 'set')) {
      const savedLexer = this.lexer.saveState();
      const savedCurrent = this.current;
      const savedPrevious = this.previous;
      const kind = this.current.value;
      this.advance();
      if (this.check(TokenType.IDENTIFIER) || this.check(TokenType.STRING)
          || this.check(TokenType.NUMBER) || this.check(TokenType.INTEGER)
          || this.check(TokenType.LBRACKET)
          || this.check(TokenType.PRIVATE_NAME)
          || (this.current && KEYWORD_TOKEN_TYPES.has(this.current.type))) {
        accessorKind = kind;
      } else {
        this.lexer.restoreState(savedLexer);
        this.current = savedCurrent;
        this.previous = savedPrevious;
      }
    }
    const accessorFlags = accessorKind === 'get' ? FLAG.MEMBER_GETTER
      : accessorKind === 'set' ? FLAG.MEMBER_SETTER : 0;

    // Computed key. A computed method/accessor evaluates its key here
    // (class-evaluation time, matching JS). A computed FIELD also
    // evaluates its key here, captured in a hidden @fieldkey binding the
    // per-instance initializer closure reads — JS evaluates field keys
    // once at class evaluation, never per instance.
    if (this.check(TokenType.LBRACKET)) {
      this.advance(); // `[`
      const keyNode = this.expression();
      this.consume(TokenType.RBRACKET, "Expected ']' to close computed key");
      if (this.check(TokenType.LPAREN)) {
        // Method or accessor: [target, key] then the closure.
        this.emit(OP.GET_VAR, S(targetVar));
        this.emit(OP.SWAP);
        const fnNode = this.classMethodClosure(
          accessorKind ? false : isAsync,
          accessorKind ? false : isGenerator,
          this.memberSuperKind(isStatic, state));
        if (accessorKind) {
          this.emit(accessorKind === 'get' ? OP.WRAP_GETTER : OP.WRAP_SETTER);
        }
        this.emit(OP.SET_INDEX);
        this.emit(OP.POP);
        return this.ast ? this.ast.writeClassMember({
          key: keyNode, value: fnNode,
          flags: memberFlags | accessorFlags | FLAG.MEMBER_KEY_COMPUTED,
          pos: this.pos(startTok),
        }) : 0;
      }
      if (accessorKind) {
        throw this.error(`Expected '(' after ${accessorKind} accessor name`);
      }
      if (isAsync || isGenerator) {
        throw this.error('Expected a method body');
      }
      // Computed field.
      if (isStatic) {
        // [key] → [class, key] → [class, key, value] → SET_INDEX.
        this.emit(OP.GET_VAR, S(targetVar));
        this.emit(OP.SWAP);
        const initNode = this.emitStaticFieldValue(state);
        this.emit(OP.SET_INDEX);
        this.emit(OP.POP);
        this.match(TokenType.SEMICOLON);
        return this.ast ? this.ast.writeClassMember({
          key: keyNode, value: initNode,
          flags: memberFlags | FLAG.MEMBER_FIELD | FLAG.MEMBER_KEY_COMPUTED,
          pos: this.pos(startTok),
        }) : 0;
      }
      const fieldKeyIndex = state.fieldCount;
      this.emit(OP.LET_VAR, S(`@fieldkey_${fieldKeyIndex}`));
      const initNode = this.emitInstanceFieldClosure(state, 0, fieldKeyIndex);
      this.match(TokenType.SEMICOLON);
      return this.ast ? this.ast.writeClassMember({
        key: keyNode, value: initNode,
        flags: memberFlags | FLAG.MEMBER_FIELD | FLAG.MEMBER_KEY_COMPUTED,
        pos: this.pos(startTok),
      }) : 0;
    }

    // Named key (identifier, string, number, reserved word, or #private).
    const keyStartTok = this.current;
    let keyName;
    let keyId;
    let isPrivate = false;
    if (this.match(TokenType.PRIVATE_NAME)) {
      isPrivate = true;
      keyName = this.previous.value; // '#x', the source spelling
      if (keyName === '#constructor') {
        throw this.error("A private member cannot be named '#constructor'");
      }
      // Prescan registered every depth-1 declaration; storage key is the
      // hidden mangled name, the AST keeps the source spelling.
      keyId = this.privateNameStack[this.privateNameStack.length - 1].get(keyName);
      if (keyId === undefined) {
        throw this.error(`Private name ${keyName} is not declared in this class`);
      }
    } else if (this.match(TokenType.IDENTIFIER) || this.match(TokenType.STRING)) {
      keyName = this.previous.value;
    } else if (this.match(TokenType.NUMBER) || this.match(TokenType.INTEGER)) {
      keyName = String(this.previous.value);
    } else if (this.current && KEYWORD_TOKEN_TYPES.has(this.current.type)) {
      this.advance();
      keyName = this.previous.value;
    } else {
      throw this.error('Expected class member name');
    }
    if (keyId === undefined) keyId = S(keyName);
    const keyNode = this.ast
      ? (keyStartTok.type === TokenType.STRING
        ? this.ast.writeLiteralString(S(keyName), this.pos(keyStartTok))
        : this.ast.writeIdentifier(S(keyName), this.pos(keyStartTok)))
      : 0;
    const privateFlags = isPrivate ? FLAG.MEMBER_PRIVATE : 0;

    if (isStatic && keyName === 'prototype') {
      // `static prototype` is a JS SyntaxError.
      throw this.error("A static member cannot be named 'prototype'");
    }


    if (this.check(TokenType.LPAREN)) {
      if (!isStatic && keyName === 'constructor' && !accessorKind) {
        if (isAsync || isGenerator) {
          throw this.error('The constructor cannot be async or a generator');
        }
        if (state.hasCtor) {
          throw this.error('A class may only have one constructor');
        }
        state.hasCtor = true;
        const fnNode = this.classMethodClosure(false, false,
          state.isDerived ? 'ctor-derived' : 'ctor-base');
        this.emit(OP.LET_VAR, S('@ctor'));
        return this.ast ? this.ast.writeClassMember({
          key: keyNode, value: fnNode,
          flags: memberFlags | FLAG.MEMBER_CTOR,
          pos: this.pos(startTok),
        }) : 0;
      }
      // Method or accessor.
      this.emit(OP.GET_VAR, S(targetVar));
      const fnNode = this.classMethodClosure(isAsync, isGenerator,
        this.memberSuperKind(isStatic, state));
      if (accessorKind) {
        this.emit(accessorKind === 'get' ? OP.WRAP_GETTER : OP.WRAP_SETTER);
      }
      this.emit(OP.SET_PROP, keyId);
      this.emit(OP.POP);
      return this.ast ? this.ast.writeClassMember({
        key: keyNode, value: fnNode,
        flags: memberFlags | accessorFlags | privateFlags,
        pos: this.pos(startTok),
      }) : 0;
    }

    // Field.
    if (accessorKind) {
      throw this.error(`Expected '(' after ${accessorKind} accessor name`);
    }
    if (isAsync || isGenerator) {
      throw this.error('Expected a method body');
    }
    if (!isStatic && keyName === 'constructor') {
      throw this.error("'constructor' must be a method");
    }

    if (isStatic) {
      // Static field: evaluated once, now (rewind time), onto @class.
      // The initializer runs inside a hidden closure called with
      // `this` = the class, so `this.other` works (JS semantics).
      this.emit(OP.GET_VAR, S(targetVar));
      const initNode = this.emitStaticFieldValue(state);
      this.emit(OP.SET_PROP, keyId);
      this.emit(OP.POP);
      this.match(TokenType.SEMICOLON);
      return this.ast ? this.ast.writeClassMember({
        key: keyNode, value: initNode,
        flags: memberFlags | FLAG.MEMBER_FIELD | privateFlags,
        pos: this.pos(startTok),
      }) : 0;
    }

    // Instance field: one hidden closure per initializer, run by @fields
    // with `this` = the instance. The closure keeps the initializer's
    // scope isolated from constructor parameters (JS field initializers
    // cannot see them).
    const initNode = this.emitInstanceFieldClosure(state, keyId, -1);
    this.match(TokenType.SEMICOLON);
    return this.ast ? this.ast.writeClassMember({
      key: keyNode, value: initNode,
      flags: memberFlags | FLAG.MEMBER_FIELD | privateFlags,
      pos: this.pos(startTok),
    }) : 0;
  }

  /**
   * Emit one instance-field initializer closure and bind it to
   * @field_N. A named field stores through SET_PROP `keyId`; a computed
   * field (`keyId` 0, `fieldKeyIndex` >= 0) stores through SET_INDEX
   * with the pre-evaluated @fieldkey_N binding. Returns the initializer
   * AST offset (0 when the field has none).
   */
  emitInstanceFieldClosure(state, keyId, fieldKeyIndex) {
    const S = (s) => this.internString(s);
    const fieldIndex = state.fieldCount;
    state.fieldCount++;
    const closureInstr = this.emit(OP.MAKE_CLOSURE, 0, 0);
    const jumpInstr = this.emit(OP.JUMP, 0);
    const bodyStart = this.here;
    this.emit(OP.RECONCILE_PARAMS, 0, 0);
    this.emit(OP.GET_VAR, S('this'));
    if (fieldKeyIndex >= 0) {
      this.emit(OP.GET_VAR, S(`@fieldkey_${fieldKeyIndex}`));
    }
    let initNode = 0;
    if (this.match(TokenType.ASSIGN)) {
      this.superStack.push({
        kind: state.isDerived ? 'method-derived' : 'method-base',
        superCalls: 0,
      });
      this.functionStack.push({ isAsync: false, isGenerator: false, isArrow: false });
      initNode = this.expression();
      this.functionStack.pop();
      this.superStack.pop();
    } else {
      this.emit(OP.LIT_UNDEFINED);
    }
    if (fieldKeyIndex >= 0) {
      this.emit(OP.SET_INDEX);
    } else {
      this.emit(OP.SET_PROP, keyId);
    }
    this.emit(OP.POP);
    this.emit(OP.RETURN_UNDEFINED);
    const bodyEnd = this.here;
    this.patch(closureInstr, bodyStart);
    this.patchOperand2(closureInstr, bodyEnd);
    this.patch(jumpInstr, bodyEnd);
    this.emit(OP.LET_VAR, S(`@field_${fieldIndex}`));
    return initNode;
  }

  /**
   * Emit a static-field value onto the stack. An initializer runs inside
   * a hidden closure called with `this` = the class ([@class, closure]
   * CALL_METHOD 0). A field with no initializer pushes undefined.
   * Returns the initializer AST offset (0 when absent).
   */
  emitStaticFieldValue(state) {
    const S = (s) => this.internString(s);
    if (!this.match(TokenType.ASSIGN)) {
      this.emit(OP.LIT_UNDEFINED);
      return 0;
    }
    this.emit(OP.GET_VAR, S('@class'));
    const closureInstr = this.emit(OP.MAKE_CLOSURE, 0, 0);
    const jumpInstr = this.emit(OP.JUMP, 0);
    const bodyStart = this.here;
    this.emit(OP.RECONCILE_PARAMS, 0, 0);
    this.superStack.push({
      kind: state.isDerived ? 'static-derived' : 'static-base',
      superCalls: 0,
    });
    this.functionStack.push({ isAsync: false, isGenerator: false, isArrow: false });
    const initNode = this.expression();
    this.functionStack.pop();
    this.superStack.pop();
    this.emit(OP.RETURN);
    const bodyEnd = this.here;
    this.patch(closureInstr, bodyStart);
    this.patchOperand2(closureInstr, bodyEnd);
    this.patch(jumpInstr, bodyEnd);
    this.emit(OP.CALL_METHOD, 0);
    return initNode;
  }

  /**
   * Parse a `static { ... }` initialization block at rewind time: the
   * block compiles to a parameterless closure called with `this` = the
   * class. The token snapshot points at the block's `{`.
   */
  parseStaticBlock(state) {
    const S = (s) => this.internString(s);
    const startTok = this.current; // `{`
    this.emit(OP.GET_VAR, S('@class'));
    this.consume(TokenType.LBRACE, "Expected '{' to open the static block");
    this.pendingSuperKind = state.isDerived ? 'static-derived' : 'static-base';
    const { bodyBlock, closureInstr } = this.emitFunctionBody([], false, false, false);
    const fnNode = this.ast ? this.ast.writeFunctionDecl({
      nameOffset: 0,
      params: [],
      body: bodyBlock,
      flags: 0,
      pos: this.pos(startTok),
    }) : 0;
    this.attributeInstruction(closureInstr, fnNode);
    this.emit(OP.CALL_METHOD, 0);
    this.emit(OP.POP);
    return this.ast ? this.ast.writeClassMember({
      key: 0, value: fnNode,
      flags: FLAG.MEMBER_STATIC | FLAG.MEMBER_STATIC_BLOCK,
      pos: this.pos(startTok),
    }) : 0;
  }

  /**
   * Prescan the class body from the token after `{`, collecting every
   * depth-1 #name declaration into `map` (name → mangled hidden key).
   * The lexer state is restored afterwards.
   */
  scanPrivateDeclarations(classId, map) {
    const savedLexer = this.lexer.saveState();
    const savedCurrent = this.current;
    const savedPrevious = this.previous;
    let depth = 1;
    while (depth > 0 && !this.check(TokenType.EOF)) {
      if (this.check(TokenType.LBRACE)) {
        depth++;
      } else if (this.check(TokenType.RBRACE)) {
        depth--;
      } else if (depth === 1 && this.check(TokenType.PRIVATE_NAME)) {
        const sourceName = this.current.value;
        if (!map.has(sourceName)) {
          map.set(sourceName, this.internString(`@${sourceName}_${classId}`));
        }
      }
      this.advance();
    }
    this.lexer.restoreState(savedLexer);
    this.current = savedCurrent;
    this.previous = savedPrevious;
  }

  /**
   * Resolve a PRIVATE_NAME token to its mangled hidden key, searching
   * enclosing class bodies innermost-first (JS private-name scoping).
   */
  resolvePrivateName(token) {
    for (let i = this.privateNameStack.length - 1; i >= 0; i--) {
      const found = this.privateNameStack[i].get(token.value);
      if (found !== undefined) return found;
    }
    throw this.error(
      `Private name ${token.value} is not declared in an enclosing class`);
  }

  memberSuperKind(isStatic, state) {
    if (state.isDerived) return isStatic ? 'static-derived' : 'method-derived';
    return isStatic ? 'static-base' : 'method-base';
  }

  /**
   * Parse `(params) { body }` for a class method/accessor/constructor.
   * Expects check(LPAREN) to hold. Returns the FUNCTION_DECL AST offset.
   */
  classMethodClosure(isAsync, isGenerator, superKind) {
    const startTok = this.current; // `(`
    this.advance();
    const params = this.parseFunctionParams();
    this.consume(TokenType.LBRACE, "Expected '{' before method body");
    this.pendingSuperKind = superKind;
    const { paramBindings, bodyBlock, closureInstr } =
      this.emitFunctionBody(params, false, isAsync, isGenerator);
    const fnNode = this.ast ? this.ast.writeFunctionDecl({
      nameOffset: 0,
      params: paramBindings,
      body: bodyBlock,
      flags: (isAsync ? FLAG.FN_ASYNC : 0) | (isGenerator ? FLAG.FN_GENERATOR : 0),
      pos: this.pos(startTok),
    }) : 0;
    this.attributeInstruction(closureInstr, fnNode);
    return fnNode;
  }

  /**
   * Emit `<hiddenVar>.call(this)` and drop the result.
   */
  emitHiddenThisCall(hiddenVar) {
    // [this, closure] CALL_METHOD 0 — CALL_METHOD binds `this` to the
    // receiver, so this IS call-with-this with no .call property hop.
    this.emit(OP.GET_VAR, this.internString('this'));
    this.emit(OP.GET_VAR, this.internString(hiddenVar));
    this.emit(OP.CALL_METHOD, 0);
    this.emit(OP.POP);
  }

  /**
   * Skim one class member (modifiers, key, and value) without emitting.
   * Used to defer static members past the class-closure emission.
   */
  skimClassMemberTail() {
    while (!this.check(TokenType.EOF)) {
      if (this.check(TokenType.LBRACKET)) {
        this.advance();
        this.skimBalanced();
        continue;
      }
      if (this.check(TokenType.LPAREN)) {
        this.advance();
        this.skimBalanced();
        this.consume(TokenType.LBRACE, "Expected '{' before method body");
        this.skimBalanced();
        return;
      }
      if (this.check(TokenType.ASSIGN)) {
        this.advance();
        // Field initializer: to the `;` or the class body's `}` at depth 0.
        let depth = 0;
        while (!this.check(TokenType.EOF)) {
          if (depth === 0
              && (this.check(TokenType.SEMICOLON) || this.check(TokenType.RBRACE))) {
            return;
          }
          if (this.check(TokenType.LBRACKET) || this.check(TokenType.LPAREN)
              || this.check(TokenType.LBRACE)) {
            depth++;
          } else if (this.check(TokenType.RBRACKET) || this.check(TokenType.RPAREN)
              || this.check(TokenType.RBRACE)) {
            depth--;
          }
          this.advance();
        }
        throw this.error('Unterminated field initializer');
      }
      if (this.check(TokenType.SEMICOLON) || this.check(TokenType.RBRACE)) {
        return; // field with no initializer
      }
      this.advance(); // modifier or key token
    }
    throw this.error('Unterminated class body');
  }

  /**
   * `super` expression (primary). Legal shapes, all in a class with
   * `extends`:
   *   super(args)      — inside a constructor, exactly once
   *   super.m(args)    — method call through the parent chain
   *   super.x          — property read (parent getter runs with this)
   *   super.x = v      — property write (parent setter intercepts, else
   *                      own define on this); compound forms compose
   */
  superExpression(canAssign) {
    const startTok = this.previous; // `super`
    const S = (s) => this.internString(s);
    const frame = this.superStack.length > 0
      ? this.superStack[this.superStack.length - 1] : null;
    const kind = frame ? frame.kind : 'none';
    if (kind === 'none') {
      throw this.error("'super' is only valid inside a class method");
    }
    if (kind === 'ctor-base' || kind === 'method-base' || kind === 'static-base') {
      throw this.error("'super' requires a class with 'extends'");
    }
    const superNode = this.ast ? this.ast.writeSuper(this.pos(startTok)) : 0;

    if (this.match(TokenType.LPAREN)) {
      if (kind !== 'ctor-derived') {
        throw this.error('super() is only valid inside a constructor');
      }
      frame.superCalls++;
      if (frame.superCalls > 1) {
        throw this.error('Call super() exactly once in a constructor');
      }
      // [this, @super] then the standard method-call argument machinery:
      // CALL_METHOD binds `this` to the receiver, so no .call property
      // hop exists for a shadowing static to hijack. The super-call flag
      // makes the dispatch propagate `@newtarget` to the parent.
      this.emit(OP.GET_VAR, S('this'));
      this.emit(OP.GET_VAR, S('@super'));
      this.pendingMethodCall = true;
      this.pendingSuperCall = true;
      const node = this.call(false, superNode);
      // JS runs field initializers when super() returns.
      this.emitHiddenThisCall('@fields');
      return node;
    }

    this.consume(TokenType.DOT, "Expected '(' or '.' after 'super'");
    if (this.check(TokenType.PRIVATE_NAME)) {
      throw this.error('super cannot access a private member');
    }
    this.consumePropertyName();
    const propTok = this.previous;
    const name = S(propTok.value);
    const memberNode = this.ast
      ? this.ast.writeMemberAccess(superNode, name, this.pos(propTok)) : 0;

    // [this, @super(.prototype)] — the receiver under the lookup start.
    // GET_SUPER/SET_SUPER walk the chain FROM the start and run accessor
    // halves with `this` = the receiver.
    const emitReceiverAndStart = () => {
      this.emit(OP.GET_VAR, S('this'));
      this.emit(OP.GET_VAR, S('@super'));
      if (kind !== 'static-derived') {
        this.emit(OP.GET_PROP, S('prototype'));
      }
    };

    if (this.match(TokenType.LPAREN)) {
      // Method call: GET_SUPER leaves [this, method] for CALL_METHOD, so
      // a getter-backed member load also runs with `this` = receiver.
      emitReceiverAndStart();
      this.emit(OP.GET_SUPER, name, 0, memberNode);
      this.pendingMethodCall = true;
      return this.call(false, memberNode);
    }

    if (this.pendingDeleteTarget) {
      throw this.error('Cannot delete a super property');
    }
    if (canAssign && this.match(TokenType.ASSIGN)) {
      emitReceiverAndStart();
      const valueAst = this.expression();
      const node = this.ast
        ? this.ast.writeAssignment(AssignOp.EQ, memberNode, valueAst, this.pos(propTok)) : 0;
      this.emit(OP.SET_SUPER, name, 0, node);
      return node;
    }
    if (canAssign && this.matchCompoundAssign()) {
      const compoundOp = this.previous.type;
      // Read first — [this, start, this, old] — then the right side; the
      // kept inner receiver is dropped after the combine.
      emitReceiverAndStart();
      emitReceiverAndStart();
      this.emit(OP.GET_SUPER, name, 0, memberNode);
      const valueAst = this.expression();
      const opKind = assignOpFromToken(compoundOp);
      this.emitCompoundOp(compoundOp);
      this.emit(OP.SWAP);
      this.emit(OP.POP);
      const node = this.ast
        ? this.ast.writeAssignment(opKind, memberNode, valueAst, this.pos(propTok)) : 0;
      this.emit(OP.SET_SUPER, name, 0, node);
      return node;
    }
    // Plain read: [this, start] -> [this, value] -> [value].
    emitReceiverAndStart();
    this.emit(OP.GET_SUPER, name, 0, memberNode);
    this.emit(OP.SWAP);
    this.emit(OP.POP);
    return memberNode;
  }

  /**
   * Parse async declaration or expression statement.
   * Called after consuming 'async' keyword.
   * Handles: async function name() {}, async () => ..., async x => ...
   */
  asyncDeclarationOrExpression() {
    // async function declaration
    if (this.match(TokenType.FUNCTION)) {
      return this.functionDeclaration(true);
    }

    // async arrow function: async () => ... or async x => ...
    // This is an expression statement
    const startTok = this.previous; // `async`
    const startPos = startTok.start;
    let fnNode = 0;

    if (this.check(TokenType.LPAREN)) {
      // async () => ... or async (params) => ...
      this.advance(); // consume (

      const params = [];
      if (!this.check(TokenType.RPAREN)) {
        do {
          this.consume(TokenType.IDENTIFIER, "Expected parameter name");
          params.push(this.previous.value);
        } while (this.match(TokenType.COMMA));
      }
      this.consume(TokenType.RPAREN, "Expected ')' after parameters");
      fnNode = this.arrowFunction(params, startPos, true, startTok);
    } else if (this.check(TokenType.IDENTIFIER)) {
      // async x => ...
      this.consume(TokenType.IDENTIFIER, "Expected parameter name");
      const params = [this.previous.value];
      fnNode = this.arrowFunction(params, startPos, true, startTok);
    } else {
      this.error("Expected '(' or identifier after 'async'");
    }

    this.pendingPop = true; // This was an expression statement
    return this.ast ? this.ast.writeExpressionStatement(fnNode, this.pos(startTok)) : 0;
  }

  /**
   * Parse variable declaration: let/const/var name = value, name2 = value2, ...
   * @param {boolean} isConst - true for const declarations (requires initializer, sets const flag)
   */
  variableDeclaration(isConst) {
    const declTok = this.previous; // `let` / `const` / `var`
    const flags = isConst ? SCOPE_FLAG_CONST : 0;
    const bindings = [];

    do {
      if (this.check(TokenType.LBRACKET) || this.check(TokenType.LBRACE)) {
        // Destructuring pattern (array `[…]` or object `{…}`).
        // See bindDestructuringPattern for the two-pass rationale.
        // The pattern node itself is the binding entry (its initializer
        // child carries the declaration's right-hand side).
        const { patternOff } = this.bindDestructuringPattern(flags);
        bindings.push(patternOff);
        continue;
      }

      this.consume(TokenType.IDENTIFIER, 'Expected variable name');
      const nameTok = this.previous;
      const varStart = nameTok.start;
      const varEnd = nameTok.end;
      const name = this.internString(nameTok.value);

      let initOff = 0;
      if (this.match(TokenType.ASSIGN)) {
        initOff = this.expression();
      } else if (isConst) {
        throw this.error("Missing initializer in const declaration");
      } else {
        this.emit(OP.LIT_UNDEFINED);
      }

      const bindingOff = this.ast ? this.ast.writeVariableBinding(name, initOff, this.pos(nameTok)) : 0;
      bindings.push(bindingOff);

      // Point LET_VAR to the variable name, pass flags in operand2
      this.emitWithSource(OP.LET_VAR, name, flags, varStart, varEnd, bindingOff);
    } while (this.match(TokenType.COMMA));

    this.match(TokenType.SEMICOLON); // optional semicolon

    return this.ast ? this.ast.writeVariableDecl(bindings, isConst, this.pos(declTok)) : 0;
  }

  /**
   * Bind a destructuring pattern declaration: `let <pattern> = <rhs>`.
   * The opening token of the pattern (`[` or, in step 3, `{`) is the
   * current token.
   *
   * Two-pass implementation:
   *
   *   Pass 1 (skim): record the lexer position at the opening token,
   *   then walk forward depth-aware until the matching close. That
   *   leaves the lexer positioned at the `=` after the pattern. Skim
   *   does not emit bytecode and does not parse default expressions.
   *
   *   RHS: consume `=`, parse the right-hand expression with the
   *   normal Pratt machinery. Source value lands on the pending stack.
   *
   *   Pass 2 (emit): rewind the lexer to the opening token of the
   *   pattern and parse it again, this time emitting bytecode. Default
   *   expressions inside the pattern (e.g. `[a = expr]`) are parsed
   *   and emitted inline at exactly the spot where they're needed —
   *   inside a JUMP_IF_FALSE guard so they only run when the iterator
   *   yielded undefined.
   *
   * Why two passes:
   *
   *   The pattern's bytecode reads from the source on top of the
   *   pending stack, so the source has to be evaluated first. But the
   *   pattern's bytecode also needs to embed each default expression's
   *   bytecode at the spot in the loop where the default fires — and
   *   the only way to emit a default's bytecode is to parse the
   *   default expression. Either you parse the pattern first and
   *   capture defaults as some kind of deferred-emit token (which
   *   requires an AST-to-bytecode pass we don't have), or you parse
   *   the pattern twice. The second pass is cheap (patterns are
   *   small) and keeps emit-as-you-parse intact.
   *
   * @param {number} flags - SCOPE_FLAG_CONST | 0
   */
  bindDestructuringPattern(flags) {
    const isArray = this.check(TokenType.LBRACKET);
    const isObject = this.check(TokenType.LBRACE);
    if (!isArray && !isObject) {
      throw this.error("Internal: bindDestructuringPattern called on non-pattern");
    }

    // PASS 1: snapshot state, skim past the pattern, expect `=`.
    const patternStart = this.lexer.saveState();
    const savedCurrent = this.current;
    const savedPrevious = this.previous;
    this.advance();  // consume opening `[` or `{`
    this.skimBalanced();
    this.consume(TokenType.ASSIGN,
      "Destructuring declaration requires an initializer");

    // RHS: parse and emit. Source value lands on pending stack.
    const initOff = this.expression();

    // Save post-RHS position to seek to after pass 2.
    const afterRhs = this.lexer.saveState();
    const afterRhsCurrent = this.current;
    const afterRhsPrevious = this.previous;

    // PASS 2: rewind, re-parse the pattern with bytecode emit (and AST
    // pattern-node construction).
    this.lexer.restoreState(patternStart);
    this.current = savedCurrent;
    this.previous = savedPrevious;
    let patternOff;
    if (isArray) {
      patternOff = this.arrayPatternBind(flags);
    } else {
      patternOff = this.objectPatternBind(flags);
    }
    if (this.ast && patternOff) {
      this.ast.patchPatternInitializer(patternOff, initOff);
    }

    // Resume from where the RHS left us.
    this.lexer.restoreState(afterRhs);
    this.current = afterRhsCurrent;
    this.previous = afterRhsPrevious;
    return { patternOff, initOff };
  }

  /**
   * Skim forward depth-aware through balanced brackets. The opening
   * token has already been consumed (current is the next token after
   * `[` / `{`). Advances the lexer until `current` points to the token
   * AFTER the matching closer.
   *
   * Handles `[`, `(`, `{` as openers and their respective closers,
   * tracking nesting depth so a `]` inside `[[…]]` doesn't terminate
   * the outer scan early.
   */
  skimBalanced() {
    // Skims are speculative or structural walks under the DIVISION
    // lexical goal: a RegExp literal like /\d/ inside the skimmed
    // region produces deferred INVALID tokens that the real parse
    // (which re-scans under the RegExp goal) never consumes. Skimming
    // steps over them; genuine lexical errors still surface when the
    // region is actually parsed.
    this.skimming = true;
    try {
      let depth = 1;
      while (depth > 0 && !this.check(TokenType.EOF)) {
        if (this.check(TokenType.LBRACKET) || this.check(TokenType.LPAREN) || this.check(TokenType.LBRACE)) {
          depth++;
        } else if (this.check(TokenType.RBRACKET) || this.check(TokenType.RPAREN) || this.check(TokenType.RBRACE)) {
          depth--;
          if (depth === 0) {
            this.advance();  // consume the matching closer
            return;
          }
        }
        this.advance();
      }
      throw this.error("Unbalanced brackets in destructuring pattern");
    } finally {
      this.skimming = false;
    }
  }

  /**
   * Parse-and-emit an array pattern. Source value is on top of the
   * pending stack. Net stack effect: -1 (source consumed; bindings
   * created in the current scope).
   */
  /**
   * Emit the binding instruction for a user-named destructuring target.
   * Declaration mode (mode='declare') emits LET_VAR; assignment mode
   * (mode='assign') emits SET_VAR — the target is an already-declared
   * binding being overwritten. The pending stack carries the value.
   */
  emitDestructuringBind(name, flags, mode, startPos, endPos) {
    if (mode === 'assign') {
      this.emitWithSource(OP.SET_VAR, name, 0, startPos, endPos, 0);
      this.emit(OP.POP);  // SET_VAR pushes the value back; discard it
    } else {
      this.emitWithSource(OP.LET_VAR, name, flags, startPos, endPos, 0);
    }
  }

  arrayPatternBind(flags, mode = 'declare') {
    const counter = this.destructuringCounter++;
    const srcName = this.internString(`@dst_src_${counter}`);
    const iterName = this.internString(`@dst_iter_${counter}`);

    this.consume(TokenType.LBRACKET, "Expected '[' in array pattern");
    const startTok = this.previous; // `[`

    // Stash source; build iterator. ASSERT_ITERABLE 0 rejects
    // never-iterable sources (null, undefined, numbers, ...) with
    // "Not iterable" before GET_INDEX can throw its generic property
    // error; ASSERT_ITERABLE 1 rejects sources whose Symbol.iterator
    // lookup missed before CALL_METHOD can throw "Not a function".
    this.emit(OP.ASSERT_ITERABLE, 0);
    this.emit(OP.LET_VAR, srcName);
    this.emit(OP.GET_VAR, srcName);
    this.emit(OP.GET_VAR, srcName);
    this.emit(OP.LIT_WELL_KNOWN_SYMBOL, 0);
    this.emit(OP.GET_INDEX);
    this.emit(OP.ASSERT_ITERABLE, 1);
    this.emit(OP.CALL_METHOD, 0);
    this.emit(OP.LET_VAR, iterName);

    const elementOffsets = [];
    let isFirst = true;
    while (!this.check(TokenType.RBRACKET)) {
      if (!isFirst) {
        this.consume(TokenType.COMMA, "Expected ',' between array pattern elements");
      }
      isFirst = false;

      // Hole `[a, , b]` — comma right at element position.
      if (this.check(TokenType.COMMA) || this.check(TokenType.RBRACKET)) {
        const holeTok = this.current;
        this.emitArrayIteratorStep(iterName);
        this.emit(OP.POP);
        if (this.ast) {
          elementOffsets.push(this.ast.writePatternElement({ flags: FLAG.PATTERN_HOLE, pos: this.pos(holeTok) }));
        }
        if (this.check(TokenType.RBRACKET)) break;
        continue;
      }

      // Rest element `...target` (must be last).
      if (this.match(TokenType.DOT_DOT_DOT)) {
        const restTok = this.previous; // `...`
        const target = this.emitArrayRestElement(iterName, flags, mode);
        if (this.ast) {
          elementOffsets.push(this.ast.writePatternElement({
            nameOffset: target.nameOffset,
            nestedPattern: target.nestedPattern,
            flags: FLAG.PATTERN_REST,
            pos: this.pos(restTok),
          }));
        }
        if (this.check(TokenType.COMMA)) {
          throw this.error("Rest element must be last in array pattern");
        }
        break;
      }

      // Regular element. Layout per element is:
      //   <iterator-step pushes value>
      //   [optional default: pop+evaluate default if value undefined]
      //   <consume target name, LET_VAR — pops value>
      // Defaults syntactically come AFTER the target name, but their
      // bytecode must run BEFORE the LET_VAR. Lookahead through the
      // target name (for identifiers it's a single token; for nested
      // patterns we'd need to skim) so we can decide whether to emit
      // the default branch.
      const elementTok = this.current;
      this.emitArrayIteratorStep(iterName);

      // Nested patterns can't carry their own defaults (yet — JS allows
      // `[[a, b] = [0, 0]]` and we'd handle that here). For step 2,
      // nested-target = no default.
      if (this.check(TokenType.LBRACKET)) {
        // Nested array pattern. The value on top is the source.
        const nestedPattern = this.arrayPatternBind(flags, mode);
        if (this.ast) {
          elementOffsets.push(this.ast.writePatternElement({ nestedPattern, pos: this.pos(elementTok) }));
        }
      } else {
        // Identifier target. Capture the name first, then look for `=`.
        this.consume(TokenType.IDENTIFIER,
          "Expected identifier or nested pattern in array destructuring");
        const nameTok = this.previous;
        const name = this.internString(nameTok.value);
        // Optional default: applies only when the value on top is undefined.
        const defaultValue = this.emitDefaultIfUndefined();
        this.emitDestructuringBind(name, flags, mode, nameTok.start, nameTok.end);
        if (this.ast) {
          elementOffsets.push(this.ast.writePatternElement({
            nameOffset: name, defaultValue, pos: this.pos(nameTok),
          }));
        }
      }
    }

    this.consume(TokenType.RBRACKET, "Expected ']' to close array pattern");
    return this.ast ? this.ast.writeArrayPattern(elementOffsets, 0, this.pos(startTok)) : 0;
  }

  /**
   * Step the iterator and push the result's .value onto the pending stack.
   * Past-the-end yields .value === undefined, which the caller handles
   * uniformly (defaults trigger; plain targets bind undefined).
   */
  emitArrayIteratorStep(iterName) {
    this.emit(OP.GET_VAR, iterName);
    this.emit(OP.GET_VAR, iterName);
    this.emit(OP.GET_PROP, this.internString('next'));
    this.emit(OP.CALL_METHOD, 0);
    this.emit(OP.ASSERT_ITER_RESULT);
    this.emit(OP.GET_PROP, this.internString('value'));
  }

  /**
   * If the next token is `=`, parse and emit a default-expression branch:
   *   DUP; LIT_UNDEFINED; EQ; JUMP_IF_FALSE skip; POP; <default expr>; skip:
   * Net stack effect: 0 (the value or its default replacement is left
   * on top). Returns the default expression's AST offset (0 if none).
   */
  emitDefaultIfUndefined() {
    if (!this.match(TokenType.ASSIGN)) return 0;
    this.emit(OP.DUP);
    this.emit(OP.LIT_UNDEFINED);
    this.emit(OP.EQ);
    const skip = this.emit(OP.JUMP_IF_FALSE, 0);
    this.emit(OP.POP);
    const defaultOff = this.expression();
    this.patch(skip, this.here);
    return defaultOff;
  }

  /**
   * Bind the value on top of the stack to one pattern element: an
   * identifier (LET_VAR) or a nested array/object pattern (recurse).
   * Returns AST target info: { nameOffset, nestedPattern }.
   */
  bindArrayPatternTarget(flags, mode = 'declare') {
    if (this.check(TokenType.LBRACKET)) {
      const nestedPattern = this.arrayPatternBind(flags, mode);
      return { nameOffset: 0, nestedPattern };
    }
    if (this.check(TokenType.LBRACE)) {
      const nestedPattern = this.objectPatternBind(flags, mode);
      return { nameOffset: 0, nestedPattern };
    }
    this.consume(TokenType.IDENTIFIER,
      "Expected identifier or nested pattern in array destructuring");
    const tok = this.previous;
    const name = this.internString(tok.value);
    this.emitDestructuringBind(name, flags, mode, tok.start, tok.end);
    return { nameOffset: name, nestedPattern: 0 };
  }

  /**
   * Emit a rest element `...target`. Drains the iterator into a fresh
   * array, then binds it.
   */
  emitArrayRestElement(iterName, flags, mode = 'declare') {
    const counter = this.destructuringCounter++;
    const restArrName = this.internString(`@dst_rest_${counter}`);
    const stepName = this.internString(`@dst_rstep_${counter}`);

    this.emit(OP.MAKE_ARRAY, 0);
    this.emit(OP.LET_VAR, restArrName);
    this.emit(OP.LIT_UNDEFINED);
    this.emit(OP.LET_VAR, stepName);

    const loopStart = this.here;
    this.emit(OP.GET_VAR, iterName);
    this.emit(OP.GET_VAR, iterName);
    this.emit(OP.GET_PROP, this.internString('next'));
    this.emit(OP.CALL_METHOD, 0);
    this.emit(OP.ASSERT_ITER_RESULT);
    this.emit(OP.SET_VAR, stepName);
    this.emit(OP.POP);  // SET_VAR pushes the value back; we used it as a statement.

    this.emit(OP.GET_VAR, stepName);
    this.emit(OP.GET_PROP, this.internString('done'));
    const exitJump = this.emit(OP.JUMP_IF_TRUE, 0);

    this.emit(OP.GET_VAR, restArrName);
    this.emit(OP.GET_VAR, restArrName);
    this.emit(OP.GET_PROP, this.internString('push'));
    this.emit(OP.GET_VAR, stepName);
    this.emit(OP.GET_PROP, this.internString('value'));
    this.emit(OP.CALL_METHOD, 1);
    this.emit(OP.POP);

    this.emit(OP.JUMP, loopStart);
    this.patch(exitJump, this.here);

    // Push the collected rest array and bind it to the target.
    this.emit(OP.GET_VAR, restArrName);
    return this.bindArrayPatternTarget(flags, mode);
  }

  /**
   * Parse-and-emit an object pattern. Source value is on top of the
   * pending stack. Net stack effect: -1 (source consumed).
   *
   * Properties supported:
   *   { a, b }                  — shorthand
   *   { a: target, b: target }  — renaming / nested
   *   { [expr]: target }        — computed key
   *   { a = 1, b: c = 2 }       — defaults
   *   { a, b, ...rest }         — rest (collects own enumerable
   *                               string-keyed properties not bound
   *                               by earlier elements)
   *
   * Null/undefined source throws TypeError per spec — emitted as a
   * guard at the top.
   */
  objectPatternBind(flags, mode = 'declare') {
    const counter = this.destructuringCounter++;
    const srcName = this.internString(`@dst_src_${counter}`);

    this.consume(TokenType.LBRACE, "Expected '{' in object pattern");
    const startTok = this.previous; // `{`

    // Stash source.
    this.emit(OP.LET_VAR, srcName);

    // Null/undefined check: trying to destructure null or undefined
    // is a TypeError per spec, even for `{} = null`. We let the first
    // GET_PROP do this — but for an empty pattern with no GET_PROPs,
    // we'd miss the check. Emit a defensive guard. The cleanest
    // shape: read any property (e.g. "constructor") just for the
    // side effect of throwing on null/undefined. Simpler: emit an
    // explicit check via `GET_VAR src; LIT_NULL; ==` and throw if
    // matched. For now, rely on the fact that any real pattern has
    // at least one property access; document the empty-pattern hole
    // and revisit if it bites.

    // Track which string keys have been explicitly bound, so that
    // a trailing `...rest` element can skip them. Only string-keyed
    // (non-computed, non-renamed-from-non-identifier) bindings count
    // toward this set — symbol keys and computed keys don't show up
    // in Object.keys(src) anyway. We accumulate string IDs.
    const boundKeyIds = [];
    const propertyOffsets = [];

    let isFirst = true;
    while (!this.check(TokenType.RBRACE)) {
      if (!isFirst) {
        this.consume(TokenType.COMMA, "Expected ',' between object pattern properties");
        // Trailing comma support.
        if (this.check(TokenType.RBRACE)) break;
      }
      isFirst = false;
      const propStartTok = this.current;

      // Rest element `...target` (must be last).
      if (this.match(TokenType.DOT_DOT_DOT)) {
        const restTarget = this.emitObjectRestElement(srcName, boundKeyIds, flags, mode);
        if (this.ast) {
          propertyOffsets.push(this.ast.writePatternElement({
            nameOffset: restTarget.nameOffset,
            nestedPattern: restTarget.nestedPattern,
            flags: FLAG.PATTERN_REST,
            pos: this.pos(propStartTok),
          }));
        }
        if (this.check(TokenType.COMMA)) {
          throw this.error("Rest element must be last in object pattern");
        }
        break;
      }

      // Property: either `[computedExpr]: target` (computed), or
      // `name: target` (renaming / nested), or `name` (shorthand).
      let isComputed = false;
      let keyId = 0;          // string-table id, when known statically
      let isShorthand = false;
      let computedKeyOff = 0;
      let isStringKey = false;

      if (this.match(TokenType.LBRACKET)) {
        // Computed key: push source, then evaluate expr, then GET_INDEX.
        isComputed = true;
        this.emit(OP.GET_VAR, srcName);
        computedKeyOff = this.expression();    // pushes the computed-key expression
        this.consume(TokenType.RBRACKET, "Expected ']' to close computed key");
        this.emit(OP.GET_INDEX);
        // GET_INDEX pops [obj, key], pushes the value.
        this.consume(TokenType.COLON,
          "Computed key must be followed by ':' and a target");
      } else if (this.match(TokenType.STRING)) {
        // String-keyed pattern entry: `{ 'x-y': target }`. Always requires
        // a target — there's no shorthand for string keys (the key isn't
        // a valid identifier).
        const keyTok = this.previous;
        keyId = this.internString(keyTok.value);
        isStringKey = true;
        boundKeyIds.push(keyId);
        this.consume(TokenType.COLON,
          "String-keyed pattern entry requires ':' and a target");
        this.emit(OP.GET_VAR, srcName);
        this.emit(OP.GET_PROP, keyId);
      } else if (this.match(TokenType.NUMBER) || this.match(TokenType.INTEGER)) {
        // Numeric pattern key: `{ 0: target }`. The key is the number's
        // canonical string form (property keys are strings). No shorthand.
        keyId = this.internString(String(this.previous.value));
        isStringKey = true;
        boundKeyIds.push(keyId);
        this.consume(TokenType.COLON,
          "Numeric pattern key requires ':' and a target");
        this.emit(OP.GET_VAR, srcName);
        this.emit(OP.GET_PROP, keyId);
      } else if (this.current && KEYWORD_TOKEN_TYPES.has(this.current.type)) {
        // Reserved word as a pattern key: `{ const: target }`. JS
        // allows any IdentifierName as the key; the binding must be
        // renamed (no shorthand — the target can't be a keyword).
        this.advance();
        const keyTok = this.previous;
        keyId = this.internString(keyTok.value);
        boundKeyIds.push(keyId);
        this.consume(TokenType.COLON,
          `Reserved-word pattern key '${keyTok.value}' requires ':' and a target`);
        this.emit(OP.GET_VAR, srcName);
        this.emit(OP.GET_PROP, keyId);
      } else {
        // Identifier key. Either `name:` (renaming) or `name` (shorthand)
        // or `name = default` (shorthand with default).
        this.consume(TokenType.IDENTIFIER,
          "Expected property name in object pattern");
        const nameTok = this.previous;
        keyId = this.internString(nameTok.value);
        boundKeyIds.push(keyId);

        if (this.match(TokenType.COLON)) {
          // Renaming form: read src[name], leave on stack for the target.
          this.emit(OP.GET_VAR, srcName);
          this.emit(OP.GET_PROP, keyId);
        } else {
          // Shorthand: read src[name], bind to local of the same name
          // (after default if any).
          this.emit(OP.GET_VAR, srcName);
          this.emit(OP.GET_PROP, keyId);
          isShorthand = true;
          // Remember the identifier we just consumed; the target binding
          // is also `name`, and a default may follow.
          this._objPatternShorthandTok = nameTok;
          this._objPatternShorthandName = keyId;
        }
      }

      // Now the value is on top of the stack. Apply default if `=` follows
      // (only meaningful for non-shorthand-with-explicit-target — see below).
      // AST key node: IDENTIFIER for plain keys, LITERAL_STRING for
      // string/numeric keys, the computed expression for computed keys
      // (with the COMPUTED flag). Shorthand entries carry no key node.
      let keyNode = 0;
      let keyFlags = 0;
      if (this.ast && !isShorthand) {
        if (isComputed) {
          keyNode = computedKeyOff;
          keyFlags = FLAG.PATTERN_KEY_COMPUTED;
        } else if (isStringKey) {
          keyNode = this.ast.writeLiteralString(keyId, this.pos(propStartTok));
        } else if (keyId) {
          keyNode = this.ast.writeIdentifier(keyId, this.pos(propStartTok));
        }
      }

      if (isShorthand) {
        const defaultValue = this.emitDefaultIfUndefined();
        // Bind to the shorthand name (saved above).
        this.emitDestructuringBind(
          this._objPatternShorthandName, flags, mode,
          this._objPatternShorthandTok.start,
          this._objPatternShorthandTok.end);
        if (this.ast) {
          propertyOffsets.push(this.ast.writePatternElement({
            nameOffset: this._objPatternShorthandName,
            defaultValue,
            flags: FLAG.PATTERN_SHORTHAND,
            pos: this.pos(propStartTok),
          }));
        }
      } else {
        // Renaming or computed form: parse the target.
        if (this.check(TokenType.LBRACKET)) {
          const nestedPattern = this.arrayPatternBind(flags, mode);
          if (this.ast) {
            propertyOffsets.push(this.ast.writePatternElement({
              keyNode, nestedPattern, flags: keyFlags, pos: this.pos(propStartTok),
            }));
          }
        } else if (this.check(TokenType.LBRACE)) {
          const nestedPattern = this.objectPatternBind(flags, mode);
          if (this.ast) {
            propertyOffsets.push(this.ast.writePatternElement({
              keyNode, nestedPattern, flags: keyFlags, pos: this.pos(propStartTok),
            }));
          }
        } else {
          this.consume(TokenType.IDENTIFIER,
            "Expected identifier or nested pattern as object-pattern target");
          const targetTok = this.previous;
          const targetName = this.internString(targetTok.value);
          // Default applies AFTER the target name and BEFORE LET_VAR.
          const defaultValue = this.emitDefaultIfUndefined();
          this.emitDestructuringBind(targetName, flags, mode, targetTok.start, targetTok.end);
          if (this.ast) {
            propertyOffsets.push(this.ast.writePatternElement({
              nameOffset: targetName, keyNode,
              defaultValue, flags: keyFlags, pos: this.pos(propStartTok),
            }));
          }
        }
      }
    }

    this.consume(TokenType.RBRACE, "Expected '}' to close object pattern");
    return this.ast ? this.ast.writeObjectPattern(propertyOffsets, 0, this.pos(startTok)) : 0;
  }

  /**
   * Emit code for a `...rest` element in an object pattern.
   *
   * Collects the source object's own enumerable string-keyed properties
   * that haven't already been bound by earlier pattern elements, into
   * a fresh object. The emitted bytecode is roughly:
   *
   *   rest = {}
   *   keys = Object.keys(src)
   *   for (let i = 0; i < keys.length; i++) {
   *     let k = keys[i];
   *     if (k === bound1 || k === bound2 || ...) continue;
   *     rest[k] = src[k];
   *   }
   *   <bind rest to target>
   *
   * Per spec, symbol keys and inherited properties are excluded; that
   * matches Object.keys's contract.
   */
  emitObjectRestElement(srcName, boundKeyIds, flags, mode = 'declare') {
    const counter = this.destructuringCounter++;
    const restName = this.internString(`@dst_rest_${counter}`);
    const keysName = this.internString(`@dst_keys_${counter}`);
    const idxName = this.internString(`@dst_i_${counter}`);
    const kName = this.internString(`@dst_k_${counter}`);

    // rest = {}
    this.emit(OP.MAKE_OBJECT, 0);
    this.emit(OP.LET_VAR, restName);

    // keys = Object.keys(src)
    this.emit(OP.GET_VAR, this.internString('Object'));
    this.emit(OP.GET_VAR, this.internString('Object'));
    this.emit(OP.GET_PROP, this.internString('keys'));
    this.emit(OP.GET_VAR, srcName);
    this.emit(OP.CALL_METHOD, 1);
    this.emit(OP.LET_VAR, keysName);

    // i = 0
    this.emit(OP.LIT_RATIONAL_INTEGER, 0);
    this.emit(OP.LET_VAR, idxName);
    // Pre-declare k so the loop body can SET_VAR each iteration.
    this.emit(OP.LIT_UNDEFINED);
    this.emit(OP.LET_VAR, kName);

    // for-loop start
    const loopStart = this.here;
    // i < keys.length
    this.emit(OP.GET_VAR, idxName);
    this.emit(OP.GET_VAR, keysName);
    this.emit(OP.GET_PROP, this.internString('length'));
    this.emit(OP.LT);
    const exitJump = this.emit(OP.JUMP_IF_FALSE, 0);

    // k = keys[i]
    this.emit(OP.GET_VAR, keysName);
    this.emit(OP.GET_VAR, idxName);
    this.emit(OP.GET_INDEX);
    this.emit(OP.SET_VAR, kName);
    this.emit(OP.POP);  // SET_VAR pushes the value back

    // skip if k is one of the bound keys.
    // Emit: if (k === bound1 || k === bound2 || ...) goto continue_label
    const skipJumps = [];
    for (const boundKey of boundKeyIds) {
      this.emit(OP.GET_VAR, kName);
      this.emit(OP.LIT_STRING, boundKey);
      this.emit(OP.EQ);
      skipJumps.push(this.emit(OP.JUMP_IF_TRUE, 0));
    }

    // rest[k] = src[k]
    this.emit(OP.GET_VAR, restName);  // container for SET_INDEX
    this.emit(OP.GET_VAR, kName);     // index
    this.emit(OP.GET_VAR, srcName);   // src (for GET_INDEX)
    this.emit(OP.GET_VAR, kName);     // key
    this.emit(OP.GET_INDEX);          // pops [src, k], pushes src[k]
    // Stack: [restName, kName, src[k]]. SET_INDEX wants
    // [container, index, value] with value on top — that's the order.
    this.emit(OP.SET_INDEX);
    this.emit(OP.POP);                // SET_INDEX pushes the value back

    // continue_label: increment i and loop.
    const continueLabel = this.here;
    for (const j of skipJumps) this.patch(j, continueLabel);

    this.emit(OP.GET_VAR, idxName);
    this.emit(OP.LIT_RATIONAL_INTEGER, 1);
    this.emit(OP.ADD);
    this.emit(OP.SET_VAR, idxName);
    this.emit(OP.POP);  // SET_VAR pushes the value back
    this.emit(OP.JUMP, loopStart);
    this.patch(exitJump, this.here);

    // Push rest object and bind to the target.
    this.emit(OP.GET_VAR, restName);
    return this.bindArrayPatternTarget(flags, mode);
  }

  ifStatement() {
    const startTok = this.previous; // `if`
    this.consume(TokenType.LPAREN, "Expected '(' after 'if'");
    const testOff = this.expression();
    this.consume(TokenType.RPAREN, "Expected ')' after condition");

    const jumpIfFalse = this.emit(OP.JUMP_IF_FALSE, 0); // placeholder

    const thenOff = this.statement(); // then branch

    let elseOff = 0;
    if (this.match(TokenType.ELSE)) {
      const jumpOver = this.emit(OP.JUMP, 0); // placeholder
      this.patch(jumpIfFalse, this.here);
      elseOff = this.statement(); // else branch
      this.patch(jumpOver, this.here);
    } else {
      this.patch(jumpIfFalse, this.here);
    }

    const ifNode = this.ast ? this.ast.writeIf(testOff, thenOff, elseOff, this.pos(startTok)) : 0;
    this.attributeInstruction(jumpIfFalse, ifNode);
    return ifNode;
  }

  whileStatement() {
    const startTok = this.previous; // `while`
    const loopStart = this.here;

    this.consume(TokenType.LPAREN, "Expected '(' after 'while'");
    const testOff = this.expression();
    this.consume(TokenType.RPAREN, "Expected ')' after condition");

    const jumpIfFalse = this.emit(OP.JUMP_IF_FALSE, 0); // placeholder

    // Push loop context - continue jumps to condition (loopStart)
    this.loopStack.push({ breaks: [], continues: [], continueTarget: loopStart, isLoop: true,
      breakProtectionDepth: this.tryProtectionDepth,
      continueProtectionDepth: this.tryProtectionDepth,
      grantProtectionDepth: this.grantProtectionDepth });

    const bodyOff = this.statement(); // body

    this.emit(OP.JUMP, loopStart);
    this.patch(jumpIfFalse, this.here);

    // Patch all breaks to exit point
    const loop = this.loopStack.pop();
    for (const breakJump of loop.breaks) {
      this.patch(breakJump, this.here);
    }

    const whileNode = this.ast ? this.ast.writeWhile(testOff, bodyOff, this.pos(startTok)) : 0;
    this.attributeInstruction(jumpIfFalse, whileNode);
    return whileNode;
  }

  doWhileStatement() {
    const startTok = this.previous; // `do`
    const loopStart = this.here;

    // Continue target unknown until we reach condition - will be patched
    this.loopStack.push({ breaks: [], continues: [], continueTarget: null, isLoop: true,
      breakProtectionDepth: this.tryProtectionDepth,
      continueProtectionDepth: this.tryProtectionDepth,
      grantProtectionDepth: this.grantProtectionDepth });

    const bodyOff = this.statement(); // body

    // Condition starts here - patch any continues
    const conditionStart = this.here;
    const loop = this.loopStack[this.loopStack.length - 1];
    for (const continueJump of loop.continues) {
      this.patch(continueJump, conditionStart);
    }

    this.consume(TokenType.WHILE, "Expected 'while' after do body");
    this.consume(TokenType.LPAREN, "Expected '(' after 'while'");
    const testOff = this.expression();
    this.consume(TokenType.RPAREN, "Expected ')' after condition");
    this.match(TokenType.SEMICOLON);

    const jumpInstr = this.emit(OP.JUMP_IF_TRUE, loopStart);

    // Patch breaks to exit point
    for (const breakJump of loop.breaks) {
      this.patch(breakJump, this.here);
    }
    this.loopStack.pop();

    const node = this.ast ? this.ast.writeDoWhile(bodyOff, testOff, this.pos(startTok)) : 0;
    this.attributeInstruction(jumpInstr, node);
    return node;
  }

  forStatement() {
    const startTok = this.previous; // `for`
    // Three forms:
    //   for (let|const|var IDENT of EXPR) body            (for-of)
    //   for await (let|const|var IDENT of EXPR) body      (for-await-of)
    //   for (init; condition; update) body                (classic)
    //
    // Classic for bytecode layout:
    //   SCOPE_PUSH
    //   <init>
    //   JUMP condition_start
    //   update_start:
    //     <update>
    //     POP
    //   condition_start:
    //     <condition>
    //     JUMP_IF_FALSE exit
    //     <body>
    //     JUMP update_start
    //   exit:
    //   SCOPE_POP

    // for-await-of: only valid where `await` is valid — top level (empty
    // functionStack) or inside an async function (top of stack is true).
    let isAwait = false;
    if (this.check(TokenType.AWAIT)) {
      this.advance(); // consume `await`
      isAwait = true;
      if (this.functionStack.length > 0 && !this.functionStack[this.functionStack.length - 1].isAsync) {
        this.error("'for await' is only valid in async functions or at top level");
      }
    }

    this.consume(TokenType.LPAREN, "Expected '(' after 'for'");

    // Look ahead for the for-of declaration form. We only consume the
    // declarator keyword if we confirm it's a for-of, so classic for-loops
    // with `let/const/var` initializers fall through unchanged.
    if (this.check(TokenType.LET) || this.check(TokenType.CONST) || this.check(TokenType.VAR)) {
      // Save state to potentially commit to either path.
      const declKeyword = this.current.type;
      const isConst = declKeyword === TokenType.CONST;
      // Peek past the declarator: snapshot lexer + current, advance, look at the next two tokens.
      this.advance();  // consume let/const/var

      // Pattern-form for-of: `for (let [a, b] of arr)` or
      // `for (let { a } of records)`. Skim past the matching close to
      // see if `of` follows. forOfBody will receive pattern position
      // info so it can rewind to parse the pattern after the iterator
      // is set up.
      if (this.check(TokenType.LBRACKET) || this.check(TokenType.LBRACE)) {
        const patternStart = this.lexer.saveState();
        const patternCurrent = this.current;
        const patternPrevious = this.previous;
        this.advance();  // consume `[` or `{`
        this.skimBalanced();
        if (this.check(TokenType.IDENTIFIER) && this.current.value === 'of') {
          this.advance();  // consume `of`
          // Lexer is now positioned right after `of`, ready for the
          // iterable expression.
          return this.forOfBody(null, isConst, isAwait, {
            pattern: true,
            patternStart,
            patternCurrent,
            patternPrevious,
          }, startTok);
        }
        if (this.check(TokenType.IN)) {
          throw this.error("Destructuring patterns not supported in for...in (keys are always strings); use for...of with Object.keys");
        }
        // Not for-of with a pattern — patterns aren't valid as classic-for
        // init either, so this is a parse error regardless.
        throw this.error("Expected 'of' after destructuring pattern in for loop");
      }

      const nameTok = this.current;
      if (nameTok.type === TokenType.IDENTIFIER) {
        // Tentatively advance past the identifier to see what's next.
        this.advance();
        if (this.check(TokenType.IDENTIFIER) && this.current.value === 'of') {
          this.advance(); // consume `of`
          return this.forOfBody(nameTok, isConst, isAwait, {}, startTok);
        }
        if (this.check(TokenType.IN)) {
          if (isAwait) {
            throw this.error("'for await' requires '... of ...'");
          }
          this.advance(); // consume `in`
          return this.forInBody(nameTok, isConst, startTok);
        }
        if (isAwait) {
          throw this.error("'for await' requires '... of ...' (no classic-for form)");
        }
        // Not for-of: we've already consumed `let/const/var IDENT`. Emit
        // the LET_VAR for this binding, then continue the classic-for init
        // path: optional `= init`, then `, more bindings`, then condition/update.
        this.emit(OP.SCOPE_PUSH);
        const initOff = this.continueDeclaratorAfterName(nameTok, isConst);
        return this.classicForTail(initOff, startTok);
      }
      if (isAwait) {
        throw this.error("'for await' requires '... of ...' (no classic-for form)");
      }
      // `let/const/var` not followed by an identifier — fall back to classic
      // for-loop error reporting via variableDeclaration.
      this.emit(OP.SCOPE_PUSH);
      const initOff = this.variableDeclaration(isConst);
      return this.classicForTail(initOff, startTok);
    }

    if (isAwait) {
      throw this.error("'for await' requires '... of ...' (no classic-for form)");
    }

    this.emit(OP.SCOPE_PUSH);

    // Init clause - ends with ;
    let initOff = 0;
    if (this.match(TokenType.SEMICOLON)) {
      // empty init
    } else {
      const exprStartTok = this.current;
      const exprOff = this.expression();
      this.emit(OP.POP);
      this.consume(TokenType.SEMICOLON, "Expected ';' after for init");
      initOff = this.ast ? this.ast.writeExpressionStatement(exprOff, this.pos(exprStartTok)) : 0;
    }

    return this.classicForTail(initOff, startTok);
  }

  /**
   * Classic for-loop tail: emit condition/update/body assuming SCOPE_PUSH and
   * init have already been emitted, and the parser is positioned just after
   * the init clause's terminating `;`.
   */
  classicForTail(initOff, startTok) {
    // Jump over update to condition (update emitted first but runs after body)
    const jumpToCondition = this.emit(OP.JUMP, 0);

    // We need to parse condition and update in source order (condition; update)
    // but emit them as (update then condition)
    // So we need to defer emission. Simplest: just emit in execution order.

    // Actually, let's restructure: emit condition first, then update code will be
    // at the jump-back point.
    //
    // New layout:
    //   SCOPE_PUSH
    //   <init>
    //   loop_start:        <- condition is here
    //     <condition>
    //     JUMP_IF_FALSE exit
    //     <body>
    //     <update>
    //     POP
    //     JUMP loop_start
    //   exit:
    //   SCOPE_POP
    //
    // This means continue jumps to just before update. But we don't know that
    // position yet when parsing body. Let's use deferred patching like do-while.

    // Parse condition (between first ; and second ;)
    const loopStart = this.here;
    this.patch(jumpToCondition, loopStart);

    let exitJump = -1;
    let testOff = 0;
    if (!this.check(TokenType.SEMICOLON)) {
      testOff = this.expression();
      exitJump = this.emit(OP.JUMP_IF_FALSE, 0);
    }
    this.consume(TokenType.SEMICOLON, "Expected ';' after for condition");

    // Parse update expression but don't emit yet - save the tokens? No, that's complex.
    // Instead, just note that we'll emit body, then update, and continue jumps to update.

    // Actually, simplest approach: parse and emit update here, jump over it,
    // then jump back to it from end of body.

    // Jump over update to body
    const jumpToBody = this.emit(OP.JUMP, 0);

    // Update clause (allow comma operator for i++, j--)
    const updateStart = this.here;
    let updateOff = 0;
    if (!this.check(TokenType.RPAREN)) {
      updateOff = this.parsePrecedence(PREC.COMMA);
      this.emit(OP.POP);
    }
    this.consume(TokenType.RPAREN, "Expected ')' after for clauses");

    // After update, jump back to condition
    this.emit(OP.JUMP, loopStart);

    // Body starts here
    this.patch(jumpToBody, this.here);

    // Push loop context - continue jumps to update
    this.loopStack.push({ breaks: [], continues: [], continueTarget: updateStart, isLoop: true,
      breakProtectionDepth: this.tryProtectionDepth,
      continueProtectionDepth: this.tryProtectionDepth,
      grantProtectionDepth: this.grantProtectionDepth });

    // Body
    const bodyOff = this.statement();

    // Jump to update (which then jumps to condition)
    this.emit(OP.JUMP, updateStart);

    // Exit point (breaks jump here, before SCOPE_POP)
    const exitPoint = this.here;
    if (exitJump !== -1) {
      this.patch(exitJump, exitPoint);
    }

    // Patch breaks
    const loop = this.loopStack.pop();
    for (const breakJump of loop.breaks) {
      this.patch(breakJump, exitPoint);
    }

    this.emit(OP.SCOPE_POP);

    const forNode = this.ast ? this.ast.writeFor(initOff, testOff, updateOff, bodyOff, this.pos(startTok)) : 0;
    if (exitJump !== -1) this.attributeInstruction(exitJump, forNode);
    return forNode;
  }

  /**
   * Mirror of variableDeclaration() for the case where the first identifier
   * has already been consumed (lookahead during for-loop dispatch). Emits
   * LET_VAR for that binding plus any additional `, name [= init]` clauses,
   * consumes the trailing `;`, and returns the AST offset.
   */
  continueDeclaratorAfterName(firstNameTok, isConst) {
    const flags = isConst ? SCOPE_FLAG_CONST : 0;
    const bindings = [];

    const firstName = this.internString(firstNameTok.value);
    let initOff = 0;
    if (this.match(TokenType.ASSIGN)) {
      initOff = this.expression();
    } else if (isConst) {
      throw this.error("Missing initializer in const declaration");
    } else {
      this.emit(OP.LIT_UNDEFINED);
    }
    const firstBindingOff = this.ast ? this.ast.writeVariableBinding(firstName, initOff, this.pos(firstNameTok)) : 0;
    bindings.push(firstBindingOff);
    this.emitWithSource(OP.LET_VAR, firstName, flags, firstNameTok.start, firstNameTok.end, firstBindingOff);

    while (this.match(TokenType.COMMA)) {
      this.consume(TokenType.IDENTIFIER, 'Expected variable name');
      const nameTok = this.previous;
      const varStart = nameTok.start;
      const varEnd = nameTok.end;
      const name = this.internString(nameTok.value);

      let nextInitOff = 0;
      if (this.match(TokenType.ASSIGN)) {
        nextInitOff = this.expression();
      } else if (isConst) {
        throw this.error("Missing initializer in const declaration");
      } else {
        this.emit(OP.LIT_UNDEFINED);
      }

      const bindingOff = this.ast ? this.ast.writeVariableBinding(name, nextInitOff, this.pos(nameTok)) : 0;
      bindings.push(bindingOff);
      this.emitWithSource(OP.LET_VAR, name, flags, varStart, varEnd, bindingOff);
    }

    this.consume(TokenType.SEMICOLON, "Expected ';' after for init");
    return this.ast ? this.ast.writeVariableDecl(bindings, isConst, this.pos(firstNameTok)) : 0;
  }

  /**
   * Emit a for...in loop. The dispatcher has already consumed `(`, the
   * declarator keyword, the identifier `nameTok`, and the `in` keyword.
   *
   * SS desugars `for (let k in obj) body` to the equivalent of:
   *
   *   { let @keys = Object.keys(obj);
   *     let @i = 0;
   *     while (@i < @keys.length) {
   *       { let k = @keys[@i]; body; }
   *       @i++;
   *     }
   *   }
   *
   * Diverges from full JS `for...in` in that it doesn't walk the prototype
   * chain. Object.keys returns own enumerable string-keyed properties,
   * which matches JS for-in for all plain objects (no enumerable built-in
   * prototype properties exist in SS or modern JS). For arrays and
   * strings, Object.keys returns string indices ("0", "1", ...), matching
   * JS for-in. For null/undefined, Object.keys throws TypeError, which
   * diverges from JS for-in (silently skips); the trade is consistency
   * with Object.keys against rarely-used silent-no-op semantics.
   */
  forInBody(nameTok, isConst, startTok = nameTok) {
    const keysName = this.internString('@keys');
    const idxName = this.internString('@i');
    const flags = isConst ? SCOPE_FLAG_CONST : 0;
    const userName = this.internString(nameTok.value);

    this.emit(OP.SCOPE_PUSH);

    // @keys = Object.keys(<iterable>)
    this.emit(OP.GET_VAR, this.internString('Object'));
    this.emit(OP.GET_VAR, this.internString('Object'));
    this.emit(OP.GET_PROP, this.internString('keys'));
    const iterableOff = this.expression();
    this.consume(TokenType.RPAREN, "Expected ')' after for-in iterable");
    this.emit(OP.CALL_METHOD, 1);
    this.emit(OP.LET_VAR, keysName);

    // @i = 0
    this.emit(OP.LIT_RATIONAL_INTEGER, 0);
    this.emit(OP.LET_VAR, idxName);

    const loopStart = this.here;

    // if (!(@i < @keys.length)) break
    this.emit(OP.GET_VAR, idxName);
    this.emit(OP.GET_VAR, keysName);
    this.emit(OP.GET_PROP, this.internString('length'));
    this.emit(OP.LT);
    const jumpExit = this.emit(OP.JUMP_IF_FALSE, 0);

    // Per-iteration scope so the user binding is fresh each round
    // (matches for-of semantics; closures captured in the body bind to
    // a distinct slot per iteration).
    this.emit(OP.SCOPE_PUSH);
    this.emit(OP.GET_VAR, keysName);
    this.emit(OP.GET_VAR, idxName);
    this.emit(OP.GET_INDEX);
    this.emitWithSource(OP.LET_VAR, userName, flags, nameTok.start, nameTok.end, 0);

    this.loopStack.push({ breaks: [], continues: [], continueTarget: null, isLoop: true,
      breakProtectionDepth: this.tryProtectionDepth,
      continueProtectionDepth: this.tryProtectionDepth,
      grantProtectionDepth: this.grantProtectionDepth });

    const bodyOff = this.statement();

    // continues land here, before the inner SCOPE_POP, so they exit the
    // per-iteration scope before incrementing.
    const continueLabel = this.here;
    this.emit(OP.SCOPE_POP);

    // @i++
    this.emit(OP.GET_VAR, idxName);
    this.emit(OP.LIT_RATIONAL_INTEGER, 1);
    this.emit(OP.ADD);
    this.emit(OP.SET_VAR, idxName);
    this.emit(OP.POP);
    this.emit(OP.JUMP, loopStart);

    const exitPoint = this.here;
    this.patch(jumpExit, exitPoint);

    const loop = this.loopStack.pop();
    for (const breakJump of loop.breaks) {
      this.patch(breakJump, exitPoint);
    }
    for (const continueJump of loop.continues) {
      this.patch(continueJump, continueLabel);
    }

    this.emit(OP.SCOPE_POP);

    const bindingOff = this.ast
      ? this.ast.writeVariableBinding(userName, 0, this.pos(nameTok))
      : 0;
    const forInNode = this.ast
      ? this.ast.writeForIn(bindingOff, iterableOff, bodyOff,
          isConst ? FLAG.FOR_IN_CONST : FLAG.FOR_IN_LET, this.pos(startTok))
      : 0;
    this.attributeInstruction(jumpExit, forInNode);
    return forInNode;
  }

  /**
   * Emit a for-of (or for-await-of) loop. The dispatcher has already
   * consumed `(`, the declarator keyword, the identifier `nameTok`, and the
   * `of` contextual keyword. Caller passes:
   *   - nameTok: identifier token for the loop variable
   *   - isConst: declarator was `const`
   *   - isAwait: `for await (...)` form
   *
   * Bytecode shape (one outer scope for the iterator binding):
   *
   *   SCOPE_PUSH                          ; outer: holds @iter
   *     <eval iterable expr>
   *     ASSERT_ITERABLE 0                 ; "Not iterable" for never-iterable sources
   *     LIT_WELL_KNOWN_SYMBOL 0 or 1
   *     GET_INDEX                         ; expr[Symbol.(async)Iterator]
   *     ASSERT_ITERABLE 1                 ; "Not iterable" if the lookup missed
   *     CALL 0                            ; iterable[Symbol.iterator]()
   *     LET_VAR @iter
   *   loop_start:
   *     GET_VAR @iter
   *     GET_PROP "next"
   *     CALL 0
   *     [AWAIT]                           ; for-await-of only
   *     LET_VAR @step                     ; bind step (its scope ends on iteration)
   *     ; TODO(strict): check @step is object, else TypeError
   *     GET_VAR @step
   *     GET_PROP "done"
   *     JUMP_IF_TRUE exit
   *     SCOPE_PUSH                        ; inner: fresh per-iteration scope
   *       GET_VAR @step
   *       GET_PROP "value"
   *       LET_VAR <user binding>
   *       <body>
   *     SCOPE_POP
   *     JUMP loop_start
   *   exit:
   *   SCOPE_POP
   *
   * NB: @step is rebound each iteration via SET_VAR (because LET_VAR in the
   * same scope would redeclare). We declare it once before the loop_start
   * jump-back point.
   */
  forOfBody(nameTok, isConst, isAwait, opts = {}, startTok = nameTok) {
    const iterName = this.internString('@iter');
    const stepName = this.internString('@step');
    const iteratorFactoryName = this.internString('@iteratorFactory');
    const syncFallbackName = this.internString('@syncFallback');
    const symbolIteratorOperand = isAwait ? 1 : 0;
    const flags = isConst ? SCOPE_FLAG_CONST : 0;
    const isPattern = opts.pattern === true;
    const userName = isPattern ? 0 : this.internString(nameTok.value);

    this.emit(OP.SCOPE_PUSH);

    // Evaluate iterable expression. We need the value twice — once as
    // receiver for CALL_METHOD, once as the object for GET_INDEX. The
    // simplest path is to bind it to a hidden local and read it back.
    const iterableTmpName = this.internString('@iterable');
    const iterableOff = this.expression();
    this.consume(TokenType.RPAREN, "Expected ')' after for-of iterable");
    // Reject never-iterable sources with "Not iterable" before the
    // generic GET_INDEX / CALL_METHOD errors can mislead.
    this.emit(OP.ASSERT_ITERABLE, 0);
    this.emit(OP.LET_VAR, iterableTmpName);

    if (isAwait) {
      // Spec fallback (C3): if the source has no Symbol.asyncIterator,
      // fall back to Symbol.iterator and drive the SYNC iterator —
      // skipping the await of each step object (it isn't a promise) and
      // instead awaiting each step VALUE, which is how the spec's
      // AsyncFromSyncIterator lifts sync values into the async protocol.
      // @syncFallback records which protocol was resolved; the loop body
      // branches on it at both await sites.
      //
      // Both paths bind @iteratorFactory through the single LET_VAR at
      // the join, never SET_VAR: assignment's flag-merge in $scope_set
      // preserves the entry's low flag byte for SCOPE_FLAG_CONST, which
      // destroys a bound method's receiver type (it lives in that same
      // byte) — a native factory stored via SET_VAR comes back
      // undispatched and CALL_METHOD produces undefined.
      this.emit(OP.GET_VAR, iterableTmpName);
      this.emit(OP.LIT_WELL_KNOWN_SYMBOL, 1);
      this.emit(OP.GET_INDEX);
      this.emit(OP.DUP);
      const haveAsyncIterator = this.emit(OP.JUMP_IF_TRUE, 0);
      this.emit(OP.POP);                       // drop the undefined async lookup
      this.emit(OP.GET_VAR, iterableTmpName);
      this.emit(OP.LIT_WELL_KNOWN_SYMBOL, 0);
      this.emit(OP.GET_INDEX);
      this.emit(OP.LIT_TRUE);
      this.emit(OP.LET_VAR, syncFallbackName);
      const jumpToFactoryBind = this.emit(OP.JUMP, 0);
      this.patch(haveAsyncIterator, this.here);
      this.emit(OP.LIT_FALSE);
      this.emit(OP.LET_VAR, syncFallbackName);
      this.patch(jumpToFactoryBind, this.here);
      this.emit(OP.LET_VAR, iteratorFactoryName);
      // CALL_METHOD layout: [receiver, method, args...]
      this.emit(OP.GET_VAR, iterableTmpName);  // receiver
      this.emit(OP.GET_VAR, iteratorFactoryName);
      this.emit(OP.ASSERT_ITERABLE, 1);        // throw "Not iterable" if BOTH lookups missed
      this.emit(OP.CALL_METHOD, 0);
      this.emit(OP.LET_VAR, iterName);
    } else {
      // CALL_METHOD layout: [receiver, method, args...]
      this.emit(OP.GET_VAR, iterableTmpName);  // receiver
      this.emit(OP.GET_VAR, iterableTmpName);  // expr to index into
      this.emit(OP.LIT_WELL_KNOWN_SYMBOL, symbolIteratorOperand);
      this.emit(OP.GET_INDEX);                  // pops expr+key, pushes method
      this.emit(OP.ASSERT_ITERABLE, 1);         // throw "Not iterable" if lookup missed
      this.emit(OP.CALL_METHOD, 0);             // pops method+receiver, pushes iterator
      this.emit(OP.LET_VAR, iterName);
    }

    // Pre-declare @step with undefined so the loop body can SET_VAR it.
    this.emit(OP.LIT_UNDEFINED);
    this.emit(OP.LET_VAR, stepName);

    const loopStart = this.here;

    // step = @iter.next() — use CALL_METHOD so `this` is bound to @iter
    // inside user-defined iterators. Stack on entry to CALL_METHOD must be
    // [receiver, method, args...]; push @iter twice so GET_PROP consumes one
    // and the receiver remains underneath the method.
    this.emit(OP.GET_VAR, iterName);
    this.emit(OP.GET_VAR, iterName);
    this.emit(OP.GET_PROP, this.internString('next'));
    this.emit(OP.CALL_METHOD, 0);
    if (isAwait) {
      // A sync-fallback iterator's step object is not a promise — skip
      // the await (the VALUE is awaited instead, below).
      this.emit(OP.GET_VAR, syncFallbackName);
      const skipStepAwait = this.emit(OP.JUMP_IF_TRUE, 0);
      this.emit(OP.AWAIT);
      this.patch(skipStepAwait, this.here);
    }
    // Spec: iterator's next() must return an object; otherwise TypeError.
    this.emit(OP.ASSERT_ITER_RESULT);
    this.emit(OP.SET_VAR, stepName);
    // SET_VAR is an expression op: it pops the value AND pushes it back
    // as the assignment expression result. The for-of desugaring uses
    // SET_VAR @step as a statement, so the pushed-back copy would
    // accumulate on the pending stack — one leak per iteration. Pop it.
    this.emit(OP.POP);

    // if (step.done) break
    this.emit(OP.GET_VAR, stepName);
    this.emit(OP.GET_PROP, this.internString('done'));
    const jumpExit = this.emit(OP.JUMP_IF_TRUE, 0);

    // Per-iteration close frame (v11): a finally-armed try entry whose
    // handler is the close block emitted after the body. Any abrupt exit
    // from the iteration — throw, return, break — diverts through it and
    // invokes the iterator's return() method (IteratorClose); the normal
    // iteration end diverts with a NORMAL completion and skips the
    // close. Pushed BEFORE the per-iteration scope so the close block
    // runs in the outer loop scope where @iter lives.
    const closeFramePush = this.emit(OP.TRY_PUSH, 0, 0);
    this.tryProtectionDepth++;
    this.tryGrantDepths.push(this.grantProtectionDepth);

    // Fresh per-iteration scope for the user binding.
    this.emit(OP.SCOPE_PUSH);
    this.emit(OP.GET_VAR, stepName);
    this.emit(OP.GET_PROP, this.internString('value'));
    if (isAwait) {
      // Sync fallback: lift each value through await (Promise.resolve
      // semantics — promise elements settle before binding). Real async
      // iterators deliver settled values in the step object; their
      // values are NOT awaited again.
      this.emit(OP.GET_VAR, syncFallbackName);
      const skipValueAwait = this.emit(OP.JUMP_IF_FALSE, 0);
      this.emit(OP.AWAIT);
      this.patch(skipValueAwait, this.here);
    }
    if (isPattern) {
      // Save current (post-iterable, post-`)`) state so we can return to
      // it for the body after the pattern-bind rewinds the lexer.
      const afterParen = this.lexer.saveState();
      const afterParenCurrent = this.current;
      const afterParenPrevious = this.previous;
      // Rewind to the pattern start; bind the value-on-stack via the
      // pattern parser. This emits all the destructuring bytecode in
      // the per-iteration scope.
      this.lexer.restoreState(opts.patternStart);
      this.current = opts.patternCurrent;
      this.previous = opts.patternPrevious;
      if (this.check(TokenType.LBRACKET)) {
        this._forOfPatternOff = this.arrayPatternBind(flags);
      } else {
        this._forOfPatternOff = this.objectPatternBind(flags);
      }
      // Restore lexer to body position.
      this.lexer.restoreState(afterParen);
      this.current = afterParenCurrent;
      this.previous = afterParenPrevious;
    } else {
      this._forOfPatternOff = 0;
      this.emitWithSource(OP.LET_VAR, userName, flags, nameTok.start, nameTok.end, 0);
    }

    // continueTarget is the position of the inner SCOPE_POP, patched later
    // (do-while style) so `continue` exits the per-iteration scope cleanly
    // before jumping back to loop_start.
    //
    // Unwind snapshots: break must unwind the loop's own close frame
    // (running the close block on the way out), so its snapshot is one
    // BELOW the current depth; continue lands on the TRY_POP that
    // diverts through the close block with a NORMAL completion, so its
    // snapshot excludes the close frame.
    this.loopStack.push({ breaks: [], continues: [], continueTarget: null, isLoop: true,
      breakProtectionDepth: this.tryProtectionDepth - 1,
      continueProtectionDepth: this.tryProtectionDepth,
      grantProtectionDepth: this.grantProtectionDepth });

    // Body.
    const bodyOff = this.statement();

    // Continues land here, before the inner SCOPE_POP.
    const continueLabel = this.here;
    this.emit(OP.SCOPE_POP);
    // Normal iteration end: divert through the close block with a NORMAL
    // completion (the close is skipped; FINALLY_END falls through to the
    // loop-back jump).
    this.emit(OP.TRY_POP);

    // ===== Close block (IteratorClose) =====
    // Entered as the close frame's finally on EVERY iteration-frame exit.
    // Branches on the pending completion kind:
    //   NORMAL — skip the close entirely.
    //   THROW  — call @iter.return() with close errors swallowed (the
    //            original exception must win).
    //   RETURN / JUMP — call @iter.return(); close errors propagate.
    // A missing / null / undefined `return` skips the call (truthiness
    // test — a non-callable truthy value reaches CALL_METHOD and throws
    // the spec's TypeError).
    const returnName = this.internString('return');
    const closeBlockStart = this.here;
    this.mem.codeBlockEditInstruction(closeFramePush, 'operand2', closeBlockStart);

    this.emit(OP.PUSH_COMPLETION_KIND);
    const skipWhenNormal = this.emit(OP.JUMP_IF_FALSE, 0);
    this.emit(OP.GET_VAR, iterName);
    this.emit(OP.GET_PROP, returnName);
    const skipWhenNoReturnMethod = this.emit(OP.JUMP_IF_FALSE, 0);
    this.emit(OP.PUSH_COMPLETION_KIND);
    this.emit(OP.LIT_RATIONAL_INTEGER, 1);
    this.emit(OP.EQ);
    const jumpToUnguardedClose = this.emit(OP.JUMP_IF_FALSE, 0);

    // THROW completion: guarded close.
    const guardPush = this.emit(OP.TRY_PUSH, 0, 0);
    this.emit(OP.GET_VAR, iterName);
    this.emit(OP.GET_VAR, iterName);
    this.emit(OP.GET_PROP, returnName);
    this.emit(OP.CALL_METHOD, 0);
    if (isAwait) this.emit(OP.AWAIT);
    this.emit(OP.POP);
    this.emit(OP.TRY_POP);
    const jumpGuardedDone = this.emit(OP.JUMP, 0);

    // RETURN / JUMP completions: unguarded close.
    this.patch(jumpToUnguardedClose, this.here);
    this.emit(OP.GET_VAR, iterName);
    this.emit(OP.GET_VAR, iterName);
    this.emit(OP.GET_PROP, returnName);
    this.emit(OP.CALL_METHOD, 0);
    if (isAwait) this.emit(OP.AWAIT);
    this.emit(OP.POP);
    const jumpUnguardedDone = this.emit(OP.JUMP, 0);

    // Guard catch: discard the close error, pop the disarmed guard entry
    // (v11 catch entry keeps it), fall into the tail.
    this.patch(guardPush, this.here);
    this.emit(OP.POP);
    this.emit(OP.TRY_POP);

    // Tail: re-dispatch the pending completion; a NORMAL completion
    // falls through to the loop-back jump.
    const closeBlockTail = this.here;
    this.patch(skipWhenNormal, closeBlockTail);
    this.patch(skipWhenNoReturnMethod, closeBlockTail);
    this.patch(jumpGuardedDone, closeBlockTail);
    this.patch(jumpUnguardedDone, closeBlockTail);
    this.emit(OP.FINALLY_END);
    this.emit(OP.JUMP, loopStart);

    this.tryProtectionDepth--;
    this.tryGrantDepths.pop();

    // Exit point.
    const exitPoint = this.here;
    this.patch(jumpExit, exitPoint);

    const loop = this.loopStack.pop();
    for (const breakJump of loop.breaks) {
      this.patch(breakJump, exitPoint);
    }
    for (const continueJump of loop.continues) {
      this.patch(continueJump, continueLabel);
    }

    this.emit(OP.SCOPE_POP);

    // AST: bind the loop variable through a VariableBinding node (or the
    // pattern node captured above for `for (const [a, b] of ...)`);
    // iterable is the AST offset returned by this.expression(); body is
    // bodyOff.
    const bindingOff = this.ast
      ? (isPattern ? this._forOfPatternOff : this.ast.writeVariableBinding(userName, 0, this.pos(nameTok)))
      : 0;
    const astFlags = (isAwait ? FLAG.FOR_OF_AWAIT : 0)
      | (isConst ? FLAG.FOR_OF_CONST : FLAG.FOR_OF_LET);
    const forOfNode = this.ast
      ? this.ast.writeForOf(bindingOff, iterableOff, bodyOff, astFlags, this.pos(startTok))
      : 0;
    this.attributeInstruction(jumpExit, forOfNode);
    return forOfNode;
  }

  breakStatement() {
    const startTok = this.previous; // `break`
    if (this.loopStack.length === 0) {
      this.error("'break' outside of switch or loop");
    }
    const breakNode = this.ast ? this.ast.writeBreak(0, this.pos(startTok)) : 0;
    const target = this.loopStack[this.loopStack.length - 1];
    if (target.scopeDepth) {
      for (let i = 0; i < target.scopeDepth; i++) this.emit(OP.SCOPE_POP);
    }
    // Try entries crossed between here and the loop exit: user tries
    // opened inside the loop body, plus (for for-of/for-await) the
    // loop's own per-iteration close frame. A nonzero count compiles to
    // UNWIND_JUMP, which pops catch-only entries and diverts through
    // armed finallys — including the for-of close block, so the
    // iterator's return() runs on break.
    //
    // Grant entries crossed (v12): the unwind walk clamps the grant
    // stack at every try entry it processes, which releases grants
    // pushed ABOVE the outermost crossed try. Grants below it — or all
    // crossed grants, when no try intervenes — are invisible to the
    // walk, so the parser pops them statically: a plain GRANT_END for
    // the try-less case, and a post-unwind trampoline (the UNWIND_JUMP
    // targets the next instruction) for the residue, so the crossed
    // finallys still run WITH those grants active.
    const crossedEntries = this.tryProtectionDepth - target.breakProtectionDepth;
    let breakJump;
    if (crossedEntries > 0) {
      const residueGrants =
        this.tryGrantDepths[target.breakProtectionDepth] - target.grantProtectionDepth;
      const unwindJump = this.emit(OP.UNWIND_JUMP, 0, crossedEntries, breakNode);
      if (residueGrants > 0) {
        this.patch(unwindJump, this.here);
        this.emit(OP.GRANT_END, residueGrants);
        breakJump = this.emit(OP.JUMP, 0, 0, breakNode);
      } else {
        breakJump = unwindJump;
      }
    } else {
      const crossedGrants = this.grantProtectionDepth - target.grantProtectionDepth;
      if (crossedGrants > 0) {
        this.emit(OP.GRANT_END, crossedGrants);
      }
      breakJump = this.emit(OP.JUMP, 0, 0, breakNode);
    }
    target.breaks.push(breakJump);
    this.match(TokenType.SEMICOLON);
    return breakNode;
  }

  continueStatement() {
    const startTok = this.previous; // `continue`
    let loop = null;
    let scopePops = 0;
    for (let i = this.loopStack.length - 1; i >= 0; i--) {
      scopePops += this.loopStack[i].scopeDepth || 0;
      if (this.loopStack[i].isLoop) {
        loop = this.loopStack[i];
        break;
      }
    }
    if (!loop) {
      this.error("'continue' outside of loop");
    }
    const continueNode = this.ast ? this.ast.writeContinue(0, this.pos(startTok)) : 0;
    for (let i = 0; i < scopePops; i++) this.emit(OP.SCOPE_POP);
    // User tries opened between here and the continue landing point.
    // For for-of loops the snapshot EXCLUDES the loop's own close frame:
    // the continue label's TRY_POP diverts through it, so the iterator
    // is not closed on continue.
    //
    // Grant entries crossed (v12): same static-pop scheme as break —
    // GRANT_END for the try-less case, post-unwind trampoline for
    // grants the walk's clamps can't see.
    const crossedEntries = this.tryProtectionDepth - loop.continueProtectionDepth;
    if (crossedEntries > 0) {
      const residueGrants =
        this.tryGrantDepths[loop.continueProtectionDepth] - loop.grantProtectionDepth;
      if (residueGrants > 0) {
        const unwindJump = this.emit(OP.UNWIND_JUMP, 0, crossedEntries, continueNode);
        this.patch(unwindJump, this.here);
        this.emit(OP.GRANT_END, residueGrants);
        if (loop.continueTarget !== null) {
          this.emit(OP.JUMP, loop.continueTarget, 0, continueNode);
        } else {
          loop.continues.push(this.emit(OP.JUMP, 0, 0, continueNode));
        }
      } else if (loop.continueTarget !== null) {
        this.emit(OP.UNWIND_JUMP, loop.continueTarget, crossedEntries, continueNode);
      } else {
        loop.continues.push(this.emit(OP.UNWIND_JUMP, 0, crossedEntries, continueNode));
      }
    } else {
      const crossedGrants = this.grantProtectionDepth - loop.grantProtectionDepth;
      if (crossedGrants > 0) {
        this.emit(OP.GRANT_END, crossedGrants);
      }
      if (loop.continueTarget !== null) {
        this.emit(OP.JUMP, loop.continueTarget, 0, continueNode);
      } else {
        loop.continues.push(this.emit(OP.JUMP, 0, 0, continueNode));
      }
    }
    this.match(TokenType.SEMICOLON);
    return continueNode;
  }

  switchStatement() {
    const startTok = this.previous; // `switch`
    this.consume(TokenType.LPAREN, "Expected '(' after 'switch'");
    const discriminantOff = this.expression();
    this.consume(TokenType.RPAREN, "Expected ')' after switch discriminant");
    this.consume(TokenType.LBRACE, "Expected '{' before switch body");

    if (this.match(TokenType.RBRACE)) {
      this.emit(OP.POP);
      return this.ast ? this.ast.writeSwitch(discriminantOff, [], this.pos(startTok)) : 0;
    }

    // Jump over the body chain to the test chain (emitted after bodies).
    const jumpToTests = this.emit(OP.JUMP, 0);

    this.loopStack.push({ breaks: [], continues: [], continueTarget: null, isLoop: false, scopeDepth: 1,
      breakProtectionDepth: this.tryProtectionDepth,
      continueProtectionDepth: this.tryProtectionDepth,
      grantProtectionDepth: this.grantProtectionDepth });

    // Parse case/default clauses in source order. Bodies are emitted inline
    // to form the fall-through chain. Case test expressions are saved
    // (lexer state snapshots) and re-parsed after all bodies to emit the
    // test chain.
    const cases = [];
    let defaultIndex = -1;

    while (!this.check(TokenType.RBRACE) && !this.check(TokenType.EOF)) {
      if (this.match(TokenType.CASE)) {
        const caseTok = this.previous; // `case`
        const savedLexer = this.lexer.saveState();
        const savedCurrent = this.current;
        const savedPrevious = this.previous;
        const preTestHere = this.here;
        const testOff = this.expression();
        // The single-pass parser just EMITTED the case-test expression
        // inline, but the executable copy belongs to the test chain
        // (re-parsed later from savedLexer). Roll the dead bytes back:
        // left in place they sat between case bodies, so FALLTHROUGH
        // executed the next case's test — leaking one pushed operand
        // per fallen-through label. Found by the stack-depth verifier
        // (join-mismatch at the next case's body entry);
        // tests/fuel/codegen_verify_test.js pins it.
        this.mem.codeBlockTruncate(preTestHere);
        this.consume(TokenType.COLON, "Expected ':' after case expression");
        const bodyStart = this.here;
        cases.push({
          isDefault: false,
          bodyStart, testOff, caseTok,
          savedLexer, savedCurrent, savedPrevious,
          stmtOffs: [],
        });
      } else if (this.match(TokenType.DEFAULT)) {
        const caseTok = this.previous; // `default`
        if (defaultIndex !== -1) {
          this.error("Duplicate 'default' clause in switch");
        }
        this.consume(TokenType.COLON, "Expected ':' after 'default'");
        const bodyStart = this.here;
        defaultIndex = cases.length;
        cases.push({ isDefault: true, bodyStart, testOff: 0, caseTok, stmtOffs: [] });
      } else {
        this.error("Expected 'case' or 'default' in switch body");
      }

      const currentCase = cases[cases.length - 1];
      while (
        !this.check(TokenType.CASE) &&
        !this.check(TokenType.DEFAULT) &&
        !this.check(TokenType.RBRACE) &&
        !this.check(TokenType.EOF)
      ) {
        currentCase.stmtOffs.push(this.statement());
      }
      if (this.pendingPop) {
        this.emit(OP.POP);
        this.pendingPop = false;
      }
    }

    this.emit(OP.SCOPE_POP);
    const bodyEndJump = this.emit(OP.JUMP, 0);

    // --- Test chain ---
    // Save parser state so we can restore after re-parsing test expressions.
    const endLexer = this.lexer.saveState();
    const endCurrent = this.current;
    const endPrevious = this.previous;

    this.patch(jumpToTests, this.here);

    for (let i = 0; i < cases.length; i++) {
      if (cases[i].isDefault) continue;

      this.emit(OP.DUP);

      // Re-parse the case test expression from saved lexer position.
      this.lexer.restoreState(cases[i].savedLexer);
      this.current = cases[i].savedCurrent;
      this.previous = cases[i].savedPrevious;
      this.expression();

      this.emit(OP.EQ);
      const skipJump = this.emit(OP.JUMP_IF_FALSE, 0);
      this.emit(OP.POP);
      this.emit(OP.SCOPE_PUSH);
      this.emit(OP.JUMP, cases[i].bodyStart);
      this.patch(skipJump, this.here);
    }

    // No case matched — pop discriminant, jump to default or exit.
    this.emit(OP.POP);
    if (defaultIndex !== -1) {
      this.emit(OP.SCOPE_PUSH);
      this.emit(OP.JUMP, cases[defaultIndex].bodyStart);
    }

    // Restore parser to end-of-switch position.
    this.lexer.restoreState(endLexer);
    this.current = endCurrent;
    this.previous = endPrevious;

    const exit = this.here;
    this.patch(bodyEndJump, exit);
    const switchEntry = this.loopStack.pop();
    for (const breakJump of switchEntry.breaks) {
      this.patch(breakJump, exit);
    }

    this.consume(TokenType.RBRACE, "Expected '}' after switch body");

    if (this.ast) {
      const caseOffsets = cases.map(c =>
        this.ast.writeSwitchCase(c.testOff, c.stmtOffs, this.pos(c.caseTok))
      );
      return this.ast.writeSwitch(discriminantOff, caseOffsets, this.pos(startTok));
    }
    return 0;
  }

  returnStatement() {
    const startTok = this.previous; // `return`
    let valueOff = 0;
    let returnInstr;
    const returnLine = startTok.line;
    if (
      this.check(TokenType.SEMICOLON) ||
      this.check(TokenType.RBRACE) ||
      this.check(TokenType.EOF) ||
      this.current.line > returnLine
    ) {
      returnInstr = this.emit(OP.RETURN_UNDEFINED);
    } else {
      valueOff = this.expression();
      // Async generators await the return value before completing
      // (spec AsyncGeneratorStart awaits a return completion's value),
      // so `return somePromise` completes the generator with the
      // settled value, not the promise object.
      const enclosingFunction = this.functionStack[this.functionStack.length - 1];
      if (enclosingFunction && enclosingFunction.isAsync && enclosingFunction.isGenerator) {
        this.emit(OP.AWAIT);
      }
      returnInstr = this.emit(OP.RETURN);
    }
    this.match(TokenType.SEMICOLON);
    const node = this.ast ? this.ast.writeReturn(valueOff, this.pos(startTok)) : 0;
    this.attributeInstruction(returnInstr, node);
    return node;
  }

  throwStatement() {
    const startTok = this.previous; // `throw`
    const valueOff = this.expression();
    const throwInstr = this.emit(OP.THROW);
    this.match(TokenType.SEMICOLON);
    const node = this.ast ? this.ast.writeThrow(valueOff, this.pos(startTok)) : 0;
    this.attributeInstruction(throwInstr, node);
    return node;
  }

  tryStatement() {
    // Parse: try { ... } catch (e) { ... } finally { ... }
    // At least one of catch or finally is required
    const startTok = this.previous; // `try`

    // Emit TRY_PUSH with placeholder operands
    const tryPushIndex = this.emit(OP.TRY_PUSH, 0, 0);
    // The entry is live through the try, catch, AND finally blocks (v11
    // keeps it, disarmed, while handlers run) — break/continue crossing
    // any of them must unwind it.
    this.tryProtectionDepth++;
    this.tryGrantDepths.push(this.grantProtectionDepth);

    // Parse try block
    this.consume(TokenType.LBRACE, "Expected '{' after 'try'");
    const tryBlockTok = this.previous; // `{`
    this.emit(OP.SCOPE_PUSH);
    const tryStmts = [];
    while (!this.check(TokenType.RBRACE) && !this.check(TokenType.EOF)) {
      const off = this.statement();
      if (off) tryStmts.push(off);
    }
    // Emit pending POP before closing scope (block contents aren't results)
    if (this.pendingPop) {
      this.emit(OP.POP);
      this.pendingPop = false;
    }
    this.consume(TokenType.RBRACE, "Expected '}' after try block");
    this.emit(OP.SCOPE_POP);
    const tryBlock = this.ast ? this.ast.writeBlock(tryStmts, this.pos(tryBlockTok)) : 0;

    // Emit TRY_POP (normal exit from try)
    this.emit(OP.TRY_POP);

    // Jump over catch to finally (or end)
    const jumpAfterTryIndex = this.emit(OP.JUMP, 0);

    // Track catch and finally positions
    let catchIndex = 0;
    let finallyIndex = 0;
    let catchParamName = null;
    let catchParamOff = 0;
    let catchBlockOff = 0;
    let finallyBlockOff = 0;

    // Parse catch clause (optional)
    if (this.match(TokenType.CATCH)) {
      catchIndex = this.here;

      // Parse parameter
      this.consume(TokenType.LPAREN, "Expected '(' after 'catch'");
      this.consume(TokenType.IDENTIFIER, "Expected catch parameter name");
      const catchParamTok = this.previous;
      catchParamName = this.internString(catchParamTok.value);
      catchParamOff = this.ast ? this.ast.writeVariableBinding(catchParamName, 0, this.pos(catchParamTok)) : 0;
      this.consume(TokenType.RPAREN, "Expected ')' after catch parameter");

      // Catch body with scope for the error variable
      this.consume(TokenType.LBRACE, "Expected '{' after catch parameter");
      const catchBlockTok = this.previous; // `{`
      this.emit(OP.SCOPE_PUSH);

      // Bind exception to parameter (exception is on pending stack from THROW)
      this.emit(OP.LET_VAR, catchParamName, 0);

      const catchStmts = [];
      while (!this.check(TokenType.RBRACE) && !this.check(TokenType.EOF)) {
        const off = this.statement();
        if (off) catchStmts.push(off);
      }
      // Emit pending POP before closing scope (block contents aren't results)
      if (this.pendingPop) {
        this.emit(OP.POP);
        this.pendingPop = false;
      }
      this.consume(TokenType.RBRACE, "Expected '}' after catch block");
      this.emit(OP.SCOPE_POP);
      // v11: catch entry KEEPS the try entry (catch-disarmed) so abrupt
      // exits from the catch body still route through a finally. Normal
      // catch completion pops it here — or, when a finally follows,
      // diverts through it with a NORMAL completion.
      this.emit(OP.TRY_POP);
      catchBlockOff = this.ast ? this.ast.writeBlock(catchStmts, this.pos(catchBlockTok)) : 0;
    }

    // Parse finally clause (optional)
    if (this.match(TokenType.FINALLY)) {
      finallyIndex = this.here;

      this.consume(TokenType.LBRACE, "Expected '{' after 'finally'");
      const finallyBlockTok = this.previous; // `{`
      this.emit(OP.SCOPE_PUSH);
      const finallyStmts = [];
      while (!this.check(TokenType.RBRACE) && !this.check(TokenType.EOF)) {
        const off = this.statement();
        if (off) finallyStmts.push(off);
      }
      // Emit pending POP before closing scope (block contents aren't results)
      if (this.pendingPop) {
        this.emit(OP.POP);
        this.pendingPop = false;
      }
      this.consume(TokenType.RBRACE, "Expected '}' after finally block");
      this.emit(OP.SCOPE_POP);

      // FINALLY_END dispatches based on completion type
      this.emit(OP.FINALLY_END);
      finallyBlockOff = this.ast ? this.ast.writeBlock(finallyStmts, this.pos(finallyBlockTok)) : 0;
    }

    // Must have at least catch or finally
    if (catchIndex === 0 && finallyIndex === 0) {
      this.error("Expected 'catch' or 'finally' after try block");
    }

    // The entry is dead past this statement (popped by the try/catch
    // TRY_POP or by FINALLY_END).
    this.tryProtectionDepth--;
    this.tryGrantDepths.pop();

    // Patch TRY_PUSH with actual catch and finally indices
    this.patch(tryPushIndex, catchIndex);
    this.mem.codeBlockEditInstruction(tryPushIndex, 'operand2', finallyIndex);

    // Patch jump after try
    // If we have finally, jump to finally
    // If we only have catch, jump to end
    if (finallyIndex !== 0) {
      this.patch(jumpAfterTryIndex, finallyIndex);
    } else {
      this.patch(jumpAfterTryIndex, this.here);
    }

    const tryNode = this.ast ? this.ast.writeTry(tryBlock, catchParamOff, catchBlockOff, finallyBlockOff, this.pos(startTok)) : 0;
    this.attributeInstruction(tryPushIndex, tryNode);
    return tryNode;
  }

  /**
   * Parse grant statement:
   *   grant <expr> { block }
   *   grant <expr> { block } denied { block }
   *   grant <expr> { block } denied (param) { block }
   *   grant (<expr>, <expr>, ...) { block }
   *
   * Code generation for grant "fs" { body } denied (e) { handler }:
   *   <expr>                      ; push identifier value
   *   GRANT_START denied_addr, 1  ; pop 1 identifier, yield STATUS_GRANT_REQUEST
   *   <body>
   *   GRANT_END 1                 ; pop 1 grant entry from stack
   *   JUMP end
   *   denied_addr:
   *   GRANT_DENIED param_offset   ; entry point, sets up param
   *   <handler>
   *   end:
   */
  grantStatement() {
    const startTok = this.previous; // `grant`
    // Parse identifiers: either single expression or parenthesized list
    let identifierCount = 0;
    const identifierOffsets = [];

    if (this.match(TokenType.LPAREN)) {
      // Multiple identifiers: grant ("a", "b") { ... }
      do {
        identifierOffsets.push(this.expression());
        identifierCount++;
      } while (this.match(TokenType.COMMA));
      this.consume(TokenType.RPAREN, "Expected ')' after grant identifiers");
    } else {
      // Single identifier: grant "fs" { ... }
      identifierOffsets.push(this.expression());
      identifierCount = 1;
    }

    // Emit one GRANT_START for the complete identifier group. Its single
    // denied target is copied into every contiguous runtime grant entry and
    // therefore identifies the whole group when revocation unwinds to it.
    const grantStartIndex = this.emit(OP.GRANT_START, 0, identifierCount);
    this.grantProtectionDepth += identifierCount;

    // Parse grant block
    this.consume(TokenType.LBRACE, "Expected '{' after grant expression");
    const bodyTok = this.previous; // `{`
    this.emit(OP.SCOPE_PUSH);
    const bodyStmts = [];
    while (!this.check(TokenType.RBRACE) && !this.check(TokenType.EOF)) {
      const off = this.statement();
      if (off) bodyStmts.push(off);
    }
    this.consume(TokenType.RBRACE, "Expected '}' after grant block");
    this.emit(OP.SCOPE_POP);
    const bodyOff = this.ast ? this.ast.writeBlock(bodyStmts, this.pos(bodyTok)) : 0;

    // Emit GRANT_END with count
    this.emit(OP.GRANT_END, identifierCount);
    this.grantProtectionDepth -= identifierCount;

    // Jump over denied block to end
    const jumpToEndIndex = this.emit(OP.JUMP, 0);

    // Track denied block
    let deniedIndex = 0;
    let deniedParamName = null;
    let deniedBodyOff = 0;

    // Parse denied clause (optional)
    if (this.match(TokenType.DENIED)) {
      deniedIndex = this.here;

      // Optional parameter for denied identifiers array
      if (this.match(TokenType.LPAREN)) {
        this.consume(TokenType.IDENTIFIER, "Expected denied parameter name");
        deniedParamName = this.internString(this.previous.value);
        this.consume(TokenType.RPAREN, "Expected ')' after denied parameter");
      }

      // GRANT_DENIED opcode sets up the parameter (if any)
      this.emit(OP.GRANT_DENIED, deniedParamName || 0);

      // Denied body with scope for the parameter
      this.consume(TokenType.LBRACE, "Expected '{' after denied");
      const deniedBodyTok = this.previous; // `{`
      this.emit(OP.SCOPE_PUSH);

      // If we have a parameter, bind the revoked identifiers array to it
      // The array is pushed by GRANT_DENIED
      if (deniedParamName !== null) {
        this.emit(OP.LET_VAR, deniedParamName, 0);
      }

      const deniedStmts = [];
      while (!this.check(TokenType.RBRACE) && !this.check(TokenType.EOF)) {
        const off = this.statement();
        if (off) deniedStmts.push(off);
      }
      this.consume(TokenType.RBRACE, "Expected '}' after denied block");
      this.emit(OP.SCOPE_POP);
      deniedBodyOff = this.ast ? this.ast.writeBlock(deniedStmts, this.pos(deniedBodyTok)) : 0;
    }

    // Patch jump to end
    this.patch(jumpToEndIndex, this.here);

    // Patch GRANT_START operand1:
    // - If denied block exists: jump to denied block
    // - If no denied block: jump to end (skip the grant block entirely)
    if (deniedIndex !== 0) {
      this.patch(grantStartIndex, deniedIndex);
    } else {
      this.patch(grantStartIndex, this.here);
    }

    return this.ast ? this.ast.writeGrant(identifierOffsets, bodyOff, deniedParamName || 0, deniedBodyOff, this.pos(startTok)) : 0;
  }

  exportDeclaration() {
    if (this.scopeDepth > 0 || this.functionStack.length > 0) {
      throw this.error("'export' may only appear at the top level");
    }

    if (this.match(TokenType.CONST)) {
      return this._exportVariableDeclaration(true);
    } else if (this.match(TokenType.LET)) {
      return this._exportVariableDeclaration(false);
    } else if (this.match(TokenType.VAR)) {
      return this._exportVariableDeclaration(false);
    } else if (this.match(TokenType.FUNCTION)) {
      // `export function* g()` puts the star before the name, so the
      // export name is recorded by functionDeclaration itself.
      const off = this.functionDeclaration(false, true);
      this.exports.set(this.lastFunctionDeclarationName, { type: 'function' });
      return off;
    } else if (this.match(TokenType.ASYNC)) {
      if (!this.match(TokenType.FUNCTION)) {
        throw this.error("Expected 'function' after 'export async'");
      }
      const off = this.functionDeclaration(true, true);
      this.exports.set(this.lastFunctionDeclarationName, { type: 'function' });
      return off;
    } else if (this.match(TokenType.CLASS)) {
      const off = this.classDeclaration(true);
      this.exports.set(this.lastFunctionDeclarationName, { type: 'class' });
      return off;
    } else {
      throw this.error("Expected declaration after 'export'");
    }
  }

  _exportVariableDeclaration(isConst) {
    const declTok = this.previous; // `const` / `let` / `var`
    const type = isConst ? 'const' : 'let';
    const names = [];
    const bindings = [];
    do {
      names.push(this.current.value);
      this.consume(TokenType.IDENTIFIER, 'Expected variable name');
      const nameTok = this.previous;
      const varStart = nameTok.start;
      const varEnd = nameTok.end;
      const name = this.internString(nameTok.value);

      let initOff = 0;
      if (this.match(TokenType.ASSIGN)) {
        initOff = this.expression();
      } else if (isConst) {
        throw this.error("Missing initializer in const declaration");
      } else {
        this.emit(OP.LIT_UNDEFINED);
      }

      const bindingOff = this.ast ? this.ast.writeVariableBinding(name, initOff, this.pos(nameTok)) : 0;
      bindings.push(bindingOff);
      this.emitWithSource(OP.LET_VAR, name, isConst ? SCOPE_FLAG_CONST : 0, varStart, varEnd, bindingOff);
    } while (this.match(TokenType.COMMA));

    this.match(TokenType.SEMICOLON);

    for (const n of names) {
      this.exports.set(n, { type });
    }
    return this.ast ? this.ast.writeVariableDecl(bindings, isConst, this.pos(declTok), true) : 0;
  }

  block() {
    const startTok = this.previous; // `{`
    this.emit(OP.SCOPE_PUSH);
    const stmts = [];
    while (!this.check(TokenType.RBRACE) && !this.check(TokenType.EOF)) {
      const off = this.statement();
      if (off) stmts.push(off);
    }
    // Emit pending POP before closing scope (block expressions aren't REPL results)
    if (this.pendingPop) {
      this.emit(OP.POP);
      this.pendingPop = false;
    }
    this.consume(TokenType.RBRACE, "Expected '}' after block");
    this.emit(OP.SCOPE_POP);
    return this.ast ? this.ast.writeBlock(stmts, this.pos(startTok)) : 0;
  }

  expressionStatement() {
    const startTok = this.current;
    const exprOff = this.expression();
    this.pendingPop = true; // defer POP so REPL can read result
    this.match(TokenType.SEMICOLON);
    return this.ast ? this.ast.writeExpressionStatement(exprOff, this.pos(startTok)) : 0;
  }

  // ===========================================================================
  // Expressions (Pratt parser)
  // ===========================================================================

  expression() {
    return this.parsePrecedence(PREC.ASSIGNMENT);
  }

  parsePrecedence(precedence) {
    this.advance();

    // Prefix rule
    const prefixRule = this.getPrefixRule(this.previous.type);
    if (!prefixRule) {
      this.error(`Unexpected token '${this.previous.value || this.previous.type}'`);
      return 0;
    }

    const canAssign = precedence <= PREC.ASSIGNMENT;
    let astOff = prefixRule.call(this, canAssign) || 0;

    // Infix rules. Each rule receives the left-hand AST offset and returns
    // the new combined offset.
    while (precedence <= this.getInfixPrecedence(this.current.type)) {
      this.advance();
      const infixRule = this.getInfixRule(this.previous.type);
      astOff = infixRule.call(this, canAssign, astOff) || 0;
    }
    return astOff;
  }

  // ===========================================================================
  // Prefix rules
  // ===========================================================================

  getPrefixRule(type) {
    switch (type) {
      case TokenType.NUMBER: return this.number;
      case TokenType.INTEGER: return this.integerLiteral;
      case TokenType.BIGINT: return this.bigintLiteral;
      case TokenType.STRING: return this.string;
      case TokenType.TEMPLATE_NO_SUB: return this.templateNoSub;
      case TokenType.TEMPLATE_HEAD: return this.templateWithSubs;
      case TokenType.TRUE: return this.literal;
      case TokenType.FALSE: return this.literal;
      case TokenType.NULL: return this.literal;
      case TokenType.UNDEFINED: return this.literal;
      case TokenType.IDENTIFIER: return this.variable;
      case TokenType.THIS: return this.thisKeyword;
      case TokenType.CLASS: return this.classExpression;
      case TokenType.SUPER: return this.superExpression;
      case TokenType.FUNCTION: return this.functionExpression;
      case TokenType.ASYNC: return this.asyncExpression;
      case TokenType.LPAREN: return this.grouping;
      case TokenType.LBRACKET: return this.arrayLiteral;
      case TokenType.LBRACE: return this.objectLiteral;
      case TokenType.PLUS: return this.unary;
      case TokenType.MINUS: return this.unary;
      case TokenType.NOT: return this.unary;
      case TokenType.TYPEOF: return this.unary;
      case TokenType.VOID: return this.unary;
      case TokenType.DELETE: return this.unary;
      case TokenType.TILDE: return this.unary;
      case TokenType.PLUS_PLUS: return this.prefixIncrement;
      case TokenType.MINUS_MINUS: return this.prefixIncrement;
      case TokenType.NEW: return this.newExpression;
      case TokenType.AWAIT: return this.awaitExpression;
      // A slash at expression position is a RegExp literal, never
      // division: re-scan it under the InputElementRegExp lexical goal.
      // SLASH_ASSIGN too — /=foo/ is a regex matching "=foo".
      case TokenType.SLASH: return this.regexpLiteral;
      case TokenType.SLASH_ASSIGN: return this.regexpLiteral;
      default: return null;
    }
  }

  regexpLiteral() {
    // this.previous is the SLASH/SLASH_ASSIGN token, but this.current was
    // already lexed from inside the literal under the division goal.
    // Re-scan from the slash under the RegExp goal, then re-prime the
    // lookahead from the position past the literal.
    const token = this.lexer.rescanRegExpFrom(this.previous);
    this.previous = token;
    this.current = this.lexer.next();
    while (this.current.type === TokenType.COMMENT) {
      this.current = this.lexer.next();
    }

    const { pattern, flags } = token.value;
    let flagsWord = 0;
    for (const letter of flags) {
      if (REGEX_UNSUPPORTED_FLAG_LETTERS.includes(letter)) {
        this.error(`RegExp flag '${letter}' is not supported`);
      }
      const bit = REGEX_FLAG_BY_LETTER[letter];
      if (bit === undefined) {
        this.error(`Invalid RegExp flag '${letter}'`);
      }
      if (flagsWord & bit) {
        this.error(`Duplicate RegExp flag '${letter}'`);
      }
      flagsWord |= bit;
    }
    const patternBytes = new TextEncoder().encode(pattern).length;
    if (patternBytes > REGEX_LIMIT.MAX_PATTERN_BYTES) {
      this.error(
        `RegExp pattern exceeds ${REGEX_LIMIT.MAX_PATTERN_BYTES} bytes`);
    }

    const patternOffset = this.internString(pattern);
    const node = this.ast
      ? this.ast.writeLiteralRegExp(patternOffset, flagsWord, this.pos(token))
      : 0;
    this.emit(OP.LIT_REGEXP, patternOffset, flagsWord, node);
    return node;
  }

  number() {
    // All numbers are f64 (JS semantics)
    const value = this.previous.value;
    const buffer = new ArrayBuffer(8);
    const f64 = new Float64Array(buffer);
    const u32 = new Uint32Array(buffer);
    f64[0] = value;
    const node = this.ast ? this.ast.writeLiteralFloat(value, this.pos(this.previous)) : 0;
    this.emit(OP.LIT_FLOAT, u32[0], u32[1], node);
    return node;
  }

  bigintLiteral() {
    const digitString = this.previous.value;
    // Convert digit string to JS BigInt, then marshal to heap
    const jsBigInt = BigInt(digitString);
    const headerPointer = this.mem.marshalBigInt(jsBigInt);
    const node = this.ast ? this.ast.writeLiteralBigInt(this.internString(digitString), this.pos(this.previous)) : 0;
    this.emit(OP.LIT_BIGINT, headerPointer, 0, node);
    return node;
  }

  // Integer literal — produces a Rational (denominator = 1). Uses the inline
  // small-Rational representation when the value fits signed i64; otherwise
  // marshals a heap BigInt numerator at parse time (one-time cost per literal).
  integerLiteral() {
    const value = this.previous.value; // JS BigInt
    // AST: LiteralInteger holds an i64 directly (BigInt converted at write).
    // For BigInt values out of i64 range, we'd need LiteralBigInt — but
    // integerLiteral here is for source like `5`, not `5n`. SS lit_rational
    // can hold larger values via BigInt heap, but we can't fit > i64 in the
    // AST LITERAL_INTEGER node. For values out of i64 range, fall back to
    // a LITERAL_RATIONAL with denominator 1 and i64-clamped numerator (rare).
    const I64_MIN = -(1n << 63n);
    const I64_MAX = (1n << 63n) - 1n;
    let node = 0;
    if (value >= I64_MIN && value <= I64_MAX) {
      if (this.ast) node = this.ast.writeLiteralInteger(value, this.pos(this.previous));
      // Inline: pack i64 as two u32s (little-endian).
      const buffer = new ArrayBuffer(8);
      const i64view = new BigInt64Array(buffer);
      const u32view = new Uint32Array(buffer);
      i64view[0] = value;
      this.emit(OP.LIT_RATIONAL_INTEGER, u32view[0], u32view[1], node);
    } else {
      if (this.ast) node = this.ast.writeLiteralRational(value, 1n, this.pos(this.previous));
      const headerPointer = this.mem.marshalBigInt(value);
      this.emit(OP.LIT_RATIONAL_BIGINT, headerPointer, 0, node);
    }
    return node;
  }

  string() {
    const offset = this.internString(this.previous.value);
    const node = this.ast ? this.ast.writeLiteralString(offset, this.pos(this.previous)) : 0;
    this.emit(OP.LIT_STRING, offset, 0, node);
    return node;
  }

  /**
   * Template literal with no substitutions: `plain text`.
   * Lower to a single LIT_STRING — indistinguishable at runtime from a
   * regular string literal.
   */
  templateNoSub() {
    const startTok = this.previous;
    const offset = this.internString(startTok.value);
    const literalNode = this.ast ? this.ast.writeLiteralString(offset, this.pos(startTok)) : 0;
    this.emit(OP.LIT_STRING, offset, 0, literalNode);
    if (this.ast) {
      // Wrap as a single-part TEMPLATE_LITERAL so source maps reflect the
      // original syntactic form.
      return this.ast.writeTemplateLiteral([literalNode], this.pos(startTok));
    }
    return literalNode;
  }

  /**
   * Template literal with at least one `${...}` substitution. The lexer
   * emits TEMPLATE_HEAD ... (expression tokens) ... TEMPLATE_MIDDLE ...
   * ... TEMPLATE_TAIL. Desugar to a chain of LIT_STRING + expression +
   * ADD that builds the final string left-to-right.
   *
   * Each substitution expression is concatenated via OP.ADD, which on
   * a string LHS coerces the RHS via String(rhs) — matching template-
   * literal semantics for non-string substitutions. We always start the
   * chain with a string (the HEAD), so coercion fires correctly even when
   * the first substitution is at the very start (HEAD is then the empty
   * string).
   */
  templateWithSubs() {
    // First part is the HEAD string fragment (this.previous).
    const startTok = this.previous;
    const headOffset = this.internString(startTok.value);
    const partNodes = [];
    const headNode = this.ast ? this.ast.writeLiteralString(headOffset, this.pos(startTok)) : 0;
    partNodes.push(headNode);
    this.emit(OP.LIT_STRING, headOffset, 0, headNode);

    // Loop: parse one substitution expression, then expect a MIDDLE or TAIL.
    while (true) {
      // Parse the substitution expression. expression() consumes tokens up
      // through the `}` that closes the substitution — the lexer detects
      // that `}` via templateBraceDepth and flips back to template-string
      // scanning, which produces the next MIDDLE / TAIL token.
      const exprNode = this.expression();
      partNodes.push(exprNode);
      this.emit(OP.ADD);

      // expression() leaves this.current at the next token, which should
      // now be a MIDDLE (more substitutions follow) or a TAIL (template
      // closes after this).
      if (this.match(TokenType.TEMPLATE_TAIL)) {
        const tailTok = this.previous;
        const tailOffset = this.internString(tailTok.value);
        const tailNode = this.ast ? this.ast.writeLiteralString(tailOffset, this.pos(tailTok)) : 0;
        partNodes.push(tailNode);
        // Only emit a trailing concat if the tail isn't empty (saves a
        // useless ADD with an empty string at the end of templates like
        // `prefix${expr}`).
        if (tailTok.value.length > 0) {
          this.emit(OP.LIT_STRING, tailOffset, 0, tailNode);
          this.emit(OP.ADD);
        }
        break;
      }
      if (this.match(TokenType.TEMPLATE_MIDDLE)) {
        const midTok = this.previous;
        const midOffset = this.internString(midTok.value);
        const midNode = this.ast ? this.ast.writeLiteralString(midOffset, this.pos(midTok)) : 0;
        partNodes.push(midNode);
        if (midTok.value.length > 0) {
          this.emit(OP.LIT_STRING, midOffset, 0, midNode);
          this.emit(OP.ADD);
        }
        continue;
      }
      throw this.error("Expected '}' to close template substitution");
    }

    return this.ast ? this.ast.writeTemplateLiteral(partNodes, this.pos(startTok)) : 0;
  }

  literal() {
    let node = 0;
    const pos = this.pos(this.previous);
    switch (this.previous.type) {
      case TokenType.TRUE:
        node = this.ast ? this.ast.writeLiteralBoolean(true, pos) : 0;
        this.emit(OP.LIT_TRUE, 0, 0, node);
        break;
      case TokenType.FALSE:
        node = this.ast ? this.ast.writeLiteralBoolean(false, pos) : 0;
        this.emit(OP.LIT_FALSE, 0, 0, node);
        break;
      case TokenType.NULL:
        node = this.ast ? this.ast.writeLiteralNull(pos) : 0;
        this.emit(OP.LIT_NULL, 0, 0, node);
        break;
      case TokenType.UNDEFINED:
        node = this.ast ? this.ast.writeLiteralUndefined(pos) : 0;
        this.emit(OP.LIT_UNDEFINED, 0, 0, node);
        break;
    }
    return node;
  }

  variable(canAssign) {
    const varTok = this.previous;
    const varStart = varTok.start;
    const varEnd = varTok.end;
    const nameValue = varTok.value;  // Don't intern yet - might be arrow param

    // `yield` is a contextual keyword: an expression form only directly
    // inside a generator body (INTERNALS.md's Generators section). Elsewhere it stays an
    // ordinary identifier.
    if (nameValue === 'yield'
        && this.functionStack.length > 0
        && this.functionStack[this.functionStack.length - 1].isGenerator) {
      return this.yieldExpression(varTok);
    }

    // Check for arrow function: x => ...
    // Only allow in assignment contexts (matches JS grammar restriction)
    if (canAssign && this.check(TokenType.ARROW)) {
      return this.arrowFunction([nameValue], varStart, false, varTok);
    }

    // Now intern the name since it's definitely a variable
    const name = this.internString(nameValue);
    const idNode = this.ast ? this.ast.writeIdentifier(name, this.pos(varTok)) : 0;

    if (canAssign && this.match(TokenType.ASSIGN)) {
      const valueOff = this.expression();
      const node = this.ast ? this.ast.writeAssignment(AssignOp.EQ, idNode, valueOff, this.pos(varTok)) : 0;
      this.emitWithSource(OP.SET_VAR, name, 0, varStart, varEnd, node);
      return node;
    } else if (canAssign && this.matchCompoundAssign()) {
      const compoundOp = this.previous.type;
      this.emit(OP.GET_VAR, name, 0, idNode);
      const valueOff = this.expression();
      const opKind = assignOpFromToken(compoundOp);
      const node = this.ast ? this.ast.writeAssignment(opKind, idNode, valueOff, this.pos(varTok)) : 0;
      this.emitCompoundOp(compoundOp);
      this.emitWithSource(OP.SET_VAR, name, 0, varStart, varEnd, node);
      return node;
    } else if (this.match(TokenType.PLUS_PLUS) || this.match(TokenType.MINUS_MINUS)) {
      const isIncrement = this.previous.type === TokenType.PLUS_PLUS;
      const opKind = isIncrement ? UpdateOp.PLUS_PLUS : UpdateOp.MINUS_MINUS;
      const node = this.ast ? this.ast.writeUpdate(opKind, idNode, false, this.pos(varTok)) : 0;
      this.emit(OP.GET_VAR, name, 0, idNode);
      this.emit(OP.GET_VAR, name, 0, idNode);
      this.emitLitRationalInteger(1);
      this.emit(isIncrement ? OP.ADD : OP.SUB);
      this.emitWithSource(OP.SET_VAR, name, 0, varStart, varEnd, node);
      this.emit(OP.POP);
      return node;
    } else {
      this.emit(OP.GET_VAR, name, 0, idNode);
      return idNode;
    }
  }

  /**
   * Handle `this` keyword - emits GET_VAR with interned "this" string.
   */
  thisKeyword() {
    const thisName = this.internString('this');
    const node = this.ast ? this.ast.writeThis(this.pos(this.previous)) : 0;
    this.emit(OP.GET_VAR, thisName, 0, node);
    return node;
  }

  /**
   * Handle `function` keyword for function expressions.
   * Syntax: function(params) { body } or function name(params) { body }
   * Emits MAKE_CLOSURE (not MAKE_ARROW_CLOSURE - binds this).
   */
  functionExpression() {
    const startTok = this.previous; // `function`
    // Generator expression: `function* () { ... }`
    const isGenerator = this.match(TokenType.STAR);
    // Parse optional function name (for named function expressions)
    let nameOffset = 0;
    if (this.check(TokenType.IDENTIFIER)) {
      this.advance();
      nameOffset = this.internString(this.previous.value);
    }

    // Parse parameters
    this.consume(TokenType.LPAREN, "Expected '(' after 'function'");
    const params = this.parseFunctionParams();

    // Parse body - must be a block
    this.consume(TokenType.LBRACE, "Expected '{' before function body");
    const { paramBindings, bodyBlock, closureInstr } = this.emitFunctionBody(params, false, false, isGenerator);
    const fnNode = this.ast ? this.ast.writeFunctionDecl({
      nameOffset,
      params: paramBindings,
      body: bodyBlock,
      flags: isGenerator ? FLAG.FN_GENERATOR : 0,
      pos: this.pos(startTok),
    }) : 0;
    this.attributeInstruction(closureInstr, fnNode);
    return fnNode;
  }

  /**
   * Handle `async` keyword in expression position.
   * Syntax: async function(params) { body }, async () => ..., async x => ...
   */
  asyncExpression() {
    const startTok = this.previous; // `async`
    const startPos = startTok.start;

    // async function expression (async function* for the generator form)
    if (this.match(TokenType.FUNCTION)) {
      const isGenerator = this.match(TokenType.STAR);
      // Parse optional function name
      let nameOffset = 0;
      if (this.check(TokenType.IDENTIFIER)) {
        this.advance();
        nameOffset = this.internString(this.previous.value);
      }

      // Parse parameters
      this.consume(TokenType.LPAREN, "Expected '(' after 'function'");
      const params = this.parseFunctionParams();

      // Parse body
      this.consume(TokenType.LBRACE, "Expected '{' before function body");
      const { paramBindings, bodyBlock, closureInstr } = this.emitFunctionBody(params, false, true, isGenerator);
      const fnNode = this.ast ? this.ast.writeFunctionDecl({
        nameOffset,
        params: paramBindings,
        body: bodyBlock,
        flags: FLAG.FN_ASYNC | (isGenerator ? FLAG.FN_GENERATOR : 0),
        pos: this.pos(startTok),
      }) : 0;
      this.attributeInstruction(closureInstr, fnNode);
      return fnNode;
    }

    // async arrow function: async (params) => ...
    // `async (` is unambiguous (no `(expr)` cover-grammar ambiguity here —
    // `async` already committed us to a function form), so we route
    // straight through parseFunctionParams. It handles patterns, defaults,
    // rest, and mixed parameter shapes.
    if (this.check(TokenType.LPAREN)) {
      this.advance(); // consume (
      const params = this.parseFunctionParams();
      return this.arrowFunction(params, startPos, true, startTok);
    }

    if (this.check(TokenType.IDENTIFIER)) {
      // async x => ...
      this.consume(TokenType.IDENTIFIER, "Expected parameter name");
      const params = [this.previous.value];
      return this.arrowFunction(params, startPos, true, startTok);
    }

    this.error("Expected 'function', '(' or identifier after 'async'");
    return 0;
  }

  /**
   * Match any compound assignment token.
   */
  matchCompoundAssign() {
    if (this.check(TokenType.PLUS_ASSIGN) ||
        this.check(TokenType.MINUS_ASSIGN) ||
        this.check(TokenType.STAR_ASSIGN) ||
        this.check(TokenType.SLASH_ASSIGN) ||
        this.check(TokenType.PERCENT_ASSIGN) ||
        this.check(TokenType.STAR_STAR_ASSIGN) ||
        this.check(TokenType.AMPERSAND_ASSIGN) ||
        this.check(TokenType.PIPE_ASSIGN) ||
        this.check(TokenType.CARET_ASSIGN) ||
        this.check(TokenType.LSHIFT_ASSIGN) ||
        this.check(TokenType.RSHIFT_ASSIGN) ||
        this.check(TokenType.URSHIFT_ASSIGN)) {
      this.advance();
      return true;
    }
    return false;
  }

  /**
   * Emit the binary operation for compound assignment.
   */
  emitCompoundOp(tokenType) {
    switch (tokenType) {
      case TokenType.PLUS_ASSIGN: this.emit(OP.ADD); break;
      case TokenType.MINUS_ASSIGN: this.emit(OP.SUB); break;
      case TokenType.STAR_ASSIGN: this.emit(OP.MUL); break;
      case TokenType.SLASH_ASSIGN: this.emit(OP.DIV); break;
      case TokenType.PERCENT_ASSIGN: this.emit(OP.MOD); break;
      case TokenType.STAR_STAR_ASSIGN: this.emit(OP.POW); break;
      case TokenType.AMPERSAND_ASSIGN: this.emit(OP.BAND); break;
      case TokenType.PIPE_ASSIGN: this.emit(OP.BOR); break;
      case TokenType.CARET_ASSIGN: this.emit(OP.BXOR); break;
      case TokenType.LSHIFT_ASSIGN: this.emit(OP.SHL); break;
      case TokenType.RSHIFT_ASSIGN: this.emit(OP.SHR); break;
      case TokenType.URSHIFT_ASSIGN: this.emit(OP.USHR); break;
    }
  }

  grouping() {
    // Could be: (expr) or (params) => body
    //
    // Cover-grammar dispatch: skim ahead to the matching `)`. If `=>`
    // follows, this is an arrow function — route through parseFunctionParams
    // which handles patterns, defaults, rest, and mixed parameter forms.
    // Otherwise it's a parenthesized expression (or comma expression).
    //
    // The skim must be token-level (the lexer handles strings/regexes;
    // a character-level scan would mis-count `)` inside strings) and
    // depth-aware across `(`, `[`, `{`.

    const startTok = this.previous; // `(`
    const startPos = startTok.start;

    // Snapshot lexer state for the skim. We restore unconditionally
    // before deciding what to do — skim is non-destructive.
    const savedLexer = this.lexer.saveState();
    const savedCurrent = this.current;
    const savedPrevious = this.previous;

    let isArrow = false;
    try {
      this.skimBalanced();   // consumes through the matching `)`
      isArrow = this.check(TokenType.ARROW);
    } catch (_e) {
      // Unbalanced — fall through to expression path; that path will
      // produce a normal parse error at the right spot. skimBalanced()
      // throws via error(), which latches hadError; clear it here so
      // the real error below isn't suppressed by cascading-error
      // suppression before it can report its own line/col.
      this.hadError = false;
      isArrow = false;
    }
    // Restore — we only peeked.
    this.lexer.restoreState(savedLexer);
    this.current = savedCurrent;
    this.previous = savedPrevious;

    if (isArrow) {
      // Empty params: `() =>`. parseFunctionParams handles this too,
      // but a fast path avoids needless work.
      if (this.check(TokenType.RPAREN)) {
        this.advance();   // consume `)`
        return this.arrowFunction([], startPos, false, startTok);
      }
      // Everything else: patterns, defaults, rest, mixed. The shared
      // parser handles all parameter shapes.
      const params = this.parseFunctionParams();   // consumes through `)`
      return this.arrowFunction(params, startPos, false, startTok);
    }

    // Not an arrow. Fall through to expression-grouping logic.
    // The empty-parens case `()` is still a parse error from JS's
    // perspective; preserve the existing lenient behavior of returning
    // `undefined` so we don't regress.
    if (this.check(TokenType.RPAREN)) {
      this.advance();
      const node = this.ast ? this.ast.writeLiteralUndefined(this.pos(startTok)) : 0;
      this.emit(OP.LIT_UNDEFINED, 0, 0, node);
      return node;
    }

    // The legacy identifier-led arrow detection used to live here. It's
    // now subsumed by the skim+parseFunctionParams path above. Remaining
    // logic below handles parenthesized expressions, including the
    // `(x = expr)` and `(x += expr)` assignment-in-grouping forms that
    // the original code special-cased.
    if (this.check(TokenType.IDENTIFIER)) {
      // Collect first identifier so we can build either an assignment
      // expression or a plain GET_VAR expression.
      this.advance();
      const identTok = this.previous;
      const firstParam = identTok.value;

      // (x + ...) or (x.foo) or (x = ...) or (x += ...) - this is an expression
      // We need to continue parsing the expression with x already consumed
      const name = this.internString(firstParam);
      const idNode = this.ast ? this.ast.writeIdentifier(name, this.pos(identTok)) : 0;

      // Check for assignment: (x = expr)
      if (this.check(TokenType.ASSIGN)) {
        this.advance(); // consume =
        const valOff = this.expression();
        const assignNode = this.ast ? this.ast.writeAssignment(AssignOp.EQ, idNode, valOff, this.pos(identTok)) : 0;
        this.emit(OP.SET_VAR, name, 0, assignNode);
        let astOff = assignNode;
        while (PREC.COMMA <= this.getInfixPrecedence(this.current.type)) {
          this.advance();
          const infixRule = this.getInfixRule(this.previous.type);
          astOff = infixRule.call(this, true, astOff) || 0;
        }
        this.consume(TokenType.RPAREN, "Expected ')' after expression");
        return astOff;
      }

      // Check for compound assignment: (x += expr)
      if (this.matchCompoundAssign()) {
        const compoundOp = this.previous.type;
        this.emit(OP.GET_VAR, name, 0, idNode);
        const valOff = this.expression();
        const opKind = assignOpFromToken(compoundOp);
        const assignNode = this.ast ? this.ast.writeAssignment(opKind, idNode, valOff, this.pos(identTok)) : 0;
        this.emitCompoundOp(compoundOp);
        this.emit(OP.SET_VAR, name, 0, assignNode);
        let astOff = assignNode;
        while (PREC.COMMA <= this.getInfixPrecedence(this.current.type)) {
          this.advance();
          const infixRule = this.getInfixRule(this.previous.type);
          astOff = infixRule.call(this, true, astOff) || 0;
        }
        this.consume(TokenType.RPAREN, "Expected ')' after expression");
        return astOff;
      }

      // Push GET_VAR for x, then continue with infix parsing
      this.emit(OP.GET_VAR, name, 0, idNode);
      let astOff = idNode;

      // Continue parsing infix operators (allow comma inside parens)
      while (PREC.COMMA <= this.getInfixPrecedence(this.current.type)) {
        this.advance();
        const infixRule = this.getInfixRule(this.previous.type);
        astOff = infixRule.call(this, true, astOff) || 0;
      }

      this.consume(TokenType.RPAREN, "Expected ')' after expression");
      return astOff;
    }

    // Not an identifier first - must be regular grouping expression
    // Allow comma operator inside parentheses
    const off = this.parsePrecedence(PREC.COMMA);
    this.consume(TokenType.RPAREN, "Expected ')' after expression");
    return off;
  }

  /**
   * Parse arrow function body and emit MAKE_ARROW_CLOSURE.
   *
   * Bytecode layout:
   *   [MAKE_ARROW_CLOSURE start, end]
   *   [JUMP past_end]
   *   [function body...]  <- start points here
   *   [RETURN]
   *   ... <- end points here, past_end too
   *
   * @param {string[]} params - Parameter names (not interned yet)
   * @param {number} startPos - Source position of arrow function start
   * @param {boolean} isAsync - If true, emit async arrow closure opcode
   * @param {object} [startTok] - Token marking the arrow function's start
   *   (for AST source position; startPos alone is a character offset with
   *   no line/col).
   */
  arrowFunction(params, startPos, isAsync = false, startTok = null) {
    // Arrow callers may still pass `params` as a plain string[] from
    // the single-identifier path (`x => ...`). The cover-grammar
    // dispatch in grouping() routes through parseFunctionParams which
    // produces descriptor objects directly. Wrap any bare strings to
    // normalize.
    params = params.map(p => {
      if (typeof p === 'string') {
        const name = this.internString(p);
        return { kind: 'ident', name, nameTok: { start: 0, end: 0 } };
      }
      return p;
    });
    this.consume(TokenType.ARROW, "Expected '=>'");

    // Parse body
    let fnNode = 0;
    if (this.check(TokenType.LBRACE)) {
      // Block body: { statements } - use shared helper
      this.advance(); // consume {
      const { paramBindings, bodyBlock, closureInstr } = this.emitFunctionBody(params, true, isAsync);
      fnNode = this.ast ? this.ast.writeFunctionDecl({
        nameOffset: 0,
        params: paramBindings,
        body: bodyBlock,
        flags: FLAG.FN_ARROW | (isAsync ? FLAG.FN_ASYNC : 0),
        pos: startTok ? this.pos(startTok) : undefined,
      }) : 0;
      this.attributeInstruction(closureInstr, fnNode);
    } else {
      // Expression body: expr (implicit return)
      // Can't use helper since there's no closing brace
      const closureOp = isAsync ? OP.MAKE_ASYNC_ARROW_CLOSURE : OP.MAKE_ARROW_CLOSURE;
      const closureInstr = this.emit(closureOp, 0, 0);
      const jumpInstr = this.emit(OP.JUMP, 0);

      const bodyStart = this.here;
      const lastKind = params.length > 0 ? params[params.length - 1].kind : null;
      const hasRest = (lastKind === 'rest' || lastKind === 'rest-pattern') ? 1 : 0;
      if (params.length > MAX_PARAMETER_COUNT) {
        throw this.error(`Too many parameters (max ${MAX_PARAMETER_COUNT})`);
      }
      this.emit(OP.RECONCILE_PARAMS, params.length, hasRest);

      // AST param entries, filled during binding (same shapes as
      // emitFunctionBody's).
      const paramBindings = params.map(() => 0);

      // Parameter binding. Mirrors emitFunctionBody's param-binding
      // path; arrow expression-body has its own copy because it doesn't
      // go through a `{ ... }` block parse. See emitFunctionBody for the
      // two-phase forward-binding rationale (defaults referencing
      // earlier parameters).
      const bindParam = (p, index) => {
        let defaultOff = 0;
        if (p.hasDefault) {
          this.emit(OP.DUP);
          this.emit(OP.LIT_UNDEFINED);
          this.emit(OP.EQ);
          const skip = this.emit(OP.JUMP_IF_FALSE, 0);
          this.emit(OP.POP);
          const here = this.lexer.saveState();
          const hereCurrent = this.current;
          const herePrevious = this.previous;
          this.lexer.restoreState(p.defaultStart);
          this.current = p.defaultCurrent;
          this.previous = p.defaultPrevious;
          defaultOff = this.expression();
          this.lexer.restoreState(here);
          this.current = hereCurrent;
          this.previous = herePrevious;
          this.patch(skip, this.here);
        }
        if (p.kind === 'ident' || p.kind === 'rest') {
          this.emitWithSource(OP.LET_VAR, p.name, 0, p.nameTok.start, p.nameTok.end, 0);
          if (this.ast) {
            const bindingOff = this.ast.writeVariableBinding(p.name, defaultOff, this.pos(p.nameTok));
            paramBindings[index] = p.kind === 'rest'
              ? this.ast.writeSpread(bindingOff, this.pos(p.nameTok)) : bindingOff;
          }
          return;
        }
        const here = this.lexer.saveState();
        const hereCurrent = this.current;
        const herePrevious = this.previous;
        const patternStartTok = p.patternCurrent;
        this.lexer.restoreState(p.patternStart);
        this.current = p.patternCurrent;
        this.previous = p.patternPrevious;
        let patternOff;
        if (this.check(TokenType.LBRACKET)) {
          patternOff = this.arrayPatternBind(0);
        } else {
          patternOff = this.objectPatternBind(0);
        }
        this.lexer.restoreState(here);
        this.current = hereCurrent;
        this.previous = herePrevious;
        if (this.ast && patternOff) {
          if (defaultOff) this.ast.patchPatternInitializer(patternOff, defaultOff);
          paramBindings[index] = p.kind === 'rest-pattern'
            ? this.ast.writeSpread(patternOff, this.pos(patternStartTok)) : patternOff;
        }
      };
      if (!params.some(p => p.hasDefault)) {
        for (let i = params.length - 1; i >= 0; i--) {
          bindParam(params[i], i);
        }
      } else {
        for (let i = params.length - 1; i >= 0; i--) {
          this.emit(OP.LET_VAR, this.internString(`@param_${i}`));
        }
        for (let i = 0; i < params.length; i++) {
          this.emit(OP.GET_VAR, this.internString(`@param_${i}`));
          bindParam(params[i], i);
        }
      }

      // Track function context for await validation
      this.functionStack.push({ isAsync, isGenerator: false, isArrow: true });

      const exprOff = this.expression();

      // Restore function context
      this.functionStack.pop();

      // The implicit return wraps the expression. Attribute the RETURN
      // instruction to a synthetic Return node whose value points at the
      // expression node.
      const returnNode = this.ast ? this.ast.writeReturn(exprOff, startTok ? this.pos(startTok) : undefined) : 0;
      this.emit(OP.RETURN, 0, 0, returnNode);

      const bodyEnd = this.here;

      this.patch(closureInstr, bodyStart);
      this.patchOperand2(closureInstr, bodyEnd);
      this.patch(jumpInstr, bodyEnd);

      const bodyBlock = this.ast ? this.ast.writeBlock([returnNode], startTok ? this.pos(startTok) : undefined) : 0;
      fnNode = this.ast ? this.ast.writeFunctionDecl({
        nameOffset: 0,
        params: paramBindings,
        body: bodyBlock,
        flags: FLAG.FN_ARROW | (isAsync ? FLAG.FN_ASYNC : 0),
        pos: startTok ? this.pos(startTok) : undefined,
      }) : 0;
      this.attributeInstruction(closureInstr, fnNode);
    }
    return fnNode;
  }

  /**
   * Patch operand2 of an instruction.
   */
  patchOperand2(index, value) {
    this.mem.codeBlockEditInstruction(index, 'operand2', value);
  }

  /**
   * Emit function body bytecode (shared by declarations, expressions, methods, arrows).
   *
   * Expects: opening brace already consumed (for block bodies)
   * Emits: MAKE_CLOSURE/MAKE_ARROW_CLOSURE, JUMP, body, RETURN, patches operands
   *
   * Returns { paramBindings, bodyBlock, closureInstr } so callers can wrap
   * the result in the appropriate AST node (FunctionDecl as statement,
   * FunctionDecl as expression, method shorthand, etc.) and attribute the
   * closure-emitting instruction to that node.
   *
   * @param {Array} params - Parameter descriptors from parseFunctionParams
   * @param {boolean} isArrow - If true, emit MAKE_ARROW_CLOSURE (no `this` binding)
   * @param {boolean} isAsync - If true, emit async variant of closure opcode
   */
  /**
   * Parse a function's parameter list from the opening LPAREN's
   * already-consumed state. Each parameter is one of:
   *
   *   { kind: 'ident', name, nameTok }
   *   { kind: 'ident', name, nameTok, hasDefault, defaultStart, defaultCurrent, defaultPrevious }
   *   { kind: 'pattern', patternStart, patternCurrent, patternPrevious, hasDefault, ... }
   *
   * Pattern parameters and default expressions are captured by
   * snapshot — the actual bytecode emit happens during emitFunctionBody
   * after the lexer rewind. We consume the closing RPAREN before
   * returning.
   */
  parseFunctionParams() {
    const params = [];
    if (!this.check(TokenType.RPAREN)) {
      do {
        if (this.match(TokenType.DOT_DOT_DOT)) {
          // Rest parameter: collects all remaining args into an array.
          // Must be the last parameter. The target is a plain identifier
          // or (ES2018) a destructuring pattern applied to the rest
          // array: `(...[a, b])`, `(...{length})`.
          if (this.check(TokenType.LBRACKET) || this.check(TokenType.LBRACE)) {
            const patternStart = this.lexer.saveState();
            const patternCurrent = this.current;
            const patternPrevious = this.previous;
            this.advance();  // consume `[` or `{`
            this.skimBalanced();
            params.push({ kind: 'rest-pattern', patternStart, patternCurrent, patternPrevious });
          } else {
            this.consume(TokenType.IDENTIFIER, "Expected name or pattern after '...'");
            const nameTok = this.previous;
            const name = this.internString(nameTok.value);
            params.push({ kind: 'rest', name, nameTok });
          }
          if (this.check(TokenType.COMMA)) {
            throw this.error("Rest parameter must be last");
          }
          break;
        }
        if (this.check(TokenType.LBRACKET) || this.check(TokenType.LBRACE)) {
          // Pattern parameter: snapshot lexer state at the opening
          // bracket, skim past the matching close, optionally capture
          // a default `= expr`, then consume `,` or stop on `)`.
          const patternStart = this.lexer.saveState();
          const patternCurrent = this.current;
          const patternPrevious = this.previous;
          this.advance();  // consume `[` or `{`
          this.skimBalanced();
          const desc = { kind: 'pattern', patternStart, patternCurrent, patternPrevious };
          if (this.match(TokenType.ASSIGN)) {
            desc.hasDefault = true;
            desc.defaultStart = this.lexer.saveState();
            desc.defaultCurrent = this.current;
            desc.defaultPrevious = this.previous;
            // Skim past the default expression. Stop at `,` or `)` at
            // depth 0. Track depth across (), [], {}.
            this.skimTopLevelExpr();
          }
          params.push(desc);
        } else {
          this.consume(TokenType.IDENTIFIER, "Expected parameter name");
          const nameTok = this.previous;
          const name = this.internString(nameTok.value);
          const desc = { kind: 'ident', name, nameTok };
          if (this.match(TokenType.ASSIGN)) {
            desc.hasDefault = true;
            desc.defaultStart = this.lexer.saveState();
            desc.defaultCurrent = this.current;
            desc.defaultPrevious = this.previous;
            this.skimTopLevelExpr();
          }
          params.push(desc);
        }
        if (!this.match(TokenType.COMMA)) break;
      } while (!this.check(TokenType.RPAREN));
    }
    this.consume(TokenType.RPAREN, "Expected ')' after parameters");
    return params;
  }

  /**
   * Skim a top-level expression: walk tokens until we see a `,` or `)`
   * at depth 0. Used for capturing parameter default expressions. The
   * default expression itself may contain `[`, `{`, `(` — we track
   * depth so nested commas don't terminate the scan.
   */
  skimTopLevelExpr() {
    let depth = 0;
    while (!this.check(TokenType.EOF)) {
      if (depth === 0 && (this.check(TokenType.COMMA) || this.check(TokenType.RPAREN))) {
        return;
      }
      if (this.check(TokenType.LBRACKET) || this.check(TokenType.LPAREN) || this.check(TokenType.LBRACE)) {
        depth++;
      } else if (this.check(TokenType.RBRACKET) || this.check(TokenType.RBRACE)) {
        depth--;
      } else if (this.check(TokenType.RPAREN) && depth > 0) {
        depth--;
      }
      this.advance();
    }
    throw this.error("Unterminated expression in parameter default");
  }

  emitFunctionBody(params, isArrow = false, isAsync = false, isGenerator = false) {
    const bodyBlockTok = this.previous; // `{`
    let closureOp;
    if (isGenerator && isAsync) {
      closureOp = OP.MAKE_ASYNC_GENERATOR_CLOSURE;
    } else if (isGenerator) {
      closureOp = OP.MAKE_GENERATOR_CLOSURE;
    } else if (isAsync) {
      closureOp = isArrow ? OP.MAKE_ASYNC_ARROW_CLOSURE : OP.MAKE_ASYNC_CLOSURE;
    } else {
      closureOp = isArrow ? OP.MAKE_ARROW_CLOSURE : OP.MAKE_CLOSURE;
    }
    const closureInstr = this.emit(closureOp, 0, 0);
    const jumpInstr = this.emit(OP.JUMP, 0);

    const bodyStart = this.here;
    // RECONCILE_PARAMS reshapes the pending stack so exactly paramCount
    // values remain for the LET_VAR sequence below. Pads missing slots
    // with undefined and packs excess into a rest array when hasRest.
    const lastKind = params.length > 0 ? params[params.length - 1].kind : null;
    const hasRest = (lastKind === 'rest' || lastKind === 'rest-pattern') ? 1 : 0;
    if (params.length > MAX_PARAMETER_COUNT) {
      throw this.error(`Too many parameters (max ${MAX_PARAMETER_COUNT})`);
    }
    this.emit(OP.RECONCILE_PARAMS, params.length, hasRest);

    // AST parameter entries, filled in declaration order by bindParam
    // below: VARIABLE_BINDING(name, default) for plain identifiers,
    // ARRAY_PATTERN / OBJECT_PATTERN nodes for pattern targets, each
    // wrapped in SPREAD for rest parameters.
    const paramBindings = params.map(() => 0);

    // Per-parameter emitter, shared by both binding strategies below:
    // apply the captured default (value on top of stack; if undefined,
    // pop it and evaluate the default in its place), then consume the
    // value into the parameter's target — a LET_VAR for plain
    // identifiers, or a rewind into the pattern bind for patterns.
    const bindParam = (p, index) => {
      let defaultOff = 0;
      if (p.hasDefault) {
        this.emit(OP.DUP);
        this.emit(OP.LIT_UNDEFINED);
        this.emit(OP.EQ);
        const skip = this.emit(OP.JUMP_IF_FALSE, 0);
        this.emit(OP.POP);
        // Rewind lexer to default expression, parse-and-emit it inline.
        const here = this.lexer.saveState();
        const hereCurrent = this.current;
        const herePrevious = this.previous;
        this.lexer.restoreState(p.defaultStart);
        this.current = p.defaultCurrent;
        this.previous = p.defaultPrevious;
        defaultOff = this.expression();
        // Restore lexer.
        this.lexer.restoreState(here);
        this.current = hereCurrent;
        this.previous = herePrevious;
        this.patch(skip, this.here);
      }
      if (p.kind === 'ident' || p.kind === 'rest') {
        this.emitWithSource(OP.LET_VAR, p.name, 0, p.nameTok.start, p.nameTok.end, 0);
        if (this.ast) {
          const bindingOff = this.ast.writeVariableBinding(p.name, defaultOff, this.pos(p.nameTok));
          paramBindings[index] = p.kind === 'rest'
            ? this.ast.writeSpread(bindingOff, this.pos(p.nameTok)) : bindingOff;
        }
        return;
      }
      const here = this.lexer.saveState();
      const hereCurrent = this.current;
      const herePrevious = this.previous;
      const patternStartTok = p.patternCurrent;
      this.lexer.restoreState(p.patternStart);
      this.current = p.patternCurrent;
      this.previous = p.patternPrevious;
      let patternOff;
      if (this.check(TokenType.LBRACKET)) {
        patternOff = this.arrayPatternBind(0);
      } else {
        patternOff = this.objectPatternBind(0);
      }
      this.lexer.restoreState(here);
      this.current = hereCurrent;
      this.previous = herePrevious;
      if (this.ast && patternOff) {
        if (defaultOff) this.ast.patchPatternInitializer(patternOff, defaultOff);
        paramBindings[index] = p.kind === 'rest-pattern'
          ? this.ast.writeSpread(patternOff, this.pos(patternStartTok)) : patternOff;
      }
    };

    if (!params.some(p => p.hasDefault)) {
      // No defaults: bind in reverse order. Args land on the pending
      // stack in declaration order; popping pulls them off in reverse.
      for (let i = params.length - 1; i >= 0; i--) {
        bindParam(params[i], i);
      }
    } else {
      // At least one default: two-phase FORWARD binding, so a default
      // expression can reference EARLIER parameters
      // (`function f(a, b = a)`). Phase 1 stashes the raw args into
      // hidden per-position temps (reverse pop order); phase 2 walks
      // the declaration order, re-reads each temp, applies the default
      // (earlier params are already bound and visible), and binds the
      // real target. Referencing a LATER param from a default still
      // throws "not defined", approximating the spec's TDZ.
      for (let i = params.length - 1; i >= 0; i--) {
        this.emit(OP.LET_VAR, this.internString(`@param_${i}`));
      }
      for (let i = 0; i < params.length; i++) {
        this.emit(OP.GET_VAR, this.internString(`@param_${i}`));
        bindParam(params[i], i);
      }
    }

    // Class support: one super frame per non-arrow body; arrows inherit
    // the enclosing frame by not pushing (JS lexical super).
    const superFrame = isArrow
      ? null
      : { kind: this.pendingSuperKind || 'none', superCalls: 0 };
    this.pendingSuperKind = null;
    if (superFrame) this.superStack.push(superFrame);

    // Track function context for await/yield validation
    this.functionStack.push({ isAsync, isGenerator, isArrow });

    // break/continue cannot cross a function boundary: a nested function
    // inside a loop body must not see the enclosing loop (real JS makes
    // that a SyntaxError), and its unwind counting starts fresh.
    const savedLoopStack = this.loopStack;
    const savedTryProtectionDepth = this.tryProtectionDepth;
    const savedGrantProtectionDepth = this.grantProtectionDepth;
    const savedTryGrantDepths = this.tryGrantDepths;
    this.loopStack = [];
    this.tryProtectionDepth = 0;
    this.grantProtectionDepth = 0;
    this.tryGrantDepths = [];

    // Parse body statements, collecting AST offsets for the Block.
    const stmtOffsets = [];
    while (!this.check(TokenType.RBRACE) && !this.check(TokenType.EOF)) {
      const off = this.statement();
      if (off) stmtOffsets.push(off);
    }
    this.consume(TokenType.RBRACE, "Expected '}' after function body");

    this.loopStack = savedLoopStack;
    this.tryProtectionDepth = savedTryProtectionDepth;
    this.grantProtectionDepth = savedGrantProtectionDepth;
    this.tryGrantDepths = savedTryGrantDepths;

    // Restore function context
    this.functionStack.pop();
    if (superFrame) {
      this.superStack.pop();
      if (superFrame.kind === 'ctor-derived' && superFrame.superCalls === 0) {
        throw this.error('A derived constructor must call super()');
      }
    }

    // Implicit return undefined. Emitted UNCONDITIONALLY: the old
    // "skip when the last instruction is already a RETURN" check was
    // wrong for bodies whose final statement is a conditional return
    // (`{ if (c) return v; }`) — the if's JUMP_IF_FALSE targets the
    // body END, so with no epilogue there, control fell out of the
    // function into whatever bytecode followed it. When the body
    // genuinely ends with an explicit return, this is one dead
    // instruction — never reached, and cheaper than proving no jump
    // targets the body end.
    this.emit(OP.RETURN_UNDEFINED);

    const bodyEnd = this.here;

    // Patch operands
    this.patch(closureInstr, bodyStart);
    this.patchOperand2(closureInstr, bodyEnd);
    this.patch(jumpInstr, bodyEnd);

    const bodyBlock = this.ast ? this.ast.writeBlock(stmtOffsets, this.pos(bodyBlockTok)) : 0;
    return { paramBindings, bodyBlock, closureInstr };
  }

  /**
   * Retroactively set the astNode field on an already-emitted instruction.
   * Used when an AST node can only be written *after* its primary emit op
   * (e.g., the closure-creating MAKE_CLOSURE is emitted first, but the
   * FunctionDecl AST node is written after the body has been parsed).
   */
  attributeInstruction(instructionIndex, astNodeOffset) {
    if (!astNodeOffset) return;
    this.mem.codeBlockEditInstruction(instructionIndex, 'astNode', astNodeOffset);
  }

  arrayLiteral() {
    const startTok = this.previous; // `[`
    // Cover-grammar check: at expression position, `[a, b, c]` looks
    // like an array literal until we see `=` after the close, in which
    // case it's the LHS of a destructuring assignment. Skim ahead
    // first; if `=` follows, dispatch to the assignment form.
    if (this.previous.type === TokenType.LBRACKET) {
      // We've already consumed `[` (the Pratt machinery does that
      // before invoking the prefix handler — `previous` is the `[`).
      // Skim depth-aware from current position to find the matching
      // `]`, then peek for `=`.
      const savedLexer = this.lexer.saveState();
      const savedCurrent = this.current;
      const savedPrevious = this.previous;
      try {
        this.skimBalanced();
      } catch (e) {
        // Re-raise: unbalanced brackets are a real error regardless
        // of which form this was.
        throw e;
      }
      const isAssignTarget = this.check(TokenType.ASSIGN);
      // Always restore — we just peeked.
      this.lexer.restoreState(savedLexer);
      this.current = savedCurrent;
      this.previous = savedPrevious;

      if (isAssignTarget) {
        return this.arrayDestructuringAssignment();
      }
    }

    // First pass: peek to see if any element is a spread (`...`). If not,
    // preserve the existing fast path (single MAKE_ARRAY with static count).
    // If a spread is present, switch to the builder pattern: MAKE_ARRAY 0,
    // then per-element ARRAY_PUSH_ONE (regular) or an inline iteration loop
    // (spread).
    //
    // We don't try to share parsing across passes — the work is shaped by
    // the element list itself, so the parser just walks once and chooses
    // emit strategy based on whether `...` appears as it goes. The
    // first-spread point switches modes; elements before it that were
    // already emitted as expressions are reused via stack rearrangement.

    let count = 0;
    const elemOffsets = [];
    let usingBuilder = false;

    if (!this.check(TokenType.RBRACKET)) {
      do {
        if (this.check(TokenType.DOT_DOT_DOT)) {
          // Switch to builder mode if not already. Any elements emitted
          // so far were pushed as direct values; convert by emitting
          // MAKE_ARRAY count, then we have one array on top of stack.
          if (!usingBuilder) {
            this.emit(OP.MAKE_ARRAY, count);   // pops count values, pushes array
            usingBuilder = true;
          }
          this.advance();                       // consume `...`
          const spreadOffset = this.expression();    // push iterable
          elemOffsets.push(spreadOffset);
          this.emitArrayAppendSpread();         // pop iterable, iterate, push each via ARRAY_PUSH_ONE
        } else {
          const off = this.expression();
          elemOffsets.push(off);
          if (usingBuilder) {
            this.emit(OP.ARRAY_PUSH_ONE);       // pop value, append to array on stack
          } else {
            count++;
          }
        }
        if (!this.match(TokenType.COMMA)) break;
      } while (!this.check(TokenType.RBRACKET));
    }
    this.consume(TokenType.RBRACKET, "Expected ']' after array elements");
    const node = this.ast ? this.ast.writeArrayLiteral(elemOffsets, this.pos(startTok)) : 0;
    if (!usingBuilder) {
      // No spread anywhere — fast path.
      this.emit(OP.MAKE_ARRAY, count, 0, node);
    }
    return node;
  }

  /**
   * Emit bytecode that iterates the value on top of the pending stack
   * and appends each yielded element to the array that sits beneath it.
   *
   * Stack:  [..., array, iterable]  →  [..., array]
   *
   * Uses the standard iterator protocol via [Symbol.iterator]() and
   * .next(). Each yielded value is appended to the array via
   * ARRAY_PUSH_ONE. Same idiom used by array-literal spread and
   * call-site spread (which builds an args array).
   */
  emitArrayAppendSpread() {
    const counter = this.destructuringCounter++;
    const iterName = this.internString(`@spread_iter_${counter}`);
    const stepName = this.internString(`@spread_step_${counter}`);

    // Convert iterable → iterator. The iterable is on top of the stack;
    // the array is beneath it.
    //   iterable[Symbol.iterator]()
    this.emit(OP.ASSERT_ITERABLE, 0);                    // "Not iterable" for null/undefined/numbers/...
    this.emit(OP.DUP);                                   // [arr, iterable, iterable]
    this.emit(OP.LIT_WELL_KNOWN_SYMBOL, 0);              // [arr, iterable, iterable, Symbol.iterator]
    this.emit(OP.GET_INDEX);                             // [arr, iterable, iter-fn]
    this.emit(OP.ASSERT_ITERABLE, 1);                    // "Not iterable" if the lookup missed
    this.emit(OP.CALL_METHOD, 0);                        // [arr, iterator]
    this.emit(OP.LET_VAR, iterName);                     // [arr]

    // Declare step once with undefined; SET_VAR reassigns inside the loop
    // (LET_VAR inside the loop would fail with "already declared").
    this.emit(OP.LIT_UNDEFINED);
    this.emit(OP.LET_VAR, stepName);

    const loopStart = this.here;
    // step = iter.next()
    this.emit(OP.GET_VAR, iterName);                     // [arr, iter]
    this.emit(OP.GET_VAR, iterName);                     // [arr, iter, iter]
    this.emit(OP.GET_PROP, this.internString('next'));   // [arr, iter, next]
    this.emit(OP.CALL_METHOD, 0);                        // [arr, step]
    this.emit(OP.ASSERT_ITER_RESULT);                    // [arr, step]
    this.emit(OP.SET_VAR, stepName);                     // [arr, step]  (SET_VAR leaves value on stack)
    this.emit(OP.POP);                                   // [arr]

    // if (step.done) break
    this.emit(OP.GET_VAR, stepName);                     // [arr, step]
    this.emit(OP.GET_PROP, this.internString('done'));   // [arr, doneBool]
    const exitJump = this.emit(OP.JUMP_IF_TRUE, 0);

    // arr.push(step.value)
    this.emit(OP.GET_VAR, stepName);                     // [arr, step]
    this.emit(OP.GET_PROP, this.internString('value'));  // [arr, value]
    this.emit(OP.ARRAY_PUSH_ONE);                        // [arr]

    this.emit(OP.JUMP, loopStart);
    this.patch(exitJump, this.here);
  }

  /**
   * Parse `[…] = expr` as a destructuring assignment expression.
   *
   * Entry: `previous` is `[`, `current` is the first token inside the
   * pattern. We've already verified by skim that `=` follows.
   *
   * Lower the pattern using SET_VAR for user targets (not LET_VAR
   * because we're assigning to already-declared bindings).
   *
   * Returns 0 for the AST offset (no dedicated pattern-assignment
   * AST node yet — array literals on the LHS aren't well modeled).
   */
  objectDestructuringAssignment() {
    return this._destructuringAssignmentImpl(true);
  }

  arrayDestructuringAssignment() {
    return this._destructuringAssignmentImpl(false);
  }

  _destructuringAssignmentImpl(isObject) {
    // We're at the first token inside `[`. To run the same two-pass
    // approach used by declarations, rewind to the `[` itself.
    // `previous` is currently `[`; its source span gives us the byte
    // position. But `lexer.restoreState` works by lexer-position;
    // we need the lexer-position of `[`, which is `previous.start`.
    // The lexer-state object stores (pos, line, col, …); we
    // reconstruct one anchored at the `[` token start.
    const patternStart = {
      pos: this.previous.start,
      line: this.previous.line ?? 1,
      col: this.previous.col ?? 1,
      tokenStart: this.previous.start,
      tokenLine: this.previous.line ?? 1,
      tokenCol: this.previous.col ?? 1,
    };
    // We don't have a valid `current`/`previous` snapshot here — the
    // lexer-rewind sets up tokens from scratch. Reset by calling
    // `advance()` twice to populate previous/current.
    this.lexer.restoreState(patternStart);
    this.advance();  // current = `[`
    // Skim past `]` and consume `=`.
    const patternStartSnapshot = this.lexer.saveState();
    const patternStartCurrent = this.current;
    const patternStartPrevious = this.previous;
    this.advance();
    this.skimBalanced();
    this.consume(TokenType.ASSIGN, "Internal: expected `=` after assignment target");
    // Parse RHS.
    this.expression();
    // DUP so the pattern-bind has its own copy to consume; the
    // original stays on the stack as the expression's value (JS spec:
    // `let r = ([a] = [1])` → `r === [1]`).
    this.emit(OP.DUP);
    // Snapshot post-RHS so we can return to it after pattern emit.
    const afterRhs = this.lexer.saveState();
    const afterRhsCurrent = this.current;
    const afterRhsPrevious = this.previous;
    // Rewind to pattern start; emit pattern bind in assignment mode.
    this.lexer.restoreState(patternStartSnapshot);
    this.current = patternStartCurrent;
    this.previous = patternStartPrevious;
    if (isObject) {
      this.objectPatternBind(0, 'assign');
    } else {
      this.arrayPatternBind(0, 'assign');
    }
    // Resume after RHS. The DUP'd RHS copy is now the expression's
    // value on top of the pending stack.
    this.lexer.restoreState(afterRhs);
    this.current = afterRhsCurrent;
    this.previous = afterRhsPrevious;
    return 0;
  }

  objectLiteral() {
    const objStartTok = this.previous; // `{`
    // Cover-grammar check: `({ a, b } = expr)` is a destructuring
    // assignment, not an object literal. JS requires the parens at
    // statement-start because `{…}` opens a block, but inside
    // expression position the disambiguation is by `=` after `}`.
    if (this.previous.type === TokenType.LBRACE) {
      const savedLexer = this.lexer.saveState();
      const savedCurrent = this.current;
      const savedPrevious = this.previous;
      try {
        this.skimBalanced();
      } catch (e) {
        throw e;
      }
      const isAssignTarget = this.check(TokenType.ASSIGN);
      this.lexer.restoreState(savedLexer);
      this.current = savedCurrent;
      this.previous = savedPrevious;

      if (isAssignTarget) {
        return this.objectDestructuringAssignment();
      }
    }

    let count = 0;
    const propOffsets = [];
    let usingBuilder = false;
    if (!this.check(TokenType.RBRACE)) {
      do {
        // Object-literal spread: `{...src}`. Switch to builder mode if not
        // already (any previously-collected key/value pairs are then bundled
        // into a MAKE_OBJECT, leaving an object on stack to merge into).
        if (this.check(TokenType.DOT_DOT_DOT)) {
          if (!usingBuilder) {
            // Flush any pending count of static keys: each pair sits as
            // [key, value] on the pending stack; MAKE_OBJECT with operand1
            // = number of pairs pops them and produces the object.
            this.emit(OP.MAKE_OBJECT, count);
            usingBuilder = true;
          }
          this.advance();                       // consume `...`
          const spreadOffset = this.expression();    // push source object
          propOffsets.push(spreadOffset);
          this.emit(OP.OBJ_MERGE_SPREAD);       // pop source, merge into object on stack
          if (!this.match(TokenType.COMMA)) break;
          continue;
        }

        // Computed key: `{ [expr]: value }`. Switches to builder mode
        // because the key is a runtime value (not statically encodable
        // as a LIT_STRING operand for MAKE_OBJECT). Needed to write
        // `{ [Symbol.iterator]() { ... } }` and similar.
        const isComputedKey = this.check(TokenType.LBRACKET);

        // Accessor property: `{ get prop() {...} }` / `{ set prop(v) {...} }`.
        // `get`/`set` are contextual: they're the accessor keyword only when
        // a property name follows; otherwise they're ordinary property names
        // (`{ get: 1 }`, `{ get() {} }`, `{ set }`). Accessors also switch
        // to builder mode: MAKE_OBJECT writes entries without key dedup, so
        // a get/set pair for one key must flow through SET_INDEX, whose
        // property store merges accessor halves.
        let accessorKind = null;
        if (!isComputedKey && this.check(TokenType.IDENTIFIER)
            && (this.current.value === 'get' || this.current.value === 'set')) {
          const savedLexer = this.lexer.saveState();
          const savedCurrent = this.current;
          const savedPrevious = this.previous;
          const kind = this.current.value;
          this.advance();  // consume get/set
          if (this.check(TokenType.IDENTIFIER) || this.check(TokenType.STRING)
              || this.check(TokenType.NUMBER) || this.check(TokenType.INTEGER)
              || (this.current && KEYWORD_TOKEN_TYPES.has(this.current.type))) {
            accessorKind = kind;
            // leave the lexer past get/set so the key parsing below sees
            // the property name directly.
          } else {
            this.lexer.restoreState(savedLexer);
            this.current = savedCurrent;
            this.previous = savedPrevious;
          }
        }

        if ((isComputedKey || accessorKind) && !usingBuilder) {
          this.emit(OP.MAKE_OBJECT, count);
          usingBuilder = true;
        }

        // In builder mode, the under-construction object lives on top of
        // the pending stack. SET_INDEX consumes [obj, key, value] so we
        // DUP the object first; SET_INDEX then leaves the assigned value
        // on top, which we POP after the pair is bound.
        if (usingBuilder) {
          this.emit(OP.DUP);
        }

        // Async method shorthand: `{ async foo() {...} }`. The `async`
        // token here is the method modifier, not the property name —
        // peek past `async` to see if an identifier-and-`(` follows.
        // Distinguish from `{ async: value }` (where `async` is the
        // property name) by checking what follows: if it's `:` or `,`
        // or `}`, async is a property name; if it's an identifier (or
        // STRING/LBRACKET for computed keys), async is the modifier.
        let isAsyncMethod = false;
        if (!isComputedKey && this.check(TokenType.ASYNC)) {
          // Look one token ahead.
          const savedLexer = this.lexer.saveState();
          const savedCurrent = this.current;
          const savedPrevious = this.previous;
          this.advance();  // consume ASYNC
          if (this.check(TokenType.IDENTIFIER) || this.check(TokenType.STRING) || this.check(TokenType.LBRACKET)
              || this.check(TokenType.STAR)  // `{ async *m() { ... } }`
              || (this.current && KEYWORD_TOKEN_TYPES.has(this.current.type))) {
            isAsyncMethod = true;
            // leave the lexer past `async` so the key-parsing path below
            // sees the method name directly.
          } else {
            // `async` is the property name — rewind so the normal key
            // parsing treats it as an identifier.
            this.lexer.restoreState(savedLexer);
            this.current = savedCurrent;
            this.previous = savedPrevious;
          }
        }

        // Generator method shorthand: `{ *m() { ... } }` (with
        // isAsyncMethod: `{ async *m() { ... } }`).
        let isGeneratorMethod = false;
        if (!isComputedKey && !accessorKind && this.check(TokenType.STAR)) {
          this.advance();
          isGeneratorMethod = true;
        }

        // Key
        const keyStartTok = this.current;
        let keyName = null;
        let keyNode = 0;
        if (isComputedKey) {
          this.advance();   // consume `[`
          keyNode = this.expression();      // emits the key value onto the stack
          this.consume(TokenType.RBRACKET, "Expected ']' to close computed key");
        } else if (this.match(TokenType.IDENTIFIER)) {
          keyName = this.previous.value;
          const key = this.internString(keyName);
          keyNode = this.ast ? this.ast.writeIdentifier(key, this.pos(keyStartTok)) : 0;
          this.emit(OP.LIT_STRING, key, 0, keyNode);
        } else if (this.match(TokenType.STRING)) {
          const key = this.internString(this.previous.value);
          keyNode = this.ast ? this.ast.writeLiteralString(key, this.pos(keyStartTok)) : 0;
          this.emit(OP.LIT_STRING, key, 0, keyNode);
        } else if (this.match(TokenType.NUMBER) || this.match(TokenType.INTEGER)) {
          // Numeric key: `{ 0: 'x', 1.5: 'y' }`. Property keys are
          // strings; use the number's canonical string form (so `1.50`
          // keys as "1.5" and `0x10` as "16", matching JS). INTEGER
          // tokens carry BigInt values; String() covers both.
          keyName = String(this.previous.value);
          const key = this.internString(keyName);
          keyNode = this.ast ? this.ast.writeLiteralString(key, this.pos(keyStartTok)) : 0;
          this.emit(OP.LIT_STRING, key, 0, keyNode);
        } else if (this.current && KEYWORD_TOKEN_TYPES.has(this.current.type)) {
          // Reserved word as a property key — JS allows any
          // IdentifierName here: `{ const: "channel" }`,
          // `{ async: value }`, `{ catch() { ... } }`. No shorthand
          // form, though: `{ const }` would bind a variable that
          // cannot exist.
          this.advance();
          keyName = this.previous.value;
          const key = this.internString(keyName);
          keyNode = this.ast ? this.ast.writeIdentifier(key, this.pos(keyStartTok)) : 0;
          this.emit(OP.LIT_STRING, key, 0, keyNode);
          if (!this.check(TokenType.COLON) && !this.check(TokenType.LPAREN)) {
            this.error(
              `Reserved word '${keyName}' as a property key needs ':' or a method body`);
          }
        } else {
          this.error('Expected property name');
        }

        // Check for method shorthand: { foo() { ... } } or { [expr]() { ... } }
        // or { async foo() {...} }, or accessor bodies.
        let valueNode = 0;
        let propFlags = isComputedKey ? FLAG.PROP_COMPUTED : 0;
        if (accessorKind) {
          if (!this.check(TokenType.LPAREN)) {
            this.error(`Expected '(' after ${accessorKind} accessor name`);
          }
          // Parse the accessor body as a non-async method closure, then
          // wrap it into a TYPE_ACCESSOR property value (getter half or
          // setter half). MAKE_OBJECT / SET_INDEX merge the halves when
          // one key defines both. The AST records the accessor kind via
          // PROP_GETTER / PROP_SETTER so getSource() prints the get/set
          // keyword.
          valueNode = this.methodShorthand(false);
          this.emit(accessorKind === 'get' ? OP.WRAP_GETTER : OP.WRAP_SETTER);
          propFlags = FLAG.PROP_METHOD
            | (accessorKind === 'get' ? FLAG.PROP_GETTER : FLAG.PROP_SETTER);
        } else if ((keyName || isComputedKey) && this.check(TokenType.LPAREN)) {
          // Method shorthand - emit MAKE_CLOSURE (not arrow, so it binds `this`).
          // `async` / `*` modifiers propagate if present.
          valueNode = this.methodShorthand(isAsyncMethod, isGeneratorMethod);
          propFlags |= FLAG.PROP_METHOD;
        } else if (keyName
            && (this.check(TokenType.COMMA) || this.check(TokenType.RBRACE))) {
          // Property shorthand: { foo } is sugar for { foo: foo }.
          // We've already emitted LIT_STRING(name) for the key above;
          // emit GET_VAR(name) for the value to read the variable
          // with the same name from the current scope. Mirrors ES2015
          // shorthand property syntax. Drone authors writing
          // `{ result, observed: observed() }` (very common in
          // "build a return record from local lets" patterns) should
          // not have to spell out `{ result: result, ... }`.
          const nameId = this.internString(keyName);
          valueNode = this.ast ? this.ast.writeIdentifier(nameId, this.pos(keyStartTok)) : 0;
          this.emit(OP.GET_VAR, nameId, 0, valueNode);
        } else {
          // Regular property: { foo: value } or { [expr]: value }
          this.consume(TokenType.COLON, "Expected ':' after property name");
          valueNode = this.expression();
        }
        const propNode = this.ast ? this.ast.writeObjectProperty(keyNode, valueNode, propFlags, this.pos(keyStartTok)) : 0;
        propOffsets.push(propNode);
        if (usingBuilder) {
          // Stack: [..., obj, obj, key, value] → SET_INDEX → [..., obj, value] → POP → [..., obj]
          this.emit(OP.SET_INDEX);
          this.emit(OP.POP);
        } else {
          count++;
        }
        if (!this.match(TokenType.COMMA)) break;
      } while (!this.check(TokenType.RBRACE));
    }
    this.consume(TokenType.RBRACE, "Expected '}' after object properties");
    const node = this.ast ? this.ast.writeObjectLiteral(propOffsets, this.pos(objStartTok)) : 0;
    if (!usingBuilder) {
      this.emit(OP.MAKE_OBJECT, count, 0, node);
    }
    return node;
  }

  /**
   * Parse method shorthand in object literal: { foo() { body } }
   * Emits MAKE_CLOSURE (binds `this`, unlike arrow functions). When
   * `isAsync` is true, emits MAKE_ASYNC_CLOSURE so `await` inside
   * the body works and callers see a Promise return.
   */
  methodShorthand(isAsync = false, isGenerator = false) {
    const startTok = this.previous; // method key/name token
    this.consume(TokenType.LPAREN, "Expected '(' after method name");

    // Parse parameters
    const params = this.parseFunctionParams();

    // Parse body
    this.consume(TokenType.LBRACE, "Expected '{' before method body");
    const { paramBindings, bodyBlock, closureInstr } = this.emitFunctionBody(params, false, isAsync, isGenerator);
    const fnNode = this.ast ? this.ast.writeFunctionDecl({
      nameOffset: 0,
      params: paramBindings,
      body: bodyBlock,
      flags: (isAsync ? FLAG.FN_ASYNC : 0) | (isGenerator ? FLAG.FN_GENERATOR : 0),
      pos: this.pos(startTok),
    }) : 0;
    this.attributeInstruction(closureInstr, fnNode);
    return fnNode;
  }

  unary() {
    const startTok = this.previous;
    const op = startTok.type;

    // delete's operand must be parsed as a REFERENCE (object + key), not a
    // value read: `delete obj.a` needs `obj` and the key 'a' on the stack
    // for DELETE_PROP to remove, not the already-read value of obj.a. Set
    // a flag dot()/index() check: if THEY are the last link in the
    // postfix chain (no further `.`/`[`/`?.` continues it), they emit
    // DELETE_PROP/DELETE_INDEX themselves instead of GET_PROP/GET_INDEX,
    // and clear the flag to signal "already handled". Chains like
    // `delete obj.a.b` still read `obj.a` normally — only the last `.b`
    // becomes the delete target.
    const wasPendingDelete = this.pendingDeleteTarget;
    if (op === TokenType.DELETE) {
      this.pendingDeleteTarget = true;
    }
    const operandOff = this.parsePrecedence(PREC.UNARY);
    const deleteTargetHandled = op === TokenType.DELETE && !this.pendingDeleteTarget;
    this.pendingDeleteTarget = wasPendingDelete;

    if (deleteTargetHandled) {
      // dot()/index() already emitted DELETE_PROP/DELETE_INDEX and left a
      // boolean on the stack — this IS the delete expression, no separate
      // UNARY_OP(DELETE) opcode to emit.
      return this.ast ? this.ast.writeUnaryOp(UnaryOp.DELETE, operandOff, this.pos(startTok)) : 0;
    }

    let opKind;
    let opcode;
    switch (op) {
      case TokenType.PLUS:   opKind = UnaryOp.PLUS;   opcode = OP.UPLUS;  break;
      case TokenType.MINUS:  opKind = UnaryOp.MINUS;  opcode = OP.NEG;    break;
      case TokenType.NOT:    opKind = UnaryOp.BANG;   opcode = OP.NOT;    break;
      case TokenType.TYPEOF: opKind = UnaryOp.TYPEOF; opcode = OP.TYPEOF; break;
      case TokenType.VOID:   opKind = UnaryOp.VOID;   opcode = OP.VOID;   break;
      case TokenType.DELETE: opKind = UnaryOp.DELETE; opcode = OP.DELETE; break;
      case TokenType.TILDE:  opKind = UnaryOp.TILDE;  opcode = OP.BNOT;   break;
    }
    const node = this.ast ? this.ast.writeUnaryOp(opKind, operandOff, this.pos(startTok)) : 0;
    this.emit(opcode, 0, 0, node);
    return node;
  }

  /**
   * Handle `await` expression.
   * Valid at top level (empty functionStack) or inside async functions (top of stack is true).
   * Invalid inside non-async functions.
   */
  awaitExpression() {
    const startTok = this.previous; // `await`
    // Check if await is valid in this context
    // At top level (empty stack) - allowed
    // Inside any function - only allowed if the immediately enclosing function is async
    if (this.functionStack.length > 0 && !this.functionStack[this.functionStack.length - 1].isAsync) {
      this.error("await is only valid in async functions or at top level");
    }

    // Parse the expression being awaited
    const argOff = this.parsePrecedence(PREC.UNARY);

    // Emit AWAIT opcode
    const node = this.ast ? this.ast.writeAwait(argOff, this.pos(startTok)) : 0;
    this.emit(OP.AWAIT, 0, 0, node);
    return node;
  }

  /**
   * Handle `yield` / `yield expr` inside a generator body
   * (INTERNALS.md's Generators section). The YIELD opcode parks the generator context
   * with the yielded value on its pending stack; resume pushes the
   * next(v) argument as the yield expression's result. The argument is
   * optional: absent when the next token can't start an expression or
   * sits on a following line (same rule as `return`).
   */
  yieldExpression(startTok) {
    if (this.match(TokenType.STAR)) {
      return this.yieldDelegateExpression(startTok);
    }
    const yieldLine = startTok.line;
    let argOff = 0;
    if (
      this.check(TokenType.SEMICOLON) ||
      this.check(TokenType.RBRACE) ||
      this.check(TokenType.RPAREN) ||
      this.check(TokenType.RBRACKET) ||
      this.check(TokenType.COMMA) ||
      this.check(TokenType.COLON) ||
      this.check(TokenType.EOF) ||
      this.current.line > yieldLine
    ) {
      this.emit(OP.LIT_UNDEFINED);
    } else {
      argOff = this.parsePrecedence(PREC.ASSIGNMENT);
    }
    // Async generators await the yielded operand before suspending
    // (spec AsyncGeneratorYield): a rejected operand throws AT the
    // yield, catchable by the body; a promise operand settles before
    // the consumer's step promise resolves with it.
    if (this.functionStack[this.functionStack.length - 1].isAsync) {
      this.emit(OP.AWAIT);
    }
    const node = this.ast ? this.ast.writeYield(argOff, false, this.pos(startTok)) : 0;
    this.emit(OP.YIELD, 0, 0, node);
    return node;
  }

  /**
   * `yield* delegate` — drive the delegate with the sync iterator
   * protocol, yielding each value outward and forwarding each sent
   * value into delegate.next(v). The expression evaluates to the
   * delegate's done value. A close frame (the for-of pattern) closes
   * the delegate via its return() method when an abrupt completion —
   * gen.return(), gen.throw(), or a throw at the yield — unwinds
   * through the drive loop. Known v1 nit: throw/return are not
   * PROXIED to the delegate's own throw/return methods; the delegate
   * is closed instead.
   */
  yieldDelegateExpression(startTok) {
    const sourceName = this.internString('@delegateSource');
    const iteratorName = this.internString('@delegateIterator');
    const factoryName = this.internString('@delegateFactory');
    const sentName = this.internString('@delegateSent');
    const stepName = this.internString('@delegateStep');
    const returnName = this.internString('return');

    // Async generator delegation: acquire via Symbol.asyncIterator with
    // a Symbol.iterator fallback (the C3 for-await dance), and AWAIT at
    // every protocol edge — the step object after next() (an async
    // delegate returns a promise; a sync delegate's plain object passes
    // through the settled fast path), the value before YIELD (spec
    // AsyncGeneratorYield + the AsyncFromSyncIterator value lift in one),
    // the close-path return() result, and the final done value.
    const isAsync = this.functionStack[this.functionStack.length - 1].isAsync;

    this.emit(OP.SCOPE_PUSH);
    const argOff = this.parsePrecedence(PREC.ASSIGNMENT);
    this.emit(OP.ASSERT_ITERABLE, 0);
    this.emit(OP.LET_VAR, sourceName);
    if (isAsync) {
      // Factory joins through a single LET_VAR, never SET_VAR (the
      // flag-merge hazard documented at forOfBody's acquisition).
      this.emit(OP.GET_VAR, sourceName);
      this.emit(OP.LIT_WELL_KNOWN_SYMBOL, 1);
      this.emit(OP.GET_INDEX);
      this.emit(OP.DUP);
      const haveAsyncIterator = this.emit(OP.JUMP_IF_TRUE, 0);
      this.emit(OP.POP);                       // drop the undefined async lookup
      this.emit(OP.GET_VAR, sourceName);
      this.emit(OP.LIT_WELL_KNOWN_SYMBOL, 0);
      this.emit(OP.GET_INDEX);
      this.patch(haveAsyncIterator, this.here);
      this.emit(OP.LET_VAR, factoryName);
      this.emit(OP.GET_VAR, sourceName);       // receiver
      this.emit(OP.GET_VAR, factoryName);
      this.emit(OP.ASSERT_ITERABLE, 1);
      this.emit(OP.CALL_METHOD, 0);
      this.emit(OP.LET_VAR, iteratorName);
    } else {
      this.emit(OP.GET_VAR, sourceName);
      this.emit(OP.GET_VAR, sourceName);
      this.emit(OP.LIT_WELL_KNOWN_SYMBOL, 0);
      this.emit(OP.GET_INDEX);
      this.emit(OP.ASSERT_ITERABLE, 1);
      this.emit(OP.CALL_METHOD, 0);
      this.emit(OP.LET_VAR, iteratorName);
    }
    this.emit(OP.LIT_UNDEFINED);
    this.emit(OP.LET_VAR, sentName);
    this.emit(OP.LIT_UNDEFINED);
    this.emit(OP.LET_VAR, stepName);

    const delegateFramePush = this.emit(OP.TRY_PUSH, 0, 0);
    this.tryProtectionDepth++;
    this.tryGrantDepths.push(this.grantProtectionDepth);

    const loopStart = this.here;
    this.emit(OP.GET_VAR, iteratorName);
    this.emit(OP.GET_VAR, iteratorName);
    this.emit(OP.GET_PROP, this.internString('next'));
    this.emit(OP.GET_VAR, sentName);
    this.emit(OP.CALL_METHOD, 1);
    if (isAsync) this.emit(OP.AWAIT);
    this.emit(OP.ASSERT_ITER_RESULT);
    this.emit(OP.SET_VAR, stepName);
    this.emit(OP.POP);
    this.emit(OP.GET_VAR, stepName);
    this.emit(OP.GET_PROP, this.internString('done'));
    const jumpLoopDone = this.emit(OP.JUMP_IF_TRUE, 0);
    this.emit(OP.GET_VAR, stepName);
    this.emit(OP.GET_PROP, this.internString('value'));
    if (isAsync) this.emit(OP.AWAIT);
    this.emit(OP.YIELD);
    this.emit(OP.SET_VAR, sentName);
    this.emit(OP.POP);
    this.emit(OP.JUMP, loopStart);

    this.patch(jumpLoopDone, this.here);
    this.emit(OP.TRY_POP);

    // Close block (same shape as forOfBody's).
    const closeBlockStart = this.here;
    this.mem.codeBlockEditInstruction(delegateFramePush, 'operand2', closeBlockStart);
    this.emit(OP.PUSH_COMPLETION_KIND);
    const skipWhenNormal = this.emit(OP.JUMP_IF_FALSE, 0);
    this.emit(OP.GET_VAR, iteratorName);
    this.emit(OP.GET_PROP, returnName);
    const skipWhenNoReturnMethod = this.emit(OP.JUMP_IF_FALSE, 0);
    this.emit(OP.PUSH_COMPLETION_KIND);
    this.emit(OP.LIT_RATIONAL_INTEGER, 1);
    this.emit(OP.EQ);
    const jumpToUnguardedClose = this.emit(OP.JUMP_IF_FALSE, 0);
    const guardPush = this.emit(OP.TRY_PUSH, 0, 0);
    this.emit(OP.GET_VAR, iteratorName);
    this.emit(OP.GET_VAR, iteratorName);
    this.emit(OP.GET_PROP, returnName);
    this.emit(OP.CALL_METHOD, 0);
    if (isAsync) this.emit(OP.AWAIT);
    this.emit(OP.POP);
    this.emit(OP.TRY_POP);
    const jumpGuardedDone = this.emit(OP.JUMP, 0);
    this.patch(jumpToUnguardedClose, this.here);
    this.emit(OP.GET_VAR, iteratorName);
    this.emit(OP.GET_VAR, iteratorName);
    this.emit(OP.GET_PROP, returnName);
    this.emit(OP.CALL_METHOD, 0);
    if (isAsync) this.emit(OP.AWAIT);
    this.emit(OP.POP);
    const jumpUnguardedDone = this.emit(OP.JUMP, 0);
    this.patch(guardPush, this.here);
    this.emit(OP.POP);
    this.emit(OP.TRY_POP);
    const closeBlockTail = this.here;
    this.patch(skipWhenNormal, closeBlockTail);
    this.patch(skipWhenNoReturnMethod, closeBlockTail);
    this.patch(jumpGuardedDone, closeBlockTail);
    this.patch(jumpUnguardedDone, closeBlockTail);
    this.emit(OP.FINALLY_END);

    this.tryProtectionDepth--;
    this.tryGrantDepths.pop();

    // The yield* expression's result: the delegate's done value.
    this.emit(OP.GET_VAR, stepName);
    this.emit(OP.GET_PROP, this.internString('value'));
    if (isAsync) this.emit(OP.AWAIT);
    this.emit(OP.SCOPE_POP);

    return this.ast ? this.ast.writeYield(argOff, true, this.pos(startTok)) : 0;
  }

  /**
   * Handle prefix ++i, --i, ++obj.x, --obj.x, ++arr[i], --arr[i]
   * Returns the NEW value on the stack
   */
  prefixIncrement() {
    const startTok = this.previous; // `++` / `--`
    const op = startTok.type;
    const isIncrement = op === TokenType.PLUS_PLUS;
    const opKind = isIncrement ? UpdateOp.PLUS_PLUS : UpdateOp.MINUS_MINUS;

    // Must start with an identifier
    if (!this.match(TokenType.IDENTIFIER)) {
      this.error("Expected identifier after increment/decrement operator");
      return 0;
    }

    const baseTok = this.previous;
    const baseName = this.internString(baseTok.value);
    const varStart = baseTok.start;
    const varEnd = baseTok.end;
    const baseId = this.ast ? this.ast.writeIdentifier(baseName, this.pos(baseTok)) : 0;

    // Check if followed by property access or index access
    if (this.match(TokenType.DOT)) {
      // ++obj.prop
      this.consumePropertyName();
      const propName = this.internString(this.previous.value);

      const memberNode = this.ast ? this.ast.writeMemberAccess(baseId, propName, this.pos(startTok)) : 0;
      const node = this.ast ? this.ast.writeUpdate(opKind, memberNode, true, this.pos(startTok)) : 0;
      this.emit(OP.GET_VAR, baseName, 0, baseId);
      this.emit(OP.DUP);
      this.emit(OP.GET_PROP, propName, 0, memberNode);
      this.emitLitRationalInteger(1);
      this.emit(isIncrement ? OP.ADD : OP.SUB);
      this.emit(OP.SET_PROP, propName, 0, node);
      return node;
    } else if (this.match(TokenType.LBRACKET)) {
      // ++arr[expr]
      const indexStart = this.here;
      const indexNode = this.expression();
      const indexEnd = this.here;
      this.consume(TokenType.RBRACKET, "Expected ']' after index");

      const accessNode = this.ast ? this.ast.writeIndexAccess(baseId, indexNode, this.pos(startTok)) : 0;
      const node = this.ast ? this.ast.writeUpdate(opKind, accessNode, true, this.pos(startTok)) : 0;

      this.emit(OP.GET_VAR, baseName, 0, baseId);
      this.emit(OP.SWAP);
      this.emit(OP.GET_VAR, baseName, 0, baseId);
      for (let i = indexStart; i < indexEnd; i++) {
        const instr = this.mem.codeBlockReadInstruction( i);
        this.emit(instr.opcode, instr.operand1, instr.operand2);
      }
      this.emit(OP.GET_INDEX, 0, 0, accessNode);
      this.emitLitRationalInteger(1);
      this.emit(isIncrement ? OP.ADD : OP.SUB);
      this.emit(OP.SET_INDEX, 0, 0, node);
      return node;
    } else {
      // Simple identifier: ++i
      const node = this.ast ? this.ast.writeUpdate(opKind, baseId, true, this.pos(startTok)) : 0;
      this.emit(OP.GET_VAR, baseName, 0, baseId);
      this.emitLitRationalInteger(1);
      this.emit(isIncrement ? OP.ADD : OP.SUB);
      this.emitWithSource(OP.SET_VAR, baseName, 0, varStart, varEnd, node);
      return node;
    }
  }

  /**
   * Emit a literal float value.
   */
  emitLitFloat(value) {
    const buffer = new ArrayBuffer(8);
    const f64 = new Float64Array(buffer);
    const u32 = new Uint32Array(buffer);
    f64[0] = value;
    this.emit(OP.LIT_FLOAT, u32[0], u32[1]);
  }

  /**
   * Emit a literal integer value — produces an inline small-Rational.
   * Used by ++ and -- to emit the constant 1.
   */
  emitLitRationalInteger(intValue) {
    const buffer = new ArrayBuffer(8);
    const i64view = new BigInt64Array(buffer);
    const u32view = new Uint32Array(buffer);
    i64view[0] = BigInt(intValue);
    this.emit(OP.LIT_RATIONAL_INTEGER, u32view[0], u32view[1]);
  }

  // ===========================================================================
  // Infix rules
  // ===========================================================================

  getInfixPrecedence(type) {
    switch (type) {
      case TokenType.COMMA: return PREC.COMMA;
      case TokenType.QUESTION: return PREC.TERNARY;
      case TokenType.QUESTION_QUESTION: return PREC.NULLISH;
      case TokenType.OR: return PREC.OR;
      case TokenType.AND: return PREC.AND;
      case TokenType.PIPE: return PREC.BIT_OR;
      case TokenType.CARET: return PREC.BIT_XOR;
      case TokenType.AMPERSAND: return PREC.BIT_AND;
      case TokenType.EQ:
      case TokenType.NEQ: return PREC.EQUALITY;
      case TokenType.LT:
      case TokenType.GT:
      case TokenType.LTE:
      case TokenType.GTE:
      case TokenType.INSTANCEOF:
      case TokenType.IN: return PREC.COMPARISON;
      case TokenType.LSHIFT:
      case TokenType.RSHIFT:
      case TokenType.URSHIFT: return PREC.SHIFT;
      case TokenType.PLUS:
      case TokenType.MINUS: return PREC.TERM;
      case TokenType.STAR:
      case TokenType.SLASH:
      case TokenType.PERCENT: return PREC.FACTOR;
      case TokenType.STAR_STAR: return PREC.POWER;
      case TokenType.LPAREN:
      case TokenType.DOT:
      case TokenType.LBRACKET:
      case TokenType.QUESTION_DOT: return PREC.CALL;
      default: return PREC.NONE;
    }
  }

  getInfixRule(type) {
    switch (type) {
      case TokenType.PLUS:
      case TokenType.MINUS:
      case TokenType.STAR:
      case TokenType.SLASH:
      case TokenType.PERCENT:
      case TokenType.STAR_STAR:
      case TokenType.EQ:
      case TokenType.NEQ:
      case TokenType.LT:
      case TokenType.GT:
      case TokenType.LTE:
      case TokenType.GTE:
      case TokenType.INSTANCEOF:
      case TokenType.IN:
      case TokenType.AMPERSAND:
      case TokenType.PIPE:
      case TokenType.CARET:
      case TokenType.LSHIFT:
      case TokenType.RSHIFT:
      case TokenType.URSHIFT:
        return this.binary;
      case TokenType.AND: return this.and;
      case TokenType.OR: return this.or;
      case TokenType.QUESTION_QUESTION: return this.nullish;
      case TokenType.QUESTION: return this.ternary;
      case TokenType.COMMA: return this.comma;
      case TokenType.LPAREN: return this.call;
      case TokenType.DOT: return this.dot;
      case TokenType.QUESTION_DOT: return this.optionalChain;
      case TokenType.LBRACKET: return this.index;
      default: return null;
    }
  }

  binary(canAssign, leftAst) {
    const op = this.previous.type;
    const opStart = this.previous.start;
    const opEnd = this.previous.end;
    const prec = this.getInfixPrecedence(op);
    // Right associative for ** (power)
    const rightAst = this.parsePrecedence(op === TokenType.STAR_STAR ? prec : prec + 1);

    let opcode;
    switch (op) {
      case TokenType.PLUS: opcode = OP.ADD; break;
      case TokenType.MINUS: opcode = OP.SUB; break;
      case TokenType.STAR: opcode = OP.MUL; break;
      case TokenType.SLASH: opcode = OP.DIV; break;
      case TokenType.PERCENT: opcode = OP.MOD; break;
      case TokenType.STAR_STAR: opcode = OP.POW; break;
      case TokenType.EQ: opcode = OP.EQ; break;
      case TokenType.NEQ: opcode = OP.NEQ; break;
      case TokenType.LT: opcode = OP.LT; break;
      case TokenType.GT: opcode = OP.GT; break;
      case TokenType.LTE: opcode = OP.LTE; break;
      case TokenType.GTE: opcode = OP.GTE; break;
      case TokenType.INSTANCEOF: opcode = OP.INSTANCEOF; break;
      case TokenType.IN: opcode = OP.IN; break;
      case TokenType.AMPERSAND: opcode = OP.BAND; break;
      case TokenType.PIPE: opcode = OP.BOR; break;
      case TokenType.CARET: opcode = OP.BXOR; break;
      case TokenType.LSHIFT: opcode = OP.SHL; break;
      case TokenType.RSHIFT: opcode = OP.SHR; break;
      case TokenType.URSHIFT: opcode = OP.USHR; break;
    }
    const node = this.ast ? this.ast.writeBinaryOp(binaryOpFromToken(op), leftAst, rightAst, this.pos(this.previous)) : 0;
    this.emitWithSource(opcode, 0, 0, opStart, opEnd, node);
    return node;
  }

  and(canAssign, leftAst) {
    const opTok = this.previous;
    const jumpIndex = this.emit(OP.AND, 0); // placeholder
    const rightAst = this.parsePrecedence(PREC.AND + 1);
    this.patch(jumpIndex, this.here);
    const node = this.ast ? this.ast.writeLogicalOp(LogicalOp.AMP_AMP, leftAst, rightAst, this.pos(opTok)) : 0;
    this.attributeInstruction(jumpIndex, node);
    return node;
  }

  or(canAssign, leftAst) {
    const opTok = this.previous;
    const jumpIndex = this.emit(OP.OR, 0);
    const rightAst = this.parsePrecedence(PREC.OR + 1);
    this.patch(jumpIndex, this.here);
    const node = this.ast ? this.ast.writeLogicalOp(LogicalOp.PIPE_PIPE, leftAst, rightAst, this.pos(opTok)) : 0;
    this.attributeInstruction(jumpIndex, node);
    return node;
  }

  nullish(canAssign, leftAst) {
    const opTok = this.previous;
    const jumpIndex = this.emit(OP.NULLISH, 0);
    const rightAst = this.parsePrecedence(PREC.NULLISH + 1);
    this.patch(jumpIndex, this.here);
    const node = this.ast ? this.ast.writeLogicalOp(LogicalOp.QUESTION_QUESTION, leftAst, rightAst, this.pos(opTok)) : 0;
    this.attributeInstruction(jumpIndex, node);
    return node;
  }

  ternary(canAssign, leftAst) {
    const opTok = this.previous; // `?`
    const jumpIfFalse = this.emit(OP.JUMP_IF_FALSE, 0);

    const consequentAst = this.parsePrecedence(PREC.TERNARY);
    this.consume(TokenType.COLON, "Expected ':' in ternary expression");

    const jumpOver = this.emit(OP.JUMP, 0);
    this.patch(jumpIfFalse, this.here);

    const alternateAst = this.parsePrecedence(PREC.TERNARY);
    this.patch(jumpOver, this.here);

    const node = this.ast ? this.ast.writeConditional(leftAst, consequentAst, alternateAst, this.pos(opTok)) : 0;
    this.attributeInstruction(jumpIfFalse, node);
    return node;
  }

  comma(canAssign, leftAst) {
    const opTok = this.previous; // `,`
    this.emit(OP.POP);
    this.pendingMethodCall = false;
    const rightAst = this.parsePrecedence(PREC.COMMA + 1);
    // Build a Sequence node. If left is already a Sequence, append; else wrap.
    if (!this.ast) return 0;
    return this.ast.writeSequence([leftAst, rightAst], this.pos(opTok));
  }

  call(canAssign, leftAst) {
    const startTok = this.previous; // `(`
    const isMethodCall = this.pendingMethodCall;
    this.pendingMethodCall = false;
    const isSuperCall = this.pendingSuperCall;
    this.pendingSuperCall = false;

    let argCount = 0;
    const argOffsets = [];
    let usingBuilder = false;       // switch to args-array builder on first `...`

    if (!this.check(TokenType.RPAREN)) {
      do {
        if (this.check(TokenType.DOT_DOT_DOT)) {
          if (!usingBuilder) {
            // Flush previously-pushed direct args into an array. Stack at
            // this point: [..., closure, arg0, arg1, ..., arg(argCount-1)]
            // — for a method call: [..., receiver, closure, args...].
            // MAKE_ARRAY operand1 = argCount pops those values and pushes
            // an array containing them, leaving the closure (and receiver)
            // beneath it.
            this.emit(OP.MAKE_ARRAY, argCount);
            usingBuilder = true;
          }
          this.advance();                       // consume `...`
          const spreadOffset = this.expression();    // push iterable
          argOffsets.push(spreadOffset);
          this.emitArrayAppendSpread();         // iterate iterable, append to args array
        } else {
          const off = this.expression();
          argOffsets.push(off);
          if (usingBuilder) {
            this.emit(OP.ARRAY_PUSH_ONE);       // append to args array on stack
          } else {
            argCount++;
          }
        }
        if (!this.match(TokenType.COMMA)) break;
      } while (!this.check(TokenType.RPAREN));
    }
    this.consume(TokenType.RPAREN, "Expected ')' after arguments");

    const node = this.ast ? this.ast.writeCall(leftAst, argOffsets, this.pos(startTok)) : 0;
    if (usingBuilder) {
      // Stack: [closure, args_array]  or  [receiver, closure, args_array].
      // CALL_SPREAD / CALL_METHOD_SPREAD pops the args array, unpacks
      // onto the pending stack, and dispatches like CALL / CALL_METHOD.
      if (isMethodCall) {
        this.emit(OP.CALL_METHOD_SPREAD, 0, isSuperCall ? 1 : 0, node);
      } else {
        this.emit(OP.CALL_SPREAD, 0, 0, node);
      }
    } else if (isMethodCall) {
      this.emit(OP.CALL_METHOD, argCount, isSuperCall ? 1 : 0, node);
    } else {
      this.emit(OP.CALL, argCount, 0, node);
    }
    return node;
  }

  /**
   * Handle `new` expression: new Foo(args)
   * Parses the constructor and arguments, emits OP.NEW
   */
  newExpression() {
    const startTok = this.previous; // `new`
    if (this.check(TokenType.DOT)) {
      this.advance(); // `.`
      if (!(this.check(TokenType.IDENTIFIER) && this.current.value === 'target')) {
        throw this.error("Expected 'target' after 'new.'");
      }
      this.advance(); // `target`
      // JS: new.target is a SyntaxError outside function bodies; arrows
      // do not count on their own (they inherit it lexically).
      if (!this.functionStack.some((f) => !f.isArrow)) {
        throw this.error('new.target is only valid inside a function');
      }
      const node = this.ast ? this.ast.writeNewTarget(this.pos(startTok)) : 0;
      // The hidden `@newtarget` binding is defined by every non-arrow
      // invocation (undefined for calls, the callee for constructs, the
      // propagated value for super() calls); arrows find it lexically.
      this.emit(OP.GET_VAR, this.internString('@newtarget'), 0, node);
      return node;
    }
    // Parse ONLY the primary expression (identifier, grouping, etc.)
    let calleeAst = this.parsePrecedence(PREC.PRIMARY);

    // Now handle member access manually (DOT and LBRACKET only, not LPAREN)
    while (true) {
      if (this.match(TokenType.DOT)) {
        calleeAst = this.dot(false, calleeAst) || calleeAst;
      } else if (this.match(TokenType.LBRACKET)) {
        calleeAst = this.index(false, calleeAst) || calleeAst;
      } else {
        break;
      }
    }

    // Check for arguments. Spread arguments (`new Foo(...args)`) switch
    // to the args-array builder — the same idiom as call(): flush any
    // direct args into an array, append per element, and emit NEW_SPREAD
    // which unpacks the array before the shared OP_NEW logic runs.
    let argCount = 0;
    const argOffsets = [];
    let usingBuilder = false;
    if (this.match(TokenType.LPAREN)) {
      if (!this.check(TokenType.RPAREN)) {
        do {
          if (this.check(TokenType.DOT_DOT_DOT)) {
            if (!usingBuilder) {
              this.emit(OP.MAKE_ARRAY, argCount);
              usingBuilder = true;
            }
            this.advance();                          // consume `...`
            const spreadOffset = this.expression();  // push iterable
            argOffsets.push(spreadOffset);
            this.emitArrayAppendSpread();            // iterate, append to args array
          } else {
            const off = this.expression();
            argOffsets.push(off);
            if (usingBuilder) {
              this.emit(OP.ARRAY_PUSH_ONE);
            } else {
              argCount++;
            }
          }
          if (!this.match(TokenType.COMMA)) break;
        } while (!this.check(TokenType.RPAREN));
      }
      this.consume(TokenType.RPAREN, "Expected ')' after constructor arguments");
    }
    // Note: `new Foo` without parens is valid JS (0 args)

    const node = this.ast ? this.ast.writeNew(calleeAst, argOffsets, this.pos(startTok)) : 0;
    if (usingBuilder) {
      this.emit(OP.NEW_SPREAD, 0, 0, node);
    } else {
      this.emit(OP.NEW, argCount, 0, node);
    }
    return node;
  }

  /**
   * Optional chaining: obj?.prop, obj?.[expr], obj?.()
   * If obj is nullish, short-circuit to undefined; else continue normally.
   */
  optionalChain(canAssign, leftAst) {
    const opTok = this.previous; // `?.`
    this.emit(OP.DUP);
    const nullishJump = this.emit(OP.NULLISH, 0);
    this.emit(OP.POP);
    this.emit(OP.LIT_UNDEFINED);
    const skipAccess = this.emit(OP.JUMP, 0);

    this.patch(nullishJump, this.here);
    this.emit(OP.POP);

    let resultNode = 0;
    if (this.check(TokenType.IDENTIFIER) || (this.current && this.current.value && typeof this.current.value === 'string' && !this.check(TokenType.LBRACKET) && !this.check(TokenType.LPAREN))) {
      // obj?.prop (or obj?.#private)
      this.advance();
      const isPrivate = this.previous.type === TokenType.PRIVATE_NAME;
      const name = isPrivate
        ? this.resolvePrivateName(this.previous)
        : this.internString(this.previous.value);
      // The AST keeps the source '#name' spelling (like the dot path)
      // so getSource() round-trips; a re-parse re-mangles consistently.
      const astName = isPrivate ? this.internString(this.previous.value) : name;
      resultNode = this.ast ? this.ast.writeOptionalMember(leftAst, astName, this.pos(opTok)) : 0;
      if (this.pendingDeleteTarget && !this.chainContinues()) {
        if (isPrivate) {
          throw this.error('delete cannot target a private member');
        }
        // `delete obj?.a`: nullish obj already short-circuited to
        // undefined above (matches JS: short-circuit propagates through
        // the whole delete, not just the access) — the real-access path
        // deletes and pushes a boolean, same as plain `delete obj.a`.
        this.pendingDeleteTarget = false;
        this.emit(OP.DELETE_PROP, name, 0, resultNode);
      } else {
        this.emit(OP.GET_PROP, name, isPrivate ? 1 : 0, resultNode);
      }
    } else if (this.match(TokenType.LBRACKET)) {
      // obj?.[expr]
      const indexAst = this.expression();
      this.consume(TokenType.RBRACKET, "Expected ']' after optional index");
      resultNode = this.ast ? this.ast.writeOptionalIndex(leftAst, indexAst, this.pos(opTok)) : 0;
      if (this.pendingDeleteTarget && !this.chainContinues()) {
        this.pendingDeleteTarget = false;
        this.emit(OP.DELETE_INDEX, 0, 0, resultNode);
      } else {
        this.emit(OP.GET_INDEX, 0, 0, resultNode);
      }
    } else if (this.match(TokenType.LPAREN)) {
      // obj?.()
      let argCount = 0;
      const argOffsets = [];
      if (!this.check(TokenType.RPAREN)) {
        do {
          argOffsets.push(this.expression());
          argCount++;
          if (!this.match(TokenType.COMMA)) break;
        } while (!this.check(TokenType.RPAREN));
      }
      this.consume(TokenType.RPAREN, "Expected ')' after optional call arguments");
      resultNode = this.ast ? this.ast.writeOptionalCall(leftAst, argOffsets, this.pos(opTok)) : 0;
      this.emit(OP.CALL, argCount, 0, resultNode);
    } else {
      this.error("Expected property name, '[', or '(' after '?.'");
    }

    this.patch(skipAccess, this.here);
    return resultNode;
  }

  // Whether the postfix chain continues past the current position in a
  // way that consumes THIS access as a value rather than a reference:
  // another `.`/`[`/`?.` (property/index chaining) or `(` (call — e.g.
  // `obj.method()`, where `obj.method` must be read normally to be
  // called, not deleted). Used by delete's operand handling in
  // dot()/index()/optionalChain() to tell "I am the last link, emit a
  // reference" from "something after me consumes my result as a value".
  chainContinues() {
    return this.check(TokenType.DOT) ||
      this.check(TokenType.LBRACKET) ||
      this.check(TokenType.QUESTION_DOT) ||
      this.check(TokenType.LPAREN);
  }

  dot(canAssign, leftAst) {
    this.consumePropertyName();
    const propTok = this.previous;
    // A #private member access resolves to its mangled hidden key for
    // every emission below; the AST keeps the source '#name' spelling so
    // getSource() round-trips (a re-parse re-mangles consistently).
    const isPrivate = propTok.type === TokenType.PRIVATE_NAME;
    const name = isPrivate
      ? this.resolvePrivateName(propTok)
      : this.internString(propTok.value);
    const astName = isPrivate ? this.internString(propTok.value) : name;
    // Private accesses set operand2 bit 0 on GET_PROP/SET_PROP: the
    // runtime throws on a full-chain miss (wrong-class receiver)
    // instead of reading undefined / creating an own property. The
    // class-definition and field-initializer emissions never set it —
    // those are the sites that legitimately create private storage.
    const privFlag = isPrivate ? 1 : 0;
    const memberNode = this.ast ? this.ast.writeMemberAccess(leftAst, astName, this.pos(propTok)) : 0;

    if (canAssign && this.match(TokenType.ASSIGN)) {
      const valueAst = this.expression();
      const node = this.ast ? this.ast.writeAssignment(AssignOp.EQ, memberNode, valueAst, this.pos(propTok)) : 0;
      this.emit(OP.SET_PROP, name, privFlag, node);
      return node;
    } else if (canAssign && this.matchCompoundAssign()) {
      const compoundOp = this.previous.type;
      this.emit(OP.DUP);
      this.emit(OP.GET_PROP, name, privFlag, memberNode);
      const valueAst = this.expression();
      const opKind = assignOpFromToken(compoundOp);
      const node = this.ast ? this.ast.writeAssignment(opKind, memberNode, valueAst, this.pos(propTok)) : 0;
      this.emitCompoundOp(compoundOp);
      this.emit(OP.SET_PROP, name, privFlag, node);
      return node;
    } else if (this.match(TokenType.PLUS_PLUS) || this.match(TokenType.MINUS_MINUS)) {
      const isIncrement = this.previous.type === TokenType.PLUS_PLUS;
      const opKind = isIncrement ? UpdateOp.PLUS_PLUS : UpdateOp.MINUS_MINUS;
      const here = this.here;
      const objInstr = this.mem.codeBlockReadInstruction(here - 1);

      if (objInstr.opcode === OP.GET_VAR) {
        const node = this.ast ? this.ast.writeUpdate(opKind, memberNode, false, this.pos(propTok)) : 0;
        this.emit(OP.GET_PROP, name, privFlag, memberNode);
        this.emit(OP.GET_VAR, objInstr.operand1);
        this.emit(OP.GET_VAR, objInstr.operand1);
        this.emit(OP.GET_PROP, name, privFlag, memberNode);
        this.emitLitRationalInteger(1);
        this.emit(isIncrement ? OP.ADD : OP.SUB);
        this.emit(OP.SET_PROP, name, privFlag, node);
        this.emit(OP.POP);
        return node;
      } else {
        this.error("Postfix increment on complex property access not supported");
        return 0;
      }
    } else if (this.pendingDeleteTarget && !this.chainContinues()) {
      if (isPrivate) {
        throw this.error('delete cannot target a private member');
      }
      // This IS delete's target (last link in the chain, nothing else
      // consumes it): emit a reference (object already on stack from
      // leftAst), not a read. DELETE_PROP pops just the object.
      this.pendingDeleteTarget = false;
      this.emit(OP.DELETE_PROP, name, 0, memberNode);
      return memberNode;
    } else {
      // Property access - check if followed by call (method call pattern)
      if (this.check(TokenType.LPAREN)) {
        // Method call: obj.method() - need receiver for CALL_METHOD
        this.emit(OP.DUP);
        this.emit(OP.GET_PROP, name, privFlag, memberNode);
        this.pendingMethodCall = true;
      } else {
        this.emit(OP.GET_PROP, name, privFlag, memberNode);
      }
      return memberNode;
    }
  }

  index(canAssign, leftAst) {
    const opTok = this.previous; // `[`
    // Track where the object instruction is (for re-emission)
    const objInstrIndex = this.here - 1;

    // Track where the index expression starts
    const indexStart = this.here;
    const indexAst = this.expression();
    const indexEnd = this.here;
    this.consume(TokenType.RBRACKET, "Expected ']' after index");

    const accessNode = this.ast ? this.ast.writeIndexAccess(leftAst, indexAst, this.pos(opTok)) : 0;

    if (canAssign && this.match(TokenType.ASSIGN)) {
      const valueAst = this.expression();
      const node = this.ast ? this.ast.writeAssignment(AssignOp.EQ, accessNode, valueAst, this.pos(opTok)) : 0;
      this.emit(OP.SET_INDEX, 0, 0, node);
      return node;
    } else if (canAssign && this.matchCompoundAssign()) {
      const compoundOp = this.previous.type;
      const objInstr = this.mem.codeBlockReadInstruction(objInstrIndex);

      if (objInstr.opcode === OP.GET_VAR) {
        this.emit(OP.GET_VAR, objInstr.operand1);
        for (let i = indexStart; i < indexEnd; i++) {
          const instr = this.mem.codeBlockReadInstruction(i);
          this.emit(instr.opcode, instr.operand1, instr.operand2);
        }
        this.emit(OP.GET_INDEX, 0, 0, accessNode);
        const valueAst = this.expression();
        const opKind = assignOpFromToken(compoundOp);
        const node = this.ast ? this.ast.writeAssignment(opKind, accessNode, valueAst, this.pos(opTok)) : 0;
        this.emitCompoundOp(compoundOp);
        this.emit(OP.SET_INDEX, 0, 0, node);
        return node;
      } else {
        this.error("Compound assignment on complex object expressions not supported");
        return 0;
      }
    } else if (this.match(TokenType.PLUS_PLUS) || this.match(TokenType.MINUS_MINUS)) {
      const isIncrement = this.previous.type === TokenType.PLUS_PLUS;
      const opKind = isIncrement ? UpdateOp.PLUS_PLUS : UpdateOp.MINUS_MINUS;
      const objInstr = this.mem.codeBlockReadInstruction(objInstrIndex);

      if (objInstr.opcode === OP.GET_VAR) {
        const node = this.ast ? this.ast.writeUpdate(opKind, accessNode, false, this.pos(opTok)) : 0;
        this.emit(OP.GET_INDEX, 0, 0, accessNode);
        this.emit(OP.GET_VAR, objInstr.operand1);
        for (let i = indexStart; i < indexEnd; i++) {
          const instr = this.mem.codeBlockReadInstruction(i);
          this.emit(instr.opcode, instr.operand1, instr.operand2);
        }
        this.emit(OP.GET_VAR, objInstr.operand1);
        for (let i = indexStart; i < indexEnd; i++) {
          const instr = this.mem.codeBlockReadInstruction(i);
          this.emit(instr.opcode, instr.operand1, instr.operand2);
        }
        this.emit(OP.GET_INDEX);
        this.emitLitRationalInteger(1);
        this.emit(isIncrement ? OP.ADD : OP.SUB);
        this.emit(OP.SET_INDEX, 0, 0, node);
        this.emit(OP.POP);
        return node;
      } else {
        this.error("Postfix increment on complex object expressions not supported");
        return 0;
      }
    } else if (this.pendingDeleteTarget && !this.chainContinues()) {
      // This IS delete's target: obj and the index expression are already
      // on the stack (Stack: [obj, index]) — DELETE_INDEX pops both
      // itself, matching SET_INDEX's pop order, ToPropertyKey-ing the
      // index at dispatch the same way GET_INDEX does.
      this.pendingDeleteTarget = false;
      this.emit(OP.DELETE_INDEX, 0, 0, accessNode);
      return accessNode;
    } else {
      if (this.check(TokenType.LPAREN)) {
        const here = this.here;
        const objInstr = this.mem.codeBlockReadInstruction(here - 2);

        if (objInstr.opcode === OP.GET_VAR) {
          this.emit(OP.GET_INDEX, 0, 0, accessNode);
          this.emit(OP.GET_VAR, objInstr.operand1);
          this.emit(OP.SWAP);
          this.pendingMethodCall = true;
        } else {
          this.emit(OP.GET_INDEX, 0, 0, accessNode);
        }
      } else {
        this.emit(OP.GET_INDEX, 0, 0, accessNode);
      }
      return accessNode;
    }
  }
}

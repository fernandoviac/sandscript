/**
 * SandScript AST pretty-printer.
 *
 * Takes a decoded AST tree (from `createAstReader(mem).readTree(offset)`)
 * and produces source-like text. The output is *not* byte-for-byte the
 * original source — comments, whitespace, and trailing-comma style are
 * gone — but it's a faithful, parseable reconstruction of the program.
 *
 * Pure function: no memory image dependency, no side effects. Hosts
 * that want a snippet for a single instruction call
 * `printNode(reader.readTree(astNodeOffset))`.
 */

import {
  NODE,
  BinaryOp,
  LogicalOp,
  UnaryOp,
  UpdateOp,
  AssignOp,
} from './ast.js';
import { regexFlagsToString } from './regex-engine-contract.js';

// =============================================================================
// Operator-name → source-text tables
// =============================================================================

const BINARY_OP_TEXT = {
  [BinaryOp.PLUS]: '+',
  [BinaryOp.MINUS]: '-',
  [BinaryOp.STAR]: '*',
  [BinaryOp.SLASH]: '/',
  [BinaryOp.PERCENT]: '%',
  [BinaryOp.STAR_STAR]: '**',
  [BinaryOp.EQ_EQ]: '==',
  [BinaryOp.NOT_EQ]: '!=',
  [BinaryOp.EQ_EQ_EQ]: '===',
  [BinaryOp.NOT_EQ_EQ]: '!==',
  [BinaryOp.LT]: '<',
  [BinaryOp.GT]: '>',
  [BinaryOp.LT_EQ]: '<=',
  [BinaryOp.GT_EQ]: '>=',
  [BinaryOp.AMP]: '&',
  [BinaryOp.PIPE]: '|',
  [BinaryOp.CARET]: '^',
  [BinaryOp.LT_LT]: '<<',
  [BinaryOp.GT_GT]: '>>',
  [BinaryOp.GT_GT_GT]: '>>>',
  [BinaryOp.IN]: ' in ',
  [BinaryOp.INSTANCEOF]: ' instanceof ',
};

const LOGICAL_OP_TEXT = {
  [LogicalOp.AMP_AMP]: '&&',
  [LogicalOp.PIPE_PIPE]: '||',
  [LogicalOp.QUESTION_QUESTION]: '??',
};

const UNARY_OP_TEXT = {
  [UnaryOp.MINUS]: '-',
  [UnaryOp.PLUS]: '+',
  [UnaryOp.BANG]: '!',
  [UnaryOp.TILDE]: '~',
  [UnaryOp.TYPEOF]: 'typeof ',
  [UnaryOp.VOID]: 'void ',
  [UnaryOp.DELETE]: 'delete ',
};

const UPDATE_OP_TEXT = {
  [UpdateOp.PLUS_PLUS]: '++',
  [UpdateOp.MINUS_MINUS]: '--',
};

const ASSIGN_OP_TEXT = {
  [AssignOp.EQ]: '=',
  [AssignOp.PLUS_EQ]: '+=',
  [AssignOp.MINUS_EQ]: '-=',
  [AssignOp.STAR_EQ]: '*=',
  [AssignOp.SLASH_EQ]: '/=',
  [AssignOp.PERCENT_EQ]: '%=',
  [AssignOp.AMP_EQ]: '&=',
  [AssignOp.PIPE_EQ]: '|=',
  [AssignOp.CARET_EQ]: '^=',
  [AssignOp.LT_LT_EQ]: '<<=',
  [AssignOp.GT_GT_EQ]: '>>=',
  [AssignOp.GT_GT_GT_EQ]: '>>>=',
  [AssignOp.STAR_STAR_EQ]: '**=',
  [AssignOp.AMP_AMP_EQ]: '&&=',
  [AssignOp.PIPE_PIPE_EQ]: '||=',
  [AssignOp.QUESTION_QUESTION_EQ]: '??=',
};

// =============================================================================
// Printer
// =============================================================================

/**
 * Print a decoded AST node to source-like text.
 *
 * @param {object} node - A node returned by createAstReader(mem).readTree(offset).
 *                         Children must be expanded objects, not raw offsets.
 * @param {object} [opts]
 * @param {string} [opts.indent='  '] - Indent unit (default two spaces)
 * @param {number} [opts.depth=0] - Starting indent depth
 * @returns {string}
 */
export function printNode(node, opts = {}) {
  const printer = new Printer(opts);
  return printer.print(node);
}

// =============================================================================
// Token kinds (slice 5 of source-inlining)
// =============================================================================

export const TokenKind = {
  KEYWORD: 'keyword',
  IDENTIFIER: 'identifier',
  LITERAL_INT: 'literal-int',
  LITERAL_FLOAT: 'literal-float',
  LITERAL_STRING: 'literal-string',
  LITERAL_BOOL: 'literal-bool',
  LITERAL_NULL: 'literal-null',
  LITERAL_BIGINT: 'literal-bigint',
  LITERAL_REGEXP: 'literal-regexp',
  LITERAL_RATIONAL: 'literal-rational',
  OPERATOR: 'operator',
  PUNCTUATION: 'punctuation',
  WHITESPACE: 'whitespace',
};

const K = TokenKind;

/**
 * Base class with linear emit(text, kind) semantics. `Printer`
 * accumulates emits into a string (kind ignored). `TokenPrinter` pushes
 * tokens onto an array tagged by kind and the current ancestor chain.
 *
 * Every brace, separator, indent, and operator is an explicit emit in
 * source order — no post-processing of rendered children, no "build
 * then wrap." Whitespace is always emitted as standalone WHITESPACE
 * tokens; embedded spaces in operator/punctuation tokens are not
 * permitted, so a downstream consumer never has to peek inside a
 * non-whitespace token to find boundaries.
 */
class WalkerBase {
  constructor(opts = {}) {
    this.indentUnit = opts.indent ?? '  ';
    this.depth = opts.depth ?? 0;
  }

  pad() {
    return this.indentUnit.repeat(this.depth);
  }

  /**
   * Convenience: emit a single space as a WHITESPACE token.
   */
  space() {
    this.emit(' ', K.WHITESPACE);
  }

  /**
   * Run `fn` with `offset` pushed onto the ancestor stack. No-op on the
   * string Printer (which has no ancestor stack); TokenPrinter overrides
   * this to push/pop. Used to attribute structurally-emitted tokens
   * (like the `let` keyword) to a child node for highlight purposes.
   */
  withAncestor(_offset, fn) {
    fn();
  }

  /**
   * Walk a node, emitting its source-like text in order. Subclasses
   * override emit(text, kind) to capture the output (string vs. tokens).
   */
  walk(node) {
    if (node === null || node === undefined) return;
    switch (node.type) {
      // -----------------------------------------------------------------
      // Literals
      // -----------------------------------------------------------------
      case 'LITERAL_INTEGER': return this.emit(String(node.value), K.LITERAL_INT);
      case 'LITERAL_FLOAT':   return this.emit(formatFloat(node.value), K.LITERAL_FLOAT);
      case 'LITERAL_BOOLEAN': return this.emit(node.value ? 'true' : 'false', K.LITERAL_BOOL);
      case 'LITERAL_NULL':    return this.emit('null', K.LITERAL_NULL);
      case 'LITERAL_UNDEFINED': return this.emit('undefined', K.LITERAL_NULL);
      case 'LITERAL_STRING':  return this.emit(JSON.stringify(node.value), K.LITERAL_STRING);
      case 'LITERAL_RATIONAL':
        if (node.denominator === 1n) {
          return this.emit(String(node.numerator), K.LITERAL_RATIONAL);
        }
        this.emit(String(node.numerator), K.LITERAL_RATIONAL);
        this.emit('/', K.OPERATOR);
        this.emit(String(node.denominator), K.LITERAL_RATIONAL);
        return;
      case 'LITERAL_BIGINT':
        // The 'n' suffix is part of the literal; emit as one token.
        this.emit(`${node.value}n`, K.LITERAL_BIGINT);
        return;
      case 'LITERAL_REGEXP':
        // Delimiters and flags are part of the literal; one token.
        this.emit(
          `/${node.pattern}/${regexFlagsToString(node.flagsWord)}`,
          K.LITERAL_REGEXP);
        return;

      // -----------------------------------------------------------------
      // Names and access
      // -----------------------------------------------------------------
      case 'IDENTIFIER': return this.emit(node.name, K.IDENTIFIER);
      case 'THIS':       return this.emit('this', K.KEYWORD);
      case 'SUPER':      return this.emit('super', K.KEYWORD);
      case 'NEW_TARGET': return this.emit('new.target', K.KEYWORD);
      case 'MEMBER_ACCESS':
        this.walk(node.object);
        this.emit('.', K.PUNCTUATION);
        this.emit(node.name, K.IDENTIFIER);
        return;
      case 'OPTIONAL_MEMBER':
        this.walk(node.object);
        this.emit('?.', K.PUNCTUATION);
        this.emit(node.name, K.IDENTIFIER);
        return;
      case 'INDEX_ACCESS':
        this.walk(node.object);
        this.emit('[', K.PUNCTUATION);
        this.walk(node.index);
        this.emit(']', K.PUNCTUATION);
        return;
      case 'OPTIONAL_INDEX':
        this.walk(node.object);
        this.emit('?.[', K.PUNCTUATION);
        this.walk(node.index);
        this.emit(']', K.PUNCTUATION);
        return;

      // -----------------------------------------------------------------
      // Operators
      // -----------------------------------------------------------------
      case 'BINARY_OP': {
        const opRaw = BINARY_OP_TEXT[node.opKind] ?? '?';
        this.walk(node.left);
        // `in` / `instanceof` are stored with surrounding spaces in the
        // table (' in ', ' instanceof '). Strip them and emit
        // whitespace tokens explicitly so the operator token is just
        // the keyword.
        const trimmed = opRaw.trim();
        this.space();
        // `in` and `instanceof` are keywords, not punctuation operators.
        const kind = (trimmed === 'in' || trimmed === 'instanceof')
          ? K.KEYWORD
          : K.OPERATOR;
        this.emit(trimmed, kind);
        this.space();
        this.walk(node.right);
        return;
      }
      case 'LOGICAL_OP': {
        const op = LOGICAL_OP_TEXT[node.opKind] ?? '?';
        this.walk(node.left);
        this.space();
        this.emit(op, K.OPERATOR);
        this.space();
        this.walk(node.right);
        return;
      }
      case 'UNARY_OP': {
        const opRaw = UNARY_OP_TEXT[node.opKind] ?? '?';
        // typeof/void/delete are keywords with a trailing space in the
        // table; emit the keyword then the explicit space token.
        const trimmed = opRaw.trimEnd();
        if (trimmed === 'typeof' || trimmed === 'void' || trimmed === 'delete') {
          this.emit(trimmed, K.KEYWORD);
          this.space();
        } else {
          this.emit(trimmed, K.OPERATOR);
        }
        this.walk(node.operand);
        return;
      }
      case 'UPDATE': {
        const op = UPDATE_OP_TEXT[node.opKind] ?? '?';
        if (node.prefix) {
          this.emit(op, K.OPERATOR);
          this.walk(node.operand);
        } else {
          this.walk(node.operand);
          this.emit(op, K.OPERATOR);
        }
        return;
      }
      case 'ASSIGNMENT': {
        const op = ASSIGN_OP_TEXT[node.opKind] ?? '=';
        this.walk(node.target);
        this.space();
        this.emit(op, K.OPERATOR);
        this.space();
        this.walk(node.value);
        return;
      }
      case 'CONDITIONAL':
        this.walk(node.test);
        this.space();
        this.emit('?', K.OPERATOR);
        this.space();
        this.walk(node.consequent);
        this.space();
        this.emit(':', K.PUNCTUATION);
        this.space();
        this.walk(node.alternate);
        return;
      case 'SEQUENCE':
        this.walkCommaSeparated(node.expressions);
        return;
      case 'SPREAD':
        this.emit('...', K.PUNCTUATION);
        this.walk(node.argument);
        return;

      // -----------------------------------------------------------------
      // Calls
      // -----------------------------------------------------------------
      case 'CALL':
        this.walk(node.callee);
        this.emit('(', K.PUNCTUATION);
        this.walkCommaSeparated(node.args);
        this.emit(')', K.PUNCTUATION);
        return;
      case 'OPTIONAL_CALL':
        this.walk(node.callee);
        this.emit('?.(', K.PUNCTUATION);
        this.walkCommaSeparated(node.args);
        this.emit(')', K.PUNCTUATION);
        return;
      case 'NEW':
        this.emit('new', K.KEYWORD);
        this.space();
        this.walk(node.callee);
        this.emit('(', K.PUNCTUATION);
        this.walkCommaSeparated(node.args);
        this.emit(')', K.PUNCTUATION);
        return;

      // -----------------------------------------------------------------
      // Control flow
      // -----------------------------------------------------------------
      case 'IF':
        this.emit('if', K.KEYWORD);
        this.space();
        this.emit('(', K.PUNCTUATION);
        this.walk(node.test);
        this.emit(')', K.PUNCTUATION);
        this.space();
        this.walkAsBlock(node.consequent);
        if (node.hasAlternate) {
          this.space();
          this.emit('else', K.KEYWORD);
          this.space();
          this.walkAsBlock(node.alternate);
        }
        return;
      case 'WHILE':
        this.emit('while', K.KEYWORD);
        this.space();
        this.emit('(', K.PUNCTUATION);
        this.walk(node.test);
        this.emit(')', K.PUNCTUATION);
        this.space();
        this.walkAsBlock(node.body);
        return;
      case 'DO_WHILE':
        this.emit('do', K.KEYWORD);
        this.space();
        this.walkAsBlock(node.body);
        this.space();
        this.emit('while', K.KEYWORD);
        this.space();
        this.emit('(', K.PUNCTUATION);
        this.walk(node.test);
        this.emit(')', K.PUNCTUATION);
        return;
      case 'FOR':
        this.emit('for', K.KEYWORD);
        this.space();
        this.emit('(', K.PUNCTUATION);
        if (node.init) this.walk(node.init);
        this.emit(';', K.PUNCTUATION);
        this.space();
        if (node.test) this.walk(node.test);
        this.emit(';', K.PUNCTUATION);
        this.space();
        if (node.update) this.walk(node.update);
        this.emit(')', K.PUNCTUATION);
        this.space();
        this.walkAsBlock(node.body);
        return;
      case 'FOR_IN':
        this.emit('for', K.KEYWORD);
        this.space();
        this.emit('(', K.PUNCTUATION);
        if (node.declarationKeyword) {
          this.emit(node.declarationKeyword, K.KEYWORD);
          this.space();
        }
        this.walk(node.binding);
        this.space();
        this.emit('in', K.KEYWORD);
        this.space();
        this.walk(node.iterable);
        this.emit(')', K.PUNCTUATION);
        this.space();
        this.walkAsBlock(node.body);
        return;
      case 'FOR_OF':
        this.emit('for', K.KEYWORD);
        this.space();
        if (node.isAwait) {
          this.emit('await', K.KEYWORD);
          this.space();
        }
        this.emit('(', K.PUNCTUATION);
        if (node.declarationKeyword) {
          this.emit(node.declarationKeyword, K.KEYWORD);
          this.space();
        }
        this.walk(node.binding);
        this.space();
        this.emit('of', K.KEYWORD);
        this.space();
        this.walk(node.iterable);
        this.emit(')', K.PUNCTUATION);
        this.space();
        this.walkAsBlock(node.body);
        return;
      case 'BREAK':
        this.emit('break', K.KEYWORD);
        if (node.label) {
          this.space();
          this.emit(node.label, K.IDENTIFIER);
        }
        return;
      case 'CONTINUE':
        this.emit('continue', K.KEYWORD);
        if (node.label) {
          this.space();
          this.emit(node.label, K.IDENTIFIER);
        }
        return;
      case 'SWITCH':
        this.emit('switch', K.KEYWORD);
        this.space();
        this.emit('(', K.PUNCTUATION);
        this.walk(node.discriminant);
        this.emit(')', K.PUNCTUATION);
        this.space();
        this.emit('{', K.PUNCTUATION);
        this.emit('\n', K.WHITESPACE);
        this.depth++;
        for (let i = 0; i < node.cases.length; i++) {
          if (i > 0) this.emit('\n', K.WHITESPACE);
          this.emit(this.pad(), K.WHITESPACE);
          this.walk(node.cases[i]);
        }
        this.depth--;
        this.emit('\n', K.WHITESPACE);
        this.emit(this.pad(), K.WHITESPACE);
        this.emit('}', K.PUNCTUATION);
        return;
      case 'SWITCH_CASE':
        if (node.isDefault) {
          this.emit('default', K.KEYWORD);
          this.emit(':', K.PUNCTUATION);
        } else {
          this.emit('case', K.KEYWORD);
          this.space();
          this.walk(node.test);
          this.emit(':', K.PUNCTUATION);
        }
        this.depth++;
        for (const s of node.statements) {
          this.emit('\n', K.WHITESPACE);
          this.emit(this.pad(), K.WHITESPACE);
          this.walk(s);
          this.emit(';', K.PUNCTUATION);
        }
        this.depth--;
        return;
      case 'RETURN':
        this.emit('return', K.KEYWORD);
        if (node.value !== null) {
          this.space();
          this.walk(node.value);
        }
        return;
      case 'THROW':
        this.emit('throw', K.KEYWORD);
        this.space();
        this.walk(node.value);
        return;
      case 'TRY':
        this.emit('try', K.KEYWORD);
        this.space();
        this.walkAsBlock(node.block);
        if (node.hasCatch) {
          this.space();
          this.emit('catch', K.KEYWORD);
          this.space();
          if (node.catchParam) {
            this.emit('(', K.PUNCTUATION);
            this.walk(node.catchParam);
            this.emit(')', K.PUNCTUATION);
            this.space();
          }
          this.walkAsBlock(node.catchBlock);
        }
        if (node.hasFinally) {
          this.space();
          this.emit('finally', K.KEYWORD);
          this.space();
          this.walkAsBlock(node.finallyBlock);
        }
        return;
      case 'LABELED':
        this.emit(node.label, K.IDENTIFIER);
        this.emit(':', K.PUNCTUATION);
        this.space();
        this.walk(node.body);
        return;

      // -----------------------------------------------------------------
      // Declarations and statements
      // -----------------------------------------------------------------
      case 'FUNCTION_DECL':
        if (node.isExported) {
          // Top-level `export function` (v4 FN_EXPORTED) — only ever set
          // on statement-position declarations, never expressions.
          this.emit('export', K.KEYWORD);
          this.space();
        }
        if (node.isAsync) {
          this.emit('async', K.KEYWORD);
          this.space();
        }
        if (node.isArrow) {
          this.emit('(', K.PUNCTUATION);
          this.walkCommaSeparated(node.params);
          this.emit(')', K.PUNCTUATION);
          this.space();
          this.emit('=>', K.OPERATOR);
          this.space();
          this.walkAsBlock(node.body);
        } else {
          this.emit('function', K.KEYWORD);
          if (node.isGenerator) {
            this.emit('*', K.OPERATOR);
          }
          if (node.name) {
            this.space();
            this.emit(node.name, K.IDENTIFIER);
          }
          this.emit('(', K.PUNCTUATION);
          this.walkCommaSeparated(node.params);
          this.emit(')', K.PUNCTUATION);
          this.space();
          this.walkAsBlock(node.body);
        }
        return;
      case 'CLASS_DECL': {
        if (node.isExported) {
          this.emit('export', K.KEYWORD);
          this.space();
        }
        this.emit('class', K.KEYWORD);
        if (node.name) {
          this.space();
          this.emit(node.name, K.IDENTIFIER);
        }
        if (node.heritage) {
          this.space();
          this.emit('extends', K.KEYWORD);
          this.space();
          this.walk(node.heritage);
        }
        this.space();
        if (node.members.length === 0) {
          this.emit('{', K.PUNCTUATION);
          this.emit('}', K.PUNCTUATION);
          return;
        }
        this.emit('{', K.PUNCTUATION);
        this.emit('\n', K.WHITESPACE);
        this.depth++;
        for (let i = 0; i < node.members.length; i++) {
          if (i > 0) this.emit('\n', K.WHITESPACE);
          this.emit(this.pad(), K.WHITESPACE);
          this.walk(node.members[i]);
        }
        this.depth--;
        this.emit('\n', K.WHITESPACE);
        this.emit(this.pad(), K.WHITESPACE);
        this.emit('}', K.PUNCTUATION);
        return;
      }
      case 'CLASS_MEMBER': {
        if (node.isStaticBlock) {
          this.emit('static', K.KEYWORD);
          this.space();
          this.walkAsBlock(node.value.body);
          return;
        }
        if (node.isStatic) {
          this.emit('static', K.KEYWORD);
          this.space();
        }
        const emitKey = () => {
          if (node.isComputed) {
            this.emit('[', K.PUNCTUATION);
            this.walk(node.key);
            this.emit(']', K.PUNCTUATION);
          } else {
            this.walk(node.key);
          }
        };
        if (node.isField) {
          emitKey();
          if (node.value) {
            this.space();
            this.emit('=', K.OPERATOR);
            this.space();
            this.walk(node.value);
          }
          this.emit(';', K.PUNCTUATION);
          return;
        }
        // Method / accessor / constructor — value is a FUNCTION_DECL;
        // inline its params/body (the `function` keyword is suppressed,
        // the same shape OBJECT_PROPERTY methods use).
        const fn = node.value;
        if (node.isGetter) {
          this.emit('get', K.KEYWORD);
          this.space();
        } else if (node.isSetter) {
          this.emit('set', K.KEYWORD);
          this.space();
        } else {
          if (fn.isAsync) {
            this.emit('async', K.KEYWORD);
            this.space();
          }
          if (fn.isGenerator) {
            this.emit('*', K.OPERATOR);
          }
        }
        emitKey();
        this.emit('(', K.PUNCTUATION);
        this.walkCommaSeparated(fn.params);
        this.emit(')', K.PUNCTUATION);
        this.space();
        this.walkAsBlock(fn.body);
        return;
      }
      case 'VARIABLE_DECL': {
        // The let/const keyword is syntactically part of the DECL, but no
        // instruction is attributed to VARIABLE_DECL itself. To make
        // stepping onto the first binding's LET_VAR highlight the whole
        // "let x = ..." span, attribute the keyword (and trailing space)
        // to the first binding for display purposes.
        const firstBinding = node.bindings[0];
        const emitKeyword = () => {
          if (node.isExported) {
            this.emit('export', K.KEYWORD);
            this.space();
          }
          this.emit(node.isConst ? 'const' : 'let', K.KEYWORD);
          this.space();
        };
        if (firstBinding) {
          this.withAncestor(firstBinding.offset, emitKeyword);
        } else {
          emitKeyword();
        }
        this.walkCommaSeparated(node.bindings);
        return;
      }
      case 'VARIABLE_BINDING':
        this.emit(node.name, K.IDENTIFIER);
        if (node.hasInitializer) {
          this.space();
          this.emit('=', K.OPERATOR);
          this.space();
          this.walk(node.initializer);
        }
        return;
      case 'ARRAY_PATTERN': {
        this.emit('[', K.PUNCTUATION);
        for (let i = 0; i < node.elements.length; i++) {
          if (i > 0) {
            this.emit(',', K.PUNCTUATION);
            if (!node.elements[i].isHole) this.space();
          }
          this.walk(node.elements[i]);
        }
        this.emit(']', K.PUNCTUATION);
        if (node.initializer) {
          this.space();
          this.emit('=', K.OPERATOR);
          this.space();
          this.walk(node.initializer);
        }
        return;
      }
      case 'OBJECT_PATTERN': {
        if (node.properties.length === 0) {
          this.emit('{', K.PUNCTUATION);
          this.emit('}', K.PUNCTUATION);
        } else {
          this.emit('{', K.PUNCTUATION);
          this.space();
          this.walkCommaSeparated(node.properties);
          this.space();
          this.emit('}', K.PUNCTUATION);
        }
        if (node.initializer) {
          this.space();
          this.emit('=', K.OPERATOR);
          this.space();
          this.walk(node.initializer);
        }
        return;
      }
      case 'PATTERN_ELEMENT': {
        if (node.isHole) return;
        if (node.isRest) this.emit('...', K.PUNCTUATION);
        if (node.key && !node.isShorthand) {
          if (node.isKeyComputed) {
            this.emit('[', K.PUNCTUATION);
            this.walk(node.key);
            this.emit(']', K.PUNCTUATION);
          } else {
            this.walk(node.key);
          }
          this.emit(':', K.PUNCTUATION);
          this.space();
        }
        if (node.nestedPattern) {
          this.walk(node.nestedPattern);
        } else if (node.name !== null) {
          this.emit(node.name, K.IDENTIFIER);
        }
        if (node.defaultValue) {
          this.space();
          this.emit('=', K.OPERATOR);
          this.space();
          this.walk(node.defaultValue);
        }
        return;
      }
      case 'BLOCK':
        if (node.statements.length === 0) {
          this.emit('{', K.PUNCTUATION);
          this.emit('}', K.PUNCTUATION);
          return;
        }
        this.emit('{', K.PUNCTUATION);
        this.emit('\n', K.WHITESPACE);
        this.depth++;
        for (let i = 0; i < node.statements.length; i++) {
          if (i > 0) this.emit('\n', K.WHITESPACE);
          this.emit(this.pad(), K.WHITESPACE);
          this.walk(node.statements[i]);
          this.emit(';', K.PUNCTUATION);
        }
        this.depth--;
        this.emit('\n', K.WHITESPACE);
        this.emit(this.pad(), K.WHITESPACE);
        this.emit('}', K.PUNCTUATION);
        return;
      case 'EXPRESSION_STMT':
        this.walk(node.expression);
        return;
      case 'EMPTY_STMT':
        return;
      case 'GRANT':
        this.emit('grant', K.KEYWORD);
        this.space();
        if (node.identifiers.length === 1) {
          this.walk(node.identifiers[0]);
        } else {
          this.emit('(', K.PUNCTUATION);
          for (let i = 0; i < node.identifiers.length; i++) {
            if (i > 0) {
              this.emit(',', K.PUNCTUATION);
              this.space();
            }
            this.walk(node.identifiers[i]);
          }
          this.emit(')', K.PUNCTUATION);
        }
        this.space();
        this.walkAsBlock(node.body);
        if (node.hasDenied) {
          this.space();
          this.emit('denied', K.KEYWORD);
          if (node.deniedParam) {
            this.space();
            this.emit('(', K.PUNCTUATION);
            this.emit(node.deniedParam, K.IDENTIFIER);
            this.emit(')', K.PUNCTUATION);
          }
          this.space();
          this.walkAsBlock(node.deniedBody);
        }
        return;

      // -----------------------------------------------------------------
      // Composite literals
      // -----------------------------------------------------------------
      case 'ARRAY_LITERAL':
        this.emit('[', K.PUNCTUATION);
        this.walkCommaSeparated(node.elements);
        this.emit(']', K.PUNCTUATION);
        return;
      case 'OBJECT_LITERAL':
        if (node.properties.length === 0) {
          this.emit('{', K.PUNCTUATION);
          this.emit('}', K.PUNCTUATION);
          return;
        }
        this.emit('{', K.PUNCTUATION);
        this.space();
        this.walkCommaSeparated(node.properties);
        this.space();
        this.emit('}', K.PUNCTUATION);
        return;
      case 'OBJECT_PROPERTY':
        if (node.isShorthand) {
          this.walk(node.key);
          return;
        }
        if (node.isMethod) {
          // value is a FUNCTION_DECL — inline its params/body so the
          // surrounding `:` / `function` framing is suppressed.
          // Accessors carry the get/set keyword in front of the key.
          if (node.isGetter) {
            this.emit('get', K.KEYWORD);
            this.space();
          } else if (node.isSetter) {
            this.emit('set', K.KEYWORD);
            this.space();
          }
          this.walk(node.key);
          const fn = node.value;
          this.emit('(', K.PUNCTUATION);
          this.walkCommaSeparated(fn.params);
          this.emit(')', K.PUNCTUATION);
          this.space();
          this.walkAsBlock(fn.body);
          return;
        }
        this.walk(node.key);
        this.emit(':', K.PUNCTUATION);
        this.space();
        this.walk(node.value);
        return;
      case 'TEMPLATE_LITERAL':
        this.emit('`', K.PUNCTUATION);
        for (const part of node.parts) {
          if (part && part.type === 'LITERAL_STRING') {
            this.emit(part.value, K.LITERAL_STRING);
          } else {
            this.emit('${', K.PUNCTUATION);
            this.walk(part);
            this.emit('}', K.PUNCTUATION);
          }
        }
        this.emit('`', K.PUNCTUATION);
        return;
      case 'TAGGED_TEMPLATE':
        this.walk(node.tagFunction);
        this.walk(node.template);
        return;

      // -----------------------------------------------------------------
      // Async
      // -----------------------------------------------------------------
      case 'AWAIT':
        this.emit('await', K.KEYWORD);
        this.space();
        this.walk(node.argument);
        return;

      case 'YIELD':
        this.emit('yield', K.KEYWORD);
        if (node.isDelegate) {
          this.emit('*', K.OPERATOR);
        }
        if (node.argument) {
          this.space();
          this.walk(node.argument);
        }
        return;

      // -----------------------------------------------------------------
      // Root chain
      // -----------------------------------------------------------------
      case 'ROOT':
        this.walkRootBody(node.body);
        return;

      default:
        this.emit(`<unknown:${node.type}>`, K.IDENTIFIER);
        return;
    }
  }

  /**
   * Walk a list of nodes separated by `, ` (comma + whitespace token).
   */
  walkCommaSeparated(nodes) {
    for (let i = 0; i < nodes.length; i++) {
      if (i > 0) {
        this.emit(',', K.PUNCTUATION);
        this.space();
      }
      this.walk(nodes[i]);
    }
  }

  /**
   * Walk a Block, or wrap a single-statement body in synthetic braces.
   */
  walkAsBlock(node) {
    if (!node) {
      this.emit('{', K.PUNCTUATION);
      this.emit('}', K.PUNCTUATION);
      return;
    }
    if (node.type === 'BLOCK') {
      this.walk(node);
      return;
    }
    this.emit('{', K.PUNCTUATION);
    this.emit('\n', K.WHITESPACE);
    this.depth++;
    this.emit(this.pad(), K.WHITESPACE);
    this.walk(node);
    this.emit(';', K.PUNCTUATION);
    this.depth--;
    this.emit('\n', K.WHITESPACE);
    this.emit(this.pad(), K.WHITESPACE);
    this.emit('}', K.PUNCTUATION);
  }

  /**
   * Walk a top-level Block (from a ROOT) as a sequence of statements
   * without surrounding braces.
   */
  walkRootBody(block) {
    if (!block || block.type !== 'BLOCK') {
      this.walk(block);
      return;
    }
    for (let i = 0; i < block.statements.length; i++) {
      if (i > 0) this.emit('\n', K.WHITESPACE);
      this.emit(this.pad(), K.WHITESPACE);
      this.walk(block.statements[i]);
      this.emit(';', K.PUNCTUATION);
    }
  }
}

/**
 * String-emitting walker. Accumulates emit() calls into `out`. The
 * `kind` arg is ignored — the string path doesn't care about kinds.
 */
class Printer extends WalkerBase {
  constructor(opts = {}) {
    super(opts);
    this.out = '';
  }

  emit(text, _kind) {
    this.out += text;
  }

  /**
   * Compatibility shim with the original Printer.print(node) → string API.
   * Walks the node and returns the accumulated string. Resets `out` so
   * the same printer instance can be reused.
   */
  print(node) {
    this.out = '';
    this.walk(node);
    return this.out;
  }
}

/**
 * Token-emitting walker. Each emit(text, kind) push call captures the
 * current ancestor stack as a snapshot, so consumers can identify the
 * innermost AST node and the chain up to the root for any token. The
 * ancestor stack is push/popped at each walk(node) boundary.
 */
class TokenPrinter extends WalkerBase {
  constructor(opts = {}) {
    super(opts);
    this.tokens = [];
    this.ancestors = [];
  }

  emit(text, kind) {
    if (text === '') return;
    const innermost = this.ancestors.length ? this.ancestors[0] : 0;
    this.tokens.push({
      text,
      astNode: innermost,
      ancestors: this.ancestors.slice(),
      kind,
    });
  }

  walk(node) {
    if (node === null || node === undefined) return;
    this.ancestors.unshift(node.offset);
    try {
      super.walk(node);
    } finally {
      this.ancestors.shift();
    }
  }

  withAncestor(offset, fn) {
    this.ancestors.unshift(offset);
    try {
      fn();
    } finally {
      this.ancestors.shift();
    }
  }
}

/**
 * Format a JS number for source output. Avoids "1" being printed where the
 * source had "1.0" — but since the AST distinguishes LITERAL_INTEGER from
 * LITERAL_FLOAT, any value reaching this path was a float in the source.
 * Force a decimal point if needed.
 */
function formatFloat(value) {
  if (Number.isInteger(value) && Number.isFinite(value)) {
    return `${value}.0`;
  }
  return String(value);
}

/**
 * Convenience: print all roots in a session's AST region as a single source
 * string. Each root's body is emitted top-level (no surrounding braces);
 * roots are separated by a blank line. Returns null when inlineSource is off.
 */
export function printAllRoots(reader) {
  const roots = [...reader.iterateRoots()];
  if (roots.length === 0) return null;
  const printer = new Printer();
  return roots
    .map(off => printer.print(reader.readTree(off)))
    .join('\n\n');
}

// =============================================================================
// Token-emitting exports
//
// Mirror the string exports above, but produce a flat Token[] each. The
// concatenation invariant — `tokens.map(t => t.text).join('') === printNode(node)`
// — is property-tested in tests/fuel/ast_printer_tokens_test.js so the
// two paths cannot silently diverge.
// =============================================================================

/**
 * Print a decoded AST node as a sequence of Tokens. Each token carries
 * its text, the kind for syntax highlighting, the offset of the
 * innermost AST node it sits under (`astNode`), and the chain of all
 * containing AST node offsets from leaf to root (`ancestors`).
 *
 * Returns [] for null/undefined input.
 *
 * @param {object} node - A node returned by createAstReader(mem).readTree(offset).
 * @param {object} [opts]
 * @param {string} [opts.indent='  ']
 * @param {number} [opts.depth=0]
 * @returns {Array<{text:string, astNode:number, ancestors:number[], kind:string}>}
 */
export function printNodeToTokens(node, opts = {}) {
  if (node === null || node === undefined) return [];
  const tp = new TokenPrinter(opts);
  tp.walk(node);
  return tp.tokens;
}

/**
 * Print every root in the AST region as a single sequence of Tokens.
 * Roots are separated by a `'\n\n'` whitespace token whose `astNode` is
 * 0 and `ancestors` is empty — the inter-root gap is owned by no node.
 *
 * Returns [] when the reader has no roots — diverges from
 * printAllRoots's `null` (arrays compose more cleanly on the consumer
 * side; both behaviors are documented).
 */
export function printAllRootsToTokens(reader, opts = {}) {
  const roots = [...reader.iterateRoots()];
  if (roots.length === 0) return [];
  const tp = new TokenPrinter(opts);
  for (let i = 0; i < roots.length; i++) {
    if (i > 0) {
      // Inter-root separator: not owned by any node. We push directly
      // so the ancestor snapshot is empty rather than capturing
      // whatever stack happened to be live.
      tp.tokens.push({
        text: '\n\n',
        astNode: 0,
        ancestors: [],
        kind: TokenKind.WHITESPACE,
      });
    }
    tp.walk(reader.readTree(roots[i]));
  }
  return tp.tokens;
}

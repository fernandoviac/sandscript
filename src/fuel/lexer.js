/**
 * SandScript Fuel Lexer
 *
 * Tokenizes loose SandScript source including operators.
 * Unlike the strict lexer, this handles +, -, *, /, ===, etc.
 */

export const TokenType = {
  // Literals
  NUMBER: 'NUMBER',
  INTEGER: 'INTEGER',  // integer literal (no decimal point, no exponent, no 'n' suffix); value = JS BigInt
  BIGINT: 'BIGINT',
  STRING: 'STRING',
  IDENTIFIER: 'IDENTIFIER',

  // Template literals: a `...` template tokenizes into either a single
  // TEMPLATE_NO_SUB (no `${...}`) or a sequence: HEAD ... (expression
  // tokens) ... MIDDLE ... (more expression tokens) ... TAIL. The
  // expression tokens between substitution markers are regular tokens
  // produced by the normal lexer path; the lexer flips into template-
  // string-scanning mode when it encounters the `}` that closes a
  // substitution.
  TEMPLATE_NO_SUB: 'TEMPLATE_NO_SUB',  // `plain text`
  TEMPLATE_HEAD: 'TEMPLATE_HEAD',      // `hello ${
  TEMPLATE_MIDDLE: 'TEMPLATE_MIDDLE',  // }, you have ${
  TEMPLATE_TAIL: 'TEMPLATE_TAIL',      // } messages`

  // Keywords
  LET: 'LET',
  CONST: 'CONST',
  VAR: 'VAR',
  RETURN: 'RETURN',
  THROW: 'THROW',
  TRY: 'TRY',
  CATCH: 'CATCH',
  FINALLY: 'FINALLY',
  IF: 'IF',
  ELSE: 'ELSE',
  WHILE: 'WHILE',
  DO: 'DO',
  FOR: 'FOR',
  BREAK: 'BREAK',
  CONTINUE: 'CONTINUE',
  TRUE: 'TRUE',
  FALSE: 'FALSE',
  NULL: 'NULL',
  UNDEFINED: 'UNDEFINED',
  TYPEOF: 'TYPEOF',
  VOID: 'VOID',
  DELETE: 'DELETE',
  THIS: 'THIS',
  FUNCTION: 'FUNCTION',
  NEW: 'NEW',
  INSTANCEOF: 'INSTANCEOF',
  IN: 'IN',
  GRANT: 'GRANT',
  DENIED: 'DENIED',
  ASYNC: 'ASYNC',
  AWAIT: 'AWAIT',
  EXPORT: 'EXPORT',
  SWITCH: 'SWITCH',
  CASE: 'CASE',
  DEFAULT: 'DEFAULT',
  CLASS: 'CLASS',
  EXTENDS: 'EXTENDS',
  SUPER: 'SUPER',
  PRIVATE_NAME: 'PRIVATE_NAME', // #name (class private member); value includes the '#'

  // Punctuation
  LPAREN: 'LPAREN',
  RPAREN: 'RPAREN',
  LBRACE: 'LBRACE',
  RBRACE: 'RBRACE',
  LBRACKET: 'LBRACKET',
  RBRACKET: 'RBRACKET',
  SEMICOLON: 'SEMICOLON',
  COLON: 'COLON',
  COMMA: 'COMMA',
  DOT: 'DOT',
  DOT_DOT_DOT: 'DOT_DOT_DOT',  // ... (spread / rest)
  ARROW: 'ARROW',

  // Assignment
  ASSIGN: 'ASSIGN',

  // Arithmetic operators
  PLUS: 'PLUS',
  MINUS: 'MINUS',
  STAR: 'STAR',
  SLASH: 'SLASH',
  PERCENT: 'PERCENT',
  STAR_STAR: 'STAR_STAR',

  // Compound assignment
  PLUS_ASSIGN: 'PLUS_ASSIGN',       // +=
  MINUS_ASSIGN: 'MINUS_ASSIGN',     // -=
  STAR_ASSIGN: 'STAR_ASSIGN',       // *=
  SLASH_ASSIGN: 'SLASH_ASSIGN',     // /=
  PERCENT_ASSIGN: 'PERCENT_ASSIGN', // %=
  STAR_STAR_ASSIGN: 'STAR_STAR_ASSIGN', // **=

  // Increment/Decrement
  PLUS_PLUS: 'PLUS_PLUS',     // ++
  MINUS_MINUS: 'MINUS_MINUS', // --

  // Comparison operators
  EQ: 'EQ',           // ===
  NEQ: 'NEQ',         // !==
  LT: 'LT',           // <
  GT: 'GT',           // >
  LTE: 'LTE',         // <=
  GTE: 'GTE',         // >=

  // Logical operators
  AND: 'AND',         // &&
  OR: 'OR',           // ||
  NOT: 'NOT',         // !

  // Bitwise operators
  AMPERSAND: 'AMPERSAND',   // &
  PIPE: 'PIPE',             // |
  CARET: 'CARET',           // ^
  TILDE: 'TILDE',           // ~
  LSHIFT: 'LSHIFT',         // <<
  RSHIFT: 'RSHIFT',         // >>
  URSHIFT: 'URSHIFT',       // >>>

  // Bitwise compound assignment
  AMPERSAND_ASSIGN: 'AMPERSAND_ASSIGN', // &=
  PIPE_ASSIGN: 'PIPE_ASSIGN',           // |=
  CARET_ASSIGN: 'CARET_ASSIGN',         // ^=
  LSHIFT_ASSIGN: 'LSHIFT_ASSIGN',       // <<=
  RSHIFT_ASSIGN: 'RSHIFT_ASSIGN',       // >>=
  URSHIFT_ASSIGN: 'URSHIFT_ASSIGN',     // >>>=

  // Ternary
  QUESTION: 'QUESTION', // ?

  // Nullish/Optional
  QUESTION_QUESTION: 'QUESTION_QUESTION', // ??
  QUESTION_DOT: 'QUESTION_DOT',           // ?.

  // RegExp literal — produced only by rescanRegExpFrom (parser-directed
  // lexical goal at expression positions); value = { pattern, flags }.
  REGEXP: 'REGEXP',

  // Deferred lexical error — produced instead of throwing when a
  // character cannot start any token. The parser throws the carried
  // SyntaxError only when it CONSUMES the token: a `/` at an
  // expression position re-scans as a RegExp literal before its stale
  // division-goal lookahead is ever consumed, so `/\d/` (escape as the
  // first pattern character) must not explode while merely priming
  // that lookahead. value = the SyntaxError.
  INVALID: 'INVALID',

  // Comments (emitted for syntax highlighting, skipped by parser)
  COMMENT: 'COMMENT',

  EOF: 'EOF',
};

// Use Object.create(null) to avoid prototype pollution
// (e.g., 'hasOwnProperty' would otherwise match Object.prototype.hasOwnProperty)
const KEYWORDS = Object.assign(Object.create(null), {
  'let': TokenType.LET,
  'const': TokenType.CONST,
  'var': TokenType.VAR,
  'return': TokenType.RETURN,
  'throw': TokenType.THROW,
  'try': TokenType.TRY,
  'catch': TokenType.CATCH,
  'finally': TokenType.FINALLY,
  'if': TokenType.IF,
  'else': TokenType.ELSE,
  'while': TokenType.WHILE,
  'do': TokenType.DO,
  'for': TokenType.FOR,
  'break': TokenType.BREAK,
  'continue': TokenType.CONTINUE,
  'true': TokenType.TRUE,
  'false': TokenType.FALSE,
  'null': TokenType.NULL,
  'undefined': TokenType.UNDEFINED,
  'typeof': TokenType.TYPEOF,
  'void': TokenType.VOID,
  'delete': TokenType.DELETE,
  'this': TokenType.THIS,
  'function': TokenType.FUNCTION,
  'new': TokenType.NEW,
  'instanceof': TokenType.INSTANCEOF,
  'in': TokenType.IN,
  'grant': TokenType.GRANT,
  'denied': TokenType.DENIED,
  'async': TokenType.ASYNC,
  'await': TokenType.AWAIT,
  'export': TokenType.EXPORT,
  'switch': TokenType.SWITCH,
  'case': TokenType.CASE,
  'default': TokenType.DEFAULT,
  'class': TokenType.CLASS,
  'extends': TokenType.EXTENDS,
  'super': TokenType.SUPER,
});

// Keyword token types, for parser sites that accept any
// IdentifierName (reserved words included) per JS — property keys
// in object literals and patterns. Keyword tokens carry their
// lexeme in `value`.
export const KEYWORD_TOKEN_TYPES = new Set(Object.values(KEYWORDS));

// Value of one hexadecimal digit, or -1. Used by the string escapes.
function hexDigitValue(ch) {
  if (ch >= 48 && ch <= 57) return ch - 48; // 0-9
  if (ch >= 97 && ch <= 102) return ch - 87; // a-f
  if (ch >= 65 && ch <= 70) return ch - 55; // A-F
  return -1;
}

export class Lexer {
  constructor(source = '') {
    this.source = source;
    this.pos = 0;
    this.line = 1;
    this.col = 1;
    this.tokenStart = 0;
    this.tokenLine = 1;
    this.tokenCol = 1;
    // Stack of per-substitution brace depths. Non-empty means we're inside
    // a template literal's `${...}`. Each entry is the current brace depth
    // for that substitution (push 0 at `${`, increment on `{`, decrement on
    // `}`; when an entry hits -1 the substitution ends and the lexer flips
    // back to scanning string-part bytes for the enclosing template).
    this.templateBraceDepth = [];
  }

  reset(source) {
    this.source = source;
    this.pos = 0;
    this.line = 1;
    this.col = 1;
    this.tokenStart = 0;
    this.tokenLine = 1;
    this.tokenCol = 1;
    this.templateBraceDepth = [];
  }

  /**
   * Snapshot the lexer cursor (position + line/column tracking).
   * Used by destructuring to skim the pattern in pass 1, then rewind
   * to emit it in pass 2.
   */
  saveState() {
    return {
      pos: this.pos,
      line: this.line,
      col: this.col,
      tokenStart: this.tokenStart,
      tokenLine: this.tokenLine,
      tokenCol: this.tokenCol,
      templateBraceDepth: this.templateBraceDepth.slice(),
    };
  }

  restoreState(s) {
    this.pos = s.pos;
    this.line = s.line;
    this.col = s.col;
    this.tokenStart = s.tokenStart;
    this.tokenLine = s.tokenLine;
    this.tokenCol = s.tokenCol;
    this.templateBraceDepth = s.templateBraceDepth ? s.templateBraceDepth.slice() : [];
  }

  peek(offset = 0) {
    const idx = this.pos + offset;
    return idx < this.source.length ? this.source.charCodeAt(idx) : 0;
  }

  advance() {
    const ch = this.source.charCodeAt(this.pos++) || 0;
    if (ch === 10) { // \n
      this.line++;
      this.col = 1;
    } else {
      this.col++;
    }
    return ch;
  }

  skipWhitespace() {
    while (true) {
      const ch = this.peek();
      if (ch === 32 || ch === 9 || ch === 13 || ch === 10) { // space, tab, \r, \n
        this.advance();
      } else if (ch === 47 && this.peek(1) === 47) { // //
        // Single-line comment — emit token
        this.tokenStart = this.pos;
        this.tokenLine = this.line;
        this.tokenCol = this.col;

        while (this.peek() !== 10 && this.peek() !== 0) {
          this.advance();
        }

        return this.makeToken(TokenType.COMMENT, this.source.slice(this.tokenStart, this.pos));
      } else if (ch === 47 && this.peek(1) === 42) { // /*
        // Multi-line comment — emit token
        this.tokenStart = this.pos;
        this.tokenLine = this.line;
        this.tokenCol = this.col;

        this.advance();
        this.advance();
        while (!(this.peek() === 42 && this.peek(1) === 47) && this.peek() !== 0) {
          this.advance();
        }
        if (this.peek() !== 0) {
          this.advance();
          this.advance();
        }

        return this.makeToken(TokenType.COMMENT, this.source.slice(this.tokenStart, this.pos));
      } else {
        return null;
      }
    }
  }

  error(message) {
    return new SyntaxError(`${message} at line ${this.tokenLine}, col ${this.tokenCol}`);
  }

  makeToken(type, value = null) {
    return {
      type,
      value,
      start: this.tokenStart,
      end: this.pos,
      line: this.tokenLine,
      col: this.tokenCol,
    };
  }

  // One escape table for strings and template literals. The backslash is
  // already consumed; this returns the text it stands for.
  //
  // An escape the table does not know is a mistake, not a licence to drop
  // the backslash. Dropping it turned "\u2193" into the letters u2193 and
  // drew them into documents for a day with nothing reported: degree signs,
  // minus signs and arrows all rendered as text nobody could tell was
  // wrong by reading the program. Refusing costs no expressiveness — "\\p"
  // is a literal backslash, and any character can be written directly in
  // this UTF-8 source or as "\u{...}".
  readEscape(unterminated) {
    const esc = this.advance();
    switch (esc) {
      case 0: throw this.error(unterminated);
      // A line continuation joins two source lines and contributes nothing.
      case 13: if (this.peek() === 10) this.advance(); return '';
      case 10: case 8232: case 8233: return '';
      case 110: return '\n'; // n
      case 116: return '\t'; // t
      case 114: return '\r'; // r
      case 98: return '\b'; // b
      case 102: return '\f'; // f
      case 118: return '\v'; // v
      case 92: return '\\';
      case 34: return '"';
      case 39: return "'";
      case 96: return '`';
      case 36: return '$';
      case 47: return '/';
      case 48: { // 0 — the NUL character, never a legacy octal escape
        const next = this.peek();
        if (next >= 48 && next <= 57) {
          throw this.error(
            'Octal escapes are not supported; write "\\u{...}" or "\\0"',
          );
        }
        return '\0';
      }
      case 120: return this.readHexEscape(2, 'x'); // x
      case 117: return this.readUnicodeEscape(); // u
      default: {
        if (esc >= 49 && esc <= 57) {
          throw this.error(
            'Octal escapes are not supported; write "\\u{...}"',
          );
        }
        throw this.error(
          `Unknown escape "\\${String.fromCharCode(esc)}": write ` +
            '"\\\\" for a literal backslash, or "\\u{...}" for a character',
        );
      }
    }
  }

  // Exactly `count` hexadecimal digits, as in "\x41" and "\u2193". A short
  // or misspelled payload is refused rather than half-read: "\u21" as the
  // letters u21 is the defect this table exists to end.
  readHexEscape(count, marker) {
    let value = 0;
    for (let index = 0; index < count; index++) {
      const digit = hexDigitValue(this.peek());
      if (digit < 0) {
        throw this.error(
          `"\\${marker}" needs ${count} hexadecimal digits`,
        );
      }
      value = value * 16 + digit;
      this.advance();
    }
    return String.fromCharCode(value);
  }

  // "\uXXXX" for one code unit, so a lone surrogate stays expressible, and
  // "\u{...}" for any code point including the astral planes.
  readUnicodeEscape() {
    if (this.peek() !== 123) return this.readHexEscape(4, 'u'); // {
    this.advance();
    let value = 0;
    let digits = 0;
    while (true) {
      const digit = hexDigitValue(this.peek());
      if (digit < 0) break;
      value = value * 16 + digit;
      digits++;
      this.advance();
    }
    if (digits === 0 || digits > 6 || this.peek() !== 125) { // }
      throw this.error(
        '"\\u{...}" needs 1 to 6 hexadecimal digits and a closing brace',
      );
    }
    this.advance();
    if (value > 0x10FFFF) {
      throw this.error(
        '"\\u{...}" is above the highest code point 10FFFF',
      );
    }
    return String.fromCodePoint(value);
  }

  scanString() {
    const quote = this.advance(); // consume " or '
    let value = '';
    while (this.peek() !== quote && this.peek() !== 0) {
      if (this.peek() === 10) throw this.error('Unterminated string');
      if (this.peek() === 92) { // \
        this.advance();
        value += this.readEscape('Unterminated string');
      } else {
        value += String.fromCharCode(this.advance());
      }
    }
    if (this.peek() === 0) throw this.error('Unterminated string');
    this.advance(); // consume closing quote
    return this.makeToken(TokenType.STRING, value);
  }

  /**
   * Re-scan a `/` (or `/=`) token as a RegExp literal — the parser calls
   * this when the token sits at an expression position, where JS's
   * InputElementRegExp lexical goal applies. The parser owns goal
   * selection; the lexer just re-reads from the token's start under the
   * other goal. Restores nothing: after this call the cursor sits past
   * the literal and the parser must re-prime its lookahead.
   *
   * @param {object} slashToken - The already-lexed SLASH / SLASH_ASSIGN
   *   token (carries start/line/col of the `/`).
   * @returns {object} REGEXP token; value = { pattern, flags } (raw
   *   text, pattern without delimiters).
   */
  rescanRegExpFrom(slashToken) {
    this.pos = slashToken.start;
    this.line = slashToken.line;
    this.col = slashToken.col;
    this.tokenStart = this.pos;
    this.tokenLine = this.line;
    this.tokenCol = this.col;

    this.advance(); // consume the opening '/'
    const bodyStart = this.pos;
    let inClass = false;
    while (true) {
      const ch = this.peek();
      if (ch === 0 || ch === 10 || ch === 13 || ch === 8232 || ch === 8233) {
        throw this.error('Unterminated regular expression literal');
      }
      if (ch === 92) { // \ — escape: the next character is consumed blind
        this.advance();
        const escaped = this.peek();
        if (escaped === 0 || escaped === 10 || escaped === 13 ||
            escaped === 8232 || escaped === 8233) {
          throw this.error('Unterminated regular expression literal');
        }
        this.advance();
        continue;
      }
      if (ch === 91) inClass = true;        // [
      else if (ch === 93) inClass = false;  // ]
      else if (ch === 47 && !inClass) break; // closing /
      this.advance();
    }
    const pattern = this.source.slice(bodyStart, this.pos);
    this.advance(); // consume the closing '/'
    const flagsStart = this.pos;
    while (this.isAlpha(this.peek()) || this.isDigit(this.peek())) {
      this.advance();
    }
    const flags = this.source.slice(flagsStart, this.pos);
    return this.makeToken(TokenType.REGEXP, { pattern, flags });
  }

  /**
   * Scan a template-literal string fragment. Called twice in different
   * positions:
   *   - isHead=true:  right after the opening backtick. Will emit either
   *                   TEMPLATE_NO_SUB (closes at the matching `) or
   *                   TEMPLATE_HEAD (followed by `${`, substitution begins).
   *   - isHead=false: right after the `}` that closed a substitution.
   *                   Emits TEMPLATE_MIDDLE (another `${` follows) or
   *                   TEMPLATE_TAIL (the closing ` is next).
   *
   * Escape sequences supported: \n \t \r \\ \` \${ \" \'.
   * Any other \x falls through as the literal char (matches scanString).
   * Multi-line content (real newlines) is allowed and preserved verbatim.
   */
  scanTemplatePart(isHead) {
    let value = '';
    while (true) {
      const ch = this.peek();
      if (ch === 0) {
        throw this.error('Unterminated template literal');
      }
      if (ch === 96) { // `  → end of template
        this.advance();
        return this.makeToken(
          isHead ? TokenType.TEMPLATE_NO_SUB : TokenType.TEMPLATE_TAIL,
          value);
      }
      if (ch === 36 && this.peek(1) === 123) { // ${  → substitution opens
        this.advance(); // $
        this.advance(); // {
        this.templateBraceDepth.push(0);
        return this.makeToken(
          isHead ? TokenType.TEMPLATE_HEAD : TokenType.TEMPLATE_MIDDLE,
          value);
      }
      if (ch === 92) { // \
        this.advance();
        value += this.readEscape('Unterminated template literal');
        continue;
      }
      // Track newlines for accurate error positions in multi-line templates.
      if (ch === 10) {
        this.line++;
        this.col = 1;
        this.pos++;
        value += '\n';
        continue;
      }
      value += String.fromCharCode(this.advance());
    }
  }

  scanNumber() {
    const firstChar = this.advance();

    // Check for base prefix when first char is '0'
    if (firstChar === 48) { // '0'
      const prefix = this.peek();
      if (prefix === 120 || prefix === 88) { // x, X
        this.advance();
        return this.scanBaseNumber(16, 'hexadecimal');
      } else if (prefix === 98 || prefix === 66) { // b, B
        this.advance();
        return this.scanBaseNumber(2, 'binary');
      } else if (prefix === 111 || prefix === 79) { // o, O
        this.advance();
        return this.scanBaseNumber(8, 'octal');
      }
      // Fall through - decimal starting with 0
    }

    // Decimal number
    let value = String.fromCharCode(firstChar);
    value += this.scanDecimalDigits(false);

    // Check for BigInt suffix before fractional/exponent parts
    if (this.peek() === 110) { // 'n'
      this.advance();
      return this.makeToken(TokenType.BIGINT, value);
    }

    let isInteger = true;

    // Fractional part
    if (this.peek() === 46 && this.isDigit(this.peek(1))) { // .
      isInteger = false;
      value += String.fromCharCode(this.advance());
      value += this.scanDecimalDigits(true);
    }

    // Exponent
    if (this.peek() === 101 || this.peek() === 69) { // e, E
      isInteger = false;
      value += String.fromCharCode(this.advance());
      if (this.peek() === 43 || this.peek() === 45) { // +, -
        value += String.fromCharCode(this.advance());
      }
      value += this.scanDecimalDigits(true);
    }

    if (isInteger) {
      return this.makeToken(TokenType.INTEGER, BigInt(value.replace(/_/g, '')));
    }
    return this.makeToken(TokenType.NUMBER, parseFloat(value));
  }

  /**
   * Scan digits for non-decimal bases (hex, binary, octal).
   * Returns NUMBER token with parsed integer value.
   */
  scanBaseNumber(base, name) {
    // Check for separator immediately after prefix
    if (this.peek() === 95) { // _
      throw this.error(`Numeric separator after ${name} prefix`);
    }

    let value = '';
    let lastWasSeparator = false;

    while (true) {
      const ch = this.peek();

      if (ch === 95) { // _
        if (lastWasSeparator) {
          throw this.error('Consecutive numeric separators');
        }
        if (value === '') {
          throw this.error(`Numeric separator after ${name} prefix`);
        }
        lastWasSeparator = true;
        this.advance();
        continue;
      }

      if (this.isValidDigit(ch, base)) {
        value += String.fromCharCode(this.advance());
        lastWasSeparator = false;
      } else if (ch === 110 && value !== '') { // 'n' — BigInt suffix, handled after loop
        break;
      } else if (this.isDigit(ch) || this.isAlpha(ch)) {
        // Invalid digit for this base
        throw this.error(`Invalid ${name} digit '${String.fromCharCode(ch)}'`);
      } else {
        break;
      }
    }

    if (value === '') {
      throw this.error(`${name.charAt(0).toUpperCase() + name.slice(1)} literal with no digits`);
    }

    if (lastWasSeparator) {
      throw this.error('Trailing numeric separator');
    }

    // Check for BigInt suffix
    if (this.peek() === 110) { // 'n'
      this.advance();
      // Store base prefix so parser can reconstruct: "0x" + value, "0b" + value, etc.
      const prefix = base === 16 ? '0x' : base === 2 ? '0b' : base === 8 ? '0o' : '';
      return this.makeToken(TokenType.BIGINT, prefix + value);
    }

    // Base-prefixed numbers (hex/bin/oct) are always integers — emit INTEGER
    // with the value as a JS BigInt so the parser can choose inline vs heap.
    const prefix = base === 16 ? '0x' : base === 2 ? '0b' : base === 8 ? '0o' : '';
    return this.makeToken(TokenType.INTEGER, BigInt(prefix + value));
  }

  /**
   * Scan decimal digits with separator support.
   * @param {boolean} required - If true, at least one digit is required
   */
  scanDecimalDigits(required) {
    let value = '';
    let lastWasSeparator = false;

    while (true) {
      const ch = this.peek();

      if (ch === 95) { // _
        if (lastWasSeparator) {
          throw this.error('Consecutive numeric separators');
        }
        if (value === '' && required) {
          throw this.error('Numeric separator at invalid position');
        }
        lastWasSeparator = true;
        this.advance();
        continue;
      }

      if (this.isDigit(ch)) {
        value += String.fromCharCode(this.advance());
        lastWasSeparator = false;
      } else {
        break;
      }
    }

    if (lastWasSeparator) {
      throw this.error('Trailing numeric separator');
    }

    if (required && value === '') {
      throw this.error('Expected digits');
    }

    return value;
  }

  /**
   * Check if character is a valid digit for the given base.
   */
  isValidDigit(ch, base) {
    if (base === 2) {
      return ch === 48 || ch === 49; // 0, 1
    } else if (base === 8) {
      return ch >= 48 && ch <= 55; // 0-7
    } else if (base === 16) {
      return (ch >= 48 && ch <= 57) ||  // 0-9
             (ch >= 65 && ch <= 70) ||  // A-F
             (ch >= 97 && ch <= 102);   // a-f
    }
    return this.isDigit(ch);
  }

  scanIdentifier() {
    let value = '';
    while (this.isAlphaNumeric(this.peek())) {
      value += String.fromCharCode(this.advance());
    }
    const type = KEYWORDS[value] || TokenType.IDENTIFIER;
    return this.makeToken(type, value);
  }

  isDigit(ch) {
    return ch >= 48 && ch <= 57; // 0-9
  }

  isAlpha(ch) {
    return (ch >= 65 && ch <= 90) || (ch >= 97 && ch <= 122) || ch === 95 || ch === 36; // A-Z, a-z, _, $
  }

  isAlphaNumeric(ch) {
    return this.isAlpha(ch) || this.isDigit(ch);
  }

  next() {
    const comment = this.skipWhitespace();
    if (comment) return comment;

    this.tokenStart = this.pos;
    this.tokenLine = this.line;
    this.tokenCol = this.col;

    if (this.pos >= this.source.length) {
      return this.makeToken(TokenType.EOF);
    }

    const ch = this.peek();

    // Template-literal continuation: inside a `${...}` substitution, track
    // brace depth so that the `}` matching `${` closes the substitution
    // and flips back to scanning string-part bytes (rather than emitting
    // a regular RBRACE token).
    if (this.templateBraceDepth.length > 0) {
      const top = this.templateBraceDepth.length - 1;
      if (ch === 123) { // {
        this.templateBraceDepth[top]++;
        this.advance();
        return this.makeToken(TokenType.LBRACE);
      }
      if (ch === 125) { // }
        if (this.templateBraceDepth[top] === 0) {
          // This `}` closes the substitution. Pop the stack and scan the
          // next string-part (which will be a MIDDLE or TAIL).
          this.templateBraceDepth.pop();
          this.advance(); // consume the `}`
          return this.scanTemplatePart(/* isHead */ false);
        }
        this.templateBraceDepth[top]--;
        this.advance();
        return this.makeToken(TokenType.RBRACE);
      }
    }

    // String
    if (ch === 34 || ch === 39) { // " or '
      return this.scanString();
    }

    // Template literal — backtick starts the template-string scan.
    if (ch === 96) { // `
      this.advance(); // consume opening backtick
      return this.scanTemplatePart(/* isHead */ true);
    }

    // Number
    if (this.isDigit(ch)) {
      return this.scanNumber();
    }

    // Identifier or keyword
    if (this.isAlpha(ch)) {
      return this.scanIdentifier();
    }

    // Private name: '#' + identifier (class-support). One token whose
    // value INCLUDES the '#'. The name part is scanned raw — '#catch'
    // is a private name, never the keyword.
    if (ch === 35 && this.isAlpha(this.peek(1))) { // #
      this.advance(); // consume '#'
      let value = '#';
      while (this.isAlphaNumeric(this.peek())) {
        value += String.fromCharCode(this.advance());
      }
      return this.makeToken(TokenType.PRIVATE_NAME, value);
    }

    // Single character tokens
    this.advance();

    switch (ch) {
      case 40: return this.makeToken(TokenType.LPAREN);   // (
      case 41: return this.makeToken(TokenType.RPAREN);   // )
      case 123: return this.makeToken(TokenType.LBRACE); // {
      case 125: return this.makeToken(TokenType.RBRACE); // }
      case 91: return this.makeToken(TokenType.LBRACKET); // [
      case 93: return this.makeToken(TokenType.RBRACKET); // ]
      case 59: return this.makeToken(TokenType.SEMICOLON); // ;
      case 58: return this.makeToken(TokenType.COLON);    // :
      case 44: return this.makeToken(TokenType.COMMA);    // ,
      case 46: // .
        if (this.peek() === 46 && this.peek(1) === 46) {  // ...
          this.advance();
          this.advance();
          return this.makeToken(TokenType.DOT_DOT_DOT);
        }
        return this.makeToken(TokenType.DOT);

      case 43: // +
        if (this.peek() === 43) { // ++
          this.advance();
          return this.makeToken(TokenType.PLUS_PLUS);
        }
        if (this.peek() === 61) { // +=
          this.advance();
          return this.makeToken(TokenType.PLUS_ASSIGN);
        }
        return this.makeToken(TokenType.PLUS);
      case 45: // -
        if (this.peek() === 45) { // --
          this.advance();
          return this.makeToken(TokenType.MINUS_MINUS);
        }
        if (this.peek() === 61) { // -=
          this.advance();
          return this.makeToken(TokenType.MINUS_ASSIGN);
        }
        return this.makeToken(TokenType.MINUS);
      case 42: // *
        if (this.peek() === 42) { // **
          this.advance();
          if (this.peek() === 61) { // **=
            this.advance();
            return this.makeToken(TokenType.STAR_STAR_ASSIGN);
          }
          return this.makeToken(TokenType.STAR_STAR);
        }
        if (this.peek() === 61) { // *=
          this.advance();
          return this.makeToken(TokenType.STAR_ASSIGN);
        }
        return this.makeToken(TokenType.STAR);
      case 47: // /
        if (this.peek() === 61) { // /=
          this.advance();
          return this.makeToken(TokenType.SLASH_ASSIGN);
        }
        return this.makeToken(TokenType.SLASH);
      case 37: // %
        if (this.peek() === 61) { // %=
          this.advance();
          return this.makeToken(TokenType.PERCENT_ASSIGN);
        }
        return this.makeToken(TokenType.PERCENT);

      case 60: // <
        if (this.peek() === 60) { // <<
          this.advance();
          if (this.peek() === 61) { // <<=
            this.advance();
            return this.makeToken(TokenType.LSHIFT_ASSIGN);
          }
          return this.makeToken(TokenType.LSHIFT);
        }
        if (this.peek() === 61) { // <=
          this.advance();
          return this.makeToken(TokenType.LTE);
        }
        return this.makeToken(TokenType.LT);
      case 62: // >
        if (this.peek() === 62) { // >>
          this.advance();
          if (this.peek() === 62) { // >>>
            this.advance();
            if (this.peek() === 61) { // >>>=
              this.advance();
              return this.makeToken(TokenType.URSHIFT_ASSIGN);
            }
            return this.makeToken(TokenType.URSHIFT);
          }
          if (this.peek() === 61) { // >>=
            this.advance();
            return this.makeToken(TokenType.RSHIFT_ASSIGN);
          }
          return this.makeToken(TokenType.RSHIFT);
        }
        if (this.peek() === 61) { // >=
          this.advance();
          return this.makeToken(TokenType.GTE);
        }
        return this.makeToken(TokenType.GT);

      case 61: // =
        if (this.peek() === 61 && this.peek(1) === 61) { // ===
          this.advance();
          this.advance();
          return this.makeToken(TokenType.EQ);
        }
        if (this.peek() === 61) { // ==
          throw this.error("loose equality '==' is not supported; use '==='");
        }
        if (this.peek() === 62) { // =>
          this.advance();
          return this.makeToken(TokenType.ARROW);
        }
        return this.makeToken(TokenType.ASSIGN);

      case 33: // !
        if (this.peek() === 61 && this.peek(1) === 61) { // !==
          this.advance();
          this.advance();
          return this.makeToken(TokenType.NEQ);
        }
        if (this.peek() === 61) { // !=
          throw this.error("loose equality '!=' is not supported; use '!=='");
        }
        return this.makeToken(TokenType.NOT);

      case 38: // &
        if (this.peek() === 38) { // &&
          this.advance();
          return this.makeToken(TokenType.AND);
        }
        if (this.peek() === 61) { // &=
          this.advance();
          return this.makeToken(TokenType.AMPERSAND_ASSIGN);
        }
        return this.makeToken(TokenType.AMPERSAND);

      case 124: // |
        if (this.peek() === 124) { // ||
          this.advance();
          return this.makeToken(TokenType.OR);
        }
        if (this.peek() === 61) { // |=
          this.advance();
          return this.makeToken(TokenType.PIPE_ASSIGN);
        }
        return this.makeToken(TokenType.PIPE);

      case 94: // ^
        if (this.peek() === 61) { // ^=
          this.advance();
          return this.makeToken(TokenType.CARET_ASSIGN);
        }
        return this.makeToken(TokenType.CARET);

      case 126: // ~
        return this.makeToken(TokenType.TILDE);

      case 63: // ?
        if (this.peek() === 63) { // ??
          this.advance();
          return this.makeToken(TokenType.QUESTION_QUESTION);
        }
        if (this.peek() === 46 && !this.isDigit(this.peek(1))) { // ?. (not ?.5 which would be ? .5)
          this.advance();
          return this.makeToken(TokenType.QUESTION_DOT);
        }
        return this.makeToken(TokenType.QUESTION);

      default:
        return this.makeToken(TokenType.INVALID,
          this.error(`Unexpected character '${String.fromCharCode(ch)}'`));
    }
  }

  /**
   * Peek at the next token without consuming it.
   */
  peekToken() {
    const savedPos = this.pos;
    const savedLine = this.line;
    const savedCol = this.col;
    const token = this.next();
    this.pos = savedPos;
    this.line = savedLine;
    this.col = savedCol;
    return token;
  }
}

/**
 * Semantic Error Translation for SandScript
 *
 * Translates raw interpreter error codes into human-readable,
 * context-aware error objects.
 */

import {
  ERR_UNDEFINED_VARIABLE,
  ERR_ASSIGN_UNDEFINED,
  ERR_NOT_CALLABLE,
  ERR_NOT_ITERABLE,
  ERR_PROPERTY_NULL,
  ERR_INVALID_OPERAND,
  ERR_STACK_OVERFLOW,
  ERR_TYPE_ERROR,
  ERR_ARITY,
  ERR_USER_THROW,
  ERR_MSGPACK_READONLY,
  ERR_MSGPACK_INVALID,
  ERR_NOT_SUPPORTED,
  NOT_SUPPORTED_FEATURE,
  ERR_REDECLARATION,
  ERR_CONST_ASSIGNMENT,
  ERR_GRANT_DENIED,
  ERR_RANGE_ERROR,
  ERR_SYNTAX_ERROR,
  ERR_JSON_PARSE,
  ERR_JSON_STRINGIFY,
  ERR_UNKNOWN_OPCODE,
  ERR_CORRUPT_OPERAND,
  ERR_HEAP_CODE_COLLISION,
  ERR_OUT_OF_MEMORY,
  BUILTIN_NAME,
  TYPE,
  STATE,
  errorCodeToString,
} from './constants.js';

const NOT_SUPPORTED_FEATURE_NAME = {
  [NOT_SUPPORTED_FEATURE.DELETE]: 'delete',
  [NOT_SUPPORTED_FEATURE.VOID]: 'void',
  [NOT_SUPPORTED_FEATURE.IN]: 'in',
  [NOT_SUPPORTED_FEATURE.REGEXP]:
    'RegExp construct (backreferences and lookaround are permanently excluded; the u and v flags are rejected)',
  [NOT_SUPPORTED_FEATURE.SCHEMA]:
    'Schema validation needing the IDNA tables (idn-hostname / idn-email labels are refused, never guessed)',
};

// Type tag to human-readable name
const TYPE_NAMES = {
  [TYPE.NULL]: 'null',
  [TYPE.UNDEFINED]: 'undefined',
  [TYPE.BOOLEAN]: 'boolean',
  [TYPE.INTEGER]: 'number',
  [TYPE.FLOAT]: 'number',
  [TYPE.STRING]: 'string',
  [TYPE.ARRAY]: 'array',
  [TYPE.OBJECT]: 'object',
  [TYPE.FUNCTION]: 'function',
  [TYPE.SCOPE]: 'scope',
  [TYPE.EXTERNAL]: 'external',
  [TYPE.MSGPACK_REF]: 'msgpack reference',
  [TYPE.BOUND_METHOD]: 'method',
  [TYPE.CONSTRUCTOR]: 'constructor',
  [TYPE.ARRAYBUFFER]: 'ArrayBuffer',
  [TYPE.BIGINT]: 'bigint',
  [TYPE.REGEXP]: 'RegExp',
  [TYPE.SCHEMA]: 'Schema',
  [TYPE.PROMISE_RESOLVE]: 'promise resolve',
  [TYPE.PROMISE_REJECT]: 'promise reject',
};

/**
 * Known unsupported globals with helpful hints
 */
// Globals here fall into two distinct categories:
//
// 1. Intrinsically unsupported globals: module-system, browser, and Node.js
//    APIs that the interpreter does not provide. JSON, Map, and Set do not
//    belong here because the interpreter binds them unconditionally.
//    `console` does belong here because it has no core binding.
//
// 2. Capability-gated globals: timers and Date under `grant "time"`, and
//    fetch under `grant "fetch"`. Time and network access cross the
//    interpreter boundary into host-provided services, so programs must
//    request them explicitly and the embedder must register a provider.
//    Without both pieces, the global is genuinely undefined; the hint must
//    identify the missing grant or provider rather than call the feature
//    unsupported.
const UNSUPPORTED_GLOBALS = {
  // Module system
  require: 'Module imports are not supported in the sandbox.',
  module: 'Module imports are not supported in the sandbox.',
  exports: 'Module imports are not supported in the sandbox.',
  import: 'Module imports are not supported in the sandbox.',

  // Browser APIs
  window: 'Browser APIs are not available. This is a pure computation sandbox.',
  document: 'Browser APIs are not available. This is a pure computation sandbox.',
  navigator: 'Browser APIs are not available. This is a pure computation sandbox.',
  localStorage: 'Browser APIs are not available. This is a pure computation sandbox.',
  sessionStorage: 'Browser APIs are not available. This is a pure computation sandbox.',
  location: 'Browser APIs are not available. This is a pure computation sandbox.',
  history: 'Browser APIs are not available. This is a pure computation sandbox.',
  alert: 'Browser APIs are not available. This is a pure computation sandbox.',

  // Node.js APIs
  process: 'Node.js APIs are not available. This is a pure computation sandbox.',
  Buffer: 'Node.js APIs are not available. This is a pure computation sandbox.',
  __dirname: 'Node.js APIs are not available. This is a pure computation sandbox.',
  __filename: 'Node.js APIs are not available. This is a pure computation sandbox.',
  global: 'Node.js APIs are not available. This is a pure computation sandbox.',

  // Timers and Date cross into a host-provided time service. Undefined here
  // means the program omitted `grant "time"` around the use or the embedder
  // did not register the capability.
  setTimeout: 'setTimeout requires `grant "time"` (or the host has not registered the time capability).',
  setInterval: 'setInterval requires `grant "time"` (or the host has not registered the time capability).',
  setImmediate: 'setImmediate is not supported — use setTimeout under `grant "time"`.',
  clearTimeout: 'clearTimeout requires `grant "time"` (or the host has not registered the time capability).',
  clearInterval: 'clearInterval requires `grant "time"` (or the host has not registered the time capability).',
  Date: 'Date requires `grant "time"` (or the host has not registered the time capability).',

  // fetch crosses into a host-provided network service and therefore needs
  // `grant "fetch"`. XMLHttpRequest and WebSocket have no capability form.
  fetch: 'fetch requires `grant "fetch"` (or the host has not registered the fetch capability).',
  XMLHttpRequest: 'Network APIs are not available in the sandbox.',
  WebSocket: 'Network APIs are not available in the sandbox.',

  // Other intrinsically unsupported globals.
  eval: 'eval is not supported for security reasons.',
  Function: 'Function constructor is not supported for security reasons.',
  Proxy: 'Proxy is not supported.',
  Reflect: 'Reflect is not supported.',
  Symbol: 'Symbol is not supported.',
  WeakMap: 'WeakMap is not supported.',
  WeakSet: 'WeakSet is not supported.',
  RegExp: 'RegExp is not supported.',

  // Unlike JSON, Map, and Set, console has no core global binding.
  console: "console is not available. Use 'get' to retrieve variable values from scope.",
};

/**
 * Convert type tag to human-readable name
 */
export function typeToString(typeTag) {
  return TYPE_NAMES[typeTag] ?? `unknown type (${typeTag})`;
}

/**
 * Translate a raw interpreter error into a semantic error object.
 *
 * @param {number} code - Error code from interpreter
 * @param {number} detail - Error detail from interpreter
 * @param {string} source - The source code that was executed
 * @param {object} mem - MemoryManipulator for string table access
 * @param {number} contextSlot - Context slot for reading completion value
 * @returns {object} Semantic error object
 */
export function translateError(code, detail, source, mem, contextSlot) {
  // Pull the PC of the failing instruction from error_info_base + 8.
  // The dispatcher stamps $current_executing_pc here on every set_error
  // (interpreter.wat). Used by ERR_UNKNOWN_OPCODE for diagnostics and
  // exposed on every result so callers can locate the failure site.
  let failPc = null;
  if (mem) {
    try {
      const errorInfoBase = mem.getErrorInfoBase();
      failPc = mem.view.getUint32(mem.abs(errorInfoBase + 8), true);
    } catch (_) {
      // ignore — diagnostic only
    }
  }

  const result = {
    // Raw values (always present)
    code,
    codeName: errorCodeToString(code),
    detail,
    failPc,

    // Semantic values (filled in below)
    type: 'Error',
    message: '',
    name: null,
    hint: null,
    line: null,
    column: null,
  };

  switch (code) {
    case ERR_UNDEFINED_VARIABLE: {
      result.type = 'ReferenceError';
      const varName = mem ? mem.readString(detail) : `(offset ${detail})`;
      result.name = varName;

      // Check for known unsupported globals
      if (UNSUPPORTED_GLOBALS[varName]) {
        result.message = `${varName} is not defined`;
        result.hint = UNSUPPORTED_GLOBALS[varName];
      } else {
        result.message = `${varName} is not defined`;
      }
      break;
    }

    case ERR_ASSIGN_UNDEFINED: {
      result.type = 'ReferenceError';
      const varName = mem ? mem.readString(detail) : `(offset ${detail})`;
      result.name = varName;
      result.message = `Cannot assign to undeclared variable '${varName}'`;
      result.hint = "Use 'let' to declare variables before assignment.";
      break;
    }

    case ERR_NOT_CALLABLE: {
      result.type = 'TypeError';
      // detail could be a type tag (0x00-0x0f) or a method_id (0x01+)
      // For type tags in valid range, show the type name
      if (detail <= 0x0f) {
        const typeName = typeToString(detail);
        result.message = `${typeName} is not a function`;
      } else {
        result.message = 'Value is not callable';
      }
      break;
    }

    case ERR_NOT_ITERABLE: {
      result.type = 'TypeError';
      const typeName = typeToString(detail);
      result.message = `${typeName} is not iterable`;
      result.hint = 'for...of loops require an array or iterable object.';
      break;
    }

    case ERR_PROPERTY_NULL: {
      result.type = 'TypeError';
      const typeName = typeToString(detail);
      result.message = `Cannot read properties of ${typeName}`;
      break;
    }

    case ERR_INVALID_OPERAND: {
      result.type = 'TypeError';
      if (detail <= 0x0f) {
        const typeName = typeToString(detail);
        result.message = `Invalid operand type: ${typeName}`;
      } else {
        result.message = 'Invalid operand';
      }
      break;
    }

    case ERR_UNKNOWN_OPCODE: {
      // detail is the byte the dispatcher fetched. If it's 0, the
      // bytecode was almost certainly corrupted (a heap allocation
      // wrote a tagged value on top of an instruction slot, and
      // TYPE.NULL = 0 / TYPE.UNDEFINED = 1 land in the opcode byte).
      // If non-zero but unrecognized, the compiler may have emitted
      // an undefined opcode.
      result.type = 'InternalError';
      const byte = `0x${(detail >>> 0).toString(16).padStart(2, '0')}`;
      const at = failPc !== null ? ` at instruction ${failPc}` : '';
      result.message = `Unknown opcode ${byte}${at}`;
      result.hint =
        'The bytecode region was likely corrupted by a heap allocation ' +
        'overrunning the code block. This indicates a bug in sandscript.';
      break;
    }

    case ERR_CORRUPT_OPERAND: {
      // A count operand (or a frame's argc) claimed more entries than
      // the structure it indexes actually holds — e.g. a
      // RECONCILE_PARAMS paramCount above MAX_PARAMETER_COUNT, or a
      // MAKE_ARRAY count exceeding the operand stack depth. The parser
      // never emits these; the code block (or a call frame) was
      // corrupted. Same fault class as ERR_UNKNOWN_OPCODE.
      result.type = 'InternalError';
      const at = failPc !== null ? ` at instruction ${failPc}` : '';
      result.message = `Corrupt operand ${detail}${at}`;
      result.hint =
        'A bytecode operand (or call-frame argument count) is ' +
        'inconsistent with interpreter state — the code block was ' +
        'likely corrupted. This indicates a bug in sandscript.';
      break;
    }

    case ERR_STACK_OVERFLOW: {
      result.type = 'RangeError';
      result.message = 'Maximum call stack size exceeded';
      result.hint = 'Check for infinite recursion in your code.';
      break;
    }

    case ERR_TYPE_ERROR: {
      result.type = 'TypeError';
      if (detail === 0) {
        result.message = 'Type error';
      } else if (detail <= 0x0f) {
        const typeName = typeToString(detail);
        result.message = `Unexpected type: ${typeName}`;
      } else {
        result.message = 'Type error';
      }
      break;
    }

    case ERR_ARITY: {
      result.type = 'TypeError';
      result.message = `Expected ${detail} argument${detail !== 1 ? 's' : ''}`;
      break;
    }

    case ERR_USER_THROW: {
      result.type = 'Error';
      result.message = 'Uncaught exception';
      // Try to read the thrown value from completion value slot
      if (mem) {
        try {
          const completionPtr = mem.getContextCompletionValue(contextSlot);
          if (completionPtr) {
            // Read raw value to check if it's an error object
            const absPtr = mem.abs(completionPtr);
            const valueType = mem.view.getUint32(absPtr, true);
            const dataLo = mem.view.getUint32(absPtr + 8, true);

            if (valueType === TYPE.OBJECT && dataLo !== 0) {
              // Classify by walking the prototype chain (bounded), so a
              // derived error class reports its family instead of the
              // plain-Error fallback a direct identity compare gave.
              const familyByProto = new Map([
                [mem.view.getUint32(mem.abs(STATE.TYPE_ERROR_PROTOTYPE), true), 'TypeError'],
                [mem.view.getUint32(mem.abs(STATE.RANGE_ERROR_PROTOTYPE), true), 'RangeError'],
                [mem.view.getUint32(mem.abs(STATE.REFERENCE_ERROR_PROTOTYPE), true), 'ReferenceError'],
                [mem.view.getUint32(mem.abs(STATE.SYNTAX_ERROR_PROTOTYPE), true), 'SyntaxError'],
                [mem.view.getUint32(mem.abs(STATE.ERROR_PROTOTYPE), true), 'Error'],
              ]);
              let cursor = mem.view.getUint32(mem.abs(dataLo) + 8, true);
              for (let depth = 0; depth < 32 && cursor !== 0; depth++) {
                const family = familyByProto.get(cursor);
                if (family) {
                  result.type = family;
                  result.name = family;
                  break;
                }
                cursor = mem.view.getUint32(mem.abs(cursor) + 8, true);
              }

              // Read the error object's properties for rich context
              const thrownValue = mem.readValueAt(completionPtr);
              const staticMessage = (thrownValue && typeof thrownValue === 'object') ? thrownValue.message : null;

              // An own `name` string (a derived class's `name = '...'`
              // field) overrides the family name in the diagnostic.
              if (thrownValue && typeof thrownValue === 'object'
                  && typeof thrownValue.name === 'string' && thrownValue.name) {
                result.name = thrownValue.name;
              }

              if (staticMessage) {
                // Has a message — use it as base, then try to enrich with extra properties
                result.message = staticMessage;

                // Read extra context properties for detailed uncaught messages
                const offsetVal = (thrownValue && typeof thrownValue === 'object') ? thrownValue.offset : undefined;
                const bufferLengthVal = (thrownValue && typeof thrownValue === 'object') ? thrownValue.bufferLength : undefined;
                const elementSizeVal = (thrownValue && typeof thrownValue === 'object') ? thrownValue.elementSize : undefined;
                const typeVal = (thrownValue && typeof thrownValue === 'object') ? thrownValue.type : undefined;
                const identifierVal = (thrownValue && typeof thrownValue === 'object') ? thrownValue.identifier : undefined;

                if (result.type === 'RangeError' && offsetVal !== undefined) {
                  result.message = `Offset ${offsetVal} is outside the bounds of the DataView (${elementSizeVal}-byte access, buffer length ${bufferLengthVal})`;
                } else if (result.type === 'TypeError' && typeVal !== undefined) {
                  const typeName = typeToString(typeVal);
                  result.message = `${staticMessage} (received ${typeName})`;
                  // WAT sites that record the offending value's data_lo
                  // (valueLo) let a post-mortem heap walk identify WHICH
                  // object sat in the slot.
                  const valueLoVal = (thrownValue && typeof thrownValue === 'object') ? thrownValue.valueLo : undefined;
                  if (valueLoVal !== undefined) {
                    result.message += ` valueLo=${valueLoVal}`;
                  }
                } else if (result.type === 'ReferenceError' && identifierVal !== undefined) {
                  result.message = `${identifierVal} is not defined`;
                }
              } else {
                // No message — old-style error object or empty message
                switch (result.type) {
                  case 'RangeError':
                    result.message = 'Index out of bounds or invalid alignment';
                    break;
                  case 'TypeError':
                    result.message = 'Invalid operation for type';
                    break;
                  case 'ReferenceError':
                    result.message = 'Undefined reference';
                    break;
                  default:
                    result.message = 'Uncaught exception';
                }
              }
            } else {
              const thrownValue = mem.readValueAt(completionPtr);
              if (typeof thrownValue === 'string') {
                result.message = thrownValue;
              } else if (thrownValue !== null && thrownValue !== undefined) {
                result.message = `Uncaught: ${String(thrownValue)}`;
              }
            }
          }
        } catch (e) {
          // Ignore read errors, keep generic message
        }
      }
      break;
    }

    case ERR_RANGE_ERROR: {
      result.type = 'RangeError';
      result.name = 'RangeError';
      result.message = 'Value out of range';
      break;
    }

    case ERR_SYNTAX_ERROR: {
      result.type = 'SyntaxError';
      result.name = 'SyntaxError';
      result.message = 'Invalid BigInt syntax';
      break;
    }

    case ERR_JSON_PARSE: {
      result.type = 'SyntaxError';
      result.name = 'SyntaxError';
      if (detail > 0) {
        result.message = `Unexpected token at position ${detail}`;
      } else {
        result.message = 'Unexpected end of JSON input';
      }
      break;
    }

    case ERR_JSON_STRINGIFY: {
      result.type = 'TypeError';
      result.name = 'TypeError';
      result.message = 'Converting circular structure to JSON';
      break;
    }

    case ERR_MSGPACK_READONLY: {
      result.type = 'TypeError';
      result.message = 'Cannot modify read-only data';
      result.hint = 'External data passed to the sandbox is immutable.';
      break;
    }

    case ERR_MSGPACK_INVALID: {
      result.type = 'Error';
      result.message = 'Invalid data format';
      // detail is a debug code 0-21 indicating where parsing failed
      break;
    }

    case ERR_NOT_SUPPORTED: {
      result.type = 'TypeError';
      if (detail === NOT_SUPPORTED_FEATURE.MATH_RANDOM) {
        result.message = 'Math.random is unavailable because the interpreter has no implicit time or entropy source';
        result.hint = 'Provide randomness through an explicit host capability.';
        break;
      }
      const featureName = NOT_SUPPORTED_FEATURE_NAME[detail];
      if (featureName) {
        result.message = `'${featureName}' is not yet implemented`;
        result.hint = `The '${featureName}' operator parses correctly but ` +
          'has no interpreter support yet.';
      } else {
        result.message = 'Operation not supported';
        result.hint = 'Some JavaScript features are not available in the sandbox.';
      }
      break;
    }

    case ERR_REDECLARATION: {
      result.type = 'SyntaxError';
      const varName = mem ? mem.readString(detail) : `(offset ${detail})`;
      result.name = varName;
      result.message = `Identifier '${varName}' has already been declared`;
      break;
    }

    case ERR_CONST_ASSIGNMENT: {
      result.type = 'TypeError';
      const varName = mem ? mem.readString(detail) : `(offset ${detail})`;
      result.name = varName;
      result.message = `Assignment to constant variable '${varName}'`;
      break;
    }

    case ERR_GRANT_DENIED: {
      result.type = 'GrantDeniedError';
      result.message = 'External call requires a grant not in the current grant stack';
      result.hint = 'Wrap the call in a grant block: grant "identifier" { ... }';
      break;
    }

    case ERR_OUT_OF_MEMORY: {
      result.type = 'RangeError';
      result.message = 'Out of memory';
      result.hint =
        'The interpreter refused an allocation that does not fit in the ' +
        'heap, string table, or stacks. Vat integrity is intact. The ' +
        'host should run GC or grow the segment.';
      break;
    }

    case ERR_HEAP_CODE_COLLISION: {
      // The dispatcher's per-instruction collision backstop: the heap
      // pointer reached the code pointer, meaning some carve wrote
      // through the entire slack red zone without a guard — bytecode
      // is likely already overwritten. A vat fault, not an allocation
      // refusal.
      result.type = 'InternalError';
      const at = failPc !== null ? ` at instruction ${failPc}` : '';
      result.message = `Heap collided with code block${at}`;
      result.hint =
        'A heap allocation wrote through the slack red zone into the ' +
        'bytecode region — the code block is likely corrupt. This ' +
        'indicates a bug in sandscript.';
      break;
    }

    default: {
      result.type = 'Error';
      result.message = `Unknown error (code=${code}, detail=${detail})`;
      break;
    }
  }

  return result;
}

/**
 * Parse a parser SyntaxError into a semantic error object.
 *
 * Parser errors have format: "{message} at line {line}, col {col}"
 *
 * @param {Error} error - SyntaxError from parser
 * @returns {object} Semantic error object
 */
export function translateParserError(error) {
  const result = {
    code: -1,  // Parser errors don't have numeric codes
    detail: 0,
    type: 'SyntaxError',
    message: error.message,
    name: null,
    hint: null,
    line: null,
    column: null,
  };

  // Parse "message at line N, col M" format
  const match = error.message.match(/^(.+) at line (\d+), col (\d+)$/);
  if (match) {
    result.message = match[1];
    result.line = parseInt(match[2], 10);
    result.column = parseInt(match[3], 10);
  }

  // Add hints for common parser errors
  if (result.message.includes("'break' outside of loop")) {
    result.hint = "'break' can only be used inside a loop.";
  } else if (result.message.includes("'continue' outside of loop")) {
    result.hint = "'continue' can only be used inside a loop.";
  } else if (result.message.includes("Expected '=>'")) {
    result.hint = 'Arrow function syntax: (params) => expression or (params) => { statements }';
  }

  return result;
}

/**
 * Format a semantic error object as a human-readable string.
 *
 * @param {object} error - Semantic error object
 * @returns {string} Formatted error message
 */
export function formatError(error) {
  let msg = `${error.type}: ${error.message}`;

  if (error.line !== null && error.column !== null) {
    msg += ` (line ${error.line}, col ${error.column})`;
  }

  if (error.hint) {
    msg += `\n\nHint: ${error.hint}`;
  }

  return msg;
}

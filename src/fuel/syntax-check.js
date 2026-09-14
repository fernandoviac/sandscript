/**
 * Standalone parse-only syntax check.
 *
 * Runs source through the normal parser via a throwaway session, with no
 * compilation to WAT and no execution. Lets a caller ask "does this parse?"
 * without spending a deploy/run cycle on it.
 */

import { freshSession } from '../host-owned-session.js';
import { ParseError } from '../runtime/errors.js';

/**
 * @param {string} source
 * @returns {{ok: true} | {ok: false, type: string, message: string, line: number|null, column: number|null, hint: string|null}}
 */
export function checkSyntax(source) {
  const session = freshSession();
  try {
    session.parse(source);
    return { ok: true };
  } catch (e) {
    if (e instanceof ParseError) {
      const { type, message, line, column, hint } = e.semanticError;
      return { ok: false, type, message, line, column, hint };
    }
    throw e;
  }
}

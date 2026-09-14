/**
 * Repro test for the dispatch_builtin_method throw-loop bug.
 *
 * BUG (pre-existing, surfaced during heap-pressure slice 3c):
 * Many branches of $dispatch_builtin_method handled uncaught throws
 * with the buggy pattern:
 *
 *     (drop (call $throw_type_error))
 *     (return (i32.const 1))
 *
 * This DROPS the throw helper's return value (which signals
 * caught-vs-uncaught) and always returns 1 to $run's OP_CALL_METHOD
 * dispatch. OP_CALL_METHOD interprets return value 1 as "exception
 * caught — reload pc from CTX_INSTRUCTION_INDEX and br $loop." With
 * no actual catch handler, the pc still points at the failing
 * CALL_METHOD, so execution loops indefinitely, allocating a fresh
 * error object on each iteration. Under tight heap (or any
 * heap-pressure pre-check) this surfaces as memory_pressure or
 * ERR_OUT_OF_MEMORY rather than the user-thrown TypeError.
 *
 * FIX: replace each buggy site with the proper convention used
 * elsewhere in the file:
 *
 *     (if (call $throw_type_error)
 *       (then (return (i32.const 2)))  ;; uncaught — exit
 *       (else (return (i32.const 1)))  ;; caught — reload pc
 *     )
 *
 * This test exercises one specific case (Expression.add with a
 * non-symbolic arg) but the fix applies to all
 * $dispatch_builtin_method branches that used the `drop` pattern.
 */

import { assertEquals, assertThrows } from 'https://deno.land/std@0.208.0/assert/mod.ts';
import { freshSession } from '../../src/host-owned-session.js';
import { parseAndSetup } from './test-helpers.js';
import { UncaughtScriptError } from '../../src/runtime/errors.js';

Deno.test('session.run with big fuel terminates cleanly on TypeError, does not OOM', () => {
  const session = freshSession();
  parseAndSetup(session, 'let x = Exact.Expression.add(1.5, Exact.Pi);');
  const err = assertThrows(() => session.run(0, 1_000_000), UncaughtScriptError);
  assertEquals(err.scriptError.message, 'Invalid operation for type');
});

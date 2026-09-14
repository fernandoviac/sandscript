/**
 * Shared test helpers for fuel tests.
 */

/**
 * Parse source code and set up execution state.
 * This is the standard way to prepare for running after parse().
 */
export function parseAndSetup(session, source, slot = 0) {
  const result = session.parse(source);
  session.mem.setContextInstructionIndex(slot, result.startIndex);
  session.mem.clearExitCondition(slot);
  return result;
}

/**
 * Parse and run in one call.
 */
export function parseAndRun(session, source, slot = 0, fuel = 10000) {
  parseAndSetup(session, source, slot);
  return session.run(slot, fuel);
}

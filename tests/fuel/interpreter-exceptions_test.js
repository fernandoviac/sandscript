/**
 * Test interpreter exceptions: try/catch/finally.
 *
 * Run with: deno task test tests/fuel/interpreter-exceptions_test.js
 */

import {
  assertNumericResult,
  assertErrorCode,
} from './interpreter-test-utils.js';

// =============================================================================
// Throw Without Handler
// =============================================================================

Deno.test("Exception: throw without handler", () => {
  assertErrorCode('throw 42', 12); // ERR_USER_THROW
});

// =============================================================================
// Basic Try-Catch
// =============================================================================

Deno.test("Exception: basic try-catch", () => {
  assertNumericResult(`
    let x = 0
    try {
      throw 42
    } catch (e) {
      x = e
    }
  `, 'x', 42);
});

Deno.test("Exception: try-catch no throw", () => {
  assertNumericResult(`
    let x = 1
    try {
      x = 2
    } catch (e) {
      x = 3
    }
  `, 'x', 2);
});

// =============================================================================
// Try-Finally
// =============================================================================

Deno.test("Exception: try-finally normal", () => {
  assertNumericResult(`
    let x = 1
    try {
      x = 2
    } finally {
      x = x + 10
    }
  `, 'x', 12);
});

Deno.test("Exception: nested finally preserves uncaught engine error metadata", () => {
  assertErrorCode(`
    const value = 1
    try {
      try {
        value = 2
      } finally {
        let innerCleanupRan = true
      }
    } finally {
      let outerCleanupRan = true
    }
  `, 19); // ERR_CONST_ASSIGNMENT
});

// =============================================================================
// Try-Catch-Finally
// =============================================================================

Deno.test("Exception: try-catch-finally", () => {
  assertNumericResult(`
    let x = 0
    try {
      throw 5
    } catch (e) {
      x = e
    } finally {
      x = x + 100
    }
  `, 'x', 105);
});

// =============================================================================
// Nested Try-Catch
// =============================================================================

Deno.test("Exception: nested try-catch", () => {
  assertNumericResult(`
    let x = 0
    try {
      try {
        throw 1
      } catch (e) {
        x = e
        throw 2
      }
    } catch (e) {
      x = x + e
    }
  `, 'x', 3);
});

// =============================================================================
// Cross-Function Throw
// =============================================================================

Deno.test("Exception: cross-function throw", () => {
  assertNumericResult(`
    let x = 0
    let f = () => {
      throw 42
    }
    try {
      f()
    } catch (e) {
      x = e
    }
  `, 'x', 42);
});

// =============================================================================
// Finally Runs on Throw
// =============================================================================

Deno.test("Exception: finally runs on throw", () => {
  assertNumericResult(`
    let x = 0
    try {
      try {
        throw 1
      } finally {
        x = 100
      }
    } catch (e) {
      x = x + e
    }
  `, 'x', 101);
});

// =============================================================================
// Return in Try with Finally
// =============================================================================

Deno.test("Exception: return in try with finally", () => {
  assertNumericResult(`
    let x = 0
    let f = () => {
      try {
        x = 1
        return 42
      } finally {
        x = x + 10
      }
    }
    f()
  `, 'x', 11);
});

// =============================================================================
// Multiple Catches
// =============================================================================

Deno.test("Exception: rethrow in catch", () => {
  assertNumericResult(`
    let x = 0
    try {
      try {
        throw 5
      } catch (e) {
        x = e
        throw e + 10
      }
    } catch (e) {
      x = e
    }
  `, 'x', 15);
});

Deno.test("Exception: catch different values", () => {
  assertNumericResult(`
    let x = 0
    try {
      throw 100
    } catch (e) {
      x = e
    }
  `, 'x', 100);
});

// =============================================================================
// Finally Always Runs
// =============================================================================

Deno.test("Exception: finally runs after catch", () => {
  assertNumericResult(`
    let x = 0
    try {
      throw 1
    } catch (e) {
      x = e
    } finally {
      x = x * 10
    }
  `, 'x', 10);
});

Deno.test("Exception: finally runs without catch", () => {
  assertNumericResult(`
    let x = 1
    try {
      x = 2
    } finally {
      x = x + 100
    }
  `, 'x', 102);
});

// =============================================================================
// Deeply Nested
// =============================================================================

Deno.test("Exception: deeply nested try-catch", () => {
  assertNumericResult(`
    let x = 0
    try {
      try {
        try {
          throw 1
        } catch (e) {
          throw e + 1
        }
      } catch (e) {
        throw e + 1
      }
    } catch (e) {
      x = e
    }
  `, 'x', 3);
});

// =============================================================================
// Throw String
// =============================================================================

Deno.test("Exception: throw string", () => {
  assertNumericResult(`
    let x = 0
    try {
      throw "error"
    } catch (e) {
      if (e === "error") {
        x = 1
      }
    }
  `, 'x', 1);
});

// =============================================================================
// Throw in Finally
// =============================================================================

Deno.test("Exception: throw in finally overrides", () => {
  assertNumericResult(`
    let x = 0
    try {
      try {
        throw 1
      } finally {
        throw 2
      }
    } catch (e) {
      x = e
    }
  `, 'x', 2);
});

# Math Function Tests

These tests verify that SandScript's transcendental math functions produce
**bit-for-bit identical results** to JavaScript's Math functions.

## Why So Many Tests?

The fdlibm (Freely Distributable LIBM) algorithms used by V8/JavaScript engines
have **different code paths for different input ranges**. Each range uses
optimized polynomial approximations tuned for that specific domain.

For example, `Math.sin` uses:
- Direct polynomial for very small values (|x| < 2^-27)
- Minimax polynomial for |x| < π/4
- Argument reduction + kernel functions for larger values
- Special handling for Infinity, NaN, and denormals

This means a bug could exist in one range while other ranges work perfectly.
**Every single test value exercises a different code path.**

## Test Value Categories

### Sentinel Values (0, -1, 1, 2, Infinity, NaN)
Boundary cases with special handling in fdlibm. These often have early-exit
fast paths or edge-case logic that must be verified independently.

### Range Values
- `SANITY_VALUE` (0.566...) - Exercises the primary polynomial range
- `SANITY_NEG` (-0.707...) - Exercises negative value handling
- `SANITY_GT1` (1.865...) - Values > 1 for functions like acos, atanh
- `SANITY_LARGE` (18023...) - Large values requiring argument reduction

## Exact Match Requirement

These tests require **exact floating-point equality**, not approximate equality.
SandScript ports the same fdlibm algorithms that V8 uses, so results must match
bit-for-bit. Any deviation indicates a porting error.

## Files

- `test-fdlibm-ranges.js` - Range-specific tests for all transcendental functions
- `test-fdlibm-sentinels.js` - Sentinel value tests (0, -1, 1, 2, Infinity, NaN)

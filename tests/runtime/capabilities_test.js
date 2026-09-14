/**
 * Pure-function tests for capability resolution and topo
 * ordering. No engine, no airlock, no scheduler — these
 * exercise `src/runtime/capabilities.js` in isolation.
 *
 * Run with: deno task test tests/runtime/capabilities_test.js
 */

import { assertEquals, assert, assertThrows } from "https://deno.land/std@0.208.0/assert/mod.ts";
import {
  validateCapabilities,
  orderCapabilities,
  validateAndOrderCapabilities,
  normalizeNeedSpec,
} from '../../src/runtime/capabilities.js';
import {
  MissingDependencyError,
  CapabilityCycleError,
  DuplicateCapabilityNameError,
  RuntimeBootError,
} from '../../src/runtime/errors.js';

const NOOP_SETUP = () => {};

// =============================================================================
// validateCapabilities
// =============================================================================

Deno.test("validateCapabilities: empty list passes", () => {
  validateCapabilities([], {}, {});
});

Deno.test("validateCapabilities: rejects non-array capabilities", () => {
  assertThrows(() => validateCapabilities('not-array', {}, {}),
    RuntimeBootError, 'capabilities must be an array');
});

Deno.test("validateCapabilities: rejects missing setup function", () => {
  assertThrows(() => validateCapabilities([{ name: 'x' }], {}, {}),
    RuntimeBootError, "capability 'x' missing setup function");
});

Deno.test("validateCapabilities: rejects empty name", () => {
  assertThrows(() => validateCapabilities([{ name: '', setup: NOOP_SETUP }], {}, {}),
    RuntimeBootError, 'capability missing string .name');
});

Deno.test("validateCapabilities: rejects duplicate names", () => {
  const caps = [
    { name: 'foo', setup: NOOP_SETUP },
    { name: 'foo', setup: NOOP_SETUP },
  ];
  assertThrows(() => validateCapabilities(caps, {}, {}),
    DuplicateCapabilityNameError, "'foo' was supplied more than once");
});

Deno.test("validateCapabilities: rejects unknown need kind", () => {
  const caps = [{
    name: 'x',
    setup: NOOP_SETUP,
    needs: { foo: 'mystery-kind' },
  }];
  assertThrows(() => validateCapabilities(caps, {}, {}),
    RuntimeBootError, "unknown kind 'mystery-kind'");
});

Deno.test("validateCapabilities: rejects missing host-service", () => {
  const caps = [{ name: 'x', setup: NOOP_SETUP, needs: { foo: 'host-service' } }];
  const err = assertThrows(
    () => validateCapabilities(caps, {}, {}),
    MissingDependencyError);
  assertEquals(err.capabilityName, 'x');
  assertEquals(err.depKind, 'host-service');
  assertEquals(err.depName, 'foo');
});

Deno.test("validateCapabilities: rejects missing subsystem", () => {
  const caps = [{ name: 'x', setup: NOOP_SETUP, needs: { foo: 'subsystem' } }];
  assertThrows(() => validateCapabilities(caps, {}, {}),
    MissingDependencyError);
});

Deno.test("validateCapabilities: rejects missing capability dep", () => {
  const caps = [{ name: 'x', setup: NOOP_SETUP, needs: { foo: 'capability' } }];
  assertThrows(() => validateCapabilities(caps, {}, {}),
    MissingDependencyError);
});

Deno.test("validateCapabilities: accepts capability dep that exists", () => {
  const caps = [
    { name: 'foo', setup: NOOP_SETUP },
    { name: 'bar', setup: NOOP_SETUP, needs: { foo: 'capability' } },
  ];
  validateCapabilities(caps, {}, {});
});

Deno.test("validateCapabilities: accepts { kind, name } long form", () => {
  const caps = [{
    name: 'x',
    setup: NOOP_SETUP,
    needs: { clock: { kind: 'host-service', name: 'system-clock' } },
  }];
  validateCapabilities(caps, { 'system-clock': () => 0 }, {});
});

// =============================================================================
// orderCapabilities
// =============================================================================

Deno.test("orderCapabilities: empty input → empty output", () => {
  assertEquals(orderCapabilities([]), []);
});

Deno.test("orderCapabilities: no dependencies → original order preserved (input-order tiebreak)", () => {
  const a = { name: 'a', setup: NOOP_SETUP };
  const b = { name: 'b', setup: NOOP_SETUP };
  const c = { name: 'c', setup: NOOP_SETUP };
  const ordered = orderCapabilities([a, b, c]);
  assertEquals(ordered.map(x => x.name), ['a', 'b', 'c']);
});

Deno.test("orderCapabilities: dependency before dependent", () => {
  const a = { name: 'a', setup: NOOP_SETUP };
  const b = { name: 'b', setup: NOOP_SETUP, needs: { a: 'capability' } };
  const ordered = orderCapabilities([b, a]);
  assertEquals(ordered.map(x => x.name), ['a', 'b']);
});

Deno.test("orderCapabilities: diamond resolves correctly", () => {
  // a → b, a → c, b → d, c → d.   d should come first.
  const d = { name: 'd', setup: NOOP_SETUP, needs: { b: 'capability', c: 'capability' } };
  const c = { name: 'c', setup: NOOP_SETUP, needs: { a: 'capability' } };
  const b = { name: 'b', setup: NOOP_SETUP, needs: { a: 'capability' } };
  const a = { name: 'a', setup: NOOP_SETUP };
  const ordered = orderCapabilities([d, c, b, a]);
  const positions = Object.fromEntries(ordered.map((x, i) => [x.name, i]));
  assert(positions.a < positions.b);
  assert(positions.a < positions.c);
  assert(positions.b < positions.d);
  assert(positions.c < positions.d);
});

Deno.test("orderCapabilities: detects two-node cycle", () => {
  const a = { name: 'a', setup: NOOP_SETUP, needs: { b: 'capability' } };
  const b = { name: 'b', setup: NOOP_SETUP, needs: { a: 'capability' } };
  const err = assertThrows(() => orderCapabilities([a, b]), CapabilityCycleError);
  assert(err.cycle.includes('a'));
  assert(err.cycle.includes('b'));
});

Deno.test("orderCapabilities: detects self-cycle", () => {
  const a = { name: 'a', setup: NOOP_SETUP, needs: { a: 'capability' } };
  const err = assertThrows(() => orderCapabilities([a]), CapabilityCycleError);
  assertEquals(err.cycle, ['a', 'a']);
});

Deno.test("orderCapabilities: detects three-node cycle", () => {
  const a = { name: 'a', setup: NOOP_SETUP, needs: { b: 'capability' } };
  const b = { name: 'b', setup: NOOP_SETUP, needs: { c: 'capability' } };
  const c = { name: 'c', setup: NOOP_SETUP, needs: { a: 'capability' } };
  assertThrows(() => orderCapabilities([a, b, c]), CapabilityCycleError);
});

Deno.test("orderCapabilities: ignores host-service / subsystem in topo (not capability edges)", () => {
  // a needs a host-service 'foo'; b is independent. Order
  // should be just input order — no cap-cap edges.
  const a = { name: 'a', setup: NOOP_SETUP, needs: { foo: 'host-service' } };
  const b = { name: 'b', setup: NOOP_SETUP };
  const ordered = orderCapabilities([a, b]);
  assertEquals(ordered.map(x => x.name), ['a', 'b']);
});

// =============================================================================
// validateAndOrderCapabilities
// =============================================================================

Deno.test("validateAndOrderCapabilities: end-to-end success", () => {
  const a = { name: 'a', setup: NOOP_SETUP };
  const b = {
    name: 'b',
    setup: NOOP_SETUP,
    needs: { a: 'capability', clock: 'host-service' },
  };
  const ordered = validateAndOrderCapabilities([b, a], { clock: 0 }, {});
  assertEquals(ordered.map(x => x.name), ['a', 'b']);
});

Deno.test("normalizeNeedSpec: bare string form", () => {
  assertEquals(normalizeNeedSpec('clock', 'host-service'),
    { kind: 'host-service', name: 'clock' });
});

Deno.test("normalizeNeedSpec: object form with explicit name", () => {
  assertEquals(normalizeNeedSpec('clock', { kind: 'host-service', name: 'sys-clock' }),
    { kind: 'host-service', name: 'sys-clock' });
});

Deno.test("normalizeNeedSpec: object form without name defaults to key", () => {
  assertEquals(normalizeNeedSpec('clock', { kind: 'host-service' }),
    { kind: 'host-service', name: 'clock' });
});

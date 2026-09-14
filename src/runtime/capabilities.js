/**
 * Capability resolution and topological ordering.
 *
 * `validateCapabilities` checks structural shape, name
 * uniqueness, and need-source presence.
 *
 * `orderCapabilities` produces a setup-execution order
 * honoring 'capability'-kind needs as dependencies. Cycles
 * raise `CapabilityCycleError` with the offending names.
 *
 * Both are pure functions, no engine/airlock access — they
 * operate on the constructor's input alone. This makes them
 * trivially unit-testable.
 */

import {
  MissingDependencyError,
  CapabilityCycleError,
  DuplicateCapabilityNameError,
  RuntimeBootError,
} from './errors.js';

const VALID_KINDS = new Set(['host-service', 'subsystem', 'capability']);

/**
 * Validate the structural shape of the capability list.
 * Throws `RuntimeBootError`-family errors. Returns nothing.
 *
 * @param {Array} capabilities
 * @param {Object} hostServices
 * @param {Object} subsystems
 */
export function validateCapabilities(capabilities, hostServices, subsystems) {
  if (!Array.isArray(capabilities)) {
    throw new RuntimeBootError(
      `capabilities must be an array, got ${typeof capabilities}`,
      { phase: 'validate' });
  }
  if (!hostServices || typeof hostServices !== 'object') {
    throw new RuntimeBootError(
      `hostServices must be an object, got ${typeof hostServices}`,
      { phase: 'validate' });
  }
  if (!subsystems || typeof subsystems !== 'object') {
    throw new RuntimeBootError(
      `subsystems must be an object, got ${typeof subsystems}`,
      { phase: 'validate' });
  }

  const seenNames = new Set();
  const nameToCap = new Map();

  for (const cap of capabilities) {
    if (!cap || typeof cap !== 'object') {
      throw new RuntimeBootError(
        `capability list contained non-object: ${cap}`,
        { phase: 'validate' });
    }
    if (typeof cap.name !== 'string' || cap.name.length === 0) {
      throw new RuntimeBootError(
        `capability missing string .name`,
        { phase: 'validate' });
    }
    if (typeof cap.setup !== 'function') {
      throw new RuntimeBootError(
        `capability '${cap.name}' missing setup function`,
        { phase: 'validate' });
    }
    if (seenNames.has(cap.name)) {
      throw new DuplicateCapabilityNameError(cap.name);
    }
    seenNames.add(cap.name);
    nameToCap.set(cap.name, cap);

    const needs = cap.needs ?? {};
    if (typeof needs !== 'object' || Array.isArray(needs)) {
      throw new RuntimeBootError(
        `capability '${cap.name}' has invalid .needs (must be object)`,
        { phase: 'validate' });
    }
    for (const [needKey, needSpec] of Object.entries(needs)) {
      // Two forms supported:
      //   key: 'kind'             — name === key
      //   key: { kind, name? }    — name defaults to key
      let kind, depName;
      if (typeof needSpec === 'string') {
        kind = needSpec;
        depName = needKey;
      } else if (needSpec && typeof needSpec === 'object') {
        kind = needSpec.kind;
        depName = needSpec.name ?? needKey;
      } else {
        throw new RuntimeBootError(
          `capability '${cap.name}' need '${needKey}' has invalid spec`,
          { phase: 'validate' });
      }
      if (!VALID_KINDS.has(kind)) {
        throw new RuntimeBootError(
          `capability '${cap.name}' need '${needKey}' has unknown kind '${kind}' ` +
          `(must be one of: ${[...VALID_KINDS].join(', ')})`,
          { phase: 'validate' });
      }
    }
  }

  // Resolve every need against its source. Capability-kind needs are
  // checked against the name set built above; the other two against the
  // supplied maps.
  for (const cap of capabilities) {
    const needs = cap.needs ?? {};
    for (const [needKey, needSpec] of Object.entries(needs)) {
      const { kind, name } = normalizeNeedSpec(needKey, needSpec);
      if (kind === 'host-service' && !(name in hostServices)) {
        throw new MissingDependencyError(cap.name, needKey, kind, name);
      }
      if (kind === 'subsystem' && !(name in subsystems)) {
        throw new MissingDependencyError(cap.name, needKey, kind, name);
      }
      if (kind === 'capability' && !nameToCap.has(name)) {
        throw new MissingDependencyError(cap.name, needKey, kind, name);
      }
    }
  }
}

/**
 * Normalize a `needs` entry into `{ kind, name }`. Accepts
 * either a bare string (the kind) — name defaults to the key
 * — or a `{ kind, name? }` object.
 *
 * @returns {{ kind: string, name: string }}
 */
export function normalizeNeedSpec(needKey, needSpec) {
  if (typeof needSpec === 'string') {
    return { kind: needSpec, name: needKey };
  }
  return { kind: needSpec.kind, name: needSpec.name ?? needKey };
}

/**
 * Topologically order capabilities so each one is set up
 * after its `'capability'`-kind dependencies. Returns a new
 * array; does not mutate the input.
 *
 * Detects cycles and raises `CapabilityCycleError` with the
 * cycle path.
 *
 * @param {Array} capabilities
 * @returns {Array} ordered capabilities
 */
export function orderCapabilities(capabilities) {
  const byName = new Map();
  for (const cap of capabilities) byName.set(cap.name, cap);

  // Iterative DFS with WHITE/GRAY/BLACK coloring.
  const WHITE = 0, GRAY = 1, BLACK = 2;
  const color = new Map();
  const order = [];
  const stack = []; // explicit stack of { capName, edges, edgeIndex, pathIndex }
  const path = []; // current DFS path (capability names), for cycle reporting

  for (const cap of capabilities) color.set(cap.name, WHITE);

  for (const root of capabilities) {
    if (color.get(root.name) !== WHITE) continue;
    stack.push({
      capName: root.name,
      edges: capabilityEdges(root),
      edgeIndex: 0,
      pathIndex: path.length,
    });
    color.set(root.name, GRAY);
    path.push(root.name);

    while (stack.length > 0) {
      const frame = stack[stack.length - 1];
      if (frame.edgeIndex >= frame.edges.length) {
        // All outgoing edges explored; commit this node.
        color.set(frame.capName, BLACK);
        order.push(byName.get(frame.capName));
        path.pop();
        stack.pop();
        continue;
      }
      const childName = frame.edges[frame.edgeIndex++];
      const childColor = color.get(childName) ?? WHITE;
      if (childColor === BLACK) continue;
      if (childColor === GRAY) {
        // Found a back-edge — cycle. Build cycle path from
        // first occurrence of childName onward.
        const cycleStart = path.indexOf(childName);
        const cycle = [...path.slice(cycleStart), childName];
        throw new CapabilityCycleError(cycle);
      }
      // WHITE — recurse.
      const childCap = byName.get(childName);
      color.set(childName, GRAY);
      path.push(childName);
      stack.push({
        capName: childName,
        edges: capabilityEdges(childCap),
        edgeIndex: 0,
        pathIndex: path.length - 1,
      });
    }
  }

  return order;
}

/**
 * The capability-kind dependencies of `cap`, returned as an
 * array of capability names.
 */
function capabilityEdges(cap) {
  const needs = cap.needs ?? {};
  const out = [];
  for (const [needKey, needSpec] of Object.entries(needs)) {
    const { kind, name } = normalizeNeedSpec(needKey, needSpec);
    if (kind === 'capability') out.push(name);
  }
  return out;
}

/**
 * Convenience: validate + order in one call. Returns the
 * ordered list. Throws on validation failure or cycle.
 */
export function validateAndOrderCapabilities(capabilities, hostServices, subsystems) {
  validateCapabilities(capabilities, hostServices, subsystems);
  return orderCapabilities(capabilities);
}

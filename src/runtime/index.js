/**
 * `src/runtime/` — the canonical driver for a sandscript
 * program.
 *
 * See SPEC.md for the contract.
 */

export {
  Runtime,
  DEFAULT_FUEL,
  driveLoop,
  runBackgroundDrive,
  runClosureCall,
  runGrantFanout,
} from './runtime.js';
export {
  RUNTIME_STATE,
  runtimeStateName,
  createRuntimeStateView,
  RUNTIME_STATE_CELL_BYTES,
} from './runtime-state.js';
export {
  createLedgerView,
  LEDGER_ENTRY_BYTES,
  LEDGER_FIELD,
  LEDGER_ACTIVITY,
  LEDGER_ACTIVITY_RUNTIME_RESERVED_MAX,
  ledgerActivityName,
} from './ledger.js';
export {
  createCostLedgerView,
  COST_LEDGER_ENTRY,
  COST_LEDGER_ENTRY_SIZE,
  RING_READ_STATUS,
  RING_READ_TRUNCATION,
} from './cost-ledger.js';
export {
  MissingDependencyError,
  CapabilityCycleError,
  MultipleEndorsementsError,
  RuntimeBootError,
  DuplicateCapabilityNameError,
  ResultMarshallingError,
  isVatFault,
  VAT_FAULT_ERROR_CODE_NAMES,
} from './errors.js';
export {
  serializeThrownError,
  ERROR_SERIALIZATION_LIMITS,
} from './serialize-error.js';

// Sub-pieces exposed for advanced consumers (custom test
// harnesses, partial reuse). The Runtime composes them; most
// embedders never import these directly.
export {
  validateCapabilities,
  orderCapabilities,
  validateAndOrderCapabilities,
  normalizeNeedSpec,
} from './capabilities.js';

// Test harness — exported from the same module so tests in
// downstream repos can import without reaching into a
// `_test/` directory.
export { createPairedChannels, RuntimeBuilder } from './test-harness.js';

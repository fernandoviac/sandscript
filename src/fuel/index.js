/**
 * SandScript Fuel-Based Interpreter
 *
 * - MemoryReader: read-only typed access to interpreter state, no WASM needed
 * - MemoryImage: extends MemoryReader; adds writers, allocators, WASM helpers
 *   (MemoryManipulator is a deprecated alias for MemoryImage)
 * - Parser: streaming parser that emits flat instructions to CodeBlocks
 * - WASM: string interning with FNV-1a hash table
 */

export { MemoryReader } from './memory-reader.js';
export { MemoryImage, MemoryImage as MemoryManipulator } from './memory-image.js';
export { Parser } from './parser.js';
export { Lexer, TokenType } from './lexer.js';
export { instantiate, instantiateSync, compileModule, instantiateFromModule } from './interpreter.wasm.js';
export { Collector } from './collector.js';
export { createSession } from './session.js';
export { snapshot, diff, readInstruction } from './step-diff.js';
export { readStepRing } from './step-ring.js';
export { readHeaderEventRing, readHeaderEventRingRange } from './header-event-ring.js';
export {
  readPublishedRange,
  RING_READ_STATUS,
  RING_READ_TRUNCATION,
  RING_PUBLICATION_CONTRACT_VERSION,
} from '../ring-publication.js';
export {
  computeVatLayout,
  layoutVat,
  readVatLayout,
} from './vat-layout.js';
export { Airlock, Handle, Grant, ClosureHandle, isHandle, isGrant, isClosureHandle } from './airlock.js';
export { AttributedRejection } from './attributed-rejection.js';
export { auditStringReferences } from './string-audit.js';
export { verifyCodeBlockStackDepth } from './codegen-verify.js';
export { checkSyntax } from './syntax-check.js';
export { findStructuralIssues, findStructuralIssuesInSession, hasBlockingFindings } from './structural-checks.js';
export {
  Membrane,
  MembraneOutOfSpaceError,
  StaleHandleError,
  StaleGrantError,
  StaleClosureHandleError,
  SnapshotOrphanedError,
  computeMembraneLayout,
  layoutMembrane,
  readMembraneLayout,
} from '../membrane/index.js';
export * from './constants.js';

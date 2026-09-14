/**
 * Region-write-discipline verifier tests.
 *
 * The verifier enforces that fixed-region base names ($STATE_SCRATCH_BASE,
 * $error_info_base, $builtins_base, ...) appear only inside their
 * allowlisted helper functions, so no other code can even derive a
 * region address.
 */

import { assert, assertEquals } from 'https://deno.land/std@0.208.0/assert/mod.ts';
import {
  scanRegionDiscipline,
  verifyRegionWriteDiscipline,
} from '../../tools/verify-region-write-discipline.js';

// A minimal WAT skeleton that satisfies the discipline map: every
// restricted name appears, every allowlisted function exists.
const CLEAN_SKELETON = `
(module
  (global $STATE_SCRATCH_BASE i32 (i32.const 0x3C))
  (global $STATE_ERROR_INFO_BASE i32 (i32.const 0x38))
  (global $STATE_BUILTINS_BASE i32 (i32.const 0x40))
  (global $error_info_base (mut i32) (i32.const 0))
  (global $builtins_base (mut i32) (i32.const 0))
  (func $init_regions
    (global.set $error_info_base (call $read_state (global.get $STATE_ERROR_INFO_BASE)))
    (global.set $builtins_base (call $read_state (global.get $STATE_BUILTINS_BASE))))
  (func $cached_error_info_base (result i32) (global.get $error_info_base))
  (func $cached_builtins_base (result i32) (global.get $builtins_base))
  (func $scratch_ptr (param $offset i32) (param $bytes i32) (result i32)
    (call $abs (i32.add (call $read_state (global.get $STATE_SCRATCH_BASE)) (local.get $offset))))
  (func $stamp_error_info (param $code i32) (param $detail i32)
    (i32.store (call $abs (global.get $error_info_base)) (local.get $code)))
  (func $gc_stamp_error_info (param $code i32) (param $detail i32) (param $phase i32)
    (i32.store (call $abs (global.get $error_info_base)) (local.get $code)))
  (func $error_info_code (result i32)
    (i32.load (call $abs (global.get $error_info_base))))
  (func $error_info_detail (result i32)
    (i32.load (call $abs (i32.add (global.get $error_info_base) (i32.const 4)))))
  (func $error_info_instruction_index (result i32)
    (i32.load (call $abs (i32.add (global.get $error_info_base) (i32.const 8)))))
  (func $read_builtin (param $offset i32) (result i32)
    (i32.load (call $abs (i32.add (global.get $builtins_base) (local.get $offset)))))
  (func $gc_update_builtin_strings
    (i32.store (call $abs (global.get $builtins_base)) (i32.const 0)))
)`;

Deno.test('discipline: the real interpreter.wat passes', async () => {
  const report = await verifyRegionWriteDiscipline();
  assertEquals(report.violations, [], 'no violations in the shipped WAT');
  assertEquals(report.stale, [], 'discipline map matches the shipped WAT');
  assert(report.ok);
});

Deno.test('discipline: clean skeleton passes', () => {
  const { violations, stale } = scanRegionDiscipline(CLEAN_SKELETON);
  assertEquals(violations, []);
  assertEquals(stale, []);
});

Deno.test('discipline: rogue scratch reference outside the helper fails', () => {
  const rogue = CLEAN_SKELETON.replace(
    '\n)',
    `
  (func $evil_op
    (i32.store (call $abs (call $read_state (global.get $STATE_SCRATCH_BASE)))
      (i32.const 99)))
)`);
  const { violations } = scanRegionDiscipline(rogue);
  assertEquals(violations.length, 1);
  assertEquals(violations[0].name, '$STATE_SCRATCH_BASE');
  assertEquals(violations[0].functionName, 'evil_op');
});

Deno.test('discipline: rogue error-info write outside the helpers fails', () => {
  const rogue = CLEAN_SKELETON.replace(
    '\n)',
    `
  (func $sneaky_error_writer
    (i32.store (call $abs (global.get $error_info_base)) (i32.const 7)))
)`);
  const { violations } = scanRegionDiscipline(rogue);
  assertEquals(violations.length, 1);
  assertEquals(violations[0].name, '$error_info_base');
  assertEquals(violations[0].functionName, 'sneaky_error_writer');
});

Deno.test('discipline: mentions in comments are ignored', () => {
  const commented = CLEAN_SKELETON.replace(
    '\n)',
    `
  (func $documented_op
    ;; the grant operands live at $STATE_SCRATCH_BASE offsets 0/4
    (nop))
)`);
  const { violations } = scanRegionDiscipline(commented);
  assertEquals(violations, []);
});

Deno.test('discipline: $cached_error_info_base name does not false-positive', () => {
  // The function NAME contains the restricted substring; the $ sigil
  // anchoring must keep a bare call from tripping the scan.
  const calling = CLEAN_SKELETON.replace(
    '\n)',
    `
  (func $some_op (result i32)
    (call $cached_error_info_base))
)`);
  const { violations } = scanRegionDiscipline(calling);
  assertEquals(violations, []);
});

Deno.test('discipline: a stale map (renamed helper) is an error, not a silent pass', () => {
  const renamed = CLEAN_SKELETON
    .replaceAll('$scratch_ptr', '$scratch_pointer_helper')
    .replaceAll('$STATE_SCRATCH_BASE', '$STATE_SCRATCH_START');
  const { violations, stale } = scanRegionDiscipline(renamed);
  // The rename moved the reference out of the allowlist...
  assert(stale.length >= 1, 'stale entries reported');
  // ...and the never-seen name is reported stale rather than vacuously OK.
  assert(stale.some((message) => message.includes('$STATE_SCRATCH_BASE')));
  assert(violations.length >= 1 || stale.length >= 2,
    'the renamed reference site is not silently accepted');
});

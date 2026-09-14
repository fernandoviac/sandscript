  ;; The artifact checker and the term engine share one operation resource
  ;; budget. Host fuel is separate: the host may stop after any step, retain the
  ;; private buffer, and resume without rechecking preceding declarations.
  (global $PROOF_OPERATION_RESOURCE_LIMIT i32 (i32.const 100000000))

  ;; Private check record (0x110, 160 bytes). The second 80 bytes checkpoint the
  ;; driver fields for a refused allocation. Every graph/metadata/typed operation
  ;; runs on the shared work stack; launch and await are distinct transitions.
  ;; References are artifact-relative and this record is never serialized.
  ;; 8 work, 12 phase, 16 declarations, 20 count, 24 index, 28 declaration,
  ;; 32 tag, 36 type, 40 constructors, 44 constructor index, 48 constructor count,
  ;; 52 temporary constructor/type/sort, 56 empty context, 60 status, 64 error,
  ;; 68 error offset, 72 actual input length, 76 scratch reclaim boundary.
  ;; Phases: 0/1 validate; 2/3 names; 4/5 quotient; 6/7 recursor package;
  ;; 8 declaration; 9/10 universe context; 11/12 recursor authentication;
  ;; 13/14 infer type; 15/16 type WHNF; 17/18 Prop; 19/20 body check;
  ;; 21/22 formation; 23 constructor setup; 24 constructor; 25/26 infer
  ;; constructor type; 27 next declaration; 28/29 constructor type WHNF;
  ;; 30 next constructor. Each pair is start/await, with no synchronous drain.

  (func $proof_artifact_check_fail
    (param $base i32) (param $state i32) (param $error i32) (result i32)
    (if (i32.eqz (local.get $error)) (then (local.set $error (i32.const 42))))
    (global.set $proof_last_error_code (local.get $error))
    (call $proof_store (local.get $base) (i32.add (local.get $state) (i32.const 60)) (i32.const 2))
    (call $proof_store (local.get $base) (i32.add (local.get $state) (i32.const 64)) (local.get $error))
    (call $proof_store (local.get $base) (i32.add (local.get $state) (i32.const 68)) (global.get $proof_last_error_offset))
    (call $proof_store (local.get $base)
      (i32.add (call $proof_load (local.get $base) (i32.add (local.get $state) (i32.const 8))) (i32.const 16))
      (local.get $error))
    (i32.const 2))

  ;; Reserve the bitmap before the reclaim checkpoint. Its payload is cleared
  ;; incrementally by the scheduled validator, never by this bounded allocator.
  (func $proof_artifact_check_reserve_boundaries
    (param $base i32) (param $work i32) (result i32)
    (local $words i32) (local $table i32)
    (local.set $words (i32.add (i32.shr_u (global.get $proof_scratch_limit) (i32.const 7))
      (i32.ne (i32.and (global.get $proof_scratch_limit) (i32.const 127)) (i32.const 0))))
    (if (i32.and
        (i32.ne (call $proof_boundary_get (local.get $base) (local.get $work) (i32.const 0)) (i32.const 0))
        (i32.ge_u (call $proof_boundary_get (local.get $base) (local.get $work) (i32.const 4)) (local.get $words)))
      (then (return (i32.const 1))))
    (local.set $table (call $proof_make_array (local.get $base) (local.get $words)))
    (if (i32.eqz (local.get $table)) (then (return (i32.const 0))))
    (call $proof_boundary_set (local.get $base) (local.get $work) (i32.const 0) (local.get $table))
    (call $proof_boundary_set (local.get $base) (local.get $work) (i32.const 4) (local.get $words))
    (call $proof_boundary_set (local.get $base) (local.get $work) (i32.const 8) (i32.const 0))
    (call $proof_boundary_set (local.get $base) (local.get $work) (i32.const 12) (i32.const 16))
    (i32.const 1))

  (func $proof_artifact_check_start
  (param $base i32) (param $length i32) (param $capacity i32) (result i32)
  (local $state i32) (local $work i32) (local $context i32)
  (global.set $proof_current_artifact_length (local.get $length))
  (global.set $proof_last_error_code (i32.const 0))
  (global.set $proof_last_error_offset (i32.const 0))
  (global.set $proof_last_inferred_type (i32.const 0))
  (global.set $proof_last_expected_type (i32.const 0))
  ;; Fixed-size guards only. All input graph/record validation runs as a job.
  (if (i32.or (i32.lt_u (local.get $length) (i32.const 28)) (i32.ne (i32.and (local.get $length) (i32.const 3)) (i32.const 0)))
  (then
    (global.set $proof_last_error_code (i32.const 1))
    (return (i32.const 0))))
  (if (i32.or (i32.lt_u (local.get $capacity) (local.get $length)) (i64.gt_u (i64.add (i64.extend_i32_u (call $abs (local.get $base))) (i64.extend_i32_u (local.get $capacity))) (i64.shl (i64.extend_i32_u (memory.size)) (i64.const 16))))
  (then
    (global.set $proof_last_error_code (i32.const 20))
    (return (i32.const 0))))
  (global.set $proof_scratch_cursor (local.get $length))
  (global.set $proof_scratch_limit (local.get $capacity))
  (global.set $proof_current_universe_context (i32.const 0))
  (global.set $proof_current_declaration_index (i32.const 0))
  (local.set $state (call $proof_allocate_record (local.get $base) (i32.const 40) (i32.const 0x110)))
  (if (i32.eqz (local.get $state))
  (then
    (return (i32.const 0))))
  (memory.fill (call $abs (i32.add (local.get $base) (i32.add (local.get $state) (i32.const 8)))) (i32.const 0) (i32.const 152))
  (local.set $context (call $proof_make_array (local.get $base) (i32.const 0)))
  (if (i32.eqz (local.get $context))
  (then
    (return (i32.const 0))))
  (local.set $work (call $proof_work_create (local.get $base) (global.get $PROOF_OPERATION_RESOURCE_LIMIT)))
  (if (i32.eqz (local.get $work))
  (then
    (return (i32.const 0))))
  (call $proof_store (local.get $base) (i32.add (local.get $state) (i32.const 8)) (local.get $work))
  (call $proof_store (local.get $base) (i32.add (local.get $state) (i32.const 56)) (local.get $context))
  (call $proof_store (local.get $base) (i32.add (local.get $state) (i32.const 72)) (local.get $length))
  (if (i32.eqz (call $proof_artifact_check_reserve_boundaries (local.get $base) (local.get $work)))
    (then (return (i32.const 0))))
  (call $proof_store (local.get $base) (i32.add (local.get $state) (i32.const 76)) (global.get $proof_scratch_cursor))
  ;; No untrusted declaration reference is loaded before validator success.
  (call $proof_work_save (local.get $base) (local.get $work))
  (local.get $state)
)

(func $proof_artifact_check_reclaim
  (param $base i32) (param $state i32)
  (local $work i32)
  (local.set $work (call $proof_load (local.get $base) (i32.add (local.get $state) (i32.const 8))))
  (global.set $proof_universe_instantiation_cache (i32.const 0))
  (global.set $proof_scratch_cursor (call $proof_load (local.get $base) (i32.add (local.get $state) (i32.const 76))))
  (call $proof_boundary_rewind (local.get $base) (local.get $work) (global.get $proof_scratch_cursor))
  ;; After arena growth, replace a reclaimed larger bitmap here, below the next
  ;; checkpoint. Retain only bitmap storage, not the preceding temporary terms.
  (if (i32.eqz (call $proof_artifact_check_reserve_boundaries (local.get $base) (local.get $work)))
    (then (return)))
  (call $proof_store (local.get $base) (i32.add (local.get $state) (i32.const 76)) (global.get $proof_scratch_cursor))
  (call $proof_store (local.get $base) (i32.add (local.get $work) (i32.const 8)) (i32.const 0))
  (call $proof_store (local.get $base) (i32.add (local.get $work) (i32.const 12)) (i32.const 0))
  (call $proof_store (local.get $base) (i32.add (local.get $work) (i32.const 28)) (i32.const 0))
  (call $proof_store (local.get $base) (i32.add (local.get $work) (i32.const 40)) (i32.const 0))
  (call $proof_store (local.get $base) (i32.add (local.get $work) (i32.const 64)) (i32.const 0))
)

    (func $proof_artifact_check_queued
    (param $base i32) (param $state i32) (param $next_phase i32) (param $started i32) (result i32)
    (if (i32.eqz (local.get $started))
      (then (return (call $proof_artifact_check_fail (local.get $base) (local.get $state)
        (global.get $proof_last_error_code)))))
    (call $proof_store (local.get $base) (i32.add (local.get $state) (i32.const 12)) (local.get $next_phase))
    (i32.const 0))

  (func $proof_artifact_check_phase
  (param $base i32) (param $state i32) (result i32)
  (local $work i32) (local $phase i32) (local $index i32) (local $decl i32) (local $tag i32) (local $result i32) (local $status i32) (local $constructors i32) (local $declarations i32)
  (local.set $work (call $proof_load (local.get $base) (i32.add (local.get $state) (i32.const 8))))
  (local.set $phase (call $proof_load (local.get $base) (i32.add (local.get $state) (i32.const 12))))
  (local.set $index (call $proof_load (local.get $base) (i32.add (local.get $state) (i32.const 24))))
  (if (i32.gt_u (local.get $phase) (i32.const 30))
  (then
    (return (call $proof_artifact_check_fail (local.get $base) (local.get $state) (i32.const 39)))))
  ;; Await and launch are distinct transitions: a refused next-frame allocation
  ;; never rolls back a completed engine frame or replays a completed gate.
  ;; The engine debits its own running steps. Charge this driver only for
  ;; launch/administrative transitions and the single completion transition,
  ;; not for every poll while its child frame is still running.
  (if (i32.and (i32.shl (i32.const 1) (local.get $phase)) (i32.const 0x245554aa))
  (then
    (local.set $status (call $proof_work_step (local.get $base) (local.get $work)))
    (if (i32.or (i32.eqz (local.get $status)) (i32.eq (local.get $status) (i32.const 3)))
  (then
    (return (local.get $status))))
    (if (i32.eq (local.get $status) (i32.const 2))
  (then
    (return (call $proof_artifact_check_fail (local.get $base) (local.get $state) (global.get $proof_last_error_code)))))
  (if (i32.eqz (call $proof_work_debit (local.get $base) (local.get $work)))
  (then
    (return (call $proof_artifact_check_fail (local.get $base) (local.get $state) (global.get $proof_last_error_code)))))
    (local.set $result (call $proof_load (local.get $base) (i32.add (local.get $work) (i32.const 12))))
    (if (i32.eq (local.get $phase) (i32.const 1))
  (then
    (if (local.get $result)
  (then
    (return (call $proof_artifact_check_fail (local.get $base) (local.get $state) (local.get $result)))))
    (local.set $declarations (call $proof_load (local.get $base) (i32.const 12)))
    (call $proof_store (local.get $base) (i32.add (local.get $state) (i32.const 16)) (local.get $declarations))
    (call $proof_store (local.get $base) (i32.add (local.get $state) (i32.const 20)) (call $proof_array_count (local.get $base) (local.get $declarations)))
    ;; Validation leaves no references into its graph table or free frames.
    (call $proof_artifact_check_reclaim (local.get $base) (local.get $state))
    (call $proof_store (local.get $base) (i32.add (local.get $state) (i32.const 12)) (i32.const 2))
    (return (i32.const 0))))
    (if (i32.eqz (local.get $result))
  (then
    (return (call $proof_artifact_check_fail (local.get $base) (local.get $state) (select (global.get $proof_last_error_code) (select (i32.const 85) (select (i32.const 55) (select (i32.const 59) (select (i32.const 55) (select (i32.const 41) (select (i32.const 55) (i32.const 42) (i32.eq (local.get $phase) (i32.const 22))) (i32.eq (local.get $phase) (i32.const 18))) (i32.eq (local.get $phase) (i32.const 12))) (i32.eq (local.get $phase) (i32.const 10))) (i32.eq (local.get $phase) (i32.const 7))) (i32.eq (local.get $phase) (i32.const 3))) (global.get $proof_last_error_code))))))
    ;; This checker never mutates input declarations. Retain only completed
    ;; literal-authentication tables after names are unique; reclaim drops them
    ;; before the declaration scope changes. Mutable elaboration keeps bit 2 off.
    (if (i32.eq (local.get $phase) (i32.const 3)) (then
      (call $proof_store (local.get $base) (i32.add (local.get $work) (i32.const 24))
        (i32.or (call $proof_load (local.get $base) (i32.add (local.get $work) (i32.const 24))) (i32.const 2)))))
    (if (i32.or (i32.eq (local.get $phase) (i32.const 14)) (i32.eq (local.get $phase) (i32.const 26)))
  (then
    (call $proof_store (local.get $base) (i32.add (local.get $state) (i32.const 52)) (local.get $result))
    (call $proof_store (local.get $base) (i32.add (local.get $state) (i32.const 12)) (select (i32.const 15) (i32.const 28) (i32.eq (local.get $phase) (i32.const 14))))
    (return (i32.const 0))))
    (if (i32.or (i32.eq (local.get $phase) (i32.const 16)) (i32.eq (local.get $phase) (i32.const 29)))
  (then
    (if (i32.ne (call $proof_load (local.get $base) (i32.add (local.get $result) (i32.const 4))) (global.get $PROOF_TERM_SORT))
  (then
    (return (call $proof_artifact_check_fail (local.get $base) (local.get $state) (select (i32.const 40) (i32.const 43) (i32.eq (local.get $phase) (i32.const 16)))))))
    (call $proof_store (local.get $base) (i32.add (local.get $state) (i32.const 52)) (local.get $result))))
    (call $proof_store (local.get $base) (i32.add (local.get $state) (i32.const 12)) (i32.add (local.get $phase) (i32.const 1)))
    (return (i32.const 0))))
  (if (i32.eqz (call $proof_work_debit (local.get $base) (local.get $work)))
  (then
    (return (call $proof_artifact_check_fail (local.get $base) (local.get $state) (global.get $proof_last_error_code)))))
  (if (i32.eq (local.get $phase) (i32.const 0))
  (then
    (if (i32.eqz (call $proof_work_start_proof_validate_artifact (local.get $base) (call $proof_load (local.get $base) (i32.add (local.get $state) (i32.const 72))) (local.get $work)))
  (then
    (return (call $proof_artifact_check_fail (local.get $base) (local.get $state) (global.get $proof_last_error_code)))))
    (call $proof_store (local.get $base) (i32.add (local.get $state) (i32.const 12)) (i32.const 1))
    (return (i32.const 0))))
  (if (i32.eq (local.get $phase) (i32.const 2))
  (then
    (if (i32.eqz (call $proof_work_start_proof_names_unique (local.get $base) (local.get $work)))
  (then
    (return (call $proof_artifact_check_fail (local.get $base) (local.get $state) (global.get $proof_last_error_code)))))
    (call $proof_store (local.get $base) (i32.add (local.get $state) (i32.const 12)) (i32.const 3))
    (return (i32.const 0))))
  (if (i32.eq (local.get $phase) (i32.const 4))
  (then
    (if (i32.eqz (call $proof_work_start_proof_validate_quotient_package (local.get $base) (local.get $work)))
  (then
    (return (call $proof_artifact_check_fail (local.get $base) (local.get $state) (global.get $proof_last_error_code)))))
    (call $proof_store (local.get $base) (i32.add (local.get $state) (i32.const 12)) (i32.const 5))
    (return (i32.const 0))))
  (if (i32.eq (local.get $phase) (i32.const 6))
  (then
    (if (i32.eqz (call $proof_work_start_proof_validate_inductive_recursors (local.get $base) (local.get $work)))
  (then
    (return (call $proof_artifact_check_fail (local.get $base) (local.get $state) (global.get $proof_last_error_code)))))
    (call $proof_store (local.get $base) (i32.add (local.get $state) (i32.const 12)) (i32.const 7))
    (return (i32.const 0))))
  (if (i32.eq (local.get $phase) (i32.const 8))
  (then
    (if (i32.ge_u (local.get $index) (call $proof_load (local.get $base) (i32.add (local.get $state) (i32.const 20))))
  (then
    (global.set $proof_last_error_code (i32.const 0))
    (global.set $proof_last_error_offset (i32.const 0))
    (call $proof_store (local.get $base) (i32.add (local.get $state) (i32.const 60)) (i32.const 1))
    (return (i32.const 1))))
    (global.set $proof_current_declaration_index (local.get $index))
    (global.set $proof_last_error_offset (local.get $index))
    (local.set $decl (call $proof_array_get (local.get $base) (call $proof_load (local.get $base) (i32.add (local.get $state) (i32.const 16))) (local.get $index)))
    (call $proof_store (local.get $base) (i32.add (local.get $state) (i32.const 28)) (local.get $decl))
    (call $proof_store (local.get $base) (i32.add (local.get $state) (i32.const 32)) (call $proof_load (local.get $base) (i32.add (local.get $decl) (i32.const 4))))
    (call $proof_store (local.get $base) (i32.add (local.get $state) (i32.const 36)) (call $proof_load (local.get $base) (i32.add (local.get $decl) (i32.const 12))))
    (global.set $proof_current_universe_context (call $proof_load (local.get $base) (i32.add (local.get $decl) (i32.const 8))))
    (call $proof_store (local.get $base) (i32.add (local.get $state) (i32.const 12)) (i32.const 9))
    (return (i32.const 0))))
  (if (i32.eq (local.get $phase) (i32.const 9))
  (then
    (if (i32.eqz (call $proof_work_start_proof_universe_context_consistent (local.get $base) (global.get $proof_current_universe_context) (local.get $work)))
  (then
    (return (call $proof_artifact_check_fail (local.get $base) (local.get $state) (global.get $proof_last_error_code)))))
    (call $proof_store (local.get $base) (i32.add (local.get $state) (i32.const 12)) (i32.const 10))
    (return (i32.const 0))))
  (if (i32.eq (local.get $phase) (i32.const 11))
  (then
    (if (i32.ne (call $proof_load (local.get $base) (i32.add (local.get $state) (i32.const 32))) (global.get $PROOF_RECORD_RECURSOR_DECLARATION))
  (then
    (call $proof_store (local.get $base) (i32.add (local.get $state) (i32.const 12)) (i32.const 13))
    (return (i32.const 0))))
    (if (i32.eqz (call $proof_work_start_proof_validate_recursor_declaration (local.get $base) (call $proof_load (local.get $base) (i32.add (local.get $state) (i32.const 28))) (local.get $index) (local.get $work)))
  (then
    (return (call $proof_artifact_check_fail (local.get $base) (local.get $state) (global.get $proof_last_error_code)))))
    (call $proof_store (local.get $base) (i32.add (local.get $state) (i32.const 12)) (i32.const 12))
    (return (i32.const 0))))
  (if (i32.eq (local.get $phase) (i32.const 13))
  (then
    (return (call $proof_artifact_check_queued (local.get $base) (local.get $state) (i32.const 14) (call $proof_work_start_proof_infer_term (local.get $base) (call $proof_load (local.get $base) (i32.add (local.get $state) (i32.const 36))) (call $proof_load (local.get $base) (i32.add (local.get $state) (i32.const 56))) (i32.const 0) (i32.const 0) (call $proof_load (local.get $base) (i32.add (local.get $state) (i32.const 8))))))))
  (if (i32.eq (local.get $phase) (i32.const 15))
  (then
    (return (call $proof_artifact_check_queued (local.get $base) (local.get $state) (i32.const 16) (call $proof_work_start_proof_weak_head_normalize (local.get $base) (call $proof_load (local.get $base) (i32.add (local.get $state) (i32.const 52))) (call $proof_load (local.get $base) (i32.add (local.get $state) (i32.const 56))) (i32.const 0) (i32.const 0) (call $proof_load (local.get $base) (i32.add (local.get $state) (i32.const 8))))))))
  (if (i32.eq (local.get $phase) (i32.const 17))
  (then
    (if (i32.ne (call $proof_load (local.get $base) (i32.add (local.get $state) (i32.const 32))) (global.get $PROOF_RECORD_THEOREM_DECLARATION))
  (then
    (call $proof_store (local.get $base) (i32.add (local.get $state) (i32.const 12)) (i32.const 19))
    (return (i32.const 0))))
    (if (i32.eqz (call $proof_work_start_proof_universe_is_zero (local.get $base) (call $proof_load (local.get $base) (i32.add (call $proof_load (local.get $base) (i32.add (local.get $state) (i32.const 52))) (i32.const 8))) (local.get $work)))
  (then
    (return (call $proof_artifact_check_fail (local.get $base) (local.get $state) (global.get $proof_last_error_code)))))
    (call $proof_store (local.get $base) (i32.add (local.get $state) (i32.const 12)) (i32.const 18))
    (return (i32.const 0))))
  (if (i32.eq (local.get $phase) (i32.const 19))
  (then
    (local.set $tag (call $proof_load (local.get $base) (i32.add (local.get $state) (i32.const 32))))
    (if (i32.or (i32.eq (local.get $tag) (global.get $PROOF_RECORD_DEFINITION_DECLARATION)) (i32.or (i32.eq (local.get $tag) (global.get $PROOF_RECORD_OPAQUE_DEFINITION_DECLARATION)) (i32.eq (local.get $tag) (global.get $PROOF_RECORD_THEOREM_DECLARATION))))
  (then
    (return (call $proof_artifact_check_queued (local.get $base) (local.get $state) (i32.const 20) (call $proof_work_start_proof_check_term (local.get $base) (call $proof_load (local.get $base) (i32.add (call $proof_load (local.get $base) (i32.add (local.get $state) (i32.const 28))) (i32.const 16))) (call $proof_load (local.get $base) (i32.add (local.get $state) (i32.const 36))) (call $proof_load (local.get $base) (i32.add (local.get $state) (i32.const 56))) (i32.const 0) (i32.const 0) (call $proof_load (local.get $base) (i32.add (local.get $state) (i32.const 8))))))))
    (call $proof_store (local.get $base) (i32.add (local.get $state) (i32.const 12)) (i32.const 21))
    (return (i32.const 0))))
  (if (i32.eq (local.get $phase) (i32.const 21))
  (then
    (local.set $tag (call $proof_load (local.get $base) (i32.add (local.get $state) (i32.const 32))))
    (if (i32.or (i32.eq (local.get $tag) (global.get $PROOF_RECORD_INDUCTIVE_DECLARATION)) (i32.eq (local.get $tag) (global.get $PROOF_RECORD_COINDUCTIVE_DECLARATION)))
  (then
    (if (i32.eqz (call $proof_work_start_proof_validate_inductive_declaration (local.get $base) (call $proof_load (local.get $base) (i32.add (local.get $state) (i32.const 28))) (local.get $index) (local.get $work)))
  (then
    (return (call $proof_artifact_check_fail (local.get $base) (local.get $state) (global.get $proof_last_error_code)))))
    (call $proof_store (local.get $base) (i32.add (local.get $state) (i32.const 12)) (i32.const 22))
    (return (i32.const 0))))
    (call $proof_store (local.get $base) (i32.add (local.get $state) (i32.const 12)) (i32.const 27))
    (return (i32.const 0))))
  (if (i32.eq (local.get $phase) (i32.const 23))
  (then
    (local.set $constructors (call $proof_load (local.get $base) (i32.add (call $proof_load (local.get $base) (i32.add (local.get $state) (i32.const 28))) (i32.const 24))))
    (call $proof_store (local.get $base) (i32.add (local.get $state) (i32.const 40)) (local.get $constructors))
    (call $proof_store (local.get $base) (i32.add (local.get $state) (i32.const 44)) (i32.const 0))
    (call $proof_store (local.get $base) (i32.add (local.get $state) (i32.const 48)) (call $proof_array_count (local.get $base) (local.get $constructors)))
    (call $proof_store (local.get $base) (i32.add (local.get $state) (i32.const 12)) (i32.const 24))
    (return (i32.const 0))))
  (if (i32.eq (local.get $phase) (i32.const 24))
  (then
    (local.set $index (call $proof_load (local.get $base) (i32.add (local.get $state) (i32.const 44))))
    (if (i32.ge_u (local.get $index) (call $proof_load (local.get $base) (i32.add (local.get $state) (i32.const 48))))
  (then
    (call $proof_store (local.get $base) (i32.add (local.get $state) (i32.const 12)) (i32.const 27))
    (return (i32.const 0))))
    (call $proof_store (local.get $base) (i32.add (local.get $state) (i32.const 52)) (call $proof_array_get (local.get $base) (call $proof_load (local.get $base) (i32.add (local.get $state) (i32.const 40))) (local.get $index)))
    (call $proof_store (local.get $base) (i32.add (local.get $state) (i32.const 12)) (i32.const 25))
    (return (i32.const 0))))
  (if (i32.eq (local.get $phase) (i32.const 25))
  (then
    (return (call $proof_artifact_check_queued (local.get $base) (local.get $state) (i32.const 26) (call $proof_work_start_proof_infer_term (local.get $base) (call $proof_load (local.get $base) (i32.add (call $proof_load (local.get $base) (i32.add (local.get $state) (i32.const 52))) (i32.const 8))) (call $proof_load (local.get $base) (i32.add (local.get $state) (i32.const 56))) (i32.const 0) (i32.const 0) (call $proof_load (local.get $base) (i32.add (local.get $state) (i32.const 8))))))))
  (if (i32.eq (local.get $phase) (i32.const 28))
  (then
    (return (call $proof_artifact_check_queued (local.get $base) (local.get $state) (i32.const 29) (call $proof_work_start_proof_weak_head_normalize (local.get $base) (call $proof_load (local.get $base) (i32.add (local.get $state) (i32.const 52))) (call $proof_load (local.get $base) (i32.add (local.get $state) (i32.const 56))) (i32.const 0) (i32.const 0) (call $proof_load (local.get $base) (i32.add (local.get $state) (i32.const 8))))))))
  (if (i32.eq (local.get $phase) (i32.const 30))
  (then
    (call $proof_store (local.get $base) (i32.add (local.get $state) (i32.const 44)) (i32.add (call $proof_load (local.get $base) (i32.add (local.get $state) (i32.const 44))) (i32.const 1)))
    (call $proof_store (local.get $base) (i32.add (local.get $state) (i32.const 12)) (i32.const 24))
    (return (i32.const 0))))
  (if (i32.eq (local.get $phase) (i32.const 27))
  (then
    (call $proof_artifact_check_reclaim (local.get $base) (local.get $state))
    (call $proof_store (local.get $base) (i32.add (local.get $state) (i32.const 24)) (i32.add (local.get $index) (i32.const 1)))
    (call $proof_store (local.get $base) (i32.add (local.get $state) (i32.const 12)) (i32.const 8))
    (return (i32.const 0))))
  (call $proof_artifact_check_fail (local.get $base) (local.get $state) (i32.const 39))
)

  (func $proof_artifact_check_step
    (param $base i32) (param $state i32) (result i32)
    (local $work i32) (local $cursor i32) (local $top i32) (local $flags i32)
    (local $cache i32) (local $epoch i32) (local $status i32)
    (local.set $status (call $proof_load (local.get $base) (i32.add (local.get $state) (i32.const 60))))
    (if (local.get $status) (then (return (local.get $status))))
    (local.set $work (call $proof_load (local.get $base) (i32.add (local.get $state) (i32.const 8))))
    (local.set $cursor (global.get $proof_scratch_cursor))
    (local.set $top (call $proof_load (local.get $base) (i32.add (local.get $work) (i32.const 8))))
    (local.set $flags (call $proof_load (local.get $base) (i32.add (local.get $work) (i32.const 24))))
    (local.set $cache (call $proof_load (local.get $base) (i32.add (local.get $work) (i32.const 64))))
    (local.set $epoch (global.get $proof_allocation_failure_epoch))
    (memory.copy (call $abs (i32.add (local.get $base) (i32.add (local.get $state) (i32.const 80))))
      (call $abs (i32.add (local.get $base) (local.get $state))) (i32.const 80))
    (local.set $status (call $proof_artifact_check_phase (local.get $base) (local.get $state)))
    (if (i32.or (i32.eq (local.get $status) (i32.const 3))
      (i32.ne (local.get $epoch) (global.get $proof_allocation_failure_epoch)))
      (then
        (memory.copy (call $abs (i32.add (local.get $base) (local.get $state)))
          (call $abs (i32.add (local.get $base) (i32.add (local.get $state) (i32.const 80)))) (i32.const 80))
        (global.set $proof_scratch_cursor (local.get $cursor))
        (call $proof_boundary_reset (local.get $base) (local.get $work) (local.get $cursor))
        (global.set $proof_last_error_code (i32.const 20))
        (call $proof_store (local.get $base) (i32.add (local.get $work) (i32.const 8)) (local.get $top))
        (call $proof_store (local.get $base) (i32.add (local.get $work) (i32.const 16)) (i32.const 20))
        (call $proof_store (local.get $base) (i32.add (local.get $work) (i32.const 24)) (local.get $flags))
        (call $proof_store (local.get $base) (i32.add (local.get $work) (i32.const 28)) (i32.const 3))
        (call $proof_store (local.get $base) (i32.add (local.get $work) (i32.const 40)) (i32.const 0))
        (call $proof_store (local.get $base) (i32.add (local.get $work) (i32.const 64)) (local.get $cache))
        (local.set $status (i32.const 3))))
    (call $proof_work_save (local.get $base) (local.get $work))
    (local.get $status))

  (func $proof_check_artifact_sync
    (param $base i32) (param $length i32) (param $workspace i32) (result i32)
    (local $state i32) (local $status i32)
    (if (i32.gt_u (local.get $workspace) (i32.sub (i32.const -1) (local.get $length)))
      (then (global.set $proof_last_error_code (i32.const 20)) (return (i32.const 20))))
    (local.set $state (call $proof_artifact_check_start (local.get $base) (local.get $length)
      (i32.add (local.get $length) (local.get $workspace))))
    (if (i32.eqz (local.get $state)) (then (return (global.get $proof_last_error_code))))
    (block $done (loop $next
      (local.set $status (call $proof_artifact_check_step (local.get $base) (local.get $state)))
      (br_if $done (local.get $status))
      (br $next)))
    (if (i32.eq (local.get $status) (i32.const 3)) (then (return (i32.const 20))))
    (call $proof_load (local.get $base) (i32.add (local.get $state) (i32.const 64))))

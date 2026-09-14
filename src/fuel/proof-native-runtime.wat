  ;; A native proof transaction can use several private artifact arenas while
  ;; composing operands. Its resource ceiling is shared across those arenas;
  ;; a nested helper never receives a fresh allowance. Durable engine jobs save
  ;; the remaining allowance in their work record before returning to the host.
  (global $proof_operation_active (mut i32) (i32.const 0))
  (global $proof_operation_remaining (mut i32) (i32.const 0))
  (global $proof_operation_work_base (mut i32) (i32.const 0))
  (global $proof_operation_work_reference (mut i32) (i32.const 0))

  (func $proof_operation_begin
    (call $proof_operation_resume (global.get $PROOF_OPERATION_RESOURCE_LIMIT)))

  ;; Re-entry takes its allowance from a traced continuation, never a new cap.
  (func $proof_operation_resume (param $remaining i32)
    (global.set $proof_operation_active (i32.const 1))
    (global.set $proof_operation_remaining (local.get $remaining))
    (global.set $proof_operation_work_base (i32.const 0))
    (global.set $proof_operation_work_reference (i32.const 0)))

  (func $proof_operation_end
    (global.set $proof_operation_active (i32.const 0))
    (global.set $proof_operation_work_base (i32.const 0))
    (global.set $proof_operation_work_reference (i32.const 0)))

  (func $proof_operation_remaining_limit (param $remaining i32) (result i32)
    (if (result i32) (i32.and (global.get $proof_operation_active)
      (i32.lt_u (global.get $proof_operation_remaining) (local.get $remaining)))
      (then (global.get $proof_operation_remaining)) (else (local.get $remaining))))

  (func $proof_operation_charged (param $remaining i32)
    (if (global.get $proof_operation_active)
      (then (global.set $proof_operation_remaining (local.get $remaining)))))

  ;; Initial sizing only, not an operation limit. Reserve the byte-mark/DFS
  ;; tables plus a small frame allowance; growable jobs retain their work when
  ;; more is needed rather than demanding 64 times the input before starting.
  (func $proof_native_workspace_size (param $length i32) (result i32)
    (local $size i64)
    (local.set $size (i64.add (i64.const 65536)
      (i64.mul (i64.extend_i32_u (local.get $length)) (i64.const 2))))
    (i32.wrap_i64 (select (i64.const 16777216) (local.get $size)
      (i64.gt_u (local.get $size) (i64.const 16777216)))))

  ;; Pure term composition only needs the shared budget record. Semantic
  ;; callers request an initial multiplier and may later grow their arena.
  (func $proof_native_composition_workspace_size
    (param $length i32) (param $multiplier i32) (result i32)
    (local $size i64)
    (if (i32.eqz (local.get $multiplier)) (then (return (global.get $PROOF_WORK_RECORD_SIZE))))
    (local.set $size (i64.add (i64.const 4096)
      (i64.mul (i64.extend_i32_u (local.get $length))
        (i64.extend_i32_u (select (i32.const 2) (local.get $multiplier)
          (i32.gt_u (local.get $multiplier) (i32.const 2)))))))
    (i32.wrap_i64 (select (i64.const 16777216) (local.get $size)
      (i64.gt_u (local.get $size) (i64.const 16777216)))))

  ;; Exact allocation preflight for two-handle composition. The common prefix
  ;; may come from either operand; neither a shorter left environment nor a
  ;; wrapped aggregate size may understate the owned allocation.
  (func $proof_native_composition_allocation_size
    (param $left i32) (param $right i32)
    (param $trailing i32) (param $multiplier i32) (result i32)
    (local $left_base i32) (local $right_base i32)
    (local $left_count i32) (local $right_count i32) (local $size i64)
    (local.set $left_base (call $proof_native_handle_artifact_base (local.get $left)))
    (local.set $right_base (call $proof_native_handle_artifact_base (local.get $right)))
    (local.set $left_count (call $proof_array_count (local.get $left_base)
      (call $proof_load (local.get $left_base) (i32.const 12))))
    (local.set $right_count (call $proof_array_count (local.get $right_base)
      (call $proof_load (local.get $right_base) (i32.const 12))))
    (local.set $size (i64.add (i64.const 44)
      (i64.add (i64.mul (i64.extend_i32_u (local.get $trailing)) (i64.const 4))
        (i64.add
          (i64.extend_i32_u (call $proof_native_term_records_length (local.get $left)))
          (i64.mul (i64.extend_i32_u
            (select (local.get $left_count) (local.get $right_count)
              (i32.ge_u (local.get $left_count) (local.get $right_count)))) (i64.const 4))))))
    (if (i32.ne (call $proof_native_handle_buffer (local.get $left))
          (call $proof_native_handle_buffer (local.get $right)))
      (then (local.set $size (i64.add (local.get $size)
        (i64.extend_i32_u (call $proof_native_term_records_length (local.get $right)))))))
    (if (i64.ge_u (local.get $size) (i64.const 0x100000000))
      (then
        (global.set $memory_pressure_signaled (i32.const 1))
        (return (i32.const -1))))
    (local.set $size (i64.add (local.get $size)
      (i64.extend_i32_u (call $proof_native_composition_workspace_size
        (i32.wrap_i64 (local.get $size)) (local.get $multiplier)))))
    (if (i64.ge_u (local.get $size) (i64.const 0x100000000))
      (then
        (global.set $memory_pressure_signaled (i32.const 1))
        (return (i32.const -1))))
    (local.set $size (i64.add (i64.const 24)
      (i64.extend_i32_u (call $estimate_arraybuffer_size (i32.wrap_i64 (local.get $size))))))
    (if (i64.ge_u (local.get $size) (i64.const 0x100000000))
      (then
        (global.set $memory_pressure_signaled (i32.const 1))
        (return (i32.const -1))))
    (i32.wrap_i64 (local.get $size)))

  ;; Commit only: this private arena will never resume. Split its unused tail
  ;; into an unreachable buffer so GC can reclaim it without copying the proof
  ;; or requiring additional space at an already-full heap boundary.
  (func $proof_native_seal_arena (param $handle i32)
    (local $buffer i32) (local $header i32) (local $length i32)
    (local $old_size i32) (local $size i32) (local $tail i32) (local $tail_size i32)
    (local.set $buffer (call $proof_native_handle_buffer (local.get $handle)))
    (local.set $header (i32.sub (local.get $buffer) (global.get $GC_HEADER_SIZE)))
    (local.set $length (call $proof_native_handle_artifact_length (local.get $handle)))
    (local.set $old_size (call $gc_object_size (local.get $header)
      (i32.load (call $abs (local.get $header)))))
    (local.set $size (i32.wrap_i64 (call $arraybuffer_size_i64 (local.get $length))))
    (if (i32.gt_u (local.get $size) (local.get $old_size)) (then (unreachable)))
    (local.set $tail_size (i32.sub (local.get $old_size) (local.get $size)))
    (if (i32.lt_u (local.get $tail_size) (i32.const 16)) (then (return)))
    (local.set $tail (i32.add (local.get $header) (local.get $size)))
    (i32.store (call $abs (local.get $tail))
      (i32.or (i32.shl (global.get $OBJ_ARRAYBUFFER) (i32.const 24))
        (select (i32.const 0) (local.get $tail_size)
          (i32.ge_u (local.get $tail_size) (i32.const 0x01000000)))))
    (i32.store (call $abs (i32.add (local.get $tail) (i32.const 4))) (i32.const 0))
    (i32.store (call $abs (i32.add (local.get $tail) (i32.const 8)))
      (i32.sub (local.get $tail_size) (i32.const 12)))
    (i32.store (call $abs (local.get $header))
      (i32.or (i32.shl (global.get $OBJ_ARRAYBUFFER) (i32.const 24))
        (select (i32.const 0) (local.get $size)
          (i32.ge_u (local.get $size) (i32.const 0x01000000)))))
    (i32.store (call $abs (local.get $buffer)) (local.get $length)))

  ;; Pipeline extensions keep the generic diagnostic offset in extension word0.
  (func $proof_native_op_error_offset (param $meta i32) (result i32)
    (if (result i32)
      (i32.and (i32.load (call $abs (i32.add (local.get $meta) (i32.const 8)))) (i32.const 16))
      (then (call $native_continuation_state_get
        (call $native_continuation_state_get (local.get $meta) (i32.const 4)) (i32.const 0)))
      (else (call $native_continuation_state_get (local.get $meta) (i32.const 4)))))

  (func $proof_native_op_set_error_offset (param $meta i32) (param $offset i32)
    (if
      (i32.and (i32.load (call $abs (i32.add (local.get $meta) (i32.const 8)))) (i32.const 16))
      (then (call $native_continuation_state_set
        (call $native_continuation_state_get (local.get $meta) (i32.const 4))
        (i32.const 0) (local.get $offset)))
      (else (call $native_continuation_state_set (local.get $meta) (i32.const 4) (local.get $offset)))))

  ;; Call only after an arena's cursor/capacity are installed. Reuse is local
  ;; to this native invocation; the dispatch boundary clears this ephemeral
  ;; lookup before collection or another context can reuse a heap address.
  (func $proof_native_operation_work (param $base i32) (result i32)
    (local $work i32)
    (local.set $work (global.get $proof_operation_work_reference))
    (if (i32.and (i32.ne (local.get $work) (i32.const 0))
      (i32.and (i32.eq (local.get $base) (global.get $proof_operation_work_base))
      (i32.and (i32.ge_u (local.get $work) (global.get $proof_current_artifact_length))
        (i32.le_u (i32.add (local.get $work) (global.get $PROOF_WORK_RECORD_SIZE)) (global.get $proof_scratch_cursor)))))
      (then
        (if (i32.eq (call $proof_load (local.get $base) (i32.add (local.get $work) (i32.const 4))) (i32.const 0x10d))
          (then (return (local.get $work))))))
    (local.set $work (call $proof_work_create (local.get $base)
      (call $proof_operation_remaining_limit (global.get $PROOF_OPERATION_RESOURCE_LIMIT))))
    (global.set $proof_operation_work_base (local.get $base))
    (global.set $proof_operation_work_reference (local.get $work))
    (local.get $work))

  (func $is_proof_native_method (param $method i32) (result i32)
    (i32.or
      (i32.and (i32.ge_u (local.get $method) (i32.const 0x240))
        (i32.and (i32.le_u (local.get $method) (i32.const 0x278))
          (i32.ne (local.get $method) (i32.const 0x254))))
      (i32.or
        (i32.and (i32.ge_u (local.get $method) (i32.const 0x27a)) (i32.le_u (local.get $method) (i32.const 0x27b)))
        (i32.or
          (i32.and (i32.ge_u (local.get $method) (i32.const 0x284)) (i32.le_u (local.get $method) (i32.const 0x293)))
          (i32.and (i32.ge_u (local.get $method) (i32.const 0x2d0)) (i32.le_u (local.get $method) (i32.const 0x2f6)))))))

  ;; Generalization changes family-local universe binders. Rebuild only the
  ;; newly published recursors, then compact and recheck before exposing them.
  

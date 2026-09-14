  ;; Host-fuel proof bridge. CTX_REGEX_STATE owns a traced continuation:
  ;; word0 phase | method<<8 | source-candidate bit24 | core-preparing bit25;
  ;; word1 private handle HEADER; word2 metadata HEADER (nested in phases35/39);
  ;; driver; word4 artifact-relative work. Header mask=6. Metadata masks=0 (or
  ;; builder extension mask16): budget, result/index, error, used bytes, error offset/extension.
  ;; Inputs remain on the original pending stack until atomic publish (including call/apply).
  ;; No artifact-relative reference is marked as a collector pointer.
  (global $PROOF_PH_PREPARE i32 (i32.const 32))
  (global $PROOF_PH_ARTIFACT i32 (i32.const 33))
  (global $PROOF_PH_TERM i32 (i32.const 34))
  (global $PROOF_PH_COMPACT i32 (i32.const 35))
  (global $PROOF_PH_PUBLISH i32 (i32.const 36))
  (global $PROOF_PH_COMPOSE_EXPECTED i32 (i32.const 37))
  (global $PROOF_PH_START_TERM i32 (i32.const 38))
  (global $PROOF_PH_TRANSFER i32 (i32.const 39))

  (func $is_proof_inline_method (param $method i32) (result i32)
    (if (call $is_proof_builder_method (local.get $method)) (then (return (i32.const 1))))
    (if (call $is_proof_state_method (local.get $method)) (then (return (i32.const 1))))
    (i32.or (i32.or (i32.eq (local.get $method) (i32.const 0x24d))
                    (i32.eq (local.get $method) (i32.const 0x24f)))
      (i32.or (i32.or (i32.eq (local.get $method) (i32.const 0x257))
                     (i32.eq (local.get $method) (i32.const 0x263)))
        (i32.or (i32.eq (local.get $method) (i32.const 0x269))
          (i32.and (i32.ge_u (local.get $method) (i32.const 0x271))
                   (i32.le_u (local.get $method) (i32.const 0x276)))))))

  ;; Function.call/apply must be intercepted BEFORE their table helper rewrites
  ;; the stack. That helper has no fuel parameter and cannot retain its locals.
  (func $is_proof_inline_call
    (param $method i32) (param $result_slot i32)
    (param $argc i32) (param $args i32) (result i32)
    (local $state i32) (local $inner i32)
    (local.set $state (call $read_ctx (global.get $CTX_REGEX_STATE)))
    (if (local.get $state) (then
      (if (i32.and (call $native_continuation_state_get (local.get $state) (i32.const 0)) (i32.const 0x08000000))
        (then (return (i32.const 1))))))
    (if (call $is_proof_inline_method (local.get $method)) (then (return (i32.const 1))))
    (if (i32.eqz (i32.or
      (i32.eq (local.get $method) (global.get $METHOD_FUNCTION_CALL))
      (i32.eq (local.get $method) (global.get $METHOD_FUNCTION_APPLY)))) (then (return (i32.const 0))))
    (if (i32.ne (call $value_type (local.get $result_slot)) (global.get $TYPE_BOUND_METHOD))
      (then (return (i32.const 0))))
    (local.set $inner (call $value_data_hi (local.get $result_slot)))
    (i32.or (call $is_proof_inline_method (local.get $inner))
      (i32.or (i32.eq (local.get $inner) (global.get $METHOD_FUNCTION_CALL))
        (i32.eq (local.get $inner) (global.get $METHOD_FUNCTION_APPLY)))))

  (func $proof_native_phase (param $state i32) (param $phase i32)
    (call $native_continuation_state_set (local.get $state) (i32.const 0)
      (i32.or (i32.and (call $native_continuation_state_get (local.get $state) (i32.const 0))
                      (i32.const -256)) (local.get $phase))))

  (func $proof_native_op_fail (param $state i32) (param $message i32) (result i32)
    (call $proof_operation_end)
    (call $write_ctx (global.get $CTX_REGEX_STATE) (i32.const 0))
    (call $schema_throw_disposition (call $throw_type_error_with_message (local.get $message))))

  ;; During transfer word2 owns an auxiliary instead of the original metadata.
  ;; Auxiliary header mask9/data mask6: metadata HEADER, source buffer DATA,
  ;; destination buffer DATA, parameters HEADER, cursor. Parameters masks0:
  ;; copy length, source offset, return phase/flags, destination offset, clear length.
  ;; State.word1 stays rooted; only whole-arena transfers publish a new buffer.
  (func $proof_native_op_metadata (param $state i32) (result i32)
    (local $meta i32) (local $phase i32) (local $word i32)
    (local.set $word (call $native_continuation_state_get (local.get $state) (i32.const 0)))
    (local.set $phase (i32.and (local.get $word) (i32.const 255)))
    (local.set $meta (call $native_continuation_state_get (local.get $state) (i32.const 2)))
    (if (i32.eq (local.get $phase) (global.get $PROOF_PH_TRANSFER)) (then
      (local.set $phase (i32.and (call $native_continuation_state_get
        (call $native_continuation_state_get (local.get $meta) (i32.const 3)) (i32.const 2)) (i32.const 255)))
      (local.set $meta (call $native_continuation_state_get (local.get $meta) (i32.const 0)))))
    (if (i32.and (i32.eq (local.get $phase) (global.get $PROOF_PH_COMPACT))
        (i32.ne (i32.and (local.get $word) (i32.const 0x06000000)) (i32.const 0)))
      (then (return (call $native_continuation_state_get (local.get $meta) (i32.const 0)))))
    (local.get $meta))

  ;; Caller preflights two continuation records and all private allocations.
  ;; Flags are private to this transport: bit8 publishes, bit9 copies backward.
  (func $proof_native_transfer_initialize
    (param $state i32) (param $source i32) (param $destination i32)
    (param $source_offset i32) (param $destination_offset i32)
    (param $length i32) (param $clear_length i32) (param $phase i32) (param $publish i32) (result i32)
    (local $parameters i32) (local $transfer i32) (local $flags i32)
    (local.set $flags (i32.or (local.get $phase) (i32.shl (local.get $publish) (i32.const 8))))
    (if (i32.and (i32.eq (local.get $source) (local.get $destination))
        (i32.and (i32.gt_u (local.get $destination_offset) (local.get $source_offset))
          (i64.lt_u (i64.extend_i32_u (local.get $destination_offset))
            (i64.add (i64.extend_i32_u (local.get $source_offset)) (i64.extend_i32_u (local.get $length))))))
      (then (local.set $flags (i32.or (local.get $flags) (i32.const 512)))))
    (local.set $parameters (call $allocate_native_continuation_state
      (i32.const 0) (i32.const 0) (local.get $length) (local.get $source_offset)
      (local.get $flags) (local.get $destination_offset) (local.get $clear_length)))
    (local.set $transfer (call $allocate_native_continuation_state
      (i32.const 9) (i32.const 6) (call $native_continuation_state_get (local.get $state) (i32.const 2))
      (local.get $source) (local.get $destination) (local.get $parameters) (i32.const 0)))
    (call $native_continuation_state_set (local.get $state) (i32.const 2) (local.get $transfer))
    (call $proof_native_phase (local.get $state) (global.get $PROOF_PH_TRANSFER))
    (i32.const 5))

  ;; Auxiliary transfers never publish handles or alter suspended work state.
  ;; Clear bytes immediately follow the copied range; zero copy is clear-only.
  (func $proof_native_transfer_range_begin
    (param $state i32) (param $source i32) (param $destination i32)
    (param $source_offset i32) (param $destination_offset i32)
    (param $length i32) (param $clear_length i32) (param $phase i32) (result i32)
    (call $proof_native_transfer_initialize (local.get $state) (local.get $source) (local.get $destination)
      (local.get $source_offset) (local.get $destination_offset) (local.get $length)
      (local.get $clear_length) (local.get $phase) (i32.const 0)))

  (func $proof_native_transfer_begin
    (param $state i32) (param $source i32) (param $destination i32)
    (param $offset i32) (param $length i32) (param $phase i32) (result i32)
    (call $proof_native_transfer_initialize (local.get $state) (local.get $source) (local.get $destination)
      (local.get $offset) (i32.const 0) (local.get $length)
      (i32.sub (i32.load (call $abs (local.get $destination))) (local.get $length))
      (local.get $phase) (i32.const 1)))

  (func $proof_native_transfer_step (param $state i32) (result i32)
    (local $transfer i32) (local $parameters i32) (local $destination i32)
    (local $cursor i32) (local $length i32) (local $total i32) (local $offset i32)
    (local $count i32) (local $handle i32) (local $work i32) (local $flags i32)
    (local.set $transfer (call $native_continuation_state_get (local.get $state) (i32.const 2)))
    (local.set $parameters (call $native_continuation_state_get (local.get $transfer) (i32.const 3)))
    (local.set $destination (call $native_continuation_state_get (local.get $transfer) (i32.const 2)))
    (local.set $cursor (call $native_continuation_state_get (local.get $transfer) (i32.const 4)))
    (local.set $length (call $native_continuation_state_get (local.get $parameters) (i32.const 0)))
    (local.set $total (i32.add (local.get $length)
      (call $native_continuation_state_get (local.get $parameters) (i32.const 4))))
    (local.set $flags (call $native_continuation_state_get (local.get $parameters) (i32.const 2)))
    (local.set $offset (local.get $cursor))
    (if (i32.lt_u (local.get $cursor) (local.get $length))
      (then
        (local.set $count (i32.sub (local.get $length) (local.get $cursor)))
        (local.set $count (select (local.get $count) (i32.const 256) (i32.lt_u (local.get $count) (i32.const 256))))
        (if (i32.and (local.get $flags) (i32.const 512)) (then
          (local.set $offset (i32.sub (local.get $length) (i32.add (local.get $cursor) (local.get $count))))))
        (memory.copy
          (call $abs (i32.add (i32.add (local.get $destination) (i32.const 4))
            (i32.add (call $native_continuation_state_get (local.get $parameters) (i32.const 3)) (local.get $offset))))
          (call $abs (i32.add
            (i32.add (call $native_continuation_state_get (local.get $transfer) (i32.const 1)) (i32.const 4))
            (i32.add (call $native_continuation_state_get (local.get $parameters) (i32.const 1)) (local.get $offset))))
          (local.get $count)))
      (else
        (local.set $count (i32.sub (local.get $total) (local.get $cursor)))
        (local.set $count (select (local.get $count) (i32.const 256) (i32.lt_u (local.get $count) (i32.const 256))))
        (memory.fill
          (call $abs (i32.add (i32.add (local.get $destination) (i32.const 4))
            (i32.add (call $native_continuation_state_get (local.get $parameters) (i32.const 3)) (local.get $cursor))))
          (i32.const 0) (local.get $count))))
    (local.set $cursor (i32.add (local.get $cursor) (local.get $count)))
    (call $native_continuation_state_set (local.get $transfer) (i32.const 4) (local.get $cursor))
    (if (i32.lt_u (local.get $cursor) (local.get $total)) (then (return (i32.const 5))))
    (if (i32.and (local.get $flags) (i32.const 256)) (then
      (local.set $handle (call $native_continuation_state_get (local.get $state) (i32.const 1)))
      (i32.store (call $abs (i32.add (local.get $handle) (i32.const 8))) (local.get $destination))
      ;; Clear copied pressure3 only when publishing a completed arena growth.
      (local.set $work (call $native_continuation_state_get (local.get $state) (i32.const 4)))
      (if (local.get $work)
        (then (call $proof_work_resume (i32.add (local.get $destination) (i32.const 4)) (local.get $work)
          (i32.load (call $abs (local.get $destination))))))))
    (call $native_continuation_state_set (local.get $state) (i32.const 2)
      (call $native_continuation_state_get (local.get $transfer) (i32.const 0)))
    (call $proof_native_phase (local.get $state) (i32.and (local.get $flags) (i32.const 255)))
    (i32.const 5))

  ;; Copy the USED prefix, not the physical capacity, and preserve the live work
  ;; stack. Refusal leaves the old rooted handle and its capacity status intact.
  ;; Returns5 when the copy is queued,0 on pressure,-1 on size refusal.
  (func $proof_native_op_grow
  (param $state i32) (param $minimum i32) (result i32)
  (local $handle i32) (local $buffer i32) (local $capacity i32) (local $next i32) (local $used i32) (local $meta i32) (local $size i64) (local $maximum i64) (local $allocation i64)
  (local.set $handle (call $native_continuation_state_get (local.get $state) (i32.const 1)))
  (local.set $buffer (call $proof_native_handle_buffer (local.get $handle)))
  (local.set $capacity (i32.load (call $abs (local.get $buffer))))
  ;; Bound only by representable physical allocation, not an input-size ceiling.
  (local.set $maximum (i64.sub (i64.const 0xffffffff) (i64.add (i64.extend_i32_u (global.get $GC_HEADER_SIZE)) (i64.const 11))))
  (if (i64.gt_u (i64.extend_i32_u (local.get $minimum)) (local.get $maximum))
  (then
    (global.set $proof_last_error_code (i32.const 20))
    (return (i32.const -1))))
  (local.set $size (i64.shl (i64.extend_i32_u (local.get $capacity)) (i64.const 1)))
  (if (i64.gt_u (i64.extend_i32_u (local.get $minimum)) (local.get $size))
  (then
    (local.set $size (i64.extend_i32_u (local.get $minimum)))))
  (if (i64.gt_u (local.get $size) (local.get $maximum))
  (then
    (local.set $size (local.get $maximum))))
  (local.set $next (i32.wrap_i64 (local.get $size)))
  (if (i32.le_u (local.get $next) (local.get $capacity))
  (then
    (global.set $proof_last_error_code (i32.const 20))
    (return (i32.const -1))))
  (local.set $allocation (i64.add (call $arraybuffer_size_i64 (local.get $next))
    (i64.extend_i32_u (i32.mul (global.get $NATIVE_CONTINUATION_STATE_SIZE) (i32.const 2)))))
  (if (i64.gt_u (local.get $allocation) (i64.const 0xffffffff))
    (then (global.set $proof_last_error_code (i32.const 20)) (return (i32.const -1))))
  (if (call $check_heap_overflow (i32.wrap_i64 (local.get $allocation)))
  (then
    (return (i32.const 0))))
  (local.set $meta (call $proof_native_op_metadata (local.get $state)))
  (local.set $used (call $native_continuation_state_get (local.get $meta) (i32.const 3)))
  (local.set $next (call $allocate_arraybuffer_uninitialized (local.get $next)))
  (call $proof_native_transfer_begin (local.get $state) (local.get $buffer) (local.get $next)
    (i32.const 0) (local.get $used)
    (i32.and (call $native_continuation_state_get (local.get $state) (i32.const 0)) (i32.const 255)))
)

  ;; Dispositions match Schema: 0 published, 1 fuel pause, 2 pressure,
  ;; 3 uncaught/fault, 4 caught, 6 original nonchecking dispatch.
  (func $proof_native_op_step
    (param $method i32) (param $result_slot i32) (param $argc i32)
    (param $args i32) (param $entry_pending i32) (param $fuel i32) (result i32 i32)
    (local $state i32) (local $meta i32) (local $phase i32)
    (local $outer i32) (local $resolver i32) (local $snapshot i32)
    (local $status i32) (local $before i32)
    (call $write_ctx (global.get $CTX_PENDING_POINTER) (local.get $entry_pending))
    (local.set $state (call $read_ctx (global.get $CTX_REGEX_STATE)))
    (if (i32.eqz (local.get $state)) (then
      (if (i32.le_s (local.get $fuel) (i32.const 0)) (then (return (i32.const 1) (local.get $fuel))))
      (local.set $state (call $proof_native_resolve_begin
        (local.get $method) (local.get $result_slot) (local.get $argc) (local.get $args)))
      (if (i32.eqz (local.get $state)) (then (return (i32.const 2) (local.get $fuel))))))
    (local.set $phase (call $native_continuation_state_get (local.get $state) (i32.const 0)))
    (if (i32.or
      (i32.or (i32.lt_u (i32.and (local.get $phase) (i32.const 255)) (i32.const 32))
        (i32.gt_u (i32.and (local.get $phase) (i32.const 255)) (i32.const 47)))
      (i32.ne (i32.and (i32.shr_u (local.get $phase) (i32.const 8)) (i32.const 65535)) (local.get $method)))
      (then
        (call $write_ctx (global.get $CTX_REGEX_STATE) (i32.const 0))
        (call $fault_error (global.get $ERR_CORRUPT_OPERAND) (local.get $phase) (global.get $current_executing_pc))
        (return (i32.const 3) (local.get $fuel))))
    (if (i32.and (local.get $phase) (i32.const 0x08000000))
      (then
        (local.set $outer (local.get $state))
        (call $proof_operation_resume
          (call $native_continuation_state_get (local.get $outer) (i32.const 3))))
      (else
        ;; Internal universe-return continuations already own their state.
        (local.set $meta (call $proof_native_op_metadata (local.get $state)))
        (call $proof_operation_resume
          (call $native_continuation_state_get (local.get $meta) (i32.const 0)))))
    (block $leave (loop $drive
      (if (i32.le_s (local.get $fuel) (i32.const 0)) (then (local.set $status (i32.const 1)) (br $leave)))
      ;; Check BEFORE any transition, especially publication. Pure work debits
      ;; itself; a native-only transition spends exactly one shared operation.
      (if (i32.eqz (global.get $proof_operation_remaining)) (then
        (global.set $proof_last_error_code (i32.const 29))
        (local.set $status (call $proof_native_op_fail (local.get $state) (global.get $BUILTIN_MSG_INVALID_INDEX)))
        (br $leave)))
      (local.set $before (global.get $proof_operation_remaining))
      (if (local.get $outer) (then
        (local.set $state (call $native_continuation_state_get (local.get $outer) (i32.const 1)))))
      (if (i32.eqz (local.get $state))
        (then (local.set $status (call $proof_native_resolve_step (local.get $outer) (local.get $result_slot))))
        (else
          (if (local.get $outer) (then
            (local.set $resolver (call $native_continuation_state_get (local.get $outer) (i32.const 2)))
            (local.set $snapshot (call $native_continuation_state_get (local.get $resolver) (i32.const 3)))
            (local.set $argc (i32.load (call $abs (i32.add (local.get $snapshot) (i32.const 8)))))
            (local.set $args (i32.add (i32.load (call $abs (i32.add (local.get $snapshot) (i32.const 16)))) (global.get $GC_HEADER_SIZE)))
            (local.set $method (i32.and (i32.shr_u
              (call $native_continuation_state_get (local.get $state) (i32.const 0)) (i32.const 8)) (i32.const 65535)))))
          (local.set $meta (call $proof_native_op_metadata (local.get $state)))
          (global.set $proof_state_artifact_mode (call $proof_native_state_returns_state (local.get $method)))
          (local.set $status (call $proof_native_op_transition (local.get $state) (local.get $method)
            (local.get $argc) (local.get $args) (local.get $result_slot)))
          (global.set $proof_state_artifact_mode (i32.const 0))))
      (if (i32.eq (local.get $before) (global.get $proof_operation_remaining))
        (then (global.set $proof_operation_remaining (i32.sub (local.get $before) (i32.const 1)))))
      (local.set $fuel (call $schema_debit_work (local.get $fuel)
        (i64.extend_i32_u (i32.sub (local.get $before) (global.get $proof_operation_remaining))) (i32.const 0)))
      (if (local.get $outer) (then
        (call $native_continuation_state_set (local.get $outer) (i32.const 3) (global.get $proof_operation_remaining))))
      (if (local.get $meta) (then
        (call $native_continuation_state_set (local.get $meta) (i32.const 0) (global.get $proof_operation_remaining))))
      (br_if $leave (i32.ne (local.get $status) (i32.const 5)))
      (br $drive)))
    (call $proof_operation_end)
    (local.get $status) (local.get $fuel))

  ;; One transition. 5 means continue; all other values are bridge dispositions.
  (func $proof_native_op_transition
    (param $state i32) (param $method i32) (param $argc i32) (param $args i32)
    (param $result_slot i32) (result i32)
    (local $phase i32) (local $meta i32) (local $handle i32) (local $base i32)
    (local $length i32) (local $capacity i32) (local $work i32) (local $driver i32)
    (local $status i32) (local $root i32) (local $context i32) (local $error i32)
    (local $index i32) (local $declarations i32) (local $declaration i32)
    (local.set $phase (i32.and (call $native_continuation_state_get (local.get $state) (i32.const 0)) (i32.const 255)))
    (if (i32.eq (local.get $phase) (global.get $PROOF_PH_TRANSFER))
      (then (return (call $proof_native_transfer_step (local.get $state)))))
    (if (i32.and (i32.eq (local.get $phase) (global.get $PROOF_PH_COMPACT))
        (i32.ne (i32.and (call $native_continuation_state_get (local.get $state) (i32.const 0)) (i32.const 0x02000000)) (i32.const 0)))
      (then (return (call $proof_native_core_prepare_step (local.get $state)))))
    (if (i32.and (i32.eq (local.get $phase) (global.get $PROOF_PH_COMPACT))
        (i32.ne (i32.and (call $native_continuation_state_get (local.get $state) (i32.const 0)) (i32.const 0x04000000)) (i32.const 0)))
      (then (return (call $proof_native_compose_step (local.get $state)))))
    (local.set $meta (call $proof_native_op_metadata (local.get $state)))
    (if (i32.and
          (i32.or (call $is_proof_builder_method (local.get $method)) (i32.eq (local.get $method) (i32.const 0x277)))
          (i32.or (i32.eq (local.get $phase) (i32.const 32))
            (i32.or (i32.eq (local.get $phase) (i32.const 37))
              (i32.and (i32.ge_u (local.get $phase) (i32.const 40)) (i32.le_u (local.get $phase) (i32.const 41))))))
      (then (return (call $proof_native_builder_transition (local.get $state) (local.get $method) (local.get $argc) (local.get $args) (local.get $result_slot)))))
    (if (i32.and (i32.ge_u (local.get $phase) (i32.const 45)) (i32.le_u (local.get $phase) (i32.const 47)))
      (then (return (call $proof_native_elaboration_transition (local.get $state) (local.get $method) (local.get $args)))))
    (if (i32.eq (local.get $phase) (i32.const 32))
      (then (return (call $proof_native_op_prepare (local.get $state) (local.get $method) (local.get $argc) (local.get $args)))))
    (if (i32.and (i32.ge_u (local.get $phase) (i32.const 42)) (i32.le_u (local.get $phase) (i32.const 44)))
      (then (return (call $proof_native_state_transition (local.get $state) (local.get $method)))))
    (local.set $handle (call $native_continuation_state_get (local.get $state) (i32.const 1)))
    (local.set $base (call $proof_native_handle_artifact_base (local.get $handle)))
    (local.set $length (call $proof_native_handle_artifact_length (local.get $handle)))
    (local.set $capacity (i32.load (call $abs (call $proof_native_handle_buffer (local.get $handle)))))
    (local.set $work (call $native_continuation_state_get (local.get $state) (i32.const 4)))
    (local.set $driver (call $native_continuation_state_get (local.get $state) (i32.const 3)))
    (if (i32.eq (local.get $phase) (i32.const 37))
      (then (return (call $proof_native_op_compose_expected (local.get $state) (local.get $args)))))
    (if (i32.eq (local.get $phase) (i32.const 38))
      (then
        ;; Composition owns only a small scratch tail. Expand before installing
        ;; the initial context/work/frame; no proof computation has started yet.
        (if (i32.lt_u (i32.sub (local.get $capacity) (local.get $length)) (i32.const 65536))
          (then
            (local.set $status (call $proof_native_op_grow (local.get $state) (i32.add (local.get $length) (i32.const 65536))))
            (if (i32.eqz (local.get $status)) (then (return (i32.const 2))))
            (if (i32.lt_s (local.get $status) (i32.const 0))
              (then (return (call $proof_native_op_fail (local.get $state) (global.get $BUILTIN_MSG_INVALID_INDEX)))))
            (return (i32.const 5))))
        (global.set $proof_current_artifact_length (local.get $length))
        (global.set $proof_current_declaration_index (i32.const -1))
        (global.set $proof_current_universe_context (i32.const 0))
        (global.set $proof_scratch_cursor (local.get $length))
        (global.set $proof_scratch_limit (local.get $capacity))
        (global.set $proof_last_error_code (i32.const 0))
        (global.set $proof_last_error_offset (i32.const 0))
        (global.set $proof_last_inferred_type (i32.const 0))
        (global.set $proof_last_expected_type (i32.const 0))
        (local.set $context (call $proof_make_array (local.get $base) (i32.const 0)))
        (local.set $work (call $proof_work_create (local.get $base) (global.get $proof_operation_remaining)))
        (local.set $root (call $proof_native_handle_root (local.get $handle)))
        (if (i32.eq (local.get $method) (i32.const 0x272))
          (then (local.set $status (call $proof_work_start_proof_infer_term (local.get $base) (local.get $root) (local.get $context) (i32.const 0) (i32.const 0) (local.get $work))))
          (else
            (call $native_continuation_state_set (local.get $meta) (i32.const 1)
              (call $proof_load (local.get $base) (i32.add (local.get $root) (i32.const 8))))
            (local.set $status (call $proof_work_start_proof_check_term (local.get $base) (call $proof_load (local.get $base) (i32.add (local.get $root) (i32.const 8))) (call $proof_load (local.get $base) (i32.add (local.get $root) (i32.const 12))) (local.get $context) (i32.const 0) (i32.const 0) (local.get $work)))))
        (if (i32.eqz (local.get $status))
          (then (return (call $proof_native_op_fail (local.get $state) (global.get $BUILTIN_MSG_INVALID_INDEX)))))
        (call $proof_work_save (local.get $base) (local.get $work))
        (call $native_continuation_state_set (local.get $state) (i32.const 4) (local.get $work))
        (call $proof_native_phase (local.get $state) (i32.const 34))
        (return (i32.const 5))))
    (if (i32.eq (local.get $phase) (i32.const 35))
      (then (return (call $proof_native_core_prepare_begin (local.get $state) (local.get $handle)
        (call $native_continuation_state_get (local.get $meta) (i32.const 1))
        (call $native_continuation_state_get (local.get $meta) (i32.const 3))
        (i32.const -1) (i32.const 33)))))
    (if (i32.or (i32.eq (local.get $phase) (i32.const 33)) (i32.eq (local.get $phase) (i32.const 34)))
      (then
        (if (i32.eqz (local.get $work))
          (then
            (if (i32.or (i32.eq (local.get $method) (i32.const 0x24d)) (i32.eq (local.get $method) (i32.const 0x24f)))
              (then (local.set $length (call $native_continuation_state_get (local.get $meta) (i32.const 3)))))
            (local.set $driver (call $proof_artifact_check_start (local.get $base) (local.get $length) (local.get $capacity)))
            (if (i32.eqz (local.get $driver))
              (then
                (call $native_continuation_state_set (local.get $meta) (i32.const 2) (global.get $proof_last_error_code))
                (call $proof_native_op_set_error_offset (local.get $meta) (global.get $proof_last_error_offset))
                (call $proof_native_phase (local.get $state) (i32.const 36))
                (return (i32.const 5))))
            (local.set $work (call $proof_load (local.get $base) (i32.add (local.get $driver) (i32.const 8))))
            (call $native_continuation_state_set (local.get $state) (i32.const 3) (local.get $driver))
            (call $native_continuation_state_set (local.get $state) (i32.const 4) (local.get $work))
            (call $proof_work_save (local.get $base) (local.get $work))
            (return (i32.const 5))))
        (if (i32.eq (call $proof_load (local.get $base) (i32.add (local.get $work) (i32.const 28))) (i32.const 3))
          (then
            (local.set $status (call $proof_native_op_grow (local.get $state) (i32.const 0)))
            (if (i32.eq (local.get $status) (i32.const 5)) (then (return (i32.const 5))))
            (if (i32.eqz (local.get $status)) (then (return (i32.const 2))))
            (return (call $proof_native_op_fail (local.get $state) (global.get $BUILTIN_MSG_INVALID_INDEX)))))
        (call $proof_work_resume (local.get $base) (local.get $work) (local.get $capacity))
        (global.set $proof_last_error_offset (call $proof_native_op_error_offset (local.get $meta)))
        (local.set $status
          (if (result i32) (i32.eq (local.get $phase) (i32.const 33))
            (then (call $proof_artifact_check_step (local.get $base) (local.get $driver)))
            (else (call $proof_work_step (local.get $base) (local.get $work)))))
        (call $proof_work_save (local.get $base) (local.get $work))
        (call $native_continuation_state_set (local.get $meta) (i32.const 3) (global.get $proof_scratch_cursor))
        (call $proof_native_op_set_error_offset (local.get $meta) (global.get $proof_last_error_offset))
        (if (i32.or (i32.eqz (local.get $status)) (i32.eq (local.get $status) (i32.const 3))) (then (return (i32.const 5))))
        (local.set $error (global.get $proof_last_error_code))
        (if (i32.and (i32.eq (local.get $phase) (i32.const 34)) (i32.eqz (local.get $error)))
          (then
            (local.set $root (call $proof_load (local.get $base) (i32.add (local.get $work) (i32.const 12))))
            (if (i32.eqz (local.get $root))
              (then (local.set $error (i32.const 42)))
              (else
                (if (i32.or (i32.eq (local.get $method) (i32.const 0x272))
                      (i32.and (call $native_continuation_state_get (local.get $state) (i32.const 0)) (i32.const 0x01000000)))
                  (then
                    (if (i32.eq (local.get $method) (i32.const 0x272))
                      (then (call $native_continuation_state_set (local.get $meta) (i32.const 1) (local.get $root))))
                    (call $proof_native_phase (local.get $state) (i32.const 35))
                    (return (i32.const 5))))))))
        (call $native_continuation_state_set (local.get $meta) (i32.const 2) (local.get $error))
        (call $proof_native_phase (local.get $state) (i32.const 36))
        (return (i32.const 5))))
    ;; Publish is the only transition permitted to overwrite pending inputs.
    (local.set $error (call $native_continuation_state_get (local.get $meta) (i32.const 2)))
    (global.set $proof_last_error_code (local.get $error))
    (global.set $proof_last_error_offset (call $proof_native_op_error_offset (local.get $meta)))
    (if (i32.eq (local.get $method) (i32.const 0x24d))
      (then
        (call $write_value (local.get $result_slot) (global.get $TYPE_BOOLEAN) (i32.const 0) (i32.eqz (local.get $error)) (i32.const 0)))
      (else
        (if (local.get $error)
          (then (return (call $proof_native_op_fail (local.get $state) (global.get $BUILTIN_MSG_NOT_AN_OBJECT)))))
        (if (i32.eq (local.get $method) (i32.const 0x24f))
          (then
            (local.set $index (call $native_continuation_state_get (local.get $meta) (i32.const 1)))
            (local.set $declarations (call $proof_load (local.get $base) (i32.const 12)))
            (if (i32.ge_u (local.get $index) (call $proof_array_count (local.get $base) (local.get $declarations)))
              (then
                (call $write_ctx (global.get $CTX_REGEX_STATE) (i32.const 0))
                (return (call $schema_throw_disposition (call $throw_range_error_with_message (global.get $BUILTIN_MSG_INVALID_INDEX))))))
            (local.set $declaration (call $proof_array_get (local.get $base) (local.get $declarations) (local.get $index)))
            (if (i32.ne (call $proof_load (local.get $base) (i32.add (local.get $declaration) (i32.const 4))) (global.get $PROOF_RECORD_THEOREM_DECLARATION))
              (then (return (call $proof_native_op_fail (local.get $state) (global.get $BUILTIN_MSG_NOT_AN_OBJECT)))))
            (i32.store (call $abs (i32.add (local.get $handle) (i32.const 12))) (local.get $index))))
        (if (i32.or (i32.eq (local.get $method) (i32.const 0x273)) (i32.eq (local.get $method) (i32.const 0x274)))
          (then
            (i32.store (call $abs (i32.add (local.get $handle) (i32.const 12)))
              (call $native_continuation_state_get (local.get $meta) (i32.const 1)))))
        (call $proof_native_seal_arena (local.get $handle))
        (call $write_value (local.get $result_slot) (global.get $TYPE_THEOREM) (i32.const 0) (local.get $handle) (i32.const 0))))
    (call $write_ctx (global.get $CTX_REGEX_STATE) (i32.const 0))
    (call $write_ctx (global.get $CTX_PENDING_POINTER) (i32.add (local.get $result_slot) (global.get $VALUE_SIZE)))
    (i32.const 0))

  (func $proof_native_op_prepare
    (param $state i32) (param $method i32) (param $argc i32) (param $args i32) (result i32)
    (local $meta i32) (local $handle i32) (local $base i32) (local $source i32)
    (local $length i32) (local $workspace i32) (local $required i32) (local $index i32)
    (local $left i32) (local $right i32) (local $third i32) (local $offset i32)
    (local $is_core i32) (local $variant i32) (local $allocation_size i64) (local $buffer i32)
    (if (call $is_proof_state_method (local.get $method))
      (then (return (call $proof_native_state_prepare (local.get $state) (local.get $method) (local.get $argc) (local.get $args)))))
    (local.set $meta (call $native_continuation_state_get (local.get $state) (i32.const 2)))
    (if (call $is_proof_elaboration_method (local.get $method))
      (then (return (call $proof_native_elaboration_prepare (local.get $state) (local.get $method) (local.get $argc) (local.get $args)))))
    (local.set $is_core (i32.or (i32.eq (local.get $method) (i32.const 0x257))
      (i32.or (i32.eq (local.get $method) (i32.const 0x263)) (i32.eq (local.get $method) (i32.const 0x269)))))
    (if (local.get $is_core)
      (then
        (local.set $variant (select (i32.const 0) (select (i32.const 1) (i32.const 2)
          (i32.eq (local.get $method) (i32.const 0x263))) (i32.eq (local.get $method) (i32.const 0x257))))
        (local.set $handle (call $proof_native_prepare_core_environment (local.get $variant)))
        (if (i32.eqz (local.get $handle)) (then (return (i32.const 2))))
        (call $native_continuation_state_set (local.get $state) (i32.const 1) (local.get $handle))
        (call $proof_native_phase (local.get $state) (i32.const 33))
        (return (i32.const 5))))
    (local.set $required (select (i32.const 1)
      (select (i32.const 3) (i32.const 2) (i32.eq (local.get $method) (i32.const 0x274)))
      (i32.or (i32.eq (local.get $method) (i32.const 0x24d)) (i32.eq (local.get $method) (i32.const 0x272)))))
    (if (i32.ne (local.get $argc) (local.get $required))
      (then (return (call $proof_native_op_fail (local.get $state) (global.get $BUILTIN_MSG_MISSING_ARGUMENT)))))
    (if (i32.or (i32.eq (local.get $method) (i32.const 0x24d)) (i32.eq (local.get $method) (i32.const 0x24f)))
      (then
        (if (i32.ne (call $value_type (local.get $args)) (global.get $TYPE_UINT8ARRAY))
          (then (return (call $proof_native_op_fail (local.get $state) (global.get $BUILTIN_MSG_NOT_AN_OBJECT)))))
        (if (i32.eq (local.get $method) (i32.const 0x24f))
          (then
            (if (i32.eqz (call $value_is_numeric (i32.add (local.get $args) (global.get $VALUE_SIZE))))
              (then (return (call $proof_native_op_fail (local.get $state) (global.get $BUILTIN_MSG_NOT_AN_OBJECT)))))
            (local.set $index (call $proof_native_nonnegative_integer_argument (i32.add (local.get $args) (global.get $VALUE_SIZE))))
            (if (i32.lt_s (local.get $index) (i32.const 0))
              (then
                (call $write_ctx (global.get $CTX_REGEX_STATE) (i32.const 0))
                (return (call $schema_throw_disposition (call $throw_range_error_with_message (global.get $BUILTIN_MSG_INVALID_INDEX))))))
            (call $native_continuation_state_set (local.get $meta) (i32.const 1) (local.get $index))))
        (local.set $source (call $value_data_lo (local.get $args)))
        (local.set $length (i32.load (call $abs (i32.add (local.get $source) (i32.const 8)))))
        (local.set $offset (i32.load (call $abs (i32.add (local.get $source) (i32.const 4)))))
        (local.set $source (i32.load (call $abs (local.get $source))))
        (local.set $workspace (call $proof_native_workspace_size (local.get $length)))
        (local.set $allocation_size (i64.add (i64.extend_i32_u (local.get $length)) (i64.extend_i32_u (local.get $workspace))))
        (if (i64.gt_u (local.get $allocation_size) (i64.const 0xffffffff))
  (then
    (global.set $proof_last_error_code (i32.const 20))
    (return (call $proof_native_op_fail (local.get $state) (global.get $BUILTIN_MSG_INVALID_INDEX)))))
        (local.set $allocation_size (i64.add (call $arraybuffer_size_i64 (i32.wrap_i64 (local.get $allocation_size)))
          (i64.add (i64.const 24) (i64.extend_i32_u (i32.mul (global.get $NATIVE_CONTINUATION_STATE_SIZE) (i32.const 2))))))
        (if (i64.gt_u (local.get $allocation_size) (i64.const 0xffffffff))
  (then
    (global.set $proof_last_error_code (i32.const 20))
    (return (call $proof_native_op_fail (local.get $state) (global.get $BUILTIN_MSG_INVALID_INDEX)))))
        (if (call $check_heap_overflow (i32.wrap_i64 (local.get $allocation_size)))
  (then
    (return (i32.const 2))))
        (local.set $buffer (call $allocate_arraybuffer_uninitialized (i32.add (local.get $length) (local.get $workspace))))
        (local.set $handle (call $proof_native_allocate_buffer_handle (local.get $buffer)
          (i32.const 0) (global.get $PROOF_HANDLE_THEOREM) (i32.const 0)))
        (call $native_continuation_state_set (local.get $state) (i32.const 1) (local.get $handle))
        ;; Physical byteLength is capacity; driver start must validate the
        ;; caller's actual view length, not an untrusted header length.
        (call $native_continuation_state_set (local.get $meta) (i32.const 3) (local.get $length))
        (return (call $proof_native_transfer_begin (local.get $state) (local.get $source) (local.get $buffer)
          (local.get $offset) (local.get $length) (i32.const 33)))))
    ;; Validate every operand before any composition dereferences its handle.
    (block $checked (loop $argument
      (br_if $checked (i32.ge_u (local.get $index) (local.get $argc)))
      (local.set $source (i32.add (local.get $args) (i32.mul (local.get $index) (global.get $VALUE_SIZE))))
      (if (i32.ne (call $value_type (local.get $source)) (global.get $TYPE_THEOREM))
        (then (return (call $proof_native_op_fail (local.get $state) (global.get $BUILTIN_MSG_NOT_AN_OBJECT)))))
      (if (i32.eqz (call $proof_native_term_handle_valid (call $value_data_lo (local.get $source))))
        (then (return (call $proof_native_op_fail (local.get $state) (global.get $BUILTIN_MSG_NOT_AN_OBJECT)))))
      (local.set $index (i32.add (local.get $index) (i32.const 1))) (br $argument)))
    (local.set $left (call $value_data_lo (local.get $args)))
    (if (i32.eq (local.get $method) (i32.const 0x272))
      (then
        (local.set $length (call $proof_native_handle_artifact_length (local.get $left)))
        (local.set $workspace (call $proof_native_workspace_size (local.get $length)))
        (local.set $allocation_size (i64.add (i64.extend_i32_u (local.get $length)) (i64.extend_i32_u (local.get $workspace))))
        (if (i64.gt_u (local.get $allocation_size) (i64.const 0xffffffff))
  (then
    (global.set $proof_last_error_code (i32.const 20))
    (return (call $proof_native_op_fail (local.get $state) (global.get $BUILTIN_MSG_INVALID_INDEX)))))
        (local.set $allocation_size (i64.add (call $arraybuffer_size_i64 (i32.wrap_i64 (local.get $allocation_size)))
          (i64.add (i64.const 24) (i64.extend_i32_u (i32.mul (global.get $NATIVE_CONTINUATION_STATE_SIZE) (i32.const 2))))))
        (if (i64.gt_u (local.get $allocation_size) (i64.const 0xffffffff))
  (then
    (global.set $proof_last_error_code (i32.const 20))
    (return (call $proof_native_op_fail (local.get $state) (global.get $BUILTIN_MSG_INVALID_INDEX)))))
        (if (call $check_heap_overflow (i32.wrap_i64 (local.get $allocation_size)))
  (then
    (return (i32.const 2))))
        (local.set $buffer (call $allocate_arraybuffer_uninitialized (i32.add (local.get $length) (local.get $workspace))))
        (local.set $handle (call $proof_native_allocate_buffer_handle (local.get $buffer)
          (call $proof_native_handle_root (local.get $left)) (global.get $PROOF_HANDLE_TERM)
          (i32.load (call $abs (i32.add (local.get $left) (i32.const 20))))))
        (call $native_continuation_state_set (local.get $state) (i32.const 1) (local.get $handle))
        (call $native_continuation_state_set (local.get $meta) (i32.const 3) (local.get $length))
        (return (call $proof_native_transfer_begin (local.get $state)
          (call $proof_native_handle_buffer (local.get $left)) (local.get $buffer)
          (i32.const 0) (local.get $length) (i32.const 38)))))
    (local.set $right (call $value_data_lo (i32.add (local.get $args) (global.get $VALUE_SIZE))))
    (if (i32.eq (local.get $method) (i32.const 0x274))
      (then
        (local.set $third (call $value_data_lo (i32.add (local.get $args) (i32.mul (global.get $VALUE_SIZE) (i32.const 2)))))
        (return (call $proof_native_compose_begin (local.get $state)
          (local.get $third) (local.get $left) (i32.const 0) (i32.const 37)))))
    (call $proof_native_elaboration_start_checked (local.get $state) (local.get $left) (local.get $right)))

  (func $proof_native_op_compose_expected (param $state i32) (param $args i32) (result i32)
    (call $proof_native_compose_begin (local.get $state)
      (call $native_continuation_state_get (local.get $state) (i32.const 1))
      (call $value_data_lo (i32.add (local.get $args) (global.get $VALUE_SIZE)))
      (i32.const 0) (i32.const 38)))

  ;; Outer root mask6: phase32|entryMethod<<8|bit27, inner state HEADER,
  ;; resolver HEADER, budget, reserved. It remains rooted until atomic publish.
  ;; Resolver mask15: current view, Brent checkpoint, counters, private Array,
  ;; snapshot cursor. View mask4: method, argc, source Array HEADER (0=pending),
  ;; byte offset (relative to result slot for pending), receiver method/-1.
  ;; Counters masks0: power, distance, reserved, reserved, reserved.
  ;; Never persist a pending/interior heap pointer. Each step follows ONE edge
  ;; or captures ONE value; a resized public Array is bounds-checked anew.
  (func $proof_native_resolve_begin
    (param $method i32) (param $result_slot i32) (param $argc i32) (param $args i32) (result i32)
    (local $view i32) (local $saved i32) (local $counters i32) (local $resolver i32)
    (local $outer i32) (local $receiver i32)
    (if (call $check_heap_overflow (i32.mul (global.get $NATIVE_CONTINUATION_STATE_SIZE) (i32.const 5)))
      (then (return (i32.const 0))))
    (local.set $receiver (i32.const -1))
    (if (local.get $result_slot) (then
      (if (i32.eq (call $value_type (local.get $result_slot)) (global.get $TYPE_BOUND_METHOD))
        (then (local.set $receiver (call $value_data_hi (local.get $result_slot)))))))
    (local.set $view (call $allocate_native_continuation_state (i32.const 4) (i32.const 0)
      (local.get $method) (local.get $argc) (i32.const 0)
      (i32.sub (local.get $args) (local.get $result_slot)) (local.get $receiver)))
    (local.set $saved (call $allocate_native_continuation_state (i32.const 4) (i32.const 0)
      (local.get $method) (local.get $argc) (i32.const 0)
      (i32.sub (local.get $args) (local.get $result_slot)) (local.get $receiver)))
    (local.set $counters (call $allocate_native_continuation_state (i32.const 0) (i32.const 0)
      (i32.const 1) (i32.const 0) (i32.const 0) (i32.const 0) (i32.const 0)))
    (local.set $resolver (call $allocate_native_continuation_state (i32.const 15) (i32.const 0)
      (local.get $view) (local.get $saved) (local.get $counters) (i32.const 0) (i32.const 0)))
    (local.set $outer (call $allocate_native_continuation_state (i32.const 6) (i32.const 0)
      (i32.or (i32.const 0x08000020) (i32.shl (local.get $method) (i32.const 8)))
      (i32.const 0) (local.get $resolver) (global.get $PROOF_OPERATION_RESOURCE_LIMIT) (i32.const 0)))
    (call $write_ctx (global.get $CTX_REGEX_STATE) (local.get $outer))
    (local.get $outer))

  (func $proof_native_resolve_value
    (param $view i32) (param $result_slot i32) (param $index i32) (result i32)
    (local $array i32) (local $offset i32)
    (if (i32.ge_u (local.get $index) (call $native_continuation_state_get (local.get $view) (i32.const 1)))
      (then (return (i32.const 0))))
    (local.set $array (call $native_continuation_state_get (local.get $view) (i32.const 2)))
    (local.set $offset (i32.add (call $native_continuation_state_get (local.get $view) (i32.const 3))
      (i32.mul (local.get $index) (global.get $VALUE_SIZE))))
    (if (i32.eqz (local.get $array)) (then (return (i32.add (local.get $result_slot) (local.get $offset)))))
    (if (i32.ge_u (i32.div_u (local.get $offset) (global.get $VALUE_SIZE))
      (i32.load (call $abs (i32.add (local.get $array) (i32.const 8))))) (then (return (i32.const 0))))
    (i32.add (i32.add (i32.load (call $abs (i32.add (local.get $array) (i32.const 16))))
      (global.get $GC_HEADER_SIZE)) (local.get $offset)))

  (func $proof_native_resolve_step (param $outer i32) (param $result_slot i32) (result i32)
    (local $resolver i32) (local $view i32) (local $saved i32) (local $counters i32)
    (local $method i32) (local $argc i32) (local $receiver i32) (local $next_receiver i32)
    (local $argument i32) (local $array i32) (local $offset i32) (local $kind i32)
    (local $snapshot i32) (local $cursor i32) (local $destination i32) (local $size i64)
    (local $meta i32) (local $state i32) (local $index i32) (local $equal i32) (local $distance i32)
    (local.set $resolver (call $native_continuation_state_get (local.get $outer) (i32.const 2)))
    (local.set $view (call $native_continuation_state_get (local.get $resolver) (i32.const 0)))
    (local.set $saved (call $native_continuation_state_get (local.get $resolver) (i32.const 1)))
    (local.set $counters (call $native_continuation_state_get (local.get $resolver) (i32.const 2)))
    (local.set $method (call $native_continuation_state_get (local.get $view) (i32.const 0)))
    (local.set $argc (call $native_continuation_state_get (local.get $view) (i32.const 1)))
    (if (call $is_proof_inline_method (local.get $method)) (then
      (local.set $snapshot (call $native_continuation_state_get (local.get $resolver) (i32.const 3)))
      (if (i32.eqz (local.get $snapshot)) (then
        (local.set $size (i64.add (i64.extend_i32_u (i32.add (global.get $ARRAY_HEADER_SIZE) (global.get $GC_HEADER_SIZE)))
          (i64.mul (i64.extend_i32_u (local.get $argc)) (i64.extend_i32_u (global.get $VALUE_SIZE)))))
        (if (i64.gt_u (local.get $size) (i64.const 0xffffffff))
          (then (return (call $proof_native_op_fail (local.get $outer) (global.get $BUILTIN_MSG_INVALID_INDEX)))))
        (if (call $check_heap_overflow (i32.wrap_i64 (local.get $size))) (then (return (i32.const 2))))
        (local.set $snapshot (call $allocate_array (local.get $argc)))
        ;; Collector traces only initialized length, never unwritten capacity.
        (i32.store (call $abs (i32.add (local.get $snapshot) (i32.const 8))) (i32.const 0))
        (call $native_continuation_state_set (local.get $resolver) (i32.const 3) (local.get $snapshot))
        (return (i32.const 5))))
      (local.set $cursor (call $native_continuation_state_get (local.get $resolver) (i32.const 4)))
      (if (i32.lt_u (local.get $cursor) (local.get $argc)) (then
        (local.set $argument (call $proof_native_resolve_value (local.get $view) (local.get $result_slot) (local.get $cursor)))
        (local.set $destination (i32.add
          (i32.add (i32.load (call $abs (i32.add (local.get $snapshot) (i32.const 16)))) (global.get $GC_HEADER_SIZE))
          (i32.mul (local.get $cursor) (global.get $VALUE_SIZE))))
        (if (local.get $argument)
          (then (memory.copy (call $abs (local.get $destination)) (call $abs (local.get $argument)) (global.get $VALUE_SIZE)))
          (else (call $write_value (local.get $destination) (global.get $TYPE_UNDEFINED) (i32.const 0) (i32.const 0) (i32.const 0))))
        (local.set $cursor (i32.add (local.get $cursor) (i32.const 1)))
        (i32.store (call $abs (i32.add (local.get $snapshot) (i32.const 8))) (local.get $cursor))
        (call $native_continuation_state_set (local.get $resolver) (i32.const 4) (local.get $cursor))
        (return (i32.const 5))))
      (if (call $check_heap_overflow (i32.mul (global.get $NATIVE_CONTINUATION_STATE_SIZE) (i32.const 2)))
        (then (return (i32.const 2))))
      (local.set $meta (call $allocate_native_continuation_state (i32.const 0) (i32.const 0)
        (global.get $proof_operation_remaining) (i32.const 0) (i32.const 0) (i32.const 0) (i32.const 0)))
      (local.set $state (call $allocate_native_continuation_state (i32.const 6) (i32.const 0)
        (i32.or (i32.const 32) (i32.shl (local.get $method) (i32.const 8)))
        (i32.const 0) (local.get $meta) (i32.const 0) (i32.const 0)))
      (call $native_continuation_state_set (local.get $outer) (i32.const 1) (local.get $state))
      (return (i32.const 5))))
    (block $not_proof
      (br_if $not_proof (i32.eqz (i32.or
        (i32.eq (local.get $method) (global.get $METHOD_FUNCTION_CALL))
        (i32.eq (local.get $method) (global.get $METHOD_FUNCTION_APPLY)))))
      (local.set $receiver (call $native_continuation_state_get (local.get $view) (i32.const 4)))
      (br_if $not_proof (i32.eq (local.get $receiver) (i32.const -1)))
      (local.set $argument (call $proof_native_resolve_value (local.get $view) (local.get $result_slot) (i32.const 0)))
      (local.set $next_receiver (i32.const -1))
      (if (local.get $argument) (then
        (if (i32.eq (call $value_type (local.get $argument)) (global.get $TYPE_BOUND_METHOD))
          (then (local.set $next_receiver (call $value_data_hi (local.get $argument)))))))
      (local.set $array (call $native_continuation_state_get (local.get $view) (i32.const 2)))
      (local.set $offset (call $native_continuation_state_get (local.get $view) (i32.const 3)))
      (if (i32.eq (local.get $method) (global.get $METHOD_FUNCTION_CALL))
        (then (if (local.get $argc) (then
          (local.set $argc (i32.sub (local.get $argc) (i32.const 1)))
          (local.set $offset (i32.add (local.get $offset) (global.get $VALUE_SIZE))))))
        (else
          (local.set $argument (call $proof_native_resolve_value (local.get $view) (local.get $result_slot) (i32.const 1)))
          (local.set $array (i32.const 0))
          (if (local.get $argument) (then
            (local.set $kind (call $value_type (local.get $argument)))
            (if (i32.eq (local.get $kind) (global.get $TYPE_ARRAY))
              (then (local.set $array (call $value_data_lo (local.get $argument))))
              (else (br_if $not_proof (i32.and
                (i32.ne (local.get $kind) (global.get $TYPE_NULL))
                (i32.ne (local.get $kind) (global.get $TYPE_UNDEFINED))))))))
          (local.set $argc (i32.const 0))
          (local.set $offset (i32.const 0))
          (if (local.get $array) (then
            (local.set $argc (i32.load (call $abs (i32.add (local.get $array) (i32.const 8)))))))
          (br_if $not_proof (i64.gt_u
            (i64.add (i64.extend_i32_u (local.get $result_slot))
              (i64.mul (i64.add (i64.extend_i32_u (local.get $argc)) (i64.const 1)) (i64.extend_i32_u (global.get $VALUE_SIZE))))
            (i64.extend_i32_u (call $read_ctx (global.get $CTX_PENDING_LIMIT)))))))
      (call $native_continuation_state_set (local.get $view) (i32.const 0) (local.get $receiver))
      (call $native_continuation_state_set (local.get $view) (i32.const 1) (local.get $argc))
      (call $native_continuation_state_set (local.get $view) (i32.const 2) (local.get $array))
      (call $native_continuation_state_set (local.get $view) (i32.const 3) (local.get $offset))
      (call $native_continuation_state_set (local.get $view) (i32.const 4) (local.get $next_receiver))
      ;; Fixed five-word comparison/copy, independent of wrapper depth.
      (local.set $equal (i32.const 1))
      (loop $compare
        (local.set $equal (i32.and (local.get $equal) (i32.eq
          (call $native_continuation_state_get (local.get $view) (local.get $index))
          (call $native_continuation_state_get (local.get $saved) (local.get $index)))))
        (local.set $index (i32.add (local.get $index) (i32.const 1)))
        (br_if $compare (i32.lt_u (local.get $index) (i32.const 5))))
      (br_if $not_proof (local.get $equal))
      (local.set $distance (i32.add (call $native_continuation_state_get (local.get $counters) (i32.const 1)) (i32.const 1)))
      (if (i32.eq (local.get $distance) (call $native_continuation_state_get (local.get $counters) (i32.const 0)))
        (then
          (memory.copy
            (call $abs (i32.add (local.get $saved) (i32.add (global.get $GC_HEADER_SIZE) (global.get $NATIVE_CONTINUATION_STATE_VALUES))))
            (call $abs (i32.add (local.get $view) (i32.add (global.get $GC_HEADER_SIZE) (global.get $NATIVE_CONTINUATION_STATE_VALUES))))
            (i32.const 20))
          (call $native_continuation_state_set (local.get $counters) (i32.const 0) (i32.shl (local.get $distance) (i32.const 1)))
          (local.set $distance (i32.const 0))))
      (call $native_continuation_state_set (local.get $counters) (i32.const 1) (local.get $distance))
      (return (i32.const 5)))
    ;; The original call/apply helper still owns all nonchecking/error routes.
    (call $write_ctx (global.get $CTX_REGEX_STATE) (i32.const 0))
    (i32.const 6))



  ;; Resumable canonical compaction. Header roots: metadata, source handle,
  ;; destination handle, scalar record; the mapping buffer is a DATA root.
  ;; Scalar=[stage,root,sourceLength,workspace,progress HEADER].
  ;; Progress=[returnPhase,record/queueHead,field,newLength/queueTail,reserved].
  (func $proof_native_core_prepare_begin
    (param $state i32) (param $source i32) (param $root i32)
    (param $length i32) (param $workspace i32) (param $phase i32) (result i32)
    (local $mapping i32) (local $scalar i32) (local $progress i32) (local $aux i32)
    (local $size i64) (local $allocation i64)
    (if (i32.eqz (local.get $length)) (then
      (local.set $length (call $proof_native_handle_artifact_length (local.get $source)))))
    (local.set $size (i64.shl (i64.extend_i32_u (local.get $length)) (i64.const 1)))
    (if (i64.gt_u (local.get $size) (i64.const 0xfffffff0))
      (then (return (call $proof_native_op_fail (local.get $state) (global.get $BUILTIN_MSG_NOT_AN_OBJECT)))))
    (local.set $allocation (i64.add (call $arraybuffer_size_i64 (i32.wrap_i64 (local.get $size)))
      (i64.extend_i32_u (i32.mul (global.get $NATIVE_CONTINUATION_STATE_SIZE) (i32.const 5)))))
    (if (i64.gt_u (local.get $allocation) (i64.const 0xffffffff))
      (then (return (call $proof_native_op_fail (local.get $state) (global.get $BUILTIN_MSG_NOT_AN_OBJECT)))))
    (if (call $check_heap_overflow (i32.wrap_i64 (local.get $allocation))) (then (return (i32.const 2))))
    (local.set $mapping (call $allocate_arraybuffer_uninitialized (i32.wrap_i64 (local.get $size))))
    (local.set $progress (call $allocate_native_continuation_state (i32.const 0) (i32.const 0)
      (local.get $phase) (i32.const 0) (i32.const 2) (i32.const 0) (i32.const 0)))
    (local.set $scalar (call $allocate_native_continuation_state (i32.const 16) (i32.const 0)
      (i32.const 0) (local.get $root) (local.get $length) (local.get $workspace) (local.get $progress)))
    (local.set $aux (call $allocate_native_continuation_state (i32.const 27) (i32.const 4)
      (call $proof_native_op_metadata (local.get $state)) (local.get $source) (local.get $mapping)
      (i32.const 0) (local.get $scalar)))
    (call $native_continuation_state_set (local.get $state) (i32.const 2) (local.get $aux))
    (call $proof_native_phase (local.get $state) (global.get $PROOF_PH_COMPACT))
    (call $native_continuation_state_set (local.get $state) (i32.const 0)
      (i32.or (call $native_continuation_state_get (local.get $state) (i32.const 0)) (i32.const 0x02000000)))
    (call $proof_native_transfer_range_begin (local.get $state) (i32.const 0) (local.get $mapping)
      (i32.const 0) (i32.const 0) (i32.const 0) (i32.wrap_i64 (local.get $size)) (global.get $PROOF_PH_COMPACT)))

  (func $proof_native_core_prepare_step (param $state i32) (result i32)
    (local $aux i32) (local $scalar i32) (local $progress i32) (local $stage i32)
    (local $source i32) (local $base i32) (local $length i32) (local $declarations i32)
    (local $mapping i32) (local $marks i32) (local $record i32) (local $field i32)
    (local $words i32) (local $child i32) (local $tail i32) (local $next i32)
    (local $mapped i32) (local $destination i32) (local $buffer i32) (local $workspace i32)
    (local $new_length i32) (local $meta i32) (local $size i64) (local $allocation i64)
    (local.set $aux (call $native_continuation_state_get (local.get $state) (i32.const 2)))
    (local.set $scalar (call $native_continuation_state_get (local.get $aux) (i32.const 4)))
    (local.set $progress (call $native_continuation_state_get (local.get $scalar) (i32.const 4)))
    (local.set $stage (call $native_continuation_state_get (local.get $scalar) (i32.const 0)))
    (local.set $source (call $native_continuation_state_get (local.get $aux) (i32.const 1)))
    (local.set $base (call $proof_native_handle_artifact_base (local.get $source)))
    (local.set $length (call $native_continuation_state_get (local.get $scalar) (i32.const 2)))
    (local.set $declarations (call $proof_load (local.get $base) (i32.const 12)))
    (local.set $mapping (call $native_continuation_state_get (local.get $aux) (i32.const 2)))
    (local.set $marks (i32.add (i32.add (local.get $mapping) (i32.const 4)) (local.get $length)))
    (local.set $record (call $native_continuation_state_get (local.get $progress) (i32.const 1)))
    (local.set $field (call $native_continuation_state_get (local.get $progress) (i32.const 2)))
    (local.set $tail (call $native_continuation_state_get (local.get $progress) (i32.const 3)))
    (if (i32.eqz (local.get $stage)) (then
      ;; The mapping half is initially a bounded work queue. At most one slot
      ;; per source record is enqueued; marks prevent cycles and duplicate work.
      (local.set $child (call $native_continuation_state_get (local.get $scalar) (i32.const 1)))
      (if (call $proof_native_mark_record_reference (local.get $marks) (local.get $child)) (then
        (i32.store (call $abs (i32.add (local.get $mapping) (i32.const 4))) (local.get $child))
        (local.set $tail (i32.const 1))))
      (if (call $proof_native_mark_record_reference (local.get $marks) (local.get $declarations)) (then
        (i32.store (call $abs (i32.add (i32.add (local.get $mapping) (i32.const 4)) (i32.shl (local.get $tail) (i32.const 2)))) (local.get $declarations))
        (local.set $tail (i32.add (local.get $tail) (i32.const 1)))))
      (call $native_continuation_state_set (local.get $progress) (i32.const 3) (local.get $tail))
      (call $native_continuation_state_set (local.get $scalar) (i32.const 0) (i32.const 1))
      (return (i32.const 5))))
    (if (i32.eq (local.get $stage) (i32.const 1)) (then
      (if (i32.ge_u (local.get $record) (local.get $tail)) (then
        (if (call $check_heap_overflow (i32.mul (global.get $NATIVE_CONTINUATION_STATE_SIZE) (i32.const 2))) (then (return (i32.const 2))))
        (call $native_continuation_state_set (local.get $scalar) (i32.const 0) (i32.const 2))
        (call $native_continuation_state_set (local.get $progress) (i32.const 1) (i32.const 16))
        (call $native_continuation_state_set (local.get $progress) (i32.const 3) (i32.const 16))
        (return (call $proof_native_transfer_range_begin (local.get $state) (i32.const 0) (local.get $mapping)
          (i32.const 0) (i32.const 0) (i32.const 0) (local.get $length) (global.get $PROOF_PH_COMPACT)))))
      (local.set $next (i32.load (call $abs (i32.add (i32.add (local.get $mapping) (i32.const 4)) (i32.shl (local.get $record) (i32.const 2))))))
      (local.set $words (call $proof_load (local.get $base) (local.get $next)))
      (if (i32.lt_u (local.get $field) (local.get $words)) (then
        (if (call $proof_record_edge_kind (local.get $base) (local.get $next) (local.get $field)) (then
          (local.set $child (call $proof_load (local.get $base) (i32.add (local.get $next) (i32.shl (local.get $field) (i32.const 2)))))
          (if (call $proof_native_mark_record_reference (local.get $marks) (local.get $child)) (then
            (i32.store (call $abs (i32.add (i32.add (local.get $mapping) (i32.const 4)) (i32.shl (local.get $tail) (i32.const 2)))) (local.get $child))
            (call $native_continuation_state_set (local.get $progress) (i32.const 3) (i32.add (local.get $tail) (i32.const 1)))))))
        (call $native_continuation_state_set (local.get $progress) (i32.const 2) (i32.add (local.get $field) (i32.const 1))))
        (else
          (call $native_continuation_state_set (local.get $progress) (i32.const 1) (i32.add (local.get $record) (i32.const 1)))
          (call $native_continuation_state_set (local.get $progress) (i32.const 2) (i32.const 2))))
      (return (i32.const 5))))
    (if (i32.eq (local.get $stage) (i32.const 2)) (then
      (if (i32.lt_u (local.get $record) (local.get $length)) (then
        (local.set $words (call $proof_load (local.get $base) (local.get $record)))
        (if (i32.and (i32.ne (local.get $record) (local.get $declarations))
            (i32.ne (i32.load (call $abs (i32.add (local.get $marks) (local.get $record)))) (i32.const 0))) (then
          (i32.store (call $abs (i32.add (i32.add (local.get $mapping) (i32.const 4)) (local.get $record))) (local.get $tail))
          (call $native_continuation_state_set (local.get $progress) (i32.const 3) (i32.add (local.get $tail) (i32.shl (local.get $words) (i32.const 2))))))
        (call $native_continuation_state_set (local.get $progress) (i32.const 1) (i32.add (local.get $record) (i32.shl (local.get $words) (i32.const 2))))
        (return (i32.const 5))))
      ;; The declaration array remains the final canonical record.
      (i32.store (call $abs (i32.add (i32.add (local.get $mapping) (i32.const 4)) (local.get $declarations))) (local.get $tail))
      (local.set $child (call $native_continuation_state_get (local.get $scalar) (i32.const 1)))
      (if (i32.eqz (i32.load (call $abs (i32.add (i32.add (local.get $mapping) (i32.const 4)) (local.get $child)))))
        (then (return (call $proof_native_op_fail (local.get $state) (global.get $BUILTIN_MSG_NOT_AN_OBJECT)))))
      (call $native_continuation_state_set (local.get $progress) (i32.const 3)
        (i32.add (local.get $tail) (i32.shl (call $proof_load (local.get $base) (local.get $declarations)) (i32.const 2))))
      (call $native_continuation_state_set (local.get $scalar) (i32.const 0) (i32.const 3))
      (return (i32.const 5))))
    (if (i32.eq (local.get $stage) (i32.const 3)) (then
      (local.set $workspace (call $native_continuation_state_get (local.get $scalar) (i32.const 3)))
      (if (i32.eq (local.get $workspace) (i32.const -1)) (then (local.set $workspace (call $proof_native_workspace_size (local.get $tail)))))
      (if (i32.eqz (local.get $workspace)) (then (local.set $workspace (local.get $tail))))
      (local.set $size (i64.add (i64.extend_i32_u (local.get $tail)) (i64.extend_i32_u (local.get $workspace))))
      (if (i64.gt_u (local.get $size) (i64.const 0xfffffff0))
        (then (return (call $proof_native_op_fail (local.get $state) (global.get $BUILTIN_MSG_NOT_AN_OBJECT)))))
      (local.set $allocation (i64.add (call $arraybuffer_size_i64 (i32.wrap_i64 (local.get $size)))
        (i64.extend_i32_u (i32.add (i32.const 24) (i32.mul (global.get $NATIVE_CONTINUATION_STATE_SIZE) (i32.const 2))))))
      (if (i64.gt_u (local.get $allocation) (i64.const 0xffffffff))
        (then (return (call $proof_native_op_fail (local.get $state) (global.get $BUILTIN_MSG_NOT_AN_OBJECT)))))
      (if (call $check_heap_overflow (i32.wrap_i64 (local.get $allocation))) (then (return (i32.const 2))))
      (local.set $buffer (call $allocate_arraybuffer_uninitialized (i32.wrap_i64 (local.get $size))))
      (local.set $child (call $native_continuation_state_get (local.get $scalar) (i32.const 1)))
      (local.set $mapped (i32.load (call $abs (i32.add (i32.add (local.get $mapping) (i32.const 4)) (local.get $child)))))
      (local.set $destination (call $proof_native_allocate_buffer_handle (local.get $buffer) (local.get $mapped)
        (global.get $PROOF_HANDLE_TERM) (i32.load (call $abs (i32.add (local.get $source) (i32.const 20))))))
      (call $native_continuation_state_set (local.get $aux) (i32.const 3) (local.get $destination))
      (call $native_continuation_state_set (local.get $scalar) (i32.const 0) (i32.const 4))
      (call $native_continuation_state_set (local.get $progress) (i32.const 1) (i32.const 16))
      (return (call $proof_native_transfer_range_begin (local.get $state) (i32.const 0) (local.get $buffer)
        (i32.const 0) (i32.const 0) (i32.const 0) (i32.wrap_i64 (local.get $size)) (global.get $PROOF_PH_COMPACT)))))
    (local.set $destination (call $native_continuation_state_get (local.get $aux) (i32.const 3)))
    (local.set $buffer (call $proof_native_handle_buffer (local.get $destination)))
    (if (i32.eq (local.get $stage) (i32.const 4)) (then
      (if (i32.eq (local.get $record) (i32.const 16)) (then
        (call $proof_native_initialize_artifact_header (i32.add (local.get $buffer) (i32.const 4)) (local.get $tail)
          (i32.load (call $abs (i32.add (i32.add (local.get $mapping) (i32.const 4)) (local.get $declarations)))))))
      (if (i32.lt_u (local.get $record) (local.get $length)) (then
        (local.set $words (call $proof_load (local.get $base) (local.get $record)))
        (local.set $mapped (i32.load (call $abs (i32.add (i32.add (local.get $mapping) (i32.const 4)) (local.get $record)))))
        (if (local.get $mapped) (then
          (if (call $check_heap_overflow (i32.mul (global.get $NATIVE_CONTINUATION_STATE_SIZE) (i32.const 2))) (then (return (i32.const 2))))
          (call $native_continuation_state_set (local.get $progress) (i32.const 1) (i32.add (local.get $record) (i32.shl (local.get $words) (i32.const 2))))
          (return (call $proof_native_transfer_range_begin (local.get $state) (call $proof_native_handle_buffer (local.get $source)) (local.get $buffer)
            (local.get $record) (local.get $mapped) (i32.shl (local.get $words) (i32.const 2)) (i32.const 0) (global.get $PROOF_PH_COMPACT)))))
        (call $native_continuation_state_set (local.get $progress) (i32.const 1) (i32.add (local.get $record) (i32.shl (local.get $words) (i32.const 2))))
        (return (i32.const 5))))
      (call $native_continuation_state_set (local.get $scalar) (i32.const 0) (i32.const 5))
      (call $native_continuation_state_set (local.get $progress) (i32.const 1) (i32.const 16))
      (call $native_continuation_state_set (local.get $progress) (i32.const 2) (i32.const 2))
      (return (i32.const 5))))
    (local.set $base (i32.add (local.get $buffer) (i32.const 4)))
    (if (i32.lt_u (local.get $record) (local.get $tail)) (then
      (local.set $words (call $proof_load (local.get $base) (local.get $record)))
      (if (i32.lt_u (local.get $field) (local.get $words)) (then
        (if (call $proof_record_edge_kind (local.get $base) (local.get $record) (local.get $field)) (then
          (local.set $child (i32.add (local.get $record) (i32.shl (local.get $field) (i32.const 2))))
          (call $proof_store (local.get $base) (local.get $child)
            (call $proof_native_relocated_reference (call $proof_load (local.get $base) (local.get $child)) (i32.const 0) (local.get $mapping)))))
        (call $native_continuation_state_set (local.get $progress) (i32.const 2) (i32.add (local.get $field) (i32.const 1))))
        (else
          (call $native_continuation_state_set (local.get $progress) (i32.const 1) (i32.add (local.get $record) (i32.shl (local.get $words) (i32.const 2))))
          (call $native_continuation_state_set (local.get $progress) (i32.const 2) (i32.const 2))))
      (return (i32.const 5))))
    (local.set $meta (call $native_continuation_state_get (local.get $aux) (i32.const 0)))
    (call $native_continuation_state_set (local.get $meta) (i32.const 1) (call $proof_native_handle_root (local.get $destination)))
    (call $native_continuation_state_set (local.get $meta) (i32.const 3) (local.get $tail))
    (call $native_continuation_state_set (local.get $state) (i32.const 1) (local.get $destination))
    (call $native_continuation_state_set (local.get $state) (i32.const 2) (local.get $meta))
    (call $native_continuation_state_set (local.get $state) (i32.const 3) (i32.const 0))
    (call $native_continuation_state_set (local.get $state) (i32.const 4) (i32.const 0))
    (call $native_continuation_state_set (local.get $state) (i32.const 0)
      (i32.and (call $native_continuation_state_get (local.get $state) (i32.const 0)) (i32.const 0xfdffffff)))
    (call $proof_native_phase (local.get $state) (call $native_continuation_state_get (local.get $progress) (i32.const 0)))
    (i32.const 5))

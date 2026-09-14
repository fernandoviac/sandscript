(module
  ;; Standalone SandScript RegExp engine. The module owns no memory: every
  ;; address is an absolute offset into caller-owned shared linear memory.
  (import "env" "memory" (memory 1 16384 shared))

  ;; ABI status values. Must match regex-engine-contract.js.
  (global $STATUS_OK i32 (i32.const 0))
  (global $STATUS_PAUSED i32 (i32.const 1))
  (global $STATUS_MATCH i32 (i32.const 2))
  (global $STATUS_NO_MATCH i32 (i32.const 3))
  (global $STATUS_SYNTAX_ERROR i32 (i32.const 4))
  (global $STATUS_UNSUPPORTED i32 (i32.const 5))
  (global $STATUS_LIMIT_EXCEEDED i32 (i32.const 6))
  (global $STATUS_BUFFER_TOO_SMALL i32 (i32.const 7))
  (global $STATUS_CORRUPT_PROGRAM i32 (i32.const 8))
  (global $STATUS_INVALID_UTF8 i32 (i32.const 9))

  (global $MAX_PATTERN_BYTES i32 (i32.const 65536))
  (global $MAX_BYTECODE_INSTRUCTIONS i32 (i32.const 4096))
  (global $MAX_CAPTURE_GROUPS i32 (i32.const 32))
  (global $MAX_CHARACTER_CLASS_RANGES i32 (i32.const 1024))
  (global $PROGRAM_HEADER_SIZE i32 (i32.const 40))
  (global $INSTRUCTION_SIZE i32 (i32.const 16))
  (global $RANGE_SIZE i32 (i32.const 8))
  (global $NAME_HEADER_SIZE i32 (i32.const 8))
  (global $CONTINUATION_HEADER_SIZE i32 (i32.const 128))
  (global $THREAD_HEADER_SIZE i32 (i32.const 8))
  (global $PROGRAM_MAGIC i32 (i32.const 0x53535258))
  (global $CONTINUATION_MAGIC i32 (i32.const 0x53535243))
  (global $FORMAT_VERSION i32 (i32.const 1))

  (global $FLAG_GLOBAL i32 (i32.const 1))
  (global $FLAG_IGNORE_CASE i32 (i32.const 2))
  (global $FLAG_MULTILINE i32 (i32.const 4))
  (global $FLAG_DOT_ALL i32 (i32.const 8))
  (global $FLAG_HAS_INDICES i32 (i32.const 32))
  (global $FLAG_STICKY i32 (i32.const 128))

  (global $SCAN_HEADER_SIZE i32 (i32.const 128))
  (global $SCAN_MAGIC i32 (i32.const 0x53525343))
  (global $MEASUREMENT_HEADER_SIZE i32 (i32.const 56))
  (global $GROUP_STACK_ENTRY_SIZE i32 (i32.const 8))
  (global $MEASUREMENT_MAGIC i32 (i32.const 0x53524d57))
  (global $EMIT_HEADER_SIZE i32 (i32.const 160))
  (global $EMIT_STACK_ENTRY_SIZE i32 (i32.const 24))
  (global $EMIT_MAGIC i32 (i32.const 0x53524543))
  (global $EMIT_MODE_NORMAL i32 (i32.const 0))
  (global $EMIT_MODE_CLASS i32 (i32.const 1))
  (global $EMIT_MODE_CLASS_ESCAPE i32 (i32.const 2))
  (global $EMIT_MODE_AFTER_GROUP_OPEN i32 (i32.const 3))
  (global $EMIT_MODE_GROUP_QUESTION i32 (i32.const 4))
  (global $EMIT_MODE_GROUP_LESS i32 (i32.const 5))
  (global $EMIT_MODE_NAMED_GROUP i32 (i32.const 6))
  (global $EMIT_MODE_AFTER_QUANTIFIER i32 (i32.const 7))
  (global $EMIT_MODE_BRACE_START i32 (i32.const 8))
  (global $EMIT_MODE_BRACE_MINIMUM i32 (i32.const 9))
  (global $EMIT_MODE_BRACE_AFTER_COMMA i32 (i32.const 10))
  (global $EMIT_MODE_BRACE_MAXIMUM i32 (i32.const 11))
  (global $EMIT_MODE_BOUNDED_READY i32 (i32.const 12))
  (global $SCAN_MODE_NORMAL i32 (i32.const 0))
  (global $SCAN_MODE_ESCAPE i32 (i32.const 1))
  (global $SCAN_MODE_CLASS i32 (i32.const 2))
  (global $SCAN_MODE_CLASS_ESCAPE i32 (i32.const 3))
  (global $SCAN_MODE_AFTER_GROUP_OPEN i32 (i32.const 4))
  (global $SCAN_MODE_GROUP_QUESTION i32 (i32.const 5))
  (global $SCAN_MODE_GROUP_LESS i32 (i32.const 6))
  (global $SCAN_MODE_NAMED_GROUP i32 (i32.const 7))
  (global $SCAN_MODE_AFTER_QUANTIFIER i32 (i32.const 8))
  (global $SCAN_MODE_BRACE_START i32 (i32.const 9))
  (global $SCAN_MODE_BRACE_MINIMUM i32 (i32.const 10))
  (global $SCAN_MODE_BRACE_AFTER_COMMA i32 (i32.const 11))
  (global $SCAN_MODE_BRACE_MAXIMUM i32 (i32.const 12))

  ;; Version 1 instruction records. Every record is
  ;; [opcode, first operand, second operand, third operand].
  (global $OPCODE_CHARACTER i32 (i32.const 0))
  (global $OPCODE_ANY i32 (i32.const 1))
  (global $OPCODE_CHARACTER_CLASS i32 (i32.const 2))
  (global $OPCODE_NEGATED_CHARACTER_CLASS i32 (i32.const 3))
  (global $OPCODE_SPLIT i32 (i32.const 4))
  (global $OPCODE_JUMP i32 (i32.const 5))
  (global $OPCODE_SAVE i32 (i32.const 6))
  (global $OPCODE_ASSERT_START i32 (i32.const 7))
  (global $OPCODE_ASSERT_END i32 (i32.const 8))
  (global $OPCODE_MATCH i32 (i32.const 9))
  ;; Reset every capture slot of a quantified atom's groups at each loop-body
  ;; entry: [first slot, slot count, next]. Reproduces JavaScript's
  ;; per-iteration capture clearing.
  (global $OPCODE_CLEAR_CAPTURES i32 (i32.const 10))
  ;; Kill the thread when no input was consumed since the recorded guard
  ;; slot: [guard slot, next]. Reproduces JavaScript's rule that an
  ;; optional quantifier iteration matching empty is discarded.
  (global $OPCODE_GUARD i32 (i32.const 11))

  ;; Resumable Pike VM phases stored in the continuation header.
  (global $PHASE_POSITION i32 (i32.const 0))
  (global $PHASE_PROCESS i32 (i32.const 1))
  (global $PHASE_COMPLETE i32 (i32.const 2))

  (func $checked_add (param $left i32) (param $right i32) (result i32)
    (local $sum i32)
    (local.set $sum (i32.add (local.get $left) (local.get $right)))
    (if (i32.lt_u (local.get $sum) (local.get $left))
      (then (return (i32.const -1))))
    (local.get $sum))

  (func $checked_mul (param $left i32) (param $right i32) (result i32)
    (local $product i64)
    (local.set $product
      (i64.mul (i64.extend_i32_u (local.get $left))
               (i64.extend_i32_u (local.get $right))))
    (if (i64.gt_u (local.get $product) (i64.const 0xffffffff))
      (then (return (i32.const -1))))
    (i32.wrap_i64 (local.get $product)))

  ;; Exact program bytes for a measured instruction/range/name payload.
  ;; Returns -1 on overflow or a hard-limit violation.
  (func $program_size (export "program_size")
    (param $instruction_count i32)
    (param $range_count i32)
    (param $name_bytes i32)
    (result i32)
    (local $instruction_bytes i32)
    (local $range_bytes i32)
    (local $total i32)
    (if (i32.gt_u (local.get $instruction_count)
                  (global.get $MAX_BYTECODE_INSTRUCTIONS))
      (then (return (i32.const -1))))
    (if (i32.gt_u (local.get $range_count)
                  (global.get $MAX_CHARACTER_CLASS_RANGES))
      (then (return (i32.const -1))))
    (local.set $instruction_bytes
      (call $checked_mul (local.get $instruction_count)
                         (global.get $INSTRUCTION_SIZE)))
    (if (i32.eq (local.get $instruction_bytes) (i32.const -1))
      (then (return (i32.const -1))))
    ;; Each range is two scalar-value u32s.
    (local.set $range_bytes
      (call $checked_mul (local.get $range_count) (i32.const 8)))
    (if (i32.eq (local.get $range_bytes) (i32.const -1))
      (then (return (i32.const -1))))
    (local.set $total
      (call $checked_add (global.get $PROGRAM_HEADER_SIZE)
                         (local.get $instruction_bytes)))
    (if (i32.eq (local.get $total) (i32.const -1))
      (then (return (i32.const -1))))
    (local.set $total (call $checked_add (local.get $total) (local.get $range_bytes)))
    (if (i32.eq (local.get $total) (i32.const -1))
      (then (return (i32.const -1))))
    (call $checked_add (local.get $total) (local.get $name_bytes)))

  ;; Exact instruction count for one already-parsed atom after quantifier
  ;; expansion. An all-one maximum is unbounded. Optional copies each need one
  ;; ordered SPLIT; an unbounded tail needs one ordered SPLIT. When the atom
  ;; contains capture groups and the quantifier can iterate more than once,
  ;; each loop-body re-entry needs one CLEAR: bounded expansions place one
  ;; before every copy after the first, and unbounded loops reuse one CLEAR
  ;; on the loop edge (before the final required copy when the minimum
  ;; exceeds one).
  (func $quantified_instruction_count (export "quantified_instruction_count")
    (param $atom_instructions i32)
    (param $minimum i32)
    (param $maximum i32)
    (param $captured_atom i32)
    (result i32)
    (local $copies i32)
    (local $optional_splits i32)
    (local $clear_count i32)
    (local $total i32)
    (if
      (i32.gt_u
        (local.get $atom_instructions)
        (global.get $MAX_BYTECODE_INSTRUCTIONS))
      (then (return (i32.const -1))))
    (if
      (i32.gt_u
        (local.get $minimum)
        (global.get $MAX_BYTECODE_INSTRUCTIONS))
      (then (return (i32.const -1))))
    (if (i32.eqz (local.get $atom_instructions))
      (then
        (if
          (i32.and
            (i32.ne (local.get $maximum) (i32.const -1))
            (i32.or
              (i32.gt_u
                (local.get $maximum)
                (global.get $MAX_BYTECODE_INSTRUCTIONS))
              (i32.lt_u (local.get $maximum) (local.get $minimum))))
          (then (return (i32.const -1))))
        (return (i32.const 0))))
    (if (i32.eq (local.get $maximum) (i32.const -1))
      (then
        (if (i32.eqz (local.get $minimum))
          (then
            (local.set $copies (local.get $atom_instructions)))
          (else
            (local.set $copies
              (call $checked_mul
                (local.get $atom_instructions)
                (local.get $minimum)))))
        (if (i32.eq (local.get $copies) (i32.const -1))
          (then (return (i32.const -1))))
        (if (local.get $captured_atom)
          (then
            (local.set $clear_count
              (if (result i32)
                (i32.gt_u (local.get $minimum) (i32.const 1))
                (then (i32.sub (local.get $minimum) (i32.const 1)))
                (else (i32.const 1))))))
        (local.set $total
          (call $checked_add (local.get $copies) (i32.const 1))))
      (else
        (if
          (i32.or
            (i32.gt_u
              (local.get $maximum)
              (global.get $MAX_BYTECODE_INSTRUCTIONS))
            (i32.lt_u (local.get $maximum) (local.get $minimum)))
          (then (return (i32.const -1))))
        (local.set $copies
          (call $checked_mul
            (local.get $atom_instructions)
            (local.get $maximum)))
        (if (i32.eq (local.get $copies) (i32.const -1))
          (then (return (i32.const -1))))
        (local.set $optional_splits
          (i32.sub (local.get $maximum) (local.get $minimum)))
        (if
          (i32.and
            (local.get $captured_atom)
            (i32.gt_u (local.get $maximum) (i32.const 1)))
          (then
            (local.set $clear_count
              (i32.sub (local.get $maximum) (i32.const 1)))))
        ;; Every optional copy carries an empty-iteration guard: one SAVE
        ;; recording its entry position and one GUARD checking progress.
        (local.set $total
          (call $checked_add
            (local.get $copies)
            (i32.mul (local.get $optional_splits) (i32.const 3))))))
    (if (i32.ne (local.get $total) (i32.const -1))
      (then
        (local.set $total
          (call $checked_add (local.get $total) (local.get $clear_count)))))
    (if
      (i32.or
        (i32.eq (local.get $total) (i32.const -1))
        (i32.gt_u
          (local.get $total)
          (global.get $MAX_BYTECODE_INSTRUCTIONS)))
      (then (return (i32.const -1))))
    (local.get $total))

  ;; Replace the most recently measured atom in an enclosing fragment with its
  ;; quantified expansion.
  (func $measurement_apply_quantifier (export "measurement_apply_quantifier")
    (param $instruction_count i32)
    (param $atom_instruction_count i32)
    (param $minimum i32)
    (param $maximum i32)
    (param $captured_atom i32)
    (result i32)
    (local $quantified_count i32)
    (local $prefix_count i32)
    (local $total i32)
    (if
      (i32.lt_u
        (local.get $instruction_count)
        (local.get $atom_instruction_count))
      (then (return (i32.const -1))))
    (local.set $quantified_count
      (call $quantified_instruction_count
        (local.get $atom_instruction_count)
        (local.get $minimum)
        (local.get $maximum)
        (local.get $captured_atom)))
    (if (i32.eq (local.get $quantified_count) (i32.const -1))
      (then (return (i32.const -1))))
    (local.set $prefix_count
      (i32.sub
        (local.get $instruction_count)
        (local.get $atom_instruction_count)))
    (local.set $total
      (call $checked_add
        (local.get $prefix_count)
        (local.get $quantified_count)))
    (if
      (i32.or
        (i32.eq (local.get $total) (i32.const -1))
        (i32.gt_u
          (local.get $total)
          (global.get $MAX_BYTECODE_INSTRUCTIONS)))
      (then (return (i32.const -1))))
    (local.get $total))

  ;; The measurement pass needs one instruction-count checkpoint per possible
  ;; group opener plus the root fragment. Pattern bytes are the safe upper
  ;; bound on group depth before UTF-8 decoding.
  (func $measurement_workspace_size (export "measurement_workspace_size")
    (param $pattern_bytes i32)
    (result i32)
    (local $stack_entries i32)
    (local $stack_bytes i32)
    (if (i32.gt_u (local.get $pattern_bytes) (global.get $MAX_PATTERN_BYTES))
      (then (return (i32.const -1))))
    (local.set $stack_entries
      (call $checked_add (local.get $pattern_bytes) (i32.const 1)))
    (if (i32.eq (local.get $stack_entries) (i32.const -1))
      (then (return (i32.const -1))))
    (local.set $stack_bytes
      (call $checked_mul
        (local.get $stack_entries)
        (global.get $GROUP_STACK_ENTRY_SIZE)))
    (if (i32.eq (local.get $stack_bytes) (i32.const -1))
      (then (return (i32.const -1))))
    (call $checked_add
      (global.get $MEASUREMENT_HEADER_SIZE)
      (local.get $stack_bytes)))

  (func $validate_measurement_workspace
    (param $workspace_address i32)
    (param $workspace_capacity i32)
    (param $pattern_bytes i32)
    (result i32)
    (local $required_bytes i32)
    (local $memory_bytes i64)
    (local.set $required_bytes
      (call $measurement_workspace_size (local.get $pattern_bytes)))
    (if
      (i32.or
        (i32.eq (local.get $required_bytes) (i32.const -1))
        (i32.lt_u
          (local.get $workspace_capacity)
          (local.get $required_bytes)))
      (then (return (global.get $STATUS_BUFFER_TOO_SMALL))))
    (local.set $memory_bytes
      (i64.mul (i64.extend_i32_u (memory.size)) (i64.const 65536)))
    (if
      (i64.gt_u
        (i64.add
          (i64.extend_i32_u (local.get $workspace_address))
          (i64.extend_i32_u (local.get $required_bytes)))
        (local.get $memory_bytes))
      (then (return (global.get $STATUS_BUFFER_TOO_SMALL))))
    (if
      (i32.or
        (i32.ne
          (i32.load (local.get $workspace_address))
          (global.get $MEASUREMENT_MAGIC))
        (i32.or
          (i32.ne
            (i32.load offset=4 (local.get $workspace_address))
            (global.get $STATE_VERSION))
          (i32.ne
            (i32.load offset=12 (local.get $workspace_address))
            (local.get $pattern_bytes))))
      (then (return (global.get $STATUS_CORRUPT_PROGRAM))))
    (if
      (i32.gt_u
        (i32.load offset=8 (local.get $workspace_address))
        (local.get $pattern_bytes))
      (then (return (global.get $STATUS_CORRUPT_PROGRAM))))
    (if
      (i32.or
        (i32.gt_u
          (i32.load offset=16 (local.get $workspace_address))
          (global.get $MAX_BYTECODE_INSTRUCTIONS))
        (i32.or
          (i32.gt_u
            (i32.load offset=20 (local.get $workspace_address))
            (i32.load offset=16 (local.get $workspace_address)))
          (i32.or
            (i32.gt_u
              (i32.load offset=24 (local.get $workspace_address))
              (global.get $MAX_CAPTURE_GROUPS))
            (i32.gt_u
              (i32.load offset=28 (local.get $workspace_address))
              (global.get $MAX_BYTECODE_INSTRUCTIONS)))))
      (then (return (global.get $STATUS_CORRUPT_PROGRAM))))
    (global.get $STATUS_OK))

  (func $initialize_measurement_workspace_impl
    (param $workspace_address i32)
    (param $workspace_capacity i32)
    (param $pattern_bytes i32)
    (param $root_instruction_count i32)
    (result i32)
    (local $required_bytes i32)
    (local $memory_bytes i64)
    (call $work_add (i32.const 3))
    (local.set $required_bytes
      (call $measurement_workspace_size (local.get $pattern_bytes)))
    (if
      (i32.or
        (i32.eq (local.get $required_bytes) (i32.const -1))
        (i32.lt_u
          (local.get $workspace_capacity)
          (local.get $required_bytes)))
      (then (return (global.get $STATUS_BUFFER_TOO_SMALL))))
    (if
      (i32.gt_u
        (local.get $root_instruction_count)
        (global.get $MAX_BYTECODE_INSTRUCTIONS))
      (then (return (global.get $STATUS_LIMIT_EXCEEDED))))
    (local.set $memory_bytes
      (i64.mul (i64.extend_i32_u (memory.size)) (i64.const 65536)))
    (if
      (i64.gt_u
        (i64.add
          (i64.extend_i32_u (local.get $workspace_address))
          (i64.extend_i32_u (local.get $required_bytes)))
        (local.get $memory_bytes))
      (then (return (global.get $STATUS_BUFFER_TOO_SMALL))))
    (call $work_fill (i32.add (local.get $workspace_address) (i32.const 32)) (i32.const 0) (i32.const 24))
    (i32.store
      (local.get $workspace_address)
      (global.get $MEASUREMENT_MAGIC))
    (i32.store offset=4
      (local.get $workspace_address)
      (global.get $STATE_VERSION))
    (i32.store offset=8
      (local.get $workspace_address)
      (i32.const 0))
    (i32.store offset=12
      (local.get $workspace_address)
      (local.get $pattern_bytes))
    (i32.store offset=16
      (local.get $workspace_address)
      (local.get $root_instruction_count))
    (i32.store offset=20
      (local.get $workspace_address)
      (i32.const 0))
    (i32.store offset=24
      (local.get $workspace_address)
      (i32.const 0))
    (i32.store offset=28
      (local.get $workspace_address)
      (i32.const 0))
    ;; Root fragment checkpoint: instruction count plus capture count zero.
    (i32.store offset=56
      (local.get $workspace_address)
      (local.get $root_instruction_count))
    (i32.store offset=60
      (local.get $workspace_address)
      (i32.const 0))
    (global.get $STATUS_OK))

  (func $measurement_push_group_impl
    (param $workspace_address i32)
    (param $workspace_capacity i32)
    (param $pattern_bytes i32)
    (param $capture_group_count i32)
    (result i32)
    (local $status i32)
    (local $depth i32)
    (local $entry_address i32)
    (call $work_add (i32.const 1))
    (local.set $status
      (call $validate_measurement_workspace
        (local.get $workspace_address)
        (local.get $workspace_capacity)
        (local.get $pattern_bytes)))
    (if (i32.ne (local.get $status) (global.get $STATUS_OK))
      (then (return (local.get $status))))
    (if
      (i32.gt_u
        (local.get $capture_group_count)
        (global.get $MAX_CAPTURE_GROUPS))
      (then (return (global.get $STATUS_CORRUPT_PROGRAM))))
    (local.set $depth
      (i32.load offset=8 (local.get $workspace_address)))
    (if (i32.ge_u (local.get $depth) (local.get $pattern_bytes))
      (then (return (global.get $STATUS_LIMIT_EXCEEDED))))
    (local.set $entry_address
      (i32.add
        (i32.add
          (local.get $workspace_address)
          (global.get $MEASUREMENT_HEADER_SIZE))
        (i32.mul
          (i32.add (local.get $depth) (i32.const 1))
          (global.get $GROUP_STACK_ENTRY_SIZE))))
    (i32.store
      (local.get $entry_address)
      (i32.load offset=16 (local.get $workspace_address)))
    (i32.store offset=4
      (local.get $entry_address)
      (local.get $capture_group_count))
    (i32.store offset=8
      (local.get $workspace_address)
      (i32.add (local.get $depth) (i32.const 1)))
    (i32.store offset=20
      (local.get $workspace_address)
      (i32.const 0))
    (i32.store offset=24
      (local.get $workspace_address)
      (i32.const 0))
    (global.get $STATUS_OK))

  (func $measurement_pop_group_impl
    (param $workspace_address i32)
    (param $workspace_capacity i32)
    (param $pattern_bytes i32)
    (param $capture_group_count i32)
    (result i32 i32)
    (local $status i32)
    (local $depth i32)
    (local $entry_address i32)
    (local $instruction_count i32)
    (local $start_instruction_count i32)
    (local $group_instruction_count i32)
    (local $capture_checkpoint i32)
    (call $work_add (i32.const 1))
    (local.set $status
      (call $validate_measurement_workspace
        (local.get $workspace_address)
        (local.get $workspace_capacity)
        (local.get $pattern_bytes)))
    (if (i32.ne (local.get $status) (global.get $STATUS_OK))
      (then (return (local.get $status) (i32.const 0))))
    (if
      (i32.gt_u
        (local.get $capture_group_count)
        (global.get $MAX_CAPTURE_GROUPS))
      (then
        (return
          (global.get $STATUS_CORRUPT_PROGRAM)
          (i32.const 0))))
    (local.set $depth
      (i32.load offset=8 (local.get $workspace_address)))
    (if (i32.eqz (local.get $depth))
      (then
        (return
          (global.get $STATUS_CORRUPT_PROGRAM)
          (i32.const 0))))
    (local.set $instruction_count
      (i32.load offset=16 (local.get $workspace_address)))
    (local.set $entry_address
      (i32.add
        (i32.add
          (local.get $workspace_address)
          (global.get $MEASUREMENT_HEADER_SIZE))
        (i32.mul
          (local.get $depth)
          (global.get $GROUP_STACK_ENTRY_SIZE))))
    (local.set $start_instruction_count
      (i32.load (local.get $entry_address)))
    (local.set $capture_checkpoint
      (i32.load offset=4 (local.get $entry_address)))
    (if
      (i32.or
        (i32.lt_u
          (local.get $instruction_count)
          (local.get $start_instruction_count))
        (i32.lt_u
          (local.get $capture_group_count)
          (local.get $capture_checkpoint)))
      (then
        (return
          (global.get $STATUS_CORRUPT_PROGRAM)
          (i32.const 0))))
    (local.set $group_instruction_count
      (i32.sub
        (local.get $instruction_count)
        (local.get $start_instruction_count)))
    (i32.store offset=8
      (local.get $workspace_address)
      (i32.sub (local.get $depth) (i32.const 1)))
    (i32.store offset=20
      (local.get $workspace_address)
      (local.get $group_instruction_count))
    (i32.store offset=24
      (local.get $workspace_address)
      (i32.sub
        (local.get $capture_group_count)
        (local.get $capture_checkpoint)))
    (global.get $STATUS_OK)
    (local.get $group_instruction_count))

  (func $measurement_add_atom_impl
    (param $workspace_address i32)
    (param $workspace_capacity i32)
    (param $pattern_bytes i32)
    (param $atom_instruction_count i32)
    (result i32)
    (local $status i32)
    (local $total i32)
    (call $work_add (i32.const 1))
    (local.set $status
      (call $validate_measurement_workspace
        (local.get $workspace_address)
        (local.get $workspace_capacity)
        (local.get $pattern_bytes)))
    (if (i32.ne (local.get $status) (global.get $STATUS_OK))
      (then (return (local.get $status))))
    (if (i32.eqz (local.get $atom_instruction_count))
      (then (return (global.get $STATUS_CORRUPT_PROGRAM))))
    (local.set $total
      (call $checked_add
        (i32.load offset=16 (local.get $workspace_address))
        (local.get $atom_instruction_count)))
    (if
      (i32.or
        (i32.eq (local.get $total) (i32.const -1))
        (i32.gt_u
          (local.get $total)
          (global.get $MAX_BYTECODE_INSTRUCTIONS)))
      (then (return (global.get $STATUS_LIMIT_EXCEEDED))))
    (i32.store offset=16
      (local.get $workspace_address)
      (local.get $total))
    (i32.store offset=20
      (local.get $workspace_address)
      (local.get $atom_instruction_count))
    (i32.store offset=24
      (local.get $workspace_address)
      (i32.const 0))
    (global.get $STATUS_OK))

  (func $measurement_add_control
    (param $workspace_address i32)
    (param $workspace_capacity i32)
    (param $pattern_bytes i32)
    (param $instruction_count i32)
    (result i32)
    (local $status i32)
    (call $work_add (i32.const 1))
    (local.set $status
      (call $measurement_add_atom
        (local.get $workspace_address)
        (local.get $workspace_capacity)
        (local.get $pattern_bytes)
        (local.get $instruction_count)))
    (if (i32.ne (local.get $status) (global.get $STATUS_OK))
      (then (return (local.get $status))))
    (i32.store offset=20
      (local.get $workspace_address)
      (i32.const 0))
    (global.get $STATUS_OK))

  (func $measurement_apply_last_quantifier_impl
    (param $workspace_address i32)
    (param $workspace_capacity i32)
    (param $pattern_bytes i32)
    (param $minimum i32)
    (param $maximum i32)
    (result i32)
    (local $status i32)
    (local $instruction_count i32)
    (local $last_atom_instruction_count i32)
    (local $total i32)
    (call $work_add (i32.const 1))
    (local.set $status
      (call $validate_measurement_workspace
        (local.get $workspace_address)
        (local.get $workspace_capacity)
        (local.get $pattern_bytes)))
    (if (i32.ne (local.get $status) (global.get $STATUS_OK))
      (then (return (local.get $status))))
    (local.set $instruction_count
      (i32.load offset=16 (local.get $workspace_address)))
    (local.set $last_atom_instruction_count
      (i32.load offset=20 (local.get $workspace_address)))
    (local.set $total
      (call $measurement_apply_quantifier
        (local.get $instruction_count)
        (local.get $last_atom_instruction_count)
        (local.get $minimum)
        (local.get $maximum)
        (i32.ne
          (i32.load offset=24 (local.get $workspace_address))
          (i32.const 0))))
    (if (i32.eq (local.get $total) (i32.const -1))
      (then (return (global.get $STATUS_LIMIT_EXCEEDED))))
    (i32.store offset=16
      (local.get $workspace_address)
      (local.get $total))
    (i32.store offset=20
      (local.get $workspace_address)
      (i32.sub
        (local.get $total)
        (i32.sub
          (local.get $instruction_count)
          (local.get $last_atom_instruction_count))))
    ;; Bounded quantifiers with optional copies allocate one hidden guard
    ;; slot; unbounded loops need none, because their loop split kills an
    ;; empty iteration through instruction deduplication.
    (if
      (i32.and
        (i32.ne (local.get $last_atom_instruction_count) (i32.const 0))
        (i32.and
          (i32.ne (local.get $maximum) (i32.const -1))
          (i32.gt_u (local.get $maximum) (local.get $minimum))))
      (then
        (i32.store offset=28
          (local.get $workspace_address)
          (i32.add
            (i32.load offset=28 (local.get $workspace_address))
            (i32.const 1)))))
    (global.get $STATUS_OK))
  ;; Exact continuation bytes. Every thread record owns an instruction
  ;; pointer, one reserved word, two byte offsets for group zero plus every
  ;; explicit group, and one hidden slot per empty-iteration guard. The
  ;; buffer stores the candidate slot record, the current and next ordered
  ;; thread lists, the closure priority stack, and one u32 dedup generation
  ;; per instruction.
  (func $continuation_size (export "continuation_size")
    (param $instruction_count i32)
    (param $capture_group_count i32)
    (param $guard_slots i32)
    (result i32)
    (local $capture_bytes i32)
    (local $thread_bytes i32)
    (local $list_bytes i32)
    (local $dedup_bytes i32)
    (local $total i32)
    (if (i32.gt_u (local.get $instruction_count)
                  (global.get $MAX_BYTECODE_INSTRUCTIONS))
      (then (return (i32.const -1))))
    (if (i32.gt_u (local.get $capture_group_count)
                  (global.get $MAX_CAPTURE_GROUPS))
      (then (return (i32.const -1))))
    (if (i32.gt_u (local.get $guard_slots)
                  (global.get $MAX_BYTECODE_INSTRUCTIONS))
      (then (return (i32.const -1))))
    (local.set $capture_bytes
      (call $checked_mul
        (call $checked_add
          (i32.mul (i32.add (local.get $capture_group_count) (i32.const 1))
                   (i32.const 2))
          (local.get $guard_slots))
        (i32.const 4)))
    (if (i32.eq (local.get $capture_bytes) (i32.const -1))
      (then (return (i32.const -1))))
    (local.set $thread_bytes
      (call $checked_add (global.get $THREAD_HEADER_SIZE)
                         (local.get $capture_bytes)))
    (if (i32.eq (local.get $thread_bytes) (i32.const -1))
      (then (return (i32.const -1))))
    (local.set $list_bytes
      (call $checked_mul (local.get $instruction_count)
                         (local.get $thread_bytes)))
    (if (i32.eq (local.get $list_bytes) (i32.const -1))
      (then (return (i32.const -1))))
    (local.set $list_bytes (call $checked_mul (local.get $list_bytes) (i32.const 3)))
    (if (i32.eq (local.get $list_bytes) (i32.const -1))
      (then (return (i32.const -1))))
    (local.set $dedup_bytes
      (call $checked_mul (local.get $instruction_count) (i32.const 4)))
    (local.set $total
      (call $checked_add (global.get $CONTINUATION_HEADER_SIZE)
                         (local.get $capture_bytes)))
    (if (i32.eq (local.get $total) (i32.const -1))
      (then (return (i32.const -1))))
    (local.set $total
      (call $checked_add (local.get $total) (local.get $list_bytes)))
    (if (i32.eq (local.get $total) (i32.const -1))
      (then (return (i32.const -1))))
    (call $checked_add (local.get $total) (local.get $dedup_bytes)))

  (func $valid_scalar (param $value i32) (result i32)
    (if (i32.gt_u (local.get $value) (i32.const 0x10ffff))
      (then (return (i32.const 0))))
    (if
      (i32.and
        (i32.ge_u (local.get $value) (i32.const 0xd800))
        (i32.le_u (local.get $value) (i32.const 0xdfff)))
      (then (return (i32.const 0))))
    (i32.const 1))

  ;; Decode one UTF-8 scalar. The low word is the scalar and the high word is
  ;; the next byte address. All-one bits report malformed or truncated input.
  (func $decode_scalar
    (param $cursor i32)
    (param $end i32)
    (result i64)
    (local $first_byte i32)
    (local $second_byte i32)
    (local $third_byte i32)
    (local $fourth_byte i32)
    (local $scalar i32)
    (local $next_cursor i32)
    (if (i32.ge_u (local.get $cursor) (local.get $end))
      (then (return (i64.const -1))))
    (local.set $first_byte (call $work_byte (local.get $cursor)))

    (if (i32.lt_u (local.get $first_byte) (i32.const 0x80))
      (then
        (local.set $scalar (local.get $first_byte))
        (local.set $next_cursor
          (i32.add (local.get $cursor) (i32.const 1))))
      (else
        (if
          (i32.and
            (i32.ge_u (local.get $first_byte) (i32.const 0xc2))
            (i32.le_u (local.get $first_byte) (i32.const 0xdf)))
          (then
            (if
              (i32.lt_u
                (i32.sub (local.get $end) (local.get $cursor))
                (i32.const 2))
              (then (return (i64.const -1))))
            (local.set $second_byte
              (call $work_byte (i32.add (local.get $cursor) (i32.const 1))))
            (if
              (i32.ne
                (i32.and (local.get $second_byte) (i32.const 0xc0))
                (i32.const 0x80))
              (then (return (i64.const -1))))
            (local.set $scalar
              (i32.or
                (i32.shl
                  (i32.and (local.get $first_byte) (i32.const 0x1f))
                  (i32.const 6))
                (i32.and
                  (local.get $second_byte)
                  (i32.const 0x3f))))
            (local.set $next_cursor
              (i32.add (local.get $cursor) (i32.const 2))))
          (else
            (if
              (i32.and
                (i32.ge_u (local.get $first_byte) (i32.const 0xe0))
                (i32.le_u (local.get $first_byte) (i32.const 0xef)))
              (then
                (if
                  (i32.lt_u
                    (i32.sub (local.get $end) (local.get $cursor))
                    (i32.const 3))
                  (then (return (i64.const -1))))
                (local.set $second_byte
                  (call $work_byte (i32.add (local.get $cursor) (i32.const 1))))
                (local.set $third_byte
                  (call $work_byte (i32.add (local.get $cursor) (i32.const 2))))
                (if
                  (i32.or
                    (i32.ne
                      (i32.and (local.get $second_byte) (i32.const 0xc0))
                      (i32.const 0x80))
                    (i32.ne
                      (i32.and (local.get $third_byte) (i32.const 0xc0))
                      (i32.const 0x80)))
                  (then (return (i64.const -1))))
                (if
                  (i32.and
                    (i32.eq
                      (local.get $first_byte)
                      (i32.const 0xe0))
                    (i32.lt_u
                      (local.get $second_byte)
                      (i32.const 0xa0)))
                  (then (return (i64.const -1))))
                (if
                  (i32.and
                    (i32.eq
                      (local.get $first_byte)
                      (i32.const 0xed))
                    (i32.ge_u
                      (local.get $second_byte)
                      (i32.const 0xa0)))
                  (then (return (i64.const -1))))
                (local.set $scalar
                  (i32.or
                    (i32.shl
                      (i32.and
                        (local.get $first_byte)
                        (i32.const 0x0f))
                      (i32.const 12))
                    (i32.or
                      (i32.shl
                        (i32.and
                          (local.get $second_byte)
                          (i32.const 0x3f))
                        (i32.const 6))
                      (i32.and
                        (local.get $third_byte)
                        (i32.const 0x3f)))))
                (local.set $next_cursor
                  (i32.add (local.get $cursor) (i32.const 3))))
              (else
                (if
                  (i32.and
                    (i32.ge_u
                      (local.get $first_byte)
                      (i32.const 0xf0))
                    (i32.le_u
                      (local.get $first_byte)
                      (i32.const 0xf4)))
                  (then
                    (if
                      (i32.lt_u
                        (i32.sub (local.get $end) (local.get $cursor))
                        (i32.const 4))
                      (then (return (i64.const -1))))
                    (local.set $second_byte
                      (call $work_byte (i32.add (local.get $cursor) (i32.const 1))))
                    (local.set $third_byte
                      (call $work_byte (i32.add (local.get $cursor) (i32.const 2))))
                    (local.set $fourth_byte
                      (call $work_byte (i32.add (local.get $cursor) (i32.const 3))))
                    (if
                      (i32.or
                        (i32.ne
                          (i32.and
                            (local.get $second_byte)
                            (i32.const 0xc0))
                          (i32.const 0x80))
                        (i32.or
                          (i32.ne
                            (i32.and
                              (local.get $third_byte)
                              (i32.const 0xc0))
                            (i32.const 0x80))
                          (i32.ne
                            (i32.and
                              (local.get $fourth_byte)
                              (i32.const 0xc0))
                            (i32.const 0x80))))
                      (then (return (i64.const -1))))
                    (if
                      (i32.and
                        (i32.eq
                          (local.get $first_byte)
                          (i32.const 0xf0))
                        (i32.lt_u
                          (local.get $second_byte)
                          (i32.const 0x90)))
                      (then (return (i64.const -1))))
                    (if
                      (i32.and
                        (i32.eq
                          (local.get $first_byte)
                          (i32.const 0xf4))
                        (i32.gt_u
                          (local.get $second_byte)
                          (i32.const 0x8f)))
                      (then (return (i64.const -1))))
                    (local.set $scalar
                      (i32.or
                        (i32.shl
                          (i32.and
                            (local.get $first_byte)
                            (i32.const 0x07))
                          (i32.const 18))
                        (i32.or
                          (i32.shl
                            (i32.and
                              (local.get $second_byte)
                              (i32.const 0x3f))
                            (i32.const 12))
                          (i32.or
                            (i32.shl
                              (i32.and
                                (local.get $third_byte)
                                (i32.const 0x3f))
                              (i32.const 6))
                            (i32.and
                              (local.get $fourth_byte)
                              (i32.const 0x3f))))))
                    (local.set $next_cursor
                      (i32.add (local.get $cursor) (i32.const 4))))
                  (else (return (i64.const -1))))))))))

    (i64.or
      (i64.shl
        (i64.extend_i32_u (local.get $next_cursor))
        (i64.const 32))
      (i64.extend_i32_u (local.get $scalar))))

  (func $validate_utf8 (export "validate_utf8")
    (param $bytes_address i32)
    (param $byte_length i32)
    (result i32)
    (local $memory_bytes i64)
    (local $cursor i32)
    (local $end i32)
    (local $decoded i64)
    (local.set $memory_bytes
      (i64.mul (i64.extend_i32_u (memory.size)) (i64.const 65536)))
    (if
      (i64.gt_u
        (i64.add
          (i64.extend_i32_u (local.get $bytes_address))
          (i64.extend_i32_u (local.get $byte_length)))
        (local.get $memory_bytes))
      (then (return (global.get $STATUS_BUFFER_TOO_SMALL))))
    (local.set $cursor (local.get $bytes_address))
    (local.set $end
      (i32.add (local.get $bytes_address) (local.get $byte_length)))
    (block $done
      (loop $next_scalar
        (call $work_add (i32.const 1))
        (br_if $done (i32.ge_u (local.get $cursor) (local.get $end)))
        (local.set $decoded
          (call $decode_scalar (local.get $cursor) (local.get $end)))
        (if (i64.eq (local.get $decoded) (i64.const -1))
          (then (return (global.get $STATUS_INVALID_UTF8))))
        (local.set $cursor
          (i32.wrap_i64
            (i64.shr_u (local.get $decoded) (i64.const 32))))
        (br $next_scalar)))
    (global.get $STATUS_OK))

  ;; Positive values are accepted flag bits, -1 is a deliberately unsupported
  ;; flag, and -2 is unknown syntax.
  (func $flag_bit (param $scalar i32) (result i32)
    (if (i32.eq (local.get $scalar) (i32.const 103))
      (then (return (global.get $FLAG_GLOBAL))))
    (if (i32.eq (local.get $scalar) (i32.const 105))
      (then (return (global.get $FLAG_IGNORE_CASE))))
    (if (i32.eq (local.get $scalar) (i32.const 109))
      (then (return (global.get $FLAG_MULTILINE))))
    (if (i32.eq (local.get $scalar) (i32.const 115))
      (then (return (global.get $FLAG_DOT_ALL))))
    (if (i32.eq (local.get $scalar) (i32.const 100))
      (then (return (global.get $FLAG_HAS_INDICES))))
    (if (i32.eq (local.get $scalar) (i32.const 121))
      (then (return (global.get $FLAG_STICKY))))
    (if
      (i32.or
        (i32.eq (local.get $scalar) (i32.const 117))
        (i32.eq (local.get $scalar) (i32.const 118)))
      (then (return (i32.const -1))))
    (i32.const -2))

  ;; Compile the bounded flag string to the descriptor/program bitfield.
  ;; The output is committed only after the complete flag string validates.
  (func (export "compile_flags")
    (param $flags_address i32)
    (param $flag_bytes i32)
    (param $result_address i32)
    (result i32)
    (local $memory_bytes i64)
    (local $cursor i32)
    (local $end i32)
    (local $decoded i64)
    (local $scalar i32)
    (local $bit i32)
    (local $compiled_flags i32)
    (if (i32.gt_u (local.get $flag_bytes) (i32.const 8))
      (then (return (global.get $STATUS_SYNTAX_ERROR))))
    (local.set $memory_bytes
      (i64.mul (i64.extend_i32_u (memory.size)) (i64.const 65536)))
    (if
      (i64.gt_u
        (i64.add
          (i64.extend_i32_u (local.get $flags_address))
          (i64.extend_i32_u (local.get $flag_bytes)))
        (local.get $memory_bytes))
      (then (return (global.get $STATUS_BUFFER_TOO_SMALL))))
    (if
      (i64.gt_u
        (i64.add
          (i64.extend_i32_u (local.get $result_address))
          (i64.const 4))
        (local.get $memory_bytes))
      (then (return (global.get $STATUS_BUFFER_TOO_SMALL))))
    (local.set $cursor (local.get $flags_address))
    (local.set $end
      (i32.add (local.get $flags_address) (local.get $flag_bytes)))
    (block $done
      (loop $next_flag
        (call $work_add (i32.const 1))
        (br_if $done (i32.ge_u (local.get $cursor) (local.get $end)))
        (local.set $decoded
          (call $decode_scalar (local.get $cursor) (local.get $end)))
        (if (i64.eq (local.get $decoded) (i64.const -1))
          (then (return (global.get $STATUS_INVALID_UTF8))))
        (local.set $cursor
          (i32.wrap_i64
            (i64.shr_u (local.get $decoded) (i64.const 32))))
        (local.set $scalar (i32.wrap_i64 (local.get $decoded)))
        (local.set $bit (call $flag_bit (local.get $scalar)))
        (if (i32.eq (local.get $bit) (i32.const -1))
          (then (return (global.get $STATUS_UNSUPPORTED))))
        (if (i32.eq (local.get $bit) (i32.const -2))
          (then (return (global.get $STATUS_SYNTAX_ERROR))))
        (if
          (i32.ne
            (i32.and (local.get $compiled_flags) (local.get $bit))
            (i32.const 0))
          (then (return (global.get $STATUS_SYNTAX_ERROR))))
        (local.set $compiled_flags
          (i32.or (local.get $compiled_flags) (local.get $bit)))
        (br $next_flag)))
    (i32.store (local.get $result_address) (local.get $compiled_flags))
    (global.get $STATUS_OK))

  ;; Return one built-in-class range packed as end:start, or -1 when absent.
  ;; Embedded uppercase classes are materialized as scalar-domain complements.
  ;; Value of a single-character escape (\t \n \r \f \v \0, and \b as
  ;; backspace inside a class); identity for everything else the dialect
  ;; accepts. -1 for escapes the dialect refuses rather than approximates:
  ;; word-boundary assertions (\b \B outside a class), Unicode property
  ;; escapes (\p \P), and the multi-character control/hex/unicode forms
  ;; (\cX \xHH \uHHHH), which are not decoded yet.
  (func $escape_value (param $scalar i32) (param $in_class i32) (result i32)
    (if (i32.eq (local.get $scalar) (i32.const 116)) (then (return (i32.const 9))))
    (if (i32.eq (local.get $scalar) (i32.const 110)) (then (return (i32.const 10))))
    (if (i32.eq (local.get $scalar) (i32.const 114)) (then (return (i32.const 13))))
    (if (i32.eq (local.get $scalar) (i32.const 102)) (then (return (i32.const 12))))
    (if (i32.eq (local.get $scalar) (i32.const 118)) (then (return (i32.const 11))))
    (if (i32.eq (local.get $scalar) (i32.const 48)) (then (return (i32.const 0))))
    (if (i32.eq (local.get $scalar) (i32.const 98))
      (then (return (select (i32.const 8) (i32.const -1) (local.get $in_class)))))
    (if (i32.eq (local.get $scalar) (i32.const 66))
      (then (return (select (i32.const 66) (i32.const -1) (local.get $in_class)))))
    (if (i32.or (i32.eq (local.get $scalar) (i32.const 112)) (i32.eq (local.get $scalar) (i32.const 80)))
      (then (return (i32.const -1))))
    (if (i32.or (i32.eq (local.get $scalar) (i32.const 99))
                (i32.or (i32.eq (local.get $scalar) (i32.const 120)) (i32.eq (local.get $scalar) (i32.const 117))))
      (then (return (i32.const -1))))
    (local.get $scalar))

  ;; ECMA-262 WhiteSpace ∪ LineTerminator: the fixed set behind \s.
  (func $whitespace_range (param $index i32) (result i64)
    (local $start i32) (local $end i32)
    (local.set $start (i32.const -1))
    (if (i32.eq (local.get $index) (i32.const 0)) (then (local.set $start (i32.const 9)) (local.set $end (i32.const 13))))
    (if (i32.eq (local.get $index) (i32.const 1)) (then (local.set $start (i32.const 32)) (local.set $end (i32.const 32))))
    (if (i32.eq (local.get $index) (i32.const 2)) (then (local.set $start (i32.const 160)) (local.set $end (i32.const 160))))
    (if (i32.eq (local.get $index) (i32.const 3)) (then (local.set $start (i32.const 5760)) (local.set $end (i32.const 5760))))
    (if (i32.eq (local.get $index) (i32.const 4)) (then (local.set $start (i32.const 8192)) (local.set $end (i32.const 8202))))
    (if (i32.eq (local.get $index) (i32.const 5)) (then (local.set $start (i32.const 8232)) (local.set $end (i32.const 8233))))
    (if (i32.eq (local.get $index) (i32.const 6)) (then (local.set $start (i32.const 8239)) (local.set $end (i32.const 8239))))
    (if (i32.eq (local.get $index) (i32.const 7)) (then (local.set $start (i32.const 8287)) (local.set $end (i32.const 8287))))
    (if (i32.eq (local.get $index) (i32.const 8)) (then (local.set $start (i32.const 12288)) (local.set $end (i32.const 12288))))
    (if (i32.eq (local.get $index) (i32.const 9)) (then (local.set $start (i32.const 65279)) (local.set $end (i32.const 65279))))
    (if (i32.eq (local.get $start) (i32.const -1)) (then (return (i64.const -1))))
    (i64.or (i64.extend_i32_u (local.get $start)) (i64.shl (i64.extend_i32_u (local.get $end)) (i64.const 32))))

  ;; Complement of the whitespace set over scalars (surrogates excluded).
  (func $non_whitespace_range (param $index i32) (result i64)
    (local $start i32) (local $end i32)
    (local.set $start (i32.const -1))
    (if (i32.eq (local.get $index) (i32.const 0)) (then (local.set $start (i32.const 0)) (local.set $end (i32.const 8))))
    (if (i32.eq (local.get $index) (i32.const 1)) (then (local.set $start (i32.const 14)) (local.set $end (i32.const 31))))
    (if (i32.eq (local.get $index) (i32.const 2)) (then (local.set $start (i32.const 33)) (local.set $end (i32.const 159))))
    (if (i32.eq (local.get $index) (i32.const 3)) (then (local.set $start (i32.const 161)) (local.set $end (i32.const 5759))))
    (if (i32.eq (local.get $index) (i32.const 4)) (then (local.set $start (i32.const 5761)) (local.set $end (i32.const 8191))))
    (if (i32.eq (local.get $index) (i32.const 5)) (then (local.set $start (i32.const 8203)) (local.set $end (i32.const 8231))))
    (if (i32.eq (local.get $index) (i32.const 6)) (then (local.set $start (i32.const 8234)) (local.set $end (i32.const 8238))))
    (if (i32.eq (local.get $index) (i32.const 7)) (then (local.set $start (i32.const 8240)) (local.set $end (i32.const 8286))))
    (if (i32.eq (local.get $index) (i32.const 8)) (then (local.set $start (i32.const 8288)) (local.set $end (i32.const 12287))))
    (if (i32.eq (local.get $index) (i32.const 9)) (then (local.set $start (i32.const 12289)) (local.set $end (i32.const 0xd7ff))))
    (if (i32.eq (local.get $index) (i32.const 10)) (then (local.set $start (i32.const 0xe000)) (local.set $end (i32.const 65278))))
    (if (i32.eq (local.get $index) (i32.const 11)) (then (local.set $start (i32.const 65280)) (local.set $end (i32.const 0x10ffff))))
    (if (i32.eq (local.get $start) (i32.const -1)) (then (return (i64.const -1))))
    (i64.or (i64.extend_i32_u (local.get $start)) (i64.shl (i64.extend_i32_u (local.get $end)) (i64.const 32))))

  (func $builtin_class_range
    (param $escape_scalar i32)
    (param $embedded i32)
    (param $range_index i32)
    (result i64)
    (local $start i32)
    (local $end i32)
    (local.set $start (i32.const -1))
    (if
      (i32.and
        (local.get $embedded)
        (i32.eq (local.get $escape_scalar) (i32.const 68)))
      (then
        (if (i32.eq (local.get $range_index) (i32.const 0))
          (then
            (local.set $start (i32.const 0))
            (local.set $end (i32.const 47))))
        (if (i32.eq (local.get $range_index) (i32.const 1))
          (then
            (local.set $start (i32.const 58))
            (local.set $end (i32.const 0xd7ff))))
        (if (i32.eq (local.get $range_index) (i32.const 2))
          (then
            (local.set $start (i32.const 0xe000))
            (local.set $end (i32.const 0x10ffff))))))
    (if
      (i32.and
        (local.get $embedded)
        (i32.eq (local.get $escape_scalar) (i32.const 87)))
      (then
        (if (i32.eq (local.get $range_index) (i32.const 0))
          (then
            (local.set $start (i32.const 0))
            (local.set $end (i32.const 47))))
        (if (i32.eq (local.get $range_index) (i32.const 1))
          (then
            (local.set $start (i32.const 58))
            (local.set $end (i32.const 64))))
        (if (i32.eq (local.get $range_index) (i32.const 2))
          (then
            (local.set $start (i32.const 91))
            (local.set $end (i32.const 94))))
        (if (i32.eq (local.get $range_index) (i32.const 3))
          (then
            (local.set $start (i32.const 96))
            (local.set $end (i32.const 96))))
        (if (i32.eq (local.get $range_index) (i32.const 4))
          (then
            (local.set $start (i32.const 123))
            (local.set $end (i32.const 0xd7ff))))
        (if (i32.eq (local.get $range_index) (i32.const 5))
          (then
            (local.set $start (i32.const 0xe000))
            (local.set $end (i32.const 0x10ffff))))))
    (if
      (i32.and
        (local.get $embedded)
        (i32.eq (local.get $escape_scalar) (i32.const 83)))
      (then (return (call $non_whitespace_range (local.get $range_index)))))
    (if
      (i32.and
        (i32.eqz (local.get $embedded))
        (i32.or
          (i32.eq (local.get $escape_scalar) (i32.const 68))
          (i32.eq (local.get $escape_scalar) (i32.const 87))))
      (then
        (local.set $escape_scalar
          (i32.add (local.get $escape_scalar) (i32.const 32)))))
    (if (i32.eq (local.get $escape_scalar) (i32.const 100))
      (then
        (if (i32.eqz (local.get $range_index))
          (then
            (local.set $start (i32.const 48))
            (local.set $end (i32.const 57))))))
    (if (i32.eq (local.get $escape_scalar) (i32.const 119))
      (then
        (if (i32.eq (local.get $range_index) (i32.const 0))
          (then
            (local.set $start (i32.const 48))
            (local.set $end (i32.const 57))))
        (if (i32.eq (local.get $range_index) (i32.const 1))
          (then
            (local.set $start (i32.const 65))
            (local.set $end (i32.const 90))))
        (if (i32.eq (local.get $range_index) (i32.const 2))
          (then
            (local.set $start (i32.const 95))
            (local.set $end (i32.const 95))))
        (if (i32.eq (local.get $range_index) (i32.const 3))
          (then
            (local.set $start (i32.const 97))
            (local.set $end (i32.const 122))))))
    (if
      (i32.and
        (i32.eqz (local.get $embedded))
        (i32.eq (local.get $escape_scalar) (i32.const 83)))
      (then (local.set $escape_scalar (i32.const 115))))
    (if (i32.eq (local.get $escape_scalar) (i32.const 115))
      (then (return (call $whitespace_range (local.get $range_index)))))
    (if (i32.eq (local.get $start) (i32.const -1))
      (then (return (i64.const -1))))
    (i64.or
      (i64.extend_i32_u (local.get $start))
      (i64.shl
        (i64.extend_i32_u (local.get $end))
        (i64.const 32))))

  ;; Compile the fixed ASCII definitions of \d, \w, and \s (and negations)
  ;; into the same inclusive scalar ranges stored after a bytecode program.
  (func $compile_builtin_class (export "compile_builtin_class")
    (param $escape_scalar i32)
    (param $ranges_address i32)
    (param $ranges_capacity i32)
    (param $result_address i32)
    (param $result_capacity i32)
    (result i32)
    (local $memory_bytes i64)
    (local $range_count i32)
    (local $range_bytes i32)
    (local $negated i32)
    (local $ranges_end i32)
    (local $result_end i32)
    (local $range_index i32)
    (local $range i64)
    (if
      (i32.or
        (i32.eq (local.get $escape_scalar) (i32.const 100))
        (i32.eq (local.get $escape_scalar) (i32.const 68)))
      (then
        (local.set $range_count (i32.const 1))
        (local.set $negated
          (i32.eq (local.get $escape_scalar) (i32.const 68))))
      (else
        (if
          (i32.or
            (i32.eq (local.get $escape_scalar) (i32.const 119))
            (i32.eq (local.get $escape_scalar) (i32.const 87)))
          (then
            (local.set $range_count (i32.const 4))
            (local.set $negated
              (i32.eq (local.get $escape_scalar) (i32.const 87))))
          (else
            (if
              (i32.or
                (i32.eq (local.get $escape_scalar) (i32.const 115))
                (i32.eq (local.get $escape_scalar) (i32.const 83)))
              (then
                (local.set $range_count (i32.const 10))
                (local.set $negated
                  (i32.eq (local.get $escape_scalar) (i32.const 83))))
              (else (return (global.get $STATUS_SYNTAX_ERROR))))))))
    (local.set $range_bytes
      (i32.mul (local.get $range_count) (i32.const 8)))
    (if (i32.lt_u (local.get $ranges_capacity) (local.get $range_bytes))
      (then (return (global.get $STATUS_BUFFER_TOO_SMALL))))
    (if (i32.lt_u (local.get $result_capacity) (i32.const 8))
      (then (return (global.get $STATUS_BUFFER_TOO_SMALL))))
    (local.set $memory_bytes
      (i64.mul (i64.extend_i32_u (memory.size)) (i64.const 65536)))
    (if
      (i64.gt_u
        (i64.add
          (i64.extend_i32_u (local.get $ranges_address))
          (i64.extend_i32_u (local.get $range_bytes)))
        (local.get $memory_bytes))
      (then (return (global.get $STATUS_BUFFER_TOO_SMALL))))
    (if
      (i64.gt_u
        (i64.add
          (i64.extend_i32_u (local.get $result_address))
          (i64.const 8))
        (local.get $memory_bytes))
      (then (return (global.get $STATUS_BUFFER_TOO_SMALL))))
    (local.set $ranges_end
      (i32.add (local.get $ranges_address) (local.get $range_bytes)))
    (local.set $result_end
      (i32.add (local.get $result_address) (i32.const 8)))
    (if
      (i32.and
        (i32.lt_u (local.get $ranges_address) (local.get $result_end))
        (i32.lt_u (local.get $result_address) (local.get $ranges_end)))
      (then (return (global.get $STATUS_CORRUPT_PROGRAM))))

    (block $ranges_done
      (loop $write_range
        (call $work_add (i32.const 1))
        (br_if $ranges_done
          (i32.ge_u
            (local.get $range_index)
            (local.get $range_count)))
        (local.set $range
          (call $builtin_class_range
            (local.get $escape_scalar)
            (i32.const 0)
            (local.get $range_index)))
        (if (i64.eq (local.get $range) (i64.const -1))
          (then (return (global.get $STATUS_CORRUPT_PROGRAM))))
        (i32.store
          (i32.add
            (local.get $ranges_address)
            (i32.mul (local.get $range_index) (i32.const 8)))
          (i32.wrap_i64 (local.get $range)))
        (i32.store offset=4
          (i32.add
            (local.get $ranges_address)
            (i32.mul (local.get $range_index) (i32.const 8)))
          (i32.wrap_i64
            (i64.shr_u (local.get $range) (i64.const 32))))
        (local.set $range_index
          (i32.add (local.get $range_index) (i32.const 1)))
        (br $write_range)))
    (i32.store (local.get $result_address) (local.get $range_count))
    (i32.store offset=4 (local.get $result_address) (local.get $negated))
    (global.get $STATUS_OK))


  (func $builtin_class_range_count
    (param $scalar i32)
    (param $embedded i32)
    (result i32)
    (if (i32.eq (local.get $scalar) (i32.const 100))
      (then (return (i32.const 1))))
    (if (i32.eq (local.get $scalar) (i32.const 68))
      (then
        (if (local.get $embedded)
          (then (return (i32.const 3))))
        (return (i32.const 1))))
    (if (i32.eq (local.get $scalar) (i32.const 119))
      (then (return (i32.const 4))))
    (if (i32.eq (local.get $scalar) (i32.const 87))
      (then
        (if (local.get $embedded)
          (then (return (i32.const 6))))
        (return (i32.const 4))))
    (if (i32.eq (local.get $scalar) (i32.const 115))
      (then (return (i32.const 10))))
    (if (i32.eq (local.get $scalar) (i32.const 83))
      (then
        (if (local.get $embedded)
          (then (return (i32.const 12))))
        (return (i32.const 10))))
    (i32.const 0))

  (func $add_measured_ranges
    (param $workspace_address i32)
    (param $additional_ranges i32)
    (result i32)
    (local $range_count i32)
    (local.set $range_count
      (i32.add
        (i32.load offset=100 (local.get $workspace_address))
        (local.get $additional_ranges)))
    (if
      (i32.gt_u
        (local.get $range_count)
        (global.get $MAX_CHARACTER_CLASS_RANGES))
      (then (return (global.get $STATUS_LIMIT_EXCEEDED))))
    (i32.store offset=100
      (local.get $workspace_address)
      (local.get $range_count))
    (global.get $STATUS_OK))

  (func $measure_class_literal
    (param $workspace_address i32)
    (param $scalar i32)
    (result i32)
    (local $status i32)
    (if (i32.load offset=96 (local.get $workspace_address))
      (then
        (if
          (i32.gt_u
            (i32.load offset=92 (local.get $workspace_address))
            (local.get $scalar))
          (then (return (global.get $STATUS_SYNTAX_ERROR))))
        (local.set $status
          (call $add_measured_ranges
            (local.get $workspace_address)
            (i32.const 1)))
        (if (i32.ne (local.get $status) (global.get $STATUS_OK))
          (then (return (local.get $status))))
        (i32.store offset=88
          (local.get $workspace_address)
          (i32.const 0))
        (i32.store offset=96
          (local.get $workspace_address)
          (i32.const 0))
        (return (global.get $STATUS_OK))))
    (if (i32.load offset=88 (local.get $workspace_address))
      (then
        (local.set $status
          (call $add_measured_ranges
            (local.get $workspace_address)
            (i32.const 1)))
        (if (i32.ne (local.get $status) (global.get $STATUS_OK))
          (then (return (local.get $status))))))
    (i32.store offset=88
      (local.get $workspace_address)
      (i32.const 1))
    (i32.store offset=92
      (local.get $workspace_address)
      (local.get $scalar))
    (i32.store offset=84
      (local.get $workspace_address)
      (i32.const 0))
    (global.get $STATUS_OK))

  (func $scan_normal_scalar
    (param $workspace_address i32)
    (param $scalar i32)
    (result i32)
    (local $status i32)
    (local $atom_instruction_count i32)
    (local $measurement_address i32)
    (local $measurement_capacity i32)
    (local $pattern_bytes i32)
    (local.set $measurement_address
      (i32.add
        (local.get $workspace_address)
        (global.get $SCAN_HEADER_SIZE)))
    (local.set $pattern_bytes
      (i32.load offset=12 (local.get $workspace_address)))
    (local.set $measurement_capacity
      (call $measurement_workspace_size (local.get $pattern_bytes)))
    (if (i32.eq (local.get $scalar) (i32.const 92))
      (then
        (i32.store offset=32
          (local.get $workspace_address)
          (global.get $SCAN_MODE_ESCAPE))
        (i32.store offset=48
          (local.get $workspace_address)
          (i32.const 0))
        (return (global.get $STATUS_OK))))
    (if (i32.eq (local.get $scalar) (i32.const 91))
      (then
        (i32.store offset=32
          (local.get $workspace_address)
          (global.get $SCAN_MODE_CLASS))
        (i32.store offset=48
          (local.get $workspace_address)
          (i32.const 0))
        (i32.store offset=80
          (local.get $workspace_address)
          (i32.const 0))
        (i32.store offset=84
          (local.get $workspace_address)
          (i32.const 1))
        (i32.store offset=88
          (local.get $workspace_address)
          (i32.const 0))
        (i32.store offset=92
          (local.get $workspace_address)
          (i32.const 0))
        (i32.store offset=96
          (local.get $workspace_address)
          (i32.const 0))
        (return (global.get $STATUS_OK))))
    (if (i32.eq (local.get $scalar) (i32.const 40))
      (then
        (local.set $status
          (call $measurement_push_group
            (local.get $measurement_address)
            (local.get $measurement_capacity)
            (local.get $pattern_bytes)
            (i32.load offset=40 (local.get $workspace_address))))
        (if (i32.ne (local.get $status) (global.get $STATUS_OK))
          (then (return (local.get $status))))
        (i32.store offset=36
          (local.get $workspace_address)
          (i32.add
            (i32.load offset=36 (local.get $workspace_address))
            (i32.const 1)))
        (i32.store offset=32
          (local.get $workspace_address)
          (global.get $SCAN_MODE_AFTER_GROUP_OPEN))
        (i32.store offset=48
          (local.get $workspace_address)
          (i32.const 0))
        (return (global.get $STATUS_OK))))
    (if (i32.eq (local.get $scalar) (i32.const 41))
      (then
        (if
          (i32.eqz
            (i32.load offset=36 (local.get $workspace_address)))
          (then (return (global.get $STATUS_SYNTAX_ERROR))))
        (local.set $atom_instruction_count
          (call $measurement_pop_group
            (local.get $measurement_address)
            (local.get $measurement_capacity)
            (local.get $pattern_bytes)
            (i32.load offset=40 (local.get $workspace_address))))
        (local.set $status)
        (if (i32.ne (local.get $status) (global.get $STATUS_OK))
          (then (return (local.get $status))))
        (i32.store offset=36
          (local.get $workspace_address)
          (i32.sub
            (i32.load offset=36 (local.get $workspace_address))
            (i32.const 1)))
        (i32.store offset=48
          (local.get $workspace_address)
          (i32.const 1))
        (return (global.get $STATUS_OK))))
    (if (i32.eq (local.get $scalar) (i32.const 124))
      (then
        (local.set $status
          (call $measurement_add_control
            (local.get $measurement_address)
            (local.get $measurement_capacity)
            (local.get $pattern_bytes)
            (i32.const 1)))
        (if (i32.ne (local.get $status) (global.get $STATUS_OK))
          (then (return (local.get $status))))
        (i32.store offset=48
          (local.get $workspace_address)
          (i32.const 0))
        (return (global.get $STATUS_OK))))
    (if
      (i32.or
        (i32.eq (local.get $scalar) (i32.const 94))
        (i32.eq (local.get $scalar) (i32.const 36)))
      (then
        (local.set $status
          (call $measurement_add_control
            (local.get $measurement_address)
            (local.get $measurement_capacity)
            (local.get $pattern_bytes)
            (i32.const 1)))
        (if (i32.ne (local.get $status) (global.get $STATUS_OK))
          (then (return (local.get $status))))
        (i32.store offset=48
          (local.get $workspace_address)
          (i32.const 0))
        (return (global.get $STATUS_OK))))
    (if (i32.eq (local.get $scalar) (i32.const 123))
      (then
        (i32.store offset=68
          (local.get $workspace_address)
          (i32.load offset=48 (local.get $workspace_address)))
        (i32.store offset=52
          (local.get $workspace_address)
          (i32.const 0))
        (i32.store offset=56
          (local.get $workspace_address)
          (i32.const 0))
        (i32.store offset=60
          (local.get $workspace_address)
          (i32.const 0))
        (i32.store offset=64
          (local.get $workspace_address)
          (i32.const 0))
        (i32.store offset=32
          (local.get $workspace_address)
          (global.get $SCAN_MODE_BRACE_START))
        (i32.store offset=48
          (local.get $workspace_address)
          (i32.const 0))
        (return (global.get $STATUS_OK))))
    (if
      (i32.or
        (i32.eq (local.get $scalar) (i32.const 42))
        (i32.or
          (i32.eq (local.get $scalar) (i32.const 43))
          (i32.eq (local.get $scalar) (i32.const 63))))
      (then
        (if
          (i32.eqz
            (i32.load offset=48 (local.get $workspace_address)))
          (then (return (global.get $STATUS_SYNTAX_ERROR))))
        (if (i32.eq (local.get $scalar) (i32.const 42))
          (then
            (local.set $status
              (call $measurement_apply_last_quantifier
                (local.get $measurement_address)
                (local.get $measurement_capacity)
                (local.get $pattern_bytes)
                (i32.const 0)
                (i32.const -1))))
          (else
            (if (i32.eq (local.get $scalar) (i32.const 43))
              (then
                (local.set $status
                  (call $measurement_apply_last_quantifier
                    (local.get $measurement_address)
                    (local.get $measurement_capacity)
                    (local.get $pattern_bytes)
                    (i32.const 1)
                    (i32.const -1))))
              (else
                (local.set $status
                  (call $measurement_apply_last_quantifier
                    (local.get $measurement_address)
                    (local.get $measurement_capacity)
                    (local.get $pattern_bytes)
                    (i32.const 0)
                    (i32.const 1)))))))
        (if (i32.ne (local.get $status) (global.get $STATUS_OK))
          (then (return (local.get $status))))
        (i32.store offset=32
          (local.get $workspace_address)
          (global.get $SCAN_MODE_AFTER_QUANTIFIER))
        (i32.store offset=48
          (local.get $workspace_address)
          (i32.const 0))
        (return (global.get $STATUS_OK))))
    (local.set $status
      (call $measurement_add_atom
        (local.get $measurement_address)
        (local.get $measurement_capacity)
        (local.get $pattern_bytes)
        (i32.const 1)))
    (if (i32.ne (local.get $status) (global.get $STATUS_OK))
      (then (return (local.get $status))))
    (i32.store offset=48
      (local.get $workspace_address)
      (i32.const 1))
    (global.get $STATUS_OK))

  ;; Fuel-resumable UTF-8 scan used as the first pattern-compiler phase. One
  ;; scalar transition plus examined UTF-8 bytes are charged at source. State
  ;; lives entirely in caller memory; atomic helper work may overrun a grant.
  (func $scan_pattern_impl
    (param $pattern_address i32)
    (param $pattern_bytes i32)
    (param $workspace_address i32)
    (param $workspace_capacity i32)
    (param $initialize i32)
    (param $fuel i32)
    (result i32 i32)
    (local $memory_bytes i64)
    (local $required_workspace_bytes i32)
    (local $pattern_end i32)
    (local $workspace_end i32)
    (local $cursor i32)
    (local $decoded i64)
    (local $scalar i32)
    (local $mode i32)
    (local $transition_status i32)
    (local $capture_group_count i32)
    (local $digit i32)
    (local $quantifier_count i32)
    (local $scalar_address i32)
    (if
      (i32.and
        (i32.ne (local.get $initialize) (i32.const 0))
        (i32.ne (local.get $initialize) (i32.const 1)))
      (then
        (return
          (global.get $STATUS_CORRUPT_PROGRAM)
          (local.get $fuel))))
    (if (i32.gt_u (local.get $pattern_bytes) (global.get $MAX_PATTERN_BYTES))
      (then
        (return
          (global.get $STATUS_LIMIT_EXCEEDED)
          (local.get $fuel))))
    (local.set $required_workspace_bytes
      (call $scan_workspace_size (local.get $pattern_bytes)))
    (if
      (i32.lt_u
        (local.get $workspace_capacity)
        (local.get $required_workspace_bytes))
      (then
        (return
          (global.get $STATUS_BUFFER_TOO_SMALL)
          (local.get $fuel))))
    (local.set $memory_bytes
      (i64.mul (i64.extend_i32_u (memory.size)) (i64.const 65536)))
    (if
      (i64.gt_u
        (i64.add
          (i64.extend_i32_u (local.get $pattern_address))
          (i64.extend_i32_u (local.get $pattern_bytes)))
        (local.get $memory_bytes))
      (then
        (return
          (global.get $STATUS_BUFFER_TOO_SMALL)
          (local.get $fuel))))
    (if
      (i64.gt_u
        (i64.add
          (i64.extend_i32_u (local.get $workspace_address))
          (i64.extend_i32_u (local.get $required_workspace_bytes)))
        (local.get $memory_bytes))
      (then
        (return
          (global.get $STATUS_BUFFER_TOO_SMALL)
          (local.get $fuel))))
    (local.set $pattern_end
      (i32.add (local.get $pattern_address) (local.get $pattern_bytes)))
    (local.set $workspace_end
      (i32.add
        (local.get $workspace_address)
        (local.get $required_workspace_bytes)))
    (if
      (i32.and
        (i32.lt_u (local.get $pattern_address) (local.get $workspace_end))
        (i32.lt_u (local.get $workspace_address) (local.get $pattern_end)))
      (then
        (return
          (global.get $STATUS_CORRUPT_PROGRAM)
          (local.get $fuel))))

    (if (local.get $initialize)
      (then
        (call $work_add (i32.const 7))
        (i32.store
          (local.get $workspace_address)
          (global.get $SCAN_MAGIC))
        (i32.store offset=4
          (local.get $workspace_address)
          (global.get $STATE_VERSION))
        (i32.store offset=8
          (local.get $workspace_address)
          (local.get $pattern_address))
        (i32.store offset=12
          (local.get $workspace_address)
          (local.get $pattern_bytes))
        (i32.store offset=16
          (local.get $workspace_address)
          (local.get $pattern_address))
        (i32.store offset=20
          (local.get $workspace_address)
          (i32.const 0))
        (i32.store offset=24
          (local.get $workspace_address)
          (i32.const 0))
        (i32.store offset=28
          (local.get $workspace_address)
          (i32.const 0))
        (i32.store offset=32
          (local.get $workspace_address)
          (global.get $SCAN_MODE_NORMAL))
        (i32.store offset=36
          (local.get $workspace_address)
          (i32.const 0))
        (i32.store offset=40
          (local.get $workspace_address)
          (i32.const 0))
        (i32.store offset=44
          (local.get $workspace_address)
          (i32.const 0))
        (i32.store offset=48
          (local.get $workspace_address)
          (i32.const 0))
        (i32.store offset=52
          (local.get $workspace_address)
          (i32.const 0))
        (i32.store offset=56
          (local.get $workspace_address)
          (i32.const 0))
        (i32.store offset=60
          (local.get $workspace_address)
          (i32.const 0))
        (i32.store offset=64
          (local.get $workspace_address)
          (i32.const 0))
        (i32.store offset=68
          (local.get $workspace_address)
          (i32.const 0))
        (i32.store offset=72
          (local.get $workspace_address)
          (i32.const 0))
        (i32.store offset=76
          (local.get $workspace_address)
          (i32.const 0))
        (i32.store offset=80
          (local.get $workspace_address)
          (i32.const 0))
        (i32.store offset=84
          (local.get $workspace_address)
          (i32.const 0))
        (i32.store offset=88
          (local.get $workspace_address)
          (i32.const 0))
        (i32.store offset=92
          (local.get $workspace_address)
          (i32.const 0))
        (i32.store offset=96
          (local.get $workspace_address)
          (i32.const 0))
        (i32.store offset=100
          (local.get $workspace_address)
          (i32.const 0))
        (local.set $transition_status
          (call $initialize_measurement_workspace
            (i32.add
              (local.get $workspace_address)
              (global.get $SCAN_HEADER_SIZE))
            (i32.sub
              (local.get $workspace_capacity)
              (global.get $SCAN_HEADER_SIZE))
            (local.get $pattern_bytes)
            (i32.const 3)))
        (if
          (i32.ne
            (local.get $transition_status)
            (global.get $STATUS_OK))
          (then
            (return
              (local.get $transition_status)
              (local.get $fuel)))))
      (else
        (if
          (i32.or
            (i32.ne
              (i32.load (local.get $workspace_address))
              (global.get $SCAN_MAGIC))
            (i32.or
              (i32.ne
                (i32.load offset=4 (local.get $workspace_address))
                (global.get $STATE_VERSION))
              (i32.or
                (i32.ne
                  (i32.load offset=8 (local.get $workspace_address))
                  (local.get $pattern_address))
                (i32.ne
                  (i32.load offset=12 (local.get $workspace_address))
                  (local.get $pattern_bytes)))))
          (then
            (return
              (global.get $STATUS_CORRUPT_PROGRAM)
              (local.get $fuel))))
        (if
          (i32.or
            (i32.gt_u
              (i32.load offset=24 (local.get $workspace_address))
              (i32.const 1))
            (i32.ne
              (i32.load offset=28 (local.get $workspace_address))
              (i32.const 0)))
          (then
            (return
              (global.get $STATUS_CORRUPT_PROGRAM)
              (local.get $fuel))))
        (if
          (i32.or
            (i32.gt_u
              (i32.load offset=32 (local.get $workspace_address))
              (global.get $SCAN_MODE_BRACE_MAXIMUM))
            (i32.or
              (i32.gt_u
                (i32.load offset=36 (local.get $workspace_address))
                (global.get $MAX_PATTERN_BYTES))
              (i32.gt_u
                (i32.load offset=40 (local.get $workspace_address))
                (global.get $MAX_CAPTURE_GROUPS))))
          (then
            (return
              (global.get $STATUS_CORRUPT_PROGRAM)
              (local.get $fuel))))
        (if
          (i32.or
            (i32.gt_u
              (i32.load offset=44 (local.get $workspace_address))
              (i32.load offset=20 (local.get $workspace_address)))
            (i32.gt_u
              (i32.load offset=48 (local.get $workspace_address))
              (i32.const 1)))
          (then
            (return
              (global.get $STATUS_CORRUPT_PROGRAM)
              (local.get $fuel))))
        (if
          (i32.or
            (i32.gt_u
              (i32.load offset=60 (local.get $workspace_address))
              (i32.const 1))
            (i32.or
              (i32.gt_u
                (i32.load offset=64 (local.get $workspace_address))
                (i32.const 1))
              (i32.gt_u
                (i32.load offset=68 (local.get $workspace_address))
                (i32.const 1))))
          (then
            (return
              (global.get $STATUS_CORRUPT_PROGRAM)
              (local.get $fuel))))
        (if
          (i32.or
            (i32.gt_u
              (i32.load offset=52 (local.get $workspace_address))
              (global.get $MAX_BYTECODE_INSTRUCTIONS))
            (i32.and
              (i32.ne
                (i32.load offset=56 (local.get $workspace_address))
                (i32.const -1))
              (i32.gt_u
                (i32.load offset=56 (local.get $workspace_address))
                (global.get $MAX_BYTECODE_INSTRUCTIONS))))
          (then
            (return
              (global.get $STATUS_CORRUPT_PROGRAM)
              (local.get $fuel))))
        (if
          (i32.or
            (i32.gt_u
              (i32.load offset=72 (local.get $workspace_address))
              (i32.load offset=40 (local.get $workspace_address)))
            (i32.gt_u
              (i32.load offset=76 (local.get $workspace_address))
              (i32.add
                (local.get $pattern_bytes)
                (i32.mul
                  (global.get $MAX_CAPTURE_GROUPS)
                  (i32.const 8)))))
          (then
            (return
              (global.get $STATUS_CORRUPT_PROGRAM)
              (local.get $fuel))))
        (if
          (i32.or
            (i32.gt_u
              (i32.load offset=80 (local.get $workspace_address))
              (i32.const 1))
            (i32.or
              (i32.gt_u
                (i32.load offset=84 (local.get $workspace_address))
                (i32.const 1))
              (i32.or
                (i32.gt_u
                  (i32.load offset=88 (local.get $workspace_address))
                  (i32.const 1))
                (i32.gt_u
                  (i32.load offset=96 (local.get $workspace_address))
                  (i32.const 1)))))
          (then
            (return
              (global.get $STATUS_CORRUPT_PROGRAM)
              (local.get $fuel))))
        (if
          (i32.or
            (i32.gt_u
              (i32.load offset=100 (local.get $workspace_address))
              (global.get $MAX_CHARACTER_CLASS_RANGES))
            (i32.and
              (i32.load offset=88 (local.get $workspace_address))
              (i32.eqz
                (call $valid_scalar
                  (i32.load offset=92 (local.get $workspace_address))))))
          (then
            (return
              (global.get $STATUS_CORRUPT_PROGRAM)
              (local.get $fuel))))))
    (local.set $transition_status
      (call $validate_measurement_workspace
        (i32.add
          (local.get $workspace_address)
          (global.get $SCAN_HEADER_SIZE))
        (i32.sub
          (local.get $workspace_capacity)
          (global.get $SCAN_HEADER_SIZE))
        (local.get $pattern_bytes)))
    (if
      (i32.ne
        (local.get $transition_status)
        (global.get $STATUS_OK))
      (then
        (return
          (local.get $transition_status)
          (local.get $fuel))))

    (local.set $cursor
      (i32.load offset=16 (local.get $workspace_address)))
    (if
      (i32.or
        (i32.lt_u (local.get $cursor) (local.get $pattern_address))
        (i32.gt_u (local.get $cursor) (local.get $pattern_end)))
      (then
        (return
          (global.get $STATUS_CORRUPT_PROGRAM)
          (local.get $fuel))))
    (if (i32.load offset=24 (local.get $workspace_address))
      (then
        (if
          (i32.eq
            (call $measured_program_size
              (local.get $workspace_address)
              (local.get $workspace_capacity)
              (local.get $pattern_bytes))
            (i32.const -1))
          (then
            (return
              (global.get $STATUS_CORRUPT_PROGRAM)
              (local.get $fuel))))
        (return (global.get $STATUS_OK) (local.get $fuel))))

    (block $complete
      (loop $next_scalar
        (br_if $complete
          (i32.ge_u (local.get $cursor) (local.get $pattern_end)))
        (local.set $fuel (call $work_take (local.get $fuel)))
        (if (i32.le_s (local.get $fuel) (i32.const 0))
          (then
            (return
              (global.get $STATUS_PAUSED)
              (local.get $fuel))))
        (call $work_add (i32.const 1))
        (local.set $scalar_address (local.get $cursor))
        (local.set $decoded
          (call $decode_scalar
            (local.get $cursor)
            (local.get $pattern_end)))
        (if (i64.eq (local.get $decoded) (i64.const -1))
          (then
            (return
              (global.get $STATUS_INVALID_UTF8)
              (local.get $fuel))))
        (local.set $cursor
          (i32.wrap_i64
            (i64.shr_u (local.get $decoded) (i64.const 32))))
        (i32.store offset=16
          (local.get $workspace_address)
          (local.get $cursor))
        (i32.store offset=20
          (local.get $workspace_address)
          (i32.add
            (i32.load offset=20 (local.get $workspace_address))
            (i32.const 1)))
        (local.set $scalar (i32.wrap_i64 (local.get $decoded)))
        (local.set $mode
          (i32.load offset=32 (local.get $workspace_address)))
        (if
          (i32.eq (local.get $mode) (global.get $SCAN_MODE_BRACE_START))
          (then
            (if
              (i32.and
                (i32.ge_u (local.get $scalar) (i32.const 48))
                (i32.le_u (local.get $scalar) (i32.const 57)))
              (then
                (if
                  (i32.eqz
                    (i32.load offset=68 (local.get $workspace_address)))
                  (then
                    (return
                      (global.get $STATUS_SYNTAX_ERROR)
                      (local.get $fuel))))
                (i32.store offset=52
                  (local.get $workspace_address)
                  (i32.sub (local.get $scalar) (i32.const 48)))
                (i32.store offset=60
                  (local.get $workspace_address)
                  (i32.const 1))
                (i32.store offset=32
                  (local.get $workspace_address)
                  (global.get $SCAN_MODE_BRACE_MINIMUM))
                (br $next_scalar)))
            (local.set $transition_status
              (call $measurement_add_atom
                (i32.add
                  (local.get $workspace_address)
                  (global.get $SCAN_HEADER_SIZE))
                (call $measurement_workspace_size
                  (local.get $pattern_bytes))
                (local.get $pattern_bytes)
                (i32.const 1)))
            (if
              (i32.ne
                (local.get $transition_status)
                (global.get $STATUS_OK))
              (then
                (return
                  (local.get $transition_status)
                  (local.get $fuel))))
            (i32.store offset=32
              (local.get $workspace_address)
              (global.get $SCAN_MODE_NORMAL))
            (i32.store offset=48
              (local.get $workspace_address)
              (i32.const 1))
            (local.set $transition_status
              (call $scan_normal_scalar
                (local.get $workspace_address)
                (local.get $scalar)))
            (if
              (i32.ne
                (local.get $transition_status)
                (global.get $STATUS_OK))
              (then
                (return
                  (local.get $transition_status)
                  (local.get $fuel))))
            (br $next_scalar)))
        (if
          (i32.eq (local.get $mode) (global.get $SCAN_MODE_BRACE_MINIMUM))
          (then
            (if
              (i32.and
                (i32.ge_u (local.get $scalar) (i32.const 48))
                (i32.le_u (local.get $scalar) (i32.const 57)))
              (then
                (local.set $digit
                  (i32.sub (local.get $scalar) (i32.const 48)))
                (local.set $quantifier_count
                  (i32.load offset=52 (local.get $workspace_address)))
                (if
                  (i32.gt_u
                    (local.get $quantifier_count)
                    (i32.div_u
                      (i32.sub
                        (global.get $MAX_BYTECODE_INSTRUCTIONS)
                        (local.get $digit))
                      (i32.const 10)))
                  (then
                    (return
                      (global.get $STATUS_LIMIT_EXCEEDED)
                      (local.get $fuel))))
                (i32.store offset=52
                  (local.get $workspace_address)
                  (i32.add
                    (i32.mul
                      (local.get $quantifier_count)
                      (i32.const 10))
                    (local.get $digit)))
                (br $next_scalar)))
            (if (i32.eq (local.get $scalar) (i32.const 125))
              (then
                (local.set $transition_status
                  (call $measurement_apply_last_quantifier
                    (i32.add
                      (local.get $workspace_address)
                      (global.get $SCAN_HEADER_SIZE))
                    (call $measurement_workspace_size
                      (local.get $pattern_bytes))
                    (local.get $pattern_bytes)
                    (i32.load offset=52 (local.get $workspace_address))
                    (i32.load offset=52 (local.get $workspace_address))))
                (if
                  (i32.ne
                    (local.get $transition_status)
                    (global.get $STATUS_OK))
                  (then
                    (return
                      (local.get $transition_status)
                      (local.get $fuel))))
                (i32.store offset=56
                  (local.get $workspace_address)
                  (i32.load offset=52 (local.get $workspace_address)))
                (i32.store offset=64
                  (local.get $workspace_address)
                  (i32.const 1))
                (i32.store offset=32
                  (local.get $workspace_address)
                  (global.get $SCAN_MODE_AFTER_QUANTIFIER))
                (br $next_scalar)))
            (if (i32.eq (local.get $scalar) (i32.const 44))
              (then
                (i32.store offset=32
                  (local.get $workspace_address)
                  (global.get $SCAN_MODE_BRACE_AFTER_COMMA))
                (br $next_scalar)))
            (return
              (global.get $STATUS_SYNTAX_ERROR)
              (local.get $fuel))))
        (if
          (i32.eq
            (local.get $mode)
            (global.get $SCAN_MODE_BRACE_AFTER_COMMA))
          (then
            (if
              (i32.and
                (i32.ge_u (local.get $scalar) (i32.const 48))
                (i32.le_u (local.get $scalar) (i32.const 57)))
              (then
                (i32.store offset=56
                  (local.get $workspace_address)
                  (i32.sub (local.get $scalar) (i32.const 48)))
                (i32.store offset=64
                  (local.get $workspace_address)
                  (i32.const 1))
                (i32.store offset=32
                  (local.get $workspace_address)
                  (global.get $SCAN_MODE_BRACE_MAXIMUM))
                (br $next_scalar)))
            (if (i32.eq (local.get $scalar) (i32.const 125))
              (then
                (local.set $transition_status
                  (call $measurement_apply_last_quantifier
                    (i32.add
                      (local.get $workspace_address)
                      (global.get $SCAN_HEADER_SIZE))
                    (call $measurement_workspace_size
                      (local.get $pattern_bytes))
                    (local.get $pattern_bytes)
                    (i32.load offset=52 (local.get $workspace_address))
                    (i32.const -1)))
                (if
                  (i32.ne
                    (local.get $transition_status)
                    (global.get $STATUS_OK))
                  (then
                    (return
                      (local.get $transition_status)
                      (local.get $fuel))))
                (i32.store offset=56
                  (local.get $workspace_address)
                  (i32.const -1))
                (i32.store offset=32
                  (local.get $workspace_address)
                  (global.get $SCAN_MODE_AFTER_QUANTIFIER))
                (br $next_scalar)))
            (return
              (global.get $STATUS_SYNTAX_ERROR)
              (local.get $fuel))))
        (if
          (i32.eq (local.get $mode) (global.get $SCAN_MODE_BRACE_MAXIMUM))
          (then
            (if
              (i32.and
                (i32.ge_u (local.get $scalar) (i32.const 48))
                (i32.le_u (local.get $scalar) (i32.const 57)))
              (then
                (local.set $digit
                  (i32.sub (local.get $scalar) (i32.const 48)))
                (local.set $quantifier_count
                  (i32.load offset=56 (local.get $workspace_address)))
                (if
                  (i32.gt_u
                    (local.get $quantifier_count)
                    (i32.div_u
                      (i32.sub
                        (global.get $MAX_BYTECODE_INSTRUCTIONS)
                        (local.get $digit))
                      (i32.const 10)))
                  (then
                    (return
                      (global.get $STATUS_LIMIT_EXCEEDED)
                      (local.get $fuel))))
                (i32.store offset=56
                  (local.get $workspace_address)
                  (i32.add
                    (i32.mul
                      (local.get $quantifier_count)
                      (i32.const 10))
                    (local.get $digit)))
                (br $next_scalar)))
            (if (i32.eq (local.get $scalar) (i32.const 125))
              (then
                (if
                  (i32.lt_u
                    (i32.load offset=56 (local.get $workspace_address))
                    (i32.load offset=52 (local.get $workspace_address)))
                  (then
                    (return
                      (global.get $STATUS_SYNTAX_ERROR)
                      (local.get $fuel))))
                (local.set $transition_status
                  (call $measurement_apply_last_quantifier
                    (i32.add
                      (local.get $workspace_address)
                      (global.get $SCAN_HEADER_SIZE))
                    (call $measurement_workspace_size
                      (local.get $pattern_bytes))
                    (local.get $pattern_bytes)
                    (i32.load offset=52 (local.get $workspace_address))
                    (i32.load offset=56 (local.get $workspace_address))))
                (if
                  (i32.ne
                    (local.get $transition_status)
                    (global.get $STATUS_OK))
                  (then
                    (return
                      (local.get $transition_status)
                      (local.get $fuel))))
                (i32.store offset=32
                  (local.get $workspace_address)
                  (global.get $SCAN_MODE_AFTER_QUANTIFIER))
                (br $next_scalar)))
            (return
              (global.get $STATUS_SYNTAX_ERROR)
              (local.get $fuel))))
        (if
          (i32.eq
            (local.get $mode)
            (global.get $SCAN_MODE_AFTER_QUANTIFIER))
          (then
            (if (i32.eq (local.get $scalar) (i32.const 43))
              (then
                (return
                  (global.get $STATUS_UNSUPPORTED)
                  (local.get $fuel))))
            (i32.store offset=32
              (local.get $workspace_address)
              (global.get $SCAN_MODE_NORMAL))
            (if (i32.eq (local.get $scalar) (i32.const 63))
              (then (br $next_scalar)))
            (local.set $transition_status
              (call $scan_normal_scalar
                (local.get $workspace_address)
                (local.get $scalar)))
            (if
              (i32.ne
                (local.get $transition_status)
                (global.get $STATUS_OK))
              (then
                (return
                  (local.get $transition_status)
                  (local.get $fuel))))
            (br $next_scalar)))
        (if (i32.eq (local.get $mode) (global.get $SCAN_MODE_ESCAPE))
          (then
            (if
              (i32.or
                (i32.and
                  (i32.ge_u (local.get $scalar) (i32.const 49))
                  (i32.le_u (local.get $scalar) (i32.const 57)))
                (i32.eq (local.get $scalar) (i32.const 107)))
              (then
                (return
                  (global.get $STATUS_UNSUPPORTED)
                  (local.get $fuel))))
            (if (i32.lt_s (call $escape_value (local.get $scalar) (i32.const 0)) (i32.const 0))
              (then
                (return
                  (global.get $STATUS_UNSUPPORTED)
                  (local.get $fuel))))
            (local.set $quantifier_count
              (call $builtin_class_range_count
                (local.get $scalar)
                (i32.const 0)))
            (if (local.get $quantifier_count)
              (then
                (local.set $transition_status
                  (call $add_measured_ranges
                    (local.get $workspace_address)
                    (local.get $quantifier_count)))
                (if
                  (i32.ne
                    (local.get $transition_status)
                    (global.get $STATUS_OK))
                  (then
                    (return
                      (local.get $transition_status)
                      (local.get $fuel))))))
            (local.set $transition_status
              (call $measurement_add_atom
                (i32.add
                  (local.get $workspace_address)
                  (global.get $SCAN_HEADER_SIZE))
                (call $measurement_workspace_size
                  (local.get $pattern_bytes))
                (local.get $pattern_bytes)
                (i32.const 1)))
            (if
              (i32.ne
                (local.get $transition_status)
                (global.get $STATUS_OK))
              (then
                (return
                  (local.get $transition_status)
                  (local.get $fuel))))
            (i32.store offset=32
              (local.get $workspace_address)
              (global.get $SCAN_MODE_NORMAL))
            (i32.store offset=48
              (local.get $workspace_address)
              (i32.const 1))
            (br $next_scalar)))
        (if (i32.eq (local.get $mode) (global.get $SCAN_MODE_CLASS))
          (then
            (if (i32.eq (local.get $scalar) (i32.const 92))
              (then
                (i32.store offset=32
                  (local.get $workspace_address)
                  (global.get $SCAN_MODE_CLASS_ESCAPE))
                (br $next_scalar)))
            (if (i32.eq (local.get $scalar) (i32.const 93))
              (then
                (if (i32.load offset=96 (local.get $workspace_address))
                  (then
                    (local.set $transition_status
                      (call $add_measured_ranges
                        (local.get $workspace_address)
                        (i32.const 2))))
                  (else
                    (if (i32.load offset=88 (local.get $workspace_address))
                      (then
                        (local.set $transition_status
                          (call $add_measured_ranges
                            (local.get $workspace_address)
                            (i32.const 1)))))))
                (if
                  (i32.ne
                    (local.get $transition_status)
                    (global.get $STATUS_OK))
                  (then
                    (return
                      (local.get $transition_status)
                      (local.get $fuel))))
                (local.set $transition_status
                  (call $measurement_add_atom
                    (i32.add
                      (local.get $workspace_address)
                      (global.get $SCAN_HEADER_SIZE))
                    (call $measurement_workspace_size
                      (local.get $pattern_bytes))
                    (local.get $pattern_bytes)
                    (i32.const 1)))
                (if
                  (i32.ne
                    (local.get $transition_status)
                    (global.get $STATUS_OK))
                  (then
                    (return
                      (local.get $transition_status)
                      (local.get $fuel))))
                (i32.store offset=88
                  (local.get $workspace_address)
                  (i32.const 0))
                (i32.store offset=96
                  (local.get $workspace_address)
                  (i32.const 0))
                (i32.store offset=32
                  (local.get $workspace_address)
                  (global.get $SCAN_MODE_NORMAL))
                (i32.store offset=48
                  (local.get $workspace_address)
                  (i32.const 1))
                (br $next_scalar)))
            (if
              (i32.and
                (i32.load offset=84 (local.get $workspace_address))
                (i32.eq (local.get $scalar) (i32.const 94)))
              (then
                (i32.store offset=80
                  (local.get $workspace_address)
                  (i32.const 1))
                (i32.store offset=84
                  (local.get $workspace_address)
                  (i32.const 0))
                (br $next_scalar)))
            (if
              (i32.and
                (i32.eq (local.get $scalar) (i32.const 45))
                (i32.and
                  (i32.load offset=88 (local.get $workspace_address))
                  (i32.eqz
                    (i32.load offset=96 (local.get $workspace_address)))))
              (then
                (i32.store offset=96
                  (local.get $workspace_address)
                  (i32.const 1))
                (i32.store offset=84
                  (local.get $workspace_address)
                  (i32.const 0))
                (br $next_scalar)))
            (local.set $transition_status
              (call $measure_class_literal
                (local.get $workspace_address)
                (local.get $scalar)))
            (if
              (i32.ne
                (local.get $transition_status)
                (global.get $STATUS_OK))
              (then
                (return
                  (local.get $transition_status)
                  (local.get $fuel))))
            (br $next_scalar)))
        (if
          (i32.eq
            (local.get $mode)
            (global.get $SCAN_MODE_CLASS_ESCAPE))
          (then
            (if (i32.lt_s (call $escape_value (local.get $scalar) (i32.const 1)) (i32.const 0))
              (then
                (return
                  (global.get $STATUS_UNSUPPORTED)
                  (local.get $fuel))))
            (local.set $quantifier_count
              (call $builtin_class_range_count
                (local.get $scalar)
                (i32.const 1)))
            (if (local.get $quantifier_count)
              (then
                (if (i32.load offset=96 (local.get $workspace_address))
                  (then
                    (return
                      (global.get $STATUS_SYNTAX_ERROR)
                      (local.get $fuel))))
                (if (i32.load offset=88 (local.get $workspace_address))
                  (then
                    (local.set $transition_status
                      (call $add_measured_ranges
                        (local.get $workspace_address)
                        (i32.const 1)))
                    (if
                      (i32.ne
                        (local.get $transition_status)
                        (global.get $STATUS_OK))
                      (then
                        (return
                          (local.get $transition_status)
                          (local.get $fuel))))
                    (i32.store offset=88
                      (local.get $workspace_address)
                      (i32.const 0))))
                (local.set $transition_status
                  (call $add_measured_ranges
                    (local.get $workspace_address)
                    (local.get $quantifier_count)))
                (i32.store offset=84
                  (local.get $workspace_address)
                  (i32.const 0)))
              (else
                (local.set $transition_status
                  (call $measure_class_literal
                    (local.get $workspace_address)
                    (call $escape_value (local.get $scalar) (i32.const 1))))))
            (if
              (i32.ne
                (local.get $transition_status)
                (global.get $STATUS_OK))
              (then
                (return
                  (local.get $transition_status)
                  (local.get $fuel))))
            (i32.store offset=32
              (local.get $workspace_address)
              (global.get $SCAN_MODE_CLASS))
            (br $next_scalar)))
        (if
          (i32.eq
            (local.get $mode)
            (global.get $SCAN_MODE_AFTER_GROUP_OPEN))
          (then
            (if (i32.eq (local.get $scalar) (i32.const 63))
              (then
                (i32.store offset=32
                  (local.get $workspace_address)
                  (global.get $SCAN_MODE_GROUP_QUESTION))
                (br $next_scalar)))
            (local.set $capture_group_count
              (i32.add
                (i32.load offset=40 (local.get $workspace_address))
                (i32.const 1)))
            (if
              (i32.gt_u
                (local.get $capture_group_count)
                (global.get $MAX_CAPTURE_GROUPS))
              (then
                (return
                  (global.get $STATUS_LIMIT_EXCEEDED)
                  (local.get $fuel))))
            (local.set $transition_status
              (call $measurement_add_atom
                (i32.add
                  (local.get $workspace_address)
                  (global.get $SCAN_HEADER_SIZE))
                (call $measurement_workspace_size
                  (local.get $pattern_bytes))
                (local.get $pattern_bytes)
                (i32.const 2)))
            (if
              (i32.ne
                (local.get $transition_status)
                (global.get $STATUS_OK))
              (then
                (return
                  (local.get $transition_status)
                  (local.get $fuel))))
            (i32.store offset=40
              (local.get $workspace_address)
              (local.get $capture_group_count))
            (i32.store offset=32
              (local.get $workspace_address)
              (global.get $SCAN_MODE_NORMAL))
            (local.set $transition_status
              (call $scan_normal_scalar
                (local.get $workspace_address)
                (local.get $scalar)))
            (if
              (i32.ne
                (local.get $transition_status)
                (global.get $STATUS_OK))
              (then
                (return
                  (local.get $transition_status)
                  (local.get $fuel))))
            (br $next_scalar)))
        (if
          (i32.eq
            (local.get $mode)
            (global.get $SCAN_MODE_GROUP_QUESTION))
          (then
            (if (i32.eq (local.get $scalar) (i32.const 58))
              (then
                (i32.store offset=32
                  (local.get $workspace_address)
                  (global.get $SCAN_MODE_NORMAL))
                (i32.store offset=48
                  (local.get $workspace_address)
                  (i32.const 0))
                (br $next_scalar)))
            (if
              (i32.or
                (i32.eq (local.get $scalar) (i32.const 61))
                (i32.eq (local.get $scalar) (i32.const 33)))
              (then
                (return
                  (global.get $STATUS_UNSUPPORTED)
                  (local.get $fuel))))
            (if (i32.eq (local.get $scalar) (i32.const 60))
              (then
                (i32.store offset=32
                  (local.get $workspace_address)
                  (global.get $SCAN_MODE_GROUP_LESS))
                (br $next_scalar)))
            (return
              (global.get $STATUS_SYNTAX_ERROR)
              (local.get $fuel))))
        (if
          (i32.eq (local.get $mode) (global.get $SCAN_MODE_GROUP_LESS))
          (then
            (if
              (i32.or
                (i32.eq (local.get $scalar) (i32.const 61))
                (i32.eq (local.get $scalar) (i32.const 33)))
              (then
                (return
                  (global.get $STATUS_UNSUPPORTED)
                  (local.get $fuel))))
            (if (i32.eq (local.get $scalar) (i32.const 62))
              (then
                (return
                  (global.get $STATUS_SYNTAX_ERROR)
                  (local.get $fuel))))
            (local.set $capture_group_count
              (i32.add
                (i32.load offset=40 (local.get $workspace_address))
                (i32.const 1)))
            (if
              (i32.gt_u
                (local.get $capture_group_count)
                (global.get $MAX_CAPTURE_GROUPS))
              (then
                (return
                  (global.get $STATUS_LIMIT_EXCEEDED)
                  (local.get $fuel))))
            (local.set $transition_status
              (call $measurement_add_atom
                (i32.add
                  (local.get $workspace_address)
                  (global.get $SCAN_HEADER_SIZE))
                (call $measurement_workspace_size
                  (local.get $pattern_bytes))
                (local.get $pattern_bytes)
                (i32.const 2)))
            (if
              (i32.ne
                (local.get $transition_status)
                (global.get $STATUS_OK))
              (then
                (return
                  (local.get $transition_status)
                  (local.get $fuel))))
            (i32.store offset=40
              (local.get $workspace_address)
              (local.get $capture_group_count))
            (i32.store offset=44
              (local.get $workspace_address)
              (i32.const 1))
            (i32.store offset=72
              (local.get $workspace_address)
              (i32.add
                (i32.load offset=72 (local.get $workspace_address))
                (i32.const 1)))
            (i32.store offset=76
              (local.get $workspace_address)
              (i32.add
                (i32.load offset=76 (local.get $workspace_address))
                (i32.add
                  (i32.const 8)
                  (i32.sub
                    (local.get $cursor)
                    (local.get $scalar_address)))))
            (i32.store offset=32
              (local.get $workspace_address)
              (global.get $SCAN_MODE_NAMED_GROUP))
            (br $next_scalar)))
        (if
          (i32.eq (local.get $mode) (global.get $SCAN_MODE_NAMED_GROUP))
          (then
            (if (i32.eq (local.get $scalar) (i32.const 62))
              (then
                (i32.store offset=32
                  (local.get $workspace_address)
                  (global.get $SCAN_MODE_NORMAL))
                (i32.store offset=44
                  (local.get $workspace_address)
                  (i32.const 0))
                (i32.store offset=48
                  (local.get $workspace_address)
                  (i32.const 0))
                (br $next_scalar)))
            (i32.store offset=44
              (local.get $workspace_address)
              (i32.add
                (i32.load offset=44 (local.get $workspace_address))
                (i32.const 1)))
            (i32.store offset=76
              (local.get $workspace_address)
              (i32.add
                (i32.load offset=76 (local.get $workspace_address))
                (i32.sub
                  (local.get $cursor)
                  (local.get $scalar_address))))
            (br $next_scalar)))
        (local.set $transition_status
          (call $scan_normal_scalar
            (local.get $workspace_address)
            (local.get $scalar)))
        (if
          (i32.ne
            (local.get $transition_status)
            (global.get $STATUS_OK))
          (then
            (return
              (local.get $transition_status)
              (local.get $fuel))))
        (br $next_scalar)))
    (if
      (i32.eq
        (i32.load offset=32 (local.get $workspace_address))
        (global.get $SCAN_MODE_BRACE_START))
      (then
        (local.set $transition_status
          (call $measurement_add_atom
            (i32.add
              (local.get $workspace_address)
              (global.get $SCAN_HEADER_SIZE))
            (call $measurement_workspace_size
              (local.get $pattern_bytes))
            (local.get $pattern_bytes)
            (i32.const 1)))
        (if
          (i32.ne
            (local.get $transition_status)
            (global.get $STATUS_OK))
          (then
            (return
              (local.get $transition_status)
              (local.get $fuel))))
        (i32.store offset=32
          (local.get $workspace_address)
          (global.get $SCAN_MODE_NORMAL))
        (i32.store offset=48
          (local.get $workspace_address)
          (i32.const 1))))
    (if
      (i32.eq
        (i32.load offset=32 (local.get $workspace_address))
        (global.get $SCAN_MODE_AFTER_QUANTIFIER))
      (then
        (i32.store offset=32
          (local.get $workspace_address)
          (global.get $SCAN_MODE_NORMAL))))
    (if
      (i32.or
        (i32.ne
          (i32.load offset=32 (local.get $workspace_address))
          (global.get $SCAN_MODE_NORMAL))
        (i32.ne
          (i32.load offset=36 (local.get $workspace_address))
          (i32.const 0)))
      (then
        (return
          (global.get $STATUS_SYNTAX_ERROR)
          (local.get $fuel))))
    (if
      (i32.or
        (i32.ne
          (i32.load offset=8
            (i32.add
              (local.get $workspace_address)
              (global.get $SCAN_HEADER_SIZE)))
          (i32.const 0))
        (i32.or
          (i32.ne
            (i32.load
              (i32.add
                (i32.add
                  (local.get $workspace_address)
                  (global.get $SCAN_HEADER_SIZE))
                (global.get $MEASUREMENT_HEADER_SIZE)))
            (i32.const 3))
          (i32.lt_u
            (i32.load offset=16
              (i32.add
                (local.get $workspace_address)
                (global.get $SCAN_HEADER_SIZE)))
            (i32.const 3))))
      (then
        (return
          (global.get $STATUS_CORRUPT_PROGRAM)
          (local.get $fuel))))
    (local.set $quantifier_count
      (call $program_size
        (i32.load offset=16
          (i32.add
            (local.get $workspace_address)
            (global.get $SCAN_HEADER_SIZE)))
        (i32.load offset=100 (local.get $workspace_address))
        (i32.load offset=76 (local.get $workspace_address))))
    (if (i32.eq (local.get $quantifier_count) (i32.const -1))
      (then
        (return
          (global.get $STATUS_LIMIT_EXCEEDED)
          (local.get $fuel))))
    (i32.store offset=24
      (local.get $workspace_address)
      (i32.const 1))
    (global.get $STATUS_OK)
    (local.get $fuel))

  (func $scan_workspace_size (export "scan_workspace_size")
    (param $pattern_bytes i32)
    (result i32)
    (local $measurement_bytes i32)
    (local.set $measurement_bytes
      (call $measurement_workspace_size (local.get $pattern_bytes)))
    (if (i32.eq (local.get $measurement_bytes) (i32.const -1))
      (then (return (i32.const -1))))
    (call $checked_add
      (global.get $SCAN_HEADER_SIZE)
      (local.get $measurement_bytes)))

  (func $measured_program_size (export "measured_program_size")
    (param $workspace_address i32)
    (param $workspace_capacity i32)
    (param $pattern_bytes i32)
    (result i32)
    (local $required_workspace_bytes i32)
    (local $memory_bytes i64)
    (local $measurement_address i32)
    (local $measurement_capacity i32)
    (local $status i32)
    (local.set $required_workspace_bytes
      (call $scan_workspace_size (local.get $pattern_bytes)))
    (if
      (i32.or
        (i32.eq (local.get $required_workspace_bytes) (i32.const -1))
        (i32.lt_u
          (local.get $workspace_capacity)
          (local.get $required_workspace_bytes)))
      (then (return (i32.const -1))))
    (local.set $memory_bytes
      (i64.mul (i64.extend_i32_u (memory.size)) (i64.const 65536)))
    (if
      (i64.gt_u
        (i64.add
          (i64.extend_i32_u (local.get $workspace_address))
          (i64.extend_i32_u (local.get $required_workspace_bytes)))
        (local.get $memory_bytes))
      (then (return (i32.const -1))))
    (if
      (i32.or
        (i32.ne
          (i32.load (local.get $workspace_address))
          (global.get $SCAN_MAGIC))
        (i32.or
          (i32.ne
            (i32.load offset=4 (local.get $workspace_address))
            (global.get $STATE_VERSION))
          (i32.or
            (i32.ne
              (i32.load offset=12 (local.get $workspace_address))
              (local.get $pattern_bytes))
            (i32.ne
              (i32.load offset=24 (local.get $workspace_address))
              (i32.const 1)))))
      (then (return (i32.const -1))))
    (if
      (i32.or
        (i32.ne
          (i32.load offset=32 (local.get $workspace_address))
          (global.get $SCAN_MODE_NORMAL))
        (i32.ne
          (i32.load offset=36 (local.get $workspace_address))
          (i32.const 0)))
      (then (return (i32.const -1))))
    (local.set $measurement_address
      (i32.add
        (local.get $workspace_address)
        (global.get $SCAN_HEADER_SIZE)))
    (local.set $measurement_capacity
      (i32.sub
        (local.get $required_workspace_bytes)
        (global.get $SCAN_HEADER_SIZE)))
    (local.set $status
      (call $validate_measurement_workspace
        (local.get $measurement_address)
        (local.get $measurement_capacity)
        (local.get $pattern_bytes)))
    (if (i32.ne (local.get $status) (global.get $STATUS_OK))
      (then (return (i32.const -1))))
    (if
      (i32.or
        (i32.ne
          (i32.load offset=8 (local.get $measurement_address))
          (i32.const 0))
        (i32.ne
          (i32.load
            (i32.add
              (local.get $measurement_address)
              (global.get $MEASUREMENT_HEADER_SIZE)))
          (i32.const 3)))
      (then (return (i32.const -1))))
    (call $program_size
      (i32.load offset=16 (local.get $measurement_address))
      (i32.load offset=100 (local.get $workspace_address))
      (i32.load offset=76 (local.get $workspace_address))))

  ;; Validate every allocation and identity dependency before committing the
  ;; immutable-program header. Magic remains zero until emission finishes.
  (func $initialize_program_emission_impl
    (param $workspace_address i32)
    (param $workspace_capacity i32)
    (param $pattern_bytes i32)
    (param $program_address i32)
    (param $program_capacity i32)
    (param $flags i32)
    (result i32)
    (local $program_bytes i32)
    (local $workspace_bytes i32)
    (local $memory_bytes i64)
    (local $program_end i64)
    (local $workspace_end i64)
    (local $pattern_address i32)
    (local $pattern_end i64)
    (local $measurement_address i32)
    (call $work_add (i32.const 3))
    (local.set $program_bytes
      (call $measured_program_size
        (local.get $workspace_address)
        (local.get $workspace_capacity)
        (local.get $pattern_bytes)))
    (if (i32.eq (local.get $program_bytes) (i32.const -1))
      (then (return (global.get $STATUS_CORRUPT_PROGRAM))))
    (if (i32.lt_u (local.get $program_capacity) (local.get $program_bytes))
      (then (return (global.get $STATUS_BUFFER_TOO_SMALL))))
    (if
      (i32.ne
        (i32.and (local.get $flags) (i32.const 0xffffff50))
        (i32.const 0))
      (then (return (global.get $STATUS_SYNTAX_ERROR))))
    (local.set $memory_bytes
      (i64.mul (i64.extend_i32_u (memory.size)) (i64.const 65536)))
    (if
      (i64.gt_u
        (i64.add
          (i64.extend_i32_u (local.get $program_address))
          (i64.extend_i32_u (local.get $program_capacity)))
        (local.get $memory_bytes))
      (then (return (global.get $STATUS_BUFFER_TOO_SMALL))))
    (local.set $workspace_bytes
      (call $scan_workspace_size (local.get $pattern_bytes)))
    (local.set $program_end
      (i64.add
        (i64.extend_i32_u (local.get $program_address))
        (i64.extend_i32_u (local.get $program_bytes))))
    (local.set $workspace_end
      (i64.add
        (i64.extend_i32_u (local.get $workspace_address))
        (i64.extend_i32_u (local.get $workspace_bytes))))
    (if
      (i32.and
        (i64.lt_u
          (i64.extend_i32_u (local.get $program_address))
          (local.get $workspace_end))
        (i64.lt_u
          (i64.extend_i32_u (local.get $workspace_address))
          (local.get $program_end)))
      (then (return (global.get $STATUS_CORRUPT_PROGRAM))))
    (local.set $pattern_address
      (i32.load offset=8 (local.get $workspace_address)))
    (local.set $pattern_end
      (i64.add
        (i64.extend_i32_u (local.get $pattern_address))
        (i64.extend_i32_u (local.get $pattern_bytes))))
    (if
      (i32.and
        (i64.lt_u
          (i64.extend_i32_u (local.get $program_address))
          (local.get $pattern_end))
        (i64.lt_u
          (i64.extend_i32_u (local.get $pattern_address))
          (local.get $program_end)))
      (then (return (global.get $STATUS_CORRUPT_PROGRAM))))
    (local.set $measurement_address
      (i32.add
        (local.get $workspace_address)
        (global.get $SCAN_HEADER_SIZE)))
    (i32.store (local.get $program_address) (i32.const 0))
    (i32.store offset=4
      (local.get $program_address)
      (global.get $FORMAT_VERSION))
    (i32.store offset=8
      (local.get $program_address)
      (local.get $program_bytes))
    (i32.store offset=12
      (local.get $program_address)
      (i32.load offset=16 (local.get $measurement_address)))
    (i32.store offset=16
      (local.get $program_address)
      (i32.load offset=100 (local.get $workspace_address)))
    (i32.store offset=20
      (local.get $program_address)
      (i32.load offset=40 (local.get $workspace_address)))
    (i32.store offset=24
      (local.get $program_address)
      (local.get $flags))
    (i32.store offset=28
      (local.get $program_address)
      (i32.load offset=76 (local.get $workspace_address)))
    (i32.store offset=32
      (local.get $program_address)
      (i32.load offset=28 (local.get $measurement_address)))
    (i32.store offset=36
      (local.get $program_address)
      (i32.const 0))
    (global.get $STATUS_OK))

  (func $emission_workspace_size (export "emission_workspace_size")
    (param $pattern_bytes i32)
    (result i32)
    (local $entries i32)
    (local $stack_bytes i32)
    (if (i32.gt_u (local.get $pattern_bytes) (global.get $MAX_PATTERN_BYTES))
      (then (return (i32.const -1))))
    (local.set $entries
      (call $checked_add (local.get $pattern_bytes) (i32.const 1)))
    (if (i32.eq (local.get $entries) (i32.const -1))
      (then (return (i32.const -1))))
    (local.set $stack_bytes
      (call $checked_mul
        (local.get $entries)
        (global.get $EMIT_STACK_ENTRY_SIZE)))
    (if (i32.eq (local.get $stack_bytes) (i32.const -1))
      (then (return (i32.const -1))))
    (call $checked_add
      (global.get $EMIT_HEADER_SIZE)
      (local.get $stack_bytes)))

  (func $initialize_emission_workspace_impl
    (param $scan_address i32)
    (param $scan_capacity i32)
    (param $pattern_bytes i32)
    (param $program_address i32)
    (param $program_capacity i32)
    (param $emission_address i32)
    (param $emission_capacity i32)
    (result i32)
    (local $program_bytes i32)
    (local $scan_bytes i32)
    (local $emission_bytes i32)
    (local $memory_bytes i64)
    (local $emission_end i64)
    (local $scan_end i64)
    (local $program_end i64)
    (local $pattern_address i32)
    (local $pattern_end i64)
    (local $root_instruction_address i32)
    (local $root_stack_address i32)
    (call $work_add (i32.const 11))
    (local.set $program_bytes
      (call $measured_program_size
        (local.get $scan_address)
        (local.get $scan_capacity)
        (local.get $pattern_bytes)))
    (if (i32.eq (local.get $program_bytes) (i32.const -1))
      (then (return (global.get $STATUS_CORRUPT_PROGRAM))))
    (if (i32.lt_u (local.get $program_capacity) (local.get $program_bytes))
      (then (return (global.get $STATUS_BUFFER_TOO_SMALL))))
    (local.set $memory_bytes
      (i64.mul (i64.extend_i32_u (memory.size)) (i64.const 65536)))
    (if
      (i64.gt_u
        (i64.add
          (i64.extend_i32_u (local.get $program_address))
          (i64.extend_i32_u (local.get $program_bytes)))
        (local.get $memory_bytes))
      (then (return (global.get $STATUS_BUFFER_TOO_SMALL))))
    (if
      (i32.or
        (i32.ne
          (i32.load (local.get $program_address))
          (i32.const 0))
        (i32.or
          (i32.ne
            (i32.load offset=4 (local.get $program_address))
            (global.get $FORMAT_VERSION))
          (i32.ne
            (i32.load offset=8 (local.get $program_address))
            (local.get $program_bytes))))
      (then (return (global.get $STATUS_CORRUPT_PROGRAM))))
    (local.set $emission_bytes
      (call $emission_workspace_size (local.get $pattern_bytes)))
    (if
      (i32.lt_u
        (local.get $emission_capacity)
        (local.get $emission_bytes))
      (then (return (global.get $STATUS_BUFFER_TOO_SMALL))))
    (if
      (i64.gt_u
        (i64.add
          (i64.extend_i32_u (local.get $emission_address))
          (i64.extend_i32_u (local.get $emission_capacity)))
        (local.get $memory_bytes))
      (then (return (global.get $STATUS_BUFFER_TOO_SMALL))))
    (local.set $scan_bytes
      (call $scan_workspace_size (local.get $pattern_bytes)))
    (local.set $emission_end
      (i64.add
        (i64.extend_i32_u (local.get $emission_address))
        (i64.extend_i32_u (local.get $emission_bytes))))
    (local.set $scan_end
      (i64.add
        (i64.extend_i32_u (local.get $scan_address))
        (i64.extend_i32_u (local.get $scan_bytes))))
    (local.set $program_end
      (i64.add
        (i64.extend_i32_u (local.get $program_address))
        (i64.extend_i32_u (local.get $program_bytes))))
    (if
      (i32.or
        (i32.and
          (i64.lt_u
            (i64.extend_i32_u (local.get $emission_address))
            (local.get $scan_end))
          (i64.lt_u
            (i64.extend_i32_u (local.get $scan_address))
            (local.get $emission_end)))
        (i32.and
          (i64.lt_u
            (i64.extend_i32_u (local.get $emission_address))
            (local.get $program_end))
          (i64.lt_u
            (i64.extend_i32_u (local.get $program_address))
            (local.get $emission_end))))
      (then (return (global.get $STATUS_CORRUPT_PROGRAM))))
    (local.set $pattern_address
      (i32.load offset=8 (local.get $scan_address)))
    (local.set $pattern_end
      (i64.add
        (i64.extend_i32_u (local.get $pattern_address))
        (i64.extend_i32_u (local.get $pattern_bytes))))
    (if
      (i32.and
        (i64.lt_u
          (i64.extend_i32_u (local.get $emission_address))
          (local.get $pattern_end))
        (i64.lt_u
          (i64.extend_i32_u (local.get $pattern_address))
          (local.get $emission_end)))
      (then (return (global.get $STATUS_CORRUPT_PROGRAM))))
    (i32.store (local.get $emission_address) (global.get $EMIT_MAGIC))
    (i32.store offset=4
      (local.get $emission_address)
      (global.get $STATE_VERSION))
    (i32.store offset=8
      (local.get $emission_address)
      (local.get $pattern_address))
    (i32.store offset=12
      (local.get $emission_address)
      (local.get $pattern_bytes))
    (i32.store offset=16
      (local.get $emission_address)
      (local.get $pattern_address))
    (i32.store offset=20
      (local.get $emission_address)
      (local.get $program_address))
    (i32.store offset=24
      (local.get $emission_address)
      (local.get $program_bytes))
    (i32.store offset=28
      (local.get $emission_address)
      (i32.const 1))
    (i32.store offset=32
      (local.get $emission_address)
      (i32.const 0))
    (i32.store offset=36
      (local.get $emission_address)
      (i32.const 0))
    (i32.store offset=40
      (local.get $emission_address)
      (i32.const 0))
    (i32.store offset=44
      (local.get $emission_address)
      (i32.const 0))
    (i32.store offset=48
      (local.get $emission_address)
      (global.get $EMIT_MODE_NORMAL))
    (i32.store offset=52
      (local.get $emission_address)
      (i32.const 0))
    (i32.store offset=56
      (local.get $emission_address)
      (i32.const 0))
    (i32.store offset=60
      (local.get $emission_address)
      (i32.const 0))
    (i32.store offset=64
      (local.get $emission_address)
      (i32.const 0))
    (i32.store offset=68
      (local.get $emission_address)
      (i32.const 0))
    (i32.store offset=72
      (local.get $emission_address)
      (i32.const 0))
    (i32.store offset=76
      (local.get $emission_address)
      (i32.const 0))
    (i32.store offset=80
      (local.get $emission_address)
      (i32.const 0))
    (i32.store offset=84
      (local.get $emission_address)
      (i32.const 0))
    (i32.store offset=88
      (local.get $emission_address)
      (i32.const 0))
    (i32.store offset=92
      (local.get $emission_address)
      (i32.const 0))
    (i32.store offset=96
      (local.get $emission_address)
      (i32.const 0))
    (i32.store offset=100
      (local.get $emission_address)
      (i32.const 0))
    (i32.store offset=104
      (local.get $emission_address)
      (i32.const 0))
    (i32.store offset=108
      (local.get $emission_address)
      (i32.const 0))
    (i32.store offset=112
      (local.get $emission_address)
      (i32.const 0))
    (i32.store offset=116
      (local.get $emission_address)
      (i32.const 0))
    (i32.store offset=120
      (local.get $emission_address)
      (i32.const 0))
    (i32.store offset=124
      (local.get $emission_address)
      (i32.const 0))
    (i32.store offset=128
      (local.get $emission_address)
      (i32.const 0))
    (i32.store offset=132 (local.get $emission_address) (i32.const 0))
    (local.set $root_instruction_address
      (i32.add
        (local.get $program_address)
        (global.get $PROGRAM_HEADER_SIZE)))
    (i32.store
      (local.get $root_instruction_address)
      (global.get $OPCODE_SAVE))
    (i32.store offset=4
      (local.get $root_instruction_address)
      (i32.const 0))
    (i32.store offset=8
      (local.get $root_instruction_address)
      (i32.const 1))
    (i32.store offset=12
      (local.get $root_instruction_address)
      (i32.const 0))
    (local.set $root_stack_address
      (i32.add
        (local.get $emission_address)
        (global.get $EMIT_HEADER_SIZE)))
    (i32.store
      (local.get $root_stack_address)
      (i32.const 0))
    (i32.store offset=4
      (local.get $root_stack_address)
      (i32.const 0))
    (i32.store offset=8
      (local.get $root_stack_address)
      (i32.const 1))
    (i32.store offset=12
      (local.get $root_stack_address)
      (i32.const -1))
    (i32.store offset=16
      (local.get $root_stack_address)
      (i32.const 1))
    (i32.store offset=20
      (local.get $root_stack_address)
      (i32.const 0))
    (global.get $STATUS_OK))
  ;; Read or replace the sole continuation target of a linear instruction.
  (func $emitted_successor
    (param $program_address i32)
    (param $instruction_index i32)
    (result i32)
    (local $instruction_address i32)
    (local $opcode i32)
    (local.set $instruction_address
      (i32.add
        (i32.add
          (local.get $program_address)
          (global.get $PROGRAM_HEADER_SIZE))
        (i32.mul
          (local.get $instruction_index)
          (global.get $INSTRUCTION_SIZE))))
    (local.set $opcode (i32.load (local.get $instruction_address)))
    ;; CHARACTER and SAVE continue through their second operand; ANY and
    ;; both assertions name their successor first, exactly like JUMP.
    (if
      (i32.or
        (i32.eq (local.get $opcode) (global.get $OPCODE_CHARACTER))
        (i32.or
          (i32.eq (local.get $opcode) (global.get $OPCODE_SAVE))
          (i32.eq (local.get $opcode) (global.get $OPCODE_GUARD))))
      (then (return (i32.load offset=8 (local.get $instruction_address)))))
    (if
      (i32.or
        (i32.eq (local.get $opcode) (global.get $OPCODE_JUMP))
        (i32.or
          (i32.eq (local.get $opcode) (global.get $OPCODE_ANY))
          (i32.or
            (i32.eq (local.get $opcode) (global.get $OPCODE_ASSERT_START))
            (i32.eq (local.get $opcode) (global.get $OPCODE_ASSERT_END)))))
      (then (return (i32.load offset=4 (local.get $instruction_address)))))
    (if
      (i32.or
        (i32.eq (local.get $opcode) (global.get $OPCODE_CHARACTER_CLASS))
        (i32.or
          (i32.eq
            (local.get $opcode)
            (global.get $OPCODE_NEGATED_CHARACTER_CLASS))
          (i32.eq (local.get $opcode) (global.get $OPCODE_CLEAR_CAPTURES))))
      (then (return (i32.load offset=12 (local.get $instruction_address)))))
    ;; A split's sole forward branch is its continuation: the entry edge of
    ;; a following alternation branch lives on the split that precedes it.
    (if (i32.eq (local.get $opcode) (global.get $OPCODE_SPLIT))
      (then
        (if
          (i32.and
            (i32.gt_u
              (i32.load offset=4 (local.get $instruction_address))
              (local.get $instruction_index))
            (i32.le_u
              (i32.load offset=8 (local.get $instruction_address))
              (local.get $instruction_index)))
          (then (return (i32.load offset=4 (local.get $instruction_address)))))
        (if
          (i32.and
            (i32.gt_u
              (i32.load offset=8 (local.get $instruction_address))
              (local.get $instruction_index))
            (i32.le_u
              (i32.load offset=4 (local.get $instruction_address))
              (local.get $instruction_index)))
          (then (return (i32.load offset=8 (local.get $instruction_address)))))
        (return (i32.const -1))))
    (i32.const -1))

  (func $set_emitted_successor
    (param $program_address i32)
    (param $instruction_index i32)
    (param $successor i32)
    (result i32)
    (local $instruction_address i32)
    (local $opcode i32)
    (local.set $instruction_address
      (i32.add
        (i32.add
          (local.get $program_address)
          (global.get $PROGRAM_HEADER_SIZE))
        (i32.mul
          (local.get $instruction_index)
          (global.get $INSTRUCTION_SIZE))))
    (local.set $opcode (i32.load (local.get $instruction_address)))
    ;; CHARACTER and SAVE continue through their second operand; ANY and
    ;; both assertions name their successor first, exactly like JUMP.
    (if
      (i32.or
        (i32.eq (local.get $opcode) (global.get $OPCODE_CHARACTER))
        (i32.or
          (i32.eq (local.get $opcode) (global.get $OPCODE_SAVE))
          (i32.eq (local.get $opcode) (global.get $OPCODE_GUARD))))
      (then
        (i32.store offset=8
          (local.get $instruction_address)
          (local.get $successor))
        (return (global.get $STATUS_OK))))
    (if
      (i32.or
        (i32.eq (local.get $opcode) (global.get $OPCODE_JUMP))
        (i32.or
          (i32.eq (local.get $opcode) (global.get $OPCODE_ANY))
          (i32.or
            (i32.eq (local.get $opcode) (global.get $OPCODE_ASSERT_START))
            (i32.eq (local.get $opcode) (global.get $OPCODE_ASSERT_END)))))
      (then
        (i32.store offset=4
          (local.get $instruction_address)
          (local.get $successor))
        (return (global.get $STATUS_OK))))
    (if
      (i32.or
        (i32.eq (local.get $opcode) (global.get $OPCODE_CHARACTER_CLASS))
        (i32.or
          (i32.eq
            (local.get $opcode)
            (global.get $OPCODE_NEGATED_CHARACTER_CLASS))
          (i32.eq (local.get $opcode) (global.get $OPCODE_CLEAR_CAPTURES))))
      (then
        (i32.store offset=12
          (local.get $instruction_address)
          (local.get $successor))
        (return (global.get $STATUS_OK))))
    (if (i32.eq (local.get $opcode) (global.get $OPCODE_SPLIT))
      (then
        (if
          (i32.and
            (i32.gt_u
              (i32.load offset=4 (local.get $instruction_address))
              (local.get $instruction_index))
            (i32.le_u
              (i32.load offset=8 (local.get $instruction_address))
              (local.get $instruction_index)))
          (then
            (i32.store offset=4
              (local.get $instruction_address)
              (local.get $successor))
            (return (global.get $STATUS_OK))))
        (if
          (i32.and
            (i32.gt_u
              (i32.load offset=8 (local.get $instruction_address))
              (local.get $instruction_index))
            (i32.le_u
              (i32.load offset=4 (local.get $instruction_address))
              (local.get $instruction_index)))
          (then
            (i32.store offset=8
              (local.get $instruction_address)
              (local.get $successor))
            (return (global.get $STATUS_OK))))
        (return (global.get $STATUS_CORRUPT_PROGRAM))))
    (global.get $STATUS_CORRUPT_PROGRAM))
  ;; Redirect every control-flow edge in an emitted instruction range.
  (func $redirect_emitted_targets
    (param $program_address i32)
    (param $start_instruction i32)
    (param $end_instruction i32)
    (param $old_target i32)
    (param $new_target i32)
    (result i32)
    (local $instruction_index i32)
    (local $instruction_address i32)
    (local $opcode i32)
    (local.set $instruction_index (local.get $start_instruction))
    (block $instructions_done
      (loop $rewrite_instruction
        (call $work_add (i32.const 1))
        (br_if $instructions_done
          (i32.ge_u
            (local.get $instruction_index)
            (local.get $end_instruction)))
        (local.set $instruction_address
          (i32.add
            (i32.add
              (local.get $program_address)
              (global.get $PROGRAM_HEADER_SIZE))
            (i32.mul
              (local.get $instruction_index)
              (global.get $INSTRUCTION_SIZE))))
        (local.set $opcode (i32.load (local.get $instruction_address)))
        ;; CHARACTER and SAVE continue through their second operand; ANY
        ;; and both assertions name their successor first, like JUMP.
        (if
          (i32.or
            (i32.eq (local.get $opcode) (global.get $OPCODE_CHARACTER))
            (i32.or
              (i32.eq (local.get $opcode) (global.get $OPCODE_SAVE))
              (i32.eq (local.get $opcode) (global.get $OPCODE_GUARD))))
          (then
            (if
              (i32.eq
                (i32.load offset=8 (local.get $instruction_address))
                (local.get $old_target))
              (then
                (i32.store offset=8
                  (local.get $instruction_address)
                  (local.get $new_target)))))
          (else
            (if
              (i32.or
                (i32.eq
                  (local.get $opcode)
                  (global.get $OPCODE_CHARACTER_CLASS))
                (i32.or
                  (i32.eq
                    (local.get $opcode)
                    (global.get $OPCODE_NEGATED_CHARACTER_CLASS))
                  (i32.eq
                    (local.get $opcode)
                    (global.get $OPCODE_CLEAR_CAPTURES))))
              (then
                (if
                  (i32.eq
                    (i32.load offset=12 (local.get $instruction_address))
                    (local.get $old_target))
                  (then
                    (i32.store offset=12
                      (local.get $instruction_address)
                      (local.get $new_target)))))
              (else
                (if
                  (i32.or
                    (i32.eq (local.get $opcode) (global.get $OPCODE_JUMP))
                    (i32.or
                      (i32.eq (local.get $opcode) (global.get $OPCODE_ANY))
                      (i32.or
                        (i32.eq
                          (local.get $opcode)
                          (global.get $OPCODE_ASSERT_START))
                        (i32.eq
                          (local.get $opcode)
                          (global.get $OPCODE_ASSERT_END)))))
                  (then
                    (if
                      (i32.eq
                        (i32.load offset=4 (local.get $instruction_address))
                        (local.get $old_target))
                      (then
                        (i32.store offset=4
                          (local.get $instruction_address)
                          (local.get $new_target)))))
                  (else
                    (if
                      (i32.eq (local.get $opcode) (global.get $OPCODE_SPLIT))
                      (then
                        (if
                          (i32.eq
                            (i32.load offset=4
                              (local.get $instruction_address))
                            (local.get $old_target))
                          (then
                            (i32.store offset=4
                              (local.get $instruction_address)
                              (local.get $new_target))))
                        (if
                          (i32.eq
                            (i32.load offset=8
                              (local.get $instruction_address))
                            (local.get $old_target))
                          (then
                            (i32.store offset=8
                              (local.get $instruction_address)
                              (local.get $new_target)))))
                      (else
                        (return
                          (global.get $STATUS_CORRUPT_PROGRAM)))))))))
        )
        (local.set $instruction_index
          (i32.add (local.get $instruction_index) (i32.const 1)))
        (br $rewrite_instruction)))
    (global.get $STATUS_OK))


  ;; Resolve all alternative tails recorded in a group to one successor.
  ;; Copy an emitted fragment and relocate every target within its closed
  ;; [start, end] target interval by the destination delta.
  (func $clone_emitted_fragment
    (param $program_address i32)
    (param $source_start i32)
    (param $source_end i32)
    (param $destination_start i32)
    (result i32)
    (local $source_index i32)
    (local $destination_index i32)
    (local $instruction_address i32)
    (local $opcode i32)
    (local $delta i32)
    (local $target i32)
    (local.set $delta
      (i32.sub
        (local.get $destination_start)
        (local.get $source_start)))
    (local.set $source_index (local.get $source_start))
    (local.set $destination_index (local.get $destination_start))
    (block $copy_done
      (loop $copy_instruction
        (call $work_add (i32.const 1))
        (br_if $copy_done
          (i32.ge_u (local.get $source_index) (local.get $source_end)))
        (call $work_copy
          (i32.add
            (i32.add
              (local.get $program_address)
              (global.get $PROGRAM_HEADER_SIZE))
            (i32.mul
              (local.get $destination_index)
              (global.get $INSTRUCTION_SIZE)))
          (i32.add
            (i32.add
              (local.get $program_address)
              (global.get $PROGRAM_HEADER_SIZE))
            (i32.mul
              (local.get $source_index)
              (global.get $INSTRUCTION_SIZE)))
          (global.get $INSTRUCTION_SIZE))
        (local.set $instruction_address
          (i32.add
            (i32.add
              (local.get $program_address)
              (global.get $PROGRAM_HEADER_SIZE))
            (i32.mul
              (local.get $destination_index)
              (global.get $INSTRUCTION_SIZE))))
        (local.set $opcode (i32.load (local.get $instruction_address)))
        (if (i32.eq (local.get $opcode) (global.get $OPCODE_SPLIT))
          (then
            (local.set $target
              (i32.load offset=4 (local.get $instruction_address)))
            (if
              (i32.and
                (i32.ge_u (local.get $target) (local.get $source_start))
                (i32.le_u (local.get $target) (local.get $source_end)))
              (then
                (i32.store offset=4
                  (local.get $instruction_address)
                  (i32.add (local.get $target) (local.get $delta)))))
            (local.set $target
              (i32.load offset=8 (local.get $instruction_address)))
            (if
              (i32.and
                (i32.ge_u (local.get $target) (local.get $source_start))
                (i32.le_u (local.get $target) (local.get $source_end)))
              (then
                (i32.store offset=8
                  (local.get $instruction_address)
                  (i32.add (local.get $target) (local.get $delta))))))
          (else
            ;; ANY and both assertions name their successor first, exactly
            ;; like JUMP; CHARACTER and SAVE continue through their second
            ;; operand.
            (if
              (i32.or
                (i32.eq (local.get $opcode) (global.get $OPCODE_JUMP))
                (i32.or
                  (i32.eq (local.get $opcode) (global.get $OPCODE_ANY))
                  (i32.or
                    (i32.eq
                      (local.get $opcode)
                      (global.get $OPCODE_ASSERT_START))
                    (i32.eq
                      (local.get $opcode)
                      (global.get $OPCODE_ASSERT_END)))))
              (then
                (local.set $target
                  (i32.load offset=4 (local.get $instruction_address)))
                (if
                  (i32.and
                    (i32.ge_u (local.get $target) (local.get $source_start))
                    (i32.le_u (local.get $target) (local.get $source_end)))
                  (then
                    (i32.store offset=4
                      (local.get $instruction_address)
                      (i32.add (local.get $target) (local.get $delta))))))
              (else
                (if
                  (i32.or
                    (i32.eq (local.get $opcode) (global.get $OPCODE_CHARACTER))
                    (i32.or
                      (i32.eq (local.get $opcode) (global.get $OPCODE_SAVE))
                      (i32.eq
                        (local.get $opcode)
                        (global.get $OPCODE_GUARD))))
                  (then
                    (local.set $target
                      (i32.load offset=8 (local.get $instruction_address)))
                    (if
                      (i32.and
                        (i32.ge_u
                          (local.get $target)
                          (local.get $source_start))
                        (i32.le_u
                          (local.get $target)
                          (local.get $source_end)))
                      (then
                        (i32.store offset=8
                          (local.get $instruction_address)
                          (i32.add
                            (local.get $target)
                            (local.get $delta))))))
                  (else
                    (if
                      (i32.or
                        (i32.eq
                          (local.get $opcode)
                          (global.get $OPCODE_CHARACTER_CLASS))
                        (i32.or
                          (i32.eq
                            (local.get $opcode)
                            (global.get $OPCODE_NEGATED_CHARACTER_CLASS))
                          (i32.eq
                            (local.get $opcode)
                            (global.get $OPCODE_CLEAR_CAPTURES))))
                      (then
                        (local.set $target
                          (i32.load offset=12
                            (local.get $instruction_address)))
                        (if
                          (i32.and
                            (i32.ge_u
                              (local.get $target)
                              (local.get $source_start))
                            (i32.le_u
                              (local.get $target)
                              (local.get $source_end)))
                          (then
                            (i32.store offset=12
                              (local.get $instruction_address)
                              (i32.add
                                (local.get $target)
                                (local.get $delta))))))
                      (else
                        (return
                          (global.get $STATUS_CORRUPT_PROGRAM)))))))))
        )
        (local.set $source_index
          (i32.add (local.get $source_index) (i32.const 1)))
        (local.set $destination_index
          (i32.add (local.get $destination_index) (i32.const 1)))
        (br $copy_instruction)))
    (global.get $STATUS_OK))

  ;; Emit one CLEAR record that resets the capture slots of the contained
  ;; groups [first group, first group + group count) before continuing.
  (func $emit_clear_captures
    (param $program_address i32)
    (param $instruction_index i32)
    (param $first_group i32)
    (param $group_count i32)
    (param $successor i32)
    (local $instruction_address i32)
    (local.set $instruction_address
      (i32.add
        (i32.add
          (local.get $program_address)
          (global.get $PROGRAM_HEADER_SIZE))
        (i32.mul
          (local.get $instruction_index)
          (global.get $INSTRUCTION_SIZE))))
    (i32.store
      (local.get $instruction_address)
      (global.get $OPCODE_CLEAR_CAPTURES))
    (i32.store offset=4
      (local.get $instruction_address)
      (i32.mul (local.get $first_group) (i32.const 2)))
    (i32.store offset=8
      (local.get $instruction_address)
      (i32.mul (local.get $group_count) (i32.const 2)))
    (i32.store offset=12
      (local.get $instruction_address)
      (local.get $successor)))

  ;; Emit one linear record [opcode, first, second, 0].
  (func $emit_linear_record
    (param $program_address i32)
    (param $instruction_index i32)
    (param $opcode i32)
    (param $first_operand i32)
    (param $second_operand i32)
    (local $instruction_address i32)
    (local.set $instruction_address
      (i32.add
        (i32.add
          (local.get $program_address)
          (global.get $PROGRAM_HEADER_SIZE))
        (i32.mul
          (local.get $instruction_index)
          (global.get $INSTRUCTION_SIZE))))
    (i32.store (local.get $instruction_address) (local.get $opcode))
    (i32.store offset=4
      (local.get $instruction_address)
      (local.get $first_operand))
    (i32.store offset=8
      (local.get $instruction_address)
      (local.get $second_operand))
    (i32.store offset=12
      (local.get $instruction_address)
      (i32.const 0)))

  ;; Expand a parsed bounded quantifier over the last complete atom fragment.
  ;; When the atom contains capture groups and more than one iteration is
  ;; possible, every loop-body re-entry passes one CLEAR so each iteration
  ;; starts with unset contained captures, matching JavaScript's
  ;; per-iteration quantifier semantics. The first iteration needs no CLEAR:
  ;; its slots are unset, or an enclosing loop already cleared them.
  (func $expand_bounded_fragment
    (param $program_address i32)
    (param $emission_address i32)
    (param $lazy i32)
    (result i32)
    (local $atom_start i32)
    (local $atom_count i32)
    (local $atom_end i32)
    (local $minimum i32)
    (local $maximum i32)
    (local $captured i32)
    (local $capture_first i32)
    (local $capture_count i32)
    (local $quantified_count i32)
    (local $quantified_end i32)
    (local $instruction_index i32)
    (local $copy_index i32)
    (local $optional_count i32)
    (local $split_address i32)
    (local $split_index i32)
    (local $clone_start i32)
    (local $loop_target i32)
    (local $atom_entry i32)
    (local $entry_offset i32)
    (local $previous_start i32)
    (local $guard_slot i32)
    (local $status i32)
    (local.set $atom_start
      (i32.load offset=92 (local.get $emission_address)))
    (local.set $atom_count
      (i32.load offset=96 (local.get $emission_address)))
    (local.set $atom_end
      (i32.add (local.get $atom_start) (local.get $atom_count)))
    (local.set $minimum
      (i32.load offset=104 (local.get $emission_address)))
    (local.set $maximum
      (i32.load offset=108 (local.get $emission_address)))
    (local.set $capture_first
      (i32.load offset=116 (local.get $emission_address)))
    (local.set $capture_count
      (i32.load offset=120 (local.get $emission_address)))
    (local.set $atom_entry
      (i32.load offset=124 (local.get $emission_address)))
    ;; A present-but-empty atom (an empty group) expands to nothing; the
    ;; measured size already excludes it. A missing atom is corrupt here:
    ;; the scan pass rejects bounded quantifiers without an atom.
    (if (i32.eqz (local.get $atom_count))
      (then
        (if (i32.eqz (local.get $atom_start))
          (then (return (global.get $STATUS_CORRUPT_PROGRAM))))
        (i32.store offset=28
          (local.get $emission_address)
          (local.get $atom_start))
        (return (global.get $STATUS_OK))))
    (local.set $entry_offset
      (i32.sub (local.get $atom_entry) (local.get $atom_start)))
    (if (i32.ge_u (local.get $entry_offset) (local.get $atom_count))
      (then (return (global.get $STATUS_CORRUPT_PROGRAM))))
    (local.set $captured
      (i32.and
        (i32.ne (local.get $capture_count) (i32.const 0))
        (i32.or
          (i32.eq (local.get $maximum) (i32.const -1))
          (i32.gt_u (local.get $maximum) (i32.const 1)))))
    (if (local.get $captured)
      (then
        (if
          (i32.or
            (i32.eqz (local.get $capture_first))
            (i32.gt_u
              (i32.add
                (local.get $capture_first)
                (i32.sub (local.get $capture_count) (i32.const 1)))
              (i32.load offset=80 (local.get $emission_address))))
          (then (return (global.get $STATUS_CORRUPT_PROGRAM))))))
    (local.set $quantified_count
      (call $quantified_instruction_count
        (local.get $atom_count)
        (local.get $minimum)
        (local.get $maximum)
        (local.get $captured)))
    (if (i32.eq (local.get $quantified_count) (i32.const -1))
      (then (return (global.get $STATUS_CORRUPT_PROGRAM))))
    (local.set $quantified_end
      (i32.add (local.get $atom_start) (local.get $quantified_count)))
    (if
      (i32.gt_u
        (local.get $quantified_end)
        (i32.sub
          (i32.load offset=12 (local.get $program_address))
          (i32.const 2)))
      (then (return (global.get $STATUS_CORRUPT_PROGRAM))))
    (if
      (i32.and
        (i32.ne (local.get $maximum) (i32.const -1))
        (i32.eqz (local.get $maximum)))
      (then
        (local.set $status
          (call $redirect_emitted_targets
            (local.get $program_address)
            (i32.const 0)
            (local.get $atom_start)
            (local.get $atom_entry)
            (local.get $atom_start)))
        (if (i32.ne (local.get $status) (global.get $STATUS_OK))
          (then (return (local.get $status))))
        (i32.store offset=28
          (local.get $emission_address)
          (local.get $atom_start))
        (return (global.get $STATUS_OK))))
    (local.set $instruction_index (local.get $atom_end))
    (local.set $loop_target (local.get $atom_entry))
    (local.set $previous_start (local.get $atom_start))
    (if (i32.gt_u (local.get $minimum) (i32.const 1))
      (then
        (local.set $copy_index (i32.const 1))
        (block $required_done
          (loop $copy_required
            (call $work_add (i32.const 1))
        (br_if $required_done
              (i32.ge_u
                (local.get $copy_index)
                (local.get $minimum)))
            (local.set $clone_start (local.get $instruction_index))
            (if (local.get $captured)
              (then
                ;; The CLEAR chains the previous copy's tails into this
                ;; copy's entry, clearing on the way.
                (call $emit_clear_captures
                  (local.get $program_address)
                  (local.get $instruction_index)
                  (local.get $capture_first)
                  (local.get $capture_count)
                  (i32.add
                    (i32.add (local.get $instruction_index) (i32.const 1))
                    (local.get $entry_offset)))
                (local.set $loop_target (local.get $instruction_index))
                (local.set $clone_start
                  (i32.add (local.get $instruction_index) (i32.const 1))))
              (else
                (local.set $loop_target
                  (i32.add
                    (local.get $instruction_index)
                    (local.get $entry_offset)))))
            ;; Clone from the immediately previous copy: its exit edges
            ;; still point at its own end, so they stay inside the
            ;; relocatable interval. Earlier copies have already had their
            ;; exits retargeted outside it.
            (local.set $status
              (call $clone_emitted_fragment
                (local.get $program_address)
                (local.get $previous_start)
                (i32.add (local.get $previous_start) (local.get $atom_count))
                (local.get $clone_start)))
            (if (i32.ne (local.get $status) (global.get $STATUS_OK))
              (then (return (local.get $status))))
            ;; Without a CLEAR, the previous copy's tails fall through to
            ;; this copy's region start; retarget them at its real entry.
            (if
              (i32.and
                (i32.eqz (local.get $captured))
                (i32.ne (local.get $entry_offset) (i32.const 0)))
              (then
                (local.set $status
                  (call $redirect_emitted_targets
                    (local.get $program_address)
                    (local.get $previous_start)
                    (local.get $clone_start)
                    (local.get $clone_start)
                    (local.get $loop_target)))
                (if (i32.ne (local.get $status) (global.get $STATUS_OK))
                  (then (return (local.get $status))))))
            (local.set $previous_start (local.get $clone_start))
            (local.set $instruction_index
              (i32.add
                (local.get $clone_start)
                (local.get $atom_count)))
            (local.set $copy_index
              (i32.add (local.get $copy_index) (i32.const 1)))
            (br $copy_required)))))
    (if (i32.eq (local.get $maximum) (i32.const -1))
      (then
        ;; Loops with at most one required copy share one CLEAR placed on
        ;; the loop edge. The CLEAR precedes the split so the expansion
        ;; ends on its flow tail.
        (local.set $split_index (local.get $instruction_index))
        (if
          (i32.and
            (local.get $captured)
            (i32.le_u (local.get $minimum) (i32.const 1)))
          (then
            (local.set $split_index
              (i32.add (local.get $instruction_index) (i32.const 1)))))
        (if (i32.eqz (local.get $minimum))
          (then
            (local.set $status
              (call $redirect_emitted_targets
                (local.get $program_address)
                (i32.const 0)
                (local.get $atom_start)
                (local.get $atom_entry)
                (local.get $split_index)))
            (if (i32.ne (local.get $status) (global.get $STATUS_OK))
              (then (return (local.get $status))))
            (local.set $status
              (call $redirect_emitted_targets
                (local.get $program_address)
                (local.get $atom_start)
                (local.get $atom_end)
                (local.get $atom_end)
                (local.get $split_index)))
            (if (i32.ne (local.get $status) (global.get $STATUS_OK))
              (then (return (local.get $status))))
            (local.set $loop_target (local.get $atom_entry))))
        (if
          (i32.and
            (local.get $captured)
            (i32.le_u (local.get $minimum) (i32.const 1)))
          (then
            ;; A single required copy's tails still point at the CLEAR's
            ;; slot; hop them over it to the split.
            (if (i32.eq (local.get $minimum) (i32.const 1))
              (then
                (local.set $status
                  (call $redirect_emitted_targets
                    (local.get $program_address)
                    (local.get $atom_start)
                    (local.get $atom_end)
                    (local.get $atom_end)
                    (local.get $split_index)))
                (if (i32.ne (local.get $status) (global.get $STATUS_OK))
                  (then (return (local.get $status))))))
            (call $emit_clear_captures
              (local.get $program_address)
              (local.get $instruction_index)
              (local.get $capture_first)
              (local.get $capture_count)
              (local.get $loop_target))
            (local.set $loop_target (local.get $instruction_index))))
        (local.set $instruction_index
          (i32.add (local.get $split_index) (i32.const 1)))
        (local.set $split_address
          (i32.add
            (i32.add
              (local.get $program_address)
              (global.get $PROGRAM_HEADER_SIZE))
            (i32.mul
              (local.get $split_index)
              (global.get $INSTRUCTION_SIZE))))
        (i32.store
          (local.get $split_address)
          (global.get $OPCODE_SPLIT))
        (i32.store offset=4
          (local.get $split_address)
          (if (result i32) (local.get $lazy)
            (then (local.get $quantified_end))
            (else (local.get $loop_target))))
        (i32.store offset=8
          (local.get $split_address)
          (if (result i32) (local.get $lazy)
            (then (local.get $loop_target))
            (else (local.get $quantified_end))))
        (i32.store offset=12
          (local.get $split_address)
          (i32.const 0))
        )
      (else
        ;; Every optional copy carries an empty-iteration guard sharing one
        ;; hidden slot per quantifier: a SAVE records where the copy began
        ;; and a GUARD kills iterations that consumed nothing, matching
        ;; JavaScript's rule for optional quantifier iterations.
        (if (i32.gt_u (local.get $maximum) (local.get $minimum))
          (then
            (if
              (i32.ge_u
                (i32.load offset=128 (local.get $emission_address))
                (i32.load offset=32 (local.get $program_address)))
              (then (return (global.get $STATUS_CORRUPT_PROGRAM))))
            (local.set $guard_slot
              (i32.add
                (i32.mul
                  (i32.add
                    (i32.load offset=20 (local.get $program_address))
                    (i32.const 1))
                  (i32.const 2))
                (i32.load offset=128 (local.get $emission_address))))
            (i32.store offset=128
              (local.get $emission_address)
              (i32.add
                (i32.load offset=128 (local.get $emission_address))
                (i32.const 1)))))
        (if (i32.eqz (local.get $minimum))
          (then
            ;; The first copy is already emitted; wrap it in its own
            ;; entry split, guard SAVE, and exit GUARD.
            (local.set $split_index (local.get $instruction_index))
            (local.set $status
              (call $redirect_emitted_targets
                (local.get $program_address)
                (i32.const 0)
                (local.get $atom_start)
                (local.get $atom_entry)
                (local.get $split_index)))
            (if (i32.ne (local.get $status) (global.get $STATUS_OK))
              (then (return (local.get $status))))
            (local.set $split_address
              (i32.add
                (i32.add
                  (local.get $program_address)
                  (global.get $PROGRAM_HEADER_SIZE))
                (i32.mul
                  (local.get $split_index)
                  (global.get $INSTRUCTION_SIZE))))
            (i32.store
              (local.get $split_address)
              (global.get $OPCODE_SPLIT))
            (i32.store offset=4
              (local.get $split_address)
              (if (result i32) (local.get $lazy)
                (then (local.get $quantified_end))
                (else (i32.add (local.get $split_index) (i32.const 1)))))
            (i32.store offset=8
              (local.get $split_address)
              (if (result i32) (local.get $lazy)
                (then (i32.add (local.get $split_index) (i32.const 1)))
                (else (local.get $quantified_end))))
            (i32.store offset=12
              (local.get $split_address)
              (i32.const 0))
            (call $emit_linear_record
              (local.get $program_address)
              (i32.add (local.get $split_index) (i32.const 1))
              (global.get $OPCODE_SAVE)
              (local.get $guard_slot)
              (local.get $atom_entry))
            (call $emit_linear_record
              (local.get $program_address)
              (i32.add (local.get $split_index) (i32.const 2))
              (global.get $OPCODE_GUARD)
              (local.get $guard_slot)
              (i32.add (local.get $split_index) (i32.const 3)))
            (local.set $instruction_index
              (i32.add (local.get $instruction_index) (i32.const 3)))
            (local.set $optional_count
              (i32.sub (local.get $maximum) (i32.const 1))))
          (else
            (local.set $optional_count
              (i32.sub
                (local.get $maximum)
                (local.get $minimum)))))
        (block $optional_done
          (loop $emit_optional
            (call $work_add (i32.const 1))
        (br_if $optional_done (i32.eqz (local.get $optional_count)))
            (local.set $split_index (local.get $instruction_index))
            (local.set $clone_start
              (i32.add
                (i32.add (local.get $split_index) (i32.const 2))
                (local.get $captured)))
            ;; The split's iterate branch records the entry position, then
            ;; clears contained captures when needed, then runs the copy.
            (call $emit_linear_record
              (local.get $program_address)
              (i32.add (local.get $split_index) (i32.const 1))
              (global.get $OPCODE_SAVE)
              (local.get $guard_slot)
              (if (result i32) (local.get $captured)
                (then (i32.add (local.get $split_index) (i32.const 2)))
                (else
                  (i32.add
                    (local.get $clone_start)
                    (local.get $entry_offset)))))
            (if (local.get $captured)
              (then
                (call $emit_clear_captures
                  (local.get $program_address)
                  (i32.add (local.get $split_index) (i32.const 2))
                  (local.get $capture_first)
                  (local.get $capture_count)
                  (i32.add
                    (local.get $clone_start)
                    (local.get $entry_offset)))))
            (local.set $split_address
              (i32.add
                (i32.add
                  (local.get $program_address)
                  (global.get $PROGRAM_HEADER_SIZE))
                (i32.mul
                  (local.get $split_index)
                  (global.get $INSTRUCTION_SIZE))))
            (i32.store
              (local.get $split_address)
              (global.get $OPCODE_SPLIT))
            (i32.store offset=4
              (local.get $split_address)
              (if (result i32) (local.get $lazy)
                (then (local.get $quantified_end))
                (else (i32.add (local.get $split_index) (i32.const 1)))))
            (i32.store offset=8
              (local.get $split_address)
              (if (result i32) (local.get $lazy)
                (then (i32.add (local.get $split_index) (i32.const 1)))
                (else (local.get $quantified_end))))
            (i32.store offset=12
              (local.get $split_address)
              (i32.const 0))
            ;; Clone from the immediately previous copy, whose exit edges
            ;; still land inside the relocatable interval.
            (local.set $status
              (call $clone_emitted_fragment
                (local.get $program_address)
                (local.get $previous_start)
                (i32.add (local.get $previous_start) (local.get $atom_count))
                (local.get $clone_start)))
            (if (i32.ne (local.get $status) (global.get $STATUS_OK))
              (then (return (local.get $status))))
            (local.set $previous_start (local.get $clone_start))
            (call $emit_linear_record
              (local.get $program_address)
              (i32.add (local.get $clone_start) (local.get $atom_count))
              (global.get $OPCODE_GUARD)
              (local.get $guard_slot)
              (i32.add
                (i32.add (local.get $clone_start) (local.get $atom_count))
                (i32.const 1)))
            (local.set $instruction_index
              (i32.add
                (i32.add
                  (local.get $clone_start)
                  (local.get $atom_count))
                (i32.const 1)))
            (local.set $optional_count
              (i32.sub (local.get $optional_count) (i32.const 1)))
            (br $emit_optional)))
        (if (i32.eqz (local.get $minimum))
          (then
            ;; The first copy's exit edges pass through its GUARD.
            (local.set $status
              (call $redirect_emitted_targets
                (local.get $program_address)
                (local.get $atom_start)
                (local.get $atom_end)
                (local.get $atom_end)
                (i32.add (local.get $atom_end) (i32.const 2))))
            (if (i32.ne (local.get $status) (global.get $STATUS_OK))
              (then (return (local.get $status))))))
      ))
    (if (i32.ne (local.get $instruction_index) (local.get $quantified_end))
      (then (return (global.get $STATUS_CORRUPT_PROGRAM))))
    (i32.store offset=28
      (local.get $emission_address)
      (local.get $instruction_index))
    (global.get $STATUS_OK))

  ;; Resolve every alternative's exit edges to one join successor. Each
  ;; split's third operand temporarily holds its branch's region start; all
  ;; edges in that region exiting past the split are retargeted, because a
  ;; quantified atom can leave several such edges, not just one tail.
  (func $finalize_emitted_alternation
    (param $program_address i32)
    (param $stack_address i32)
    (param $successor i32)
    (result i32)
    (local $split_index i32)
    (local $split_address i32)
    (local $region_start i32)
    (local $status i32)
    (local.set $split_index
      (call $emitted_successor
        (local.get $program_address)
        (i32.load offset=4 (local.get $stack_address))))
    (if (i32.eq (local.get $split_index) (i32.const -1))
      (then (return (global.get $STATUS_CORRUPT_PROGRAM))))
    (block $alternation_done
      (loop $patch_alternative
        (call $work_add (i32.const 1))
        (local.set $split_address
          (i32.add
            (i32.add
              (local.get $program_address)
              (global.get $PROGRAM_HEADER_SIZE))
            (i32.mul
              (local.get $split_index)
              (global.get $INSTRUCTION_SIZE))))
        (if
          (i32.ne
            (i32.load (local.get $split_address))
            (global.get $OPCODE_SPLIT))
          (then (return (global.get $STATUS_CORRUPT_PROGRAM))))
        (local.set $region_start
          (i32.load offset=12 (local.get $split_address)))
        (if (i32.gt_u (local.get $region_start) (local.get $split_index))
          (then (return (global.get $STATUS_CORRUPT_PROGRAM))))
        (if (i32.eq (local.get $region_start) (local.get $split_index))
          (then
            ;; This branch is empty, so the split's first alternative
            ;; flows directly to the join.
            (i32.store offset=4
              (local.get $split_address)
              (local.get $successor)))
          (else
            (local.set $status
              (call $redirect_emitted_targets
                (local.get $program_address)
                (local.get $region_start)
                (local.get $split_index)
                (local.get $split_index)
                (local.get $successor)))
            (if (i32.ne (local.get $status) (global.get $STATUS_OK))
              (then (return (local.get $status))))))
        (i32.store offset=12
          (local.get $split_address)
          (i32.const 0))
        (if
          (i32.eq
            (local.get $split_index)
            (i32.load offset=12 (local.get $stack_address)))
          (then (br $alternation_done)))
        (local.set $split_index
          (i32.load offset=8 (local.get $split_address)))
        (br $patch_alternative)))
    (global.get $STATUS_OK))

  ;; Push one capturing or noncapturing group record.
  (func $push_emission_group
    (param $emission_address i32)
    (param $pattern_bytes i32)
    (param $capture_slot i32)
    (result i32)
    (local $group_depth i32)
    (local $stack_address i32)
    (local $instruction_index i32)
    (local.set $instruction_index
      (i32.load offset=28 (local.get $emission_address)))
    (local.set $group_depth
      (i32.add
        (i32.load offset=40 (local.get $emission_address))
        (i32.const 1)))
    (if (i32.gt_u (local.get $group_depth) (local.get $pattern_bytes))
      (then (return (global.get $STATUS_CORRUPT_PROGRAM))))
    (local.set $stack_address
      (i32.add
        (i32.add
          (local.get $emission_address)
          (global.get $EMIT_HEADER_SIZE))
        (i32.mul
          (local.get $group_depth)
          (global.get $EMIT_STACK_ENTRY_SIZE))))
    (i32.store (local.get $stack_address) (local.get $capture_slot))
    (i32.store offset=4
      (local.get $stack_address)
      (if (result i32)
        (local.get $capture_slot)
        (then (local.get $instruction_index))
        (else (i32.sub (local.get $instruction_index) (i32.const 1)))))
    (i32.store offset=8
      (local.get $stack_address)
      (if (result i32)
        (local.get $capture_slot)
        (then (i32.add (local.get $instruction_index) (i32.const 1)))
        (else (local.get $instruction_index))))
    (i32.store offset=12 (local.get $stack_address) (i32.const -1))
    (i32.store offset=16
      (local.get $stack_address)
      (local.get $instruction_index))
    ;; Capture count before this group opened: the group's own number and
    ;; every contained group land above this checkpoint.
    (i32.store offset=20
      (local.get $stack_address)
      (i32.load offset=80 (local.get $emission_address)))
    (i32.store offset=40
      (local.get $emission_address)
      (local.get $group_depth))
    (global.get $STATUS_OK))


  ;; Emit one capture SAVE at the current instruction cursor.
  (func $emit_capture_save
    (param $emission_address i32)
    (param $capture_slot i32)
    (result i32)
    (local $program_address i32)
    (local $instruction_count i32)
    (local $instruction_index i32)
    (local $instruction_address i32)
    (local.set $program_address
      (i32.load offset=20 (local.get $emission_address)))
    (local.set $instruction_count
      (i32.load offset=12 (local.get $program_address)))
    (local.set $instruction_index
      (i32.load offset=28 (local.get $emission_address)))
    (if
      (i32.ge_u
        (i32.add (local.get $instruction_index) (i32.const 2))
        (local.get $instruction_count))
      (then (return (global.get $STATUS_CORRUPT_PROGRAM))))
    (local.set $instruction_address
      (i32.add
        (i32.add
          (local.get $program_address)
          (global.get $PROGRAM_HEADER_SIZE))
        (i32.mul
          (local.get $instruction_index)
          (global.get $INSTRUCTION_SIZE))))
    (i32.store
      (local.get $instruction_address)
      (global.get $OPCODE_SAVE))
    (i32.store offset=4
      (local.get $instruction_address)
      (local.get $capture_slot))
    (i32.store offset=8
      (local.get $instruction_address)
      (i32.add (local.get $instruction_index) (i32.const 1)))
    (i32.store offset=12
      (local.get $instruction_address)
      (i32.const 0))
    (i32.store offset=28
      (local.get $emission_address)
      (i32.add (local.get $instruction_index) (i32.const 1)))
    (global.get $STATUS_OK))

  ;; Commit one inclusive scalar range to the measured program range table.
  (func $append_emitted_range
    (param $emission_address i32)
    (param $range_start i32)
    (param $range_end i32)
    (result i32)
    (local $program_address i32)
    (local $instruction_count i32)
    (local $range_count i32)
    (local $range_index i32)
    (local $range_address i32)
    (if
      (i32.or
        (i32.eqz (call $valid_scalar (local.get $range_start)))
        (i32.or
          (i32.eqz (call $valid_scalar (local.get $range_end)))
          (i32.gt_u (local.get $range_start) (local.get $range_end))))
      (then (return (global.get $STATUS_CORRUPT_PROGRAM))))
    (local.set $program_address
      (i32.load offset=20 (local.get $emission_address)))
    (local.set $instruction_count
      (i32.load offset=12 (local.get $program_address)))
    (local.set $range_count
      (i32.load offset=16 (local.get $program_address)))
    (local.set $range_index
      (i32.load offset=32 (local.get $emission_address)))
    (if (i32.ge_u (local.get $range_index) (local.get $range_count))
      (then (return (global.get $STATUS_CORRUPT_PROGRAM))))
    (local.set $range_address
      (i32.add
        (i32.add
          (i32.add
            (local.get $program_address)
            (global.get $PROGRAM_HEADER_SIZE))
          (i32.mul
            (local.get $instruction_count)
            (global.get $INSTRUCTION_SIZE)))
        (i32.mul (local.get $range_index) (i32.const 8))))
    (i32.store (local.get $range_address) (local.get $range_start))
    (i32.store offset=4 (local.get $range_address) (local.get $range_end))
    (i32.store offset=32
      (local.get $emission_address)
      (i32.add (local.get $range_index) (i32.const 1)))
    (i32.store offset=76
      (local.get $emission_address)
      (i32.add
        (i32.load offset=76 (local.get $emission_address))
        (i32.const 1)))
    (global.get $STATUS_OK))

  ;; Commit a literal as a singleton or as the end of a pending range.
  (func $commit_class_literal
    (param $emission_address i32)
    (param $scalar i32)
    (result i32)
    (local $status i32)
    (if (i32.load offset=68 (local.get $emission_address))
      (then
        (if (i32.eqz (i32.load offset=60 (local.get $emission_address)))
          (then (return (global.get $STATUS_CORRUPT_PROGRAM))))
        (local.set $status
          (call $append_emitted_range
            (local.get $emission_address)
            (i32.load offset=64 (local.get $emission_address))
            (local.get $scalar)))
        (if (i32.ne (local.get $status) (global.get $STATUS_OK))
          (then (return (local.get $status))))
        (i32.store offset=60 (local.get $emission_address) (i32.const 0))
        (i32.store offset=64 (local.get $emission_address) (i32.const 0))
        (i32.store offset=68 (local.get $emission_address) (i32.const 0))
        (return (global.get $STATUS_OK))))
    (if (i32.load offset=60 (local.get $emission_address))
      (then
        (local.set $status
          (call $append_emitted_range
            (local.get $emission_address)
            (i32.load offset=64 (local.get $emission_address))
            (i32.load offset=64 (local.get $emission_address))))
        (if (i32.ne (local.get $status) (global.get $STATUS_OK))
          (then (return (local.get $status))))))
    (i32.store offset=60 (local.get $emission_address) (i32.const 1))
    (i32.store offset=64 (local.get $emission_address) (local.get $scalar))
    (global.get $STATUS_OK))

  ;; Emit a complete pattern. The continuation commits after every source
  ;; scalar and after each of the two root-closing instructions.
  (func $emit_pattern_impl
    (param $emission_address i32)
    (param $emission_capacity i32)
    (param $fuel i32)
    (result i32 i32)
    (local $memory_bytes i64)
    (local $pattern_address i32)
    (local $pattern_bytes i32)
    (local $pattern_end i32)
    (local $cursor i32)
    (local $program_address i32)
    (local $program_bytes i32)
    (local $instruction_count i32)
    (local $instruction_index i32)
    (local $complete i32)
    (local $decoded i64)
    (local $scalar i32)
    (local $instruction_address i32)
    (local $opcode i32)
    (local $next_cursor i32)
    (local $range_count i32)
    (local $range_index i32)
    (local $range_address i32)
    (local $class_range_count i32)
    (local $class_negated i32)
    (local $status i32)
    (local $mode i32)
    (local $builtin_range_count i32)
    (local $builtin_range_index i32)
    (local $builtin_range i64)
    (local $group_depth i32)
    (local $capture_group_count i32)
    (local $stack_address i32)
    (local $capture_slot i32)
    (local $atom_capture_first i32)
    (local $atom_capture_count i32)
    (local $group_entry i32)
    (local $name_base_address i32)
    (local $name_address i32)
    (local $name_bytes_emitted i32)
    (local $name_length i32)
    (local $digit i32)
    (local $quantifier_count i32)
    (local $prior_name_offset i32)
    (local $prior_name_length i32)
    (local $name_byte_index i32)
    (local $names_match i32)
    (local $branch_start i32)
    (local $latest_split i32)
    (local $tail_index i32)
    (local $atom_start i32)
    (local $atom_instruction_count i32)
    (if (i32.lt_u (local.get $emission_capacity) (global.get $EMIT_HEADER_SIZE))
      (then
        (return
          (global.get $STATUS_BUFFER_TOO_SMALL)
          (local.get $fuel))))
    (local.set $memory_bytes
      (i64.mul (i64.extend_i32_u (memory.size)) (i64.const 65536)))
    (if
      (i64.gt_u
        (i64.add
          (i64.extend_i32_u (local.get $emission_address))
          (i64.extend_i32_u (local.get $emission_capacity)))
        (local.get $memory_bytes))
      (then
        (return
          (global.get $STATUS_BUFFER_TOO_SMALL)
          (local.get $fuel))))
    (if
      (i32.or
        (i32.ne
          (i32.load (local.get $emission_address))
          (global.get $EMIT_MAGIC))
        (i32.ne
          (i32.load offset=4 (local.get $emission_address))
          (global.get $STATE_VERSION)))
      (then
        (return
          (global.get $STATUS_CORRUPT_PROGRAM)
          (local.get $fuel))))
    (local.set $pattern_address
      (i32.load offset=8 (local.get $emission_address)))
    (local.set $pattern_bytes
      (i32.load offset=12 (local.get $emission_address)))
    (if
      (i32.lt_u
        (local.get $emission_capacity)
        (call $emission_workspace_size (local.get $pattern_bytes)))
      (then
        (return
          (global.get $STATUS_BUFFER_TOO_SMALL)
          (local.get $fuel))))
    (local.set $pattern_end
      (i32.add (local.get $pattern_address) (local.get $pattern_bytes)))
    (if
      (i32.or
        (i32.lt_u (local.get $pattern_end) (local.get $pattern_address))
        (i64.gt_u
          (i64.extend_i32_u (local.get $pattern_end))
          (local.get $memory_bytes)))
      (then
        (return
          (global.get $STATUS_CORRUPT_PROGRAM)
          (local.get $fuel))))
    (local.set $cursor
      (i32.load offset=16 (local.get $emission_address)))
    (local.set $program_address
      (i32.load offset=20 (local.get $emission_address)))
    (local.set $program_bytes
      (i32.load offset=24 (local.get $emission_address)))
    (local.set $instruction_index
      (i32.load offset=28 (local.get $emission_address)))
    (local.set $complete
      (i32.load offset=44 (local.get $emission_address)))
    (if
      (i32.or
        (i32.lt_u (local.get $cursor) (local.get $pattern_address))
        (i32.gt_u (local.get $cursor) (local.get $pattern_end)))
      (then
        (return
          (global.get $STATUS_CORRUPT_PROGRAM)
          (local.get $fuel))))
    (if
      (i64.gt_u
        (i64.add
          (i64.extend_i32_u (local.get $program_address))
          (i64.extend_i32_u (local.get $program_bytes)))
        (local.get $memory_bytes))
      (then
        (return
          (global.get $STATUS_CORRUPT_PROGRAM)
          (local.get $fuel))))
    (if
      (i32.or
        (i32.ne
          (i32.load (local.get $program_address))
          (if (result i32)
            (i32.eq (local.get $complete) (i32.const 2))
            (then (global.get $PROGRAM_MAGIC))
            (else (i32.const 0))))
        (i32.or
          (i32.ne
            (i32.load offset=4 (local.get $program_address))
            (global.get $FORMAT_VERSION))
          (i32.ne
            (i32.load offset=8 (local.get $program_address))
            (local.get $program_bytes))))
      (then
        (return
          (global.get $STATUS_CORRUPT_PROGRAM)
          (local.get $fuel))))
    (local.set $range_count
      (i32.load offset=16 (local.get $program_address)))
    (local.set $range_index
      (i32.load offset=32 (local.get $emission_address)))
    (if (i32.gt_u (local.get $range_index) (local.get $range_count))
      (then
        (return
          (global.get $STATUS_CORRUPT_PROGRAM)
          (local.get $fuel))))
    (local.set $instruction_count
      (i32.load offset=12 (local.get $program_address)))
    (if
      (i32.or
        (i32.or
          (i32.eqz (local.get $instruction_index))
          (i32.gt_u
            (local.get $instruction_index)
            (local.get $instruction_count)))
        (i32.or
          (i32.lt_u (local.get $instruction_count) (i32.const 3))
          (i32.gt_u (local.get $complete) (i32.const 2))))
      (then
        (return
          (global.get $STATUS_CORRUPT_PROGRAM)
          (local.get $fuel))))
    (local.set $instruction_address
      (i32.add
        (local.get $program_address)
        (global.get $PROGRAM_HEADER_SIZE)))
    (local.set $stack_address
      (i32.add
        (local.get $emission_address)
        (global.get $EMIT_HEADER_SIZE)))
    (if
      (i32.or
        (i32.ne
          (i32.load (local.get $instruction_address))
          (global.get $OPCODE_SAVE))
        (i32.or
          (i32.load offset=4 (local.get $instruction_address))
          (i32.load offset=12 (local.get $instruction_address))))
      (then
        (return
          (global.get $STATUS_CORRUPT_PROGRAM)
          (local.get $fuel))))
    (if
      (i32.or
        (i32.load (local.get $stack_address))
        (i32.or
          (i32.load offset=4 (local.get $stack_address))
          (i32.gt_u
            (i32.load offset=8 (local.get $stack_address))
            (local.get $instruction_index))))
      (then
        (return
          (global.get $STATUS_CORRUPT_PROGRAM)
          (local.get $fuel))))
    (if
      (i32.or
        (i32.eqz
          (i32.load offset=8 (local.get $instruction_address)))
        (i32.or
          (i32.gt_u
            (i32.load offset=8 (local.get $instruction_address))
            (local.get $instruction_index))
          (i32.and
            (i32.ne
              (i32.load offset=12 (local.get $stack_address))
              (i32.const -1))
            (i32.ge_u
              (i32.load offset=12 (local.get $stack_address))
              (local.get $instruction_index)))))
      (then
        (return
          (global.get $STATUS_CORRUPT_PROGRAM)
          (local.get $fuel))))
    (local.set $mode
      (i32.load offset=48 (local.get $emission_address)))
    (if
      (i32.or
        (i32.gt_u
          (local.get $mode)
          (global.get $EMIT_MODE_BOUNDED_READY))
        (i32.or
          (i32.gt_u
            (i32.load offset=52 (local.get $emission_address))
            (i32.const 1))
          (i32.or
            (i32.gt_u
              (i32.load offset=56 (local.get $emission_address))
              (i32.const 1))
            (i32.or
              (i32.gt_u
                (i32.load offset=60 (local.get $emission_address))
                (i32.const 1))
              (i32.gt_u
                (i32.load offset=68 (local.get $emission_address))
                (i32.const 1))))))
      (then
        (return
          (global.get $STATUS_CORRUPT_PROGRAM)
          (local.get $fuel))))
    (if
      (i32.or
        (i32.gt_u
          (i32.load offset=40 (local.get $emission_address))
          (local.get $pattern_bytes))
        (if (result i32)
          (i32.eq
            (local.get $mode)
            (global.get $EMIT_MODE_NAMED_GROUP))
          (then
            (i32.or
              (i32.eqz (i32.load offset=88
                (local.get $emission_address)))
              (i32.ne
                (i32.add
                  (i32.add
                    (i32.load offset=84 (local.get $emission_address))
                    (global.get $NAME_HEADER_SIZE))
                  (i32.load offset=88 (local.get $emission_address)))
                (i32.load offset=36 (local.get $emission_address)))))
          (else
            (i32.or
              (i32.load offset=84 (local.get $emission_address))
              (i32.load offset=88 (local.get $emission_address))))))
      (then
        (return
          (global.get $STATUS_CORRUPT_PROGRAM)
          (local.get $fuel))))
    (if
      (if (result i32)
        (i32.eqz
          (i32.load offset=96 (local.get $emission_address)))
        (then
          (i32.load offset=92 (local.get $emission_address)))
        (else
          (i32.or
            (i32.ge_u
              (i32.load offset=92 (local.get $emission_address))
              (local.get $instruction_index))
            (i32.gt_u
              (i32.load offset=96 (local.get $emission_address))
              (i32.sub
                (local.get $instruction_index)
                (i32.load offset=92 (local.get $emission_address)))))))
      (then
        (return
          (global.get $STATUS_CORRUPT_PROGRAM)
          (local.get $fuel))))
    (if
      (i32.or
        (i32.gt_u
          (i32.load offset=80 (local.get $emission_address))
          (i32.load offset=20 (local.get $program_address)))
        (i32.or
          (i32.gt_u
            (i32.load offset=40 (local.get $emission_address))
            (local.get $pattern_bytes))
          (i32.and
            (i32.and
              (i32.ge_u
                (local.get $mode)
                (global.get $EMIT_MODE_AFTER_GROUP_OPEN))
              (i32.le_u
                (local.get $mode)
                (global.get $EMIT_MODE_NAMED_GROUP)))
            (i32.or
              (i32.load offset=52 (local.get $emission_address))
              (i32.or
                (i32.load offset=56 (local.get $emission_address))
                (i32.or
                  (i32.load offset=60 (local.get $emission_address))
                  (i32.or
                    (i32.load offset=64 (local.get $emission_address))
                    (i32.or
                      (i32.load offset=68 (local.get $emission_address))
                      (i32.or
                        (i32.load offset=72 (local.get $emission_address))
                        (i32.load offset=76
                          (local.get $emission_address)))))))))))
      (then
        (return
          (global.get $STATUS_CORRUPT_PROGRAM)
          (local.get $fuel))))
    (if
      (if (result i32)
        (i32.eq
          (local.get $mode)
          (global.get $EMIT_MODE_AFTER_QUANTIFIER))
        (then
          (i32.ge_u
            (i32.load offset=100 (local.get $emission_address))
            (local.get $instruction_index)))
        (else
          (i32.load offset=100 (local.get $emission_address))))
      (then
        (return
          (global.get $STATUS_CORRUPT_PROGRAM)
          (local.get $fuel))))
    (if
      (i32.and
        (i32.eq
          (local.get $mode)
          (global.get $EMIT_MODE_AFTER_QUANTIFIER))
        (i32.ne
          (i32.load
            (i32.add
              (i32.add
                (local.get $program_address)
                (global.get $PROGRAM_HEADER_SIZE))
              (i32.mul
                (i32.load offset=100 (local.get $emission_address))
                (global.get $INSTRUCTION_SIZE))))
          (global.get $OPCODE_SPLIT)))
      (then
        (return
          (global.get $STATUS_CORRUPT_PROGRAM)
          (local.get $fuel))))
    (if
      (i32.or
        (i32.gt_u
          (i32.load offset=112 (local.get $emission_address))
          (i32.const 1))
        (i32.or
          (i32.gt_u
            (i32.load offset=104 (local.get $emission_address))
            (global.get $MAX_BYTECODE_INSTRUCTIONS))
          (i32.and
            (i32.ne
              (i32.load offset=108 (local.get $emission_address))
              (i32.const -1))
            (i32.gt_u
              (i32.load offset=108 (local.get $emission_address))
              (global.get $MAX_BYTECODE_INSTRUCTIONS)))))
      (then
        (return
          (global.get $STATUS_CORRUPT_PROGRAM)
          (local.get $fuel))))
    (if
      (i32.and
        (i32.lt_u
          (local.get $mode)
          (global.get $EMIT_MODE_BRACE_START))
        (i32.or
          (i32.load offset=104 (local.get $emission_address))
          (i32.or
            (i32.load offset=108 (local.get $emission_address))
            (i32.load offset=112 (local.get $emission_address)))))
      (then
        (return
          (global.get $STATUS_CORRUPT_PROGRAM)
          (local.get $fuel))))
    (if
      (i32.and
        (i32.eq
          (local.get $mode)
          (global.get $EMIT_MODE_BRACE_START))
        (i32.or
          (i32.load offset=104 (local.get $emission_address))
          (i32.or
            (i32.load offset=108 (local.get $emission_address))
            (i32.load offset=112 (local.get $emission_address)))))
      (then
        (return
          (global.get $STATUS_CORRUPT_PROGRAM)
          (local.get $fuel))))
    (if
      (i32.and
        (i32.eq
          (local.get $mode)
          (global.get $EMIT_MODE_BRACE_MINIMUM))
        (i32.or
          (i32.ne
            (i32.load offset=112 (local.get $emission_address))
            (i32.const 1))
          (i32.load offset=108 (local.get $emission_address))))
      (then
        (return
          (global.get $STATUS_CORRUPT_PROGRAM)
          (local.get $fuel))))
    (if
      (i32.and
        (i32.eq
          (local.get $mode)
          (global.get $EMIT_MODE_BRACE_AFTER_COMMA))
        (i32.or
          (i32.load offset=108 (local.get $emission_address))
          (i32.load offset=112 (local.get $emission_address))))
      (then
        (return
          (global.get $STATUS_CORRUPT_PROGRAM)
          (local.get $fuel))))
    (if
      (i32.and
        (i32.eq
          (local.get $mode)
          (global.get $EMIT_MODE_BRACE_MAXIMUM))
        (i32.ne
          (i32.load offset=112 (local.get $emission_address))
          (i32.const 1)))
      (then
        (return
          (global.get $STATUS_CORRUPT_PROGRAM)
          (local.get $fuel))))
    (if
      (i32.and
        (i32.eq
          (local.get $mode)
          (global.get $EMIT_MODE_BOUNDED_READY))
        (i32.or
          (i32.load offset=112 (local.get $emission_address))
          (i32.and
            (i32.ne
              (i32.load offset=108 (local.get $emission_address))
              (i32.const -1))
            (i32.lt_u
              (i32.load offset=108 (local.get $emission_address))
              (i32.load offset=104 (local.get $emission_address))))))
      (then
        (return
          (global.get $STATUS_CORRUPT_PROGRAM)
          (local.get $fuel))))
    (if
      (if (result i32)
        (i32.or
          (i32.eq (local.get $mode) (global.get $EMIT_MODE_NORMAL))
          (i32.gt_u
            (local.get $mode)
            (global.get $EMIT_MODE_CLASS_ESCAPE)))
        (then
          (i32.or
            (i32.load offset=52 (local.get $emission_address))
            (i32.or
              (i32.load offset=56 (local.get $emission_address))
              (i32.or
                (i32.load offset=60 (local.get $emission_address))
                (i32.or
                  (i32.load offset=64 (local.get $emission_address))
                  (i32.or
                    (i32.load offset=68 (local.get $emission_address))
                    (i32.or
                      (i32.load offset=72 (local.get $emission_address))
                      (i32.load offset=76
                        (local.get $emission_address)))))))))
        (else
          (i32.or
            (i32.ne (local.get $complete) (i32.const 0))
            (i32.or
              (i32.gt_u
                (i32.load offset=72 (local.get $emission_address))
                (local.get $range_index))
              (i32.or
                (i32.ne
                  (i32.load offset=76 (local.get $emission_address))
                  (i32.sub
                    (local.get $range_index)
                    (i32.load offset=72 (local.get $emission_address))))
                (i32.and
                  (i32.load offset=68 (local.get $emission_address))
                  (i32.eqz
                    (i32.load offset=60
                      (local.get $emission_address)))))))))
      (then
        (return
          (global.get $STATUS_CORRUPT_PROGRAM)
          (local.get $fuel))))
    (if
      (i32.or
        (i32.and
          (i32.eq (local.get $complete) (i32.const 0))
          (i32.gt_u
            (local.get $instruction_index)
            (local.get $instruction_count)))
        (i32.or
          (i32.and
            (i32.eq (local.get $complete) (i32.const 1))
            (i32.or
              (i32.ne
                (local.get $instruction_index)
                (i32.sub (local.get $instruction_count) (i32.const 1)))
              (i32.or
                (i32.ne (local.get $cursor) (local.get $pattern_end))
                (i32.ne
                  (local.get $range_index)
                  (local.get $range_count)))))
          (i32.and
            (i32.eq (local.get $complete) (i32.const 2))
            (i32.or
              (i32.ne
                (local.get $instruction_index)
                (local.get $instruction_count))
              (i32.or
                (i32.ne (local.get $cursor) (local.get $pattern_end))
                (i32.ne
                  (local.get $range_index)
                  (local.get $range_count)))))))
      (then
        (return
          (global.get $STATUS_CORRUPT_PROGRAM)
          (local.get $fuel))))
    (block $pattern_complete
      (loop $next_literal
        (if
          (i32.and
            (i32.ge_u (local.get $cursor) (local.get $pattern_end))
            (i32.eq
              (local.get $mode)
              (global.get $EMIT_MODE_AFTER_QUANTIFIER)))
          (then
            (local.set $mode (global.get $EMIT_MODE_NORMAL))
            (i32.store offset=48
              (local.get $emission_address)
              (local.get $mode))
            (i32.store offset=100
              (local.get $emission_address)
              (i32.const 0))))
        (if
          (i32.and
            (i32.ge_u (local.get $cursor) (local.get $pattern_end))
            (i32.eq
              (local.get $mode)
              (global.get $EMIT_MODE_BOUNDED_READY)))
          (then
            (local.set $status
              (call $expand_bounded_fragment
                (local.get $program_address)
                (local.get $emission_address)
                (i32.const 0)))
            (if (i32.ne (local.get $status) (global.get $STATUS_OK))
              (then
                (return
                  (local.get $status)
                  (local.get $fuel))))
            (local.set $instruction_index
              (i32.load offset=28 (local.get $emission_address)))
            (local.set $mode (global.get $EMIT_MODE_NORMAL))
            (i32.store offset=48
              (local.get $emission_address)
              (local.get $mode))
            (i32.store offset=92
              (local.get $emission_address)
              (i32.const 0))
            (i32.store offset=96
              (local.get $emission_address)
              (i32.const 0))
            (i32.store offset=116
              (local.get $emission_address)
              (i32.const 0))
            (i32.store offset=120
              (local.get $emission_address)
              (i32.const 0))
            (i32.store offset=124
              (local.get $emission_address)
              (i32.const 0))
            (i32.store offset=104
              (local.get $emission_address)
              (i32.const 0))
            (i32.store offset=108
              (local.get $emission_address)
              (i32.const 0))))
        (br_if $pattern_complete
          (i32.ge_u (local.get $cursor) (local.get $pattern_end)))
        (local.set $fuel (call $work_take (local.get $fuel)))
        (if (i32.le_s (local.get $fuel) (i32.const 0))
          (then
            (return
              (global.get $STATUS_PAUSED)
              (local.get $fuel))))
        (local.set $decoded
          (call $decode_scalar
            (local.get $cursor)
            (local.get $pattern_end)))
        (if (i64.eq (local.get $decoded) (i64.const -1))
          (then
            (return
              (global.get $STATUS_INVALID_UTF8)
              (local.get $fuel))))
        (local.set $scalar (i32.wrap_i64 (local.get $decoded)))
        (local.set $next_cursor
          (i32.wrap_i64 (i64.shr_u (local.get $decoded) (i64.const 32))))
        (block $opcode_ready
        (if
          (i32.eq
            (local.get $mode)
            (global.get $EMIT_MODE_AFTER_GROUP_OPEN))
          (then
            (if (i32.eq (local.get $scalar) (i32.const 63))
              (then
                (local.set $mode (global.get $EMIT_MODE_GROUP_QUESTION))
                (i32.store offset=48
                  (local.get $emission_address)
                  (local.get $mode))
                (i32.store offset=16
                  (local.get $emission_address)
                  (local.get $next_cursor))
                (local.set $cursor (local.get $next_cursor))
                (call $work_add (i32.const 1))
                (br $next_literal)))
            (local.set $capture_group_count
              (i32.add
                (i32.load offset=80 (local.get $emission_address))
                (i32.const 1)))
            (if
              (i32.gt_u
                (local.get $capture_group_count)
                (i32.load offset=20 (local.get $program_address)))
              (then
                (return
                  (global.get $STATUS_CORRUPT_PROGRAM)
                  (local.get $fuel))))
            (local.set $capture_slot
              (i32.mul
                (local.get $capture_group_count)
                (i32.const 2)))
            (local.set $status
              (call $push_emission_group
                (local.get $emission_address)
                (local.get $pattern_bytes)
                (local.get $capture_slot)))
            (if (i32.ne (local.get $status) (global.get $STATUS_OK))
              (then
                (return
                  (local.get $status)
                  (local.get $fuel))))
            (i32.store offset=80
              (local.get $emission_address)
              (local.get $capture_group_count))
            (local.set $status
              (call $emit_capture_save
                (local.get $emission_address)
                (local.get $capture_slot)))
            (if (i32.ne (local.get $status) (global.get $STATUS_OK))
              (then
                (return
                  (local.get $status)
                  (local.get $fuel))))
            (local.set $instruction_index
              (i32.load offset=28 (local.get $emission_address)))
            (local.set $mode (global.get $EMIT_MODE_NORMAL))
            (i32.store offset=48
              (local.get $emission_address)
              (local.get $mode))
            (call $work_add (i32.const 1))
            (br $next_literal)))
        (if
          (i32.eq
            (local.get $mode)
            (global.get $EMIT_MODE_GROUP_QUESTION))
          (then
            (if (i32.eq (local.get $scalar) (i32.const 60))
              (then
                (local.set $mode (global.get $EMIT_MODE_GROUP_LESS))
                (i32.store offset=48
                  (local.get $emission_address)
                  (local.get $mode))
                (i32.store offset=16
                  (local.get $emission_address)
                  (local.get $next_cursor))
                (local.set $cursor (local.get $next_cursor))
                (call $work_add (i32.const 1))
                (br $next_literal)))
            (if (i32.ne (local.get $scalar) (i32.const 58))
              (then
                (return
                  (global.get $STATUS_UNSUPPORTED)
                  (local.get $fuel))))
            (local.set $status
              (call $push_emission_group
                (local.get $emission_address)
                (local.get $pattern_bytes)
                (i32.const 0)))
            (if (i32.ne (local.get $status) (global.get $STATUS_OK))
              (then
                (return
                  (local.get $status)
                  (local.get $fuel))))
            (local.set $mode (global.get $EMIT_MODE_NORMAL))
            (i32.store offset=48
              (local.get $emission_address)
              (local.get $mode))
            (i32.store offset=16
              (local.get $emission_address)
              (local.get $next_cursor))
            (local.set $cursor (local.get $next_cursor))
            (call $work_add (i32.const 1))
            (br $next_literal)))
        (if
          (i32.eq
            (local.get $mode)
            (global.get $EMIT_MODE_GROUP_LESS))
          (then
            (if
              (i32.or
                (i32.eq (local.get $scalar) (i32.const 61))
                (i32.eq (local.get $scalar) (i32.const 33)))
              (then
                (return
                  (global.get $STATUS_UNSUPPORTED)
                  (local.get $fuel))))
            (if (i32.eq (local.get $scalar) (i32.const 62))
              (then
                (return
                  (global.get $STATUS_SYNTAX_ERROR)
                  (local.get $fuel))))
            (local.set $capture_group_count
              (i32.add
                (i32.load offset=80 (local.get $emission_address))
                (i32.const 1)))
            (if
              (i32.gt_u
                (local.get $capture_group_count)
                (i32.load offset=20 (local.get $program_address)))
              (then
                (return
                  (global.get $STATUS_CORRUPT_PROGRAM)
                  (local.get $fuel))))
            (local.set $name_bytes_emitted
              (i32.load offset=36 (local.get $emission_address)))
            (local.set $name_length
              (i32.sub (local.get $next_cursor) (local.get $cursor)))
            (if
              (i32.gt_u
                (i32.add
                  (i32.add
                    (local.get $name_bytes_emitted)
                    (global.get $NAME_HEADER_SIZE))
                  (local.get $name_length))
                (i32.load offset=28 (local.get $program_address)))
              (then
                (return
                  (global.get $STATUS_CORRUPT_PROGRAM)
                  (local.get $fuel))))
            (local.set $name_base_address
              (i32.add
                (i32.add
                  (i32.add
                    (local.get $program_address)
                    (global.get $PROGRAM_HEADER_SIZE))
                  (i32.mul
                    (local.get $instruction_count)
                    (global.get $INSTRUCTION_SIZE)))
                (i32.mul
                  (local.get $range_count)
                  (global.get $RANGE_SIZE))))
            (local.set $name_address
              (i32.add
                (local.get $name_base_address)
                (local.get $name_bytes_emitted)))
            (i32.store
              (local.get $name_address)
              (local.get $capture_group_count))
            (i32.store offset=4
              (local.get $name_address)
              (local.get $name_length))
            (call $work_copy
              (i32.add
                (local.get $name_address)
                (global.get $NAME_HEADER_SIZE))
              (local.get $cursor)
              (local.get $name_length))
            (i32.store offset=80
              (local.get $emission_address)
              (local.get $capture_group_count))
            (i32.store offset=84
              (local.get $emission_address)
              (local.get $name_bytes_emitted))
            (i32.store offset=88
              (local.get $emission_address)
              (local.get $name_length))
            (i32.store offset=36
              (local.get $emission_address)
              (i32.add
                (i32.add
                  (local.get $name_bytes_emitted)
                  (global.get $NAME_HEADER_SIZE))
                (local.get $name_length)))
            (local.set $mode (global.get $EMIT_MODE_NAMED_GROUP))
            (i32.store offset=48
              (local.get $emission_address)
              (local.get $mode))
            (i32.store offset=16
              (local.get $emission_address)
              (local.get $next_cursor))
            (local.set $cursor (local.get $next_cursor))
            (call $work_add (i32.const 1))
            (br $next_literal)))
        (if
          (i32.eq
            (local.get $mode)
            (global.get $EMIT_MODE_NAMED_GROUP))
          (then
            (local.set $name_bytes_emitted
              (i32.load offset=36 (local.get $emission_address)))
            (local.set $name_length
              (i32.load offset=88 (local.get $emission_address)))
            (local.set $name_base_address
              (i32.add
                (i32.add
                  (i32.add
                    (local.get $program_address)
                    (global.get $PROGRAM_HEADER_SIZE))
                  (i32.mul
                    (local.get $instruction_count)
                    (global.get $INSTRUCTION_SIZE)))
                (i32.mul
                  (local.get $range_count)
                  (global.get $RANGE_SIZE))))
            (local.set $name_address
              (i32.add
                (local.get $name_base_address)
                (i32.load offset=84 (local.get $emission_address))))
            (if (i32.eq (local.get $scalar) (i32.const 62))
              (then
                (local.set $prior_name_offset (i32.const 0))
                (block $names_checked
                  (loop $check_prior_name
                    (call $work_add (i32.const 1))
        (br_if $names_checked
                      (i32.ge_u
                        (local.get $prior_name_offset)
                        (i32.load offset=84
                          (local.get $emission_address))))
                    (local.set $prior_name_length
                      (i32.load offset=4
                        (i32.add
                          (local.get $name_base_address)
                          (local.get $prior_name_offset))))
                    (if
                      (i32.eq
                        (local.get $prior_name_length)
                        (local.get $name_length))
                      (then
                        (local.set $names_match (i32.const 1))
                        (local.set $name_byte_index (i32.const 0))
                        (block $name_bytes_checked
                          (loop $check_name_byte
                            (call $work_add (i32.const 1))
        (br_if $name_bytes_checked
                              (i32.ge_u
                                (local.get $name_byte_index)
                                (local.get $name_length)))
                            (if
                              (i32.ne
                                (call $work_byte (i32.add
                                    (i32.add
                                      (i32.add
                                        (local.get $name_base_address)
                                        (local.get $prior_name_offset))
                                      (global.get $NAME_HEADER_SIZE))
                                    (local.get $name_byte_index)))
                                (call $work_byte (i32.add
                                    (i32.add
                                      (local.get $name_address)
                                      (global.get $NAME_HEADER_SIZE))
                                    (local.get $name_byte_index))))
                              (then
                                (local.set $names_match (i32.const 0))
                                (br $name_bytes_checked)))
                            (local.set $name_byte_index
                              (i32.add
                                (local.get $name_byte_index)
                                (i32.const 1)))
                            (br $check_name_byte)))
                        (if (local.get $names_match)
                          (then
                            (return
                              (global.get $STATUS_SYNTAX_ERROR)
                              (local.get $fuel))))))
                    (local.set $prior_name_offset
                      (i32.add
                        (i32.add
                          (local.get $prior_name_offset)
                          (global.get $NAME_HEADER_SIZE))
                        (local.get $prior_name_length)))
                    (br $check_prior_name)))
                (i32.store offset=80
                  (local.get $emission_address)
                  (i32.sub
                    (i32.load offset=80 (local.get $emission_address))
                    (i32.const 1)))
                (i32.store offset=84
                  (local.get $emission_address)
                  (i32.const 0))
                (i32.store offset=88
                  (local.get $emission_address)
                  (i32.const 0))
                (local.set $mode (global.get $EMIT_MODE_AFTER_GROUP_OPEN))
                (i32.store offset=48
                  (local.get $emission_address)
                  (local.get $mode))
                (i32.store offset=16
                  (local.get $emission_address)
                  (local.get $next_cursor))
                (local.set $cursor (local.get $next_cursor))
                (call $work_add (i32.const 1))
                (br $next_literal)))
            (local.set $name_length
              (i32.sub (local.get $next_cursor) (local.get $cursor)))
            (if
              (i32.gt_u
                (i32.add
                  (local.get $name_bytes_emitted)
                  (local.get $name_length))
                (i32.load offset=28 (local.get $program_address)))
              (then
                (return
                  (global.get $STATUS_CORRUPT_PROGRAM)
                  (local.get $fuel))))
            (call $work_copy
              (i32.add
                (local.get $name_base_address)
                (local.get $name_bytes_emitted))
              (local.get $cursor)
              (local.get $name_length))
            (i32.store offset=4
              (local.get $name_address)
              (i32.add
                (i32.load offset=4 (local.get $name_address))
                (local.get $name_length)))
            (i32.store offset=36
              (local.get $emission_address)
              (i32.add
                (local.get $name_bytes_emitted)
                (local.get $name_length)))
            (i32.store offset=88
              (local.get $emission_address)
              (i32.add
                (i32.load offset=88 (local.get $emission_address))
                (local.get $name_length)))
            (i32.store offset=16
              (local.get $emission_address)
              (local.get $next_cursor))
            (local.set $cursor (local.get $next_cursor))
            (call $work_add (i32.const 1))
            (br $next_literal)))
        (if
          (i32.eq
            (local.get $mode)
            (global.get $EMIT_MODE_AFTER_QUANTIFIER))
          (then
            ;; An empty atom's quantifier emitted nothing; index zero is the
            ;; root SAVE and marks that there is no split to make lazy.
            (if (i32.eqz (i32.load offset=100 (local.get $emission_address)))
              (then
                (local.set $mode (global.get $EMIT_MODE_NORMAL))
                (i32.store offset=48
                  (local.get $emission_address)
                  (local.get $mode))
                (if (i32.eq (local.get $scalar) (i32.const 63))
                  (then
                    (i32.store offset=16
                      (local.get $emission_address)
                      (local.get $next_cursor))
                    (local.set $cursor (local.get $next_cursor))
                    (call $work_add (i32.const 1))
                    (br $next_literal))))
              (else
                (local.set $instruction_address
                  (i32.add
                    (i32.add
                      (local.get $program_address)
                      (global.get $PROGRAM_HEADER_SIZE))
                    (i32.mul
                      (i32.load offset=100 (local.get $emission_address))
                      (global.get $INSTRUCTION_SIZE))))
                (if
                  (i32.ne
                    (i32.load (local.get $instruction_address))
                    (global.get $OPCODE_SPLIT))
                  (then
                    (return
                      (global.get $STATUS_CORRUPT_PROGRAM)
                      (local.get $fuel))))
                (local.set $mode (global.get $EMIT_MODE_NORMAL))
                (i32.store offset=48
                  (local.get $emission_address)
                  (local.get $mode))
                (i32.store offset=100
                  (local.get $emission_address)
                  (i32.const 0))
                (if (i32.eq (local.get $scalar) (i32.const 63))
                  (then
                    (local.set $branch_start
                      (i32.load offset=4 (local.get $instruction_address)))
                    (i32.store offset=4
                      (local.get $instruction_address)
                      (i32.load offset=8 (local.get $instruction_address)))
                    (i32.store offset=8
                      (local.get $instruction_address)
                      (local.get $branch_start))
                    (i32.store offset=16
                      (local.get $emission_address)
                      (local.get $next_cursor))
                    (local.set $cursor (local.get $next_cursor))
                    (call $work_add (i32.const 1))
                    (br $next_literal))))))
        )
        (if
          (i32.eq
            (local.get $mode)
            (global.get $EMIT_MODE_BRACE_START))
          (then
            (if
              (i32.or
                (i32.lt_u (local.get $scalar) (i32.const 48))
                (i32.gt_u (local.get $scalar) (i32.const 57)))
              (then
                (return
                  (global.get $STATUS_SYNTAX_ERROR)
                  (local.get $fuel))))
            (i32.store offset=104
              (local.get $emission_address)
              (i32.sub (local.get $scalar) (i32.const 48)))
            (i32.store offset=112
              (local.get $emission_address)
              (i32.const 1))
            (local.set $mode (global.get $EMIT_MODE_BRACE_MINIMUM))
            (i32.store offset=48
              (local.get $emission_address)
              (local.get $mode))
            (i32.store offset=16
              (local.get $emission_address)
              (local.get $next_cursor))
            (local.set $cursor (local.get $next_cursor))
            (call $work_add (i32.const 1))
            (br $next_literal)))
        (if
          (i32.eq
            (local.get $mode)
            (global.get $EMIT_MODE_BRACE_MINIMUM))
          (then
            (if
              (i32.and
                (i32.ge_u (local.get $scalar) (i32.const 48))
                (i32.le_u (local.get $scalar) (i32.const 57)))
              (then
                (local.set $digit
                  (i32.sub (local.get $scalar) (i32.const 48)))
                (local.set $quantifier_count
                  (i32.load offset=104 (local.get $emission_address)))
                (if
                  (i32.gt_u
                    (local.get $quantifier_count)
                    (i32.div_u
                      (i32.sub
                        (global.get $MAX_BYTECODE_INSTRUCTIONS)
                        (local.get $digit))
                      (i32.const 10)))
                  (then
                    (return
                      (global.get $STATUS_LIMIT_EXCEEDED)
                      (local.get $fuel))))
                (i32.store offset=104
                  (local.get $emission_address)
                  (i32.add
                    (i32.mul
                      (local.get $quantifier_count)
                      (i32.const 10))
                    (local.get $digit)))
                (i32.store offset=16
                  (local.get $emission_address)
                  (local.get $next_cursor))
                (local.set $cursor (local.get $next_cursor))
                (call $work_add (i32.const 1))
                (br $next_literal)))
            (if
              (i32.or
                (i32.eq (local.get $scalar) (i32.const 44))
                (i32.eq (local.get $scalar) (i32.const 125)))
              (then
                (if (i32.eq (local.get $scalar) (i32.const 44))
                  (then
                    (local.set $mode
                      (global.get $EMIT_MODE_BRACE_AFTER_COMMA)))
                  (else
                    (i32.store offset=108
                      (local.get $emission_address)
                      (i32.load offset=104
                        (local.get $emission_address)))
                    (local.set $mode
                      (global.get $EMIT_MODE_BOUNDED_READY))))
                (i32.store offset=48
                  (local.get $emission_address)
                  (local.get $mode))
                (i32.store offset=112
                  (local.get $emission_address)
                  (i32.const 0))
                (i32.store offset=16
                  (local.get $emission_address)
                  (local.get $next_cursor))
                (local.set $cursor (local.get $next_cursor))
                (call $work_add (i32.const 1))
                (br $next_literal)))
            (return
              (global.get $STATUS_SYNTAX_ERROR)
              (local.get $fuel))))
        (if
          (i32.eq
            (local.get $mode)
            (global.get $EMIT_MODE_BRACE_AFTER_COMMA))
          (then
            (if (i32.eq (local.get $scalar) (i32.const 125))
              (then
                (i32.store offset=108
                  (local.get $emission_address)
                  (i32.const -1))
                (local.set $mode (global.get $EMIT_MODE_BOUNDED_READY))
                (i32.store offset=48
                  (local.get $emission_address)
                  (local.get $mode))
                (i32.store offset=16
                  (local.get $emission_address)
                  (local.get $next_cursor))
                (local.set $cursor (local.get $next_cursor))
                (call $work_add (i32.const 1))
                (br $next_literal)))
            (if
              (i32.and
                (i32.ge_u (local.get $scalar) (i32.const 48))
                (i32.le_u (local.get $scalar) (i32.const 57)))
              (then
                (i32.store offset=108
                  (local.get $emission_address)
                  (i32.sub (local.get $scalar) (i32.const 48)))
                (i32.store offset=112
                  (local.get $emission_address)
                  (i32.const 1))
                (local.set $mode (global.get $EMIT_MODE_BRACE_MAXIMUM))
                (i32.store offset=48
                  (local.get $emission_address)
                  (local.get $mode))
                (i32.store offset=16
                  (local.get $emission_address)
                  (local.get $next_cursor))
                (local.set $cursor (local.get $next_cursor))
                (call $work_add (i32.const 1))
                (br $next_literal)))
            (return
              (global.get $STATUS_SYNTAX_ERROR)
              (local.get $fuel))))
        (if
          (i32.eq
            (local.get $mode)
            (global.get $EMIT_MODE_BRACE_MAXIMUM))
          (then
            (if
              (i32.and
                (i32.ge_u (local.get $scalar) (i32.const 48))
                (i32.le_u (local.get $scalar) (i32.const 57)))
              (then
                (local.set $digit
                  (i32.sub (local.get $scalar) (i32.const 48)))
                (local.set $quantifier_count
                  (i32.load offset=108 (local.get $emission_address)))
                (if
                  (i32.gt_u
                    (local.get $quantifier_count)
                    (i32.div_u
                      (i32.sub
                        (global.get $MAX_BYTECODE_INSTRUCTIONS)
                        (local.get $digit))
                      (i32.const 10)))
                  (then
                    (return
                      (global.get $STATUS_LIMIT_EXCEEDED)
                      (local.get $fuel))))
                (i32.store offset=108
                  (local.get $emission_address)
                  (i32.add
                    (i32.mul
                      (local.get $quantifier_count)
                      (i32.const 10))
                    (local.get $digit)))
                (i32.store offset=16
                  (local.get $emission_address)
                  (local.get $next_cursor))
                (local.set $cursor (local.get $next_cursor))
                (call $work_add (i32.const 1))
                (br $next_literal)))
            (if (i32.ne (local.get $scalar) (i32.const 125))
              (then
                (return
                  (global.get $STATUS_SYNTAX_ERROR)
                  (local.get $fuel))))
            (if
              (i32.lt_u
                (i32.load offset=108 (local.get $emission_address))
                (i32.load offset=104 (local.get $emission_address)))
              (then
                (return
                  (global.get $STATUS_SYNTAX_ERROR)
                  (local.get $fuel))))
            (local.set $mode (global.get $EMIT_MODE_BOUNDED_READY))
            (i32.store offset=48
              (local.get $emission_address)
              (local.get $mode))
            (i32.store offset=112
              (local.get $emission_address)
              (i32.const 0))
            (i32.store offset=16
              (local.get $emission_address)
              (local.get $next_cursor))
            (local.set $cursor (local.get $next_cursor))
            (call $work_add (i32.const 1))
            (br $next_literal)))
        (if
          (i32.eq
            (local.get $mode)
            (global.get $EMIT_MODE_BOUNDED_READY))
          (then
            (local.set $status
              (call $expand_bounded_fragment
                (local.get $program_address)
                (local.get $emission_address)
                (i32.eq (local.get $scalar) (i32.const 63))))
            (if (i32.ne (local.get $status) (global.get $STATUS_OK))
              (then
                (return
                  (local.get $status)
                  (local.get $fuel))))
            (local.set $instruction_index
              (i32.load offset=28 (local.get $emission_address)))
            (local.set $mode (global.get $EMIT_MODE_NORMAL))
            (i32.store offset=48
              (local.get $emission_address)
              (local.get $mode))
            (i32.store offset=92
              (local.get $emission_address)
              (i32.const 0))
            (i32.store offset=96
              (local.get $emission_address)
              (i32.const 0))
            (i32.store offset=116
              (local.get $emission_address)
              (i32.const 0))
            (i32.store offset=120
              (local.get $emission_address)
              (i32.const 0))
            (i32.store offset=124
              (local.get $emission_address)
              (i32.const 0))
            (i32.store offset=104
              (local.get $emission_address)
              (i32.const 0))
            (i32.store offset=108
              (local.get $emission_address)
              (i32.const 0))
            (if (i32.eq (local.get $scalar) (i32.const 63))
              (then
                (i32.store offset=16
                  (local.get $emission_address)
                  (local.get $next_cursor))
                (local.set $cursor (local.get $next_cursor))
                (call $work_add (i32.const 1))
                (br $next_literal)))))
        (if
          (i32.ne (local.get $mode) (global.get $EMIT_MODE_NORMAL))
          (then
            (if
              (i32.eq
                (local.get $mode)
                (global.get $EMIT_MODE_CLASS_ESCAPE))
              (then
                (local.set $builtin_range_count
                  (call $builtin_class_range_count
                    (local.get $scalar)
                    (i32.const 1)))
                (if (local.get $builtin_range_count)
                  (then
                    (if (i32.load offset=68 (local.get $emission_address))
                      (then
                        (return
                          (global.get $STATUS_SYNTAX_ERROR)
                          (local.get $fuel))))
                    (if (i32.load offset=60 (local.get $emission_address))
                      (then
                        (local.set $status
                          (call $append_emitted_range
                            (local.get $emission_address)
                            (i32.load offset=64
                              (local.get $emission_address))
                            (i32.load offset=64
                              (local.get $emission_address))))
                        (if
                          (i32.ne
                            (local.get $status)
                            (global.get $STATUS_OK))
                          (then
                            (return
                              (local.get $status)
                              (local.get $fuel))))
                        (i32.store offset=60
                          (local.get $emission_address)
                          (i32.const 0))
                        (i32.store offset=64
                          (local.get $emission_address)
                          (i32.const 0))))
                    (local.set $builtin_range_index (i32.const 0))
                    (block $builtins_done
                      (loop $append_builtin
                        (call $work_add (i32.const 1))
        (br_if $builtins_done
                          (i32.ge_u
                            (local.get $builtin_range_index)
                            (local.get $builtin_range_count)))
                        (local.set $builtin_range
                          (call $builtin_class_range
                            (local.get $scalar)
                            (i32.const 1)
                            (local.get $builtin_range_index)))
                        (if
                          (i64.eq
                            (local.get $builtin_range)
                            (i64.const -1))
                          (then
                            (return
                              (global.get $STATUS_CORRUPT_PROGRAM)
                              (local.get $fuel))))
                        (local.set $status
                          (call $append_emitted_range
                            (local.get $emission_address)
                            (i32.wrap_i64 (local.get $builtin_range))
                            (i32.wrap_i64
                              (i64.shr_u
                                (local.get $builtin_range)
                                (i64.const 32)))))
                        (if
                          (i32.ne
                            (local.get $status)
                            (global.get $STATUS_OK))
                          (then
                            (return
                              (local.get $status)
                              (local.get $fuel))))
                        (local.set $builtin_range_index
                          (i32.add
                            (local.get $builtin_range_index)
                            (i32.const 1)))
                        (br $append_builtin))))
                  (else
                    (local.set $status
                      (call $commit_class_literal
                        (local.get $emission_address)
                        (call $escape_value (local.get $scalar) (i32.const 1))))
                    (if
                      (i32.ne
                        (local.get $status)
                        (global.get $STATUS_OK))
                      (then
                        (return
                          (local.get $status)
                          (local.get $fuel))))))
                (local.set $mode (global.get $EMIT_MODE_CLASS))
                (i32.store offset=48
                  (local.get $emission_address)
                  (local.get $mode))
                (i32.store offset=52
                  (local.get $emission_address)
                  (i32.const 0))
                (i32.store offset=16
                  (local.get $emission_address)
                  (local.get $next_cursor))
                (local.set $cursor (local.get $next_cursor))
                (call $work_add (i32.const 1))
                (br $next_literal)))
            (if
              (i32.and
                (i32.load offset=52 (local.get $emission_address))
                (i32.eq (local.get $scalar) (i32.const 94)))
              (then
                (i32.store offset=52
                  (local.get $emission_address)
                  (i32.const 0))
                (i32.store offset=56
                  (local.get $emission_address)
                  (i32.const 1))
                (i32.store offset=16
                  (local.get $emission_address)
                  (local.get $next_cursor))
                (local.set $cursor (local.get $next_cursor))
                (call $work_add (i32.const 1))
                (br $next_literal)))
            (i32.store offset=52
              (local.get $emission_address)
              (i32.const 0))
            (if (i32.eq (local.get $scalar) (i32.const 92))
              (then
                (local.set $mode (global.get $EMIT_MODE_CLASS_ESCAPE))
                (i32.store offset=48
                  (local.get $emission_address)
                  (local.get $mode))
                (i32.store offset=16
                  (local.get $emission_address)
                  (local.get $next_cursor))
                (local.set $cursor (local.get $next_cursor))
                (call $work_add (i32.const 1))
                (br $next_literal)))
            (if (i32.eq (local.get $scalar) (i32.const 93))
              (then
                (if (i32.load offset=60 (local.get $emission_address))
                  (then
                    (local.set $status
                      (call $append_emitted_range
                        (local.get $emission_address)
                        (i32.load offset=64 (local.get $emission_address))
                        (i32.load offset=64 (local.get $emission_address))))
                    (if (i32.ne (local.get $status) (global.get $STATUS_OK))
                      (then
                        (return
                          (local.get $status)
                          (local.get $fuel))))))
                (if (i32.load offset=68 (local.get $emission_address))
                  (then
                    (local.set $status
                      (call $append_emitted_range
                        (local.get $emission_address)
                        (i32.const 45)
                        (i32.const 45)))
                    (if (i32.ne (local.get $status) (global.get $STATUS_OK))
                      (then
                        (return
                          (local.get $status)
                          (local.get $fuel))))))
                (local.set $class_range_count
                  (i32.load offset=76 (local.get $emission_address)))
                (local.set $class_negated
                  (i32.load offset=56 (local.get $emission_address)))
                (local.set $range_index
                  (i32.load offset=72 (local.get $emission_address)))
                (local.set $opcode
                  (if (result i32) (local.get $class_negated)
                    (then (global.get $OPCODE_NEGATED_CHARACTER_CLASS))
                    (else (global.get $OPCODE_CHARACTER_CLASS))))
                (local.set $mode (global.get $EMIT_MODE_NORMAL))
                (i32.store offset=48
                  (local.get $emission_address)
                  (local.get $mode))
                (i32.store offset=56
                  (local.get $emission_address)
                  (i32.const 0))
                (i32.store offset=60
                  (local.get $emission_address)
                  (i32.const 0))
                (i32.store offset=64
                  (local.get $emission_address)
                  (i32.const 0))
                (i32.store offset=68
                  (local.get $emission_address)
                  (i32.const 0))
                (i32.store offset=72
                  (local.get $emission_address)
                  (i32.const 0))
                (i32.store offset=76
                  (local.get $emission_address)
                  (i32.const 0))
                (br $opcode_ready))
              (else
                (if
                  (i32.and
                    (i32.eq (local.get $scalar) (i32.const 45))
                    (i32.and
                      (i32.load offset=60 (local.get $emission_address))
                      (i32.eqz
                        (i32.load offset=68
                          (local.get $emission_address)))))
                  (then
                    (i32.store offset=68
                      (local.get $emission_address)
                      (i32.const 1)))
                  (else
                    (local.set $status
                      (call $commit_class_literal
                        (local.get $emission_address)
                        (local.get $scalar)))
                    (if (i32.ne (local.get $status) (global.get $STATUS_OK))
                      (then
                        (return
                          (local.get $status)
                          (local.get $fuel))))))
                (i32.store offset=16
                  (local.get $emission_address)
                  (local.get $next_cursor))
                (local.set $cursor (local.get $next_cursor))
                (call $work_add (i32.const 1))
                (br $next_literal)))))
        (if
          (i32.and
            (i32.eq (local.get $scalar) (i32.const 123))
            (i32.and
              ;; An atom exists when either last-atom field is set: an empty
              ;; group leaves a start with a zero count and still accepts a
              ;; bounded quantifier, exactly as the scan pass measured.
              (i32.ne
                (i32.or
                  (i32.load offset=92 (local.get $emission_address))
                  (i32.load offset=96 (local.get $emission_address)))
                (i32.const 0))
              (i32.and
                (i32.lt_u
                  (local.get $next_cursor)
                  (local.get $pattern_end))
                (i32.and
                  (i32.ge_u
                    (call $work_byte (local.get $next_cursor))
                    (i32.const 48))
                  (i32.le_u
                    (call $work_byte (local.get $next_cursor))
                    (i32.const 57))))))
          (then
            (local.set $mode (global.get $EMIT_MODE_BRACE_START))
            (i32.store offset=48
              (local.get $emission_address)
              (local.get $mode))
            (i32.store offset=104
              (local.get $emission_address)
              (i32.const 0))
            (i32.store offset=108
              (local.get $emission_address)
              (i32.const 0))
            (i32.store offset=112
              (local.get $emission_address)
              (i32.const 0))
            (i32.store offset=16
              (local.get $emission_address)
              (local.get $next_cursor))
            (local.set $cursor (local.get $next_cursor))
            (call $work_add (i32.const 1))
            (br $next_literal)))
        (if
          (i32.or
            (i32.eq (local.get $scalar) (i32.const 42))
            (i32.or
              (i32.eq (local.get $scalar) (i32.const 43))
              (i32.eq (local.get $scalar) (i32.const 63))))
          (then
            (local.set $atom_start
              (i32.load offset=92 (local.get $emission_address)))
            (local.set $atom_instruction_count
              (i32.load offset=96 (local.get $emission_address)))
            (if (i32.eqz (local.get $atom_instruction_count))
              (then
                ;; A quantifier needs an atom. A present-but-empty atom (an
                ;; empty group) expands to nothing, matching its measured
                ;; size of zero; a missing atom is a syntax error.
                (if (i32.eqz (local.get $atom_start))
                  (then
                    (return
                      (global.get $STATUS_SYNTAX_ERROR)
                      (local.get $fuel))))
                (local.set $mode (global.get $EMIT_MODE_AFTER_QUANTIFIER))
                (i32.store offset=48
                  (local.get $emission_address)
                  (local.get $mode))
                (i32.store offset=92 (local.get $emission_address) (i32.const 0))
                (i32.store offset=96 (local.get $emission_address) (i32.const 0))
                (i32.store offset=116
                  (local.get $emission_address)
                  (i32.const 0))
                (i32.store offset=120
                  (local.get $emission_address)
                  (i32.const 0))
                (i32.store offset=124
                  (local.get $emission_address)
                  (i32.const 0))
                (i32.store offset=100
                  (local.get $emission_address)
                  (i32.const 0))
                (i32.store offset=16
                  (local.get $emission_address)
                  (local.get $next_cursor))
                (local.set $cursor (local.get $next_cursor))
                (call $work_add (i32.const 1))
                (br $next_literal)))
            (local.set $group_entry
              (i32.load offset=124 (local.get $emission_address)))
            (if
              (i32.ge_u
                (i32.sub (local.get $group_entry) (local.get $atom_start))
                (local.get $atom_instruction_count))
              (then
                (return
                  (global.get $STATUS_CORRUPT_PROGRAM)
                  (local.get $fuel))))
            (if (i32.eq (local.get $scalar) (i32.const 63))
              (then
                ;; An optional atom carries an empty-iteration guard: a SAVE
                ;; records where the body began and a GUARD kills iterations
                ;; that consumed nothing, matching JavaScript's rule that an
                ;; optional iteration matching empty is discarded.
                (if
                  (i32.ge_u
                    (i32.add (local.get $instruction_index) (i32.const 4))
                    (local.get $instruction_count))
                  (then
                    (return
                      (global.get $STATUS_CORRUPT_PROGRAM)
                      (local.get $fuel))))
                (if
                  (i32.ge_u
                    (i32.load offset=128 (local.get $emission_address))
                    (i32.load offset=32 (local.get $program_address)))
                  (then
                    (return
                      (global.get $STATUS_CORRUPT_PROGRAM)
                      (local.get $fuel))))
                (local.set $capture_group_count
                  (i32.add
                    (i32.mul
                      (i32.add
                        (i32.load offset=20 (local.get $program_address))
                        (i32.const 1))
                      (i32.const 2))
                    (i32.load offset=128 (local.get $emission_address))))
                (i32.store offset=128
                  (local.get $emission_address)
                  (i32.add
                    (i32.load offset=128 (local.get $emission_address))
                    (i32.const 1)))
                (local.set $instruction_address
                  (i32.add
                    (i32.add
                      (local.get $program_address)
                      (global.get $PROGRAM_HEADER_SIZE))
                    (i32.mul
                      (local.get $instruction_index)
                      (global.get $INSTRUCTION_SIZE))))
                (i32.store
                  (local.get $instruction_address)
                  (global.get $OPCODE_SAVE))
                (i32.store offset=4
                  (local.get $instruction_address)
                  (local.get $capture_group_count))
                (i32.store offset=8
                  (local.get $instruction_address)
                  (local.get $group_entry))
                (i32.store offset=12
                  (local.get $instruction_address)
                  (i32.const 0))
                (local.set $instruction_address
                  (i32.add
                    (local.get $instruction_address)
                    (global.get $INSTRUCTION_SIZE)))
                (i32.store
                  (local.get $instruction_address)
                  (global.get $OPCODE_SPLIT))
                (i32.store offset=4
                  (local.get $instruction_address)
                  (local.get $instruction_index))
                (i32.store offset=8
                  (local.get $instruction_address)
                  (i32.add (local.get $instruction_index) (i32.const 3)))
                (i32.store offset=12
                  (local.get $instruction_address)
                  (i32.const 0))
                (local.set $instruction_address
                  (i32.add
                    (local.get $instruction_address)
                    (global.get $INSTRUCTION_SIZE)))
                (i32.store
                  (local.get $instruction_address)
                  (global.get $OPCODE_GUARD))
                (i32.store offset=4
                  (local.get $instruction_address)
                  (local.get $capture_group_count))
                (i32.store offset=8
                  (local.get $instruction_address)
                  (i32.add (local.get $instruction_index) (i32.const 3)))
                (i32.store offset=12
                  (local.get $instruction_address)
                  (i32.const 0))
                (local.set $status
                  (call $redirect_emitted_targets
                    (local.get $program_address)
                    (i32.const 0)
                    (local.get $atom_start)
                    (local.get $group_entry)
                    (i32.add (local.get $instruction_index) (i32.const 1))))
                (if (i32.ne (local.get $status) (global.get $STATUS_OK))
                  (then
                    (return
                      (local.get $status)
                      (local.get $fuel))))
                (local.set $status
                  (call $redirect_emitted_targets
                    (local.get $program_address)
                    (local.get $atom_start)
                    (local.get $instruction_index)
                    (local.get $instruction_index)
                    (i32.add (local.get $instruction_index) (i32.const 2))))
                (if (i32.ne (local.get $status) (global.get $STATUS_OK))
                  (then
                    (return
                      (local.get $status)
                      (local.get $fuel))))
                (local.set $mode (global.get $EMIT_MODE_AFTER_QUANTIFIER))
                (i32.store offset=48
                  (local.get $emission_address)
                  (local.get $mode))
                (i32.store offset=100
                  (local.get $emission_address)
                  (i32.add (local.get $instruction_index) (i32.const 1)))
                (i32.store offset=92 (local.get $emission_address) (i32.const 0))
                (i32.store offset=96 (local.get $emission_address) (i32.const 0))
                (i32.store offset=116
                  (local.get $emission_address)
                  (i32.const 0))
                (i32.store offset=120
                  (local.get $emission_address)
                  (i32.const 0))
                (i32.store offset=124
                  (local.get $emission_address)
                  (i32.const 0))
                (local.set $instruction_index
                  (i32.add (local.get $instruction_index) (i32.const 3)))
                (i32.store offset=28
                  (local.get $emission_address)
                  (local.get $instruction_index))
                (i32.store offset=16
                  (local.get $emission_address)
                  (local.get $next_cursor))
                (local.set $cursor (local.get $next_cursor))
                (call $work_add (i32.const 1))
                (br $next_literal)))
            ;; `?` runs its body at most once, so only `*` and `+` need the
            ;; per-iteration CLEAR for contained capture groups.
            (local.set $atom_capture_first
              (i32.load offset=116 (local.get $emission_address)))
            (local.set $atom_capture_count
              (i32.load offset=120 (local.get $emission_address)))
            (if (local.get $atom_capture_count)
              (then
                (if
                  (i32.or
                    (i32.eqz (local.get $atom_capture_first))
                    (i32.gt_u
                      (i32.add
                        (local.get $atom_capture_first)
                        (i32.sub
                          (local.get $atom_capture_count)
                          (i32.const 1)))
                      (i32.load offset=80 (local.get $emission_address))))
                  (then
                    (return
                      (global.get $STATUS_CORRUPT_PROGRAM)
                      (local.get $fuel))))))
            (if
              (i32.ge_u
                (i32.add
                  (local.get $instruction_index)
                  (i32.add
                    (i32.const 2)
                    (i32.ne (local.get $atom_capture_count) (i32.const 0))))
                (local.get $instruction_count))
              (then
                (return
                  (global.get $STATUS_CORRUPT_PROGRAM)
                  (local.get $fuel))))
            ;; With contained captures the CLEAR precedes the split, so the
            ;; expansion always ends on its flow tail; the instruction that
            ;; follows any fragment must always continue past it.
            (local.set $quantifier_count
              (i32.add
                (local.get $instruction_index)
                (i32.ne (local.get $atom_capture_count) (i32.const 0))))
            (if (local.get $atom_capture_count)
              (then
                (call $emit_clear_captures
                  (local.get $program_address)
                  (local.get $instruction_index)
                  (local.get $atom_capture_first)
                  (local.get $atom_capture_count)
                  (local.get $group_entry))))
            (local.set $instruction_address
              (i32.add
                (i32.add
                  (local.get $program_address)
                  (global.get $PROGRAM_HEADER_SIZE))
                (i32.mul
                  (local.get $quantifier_count)
                  (global.get $INSTRUCTION_SIZE))))
            (i32.store
              (local.get $instruction_address)
              (global.get $OPCODE_SPLIT))
            (i32.store offset=4
              (local.get $instruction_address)
              (if (result i32) (local.get $atom_capture_count)
                (then (local.get $instruction_index))
                (else (local.get $group_entry))))
            (i32.store offset=8
              (local.get $instruction_address)
              (i32.add (local.get $quantifier_count) (i32.const 1)))
            (i32.store offset=12
              (local.get $instruction_address)
              (i32.const 0))
            (if
              (i32.ne (local.get $scalar) (i32.const 43))
              (then
                (local.set $status
                  (call $redirect_emitted_targets
                    (local.get $program_address)
                    (i32.const 0)
                    (local.get $atom_start)
                    (local.get $group_entry)
                    (local.get $quantifier_count)))
                (if (i32.ne (local.get $status) (global.get $STATUS_OK))
                  (then
                    (return
                      (local.get $status)
                      (local.get $fuel))))))
            (local.set $status
              (call $redirect_emitted_targets
                (local.get $program_address)
                (local.get $atom_start)
                (local.get $instruction_index)
                (local.get $instruction_index)
                (local.get $quantifier_count)))
            (if (i32.ne (local.get $status) (global.get $STATUS_OK))
              (then
                (return
                  (local.get $status)
                  (local.get $fuel))))
            (local.set $mode (global.get $EMIT_MODE_AFTER_QUANTIFIER))
            (i32.store offset=48
              (local.get $emission_address)
              (local.get $mode))
            (i32.store offset=92
              (local.get $emission_address)
              (i32.const 0))
            (i32.store offset=96
              (local.get $emission_address)
              (i32.const 0))
            (i32.store offset=116
              (local.get $emission_address)
              (i32.const 0))
            (i32.store offset=120
              (local.get $emission_address)
              (i32.const 0))
            (i32.store offset=124
              (local.get $emission_address)
              (i32.const 0))
            (i32.store offset=100
              (local.get $emission_address)
              (local.get $quantifier_count))
            (local.set $instruction_index
              (i32.add
                (local.get $instruction_index)
                (i32.add
                  (i32.const 1)
                  (i32.ne (local.get $atom_capture_count) (i32.const 0)))))
            (i32.store offset=28
              (local.get $emission_address)
              (local.get $instruction_index))
            (i32.store offset=16
              (local.get $emission_address)
              (local.get $next_cursor))
            (local.set $cursor (local.get $next_cursor))
            (call $work_add (i32.const 1))
            (br $next_literal)))
        (if (i32.eq (local.get $scalar) (i32.const 124))
          (then
            (local.set $group_depth
              (i32.load offset=40 (local.get $emission_address)))
            (local.set $stack_address
              (i32.add
                (i32.add
                  (local.get $emission_address)
                  (global.get $EMIT_HEADER_SIZE))
                (i32.mul
                  (local.get $group_depth)
                  (global.get $EMIT_STACK_ENTRY_SIZE))))
            (local.set $branch_start
              (i32.load offset=8 (local.get $stack_address)))
            (local.set $latest_split
              (i32.load offset=12 (local.get $stack_address)))
            ;; The split's third operand temporarily records the branch's
            ;; region start. Finalization retargets every branch edge that
            ;; exits past the split — a quantified atom can leave several
            ;; such edges. An empty branch records the split's own index
            ;; and finalization points the first operand at the join.
            (if
              (i32.or
                (i32.gt_u
                  (local.get $branch_start)
                  (local.get $instruction_index))
                (i32.ge_u
                  (i32.add (local.get $instruction_index) (i32.const 2))
                  (local.get $instruction_count)))
              (then
                (return
                  (global.get $STATUS_CORRUPT_PROGRAM)
                  (local.get $fuel))))
            ;; The ended branch's entry edge lives on the instruction that
            ;; precedes it: the group's predecessor for the first branch,
            ;; and the prior split's forward operand afterwards. A branch
            ;; beginning with a quantified atom enters at that expansion's
            ;; split, not at its lowest instruction index.
            (local.set $group_entry
              (call $emitted_successor
                (local.get $program_address)
                (if (result i32)
                  (i32.eq (local.get $latest_split) (i32.const -1))
                  (then (i32.load offset=4 (local.get $stack_address)))
                  (else (local.get $latest_split)))))
            (if
              (i32.or
                (i32.lt_u (local.get $group_entry) (local.get $branch_start))
                (i32.gt_u
                  (local.get $group_entry)
                  (local.get $instruction_index)))
              (then
                (return
                  (global.get $STATUS_CORRUPT_PROGRAM)
                  (local.get $fuel))))
            (local.set $instruction_address
              (i32.add
                (i32.add
                  (local.get $program_address)
                  (global.get $PROGRAM_HEADER_SIZE))
                (i32.mul
                  (local.get $instruction_index)
                  (global.get $INSTRUCTION_SIZE))))
            (i32.store
              (local.get $instruction_address)
              (global.get $OPCODE_SPLIT))
            (i32.store offset=4
              (local.get $instruction_address)
              (local.get $group_entry))
            (i32.store offset=8
              (local.get $instruction_address)
              (i32.add (local.get $instruction_index) (i32.const 1)))
            (i32.store offset=12
              (local.get $instruction_address)
              (local.get $branch_start))
            (if (i32.eq (local.get $latest_split) (i32.const -1))
              (then
                ;; Every edge entering the first branch's region belongs to
                ;; the group's entry: a multi-exit fragment before the
                ;; group can leave several such edges, not just its
                ;; predecessor's continuation.
                (local.set $status
                  (call $redirect_emitted_targets
                    (local.get $program_address)
                    (i32.const 0)
                    (local.get $branch_start)
                    (local.get $group_entry)
                    (local.get $instruction_index))))
              (else
                (i32.store offset=8
                  (i32.add
                    (i32.add
                      (local.get $program_address)
                      (global.get $PROGRAM_HEADER_SIZE))
                    (i32.mul
                      (local.get $latest_split)
                      (global.get $INSTRUCTION_SIZE)))
                  (local.get $instruction_index))
                (local.set $status (global.get $STATUS_OK))))
            (if (i32.ne (local.get $status) (global.get $STATUS_OK))
              (then
                (return
                  (local.get $status)
                  (local.get $fuel))))
            (i32.store offset=8
              (local.get $stack_address)
              (i32.add (local.get $instruction_index) (i32.const 1)))
            (i32.store offset=12
              (local.get $stack_address)
              (local.get $instruction_index))
            (i32.store offset=92
              (local.get $emission_address)
              (i32.const 0))
            (i32.store offset=96
              (local.get $emission_address)
              (i32.const 0))
            (i32.store offset=116
              (local.get $emission_address)
              (i32.const 0))
            (i32.store offset=120
              (local.get $emission_address)
              (i32.const 0))
            (i32.store offset=124
              (local.get $emission_address)
              (i32.const 0))
            (local.set $instruction_index
              (i32.add (local.get $instruction_index) (i32.const 1)))
            (i32.store offset=28
              (local.get $emission_address)
              (local.get $instruction_index))
            (i32.store offset=16
              (local.get $emission_address)
              (local.get $next_cursor))
            (local.set $cursor (local.get $next_cursor))
            (call $work_add (i32.const 1))
            (br $next_literal)))
        (if (i32.eq (local.get $scalar) (i32.const 40))
          (then
            (local.set $mode (global.get $EMIT_MODE_AFTER_GROUP_OPEN))
            (i32.store offset=48
              (local.get $emission_address)
              (local.get $mode))
            (i32.store offset=92
              (local.get $emission_address)
              (i32.const 0))
            (i32.store offset=96
              (local.get $emission_address)
              (i32.const 0))
            (i32.store offset=116
              (local.get $emission_address)
              (i32.const 0))
            (i32.store offset=120
              (local.get $emission_address)
              (i32.const 0))
            (i32.store offset=124
              (local.get $emission_address)
              (i32.const 0))
            (i32.store offset=16
              (local.get $emission_address)
              (local.get $next_cursor))
            (local.set $cursor (local.get $next_cursor))
            (call $work_add (i32.const 1))
            (br $next_literal)))
        (if (i32.eq (local.get $scalar) (i32.const 41))
          (then
            (local.set $group_depth
              (i32.load offset=40 (local.get $emission_address)))
            (if (i32.eqz (local.get $group_depth))
              (then
                (return
                  (global.get $STATUS_CORRUPT_PROGRAM)
                  (local.get $fuel))))
            (local.set $stack_address
              (i32.add
                (i32.add
                  (local.get $emission_address)
                  (global.get $EMIT_HEADER_SIZE))
                (i32.mul
                  (local.get $group_depth)
                  (global.get $EMIT_STACK_ENTRY_SIZE))))
            (local.set $capture_slot
              (i32.load (local.get $stack_address)))
            (local.set $branch_start
              (i32.load offset=16 (local.get $stack_address)))
            (if
              (i32.or
                (i32.ge_u
                  (i32.load offset=4 (local.get $stack_address))
                  (local.get $instruction_index))
                (i32.or
                  (i32.gt_u
                    (i32.load offset=8 (local.get $stack_address))
                    (local.get $instruction_index))
                  (i32.or
                    (i32.and
                      (i32.ne
                        (i32.load offset=12 (local.get $stack_address))
                        (i32.const -1))
                      (i32.ge_u
                        (i32.load offset=12 (local.get $stack_address))
                        (local.get $instruction_index)))
                    (i32.or
                      (i32.gt_u
                        (local.get $branch_start)
                        (local.get $instruction_index))
                    (i32.and
                      (local.get $capture_slot)
                      (i32.or
                        (i32.lt_u
                          (local.get $capture_slot)
                          (i32.const 2))
                        (i32.or
                          (i32.and
                            (local.get $capture_slot)
                            (i32.const 1))
                          (i32.gt_u
                            (local.get $capture_slot)
                            (i32.mul
                              (i32.load offset=80
                                (local.get $emission_address))
                              (i32.const 2)))))))))
                    )
              (then
                (return
                  (global.get $STATUS_CORRUPT_PROGRAM)
                  (local.get $fuel))))
            (if
              (i32.ne
                (i32.load offset=12 (local.get $stack_address))
                (i32.const -1))
              (then
                (local.set $status
                  (call $finalize_emitted_alternation
                    (local.get $program_address)
                    (local.get $stack_address)
                    (local.get $instruction_index)))
                (if (i32.ne (local.get $status) (global.get $STATUS_OK))
                  (then
                    (return
                      (local.get $status)
                      (local.get $fuel))))))
            (if (local.get $capture_slot)
              (then
                (local.set $status
                  (call $emit_capture_save
                    (local.get $emission_address)
                    (i32.add (local.get $capture_slot) (i32.const 1))))
                (if (i32.ne (local.get $status) (global.get $STATUS_OK))
                  (then
                    (return
                      (local.get $status)
                      (local.get $fuel))))))
            ;; The atom's real entry: a capturing group enters at its open
            ;; SAVE; a noncapturing group enters wherever its predecessor's
            ;; continuation edge points, which alternation and quantifier
            ;; emission may have retargeted inside the body.
            (local.set $group_entry (local.get $branch_start))
            (if (i32.eqz (local.get $capture_slot))
              (then
                (local.set $group_entry
                  (call $emitted_successor
                    (local.get $program_address)
                    (i32.load offset=4 (local.get $stack_address))))
                (if (i32.eq (local.get $group_entry) (i32.const -1))
                  (then
                    (return
                      (global.get $STATUS_CORRUPT_PROGRAM)
                      (local.get $fuel))))))
            ;; The atom's contained groups sit above the recorded capture
            ;; checkpoint, including this group's own number when capturing.
            (local.set $capture_group_count
              (i32.load offset=20 (local.get $stack_address)))
            (if
              (i32.lt_u
                (i32.load offset=80 (local.get $emission_address))
                (local.get $capture_group_count))
              (then
                (return
                  (global.get $STATUS_CORRUPT_PROGRAM)
                  (local.get $fuel))))
            (i64.store
              (local.get $stack_address)
              (i64.const 0))
            (i64.store offset=8
              (local.get $stack_address)
              (i64.const 0))
            (i64.store offset=16
              (local.get $stack_address)
              (i64.const 0))
            (i32.store offset=40
              (local.get $emission_address)
              (i32.sub (local.get $group_depth) (i32.const 1)))
            (local.set $instruction_index
              (i32.load offset=28 (local.get $emission_address)))
            (i32.store offset=92
              (local.get $emission_address)
              (local.get $branch_start))
            (i32.store offset=96
              (local.get $emission_address)
              (i32.sub
                (local.get $instruction_index)
                (local.get $branch_start)))
            (i32.store offset=116
              (local.get $emission_address)
              (i32.add (local.get $capture_group_count) (i32.const 1)))
            (i32.store offset=120
              (local.get $emission_address)
              (i32.sub
                (i32.load offset=80 (local.get $emission_address))
                (local.get $capture_group_count)))
            (i32.store offset=124
              (local.get $emission_address)
              (local.get $group_entry))
            (i32.store offset=16
              (local.get $emission_address)
              (local.get $next_cursor))
            (local.set $cursor (local.get $next_cursor))
            (call $work_add (i32.const 1))
            (br $next_literal)))
        (if (i32.eq (local.get $scalar) (i32.const 91))
          (then
            (local.set $mode (global.get $EMIT_MODE_CLASS))
            (i32.store offset=48
              (local.get $emission_address)
              (local.get $mode))
            (i32.store offset=52
              (local.get $emission_address)
              (i32.const 1))
            (i32.store offset=72
              (local.get $emission_address)
              (local.get $range_index))
            (i32.store offset=16
              (local.get $emission_address)
              (local.get $next_cursor))
            (local.set $cursor (local.get $next_cursor))
            (call $work_add (i32.const 1))
            (br $next_literal)))
        (local.set $opcode (global.get $OPCODE_CHARACTER))
        (if (i32.eq (local.get $scalar) (i32.const 46))
          (then
            (local.set $opcode (global.get $OPCODE_ANY)))
          (else
            (if (i32.eq (local.get $scalar) (i32.const 94))
              (then
                (local.set $opcode (global.get $OPCODE_ASSERT_START)))
              (else
                (if (i32.eq (local.get $scalar) (i32.const 36))
                  (then
                    (local.set $opcode (global.get $OPCODE_ASSERT_END)))
                  (else
                    (if (i32.eq (local.get $scalar) (i32.const 92))
                      (then
                        (local.set $decoded
                          (call $decode_scalar
                            (local.get $next_cursor)
                            (local.get $pattern_end)))
                        (if (i64.eq (local.get $decoded) (i64.const -1))
                          (then
                            (return
                              (global.get $STATUS_INVALID_UTF8)
                              (local.get $fuel))))
                        (local.set $scalar
                          (i32.wrap_i64 (local.get $decoded)))
                        (local.set $next_cursor
                          (i32.wrap_i64
                            (i64.shr_u
                              (local.get $decoded)
                              (i64.const 32))))
                        (if (i32.lt_s (call $escape_value (local.get $scalar) (i32.const 0)) (i32.const 0))
                          (then
                            (return
                              (global.get $STATUS_UNSUPPORTED)
                              (local.get $fuel))))
                        (local.set $scalar (call $escape_value (local.get $scalar) (i32.const 0)))
                        (if
                          (i32.or
                            (i32.eq (local.get $scalar) (i32.const 68))
                            (i32.or
                              (i32.eq (local.get $scalar) (i32.const 83))
                              (i32.or
                                (i32.eq (local.get $scalar) (i32.const 87))
                                (i32.or
                                  (i32.eq (local.get $scalar) (i32.const 100))
                                  (i32.or
                                    (i32.eq
                                      (local.get $scalar)
                                      (i32.const 115))
                                    (i32.eq
                                      (local.get $scalar)
                                      (i32.const 119)))))))
                          (then
                            (local.set $range_address
                              (i32.add
                                (i32.add
                                  (i32.add
                                    (local.get $program_address)
                                    (global.get $PROGRAM_HEADER_SIZE))
                                  (i32.mul
                                    (local.get $instruction_count)
                                    (global.get $INSTRUCTION_SIZE)))
                                (i32.mul
                                  (local.get $range_index)
                                  (i32.const 8))))
                            (local.set $status
                              (call $compile_builtin_class
                                (local.get $scalar)
                                (local.get $range_address)
                                (i32.mul
                                  (i32.sub
                                    (local.get $range_count)
                                    (local.get $range_index))
                                  (i32.const 8))
                                (i32.add
                                  (local.get $emission_address)
                                  (i32.const 72))
                                (i32.const 8)))
                            (if
                              (i32.ne
                                (local.get $status)
                                (global.get $STATUS_OK))
                              (then
                                (return
                                  (local.get $status)
                                  (local.get $fuel))))
                            (local.set $class_range_count
                              (i32.load offset=72
                                (local.get $emission_address)))
                            (local.set $class_negated
                              (i32.load offset=76
                                (local.get $emission_address)))
                            (i64.store offset=72
                              (local.get $emission_address)
                              (i64.const 0))
                            (if
                              (i32.gt_u
                                (local.get $class_range_count)
                                (i32.sub
                                  (local.get $range_count)
                                  (local.get $range_index)))
                              (then
                                (return
                                  (global.get $STATUS_CORRUPT_PROGRAM)
                                  (local.get $fuel))))
                            (local.set $opcode
                              (if (result i32) (local.get $class_negated)
                                (then
                                  (global.get
                                    $OPCODE_NEGATED_CHARACTER_CLASS))
                                (else
                                  (global.get $OPCODE_CHARACTER_CLASS)))))))
                      (else
                        (if
                          (i32.or
                            (i32.and
                              (i32.ge_u
                                (local.get $scalar)
                                (i32.const 40))
                              (i32.le_u
                                (local.get $scalar)
                                (i32.const 43)))
                            (i32.or
                              (i32.eq
                                (local.get $scalar)
                                (i32.const 63))
                              (i32.and
                                (i32.ge_u
                                  (local.get $scalar)
                                  (i32.const 91))
                                (i32.le_u
                                  (local.get $scalar)
                                  (i32.const 93)))))
                          (then
                            (return
                              (global.get $STATUS_UNSUPPORTED)
                              (local.get $fuel)))))))))))))
        (if
          (i32.ge_u
            (local.get $instruction_index)
            (local.get $instruction_count))
          (then
            (return
              (global.get $STATUS_CORRUPT_PROGRAM)
              (local.get $fuel))))
        (local.set $instruction_address
          (i32.add
            (i32.add
              (local.get $program_address)
              (global.get $PROGRAM_HEADER_SIZE))
            (i32.mul
              (local.get $instruction_index)
              (global.get $INSTRUCTION_SIZE))))
        (i32.store
          (local.get $instruction_address)
          (local.get $opcode))
        (if (i32.eq (local.get $opcode) (global.get $OPCODE_CHARACTER))
          (then
            (i32.store offset=4
              (local.get $instruction_address)
              (local.get $scalar))
            (i32.store offset=8
              (local.get $instruction_address)
              (i32.add (local.get $instruction_index) (i32.const 1)))
            (i32.store offset=12
              (local.get $instruction_address)
              (i32.const 0)))
          (else
            (if
              (i32.or
                (i32.eq
                  (local.get $opcode)
                  (global.get $OPCODE_CHARACTER_CLASS))
                (i32.eq
                  (local.get $opcode)
                  (global.get $OPCODE_NEGATED_CHARACTER_CLASS)))
              (then
                (i32.store offset=4
                  (local.get $instruction_address)
                  (local.get $range_index))
                (i32.store offset=8
                  (local.get $instruction_address)
                  (local.get $class_range_count))
                (i32.store offset=12
                  (local.get $instruction_address)
                  (i32.add
                    (local.get $instruction_index)
                    (i32.const 1))))
              (else
                (i32.store offset=4
                  (local.get $instruction_address)
                  (i32.add
                    (local.get $instruction_index)
                    (i32.const 1)))
                (i32.store offset=8
                  (local.get $instruction_address)
                  (i32.const 0))
                (i32.store offset=12
                  (local.get $instruction_address)
                  (i32.const 0))))))
        (local.set $cursor (local.get $next_cursor))
        (local.set $instruction_index
          (i32.add (local.get $instruction_index) (i32.const 1)))
        (if
          (i32.or
            (i32.eq (local.get $opcode) (global.get $OPCODE_ASSERT_START))
            (i32.eq (local.get $opcode) (global.get $OPCODE_ASSERT_END)))
          (then
            (i32.store offset=92
              (local.get $emission_address)
              (i32.const 0))
            (i32.store offset=96
              (local.get $emission_address)
              (i32.const 0)))
          (else
            (i32.store offset=92
              (local.get $emission_address)
              (i32.sub (local.get $instruction_index) (i32.const 1)))
            (i32.store offset=96
              (local.get $emission_address)
              (i32.const 1))))
        (i32.store offset=116
          (local.get $emission_address)
          (i32.const 0))
        (i32.store offset=120
          (local.get $emission_address)
          (i32.const 0))
        (i32.store offset=124
          (local.get $emission_address)
          (if (result i32)
            (i32.or
              (i32.eq (local.get $opcode) (global.get $OPCODE_ASSERT_START))
              (i32.eq (local.get $opcode) (global.get $OPCODE_ASSERT_END)))
            (then (i32.const 0))
            (else (i32.sub (local.get $instruction_index) (i32.const 1)))))
        (if
          (i32.or
            (i32.eq
              (local.get $opcode)
              (global.get $OPCODE_CHARACTER_CLASS))
            (i32.eq
              (local.get $opcode)
              (global.get $OPCODE_NEGATED_CHARACTER_CLASS)))
          (then
            (local.set $range_index
              (i32.add
                (local.get $range_index)
                (local.get $class_range_count)))
            (i32.store offset=32
              (local.get $emission_address)
              (local.get $range_index))))
        (i32.store offset=16
          (local.get $emission_address)
          (local.get $cursor))
        (i32.store offset=28
          (local.get $emission_address)
          (local.get $instruction_index))
        (call $work_add (i32.const 1))
        (br $next_literal)))
    (if
      (i32.or
        (i32.ne (local.get $mode) (global.get $EMIT_MODE_NORMAL))
        (i32.load offset=40 (local.get $emission_address)))
      (then
        (return
          (global.get $STATUS_CORRUPT_PROGRAM)
          (local.get $fuel))))
    (if (i32.eqz (local.get $complete))
      (then
        (local.set $fuel (call $work_take (local.get $fuel)))
        (if (i32.le_s (local.get $fuel) (i32.const 0))
          (then
            (return
              (global.get $STATUS_PAUSED)
              (local.get $fuel))))
        (if
          (i32.or
            (i32.ne
              (i32.add (local.get $instruction_index) (i32.const 2))
              (local.get $instruction_count))
            (i32.ne (local.get $range_index) (local.get $range_count)))
          (then
            (return
              (global.get $STATUS_CORRUPT_PROGRAM)
              (local.get $fuel))))
        (local.set $stack_address
          (i32.add
            (local.get $emission_address)
            (global.get $EMIT_HEADER_SIZE)))
        (if
          (i32.ne
            (i32.load offset=12 (local.get $stack_address))
            (i32.const -1))
          (then
            (local.set $status
              (call $finalize_emitted_alternation
                (local.get $program_address)
                (local.get $stack_address)
                (local.get $instruction_index)))
            (if (i32.ne (local.get $status) (global.get $STATUS_OK))
              (then
                (return
                  (local.get $status)
                  (local.get $fuel))))))
        (local.set $instruction_address
          (i32.add
            (i32.add
              (local.get $program_address)
              (global.get $PROGRAM_HEADER_SIZE))
            (i32.mul
              (local.get $instruction_index)
              (global.get $INSTRUCTION_SIZE))))
        (i32.store
          (local.get $instruction_address)
          (global.get $OPCODE_SAVE))
        (i32.store offset=4
          (local.get $instruction_address)
          (i32.const 1))
        (i32.store offset=8
          (local.get $instruction_address)
          (i32.add (local.get $instruction_index) (i32.const 1)))
        (i32.store offset=12
          (local.get $instruction_address)
          (i32.const 0))
        (local.set $instruction_index
          (i32.add (local.get $instruction_index) (i32.const 1)))
        (local.set $complete (i32.const 1))
        (i32.store offset=28
          (local.get $emission_address)
          (local.get $instruction_index))
        (i32.store offset=44
          (local.get $emission_address)
          (local.get $complete))
        (call $work_add (i32.const 1))))
    (if (i32.eq (local.get $complete) (i32.const 1))
      (then
        (local.set $fuel (call $work_take (local.get $fuel)))
        (if (i32.le_s (local.get $fuel) (i32.const 0))
          (then
            (return
              (global.get $STATUS_PAUSED)
              (local.get $fuel))))
        (local.set $instruction_address
          (i32.add
            (i32.add
              (local.get $program_address)
              (global.get $PROGRAM_HEADER_SIZE))
            (i32.mul
              (local.get $instruction_index)
              (global.get $INSTRUCTION_SIZE))))
        (i32.store
          (local.get $instruction_address)
          (global.get $OPCODE_MATCH))
        (i32.store offset=4
          (local.get $instruction_address)
          (i32.const 0))
        (i32.store offset=8
          (local.get $instruction_address)
          (i32.const 0))
        (i32.store offset=12
          (local.get $instruction_address)
          (i32.const 0))
        (local.set $instruction_index
          (i32.add (local.get $instruction_index) (i32.const 1)))
        (local.set $complete (i32.const 2))
        (i32.store offset=28
          (local.get $emission_address)
          (local.get $instruction_index))
        (i32.store offset=44
          (local.get $emission_address)
          (local.get $complete))
        (i32.store
          (local.get $program_address)
          (global.get $PROGRAM_MAGIC))
        (call $work_add (i32.const 1))
        (if
          (i32.ne
            (call $validate_program
              (local.get $program_address)
              (local.get $program_bytes))
            (global.get $STATUS_OK))
          (then
            (i32.store (local.get $program_address) (i32.const 0))
            (return
              (global.get $STATUS_CORRUPT_PROGRAM)
              (local.get $fuel))))))
    (return (global.get $STATUS_OK) (local.get $fuel)))

  (func $valid_target
    (param $target i32)
    (param $instruction_count i32)
    (result i32)
    (i32.lt_u (local.get $target) (local.get $instruction_count)))

  ;; Validate the complete immutable program before execution. Compiler output,
  ;; restored snapshots, and debug-authored programs all cross this same gate.
  (func $validate_program (export "validate_program")
    (param $program_address i32)
    (param $program_capacity i32)
    (result i32)
    (local $memory_bytes i64)
    (local $program_bytes i32)
    (local $instruction_count i32)
    (local $range_count i32)
    (local $capture_group_count i32)
    (local $name_bytes i32)
    (local $expected_bytes i32)
    (local $instruction_index i32)
    (local $instruction_address i32)
    (local $opcode i32)
    (local $first_operand i32)
    (local $second_operand i32)
    (local $third_operand i32)
    (local $range_index i32)
    (local $range_address i32)
    (local $range_end i32)
    (local $name_address i32)
    (local $name_bytes_remaining i32)
    (local $capture_name_group i32)
    (local $capture_name_length i32)
    (local $prior_name_address i32)
    (local $prior_name_length i32)
    (local $name_byte_index i32)
    (local $names_match i32)
    (local $guard_slots i32)

    (call $work_add (i32.const 1))
    (local.set $memory_bytes
      (i64.mul (i64.extend_i32_u (memory.size)) (i64.const 65536)))
    (if
      (i64.gt_u
        (i64.add
          (i64.extend_i32_u (local.get $program_address))
          (i64.extend_i32_u (local.get $program_capacity)))
        (local.get $memory_bytes))
      (then (return (global.get $STATUS_BUFFER_TOO_SMALL))))
    (if (i32.lt_u (local.get $program_capacity) (global.get $PROGRAM_HEADER_SIZE))
      (then (return (global.get $STATUS_BUFFER_TOO_SMALL))))
    (if
      (i32.ne
        (i32.load (local.get $program_address))
        (global.get $PROGRAM_MAGIC))
      (then (return (global.get $STATUS_CORRUPT_PROGRAM))))
    (if
      (i32.ne
        (i32.load offset=4 (local.get $program_address))
        (global.get $FORMAT_VERSION))
      (then (return (global.get $STATUS_CORRUPT_PROGRAM))))

    (local.set $program_bytes
      (i32.load offset=8 (local.get $program_address)))
    (local.set $instruction_count
      (i32.load offset=12 (local.get $program_address)))
    (local.set $range_count
      (i32.load offset=16 (local.get $program_address)))
    (local.set $capture_group_count
      (i32.load offset=20 (local.get $program_address)))
    (local.set $name_bytes
      (i32.load offset=28 (local.get $program_address)))

    (if
      (i32.ne
        (i32.and
          (i32.load offset=24 (local.get $program_address))
          (i32.const 0xffffff50))
        (i32.const 0))
      (then (return (global.get $STATUS_CORRUPT_PROGRAM))))
    (if
      (i32.gt_u
        (local.get $capture_group_count)
        (global.get $MAX_CAPTURE_GROUPS))
      (then (return (global.get $STATUS_CORRUPT_PROGRAM))))
    (local.set $guard_slots
      (i32.load offset=32 (local.get $program_address)))
    (if
      (i32.or
        (i32.gt_u
          (local.get $guard_slots)
          (global.get $MAX_BYTECODE_INSTRUCTIONS))
        (i32.ne
          (i32.load offset=36 (local.get $program_address))
          (i32.const 0)))
      (then (return (global.get $STATUS_CORRUPT_PROGRAM))))
    (local.set $expected_bytes
      (call $program_size
        (local.get $instruction_count)
        (local.get $range_count)
        (local.get $name_bytes)))
    (if
      (i32.or
        (i32.eq (local.get $expected_bytes) (i32.const -1))
        (i32.ne (local.get $program_bytes) (local.get $expected_bytes)))
      (then (return (global.get $STATUS_CORRUPT_PROGRAM))))
    (if (i32.gt_u (local.get $program_bytes) (local.get $program_capacity))
      (then (return (global.get $STATUS_BUFFER_TOO_SMALL))))
    (if (i32.eqz (local.get $instruction_count))
      (then (return (global.get $STATUS_CORRUPT_PROGRAM))))

    (block $instructions_done
      (loop $validate_instruction
        (call $work_add (i32.const 1))
        (br_if $instructions_done
          (i32.ge_u
            (local.get $instruction_index)
            (local.get $instruction_count)))
        (local.set $instruction_address
          (i32.add
            (i32.add
              (local.get $program_address)
              (global.get $PROGRAM_HEADER_SIZE))
            (i32.mul
              (local.get $instruction_index)
              (global.get $INSTRUCTION_SIZE))))
        (local.set $opcode (i32.load (local.get $instruction_address)))
        (local.set $first_operand
          (i32.load offset=4 (local.get $instruction_address)))
        (local.set $second_operand
          (i32.load offset=8 (local.get $instruction_address)))
        (local.set $third_operand
          (i32.load offset=12 (local.get $instruction_address)))

        (if (i32.eq (local.get $opcode) (global.get $OPCODE_CHARACTER))
          (then
            (if
              (i32.or
                (i32.eqz (call $valid_scalar (local.get $first_operand)))
                (i32.eqz
                  (call $valid_target
                    (local.get $second_operand)
                    (local.get $instruction_count))))
              (then (return (global.get $STATUS_CORRUPT_PROGRAM))))
            (if (local.get $third_operand)
              (then (return (global.get $STATUS_CORRUPT_PROGRAM)))))
          (else
            (if (i32.eq (local.get $opcode) (global.get $OPCODE_ANY))
              (then
                (if
                  (i32.or
                    (i32.eqz
                      (call $valid_target
                        (local.get $first_operand)
                        (local.get $instruction_count)))
                    (i32.or
                      (local.get $second_operand)
                      (local.get $third_operand)))
                  (then (return (global.get $STATUS_CORRUPT_PROGRAM)))))
              (else
                (if
                  (i32.or
                    (i32.eq
                      (local.get $opcode)
                      (global.get $OPCODE_CHARACTER_CLASS))
                    (i32.eq
                      (local.get $opcode)
                      (global.get $OPCODE_NEGATED_CHARACTER_CLASS)))
                  (then
                    (if
                      (i32.or
                        (i32.gt_u
                          (local.get $first_operand)
                          (local.get $range_count))
                        (i32.gt_u
                          (local.get $second_operand)
                          (i32.sub
                            (local.get $range_count)
                            (local.get $first_operand))))
                      (then (return (global.get $STATUS_CORRUPT_PROGRAM))))
                    (if
                      (i32.eqz
                        (call $valid_target
                          (local.get $third_operand)
                          (local.get $instruction_count)))
                      (then (return (global.get $STATUS_CORRUPT_PROGRAM)))))
                  (else
                    (if (i32.eq (local.get $opcode) (global.get $OPCODE_SPLIT))
                      (then
                        (if
                          (i32.or
                            (i32.eqz
                              (call $valid_target
                                (local.get $first_operand)
                                (local.get $instruction_count)))
                            (i32.or
                              (i32.eqz
                                (call $valid_target
                                  (local.get $second_operand)
                                  (local.get $instruction_count)))
                              (local.get $third_operand)))
                          (then (return (global.get $STATUS_CORRUPT_PROGRAM)))))
                      (else
                        (if (i32.eq (local.get $opcode) (global.get $OPCODE_JUMP))
                          (then
                            (if
                              (i32.or
                                (i32.eqz
                                  (call $valid_target
                                    (local.get $first_operand)
                                    (local.get $instruction_count)))
                                (i32.or
                                  (local.get $second_operand)
                                  (local.get $third_operand)))
                              (then (return (global.get $STATUS_CORRUPT_PROGRAM)))))
                          (else
                            (if (i32.eq (local.get $opcode) (global.get $OPCODE_SAVE))
                              (then
                                (if
                                  (i32.or
                                    (i32.ge_u
                                      (local.get $first_operand)
                                      (i32.add
                                        (i32.mul
                                          (i32.add
                                            (local.get $capture_group_count)
                                            (i32.const 1))
                                          (i32.const 2))
                                        (local.get $guard_slots)))
                                    (i32.or
                                      (i32.eqz
                                        (call $valid_target
                                          (local.get $second_operand)
                                          (local.get $instruction_count)))
                                      (local.get $third_operand)))
                                  (then (return (global.get $STATUS_CORRUPT_PROGRAM)))))
                              (else
                                (if
                                  (i32.or
                                    (i32.eq
                                      (local.get $opcode)
                                      (global.get $OPCODE_ASSERT_START))
                                    (i32.eq
                                      (local.get $opcode)
                                      (global.get $OPCODE_ASSERT_END)))
                                  (then
                                    (if
                                      (i32.or
                                        (i32.eqz
                                          (call $valid_target
                                            (local.get $first_operand)
                                            (local.get $instruction_count)))
                                        (i32.or
                                          (local.get $second_operand)
                                          (local.get $third_operand)))
                                      (then
                                        (return
                                          (global.get $STATUS_CORRUPT_PROGRAM)))))
                                  (else
                                    (if
                                      (i32.eq
                                        (local.get $opcode)
                                        (global.get $OPCODE_MATCH))
                                      (then
                                        (if
                                          (i32.or
                                            (local.get $first_operand)
                                            (i32.or
                                              (local.get $second_operand)
                                              (local.get $third_operand)))
                                          (then
                                            (return
                                              (global.get $STATUS_CORRUPT_PROGRAM)))))
                                      (else
                                        (if
                                          (i32.eq
                                            (local.get $opcode)
                                            (global.get $OPCODE_CLEAR_CAPTURES))
                                          (then
                                            ;; Whole explicit-group slot
                                            ;; pairs only; group zero is
                                            ;; never cleared.
                                            (if
                                              (i32.or
                                                (i32.or
                                                  (i32.lt_u
                                                    (local.get $first_operand)
                                                    (i32.const 2))
                                                  (i32.or
                                                    (i32.and
                                                      (local.get $first_operand)
                                                      (i32.const 1))
                                                    (i32.and
                                                      (local.get $second_operand)
                                                      (i32.const 1))))
                                                (i32.or
                                                  (i32.eqz
                                                    (local.get $second_operand))
                                                  (i32.or
                                                    (i32.gt_u
                                                      (i32.add
                                                        (local.get $first_operand)
                                                        (local.get $second_operand))
                                                      (i32.mul
                                                        (i32.add
                                                          (local.get $capture_group_count)
                                                          (i32.const 1))
                                                        (i32.const 2)))
                                                    (i32.eqz
                                                      (call $valid_target
                                                        (local.get $third_operand)
                                                        (local.get $instruction_count))))))
                                              (then
                                                (return
                                                  (global.get $STATUS_CORRUPT_PROGRAM)))))
                                          (else
                                            (if
                                              (i32.eq
                                                (local.get $opcode)
                                                (global.get $OPCODE_GUARD))
                                              (then
                                                ;; Guards read only hidden
                                                ;; slots past the capture
                                                ;; pairs.
                                                (if
                                                  (i32.or
                                                    (i32.lt_u
                                                      (local.get $first_operand)
                                                      (i32.mul
                                                        (i32.add
                                                          (local.get $capture_group_count)
                                                          (i32.const 1))
                                                        (i32.const 2)))
                                                    (i32.or
                                                      (i32.ge_u
                                                        (local.get $first_operand)
                                                        (i32.add
                                                          (i32.mul
                                                            (i32.add
                                                              (local.get $capture_group_count)
                                                              (i32.const 1))
                                                            (i32.const 2))
                                                          (local.get $guard_slots)))
                                                      (i32.or
                                                        (i32.eqz
                                                          (call $valid_target
                                                            (local.get $second_operand)
                                                            (local.get $instruction_count)))
                                                        (local.get $third_operand))))
                                                  (then
                                                    (return
                                                      (global.get $STATUS_CORRUPT_PROGRAM)))))
                                              (else
                                                (return
                                                  (global.get $STATUS_CORRUPT_PROGRAM))))))))))))))))))))))

        (local.set $instruction_index
          (i32.add (local.get $instruction_index) (i32.const 1)))
        (br $validate_instruction)))

    (local.set $range_address
      (i32.add
        (i32.add
          (local.get $program_address)
          (global.get $PROGRAM_HEADER_SIZE))
        (i32.mul
          (local.get $instruction_count)
          (global.get $INSTRUCTION_SIZE))))
    (block $ranges_done
      (loop $validate_range
        (call $work_add (i32.const 1))
        (br_if $ranges_done
          (i32.ge_u (local.get $range_index) (local.get $range_count)))
        (local.set $range_end
          (i32.load offset=4 (local.get $range_address)))
        (if
          (i32.or
            (i32.eqz
              (call $valid_scalar
                (i32.load (local.get $range_address))))
            (i32.or
              (i32.eqz (call $valid_scalar (local.get $range_end)))
              (i32.gt_u
                (i32.load (local.get $range_address))
                (local.get $range_end))))
          (then (return (global.get $STATUS_CORRUPT_PROGRAM))))
        (local.set $range_address
          (i32.add (local.get $range_address) (i32.const 8)))
        (local.set $range_index
          (i32.add (local.get $range_index) (i32.const 1)))
        (br $validate_range)))
    (local.set $name_address (local.get $range_address))
    (local.set $name_bytes_remaining (local.get $name_bytes))
    (block $names_done
      (loop $validate_name
        (call $work_add (i32.const 1))
        (br_if $names_done (i32.eqz (local.get $name_bytes_remaining)))
        (if
          (i32.lt_u
            (local.get $name_bytes_remaining)
            (global.get $NAME_HEADER_SIZE))
          (then (return (global.get $STATUS_CORRUPT_PROGRAM))))
        (local.set $capture_name_group
          (i32.load (local.get $name_address)))
        (local.set $capture_name_length
          (i32.load offset=4 (local.get $name_address)))
        (if
          (i32.or
            (i32.eqz (local.get $capture_name_group))
            (i32.or
              (i32.gt_u
                (local.get $capture_name_group)
                (local.get $capture_group_count))
              (i32.or
                (i32.eqz (local.get $capture_name_length))
                (i32.gt_u
                  (local.get $capture_name_length)
                  (i32.sub
                    (local.get $name_bytes_remaining)
                    (global.get $NAME_HEADER_SIZE))))))
          (then (return (global.get $STATUS_CORRUPT_PROGRAM))))
        (if
          (i32.ne
            (call $validate_utf8
              (i32.add
                (local.get $name_address)
                (global.get $NAME_HEADER_SIZE))
              (local.get $capture_name_length))
            (global.get $STATUS_OK))
          (then (return (global.get $STATUS_CORRUPT_PROGRAM))))
        (local.set $prior_name_address (local.get $range_address))
        (block $prior_names_done
          (loop $validate_prior_name
            (call $work_add (i32.const 1))
        (br_if $prior_names_done
              (i32.ge_u
                (local.get $prior_name_address)
                (local.get $name_address)))
            (local.set $prior_name_length
              (i32.load offset=4 (local.get $prior_name_address)))
            (if
              (i32.eq
                (i32.load (local.get $prior_name_address))
                (local.get $capture_name_group))
              (then (return (global.get $STATUS_CORRUPT_PROGRAM))))
            (if
              (i32.eq
                (local.get $prior_name_length)
                (local.get $capture_name_length))
              (then
                (local.set $names_match (i32.const 1))
                (local.set $name_byte_index (i32.const 0))
                (block $prior_name_bytes_done
                  (loop $validate_prior_name_byte
                    (call $work_add (i32.const 1))
        (br_if $prior_name_bytes_done
                      (i32.ge_u
                        (local.get $name_byte_index)
                        (local.get $capture_name_length)))
                    (if
                      (i32.ne
                        (call $work_byte (i32.add
                            (i32.add
                              (local.get $prior_name_address)
                              (global.get $NAME_HEADER_SIZE))
                            (local.get $name_byte_index)))
                        (call $work_byte (i32.add
                            (i32.add
                              (local.get $name_address)
                              (global.get $NAME_HEADER_SIZE))
                            (local.get $name_byte_index))))
                      (then
                        (local.set $names_match (i32.const 0))
                        (br $prior_name_bytes_done)))
                    (local.set $name_byte_index
                      (i32.add
                        (local.get $name_byte_index)
                        (i32.const 1)))
                    (br $validate_prior_name_byte)))
                (if (local.get $names_match)
                  (then (return (global.get $STATUS_CORRUPT_PROGRAM))))))
            (local.set $prior_name_address
              (i32.add
                (i32.add
                  (local.get $prior_name_address)
                  (global.get $NAME_HEADER_SIZE))
                (local.get $prior_name_length)))
            (br $validate_prior_name)))
        (local.set $name_address
          (i32.add
            (i32.add
              (local.get $name_address)
              (global.get $NAME_HEADER_SIZE))
            (local.get $capture_name_length)))
        (local.set $name_bytes_remaining
          (i32.sub
            (local.get $name_bytes_remaining)
            (i32.add
              (global.get $NAME_HEADER_SIZE)
              (local.get $capture_name_length))))
        (br $validate_name)))

    (global.get $STATUS_OK))

  ;; One Pike thread record: instruction pointer, one reserved word, two
  ;; byte offsets for group zero plus every explicit capture group, and one
  ;; hidden slot per empty-iteration guard.
  (func $thread_record_bytes
    (param $capture_group_count i32)
    (param $guard_slots i32)
    (result i32)
    (i32.add
      (global.get $THREAD_HEADER_SIZE)
      (i32.mul
        (i32.add
          (i32.mul
            (i32.add (local.get $capture_group_count) (i32.const 1))
            (i32.const 2))
          (local.get $guard_slots))
        (i32.const 4))))
  ;; JavaScript's multiline and dot semantics recognize four terminators.
  (func $line_terminator (param $scalar i32) (result i32)
    (i32.or
      (i32.or
        (i32.eq (local.get $scalar) (i32.const 0x0a))
        (i32.eq (local.get $scalar) (i32.const 0x0d)))
      (i32.or
        (i32.eq (local.get $scalar) (i32.const 0x2028))
        (i32.eq (local.get $scalar) (i32.const 0x2029)))))

  ;; ASCII-only folding: the opposite-case letter, or the scalar itself.
  (func $ascii_case_counterpart (param $scalar i32) (result i32)
    (if
      (i32.and
        (i32.ge_u (local.get $scalar) (i32.const 65))
        (i32.le_u (local.get $scalar) (i32.const 90)))
      (then (return (i32.add (local.get $scalar) (i32.const 32)))))
    (if
      (i32.and
        (i32.ge_u (local.get $scalar) (i32.const 97))
        (i32.le_u (local.get $scalar) (i32.const 122)))
      (then (return (i32.sub (local.get $scalar) (i32.const 32)))))
    (local.get $scalar))

  (func $scalar_in_ranges
    (param $range_address i32)
    (param $range_count i32)
    (param $scalar i32)
    (result i32)
    (local $index i32)
    (block $done
      (loop $next_range
        (call $work_add (i32.const 1))
        (br_if $done (i32.ge_u (local.get $index) (local.get $range_count)))
        (if
          (i32.and
            (i32.ge_u (local.get $scalar)
              (i32.load (local.get $range_address)))
            (i32.le_u (local.get $scalar)
              (i32.load offset=4 (local.get $range_address))))
          (then (return (i32.const 1))))
        (local.set $range_address
          (i32.add (local.get $range_address) (global.get $RANGE_SIZE)))
        (local.set $index (i32.add (local.get $index) (i32.const 1)))
        (br $next_range)))
    (i32.const 0))

  ;; Effective class membership: the scalar itself, plus its ASCII case
  ;; counterpart under the ignore-case flag. Negated classes invert this one
  ;; membership result so [^a] under `i` also rejects the uppercase letter.
  (func $class_membership
    (param $range_address i32)
    (param $range_count i32)
    (param $scalar i32)
    (param $ignore_case i32)
    (result i32)
    (local $counterpart i32)
    (if
      (call $scalar_in_ranges
        (local.get $range_address)
        (local.get $range_count)
        (local.get $scalar))
      (then (return (i32.const 1))))
    (if (i32.eqz (local.get $ignore_case))
      (then (return (i32.const 0))))
    (local.set $counterpart
      (call $ascii_case_counterpart (local.get $scalar)))
    (if (i32.eq (local.get $counterpart) (local.get $scalar))
      (then (return (i32.const 0))))
    (call $scalar_in_ranges
      (local.get $range_address)
      (local.get $range_count)
      (local.get $counterpart)))

  ;; Copy one thread record into a bounded list slot and retarget its
  ;; instruction pointer. Returns the grown count, or -1 when the list is
  ;; full. Copying before patching keeps the source record intact even when
  ;; the destination slot is the record just popped from the same stack.
  (func $place_thread
    (param $list_base i32)
    (param $count i32)
    (param $capacity i32)
    (param $thread_bytes i32)
    (param $entry_address i32)
    (param $target i32)
    (result i32)
    (local $destination i32)
    (if (i32.ge_u (local.get $count) (local.get $capacity))
      (then (return (i32.const -1))))
    (local.set $destination
      (i32.add
        (local.get $list_base)
        (i32.mul (local.get $count) (local.get $thread_bytes))))
    (call $work_copy
      (local.get $destination)
      (local.get $entry_address)
      (local.get $thread_bytes))
    (i32.store (local.get $destination) (local.get $target))
    (i32.store offset=4 (local.get $destination) (i32.const 0))
    (i32.add (local.get $count) (i32.const 1)))

  ;; Prepare one resumable match over caller-owned buffers. The continuation
  ;; is committed only after every program, input, offset, aliasing, and
  ;; capacity dependency validates. Initialization is unmetered, mirroring
  ;; emission setup. The start offsets must name the same scalar boundary:
  ;; the byte offset addresses input bytes and the scalar offset carries the
  ;; caller's already-known scalar index for that boundary.
  (func $initialize_match_impl
    (param $program_address i32)
    (param $program_capacity i32)
    (param $input_address i32)
    (param $input_bytes i32)
    (param $start_byte i32)
    (param $start_scalar i32)
    (param $continuation_address i32)
    (param $continuation_capacity i32)
    (result i32)
    (local $status i32)
    (local $program_bytes i32)
    (local $instruction_count i32)
    (local $capture_group_count i32)
    (local $flags i32)
    (local $required i32)
    (local $memory_bytes i64)
    (local $continuation_end i64)
    (local $previous_scalar i32)
    (local $back_step i32)
    (local $lead_address i32)
    (local $decoded i64)
    (local $capture_bytes i32)
    (local $guard_slots i32)
    (local $candidate_address i32)
    (local $marks_address i32)
    (call $work_add (i32.const 7))
    (local.set $status
      (call $validate_program
        (local.get $program_address)
        (local.get $program_capacity)))
    (if (i32.ne (local.get $status) (global.get $STATUS_OK))
      (then (return (local.get $status))))
    (local.set $program_bytes
      (i32.load offset=8 (local.get $program_address)))
    (local.set $instruction_count
      (i32.load offset=12 (local.get $program_address)))
    (local.set $capture_group_count
      (i32.load offset=20 (local.get $program_address)))
    (local.set $flags (i32.load offset=24 (local.get $program_address)))
    (local.set $guard_slots
      (i32.load offset=32 (local.get $program_address)))
    (local.set $memory_bytes
      (i64.mul (i64.extend_i32_u (memory.size)) (i64.const 65536)))
    (if
      (i64.gt_u
        (i64.add
          (i64.extend_i32_u (local.get $input_address))
          (i64.extend_i32_u (local.get $input_bytes)))
        (local.get $memory_bytes))
      (then (return (global.get $STATUS_BUFFER_TOO_SMALL))))
    (local.set $required
      (call $continuation_size
        (local.get $instruction_count)
        (local.get $capture_group_count)
        (local.get $guard_slots)))
    (if (i32.eq (local.get $required) (i32.const -1))
      (then (return (global.get $STATUS_CORRUPT_PROGRAM))))
    (if (i32.lt_u (local.get $continuation_capacity) (local.get $required))
      (then (return (global.get $STATUS_BUFFER_TOO_SMALL))))
    (local.set $continuation_end
      (i64.add
        (i64.extend_i32_u (local.get $continuation_address))
        (i64.extend_i32_u (local.get $required))))
    (if (i64.gt_u (local.get $continuation_end) (local.get $memory_bytes))
      (then (return (global.get $STATUS_BUFFER_TOO_SMALL))))
    ;; The written continuation must not alias the program or the input.
    (if
      (i32.and
        (i64.lt_u
          (i64.extend_i32_u (local.get $continuation_address))
          (i64.add
            (i64.extend_i32_u (local.get $program_address))
            (i64.extend_i32_u (local.get $program_bytes))))
        (i64.lt_u
          (i64.extend_i32_u (local.get $program_address))
          (local.get $continuation_end)))
      (then (return (global.get $STATUS_CORRUPT_PROGRAM))))
    (if
      (i32.and
        (i64.lt_u
          (i64.extend_i32_u (local.get $continuation_address))
          (i64.add
            (i64.extend_i32_u (local.get $input_address))
            (i64.extend_i32_u (local.get $input_bytes))))
        (i64.lt_u
          (i64.extend_i32_u (local.get $input_address))
          (local.get $continuation_end)))
      (then (return (global.get $STATUS_CORRUPT_PROGRAM))))
    ;; Start offsets must land on a scalar boundary inside the input. A
    ;; scalar index can never exceed its own byte offset.
    (if (i32.gt_u (local.get $start_byte) (local.get $input_bytes))
      (then (return (global.get $STATUS_INVALID_UTF8))))
    (if (i32.gt_u (local.get $start_scalar) (local.get $start_byte))
      (then (return (global.get $STATUS_INVALID_UTF8))))
    ;; Multiline start assertions need the scalar that ends at the start
    ;; byte. Decoding it backwards also proves the boundary is real.
    (local.set $previous_scalar (i32.const -1))
    (if (i32.ne (local.get $start_byte) (i32.const 0))
      (then
        (local.set $back_step (i32.const 1))
        (block $lead_found
          (loop $walk_back
            (call $work_add (i32.const 1))
        (if
              (i32.or
                (i32.gt_u (local.get $back_step) (local.get $start_byte))
                (i32.gt_u (local.get $back_step) (i32.const 4)))
              (then (return (global.get $STATUS_INVALID_UTF8))))
            (local.set $lead_address
              (i32.sub
                (i32.add (local.get $input_address) (local.get $start_byte))
                (local.get $back_step)))
            (br_if $lead_found
              (i32.ne
                (i32.and
                  (call $work_byte (local.get $lead_address))
                  (i32.const 0xc0))
                (i32.const 0x80)))
            (local.set $back_step
              (i32.add (local.get $back_step) (i32.const 1)))
            (br $walk_back)))
        (local.set $decoded
          (call $decode_scalar
            (local.get $lead_address)
            (i32.add (local.get $input_address) (local.get $input_bytes))))
        (if (i64.eq (local.get $decoded) (i64.const -1))
          (then (return (global.get $STATUS_INVALID_UTF8))))
        (if
          (i32.ne
            (i32.wrap_i64 (i64.shr_u (local.get $decoded) (i64.const 32)))
            (i32.add (local.get $input_address) (local.get $start_byte)))
          (then (return (global.get $STATUS_INVALID_UTF8))))
        (local.set $previous_scalar (i32.wrap_i64 (local.get $decoded)))))
    (local.set $capture_bytes
      (i32.mul
        (i32.add
          (i32.mul
            (i32.add (local.get $capture_group_count) (i32.const 1))
            (i32.const 2))
          (local.get $guard_slots))
        (i32.const 4)))
    (local.set $candidate_address
      (i32.add
        (local.get $continuation_address)
        (global.get $CONTINUATION_HEADER_SIZE)))
    (local.set $marks_address
      (i32.add
        (i32.add (local.get $candidate_address) (local.get $capture_bytes))
        (i32.mul
          (i32.mul (local.get $instruction_count) (i32.const 3))
          (call $thread_record_bytes
            (local.get $capture_group_count)
            (local.get $guard_slots)))))
    (i32.store
      (local.get $continuation_address)
      (global.get $CONTINUATION_MAGIC))
    (i32.store offset=4
      (local.get $continuation_address)
      (global.get $STATE_VERSION))
    (i32.store offset=8
      (local.get $continuation_address)
      (local.get $program_address))
    (i32.store offset=12
      (local.get $continuation_address)
      (local.get $program_bytes))
    (i32.store offset=16
      (local.get $continuation_address)
      (local.get $input_address))
    (i32.store offset=20
      (local.get $continuation_address)
      (local.get $input_bytes))
    (i32.store offset=24
      (local.get $continuation_address)
      (local.get $start_byte))
    (i32.store offset=28
      (local.get $continuation_address)
      (local.get $start_byte))
    (i32.store offset=32
      (local.get $continuation_address)
      (local.get $start_scalar))
    (i32.store offset=36
      (local.get $continuation_address)
      (local.get $previous_scalar))
    (i32.store offset=40
      (local.get $continuation_address)
      (global.get $PHASE_POSITION))
    (i32.store offset=44 (local.get $continuation_address) (i32.const 0))
    (i32.store offset=48 (local.get $continuation_address) (i32.const 0))
    (i32.store offset=52 (local.get $continuation_address) (i32.const 0))
    (i32.store offset=56 (local.get $continuation_address) (i32.const 0))
    (i32.store offset=60 (local.get $continuation_address) (i32.const 0))
    (i32.store offset=64 (local.get $continuation_address) (i32.const 0))
    (i32.store offset=68 (local.get $continuation_address) (i32.const -1))
    (i32.store offset=72 (local.get $continuation_address) (i32.const -1))
    (i32.store offset=76 (local.get $continuation_address) (i32.const -1))
    (i32.store offset=80
      (local.get $continuation_address)
      (local.get $start_byte))
    (i32.store offset=84
      (local.get $continuation_address)
      (local.get $instruction_count))
    (i32.store offset=88
      (local.get $continuation_address)
      (local.get $capture_group_count))
    (i32.store offset=92
      (local.get $continuation_address)
      (local.get $flags))
    (i32.store offset=96
      (local.get $continuation_address)
      (local.get $guard_slots))
    (i32.store offset=100
      (local.get $continuation_address)
      (i32.const 0))
    (call $work_fill
      (local.get $candidate_address)
      (i32.const 0xff)
      (local.get $capture_bytes))
    (call $work_fill
      (local.get $marks_address)
      (i32.const 0)
      (i32.mul (local.get $instruction_count) (i32.const 4)))
    (global.get $STATUS_OK))

  ;; Execute the ordered Pike VM under a bounded fuel budget. One documented
  ;; rule charges every transition: starting one input position (scalar
  ;; decode plus start-thread injection) costs one unit, and taking one
  ;; pending thread record costs one unit. UTF-8, classes, captures, copies,
  ;; fills and setup add their source-owned charges. Intrinsic work is atomic,
  ;; not preempted: PAUSED may return negative fuel, clamped at INT32_MIN.
  ;; Setup debt is consumed once; subsequent positive grants make progress.
  ;;
  ;; Ordering: the current list holds threads in source-priority order and
  ;; is drained through a cursor; epsilon closure runs depth-first through
  ;; the priority stack, so higher-priority alternatives fully expand before
  ;; lower ones. Consuming survivors append to the next list in that same
  ;; priority order. The first thread reaching an instruction at a position
  ;; wins deduplication; MATCH records the candidate and cuts every
  ;; lower-priority pending record while surviving higher-priority threads
  ;; may still replace the candidate later.
  (func $run_match_impl
    (param $continuation_address i32)
    (param $continuation_capacity i32)
    (param $fuel i32)
    (result i32 i32)
    (local $memory_bytes i64)
    (local $required i32)
    (local $instruction_count i32)
    (local $capture_group_count i32)
    (local $program_address i32)
    (local $program_bytes i32)
    (local $input_address i32)
    (local $input_bytes i32)
    (local $start_byte i32)
    (local $flags i32)
    (local $range_count i32)
    (local $capture_bytes i32)
    (local $thread_bytes i32)
    (local $candidate_address i32)
    (local $lists_base i32)
    (local $stack_base i32)
    (local $marks_address i32)
    (local $current_base i32)
    (local $next_base i32)
    (local $byte_position i32)
    (local $scalar_position i32)
    (local $previous_scalar i32)
    (local $decoded_scalar i32)
    (local $next_byte_position i32)
    (local $phase i32)
    (local $parity i32)
    (local $current_count i32)
    (local $cursor i32)
    (local $stack_count i32)
    (local $next_count i32)
    (local $matched i32)
    (local $match_end_byte i32)
    (local $match_end_scalar i32)
    (local $guard_slots i32)
    (local $sticky i32)
    (local $multiline i32)
    (local $dot_all i32)
    (local $ignore_case i32)
    (local $result_status i32)
    (local $entry_address i32)
    (local $instruction_pointer i32)
    (local $mark_address i32)
    (local $instruction_address i32)
    (local $opcode i32)
    (local $first_operand i32)
    (local $second_operand i32)
    (local $third_operand i32)
    (local $decoded i64)
    (local $consumed_target i32)
    (local $advances i32)
    (local $placed i32)
    (local $swap_temp i32)
    (local.set $memory_bytes
      (i64.mul (i64.extend_i32_u (memory.size)) (i64.const 65536)))
    (if
      (i64.gt_u
        (i64.add
          (i64.extend_i32_u (local.get $continuation_address))
          (i64.extend_i32_u (global.get $CONTINUATION_HEADER_SIZE)))
        (local.get $memory_bytes))
      (then
        (return
          (global.get $STATUS_BUFFER_TOO_SMALL)
          (local.get $fuel))))
    (if
      (i32.lt_u
        (local.get $continuation_capacity)
        (global.get $CONTINUATION_HEADER_SIZE))
      (then
        (return
          (global.get $STATUS_BUFFER_TOO_SMALL)
          (local.get $fuel))))
    (if
      (i32.or
        (i32.ne
          (i32.load (local.get $continuation_address))
          (global.get $CONTINUATION_MAGIC))
        (i32.ne
          (i32.load offset=4 (local.get $continuation_address))
          (global.get $STATE_VERSION)))
      (then
        (return
          (global.get $STATUS_CORRUPT_PROGRAM)
          (local.get $fuel))))
    (local.set $instruction_count
      (i32.load offset=84 (local.get $continuation_address)))
    (local.set $capture_group_count
      (i32.load offset=88 (local.get $continuation_address)))
    (local.set $guard_slots
      (i32.load offset=96 (local.get $continuation_address)))
    (if
      (i32.ne
        (i32.load offset=100 (local.get $continuation_address))
        (i32.const 0))
      (then
        (return
          (global.get $STATUS_CORRUPT_PROGRAM)
          (local.get $fuel))))
    (local.set $required
      (call $continuation_size
        (local.get $instruction_count)
        (local.get $capture_group_count)
        (local.get $guard_slots)))
    (if
      (i32.or
        (i32.eq (local.get $required) (i32.const -1))
        (i32.eqz (local.get $instruction_count)))
      (then
        (return
          (global.get $STATUS_CORRUPT_PROGRAM)
          (local.get $fuel))))
    (if (i32.lt_u (local.get $continuation_capacity) (local.get $required))
      (then
        (return
          (global.get $STATUS_BUFFER_TOO_SMALL)
          (local.get $fuel))))
    (if
      (i64.gt_u
        (i64.add
          (i64.extend_i32_u (local.get $continuation_address))
          (i64.extend_i32_u (local.get $required)))
        (local.get $memory_bytes))
      (then
        (return
          (global.get $STATUS_BUFFER_TOO_SMALL)
          (local.get $fuel))))
    (local.set $program_address
      (i32.load offset=8 (local.get $continuation_address)))
    (local.set $program_bytes
      (i32.load offset=12 (local.get $continuation_address)))
    (local.set $input_address
      (i32.load offset=16 (local.get $continuation_address)))
    (local.set $input_bytes
      (i32.load offset=20 (local.get $continuation_address)))
    (local.set $start_byte
      (i32.load offset=24 (local.get $continuation_address)))
    (local.set $flags
      (i32.load offset=92 (local.get $continuation_address)))
    (if
      (i64.gt_u
        (i64.add
          (i64.extend_i32_u (local.get $program_address))
          (i64.extend_i32_u (local.get $program_bytes)))
        (local.get $memory_bytes))
      (then
        (return
          (global.get $STATUS_BUFFER_TOO_SMALL)
          (local.get $fuel))))
    (if
      (i64.gt_u
        (i64.add
          (i64.extend_i32_u (local.get $input_address))
          (i64.extend_i32_u (local.get $input_bytes)))
        (local.get $memory_bytes))
      (then
        (return
          (global.get $STATUS_BUFFER_TOO_SMALL)
          (local.get $fuel))))
    ;; The retained program must still be the one this match was prepared
    ;; against, and its byte length must satisfy the checked size formula so
    ;; every instruction and range read below stays inside the buffer.
    (if (i32.lt_u (local.get $program_bytes) (global.get $PROGRAM_HEADER_SIZE))
      (then
        (return
          (global.get $STATUS_CORRUPT_PROGRAM)
          (local.get $fuel))))
    (local.set $range_count
      (i32.load offset=16 (local.get $program_address)))
    (if
      (i32.or
        (i32.or
          (i32.ne
            (i32.load (local.get $program_address))
            (global.get $PROGRAM_MAGIC))
          (i32.ne
            (i32.load offset=4 (local.get $program_address))
            (global.get $FORMAT_VERSION)))
        (i32.or
          (i32.ne
            (i32.load offset=8 (local.get $program_address))
            (local.get $program_bytes))
          (i32.or
            (i32.ne
              (i32.load offset=12 (local.get $program_address))
              (local.get $instruction_count))
            (i32.or
              (i32.ne
                (i32.load offset=20 (local.get $program_address))
                (local.get $capture_group_count))
              (i32.or
                (i32.ne
                  (i32.load offset=24 (local.get $program_address))
                  (local.get $flags))
                (i32.ne
                  (i32.load offset=32 (local.get $program_address))
                  (local.get $guard_slots)))))))
      (then
        (return
          (global.get $STATUS_CORRUPT_PROGRAM)
          (local.get $fuel))))
    (if
      (i32.ne
        (call $program_size
          (local.get $instruction_count)
          (local.get $range_count)
          (i32.load offset=28 (local.get $program_address)))
        (local.get $program_bytes))
      (then
        (return
          (global.get $STATUS_CORRUPT_PROGRAM)
          (local.get $fuel))))
    (local.set $byte_position
      (i32.load offset=28 (local.get $continuation_address)))
    (local.set $scalar_position
      (i32.load offset=32 (local.get $continuation_address)))
    (local.set $previous_scalar
      (i32.load offset=36 (local.get $continuation_address)))
    (local.set $phase
      (i32.load offset=40 (local.get $continuation_address)))
    (local.set $parity
      (i32.load offset=44 (local.get $continuation_address)))
    (local.set $current_count
      (i32.load offset=48 (local.get $continuation_address)))
    (local.set $cursor
      (i32.load offset=52 (local.get $continuation_address)))
    (local.set $stack_count
      (i32.load offset=56 (local.get $continuation_address)))
    (local.set $next_count
      (i32.load offset=60 (local.get $continuation_address)))
    (local.set $matched
      (i32.load offset=64 (local.get $continuation_address)))
    (local.set $match_end_byte
      (i32.load offset=68 (local.get $continuation_address)))
    (local.set $match_end_scalar
      (i32.load offset=72 (local.get $continuation_address)))
    (local.set $decoded_scalar
      (i32.load offset=76 (local.get $continuation_address)))
    (local.set $next_byte_position
      (i32.load offset=80 (local.get $continuation_address)))
    (if
      (i32.or
        (i32.or
          (i32.gt_u (local.get $phase) (global.get $PHASE_COMPLETE))
          (i32.gt_u (local.get $parity) (i32.const 1)))
        (i32.or
          (i32.gt_u (local.get $matched) (i32.const 1))
          (i32.gt_u (local.get $start_byte) (local.get $input_bytes))))
      (then
        (return
          (global.get $STATUS_CORRUPT_PROGRAM)
          (local.get $fuel))))
    (if
      (i32.or
        (i32.or
          (i32.gt_u (local.get $current_count) (local.get $instruction_count))
          (i32.gt_u (local.get $cursor) (local.get $current_count)))
        (i32.or
          (i32.gt_u (local.get $stack_count) (local.get $instruction_count))
          (i32.gt_u (local.get $next_count) (local.get $instruction_count))))
      (then
        (return
          (global.get $STATUS_CORRUPT_PROGRAM)
          (local.get $fuel))))
    (if
      (i32.or
        (i32.lt_u (local.get $byte_position) (local.get $start_byte))
        (i32.gt_u (local.get $byte_position) (local.get $input_bytes)))
      (then
        (return
          (global.get $STATUS_CORRUPT_PROGRAM)
          (local.get $fuel))))
    (if
      (i32.and
        (i32.eq (local.get $phase) (global.get $PHASE_PROCESS))
        (i32.or
          (i32.lt_u
            (local.get $next_byte_position)
            (local.get $byte_position))
          (i32.gt_u
            (local.get $next_byte_position)
            (local.get $input_bytes))))
      (then
        (return
          (global.get $STATUS_CORRUPT_PROGRAM)
          (local.get $fuel))))
    (if (i32.eq (local.get $phase) (global.get $PHASE_COMPLETE))
      (then
        (if (local.get $matched)
          (then (return (global.get $STATUS_MATCH) (local.get $fuel))))
        (return (global.get $STATUS_NO_MATCH) (local.get $fuel))))
    (local.set $capture_bytes
      (i32.mul
        (i32.add
          (i32.mul
            (i32.add (local.get $capture_group_count) (i32.const 1))
            (i32.const 2))
          (local.get $guard_slots))
        (i32.const 4)))
    (local.set $thread_bytes
      (call $thread_record_bytes
        (local.get $capture_group_count)
        (local.get $guard_slots)))
    (local.set $candidate_address
      (i32.add
        (local.get $continuation_address)
        (global.get $CONTINUATION_HEADER_SIZE)))
    (local.set $lists_base
      (i32.add (local.get $candidate_address) (local.get $capture_bytes)))
    (local.set $stack_base
      (i32.add
        (local.get $lists_base)
        (i32.mul
          (i32.mul (local.get $instruction_count) (i32.const 2))
          (local.get $thread_bytes))))
    (local.set $marks_address
      (i32.add
        (local.get $stack_base)
        (i32.mul (local.get $instruction_count) (local.get $thread_bytes))))
    (local.set $current_base
      (i32.add
        (local.get $lists_base)
        (i32.mul
          (i32.mul (local.get $parity) (local.get $instruction_count))
          (local.get $thread_bytes))))
    (local.set $next_base
      (i32.add
        (local.get $lists_base)
        (i32.mul
          (i32.mul
            (i32.sub (i32.const 1) (local.get $parity))
            (local.get $instruction_count))
          (local.get $thread_bytes))))
    (local.set $sticky
      (i32.ne
        (i32.and (local.get $flags) (global.get $FLAG_STICKY))
        (i32.const 0)))
    (local.set $multiline
      (i32.ne
        (i32.and (local.get $flags) (global.get $FLAG_MULTILINE))
        (i32.const 0)))
    (local.set $dot_all
      (i32.ne
        (i32.and (local.get $flags) (global.get $FLAG_DOT_ALL))
        (i32.const 0)))
    (local.set $ignore_case
      (i32.ne
        (i32.and (local.get $flags) (global.get $FLAG_IGNORE_CASE))
        (i32.const 0)))
    (block $exit
      (loop $step
        (if (i32.eq (local.get $phase) (global.get $PHASE_POSITION))
          (then
            (local.set $fuel (call $work_take (local.get $fuel)))
        (if (i32.le_s (local.get $fuel) (i32.const 0))
              (then
                (local.set $result_status (global.get $STATUS_PAUSED))
                (br $exit)))
            (call $work_add (i32.const 1))
            (if (i32.lt_u (local.get $byte_position) (local.get $input_bytes))
              (then
                (local.set $decoded
                  (call $decode_scalar
                    (i32.add
                      (local.get $input_address)
                      (local.get $byte_position))
                    (i32.add
                      (local.get $input_address)
                      (local.get $input_bytes))))
                (if (i64.eq (local.get $decoded) (i64.const -1))
                  (then
                    (local.set $result_status
                      (global.get $STATUS_INVALID_UTF8))
                    (br $exit)))
                (local.set $decoded_scalar
                  (i32.wrap_i64 (local.get $decoded)))
                (local.set $next_byte_position
                  (i32.sub
                    (i32.wrap_i64
                      (i64.shr_u (local.get $decoded) (i64.const 32)))
                    (local.get $input_address))))
              (else
                (local.set $decoded_scalar (i32.const -1))
                (local.set $next_byte_position (local.get $byte_position))))
            ;; A new start thread joins at the lowest priority while no
            ;; match candidate exists. Sticky matches never restart past
            ;; the start position.
            (if
              (i32.and
                (i32.eqz (local.get $matched))
                (i32.or
                  (i32.eqz (local.get $sticky))
                  (i32.eq
                    (local.get $byte_position)
                    (local.get $start_byte))))
              (then
                (if
                  (i32.ge_u
                    (local.get $current_count)
                    (local.get $instruction_count))
                  (then
                    (local.set $result_status
                      (global.get $STATUS_CORRUPT_PROGRAM))
                    (br $exit)))
                (local.set $entry_address
                  (i32.add
                    (local.get $current_base)
                    (i32.mul
                      (local.get $current_count)
                      (local.get $thread_bytes))))
                (i32.store (local.get $entry_address) (i32.const 0))
                (i32.store offset=4 (local.get $entry_address) (i32.const 0))
                (call $work_fill
                  (i32.add
                    (local.get $entry_address)
                    (global.get $THREAD_HEADER_SIZE))
                  (i32.const 0xff)
                  (local.get $capture_bytes))
                (local.set $current_count
                  (i32.add (local.get $current_count) (i32.const 1)))))
            (local.set $phase (global.get $PHASE_PROCESS))
            (br $step)))
        ;; The position is finished once the closure stack and the ordered
        ;; current list are both drained.
        (if
          (i32.and
            (i32.eqz (local.get $stack_count))
            (i32.eq (local.get $cursor) (local.get $current_count)))
          (then
            (if (i32.eq (local.get $byte_position) (local.get $input_bytes))
              (then
                (local.set $phase (global.get $PHASE_COMPLETE))
                (local.set $result_status (global.get $STATUS_NO_MATCH))
                (if (local.get $matched)
                  (then
                    (local.set $result_status (global.get $STATUS_MATCH))))
                (br $exit)))
            (if (i32.eqz (local.get $next_count))
              (then
                (if (local.get $matched)
                  (then
                    (local.set $phase (global.get $PHASE_COMPLETE))
                    (local.set $result_status (global.get $STATUS_MATCH))
                    (br $exit)))
                (if (local.get $sticky)
                  (then
                    (local.set $phase (global.get $PHASE_COMPLETE))
                    (local.set $result_status (global.get $STATUS_NO_MATCH))
                    (br $exit)))))
            (local.set $previous_scalar (local.get $decoded_scalar))
            (local.set $byte_position (local.get $next_byte_position))
            (local.set $scalar_position
              (i32.add (local.get $scalar_position) (i32.const 1)))
            (local.set $parity
              (i32.sub (i32.const 1) (local.get $parity)))
            (local.set $swap_temp (local.get $current_base))
            (local.set $current_base (local.get $next_base))
            (local.set $next_base (local.get $swap_temp))
            (local.set $current_count (local.get $next_count))
            (local.set $next_count (i32.const 0))
            (local.set $cursor (i32.const 0))
            (local.set $phase (global.get $PHASE_POSITION))
            (br $step)))
        ;; Take the highest-priority pending record: the closure stack
        ;; first, then the ordered current list.
        (local.set $fuel (call $work_take (local.get $fuel)))
        (if (i32.le_s (local.get $fuel) (i32.const 0))
          (then
            (local.set $result_status (global.get $STATUS_PAUSED))
            (br $exit)))
        (call $work_add (i32.const 1))
        (if (local.get $stack_count)
          (then
            (local.set $stack_count
              (i32.sub (local.get $stack_count) (i32.const 1)))
            (local.set $entry_address
              (i32.add
                (local.get $stack_base)
                (i32.mul
                  (local.get $stack_count)
                  (local.get $thread_bytes)))))
          (else
            (local.set $entry_address
              (i32.add
                (local.get $current_base)
                (i32.mul (local.get $cursor) (local.get $thread_bytes))))
            (local.set $cursor (i32.add (local.get $cursor) (i32.const 1)))))
        (local.set $instruction_pointer (i32.load (local.get $entry_address)))
        (if
          (i32.ge_u
            (local.get $instruction_pointer)
            (local.get $instruction_count))
          (then
            (local.set $result_status (global.get $STATUS_CORRUPT_PROGRAM))
            (br $exit)))
        ;; The first record reaching an instruction at this position wins.
        (local.set $mark_address
          (i32.add
            (local.get $marks_address)
            (i32.mul (local.get $instruction_pointer) (i32.const 4))))
        (if
          (i32.eq
            (i32.load (local.get $mark_address))
            (i32.add (local.get $scalar_position) (i32.const 1)))
          (then (br $step)))
        (i32.store
          (local.get $mark_address)
          (i32.add (local.get $scalar_position) (i32.const 1)))
        (local.set $instruction_address
          (i32.add
            (i32.add
              (local.get $program_address)
              (global.get $PROGRAM_HEADER_SIZE))
            (i32.mul
              (local.get $instruction_pointer)
              (global.get $INSTRUCTION_SIZE))))
        (local.set $opcode (i32.load (local.get $instruction_address)))
        (local.set $first_operand
          (i32.load offset=4 (local.get $instruction_address)))
        (local.set $second_operand
          (i32.load offset=8 (local.get $instruction_address)))
        (local.set $third_operand
          (i32.load offset=12 (local.get $instruction_address)))
        ;; Consuming instructions share one bounded next-list append.
        (local.set $consumed_target (i32.const -1))
        (if (i32.eq (local.get $opcode) (global.get $OPCODE_CHARACTER))
          (then
            (local.set $advances
              (i32.and
                (i32.ne (local.get $decoded_scalar) (i32.const -1))
                (i32.or
                  (i32.eq
                    (local.get $decoded_scalar)
                    (local.get $first_operand))
                  (i32.and
                    (local.get $ignore_case)
                    (i32.eq
                      (call $ascii_case_counterpart
                        (local.get $decoded_scalar))
                      (local.get $first_operand))))))
            (local.set $consumed_target (local.get $second_operand))))
        (if (i32.eq (local.get $opcode) (global.get $OPCODE_ANY))
          (then
            (local.set $advances
              (i32.and
                (i32.ne (local.get $decoded_scalar) (i32.const -1))
                (i32.or
                  (local.get $dot_all)
                  (i32.eqz
                    (call $line_terminator (local.get $decoded_scalar))))))
            (local.set $consumed_target (local.get $first_operand))))
        (if
          (i32.or
            (i32.eq
              (local.get $opcode)
              (global.get $OPCODE_CHARACTER_CLASS))
            (i32.eq
              (local.get $opcode)
              (global.get $OPCODE_NEGATED_CHARACTER_CLASS)))
          (then
            (if
              (i32.or
                (i32.gt_u (local.get $first_operand) (local.get $range_count))
                (i32.gt_u
                  (local.get $second_operand)
                  (i32.sub
                    (local.get $range_count)
                    (local.get $first_operand))))
              (then
                (local.set $result_status
                  (global.get $STATUS_CORRUPT_PROGRAM))
                (br $exit)))
            (local.set $advances (i32.const 0))
            (if (i32.ne (local.get $decoded_scalar) (i32.const -1))
              (then
                (local.set $advances
                  (call $class_membership
                    (i32.add
                      (i32.add
                        (i32.add
                          (local.get $program_address)
                          (global.get $PROGRAM_HEADER_SIZE))
                        (i32.mul
                          (local.get $instruction_count)
                          (global.get $INSTRUCTION_SIZE)))
                      (i32.mul
                        (local.get $first_operand)
                        (global.get $RANGE_SIZE)))
                    (local.get $second_operand)
                    (local.get $decoded_scalar)
                    (local.get $ignore_case)))
                (if
                  (i32.eq
                    (local.get $opcode)
                    (global.get $OPCODE_NEGATED_CHARACTER_CLASS))
                  (then
                    (local.set $advances
                      (i32.eqz (local.get $advances)))))))
            (local.set $consumed_target (local.get $third_operand))))
        (if (i32.ne (local.get $consumed_target) (i32.const -1))
          (then
            (if (local.get $advances)
              (then
                (local.set $placed
                  (call $place_thread
                    (local.get $next_base)
                    (local.get $next_count)
                    (local.get $instruction_count)
                    (local.get $thread_bytes)
                    (local.get $entry_address)
                    (local.get $consumed_target)))
                (if (i32.eq (local.get $placed) (i32.const -1))
                  (then
                    (local.set $result_status
                      (global.get $STATUS_CORRUPT_PROGRAM))
                    (br $exit)))
                (local.set $next_count (local.get $placed))))
            (br $step)))
        (if (i32.eq (local.get $opcode) (global.get $OPCODE_SPLIT))
          (then
            ;; The second branch is deferred below the first so the first
            ;; branch's whole closure expands ahead of it.
            (local.set $placed
              (call $place_thread
                (local.get $stack_base)
                (local.get $stack_count)
                (local.get $instruction_count)
                (local.get $thread_bytes)
                (local.get $entry_address)
                (local.get $second_operand)))
            (if (i32.eq (local.get $placed) (i32.const -1))
              (then
                (local.set $result_status
                  (global.get $STATUS_CORRUPT_PROGRAM))
                (br $exit)))
            (local.set $stack_count (local.get $placed))
            (local.set $placed
              (call $place_thread
                (local.get $stack_base)
                (local.get $stack_count)
                (local.get $instruction_count)
                (local.get $thread_bytes)
                (local.get $entry_address)
                (local.get $first_operand)))
            (if (i32.eq (local.get $placed) (i32.const -1))
              (then
                (local.set $result_status
                  (global.get $STATUS_CORRUPT_PROGRAM))
                (br $exit)))
            (local.set $stack_count (local.get $placed))
            (br $step)))
        (if (i32.eq (local.get $opcode) (global.get $OPCODE_JUMP))
          (then
            (local.set $placed
              (call $place_thread
                (local.get $stack_base)
                (local.get $stack_count)
                (local.get $instruction_count)
                (local.get $thread_bytes)
                (local.get $entry_address)
                (local.get $first_operand)))
            (if (i32.eq (local.get $placed) (i32.const -1))
              (then
                (local.set $result_status
                  (global.get $STATUS_CORRUPT_PROGRAM))
                (br $exit)))
            (local.set $stack_count (local.get $placed))
            (br $step)))
        (if (i32.eq (local.get $opcode) (global.get $OPCODE_SAVE))
          (then
            (if
              (i32.ge_u
                (local.get $first_operand)
                (i32.add
                  (i32.mul
                    (i32.add
                      (local.get $capture_group_count)
                      (i32.const 1))
                    (i32.const 2))
                  (local.get $guard_slots)))
              (then
                (local.set $result_status
                  (global.get $STATUS_CORRUPT_PROGRAM))
                (br $exit)))
            (local.set $placed
              (call $place_thread
                (local.get $stack_base)
                (local.get $stack_count)
                (local.get $instruction_count)
                (local.get $thread_bytes)
                (local.get $entry_address)
                (local.get $second_operand)))
            (if (i32.eq (local.get $placed) (i32.const -1))
              (then
                (local.set $result_status
                  (global.get $STATUS_CORRUPT_PROGRAM))
                (br $exit)))
            (i32.store
              (i32.add
                (i32.add
                  (i32.add
                    (local.get $stack_base)
                    (i32.mul
                      (local.get $stack_count)
                      (local.get $thread_bytes)))
                  (global.get $THREAD_HEADER_SIZE))
                (i32.mul (local.get $first_operand) (i32.const 4)))
              (local.get $byte_position))
            (local.set $stack_count (local.get $placed))
            (br $step)))
        (if (i32.eq (local.get $opcode) (global.get $OPCODE_GUARD))
          (then
            ;; Kill the thread when its recorded guard position equals the
            ;; current position: this optional iteration consumed nothing.
            (if
              (i32.or
                (i32.lt_u
                  (local.get $first_operand)
                  (i32.mul
                    (i32.add
                      (local.get $capture_group_count)
                      (i32.const 1))
                    (i32.const 2)))
                (i32.ge_u
                  (local.get $first_operand)
                  (i32.add
                    (i32.mul
                      (i32.add
                        (local.get $capture_group_count)
                        (i32.const 1))
                      (i32.const 2))
                    (local.get $guard_slots))))
              (then
                (local.set $result_status
                  (global.get $STATUS_CORRUPT_PROGRAM))
                (br $exit)))
            (if
              (i32.eq
                (i32.load
                  (i32.add
                    (i32.add
                      (local.get $entry_address)
                      (global.get $THREAD_HEADER_SIZE))
                    (i32.mul (local.get $first_operand) (i32.const 4))))
                (local.get $byte_position))
              (then (br $step)))
            (local.set $placed
              (call $place_thread
                (local.get $stack_base)
                (local.get $stack_count)
                (local.get $instruction_count)
                (local.get $thread_bytes)
                (local.get $entry_address)
                (local.get $second_operand)))
            (if (i32.eq (local.get $placed) (i32.const -1))
              (then
                (local.set $result_status
                  (global.get $STATUS_CORRUPT_PROGRAM))
                (br $exit)))
            (local.set $stack_count (local.get $placed))
            (br $step)))
        (if (i32.eq (local.get $opcode) (global.get $OPCODE_ASSERT_START))
          (then
            (if
              (i32.or
                (i32.eqz (local.get $byte_position))
                (i32.and
                  (local.get $multiline)
                  (call $line_terminator (local.get $previous_scalar))))
              (then
                (local.set $placed
                  (call $place_thread
                    (local.get $stack_base)
                    (local.get $stack_count)
                    (local.get $instruction_count)
                    (local.get $thread_bytes)
                    (local.get $entry_address)
                    (local.get $first_operand)))
                (if (i32.eq (local.get $placed) (i32.const -1))
                  (then
                    (local.set $result_status
                      (global.get $STATUS_CORRUPT_PROGRAM))
                    (br $exit)))
                (local.set $stack_count (local.get $placed))))
            (br $step)))
        (if (i32.eq (local.get $opcode) (global.get $OPCODE_ASSERT_END))
          (then
            (if
              (i32.or
                (i32.eq
                  (local.get $byte_position)
                  (local.get $input_bytes))
                (i32.and
                  (local.get $multiline)
                  (call $line_terminator (local.get $decoded_scalar))))
              (then
                (local.set $placed
                  (call $place_thread
                    (local.get $stack_base)
                    (local.get $stack_count)
                    (local.get $instruction_count)
                    (local.get $thread_bytes)
                    (local.get $entry_address)
                    (local.get $first_operand)))
                (if (i32.eq (local.get $placed) (i32.const -1))
                  (then
                    (local.set $result_status
                      (global.get $STATUS_CORRUPT_PROGRAM))
                    (br $exit)))
                (local.set $stack_count (local.get $placed))))
            (br $step)))
        (if (i32.eq (local.get $opcode) (global.get $OPCODE_CLEAR_CAPTURES))
          (then
            ;; Reset the contained capture slots before re-entering a
            ;; quantified body, so each iteration starts unset.
            (if
              (i32.or
                (i32.or
                  (i32.lt_u (local.get $first_operand) (i32.const 2))
                  (i32.eqz (local.get $second_operand)))
                (i32.gt_u
                  (i32.add
                    (local.get $first_operand)
                    (local.get $second_operand))
                  (i32.mul
                    (i32.add
                      (local.get $capture_group_count)
                      (i32.const 1))
                    (i32.const 2))))
              (then
                (local.set $result_status
                  (global.get $STATUS_CORRUPT_PROGRAM))
                (br $exit)))
            (local.set $placed
              (call $place_thread
                (local.get $stack_base)
                (local.get $stack_count)
                (local.get $instruction_count)
                (local.get $thread_bytes)
                (local.get $entry_address)
                (local.get $third_operand)))
            (if (i32.eq (local.get $placed) (i32.const -1))
              (then
                (local.set $result_status
                  (global.get $STATUS_CORRUPT_PROGRAM))
                (br $exit)))
            (call $work_fill
              (i32.add
                (i32.add
                  (i32.add
                    (local.get $stack_base)
                    (i32.mul
                      (local.get $stack_count)
                      (local.get $thread_bytes)))
                  (global.get $THREAD_HEADER_SIZE))
                (i32.mul (local.get $first_operand) (i32.const 4)))
              (i32.const 0xff)
              (i32.mul (local.get $second_operand) (i32.const 4)))
            (local.set $stack_count (local.get $placed))
            (br $step)))
        (if (i32.eq (local.get $opcode) (global.get $OPCODE_MATCH))
          (then
            ;; Record the candidate and cut every lower-priority pending
            ;; record. Surviving next-list threads are all higher priority
            ;; and may still replace this candidate at a later position.
            (call $work_copy
              (local.get $candidate_address)
              (i32.add
                (local.get $entry_address)
                (global.get $THREAD_HEADER_SIZE))
              (local.get $capture_bytes))
            (local.set $matched (i32.const 1))
            (local.set $match_end_byte (local.get $byte_position))
            (local.set $match_end_scalar (local.get $scalar_position))
            (local.set $stack_count (i32.const 0))
            (local.set $cursor (local.get $current_count))
            (br $step)))
        (local.set $result_status (global.get $STATUS_CORRUPT_PROGRAM))
        (br $exit)))
    (i32.store offset=28
      (local.get $continuation_address)
      (local.get $byte_position))
    (i32.store offset=32
      (local.get $continuation_address)
      (local.get $scalar_position))
    (i32.store offset=36
      (local.get $continuation_address)
      (local.get $previous_scalar))
    (i32.store offset=40 (local.get $continuation_address) (local.get $phase))
    (i32.store offset=44 (local.get $continuation_address) (local.get $parity))
    (i32.store offset=48
      (local.get $continuation_address)
      (local.get $current_count))
    (i32.store offset=52 (local.get $continuation_address) (local.get $cursor))
    (i32.store offset=56
      (local.get $continuation_address)
      (local.get $stack_count))
    (i32.store offset=60
      (local.get $continuation_address)
      (local.get $next_count))
    (i32.store offset=64
      (local.get $continuation_address)
      (local.get $matched))
    (i32.store offset=68
      (local.get $continuation_address)
      (local.get $match_end_byte))
    (i32.store offset=72
      (local.get $continuation_address)
      (local.get $match_end_scalar))
    (i32.store offset=76
      (local.get $continuation_address)
      (local.get $decoded_scalar))
    (i32.store offset=80
      (local.get $continuation_address)
      (local.get $next_byte_position))
    (return (local.get $result_status) (local.get $fuel)))

  (func (export "max_pattern_bytes") (result i32) (global.get $MAX_PATTERN_BYTES))
  (func (export "max_bytecode_instructions") (result i32) (global.get $MAX_BYTECODE_INSTRUCTIONS))
  (func (export "max_capture_groups") (result i32) (global.get $MAX_CAPTURE_GROUPS))
  (func (export "max_character_class_ranges") (result i32) (global.get $MAX_CHARACTER_CLASS_RANGES))
  (func (export "format_version") (result i32) (global.get $FORMAT_VERSION))

  ;; In-flight state is v2; portable PROGRAM remains v1. Work records append
  ;; [u64 total, i32 sticky overflow, i32 reserved, u64 scheduling debt].
  ;; Transient globals are restored at each public entry; no import re-enters
  ;; this module. Nested measurement helpers charge their enclosing scan.
  (global $STATE_VERSION i32 (i32.const 2))
  (global $work_active (mut i32) (i32.const 0))
  (global $work_total (mut i64) (i64.const 0))
  (global $work_overflow (mut i32) (i32.const 0))
  (global $work_pending (mut i64) (i64.const 0))
  (global $work_spend (mut i32) (i32.const 0))
  (func $work_header_ok (param $p i32) (param $capacity i32) (param $size i32) (result i32)
    (i32.and (i32.ge_u (local.get $capacity) (local.get $size))
      (i64.le_u (i64.add (i64.extend_i32_u (local.get $p)) (i64.extend_i32_u (local.get $size)))
        (i64.shl (i64.extend_i32_u (memory.size)) (i64.const 16)))))
  (func $work_overlaps (param $a i32) (param $an i32) (param $b i32) (param $bn i32) (result i32)
    (i32.and (i32.and (i32.ne (local.get $an) (i32.const 0)) (i32.ne (local.get $bn) (i32.const 0)))
      (i32.and
        (i64.lt_u (i64.extend_i32_u (local.get $a)) (i64.add (i64.extend_i32_u (local.get $b)) (i64.extend_i32_u (local.get $bn))))
        (i64.lt_u (i64.extend_i32_u (local.get $b)) (i64.add (i64.extend_i32_u (local.get $a)) (i64.extend_i32_u (local.get $an)))))))
  (func $work_begin (param $meter i32) (param $initialize i32) (param $spend i32)
    (global.set $work_total (i64.const 0))
    (global.set $work_overflow (i32.const 0))
    (global.set $work_pending (i64.const 0))
    (global.set $work_spend (local.get $spend))
    (if (i32.eqz (local.get $initialize))
      (then
        (global.set $work_total (i64.load (local.get $meter)))
        (global.set $work_overflow (i32.load offset=8 (local.get $meter)))
        (if (global.get $work_overflow) (then (global.set $work_total (i64.const -1))))
        (global.set $work_pending (i64.load offset=16 (local.get $meter)))
        (if (i64.gt_u (global.get $work_pending) (i64.const 0x100000000))
          (then (global.set $work_pending (i64.const 0x100000000))))))
    (global.set $work_active (i32.const 1)))
  (func $work_add (param $n i32)
    (local $sum i64)
    (if (i32.eqz (global.get $work_active)) (then (return)))
    (local.set $sum (i64.add (global.get $work_total) (i64.extend_i32_u (local.get $n))))
    (if (i64.lt_u (local.get $sum) (global.get $work_total))
      (then (global.set $work_overflow (i32.const 1))))
    (global.set $work_total (select (i64.const -1) (local.get $sum) (global.get $work_overflow)))
    (local.set $sum (i64.add (global.get $work_pending) (i64.extend_i32_u (local.get $n))))
    (global.set $work_pending (select (i64.const 0x100000000) (local.get $sum)
      (i64.gt_u (local.get $sum) (i64.const 0x100000000)))))
  (func $work_take (param $fuel i32) (result i32)
    (local $remaining i64)
    ;; A nonpositive grant cannot consume initialization debt. A positive
    ;; step can overrun atomically; debt is spent once, never retried as setup.
    (if (i32.eqz (global.get $work_spend)) (then (return (local.get $fuel))))
    (local.set $remaining (i64.sub (i64.extend_i32_s (local.get $fuel)) (global.get $work_pending)))
    (global.set $work_pending (i64.const 0))
    (if (i64.lt_s (local.get $remaining) (i64.const -2147483648))
      (then (return (i32.const -2147483648))))
    (i32.wrap_i64 (local.get $remaining)))
  (func $work_end (param $meter i32)
    (i64.store (local.get $meter) (global.get $work_total))
    (i32.store offset=8 (local.get $meter) (global.get $work_overflow))
    (i32.store offset=12 (local.get $meter) (i32.const 0))
    (i64.store offset=16 (local.get $meter) (global.get $work_pending))
    (global.set $work_active (i32.const 0)))
  ;; Examined UTF-8/name bytes, intrinsic loop iterations, and 16-byte bulk
  ;; blocks are additive work units. Control/scalar/thread steps retain one
  ;; unit each. Fixed setup writes are charged in their source functions.
  (func $work_byte (param $address i32) (result i32)
    (call $work_add (i32.const 1))
    (i32.load8_u (local.get $address)))
  (func $work_bulk (param $bytes i32) (result i32)
    (i32.add (i32.shr_u (local.get $bytes) (i32.const 4))
      (i32.ne (i32.and (local.get $bytes) (i32.const 15)) (i32.const 0))))
  (func $work_copy (param $dst i32) (param $src i32) (param $bytes i32)
    (call $work_add (call $work_bulk (local.get $bytes)))
    (memory.copy (local.get $dst) (local.get $src) (local.get $bytes)))
  (func $work_fill (param $dst i32) (param $value i32) (param $bytes i32)
    (call $work_add (call $work_bulk (local.get $bytes)))
    (memory.fill (local.get $dst) (local.get $value) (local.get $bytes)))
  (func (export "measurement_work_charged") (param $state i32) (result i64)
    (i64.load offset=32 (local.get $state)))
  (func (export "measurement_work_overflow") (param $state i32) (result i32)
    (i32.load offset=40 (local.get $state)))
  (func (export "scan_work_charged") (param $state i32) (result i64)
    (i64.load offset=104 (local.get $state)))
  (func (export "scan_work_overflow") (param $state i32) (result i32)
    (i32.load offset=112 (local.get $state)))
  (func (export "emission_work_charged") (param $state i32) (result i64)
    (i64.load offset=136 (local.get $state)))
  (func (export "emission_work_overflow") (param $state i32) (result i32)
    (i32.load offset=144 (local.get $state)))
  (func (export "match_work_charged") (param $state i32) (result i64)
    (i64.load offset=104 (local.get $state)))
  (func (export "match_work_overflow") (param $state i32) (result i32)
    (i32.load offset=112 (local.get $state)))
  ;; Stateless check: same validator, exact unsigned charge, no fake workspace.
  (func (export "validate_program_work") (param $program i32) (param $capacity i32) (result i32 i64 i32)
    (local $status i32)
    (call $work_begin (i32.const 0) (i32.const 1) (i32.const 0))
    (local.set $status (call $validate_program (local.get $program) (local.get $capacity)))
    (global.set $work_active (i32.const 0))
    (local.get $status) (global.get $work_total) (global.get $work_overflow))

  (func $initialize_measurement_workspace (export "initialize_measurement_workspace")
    (param $workspace_address i32)
    (param $workspace_capacity i32)
    (param $pattern_bytes i32)
    (param $root_instruction_count i32)
    (result i32)
    (local $status i32)
    (if (global.get $work_active) (then (return (call $initialize_measurement_workspace_impl (local.get $workspace_address) (local.get $workspace_capacity) (local.get $pattern_bytes) (local.get $root_instruction_count)))))
    (if (i32.eqz (call $work_header_ok (local.get $workspace_address) (local.get $workspace_capacity) (i32.const 56)))
      (then (return (global.get $STATUS_BUFFER_TOO_SMALL))))
    (call $work_begin (i32.add (local.get $workspace_address) (i32.const 32)) (i32.const 1) (i32.const 0))
    (i32.store (local.get $workspace_address) (i32.const 0))
    (call $initialize_measurement_workspace_impl (local.get $workspace_address) (local.get $workspace_capacity) (local.get $pattern_bytes) (local.get $root_instruction_count))
    (local.set $status)
    (call $work_end (i32.add (local.get $workspace_address) (i32.const 32)))
    (local.get $status))

  (func $measurement_push_group (export "measurement_push_group")
    (param $workspace_address i32)
    (param $workspace_capacity i32)
    (param $pattern_bytes i32)
    (param $capture_group_count i32)
    (result i32)
    (local $status i32)
    (if (global.get $work_active) (then (return (call $measurement_push_group_impl (local.get $workspace_address) (local.get $workspace_capacity) (local.get $pattern_bytes) (local.get $capture_group_count)))))
    (if (i32.eqz (call $work_header_ok (local.get $workspace_address) (local.get $workspace_capacity) (i32.const 56)))
      (then (return (global.get $STATUS_BUFFER_TOO_SMALL))))
    (if (i32.or (i32.ne (i32.load (local.get $workspace_address)) (global.get $MEASUREMENT_MAGIC))
                (i32.ne (i32.load offset=4 (local.get $workspace_address)) (global.get $STATE_VERSION)))
      (then (return (global.get $STATUS_CORRUPT_PROGRAM))))
    (call $work_begin (i32.add (local.get $workspace_address) (i32.const 32)) (i32.const 0) (i32.const 0))
    (call $measurement_push_group_impl (local.get $workspace_address) (local.get $workspace_capacity) (local.get $pattern_bytes) (local.get $capture_group_count))
    (local.set $status)
    (call $work_end (i32.add (local.get $workspace_address) (i32.const 32)))
    (local.get $status))

  (func $measurement_pop_group (export "measurement_pop_group")
    (param $workspace_address i32)
    (param $workspace_capacity i32)
    (param $pattern_bytes i32)
    (param $capture_group_count i32)
    (result i32 i32)
    (local $status i32)
    (local $count i32)
    (if (global.get $work_active) (then (return (call $measurement_pop_group_impl (local.get $workspace_address) (local.get $workspace_capacity) (local.get $pattern_bytes) (local.get $capture_group_count)))))
    (if (i32.eqz (call $work_header_ok (local.get $workspace_address) (local.get $workspace_capacity) (i32.const 56)))
      (then (return (global.get $STATUS_BUFFER_TOO_SMALL) (i32.const 0))))
    (if (i32.or (i32.ne (i32.load (local.get $workspace_address)) (global.get $MEASUREMENT_MAGIC))
                (i32.ne (i32.load offset=4 (local.get $workspace_address)) (global.get $STATE_VERSION)))
      (then (return (global.get $STATUS_CORRUPT_PROGRAM) (i32.const 0))))
    (call $work_begin (i32.add (local.get $workspace_address) (i32.const 32)) (i32.const 0) (i32.const 0))
    (call $measurement_pop_group_impl (local.get $workspace_address) (local.get $workspace_capacity) (local.get $pattern_bytes) (local.get $capture_group_count))
    (local.set $count)
    (local.set $status)
    (call $work_end (i32.add (local.get $workspace_address) (i32.const 32)))
    (local.get $status) (local.get $count))

  (func $measurement_add_atom (export "measurement_add_atom")
    (param $workspace_address i32)
    (param $workspace_capacity i32)
    (param $pattern_bytes i32)
    (param $atom_instruction_count i32)
    (result i32)
    (local $status i32)
    (if (global.get $work_active) (then (return (call $measurement_add_atom_impl (local.get $workspace_address) (local.get $workspace_capacity) (local.get $pattern_bytes) (local.get $atom_instruction_count)))))
    (if (i32.eqz (call $work_header_ok (local.get $workspace_address) (local.get $workspace_capacity) (i32.const 56)))
      (then (return (global.get $STATUS_BUFFER_TOO_SMALL))))
    (if (i32.or (i32.ne (i32.load (local.get $workspace_address)) (global.get $MEASUREMENT_MAGIC))
                (i32.ne (i32.load offset=4 (local.get $workspace_address)) (global.get $STATE_VERSION)))
      (then (return (global.get $STATUS_CORRUPT_PROGRAM))))
    (call $work_begin (i32.add (local.get $workspace_address) (i32.const 32)) (i32.const 0) (i32.const 0))
    (call $measurement_add_atom_impl (local.get $workspace_address) (local.get $workspace_capacity) (local.get $pattern_bytes) (local.get $atom_instruction_count))
    (local.set $status)
    (call $work_end (i32.add (local.get $workspace_address) (i32.const 32)))
    (local.get $status))

  (func $measurement_apply_last_quantifier (export "measurement_apply_last_quantifier")
    (param $workspace_address i32)
    (param $workspace_capacity i32)
    (param $pattern_bytes i32)
    (param $minimum i32)
    (param $maximum i32)
    (result i32)
    (local $status i32)
    (if (global.get $work_active) (then (return (call $measurement_apply_last_quantifier_impl (local.get $workspace_address) (local.get $workspace_capacity) (local.get $pattern_bytes) (local.get $minimum) (local.get $maximum)))))
    (if (i32.eqz (call $work_header_ok (local.get $workspace_address) (local.get $workspace_capacity) (i32.const 56)))
      (then (return (global.get $STATUS_BUFFER_TOO_SMALL))))
    (if (i32.or (i32.ne (i32.load (local.get $workspace_address)) (global.get $MEASUREMENT_MAGIC))
                (i32.ne (i32.load offset=4 (local.get $workspace_address)) (global.get $STATE_VERSION)))
      (then (return (global.get $STATUS_CORRUPT_PROGRAM))))
    (call $work_begin (i32.add (local.get $workspace_address) (i32.const 32)) (i32.const 0) (i32.const 0))
    (call $measurement_apply_last_quantifier_impl (local.get $workspace_address) (local.get $workspace_capacity) (local.get $pattern_bytes) (local.get $minimum) (local.get $maximum))
    (local.set $status)
    (call $work_end (i32.add (local.get $workspace_address) (i32.const 32)))
    (local.get $status))

  (func $scan_pattern (export "scan_pattern")
    (param $pattern_address i32)
    (param $pattern_bytes i32)
    (param $workspace_address i32)
    (param $workspace_capacity i32)
    (param $initialize i32)
    (param $fuel i32)
    (result i32 i32)
    (local $status i32)
    (if (global.get $work_active) (then (return (call $scan_pattern_impl (local.get $pattern_address) (local.get $pattern_bytes) (local.get $workspace_address) (local.get $workspace_capacity) (local.get $initialize) (local.get $fuel)))))
    ;; Preserve syntax/size refusal precedence before the header-capacity gate.
    (if (i32.gt_u (local.get $initialize) (i32.const 1))
      (then (return (global.get $STATUS_CORRUPT_PROGRAM) (local.get $fuel))))
    (if (i32.gt_u (local.get $pattern_bytes) (global.get $MAX_PATTERN_BYTES))
      (then (return (global.get $STATUS_LIMIT_EXCEEDED) (local.get $fuel))))
    (if (i32.eqz (call $work_header_ok (local.get $workspace_address) (local.get $workspace_capacity) (i32.const 128)))
      (then (return (global.get $STATUS_BUFFER_TOO_SMALL) (local.get $fuel))))
    (if (i32.eqz (local.get $initialize))
      (then (if (i32.or (i32.ne (i32.load (local.get $workspace_address)) (global.get $SCAN_MAGIC))
                         (i32.ne (i32.load offset=4 (local.get $workspace_address)) (global.get $STATE_VERSION)))
        (then (return (global.get $STATUS_CORRUPT_PROGRAM) (local.get $fuel))))))
    (if (call $work_overlaps (local.get $workspace_address) (i32.const 128) (local.get $pattern_address) (local.get $pattern_bytes))
      (then (return (global.get $STATUS_CORRUPT_PROGRAM) (local.get $fuel))))
    (call $work_begin (i32.add (local.get $workspace_address) (i32.const 104)) (local.get $initialize) (i32.gt_s (local.get $fuel) (i32.const 0)))
    (if (local.get $initialize) (then (i32.store (local.get $workspace_address) (i32.const 0))))
    (call $scan_pattern_impl (local.get $pattern_address) (local.get $pattern_bytes) (local.get $workspace_address) (local.get $workspace_capacity) (local.get $initialize) (local.get $fuel))
    (local.set $fuel)
    (local.set $status)
    (local.set $fuel (call $work_take (local.get $fuel)))
    (call $work_end (i32.add (local.get $workspace_address) (i32.const 104)))
    (local.get $status) (local.get $fuel))

  (func $initialize_program_emission (export "initialize_program_emission")
    (param $workspace_address i32)
    (param $workspace_capacity i32)
    (param $pattern_bytes i32)
    (param $program_address i32)
    (param $program_capacity i32)
    (param $flags i32)
    (result i32)
    (local $status i32)
    (if (global.get $work_active) (then (return (call $initialize_program_emission_impl (local.get $workspace_address) (local.get $workspace_capacity) (local.get $pattern_bytes) (local.get $program_address) (local.get $program_capacity) (local.get $flags)))))
    (if (i32.eqz (call $work_header_ok (local.get $workspace_address) (local.get $workspace_capacity) (i32.const 128)))
      (then (return (global.get $STATUS_BUFFER_TOO_SMALL))))
    (if (i32.or (i32.ne (i32.load (local.get $workspace_address)) (global.get $SCAN_MAGIC))
                (i32.ne (i32.load offset=4 (local.get $workspace_address)) (global.get $STATE_VERSION)))
      (then (return (global.get $STATUS_CORRUPT_PROGRAM))))
    (call $work_begin (i32.add (local.get $workspace_address) (i32.const 104)) (i32.const 0) (i32.const 0))
    (call $initialize_program_emission_impl (local.get $workspace_address) (local.get $workspace_capacity) (local.get $pattern_bytes) (local.get $program_address) (local.get $program_capacity) (local.get $flags))
    (local.set $status)
    (call $work_end (i32.add (local.get $workspace_address) (i32.const 104)))
    (local.get $status))

  (func $initialize_emission_workspace (export "initialize_emission_workspace")
    (param $scan_address i32)
    (param $scan_capacity i32)
    (param $pattern_bytes i32)
    (param $program_address i32)
    (param $program_capacity i32)
    (param $emission_address i32)
    (param $emission_capacity i32)
    (result i32)
    (local $status i32)
    (local $pending i64)
    (if (global.get $work_active) (then (return (call $initialize_emission_workspace_impl (local.get $scan_address) (local.get $scan_capacity) (local.get $pattern_bytes) (local.get $program_address) (local.get $program_capacity) (local.get $emission_address) (local.get $emission_capacity)))))
    (if (i32.eqz (call $work_header_ok (local.get $emission_address) (local.get $emission_capacity) (i32.const 160)))
      (then (return (global.get $STATUS_BUFFER_TOO_SMALL))))
    (if (call $work_overlaps (local.get $emission_address) (i32.const 160) (local.get $scan_address) (local.get $scan_capacity))
      (then (return (global.get $STATUS_CORRUPT_PROGRAM))))
    (if (call $work_overlaps (local.get $emission_address) (i32.const 160) (local.get $program_address) (local.get $program_capacity))
      (then (return (global.get $STATUS_CORRUPT_PROGRAM))))
    (if (call $work_header_ok (local.get $scan_address) (local.get $scan_capacity) (i32.const 128))
      (then (if (call $work_overlaps (local.get $emission_address) (i32.const 160) (i32.load offset=8 (local.get $scan_address)) (local.get $pattern_bytes))
        (then (return (global.get $STATUS_CORRUPT_PROGRAM))))))
    (call $work_begin (i32.add (local.get $emission_address) (i32.const 136)) (i32.const 1) (i32.const 0))
    (i32.store (local.get $emission_address) (i32.const 0))
    (call $initialize_emission_workspace_impl (local.get $scan_address) (local.get $scan_capacity) (local.get $pattern_bytes) (local.get $program_address) (local.get $program_capacity) (local.get $emission_address) (local.get $emission_capacity))
    (local.set $status)
    (if (i32.eq (local.get $status) (global.get $STATUS_OK))
      (then
        ;; Program-header initialization belongs to the scan's exact total,
        ;; but its outstanding scheduling debt follows execution into emit.
        ;; Move debt once without charging that source work a second time.
        (local.set $pending (i64.load offset=120 (local.get $scan_address)))
        (if (i64.gt_u (local.get $pending) (i64.const 0x100000000))
          (then (local.set $pending (i64.const 0x100000000))))
        (local.set $pending (i64.add (local.get $pending) (global.get $work_pending)))
        (global.set $work_pending (select (i64.const 0x100000000) (local.get $pending)
          (i64.gt_u (local.get $pending) (i64.const 0x100000000))))
        (i64.store offset=120 (local.get $scan_address) (i64.const 0))))
    (call $work_end (i32.add (local.get $emission_address) (i32.const 136)))
    (local.get $status))

  (func $emit_pattern (export "emit_pattern")
    (param $emission_address i32)
    (param $emission_capacity i32)
    (param $fuel i32)
    (result i32 i32)
    (local $status i32)
    (if (global.get $work_active) (then (return (call $emit_pattern_impl (local.get $emission_address) (local.get $emission_capacity) (local.get $fuel)))))
    (if (i32.eqz (call $work_header_ok (local.get $emission_address) (local.get $emission_capacity) (i32.const 160)))
      (then (return (global.get $STATUS_BUFFER_TOO_SMALL) (local.get $fuel))))
    (if (i32.or (i32.ne (i32.load (local.get $emission_address)) (global.get $EMIT_MAGIC))
                (i32.ne (i32.load offset=4 (local.get $emission_address)) (global.get $STATE_VERSION)))
      (then (return (global.get $STATUS_CORRUPT_PROGRAM) (local.get $fuel))))
    (call $work_begin (i32.add (local.get $emission_address) (i32.const 136)) (i32.const 0) (i32.gt_s (local.get $fuel) (i32.const 0)))
    (call $emit_pattern_impl (local.get $emission_address) (local.get $emission_capacity) (local.get $fuel))
    (local.set $fuel)
    (local.set $status)
    (local.set $fuel (call $work_take (local.get $fuel)))
    (call $work_end (i32.add (local.get $emission_address) (i32.const 136)))
    (local.get $status) (local.get $fuel))

  (func $initialize_match (export "initialize_match")
    (param $program_address i32)
    (param $program_capacity i32)
    (param $input_address i32)
    (param $input_bytes i32)
    (param $start_byte i32)
    (param $start_scalar i32)
    (param $continuation_address i32)
    (param $continuation_capacity i32)
    (result i32)
    (local $status i32)
    (if (global.get $work_active) (then (return (call $initialize_match_impl (local.get $program_address) (local.get $program_capacity) (local.get $input_address) (local.get $input_bytes) (local.get $start_byte) (local.get $start_scalar) (local.get $continuation_address) (local.get $continuation_capacity)))))
    (if (i32.eqz (call $work_header_ok (local.get $continuation_address) (local.get $continuation_capacity) (i32.const 128)))
      (then (return (global.get $STATUS_BUFFER_TOO_SMALL))))
    (if (call $work_overlaps (local.get $continuation_address) (i32.const 128) (local.get $program_address) (local.get $program_capacity))
      (then (return (global.get $STATUS_CORRUPT_PROGRAM))))
    (if (call $work_overlaps (local.get $continuation_address) (i32.const 128) (local.get $input_address) (local.get $input_bytes))
      (then (return (global.get $STATUS_CORRUPT_PROGRAM))))
    (call $work_begin (i32.add (local.get $continuation_address) (i32.const 104)) (i32.const 1) (i32.const 0))
    (i32.store (local.get $continuation_address) (i32.const 0))
    (call $initialize_match_impl (local.get $program_address) (local.get $program_capacity) (local.get $input_address) (local.get $input_bytes) (local.get $start_byte) (local.get $start_scalar) (local.get $continuation_address) (local.get $continuation_capacity))
    (local.set $status)
    (call $work_end (i32.add (local.get $continuation_address) (i32.const 104)))
    (local.get $status))

  (func $run_match (export "run_match")
    (param $continuation_address i32)
    (param $continuation_capacity i32)
    (param $fuel i32)
    (result i32 i32)
    (local $status i32)
    (if (global.get $work_active) (then (return (call $run_match_impl (local.get $continuation_address) (local.get $continuation_capacity) (local.get $fuel)))))
    (if (i32.eqz (call $work_header_ok (local.get $continuation_address) (local.get $continuation_capacity) (i32.const 128)))
      (then (return (global.get $STATUS_BUFFER_TOO_SMALL) (local.get $fuel))))
    (if (i32.or (i32.ne (i32.load (local.get $continuation_address)) (global.get $CONTINUATION_MAGIC))
                (i32.ne (i32.load offset=4 (local.get $continuation_address)) (global.get $STATE_VERSION)))
      (then (return (global.get $STATUS_CORRUPT_PROGRAM) (local.get $fuel))))
    (call $work_begin (i32.add (local.get $continuation_address) (i32.const 104)) (i32.const 0) (i32.gt_s (local.get $fuel) (i32.const 0)))
    (call $run_match_impl (local.get $continuation_address) (local.get $continuation_capacity) (local.get $fuel))
    (local.set $fuel)
    (local.set $status)
    (local.set $fuel (call $work_take (local.get $fuel)))
    (call $work_end (i32.add (local.get $continuation_address) (i32.const 104)))
    (local.get $status) (local.get $fuel))
)

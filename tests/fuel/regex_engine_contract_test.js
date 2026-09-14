import { assertEquals } from "https://deno.land/std@0.208.0/assert/mod.ts";
import {
  REGEX_COMPILER,
  REGEX_CONTINUATION,
  REGEX_FLAG,
  REGEX_LIMIT,
  REGEX_OPCODE,
  REGEX_PROGRAM,
  REGEX_STATUS,
} from "../../src/fuel/regex-engine-contract.js";
import { instantiateRegexSync } from "../../src/fuel/regex-engine.wasm.js";

function engine() {
  const memory = new WebAssembly.Memory({
    initial: 4,
    maximum: 32,
    shared: true,
  });
  return instantiateRegexSync(memory).exports;
}

function scanPattern(pattern, fuel) {
  const memory = new WebAssembly.Memory({
    initial: 1,
    maximum: 32,
    shared: true,
  });
  const exports = instantiateRegexSync(memory).exports;
  const patternAddress = 256;
  const workspaceAddress = 2048;
  const encodedPattern = new TextEncoder().encode(pattern);
  new Uint8Array(memory.buffer).set(encodedPattern, patternAddress);
  let initialize = 1;
  let status;
  do {
    let fuelRemaining;
    [status, fuelRemaining] = exports.scan_pattern(
      patternAddress,
      encodedPattern.length,
      workspaceAddress,
      exports.scan_workspace_size(encodedPattern.length),
      initialize,
      fuel,
    );
    initialize = 0;
  } while (status === REGEX_STATUS.PAUSED);
  const words = new Uint32Array(memory.buffer);
  const workspaceWord = workspaceAddress / 4;
  const measurementWord = workspaceWord + REGEX_COMPILER.SCAN_HEADER_SIZE / 4;
  return {
    status,
    totalFuel: BigInt.asUintN(64, exports.scan_work_charged(workspaceAddress)),
    programBytes: exports.measured_program_size(
      workspaceAddress,
      exports.scan_workspace_size(encodedPattern.length),
      encodedPattern.length,
    ),
    instructionCount: words[
      measurementWord +
      REGEX_COMPILER.MEASUREMENT.INSTRUCTION_COUNT / 4
    ],
    lastAtomInstructionCount: words[
      measurementWord +
      REGEX_COMPILER.MEASUREMENT.LAST_ATOM_INSTRUCTION_COUNT / 4
    ],
    captureGroupCount:
      words[workspaceWord + REGEX_COMPILER.SCAN.CAPTURE_GROUP_COUNT / 4],
    groupDepth: words[workspaceWord + REGEX_COMPILER.SCAN.GROUP_DEPTH / 4],
    mode: words[workspaceWord + REGEX_COMPILER.SCAN.MODE / 4],
    quantifierMinimum:
      words[workspaceWord + REGEX_COMPILER.SCAN.QUANTIFIER_MINIMUM / 4],
    quantifierMaximum:
      words[workspaceWord + REGEX_COMPILER.SCAN.QUANTIFIER_MAXIMUM / 4],
    namedCaptureCount:
      words[workspaceWord + REGEX_COMPILER.SCAN.NAMED_CAPTURE_COUNT / 4],
    nameBytes: words[workspaceWord + REGEX_COMPILER.SCAN.NAME_BYTES / 4],
    classNegated: words[workspaceWord + REGEX_COMPILER.SCAN.CLASS_NEGATED / 4],
    rangeCount: words[workspaceWord + REGEX_COMPILER.SCAN.RANGE_COUNT / 4],
  };
}

function emitLinearPattern(
  pattern,
  fuel,
  resume = true,
  includeContinuation = false,
) {
  const memory = new WebAssembly.Memory({
    initial: 1,
    maximum: 32,
    shared: true,
  });
  const exports = instantiateRegexSync(memory).exports;
  const patternAddress = 256;
  const scanAddress = 2048;
  const programAddress = 8192;
  const emissionAddress = 16384;
  const encodedPattern = new TextEncoder().encode(pattern);
  new Uint8Array(memory.buffer).set(encodedPattern, patternAddress);
  assertEquals(
    exports.scan_pattern(
      patternAddress,
      encodedPattern.length,
      scanAddress,
      exports.scan_workspace_size(encodedPattern.length),
      1,
      0xffff,
    )[0],
    REGEX_STATUS.OK,
  );
  const programBytes = exports.measured_program_size(
    scanAddress,
    exports.scan_workspace_size(encodedPattern.length),
    encodedPattern.length,
  );
  assertEquals(
    exports.initialize_program_emission(
      scanAddress,
      exports.scan_workspace_size(encodedPattern.length),
      encodedPattern.length,
      programAddress,
      programBytes,
      0,
    ),
    REGEX_STATUS.OK,
  );
  const emissionBytes = exports.emission_workspace_size(encodedPattern.length);
  assertEquals(
    exports.initialize_emission_workspace(
      scanAddress,
      exports.scan_workspace_size(encodedPattern.length),
      encodedPattern.length,
      programAddress,
      programBytes,
      emissionAddress,
      emissionBytes,
    ),
    REGEX_STATUS.OK,
  );
  let [status, fuelRemaining] = exports.emit_pattern(
    emissionAddress,
    emissionBytes,
    fuel,
  );
  while (resume && status === REGEX_STATUS.PAUSED) {
    [status, fuelRemaining] = exports.emit_pattern(
      emissionAddress,
      emissionBytes,
      fuel,
    );
  }
  const instructionCount = new Uint32Array(memory.buffer)[
    programAddress / 4 + REGEX_PROGRAM.HEADER.INSTRUCTION_COUNT / 4
  ];
  const records = [];
  const words = new Uint32Array(memory.buffer);
  for (let index = 0; index < instructionCount; index++) {
    const instructionWord = (programAddress + REGEX_PROGRAM.HEADER_SIZE) / 4 +
      index * REGEX_PROGRAM.INSTRUCTION_SIZE / 4;
    records.push(
      Array.from(
        words.slice(
          instructionWord,
          instructionWord + REGEX_PROGRAM.INSTRUCTION_SIZE / 4,
        ),
      ),
    );
  }
  const rangeCount =
    words[programAddress / 4 + REGEX_PROGRAM.HEADER.RANGE_COUNT / 4];
  const ranges = [];
  const rangeWord = (programAddress + REGEX_PROGRAM.HEADER_SIZE) / 4 +
    instructionCount * REGEX_PROGRAM.INSTRUCTION_SIZE / 4;
  for (let index = 0; index < rangeCount; index++) {
    ranges.push([
      words[rangeWord + index * 2],
      words[rangeWord + index * 2 + 1],
    ]);
  }
  const nameBytes =
    words[programAddress / 4 + REGEX_PROGRAM.HEADER.NAME_BYTES / 4];
  const names = [];
  const nameByte = programAddress + REGEX_PROGRAM.HEADER_SIZE +
    instructionCount * REGEX_PROGRAM.INSTRUCTION_SIZE +
    rangeCount * 8;
  let nameOffset = 0;
  const dataView = new DataView(memory.buffer);
  while (nameOffset < nameBytes) {
    const captureGroup = dataView.getUint32(nameByte + nameOffset, true);
    const nameLength = dataView.getUint32(nameByte + nameOffset + 4, true);
    names.push([
      captureGroup,
      new TextDecoder().decode(
        new Uint8Array(memory.buffer).slice(
          nameByte + nameOffset + REGEX_COMPILER.NAME_HEADER_SIZE,
          nameByte + nameOffset + REGEX_COMPILER.NAME_HEADER_SIZE + nameLength,
        ),
      ),
    ]);
    nameOffset += REGEX_COMPILER.NAME_HEADER_SIZE + nameLength;
  }
  return {
    status,
    validationStatus: exports.validate_program(programAddress, programBytes),
    records,
    ranges,
    ...(names.length === 0 ? {} : { names }),
    ...(includeContinuation
      ? {
        lastAtom: [
          words[emissionAddress / 4 + REGEX_COMPILER.EMIT.LAST_ATOM_START / 4],
          words[
            emissionAddress / 4 +
            REGEX_COMPILER.EMIT.LAST_ATOM_INSTRUCTION_COUNT / 4
          ],
        ],
      }
      : {}),
  };
}

Deno.test("regex engine contract: hard limits match JavaScript mirror", () => {
  const exports = engine();
  assertEquals(exports.max_pattern_bytes(), REGEX_LIMIT.MAX_PATTERN_BYTES);
  assertEquals(
    exports.max_bytecode_instructions(),
    REGEX_LIMIT.MAX_BYTECODE_INSTRUCTIONS,
  );
  assertEquals(exports.max_capture_groups(), REGEX_LIMIT.MAX_CAPTURE_GROUPS);
  assertEquals(
    exports.max_character_class_ranges(),
    REGEX_LIMIT.MAX_CHARACTER_CLASS_RANGES,
  );
  assertEquals(exports.format_version(), REGEX_PROGRAM.VERSION);
});

Deno.test("regex engine contract: program size includes every bounded region", () => {
  const exports = engine();
  assertEquals(
    exports.program_size(7, 3, 11),
    REGEX_PROGRAM.HEADER_SIZE + 7 * REGEX_PROGRAM.INSTRUCTION_SIZE + 3 * 8 + 11,
  );
  assertEquals(
    exports.program_size(REGEX_LIMIT.MAX_BYTECODE_INSTRUCTIONS + 1, 0, 0),
    -1,
  );
  assertEquals(
    exports.program_size(0, REGEX_LIMIT.MAX_CHARACTER_CLASS_RANGES + 1, 0),
    -1,
  );
});

Deno.test("regex engine contract: sizes quantified Pike fragments exactly", () => {
  const exports = engine();
  const unbounded = 0xffffffff;
  assertEquals(exports.quantified_instruction_count(1, 0, 0, 0), 0);
  assertEquals(exports.quantified_instruction_count(1, 2, 2, 0), 2);
  assertEquals(exports.quantified_instruction_count(1, 2, 4, 0), 10);
  assertEquals(exports.quantified_instruction_count(1, 0, 1, 0), 4);
  assertEquals(exports.quantified_instruction_count(1, 0, unbounded, 0), 2);
  assertEquals(exports.quantified_instruction_count(1, 1, unbounded, 0), 2);
  assertEquals(exports.quantified_instruction_count(1, 3, unbounded, 0), 4);
  assertEquals(exports.quantified_instruction_count(5, 2, 4, 0), 26);
  assertEquals(exports.quantified_instruction_count(5, 3, unbounded, 0), 16);
  // Capturing atoms add one CLEAR per loop-body re-entry, and bounded
  // optional copies each add one guard SAVE and one GUARD.
  assertEquals(exports.quantified_instruction_count(3, 0, 0, 1), 0);
  assertEquals(exports.quantified_instruction_count(3, 0, 1, 1), 6);
  assertEquals(exports.quantified_instruction_count(3, 1, 1, 1), 3);
  assertEquals(exports.quantified_instruction_count(3, 0, unbounded, 1), 5);
  assertEquals(exports.quantified_instruction_count(3, 1, unbounded, 1), 5);
  assertEquals(exports.quantified_instruction_count(3, 3, unbounded, 1), 12);
  assertEquals(exports.quantified_instruction_count(3, 2, 2, 1), 7);
  assertEquals(exports.quantified_instruction_count(3, 2, 4, 1), 21);
});

Deno.test("regex engine contract: rejects oversized quantified fragments", () => {
  const exports = engine();
  const unbounded = 0xffffffff;
  const maximum = REGEX_LIMIT.MAX_BYTECODE_INSTRUCTIONS;
  assertEquals(exports.quantified_instruction_count(maximum, 1, 1, 0), maximum);
  assertEquals(exports.quantified_instruction_count(maximum, 0, 0, 0), 0);
  assertEquals(
    exports.quantified_instruction_count(maximum, 0, unbounded, 0),
    -1,
  );
  assertEquals(exports.quantified_instruction_count(2, 3, 2, 0), -1);
  assertEquals(
    exports.quantified_instruction_count(1, maximum + 1, unbounded, 0),
    -1,
  );
  assertEquals(exports.quantified_instruction_count(1, 0, maximum + 1, 0), -1);
  assertEquals(exports.quantified_instruction_count(2, 0, maximum, 0), -1);
  assertEquals(
    exports.quantified_instruction_count(1, 0, maximum - 1, 1),
    -1,
  );
});

Deno.test("regex engine contract: applies quantifiers to enclosing fragments", () => {
  const exports = engine();
  const unbounded = 0xffffffff;
  assertEquals(exports.measurement_apply_quantifier(20, 5, 2, 4, 0), 41);
  assertEquals(exports.measurement_apply_quantifier(20, 5, 2, 4, 1), 44);
  assertEquals(exports.measurement_apply_quantifier(8, 1, 0, unbounded, 0), 9);
  assertEquals(exports.measurement_apply_quantifier(8, 1, 0, 0, 0), 7);
  assertEquals(exports.measurement_apply_quantifier(8, 0, 0, 1, 0), 8);
  assertEquals(exports.quantified_instruction_count(0, 0, 0xffffffff, 0), 0);
  assertEquals(exports.quantified_instruction_count(0, 2, 1, 0), -1);
  assertEquals(exports.measurement_apply_quantifier(4, 5, 1, 1, 0), -1);
  assertEquals(
    exports.measurement_apply_quantifier(
      REGEX_LIMIT.MAX_BYTECODE_INSTRUCTIONS,
      1,
      0,
      unbounded,
      0,
    ),
    -1,
  );
});

Deno.test("regex engine contract: sizes the measurement group stack", () => {
  const exports = engine();
  const expected = (patternBytes) =>
    REGEX_COMPILER.MEASUREMENT_HEADER_SIZE +
    (patternBytes + 1) * REGEX_COMPILER.GROUP_STACK_ENTRY_SIZE;
  assertEquals(exports.measurement_workspace_size(0), expected(0));
  assertEquals(exports.measurement_workspace_size(10), expected(10));
  assertEquals(
    exports.measurement_workspace_size(REGEX_LIMIT.MAX_PATTERN_BYTES),
    expected(REGEX_LIMIT.MAX_PATTERN_BYTES),
  );
  assertEquals(
    exports.measurement_workspace_size(REGEX_LIMIT.MAX_PATTERN_BYTES + 1),
    -1,
  );
  assertEquals(
    exports.scan_workspace_size(10),
    REGEX_COMPILER.SCAN_HEADER_SIZE + expected(10),
  );
  assertEquals(
    exports.scan_workspace_size(REGEX_LIMIT.MAX_PATTERN_BYTES),
    REGEX_COMPILER.SCAN_HEADER_SIZE +
      expected(REGEX_LIMIT.MAX_PATTERN_BYTES),
  );
  assertEquals(
    exports.scan_workspace_size(REGEX_LIMIT.MAX_PATTERN_BYTES + 1),
    -1,
  );
  assertEquals(
    exports.emission_workspace_size(REGEX_LIMIT.MAX_PATTERN_BYTES),
    REGEX_COMPILER.EMIT_HEADER_SIZE +
      (REGEX_LIMIT.MAX_PATTERN_BYTES + 1) *
        REGEX_COMPILER.EMIT_STACK_ENTRY_SIZE,
  );
  assertEquals(
    exports.emission_workspace_size(REGEX_LIMIT.MAX_PATTERN_BYTES + 1),
    -1,
  );
});

Deno.test("regex engine contract: operates the measurement group stack", () => {
  const memory = new WebAssembly.Memory({
    initial: 1,
    maximum: 32,
    shared: true,
  });
  const exports = instantiateRegexSync(memory).exports;
  const workspaceAddress = 1024;
  const patternBytes = 3;
  const workspaceCapacity = exports.measurement_workspace_size(patternBytes);
  assertEquals(
    exports.initialize_measurement_workspace(
      workspaceAddress,
      workspaceCapacity,
      patternBytes,
      3,
    ),
    REGEX_STATUS.OK,
  );
  const words = new Uint32Array(memory.buffer);
  const workspaceWord = workspaceAddress / 4;
  assertEquals(
    words[workspaceWord + REGEX_COMPILER.MEASUREMENT.MAGIC / 4],
    REGEX_COMPILER.MEASUREMENT_MAGIC,
  );
  assertEquals(
    words[workspaceWord + REGEX_COMPILER.MEASUREMENT.PATTERN_BYTES / 4],
    patternBytes,
  );
  assertEquals(
    words[
      workspaceWord +
      REGEX_COMPILER.MEASUREMENT_HEADER_SIZE / 4
    ],
    3,
  );

  assertEquals(
    exports.measurement_push_group(
      workspaceAddress,
      workspaceCapacity,
      patternBytes,
      0,
    ),
    REGEX_STATUS.OK,
  );
  assertEquals(
    exports.measurement_add_atom(
      workspaceAddress,
      workspaceCapacity,
      patternBytes,
      2,
    ),
    REGEX_STATUS.OK,
  );
  assertEquals(
    exports.measurement_push_group(
      workspaceAddress,
      workspaceCapacity,
      patternBytes,
      1,
    ),
    REGEX_STATUS.OK,
  );
  assertEquals(
    exports.measurement_add_atom(
      workspaceAddress,
      workspaceCapacity,
      patternBytes,
      4,
    ),
    REGEX_STATUS.OK,
  );
  assertEquals(
    exports.measurement_pop_group(
      workspaceAddress,
      workspaceCapacity,
      patternBytes,
      2,
    ),
    [REGEX_STATUS.OK, 4],
  );
  assertEquals(
    words[
      workspaceWord +
      REGEX_COMPILER.MEASUREMENT.LAST_ATOM_CAPTURE_COUNT / 4
    ],
    1,
  );
  assertEquals(
    exports.measurement_apply_last_quantifier(
      workspaceAddress,
      workspaceCapacity,
      patternBytes,
      2,
      3,
    ),
    REGEX_STATUS.OK,
  );
  assertEquals(
    exports.measurement_pop_group(
      workspaceAddress,
      workspaceCapacity,
      patternBytes,
      2,
    ),
    [REGEX_STATUS.OK, 19],
  );
  assertEquals(
    words[
      workspaceWord +
      REGEX_COMPILER.MEASUREMENT.INSTRUCTION_COUNT / 4
    ],
    22,
  );
  assertEquals(
    words[
      workspaceWord +
      REGEX_COMPILER.MEASUREMENT.LAST_ATOM_INSTRUCTION_COUNT / 4
    ],
    19,
  );
  assertEquals(
    words[
      workspaceWord +
      REGEX_COMPILER.MEASUREMENT.LAST_ATOM_CAPTURE_COUNT / 4
    ],
    2,
  );
  // The bounded quantifier with optional copies claimed one guard slot.
  assertEquals(
    words[
      workspaceWord +
      REGEX_COMPILER.MEASUREMENT.GUARD_SLOTS / 4
    ],
    1,
  );
  assertEquals(
    exports.measurement_pop_group(
      workspaceAddress,
      workspaceCapacity,
      patternBytes,
      2,
    ),
    [REGEX_STATUS.CORRUPT_PROGRAM, 0],
  );
});

Deno.test("regex engine contract: rejects corrupt measurement stacks", () => {
  const memory = new WebAssembly.Memory({
    initial: 1,
    maximum: 32,
    shared: true,
  });
  const exports = instantiateRegexSync(memory).exports;
  const workspaceAddress = 1024;
  const patternBytes = 2;
  const workspaceCapacity = exports.measurement_workspace_size(patternBytes);
  assertEquals(
    exports.initialize_measurement_workspace(
      workspaceAddress,
      workspaceCapacity,
      patternBytes,
      2,
    ),
    REGEX_STATUS.OK,
  );
  assertEquals(
    exports.measurement_push_group(
      workspaceAddress,
      exports.measurement_workspace_size(patternBytes + 1),
      patternBytes + 1,
    ),
    REGEX_STATUS.CORRUPT_PROGRAM,
  );
  assertEquals(
    exports.measurement_push_group(
      workspaceAddress,
      workspaceCapacity,
      patternBytes,
    ),
    REGEX_STATUS.OK,
  );
  assertEquals(
    exports.measurement_push_group(
      workspaceAddress,
      workspaceCapacity,
      patternBytes,
    ),
    REGEX_STATUS.OK,
  );
  assertEquals(
    exports.measurement_push_group(
      workspaceAddress,
      workspaceCapacity,
      patternBytes,
    ),
    REGEX_STATUS.LIMIT_EXCEEDED,
  );
  const words = new Uint32Array(memory.buffer);
  const workspaceWord = workspaceAddress / 4;
  words[
    workspaceWord +
    REGEX_COMPILER.MEASUREMENT.INSTRUCTION_COUNT / 4
  ] = 1;
  assertEquals(
    exports.measurement_pop_group(
      workspaceAddress,
      workspaceCapacity,
      patternBytes,
    ),
    [REGEX_STATUS.CORRUPT_PROGRAM, 0],
  );
  words[
    workspaceWord +
    REGEX_COMPILER.MEASUREMENT.INSTRUCTION_COUNT / 4
  ] = 2;
  assertEquals(
    exports.measurement_add_atom(
      workspaceAddress,
      workspaceCapacity,
      patternBytes,
      REGEX_LIMIT.MAX_BYTECODE_INSTRUCTIONS,
    ),
    REGEX_STATUS.LIMIT_EXCEEDED,
  );
  words[
    workspaceWord +
    REGEX_COMPILER.MEASUREMENT.LAST_ATOM_INSTRUCTION_COUNT / 4
  ] = 3;
  assertEquals(
    exports.measurement_add_atom(
      workspaceAddress,
      workspaceCapacity,
      patternBytes,
      1,
    ),
    REGEX_STATUS.CORRUPT_PROGRAM,
  );
  assertEquals(
    exports.initialize_measurement_workspace(
      workspaceAddress,
      workspaceCapacity - 1,
      patternBytes,
      0,
    ),
    REGEX_STATUS.BUFFER_TOO_SMALL,
  );
});

Deno.test("regex engine contract: continuation size includes candidate, lists, stack, and marks", () => {
  const exports = engine();
  const instructionCount = 9;
  const explicitCaptureCount = 2;
  const captureBytes = (explicitCaptureCount + 1) * 2 *
    REGEX_CONTINUATION.CAPTURE_OFFSET_SIZE;
  const threadBytes = REGEX_CONTINUATION.THREAD_HEADER_SIZE + captureBytes;
  assertEquals(
    exports.continuation_size(instructionCount, explicitCaptureCount),
    REGEX_CONTINUATION.HEADER_SIZE + captureBytes +
      instructionCount * threadBytes * 3 +
      instructionCount * 4,
  );
  assertEquals(
    exports.continuation_size(1, REGEX_LIMIT.MAX_CAPTURE_GROUPS + 1),
    -1,
  );
  assertEquals(
    exports.continuation_size(
      REGEX_LIMIT.MAX_BYTECODE_INSTRUCTIONS + 1,
      0,
    ),
    -1,
  );
});

Deno.test("regex engine contract: validates complete bytecode records", () => {
  const memory = new WebAssembly.Memory({
    initial: 4,
    maximum: 32,
    shared: true,
  });
  const exports = instantiateRegexSync(memory).exports;
  const programAddress = 128;
  const instructionCount = 2;
  const programBytes = exports.program_size(instructionCount, 0, 0);
  const words = new Uint32Array(memory.buffer);
  const headerWord = programAddress / 4;
  words[headerWord + REGEX_PROGRAM.HEADER.MAGIC / 4] = REGEX_PROGRAM.MAGIC;
  words[headerWord + REGEX_PROGRAM.HEADER.VERSION / 4] = REGEX_PROGRAM.VERSION;
  words[headerWord + REGEX_PROGRAM.HEADER.BYTE_LENGTH / 4] = programBytes;
  words[headerWord + REGEX_PROGRAM.HEADER.INSTRUCTION_COUNT / 4] =
    instructionCount;
  words[headerWord + REGEX_PROGRAM.HEADER.RANGE_COUNT / 4] = 0;
  words[headerWord + REGEX_PROGRAM.HEADER.CAPTURE_GROUP_COUNT / 4] = 0;
  words[headerWord + REGEX_PROGRAM.HEADER.FLAGS / 4] = 0;
  words[headerWord + REGEX_PROGRAM.HEADER.NAME_BYTES / 4] = 0;

  const firstInstructionWord = (programAddress + REGEX_PROGRAM.HEADER_SIZE) / 4;
  words[firstInstructionWord + REGEX_PROGRAM.INSTRUCTION.OPCODE / 4] =
    REGEX_OPCODE.CHARACTER;
  words[firstInstructionWord + REGEX_PROGRAM.INSTRUCTION.FIRST_OPERAND / 4] =
    "a".codePointAt(0);
  words[firstInstructionWord + REGEX_PROGRAM.INSTRUCTION.SECOND_OPERAND / 4] =
    1;
  words[firstInstructionWord + REGEX_PROGRAM.INSTRUCTION.THIRD_OPERAND / 4] = 0;

  const secondInstructionWord = firstInstructionWord +
    REGEX_PROGRAM.INSTRUCTION_SIZE / 4;
  words[secondInstructionWord + REGEX_PROGRAM.INSTRUCTION.OPCODE / 4] =
    REGEX_OPCODE.MATCH;
  words[secondInstructionWord + REGEX_PROGRAM.INSTRUCTION.FIRST_OPERAND / 4] =
    0;
  words[secondInstructionWord + REGEX_PROGRAM.INSTRUCTION.SECOND_OPERAND / 4] =
    0;
  words[secondInstructionWord + REGEX_PROGRAM.INSTRUCTION.THIRD_OPERAND / 4] =
    0;

  assertEquals(
    exports.validate_program(programAddress, programBytes),
    REGEX_STATUS.OK,
  );

  words[firstInstructionWord + REGEX_PROGRAM.INSTRUCTION.SECOND_OPERAND / 4] =
    instructionCount;
  assertEquals(
    exports.validate_program(programAddress, programBytes),
    REGEX_STATUS.CORRUPT_PROGRAM,
  );
  words[firstInstructionWord + REGEX_PROGRAM.INSTRUCTION.SECOND_OPERAND / 4] =
    1;

  words[firstInstructionWord + REGEX_PROGRAM.INSTRUCTION.OPCODE / 4] = 99;
  assertEquals(
    exports.validate_program(programAddress, programBytes),
    REGEX_STATUS.CORRUPT_PROGRAM,
  );
  words[firstInstructionWord + REGEX_PROGRAM.INSTRUCTION.OPCODE / 4] =
    REGEX_OPCODE.CHARACTER;

  assertEquals(
    exports.validate_program(programAddress, REGEX_PROGRAM.HEADER_SIZE - 1),
    REGEX_STATUS.BUFFER_TOO_SMALL,
  );
});

Deno.test("regex engine contract: validates capture-name records", () => {
  const memory = new WebAssembly.Memory({
    initial: 4,
    maximum: 32,
    shared: true,
  });
  const exports = instantiateRegexSync(memory).exports;
  const programAddress = 128;
  const instructionCount = 1;
  const nameBytes = 18;
  const programBytes = exports.program_size(instructionCount, 0, nameBytes);
  const words = new Uint32Array(memory.buffer);
  const headerWord = programAddress / 4;
  words[headerWord + REGEX_PROGRAM.HEADER.MAGIC / 4] = REGEX_PROGRAM.MAGIC;
  words[headerWord + REGEX_PROGRAM.HEADER.VERSION / 4] = REGEX_PROGRAM.VERSION;
  words[headerWord + REGEX_PROGRAM.HEADER.BYTE_LENGTH / 4] = programBytes;
  words[headerWord + REGEX_PROGRAM.HEADER.INSTRUCTION_COUNT / 4] =
    instructionCount;
  words[headerWord + REGEX_PROGRAM.HEADER.RANGE_COUNT / 4] = 0;
  words[headerWord + REGEX_PROGRAM.HEADER.CAPTURE_GROUP_COUNT / 4] = 2;
  words[headerWord + REGEX_PROGRAM.HEADER.FLAGS / 4] = 0;
  words[headerWord + REGEX_PROGRAM.HEADER.NAME_BYTES / 4] = nameBytes;
  const instructionWord = (programAddress + REGEX_PROGRAM.HEADER_SIZE) / 4;
  words[instructionWord + REGEX_PROGRAM.INSTRUCTION.OPCODE / 4] =
    REGEX_OPCODE.MATCH;
  const nameAddress = programAddress + REGEX_PROGRAM.HEADER_SIZE +
    REGEX_PROGRAM.INSTRUCTION_SIZE;
  const dataView = new DataView(memory.buffer);
  dataView.setUint32(nameAddress, 1, true);
  dataView.setUint32(nameAddress + 4, 1, true);
  dataView.setUint8(nameAddress + 8, "a".codePointAt(0));
  dataView.setUint32(nameAddress + 9, 2, true);
  dataView.setUint32(nameAddress + 13, 1, true);
  dataView.setUint8(nameAddress + 17, "b".codePointAt(0));
  assertEquals(
    exports.validate_program(programAddress, programBytes),
    REGEX_STATUS.OK,
  );

  dataView.setUint8(nameAddress + 17, "a".codePointAt(0));
  assertEquals(
    exports.validate_program(programAddress, programBytes),
    REGEX_STATUS.CORRUPT_PROGRAM,
  );
  dataView.setUint8(nameAddress + 17, "b".codePointAt(0));
  dataView.setUint32(nameAddress + 9, 1, true);
  assertEquals(
    exports.validate_program(programAddress, programBytes),
    REGEX_STATUS.CORRUPT_PROGRAM,
  );
  dataView.setUint32(nameAddress + 9, 2, true);
  dataView.setUint8(nameAddress + 17, 0x80);
  assertEquals(
    exports.validate_program(programAddress, programBytes),
    REGEX_STATUS.CORRUPT_PROGRAM,
  );
  dataView.setUint8(nameAddress + 17, "b".codePointAt(0));
  dataView.setUint32(nameAddress + 13, 2, true);
  assertEquals(
    exports.validate_program(programAddress, programBytes),
    REGEX_STATUS.CORRUPT_PROGRAM,
  );
});

Deno.test("regex engine contract: validates canonical UTF-8 scalars", () => {
  const memory = new WebAssembly.Memory({
    initial: 4,
    maximum: 32,
    shared: true,
  });
  const exports = instantiateRegexSync(memory).exports;
  const bytes = new Uint8Array(memory.buffer);
  const address = 256;
  const valid = new TextEncoder().encode("A¢€𐍈");
  bytes.set(valid, address);
  assertEquals(exports.validate_utf8(address, valid.length), REGEX_STATUS.OK);
  assertEquals(exports.validate_utf8(address, 0), REGEX_STATUS.OK);
});

Deno.test("regex engine contract: rejects every malformed UTF-8 shape", () => {
  const malformedSequences = [
    [0x80],
    [0xc0, 0x80],
    [0xc2],
    [0xc2, 0x20],
    [0xe0, 0x80, 0x80],
    [0xed, 0xa0, 0x80],
    [0xe2, 0x82],
    [0xe2, 0x28, 0xa1],
    [0xf0, 0x80, 0x80, 0x80],
    [0xf4, 0x90, 0x80, 0x80],
    [0xf5, 0x80, 0x80, 0x80],
    [0xf0, 0x90, 0x80],
  ];
  for (const malformed of malformedSequences) {
    const memory = new WebAssembly.Memory({
      initial: 4,
      maximum: 32,
      shared: true,
    });
    const exports = instantiateRegexSync(memory).exports;
    const address = 256;
    new Uint8Array(memory.buffer).set(malformed, address);
    assertEquals(
      exports.validate_utf8(address, malformed.length),
      REGEX_STATUS.INVALID_UTF8,
      `accepted ${malformed.map((byte) => byte.toString(16)).join(" ")}`,
    );
  }
});

Deno.test("regex engine contract: checks UTF-8 buffer bounds", () => {
  const memory = new WebAssembly.Memory({
    initial: 1,
    maximum: 32,
    shared: true,
  });
  const exports = instantiateRegexSync(memory).exports;
  assertEquals(
    exports.validate_utf8(memory.buffer.byteLength - 1, 2),
    REGEX_STATUS.BUFFER_TOO_SMALL,
  );
});

Deno.test("regex engine compiler: compiles every accepted flag", () => {
  const memory = new WebAssembly.Memory({
    initial: 1,
    maximum: 32,
    shared: true,
  });
  const exports = instantiateRegexSync(memory).exports;
  const bytes = new Uint8Array(memory.buffer);
  const words = new Uint32Array(memory.buffer);
  const flagsAddress = 256;
  const resultAddress = 512;
  const encodedFlags = new TextEncoder().encode("ydsmig");
  bytes.set(encodedFlags, flagsAddress);
  assertEquals(
    exports.compile_flags(flagsAddress, encodedFlags.length, resultAddress),
    REGEX_STATUS.OK,
  );
  assertEquals(
    words[resultAddress / 4],
    REGEX_FLAG.GLOBAL |
      REGEX_FLAG.IGNORE_CASE |
      REGEX_FLAG.MULTILINE |
      REGEX_FLAG.DOT_ALL |
      REGEX_FLAG.HAS_INDICES |
      REGEX_FLAG.STICKY,
  );
});

Deno.test("regex engine compiler: rejects invalid flags without committing", () => {
  const cases = [
    { flags: "gg", status: REGEX_STATUS.SYNTAX_ERROR },
    { flags: "x", status: REGEX_STATUS.SYNTAX_ERROR },
    { flags: "u", status: REGEX_STATUS.UNSUPPORTED },
    { flags: "v", status: REGEX_STATUS.UNSUPPORTED },
    { flags: "gimsdyxxx", status: REGEX_STATUS.SYNTAX_ERROR },
  ];
  for (const { flags, status } of cases) {
    const memory = new WebAssembly.Memory({
      initial: 1,
      maximum: 32,
      shared: true,
    });
    const exports = instantiateRegexSync(memory).exports;
    const flagsAddress = 256;
    const resultAddress = 512;
    const sentinel = 0xdeadbeef;
    const encodedFlags = new TextEncoder().encode(flags);
    new Uint8Array(memory.buffer).set(encodedFlags, flagsAddress);
    new Uint32Array(memory.buffer)[resultAddress / 4] = sentinel;
    assertEquals(
      exports.compile_flags(flagsAddress, encodedFlags.length, resultAddress),
      status,
      flags,
    );
    assertEquals(new Uint32Array(memory.buffer)[resultAddress / 4], sentinel);
  }
});

Deno.test("regex engine compiler: rejects malformed and out-of-bounds flags", () => {
  const memory = new WebAssembly.Memory({
    initial: 1,
    maximum: 32,
    shared: true,
  });
  const exports = instantiateRegexSync(memory).exports;
  const bytes = new Uint8Array(memory.buffer);
  const resultAddress = 512;
  bytes.set([0xc2], 256);
  assertEquals(
    exports.compile_flags(256, 1, resultAddress),
    REGEX_STATUS.INVALID_UTF8,
  );
  assertEquals(
    exports.compile_flags(memory.buffer.byteLength - 1, 2, resultAddress),
    REGEX_STATUS.BUFFER_TOO_SMALL,
  );
  assertEquals(
    exports.compile_flags(256, 0, memory.buffer.byteLength - 3),
    REGEX_STATUS.BUFFER_TOO_SMALL,
  );
});

Deno.test("regex engine compiler: emits linear syntax instructions", () => {
  assertEquals(emitLinearPattern("^a.$", 6), {
    status: REGEX_STATUS.OK,
    validationStatus: REGEX_STATUS.OK,
    records: [
      [REGEX_OPCODE.SAVE, 0, 1, 0],
      [REGEX_OPCODE.ASSERT_START, 2, 0, 0],
      [REGEX_OPCODE.CHARACTER, 97, 3, 0],
      [REGEX_OPCODE.ANY, 4, 0, 0],
      [REGEX_OPCODE.ASSERT_END, 5, 0, 0],
      [REGEX_OPCODE.SAVE, 1, 6, 0],
      [REGEX_OPCODE.MATCH, 0, 0, 0],
    ],
    ranges: [],
  });
  assertEquals(emitLinearPattern(String.raw`\.\^\$\\`, 6), {
    status: REGEX_STATUS.OK,
    validationStatus: REGEX_STATUS.OK,
    records: [
      [REGEX_OPCODE.SAVE, 0, 1, 0],
      [REGEX_OPCODE.CHARACTER, 46, 2, 0],
      [REGEX_OPCODE.CHARACTER, 94, 3, 0],
      [REGEX_OPCODE.CHARACTER, 36, 4, 0],
      [REGEX_OPCODE.CHARACTER, 92, 5, 0],
      [REGEX_OPCODE.SAVE, 1, 6, 0],
      [REGEX_OPCODE.MATCH, 0, 0, 0],
    ],
    ranges: [],
  });
  assertEquals(emitLinearPattern(String.raw`\d\W\s`, 5), {
    status: REGEX_STATUS.OK,
    validationStatus: REGEX_STATUS.OK,
    records: [
      [REGEX_OPCODE.SAVE, 0, 1, 0],
      [REGEX_OPCODE.CHARACTER_CLASS, 0, 1, 2],
      [REGEX_OPCODE.NEGATED_CHARACTER_CLASS, 1, 4, 3],
      [REGEX_OPCODE.CHARACTER_CLASS, 5, 10, 4],
      [REGEX_OPCODE.SAVE, 1, 5, 0],
      [REGEX_OPCODE.MATCH, 0, 0, 0],
    ],
    ranges: [
      [48, 57],
      [48, 57],
      [65, 90],
      [95, 95],
      [97, 122],
      // ECMA-262 WhiteSpace ∪ LineTerminator
      [9, 13], [32, 32], [160, 160], [5760, 5760], [8192, 8202], [8232, 8233], [8239, 8239], [8287, 8287], [12288, 12288], [65279, 65279],
    ],
  });

  assertEquals(emitLinearPattern("[a-cx]", 1, true), {
    status: REGEX_STATUS.OK,
    validationStatus: REGEX_STATUS.OK,
    records: [
      [REGEX_OPCODE.SAVE, 0, 1, 0],
      [REGEX_OPCODE.CHARACTER_CLASS, 0, 2, 2],
      [REGEX_OPCODE.SAVE, 1, 3, 0],
      [REGEX_OPCODE.MATCH, 0, 0, 0],
    ],
    ranges: [
      [97, 99],
      [120, 120],
    ],
  });
  assertEquals(emitLinearPattern(String.raw`[^a\-]`, 1, true), {
    status: REGEX_STATUS.OK,
    validationStatus: REGEX_STATUS.OK,
    records: [
      [REGEX_OPCODE.SAVE, 0, 1, 0],
      [REGEX_OPCODE.NEGATED_CHARACTER_CLASS, 0, 2, 2],
      [REGEX_OPCODE.SAVE, 1, 3, 0],
      [REGEX_OPCODE.MATCH, 0, 0, 0],
    ],
    ranges: [
      [97, 97],
      [45, 45],
    ],
  });
  assertEquals(emitLinearPattern(String.raw`[\dA]`, 1, true), {
    status: REGEX_STATUS.OK,
    validationStatus: REGEX_STATUS.OK,
    records: [
      [REGEX_OPCODE.SAVE, 0, 1, 0],
      [REGEX_OPCODE.CHARACTER_CLASS, 0, 2, 2],
      [REGEX_OPCODE.SAVE, 1, 3, 0],
      [REGEX_OPCODE.MATCH, 0, 0, 0],
    ],
    ranges: [
      [48, 57],
      [65, 65],
    ],
  });
  assertEquals(emitLinearPattern(String.raw`[\D]`, 1, true), {
    status: REGEX_STATUS.OK,
    validationStatus: REGEX_STATUS.OK,
    records: [
      [REGEX_OPCODE.SAVE, 0, 1, 0],
      [REGEX_OPCODE.CHARACTER_CLASS, 0, 3, 2],
      [REGEX_OPCODE.SAVE, 1, 3, 0],
      [REGEX_OPCODE.MATCH, 0, 0, 0],
    ],
    ranges: [
      [0, 47],
      [58, 0xd7ff],
      [0xe000, 0x10ffff],
    ],
  });
  assertEquals(emitLinearPattern(String.raw`[\W\S]`, 1, true), {
    status: REGEX_STATUS.OK,
    validationStatus: REGEX_STATUS.OK,
    records: [
      [REGEX_OPCODE.SAVE, 0, 1, 0],
      [REGEX_OPCODE.CHARACTER_CLASS, 0, 18, 2],
      [REGEX_OPCODE.SAVE, 1, 3, 0],
      [REGEX_OPCODE.MATCH, 0, 0, 0],
    ],
    ranges: [
      [0, 47],
      [58, 64],
      [91, 94],
      [96, 96],
      [123, 0xd7ff],
      [0xe000, 0x10ffff],
      // \S: complement of ECMA-262 WhiteSpace ∪ LineTerminator
      [0, 8],
      [14, 31],
      [33, 159],
      [161, 5759],
      [5761, 8191],
      [8203, 8231],
      [8234, 8238],
      [8240, 8286],
      [8288, 12287],
      [12289, 0xd7ff],
      [0xe000, 65278],
      [65280, 0x10ffff],
    ],
  });
  assertEquals(emitLinearPattern("(a(b)c)", 1, true), {
    status: REGEX_STATUS.OK,
    validationStatus: REGEX_STATUS.OK,
    records: [
      [REGEX_OPCODE.SAVE, 0, 1, 0],
      [REGEX_OPCODE.SAVE, 2, 2, 0],
      [REGEX_OPCODE.CHARACTER, 97, 3, 0],
      [REGEX_OPCODE.SAVE, 4, 4, 0],
      [REGEX_OPCODE.CHARACTER, 98, 5, 0],
      [REGEX_OPCODE.SAVE, 5, 6, 0],
      [REGEX_OPCODE.CHARACTER, 99, 7, 0],
      [REGEX_OPCODE.SAVE, 3, 8, 0],
      [REGEX_OPCODE.SAVE, 1, 9, 0],
      [REGEX_OPCODE.MATCH, 0, 0, 0],
    ],
    ranges: [],
  });
  assertEquals(emitLinearPattern("(?:a(?:b)c)", 1, true), {
    status: REGEX_STATUS.OK,
    validationStatus: REGEX_STATUS.OK,
    records: [
      [REGEX_OPCODE.SAVE, 0, 1, 0],
      [REGEX_OPCODE.CHARACTER, 97, 2, 0],
      [REGEX_OPCODE.CHARACTER, 98, 3, 0],
      [REGEX_OPCODE.CHARACTER, 99, 4, 0],
      [REGEX_OPCODE.SAVE, 1, 5, 0],
      [REGEX_OPCODE.MATCH, 0, 0, 0],
    ],
    ranges: [],
  });
  assertEquals(emitLinearPattern("(?:a(b)c)", 1, true), {
    status: REGEX_STATUS.OK,
    validationStatus: REGEX_STATUS.OK,
    records: [
      [REGEX_OPCODE.SAVE, 0, 1, 0],
      [REGEX_OPCODE.CHARACTER, 97, 2, 0],
      [REGEX_OPCODE.SAVE, 2, 3, 0],
      [REGEX_OPCODE.CHARACTER, 98, 4, 0],
      [REGEX_OPCODE.SAVE, 3, 5, 0],
      [REGEX_OPCODE.CHARACTER, 99, 6, 0],
      [REGEX_OPCODE.SAVE, 1, 7, 0],
      [REGEX_OPCODE.MATCH, 0, 0, 0],
    ],
    ranges: [],
  });
  assertEquals(emitLinearPattern("(?<name_λ>a)(?<other>b)", 1, true), {
    status: REGEX_STATUS.OK,
    validationStatus: REGEX_STATUS.OK,
    records: [
      [REGEX_OPCODE.SAVE, 0, 1, 0],
      [REGEX_OPCODE.SAVE, 2, 2, 0],
      [REGEX_OPCODE.CHARACTER, 97, 3, 0],
      [REGEX_OPCODE.SAVE, 3, 4, 0],
      [REGEX_OPCODE.SAVE, 4, 5, 0],
      [REGEX_OPCODE.CHARACTER, 98, 6, 0],
      [REGEX_OPCODE.SAVE, 5, 7, 0],
      [REGEX_OPCODE.SAVE, 1, 8, 0],
      [REGEX_OPCODE.MATCH, 0, 0, 0],
    ],
    ranges: [],
    names: [[1, "name_λ"], [2, "other"]],
  });
  assertEquals(
    emitLinearPattern("(?<same>a)(?<same>b)", 1, true).status,
    REGEX_STATUS.SYNTAX_ERROR,
  );
  assertEquals(emitLinearPattern("a|b|c", 1, true), {
    status: REGEX_STATUS.OK,
    validationStatus: REGEX_STATUS.OK,
    records: [
      [REGEX_OPCODE.SAVE, 0, 2, 0],
      [REGEX_OPCODE.CHARACTER, 97, 6, 0],
      [REGEX_OPCODE.SPLIT, 1, 4, 0],
      [REGEX_OPCODE.CHARACTER, 98, 6, 0],
      [REGEX_OPCODE.SPLIT, 3, 5, 0],
      [REGEX_OPCODE.CHARACTER, 99, 6, 0],
      [REGEX_OPCODE.SAVE, 1, 7, 0],
      [REGEX_OPCODE.MATCH, 0, 0, 0],
    ],
    ranges: [],
  });
  assertEquals(emitLinearPattern("(a|b)c", 1, true), {
    status: REGEX_STATUS.OK,
    validationStatus: REGEX_STATUS.OK,
    records: [
      [REGEX_OPCODE.SAVE, 0, 1, 0],
      [REGEX_OPCODE.SAVE, 2, 3, 0],
      [REGEX_OPCODE.CHARACTER, 97, 5, 0],
      [REGEX_OPCODE.SPLIT, 2, 4, 0],
      [REGEX_OPCODE.CHARACTER, 98, 5, 0],
      [REGEX_OPCODE.SAVE, 3, 6, 0],
      [REGEX_OPCODE.CHARACTER, 99, 7, 0],
      [REGEX_OPCODE.SAVE, 1, 8, 0],
      [REGEX_OPCODE.MATCH, 0, 0, 0],
    ],
    ranges: [],
  });
  assertEquals(emitLinearPattern("|z", 1, true), {
    status: REGEX_STATUS.OK,
    validationStatus: REGEX_STATUS.OK,
    records: [
      [REGEX_OPCODE.SAVE, 0, 1, 0],
      [REGEX_OPCODE.SPLIT, 3, 2, 0],
      [REGEX_OPCODE.CHARACTER, 122, 3, 0],
      [REGEX_OPCODE.SAVE, 1, 4, 0],
      [REGEX_OPCODE.MATCH, 0, 0, 0],
    ],
    ranges: [],
  });
  assertEquals(emitLinearPattern("a||b", 1, true), {
    status: REGEX_STATUS.OK,
    validationStatus: REGEX_STATUS.OK,
    records: [
      [REGEX_OPCODE.SAVE, 0, 2, 0],
      [REGEX_OPCODE.CHARACTER, 97, 5, 0],
      [REGEX_OPCODE.SPLIT, 1, 3, 0],
      [REGEX_OPCODE.SPLIT, 5, 4, 0],
      [REGEX_OPCODE.CHARACTER, 98, 5, 0],
      [REGEX_OPCODE.SAVE, 1, 6, 0],
      [REGEX_OPCODE.MATCH, 0, 0, 0],
    ],
    ranges: [],
  });
});

Deno.test("regex engine compiler: emits greedy and lazy simple quantifiers", () => {
  const cases = [
    {
      pattern: "a*",
      records: [
        [REGEX_OPCODE.SAVE, 0, 2, 0],
        [REGEX_OPCODE.CHARACTER, 97, 2, 0],
        [REGEX_OPCODE.SPLIT, 1, 3, 0],
        [REGEX_OPCODE.SAVE, 1, 4, 0],
        [REGEX_OPCODE.MATCH, 0, 0, 0],
      ],
    },
    {
      pattern: "a*?",
      records: [
        [REGEX_OPCODE.SAVE, 0, 2, 0],
        [REGEX_OPCODE.CHARACTER, 97, 2, 0],
        [REGEX_OPCODE.SPLIT, 3, 1, 0],
        [REGEX_OPCODE.SAVE, 1, 4, 0],
        [REGEX_OPCODE.MATCH, 0, 0, 0],
      ],
    },
    {
      pattern: "a+",
      records: [
        [REGEX_OPCODE.SAVE, 0, 1, 0],
        [REGEX_OPCODE.CHARACTER, 97, 2, 0],
        [REGEX_OPCODE.SPLIT, 1, 3, 0],
        [REGEX_OPCODE.SAVE, 1, 4, 0],
        [REGEX_OPCODE.MATCH, 0, 0, 0],
      ],
    },
    {
      pattern: "a+?",
      records: [
        [REGEX_OPCODE.SAVE, 0, 1, 0],
        [REGEX_OPCODE.CHARACTER, 97, 2, 0],
        [REGEX_OPCODE.SPLIT, 3, 1, 0],
        [REGEX_OPCODE.SAVE, 1, 4, 0],
        [REGEX_OPCODE.MATCH, 0, 0, 0],
      ],
    },
    {
      pattern: "a?",
      records: [
        [REGEX_OPCODE.SAVE, 0, 3, 0],
        [REGEX_OPCODE.CHARACTER, 97, 4, 0],
        [REGEX_OPCODE.SAVE, 2, 1, 0],
        [REGEX_OPCODE.SPLIT, 2, 5, 0],
        [REGEX_OPCODE.GUARD, 2, 5, 0],
        [REGEX_OPCODE.SAVE, 1, 6, 0],
        [REGEX_OPCODE.MATCH, 0, 0, 0],
      ],
    },
    {
      pattern: "a??",
      records: [
        [REGEX_OPCODE.SAVE, 0, 3, 0],
        [REGEX_OPCODE.CHARACTER, 97, 4, 0],
        [REGEX_OPCODE.SAVE, 2, 1, 0],
        [REGEX_OPCODE.SPLIT, 5, 2, 0],
        [REGEX_OPCODE.GUARD, 2, 5, 0],
        [REGEX_OPCODE.SAVE, 1, 6, 0],
        [REGEX_OPCODE.MATCH, 0, 0, 0],
      ],
    },
  ];
  for (const { pattern, records } of cases) {
    const uninterrupted = emitLinearPattern(pattern, 100);
    const oneFuelAtATime = emitLinearPattern(pattern, 1, true);
    assertEquals(uninterrupted.status, REGEX_STATUS.OK, pattern);
    assertEquals(uninterrupted.validationStatus, REGEX_STATUS.OK, pattern);
    assertEquals(uninterrupted.records, records, pattern);
    assertEquals(oneFuelAtATime.records, records, `${pattern} resumed`);
    assertEquals(oneFuelAtATime.validationStatus, REGEX_STATUS.OK, pattern);
  }
});

Deno.test("regex engine compiler: quantifies complete grouped fragments", () => {
  assertEquals(emitLinearPattern("(ab)*", 1, true).records, [
    [REGEX_OPCODE.SAVE, 0, 6, 0],
    [REGEX_OPCODE.SAVE, 2, 2, 0],
    [REGEX_OPCODE.CHARACTER, 97, 3, 0],
    [REGEX_OPCODE.CHARACTER, 98, 4, 0],
    [REGEX_OPCODE.SAVE, 3, 6, 0],
    [REGEX_OPCODE.CLEAR_CAPTURES, 2, 2, 1],
    [REGEX_OPCODE.SPLIT, 5, 7, 0],
    [REGEX_OPCODE.SAVE, 1, 8, 0],
    [REGEX_OPCODE.MATCH, 0, 0, 0],
  ]);
  assertEquals(emitLinearPattern("(?:ab)?", 1, true).records, [
    [REGEX_OPCODE.SAVE, 0, 4, 0],
    [REGEX_OPCODE.CHARACTER, 97, 2, 0],
    [REGEX_OPCODE.CHARACTER, 98, 5, 0],
    [REGEX_OPCODE.SAVE, 2, 1, 0],
    [REGEX_OPCODE.SPLIT, 3, 6, 0],
    [REGEX_OPCODE.GUARD, 2, 6, 0],
    [REGEX_OPCODE.SAVE, 1, 7, 0],
    [REGEX_OPCODE.MATCH, 0, 0, 0],
  ]);
  const alternation = emitLinearPattern("(a|b)+?", 1, true);
  assertEquals(alternation.validationStatus, REGEX_STATUS.OK);
  assertEquals(alternation.records, [
    [REGEX_OPCODE.SAVE, 0, 1, 0],
    [REGEX_OPCODE.SAVE, 2, 3, 0],
    [REGEX_OPCODE.CHARACTER, 97, 5, 0],
    [REGEX_OPCODE.SPLIT, 2, 4, 0],
    [REGEX_OPCODE.CHARACTER, 98, 5, 0],
    [REGEX_OPCODE.SAVE, 3, 7, 0],
    [REGEX_OPCODE.CLEAR_CAPTURES, 2, 2, 1],
    [REGEX_OPCODE.SPLIT, 8, 6, 0],
    [REGEX_OPCODE.SAVE, 1, 9, 0],
    [REGEX_OPCODE.MATCH, 0, 0, 0],
  ]);
});

Deno.test("regex engine compiler: emits bounded repetition graphs", () => {
  const cases = [
    {
      pattern: "a{0}",
      records: [
        [REGEX_OPCODE.SAVE, 0, 1, 0],
        [REGEX_OPCODE.SAVE, 1, 2, 0],
        [REGEX_OPCODE.MATCH, 0, 0, 0],
      ],
    },
    {
      pattern: "a{2}",
      records: [
        [REGEX_OPCODE.SAVE, 0, 1, 0],
        [REGEX_OPCODE.CHARACTER, 97, 2, 0],
        [REGEX_OPCODE.CHARACTER, 97, 3, 0],
        [REGEX_OPCODE.SAVE, 1, 4, 0],
        [REGEX_OPCODE.MATCH, 0, 0, 0],
      ],
    },
    {
      pattern: "a{1,3}",
      records: [
        [REGEX_OPCODE.SAVE, 0, 1, 0],
        [REGEX_OPCODE.CHARACTER, 97, 2, 0],
        [REGEX_OPCODE.SPLIT, 3, 10, 0],
        [REGEX_OPCODE.SAVE, 2, 4, 0],
        [REGEX_OPCODE.CHARACTER, 97, 5, 0],
        [REGEX_OPCODE.GUARD, 2, 6, 0],
        [REGEX_OPCODE.SPLIT, 7, 10, 0],
        [REGEX_OPCODE.SAVE, 2, 8, 0],
        [REGEX_OPCODE.CHARACTER, 97, 9, 0],
        [REGEX_OPCODE.GUARD, 2, 10, 0],
        [REGEX_OPCODE.SAVE, 1, 11, 0],
        [REGEX_OPCODE.MATCH, 0, 0, 0],
      ],
    },
    {
      pattern: "a{0,2}?",
      records: [
        [REGEX_OPCODE.SAVE, 0, 2, 0],
        [REGEX_OPCODE.CHARACTER, 97, 4, 0],
        [REGEX_OPCODE.SPLIT, 9, 3, 0],
        [REGEX_OPCODE.SAVE, 2, 1, 0],
        [REGEX_OPCODE.GUARD, 2, 5, 0],
        [REGEX_OPCODE.SPLIT, 9, 6, 0],
        [REGEX_OPCODE.SAVE, 2, 7, 0],
        [REGEX_OPCODE.CHARACTER, 97, 8, 0],
        [REGEX_OPCODE.GUARD, 2, 9, 0],
        [REGEX_OPCODE.SAVE, 1, 10, 0],
        [REGEX_OPCODE.MATCH, 0, 0, 0],
      ],
    },
    {
      pattern: "a{2,}",
      records: [
        [REGEX_OPCODE.SAVE, 0, 1, 0],
        [REGEX_OPCODE.CHARACTER, 97, 2, 0],
        [REGEX_OPCODE.CHARACTER, 97, 3, 0],
        [REGEX_OPCODE.SPLIT, 2, 4, 0],
        [REGEX_OPCODE.SAVE, 1, 5, 0],
        [REGEX_OPCODE.MATCH, 0, 0, 0],
      ],
    },
    {
      pattern: "a{0,}?",
      records: [
        [REGEX_OPCODE.SAVE, 0, 2, 0],
        [REGEX_OPCODE.CHARACTER, 97, 2, 0],
        [REGEX_OPCODE.SPLIT, 3, 1, 0],
        [REGEX_OPCODE.SAVE, 1, 4, 0],
        [REGEX_OPCODE.MATCH, 0, 0, 0],
      ],
    },
  ];
  for (const { pattern, records } of cases) {
    const uninterrupted = emitLinearPattern(pattern, 100);
    const oneFuelAtATime = emitLinearPattern(pattern, 1, true);
    assertEquals(uninterrupted.status, REGEX_STATUS.OK, pattern);
    assertEquals(uninterrupted.validationStatus, REGEX_STATUS.OK, pattern);
    assertEquals(uninterrupted.records, records, pattern);
    assertEquals(oneFuelAtATime.status, REGEX_STATUS.OK, `${pattern} resumed`);
    assertEquals(oneFuelAtATime.validationStatus, REGEX_STATUS.OK, pattern);
    assertEquals(oneFuelAtATime.records, records, `${pattern} resumed`);
  }
  const grouped = emitLinearPattern("(ab){2}", 1, true);
  assertEquals(grouped.status, REGEX_STATUS.OK);
  assertEquals(grouped.validationStatus, REGEX_STATUS.OK);
  assertEquals(grouped.records, [
    [REGEX_OPCODE.SAVE, 0, 1, 0],
    [REGEX_OPCODE.SAVE, 2, 2, 0],
    [REGEX_OPCODE.CHARACTER, 97, 3, 0],
    [REGEX_OPCODE.CHARACTER, 98, 4, 0],
    [REGEX_OPCODE.SAVE, 3, 5, 0],
    [REGEX_OPCODE.CLEAR_CAPTURES, 2, 2, 6],
    [REGEX_OPCODE.SAVE, 2, 7, 0],
    [REGEX_OPCODE.CHARACTER, 97, 8, 0],
    [REGEX_OPCODE.CHARACTER, 98, 9, 0],
    [REGEX_OPCODE.SAVE, 3, 10, 0],
    [REGEX_OPCODE.SAVE, 1, 11, 0],
    [REGEX_OPCODE.MATCH, 0, 0, 0],
  ]);
  const alternation = emitLinearPattern("(a|b){2}", 1, true);
  assertEquals(alternation.validationStatus, REGEX_STATUS.OK);
  assertEquals(alternation.records, [
    [REGEX_OPCODE.SAVE, 0, 1, 0],
    [REGEX_OPCODE.SAVE, 2, 3, 0],
    [REGEX_OPCODE.CHARACTER, 97, 5, 0],
    [REGEX_OPCODE.SPLIT, 2, 4, 0],
    [REGEX_OPCODE.CHARACTER, 98, 5, 0],
    [REGEX_OPCODE.SAVE, 3, 6, 0],
    [REGEX_OPCODE.CLEAR_CAPTURES, 2, 2, 7],
    [REGEX_OPCODE.SAVE, 2, 9, 0],
    [REGEX_OPCODE.CHARACTER, 97, 11, 0],
    [REGEX_OPCODE.SPLIT, 8, 10, 0],
    [REGEX_OPCODE.CHARACTER, 98, 11, 0],
    [REGEX_OPCODE.SAVE, 3, 12, 0],
    [REGEX_OPCODE.SAVE, 1, 13, 0],
    [REGEX_OPCODE.MATCH, 0, 0, 0],
  ]);
});

Deno.test("regex engine compiler: resumes named captures without divergence", () => {
  const pattern = "(?<name_λ>a(?<other>b)c)";
  const uninterrupted = emitLinearPattern(pattern, 100, true);
  const oneFuelAtATime = emitLinearPattern(pattern, 1, true);
  assertEquals(oneFuelAtATime.status, uninterrupted.status);
  assertEquals(oneFuelAtATime.validationStatus, uninterrupted.validationStatus);
  assertEquals(oneFuelAtATime.records, uninterrupted.records);
  assertEquals(oneFuelAtATime.ranges, uninterrupted.ranges);
  assertEquals(oneFuelAtATime.names, uninterrupted.names);
});
Deno.test("regex engine compiler: resumes nested alternation without divergence", () => {
  const pattern = "(?:a|b(?<inner>c|d))|e";
  const uninterrupted = emitLinearPattern(pattern, 100, true);
  const oneFuelAtATime = emitLinearPattern(pattern, 1, true);
  assertEquals(uninterrupted.status, REGEX_STATUS.OK);
  assertEquals(uninterrupted.validationStatus, REGEX_STATUS.OK);
  assertEquals(oneFuelAtATime.status, uninterrupted.status);

  assertEquals(oneFuelAtATime.validationStatus, uninterrupted.validationStatus);
  assertEquals(oneFuelAtATime.records, uninterrupted.records);
  assertEquals(oneFuelAtATime.ranges, uninterrupted.ranges);
  assertEquals(oneFuelAtATime.names, uninterrupted.names);
});

Deno.test("regex engine compiler: accepted syntax resumes without divergence", () => {
  const patterns = [
    "",
    "{",
    "{}",
    "{x}",
    "a{x}",
    "a{2}b",
    "xa*yz",
    "x(a|b){1,3}y",
    "a*|b+",
    "(a?|b{0,2})c",
    "[a-c]+x",
    String.raw`\d{2,4}\W?`,
    "^a*$",
    "(ab){0,2}",
    "(ab){0,2}?",
    "(?:a|)*b",
    "((ab){0,2})",
    "((ab){0,2}?c+)|d",
    "(?<first>a|b){1,2}(?<second>c?)",
  ];
  for (const pattern of patterns) {
    const uninterrupted = emitLinearPattern(pattern, 0xffff, true);
    const oneFuelAtATime = emitLinearPattern(pattern, 1, true);
    assertEquals(
      uninterrupted.status,
      REGEX_STATUS.OK,
      `${pattern} ${JSON.stringify(uninterrupted)}`,
    );
    assertEquals(uninterrupted.validationStatus, REGEX_STATUS.OK, pattern);
    assertEquals(
      oneFuelAtATime.status,
      uninterrupted.status,
      `${pattern} ${JSON.stringify(oneFuelAtATime)}`,
    );
    assertEquals(
      oneFuelAtATime.validationStatus,
      uninterrupted.validationStatus,
      pattern,
    );
    assertEquals(oneFuelAtATime.records, uninterrupted.records, pattern);
    assertEquals(oneFuelAtATime.ranges, uninterrupted.ranges, pattern);
    assertEquals(oneFuelAtATime.names, uninterrupted.names, pattern);
  }
});

Deno.test("regex engine compiler: records quantifiable atom fragments", () => {
  assertEquals(emitLinearPattern("a", 100, true, true).lastAtom, [1, 1]);
  assertEquals(emitLinearPattern("(a|b)", 100, true, true).lastAtom, [1, 5]);
  assertEquals(emitLinearPattern("(?:a|b)", 100, true, true).lastAtom, [1, 3]);
});

Deno.test("regex engine compiler: scans patterns with resumable fuel", () => {
  const memory = new WebAssembly.Memory({
    initial: 1,
    maximum: 32,
    shared: true,
  });
  const exports = instantiateRegexSync(memory).exports;
  const patternAddress = 256;

  const workspaceAddress = 512;
  const pattern = new TextEncoder().encode("a¢€𐍈");
  new Uint8Array(memory.buffer).set(pattern, patternAddress);
  assertEquals(
    exports.scan_workspace_size(pattern.length),
    REGEX_COMPILER.SCAN_HEADER_SIZE +
      exports.measurement_workspace_size(pattern.length),
  );
  assertEquals(
    exports.scan_pattern(
      patternAddress,
      pattern.length,
      workspaceAddress,
      exports.scan_workspace_size(pattern.length) - 1,
      1,
      1,
    )[0],
    REGEX_STATUS.BUFFER_TOO_SMALL,
  );

  let [status, fuelRemaining] = exports.scan_pattern(
    patternAddress,
    pattern.length,
    workspaceAddress,
    exports.scan_workspace_size(pattern.length),
    1,
    1,
  );
  assertEquals(status, REGEX_STATUS.PAUSED);
  assertEquals(
    exports.measured_program_size(
      workspaceAddress,
      exports.scan_workspace_size(pattern.length),
      pattern.length,
    ),
    -1,
  );
  for (let index = 0; status === REGEX_STATUS.PAUSED && index < 100; index++) {
    [status, fuelRemaining] = exports.scan_pattern(
      patternAddress,
      pattern.length,
      workspaceAddress,
      exports.scan_workspace_size(pattern.length),
      0,
      1,
    );
  }
  assertEquals(status, REGEX_STATUS.OK);

  const words = new Uint32Array(memory.buffer);
  const workspaceWord = workspaceAddress / 4;
  assertEquals(
    words[workspaceWord + REGEX_COMPILER.SCAN.SCALAR_COUNT / 4],
    4,
  );
  assertEquals(
    words[workspaceWord + REGEX_COMPILER.SCAN.CURSOR / 4],
    patternAddress + pattern.length,
  );
  assertEquals(
    words[workspaceWord + REGEX_COMPILER.SCAN.COMPLETE / 4],
    1,
  );
  const measurementWord = workspaceWord + REGEX_COMPILER.SCAN_HEADER_SIZE / 4;
  assertEquals(
    words[measurementWord + REGEX_COMPILER.MEASUREMENT.MAGIC / 4],
    REGEX_COMPILER.MEASUREMENT_MAGIC,
  );
  assertEquals(
    words[measurementWord + REGEX_COMPILER.MEASUREMENT.PATTERN_BYTES / 4],
    pattern.length,
  );

  assertEquals(
    exports.scan_pattern(
      patternAddress,
      pattern.length,
      workspaceAddress,
      exports.scan_workspace_size(pattern.length),
      0,
      9,
    )[0],
    REGEX_STATUS.OK,
  );
  const programAddress = 4096;
  const programBytes = exports.measured_program_size(
    workspaceAddress,
    exports.scan_workspace_size(pattern.length),
    pattern.length,
  );
  words[programAddress / 4] = 0xdeadbeef;
  assertEquals(
    exports.initialize_program_emission(
      workspaceAddress,
      exports.scan_workspace_size(pattern.length),
      pattern.length,
      programAddress,
      programBytes - 1,
      REGEX_FLAG.GLOBAL,
    ),
    REGEX_STATUS.BUFFER_TOO_SMALL,
  );
  assertEquals(words[programAddress / 4], 0xdeadbeef);
  assertEquals(
    exports.initialize_program_emission(
      workspaceAddress,
      exports.scan_workspace_size(pattern.length),
      pattern.length,
      programAddress,
      programBytes,
      1 << 4,
    ),
    REGEX_STATUS.SYNTAX_ERROR,
  );
  assertEquals(words[programAddress / 4], 0xdeadbeef);
  assertEquals(
    exports.initialize_program_emission(
      workspaceAddress,
      exports.scan_workspace_size(pattern.length),
      pattern.length,
      workspaceAddress,
      programBytes,
      REGEX_FLAG.GLOBAL,
    ),
    REGEX_STATUS.CORRUPT_PROGRAM,
  );
  assertEquals(
    exports.initialize_program_emission(
      workspaceAddress,
      exports.scan_workspace_size(pattern.length),
      pattern.length,
      patternAddress,
      programBytes,
      REGEX_FLAG.GLOBAL,
    ),
    REGEX_STATUS.CORRUPT_PROGRAM,
  );
  assertEquals(
    exports.initialize_program_emission(
      workspaceAddress,
      exports.scan_workspace_size(pattern.length),
      pattern.length,
      programAddress,
      programBytes,
      REGEX_FLAG.GLOBAL | REGEX_FLAG.STICKY,
    ),
    REGEX_STATUS.OK,
  );
  const programWord = programAddress / 4;
  assertEquals(
    words[programWord + REGEX_PROGRAM.HEADER.MAGIC / 4],
    0,
  );
  assertEquals(
    words[programWord + REGEX_PROGRAM.HEADER.BYTE_LENGTH / 4],
    programBytes,
  );
  assertEquals(
    words[programWord + REGEX_PROGRAM.HEADER.INSTRUCTION_COUNT / 4],
    7,
  );
  assertEquals(
    words[programWord + REGEX_PROGRAM.HEADER.FLAGS / 4],
    REGEX_FLAG.GLOBAL | REGEX_FLAG.STICKY,
  );
  assertEquals(
    exports.validate_program(programAddress, programBytes),
    REGEX_STATUS.CORRUPT_PROGRAM,
  );
  const emissionAddress = 8192;
  const emissionBytes = exports.emission_workspace_size(pattern.length);
  assertEquals(
    emissionBytes,
    REGEX_COMPILER.EMIT_HEADER_SIZE +
      (pattern.length + 1) * REGEX_COMPILER.EMIT_STACK_ENTRY_SIZE,
  );
  assertEquals(
    exports.initialize_emission_workspace(
      workspaceAddress,
      exports.scan_workspace_size(pattern.length),
      pattern.length,
      programAddress,
      programBytes,
      emissionAddress,
      emissionBytes - 1,
    ),
    REGEX_STATUS.BUFFER_TOO_SMALL,
  );
  for (
    const overlappingAddress of [
      workspaceAddress,
      patternAddress,
      programAddress,
    ]
  ) {
    assertEquals(
      exports.initialize_emission_workspace(
        workspaceAddress,
        exports.scan_workspace_size(pattern.length),
        pattern.length,
        programAddress,
        programBytes,
        overlappingAddress,
        emissionBytes,
      ),
      REGEX_STATUS.CORRUPT_PROGRAM,
    );
  }
  assertEquals(
    exports.initialize_emission_workspace(
      workspaceAddress,
      exports.scan_workspace_size(pattern.length),
      pattern.length,
      programAddress,
      programBytes,
      emissionAddress,
      emissionBytes,
    ),
    REGEX_STATUS.OK,
  );
  const emissionWord = emissionAddress / 4;
  assertEquals(
    words[emissionWord + REGEX_COMPILER.EMIT.MAGIC / 4],
    REGEX_COMPILER.EMIT_MAGIC,
  );
  assertEquals(
    words[emissionWord + REGEX_COMPILER.EMIT.INSTRUCTION_INDEX / 4],
    1,
  );
  for (
    const field of [
      REGEX_COMPILER.EMIT.MODE,
      REGEX_COMPILER.EMIT.CLASS_FIRST,
      REGEX_COMPILER.EMIT.CLASS_NEGATED,
      REGEX_COMPILER.EMIT.CLASS_PENDING,
      REGEX_COMPILER.EMIT.CLASS_PENDING_SCALAR,
      REGEX_COMPILER.EMIT.CLASS_DASH,
      REGEX_COMPILER.EMIT.CLASS_RANGE_START,
      REGEX_COMPILER.EMIT.CLASS_RANGE_COUNT,
      REGEX_COMPILER.EMIT.QUANTIFIER_MINIMUM,
      REGEX_COMPILER.EMIT.QUANTIFIER_MAXIMUM,
      REGEX_COMPILER.EMIT.QUANTIFIER_HAS_DIGITS,
      REGEX_COMPILER.EMIT.CAPTURE_GROUP_COUNT,
      REGEX_COMPILER.EMIT.NAME_START,
      REGEX_COMPILER.EMIT.NAME_LENGTH,
      REGEX_COMPILER.EMIT.LAST_ATOM_START,
      REGEX_COMPILER.EMIT.LAST_ATOM_INSTRUCTION_COUNT,
      REGEX_COMPILER.EMIT.QUANTIFIER_SPLIT,
    ]
  ) {
    assertEquals(words[emissionWord + field / 4], 0);
  }
  const rootInstructionWord = (programAddress + REGEX_PROGRAM.HEADER_SIZE) / 4;
  assertEquals(
    Array.from(
      words.slice(
        rootInstructionWord,
        rootInstructionWord + REGEX_PROGRAM.INSTRUCTION_SIZE / 4,
      ),
    ),
    [REGEX_OPCODE.SAVE, 0, 1, 0],
  );
  assertEquals(
    exports.emit_pattern(emissionAddress, emissionBytes, 0)[0],
    REGEX_STATUS.PAUSED,
  );
  let emissionStatus = REGEX_STATUS.PAUSED;
  for (let index = 0; emissionStatus === REGEX_STATUS.PAUSED && index < 100; index++) {
    [emissionStatus] = exports.emit_pattern(emissionAddress, emissionBytes, 1);
  }
  assertEquals(emissionStatus, REGEX_STATUS.OK);
  const instructionRecords = [];
  for (let index = 0; index < 7; index++) {
    const instructionWord = rootInstructionWord +
      index * REGEX_PROGRAM.INSTRUCTION_SIZE / 4;
    instructionRecords.push(
      Array.from(
        words.slice(
          instructionWord,
          instructionWord + REGEX_PROGRAM.INSTRUCTION_SIZE / 4,
        ),
      ),
    );
  }
  assertEquals(instructionRecords, [
    [REGEX_OPCODE.SAVE, 0, 1, 0],
    [REGEX_OPCODE.CHARACTER, "a".codePointAt(0), 2, 0],
    [REGEX_OPCODE.CHARACTER, "¢".codePointAt(0), 3, 0],
    [REGEX_OPCODE.CHARACTER, "€".codePointAt(0), 4, 0],
    [REGEX_OPCODE.CHARACTER, "𐍈".codePointAt(0), 5, 0],
    [REGEX_OPCODE.SAVE, 1, 6, 0],
    [REGEX_OPCODE.MATCH, 0, 0, 0],
  ]);
  assertEquals(
    exports.validate_program(programAddress, programBytes),
    REGEX_STATUS.OK,
  );
  assertEquals(
    exports.emit_pattern(emissionAddress, emissionBytes, 9)[0],
    REGEX_STATUS.OK,
  );
  words[programWord + REGEX_PROGRAM.HEADER.VERSION / 4] =
    REGEX_PROGRAM.VERSION + 1;
  assertEquals(
    exports.emit_pattern(emissionAddress, emissionBytes, 9)[0],
    REGEX_STATUS.CORRUPT_PROGRAM,
  );
  words[programWord + REGEX_PROGRAM.HEADER.VERSION / 4] = REGEX_PROGRAM.VERSION;
  words[rootInstructionWord] = REGEX_OPCODE.ANY;
  assertEquals(
    exports.emit_pattern(emissionAddress, emissionBytes, 9)[0],
    REGEX_STATUS.CORRUPT_PROGRAM,
  );
  words[rootInstructionWord] = REGEX_OPCODE.SAVE;
  words[emissionWord + REGEX_COMPILER.EMIT.INSTRUCTION_INDEX / 4] = 0;
  assertEquals(
    exports.emit_pattern(emissionAddress, emissionBytes, 9)[0],
    REGEX_STATUS.CORRUPT_PROGRAM,
  );
  words[emissionWord + REGEX_COMPILER.EMIT.INSTRUCTION_INDEX / 4] = 7;
  words[emissionWord + REGEX_COMPILER.EMIT.MODE / 4] = 1;
  assertEquals(
    exports.emit_pattern(emissionAddress, emissionBytes, 9)[0],
    REGEX_STATUS.CORRUPT_PROGRAM,
  );
  words[emissionWord + REGEX_COMPILER.EMIT.MODE / 4] = 0;
  words[
    emissionWord + REGEX_COMPILER.EMIT.CAPTURE_GROUP_COUNT / 4
  ] = 1;
  assertEquals(
    exports.emit_pattern(emissionAddress, emissionBytes, 9)[0],
    REGEX_STATUS.CORRUPT_PROGRAM,
  );
  words[
    emissionWord + REGEX_COMPILER.EMIT.CAPTURE_GROUP_COUNT / 4
  ] = 0;
  words[emissionWord + REGEX_COMPILER.EMIT.MODE / 4] =
    REGEX_COMPILER.EMIT_MODE.AFTER_GROUP_OPEN;
  assertEquals(
    exports.emit_pattern(emissionAddress, emissionBytes, 9)[0],
    REGEX_STATUS.CORRUPT_PROGRAM,
  );
  words[emissionWord + REGEX_COMPILER.EMIT.MODE / 4] =
    REGEX_COMPILER.EMIT_MODE.NORMAL;
  const lastAtomStart =
    words[emissionWord + REGEX_COMPILER.EMIT.LAST_ATOM_START / 4];
  const lastAtomInstructionCount = words[
    emissionWord + REGEX_COMPILER.EMIT.LAST_ATOM_INSTRUCTION_COUNT / 4
  ];
  words[
    emissionWord + REGEX_COMPILER.EMIT.LAST_ATOM_INSTRUCTION_COUNT / 4
  ] = 8;
  assertEquals(
    exports.emit_pattern(emissionAddress, emissionBytes, 9)[0],
    REGEX_STATUS.CORRUPT_PROGRAM,
  );
  words[emissionWord + REGEX_COMPILER.EMIT.LAST_ATOM_START / 4] = lastAtomStart;
  words[
    emissionWord + REGEX_COMPILER.EMIT.LAST_ATOM_INSTRUCTION_COUNT / 4
  ] = lastAtomInstructionCount;
  words[emissionWord + REGEX_COMPILER.EMIT.QUANTIFIER_SPLIT / 4] = 1;
  words[emissionWord + REGEX_COMPILER.EMIT.QUANTIFIER_MINIMUM / 4] = 1;
  assertEquals(
    exports.emit_pattern(emissionAddress, emissionBytes, 9)[0],
    REGEX_STATUS.CORRUPT_PROGRAM,
  );
  words[emissionWord + REGEX_COMPILER.EMIT.QUANTIFIER_MINIMUM / 4] = 0;
  assertEquals(
    exports.emit_pattern(emissionAddress, emissionBytes, 9)[0],
    REGEX_STATUS.CORRUPT_PROGRAM,
  );
  words[emissionWord + REGEX_COMPILER.EMIT.QUANTIFIER_SPLIT / 4] = 0;
  const uninterruptedProgramAddress = 12288;
  words[emissionWord + REGEX_COMPILER.EMIT.NAME_LENGTH / 4] = 1;
  assertEquals(
    exports.emit_pattern(emissionAddress, emissionBytes, 9)[0],
    REGEX_STATUS.CORRUPT_PROGRAM,
  );
  words[emissionWord + REGEX_COMPILER.EMIT.NAME_LENGTH / 4] = 0;
  const uninterruptedEmissionAddress = 16384;
  assertEquals(
    exports.initialize_program_emission(
      workspaceAddress,
      exports.scan_workspace_size(pattern.length),
      pattern.length,
      uninterruptedProgramAddress,
      programBytes,
      REGEX_FLAG.GLOBAL | REGEX_FLAG.STICKY,
    ),
    REGEX_STATUS.OK,
  );
  assertEquals(
    exports.initialize_emission_workspace(
      workspaceAddress,
      exports.scan_workspace_size(pattern.length),
      pattern.length,
      uninterruptedProgramAddress,
      programBytes,
      uninterruptedEmissionAddress,
      emissionBytes,
    ),
    REGEX_STATUS.OK,
  );
  assertEquals(
    exports.emit_pattern(
      uninterruptedEmissionAddress,
      emissionBytes,
      100,
    )[0],
    REGEX_STATUS.OK,
  );
  assertEquals(
    Array.from(
      new Uint8Array(
        memory.buffer,
        uninterruptedProgramAddress,
        programBytes,
      ),
    ),
    Array.from(new Uint8Array(memory.buffer, programAddress, programBytes)),
  );
  const rootCheckpointWord = measurementWord +
    REGEX_COMPILER.MEASUREMENT_HEADER_SIZE / 4;
  words[rootCheckpointWord] = 4;
  assertEquals(
    exports.measured_program_size(
      workspaceAddress,
      exports.scan_workspace_size(pattern.length),
      pattern.length,
    ),
    -1,
  );
  assertEquals(
    exports.scan_pattern(
      patternAddress,
      pattern.length,
      workspaceAddress,
      exports.scan_workspace_size(pattern.length),
      0,
      9,
    )[0],
    REGEX_STATUS.CORRUPT_PROGRAM,
  );
  words[rootCheckpointWord] = 3;
  words[measurementWord + REGEX_COMPILER.MEASUREMENT.MAGIC / 4] = 0;
  assertEquals(
    exports.scan_pattern(
      patternAddress,
      pattern.length,
      workspaceAddress,
      exports.scan_workspace_size(pattern.length),
      0,
      9,
    )[0],
    REGEX_STATUS.CORRUPT_PROGRAM,
  );
});

Deno.test("regex engine compiler: tiny and uninterrupted scans agree", () => {
  const pattern = new TextEncoder().encode("plain-λ-pattern");
  const run = (fuel) => {
    const memory = new WebAssembly.Memory({
      initial: 1,
      maximum: 32,
      shared: true,
    });
    const exports = instantiateRegexSync(memory).exports;
    const patternAddress = 256;
    const workspaceAddress = 512;
    new Uint8Array(memory.buffer).set(pattern, patternAddress);
    let initialize = 1;
    let status;
      do {
      let fuelRemaining;
      [status, fuelRemaining] = exports.scan_pattern(
        patternAddress,
        pattern.length,
        workspaceAddress,
        exports.scan_workspace_size(pattern.length),
        initialize,
        fuel,
      );
        initialize = 0;
    } while (status === REGEX_STATUS.PAUSED);
    const words = new Uint32Array(memory.buffer);
    return {
      status,
      totalFuel: BigInt.asUintN(64, exports.scan_work_charged(workspaceAddress)),
      scalarCount: words[
        workspaceAddress / 4 + REGEX_COMPILER.SCAN.SCALAR_COUNT / 4
      ],
    };
  };
  assertEquals(run(1), run(100));
});

Deno.test("regex engine compiler: rejects invalid scan continuations", () => {
  const memory = new WebAssembly.Memory({
    initial: 2,
    maximum: 32,
    shared: true,
  });
  const exports = instantiateRegexSync(memory).exports;
  const bytes = new Uint8Array(memory.buffer);
  const words = new Uint32Array(memory.buffer);
  const patternAddress = 256;
  const workspaceAddress = 512;
  bytes.set([0x61, 0x62], patternAddress);
  assertEquals(
    exports.scan_pattern(
      patternAddress,
      2,
      workspaceAddress,
      exports.scan_workspace_size(2),
      1,
      1,
    )[0],
    REGEX_STATUS.PAUSED,
  );
  assertEquals(
    exports.scan_pattern(
      patternAddress,
      1,
      workspaceAddress,
      exports.scan_workspace_size(1),
      0,
      1,
    )[0],
    REGEX_STATUS.CORRUPT_PROGRAM,
  );

  words[workspaceAddress / 4 + REGEX_COMPILER.SCAN.RESERVED / 4] = 1;
  assertEquals(
    exports.scan_pattern(
      patternAddress,
      2,
      workspaceAddress,
      exports.scan_workspace_size(2),
      0,
      1,
    )[0],
    REGEX_STATUS.CORRUPT_PROGRAM,
  );

  assertEquals(
    exports.scan_pattern(
      patternAddress,
      2,
      patternAddress,
      exports.scan_workspace_size(2),
      1,
      1,
    )[0],
    REGEX_STATUS.CORRUPT_PROGRAM,
  );

  bytes.set([0xc2], patternAddress);
  assertEquals(
    exports.scan_pattern(
      patternAddress,
      1,
      workspaceAddress,
      exports.scan_workspace_size(1),
      1,
      0x7fffffff,
    )[0],
    REGEX_STATUS.INVALID_UTF8,
  );
  assertEquals(
    exports.scan_pattern(
      0,
      REGEX_LIMIT.MAX_PATTERN_BYTES + 1,
      workspaceAddress,
      0,
      1,
      1,
    )[0],
    REGEX_STATUS.LIMIT_EXCEEDED,
  );
});

Deno.test("regex engine compiler: emits exact ASCII shorthand ranges", () => {
  const definitions = [
    { escape: "d", ranges: [[48, 57]], negated: 0 },
    { escape: "D", ranges: [[48, 57]], negated: 1 },
    {
      escape: "w",
      ranges: [[48, 57], [65, 90], [95, 95], [97, 122]],
      negated: 0,
    },
    {
      escape: "W",
      ranges: [[48, 57], [65, 90], [95, 95], [97, 122]],
      negated: 1,
    },
    { escape: "s", ranges: [[9, 13], [32, 32], [160, 160], [5760, 5760], [8192, 8202], [8232, 8233], [8239, 8239], [8287, 8287], [12288, 12288], [65279, 65279]], negated: 0 },
    { escape: "S", ranges: [[9, 13], [32, 32], [160, 160], [5760, 5760], [8192, 8202], [8232, 8233], [8239, 8239], [8287, 8287], [12288, 12288], [65279, 65279]], negated: 1 },
  ];
  for (const { escape, ranges, negated } of definitions) {
    const memory = new WebAssembly.Memory({
      initial: 1,
      maximum: 32,
      shared: true,
    });
    const exports = instantiateRegexSync(memory).exports;
    const rangesAddress = 256;
    const resultAddress = 512;
    assertEquals(
      exports.compile_builtin_class(
        escape.codePointAt(0),
        rangesAddress,
        REGEX_COMPILER.BUILTIN_CLASS_MAX_RANGES * 8,
        resultAddress,
        REGEX_COMPILER.BUILTIN_CLASS_RESULT_SIZE,
      ),
      REGEX_STATUS.OK,
    );
    const words = new Uint32Array(memory.buffer);
    assertEquals(
      words[
        resultAddress / 4 +
        REGEX_COMPILER.BUILTIN_CLASS_RESULT.RANGE_COUNT / 4
      ],
      ranges.length,
    );
    assertEquals(
      words[
        resultAddress / 4 +
        REGEX_COMPILER.BUILTIN_CLASS_RESULT.NEGATED / 4
      ],
      negated,
    );
    assertEquals(
      Array.from(
        words.slice(rangesAddress / 4, rangesAddress / 4 + ranges.length * 2),
      ),
      ranges.flat(),
    );
  }
});

Deno.test("regex engine compiler: class failures do not commit output", () => {
  const memory = new WebAssembly.Memory({
    initial: 1,
    maximum: 32,
    shared: true,
  });
  const exports = instantiateRegexSync(memory).exports;
  const words = new Uint32Array(memory.buffer);
  const rangesAddress = 256;
  const resultAddress = 512;
  const sentinel = 0xdeadbeef;
  words[resultAddress / 4] = sentinel;
  words[resultAddress / 4 + 1] = sentinel;

  assertEquals(
    exports.compile_builtin_class(
      "x".codePointAt(0),
      rangesAddress,
      32,
      resultAddress,
      8,
    ),
    REGEX_STATUS.SYNTAX_ERROR,
  );
  assertEquals(
    exports.compile_builtin_class(
      "w".codePointAt(0),
      rangesAddress,
      31,
      resultAddress,
      8,
    ),
    REGEX_STATUS.BUFFER_TOO_SMALL,
  );
  assertEquals(
    exports.compile_builtin_class(
      "d".codePointAt(0),
      rangesAddress,
      8,
      rangesAddress + 4,
      8,
    ),
    REGEX_STATUS.CORRUPT_PROGRAM,
  );
  assertEquals(
    exports.compile_builtin_class(
      "d".codePointAt(0),
      memory.buffer.byteLength - 4,
      8,
      resultAddress,
      8,
    ),
    REGEX_STATUS.BUFFER_TOO_SMALL,
  );
  assertEquals(
    [words[resultAddress / 4], words[resultAddress / 4 + 1]],
    [sentinel, sentinel],
  );
});

Deno.test("regex engine compiler: lexes groups classes escapes and names", () => {
  const pattern = String.raw`(a)[\]](?:b)(?<name_1>c)(?<λ>z)\\1`;
  const uninterrupted = scanPattern(pattern, 100);
  const tinyFuel = scanPattern(pattern, 1);
  assertEquals(tinyFuel, uninterrupted);
  assertEquals(uninterrupted.status, REGEX_STATUS.OK);
  assertEquals(uninterrupted.captureGroupCount, 3);
  assertEquals(uninterrupted.groupDepth, 0);
  assertEquals(uninterrupted.mode, 0);
  assertEquals(uninterrupted.namedCaptureCount, 2);
  assertEquals(
    uninterrupted.nameBytes,
    REGEX_COMPILER.NAME_HEADER_SIZE * 2 +
      new TextEncoder().encode("name_1λ").length,
  );
});

Deno.test("regex engine compiler: measures UTF-8 name payload bytes", () => {
  const pattern = "(?<λ>x)(?<𐍈>y)";
  const uninterrupted = scanPattern(pattern, 100);
  const tinyFuel = scanPattern(pattern, 1);
  assertEquals(tinyFuel, uninterrupted);
  assertEquals(uninterrupted.status, REGEX_STATUS.OK);
  assertEquals(uninterrupted.captureGroupCount, 2);
  assertEquals(uninterrupted.namedCaptureCount, 2);
  assertEquals(
    uninterrupted.nameBytes,
    REGEX_COMPILER.NAME_HEADER_SIZE * 2 +
      new TextEncoder().encode("λ𐍈").length,
  );
});

Deno.test("regex engine compiler: rejects permanently unsupported syntax", () => {
  const unsupportedPatterns = [
    String.raw`(?=a)`,
    String.raw`(?!a)`,
    String.raw`(?<=a)`,
    String.raw`(?<!a)`,
    String.raw`\1`,
    String.raw`\9`,
    String.raw`\k<name>`,
    "a*+",
    "a++",
    "a?+",
    "a{2,4}+",
  ];
  for (const pattern of unsupportedPatterns) {
    assertEquals(
      scanPattern(pattern, 1).status,
      REGEX_STATUS.UNSUPPORTED,
      pattern,
    );
  }
});

Deno.test("regex engine compiler: rejects malformed lexical structures", () => {
  const malformedPatterns = [
    ")",
    "(",
    "[",
    "\\",
    "(?x)",
    "(?<>)",
  ];
  for (const pattern of malformedPatterns) {
    assertEquals(
      scanPattern(pattern, 1).status,
      REGEX_STATUS.SYNTAX_ERROR,
      pattern,
    );
  }
});

Deno.test("regex engine compiler: capture limits exclude noncapturing groups", () => {
  const captures = `${"(a)".repeat(REGEX_LIMIT.MAX_CAPTURE_GROUPS)}(?:b)`;
  assertEquals(scanPattern(captures, 1).status, REGEX_STATUS.OK);
  assertEquals(
    scanPattern(`${captures}(c)`, 1).status,
    REGEX_STATUS.LIMIT_EXCEEDED,
  );
  assertEquals(scanPattern("(?:a)".repeat(64), 1).status, REGEX_STATUS.OK);
});

Deno.test("regex engine compiler: validates alternation and simple quantifiers", () => {
  const validPatterns = [
    "a*?b+|c?",
    "(ab)+",
    "(?:a|)*",
    String.raw`\*+`,
    "^a+$",
    "a??",
  ];
  for (const pattern of validPatterns) {
    const uninterrupted = scanPattern(pattern, 100);
    const tinyFuel = scanPattern(pattern, 1);
    assertEquals(tinyFuel, uninterrupted, pattern);
    assertEquals(uninterrupted.status, REGEX_STATUS.OK, pattern);
  }
});

Deno.test("regex engine compiler: measures normal Pike transitions", () => {
  const cases = [
    { pattern: "abc", instructionCount: 6, lastAtomInstructionCount: 1 },
    { pattern: "a*", instructionCount: 5, lastAtomInstructionCount: 2 },
    { pattern: "(?:ab)+", instructionCount: 6, lastAtomInstructionCount: 3 },
    {
      pattern: String.raw`\*+`,
      instructionCount: 5,
      lastAtomInstructionCount: 2,
    },
    { pattern: "^a$", instructionCount: 6, lastAtomInstructionCount: 0 },
    { pattern: "[a-c]+", instructionCount: 5, lastAtomInstructionCount: 2 },
    {
      pattern: "a+|^b?",
      instructionCount: 11,
      lastAtomInstructionCount: 4,
    },
  ];
  for (
    const { pattern, instructionCount, lastAtomInstructionCount } of cases
  ) {
    const uninterrupted = scanPattern(pattern, 100);
    const tinyFuel = scanPattern(pattern, 1);
    assertEquals(tinyFuel, uninterrupted, pattern);
    assertEquals(uninterrupted.status, REGEX_STATUS.OK, pattern);
    assertEquals(uninterrupted.instructionCount, instructionCount, pattern);
    assertEquals(
      uninterrupted.lastAtomInstructionCount,
      lastAtomInstructionCount,
      pattern,
    );
  }
});

Deno.test("regex engine compiler: rejects misplaced and repeated quantifiers", () => {
  const invalidPatterns = [
    "*a",
    "+",
    "?",
    "a**",
    "a+*",
    "a???",
    "^*",
    "$+",
    "(*)",
    "a|*",
  ];
  for (const pattern of invalidPatterns) {
    assertEquals(
      scanPattern(pattern, 1).status,
      REGEX_STATUS.SYNTAX_ERROR,
      pattern,
    );
  }
});

Deno.test("regex engine compiler: parses bounded quantifiers resumably", () => {
  const validPatterns = [
    "a{0}",
    "a{1,}",
    "a{2,4}",
    "a{2,4}?",
    "(ab){32}",
    "a{0002,0003}",
    "{",
    "{x}",
    "a{x}",
  ];
  for (const pattern of validPatterns) {
    const uninterrupted = scanPattern(pattern, 100);
    const tinyFuel = scanPattern(pattern, 1);
    assertEquals(tinyFuel, uninterrupted, pattern);
    assertEquals(uninterrupted.status, REGEX_STATUS.OK, pattern);
  }
  assertEquals(scanPattern("a{2,4}?", 1).quantifierMinimum, 2);
  assertEquals(scanPattern("a{2,4}?", 1).quantifierMaximum, 4);
  assertEquals(scanPattern("a{1,}", 1).quantifierMaximum, 0xffffffff);
});

Deno.test("regex engine compiler: measures captures and bounded quantifiers", () => {
  const cases = [
    { pattern: "(a)", instructionCount: 6, lastAtomInstructionCount: 3 },
    { pattern: "(?<x>a)", instructionCount: 6, lastAtomInstructionCount: 3 },
    { pattern: "(?:a)", instructionCount: 4, lastAtomInstructionCount: 1 },
    { pattern: "(a){2}", instructionCount: 10, lastAtomInstructionCount: 7 },
    { pattern: "a{2,4}", instructionCount: 13, lastAtomInstructionCount: 10 },
    { pattern: "a{1,}", instructionCount: 5, lastAtomInstructionCount: 2 },
    { pattern: "a{0}", instructionCount: 3, lastAtomInstructionCount: 0 },
    {
      pattern: "(ab){32}",
      instructionCount: 162,
      lastAtomInstructionCount: 159,
    },
    { pattern: "(a(b))", instructionCount: 9, lastAtomInstructionCount: 6 },
    { pattern: "(?:)*", instructionCount: 3, lastAtomInstructionCount: 0 },
    { pattern: "(?:){2,4}", instructionCount: 3, lastAtomInstructionCount: 0 },
  ];
  for (
    const { pattern, instructionCount, lastAtomInstructionCount } of cases
  ) {
    const uninterrupted = scanPattern(pattern, 100);
    const tinyFuel = scanPattern(pattern, 1);
    assertEquals(tinyFuel, uninterrupted, pattern);
    assertEquals(uninterrupted.status, REGEX_STATUS.OK, pattern);
    assertEquals(uninterrupted.instructionCount, instructionCount, pattern);
    assertEquals(
      uninterrupted.lastAtomInstructionCount,
      lastAtomInstructionCount,
      pattern,
    );
  }
});

Deno.test("regex engine compiler: exposes exact program allocation", () => {
  const cases = [
    { pattern: "", programBytes: 88 },
    { pattern: "abc", programBytes: 136 },
    { pattern: "[a-c]", programBytes: 112 },
    { pattern: "a{2,4}", programBytes: 248 },
    { pattern: "(?<λ>a)", programBytes: 146 },
    { pattern: "(?<x>a)(?<yz>b)", programBytes: 203 },
  ];
  for (const { pattern, programBytes } of cases) {
    const uninterrupted = scanPattern(pattern, 100);
    const tinyFuel = scanPattern(pattern, 1);
    assertEquals(tinyFuel, uninterrupted, pattern);
    assertEquals(uninterrupted.status, REGEX_STATUS.OK, pattern);
    assertEquals(uninterrupted.programBytes, programBytes, pattern);
  }
});

Deno.test("regex engine compiler: rejects invalid bounded quantifiers", () => {
  const syntaxErrors = [
    "{1}",
    "a{1",
    "a{1x}",
    "a{1,2x}",
    "a{2,1}",
    "a{1,,2}",
    "a{1,2,}",
    "a{1}{2}",
  ];
  for (const pattern of syntaxErrors) {
    assertEquals(
      scanPattern(pattern, 1).status,
      REGEX_STATUS.SYNTAX_ERROR,
      pattern,
    );
  }
  assertEquals(scanPattern("a{4093}", 1).status, REGEX_STATUS.OK);
  assertEquals(
    scanPattern("a{4094}", 1).status,
    REGEX_STATUS.LIMIT_EXCEEDED,
  );
  assertEquals(
    scanPattern("a{4097}", 1).status,
    REGEX_STATUS.LIMIT_EXCEEDED,
  );
  assertEquals(
    scanPattern("a{1,4097}", 1).status,
    REGEX_STATUS.LIMIT_EXCEEDED,
  );
});

Deno.test("regex engine compiler: measures exact character-class ranges", () => {
  const cases = [
    { pattern: "[abc]", rangeCount: 3, negated: 0 },
    { pattern: "[a-c]", rangeCount: 1, negated: 0 },
    { pattern: "[-a]", rangeCount: 2, negated: 0 },
    { pattern: "[a-]", rangeCount: 2, negated: 0 },
    {
      pattern: String.raw`[^a-z\d\w\s]`,
      rangeCount: 16,
      negated: 1,
    },
    { pattern: String.raw`\d\w\s`, rangeCount: 15, negated: 0 },
    {
      // \S inside a class is the 12-range complement of the whitespace set
      pattern: String.raw`[\D\W\S]`,
      rangeCount: 21,
      negated: 0,
    },
  ];
  for (const { pattern, rangeCount, negated } of cases) {
    const uninterrupted = scanPattern(pattern, 100);
    const tinyFuel = scanPattern(pattern, 1);
    assertEquals(tinyFuel, uninterrupted, pattern);
    assertEquals(uninterrupted.status, REGEX_STATUS.OK, pattern);
    assertEquals(uninterrupted.rangeCount, rangeCount, pattern);
    assertEquals(uninterrupted.classNegated, negated, pattern);
  }
});

Deno.test("regex engine compiler: rejects invalid and excessive class ranges", () => {
  const invalidPatterns = [
    "[z-a]",
    String.raw`[a-\d]`,
    String.raw`[a-\w]`,
  ];
  for (const pattern of invalidPatterns) {
    assertEquals(
      scanPattern(pattern, 1).status,
      REGEX_STATUS.SYNTAX_ERROR,
      pattern,
    );
  }
  assertEquals(
    scanPattern(String.raw`\w`.repeat(257), 100).status,
    REGEX_STATUS.LIMIT_EXCEEDED,
  );
  assertEquals(
    scanPattern(String.raw`\w`.repeat(256), 100).status,
    REGEX_STATUS.OK,
  );
});

function compileForMatch(pattern, flags = 0, grant = 0xffff) {
  const memory = new WebAssembly.Memory({
    initial: 4,
    maximum: 32,
    shared: true,
  });
  const exports = instantiateRegexSync(memory).exports;
  const patternAddress = 256;
  const scanAddress = 2048;
  const programAddress = 8192;
  const emissionAddress = 16384;
  const encodedPattern = new TextEncoder().encode(pattern);
  new Uint8Array(memory.buffer).set(encodedPattern, patternAddress);
  const scanCapacity = exports.scan_workspace_size(encodedPattern.length);
  let scanStatus;
  for (let calls = 0; calls < 100000; calls++) {
    [scanStatus] = exports.scan_pattern(
      patternAddress, encodedPattern.length, scanAddress, scanCapacity,
      calls === 0 ? 1 : 0, grant,
    );
    if (scanStatus !== REGEX_STATUS.PAUSED) break;
  }
  assertEquals(scanStatus, REGEX_STATUS.OK, pattern);
  const programBytes = exports.measured_program_size(
    scanAddress,
    scanCapacity,
    encodedPattern.length,
  );
  assertEquals(
    exports.initialize_program_emission(
      scanAddress,
      scanCapacity,
      encodedPattern.length,
      programAddress,
      programBytes,
      flags,
    ),
    REGEX_STATUS.OK,
    pattern,
  );
  const emissionBytes = exports.emission_workspace_size(encodedPattern.length);
  assertEquals(
    exports.initialize_emission_workspace(
      scanAddress,
      scanCapacity,
      encodedPattern.length,
      programAddress,
      programBytes,
      emissionAddress,
      emissionBytes,
    ),
    REGEX_STATUS.OK,
    pattern,
  );
  let emitStatus;
  for (let calls = 0; calls < 100000; calls++) {
    [emitStatus] = exports.emit_pattern(emissionAddress, emissionBytes, grant);
    if (emitStatus !== REGEX_STATUS.PAUSED) break;
  }
  assertEquals(emitStatus, REGEX_STATUS.OK, pattern);
  const words = new Uint32Array(memory.buffer);
  return {
    memory,
    exports,
    programAddress,
    programBytes,
    scanAddress,
    scanCapacity,
    emissionAddress,
    emissionBytes,
    instructionCount: words[
      programAddress / 4 + REGEX_PROGRAM.HEADER.INSTRUCTION_COUNT / 4
    ],
    captureGroupCount: words[
      programAddress / 4 + REGEX_PROGRAM.HEADER.CAPTURE_GROUP_COUNT / 4
    ],
    guardSlots: words[
      programAddress / 4 + REGEX_PROGRAM.HEADER.GUARD_SLOTS / 4
    ],
  };
}

const MATCH_INPUT_ADDRESS = 24576;
const MATCH_CONTINUATION_ADDRESS = 32768;

function initializeMatch(compiled, input, options = {}) {
  const { startByte = 0, startScalar = 0 } = options;
  const encodedInput = input instanceof Uint8Array
    ? input
    : new TextEncoder().encode(input);
  new Uint8Array(compiled.memory.buffer).set(encodedInput, MATCH_INPUT_ADDRESS);
  const continuationBytes = compiled.exports.continuation_size(
    compiled.instructionCount,
    compiled.captureGroupCount,
    compiled.guardSlots,
  );
  const status = compiled.exports.initialize_match(
    compiled.programAddress,
    compiled.programBytes,
    MATCH_INPUT_ADDRESS,
    encodedInput.length,
    startByte,
    startScalar,
    MATCH_CONTINUATION_ADDRESS,
    continuationBytes,
  );
  return { status, continuationBytes };
}

function readMatchResult(compiled) {
  const words = new Uint32Array(compiled.memory.buffer);
  const headerWord = MATCH_CONTINUATION_ADDRESS / 4;
  const captures = [];
  const candidateWord = headerWord + REGEX_CONTINUATION.HEADER_SIZE / 4;
  for (
    let slot = 0;
    slot < (compiled.captureGroupCount + 1) * 2;
    slot++
  ) {
    const value = words[candidateWord + slot];
    captures.push(value === REGEX_CONTINUATION.NO_POSITION ? null : value);
  }
  const endByte = words[
    headerWord + REGEX_CONTINUATION.HEADER.MATCH_END_BYTE / 4
  ];
  const endScalar = words[
    headerWord + REGEX_CONTINUATION.HEADER.MATCH_END_SCALAR / 4
  ];
  return {
    captures,
    matchEndByte: endByte === REGEX_CONTINUATION.NO_POSITION ? null : endByte,
    matchEndScalar: endScalar === REGEX_CONTINUATION.NO_POSITION
      ? null
      : endScalar,
  };
}

function runMatch(pattern, input, options = {}) {
  const { flags = 0, fuel = 0xffff } = options;
  const compiled = compileForMatch(pattern, flags);
  const { status: initStatus, continuationBytes } = initializeMatch(
    compiled,
    input,
    options,
  );
  if (initStatus !== REGEX_STATUS.OK) return { status: initStatus };
  let status;
  let grants = 0;
  do {
    let fuelRemaining;
    [status, fuelRemaining] = compiled.exports.run_match(
      MATCH_CONTINUATION_ADDRESS,
      continuationBytes,
      fuel,
    );
    grants++;
  } while (status === REGEX_STATUS.PAUSED);
  return {
    status,
    totalFuel: BigInt.asUintN(64, compiled.exports.match_work_charged(MATCH_CONTINUATION_ADDRESS)),
    grants,
    ...readMatchResult(compiled),
  };
}

Deno.test("regex engine vm: initialize_match validates every dependency", () => {
  const compiled = compileForMatch("a(b)");
  const encodedInput = new TextEncoder().encode("ab");
  new Uint8Array(compiled.memory.buffer).set(encodedInput, MATCH_INPUT_ADDRESS);
  const continuationBytes = compiled.exports.continuation_size(
    compiled.instructionCount,
    compiled.captureGroupCount,
    compiled.guardSlots,
  );
  assertEquals(
    compiled.exports.initialize_match(
      compiled.programAddress,
      compiled.programBytes,
      MATCH_INPUT_ADDRESS,
      encodedInput.length,
      0,
      0,
      MATCH_CONTINUATION_ADDRESS,
      continuationBytes - 1,
    ),
    REGEX_STATUS.BUFFER_TOO_SMALL,
  );
  assertEquals(
    compiled.exports.initialize_match(
      compiled.programAddress,
      compiled.programBytes,
      MATCH_INPUT_ADDRESS,
      encodedInput.length,
      3,
      3,
      MATCH_CONTINUATION_ADDRESS,
      continuationBytes,
    ),
    REGEX_STATUS.INVALID_UTF8,
  );
  assertEquals(
    compiled.exports.initialize_match(
      compiled.programAddress,
      compiled.programBytes,
      MATCH_INPUT_ADDRESS,
      encodedInput.length,
      1,
      2,
      MATCH_CONTINUATION_ADDRESS,
      continuationBytes,
    ),
    REGEX_STATUS.INVALID_UTF8,
  );
  assertEquals(
    compiled.exports.initialize_match(
      compiled.programAddress,
      compiled.programBytes,
      MATCH_INPUT_ADDRESS,
      encodedInput.length,
      0,
      0,
      MATCH_INPUT_ADDRESS + 1,
      continuationBytes,
    ),
    REGEX_STATUS.CORRUPT_PROGRAM,
  );
  const words = new Uint32Array(compiled.memory.buffer);
  const magicWord = compiled.programAddress / 4;
  words[magicWord] = 0;
  assertEquals(
    compiled.exports.initialize_match(
      compiled.programAddress,
      compiled.programBytes,
      MATCH_INPUT_ADDRESS,
      encodedInput.length,
      0,
      0,
      MATCH_CONTINUATION_ADDRESS,
      continuationBytes,
    ),
    REGEX_STATUS.CORRUPT_PROGRAM,
  );
  words[magicWord] = REGEX_PROGRAM.MAGIC;
  assertEquals(
    compiled.exports.initialize_match(
      compiled.programAddress,
      compiled.programBytes,
      MATCH_INPUT_ADDRESS,
      encodedInput.length,
      0,
      0,
      MATCH_CONTINUATION_ADDRESS,
      continuationBytes,
    ),
    REGEX_STATUS.OK,
  );
  const headerWord = MATCH_CONTINUATION_ADDRESS / 4;
  assertEquals(
    words[headerWord + REGEX_CONTINUATION.HEADER.MAGIC / 4],
    REGEX_CONTINUATION.MAGIC,
  );
  assertEquals(
    words[headerWord + REGEX_CONTINUATION.HEADER.PHASE / 4],
    REGEX_CONTINUATION.PHASE.POSITION,
  );
  assertEquals(
    words[headerWord + REGEX_CONTINUATION.HEADER.INSTRUCTION_COUNT / 4],
    compiled.instructionCount,
  );
  assertEquals(
    words[headerWord + REGEX_CONTINUATION.HEADER.CAPTURE_GROUP_COUNT / 4],
    compiled.captureGroupCount,
  );
});

Deno.test("regex engine vm: rejects start offsets inside an encoding", () => {
  assertEquals(
    runMatch(".", "€a", { startByte: 1, startScalar: 1 }).status,
    REGEX_STATUS.INVALID_UTF8,
  );
  assertEquals(
    runMatch(".", "€a", { startByte: 3, startScalar: 1 }).status,
    REGEX_STATUS.MATCH,
  );
});

Deno.test("regex engine vm: matches leftmost-first literal spans", () => {
  const found = runMatch("abc", "xxabcabc");
  assertEquals(found.status, REGEX_STATUS.MATCH);
  assertEquals(found.captures, [2, 5]);
  assertEquals(found.matchEndByte, 5);
  assertEquals(found.matchEndScalar, 5);
  assertEquals(runMatch("abc", "abx").status, REGEX_STATUS.NO_MATCH);
  assertEquals(runMatch("a", "").status, REGEX_STATUS.NO_MATCH);
  const empty = runMatch("(?:)", "");
  assertEquals(empty.status, REGEX_STATUS.MATCH);
  assertEquals(empty.captures, [0, 0]);
});

Deno.test("regex engine vm: orders alternation by source priority", () => {
  assertEquals(runMatch("a|ab", "ab").captures, [0, 1]);
  assertEquals(runMatch("ab|a", "ab").captures, [0, 2]);
  assertEquals(runMatch("b|a", "ab").captures, [0, 1]);
  // Empty branches participate in priority order like any other branch.
  assertEquals(runMatch("|z", "z").captures, [0, 0]);
  assertEquals(runMatch("z|", "x").captures, [0, 0]);
  assertEquals(runMatch("a||b", "b").captures, [0, 0]);
  assertEquals(runMatch("x(a||b)y", "xy").captures, [0, 2, 1, 1]);
});

Deno.test("regex engine vm: encodes greedy and lazy behavior in branch order", () => {
  assertEquals(runMatch("a*", "aaa").captures, [0, 3]);
  assertEquals(runMatch("a*?", "aaa").captures, [0, 0]);
  assertEquals(runMatch("a+?", "aaa").captures, [0, 1]);
  assertEquals(runMatch("a{2,3}", "aaaa").captures, [0, 3]);
  assertEquals(runMatch("a{2,3}?", "aaaa").captures, [0, 2]);
  assertEquals(runMatch("a*", "bbb").captures, [0, 0]);
  assertEquals(runMatch("a{2}", "a").status, REGEX_STATUS.NO_MATCH);
});

Deno.test("regex engine vm: preserves capture precedence", () => {
  const optional = runMatch("(a)(b)?", "ab");
  assertEquals(optional.captures, [0, 2, 0, 1, 1, 2]);
  const missing = runMatch("(a)(b)?", "ax");
  assertEquals(missing.captures, [0, 1, 0, 1, null, null]);
  const repeated = runMatch("(a|b)+", "ab");
  assertEquals(repeated.captures, [0, 2, 1, 2]);
  const nested = runMatch("(a(b))c", "abc");
  assertEquals(nested.captures, [0, 3, 0, 2, 1, 2]);
  const named = runMatch("(?<first>a)(?<second>b)", "ab");
  assertEquals(named.captures, [0, 2, 0, 1, 1, 2]);
  const participatingEmpty = runMatch("(a*)b", "b");
  assertEquals(participatingEmpty.captures, [0, 1, 0, 0]);
});

Deno.test("regex engine vm: clears iteration captures like JavaScript", () => {
  // A later iteration taking a different branch leaves earlier-iteration
  // groups unset, exactly as JavaScript's RepeatMatcher clears them.
  assertEquals(
    runMatch("((a)|(b))*", "ab").captures,
    [0, 2, 1, 2, null, null, 1, 2],
  );
  assertEquals(
    runMatch("((a)|(b))+", "ba").captures,
    [0, 2, 1, 2, 1, 2, null, null],
  );
  assertEquals(
    runMatch("((a)|(b)){2}", "ab").captures,
    [0, 2, 1, 2, null, null, 1, 2],
  );
  assertEquals(
    runMatch("((a)?b)+", "abb").captures,
    [0, 3, 2, 3, null, null],
  );
  assertEquals(
    runMatch("((a)|(b)){1,3}", "bab").captures,
    [0, 3, 2, 3, null, null, 2, 3],
  );
  // The winning thread's own iteration still keeps its captures.
  assertEquals(
    runMatch("((a)|(b))*", "ba").captures,
    [0, 2, 1, 2, 1, 2, null, null],
  );
  // Zero iterations leave every contained group unset.
  assertEquals(
    runMatch("((a)|(b))*", "x").captures,
    [0, 0, null, null, null, null, null, null],
  );
});

Deno.test("regex engine vm: quantifies noncapturing alternation groups", () => {
  // The group's entry is its alternation split; quantifier wrapping must
  // target that entry, not the group's lowest instruction index.
  assertEquals(runMatch("(?:a|b)*", "").captures, [0, 0]);
  assertEquals(runMatch("(?:a|b)*", "ab").captures, [0, 2]);
  assertEquals(runMatch("(?:a|b)*", "cab").captures, [0, 0]);
  assertEquals(runMatch("(?:a|b)+", "ba").captures, [0, 2]);
  assertEquals(runMatch("(?:a|b)?", "b").captures, [0, 1]);
  assertEquals(runMatch("(?:a|b)?", "c").captures, [0, 0]);
  assertEquals(runMatch("(?:a|b){2}", "ab").captures, [0, 2]);
  assertEquals(runMatch("(?:a|b){2}", "cb").status, REGEX_STATUS.NO_MATCH);
  assertEquals(runMatch("(?:a|b){1,2}", "bb").captures, [0, 2]);
  assertEquals(runMatch("(?:ab|c)*", "abc").captures, [0, 3]);
  assertEquals(runMatch("(?:(?:a|b))*", "ab").captures, [0, 2]);
  assertEquals(runMatch("x|(?:a|b)", "b").captures, [0, 1]);
  assertEquals(runMatch("(?:)*", "x").captures, [0, 0]);
  assertEquals(runMatch("(?:){2,4}", "x").captures, [0, 0]);
  assertEquals(runMatch("(?:)*?", "x").captures, [0, 0]);
});

Deno.test("regex engine vm: anchors follow multiline flags", () => {
  assertEquals(runMatch("^b", "ab").status, REGEX_STATUS.NO_MATCH);
  assertEquals(
    runMatch("^b", "a\nb", { flags: REGEX_FLAG.MULTILINE }).captures,
    [2, 3],
  );
  assertEquals(
    runMatch("^b", "a\rb", { flags: REGEX_FLAG.MULTILINE }).captures,
    [2, 3],
  );
  assertEquals(runMatch("a$", "ab").status, REGEX_STATUS.NO_MATCH);
  assertEquals(runMatch("a$", "ba").captures, [1, 2]);
  assertEquals(
    runMatch("a$", "a\nb", { flags: REGEX_FLAG.MULTILINE }).captures,
    [0, 1],
  );
  assertEquals(runMatch("^a", "ba", { startByte: 1, startScalar: 1 }).status,
    REGEX_STATUS.NO_MATCH);
  assertEquals(
    runMatch("^b", "a\nb", {
      flags: REGEX_FLAG.MULTILINE,
      startByte: 2,
      startScalar: 2,
    }).captures,
    [2, 3],
  );
});

Deno.test("regex engine vm: discards empty optional iterations", () => {
  // JavaScript's RepeatMatcher fails an optional iteration that consumed
  // nothing, so the group never participates.
  assertEquals(runMatch("(a*)?", "").captures, [0, 0, null, null]);
  assertEquals(runMatch("(a*)?", "c").captures, [0, 0, null, null]);
  assertEquals(runMatch("(a*)?", "aa").captures, [0, 2, 0, 2]);
  assertEquals(runMatch("(a?)?", "").captures, [0, 0, null, null]);
  assertEquals(runMatch("(a*)??", "a").captures, [0, 0, null, null]);
  assertEquals(runMatch("(a*){0,2}", "b").captures, [0, 0, null, null]);
  assertEquals(runMatch("(b|a*)?", "c").captures, [0, 0, null, null]);
  assertEquals(runMatch("((?:)|x)?", "y").captures, [0, 0, null, null]);
  // Mandatory iterations keep their empty matches.
  assertEquals(runMatch("(a*){1,2}", "b").captures, [0, 0, 0, 0]);
  assertEquals(runMatch("(a*){2}", "b").captures, [0, 0, 0, 0]);
  // Nonempty optional iterations still participate and can repeat.
  assertEquals(runMatch("(?:a?){3}", "aa").captures, [0, 2]);
  assertEquals(runMatch("(?:a{0,2}){2}", "aaa").captures, [0, 3]);
  assertEquals(runMatch("a{0,2}(?:b|.{2})", "aa").captures, [0, 2]);
});

Deno.test("regex engine vm: dot and classes honor dotAll and ignoreCase", () => {
  assertEquals(runMatch(".", "\n").status, REGEX_STATUS.NO_MATCH);
  assertEquals(runMatch(".", "\r").status, REGEX_STATUS.NO_MATCH);
  assertEquals(
    runMatch(".", "\n", { flags: REGEX_FLAG.DOT_ALL }).captures,
    [0, 1],
  );
  assertEquals(
    runMatch("aB", "Ab", { flags: REGEX_FLAG.IGNORE_CASE }).captures,
    [0, 2],
  );
  assertEquals(runMatch("aB", "Ab").status, REGEX_STATUS.NO_MATCH);
  assertEquals(
    runMatch("[a-z]+", "AbC", { flags: REGEX_FLAG.IGNORE_CASE }).captures,
    [0, 3],
  );
  assertEquals(
    runMatch("[^a]", "A", { flags: REGEX_FLAG.IGNORE_CASE }).status,
    REGEX_STATUS.NO_MATCH,
  );
  assertEquals(runMatch("[^a]", "A").captures, [0, 1]);
  assertEquals(runMatch(String.raw`\d+`, "ab123").captures, [2, 5]);
  assertEquals(runMatch(String.raw`[\w-]+`, "a_b-1").captures, [0, 5]);
});

Deno.test("regex engine vm: sticky matches never restart past the start", () => {
  assertEquals(
    runMatch("b", "ab", { flags: REGEX_FLAG.STICKY }).status,
    REGEX_STATUS.NO_MATCH,
  );
  assertEquals(
    runMatch("b", "ab", {
      flags: REGEX_FLAG.STICKY,
      startByte: 1,
      startScalar: 1,
    }).captures,
    [1, 2],
  );
  assertEquals(
    runMatch("a*", "bbb", { flags: REGEX_FLAG.STICKY }).captures,
    [0, 0],
  );
});

Deno.test("regex engine vm: reports byte spans over Unicode scalars", () => {
  const euro = runMatch("€+", "x€€y");
  assertEquals(euro.captures, [1, 7]);
  assertEquals(euro.matchEndScalar, 3);
  const supplementary = runMatch(".", "𐍈");
  assertEquals(supplementary.captures, [0, 4]);
  assertEquals(supplementary.matchEndScalar, 1);
  assertEquals(runMatch("[à-ÿ]", "xé").captures, [1, 3]);
  assertEquals(
    runMatch("é", "É", { flags: REGEX_FLAG.IGNORE_CASE }).status,
    REGEX_STATUS.NO_MATCH,
  );
  assertEquals(
    runMatch("b", new Uint8Array([0x61, 0xff, 0x62])).status,
    REGEX_STATUS.INVALID_UTF8,
  );
});

Deno.test("regex engine vm: tiny fuel grants replay identical results", () => {
  const cases = [
    { pattern: "a*", input: "aaab" },
    { pattern: "(a|b)+?c", input: "ababc" },
    { pattern: "(?<word>\\w+) (?<again>\\w+)", input: "one two" },
    { pattern: "x", input: "aaaa" },
    { pattern: "^a$", input: "a" },
  ];
  for (const { pattern, input } of cases) {
    const uninterrupted = runMatch(pattern, input);
    assertEquals(uninterrupted.grants, 1, pattern);
    const tinyFuel = runMatch(pattern, input, { fuel: 1 });
    assertEquals(
      { ...tinyFuel, grants: 0 },
      { ...uninterrupted, grants: 0 },
      pattern,
    );
  }
});

Deno.test("regex engine vm: completed matches replay their final status", () => {
  const compiled = compileForMatch("a");
  const { continuationBytes } = initializeMatch(compiled, "za");
  const [status, fuelRemaining] = compiled.exports.run_match(
    MATCH_CONTINUATION_ADDRESS,
    continuationBytes,
    0xffff,
  );
  assertEquals(status, REGEX_STATUS.MATCH);
  assertEquals(
    compiled.exports.run_match(
      MATCH_CONTINUATION_ADDRESS,
      continuationBytes,
      7,
    ),
    [REGEX_STATUS.MATCH, 7],
  );
  assertEquals(fuelRemaining > 0, true);
});

Deno.test("regex engine vm: rejects corrupt continuations and drifted programs", () => {
  const compiled = compileForMatch("a(b)");
  const { continuationBytes } = initializeMatch(compiled, "ab");
  const words = new Uint32Array(compiled.memory.buffer);
  const headerWord = MATCH_CONTINUATION_ADDRESS / 4;
  assertEquals(
    compiled.exports.run_match(
      MATCH_CONTINUATION_ADDRESS,
      continuationBytes - 1,
      5,
    )[0],
    REGEX_STATUS.BUFFER_TOO_SMALL,
  );
  words[headerWord + REGEX_CONTINUATION.HEADER.MAGIC / 4] = 7;
  assertEquals(
    compiled.exports.run_match(
      MATCH_CONTINUATION_ADDRESS,
      continuationBytes,
      5,
    )[0],
    REGEX_STATUS.CORRUPT_PROGRAM,
  );
  words[headerWord + REGEX_CONTINUATION.HEADER.MAGIC / 4] =
    REGEX_CONTINUATION.MAGIC;
  words[headerWord + REGEX_CONTINUATION.HEADER.PHASE / 4] = 9;
  assertEquals(
    compiled.exports.run_match(
      MATCH_CONTINUATION_ADDRESS,
      continuationBytes,
      5,
    )[0],
    REGEX_STATUS.CORRUPT_PROGRAM,
  );
  words[headerWord + REGEX_CONTINUATION.HEADER.PHASE / 4] =
    REGEX_CONTINUATION.PHASE.POSITION;
  words[headerWord + REGEX_CONTINUATION.HEADER.CURRENT_CURSOR / 4] = 3;
  assertEquals(
    compiled.exports.run_match(
      MATCH_CONTINUATION_ADDRESS,
      continuationBytes,
      5,
    )[0],
    REGEX_STATUS.CORRUPT_PROGRAM,
  );
  words[headerWord + REGEX_CONTINUATION.HEADER.CURRENT_CURSOR / 4] = 0;
  const flagsWord = compiled.programAddress / 4 +
    REGEX_PROGRAM.HEADER.FLAGS / 4;
  words[flagsWord] = REGEX_FLAG.STICKY;
  assertEquals(
    compiled.exports.run_match(
      MATCH_CONTINUATION_ADDRESS,
      continuationBytes,
      5,
    )[0],
    REGEX_STATUS.CORRUPT_PROGRAM,
  );
  words[flagsWord] = 0;
  const [status] = compiled.exports.run_match(
    MATCH_CONTINUATION_ADDRESS,
    continuationBytes,
    0xffff,
  );
  assertEquals(status, REGEX_STATUS.MATCH);
});


Deno.test("regex work: wide scan totals saturate only on unsigned overflow", () => {
  const compiled = compileForMatch("x");
  const { exports: x, memory, scanAddress: ws, scanCapacity } = compiled;
  const view = new DataView(memory.buffer);
  const h = REGEX_COMPILER.SCAN;
  for (const seed of [0xffffffffn, 0x8000000000000000n, 0xfffffffffffffffen]) {
    assertEquals(x.scan_pattern(256, 1, ws, scanCapacity, 1, 0)[0], REGEX_STATUS.PAUSED);
    view.setBigUint64(ws + h.WORK_CHARGED, seed, true);
    view.setBigUint64(ws + h.WORK_PENDING, 0n, true);
    const [status, remaining] = x.scan_pattern(256, 1, ws, scanCapacity, 0, 1);
    assertEquals(status, REGEX_STATUS.OK);
    const delta = BigInt(1 - remaining);
    assertEquals(delta >= 3n, true); // transition, examined byte, measured atom
    const overflow = seed + delta > 0xffffffffffffffffn;
    assertEquals(BigInt.asUintN(64, x.scan_work_charged(ws)), overflow ? 0xffffffffffffffffn : seed + delta);
    assertEquals(x.scan_work_overflow(ws), Number(overflow));
    const before = x.scan_work_charged(ws);
    assertEquals(x.scan_pattern(256, 1, ws, scanCapacity, 0, 1)[0], REGEX_STATUS.OK);
    assertEquals(x.scan_work_charged(ws), before);
    assertEquals(x.scan_work_overflow(ws), Number(overflow));
  }
});

Deno.test("regex work: expansion, fixups and program checks are grant-independent", () => {
  const pattern = "(?:(a)|b){32}";
  const whole = compileForMatch(pattern);
  const tiny = compileForMatch(pattern, 0, 1);
  assertEquals(
    new Uint8Array(tiny.memory.buffer, tiny.programAddress, tiny.programBytes),
    new Uint8Array(whole.memory.buffer, whole.programAddress, whole.programBytes),
  );
  const charged = (c) => BigInt.asUintN(64, c.exports.emission_work_charged(c.emissionAddress));
  assertEquals(charged(tiny), charged(whole));
  assertEquals(charged(whole) > BigInt(whole.instructionCount * 2), true);
  assertEquals(tiny.exports.scan_work_charged(tiny.scanAddress), whole.exports.scan_work_charged(whole.scanAddress));
  assertEquals(tiny.exports.emission_work_overflow(tiny.emissionAddress), 0);
  const [status, work, overflow] = whole.exports.validate_program_work(whole.programAddress, whole.programBytes);
  assertEquals(status, REGEX_STATUS.OK);
  assertEquals(BigInt.asUintN(64, work) >= BigInt(whole.instructionCount), true);
  assertEquals(overflow, 0);
});

Deno.test("regex work: failed setup retains inspected work without poisoning reusable inputs", () => {
  const c = compileForMatch("(?<name>a){8}");
  const x = c.exports;
  const before = BigInt.asUintN(64, x.scan_work_charged(c.scanAddress));
  assertEquals(x.initialize_program_emission(c.scanAddress, c.scanCapacity, new TextEncoder().encode("(?<name>a){8}").length, c.programAddress, 0, 0), REGEX_STATUS.BUFFER_TOO_SMALL);
  assertEquals(BigInt.asUintN(64, x.scan_work_charged(c.scanAddress)) > before, true);
  const init = initializeMatch(c, "a", { startByte: 2, startScalar: 0 });
  assertEquals(init.status, REGEX_STATUS.INVALID_UTF8);
  assertEquals(BigInt.asUintN(64, x.match_work_charged(MATCH_CONTINUATION_ADDRESS)) >= BigInt(c.instructionCount), true);
  assertEquals(x.match_work_overflow(MATCH_CONTINUATION_ADDRESS), 0);
  assertEquals(x.run_match(MATCH_CONTINUATION_ADDRESS, init.continuationBytes, 100)[0], REGEX_STATUS.CORRUPT_PROGRAM);
  assertEquals(x.validate_program(c.programAddress, c.programBytes), REGEX_STATUS.OK);
});

Deno.test("regex work: restored match debt clamps without source overflow and survives relocation", () => {
  const c = compileForMatch("(a|b)+c");
  const { continuationBytes, status } = initializeMatch(c, "aabc");
  assertEquals(status, REGEX_STATUS.OK);
  const h = REGEX_CONTINUATION.HEADER;
  const view = new DataView(c.memory.buffer);
  const seed = 0x8000000000000000n;
  view.setBigUint64(MATCH_CONTINUATION_ADDRESS + h.WORK_CHARGED, seed, true);
  view.setBigUint64(MATCH_CONTINUATION_ADDRESS + h.WORK_PENDING, 0x100000000n, true);
  assertEquals(c.exports.run_match(MATCH_CONTINUATION_ADDRESS, continuationBytes, 1), [REGEX_STATUS.PAUSED, -2147483648]);
  assertEquals(c.exports.match_work_overflow(MATCH_CONTINUATION_ADDRESS), 0);
  assertEquals(BigInt.asUintN(64, c.exports.match_work_charged(MATCH_CONTINUATION_ADDRESS)), seed);
  const relocated = MATCH_CONTINUATION_ADDRESS + continuationBytes + 8;
  new Uint8Array(c.memory.buffer).copyWithin(relocated, MATCH_CONTINUATION_ADDRESS, MATCH_CONTINUATION_ADDRESS + continuationBytes);
  // Reinstantiation discards every transient global. Only the copied state
  // can preserve debt, captures, search position and the unsigned total.
  const restored = instantiateRegexSync(c.memory).exports;
  let result;
  for (let calls = 0; calls < 10000; calls++) {
    [result] = restored.run_match(relocated, continuationBytes, 1);
    if (result !== REGEX_STATUS.PAUSED) break;
  }
  assertEquals(result, REGEX_STATUS.MATCH);
  assertEquals(BigInt.asUintN(64, restored.match_work_charged(relocated)) > seed, true);
  assertEquals(restored.match_work_overflow(relocated), 0);
  assertEquals(Array.from(new Uint32Array(c.memory.buffer, relocated + REGEX_CONTINUATION.HEADER_SIZE, 2)), [0, 4]);
  view.setUint32(relocated + h.VERSION, 1, true);
  assertEquals(restored.run_match(relocated, continuationBytes, 1)[0], REGEX_STATUS.CORRUPT_PROGRAM);
});

Deno.test("regex work: program setup debt follows emission without duplicate source charge", () => {
  const c = compileForMatch("a");
  const x = c.exports;
  const expected = new Uint8Array(c.memory.buffer, c.programAddress, c.programBytes).slice();
  assertEquals(x.initialize_program_emission(c.scanAddress, c.scanCapacity, 1, c.programAddress, c.programBytes, 0), REGEX_STATUS.OK);
  const view = new DataView(c.memory.buffer);
  view.setBigUint64(c.scanAddress + REGEX_COMPILER.SCAN.WORK_PENDING, 0x100000000n, true);
  assertEquals(x.initialize_emission_workspace(c.scanAddress, c.scanCapacity, 1, c.programAddress, c.programBytes, c.emissionAddress, c.emissionBytes), REGEX_STATUS.OK);
  const before = x.emission_work_charged(c.emissionAddress);
  assertEquals(x.emit_pattern(c.emissionAddress, c.emissionBytes, 1), [REGEX_STATUS.PAUSED, -2147483648]);
  assertEquals(x.emission_work_charged(c.emissionAddress), before);
  assertEquals(x.emission_work_overflow(c.emissionAddress), 0);
  assertEquals(x.emit_pattern(c.emissionAddress, c.emissionBytes, 1000)[0], REGEX_STATUS.OK);
  assertEquals(new Uint8Array(c.memory.buffer, c.programAddress, c.programBytes), expected);
  view.setUint32(c.emissionAddress + REGEX_COMPILER.EMIT.VERSION, 1, true);
  assertEquals(x.emit_pattern(c.emissionAddress, c.emissionBytes, 1)[0], REGEX_STATUS.CORRUPT_PROGRAM);
  view.setUint32(c.scanAddress + REGEX_COMPILER.SCAN.VERSION, 1, true);
  assertEquals(x.scan_pattern(256, 1, c.scanAddress, c.scanCapacity, 0, 1)[0], REGEX_STATUS.CORRUPT_PROGRAM);
});

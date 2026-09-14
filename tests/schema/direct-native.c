/* Test-only outer host. Build/run instructions live in tools/run-schema-native-proof.js.
 * Wasmtime v36.0.2 C API: https://github.com/bytecodealliance/wasmtime/tree/v36.0.2/crates/c-api/include
 * No WASI, host functions, schema driver, linear-memory writes or host growth.
 * The three raw modules and all fixtures are loaded from the current directory.
 */
#include <wasmtime.h>
#include <errno.h>
#include <inttypes.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

#if WASMTIME_VERSION_MAJOR != 36 || WASMTIME_VERSION_MINOR != 0 || WASMTIME_VERSION_PATCH != 2
#error "This runner targets the stock Wasmtime 36.0.2 C API"
#endif
#if !defined(WASMTIME_FEATURE_THREADS) || !defined(WASMTIME_FEATURE_COMPILER)
#error "Wasmtime C API must include threads and a compiler (not the min release)"
#endif

static void fail(const char *message) {
  fprintf(stderr, "direct-native: %s\n", message);
  exit(EXIT_FAILURE);
}

static void checked(wasmtime_error_t *error, wasm_trap_t *trap, const char *where) {
  if (!error && !trap) return;
  wasm_byte_vec_t message;
  if (error) wasmtime_error_message(error, &message);
  else wasm_trap_message(trap, &message);
  fprintf(stderr, "direct-native: %s: ", where);
  fwrite(message.data, 1, message.size, stderr);
  fputc('\n', stderr);
  wasm_byte_vec_delete(&message);
  if (error) wasmtime_error_delete(error);
  if (trap) wasm_trap_delete(trap);
  exit(EXIT_FAILURE);
}

static wasmtime_module_t *load(wasm_engine_t *engine, const char *path) {
  FILE *file = fopen(path, "rb");
  if (!file) {
    fprintf(stderr, "direct-native: %s: %s\n", path, strerror(errno));
    exit(EXIT_FAILURE);
  }
  if (fseek(file, 0, SEEK_END)) fail("cannot seek module");
  long length = ftell(file);
  if (length < 8 || (uintmax_t)length > SIZE_MAX) fail("invalid module size");
  rewind(file);
  uint8_t *bytes = malloc((size_t)length);
  if (!bytes) fail("module allocation failed");
  if (fread(bytes, 1, (size_t)length, file) != (size_t)length || ferror(file))
    fail("cannot read complete module");
  if (fclose(file)) fail("cannot close module");
  if (memcmp(bytes, "\0asm\1\0\0\0", 8)) fail("expected raw WebAssembly v1 binary");
  wasmtime_module_t *module = NULL;
  wasmtime_error_t *error = wasmtime_module_new(engine, bytes, (size_t)length, &module);
  free(bytes);
  checked(error, NULL, path);
  return module;
}

static bool named(const wasm_name_t *name, const char *literal) {
  return name->size == strlen(literal) && !memcmp(name->data, literal, name->size);
}

static bool identifier(const wasm_name_t *name) {
  if (!name->size || name->size > INT32_MAX) return false;
  for (size_t i = 0; i < name->size; ++i) {
    unsigned char c = (unsigned char)name->data[i];
    if (!(c == '_' || (c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z') ||
          (c >= '0' && c <= '9'))) return false;
  }
  return true;
}

/* Audit all modules before creating any instance. Only env.memory and genuine
 * exports of an already-loaded engine can satisfy an import. Wasmtime checks
 * exact function types again during instantiation. */
static uint64_t audit(wasmtime_module_t *module, unsigned lane, const char *label) {
  wasm_importtype_vec_t imports;
  wasmtime_module_imports(module, &imports);
  unsigned memories = 0, schema_functions = 0;
  uint64_t minimum = 0;
  for (size_t i = 0; i < imports.size; ++i) {
    const wasm_name_t *space = wasm_importtype_module(imports.data[i]);
    const wasm_name_t *name = wasm_importtype_name(imports.data[i]);
    const wasm_externtype_t *type = wasm_importtype_type(imports.data[i]);
    if (!identifier(space) || !identifier(name)) fail("invalid import identifier");
    printf("import %s %.*s.%.*s kind=%u\n", label, (int)space->size, space->data,
           (int)name->size, name->data, (unsigned)wasm_externtype_kind(type));
    if (wasm_externtype_kind(type) == WASM_EXTERN_MEMORY &&
        named(space, "env") && named(name, "memory")) {
      const wasm_memorytype_t *memory = wasm_externtype_as_memorytype_const(type);
      uint64_t maximum = 0;
      minimum = wasmtime_memorytype_minimum(memory);
      if (++memories != 1 || wasmtime_memorytype_is64(memory) ||
          !wasmtime_memorytype_isshared(memory) ||
          !wasmtime_memorytype_maximum(memory, &maximum) || maximum != 16384 ||
          minimum < 1 || minimum > maximum || (lane < 2 && minimum != 1))
        fail("incompatible shared memory declaration");
      continue;
    }
    if (wasm_externtype_kind(type) != WASM_EXTERN_FUNC || lane == 0 ||
        !(named(space, "regex") || (lane == 2 && named(space, "schema"))))
      fail("forbidden import (no WASI, host callbacks or other namespaces)");
    if (named(space, "schema")) ++schema_functions;
  }
  wasm_importtype_vec_delete(&imports);
  if (memories != 1 || (lane == 2 && schema_functions == 0))
    fail("missing shared memory or direct schema imports");
  return minimum;
}

static wasmtime_instance_t instantiate(wasmtime_context_t *context,
    wasmtime_module_t *module, wasmtime_sharedmemory_t *memory,
    const wasmtime_instance_t *regex, const wasmtime_instance_t *schema,
    const char *label) {
  wasm_importtype_vec_t types;
  wasmtime_module_imports(module, &types);
  wasmtime_extern_t *imports = calloc(types.size, sizeof(*imports));
  if (!imports) fail("import allocation failed");
  for (size_t i = 0; i < types.size; ++i) {
    const wasm_name_t *space = wasm_importtype_module(types.data[i]);
    const wasm_name_t *name = wasm_importtype_name(types.data[i]);
    if (named(space, "env")) {
      imports[i].kind = WASMTIME_EXTERN_SHAREDMEMORY;
      imports[i].of.sharedmemory = wasmtime_sharedmemory_clone(memory);
    } else {
      const wasmtime_instance_t *provider = named(space, "regex") ? regex : schema;
      if (!provider || !wasmtime_instance_export_get(context, provider,
          name->data, name->size, &imports[i])) fail("missing genuine engine export");
      if (imports[i].kind != WASMTIME_EXTERN_FUNC) fail("engine export is not a function");
    }
  }
  wasm_trap_t *trap = NULL;
  wasmtime_instance_t instance;
  wasmtime_error_t *error = wasmtime_instance_new(context, module, imports,
      types.size, &instance, &trap);
  for (size_t i = 0; i < types.size; ++i) wasmtime_extern_delete(&imports[i]);
  free(imports);
  wasm_importtype_vec_delete(&types);
  checked(error, trap, label);
  printf("linked %s\n", label);
  return instance;
}

static wasmtime_func_t function(wasmtime_context_t *context,
    const wasmtime_instance_t *instance, const char *name, size_t parameters) {
  wasmtime_extern_t item;
  if (!wasmtime_instance_export_get(context, instance, name, strlen(name), &item))
    fail("missing harness export");
  if (item.kind != WASMTIME_EXTERN_FUNC) fail("harness export is not a function");
  wasmtime_func_t func = item.of.func;
  wasm_functype_t *type = wasmtime_func_type(context, &func);
  const wasm_valtype_vec_t *args = wasm_functype_params(type);
  const wasm_valtype_vec_t *results = wasm_functype_results(type);
  if (args->size != parameters || results->size != 1 ||
      wasm_valtype_kind(results->data[0]) != WASM_I32)
    fail("harness export signature mismatch");
  for (size_t i = 0; i < args->size; ++i)
    if (wasm_valtype_kind(args->data[i]) != WASM_I32)
      fail("harness argument signature mismatch");
  wasm_functype_delete(type);
  wasmtime_extern_delete(&item);
  return func;
}

static uint32_t call(wasmtime_context_t *context, const wasmtime_func_t *func,
    const wasmtime_val_t *args, size_t count, const char *name) {
  wasmtime_val_t result;
  wasm_trap_t *trap = NULL;
  wasmtime_error_t *error = wasmtime_func_call(context, func, args, count, &result, 1, &trap);
  checked(error, trap, name);
  if (result.kind != WASMTIME_I32) fail("non-i32 harness result");
  return (uint32_t)result.of.i32;
}

static uint32_t u32(const uint8_t *p) {
  return (uint32_t)p[0] | ((uint32_t)p[1] << 8) | ((uint32_t)p[2] << 16) |
      ((uint32_t)p[3] << 24);
}

int main(int argc, char **argv) {
  (void)argv;
  if (argc != 1) fail("run without arguments from the source-free bundle directory");
  setvbuf(stdout, NULL, _IOLBF, 0);
  printf("runtime Wasmtime %s; no host functions; link order regex,schema,direct-proof\n",
         WASMTIME_VERSION);
  wasm_config_t *config = wasm_config_new();
  if (!config) fail("configuration allocation failed");
  wasmtime_config_wasm_threads_set(config, true);
  wasmtime_config_wasm_bulk_memory_set(config, true);
  wasmtime_config_wasm_multi_value_set(config, true);
  wasmtime_config_wasm_multi_memory_set(config, false);
  wasmtime_config_wasm_memory64_set(config, false);
  wasm_engine_t *engine = wasm_engine_new_with_config(config);
  if (!engine) fail("engine allocation failed");
  const char *names[] = {"regex.wasm", "schema.wasm", "direct-proof.wasm"};
  wasmtime_module_t *modules[3];
  uint64_t initial = 1;
  for (unsigned i = 0; i < 3; ++i) {
    modules[i] = load(engine, names[i]);
    uint64_t minimum = audit(modules[i], i, names[i]);
    if (minimum > initial) initial = minimum;
  }
  wasm_memorytype_t *type = wasmtime_memorytype_new(initial, true, 16384, false, true);
  if (!type) fail("memory type allocation failed");
  wasmtime_sharedmemory_t *memory = NULL;
  checked(wasmtime_sharedmemory_new(engine, type, &memory), NULL, "shared memory");
  wasm_memorytype_delete(type);
  printf("memory shared32 initial=%" PRIu64 " maximum=16384 pages\n", initial);
  wasmtime_store_t *store = wasmtime_store_new(engine, NULL, NULL);
  if (!store) fail("store allocation failed");
  wasmtime_context_t *context = wasmtime_store_context(store);
  wasmtime_instance_t regex = instantiate(context, modules[0], memory, NULL, NULL, names[0]);
  wasmtime_instance_t schema = instantiate(context, modules[1], memory, &regex, NULL, names[1]);
  wasmtime_instance_t proof = instantiate(context, modules[2], memory, &regex, &schema, names[2]);
  wasmtime_func_t count_fn = function(context, &proof, "case_count", 0);
  wasmtime_func_t run_fn = function(context, &proof, "run_case", 1);
  wasmtime_func_t pointer_fn = function(context, &proof, "result_pointer", 0);
  wasmtime_func_t size_fn = function(context, &proof, "result_size", 0);
  uint32_t cases = call(context, &count_fn, NULL, 0, "case_count");
  if (cases == 0 || cases > INT32_MAX) fail("invalid case_count");
  for (uint32_t id = 0; id < cases; ++id) {
    wasmtime_val_t argument = {.kind = WASMTIME_I32, .of.i32 = (int32_t)id};
    /* Exactly one scenario entry. All engine work and resource handling is WAT. */
    uint32_t returned = call(context, &run_fn, &argument, 1, "run_case");
    uint32_t pointer = call(context, &pointer_fn, NULL, 0, "result_pointer");
    uint32_t size = call(context, &size_fn, NULL, 0, "result_size");
    size_t available = wasmtime_sharedmemory_data_size(memory);
    if (size != 32 || (uint64_t)pointer + size > available)
      fail("out-of-bounds or incompatible outer result");
    /* Refresh the native view after run_case's possible memory.grow. Never
     * decode engine programs, continuations, messages or schema input here. */
    const uint8_t *record = wasmtime_sharedmemory_data(memory) + pointer;
    uint32_t observed_id = u32(record), status = u32(record + 4);
    uint32_t assertion = u32(record + 8), expected = u32(record + 12);
    uint32_t phase = u32(record + 16), reserved = u32(record + 20);
    uint64_t consumed = u32(record + 24) | ((uint64_t)u32(record + 28) << 32);
    printf("case=%" PRIu32 " status=%" PRIu32 " assertion=%" PRIu32
           " expected=%" PRIu32 " phase=%" PRIu32 " consumed=%" PRIu64
           " returned=%" PRIu32 "\n", observed_id, status, assertion, expected,
           phase, consumed, returned);
    if (returned || assertion || observed_id != id || status != expected ||
        status > 12 || status == 1 || phase > 8 || reserved)
      fail("case assertion or inconsistent outer result");
    if (call(context, &count_fn, NULL, 0, "case_count") != cases)
      fail("case_count changed during execution");
  }
  printf("PASS %" PRIu32 " direct-WASM scenarios in a native process\n", cases);
  wasmtime_store_delete(store);
  wasmtime_sharedmemory_delete(memory);
  for (unsigned i = 0; i < 3; ++i) wasmtime_module_delete(modules[i]);
  wasm_engine_delete(engine);
  return EXIT_SUCCESS;
}

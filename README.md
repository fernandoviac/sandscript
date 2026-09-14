# SandScript

SandScript is a sandboxed language and WebAssembly runtime for executing a
defined subset of JavaScript under explicit host control. Programs request named
host capabilities with `grant` blocks. The host can approve, deny, or revoke
each capability. SandScript removes ambient authority and language behavior that
prevents bounded execution, inspection, persistence, or replay.

A SandScript program has no filesystem, network, clock, process, or application
access unless its host supplies that access through an explicit capability. The
host owns execution. It decides which context runs, how much fuel it gets, which
capabilities exist, and when suspended work resumes.

SandScript is intended for code that must remain under host control:

- generated programs that must not inherit the host's authority;
- long-lived programs that pause, resume, and survive snapshot and restore;
- programs whose instructions, scopes, pending work, grants, and resource use
  must remain observable; and
- application extensions that need explicit denial and revocation behavior.

The relevant alternatives are a Worker or a V8 isolate. SandScript gives the
host complete control and observation of execution, memory, and external
resources. External access uses the built-in grant system instead of ambient
runtime authority. Each drone also runs within a host-defined memory bound; it
cannot grow an independent JavaScript heap without that bound. An idle
SandScript drone uses roughly one-tenth of the memory of an idle V8 isolate, and
some configurations reduce idle memory to about one-twentieth.

## The language boundary

SandScript uses JavaScript syntax plus the `grant` statement. It supports a
defined subset of JavaScript and rejects syntax or operations outside that
subset.

The language includes ordinary bindings, functions, classes, arrays, objects,
control flow, exceptions, promises, generators, maps, sets, and selected
standard-library operations. SandScript deliberately does not provide ambient
module loading or host globals.

A capability request names both its accepted and denied paths:

```javascript
grant "documents" {
  let document = Documents.read("current");
  document.title = "Reviewed";
} denied (reason) {
  Result.publish({ updated: false, reason });
}
```

`Documents` and `Result` exist only if the host declares them and associates
them with the accepted grant. Revocation removes access from subsequent
operations. Host values cross the interpreter boundary through explicit handles
and a membrane rather than becoming ambient globals.

## Execution model

Execution is cooperative and fuel-bounded. The host gives one context a fuel
amount. The interpreter returns when the program completes, consumes that fuel,
requests an external operation, waits for asynchronous work, or fails. It never
silently schedules another context. The host owns the drive loop and every
resume decision.

The runtime can preserve the complete SandScript state as bytes. This includes
the heap, scopes, instruction positions, suspended contexts, grants, and
interpreter-side closure handles. The host remains responsible for its own
resources and must reconnect host-side handlers after restore.

Persisted artifacts carry explicit format versions. An incompatible artifact
must be migrated or rejected; the runtime does not guess its layout.

## Install

Use Node 22 or later or Bun 1.3 or later:

```sh
npm install sandscript
```

```sh
bun add sandscript
```

The runtime uses shared WebAssembly memory and `SharedArrayBuffer`. Browser
hosts must supply the isolation policy required for shared memory.

The canonical distribution is the immutable ES module set at
`https://cdn.urania-libs.com`. The npm package is a convenience distribution of
the same plain runtime modules for Node and Bun.

## Host runtime

The package root and `sandscript/runtime` export the maintained runtime driver:

```javascript
import { Runtime } from "sandscript";
```

`Runtime` composes a prepared interpreter session, inbound and outbound
channels, declared capabilities, host services, and subsystems. It owns boot,
driving, grant fan-out, background work, quiescence, snapshot coordination,
relocation, and shutdown after construction.

The host must prepare the session and channels before it constructs `Runtime`.
This is intentional: memory allocation, persistence, transport, scheduling, and
authority remain host decisions. SandScript does not create an implicit process
or event loop around the program.

## Standalone JSON Schema engine

SandScript's JSON Schema implementation is also available to host applications
without loading the interpreter:

```javascript
import { createSchemaEngine } from "sandscript/schema";

const engine = createSchemaEngine();
const schema = engine.compile({
  type: "object",
  required: ["kind"],
  properties: {
    kind: { const: "example" },
  },
  additionalProperties: false,
});

schema.test({ kind: "example" }); // true

const result = schema.validate({ kind: "wrong" });
console.log(result.valid); // false
console.log(result.errors);

schema.dispose();
```

The engine supports JSON Schema 2020-12, 2019-09, draft-07, and draft-04. It
accepts JavaScript values, MessagePack bytes, and JSON text. Compiled schemas
can be tested, validated, asserted, serialized as program bytes, loaded again,
and disposed. Schema compilation and validation can use explicit fuel and memory
limits.

The engine refuses behavior that it cannot evaluate correctly. Examples include
regular-expression constructs outside SandScript's regular-expression dialect
and IDN hostname or email checks that require unavailable IDNA tables.

## Package entries

- `sandscript` — the maintained host runtime;
- `sandscript/runtime` — the same runtime entry explicitly; and
- `sandscript/schema` — the standalone JSON Schema engine.

Fuel internals, membrane internals, generated WebAssembly modules, the local
`sand` command, and test helpers are not separate public package entries.

## Status and license

SandScript is experimental. Its supported language, runtime, capability,
persistence, and schema contracts are tested, but releases can make explicit
format cutovers. Invalid inputs and unsupported behavior fail loudly rather than
receiving an approximate result.

Copyright 2026 DevBlanket AB. Licensed under the Apache License, Version 2.0.
The license does not grant permission to use the SandScript or DevBlanket names
to identify a modified product as an official offering.

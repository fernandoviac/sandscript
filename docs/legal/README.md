# SandScript legal material

## Project license and copyright

Copyright 2026 DevBlanket AB.

SandScript's programme-authored software is licensed under the
[Apache License, Version 2.0](../../LICENSE). The root [NOTICE](../../NOTICE)
records the copyright owner and public trademark boundary.

## Third-party material

`src/fuel/interpreter.wat` contains portions of transcendental-math
function implementations adapted from V8. The required V8 BSD-style notice,
source location, and conditions are preserved verbatim in
[`legal/THIRD-PARTY-NOTICES`](../../legal/THIRD-PARTY-NOTICES).

`fixtures/json-schema-test-suite/` vendors the official JSON Schema Test
Suite (MIT, Julian Berman) as the conformance oracle for the schema engine;
see its `PROVENANCE.md` and the notice in
[`legal/THIRD-PARTY-NOTICES`](../../legal/THIRD-PARTY-NOTICES). Test
fixtures only; not part of any shipped artifact.

`deno.json` declares no runtime third-party package imports. Deno's own
runtime and tooling are not redistributed by this repository.

## Lean references, adaptations and redistributed artifacts

Lean and lean4export are pinned in
[`tests/proof/lean/oracle-lock.json`](../../tests/proof/lean/oracle-lock.json).
Both repositories declare Apache-2.0 for their source. Exact upstream texts are
retained as [`lean4-LICENSE`](../../legal/lean4-LICENSE) and
[`lean4export-LICENSE`](../../legal/lean4export-LICENSE); upstream Git blob
identities were checked when copying them, and the lock records SHA-256 digests.
Lean's separate [`LICENSES`](../../legal/lean4-LICENSES) collection is also
preserved verbatim. Attribution and applicability are recorded in
[`THIRD-PARTY-NOTICES`](../../legal/THIRD-PARTY-NOTICES).

The offline oracle was built and executed during preparation, but its binaries
and full Init export are not currently vendored. Future redistribution of
Lean-derived artifacts is expected and has the following release requirements:

1. **Track the material, not just the generating tool.** Every imported corpus
   or embedded artifact needs its upstream repository/revision, module and
   source-file inventory, generator revision/options, original and transformed
   hashes, and a description of transformations. Exporter licensing does not
   determine the license of all exported input.
2. **Preserve applicable notices.** Audit the actual source-file headers and
   any subtree licenses/NOTICE files. Retain every relevant copyright, patent,
   trademark and attribution notice; the Prelude header alone does not cover
   all of Init. Keep this inventory alongside the artifact when distributing
   a corpus separately.
3. **Mark adaptations and modifications.** Copied or translated kernel code
   must carry the original applicable notices plus a prominent SandScript
   modification notice identifying the upstream file/revision. A WAT port is
   not treated as attribution-free merely because the implementation language
   changed. For binary data that cannot carry comments, ship a clearly named
   accompanying provenance/modification notice.
4. **Ship the texts with the payload.** Apply Apache-2.0 redistribution
   conditions conservatively to Lean-derived declarations and proof data,
   including compressed or reserialized forms. Do not label those portions as
   solely DevBlanket-authored. Include the relevant license and notices in every
   package, archive, CDN/library set and separately distributed corpus containing
   them; links alone are insufficient. This policy avoids relying on a legal
   conclusion that particular mathematical data is uncopyrightable.
5. **Distinguish source/proof data from a bundled toolchain.** Lean's binary
   LICENSES collection includes LLVM exceptions, GNU C Library LGPL terms,
   GNU MP LGPL terms and other component licenses. Do not assume every component
   appears on every platform, or that Apache-2.0 covers the entire binary.
   Before bundling any compiler/runtime/library, inventory the exact payload
   and satisfy its applicable source availability, replacement/relinking,
   notice and other conditions. Retaining LICENSES alone is not sufficient.
   Binary redistribution needs a release-specific legal review.
6. **Keep marks and warranties separate.** Apache-2.0 does not grant branding
   rights or imply upstream endorsement. Preserve disclaimers; any additional
   warranty is offered on our own behalf, not upstream's.

The library-set allowlist already includes `LICENSE`, `NOTICE` and `legal/**`.
The npm builder and archive checker explicitly include all three pinned Lean
license files. This is license packaging readiness, not permission to add
unreviewed third-party binaries or a claim of blanket legal clearance.

## Trademark boundary

SandScript is a DevBlanket AB programme name. The Apache License grants no
right to use SandScript, DevBlanket, or related marks to identify a modified
or derived product as official.

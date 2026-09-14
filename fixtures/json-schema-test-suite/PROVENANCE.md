# JSON-Schema-Test-Suite

Vendored from <https://github.com/json-schema-org/JSON-Schema-Test-Suite>,
commit `c9510e3bf8a896c3cba4e08509cf752b4f30dff8` (main, fetched
2026-09-04): directories `tests/draft2020-12`, `tests/draft2019-09`,
`tests/draft7`, `tests/draft4`, and `remotes/`. `LICENSE` is the suite's
own (MIT, Julian Berman).

This is the oracle for `tests/fuel/schema_conformance_test.js`. It is the
official conformance corpus for JSON Schema — an authority, not another
implementation. Every case is accounted as conformant or declined with an
explicit reason; a wrong verdict fails the run.

## Why vendored rather than fetched

The test runner is offline and deterministic. Re-vendoring is a
deliberate act: update the commit hash here, re-run the conformance
suite, and record any newly declined cases in the harness.

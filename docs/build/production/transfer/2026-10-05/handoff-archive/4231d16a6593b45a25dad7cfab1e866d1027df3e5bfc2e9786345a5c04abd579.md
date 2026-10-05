# Packaged shutdown modeled evidence guard

This fixture overlay adds an explicit presence and object check before reading the sanitized client evidence. Missing evidence now throws the existing assertion error at the guard, and TypeScript can narrow the returned optional value before the operation identity and SQL checks.

The overlay starts from frozen package4 plus CI2 tree `3e7d2875fc47aba7587aba94c20136cb9ca44bef`. It owns only the existing acceptance test and this handoff. The original 45 source and scalar case identities, their assertions, the native 22 gate identities, the packaged client, and the acceptance harness remain exact. No nonnull assertion or production change is included.

Root's first compiler attempt exhausted its 3 GB heap. Its supported 4 GB retry reached four TS18048 diagnostics at the optional client reads. Both failed attempts remain retained. Root subsequently passed ten genuine default broker and PostgreSQL readback checks on the unchanged package4 implementation; those results do not establish the modeled test or complete package gate.

Author execution remains unrun: no project imports, compiler, lint, tests, services, database, container, package rebuild, install, or commit. B and C independently review this frozen overlay; root integrates it and runs the model tests and compiler serially.

Suggested root commands use the existing pinned Node runtime and locked dependencies:

```sh
PATH=/Users/saivedanthava/.codex/zenith-w8/tools/node-current/bin:$PATH NODE_OPTIONS=--max-old-space-size=4096 node node_modules/typescript/bin/tsc --noEmit --incremental false
PATH=/Users/saivedanthava/.codex/zenith-w8/tools/node-current/bin:$PATH node node_modules/vitest/vitest.mjs run tests/acceptance/packaged-worker.test.ts tests/ci/packaged-workers.test.ts --maxWorkers=1
```

Actual package startup, TLS, wait and drain, native history, recovery, architecture, and accepted provider mutation evidence remain separate root-owned verification work.

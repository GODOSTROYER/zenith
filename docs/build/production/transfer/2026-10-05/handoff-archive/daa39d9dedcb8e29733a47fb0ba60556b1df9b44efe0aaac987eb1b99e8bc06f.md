# Packaged shutdown CI fixture, 2026-10-04

This separate two-path fixture overlay follows the immutable four-path packaged shutdown authority freeze 6c09ac69, patch 70037719, candidate a9e2997d. The predecessor adds a mandatory client-verified native operation identity. The existing CI positive harness record omitted that field, so the strengthened sanitizer would refuse its positive model before checking the existing package verdict. The original source freeze and all runtime failure receipts remain unchanged.

Only tests/ci/packaged-workers.test.ts and this handoff are authored. The positive fixed-schema model now supplies the native default operation ID shape and exact workspace/project/environment, resource absence, capability, user/member and canonical scoped key from the existing control-plane digest. Fourteen additive literal negative cases reject missing, foreign, changed-scope or injected identities. Every prior test title and the existing positive, failed-child, failed-check, private artifact, cleanup, TLS, builder and process assertions remain. The same 22 native package check identities are unchanged.

These are receipt-schema models. They do not create a database operation, execute a worker or establish native identity. The actual image-local client, owning row readback, PostgreSQL, package rebuild and separate native architectures remain root verification tasks. No production source, canonical manifest, report schema or skip allowance changes in this overlay.

Prepared dependencies are the exact clean 09301572 base plus the reviewed four-path source patch. The overlay freeze records every dependent postimage, full inventory, outside-owned hashes and private patch roundtrip. Independent B/C and root review are required before integration. All imports, compiler, lint, tests, services, installs and commits are unrun by this author.

Root runs the pinned compiler and affected model suites serially, then the genuine native readback and complete unchanged package gate:

```sh
export PATH=/Users/saivedanthava/.codex/zenith-w8/tools/node-current/bin:$PATH
node node_modules/typescript/bin/tsc --noEmit
node node_modules/eslint/bin/eslint.js tests/ci/packaged-workers.test.ts
node node_modules/vitest/vitest.mjs run tests/ci/packaged-workers.test.ts tests/acceptance/packaged-worker.test.ts --maxWorkers=1 --no-file-parallelism
```

Successful scalar models cannot replace the original 22 native execution checks, source/image custody or cleanup. Blocked SQL remains a read prerequisite observation, not an accepted provider mutation or consumed-grant/receipt recovery proof.

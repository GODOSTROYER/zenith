# Packaged worker context cleanup correction

This source-only packet is based on `8031ce0db3c61b289512f270ae594a197d055c15`. It changes only `scripts/ci/packaged-worker-native.mjs`, `tests/ci/packaged-workers.test.ts`, and this handoff. No compiler, tests, Docker, services, or package build were run by the author. Independent review and root execution are pending.

The current ARM64 job in GitHub run `37291676663` and both architectures in prior run `37282165340` returned child exit 0 and passed the first 20 packaged-worker checks. Their wrappers failed during final owned cleanup; owned-context absence and baseline preservation remained unverified. The wrapper selected its disposable context through `DOCKER_CONTEXT`, then attempted unforced removal before restoring that override. Docker refuses removal of the selected context. Forcing removal would also risk changing Docker's stored default, so the correction restores only this invocation's environment and freshly verifies the original selected context and metadata fingerprint before exact-owned removal, in both success and finally paths. Existing builder/process settlement, context endpoint/fingerprint checks, exact absence checks, baseline checks, resource limits, and all 22 required identities remain.

The current AMD64 job returned child exit 1 during `actual-packaged-worker`; its sanitized report cannot identify the child failure. This separate failure is unresolved. A distinct diagnostic change admits optional `childFailure` only for a failed, nonzero child in that phase. It contains two finite enums already emitted by the unchanged private child: `phase` and `workerCategory`. Unknown values become `unavailable`; arbitrary payload fields, messages, errors, environment, paths, stdout, and stderr are rejected. Diagnostics are captured only after child commit/source/harness hashes match and platform/run identity matches. They never satisfy a required check or change a failed verdict. Passing execution admission retains its original exact schema.

New source/order models interpret the actual cleanup branch calls with a stateful context-removal model, exercise removal-before-restoration and missing fresh-proof failures, preserve the caller's exact override and unrelated environment, and refuse changed original selection/endpoint/metadata/TLS identity. Additional models cover diagnostic enum parity, unknown/proxy inputs without coercion or callbacks, extra fields, malformed categories, absent/zero children, and passing-verdict refusal. All old test bodies and names remain; these models are not actual Docker or packaged-worker acceptance.

Root verification after independent review:

```sh
npx vitest run tests/ci/packaged-workers.test.ts --maxWorkers=1
npx eslint tests/ci/packaged-workers.test.ts
npx tsc --noEmit
```

On an authorized owned Linux environment, also run the existing actual supervisor cases with `ZENITH_TEST_NATIVE_SUPERVISOR_REQUIRED=1`. Verify exact caller-context restoration, unforced owned-context deletion, owned-resource absence, and baseline preservation with real Docker. Then rerun the unchanged canonical native package command and strict evidence validation on native AMD64 and ARM64, using each architecture's existing hosted workflow prerequisites. Local wrapper admission remains subject to the existing 18 GiB launch floor; this packet lowers no resource bound.

Do not borrow the prior child success as a current package pass. Root must reproduce or diagnose the AMD64 child failure using the new fixed categories and retain the old failed artifacts. Genuine provider mutation, browser approval, production namespace authorization, and accepted-write recovery remain outside this harness proof. No outside-owned source is edited; any subsequent child/runtime repair requires its own bounded source packet.

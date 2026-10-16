# PROD-PKG-01 verification checkpoint — 2026-10-16

Status: **in progress; not fully verified**. No requirement or release status has been promoted.

## Candidate and scope

Reviewed candidate: `e70820e2576dcef0eb3a462d1c9ec25917cf82a8`.
Acceptance: build AMD64 and ARM64 execution-worker images, exercise the actual entrypoint, and distinguish native from emulated execution.
The local branch adds only this evidence checkpoint. Product code, tests, acceptance requirements and required evidence levels are unchanged.

## Existing native CI evidence validated

Original run: https://github.com/GODOSTROYER/zenith/actions/runs/38564102611, attempt 1.
Both artifacts identify the candidate above, native Linux/Docker architectures, Node 22.23.3, child exit zero, all 22 required controls passed, and all six cleanup flags true.

| Architecture | Artifact ID | ZIP SHA-256 | Recorded runtime |
|---|---|---|---|
| AMD64 | 11894076106 | 6f46eabd99df4133611974e88bffe243c8e2e60291f39e7256bcff9b101f270c | 408.085 seconds |
| ARM64 | 11895020344 | 1cc5d19eb94821c054bc84c8b5a2b8c5fcbfbd991ac13dc317de3fa9c60f9329 | 411.957 seconds |

The copied JSON files are unchanged downloaded sanitized receipts. Archive digests matched GitHub metadata. Source digest independently recomputed:
`9ad5b30720e95e9bf693413e97dd5fff4fe011a99b5647048481fab1e5e028c8`.
Harness, wrapper, architecture-specific manifest and workflow hashes match the candidate. The repository's published-evidence validator accepted both receipts; supplemental tamper checks rejected altered source/commit/architecture/check/cleanup data. This revalidation is offline and is not a new native execution.

Relevant harness review confirmed a fresh no-cache architecture build and actual inherited worker entrypoint. The acceptance image is a derivative with a fixture client, sharing the production runtime and entrypoint. Source is hashed before/after build, not an immutable build snapshot. No claim is made about cloud mutation, production topology, namespace authorization, or consumed write-grant recovery.

## Contract evidence

The existing exact-candidate CI Verify job reports 411 passing packaged-worker acceptance contract tests and 145 passing packaged-workers CI contract tests. The accompanying excerpt identifies the source commit and paths; it is not a substitute for a structured release receipt.
Source: https://github.com/GODOSTROYER/zenith/actions/runs/38564102900/job/115852292113.
Fresh local contract execution is recorded separately when it reaches a terminal result. An earlier local attempt was interrupted by executor transport recovery and produced no final test report; it is not counted as a pass.

## Blocking acceptance condition

The current ledger requires `contract`, `local_linux_arm64`, and `local_linux_amd64`. Both downloaded native runs are **remote CI**, not local execution. They must not be relabeled. The verifier handoff requires every listed level on one coherent commit; the release validator also requires original source mode to match the declared level.

The current cloud VM is x86-64 with no Docker executable/socket observed. It cannot supply fresh native ARM64 evidence or execute the Docker acceptance harness as currently provisioned.

To close the unchanged requirement, obtain exact-candidate local-native receipts for both architectures, or run on explicitly authorized native Linux environments meeting the canonical prerequisites (Node 22.23.3, matching local Unix-socket Docker, 12 GiB host/Docker RAM, 8 GiB available RAM and 18 GiB free space floors). Reusing independently validated current local receipts is acceptable; older or emulated receipts are not a replacement for the missing level.

Any change to accept remote CI in place of local-native evidence is an explicit acceptance-policy decision, not verification under the current criteria. No such change has been made. Raw native artifacts also require honest provenance-bound release receipt packaging before release-dossier use; the originals remain intact.

No new CI runs, pushes, PRs, cloud resources, account logins, production signoffs, or unrelated requirement work were performed.

## Fresh local contract result

Node 22.23.3; npm lockfile installation with lifecycle scripts disabled. Product source and assertions unchanged. Command:

```sh
NODE_OPTIONS="--disable-warning=UNDICI-EHPA" node node_modules/vitest/vitest.mjs run tests/acceptance/packaged-worker.test.ts tests/ci/packaged-workers.test.ts --no-file-parallelism --maxWorkers=1 --reporter=default --reporter=json --outputFile=<report-path>
```

Final result: **556 passed, 0 failed, 0 skipped**, two files; reported duration 26.80 seconds. This is contract evidence, not Docker/native worker execution. The current checkout has only documentation/evidence additions relative to the candidate; executable source is unchanged.

Attempt R2 was **553 passed / 3 failed**. All three differences were an additional Node `UNDICI-EHPA` experimental proxy-agent warning in exact stderr assertions. R3 suppresses only that named runtime warning; it leaves the proxy configuration, all application stderr, assertions, and other warnings intact. Both full JSON results are retained. No product-code fix was needed for this environment-specific diagnostic noise. The initial interrupted attempt remains not verified.

The final result does not close the missing local-native image evidence. Requirement state remains in progress. No later serial requirement has been started.

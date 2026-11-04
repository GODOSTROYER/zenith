# J2 default operated journey (PKG-05)

Implementation complete, verification pending. No browser, Docker, PostgreSQL,
Temporal, kind or cloud acceptance was run on the Windows builder. This harness
requires `ZENITH_DEFAULT_JOURNEY=1`; collection and disabled invocation have no
credential or engine access. No platform migration, application code, dependency
metadata, generated aggregate or gate assertion is changed.

## Files and acceptance mapping

| Acceptance | Real path and check |
| --- | --- |
| Actual J1 composition | `support.mjs` imports J1 `readState/compose/readiness`, checks the installer head, source content hash, dirty flag and lean profile, and uses its actual Supabase Auth and API. |
| Two real operators, Auth admin and Mailpit | Create two unique confirmed local Auth users through admin; send recovery mail, require each recipient and an Auth verification link in real Mailpit; sign in through the password UI and check Auth's returned user id. Mail delivery is exercised; admin confirmation, rather than mail-link redemption, establishes these disposable identities. |
| Shared workspace with independent authority | A creates an isolated workspace; A invites B as admin and B accepts through the real sharing API. No database role seeding or demo identity. |
| Browser proposal | Actual pending-changes review, typed production confirmation and Request approval button; require a workflow-backed deployment and an operation requested by A. |
| A cannot self-approve | UI disabled; real approval endpoint returns `403 separation_of_duties` at the initial and concrete-plan gates. |
| Bearer cannot forge human approval | Already-consented valid linked credential is refused by the human endpoint; authoritative operation remains pending. |
| Exact plan semantics | Require saved plan and executable-semantics hashes from the actual worker; B's deliberately mismatched semantics hash returns `409 semantics_mismatch`, leaving approval pending. B approves through the real approval card, which submits the reviewed hashes. |
| Independent kind proof | Browser deployment followed by REST scale to two and MCP scale to one; each proposal requires B's UI approval and each dispatch uses the existing workflow caller. A separate observer kubeconfig checks deployment image, generation, available replicas and actual HTTP nonce through the deployed witness. |
| REST and MCP proposals | REST calls the capability endpoint as the same bounded linked integration; MCP calls `zenith_scale_service`. Both dispatch via `zenith_execute_approved_operation`, the reachable integration dispatch seam. REST proposal does not claim a separate REST execute endpoint. |
| Customer zenithd consent and execution | A's same-origin enrollment-token API consent pins environment/address. A real outbound zenithd container registers and heartbeats. A publishes a signed raw-command runbook, requests it, cannot self-approve; B clicks Approve this run. Every step must succeed. A separate docker exec reads the local marker. |
| Credentials and model results | One runtime-generated fake local credential is mounted only in the customer fixture; witness emits its bearer shape. Real, nonempty MCP operation events must omit it. Host-side scans inspect CP container environments, application files and a bounded real logical dump of J1's owned product/authority PostgreSQL without sending the canary to SQL or a CP process. |
| Connection rotation | Stage/verify a second local ServiceAccount token reference, explicitly promote, delete the old ServiceAccount in the owned cluster, execute a new scale and independently read two replicas/HTTP nonce. |
| Revocation without fallback | Approve a pending scale before terminal browser UI revocation; read back its saved revoked state, then actually attempt dispatch. A named connection-authority refusal or real terminal failed workflow with the unusable/revoked connection reason is required. Server/protocol outages fail. Independent readback must remain at two replicas. Verification must refuse with a revocation reason. Revoked zenithd must stop. |
| Sanitized ledger evidence | `receipt.mjs` emits only fixed check/status vocabularies, validated commit/source/readback hashes and bounded runtime versions. No emails, identities, cookies, headers, keys, secrets, home paths, commands, mail or raw diagnostic payloads. Dirty rehearsal evidence cannot be attached to the ledger as coherent-commit proof. |

The Playwright spec is `tests/e2e/default/journey.spec.mjs`. Unit/gate tests are
`tests/e2e/default/receipt.test.ts` (contract evidence only).
`prepare.mjs` creates a new named local kind fixture and refuses an existing
`zenith-j2`; it never uses the operator's default kubeconfig. The observer is
independent of both deployer identities. `engines.mjs` labels and validates each
customer container/volume before cleanup. The shared Go witness has no provider
SDK, shell execution or external HTTP destination.

## Required assembly joins

1. **J1:** merge its `scripts/acceptance/default-stack/**` first. Required CLI:
   `up.mjs --directory <private-new-dir> --profile lean`; its existing
   `cleanup.mjs --directory <dir>` is the down seam. Preserve `state.json`
   (`source.head/contentSha256/dirty`, `applicationProjectName`), private
   `input.json` (`environment.NEXT_PUBLIC_SITE_URL/SUPABASE_URL/SUPABASE_SERVICE_ROLE_KEY`),
   and exported `readState/compose/readiness`. Engines must use the same committed
   source as the harness. The scripts import these seams, not test replacements.
2. **Mailpit:** the inspected J1 worktree currently uses Supabase Inbucket,
   not Mailpit. J1/assembly must supply a digest-pinned local Mailpit and direct
   GoTrue SMTP to it. Require Mailpit's real `/api/v1/messages` and
   `/api/v1/message/:id`. The harness deliberately does not treat Inbucket or
   a fake inbox as a pass. Keep SMTP on an isolated owned Docker network;
   publish the inbox only on loopback. Mailpit can use port 8025, distinct
   from the current Inbucket port 54324.
3. **Playwright runner:** base package.json has playwright-core only.
   `@playwright/test` and its CLI are absent. Assembly must add a pinned,
   audited compatible test runner; this job was forbidden to edit package files
   or install. The wrapper refuses missing runners without npx downloading one.
   Mac installs the browser only after dependency assembly.
4. **J3:** preserve actual MFA/step-up admission when merged. The current base
   password/approval UI has no MFA challenge. Extend operator enrollment and
   challenge interaction to the final J3 UI before full joined acceptance;
   do not disable MFA or relax approval guards to run this spec.
5. **J4/J1:** the operated stack must naturally claim approved runbook runs and
   deliver signed machine steps. This harness does not bypass scheduling through
   an internal tick, fake grant or a direct machine executor.
6. **J7:** this leg exercises real Kubernetes connections and zenithd enrollment,
   not AWS/GCP/Azure/OCI runner-mode connection creation. Those lifecycle joins
   remain J7's tests; append their real default runner journey before claiming
   LIFE-01 or MACH-05 verified across all supported modes.
7. **J11:** supply approved native ARM64 kind-node, Go-builder, distroless and
   Mailpit digests. No moving tag is supplied by this harness.
8. Merge ledger edits by requirement id, keeping existing evidence. Assembly
   owns any generated requirement document/gate registration. No migration or
   schema need is introduced.
9. **J10/J13:** retain the real stateless MCP v3 initialization/tool envelopes
   and exact grant visibility. Join namespace/resource ownership through the
   final connection/deployment interface; a fixture namespace must not receive
   an admission bypass. J5 updates, J8 cost reconciliation and J9 plugin
   lifecycle remain their separate acceptance lanes.

## Mac: prepare and run (one heavy operation at a time)

Run on native macOS ARM64, Node 22, Docker with 4 GiB, an 8 GiB host and at least
J1's 22 GiB free disk floor. Use the integrated RC. Variables below are operator
inputs from the approved image lock, not invented digests. The commands refuse
unset inputs. All directory inputs are private fresh paths outside the source.
Choose canonical parent paths for the target directory (macOS `/var` commonly
aliases `/private/var`); `prepare.mjs` rejects symlink parents. It canonicalizes
the existing J1 stack directory, and the wrapper canonicalizes its own temp root.
Supabase HTTPS must resolve `supabase.localhost` to loopback and its private CA
must be trusted by Node and Chromium. Install the CA using J1's local trust
runbook; do not set `NODE_TLS_REJECT_UNAUTHORIZED=0`, ignoreHTTPSErrors or global
certificate-error bypasses. Do not use real account credentials.

```bash
export PATH="$HOME/.local/sdk/node22:$PATH"
test "$(node -p 'process.versions.node.split(".")[0]')" = 22
test "$(uname -m)" = arm64
: "${GO_BUILDER_IMAGE:?approved ARM64 digest required}"
: "${DISTROLESS_IMAGE:?approved ARM64 digest required}"
: "${KIND_NODE_IMAGE:?approved ARM64 digest required}"
: "${J2_STACK:?fresh J1 private stack directory required}"
: "${J2_TARGETS:?fresh private target directory required}"
: "${J2_MAILPIT_URL:?real local Mailpit inbox origin required}"
export ZENITH_DEFAULT_JOURNEY=1 ZENITH_ACCEPTANCE_DEFAULT_STACK=1

# Build the witness before starting the stack/kind, to keep compiler memory isolated.
docker build -f tests/e2e/default/zenithd.Dockerfile \
  --build-arg GO_BUILDER_IMAGE="$GO_BUILDER_IMAGE" \
  --build-arg DISTROLESS_IMAGE="$DISTROLESS_IMAGE" \
  -t localhost:5000/zenith-j2-witness:rc .

# J1 starts the local registry as well as the actual operated composition.
node scripts/acceptance/default-stack/up.mjs --directory "$J2_STACK" --profile lean

# Configure/verify J1's joined Mailpit SMTP and trusted browser CA before proceeding.
export NODE_EXTRA_CA_CERTS="$J2_STACK/tls/ca.crt"
# This push is only to J1's disposable local loopback registry, never a cloud registry.
docker push localhost:5000/zenith-j2-witness:rc
J2_WITNESS_IMAGE="$(docker image inspect localhost:5000/zenith-j2-witness:rc --format '{{index .RepoDigests 0}}')"
node tests/e2e/default/prepare.mjs --directory "$J2_TARGETS" --stack "$J2_STACK" \
  --node-image "$KIND_NODE_IMAGE" --witness-image "$J2_WITNESS_IMAGE" \
  --mailpit-url "$J2_MAILPIT_URL"

# Only after assembly has installed the pinned @playwright/test dependency:
npx --no-install playwright install chromium
npx --no-install playwright test --config tests/e2e/default/playwright.config.mjs --list
node scripts/acceptance/default-journey.mjs \
  --config "$J2_TARGETS/journey.json" --receipt "$J2_TARGETS/default-journey.json"

# Expected: 16 passed /0 failed /0 skipped /0 not_run checks, process exit 0.
# ledgerEligible is true only for a clean native RC; productionReady is always false.
# Copy ONLY the sanitized receipt into the source after the run:
mkdir -p docs/build/production/evidence/PROD-PKG-05
cp "$J2_TARGETS/default-journey.json" docs/build/production/evidence/PROD-PKG-05/default-journey.json
```

The preparation helper joins only the newly created kind control-plane container
to J1's owned installation network; the certificate-checked Kubernetes endpoint
is `https://zenith-j2-control-plane:6443`. It seeds two separate ServiceAccounts
with namespace-bound workload permissions and get/patch/update on the exact
`zenith-j2` namespace. It loads the same digest-pinned witness into kind's
containerd without a cloud image registry. The legacy kubeconfig connection is
explicit; it does not pretend to test scoped guest credential minting.

Lean planned caps: J1's lean composition, one kind node capped at 640 MiB/one CPU,
one zenithd at 96 MiB, no parallel target/workflow execution, one Chromium worker
on the host. Build images before running the engines. These are unmeasured local
budgets, not proof of fit, HA or production sizing. OOM, an unavailable source,
failed health/permission checks and timeouts must fail the run; do not relax
assertions. ARM64 builder compilation can be limited further with GOMAXPROCS=2
and GOMEMLIMIT=512MiB in the Dockerfile build stage.

Cleanup after success OR failure (the helper refused a preexisting cluster):
```bash
set -euo pipefail
# Spec cleanup revokes its linked credential, deletes its Auth users, gracefully
# stops its zenithd, and validates ownership labels before removing its volumes.
# If the test process was killed, inspect io.zenith.journey labels and remove
# ONLY resources for this invocation's nonce; retain a failed cleanup check.
# Never delete a preexisting cluster when preparation refused its name.
J2_KIND_ID="$(node -e 'const fs=require("node:fs"); const t=JSON.parse(fs.readFileSync(process.argv[1],"utf8")); if(t.createdBy!=="J2-DEFAULT-JOURNEY" || t.status!=="created" || !/^[a-f0-9]{64}$/.test(t.containerId)) throw Error("owned target absent"); process.stdout.write(t.containerId)' "$J2_TARGETS/targets.json")"
test "$(docker inspect zenith-j2-control-plane --format '{{.Id}}')" = "$J2_KIND_ID"
kind delete cluster --name zenith-j2 --kubeconfig "$J2_TARGETS/kind-bootstrap.yaml"
node scripts/acceptance/default-stack/cleanup.mjs --directory "$J2_STACK"
# Keep only sanitized evidence; target directory contains kubeconfigs and CA material.
# Delete the explicitly chosen owned private target directory using the host's file manager.
```

If kind creation failed before recording `status: created`, this teardown block
refuses deletion. Inspect the failed invocation's Docker resources manually;
do not substitute deletion by a guessed cluster name.

## Builder checks and exact outcomes

Node 22 was prepended for every shell. Commands are recorded here so the report
does not confuse inspection or collection with executed acceptance.

| Command | Outcome |
| --- | --- |
| `npx --no-install vitest run tests/e2e/default/receipt.test.ts --no-file-parallelism --maxWorkers=2` | Initial: 1 file, 15 passed /0 failed /0 skipped. |
| `npx --offline --no-install vitest run tests/e2e/default/receipt.test.ts --no-file-parallelism --maxWorkers=2` | Final: 1 file, 17 passed /0 failed /0 skipped. Repeated after wrapper changes. |
| `npx --no-install eslint scripts/acceptance/default-journey.mjs tests/e2e/default/*.mjs tests/e2e/default/receipt.test.ts` | Initial: 2 unused-import errors /1 expression warning; fixed. |
| `npx --offline --no-install eslint scripts/acceptance/default-journey.mjs tests/e2e/default/*.mjs tests/e2e/default/receipt.test.ts` | Final: 0 errors /0 warnings. Repeated after final source edits. |
| `npx --no-install playwright test --config tests/e2e/default/playwright.config.mjs --list` | Failed before collecting any tests. Runner absent; npm attempted registry metadata resolution, denied EACCES. No package installed. |
| `npx --offline --no-install playwright test --config tests/e2e/default/playwright.config.mjs --list` | Failed before collecting any tests: ENOTCACHED. No network or installation. |
| `bash Z:/Projects/Spawned.ai/zenith-wt/.resume/codex/tsc-serial.sh` | Pass, exit 0, 0 diagnostics. One invocation, including the shared-lock wait; no direct whole-repo tsc invocation. |
| `C:/Users/user/.local/sdk/go/bin/gofmt.exe -w tests/e2e/default/witness.go` | Pass, exit 0. |
| `C:/Users/user/.local/sdk/go/bin/go.exe build -o C:/Users/user/AppData/Local/Temp/zenith-j2-witness-check.exe tests/e2e/default/witness.go` (`GOTOOLCHAIN=local`) | First attempt failed: default Go build-cache write denied. Retry with `GOCACHE=C:/Users/user/AppData/Local/Temp/zenith-j2-go-cache`: pass, exit 0. Windows compile only, no engine/ARM64 image proof or Go tests claimed. |
| `node --check <file>` on the wrapper and six default-journey `.mjs` files | 7 passed /0 failed; repeated after final source edits. |
| `git diff --check` | Pass, exit 0. |
| Read-only ledger comparison against `git show HEAD:docs/build/production/ledger.json` | 5 assigned rows changed /0 unrelated rows /0 evidence or state changes. |
| Actual Playwright run, J1 readiness, target preparation, Docker build, PG/Temporal/kind execution | Not run: needs the Mac engines/browser and joins above. |
| Live clouds | Not run: owner deferred; no live-cloud leg exists in this local harness. |

Read-only discovery included git status, the latest ten commits, PREAMBLE, the
five ledger rows, PLAN-100's requirement/P3/4.1 rows, existing verification notes,
J1 source and the real Auth/browser/connection/broker/runbook callers. No git
mutation occurred. A stalled apply_patch was interrupted after its first two
files had landed; native literal file writes completed the remaining edits.

## Limits and suggested ledger state

Suggested `implementationStatus`: `implementation_complete_verification_pending`.
Never mark any row verified from Windows unit success or list-only collection.

This journey adds default-path evidence; it does not replace all DUR-03 component
mutation/dispatch tests, DUR-04 standing-grant bound tests, all provider/CLI
LIFE-01 tests or all runner/federated credential MACH-05 tests. Run their existing
verification documents separately on the coherent RC. The credential-absence
probe covers the known generated canary in CP environments/application files,
a bounded logical PostgreSQL dump and model-visible events. The dump remains
only in host memory and is never saved in the receipt. This is not a full secret
inventory or evidence that unknown secret shapes are all detected.

First likely joined failures: missing Mailpit/SMTP delivery; MFA challenge changes;
natural runbook claim/step delivery; namespace preexistence/ownership admission;
MCP grant visibility of runbook-step operation events; workload image admission;
customer runner-mode connection seams. These must be fixed by the responsible
owners, or remain explicit failed acceptance checks. The harness does not create
privileged replacement transports, fabricate receipts or skip a joined failure.

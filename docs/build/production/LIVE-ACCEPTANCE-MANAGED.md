# L3 managed, mixed-cloud and release live acceptance

Builder base: `443bfeaf`. This document describes an owner-gated harness, not performed cloud verification. No cloud was called on the Windows builder. `live_sandbox`, `operational_rehearsal` and production signoff remain pending. Acceptance text in `ledger.json` is authoritative; a successful observation is not verification of its entire requirement.

## Entry points and evidence

| Profile | Entry point | Gate | Required scenario catalogue |
| --- | --- | --- | --- |
| Managed | `bash scripts/acceptance/managed-acceptance.sh` | `ZENITH_LIVE_MANAGED=1` | MAN-01 through MAN-07 |
| Mixed | `bash scripts/acceptance/live/mixed/acceptance.sh` | `ZENITH_LIVE_MIXED=1` | MIX-01 through MIX-07 |
| Release | `bash scripts/acceptance/live/release/acceptance.sh` | `ZENITH_LIVE_RELEASE=1` | All required REL-01 journeys and nine OPS rehearsals |

All three call `scripts/acceptance/live/managed/cli.ts`. Strict recipe validation, plan hashing, the existing `scripts/release/scope.ts`, exact-plan approval, journal and budget reservations are in `plan.ts` and `runner.ts`. `transport.ts` contains actual HTTPS, Kubernetes API and AWS/GCP/Azure inventory calls. `mixed/probes.ts` reuses the existing reference traffic generator, independent price/checksum checker and protected-connectivity checker, and adds TLS peer verification to the direct PostgreSQL readback. Nothing falls back to a mock transport in the CLI.

An owner writes a recipe of specific requests and expected JSON-pointer observations. The engine does not invent these from a model or from expected test results. Each step has a stable id, scenario, scope action, exact target, resource binding when it changes anything, attempt count and interval. Assertions compare JSON values without coercion; a missing field never satisfies `null`. HTTP responses, database rows, cookies, kubeconfig, credentials and provider error text are omitted from public evidence. The recipe itself must contain no secret values: use credential FILE references and product vault references. Sanitization cannot recognize every unknown secret; public evidence uses a fixed output schema instead.

Every scenario id is enumerated by `scenarios(profile)` in `plan.ts`. Missing scenarios remain in `pendingScenarios`. Exit codes: `0` all selected profile observations, cleanup and inventories passed with no pending scenarios; `1` at least one performed check failed; `2` gate/plan/fixture/permission refusal; `3` incomplete profile or cleanup-only completion. Skips, incomplete recipes and cleanup-only runs are never live passes. Evidence is `.data-live/l3/<runId>/report.json`, `journal.json` and, on recovery, `cleanup-report.json`; these are ignored by Git. Results bind the exact source commit, scope digest and recipe digest. No ledger verification flag is set by this tool.

## Owner prerequisites and approvals (DEC-CLOUD)

The owner, not the harness, must provide:

1. Disposable sandbox accounts/projects/subscriptions, exact regions and an existing managed EKS/GKE/AKS/OKE or equivalent cluster. Provisioning, IAM changes, cluster/node-pool creation, production resources, account creation, purchases and accepting terms are outside this harness. Use the normal Zenith installation and browser approval paths for provisioning and source build/release; point observations at their actual operation ids. MAN-01 must use the default composition with no injected test ports.
2. A running sandbox Zenith control plane, real PostgreSQL platform/product stores and Temporal worker/server. For a lean Mac run, use the already operated remote disposable sandbox and cloud cluster. The L3 observer then needs only Node 22 and its existing dependencies, no Docker. Do not boot the full default stack, kind, PostgreSQL and Temporal concurrently on the 8 GB Mac/4 GiB Docker allocation. Local rehearsals below run sequentially against one disposable stack; obtain J1's resource profile after integration rather than guessing unsupported flags.
3. A private GitHub App installation/repository and approved immutable private-source snapshot for source journeys; private registry with real pinned images/provenance; an owned DNS subdomain and DNS write authority through the product, a real ACME issuer/renewal path, gateway and managed object storage/database. These fixtures need owner creation and authorization. Real ACME and registry checks are distinct from local pebble/registry tests.
4. Two disposable tenants, an enforcing CNI (Cilium for FQDN egress), a sandbox RuntimeClass/node pool (J14), limits and an explicitly reviewed noisy-neighbour load bound. Do not disable assertions or substitute namespaces for isolation. Record provisional load/SLO bounds and exact environment.
5. Stripe **test mode** account/customer/webhook setup for MAN-06. Do not change real billing or charge a customer. MAN-07 pricing/terms remain provisional (DEC-BUSINESS); suspension must preserve data and permit export. Destructive retention needs DEC-RETENTION, is outside these recipes, and stays disabled. Production release signing/signoff need their separate owner decisions; this harness grants neither.
6. For mixed traffic: GCP web compute, Azure PostgreSQL, AWS enricher/function, real protected network/TLS/identity/secret bindings and separate approved partition connections/backends. An equivalent placement needs a written owner-reviewed justification; row markers alone do not establish provider identity. Independently observe actual provider resources/receipts as well as the direct database readback.
7. Protected-endpoint probes from **both** an allowlisted and an outside-allowlist machine, with the valid client certificate, key and CA files. One vantage point cannot prove both access and denial. Include both observations in the campaign dossier; one successful recipe is not complete MIX-05 evidence.
8. Genuine owner/browser session cookie FILE for browser-only routes (including prior MFA step-up when required), scoped bearer token FILE for reads, static short-lived kubeconfig FILE, temporary AWS credential JSON FILE, GCP/Azure access token FILEs and read-only PostgreSQL URI/CA FILEs as applicable. Files must be absolute, private regular files (0600 on macOS); no ambient credential chains, exec/auth-provider kubeconfig plugins, metadata credential fallback or TLS bypass. Kubeconfig embeds CA and optional client certificate/key data; its exact context and server must match the plan.
9. Review and approve budget/grants using the existing interactive permissions CLI. `permissions.json` ships unapproved, and **does not currently grant managed/release mutations**. `--plan` emits a proposed grant to review; the integrator/owner adds the grant to an owner-local manifest and approves its digest. The builder does not edit or approve that file. Managed uses `managed-acceptance-live`, mixed uses `mixed-traffic-live`, release uses `release-acceptance-live`. Mixed fault injection also requires `inject_fault` and any cluster provider grant; the shipped mixed grant does not include them.
10. A separate exact-plan approval FILE, described below, and a shared absolute budget FILE for L1/L2/L3 reservations. Explicit price projection must include the run window of pre-existing resources, egress, storage, idle time and cleanup. Every cloud provider needs a positive projection; reserve is allocated proportionally when checking provider caps. Bundled placeholder prices are never executable.

## Exact Mac commands

Start from the clean, committed integrated verifier RC, Node 22 and existing node_modules. Do not install dependencies as part of this harness. Owner creates a private working directory outside the checkout:

```bash
node --version                             # must be v22.x
umask 077
export L3_PRIVATE="$(mktemp -d "${TMPDIR:-/tmp}/zenith-l3-owner.XXXXXX")"
bash scripts/acceptance/managed-acceptance.sh --template > "$L3_PRIVATE/managed.recipe.json"
bash scripts/acceptance/live/mixed/acceptance.sh --template > "$L3_PRIVATE/mixed.recipe.json"
bash scripts/acceptance/live/release/acceptance.sh --template > "$L3_PRIVATE/release.recipe.json"
# Owner edits recipes: actual targets/ids, tagged resources, assertion matrix below,
# timestamps, full price projection, approved cleanup, all independent inventories.
bash scripts/acceptance/managed-acceptance.sh --plan --fixture "$L3_PRIVATE/managed.recipe.json" > "$L3_PRIVATE/managed.plan.json"
bash scripts/acceptance/live/mixed/acceptance.sh --plan --fixture "$L3_PRIVATE/mixed.recipe.json" > "$L3_PRIVATE/mixed.plan.json"
bash scripts/acceptance/live/release/acceptance.sh --plan --fixture "$L3_PRIVATE/release.recipe.json" > "$L3_PRIVATE/release.plan.json"
```

These commands read neither credential FILEs nor a cloud. Templates are deliberately incomplete and use `.invalid` targets; execution refuses them. Template generation itself is not readiness evidence. Fill all scenarios, rather than repeating the same operation-status assertion under different scenario ids.

The owner creates `$L3_PRIVATE/permissions.json` from the reviewed manifest, adds only needed proposed grants within the existing per-run/per-provider/total/TTL budgets, and approves it interactively:

```bash
export ZENITH_LIVE_SCOPE_FILE="$L3_PRIVATE/permissions.json"
npx tsx scripts/release/permissions-cli.ts show
npx tsx scripts/release/permissions-cli.ts approve --by 'Arnav Bule'
npx tsx scripts/release/permissions-cli.ts check
```

Then rerun each `--plan` command with that scope. The owner writes a private exact-plan approval JSON per recipe (no secret, no automatic approval). Fields must be actual values from that plan and manifest, not the placeholders below:

```json
{
  "schema": 1,
  "decision": "DEC-CLOUD",
  "approvedBy": "Arnav Bule",
  "approvedAt": "<actual approval ISO timestamp>",
  "expiresAt": "<actual ISO timestamp covering the run plus cleanup>",
  "planSha256": "<plan.sha256>",
  "scopeDigest": "<permissions-cli digest>",
  "sourceCommit": "<integrated verifier RC SHA>"
}
```

Store cookies/tokens/kubeconfig via the owner's authenticated tooling, never in recipes or shell literals. Export only FILE references (recipe `credentialRef`, `caRef`, `certRef`, `keyRef` name these env variables). Example profile invocation, after all prerequisites and exact approval:

```bash
export ZENITH_L3_BROWSER_FILE="$L3_PRIVATE/browser.cookie"
export ZENITH_L3_KUBECONFIG_FILE="$L3_PRIVATE/kubeconfig"
export ZENITH_L3_BUDGET_FILE="$L3_PRIVATE/budget.json"
export ZENITH_L3_OUT="$PWD/.data-live/l3"
export ZENITH_L3_APPROVAL_FILE="$L3_PRIVATE/managed.approval.json"
ZENITH_LIVE_MANAGED=1 bash scripts/acceptance/managed-acceptance.sh --run --fixture "$L3_PRIVATE/managed.recipe.json"

export ZENITH_L3_APPROVAL_FILE="$L3_PRIVATE/mixed.approval.json"
ZENITH_LIVE_MIXED=1 bash scripts/acceptance/live/mixed/acceptance.sh --run --fixture "$L3_PRIVATE/mixed.recipe.json"

export ZENITH_L3_APPROVAL_FILE="$L3_PRIVATE/release.approval.json"
ZENITH_LIVE_RELEASE=1 bash scripts/acceptance/live/release/acceptance.sh --run --fixture "$L3_PRIVATE/release.recipe.json"
```

Run **once per recipe/run id**. No forward effects are automatically resumed. Gated vitest alternative (choose one profile; do not first run the same recipe via its shell):

```bash
export ZENITH_L3_MANAGED_RECIPE_FILE="$L3_PRIVATE/managed.recipe.json"
ZENITH_LIVE_MANAGED=1 npx vitest run tests/acceptance/live-l3.gated.test.ts --no-file-parallelism --maxWorkers=1
# For mixed/release, use ZENITH_L3_MIXED_RECIPE_FILE or ZENITH_L3_RELEASE_RECIPE_FILE,
# the matching profile gate and exact-plan approval FILE. Other profiles are SKIPPED.
```

Expected: active profile has 1 actual passing live test only when its CLI exits 0; two other profiles explicitly skip. Without gates all 3 skip and establish no live evidence. Recipe counts depend on the reviewed observation matrix, and the JSON report provides exact performed/failed/not-run counts. A runtime failure always attempts every reviewed cleanup entry and every independent inventory. Handle SIGINT/SIGTERM by letting the current bounded call settle and cleanup finish. SIGKILL/power loss cannot execute `finally`.

## Required observation matrix

Owner recipes must map **each acceptance clause** to concrete normal-product receipts and independent resource/traffic observations. `http` and `kubernetes` steps support exact JSON-pointer expectations and bounded polling. Use `{ "pointer": "/p95Ms", "min": 0, "max": 500 }` for a finite measured bound, or `equals` for exact JSON equality; never both. Missing, nonnumeric or nonfinite measurements fail. They do not manufacture operational rehearsal evidence. The release profile requires all 16 existing REL-01 scenario ids plus these nine OPS rehearsal ids. Use new ids for each distinct check.

| Rows | Required real observations |
| --- | --- |
| MAN-01 | Default session/tenant identity and refused cross-tenant access; immutable private source/build isolation/provenance and registry digest; real release ready pods and serving health. Never use the legacy kind fixture's synthetic next digest as a real successful release. |
| MAN-02/03 | Registry pull/readback, Gateway/route, issued certificate SAN/issuer/expiry and real TLS; vault secret delivery without exposing it; tenant object storage positive/negative access; managed DB identity; DNS proof, renewal/revocation; export/restore content checksums; HPA metrics/load and catalog capability readback. |
| MAN-04/05 | Two tenants with positive controls plus route/storage/CNI/metadata/FQDN egress/pod-security/quota/operator denial; sandbox RuntimeClass actually running; CPU/memory/disk/PID exhaustion and measured victim p95 within recorded provisional bounds. A configuration object alone is insufficient. |
| MAN-06/07 | Real Stripe test invoice/event reconciliation and idempotent replay; plan assignment, meter/quotas; BYOC without billing; suspension refuses new work while preserving row/resource counts and allowing export; reinstatement. Pricing/terms and destructive retention stay undecided. |
| MIX-01/02 | `mixed_evidence` request to the real stored plan verifies separate accounts/connections/backends, immutable child/semantics digests, durable receipts, dependency order and stable addresses. Independently read actual child resources; stored receipts alone do not prove provider reality. |
| MIX-03/04 | Typed output provenance/scope, sealed references, changed materialization demands review; cycles and missing authority refused; partial success/timeout/expiry/cancel/outage/drift/migration block safely; no destructive compensation. Capture real operation/refusal receipts and reverse-order destroy release/sync. |
| MIX-05 | `connectivity` request pins endpoint hostname, DNS targets, TLS minimum, SPKI, valid mTLS material, approved allowlist. Include both vantage points. Verify actual route/firewall/private endpoint and overlap handling separately. Database public exposure cannot be silently accepted. |
| MIX-06 | `mixed_traffic` baseline and recovered requests: GCP entry, Azure direct PostgreSQL TLS read-only transaction, AWS enricher markers and actual cloud resource reads. Checker recomputes price/checksum, rejects missing/duplicate/phantom/rejected rows and checks idempotent replay. No app readback endpoint is accepted. |
| MIX-07 | `scale_deployment` for an exact tagged disposable GCP Kubernetes-equivalent Deployment (zero replicas requires `inject_fault`); observe outage and direct DB uncertain writes, then restore replicas and observe readiness/traffic. Owner documents equivalence. Other compute fault modes require owner-operated real fault and heal plus independent observations. Read actual economics response with priced transfer/residency/latency terms; prices are estimates, not invoices. |
| OPS-01 | `slo-measurement`: measured availability/latency/capacity and restore-derived RPO/RTO; objective approval remains provisional unless separately signed off. |
| OPS-02 | `control-plane-outage-fairness`: actual outage and read-only maintenance receipts, tenant queue/backpressure/fairness measurements, serving independent workload, correlated dashboards/alerts successfully imported. |
| OPS-03 | `rolling-upgrade-replay`: actual in-flight histories across N-1/N API/worker/runner, replay result, compatibility refusal and rollback readback. |
| OPS-04 | `clean-host-restore`: fresh host/store identities, restored stores/artifacts/Temporal/customer state, consumed approvals refuse reuse and old epoch refuses writes until explicit reconciliation/reopen. |
| OPS-05 | `key-rotation-decrypt-history`: purpose ids, active/decrypt-only states, old ciphertext/history remains readable, wrong-purpose refusal and real KMS/HSM audit receipts where claimed. Never expose material. |
| OPS-06/07 | `persistence-leak-scan` of operated stores/logs/history with runtime canaries; `archive-hold-dry-run` sealed object verify/restore/hold and preview counts. No deletion or general perfect-redaction claim. |
| OPS-08 | `independent-adversarial`: independent reviewer/tester performs tenant/role/stale approval/SSRF/rebinding/prompt/archive/build/exfiltration/forgery/escalation/integration-compromise probes against the operated stack/cloud metadata surfaces. This builder's offline tests are not independent acceptance. |
| OPS-09 | `signed-release-audit`: independently verified real artifacts/SBOM/provenance/updater signature/triage/audit chain. Local ephemeral signing key is rehearsal only; actual tag release needs the separate signing-key decision. |
| REL-01 | All existing required scenario ids: install, private-source, plan-approval, dns-tls, stateful-traffic, update-rollback, machine-schedules, drift-repair, revocation, crash-partition, rotation, upgrade, restore, two-tenants, export, teardown. Include their actual operational receipts and independent cloud traffic/readback. |
| REL-02/03/04 | Generate dossier at exact RC, retain pending/skipped entries and full environment; no automatic production signoff; exact digest/target/budget approval and conservative attempted-effect journal with next cleanup command. |

## Tagging, cleanup and inventory limitations

Tag owned resources during their normal disposable provisioning. Do not stamp a tag on an unrelated object to make cleanup pass. Canonical cloud tags/annotations are `zenith:live-run=<runId>` and `zenith:ttl-expires=<startedAt + ttlMinutes ISO>`. Kubernetes also needs label `zenith.dev/live-run=<runId>`; GCP uses label `zenith_live_run=<runId>` because colon keys are not supported. Independent ownership reads must match exact run and TTL plus the pinned pointer assertions before any mutation/delete. Namespace deletion uses live UID and resourceVersion preconditions, never `--all` or a wildcard name. Deployment scale uses live identity/resourceVersion and exact replicas; approved cleanup can restore its declared baseline before namespace teardown. This is preauthorized fixture cleanup, never automatic mixed compensation.

Mixed teardown POSTs can **only release/sync already human-approved child destroy operations** at the existing browser-only route. Include their terminal status polling and sync steps in dependency order before inventories. The harness cannot propose a new approval or release an unapproved destroy operation. Missing, stale, expired or revoked approvals yield failure, including during cleanup; no expiry bypass exists. Approve a cleanup window longer than the run TTL.

Independent scans check Kubernetes namespaces/PVs/ClusterRoles/ClusterRoleBindings bearing the run label; AWS Resource Groups Tagging API (with independently checked STS account and explicit commercial-region endpoints); GCP Cloud Asset Search within exact project; Azure resource inventory within exact subscription. Cloud scans paginate with bounded calls and reject unreadable or incomplete responses. K8s inventories reject continuation tokens rather than declaring an incomplete page empty. AWS/GCP/ARM tag indexes can lag or omit unsupported/global/untaggable resources; zero here covers the **declared indexed inventory only**. Add provider-specific direct reads for every provisioned kind, including volumes, DNS, registry images and global IAM, via L1/L2 and the owner campaign. An empty generic tag index alone is insufficient for the ledger's full zero-leak acceptance. OCI inventory is refused, not approximated.

On interruption, use the **same** committed checkout, recipe, source digest, scope, credential refs and original out directory. Investigate a crash `run.lock` before removing that specific lock; the tool never silently steals a lock. Retry cleanup, not forward effects:

```bash
ZENITH_LIVE_MANAGED=1 bash scripts/acceptance/managed-acceptance.sh --cleanup-only --fixture "$L3_PRIVATE/managed.recipe.json"
ZENITH_LIVE_MIXED=1 bash scripts/acceptance/live/mixed/acceptance.sh --cleanup-only --fixture "$L3_PRIVATE/mixed.recipe.json"
ZENITH_LIVE_RELEASE=1 bash scripts/acceptance/live/release/acceptance.sh --cleanup-only --fixture "$L3_PRIVATE/release.recipe.json"
```

Cleanup-only success exits 3 (scenarios remain not run). A failed teardown or nonempty/unreadable inventory exits 1 and requires owner remediation. All entries are attempted even after an earlier cleanup fails. Budget reservations remain conservatively charged after cleanup and are never auto-refunded. Retain evidence and budget book until the owner reconciles actual spend and scans every supported resource kind.

## Local Mac verification and integration joins

Offline Windows/Mac contract commands:

```bash
ZENITH_LIVE_MANAGED=0 ZENITH_LIVE_MIXED=0 ZENITH_LIVE_RELEASE=0 npx vitest run tests/acceptance/live-managed.test.ts tests/acceptance/live-managed-transports.test.ts tests/acceptance/live-l3.gated.test.ts tests/release/live-scope-coverage.test.ts --no-file-parallelism --maxWorkers=2
npx eslint scripts/acceptance/live/managed scripts/acceptance/live/mixed/probes.ts tests/acceptance/live-managed.test.ts tests/acceptance/live-managed-transports.test.ts tests/acceptance/live-l3.gated.test.ts
bash -n scripts/acceptance/managed-acceptance.sh
bash -n scripts/acceptance/live/mixed/acceptance.sh
bash -n scripts/acceptance/live/release/acceptance.sh
```

Mac local-engine/cluster rehearsal commands (sequential, one worker; not run here):

```bash
# Start the reviewed J1 disposable default stack after that job integrates; its
# up.mjs owns readiness/labels. If its lean profile cannot fit, use the remote
# operated sandbox for L3 rather than weakening the install acceptance.
node scripts/acceptance/default-stack/up.mjs

# Owner sets digest-pinned registry/builder images in the environment first.
bash scripts/k8s/managed-substrate-acceptance.sh
# Run a separate cluster for Cilium/FQDN/runtime/load tests; review J11/J14 pins.
bash scripts/isolation/tenant-isolation-acceptance.sh kind-cilium

# With the owned PostgreSQL URL and Temporal endpoint set by the stack runbook:
ZENITH_TEST_PLATFORM_PG_URL="$OWNED_PLATFORM_PG_URL" npx vitest run tests/controlplane/mixed-parent-plans.test.ts tests/controlplane/mixed-runs.test.ts --no-file-parallelism --maxWorkers=1
ZENITH_TEST_TEMPORAL=1 npx vitest run tests/workflows/mixed-parent.test.ts --no-file-parallelism --maxWorkers=1
npm run replay:check
npm run ops:upgrade
# Recovery/retention/key commands and environment are in per-row existing docs;
# use their owned backup/restore configuration, never a production connection.
npx tsx scripts/release/acceptance-orchestrator.ts run --out .data-live/release-local
npx tsx scripts/release/dossier.ts --out .data-live/release-dossier.md --json .data-live/release-dossier.json
```

Original per-requirement verify documents retain precise engine/ops environment requirements. Legacy `managed-kind.test.ts` establishes object/build contracts, **not** running a real next release digest, platform DB/Temporal, cloud DNS/ACME, or paying tenants. The local isolation suite currently refuses non-kind contexts and is not quietly reused on a cloud cluster. Full default-journey/isolation/ops receipt producers must come from J1/J2/J4/J5/J6/J11/J14/J15 and the verifier campaign; L3 consumes genuine observations rather than injecting replacements.

L1 currently provides AWS-specific plan/Guard/Transport/ProductScenarioPort contracts in its sibling worktree, not a generic managed/mixed runner. This job defines its helper under `live/managed` and shares the existing release Scope/digest and MIX checker interfaces. Integration joins: share one conservative budget-book schema/lock with L1/L2; add their provider-specific inventories and product scenario evidence; keep L1's exact-plan approval extension compatible with the strict root Scope schema (prefer separate approval FILEs rather than adding an unknown root key); add reviewed managed/release grants; wire these entry points to the release campaign without replacing any existing required lane or gate. J12 remains owner of dossier/signoff status logic. No schema/migration need, package/lock changes or published SQL edits in L3.

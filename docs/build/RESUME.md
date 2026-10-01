# Resume here — platform build checkpoint (2026-10-01, 20:50 IST)

This branch (`platform/checkpoint-2026-10-01`) is the complete state of the agentic multi-cloud control-plane build
(the "Master Build Prompt" program). Everything finished is merged here; everything unfinished is saved here as a patch
with its brief. Read this file first, then `docs/build/IMPLEMENTATION-LEDGER.md` (rendered from `docs/build/ledger.json`).

## 1. Where things are

| Thing | Where |
|---|---|
| This checkpoint (all done work, wave 1–8) | branch `platform/checkpoint-2026-10-01` (= local `ws/integrate-w6` staging) |
| Last fully-gated integration point (waves 1–7) | commit `848532c` "Merge wave-7 staging (ws/integrate-w6) into platform/integration" (local branch `platform/integration`, not pushed separately) |
| Durable program state | `docs/build/ledger.json` → `node scripts/build/ledger.mjs` renders `docs/build/IMPLEMENTATION-LEDGER.md` |
| Honest list of what is and is not done | `docs/LIMITATIONS.md` ("Still-open gaps") |
| Codex job briefs (all waves) | `docs/build/handoffs/WS-*.md` |
| Paused work (uncommitted diffs) | `docs/build/paused/ws-*.patch` (+ any `*.resume-prompt.md`) |
| Codex lane scripts used on the old machine | `docs/build/codex-lane/` (paths inside are the old machine's; adapt them) |

## 2. Status

- **Waves 1–7: integrated and fully gated** at `848532c`: tsc 0, eslint 0, gofmt/vet/go test green, policy (OPA 1.19.1, 213 Rego
  tests, bundle byte-identical), `platform:emit-sql --check`, `capability-matrix --strict`, AWS policy templates `--check`,
  full vitest with real OpenTofu 1.12.5 + Temporal time-skipping: 15,219 passed, 210 skipped, 0 failed (one flaky test fixed).
- **Wave 8 merged into this branch (8 jobs)**, each verified outside the Codex sandbox with tsc, Go, and the affected suites
  (real OpenTofu where relevant), but **the full gate has NOT been re-run since these merges**:
  TEMPORAL-MTLS, VAULT-REWRAP, RELEASE-K8S, RELEASE-OCI, IMAGE-PINS, MACHINE-PORT, GITHUB-SOURCE, DNS-GUARDS-CLOUDS.
- **Wave 8 paused (3 jobs)** — work saved as patches, not merged:

| Job | Brief | Patch (base commit) | Where it stopped |
|---|---|---|---|
| WS-DESTROY-REVIEW | `handoffs/WS-DESTROY-REVIEW.md` | `paused/ws-destroy-review.patch` (base `53d5e2d`) | Focused tests passed (86); found a race: review replacement could cancel an already-approved proposal; was adding a conditional cancellation guard. Then: lint, tsc, docs. |
| WS-AZURE-SOURCE-WIRE | `handoffs/WS-AZURE-SOURCE-WIRE.md` + `paused/WS-AZURE-SOURCE-WIRE.resume-prompt.md` | `paused/ws-azure-source-wire.patch` (base `53d5e2d`) | First pass complete (Azure C3 storage helper, ACR wiring, 209 tests). Was doing the follow-ups in the resume prompt: Storage-audience token + strict Blob host policy + no redirects in `src/lib/providers/azure/credentials.ts`; trusted `sourceBundles.azureStorage` resolver in `workers/execution/worker.ts`/`src/lib/platform/execution.ts`; docs guards. |
| WS-AWS-BOUNDARY-SPLIT | `handoffs/WS-AWS-BOUNDARY-SPLIT.md` | `paused/ws-aws-boundary-split.patch` (base `2dfc58c`) | One permissions boundary per AWS role family (38 files). Was fixing: the deploy-role IAM policy went over IAM's 6,144-char limit after listing six boundary ARNs; compacting statements. Coverage for identity/EKS families not finished. |

Apply a patch: `git checkout -b ws/<name> platform/checkpoint-2026-10-01 && git apply --3way docs/build/paused/ws-<name>.patch`
(bases are ancestors of this branch; resolve the usual `docs/LIMITATIONS.md` conflicts by keeping both sides' lines).

## 3. Orchestrator follow-ups not yet done

1. **Run the full gate on this branch**, then merge it into `platform/integration` (see §5 for the commands).
2. **GitHub source schema → platform migration 6.** WS-GITHUB-SOURCE ships its own schema (`src/lib/sources/github/{schema,migrate}.ts`)
   with a documented installer. Convert it to `src/lib/controlplane/db/migrations/0006_*.ts`, register it in `migrations/index.ts`,
   regenerate `supabase/migrations/0014_platform_core.sql` (`npm run platform:emit-sql`), update the "Five migrations" text in
   `docs/platform/operations/DEPLOYING.md` and its docs guard. Also add the GitHub page link in `src/app/(product)/platform/layout.tsx`.
3. **WS-MACHINE-PORT doc follow-ups:** stale default-port claims in `docs/platform/operations/README.md:83` and
   `docs/platform/operations/AWS-SETUP.md:221`.
4. **WS-RELEASE-OCI:** (a) the runner must add trusted compartment bindings for container instances it just created
   (`go/internal/runner/kinds/ocihttp.go` ~180) or migration polling fails closed; (b) nothing deletes finished one-off migration
   container instances — add a DELETE rule restricted to instances the runner created for that job, plus cleanup.
5. **AWS boundary:** until WS-AWS-BOUNDARY-SPLIT lands, the single `ZenithWorkloadBoundary` is 5,983/6,144 chars (GovCloud) and still
   blocks identity (multipart upload, log reads, DB/cache grants) and parts of EKS role policies.
6. **Needs the user:** retention/pruning policy for events, evidence, approvals, decisions, grants, runner jobs (audit-history decision);
   managed Zenith session opener (needs the hosted substrate); installing `kind` (real-cluster Kubernetes tests) needs approval.
7. **Externally blocked:** live AWS/GCP/Azure/OCI accounts, Temporal Cloud, GitHub `live-sandbox` environment, a real Postgres server
   (`ZENITH_TEST_PLATFORM_PG_URL`), Docker.

## 4. Rules of the program (keep them)

- Deterministic code owns credentials, policy, approvals, state and execution; LLMs only propose. Approvals are human, browser-only,
  bound to an immutable plan digest (approval rounds). No secret value in logs, state, evidence, errors, URLs or tests. Nothing is
  labelled live-verified without live acceptance.
- Commits: `git -c user.name="Arnav Bule" -c user.email="arnav.bule05@gmail.com" commit ...`, no Co-Authored-By trailer.
- Workers were Codex `gpt-6.1-sol` at `xhigh` reasoning, one git worktree + branch per job (`zenith-wt/ws-<name>` on `ws/<name>`,
  node_modules junctioned to the integration worktree), launched with `codex exec` using `codex-lane/PREAMBLE.md` + the brief +
  `codex-lane/BATCH4-ETIQUETTE.md`. The Codex sandbox cannot run tofu/opa/go/temporal or write `.git`: the orchestrator commits and
  re-runs those checks outside the sandbox before every merge — this repeatedly caught real bugs. "Model at capacity" exits are
  common: resume the same thread with `codex exec resume <thread>` and a short "continue from where you stopped" prompt.
- Merge order: job branch → staging (`ws/integrate-w6`) with outside-sandbox checks → full gate → `platform/integration`.
- Never touch the `ssc-*` containers or ports 4566/54329/7233/8181 on the old machine (another project). LocalStack work is on hold
  (`src/lib/providers/localstack/**`).

## 5. Verification commands (the full gate)

Tools: Node 22.16–22.x, OpenTofu 1.12.5 on PATH, OPA 1.19.1, Go (GOTOOLCHAIN=local), network for provider downloads.

```bash
npx tsc --noEmit
npx eslint .
(cd go && gofmt -l . && go vet ./... && go test ./...)
npm run policy:check
npm run platform:emit-sql -- --check
npx tsx scripts/docs/capability-matrix.ts --strict
npx tsx deploy/aws/tools/generate-tofu-policies.ts --check
ZENITH_TEST_TOFU_NETWORK=1 ZENITH_COMPOSE_TEMPORAL_MODE=time-skipping ZENITH_TEST_TEMPORAL_DOWNLOAD=1 ZENITH_SEC_TEMPORAL=1 npx vitest run --maxWorkers=3
```

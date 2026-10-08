# J14 step 2 build receipt

Worktree `prod6-j14-isolation-runtime`, branch `prod/j14-isolation-runtime`, merge base `eb338840`.
This supersedes the missing-join conclusions in the original J14 receipt. MAN-04/05 are build complete,
with required Mac/local-engine/live/operational verification pending. No Git writes, package edits,
published migration edits, aggregate generation, real cloud API calls or production credentials.

## Changes, 30 files

Added:

- `src/lib/controlplane/db/migrations/056_isolation_custody.ts`
- `src/lib/execution/isolation-custody.ts`
- `src/lib/platform/zenith-isolation-custody.ts`
- `tests/execution/zenith-first-deploy.test.ts`
- `tests/platform/zenith-isolation-custody.test.ts`
- `tests/isolation/gvisor-onboarding-acceptance.test.ts`
- `tests/isolation/gateway-isolation-acceptance.test.ts`
- `docs/build/production/verify/J14-ISOLATION-RUNTIME-STEP2.md`

Changed:

- `src/lib/providers/zenith/onboarding.ts`: standalone/composite reviewed provisioning contract.
- `deploy/zenith-managed/runtime/kind-up.sh`: optional reviewed CRD and Cilium Gateway/Envoy setup,
  kube-proxy replacement using the owned node's internal API address; complete image pin checks retained.
- `docs/build/production/verify/PROD-MAN-04-05.md`: current acceptance mapping and exact Mac commands.
- `docs/build/production/ledger.json`: MAN-04/05 notes and MAN-04 test paths only; both statuses remain
  `implementation_complete_verification_pending`, with evidence unchanged.

Minimal edits outside the original owned source paths, explicitly authorized by step 2:

| File | Purpose |
|---|---|
| `src/lib/providers/zenith/managed-port.ts` | Typed internal planning/provisioner join. |
| `src/lib/providers/zenith/managed-substrate.ts` | Expose composed onboarding port. |
| `src/lib/platform/zenith-managed.ts` | Default provisioner, trusted tenant resolution, real operator probe and encrypted scoped credential sink. |
| `src/lib/platform/zenith-onboarding.ts` | Read-only HTTP authentication firewall; existing readiness remains read-only. |
| `src/lib/platform/execution.ts` | Default direct-object custody composition. |
| `src/lib/execution/ports.ts` | Custody port seam. |
| `src/lib/execution/session.ts` | Attenuated planning grant before internal planning credentials. |
| `src/lib/execution/direct-zenith.ts` | Composite plan/review and approved isolation phase before tenant workload session; mutating grant required. |
| `src/lib/execution/semantics/zenith.ts` | Bind complete isolation and token constraints in canonical deployment semantics. |
| `src/lib/execution/tenant-isolation.ts` | DUR-B/C guards, critical evidence, effect-before-call, repeat/readback and token issuance/storage guards. |
| `src/lib/providers/zenith/isolation-bundle.ts` | Exact reserved Cilium ingress identity permission for class cilium; broader peers refused. |
| `src/lib/controlplane/db/migrations/index.ts` | Append assigned migration 56; preserve migrations 44-52. |
| `src/lib/sensitivedata/inventory.ts` | Classify new sealed direct-plan table and immutable logical expiry. |
| `src/lib/sensitivedata/at-rest.ts` | Add new table's ciphertext/tag to existing at-rest census. |
| `src/lib/controlplane/db/repos/operations.ts` | One-value SQL repair: fresh execution lease had 8 columns but 7 expressions, missing renewed_at. |
| `tests/execution/tenant-isolation.test.ts` | Existing fixture now supplies real canonical semantics and encrypted custody. All assertions retained. |
| `tests/platform/zenith-onboarding.test.ts` | Actual client dry-run succeeds; same planning session cannot authenticate a real write. |
| `tests/providers/zenith/isolation-bundle.test.ts` | Exact reserved ingress peer and hostile policy mutation contracts. |

New tests explicitly distinguish scripted cluster/approval/product contracts from enforcing kind evidence.
No existing assertion, gate or expectation was weakened or changed. The fixture additions satisfy the new
mandatory custody requirement. New table is service-role-only with RLS and immutable UPDATE/DELETE trigger;
the envelope authenticates workspace/project/environment/operation/proposal/input/expiry and exact reviewed
objects. The existing enc:plan-artifacts key purpose is reused; this direct-object format is separate from
OpenTofu native plan bytes and cannot substitute for them.

## Commands and observed counts

Every PowerShell shell first used:

```powershell
$env:PATH = 'C:\Users\user\.local\sdk\node22;' + $env:PATH
```

Before the initial regression, real-engine gates were removed in that shell only:

```powershell
Remove-Item Env:ZENITH_TEST_TENANT_ISOLATION,Env:ZENITH_TEST_GVISOR_RUNTIME,Env:ZENITH_TEST_PLATFORM_PG_URL -ErrorAction SilentlyContinue
```

All vitest commands below append `--no-file-parallelism --maxWorkers=2`. Counts are individual observed
runs; overlapping runs must not be added together as unique tests.

1. Old migration-collision regression:

   ```text
   npx vitest run tests/execution/tenant-isolation.test.ts tests/providers/zenith/onboarding-semantics.test.ts tests/isolation/gvisor-installation.test.ts tests/isolation/isolation-profile.test.ts tests/providers/zenith/isolation-bundle.test.ts tests/isolation/gvisor-runtime-acceptance.test.ts tests/isolation/tenant-isolation-acceptance.test.ts --no-file-parallelism --maxWorkers=2
   ```

   Exit 0: **162 passed / 0 failed / 31 skipped**; 5 passed files, 2 gated files. The assembly removed the
   migration collision; no migration history or assertion was edited to achieve this.

2. First default first-deploy batch:

   ```text
   npx vitest run tests/execution/zenith-first-deploy.test.ts tests/platform/zenith-onboarding.test.ts tests/platform/zenith-managed-composition.test.ts tests/execution/zenith-managed-journey.test.ts --no-file-parallelism --maxWorkers=2
   ```

   Exit 1: **47 passed / 3 failed / 0 skipped**; 3 passed files, 1 failed file. Fixture used an in-memory
   lease while the real effect ledger checked SQL; a guessed fixture method was also invalid. Changed
   fixture to real platform lease adapter and claim, keeping every assertion.

3. First-deploy/firewall/Cilium rerun:

   ```text
   npx vitest run tests/execution/zenith-first-deploy.test.ts tests/platform/zenith-onboarding.test.ts tests/providers/zenith/isolation-bundle.test.ts --no-file-parallelism --maxWorkers=2
   ```

   Exit 1: **99 passed / 8 failed / 0 skipped**; 2 passed files, 1 failed file. Real fresh execution-lease
   SQL failed with `INSERT has more target columns than expressions`. Fixed missing renewal timestamp,
   preserving ownership/fence/claim guards and all assertions.

4. Lease repair / first-deploy rerun:

   ```text
   npx vitest run tests/execution/zenith-first-deploy.test.ts tests/controlplane/first-source-lease-binding.test.ts --no-file-parallelism --maxWorkers=2
   ```

   Exit 0: **8 passed / 0 failed / 31 skipped**; 1 passed file, 1 gated PostgreSQL file.

5. Expanded first-deploy and custody contracts with new kind harnesses gated:

   ```text
   npx vitest run tests/execution/zenith-first-deploy.test.ts tests/platform/zenith-isolation-custody.test.ts tests/isolation/gateway-isolation-acceptance.test.ts tests/isolation/gvisor-onboarding-acceptance.test.ts --no-file-parallelism --maxWorkers=2
   ```

   Exit 0: **17 passed / 0 failed / 4 skipped**; 2 passed files, 2 gated kind files.

6. Final broad, scoped regression:

   ```text
   npx vitest run tests/execution/tenant-isolation.test.ts tests/providers/zenith/onboarding-semantics.test.ts tests/isolation/gvisor-installation.test.ts tests/isolation/isolation-profile.test.ts tests/providers/zenith/isolation-bundle.test.ts tests/isolation/gvisor-runtime-acceptance.test.ts tests/isolation/tenant-isolation-acceptance.test.ts tests/execution/zenith-managed-journey.test.ts tests/platform/zenith-onboarding.test.ts tests/platform/zenith-managed-composition.test.ts tests/sensitivedata/minimize.test.ts --no-file-parallelism --maxWorkers=2
   ```

   Exit 0: **214 passed / 0 failed / 31 skipped**; 9 passed files, 2 gated kind files.

7. Pure managed semantics/substrate and final gated harness import:

   ```text
   npx vitest run tests/execution/zenith-semantics.test.ts tests/providers/zenith/managed-substrate.test.ts tests/isolation/gateway-isolation-acceptance.test.ts tests/isolation/gvisor-onboarding-acceptance.test.ts --no-file-parallelism --maxWorkers=2
   ```

   Exit 0: **33 passed / 0 failed / 4 skipped**; 2 passed files, 2 gated kind files.

8. Sensitive inventory audit:

   ```text
   npx vitest run tests/security/sensitive-inventory.test.ts --no-file-parallelism --maxWorkers=2
   ```

   Exit 1: **12 passed / 1 failed / 0 skipped**; 1 failed file. The inventory census tracks sensitive-looking
   names, so the extra artifact_digest entry was stale under its unchanged contract. Removed that extra
   entry, retained plan_digest and both sealed columns; added ciphertext/tag to the existing at-rest census.

9. Final affected contracts after scope/type/inventory fixes:

   ```text
   npx vitest run tests/execution/zenith-first-deploy.test.ts tests/platform/zenith-isolation-custody.test.ts tests/security/sensitive-inventory.test.ts --no-file-parallelism --maxWorkers=2
   ```

   Exit 0: **30 passed / 0 failed / 0 skipped**; 3 passed files.

10. Lint ran three times as the scoped files grew, using the actual Git file lists, without Git writes:

    ```powershell
    $files = @(git diff --name-only -- '*.ts')
    $files += @(git ls-files --others --exclude-standard -- '*.ts')
    npx eslint $files
    ```

    All exit 0, **0 errors / 0 warnings**. Final invocation covers **26 TypeScript files**.

11. Whole-repo typecheck, only through the shared serialized script:

    ```text
    bash Z:/Projects/Spawned.ai/zenith-wt/.resume/codex/tsc-serial.sh
    ```

    First invocation exit 1: **12 diagnostics**, scope nullability and test mock/environment declarations.
    Second invocation exit 0: **0 diagnostics** after fixes. A SHA-256 check of all 26 final TypeScript
    files against tsbuildinfo found **25 matched / 1 mismatched**: the final inventory edit occurred after
    the checker read that file. Third serialized invocation exit 0: **0 diagnostics**. Final SHA-256
    comparison confirms **26 matched / 0 mismatched** TypeScript versions. No TypeScript edits followed it.
    Across the three invocations: **2 checks passed / 1 failed / 0 skipped**; only reran after fixes.

12. Non-test checks: `bash -n deploy/zenith-managed/runtime/kind-up.sh`, `git diff --check`, and
    `node scripts/build/production-ledger.mjs --check` each passed with no diagnostics. Repeated after
    final edits as needed. Repo conflict-marker search via `rg -n '^<<<<<<< |^=======$|^>>>>>>> ' . -g
    '!node_modules/**' -g '!tsconfig.tsbuildinfo'` had zero matches (rg exit 1 means no matches).

Read-only inspection used `git status --short`, `git log --oneline -10`, `git diff --stat`, `git diff
--name-only`, `git diff --numstat`, scoped `git diff`, `git show HEAD:docs/build/production/ledger.json`,
`git ls-files --others --exclude-standard`, `Get-Content`, `rg` and `Get-ChildItem` for the shared lock.
Several guessed exploratory paths and literal PowerShell globs were absent and corrected; they were
inspection errors, not test skips or passing checks. Node scripts updated only the two ledger rows and
the current verify section; checked JSON parsing and preserved other rows verbatim. Public official Cilium
documentation was read to validate the reserved ingress identity and Gateway prerequisites.

## Pending Mac verification and deviations

Exact start/env/test/cleanup commands and expected enabled counts are in
[PROD-MAN-04-05.md](PROD-MAN-04-05.md). Not run here: Docker, real PostgreSQL (31 native first-source cases),
kind/Cilium/gVisor/Gateway (35 gated cases across the selected files), Temporal, browsers, live clouds and
operational rehearsal. Gates remain intact. Namespace-missing planning is an explicitly warned local
projection, followed by approved provisioning/readback and real workload validation; no fake server proof.
The native provisioning test proves real API/token/RBAC behavior with product/approval contract inputs,
not a browser-human approval or Temporal acceptance run. Local certificates prove Gateway routing, not ACME.

No deviation from step 2. The first-lease SQL and at-rest census joins are necessary minimal additional
repairs, listed above. Builds still refuse without per-tenant build isolation; unattended token rotation
after operation expiry and immutable-artifact retention/purge remain separately reviewed work. No approval
bypass or deletion policy was added. Assembly owns the next aggregate/export, tenancy/scoping census
registration and gate-manifest integration for the new files. No verified ledger promotion.

Suggested commit: `PROD-MAN-04/05: wire reviewed tenant onboarding and scoped custody`

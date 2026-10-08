# J14 local build receipt

Base: `443bfeaf`, worktree `prod6-j14-isolation-runtime`. No commits, cloud calls or migration changes.
Branch: `prod/j14-isolation-runtime`.

## Files (12)

Added:

- `deploy/zenith-managed/runtime/runtimeclass.yaml`
- `deploy/zenith-managed/runtime/kind-lean.yaml`
- `deploy/zenith-managed/runtime/kind-up.sh`
- `deploy/zenith-managed/runtime/setup-kind.ts`
- `tests/isolation/gvisor-installation.test.ts`
- `tests/isolation/gvisor-runtime-acceptance.test.ts`
- `tests/providers/zenith/onboarding-semantics.test.ts`
- `docs/build/production/verify/J14-ISOLATION-RUNTIME.md`

Changed:

- `src/lib/providers/zenith/onboarding.ts`
- `tests/isolation/tenant-isolation-acceptance.test.ts`
- `docs/build/production/ledger.json` (MAN-04/05 only)
- `docs/build/production/verify/PROD-MAN-04-05.md`

Exact Mac setup/acceptance commands, acceptance mapping and required MAN-01/DUR-B/C joins are in
[PROD-MAN-04-05.md](PROD-MAN-04-05.md).

The original onboarding caller join is absent and belongs to files outside the handoff's owned list.
The new semantics guard is a tested assembly seam, not a claim that the product caller is wired.

## Commands and results

Every PowerShell invocation prepended Node 22 with:

```powershell
$env:PATH = 'C:\Users\user\.local\sdk\node22;' + $env:PATH
```

Before local vitest, real-engine gates were removed from this shell only:

```powershell
Remove-Item Env:ZENITH_TEST_TENANT_ISOLATION,Env:ZENITH_TEST_GVISOR_RUNTIME,Env:ZENITH_TEST_PLATFORM_PG_URL -ErrorAction SilentlyContinue
```

1. Initial targeted contracts and disabled real-kind harnesses:

   ```text
   npx vitest run tests/isolation/gvisor-installation.test.ts tests/providers/zenith/onboarding-semantics.test.ts tests/isolation/isolation-profile.test.ts tests/providers/zenith/isolation-bundle.test.ts tests/isolation/gvisor-runtime-acceptance.test.ts tests/isolation/tenant-isolation-acceptance.test.ts --no-file-parallelism --maxWorkers=2
   ```

   Exit 0. Files: 4 passed / 0 failed / 2 skipped. Tests: **135 passed / 0 failed / 31 skipped**.
   Duration 17.60s. This preceded the additional runtime-binding contract and mandatory CPU accounting assertion.

2. Final targeted regression run, including the existing real-PGlite provisioner:

   ```text
   npx vitest run tests/execution/tenant-isolation.test.ts tests/providers/zenith/onboarding-semantics.test.ts tests/isolation/gvisor-installation.test.ts tests/isolation/isolation-profile.test.ts tests/providers/zenith/isolation-bundle.test.ts tests/isolation/gvisor-runtime-acceptance.test.ts tests/isolation/tenant-isolation-acceptance.test.ts --no-file-parallelism --maxWorkers=2
   ```

   **Exit 1.** Files: 4 passed / 1 failed / 2 skipped. Tests: **146 passed / 0 failed / 45 skipped**,
   with **2 failing suite hooks** in the failed file. Duration 184.17s. Of the skips, 31 are explicit
   kind/runtime gates and 14 are provisioner cases whose PGlite beforeAll failed; the latter are blocked,
   not passing acceptance. The test counts overlap run 1 and must not be added together.

   Root blocker: the untouched base migration registry includes BOTH `0042_external_effect_key_bounds`
   and `0042_mixed_output_records` at version 42, and both stream-events and SLO migrations at 43.
   Fresh PGlite correctly refuses migration 42's different checksum (`schema_tampered`). The second
   error is the existing afterAll's `ctx.close()` after setup failed. The assigned concurrent assembly
   job must renumber the wave-5 collisions; J14 must not edit published migrations or numbering.
   `git diff --name-only -- src/lib/controlplane/db/migrations` is empty. Rerun this exact command
   after integrating the assembly result. No gate/assertion was weakened, and no test expectation changed.

3. Lint of every changed source/test file:

   ```text
   npx eslint src/lib/providers/zenith/onboarding.ts deploy/zenith-managed/runtime/setup-kind.ts tests/providers/zenith/onboarding-semantics.test.ts tests/isolation/gvisor-installation.test.ts tests/isolation/gvisor-runtime-acceptance.test.ts tests/isolation/tenant-isolation-acceptance.test.ts
   ```

   Passed, no output (0 errors / 0 warnings).

4. Shell parsing only: `bash -n deploy/zenith-managed/runtime/kind-up.sh` passed, no output.
   No installer or Docker command was executed.

5. Whole-repo check: `bash Z:/Projects/Spawned.ai/zenith-wt/.resume/codex/tsc-serial.sh` passed,
   exit 0, no diagnostics (**1 check passed / 0 failed / 0 skipped**). The shared lock wait was
   substantial; this job used one serialized invocation and never changed the lock.

6. `git diff --check` passed (0 whitespace errors). `git status --short`,
   `git log --oneline -10`, `git diff --stat`, `git diff --numstat` and scoped `git diff` inspections
   were read-only. File/program/requirement inspection used `Get-Content` and `rg`; two initial
   exploratory batches tried nonexistent `src/lib/semantics`/`src/lib/custody` paths and a later
   PowerShell literal glob failed, then corrected `src/lib/execution/semantics` and rg `-g` reads succeeded.

7. Ledger JSON validation (exit 0, **2 rows passed / 0 failed**):

   ```text
   node -e 'const fs=require("node:fs");const j=JSON.parse(fs.readFileSync("docs/build/production/ledger.json","utf8"));const rows=j.requirements.filter(r=>["PROD-MAN-04","PROD-MAN-05"].includes(r.id));if(rows.length!==2||rows.some(r=>r.implementationStatus!=="implementation_complete_verification_pending"||r.evidence.length!==0))process.exit(1);console.log("2 ledger rows checked; existing evidence arrays retained empty")'
   ```

8. After the final native-ELF architecture check was added, reran only its affected contracts:

   ```text
   npx vitest run tests/isolation/gvisor-installation.test.ts --no-file-parallelism --maxWorkers=2
   npx eslint deploy/zenith-managed/runtime/setup-kind.ts tests/isolation/gvisor-installation.test.ts
   ```

   Vitest exit 0: **18 passed / 0 failed / 0 skipped**, 1 passed file, 870ms. Lint exit 0,
   0 errors / 0 warnings. This prevents an emulated wrong-architecture binary being counted as native ARM64.

9. Final minimal-node fix: the host supplies decompressed tar streams, so kind nodes need no bzip2 package.
   Reran the same installer vitest/lint commands from item 8 and
   `bash -n deploy/zenith-managed/runtime/kind-up.sh` plus `git diff --check`.
   Vitest exit 0: **19 passed / 0 failed / 0 skipped**, 1 passed file, 778ms.
   Lint exit 0 (0 errors / 0 warnings); syntax and whitespace checks exit 0.

10. After guarding tar-flag lookup against inherited object keys, reran the same installer
    vitest/lint commands from item 8. Vitest exit 0: **19 passed / 0 failed / 0 skipped**,
    1 passed file, 746ms. Lint exit 0 (0 errors / 0 warnings).

11. Confirmed the successful incremental typecheck recorded the final contents of all six changed
    TypeScript source/test files (**6 matched / 0 mismatched**, exit 0):

    ```powershell
    @'
    const fs = require('node:fs');
    const path = require('node:path');
    const crypto = require('node:crypto');
    const build = JSON.parse(fs.readFileSync('tsconfig.tsbuildinfo', 'utf8'));
    const names = build.fileNames ?? build.program.fileNames;
    const infos = build.fileInfos ?? build.program.fileInfos;
    const files = ['src/lib/providers/zenith/onboarding.ts', 'deploy/zenith-managed/runtime/setup-kind.ts', 'tests/providers/zenith/onboarding-semantics.test.ts', 'tests/isolation/gvisor-installation.test.ts', 'tests/isolation/gvisor-runtime-acceptance.test.ts', 'tests/isolation/tenant-isolation-acceptance.test.ts'];
    for (const file of files) {
      const index = names.findIndex(name => path.resolve(name) === path.resolve(file));
      const version = typeof infos[index] === 'string' ? infos[index] : infos[index]?.version;
      const actual = crypto.createHash('sha256').update(fs.readFileSync(file, 'utf8')).digest('hex');
      if (version !== actual) throw new Error('Final source not recorded in typecheck: ' + file);
    }
    console.log('6 final TypeScript source versions matched the successful serialized typecheck');
    '@ | node
    ```

Optional Windows process-status inspection via `Get-CimInstance Win32_Process` was denied (exit 1);
it changed no state. The shared typecheck lock was inspected read-only and never changed by this job.

Not run (needs Mac): real kind/Cilium/gVisor and noisy-neighbour checks, real PostgreSQL, Temporal,
browser, operational rehearsal and live acceptance. Local command doubles and MemorySemanticsStore
prove contracts only. No artifacts from this builder claim those checks passed.

Suggested commit: `PROD-MAN-04/05: add gVisor kind runtime and reviewed onboarding seam`.

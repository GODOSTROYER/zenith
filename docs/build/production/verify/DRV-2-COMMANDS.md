# DRV-2 command and file report

Worktree: Z:/Projects/Spawned.ai/zenith-wt/prod7-drivers-d2. Branch: prod/j15-drivers-d2. Base: 7d52b372. No commits, Git writes, push, installation, published migration edits or real cloud operations. Every PowerShell shell starts with:

```powershell
$env:PATH = 'C:\Users\user\.local\sdk\node22;' + $env:PATH
```

## Check attempts

Counts overlap between reruns; they must not be added. Latest independent file results total **368 passed /0 failed /2 skipped** across seven files: gate-manifest301, drivers-d2 17, local-targets33, acceptance-scenarios7, orchestrator10, plus one skipped case in each of the two operated files. The two skips are **not run (needs Mac Docker/real PostgreSQL/Temporal/kind/Chromium)**, not operated passes.

The exact four Vitest commands, in order:

```powershell
npx vitest run tests/release/drivers-d2.test.ts tests/release/local-targets.test.ts tests/release/acceptance-scenarios.test.ts tests/release/orchestrator.test.ts tests/acceptance/drift-repair.operated.test.ts tests/acceptance/crash-partition.operated.test.ts --no-file-parallelism --maxWorkers=2 --reporter=default --reporter=json --outputFile.json=C:/Users/user/AppData/Local/Temp/zenith-drv2-vitest-1.json
npx vitest run tests/release/drivers-d2.test.ts tests/release/local-targets.test.ts tests/release/acceptance-scenarios.test.ts tests/release/orchestrator.test.ts tests/acceptance/drift-repair.operated.test.ts tests/acceptance/crash-partition.operated.test.ts tests/ci/gate-manifest.test.ts --no-file-parallelism --maxWorkers=2 --reporter=default --reporter=json --outputFile.json=C:/Users/user/AppData/Local/Temp/zenith-drv2-vitest-final.json
npx vitest run tests/release/drivers-d2.test.ts tests/release/local-targets.test.ts tests/release/acceptance-scenarios.test.ts tests/release/orchestrator.test.ts tests/acceptance/drift-repair.operated.test.ts tests/acceptance/crash-partition.operated.test.ts --no-file-parallelism --maxWorkers=2 --reporter=default --reporter=json --outputFile.json=C:/Users/user/AppData/Local/Temp/zenith-drv2-vitest-repaired.json
npx vitest run tests/release/drivers-d2.test.ts tests/acceptance/drift-repair.operated.test.ts tests/acceptance/crash-partition.operated.test.ts --no-file-parallelism --maxWorkers=2 --reporter=default --reporter=json --outputFile.json=C:/Users/user/AppData/Local/Temp/zenith-drv2-vitest-last.json
```

| Attempt | Passed | Failed | Skipped | Exit |
| --- | ---: | ---: | ---: | ---: |
| First focused run | 64 | 0 | 2 | 0 |
| Expanded gate-manifest run | 366 | 2 | 2 | 1 |
| Corrected report fixture | 67 | 0 | 2 | 0 |
| Final cleanup/import changes | 17 | 0 | 2 | 0 |

The two interim failures were in new strict-verifier fixtures: the synthetic report omitted Vitest's required success=true. The fixture was corrected. The strict report validator and all assertions stayed intact. All301 existing manifest assertions passed in the expanded run and were not unnecessarily rerun.

ESLint commands:

```powershell
npx eslint scripts/release/drivers/operated-contract.ts scripts/release/drivers/operated.ts scripts/release/drivers/drift-repair.ts scripts/release/drivers/crash-partition.ts scripts/release/local-targets.ts scripts/release/local-target-runner.ts scripts/release/scenarios.ts scripts/release/acceptance-orchestrator.ts scripts/ci/gate-manifest.mjs tests/release/drivers-d2.test.ts tests/release/local-targets.test.ts tests/acceptance/drift-repair.operated.test.ts tests/acceptance/crash-partition.operated.test.ts
npx eslint scripts/release/drivers/operated-contract.ts scripts/release/drivers/operated.ts scripts/release/drivers/drift-repair.ts scripts/release/drivers/crash-partition.ts scripts/release/drivers/verify.ts scripts/release/local-targets.ts scripts/release/local-target-runner.ts scripts/release/scenarios.ts scripts/release/acceptance-orchestrator.ts scripts/ci/gate-manifest.mjs tests/release/drivers-d2.test.ts tests/release/local-targets.test.ts tests/acceptance/drift-repair.operated.test.ts tests/acceptance/crash-partition.operated.test.ts
```

First command: one invocation, 13 files, pass1/fail0/skip0, errors0/warnings0. Second command: two invocations, 14 files each, pass2/fail0/skip0, errors0/warnings0, including final code.

Whole-repo compiler command, three serialized invocations:

```powershell
bash Z:/Projects/Spawned.ai/zenith-wt/.resume/codex/tsc-serial.sh
```

First failed with10 TypeScript diagnostics from inference across J2 JavaScript helpers (implicit-any polling predicates, JSON request excess-property typing, and host-environment return inference). Typed reuse wrappers fixed these without changing runtime behavior. Second and third passed with0 diagnostics; the third checks the final cleanup fixes. Overall command counts: pass2/fail1/skip0. No direct or concurrent whole-repo tsc command was used.

Compiler snapshot check:

```powershell
node --input-type=module -e 'import fs from "node:fs"; import crypto from "node:crypto"; const info=JSON.parse(fs.readFileSync("tsconfig.tsbuildinfo","utf8")); const files=["scripts/release/drivers/operated.ts","scripts/release/drivers/crash-partition.ts"]; for(const file of files){const index=info.fileNames.findIndex(name=>name.replace(/^\.\//,"")===file); const version=crypto.createHash("sha256").update(fs.readFileSync(file,"utf8")).digest("hex"); const actual=typeof info.fileInfos[index]==="string"?info.fileInfos[index]:info.fileInfos[index]?.version; process.stdout.write(file+" "+(actual===version?"current":"changed since compiler snapshot")+"\n"); if(actual!==version) process.exitCode=1;}'
```

Exit1: both inspected files had changed after the second compiler snapshot. This was an intentional stale-snapshot detection, not a product test. It justified the third serialized compiler run.

Other verification/read-only commands:

```powershell
node scripts/ci/gate-manifest.mjs drv2-drift-repair
node scripts/ci/gate-manifest.mjs drv2-crash-partition
npx tsx scripts/release/acceptance-orchestrator.ts check
git diff --check
git branch --show-current
node --version
```

Each manifest command: pass1/fail0/skip0; exact dedicated file/gates/test identity printed, no engine started. Scenario check: pass1/fail0/skip0; 19 scenarios,80 mapped files,0 missing. Diff checks including final documentation: four invocations, pass4/fail0/skip0. Branch/runtime observations: prod/j15-drivers-d2 and v22.23.3; case counts N/A.

Final compiler-source snapshot command (exit0, current13/stale0):

```powershell
node --input-type=module -e 'import fs from "node:fs"; import crypto from "node:crypto"; const info=JSON.parse(fs.readFileSync("tsconfig.tsbuildinfo","utf8")); const files=["scripts/release/drivers/operated-contract.ts","scripts/release/drivers/operated.ts","scripts/release/drivers/drift-repair.ts","scripts/release/drivers/crash-partition.ts","scripts/release/drivers/verify.ts","scripts/release/local-targets.ts","scripts/release/local-target-runner.ts","scripts/release/scenarios.ts","scripts/release/acceptance-orchestrator.ts","tests/release/drivers-d2.test.ts","tests/release/local-targets.test.ts","tests/acceptance/drift-repair.operated.test.ts","tests/acceptance/crash-partition.operated.test.ts"]; let stale=0; for(const file of files){const index=info.fileNames.findIndex(name=>name.replace(/^\.\//,"")===file); const version=crypto.createHash("sha256").update(fs.readFileSync(file,"utf8")).digest("hex"); const actual=typeof info.fileInfos[index]==="string"?info.fileInfos[index]:info.fileInfos[index]?.version; if(actual!==version){stale++;process.stdout.write(file+" stale\n");}} process.stdout.write(JSON.stringify({current:files.length-stale,stale})+"\n"); if(stale)process.exitCode=1;'
git status --short --untracked-files=all
```

Status reports exactly the18 intended files below. Final per-file count summary command (exit0, files7/passed368/failed0/skipped2):

```powershell
$drv2Reports = @('C:/Users/user/AppData/Local/Temp/zenith-drv2-vitest-final.json','C:/Users/user/AppData/Local/Temp/zenith-drv2-vitest-repaired.json','C:/Users/user/AppData/Local/Temp/zenith-drv2-vitest-last.json'); $drv2Latest = @{}; foreach ($drv2Report in $drv2Reports) { $drv2Parsed = Get-Content -LiteralPath $drv2Report -Raw | ConvertFrom-Json; foreach ($drv2Result in $drv2Parsed.testResults) { $drv2Latest[$drv2Result.name] = $drv2Result } }; $drv2Assertions = @($drv2Latest.Values | ForEach-Object { $_.assertionResults }); [pscustomobject]@{ files=$drv2Latest.Count; passed=@($drv2Assertions | Where-Object status -eq 'passed').Count; failed=@($drv2Assertions | Where-Object status -eq 'failed').Count; skipped=@($drv2Assertions | Where-Object { $_.status -in @('pending','skipped','todo') }).Count } | ConvertTo-Json -Compress
```

The preceding same count-summary command filtered only status=pending for skips and printed skipped0 (exit0); it was corrected to include Vitest4's skipped status, yielding the2 gated skips already reported by Vitest. This summary filter correction changes no assertion or test result.

Read-only discovery used git status --short, git log --oneline -10, git diff --stat, rg -n and rg --files, and Get-Content with Select-Object/Select-String over the supplied PREAMBLE, FINAL-INTEGRATION, J15-HARNESS-COMPLETION, release/acceptance/default-stack/maintenance modules, J2 browser helpers, affected provider/broker/workflow/store code, CI manifests/report validators, requirement/verify docs, tsconfig/vitest config and the compiler helper. A lightweight MEMORY.md keyword search found no task-relevant implementation facts; no memory-derived fact was used. Skills lean-build and investigate-first were read; only lean-build was applied. These are inspections (test pass/fail/skip N/A), not acceptance commands. Some exploratory wildcard/legacy filenames were absent, one Get-Content invocation supplied a duplicate positional/LiteralPath argument and exited1, and the J2-DEFAULT-JOURNEY/images.env exploration exited1; actual files were subsequently located with rg. No failing check was hidden by these inspections. Tool edits used apply_patch only in the authorized worktree; test output files were written under TEMP.

## Files and minimal joins

Added:

- scripts/release/drivers/operated-contract.ts
- scripts/release/drivers/operated.ts
- scripts/release/drivers/drift-repair.ts
- scripts/release/drivers/crash-partition.ts
- scripts/release/drivers/verify.ts
- tests/release/drivers-d2.test.ts
- tests/acceptance/drift-repair.operated.test.ts
- tests/acceptance/crash-partition.operated.test.ts
- docs/build/production/verify/DRV-2.md
- docs/build/production/verify/DRV-2-COMMANDS.md

Changed:

- scripts/release/local-targets.ts: two additive target overrides, exact operated checks/schema, dedicated gates and derived J1 public CA in local child startup.
- scripts/release/local-target-runner.ts: two dedicated dispatch cases.
- scripts/release/scenarios.ts: only the two owned contract registrations/limits, plus the operated evidence label type.
- scripts/release/acceptance-orchestrator.ts: preserve and validate a command lane's actual evidence label.
- scripts/ci/gate-manifest.mjs: two additive gated lanes and literal test identities.
- tests/release/local-targets.test.ts: exactly compare the new gates/label for these two scenarios; all other expectations stay identical.
- docs/build/production/verify/PROD-REL-01.md and PROD-MIX-07.md: additive requirement links to exact Mac commands.

18 files. The runner/orchestrator and two requirement-doc links are necessary joins outside the narrow new-driver ownership list. No unrelated areas rewritten. No migrations, tables, sensitive-data inventory or SQL-scoping entries added. The one existing expectation change is provably stale because DRV-2 introduces stricter gates and the requested local_operated_rehearsal label; it retains exact assertions.

Remaining: all real operated checks and native lean memory measurements await the Mac. Explicit scope limits: supported approved Kubernetes replica repair instead of inventing a Kubernetes drift.repair adapter; queued-work crash recovery instead of claiming every in-flight provider crash window; no mixed-cloud outage, live acceptance or production promotion. See [DRV-2](DRV-2.md) for setup/cleanup and requirement mapping.

Suggested commit: `feat(release): add operated drift and crash scenario drivers`.

# L2-LIVE-CLOUDS build report

Worktree: `Z:/Projects/Spawned.ai/zenith-wt/prod6-l2-live-clouds`. Base `3a9de905`. Changes are uncommitted; no push, branch change, dependency install or migration edit occurred. No real credential or cloud/DNS/ACME endpoint was used.

## Files

- New executable/provider packets under `scripts/acceptance/live/{azure,gcp,oci,dns}/`; shared strict contracts, permission guard, real HTTP/OCI-signature/DNS/TLS transport, browser-approved teardown, pagination/leak scan, offline tests and a separately gated live file.
- New Azure/GCP/OCI scoped observer federation/budget modules under `deploy/live-sandbox/`, plus OCI IdentityPropagationTrust template.
- New `docs/build/production/LIVE-ACCEPTANCE-CLOUDS.md` and twelve requirement-specific verify docs; additive LIFE-04 successor instructions.
- `ledger.json`: thirteen harness-slice implementation status/notes/test paths only. All 78 acceptance rows, states, required evidence, historical evidence and release flags preserved.

## Executed checks

Counts below are separate runs and are **not summed**.

| Exact command | Result |
|---|---|
| `npx vitest run --config scripts/acceptance/live/dns/vitest.config.ts scripts/acceptance/live/dns/offline.test.ts --no-file-parallelism --maxWorkers=2` (first run) | 30 passed / 0 failed / 0 skipped; 1 file |
| Same exact command after receipt/cancellation fixes | 32 / 0 / 0; 1 file |
| Same exact command after signing/audience/parent/pagination tests | 38 / 0 / 0; 1 file |
| Same exact command after final token/duration guard changes | 38 / 0 / 0; 1 file |
| Same offline command after the sovereign-origin coverage correction | 39 passed / 0 failed / 0 skipped; 1 file |
| Same offline command after requiring an actual sovereign ARM probe | 40 passed / 0 failed / 0 skipped; 1 file |
| Same offline command after finite budget/duration guards | 42 passed / 0 failed / 0 skipped; 1 file |
| Same offline command after explicit-null receipt comparison | 43 passed / 0 failed / 0 skipped; 1 file |
| Same offline command after rejecting non-finite packet estimates | 44 passed / 0 failed / 0 skipped; 1 file |
| Same offline command after Storage typed-empty/grouped-prefix inventory fixes | 46 passed / 0 failed / 0 skipped; 1 file |
| Same offline command after binding typed empties to /items | 46 passed / 0 failed / 0 skipped; 1 file |
| Same offline command after validating the grouped-prefix fixture against the tightened schema | 46 passed / 0 failed / 0 skipped; 1 file |
| Same offline command after refusing response projection/grouping | 48 passed / 0 failed / 0 skipped; 1 file |
| Same offline command after CLI environment typing and DNS/partial-list coverage | 53 passed / 0 failed / 0 skipped; 1 file (final confirmed run) |
| `npx eslint scripts/acceptance/live` (thirteen confirmed runs) | All exit 0, 0 errors / 0 warnings; no tests |
| `git diff --check` (repeated during source/report changes) | Every confirmed run exited 0; no whitespace defects; no tests |
| `npx vitest run --config scripts/acceptance/live/dns/vitest.config.ts scripts/acceptance/live/dns/clouds.live.test.ts --no-file-parallelism --maxWorkers=2` | 0 passed / 0 failed / 4 skipped; 1 skipped file. Provider/DNS opt-ins explicitly removed from the child shell first. No live bodies ran. |
| `npx tsx scripts/acceptance/live/azure/run.ts --plan --packet scripts/acceptance/live/azure/packet.json.example` (three runs) | Each exit 0; 18 declared checks; 0 credential reads / 0 network calls |
| `npx tsx scripts/acceptance/live/gcp/run.ts --plan --packet scripts/acceptance/live/gcp/packet.json.example` (three runs) | Each exit 0; 14 declared checks; 0 credential reads / 0 network calls |
| `npx tsx scripts/acceptance/live/oci/run.ts --plan --packet scripts/acceptance/live/oci/packet.json.example` (three runs) | Each exit 0; 18 declared checks; 0 credential reads / 0 network calls |
| `tofu fmt -recursive deploy/live-sandbox` | Could not launch: WinGet link association error. No format/validate result. |
| `& 'C:\Users\user\AppData\Local\Microsoft\WinGet\Packages\OpenTofu.Tofu_Microsoft.Winget.Source_8wekyb3d8bbwe\tofu.exe' fmt -recursive deploy/live-sandbox` | Could not launch: access denied. No format/validate result. |
| `bash Z:/Projects/Spawned.ai/zenith-wt/.resume/codex/tsc-serial.sh` (first run) | Exit 1; 2 owned TS2345 diagnostics at offline.test.ts:97 and :107. Next requires NODE_ENV on ProcessEnv; isolated test environment maps lacked it. No tests. |
| Same exact serialized command after the CLI environment type fix and final inventory guards | Exit 0; 0 remaining diagnostics. TypeScript 5.9.3 cache versions match all 11 final owned TS files; no tests. |

Each PowerShell execution prepended exactly `$env:PATH = 'C:\Users\user\.local\sdk\node22;' + $env:PATH`. No raw whole-repo compiler command or whole test suite was run. No test assertion/expectation was changed; all new tests are clearly offline contracts. Test reruns followed new code or tests.

One scoped test/lint shell attempt failed before process launch with `helper_unknown_error: apply deny-read ACLs`; no test counts exist for that attempt. The same command was retried without changing permissions and passed (40 / 0 / 0). A later tool response was truncated during the explicit-null test/lint attempt, so its unavailable result is not counted; the final confirmed retry above passed 43 / 0 / 0 and lint exited 0.

A separate Node read-only invariant comparison used `git show HEAD:docs/build/production/ledger.json` and the current JSON: 78 rows, 13 notes changed, 0 acceptance/state/evidence/release flag changes. The ledger update script modified exactly those thirteen rows. Plans were redirected to a new owned temp directory and parsed locally; their estimates are provisional input, not actual spend or provider verification.

## Inspection command audit

Read-only commands below had no test pass/skip counts. Common PATH prefix above applies to every shell. Repeated reads are listed together; missing/stale file paths were resolved to the existing combined docs. None was mistaken for a verification gate.

- `Get-Content -LiteralPath 'Z:\Projects\Spawned.ai\zenith-wt\.resume\PREAMBLE.md'`
- `git status --short`; `git log --oneline -10`
- `rg -n 'Zenith|production|cloud|acceptance' 'C:\Users\user\.codex\memories\MEMORY.md'` (quick pass; no task-specific prior harness decisions used)
- `Get-Content -LiteralPath 'docs/build/production/WIP-HANDOFF-2026-10-08.md'`; `Get-Content -LiteralPath 'Z:\Projects\Spawned.ai\zenith-wt\.resume\PLAN-100.md'`
- `rg -n 'live_sandbox|Azure|GCP|OCI|DNS|ACME|permissions.json' docs/build/production/ledger.json`
- `rg --files scripts/acceptance deploy tests | rg 'live|sandbox|azure|gcp|oci|dns|acme'`
- `Get-Content package.json`; `Get-Content tsconfig.json`
- Node JSON inspection: `require('./docs/build/production/ledger.json')`, print top-level keys and rows requiring live_sandbox plus LIFE-04/05/06; no modification.
- `Get-Content scripts/acceptance/azure-live.ts`; `Get-Content scripts/acceptance/non-aws-dns-live.ts`
- `rg --files | rg 'permissions.json|live.*harness|acceptance.*shared'`
- `rg -n '^###|^##|L2-LIVE|P3|T[0-9]+|PROD-(MIX|LIFE-0[3456]|MAN)' 'Z:\Projects\Spawned.ai\zenith-wt\.resume\PLAN-100.md'`
- PLAN line-array reads: `$p[202..264]`, `$p[357..381]`, `$p[517..549]`, `$p[910..934]`, `$p[987..1009]`
- `Get-Content docs/build/production/verify/PROD-LIFE-04.md`; attempted LIFE-05.md / LIFE-06.md (absent in base); `Get-Content docs/build/production/verify/PROD-LIFE-05-06.md | Select-Object -Last 95`; `Get-Content docs/build/production/verify/PROD-MIX-03-04.md | Select-Object -Last 55`
- `Get-Content tests/live/mixed-cloud.live.test.ts` (repeated); `Get-Content tests/acceptance/non-aws-dns-live.test.ts`
- `rg --files scripts/acceptance`; `Get-Content scripts/acceptance/clients/control-plane.ts` (repeated); `Get-Content scripts/acceptance/config.ts` (repeated)
- `Get-Content vitest.config.ts`; `Get-Content eslint.config.mjs`; `rg -n 'include|exclude|test:' vitest.config.ts`; `Get-Content vitest.config.ts -TotalCount 42`
- `rg -n 'permissions|budget|live_sandbox' scripts/acceptance scripts/build docs/build/production/permissions*`; `rg -n 'permissions|budget' scripts/acceptance` (repeated)
- `rg -n 'resource_principal|oidc|workload|federat' src/lib/providers/oci src/lib/credentials/types.ts`
- `Get-Command tofu -ErrorAction SilentlyContinue`; `node --version` (22.23.3)
- `Get-Content scripts/acceptance/permissions.ts -ErrorAction SilentlyContinue` (absent); `rg --files docs/build/production | rg 'permissions|PROD-MIX|PROD-MAN'`; `rg --files | rg 'permissions.json'`
- `Get-Content scripts/acceptance/scenarios/_shared.ts`
- `rg -n 'id:|deploy|release' src/lib/actions/registry.ts src/lib/capabilities/catalog.ts` (registry path absent)
- `Get-Content src/lib/capabilities/catalog.ts -TotalCount 155`; `Get-Content scripts/acceptance/mixed-evidence.ts -TotalCount 160`
- `Get-Content docs/build/production/verify/PROD-LIFE-05.md | Select-Object -Last 65` (absent at that time); `Get-Content src/lib/providers/oci/credentials.ts -TotalCount 110` (absent)
- `rg -n 'Request|body:|scope:|infrastructure.destroy' scripts/acceptance/scenarios/a-autonomous-deploy.ts scripts/acceptance/cleanup.ts`
- `rg --files src/app/api/platform | rg 'managed|mixed|operation|environment'`
- `rg -n 'permissions|budget|ledger' scripts/release -g '*.ts' -g '*.mjs'` (Wave 5 directory absent)
- `rg --files docs/build/production/verify | rg 'LIFE-0[456]|MAN|MIX'`
- `Get-Content deploy/azure/versions.tf`; `Get-Content deploy/gcp/versions.tf`; `Get-Content deploy/oci/versions.tf`
- `Get-Content src/lib/providers/gcp/credentials.ts -TotalCount 90`; `Get-Content src/lib/credentials/oci.ts -TotalCount 80` (OCI path absent)
- One malformed `Get-Content` invocation attempted the resources route with both positional path and LiteralPath; it failed without changes.
- `Get-Content -LiteralPath 'Z:\Projects\Spawned.ai\zenith-wt\.resume\codex\tsc-serial.sh'`
- `rg --files 'C:\Users\user\.local\sdk' | rg 'tofu|terraform'`
- `Get-Content -LiteralPath 'src/app/api/platform/v1/mixed/plans/[id]/route.ts' -TotalCount 75`; `Get-Content -LiteralPath 'src/app/api/platform/v1/environments/[id]/teardown-review/route.ts' -TotalCount 130`
- `Get-Item -LiteralPath 'C:\Users\user\AppData\Local\Microsoft\WinGet\Links\tofu.exe' | Format-List LinkType,Target`
- `rg --files 'C:\Users\user\AppData\Local\Microsoft\WinGet\Packages' | rg 'tofu.exe$'` (three unrelated subdirectories denied read; actual tofu path found)
- `rg -n 'implementationStatus|notes|testPaths' scripts/build/ledger.mjs -m 15`; `Get-Content docs/build/production/ledger.json -TotalCount 85`; `Get-Content scripts/acceptance/evidence.ts -TotalCount 95`
- `git diff --stat`; `git status --short`
- `Get-Item -LiteralPath 'C:\Users\user\AppData\Local\Temp\zenith-tsc.lock' -ErrorAction SilentlyContinue | Select-Object FullName,CreationTime,LastWriteTime`; `Get-CimInstance Win32_Process -Filter "name = 'node.exe'" | Where-Object { $_.CommandLine -match 'tsc|vitest|eslint' } | Select-Object ProcessId,CommandLine` (WMI denied; no process changes)
- `Remove-Item -Path Env:ZENITH_LIVE_AZURE,Env:ZENITH_LIVE_GCP,Env:ZENITH_LIVE_OCI,Env:ZENITH_LIVE_DNS -ErrorAction SilentlyContinue` (only this child shell's gates, before the skipped-file check)

Public documentation was searched/opened via the web tool for Microsoft, Google and Oracle federation/OCI authenticated RPST exchange plus provider budget schemas. No cloud service API was queried. The campaign contains the primary links and labels unverified OCI policy admission explicitly.

## Remaining and handoff boundaries

- Live calls, real DNS/ACME, browser approvals and operated Wave 5 fixture/fault/data journeys were not run (needs accountable approval, provisioned accounts and the Mac environment). Four gated tests skipped explicitly.
- OpenTofu format/validate was not run (needs a usable executable and initialized pinned providers); exact Mac init/validate/fmt commands are in the campaign.
- Wave 5 must emit the typed operated packet, add `zenith_live_run` labels/tags, supply canonical default fixture startup and merge the shared permission envelope. It also supplies mixed fault chronology, independent DB traffic/export/restore/renewal proof and the AWS partition's receipt. Those files are outside this ownership scope.
- OCI IdentityPropagationTrust bootstrap, authenticated non-admin exchange caller and IAM condition/service permission admission still need the actual tenancy. No anonymous exchange or admin fallback is claimed.
- Physical deletion cannot be guaranteed after SIGKILL, credential/permission loss, failed dependency cleanup or absent browser approval. The runner fails closed, attempts bounded finally cleanup/leak scans and preserves the immutable packet for `--cleanup`.
- No changes to existing production provider/core code, installer, workflows, package files, SQL/migrations, old tests, ledger evidence or release flags. No test expectation deviations. The custom test config keeps tests inside the owned scripts path; assembler must wire that lane.

Suggested commit: `test(acceptance): add gated Azure GCP OCI and DNS harnesses`.

Final read-only scope audit: `git diff --check` exited 0 and `git status --porcelain --untracked-files=all` reported 35 changed/added files, entirely in the assigned harness/deploy/docs/ledger paths. Report-only PowerShell normalization replaced doubled display backslashes with single backslashes; no code or credentials were changed.

Final corrections: sovereign acceptance requires an actual sovereign ARM probe; unused allowed origins or data-plane hosts cannot close it. Budgets and plan estimates reject non-finite numbers, and explicit-null receipt comparisons distinguish null, absence and numeric overflow. All new regressions passed; no existing test or expectation changed. Serial lock diagnostics used `Get-Command bash | Select-Object Source` (Git Bash confirmed), `Get-Date`, a Node `fs.statSync` mtime read of the shared lock, and `Get-Process -Name node,bash -ErrorAction SilentlyContinue | Select-Object Id,ProcessName,CPU,StartTime,WorkingSet64`. No lock or other worker process was modified.

Additional final read-only commands: `rg -n 'explicit null|expected:|function equal|const equal' scripts/acceptance/live/dns/offline.test.ts scripts/acceptance/live/dns/contracts.ts scripts/acceptance/live/dns/runtime.ts`; `Get-Content scripts/acceptance/live/dns/cli.ts`; `Get-Content scripts/acceptance/live/dns/contracts.ts`; `Get-Content scripts/acceptance/live/dns/runtime.ts | Select-Object -Skip 280`; `Get-Content docs/build/production/LIVE-ACCEPTANCE-CLOUDS.md`; repeated report/status reads. All exited 0; no test counts apply.

Compiler wait diagnostics also read `tsconfig.json`, inspected `tsconfig.tsbuildinfo` existence/metadata with Node `fs`, read shared-lock metadata with Node `fs.statSync`, and ran `Get-Acl -LiteralPath 'C:\Users\user\AppData\Local\Temp\zenith-tsc.lock' -ErrorAction SilentlyContinue | Select-Object Owner,AccessToString` (exit 0). A separate scratch probe used `$probeLockDirectory = 'C:/Users/user/AppData/Local/Temp/zenith-live-lock-probe-' + [guid]::NewGuid().ToString('N'); bash -c 'mkdir "$1" && rmdir "$1"' -- $probeLockDirectory` (exit 0, no shared-lock mutation). `rg -n -C 5 'finite|budget' scripts/acceptance/live/dns/offline.test.ts` exited 0. These diagnostics have no test counts.

The final GCP Storage contract review used `rg -n -C 6 'emptyListKind|typed empty' scripts/acceptance/live/dns/runtime.ts scripts/acceptance/live/dns/offline.test.ts` (exit 0) and Google's primary objects-list documentation. The schema recognizes `storage#objects` / `storage#buckets`; nonempty grouped object prefixes refuse leak-scan completion. Both offline regressions passed. The campaign was updated using `System.IO.File.ReadAllText`, a literal `.Replace` of the inventory sentence, and UTF-8 `System.IO.File.WriteAllText` (exit 0); no credentials or endpoint were read. Primary reference: [Storage objects list](https://docs.cloud.google.com/storage/docs/json_api/v1/objects/list).

Typed-empty handling is additionally bound to the documented `/items` pointer, in both schema and runtime. A misspelled pointer refuses the packet instead of hiding an actual nonempty list. The negative regression passed for both Compute and Storage. All modified test files in this job are newly added; no base test assertion or expectation changed.

The final plan rerun expanded the three exact commands above through a PowerShell `foreach ($cloudProvider in @('azure', 'gcp', 'oci'))` loop, parsed each stdout via `ConvertFrom-Json`, and checked both call counters equal zero. All three passed against the tightened schema. A repeated read-only Node audit used `git status --porcelain --untracked-files=all` through `execFileSync` plus `fs.statSync` of the lock and `fs.existsSync` of the compiler cache: 35 changed/added files, no lock/process mutations. No test counts apply to those inspection commands.

The CLI environment seam now uses `Readonly<Record<string, string | undefined>>`, matching the isolated read-only env input that the guard actually needs. This fixes both owned compiler errors without importing ambient credentials into tests. Additional final guards refuse GCP response masks/grouping and partial-success mode on every inventory page, reject unreachable-resource lists, and map typed DNS collections to `/rrsets` and `/managedZones`. Kind mismatches and malformed pointers still fail closed; actual cloud discriminator/IAM admission remains a Mac/live check. Primary references: [Storage partial responses](https://docs.cloud.google.com/storage/docs/json_api), [bucket partial listings](https://docs.cloud.google.com/storage/docs/json_api/v1/buckets/list), [DNS record-set collections](https://docs.cloud.google.com/dns/docs/reference/rest/v1/resourceRecordSets/list), [DNS zone collections](https://docs.cloud.google.com/dns/docs/reference/rest/v1/managedZones/list).

Final inspection commands also read `runtime.ts -TotalCount 16`; checked `require("typescript/package.json").version` and `require.resolve("typescript/lib/tsc.js")` with Node (5.9.3, locally installed in compose/node_modules); and inspected shared-lock entry count with `fs.readdirSync` (0 entries). All exited 0; no test counts. Public-source discovery searches did not provide an exact DNS kind literal, so those literals are an explicit live-readback prerequisite, not claimed-current provider proof. No real cloud API was queried.

Final compiler/scope audit: Node loaded `tsconfig.tsbuildinfo`, obtained the current 35-file status with `git status --porcelain --untracked-files=all`, resolved each of the 11 owned TS paths against `fileNames`, and compared each `fileInfos.version` with `typescript.sys.createHash(typescript.sys.readFile(path))`. Result: 11/11 current source versions matched, 0 mismatches, compiler 5.9.3, exit 0. `git diff --check` also exited 0. The three plan entry points were rerun after this audit and all exited 0 with their original counts and zero credential reads/network calls. Only report text changed afterward; no further compiler or test rerun is needed.

## Exact changed file inventory

```text
docs/build/production/ledger.json (modified)
docs/build/production/verify/PROD-LIFE-04.md (modified)
deploy/live-sandbox/azure/main.tf
deploy/live-sandbox/gcp/main.tf
deploy/live-sandbox/oci/github-trust.json.example
deploy/live-sandbox/oci/main.tf
docs/build/production/LIVE-ACCEPTANCE-CLOUDS.md
docs/build/production/verify/L2-LIVE-CLOUDS.md
docs/build/production/verify/PROD-LIFE-05.md
docs/build/production/verify/PROD-LIFE-06.md
docs/build/production/verify/PROD-MAN-01.md
docs/build/production/verify/PROD-MAN-02.md
docs/build/production/verify/PROD-MAN-03.md
docs/build/production/verify/PROD-MIX-01.md
docs/build/production/verify/PROD-MIX-02.md
docs/build/production/verify/PROD-MIX-03.md
docs/build/production/verify/PROD-MIX-04.md
docs/build/production/verify/PROD-MIX-05.md
docs/build/production/verify/PROD-MIX-06.md
docs/build/production/verify/PROD-MIX-07.md
scripts/acceptance/live/azure/packet.json.example
scripts/acceptance/live/azure/run.ts
scripts/acceptance/live/dns/cli.ts
scripts/acceptance/live/dns/clouds.live.test.ts
scripts/acceptance/live/dns/contracts.ts
scripts/acceptance/live/dns/guard.ts
scripts/acceptance/live/dns/offline.test.ts
scripts/acceptance/live/dns/permissions.json.example
scripts/acceptance/live/dns/run.ts
scripts/acceptance/live/dns/runtime.ts
scripts/acceptance/live/dns/vitest.config.ts
scripts/acceptance/live/gcp/packet.json.example
scripts/acceptance/live/gcp/run.ts
scripts/acceptance/live/oci/packet.json.example
scripts/acceptance/live/oci/run.ts
```

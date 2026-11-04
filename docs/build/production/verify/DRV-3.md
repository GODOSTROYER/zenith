# DRV-3: operated upgrade and restore

Built in `prod7-drivers-d3` from `7d52b372`. Verification status remains
`implementation_complete_verification_pending`. No migration, dependency change,
Git write, real credential, real cloud API or production approval.

## Implementation and acceptance

| Requirement | Operation and independent evidence | Tests |
| --- | --- | --- |
| PROD-REL-01 upgrade | Fresh lean J1 stack; J2 real Auth/Mailpit/MFA and separate admin; browser-authored immutable deployment review; pinned owned ARM64 candidate images; expand then worker then API; observe the same Temporal run across both replacement and rollback; stop the API and independently observe outage; restore old images without downgrading SQL; approve the retained review through the UI; read deployed witness through independent kubectl and terminal ledger/history | `tests/acceptance/operated-upgrade.engine.test.ts` |
| PROD-OPS-03 | Existing `rolling-upgrade.mjs` supplies ordering and compatibility suite inventory; all compatibility assertions must pass without skips; migrations use candidate J1 maintenance image; current schema/readiness and exact running images checked | Same engine suite, existing rolling-upgrade/component suites, `tests/release/operated-drivers.test.ts` |
| PROD-REL-01 restore / PROD-OPS-04 | Browser-approved operation snapshotted with real product/public, platform, agent, hosted and Temporal inventory; execute and independently observe consumption after snapshot; stop writers; refuse corrupt backup, missing key custody and nonempty target before a restore write; restore into a newly owned local database; compare facts and bump epoch through existing recovery tooling; terminate lost operation workflows; independent SQL proves restored unconsumed approval is below current epoch; real MCP refuses it; kind remains unchanged; exact browser recovery binding rejects stale digest and resumes into a new approval round; UI approval and fresh mutation independently read back | `tests/acceptance/operated-restore.engine.test.ts` |
| Both | J4 migration-seeded cleanup epoch read, never repaired; ownership-bound J1/J2 cleanup in `finally`; every cleanup attempted even after failure; kind and Docker absence and restored database absence checked; private dumps/config/logs removed; closed sanitized check inventory and source/run/scenario binding | `tests/release/operated-drivers.test.ts`, `tests/release/local-targets.test.ts` |

Drivers: `scripts/release/drivers/{contracts,operated,upgrade,restore}.ts`.
Minimal joins: local-target catalog and planner, J1/J2 joined subprocess dispatch
(CA trust is configured at process launch), scenario requirement mapping, canonical
`j15-operated-upgrade` and `j15-operated-restore` gate lanes, orchestrator receipt
label preservation. These lanes are reachable through `--local-targets` and the
ordinary local-target runner. They do not call the generic J2 journey and project
its unrelated checks into an upgrade/restore pass.

Full inventory, **19 files**:

- Added: `scripts/release/drivers/contracts.ts`, `operated.ts`, `upgrade.ts`,
  `restore.ts`; `tests/release/operated-drivers.test.ts`;
  `tests/acceptance/operated-upgrade.engine.test.ts` and
  `tests/acceptance/operated-restore.engine.test.ts`; this verify document.
- Modified: `deploy/acceptance/local-targets/scenarios.json`;
  `scripts/release/scenarios.ts`, `local-targets.ts`, `local-joined.ts`,
  `acceptance-orchestrator.ts`; `scripts/ci/gate-manifest.mjs`;
  `tests/release/local-targets.test.ts`; `docs/build/production/verify/PROD-OPS-03.md`,
  `PROD-OPS-04.md`, `PROD-REL-01.md`, `REL-01.md`.

Both receipts use **`local_operated_rehearsal`**. Generic local receipts cannot
satisfy them. Missing, duplicate, unknown, foreign or live-labelled evidence is
refused. Failed actions and cleanup failures remain failed; unreached actions are
skipped. The child exit code and every required check must succeed. No raw API
response, database URL, key, token, password, diagnostic or exception enters the
sanitized receipt.

## Exact lean-profile Mac plan

Run each scenario separately from repository root with Node 22 on native ARM64
macOS. Docker Desktop: 4 GiB; one kind node; no other heavy profile. Tools: Docker,
Supabase CLI 2.75.0, kind, kubectl, openssl, Temporal CLI 1.9.1, already installed
Chromium. PostgreSQL clients must match **J1's actual server major** (its CLI
project currently requests 17). Do not substitute the J15 mixed fixture's 16.15
clients. Real tests are not run on this PC.

Before starting J1, supply the verifier's native digest pins for `GO_BUILDER_IMAGE`
and `DISTROLESS_IMAGE` from `docker/zenithd.Dockerfile`, and the reviewed
recorded histories under `tests/fixtures/workflow-histories`. When those histories
are absent, record them using the existing Mac recorder **before** J1 source
binding: `ZENITH_RECORD_WORKFLOW_HISTORIES=1 npx vitest run tests/workflows/history-record.test.ts --no-file-parallelism --maxWorkers=2`.
The driver refuses any skipped replay assertion; recording is not itself a replay
pass.

```bash
node --version                         # v22.x
umask 077
export ZENITH_ACCEPTANCE_DEFAULT_STACK=1
export ZENITH_DEFAULT_JOURNEY=1
export ZENITH_LOCAL_TARGETS=1
export ZENITH_LOCAL_JOINED_DRIVERS=1
export ZENITH_LOCAL_OPERATED=1
export ZENITH_LOCAL_RUN_ID=drv3-upgrade # use drv3-restore for the second fresh run
PRIVATE_BASE="$(node -e 'process.stdout.write(require("fs").realpathSync(require("os").tmpdir()))')"
PRIVATE_STACK="$(mktemp -d "$PRIVATE_BASE/zenith-drv3-stack-XXXXXX")"
PRIVATE_J2="$(mktemp -d "$PRIVATE_BASE/zenith-drv3-j2-XXXXXX")"
export ZENITH_LOCAL_ROOT="$(mktemp -d "$PRIVATE_BASE/zenith-j15-$ZENITH_LOCAL_RUN_ID-XXXXXX")"
export ZENITH_ACCEPTANCE_DEFAULT_STACK_DIR="$PRIVATE_STACK"
export ZENITH_LOCAL_JOURNEY_CONFIG_FILE="$PRIVATE_J2/journey.json"
node scripts/acceptance/default-stack/up.mjs --profile lean --directory "$PRIVATE_STACK"
node scripts/acceptance/default-stack/env.mjs "$PRIVATE_STACK" "$PRIVATE_STACK/host.env"
```

Add `supabase.localhost -> 127.0.0.1` to the local resolver and trust the generated
public `$PRIVATE_STACK/tls/ca.crt` for Chromium. Trust the public certificate, never
disable TLS verification. The runner passes `NODE_EXTRA_CA_CERTS` to the child.
OIDC issuer setup is not needed for this linked-agent path; linked-agent browser
consent, real Auth identity, current admin membership and AAL2 are still required.

For upgrade, first run the candidate-image block below, then this J2 block.
J2's owned prepare command refuses an existing kind cluster. Build the actual
witness using verifier-supplied native pins; it also contains the J2 machine
binary, but these two scenarios use its Kubernetes application only. The registry
is J1's owned localhost registry; the following registry writes are local:

```bash
export GO_BUILDER_IMAGE='golang:1.27-alpine@sha256:8a5910f31396cd4d89662f56c68b3ae31d374308270a1c3bd96672ee5ed43414'
export DISTROLESS_IMAGE='gcr.io/distroless/static-debian12:nonroot@sha256:afa5c872c891853ca7fcf1f12c3edb23f7eeef36189728842dd51042ff57f7ab'
# Pause the owned services while compiling on the 4-GiB Docker budget.
node --input-type=module <<'NODE'
import { readState, compose, docker } from './scripts/acceptance/default-stack/runtime.mjs';
const state = readState(process.env.ZENITH_ACCEPTANCE_DEFAULT_STACK_DIR);
await compose(state, ['stop','api','execution-worker','temporal']);
await docker(['stop', ...['db','auth','rest','kong','pooler'].map(role => `supabase_${role}_${state.projectId}`)]);
NODE
docker build --platform linux/arm64 --build-arg "GO_BUILDER_IMAGE=$GO_BUILDER_IMAGE" \
  --build-arg "DISTROLESS_IMAGE=$DISTROLESS_IMAGE" -f tests/e2e/default/zenithd.Dockerfile \
  -t localhost:5000/zenith-j2-witness:drv3 .
docker push localhost:5000/zenith-j2-witness:drv3
WITNESS_IMAGE="$(docker image inspect localhost:5000/zenith-j2-witness:drv3 --format '{{index .RepoDigests 0}}')"
node --input-type=module <<'NODE'
import { readState, compose, docker } from './scripts/acceptance/default-stack/runtime.mjs';
const state = readState(process.env.ZENITH_ACCEPTANCE_DEFAULT_STACK_DIR);
await docker(['start', ...['db','auth','rest','kong','pooler'].map(role => `supabase_${role}_${state.projectId}`)]);
await compose(state, ['up','-d','--wait','api','execution-worker','temporal']);
NODE
node tests/e2e/default/prepare.mjs --directory "$PRIVATE_J2" \
  --stack-directory "$PRIVATE_STACK" --witness-image "$WITNESS_IMAGE" \
  --mailpit-url http://127.0.0.1:8025
```

For upgrade, a private `ZENITH_LOCAL_UPGRADE_IMAGES_FILE` must contain the strict
JSON `{ "schema": 1, "api": "localhost:5000/zenith-<J1 owner>/api@sha256:...",
"worker": "localhost:5000/zenith-<J1 owner>/worker@sha256:...", "migration":
"localhost:5000/zenith-<J1 owner>/migration@sha256:..." }`. All three artifacts
must differ from J1's old artifacts, exist locally, be native ARM64 and carry J1's
exact `io.zenith.installation` label. Mutable, remote, foreign, same-artifact and
absent candidates refuse before replacement. To generate a compatible same-source
image fixture with distinct build labels, run this before target preparation to
avoid compiling alongside kind. It proves artifact replacement, not a released
N-1/N binary matrix; the component compatibility gates cover their stated model.

```bash
export ZENITH_LOCAL_UPGRADE_IMAGES_FILE="$ZENITH_LOCAL_ROOT/upgrade-images.json"
node --input-type=module <<'NODE'
import fs from 'node:fs';
import { readState, compose, docker } from './scripts/acceptance/default-stack/runtime.mjs';
const state = readState(process.env.ZENITH_ACCEPTANCE_DEFAULT_STACK_DIR);
const input = JSON.parse(fs.readFileSync(state.directory + '/input.json', 'utf8'));
const roles = ['db', 'auth', 'rest', 'kong', 'pooler'];
const cli = roles.map(role => `supabase_${role}_${state.projectId}`);
await compose(state, ['stop', 'api', 'execution-worker', 'temporal']);
await docker(['stop', ...cli]);
const images = { schema: 1 };
try {
  for (const [role, file] of [['api','Dockerfile'],['worker','docker/worker.Dockerfile'],['migration','deploy/self-hosted/migrations.Dockerfile']]) {
    const tag = `localhost:5000/zenith-${state.installationId}/${role}:drv3`;
    const args = ['build','--platform','linux/arm64','--label',`io.zenith.installation=${state.installationId}`,
      '--label',`io.zenith.rehearsal=${process.env.ZENITH_LOCAL_RUN_ID}`,'-f',file,'-t',tag];
    if (role === 'api') for (const [key,value] of Object.entries(input.environment))
      if (key.startsWith('NEXT_PUBLIC_')) args.push('--build-arg',`${key}=${value}`);
    await docker([...args,'.'], { timeout: 1800000 });
    await docker(['push',tag]);
    images[role] = JSON.parse(await docker(['image','inspect',tag]))[0].RepoDigests.find(ref => ref.startsWith(tag.split(':drv3')[0] + '@'));
  }
  fs.writeFileSync(process.env.ZENITH_LOCAL_UPGRADE_IMAGES_FILE, JSON.stringify(images), { mode: 0o600, flag: 'wx' });
} finally {
  await docker(['start', ...cli]);
  await compose(state, ['up','-d','--wait','api','execution-worker','temporal']);
}
NODE
```

Run the upgrade gate (after preparing J2). It consumes its fresh J1/J2 stack,
including on failure; use another fresh stack and kind cluster for restore.

```bash
node scripts/ci/gate-manifest.mjs j15-operated-upgrade
node scripts/ci/run-gate.mjs j15-operated-upgrade --run \
  --report "$ZENITH_LOCAL_ROOT/upgrade-vitest.json" --evidence "$ZENITH_LOCAL_ROOT/upgrade-evidence.json"
node scripts/ci/run-gate.mjs j15-operated-upgrade --validate "$ZENITH_LOCAL_ROOT/upgrade-vitest.json" \
  --require-execution --evidence "$ZENITH_LOCAL_ROOT/upgrade-evidence.json"
```

Restore: repeat the common fixture commands with `ZENITH_LOCAL_RUN_ID=drv3-restore`,
new private directories and J2 preparation. No candidate images needed. Set absolute
`ZENITH_TEST_PG_DUMP_BIN`, `ZENITH_TEST_PG_RESTORE_BIN` and
`ZENITH_TEST_TEMPORAL_BIN` when tools are not on PATH. The driver derives direct
database credentials and namespace from J1's private prepared state, not an
operator-supplied arbitrary URL.

```bash
node scripts/ci/gate-manifest.mjs j15-operated-restore
node scripts/ci/run-gate.mjs j15-operated-restore --run \
  --report "$ZENITH_LOCAL_ROOT/restore-vitest.json" --evidence "$ZENITH_LOCAL_ROOT/restore-evidence.json"
node scripts/ci/run-gate.mjs j15-operated-restore --validate "$ZENITH_LOCAL_ROOT/restore-vitest.json" \
  --require-execution --evidence "$ZENITH_LOCAL_ROOT/restore-evidence.json"
```

Expected per operated gate: **1 passed, 0 failed, 0 skipped**, and strict validation
exit 0. Upgrade receipt: 10 passed checks. Restore receipt: 14 passed checks. The
checked case cannot pass if the gate is absent, a precondition is missing, the
child fails, readback disagrees or cleanup leaves anything owned. An ungated test
collection skips that case; this is not an operated pass.

Equivalent scenario-runner entry after fresh fixture preparation (choose ONE
scenario, because the first consumes the stack):

```bash
npx tsx scripts/release/acceptance-orchestrator.ts run --only upgrade \
  --local-targets --run-id "$ZENITH_LOCAL_RUN_ID" --out "$ZENITH_LOCAL_ROOT/orchestrator"
# For a fresh restore fixture: --only restore
```

The scenario runner also requires its component lanes; component skips cannot be
promoted. It never invokes a live lane in local mode.

## Limits and cleanup recovery

- Not run here: Docker, real PostgreSQL/Temporal, kind, browser, native clients or
  operated gates. Mac measurements, adjacent-release compatibility and live
  provider acceptance remain pending. Lean profile has intentional process pauses.
- Backup/restore uses the existing production recovery machinery, plus Auth and
  extension prerequisites for public-schema FKs. No SQL/migration snapshot is
  changed. Actual Mac acceptance will fail if the owned pooler cannot route the
  fresh database, a prerequisite schema dependency is missing, source facts
  disagree, the old timeline is not terminated or a browser decision is refused.
  Epoch/item readback from the reopened API prevents a successful source-DB request
  from masquerading as restored-DB acceptance.
- J1/J2 fixtures are transferred to this invocation only under explicit gates.
  Cleanup stops restored writers, closes handles, drops only the database created
  after observed absence with its exact ownership marker, deletes only J2's
  recorded container/cluster, then runs J1's label-bound independent inventory
  cleanup. All registered finalizers are attempted. Cleanup errors make the run
  fail. Private evidence receipt remains; generated private backups/Auth dumps/logs
  and J1 credentials are removed. Private J2 configuration remains for provenance;
  deleting its actual cluster invalidates its local credentials. No global prune
  or borrowed cluster deletion.
- If fixture setup fails before the driver starts, run J1's own down command and
  delete J2 only after comparing its current container ID with the private
  `targets.json`: `node scripts/acceptance/default-stack/down.mjs "$PRIVATE_STACK"`.
  Do not delete a replaced/foreign cluster. Reuse no partially operated fixture.
- Primary receipt is sanitized. Gate evidence produced by the canonical gate
  runner records the source/manifest/command environment hashes and strict test
  identity. Keep failed evidence; do not label it live or promote ledger status.

## PC checks and justified expectation change

Every shell prepends `C:\Users\user\.local\sdk\node22` to PATH. Checks and exact
attempt counts are reported in the final handoff. Read-only `Get-Content`, `rg`,
`git status/log/diff` and `apply_patch` have no assertion counts. A lightweight
memory search found no applicable production-program context. Some exploratory
path/wildcard reads were absent; no product action occurred from them.

One existing assertion changed: the 19-scenario registry test now expects the
required `local_operated_rehearsal` label and additional explicit gates for upgrade
and restore. Its old universal `local_rehearsal` expectation contradicted this
handoff. Exact existing labels/gates remain asserted for the other 17 scenarios.
No assertion/gate was deleted, disabled or relaxed.

Exact executed verification commands (all with the Node 22 PATH prefix above):

```powershell
npx vitest run tests/release/operated-drivers.test.ts tests/release/local-targets.test.ts tests/release/acceptance-scenarios.test.ts tests/release/orchestrator.test.ts --no-file-parallelism --maxWorkers=2
npx vitest run tests/release/operated-drivers.test.ts tests/ci/gate-manifest.test.ts --no-file-parallelism --maxWorkers=2
npx vitest run tests/release/operated-drivers.test.ts tests/release/local-targets.test.ts --no-file-parallelism --maxWorkers=2
bash Z:/Projects/Spawned.ai/zenith-wt/.resume/codex/tsc-serial.sh
npx eslint scripts/release/drivers/contracts.ts scripts/release/drivers/operated.ts scripts/release/drivers/upgrade.ts scripts/release/drivers/restore.ts scripts/release/scenarios.ts scripts/release/local-targets.ts scripts/release/local-joined.ts scripts/release/acceptance-orchestrator.ts scripts/ci/gate-manifest.mjs tests/release/operated-drivers.test.ts tests/acceptance/operated-upgrade.engine.test.ts tests/acceptance/operated-restore.engine.test.ts
npx eslint scripts/release/drivers/contracts.ts scripts/release/drivers/operated.ts scripts/release/drivers/upgrade.ts scripts/release/drivers/restore.ts scripts/release/scenarios.ts scripts/release/local-targets.ts scripts/release/local-joined.ts scripts/release/acceptance-orchestrator.ts scripts/ci/gate-manifest.mjs tests/release/operated-drivers.test.ts tests/release/local-targets.test.ts tests/acceptance/operated-upgrade.engine.test.ts tests/acceptance/operated-restore.engine.test.ts
npx eslint scripts/release/drivers/operated.ts
npx tsx scripts/release/acceptance-orchestrator.ts check
git diff --check
```

| Command/attempt | Passed | Failed | Skipped |
| --- | ---: | ---: | ---: |
| Four-file Vitest, initial | 58 | 1 | 0 |
| Four-file Vitest, corrected exact registry expectation | 60 | 0 | 0 |
| Two-file Vitest after TypeScript corrections, includes canonical gate-manifest regression suite | 311 | 0 | 0 |
| Final two-file driver/local-target rerun after explicit local-Docker precondition | 43 | 0 | 0 |
| Serialized typecheck, first | 0 checks | 1 check, 8 diagnostics | 0 |
| Serialized typecheck, corrected | 1 check | 0 | 0 |
| Serialized typecheck, final local-Docker precondition | 1 check | 0 | 0 |
| Twelve-file eslint, initial | 1 check, 0 errors/warnings | 0 | 0 |
| Thirteen-file eslint, intermediate | 1 check, 0 errors/warnings | 0 | 0 |
| Thirteen-file eslint, final | 1 check, 0 errors/warnings | 0 | 0 |
| One-file eslint, final local-Docker precondition | 1 check, 0 errors/warnings | 0 | 0 |
| Scenario inventory check | 1 check, 19 scenarios and 79 mapped files | 0 | 0 |
| Diff whitespace checks | 3 checks | 0 | 0 |
| Operated Mac gates | Not run | Not run | Not counted; needs real engines/browser |

Final distinct offline assertions across five files: **361 passed, 0 failed,
0 skipped**. Overlapping reruns are not added. The first compiler errors were
typed optional environment overrides, explicit callback types for imported JS,
the existing J2 JSON helper's inferred optional-body declaration, and complete
typed negative-test fixtures. No runtime contract was relaxed to fix compilation.

Suggested commit: `feat(release): add operated upgrade and restore rehearsals`

# PKG-04 default installation topology

Implementation status: `implementation_complete_verification_pending`. This is a J1 implementation handoff, not verified installation or release evidence. Working tree base: `3a9de905`. No commit, package installation, migration rewrite, Docker operation or cloud call was performed on the builder.

## Acceptance mapping

Contract: “Reproducible API, durable product/platform stores, Temporal, workers and customer agents deploy from a clean host without hidden injected ports.”

| Clause | Implementation and proof |
| --- | --- |
| Isolated genuine local Supabase project | `scripts/acceptance/default-stack/config.mjs` creates a unique CLI project, pins CLI 2.75.0, enables real Auth/PostgREST and a transaction-mode Supavisor pooler. Every started CLI service is reopened at its actual native image ID and recorded in `supabase.images.json`. Pass `--supabase-image-lock <private snapshot>` to refuse a different image set on a subsequent clean host. The first vendor version resolution is recorded, not described as a previously reviewed digest lock. |
| Private-CA HTTPS and pooler TLS | Runtime OpenSSL CA/certificates; HTTPS edge in `deploy/self-hosted/supabase-gateway.mjs`; actual Supavisor `GLOBAL_DOWNSTREAM_CERT_PATH`/`GLOBAL_DOWNSTREAM_KEY_PATH`. Product URL is `supabase-pooler:6543/postgres?sslmode=verify-full`. API/worker mount only the public CA and use Node's verified TLS. `pooler-probe.mjs` requires successful native queries plus wrong-CA and wrong-hostname refusals. No certificate bypass or OS trust change. |
| Immutable local builds, native architecture | `up.mjs` builds the existing API, worker and migrator Dockerfiles serially, pushes to an owned registry on `localhost:5000`, obtains actual repository digests and refuses host/daemon/image architecture mismatch. Source binding is compared before/after builds and prepare, and again at readiness. No emulation evidence. |
| Disposable preparation and durable engines | Invokes the actual `installation.mjs prepare`; reuses the shipped composition and pinned PostgreSQL/Temporal engines; runs the explicit migrator before APIs/workers. Existing TLS, separate-authority, disposable binding, private-permission, symlink and shell-override guards stay intact. |
| Two APIs and two independent workers | Default profile renders two API processes with independent data volumes. `prepare --join` supplies identical custody/signing keys and authority configuration through a private keyring; peer worker has a distinct scratch volume. Lean renders one API and one worker without silently satisfying the two-worker clause. Pure contracts: `tests/deploy/default-stack.test.ts`; POSIX preparation/drift contracts: `tests/deploy/installation.test.ts`. |
| Ownership, readiness and zero-resource cleanup | All new resources carry the installation label, or the exact unique CLI project label. Cleanup inspects labels before each mutation, drains workers, removes only owned containers/volumes/networks/local build images, then independently inventories absence. No global prune. Public base images and unlabelled BuildKit caches are retained. Successful cleanup also removes private credentials/certificates/backup files; sanitized receipts remain. Engine tests: `tests/deploy/default-stack.engine.test.ts` (three explicit gated cases). |
| MCP admission | `mcp-product-endpoint.ts` retains exact 20-character hosted project admission and matching pooler realm, and admits only the exact local HTTPS origin and verified-TLS pooler binding. Tests cover hosted 19/20/21 character cases, foreign realms, weaker TLS and unrelated database authorities. The native handle, REST-client ownership, same-database and locked-row checks remain mandatory. |
| Customer agents and actual cross-worker execution | Owned by J2/J4/J9 and DUR campaign joins. This harness provides the reachable installation/keyring seam; it does not manufacture registration, browser approval, execution or recovery receipts. |

## Exact Mac verification commands

Run serially on the frozen worktree. Required: native ARM64 Node 22, Docker Desktop/Compose 2.30+, Supabase CLI **2.75.0**, OpenSSL supporting `-addext`, and enough disk for image builds. Check `node --version`, `supabase --version`, `docker compose version`, `docker info`. No host `npm install` or `npm ci` is required. Existing Dockerfile recipes install their own locked image dependencies.

The lean running-service memory ceilings total **3296 MiB**, excluding temporary migration/probe containers, Docker overhead and build/bootstrap peaks. It is a plan, not a measured fit. Lean stops only its owned Supabase containers during image compilation and restarts them afterward. Use Docker 4 GiB RAM / 4 GiB swap on the 8 GB Mac, one workload at a time. The harness checks the host home filesystem's free space before each child command and every five seconds during it, enforcing the verifier's **22 GiB free disk floor**. It records the minimum observed value. If Docker's disk is on another filesystem, monitor that filesystem too. Cleanup remains available below the floor. The default two-API/two-worker plan exceeds 4 GiB; run it only with sufficient measured capacity. Do not report a lean run as default multiworker acceptance.

The OCI registry prerequisite must be a real digest, not a guessed pin. Resolve and inspect it before the run; preserve its actual digest and native architecture with the receipt:

```bash
export PATH="/opt/homebrew/opt/node@22/bin:$PATH"
node --version
supabase --version
docker compose version
docker info --format '{{.Architecture}}'
docker pull registry:2.8.3
export ZENITH_DEFAULT_STACK_REGISTRY_IMAGE="$(docker image inspect registry:2.8.3 --format '{{index .RepoDigests 0}}')"
export ZENITH_ACCEPTANCE_DEFAULT_STACK=1
export ZENITH_DEFAULT_STACK_PROFILE=lean
export ZENITH_ACCEPTANCE_DEFAULT_STACK_DIR="$(python3 -c 'import os,tempfile; print(os.path.join(os.path.realpath(tempfile.gettempdir()), "zenith-j1-lean"))')"
# The chosen directory must not exist. Do not reuse or delete somebody else's directory.
npx vitest run tests/deploy/default-stack.test.ts tests/controlplane/mcp-product-endpoint.test.ts --no-file-parallelism --maxWorkers=2
npx vitest run tests/deploy/installation.test.ts --no-file-parallelism --maxWorkers=2
npx vitest run tests/deploy/default-stack.engine.test.ts --no-file-parallelism --maxWorkers=2
```

Expected: pure tests green; POSIX installer contracts green including real Compose `config --quiet`; engine suite **3 passed / 0 failed / 0 skipped**, followed by `cleanup.receipt.json` showing zero owned Docker resources. A startup/migration/TLS/build failure is a failure; missing engine prerequisites are “not run (needs Docker/Supabase/POSIX)”. Absent opt-in gate produces three skipped engine cases, not three passes.

For the existing native MCP admission regressions, start the persistent J1 stack using the commands below, then use its owned direct Supabase database. The status output is captured into an environment variable, never printed:

```bash
export PATH="/opt/homebrew/opt/node@22/bin:$PATH"
export ZENITH_TEST_PLATFORM_PG_URL="$(supabase status --workdir "$ZENITH_ACCEPTANCE_DEFAULT_STACK_DIR/supabase-project" --output json | node -e 'let s=""; process.stdin.on("data",x=>s+=x); process.stdin.on("end",()=>process.stdout.write(JSON.parse(s).DB_URL));')"
export ZENITH_TEST_MCP_DEPLOY_ADMISSION_REQUIRED=1
export ZENITH_TEST_MCP_START_SOURCE_AUTHORITY_REQUIRED=1
npx vitest run tests/controlplane/mcp-deploy-admission.test.ts tests/controlplane/mcp-start-source-authority.test.ts --no-file-parallelism --maxWorkers=2
unset ZENITH_TEST_PLATFORM_PG_URL
unset ZENITH_TEST_MCP_DEPLOY_ADMISSION_REQUIRED
unset ZENITH_TEST_MCP_START_SOURCE_AUTHORITY_REQUIRED
```

Expected: native cases run without skips or assertion failures. These suites model external product protocols and cannot establish the unresolved separate-authority MCP deployment join. Clean up the persistent stack afterward. The Windows builder's existing admission run was **0 passed / 0 failed / 18 skipped** because no real PostgreSQL URL was supplied.

For a persistent stack used by J2/J4/J9/J10, use the same prerequisites and a fresh private directory:

```bash
export PATH="/opt/homebrew/opt/node@22/bin:$PATH"
node scripts/acceptance/default-stack/up.mjs --profile lean --directory "$ZENITH_ACCEPTANCE_DEFAULT_STACK_DIR"
node scripts/acceptance/default-stack/readiness.mjs "$ZENITH_ACCEPTANCE_DEFAULT_STACK_DIR"
node scripts/acceptance/default-stack/verify-database.mjs "$ZENITH_ACCEPTANCE_DEFAULT_STACK_DIR"
node scripts/acceptance/default-stack/cleanup.mjs "$ZENITH_ACCEPTANCE_DEFAULT_STACK_DIR"
```

`up.mjs` without arguments chooses a fresh resolved system-temp directory and the default 2+2 profile, and prints its directory in the sanitized receipt. `--profile lean` is explicit. For default proof, use a new directory and `ZENITH_DEFAULT_STACK_PROFILE=default` with the engine suite; expect `apis=2`, `workers=2`, and independent scratch. Startup, readiness and database commands require `ZENITH_ACCEPTANCE_DEFAULT_STACK=1`; without it they exit **77** with “not-run”. Failure cleanup is attempted automatically; if it reports pending, retry `cleanup.mjs` using the private `state.json`. Cleanup never depends on successful preparation or an unmodified composition file.

Published host ports: API 36400 (peer 36401 only in default); Supabase HTTPS 54321; internal CLI gateway loopback 54326; Supabase database loopback 54322; TLS pooler 6543; Mailpit-compatible CLI mail UI 54324; registry 5000. Shadow database port 54320 and initial CLI pooler port 54329 are declared in config. Platform PostgreSQL and Temporal have no host publication. Port collisions refuse startup; no automatic reassignment. `supabase.localhost` resolves to loopback in the browser and to the private HTTPS edge in the application network.

## Joins and first likely failures

- **MCP atomic admission remains incompatible with separate authorities.** `defaultMcpProductTopology` still requires the product and platform URLs to identify the same opened native database. The installer still requires different server authorities. Local endpoint admission fixes the hostname-only exclusion but deliberately cannot satisfy both authority requirements. The orchestrator/DUR owner must design a locked cross-database product-admission join. No public proof flag, callback, privileged fallback, or relaxed predicate was added. REST/browser installation readiness is not MCP deployment acceptance.
- `prepare --join <parent/keyring.json> <new-private-directory>` is supported. The keyring must remain beside its canonical `installation.json` and effective env files; altered/detached keyrings refuse. Start the standalone join with its generated `worker.compose.json` on the parent network. For this local private-CA installation, also mount the parent's `tls/ca.crt` read-only and set `NODE_EXTRA_CA_CERTS=/run/zenith-ca.crt` in an explicit Compose override. The default peer worker already includes that mount automatically. Do not share any worker scratch mount.
- Full browser trust is J2's isolated browser-profile CA join. This harness changes no personal browser profile or global trust store. OAuth client interoperability/issuer is J10's join; no local authorization server was introduced.
- Fresh immutable SQL may expose upstream migration/compatibility failures. Preserve the actual refusal and coordinate with the migration owner; never edit published snapshots or weaken contract admission.
- CLI image names, mounts, TLS certificate readability, status JSON fields, and real ARM64 image pins need the actual Mac successor. Unsupported/mismatched resources refuse; no dummy service substitutes.
- Wave-5 maintenance, rotation, archive, clean-host recovery and release harnesses remain owned there. No new tables, migrations, dependencies or gate-manifest entries. The orchestrator may register the gated engine suite after its real successor is reviewed.

Primary configuration references: [Supabase CLI 2.75.0 start code](https://github.com/supabase/cli/blob/v2.75.0/internal/start/start.go), [Supavisor downstream TLS configuration](https://github.com/supabase/supavisor/blob/v2.7.4/config/runtime.exs), [CLI project configuration](https://supabase.com/docs/guides/local-development/cli/config). Actual resolved pooler image identity is recorded and any TLS incompatibility must fail the real probe.

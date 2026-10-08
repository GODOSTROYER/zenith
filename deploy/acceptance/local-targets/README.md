# J15 disposable local targets

These are **local rehearsal** targets. They establish no live cloud, public DNS, production CA, account identity, VPN/peering, commercial payment, or production signoff. The mixed fixture is deployed by this harness's local administrator; the Zenith approval/execution journey belongs to the joined J1/J2 drivers.

Use Node 22, Docker Compose v2, kind, kubectl, zip and OpenSSL. Run from the repository root. No package installation is needed. Docker image acquisition and all engine checks belong to the Mac verifier, not the Windows builder. Remote Docker contexts are refused. Local mode strips live gates and cloud credentials from every child, including component lanes. Up refuses an existing cluster/project and nonempty scratch. Down removes only the named run's cluster and Compose project; it retains private scratch for diagnosis. Choose a fresh run ID and directory each time.

The one-node mixed profile caps kind at 2 GiB (2.5 GiB memory+swap), LocalStack at 768 MiB and each Lambda at 128 MiB. Web/enricher/PostgreSQL pod limits are 192/192/256 MiB within kind. Run one heavy workload at a time with Docker's 4 GiB allocation; stop the J1/default stack during the standalone mixed drill. ACME and billing are separate small profiles. The default stack and browser journeys need J1's own lean profile and may still exceed the Mac budget.

## Mixed Lambda traffic and real partition recovery

```bash
export ZENITH_LOCAL_TARGETS=1 ZENITH_LOCAL_RUN_ID=j15-mix ZENITH_LOCAL_PROFILE=mixed
export ZENITH_LOCAL_ROOT="$(mktemp -d "${TMPDIR:-/tmp}/zenith-j15-${ZENITH_LOCAL_RUN_ID}-XXXXXX")"
npx tsx scripts/release/local-target-runner.ts up --profile mixed --variant lambda
export KUBECONFIG="$ZENITH_LOCAL_ROOT/kubeconfig"
npx vitest run tests/acceptance/local-targets.engine.test.ts --no-file-parallelism --maxWorkers=2
npx tsx scripts/release/acceptance-orchestrator.ts run --only stateful-traffic,mixed-recovery,mixed-economics --run-id "$ZENITH_LOCAL_RUN_ID" --local-targets --out .data-local/acceptance
npx tsx scripts/release/local-target-runner.ts down
```

Engine expected: **2 passed, 2 skipped**, because ACME/billing are separate profiles; each skip is named, not a pass. Mixed recovery stops LocalStack, requires zero acknowledgements, reads existing rows directly through read-only PostgreSQL, requires no outage rows, starts LocalStack, recreates its stateless function from the same ZIP if needed, and reads both old and recovered rows. The live lanes stay deferred. The orchestrator also runs the existing component lanes: any missing Temporal/PG gate or intentional skipped case leaves its scenario incomplete (exit 2), even if the separate engine drill passed. Read every lane; never infer end-to-end verification from a component lane.

For the container equivalent, clean down first, choose a fresh run/directory, then:
```bash
npx tsx scripts/release/local-target-runner.ts up --profile mixed --variant container
npx tsx scripts/release/local-target-runner.ts run --scenario stateful-traffic
npx tsx scripts/release/local-target-runner.ts down
```

The Lambda ZIP contains `enricher/lambda.mjs`, the shared handler and spec. The existing cloud manifest remains the justified container equivalent: its service schema has no reachable Lambda service kind. LocalStack Invoke is an unsigned emulator transport behind an mTLS bridge, not evidence of AWS IAM. The bridge rejects any endpoint other than its dedicated ClusterIP service. Web records `kind-web` and `localstack-aws-lambda` (or `kind-container`), never GCP/Azure/AWS as if real clouds ran.

Database has no host, NodePort or LoadBalancer port. PostgreSQL requires the web client's certificate for TCP; the readback has a separate read-only role accessed through owned pod exec, independently of web. Client TLS verifies the server hostname against the ephemeral CA. Web and enricher get separate keys; CA signing key stays outside the cluster. A NetworkPolicy is emitted, but default kindnet does not enforce it. Use J11's policy-capable CNI to establish packet-level isolation; this harness does not claim that proof.

## Pebble plus CoreDNS

```bash
export ZENITH_LOCAL_TARGETS=1 ZENITH_LOCAL_RUN_ID=j15-acme ZENITH_LOCAL_PROFILE=acme
export ZENITH_LOCAL_ROOT="$(mktemp -d "${TMPDIR:-/tmp}/zenith-j15-${ZENITH_LOCAL_RUN_ID}-XXXXXX")"
npx tsx scripts/release/local-target-runner.ts up --profile acme
npx vitest run tests/acceptance/local-targets.engine.test.ts --no-file-parallelism --maxWorkers=2
npx tsx scripts/release/local-target-runner.ts run --scenario dns-tls
npx tsx scripts/release/local-target-runner.ts down
```

Expected engine counts: **1 passed, 3 skipped**. The CA performs real HTTP-01 through CoreDNS, issues a certificate for mixed.j15.test, and a separate HTTPS handshake verifies its hostname/key/chain using only Pebble's root. No validation bypass is set. Bad nonces are retried within a bound. The fixed 172.30.115.0/24 DNS network must not overlap any existing Docker network; up refuses overlaps. CoreDNS has no public forwarder.

The configuration follows [Pebble's versioned configuration](https://github.com/letsencrypt/pebble/blob/v2.8.0/test/config/pebble-config.json) and [upstream Compose image/arguments](https://github.com/letsencrypt/pebble/blob/v2.8.0/docker-compose.yml). Images are version tags except the reused Node digest; immutable emulator/PG/CA image digests remain an integration task for J11, not a fabricated pin.

## stripe-mock wire rehearsal

```bash
export ZENITH_LOCAL_TARGETS=1 ZENITH_LOCAL_RUN_ID=j15-bill ZENITH_LOCAL_PROFILE=billing
export ZENITH_LOCAL_ROOT="$(mktemp -d "${TMPDIR:-/tmp}/zenith-j15-${ZENITH_LOCAL_RUN_ID}-XXXXXX")"
npx tsx scripts/release/local-target-runner.ts up --profile billing
npx vitest run tests/acceptance/local-targets.engine.test.ts --no-file-parallelism --maxWorkers=2
npx tsx scripts/release/local-target-runner.ts run --scenario billing
npx tsx scripts/release/local-target-runner.ts down
```

Expected engine counts: **1 passed, 3 skipped**. Runtime-generated fake test key; the actual billing adapter creates/finalizes an invoice against loopback and an independent GET checks its schema and stripe-mock header. stripe-mock is not a persistence, payment, webhook or durable billing-schedule test. ARM64 uses the upstream `v0.197.0-arm64` image suffix; AMD64 uses `v0.197.0`.

## Joined scenario driver protocol

`scenarios.json` covers all 19 existing release scenarios. Install uses J1's `scripts/acceptance/default-stack/verify.mjs`; product journeys use J2's `scripts/acceptance/default-journey.mjs`; schedules use J4's `scripts/acceptance/maintenance/run.mjs`. These filenames and argument contracts require confirmation/adapters from their owners. No stub succeeds when one is absent. Without a driver and `ZENITH_LOCAL_JOINED_DRIVERS=1`, the local lane declines with exit 2.

After those joins and their own documented setup, use:
```bash
export ZENITH_LOCAL_TARGETS=1 ZENITH_LOCAL_JOINED_DRIVERS=1
# Keep ZENITH_LOCAL_RUN_ID/ROOT tied to this disposable run; start J1 using its verify document.
npx tsx scripts/release/acceptance-orchestrator.ts run --local-targets --run-id "$ZENITH_LOCAL_RUN_ID" --out .data-local/acceptance
```

Each driver receives `--scenario ID --run-id ID --receipt FILE`. It must exercise its real local journey and write schema 1, evidenceLabel local_rehearsal, matching scenarioId/runId/sourceCommit, nonempty checks with required `scenario-<ID>` and statuses passed/failed/skipped, and nonempty limits. Its independent readback belongs to the driver, not this receipt parser. Zero-exit with absent/malformed/foreign receipts fails. Skipped checks remain incomplete. Child environment excludes live gates and real provider credentials; local auth uses ZENITH_LOCAL_* credential FILE references. No privileged fallback.

Resume binds source commit, harness/fixture/config bytes, lane plan and local scratch/join choice. Missing/tampered completed lane artifacts refuse resume. Use a fresh run after such a refusal; never repair the evidence to pass.

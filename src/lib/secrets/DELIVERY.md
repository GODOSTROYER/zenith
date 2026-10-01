# Secret delivery integration

`deployWorkloads` calls `syncEnvironmentSecrets` inside the environment lease's
keepalive, before the workload session/rollout. The activity loads current values
inside individual credential-broker callbacks. Only target references, keyed AWS
version tokens, counts and fixed failure classifications become evidence. A partial
sync stops rollout; an ambiguous write records `outcomeUnknown` and throws a plain,
value-free error so the workflow can finalize uncertain. Lease loss retains its
`LeaseLostError` classification. OCI and runner writes remain refused until sealed
secret request bodies exist. All provider proof is contract evidence, not live.

## Required orchestrator integration (outside this worker's owned paths)

- `src/lib/platform/broker.ts:94-110` currently rejects a deployment's request for
  `secret.write`. Add an explicit approved deploy/apply/rollback-to-secret-write
  relationship, evaluate the secret capability's own policy/autonomy/approval
  requirements with the reviewed plan facts, and preserve live fence, role and
  approval checks. Do not permit arbitrary mutating-capability attenuation.
- The broker must independently resolve the current graph's exact target identities
  and sign them as `claims.constraints.secretResources: string[]`. Identity forms
  are a full AWS secret ARN, GCP `projects/<project>/secrets/<secret>`, Azure
  versionless `https://<vault>.vault.azure.net/secrets/<name>` and Kubernetes
  `kubernetes:<namespace>/<name>`. The set must exactly equal the sync batch,
  including generated database Secrets on Kubernetes. No wildcard or added local
  claim is accepted. If the broker cannot derive these safely, add a typed target
  list to `BrokerPort.issueGrant` in `src/lib/execution/ports.ts:308-313` and validate
  it server-side against the approved graph/provider observations before signing.
- AWS connections must carry `config.secretWriterRoleArn` from the bootstrap's
  `SecretWriterRoleArn` / `secret_writer_role_arn` output. Existing connections
  require an operator bootstrap update and config update. The credential broker
  refuses missing/shared roles and always derives an exact-ARN session policy,
  even when normal session-policy derivation is disabled.
- GCP, Azure and Kubernetes use their existing deploy session purpose with a
  `secret.write` grant; AWS uses the new separate `secret.write` purpose. The GCP
  writer identity needs secret metadata, latest-version access and AddSecretVersion
  only on the signed targets. Azure needs ARM vault metadata and Key Vault get/set
  on the target vaults. Kubernetes needs Secret read/patch in allowed namespaces.
  These provider IAM/RBAC permissions have not been verified live.
- `createSecretResolver(scope)` and `createConnectionSecretSink(scope)` are the
  store implementations for Kubernetes apply and the Zenith-managed Neon adapter.
  The deployment sync wires the Kubernetes resolver. A caller constructing
  `DatabaseProviderDeps` (`src/lib/providers/zenith/database.ts:181-183`) must inject
  both factories; no managed-provider composition root currently does so here.
- `src/lib/platform/release.ts:56-65` says manifest-pinned images were already
  applied by OpenTofu, and `src/lib/execution/apply.ts:109-...` applies whole
  workloads. This worker gates the mandated post-infrastructure deploy activity;
  it cannot guarantee initial/updated pods/tasks were not started by infrastructure
  apply. Full lifecycle ordering needs the infrastructure/rollout owner to keep
  workloads quiescent until delivery, then force rollout when secret content changes.

## Store and compatibility decisions

Generated `vault:generated/<environment>/<kind>/<name>/password` values are random
32-byte credentials, sealed, created by atomic insert-or-return and stable thereafter.
`connection-uri` is supplied once by the database adapter; a missing URI stays
unresolved and a different replacement is refused. Postgres uses the existing
`(workspace_id, ref)` primary key and PostgREST ignore-duplicates; no migration.
Only the PostgREST contract was tested; real Postgres was not run.

File mutations use an exclusive `secrets.json.lock`, including compatibility writes
and deletes. Contention on create-once is retried for about one second. A stale lock
after a process crash fails closed; an operator may remove it only after verifying
all file-store writers have stopped. Plaintext never reaches that file or lock.

Ordinary `vault:<project>/<service>/<key>` refs are project-scoped and
`vault:<key>` refs retain the store's intentional workspace-sharing compatibility.
Neither format encodes an environment. Generated refs additionally require the
current environment and a managed graph address. JavaScript strings cannot be
securely zeroed; references are dropped after requests, and byte buffers are cleared.

AWS drivers currently name secrets `zenith/zenith-<environment>-<node>`, rather than
the handoff's proposed `zenith/<environment>/*`. Both bootstrap patterns are supported
without editing driver files; exact ARN and environment/workspace tag checks are
mandatory. AWS content tokens use a private, stable fingerprint key across operations;
current matching versions cause no write and older matching versions are promoted.
GCP and Azure compare content hashes in memory. Kubernetes skips equal Secret data
before patching. No public content hash or operation-only marker is persisted.

AWS token/promotion behavior follows the [PutSecretValue API contract](https://docs.aws.amazon.com/secretsmanager/latest/apireference/API_PutSecretValue.html).
GCP writes follow the [AddSecretVersion API contract](https://docs.cloud.google.com/secret-manager/docs/reference/rest/v1/projects.secrets/addVersion).

## Verification performed in this continuation

All vitest commands used `--maxWorkers=2`. Counts below are per invocation, not
distinct tests across runs. The whole-repo TypeScript checker ran exactly three
times. No dependencies, workflow definitions, excluded driver files, Git metadata,
commits or other worktrees were changed.

| Exact command | Results in execution order |
| --- | --- |
| `npx tsx deploy/aws/tools/generate-tofu-policies.ts --write` | Exit 0; generated 12 templates, with only the new writer template changed/added. |
| `npx vitest run --maxWorkers=2 tests/secrets/resolver.test.ts tests/providers/aws/secret-writer.test.ts tests/providers/gcp/secret-writer.test.ts` | 38 passed, 1 failed, 0 skipped; 2 files passed, 1 failed. The malformed-ref test expected denied rather than the implementation's invalid classification; corrected the precise expected classification. |
| `npx vitest run --maxWorkers=2 tests/secrets/resolver.test.ts tests/execution/secrets.test.ts tests/execution/secrets-kubernetes.test.ts` | 31 passed, 0 failed, 0 skipped; 3 files passed. |
| `npx eslint src/lib/secrets src/lib/execution/secrets.ts src/lib/execution/release.ts src/lib/credentials src/lib/providers/aws/secret-writer.ts src/lib/providers/gcp/secret-writer.ts src/lib/providers/azure/secrets.ts tests/secrets/resolver.test.ts tests/providers/aws/secret-writer.test.ts tests/providers/gcp/secret-writer.test.ts` | Exit 0; 0 errors, 0 warnings. |
| `npx tsc --noEmit` | Run 1: exit 1, 1 error (new test graph missing version). Run 2: exit 1, 2 errors (SDK send overload and Next's required NODE_ENV type in the child-process test). Run 3 after fixes: exit 0, 0 errors. |
| `npx eslint src/lib/secrets src/lib/execution/secrets.ts src/lib/execution/release.ts src/lib/providers src/lib/credentials deploy/aws/tools/generate-tofu-policies.ts tests/secrets tests/execution tests/providers/aws/secret-writer.test.ts tests/providers/gcp/secret-writer.test.ts` | Three invocations: exit 0 (0 errors/0 warnings), exit 1 (1 error/0 warnings, forbidden module variable name in new test), exit 0 after rename (0 errors/0 warnings). |
| `npx vitest run --maxWorkers=2 tests/secrets tests/execution tests/platform tests/security tests/providers/aws/secret-writer.test.ts tests/providers/gcp/secret-writer.test.ts` | 815 passed, 0 failed, 20 skipped; 51 files passed, 1 skipped. |
| `npx vitest run --maxWorkers=2 tests/execution/secrets.test.ts tests/execution/secrets-kubernetes.test.ts tests/execution/secrets-azure.test.ts tests/secrets/secret-writer-bootstrap.test.ts tests/providers/azure/helpers.test.ts tests/credentials` | 248 passed, 0 failed, 1 skipped; 13 files passed. |
| `npx vitest run --maxWorkers=2 tests/secrets/resolver.test.ts tests/execution/secrets.test.ts tests/providers/aws/secret-writer.test.ts` | 50 passed, 0 failed, 0 skipped; 3 files passed, including independent-process password creation, write timeout and writer-session expiry proof. |
| `npx vitest run --maxWorkers=2 tests/secrets tests/execution tests/platform tests/security tests/providers/aws/secret-writer.test.ts tests/providers/gcp/secret-writer.test.ts tests/providers/azure/helpers.test.ts tests/credentials` | Final expanded regression run: 1049 passed, 0 failed, 21 skipped; 62 files passed, 1 skipped. |
| `npx vitest run --maxWorkers=2 tests/secrets/resolver.test.ts tests/execution/secrets.test.ts tests/secrets/secret-writer-bootstrap.test.ts` | Final verification of tests adjusted for type/lint fixes: 34 passed, 0 failed, 0 skipped; 3 files passed. |
| `git diff --check` | All invocations exit 0; 0 whitespace errors. |
| `tofu fmt -check -diff deploy/aws/tofu-module` | Exit 1 before the binary launched: Windows reported no application associated with the WinGet link. No formatting check ran. |
| `$tofuExecutable = (Get-Item -LiteralPath 'C:\Users\user\AppData\Local\Microsoft\WinGet\Links\tofu.exe').Target; & $tofuExecutable fmt -check -diff deploy/aws/tofu-module` | Exit 1 before the resolved binary launched: Access is denied. No formatting check ran. |

The final 21 skips were existing gates: 12 require an executable OpenTofu (including
the bootstrap's unset `ZENITH_TEST_TOFU` gate), 2 require
`ZENITH_TEST_TOFU_NETWORK=1`, 5 require Temporal (3 unavailable CLI, 2 unset
`ZENITH_SEC_TEMPORAL=1`), and 2 canonical-JSON tests refuse this Node 24 runtime's
known V8 single-character-key defect. Provider network tests were not enabled.
No live cloud, real Postgres, WSL or Docker validation was performed. Static bootstrap
and mocked provider/store contracts passed; OpenTofu formatting/init/validate/test
remain for the orchestrator outside this sandbox.

## Changed and added files

Branch `ws/secret-sync`, unchanged HEAD `4c7a652`; all 26 files remain uncommitted.

Modified:

- `src/lib/secrets/backend.ts`
- `src/lib/secrets/file-backend.ts`
- `src/lib/secrets/pg-backend.ts`
- `src/lib/execution/release.ts`
- `src/lib/providers/azure/secrets.ts`
- `src/lib/credentials/types.ts`
- `src/lib/credentials/aws/broker.ts`
- `deploy/aws/zenith-connection.cfn.yaml`
- `deploy/aws/tools/generate-tofu-policies.ts`
- `deploy/aws/tofu-module/main.tf`
- `deploy/aws/tofu-module/outputs.tf`

Added:

- `src/lib/secrets/resolver.ts`
- `src/lib/secrets/delivery.ts`
- `src/lib/secrets/DELIVERY.md`
- `src/lib/execution/secrets.ts`
- `src/lib/providers/aws/secret-writer.ts`
- `src/lib/providers/gcp/secret-writer.ts`
- `src/lib/credentials/aws/secret-policy.ts`
- `deploy/aws/tofu-module/policies/secret-writer.json.tftpl`
- `tests/secrets/resolver.test.ts`
- `tests/secrets/secret-writer-bootstrap.test.ts`
- `tests/execution/secrets.test.ts`
- `tests/execution/secrets-kubernetes.test.ts`
- `tests/execution/secrets-azure.test.ts`
- `tests/providers/aws/secret-writer.test.ts`
- `tests/providers/gcp/secret-writer.test.ts`

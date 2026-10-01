# WS-DRIVER-FIX — driver declaration mismatches + EventBridge/CloudFront reads

Workstream: WS-DRIVER-FIX (new; orchestrator brief) — Branch ws/driver-fix — worktree Z:\Projects\Spawned.ai\zenith-wt\ws-driver-fix
Base: platform/integration (AWS consolidated provider; @aws-sdk/client-eventbridge and
@aws-sdk/client-cloudfront 3.1121.0 now installed)

## Part A — the capability-matrix problems (`npx tsx scripts/docs/capability-matrix.ts` lists them)
- `aws.ec2_instance@1` and `aws.lambda_function@1` declare evidence under a non-operation key
  `experimental`. Add an optional `experimental?: boolean` to `DriverCapabilities`
  (src/lib/drivers/types.ts, ADDITIVE) and use it; remove the fake evidence key.
- `aws.rds_instance@1`: `database.restore` / `database.delete` are deliberate refusal stubs in
  `operations`, undeclared, with evidence entries. Pick ONE consistent contract for refusal
  operations (e.g. an optional `capabilities.refuses?: string[]` listing operations that exist only to
  refuse, with their evidence) and apply it; the matrix generator (scripts/docs/capability-matrix.ts)
  and the AWS contract test (tests/providers/aws/drivers/contract.test.ts) must agree on it.
- `oci.compute_instance@1`, `oci.mysql_db_system@1`, `oci.oke_cluster@1`: declare `compile: false`
  but have a `compile` that throws OciUnsupportedError. Make declaration and implementation agree
  (either drop the throwing compile or make the matrix treat an always-refusing compile as unsupported —
  choose the clearer contract, document it in docs/platform/DRIVER-CONVENTIONS.md).
- After the fixes, the matrix's problems list must be empty: remove those lines from the `KNOWN`
  ratchet in tests/docs/capability-matrix.test.ts and regenerate docs/platform/CAPABILITY-MATRIX.md.

## Part B — real reads for two AWS drivers (src/lib/providers/aws/drivers/compute/)
- `aws:ecs_scheduled_task`: read the EventBridge rule (DescribeRule: schedule expression, state) and
  its targets (ListTargetsByRule: the RunTask target's cluster/task definition/role) so observe/verify
  can reach `passed` (today they report `unknown`). Tag-based lookup stays; bounded native; no secrets.
- `aws:s3_static_site`: read the CloudFront distribution (GetDistribution: status, enabled, origins incl.
  the OAC id, aliases, viewer certificate) so verify can reach `passed`.
- Clients via the session like the other AWS clients (src/lib/providers/aws/drivers/compute/support/sdk.ts
  pattern); aws-sdk-client-mock tests for present/missing/inaccessible/throttled/partial.
- Implement `discover` for both if straightforward (tag-filtered), else keep capabilities false.

## Owned paths
src/lib/drivers/types.ts (additive) ; src/lib/providers/aws/drivers/** ; src/lib/providers/oci/drivers/** ;
scripts/docs/capability-matrix.ts ; docs/platform/CAPABILITY-MATRIX.md (regenerated) ;
docs/platform/DRIVER-CONVENTIONS.md (the contract notes) ; tests/providers/aws/** ; tests/providers/oci/** ;
tests/docs/capability-matrix.test.ts (KNOWN ratchet + any assertion the new contract changes).
Do NOT edit package.json (deps are installed) or other docs/tests (WS-DOCS-SYNC is editing them).

## Verification
- npx tsc --noEmit ; npx eslint src/lib/drivers src/lib/providers/aws src/lib/providers/oci scripts/docs tests/providers/aws tests/providers/oci tests/docs/capability-matrix.test.ts
- npx vitest run --maxWorkers=2 tests/providers/aws tests/providers/oci tests/docs/capability-matrix.test.ts
- npx tsx scripts/docs/capability-matrix.ts --strict   (must pass: no problems)

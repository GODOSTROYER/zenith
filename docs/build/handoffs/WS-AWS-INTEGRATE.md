# WS-AWS-INTEGRATE — consolidate and wire the three AWS driver groups

Workstream: WS-AWS-INTEGRATE (new; written by the orchestrator, not a previous agent)
Branch: ws/aws-integrate — worktree Z:\Projects\Spawned.ai\zenith-wt\ws-aws-integrate
Base: platform/integration @ 97282c4 (all three AWS driver groups merged, 915 AWS driver tests passing, tsc clean)

## Objective (condensed but complete)
Three workers built AWS resource drivers in parallel (ResourceDriver contract:
src/lib/drivers/types.ts; conventions: docs/platform/DRIVER-CONVENTIONS.md; specs:
src/lib/resources/specs.ts; native types: src/lib/resources/native-types.ts):
- src/lib/providers/aws/drivers/network/** + the CANONICAL helpers src/lib/providers/aws/drivers/shared/**
- src/lib/providers/aws/drivers/compute/** — carries a private snapshot of shared at compute/support/aws-shared/**
- src/lib/providers/aws/drivers/data/** — carries a private snapshot of shared at data/_shared/**
Both snapshots are OLDER than shared/ (shared/ gained tfLiteral, attempt capture, verify.ts,
discovery-tag helpers, bounded compile errors). Make the three groups one coherent provider.

Owned paths: src/lib/providers/aws/drivers/** ; tests/providers/aws/** ; src/lib/resources/expand*.ts
and src/lib/resources/specs.ts (ADDITIVE spec fields only) for item 4 ; tests/resources/** for item 4.

## Remaining (all of it)
1. Delete compute/support/aws-shared/** and data/_shared/**; repoint every import (src AND tests —
   e.g. tests/providers/aws/drivers/data/_helpers.ts imports data/_shared) to
   `@/lib/providers/aws/drivers/shared`. Resolve API drift between the snapshots and shared/
   (prefer shared/'s newer behaviour, e.g. tfLiteral for any graph text placed in tofu JSON —
   graph text is data, never an interpolation). Keep group-private helpers that are not
   duplicates (compute/support/{bucket,cron,driver-util,fargate,image,refs,sdk,tf}.ts, data/support.ts)
   unless they duplicate shared/; if they do, consolidate into shared/.
2. In shared/errors.ts add SQS's legacy `AWS.SimpleQueueService.NonExistentQueue` (and
   `QueueDoesNotExist`) to NOT_FOUND, and drop the data group's wrapper workaround.
3. Provider registry: src/lib/providers/aws/drivers/index.ts exporting `awsDrivers` (network +
   compute + data arrays) and an idempotent `registerAwsDrivers()` that calls registerDriver for
   each (cast as the contract test does). Exactly one driver per (provider, nativeType); a test
   asserts no duplicates and that every `aws:` row of NATIVE_TYPE_TABLE either has a driver or is
   listed in an explicit, commented `NOT_YET_IMPLEMENTED` set.
4. Expansion gaps found by the data driver (fix in src/lib/resources expansion, with tests):
   a) RDS needs private subnets in ≥2 AZs even for a single instance: when the provider is aws and
      the graph has a postgres/mysql node (or redis with highAvailability), the network must have
      ≥2 zones in every environment class (note emitted explaining why).
   b) A `cache` binding to redis must yield an identity grant `connect` on the redis node (the
      ElastiCache driver uses IAM-authenticated RBAC; the compute IAM role needs
      elasticache:Connect on the replication group and user ARNs). Make sure the IAM grant table
      (data/iam-grants.ts GRANT_RULES) maps it to exact ARNs, no wildcards.
   c) Verify identity grant verbs emitted by expansion are ALL covered by GRANT_RULES (test: expand
      every blueprint in src/lib/blueprints + the fixtures under tests/resources, compile every
      identity node, no DriverCompileError).
5. END-TO-END COMPILE TEST (the most valuable item): tests/providers/aws/drivers/e2e-compile.test.ts —
   take a realistic V1 manifest (web service with git source + Dockerfile, worker, postgres, redis,
   object store, queue, route with TLS on a referenced zone, secretRef env vars), upgradeManifest →
   expandManifest(env class production, provider aws, region ap-south-1) → compile EVERY managed node
   with its registered driver (fail on any node without a driver unless it is in NOT_YET_IMPLEMENTED
   with an explicit reason) → assembleWorkspace({providerSet:"aws", backend s3 …}) → assert: no
   duplicate tofu addresses, deterministic output (compile twice, identical configDigest), no secret
   canary anywhere, no IAM wildcard (run src/lib/policy extractPlanFacts-style checks over the
   compiled IAM documents), every cross-node reference resolves. Gate `tofu init -backend=false` +
   `tofu validate` of that workspace behind ZENITH_TEST_TOFU_NETWORK=1 and RUN IT (the provider
   plugin cache in the OS temp dir may already hold hashicorp/aws 6.66.0; if the sandbox blocks the
   network and the cache lacks it, report that clearly as not run). Also the same for staging class.
6. A generic driver contract test over `awsDrivers`: every driver has id `aws.<x>@1`, nativeType in
   NATIVE_TYPE_TABLE.aws, capabilities.evidence has an entry for each true capability and for each
   operation, no evidence level is `real` or `emulated` (no live account exists), compile is pure
   (same input twice → identical JSON), observe of a node returns only `known` attributes it read.

## Known failures
None at base: tsc clean, `npx vitest run tests/providers/aws` 30 files / 915 passed / 10 skipped.

## Decisions already made (keep them)
- Drivers never construct credentials; sessions come from the credential broker.
- Secrets are containers only; no GetSecretValue anywhere (a source-scan test enforces it).
- RDS uses manage_master_user_password; ElastiCache uses IAM-authenticated RBAC (no AUTH token).
- Security groups: one per protected node via shared/security-group.ts; public CIDR only for
  public_http to the load balancer.
- Evidence is `contract` everywhere.

## Verification commands
- npx tsc --noEmit
- npx eslint src/lib/providers/aws tests/providers/aws src/lib/resources tests/resources
- npx vitest run tests/providers/aws tests/resources
- ZENITH_TEST_TOFU_NETWORK=1 npx vitest run tests/providers/aws/drivers/e2e-compile.test.ts

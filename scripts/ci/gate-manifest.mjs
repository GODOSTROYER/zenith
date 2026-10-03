/** Canonical local/CI execution contract. Report payloads never define requirements. */
import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";

export const TOFU_SUITES = [
  ["tests/tofu/network.test.ts", "real provider install through the committed lockfile (network)"],
  ["tests/tofu/network.test.ts", "AWS provider blocks validate against the real provider schema (network, ~160 MB first run)"],
  ["tests/tofu/backends.test.ts", "real backend block validation (network gate, no cloud calls)"],
  ["tests/tofu/destroy-real.test.ts", "real tofu destroy (ZENITH_TEST_TOFU_NETWORK=1)"],
  ["tests/providers/aws/drivers/compute/assemble.test.ts", "real `tofu validate` against hashicorp/aws 6.66.0 (network, plugin cache)"],
  ["tests/providers/aws/drivers/data/assemble.test.ts", "compiled data fragments validate against the real hashicorp/aws provider (network)"],
  ["tests/providers/aws/drivers/messaging/assemble.test.ts", "OpenTofu AWS 6.66.0 schema validation (requires binary/network)"],
  ["tests/providers/aws/drivers/network/compile-graph.test.ts", "tofu validate over the real aws 6.66.0 provider schema (gated: ZENITH_TEST_TOFU_NETWORK=1)"],
  ["tests/providers/aws/drivers/e2e-compile.test.ts", "real OpenTofu AWS 6.66.0 schema validation (opt-in)"],
  ["tests/providers/aws/identity/trust.test.ts", "IRSA pinned provider schema"],
  ["tests/providers/gcp/tofu-validate.test.ts", "tofu validate against hashicorp/google 8.5.0 (network)"],
  ["tests/providers/gcp/bootstrap.test.ts", "tofu validate (network)"],
  ["tests/providers/gcp/identity/trust.test.ts", "GKE trust pinned provider schema"],
  ["tests/providers/azure/validate.test.ts", "compiled Azure OpenTofu validates against the real azurerm 5.7.0 schema (network)"],
  ["tests/providers/azure/deploy.test.ts", "deploy/azure validates against the real azurerm 5.7.0 schema (network)"],
  ["tests/providers/azure/identity/trust.test.ts", "AKS trust pinned provider schema"],
  ["tests/providers/oci/validate.test.ts", "tofu validate against oracle/oci 9.7.1 (network)"],
  ["tests/providers/oci/validate.test.ts", "the customer bootstrap module (deploy/oci) validates against the locked provider (network)"],
  ["tests/execution/compile-refs-providers.test.ts", "real AWS schema validation through the execution compiler (opt-in)"],
  ["tests/security/tofu-secrets.test.ts", "part 3: real OpenTofu 1.12.5, plan -> approve -> apply, scanning every surface"],
  ["tests/security/tofu-runner-env.test.ts", "part 1: a provisioner inside real tofu inherits nothing of the control plane's environment"],
  ["tests/security/tofu-workspace-injection.test.ts", "what the assembler ACCEPTS, real OpenTofu must not turn into a file read or a path leak (SEC-F5)"],
  ["tests/execution/journey.test.ts", "deploy journey on the real OpenTofu engine, platform store and product store"],
  ["tests/tofu/ephemeral-network.test.ts", "real ephemeral resources (network)"],
  ["tests/providers/azure/mysql.test.ts", "Azure MySQL real pinned tofu validate (network, no Azure account)"],
  ["tests/providers/oci/mysql.test.ts", "OCI MySQL real pinned tofu schema and persistence controls (network)"],
];


export const EXTERNAL_ACCEPTANCE = [
  {
    id: "external-temporal-mtls", file: "tests/workflows/mtls-live.test.ts",
    suite: "external Temporal mTLS (ZENITH_TEST_TEMPORAL_MTLS=1)", wholeFile: true,
    prerequisites: ["An authorized external Temporal namespace", "ZENITH_TEMPORAL_ADDRESS", "ZENITH_TEMPORAL_NAMESPACE", "ZENITH_TEMPORAL_TLS_CERT_FILE", "ZENITH_TEMPORAL_TLS_KEY_FILE", "ZENITH_TEST_TEMPORAL_MTLS=1"],
    releaseBlocker: "External Temporal mTLS execution remains unverified until separate authorized acceptance passes.",
  },

];

export const CORE_CHECKS = [
  { id: "typecheck", command: ["npm", "run", "typecheck"] },
  { id: "lint", command: ["npm", "run", "lint"] },
  { id: "unit", command: ["node", "node_modules/vitest/vitest.mjs", "run", "--project=node", "--project=dom", "--maxWorkers=1"] },
  { id: "smoke", command: ["npm", "run", "smoke"] },
  { id: "gimbal", command: ["npm", "run", "gimbal:verify"] },
];

const ECS_REPLICA_REPAIR_FILES = {
  execution: "tests/execution/ecs-replica-repair.test.ts",
  ownership: "tests/providers/aws/drivers/compute/ecs-replica-repair-read.test.ts",
  grants: "tests/platform/ecs-replica-repair-grants.test.ts",
  workflows: "tests/workflows/ecs-replica-repair.test.ts",
};
const ECS_REPLICA_REPAIR_WORKFLOW_REQUIREMENTS = [
  ...["immutable ECS replica materialization", "raw full-environment repair plan", "existing plan/apply activity integration"]
    .map((suite) => ({ file: ECS_REPLICA_REPAIR_FILES.execution, suite })),
  { file: ECS_REPLICA_REPAIR_FILES.ownership, suite: "ECS replica ownership reads" },
  { file: ECS_REPLICA_REPAIR_FILES.grants },
  { file: ECS_REPLICA_REPAIR_FILES.workflows },
];
const ECS_REPLICA_REPAIR_POSTGRES_SUITES = [
  "initial planning authority", "planning policy denial", "browser plan approval",
  "resumed planning authority", "stricter approval policy", "immutable repair evidence",
];


// Predispatch, uncertainty and legacy replay contracts stay mandatory even when source files disappear.
const BUILD_SOURCE_POSTGRES_REQUIREMENTS = [
  {
    "file": "tests/controlplane/build-launches.test.ts",
    "suite": "build launch authority [postgres]",
    "test": "commits one permanent predispatch claim across independent workers",
    "postgres": true
  },
  {
    "file": "tests/controlplane/build-launches.test.ts",
    "suite": "build launch authority [postgres]",
    "test": "a committed claim without a provider receipt never becomes dispatchable again",
    "postgres": true
  },
  {
    "file": "tests/controlplane/build-launches.test.ts",
    "suite": "build launch authority [postgres]",
    "test": "a rollback before commit leaves no external launch intent and can be claimed",
    "postgres": true
  },
  {
    "file": "tests/controlplane/build-launches.test.ts",
    "suite": "build launch authority [postgres]",
    "test": "refuses expired consumed approvals at the CAS while operation and fence remain live",
    "postgres": true
  },
  {
    "file": "tests/controlplane/build-launches.test.ts",
    "suite": "build launch authority [postgres]",
    "test": "keeps the isolated actual-broker claimer unavailable in production and outside bound SQL repositories",
    "postgres": true
  },
  {
    "file": "tests/controlplane/build-launches.test.ts",
    "suite": "build launch authority [postgres]",
    "test": "records a late accepted receipt after cancellation without reopening the writer",
    "postgres": true
  },
  {
    "file": "tests/controlplane/build-launches.test.ts",
    "suite": "build launch authority [postgres]",
    "test": "rejects stale fences, foreign tenants, absent original-use authority and revoked account bindings",
    "postgres": true
  },
  {
    "file": "tests/controlplane/build-launches.test.ts",
    "suite": "build launch authority [postgres]",
    "test": "retains an immutable terminal receipt independently of operation projections and provider-token expiry",
    "postgres": true
  },
  {
    "file": "tests/controlplane/build-launches.test.ts",
    "suite": "build launch authority [postgres]",
    "test": "refuses receipt substitution and preserves the first acknowledgement",
    "postgres": true
  },
  {
    "file": "tests/controlplane/build-launches.test.ts",
    "suite": "build launch authority [postgres]",
    "test": "rechecks fence expiry after an observed resource lock wait before committing dispatch",
    "postgres": true
  },
  {
    "file": "tests/controlplane/build-launches.test.ts",
    "suite": "build launch authority [postgres]",
    "test": "rechecks execution-lease expiry after an observed resource lock wait before committing dispatch",
    "postgres": true
  },
  {
    "file": "tests/controlplane/build-launches.test.ts",
    "suite": "build launch authority [postgres]",
    "test": "rechecks operation expiry after an observed resource lock wait before committing dispatch",
    "postgres": true
  },
  {
    "file": "tests/controlplane/build-launches.test.ts",
    "suite": "build launch authority [postgres]",
    "test": "rechecks consumed-approval expiry after an observed resource lock wait before committing dispatch",
    "postgres": true
  },
  {
    "file": "tests/platform/codebuild-launch-authority.test.ts",
    "suite": "CodeBuild launch authority [postgres]",
    "test": "keeps the isolated actual-broker launcher unavailable in production",
    "postgres": true
  },
  {
    "file": "tests/platform/codebuild-launch-authority.test.ts",
    "suite": "CodeBuild launch authority [postgres]",
    "test": "commits one claim across competing workers and sends the bound ZIP once",
    "postgres": true
  },
  {
    "file": "tests/platform/codebuild-launch-authority.test.ts",
    "suite": "CodeBuild launch authority [postgres]",
    "test": "keeps an accepted-but-lost response permanently unconfirmed, including after token expiry",
    "postgres": true
  },
  {
    "file": "tests/platform/codebuild-launch-authority.test.ts",
    "suite": "CodeBuild launch authority [postgres]",
    "test": "rejects altered input/settings and missing ownership or stored checksum before another dispatch",
    "postgres": true
  },
  {
    "file": "tests/platform/codebuild-launch-authority.test.ts",
    "suite": "CodeBuild launch authority [postgres]",
    "test": "retains a provider-complete failure receipt independently of cancelled UI status",
    "postgres": true
  },
  {
    "file": "tests/platform/codebuild-launch-authority.test.ts",
    "suite": "CodeBuild launch authority [postgres]",
    "test": "refuses terminal status without completion, a foreign build, and a polling deadline as clean failure",
    "postgres": true
  },
  {
    "file": "tests/platform/codebuild-launch-authority.test.ts",
    "suite": "CodeBuild launch authority [postgres]",
    "test": "refuses expired approval through canonical current authority with a live operation and fence",
    "postgres": true
  },
  {
    "file": "tests/platform/codebuild-launch-authority.test.ts",
    "suite": "CodeBuild launch authority [postgres]",
    "test": "refuses revoked approver role through canonical current authority with a live operation and fence",
    "postgres": true
  },
  {
    "file": "tests/platform/codebuild-launch-authority.test.ts",
    "suite": "CodeBuild launch authority [postgres]",
    "test": "refuses new approval count through canonical current authority with a live operation and fence",
    "postgres": true
  },
  {
    "file": "tests/platform/codebuild-launch-authority.test.ts",
    "suite": "CodeBuild launch authority [postgres]",
    "test": "refuses current policy deny through canonical current authority with a live operation and fence",
    "postgres": true
  },
  {
    "file": "tests/platform/codebuild-launch-authority.test.ts",
    "suite": "CodeBuild launch authority [postgres]",
    "test": "refuses missing plan evidence through canonical current authority with a live operation and fence",
    "postgres": true
  },
  {
    "file": "tests/platform/codebuild-launch-authority.test.ts",
    "suite": "CodeBuild launch authority [postgres]",
    "test": "refuses moved approval round through canonical current authority with a live operation and fence",
    "postgres": true
  },
  {
    "file": "tests/platform/codebuild-launch-authority.test.ts",
    "suite": "CodeBuild launch authority [postgres]",
    "test": "reevaluates unchanged authority after an observed PostgreSQL resource lock wait before any launch",
    "postgres": true
  },
  {
    "file": "tests/platform/codebuild-launch-authority.test.ts",
    "suite": "CodeBuild launch authority [postgres]",
    "test": "reevaluates revoked approver role after an observed PostgreSQL resource lock wait before any launch",
    "postgres": true
  },
  {
    "file": "tests/platform/codebuild-launch-authority.test.ts",
    "suite": "CodeBuild launch authority [postgres]",
    "test": "reevaluates new approval count after an observed PostgreSQL resource lock wait before any launch",
    "postgres": true
  },
  {
    "file": "tests/platform/codebuild-launch-authority.test.ts",
    "suite": "CodeBuild launch authority [postgres]",
    "test": "reevaluates current policy deny after an observed PostgreSQL resource lock wait before any launch",
    "postgres": true
  },
  {
    "file": "tests/platform/codebuild-launch-authority.test.ts",
    "suite": "CodeBuild launch authority [postgres]",
    "test": "returns verified executed output with omitted NO_ARTIFACTS readback through canonical authority",
    "postgres": true
  },
  {
    "file": "tests/platform/codebuild-launch-authority.test.ts",
    "suite": "CodeBuild launch authority [postgres]",
    "test": "returns verified executed output with empty NO_ARTIFACTS readback through canonical authority",
    "postgres": true
  },
  {
    "file": "tests/platform/codebuild-launch-authority.test.ts",
    "suite": "CodeBuild launch authority [postgres]",
    "test": "returns verified executed output with default-flags NO_ARTIFACTS readback through canonical authority",
    "postgres": true
  },
  {
    "file": "tests/platform/codebuild-launch-authority.test.ts",
    "suite": "CodeBuild launch authority [postgres]",
    "test": "refuses a changed executed image even after the project was restored",
    "postgres": true
  },
  {
    "file": "tests/platform/codebuild-launch-authority.test.ts",
    "suite": "CodeBuild launch authority [postgres]",
    "test": "refuses a changed executed environment even after the project was restored",
    "postgres": true
  },
  {
    "file": "tests/platform/codebuild-launch-authority.test.ts",
    "suite": "CodeBuild launch authority [postgres]",
    "test": "refuses a changed executed repository even after the project was restored",
    "postgres": true
  },
  {
    "file": "tests/platform/codebuild-launch-authority.test.ts",
    "suite": "CodeBuild launch authority [postgres]",
    "test": "refuses a changed executed role even after the project was restored",
    "postgres": true
  },
  {
    "file": "tests/platform/codebuild-launch-authority.test.ts",
    "suite": "CodeBuild launch authority [postgres]",
    "test": "refuses a changed executed encryption even after the project was restored",
    "postgres": true
  },
  {
    "file": "tests/platform/codebuild-launch-authority.test.ts",
    "suite": "CodeBuild launch authority [postgres]",
    "test": "refuses a changed executed vpc even after the project was restored",
    "postgres": true
  },
  {
    "file": "tests/platform/codebuild-launch-authority.test.ts",
    "suite": "CodeBuild launch authority [postgres]",
    "test": "refuses a changed executed source even after the project was restored",
    "postgres": true
  },
  {
    "file": "tests/platform/codebuild-launch-authority.test.ts",
    "suite": "CodeBuild launch authority [postgres]",
    "test": "refuses a changed executed artifacts even after the project was restored",
    "postgres": true
  },
  {
    "file": "tests/platform/codebuild-launch-authority.test.ts",
    "suite": "CodeBuild launch authority [postgres]",
    "test": "refuses a changed executed secondaryArtifacts even after the project was restored",
    "postgres": true
  },
  {
    "file": "tests/platform/codebuild-launch-authority.test.ts",
    "suite": "CodeBuild launch authority [postgres]",
    "test": "refuses a changed executed missingEnvironment even after the project was restored",
    "postgres": true
  },
  {
    "file": "tests/platform/codebuild-launch-authority.test.ts",
    "suite": "CodeBuild launch authority [postgres]",
    "test": "refuses a changed executed duplicateEnvironment even after the project was restored",
    "postgres": true
  },
  {
    "file": "tests/platform/codebuild-launch-authority.test.ts",
    "suite": "CodeBuild launch authority [postgres]",
    "test": "refuses a changed executed duplicateDigest even after the project was restored",
    "postgres": true
  },
  {
    "file": "tests/platform/codebuild-launch-authority.test.ts",
    "suite": "CodeBuild launch authority [postgres]",
    "test": "refuses a changed executed digestType even after the project was restored",
    "postgres": true
  },
  {
    "file": "tests/platform/codebuild-launch-authority.test.ts",
    "suite": "CodeBuild launch authority [postgres]",
    "test": "refuses a changed executed retryLimit even after the project was restored",
    "postgres": true
  },
  {
    "file": "tests/platform/codebuild-launch-authority.test.ts",
    "suite": "CodeBuild launch authority [postgres]",
    "test": "refuses a changed executed retryAncestor even after the project was restored",
    "postgres": true
  },
  {
    "file": "tests/sources/github-store.test.ts",
    "suite": "GitHub source Postgres store (opt-in)",
    "test": "persists only identifiers and proof digests, and resolves bindings by workspace",
    "backend": "postgres"
  },
  {
    "file": "tests/sources/github-store.test.ts",
    "suite": "GitHub source Postgres store (opt-in)",
    "test": "refuses a changed callback workspace without consuming the legitimate intent",
    "backend": "postgres"
  },
  {
    "file": "tests/sources/github-store.test.ts",
    "suite": "GitHub source Postgres store (opt-in)",
    "test": "refuses a changed callback actor without consuming the legitimate intent",
    "backend": "postgres"
  },
  {
    "file": "tests/sources/github-store.test.ts",
    "suite": "GitHub source Postgres store (opt-in)",
    "test": "refuses a changed callback browser without consuming the legitimate intent",
    "backend": "postgres"
  },
  {
    "file": "tests/sources/github-store.test.ts",
    "suite": "GitHub source Postgres store (opt-in)",
    "test": "refuses a changed callback state without consuming the legitimate intent",
    "backend": "postgres"
  },
  {
    "file": "tests/sources/github-store.test.ts",
    "suite": "GitHub source Postgres store (opt-in)",
    "test": "refuses expired intents at both transitions using database time",
    "backend": "postgres"
  },
  {
    "file": "tests/sources/github-store.test.ts",
    "suite": "GitHub source Postgres store (opt-in)",
    "test": "allows only one racing setup and one racing OAuth callback",
    "backend": "postgres"
  },
  {
    "file": "tests/sources/github-store.test.ts",
    "suite": "GitHub source Postgres store (opt-in)",
    "test": "stores hashed state/proof and never lets an install callback skip OAuth",
    "backend": "postgres"
  },
  {
    "file": "tests/sources/github-store.test.ts",
    "suite": "GitHub source Postgres store (opt-in)",
    "test": "rejects stale/racing bind intents rather than overwriting another admin's binding",
    "backend": "postgres"
  },
  {
    "file": "tests/sources/github-store.test.ts",
    "suite": "GitHub source Postgres store (opt-in)",
    "test": "revokes new access, preserves a monotonic version and requires a new install intent",
    "backend": "postgres"
  },
  {
    "file": "tests/sources/github-store.test.ts",
    "suite": "GitHub source Postgres store (opt-in)",
    "test": "blocks a consumed callback and serializes competing revocation and replacement",
    "backend": "postgres"
  },
  {
    "file": "tests/sources/github-store.test.ts",
    "suite": "GitHub source Postgres store (opt-in)",
    "test": "scopes revocation by workspace and exact version; failed attempts retain legitimate intents",
    "backend": "postgres"
  },
  {
    "file": "tests/sources/github-store.test.ts",
    "suite": "GitHub source Postgres store (opt-in)",
    "test": "validates identifiers and numeric IDs without reflecting malicious data",
    "backend": "postgres"
  }
];
const BUILD_WORKFLOW_REQUIREMENTS = [
  {
    "file": "tests/workflows/deploy.test.ts",
    "suite": "deploy: lease loss and mutating-step failures",
    "test": "an unknown build launch outcome is uncertain and never automatically retried"
  },
  {
    "file": "tests/workflows/deploy.test.ts",
    "suite": "deploy: lease loss and mutating-step failures",
    "test": "pre-patch build retry history retains its original commands and failed classification on replay"
  },
  {
    "file": "tests/workflows/deploy.test.ts",
    "suite": "deploy: lease loss and mutating-step failures",
    "test": "a build that fails after the apply is failed, and says the apply stays"
  },
  {
    "file": "tests/workflows/deploy.test.ts",
    "suite": "deploy: cancellation",
    "test": "cancelling a pending build retains an uncertain accepted writer"
  },
  {
    "file": "tests/workflows/deploy.test.ts",
    "suite": "deploy: cancellation",
    "test": "pre-patch build cancellation history retains its cancelled outcome on replay"
  },
  {
    "file": "tests/workflows/failures.test.ts",
    "suite": "classifyFailure: the failure -> status table",
    "test": "retains unconfirmed patched build errors and timeouts as uncertain without changing legacy classification"
  },
  {
    "file": "tests/workflows/failures.test.ts",
    "suite": "the may-have-acted table and retry policies (policies.ts)",
    "test": "gives the patched build one attempt and waits for cancellation while retaining historical build options"
  },
  {
    "file": "tests/execution/release.test.ts",
    "suite": "buildArtifacts",
    "test": "retains a later parallel lost-response uncertainty over an earlier definitive failure and starts no fourth build"
  },
  {
    "file": "tests/execution/release.test.ts",
    "suite": "buildArtifacts",
    "test": "retains a later parallel polling-deadline uncertainty over an earlier definitive failure and starts no fourth build"
  }
];
const CODEBUILD_POSTGRES_FILE = "tests/platform/codebuild-launch-authority.test.ts";
const GITHUB_WEBHOOK_POSTGRES_CASES = [
  "duplicates and concurrent redeliveries commit one receipt, version change and audit per tenant",
  "refuses a delivery GUID reused with a different signed body without partial mutations",
  "changing the unsigned GUID cannot replay signed bytes against a freshly rebound row",
  "receipt, epoch, audit and intent invalidation roll back on an actual SQL audit failure",
  "fences consumed callbacks including expectedVersion=0 before any binding row exists",
  "refuses an actual consumed first binding after signed installation revocation",
  "refuses an actual consumed existing binding after signed installation revocation",
  "serializes webhook revocation with a first-binding transaction holding the same epoch lock"
].map(test => ({ file: "tests/sources/github-webhook.test.ts", suite: "GitHub webhook SQL [postgres]", test, postgres: true }));
const GITHUB_WEBHOOK_POSTGRES_REQUIREMENT = { file: "tests/sources/github-webhook.test.ts", suite: "GitHub webhook SQL [postgres]", postgres: true };

export const GATE_LANES = {
  postgres: {
    files: ["tests/hosted/authority/contract", "tests/scripts/migrate-hosted-to-postgres.test.ts", "tests/agent-link/pg-contract.test.ts", "tests/agent-control/pg-contract.test.ts", "tests/db/contract/workspace-sharing.test.ts", "tests/waitlist/pg-contract.test.ts"],
    env: { ZENITH_CONTRACT_POSTGRES: "1", ZENITH_FAST: "1" }, report: ".data-ci-lane/postgres-lane.json",
    prerequisites: ["Node 22.23.3", "npm ci --ignore-scripts", "PostgreSQL 16.15 at SUPABASE_DB_URL", "Hosted, agent, membership and waitlist migrations applied with scripts/ci/apply-supabase-migrations.sh"],
    tools: { node: "22.23.3", postgres: "16.15" },
  },
  policy: {
    files: ["tests/policy"], env: {}, report: ".data-ci-lane/policy-lane.json",
    prerequisites: ["Node 22.23.3", "npm ci --ignore-scripts", "OPA 1.19.1 at ZENITH_OPA_BIN", "Committed policy bundle verified with policy/build.mjs --check"],
    tools: { node: "22.23.3", opa: "1.19.1" },
  },
  tofu: {
    files: ["tests/tofu", "tests/providers/aws/drivers", "tests/providers/aws/identity", "tests/providers/gcp", "tests/providers/azure", "tests/providers/oci", "tests/execution/compile-refs-providers.test.ts", "tests/execution/journey.test.ts", "tests/security/tofu-secrets.test.ts", "tests/security/tofu-runner-env.test.ts", "tests/security/tofu-workspace-injection.test.ts"],
    env: { ZENITH_TEST_TOFU_NETWORK: "1" }, report: ".data-ci-lane/tofu-lane.json",
    prerequisites: ["Node 22.23.3", "npm ci --ignore-scripts", "OpenTofu 1.12.5 at ZENITH_TOFU_BIN", "Provider registry network access and committed lockfiles", "Writable plugin cache at ZENITH_TOFU_PLUGIN_CACHE"],
    tools: { node: "22.23.3", tofu: "1.12.5" },
  },
  workflows: {
    files: ["tests/workflows", "tests/platform", "tests/security/workflow-history.test.ts", ECS_REPLICA_REPAIR_FILES.execution, ECS_REPLICA_REPAIR_FILES.ownership, "tests/execution/release.test.ts"],
    excludeFiles: ["tests/workflows/mtls-live.test.ts", CODEBUILD_POSTGRES_FILE],
    env: { ZENITH_COMPOSE_TEMPORAL_MODE: "time-skipping", ZENITH_TEST_TEMPORAL_DOWNLOAD: "1", ZENITH_SEC_TEMPORAL: "1", ZENITH_TEST_TEMPORAL: "1", ZENITH_TEST_SOURCE_GITHUB: "1", ZENITH_TEST_SOURCE_REPO: "https://github.com/GODOSTROYER/zenith", ZENITH_TEST_SOURCE_REF: "37be7340536ccb68ae4bb49294e8ab3799d1f01b" },
    report: ".data-ci-lane/workflows-lane.json",
    prerequisites: ["Node 22.23.3", "npm ci --ignore-scripts", "Temporal CLI 1.9.1 at ZENITH_TEST_TEMPORAL_CLI", "Local Temporal dev and time-skipping servers; SDK test-server cache or download access", "Public GitHub codeload access for the immutable source fixture"],
    tools: { node: "22.23.3", temporal: "1.9.1" },
  },
  "platform-postgres": {
    files: ["tests/controlplane", "tests/capabilities", "tests/runners", "tests/reconcile/platform.test.ts", "tests/tofu/plan-artifact-handoff.test.ts", "tests/security/plan-artifact-secrecy.test.ts", "tests/execution/destroy-review.test.ts", "tests/execution/apply.test.ts", "tests/platform/plan-approval.test.ts", ECS_REPLICA_REPAIR_FILES.grants, CODEBUILD_POSTGRES_FILE, "tests/sources/github-store.test.ts", "tests/sources/github-webhook.test.ts"],
    env: { ZENITH_FAST: "1", ZENITH_TEST_TOFU_NETWORK: "1" }, report: ".data-ci-lane/platform-lane.json",
    prerequisites: ["Node 22.23.3", "npm ci --ignore-scripts", "PostgreSQL 16.15", "pg_dump and pg_restore of the same full client version and server major (optional absolute ZENITH_TEST_PG_DUMP_BIN / ZENITH_TEST_PG_RESTORE_BIN overrides)", "ZENITH_TEST_PLATFORM_PG_URL points to the real test database", "Platform migrations applied with scripts/ci/apply-platform-migrations.sh", "OpenTofu 1.12.5 at ZENITH_TOFU_BIN", "ZENITH_TEST_TOFU_NETWORK=1", "Provider registry network access and writable plugin cache"],
    tools: { node: "22.23.3", postgres: "16.15", tofu: "1.12.5" },
  },
};

// Native Go evidence is a separate contract, never a Vitest lane. IDs are
// committed requirements, not discovered from a possibly incomplete report.
const GO_MODULE = "github.com/GODOSTROYER/zenith/go";
const OPS = `${GO_MODULE}/internal/machine/ops`;
const MACHINE = `${GO_MODULE}/internal/machine`;
const cases = (packageName, names) => names.map((test) => ({ package: packageName, test, id: `linux-guest:${packageName}:${test}` }));
const subcases = (test, names) => names.map((name) => `${test}/${name}`);
export const LINUX_GUEST_CASES = [
  ...cases(OPS, [
    "TestWriteCreateReplaceNoop", "TestWriteStrictArgsAndConstraints", "TestWriteDisabledAndInvalidProfiles",
    "TestImmutableProfileVersionCanonicalContract", "TestFileWriteDefaultsDisabled",
    "TestWriteSymlinkFIFODeviceMountAndOwnership", "TestWriteConcurrentWritersAndDirectorySwapStress",
    "TestWriteExactMountAnchorsAndEscapes", "TestWriteBackupByteBudgetRetainsSparseCustody",
    ...subcases("TestWritePriorVersionSourceAndCapacityRefusal", ["prior", "create-only", "version", "source", "capacity", "private-store", "target-mode", "target-hardlink", "source-hardlink", "source-symlink", "parent-mode"]),
    ...subcases("TestWriteSymlinkFIFODeviceMountAndOwnership", ["symlink", "parent-symlink", "fifo"]),
    ...subcases("TestWriteFaultAndCancelPhases", ["file_sync", "prepared", "backup_file_sync", "intent_file_sync", "backup_directory_sync", "backup", "before_rename", "after_rename", "before_directory_sync", "directory_sync", "postcondition"].flatMap((phase) => [phase + "false", phase + "true"])),
    ...subcases("TestWriteIndependentPostconditionAndTargetSwap", ["before_rename", "postcondition", "noop"]),
    ...subcases("TestWriteCrashCustodyAndRestart", ["file_sync", "prepared", "backup", "after_rename", "before_directory_sync", "directory_sync"]),
    ...subcases("TestWriteModeBoundsBackupExhaustionAndSourceSwap", ["fixed0640", "bounded-source", "retained-capacity", "source-swapped-before-commit"]),
    ...subcases("TestWriteImmutableVersionCannotBeReused", ["pinned-bytes", "mode", "path", "ref", "source", "byte-bound", "backup-dir", "backup-bytes", "backup-count"]),
    ...subcases("TestWriteRejectsActualAccessAndDefaultACLs", ["target-access", "parent-default"]),
    "TestResultGoldens/file.write-filesystem",
  ]),
  ...cases(MACHINE, ["TestLocalTemplateConfigDefaultAndValidation", "TestFileWriteVersionsCLIUsesMetadataOnlyAndLoadingEnforcesVersion", "TestWriteWirePreservesUncertainCustodyWithoutOutput", "TestWriteAuditCompletionFailureIsUncertain"]),
];
export const LINUX_GUEST_PACKAGES = ["internal/agent", "internal/awsauth", "internal/machine", "internal/machine/ops", "internal/miniyaml", "internal/netguard", "internal/oci", "internal/protocol", "internal/redact", "internal/runner", "internal/runner/kinds"].map((name) => `${GO_MODULE}/${name}`);
export const LINUX_GUEST_NO_TEST_PACKAGES = ["cmd/zenith-runner", "cmd/zenithd", "internal/agent/fakecp", "internal/proc", "internal/protocol/protocoltest", "internal/version"].map((name) => `${GO_MODULE}/${name}`);
export const LINUX_GUEST_ALLOWED_SKIPS = [
  { package: OPS, test: "TestRealSystemctlAndJournalctl", reason: "Separately opted-in actual systemd acceptance; this gate starts no services." },
  ...cases(`${GO_MODULE}/internal/runner/kinds`, ["TestRealOpenTofuPlanShowApply", "TestRealOpenTofuWithProviderAndLockfile"]).map(({ package: packageName, test }) => ({ package: packageName, test, reason: "The existing dedicated OpenTofu workflow gate retains actual binary/provider evidence." })),
];
export function linuxGuestManifest() {
  return {
    schemaVersion: 1, lane: "linux-guest", kind: "native-go", files: [], excludeFiles: [], requirements: [], externalAcceptance: [], report: ".data-ci-guest/attempt-{attemptId}/sanitized.json",
    artifactSelection: "Fresh wrapper attempt ID, exact runner outputs, sanitized digest and observed CI runner outcome must agree; missing/mismatched selection fails.",
    env: { GOTOOLCHAIN: "local", CGO_ENABLED: "1", ZENITH_FILE_WRITE_TEST_ROOT: "/opt/zenith-file-write-tests", ZENITH_FILE_WRITE_MOUNT_FIXTURES: "/opt/zenith-file-write-mounts" },
    tools: { node: "22.23.3", go: "1.27.1" },
    command: ["node", "scripts/ci/run-guest-file-write-gate.mjs", "--run"],
    steps: [
      { id: "race", command: ["go", "test", "-json", "-race", "-count=1", "./..."] },
      { id: "goldens", command: ["go", "test", "-json", "-count=1", "./internal/machine/ops", "-run", "^TestResultGoldens$"] },
      { id: "golden-diff", command: ["git", "diff", "--exit-code", "--", "internal/machine/testdata/results"] },
      { id: "golden-status", command: ["git", "--no-optional-locks", "status", "--porcelain", "--", "internal/machine/testdata/results"] },
    ],
    requiredCases: LINUX_GUEST_CASES,
    goldenCases: cases(OPS, ["TestResultGoldens/file.write-filesystem"]),
    requiredPackages: LINUX_GUEST_PACKAGES, noTestPackages: LINUX_GUEST_NO_TEST_PACKAGES, allowedSkips: LINUX_GUEST_ALLOWED_SKIPS,
    prerequisites: ["Linux; unprivileged test UID/GID", "Node 22.23.3; Go 1.27.1; GOTOOLCHAIN=local; cgo C compiler", "Persistent ext-family, XFS or Btrfs root filesystem (no overlay/tmpfs/FUSE/network filesystem)", "/proc/self/fdinfo mount IDs; POSIX access/default ACL xattrs", "Python 3; util-linux mount/umount/flock; explicitly authorized disposable root fixture setup", "Owned exact /opt fixture roots and four actual bind mounts checked by guest-file-write-fixtures.sh", "Integrated frozen writer source and five actual Linux-generated committed file.write goldens", "No active fixture users during validated cleanup"],
    reportValidation: "Strict complete Go JSON lifecycles plus observed successful exits; absent or skipped required cases fail. Raw streams remain private.",
  };
}

/** @param {string} root @param {string} directory @returns {string[]} */
export function testFiles(root, directory) {
  return fs.readdirSync(path.join(root, directory), { withFileTypes: true }).flatMap((entry) => {
    const relative = `${directory}/${entry.name}`;
    return entry.isDirectory() ? testFiles(root, relative) : relative.endsWith(".test.ts") ? [relative] : [];
  }).sort();
}

/** Normalize only complete backend labels; mismatched quotes never identify a backend. */
export function canonicalSuite(value) {
  return String(value).replace(/^(['"])(PostgresAuthority)\1(?=\s|$)/, "$2").replace(/\[\s*(?:'([^']+)'|"([^"]+)"|([a-z]+))\s*\]/gi, (_all, single, double, bare) => `[${single ?? double ?? bare}]`);
}

export function assertionMatches(required, assertion) {
  if (!assertion || typeof assertion.fullName !== "string") return false;
  const ancestors = Array.isArray(assertion.ancestorTitles) ? assertion.ancestorTitles : [];
  if (required.suite && !ancestors.some((title) => typeof title === "string" && canonicalSuite(title) === canonicalSuite(required.suite))) return false;
  if (required.ancestorSuite && !ancestors.some((title) => typeof title === "string" && canonicalSuite(title) === canonicalSuite(required.ancestorSuite))) return false;
  if (required.excludeSuites?.some((suite) => ancestors.includes(suite))) return false;
  if (required.test && assertion.title !== required.test) return false;
  if (!required.postgres) return true;
  // Prefer suite ancestry. A test title mentioning PostgreSQL cannot turn a
  // PGlite suite into real-engine evidence. Older reports omit the ancestry.
  const labels = ancestors.length > 0 ? ancestors : [assertion.fullName];
  return labels.some((title) => typeof title === "string" && canonicalSuite(title).includes("[postgres]"));
}

/** Stable IDs contain only trusted source paths and a digest of the owned suite. */
export function requirementId(lane, required) {
  const identity = `${required.suite ?? ""}:${required.postgres ?? false}${required.ancestorSuite !== undefined ? `:${required.ancestorSuite}` : ""}`;
  const suffix = createHash("sha256").update(identity + (required.test ? `:test:${required.test}` : "")).digest("hex").slice(0, 12);
  return `${lane}:${required.file}:${suffix}`;
}

/** @typedef {Readonly<{ file: string, suite?: string, test?: string, ancestorSuite?: string, postgres?: boolean, backend?: string, id: string, excludeSuites?: readonly string[] }>} GateRequirement */
/**
 * Backend suite identity comes from committed gate declarations, never assertions.
 * @param {string} lane
 * @param {string} root
 * @returns {GateRequirement[]}
 */
export function requirementsFor(lane, root) {
  let requirements;
  switch (lane) {
    case "postgres":
      requirements = [
        ...testFiles(root, "tests/hosted/authority/contract").map((file) => ({ file, suite: file.endsWith("ledgers.test.ts") ? "PostgresAuthority ledgers" : "PostgresAuthority", backend: "postgres" })),
        { file: "tests/scripts/migrate-hosted-to-postgres.test.ts", suite: "migrate-hosted-to-postgres — against the real Supabase project", backend: "postgres" },
        ...[["tests/agent-link/pg-contract.test.ts", "AgentLinkPostgres"], ["tests/agent-control/pg-contract.test.ts", "AgentControlPostgres"], ["tests/db/contract/workspace-sharing.test.ts", "WorkspaceSharingPostgres"], ["tests/waitlist/pg-contract.test.ts", "WaitlistPostgres"]].map(([file, suite]) => ({ file, suite, backend: "postgres" })),
      ];
      break;
    case "policy":
      requirements = testFiles(root, "tests/policy").map((file) => ({ file }));
      break;
    case "tofu":
      requirements = TOFU_SUITES.map(([file, suite]) => ({ file, suite }));
      // The runner binary tests must not disappear behind passing mocked tests.
      requirements.push({ file: "tests/tofu/runner.test.ts" });
      break;
    case "workflows":
      requirements = [...testFiles(root, "tests/workflows"), ...testFiles(root, "tests/platform"), "tests/security/workflow-history.test.ts"]
        .filter((file) => !EXTERNAL_ACCEPTANCE.some((group) => group.wholeFile && group.file === file))
        .filter((file) => !Object.values(ECS_REPLICA_REPAIR_FILES).includes(file))
        .filter((file) => file !== CODEBUILD_POSTGRES_FILE)
        .flatMap((file) => file === "tests/platform/source-bundle.test.ts"
          ? ["source acquisition and canonical archives", "customer source bucket uploads", "GCS source upload through authorizedFetch", "live public GitHub source (opt-in network)"].map((suite) => ({ file, suite }))
          : [{ file }]);
      requirements.push(...ECS_REPLICA_REPAIR_WORKFLOW_REQUIREMENTS, ...BUILD_WORKFLOW_REQUIREMENTS);
      break;
    case "platform-postgres":
      requirements = ["tests/controlplane", "tests/capabilities", "tests/reconcile"].flatMap((directory) => testFiles(root, directory).flatMap((file) => {
        const source = fs.readFileSync(path.join(root, file), "utf8");
        const backendSuites = [...source.matchAll(/describe\.each\((?:LANES|STORE_KINDS|lanes)\)\(\s*(["'])(.*?)\1/g)].map((match) => ({
          file, suite: match[2].replace("$name", "postgres").replace("%s", "postgres"), postgres: true,
        }));
        const postgresOnly = [...source.matchAll(/describe\.skipIf\(!PG_URL\)\(\s*(["'])(.*?)\1/g)].map((match) => ({ file, suite: match[2], backend: "postgres" }));
        return [...backendSuites, ...postgresOnly];
      }));
      requirements.push({file:"tests/controlplane/migrations.test.ts",suite:"migrator [postgres] concurrency and fail-closed open",test:"schema 6 emitted hardening upgrades through the canonical migrator under a distinct owner with RLS, role isolation and immutable artifacts",postgres:true});
      // These require independent PostgreSQL handles; they are not registered as isolated PGlite skips.
      requirements.push(...[
        "publisher and reader barriers serialize visible commit, then losing fence cannot dispatch",
        "a committed dispatch CAS with lost response remains uncertain and refuses another claim",
        "source association locks both operations and loses safely to a partially decided browser round",
        "lost durable completion response refuses replay even when the commit succeeded",
        "a serialized canonical proof with 0 required humans permits exactly one live durable dispatch",
        "a serialized canonical proof with 2 required humans permits exactly one live durable dispatch",
      ].map(test=>({file:"tests/controlplane/plan-artifacts.test.ts",suite:"plan artifacts [postgres]",test,postgres:true})));
      requirements.push({file:"tests/controlplane/operations.test.ts",suite:"operations [postgres]",ancestorSuite:"claimForExecution",test:"a blocked environment fence is acquired before the operation row across independent PostgreSQL handles",postgres:true});
      // Explicit combined contract: each scenario is mandatory, with no discovery/skip fallback.
      requirements.push(...[
        "producer exits and loses its directory; another worker applies ORIGINAL bytes after a separate fresh check, then destroys",
        "fresh semantic drift refuses before dispatch and has no original/fresh fallback",
        "source/config/backend/address-map/lock/tool and operation swaps refuse before mutation",
        "tampering with the original after inspection refuses before apply and preserves uncertainty after dispatch",
        "stale original state serial refuses even when independent fresh semantic plan is unchanged, with no fallback",
        "source review completes, browser human approval is consumed, and destination destroys the associated ORIGINAL",
        "restore into a fresh PostgreSQL store with matching keys preserves the original; missing keys refuse",
        "fake cipher authority and arbitrary runner handles cannot mint production admission",
      ].map(test => ({file:"tests/tofu/plan-artifact-handoff.test.ts",suite:"authenticated original cross-worker handoff [postgres]",test,postgres:true})));
      requirements.push(...["expired approval","revoked approver role","new policy denial","expiry after authority check","expiry during role lookup"].map(mode=>({file:"tests/execution/apply.test.ts",suite:"dispatch current authority [postgres]",test:`refuses ${mode} after fresh replan and before durable dispatch`,postgres:true})));
      requirements.push({file:"tests/platform/plan-approval.test.ts",suite:"immutable source review approval [postgres]",postgres:true});
      requirements.push({file:"tests/execution/destroy-review.test.ts",suite:"undecided teardown supersession [postgres]",postgres:true});
      requirements.push({file:"tests/security/plan-artifact-secrecy.test.ts",suite:"encrypted plan artifact secrecy [postgres]",postgres:true});
      requirements.push(...ECS_REPLICA_REPAIR_POSTGRES_SUITES.map((suite) => ({ file: ECS_REPLICA_REPAIR_FILES.grants, suite, ancestorSuite: "replica repair authority [postgres]", postgres: true })));
      requirements.push(...BUILD_SOURCE_POSTGRES_REQUIREMENTS, GITHUB_WEBHOOK_POSTGRES_REQUIREMENT, ...GITHUB_WEBHOOK_POSTGRES_CASES);
      break;
    default:
      throw new Error("Unknown CI lane");
  }
  return requirements.map((required) => ({ ...required, id: requirementId(lane, required) }));
}

/**
 * @typedef {object} GateManifest
 * @property {number} schemaVersion
 * @property {string} lane
 * @property {string[]} files
 * @property {string[]} excludeFiles
 * @property {Record<string, string>} env
 * @property {string} report
 * @property {string[]} command
 * @property {GateRequirement[]} requirements
 * @property {typeof EXTERNAL_ACCEPTANCE} externalAcceptance
 * @property {{ id: string, command: string[] }[]} steps
 * @property {Record<string, string>} tools
 * @property {string[]} prerequisites
 * @property {string} [reportValidation]
 */
/** @param {string} lane @param {string} [root] @param {string} [reportPath] @returns {GateManifest} */
export function manifestFor(lane, root = process.cwd(), reportPath) {
  if (lane === "linux-guest") return linuxGuestManifest();
  if (lane === "core" || lane === "fresh") return { schemaVersion: 1, lane, files: [], excludeFiles: [], env: {}, report: "", command: [], requirements: [], externalAcceptance: [], tools: { node: "22.23.3" }, prerequisites: ["Node 22.23.3", "npm ci --ignore-scripts"], steps: lane === "fresh" ? [{ id: "install", command: ["npm", "ci", "--ignore-scripts"] }, ...CORE_CHECKS] : CORE_CHECKS, reportValidation: "Command exits establish core checks; real-engine requirements are validated by their dedicated lanes." };
  if (!Object.hasOwn(GATE_LANES, lane)) throw new Error("Unknown CI lane");
  const config = GATE_LANES[lane];
  const report = reportPath ?? config.report;
  const args = ["run", ...config.files, ...(config.excludeFiles ?? []).flatMap((file) => ["--exclude", file]), "--maxWorkers=1", "--no-file-parallelism", "--reporter=default", "--reporter=json", `--outputFile.json=${report}`];
  return { schemaVersion: 1, lane, ...config, excludeFiles: config.excludeFiles ?? [], steps: [], report, command: ["node", "node_modules/vitest/vitest.mjs", ...args], requirements: requirementsFor(lane, root), externalAcceptance: lane === "workflows" ? EXTERNAL_ACCEPTANCE : [] };
}

export function main(args) {
  try {
    if (args.length > 1) throw new Error("usage");
    const result = args[0] === "external-acceptance" ? { schemaVersion: 1, groups: EXTERNAL_ACCEPTANCE.map((group) => ({ ...group, status: "unverified", command: ["node", "node_modules/vitest/vitest.mjs", "run", group.file, "--testNamePattern", group.suite.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "--maxWorkers=1"] })) } : args[0] ? manifestFor(args[0]) : { schemaVersion: 1, lanes: ["fresh", "core", ...Object.keys(GATE_LANES), "linux-guest"].map((lane) => manifestFor(lane)) };
    console.log(JSON.stringify(result, null, 2));
    return 0;
  } catch {
    console.error("usage: node scripts/ci/gate-manifest.mjs [fresh|core|postgres|policy|tofu|workflows|platform-postgres|linux-guest|external-acceptance]");
    return 2;
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) process.exitCode = main(process.argv.slice(2));

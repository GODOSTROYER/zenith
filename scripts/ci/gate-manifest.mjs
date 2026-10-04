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

// Committed source13 scenarios are mandatory even when a suite/source file is
// missing. SQL/Tofu receipts do not establish live GitHub or cloud acceptance.
// Exact owning fixture and stage evidence counterparts are separate reviewed prerequisites.
export const SOURCE_FIXTURE_POSTGRES_REQUIREMENTS = [
  {
    "file": "tests/platform/composition.test.ts",
    "suite": "platform composition",
    "test": "captures optional tool authority absent at composition before lazy resolution",
    "backend": "postgres"
  },
  {
    "file": "tests/platform/composition.test.ts",
    "suite": "platform composition",
    "test": "captures optional tool authority present at composition before lazy resolution",
    "backend": "postgres"
  },
  {
    "file": "tests/platform/source-bundle-composition.test.ts",
    "suite": "source-bundle execution wiring",
    "test": "forwards the download configuration and preserves resource overrides",
    "backend": "postgres"
  },
  {
    "file": "tests/platform/source-bundle-composition.test.ts",
    "suite": "source-bundle execution wiring",
    "test": "uses the injected resource store with the activity's workspace and environment",
    "backend": "postgres"
  },
  {
    "file": "tests/platform/source-bundle-composition.test.ts",
    "suite": "source-bundle execution wiring",
    "test": "composes Azure preparation, stored-source reading and the SQL launch journal by default",
    "backend": "postgres"
  },
  {
    "file": "tests/platform/source-bundle-composition.test.ts",
    "suite": "source-bundle execution wiring",
    "test": "uses the trusted connection binding without a source resolver override through ACR launch",
    "backend": "postgres"
  },
  {
    "file": "tests/platform/source-bundle-composition.test.ts",
    "suite": "source-bundle execution wiring",
    "test": "refuses an Azure environment without a binding in the composed preparation port",
    "backend": "postgres"
  },
  {
    "file": "tests/platform/source-bundle-github.test.ts",
    "suite": "C3 default GitHub App acquisition",
    "test": "uses the default connector in the existing composition hook and returns archive identifiers only",
    "backend": "postgres"
  },
  {
    "file": "tests/platform/source-bundle-azure.test.ts",
    "suite": "provider-dispatched Azure source preparation",
    "test": "prepares canonical tar.gz in the bound container and passes exact bytes to ACR",
    "backend": "postgres"
  },
  {
    "file": "tests/platform/source-bundle-azure.test.ts",
    "suite": "provider-dispatched Azure source preparation",
    "test": "rereads the stored bundle on another instance without downloading a moving GitHub ref",
    "backend": "postgres"
  },
  {
    "file": "tests/platform/source-bundle-azure.test.ts",
    "suite": "provider-dispatched Azure source preparation",
    "test": "clearly refuses missing storage bindings before downloading source: undefined",
    "backend": "postgres"
  },
  {
    "file": "tests/platform/source-bundle-azure.test.ts",
    "suite": "provider-dispatched Azure source preparation",
    "test": "clearly refuses missing storage bindings before downloading source: resolver returning null",
    "backend": "postgres"
  },
  {
    "file": "tests/platform/source-bundle-azure.test.ts",
    "suite": "provider-dispatched Azure source preparation",
    "test": "refuses a cross-tenant workspaceId resource lookup",
    "backend": "postgres"
  },
  {
    "file": "tests/platform/source-bundle-azure.test.ts",
    "suite": "provider-dispatched Azure source preparation",
    "test": "refuses a cross-tenant environmentId resource lookup",
    "backend": "postgres"
  },
  {
    "file": "tests/platform/source-bundle-azure.test.ts",
    "suite": "provider-dispatched Azure source preparation",
    "test": "refuses a different pipeline source and a mismatched provider/session before acquisition",
    "backend": "postgres"
  },
  {
    "file": "tests/platform/source-bundle-azure.test.ts",
    "suite": "provider-dispatched Azure source preparation",
    "test": "refuses changed stored bytes before an ACR upload or schedule",
    "backend": "postgres"
  },
  {
    "file": "tests/platform/source-bundle-azure.test.ts",
    "suite": "provider-dispatched Azure source preparation",
    "test": "propagates C3's lowered compressed-size ceiling to the stored source reader",
    "backend": "postgres"
  },
  {
    "file": "tests/platform/source-bundle-azure.test.ts",
    "suite": "provider-dispatched Azure source preparation",
    "test": "binds the private GitHub connector to the activity's tenant and environment",
    "backend": "postgres"
  }
];
export const SOURCE_PLAN_EVIDENCE_POSTGRES_REQUIREMENTS = [
  {
    "file": "tests/controlplane/source-plan-evidence.test.ts",
    "suite": "source plan evidence authority [postgres]",
    "test": "selects the original plan after a later final plan with the same digest without deleting either row",
    "postgres": true
  },
  {
    "file": "tests/controlplane/source-plan-evidence.test.ts",
    "suite": "source plan evidence authority [postgres]",
    "test": "keeps plan selection scoped to the exact tenant operation kind digest and stage",
    "postgres": true
  },
  {
    "file": "tests/controlplane/source-plan-evidence.test.ts",
    "suite": "source plan evidence authority [postgres]",
    "test": "refuses final-only source evidence before a build or tool mutation",
    "postgres": true
  },
  {
    "file": "tests/controlplane/source-plan-evidence.test.ts",
    "suite": "source plan evidence authority [postgres]",
    "test": "retains the non-simulated review guard when selecting a plan stage",
    "postgres": true
  }
];

// Native final raw-plan source admission remains mandatory when either trusted source file disappears.
export const PLAN_SOURCE_AUTHORITY_POSTGRES_REQUIREMENTS = [
  {
    "file": "tests/controlplane/plan-artifact-source-authority.test.ts",
    "suite": "original plan source dispatch authority [postgres]",
    "test": "final original-plan source admission fences unchanged private binding during delayed current human role lookup",
    "postgres": true
  },
  {
    "file": "tests/controlplane/plan-artifact-source-authority.test.ts",
    "suite": "original plan source dispatch authority [postgres]",
    "test": "final original-plan source admission fences revoked private binding during delayed current human role lookup",
    "postgres": true
  },
  {
    "file": "tests/controlplane/plan-artifact-source-authority.test.ts",
    "suite": "original plan source dispatch authority [postgres]",
    "test": "final original-plan source admission fences removed private binding during delayed current human role lookup",
    "postgres": true
  },
  {
    "file": "tests/controlplane/plan-artifact-source-authority.test.ts",
    "suite": "original plan source dispatch authority [postgres]",
    "test": "final original-plan source admission fences replaced private binding during delayed current human role lookup",
    "postgres": true
  },
  {
    "file": "tests/controlplane/plan-artifact-source-authority.test.ts",
    "suite": "original plan source dispatch authority [postgres]",
    "test": "final original-plan source admission fences introduced public binding during delayed current human role lookup",
    "postgres": true
  },
  {
    "file": "tests/controlplane/plan-artifact-source-authority.test.ts",
    "suite": "original plan source dispatch authority [postgres]",
    "test": "full service recipe JSON mutation with unchanged stored digest refuses original dispatch",
    "postgres": true
  },
  {
    "file": "tests/controlplane/plan-artifact-source-authority.test.ts",
    "suite": "original plan source dispatch authority [postgres]",
    "test": "full pipeline recipe JSON mutation with unchanged stored digest refuses original dispatch",
    "postgres": true
  },
  {
    "file": "tests/controlplane/plan-artifact-source-authority.test.ts",
    "suite": "original plan source dispatch authority [postgres]",
    "test": "native original-plan custody refuses missing source without entering dispatch",
    "postgres": true
  },
  {
    "file": "tests/controlplane/plan-artifact-source-authority.test.ts",
    "suite": "original plan source dispatch authority [postgres]",
    "test": "native original-plan custody refuses foreign source without entering dispatch",
    "postgres": true
  },
  {
    "file": "tests/controlplane/plan-artifact-source-authority.test.ts",
    "suite": "original plan source dispatch authority [postgres]",
    "test": "native original-plan custody refuses stripped source without entering dispatch",
    "postgres": true
  },
  {
    "file": "tests/controlplane/plan-artifact-source-authority.test.ts",
    "suite": "original plan source dispatch authority [postgres]",
    "test": "genuine native source-free absence retains historical original dispatch compatibility",
    "postgres": true
  },
  {
    "file": "tests/controlplane/plan-artifact-source-authority.test.ts",
    "suite": "original plan source dispatch authority [postgres]",
    "test": "mixed-case multi-source review and final native aggregate share exact ASCII lexical service ordering",
    "postgres": true
  },
  {
    "file": "tests/controlplane/plan-artifact-source-authority.test.ts",
    "suite": "original plan source dispatch authority [postgres]",
    "test": "committed private revocation during an observed three-connection use-row waiter refuses the final original dispatch CAS",
    "postgres": true
  },
  {
    "file": "tests/tofu/plan-artifact-handoff.test.ts",
    "suite": "authenticated original cross-worker handoff [postgres]",
    "test": "independent saved binary with matching native private source binding applies the exact original once",
    "postgres": true
  },
  {
    "file": "tests/tofu/plan-artifact-handoff.test.ts",
    "suite": "authenticated original cross-worker handoff [postgres]",
    "test": "independent saved binary refuses committed private source revocation before original apply without a fresh fallback",
    "postgres": true
  }
];

export const APPROVED_SOURCE_POSTGRES_REQUIREMENTS = [
  ...[
    "persists one immutable row across two actual independent handles and reuses it after producer loss",
    "rollback before commit retains no partial source row and allows a subsequent capture",
    "a lost acknowledgement leaves the same permanent row for an independent retry",
    "retained main bytes remain pinned after branch/tag movement across source-bound plan recording",
    "retained v1.0.0 bytes remain pinned after branch/tag movement across source-bound plan recording",
    "a different canonical archive for the same commit refuses while preserving the original row",
    "same spec_digest with changed service JSON cannot establish native recipe authority",
    "same spec_digest with changed pipeline JSON cannot establish native recipe authority",
    "retained service JSON mutation with unchanged digest refuses current authority",
    "retained pipeline JSON mutation with unchanged digest refuses current authority",
    "authentic capture at a different requested ref cannot borrow the owning recipe digest",
    "foreign workspaceId cannot read or retain another scope",
    "foreign operationId cannot read or retain another scope",
    "foreign projectId cannot read or retain another scope",
    "foreign environmentId cannot read or retain another scope",
    "raw/as-cast metadata cannot forge actual archive capture provenance",
    "expired operation authority refuses both first capture and current retained row",
    "expired execution authority refuses both first capture and current retained row",
    "expired fence authority refuses both first capture and current retained row",
    "remembered private binding revoked never becomes anonymous even when repository is public",
    "remembered private binding removed never becomes anonymous even when repository is public",
    "remembered private binding replaced never becomes anonymous even when repository is public",
    "retains a matching bound identity and refuses missing App configuration after capture",
    "repository reuse/replacement at the same canonical slug refuses immutable numeric identity",
    "owning PostgreSQL withPlanReview returns the source-bound normalized plan and safe metadata",
    "owning PostgreSQL legacy source-free view remains byte-compatible when no native snapshots exist",
    "owning PostgreSQL browser projection refuses foreign source set and display without returning a source-less approval",
    "owning PostgreSQL browser projection refuses changed display without returning a source-less approval",
    "owning PostgreSQL browser projection refuses absent native row without returning a source-less approval",
    "owning PostgreSQL browser projection refuses foreign project row without returning a source-less approval",
    "owning PostgreSQL browser projection refuses wrong native hash without returning a source-less approval",
    "owning PostgreSQL browser projection refuses all source fields stripped without returning a source-less approval",
    "only exact source-bound nonsimulated plan evidence enables native upload readiness",
    "rejects new source attachment once an old plan digest is recorded",
    "revocation during a delayed archive read refuses capture before native persistence",
    "a proved resource waiter rechecks current operation clock after release, without capturing a stale source row",
    "permanent rows refuse UPDATE, DELETE and TRUNCATE while no-op UPDATE preserves identity",
    "schema rejects missing/nonnumeric/foreign provider-format metadata independently of TypeScript"
  ].map(test => ({file:"tests/controlplane/approved-source-snapshots.test.ts",suite:"permanent approved source snapshots [postgres]",test,postgres:true})),
  ...[
    "final native source CAS fences unchanged binding during delayed current approver lookup",
    "final native source CAS fences binding revoked during delayed current approver lookup",
    "final native source CAS fences binding removed during delayed current approver lookup",
    "final native source CAS fences binding replaced during delayed current approver lookup",
    "final native source CAS fences public absence replaced during delayed current approver lookup",
    "retained-launch recovery fences unchanged binding during delayed approver lookup without another SDK attempt",
    "retained-launch recovery fences binding revoked during delayed approver lookup without another SDK attempt",
    "retained-launch recovery fences binding removed during delayed approver lookup without another SDK attempt",
    "retained-launch recovery fences public absence replaced during delayed approver lookup without another SDK attempt",
    "rechecks unchanged binding after an exact three-connection retained launch lock wait",
    "rechecks binding revoked after an exact three-connection retained launch lock wait",
    "same stored digest with changed service recipe JSON refuses before native launch and SDK mutation",
    "same stored digest with changed pipeline recipe JSON refuses before native launch and SDK mutation",
    "native source CAS refuses missing row without a new launch",
    "native source CAS refuses foreign project row without a new launch",
    "native source CAS refuses wrong approved set without a new launch",
    "native source CAS refuses simulated approval evidence without a new launch"
  ].map(test => ({file:"tests/controlplane/build-launch-broker-binding.test.ts",suite:"CodeBuild transaction-bound broker [postgres]",test,postgres:true})),
  ...[
    "fresh canonical migrations keep permanent approved source snapshots select/insert-only",
    "same-owner schema6 canonical migrations keep permanent approved source snapshots select/insert-only",
    "schema12 refuses startup and even source-free plan review until the canonical source migration is applied"
  ].map(test => ({file:"tests/controlplane/migrations.test.ts",suite:"migrator [postgres] concurrency and fail-closed open",test,postgres:true})),
  ...[
    "matching immutable source identity consumes original bytes and a different source digest refuses before dispatch"
  ].map(test => ({file:"tests/tofu/plan-artifact-handoff.test.ts",suite:"authenticated original cross-worker handoff [postgres]",test,postgres:true})),
  ...[
    "sweeps claim/get/acknowledge/observeTerminal with current owning authority and preserves A exactly"
  ].map(test => ({file:"tests/controlplane/tenancy.test.ts",suite:"build launch tenant isolation sweep [postgres]",test,postgres:true})),
  {
    file: "tests/platform/approved-source-runtime.test.ts",
    suite: "default approved source runtime owning persistence [postgres]",
    test: "default single-pool owning runtime captures, retains and verifies the same immutable row across an independent pool",
    postgres: true,
  },
];

const BOUND_BUILD_POSTGRES_CASES = [
  ...["production", "isolated"].map(mode => `launches with valid owning approvals on a single-connection pool through ${mode} composition`),
  "ignores a permissive global memory policy and authentic approval IDs when owning PostgreSQL policy denies",
  "rebinds the captured isolated broker store instead of admitting its memory policy",
  ...["unchanged authority", "current approver demotion", "current requester removal", "raised policy count", "current policy deny"].map(change => `uses ${change} after an observed PostgreSQL resource lock wait`),
  ...["unchanged settings", "two-person policy", "denying policy", "lower autonomy", "same-value policy version", "same-value environment version", "same-version policy params", "same-version autonomy", "same-version environment params", "deleted policy row", "deleted environment row"].map(change => `fences insertion when ${change} is observed during a delayed approver read`),
  ...["unchanged defaults", "new default policy row", "new default environment row", "new foreign environment row"].map(change => `fences explicit absent settings when ${change} occurs during approver lookup`),
  ...["unchanged recovery", "two-person policy", "denying policy", "lower autonomy", "same-value policy version", "same-value environment version", "same-version policy params", "same-version autonomy", "same-version environment params", "deleted policy row", "deleted environment row", "new default policy row", "new default environment row", "new foreign environment row"].map(change => `fences retained-launch recovery under ${change} without a second SDK attempt`),
  "cannot continue a claim from a late membership success after the bounded read is aborted",
  "captures isolated evaluator ports once while always rebinding its store",
  ...["foreign membership", "malformed membership", "inaccessible membership"].map(change => `refuses ${change} with live owning approval before any launch`),
  "refuses expired consumed approval even with current product admin and live operation/fence",
].map(test => ({ file: "tests/controlplane/build-launch-broker-binding.test.ts", suite: "CodeBuild transaction-bound broker [postgres]", test, postgres: true }));

// Permanent signed outcome evidence must execute every owning/refusal case on real PostgreSQL.
const AGENT_EFFECT_POSTGRES_CASES = [
  "settles active work atomically and accepts an identical signed retry without replacing the first evidence",
  "retains a cancelled-after-claimed outcome without reopening the job or clearing operation uncertainty",
  "retains a cancelled-after-running outcome without reopening the job or clearing operation uncertainty",
  "retains an authenticated result after reaper timeout independently of its terminal projection",
  "refuses queued work with no original claim and retains no synthetic receipt",
  "refuses cancelled-unclaimed work with no original claim and retains no synthetic receipt",
  "refuses expired work with no original claim and retains no synthetic receipt",
  "refuses foreign workspace, agent, job and invalid signature without recording evidence",
  "refuses valid encrypted outcomes under foreign SQL scope while retaining owning evidence",
  "rechecks revocation after request authentication and refuses the previously valid identity",
  "refuses unknown fields and non-JSON/deep result values with fixed-safe errors",
  "serializes independent matching deliveries and retains exactly the first immutable receipt",
  "serializes divergent deliveries across independent workers and refuses the losing logical outcome",
  "retains committed evidence when the caller loses the acknowledgement and refuses any replay of work",
  "commits active settlement and receipt before advisory audit delivery, retaining evidence when delivery fails",
  "binds sealed evidence to workspace, agent kind, job, agent key and original envelope without an old-key fallback",
  "copies returned evidence and validates ciphertext rather than accepting raw proof-shaped results",
  "rolls back the receipt and active projection together, then accepts a fresh delivery",
  "makes receipt update/delete and original assignment substitution fail at the database boundary",
  "observes a blocked PostgreSQL result writer and retains late evidence when cancellation wins the job lock",
];
const AGENT_EFFECT_POSTGRES_REQUIREMENTS = ["runner", "machine"].flatMap(kind => AGENT_EFFECT_POSTGRES_CASES.map(test => ({
  file: "tests/runners/late-effect-receipts.test.ts", suite: `${kind} authenticated outcomes`,
  ancestorSuite: "agent effect receipts [postgres]", test, postgres: true,
})));

// Fixed operation contracts survive missing source files and reports. Backend
// metadata describes actual SQL; product-port and wire models remain labelled.
const WORKFLOW_INTENT_SQL_FILE = "tests/controlplane/workflow-start-intents.test.ts";
const WORKFLOW_INTENT_AUTHORITY_FILE = "tests/controlplane/workflow-start-authority.test.ts";
const WORKFLOW_INTENT_TEMPORAL_FILE = "tests/workflows/start-intent.test.ts";
const CURRENT_MEMBERSHIP_FILE = "tests/capabilities/default-current-membership.test.ts";
const RECONCILE_SCHEDULE_CASES = [
  "creates one compatible schedule, provisions concurrently and preserves an operator pause",
  "refuses changed configuration and foreign ownership without updating the existing action",
  "a real concurrent operator pause invalidates activation CAS and is preserved",
  "refuses absent prerequisites and a production PGlite store before schedule creation",
  "proves SKIP overlap while the first scheduled activity is actually held",
  "the global database lease refuses a direct concurrent sweep despite distinct workflow IDs",
  "the valid sweep-v1 environment retains its distinct lease while the global sweep runs",
  "keeps durable minute scheduling active after an actual database statement failure and recovers",
  "preserves the schedule and queued execution through an actual server process restart",
  "a completed pass replays after a worker restart without rerunning its SQL activity",
  "cancellation reaches a held controller read, releases the global lease and runs no compensation",
  "claims a bounded fair SQL batch and leaves unvisited environments due for the next pass",
  "checks every authority-bearing schedule field on a genuine describe result",
  "refuses persisted raw versioning and workflow-ID policies that SDK decoding omits"
];
const RECONCILE_COMPOSITION_CASES = [
  "refuses actual PGlite, closes a refused handle, and does not inherit a global broker ready flag",
  "confirms its real configured namespace, closes its client, and refuses an unavailable namespace",
  "owning PostgreSQL canonical broker with modeled current product membership: unchanged",
  "owning PostgreSQL canonical broker with modeled current product membership: demoted",
  "owning PostgreSQL canonical broker with modeled current product membership: cancelled",
  "polls the full default activity set before provisioning and observes encrypted real SQL results",
  "preserves operator pause and refuses incompatible ownership/routing in both permission modes",
  "a held actual fleet lease reports busy and cannot advertise successful observation",
  "bounded real PostgreSQL lock outage defers a pass and the unpaused schedule recovers",
  "pre-acquisition cancellation during an observed schema prerequisite waiter starts no compensation",
  "default controller cancellation after an observed post-acquisition SQL waiter releases its exact live fleet lease",
  "a canonical eligible empty graph completes in SQL, then owned worker restart services the same schedule"
];
const WORKFLOW_INTENT_SQL_CASES = [
  "commits typed immutable intent before a sole claim; competing workers retain one permanent attempt",
  "rebinds an alternative broker store to the actual locked SQL authority rather than trusting another approval ledger",
  "rollback leaves no prepared intent or attempt; commit acknowledgement loss preserves the attempted tombstone",
  "different arguments, kind, destination, queue and foreign tenant cannot replace the first binding",
  "refuses new dispatch under expired approval",
  "refuses new dispatch under revoked role",
  "refuses new dispatch under raised count",
  "refuses new dispatch under policy deny",
  "refuses new dispatch under expired operation",
  "refuses new dispatch under cancelled",
  "refuses new dispatch under lost fence",
  "late matching acknowledgement survives cancellation and reaper; first receipt wins and queue never reopens",
  "proposal-approved deploy starts before executable plan approval; preApproved cannot supply missing authority",
  "approved read-only teardown review may be admitted before its worker claims the operation",
  "an approved but unclaimed mutation operation cannot use workflow admission to consume or bypass its execution claim",
  "after an observed final intent-row lock wait, unchanged is evaluated freshly",
  "after an observed final intent-row lock wait, demoted approver is evaluated freshly",
  "after an observed final intent-row lock wait, raised count is evaluated freshly",
  "after an observed final intent-row lock wait, current deny is evaluated freshly",
  "after an observed final intent-row lock wait, approval expiry is evaluated freshly"
];
const WORKFLOW_INTENT_PRIVILEGE_CASES = [
  "fresh migration12 refuses inherited TRUNCATE and retains the attempted tombstone",
  "same-owner schema6 migration12 refuses inherited TRUNCATE and retains the attempted tombstone"
];
const WORKFLOW_INTENT_AUTHORITY_CASES = [
  "uses the owning single-connection transaction through production composition",
  "uses the owning single-connection transaction through isolated composition",
  "ignores a permissive global memory broker at prepare with authentic owning consumed approvals",
  "ignores a permissive global memory broker at claim with authentic owning consumed approvals",
  "refuses explicit process memory mode before prepare reads the durable store",
  "refuses explicit process memory mode before claim reads the durable store",
  "captures isolated ports once and discards the broker's mutable/alternative store",
  "refuses freshly removed requester at prepare despite the old bulk snapshot",
  "refuses freshly removed approver at prepare despite the old bulk snapshot",
  "refuses freshly removed requester at claim despite the old bulk snapshot",
  "refuses freshly removed approver at claim despite the old bulk snapshot",
  "prepare fences unchanged settings committed during a delayed consumed-approver read",
  "prepare fences two-person policy committed during a delayed consumed-approver read",
  "prepare fences denying policy committed during a delayed consumed-approver read",
  "prepare fences policy version committed during a delayed consumed-approver read",
  "prepare fences policy JSON same version committed during a delayed consumed-approver read",
  "prepare fences deleted policy committed during a delayed consumed-approver read",
  "prepare fences replaced policy same version committed during a delayed consumed-approver read",
  "prepare fences autonomy committed during a delayed consumed-approver read",
  "prepare fences environment version committed during a delayed consumed-approver read",
  "prepare fences autonomy same version committed during a delayed consumed-approver read",
  "prepare fences environment JSON same version committed during a delayed consumed-approver read",
  "prepare fences deleted environment committed during a delayed consumed-approver read",
  "prepare fences unchanged defaults committed during a delayed consumed-approver read",
  "prepare fences insert default policy committed during a delayed consumed-approver read",
  "prepare fences insert default environment committed during a delayed consumed-approver read",
  "prepare fences insert foreign environment committed during a delayed consumed-approver read",
  "claim fences unchanged settings committed during a delayed consumed-approver read",
  "claim fences two-person policy committed during a delayed consumed-approver read",
  "claim fences denying policy committed during a delayed consumed-approver read",
  "claim fences policy version committed during a delayed consumed-approver read",
  "claim fences policy JSON same version committed during a delayed consumed-approver read",
  "claim fences deleted policy committed during a delayed consumed-approver read",
  "claim fences replaced policy same version committed during a delayed consumed-approver read",
  "claim fences autonomy committed during a delayed consumed-approver read",
  "claim fences environment version committed during a delayed consumed-approver read",
  "claim fences autonomy same version committed during a delayed consumed-approver read",
  "claim fences environment JSON same version committed during a delayed consumed-approver read",
  "claim fences deleted environment committed during a delayed consumed-approver read",
  "claim fences unchanged defaults committed during a delayed consumed-approver read",
  "claim fences insert default policy committed during a delayed consumed-approver read",
  "claim fences insert default environment committed during a delayed consumed-approver read",
  "claim fences insert foreign environment committed during a delayed consumed-approver read",
  "refuses an already foreign globally keyed environment before prepare",
  "refuses an already foreign globally keyed environment before claim",
  "prepare resolves unchanged after an exact observed operation-row lock waiter",
  "prepare resolves removed requester after an exact observed operation-row lock waiter",
  "prepare resolves demoted approver after an exact observed operation-row lock waiter",
  "claim resolves unchanged after an exact observed operation-row lock waiter",
  "claim resolves removed requester after an exact observed operation-row lock waiter",
  "claim resolves demoted approver after an exact observed operation-row lock waiter",
  "prepare authority abort rolls back and a late member answer cannot commit",
  "claim authority abort rolls back and a late member answer cannot commit"
];
const WORKFLOW_INTENT_TEMPORAL_CASES = [
  "independent SQL workers and SDK connections commit one exact accepted start and retain the same completed execution",
  "accepted start followed by connection loss is recovered by an independent reader without another Start RPC",
  "SQL claim commit acknowledgement loss prevents transport and remains unconfirmed when Temporal has no execution",
  "a prepared-intent commit acknowledgement loss recovers that same row and permits only its first authorized transport",
  "an accepted start whose readback cannot be committed recovers the retained original, never a new execution",
  "foreign legacy execution with the same workflow ID is refused rather than adopted or restarted",
  "mutated argument, type, namespace or queue requests cannot replace the retained writer",
  "actual Temporal original with wrong type cannot acknowledge a retained attempt",
  "actual Temporal original with wrong arguments cannot acknowledge a retained attempt",
  "actual Temporal original with wrong memo cannot acknowledge a retained attempt",
  "actual Temporal raw Start with priority key is not the retained canonical configuration",
  "actual Temporal raw Start with fairness key is not the retained canonical configuration",
  "actual Temporal raw Start with fairness weight is not the retained canonical configuration",
  "actual Temporal raw Start with enabled time skipping is not the retained canonical configuration",
  "actual Temporal raw Start with disabled propagation is not the retained canonical configuration",
  "actual Temporal raw Start with skip-count override is not the retained canonical configuration",
  "actual Temporal raw Start with continued failure is not the retained canonical configuration",
  "actual Temporal raw Start with last completion result is not the retained canonical configuration",
  "actual Temporal raw Start with explicit parentless priority and disabled time-skipping defaults confirms the same original",
  "real PostgreSQL final lock waiter unchanged permits only a fresh canonical Temporal dispatch",
  "real PostgreSQL final lock waiter demoted approver permits only a fresh canonical Temporal dispatch",
  "real PostgreSQL final lock waiter raised approval count permits only a fresh canonical Temporal dispatch",
  "real PostgreSQL final lock waiter current policy deny permits only a fresh canonical Temporal dispatch",
  "retention-equivalent deletion of this owned closed Temporal history preserves the SQL tombstone and never authorizes replay",
  "encrypted original input and memo round-trip through the configured codecs on independent readers",
  "cancelled operation keeps an exact late accepted-start receipt and denies a new attempted writer",
  "current role or policy revocation refuses a prepared intent before any Temporal Start call"
];
const WORKFLOW_INTENT_WIRE_MODELS = [
  "pinned raw response model omitted accepts defaults without another Start",
  "pinned raw response model null accepts defaults without another Start",
  "pinned raw response model empty nested messages accepts defaults without another Start",
  "pinned raw response model explicit zero knobs accepts defaults without another Start",
  "pinned raw response model documented unit fairness weight accepts defaults without another Start",
  "pinned raw response model eager acceptance refuses confirmation without another Start",
  "pinned raw response model priority key refuses confirmation without another Start",
  "pinned raw response model fairness key refuses confirmation without another Start",
  "pinned raw response model fairness weight refuses confirmation without another Start",
  "pinned raw response model time skipping enabled refuses confirmation without another Start",
  "pinned raw response model empty fast-forward wrapper refuses confirmation without another Start",
  "pinned raw response model propagation disabled refuses confirmation without another Start",
  "pinned raw response model skip-count override refuses confirmation without another Start",
  "pinned raw response model propagated skipped seconds refuses confirmation without another Start",
  "pinned raw response model propagated skipped nanos refuses confirmation without another Start",
  "pinned raw response model invalid duration cancelling to zero refuses confirmation without another Start",
  "pinned raw response model propagated skip count refuses confirmation without another Start",
  "pinned raw response model empty fast-forward target wrapper refuses confirmation without another Start",
  "pinned raw response model declined unversioned target wrapper refuses confirmation without another Start",
  "pinned raw response model empty continued-failure wrapper refuses confirmation without another Start",
  "pinned raw response model empty last-completion-result wrapper refuses confirmation without another Start"
];
const DEFAULT_CURRENT_MEMBERSHIP_CASES = [
  "same owning current requester and approver permit one canonical signed claim",
  "the same cached broker refuses a demoted requester without a snapshot fallback",
  "the same cached broker refuses a deleted requester without a snapshot fallback",
  "missing hosted member bob receives no empty-workspace or local authority",
  "missing hosted member local receives no empty-workspace or local authority",
  "a cached requester approval cannot survive a demoted consumed human approver",
  "a cached requester approval cannot survive a deleted consumed human approver",
  "a demoted requester cannot claim an already approved operation",
  "a deleted requester cannot claim an already approved operation",
  "current membership response error refuses before proposal authority or privileged fallback",
  "current membership thrown error refuses before proposal authority or privileged fallback",
  "current membership foreign workspace refuses before proposal authority or privileged fallback",
  "current membership foreign human refuses before proposal authority or privileged fallback",
  "current membership unsupported role refuses before proposal authority or privileged fallback",
  "a real eight-second role deadline refuses late successful modeled PostgREST completion on the cached broker",
  "integration authority retains credential scope and target attenuation while rereading its human",
  "a revoked integration credential cannot be restored by current admin membership",
  "a expired integration credential cannot be restored by current admin membership",
  "a foreign workspace integration credential cannot be restored by current admin membership",
  "a missing integration credential cannot be restored by current admin membership",
  "system principals remain nonmembers governed by canonical policy, never human approvers"
];
const RECONCILIATION_REQUIREMENTS = [
  ...RECONCILE_SCHEDULE_CASES.map(test => ({file:"tests/workflows/reconcile-schedule.test.ts",suite:"durable schedule on an actual isolated Temporal service",test,backend:"postgres"})),
  ...RECONCILE_COMPOSITION_CASES.map(test => ({file:"tests/workers/reconcile-composition.test.ts",suite:"actual default activity composition: PostgreSQL and owned durable Temporal",test,backend:"postgres"})),
];
const WORKFLOW_INTENT_POSTGRES_REQUIREMENTS = [
  ...WORKFLOW_INTENT_SQL_CASES.map(test=>({file:WORKFLOW_INTENT_SQL_FILE,suite:"workflow start intents [postgres]",test,postgres:true})),
  ...WORKFLOW_INTENT_PRIVILEGE_CASES.map(test=>({file:WORKFLOW_INTENT_SQL_FILE,suite:"workflow start tombstone privileges [postgres]",test,postgres:true})),
  ...WORKFLOW_INTENT_AUTHORITY_CASES.map(test=>({file:WORKFLOW_INTENT_AUTHORITY_FILE,suite:"workflow start final authority [postgres]",test,postgres:true})),
];
const DEFAULT_CURRENT_MEMBERSHIP_REQUIREMENTS = DEFAULT_CURRENT_MEMBERSHIP_CASES.map(test=>({
  file:CURRENT_MEMBERSHIP_FILE,suite:"cached default broker current membership [postgres; modeled product reads]",test,backend:"postgres",
}));
// Real Temporal replay with scripted activities; these do not claim provider effects.
const WORKFLOW_INTENT_REPLAY_REQUIREMENTS = [
  {
    "file": "tests/workflows/replay.test.ts",
    "suite": "replaying histories recorded by the current workflows",
    "test": "deploy: happy path"
  },
  {
    "file": "tests/workflows/replay.test.ts",
    "suite": "replaying histories recorded by the current workflows",
    "test": "deploy: approval wait, signal, and a second lease"
  },
  {
    "file": "tests/workflows/replay.test.ts",
    "suite": "replaying histories recorded by the current workflows",
    "test": "deploy: a failure path (lease lost during apply)"
  },
  {
    "file": "tests/workflows/replay.test.ts",
    "suite": "replaying histories recorded by the current workflows",
    "test": "deploy: cancellation mid-flight"
  },
  {
    "file": "tests/workflows/replay.test.ts",
    "suite": "replaying histories recorded by the current workflows",
    "test": "deploy: retried reads (activity attempts do not disturb replay)"
  },
  {
    "file": "tests/workflows/replay.test.ts",
    "suite": "replaying histories recorded by the current workflows",
    "test": "day-two, remediation and reconcile"
  },
  {
    "file": "tests/workflows/replay.test.ts",
    "suite": "the replay check has teeth",
    "test": "the same history is rejected by a workflow that schedules its activities in a different order"
  },
  {
    "file": "tests/workflows/codec-replay.test.ts",
    "suite": "codec histories on local Temporal (ZENITH_TEST_TEMPORAL=1)",
    "test": "encrypts workflow/activity payloads, supports queries/signals and replays with retained keys"
  },
  {
    "file": "tests/workflows/codec-replay.test.ts",
    "suite": "codec histories on local Temporal (ZENITH_TEST_TEMPORAL=1)",
    "test": "replays a legacy plaintext history with an encrypted converter"
  },
  {
    "file": "tests/workflows/destroy-replay.test.ts",
    "suite": "real destroy workflow histories (ZENITH_TEST_TEMPORAL=1)",
    "test": "happy runs and replays against the current definitions"
  },
  {
    "file": "tests/workflows/destroy-replay.test.ts",
    "suite": "real destroy workflow histories (ZENITH_TEST_TEMPORAL=1)",
    "test": "plan_changed runs and replays against the current definitions"
  },
  {
    "file": "tests/workflows/destroy-replay.test.ts",
    "suite": "real destroy workflow histories (ZENITH_TEST_TEMPORAL=1)",
    "test": "lease_lost runs and replays against the current definitions"
  },
  {
    "file": "tests/workflows/destroy-replay.test.ts",
    "suite": "real destroy workflow histories (ZENITH_TEST_TEMPORAL=1)",
    "test": "approval_reject runs and replays against the current definitions"
  },
  {
    "file": "tests/workflows/destroy-replay.test.ts",
    "suite": "real destroy workflow histories (ZENITH_TEST_TEMPORAL=1)",
    "test": "unknown_absence runs and replays against the current definitions"
  },
  {
    "file": "tests/workflows/destroy-replay.test.ts",
    "suite": "real destroy workflow histories (ZENITH_TEST_TEMPORAL=1)",
    "test": "preserves and replays the deploy command sequence"
  }
];
const WORKFLOW_INTENT_REQUIREMENTS = [
  ...WORKFLOW_INTENT_POSTGRES_REQUIREMENTS,
  ...WORKFLOW_INTENT_TEMPORAL_CASES.map(test=>({file:WORKFLOW_INTENT_TEMPORAL_FILE,test,backend:"postgres"})),
  // Supplemental wire models cannot match any actual scenario's exact title.
  ...WORKFLOW_INTENT_WIRE_MODELS.map(test=>({file:WORKFLOW_INTENT_TEMPORAL_FILE,test})),
  {file:WORKFLOW_INTENT_SQL_FILE,test:"test-only captured broker authority is unavailable in production at creation and invocation"},
  ...["own scalar snapshot rejects accessors before store or SDK and strips extra serialization hooks","production start refuses missing durable store and test seam is unavailable in production"]
    .map(test=>({file:WORKFLOW_INTENT_TEMPORAL_FILE,test})),
  ...WORKFLOW_INTENT_REPLAY_REQUIREMENTS,
];

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
    excludeFiles: ["tests/workflows/mtls-live.test.ts", CODEBUILD_POSTGRES_FILE, WORKFLOW_INTENT_TEMPORAL_FILE],
    env: { ZENITH_COMPOSE_TEMPORAL_MODE: "time-skipping", ZENITH_TEST_TEMPORAL_DOWNLOAD: "1", ZENITH_SEC_TEMPORAL: "1", ZENITH_TEST_TEMPORAL: "1", ZENITH_TEST_SOURCE_GITHUB: "1", ZENITH_TEST_SOURCE_REPO: "https://github.com/GODOSTROYER/zenith", ZENITH_TEST_SOURCE_REF: "37be7340536ccb68ae4bb49294e8ab3799d1f01b" },
    report: ".data-ci-lane/workflows-lane.json",
    prerequisites: ["Node 22.23.3", "npm ci --ignore-scripts", "Temporal CLI 1.9.1 at ZENITH_TEST_TEMPORAL_CLI", "Local Temporal dev and time-skipping servers; SDK test-server cache or download access", "Public GitHub codeload access for the immutable source fixture"],
    tools: { node: "22.23.3", temporal: "1.9.1" },
  },
  reconciliation: {
    files:["tests/workflows/reconcile-schedule.test.ts","tests/workers/reconcile-composition.test.ts"],
    env:{ZENITH_TEST_TEMPORAL:"1",ZENITH_TEST_TEMPORAL_DOWNLOAD:"0",ZENITH_TEST_RECONCILE_SCHEDULE:"1",ZENITH_TEST_RECONCILE_COMPOSITION:"1"},
    report:".data-ci-lane/reconciliation-lane.json",
    prerequisites:["Node 22.23.3","npm ci --ignore-scripts","PostgreSQL 16.15: fresh owned loopback database at ZENITH_TEST_PLATFORM_PG_URL","Platform migrator applied/current via scripts/ci/apply-platform-migrations.sh","Temporal CLI 1.9.1 at ZENITH_TEST_TEMPORAL_CLI; owned durable SQLite dev servers, no ambient frontend or test-server download","Committed policy/dist WASM and manifest hash checked; canonical in-process OPA loader"],
    tools:{node:"22.23.3",postgres:"16.15",temporal:"1.9.1"},
  },
  "workflow-intents": {
    files:[WORKFLOW_INTENT_SQL_FILE,WORKFLOW_INTENT_AUTHORITY_FILE,WORKFLOW_INTENT_TEMPORAL_FILE,"tests/workflows/replay.test.ts","tests/workflows/codec-replay.test.ts","tests/workflows/destroy-replay.test.ts"],
    env:{ZENITH_TEST_TEMPORAL:"1",ZENITH_TEST_TEMPORAL_DOWNLOAD:"1",ZENITH_TEST_WORKFLOW_START_REQUIRED:"1"},
    report:".data-ci-lane/workflow-intents-lane.json",
    prerequisites:["Node 22.23.3","npm ci --ignore-scripts","PostgreSQL 16.15 at ZENITH_TEST_PLATFORM_PG_URL; owned scratch CREATEDB and test-role administration","Platform migration12 registered/applied/current via scripts/ci/apply-platform-migrations.sh","Temporal CLI 1.9.1 at ZENITH_TEST_TEMPORAL_CLI; owned persistent local servers for new outbox cases; unchanged historical destroy replay also needs SDK time-skipping cache/binary or existing permitted download policy (ZENITH_TEST_TEMPORAL_DOWNLOAD=1, optional ZENITH_TEST_TEMPORAL_SERVER)","Committed policy/dist WASM and manifest hash checked; product REST/directory/policy fixtures remain explicit models"],
    tools:{node:"22.23.3",postgres:"16.15",temporal:"1.9.1"},
  },
  "platform-postgres": {
    files: ["tests/controlplane", "tests/capabilities", "tests/runners", "tests/reconcile/platform.test.ts", "tests/tofu/plan-artifact-handoff.test.ts", "tests/security/plan-artifact-secrecy.test.ts", "tests/execution/destroy-review.test.ts", "tests/execution/apply.test.ts", "tests/platform/plan-approval.test.ts", ECS_REPLICA_REPAIR_FILES.grants, CODEBUILD_POSTGRES_FILE, "tests/sources/github-store.test.ts", "tests/sources/github-webhook.test.ts", "tests/platform/approved-source-runtime.test.ts", "tests/platform/composition.test.ts", "tests/platform/source-bundle-composition.test.ts", "tests/platform/source-bundle-github.test.ts", "tests/platform/source-bundle-azure.test.ts"],
    env: { ZENITH_FAST: "1", ZENITH_TEST_TOFU_NETWORK: "1", ZENITH_TEST_WORKFLOW_START_REQUIRED: "1", ZENITH_TEST_DEFAULT_CURRENT_MEMBERSHIP_REQUIRED: "1", ZENITH_TEST_APPROVED_SOURCE_REQUIRED: "1", ZENITH_TEST_APPROVED_SOURCE_RUNTIME_REQUIRED: "1", ZENITH_TEST_PLAN_SOURCE_AUTHORITY_REQUIRED: "1", ZENITH_TEST_SOURCE_FIXTURE_REQUIRED: "1", ZENITH_TEST_SOURCE_PLAN_EVIDENCE_REQUIRED: "1" }, report: ".data-ci-lane/platform-lane.json",
    prerequisites: ["Node 22.23.3", "npm ci --ignore-scripts", "PostgreSQL 16.15", "pg_dump and pg_restore of the same full client version and server major (optional absolute ZENITH_TEST_PG_DUMP_BIN / ZENITH_TEST_PG_RESTORE_BIN overrides)", "ZENITH_TEST_PLATFORM_PG_URL points to the real test database", "Platform migrations applied with scripts/ci/apply-platform-migrations.sh (canonical schema13 is mandatory before every plan review)", "ZENITH_TEST_APPROVED_SOURCE_REQUIRED=1; actual PostgreSQL source/custody scenarios cannot skip", "ZENITH_TEST_APPROVED_SOURCE_RUNTIME_REQUIRED=1; default owning runtime persistence requires actual PostgreSQL and canonical schema13", "ZENITH_TEST_PLAN_SOURCE_AUTHORITY_REQUIRED=1; final original-plan source admission requires actual PostgreSQL, canonical schema13 and pinned OpenTofu", "ZENITH_TEST_SOURCE_FIXTURE_REQUIRED=1; native source composition fixtures require actual PostgreSQL and canonical schema13", "ZENITH_TEST_SOURCE_PLAN_EVIDENCE_REQUIRED=1; original stage evidence authority requires actual PostgreSQL and canonical schema13", "OpenTofu 1.12.5 at ZENITH_TOFU_BIN", "ZENITH_TEST_TOFU_NETWORK=1", "Provider registry network access and writable plugin cache"],
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
        .filter((file) => file !== CODEBUILD_POSTGRES_FILE && file !== WORKFLOW_INTENT_TEMPORAL_FILE)
        .flatMap((file) => file === "tests/platform/source-bundle.test.ts"
          ? ["source acquisition and canonical archives", "customer source bucket uploads", "GCS source upload through authorizedFetch", "live public GitHub source (opt-in network)"].map((suite) => ({ file, suite }))
          : [{ file }]);
      requirements.push(...ECS_REPLICA_REPAIR_WORKFLOW_REQUIREMENTS, ...BUILD_WORKFLOW_REQUIREMENTS);
      break;
    case "reconciliation":
      requirements = RECONCILIATION_REQUIREMENTS;
      break;
    case "workflow-intents":
      requirements = WORKFLOW_INTENT_REQUIREMENTS;
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
      requirements.push(...BOUND_BUILD_POSTGRES_CASES);
      requirements.push(...["fresh", "same-owner schema6"].map(mode => ({
        file: "tests/controlplane/migrations.test.ts", suite: "migrator [postgres] concurrency and fail-closed open",
        test: `${mode} canonical migrations keep permanent agent receipts select/insert-only`, postgres: true,
      })));
      requirements.push(...AGENT_EFFECT_POSTGRES_REQUIREMENTS);
      requirements.push(...BUILD_SOURCE_POSTGRES_REQUIREMENTS, GITHUB_WEBHOOK_POSTGRES_REQUIREMENT, ...GITHUB_WEBHOOK_POSTGRES_CASES);
      // Discovery above remains; these named cases survive source deletion.
      requirements.push(...WORKFLOW_INTENT_POSTGRES_REQUIREMENTS,...DEFAULT_CURRENT_MEMBERSHIP_REQUIREMENTS,...APPROVED_SOURCE_POSTGRES_REQUIREMENTS,...PLAN_SOURCE_AUTHORITY_POSTGRES_REQUIREMENTS,...SOURCE_FIXTURE_POSTGRES_REQUIREMENTS,...SOURCE_PLAN_EVIDENCE_POSTGRES_REQUIREMENTS);
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
    console.error("usage: node scripts/ci/gate-manifest.mjs [fresh|core|postgres|policy|tofu|workflows|reconciliation|workflow-intents|platform-postgres|linux-guest|external-acceptance]");
    return 2;
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) process.exitCode = main(process.argv.slice(2));

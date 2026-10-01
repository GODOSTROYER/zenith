# Builds from source

Written against branch `ws/docs-sync-2`, based on `ws/integrate-w6` at `3c1fa66` (2026-10-01).
Image pinning and its guard updated on `ws/image-pins` (2026-10-01).
Azure source storage, broker audience and default composition updated by `WS-AZURE-SOURCE-WIRE` (2026-10-01).

Customer repository code runs in the provider's build service, not in the
control-plane or worker process. The worker downloads, validates and packages
source, then records source/build identifiers and the resulting image digest.
All paths below have contract evidence only; no live build or registry push was
verified here.

## Source and integrity

Use a GitHub repository and explicit `source.ref`; pin a commit SHA for repeatable
operation. `createSourceBundles` in `src/lib/platform/source-bundle.ts` reads the
archive bytes rather than the lossy repository-analysis snapshot. Files are
sorted, timestamps and ownership normalized, binary contents and executable
intent preserved. Unsafe paths, links, duplicate entries, oversized archives
and missing requested Dockerfiles are refused. The digest is SHA-256 of the
canonical archive bytes, not a claim that a mutable branch is immutable.

Public GitHub archives are the default source. Private repositories require
the tenant-scoped GitHub App source binding described below. C3's default
acquisition hook supplies the connector when App configuration and a workspace
binding are present; an explicit `withGithubAccess` override remains authoritative.
A download refusal produces no fake source bundle.
Repository text, Dockerfile paths and cloud responses are data, never worker
instructions; secrets must not be embedded in source or build diagnostics.

For built artifacts, the service must name a matching managed build pipeline
and container registry in its provider/region. Missing build/source ports refuse
execution (`src/lib/execution/release.ts`). A successful build must return a
verified image digest and URI before release; dispatch or a bootstrap image is
not deployment evidence.

## GitHub App registration and workspace binding

The operator registers the App in GitHub; Zenith cannot register it on the
operator's behalf. Configure **Contents: read-only** (Metadata: read-only is
automatic), no additional repository or organization permissions, and disable
webhooks. Set both the **Setup URL** and the **Callback URL** to
`https://<zenith-origin>/api/platform/v1/github/callback`. Enable redirect on
installation update. Leave **Request user authorization during installation**
unchecked: Zenith performs an explicit OAuth redirect with PKCE after setup.
Use HTTPS outside loopback development and set the exact public
`ZENITH_PLATFORM_ORIGIN` on the web host.

Generate an RSA App private key and an OAuth client secret in GitHub. Mount
their files with access limited to the service account; do not put their contents
in the repository, manifest, workflow payload or environment-variable value.
Set `ZENITH_GITHUB_APP_ID` and `ZENITH_GITHUB_APP_PRIVATE_KEY_FILE` (absolute path)
on both web and worker hosts. Set `ZENITH_GITHUB_APP_CLIENT_ID` and
`ZENITH_GITHUB_APP_CLIENT_SECRET_FILE` (absolute path) on the web host only.
The worker does not need an OAuth client secret. See the configuration rows in
[DEPLOYING.md](DEPLOYING.md).

Apply the normal platform migrations against the **same platform database used by
web and worker** before rolling out the application:

```sh
npm run migrate:platform
npm run migrate:platform -- --status
```

Platform migration 6 (`github_sources`) includes the source-binding tables and
expiring install intents. Alternatively, re-apply the generated
`supabase/migrations/0014_platform_core.sql` as described in
[DEPLOYING.md](DEPLOYING.md#32-migrating). No separate GitHub schema installer is
required. Migration 6 is additive and idempotent: it preserves tables and rows
from earlier manual installations and records its checksum in the platform ledger.
The old `src/lib/sources/github/migrate.ts` command remains a compatibility
entrypoint that now applies the normal platform migrations. Runtime requests never
run GitHub schema DDL; a Postgres ledger behind migration 6 fails closed before
source access. A failed database read refuses source access rather than silently
switching a configured workspace to anonymous access.
Production uses shared Postgres; a PGlite directory still belongs to one process.

As a signed-in **workspace admin**, select the workspace, then choose **GitHub source**
in the Platform navigation (opens `/api/platform/v1/github/callback` in the browser).
Enter `owner/repository`, install the App for that repository and authorize the
GitHub user-access check. This
single endpoint serves the form, starts installation via a same-origin POST,
handles GitHub's setup redirect, and exchanges the OAuth code server-side.
The binding saves only workspace, App, installation and repository identifiers.
No access token is sent to the browser, stored, logged or placed in a URL.

The installation ID in the setup query is untrusted: Zenith verifies that the
GitHub user can access the requested repository in that installation, then
checks the installation with the App JWT. State is hashed in SQL, expires after
ten minutes, and is bound to the initiating human, selected workspace and a
protected browser PKCE cookie. Each phase is single-use. A changed binding
version refuses an older competing flow; restart after any failed callback.
The user-access check is capped at 1,000 repositories. This follows GitHub's
[setup URL security guidance](https://docs.github.com/en/apps/creating-github-apps/registering-a-github-app/about-the-setup-url).

At acquisition, an RS256 App JWT (issued 60 seconds in the past, expires within
ten minutes) checks installation membership, then requests an installation token
with exactly one `repository_ids` entry and `contents: read`. Token receipt
scope and expiration are checked. The token is passed to C3's archive request
in the initial Authorization header, omitted from redirects, and discarded
after the callback. No token cache or anonymous retry of failed private access
exists. Public downloads need no App configuration; an unbound workspace or an
unscoped standalone reader uses anonymous access. A bound workspace refuses a
different repository. App removal, suspension or repository removal is checked
again on acquisition. See GitHub's
[installation token contract](https://docs.github.com/en/rest/apps/apps#create-an-installation-access-token-for-an-app).

Limits: one repository binding per workspace; reconnecting replaces it. The
form is at the endpoint above and linked from Platform navigation. There is no
uninstall webhook or unbind UI. The connector uses GitHub.com, not Enterprise Server. Standalone private readers must inject
an explicitly workspace-bound callback. Authorization, archive transport and
production Postgres behavior have **not** been verified against live GitHub or
production services here. OAuth callback codes and state arrive in query strings;
configure ingress/access logs to redact them and disable credential/body tracing.

Verification: the default suites mock GitHub HTTP and Supabase identity; store
contracts use PGlite. The Postgres lane is gated by `ZENITH_TEST_PLATFORM_PG_URL`.
An explicit private archive check is gated by `ZENITH_TEST_SOURCE_GITHUB_APP=1`:
set App credentials on the test host, `ZENITH_TEST_SOURCE_REF` to a 40-hex commit,
and `ZENITH_TEST_SOURCE_GITHUB_BINDING` to a JSON object containing only
`workspaceId`, `owner`, `repo`, `appId`, `installationId`, `repositoryId` and
`version`. Run only against a test installation after authorizing network use.
Neither that lane nor the existing public network check was run in this sandbox.

## Provider paths

| Provider | Source transport and build | Current operational limit |
|---|---|---|
| AWS | Deterministic **ZIP**, uploaded to the customer's tagged S3 source bucket. CodeBuild uses native `S3` source and the exact object key; image output goes to ECR. | Pipeline and bucket ownership/account/region are checked before upload. No live CodeBuild acceptance. |
| GCP | Deterministic **tar.gz**, uploaded to the pipeline's GCS bucket, then Cloud Build uses `storageSource` and publishes to Artifact Registry. | Upload identity/size/integrity and scope are checked. No live Cloud Build acceptance. |
| Azure | Deterministic **tar.gz** uploaded by C3 to a bound customer Blob container. Build start rereads and hashes that object, uploads the verified bytes to ACR's short-lived Blob SAS URL, then schedules a `DockerBuildRequest` in the customer registry. | Default composition supplies preparation, stored-source reading and the durable launch journal. A trusted environment storage binding is required. The broker requests the Storage audience for exactly the trusted account host and refuses redirects. No live Azure build acceptance. |
| Kubernetes | Pre-built image digests; owned Deployment/StatefulSet image rollout and migration Jobs are wired into release dispatch. | The default build port refuses source builds. Supply an image pinned by SHA-256, or explicitly inject external build and source ports. Contract evidence only. |
| OCI | Build port explicitly refuses: bring a pre-built OCIR image pinned to a SHA-256 digest. | Runner-backed release ports verify the manifest image applied by OpenTofu and wait for ACTIVE replicas; one-off migrations use trusted runner-created bindings and durable execution receipts. No OCI DevOps build or live acceptance. |
| Zenith-managed | No source-build release adapter in the default composed worker. | Supply an existing image supported by the relevant path; do not infer source-build readiness from driver registration or the separate hosted-apps builder. |

AWS's assembler uploads with `application/zip`, expected bucket owner, checksum
and create-only semantics. An existing key must match its size/checksum. GCP
uploads with `application/gzip` and a generation precondition; an existing
object is checked against the bundle. Both use scoped, digest-addressed keys
(`src/lib/platform/source-bundle.ts`). CodeBuild's S3 source configuration is in
`src/lib/providers/aws/drivers/compute/codebuild-project.ts`; Cloud Build's
storage source is in `src/lib/providers/gcp/drivers/build/build-api.ts`.

Default Azure composition passes C3's `readAzureSource` to `createReleasePorts`
as `azure.readSource`. The same C3 preparation call dispatches AWS ZIP and
GCP/Azure tar.gz. Azure returns only the digest, scoped object key, account/container
identifier and unsigned object URI. Build start reads the stored bytes, not the
GitHub ref again, and must match the recorded SHA-256. This avoids changing build
input when a branch moves between preparation and launch. Explicit legacy
`azure.sourceBundles`/`createAzureSourceBundlePort` overrides remain available;
those reread the repository and refuse a changed digest.

The worker and app share `createAzureSourceStorageResolver`. Operators must add
non-secret `AzureConnectionConfig.sourceStorage[environmentId]` metadata to the
verified environment connection:

```json
{
  "accountResourceId": "/subscriptions/<subscription>/resourceGroups/<group>/providers/Microsoft.Storage/storageAccounts/<account>",
  "container": "source-bundles",
  "resourceAddress": "object_store/build-source",
  "cloud": "public"
}
```

The environment must be registered in `platform.reconcile_state` with that
connection. The resolver checks the workspace, environment, verified Azure
connection, subscription, region and current managed resource identity. A
resource-scoped credential grant cannot borrow another resource's binding.
Account/container metadata comes from this trusted connection configuration,
never a manifest, model, state backend or another environment. Missing bindings
refuse before GitHub acquisition or Blob writes. Creating infrastructure may
proceed before the source account exists; Blob access remains disabled until the
binding matches the owned account. The explicit
`ComposeExecutionOptions.sourceBundles.azureStorage` override remains available
for trusted composition and contract tests, with the same ARM checks.

`src/lib/providers/azure/release/source-storage.ts` verifies the ARM account's
workspace/environment/resource/managed tags, subscription, region, endpoint and
Entra-only private posture, then the exact private container identity. Blob keys
are `zenith/<environment>/<service>/<sha256>.tar.gz`. Uploads use `Put Blob`,
create-only `If-None-Match: *` and transport MD5; both new and existing objects
are reread and checked for SHA-256 and size. The reader caps streamed and declared
lengths at C3's 32 MiB compressed ceiling (or a lower injected ceiling), checks
empty/truncated responses, and bounds stalled requests and body reads.
See Microsoft's [Put Blob contract](https://learn.microsoft.com/en-us/rest/api/storageservices/put-blob).

All customer Blob calls use the current broker session's `authorizedFetch`, request
`redirect: "error"`, reject redirected/foreign response URLs, and supply no bearer.
`src/lib/providers/azure/credentials.ts` exchanges a token for the Storage audience
`https://storage.azure.com/.default`; an ARM token is never sent to Blob Storage.
Only the exact trusted `<account>.blob.core.windows.net` host is allowed, over
HTTPS on its default port. `cloud: "usgov"` and `cloud: "china"` select exact
`<account>.blob.core.usgovcloudapi.net` and
`<account>.blob.core.chinacloudapi.cn` hosts respectively. Lookalikes, another
account/cloud, extra labels, credentials in the URL and redirects are refused.
Token exchange also refuses redirects. These host contracts do not add sovereign
Entra authority/ARM support; the complete session remains public-cloud only.
The worker identity needs container-scoped Blob data read/write permission and
network reachability to the customer account. These are requirements, not
verified permissions or live acceptance. The source transport never exchanges
credentials itself.

`src/lib/providers/azure/release/build.ts` and
`src/lib/providers/azure/release/acr-task.ts` implement the ACR contract. The SAS URL
stays inside the call, goes only to the validated plain upload transport and
never receives the broker's ARM bearer. A consumed launch key without a receipt
is unknown and is not launched again automatically; investigate the ACR run.

## Bootstrap and release

### OCI images and migrations

`src/lib/platform/release-oci.ts` is selected by `createReleasePorts` for OCI.
Source-build start/wait refuse clearly; there is no OCI DevOps build adapter.
Use an image such as `iad.ocir.io/<namespace>/<repo>@sha256:<64 hex digits>`.
OCI does not support changing `imageUrl` with UpdateContainer or
UpdateContainerInstance; pin the digest in the manifest, then approve and apply
the OpenTofu replacement. The release port reads every replica/container through
`oci.http`, checks workspace/environment/compartment ownership and the digest,
and waits for all expected instances and containers to be ACTIVE. ACTIVE is
provider lifecycle evidence, not a live application health acceptance test.

`src/lib/providers/oci/release/migrations.ts` creates one private instance from
the workload's supported single-container template and VNIC, preserving subnet,
NSGs, manifest env and Vault OCID pointers. It passes argv directly and disables
container restarts (`NEVER`). A stable retry token and `zenith_release` tag bind
the execution to its workspace, environment, operation, service, image and argv.
Observed executions are recovered without re-launching. Completion requires an
observed INACTIVE container and integer exit code; timeouts and lost responses
remain unknown. Cloud diagnostics and raw container logs are suppressed; the
driver emits only a fixed exit-code summary. No logs reference is fabricated.

The runner's local `resourceCompartments` map must bind the workload instance,
container, VNIC, subnet, NSGs and Vault pointers. The runner learns newly created
migration instance/container bindings only from validated OCI create responses. Migrations share the workload's identity tags and need
customer IAM that actually grants the same exact-resource access; that path is
unverified. Extra volumes, registry pull secrets and security overrides refuse.
Finished one-off migrations, including nonzero exits, request cleanup through a
DELETE restricted to the runner-created instance and its signed workspace, operation
and migration key. Running, timed-out or unproven instances remain untouched.
The runner appends and fsyncs durable intents and terminal receipts beside its audit
file (`<auditPath>.oci-receipts`); preserve that journal and use the same runner
for retries. Receipts keep completed outcomes after deletion. Lost create responses
remain explicitly unknown and never trigger another launch. Cleanup failure preserves
the observed exit and reports unknown cleanup; an accepted DELETE proves only a
delete request, not completed deletion. No receipt pruning policy is added. All of
this has synthetic contract evidence only.
See [OCI runner release rules](../RUNNER-PROTOCOL-OCI.md).

### Other provider releases

GCP Cloud Run uses fixed service/job image digests
(`src/lib/providers/gcp/drivers/compute/run-image.ts`). Azure Container Apps/jobs
use a fixed bootstrap digest and argv; release replaces both with the verified
ACR image (`src/lib/providers/azure/drivers/compute/workload.ts`). Their compilers
ignore only release-owned fields so a later OpenTofu apply keeps the release.
AWS ECS uses the deliberately nonexistent `zenith-bootstrap` tag until release,
not `:latest` (`src/lib/providers/aws/drivers/compute/ecs-task.ts`). Bootstrap
presence or health is never evidence that customer source was built or served.

## Build-tool image pins and exceptions

GCP's Docker build step uses the exported `CLOUD_BUILD_DOCKER_IMAGE` in
`src/lib/providers/gcp/drivers/build/build-api.ts`:
`gcr.io/cloud-builders/docker@sha256:40c2fb4fcd0ad51376eef166c2e7b2b40a3508d5776e2bf33db3783ab39d0f2e`.
The orchestrator resolved `gcr.io/cloud-builders/docker:latest` by public registry
HEAD on 2026-10-01; `Docker-Content-Digest` identified a single-platform Docker v2
manifest. The sandbox could not reach the registry. This records the supplied
manifest digest; an image pull or Cloud Build execution was not verified here.
The tag and resolution date remain in the constant's comment for future updates.

`tests/security/image-pins.test.ts` scans executable source and deployment files
under `src/lib/providers/` and `deploy/`, including generated image fields and
the Helm runner's repository/tag/appVersion combination. It rejects tag-only,
implicit-latest and malformed digest references outside the explicit allowlist.
Each exception has an exact file, reference, occurrence count and reason; removed,
changed or expanded matches fail. Comments, Markdown, API URLs and caller-supplied
image variables are not executable image pins. The static guard does not validate
arbitrary runtime values, customer Dockerfile bases or registry availability.

The exceptions are deliberately narrower than a claim that every image is pinned:

| Reference | Reason and follow-up |
|---|---|
| `aws/codebuild/standard:7.0` | AWS-managed curated CodeBuild image, selected by name; CodeBuild does not take a digest for curated images. See [AWS EC2 compute images](https://docs.aws.amazon.com/codebuild/latest/userguide/ec2-compute-images.html). |
| `zenith-runner:1.0.0` in the Helm chart | Unpublished; pin by digest at first release. The guard names and tracks the chart default. |
| AWS ECS `zenith-bootstrap` | Deliberately nonexistent placeholder until release writes the verified image digest. |
| Kubernetes dev-data `postgres:<version>` and `redis:7-alpine` | Existing dev-tier rendering outside this workstream's editable paths; orchestrator follow-up to pin supported versions. |
| Sandbox Compose `postgres:16-alpine`, `redis:7-alpine`, `minio/minio:latest`, `axllent/mailpit:latest` | Existing local export outside the editable paths; orchestrator follow-up to pin them. |
| Legacy AWS Terraform ECR `:latest` fallback | Existing export outside the editable paths; orchestrator follow-up to require a digest. |
| Azure ACR build-output `:latest` | Existing staging tag in `src/lib/providers/azure/acr-build.ts`, outside the editable paths; not a build-tool image. Orchestrator follow-up to use an immutable operation/source tag. |
| LocalStack Docker help command | Existing untagged `localstack/localstack` instructions; LocalStack is on hold and its files may not be edited. |

After release, inspect the operation's build evidence, source digest, image
digest and steady-state/verification outcome. Failed uploads, unconfirmed
launches, missing digests and unknown status remain failures or unknown; they
must not produce a successful release.

## Kubernetes releases

Set `artifact: { type: "image", ref: "<registry>/<repository>@sha256:<64 hex>" }`.
The Kubernetes build port explicitly requires a pre-built image; it never builds
customer code in the worker or simulates a successful build. An external builder
requires explicit `ComposeExecutionOptions.ports.build` and `.sourceBundle`
adapters; registry registration alone does not configure one.

`createReleasePorts` selects the Kubernetes adapters in
`src/lib/platform/release-k8s.ts`. Image release checks the namespace allowlist,
managed ownership, environment and resource address, then applies under field
manager `zenith` with `force: false`. It extracts the manager's full field set
before changing the image so probes, replicas and other managed fields survive.
UID/resourceVersion preconditions refuse stale writes. Steady waits check owned
Deployment/StatefulSet rollout status with a bounded deadline; missing state,
controller failure and timeouts never imply readiness. CronJob release is not
implemented by these ports. These adapters do not replace infrastructure apply
or supply the still-required durable OpenTofu state backend.

Migration Jobs copy the owned workload's pod settings, service account, resources,
security context, volumes and secret references. A single regular container is
required; command arguments are sent as an argv array, with existing args,
service probes and lifecycle hooks removed. The image must already be pinned.
Jobs have `backoffLimit: 0`, `restartPolicy: Never`, an active deadline and a
3600-second TTL after completion. Migration pods remove the workload's selector
labels so they do not serve application traffic; cluster NetworkPolicies must
explicitly allow the migration pods' database access. No policy bypass is added.

A resourceVersion-guarded workload annotation claims each deterministic Job
launch before creation. Retries recover that Job; a claimed Job that is absent,
including after TTL cleanup or an interrupted launch, is unknown and is never
automatically relaunched. The command is represented only by its digest in the
receipt. At most 128 receipts are retained per workload; reconcile operation
history before pruning receipts. Deleting the workload removes its retry history.
Only an observed terminated container exit code on a UID-owned Job pod completes
the migration. A bounded log tail is credential-pattern redacted and scrubs known
argv/inline environment values; the Job reference is returned as evidence.
The Kubernetes Job controller can still start duplicate pods during failures;
the migration itself must be idempotent. Multiple observed pods remain unknown.

The connection identity needs workload reads/patches, namespaced Job create/get,
pod list and pod-log read permissions. The ports do not grant RBAC. Tests use the
existing fake API server, providing contract evidence only. The real-cluster lane
is gated by `ZENITH_TEST_KIND=1` and `KUBECONFIG`; the release-specific test also
requires `ZENITH_TEST_KIND_RELEASE_IMAGE`, a pinned non-root image with `/bin/sh`.
It requires a disposable cluster and was not run in this sandbox. No live
Kubernetes release is claimed.

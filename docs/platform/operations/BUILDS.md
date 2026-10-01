# Builds from source

Written against branch `ws/docs-sync-2`, based on `ws/integrate-w6` at `3c1fa66` (2026-10-01).

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

Apply the core platform migrations first, then explicitly install the additive
source-binding tables against the **same platform database used by web and worker**:

```sh
npx tsx --env-file-if-exists=.env.local src/lib/sources/github/migrate.ts
```

The installer is idempotent and transactional. Runtime requests never run DDL.
This schema is currently separate from the platform migration ledger; integrating
`src/lib/sources/github/schema.ts` into that registry and emitted SQL is an
orchestrator follow-up. A missing table or failed database read refuses source
access rather than silently switching a configured workspace to anonymous access.
Production uses shared Postgres; a PGlite directory still belongs to one process.

As a signed-in **workspace admin**, select the workspace, then open
`/api/platform/v1/github/callback` in the browser. Enter `owner/repository`, install
the App for that repository and authorize the GitHub user-access check. This
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
form is at the endpoint above; a navigation link in the product settings is an
orchestrator follow-up. There is no uninstall webhook or unbind UI. The connector
uses GitHub.com, not Enterprise Server. Standalone private readers must inject
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
| Azure | Deterministic **tar.gz** through the shared reader, uploaded to ACR's short-lived Blob SAS URL, then a `DockerBuildRequest` is scheduled in the customer registry. | The build adapter and durable tenant-scoped launch journal exist, but default worker composition supplies neither the Azure source reader nor a provider-dispatched source preparation port. It refuses; operators cannot enable this with an environment variable alone. |
| OCI, Kubernetes, Zenith-managed | No source-build release adapter in the default composed worker. | Supply an existing image supported by the relevant path; do not infer source-build readiness from driver registration or the separate hosted-apps builder. |

AWS's assembler uploads with `application/zip`, expected bucket owner, checksum
and create-only semantics. An existing key must match its size/checksum. GCP
uploads with `application/gzip` and a generation precondition; an existing
object is checked against the bundle. Both use scoped, digest-addressed keys
(`src/lib/platform/source-bundle.ts`). CodeBuild's S3 source configuration is in
`src/lib/providers/aws/drivers/compute/codebuild-project.ts`; Cloud Build's
storage source is in `src/lib/providers/gcp/drivers/build/build-api.ts`.

Azure integration must pass the shared reader to `createReleasePorts` as
`azure.sourceBundles` and dispatch Azure preparation through
`createAzureSourceBundlePort`, retaining the AWS/GCP C3 port for those providers.
The reader runs again at build start and must match the recorded digest.
`src/lib/providers/azure/release/source.ts`,
`src/lib/providers/azure/release/build.ts` and
`src/lib/providers/azure/release/acr-task.ts` implement this contract. The SAS URL
stays inside the call, goes only to the validated plain upload transport and
never receives the broker's ARM bearer. A consumed launch key without a receipt
is unknown and is not launched again automatically; investigate the ACR run.

## Bootstrap and release

GCP Cloud Run uses fixed service/job image digests
(`src/lib/providers/gcp/drivers/compute/run-image.ts`). Azure Container Apps/jobs
use a fixed bootstrap digest and argv; release replaces both with the verified
ACR image (`src/lib/providers/azure/drivers/compute/workload.ts`). Their compilers
ignore only release-owned fields so a later OpenTofu apply keeps the release.
AWS ECS uses the deliberately nonexistent `zenith-bootstrap` tag until release,
not `:latest` (`src/lib/providers/aws/drivers/compute/ecs-task.ts`). Bootstrap
presence or health is never evidence that customer source was built or served.
This does not claim that every build-tool image is digest-pinned: GCP's Docker
builder step currently names `gcr.io/cloud-builders/docker` without a digest.

After release, inspect the operation's build evidence, source digest, image
digest and steady-state/verification outcome. Failed uploads, unconfirmed
launches, missing digests and unknown status remain failures or unknown; they
must not produce a successful release.

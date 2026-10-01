# Builds from source

Written against branch `ws/docs-sync-2`, based on `ws/integrate-w6` at `3c1fa66` (2026-10-01).
Image pinning and its guard updated on `ws/image-pins` (2026-10-01).

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
the injected, tenant-scoped `withGithubAccess` callback; default composition
does not supply a connector. A download refusal produces no fake source bundle.
Repository text, Dockerfile paths and cloud responses are data, never worker
instructions; secrets must not be embedded in source or build diagnostics.

For built artifacts, the service must name a matching managed build pipeline
and container registry in its provider/region. Missing build/source ports refuse
execution (`src/lib/execution/release.ts`). A successful build must return a
verified image digest and URI before release; dispatch or a bootstrap image is
not deployment evidence.

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

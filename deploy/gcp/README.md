# Zenith customer bootstrap for Google Cloud

An OpenTofu module you apply **once, with your own credentials**, in the GCP
project Zenith will manage. It creates the keyless trust Zenith uses
(ADR-0006), two service accounts, and the state bucket. Nothing in it
produces or stores a key, token or secret.

```
Zenith OIDC issuer ──JWT (sub = zenith:ws:<ws>:conn:<conn>, ≤ 5 min)──▶ STS
   └─▶ workload identity pool provider  (issuer, audience and subject pinned)
         └─▶ impersonate  zenith-observe  (read-only)
                          zenith-deploy   (mutating)   ──▶ access token ≤ 15 min
```

## What it creates

| Resource | Purpose |
|---|---|
| `google_iam_workload_identity_pool` + `_provider` | Trusts Zenith's OIDC issuer. `attribute_condition` is `assertion.sub == "zenith:ws:<workspace>:conn:<connection>"`, `allowed_audiences` is exactly `https://iam.googleapis.com/<provider path>`. |
| `google_service_account.observe` / `.deploy` | The two identities Zenith impersonates. No keys are created. |
| `google_service_account_iam_member` ×2 | `roles/iam.workloadIdentityUser` for the **single** federated subject (`principal://…/subject/<sub>`), not for the pool. |
| Role bindings (below) | Least privilege for each account. No primitive role (`owner`, `editor`, `viewer`). |
| `google_storage_bucket.state` | OpenTofu state: uniform access, public access prevention enforced, versioning, 7-day soft delete, noncurrent versions expire after 90 days, `force_destroy = false`. |
| `google_project_service` ×20 | The APIs Zenith's drivers use (skip with `enable_apis = false`). |

### Trust model

Stealing Zenith's database yields no cloud credential: there is none to steal.
A token is accepted only if **all** hold: the issuer is `zenith_issuer_uri`, the
audience is this provider's resource name, and the subject is exactly this
workspace and connection (`attribute_condition`, and again in the
`principal://` binding). Tokens for any other workspace or connection, signed
by the same issuer, are rejected by Google.

### Roles

`zenith-observe` (read-only; none of these can read a secret value, object or row):
`run.viewer`, `cloudsql.viewer`, `redis.viewer`, `pubsub.viewer`,
`secretmanager.viewer` (metadata only), `compute.viewer`, `dns.reader`,
`cloudscheduler.viewer`, `logging.viewer`, `monitoring.viewer`,
`cloudbuild.builds.viewer`, `serviceusage.serviceUsageConsumer`, plus the
custom role `zenithObserveExtras` (Artifact Registry / bucket / service
account / log bucket metadata reads).

`zenith-deploy`: `compute.networkAdmin`, `compute.securityAdmin`,
`compute.loadBalancerAdmin`, `servicenetworking.networksAdmin`, `run.admin`,
`cloudsql.admin`, `redis.admin`, `storage.admin`, `pubsub.admin`,
`artifactregistry.admin`, `cloudbuild.builds.editor`, `cloudscheduler.admin`,
`dns.admin`, `iam.serviceAccountAdmin`, `serviceusage.serviceUsageConsumer`,
`iam.serviceAccountUser`, plus:

* custom role `zenithSecretsManage`: create/manage secrets and **add**
  versions; it deliberately lacks `secretmanager.versions.access`, so the
  deploy account can write a secret but never read it;
* `resourcemanager.projectIamAdmin` **with an IAM condition** that limits it to
  granting/revoking `roles/logging.logWriter`, `roles/cloudsql.client` and
  `roles/cloudsql.instanceUser` (`modifiedGrantsByRole … hasOnly`). It cannot
  grant `owner`, `editor`, an admin role, or widen itself.

### Things to know (honest limits)

* **Both accounts are reachable by the same subject.** The subject names a
  workspace and connection, not a purpose; Zenith's broker decides whether a
  request is `observe` or `deploy`. If you need Google to enforce the split,
  create two Zenith connections (two applies of this module with different
  connection ids and `pool_id`/`provider_id`/account names).
* **`iam.serviceAccountUser` is project-wide unless you set
  `service_account_name_prefix`.** Deploying a Cloud Run service or scheduler
  job "as" a service account requires act-as. With a prefix, the binding is
  limited to accounts whose id starts with `<prefix>-`. The condition's
  resource-name format follows Google's documentation but was **not verified
  against a live project**; if it never matches, deploys fail closed
  (act-as denied) rather than open. Test with a prefix in a scratch project
  first.
* **`storage.admin` is project-wide** (Zenith creates buckets and sets bucket
  IAM). The state bucket is protected by its own settings (versioning,
  no public access, no force destroy), not by excluding the deploy account.
* **Validation status:** `tofu validate` passes against `hashicorp/google`
  8.5.0. The module has **not been applied** to a real project, so role
  sufficiency (the exact permission set a first deploy needs) is unverified; expect
  to adjust on the first real apply. This is recorded as `contract`-level
  evidence, like every other GCP piece.
* **State backend:** record this module's bucket as `stateBucket` on the GCP
  connection. `src/lib/tofu/backends.ts` derives a `gcs` block with prefix
  `zenith/<workspace>/<environment>`; the default OpenTofu workspace stores
  the object at `<prefix>/default.tfstate`. Authentication comes only from
  the session's short-lived `GOOGLE_OAUTH_ACCESS_TOKEN`; no credential file or
  inline token is emitted. Optional `stateKmsKey` is a Cloud KMS resource name
  (`projects/<project>/locations/<location>/keyRings/<ring>/cryptoKeys/<key>`)
  emitted as `kms_encryption_key`: server-side state encryption, not plan
  encryption. Grant the GCS service agent the necessary KMS permissions.
  Backend blocks/refusals have unit coverage and gated real
  `tofu init -backend=false` / `tofu validate` checks; actual state access,
  KMS permissions and locking remain unverified against Google. The
  orchestrator still needs to wire the execution compiler to this helper.
* **Org policies** (domain-restricted sharing, required bucket settings,
  disabled service-account key creation) are not managed here. The `allUsers`
  `run.invoker` binding Zenith compiles for a public web service behind the load
  balancer is blocked by domain-restricted sharing.

## Apply

```bash
gcloud auth application-default login          # your own credentials; Zenith never sees them
cp terraform.tfvars.example terraform.tfvars    # fill in the wizard's values
tofu init
tofu plan
tofu apply
tofu output -json connection                    # paste into Zenith
```

Variables: `project_id`, `region`, `zenith_issuer_uri`, `zenith_workspace_id`,
`zenith_connection_id` (required); `pool_id`, `provider_id`,
`state_bucket_name`, `enable_apis`, `service_account_name_prefix` (optional).
The `connection` output is the non-secret `GcpConnectionConfig` (plus
`stateBucket`).

## Remove

`tofu destroy` removes the trust and accounts. The state bucket has
`force_destroy = false`, so it is only deleted once empty; APIs are left
enabled (`disable_on_destroy = false`). Resources Zenith created in the
project are Zenith's to destroy first (`infrastructure.destroy`); this module
does not track them.

## Required APIs (if `enable_apis = false`)

`iam`, `iamcredentials`, `sts`, `cloudresourcemanager`, `serviceusage`,
`compute`, `run`, `sqladmin`, `redis`, `servicenetworking`, `storage`,
`pubsub`, `secretmanager`, `artifactregistry`, `containerscanning`,
`cloudbuild`, `cloudscheduler`, `dns`, `logging`, `monitoring`
(each `<name>.googleapis.com`).

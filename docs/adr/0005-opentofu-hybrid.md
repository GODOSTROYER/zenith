# ADR-0005 — OpenTofu for declarative lifecycle, native APIs for day two

Status: accepted (2026-09-30)

## Decision
- Persistent infrastructure (VPC, subnets, SGs, RDS, ElastiCache, S3, SQS,
  ECS cluster/services, ALB, ACM, Route53, IAM, …) is compiled to OpenTofu
  JSON (`.tf.json`) and executed by a pinned OpenTofu (1.12.5) with exact
  provider versions and a committed multi-platform `.terraform.lock.hcl`.
- `plan -out` → `show -json` → normalized plan → digest. Approval binds to
  the digest and the authenticated original binary. The production engine records
  its tenant, operation, source, configuration, backend, address map, lockfile
  and executable provenance in encrypted PostgreSQL custody. Another worker
  makes a separate fresh plan for drift/ownership checks, then applies the
  original private saved file. A changed digest or context requires new review;
  there is no fresh-file fallback.
- State lives in the customer's account (S3 backend with native lockfile,
  optional KMS client-side state encryption).
- Day-two operations (restart, scale now, logs, metrics, target health, SSM,
  invoke) use native SDK calls through drivers.
- tofu runs with an allowlisted environment only (brokered cloud creds,
  `TF_*` settings); the control plane's environment never reaches plugins.

## Consequences
Zenith does not reimplement cloud CRUD; plans are reviewable artifacts;
exports remain real, applyable IaC.


## Durable originals and recovery
Migration 7 separates immutable ciphertext and teardown source associations from
mutable use attempts. Publication commits the original and reviewed digest/evidence
together. A teardown review runs under a live claim and associates its original
with the separate immutable destroy proposal before any current-round human decision.
The source must complete with the destination ID/digest before destination use.

The canonical engine owns dispatch. It reevaluates current policy and human roles,
then SQL rechecks the exact validated approval IDs/count/round/digests and expiry,
alongside the destination claim and environment fence. A lost dispatch response or
crash after dispatch preserves uncertainty and prevents automatic replay. Policy or
fence revocation cannot atomically revoke a provider call already accepted.

`ZENITH_PLAN_ARTIFACT_KEY` is a dedicated 64-hex key, disjoint from every product
vault key. Previous artifact keys are decrypt-only. Existing `VaultCipher` supplies
encryption; artifact-specific authenticated data binds the complete manifest.
Plaintext exists only in private worker callbacks and exclusive `0600` attempt files.
No plan bytes enter Temporal results, operation JSON, evidence, URLs or logs.

Maintenance records logical expiry only. Ciphertext and historical local files remain
retained; physical purge, key retirement, immutable re-encryption and new retention
policies are separate work. Drain old workers, apply the canonical migration and
configure matching artifact keys/executable identity before starting new workers.
Old local-only plans lack producer provenance and require new review. Restore needs
the original PostgreSQL records, matching artifact/fingerprint keys, backend context,
lockfile and executable identity. Matching binary hashes do not independently attest
distribution origin; the packaged archive checksum remains the build boundary.

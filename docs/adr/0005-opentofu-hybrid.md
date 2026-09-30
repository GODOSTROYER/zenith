# ADR-0005 — OpenTofu for declarative lifecycle, native APIs for day two

Status: accepted (2026-09-30)

## Decision
- Persistent infrastructure (VPC, subnets, SGs, RDS, ElastiCache, S3, SQS,
  ECS cluster/services, ALB, ACM, Route53, IAM, …) is compiled to OpenTofu
  JSON (`.tf.json`) and executed by a pinned OpenTofu (1.12.5) with exact
  provider versions and a committed multi-platform `.terraform.lock.hcl`.
- `plan -out` → `show -json` → normalized plan → digest. Approval binds to
  the digest. Immediately before apply the plan is regenerated; a changed
  digest refuses the apply (`plan_changed`) and requires re-approval; the
  apply uses the saved plan file that was just verified.
- State lives in the customer's account (S3 backend with native lockfile,
  optional KMS client-side state encryption).
- Day-two operations (restart, scale now, logs, metrics, target health, SSM,
  invoke) use native SDK calls through drivers.
- tofu runs with an allowlisted environment only (brokered cloud creds,
  `TF_*` settings); the control plane's environment never reaches plugins.

## Consequences
Zenith does not reimplement cloud CRUD; plans are reviewable artifacts;
exports remain real, applyable IaC.

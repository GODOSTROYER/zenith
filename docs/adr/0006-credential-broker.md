# ADR-0006 — Keyless credential brokering

Status: accepted (2026-09-30)

## Decision
- Zenith is an OIDC issuer (`<origin>/api/oidc`, RS256, JWKS published). The
  broker mints ≤5-minute tokens with `sub = zenith:ws:<ws>:conn:<conn>` and
  exchanges them: AWS `AssumeRoleWithWebIdentity`, GCP STS + SA
  impersonation, Azure client assertion. No customer secret is stored.
- AWS `AssumeRole` + per-connection ExternalId from Zenith's own AWS
  principal is supported for control planes running on AWS.
- Sessions ≤ 1 h (default 15 min), session-tagged, AWS sessions narrowed with
  an inline session policy per capability; observe and deploy roles differ.
- `runner` mode: jobs go to the customer's zenith-runner; credentials never
  leave the customer environment.
- Credentials live only inside `withSession` callbacks in the execution
  worker; the session object exposes client factories, not keys.
- Customer bootstrap: a CloudFormation template and an equivalent OpenTofu
  module create the OIDC provider (or trust), the two roles with a permission
  boundary on anything Zenith creates, the state bucket and the CodeBuild role.

## Consequences
Stealing Zenith's database yields no cloud credential. The OIDC signing key
is the crown jewel; production uses a KMS-backed signer.

# ADR-0007 — Capability broker, approvals and autonomy levels

Status: accepted (2026-09-30)

## Decision
- All interfaces submit `CapabilityRequest`s (`src/lib/capabilities`). The
  broker resolves tenant scope server-side (workspace → project →
  environment → resource), checks the principal's role and integration
  scopes, reads the environment's autonomy level, evaluates policy (ADR-0008),
  persists the decision, and returns allow / deny / require_approval.
- Approvals are human-only (browser session, never a bearer token), bind to
  the operation's `proposalDigest`, expire, are single-use (consumed in the
  claiming transaction), and are re-validated against the current policy
  version at execution. A model's "yes" is never an approval.
- Execution requires a short-lived signed capability grant (EdDSA JWT)
  bound to operation id, digest, scope and fence token; every execution
  surface verifies it.
- Autonomy is per environment, 0–5: 0 observe, 1 recommend, 2 plan (exact
  proposals needing approval), 3 safe execution (low-risk automatic), 4
  bounded SRE operations automatic under policy, 5 broad autonomy within
  configured limits. The Navigator's install-wide enum maps onto it
  (observe→0, plan→1, approve→2, bounded→3, autonomous→5).
